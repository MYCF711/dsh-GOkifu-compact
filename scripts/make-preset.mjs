#!/usr/bin/env node
/**
 * make-preset.mjs —— 从**当前宿主**读官方 preset，改写成 gokifu 版 preset bundle 包（**免冻结生成器**）
 *
 * 为什么需要生成器而不是「照抄一份 preset」：
 *   装回新版 DSH 的 C 段要求压缩引擎挂在 **agent preset 的 compaction group** 里
 *   （profile/bundle 级 patch 打不到 preset 的 `config.plugins`，见 docs/DSH-技术测绘.md §7.6）。
 *   而新版 home 没有 `preset-bundles/`，旧 `personal-assistant` 也没迁过来。
 *   如果手工从官方 `standard.patch.yml` 抄一份，就等于**把生成时那版 DSH 的插件清单冻成快照** ——
 *   DSH 下次升级新增的行（`time-context` / `tool-schedule` / `workflow-ptc` …）会静默丢失。
 *   所以这里做成「读宿主 asar 里**当前**官方 preset → 只换 compression group 的引擎行 → 输出独立 bundle 包」：
 *   **DSH 升级后重跑一次就行，永不冻结。**
 *
 * 做什么（纯文本级改写，不引 YAML 依赖 —— 与 src/rooms/preset-format.mjs 的思路一致：
 * 整份 YAML 重新序列化会丢注释/`!!js` 标签/顺序，而这里恰恰要求「其余行逐字保留」）：
 *   ① 从 `<asar>` 读 `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`；
 *   ② 找到 `config.plugins` 里 `id: compaction`（`group: true`）的那一组；
 *   ③ 把它 `config` 数组里的 `- id: compaction-basic / name: '@deepseek-ai/dsh-compaction-basic'`
 *      换成 `- id: gokifu-compact / name: 'dsh-gokifu-compact/engine'`
 *      （**必须是子路径 `/engine`**：包根 `exports["."]` 是 UI host 半，DSH 会把 UI host 当压缩引擎用，装回去照样挂）；
 *   ④ 其余插件行（command-compact / tool-result-pruner / …）**逐字保留**，并做「行集合不多不少」自检；
 *   ⑤ 输出可被 `link:` 进 profile 的 preset bundle 包目录：
 *        <out>/package.json       # name / version(=生成时的宿主版本) / private / dsh.bundle.patch
 *        <out>/cordis.patch.yml   # - insert: [{id: preset-<id>, name: '@deepseek-ai/dsh-agent-preset', config: {...}}]
 *
 * 用法：
 *   node scripts/make-preset.mjs                     # 默认 dry-run，只打印将写什么（不落盘）
 *   node scripts/make-preset.mjs --write             # 真的写到 --out（默认 <repo>/tmp/preset-bundle）
 *   node scripts/make-preset.mjs --out <dir> --id gokifu --name 'gokifu 压缩'
 *   node scripts/make-preset.mjs --asar <path> --version 0.2.1-rc.5
 *
 * 退出码：0 成功（含 dry-run 成功）/ 1 失败（读不到 asar、找不到 compaction group、生成物自检失败）
 *         / 2 参数错误或**输出目录守卫**（输出落在运行中的 DSH home 里）
 *
 * ⚠ 守卫：输出目录**绝不允许**落在运行中的 `DSH_HOME`（或 `%USERPROFILE%\DeepSeek Harness\home`）里 ——
 *   那是生产 home，本脚本只产出文件，不安装、不启停 DSH。
 *
 * 双入口（C-12）：直接执行时跑 CLI；被 import 时**零副作用**（只导出纯函数）。
 * 入口判定用 realpath 比较 —— 经 junction / 非 ASCII 路径调用时 argv[1] 与 import.meta.url 形状不同，
 * 用字符串相等会静默不执行（本仓 C-12 踩过的假绿，见 test/ws-install.test.mjs）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
/** 仓库根（经 realpath 解析后再上一级，junction 调用也拿到真身）。 */
export const REPO_DIR = nodePath.resolve(HERE, "..");
/** dry-run 打印 / --write 默认写入位置（仓库 tmp/ 已 gitignore）。 */
export const DEFAULT_OUT = nodePath.join(REPO_DIR, "tmp", "preset-bundle");
/** 官方 preset 在宿主 asar 里的路径（实测）。 */
export const INNER_OFFICIAL_PRESET = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml";
/** 宿主版本来源（asar 内的 dsh/package.json）。 */
export const INNER_HOST_PKG = "dsh/package.json";
/** 默认 asar 候选（新版装在这里；旧路径留一个兜底）。 */
export const ASAR_CANDIDATES = ["D:/DeepSeek Harness/Desktop/resources/app.asar", "D:/DeepSeek Harness/resources/app.asar"];
/** 要换进去的引擎行（**必须是 `/engine` 子路径**，理由见文件头）。 */
export const ENGINE_ROW = { id: "gokifu-compact", name: "dsh-gokifu-compact/engine" };
/** preset 声明行的 name（新版 agent preset 的固定形态）。 */
export const PRESET_ROW_NAME = "@deepseek-ai/dsh-agent-preset";
/** preset 在「新会话」选择器里显示的默认描述（用户看到的那一行「暂无描述」就是缺它）。 */
export const DEFAULT_PRESET_DESCRIPTION =
  "棋谱式上下文压缩 — 替换内置 compaction-basic：失败记忆逐字保留、每步热清单、置换检测；压缩永不裸截断。";
/** 本包名（bundle patch 的 UI 行 name / registry 补丁的归属都以它为准）。 */
export const PKG_NAME = "dsh-gokifu-compact";
/** UI host 行的 id（与历史手工行、verify-install 的判据逐字一致）。 */
export const UI_ROW_ID = "gokifu-ui";
/** agent preset 注册表的行 id（宿主 dsh-web-app 层定义；我们只改它「新会话默认 preset」）。 */
export const REGISTRY_ROW_ID = "agent-preset-registry";

/** 参数/守卫错误 ⇒ CLI 退出码 2（与「读不到/改不动」的运行失败 1 分开）。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/* ─────────────────────────── asar 读取 ─────────────────────────── */

/**
 * 从 asar 里读一个文件（纯同步、只读）。偏移算法是**实测验证过**的（不是推的）：
 *   asar = [8B 头][headerSize B 的 header JSON 区][payload]；
 *   header 区前 4B 是 JSON 字符串长度（pickle 包装），JSON 从第 8B 开始；
 *   文件内容 = [8 + headerSize + Number(entry.offset), + Number(entry.size))。
 *
 * @param {string} asarPath
 * @param {string} innerPath asar 内路径（用 `/`，不带前导斜杠）
 * @returns {string} UTF-8 文本
 */
export function readAsarEntry(asarPath, innerPath) {
  if (typeof asarPath !== "string" || asarPath === "") throw new Error("asar 路径为空");
  if (typeof innerPath !== "string" || innerPath === "") throw new Error("asar 内路径为空");
  let fd;
  try {
    fd = nodeFs.openSync(asarPath, "r");
  } catch (error) {
    throw new Error(`读不到 asar：${asarPath}（${error?.code ?? error?.message}）—— 用 --asar 指定宿主 app.asar`);
  }
  try {
    const head = Buffer.alloc(8);
    nodeFs.readSync(fd, head, 0, 8, 0);
    const headerSize = head.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    nodeFs.readSync(fd, headerBuf, 0, headerSize, 8);
    const header = JSON.parse(headerBuf.slice(8, 8 + headerBuf.readUInt32LE(4)).toString("utf8"));
    const dataStart = 8 + headerSize;
    let node = header;
    for (const seg of String(innerPath).split("/")) {
      node = node?.files?.[seg];
      if (node === undefined || node === null) throw new Error(`asar 里没有这个路径：${innerPath}（asar=${asarPath}）`);
    }
    if (node.size === undefined) throw new Error(`asar 里这个路径是目录，不是文件：${innerPath}`);
    const size = Number(node.size);
    const buf = Buffer.alloc(size);
    if (size > 0) nodeFs.readSync(fd, buf, 0, size, dataStart + Number(node.offset));
    return buf.toString("utf8");
  } finally {
    try {
      nodeFs.closeSync(fd);
    } catch {
      /* 只读句柄关不掉也不该掩盖真正错误 */
    }
  }
}

/**
 * 解析要用的 asar：显式 --asar > 环境变量 DSH_ASAR > 默认候选里第一个存在的。
 * @param {string|null} explicit
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAsarPath(explicit, env = process.env) {
  if (typeof explicit === "string" && explicit !== "") {
    if (!nodeFs.existsSync(explicit)) throw new Error(`指定的 asar 不存在：${explicit}`);
    return explicit;
  }
  const candidates = [env.DSH_ASAR, ...ASAR_CANDIDATES].filter((p) => typeof p === "string" && p !== "");
  for (const candidate of candidates) if (nodeFs.existsSync(candidate)) return candidate;
  throw new Error(`找不到宿主 app.asar（试过：${candidates.join(" / ")}）—— 用 --asar 指定`);
}

/**
 * 生成时的宿主版本：读 asar 内 `dsh/package.json` 的 version（与在跑宿主同一来源）。
 * 读不到返回 null（不假装知道）。
 * @param {string} asarPath
 * @returns {string|null}
 */
export function readHostVersion(asarPath) {
  try {
    const pkg = JSON.parse(readAsarEntry(asarPath, INNER_HOST_PKG));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/* ─────────────────────── YAML 文本级改写（纯函数） ─────────────────────── */

/** 统一换行（CRLF/CR → LF），避免生成的 diff 里混进 \r。 */
function normalizeText(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  return m === null ? 0 : m[0].length;
}

/** 单引号 YAML 标量转义：' → ''。 */
function quoteYaml(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 在一段官方 preset 文本里定位 `id: compaction`（group: true）那一组，以及组内 `compaction-basic` 条目。
 * 纯文本行扫描（只用缩进判层级），找不到就抛**明确**错误（不返回半成品）。
 *
 * @param {string[]} lines
 * @returns {{basicIdx:number,basicIndent:number,nameIdx:number,nameIndent:number,groupIdx:number,groupId:string}}
 */
export function findCompactionGroup(lines) {
  const basicIdxs = [];
  for (let i = 0; i < lines.length; i += 1) if (/^\s*-\s*id:\s*compaction-basic\s*$/.test(lines[i])) basicIdxs.push(i);
  if (basicIdxs.length === 0) throw new Error(`官方 preset 里找不到 \`- id: compaction-basic\`（preset 形状可能变了：${INNER_OFFICIAL_PRESET}）`);
  if (basicIdxs.length > 1) throw new Error(`官方 preset 里 compaction-basic 出现了 ${basicIdxs.length} 次，无法确定该替换哪一个`);
  const basicIdx = basicIdxs[0];
  const basicIndent = indentOf(lines[basicIdx]);

  // 同一条目的 name: 行（必须存在，否则不知道换的是不是原生压缩后端）
  let nameIdx = -1;
  for (let i = basicIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= basicIndent) break;
    if (/^\s*name:\s*\S/.test(lines[i])) {
      nameIdx = i;
      break;
    }
  }
  if (nameIdx < 0) throw new Error("compaction-basic 条目没有 name: 行，拒绝猜着改");

  // 最近的、带 `group: true` 的祖先条目（id 通常是 compaction）。
  // 判定必须看**直接属性**（缩进恰为 gi+2 的行）—— 否则会把「含 group 子条目的外层 preset 条目」
  // 也当成父组（本例里 `- id: preset-standard` 的孙辈就有 group:true）。
  let groupIdx = -1;
  for (let i = basicIdx - 1; i >= 0; i -= 1) {
    const m = /^(\s*)-\s*id:\s*([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
    if (m === null) continue;
    const gi = indentOf(lines[i]);
    if (gi >= basicIndent) continue; // 兄弟/后代，继续往上
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= gi) {
        end = j;
        break;
      }
    }
    if (end <= basicIdx) continue; // compaction-basic 不在这条目的块里
    const isGroup = lines.slice(i + 1, end).some((line) => indentOf(line) === gi + 2 && /^\s*group:\s*true\s*$/.test(line));
    if (isGroup) {
      groupIdx = i;
      break;
    }
  }
  if (groupIdx < 0) throw new Error("找不到包住 compaction-basic 且 group: true 的父组（preset 形状可能变了）");
  const groupId = /^(\s*)-\s*id:\s*([A-Za-z0-9._-]+)\s*$/.exec(lines[groupIdx])[2];
  return { basicIdx, basicIndent, nameIdx, nameIndent: indentOf(lines[nameIdx]), groupIdx, groupId };
}

/**
 * 把官方 preset 里 compaction group 的引擎行换成 gokifu（其余行一个字节都不动）。
 *
 * @param {string} officialText
 * @returns {{text:string, groupId:string, replaced:{fromId:string,fromName:string,toId:string,toName:string}}}
 */
export function rewriteCompactionEngine(officialText) {
  const text = normalizeText(officialText);
  const lines = text.split("\n");
  const group = findCompactionGroup(lines);
  const fromName = /^\s*name:\s*(.*)$/.exec(lines[group.nameIdx])?.[1]?.trim() ?? "";
  lines[group.basicIdx] = `${" ".repeat(group.basicIndent)}- id: ${ENGINE_ROW.id}`;
  lines[group.nameIdx] = `${" ".repeat(group.nameIndent)}name: ${quoteYaml(ENGINE_ROW.name)}`;
  const out = lines.join("\n");
  if (out.includes("compaction-basic")) throw new Error("替换后仍残留 compaction-basic（内部错误，拒绝产出）");
  return { text: out, groupId: group.groupId, replaced: { fromId: "compaction-basic", fromName, toId: ENGINE_ROW.id, toName: ENGINE_ROW.name } };
}

/**
 * 从（已改写的）官方 preset 文本里抽出 `- insert:` 条目的 `config:` 块
 * （= preset 声明里的 config: id/order/plugins... 整段，缩进原样）。
 *
 * @param {string} officialText
 * @returns {{childIndent:number,configIndent:number,configLines:string[],childId:string,insertIndent:number}}
 */
export function extractInsertConfig(officialText) {
  const lines = normalizeText(officialText).split("\n");
  const insertIdx = lines.findIndex((l) => /^-\s*insert:\s*$/.test(l));
  if (insertIdx < 0) throw new Error("官方 preset 里找不到顶层 `- insert:` 行");
  const insertIndent = indentOf(lines[insertIdx]);

  let childIdx = -1;
  for (let i = insertIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    if (/^\s*-\s*id:\s*\S+/.test(lines[i]) && indentOf(lines[i]) > insertIndent) {
      childIdx = i;
      break;
    }
  }
  if (childIdx < 0) throw new Error("官方 preset 的 `- insert:` 下面没有条目");
  const childIndent = indentOf(lines[childIdx]);

  let nameIdx = -1;
  for (let i = childIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= childIndent) break;
    if (/^\s*name:/.test(lines[i])) {
      nameIdx = i;
      break;
    }
  }
  if (nameIdx < 0 || !lines[nameIdx].includes(PRESET_ROW_NAME)) {
    throw new Error(`官方 preset 的 insert 条目不是 ${PRESET_ROW_NAME} 声明（${lines[nameIdx] ?? "没有 name 行"}）`);
  }

  let configIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= childIndent) break;
    if (/^\s*config:\s*$/.test(lines[i]) && indentOf(lines[i]) === childIndent + 2) {
      configIdx = i;
      break;
    }
  }
  if (configIdx < 0) throw new Error("官方 preset 的 insert 条目没有 config: 块");

  let endIdx = lines.length;
  for (let i = configIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= insertIndent) {
      endIdx = i;
      break;
    }
  }
  let last = endIdx - 1;
  while (last > configIdx && lines[last].trim() === "") last -= 1;
  return {
    insertIndent,
    childIndent,
    configIndent: indentOf(lines[configIdx]),
    configLines: lines.slice(configIdx, last + 1),
    childId: /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[childIdx])[1],
  };
}

/** 整块缩进平移（生成物统一用 4/6 空格层级）。 */
function reindent(lines, fromIndent, toIndent) {
  const delta = toIndent - fromIndent;
  if (delta === 0) return [...lines];
  return lines.map((line) => {
    if (line.trim() === "") return line;
    if (delta > 0) return `${" ".repeat(delta)}${line}`;
    const cut = Math.min(-delta, indentOf(line));
    return line.slice(cut);
  });
}

/** 从文本里收集插件条目 id（`- id: xxx`），忽略 preset 声明自己的 `preset-*` id。 */
function pluginIds(text) {
  return [...normalizeText(text).matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm)]
    .map((m) => m[1])
    .filter((id) => !id.startsWith("preset-"));
}

/**
 * 生成物自检（核心防冻结判据）：
 *   · 必须是 agent-preset 声明 / 必须含 `dsh-gokifu-compact/engine` / **不许**再含 compaction-basic；
 *   · 插件行集合必须与官方 preset **不多不少**（只有 compaction-basic → gokifu-compact 这一处差异）——
 *     少了 = 把官方新增行弄丢（冻结），多了 = 凭空加行，都不许静默发生。
 */
export function validatePresetPatch(patchYml, officialText) {
  const problems = [];
  // 只校验**非注释正文**：生成文件头部注释里会写到 `compaction-basic` 这个词（解释替换了什么），
  // 那不是声明，不能把它当成「残留」误报。
  const body = String(patchYml)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  if (!body.includes(PRESET_ROW_NAME)) problems.push(`缺少 ${PRESET_ROW_NAME} 声明`);
  if (!body.includes(ENGINE_ROW.name)) problems.push(`缺少引擎行 ${ENGINE_ROW.name}`);
  // 只看「行 id」，不看任意出现：preset 的 description 里会解释「把 compaction-basic 换掉」，那不是残留。
  if (/^\s*- id: compaction-basic\s*$/m.test(body)) problems.push("仍残留 - id: compaction-basic");
  const expected = pluginIds(officialText)
    .map((id) => (id === "compaction-basic" ? ENGINE_ROW.id : id))
    .sort();
  const actual = pluginIds(body).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const missing = expected.filter((id) => !actual.includes(id));
    const extra = actual.filter((id) => !expected.includes(id));
    problems.push(
      `插件行集合与官方 preset 不一致（缺：${missing.join(", ") || "无"}；多：${extra.join(", ") || "无"}）` +
        " —— 生成器必须「其余行逐字保留」，否则就是把某版 DSH 的清单冻结成快照",
    );
  }
  if (problems.length > 0) throw new Error(`生成物自检失败：${problems.join("；")}`);
  return true;
}

/**
 * 纯函数：官方 preset 文本 → preset bundle 包内容（package.json + cordis.patch.yml）。
 *
 * @param {{officialText:string, id?:string, name?:string, order?:number|null, hostVersion?:string|null}} options
 * @returns {{packageJson:object, packageJsonText:string, patchYml:string, presetId:string, displayName:string, order:number|string|null, groupId:string, hostVersion:string|null, engineReplacement:object, pluginCount:number}}
 */
export function buildPresetBundle(options = {}) {
  const { officialText, id = "gokifu", hostVersion = null } = options;
  if (typeof officialText !== "string" || officialText.trim() === "") throw new Error("没有官方 preset 文本可改写");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new UsageError(`preset id 不合法（只允许字母/数字/._-，且不以符号开头）：${id}`);

  // 先校验「是不是 agent-preset 的 insert 声明」：形状不对时报错比「找不到 compaction-basic」更贴根因
  extractInsertConfig(officialText);
  const rewritten = rewriteCompactionEngine(officialText);
  const extracted = extractInsertConfig(rewritten.text);
  const configLines = [...extracted.configLines];
  const keyIndent = extracted.configIndent + 2;
  const pad = " ".repeat(keyIndent);
  const keyIndex = (key) => configLines.findIndex((line) => indentOf(line) === keyIndent && new RegExp(`^\\s*${key}:`).test(line));

  // config.id = 新的 preset id（官方是 standard）
  const idIdx = keyIndex("id");
  if (idIdx < 0) throw new Error("官方 preset 的 config 里没有 id: 行，拒绝生成");
  configLines[idIdx] = `${pad}id: ${id}`;

  // config.order：默认沿用官方值（standard = 1），--order 可覆盖；没有就补 1
  const orderIdx = keyIndex("order");
  const officialOrder = orderIdx >= 0 ? /^\s*order:\s*(\S+)\s*$/.exec(configLines[orderIdx])?.[1] ?? "1" : "1";
  const order = options.order === undefined || options.order === null ? officialOrder : options.order;
  if (orderIdx >= 0) configLines[orderIdx] = `${pad}order: ${order}`;
  else configLines.splice(idIdx + 1, 0, `${pad}order: ${order}`);

  // 显示名：默认 = id；官方 config 里的旧 name/description（属于 standard）不能带过去。
  const displayName = typeof options.name === "string" && options.name !== "" ? options.name : id;
  const description =
    typeof options.description === "string" && options.description !== "" ? options.description : DEFAULT_PRESET_DESCRIPTION;
  // 官方 preset 的 name/description 属于 standard：先整行删掉，再写我们自己的（顺序：id → name → description → order）
  for (let i = configLines.length - 1; i >= 0; i -= 1) {
    if (indentOf(configLines[i]) === keyIndent && /^\s*description:/.test(configLines[i])) configLines.splice(i, 1);
  }
  const nameIdx = configLines.findIndex((line) => indentOf(line) === keyIndent && /^\s*name:/.test(line));
  if (nameIdx >= 0) configLines[nameIdx] = `${pad}name: ${quoteYaml(displayName)}`;
  else configLines.splice(idIdx + 1, 0, `${pad}name: ${quoteYaml(displayName)}`);
  const nameLineIdx = configLines.findIndex((line) => indentOf(line) === keyIndent && /^\s*name:/.test(line));
  configLines.splice(nameLineIdx + 1, 0, `${pad}description: ${quoteYaml(description)}`);

  const header = [
    "# 由 dsh-gokifu-compact 的 scripts/make-preset.mjs 生成 —— **不要手工改**（改了会被下次重跑覆盖）。",
    "# 源：宿主 asar 内官方 preset（" + INNER_OFFICIAL_PRESET + "）。",
    `# 宿主版本：${hostVersion ?? "(未取到)"}`,
    "# 只把 compaction group 的 compaction-basic 换成 dsh-gokifu-compact/engine；其余插件行逐字保留。",
    "# 为什么是生成器：照抄一份会把「当时那版 DSH 的插件清单」冻成快照，升级新增的行会静默丢失。",
    "# DSH 升级后重跑一次即可：node scripts/make-preset.mjs --write --out <本目录>",
  ];
  const patchLines = [
    ...header,
    "- insert:",
    `    - id: preset-${id}`,
    `      name: ${quoteYaml(PRESET_ROW_NAME)}`,
    ...reindent(configLines, extracted.configIndent, 6),
  ];
  const patchYml = `${patchLines.join("\n")}\n`;
  validatePresetPatch(patchYml, officialText);

  const packageJson = {
    name: id === "gokifu" ? "dsh-gokifu-preset" : `dsh-gokifu-preset-${id}`,
    version: typeof hostVersion === "string" && /^\d+\.\d+\.\d+/.test(hostVersion) ? hostVersion : "0.0.0",
    private: true,
    description: `DSH agent preset "${id}" generated from the host's official standard preset (host ${hostVersion ?? "unknown"}).`,
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  };
  return {
    packageJson,
    packageJsonText: `${JSON.stringify(packageJson, null, 2)}\n`,
    patchYml,
    presetId: id,
    displayName,
    description,
    order,
    groupId: rewritten.groupId,
    hostVersion,
    engineReplacement: rewritten.replaced,
    pluginCount: pluginIds(patchYml).length,
  };
}

/**
 * 组合 bundle patch 的自检（**一个包装上就接管**）。
 *
 * 为什么要有这个模式：1.14.0 以前的安装是「插件包 + 另装一个 preset bundle」两步，
 * 还要用户自己跑生成器、自己挑 preset —— 跟装别的插件不一样。1.15.0 起把
 * preset 声明与默认 preset 一起放进**本包自己的** `dsh.bundle.patch`：
 *   `dsh plugin add dsh-gokifu-compact`（或插件市场点一下）→ 自动进 bundles → 重启即生效。
 * 自检锁三件事：① UI 行在；② preset 行在且引擎是 `dsh-gokifu-compact/engine`；
 * ③ 注册表默认 preset 指向本 preset；且**不许**残留 `- id: compaction-basic`。
 *
 * @param {string} patchYml 组合后的 patch 文本
 * @param {string} presetPatchYml 纯 preset 部分（交给 validatePresetPatch 做「行集合不多不少」）
 * @param {string} officialText 官方 preset 原文
 * @returns {true}
 */
export function validateBundlePatch(patchYml, presetPatchYml, officialText) {
  validatePresetPatch(presetPatchYml, officialText);
  const problems = [];
  const body = String(patchYml)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  if (!body.includes(`- id: ${UI_ROW_ID}`)) problems.push(`缺少 UI 行 ${UI_ROW_ID}`);
  if (!body.includes(`name: '${PKG_NAME}'`) && !body.includes(`name: ${PKG_NAME}`)) problems.push(`缺少 UI 行的 name: ${PKG_NAME}`);
  if (!body.includes(PRESET_ROW_NAME)) problems.push(`缺少 ${PRESET_ROW_NAME} 声明`);
  if (!body.includes(ENGINE_ROW.name)) problems.push(`缺少引擎行 ${ENGINE_ROW.name}`);
  if (body.includes("- id: compaction-basic")) problems.push("仍残留 - id: compaction-basic");
  if (!new RegExp(`^- id: ${REGISTRY_ROW_ID}$`, "m").test(body)) problems.push(`缺少注册表补丁 - id: ${REGISTRY_ROW_ID}`);
  const registryBlock = body.slice(body.indexOf(`- id: ${REGISTRY_ROW_ID}`));
  if (!/^\s*default:\s*[A-Za-z0-9][A-Za-z0-9._-]*\s*$/m.test(registryBlock)) problems.push(`注册表补丁没有 default: 行`);
  if ((body.match(/^- insert:\s*$/gm) ?? []).length !== 1) problems.push("顶层 `- insert:` 必须恰好一条");
  if (problems.length > 0) throw new Error(`bundle patch 自检失败：${problems.join("；")}`);
  return true;
}

/**
 * 纯函数：官方 preset 文本 → **本包自己的** `dsh.bundle.patch`（UI 行 + preset 行 + 默认 preset）。
 *
 * 产物直接写进仓库根的 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它），
 * 因此「装本包」= 「装 UI + 装 preset + 把新会话默认 preset 指到它」，不再需要第二个包。
 *
 * @param {{officialText:string, id?:string, name?:string, order?:number|null, hostVersion?:string|null}} options
 * @returns {ReturnType<typeof buildPresetBundle> & {patchYml:string, presetPatchYml:string}}
 */
export function buildBundlePatch(options = {}) {
  const preset = buildPresetBundle(options);
  const id = preset.presetId;
  const lines = preset.patchYml.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const insertIdx = lines.findIndex((line) => line.trim() === "- insert:");
  if (insertIdx < 0) throw new Error("preset patch 里没有顶层 `- insert:` 行（内部错误）");
  const presetRows = lines.slice(insertIdx + 1);
  const header = [
    "# dsh-gokifu-compact 的 bundle patch（**生成物 · 不要手改**；改了下一次生成会被覆盖）",
    `# 生成器：node scripts/make-preset.mjs --bundle --write —— 源：宿主 asar 内官方 preset（${INNER_OFFICIAL_PRESET}）`,
    `# 宿主版本：${preset.hostVersion ?? "(未取到)"}；preset id=${id}；引擎行 ${ENGINE_ROW.name}`,
    "#",
    "# 一个包装上就完成接管（1.15.0 起），**不需要再单独装 preset bundle**：",
    `#   ① 插入 UI host 行（${UI_ROW_ID}）：/gokifu/api + 设置页；`,
    `#   ② 插入 agent preset 行（preset-${id}）：compaction group 的 compaction-basic → ${ENGINE_ROW.name}；`,
    `#   ③ 把 ${REGISTRY_ROW_ID} 的新会话默认 preset 指向 ${id} —— 新会话自动用本引擎（用户仍可在设置里改回）。`,
    "# preset 的其余插件行逐字保留（自检「不多不少」，避免把某版 DSH 的清单冻成快照后静默丢行）。",
    "# 宿主升级后重跑生成器，提交新 patch，再发一个插件版本即可。",
  ];
  const out = [
    ...header,
    "- insert:",
    `    - id: ${UI_ROW_ID}`,
    `      name: '${PKG_NAME}'`,
    ...presetRows,
    `- id: ${REGISTRY_ROW_ID}`,
    "  config:",
    `    default: ${id}`,
  ];
  const patchYml = `${out.join("\n").replace(/\n+$/, "")}\n`;
  validateBundlePatch(patchYml, preset.patchYml, options.officialText);
  return { ...preset, patchYml, presetPatchYml: preset.patchYml };
}

/* ───────────────────────── 输出目录守卫 ───────────────────────── */

function normalizedPath(p) {
  const resolved = nodePath.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 运行中的 DSH home（守卫目标）：显式 DSH_HOME，加上 Windows 默认位置 `%USERPROFILE%\DeepSeek Harness\home`。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} 归一化后的绝对路径
 */
export function runningHomes(env = process.env) {
  const homes = [];
  if (typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "") homes.push(env.DSH_HOME.trim());
  const profile = env.USERPROFILE ?? env.HOME;
  if (typeof profile === "string" && profile !== "") homes.push(nodePath.join(profile, "DeepSeek Harness", "home"));
  return [...new Set(homes.map((home) => nodePath.resolve(home)))];
}

/**
 * 输出目录守卫：**绝不允许**落在运行中的 DSH home 里（那是生产 home，本脚本只产出文件）。
 * @param {string} outDir
 * @param {string[]} [homes] home 列表（默认取 runningHomes()）
 * @returns {string} 解析后的输出目录
 */
export function assertOutDirAllowed(outDir, homes = runningHomes()) {
  if (typeof outDir !== "string" || outDir.trim() === "") throw new UsageError("输出目录为空");
  const out = normalizedPath(outDir);
  for (const home of homes) {
    const homeResolved = nodePath.resolve(home);
    const rel = nodePath.relative(normalizedPath(homeResolved), out);
    const inside = rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
    if (inside) {
      throw new UsageError(
        `输出目录不许落在运行中的 DSH home 里：${nodePath.resolve(outDir)}（home=${homeResolved}）—— 换 --out（默认 <repo>/tmp/preset-bundle 就安全）`,
      );
    }
  }
  return nodePath.resolve(outDir);
}

/* ───────────────────────────── CLI ───────────────────────────── */

export const USAGE = `dsh-gokifu-compact make-preset —— 从当前宿主读官方 preset，生成 gokifu 版 preset bundle 包

用法：
  node scripts/make-preset.mjs [选项]          默认 dry-run（只打印，不写盘）
  node scripts/make-preset.mjs --write        真的写到 --out

选项：
  --dry-run            只打印将写什么（默认）
  --write, --apply     落盘（写 <out>/package.json 与 <out>/cordis.patch.yml）
  --bundle             生成**本包自己的** bundle patch（<repo>/cordis.patch.yml：UI 行 + preset 行 + 默认 preset）
                       —— 一个包装上就接管，不再需要单独的 preset bundle；配合 --write 落盘（旧文件备份 .bak-<ts>）
  --out <dir>          输出目录（默认 <repo>/tmp/preset-bundle；**不许落在 DSH home 里**）
  --id <presetId>      preset id（默认 gokifu；生成的 insert 行 id 是 preset-<id>）
  --name <displayName> preset 显示名（默认 = id）
  --description <text> preset 描述（显示在「新会话」选择器里；默认写明它做了什么）
  --order <n>          覆盖官方 preset 的 order（默认沿用官方值）
  --asar <path>        宿主 app.asar 路径（默认自动找 D:\\DeepSeek Harness\\Desktop\\resources\\app.asar）
  --version <x.y.z>    写进生成物的宿主版本（默认从 asar 内 dsh/package.json 读）
  --help, -h           显示本帮助

退出码：0 成功；1 失败（读不到 asar / 找不到 compaction group / 生成物自检失败）；
        2 参数错误或输出目录守卫（落在 DSH home 里）。
`;

/**
 * 解析 CLI 参数（纯函数，便于测试）。未知参数 / 缺值 / 非法 id 都抛 UsageError（exit 2）。
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseArgs(argv = [], env = process.env) {
  const opts = {
    dryRun: true,
    write: false,
    bundle: false,
    out: DEFAULT_OUT,
    id: "gokifu",
    name: "",
    description: "",
    order: null,
    asar: typeof env.DSH_ASAR === "string" && env.DSH_ASAR !== "" ? env.DSH_ASAR : null,
    version: null,
    help: false,
  };
  const args = [...argv];
  const valueOf = (flag) => {
    const value = args.shift();
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${flag} 需要一个值`);
    return value;
  };
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        opts.write = false;
        break;
      case "--write":
      case "--apply":
        opts.write = true;
        opts.dryRun = false;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--bundle":
        opts.bundle = true;
        break;
      case "--out":
        opts.out = valueOf("--out");
        break;
      case "--id":
        opts.id = valueOf("--id");
        break;
      case "--name":
        opts.name = valueOf("--name");
        break;
      case "--description":
        opts.description = valueOf("--description");
        break;
      case "--order": {
        const n = Number(valueOf("--order"));
        if (!Number.isFinite(n)) throw new UsageError("--order 需要一个数字");
        opts.order = n;
        break;
      }
      case "--asar":
        opts.asar = valueOf("--asar");
        break;
      case "--version":
        opts.version = valueOf("--version");
        break;
      default:
        throw new UsageError(`未知参数：${arg}（可用：--dry-run / --write / --bundle / --out / --id / --name / --description / --order / --asar / --version / --help）`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.id)) throw new UsageError(`--id 不是合法的 preset id：${opts.id}`);
  if (opts.version !== null && !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(opts.version)) {
    throw new UsageError(`--version 不是合法版本号：${opts.version}`);
  }
  return opts;
}

function preview(text, maxLines) {
  return String(text)
    .split("\n")
    .slice(0, maxLines)
    .join("\n");
}

function byteSize(text) {
  return Buffer.byteLength(String(text), "utf8");
}

/**
 * CLI 主流程（返回退出码，便于测试直接调用）。
 * @param {string[]} argv
 * @param {{env?:NodeJS.ProcessEnv, log?:(m:string)=>void, error?:(m:string)=>void}} [options]
 * @returns {number} 0 / 1 / 2
 */
export function run(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((m) => console.log(m));
  const error = options.error ?? ((m) => console.error(m));

  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    if (e instanceof UsageError) {
      error(`make-preset: ${e.message}`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  /** --bundle 写仓库根的 cordis.patch.yml；否则写一个独立的 preset bundle 目录。 */
  const bundleOutFile = nodePath.join(REPO_DIR, "cordis.patch.yml");
  let outDir;
  try {
    outDir = assertOutDirAllowed(opts.bundle ? REPO_DIR : opts.out, runningHomes(env));
  } catch (e) {
    if (e instanceof UsageError) {
      error(`make-preset: ${e.message}`);
      return 2;
    }
    throw e;
  }

  try {
    const asarPath = resolveAsarPath(opts.asar, env);
    const officialText = readAsarEntry(asarPath, INNER_OFFICIAL_PRESET);
    const hostVersion = opts.version ?? readHostVersion(asarPath);
    const makeOpts = { officialText, id: opts.id, name: opts.name, description: opts.description, order: opts.order ?? undefined, hostVersion };
    const bundle = opts.bundle ? buildBundlePatch(makeOpts) : buildPresetBundle(makeOpts);

    if (!opts.write) {
      log(`== dsh-gokifu-compact make-preset（dry-run，不写盘）==`);
      if (opts.bundle) {
        log(`模式        : --bundle（生成本包自己的 bundle patch）`);
        log(`asar        : ${asarPath}`);
        log(`官方 preset : ${INNER_OFFICIAL_PRESET}`);
        log(`宿主版本    : ${bundle.hostVersion ?? "(未取到)"}`);
        log(`preset      : id=${bundle.presetId}（显示名：${bundle.displayName}）/ order=${bundle.order}`);
        log(`写入目标    : ${bundleOutFile}（${byteSize(bundle.patchYml)} B）`);
        log(`引擎替换    : ${bundle.engineReplacement.fromId} → ${bundle.engineReplacement.toId}（${ENGINE_ROW.name}）`);
        log(`保留插件行  : ${bundle.pluginCount} 条`);
        log("");
        log("--- cordis.patch.yml 预览（前 40 行）---");
        log(preview(bundle.patchYml, 40));
        log("");
        log("（dry-run：没有写任何文件。真写加 --write）");
        return 0;
      }
      log(`asar        : ${asarPath}`);
      log(`官方 preset : ${INNER_OFFICIAL_PRESET}`);
      log(`宿主版本    : ${bundle.hostVersion ?? "(未取到)"}`);
      log(`preset      : id=${bundle.presetId}（显示名：${bundle.displayName}）/ order=${bundle.order}`);
      log(`输出目录    : ${outDir}`);
      log(`将写文件    : package.json（${byteSize(bundle.packageJsonText)} B）/ cordis.patch.yml（${byteSize(bundle.patchYml)} B）`);
      log(`引擎替换    : ${bundle.engineReplacement.fromId} → ${bundle.engineReplacement.toId}（${ENGINE_ROW.name}）`);
      log(`保留插件行  : ${bundle.pluginCount} 条（含 command-compact / tool-result-pruner 等，逐字保留）`);
      log("");
      log("--- cordis.patch.yml 预览（前 40 行）---");
      log(preview(bundle.patchYml, 40));
      log("");
      log("--- package.json 预览 ---");
      log(bundle.packageJsonText.trimEnd());
      log("");
      log("（dry-run：没有写任何文件。真写加 --write）");
      return 0;
    }

    if (opts.bundle) {
      nodeFs.mkdirSync(nodePath.dirname(bundleOutFile), { recursive: true });
      let backup = null;
      if (nodeFs.existsSync(bundleOutFile)) {
        backup = `${bundleOutFile}.bak-${Date.now()}`;
        nodeFs.copyFileSync(bundleOutFile, backup);
      }
      nodeFs.writeFileSync(bundleOutFile, bundle.patchYml, "utf8");
      log(`✓ 已写入 ${bundleOutFile}（${byteSize(bundle.patchYml)} B）${backup === null ? "" : `；原文件备份到 ${backup}`}`);
      log(`  宿主版本 ${bundle.hostVersion ?? "(未取到)"}；preset id=${bundle.presetId}；引擎行 ${ENGINE_ROW.name}`);
      log("");
      log("下一步：");
      log("  ① 提交（git add cordis.patch.yml）→ 发版（npm publish / tag）—— 这个文件就是安装时生效的内容；");
      log("  ② 已装环境：重启 DSH 即生效（bundle 层自动合并）；装了旧 preset bundle 的，先把那个包卸掉（同名 preset 会重复）。");
      return 0;
    }
    nodeFs.mkdirSync(outDir, { recursive: true });
    const patchFile = nodePath.join(outDir, "cordis.patch.yml");
    const packageFile = nodePath.join(outDir, "package.json");
    nodeFs.writeFileSync(packageFile, bundle.packageJsonText, "utf8");
    nodeFs.writeFileSync(patchFile, bundle.patchYml, "utf8");
    log(`✓ 已写入 ${packageFile}（${byteSize(bundle.packageJsonText)} B）`);
    log(`✓ 已写入 ${patchFile}（${byteSize(bundle.patchYml)} B）`);
    log(`  宿主版本 ${bundle.hostVersion ?? "(未取到)"}；preset id=${bundle.presetId}；引擎行 ${ENGINE_ROW.name}`);
    log("");
    log("下一步（本脚本不执行，也不碰运行中的 home）：");
    log("  ① 把这个目录 link 进目标 profile（pnpm/npm link 或把依赖写成 file:/link:）；");
    log("  ② 把包名写进该 profile 的 dsh.profile.bundles；");
    log("  ③ 重启 DSH 后在 preset 选择器里选它。");
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      error(`make-preset: ${e.message}`);
      return 2;
    }
    error(`make-preset 失败：${e?.message ?? e}`);
    return 1;
  }
}

/* ── 入口判定（C-12）：直接执行才跑 CLI；被 import 零副作用 ── */
function realPathOrNull(p) {
  try {
    return nodeFs.realpathSync.native(p);
  } catch {
    return null;
  }
}
function isInvokedDirectly() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const a = realPathOrNull(argv1) ?? nodePath.resolve(argv1);
  const b = realPathOrNull(self) ?? nodePath.resolve(self);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isInvokedDirectly()) process.exitCode = run();
