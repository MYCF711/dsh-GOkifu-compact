/**
 * range-fidelity.test.mjs —— 「折叠区间保真度」守卫（T53）
 *
 * 由来（Lead 在 T52 之后的判词）：
 *   「可定位率 = f(折痕形状)，不是 f(代码质量) —— 折到会话尾部 99.6%、折历史中段 43.9%。
 *    今晚已经有多条任务拿它当验收，**全部失效**。」
 *   T53 的候选替代品 = **区间保真度**（记录区间 vs 实际内容区间）。
 *
 * 这个文件钉住的**不是**「保真度算得对」，而是**它能不能当质量指标** —— 结论是不能，
 * 而且不能的方式很具体（`node scripts/range-fidelity-audit.mjs` 原样输出见报告）：
 *
 *   ① **口径 A（摘要内可定位区间）结构性失明**：
 *      盘上正文由 **pre-T35** 的 `sanitizeSummaryIds` 落盘，那一版的界是 `range.end`（无条件）
 *      ⇒ 活下来的引用**一定** `span.end ≤ range.end` ⇒ 「记录区间覆盖实际内容」对任何非零存活
 *      引用**恒为真**（真机 85.6% 恰等于 1.0）。它看不见「被抹掉的引用」，而被抹掉的正是缺陷。
 *      ⇒ 所以「保真度与形状无关（ρ=−0.09）」是**幸存者偏差**：删掉 60 条不可测换来的。
 *      ⇒ T35 之后（当前源码）界取不到就**不判未来** ⇒ 那 60 条会变成可测且 = 0
 *        ⇒ 补真后 |ρ| = 0.290 是**保守下界**，这个「无关」是**版本伪影**。
 *   ② **口径 B（输入重放）只是可定位率换了个名字**：
 *      与可定位率 ρ=0.896、与形状 ρ=−0.752（可定位率自己是 −0.755）⇒ 同一个生产条件的第三个投影。
 *   ③ **但缺陷是真的、可修的**：退化区间（记录 `8-8` vs 实际 `9-501`）在 T37 重放后 0 → 0.966。
 *
 * 不变量（本文件钉住）：
 *   · **补真规则**：0 个存活引用 + 有占位符 ⇒ 保真度**就是** 0（不是不可测）；
 *   · **两种界**：pre-T35 全抹 / T35 之后不判未来 —— 两者给出**不同**的口径 A，这正是指标的死因；
 *   · **判据 2 只对退化区间成立**：T37 的 `coverageOf` 对正常区间**一个字都不改**；
 *   · **三条判据的裁决必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { sanitizeSummaryIds } from "../src/rooms/fold-quality.mjs";
import {
  CRITERIA_RULES,
  TAIL_BANDS,
  audit,
  auditMark,
  contentRangeFromText,
  correlate,
  edgeDeviation,
  entitySpan,
  imputeFidelity,
  independentIds,
  intersectionSize,
  pearson,
  placeholderCount,
  rangeFidelity,
  rank,
  recordedRange,
  replayRange,
  repairedRange,
  spearman,
  summarizeRows,
  tailBandOf,
  verdicts,
} from "../scripts/range-fidelity-audit.mjs";

export const tests = {};

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 一条 user/assistant 消息（`collectMessages` 只认这两种 type 的文本）。 */
const msg = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/**
 * 真机形状的合成会话（尺寸抄自 `<SESSION_ID>`）：
 *   · seq 0–8 是 session / system 之类，**没有一条可摘要消息**（所以欠账区间 `[1,8]` 折不出东西）；
 *   · 第一条消息在 seq 9，最后一条在 `lastMessageSeq`；
 *   · 图里的节点从 seq 9 起（**全图没有 seq ≤ 8 的实体**）⇒ T35 的界取不到。
 *
 * @param {{lastMessageSeq?:number, nodeSeqs?:number[]}} [options]
 * @returns {Array<object>}
 */
function sessionEvents({ lastMessageSeq = 501, nodeSeqs = [9, 27, 35, 42, 53, 64] } = {}) {
  const events = [];
  for (let seq = 0; seq <= 8; seq += 1) events.push({ type: seq === 8 ? "system/message" : "step/start", seq, data: {} });
  for (let seq = 9; seq <= lastMessageSeq; seq += 1) events.push(msg(seq, `第 ${seq} 步：读文件、跑测试、确认结论`));
  void nodeSeqs;
  return events;
}

/** 一张最小棋谱（节点 + 一条带 evidence 的边）。 */
function makeGraph({ nodeSeqs = [9, 27, 35, 42, 53, 64], head = null } = {}) {
  const nodes = Object.create(null);
  const seqs = head === null ? [...nodeSeqs] : [head, ...nodeSeqs];
  for (const seq of seqs) nodes[`n${seq}`] = { id: `n${seq}`, seq, kind: "assistant" };
  const edges = { e42: { id: "e42", evidence: { start: 42, end: 44 }, result: "failure" } };
  return { nodes, edges, foldMarks: [], order: [] };
}

/** 一个「不可测」的 `contentRangeFromText` 结果（0 个存活引用 + 有占位符）。 */
const blind = (recorded, placeholders = 60) => ({
  start: null,
  end: null,
  resolved: 0,
  unresolved: 0,
  placeholders,
  recorded,
});

/** 判据裁决用的合成 result（只放 `verdicts` 需要的字段）。 */
function makeResult({
  idRho = -0.087,
  idImputedRho = -0.29,
  replayRho = -0.752,
  traceableRho = -0.755,
  idVsTraceable = 0.142,
  idImputedVsTraceable = 0.529,
  replayVsTraceable = 0.896,
  degenerateBefore = 0,
  degenerateAfter = 0.966,
  degeneratePool = 88,
  degenerateTo1 = 85,
  normalBefore = 0.504,
  normalAfter = 0.504,
  unmeasurableId = 60,
} = {}) {
  return {
    unmeasurableId,
    correlations: {
      idVsTailGap: { n: 369, pearson: -0.199, spearman: idRho },
      idImputedVsTailGap: { n: 427, pearson: -0.258, spearman: idImputedRho },
      replayVsTailGap: { n: 601, pearson: -0.482, spearman: replayRho },
      traceableVsTailGap: { n: 427, pearson: -0.456, spearman: traceableRho },
      idVsTraceable: { n: 369, pearson: 0.09, spearman: idVsTraceable },
      idImputedVsTraceable: { n: 427, pearson: 0.546, spearman: idImputedVsTraceable },
      replayVsTraceable: { n: 350, pearson: 0.895, spearman: replayVsTraceable },
      replayVsIdImputed: { n: 350, pearson: 0.4, spearman: 0.4 },
    },
    repair: {
      pool: 601,
      beforeMean: 0.43,
      afterMean: 0.572,
      toOne: 105,
      changed: 85,
      degenerateBeforeMean: degenerateBefore,
      degenerateAfterMean: degenerateAfter,
      degeneratePool,
      degenerateTo1,
      normalBeforeMean: normalBefore,
      normalAfterMean: normalAfter,
    },
  };
}

/* ───────────────────────────── ① 纯函数：id 与区间 ───────────────────────────── */

tests["T53 独立 id 的边界规则：`e1` 不匹配 `e12`、`the1` 不算 `e1`、去重保序"] = (t) => {
  t.eq(independentIds("n1, e42; n300 和 the1 还有 e12 以及 n1"), ["n1", "e42", "n300", "e12"], "边界 + 去重 + 保序");
  t.eq(independentIds("x9 不是 id（前缀不在 [en]）"), [], "`x9` 不算");
  t.eq(independentIds("n3634 与 e9442"), ["n3634", "e9442"], "5 位编号（真机已有 n3634）必须认");
  t.eq(independentIds(""), [], "空串 ⇒ 空数组");
};

tests["T53 占位符三种写法都算（`n?` / `e?` / 全角 `e？`），且不去重"] = (t) => {
  t.eq(placeholderCount("n? e? e？"), 3, "三种写法");
  t.eq(placeholderCount("n??"), 1, "`n??` 只算一条占位符（? 重复不算新引用）");
  t.eq(placeholderCount("n1 e42 没有占位符"), 0, "真 id 不算占位符");
  t.eq(placeholderCount(""), 0, "空串 ⇒ 0");
};

tests["T53 实体跨度：边取 evidence、节点取 seq、图里没有 ⇒ null（不猜）"] = (t) => {
  const graph = makeGraph();
  t.eq(entitySpan(graph, "e42"), { start: 42, end: 44 }, "边用 evidence 的闭区间");
  t.eq(entitySpan(graph, "n9"), { start: 9, end: 9 }, "节点是单点");
  t.eq(entitySpan(graph, "n999"), null, "图里没有 ⇒ null");
  t.eq(entitySpan(graph, ""), null, "空 id ⇒ null");
  t.eq(entitySpan({ nodes: { n1: { id: "n1" } } }, "n1"), null, "没有 seq 的节点 ⇒ null");
};

/* ───────────────────────────── ② 保真度与首尾偏差 ───────────────────────────── */

tests["T53 保真度 = |记录 ∩ 实际| / |实际|（四种形状，分母是「实际」）"] = (t) => {
  // 真机正常折痕：记录 12-318，摘要实际讲 13-315 ⇒ 完整覆盖
  t.eq(rangeFidelity({ start: 12, end: 318 }, { start: 13, end: 315 }), 1, "记录区间包住实际内容 ⇒ 1.0");
  // 真机补账折：记录 8-8，实际 9-501 ⇒ 完全不相交
  t.eq(rangeFidelity({ start: 8, end: 8 }, { start: 9, end: 501 }), 0, "不相交 ⇒ 0");
  // 部分覆盖：记录 10-20（11 个事件），实际 15-30（16 个事件），交集 15-20 = 6
  t.eq(Math.round(rangeFidelity({ start: 10, end: 20 }, { start: 15, end: 30 }) * 1000) / 1000, 0.375, "部分覆盖 = 6/16");
  // 不可测：一个可定位引用都没有
  t.eq(rangeFidelity({ start: 8, end: 8 }, { start: null, end: null }), null, "实际区间为空 ⇒ null（**不是 0**）");
  t.eq(rangeFidelity(null, { start: 9, end: 9 }), null, "记录区间缺失 ⇒ null");
  t.eq(intersectionSize({ start: 1, end: 5 }, { start: 6, end: 9 }), 0, "相邻不相交 ⇒ 0");
  t.eq(intersectionSize({ start: 1, end: 5 }, { start: 3, end: 9 }), 3, "闭区间交集 3-5 = 3");
};

tests["T53 首尾偏差的符号语义（head>0 = 漏开头、tail>0 = 记早了、tail<0 = 漏结尾）"] = (t) => {
  t.eq(edgeDeviation({ start: 12, end: 318 }, { start: 13, end: 315 }), { head: 1, tail: 3 }, "包住内容 ⇒ 两头都为正");
  t.eq(edgeDeviation({ start: 8, end: 8 }, { start: 9, end: 501 }), { head: 1, tail: -493 }, "补账折 ⇒ tail 大负（漏掉 493 个事件）");
  t.eq(edgeDeviation({ start: 8, end: 8 }, { start: 5, end: 9 }), { head: -3, tail: -1 }, "两头都漏 ⇒ 都为负");
  t.eq(edgeDeviation({ start: 8, end: 8 }, { start: null, end: null }), null, "不可测 ⇒ null");
};

/* ───────────────────────────── ③ 截断引理（本指标的死刑判决） ───────────────────────────── */

tests["T53 截断引理：口径 A 量不到「记录区间过窄」，只量到「sanitize 抹了多少」"] = (t) => {
  // 一条**未清洗**的摘要：它讲的是 seq 9–300 的内容，而账上记的是 8-8
  const raw = "- n9 读了文件\n- n300 又读了一次\n";

  // 情形 ①：图里有 seq ≤ range.end 的实体 ⇒ boundary 非空 ⇒ n9/n300 的 span.end > boundary ⇒ 全抹
  const withHead = { nodes: { n1: { id: "n1", seq: 1 } }, edges: {} };
  const cleaned = sanitizeSummaryIds(raw, withHead, { start: 8, end: 8 });
  t.eq([...cleaned.removed].sort(), ["n300", "n9"], "pre-T35 的界（range.end 无条件）把 8-8 区间里的 nN 全判「未来」");
  const blindContent = contentRangeFromText(cleaned.text, withHead);
  t.eq({ start: blindContent.start, end: blindContent.end }, { start: null, end: null }, "抹光之后口径 A **不可测**（证据没了）");
  t.eq(imputeFidelity({ ...blindContent, recorded: { start: 8, end: 8 } }), 0, "按引理补真 = 0（不是「没有缺陷」）");

  // 情形 ②：T35 之后 —— 区间早于全图第一个实体 ⇒ boundary = null ⇒ **一个字都不抹**
  const noHead = { nodes: { n9: { id: "n9", seq: 9 }, n300: { id: "n300", seq: 300 } }, edges: {} };
  const cleanedNew = sanitizeSummaryIds(raw, noHead, { start: 8, end: 8 });
  t.eq(cleanedNew.removed, [], "T35 之后取不到界 ⇒ 兜底「不判未来」");
  const content = contentRangeFromText(cleanedNew.text, noHead);
  t.eq({ start: content.start, end: content.end }, { start: 9, end: 300 }, "同样的正文，T35 之后口径 A **可测**");
  t.eq(rangeFidelity({ start: 8, end: 8 }, content), 0, "可测之后保真度 = 0 ⇒ 「不可测」是**版本伪影**，不是「没有缺陷」");
};

tests["T53 补真规则：0 个存活 + 有占位符 ⇒ 0；一个引用都没有 ⇒ 不可测（null）"] = (t) => {
  t.eq(imputeFidelity(blind({ start: 8, end: 8 }, 60)), 0, "证据被抹光 ⇒ 保真度就是 0");
  t.eq(imputeFidelity(blind({ start: 8, end: 8 }, 0)), null, "既没 id 也没占位符（空摘要）⇒ 不可测");
  t.eq(imputeFidelity({ start: 9, end: 9, placeholders: 0, recorded: { start: 8, end: 8 } }), 0, "有 id 且落在区间外 ⇒ 0");
  t.eq(imputeFidelity({ start: 13, end: 315, placeholders: 0, recorded: { start: 12, end: 318 } }), 1, "有 id 且落在区间内 ⇒ 1");
  t.eq(imputeFidelity(null), null, "没有这一行 ⇒ null");
};

/* ───────────────────────────── ④ 统计 ───────────────────────────── */

tests["T53 秩相关：并列取平均秩、常数序列 ⇒ null（不许拿 0 冒充「无相关」）"] = (t) => {
  t.eq(rank([10, 20, 20, 30]), [0, 1.5, 1.5, 3], "并列取平均秩");
  t.eq(rank([3, 1, 2]), [2, 0, 1], "保序");
  t.eq(pearson([1, 2, 3], [2, 4, 6]), 1, "完全线性正相关");
  t.eq(pearson([1, 2, 3], [3, 2, 1]), -1, "完全线性负相关");
  t.eq(pearson([1, 1, 1], [1, 2, 3]), null, "常数序列 ⇒ null（不是 0）");
  t.eq(pearson([1, 2], [1, 2]), null, "样本 < 3 ⇒ null");
  t.eq(spearman([1, 2, 3, 4], [1, 8, 27, 64]), 1, "单调非线性 ⇒ 秩相关仍是 1（Pearson 会 < 1）");
  t.eq(Math.round(pearson([1, 2, 3, 4], [1, 8, 27, 64]) * 1000) / 1000 < 0.99, true, "…而 Pearson 明显不到 1 ⇒ 这就是为什么主判据用 Spearman");
};

tests["T53 离尾部距离分桶与 T52 完全同一组边界（否则两个指标不可比）"] = (t) => {
  t.eq(TAIL_BANDS.map((band) => band.band), ["折到尾部(0)", "1–20", "21–100", "100+"], "桶名固定");
  t.eq(tailBandOf(0), "折到尾部(0)", "折到尾部");
  t.eq(tailBandOf(1), "1–20", "边界归左");
  t.eq(tailBandOf(20), "1–20", "上界含");
  t.eq(tailBandOf(21), "21–100", "下一个桶");
  t.eq(tailBandOf(100), "21–100", "上界含");
  t.eq(tailBandOf(101), "100+", "尾桶");
  t.eq(tailBandOf(6831), "100+", "真机最大 gap 也进尾桶");
  t.eq(tailBandOf(null), null, "缺测 ⇒ null（不塞进任何桶）");
};

tests["T53 汇总：直方图五档、点质量计数、池化可定位率"] = (t) => {
  const rows = [
    { fidelityId: 1, fidelityIdImputed: 1, fidelityReplay: 1, fidelityRepaired: 1, ids: 10, placeholders: 0 },
    { fidelityId: 0, fidelityIdImputed: 0, fidelityReplay: 0, fidelityRepaired: 1, ids: 0, placeholders: 40 },
    { fidelityId: 0.4, fidelityIdImputed: 0.4, fidelityReplay: 0.4, fidelityRepaired: 0.4, ids: 4, placeholders: 0 },
    { fidelityId: null, fidelityIdImputed: 0, fidelityReplay: null, fidelityRepaired: null, ids: 0, placeholders: 0 },
  ];
  const summary = summarizeRows(rows);
  t.eq(summary.n, 4, "分母是全部行（不可测也计入 n）");
  t.eq(summary.fidelityId.n, 3, "口径 A 只对可测的算分布");
  t.eq(summary.fidelityId.histogram, { "= 0.0": 1, "0–0.5": 1, "0.5–0.9": 0, "0.9–1.0": 0, "= 1.0": 1 }, "五档直方图");
  t.eq(summary.fidelityIdImputed.atOne, 1, "补真后 1.0 的条数");
  t.eq(summary.fidelityIdImputed.atZero, 2, "补真后 0.0 的条数（原来 1 条被抹光的也算进来）");
  t.eq(summary.traceableShare, 0.2593, "池化可定位率 = 14 / 54（与 T52 的 traceableRate 同一口径）");
  t.eq(summarizeRows([]).traceableShare, null, "空集 ⇒ null（不是 0）");
};

tests["T53 correlate：缺测整条丢掉（不许拿 0 冒充）、常数序列 ⇒ null"] = (t) => {
  const rows = [
    { gap: 0, fidelity: 1 },
    { gap: 10, fidelity: 0.9 },
    { gap: 100, fidelity: 0.5 },
    { gap: 500, fidelity: 0.1 },
    { gap: 900, fidelity: 0 },
    { gap: null, fidelity: 0.7 },
    { gap: 5, fidelity: null },
  ];
  const strong = correlate(rows, "fidelity", "gap");
  t.eq(strong.n, 5, "两条缺测被丢掉，分母是 5 不是 7");
  t.eq(strong.spearman, -1, "完全单调下降 ⇒ ρ = −1");
  const flat = correlate([{ gap: 1, fidelity: 1 }, { gap: 2, fidelity: 1 }, { gap: 3, fidelity: 1 }], "fidelity", "gap");
  t.eq(flat.spearman, null, "常数 ⇒ null（不是 0：0 会让人以为「检查过了」）");
  t.eq(correlate([], "fidelity", "gap").n, 0, "空 ⇒ n=0");
};

/* ───────────────────────────── ⑤ 判据 2：真红 ───────────────────────────── */

tests["T53 判据 2：T37 重放让退化区间 0 → 1.0，正常区间一个字都不改"] = (t) => {
  const events = sessionEvents({ lastMessageSeq: 501 });
  // 退化形状：账上 [8,8]（一条可摘要消息都没有），模型实际看的 [9,501]
  const degenerate = { start: 8, end: 8 };
  const replay = replayRange(events, degenerate);
  t.eq({ start: replay.start, end: replay.end }, { start: 9, end: 501 }, "重放跨度 = 9-501（与真机 `degenerate-range-audit` 一致）");
  t.eq(rangeFidelity(degenerate, replay), 0, "修复前保真度 = 0");
  const repaired = repairedRange(events, degenerate);
  t.eq({ start: repaired.start, end: repaired.end }, { start: 9, end: 501 }, "T37 的 coverageOf 在「不相交」时如实报实际跨度");
  t.eq(rangeFidelity(repaired, replay), 1, "修复后保真度 = 1.0 ⇒ 判据 2 成立（缺陷可修）");

  // 正常形状：账上 [9,20] 与消息跨度**有交集** ⇒ C491 的夹取契约原样保留 ⇒ 保真度一个字都不变
  const normal = { start: 9, end: 20 };
  const normalReplay = replayRange(events, normal);
  const normalRepaired = repairedRange(events, normal);
  t.eq({ start: normalRepaired.start, end: normalRepaired.end }, { start: 9, end: 20 }, "正常区间被夹回欠账区间（C491 契约）");
  t.eq(rangeFidelity(normalRepaired, normalReplay), rangeFidelity(normal, normalReplay), "保真度**不变** ⇒ T37 不是万能的");
  t.eq(rangeFidelity(normal, normalReplay) < 1, true, "正常区间的保真度本来就 < 1（prompt 会越过 rangeEnd）⇒ 这是「输入口径」不是「内容口径」");

  // 没有任何消息 ⇒ 不可重放（不猜）
  t.eq(replayRange([], { start: 8, end: 8 }), null, "没有事件 ⇒ null");
  t.eq(replayRange(sessionEvents().slice(0, 9), { start: 8, end: 8 }), null, "事件里一条可摘要消息都没有 ⇒ null");
  t.eq(repairedRange([], { start: 8, end: 8 }), null, "没有事件 ⇒ 修复后也 null");
};

/* ───────────────────────────── ⑥ 三条判据的裁决必须能返回「不通过」 ───────────────────────────── */

tests["T53 裁决 1：形状相关太强 ⇒ 判据 1 必须红（口径 B 单独就足以否决）"] = (t) => {
  const verdict = verdicts(makeResult({ replayRho: -0.9 })).find((entry) => entry.id === "shape-free");
  t.eq(verdict.pass, false, "B 与形状 ρ=−0.9 ⇒ 「与形状无关」不成立");
  t.includes(verdict.detail, "B(重放)", "detail 必须点名是哪个口径不过");

  const ok = verdicts(makeResult({ idRho: -0.05, idImputedRho: -0.1, replayRho: -0.2 })).find((entry) => entry.id === "shape-free");
  t.eq(ok.pass, true, "三个口径都小 ⇒ 通过（门槛两侧都要能走）");
  t.eq(CRITERIA_RULES.maxAbsRho, 0.3, "门槛写死在这里：|ρ| < 0.3");
};

tests["T53 裁决 2：修复没有改善（退化区间不动）⇒ 判据 2 必须红"] = (t) => {
  const verdict = verdicts(makeResult({ degenerateBefore: 0.5, degenerateAfter: 0.5 })).find((entry) => entry.id === "repairable");
  t.eq(verdict.pass, false, "修复前后一样 ⇒ 不可修（或修错了地方）");
  const ok = verdicts(makeResult()).find((entry) => entry.id === "repairable");
  t.eq(ok.pass, true, "真机形状（0 → 0.966）⇒ 通过");
  t.includes(ok.detail, "正常区间", "detail 必须同时给出「正常区间不变」—— 否则会被读成「全都修好了」");
};

tests["T53 裁决 3：与摘要质量完全无关 ⇒ 判据 3 必须红"] = (t) => {
  const verdict = verdicts(makeResult({ idImputedVsTraceable: 0.05, replayVsTraceable: 0.1 })).find((entry) => entry.id === "explanatory");
  t.eq(verdict.pass, false, "两个口径都无解释力 ⇒ 不可用");
  const ok = verdicts(makeResult()).find((entry) => entry.id === "explanatory");
  t.eq(ok.pass, true, "真机（A 补真 0.529 / B 0.896）⇒ 通过");
  t.includes(ok.detail, "占位符", "detail 必须点破「A 的解释力来自占位符」这层循环");
};

tests["T53 裁决总表：真机形状是 2 / 3（判据 1 不过 ⇒ 不能用）"] = (t) => {
  const all = verdicts(makeResult());
  t.eq(all.length, 3, "三条判据，一条不少");
  t.eq(all.map((entry) => entry.id), ["shape-free", "repairable", "explanatory"], "顺序固定（报告与测试都按它）");
  t.eq(all.filter((entry) => entry.pass).length, 2, "真机形状通过 2 条 —— 关键的那条（形状无关）不过");
  t.eq(all.map((entry) => entry.pass), [false, true, true], "逐条：形状 ❌ · 可修 ✅ · 有解释力 ✅");
};

/* ───────────────────────────── ⑦ 端到端（临时 home，只读） ───────────────────────────── */

tests["T53 auditMark：真机形状（记录 8-8 / 摘要全 n? / 事件 9-501）三口径同时给出"] = (t) => {
  const graph = makeGraph({ nodeSeqs: [9, 27, 35, 42, 53, 64, 300, 501] });
  const events = sessionEvents({ lastMessageSeq: 501 });
  // 真机正文：**一个存活 id 都没有**，全是 `n?`（pre-T35 的界抹的）
  const text = "## 目标\n在隔离仓里做一件事。\n\n## 棋谱（状态节点）\n- n? 读了文件 → **得出了结论**\n\n## 原始坐标\n- 本段遮蔽 seq 1-8；逐字原文在 DSH 会话日志中（seq 可定位）。\n";
  const row = auditMark({
    mark: { at: 1793829856347, seqStart: 8, seqEnd: 8, trigger: "archive-offline" },
    graph,
    text,
    events,
    graphMaxSeq: 499,
    sessionId: "<SESSION_ID>-fixture",
  });
  t.eq(row.recorded, { start: 8, end: 8 }, "记录区间");
  t.eq(row.span, 1, "跨度 1 个事件");
  t.eq(row.degenerate, true, "退化区间（seqStart === seqEnd）");
  t.eq(row.tailGap, 491, "离尾部 499 − 8 = 491（落进 100+ 桶）");
  t.eq(row.ids, 0, "一个存活 id 都没有");
  t.eq(row.placeholders, 1, "1 个占位符");
  t.eq(row.traceableShare, 0, "可定位率 0（整篇零锚点）");
  t.eq(row.fidelityId, null, "口径 A 不可测（证据被抹光）");
  t.eq(row.fidelityIdImputed, 0, "补真 = 0（引理）");
  t.eq({ start: row.replay.start, end: row.replay.end }, { start: 9, end: 501 }, "口径 B 重放 9-501");
  t.eq(row.fidelityReplay, 0, "口径 B 保真度 0");
  t.eq(row.fidelityRepaired, 1, "T37 重放后 1.0");
  t.eq(row.headDev, null, "口径 A 的首尾偏差不可测（证据被抹光 —— 这正是缺陷所在）");
  t.eq(row.headDevReplay, 1, "口径 B 首偏差：实际从 9 开始，账上从 8 开始（+1）");
  t.eq(row.tailDevReplay, -493, "口径 B 尾偏差：账上到 8，实际到 501（−493）");

  // 反过来：真机正常折痕（记录 12-318 / 摘要讲 13-315）⇒ 口径 A = 1.0
  const normalGraph = makeGraph({ nodeSeqs: [13, 200, 315] });
  const normalRow = auditMark({
    mark: { at: 1, seqStart: 12, seqEnd: 318, trigger: "archive-offline" },
    graph: normalGraph,
    text: "- n13 开始\n- n200 中段\n- n315 收尾\n",
    events: null,
    graphMaxSeq: 680,
    sessionId: "00be4723-fixture",
  });
  t.eq(normalRow.content, { start: 13, end: 315, resolved: 3, unresolved: 0, placeholders: 0 }, "口径 A 解析出 13-315");
  t.eq(normalRow.fidelityId, 1, "被记录区间完整覆盖 ⇒ 1.0（这就是 85.6% 恒等于 1.0 的那一批）");
  t.eq(normalRow.replay, null, "没有日志 ⇒ 口径 B 不可测（不猜）");
  t.eq(normalRow.fidelityReplay, null, "…保真度也是 null");
};

tests["T53 audit() 端到端：临时 home 只读、缺目录 ⇒ missing、坏图跳过"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "range-fidelity-"));
  try {
    const sessionsDir = nodePath.join(home, "chess-context", "sessions");
    const graph = makeGraph({ nodeSeqs: [13, 200, 315] });
    graph.sessionId = "sess-1";
    graph.foldMarks = [
      { at: 1000, seqStart: 8, seqEnd: 8, trigger: "archive-offline", summaryChars: 5973 },
      { at: 2000, seqStart: 12, seqEnd: 318, trigger: "archive-offline", summaryChars: 6334 },
    ];
    graph.lastOfflineSummary = { at: 2000, range: { start: 12, end: 318 }, text: "- n13 开始\n- n315 收尾\n" };
    nodeFs.mkdirSync(nodePath.join(sessionsDir, "sess-1"), { recursive: true });
    const graphFile = nodePath.join(sessionsDir, "sess-1", "graph.json");
    nodeFs.writeFileSync(graphFile, JSON.stringify(graph), "utf8");
    const before = { text: nodeFs.readFileSync(graphFile, "utf8"), mtime: nodeFs.statSync(graphFile).mtimeMs };

    const result = audit({ home });
    t.eq(result.missing, false, "有棋谱目录 ⇒ 不是 missing");
    t.eq(result.sessions, 1, "1 个会话");
    t.eq(result.marks, 2, "2 条折痕");
    t.eq(result.rows.length, 2, "两条都进 rows");
    t.eq(result.rows.map((row) => row.recorded.start), [8, 12], "按 at 升序");
    t.eq(result.poolId, 1, "只有 latest 那条有正文（单槽口径）⇒ 可复判池 1");
    t.eq(result.measurableId, 1, "1 条口径 A 可测");
    t.eq(result.unmeasurableId, 0, "0 条不可测（另一条没有正文，不算进分母）");
    t.eq(result.rows[1].fidelityId, 1, "正常折痕保真度 1.0");
    t.eq(result.rows[0].fidelityId, null, "没有正文的折痕 ⇒ 口径 A 不可测（不拿 0 冒充）");
    t.eq(result.poolReplay, 0, "没有会话日志 ⇒ 口径 B 一条都不可重放");
    t.eq(result.bands.length, 4, "四个离尾部桶");
    t.eq(result.bands.reduce((sum, band) => sum + band.n, 0), 2, "分桶覆盖全部折痕");

    // **只读**：图文件一个字节都不许变
    const after = { text: nodeFs.readFileSync(graphFile, "utf8"), mtime: nodeFs.statSync(graphFile).mtimeMs };
    t.eq(after.text, before.text, "审计不得改写 graph.json");
    t.eq(after.mtime, before.mtime, "审计连 mtime 都不许动");

    // 缺目录 ⇒ missing（调用方据此退出码 2，不许静默出一个空报告）
    t.eq(audit({ home: nodePath.join(home, "nope") }).missing, true, "没有棋谱目录 ⇒ missing");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
