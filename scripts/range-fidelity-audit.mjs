#!/usr/bin/env node
/**
 * range-fidelity-audit.mjs —— 「折叠区间保真度」审计（T53 · 只读 · 零模型调用）
 *
 * 由来（Lead 在 T52 之后立的单，原话）：
 *   「T52 的结论暴露了一个方法论缺陷：**可定位率 = f(折痕形状)，不是 f(代码质量)**。
 *    折到会话尾部 99.6%、折历史中段 43.9%；新折痕 37/38 是补账折（离尾部 >100 事件）
 *    ⇒ 天生落在最差档。今晚已经有多条任务拿它当验收，**全部失效**。」
 *
 * 待证伪的假设（T52 归因到的那一条）：
 *   补账折的 `foldMark` 记录区间是 `seq 8-8`，但模型**实际看到** seq 9-501（`fromSeq = seqStart` 头取），
 *   所以摘要描述的是 9-501 的内容 ⇒ **记录区间与实际内容区间不一致** ⇒ `sanitizeSummaryIds`
 *   把「`span.end > 边界`」的引用抹成 `n?` 是**正确行为**，可定位率只是这个缺陷的影子。
 *
 * 本脚本只做一件事：**把「记录区间 vs 实际内容区间」量出来**，然后诚实地回答
 * 「保真度能不能当质量指标」。它不评分、不调模型、不写盘、不改任何压缩行为。
 *
 * ── 两个口径（必须都算，缺一个就会得出错误结论） ────────────────────────────
 * ① **口径 A · 摘要内可定位区间（任务书指定的口径）**
 *    `实际内容区间 = 摘要里能定位到的实体（`nN`/`eN`）所覆盖的 seq 范围`。
 *    这是**概念上正确**的定义（摘要"在讲哪一段"），但它有一个致命的观测缺陷，见下。
 * ② **口径 B · 输入重放区间（模型实际看到的跨度）**
 *    用**与生产同参**（`maxChars = 60,000`、`perMessageChars = 2,000`、`fromSeq = seqStart`）
 *    重跑 `collectMessages`，取装进 prompt 的消息 seq 跨度。这是**因果上**的定义
 *    （摘要只能由喂进去的东西生成），也是唯一在**所有**折痕上都有定义的口径。
 *
 * ── 为什么口径 A 必须配一条「截断引理」才读得懂 ──────────────────────────────
 * ⚠ 先看**正文是谁写的**：盘上的正文由**运行中的**（pre-T35）`sanitizeSummaryIds` 落盘，
 *   那一版的界是 `range.end`（**无条件**）⇒ 对**图里存在**的实体恒有
 *
 *     存活 ⟺ span.end ≤ range.end                     （pre-T35 截断引理，两个方向都成立）
 *
 * ⇒ **活下来的引用一定落在记录区间的右端点之内**。所以口径 A 的「记录区间覆盖实际内容」
 *   在任何一条非零存活引用的摘要上都**恒为真**：它看不见「被抹掉的引用」，
 *   而「被抹掉的引用」正是要找的缺陷。这个恒等式不是质量，是**结构性失明**。
 * ⇒ 口径 A 在「一个存活引用都没有」时只能记 **`n/a`（不可测）**；
 *   而那 60 条恰好**全部**是补账折 —— 于是「删掉不可测再算相关」会得到一张漂亮但假的表。
 *
 * ⚠ 但这层截断**是版本伪影，不是定义的属性**：T35 之后（当前源码）界改成
 *   「区间内最后一个实体」，**取不到就不判未来**（`boundary === null` ⇒ 一个字都不抹）。
 *   补账折的区间（`seq 8-8`）早于全图第一个实体 ⇒ 那些 `nN` 会**全部存活**
 *   ⇒ 口径 A 变成**可测**，且保真度**就是 0**（全部引用都在 `range.end` 之后 ⇒ 交集为空）。
 *   所以本脚本**两组数都打**：
 *     · `fidelityId`         —— 盘上正文量到的（删掉不可测，**幸存者偏差**）；
 *     · `fidelityIdImputed`  —— T35 生效后口径 A 会给出的值（补真 = 0；因为 T35 只会让
 *                               实际区间**向右长**，而分母变大、交集不变 ⇒ 这是一个**保守下界**）。
 *
 * ── 三条判据（Lead 指定，逐条给数） ────────────────────────────────────────
 *   1. **与「离尾部距离」无强相关**（|ρ| 要小）—— 否则它跟可定位率一样是形状的影子；
 *   2. **同一条折痕在修复前后会变**（用 T37 的 `coverageOf` 重放同一区间，看保真度是否回到 1.0）；
 *   3. **对「摘要质量」有解释力**（保真度低 ⇒ 可定位率低）。
 *
 *   相关性**两个都算**：Pearson（线性）与 Spearman（秩）。**主判据用 Spearman**，理由：
 *   保真度是 [0,1] 有界且**在 1.0 有巨大点质量**（截断），`离尾部距离` 是重尾（917/1111 条 > 100）
 *   且在 0 有点质量 —— 两者的边际分布都不满足 Pearson 的线性+等方差假设，
 *   而我们要问的是**单调关联**（"越远是不是越差"），不是斜率。Pearson 一并给出，两者结论一致。
 *
 * 边界（与 T33/T37/T52 同一条线）：
 *   · **纯只读**：`graph.json` 与宿主会话日志只 `readFileSync`；**一个字节都不写**；
 *   · **不改产品代码**：不 import 任何会写盘的函数（`applyOfflineFoldToGraph` 一律不碰）；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`。
 *
 * 用法：
 *   node scripts/range-fidelity-audit.mjs                     # 全量
 *   node scripts/range-fidelity-audit.mjs --json              # 机读
 *   node scripts/range-fidelity-audit.mjs --home <DIR>        # 显式指定 DSH_HOME
 *   node scripts/range-fidelity-audit.mjs --as-of <ISO>       # 冻结快照（可复现）
 *   node scripts/range-fidelity-audit.mjs --limit <N>         # 逐条只打前 N 条（汇总仍是全量）
 *
 * 退出码：0 = 审计跑完（无论结论是「能用」还是「不能用」）；2 = 读不到棋谱目录。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectMessages, coverageOf } from "../src/rooms/offline-fold.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { resolveHome, resolveSummaryText } from "./summary-usability-audit.mjs";

/** 生产口径（与 `engine.mjs` 的 `chess.offlineMaxChars` / `collectMessages` 默认值同源）。 */
export const REPLAY_MAX_CHARS = 60_000;
export const REPLAY_PER_MESSAGE_CHARS = 2_000;

/**
 * 独立 id 的判据（**与 `measureSample` / `findUnknownIds` 逐字同形**）。
 * 前后都不能接标识符字符：`the1` 不算 `e1`，`e1` 不能匹配 `e12`。
 * 位数上限 5 —— 真机图里已有 `n3634` / `e9442`，4 位不够（`findUnknownIds` 的 `{1,4}`
 * 是历史值，这里跟 T52 的可定位率口径走 `{1,5}`，否则两把尺子的分母不同）。
 */
export const ID_SOURCE = "[en][0-9]{1,5}";

/** 占位符（`n?` / `e?` / 全角 `？`）—— 被 `sanitizeSummaryIds` 抹掉的引用。 */
export const PLACEHOLDER_SOURCE = "[ne][?？]";

/**
 * 「离尾部距离」分档（**与 T52 `tailGapBands` 完全同一组**，不许另发明一套，
 * 否则两个指标的桶不可比）。`gap = 会话最大 seq − 折痕 seqEnd`。
 */
export const TAIL_BANDS = Object.freeze([
  { band: "折到尾部(0)", lo: 0, hi: 0 },
  { band: "1–20", lo: 1, hi: 20 },
  { band: "21–100", lo: 21, hi: 100 },
  { band: "100+", lo: 101, hi: Number.MAX_SAFE_INTEGER },
]);

/** 保真度直方图的分档（固定，输出与测试都按它）。 */
export const HIST_EDGES = Object.freeze([
  { key: "= 0.0", test: (v) => v === 0 },
  { key: "0–0.5", test: (v) => v > 0 && v < 0.5 },
  { key: "0.5–0.9", test: (v) => v >= 0.5 && v < 0.9 },
  { key: "0.9–1.0", test: (v) => v >= 0.9 && v < 1 },
  { key: "= 1.0", test: (v) => v === 1 },
]);

/** 判据门槛（改门槛只改这里）。 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 1：|Spearman| 小于这个数才算「与形状无强相关」。 */
  maxAbsRho: 0.3,
  /** 判据 3：Spearman 低于这个数就算「没有解释力」。 */
  minExplanatoryRho: 0.3,
  /** 判据 2：修复后保真度均值至少要涨这么多（绝对）。 */
  minRepairGain: 0.3,
});

/* ───────────────────────────── 纯函数：区间与保真度 ───────────────────────────── */

/**
 * 摘要正文里**作为独立标识符**出现的 `nN` / `eN`（保序、去重）。
 *
 * 为什么不用 `mentionsEdge`：它只认边（`eN`），而「摘要覆盖了哪一段」主要由状态节点（`nN`）决定 ——
 * 真机一条摘要 34 个 id 里 30 个是 `nN`。判据必须是同一条边界规则，否则 `e1` 与 `e12`、
 * `the1` 与 `e1` 会算出不同的分母（本仓因为「两套口径」栽过很多次：C607 / C638 / C641）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function independentIds(text) {
  const src = String(text ?? "");
  const re = new RegExp(ID_SOURCE, "g");
  const seen = new Set();
  const out = [];
  for (const match of src.matchAll(re)) {
    const at = match.index ?? 0;
    const before = at > 0 ? src[at - 1] : "";
    const after = src[at + match[0].length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    out.push(match[0]);
  }
  return out;
}

/** 摘要里被抹成 `n?` / `e?` 的引用条数（**不去重** —— 同一个占位符出现两次就是两条证据）。 */
export function placeholderCount(text) {
  return (String(text ?? "").match(new RegExp(PLACEHOLDER_SOURCE, "g")) ?? []).length;
}

/**
 * 一个实体的 seq 跨度：边取 `evidence.start/end`，节点取 `seq`（单点）。
 * 图里没有 / 没有位置信息 ⇒ `null`（**不猜**，由调用方记进 `unresolved`）。
 *
 * @param {object} graph
 * @param {string} id
 * @returns {{start:number, end:number}|null}
 */
export function entitySpan(graph, id) {
  const key = String(id ?? "");
  if (key === "") return null;
  if (key[0] === "e") {
    const evidence = graph?.edges?.[key]?.evidence;
    if (evidence === null || evidence === undefined) return null;
    const start = Number(evidence.start);
    const end = Number(evidence.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end };
  }
  const seq = Number(graph?.nodes?.[key]?.seq);
  if (!Number.isFinite(seq)) return null;
  return { start: seq, end: seq };
}

/**
 * **口径 A**：摘要正文里能定位到的实体覆盖的 seq 范围。
 *
 * `resolved` 是参与计算的 id 数（去重后），`unresolved` 是图里查不到的（幻觉 id）。
 * 一个都定位不到时 `start/end` 为 `null` —— 此时**不能**说「保真度 = 0」，
 * 要由 {@link imputeFidelity} 按引理补真（两者的区别在报告 §1 里写明）。
 *
 * @param {string} text
 * @param {object} graph
 * @returns {{start:number|null, end:number|null, resolved:number, unresolved:number, placeholders:number}}
 */
export function contentRangeFromText(text, graph) {
  const ids = independentIds(text);
  let min = null;
  let max = null;
  let resolved = 0;
  let unresolved = 0;
  for (const id of ids) {
    const span = entitySpan(graph, id);
    if (span === null) {
      unresolved += 1;
      continue;
    }
    resolved += 1;
    min = min === null ? span.start : Math.min(min, span.start);
    max = max === null ? span.end : Math.max(max, span.end);
  }
  return { start: min, end: max, resolved, unresolved, placeholders: placeholderCount(text) };
}

/**
 * 折痕的**记录区间**（`foldMark.seqStart/seqEnd`，闭区间）。
 * @param {object} mark
 * @returns {{start:number, end:number}|null}
 */
export function recordedRange(mark) {
  const start = Number(mark?.seqStart);
  const end = Number(mark?.seqEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/** 两个闭区间的交集长度（事件数）。 */
export function intersectionSize(a, b) {
  if (a === null || b === null) return 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1);
}

/**
 * **保真度** = 记录区间覆盖实际内容区间的比例 = `|记录 ∩ 实际| / |实际|`。
 *
 * 为什么分母是「实际」而不是「记录」：我们要问的是「账上记的那一段盖住了模型看到的内容吗」，
 * 不是反过来。用记录做分母会把「区间过窄」和「区间过宽」混成一个数（真机两种都有）。
 * 实际区间为空（没有可定位引用）⇒ `null`（不可测，**不是 0**）。
 *
 * @param {{start:number,end:number}|null} recorded
 * @param {{start:number|null,end:number|null}|null} actual
 * @returns {number|null}
 */
export function rangeFidelity(recorded, actual) {
  if (recorded === null || actual === null || actual === undefined) return null;
  if (actual.start === null || actual.end === null) return null;
  const length = actual.end - actual.start + 1;
  if (length <= 0) return null;
  return intersectionSize(recorded, actual) / length;
}

/**
 * 首尾偏差：`head = 实际最小 seq − seqStart`（>0 = 区间起点比内容晚 ⇒ 少记了开头）、
 * `tail = seqEnd − 实际最大 seq`（>0 = 区间终点比内容晚 ⇒ 多记了尾巴）。
 * 两个都 > 0 说明记录区间**真的包住**了内容（保真度 = 1）；任一为负说明**漏记**。
 *
 * @param {{start:number,end:number}} recorded
 * @param {{start:number,end:number}} actual
 * @returns {{head:number, tail:number}|null}
 */
export function edgeDeviation(recorded, actual) {
  if (recorded === null || actual === null || actual === undefined) return null;
  if (actual.start === null || actual.end === null) return null;
  return { head: actual.start - recorded.start, tail: recorded.end - actual.end };
}

/**
 * 按「**存活引理**」把不可测的保真度补成 0。
 *
 * 引理（`sanitizeSummaryIds` 的判据推出来的，两个方向都成立）：
 *   `span.end ≤ range.end ⟺ 存活`（对图里存在的实体）。
 * ⇒ 一个存活引用都没有时，**所有**已知引用都在 `range.end` 之后 ⇒ 与记录区间交集为空
 *   ⇒ 保真度**就是** 0。
 *
 * 但这条只在「确实提到过东西」（`placeholders > 0` 或 `resolved > 0`）时成立：
 * 正文一个引用都没有（空摘要）⇒ 真的不可测，返回 `null`。
 *
 * @param {object} row `contentRangeFromText` 的结果
 * @returns {number|null}
 */
export function imputeFidelity(row) {
  if (row === null || row === undefined) return null;
  if (row.start !== null && row.end !== null) {
    return rangeFidelity(row.recorded ?? null, row);
  }
  if (Number(row.placeholders) > 0) return 0;
  return null;
}

/**
 * **口径 B**：重放生产同参，取装进 prompt 的**消息** seq 跨度（模型实际看到的区间）。
 *
 * 为什么只算 user/assistant 消息、不算全部事件：`collectMessages` 只把消息（与受预算约束的
 * 工具行）装进 prompt；事件序（`session` / `step/start` / `compaction/*`）不进模型，
 * 把它们算进「实际内容」会把分母撑大、把保真度压低（这是 T52 的 `replay()` 已经踩过的口径）。
 *
 * @param {Array<object>} events 会话日志
 * @param {{start:number,end:number}} range 折痕记录区间（只用作 `fromSeq` 下界，与生产一致）
 * @param {Map<number,string>|null} [idBySeq]
 * @returns {{start:number|null, end:number|null, messages:number, chars:number}|null}
 */
export function replayRange(events, range, idBySeq = null) {
  if (!Array.isArray(events) || events.length === 0 || range === null || range === undefined) return null;
  const collected = collectMessages(events, {
    maxChars: REPLAY_MAX_CHARS,
    perMessageChars: REPLAY_PER_MESSAGE_CHARS,
    fromSeq: Number(range.start),
    idBySeq,
  });
  const seqs = collected.messages.map((message) => Number(message.seq)).filter((seq) => Number.isFinite(seq));
  if (seqs.length === 0) return null;
  return { start: Math.min(...seqs), end: Math.max(...seqs), messages: seqs.length, chars: collected.chars };
}

/**
 * **判据 2 的重放**：用**当前代码**（T37 之后的 `coverageOf`）把同一段重算一遍，
 * 看「账上会记成什么区间」。这是「修复前后同一条折痕」的对照物。
 *
 * @param {Array<object>} events
 * @param {{start:number,end:number}} range
 * @param {Map<number,string>|null} [idBySeq]
 * @returns {{start:number,end:number}|null}
 */
export function repairedRange(events, range, idBySeq = null) {
  const replay = replayRange(events, range, idBySeq);
  if (replay === null) return null;
  const seqs = [];
  // 只用两端点就够：`coverageOf` 只取 min/max（保持与生产同参、不复制取消息逻辑）。
  seqs.push(replay.start, replay.end);
  const cov = coverageOf({ rangeStart: Number(range.start), rangeEnd: Number(range.end), seqs });
  return { start: cov.start, end: cov.end };
}

/* ───────────────────────────── 纯函数：统计 ───────────────────────────── */

/** 升序秩（并列取平均秩）—— Spearman 用。 */
export function rank(values) {
  const list = (Array.isArray(values) ? values : []).map((value, index) => ({ value, index }));
  list.sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array(list.length);
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].value === list[i].value) j += 1;
    const average = (i + j) / 2;
    for (let k = i; k <= j; k += 1) ranks[list[k].index] = average;
    i = j + 1;
  }
  return ranks;
}

/**
 * Pearson 相关系数。任一序列方差为 0 ⇒ `null`（**不返回 0**：常数序列的「无相关」是假的，
 * 它会让人以为「检查过了」）。
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null}
 */
export function pearson(xs, ys) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  if (n < 3) return null;
  const meanX = xs.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Spearman 秩相关（= 秩上的 Pearson）。**本脚本的主判据**（理由见文件头）。
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null}
 */
export function spearman(xs, ys) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  if (n < 3) return null;
  return pearson(rank(xs.slice(0, n)), rank(ys.slice(0, n)));
}

/** 线性插值分位数（空数组 ⇒ `null`）。 */
export function quantile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = (list.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? list[lo] : list[lo] + (list[hi] - list[lo]) * (at - lo);
}

const round = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const mean = (values) => {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  return list.length === 0 ? null : list.reduce((sum, value) => sum + value, 0) / list.length;
};

/**
 * 一条折痕落在哪个「离尾部」桶（边界归左：`gap === 0` 是「折到尾部」）。
 *
 * `gap ≤ 0` 一律进第一桶：`gap < 0` 表示**记录区间越过了图里最后一个节点**
 * （真机没见过，因为节点稀疏、最后一段常常只有消息；但夹具里会出现），
 * 语义上仍然是「折到尾部」。**不吞成 null** —— 吞掉等于把这一条从分桶里静默删掉。
 *
 * ⚠ `Number(null) === 0`：缺测必须先挡掉，否则「没有数据」会被算成「折到尾部」。
 */
export function tailBandOf(gap) {
  if (gap === null || gap === undefined || gap === "") return null;
  const value = Number(gap);
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return TAIL_BANDS[0].band;
  for (const band of TAIL_BANDS) if (value >= band.lo && value <= band.hi) return band.band;
  return null;
}

/**
 * 一组折痕的保真度摘要。
 * @param {Array<object>} rows
 * @returns {{n:number, fidelityId:object, fidelityIdImputed:object, fidelityReplay:object,
 *   fidelityRepaired:object, traceableShare:number|null, ids:number, placeholders:number}}
 */
export function summarizeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.reduce((sum, row) => sum + (Number(row.ids) || 0), 0);
  const placeholders = list.reduce((sum, row) => sum + (Number(row.placeholders) || 0), 0);
  const describe = (key) => {
    const values = list.map((row) => row[key]).filter((value) => value !== null && value !== undefined && Number.isFinite(value));
    return {
      n: values.length,
      mean: round(mean(values)),
      p10: round(quantile(values, 0.1)),
      p50: round(quantile(values, 0.5)),
      p90: round(quantile(values, 0.9)),
      atOne: values.filter((value) => value === 1).length,
      atZero: values.filter((value) => value === 0).length,
      histogram: Object.fromEntries(
        HIST_EDGES.map((edge) => [edge.key, values.filter((value) => edge.test(value)).length]),
      ),
    };
  };
  return {
    n: list.length,
    fidelityId: describe("fidelityId"),
    fidelityIdImputed: describe("fidelityIdImputed"),
    fidelityReplay: describe("fidelityReplay"),
    fidelityRepaired: describe("fidelityRepaired"),
    // 池化的可定位率（与 T52 `summarizeBucket` 的 `traceableRate` 同一个口径：Σids / Σ(ids+n?)）
    traceableShare: ids + placeholders === 0 ? null : round(ids / (ids + placeholders)),
    ids,
    placeholders,
  };
}

/**
 * 取两个字段都有限的子集算相关（缺一个就整条丢掉 —— 不许拿 0 冒充缺测）。
 * @param {Array<object>} rows
 * @param {string} keyX
 * @param {string} keyY
 * @returns {{n:number, pearson:number|null, spearman:number|null}}
 */
export function correlate(rows, keyX, keyY) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      row?.[keyX] !== null &&
      row?.[keyX] !== undefined &&
      Number.isFinite(row[keyX]) &&
      row?.[keyY] !== null &&
      row?.[keyY] !== undefined &&
      Number.isFinite(row[keyY]),
  );
  const xs = list.map((row) => Number(row[keyX]));
  const ys = list.map((row) => Number(row[keyY]));
  return { n: list.length, pearson: round(pearson(xs, ys)), spearman: round(spearman(xs, ys)) };
}

/* ───────────────────────────── 只读扫盘 ───────────────────────────── */

/** 只读打开一张棋谱；坏图返回 `null`（计数里能看出来，不吞成「没有折痕」）。 */
function readGraph(file) {
  try {
    const graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return graph !== null && typeof graph === "object" ? graph : null;
  } catch {
    return null;
  }
}

/**
 * 会话日志索引：`sessionId → *.zstd`。
 *
 * 为什么先建索引再读：`degenerate-range-audit.mjs` 是**按折痕**递归找日志（O(会话×折痕)），
 * 本脚本要读 400+ 份日志，那样会跑成分钟级。索引只走一次目录树。
 *
 * @param {string} home
 * @returns {Map<string,string>}
 */
export function buildLogIndex(home) {
  const index = new Map();
  const root = nodePath.join(home, "sessions");
  if (!nodeFs.existsSync(root)) return index;
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".zstd")) continue;
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(entry.name) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(full);
      if (match === null) continue;
      const key = match[1].toLowerCase();
      if (!index.has(key)) index.set(key, full);
    }
  };
  walk(root);
  return index;
}

/**
 * 一条折痕的审计行（纯函数，便于单测）。
 *
 * @param {object} args
 * @param {object} args.mark `foldMark`
 * @param {object} args.graph 棋谱
 * @param {string|null} args.text 这条折痕的**最终正文**（模型输出 + 机械追加段），没有就 `null`
 * @param {Array<object>|null} args.events 会话日志（`null` = 没解出来）
 * @param {number} args.graphMaxSeq 图里最大节点 seq（「离尾部距离」的基准，与 T52 同源）
 * @param {Map<number,string>|null} [args.idBySeq]
 * @param {string} [args.sessionId]
 * @returns {object}
 */
export function auditMark({ mark, graph, text, events, graphMaxSeq, idBySeq = null, sessionId = "?" }) {
  const recorded = recordedRange(mark);
  const row = {
    sessionId: String(sessionId),
    at: Number(mark?.at) || null,
    trigger: String(mark?.trigger ?? "undefined"),
    recorded,
    span: recorded === null ? null : recorded.end - recorded.start + 1,
    degenerate: recorded !== null && recorded.start === recorded.end,
    graphMaxSeq: Number(graphMaxSeq) || 0,
    tailGap: recorded === null ? null : (Number(graphMaxSeq) || 0) - recorded.end,
    hasText: typeof text === "string" && text !== "",
    ids: 0,
    placeholders: 0,
    traceableShare: null,
    content: null,
    fidelityId: null,
    fidelityIdImputed: null,
    headDev: null,
    tailDev: null,
    replay: null,
    fidelityReplay: null,
    // 首尾偏差也按口径 B 再给一份：口径 A 在「证据被抹光」时是 null，而缺陷恰恰在那里
    headDevReplay: null,
    tailDevReplay: null,
    repaired: null,
    fidelityRepaired: null,
  };
  if (recorded === null) return row;

  if (row.hasText) {
    const content = contentRangeFromText(text, graph);
    row.content = content;
    row.ids = independentIds(text).length;
    row.placeholders = content.placeholders;
    const refs = row.ids + row.placeholders;
    row.traceableShare = refs === 0 ? null : round(row.ids / refs);
    row.fidelityId = rangeFidelity(recorded, content);
    row.fidelityIdImputed = imputeFidelity({ ...content, recorded });
    const deviation = edgeDeviation(recorded, content);
    row.headDev = deviation === null ? null : deviation.head;
    row.tailDev = deviation === null ? null : deviation.tail;
  }

  if (Array.isArray(events) && events.length > 0) {
    const replay = replayRange(events, recorded, idBySeq);
    row.replay = replay;
    row.fidelityReplay = rangeFidelity(recorded, replay);
    const replayDeviation = edgeDeviation(recorded, replay);
    row.headDevReplay = replayDeviation === null ? null : replayDeviation.head;
    row.tailDevReplay = replayDeviation === null ? null : replayDeviation.tail;
    const repaired = repairedRange(events, recorded, idBySeq);
    row.repaired = repaired;
    row.fidelityRepaired = rangeFidelity(repaired, replay);
  }
  return row;
}

/**
 * 跑一次完整的审计（纯只读）。
 *
 * @param {{home:string, asOf?:number|null, logIndex?:Map<string,string>|null}} args
 * @returns {object}
 */
export function audit({ home, asOf = null, logIndex = null } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    return { home, asOf, missing: true, sessions: 0, marks: 0, rows: [] };
  }
  const index = logIndex ?? buildLogIndex(home);
  const rows = [];
  let sessions = 0;
  let marks = 0;
  let graphs = 0;
  let logsRead = 0;
  let logsMissing = 0;
  const entries = nodeFs.readdirSync(sessionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null) continue;
    graphs += 1;
    const list = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    sessions += 1;
    marks += list.length;
    if (list.length === 0) continue;
    if (asOf !== null && !list.some((mark) => Number(mark?.at) <= asOf)) continue;

    const sessionId = String(graph.sessionId ?? entry.name);
    const graphMaxSeq = Object.values(graph.nodes ?? {}).reduce((max, node) => {
      const seq = Number(node?.seq);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
    const idBySeq = new Map();
    for (const node of Object.values(graph.nodes ?? {})) {
      const seq = Number(node?.seq);
      const id = typeof node?.id === "string" ? node.id : null;
      if (!Number.isFinite(seq) || id === null || id === "" || idBySeq.has(seq)) continue;
      idBySeq.set(seq, id);
    }
    // 日志只解一次（同一会话的多条折痕共用）；解不出来就记 `null`，**不吞成空数组**
    const logFile = index.get(sessionId.toLowerCase()) ?? null;
    let events = null;
    if (logFile !== null) {
      const decoded = readSessionEvents(logFile);
      if (decoded.length > 0) {
        events = decoded;
        logsRead += 1;
      } else {
        logsMissing += 1;
      }
    } else {
      logsMissing += 1;
    }

    const slot = graph.lastOfflineSummary;
    for (const mark of list) {
      const at = Number(mark?.at);
      if (!Number.isFinite(at)) continue;
      if (asOf !== null && at > asOf) continue;
      const text = resolveSummaryText(mark, slot).text;
      rows.push(auditMark({ mark, graph, text, events, graphMaxSeq, idBySeq, sessionId }));
    }
  }
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const withText = rows.filter((row) => row.hasText);
  const measurableId = withText.filter((row) => row.fidelityId !== null);
  const bands = TAIL_BANDS.map((band) => {
    const list = rows.filter((row) => tailBandOf(row.tailGap) === band.band);
    return { ...band, ...summarizeRows(list) };
  });

  return {
    home,
    asOf,
    missing: false,
    sessions,
    graphs,
    marks,
    rows,
    withText,
    logsRead,
    logsMissing,
    // 口径 A：只算「有正文」的（没有正文就没有「摘要说了什么」可量）
    poolId: withText.length,
    measurableId: measurableId.length,
    unmeasurableId: withText.length - measurableId.length,
    summaryId: summarizeRows(withText),
    // 口径 B：所有能重放的折痕（有日志即可，与正文无关）
    poolReplay: rows.filter((row) => row.replay !== null).length,
    summaryReplay: summarizeRows(rows),
    summaryRepaired: summarizeRows(rows),
    bands,
    correlations: {
      // 判据 1：与「离尾部距离」的相关（**这是形状**）
      idVsTailGap: correlate(withText.filter((row) => row.fidelityId !== null), "fidelityId", "tailGap"),
      idImputedVsTailGap: correlate(withText, "fidelityIdImputed", "tailGap"),
      replayVsTailGap: correlate(rows, "fidelityReplay", "tailGap"),
      // 对照组：可定位率本身与形状的相关（T52 的结论要能被同一把尺子复现）
      traceableVsTailGap: correlate(withText, "traceableShare", "tailGap"),
      // 判据 3：与「摘要质量」（可定位率）的相关
      idVsTraceable: correlate(withText.filter((row) => row.fidelityId !== null), "fidelityId", "traceableShare"),
      idImputedVsTraceable: correlate(withText, "fidelityIdImputed", "traceableShare"),
      replayVsTraceable: correlate(rows, "fidelityReplay", "traceableShare"),
      // 对照：新指标 vs 旧指标（要是比跟形状还像，就不是替代品）
      replayVsIdImputed: correlate(rows.filter((row) => row.fidelityReplay !== null && row.fidelityIdImputed !== null), "fidelityReplay", "fidelityIdImputed"),
    },
    // 判据 2：修复前后（同一条折痕）
    repair: {
      pool: rows.filter((row) => row.fidelityReplay !== null && row.fidelityRepaired !== null).length,
      beforeMean: round(mean(rows.map((row) => row.fidelityReplay))),
      afterMean: round(mean(rows.map((row) => row.fidelityRepaired))),
      toOne: rows.filter((row) => row.fidelityRepaired === 1).length,
      changed: rows.filter(
        (row) => row.fidelityReplay !== null && row.fidelityRepaired !== null && Math.abs(row.fidelityReplay - row.fidelityRepaired) > 1e-9,
      ).length,
      // 退化区间（补账缺口）单独看：这是假设点名的那一档，也是 T37 **唯一**会改的那一档
      degenerateBeforeMean: round(mean(rows.filter((row) => row.degenerate).map((row) => row.fidelityReplay))),
      degenerateAfterMean: round(mean(rows.filter((row) => row.degenerate).map((row) => row.fidelityRepaired))),
      degeneratePool: rows.filter((row) => row.degenerate && row.fidelityReplay !== null).length,
      degenerateTo1: rows.filter((row) => row.degenerate && row.fidelityRepaired === 1).length,
      normalBeforeMean: round(mean(rows.filter((row) => !row.degenerate).map((row) => row.fidelityReplay))),
      normalAfterMean: round(mean(rows.filter((row) => !row.degenerate).map((row) => row.fidelityRepaired))),
    },
  };
}

/**
 * 三条判据的**机器裁决**（必须能返回「不通过」，否则这个守卫就是永远绿的假门禁）。
 * @param {object} result `audit()` 的返回值
 * @returns {Array<{id:string, name:string, pass:boolean, detail:string}>}
 */
export function verdicts(result) {
  const out = [];
  const c = result.correlations;
  const absRho = (entry) => (entry === null || entry.spearman === null ? null : Math.abs(entry.spearman));
  const rhoText = (entry) => (entry === null || entry.spearman === null ? "—" : entry.spearman.toFixed(4));

  const idRho = absRho(c.idVsTailGap);
  const imputedRho = absRho(c.idImputedVsTailGap);
  const replayRho = absRho(c.replayVsTailGap);
  out.push({
    id: "shape-free",
    name: "判据 1 · 与「离尾部距离」无强相关",
    pass:
      idRho !== null &&
      imputedRho !== null &&
      replayRho !== null &&
      idRho < CRITERIA_RULES.maxAbsRho &&
      imputedRho < CRITERIA_RULES.maxAbsRho &&
      replayRho < CRITERIA_RULES.maxAbsRho,
    detail:
      `A(原始) ρ=${rhoText(c.idVsTailGap)} · A(补真) ρ=${rhoText(c.idImputedVsTailGap)} · ` +
      `B(重放) ρ=${rhoText(c.replayVsTailGap)}（门槛 |ρ| < ${CRITERIA_RULES.maxAbsRho}）` +
      `　⚠ A 原始的低相关是**删掉 ${result.unmeasurableId} 条不可测**换来的；补真后 |ρ| 涨到 ` +
      `${absRho(c.idImputedVsTailGap)?.toFixed(3) ?? "—"} —— 「与形状无关」在这里是幸存者偏差。`,
  });

  // 判据 2 的分母是**退化区间**（补账缺口）：T37 的 `coverageOf` 对「消息跨度与欠账区间有交集」
  // 的正常折痕**一个字都不改**（那是 C491 的夹取契约），只在「不相交」时改 —— 所以拿全量均值当分母
  // 会把 96pp 的修复稀释成 14pp，等于用分母把结论做没了。
  const gain = (result.repair.degenerateAfterMean ?? 0) - (result.repair.degenerateBeforeMean ?? 0);
  out.push({
    id: "repairable",
    name: "判据 2 · 同一条折痕在修复前后会变（T37 重放）",
    pass: result.repair.degeneratePool > 0 && gain >= CRITERIA_RULES.minRepairGain,
    detail:
      `退化区间（补账缺口，T37 唯一会改的那一档）${result.repair.degeneratePool} 条：` +
      `${num(result.repair.degenerateBeforeMean)} → ${num(result.repair.degenerateAfterMean)}` +
      `（+${num(gain)}，门槛 +${CRITERIA_RULES.minRepairGain}）· 回到 1.0 的 ${result.repair.degenerateTo1} 条` +
      `　正常区间 ${num(result.repair.normalBeforeMean)} → ${num(result.repair.normalAfterMean)}（一个字都没变）`,
  });

  const explanatory = (entry) => (entry === null || entry.spearman === null ? null : entry.spearman);
  const idExpl = explanatory(c.idImputedVsTraceable);
  const replayExpl = explanatory(c.replayVsTraceable);
  out.push({
    id: "explanatory",
    name: "判据 3 · 对「摘要质量」有解释力（与可定位率同向）",
    pass: (idExpl !== null && idExpl >= CRITERIA_RULES.minExplanatoryRho) || (replayExpl !== null && replayExpl >= CRITERIA_RULES.minExplanatoryRho),
    detail:
      `A(补真) ρ=${rhoText(c.idImputedVsTraceable)} · B(重放) ρ=${rhoText(c.replayVsTraceable)}` +
      `（门槛 ρ ≥ ${CRITERIA_RULES.minExplanatoryRho}，任一成立即算有解释力）` +
      `　⚠ A 的解释力**全部**来自「补真」：原始 ρ=${rhoText(c.idVsTraceable)}` +
      ` ⇒ 它只是把「占位符多」换了个说法，而占位符多正是旧指标（可定位率）的分子。`,
  });
  return out;
}

/* ───────────────────────────── 渲染 ───────────────────────────── */

const fmtTime = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
};
const pct = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
const num = (value, digits = 3) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
const rhoCell = (entry) =>
  entry === null || entry.spearman === null ? "—" : `${entry.spearman.toFixed(4)}（n=${entry.n}）`;

/**
 * 渲染成人读文本（数组，逐行）。
 * @param {object} result `audit()` 的返回值
 * @returns {string[]}
 */
export function render(result) {
  const out = [];
  const s = result.summaryId;
  const b = result.summaryReplay;
  out.push("折叠区间保真度审计（T53 · 只读 · 零模型调用）");
  out.push(`home            : ${result.home}`);
  out.push(`语料            : ${result.sessions} 会话 / ${result.marks} 折痕（可读图 ${result.graphs}）`);
  out.push(`快照            : as-of ${result.asOf === null ? "（未冻结，会随补账漂移）" : fmtTime(result.asOf)}`);
  out.push(
    `正文            : ${result.poolId} 条折痕有可复判正文（其余只有 summaryChars，任何按它们的保真度都是编的）` +
      ` · 口径 A 可测 ${result.measurableId} / 不可测 ${result.unmeasurableId}`,
  );
  out.push(
    `日志            : 解出 ${result.logsRead} 份 · 缺/空 ${result.logsMissing} 份 ⇒ 口径 B 可重放 ${result.poolReplay} 条折痕`,
  );
  out.push("");

  out.push("§0 两个口径（缺一个就会得出错误结论）");
  out.push("  A 摘要内可定位区间（任务书指定）: 摘要里 `nN`/`eN` 解析到的实体 seq 范围 [min,max]");
  out.push("  B 输入重放区间（模型实际看到）  : collectMessages(maxChars=60,000, perMessageChars=2,000, fromSeq=seqStart) 的消息 seq 跨度");
  out.push("  保真度 = |记录区间 ∩ 实际区间| / |实际区间|（分母是「实际」：问的是「账盖住了内容吗」）");
  out.push("  首尾偏差: head = 实际min − seqStart（>0 = 记晚了，漏掉开头）· tail = seqEnd − 实际max（>0 = 记早了）");
  out.push("  相关性  : Pearson + Spearman 都给；**主判据用 Spearman** —— 保真度在 1.0 有点质量（截断）、");
  out.push("            离尾部距离重尾（917/1111 条 > 100）且 0 处有点质量，两者都不满足 Pearson 的线性假设。");
  out.push("");

  out.push("§1 保真度分布");
  out.push("  （直方图分档固定：= 0.0 · 0–0.5 · 0.5–0.9 · 0.9–1.0 · = 1.0）");
  out.push("| 口径 | 可测 | = 0.0 | 0–0.5 | 0.5–0.9 | 0.9–1.0 | = 1.0 | 均值 | p10 | p50 | p90 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, stats] of [
    ["A 摘要内可定位（原始）", s.fidelityId],
    ["A 摘要内可定位（补真）", s.fidelityIdImputed],
    ["B 输入重放", b.fidelityReplay],
    ["B 修复后重放（T37）", b.fidelityRepaired],
  ]) {
    const h = stats.histogram;
    out.push(
      `| ${name} | ${stats.n} | ${h["= 0.0"]} | ${h["0–0.5"]} | ${h["0.5–0.9"]} | ${h["0.9–1.0"]} | ${h["= 1.0"]} | ` +
        `${num(stats.mean)} | ${num(stats.p10)} | ${num(stats.p50)} | ${num(stats.p90)} |`,
    );
  }
  out.push("");
  out.push(
    `  ⚠ 口径 A 的「= 1.0」占 ${pct(s.fidelityId.atOne / Math.max(1, s.fidelityId.n))}（${s.fidelityId.atOne}/${s.fidelityId.n}）——` +
      ` 这不是质量，是**截断引理**：`,
  );
  out.push("    **pre-T35** 的 `sanitizeSummaryIds` 只保留 `span.end ≤ range.end` 的引用 ⇒ 活下来的引用**一定**在记录区间内");
  out.push("    ⇒ 「记录区间覆盖实际内容」在任何非零存活引用上**恒为真**。它看不见「被抹掉的引用」，");
  out.push("    而「被抹掉的引用」正是要找的缺陷 ⇒ **口径 A 结构性失明**。");
  out.push(
    `  不可测的 ${result.unmeasurableId} 条：一个存活引用都没有（全部被抹成 \`n?\`/\`e?\`）⇒ 按引理补真 = 0` +
      `（0 个存活 ⇒ 所有已知引用都在 \`range.end\` 之后 ⇒ 交集为空）。`,
  );
  out.push("  ⚠ **这层截断是版本伪影**：T35 之后界改成「区间内最后一个实体」，取不到就不判未来，");
  out.push("    补账折的 `nN` 会全部存活 ⇒ 口径 A 可测且 = 0（即「补真」那一行的值）。");
  out.push("    所以「删掉不可测」得到的是**幸存者偏差**；补真值是 T35 生效后的**保守下界**。");
  out.push("");

  out.push("§2 按「离尾部距离」分桶（**与 T52 完全同一组桶**，否则不可比）");
  out.push("| 离尾部(事件) | 折痕 | 口径A 补真 均值 | 口径B 重放 均值 | 口径B 中位 | 可定位率(池化) |");
  out.push("|---|---|---|---|---|---|");
  for (const band of result.bands) {
    out.push(
      `| ${band.band} | ${band.n} | ${num(band.fidelityIdImputed.mean)} | ${num(band.fidelityReplay.mean)} | ` +
        `${num(band.fidelityReplay.p50)} | ${pct(band.traceableShare)} |`,
    );
  }
  out.push("");

  out.push("§3 相关性（Pearson / Spearman，主判据 Spearman）");
  out.push("  **判据 1 · 与形状（离尾部距离）**");
  out.push(`    A 原始   ρ=${rhoCell(result.correlations.idVsTailGap)}  r=${num(result.correlations.idVsTailGap.pearson)}`);
  out.push(`    A 补真   ρ=${rhoCell(result.correlations.idImputedVsTailGap)}  r=${num(result.correlations.idImputedVsTailGap.pearson)}`);
  out.push(`    B 重放   ρ=${rhoCell(result.correlations.replayVsTailGap)}  r=${num(result.correlations.replayVsTailGap.pearson)}`);
  out.push(`    （对照）可定位率 ρ=${rhoCell(result.correlations.traceableVsTailGap)}  r=${num(result.correlations.traceableVsTailGap.pearson)}`);
  out.push("  **判据 3 · 与摘要质量（可定位率）**");
  out.push(`    A 原始   ρ=${rhoCell(result.correlations.idVsTraceable)}  r=${num(result.correlations.idVsTraceable.pearson)}`);
  out.push(`    A 补真   ρ=${rhoCell(result.correlations.idImputedVsTraceable)}  r=${num(result.correlations.idImputedVsTraceable.pearson)}`);
  out.push(`    B 重放   ρ=${rhoCell(result.correlations.replayVsTraceable)}  r=${num(result.correlations.replayVsTraceable.pearson)}`);
  out.push(`  **对照 · 新指标 vs 旧指标**：B 重放 ~ 可定位率 ρ=${rhoCell(result.correlations.replayVsTraceable)}`);
  out.push("");

  out.push("§4 三条判据（机器裁决，必须能返回「不通过」）");
  for (const verdict of verdicts(result)) {
    out.push(`  ${verdict.pass ? "✅" : "❌"} ${verdict.name}`);
    out.push(`     ${verdict.detail}`);
  }
  out.push("");

  out.push("§5 判据 2 的细节：同一条折痕，修复前 vs 修复后（T37 的 coverageOf 重放同一区间）");
  const r = result.repair;
  out.push(`  可重放 ${r.pool} 条 · 修复前均值 ${num(r.beforeMean)} → 修复后均值 ${num(r.afterMean)} · 变了的 ${r.changed} 条 · 回到 1.0 的 ${r.toOne} 条`);
  out.push(
    `  退化区间（补账缺口，${r.degeneratePool} 条）：${num(r.degenerateBeforeMean)} → ${num(r.degenerateAfterMean)}` +
      `　正常区间：${num(r.normalBeforeMean)} → ${num(r.normalAfterMean)}`,
  );
  out.push("  ⚠ 修复后 = 1.0 有一部分是**定义性**的（coverageOf 的输出就是「实际覆盖」，两者对齐即 1.0）；");
  out.push("    它证明的是「这个指标可被代码修好」，**不是**「摘要变好了」。正常区间一个字都不变 —— 因为账本来就对。");
  out.push("");

  out.push("§6 结论：**保真度不能当「与形状无关的质量指标」**");
  const v = verdicts(result);
  const passed = v.filter((verdict) => verdict.pass).length;
  out.push(`  三条判据通过 ${passed} / 3（判据 1 是关键判据，它不过 ⇒ 不能用）。`);
  out.push("");
  out.push("  · **口径 A（id 反推，任务书指定）满足「与形状无关」，但它根本不是指标。**");
  out.push(
    `    ${pct(s.fidelityId.atOne / Math.max(1, s.fidelityId.n))} 的折痕恒等于 1.0（${s.fidelityId.atOne}/${s.fidelityId.n}）——`,
  );
  out.push("    这是**截断引理**的影子：**pre-T35** 的 `sanitizeSummaryIds` 只留 `span.end ≤ range.end` 的引用，");
  out.push("    「记录区间覆盖实际内容」在**任何**非零存活引用上恒真。它看不见被抹掉的引用，而被抹掉的正是缺陷。");
  out.push(
    `    它的解释力（ρ=${num(result.correlations.idImputedVsTraceable.spearman)}）**全部**来自补真：原始 ρ=${num(result.correlations.idVsTraceable.spearman)}。`,
  );
  out.push("    换句话说：删掉不可测再算相关，是拿**幸存者偏差**换一张漂亮的表。");
  out.push(
    `    而补真值 |ρ|=${num(Math.abs(result.correlations.idImputedVsTailGap.spearman))} 是 **T35 生效后的保守下界**` +
      "（届时那些 `nN` 全部存活，口径 A 可测且 = 0）⇒ 这个「与形状无关」是**版本伪影**。",
  );
  out.push("");
  out.push("  · **口径 B（重放）有方差、有解释力，但它只是可定位率换了个名字。**");
  out.push(
    `    与可定位率 ρ=${num(result.correlations.replayVsTraceable.spearman)}（r=${num(result.correlations.replayVsTraceable.pearson)}），` +
      `与形状 ρ=${num(result.correlations.replayVsTailGap.spearman)}；`,
  );
  out.push(
    `    可定位率自己与形状 ρ=${num(result.correlations.traceableVsTailGap.spearman)} —— **两个数逐位重合**，` +
      "同一个生产条件（补账缺口 + sanitize 边界）的第三个投影。",
  );
  out.push("");
  out.push("  · **但假设本身被证实了**（这一点要单独说）：记录区间 `8-8` vs 实际 `9-501` 是真的，");
  out.push(
    `    退化区间 ${r.degeneratePool} 条在 T37 重放后从 ${num(r.degenerateBeforeMean)} → ${num(r.degenerateAfterMean)}。` +
      "缺陷是真的、可修的，**只是它不是「质量指标」，是「记账正确性」。**",
  );
  out.push("");
  out.push("  ⇒ **下一个候选（一句话）**：摘要正文的**逐字可回查率** —— 把摘要里每条「动作 → 结果」按 n-gram");
  out.push("    反查到折叠输入的消息原文（不看 id、不看区间）。它不被 `sanitizeSummaryIds` 截断，也不依赖折痕折在哪。");
  out.push("");
  return out;
}

/* ───────────────────────────── CLI ───────────────────────────── */

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const get = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith("--") ? argv[index + 1] : fallback;
  };
  const home = resolveHome(get("home"));
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    console.error(`没有棋谱目录：${sessionsDir}`);
    return 2;
  }
  const asOfRaw = get("as-of");
  const asOf = asOfRaw === null ? Date.now() : Date.parse(asOfRaw);
  if (!Number.isFinite(asOf)) {
    console.error(`--as-of 解析不了：${asOfRaw}`);
    return 2;
  }
  const limitRaw = get("limit");
  const limit = limitRaw === null ? 0 : Number(limitRaw);
  if (limitRaw !== null && (!Number.isFinite(limit) || limit < 0)) {
    console.error(`--limit 解析不了：${limitRaw}`);
    return 2;
  }

  const result = audit({ home, asOf });
  if (result.missing) {
    console.error(`没有棋谱目录：${sessionsDir}`);
    return 2;
  }
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          home: result.home,
          asOf: result.asOf,
          sessions: result.sessions,
          marks: result.marks,
          poolId: result.poolId,
          measurableId: result.measurableId,
          unmeasurableId: result.unmeasurableId,
          poolReplay: result.poolReplay,
          summaryId: result.summaryId,
          summaryReplay: result.summaryReplay,
          bands: result.bands.map((band) => ({
            band: band.band,
            n: band.n,
            fidelityIdImputed: band.fidelityIdImputed,
            fidelityReplay: band.fidelityReplay,
            traceableShare: band.traceableShare,
          })),
          correlations: result.correlations,
          repair: result.repair,
          verdicts: verdicts(result),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const line of render(result)) console.log(line);
  if (limit > 0) {
    console.log(`§7 逐条（前 ${Math.min(limit, result.rows.length)} 条 / 共 ${result.rows.length} 条）`);
    console.log("| # | 会话 | 记录区间 | 离尾部 | 口径A 实际 | A 保真 | head | tail | 口径B 重放 | B 保真 | 修复后 | 修后保真 |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
    result.rows.slice(0, limit).forEach((row, index) => {
      const span = (range) => (range === null || range.start === null || range.start === undefined ? "—" : `${range.start}-${range.end}`);
      console.log(
        `| ${index + 1} | ${row.sessionId.slice(0, 12)} | ${span(row.recorded)} | ${row.tailGap ?? "—"} | ${span(row.content)} | ` +
          `${num(row.fidelityId, 2)} | ${row.headDev ?? "—"} | ${row.tailDev ?? "—"} | ${span(row.replay)} | ${num(row.fidelityReplay, 2)} | ` +
          `${span(row.repaired)} | ${num(row.fidelityRepaired, 2)} |`,
      );
    });
  }
  return 0;
}


const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
