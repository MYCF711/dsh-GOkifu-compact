/**
 * make-preset.test.mjs —— preset 生成器（从宿主 asar 读官方 preset → 只换压缩引擎 → 输出 bundle 包）回归
 *
 * 为什么要有这个文件：`scripts/make-preset.mjs` 是「装回新版 DSH」的 C 段工具。它的价值不是
 * 「能生成一个 preset」，而是**永远从宿主当前版本的官方 preset 现读现改** —— 手工照抄一份会把
 * 当时那版 DSH 的插件清单冻成快照（升级新增的行会静默丢失）。所以这里钉的判据里最重要的一条是：
 * **生成物的插件行集合必须与官方 preset 不多不少**，只有 compaction-basic → gokifu-compact 这一处差异。
 *
 * 覆盖：
 *   ① 纯函数能定位 compaction group 并替换，缩进/行数/其它行原样（只改 2 行）；
 *   ② compaction-basic 消失、gokifu 引擎行出现、command-compact / tool-result-pruner / 后来的官方行
 *      （time-context / tool-schedule / workflow-ptc / `!!js` 标签）逐字保留；package.json 形状正确；
 *   ③ 找不到 compaction group / 没有 group:true 父组 ⇒ 明确错误、不产出半成品；
 *   ④ 输出目录守卫：落在 DSH_HOME 下 ⇒ UsageError / CLI exit 2，且一个文件都不写；
 *   ⑤ 真实 app.asar 跑 `--dry-run`（asar 不可读则明确 skip）+ 真 `--write` 落盘内容检查；
 *   ⑥ CLI 契约：--help exit 0 / 未知参数、非法 id、非法 version exit 2 / 坏 asar exit 1。
 *
 * 夹具：官方 preset 用**按真实 asar 形状内联的等价片段**（不依赖真实 asar，跑得快）；
 * 输出目录一律建在仓库 tmp/ 下，用例结束清理。真实 asar 只读（绝不在 home 里写任何东西）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ASAR_CANDIDATES,
  DEFAULT_OUT,
  ENGINE_ROW,
  UsageError,
  assertOutDirAllowed,
  buildBundlePatch,
  buildPresetBundle,
  findCompactionGroup,
  parseArgs,
  rewriteCompactionEngine,
  run,
  runningHomes,
  validateBundlePatch,
} from "../scripts/make-preset.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "make-preset.mjs");
const TMP = nodePath.join(REPO, "tmp");

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 官方 preset 的**等价形状**片段（缩进/键序/`!!js` 标签/嵌套 group 都照真实
 * `standard.patch.yml` 抄；只删掉若干重复的普通工具行以缩短）。
 */
const OFFICIAL_FIXTURE = [
  "# Agent preset standard: one `@deepseek-ai/dsh-agent-preset` declaration inserted",
  "# after the web patch. Edits saved from the Web editor override this row's",
  "# `config.plugins` by id from the profile patch.",
  "- insert:",
  "    - id: preset-standard",
  "      name: '@deepseek-ai/dsh-agent-preset'",
  "      config:",
  "        id: standard",
  "        order: 1",
  "        plugins:",
  "          - id: persona",
  "            name: '@deepseek-ai/dsh-persona'",
  "            config:",
  "              prefix: You are a coding agent powered by the {{model}} model.",
  "          - id: agent-instructions",
  "            name: '@deepseek-ai/dsh-agent-instructions'",
  "            config:",
  "              maxBytes: 65536",
  "          - id: time-context",
  "            name: '@deepseek-ai/dsh-time-context'",
  "          - id: tool-bash",
  "            name: '@deepseek-ai/dsh-tool-bash'",
  "            disabled: !!js process.platform === 'win32'",
  "          - id: tool-schedule",
  "            name: '@deepseek-ai/dsh-tool-schedule'",
  "          - id: planning",
  "            name: cordis:group",
  "            group: true",
  "            isolate:",
  "              planMode: true",
  "            config:",
  "              - id: plan-mode",
  "                name: '@deepseek-ai/dsh-plan-mode'",
  "          - id: compaction",
  "            name: cordis:group",
  "            group: true",
  "            isolate:",
  "              compaction: true",
  "              toolResultPruner: true",
  "            config:",
  "              - id: compaction-basic",
  "                name: '@deepseek-ai/dsh-compaction-basic'",
  "              - id: command-compact",
  "                name: '@deepseek-ai/dsh-command-compact'",
  "              - id: tool-result-pruner",
  "                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  "                config:",
  "                  thresholdChars: 8192",
  "                  headChars: 4096",
  "                  tailChars: 1024",
  "          - id: delegation",
  "            name: cordis:group",
  "            group: true",
  "            isolate:",
  "              workflowEngine: true",
  "            config:",
  "              - id: tool-subagent",
  "                name: '@deepseek-ai/dsh-tool-subagent'",
  "              - id: workflow-ptc",
  "                name: '@deepseek-ai/dsh-workflow-ptc'",
  "              - id: tool-workflow",
  "                name: '@deepseek-ai/dsh-tool-workflow'",
  "          - id: tool-ask-user",
  "            name: '@deepseek-ai/dsh-tool-ask-user'",
  "          - id: tool-plugin-manager",
  "            name: '@deepseek-ai/dsh-plugin-manager/tools'",
  "            disabled: true",
  "",
].join("\n");

/** 只比较**声明正文**（生成文件头部注释里会写到 `compaction-basic` 这个词，解释替换了什么）。 */
function bodyOf(text) {
  return String(text)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function mkTmp(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-make-preset-${label}-`));
}

function cleanup(dir) {
  nodeFs.rmSync(dir, { recursive: true, force: true });
}

/** 跑真实 CLI，收集退出码/stdout/stderr。 */
function runCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120000,
    windowsHide: true,
  });
  return { code: result.status, out: String(result.stdout ?? ""), err: String(result.stderr ?? "") };
}

/** 跑任意路径的脚本（C-12 的非 ASCII 文件名副本用）。 */
function runCliAt(scriptPath, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120000,
    windowsHide: true,
  });
  return { code: result.status, out: String(result.stdout ?? ""), err: String(result.stderr ?? "") };
}

/** 捕获同步抛错（要 msg 的断言用得到）。 */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

export const tests = {
  "① 纯函数：官方 preset 夹具里定位 compaction group 并替换引擎行（只改 2 行，缩进不变）"(t) {
    const result = rewriteCompactionEngine(OFFICIAL_FIXTURE);
    t.eq(result.groupId, "compaction", "必须认出 id: compaction 的 group");
    t.eq(result.replaced.toId, "gokifu-compact", "替换后的 id");
    t.eq(result.replaced.toName, ENGINE_ROW.name, "替换后的 name 必须是 /engine 子路径");
    t.includes(result.text, "              - id: gokifu-compact", "group 内条目缩进必须保持（14 空格）");
    t.includes(result.text, "                name: 'dsh-gokifu-compact/engine'", "name 行缩进保持（16 空格）");
    t.notIncludes(result.text, "- id: compaction-basic", "旧引擎行必须消失");
    // 只允许改 2 行：行数不变 + 逐行比对
    const before = OFFICIAL_FIXTURE.split("\n");
    const after = result.text.split("\n");
    t.eq(after.length, before.length, "行数必须不变（纯值替换，不增删行）");
    const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    t.eq(changed.length, 2, `只许改 2 行（id/name），实际改了 ${changed.length} 行`);
    // 另一种错误形态（有 compaction-basic 但没有 group:true 父组）也必须明确报错
    const noGroup = caught(() => rewriteCompactionEngine(OFFICIAL_FIXTURE.replace("            group: true\n            isolate:\n              compaction: true", "            isolate:\n              compaction: true")));
    t.ok(noGroup instanceof Error, "没有 group:true 父组时必须抛错");
    t.includes(String(noGroup?.message ?? ""), "group", "错误信息要说清是 group 形状不对");
  },

  "② 生成 bundle：compaction-basic 消失、引擎行出现，其余官方插件行逐字保留；package.json 形状正确"(t) {
    const bundle = buildPresetBundle({ officialText: OFFICIAL_FIXTURE, hostVersion: "0.2.1-rc.5" });
    const body = bodyOf(bundle.patchYml);
    // 声明形状
    t.includes(body, "- insert:", "必须是 insert 声明");
    t.includes(body, "    - id: preset-gokifu", "insert 行 id 必须是 preset-<id>");
    t.includes(body, "      name: '@deepseek-ai/dsh-agent-preset'", "必须是 agent-preset 声明");
    t.includes(body, "        id: gokifu", "config.id 必须是 gokifu");
    t.includes(body, "        order: 1", "order 默认沿用官方值");
    // 引擎替换
    t.notIncludes(body, "compaction-basic", "声明正文里不许再有 compaction-basic");
    t.includes(body, ENGINE_ROW.name, "必须写 /engine 子路径（包根是 UI host，绝不能当引擎）");
    t.notIncludes(body, "name: 'dsh-gokifu-compact'", "绝不能写包根当引擎");
    // 官方行逐字保留（防冻结的核心证据）
    for (const line of [
      "              - id: command-compact",
      "                name: '@deepseek-ai/dsh-command-compact'",
      "              - id: tool-result-pruner",
      "                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      "          - id: time-context",
      "          - id: tool-schedule",
      "              - id: workflow-ptc",
      "                name: '@deepseek-ai/dsh-workflow-ptc'",
      "            disabled: !!js process.platform === 'win32'",
      "                  thresholdChars: 8192",
    ]) {
      t.includes(body, line, `官方行必须原样保留：${line.trim()}`);
    }
    // package.json 形状
    t.eq(bundle.packageJson.private, true, "必须 private");
    t.eq(bundle.packageJson.dsh?.bundle?.patch, "./cordis.patch.yml", "必须声明 dsh.bundle.patch");
    t.eq(bundle.packageJson.version, "0.2.1-rc.5", "version 应记录生成时的宿主版本");
    t.eq(bundle.packageJson.name, "dsh-gokifu-preset", "默认包名");
    t.includes(bundle.patchYml, "宿主版本：0.2.1-rc.5", "头部要写明宿主版本（生成快照的可追溯性）");
    // --name / --id / --order 可覆盖
    const custom = buildPresetBundle({ officialText: OFFICIAL_FIXTURE, id: "my-preset", name: "我的 压缩", order: 7, hostVersion: "0.2.1-rc.5" });
    t.includes(bodyOf(custom.patchYml), "        id: my-preset", "自定义 id");
    t.includes(bodyOf(custom.patchYml), "        name: '我的 压缩'", "自定义显示名（单引号 YAML）");
    t.includes(bodyOf(custom.patchYml), "        order: 7", "自定义 order");
    t.eq(custom.packageJson.name, "dsh-gokifu-preset-my-preset", "带 id 的包名");
  },

  "③ 找不到 compaction group ⇒ 明确错误、不产出半成品（不返回空/空壳）"(t) {
    const noBasic = caught(() => buildPresetBundle({ officialText: OFFICIAL_FIXTURE.replaceAll("compaction-basic", "some-other-engine") }));
    t.ok(noBasic instanceof Error, "没有 compaction-basic 时必须抛错");
    t.includes(String(noBasic?.message ?? ""), "compaction-basic", "错误要指名缺的是 compaction-basic");
    // 不是 insert/preset 形状
    const notPreset = caught(() => buildPresetBundle({ officialText: "plugins:\n  - id: x\n" }));
    t.ok(notPreset instanceof Error, "非 agent-preset 形状必须抛错");
    t.includes(String(notPreset?.message ?? ""), "insert", "错误要说明找不到顶层 insert");
    // 空输入
    const empty = caught(() => buildPresetBundle({ officialText: "" }));
    t.ok(empty instanceof Error, "空输入必须抛错（不许生成空壳）");
    // 纯函数 findCompactionGroup 自身对行数组也给明确结论
    const direct = caught(() => findCompactionGroup(["plugins:", "  - id: nope"]));
    t.ok(direct instanceof Error, "findCompactionGroup 缺 group 时必须抛");
    t.includes(String(direct?.message ?? ""), "compaction-basic", "错误要指名缺的行");
  },

  "④ 输出目录守卫：落在 DSH_HOME 下 ⇒ 拒绝（UsageError / CLI exit 2），一个文件都不写"(t) {
    const root = mkTmp("guard");
    try {
      const fakeHome = nodePath.join(root, "fake-home");
      nodeFs.mkdirSync(fakeHome, { recursive: true });
      // 纯函数：home 内部（含 home 本身）都拒绝
      t.ok(caught(() => assertOutDirAllowed(nodePath.join(fakeHome, "preset-bundle"), [fakeHome])) instanceof UsageError, "home 子目录必须拒绝（UsageError）");
      t.ok(caught(() => assertOutDirAllowed(fakeHome, [fakeHome])) instanceof UsageError, "home 目录本身也必须拒绝");
      const outside = nodePath.join(root, "out-ok");
      t.eq(assertOutDirAllowed(outside, [fakeHome]), nodePath.resolve(outside), "home 之外允许");
      // 默认输出目录（repo tmp）本身必须是安全的（对真实 runningHomes 判一次）
      t.eq(assertOutDirAllowed(DEFAULT_OUT), nodePath.resolve(DEFAULT_OUT), "默认输出目录不许落在运行中的 home 里");
      // CLI：DSH_HOME=fakeHome + --out 在 home 内 ⇒ exit 2，且不创建目录
      const homeOut = nodePath.join(fakeHome, "preset-bundle");
      const cli = runCli(["--out", homeOut], { DSH_HOME: fakeHome });
      t.eq(cli.code, 2, `守卫必须 exit 2（实际 ${cli.code}）：${cli.err}`);
      t.includes(cli.err, "不许落在运行中的 DSH home", "要给人话");
      t.ok(!nodeFs.existsSync(homeOut), "被拒时一个文件都不许写");
      // run() 直接调用也返回 2（纯入口，不吞错）
      const direct = run(["--out", homeOut], { env: { ...process.env, DSH_HOME: fakeHome }, log: () => {}, error: () => {} });
      t.eq(direct, 2, "run() 对守卫错误返回 2");
      // runningHomes 同时包含显式 DSH_HOME 与默认 USERPROFILE 位置
      const homes = runningHomes({ DSH_HOME: fakeHome, USERPROFILE: "C:\\Users\\fixture" });
      t.ok(homes.some((h) => h.toLowerCase() === nodePath.resolve(fakeHome).toLowerCase()), "runningHomes 要包含 DSH_HOME");
      t.ok(homes.some((h) => h.toLowerCase() === nodePath.resolve("C:\\Users\\fixture\\DeepSeek Harness\\home").toLowerCase()), "runningHomes 要包含默认 home");
    } finally {
      cleanup(root);
    }
  },

  "⑤ 真实 app.asar：--dry-run 输出含引擎行且不写盘；--write 落盘内容与自检一致（asar 不可读则 skip）"(t) {
    const asar = [process.env.DSH_ASAR, ...ASAR_CANDIDATES].find((p) => typeof p === "string" && p !== "" && nodeFs.existsSync(p));
    if (asar === undefined) {
      t.skip(`真实 asar 不可读（试过 ${ASAR_CANDIDATES.join(" / ")}；可用 DSH_ASAR 指定）—— 生成器的纯函数部分由 ①②③ 覆盖`);
      return;
    }
    const root = mkTmp("real");
    try {
      const outDir = nodePath.join(root, "bundle");
      const dry = runCli(["--dry-run", "--out", outDir, "--asar", asar]);
      t.eq(dry.code, 0, `真实 asar 的 dry-run 必须成功：${dry.err}`);
      t.includes(dry.out, ENGINE_ROW.name, "dry-run 输出必须含 dsh-gokifu-compact/engine");
      t.includes(dry.out, "compaction-basic → gokifu-compact", "输出要说明替换了什么");
      t.ok(!nodeFs.existsSync(outDir), "dry-run 不许创建输出目录/写文件");
      // 真写：内容必须与纯函数生成结果一致（同一份 asar 输入）
      const written = runCli(["--write", "--out", outDir, "--asar", asar]);
      t.eq(written.code, 0, `--write 必须成功：${written.err}`);
      const patchFile = nodePath.join(outDir, "cordis.patch.yml");
      const packageFile = nodePath.join(outDir, "package.json");
      t.ok(nodeFs.existsSync(patchFile) && nodeFs.existsSync(packageFile), "落盘必须同时有 cordis.patch.yml 与 package.json");
      const body = bodyOf(nodeFs.readFileSync(patchFile, "utf8"));
      t.includes(body, ENGINE_ROW.name, "落盘 patch 必须含引擎行");
      t.notIncludes(body, "compaction-basic", "落盘 patch 正文不许残留 compaction-basic");
      t.includes(body, "command-compact", "命令压缩行必须保留");
      t.includes(body, "tool-result-pruner", "工具结果裁剪行必须保留");
      t.includes(body, "          - id: time-context", "官方新增的 time-context 行（本轮 0.2.1-rc.5 就有）必须被带上");
      const pkg = JSON.parse(nodeFs.readFileSync(packageFile, "utf8"));
      t.eq(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "package.json 必须声明 bundle patch");
      t.ok(/^\d+\.\d+\.\d+/.test(String(pkg.version)), `version 必须是合法 semver：${pkg.version}`);
    } finally {
      cleanup(root);
    }
  },

  "⑥ CLI 契约：--help exit 0 / 未知参数、非法 id、非法 version exit 2 / 坏 asar exit 1"(t) {
    const root = mkTmp("cli");
    try {
      const help = runCli(["--help"]);
      t.eq(help.code, 0, "--help 应 exit 0");
      t.includes(help.out, "用法", "帮助要有用法段");
      t.includes(help.out, "退出码：0 成功", "帮助要写清退出码语义");
      const unknown = runCli(["--nope"]);
      t.eq(unknown.code, 2, "未知参数 ⇒ exit 2");
      t.includes(unknown.err, "未知参数", "要指名未知参数");
      const badId = runCli(["--id", "??非法"]);
      t.eq(badId.code, 2, "非法 id ⇒ exit 2");
      const badVersion = runCli(["--version", "not-a-version"]);
      t.eq(badVersion.code, 2, "非法 --version ⇒ exit 2");
      const missingValue = runCli(["--out"]);
      t.eq(missingValue.code, 2, "缺参数值 ⇒ exit 2");
      const badAsar = runCli(["--asar", nodePath.join(root, "不存在.asar")]);
      t.eq(badAsar.code, 1, "坏 asar ⇒ exit 1（运行失败，不是参数错误）");
      t.includes(badAsar.err, "指定的 asar 不存在", "要给人话");
      // parseArgs 默认 dry-run（不写盘）
      const defaults = parseArgs([], {});
      t.eq(defaults.dryRun, true, "默认必须是 dry-run");
      t.eq(defaults.write, false, "默认不写盘");
      t.eq(defaults.id, "gokifu", "默认 preset id");
      t.eq(parseArgs(["--write"], {}).write, true, "--write 才落盘");
      t.eq(parseArgs(["--id", "x.y_z"], {}).id, "x.y_z", "合法 id 允许 . _ -");
      // C-12：被 import 时零副作用（不跑 CLI、不打横幅、不创建默认输出目录）
      const beforeDefault = nodeFs.existsSync(DEFAULT_OUT);
      const imported = spawnSync(
        process.execPath,
        ["-e", "import('./scripts/make-preset.mjs').then((m) => console.log('imported', typeof m.run, typeof m.buildPresetBundle))"],
        { cwd: REPO, encoding: "utf8", timeout: 60000, windowsHide: true },
      );
      t.eq(imported.status, 0, `被 import 必须可正常加载：${imported.stderr}`);
      t.eq(String(imported.stdout).trim(), "imported function function", "被 import 时零副作用（只导出函数，不跑 CLI）");
      t.eq(nodeFs.existsSync(DEFAULT_OUT), beforeDefault, "被 import 时不许创建默认输出目录");
      // C-12：**非 ASCII 文件名**直接执行也必须真的干活（不是静默 exit 0 / 空输出）
      const nonAscii = nodePath.join(root, "生成 器.mjs");
      nodeFs.copyFileSync(SCRIPT, nonAscii);
      const viaNonAscii = runCliAt(nonAscii, ["--help"]);
      t.eq(viaNonAscii.code, 0, `非 ASCII 文件名直接执行必须成功：${viaNonAscii.err}`);
      t.includes(viaNonAscii.out, "用法", "非 ASCII 文件名下必须真的打印帮助（不是静默空输出）");
    } finally {
      cleanup(root);
    }
  },

/* ─────────────── B · 1.15.0：一个包装上就接管（bundle patch 组合模式） ─────────────── */

"B-1 buildBundlePatch：UI 行 + preset 行 + 默认 preset，官方插件行逐字保留": (t) => {
  const bundle = buildBundlePatch({ officialText: OFFICIAL_FIXTURE, hostVersion: "0.2.1-rc.5" });
  const body = bodyOf(bundle.patchYml);
  t.eq(bundle.presetId, "gokifu", "preset id");
  t.includes(body, "- id: gokifu-ui", "必须插 UI host 行");
  t.includes(body, "name: 'dsh-gokifu-compact'", "UI 行必须用裸包名");
  t.includes(body, "- id: preset-gokifu", "必须插 preset 声明行");
  t.includes(body, "name: 'dsh-gokifu-compact/engine'", "引擎行必须是 /engine 子路径");
  t.eq(body.includes("- id: compaction-basic"), false, "不许残留 compaction-basic");
  t.includes(body, "- id: agent-preset-registry", "必须把注册表默认 preset 指向 gokifu");
  t.includes(body, "default: gokifu", "注册表补丁的默认值");
  t.eq(body.split(String.fromCharCode(10)).filter((l) => l.trim() === "- insert:").length, 1, "顶层 - insert: 恰好一条");
  for (const id of ["persona", "agent-instructions", "time-context", "tool-schedule", "plan-mode", "command-compact", "tool-result-pruner", "workflow-ptc", "tool-ask-user"]) {
    t.includes(body, `- id: ${id}`, `官方插件行 ${id} 必须逐字保留`);
  }
  const NL = String.fromCharCode(10);
  const presetLines = bundle.presetPatchYml.split(NL).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const combinedLines = new Set(bundle.patchYml.split(NL));
  t.eq(presetLines.filter((l) => !combinedLines.has(l)), [], "组合 patch 必须逐行包含纯 preset 产物");
},

"B-2 validateBundlePatch：缺注册表 / 残留 compaction-basic / 缺 UI 行都必须拒绝（不许半成品）": (t) => {
  const good = buildBundlePatch({ officialText: OFFICIAL_FIXTURE, hostVersion: "0.2.1-rc.5" });
  t.eq(validateBundlePatch(good.patchYml, good.presetPatchYml, OFFICIAL_FIXTURE), true, "健康产物必须过检");
  t.throws(
    () => validateBundlePatch(good.patchYml.replace("- id: agent-preset-registry", "- id: not-the-registry"), good.presetPatchYml, OFFICIAL_FIXTURE),
    "缺注册表补丁必须拒绝",
  );
  t.throws(
    () => validateBundlePatch(good.patchYml.replace("name: 'dsh-gokifu-compact/engine'", "name: '@deepseek-ai/dsh-compaction-basic'"), good.presetPatchYml, OFFICIAL_FIXTURE),
    "引擎换回 compaction-basic 必须拒绝",
  );
  t.throws(
    () => validateBundlePatch(good.patchYml.replace("- id: gokifu-ui", "- id: uh-oh"), good.presetPatchYml, OFFICIAL_FIXTURE),
    "缺 UI 行必须拒绝",
  );
},
};
