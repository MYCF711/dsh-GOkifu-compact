#!/usr/bin/env node
/**
 * apply-pending-preset.mjs —— 把面板保存产生的 `.pending` 在重启前应用成实时 preset（C664）
 *
 * 机器铁律 3：`cordis.patch.yml` 是**热重载开关**，运行中写它会整树热重载 ⇒ host `exit(1)`。
 * 面板因此只写 `<preset>.pending`；**由这个脚本应用**：备份 → 校验 → 原子替换。
 *
 * 用法：
 *   node scripts/apply-pending-preset.mjs                    # 预演
 *   node scripts/apply-pending-preset.mjs --write            # 真做（之后仍需重启 DSH）
 *   node scripts/apply-pending-preset.mjs --write --home X
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { findPresetFiles, resolveHome, BACKUP_MARK, PENDING_SUFFIX, findSecretLike } from "../src/ui.mjs";
import { parseEngineBlock, ENTRY_ID } from "../src/rooms/preset-format.mjs";

const argv = new Set(process.argv.slice(2));
const WRITE = argv.has("--write");
function flagValue(name) {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return "";
  return args[i].includes("=") ? args[i].slice(name.length + 3) : (args[i + 1] ?? true);
}

/** 校验 pending 能否替换实时文件。 */
export function validatePending(livePath, pendingText) {
  if (typeof pendingText !== "string" || pendingText.trim() === "") return { ok: false, reason: "pending 是空的（面板写坏了？）" };
  if (!pendingText.includes(ENTRY_ID)) return { ok: false, reason: `pending 里没有 ${ENTRY_ID}（不是本插件的 preset）` };
  if (parseEngineBlock(pendingText) === null) return { ok: false, reason: "pending 解析不出 engine 块（结构坏了，拒绝替换）" };
  let live = "";
  try { live = nodeFs.readFileSync(livePath, "utf8"); } catch { /* 实时文件不存在也允许 */ }
  if (live === pendingText) return { ok: false, reason: "与实时文件逐字相同，无需应用" };
  return { ok: true };
}

function backupLive(livePath) {
  const live = nodeFs.readFileSync(livePath, "utf8");
  if (findSecretLike(live).length > 0) return { skipped: true, reason: "实时 preset 含疑似密钥，跳过明文备份" };
  const stamp = `${Date.now()}`;
  let candidate = `${livePath}${BACKUP_MARK}${stamp}`;
  let n = 1;
  while (nodeFs.existsSync(candidate)) { n += 1; candidate = `${livePath}${BACKUP_MARK}${stamp}-${n}`; }
  nodeFs.copyFileSync(livePath, candidate);
  return { skipped: false, file: candidate };
}

/** 同目录 tmp + rename ⇒ 原子；热重载永远读不到半个文件。 */
function atomicReplace(livePath, text) {
  const tmp = `${livePath}.tmp-${process.pid}`;
  nodeFs.writeFileSync(tmp, text, "utf8");
  nodeFs.renameSync(tmp, livePath);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  const home = flagValue("home") || resolveHome();
  console.log(`apply-pending-preset · home=${home} · ${WRITE ? "**真做**" : "预演（加 --write 才动手）"}`);
  let applied = 0, skipped = 0;
  for (const preset of findPresetFiles(home)) {
    const pendingPath = `${preset.file}${PENDING_SUFFIX}`;
    if (!nodeFs.existsSync(pendingPath)) continue;
    const pendingText = nodeFs.readFileSync(pendingPath, "utf8");
    const check = validatePending(preset.file, pendingText);
    if (!check.ok) { console.log(`  ⊘ 跳过 ${nodePath.basename(preset.file)}：${check.reason}`); skipped += 1; continue; }
    if (!WRITE) { console.log(`  · 将应用 ${nodePath.basename(preset.file)}（${pendingText.length} 字节）→ 备份 → 原子替换`); applied += 1; continue; }
    const backup = nodeFs.existsSync(preset.file) ? backupLive(preset.file) : { skipped: true, reason: "实时文件不存在" };
    atomicReplace(preset.file, pendingText);
    nodeFs.rmSync(pendingPath, { force: true });
    console.log(`  ✓ 已应用 ${nodePath.basename(preset.file)}${backup.skipped ? `（备份跳过：${backup.reason}）` : `（备份 ${nodePath.basename(backup.file)}）`}`);
    applied += 1;
  }
  if (applied === 0 && skipped === 0) console.log("  没有待应用的 .pending —— 面板没存过东西，或已经应用过。");
  else {
    console.log(`  合计：${applied} 份${WRITE ? "已应用" : "待应用"} / ${skipped} 份跳过`);
    if (WRITE && applied > 0) console.log("  ⇒ **重启 DSH 后才生效**（插件在 boot 时读 preset）。");
  }
}
