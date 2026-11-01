/**
 * graph-audit.test.mjs —— 只读图体检的判据（2026-11-02，C139）
 *
 * 这个脚本的价值在于「**历史遗留的坏图会被点名**」：
 * flush 只在写盘时告警，老版本留下的悬空边 / 悬空索引 / order 漂移不会再被提及。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { auditGraph, auditRoot } from "../scripts/graph-audit.mjs";
import { addAgentNode, addEdge, addUserNode, createGraph, settleEdge, toJSON } from "./graph-fixtures.mjs";

export const tests = {};

function goodGraph() {
  const g = createGraph({ sessionId: "s" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿" }).id;
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return g;
}

tests["C139-1 自洽的图必须 0 问题（不许对正常图假红）"] = (t) => {
  t.eq(auditGraph(goodGraph()), [], "正常图不该有问题");
};

tests["C139-2 四类坏数据都必须被点名（悬空边 / 悬空索引 / order 漂移 / 闭包越界）"] = (t) => {
  // ① 悬空边
  const dangling = goodGraph();
  const eid = Object.keys(dangling.edges)[0];
  dangling.edges[eid].to = "n999";
  t.eq(auditGraph(dangling).some((p) => p.includes("to 节点不存在")), true, "悬空边必须报");

  // ② 悬空 stateIndex
  const idx = goodGraph();
  idx.stateIndex = { "W1/C1": "n777" };
  t.eq(auditGraph(idx).some((p) => p.includes("不存在的节点 n777")), true, "悬空索引必须报");

  // ③ order 漂移（缺节点 + 幽灵节点）
  const order = goodGraph();
  order.order = order.order.filter((id) => id !== "n1");
  order.order.push("n555");
  const op = auditGraph(order);
  t.eq(op.some((p) => p.includes("order 缺节点 n1")), true, "order 缺节点必须报");
  t.eq(op.some((p) => p.includes("order 有幽灵节点 n555")), true, "order 幽灵节点必须报");

  // ④ 闭包越界 + seq 反向
  const clos = goodGraph();
  clos.foldMarks = [{ seqStart: 9, seqEnd: 3, closure: { nodes: 7, graphNodes: 5 } }];
  const cp = auditGraph(clos);
  t.eq(cp.some((p) => p.includes("seqStart>seqEnd")), true, "seq 反向必须报");
  t.eq(cp.some((p) => p.includes("closure.nodes(7) > graphNodes(5)")), true, "闭包越界必须报");
};

tests["C139-3 auditRoot：坏文件（无法解析）也要被点名，而不是让脚本崩"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-audit-"));
  try {
    const good = nodePath.join(root, "session-good");
    nodeFs.mkdirSync(good, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(good, "graph.json"), toJSON(goodGraph()), "utf8");
    const broken = nodePath.join(root, "session-broken");
    nodeFs.mkdirSync(broken, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(broken, "graph.json"), "{not json", "utf8");

    const rows = auditRoot(root);
    t.eq(rows.length, 2, "两个会话都要出现在结果里");
    const byName = Object.fromEntries(rows.map((r) => [r.session, r.problems]));
    t.eq(byName["session-good"].length, 0, "好图必须 0 问题");
    t.eq(byName["session-broken"].some((p) => p.includes("无法解析")), true, "坏文件必须点名而不是抛出");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};
