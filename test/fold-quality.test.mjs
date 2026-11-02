/**
 * fold-quality.test.mjs —— 「压缩保真度」L1 指标的回归（2026-11-01）
 *
 * 这条指标的意义是**任务级**的：丢一条约束 = 任务变了；丢一条失败边 = 下一个模型必然重踩。
 * 所以测试不测「数字好不好看」，只测三件事：
 *   1. 匹配是机械且精确的（e1 不能匹配 e12；约束必须逐字出现）；
 *   2. 区间过滤与残留过滤的口径与 renderFacts 一致（不然指标会报假警）；
 *   3. 空集返回 1（不是 0 —— 「没有可丢的」不等于「全丢了」）。
 */

import { findOutOfRangeIds, measureFoldQuality, mentionsEdge, failuresInFoldRange, findUnknownIds, foldCostMetrics } from "../src/rooms/fold-quality.mjs";
import { foldBoundaryOf, foldClosureOf } from "../src/rooms/kifu-model.mjs";
import { addAgentNode, addEdge, addUserNodeId, createGraph, settleEdge } from "./graph-fixtures.mjs";

export const tests = {};

tests["Q-8 foldCostMetrics：share/ratio/roi 三个口径各回答一件事，非法输入返回 null"] = (t) => {
  const m = foldCostMetrics({ inputTokens: 200, shadowedTokens: 80, summaryTokens: 10 });
  t.eq(Number(m.share.toFixed(2)), 0.4, "share = shadowed/input");
  t.eq(Number(m.ratio.toFixed(2)), 2.5, "ratio = input/shadowed（旧口径）");
  t.eq(m.savedTokens, 70, "saved = shadowed - summary");
  t.eq(Number(m.roi.toFixed(3)), 0.35, "roi = saved/input");
  t.eq(foldCostMetrics({ inputTokens: 0, shadowedTokens: 10 }), null, "input 非法 ⇒ null");
  t.eq(foldCostMetrics({ inputTokens: 100, shadowedTokens: 0 }), null, "shadowed 非法 ⇒ null");
  const noSummary = foldCostMetrics({ inputTokens: 100, shadowedTokens: 50 });
  t.eq(noSummary.summaryTokens, null, "没有摘要长度时如实标 null（不拿 0 冒充）");
  t.eq(noSummary.savedTokens, 50, "没有摘要长度时 saved 按整段遮蔽算");
};

tests["Q-9 share 是「折得碎不碎」的判据：读得多压得少 ⇒ share 低"] = (t) => {
  const early = foldCostMetrics({ inputTokens: 300, shadowedTokens: 60 });   // 折得太碎
  const healthy = foldCostMetrics({ inputTokens: 300, shadowedTokens: 210 }); // 大头都压上了
  t.eq(early.share < 0.3, true, "share < 0.3 才是「折太碎」");
  t.eq(healthy.share >= 0.3, true, "share ≥ 0.3 属健康");
  t.eq(healthy.roi > early.roi, true, "ROI 与 share 同向（压得多自然换回多）");
};


const now = Date.now();

/** 最小图：user 节点带 constraints；agent 节点；边按需要塞。 */
function mkGraph({ constraints = [], edges = [] } = {}) {
  const nodes = {
    n1: { id: "n1", kind: "user", seq: 1, text: "把测试跑绿", constraints, ts: now - 5000 },
    n2: { id: "n2", kind: "agent", seq: 2, goal: "跑测试", ts: now - 1000 },
  };
  if (constraints.length > 0) nodes.n1.constraints = constraints;
  const g = {
    version: 1,
    sessionId: "s-quality",
    cwd: "E:/x",
    order: ["n1", "n2"],
    nodes,
    edges: {},
    nextNode: 3,
    nextEdge: edges.length + 1,
    rootUserNodeIds: ["n1"],
  };
  for (const edge of edges) g.edges[edge.id] = edge;
  return g;
}

function failureEdge(id, seq, over = {}) {
  return {
    id,
    from: "n1",
    to: "n2",
    intent: `试 ${id}`,
    action: "bash(x)",
    result: "failure",
    errorSnippet: `boom ${id}`,
    evidence: { start: seq, end: seq + 1 },
    verify: { kind: "exit", summary: "exit 1" },
    ts: now - 1000,
    ...over,
  };
}

tests["Q-1 约束全部逐字出现 ⇒ constraintRecall = 1；少一条必须 <1 且列出缺的那条"] = (t) => {
  const g = mkGraph({ constraints: ["必须保持 API 字段不变", "不要动 prod 配置"] });
  const full = measureFoldQuality({ graph: g, summaryText: "## 目标\n- 必须保持 API 字段不变\n- 不要动 prod 配置\n" });
  t.eq(full.constraintRecall, 1, "两条约束都在 ⇒ 召回率 1");
  t.eq(full.expectedConstraints, 2, "约束条数口径");
  const missing = measureFoldQuality({ graph: g, summaryText: "## 目标\n- 必须保持 API 字段不变\n" });
  t.eq(missing.constraintRecall, 0.5, "少一条 ⇒ 0.5（不是四舍五入到 1）");
  t.eq(missing.missingConstraints.length, 1, "必须点名缺哪条");
  t.includes(missing.missingConstraints[0], "prod", "缺的正是 prod 配置那条");
};

tests["Q-2 失败边按 edge id 机械匹配：e1 不能匹配 e12 / e123"] = (t) => {
  t.eq(mentionsEdge("## 已探明死路\n- e1 \"x\" → boom (evidence seq 2-3)", "e1"), true, "精确提到");
  t.eq(mentionsEdge("只有 e12 被提到", "e1"), false, "e1 不许被 e12 顶替");
  t.eq(mentionsEdge("只有 e123 被提到", "e12"), false, "e12 不许被 e123 顶替");
  t.eq(mentionsEdge("id=e7，还有 e70", "e7"), true, "前面非字母数字也算独立标识符");
  t.eq(mentionsEdge("", "e1"), false, "空文本不匹配");
  t.eq(mentionsEdge("e1", ""), false, "空 id 不匹配");
};

tests["Q-3 failureRecall 按区间过滤：区间外的失败边不参与分母"] = (t) => {
  const g = mkGraph({
    edges: [failureEdge("e1", 10), failureEdge("e2", 20), failureEdge("e3", 30)],
  });
  const range = { start: 9, end: 21 };
  const inRange = failuresInFoldRange(g, range).map((e) => e.id);
  t.eq(inRange.length, 2, "只取 e1/e2（seq 10/20 与 9-21 有交集）");
  const q = measureFoldQuality({ graph: g, range, summaryText: "- e1 失败\n- e2 失败\n" });
  t.eq(q.expectedFailures, 2, "分母是区间内的 2 条");
  t.eq(q.failureRecall, 1, "两条都被提到 ⇒ 1");
  const qMiss = measureFoldQuality({ graph: g, range, summaryText: "- e1 失败\n" });
  t.eq(qMiss.failureRecall, 0.5, "少一条 ⇒ 0.5");
  t.eq(qMiss.missingFailures[0], "e2", "点名缺 e2");
};

tests["Q-4 残留（residue）失败边不算「本次 fold 该保的」"] = (t) => {
  const residue = failureEdge("e9", 40, { to: null, ts: now - 24 * 60 * 60 * 1000 });
  const g = mkGraph({ edges: [failureEdge("e1", 10), residue] });
  t.eq(
    failuresInFoldRange(g, null).map((e) => e.id).join(","),
    "e1",
    "residue 必须被排除（与 renderFacts/热清单的 P6-A 口径一致）",
  );
};

tests["Q-5 空集返回 1（没有可丢的 ≠ 全丢了）；压缩比只在两个数都有时才算"] = (t) => {
  const g = mkGraph();
  const q = measureFoldQuality({ graph: g, summaryText: "## 目标\n- 随便写\n" });
  t.eq(q.constraintRecall, 1, "没有约束 ⇒ 召回率 1（不许报 0）");
  t.eq(q.failureRecall, 1, "没有失败边 ⇒ 召回率 1（不许报 0）");
  t.eq(q.compressionRatio, null, "没有 shadowedTokens ⇒ 比值 null（不许瞎算）");
  // ASCII 按 1/4 token 算（宿主口径）：400 个 x ≈ 100 tokens ⇒ 8000/100 = 80
  const withTokens = measureFoldQuality({ graph: g, summaryText: "x".repeat(400), shadowedTokens: 8000 });
  t.eq(withTokens.compressionRatio, 80, "8000 / 100 估算 token = 80（记录趋势用，不设阈值）");
};

tests["Q-7 summaryTokens 用 CJK 感知口径（4 单位=1 token），不是 chars/2"] = (t) => {
  const g = mkGraph();
  // 12 个汉字（12×4=48 单位）+ 40 个 ASCII（40 单位）= 88 单位 ⇒ ceil(88/4) = 22 tokens
  const text = "汉".repeat(12) + "a".repeat(40);
  const q = measureFoldQuality({ graph: g, summaryText: text, shadowedTokens: 1000 });
  t.eq(q.summaryTokens, 22, "CJK 1 token/字 + 其余 1/4 的口径（与热清单/bench 同一套）");
  t.eq(q.compressionRatio, Math.round((1000 / 22) * 100) / 100, "compressionRatio = 遮蔽 ÷ 该口径 token");
  // 旧口径 Math.ceil(chars/2) 会把同一段文本算成 26 —— 两种口径必须区分开，否则比值被系统性低估
  t.ne(q.summaryTokens, Math.ceil(text.length / 2), "不许退回 chars/2 的粗估口径");
};

tests["Q-6 模型输出 vs 最终产物：机械追加段让 constraintRecall 从 <1 回到 1"] = (t) => {
  const g = mkGraph({ constraints: ["约束甲", "约束乙"] });
  const modelOnly = measureFoldQuality({ graph: g, modelText: "## 目标\n- 约束甲\n", summaryText: "## 目标\n- 约束甲\n" });
  t.eq(modelOnly.modelConstraintRecall, 0.5, "模型自己只写了一条");
  t.eq(modelOnly.constraintRecall, 0.5, "最终产物如果没机械追加，就和模型一样");
  const withMechanical = measureFoldQuality({
    graph: g,
    modelText: "## 目标\n- 约束甲\n",
    summaryText: "## 目标\n- 约束甲\n\n## 约束（机械保留，逐字；不由模型改写）\n- 约束甲\n- 约束乙\n",
  });
  t.eq(withMechanical.constraintRecall, 1, "机械追加后最终产物必须 1（这是设计保证）");
  t.eq(withMechanical.modelConstraintRecall, 0.5, "模型自身保真度仍然如实记录");
};

tests["幻觉探针：摘要里提到、图里没有的 eN/nN 必须被点名"] = (t) => {
  // 为什么：摘要由模型生成，它可能写出不存在的边 id（"e99 说明……"），而后续模型会把编号当事实引用。
  // 这类幻觉不需要模型判断就能抓 —— 图里有就是有，没有就是没有。
  const g = { nodes: { n1: {}, n2: {} }, edges: { e1: {}, e12: {} } };
  const r = findUnknownIds(g, "e1 试过失败；e12 也失败；e99 是编的；n1 是当前；n3 不存在；e1 重复一次");
  t.eq(r.checked, 5, `提到的 id 去重后应为 5 个（e1/e12/e99/n1/n3），实际 ${r.checked}`);
  t.eq(r.unknown, ["e99", "n3"], `只报图里没有的，且保序，实际 ${JSON.stringify(r.unknown)}`);
  // 普通数字不该误报：中文序号、英文 step、版本号、纯数字
  t.eq(findUnknownIds(g, "第 3 步 / step 3 / v2 版本 / 共 12 次").unknown, [], "无字母前缀的数字不许误报");
  // e1 与 e12 必须分开（这是老坑：子串匹配会把 e1 算进 e12）
  t.eq(findUnknownIds({ nodes: {}, edges: { e12: {} } }, "e1 ").unknown, ["e1"], "e1 不能被 e12 的存在骗过");
};

tests["Q-8 越界引用（C104）：图里有、但不在本次折叠区间内的 id 必须被点出来"] = (t) => {
  const graph = {
    nodes: { n1: { id: "n1", seq: 5 }, n2: { id: "n2", seq: 200 } },
    edges: { e1: { id: "e1", evidence: { start: 10, end: 20 } }, e2: { id: "e2", evidence: { start: 100, end: 110 } } },
  };
  const inRange = findOutOfRangeIds(graph, { start: 1, end: 50 }, "e1 说明 n1 的问题；e2 与 n2 是后来的事");
  t.eq(inRange.outOfRange.includes("e2"), true, "e2（证据 100-110）在区间外，必须报");
  t.eq(inRange.outOfRange.includes("n2"), true, "n2（seq 200）在区间外，必须报");
  t.eq(inRange.outOfRange.includes("e1"), false, "e1 在区间内，不许报");
  t.eq(inRange.outOfRange.includes("n1"), false, "n1 在区间内，不许报");

  t.eq(findOutOfRangeIds(graph, null, "e2 n2").outOfRange.length, 0, "没有区间时不判（手动/tier2 无从界定）");
  t.eq(findOutOfRangeIds(graph, { start: 1, end: 50 }, "e99 n99").outOfRange.length, 0, "不存在的 id 归幻觉探针，这里不重复报");
  t.eq(findOutOfRangeIds(graph, { start: 1, end: 50 }, "step3 xe1y e1").outOfRange.length, 0, "非独立 token（xe1y / step3）不许误判");
};

tests["Q-9 被置换合并吞掉的节点 id 不算幻觉（C105）"] = (t) => {
  const graph = {
    nodes: {
      n1: { id: "n1", seq: 5, superseded: [{ id: "n9", seq: 9, goal: "旧目标" }] },
      n2: { id: "n2", seq: 30 },
    },
    edges: {},
  };
  // 合并后的节点已从 nodes 里删除，只留在 n1.superseded —— 摘要引用它是**正确**的
  const merged = findUnknownIds(graph, "n9 那条死路已经试过");
  t.eq(merged.unknown.length, 0, `合并 id 不许报成幻觉：${JSON.stringify(merged)}`);
  // 真编造的仍要抓到
  const fake = findUnknownIds(graph, "n999 说明……");
  t.eq(fake.unknown.includes("n999"), true, "不存在的 id 仍必须报");
  // 越界探针对合并 id 也不该报（它已不在图里，归幻觉 / 合并两处，不重复）
  t.eq(findOutOfRangeIds(graph, { start: 1, end: 10 }, "n9").outOfRange.length, 0, "合并 id 不许在越界探针里重复报");
};

tests["C194 反向区间传进 foldClosureOf / foldBoundaryOf 也必须算对（不能报「覆盖 0 / 重叠 0」）"] = (t) => {
  const g = createGraph({ sessionId: "s" });
  const n1 = addUserNodeId(g, { seq: 100, text: "目标" });
  const e = addEdge(g, { from: n1, intent: "步骤", action: "bash(x)", evidence: { start: 120, end: 121 } });
  const n2 = addAgentNode(g, { seq: 121, goal: "结果", worldHash: "W", constraintHash: "C", via: e }).id;
  settleEdge(g, e, { to: n2, result: "success", verify: { kind: "exit", summary: "exit 0" } });

  const forward = foldClosureOf(g, { start: 100, end: 121 });
  const reversed = foldClosureOf(g, { start: 121, end: 100 });
  t.eq(forward.preGraph, false, "正向区间应在本图内");
  t.eq(reversed.nodes, forward.nodes, `反向区间的节点数必须与正向一致（实际 ${reversed.nodes} vs ${forward.nodes}）`);
  t.eq(reversed.edges, forward.edges, "反向区间的边数也必须一致");
  t.eq(reversed.nodes > 0, true, "反向区间不许报「覆盖 0 个节点」");

  const bForward = foldBoundaryOf(g, { start: 100, end: 121 });
  const bReversed = foldBoundaryOf(g, { start: 121, end: 100 });
  t.eq(bReversed.overlapping, bForward.overlapping, `反向区间的重叠边数必须一致（${bReversed.overlapping} vs ${bForward.overlapping}）`);
  t.eq(bReversed.openAtEnd, bForward.openAtEnd, "openAtEnd 也必须一致");
};
