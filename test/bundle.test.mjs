/**
 * bundle.test.mjs —— 本包作为 **DSH bundle**（自带 patch 层）的形状与安装通道（task-118）
 *
 * 为什么要有这个文件：
 *   以前 UI 的 host 半是**手改 profile 的 cordis.patch.yml** 插一行（`id: gokifu-ui`）。
 *   那条路有两个静默后患：升级后手工行还在 ⇒ 与 bundle 通道**同时挂载**（两个 host 半抢同一
 *   个 /gokifu/api 前缀，启动直接失败）；或者反过来，`dsh plugin add` 装完没有挂载行 ⇒
 *   「装好了但没生效」，没有任何报错。
 *
 * 现在本包声明 `dsh.bundle.patch`，install 走 **bundle 优先**：把本包写进
 * `dsh.profile.bundles`，并**备份后删除**旧手工行，保证任何时刻只有一条通道。
 *
 * 本文件锁四件事：
 *   ① package.json 的 bundle 声明齐全（patch 路径 / manifestVersion / files / exports）；
 *   ② `cordis.patch.yml` **只插 UI 一行**（不许把引擎或 config 塞进来 —— 引擎必须在 preset 里）；
 *   ③ 安装器的 bundle 优先与手工行删除（含备份、幂等、dry-run 零写、别的行不动）；
 *   ④ 已存在的 registry/git 规格**不被改写**成 link（用户装的是哪个版本要可追溯）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { run as runInstall, findManualUiRow, removeManualUiRow, patchProfileBundles, ensureBundleChannel, PKG_NAME } from "../scripts/install.mjs";

const REPO = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = PKG_NAME;
const TMP = nodePath.resolve(os.tmpdir());

function mkTemp(label) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-bundle-${label}-`));
  if (!nodePath.resolve(dir).startsWith(TMP)) throw new Error(`夹具必须在 tmp 下：${dir}`);
  return dir;
}

const write = (file, text) => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
};

const PRESET_YML = [
  "plugins:",
  "  - group: true",
  "    isolate:",
  "      compaction: true",
  "    config:",
  "      - id: compaction-basic",
  "        name: '@deepseek-ai/dsh-compaction-basic'",
  "      - id: command-compact",
  "        name: 'dsh-command-compact'",
  "",
].join("\n");

/** 假 profile 目录（不带 preset/home 结构，只测 bundle 通道）。 */
function mkProfile(label, { spec, bundles, manualRow } = {}) {
  const home = mkTemp(label);
  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
  const pkg = { name: "dsh-profile-fixture", private: true, dependencies: spec === undefined ? {} : { [PKG]: spec } };
  if (bundles !== undefined) pkg.dsh = { profile: { bundles } };
  write(nodePath.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  write(nodePath.join(profileDir, "cordis.patch.yml"), manualRow === undefined ? "# fixture profile patch\n" : manualRow);
  return { home, profileDir, cleanup: () => nodeFs.rmSync(home, { recursive: true, force: true }) };
}

const MANUAL_BLOCK = [
  "# fixture profile patch",
  "",
  "# ★ 上下文压缩详情页（host 半）：注册 /gokifu/api，给客户端页提供数据/写配置。",
  "#   客户端 bundle 由本包的 dsh.client 声明自动加载（左栏「上下文压缩」）。",
  "- insert:",
  "    - id: gokifu-ui",
  `      name: '${PKG}'`,
  "",
  "- id: subagent",
  "  name: '@deepseek-ai/dsh-subagent'",
  "",
].join("\n");

export const tests = {
  "B-1 package.json：bundle 声明齐全（patch 路径 / manifestVersion / files / exports）"(t) {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "package.json"), "utf8"));
    t.eq(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "dsh.bundle.patch 必须是 ./cordis.patch.yml");
    t.eq(pkg.dsh?.manifestVersion, 1, "dsh.manifestVersion 必须是 1（与 dsh-better-sidebar 等现役 bundle 一致）");
    t.eq(pkg.dsh?.client?.platform, "web", "dsh.client.platform 仍必须是 web");
    t.ok(nodeFs.existsSync(nodePath.join(REPO, "cordis.patch.yml")), "patch 文件必须真实存在");
    t.eq(pkg.files.includes("cordis.patch.yml"), true, "cordis.patch.yml 必须在 files 里（否则 npm 包里没有它）");
    t.eq(pkg.exports?.["./cordis.patch.yml"], "./cordis.patch.yml", "exports 必须暴露 ./cordis.patch.yml");
    t.eq(pkg.main, "src/ui.mjs", "main 仍是 host 半入口（bundle 不改变它）");
  },

  "B-2 cordis.patch.yml：只插 UI 一行（引擎/配置不许进 patch）"(t) {
    const text = nodeFs.readFileSync(nodePath.join(REPO, "cordis.patch.yml"), "utf8");
    const lines = text.split("\n");
    const inserts = lines.filter((l) => /^- insert:\s*$/.test(l));
    t.eq(inserts.length, 1, "顶级 - insert: 必须恰好 1 个");
    const ids = lines.filter((l) => /^\s*- id:/.test(l)).map((l) => l.trim());
    t.eq(ids, ["- id: gokifu-ui"], "插入行必须只有 id: gokifu-ui");
    t.includes(text, `name: '${PKG}'`, "插入行必须用裸包名（client-modules 只对包根说明符发现客户端）");
    // 引擎必须在 preset 的 compaction group 里；patch 里出现这些 = 挂错层
    for (const banned of ["compaction", "engine", "config:", "disabled:"]) {
      t.eq(new RegExp(`^\\s*${banned}`, "m").test(text.replace(/^#.*$/gm, "")), false, `patch 里不许出现 ${banned}（引擎归 preset，配置归宿主）`);
    }
    // 缩进：子行必须比 - insert: 深
    const insertIdx = lines.findIndex((l) => /^- insert:\s*$/.test(l));
    const childIdx = lines.findIndex((l) => /^\s*- id: gokifu-ui/.test(l));
    t.eq(lines[childIdx].match(/^\s*/)[0].length > lines[insertIdx].match(/^\s*/)[0].length, true, "子行缩进必须比 - insert: 深");
  },

  "B-3 findManualUiRow：整块识别 / 多子行时只删本行 / 结构不认识时拒绝"(t) {
    const whole = findManualUiRow(MANUAL_BLOCK);
    t.eq(whole.wholeBlock, true, "只有本行子项的 insert 块 ⇒ 整块删");
    const text = MANUAL_BLOCK.split("\n");
    t.eq(text[whole.start], "- insert:", `起始行必须是 - insert:，实际 ${text[whole.start]}`);
    const afterBlock = text.slice(whole.end + 1).join("\n");
    t.includes(afterBlock, "- id: subagent", "块结束后必须紧接着下一个顶级条目");
    // 多子行：insert 块里还有别的插件 ⇒ 只删自己那一行
    const mixed = ["- insert:", "    - id: other-plugin", `      name: 'x'`, "    - id: gokifu-ui", `      name: '${PKG}'`, ""].join("\n");
    const mixedFound = findManualUiRow(mixed);
    t.eq(mixedFound.wholeBlock, false, "insert 块里还有别的插件 ⇒ 只删本行");
    t.eq(mixedFound.startLine, 3, "本行下标");
    // 结构不认识：没有父 insert 行
    const broken = ["plugins:", "  - id: gokifu-ui", `    name: '${PKG}'`].join("\n");
    t.eq(findManualUiRow(broken).unsupported, true, "找不到 - insert: 父行时必须拒绝改");
    t.eq(findManualUiRow("# 没有这一行\n"), null, "没有手工行 ⇒ null");
  },

  "B-4 安装通道：bundle 优先 —— bundles 追加 + 旧手工行（带备份）删除"(t) {
    const fx = mkProfile("channel", { bundles: ["@deepseek-ai/dsh-base", "@liustack/modsearch"], manualRow: MANUAL_BLOCK });
    try {
      const logs = [];
      const res = ensureBundleChannel(fx.profileDir, (m) => logs.push(m), false);
      const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(fx.profileDir, "package.json"), "utf8"));
      t.eq(pkg.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "@liustack/modsearch", PKG], "本包必须追加在末尾、既有顺序不变");
      t.eq(res.bundle.changed, true, "bundle 通道必须被写入");
      const backups = nodeFs.readdirSync(fx.profileDir).filter((f) => f.startsWith("package.json.bak-before-gokifu-"));
      t.eq(backups.length, 1, "改 profile/package.json 前必须备份");
      const patch = nodeFs.readFileSync(nodePath.join(fx.profileDir, "cordis.patch.yml"), "utf8");
      t.eq(/^\s*- id:\s*gokifu-ui\s*$/m.test(patch), false, "手工行必须被删除");
      t.includes(patch, "- id: subagent", "别的条目必须逐字保留");
      t.eq(patch.includes("上下文压缩详情页"), false, "配套死注释必须一并删除");
      const patchBackups = nodeFs.readdirSync(fx.profileDir).filter((f) => f.startsWith("cordis.patch.yml.bak-before-gokifu-ui-"));
      t.eq(patchBackups.length, 1, "删手工行前必须备份 profile cordis.patch.yml");
      const backupText = nodeFs.readFileSync(nodePath.join(fx.profileDir, patchBackups[0]), "utf8");
      t.includes(backupText, "- id: gokifu-ui", "备份里必须还能看到被删的那一行");
      // 幂等：再跑一次什么都不改
      const again = ensureBundleChannel(fx.profileDir, () => {}, false);
      t.eq(again.bundle.changed, false, "已在 bundles ⇒ 不再写");
      t.eq(again.manual.changed, false, "手工行已删 ⇒ 不再写");
    } finally {
      fx.cleanup();
    }
  },

  "B-5 dry-run 零写入 + 只有手工行没有 bundles 时也能收口"(t) {
    const fx = mkProfile("dry", { manualRow: MANUAL_BLOCK });
    try {
      const beforePkg = nodeFs.readFileSync(nodePath.join(fx.profileDir, "package.json"), "utf8");
      const beforePatch = nodeFs.readFileSync(nodePath.join(fx.profileDir, "cordis.patch.yml"), "utf8");
      const res = ensureBundleChannel(fx.profileDir, () => {}, true);
      t.eq(res.bundle.changed, true, "dry-run 也要报告会改");
      t.eq(nodeFs.readFileSync(nodePath.join(fx.profileDir, "package.json"), "utf8"), beforePkg, "dry-run 不许写 profile/package.json");
      t.eq(nodeFs.readFileSync(nodePath.join(fx.profileDir, "cordis.patch.yml"), "utf8"), beforePatch, "dry-run 不许写 cordis.patch.yml");
      t.eq(nodeFs.readdirSync(fx.profileDir).filter((f) => f.includes(".bak-")).length, 0, "dry-run 不许产备份");
    } finally {
      fx.cleanup();
    }
  },

  "B-6 registry/git 规格不被改写成 link（用户的安装来源必须可追溯）"(t) {
    const home = mkTemp("registry");
    const profileDir = nodePath.join(home, "profiles", "desktop");
    nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
    // 真实复制安装（node_modules 里是真目录，不是 junction）⇒ 安装器的「复制安装」分支
    const installed = nodePath.join(profileDir, "node_modules", PKG);
    write(nodePath.join(installed, "package.json"), JSON.stringify({ name: PKG, version: "1.11.1", main: "src/ui.mjs" }, null, 2) + "\n");
    write(nodePath.join(installed, "src", "ui.mjs"), "export const ui = true;\n");
    write(nodePath.join(profileDir, "package.json"), JSON.stringify({
      name: "dsh-profile-fixture",
      private: true,
      dependencies: { [PKG]: "^1.11.0" },
      dsh: { profile: { bundles: [PKG] } },
    }, null, 2) + "\n");
    write(nodePath.join(profileDir, "cordis.patch.yml"), "# fixture profile patch\n");
    write(nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml"), PRESET_YML);
    try {
      const logs = [];
      const code = runInstall(["install", "--home", home, "--profile", "desktop", "--quiet"]);
      // run() 的 log 通道由 parseArgs 决定（--quiet 静音），这里只关心磁盘结果
      const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(profileDir, "package.json"), "utf8"));
      t.eq(pkg.dependencies[PKG], "^1.11.0", `registry 规格必须原样保留，实际 ${pkg.dependencies[PKG]}`);
      t.eq(pkg.dsh.profile.bundles, [PKG], "bundle 通道仍会被确保");
      t.ok(code === 0 || code === 1, `run() 必须返回退出码，实际 ${code}`);
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  },
};