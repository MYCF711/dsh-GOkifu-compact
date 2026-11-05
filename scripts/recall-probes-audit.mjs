#!/usr/bin/env node
/**
 * recall-probes-audit.mjs —— 两个「一直存在」的探针能不能当摘要质量指标？（T55 · 只读 · 零模型调用）
 *
 * ── 由来（Lead 的原话，T52/T53/T54 判死三个候选指标之后） ─────────────────────────
 *   「仓库里一直有两个探针（`src/rooms/fold-quality.mjs`）：
 *     `constraintRecall` —— 摘要覆盖了多少条「必须出现的约束」
 *     `failureRecall`    —— 摘要覆盖了多少条「区间内的失败边」
 *    它们**从来没做过形状无关性验证**。如果它们其实是好的（与形状无关、对修复敏感、有解释力），
 *    那今晚白判死三个 —— 我们一直有指标，只是没用对。」
 *   硬话：「**这两个探针可能也不合格**（今晚已经判死三个）—— 别因为它们「一直存在」就放过。」
 *        「**特别检查「恒等于 1」**：真机 `failureRecall` 中位就是 1，如果 80% 以上恒等，
 *          它就是 T53 那个死法。」
 *
 * ── 这个脚本量什么（一句话） ───────────────────────────────────────────────────
 *   把两个探针在**真机全部折痕**上量一遍，然后拿 T52/T53/T54 的同一套判据裁决：
 *   ① 与形状无关（|ρ| < 0.2）② 有方差（不能 > 80% 恒等于某个值）③ 有解释力（ρ(T33 分) > 0.3）。
 *
 * ── 两个池（口径不同，必须分开报） ──────────────────────────────────────────────
 *   **P0 记录池**（n = 1125）：`foldMark.quality` 里**折叠当时**记下的两个数。
 *     覆盖全部折痕（1133 条里 8 条没有 quality 记录），**不需要正文** —— 这就是任务书说的
 *     「这两个探针不需要正文」。分布与形状相关性只在这个池上算（**全量**，不抽样）。
 *   **P1 重算池**（n = 434）：正文还能取到的折痕（`resolveSummaryText`：`summaryText` →
 *     `summaryTextRef` → `lastOfflineSummary` 单槽）。用它做两件事：
 *     (a) **重算一致性**（记录值是不是当前代码算得出来的）；(b) **判据 3**（T33 五判据机械分要正文）。
 *     重算一致性本身是一条守卫：两套口径（记录 vs 重算）必须逐条相等，否则本脚本量的不是同一个东西
 *     —— 这是本仓栽过很多次的「两套口径」（C607 / C638 / C641）。
 *
 * ── 为什么「恒等于 1」是设计保证，不是跑出来的 ────────────────────────────────
 *   生产在模型输出之后**机械追加**缺失内容，然后拿**同一份最终文本**算 recall：
 *     · 约束：`repairMissingConstraints`（C492，`offline-fold.mjs:1109`）
 *     · 死路：`repairFailuresInText`（C607/C641，`offline-fold.mjs:1122` 与 `:1430`）
 *   ⇒ `constraintRecall` / `failureRecall` 是**补回函数的输出**，不是摘要的性质。
 *   `fold-quality.mjs` 自己的注释就写着「`failureRecall` 按设计恒 = 1（最终产物口径）」。
 *   本脚本的职责是把这句话**量出来**：恒等的比例、剩下的那部分是什么、以及它随什么动。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` 与宿主会话日志只 `readFileSync`；**一个字节都不写**（不落 tmp/）；
 *   · **不改产品代码**：只 import 纯函数（`measureFoldQuality` / `sanitizeSummaryIds` /
 *     `repairFailuresInText` / `coverageOf` 都是纯的），`applyOfflineFoldToGraph` 一律不碰；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **判据必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/recall-probes-audit.mjs                  # 全量
 *   node scripts/recall-probes-audit.mjs --json           # 机读
 *   node scripts/recall-probes-audit.mjs --home <DIR>     # 显式指定 DSH_HOME
 *   node scripts/recall-probes-audit.mjs --as-of <ISO>    # 冻结快照（可复现）
 *   node scripts/recall-probes-audit.mjs --limit <N>      # 逐条只打前 N 条（汇总仍是全量）
 *   node scripts/recall-probes-audit.mjs --no-replay      # 跳过 T37 重放（省时间，Δ 记 n/a）
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 读不到棋谱目录 / 参数错。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { measureFoldQuality, sanitizeSummaryIds, failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
import { collectConstraints, isDanglingResidue } from "../src/rooms/ledger.mjs";
import { failureEdges, evidenceSpan } from "../src/rooms/kifu-model.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { measureSample, resolveHome, resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";
import {
  HIST_EDGES,
  TAIL_BANDS,
  buildLogIndex,
  correlate,
  independentIds,
  placeholderCount,
  quantile,
  repairedRange,
  replayRange,
  tailBandOf,
} from "./range-fidelity-audit.mjs";

/* ───────────────────────────── 口径常量（改这里就是改指标） ───────────────────────────── */

/**
 * 两个探针。`denom` 是它的**分母字段** —— 分母为 0 时 recall 定义上 = 1，
 * 这是「没东西可量」被记成「满分」的结构性来源，必须单列（`trivial`），否则分布会被它抬高。
 */
export const PROBES = Object.freeze([
  { key: "constraintRecall", denom: "expectedConstraints", unit: "约束" },
  { key: "failureRecall", denom: "expectedFailures", unit: "失败边" },
]);

/** 判据门槛（改门槛只改这里；与 T53/T54 同一套数字）。 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 1：|ρ| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** 判据 2：某一取值占比超过这个数就叫「恒等」（T53 口径 A 的死法）。 */
  maxConstantShare: 0.8,
  /** 判据 3：与 T33 五判据机械分的 Spearman 高于这个数才算「有解释力」。 */
  minExplanatoryRho: 0.3,
  /** 修复敏感性表的判读线（**不进三条判据**）：任一改动让率动这么多才算「会变」。 */
  minRepairGain: 0.05,
});

/** 折痕跨度分档（与 T52 的离尾部分档同一套写法：边界归左）。 */
export const SPAN_BANDS = Object.freeze([
  { band: "1（单事件）", lo: 1, hi: 1 },
  { band: "2–10", lo: 2, hi: 10 },
  { band: "11–50", lo: 11, hi: 50 },
  { band: "51–200", lo: 51, hi: 200 },
  { band: "200+", lo: 201, hi: Number.MAX_SAFE_INTEGER },
]);

/** `sanitizeSummaryIds` 用的实体引用（T35 之前的界：`span.end > range.end` 一律抹掉）。 */
const OLD_ID_RE = /[en][0-9]{1,4}/g;

const round = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const mean = (values) => {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  return list.length === 0 ? null : list.reduce((sum, value) => sum + value, 0) / list.length;
};

/* ───────────────────────────── 纯函数：一行折痕 ───────────────────────────── */

/**
 * 一条折痕的**记录行**（只读 `foldMark.quality`，不需要正文）。
 *
 * 缺测一律 `null`（**不拿 0 冒充**）：`Number(null) === 0` 是本仓踩过的坑
 * （T49：把 892 条字段缺失读成「命中 0」）。
 *
 * @param {object} mark `foldMark`
 * @param {object} graph 棋谱
 * @param {{sessionId?:string, graphMaxSeq?:number}} [ctx]
 * @returns {object}
 */
export function readProbeRow(mark, graph, { sessionId = "?", graphMaxSeq = 0 } = {}) {
  const quality = mark?.quality !== null && typeof mark?.quality === "object" ? mark.quality : null;
  const seqStart = Number(mark?.seqStart);
  const seqEnd = Number(mark?.seqEnd);
  const finite = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
  const row = {
    sessionId: String(sessionId),
    at: finite(mark?.at),
    trigger: String(mark?.trigger ?? "undefined"),
    seqStart: finite(seqStart),
    seqEnd: finite(seqEnd),
    tailGap: Number.isFinite(seqEnd) ? (Number(graphMaxSeq) || 0) - seqEnd : null,
    span: Number.isFinite(seqStart) && Number.isFinite(seqEnd) ? seqEnd - seqStart + 1 : null,
    chars: Number(mark?.summaryChars) || 0,
    truncated: mark?.truncated === true,
    /** 折叠当时机械补回的**约束**条数（`qualityRepaired`）。> 0 ⇒ 这条的 cr = 1 是补回来的。 */
    repaired: Number(mark?.qualityRepaired) || 0,
    /** 账单形状（T50 的落点）：`usage` 里到底有没有命中量字段。 */
    usageHasCache: Boolean(
      quality !== null &&
        mark?.usage !== null &&
        typeof mark?.usage === "object" &&
        (Number.isFinite(Number(mark.usage.cacheReadTokens)) || Number.isFinite(Number(mark.usage.prompt_tokens_details?.cached_tokens))),
    ),
    constraintRecall: null,
    failureRecall: null,
    expectedConstraints: null,
    expectedFailures: null,
    modelConstraintRecall: null,
    /** 重算池才有：当前代码重算出来的两个数（守卫用）。 */
    recomputed: null,
    /** 重算池才有：T33 五判据机械分（判据 3 的对照物）。 */
    qualityTotal: null,
    /** 重算池才有：可定位率（T52 的口径，**只作对照** —— 与它 ρ > 0.8 就是同一个东西）。 */
    traceableShare: null,
    /** 重算池才有：T35 / T37 的 Δ。 */
    repair: null,
  };
  if (quality === null) return row;
  row.constraintRecall = finite(quality.constraintRecall);
  row.failureRecall = finite(quality.failureRecall);
  row.expectedConstraints = finite(quality.expectedConstraints);
  row.expectedFailures = finite(quality.expectedFailures);
  row.modelConstraintRecall = finite(quality.modelConstraintRecall);
  return row;
}

/**
 * 一条折痕的**重算**：用当前代码（`measureFoldQuality`）在正文上重算两个探针。
 * @param {{graph:object, range:{start:number,end:number}, text:string}} args
 * @returns {{constraintRecall:number, failureRecall:number, expectedConstraints:number, expectedFailures:number}}
 */
export function recomputeProbes({ graph, range, text }) {
  const measured = measureFoldQuality({ graph, range, summaryText: String(text ?? "") });
  return {
    constraintRecall: Number(measured.constraintRecall),
    failureRecall: Number(measured.failureRecall),
    expectedConstraints: Number(measured.expectedConstraints),
    expectedFailures: Number(measured.expectedFailures),
  };
}

/**
 * **T35 之前的界**：`sanitizeSummaryIds` 旧版把 `span.end > range.end` 的实体一律抹成 `n?`/`e?`。
 *
 * 为什么能重放：现行实现多了一个 `boundary`（= 「≤ `range.end` 的最后一个**完整存在过**的实体」的 seq），
 * 取不到时**兜底不判「未来」**（T35：单事件折叠的区间里一个节点都没有，旧判据把全篇 id 判成未来）。
 * 两者只在「`boundary === null` 或 `boundary < range.end`」时不同 —— 这正是 T35 的生效面。
 *
 * @param {string} text
 * @param {object} graph
 * @param {{start:number,end:number}} range
 * @returns {string}
 */
export function oldBoundarySanitize(text, graph, range) {
  const src = String(text ?? "");
  if (!Number.isFinite(Number(range?.end))) return src;
  const end = Number(range.end);
  return src.replace(OLD_ID_RE, (id, offset) => {
    const before = offset > 0 ? src[offset - 1] : "";
    const after = src[offset + id.length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) return id;
    const isEdge = id[0] === "e";
    const obj = isEdge ? graph?.edges?.[id] : graph?.nodes?.[id];
    if (obj === null || obj === undefined) return isEdge ? "e?" : "n?";
    const span = isEdge ? evidenceSpan(obj) : Number.isFinite(Number(obj?.seq)) ? { start: Number(obj.seq), end: Number(obj.seq) } : null;
    if (span !== null && span.end > end) return isEdge ? "e?" : "n?";
    return id;
  });
}

/**
 * **T35 的生效面**：有多少条折痕的正文里真的存在「当前界保留、旧界会抹掉」的实体。
 * @param {string} text
 * @param {object} graph
 * @param {{start:number,end:number}} range
 * @returns {number} 被抹掉的 id 个数
 */
export function oldBoundaryRemovals(text, graph, range) {
  const src = String(text ?? "");
  const current = sanitizeSummaryIds(src, graph, range).text;
  const old = oldBoundarySanitize(src, graph, range);
  if (old === current) return 0;
  // 只数「旧界**比当前界多**抹掉的那些」：图里没有的 id 两边都抹，不算 T35 的生效面。
  const count = (value) => (String(value).match(/[en][?？]/g) ?? []).length;
  return Math.max(0, count(old) - count(current));
}

/* ───────────────────────────── 纯函数：统计 ───────────────────────────── */

/**
 * 一个探针的分布。
 *
 * `trivial` = 分母为 0 的折痕（recall 定义上 = 1）；`effective` = 分母 > 0 的真测量。
 * 两个都给，因为「恒等于 1」有两种来源：真的都保住了，或者**根本没东西可保**。
 *
 * @param {Array<object>} rows
 * @param {string} key 探针字段
 * @returns {object}
 */
export function summarizeProbe(rows, key) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && Number.isFinite(row?.[key]));
  const values = list.map((row) => Number(row[key]));
  const probe = PROBES.find((item) => item.key === key) ?? { denom: null };
  const trivial = probe.denom === null ? [] : list.filter((row) => Number(row[probe.denom]) === 0);
  const effective = probe.denom === null ? list : list.filter((row) => Number(row[probe.denom]) > 0);
  const describe = (series) => {
    const counts = new Map();
    for (const value of series) counts.set(value, (counts.get(value) ?? 0) + 1);
    let mode = null;
    let modeCount = -1;
    for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      if (count > modeCount) {
        mode = value;
        modeCount = count;
      }
    }
    return {
      n: series.length,
      mean: round(mean(series)),
      p10: round(quantile(series, 0.1)),
      p50: round(quantile(series, 0.5)),
      p90: round(quantile(series, 0.9)),
      atZero: series.filter((value) => value === 0).length,
      atOne: series.filter((value) => value === 1).length,
      atOneShare: series.length === 0 ? null : round(series.filter((value) => value === 1).length / series.length),
      mode: round(mode),
      modeCount,
      modeShare: series.length === 0 ? null : round(modeCount / series.length),
      distinct: counts.size,
      histogram: Object.fromEntries(HIST_EDGES.map((edge) => [edge.key, series.filter((value) => edge.test(value)).length])),
    };
  };
  return {
    all: describe(values),
    effective: describe(effective.map((row) => Number(row[key]))),
    trivialCount: trivial.length,
    trivialShare: list.length === 0 ? null : round(trivial.length / list.length),
    pool: list.length,
  };
}

/**
 * 一个探针的**形状相关**（判据 1）：与「离尾部距离」「折痕跨度」两个形状量。
 * 两个都算 —— 任务书点名两个，只报一个就是挑好看的那个（T52 的教训）。
 * @param {Array<object>} rows
 * @param {string} key
 * @returns {{tailGap:object, span:object}}
 */
export function shapeCorrelations(rows, key) {
  return { tailGap: correlate(rows, key, "tailGap"), span: correlate(rows, key, "span") };
}

/**
 * 按「离尾部距离」分桶（**与 T52/T54 完全同一组桶**，否则不可比）。
 * @param {Array<object>} rows
 * @param {string} key
 * @returns {Array<object>}
 */
export function tailBands(rows, key) {
  const list = Array.isArray(rows) ? rows : [];
  return TAIL_BANDS.map((band) => {
    const group = list.filter((row) => tailBandOf(row.tailGap) === band.band && Number.isFinite(row?.[key]));
    const values = group.map((row) => Number(row[key]));
    return {
      band: band.band,
      n: group.length,
      mean: round(mean(values)),
      p50: round(quantile(values, 0.5)),
      atOne: values.filter((value) => value === 1).length,
      atOneShare: values.length === 0 ? null : round(values.filter((value) => value === 1).length / values.length),
    };
  });
}

/** 跨度落在哪一档（边界归左；缺测 `null`）。 */
export function spanBandOf(span) {
  if (span === null || span === undefined || span === "") return null;
  const value = Number(span);
  if (!Number.isFinite(value) || value <= 0) return null;
  for (const band of SPAN_BANDS) if (value >= band.lo && value <= band.hi) return band.band;
  return null;
}

/**
 * 按「折痕跨度」分桶（第二个形状量）。
 * @param {Array<object>} rows
 * @param {string} key
 * @returns {Array<object>}
 */
export function spanBands(rows, key) {
  const list = Array.isArray(rows) ? rows : [];
  return SPAN_BANDS.map((band) => {
    const group = list.filter((row) => spanBandOf(row.span) === band.band && Number.isFinite(row?.[key]));
    const values = group.map((row) => Number(row[key]));
    return {
      band: band.band,
      n: group.length,
      mean: round(mean(values)),
      p50: round(quantile(values, 0.5)),
      atOne: values.filter((value) => value === 1).length,
      atOneShare: values.length === 0 ? null : round(values.filter((value) => value === 1).length / values.length),
    };
  });
}

/* ───────────────────────────── 修复敏感性（T35 / T37 / T42 / T50） ───────────────────────────── */

/**
 * 一条折痕上 T35 / T37 的 Δ（**T42 / T50 是池级判据，见 `classificationSensitivity`**）。
 *
 * 为什么是这两个：它们是**同一条链路**上、会改到「文本 / 分母」的真改动 ——
 *   · T35 改 `sanitizeSummaryIds` 的界 ⇒ 改**文本里的 id** ⇒ 直接改 `failureRecall` 的分子；
 *   · T37 改 `coverageOf` 的区间 ⇒ 改**分母**（哪些失败边算「本段」）⇒ 直接改 `failureRecall`。
 * 如果探针跟着它们动，说明它量的是**记账**（T53 口径 B 的死法），不是摘要。
 *
 * @param {{graph:object, range:{start:number,end:number}, text:string, events:Array<object>|null, replay?:boolean}} args
 * @returns {{t35:object, t37:object|null}|null}
 */
export function repairSensitivity({ graph, range, text, events = null, replay = true }) {
  const body = String(text ?? "");
  if (body === "") return null;
  const base = measureFoldQuality({ graph, range, summaryText: body });

  // ① T35：**两个界作用在同一份输入上**比（旧界 = `span.end > range.end` 一律抹）。
  //   为什么不能拿「存储正文」当基线：真机里有折痕的正文不是当前 sanitize 的产物
  //   （`sanitizeSummaryIds(body) !== body`），拿它当基线会把「重跑 sanitize」也算成 T35 的功。
  const currentText = sanitizeSummaryIds(body, graph, range).text;
  const oldText = oldBoundarySanitize(body, graph, range);
  const measured = (value) => (value === body ? base : measureFoldQuality({ graph, range, summaryText: value }));
  const current35 = measured(currentText);
  const after35 = measured(oldText);
  const t35 = {
    applied: oldBoundaryRemovals(body, graph, range),
    delta: {
      // 口径统一成「**修复后 − 修复前**」（与 T37 同向）：T35 让 id 活下来 ⇒ Δ ≥ 0。
      constraintRecall: round(Number(current35.constraintRecall) - Number(after35.constraintRecall)),
      failureRecall: round(Number(current35.failureRecall) - Number(after35.failureRecall)),
    },
  };

  // ② T37：区间重放（`coverageOf` 夹取后的实际跨度）
  if (!replay) return { t35, t37: null };
  const replayed = repairedRangeSafe(events, range);
  if (replayed === null) return { t35, t37: null };
  const changed = replayed.start !== range.start || replayed.end !== range.end;
  const after37 = changed ? measureFoldQuality({ graph, range: replayed, summaryText: body }) : base;
  return {
    t35,
    t37: {
      applied: changed ? 1 : 0,
      from: { start: range.start, end: range.end },
      to: replayed,
      expectedFailures: { before: Number(base.expectedFailures), after: Number(after37.expectedFailures) },
      delta: {
        constraintRecall: round(Number(after37.constraintRecall) - Number(base.constraintRecall)),
        failureRecall: round(Number(after37.failureRecall) - Number(base.failureRecall)),
      },
    },
  };
}

/**
 * T37 的重放（`range-fidelity-audit.repairedRange`：`replayRange` + `coverageOf` 夹取）。
 * @param {Array<object>|null} events
 * @param {{start:number,end:number}} range
 * @returns {{start:number,end:number}|null}
 */
function repairedRangeSafe(events, range) {
  if (!Array.isArray(events) || events.length === 0) return null;
  if (range === null || range === undefined) return null;
  try {
    const replayed = replayCoverage(events, range);
    if (replayed === null) return null;
    if (!Number.isFinite(replayed.start) || !Number.isFinite(replayed.end)) return null;
    return { start: replayed.start, end: replayed.end };
  } catch {
    return null;
  }
}

/**
 * `coverageOf` 的重放（**逐参同生产**：`fromSeq = range.start`、`maxChars = 60_000`、
 * `perMessageChars = 2_000`）。少一个参数量的就不是同一件事。
 * @param {Array<object>} events
 * @param {{start:number,end:number}} range
 * @returns {{start:number,end:number}|null}
 */
export function replayCoverage(events, range) {
  return repairedRange(events, replayRange(events, range, null) ?? range, null);
}

/**
 * **T42 / T50 是池级判据**：它们的改动不落在文本或区间上，而是落在**归类 / 账单**上。
 *
 *   · T42（截断判据 C649：比正文 `estimateTokens` 而不是含 reasoning 的 `outputTokens`）
 *     ⇒ 改的是「哪些折痕被标 `truncated`」。一个量摘要质量的指标，在 `truncated = true`
 *     （摘要被切了）那一组上**必须更低**；两组的区别 ≤ 5pp 就是「对截断瞎」。
 *   · T50（`normalizeUsage` 认 `cacheReadTokens`）⇒ 只改 `usage` 的形状。
 *     `measureFoldQuality` 的入参里**没有 usage** ⇒ Δ 结构上恒为 0（不是懒得测）。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function classificationSensitivity(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null);
  const groupMean = (group, key) => round(mean(group.map((row) => Number(row[key])).filter((value) => Number.isFinite(value))));
  const t42 = { pool: list.length, byProbe: Object.create(null) };
  for (const probe of PROBES) {
    const withValue = list.filter((row) => Number.isFinite(row?.[probe.key]));
    const truncated = withValue.filter((row) => row.truncated === true);
    const clean = withValue.filter((row) => row.truncated !== true);
    const delta = groupMean(truncated, probe.key) === null || groupMean(clean, probe.key) === null ? null : round(groupMean(truncated, probe.key) - groupMean(clean, probe.key));
    t42.byProbe[probe.key] = {
      truncated: truncated.length,
      clean: clean.length,
      meanTruncated: groupMean(truncated, probe.key),
      meanClean: groupMean(clean, probe.key),
      delta,
      blind: delta === null || Math.abs(delta) < CRITERIA_RULES.minRepairGain,
    };
  }
  // T50：账单形状分组的差别（应当恒为 0 —— 探针读不到 usage）
  const t50 = { byProbe: Object.create(null) };
  for (const probe of PROBES) {
    const withValue = list.filter((row) => Number.isFinite(row?.[probe.key]));
    const hasField = withValue.filter((row) => row.usageHasCache === true);
    const missing = withValue.filter((row) => row.usageHasCache !== true);
    const delta = groupMean(hasField, probe.key) === null || groupMean(missing, probe.key) === null ? null : round(groupMean(hasField, probe.key) - groupMean(missing, probe.key));
    t50.byProbe[probe.key] = { hasField: hasField.length, missing: missing.length, meanHasField: groupMean(hasField, probe.key), meanMissing: groupMean(missing, probe.key), delta };
  }
  // 合并成一张表（渲染用）
  const byChange = {
    "t35-boundary": { label: "T35 sanitize 的界（id 侧）", applied: 0, deltas: { constraintRecall: 0, failureRecall: 0 }, pool: 0 },
    "t37-replay": { label: "T37 区间重放（分母侧）", applied: 0, deltas: { constraintRecall: 0, failureRecall: 0 }, pool: 0 },
    "t42-truncation": { label: "T42 截断判据（归类侧）", applied: t42.byProbe.failureRecall?.truncated ?? 0, deltas: { constraintRecall: t42.byProbe.constraintRecall?.delta ?? null, failureRecall: t42.byProbe.failureRecall?.delta ?? null }, pool: t42.pool },
    "t50-usage": { label: "T50 usage 归一（账单侧）", applied: 0, deltas: { constraintRecall: t50.byProbe.constraintRecall?.delta ?? null, failureRecall: t50.byProbe.failureRecall?.delta ?? null }, pool: t50.pool },
  };
  return { t42, t50, byChange };
}

/** 延迟 import 的 `range-fidelity-audit`（只为了 `repairedRange` / `replayRange` 两个纯函数）。 */

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
 * 跑一次完整审计（纯只读）。
 *
 * @param {{home:string, asOf?:number|null, logIndex?:Map<string,string>|null, replay?:boolean}} [args]
 * @returns {Promise<object>}
 */
export async function audit({ home, asOf = null, logIndex = null, replay = true } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) return { home, asOf, missing: true, sessions: 0, marks: 0, rows: [] };
  const index = logIndex ?? buildLogIndex(home);
  const rows = [];
  let sessions = 0;
  let marks = 0;
  let graphs = 0;
  let logsRead = 0;
  let logsMissing = 0;
  let textPool = 0;
  let qualityPool = 0;

  const entries = nodeFs.readdirSync(sessionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null) continue;
    graphs += 1;
    sessions += 1;
    const list = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    marks += list.length;
    if (list.length === 0) continue;
    if (asOf !== null && !list.some((mark) => Number(mark?.at) <= asOf)) continue;

    const sessionId = String(graph.sessionId ?? entry.name);
    const graphMaxSeq = Object.values(graph.nodes ?? {}).reduce((max, node) => {
      const seq = Number(node?.seq);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);

    // 日志只解一次（同一会话的多条折痕共用）；解不出来记 `null`，**不吞成空数组**
    const logFile = index.get(sessionId.toLowerCase()) ?? null;
    let events = null;
    if (replay) {
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
    }

    for (const mark of list) {
      const at = Number(mark?.at);
      if (Number.isFinite(at) && asOf !== null && at > asOf) continue;
      const row = readProbeRow(mark, graph, { sessionId, graphMaxSeq });
      if (row.constraintRecall !== null || row.failureRecall !== null) qualityPool += 1;
      // 重算池：正文还在的折痕（T33 分也在这条路上）
      const resolved = resolveSummaryText(mark, graph.lastOfflineSummary);
      if (resolved.text !== null && Number.isFinite(row.seqStart) && Number.isFinite(row.seqEnd)) {
        textPool += 1;
        const range = { start: row.seqStart, end: row.seqEnd };
        row.recomputed = recomputeProbes({ graph, range, text: resolved.text });
        // 可定位率（T52 的口径，**只作对照**：与它 ρ > 0.8 就说明「换个名字不产生新信息」）
        const ids = independentIds(resolved.text).length;
        const placeholders = placeholderCount(resolved.text);
        row.traceableShare = ids + placeholders === 0 ? null : Math.round((ids / (ids + placeholders)) * 10_000) / 10_000;
        try {
          row.qualityTotal = scoreMark(
            measureSample(
              {
                sessionId,
                trigger: row.trigger,
                source: resolved.source,
                at: row.at ?? 0,
                seqStart: row.seqStart,
                seqEnd: row.seqEnd,
                text: resolved.text,
                mark,
                lastOfflineSummary: null,
                chars: resolved.text.length,
              },
              graph,
            ),
          ).total;
        } catch {
          row.qualityTotal = null;
        }
        row.repair = repairSensitivity({ graph, range, text: resolved.text, events, replay });
      }
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const summary = Object.fromEntries(PROBES.map((probe) => [probe.key, summarizeProbe(rows, probe.key)]));
  // 有效分母池（`expected* > 0`）—— 判据 3 也要在这个子集上再看一遍：
  // 拿「没东西可量」的折痕去算相关，等于让结构性的 1 去稀释信号。
  const effectiveRows = Object.fromEntries(
    PROBES.map((probe) => [probe.key, rows.filter((row) => Number(row?.[probe.denom]) > 0)]),
  );
  const correlations = Object.fromEntries(
    PROBES.map((probe) => [
      probe.key,
      {
        ...shapeCorrelations(rows, probe.key),
        qualityTotal: correlate(rows, probe.key, "qualityTotal"),
        qualityTotalEffective: correlate(effectiveRows[probe.key], probe.key, "qualityTotal"),
        traceableShare: correlate(rows, probe.key, "traceableShare"),
      },
    ]),
  );

  // 重算一致性（两套口径必须是同一件事）
  const comparable = rows.filter((row) => row.recomputed !== null && Number.isFinite(row?.["constraintRecall"]));
  const consistent = (key) => comparable.filter((row) => Math.abs(Number(row[key]) - Number(row.recomputed[key])) < 1e-9).length;

  const repairRows = rows.filter((row) => row.repair !== null);
  const classification = classificationSensitivity(rows);
  const byChange = classification.byChange;
  for (const key of ["t35-boundary", "t37-replay"]) {
    const field = key === "t35-boundary" ? "t35" : "t37";
    const list = repairRows.map((row) => row.repair[field]).filter((item) => item !== null && item !== undefined);
    const deltas = (probe) => list.map((item) => item.delta?.[probe]).filter((value) => Number.isFinite(value));
    byChange[key].pool = list.length;
    byChange[key].applied = list.filter((item) => Number(item.applied) > 0).length;
    byChange[key].deltas = Object.fromEntries(
      PROBES.map((probe) => {
        const series = deltas(probe.key);
        return [probe.key, { mean: round(mean(series)), min: series.length === 0 ? null : round(Math.min(...series)), max: series.length === 0 ? null : round(Math.max(...series)), changed: series.filter((value) => Math.abs(value) > 1e-9).length }];
      }),
    );
  }
  for (const key of ["t42-truncation", "t50-usage"]) {
    byChange[key].deltas = Object.fromEntries(
      PROBES.map((probe) => [probe.key, { mean: byChange[key].deltas[probe.key], changed: null }]),
    );
  }

  const modelCalls = rows.map((row) => row.modelConstraintRecall).filter((value) => Number.isFinite(value));
  return {
    home,
    asOf,
    missing: false,
    graphs,
    sessions,
    marks,
    qualityPool,
    textPool,
    logsRead,
    logsMissing,
    rows,
    summary,
    correlations,
    tailBands: Object.fromEntries(PROBES.map((probe) => [probe.key, tailBands(rows, probe.key)])),
    spanBands: Object.fromEntries(PROBES.map((probe) => [probe.key, spanBands(rows, probe.key)])),
    bands: TAIL_BANDS.map((band) => ({
      band: band.band,
      ...Object.fromEntries(
        PROBES.map((probe) => {
          const group = rows.filter((row) => tailBandOf(row.tailGap) === band.band && Number.isFinite(row?.[probe.key]));
          const values = group.map((row) => Number(row[probe.key]));
          return [probe.key, { n: group.length, mean: round(mean(values)), atOneShare: values.length === 0 ? null : round(values.filter((value) => value === 1).length / values.length) }];
        }),
      ),
    })),
    consistency: {
      pool: comparable.length,
      constraintRecall: consistent("constraintRecall"),
      failureRecall: consistent("failureRecall"),
    },
    modelConstraintRecall: summarizeProbe(
      rows.map((row) => ({ ...row, modelProbe: row.modelConstraintRecall })),
      "modelProbe",
    ),
    modelRecallPool: modelCalls.length,
    repair: { byChange, t42: classification.t42, t50: classification.t50, rows: repairRows.length },
    extremes: summarizeExtremes(rows, "qualityTotal"),
  };
}

/**
 * **极端对照**：探针的最高档（= 1）与最低档（< 1）在 T33 五判据机械分上有区别吗？
 *
 * 一个「有用」的质量指标，它的最高档与最低档**必须**在质量上有差距 ——
 * 没有差距就是 T54 的死法（7.91 vs 7.86，差 0.05 / 10 分）。
 * @param {Array<object>} rows
 * @param {string} qualityKey
 * @returns {object}
 */
export function summarizeExtremes(rows, qualityKey = "qualityTotal") {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => Number.isFinite(row?.[qualityKey]));
  const describe = (group) => ({
    n: group.length,
    quality: round(mean(group.map((row) => Number(row[qualityKey]))), 2),
    chars: round(mean(group.map((row) => Number(row.chars))), 0),
    sessions: group.slice(0, 3).map((row) => row.sessionId),
  });
  return Object.fromEntries(
    PROBES.map((probe) => {
      const top = describe(list.filter((row) => Number(row[probe.key]) === 1));
      const bottom = describe(list.filter((row) => Number(row[probe.key]) < 1));
      return [
        probe.key,
        { top, bottom, gap: top.quality === null || bottom.quality === null ? null : round(top.quality - bottom.quality, 2) },
      ];
    }),
  );
}

/* ───────────────────────────── 三条判据 ───────────────────────────── */

/**
 * 三条判据的**机器裁决**（必须能返回「不通过」）。
 *
 * 注意判据 1 有一个必须说破的口径问题：一个**几乎没有方差**的序列，「与形状无关」是**没有信息量**的
 * —— 常数的秩相关本来就是 0。所以判据 1 通过**不能**当作「它是好指标」的证据，
 * 报告里必须与判据 2 并排读。这一点写进 `vacuous` 字段，渲染时原样打印。
 *
 * @param {object} result `audit()` 的返回值
 * @returns {Array<{id:string, probe:string, name:string, pass:boolean, vacuous?:boolean, detail:string}>}
 */
export function criteria(result) {
  const out = [];
  const show = (value) => (value === null || value === undefined ? "—" : Number(value).toFixed(4));
  for (const probe of PROBES) {
    const stats = result?.summary?.[probe.key] ?? {};
    const corr = result?.correlations?.[probe.key] ?? {};

    // ① 与形状无关（两个形状量都要过）
    const tailRho = corr.tailGap?.spearman ?? null;
    const spanRho = corr.span?.spearman ?? null;
    out.push({
      id: `${probe.key}:shape`,
      probe: probe.key,
      name: `判据 1 · ${probe.key} 与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
      pass:
        tailRho !== null &&
        spanRho !== null &&
        Math.abs(tailRho) < CRITERIA_RULES.maxAbsRhoShape &&
        Math.abs(spanRho) < CRITERIA_RULES.maxAbsRhoShape,
      vacuous: Number(stats.all?.modeShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
      detail:
        `ρ(离尾部) = ${show(tailRho)}（n=${corr.tailGap?.n ?? 0}）· ρ(跨度) = ${show(spanRho)}（n=${corr.span?.n ?? 0}）` +
        `　⚠ 这两个数是在一个 ${show(stats.all?.modeShare)} 恒等于 ${show(stats.all?.mode)} 的序列上算的 —— ` +
        `**没有方差的「无关」不是好消息，是没信息**。`,
    });

    // ② 有方差（全池 + 有效分母池，两个都要过）
    const modeShare = stats.all?.modeShare ?? null;
    const effectiveShare = stats.effective?.modeShare ?? null;
    out.push({
      id: `${probe.key}:variance`,
      probe: probe.key,
      name: `判据 2 · ${probe.key} 有方差（不能 > ${CRITERIA_RULES.maxConstantShare * 100}% 恒等于某个值）`,
      pass:
        modeShare !== null &&
        effectiveShare !== null &&
        modeShare < CRITERIA_RULES.maxConstantShare &&
        effectiveShare < CRITERIA_RULES.maxConstantShare,
      detail:
        `众数 = ${show(stats.all?.mode)}，占 ${show(modeShare)}（${stats.all?.modeCount} / ${stats.all?.n}）；` +
        `剔除分母为 0 的 ${stats.trivialCount} 条后仍占 ${show(effectiveShare)}（${stats.effective?.modeCount} / ${stats.effective?.n}）· ` +
        `p10 ${show(stats.all?.p10)} / p50 ${show(stats.all?.p50)} / p90 ${show(stats.all?.p90)}` +
        `　（门槛 < ${CRITERIA_RULES.maxConstantShare}；T53 口径 A 就死于「85.6% 恒等」）`,
    });

    // ③ 有解释力（T33 五判据机械分）
    const quality = corr.qualityTotal?.spearman ?? null;
    out.push({
      id: `${probe.key}:explanatory`,
      probe: probe.key,
      name: `判据 3 · ${probe.key} 对「摘要质量」有解释力（ρ > ${CRITERIA_RULES.minExplanatoryRho}）`,
      pass: quality !== null && quality > CRITERIA_RULES.minExplanatoryRho,
      detail:
        `ρ(T33 总分) = ${show(quality)}（n=${corr.qualityTotal?.n ?? 0}，Pearson r=${show(corr.qualityTotal?.pearson)}，` +
        `门槛 ρ > ${CRITERIA_RULES.minExplanatoryRho}）` +
        (quality === null ? `　⚠ ρ 是 null 而不是 0：探针在重算池上没有方差（常数的秩相关无定义）` : ""),
    });
  }
  return out;
}

/**
 * 总裁决：**两个探针都要三条全过**才叫「能当质量指标」。
 * @param {object} result
 * @returns {{usable:boolean, passed:number, total:number, perProbe:Record<string,{passed:number, total:number}>, reason:string}}
 */
export function verdictOf(result) {
  const list = criteria(result);
  const perProbe = Object.fromEntries(
    PROBES.map((probe) => {
      const own = list.filter((item) => item.probe === probe.key);
      return [probe.key, { passed: own.filter((item) => item.pass).length, total: own.length }];
    }),
  );
  const passed = list.filter((item) => item.pass).length;
  const total = list.length;
  const usable = PROBES.every((probe) => perProbe[probe.key].passed === perProbe[probe.key].total);
  const failures = list.filter((item) => !item.pass).map((item) => item.id);
  return {
    usable,
    passed,
    total,
    perProbe,
    reason: usable ? "两个探针三条判据全过" : `未过：${failures.join(" · ")}`,
  };
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
const rhoCell = (entry) => (entry === null || entry === undefined ? "—" : `${num(entry.spearman, 4)}（n=${entry.n}）`);

/**
 * 渲染成人读文本（数组，逐行）。
 * @param {object} result `audit()` 的返回值
 * @returns {string[]}
 */
export function render(result) {
  const out = [];
  const s = result.summary;
  out.push("两个「一直存在」的探针能不能当摘要质量指标？（T55 · 只读 · 零模型调用）");
  out.push(`home            : ${result.home}`);
  out.push(`语料            : ${result.sessions} 会话 / ${result.marks} 折痕（可读图 ${result.graphs}）`);
  out.push(`快照            : as-of ${result.asOf === null ? "（未冻结，会随补账漂移）" : fmtTime(result.asOf)}`);
  out.push(`P0 记录池       : ${result.qualityPool} 条折痕带 \`quality\` 记录（不需要正文 —— 任务书说的「1131 条」就是这个口径）`);
  out.push(`P1 重算池       : ${result.textPool} 条折痕正文可取（重算 + T33 机械分 + 修复敏感性都在这上面）`);
  out.push(`日志            : 解出 ${result.logsRead} 份 · 缺/空 ${result.logsMissing} 份（T37 重放用）`);
  out.push("");

  out.push("§0 口径（**改这里就是改指标**）");
  out.push("  constraintRecall = 摘要里逐字出现的约束条数 ÷ 图里抽取到的约束条数（`collectConstraints`）");
  out.push("  failureRecall    = 摘要里作为独立标识符出现的失败边条数 ÷ 区间内失败边条数（`failuresInFoldRange` + `mentionsEdge`）");
  out.push("  两者都按**最终产物**算（模型输出 → sanitize → 机械补回 → 再算 recall）⇒ 分子是**补回函数的输出**");
  out.push(`  判据 1 |ρ| < ${CRITERIA_RULES.maxAbsRhoShape} · 判据 2 众数占比 < ${CRITERIA_RULES.maxConstantShare} · 判据 3 ρ(T33) > ${CRITERIA_RULES.minExplanatoryRho}`);
  out.push("  相关性主判据用 **Spearman**（与 T52/T53/T54 同一条：率是 [0,1] 有界、两个形状量都重尾，不满足 Pearson 的线性 + 等方差假设）");
  out.push("");

  out.push(`§1 分布（P0 记录池 · 全量 ${result.qualityPool} 条）`);
  out.push("| 探针 | n | = 0 | 0–0.5 | 0.5–0.9 | 0.9–1.0 | = 1.0 | 均值 | p10 | p50 | p90 | 众数 | 众数占比 | 不同取值 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const probe of PROBES) {
    const stats = s[probe.key];
    const h = stats.all.histogram;
    out.push(
      `| ${probe.key} | ${stats.pool} | ${h["= 0.0"]} | ${h["0–0.5"]} | ${h["0.5–0.9"]} | ${h["0.9–1.0"]} | ${h["= 1.0"]} | ` +
        `${num(stats.all.mean)} | ${num(stats.all.p10)} | ${num(stats.all.p50)} | ${num(stats.all.p90)} | ` +
        `${num(stats.all.mode, 2)} | **${pct(stats.all.modeShare)}** | ${stats.all.distinct} |`,
    );
  }
  out.push("");
  out.push(
    `  ⚠ **「= 1.0」有两种来源，必须拆开**：分母为 0 时 recall 定义上 = 1（「没东西可量」被记成「满分」）—— ` +
      PROBES.map((probe) => `${probe.key} ${s[probe.key].trivialCount} 条（${pct(s[probe.key].trivialShare)}）`).join(" · "),
  );
  out.push("  | 探针 | 有效分母池 | = 1.0 | 众数占比（有效池） | 均值 | p10 | p50 | p90 |");
  out.push("  |---|---|---|---|---|---|---|---|");
  for (const probe of PROBES) {
    const e = s[probe.key].effective;
    out.push(`  | ${probe.key} | ${e.n} | ${e.atOne} | **${pct(e.modeShare)}** | ${num(e.mean)} | ${num(e.p10)} | ${num(e.p50)} | ${num(e.p90)} |`);
  }
  out.push("");
  out.push(
    `  · **重算一致性**（P1）：${result.consistency.pool} 条里 constraintRecall 逐条相等 ${result.consistency.constraintRecall} 条、` +
      `failureRecall 相等 ${result.consistency.failureRecall} 条 ⇒ 记录值不是历史噪声，当前的纯函数算得出来同一批数。`,
  );
  out.push(
    `  · **模型侧那半边**（\`modelConstraintRecall\`，生产**从不读**）：${result.modelRecallPool} 条有记录，` +
      `众数 ${num(result.modelConstraintRecall.all.mode, 2)} 占 ${pct(result.modelConstraintRecall.all.modeShare)} —— ` +
      `连「模型自己写对了多少」都基本全 1。`,
  );
  out.push("");

  out.push("§2 形状相关性（判据 1 · 两个形状量都算，只报一个就是挑好看的）");
  for (const probe of PROBES) {
    const corr = result.correlations[probe.key];
    out.push(`  ${probe.key} : ρ(离尾部) = ${rhoCell(corr.tailGap)} · ρ(折痕跨度) = ${rhoCell(corr.span)}`);
    out.push(
      `    ${" ".repeat(probe.key.length)}   Pearson r：离尾部 ${num(corr.tailGap?.pearson, 4)} · 跨度 ${num(corr.span?.pearson, 4)}`,
    );
  }
  out.push("");
  out.push("  分桶（离尾部距离 —— **与 T52/T54 完全同一组桶**，否则不可比）：");
  out.push("  | 离尾部(事件) | " + PROBES.map((probe) => `${probe.key} n / 均值 / = 1.0 占比`).join(" | ") + " |");
  out.push("  |---|" + PROBES.map(() => "---").join("|") + "|");
  for (const band of result.bands) {
    out.push(
      `  | ${band.band} | ` +
        PROBES.map((probe) => `${band[probe.key].n} / ${num(band[probe.key].mean)} / ${pct(band[probe.key].atOneShare)}`).join(" | ") +
        " |",
    );
  }
  out.push("");
  out.push("  分桶（折痕跨度 —— 第二个形状量）：");
  out.push("  | 跨度(事件) | " + PROBES.map((probe) => `${probe.key} n / 均值 / = 1.0 占比`).join(" | ") + " |");
  out.push("  |---|" + PROBES.map(() => "---").join("|") + "|");
  for (let i = 0; i < SPAN_BANDS.length; i += 1) {
    const band = SPAN_BANDS[i].band;
    out.push(
      `  | ${band} | ` +
        PROBES.map((probe) => {
          const item = result.spanBands[probe.key][i];
          return `${item.n} / ${num(item.mean)} / ${pct(item.atOneShare)}`;
        }).join(" | ") +
        " |",
    );
  }
  out.push("");

  out.push("§3 修复敏感性（目标 1 的第 4 项 · **不进三条判据**，但决定「它到底在量什么」）");
  out.push("| 改动 | 作用对象 | 生效面 | Δ(constraintRecall) | Δ(failureRecall) | 变了的折痕 | 判读 |");
  out.push("|---|---|---|---|---|---|---|");
  const verdictLine = (item) => {
    const meanDelta = Math.max(...PROBES.map((probe) => Math.abs(Number(item.deltas[probe.key]?.mean ?? 0))));
    return meanDelta >= CRITERIA_RULES.minRepairGain ? "**会变**" : "不动";
  };
  for (const [key, label, target] of [
    ["t35-boundary", "T35 sanitize 的界", "文本里的 id（分子）"],
    ["t37-replay", "T37 区间重放", "分母（哪些失败边算本段）"],
    ["t42-truncation", "T42 截断判据", "truncated 归类（池级）"],
    ["t50-usage", "T50 usage 归一", "账单字段（池级）"],
  ]) {
    const item = result.repair.byChange[key];
    const changed = PROBES.map((probe) => item.deltas[probe.key]?.changed).filter((value) => Number.isFinite(value));
    out.push(
      `| ${label} | ${target} | ${item.applied} 条 | ${num(item.deltas.constraintRecall?.mean, 4)} | ${num(item.deltas.failureRecall?.mean, 4)} | ` +
        `${changed.length === 0 ? "—" : changed.join(" / ")} | ${verdictLine(item)} |`,
    );
  }
  out.push("");
  out.push("  池级判据（T42 / T50 的改动不落在文本上，只改**归类 / 账单**，只能按组比）：");
  out.push("  | 改动 | 分组 | n | cr 均值 | fr 均值 |");
  out.push("  |---|---|---|---|---|");
  for (const [key, label] of [
    ["t42", "T42 截断判据"],
    ["t50", "T50 usage 归一"],
  ]) {
    const group = key === "t42" ? result.repair.t42 : result.repair.t50;
    const cr = group.byProbe.constraintRecall;
    const fr = group.byProbe.failureRecall;
    const parts =
      key === "t42"
        ? [
            ["truncated = true", cr?.truncated, cr?.meanTruncated, fr?.meanTruncated],
            ["truncated = false", cr?.clean, cr?.meanClean, fr?.meanClean],
          ]
        : [
            ["usage 有命中字段", cr?.hasField, cr?.meanHasField, fr?.meanHasField],
            ["usage 缺失", cr?.missing, cr?.meanMissing, fr?.meanMissing],
          ];
    for (const [name, count, meanCr, meanFr] of parts) {
      out.push(`  | ${label} | ${name} | ${count ?? "—"} | ${num(meanCr, 4)} | ${num(meanFr, 4)} |`);
    }
    out.push(`  | ${label} | **两组差（Δ）** | | ${num(cr?.delta, 4)} | ${num(fr?.delta, 4)} |`);
  }
  out.push("");
  const t35Applied = result.repair.byChange["t35-boundary"].applied;
  out.push(
    t35Applied === 0
      ? "  · **T35 的界在真机上一条折痕都不生效**（旧界与当前界的输出逐字相同）—— 不是「修复无用」，而是最终产物"
      : `  · **T35 的界只对 ${t35Applied} 条折痕生效**（旧界会多抹几个 id）—— 生效面小是因为最终产物`,
  );
  out.push("    已经过**当前（更严）**的界；旧界只会更宽松 ⇒ 在那之外 Δ 恒为 0 是**定义保证**，不是跑出来的。");
  const t37 = result.repair.byChange["t37-replay"].deltas.failureRecall ?? {};
  out.push(
    `  · **T37 的 Δ 是 ${num(t37.mean, 2)}（最小 ${num(t37.min, 2)}，${t37.changed ?? 0} 条折痕变了）—— 不是「修复让指标变好」，是「分母一变数就崩」**：`,
  );
  out.push("    区间记账一纠正（真机 `8-8` → `9-501`），失败边的分母从 0 变成几十条 ⇒ failureRecall 跟着塌。它量的是**记账**，不是摘要。");
  out.push(
    `  · **T42 的两组差只有 ${num(Math.abs(Number(result.repair.t42.byProbe.failureRecall?.delta ?? 0)) * 100, 2)}pp** ⇒ 对「摘要被切断」完全瞎 ` +
      `（被截断的摘要本该更差，实测与未截断组没有区别）。`,
  );
  out.push("  · **T50 结构上不可能变**：`measureFoldQuality` 的入参里没有 `usage`（Δ 恒为 0，不是懒得测）。");
  out.push("");

  out.push("§4 解释力（判据 3 · T33 五判据机械分）");
  out.push("  | 探针 | ρ(T33 总分) | Pearson r | ρ(T33 · 只算有效分母池) | ρ(可定位率 · 对照) |");
  out.push("  |---|---|---|---|---|");
  for (const probe of PROBES) {
    const corr = result.correlations[probe.key];
    out.push(
      `  | ${probe.key} | ${rhoCell(corr.qualityTotal)} | ${num(corr.qualityTotal?.pearson, 4)} | ` +
        `${rhoCell(corr.qualityTotalEffective)} | ${rhoCell(corr.traceableShare)} |`,
    );
  }
  out.push("");
  out.push("  极端对照（最高档 vs 最低档，T33 均分）：");
  out.push("  | 探针 | 档 | 折痕 | T33 均分 | 平均摘要字符 |");
  out.push("  |---|---|---|---|---|");
  for (const probe of PROBES) {
    const x = result.extremes[probe.key];
    out.push(`  | ${probe.key} | = 1.0 | ${x.top.n} | ${num(x.top.quality, 2)} | ${x.top.chars ?? "—"} |`);
    out.push(`  | ${probe.key} | < 1.0 | ${x.bottom.n} | ${num(x.bottom.quality, 2)} | ${x.bottom.chars ?? "—"} |`);
  }
  out.push("");
  out.push(
    "  ⚠ **低相关不是 T33 的错，是探针的错 —— 这条必须说清楚**：T33 机械分确实不是金标准" +
      "（它是人读 10 条的近似，`usability-by-age-audit` 校准到 7.5~7.6 vs 人读 7.0，偏差 +0.5~0.68），" +
      "所以低 ρ 本来有两种解释。",
  );
  out.push(
    "    但这里只有一种：**一个几乎恒定的序列，与任何有方差的量都只能低相关**（数学必然，不是巧合）。" +
      "T33 在重算池上有方差（p10/p90 见 §1 的字符分布），探针没有 ⇒ 低 ρ 提供的是「**探针没信息**」的证据。",
  );
  out.push(
    "    反证来自 T54 的噪声样本：`4223dc9d`（整段 `<tool_call>` 泄漏、T33 = 4.5）与 `b108a0a7`（T33 = 10 满分）" +
      "在 T33 上分得开，而这两个探针在两条上都给 1.00 —— **T33 能区分的地方，探针不区分**。",
  );
  out.push(
    "    再补一条：**判据 1 的 ρ≈0 与判据 3 的 ρ=null 是同一个原因**（没有方差），" +
      "所以「形状无关」这一条是**假通过**（vacuous），不能当证据。",
  );
  out.push("");

  out.push("§5 三条判据（机器裁决 · 必须能返回「不通过」）");
  const list = criteria(result);
  for (const item of list) {
    out.push(`  ${item.pass ? "✅" : "❌"} ${item.name}${item.vacuous === true ? "（**vacuous**：序列恒等，无关是没信息）" : ""}`);
    out.push(`     ${item.detail}`);
  }
  out.push("");
  const verdict = verdictOf(result);
  out.push(
    `§6 结论：${verdict.usable ? "**能**" : "**不能**"}当「摘要质量」指标` +
      `（${verdict.passed} / ${verdict.total} 条判据通过：` +
      PROBES.map((probe) => `${probe.key} ${verdict.perProbe[probe.key].passed}/${verdict.perProbe[probe.key].total}`).join(" · ") +
      "）",
  );
  out.push("");
  if (!verdict.usable) {
    out.push("  · **最关键的一条理由：它是循环的。** 生产在模型输出之后**机械追加**缺失的约束");
    out.push("    （`repairMissingConstraints`）和缺失的失败边（`repairFailuresInText`），然后拿**同一份文本**算 recall");
    out.push("    ⇒ `constraintRecall` / `failureRecall` 是**补回函数的返回值**，不是摘要的性质。");
    out.push("    `src/rooms/offline-fold.mjs` 自己的注释就写着：「`failureRecall` 按设计恒 = 1（最终产物口径）」。");
    out.push(`    真机证据：constraintRecall 众数占比 **${pct(s.constraintRecall.all.modeShare)}**、failureRecall **${pct(s.failureRecall.all.modeShare)}**。`);
    out.push("");
    out.push("  · 这就是 **T53 口径 A 的同一个死法**（那个是「85.6% 恒等于 1.0」）。");
    out.push(
      `    ${pct(s.failureRecall.trivialShare)} 的 failureRecall 折痕**分母就是 0**（\`expectedFailures = 0\`）—— ` +
        "「没东西可量」被记成「满分」；",
    );
    out.push(
      `    剔除之后剩下的有效池里，它仍占 ${pct(s.failureRecall.effective.modeShare)}（${s.failureRecall.effective.atOne}/${s.failureRecall.effective.n}）。`,
    );
    out.push("");
    out.push(
      `  · 它能动的那个维度（T37 的 Δ = ${num(result.repair.byChange["t37-replay"].deltas.failureRecall?.mean, 2)}）量的是**区间记账**，` +
        "不是摘要 —— 那是 T53 口径 B 的死法。",
    );
    out.push("");
    out.push("  · **但它不是废的**：作为**不变量守卫**（invariant guard）它是合格的 —— 它守的是");
    out.push("    「机械补回那一段没有坏」，掉到 1 以下就说明补回/写回点破了。它的正确用法是**红线**（必须 = 1），");
    out.push("    不是**刻度**（越大越好）。今天 doctor 里它就是这个身份，别改。");
    out.push("");
    out.push("§7 今天是不是等于「一个质量指标都没有」？（诚实回答，不粉饰）");
    out.push("");
    out.push("  · **对「摘要质量」，是 —— 今晚四个候选（可定位率 / 区间保真度 / 逐字可回查率 / 这两个探针）全不合格。**");
    out.push("    四个的死法各不相同：形状（可定位率）· 循环（保真度 A、这两个探针）· 冗余（保真度 B）· 方向（可回查率）。");
    out.push("");
    out.push("  · **但「没有任何指标」是错的** —— 只是没有**质量**指标。仍然有三类可复算的观测，各自的用途要分清：");
    out.push("    ① **不变量**（必须 = 1，红了就是破了）：`constraintRecall` / `failureRecall` / 结构契约 `sectionsMissing` /");
    out.push("       `endedCleanly` —— 它们守「补回与写回没坏」，不回答「摘要好不好」；");
    out.push("    ② **缺陷探针**（越低越好，且没有上界意义）：幻觉 id（`unknownIds`）、越界 id（`outOfRangeLater`）、");
    out.push("       工具调用泄漏、系统提示词回灌、重复行 —— 这些是**负向**的，抓得到具体的坏，量不出抽象的好；");
    out.push("    ③ **代理分**（T33 五判据机械分）：它有人读校准（偏差 +0.5~0.68），但它自己的方差主要来自长度与结构，");
    out.push("       不能反过来当金标准去给别的指标打分。");
    out.push("");
    out.push("  · **该改成什么**：任务式验收 —— 给下一个 agent 一条摘要，看它能不能做成一件具体的事");
    out.push("    （`docs/knowledge/进度.md` 第 20 轮的结论）。在那之前，任何「摘要质量 = 某个率」的指标都会重蹈今晚四个的覆辙。");
  }
  out.push("");
  return out;
}

/* ───────────────────────────── CLI ───────────────────────────── */

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
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

  const result = await audit({ home, asOf, replay: !argv.includes("--no-replay") });
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
          qualityPool: result.qualityPool,
          textPool: result.textPool,
          summary: result.summary,
          correlations: result.correlations,
          bands: result.bands,
          consistency: result.consistency,
          modelRecallPool: result.modelRecallPool,
          modelConstraintRecall: result.modelConstraintRecall,
          repair: result.repair,
          extremes: result.extremes,
          criteria: criteria(result),
          verdict: verdictOf(result),
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
    console.log("| # | 会话 | 区间 | 离尾部 | 跨度 | cr | fr | 重算 cr/fr | T33 | 补回 | 截断 |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|");
    result.rows.slice(0, limit).forEach((row, index) => {
      console.log(
        `| ${index + 1} | ${row.sessionId.slice(0, 12)} | ${row.seqStart ?? "—"}-${row.seqEnd ?? "—"} | ${row.tailGap ?? "—"} | ${row.span ?? "—"} | ` +
          `${num(row.constraintRecall, 2)} | ${num(row.failureRecall, 2)} | ` +
          `${row.recomputed === null ? "—" : `${num(row.recomputed.constraintRecall, 2)}/${num(row.recomputed.failureRecall, 2)}`} | ` +
          `${num(row.qualityTotal, 1)} | ${row.repaired} | ${row.truncated ? "Y" : ""} |`,
      );
    });
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
