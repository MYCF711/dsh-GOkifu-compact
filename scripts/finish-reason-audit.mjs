#!/usr/bin/env node
/**
 * finish-reason-audit.mjs —— 「摘要怎么结束的」**落盘率**审计（T42 / T44 · C650）
 *
 * ## 缺陷（只读量它，不改它）
 *
 * 截断判据 `looksTruncated` 的第一条分支是 `isTruncatedFinish(r.finish ?? r.finishReason)` ——
 * 它要的是**上游的终止原因**。可离线补折这条路上：
 *
 *   · `runOfflineFold` 的 chunk 组装只搬了 `usage` / `model`（`finish` 留在 `out` 上，栈一弹就没了）；
 *   · 写回点 `applyOfflineFoldToGraph` 因此**从不写** `foldMark.finishReason`。
 *
 * ⇒ 离线折痕的 `finishReason` 恒为「字段缺失」⇒ 那条分支**永远不可能命中** ⇒
 * 审计器分不开「真撞顶」与「写完但没到 2×」（T44 的 69 条假重试 / 60 条不可判 / 67 条字段缺失就是这个）。
 *
 * ## 这个脚本回答四个问题（一条不多）
 *
 *   ① **各路径的落盘率**：`archive-offline` / `pressure` / `tier2` / `manual` / `host` / 其它，
 *      各自多少条、多少条 `finishReason` 是字符串（= 采集到了）、取值分布是什么；
 *   ② **离线这条路上 `callModel` 实际返回什么**：**从源码读**（`src/engine.mjs` 与
 *      `scripts/archive-fold.mjs` 两处实现逐字段打印），不从数据猜 —— 数据只能看到"缺"，看不到"为什么缺"；
 *   ③ **补上它能让多少条从「不可判」变成可判**：历史（已落盘的记录不可变）+ 增量（每条新折痕）；
 *   ④ **`callModel` 不给 `finish` 时怎么办**：`chunk.finish = null` ⇒ 写回点**不写这个键**
 *      （写 `"unknown"` 会把「不可判」变成假的「已判」），审计器把它单独归一档。
 *
 * ## 口径（与写入点逐字对齐，改代码时这里要跟着改）
 *
 *   · 人口 = `foldMark`（每张图各自一份 `foldMarks[]`），按 `mark.trigger` 分组；
 *   · 「采集到了」= `typeof mark.finishReason === "string" && !== ""` —— 与 `scripts/instrument-audit.mjs`
 *     的 `hasFinishReason` **同一判据**（`null` 是「没采集」，不是「没有截断」）；
 *   · 「可判」= 取值被 `isTruncatedFinish` 认（截断）**或**落在正常终态闭集（没截断）；
 *     其余（`aborted` / `error` / 非字符串 / 缺键）一律「不可判」，**绝不拿 false 冒充**；
 *   · 世代分界线 `FINISH_REASON_AT` = 写回点开始写 `finishReason` 的那一版（C650）的落地时刻：
 *     **之前**落盘的折痕不可能有该字段（写回点当时不写）⇒ 缺键是历史，不是缺陷；
 *     **之后**还缺键 = 真不可判（`callModel` 没给）⇒ 才要查。
 *
 * ## 用法
 *
 *   node scripts/finish-reason-audit.mjs                    # 真机全量（DSH_HOME 或 ~/.dsh）
 *   node scripts/finish-reason-audit.mjs --json             # 机读
 *   node scripts/finish-reason-audit.mjs --session=8a73     # 单会话
 *   node scripts/finish-reason-audit.mjs --since=2026-11-05T12:00:00+08:00   # 换世代分界线
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";
import { resolveHome } from "./summary-truncation-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/**
 * 从这一代起，写回点 `applyOfflineFoldToGraph` 会写 `foldMark.finishReason`。
 *
 * 为什么要有世代号：**缺键**有两种修法完全不同的原因 ——
 *   · 生产者早于本改动：那时代码就不写这个字段，历史永远补不回来（等新折痕即可）；
 *   · 生产者已是新版、`callModel` 没给 `finish`：**真不可判**，要去查调用方（本机就是这一档）。
 * 把两者并成一档，报出来的数字既不能立项也不能验收。
 */
export const FINISH_REASON_SINCE = "C650";

/**
 * 生产者**世代分界线**（ms）—— 从 `build.json` 读，**不猜**。
 *
 * 为什么不能拍一个"编写时刻"当分界线：正在跑的 DSH 加载的还是**旧**代码（本仓踩过两次同类事故，
 * 见 `src/rooms/build-stamp.mjs` 的 C34），于是「10:00 之后写的折痕」里混着旧生产者 ——
 * 拿墙钟切会把「还没重启」误报成「真不可判」，数字越跑越大（本机第一次试就出现了）。
 *
 * 正确做法是比**构建标识**（`repoBuildId()` = `package.json` 与 `src` 下所有 `.mjs` 的内容哈希）：
 *   · 运行实例的 `buildId` **等于**磁盘 ⇒ 现在跑的就是带本改动的代码 ⇒ 分界线 = 它的 `startedAt`
 *     （这之后写的折痕都出自新生产者，缺键就是**真不可判**）；
 *   · **不等于** ⇒ 磁盘上的改动还没被加载 ⇒ 本机**一条 C650 折痕都还没有** ⇒ 分界线 = `Infinity`
 *     （全部按历史算，宁可少报，绝不编）；
 *   · 没有 `build.json` / 坏 JSON ⇒ 分界线 = `null`（**世代未知**，单独一档，不并进任何一边）。
 *
 * @param {{home:string, repoId:string, readJson?:(file:string)=>{status:string, value:object|null}}} args
 * @returns {{state:"current"|"stale"|"missing"|"invalid", boundary:number|null, buildId:string|null, repoBuildId:string, startedAt:number|null, why:string, path:string}}
 */
export function producerEpochOf({ home, repoId, readJson = readJsonFile } = {}) {
  const file = nodePath.join(String(home ?? ""), "chess-context", "build.json");
  const read = readJson(file);
  const base = { boundary: null, buildId: null, repoBuildId: String(repoId ?? "unknown"), startedAt: null, path: file };
  if (read.status === "missing") return { ...base, state: "missing", why: "没有 build.json（插件没写过戳）⇒ 判不了世代" };
  if (read.status === "invalid") return { ...base, state: "invalid", why: "build.json 不是合法 JSON（写盘中断）⇒ 判不了世代" };
  const buildId = typeof read.value?.buildId === "string" && read.value.buildId !== "" ? read.value.buildId : null;
  const startedAt = Number(read.value?.startedAt);
  if (buildId === null || !Number.isFinite(startedAt) || startedAt <= 0) {
    return { ...base, state: "invalid", why: "build.json 缺 buildId / startedAt ⇒ 判不了世代" };
  }
  if (buildId !== base.repoBuildId) {
    return {
      ...base,
      state: "stale",
      buildId,
      startedAt,
      boundary: Number.POSITIVE_INFINITY,
      why: `运行实例 buildId=${buildId} ≠ 磁盘 ${base.repoBuildId}（改动还没被加载）⇒ 本机一条 ${FINISH_REASON_SINCE} 折痕都还没有`,
    };
  }
  return { ...base, state: "current", buildId, startedAt, boundary: startedAt, why: `运行实例就是磁盘这一版（buildId=${buildId}）` };
}

/** 读一个 JSON 文件，把「没有」与「坏了」分开（旧读法把两者都归成 null，于是「不知道」被当成「没问题」）。 */
function readJsonFile(file) {
  if (!nodeFs.existsSync(file)) return { status: "missing", value: null };
  try {
    const value = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", value: null };
    return { status: "ok", value };
  } catch {
    return { status: "invalid", value: null };
  }
}

/**
 * 写入点**能**写出的正常终态（`engine.mjs` 的归一化结果 + 宿主 `stopReason` 联合）。
 * 归一化与 `isTruncatedFinish` 同一套（小写 + 去掉 `-` `_`）—— 两种拼法指的是同一件事（C320）。
 */
export const CLEAN_VALUES = Object.freeze(["stop", "endturn", "toolcalls", "completed"]);

/**
 * 「不可判」的**全部**来源 —— 闭合集。报告与测试共用这几个字符串，别在别处重写。
 *
 * 前两项是**缺键**的两种世代（修法不同：等新折痕 vs 查调用方），第三项是**判不了世代**，
 * 后两项是「有值但判不了」。
 */
export const UNJUDGEABLE = Object.freeze({
  legacy: "missing-legacy",
  genuine: "missing-genuine",
  unknown: "missing-unknown",
  nullValue: "null",
  valueUnknown: "value-unknown",
});

/** 一条折痕在 `finishReason` 上的**三态 + 不可判细分**。 */
export const FINISH_STATE = Object.freeze({
  truncated: "truncated",
  clean: "clean",
  unjudgeable: "unjudgeable",
});

/**
 * 一条折痕的 `finishReason` 判定（**纯函数**，审计与测试共用）。
 *
 * 三态口径与 doctor / 面板一致：
 *   · `truncated`    —— 字符串且 `isTruncatedFinish` 认（或含 `max`，与 `looksTruncated` 第一条同源）；
 *   · `clean`        —— 字符串且在正常终态闭集里 ⇒ 确实没截断；
 *   · `unjudgeable`  —— 其余一切，再按 `why` 细分（缺键的世代 / null / 值不认识）。
 *
 * @param {object} mark foldMark
 * @param {{boundary?:number|null}} [opts] 世代分界线（`producerEpochOf().boundary`）：
 *   `Infinity` = 新生产者还没上线（全部按历史算）；`null` = 判不了世代
 * @returns {{state:string, why:string|null, value:string|null, label:string}}
 */
export function finishStateOf(mark, { boundary = Number.POSITIVE_INFINITY } = {}) {
  const raw = mark?.finishReason;
  if (typeof raw === "string" && raw !== "") {
    if (isTruncatedFinish(raw) || /max/i.test(raw)) {
      return { state: FINISH_STATE.truncated, why: null, value: raw, label: `截断（${raw}）` };
    }
    if (CLEAN_VALUES.includes(raw.toLowerCase().replace(/[-_]/g, ""))) {
      return { state: FINISH_STATE.clean, why: null, value: raw, label: `没截断（${raw}）` };
    }
    return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.valueUnknown, value: raw, label: `值不认识（${raw}）` };
  }
  if (raw === null) {
    return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.nullValue, value: null, label: "生产者说是 null（没采集）" };
  }
  if (boundary === null || boundary === undefined) {
    return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.unknown, value: null, label: "字段缺失（判不了世代）" };
  }
  const at = Number(mark?.at);
  if (!Number.isFinite(at)) {
    return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.unknown, value: null, label: "字段缺失且没有 at（判不了世代）" };
  }
  if (Number(at) < Number(boundary)) {
    return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.legacy, value: null, label: `字段缺失（生产者早于 ${FINISH_REASON_SINCE}）` };
  }
  return { state: FINISH_STATE.unjudgeable, why: UNJUDGEABLE.genuine, value: null, label: `字段缺失（生产者已是 ${FINISH_REASON_SINCE}+，callModel 没给 finish）` };
}

/* ────────────────────────── 源码里的 callModel ────────────────────────── */

/** 跳过一段引号字符串，返回结束下标（含收尾引号）。 */
function skipQuoted(text, start, quote) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/**
 * 跳过模板字符串（含 `${…}` 插值里的括号）。
 * @returns {number} 结束下标（含收尾反引号）
 */
function skipTemplate(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && text[i + 1] === "{") {
      const close = braceEnd(text, i + 1);
      if (close < 0) return text.length;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return text.length;
}

/**
 * 从 `open`（必须是 `{`）开始找配对的 `}`，跳过字符串 / 模板 / 注释。
 * @returns {number} 配对 `}` 的下标；找不到 -1
 */
export function braceEnd(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 对象字面量内部文本的**顶层键**（跳过嵌套、字符串、注释、展开 `...`）。
 *
 * 为什么不用正则拍：两处 `callModel` 的值里有 `json?.choices?.[0]?.finish_reason ?? null`
 * 这种带方括号/括号的写法 —— 正则会在第一个逗号上切错，切出来的键名就是编的。
 *
 * @param {string} inner 花括号之间的文本
 * @returns {string[]}
 */
export function topLevelKeys(inner) {
  const s = String(inner ?? "");
  const keys = [];
  let depth = 0;
  let tokenStart = null;
  let i = 0;
  const flush = (end) => {
    const raw = s.slice(tokenStart ?? 0, end).trim();
    tokenStart = null;
    if (raw === "" || raw.startsWith("...")) return;
    const colon = raw.indexOf(":");
    // 可选标记（`finish?:string`）要剥掉，否则键名成了 `finish?` ⇒ 少报一个字段
    const head = (colon < 0 ? raw : raw.slice(0, colon)).trim().replace(/\?$/, "");
    if (/^[A-Za-z_$][\w$]*$/.test(head)) {
      keys.push(head);
      return;
    }
    const quoted = head.match(/^\[?(["'`])([^"'`]+)\1\]?$/);
    if (quoted !== null) keys.push(quoted[2]);
  };
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === "/" && next === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (tokenStart === null) tokenStart = i;
      i = skipQuoted(s, i, ch);
      continue;
    }
    if (ch === "`") {
      if (tokenStart === null) tokenStart = i;
      i = skipTemplate(s, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      if (tokenStart === null) tokenStart = i;
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      flush(i);
      i += 1;
      continue;
    }
    if (tokenStart === null && !/\s/.test(ch)) tokenStart = i;
    i += 1;
  }
  if (tokenStart !== null) flush(s.length);
  return keys;
}

/**
 * 函数体 `{` 的下标 —— **按括号深度找**，不能取「起点之后第一个 `{`」：
 * `const callModel = async (prompt, { maxTokens }) => {` 里第一个 `{` 是**解构参数**，
 * 取错就整段解析失败（而那正是「宁可吵，不许静默」要拦住的）。
 *
 * @param {string} text
 * @param {number} start 函数起点
 * @returns {number} 函数体 `{` 的下标；找不到 -1
 */
function bodyOpenOf(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (ch === "{" && depth === 0) return i;
    i += 1;
  }
  return -1;
}

/**
 * 从源码里取出一个函数的**返回对象字面量的顶层键**（`callModel` 契约的实证）。
 *
 * 取哪一处 `return {…}`：函数体里**带 `text` 键**的那一个（成功返回）。
 * 引擎的 `callModel` 还有一个 `return { tier: "offline", … }`（上下文失活）——
 * 那不是契约，是错误分支，不许拿它冒充。
 *
 * @param {string} source 源码全文
 * @param {string} marker 函数起点（逐字，签名改了这里就报「找不到」—— 宁可吵，不许静默）
 * @returns {{ok:boolean, why:string, keys:string[], all:Array<{offset:number, keys:string[]}>}}
 */
export function returnKeysOf(source, marker) {
  const text = String(source ?? "");
  const start = text.indexOf(marker);
  if (start < 0) return { ok: false, why: `找不到起点标记：${marker}`, keys: [], all: [] };
  const bodyOpen = bodyOpenOf(text, start);
  if (bodyOpen < 0) return { ok: false, why: "函数体没有 `{`", keys: [], all: [] };
  const bodyClose = braceEnd(text, bodyOpen);
  if (bodyClose < 0) return { ok: false, why: "函数体的括号不配对", keys: [], all: [] };
  const body = text.slice(bodyOpen, bodyClose + 1);
  const all = [];
  const re = /return\s*\{/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const open = bodyOpen + m.index + m[0].length - 1;
    const close = braceEnd(text, open);
    if (close < 0) continue;
    all.push({ offset: open, keys: topLevelKeys(text.slice(open + 1, close)) });
  }
  if (all.length === 0) return { ok: false, why: "函数体里没有 `return { … }`", keys: [], all: [] };
  const hit = all.filter((x) => x.keys.includes("text"));
  const chosen = hit.length > 0 ? hit[hit.length - 1] : all[all.length - 1];
  return { ok: true, why: "", keys: chosen.keys, all };
}

/**
 * 两处 `callModel` 的实现（**唯一的两个传输层**：引擎走宿主 `ctx.llm.stream`，脚本走 HTTP）。
 * 标记逐字取自源码 —— 签名改了这里就报「找不到」，而不是悄悄少报一个字段。
 */
export const CALL_MODEL_SOURCES = Object.freeze([
  {
    key: "engine",
    label: "引擎（自动补账 · 真机主路）",
    file: nodePath.join(ROOT, "src", "engine.mjs"),
    marker: "const callModel = async (prompt, { maxTokens }) => {",
  },
  {
    key: "script",
    label: "脚本（手工 --write）",
    file: nodePath.join(ROOT, "scripts", "archive-fold.mjs"),
    marker: "async function callModel({ baseUrl, apiKey, model, prompt, maxTokens, timeoutMs }) {",
  },
]);

/** `runOfflineFold` 的 JSDoc 契约里那串 `Promise<{…}>` 的键（证明 `finish?` 本来就在契约里）。 */
export function contractKeysOf(source) {
  const m = String(source ?? "").match(/Promise<\{([^}]*)\}>/);
  return m === null ? null : topLevelKeys(m[1]);
}

/* ────────────────────────────── 采集 ────────────────────────────── */

/**
 * 逐图逐折痕展开（只读）。
 * @param {string} home
 * @param {{session?:string|null}} [opts]
 * @returns {{files:number, rows:Array<{session:string, graph:object, mark:object}>}}
 */
export function collectRows(home, { session = null } = {}) {
  const scan = collectGraphFiles(home);
  const rows = [];
  for (const entry of scan.files) {
    if (session !== null && !String(entry.dir).includes(session)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      continue; // 坏图跳过：只读审计不许因为一张坏图整跑挂掉
    }
    for (const mark of Array.isArray(graph?.foldMarks) ? graph.foldMarks : []) rows.push({ session: entry.dir, graph, mark: mark ?? {} });
  }
  return { files: scan.files.length, rows };
}

/**
 * 各路径的落盘率。
 *
 * `tier2` 单独标出来：**分段合并不调模型** ⇒ 没有 `finish` 可言，缺键不是缺陷
 * （口径与 `scripts/instrument-audit.mjs` 的 `base("tier2", …)` 同源）。
 *
 * @param {Array<{mark:object}>} rows
 * @returns {Array<{trigger:string, marks:number, string:number, nulls:number, missing:number, rate:number|null, values:Array<[string,number]>, noModel:boolean}>}
 */
export function landingRates(rows) {
  const byTrigger = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const mark = row?.mark ?? {};
    const trigger = String(mark.trigger ?? "(none)");
    const bucket = byTrigger.get(trigger) ?? { trigger, marks: 0, string: 0, nulls: 0, missing: 0, values: new Map() };
    bucket.marks += 1;
    if (typeof mark.finishReason === "string" && mark.finishReason !== "") {
      bucket.string += 1;
      bucket.values.set(mark.finishReason, (bucket.values.get(mark.finishReason) ?? 0) + 1);
    } else if (mark.finishReason === null) {
      bucket.nulls += 1;
    } else {
      bucket.missing += 1;
    }
    byTrigger.set(trigger, bucket);
  }
  return [...byTrigger.values()]
    .map((b) => ({
      ...b,
      rate: b.marks === 0 ? null : b.string / b.marks,
      noModel: b.trigger === "tier2",
      values: [...b.values.entries()].sort((x, y) => y[1] - x[1]),
    }))
    .sort((a, b) => b.marks - a.marks);
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sessionArg = args.find((a) => a.startsWith("--session="));
const only = sessionArg === undefined ? null : sessionArg.slice("--session=".length) || null;
/** `--since=<ISO|ms>`：手工指定世代分界线（默认读 `build.json`，见 `producerEpochOf`）。 */
const sinceArg = args.find((a) => a.startsWith("--since="));
const sinceOverride = (() => {
  if (sinceArg === undefined) return null;
  const raw = sinceArg.slice("--since=".length);
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
})();

const pct = (x) => (Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(1)}%` : "—");
/** 显示宽度：CJK / 全角算 2 列（`padEnd` 按码点算，中文表格会歪）。 */
const wide = (s) => [...String(s)].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => `${s}${" ".repeat(Math.max(0, n - wide(s)))}`;

function main() {
  const home = resolveHome();
  const { files, rows } = collectRows(home, { session: only });
  if (rows.length === 0 && files === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  const epoch = producerEpochOf({ home, repoId: repoBuildId() });
  const since = sinceOverride === null ? epoch.boundary : sinceOverride;
  const rates = landingRates(rows);
  const offline = rows.filter((r) => r.mark.offline === true);
  const walk = offline.map((r) => ({ ...r, f: finishStateOf(r.mark, { boundary: since }) }));
  const tally = {
    files,
    marks: rows.length,
    offline: offline.length,
    offlineString: walk.filter((r) => r.f.state === FINISH_STATE.truncated || r.f.state === FINISH_STATE.clean).length,
    truncated: walk.filter((r) => r.f.state === FINISH_STATE.truncated).length,
    clean: walk.filter((r) => r.f.state === FINISH_STATE.clean).length,
    unjudgeable: walk.filter((r) => r.f.state === FINISH_STATE.unjudgeable).length,
    legacy: walk.filter((r) => r.f.why === UNJUDGEABLE.legacy).length,
    genuine: walk.filter((r) => r.f.why === UNJUDGEABLE.genuine).length,
    unknown: walk.filter((r) => r.f.why === UNJUDGEABLE.unknown).length,
    nullValue: walk.filter((r) => r.f.why === UNJUDGEABLE.nullValue).length,
    valueUnknown: walk.filter((r) => r.f.why === UNJUDGEABLE.valueUnknown).length,
    /** 判据**开过火**、却因为缺 `finishReason` 无法归因的条数（真撞顶 vs 写完但没到 2×）。 */
    judgeFired: walk.filter((r) => r.mark.truncated === true).length,
  };

  const sources = CALL_MODEL_SOURCES.map((s) => {
    let source = "";
    try {
      source = nodeFs.readFileSync(s.file, "utf8");
    } catch (error) {
      return { ...s, ok: false, why: `读不到：${String(error?.message ?? error)}`, keys: [] };
    }
    const parsed = returnKeysOf(source, s.marker);
    return { key: s.key, label: s.label, file: nodePath.relative(ROOT, s.file), marker: s.marker, ...parsed, hasFinish: parsed.ok && parsed.keys.includes("finish") };
  });
  const contract = (() => {
    try {
      return contractKeysOf(nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs"), "utf8"));
    } catch {
      return null;
    }
  })();

  const report = {
    home,
    epoch,
    boundary: since === null ? null : since === Number.POSITIVE_INFINITY ? "infinity" : new Date(since).toISOString(),
    finishReasonSince: FINISH_REASON_SINCE,
    tally,
    paths: rates,
    callModel: { contract, sources },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`finishReason 落盘率审计（T42 / T44 · ${FINISH_REASON_SINCE}）  home=${home}`);
  console.log(`生产者世代：${epoch.why}`);
  console.log(`世代分界线 ${report.boundary}（${FINISH_REASON_SINCE}；` +
    `${since === null ? "**判不了世代**，缺键一律不算缺陷" : since === Number.POSITIVE_INFINITY ? "**新生产者还没上线**，全部按历史算" : "之前落盘的折痕不可能有该字段"}）`);
  console.log(`图 ${files} 张 · foldMark ${rows.length} 条 · 其中**离线补折** ${offline.length} 条（\`looksTruncated\` 唯一跑的地方）`);
  console.log("");

  console.log("① 各路径的落盘率（「采集到了」= `finishReason` 是字符串，与 instrument-audit 同一判据）");
  console.log(`   ${pad("trigger", 18)}${pad("折痕", 6)}${pad("有值", 6)}${pad("null", 6)}${pad("缺键", 6)}${pad("落盘率", 10)}取值分布`);
  for (const row of rates) {
    const dist = row.values.length === 0 ? "—" : row.values.map(([v, n]) => `${v}×${n}`).join(" · ");
    const note = row.noModel ? "   ← 分段合并不调模型，缺键不是缺陷" : "";
    console.log(`   ${pad(row.trigger, 18)}${pad(row.marks, 6)}${pad(row.string, 6)}${pad(row.nulls, 6)}${pad(row.missing, 6)}${pad(pct(row.rate), 10)}${dist}${note}`);
  }
  console.log("");

  console.log("② 离线这条路上 `callModel` **实际**返回什么（从源码读，不从数据猜）");
  if (contract === null) {
    console.log("   契约   ✗ 读不到 `runOfflineFold` 的 JSDoc（Promise<{…}> 没解析出来）");
  } else {
    console.log(`   契约   \`runOfflineFold\` 的 JSDoc：{ ${contract.join(", ")} } ⇒ ${contract.includes("finish") ? "**本来就写着 `finish?`**" : "**没有 `finish`**（契约就不对）"}`);
  }
  for (const s of sources) {
    if (!s.ok) {
      console.log(`   ${pad(s.label, 22)} ✗ ${s.why}`);
      continue;
    }
    console.log(`   ${pad(s.label, 22)} ${pad(s.file, 26)} { ${s.keys.join(", ")} } ⇒ ${s.hasFinish ? "✅ 有 `finish`" : "❌ **没有 `finish`**"}`);
  }
  const withFinish = sources.filter((s) => s.hasFinish).map((s) => s.key);
  const withoutFinish = sources.filter((s) => s.ok && !s.hasFinish).map((s) => s.key);
  console.log(`   ⇒ ${withFinish.length === 0 ? "**一条都没有**" : `有 \`finish\` 的：${withFinish.join(" / ")}`}` +
    `${withoutFinish.length === 0 ? "" : ` · 没有的：${withoutFinish.join(" / ")}`}`);
  console.log("");

  console.log("③ 补上它能让多少条从「不可判」变成可判");
  console.log(`   现状（离线 ${tally.offline} 条）：可判 ${tally.offlineString} 条（截断 ${tally.truncated} · 没截断 ${tally.clean}）· **不可判 ${tally.unjudgeable} 条** ${pct(tally.offline === 0 ? 0 : tally.unjudgeable / tally.offline)}`);
  console.log(`     不可判细分：生产者早于 ${FINISH_REASON_SINCE} ${tally.legacy} 条 · 真不可判（${FINISH_REASON_SINCE}+ 且没给 finish）${tally.genuine} 条 · 世代未知 ${tally.unknown} 条 · 显式 null ${tally.nullValue} 条 · 值不认识 ${tally.valueUnknown} 条`);
  console.log(`     其中**判据开过火**（\`truncated === true\`）却无法归因的 ${tally.judgeFired} 条 —— 补上后会立刻分裂成「真撞顶 / 写完但没到 2×」两档。`);
  console.log(`   历史：已落盘的 ${tally.unjudgeable} 条**一条都补不回来**（记录不可变，写回点不重算旧折痕）。`);
  console.log(`   增量：新折痕的可判率 = 该路由 \`callModel\` 是否给 \`finish\` ⇒ ` +
    `${withFinish.length === 0 ? "**0%**（两处都不给 ⇒ 接线不产生任何可判）" : withFinish.map((k) => `${k} 100%`).join(" · ")}` +
    `${withoutFinish.length === 0 ? "" : ` · ${withoutFinish.map((k) => `${k} 0%`).join(" · ")}`}`);
  console.log("");

  console.log("④ 结论");
  const engine = sources.find((s) => s.key === "engine");
  const script = sources.find((s) => s.key === "script");
  console.log(`   · 离线折痕 ${tally.offline}/${tally.offline} 条的 \`finishReason\` 落盘率 = ${pct(tally.offline === 0 ? 0 : tally.offlineString / tally.offline)}` +
    ` ⇒ \`looksTruncated\` 的 finish 分支在这条路上**命中不了**（不是"没撞顶"，是"看不见撞没撞"）；`);
  console.log(`   · 根因在**传输层**，不在编排层：` +
    `${engine?.ok ? `引擎 \`callModel\` 返回 { ${engine.keys.join(", ")} }` : "引擎 callModel 未解析"}，` +
    `${script?.ok ? `脚本 \`callModel\` 返回 { ${script.keys.join(", ")} }` : "脚本 callModel 未解析"}；`);
  console.log(`   · **修法**：chunk 组装把 \`finish\` 搬上去（${FINISH_REASON_SINCE}）—— 编排层从此有值可传，` +
    `但**引擎那条 callModel 不返回 finish**（见 ②）⇒ 真机上可判条数**不会变**，除非引擎侧也把 \`usedAssembler.finish\` 带出来；`);
  console.log(`   · \`callModel\` 不给 \`finish\` 时：\`chunk.finish = null\` ⇒ 写回点**不写这个键**（写 \`"unknown"\` 会把「不可判」变成假的「已判」）` +
    `⇒ 审计器把它归到「真不可判」，只有\`at\`早于分界线的才算历史。`);
  console.log(`   · 退出码 0（只读审计跑完）；不写盘、不改图、不调模型。`);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
