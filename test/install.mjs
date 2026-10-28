/**
 * install.mjs —— 把 dsh-kifu-context 装进本机 DSH profile（可回滚）
 *
 * 做四件事，每件都留备份：
 *   ① 把包链接进 <profile>/node_modules/dsh-kifu-context（junction，不需要管理员）
 *   ② profile/package.json 的 dependencies 加一条 link（供 pnpm 感知；不改 bundles，
 *      —— 否则 bundle patch 会在顶层再挂一份，与 preset 内那份形成双实例）
 *   ③ preset 的 cordis.patch.yml 里把 compaction group 的 `compaction-basic`
 *      换成 `dsh-kifu-context`（preset 内才是真正生效的那一份，见 profile patch 注释）
 *   ④ 打印 diff 摘要 + 回滚命令
 *
 * 用法：
 *   node test/install.mjs --dry-run
 *   node test/install.mjs --profile desktop --preset personal-assistant
 *   node test/rollback.mjs            # 回滚
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PKG_NAME = "dsh-kifu-context";
const PROJECT_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home";
const PROFILE = getArg("profile", "desktop");
const PRESET = getArg("preset", "personal-assistant");
const PROFILE_DIR = nodePath.join(DSH_HOME, "profiles", PROFILE);
const PRESET_FILE = nodePath.join(DSH_HOME, "preset-bundles", PRESET, "cordis.patch.yml");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_SUFFIX = `.bak-before-chess-context-${ts}`;

const log = (...m) => console.log(...m);

function backup(file) {
  const target = file + BACKUP_SUFFIX;
  if (dryRun) {
    log(`  [dry] 会备份 ${file} → ${nodePath.basename(target)}`);
    return target;
  }
  nodeFs.copyFileSync(file, target);
  log(`  ✓ 备份 ${nodePath.basename(target)}`);
  return target;
}

/* ── ① 链接包 ── */
function linkPackage() {
  const dest = nodePath.join(PROFILE_DIR, "node_modules", PKG_NAME);
  if (nodeFs.existsSync(dest)) {
    log(`  · ${dest} 已存在，跳过链接（如需重建请先 rollback）`);
    return;
  }
  if (dryRun) {
    log(`  [dry] 会创建 junction ${dest} → ${PROJECT_DIR}`);
    return;
  }
  nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
  execFileSync("cmd", ["/c", "mklink", "/J", dest, PROJECT_DIR], { stdio: "ignore" });
  log(`  ✓ junction: ${dest} → ${PROJECT_DIR}`);
}

/* ── ② profile/package.json ── */
function patchProfilePackage() {
  const file = nodePath.join(PROFILE_DIR, "package.json");
  const raw = nodeFs.readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  if (pkg.dependencies?.[PKG_NAME]) {
    log(`  · profile/package.json 已有 ${PKG_NAME}，跳过`);
    return;
  }
  backup(file);
  const deps = { ...(pkg.dependencies ?? {}) };
  deps[PKG_NAME] = `link:${PROJECT_DIR.replace(/\\/g, "/")}`;
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  const next = { ...pkg, dependencies: sorted };
  const out = JSON.stringify(next, null, 2) + "\n";
  if (dryRun) {
    log(`  [dry] 会在 dependencies 加 ${PKG_NAME} → link:${PROJECT_DIR}`);
    return;
  }
  nodeFs.writeFileSync(file, out, "utf8");
  log(`  ✓ profile/package.json 已加 dependency`);
}

/* ── ③ preset 换后端 ── */
function patchPreset() {
  const text = nodeFs.readFileSync(PRESET_FILE, "utf8");
  const startAnchor = "              - id: compaction-basic";
  const start = text.indexOf(startAnchor);
  if (start < 0) {
    if (text.includes("name: 'dsh-kifu-context'") || text.includes(`name: "${PKG_NAME}"`)) {
      log(`  · preset 已是 chess-context，跳过`);
      return;
    }
    throw new Error(`preset 里找不到 compaction-basic 行：${PRESET_FILE}`);
  }
  const configAnchor = "                  thresholdRatio: 0.7";
  const cfgIdx = text.indexOf(configAnchor, start);
  if (cfgIdx < 0) throw new Error("找不到 thresholdRatio: 0.7，拒绝盲改");
  const end = cfgIdx + configAnchor.length;

  const replacement = [
    "              # ★ 2026-10-28 换后端：棋谱式增量 fold（失败记忆 + 置换检测）。",
    "              #   原行是 @deepseek-ai/dsh-compaction-basic（thresholdRatio: 0.7）。",
    "              #   回滚：node test/rollback.mjs  （恢复 .bak-before-chess-context-* 备份）",
    "              - id: chess-context",
    `                name: '${PKG_NAME}'`,
    "                config:",
    "                  # 压力闸：min(窗口×0.45, 窗口−输出预留−64K)",
    "                  thresholdRatio: 0.45",
    "                  headroomTokens: 65536",
    "                  retainRatio: 0.16",
    "                  # 增长闸：距上次 fold 至少新增 40K 才再次 fold",
    "                  growthFloorTokens: 40000",
    "                  minFoldTokens: 8000",
    "                  summaryMode: hybrid",
    "                  maxTokens: 2048",
    "                  hotLedger: true",
    "                  hotLedgerMaxTokens: 500",
    "                  transposition: true",
    "                  tier2After: 8",
  ].join("\n");

  const next = text.slice(0, start) + replacement + text.slice(end);
  if (dryRun) {
    log(`  [dry] preset 会把 compaction-basic 行替换为 chess-context（${next.length - text.length} 字节差）`);
    return;
  }
  backup(PRESET_FILE);
  nodeFs.writeFileSync(PRESET_FILE, next, "utf8");
  log(`  ✓ preset 已换后端：${PRESET_FILE}`);
}

/* ── 校验 ── */
function verify() {
  const problems = [];
  const dest = nodePath.join(PROFILE_DIR, "node_modules", PKG_NAME, "package.json");
  if (!nodeFs.existsSync(dest)) problems.push(`未链接到 profile node_modules：${dest}`);
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(PROFILE_DIR, "package.json"), "utf8"));
  if (!pkg.dependencies?.[PKG_NAME]) problems.push("profile/package.json 缺 dependency");
  if (pkg.dsh?.profile?.bundles?.includes(PKG_NAME)) problems.push("bundles 里不该有它（会顶层双挂载）");
  const preset = nodeFs.readFileSync(PRESET_FILE, "utf8");
  if (!preset.includes(PKG_NAME)) problems.push("preset 未引用 dsh-kifu-context");
  if (preset.includes("- id: compaction-basic")) problems.push("preset 里仍有 compaction-basic（会双实例）");
  return problems;
}

log("== install dsh-kifu-context ==");
log(`profile: ${PROFILE_DIR}`);
log(`preset : ${PRESET_FILE}`);
log(dryRun ? "模式: dry-run\n" : "");
linkPackage();
patchProfilePackage();
patchPreset();
const problems = dryRun ? [] : verify();
if (problems.length) {
  log("\n✗ 校验未通过：");
  for (const p of problems) log(`  - ${p}`);
  process.exitCode = 1;
} else if (!dryRun) {
  log("\n✓ 安装完成。生效需重启 DSH（本会话不能重启自身）。");
  log("  重启后按 docs/重启后验证清单.md 四条确认；回滚：node test/rollback.mjs");
}
