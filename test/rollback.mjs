/**
 * rollback.mjs —— 撤销 test/install.mjs 的全部改动
 *
 * 找最新的 .bak-before-chess-context-* 备份并恢复；删掉 node_modules 里的 junction。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

const PKG_NAME = "dsh-chess-context";
const DSH_HOME = process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home";
const profileArg = process.argv.indexOf("--profile");
const PROFILE = profileArg >= 0 ? process.argv[profileArg + 1] : "desktop";
const presetArg = process.argv.indexOf("--preset");
const PRESET = presetArg >= 0 ? process.argv[presetArg + 1] : "personal-assistant";

const PROFILE_DIR = nodePath.join(DSH_HOME, "profiles", PROFILE);
const PRESET_FILE = nodePath.join(DSH_HOME, "preset-bundles", PRESET, "cordis.patch.yml");
const PREFIX = ".bak-before-chess-context-";

function latestBackup(dir, base) {
  const files = nodeFs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + PREFIX))
    .sort();
  return files.length ? nodePath.join(dir, files[files.length - 1]) : null;
}

let restored = 0;
for (const [file, dir, base] of [
  [PRESET_FILE, nodePath.dirname(PRESET_FILE), nodePath.basename(PRESET_FILE)],
  [nodePath.join(PROFILE_DIR, "package.json"), PROFILE_DIR, "package.json"],
]) {
  const bak = latestBackup(dir, base);
  if (bak === null) {
    console.log(`· 没有 ${base} 的备份，跳过`);
    continue;
  }
  nodeFs.copyFileSync(bak, file);
  console.log(`✓ 恢复 ${base} ← ${nodePath.basename(bak)}`);
  restored += 1;
}

const dest = nodePath.join(PROFILE_DIR, "node_modules", PKG_NAME);
if (nodeFs.existsSync(dest)) {
  try {
    // junction 用 rmdir 删除（不递归删目标内容）
    nodeFs.rmSync(dest, { recursive: false });
    console.log(`✓ 移除 junction ${dest}`);
  } catch {
    console.log(`! 移除失败，请手工删除目录链接：${dest}`);
  }
}

console.log(restored > 0 ? "\n回滚完成。重启 DSH 生效。" : "\n没有可回滚的改动。");
