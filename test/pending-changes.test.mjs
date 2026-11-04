/**
 * pending-changes.test.mjs —— 「时间点之后的改动被列出 / 之前的不列 / 没有就说没有 / 判不了就说判不了」（C646）
 *
 * 由来（今晚连续 4 次踩同一个坑，Lead 要求变成自动检测）：
 *   代码已经改了，但跑的是旧进程 —— 每次白烧一整轮验证。
 *   04:5x C607 机械补回（`failuresRepaired` 出现 0 次）、05:5x C607 提示词（`git show` 里没有这条规则）、
 *   06:0x C640 回滚（修完又新增第 2 条悬空边）、06:2x C642 摘要正文（之后的 71 条折痕全是旧代码写的）。
 *
 * 这个守卫钉住四件事（**用真 git 夹具**，不是 mock 掉 git 的假绿）：
 *   ① 时间点**之后**的提交被列出（含归类 + 复验命令）；
 *   ② 时间点**之前**的提交不列（否则就是把"早就生效的"也算成待验证）；
 *   ③ 没有改动 ⇒ 输出「无待验证改动」（这一条必须能被单独证明，否则"绿"没有意义）；
 *   ④ 读不到 git / 读不到 build.json ⇒ **不抛**，明确说「无法判断」，且**不许**出现「无待验证改动」
 *      （假绿比红贵：判不了时说"没问题"正是这个脚本要堵的那种错）。
 *
 * ⚠ 夹具全部在 `os.tmpdir()` 下（`mktemp -d` 的等价物），跑完删掉 —— 不在仓库里留垃圾。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReport, formatReport, formatSection, readStartPoint, summarize } from "../scripts/pending-changes.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const CLI = nodePath.join(ROOT, "scripts", "pending-changes.mjs");

export const tests = {};

/** 三个固定时刻：提交 1 在时间点**之前**，提交 2 在**之后**，`NO_CHANGE_AT` 在两者之后再往后。 */
const BEFORE = "2026-01-01T00:00:00.000Z";
const MID = "2026-01-02T00:00:00.000Z";
const AFTER = "2026-01-03T00:00:00.000Z";
const NO_CHANGE_AT = "2026-01-09T00:00:00.000Z";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  // Windows 上 `git` 可能带 CRLF 转换：关掉，否则 diff 的 +/- 行会被改写
  GIT_CONFIG_NOSYSTEM: "1",
};

function gitIn(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}

function writeFile(root, relPath, content) {
  const file = nodePath.join(root, relPath);
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, content, "utf8");
}

function commitAll(root, message, date) {
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function writeStamp(home, { startedAt = Date.parse(MID), buildId = "fixturebuild" } = {}) {
  const dir = nodePath.join(home, "chess-context");
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, "build.json"),
    JSON.stringify({ schema: "gokifu/build-stamp/v1", version: "1.17.6", buildId, startedAt, pid: 424242 }),
    "utf8",
  );
  return dir;
}

/**
 * 造夹具：真 `git init` + 两次提交（时间点一前一后）+ 假 `build.json`。
 *
 * 提交 1（**之前**）：`scripts/old-thing.mjs` / `src/rooms/fold.mjs` / `scripts/doctor.mjs`
 * 提交 2（**之后**）：改 `fold.mjs`（写回点）、新增 `facts-prompt.mjs`（提示词）、
 *                     改 `doctor.mjs`（探测器）、新增 `add-changelog.mjs`（文档工具）
 */
function makeFixture() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pending-changes-repo-"));
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pending-changes-home-"));
  gitIn(root, ["init", "-q", "-b", "main"]);

  writeFile(root, "scripts/old-thing.mjs", "#!/usr/bin/env node\nconsole.log('only in commit 1');\n");
  writeFile(root, "src/rooms/fold.mjs", "export function fold() {\n  return 1;\n}\n");
  writeFile(root, "scripts/doctor.mjs", "const asJson = process.argv.includes('--json');\nconsole.log(asJson);\n");
  commitAll(root, "提交 1：时间点之前", BEFORE);

  const graphDir = writeStamp(home);

  writeFile(
    root,
    "src/rooms/fold.mjs",
    "export function summaryTextField(graph, range, text) {\n  return { summaryText: text };\n}\n",
  );
  writeFile(root, "src/rooms/facts-prompt.mjs", "export const FACTS_PROMPT = '## 已探明死路';\n");
  writeFile(root, "scripts/doctor.mjs", "const asJson = process.argv.includes('--json');\nconsole.log('正文 有/无', asJson);\n");
  writeFile(root, "scripts/add-changelog.mjs", "#!/usr/bin/env node\n// 文档工具：跑它会写 CHANGELOG\n");
  commitAll(root, "提交 2：时间点之后", AFTER);

  return { root, home, graphDir };
}

function cleanup(fixture) {
  for (const dir of [fixture?.root, fixture?.home]) {
    if (typeof dir !== "string" || dir === "") continue;
    try {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

/** 跑 CLI，拿 `{ code, stdout }`（真进程：退出码是契约的一部分）。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return { code: 0, stdout };
  } catch (error) {
    return { code: typeof error?.status === "number" ? error.status : -1, stdout: String(error?.stdout ?? "") };
  }
}

const paths = (report) => report.files.map((file) => file.path).sort();

tests["C646 时间点之后的改动被列出、之前的不列"] = (t) => {
  const fixture = makeFixture();
  try {
    const report = buildReport({ root: fixture.root, graphDir: fixture.graphDir, diskBuildId: "" });
    t.eq(report.state, "ok", "读得到就报 ok");
    t.eq(report.commits.length, 1, "只有提交 2 在时间点之后（提交 1 是 01-01，时间点是 01-02）");
    t.eq(
      paths(report),
      ["scripts/add-changelog.mjs", "scripts/doctor.mjs", "src/rooms/facts-prompt.mjs", "src/rooms/fold.mjs"],
      "四个改动文件，一个不多一个不少",
    );
    t.notIncludes(paths(report).join(","), "old-thing", "**时间点之前**的提交不许列出来");
    // 时间点必须来自 build.json.startedAt
    t.eq(report.startPoint.startedAt, Date.parse(MID), "时间点 = build.json.startedAt");
    t.includes(summarize(report), "之后 1 个提交", "总结要说清是「之后」");
  } finally {
    cleanup(fixture);
  }
};

tests["C646 归类：改提示词 / 改写回点 / 改探测器 / 改文档，各带一条能跑的命令"] = (t) => {
  const fixture = makeFixture();
  try {
    const report = buildReport({ root: fixture.root, graphDir: fixture.graphDir, diskBuildId: "" });
    const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));
    const classesOf = (p) => (byPath[p]?.classes ?? []).map((entry) => entry.cls);

    t.includes(classesOf("src/rooms/facts-prompt.mjs"), "改提示词", "提示词文件按路径就能认出来");
    t.includes(classesOf("src/rooms/fold.mjs"), "改写回点", "summaryText ⇒ 写回点");
    t.includes(classesOf("scripts/doctor.mjs"), "改探测器", "诊断脚本本身改了");
    t.includes(classesOf("scripts/add-changelog.mjs"), "改文档", "文档工具改了（不是运行时）");

    // 每条建议都必须是真命令；文档工具**不许**裸跑（它跑一次会改文件）
    const commands = byPath["src/rooms/fold.mjs"].commands.map((entry) => entry.command);
    t.eq(commands, ["node scripts/summary-text-coverage-audit.mjs"], "写回点 ⇒ 覆盖率审计");
    const docCommands = byPath["scripts/add-changelog.mjs"].commands.map((entry) => entry.command);
    t.eq(docCommands, ["node scripts/docs-index-check.mjs"], "文档工具只给一致性检查，不给裸跑（add-changelog 会写盘）");
    t.eq(byPath["scripts/doctor.mjs"].commands.map((entry) => entry.command), ["node scripts/doctor.mjs"], "探测器 ⇒ 跑它自己");

    const section = formatSection(report);
    t.includes(section, "需要真机证据", "段落要说清哪些**必须有**真机证据");
    t.includes(section, "node scripts/summary-text-coverage-audit.mjs", "命令要原样出现在段落里");
  } finally {
    cleanup(fixture);
  }
};

tests["C646 没有改动 ⇒ 无待验证改动（CLI 退出码 0）"] = (t) => {
  const fixture = makeFixture();
  try {
    const report = buildReport({ root: fixture.root, graphDir: fixture.graphDir, diskBuildId: "", sinceMs: Date.parse(NO_CHANGE_AT) });
    t.eq(report.state, "ok", "判得了（不是 unknown）");
    t.eq(report.files.length, 0, "时间点之后没有提交");
    t.eq(formatSection(report), "无待验证改动", "这一句话必须原样出现，才能被别的脚本 grep");

    const cli = runCli([`--root=${fixture.root}`, `--home=${fixture.home}`, `--since=${NO_CHANGE_AT}`]);
    t.eq(cli.code, 0, "没有待验证改动 ⇒ 退出码 0");
    t.includes(cli.stdout, "无待验证改动", "人读输出也要有这句话");
  } finally {
    cleanup(fixture);
  }
};

tests["C646 工作区未提交改动单列，并标明「时刻不可判」"] = (t) => {
  const fixture = makeFixture();
  try {
    writeFile(fixture.root, "scripts/brand-new-audit.mjs", "#!/usr/bin/env node\nconsole.log(process.argv.length);\n");
    const report = buildReport({ root: fixture.root, graphDir: fixture.graphDir, diskBuildId: "" });
    const entry = report.files.find((file) => file.path === "scripts/brand-new-audit.mjs");
    t.ok(entry !== undefined, "未提交的新文件必须被列出（否则「改了没提交」就永远看不见）");
    t.eq(entry.source, "workspace", "来源要能区分是提交还是工作区");
    t.eq(entry.timing, "unknown", "git 不记录工作区文件的修改时刻 ⇒ 必须标不可判");
    t.includes(formatSection(report), "时刻不可判", "段落里要把这件事说出来");
  } finally {
    cleanup(fixture);
  }
};

tests["C646 读不到 git ⇒ 无法判断（不抛、不假绿）"] = (t) => {
  const fixture = makeFixture();
  try {
    const boom = () => {
      const error = new Error("spawn git ENOENT");
      error.code = "ENOENT";
      throw error;
    };
    let report = null;
    // ① 不许抛：这里**直接调用**（抛了这条用例就红），不用 t.throws —— 断言的是"不抛"
    report = buildReport({ root: fixture.root, graphDir: fixture.graphDir, git: boom, diskBuildId: "" });
    t.ok(report !== null, "读不到 git 时**不许**抛（诊断设施拖垮体检比不报还糟）");
    t.eq(report?.state, "unknown", "要报 unknown，不是 ok");
    t.includes(report?.reason, "找不到 git", "理由要具体到「找不到 git」");
    const section = formatSection(report);
    t.includes(section, "无法判断", "必须明说判不了");
    t.notIncludes(section, "无待验证改动", "**判不了时不许说「没有改动」** —— 那正是这个脚本要堵的假绿");
    t.includes(formatReport(report), "无法判断", "人读输出同一口径");

    // ② CLI 退出码：无法判断 = 2（不是 0）
    const real = buildReport({ root: fixture.root, graphDir: fixture.graphDir, diskBuildId: "" });
    t.eq(real.state, "ok", "同一夹具换成真 git 就能判 —— 证明上面红的是注入的那条路，不是夹具坏了");
  } finally {
    cleanup(fixture);
  }
};

tests["C646 读不到 build.json ⇒ 无法判断（不拿 mtime 顶）"] = (t) => {
  const emptyHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pending-changes-nostamp-"));
  try {
    const startPoint = readStartPoint({ dir: nodePath.join(emptyHome, "chess-context") });
    t.eq(startPoint.state, "missing", "没有 build.json ⇒ missing");
    t.includes(startPoint.reason, "读不到 build.json", "理由要说清是哪个文件");

    const report = buildReport({ root: HERE, home: emptyHome, diskBuildId: "" });
    t.eq(report.state, "unknown", "没有时间点 ⇒ unknown");
    t.includes(formatSection(report), "无法判断", "必须明说判不了");
    t.notIncludes(formatSection(report), "无待验证改动", "不许退化成「没有改动」");

    // build.json 存在但没有 startedAt ⇒ 同样是"判不了"，**不许**退回文件 mtime
    const graphDir = writeStamp(emptyHome);
    nodeFs.writeFileSync(nodePath.join(graphDir, "build.json"), JSON.stringify({ buildId: "x", pid: 1 }), "utf8");
    const broken = readStartPoint({ dir: graphDir });
    t.eq(broken.state, "invalid", "没有 startedAt 就是 invalid");
    t.includes(broken.reason, "startedAt", "理由要点名缺的是 startedAt");

    const cli = runCli([`--root=${ROOT}`, `--home=${emptyHome}`]);
    t.eq(cli.code, 2, "无法判断 ⇒ 退出码 2（0 会被门禁读成「没问题」）");
    t.includes(cli.stdout, "无法判断", "人读输出也必须有这句话");
  } finally {
    try {
      nodeFs.rmSync(emptyHome, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
};

tests["C646 不是 git 仓库 ⇒ 无法判断（真 git 的错误路径）"] = (t) => {
  const plain = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pending-changes-nogit-"));
  try {
    writeStamp(plain);
    const report = buildReport({ root: plain, graphDir: nodePath.join(plain, "chess-context"), diskBuildId: "" });
    t.eq(report.state, "unknown", "不是仓库 ⇒ unknown");
    t.includes(report.reason, "不是 git 仓库", `理由要点名不是仓库（实际：${report.reason}）`);
    t.notIncludes(formatSection(report), "无待验证改动", "仍然不许说「没有改动」");
  } finally {
    try {
      nodeFs.rmSync(plain, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
};

tests["C646 CLI 退出码：有待验证 = 1（不是 0）"] = (t) => {
  const fixture = makeFixture();
  try {
    const cli = runCli([`--root=${fixture.root}`, `--home=${fixture.home}`]);
    t.eq(cli.code, 1, "有待验证改动 ⇒ 退出码 1，门禁才拦得住");
    t.includes(cli.stdout, "待验证改动", "正文要有标题");
    t.includes(cli.stdout, "node scripts/summary-text-coverage-audit.mjs", "每条都附复验命令");
    t.includes(cli.stdout, `build.json.startedAt`, "时间点要写清来源是 build.json.startedAt");

    // 机器可读：--json 必须自洽（state/files/commands 三处一致）
    const json = runCli([`--root=${fixture.root}`, `--home=${fixture.home}`, "--json"]);
    const parsed = JSON.parse(json.stdout);
    t.eq(parsed.state, "ok", "--json 的 state");
    t.eq(parsed.files.length, 4, "--json 的文件数与人读输出一致");
    t.ok(Array.isArray(parsed.commands) && parsed.commands.length > 0, "--json 要给出去重后的命令表");
  } finally {
    cleanup(fixture);
  }
};
