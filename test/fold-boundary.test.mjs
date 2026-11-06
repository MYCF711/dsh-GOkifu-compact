/**
 * fold-boundary.test.mjs —— 「折叠边界完整性」的回归（2026-11-02，C31）
 *
 * 判据：fold 在 step 边界执行，正常**不会**把一次工具调用切成两半（证据区间跨过 fold 终点）。
 * 一旦切开，摘要会引用一个结果落在区间外的调用 —— 模型回查时看到悬空 attempt。
 * 所以每次 fold 记 `boundary: { overlapping, openAtEnd, unsettled }`：
 *   · openAtEnd 必须为 0（切点落在调用中间 = 记账自相矛盾）；
 *   · unsettled 是区间内未结算边数（正常 folding 可能包含正在进行的尝试，只观测不判错）。
 */

import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge } from "./graph-fixtures.mjs";
import { foldBoundaryOf } from "../src/rooms/kifu-model.mjs";

export const tests = {};

/** 四条边证据区间（互不共享 seq 边界，贴近真实 seq 递增）：e1[1,2] e2[3,4] e3[5,6] e4[7,9]。 */
function mkGraph() {
  const g = createGraph({ sessionId: "s-boundary" });
  addUserNodeId(g, { seq: 1, text: "起点" });
  const nodes = [];
  for (let i = 2; i <= 4; i += 1) {
    const node = addAgentNode(g, { seq: i, goal: `步 ${i}`, worldHash: `W${i}`, constraintHash: "C" });
    nodes.push(node.id ?? node);
  }
  const e1 = addEdge(g, { from: nodes[0], intent: "a", action: "read(x)", evidence: { start: 1, end: 2 } });
  const e2 = addEdge(g, { from: nodes[0], intent: "b", action: "read(y)", evidence: { start: 3, end: 4 } });
  const e3 = addEdge(g, { from: nodes[1], intent: "c", action: "write(z)", evidence: { start: 5, end: 6 } });
  const e4 = addEdge(g, { from: nodes[2], intent: "d", action: "bash(slow)", evidence: { start: 7, end: 9 } });
  settleEdge(g, e1, { result: "success", verify: { kind: "exit", summary: "ok" } });
  settleEdge(g, e2, { result: "success", verify: { kind: "exit", summary: "ok" } });
  settleEdge(g, e3, { result: "unverified", verify: { kind: "no-result", summary: "step closed" } });
  return { g, edges: [e1, e2, e3, e4] };
}

tests["B-1 正常切在 step 边界：openAtEnd=0；重叠边与未结算边计数正确"] = (t) => {
  const { g } = mkGraph();
  // 区间 [1,4]：重叠 e1(1-2)、e2(3-4)；两条都 success ⇒ unsettled=0；
  // 切点 4 正好是 e2 的 end（没有边跨过它）⇒ openAtEnd=0。
  const b = foldBoundaryOf(g, { start: 1, end: 4 });
  t.eq(b.overlapping, 2, `重叠边应为 2，实际 ${b.overlapping}`);
  t.eq(b.unsettled, 0, "e1/e2 都 success ⇒ unsettled=0");
  t.eq(b.openAtEnd, 0, "切点 4 落在边边界上 ⇒ openAtEnd 必须为 0");
};

tests["B-2 切在调用中间：e4 证据 7-9、区间到 8 ⇒ openAtEnd=1（必须能被抓到）"] = (t) => {
  const { g } = mkGraph();
  const b = foldBoundaryOf(g, { start: 7, end: 8 });
  // e4(7-9) 与 [7,8] 重叠且 end=9 > 8 ⇒ 切在调用中间；e4 从未结算（untested）⇒ unsettled=1。
  t.eq(b.overlapping, 1, `只有 e4 与 [7,8] 重叠，实际 ${b.overlapping}`);
  t.eq(b.openAtEnd, 1, "e4 的 end=9 > 8 ⇒ 切在调用中间（openAtEnd=1）");
  t.eq(b.unsettled, 1, `e4=untested ⇒ unsettled=1，实际 ${b.unsettled}`);
};

tests["B-3 空区间 / null range：不伪造 0 计数"] = (t) => {
  const { g } = mkGraph();
  const b = foldBoundaryOf(g, { start: 100, end: 200 });
  t.eq(b.overlapping, 0, "无重叠边");
  t.eq(b.openAtEnd, 0, "无切点");
  t.eq(foldBoundaryOf(g, null), null, "range 为 null ⇒ null");
  t.eq(foldBoundaryOf(null, { start: 1, end: 2 }), null, "图不存在 ⇒ null");
  t.eq(foldBoundaryOf(g, { start: "x" }), null, "非法 range ⇒ null");
};

tests["B-4 纯函数：不修改图，结果可 JSON 序列化（要写进 foldMarks）"] = (t) => {
  const { g } = mkGraph();
  const before = JSON.stringify(g);
  const b = foldBoundaryOf(g, { start: 1, end: 8 });
  t.eq(JSON.stringify(g), before, "不许改图");
  t.eq(typeof JSON.parse(JSON.stringify(b)), "object", "必须可序列化");
  t.eq(Object.keys(b).sort().join(","), "openAtEnd,overlapping,unsettled", "字段集合固定");
};
