/**
 * fold-closure.test.mjs —— 「可寻址闭包」的回归（2026-11-02，C24）
 *
 * 判据：一次 fold 的 seq 区间里，图里有哪些**节点/边**（计数 + 首尾 id）。
 * 它让「摘要/热清单里看到的 n41、e88 属于哪一次折叠」可以一步回答，而不是靠区间自己推。
 *
 * 只存计数与首尾 id（不存全量列表）——一个 fold 可能覆盖几百个实体，全存会让 graph.json 膨胀。
 */

import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge } from "./graph-fixtures.mjs";
import { foldClosureOf } from "../src/rooms/kifu-model.mjs";

export const tests = {};

/** 造 6 个节点（seq 1..6）与 4 条边（evidence 各占一段 seq）。 */
function mkGraph() {
  const g = createGraph({ sessionId: "s-closure" });
  const n1 = addUserNodeId(g, { seq: 1, text: "起点" });
  const nodes = [n1];
  for (let i = 2; i <= 6; i += 1) {
    const node = addAgentNode(g, { seq: i, goal: `步 ${i}`, worldHash: `W${i}`, constraintHash: "C" });
    nodes.push(node.id ?? node);
  }
  const edges = [];
  for (let i = 0; i < 4; i += 1) {
    const e = addEdge(g, { from: nodes[i], intent: `尝试 ${i}`, action: `bash(x${i})`, evidence: { start: i + 1, end: i + 2 } });
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    edges.push(e);
  }
  return { g, nodes, edges };
}

tests["CL-1 区间过滤：只统计 seq 落在 [start,end] 的节点；边按 evidence 交集算"] = (t) => {
  const { g, edges } = mkGraph();
  // 节点 seq 1..6；边 evidence 1-2 / 2-3 / 3-4 / 4-5。
  // 区间 [3,5] ⇒ 节点 seq 3/4/5 = 3 个；边与区间有交集的 = e2(2-3) / e3(3-4) / e4(4-5) = 3 条
  const closure = foldClosureOf(g, { start: 3, end: 5 });
  t.eq(closure.nodes, 3, `节点数应为 3，实际 ${closure.nodes}`);
  t.eq(closure.edges, 3, `边数应为 3，实际 ${closure.edges}`);
  t.eq(typeof closure.firstNode, "string", "必须记录首节点 id（可定位）");
  t.eq(typeof closure.lastEdge, "string", "必须记录尾边 id（可定位）");
};

tests["CL-2 首尾 id 是区间内真实的第一个/最后一个，不是全图首尾"] = (t) => {
  const { g, edges } = mkGraph();
  const closure = foldClosureOf(g, { start: 4, end: 5 });
  // 该区间覆盖边 e3(3-4) / e4(4-5)，节点 seq 4/5
  t.eq(closure.edges, 2, `边数应为 2，实际 ${closure.edges}`);
  t.eq(closure.firstEdge, edges[2], `首边应是 e3，实际 ${closure.firstEdge}`);
  t.eq(closure.lastEdge, edges[3], `尾边应是 e4，实际 ${closure.lastEdge}`);
};

tests["CL-5 preGraph：区间整体早于图的首个节点 ⇒ 标 preGraph（可回查承诺为空）"] = (t) => {
  const g = createGraph({ sessionId: "s-pre" });
  const node = addAgentNode(g, { seq: 5, goal: "晚于区间的第一步", worldHash: "W5", constraintHash: "C" });
  t.eq(node.id !== undefined, true, "夹具前置：节点要真的建出来");
  const before = foldClosureOf(g, { start: 1, end: 3 });
  t.eq(before.nodes, 0, "区间内没有节点");
  t.eq(before.preGraph, true, "区间早于图 ⇒ preGraph=true");
  t.eq(before.graphNodes, 1, "要记下当时图里有多少节点（1）");
  const after = foldClosureOf(g, { start: 100, end: 200 });
  t.eq(after.nodes, 0, "区间在图之后也没有节点");
  t.eq(after.preGraph, false, "「图之后的空区间」不是 preGraph（语义必须分开）");
};

tests["CL-6 preGraph：完全没有节点的新图 ⇒ preGraph=true；有节点在区间内 ⇒ false"] = (t) => {
  const empty = createGraph({ sessionId: "s-empty" });
  const c1 = foldClosureOf(empty, { start: 1, end: 10 });
  t.eq(c1.nodes, 0, "空图空区间");
  t.eq(c1.preGraph, true, "空图没有任何可回查实体 ⇒ preGraph=true");
  t.eq(c1.graphNodes, 0, "空图节点数 0");
  const { g } = mkGraph();
  const c2 = foldClosureOf(g, { start: 3, end: 5 });
  t.eq(c2.preGraph, false, "区间内有节点 ⇒ 不是 preGraph");
  t.eq(c2.graphNodes, 6, "图里共有 6 个节点");
};

tests["CL-3 空区间/非法 range ⇒ 结果为零而不是 null（fold 可能确实没覆盖实体）"] = (t) => {
  const { g } = mkGraph();
  const empty = foldClosureOf(g, { start: 1000, end: 2000 });
  t.eq(empty.nodes, 0, "空区间节点数 0");
  t.eq(empty.edges, 0, "空区间边数 0");
  t.eq(empty.firstNode, null, "没有节点时 firstNode 为 null");
  t.eq(foldClosureOf(g, null), null, "range 为 null 时返回 null（不是伪造 0）");
  t.eq(foldClosureOf(g, { start: "x" }), null, "非法 range 返回 null");
};

tests["CL-4 不修改图（纯函数），且结果可 JSON 序列化（要写进 graph.json）"] = (t) => {
  const { g } = mkGraph();
  const before = JSON.stringify(g);
  const closure = foldClosureOf(g, { start: 1, end: 30 });
  t.eq(JSON.stringify(g), before, "不许改图");
  t.eq(typeof JSON.parse(JSON.stringify(closure)), "object", "必须可序列化（foldMarks 会落盘）");
};
