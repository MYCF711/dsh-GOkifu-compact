#!/usr/bin/env node
/**
 * restart-checklist.mjs —— 从 build.json + git log 现算「这次重启要让哪些提交生效」。
 *
 * 默认只读；唯一写入是用户显式给出的 --out。不会重启 DSH、不会调用模型。
 *
 *   node scripts/restart-checklist.mjs
 *   node scripts/restart-checklist.mjs --out <workspace>
 *   node scripts/restart-checklist.mjs --verify <workspace>
 *
 * 退出码：0 = 当前无待生效修复 / 验收全绿；1 = 有待生效修复 / 验收失败；2 = 输入不足或参数错误。
 *
 * 范围：只有 src/**、lib/**、package.json 是「宿主运行时代码」。scripts/** 每次由新的
 * Node 进程加载，test/docs 更不因 DSH 重启才生效，所以它们会列出，但不会硬凑进待重启清单。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
export const ROOT = nodePath.resolve(HERE, "..");
export const DEFAULT_OUT = "/tmp/restart-checklist.md";
const MANIFEST_SCHEMA = "gokifu/restart-checklist/v1";
const RUNTIME_FILE = /^(?:src\/.*\.mjs|lib\/|package\.json$)/i;
const TEST_FILE = /^test\/([^/]+)\.test\.mjs$/i;
const SCRIPT_FILE = /^scripts\/([^/]+)\.mjs$/i;

export const testsOnlyNote = "scripts/test/docs 由新 Node 进程或读者直接使用，不列入「重启后才生效」";

function iso(ms) {
  return new Date(Number(ms)).toISOString();
}

function displayCommand(args) {
  return ["node", ...args].map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : `'${String(part).replaceAll("'", `'"'"'`)}'`)).join(" ");
}

/** Git Bash 的 /tmp、<workspace> 不是 Windows Node 能直接理解的绝对路径。 */
export function resolveUserPath(value, { platform = process.platform, convert = null } = {}) {
  const raw = String(value ?? "");
  if (platform === "win32" && /^\/(?:[A-Za-z](?:\/|$)|tmp(?:\/|$))/.test(raw)) {
    try {
      const convertPath = convert ?? ((input) => execFileSync("cygpath", ["-w", input], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
      return convertPath(raw);
    } catch {
      const drive = /^\/([A-Za-z])(?:\/|$)/.exec(raw);
      if (drive !== null) return `${drive[1].toUpperCase()}:${raw.slice(2).replaceAll("/", "\\")}`;
      if (/^\/tmp(?:\/|$)/.test(raw)) return nodePath.join(nodeOs.tmpdir(), raw.slice(5));
    }
  }
  return nodePath.resolve(raw);
}

export function defaultHome() {
  if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== "") return process.env.DSH_HOME.trim();
  const profile = process.env.USERPROFILE ?? "";
  return profile === "" ? nodePath.join(nodeOs.homedir(), ".dsh") : nodePath.join(nodePath.dirname(nodePath.dirname(profile)), "DeepSeek Harness", "home");
}

export function readStamp(home, { readFile = (file) => nodeFs.readFileSync(file, "utf8") } = {}) {
  const file = nodePath.join(String(home ?? ""), "chess-context", "build.json");
  let value;
  try {
    value = JSON.parse(readFile(file));
  } catch (error) {
    return { state: "unknown", path: file, reason: `读不到或无法解析 build.json（${error?.code ?? error?.message ?? "JSON 错误"}）` };
  }
  const startedAt = Number(value?.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return { state: "unknown", path: file, reason: "build.json 没有可用的 startedAt（不拿文件 mtime 顶）" };
  }
  const buildId = typeof value?.buildId === "string" && value.buildId.trim() !== "" ? value.buildId.trim() : null;
  const pid = Number(value?.pid);
  return {
    state: "ok",
    path: file,
    startedAt,
    startedAtIso: iso(startedAt),
    buildId,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

export function runGit({ root, args }) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitReason(error) {
  const first = String(error?.stderr ?? error?.message ?? error).split(/\r?\n/).find((line) => line.trim() !== "") ?? "git 失败";
  if (error?.code === "ENOENT") return "找不到 git（PATH 里没有）";
  return first.slice(0, 240);
}

/** 每条提交单独取 name-only，避免路径里空格/非 ASCII 被手拆 diff 误读。 */
export function collectCommits({ root, sinceMs, git = runGit } = {}) {
  const since = iso(sinceMs);
  let log;
  try {
    log = git({ root, args: ["log", "--reverse", `--since=${since}`, "--pretty=format:%H%x09%cI%x09%s"] });
  } catch (error) {
    return { state: "unknown", reason: gitReason(error) };
  }
  const commits = [];
  try {
    for (const line of String(log).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 <= 0 || tab2 <= tab1) continue;
      const hash = line.slice(0, tab1);
      const committedAt = line.slice(tab1 + 1, tab2);
      const subject = line.slice(tab2 + 1).trim();
      const names = git({ root, args: ["show", "--pretty=format:", "--no-renames", "--name-only", hash, "--"] });
      const files = [...new Set(String(names).split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
      commits.push({ hash, short: hash.slice(0, 7), committedAt, committedAtMs: Date.parse(committedAt), subject, files });
    }
  } catch (error) {
    return { state: "unknown", reason: gitReason(error) };
  }
  return { state: "ok", commits };
}

function fileExists(root, rel, readText) {
  try {
    readText(nodePath.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * 只给「静态可见只读」的脚本自动命令。写盘、网络、进程退出或库文件一律不给裸跑命令。
 * 这是保守筛选：漏掉会退成人工验收，绝不会为了凑命令把危险脚本跑起来。
 */
export function inspectReadOnlyCli(source, { allowTopLevelAudit = false } = {}) {
  const text = String(source ?? "");
  const dangerous = /\b(?:writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|mkdirSync|cpSync|createWriteStream)\s*\(|\bfetch\s*\(|\bprocess\.exit\s*\(/;
  if (dangerous.test(text)) return { safe: false, json: false, reason: "含写盘/网络/进程退出调用" };
  const unboundedReplay = /\b(?:runOfflineFold|replayMark)\s*\(/.test(text) && !/(?:--limit|--session)/.test(text);
  if (unboundedReplay) return { safe: false, json: false, reason: "含全量折叠重放且没有 --limit/--session 样本边界" };
  const guarded = /process\.argv\[1\]/.test(text);
  const topLevelAudit = allowTopLevelAudit && /process\.argv/.test(text);
  if (!guarded && !topLevelAudit) return { safe: false, json: false, reason: "没有可识别的 CLI 入口" };
  return { safe: true, json: /(?:process\.argv|argv)\.includes\(\s*["']--json["']\s*\)/.test(text), reason: "" };
}

function commandForTest(rel) {
  const match = TEST_FILE.exec(rel);
  const filter = match?.[1] ?? "";
  return {
    args: ["test/run.mjs", filter],
    command: displayCommand(["test/run.mjs", filter]),
    kind: "test",
    expected: "退出码 0；末行匹配 `== N passed, 0 skipped, 0 failed ==`，且 N > 0。",
  };
}

function commandForScript(rel, inspection) {
  const args = [rel, ...(inspection.json ? ["--json"] : [])];
  return {
    args,
    command: displayCommand(args),
    kind: inspection.json ? "json" : "plain",
    expected: inspection.json
      ? "退出码 0；stdout 是可解析 JSON；不出现 `ReferenceError` 或未捕获异常。"
      : "退出码 0；打印只读审计报告；不出现 `ReferenceError` 或未捕获异常。",
  };
}

/** 从该提交真实带进来的测试/只读 CLI 推导验证，不登记任何固定修复编号或提交哈希。 */
export function validationsForCommit(commit, { root = ROOT, readText = (file) => nodeFs.readFileSync(file, "utf8") } = {}) {
  const commands = [];
  const manualReasons = [];
  const testFiles = commit.files.filter((file) => TEST_FILE.test(file) && file !== "test/counts-baseline.json" && fileExists(root, file, readText));
  for (const file of testFiles) commands.push(commandForTest(file));

  for (const file of commit.files) {
    const match = SCRIPT_FILE.exec(file);
    if (match === null || !fileExists(root, file, readText)) continue;
    const source = readText(nodePath.join(root, file));
    const isAudit = /-audit\.mjs$/i.test(file);
    // 有专用测试的提交只补充只读审计；无测试时也允许其它只读 CLI 作为功能探针。
    if (!isAudit && testFiles.length > 0) continue;
    const inspection = inspectReadOnlyCli(source, { allowTopLevelAudit: isAudit });
    if (inspection.safe) commands.push(commandForScript(file, inspection));
    else if (isAudit) manualReasons.push(`\`${file}\` 未给自动命令（${inspection.reason}）；需人工看它的新旧对照。`);
  }

  if (testFiles.length === 0 && fileExists(root, "test/run.mjs", readText)) {
    commands.push({
      args: ["test/run.mjs"],
      command: "node test/run.mjs",
      kind: "test",
      expected: "退出码 0；末行匹配 `== N passed, 0 skipped, 0 failed ==`，且 N > 0。全量回归不替代真机分支验收。",
    });
  }

  const seen = new Set();
  const unique = commands.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
  if (testFiles.length === 0) {
    manualReasons.unshift(`本提交没有专用测试；需人工看 ${commit.files.filter((file) => RUNTIME_FILE.test(file)).join("、") || "运行时文件"} 的「${commit.subject}」真机路径。`);
  }
  return { commands: unique, manual: manualReasons.length > 0 ? manualReasons.join(" ") : null };
}

export function createChecklist({
  root = ROOT,
  home = defaultHome(),
  diskBuildId,
  git = runGit,
  readFile = (file) => nodeFs.readFileSync(file, "utf8"),
  readText = readFile,
} = {}) {
  const stamp = readStamp(home, { readFile });
  if (stamp.state !== "ok") return { state: "unknown", reason: stamp.reason, stamp, commits: [], skippedCommits: [], commands: [] };
  const disk = diskBuildId ?? repoBuildId(root);
  if (typeof disk !== "string" || disk === "" || disk === "unknown") {
    return { state: "unknown", reason: "repoBuildId() 无法计算磁盘 buildId", stamp, diskBuildId: disk, commits: [], skippedCommits: [], commands: [] };
  }
  const base = { stamp, diskBuildId: disk, runningBuildId: stamp.buildId, startedAt: stamp.startedAt };
  // 明确契约：build 已一致时不硬凑提交表，也不需要再读 git。
  if (stamp.buildId === disk) return { state: "current", ...base, commits: [], skippedCommits: [], commands: [] };
  if (stamp.buildId === null) {
    return { state: "unknown", reason: "build.json 缺 buildId，无法与磁盘比较", ...base, commits: [], skippedCommits: [], commands: [] };
  }

  const collected = collectCommits({ root, sinceMs: stamp.startedAt, git });
  if (collected.state !== "ok") return { state: "unknown", reason: collected.reason, ...base, commits: [], skippedCommits: [], commands: [] };
  const pending = [];
  const skipped = [];
  for (const commit of collected.commits) {
    if (!commit.files.some((file) => RUNTIME_FILE.test(file))) {
      skipped.push(commit);
      continue;
    }
    const validation = validationsForCommit(commit, { root, readText });
    pending.push({ ...commit, runtimeFiles: commit.files.filter((file) => RUNTIME_FILE.test(file)), ...validation });
  }
  const commands = [];
  for (const commit of pending) {
    for (const command of commit.commands) {
      if (commands.some((entry) => entry.command === command.command)) continue;
      commands.push({ ...command, commitHashes: pending.filter((item) => item.commands.some((c) => c.command === command.command)).map((item) => item.hash) });
    }
  }
  return { state: "stale", ...base, commits: pending, skippedCommits: skipped, commands };
}

function manifestOf(report) {
  return {
    schema: MANIFEST_SCHEMA,
    startedAt: report.startedAt,
    runningBuildId: report.runningBuildId,
    diskBuildId: report.diskBuildId,
    commits: report.commits.map((commit) => ({ hash: commit.hash, committedAt: commit.committedAt, subject: commit.subject })),
    commands: report.commands.map((command) => ({ args: command.args, command: command.command, kind: command.kind, expected: command.expected })),
  };
}

export function renderChecklist(report, { outPath = DEFAULT_OUT, includeManifest = false } = {}) {
  const lines = ["# 重启验收清单", "", "## 一致性检查"];
  if (report.state === "unknown") {
    lines.push(`- ✗ 无法判断：${report.reason}`, "", "**这不是「当前无待生效修复」，而是输入不足，清单生成失败。**");
    return `${lines.join("\n")}\n`;
  }
  const stamp = report.stamp;
  lines.push(`- 运行实例 buildId：\`${report.runningBuildId ?? "?"}\``);
  lines.push(`- 磁盘 repoBuildId()：\`${report.diskBuildId}\``);
  lines.push(`- 运行实例 startedAt：\`${stamp.startedAtIso}\`${stamp.pid === null ? "" : `（pid ${stamp.pid}）`}`);
  if (report.state === "current") {
    lines.push("- ✓ 两者相等。", "", "## 当前无待生效修复", "", "**当前无待生效修复。**");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`- ✗ 两者不等；磁盘代码尚未由这个运行实例加载。`, "", `## 待生效修复清单（${report.commits.length} 条）`);
  if (report.commits.length === 0) {
    lines.push("", "**buildId 不一致，但 startedAt 之后没有找到运行时提交。可能是不一致的未提交改动或历史被改写；不能报「无待生效修复」。**");
  }
  report.commits.forEach((commit, index) => {
    lines.push("", `### ${index + 1}. \`${commit.short}\` ${commit.subject}`);
    lines.push(`- 提交时间：\`${commit.committedAt}\``);
    lines.push(`- 影响面：${commit.runtimeFiles.map((file) => `\`${file}\``).join("、")}`);
    lines.push(`- 功能：${commit.subject}`);
    if (commit.commands.length === 0) lines.push("- 自动验证：**无自动验证，需人工看上述运行时文件对应功能。**");
    for (const command of commit.commands) {
      lines.push(`- 验证：\`${command.command}\``, `  - 预期：${command.expected}`);
    }
    if (commit.manual !== null) lines.push(`- 人工补充：${commit.manual}`);
  });
  if (report.skippedCommits.length > 0) {
    lines.push("", `## 不需重启的提交（${report.skippedCommits.length} 条）`, "", testsOnlyNote);
    for (const commit of report.skippedCommits) lines.push(`- \`${commit.short}\` ${commit.subject}`);
  }
  lines.push("", "## 新旧对比（可判据断言）");
  lines.push(`- 重启前：buildId 不一致，待生效运行时提交 **${report.commits.length} 条**。`);
  lines.push("- 重启后：buildId 必须相等，待生效运行时提交应为 **0 条**，且上面每条自动命令都满足自己的预期。 ");
  lines.push("- 历史图与折痕不会因重启消失；**不要把历史审计总数必须为 0 当验收条件**。没有通用「退化/缺口清零」判据时，以各命令的退出码、汇总行和人工补验为准。");
  lines.push("", "## 下次重启后的一条汇总命令", "", "重启前先把本清单及机读命令表落盘：", "", `\`node scripts/restart-checklist.mjs --out ${outPath}\``, "", "重启后只跑这一条：", "", `\`node scripts/restart-checklist.mjs --verify ${outPath}\``, "", `预期末行：\`== 重启验收通过：buildId 一致，${report.commands.length}/${report.commands.length} 条验证命令通过 ==\`，退出码 0。`);
  let text = `${lines.join("\n")}\n`;
  if (includeManifest) text += `\n<!-- restart-checklist-manifest\n${JSON.stringify(manifestOf(report), null, 2)}\n-->\n`;
  return text;
}

export function parseManifest(text) {
  const match = /<!-- restart-checklist-manifest\n([\s\S]*?)\n-->/.exec(String(text ?? ""));
  if (match === null) throw new Error("文件里没有 restart-checklist-manifest；先用 --out 生成");
  const value = JSON.parse(match[1]);
  if (value?.schema !== MANIFEST_SCHEMA || !Array.isArray(value.commands) || !Array.isArray(value.commits)) throw new Error("清单 manifest 形状不正确");
  for (const command of value.commands) {
    if (!Array.isArray(command.args) || !["test", "json", "plain"].includes(command.kind)) throw new Error("manifest 含无效命令");
    const first = String(command.args[0] ?? "");
    if (!/^(?:test\/run\.mjs|scripts\/[A-Za-z0-9._-]+\.mjs)$/.test(first) || command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error(`manifest 含不允许执行的命令：${first}`);
    }
  }
  return value;
}

export function evaluateCommandResult(command, result) {
  const status = typeof result?.status === "number" ? result.status : null;
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  const both = `${stdout}\n${stderr}`;
  if (result?.error) return { ok: false, reason: String(result.error.message ?? result.error) };
  if (status !== 0) return { ok: false, reason: `退出码 ${status ?? "?"}，预期 0` };
  if (/ReferenceError|Unhandled (?:Promise )?Rejection|uncaught exception/i.test(both)) return { ok: false, reason: "输出含 ReferenceError / 未捕获异常" };
  if (command.kind === "test") {
    const matches = [...stdout.matchAll(/== (\d+) passed, (\d+) skipped, (\d+) failed ==/g)];
    const last = matches.at(-1);
    if (last === undefined || Number(last[1]) <= 0 || Number(last[2]) !== 0 || Number(last[3]) !== 0) {
      return { ok: false, reason: "没有 `N passed, 0 skipped, 0 failed`（N>0）汇总行" };
    }
  }
  if (command.kind === "json") {
    try {
      JSON.parse(stdout);
    } catch {
      return { ok: false, reason: "stdout 不是可解析 JSON" };
    }
  }
  return { ok: true, reason: "符合预期" };
}

function tail(text, lines = 12) {
  return String(text ?? "").trim().split(/\r?\n/).slice(-lines).map((line) => `    ${line}`).join("\n");
}

export function verifyChecklist({
  manifest,
  root = ROOT,
  home = defaultHome(),
  diskBuildId,
  git = runGit,
  readFile = (file) => nodeFs.readFileSync(file, "utf8"),
  runCommand = (command) => spawnSync(process.execPath, command.args, {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }),
  log = (line) => console.log(line),
} = {}) {
  const current = createChecklist({ root, home, diskBuildId, git, readFile });
  if (current.state !== "current") {
    log(`✗ 一致性检查失败：${current.state === "unknown" ? current.reason : `运行 ${current.runningBuildId} ≠ 磁盘 ${current.diskBuildId}`}`);
    log("== 重启验收失败：buildId 尚未一致；未执行任何验证命令 ==");
    return { ok: false, code: current.state === "unknown" ? 2 : 1, passed: 0, total: manifest.commands.length };
  }
  if (manifest.diskBuildId !== current.diskBuildId) {
    log(`✗ 清单已过期：生成时磁盘 ${manifest.diskBuildId}，现在磁盘 ${current.diskBuildId}；请重新生成。`);
    log("== 重启验收失败：清单与磁盘不是同一代代码 ==");
    return { ok: false, code: 1, passed: 0, total: manifest.commands.length };
  }
  // lib/** 不在 repoBuildId 内：额外确保生成清单之后没有漏加新的运行时提交。
  const nowCommits = collectCommits({ root, sinceMs: Number(manifest.startedAt), git });
  if (nowCommits.state !== "ok") {
    log(`✗ 无法复核清单覆盖范围：${nowCommits.reason}`);
    log("== 重启验收失败：git 读取失败 ==");
    return { ok: false, code: 2, passed: 0, total: manifest.commands.length };
  }
  const listed = new Set(manifest.commits.map((commit) => commit.hash));
  const missing = nowCommits.commits.filter((commit) => commit.files.some((file) => RUNTIME_FILE.test(file)) && !listed.has(commit.hash));
  if (missing.length > 0) {
    log(`✗ 清单漏了生成之后新增的运行时提交：${missing.map((commit) => commit.short).join("、")}；请重新生成。`);
    log("== 重启验收失败：清单覆盖不完整 ==");
    return { ok: false, code: 1, passed: 0, total: manifest.commands.length };
  }
  log(`✓ buildId 一致：${current.diskBuildId}`);
  let passed = 0;
  for (const command of manifest.commands) {
    const result = runCommand(command);
    const evaluated = evaluateCommandResult(command, result);
    if (evaluated.ok) {
      passed += 1;
      log(`✓ ${command.command} — 退出码 0，${evaluated.reason}`);
      continue;
    }
    log(`✗ ${command.command} — ${evaluated.reason}`);
    const output = `${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`;
    if (output.trim() !== "") log(tail(output));
    log(`== 重启验收失败：${passed}/${manifest.commands.length} 条验证命令通过 ==`);
    return { ok: false, code: 1, passed, total: manifest.commands.length };
  }
  log(`== 重启验收通过：buildId 一致，${passed}/${manifest.commands.length} 条验证命令通过 ==`);
  return { ok: true, code: 0, passed, total: manifest.commands.length };
}

export function parseArgs(argv) {
  const out = { root: ROOT, home: defaultHome(), out: null, verify: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg === name) {
        index += 1;
        return argv[index] ?? "";
      }
      return arg.slice(name.length + 1);
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--out" || arg.startsWith("--out=")) out.out = take("--out");
    else if (arg === "--verify" || arg.startsWith("--verify=")) out.verify = take("--verify");
    else if (arg === "--root" || arg.startsWith("--root=")) out.root = take("--root");
    else if (arg === "--home" || arg.startsWith("--home=")) out.home = take("--home");
    else return { ...out, error: `未知参数：${arg}` };
  }
  if (out.out !== null && out.verify !== null) return { ...out, error: "--out 与 --verify 不能同时用" };
  for (const key of ["out", "verify", "root", "home"]) if (out[key] !== null && String(out[key]).trim() === "") return { ...out, error: `--${key} 缺路径` };
  return out;
}

const USAGE = [
  "用法：",
  "  node scripts/restart-checklist.mjs [--home DIR] [--root DIR]",
  "  node scripts/restart-checklist.mjs --out /tmp/restart-checklist.md",
  "  node scripts/restart-checklist.mjs --verify /tmp/restart-checklist.md",
  "退出码：0 当前无待生效修复/验收通过；1 有待生效修复/验收失败；2 无法判断。",
].join("\n");

export function main(argv = process.argv.slice(2), { log = (line) => console.log(line) } = {}) {
  const options = parseArgs(argv);
  if (options.error) {
    log(options.error);
    log(USAGE);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const root = resolveUserPath(options.root);
  const home = resolveUserPath(options.home);
  try {
    if (options.verify !== null) {
      const file = resolveUserPath(options.verify);
      const manifest = parseManifest(nodeFs.readFileSync(file, "utf8"));
      return verifyChecklist({ manifest, root, home, log }).code;
    }
    const report = createChecklist({ root, home });
    const text = renderChecklist(report, { outPath: options.out ?? DEFAULT_OUT, includeManifest: options.out !== null && report.state === "stale" });
    if (options.out !== null) {
      const file = resolveUserPath(options.out);
      nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
      nodeFs.writeFileSync(file, text, "utf8");
      log(text.trimEnd());
      log(`\n已写入：${options.out}`);
    } else {
      log(text.trimEnd());
    }
    return report.state === "unknown" ? 2 : report.state === "current" ? 0 : 1;
  } catch (error) {
    log(`无法生成或验收重启清单：${String(error?.message ?? error)}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
