/**
 * verify-install.mjs —— 不重启 DSH 的「挂载校验」
 *
 * 检查 6 件事，任何一条失败都退出码 1：
 *   ① 包已链接进 profile/node_modules，且能读到 package.json
 *   ② profile/package.json 有 link 依赖，且 dsh.profile.bundles 里没有它（防止顶层双挂载）
 *   ③ preset 的 compaction group 里是 dsh-kifu-context，且没有 compaction-basic（单实例）
 *   ④ preset 的 group 仍然 isolate:{compaction:true}（否则整个 preset 挂载失败）
 *   ⑤ preset 里其他 compaction 成员（command-compact / tool-result-pruner）还在
 *   ⑥ 运行期证据：<DSH_HOME>/chess-context/sessions 下有 graph.json（说明 keeper 真跑过）
 *
 * 用法：node test/verify-install.mjs [--profile desktop] [--preset personal-assistant]
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PKG = "dsh-kifu-context";
const DSH_HOME = process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home";
const PROFILE = getArg("profile", "desktop");
const PRESET = getArg("preset", "personal-assistant");
const PROFILE_DIR = nodePath.join(DSH_HOME, "profiles", PROFILE);
const PRESET_FILE = nodePath.join(DSH_HOME, "preset-bundles", PRESET, "cordis.patch.yml");

const checks = [];
const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

/* ① 包链接 */
const pkgJson = nodePath.join(PROFILE_DIR, "node_modules", PKG, "package.json");
add("包已链接进 profile/node_modules", nodeFs.existsSync(pkgJson), pkgJson);
if (nodeFs.existsSync(pkgJson)) {
  const pkg = JSON.parse(nodeFs.readFileSync(pkgJson, "utf8"));
  add("包名正确", pkg.name === PKG, pkg.name);
  add("有 main 入口", typeof pkg.main === "string" && nodeFs.existsSync(nodePath.resolve(nodePath.dirname(pkgJson), pkg.main)), pkg.main ?? "(none)");
  const peers = pkg.peerDependencies ?? {};
  const want = ["@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-compaction", "@deepseek-ai/dsh-llm", "@deepseek-ai/schemastery"];
  const missing = want.filter((p) => !peers[p]);
  add("peerDependencies 齐全", missing.length === 0, missing.join(", ") || "ok");
  const badVersion = Object.entries(peers).filter(([, v]) => /^\^0\.2\.0/.test(v));
  add("peer 版本是精确 0.2.0-rc.2（预发布不能用 ^0.2.0）", badVersion.length === 0, JSON.stringify(peers));
}

/* ② profile/package.json */
const profilePkgPath = nodePath.join(PROFILE_DIR, "package.json");
if (nodeFs.existsSync(profilePkgPath)) {
  const pkg = JSON.parse(nodeFs.readFileSync(profilePkgPath, "utf8"));
  add("profile/package.json 有 link 依赖", Boolean(pkg.dependencies?.[PKG]), pkg.dependencies?.[PKG] ?? "");
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  add("dsh.profile.bundles 里没有它（避免顶层双挂载）", !bundles.includes(PKG), bundles.join(", "));
}

/* ③④⑤ preset */
if (nodeFs.existsSync(PRESET_FILE)) {
  const text = nodeFs.readFileSync(PRESET_FILE, "utf8");
  add("preset 引用了 dsh-kifu-context", text.includes(`'${PKG}'`) || text.includes(`"${PKG}"`));
  add("preset 里没有 compaction-basic（单实例）", !text.includes("- id: compaction-basic"));
  add("preset 保留 command-compact", text.includes("dsh-command-compact"));
  add("preset 保留 tool-result-pruner", text.includes("dsh-compaction-tool-result-pruner"));
  // 找 chess-context 所在 group 的 isolate
  const idx = text.indexOf(`'${PKG}'`) >= 0 ? text.indexOf(`'${PKG}'`) : text.indexOf(`"${PKG}"`);
  const before = text.slice(Math.max(0, idx - 2200), idx);
  const iso = before.lastIndexOf("isolate:");
  const isoBlock = iso >= 0 ? before.slice(iso, iso + 120) : "";
  add("引擎行仍在 isolate:{compaction:true} 的 group 内", /compaction:\s*true/.test(isoBlock), isoBlock.replace(/\s+/g, " ").slice(0, 80));
} else {
  add("preset 文件存在", false, PRESET_FILE);
}

/* ⑥ 运行期证据 */
const graphRoot = nodePath.join(DSH_HOME, "chess-context", "sessions");
let graphs = [];
if (nodeFs.existsSync(graphRoot)) {
  for (const d of nodeFs.readdirSync(graphRoot)) {
    const f = nodePath.join(graphRoot, d, "graph.json");
    if (nodeFs.existsSync(f)) graphs.push({ dir: d, size: nodeFs.statSync(f).size, mtime: nodeFs.statSync(f).mtime });
  }
}
add("运行期已产出棋谱（keeper 真跑过）", graphs.length > 0, graphs.length ? `${graphs.length} 个会话，最新 ${graphs.sort((a, b) => b.mtime - a.mtime)[0].dir.slice(0, 24)}… (${graphs[0]?.size ?? 0}B)` : "无 graph.json");

/* 输出 */
let failed = 0;
console.log(`== verify-install（profile=${PROFILE}, preset=${PRESET}）==`);
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `　— ${c.detail}` : ""}`);
}
console.log(failed === 0 ? "\n== 全部通过 ==" : `\n== ${failed} 项失败 ==`);
if (failed > 0) process.exitCode = 1;
