/**
 * small-window.test.mjs —— 「每折一次都付整次模型调用」的小窗口守卫（T63）
 *
 * 由来（真机，重启后新代码 `6bc782c3aabb` 跑起来立刻暴露）：
 * 离线折痕 1,011 条里 **180 条跨度 < 20**（17.8%）、**129 条 < 5**（12.8%）、p10 = **1 个事件**；
 * 而每一次都是一次完整模型调用。`scripts/small-window-audit.mjs` 原样输出（本机同一份代码）：
 *
 * ```
 * 跨度 < 20：182 条（15.4%）· < 5：125 条（10.6%）· = 1（单点）：113 条（9.6%）
 * 成因：首折头部缺口 102 · 抖动（紧接上一条）41 · 中间空洞 29 · 跳折 9 · 重复折叠 1
 * 窗口里 0 条可折事件：131 条（72.0%）
 * 质量：可定位率 小窗口 0.058 vs 大窗口 0.787 · T33 6.76 vs 8.35
 * 反事实重放：小窗口 71 → 0（182 条全部合并成 ≥ 20 个事件的窗口）
 * ```
 *
 * 根因（引擎的窗口夹取，`src/engine.mjs` 的 `rangeEnd = min(maxSeq, gapEnd)`）：
 *   · 上一轮折叠留下**残留缺口** `offlineUncoveredHead = {from:9, events:7}`；
 *   · 下一轮把窗口算成 `[9, 15]`（7 个事件）—— 而 `fromHead` **不设上界**，
 *     模型照样读完整段会话（实测 p50 读 636 个事件）；
 *   · 账上只记 7 个事件 ⇒ 区间外的 id 全被 `sanitizeSummaryIds` 抹成 `n?`
 *     ⇒ 小窗口可定位率 0.058（大窗口 0.787）。**不是模型差，是账错。**
 *
 * 判据（T63 修法）：缺口**不够一次调用的门槛**（`closeoutMinEvents`，默认 40）⇒ **不夹取**，
 * 把缺口和它后面的未折尾巴**合并成一个窗口**（`rangeEnd = maxSeq`）；
 * 缺口 ≥ 门槛 ⇒ 逐字走 C575 原逻辑（C519 的大缺口语义一个字都不动）。
 *
 * 本文件守六条：
 *   ① **窗口**：`gap{from:9,events:7}` ⇒ 旧夹取 `[9,15]`（< 20）、新夹取 `[9,maxSeq]`（≥ 20）
 *   ② **端到端**：同一份事件跑 `runOfflineFold`，旧窗口产出 7 个事件的折痕、新窗口覆盖全部消息
 *   ③ **大缺口不变**：`events ≥ 门槛` 时两种口径**逐字相同**（C519/C575 不许被这次放宽动到）
 *   ④ **零门槛/配置**：`minEvents` 传给 `engineWindow` 就改行为（不硬编码 40）
 *   ⑤ **纯函数**：可折事件计数 / 五种成因 / 抖动连击（真机 `[9,284] → [8,8] → [9,15] → [16,1232]`）
 *   ⑥ **反回退**：`src/engine.mjs` 的夹取必须仍是「缺口 ≥ 门槛」才生效（改回去立刻红）
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { debtOfGraph, DEFAULT_MIN_EVENTS } from "../src/rooms/closeout-backfill.mjs";
import { runOfflineFold, applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";
import {
  countIn,
  classifyWindow,
  engineWindow,
  foldableSeqs,
  jitterRuns,
  replayMark,
  SMALL_SPAN,
} from "../scripts/small-window-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/* ───────────────────────────── 夹具 ───────────────────────────── */

/**
 * 真机形状（抄自 `<SESSION_ID>` / `<SESSION_ID>` / `<SESSION_ID>` 的实测区间）：
 *
 *   · seq 1–8 是 `session` / `sandbox/mode` / `step/start` 这类**非消息**事件；
 *   · 第一条 user 消息在 seq 9 ⇒ 首折会出现 `offlineUncoveredHead = {from:1, events:8}`；
 *   · 已经折过一段 `[9, 284]`，残留缺口 `{from:9, events:7}`（老代码折了 `[8,8]` 之后的样子）；
 *   · 图的最大 seq 远大于已折段（真机：折到 284、会话到 1232）。
 *
 * @param {{messages?:number, gapFrom?:number, gapEvents?:number, marks?:Array<object>}} [options]
 * @returns {{graph:object, events:Array<object>}}
 */
export function fixture({ messages = 1300, gapFrom = 9, gapEvents = 7, marks = null } = {}) {
  const first = 9;
  const events = [];
  for (let seq = 1; seq < first; seq += 1) events.push({ type: seq === 8 ? "system/message" : "step/start", seq, data: {} });
  for (let seq = first; seq < first + messages; seq += 1) {
    events.push({
      type: seq % 2 === 0 ? "user/message" : "assistant/message",
      seq,
      data: { message: { content: [{ type: "text", text: `第 ${seq} 步：读文件、跑测试、确认结论` }] } },
    });
  }
  const maxSeq = first + messages - 1;
  const nodes = {};
  for (let seq = first; seq <= maxSeq; seq += Math.max(1, Math.floor(messages / 8))) {
    nodes[`n${seq}`] = { id: `n${seq}`, seq, kind: seq % 2 === 0 ? "user" : "agent", text: `节点 ${seq}` };
  }
  // 最大节点必须在最后一条消息上（否则 `maxSeq` 比会话短，窗口终点对不上）
  nodes[`n${maxSeq}`] = { id: `n${maxSeq}`, seq: maxSeq, kind: "agent", text: `节点 ${maxSeq}` };
  const foldMarks =
    marks ??
    [
      {
        at: 1_800_000_000_000,
        seqStart: first,
        seqEnd: first + 275,
        trigger: "archive-offline",
        shadowedTokens: 3390,
        summaryChars: 6000,
        quality: { constraintRecall: 1, failureRecall: 1, summaryTokens: 2800, sectionsPresent: 2 },
      },
    ];
  const graph = {
    version: 1,
    sessionId: "session-t63-small-window",
    rootUserNodeIds: [`n${first}`],
    nodes,
    edges: {},
    foldMarks: foldMarks.map((m) => ({ ...m })),
    closeout: {
      at: 1_800_000_000_000,
      source: "archive-offline",
      foldAttempted: true,
      folded: 1,
      foldOffline: true,
      partial: true,
      // ★ 残留缺口：老代码折了 [8,8] 之后，游标推到 9、只剩 7 个事件
      offlineUncoveredHead: { from: gapFrom, events: gapEvents },
    },
    lastOfflineSummary: { at: 1_800_000_000_000, range: { start: first, end: first + 275 }, text: "## 目标\n- 旧摘要" },
  };
  return { graph, events };
}

/** 假模型：确定性、不联网。 */
const fakeModel = async () => ({
  text: "## 目标\n- 合成摘要\n\n## 棋谱（状态节点）\n- n9 合成\n\n## 原始坐标（本段）\n- 本段遮蔽 seq 9-15",
  usage: { inputTokens: 15_000, outputTokens: 500 },
  model: "fake",
  finish: "stop",
});

const messageSeqs = (events) =>
  events.filter((e) => e.type === "user/message" || e.type === "assistant/message").map((e) => Number(e.seq)).sort((a, b) => a - b);

/* ─────────────────────── ① 纯函数：可折事件 ─────────────────────── */

tests["T63 ① 可折事件只认 user/assistant/tool —— 头部 8 个非消息事件不算内容"] = (t) => {
  const { events } = fixture({ messages: 40 });
  const seqs = foldableSeqs(events);
  t.eq(seqs[0], 9, "第一条可折事件在 seq 9（1–8 是 session/step/system）");
  t.eq(seqs.length, 40, "40 条消息");
  t.eq(countIn(seqs, 1, 8), 0, "窗口 1–8 里一条可折事件都没有（这就是「账上虚构」）");
  t.eq(countIn(seqs, 9, 15), 7, "窗口 9–15 里有 7 条");
  t.eq(countIn(seqs, 9, 2000), 40, "越界也只会数到实际条数");
  t.eq(countIn(seqs, 2000, 3000), 0, "空区间 = 0");
};

/* ─────────────────────── ② 窗口：旧 vs 新 ─────────────────────── */

tests["T63 ② 小缺口不许当窗口：gap{from:9,events:7} ⇒ 旧 [9,15]（< 20）/ 新 [9,maxSeq]（≥ 20）"] = (t) => {
  const { graph } = fixture();
  const debt = debtOfGraph(graph);
  t.eq(debt.gap, { from: 9, events: 7 }, "前提：残留缺口 7 个事件（真机形状）");
  t.eq(debt.lastFoldSeq, 284, "前提：已折到 284");
  t.eq(debt.maxSeq, 1308, "前提：会话到 1308");

  const old = engineWindow(debt, "old");
  const neu = engineWindow(debt, "new");
  t.eq({ start: old.rangeStart, end: old.rangeEnd }, { start: 9, end: 15 }, "旧夹取把窗口压成 9–15（7 个事件）");
  t.eq(old.rangeEnd - old.rangeStart + 1, 7, "旧窗口跨度 7 < 20 ⇒ 就是「纯浪费的调用」");
  t.eq(neu.rangeStart, 9, "新口径起点不变（还是从缺口起）");
  t.eq(neu.rangeEnd, 1308, "新口径把窗口扩到 maxSeq（与未折尾巴合并）");
  t.ok(neu.rangeEnd - neu.rangeStart + 1 >= SMALL_SPAN, `新窗口跨度 ${neu.rangeEnd - neu.rangeStart + 1} ≥ ${SMALL_SPAN}`);
};

tests["T63 ③ 大缺口逐字不变：events ≥ 门槛时两种口径完全相同（C519/C575 语义）"] = (t) => {
  for (const gapEvents of [DEFAULT_MIN_EVENTS, 300, 8000]) {
    const { graph } = fixture({ messages: 9000 + 300, gapFrom: 21, gapEvents, marks: [{ at: 1, seqStart: 21 + gapEvents, seqEnd: 8900, trigger: "archive-offline" }] });
    const debt = debtOfGraph(graph);
    const old = engineWindow(debt, "old");
    const neu = engineWindow(debt, "new");
    t.eq({ s: neu.rangeStart, e: neu.rangeEnd }, { s: old.rangeStart, e: old.rangeEnd }, `缺口 ${gapEvents} ≥ 门槛 ⇒ 两种口径必须一致`);
    t.eq(neu.rangeEnd, 21 + gapEvents - 1, `缺口 ${gapEvents}：窗口仍夹到缺口末端（不许把已折尾巴塞进来）`);
  }
};

tests["T63 ④ 门槛可配：minEvents 传进去就改行为（不硬编码 40）"] = (t) => {
  const { graph } = fixture({ gapFrom: 9, gapEvents: 30 });
  const debt = debtOfGraph(graph);
  t.eq(engineWindow(debt, "new", 40).rangeEnd, debt.maxSeq, "门槛 40：30 < 40 ⇒ 合并");
  t.eq(engineWindow(debt, "new", 10).rangeEnd, 9 + 30 - 1, "门槛 10：30 ≥ 10 ⇒ 仍按 C575 夹到缺口末端");
};

/* ─────────────────── ⑤ 成因 / 抖动（真机形状） ─────────────────── */

tests["T63 ⑤ 五种成因：首折头部缺口 / 中间空洞 / 抖动 / 重复折叠 / 跳折"] = (t) => {
  t.eq(classifyWindow({ start: 1, end: 8, prev: null, content: 0 }), "head-gap", "首折 + 0 条可折事件");
  t.eq(classifyWindow({ start: 2146, end: 2146, prev: { seqEnd: 2121 }, content: 0 }), "empty", "中间空洞 + 0 条可折事件");
  t.eq(classifyWindow({ start: 2148, end: 2148, prev: { seqEnd: 2147 }, content: 1 }), "contiguous", "紧接上一条 ⇒ 抖动");
  t.eq(classifyWindow({ start: 10, end: 17, prev: { seqEnd: 15 }, content: 8 }), "overlap", "与上一条重叠 ⇒ 重复折叠");
  t.eq(classifyWindow({ start: 2149, end: 2155, prev: { seqEnd: 2140 }, content: 7 }), "jump", "中间隔着非消息事件 ⇒ 跳折");
};

tests["T63 ⑥ 抖动检测：真机 [9,284] → [8,8] → [9,15] → [16,1232] 必须被认成一条连击"] = (t) => {
  const marks = [
    { seqStart: 9, seqEnd: 284 },
    { seqStart: 8, seqEnd: 8 },
    { seqStart: 9, seqEnd: 15 },
    { seqStart: 16, seqEnd: 1232 },
  ];
  const runs = jitterRuns(marks, { small: 20 });
  t.eq(runs.length, 1, "一条连击（不是四条独立事件）");
  t.eq(runs[0].marks, [0, 1, 2, 3], "四个折痕首尾相接");
  t.eq(runs[0].spans, [276, 1, 7, 1217], "其中两条 < 20（1 和 7）—— 这就是「折完又留尾巴」");
  t.eq(jitterRuns([{ seqStart: 9, seqEnd: 284 }, { seqStart: 375, seqEnd: 687 }], { small: 20 }).length, 0, "不紧接的两段不算连击");
};

/* ─────────────────── ② 端到端：真编排 + 真写回 ─────────────────── */

tests["T63 ⑦ 端到端：旧窗口折出 7 个事件的折痕，新窗口覆盖全部消息（内容一条不丢）"] = async (t) => {
  const { graph, events } = fixture();
  const seqs = messageSeqs(events);
  const debt = debtOfGraph(graph);
  const old = engineWindow(debt, "old");
  const neu = engineWindow(debt, "new");

  const run = async (rangeStart, rangeEnd) =>
    runOfflineFold({
      graph,
      events,
      rangeStart,
      rangeEnd,
      maxChunks: 1,
      fromHead: true,
      callModel: fakeModel,
      measureQuality: () => ({ constraintRecall: 1, failureRecall: 1, summaryTokens: 10, sectionsPresent: 2 }),
    });

  const oldRun = await run(old.rangeStart, old.rangeEnd);
  const oldChunk = oldRun.chunks[oldRun.chunks.length - 1];
  t.eq(oldChunk.end - oldChunk.start + 1, 7, "旧口径：折痕只记 7 个事件（< 20 ⇒ 小窗口）");
  t.eq(oldChunk.messages, seqs.length, "但模型实际读了**全部**消息 —— 账与实严重不符");

  const newRun = await run(neu.rangeStart, neu.rangeEnd);
  const newChunk = newRun.chunks[newRun.chunks.length - 1];
  t.ok(newChunk.end - newChunk.start + 1 >= SMALL_SPAN, `新口径：折痕跨度 ${newChunk.end - newChunk.start + 1} ≥ ${SMALL_SPAN}`);
  t.eq(newChunk.start, seqs[0], "新口径起点 = 第一条被折的消息");
  // 窗口终点受**字符预算**（60,000 字符）约束，不是 maxSeq —— 这一点与生产一致，不许假装装得下
  t.ok(newChunk.end > newChunk.start + 1000, `新口径覆盖 ${newChunk.end - newChunk.start + 1} 个事件（不是 7 个）`);
  t.ok(newChunk.messages > 1000, `读到的消息 ${newChunk.messages} 条（> 1000）`);
  t.eq(oldChunk.messages, newChunk.messages, "两种口径读到的消息条数相同（**没有**为了合并多付一次钱）");
};

tests["T63 ⑧ 写回：合并后 closeout 不再留小缺口（否则下一轮还会再折一个 sliver）"] = async (t) => {
  const { graph, events } = fixture();
  const debt = debtOfGraph(graph);
  const neu = engineWindow(debt, "new");
  const result = await runOfflineFold({
    graph,
    events,
    rangeStart: neu.rangeStart,
    rangeEnd: neu.rangeEnd,
    maxChunks: 1,
    fromHead: true,
    callModel: fakeModel,
    measureQuality: () => null,
  });
  applyOfflineFoldToGraph(graph, result, {
    rangeStart: neu.rangeStart,
    rangeEnd: neu.rangeEnd,
    previousGapEvents: Number(debt.gap.events),
    provider: "fake",
    model: "fake",
  });
  const mark = graph.foldMarks[graph.foldMarks.length - 1];
  t.ok(mark.seqEnd - mark.seqStart + 1 >= SMALL_SPAN, `写回的是大窗口（${mark.seqStart}-${mark.seqEnd}），不是 sliver`);
  t.eq(graph.closeout.offlineUncoveredHead, undefined, "残留缺口被这次折叠吃干净（不会每轮再折一个 1–8 事件的窗口）");
  t.eq(debtOfGraph(graph).due, false, "折完这一笔账就结清了");
};

/* ─────────────────── ⑥ 反回退：生产代码必须仍是这个判据 ─────────────────── */

tests["T63 ⑨ 反回退：src/engine.mjs 的 rangeEnd 夹取必须带「缺口 ≥ 门槛」闸门"] = (t) => {
  const source = nodeFs.readFileSync(nodePath.join(REPO, "src", "engine.mjs"), "utf8");
  t.includes(source, "const gapWorthFolding = gapEventsForEnd >= (Number(this.chess.closeoutMinEvents) || 40);", "闸门表达式在（改回 min 就会红）");
  t.includes(
    source,
    "const rangeEnd = gapEnd > 0 && gapWorthFolding ? Math.min(rangeEndRaw, gapEnd) : rangeEndRaw;",
    "rangeEnd 只在「缺口够大」时才夹取",
  );
};

/* ─────────────────── 反事实重放（scripts 侧，真函数） ─────────────────── */

tests["T63 ⑩ 反事实重放：重建态下 old 仍 < 20、new 合并成 ≥ 20（且内容不丢）"] = async (t) => {
  const { graph, events } = fixture();
  const marks = graph.foldMarks;
  const seqs = foldableSeqs(events);
  // 真机的第 2、3 条折痕（[8,8] 之后是 [9,15]）—— 取最后一步来重放
  marks.push({ at: 1_800_000_000_001, seqStart: 9, seqEnd: 15, trigger: "archive-offline" });
  const oldRun = await replayMark({ graph, events, marks, index: 1, clamp: "old", minEvents: DEFAULT_MIN_EVENTS, seqs });
  const newRun = await replayMark({ graph, events, marks, index: 1, clamp: "new", minEvents: DEFAULT_MIN_EVENTS, seqs });
  t.eq(oldRun.recorded, { start: 9, end: 15, span: 7 }, "重放目标 = 真机那条 7 事件折痕");
  t.eq(oldRun.exact, true, "重建忠实度：old 口径必须复现记录区间 [9,15]");
  t.eq(oldRun.chunk.span, 7, "old：仍产出 7 个事件的窗口（< 20）");
  t.ok(newRun.chunk.span >= SMALL_SPAN, `new：合并成 ${newRun.chunk.span} 个事件的窗口（≥ ${SMALL_SPAN}）`);
  t.ok(newRun.chunk.content > 1000, `new：窗口里装着 ${newRun.chunk.content} 条可折事件（不是空窗口）`);
  // 代价说清楚：合并后的窗口**包含**已折的 [9,284]（T37 早就记录过这个取舍 ——「错的是账，不是
  // 模型看到的输入」）。区别是：旧口径把这段重读记成 `[9,15]`（区间外 id 全被抹成 `n?`），
  // 新口径如实记成 `[9,1308]` —— 同样的钱，账是诚实的、id 活下来了。
  t.eq(newRun.overlap, true, "new：窗口覆盖已折段（同一笔钱，旧口径也读了它，只是记成了 7 个事件）");
};
