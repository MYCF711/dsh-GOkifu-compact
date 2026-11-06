/**
 * degenerate-range.test.mjs —— 「折叠区间退化」守卫（T37）
 *
 * 由来（T35 只加了兜底，上游还在算错）：
 *   真机 125 条退化折痕里，107 条是 `seqStart === seqEnd` 的单点区间（`seq 8-8` / `9-9` / `11-11`），
 *   而**区间里一条 user/assistant 消息都没有**（`node scripts/degenerate-range-audit.mjs` 原样输出）：
 *
 *     | <SESSION_ID>-ed1 | 8–8 | 跨度 1 | 区间内事件 1 | 区间内消息 0 | 日志最大seq 503 | 摘要 5973 字符 |
 *
 *   ⇒ 模型实际看的是整个会话（重放：中位 140 条消息 / 25,637 字符），账上只记了 1 个事件。
 *   这不是「短会话」：同一个会话的日志有 500–1500 个事件。
 *
 * 根因（`src/rooms/offline-fold.mjs` 的 `coverageOf`）：
 *   它把「实际收集到的消息跨度」**夹进欠账区间** `[rangeStart, rangeEnd]`：
 *
 *     const start = Math.max(rangeStart, Math.min(coveredStart, rangeEnd));   // ← 起点被压到 rangeEnd
 *     const end   = Math.max(start, Math.min(rangeEnd, coveredEnd));
 *
 *   当前缀缺口（`closeout.offlineUncoveredHead = {events: 8, from: 1}`）整段落在**第一条消息之前**时，
 *   `coveredStart (9) > rangeEnd (8)` ⇒ `start = 8`、`end = 8` ⇒ 区间塌成一点。
 *   `fromHead` 模式的 `collectMessages` 又**不设上界**（C522：补缺口必须从头取），于是 prompt 里是
 *   整个会话、账上是一步 —— T35 的界（`span.end <= range.end` 的最后一个实体）取不到，锚点全被抹成 `n?`。
 *
 * 不变量（本文件钉住）：
 *   **只要这一段真的折到了消息，报出的 `[start, end]` 就必须与那些消息的 seq 有交集。**
 *   旧代码在「消息整体落在 rangeEnd 之后」时违反它（`[8,8] ∩ [9..501] = ∅`）。
 */
import { applyOfflineFoldToGraph, coverageOf, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { MIN_SPAN, classify, criteriaOf } from "../scripts/degenerate-range-audit.mjs";

export const tests = {};

/** 一条 user/assistant 消息（`collectMessages` 只认这两种 type 的文本）。 */
const msg = (seq, role, text) => ({ type: role === "user" ? "user/message" : "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/**
 * 真机形状的合成夹具。
 *
 * 关键尺寸都抄自真机（`<SESSION_ID>` / `<SESSION_ID>`）：
 *   · 前 9 个事件（seq 0–8）是 session / system 之类，**没有一条可摘要消息**；
 *   · 第一条消息在 seq 9（所以前缀缺口 = `[1, 8]`，8 个事件）；
 *   · 节点稀疏（seq 9 / 30 / …），最大节点 seq 小于最后一条消息（真机 499 vs 503）；
 *   · 已经有一条 9-249 的折痕（第一段折过），余下 `offlineUncoveredHead = {events: 8, from: 1}`。
 *
 * @param {{messages?:number, maxNodeSeq?:number}} [options]
 * @returns {{graph:object, events:Array<object>}}
 */
export function fixture({ messages = 120, maxNodeSeq = 120 } = {}) {
  const events = [];
  for (let seq = 0; seq <= 8; seq += 1) events.push({ type: seq === 8 ? "system/message" : "step/start", seq, data: {} });
  for (let i = 0; i < messages; i += 1) {
    const seq = 9 + i;
    events.push(msg(seq, i % 2 === 0 ? "user" : "assistant", `第 ${seq} 步：读文件、跑测试、确认结论`));
  }
  const nodes = {};
  const edges = {};
  for (let seq = 9; seq <= maxNodeSeq; seq += Math.max(1, Math.floor((maxNodeSeq - 9) / 6) || 1)) {
    nodes[`n${seq}`] = { id: `n${seq}`, seq, kind: "user", text: `节点 ${seq}` };
  }
  const graph = {
    version: 1,
    sessionId: "session-t37-degenerate",
    rootUserNodeIds: ["n9"],
    nodes,
    edges,
    foldMarks: [
      {
        at: 1_800_000_000_000,
        seqStart: 9,
        seqEnd: 249,
        trigger: "archive-offline",
        summaryChars: 6000,
        quality: { constraintRecall: 1, failureRecall: 1, summaryTokens: 2800, sectionsPresent: 2 },
      },
    ],
    closeout: {
      at: 1_800_000_000_000,
      source: "archive-offline",
      foldAttempted: true,
      folded: 1,
      foldOffline: true,
      offlineCovered: { start: 9, end: 249 },
      partial: true,
      // ★ 前缀缺口：`uncoveredHead = start - rangeStart = 9 - 1 = 8`，游标被推到 1
      offlineUncoveredHead: { events: 8, from: 1 },
    },
    lastOfflineSummary: { at: 1_800_000_000_000, range: { start: 9, end: 249 }, text: "## 目标\n- 旧摘要" },
  };
  return { graph, events };
}

/**
 * 引擎算 `rangeStart / rangeEnd` 的那几行（`src/engine.mjs:2471-2487` 逐行照抄）。
 *
 * 为什么照抄而不是 import：那几行是 `#offlineCloseoutFold` 的内联代码，没有导出。
 * 本文件要复现的是**同一个欠账区间**喂给 `runOfflineFold` 之后区间怎么塌 —— 输入必须同源。
 * @param {object} graph
 * @returns {{debt:object, rangeStart:number, rangeEnd:number}}
 */
export function engineRange(graph) {
  const debt = debtOfGraph(graph);
  const gapFrom = Number(debt?.gap?.from ?? 0);
  const hasGapFrom = Number.isFinite(gapFrom) && gapFrom > 0;
  const rangeStart = hasGapFrom ? gapFrom : debt.lastFoldSeq === null || debt.lastFoldSeq === undefined ? 1 : Number(debt.lastFoldSeq) + 1;
  const gapFromForEnd = Number(debt?.gap?.from ?? 0);
  const gapEventsForEnd = Number(debt?.gap?.events ?? 0);
  const gapEnd = gapFromForEnd > 0 && gapEventsForEnd > 0 ? gapFromForEnd + gapEventsForEnd - 1 : 0;
  const rangeEndRaw = Number(debt.maxSeq) || 0;
  const rangeEnd = gapEnd > 0 ? Math.min(rangeEndRaw, gapEnd) : rangeEndRaw;
  return { debt, rangeStart, rangeEnd };
}

/** 假模型：确定性返回，不联网。 */
const fakeModel = async () => ({ text: "## 目标\n- 合成摘要\n\n## 原始坐标\n- 本段遮蔽 seq 1-8", usage: { inputTokens: 100, outputTokens: 50 }, model: "fake" });

/** 这一段的 user/assistant 消息 seq（升序）。 */
function messageSeqs(events) {
  return events.filter((e) => e.type === "user/message" || e.type === "assistant/message").map((e) => Number(e.seq)).sort((a, b) => a - b);
}

tests["T37 前缀缺口 [1,8] 里一条消息都没有：区间不许塌成 seq 8-8"] = async (t) => {
  const { graph, events } = fixture({ messages: 120, maxNodeSeq: 120 });
  const { rangeStart, rangeEnd } = engineRange(graph);
  // 前提：这条会话的欠账区间就是真机那个形状
  t.eq(rangeStart, 1, "欠账区间从缺口游标 1 开始");
  t.eq(rangeEnd, 8, "缺口末端 = 1 + 8 - 1 = 8（整段早于第一条消息 seq 9）");

  const result = await runOfflineFold({
    graph,
    events,
    rangeStart,
    rangeEnd,
    maxChunks: 1,
    fromHead: true,
    callModel: fakeModel,
    measureQuality: () => ({ constraintRecall: 1, failureRecall: 1, summaryTokens: 10, sectionsPresent: 2 }),
  });

  t.eq(result.chunks.length, 1, "这一段是折了的（模型真的看到了消息）");
  const chunk = result.chunks[0];
  const seqs = messageSeqs(events);
  // ★ 旧代码在这里是 8-8：区间里**一条消息都没有**，与「这一段折过」自相矛盾
  t.eq(chunk.start === chunk.end, false, `折叠区间塌成一点：${chunk.start}-${chunk.end}（区间里一条 user/assistant 消息都没有）`);
  t.ok(
    seqs.some((seq) => seq >= chunk.start && seq <= chunk.end),
    `报出的区间 ${chunk.start}-${chunk.end} 与「被折的消息」没有交集（消息 seq ${seqs[0]}..${seqs[seqs.length - 1]}）`,
  );
  t.eq(chunk.start, seqs[0], "起点 = 第一条被折的消息");
  t.eq(chunk.end, seqs[seqs.length - 1], "终点 = 最后一条被折的消息（模型看全了，账上就得这么记）");
  // 覆盖率也必须跟着对上：覆盖 0 个事件 = 什么也没记
  t.eq(result.coveredStart, seqs[0], "coveredStart 与 chunk.start 同源");
  t.eq(result.coveredEnd, seqs[seqs.length - 1], "coveredEnd 与 chunk.end 同源");
};

tests["T37 写回：折痕记的必须是真折过的那段，缺口要清掉（否则同一段永远重折）"] = async (t) => {
  const { graph, events } = fixture({ messages: 120, maxNodeSeq: 120 });
  const { rangeStart, rangeEnd } = engineRange(graph);
  const result = await runOfflineFold({
    graph,
    events,
    rangeStart,
    rangeEnd,
    maxChunks: 1,
    fromHead: true,
    callModel: fakeModel,
    measureQuality: () => ({ constraintRecall: 1, failureRecall: 1, summaryTokens: 10, sectionsPresent: 2 }),
  });
  const seqs = messageSeqs(events);
  applyOfflineFoldToGraph(graph, result, { rangeStart, rangeEnd, previousGapEvents: 8, provider: "fake", model: "fake" });

  const mark = graph.foldMarks[graph.foldMarks.length - 1];
  t.eq(mark.seqStart, seqs[0], "折痕起点 = 第一条被折的消息");
  t.eq(mark.seqEnd, seqs[seqs.length - 1], "折痕终点 = 最后一条被折的消息");
  t.eq(mark.seqEnd - mark.seqStart + 1 >= 100, true, "这一段真折了 100+ 个事件（不是「折了一步就收工」）");
  // 缺口：这次真压掉的事件数把 8 个事件的缺口吃干净 ⇒ 不许再留 `offlineUncoveredHead`
  t.eq(graph.closeout.offlineUncoveredHead, undefined, "缺口必须清零（真机旧行为留下 {events:7, from:9}，于是同一段被反复重折）");
  // 记账坐标也要是**真折过的那段**（旧行为记 8-8：整段都在它之后，谁也对不上）
  t.eq(graph.closeout.offlineCovered, { start: seqs[0], end: seqs[seqs.length - 1] }, "closeout 的覆盖坐标 = 实际跨度");
  // 注意：`partial` 仍然是 true —— 前缀 8 个事件（seq 1-8）确实**没有**被折过（那里没有消息可折）。
  //   这不是「没折完」的债：`remainingGap` 用的是「这次真压掉多少事件」，缺口游标不会再回来，
  //   所以 `debtOfGraph` 判结清。把 partial 当成 bug 去抹掉，反而会在真有缺口时撒谎。
  t.eq(debtOfGraph(graph).due, false, "折完这一笔账就结清了（不会每轮重折同一段）");
};

tests["T37 不变量：消息跨度与欠账区间不相交时，报出的必须是实际跨度（不许虚构一点）"] = (t) => {
  /** 各种形状：消息在区间内 / 跨出区间 / 整体在区间之后 / 整体在区间之前。 */
  const cases = [
    { name: "区间内（旧行为，必须逐字不变）", input: { rangeStart: 100, rangeEnd: 500, seqs: [480, 490, 500] }, want: { start: 480, end: 500 } },
    { name: "全覆盖", input: { rangeStart: 100, rangeEnd: 500, seqs: [100, 300, 500] }, want: { start: 100, end: 500 } },
    { name: "越界夹取（C491 的原始契约，必须保住）", input: { rangeStart: 100, rangeEnd: 200, seqs: [50, 999] }, want: { start: 100, end: 200 } },
    // ★ 退化形状：欠账区间 [1,8] 里没有任何消息，消息整体在它之后
    { name: "前缀缺口（本轮的根因）", input: { rangeStart: 1, rangeEnd: 8, seqs: [9, 10, 11, 12] }, want: { start: 9, end: 12 } },
    { name: "区间早于全部消息（单点欠账）", input: { rangeStart: 7, rangeEnd: 7, seqs: [8, 9, 10] }, want: { start: 8, end: 10 } },
    // 镜像形状：消息整体在欠账区间**之前**（尾部消息早于 `lastFoldSeq + 1`）
    { name: "后缀缺口（消息整体在区间之前）", input: { rangeStart: 401, rangeEnd: 499, seqs: [300, 350, 400] }, want: { start: 300, end: 400 } },
  ];
  for (const c of cases) {
    const cov = coverageOf(c.input);
    t.eq({ start: cov.start, end: cov.end }, c.want, `${c.name}：${JSON.stringify(c.input.seqs)} @ ${c.input.rangeStart}-${c.input.rangeEnd}`);
    const list = c.input.seqs.filter((seq) => Number.isFinite(seq));
    if (list.length === 0) continue;
    const min = list[0];
    const max = list[list.length - 1];
    // 不变量：消息跨度与欠账区间**不相交** ⇒ 报出的必须是实际跨度（不是虚构的一点）
    if (max < c.input.rangeStart || min > c.input.rangeEnd) {
      t.eq({ start: cov.start, end: cov.end }, { start: min, end: max }, `${c.name}：区间里没有任何消息时，必须报实际跨度`);
      t.eq(cov.start === cov.end, min === max, `${c.name}：只有真的只有一条消息时才允许是单点`);
    }
  }
  // 没有消息时保持原契约：起点退回归一化、整段算缺
  const none = coverageOf({ rangeStart: 100, rangeEnd: 500, seqs: [] });
  t.eq({ start: none.start, end: none.end }, { start: 100, end: 100 }, "没有消息 ⇒ 归一化成一点（这是「什么都没折」的既有写法）");
  t.eq(none.uncoveredTail, 400, "没有消息 ⇒ 整段都没覆盖");
};

tests["T37 审计脚本必须能区分「合法短会话」与「区间算错」"] = (t) => {
  /** 退化判据：三条任一成立。 */
  t.eq(criteriaOf({ start: 8, end: 8, nodesInRange: 0 }), { noNode: true, point: true, narrow: true, degenerate: true }, "8-8 三条全中");
  t.eq(criteriaOf({ start: 9, end: 40, nodesInRange: 3 }), { noNode: false, point: false, narrow: false, degenerate: false }, "正常区间不算退化");
  t.eq(criteriaOf({ start: 9, end: 12, nodesInRange: 1 }).degenerate, true, `跨度 < ${MIN_SPAN} 也算退化`);

  // 合法短会话：会话日志本身就结束在区间内（logMaxSeq <= seqEnd）⇒ 不是 bug
  const short = { start: 1, end: 8, eventsInRange: 9, messagesInRange: 0, nodesInRange: 0, logMaxSeq: 8, firstMessageSeq: null, degenerate: true };
  t.eq(classify(short), "short-session", "短会话是合法结局，不许报成 bug");
  // 根因形状：区间整段早于第一条消息，且区间里没有可摘要消息
  const prefix = { start: 1, end: 8, eventsInRange: 8, messagesInRange: 0, nodesInRange: 0, logMaxSeq: 503, firstMessageSeq: 9, degenerate: true };
  t.eq(classify(prefix), "prefix-gap", "前缀缺口 + 区间里没有消息 = 本轮的根因");
  // 镜像形状：区间整体晚于最后一条消息（尾部那一截永远折不出东西）
  const suffix = { start: 401, end: 499, eventsInRange: 99, messagesInRange: 0, nodesInRange: 0, logMaxSeq: 1200, firstMessageSeq: 9, lastMessageSeq: 400, degenerate: true };
  t.eq(classify(suffix), "suffix-gap", "区间整体晚于最后一条消息 = 镜像形状（同样是虚构的一点）");
  // 区间里夹着消息（薄，但没算错）
  const point = { start: 871, end: 871, eventsInRange: 1, messagesInRange: 1, nodesInRange: 0, logMaxSeq: 1517, firstMessageSeq: 9, degenerate: true };
  t.eq(classify(point), "point-range", "单点区间里确实有消息 ⇒ 不是区间算错");
  // 节点稀疏不是区间错
  const sparse = { start: 3588, end: 4682, eventsInRange: 1095, messagesInRange: 161, nodesInRange: 0, logMaxSeq: 24478, firstMessageSeq: 8, degenerate: true };
  t.eq(classify(sparse), "sparse-nodes", "跨度/消息都正常，只是这段没有节点");
  // 日志解不出来：不猜
  t.eq(classify({ ...prefix, logMaxSeq: null }), "no-log", "没有日志就不分类（不猜）");
  // 非退化
  t.eq(classify({ ...prefix, degenerate: false }), "normal", "非退化区间分类是 normal");
};
