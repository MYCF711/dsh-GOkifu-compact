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


/* ─────────────── ②·b bundle 通道（task-118） ─────────────── */

/** 手工行的 id（历史值，保持兼容：日志/doctor/文档都用这个口径）。 */
const MANUAL_UI_ID = "gokifu-ui";

/**
 * 在 profile 的 cordis.patch.yml 里定位手工 UI 行（`- insert:` + `- id: gokifu-ui`）。
 *
 * 纯函数：只算行号，不改任何东西（方便测试与 dry-run）。找不到返回 null。
 * 结构不认识时返回 `{ unsupported: true }` —— 调用方必须**拒绝改**，绝不能猜着删。
 * @returns {{startLine:number,endLine:number,start:number,end:number,wholeBlock:boolean}|{unsupported:true,reason:string}|null}
 */
export function findManualUiRow(text) {
  const lines = String(text).split("\n");
  const childIdx = lines.findIndex((l) => new RegExp("^\\s*- id:\\s*" + MANUAL_UI_ID + "\\s*$").test(l));
  if (childIdx < 0) return null;
  // 往上找父级 `- insert:`（最多 12 行内；缩进必须比子行浅）
  const childIndent = lines[childIdx].match(/^\s*/)[0].length;
  let parentIdx = -1;
  for (let i = childIdx - 1; i >= Math.max(0, childIdx - 12); i -= 1) {
    const m = /^(\s*)- insert:\s*$/.exec(lines[i]);
    if (m && m[1].length < childIndent) {
      parentIdx = i;
      break;
    }
  }
  if (parentIdx < 0) return { unsupported: true, reason: "找不到 `- insert:` 父行" };
  // 父块范围 = 从父行到下一条**缩进 ≤ 父缩进**的非空行
  const parentIndent = lines[parentIdx].match(/^\s*/)[0].length;
  let endIdx = lines.length;
  for (let i = parentIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim().length === 0) continue;
    if (lines[i].match(/^\s*/)[0].length <= parentIndent && /^\s*- /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // 这个 insert 块里还有别的子行吗？（有 ⇒ 只删本行；没有 ⇒ 整块删）
  const otherChildren = lines
    .slice(parentIdx + 1, endIdx)
    .some((l) => l.match(/^\s*/)[0].length === childIndent && /^\s*- /.test(l) && !new RegExp("^\\s*- id:\\s*" + MANUAL_UI_ID + "\\s*$").test(l));
  return { startLine: childIdx, endLine: childIdx, start: parentIdx, end: endIdx - 1, wholeBlock: !otherChildren };
}

/**
 * 从 profile 的 cordis.patch.yml 删除手工 UI 行（**带备份**）。
 * 只在 `wholeBlock` 时连注释一起删：注释是与那一行配套的说明，留着会变成误导性死注释。
 */
export function removeManualUiRow(profileDir, log = () => {}, dryRun = false) {
  const file = nodePath.join(profileDir, "cordis.patch.yml");
  if (!nodeFs.existsSync(file)) return { changed: false, reason: "没有 profile cordis.patch.yml" };
  const text = nodeFs.readFileSync(file, "utf8");
  const found = findManualUiRow(text);
  if (found === null) return { changed: false, reason: "没有手工 UI 行" };
  if (found.unsupported) return { changed: false, reason: `手工行结构不认识（${found.reason}），拒绝改` };
  const lines = text.split("\n");
  let start = found.start;
  let end = found.end;
  if (found.wholeBlock) {
    // 连带删除紧贴其上、提到 gokifu 的连续注释行
    while (start - 1 >= 0 && /^\s*#/.test(lines[start - 1]) && /gokifu|上下文压缩/i.test(lines[start - 1])) start -= 1;
  } else {
    start = found.startLine;
    end = found.endLine;
  }
  let next = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
  next = next.replace(/\n{3,}/g, "\n\n");
  if (dryRun) {
    log("  [dry] profile cordis.patch.yml 会删掉手工 gokifu-ui 行（改走 bundle 通道）");
    return { changed: true, dryRun: true };
  }
  const backup = `${file}.bak-before-gokifu-ui-${Date.now()}`;
  nodeFs.copyFileSync(file, backup);
  nodeFs.writeFileSync(file, next, "utf8");
  log(`  ✓ profile cordis.patch.yml 已删手工 gokifu-ui 行（备份 ${nodePath.basename(backup)}）`);
  return { changed: true, backup };
}

/**
 * 确保 profile 的 `dsh.profile.bundles` 含本包（**追加在末尾**，保持既有顺序）。
 * 为什么这是主通道：bundle 声明了 patch 层 ⇒ 装载器自动合并本包的 cordis.patch.yml，
 * 与手写那一行语义等价，但用户不用改 YAML，升级也不会漏。
 */
export function patchProfileBundles(profileDir, log = () => {}, dryRun = false) {
  const file = nodePath.join(profileDir, "package.json");
  if (!nodeFs.existsSync(file)) return { changed: false, reason: "没有 profile/package.json" };
  let pkg;
  try {
    pkg = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch (error) {
    return { changed: false, reason: `profile/package.json 不是合法 JSON（${error.message}）` };
  }
  const dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  const profile = dsh.profile && typeof dsh.profile === "object" ? dsh.profile : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
  if (bundles.includes(PKG_NAME)) return { changed: false, reason: "已在 dsh.profile.bundles" };
  const next = [...bundles, PKG_NAME];
  if (dryRun) {
    log(`  [dry] profile/package.json 的 dsh.profile.bundles 会追加 ${PKG_NAME}（现 ${bundles.length} 项）`);
    return { changed: true, dryRun: true };
  }
  nodeFs.copyFileSync(file, `${file}.bak-before-gokifu-${Date.now()}`);
  pkg.dsh = { ...dsh, profile: { ...profile, bundles: next } };
  nodeFs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  log(`  ✓ profile/package.json 的 dsh.profile.bundles 已追加 ${PKG_NAME}（${bundles.length} → ${next.length} 项）`);
  return { changed: true, bundles: next };
}

/**
 * **bundle 优先**：先把本包写进 `dsh.profile.bundles`，再删掉旧的手工 gokifu-ui 行（带备份）。
 * 顺序不能反：先加 bundle 再删手工行，任何一步中断都**不会**出现「两条通道都没有」的空窗。
 */
export function ensureBundleChannel(profileDir, log = () => {}, dryRun = false) {
  const bundle = patchProfileBundles(profileDir, log, dryRun);
  if (bundle.changed === false) log(`  · UI（bundle 通道）：${bundle.reason}`);
  const manual = removeManualUiRow(profileDir, log, dryRun);
  if (manual.changed === false && manual.reason !== "没有手工 UI 行") log(`  · 手工行：${manual.reason}`);
  return { bundle, manual };
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
      } else if (spec !== null && spec.kind === "other") {
        // ★ task-118：用户把手上的依赖写成 registry / git / tarball 规格时**不许改写成 link**。
        //   那是用户的选择（例如从 npm 装正式版），改写会让「装的是哪个」不可追溯；
        //   本地调试请自己显式写 file:/link:，安装器不替用户做这个决定。
        log(`  · profile/package.json 的 ${PKG_NAME} 是 ${declared} 规格（非 file:/link:）—— 保持原样，不改写成 link`);
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

  /* ③ 挂 UI 的 host 半：**bundle 通道优先**（本包自带 cordis.patch.yml，声明在 dsh.bundle.patch）。
     旧做法是手改 profile 的 cordis.patch.yml 加 `- insert: {id: gokifu-ui}`；那条路已废弃 ——
     升级后手工行与 bundle 会同时挂载，两个 host 半抢同一个 /gokifu/api 前缀，启动直接失败。
     ⇒ 这里把本包写进 dsh.profile.bundles，并**备份后删除**旧手工行，保证任何时候只有一条通道。 */
  ensureBundleChannel(profileDir, (m) => log(m), dryRun);

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
