#!/usr/bin/env node
/**
 * compaction-writes-audit.mjs —— 一次折叠到底往 surface 上写了几次（T51，2026-11-05）
 *
 * ## 为什么要有它（T46 账单里的 B 桶）
 *
 * T46（`scripts/cache-miss-audit.mjs`）把 `none` 组的 waste 拆成四桶，B（前缀被改）$15.20。
 * 报告里给 B 贴的标签是 `compaction/prune` + `compaction/summary`，并据此提出
 * 「这是**同一次折叠的两次** surface 写，各收 207k 重读 ⇒ 合并省 ≈$5.96」。
 *
 * 那是**归因标签**，不是**写次数**。本脚本去真机日志里逐条数：
 * 一次折叠真正产生几次 surface 写、两次之间隔多久、内容上到底能不能合成一次。
 *
 * ## 口径（先证伪：标签 ≠ 写）
 *
 * 宿主源码里，一次 `compactSurfaceRegion` 事务的**写**只有两处（`surfaceOp.op === "replace"`）：
 *
 * | 谁写 | 文件:行 | 事件类型 | 配套的「定价事件」（**不是**写） |
 * |---|---|---|---|
 * | `ToolResultPruner.pruneSession` | `dsh-compaction-tool-result-pruner/lib/index.js:167` | `tool/result` | `compaction/prune`（:159） |
 * | `commitCompactionBody` | `dsh-compaction-basic/lib/index.js:641` | `user/message`（`source.kind = compact-checkpoint`） | `compaction/summary`（:634） |
 *
 * 所以「`compaction/prune` 与 `compaction/summary` 是两次写」这句话**混了层**：
 * 它们是两次写的**定价事件**。真正的写是 `tool/result` 与 `user/message` 的 replace。
 * 本脚本按**写**统计（`surfaceOp.op === "replace"`），并把每次写映射回它的定价事件。
 *
 * 另外两条**不是折叠**的写，单独列（它们是 B 桶里另外那两笔）：
 *   · `user/message:chess-context:ledger` —— 本仓 `src/rooms/hot-inject.mjs:212`（热清单就地替换）；
 *   · `system/message`（`source.kind = system-prompt`）—— 宿主 system prompt 重渲染。
 *
 * ## 用法
 *
 *   node scripts/compaction-writes-audit.mjs                 # 扫 DSH_HOME 下全部会话
 *   node scripts/compaction-writes-audit.mjs --session 8a73e06b
 *   node scripts/compaction-writes-audit.mjs --limit 8       # 明细打印条数（默认 6）
 *   node scripts/compaction-writes-audit.mjs --max-sessions 50
 *   node scripts/compaction-writes-audit.mjs --json          # 机读
 *
 * 退出码：0 = 打印完成（**没有折叠也是一种结果**，不是错误）；2 = 参数写错 / home 不存在。
 * 边界：**只读**。不写盘、不跑模型、不改任何会话文件。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";
// 价目表与 waste 口径**必须**与 T46 同一份（两份报告的美元要可比）。故意在这里 import，
// 而不是复制一份常量：那边一改，这边跟着变；反过来（静默 0）才是灾难。
import { NOISE_TOKENS, PRICES, growthOf, wasteOf } from "./cache-miss-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/** 只解析这几种事件（整行 JSON.parse 太慢，先按顶层 type 前缀过滤）。 */
export const KEEP_TYPES = new Set([
  "assistant/message",
  "user/message",
  "system/message",
  "developer/message",
  "tool/result",
  "tool/call",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "compaction/prune",
]);

/** 折叠事务里的两种「写」。见文件头表格。 */
export const WRITE_KINDS = Object.freeze({
  PRUNE: "prune",
  SUMMARY: "summary",
  LEDGER: "ledger",
  SYSTEM_PROMPT: "system-prompt",
  OTHER: "other",
});

/** 中文名（报告与测试共用，避免两处手写字符串漂移）。 */
export const WRITE_LABELS = Object.freeze({
  prune: "prune 写（tool/result 就地截断）",
  summary: "summary 写（user/message 折叠检查点）",
  ledger: "热清单写（user/message chess-context）",
  "system-prompt": "system prompt 写（宿主重渲染）",
  other: "其它写",
});

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/** 顶层 `type` 字段（避免对整行 JSON.parse —— 648 MB 日志差一个数量级）。 */
function typeOfLine(line) {
  const prefix = '{"type":"';
  if (!line.startsWith(prefix)) return null;
  const end = line.indexOf('"', prefix.length);
  return end < 0 ? null : line.slice(prefix.length, end);
}

/**
 * content（block 数组或字符串）的字符数。非文本块按 0 计 —— 与 pruner 的 `measureContent` 同口径。
 * @param {unknown} content
 * @returns {number}
 */
export function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) if (typeof block?.text === "string") n += block.text.length;
  return n;
}

/**
 * 一条 surface 写（`surfaceOp.op === "replace"`）的身份。
 *
 * 为什么只认 `replace`：`append` 只往尾部加，**不动前缀**（前缀缓存照常命中）。
 * 会作废缓存的只有就地改写早期槽位 —— 那是 `replace`。
 * @param {object} event
 * @param {string} [session]
 * @returns {object}
 */
export function writeOf(event, session = "?") {
  const op = event?.surfaceOp ?? {};
  const kind = event?.data?.source?.kind ?? event?.data?.message?.source?.kind ?? null;
  const form = event?.data?.source?.form ?? event?.data?.message?.source?.form ?? null;
  const type = String(event?.type ?? "?");
  let writeKind = WRITE_KINDS.OTHER;
  if (type === "tool/result") writeKind = WRITE_KINDS.PRUNE;
  else if (type === "user/message" && kind === "compact-checkpoint") writeKind = WRITE_KINDS.SUMMARY;
  else if (type === "user/message" && kind === "chess-context") writeKind = WRITE_KINDS.LEDGER;
  else if (type === "system/message") writeKind = WRITE_KINDS.SYSTEM_PROMPT;
  return {
    session,
    seq: Number(event?.seq) || 0,
    time: Number(event?.time) || 0,
    type,
    kind,
    form,
    callId: event?.data?.message?.source?.callId ?? null,
    startSeq: Number(op.startSeq) || 0,
    endSeq: Number(op.endSeq) || 0,
    charsAfter: contentChars(event?.data?.content ?? event?.data?.message?.content),
    writeKind,
    label: WRITE_LABELS[writeKind],
  };
}

/** `compaction/prune` 定价事件（**不是**写）。 */
export function pruneOf(event, session = "?") {
  return {
    session,
    seq: Number(event?.seq) || 0,
    time: Number(event?.time) || 0,
    shadowedSeqs: Array.isArray(event?.data?.shadowedSeqs) ? event.data.shadowedSeqs.map(Number) : [],
    shadowedTokenCount: Number(event?.data?.shadowedTokenCount) || 0,
  };
}

/**
 * ★ 核心：把一个会话的事件流拆成「折叠事务」+「写」。
 *
 * 一个折叠事务 = `compaction/start` … `compaction/end` 的括弧。括弧**之前**的写
 * （prune 那一批）记进 `precedingWrites`；括弧**之内**的写（summary 那一笔）记进 `writes`。
 * 这个区分是整份报告的地基：宿主先剪枝、再选区间、再折 —— 剪枝落在括弧外。
 *
 * @param {Array<object>} events 已按 seq 升序
 * @param {{session?: string}} [opts]
 * @returns {{session:string, writes:Array<object>, folds:Array<object>,
 *            pruneEvents:Array<object>, orphanPrunes:Array<object>, orphanWrites:Array<object>,
 *            appendChars:Map<number,number>}}
 */
export function analyzeSession(events, { session = "?" } = {}) {
  const writes = [];
  const folds = [];
  const pruneEvents = [];
  const appendChars = new Map();
  let pendingPrunes = [];
  let pendingWrites = [];
  let open = null;

  for (const event of events ?? []) {
    const type = String(event?.type ?? "");
    const op = event?.surfaceOp;
    if (op !== null && typeof op === "object" && op.op === "replace") {
      const write = writeOf(event, session);
      writes.push(write);
      if (open !== null) open.writes.push(write);
      else pendingWrites.push(write);
      continue;
    }
    if (type === "tool/result") {
      // 原始内容长度：prune 写完只剩尾巴，得从**改写前**那条 append 里拿。
      // （tool/result 的 append 也带 `surfaceOp: {op:"append"}`，所以不能按「没有 surfaceOp」判。）
      const seq = Number(event?.seq) || 0;
      appendChars.set(seq, contentChars(event?.data?.message?.content ?? event?.data?.content));
      continue;
    }
    if (type === "compaction/prune") {
      const prune = pruneOf(event, session);
      pruneEvents.push(prune);
      pendingPrunes.push(prune);
      continue;
    }
    if (type === "compaction/start") {
      open = {
        session,
        compactionId: event?.data?.compactionId ?? null,
        startSeq: Number(event?.seq) || 0,
        startTime: Number(event?.time) || 0,
        endSeq: null,
        endTime: null,
        summarySeq: null,
        summaryTime: null,
        summaryChars: 0,
        summaryUsage: null,
        shadowedRange: null,
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        precedingPrunes: pendingPrunes,
        precedingWrites: pendingWrites,
        writes: [],
      };
      pendingPrunes = [];
      pendingWrites = [];
      continue;
    }
    if (type === "compaction/summary" && open !== null) {
      open.summarySeq = Number(event?.seq) || 0;
      open.summaryTime = Number(event?.time) || 0;
      open.summaryChars = contentChars(event?.data?.summary);
      open.summaryUsage = event?.data?.usage ?? null;
      const range = event?.data?.shadowedRange;
      open.shadowedRange = range === undefined ? null : { start: Number(range.start) || 0, end: Number(range.end) || 0 };
      open.shadowedSeqs = Array.isArray(event?.data?.shadowedSeqs) ? event.data.shadowedSeqs.map(Number) : [];
      open.shadowedTokenCount = Number(event?.data?.shadowedTokenCount) || 0;
      continue;
    }
    if (type === "compaction/end" && open !== null) {
      open.endSeq = Number(event?.seq) || 0;
      open.endTime = Number(event?.time) || 0;
      folds.push(open);
      open = null;
      pendingWrites = [];
      continue;
    }
  }
  return { session, writes, folds, pruneEvents, orphanPrunes: pendingPrunes, orphanWrites: pendingWrites, appendChars };
}

/** 折叠里的「summary 写」（括弧内那条 user/message replace）。 */
export function summaryWriteOf(fold) {
  return (fold?.writes ?? []).find((w) => w.writeKind === WRITE_KINDS.SUMMARY) ?? null;
}

/** 折叠里的「prune 写」（括弧外那批 tool/result replace）。 */
export function pruneWritesOf(fold) {
  return (fold?.precedingWrites ?? []).filter((w) => w.writeKind === WRITE_KINDS.PRUNE);
}

/**
 * ① 成对率：**一次折叠到底几次写**。
 *
 * 定义（写死在这里，报告与测试都调它）：
 *   · `folds` —— 括弧完整的折叠数；
 *   · `withPruneWrite` —— 括弧前有 ≥1 条 `tool/result` replace 的折叠；
 *   · `withSummaryWrite` —— 括弧内有 `user/message:compact-checkpoint` replace 的折叠；
 *   · `both` —— 两者都有（**这才是「两次写」的实际计数**）；
 *   · `prunePairRate` —— `prune 定价事件` 里，后面真的跟了一次折叠的比例
 *     （= 剪枝没有把压力降到阈值以下、于是还折了）。
 * @param {object} analysis `analyzeSession` 的输出
 * @returns {object}
 */
export function pairingStats(analysis) {
  const folds = analysis?.folds ?? [];
  let withPruneWrite = 0;
  let withSummaryWrite = 0;
  let both = 0;
  let writesTotal = 0;
  let pruneWritesTotal = 0;
  let summaryWritesTotal = 0;
  const writeHistogram = new Map();
  for (const fold of folds) {
    const pruneWrites = pruneWritesOf(fold).length;
    const summaryWrites = summaryWriteOf(fold) === null ? 0 : 1;
    if (pruneWrites > 0) withPruneWrite += 1;
    if (summaryWrites > 0) withSummaryWrite += 1;
    if (pruneWrites > 0 && summaryWrites > 0) both += 1;
    pruneWritesTotal += pruneWrites;
    summaryWritesTotal += summaryWrites;
    const n = pruneWrites + summaryWrites;
    writesTotal += n;
    writeHistogram.set(n, (writeHistogram.get(n) ?? 0) + 1);
  }
  const pruneEvents = (analysis?.pruneEvents ?? []).length;
  const prunesFollowedByFold = folds.reduce((a, f) => a + (f?.precedingPrunes ?? []).length, 0);
  return {
    folds: folds.length,
    withPruneWrite,
    withSummaryWrite,
    both,
    pruneWritesTotal,
    summaryWritesTotal,
    writesTotal,
    /** 折叠里「两次写」的占比（both / folds）。 */
    bothRate: folds.length === 0 ? null : both / folds.length,
    pruneEvents,
    prunesFollowedByFold,
    /** prune 定价事件里有几成真的走到了折叠。 */
    prunePairRate: pruneEvents === 0 ? null : prunesFollowedByFold / pruneEvents,
    orphanPrunes: (analysis?.orphanPrunes ?? []).length,
    writeHistogram: [...writeHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([writes, folds2]) => ({ writes, folds: folds2 })),
  };
}

/**
 * ② 间隔：两次写之间隔多久（毫秒 + 事件数）。
 *
 * 为什么两种都给：间隔里夹着**摘要模型调用**（秒级），所以「毫秒」回答「是不是同一个事务」，
 * 「事件数」回答「中间有没有别的轮次」。
 * @param {Array<object>} folds
 * @returns {{n:number, ms:object, events:object, samples:Array<object>}}
 */
export function intervalStats(folds) {
  const samples = [];
  for (const fold of folds ?? []) {
    const summary = summaryWriteOf(fold);
    const pruneWrites = pruneWritesOf(fold);
    if (summary === null || pruneWrites.length === 0) continue;
    const lastPrune = pruneWrites[pruneWrites.length - 1];
    samples.push({
      session: fold.session,
      compactionId: fold.compactionId,
      pruneSeq: lastPrune.seq,
      summarySeq: summary.seq,
      ms: Math.max(0, (summary.time || 0) - (lastPrune.time || 0)),
      events: Math.max(0, (summary.seq || 0) - (lastPrune.seq || 0)),
      pruneCount: pruneWrites.length,
    });
  }
  const ms = samples.map((s) => s.ms);
  const ev = samples.map((s) => s.events);
  const dist = (arr) => {
    if (arr.length === 0) return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0 };
    const a = [...arr].sort((x, y) => x - y);
    const pick = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
    return {
      n: a.length,
      min: a[0],
      p25: pick(0.25),
      median: pick(0.5),
      p75: pick(0.75),
      max: a[a.length - 1],
      mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length),
    };
  };
  return { n: samples.length, ms: dist(ms), events: dist(ev), samples };
}

/**
 * ③ 内容关系：prune 删了哪些、summary 改了哪些 —— 能不能合成一次。
 *
 * 判据：**被 prune 的 seq 落在 summary 的 `shadowedSeqs` 里** ⇒ 那次 pruner 写是**冗余**的
 * （summary 的 replace 本来就会把这个节点整条换掉；prune 那一写只换来一次前缀重读）。
 * 落在外面（保留尾巴里）⇒ prune 在干真活，删不掉。
 *
 * `appendChars` 是「**本会话**的 seq → 原始 content 字符数」，用来算 prune 删掉多少
 * （写事件上只有改写后的尾巴，原长度只在 append 那条里）。
 * @param {Array<object>} folds
 * @param {Map<number,number>} [appendChars]
 * @returns {object}
 */
export function contentRelation(folds, appendChars = new Map()) {
  const perFold = [];
  let insideTotal = 0;
  let outsideTotal = 0;
  let prunedNodes = 0;
  let charsRemoved = 0;
  let pruneTokens = 0;
  let summaryTokens = 0;
  for (const fold of folds ?? []) {
    const summary = summaryWriteOf(fold);
    const pruneWrites = pruneWritesOf(fold);
    const shadowed = new Set(fold?.shadowedSeqs ?? []);
    // ★ 关键：surface 上的节点是**替换后**那条（`append` 出来的新 seq），不是被剪掉的旧 seq。
    //   所以「这个工具结果会不会被 summary 顺手换掉」要查 `write.seq`，不是 `write.startSeq`。
    const prunedSeqs = new Set((fold?.precedingWrites ?? []).filter((w) => w.writeKind === WRITE_KINDS.PRUNE).map((w) => w.seq));
    const inside = [...prunedSeqs].filter((seq) => shadowed.has(seq));
    const outside = [...prunedSeqs].filter((seq) => !shadowed.has(seq));
    insideTotal += inside.length;
    outsideTotal += outside.length;
    prunedNodes += prunedSeqs.size;
    let foldChars = 0;
    const charsOf = fold?.appendChars instanceof Map ? fold.appendChars : appendChars;
    for (const write of pruneWrites) {
      const before = charsOf.get(write.startSeq) ?? null;
      if (before !== null) foldChars += Math.max(0, before - write.charsAfter);
    }
    charsRemoved += foldChars;
    const foldPruneTokens = (fold?.precedingPrunes ?? []).reduce((a, p) => a + (p.shadowedTokenCount || 0), 0);
    pruneTokens += foldPruneTokens;
    summaryTokens += fold?.shadowedTokenCount ?? 0;
    perFold.push({
      session: fold.session,
      compactionId: fold.compactionId,
      pruneWrites: pruneWrites.length,
      summaryWrite: summary === null ? null : summary.seq,
      prunedNodes: prunedSeqs.size,
      inside,
      outside,
      pruneCharsRemoved: foldChars,
      pruneTokens: foldPruneTokens,
      summaryShadowedSeqs: shadowed.size,
      summaryShadowedTokens: fold?.shadowedTokenCount ?? 0,
      summaryChars: fold?.summaryChars ?? 0,
      summaryRange: fold?.shadowedRange ?? null,
    });
  }
  return {
    folds: perFold.length,
    prunedNodes,
    insideTotal,
    outsideTotal,
    charsRemoved,
    pruneTokens,
    summaryTokens,
    /** 被 prune 的节点里，有多少是 summary 会顺手换掉的（冗余写）。 */
    redundantRate: prunedNodes === 0 ? null : insideTotal / prunedNodes,
    perFold: perFold.sort((a, b) => b.prunedNodes - a.prunedNodes),
  };
}

/**
 * ★ ④ 逐请求 waste 归因（T46 口径，一字不改）：
 * `waste = miss − max(0, prompt_i − prompt_{i−1})`，只统计 `none` 组。
 *
 * 与 T46 的差别只有一件：这里**保留**了两次请求之间的**写**（不只是改写种类），
 * 因为本脚本要按「哪一次写」分账。
 * @param {Array<object>} events 已按 seq 升序
 * @returns {Array<object>}
 */
export function requestRows(events) {
  const rows = [];
  let prev = null;
  let pending = [];
  for (const event of events ?? []) {
    if (event?.type !== "assistant/message") {
      pending.push(event);
      continue;
    }
    const usage = event?.data?.usage;
    if (!usage || !Number.isFinite(Number(usage.cacheReadTokens))) {
      pending.push(event);
      continue;
    }
    const miss = Number(usage.inputTokens) || 0;
    const hit = Number(usage.cacheReadTokens) || 0;
    const out = Number(usage.outputTokens) || 0;
    const prompt = miss + hit;
    const time = Number(event.time) || 0;
    const isNone = !pending.some((e) => e?.data?.source?.kind === "chess-context");
    if (prev && isNone) {
      const writes = pending.filter((e) => e?.surfaceOp?.op === "replace").map((e) => writeOf(e));
      rows.push({
        seq: Number(event.seq) || 0,
        time,
        miss,
        hit,
        out,
        prompt,
        prevPrompt: prev.prompt,
        growth: growthOf(prompt, prev.prompt),
        waste: wasteOf({ miss, prompt, prevPrompt: prev.prompt }).waste,
        gapSec: prev.time === 0 || time === 0 ? null : Math.max(0, (time - prev.time) / 1000),
        writes,
      });
    }
    prev = { prompt, time };
    pending = [];
  }
  return rows;
}

/**
 * ★ ⑤ 天花板：把 B 桶的 waste 按「写」分账，并给出「合并两次写」能拿回多少。
 *
 * 合并能省多少，只取决于一件事：**两次写落在不同的请求窗口里**。
 *   · 同一个窗口（两次写之间没有请求）⇒ 本来就只有一次重读，合并省 **0**；
 *   · 不同窗口 ⇒ 合并（少写一次）省掉**其中一次**的重读。
 * 另外，被 prune 的节点如果本来就会被 summary 换掉（`inside`），那次写是**纯冗余**，
 * 它的整份额都可以拿走 —— 这是唯一不需要「少折叠」的部分。
 *
 * 所以天花板 = Σ（窗口里**只剩**冗余 prune 写的那些请求的 waste）。窗口里只要还有
 * summary 写，删掉 prune 也省不到钱（summary 那一写照样作废前缀）。
 * @param {Array<object>} rows `requestRows` 的输出
 * @param {Array<object>} folds `analyzeSession` 的 folds
 * @param {{prices?:object, noiseTokens?:number}} [opts]
 * @returns {object}
 */
export function ceilingOf(rows, folds, { prices = PRICES, noiseTokens = NOISE_TOKENS } = {}) {
  // ① 先给每条 prune 写判「冗余」：它剪的节点会不会被 summary 顺手换掉。
  const redundant = new Set();
  const redundantNodes = new Set();
  for (const fold of folds ?? []) {
    const shadowed = new Set(fold?.shadowedSeqs ?? []);
    for (const write of fold?.precedingWrites ?? []) {
      if (write?.writeKind !== WRITE_KINDS.PRUNE) continue;
      // surface 上是**替换后**那条 ⇒ 查 `write.seq`（见 contentRelation 的注释）。
      if (shadowed.has(write.seq)) {
        redundant.add(write.seq);
        redundantNodes.add(`${fold.session}:${write.startSeq}`);
      }
    }
  }

  const byKind = new Map();
  let pruneOnly = 0;
  let summaryOnly = 0;
  let bothSameWindow = 0;
  let otherWrites = 0;
  let wasteTotal = 0;
  let bRows = 0;
  let mergeCeilingTokens = 0;
  let mergeRows = 0;
  let redundantWindowTokens = 0;
  let redundantWindowRows = 0;
  for (const row of rows ?? []) {
    wasteTotal += row.waste;
    const writes = row.writes ?? [];
    const kinds = new Set(writes.map((w) => w.writeKind));
    const hasPrune = kinds.has(WRITE_KINDS.PRUNE);
    const hasSummary = kinds.has(WRITE_KINDS.SUMMARY);
    // 合并能拿走的：窗口里**只有**冗余 prune 写。
    const onlyRedundantPrune = writes.length > 0 && writes.every((w) => w.writeKind === WRITE_KINDS.PRUNE && redundant.has(w.seq));
    if (onlyRedundantPrune && row.waste > noiseTokens) {
      mergeCeilingTokens += row.waste;
      mergeRows += 1;
    }
    // 中间上界：窗口里**至少有一条**冗余 prune 写（但可能还夹着别的写 ⇒ 省不到）。
    if (writes.some((w) => w.writeKind === WRITE_KINDS.PRUNE && redundant.has(w.seq)) && row.waste > noiseTokens) {
      redundantWindowTokens += row.waste;
      redundantWindowRows += 1;
    }
    if (row.waste <= noiseTokens || kinds.size === 0) {
      if (row.waste > noiseTokens) otherWrites += row.waste;
      continue;
    }
    bRows += 1;
    for (const kind of kinds) {
      const b = byKind.get(kind) ?? { kind, label: WRITE_LABELS[kind] ?? kind, n: 0, waste: 0 };
      b.n += 1;
      b.waste += row.waste;
      byKind.set(kind, b);
    }
    if (hasPrune && hasSummary) bothSameWindow += row.waste;
    else if (hasPrune) pruneOnly += row.waste;
    else if (hasSummary) summaryOnly += row.waste;
  }
  const kinds = [...byKind.values()].map((b) => ({ ...b, cost: (b.waste * prices.miss) / 1e6 })).sort((a, b) => b.waste - a.waste);
  const find = (kind) => kinds.find((b) => b.kind === kind) ?? { waste: 0, n: 0, cost: 0 };
  return {
    rows: (rows ?? []).length,
    bRows,
    wasteTotal,
    wasteCost: (wasteTotal * prices.miss) / 1e6,
    kinds,
    /** 两次写落在**同一个**窗口 —— 本来就只有一次重读，合并的收益是 0。 */
    bothSameWindowTokens: bothSameWindow,
    pruneOnlyTokens: pruneOnly,
    summaryOnlyTokens: summaryOnly,
    otherWritesTokens: otherWrites,
    /** 冗余 prune 写：剪掉的节点本来就会被 summary 换掉。 */
    redundantWrites: redundant.size,
    redundantNodes: redundantNodes.size,
    mergeRows,
    /** 合并上界（token）= 窗口里只剩冗余 prune 写的那些请求的 waste。 */
    mergeCeilingTokens,
    mergeCeiling: (mergeCeilingTokens * prices.miss) / 1e6,
    /** 中间上界：窗口里**至少有一条**冗余 prune 写（但可能夹着别的写 ⇒ 省不到）。 */
    redundantWindowTokens,
    redundantWindowRows,
    /** 宽松上界：把所有 prune 写当冗余（**做不到**，prune 也在给保留尾巴瘦身）。 */
    looseCeiling: (find(WRITE_KINDS.PRUNE).waste * prices.miss) / 1e6,
    pruneWaste: find(WRITE_KINDS.PRUNE).waste,
    summaryWaste: find(WRITE_KINDS.SUMMARY).waste,
    ledgerWaste: find(WRITE_KINDS.LEDGER).waste,
    systemPromptWaste: find(WRITE_KINDS.SYSTEM_PROMPT).waste,
  };
}

/* ────────────────────────── 读日志 ────────────────────────── */

/** 从解压后的文本里抽事件（只留 `KEEP_TYPES`），按 seq 升序。 */
export function extractEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    const type = typeOfLine(line);
    if (type === null || !KEEP_TYPES.has(type)) continue;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(message);
  }
  events.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  return events;
}

/** 找 DSH_HOME 下所有 `session.v4.jsonl.zstd`（按体积降序）。 */
export function listSessionFiles(home) {
  const root = nodePath.join(String(home ?? ""), "sessions");
  if (String(home ?? "") === "" || !nodeFs.existsSync(root)) return [];
  const files = [];
  for (const workspace of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const dir = nodePath.join(root, workspace.name);
    let entries = [];
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of entries) {
      if (!session.isDirectory()) continue;
      const file = nodePath.join(dir, session.name, "session.v4.jsonl.zstd");
      try {
        if (!nodeFs.existsSync(file)) continue;
        files.push({ file, session: session.name, workspace: workspace.name, bytes: nodeFs.statSync(file).size });
      } catch {
        /* 权限 / 竞态：跳过 */
      }
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 扫一个 home（**只读**）。
 * @param {string} home
 * @param {{session?:string|null, maxSessions?:number, maxBytes?:number, onSession?:Function}} [opts]
 * @returns {object}
 */
export function scanHome(home, { session = null, maxSessions = Infinity, maxBytes = Infinity, onSession = null } = {}) {
  const all = listSessionFiles(home);
  const picked = session === null ? all : all.filter((f) => f.session.includes(session));
  const analyses = [];
  let bytes = 0;
  let scanned = 0;
  for (const entry of picked) {
    if (scanned >= maxSessions) break;
    if (bytes + entry.bytes > maxBytes && scanned > 0) break;
    let text = "";
    try {
      text = decodeMultiFrameZstd(nodeFs.readFileSync(entry.file)).text;
    } catch {
      continue;
    }
    const events = extractEvents(text);
    if (events.length === 0) continue;
    bytes += entry.bytes;
    scanned += 1;
    analyses.push({ ...analyzeSession(events, { session: entry.session }), bytes: entry.bytes, rows: requestRows(events) });
    if (typeof onSession === "function") {
      try {
        onSession({ session: entry.session, bytes: entry.bytes, scanned, total: picked.length });
      } catch {
        /* 进度回调坏掉不许影响审计 */
      }
    }
  }
  return { sessions: analyses, files: all.length, picked: picked.length, bytes, scanned };
}

/* ────────────────────────── 归属（钩子）取证 ────────────────────────── */

/**
 * ★ ⑦ 能不能干预：**在仓库自己的源码里**逐行找钩子，打上行号。
 *
 * 为什么要在脚本里现场读、而不是在报告里手写行号：手写的行号会漂（代码一动就错），
 * 而「我们有没有钩子」这个结论**必须**能被下一次运行重新证明。
 * @param {string} repoRoot
 * @returns {Array<{line:number, label:string, text:string}>}
 */
export function hookEvidence(repoRoot) {
  const file = nodePath.join(String(repoRoot ?? ""), "src", "engine.mjs");
  let lines = [];
  try {
    lines = nodeFs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  const wanted = [
    { pattern: /^\s*async compactIfNeeded\(/, label: "compactIfNeeded **重写**（不调 super ⇒ 我们能改顺序/条件）" },
    { pattern: /^\s*async compactRegion\(/, label: "compactRegion **重写**（入口）" },
    { pattern: /super\.compactRegion\(/, label: "compactRegion 把**写**交给宿主（summary 那一笔在 super 里）" },
    { pattern: /^\s*const prune = this\.ctx\.get\("toolResultPruner"\)/, label: "取宿主 pruner 服务" },
    { pattern: /prune\.pruneSession\(/, label: "**我们**调 pruneSession ⇒ prune 那一笔的时机在我们手里" },
  ];
  const found = [];
  for (const { pattern, label } of wanted) {
    lines.forEach((text, index) => {
      if (pattern.test(text)) found.push({ line: index + 1, label, text: text.trim().slice(0, 110) });
    });
  }
  return found.sort((a, b) => a.line - b.line);
}

/* ────────────────────────── 报告 ────────────────────────── */

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1)}%`);
const usd = (x) => `$${(Number(x) || 0).toFixed(2)}`;
const int = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "" || !nodeFs.existsSync(home)) {
    console.error("需要 DSH_HOME（或 --home <dir>）；当前为空或不存在。");
    return 2;
  }
  const session = getArg("session", null);
  const limit = Number(getArg("limit", "6"));
  const maxSessionsRaw = Number(getArg("max-sessions", "Infinity"));
  const maxBytesRaw = Number(getArg("max-bytes", String(1500 * 1024 * 1024)));
  const asJson = argv.includes("--json");
  const quiet = argv.includes("--quiet");

  const t0 = Date.now();
  const scan = scanHome(home, {
    session,
    maxSessions: Number.isFinite(maxSessionsRaw) ? maxSessionsRaw : Infinity,
    maxBytes: Number.isFinite(maxBytesRaw) ? maxBytesRaw : Infinity,
    onSession: quiet ? null : (e) => {
      if (e.scanned % 100 === 0) console.error(`  …扫到 ${e.scanned}/${e.total} 个会话（${((Date.now() - t0) / 1000) | 0}s）`);
    },
  });

  // —— 汇总（跨会话）——
  const allWrites = [];
  const allFolds = [];
  const allPrunes = [];
  const allRows = [];
  let orphanPrunes = 0;
  for (const s of scan.sessions) {
    allWrites.push(...s.writes);
    allPrunes.push(...s.pruneEvents);
    allRows.push(...s.rows);
    orphanPrunes += s.orphanPrunes.length;
    // contentRelation 要「本会话的 seq → 原始字符数」：把 map 挂到 fold 上，跨会话 seq 不会串。
    for (const fold of s.folds) allFolds.push({ ...fold, appendChars: s.appendChars });
  }
  const relation = contentRelation(allFolds);
  const pairing = pairingStats({ folds: allFolds, pruneEvents: allPrunes, orphanPrunes: { length: orphanPrunes } });
  const interval = intervalStats(allFolds);
  const ceiling = ceilingOf(allRows, allFolds);

  const writeKinds = new Map();
  for (const write of allWrites) writeKinds.set(write.writeKind, (writeKinds.get(write.writeKind) ?? 0) + 1);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          home,
          session,
          scannedSessions: scan.scanned,
          totalSessionFiles: scan.files,
          scannedBytes: scan.bytes,
          prices: PRICES,
          noiseTokens: NOISE_TOKENS,
          writeKinds: Object.fromEntries(writeKinds),
          pairing,
          interval: { n: interval.n, ms: interval.ms, events: interval.events },
          relation: { ...relation, perFold: relation.perFold.slice(0, 40) },
          ceiling,
          folds: allFolds.slice(0, 200).map((f) => ({
            session: f.session,
            compactionId: f.compactionId,
            startSeq: f.startSeq,
            endSeq: f.endSeq,
            durationMs: Math.max(0, (f.endTime || 0) - (f.startTime || 0)),
            precedingPrunes: f.precedingPrunes.length,
            precedingWrites: f.precedingWrites.length,
            insideWrites: f.writes.length,
            shadowedRange: f.shadowedRange,
            shadowedSeqs: f.shadowedSeqs.length,
            shadowedTokenCount: f.shadowedTokenCount,
            summaryChars: f.summaryChars,
            summaryUsage: f.summaryUsage,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log("== 折叠事务的 surface 写审计（只读） ==");
  console.log(`home: ${home}`);
  console.log(
    `扫到 ${scan.scanned} 个会话 / ${(scan.bytes / 1024 / 1024).toFixed(0)} MB` +
      `（磁盘上共 ${scan.files} 个会话文件）· 折叠 ${int(pairing.folds)} 次 · 用时 ${((Date.now() - t0) / 1000) | 0}s`,
  );
  console.log(`单价：miss $${PRICES.miss}/M · hit $${PRICES.hit}/M（= 1/${Math.round(PRICES.miss / PRICES.hit)}）· 判据：noise ≤ ${NOISE_TOKENS} token`);
  console.log("");
  console.log("   口径：**只有 `surfaceOp.op === \"replace\"` 才是写**（就地改写早期槽位 ⇒ 前缀作废）。");
  console.log("         `append` 只往尾部加，前缀缓存照常命中，不算。");
  console.log("");

  console.log("── ① 先证伪：`compaction/prune` 与 `compaction/summary` 不是写，是**定价事件** ──");
  console.log("   写              次数      说明");
  for (const [kind, n] of [...writeKinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(kind).padEnd(16)} ${String(n).padStart(7)}      ${WRITE_LABELS[kind] ?? kind}`);
  }
  console.log(`   （定价事件：compaction/prune ${int(pairing.pruneEvents)} 次 · compaction/summary ${int(pairing.summaryWritesTotal)} 次）`);
  console.log("   ⇒ 宿主源码：`pruneSession` 写 `tool/result`（tool-result-pruner/lib/index.js:167），");
  console.log("     `commitCompactionBody` 写 `user/message`（compaction-basic/lib/index.js:641）。");
  console.log("     `compaction/prune`（:159）与 `compaction/summary`（:634）只是**紧邻的定价/记账事件**。");
  console.log("");

  console.log("── ② 成对率：一次折叠几次写 ──");
  console.log(
    `   折叠 ${int(pairing.folds)} 次 · 括弧前有 prune 写 ${int(pairing.withPruneWrite)} 次（${pct(pairing.folds === 0 ? null : pairing.withPruneWrite / pairing.folds)}）` +
      ` · 括弧内有 summary 写 ${int(pairing.withSummaryWrite)} 次（${pct(pairing.folds === 0 ? null : pairing.withSummaryWrite / pairing.folds)}）`,
  );
  console.log(
    `   **两次写都有的折叠**：${int(pairing.both)} 次（${pct(pairing.bothRate)}）· 写合计 ${int(pairing.writesTotal)} 次` +
      `（prune 写 ${int(pairing.pruneWritesTotal)} + summary 写 ${int(pairing.summaryWritesTotal)}）`,
  );
  console.log(
    `   prune 定价事件 ${int(pairing.pruneEvents)} 次，其中后面真的走了折叠的 ${int(pairing.prunesFollowedByFold)} 次` +
      `（配对率 ${pct(pairing.prunePairRate)}）—— 其余是「剪枝后压力降到阈值以下 ⇒ 不折」。`,
  );
  console.log("   每次折叠的写次数分布：");
  for (const h of pairing.writeHistogram) console.log(`     ${String(h.writes).padStart(3)} 次写 → ${String(h.folds).padStart(5)} 次折叠`);
  console.log("");

  console.log("── ③ 间隔：prune 写 → summary 写 ──");
  console.log(
    `   样本 ${int(interval.n)} 组 · 毫秒 min ${int(interval.ms.min)} / p25 ${int(interval.ms.p25)} / 中位 ${int(interval.ms.median)}` +
      ` / p75 ${int(interval.ms.p75)} / max ${int(interval.ms.max)} / 均值 ${int(interval.ms.mean)}`,
  );
  console.log(
    `   中间事件数 min ${int(interval.events.min)} / 中位 ${int(interval.events.median)} / max ${int(interval.events.max)}` +
      ` ⇒ ${interval.events.median > 2 ? "**隔着别的轮次**（不是同一个事务内的两次写）" : "紧邻（同一事务）"}`,
  );
  for (const s of interval.samples.slice(0, limit)) {
    console.log(
      `     ${String(s.session).slice(0, 20).padEnd(20)} ${String(s.compactionId ?? "").slice(0, 8)} ` +
        `prune#${String(s.pruneSeq).padStart(6)} → summary#${String(s.summarySeq).padStart(6)}  ${String(s.ms).padStart(7)} ms  ${String(s.events).padStart(5)} 事件  (${s.pruneCount} 条 prune 写)`,
    );
  }
  console.log("");

  console.log("── ④ 内容关系：prune 删了什么、summary 换掉了什么 ──");
  console.log(
    `   被 prune 的节点 ${int(relation.prunedNodes)} 个 · 其中落在 summary 遮蔽区间内（**冗余写**）${int(relation.insideTotal)} 个` +
      `（${pct(relation.redundantRate)}）· 落在保留尾巴里 ${int(relation.outsideTotal)} 个`,
  );
  console.log(
    `   prune 合计删掉 ${int(relation.charsRemoved)} 字符（≈${int(relation.pruneTokens)} 阴影 token）；` +
      `summary 合计遮蔽 ${int(relation.summaryTokens)} token`,
  );
  const interesting = relation.perFold.filter((f) => f.prunedNodes > 0).slice(0, limit);
  if (interesting.length === 0) {
    console.log("   没有任何折叠带 prune 写。");
  } else {
    console.log("   会话                  折叠       prune写  被剪节点  区间内  区间外  prune删字符   summary遮蔽token  摘要字符");
    for (const f of interesting) {
      console.log(
        `   ${String(f.session).slice(0, 20).padEnd(20)} ${String(f.compactionId ?? "").slice(0, 8)} ${String(f.pruneWrites).padStart(7)} ` +
          `${String(f.prunedNodes).padStart(8)} ${String(f.inside.length).padStart(7)} ${String(f.outside.length).padStart(7)} ` +
          `${String(f.pruneCharsRemoved).padStart(12)} ${String(f.summaryShadowedTokens).padStart(17)} ${String(f.summaryChars).padStart(9)}`,
      );
    }
  }
  console.log(
    `   ⇒ ${relation.redundantRate === null ? "没有 prune 写，无从合并" : relation.redundantRate >= 0.5 ? "**大部分 prune 写是冗余的**（summary 的 replace 本来就会换掉那个节点）" : "**大部分 prune 写不冗余**（剪的是保留尾巴里的工具结果，summary 碰不到）"}`,
  );
  console.log("");

  console.log("── ⑤ 逐请求 waste 归因（T46 口径：waste = miss − 新增）──");
  console.log("   写种类                                    请求数        waste 合计      花费");
  for (const b of ceiling.kinds) {
    console.log(`   ${String(b.label).padEnd(40)} ${String(b.n).padStart(7)} ${int(b.waste).padStart(16)} ${usd(b.cost).padStart(10)}`);
  }
  if (ceiling.kinds.length === 0) console.log("   没有任何「带写的 none 请求」。");
  console.log(
    `   窗口归属：**同一窗口里既有 prune 又有 summary** ${int(ceiling.bothSameWindowTokens)} token（合并省 0）· ` +
      `只有 prune ${int(ceiling.pruneOnlyTokens)} · 只有 summary ${int(ceiling.summaryOnlyTokens)}`,
  );
  console.log(`   none 组 waste 合计 ${int(ceiling.wasteTotal)} token = ${usd(ceiling.wasteCost)}（${int(ceiling.rows)} 次请求，其中 ${int(ceiling.bRows)} 次带写）`);
  console.log("");

  console.log("── ⑥ 天花板 ──");
  console.log(`   prune 写那一份：${int(ceiling.pruneWaste)} token = **${usd((ceiling.pruneWaste * PRICES.miss) / 1e6)}**`);
  console.log(`   summary 写那一份：${int(ceiling.summaryWaste)} token = **${usd((ceiling.summaryWaste * PRICES.miss) / 1e6)}**`);
  console.log(`   热清单写（本仓 src/rooms/hot-inject.mjs）：${int(ceiling.ledgerWaste)} token = ${usd((ceiling.ledgerWaste * PRICES.miss) / 1e6)}`);
  console.log(`   system prompt 写（宿主）：${int(ceiling.systemPromptWaste)} token = ${usd((ceiling.systemPromptWaste * PRICES.miss) / 1e6)}`);
  console.log(`   ⇒ **合并两次写**能拿走的钱 = 冗余 prune 写那一份 = **${usd(ceiling.mergeCeiling)}**（${int(ceiling.mergeCeilingTokens)} token，${int(ceiling.mergeRows)} 次请求）`);
  console.log(`     （中间上界「窗口里至少一条冗余 prune 写」= ${usd((ceiling.redundantWindowTokens * PRICES.miss) / 1e6)} —— 那些窗口里还夹着别的写，省不到）`);
  console.log(`     （宽松上界「prune 写全算冗余」= ${usd(ceiling.looseCeiling)} —— 做不到，prune 也在给保留尾巴瘦身）`);
  console.log("");

  console.log("── ⑦ 归属：我们的 engine 有没有钩子 ──");
  const hooks = hookEvidence(nodePath.resolve(HERE, ".."));
  if (hooks.length === 0) {
    console.log("   读不到 src/engine.mjs（或里面没有预期的方法名）。");
  } else {
    for (const hook of hooks) console.log(`   src/engine.mjs:${hook.line}  ${hook.label}\n       ${hook.text}`);
  }
  console.log("   宿主侧（app.asar 内，只读引用）：");
  console.log("     @deepseek-ai/dsh-compaction-basic/lib/index.js:634  session.append(\"compaction/summary\", …)          ← 记账事件");
  console.log("     @deepseek-ai/dsh-compaction-basic/lib/index.js:641  session.append(\"user/message\", checkpoint, {surfaceOp:{op:\"replace\"}})  ← **写 2**");
  console.log("     @deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:159  session.append(\"compaction/prune\", …)   ← 记账事件");
  console.log("     @deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:167  session.append(\"tool/result\", …, {surfaceOp:{op:\"replace\"}})  ← **写 1**");
  console.log("   ⇒ **有钩子**：`compactIfNeeded` 整个被我们重写，`pruneSession` 是**我们**调的；");
  console.log(
    `     但「合并」要求两次写落在**同一个** surface 事务里 —— 实测中位相隔 ${int(interval.ms.median)} ms / ${int(interval.events.median)} 个事件；`,
  );
  console.log(
    `     而且 prune 剪掉的 ${int(relation.prunedNodes)} 个节点里有 ${int(relation.outsideTotal)} 个（${pct(relation.prunedNodes === 0 ? null : relation.outsideTotal / relation.prunedNodes)}）` +
      `不在 summary 的遮蔽区间内 —— 合并等于不剪。`,
  );
  console.log("");

  console.log("── 结论 ──");
  console.log(
    `   折叠 ${int(pairing.folds)} 次里，**两次写都发生**的只有 ${int(pairing.both)} 次（${pct(pairing.bothRate)}）——` +
      `「prune 与 summary 是同一次折叠的两次写」这个前提**只在少数折叠上成立**。`,
  );
  console.log(
    `   prune 定价事件 ${int(pairing.pruneEvents)} 次，只有 ${int(pairing.prunesFollowedByFold)} 次（${pct(pairing.prunePairRate)}）真的走到了折叠；` +
      `其余是「剪枝之后压力已达标 ⇒ 不折」——那是 prune 的**本职工作**，不是冗余。`,
  );
  console.log(
    `   **合并的天花板 ${usd(ceiling.mergeCeiling)}**（判据线 $3）⇒ ` +
      `${ceiling.mergeCeiling > 3 ? "可做，进最小改动" : `**不可做**：天花板 ${usd(ceiling.mergeCeiling)} 不到 $3，而且这点钱还要靠「少剪枝」换 —— 是产品取舍，不是 bug`}`,
  );
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(HERE, "compaction-writes-audit.mjs")) {
  process.exitCode = main();
}
