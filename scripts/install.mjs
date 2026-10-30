/**
 * install.mjs —— 一条命令让 dsh-gokifu-compact 接管压缩后端（不需要手改任何 YAML）
 *
 * 为什么必须改 preset 文件：DSH 的压缩后端是挂在 **agent preset 的 compaction group 里**
 * 的一行（`@deepseek-ai/dsh-compaction-basic`）。那是 preset 的 `config.plugins` 数组内部，
 * 不是 loader 顶层条目 —— profile 级 / bundle 级的 patch 打不到它
 * （`applyEntryPatches` 只递归 `group: true` 且 `config` 为数组的条目，而 preset 的 plugins
 * 是 `config.plugins`；实测记录见 docs/DSH-技术测绘.md §7.6）。
 *
 * 这个脚本就是替你改那一行，并且：
 *   · 自动找 profile / preset（把 preset 里所有 `- id: compaction-basic` 块换掉）
 *   · 改之前备份（`*.bak-before-gokifu-<ts>`），`revert` 一键还原
 *   · `--dry-run` 只打印不写盘
 *   · 幂等：判「链接解析后的真实目录是不是本目录」，不是判「字符串/键存不存在」；
 *     指向别处、断链、指到不存在的目录 —— 一律重建 + 改写依赖声明（旧值先备份）
 *   · 双模式：从仓库跑（建/修 junction + 依赖声明）/ 从已装的链接跑（判定为安装态，跳过链接）
 *   · 复制安装（node_modules 里是真实目录，例如从 npm registry 装的）不动它的依赖声明
 *
 * 用法：
 *   dsh-gokifu-compact install [--profile desktop] [--preset personal-assistant] [--dry-run]
 *   dsh-gokifu-compact revert  [--profile desktop]
 *
 * 兼容：`node test/install.mjs` 仍然可用（薄封装到这个文件）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createDirLink, inspectSpec, realPathOrNull, removeDirLink, samePath, statLink, toLinkSpec } from "./link-path.mjs";
import { PKG_NAME, ENTRY_ID, replaceCompactionBlock, engineBlock, parseEngineBlock, renderEngineBlock, KEY_COMMENTS } from "../src/rooms/preset-format.mjs";

// ★ A2-1（2026-10-30）：preset 块格式的唯一事实已搬到 src/rooms/preset-format.mjs（R13 子房间）。
//   这里保留**同名兼容再导** —— test/ui.test.mjs、test/ui-config.test.mjs、test/install-link.test.mjs
//   都从 scripts/install.mjs 取这些符号；删掉这行不会让文件加载失败，而是让 ui(38/16)/
//   ui-config(8/5)/ui-security(19/6) 在**运行期**红（导入得 undefined，不是 SyntaxError）。
export { PKG_NAME, ENTRY_ID, replaceCompactionBlock, engineBlock, parseEngineBlock, renderEngineBlock, KEY_COMMENTS };

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
/**
 * 安装源目录 —— 只能来自**可靠事实**（脚本自己所在的真实目录），不许从包名猜目录名。
 *
 * 为什么写这段：v0.4.0 改名那次，profile 里被写成
 * `link:D:/主工作区/projects/dsh-gokifu-compact` —— 那是**跟着包名猜出来的目录**，
 * 真实目录一直叫 `dsh-chess-context`。重装时 pnpm 对不存在的 link 目标只打一行 WARN，
 * **退出码 0、且不建任何链接** ⇒「重装即坏」是静默的（本轮实测见 docs/草稿 §S10a 证据）。
 * realpath 同时解决两件事：从 junction 里跑（安装态）时拿回真身；路径大小写被规范化。
 */
export const PROJECT_DIR = realPathOrNull(nodePath.resolve(HERE, "..")) ?? nodePath.resolve(HERE, "..");

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "install";
  const get = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    command,
    dryRun: args.includes("--dry-run"),
    profile: get("profile", process.env.DSH_PROFILE ?? "desktop"),
    preset: get("preset", ""),
    dshHome: get(
      "home",
      process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home"),
    ),
    log: args.includes("--quiet") ? () => {} : (...m) => console.log(...m),
  };
}

function installedLocation(dshHome, profile) {
  const profilePkg = nodePath.join(dshHome, "profiles", profile, "node_modules", PKG_NAME);
  // 旧写法 `nodePath.resolve(profilePkg) === PROJECT_DIR` 不跟随链接：拿 junction 自己的路径
  // 去比真实仓库路径，永远不相等 —— 判定必须用 realpath。
  const real = realPathOrNull(profilePkg);
  return real !== null && samePath(real, PROJECT_DIR);
}

function presetsWithCompaction(dshHome) {
  const root = nodePath.join(dshHome, "preset-bundles");
  if (!nodeFs.existsSync(root)) return [];
  const out = [];
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "cordis.patch.yml");
    if (!nodeFs.existsSync(file)) continue;
    const text = nodeFs.readFileSync(file, "utf8");
    if (text.includes("- id: compaction-basic") || text.includes(PKG_NAME)) out.push({ name: entry.name, file, text });
  }
  return out;
}

export function backupFile(file, ts = Date.now()) {
  const target = `${file}.bak-before-gokifu-${ts}`;
  nodeFs.copyFileSync(file, target);
  return target;
}

export function revertPreset(file, log = console.log) {
  const dir = nodePath.dirname(file);
  const base = nodePath.basename(file);
  const backups = nodeFs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-before-`))
    .sort()
    .reverse();
  if (backups.length === 0) {
    log(`  ! ${file} 没有备份可恢复`);
    return false;
  }
  nodeFs.copyFileSync(nodePath.join(dir, backups[0]), file);
  log(`  ✓ 已还原 ${file} ← ${backups[0]}`);
  return true;
}

/** 旧版本残留：有我们的 name，但 id 还是别的（例如 chess-context）。只改 id 行。 */
function renameLegacyId(text) {
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id:\s*([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
    if (!m || m[2] === ENTRY_ID) continue;
    const near = lines.slice(i, i + 3).join("\n");
    if (!near.includes(PKG_NAME)) continue;
    lines[i] = `${m[1]}- id: ${ENTRY_ID}`;
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

/**
 * 在 profile 的 cordis.patch.yml 里挂上 UI 的 host 半（`id: gokifu-ui`，裸包名）。
 * 为什么用裸包名：client-modules 只对「包根说明符」做客户端发现（子路径直接跳过），
 * 所以 host 半必须是 `dsh-gokifu-compact`（根 = src/ui.mjs），引擎在 preset 里用 `/engine`。
 */
export function patchProfileForUi(profileDir, log = () => {}, dryRun = false) {
  const file = nodePath.join(profileDir, "cordis.patch.yml");
  if (!nodeFs.existsSync(file)) return { changed: false, reason: "没有 profile cordis.patch.yml" };
  const text = nodeFs.readFileSync(file, "utf8");
  if (text.includes("id: gokifu-ui")) return { changed: false, reason: "已挂载" };
  const block = [
    "",
    "# ★ 上下文压缩详情页（host 半）：注册 /gokifu/api，给客户端页提供数据/写配置。",
    "#   客户端 bundle 由本包的 dsh.client 声明自动加载（左栏「上下文压缩」）。",
    "- insert:",
    "    - id: gokifu-ui",
    `      name: '${PKG_NAME}'`,
    "",
  ].join("\n");
  const next = text.endsWith("\n") ? text + block : text + "\n" + block;
  if (dryRun) {
    log("  [dry] profile cordis.patch.yml 会加 gokifu-ui");
    return { changed: true, dryRun: true };
  }
  const backup = `${file}.bak-before-gokifu-ui-${Date.now()}`;
  nodeFs.copyFileSync(file, backup);
  nodeFs.writeFileSync(file, next, "utf8");
  log(`  ✓ profile cordis.patch.yml 已加 gokifu-ui（备份 ${nodePath.basename(backup)}）`);
  return { changed: true, backup };
}

export function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { dryRun, profile, dshHome, log } = opts;
  const profileDir = nodePath.join(dshHome, "profiles", profile);

  if (!nodeFs.existsSync(profileDir)) {
    console.error(`找不到 profile 目录：${profileDir}（用 --profile / --home 指定）`);
    return 1;
  }

  const targets = presetsWithCompaction(dshHome).filter((p) => (opts.preset ? p.name === opts.preset : true));
  if (targets.length === 0) {
    console.error(`在 ${nodePath.join(dshHome, "preset-bundles")} 下没找到含 compaction-basic 的 preset`);
    return 1;
  }

  log(`== dsh-gokifu-compact ${opts.command} ==`);
  log(`profile: ${profileDir}`);
  for (const t of targets) log(`preset : ${t.file}`);
  log(dryRun ? "模式: dry-run（不写盘）\n" : "");

  if (opts.command === "revert") {
    for (const t of targets) revertPreset(t.file, log);
    log("\n还原后重启 DSH 生效。");
    return 0;
  }

  if (opts.command !== "install") {
    console.error(`未知命令：${opts.command}（可用：install / revert）`);
    return 1;
  }

  /* ① 确保包装进 profile（链接对就跳过；链接错就重建 —— 不许「存在即跳过」） */
  const dest = nodePath.join(profileDir, "node_modules", PKG_NAME);
  const destLink = statLink(dest);
  /** 复制安装（node_modules 里是真实目录，例如从 npm registry 装的）—— 不是链接安装，不改它的依赖声明。 */
  const copiedInstall = destLink.present && !destLink.isLink;

  if (copiedInstall) {
    log(`  ! ${dest} 是真实目录（复制 / npm 安装）—— 按复制安装处理，不改依赖声明`);
  } else if (installedLocation(dshHome, profile)) {
    log(`  · 链接已指向本目录：${dest} → ${PROJECT_DIR}`);
  } else if (!destLink.present) {
    if (dryRun) log(`  [dry] 会建 junction ${dest} → ${PROJECT_DIR}`);
    else {
      createDirLink(PROJECT_DIR, dest);
      log(`  ✓ junction: ${dest} → ${PROJECT_DIR}`);
    }
  } else {
    // 断链，或指向别的目录：旧代码在这里打印「已存在（不是本目录），跳过链接」然后 ✓ 完成 ——
    // 装完的状态和声明仍然对不上，属于安装器自己的假绿。这里重建。
    const now = destLink.targetExists ? destLink.realPath : "断链";
    if (dryRun) log(`  [dry] 会重建 junction ${dest}（现在 → ${now}）`);
    else {
      removeDirLink(dest);
      createDirLink(PROJECT_DIR, dest);
      log(`  ✓ junction 已重建（原来 → ${now}）：${dest} → ${PROJECT_DIR}`);
    }
  }

  /* 依赖声明：不能只看「有没有这个键」，必须解析到真实目标。
     键存在但指向不存在的目录 = 重装即坏（pnpm 只 WARN、退出码 0、不建链接）。 */
  if (!copiedInstall) {
    const pkgFile = nodePath.join(profileDir, "package.json");
    const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
    const declared = pkg.dependencies?.[PKG_NAME] ?? null;
    const want = toLinkSpec(PROJECT_DIR);
    const spec = declared === null ? null : inspectSpec(declared, profileDir);
    const correct =
      spec !== null &&
      (spec.kind === "link" || spec.kind === "file") &&
      spec.ok &&
      spec.target.packageName === PKG_NAME &&
      samePath(spec.target.realPath, PROJECT_DIR);
    if (correct) {
      log(`  · profile/package.json 的 ${PKG_NAME} 已指向本目录：${declared}`);
    } else if (dryRun) {
      log(`  [dry] 会${declared === null ? "加" : "修"} profile/package.json 的 ${PKG_NAME}：${declared ?? "(无)"} → ${want}`);
    } else {
      nodeFs.copyFileSync(pkgFile, `${pkgFile}.bak-before-gokifu-${Date.now()}`);
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: want };
      nodeFs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      log(`  ✓ profile/package.json 已${declared === null ? "加" : "修"} ${PKG_NAME}：${declared ?? "(无)"} → ${want}`);
    }
  }

  /* ② 换 preset 里的压缩后端 */
  for (const t of targets) {
    const hasOurs = t.text.includes(PKG_NAME);
    const hasOurId = /^\s*- id: gokifu-compact\s*$/m.test(t.text);
    const hasEngineName = t.text.includes(`${PKG_NAME}/engine`);
    if (hasOurs && hasOurId && hasEngineName) {
      log(`  · ${nodePath.basename(nodePath.dirname(t.file))}: 已是 ${ENTRY_ID}，跳过`);
      continue;
    }
    if (hasOurs && hasOurId && !hasEngineName) {
      // 迁移：v1.8 之前 preset 里写的是包根名（那时根就是引擎）；现在根是 UI，引擎在 /engine。
      const parsed = parseEngineBlock(t.text);
      const next = parsed === null ? null : t.text.replace(parsed.raw, renderEngineBlock(parsed.config, parsed.indent));
      if (next === null) {
        log(`  ! ${t.file}: 找不到引擎块，跳过迁移`);
        continue;
      }
      if (dryRun) {
        log(`  [dry] ${t.file}: 引擎名迁移为 ${PKG_NAME}/engine`);
        continue;
      }
      const backup = backupFile(t.file);
      nodeFs.writeFileSync(t.file, next, "utf8");
      log(`  ✓ ${t.file} 引擎名迁移为 ${PKG_NAME}/engine（备份 ${nodePath.basename(backup)}）`);
      continue;
    }
    if (hasOurs && !hasOurId) {
      const renamed = renameLegacyId(t.text);
      if (renamed === null) {
        log(`  ! ${t.file}: 有 ${PKG_NAME} 但找不到可改的旧 id 行，跳过（请手工检查）`);
        continue;
      }
      if (dryRun) {
        log(`  [dry] ${t.file}: 旧 id 改名为 ${ENTRY_ID}`);
        continue;
      }
      const backup = backupFile(t.file);
      nodeFs.writeFileSync(t.file, renamed, "utf8");
      log(`  ✓ ${t.file} 已把旧 id 改名为 ${ENTRY_ID}（备份 ${nodePath.basename(backup)}）`);
      continue;
    }
    const next = replaceCompactionBlock(t.text, engineBlock());
    if (next === null) {
      log(`  ! ${t.file}: 找不到 compaction-basic 块，跳过`);
      continue;
    }
    if (dryRun) {
      log(`  [dry] ${t.file}: compaction-basic → ${ENTRY_ID}`);
      continue;
    }
    const backup = backupFile(t.file);
    nodeFs.writeFileSync(t.file, next, "utf8");
    log(`  ✓ ${t.file} 已换后端（备份 ${nodePath.basename(backup)}）`);
  }

  /* ③ 挂 UI 的 host 半（profile 级）：裸包名，客户端 bundle 靠它被发现 */
  const ui = patchProfileForUi(profileDir, (m) => log(m), dryRun);
  if (ui.changed === false) log(`  · UI host 半：${ui.reason}`);

  if (dryRun) {
    log("\n这是预演，什么都没改。真装去掉 --dry-run。");
    return 0;
  }
  log("\n✓ 完成。重启 DSH 后生效（插件在启动时加载）。");
  log("  重启后自检：npx dsh-gokifu-compact doctor");
  log("  回滚：npx dsh-gokifu-compact revert");
  return 0;
}

// 判「是不是被直接执行」必须用 realpath：经 junction 调用时（`node <profile>/node_modules/<pkg>/scripts/install.mjs`）
// `import.meta.url` 已被 Node 解析成真身，而 argv[1] 还是链接路径 ⇒ 旧写法判 false ⇒ **静默什么都不做、退出码 0**。
// 那正是最坏的一种假绿（命令「成功」了但没干活）。verify-install.mjs 末尾同一处也一并改。
const invokedDirectly = process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = run();
