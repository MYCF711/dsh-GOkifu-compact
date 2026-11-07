#!/usr/bin/env node
/**
 * make-presets-override.mjs —— 生成 cordis.patch.yml：替换四个官方 agent preset 的压缩引擎
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────────────────
 * DSH 的压缩引擎挂在 **agent preset 的 compaction group** 里（`isolate: { compaction: true }`），
 * 内置的 standard / ptc / minimal / cordis 各带一行 `- id: compaction-basic`。本插件要做的不是
 * 「新增一个叫 gokifu 的模式」，而是**把官方压缩换成棋谱压缩** —— 所以按 id 整体覆盖这四个
 * preset 行的 `config`（DSH Web 预设编辑器用的同一机制）。
 *
 * 为什么只能用整体覆盖：`dsh-app-boot` 的 `applyEntryPatches()` 建 id 索引时只递归
 * `entry.group === true && Array.isArray(entry.config)` 的行；preset 行是
 * `@deepseek-ai/dsh-agent-preset`，它的 config 是**对象**、`plugins` 在对象里 ⇒ patch 的
 * id 索引根本到不了 preset 内部的 compaction 行。整体覆盖是唯一不改宿主代码的路径。
 *
 * ── 为什么全程文本级、绝不 YAML round-trip ───────────────────────────────────────────────
 * 官方 preset 里有 `disabled: !!js process.platform === 'win32'` 这类表达式。一旦
 * yaml.load → yaml.dump，`!!js` 标签会退化成普通值，宿主不再按表达式求值 ⇒ 工具集改变
 * （`tool-bash` / `tool-pwsh` 的启停直接受影响）。所以这里只做**按行文本处理**：
 *   · 定位 `^ {6}config:`（官方文件里 config 是 6 空格缩进），取其后全部行统一去掉前 4 个空格；
 *   · 在得到的块里只换 `- id: compaction-basic` 与其紧邻的 `name:` 两行。
 *
 * 代价：preset 清单是**宿主版本快照**。DSH 升级后重跑本生成器，再发一版插件。
 *
 * 用法：
 *   node scripts/make-presets-override.mjs            # dry-run，打印摘要与自检结果
 *   node scripts/make-presets-override.mjs --write    # 写仓库根 cordis.patch.yml（先备份）
 * 环境变量：
 *   DSH_APP_ASAR  —— 显式指定 app.asar；不设时按平台自动探测真实安装目录
 *                   （Windows %LOCALAPPDATA%/Programs/DeepSeek Harness、macOS /Applications、
 *                    Linux /opt），都找不到才回退到历史写死的 D: fixture。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const OUT = nodePath.join(ROOT, "cordis.patch.yml");

/**
 * 解析宿主 app.asar。
 *
 * 优先级**从「当前实例」往外**（越靠前越可信）：
 *   ① `DSH_APP_ASAR` 环境变量（显式指定，最优先）；
 *   ② **`DSH_HOME` 父目录下的同级安装** —— 本机真实布局：
 *      `DSH_HOME=D:/DeepSeek Harness/home` ⇒ 同级并存 `Desktop` 与 `Desktop-0.2.2-rc.1`，
 *      按目录名**倒序**让带版本号的那个（`Desktop-0.2.2-rc.1`）排在裸名之前；
 *   ③ `process.execPath` 所在安装（脚本在宿主进程里跑时命中；用 node 直接跑时是 nodejs 目录，自然落空）；
 *   ④ 各平台标准安装位置。
 *
 * ★ **不再兜底到历史写死的 `D:/DeepSeek Harness/Desktop/...`**：
 *   静默用**旧宿主**生成「看起来对」的产物，比找不到更危险 ——
 *   那正是 2026-11-07「随包 patch 引用宿主已删除的 list-agents 子路径」事故的成因。
 *
 * @returns {string|null} 找到的 app.asar 路径；一个都不存在时返回 null（由 main 报错退出）。
 */
export function resolveAsar() {
  const fromEnv = process.env.DSH_APP_ASAR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;

  const candidates = [];
  const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
  const appAsarUnder = (dir) => nodePath.join(dir, "resources", "app.asar");

  // ② DSH_HOME 的父目录下扫同级安装（本机真实布局：Desktop / Desktop-0.2.2-rc.1 并存）
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === "string" && dshHome.trim() !== "") {
    const parent = nodePath.dirname(nodePath.resolve(dshHome));
    try {
      const siblings = nodeFs
        .readdirSync(parent, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse(); // 倒序：`Desktop-0.2.2-rc.1` 排在 `Desktop` 之前（带版本号的更可能是当前实例）
      for (const name of siblings) add(appAsarUnder(nodePath.join(parent, name)));
    } catch { /* 目录读不到就跳过 */ }
  }

  // ③ 当前进程所在安装（在宿主里跑时命中）
  add(appAsarUnder(nodePath.dirname(process.execPath)));

  // ④ 平台标准位置
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? (home ? nodePath.join(home, "AppData", "Local") : "");
  if (process.platform === "win32") {
    add(localAppData ? appAsarUnder(nodePath.join(localAppData, "Programs", "DeepSeek Harness")) : "");
    add(appAsarUnder(nodePath.join(process.env.PROGRAMFILES ?? "C:/Program Files", "DeepSeek Harness")));
    if (process.env.PROGRAMFILES_X86) {
      add(appAsarUnder(nodePath.join(process.env.PROGRAMFILES_X86, "DeepSeek Harness")));
    }
  } else if (process.platform === "darwin") {
    add("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar");
  } else {
    add("/opt/DeepSeek Harness/resources/app.asar");
    if (home) add(appAsarUnder(nodePath.join(home, ".local", "share", "DeepSeek Harness")));
  }

  return candidates.find((p) => nodeFs.existsSync(p)) ?? null;
}

const ASAR = resolveAsar();

/** 四个内置 preset 的 id（宿主 `@deepseek-ai/dsh-web-app` bundle 层）。 */
const PRESET_NAMES = Object.freeze(["standard", "ptc", "minimal", "cordis"]);

/** asar 内官方 preset 文件目录。 */
const ASAR_PRESET_DIR = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets";

/** 本插件的引擎入口（**必须带子路径**：包根 `exports["."]` 是 UI host）。 */
const ENGINE_NAME = "dsh-gokifu-compact/engine";

/** 接管后那一行用的 id（与插件自带 preset 里的写法一致，便于排障）。 */
const ENGINE_ROW_ID = "gokifu-compact";

/** 被替换的官方引擎包名。 */
const OFFICIAL_ENGINE = "@deepseek-ai/dsh-compaction-basic";

/* ───────────────────────── 纯 node 读 asar ───────────────────────── */

/**
 * 打开 asar 归档（只读，零依赖）。
 *
 * 格式（Electron asar）：8 字节 pickle 头 + 4 字节 pickle 载荷大小 + 4 字节 JSON 长度 + JSON 索引。
 *   u32@4  = headerPickleSize（整段 pickle 的大小，**含**它自己的 4 字节长度前缀）
 *   u32@12 = jsonSize
 *   JSON   = offset 16 起
 *   文件数据偏移 = 8 + headerPickleSize
 * @param {string} archive
 */
export function openAsar(archive) {
  const fd = nodeFs.openSync(archive, "r");
  const head = Buffer.alloc(16);
  nodeFs.readSync(fd, head, 0, 16, 0);
  const headerPickleSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  if (headerPickleSize <= 0 || jsonSize <= 0) {
    nodeFs.closeSync(fd);
    throw new Error("asar 头不合法（可能是旧格式）");
  }
  const headerBuf = Buffer.alloc(jsonSize);
  nodeFs.readSync(fd, headerBuf, 0, jsonSize, 16);
  const header = JSON.parse(headerBuf.toString("utf8"));
  const baseOffset = 8 + headerPickleSize;

  const walk = (p) => {
    let node = header;
    for (const part of String(p).split("/").filter(Boolean)) {
      if (!node.files) return null;
      node = node.files[part];
      if (!node) return null;
    }
    return node;
  };

  // ★ 注意：fd 保持打开（返回的对象要多次读文件）。用完不关，进程退出时由 OS 回收 ——
  //   这是个短命 CLI，比引入 close() 生命周期简单且安全。
  return {
    has: (p) => {
      const n = walk(p);
      return Boolean(n && !n.files);
    },
    readFile: (p) => {
      const n = walk(p);
      if (!n || n.files) return null;
      const buf = Buffer.alloc(n.size);
      nodeFs.readSync(fd, buf, 0, n.size, Number(n.offset) + baseOffset);
      return buf.toString("utf8");
    },
  };
}

/* ───────────────────────── 文本变换 ───────────────────────── */

/**
 * 从官方 preset 文本里取出 config 块（已重排缩进，可直接接在 `- id: <preset>` 下面）。
 *
 * 官方形状：
 *   - insert:                              (0 空格)
 *       - id: preset-standard              (4)
 *         name: '@deepseek-ai/dsh-agent-preset'
 *         config:                          (6) ← 从这里取
 *           id: standard                   (8)
 *           plugins:                       (8)
 *             - id: persona                (10)
 * 生成目标：
 *   - id: preset-standard                  (0)
 *     config:                              (2)
 *       id: standard                       (4)
 *       plugins:                           (4)
 *         - id: persona                    (6)  ← 相对缩进不变，整体减 4
 *
 * @param {string} officialText
 * @returns {string}
 */
export function liftConfigBlock(officialText) {
  const lines = String(officialText).split("\n");
  const start = lines.findIndex((line) => /^ {6}config:\s*$/.test(line));
  if (start < 0) throw new Error("没找到 6 空格缩进的 config:（宿主 preset 格式变了？）");
  const body = lines.slice(start + 1);
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const shifted = body.map((line) => (line.startsWith("    ") ? line.slice(4) : line));
  return ["  config:", ...shifted].join("\n");
}

/** 把组内的官方引擎行换成 GOkifu 引擎行（只动 `- id: compaction-basic` 与它的 name 行）。 */
export function swapEngineRow(configBlock) {
  const lines = String(configBlock).split("\n");
  const out = [];
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*- id: compaction-basic\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const nameLine = lines[i + 1] ?? "";
    const nameIndent = nameLine.match(/^\s*/)?.[0] || indent;
    const expected = new RegExp(`^\\s*name:\\s*'?${OFFICIAL_ENGINE.replace(/[/.]/g, "\\$&")}'?\\s*$`);
    if (!expected.test(nameLine)) {
      throw new Error(`compaction-basic 的下一行不是官方 name：${JSON.stringify(nameLine)}`);
    }
    out.push(`${indent}- id: ${ENGINE_ROW_ID}`);
    out.push(`${nameIndent}name: '${ENGINE_NAME}'`);
    hits += 1;
    i += 1; // 跳过原 name 行
  }
  if (hits !== 1) throw new Error(`每个 preset 应恰好替换 1 处引擎行，实际 ${hits} 处`);
  return out.join("\n");
}

/** 拼装最终 patch。 */
export function buildPatch(entries) {
  const head = [
    "# dsh-gokifu-compact 的 bundle patch（**生成物 · 不要手改**；改了下一次生成会被覆盖）",
    "# 生成器：node scripts/make-presets-override.mjs --write",
    "# 源：宿主 asar 内的官方 agent preset（dsh/node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml）",
    "#",
    "# 做两件事：",
    "#   ① 插入 UI host 行（gokifu-ui）：/gokifu/api + 设置页；",
    "#   ② 按 id 整体覆盖四个官方 preset 的 config —— 把 compaction group 里的",
    "#      `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine`。",
    "#      标准 / PTC / 极简 / 创造 四个模式都用棋谱压缩，模式本身与选择器不变。",
    "#",
    "# 不新增 preset、不改 agent-preset-registry 的默认 preset。",
    "# 代价：preset 清单是宿主版本快照 —— DSH 升级后重跑生成器、再发一版插件。",
    "",
    "- insert:",
    "    - id: gokifu-ui",
    "      name: 'dsh-gokifu-compact'",
  ];
  const body = [];
  for (const entry of entries) body.push("", `- id: ${entry.id}`, entry.configBlock);
  return `${head.concat(body).join("\n")}\n`;
}

/* ───────────────────────── 自检 ───────────────────────── */

/**
 * @param {string} text 生成物
 * @param {string[]} officialTexts 官方四个 preset 的原文
 * @returns {string[]} 问题清单（空 = 通过）
 */
export function validateBundlePatch(text, officialTexts) {
  const problems = [];
  const count = (haystack, needle) => haystack.split(needle).length - 1;
  const countJs = (s) => (s.match(/!!js /g) ?? []).length;

  // 只看「代码行」：注释里会解释为什么不新增 preset / 不改注册表，不能自我误杀；
  // 官方 preset 的 plugins 里也可能出现 `.../dsh-agent-preset/package.json` 这类路径（cordis 的 skills 行），
  // 所以下面两条按**行首结构**判，而不是全文子串。
  const code = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  if (/- id: compaction-basic/.test(code)) problems.push("残留 `- id: compaction-basic`（官方引擎行没换掉）");
  if (/^\s*name:\s*'@deepseek-ai\/dsh-agent-preset'\s*$/m.test(code)) {
    problems.push("出现了 agent-preset 声明行（B 方案不允许新增 preset）");
  }
  if (/^\s*-?\s*id:\s*agent-preset-registry\s*$/m.test(code)) {
    problems.push("出现了 agent-preset-registry 行（不许改默认 preset）");
  }
  for (const name of PRESET_NAMES) {
    if (!new RegExp(`^- id: preset-${name}\\s*$`, "m").test(text)) problems.push(`缺 preset-${name} 覆盖`);
  }
  const engineCount = count(text, `name: '${ENGINE_NAME}'`);
  if (engineCount !== PRESET_NAMES.length) {
    problems.push(`引擎行应恰好 ${PRESET_NAMES.length} 条，实际 ${engineCount}`);
  }
  const topInserts = text.split("\n").filter((line) => line === "- insert:").length;
  if (topInserts !== 1) problems.push(`顶层 \`- insert:\` 应恰好 1 条，实际 ${topInserts}`);
  if (!/compaction:\s*true/.test(text)) problems.push("找不到 `isolate: { compaction: true }`");

  // ★ 这条专门抓「有人偷懒用 yaml.load → yaml.dump」：`!!js` 表达式数量必须与官方完全一致。
  const officialJs = officialTexts.reduce((n, t) => n + countJs(t), 0);
  const actualJs = countJs(text);
  if (actualJs !== officialJs) {
    problems.push(`!!js 表达式 ${actualJs} 个 ≠ 官方 ${officialJs} 个（文本被 YAML 往返破坏了）`);
  }
  return problems;
}

/* ───────────────────────── 子路径可解析性守卫 ───────────────────────── */

/**
 * 解析一个 `@scope/pkg[/subpath]` 说明符；非此形态返回 null。
 * @param {string} specifier
 * @returns {{scope:string,pkg:string,subpath:string|null}|null}
 */
export function parseScopedSpecifier(specifier) {
  const m = /^(@[^/]+)\/([^/]+)(?:\/(.+))?$/.exec(String(specifier));
  if (!m) return null;
  return { scope: m[1], pkg: m[2], subpath: m[3] ?? null };
}

/**
 * 找出 patch 里「宿主包存在、但子路径无法解析」的 @deepseek-ai 说明符。
 *
 * 这正是本次故障的机器判据：宿主 0.2.2-rc.1 已移除
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径，而随包发布的旧快照
 * 仍引用它 ⇒ 该插件 never started、preset 校验失败。
 *
 * 只校验宿主 asar 内真实存在的 @deepseek-ai 包；本插件自己的
 * `dsh-gokifu-compact/engine` 等不在 asar，运行时由 profile 解析，不在此误报。
 * @param {{has:(p:string)=>boolean,readFile:(p:string)=>string|null}} asar openAsar 返回值
 * @param {string} text 待校验的 patch 文本
 * @returns {string[]}
 */
export function findUnresolvableSpecifiers(asar, text) {
  const names = [...String(text).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  const bad = [];
  for (const name of [...new Set(names)]) {
    const parsed = parseScopedSpecifier(name);
    if (!parsed || parsed.scope !== "@deepseek-ai" || !parsed.subpath) continue;
    const pkgDir = ["dsh", "node_modules", "@deepseek-ai", parsed.pkg].join("/");
    const pjPath = `${pkgDir}/package.json`;
    if (!asar.has(pjPath)) continue; // 宿主里没有这个包，交给其它校验，不在此误报
    let exportsMap = {};
    const pjText = asar.readFile(pjPath);
    if (pjText) {
      try {
        exportsMap = JSON.parse(pjText).exports ?? {};
      } catch {
        exportsMap = {};
      }
    }
    const target = `./${parsed.subpath}`;
    const exact = Object.keys(exportsMap).includes(target);
    const wildcard = Object.keys(exportsMap).some(
      (k) => k.endsWith("/*") && target.startsWith(k.slice(0, -1)),
    );
    const fileExists = asar.has(`${pkgDir}/${parsed.subpath}`);
    if (!exact && !wildcard && !fileExists) bad.push(name);
  }
  return bad;
}

/* ───────────────────────── 主流程 ───────────────────────── */

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");

  if (!ASAR || !nodeFs.existsSync(ASAR)) {
    console.error(`✗ 找不到宿主 app.asar（探测到：${ASAR ?? "无"}）；用 DSH_APP_ASAR 显式指定`);
    console.error("  提示：不确定装在哪时，先看 DSH_HOME 的父目录下有哪些安装版本");
    process.exitCode = 2;
    return;
  }

  let asar;
  try {
    asar = openAsar(ASAR);
  } catch (error) {
    console.error(`✗ 读 asar 失败：${String(error?.message ?? error)}`);
    process.exitCode = 2;
    return;
  }

  const officialTexts = [];
  const entries = [];
  for (const name of PRESET_NAMES) {
    const file = `${ASAR_PRESET_DIR}/${name}.patch.yml`;
    const text = asar.readFile(file);
    if (!text) {
      console.error(`✗ asar 里读不到 ${file}`);
      process.exitCode = 2;
      return;
    }
    officialTexts.push(text);
    let configBlock;
    try {
      configBlock = swapEngineRow(liftConfigBlock(text));
    } catch (error) {
      console.error(`✗ 处理 preset-${name} 失败：${String(error?.message ?? error)}`);
      process.exitCode = 1;
      return;
    }
    entries.push({ id: `preset-${name}`, configBlock });
  }

  const patch = buildPatch(entries);
  const problems = validateBundlePatch(patch, officialTexts);
  const unresolvable = findUnresolvableSpecifiers(asar, patch);

  console.log(`宿主 asar：${ASAR}`);
  for (let i = 0; i < entries.length; i += 1) {
    const { id, configBlock } = entries[i];
    const lineCount = configBlock.split("\n").length;
    const engine = (configBlock.match(new RegExp(`name: '${ENGINE_NAME.replace(/[/.]/g, "\\$&")}'`, "g")) ?? []).length;
    const js = (configBlock.match(/!!js /g) ?? []).length;
    console.log(`  ${id}: ${lineCount} 行 · 引擎行 ${engine} · !!js ${js}`);
    void officialTexts[i];
    void id;
  }

  if (problems.length > 0) {
    console.error("✗ 自检失败：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  if (unresolvable.length > 0) {
    console.error("✗ 自检失败：patch 引用了宿主不存在的子路径（对应插件 never started）：");
    for (const s of unresolvable) console.error(`  - ${s}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 自检通过（产物 ${Buffer.byteLength(patch)} B）`);

  if (!write) {
    console.log("（dry-run）加 --write 才写盘");
    return;
  }
  if (nodeFs.existsSync(OUT)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${OUT}.bak-${stamp}`;
    nodeFs.copyFileSync(OUT, bak);
    console.log(`备份：${nodePath.basename(bak)}`);
  }
  nodeFs.writeFileSync(OUT, patch, "utf8");
  console.log(`已写入 ${OUT}`);
}

// 直接执行时才跑 main（被单测 import 时不跑）
if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
