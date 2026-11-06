#!/usr/bin/env node
/**
 * degenerate-range-audit.mjs —— 「折叠区间退化」审计（T37 · **只读**）
 *
 * 由来（T35 收尾时留下的口子）：
 *   T35 修好了 `sanitizeSummaryIds` 的**界**（「未来」不再一律按 `range.end` 判），
 *   但真机里 58/60 条零锚点摘要的折叠区间长这样：
 *
 *     seq 8-8 · seq 9-9 · seq 11-11 · seq 7-7      ← 单事件折叠，区间里一个节点都没有
 *
 *   这不是 sanitize 的问题 —— 是**上游算出来的区间**本身就退化了：
 *   区间里没有任何节点（真机 125 条退化折痕里 125 条 `nodesInRange === 0`），
 *   而且大多连**一条 user/assistant 消息都没有**。
 *
 * 这个脚本只做四件事（全部机械可核对，不评分、不调模型、**不写任何文件**）：
 *   ① **量**：有多少条 foldMark 的区间是退化的（三条判据：区间内 0 个节点 / `seqStart === seqEnd` /
 *      跨度 < {@link MIN_SPAN} 事件），它们的 `trigger` / `summaryChars` / `quality` 分布；
 *   ② **对照**：正常区间（非退化）的摘要长度与质量分布，放在一起看差多少；
 *   ③ **覆盖**：退化区间声明覆盖了多少事件 vs 会话日志里到底有多少事件 ——
 *      回答「是不是只折了一小段就收工」；
 *   ④ **根因分类**（{@link classify}）：短会话（合法）/ 空区间 / 区间里没有可摘要消息 / 前缀缺口。
 *
 * 为什么必须「重放」而不是只读区间：
 *   `foldMark` 只记了 `seqStart/seqEnd`，**没记模型实际看到的范围**。所以这里用与生产同参
 *   （`maxChars = 60,000`、`perMessageChars = 2,000`、`fromSeq = seqStart`）重跑一遍
 *   `collectMessages` + `coverageOf`，看**当前代码**会把这一段算成什么：
 *     · 重放后仍然 `start === end` ⇒ 当前代码还在制造退化区间（**是 bug，不是历史**）；
 *     · 重放后 `start < end` 而历史记的是 `start === end` ⇒ 历史产物 + 现行为都指向同一个夹取。
 *
 * 边界：
 *   · **纯只读**：`graph.json` 与宿主会话日志都只 `readFileSync`，不写任何文件、不调模型；
 *   · 不 import 任何会写盘的函数（`applyOfflineFoldToGraph` 一律不碰）；
 *   · 会话日志按需解码（只解**有退化折痕**的会话），解完即弃，不驻留。
 *
 * 用法：
 *   node scripts/degenerate-range-audit.mjs                # 全量汇总 + 逐条
 *   node scripts/degenerate-range-audit.mjs --limit 20     # 逐条只看前 20 条（汇总仍是全量）
 *   node scripts/degenerate-range-audit.mjs --json         # 机器可读
 *   node scripts/degenerate-range-audit.mjs --home <DIR>   # 显式指定 DSH_HOME（默认读环境变量）
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { collectMessages, coverageOf } from "../src/rooms/offline-fold.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { anchorIds, countPlaceholders } from "./sanitize-anchor-audit.mjs";
import { resolveHome, resolveSummaryText } from "./summary-usability-audit.mjs";

/** 「跨度 < N 事件」里的 N —— 退化区间的第三条判据。 */
export const MIN_SPAN = 5;

/** 生产口径（与 `engine.mjs` 的 `chess.offlineMaxChars` / `collectMessages` 默认值同源）。 */
export const REPLAY_MAX_CHARS = 60_000;
export const REPLAY_PER_MESSAGE_CHARS = 2_000;

/** 只有这些 trigger 的折痕会写 `summaryText` / 走离线编排；其余照常统计但不参与根因。 */
export const OFFLINE_TRIGGERS = Object.freeze(["archive-offline"]);

/**
 * 一条折痕的正文（口径与 T33/T35 同源：`summaryText` → `summaryTextRef` → `lastOfflineSummary` 单槽）。
 * @param {object} mark
 * @param {object|null} lastOfflineSummary
 * @returns {string|null}
 */
export function summaryTextOf(mark, lastOfflineSummary) {
  return resolveSummaryText(mark, lastOfflineSummary).text;
}

/**
 * 会话日志的**可核对事实**（只算一遍，供该会话所有折痕复用）。
 *
 * @param {object} graph
 * @param {Array<object>} events 会话日志事件（解不出来就是空数组）
 * @returns {{logEvents:number, logMaxSeq:number|null, firstMessageSeq:number|null, lastMessageSeq:number|null,
 *            eventSeqs:number[], messageSeqs:number[], seqToId:Map<number,string>}}
 */
export function sessionFacts(graph, events) {
  const eventSeqs = [];
  const messageSeqs = [];
  for (const e of Array.isArray(events) ? events : []) {
    const seq = Number(e?.seq);
    if (!Number.isFinite(seq)) continue;
    eventSeqs.push(seq);
    if (e?.type === "user/message" || e?.type === "assistant/message") messageSeqs.push(seq);
  }
  eventSeqs.sort((a, b) => a - b);
  messageSeqs.sort((a, b) => a - b);
  const seqToId = new Map();
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    const id = typeof node?.id === "string" ? node.id : null;
    if (!Number.isFinite(seq) || id === null || id === "" || seqToId.has(seq)) continue;
    seqToId.set(seq, id);
  }
  return {
    logEvents: eventSeqs.length,
    logMaxSeq: eventSeqs.length > 0 ? eventSeqs[eventSeqs.length - 1] : null,
    firstMessageSeq: messageSeqs.length > 0 ? messageSeqs[0] : null,
    lastMessageSeq: messageSeqs.length > 0 ? messageSeqs[messageSeqs.length - 1] : null,
    eventSeqs,
    messageSeqs,
    // ★ C572 的 `nearestId` 依赖 Map，重放必须与生产同形（否则 id 前缀会缺）
    seqToId,
  };
}

/** 区间内的计数（闭区间；`seqs` 已升序）。 */
export function countInRange(sorted, start, end) {
  let n = 0;
  for (const seq of sorted) {
    if (seq < start) continue;
    if (seq > end) break;
    n += 1;
  }
  return n;
}

/**
 * 三条退化判据（任一成立即「退化」）。
 * @param {{start:number, end:number, nodesInRange:number}} row
 * @returns {{noNode:boolean, point:boolean, narrow:boolean, degenerate:boolean}}
 */
export function criteriaOf({ start, end, nodesInRange }) {
  const noNode = Number(nodesInRange) === 0;
  const point = start === end;
  const narrow = end - start + 1 < MIN_SPAN;
  return { noNode, point, narrow, degenerate: noNode || point || narrow };
}

/**
 * 根因分类（闭集）。
 *
 * 判据顺序有意义 —— 先排除「合法」，再判「算错」：
 *   · `short-session`：**会话日志本身就结束在区间内**（`logMaxSeq <= end`）⇒ 这是合法的短会话，
 *     不是 bug。此时「区间里没有节点」只是因为整个会话都没有节点。
 *   · `prefix-gap`：区间里**一条可摘要的消息都没有**，且区间整体早于第一条消息
 *     （`end < firstMessageSeq`）⇒ 典型的「缺口末端夹取」形状：`rangeStart..rangeEnd` 落在
 *     第一条消息之前的空档里，模型实际看到的是它**后面**那一整段。
 *   · `suffix-gap`：**镜像形状** —— 区间里没有消息，且区间整体晚于最后一条消息
 *     （`start > lastMessageSeq`）⇒ 尾部那一截（`lastFoldSeq + 1` 越过最后一条消息）永远折不出东西。
 *   · `between-messages`：区间里没有 user/assistant 消息，但区间夹在两条消息之间（空档）。
 *   · `point-range`：`seqStart === seqEnd`，但区间里**确实有**一条消息 —— 折的是真的，只是很薄。
 *   · `sparse-nodes`：跨度正常、区间里有消息，只是**图里的节点稀疏**（这段没有节点）——
 *     不是区间算错，是 `nodesInRange` 这条判据本身弱。
 *   · `other`：退化但不属于上面任何一类（要人看）。
 *
 * @param {{start:number, end:number, eventsInRange:number, messagesInRange:number,
 *          nodesInRange:number, logMaxSeq:number|null, firstMessageSeq:number|null,
 *          lastMessageSeq:number|null, degenerate:boolean}} row
 * @returns {string}
 */
export function classify(row) {
  if (!row.degenerate) return "normal";
  const logMax = row.logMaxSeq;
  if (logMax === null || logMax === undefined) return "no-log"; // 日志解不出来：不猜
  if (logMax <= row.end) return "short-session";
  if (row.messagesInRange === 0) {
    const first = row.firstMessageSeq;
    const last = row.lastMessageSeq;
    if (first !== null && first !== undefined && row.end < first) return "prefix-gap";
    if (last !== null && last !== undefined && row.start > last) return "suffix-gap";
    return "between-messages";
  }
  if (row.start === row.end) return "point-range";
  if (row.nodesInRange === 0) return "sparse-nodes";
  return "other";
}

/**
 * 重放：**当前代码**拿这一段的起点去取消息，会覆盖到哪。
 *
 * 为什么要重放：区间只说明「记了什么」，不说明「模型看了什么」。同一个 `fromSeq` 重跑
 * `collectMessages` + `coverageOf`，就能看出「声明的区间」与「实际喂给模型的跨度」差多少。
 *
 * @param {Array<object>} events
 * @param {object} facts `sessionFacts` 的结果
 * @param {{start:number, end:number}} range 折痕记录的区间
 * @returns {{messages:number, chars:number, start:number, end:number, promptCoveredEnd:number|null}}
 */
export function replay(events, facts, range) {
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Array.isArray(events) || events.length === 0 || !Number.isFinite(start) || !Number.isFinite(end)) {
    return { messages: 0, chars: 0, start, end, promptCoveredEnd: null };
  }
  const collected = collectMessages(events, {
    maxChars: REPLAY_MAX_CHARS,
    perMessageChars: REPLAY_PER_MESSAGE_CHARS,
    fromSeq: start,
    idBySeq: facts.seqToId,
  });
  const seqs = collected.messages.map((m) => m.seq).filter((x) => Number.isFinite(x));
  const cov = coverageOf({ rangeStart: start, rangeEnd: end, seqs });
  return {
    messages: collected.messages.length,
    chars: collected.chars,
    start: cov.start,
    end: cov.end,
    promptCoveredEnd: seqs.length > 0 ? Math.max(...seqs) : null,
  };
}

/**
 * 一条折痕的审计（纯函数）。
 * @param {object} mark
 * @param {object} graph
 * @param {Array<object>|null} events 会话日志（`null` = 没解）
 * @param {object|null} lastOfflineSummary
 * @param {object} facts `sessionFacts` 的结果
 * @param {{sessionId:string, dir:string}} meta
 * @returns {object}
 */
export function auditMark(mark, graph, events, lastOfflineSummary, facts, meta) {
  const start = Number(mark?.seqStart);
  const end = Number(mark?.seqEnd);
  const text = summaryTextOf(mark, lastOfflineSummary);
  const nodeSeqs = Object.values(graph?.nodes ?? {})
    .map((node) => Number(node?.seq))
    .filter((seq) => Number.isFinite(seq))
    .sort((a, b) => a - b);
  const nodesInRange = Number.isFinite(start) && Number.isFinite(end) ? countInRange(nodeSeqs, start, end) : 0;
  const eventsInRange = Number.isFinite(start) && Number.isFinite(end) ? countInRange(facts.eventSeqs, start, end) : 0;
  const messagesInRange = Number.isFinite(start) && Number.isFinite(end) ? countInRange(facts.messageSeqs, start, end) : 0;
  const ctx = criteriaOf({ start, end, nodesInRange });
  const row = {
    sessionId: String(meta?.sessionId ?? "?"),
    dir: String(meta?.dir ?? "?"),
    trigger: String(mark?.trigger ?? "(none)"),
    at: Number(mark?.at) || null,
    start,
    end,
    span: Number.isFinite(start) && Number.isFinite(end) ? end - start + 1 : null,
    nodesInRange,
    eventsInRange,
    messagesInRange,
    logEvents: facts.logEvents,
    logMaxSeq: facts.logMaxSeq,
    firstMessageSeq: facts.firstMessageSeq,
    lastMessageSeq: facts.lastMessageSeq,
    graphMaxSeq: nodeSeqs.length > 0 ? nodeSeqs[nodeSeqs.length - 1] : 0,
    summaryChars: Number.isFinite(Number(mark?.summaryChars)) ? Number(mark.summaryChars) : text === null ? null : text.length,
    summaryTokens: Number(mark?.quality?.summaryTokens) || null,
    sectionsPresent: Number(mark?.quality?.sectionsPresent) || null,
    constraintRecall: Number.isFinite(Number(mark?.quality?.constraintRecall)) ? Number(mark.quality.constraintRecall) : null,
    failureRecall: Number.isFinite(Number(mark?.quality?.failureRecall)) ? Number(mark.quality.failureRecall) : null,
    anchors: text === null ? null : anchorIds(text).length,
    placeholders: text === null ? null : countPlaceholders(text).total,
    ...ctx,
  };
  row.kind = classify(row);
  row.replay = events === null ? null : replay(events, facts, { start, end });
  /** 模型实际看到的跨度**越过了**记账区间（`promptCoveredEnd > seqEnd`）⇒ 区间少记了。 */
  row.promptBeyond =
    row.replay !== null && Number.isFinite(row.replay.promptCoveredEnd) && row.replay.promptCoveredEnd > end;
  return row;
}

/** 分位数（线性插值；空数组返回 null）。 */
export function quantile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = (list.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? list[lo] : list[lo] + (list[hi] - list[lo]) * (at - lo);
}

/** 一个桶组的摘要（长度 / 质量）。 */
export function describe(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const chars = list.map((row) => row.summaryChars);
  const tokens = list.map((row) => row.summaryTokens);
  return {
    marks: list.length,
    summaryChars: { p50: quantile(chars, 0.5), p90: quantile(chars, 0.9), min: quantile(chars, 0), max: quantile(chars, 1) },
    summaryTokens: { p50: quantile(tokens, 0.5), p90: quantile(tokens, 0.9) },
    sectionsPresent: { p50: quantile(list.map((row) => row.sectionsPresent), 0.5) },
    constraintRecall: { p50: quantile(list.map((row) => row.constraintRecall), 0.5) },
    failureRecall: { p50: quantile(list.map((row) => row.failureRecall), 0.5) },
    anchors: { p50: quantile(list.map((row) => row.anchors), 0.5) },
    placeholders: { sum: list.reduce((n, row) => n + (Number(row.placeholders) || 0), 0) },
  };
}

/**
 * 全库汇总（纯函数，便于单测）。
 * @param {Array<object>} rows `auditMark` 的行
 * @returns {object}
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const degenerate = list.filter((row) => row.degenerate === true);
  const normal = list.filter((row) => row.degenerate === false);
  const byTrigger = Object.create(null);
  for (const row of degenerate) byTrigger[row.trigger] = (byTrigger[row.trigger] ?? 0) + 1;
  const byKind = Object.create(null);
  for (const row of degenerate) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const replayRows = degenerate.filter((row) => row.replay !== null);
  // 「重放之后仍然是空区间」= 当前代码仍会写出一条退化折痕
  const stillDegenerate = replayRows.filter((row) => row.replay.start === row.replay.end);
  const grew = degenerate.filter((row) => row.promptBeyond === true);
  const claimedEvents = degenerate.reduce((n, row) => n + (Number(row.span) || 0), 0);
  // 分母：**这些会话**的日志事件总数（同一条会话的多条折痕会重复计，这里按会话去重）
  const sessions = new Map();
  for (const row of degenerate) sessions.set(row.dir, row.logEvents);
  const sessionEvents = [...sessions.values()].reduce((n, x) => n + (Number(x) || 0), 0);
  return {
    marks: list.length,
    degenerate: degenerate.length,
    normal: normal.length,
    criteria: {
      noNode: degenerate.filter((row) => row.noNode === true).length,
      point: degenerate.filter((row) => row.point === true).length,
      narrow: degenerate.filter((row) => row.narrow === true).length,
      allThree: degenerate.filter((row) => row.noNode && row.point && row.narrow).length,
    },
    byTrigger,
    byKind,
    degenerateSessions: sessions.size,
    claimedEvents,
    sessionEvents,
    replayed: {
      rows: replayRows.length,
      stillDegenerate: stillDegenerate.length,
      promptBeyondRange: grew.length,
      messages: quantile(replayRows.map((row) => row.replay.messages), 0.5),
      chars: quantile(replayRows.map((row) => row.replay.chars), 0.5),
    },
    describe: describe(degenerate),
    describeNormal: describe(normal),
    rows: list,
  };
}

/**
 * 只读扫全库。
 * @param {string} home DSH_HOME
 * @param {{decodeLogs?:boolean}} [options]
 * @returns {{rows:Array<object>, sessions:number, graphMarks:number}}
 */
export function scan(home, { decodeLogs = true } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  const rows = [];
  let sessions = 0;
  let graphMarks = 0;
  if (!nodeFs.existsSync(sessionsDir)) return { rows, sessions, graphMarks };
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
    } catch {
      continue; // 坏图跳过（不吞成「没有折痕」：sessions 计数只算读得出来的）
    }
    if (graph === null || typeof graph !== "object") continue;
    sessions += 1;
    const marks = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    graphMarks += marks.length;
    const sessionId = String(graph.sessionId ?? entry.name);
    // 先只按图算「退化」——只有退化的才需要解日志（解一次，整条会话复用）
    const nodeSeqs = Object.values(graph.nodes ?? {})
      .map((node) => Number(node?.seq))
      .filter((seq) => Number.isFinite(seq))
      .sort((a, b) => a - b);
    const needsLog = (mark) => {
      const start = Number(mark?.seqStart);
      const end = Number(mark?.seqEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
      return criteriaOf({ start, end, nodesInRange: countInRange(nodeSeqs, start, end) }).degenerate;
    };
    let events = null;
    let facts = null;
    const logFor = () => {
      if (facts !== null) return facts;
      if (!decodeLogs) {
        facts = sessionFacts(graph, []);
        return facts;
      }
      const logFile = findLog(home, entry.name);
      events = logFile === null ? [] : readSessionEvents(logFile);
      facts = sessionFacts(graph, events);
      return facts;
    };
    /** 不解日志时的「事实」：长度/质量都在 mark 上，正常区间用不到日志。 */
    const emptyFacts = () => sessionFacts(graph, []);
    for (const mark of marks) {
      // 正常区间不需要日志（长度/质量都在 mark 上）—— 只有退化的才解，避免 565 份日志全解一遍
      const factsForMark = needsLog(mark) ? logFor() : emptyFacts();
      rows.push(
        auditMark(mark, graph, needsLog(mark) ? events : null, graph.lastOfflineSummary ?? null, factsForMark, {
          sessionId,
          dir: entry.name,
        }),
      );
    }
  }
  return { rows, sessions, graphMarks };
}

/** 按会话目录名找日志（`<home>/sessions/**` 下含该名的 `*.zstd`）。 */
function findLog(home, dirName) {
  const root = nodePath.join(home, "sessions");
  let found = null;
  const walk = (dir) => {
    if (found !== null) return;
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found !== null) return;
      const p = nodePath.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd") && p.includes(dirName)) found = p;
    }
  };
  walk(root);
  return found;
}

/** 固定宽度打印（中文按 2 列宽）。 */
function pad(value, width) {
  const text = String(value ?? "");
  let shown = 0;
  for (const char of text) shown += char.charCodeAt(0) > 255 ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - shown));
}

function pct(part, total) {
  return total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;
}

function num(value) {
  return value === null || value === undefined ? "—" : String(Math.round(Number(value) * 10) / 10);
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const get = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : dflt;
  };
  const home = resolveHome(get("home"));
  const limitArg = Number(get("limit", "0"));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : Infinity;

  const { rows, sessions, graphMarks } = scan(home);
  const s = summarize(rows);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ home, sessions, graphMarks, ...s, rows: s.rows.filter((row) => row.degenerate) }, null, 2));
    return 0;
  }

  console.log("折叠区间退化审计（T37 · 只读 · 不写盘 · 不调模型）");
  console.log(`home            : ${home}`);
  console.log(`语料            : ${sessions} 会话 / ${graphMarks} 折痕（其中 ${s.degenerate} 条退化）`);
  console.log(`判据            : 区间内 0 节点 · seqStart === seqEnd · 跨度 < ${MIN_SPAN} 事件（任一成立即退化）`);
  console.log("");

  console.log("## 1. 退化区间统计");
  console.log("");
  console.log(`退化折痕        : ${s.degenerate} / ${s.marks}（${pct(s.degenerate, s.marks)}）· 分布在 ${s.degenerateSessions} 个会话`);
  console.log(`  · 区间内 0 节点 : ${s.criteria.noNode}（${pct(s.criteria.noNode, s.degenerate)}）`);
  console.log(`  · 单点区间      : ${s.criteria.point}（${pct(s.criteria.point, s.degenerate)}）`);
  console.log(`  · 跨度 < ${MIN_SPAN}     : ${s.criteria.narrow}（${pct(s.criteria.narrow, s.degenerate)}）`);
  console.log(`  · 三条全中      : ${s.criteria.allThree}（${pct(s.criteria.allThree, s.degenerate)}）`);
  console.log("");
  console.log(`按 trigger      : ${Object.entries(s.byTrigger).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
  console.log(
    `覆盖事件数      : 退化区间声明覆盖 ${s.claimedEvents} 事件 / 这些会话日志里共 ${s.sessionEvents} 事件（${pct(s.claimedEvents, s.sessionEvents)}）`,
  );
  if (s.replayed.rows > 0) {
    console.log(
      `重放（当前代码）: ${s.replayed.rows} 条 · 重放后仍 start === end **${s.replayed.stillDegenerate}** 条 · ` +
        `prompt 跨过 rangeEnd **${s.replayed.promptBeyondRange}** 条 · 中位 ${num(s.replayed.messages)} 条消息 / ${num(s.replayed.chars)} 字符`,
    );
  } else {
    console.log("重放（当前代码）: 无（没有解到日志）");
  }
  console.log("");

  console.log("## 2. 根因分类");
  console.log("");
  const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of kinds) {
    console.log(`  ${pad(kind, 18)}${pad(`${count} 条`, 10)}${pct(count, s.degenerate)}`);
  }
  console.log("");
  console.log("  判据（闭集，顺序有意义）：");
  console.log("    short-session    会话日志就结束在区间内（logMaxSeq <= seqEnd）⇒ **合法短会话，不是 bug**");
  console.log("    prefix-gap       区间里没有可摘要消息，且整体早于第一条消息 ⇒ 缺口末端夹取的形状（本次的根因）");
  console.log("    suffix-gap       镜像形状：区间里没有消息，且整体晚于最后一条消息（尾部再折也折不出东西）");
  console.log("    between-messages 区间里没有 user/assistant 消息，但夹在两条消息之间");
  console.log("    point-range      seqStart === seqEnd，但区间里确实有 1 条消息（薄，但没算错）");
  console.log("    sparse-nodes     跨度/消息都正常，只是这段图里没有节点（判据本身弱，不是区间 bug）");
  console.log("    other            退化但不属于上面任何一类（要人看）");
  console.log("");

  console.log(`## 3. 逐条（${s.degenerate} 条；全部列出，不截断）`);
  console.log("");
  console.log(
    "| # | 会话 | 区间(seq) | 跨度 | 触发 | 区间内节点 | 区间内事件 | 区间内消息 | 日志最大seq | 摘要字符 | 锚点 | 占位符 | 重放跨度 | prompt跨过rangeEnd | 分类 |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  s.rows
    .filter((row) => row.degenerate)
    .slice(0, limit)
    .forEach((row, index) => {
      const replaySpan = row.replay === null ? "—" : `${row.replay.start}-${row.replay.end}`;
      console.log(
        `| ${index + 1} | ${String(row.sessionId).replace(/^session-/, "").slice(0, 12)} | ${row.start}–${row.end} | ${num(row.span)} | ` +
          `${row.trigger} | ${row.nodesInRange} | ${row.eventsInRange} | ${row.messagesInRange} | ${row.logMaxSeq ?? "—"} | ` +
          `${row.summaryChars ?? "—"} | ${row.anchors ?? "—"} | ${row.placeholders ?? "—"} | ${replaySpan} | ` +
          `${row.promptBeyond === true ? "**是**" : row.promptBeyond === false ? "否" : "—"} | ${row.kind} |`,
      );
    });
  if (s.degenerate > limit) console.log(`\n…（--limit ${limit}，省略 ${s.degenerate - limit} 条）`);
  console.log("");

  console.log("## 4. 对照：退化 vs 正常（摘要长度 / 质量）");
  console.log("");
  console.log(`           | 条数 | 摘要字符 p50 / p90 | 摘要tok p50 | sections p50 | 约束召回 p50 | 死路召回 p50 | 真锚点 p50 | 占位符合计`);
  console.log(`退化区间   | ${pad(s.describe.marks, 4)} | ${pad(`${num(s.describe.summaryChars.p50)} / ${num(s.describe.summaryChars.p90)}`, 18)} | ` +
    `${pad(num(s.describe.summaryTokens.p50), 11)} | ${pad(num(s.describe.sectionsPresent.p50), 12)} | ${pad(num(s.describe.constraintRecall.p50), 12)} | ` +
    `${pad(num(s.describe.failureRecall.p50), 12)} | ${pad(num(s.describe.anchors.p50), 10)} | ${s.describe.placeholders.sum}`);
  console.log(`正常区间   | ${pad(s.describeNormal.marks, 4)} | ${pad(`${num(s.describeNormal.summaryChars.p50)} / ${num(s.describeNormal.summaryChars.p90)}`, 18)} | ` +
    `${pad(num(s.describeNormal.summaryTokens.p50), 11)} | ${pad(num(s.describeNormal.sectionsPresent.p50), 12)} | ${pad(num(s.describeNormal.constraintRecall.p50), 12)} | ` +
    `${pad(num(s.describeNormal.failureRecall.p50), 12)} | ${pad(num(s.describeNormal.anchors.p50), 10)} | ${s.describeNormal.placeholders.sum}`);
  console.log("");
  console.log(`（只读脚本，未写任何文件；不调模型 —— 摘要质量只能重算，本脚本不重算）`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
