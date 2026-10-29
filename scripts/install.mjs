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
 *   · 幂等：已经换过就跳过；旧版本残留（有我们的 name、id 还是旧名）只改名
 *   · 双模式：从仓库跑（会先建 junction + profile 依赖）/ 从已装的包跑（跳过链接）
 *
 * 用法：
 *   dsh-gokifu-compact install [--profile desktop] [--preset personal-assistant] [--dry-run]
 *   dsh-gokifu-compact revert  [--profile desktop]
 *
 * 兼容：`node test/install.mjs` 仍然可用（薄封装到这个文件）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PKG_NAME = "dsh-gokifu-compact";
export const ENTRY_ID = "gokifu-compact";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = nodePath.resolve(HERE, "..");

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
  return nodePath.resolve(profilePkg) === PROJECT_DIR;
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

/**
 * 找到 `- id: compaction-basic` 那一块并整块替换（按缩进判断块边界）。
 * @returns 新文本；找不到返回 null
 */
export function replaceCompactionBlock(text, blockLines) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const startPattern = /^(\s*)- id: compaction-basic\s*$/;
  let start = -1;
  let foundIndent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const m = startPattern.exec(lines[i]);
    if (m) {
      start = i;
      foundIndent = m[1];
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (/^\s*#/.test(line)) continue;
    const lead = (/^\s*/.exec(line)[0] ?? "").length;
    if (lead === foundIndent.length && /^-\s/.test(line.trim())) {
      end = i;
      break;
    }
    if (lead < foundIndent.length) {
      end = i;
      break;
    }
  }
  const replacement = blockLines.map((line) => foundIndent + line);
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

/** 我们的引擎块（不含缩进，缩进由 replaceCompactionBlock 加）。 */
export function engineBlock() {
  return [
    `# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。`,
    `#   替换掉原来的 @deepseek-ai/dsh-compaction-basic —— 两者会抢同一个 ctx.compaction。`,
    `#   回滚：dsh-gokifu-compact revert   （恢复 .bak-before-gokifu-* 备份）`,
    `- id: ${ENTRY_ID}`,
    `  name: '${PKG_NAME}/engine'`,
    `  config:`,
    `    auto: true                # 自动压缩：继承基类的 between-step 压力触发`,
    `    thresholdRatio: 0.45      # 压力闸：min(窗口×0.45, 窗口−输出预留−64K)`,
    `    headroomTokens: 65536`,
    `    retainRatio: 0.16         # 逐字保留的近期尾部`,
    `    growthFloorTokens: 40000  # 增长闸：距上次 fold 至少新增这么多 token`,
    `    minFoldTokens: 8000`,
    `    summaryMode: hybrid       # hybrid | rules（零模型调用）| llm`,
    `    summarizationProvider: '' # 留空 = 跟随当前路由`,
    `    summarizationModel: ''    # 想用免费模型，先确认 provider 模型表里有那个 id`,
    `    hotLedger: true`,
    `    hotLedgerMaxTokens: 500`,
    `    hotLedgerMarkers: semantic`,
    `    hotLedgerReplace: true`,
    `    transposition: true`,
    `    tier2After: 8`,
  ];
}

/**
 * 解析 preset 文本里我们那一块（`- id: gokifu-compact`）。
 * raw 覆盖「紧贴 id 行的注释 + 整块」，这样替换时注释不会重复。
 */
export function parseEngineBlock(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const idRe = new RegExp("^(\\s*)- id: " + ENTRY_ID + "\\s*$");
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const m = idRe.exec(lines[i]);
    if (m) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start < 0) return null;
  // 往上吞掉同缩进的注释行（它们属于这一块）
  let first = start;
  while (first > 0 && /^\s*#/.test(lines[first - 1]) && /^(\s*)/.exec(lines[first - 1])[1].length === indent.length) first -= 1;
  // 往下找块尾：同缩进的下一个条目，或更浅的层级
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const lead = /^(\s*)/.exec(line)[1].length;
    if (lead <= indent.length && /^-\s/.test(line.trim())) {
      end = i;
      break;
    }
    if (lead < indent.length) {
      end = i;
      break;
    }
  }
  const raw = lines.slice(first, end).join("\n");
  const config = {};
  let inConfig = false;
  for (const line of lines.slice(start + 1, end)) {
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = parseScalar(m[2]);
    if (value !== undefined) config[m[1]] = value;
  }
  return { indent, raw, config, commentLines: [] };
}

function parseScalar(raw) {
  const text = String(raw).replace(/\s+#.*$/, "").trim();
  if (text.length === 0) return undefined;
  if (/^'.*'$/.test(text) || /^".*"$/.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function formatScalar(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return "''";
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9._/-]+$/.test(text)) return "'" + text + "'";
  return "'" + text.replace(/'/g, "''") + "'";
}

/** 每个键后面带的短注释（写回 preset 时保留可读性）。 */
export const KEY_COMMENTS = {
  auto: "自动压缩（between-step 压力触发）",
  thresholdRatio: "压力闸：min(窗口×该值, 窗口−输出预留−余量)",
  headroomTokens: "路由输出预留之外的额外余量",
  retainRatio: "逐字保留的近期尾部",
  growthFloorTokens: "增长闸：距上次 fold 增至该值才再次 fold",
  minFoldTokens: "被遮蔽内容少于该值不 fold",
  summaryMode: "hybrid | rules（零模型调用）| llm",
  summarizationProvider: "留空 = 跟随当前路由",
  summarizationModel: "留空 = 跟随当前路由",
  maxTokens: "摘要输出上限",
  hotLedger: "每步注入失败清单",
  hotLedgerMaxTokens: "清单 token 上限",
  hotLedgerMarkers: "semantic | terse | off",
  hotLedgerReplace: "就地替换旧清单（surface 永远一条）",
  transposition: "置换检测",
  tier2After: "checkpoint 超过该值合并最老的两段",
  graphDir: "棋谱目录；留空 = <DSH_HOME>/chess-context",
  worldHashMaxFiles: "世界状态哈希最多 stat 多少文件",
};

/**
 * 用一份配置对象渲染我们那一块（含注释）。缩进由调用方给。
 * 与 engineBlock() 的区别：后者是固定模板（安装器用），这个按实际值渲染（UI 保存用）。
 */
export function renderEngineBlock(config, indent = "") {
  const lines = [
    "# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。",
    "#   替换掉原来的 @deepseek-ai/dsh-compaction-basic —— 两者会抢同一个 ctx.compaction。",
    "#   回滚：dsh-gokifu-compact revert   （恢复 .bak-before-gokifu-* 备份）",
    "- id: " + ENTRY_ID,
    "  name: '" + PKG_NAME + "/engine'",
    "  config:",
  ];
  for (const [key, value] of Object.entries(config ?? {})) {
    const note = KEY_COMMENTS[key];
    const pad = " ".repeat(Math.max(1, 20 - key.length));
    lines.push("    " + key + ": " + formatScalar(value) + (note ? pad + "# " + note : ""));
  }
  return lines.map((line) => indent + line).join("\n");
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

  /* ① 确保包装进 profile（已装好则跳过） */
  if (!installedLocation(dshHome, profile)) {
    const dest = nodePath.join(profileDir, "node_modules", PKG_NAME);
    if (nodeFs.existsSync(dest)) {
      log(`  · ${dest} 已存在（不是本目录），跳过链接`);
    } else if (dryRun) {
      log(`  [dry] 会建 junction ${dest} → ${PROJECT_DIR}`);
    } else {
      nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      execFileSync("cmd", ["/c", "mklink", "/J", dest, PROJECT_DIR], { stdio: "ignore" });
      log(`  ✓ junction: ${dest} → ${PROJECT_DIR}`);
    }
    const pkgFile = nodePath.join(profileDir, "package.json");
    const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
    if (!pkg.dependencies?.[PKG_NAME]) {
      if (dryRun) log(`  [dry] 会在 package.json dependencies 加 ${PKG_NAME}`);
      else {
        nodeFs.copyFileSync(pkgFile, `${pkgFile}.bak-before-gokifu-${Date.now()}`);
        pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: `link:${PROJECT_DIR.replace(/\\/g, "/")}` };
        nodeFs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        log("  ✓ profile/package.json 已加 dependency");
      }
    } else log(`  · profile/package.json 已有 ${PKG_NAME}`);
  } else {
    log(`  · 已从 profile 的 node_modules 运行（安装态），跳过链接`);
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

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = run();
