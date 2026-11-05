#!/usr/bin/env node
/**
 * small-window-audit.mjs —— 「小窗口折痕」审计：**每折一次都付整次模型调用**，而 1–8 个事件的窗口
 * 产出几乎没用的摘要（T63 · **只读**）
 *
 * ## 由来（真机，重启后新代码 `6bc782c3aabb` 跑起来立刻暴露）
 *
 * 离线折痕 1,011 条里，**180 条跨度 < 20**（17.8%）、**129 条 < 5**（12.8%）；p10 = 1 个事件。
 * 重启后头三条：`seq 8-13`（6 事件）· `seq 10-17`（8 事件）· `seq 2148-2148`（**1 事件**）。
 * 每一次都是一次完整模型调用（≈$0.008 + 15k 输入 token），而 T52 已证：
 * 1 事件跨度的**可定位率只有 2.3%**，241 事件的是 76.8%。
 *
 * ## 这个脚本要回答的四个问题（先证伪，别猜）
 *
 * ① **分布**：跨度分布到底长什么样？按 trigger / 按会话分，小窗口集中在哪？
 * ② **成因**：每个小窗口是**上一轮折完留下的尾巴**（缺口的残余）、**本来就有的空洞**，
 *    还是**抖动**（折了 1 个、又留 1 个，每轮都触发）？
 * ③ **抖动检测**：同一个会话里是否连续出现「紧接上一条折痕」的小窗口？
 *    （`seq 8-13` 之后又是 `10-17` —— 若同会话，就是**死循环**，优先级最高。）
 * ④ **白花的钱 + 质量对比**：小窗口折痕数 × 单次成本；小窗口 vs 大窗口的
 *    `constraintRecall` / 可定位率 / T33 五判据机械分。
 *
 * ## 关键判据（都是真函数，不另起一套）
 *
 * · **窗口**：`debtOfGraph`（`src/rooms/closeout-backfill.mjs`）—— 与引擎/面板/doctor 同源；
 * · **实际看到什么**：`runOfflineFold`（`src/rooms/offline-fold.mjs`）**原样调用**（假模型，不联网），
 *   于是「账上记的区间」与「模型真正读到的消息跨度」可以直接并排比 —— 这是 T37/T52 那条线的核心；
 * · **质量**：`measureSample` / `scoreMark`（T33 五判据机械分）+ 池化可定位率（`Σids/(Σids+Σn?)`）。
 *
 * ## 反事实重放（证明修法有效，而不是「看起来像修好了」）
 *
 * 对每个会话从**空图**开始重放折叠（假模型），两种窗口夹取各跑一遍：
 *   · `old`：`rangeEnd = min(maxSeq, gapEnd)`（C575 的原写法，当前生产代码）；
 *   · `new`：缺口本身**不够一次调用的门槛**（`gapEvents < closeoutMinEvents`）时**不夹取**
 *     —— 把缺口和它后面的尾巴**合并成一个窗口**（B：「小缺口本来就该折，但应该合并」）。
 * 输出两种口径下的**折痕数 / 小窗口数 / 重复折痕数 / 调用成本**。修法只在 `old → new` 上有效才算数。
 *
 * ## 边界
 *
 * **只读**：不写盘、不调模型（假模型返回固定字符串）、不 resume 任何会话。
 * 唯一的外部读是 `<home>/chess-context/sessions/**` 与 `<home>/sessions/**`。
 *
 * 用法：
 *   node scripts/small-window-audit.mjs                    # 默认 --home $DSH_HOME
 *   node scripts/small-window-audit.mjs --home "D:/DeepSeek Harness/home"
 *   node scripts/small-window-audit.mjs --small 20         # 「小窗口」阈值（默认 20）
 *   node scripts/small-window-audit.mjs --tiny 5           # 「极窄」阈值（默认 5）
 *   node scripts/small-window-audit.mjs --min 40           # 与 closeoutMinEvents 同义（默认 40）
 *   node scripts/small-window-audit.mjs --no-replay        # 跳过反事实重放（快）
 *   node scripts/small-window-audit.mjs --json             # 机读
 *
 * 退出码：0 正常；2 找不到图目录（没数据可审计，不是错误）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { debtOfGraph, closeoutSettles, DEFAULT_MIN_EVENTS } from "../src/rooms/closeout-backfill.mjs";
import { collectMessages, coverageOf, runOfflineFold, applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { estimateFoldCostUsd, priceForModel } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { resolveSummaryText, measureSample, resolveHome } from "./summary-usability-audit.mjs";
import { replayRange } from "./range-fidelity-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────── 常量（都是可核对的数，不是拍脑袋） ─────────────────────────── */

/** 「小窗口」阈值：跨度的 p10 就在这附近，且 T52 说 1–8 个事件的摘要几乎不可定位。 */
export const SMALL_SPAN = 20;
/** 「极窄」阈值：真机 129 条（12.8%）落在这里。 */
export const TINY_SPAN = 5;
/** 反事实重放的轮数上限（生产每 tick 最多 8 轮，见 C599）。 */
export const MAX_ROUNDS = 8;

/** `collectMessages` 认的可折事件（与 `src/rooms/offline-fold.mjs` 的过滤逐字同源）。 */
const FOLDABLE = new Set(["user/message", "assistant/message", "tool/call"]);

/* ─────────────────────────── 纯函数：事件 → 可折 seq ─────────────────────────── */

/**
 * 会话日志里**可折**的事件 seq（升序去重）。
 *
 * 为什么要单独算：折痕的 `seqStart/seqEnd` 是**事件序**，而 `collectMessages` 只把
 * `user/message` / `assistant/message` / `tool/call` 装进 prompt。中间那些
 * `session` / `step/start` / `sandbox/mode` 事件**没有可摘要内容** ——
 * `seq 1-8` 这种「窗口」里一条消息都没有，就是它们撑出来的。
 *
 * @param {Array<object>} events 会话日志
 * @returns {number[]}
 */
export function foldableSeqs(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object" || !FOLDABLE.has(e.type)) continue;
    const seq = Number(e.seq);
    if (Number.isFinite(seq)) out.push(seq);
  }
  out.sort((a, b) => a - b);
  return [...new Set(out)];
}

/**
 * 闭区间 `[start, end]` 里有多少条可折事件（二分，不逐条扫 —— 一条 9,968 事件的折痕也只要 2 次比较）。
 * @param {number[]} sorted 升序可折 seq
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
export function countIn(sorted, start, end) {
  const lo = (value) => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (sorted[mid] < value) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  const hi = (value) => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (sorted[mid] <= value) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  return Math.max(0, hi(end) - lo(start));
}

/* ─────────────────────────── 纯函数：一条折痕的成因 ─────────────────────────── */

/**
 * 一条小窗口折痕的**成因**（五选一 + `content`）。
 *
 * 判据（只在这些形状上分类，别的形状不进来）：
 *   · `content === 0` ⇒ 窗口里**一条可折事件都没有** —— 这不是「折得少」，是账上的**虚构窗口**
 *     （`uncoveredHead = start - rangeStart` 把 `session` / `step/start` 这类事件也算成缺口）；
 *     再按它相对上一条折痕的位置细分 `head-gap`（首折，区间从 1 起）/ `empty`（中间空洞）；
 *   · `content > 0` 且 `start <= prev.end` ⇒ **重复折叠**（同一段被摘了两次，T52 的可定位率被它拉低）；
 *   * `content > 0` 且 `start === prev.end + 1` ⇒ **抖动**（紧接上一条：每轮只折上一轮剩下的那点缺口）；
 *   · `content > 0` 且 `start > prev.end + 1` ⇒ **跳折**（中间隔着一串非消息事件）。
 *
 * @param {{start:number, end:number, prev:object|null, content:number}} input
 * @returns {"head-gap"|"empty"|"overlap"|"contiguous"|"jump"}
 */
export function classifyWindow({ start, end, prev, content }) {
  const prevEnd = prev === null || prev === undefined ? null : Number(prev.seqEnd);
  const hasPrev = Number.isFinite(prevEnd);
  if (content === 0) {
    if (!hasPrev) return "head-gap";
    return start <= prevEnd ? "head-gap" : "empty";
  }
  if (!hasPrev) return "head-gap";
  if (start <= prevEnd) return "overlap";
  if (start === prevEnd + 1) return "contiguous";
  return "jump";
}

/** 成因的中文名（报告用，一处定义）。 */
export const CAUSE_CN = {
  "head-gap": "首折头部缺口（窗口内 0 条可折事件）",
  empty: "中间空洞（窗口内 0 条可折事件）",
  overlap: "重复折叠（与上一条折痕重叠）",
  contiguous: "抖动（紧接上一条：每轮只折剩下的缺口）",
  jump: "跳折（中间是非消息事件）",
};

/* ─────────────────────────── 纯函数：抖动检测 ─────────────────────────── */

/**
 * 抖动的**机器判据**：同一会话里，连续两条折痕**首尾相接或重叠**（`next.seqStart <= prev.seqEnd + 1`）。
 *
 * 为什么这就是抖动：正常折叠是**向前推进**的（下一段从上一段的 `seqEnd + 1` 之后开始，且中间没有
 * 未折事件）；首尾相接意味着「上一轮折完之后，欠账游标只前进了一个缺口」——
 * 折的正是**上一轮自己留下的缺口**。一条会话里出现 ≥ 2 条这样的折痕，就是「折完又留尾巴」的循环。
 *
 * @param {Array<object>} marks 该会话的折痕（按 `at` / 追加顺序）
 * @param {{small?:number}} [options] 只把「任一条 < small」的连击算抖动（默认不过滤）
 * @returns {Array<{from:number, to:number, marks:number[], spans:number[]}>} 连击（下标区间，闭区间）
 */
export function jitterRuns(marks, { small = SMALL_SPAN } = {}) {
  const list = Array.isArray(marks) ? marks : [];
  // 两种入参都收：棋谱折痕（`seqStart/seqEnd`）与审计行（`start/end`）
  const startOf = (m) => Number(m?.seqStart ?? m?.start);
  const endOf = (m) => Number(m?.seqEnd ?? m?.end);
  const spans = list.map((m) => endOf(m) - startOf(m) + 1);
  const runs = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && startOf(list[j + 1]) <= endOf(list[j]) + 1 && (spans[j + 1] < small || spans[j] < small)) {
      j += 1;
    }
    if (j > i) {
      const idx = [];
      for (let k = i; k <= j; k += 1) idx.push(k);
      runs.push({ from: i, to: j, marks: idx, spans: idx.map((k) => spans[k]) });
    }
    i = j + 1;
  }
  return runs;
}

/* ─────────────────────────── 窗口：与 src/engine.mjs 同源 ─────────────────────────── */

/**
 * 引擎算欠账窗口的那几行（`src/engine.mjs:2471-2487`）。
 *
 * **为什么抄而不是 import**：那几行是 `#offlineCloseoutFold` 的内联代码，没有导出。
 * 本文件的 `new` 分支就是**修复提案**；`old` 分支与生产**逐字一致**（同样的抄法见
 * `test/degenerate-range.test.mjs` 的 `engineRange`）。两边一起改才不会漂。
 *
 * @param {object} debt `debtOfGraph()` 的返回
 * @param {"old"|"new"} clamp
 * @param {number} minEvents 与 `closeoutMinEvents` 同义
 * @returns {{rangeStart:number, rangeEnd:number, gapEvents:number, fromHead:boolean}}
 */
export function engineWindow(debt, clamp = "old", minEvents = DEFAULT_MIN_EVENTS) {
  const gapFrom = Number(debt?.gap?.from ?? 0);
  const hasGapFrom = Number.isFinite(gapFrom) && gapFrom > 0;
  const lastFold = debt?.lastFoldSeq;
  const rangeStart = hasGapFrom ? gapFrom : lastFold === null || lastFold === undefined ? 1 : Number(lastFold) + 1;
  const gapEvents = Number(debt?.gap?.events ?? 0);
  const gapEnd = hasGapFrom && gapEvents > 0 ? gapFrom + gapEvents - 1 : 0;
  const rangeEndRaw = Number(debt?.maxSeq) || 0;
  // ★ T63：**缺口不够一次调用就不许拿它当窗口**。原写法无条件夹到 `gapEnd`，
  //   于是 `gapEvents = 8` 就把窗口压成 8 个事件（真机 p10 = 1）—— 每轮折一个缺口、
  //   付整次调用，而模型因为 `fromHead` 不设上界，读到的其实是整段会话。
  //   合并（`rangeEnd = rangeEndRaw`）后：缺口和它后面的未折尾巴一起进窗口，一次折完。
  const gapWorthFolding = gapEvents >= Number(minEvents);
  const rangeEnd = gapEnd > 0 && (clamp === "old" || gapWorthFolding) ? Math.min(rangeEndRaw, gapEnd) : rangeEndRaw;
  const fromHead = (debt?.gap !== undefined && debt?.gap !== null) || false;
  return { rangeStart, rangeEnd, gapEvents, fromHead };
}

/* ─────────────────────────── 反事实重放 ─────────────────────────── */

/** 假模型：确定性、不联网、不花一分钱（只为了让 `runOfflineFold` 走完编排）。 */
const fakeModel = async () => ({
  text: "## 目标\n- 重放（假模型）\n\n## 棋谱（状态节点）\n- n1 重放\n\n## 原始坐标（本段）\n- 本段遮蔽 seq 1-1",
  usage: { inputTokens: 15_000, outputTokens: 500, totalTokens: 15_500 },
  model: "replay",
  finish: "stop",
});

/**
 * **单条折痕的反事实重放**：把「这条折痕写下之前」的欠账状态重建出来，两种窗口夹取各跑一遍。
 *
 * 重建（可验证）：残留缺口 = 这条折痕自己（`offlineUncoveredHead = {from: seqStart, events: span}`），
 * 已折段 = 它之前的所有折痕。这样 `old` 口径算出来的窗口必然就是 `[seqStart, seqEnd]` ——
 * 于是「重放能复现记录区间」本身就是**重建忠实度**的自检（`exact` 字段）。
 *
 * 为什么要这么建：`closeout` 是**单槽且被覆盖**的，历史那一刻的缺口早已不在图上；
 * 而缺口填充折痕（`start === prev.seqEnd + 1`）的 `span` **就是**当时的残留缺口大小 ——
 * 用它反推是唯一有据的做法（不是编的）。
 *
 * 与生产同参：`runOfflineFold`（真编排：字符预算 / 覆盖率 / 质量 / 写回）。
 *
 * @param {object} args
 * @param {object} args.graph 会话棋谱（会被拷贝）
 * @param {Array<object>} args.events 会话日志
 * @param {Array<object>} args.marks 该会话全部折痕（追加顺序）
 * @param {number} args.index 要重放的那条折痕下标
 * @param {"old"|"new"} args.clamp
 * @param {number} args.minEvents
 * @param {number[]} [args.seqs] 可折 seq（省一次重算）
 * @returns {Promise<{recorded:object, window:object, chunk:object|null, exact:boolean, overlap:boolean}>}
 */
export async function replayMark({ graph, events, marks, index, clamp = "old", minEvents = DEFAULT_MIN_EVENTS, seqs = null }) {
  const list = Array.isArray(marks) ? marks : [];
  const mark = list[index];
  const start = Number(mark?.seqStart);
  const end = Number(mark?.seqEnd);
  const span = end - start + 1;
  const before = list.slice(0, index).map((m) => ({ ...m }));
  const sim = {
    ...graph,
    foldMarks: before,
    closeout: {
      at: 1,
      source: "archive-offline",
      foldAttempted: true,
      folded: 1,
      foldOffline: true,
      partial: true,
      offlineUncoveredHead: { from: start, events: span },
    },
    lastOfflineSummary: null,
  };
  const debt = debtOfGraph(sim, { minEvents });
  const { rangeStart, rangeEnd } = engineWindow(debt, clamp, minEvents);
  const fromHead = debt.gap !== undefined && debt.gap !== null ? true : before.length === 0;
  let result = null;
  try {
    result = await runOfflineFold({
      graph: sim,
      events,
      rangeStart,
      rangeEnd,
      maxChunks: 1,
      fromHead,
      callModel: fakeModel,
      measureQuality: () => null,
    });
  } catch {
    result = null;
  }
  const chunk = result?.chunks?.[result.chunks.length - 1] ?? null;
  const foldable = Array.isArray(seqs) ? seqs : foldableSeqs(events);
  const overlap =
    chunk === null ? false : before.some((m) => Number(m.seqStart) <= chunk.end && Number(m.seqEnd) >= chunk.start);
  return {
    recorded: { start, end, span },
    window: { rangeStart, rangeEnd, span: Math.max(0, rangeEnd - rangeStart + 1) },
    chunk: chunk === null ? null : { start: chunk.start, end: chunk.end, span: chunk.end - chunk.start + 1, content: countIn(foldable, chunk.start, chunk.end) },
    exact: chunk !== null && chunk.start === start && chunk.end === end,
    overlap,
  };
}

/* ─────────────────────────── 质量：一条折痕 ─────────────────────────── */

/**
 * 一条折痕的质量三元组（**形状受控**：同时给出「模型实际读到的跨度」，因为 T52 已证
 * 可定位率是**形状的函数**，不是代码质量的函数）。
 *
 * @param {object} mark
 * @param {object} graph
 * @param {number[]} seqs 可折 seq
 * @returns {{text:boolean, constraintRecall:number|null, traceableShare:number|null, t33:number|null; replaySpan:number|null}}
 */
export function qualityOf(mark, graph, events, seqs) {
  const { text } = resolveSummaryText(mark, graph?.lastOfflineSummary ?? null);
  const out = { text: false, constraintRecall: null, traceableShare: null, t33: null, content: null, replaySpan: null, replayMessages: null, ids: 0, placeholders: 0 };
  const recall = Number(mark?.quality?.constraintRecall);
  out.constraintRecall = Number.isFinite(recall) ? recall : null;
  const start = Number(mark?.seqStart);
  const end = Number(mark?.seqEnd);
  // 形状受控：**模型实际读到的**消息跨度（与生产同参重放，见 `range-fidelity-audit.mjs` 的口径 B）
  if (Number.isFinite(start) && Number.isFinite(end)) {
    out.content = countIn(seqs, start, end);
    try {
      const replay = replayRange(events, { start, end });
      if (replay !== null) {
        out.replaySpan = replay.end - replay.start + 1;
        out.replayMessages = replay.messages;
      }
    } catch {
      out.replaySpan = null;
    }
  }
  if (typeof text === "string" && text !== "") {
    out.text = true;
    const sample = {
      sessionId: String(graph?.sessionId ?? ""),
      trigger: String(mark?.trigger ?? ""),
      source: "mark",
      at: Number(mark?.at) || 0,
      seqStart: start,
      seqEnd: end,
      text,
      mark,
      lastOfflineSummary: null,
      chars: text.length,
    };
    try {
      const measured = measureSample(sample, graph);
      out.traceableShare = Number.isFinite(Number(measured?.traceableShare)) ? Number(measured.traceableShare) : null;
      out.ids = Number(measured?.ids) || 0;
      out.placeholders = Number(measured?.placeholders) || 0;
      const scored = scoreMark(measured);
      out.t33 = Number.isFinite(Number(scored?.total)) ? Number(scored.total) : null;
    } catch {
      out.traceableShare = null;
      out.t33 = null;
    }
  }
  return out;
}

/* ─────────────────────────── 统计工具 ─────────────────────────── */

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

/** 分位数（线性插值，与各审计脚本同口径）。 */
export function quantile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = (list.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, list.length - 1);
  return list[lo] + (list[hi] - list[lo]) * (at - lo);
}

const mean = (values) => {
  const list = values.filter((v) => Number.isFinite(Number(v))).map(Number);
  return list.length === 0 ? null : list.reduce((n, v) => n + v, 0) / list.length;
};

const pct = (part, whole, d = 1) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(d)}%`);

/* ─────────────────────────── 主流程 ─────────────────────────── */

/**
 * 全库扫描（纯只读）。
 * @param {{home:string, small?:number, tiny?:number, minEvents?:number, replay?:boolean}} options
 */
export async function audit({ home, small = SMALL_SPAN, tiny = TINY_SPAN, minEvents = DEFAULT_MIN_EVENTS, replay = true } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) return { home, missing: true, sessions: 0, marks: 0, rows: [] };

  // 会话**目录名** → 日志（一次遍历，别逐个 findSessionLog：那要 110ms × 844）
  // ★ T63（第一版踩的坑）：目录名**不一定等于** uuid —— 真机有 `session-<uuid>` 这种前缀写法。
  //   按 uuid 建索引会让这 47 条会话读不到事件，重放全变成「空窗口」，结论直接错。
  const logs = new Map();
  for (const file of listSessionLogs(home)) {
    const dir = nodePath.basename(nodePath.dirname(file));
    if (dir !== "") logs.set(dir, file);
  }
  const logFor = (sessionId) => {
    const direct = logs.get(sessionId);
    if (direct !== undefined) return direct;
    for (const [dir, file] of logs) if (dir.endsWith(sessionId) || sessionId.endsWith(dir)) return file;
    return undefined;
  };

  const rows = [];
  let sessions = 0;
  let marksTotal = 0;
  const eventCache = new Map();
  const loadEvents = (sessionId) => {
    if (eventCache.has(sessionId)) return eventCache.get(sessionId);
    const file = logFor(sessionId);
    const events = file === undefined ? [] : readSessionEvents(file);
    eventCache.set(sessionId, events);
    return events;
  };

  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const graphFile = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let loaded;
    try {
      loaded = loadSessionGraph(graphFile);
    } catch {
      continue;
    }
    const graph = loaded.graph;
    const marks = (graph.foldMarks ?? []).filter((m) => Number.isFinite(Number(m?.seqStart)) && Number.isFinite(Number(m?.seqEnd)));
    if (marks.length === 0) continue;
    sessions += 1;
    marksTotal += marks.length;
    const events = loadEvents(name);
    const seqs = foldableSeqs(events);
    const graphMaxSeq = Number(debtOfGraph(graph).maxSeq) || 0;
    marks.forEach((mark, index) => {
      const start = Number(mark.seqStart);
      const end = Number(mark.seqEnd);
      const span = end - start + 1;
      const content = countIn(seqs, start, end);
      const prev = index === 0 ? null : marks[index - 1];
      rows.push({
        sessionId: name,
        index,
        at: Number(mark.at) || null,
        trigger: String(mark.trigger ?? "undefined"),
        start,
        end,
        span,
        content,
        small: span < small,
        tiny: span < tiny,
        cause: span < small ? classifyWindow({ start, end, prev, content }) : null,
        degenerate: start === end,
        gapAfter: graphMaxSeq - end,
        summaryChars: Number(mark.summaryChars) || 0,
        usage: mark.usage ?? null,
        model: mark?.route?.model ?? mark?.model ?? null,
        truncated: mark.truncated === true,
        quality: qualityOf(mark, graph, events, seqs),
      });
    });
  }

  const spans = rows.map((r) => r.span);
  const smallRows = rows.filter((r) => r.small);
  const byTrigger = {};
  for (const row of rows) {
    const bucket = (byTrigger[row.trigger] ??= { marks: 0, small: 0, tiny: 0, spanSum: 0 });
    bucket.marks += 1;
    bucket.spanSum += row.span;
    if (row.small) bucket.small += 1;
    if (row.tiny) bucket.tiny += 1;
  }
  const bySession = new Map();
  for (const row of rows) {
    const bucket = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, marks: 0, small: 0, spans: [] };
    bucket.marks += 1;
    bucket.spans.push(row.span);
    if (row.small) bucket.small += 1;
    bySession.set(row.sessionId, bucket);
  }

  const causeCount = {};
  for (const row of smallRows) causeCount[row.cause] = (causeCount[row.cause] ?? 0) + 1;

  // 抖动：同一会话里首尾相接/重叠的连击
  const jitter = [];
  for (const [sessionId, bucket] of bySession) {
    const list = rows.filter((r) => r.sessionId === sessionId);
    for (const run of jitterRuns(list, { small })) {
      jitter.push({
        sessionId,
        from: run.from,
        to: run.to,
        length: run.marks.length,
        spans: run.spans,
        seqs: run.marks.map((k) => [list[k].start, list[k].end]),
        tiny: run.spans.filter((s) => s < tiny).length,
      });
    }
  }
  jitter.sort((a, b) => b.tiny - a.tiny || b.length - a.length || a.sessionId.localeCompare(b.sessionId));

  // 白花的钱：只按小窗口自己记的 usage 算（没有 usage 的按「一次调用」的单价估）
  const costOf = (row) => {
    const input = Number(row?.usage?.inputTokens);
    if (Number.isFinite(input) && input > 0) {
      const cost = estimateFoldCostUsd(row.usage, row.model ?? undefined);
      if (Number.isFinite(cost)) return { usd: cost, input, known: true };
      return { usd: null, input, known: false };
    }
    return { usd: null, input: null, known: false };
  };
  const knownCosts = rows.map(costOf).filter((c) => c.usd !== null);
  const unitUsd = knownCosts.length === 0 ? null : mean(knownCosts.map((c) => c.usd));
  const unitInput = (() => {
    const inputs = rows.map((r) => Number(r?.usage?.inputTokens)).filter((v) => Number.isFinite(v) && v > 0);
    return inputs.length === 0 ? null : mean(inputs);
  })();
  const price = priceForModel(rows.find((r) => r.model)?.model ?? "deepseek-flash");
  const money = (list) => {
    const known = list.map(costOf).filter((c) => c.usd !== null);
    const knownSum = known.reduce((n, c) => n + c.usd, 0);
    const estimated = (list.length - known.length) * (unitUsd ?? 0);
    const inputs = list.map((r) => Number(r?.usage?.inputTokens)).filter((v) => Number.isFinite(v) && v > 0);
    return {
      marks: list.length,
      known: known.length,
      usd: knownSum + estimated,
      usdKnownOnly: knownSum,
      inputTokens: inputs.reduce((n, v) => n + v, 0),
      inputMean: inputs.length === 0 ? null : mean(inputs),
      unitUsd,
    };
  };

  // 质量对比：小窗口 vs 大窗口（**同时**给「模型实际读到的消息条数」，形状受控）
  const bucketQuality = (list) => {
    const recall = list.map((r) => r.quality?.constraintRecall).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const trace = list.map((r) => r.quality?.traceableShare).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const t33 = list.map((r) => r.quality?.t33).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const replay = list.map((r) => r.quality?.replaySpan).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const content = list.map((r) => r.quality?.content).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    return {
      n: list.length,
      withText: list.filter((r) => r.quality?.text === true).length,
      constraintRecallMean: round(mean(recall), 4),
      constraintRecallN: recall.length,
      traceableMean: round(mean(trace), 4),
      traceableN: trace.length,
      traceableAtOne: trace.filter((v) => v === 1).length,
      traceableAtZero: trace.filter((v) => v === 0).length,
      t33Mean: round(mean(t33), 2),
      t33N: t33.length,
      ids: list.reduce((n, r) => n + (Number(r.quality?.ids) || 0), 0),
      placeholders: list.reduce((n, r) => n + (Number(r.quality?.placeholders) || 0), 0),
      contentP50: quantile(content, 0.5),
      replaySpanP50: quantile(replay, 0.5),
      replaySpanMax: replay.length === 0 ? null : Math.max(...replay),
    };
  };

  // 反事实重放：**逐条小窗口**重建「它写下之前」的欠账状态，两种夹取各跑一遍（--no-replay 跳过）
  let replayResult = null;
  if (replay) {
    const bySessionRows = new Map();
    for (const row of smallRows) {
      if (!bySessionRows.has(row.sessionId)) bySessionRows.set(row.sessionId, []);
      bySessionRows.get(row.sessionId).push(row);
    }
    const detail = [];
    for (const [sessionId, list] of bySessionRows) {
      const graphFile = nodePath.join(sessionsDir, sessionId, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      let graph;
      try {
        graph = loadSessionGraph(graphFile).graph;
      } catch {
        continue;
      }
      const events = loadEvents(sessionId);
      const seqs = foldableSeqs(events);
      const marks = (graph.foldMarks ?? []).filter((m) => Number.isFinite(Number(m?.seqStart)) && Number.isFinite(Number(m?.seqEnd)));
      for (const row of list) {
        const base = { graph, events, marks, index: row.index, minEvents, seqs };
        const oldRun = await replayMark({ ...base, clamp: "old" });
        const newRun = await replayMark({ ...base, clamp: "new" });
        detail.push({ sessionId, index: row.index, recorded: oldRun.recorded, old: oldRun, new: newRun });
      }
    }
    const agg = (side) => {
      const list = detail.map((d) => d[side]);
      const spans = list.map((r) => (r.chunk === null ? 0 : r.chunk.span));
      return {
        marks: list.length,
        small: spans.filter((v) => v < small).length,
        big: spans.filter((v) => v >= small).length,
        overlaps: list.filter((r) => r.overlap === true).length,
        nullChunk: list.filter((r) => r.chunk === null).length,
        spanP50: quantile(spans, 0.5),
        spanMax: spans.length === 0 ? null : Math.max(...spans),
        contentP50: quantile(list.map((r) => (r.chunk === null ? 0 : r.chunk.content)), 0.5),
        usd: list.length * (unitUsd ?? 0),
      };
    };
    replayResult = {
      marks: detail.length,
      sessions: bySessionRows.size,
      exact: detail.filter((d) => d.old.exact === true).length,
      old: agg("old"),
      new: agg("new"),
      detail,
    };
  }

  return {
    home,
    missing: false,
    sessions,
    marks: marksTotal,
    spans: {
      n: spans.length,
      min: spans.length === 0 ? null : Math.min(...spans),
      p10: quantile(spans, 0.1),
      p25: quantile(spans, 0.25),
      p50: quantile(spans, 0.5),
      p75: quantile(spans, 0.75),
      p90: quantile(spans, 0.9),
      max: spans.length === 0 ? null : Math.max(...spans),
      small: smallRows.length,
      tiny: rows.filter((r) => r.tiny).length,
      degenerate: rows.filter((r) => r.degenerate).length,
    },
    byTrigger,
    bySession: [...bySession.values()].sort((a, b) => b.small - a.small || b.marks - a.marks),
    causeCount,
    smallRows,
    jitter,
    money: { all: money(rows), small: money(smallRows), unitInput, price },
    quality: {
      small: bucketQuality(smallRows),
      large: bucketQuality(rows.filter((r) => !r.small)),
    },
    replayResult,
    rows,
  };
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

const fmtUsd = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `$${Number(v).toFixed(4)}`);
const fmtNum = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d));

/**
 * 报告渲染（纯函数，便于单测）。
 * @param {object} result `audit()` 的返回
 * @returns {string}
 */
export function render(result) {
  const lines = [];
  const { spans, byTrigger, bySession, causeCount, jitter, money, quality, replayResult } = result;
  lines.push("# 小窗口折痕审计（只读 · 不调模型）");
  lines.push("");
  lines.push(`> home: \`${result.home}\` · 会话 **${result.sessions}** · 折痕 **${result.marks}**`);
  lines.push("");

  /* ① 分布 */
  lines.push("## ① 跨度分布");
  lines.push("");
  lines.push("| p10 | p25 | p50 | p75 | p90 | max |");
  lines.push("|---|---|---|---|---|---|");
  lines.push(`| ${fmtNum(spans.p10)} | ${fmtNum(spans.p25)} | ${fmtNum(spans.p50)} | ${fmtNum(spans.p75)} | ${fmtNum(spans.p90)} | ${fmtNum(spans.max)} |`);
  lines.push("");
  lines.push(
    `- 跨度 **< 20**：**${spans.small}** 条（${pct(spans.small, spans.n)}）· **< 5**：**${spans.tiny}** 条（${pct(spans.tiny, spans.n)}）· **= 1**（单点）：${spans.degenerate} 条（${pct(spans.degenerate, spans.n)}）`,
  );
  lines.push(`- 最小跨度 ${fmtNum(spans.min)} · 最大 ${fmtNum(spans.max)} · 极差 ${fmtNum(spans.max === null ? null : spans.max - spans.min)}`);
  lines.push("");
  lines.push("### 按 trigger");
  lines.push("");
  lines.push("| trigger | 折痕 | < 20 | < 5 | 小窗口占比 | 平均跨度 |");
  lines.push("|---|---|---|---|---|---|");
  for (const [trigger, bucket] of Object.entries(byTrigger).sort((a, b) => b[1].small - a[1].small)) {
    lines.push(`| \`${trigger}\` | ${bucket.marks} | ${bucket.small} | ${bucket.tiny} | ${pct(bucket.small, bucket.marks)} | ${fmtNum(bucket.spanSum / bucket.marks, 1)} |`);
  }
  lines.push("");
  const topSessions = bySession.filter((s) => s.small > 0).slice(0, 10);
  lines.push(`### 按会话（有小窗口的会话 ${bySession.filter((s) => s.small > 0).length} 个，取前 10）`);
  lines.push("");
  lines.push("| 会话 | 折痕 | < 20 | 跨度序列 |");
  lines.push("|---|---|---|---|");
  for (const s of topSessions) {
    lines.push(`| \`${s.sessionId.slice(0, 12)}…\` | ${s.marks} | ${s.small} | ${s.spans.slice(0, 14).join(" · ")}${s.spans.length > 14 ? " …" : ""} |`);
  }
  lines.push("");

  /* ② 成因 */
  lines.push("## ② 成因（每个 < 20 的窗口）");
  lines.push("");
  lines.push("| 成因 | 条数 | 占小窗口 |");
  lines.push("|---|---|---|");
  for (const [cause, count] of Object.entries(causeCount).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${CAUSE_CN[cause] ?? cause} | ${count} | ${pct(count, result.spans.small)} |`);
  }
  lines.push("");
  const empty = (causeCount["head-gap"] ?? 0) + (causeCount.empty ?? 0);
  lines.push(
    `- **窗口里 0 条可折事件**（\`session\` / \`step/start\` 这类非消息事件撑出来的虚构窗口）：**${empty}** 条（${pct(empty, result.spans.small)}）`,
  );
  lines.push(`- **紧接上一条折痕（抖动）**：**${causeCount.contiguous ?? 0}** 条 · **与上一条重叠（重复折叠）**：**${causeCount.overlap ?? 0}** 条 · **跳折**：**${causeCount.jump ?? 0}** 条`);
  lines.push("");

  /* ③ 抖动检测 */
  lines.push("## ③ 抖动检测（同一会话里首尾相接/重叠的连击）");
  lines.push("");
  if (jitter.length === 0) {
    lines.push("- 没有连击：每条小窗口都是独立事件。");
  } else {
    lines.push(`- 连击 **${jitter.length}** 段（最长 ${Math.max(...jitter.map((j) => j.length))} 条）· 涉及 **${new Set(jitter.map((j) => j.sessionId)).size}** 个会话`);
    lines.push("");
    lines.push("| 会话 | 连击长度 | 其中 < 5 | 区间序列（seq） | 跨度 |");
    lines.push("|---|---|---|---|---|");
    for (const run of jitter.slice(0, 12)) {
      lines.push(
        `| \`${run.sessionId.slice(0, 12)}…\` | ${run.length} | ${run.tiny} | ${run.seqs.map(([a, b]) => `${a}-${b}`).join(" → ")} | ${run.spans.join(" · ")} |`,
      );
    }
  }
  lines.push("");

  /* ④ 白花的钱 */
  lines.push("## ④ 白花的钱");
  lines.push("");
  lines.push(`- 全库折痕 **${money.all.marks}** 条 · 有 usage 的 **${money.all.known}** 条 · 合计 **${fmtUsd(money.all.usd)}**（缺 usage 的按均值 ${fmtUsd(money.all.unitUsd)} 估）`);
  lines.push(`- 小窗口（< 20）**${money.small.marks}** 条 · 合计 **${fmtUsd(money.small.usd)}**（占全库 ${pct(money.small.usd, money.all.usd || 1)}）`);
  lines.push(
    `- 单次调用平均输入 **${fmtNum(money.small.inputMean)}** token（全库 ${fmtNum(money.all.inputMean)}）· 价目：miss $${fmtNum(money.price?.miss, 2)}/M · hit $${fmtNum(money.price?.hit, 2)}/M · out $${fmtNum(money.price?.out, 2)}/M`,
  );
  lines.push("");

  /* ⑤ 质量对比 */
  lines.push("## ⑤ 质量对比（小窗口 vs 大窗口 · **形状受控**）");
  lines.push("");
  lines.push("| 桶 | 折痕 | 有正文 | constraintRecall | 可定位率（逐条均） | 可定位率 = 1 | 可定位率 = 0 | T33 五判据 | 窗口内可折事件 p50 | **模型实读跨度** p50 | max |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const qrow = (label, q) =>
    `| ${label} | ${q.n} | ${q.withText} | ${fmtNum(q.constraintRecallMean, 3)} (n=${q.constraintRecallN}) | ${fmtNum(q.traceableMean, 3)} (n=${q.traceableN}) | ${q.traceableAtOne} | ${q.traceableAtZero} | ${fmtNum(q.t33Mean, 2)} (n=${q.t33N}) | ${fmtNum(q.contentP50)} | ${fmtNum(q.replaySpanP50)} | ${fmtNum(q.replaySpanMax)} |`;
  lines.push(qrow("小窗口 < 20", quality.small));
  lines.push(qrow("大窗口 ≥ 20", quality.large));
  lines.push("");
  lines.push(
    `- 引用池化：小窗口 **真 id ${quality.small.ids} 个 / 占位符 ${quality.small.placeholders} 个**（可定位率 ${fmtNum(
      quality.small.ids + quality.small.placeholders === 0 ? null : quality.small.ids / (quality.small.ids + quality.small.placeholders),
      3,
    )}）· 大窗口 **${quality.large.ids} / ${quality.large.placeholders}**（${fmtNum(
      quality.large.ids + quality.large.placeholders === 0 ? null : quality.large.ids / (quality.large.ids + quality.large.placeholders),
      3,
    )}）`,
  );
  lines.push(
    `- **形状受控（T52）**：小窗口的摘要正文 p50 ${fmtNum(quality.small.contentP50 === null ? null : quality.small.contentP50)} 条可折事件、模型实读 p50 **${fmtNum(
      quality.small.replaySpanP50,
    )}** 个事件 —— 模型读的是一整段会话，账上只记了几个事件。**低可定位率是「账」造成的：区间外的 id 全被 \`sanitizeSummaryIds\` 抹成 \`n?\`。**`,
  );
  lines.push("");

  /* ⑥ 反事实重放 */
  if (replayResult !== null && replayResult !== undefined) {
    lines.push("## ⑥ 反事实重放（逐条重建「写下之前」的欠账状态 · 假模型 · 只改窗口夹取）");
    lines.push("");
    lines.push(
      `对象：**${replayResult.marks}** 条小窗口（**${replayResult.sessions}** 个会话）· 重建忠实度：\`old\` 口径复现记录区间 **${replayResult.exact}/${replayResult.marks}**（${pct(replayResult.exact, replayResult.marks)}）`,
    );
    lines.push("");
    lines.push("| 口径 | 仍 < 20 | 合并成 ≥ 20 | 与已折段重叠 | 跨度 p50 | max | 窗口内可折事件 p50 |");
    lines.push("|---|---|---|---|---|---|---|");
    const qrow2 = (label, q) =>
      `| ${label} | ${q.small} | ${q.big} | ${q.overlaps} | ${fmtNum(q.spanP50)} | ${fmtNum(q.spanMax)} | ${fmtNum(q.contentP50)} |`;
    lines.push(qrow2("`old`（生产：min(maxSeq, gapEnd)）", replayResult.old));
    lines.push(qrow2("`new`（缺口 < 门槛 ⇒ 与尾巴合并）", replayResult.new));
    lines.push("");
    lines.push(
      `- 小窗口 **${replayResult.old.small} → ${replayResult.new.small}**（−${replayResult.old.small - replayResult.new.small}）· 合并成大窗口 **${replayResult.old.big} → ${replayResult.new.big}** · 空窗口（无消息）${replayResult.old.nullChunk} → ${replayResult.new.nullChunk}`,
    );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const flag = (name, dflt) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : dflt;
  };
  const home = resolveHome(flag("home", null));
  const small = Number(flag("small", SMALL_SPAN)) || SMALL_SPAN;
  const tiny = Number(flag("tiny", TINY_SPAN)) || TINY_SPAN;
  const minEvents = Number(flag("min", DEFAULT_MIN_EVENTS)) || DEFAULT_MIN_EVENTS;
  const replay = !argv.includes("--no-replay");
  const result = await audit({ home, small, tiny, minEvents, replay });
  if (result.missing) {
    process.stderr.write(`找不到棋谱目录：${nodePath.join(home, "chess-context", "sessions")}\n`);
    return 2;
  }
  if (argv.includes("--json")) {
    const { rows, smallRows, ...rest } = result;
    process.stdout.write(`${JSON.stringify({ ...rest, rows: rows.length, smallRows: smallRows.length }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(render(result));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
