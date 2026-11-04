/**
 * sanitize-anchor.test.mjs —— `sanitizeSummaryIds` 的「未来」判据边界（T35）
 *
 * 为什么（T33 审计第一号发现，真机 365 条可复判摘要）：
 *   **51 条（14.0%）摘要一个真 id 都没有** —— 全篇 `nN` 被抹成 `n?`；108 条过半被抹。
 *   根因不是模型，是判据：`archive-offline` 给单事件折叠记的区间是 `seq 8-8` / `9-9` / `11-11`
 *   这种**退化区间** —— 区间里一个节点都没有，而且早于全图第一个节点。
 *   旧判据 `span.end > range.end` 于是对**全篇**每个 `nN` 成立 ⇒ 锚点被整篇抹掉，
 *   而探针 `unknownIds: []` / `constraintRecall: 1` 恒绿（它没有 id 可查）。
 *
 * 钉住两头（少一头都会修歪）：
 *   ① **失败分支必须真红**：单事件折叠（seq 8-8）里，区间**之前**就已存在的实体 id 必须保留
 *      —— 旧判据把它们全抹了（本文件 T35-1 在旧代码下红）；
 *   ② **「未来」判据不许整个废掉**：区间之后（折叠时还不存在）的 id 仍然要抹
 *      —— 否则 C458 的初衷（checkpoint 不许指向未来证据）就没了（T35-2 / T35-4）。
 *
 * 兜底方向（T35 硬约束）：**取不到界就不判「未来」** —— 抹掉全部锚点比留一个可疑 id 更坏
 * （读者至少能用 id 回查棋谱）。但「图里没有」的 id 仍然抹（C458 的另一半，与「未来」无关）。
 */

import { sanitizeSummaryIds } from "../src/rooms/fold-quality.mjs";
import { anchorIds, countPlaceholders, buildProbeText, auditSummary, auditSessions } from "../scripts/sanitize-anchor-audit.mjs";

export const tests = {};

/** 真机形状的棋谱：节点 seq 从 9 起（区间 8-8 里一个节点都没有），边跨在节点之间。 */
function realShapeGraph() {
  return {
    nodes: {
      n1: { id: "n1", seq: 9, ts: 1000 },
      n2: { id: "n2", seq: 30, ts: 2000 },
      n3: { id: "n3", seq: 42, ts: 3000 },
    },
    edges: {
      e1: { id: "e1", evidence: { start: 10, end: 29 }, ts: 1500 },
      e2: { id: "e2", evidence: { start: 31, end: 41 }, ts: 2500 },
    },
  };
}

/* ───────── T35-1：单事件折叠（seq 8-8）里，已存在的锚点必须保留（旧判据下真红） ───────── */

tests["T35-1 单事件折叠（seq 8-8）早于全图 ⇒ 全篇真 id 必须保留（旧判据把它们全抹成 n?）"] = (t) => {
  const graph = realShapeGraph();
  const range = { start: 8, end: 8 };
  const text = "**n1** 用户给出目标并配图；**n2** 助手先做基础侦察；**e1** 这条命令失败。";
  const got = sanitizeSummaryIds(text, graph, range);
  t.eq(got.text, text, "区间里一个节点都没有 ⇒ 没有任何「未来」依据，锚点必须原样保留");
  t.eq(got.removed, [], "一个 id 都不许抹（旧判据在这里抹掉全部 3 个）");
  t.eq(got.checked, 3, "检查过 3 个独立 id（不是「没检查」）");
};

tests["T35-2 单事件折叠（seq 8-8）区间之前有实体 ⇒ 之前的保留、之后的仍然要抹（不废「未来」判据）"] = (t) => {
  const graph = {
    nodes: { n1: { id: "n1", seq: 5, ts: 1000 }, n9: { id: "n9", seq: 50, ts: 9000 } },
    edges: { e1: { id: "e1", evidence: { start: 6, end: 7 }, ts: 1500 } },
  };
  const got = sanitizeSummaryIds("**n1** 早先的目标；**e1** 早先的失败；**n9** 折叠时还不存在。", graph, { start: 8, end: 8 });
  t.includes(got.text, "n1", "区间之前的节点 id 必须保留");
  t.includes(got.text, "e1", "区间之前的边 id 必须保留");
  t.includes(got.text, "n?", "区间之后的 id 仍然要抹（「未来」判据没被废掉）");
  t.eq(got.removed, ["n9"], "只抹 n9 —— 抹谁要能点名");
};

/* ───────── T35-3：正常区间不许回归（与 C458 的既有行为逐条一致） ───────── */

tests["T35-3 正常区间的判定与旧判据逐条一致（只改退化区间，不动老行为）"] = (t) => {
  const graph = { nodes: { n1: { seq: 5 }, n2: { seq: 50 } }, edges: { e1: { id: "e1", evidence: { start: 6, end: 7 } } } };
  const got = sanitizeSummaryIds("路径 n1 → n2（在 seq 50）；边 e1；另一个 e99。", graph, { start: 1, end: 20 });
  t.includes(got.text, "n1", "区间内的真 id 保留");
  t.includes(got.text, "e1", "区间内的真边保留");
  t.includes(got.text, "n?", "晚于区间的 n2 必须抹（未来实体）");
  t.includes(got.text, "e?", "图里没有的 e99 必须抹（幻觉）");
  t.eq(got.removed.sort().join(","), "e99,n2", "被抹的 id 要能点名");
};

tests["T35-4 兜底只关「未来」：区间早于全图时，图里没有的 id 仍然抹（C458 的另一半还在）"] = (t) => {
  const graph = realShapeGraph();
  const got = sanitizeSummaryIds("n1 是真的；n99 是编的；e77 也是编的。", graph, { start: 8, end: 8 });
  t.includes(got.text, "n1", "真 id 保留（兜底方向 = 保留）");
  t.includes(got.text, "n?", "图里没有的 n99 仍然抹成 n?");
  t.includes(got.text, "e?", "图里没有的 e77 仍然抹成 e?");
  t.eq(got.removed.sort().join(","), "e77,n99", "只抹图里没有的");
};

/* ───────── T35-5：界的定义（节点 + 边的 evidence，而不是只看节点） ───────── */

tests["T35-5 界的定义：边 evidence 也算实体（尾部只有边没有节点时，别把正当 id 抹掉）"] = (t) => {
  // 节点只到 seq 5，但 e1 的 evidence 一直到 range.end（20）—— 只用节点取界会把 e1（end 20 > 5）误抹。
  const graph = { nodes: { n1: { seq: 5 } }, edges: { e1: { id: "e1", evidence: { start: 6, end: 20 } } } };
  const got = sanitizeSummaryIds("n1 与 e1 都在折叠区间内。", graph, { start: 1, end: 20 });
  t.includes(got.text, "e1", "evidence 收口在 range.end 的边是「已存在」的，必须保留");
  t.includes(got.text, "n1", "区间内的节点保留");
  t.eq(got.removed, [], "一条都不该抹");
};

tests["T35-6 range 为空 / 非有限值 ⇒ 不做处理（判不了「晚不晚」，宁可不动）"] = (t) => {
  const graph = realShapeGraph();
  for (const range of [null, undefined, { start: 1, end: Number.NaN }]) {
    const got = sanitizeSummaryIds("引用 n9 与 n1", graph, range);
    t.eq(got.text, "引用 n9 与 n1", `range=${JSON.stringify(range)} ⇒ 原样返回`);
    t.eq(got.removed.length, 0, "也不许虚报「清洗了几个」");
    t.eq(got.checked, 0, "没检查就是 0（别拿 0 冒充「检查过没毛病」）");
  }
};

/* ───────── T35-7：审计口径（真机 51 条的复现器） ───────── */

tests["T35-7 审计口径：零锚点摘要的「应该保留但被抹」= 占位符个数，且回放能全部救回"] = (t) => {
  const graph = realShapeGraph();
  const text = "## 目标\n**n?** 用户给出目标\n**n?** 助手侦察\n**e?** 命令失败\n";
  const sample = { sessionId: "fixture-8-8", trigger: "archive-offline", text, seqStart: 8, seqEnd: 8, at: 5000 };
  const row = auditSummary(sample, graph);
  t.eq(row.ids, 0, "真 id 是 0（这就是「零锚点」）");
  t.eq(row.placeholders.total, 3, "占位符 = 3 个被抹的锚点");
  t.eq(row.nodesInRange, 0, "区间内 0 个节点（旧界没有依据）");
  t.eq(row.boundary.next, null, "区间早于全图 ⇒ 界取不到");
  t.eq(row.futureAtFold, 0, "折叠时没有任何实体是「未来」的");
  t.eq(row.keptCurrent, 3, "当前判据回放后 3 个锚点全部保留（修前是 0）");

  const probe = buildProbeText(text, graph, 5000);
  t.eq(anchorIds(probe.text).length, 3, "回填后是真 id（模拟模型原本写的号码）");
  t.eq(countPlaceholders(probe.text).total, 0, "回填后没有占位符");

  const totals = auditSessions([{ sessionId: "fixture-8-8", marks: [{ ...sample, summaryText: text }], lastOfflineSummary: null, graph }]).totals;
  t.eq(totals.zeroAnchor, 1, "汇总：1 条零锚点");
  t.eq(totals.shouldKeep, 3, "「应该保留但被抹」= 3");
  t.eq(totals.futureAtFold, 0, "其中真未来 0 个");
  t.eq(totals.flipped, 0, "非退化区间回归探针不该有变化");
};

tests["T35-8 审计：正常区间的摘要不算零锚点（别把「有 id 的」也报进来）"] = (t) => {
  const graph = realShapeGraph();
  const sample = { sessionId: "fixture-ok", trigger: "archive-offline", text: "**n2** 侦察；**e2** 失败", seqStart: 30, seqEnd: 41, at: 5000 };
  const row = auditSummary(sample, graph);
  t.eq(row.ids, 2, "真 id 有 2 个 ⇒ 不是零锚点");
  t.eq(row.placeholders.total, 0, "没有占位符");
  t.eq(row.keptOld, 2, "旧判据也保得住（这条是回归基线）");
  t.eq(row.keptCurrent, 0, "没有占位符可回放 ⇒ 0");
  const totals = auditSessions([{ sessionId: "fixture-ok", marks: [{ ...sample, summaryText: sample.text }], lastOfflineSummary: null, graph }]).totals;
  t.eq(totals.zeroAnchor, 0, "汇总里不该出现零锚点");
  t.eq(totals.summaries, 1, "分母是 1 条可复判摘要");
};
