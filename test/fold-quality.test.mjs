/**
 * fold-quality.test.mjs —— 「压缩保真度」L1 指标的回归（2026-11-01）
 *
 * 这条指标的意义是**任务级**的：丢一条约束 = 任务变了；丢一条失败边 = 下一个模型必然重踩。
 * 所以测试不测「数字好不好看」，只测三件事：
 *   1. 匹配是机械且精确的（e1 不能匹配 e12；约束必须逐字出现）；
 *   2. 区间过滤与残留过滤的口径与 renderFacts 一致（不然指标会报假警）；
 *   3. 空集返回 1（不是 0 —— 「没有可丢的」不等于「全丢了」）。
 */

import { measureFoldQuality, mentionsEdge, failuresInFoldRange } from "../src/rooms/fold-quality.mjs";

export const tests = {};

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
