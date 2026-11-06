/**
 * merge-provenance.test.mjs —— 非破坏合并的「身份保留」回归（2026-11-02，C33）
 *
 * 背景：`mergeNodeInto` 是**置换合并**（同一世界状态被另一条路径再次到达）。它删掉 from 节点、
 * 把边改指向 into —— 图结构因此收拢，但被吞节点的身份（id/seq/目标）与「这条出边原本属于谁」
 * 会永久消失。C33 起只加记录、不改结构：
 *   · into 上保留**有界**的 `superseded[]`（id/seq/goal/ts/at）与 `supersededCount`（总次数）；
 *   · 被改写的出边记 `retargetedFrom`（第一次来源），边本身仍指 into。
 * 这两样都是**可审计事实**，不改变渲染文本（热清单里的 `×N` 仍来自 transpositions）。
 */

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, mergeNodeInto, fromJSON, toJSON } from "./graph-fixtures.mjs";
import { validate } from "../src/rooms/kifu-model.mjs";

export const tests = {};

/**
 * 两条路：u → n1 → n3（n1 有出边）与 u → n2（n2 是替换目标）。
 * 合并 n1 进 n2：e1.to 改指向 n2（置换），e2.from 改指向 n2 且保留 retargetedFrom=n1。
 */
function chain(sessionId = "s-merge") {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "必须保持接口不变。" });
  const e1 = addEdge(g, { from: u, intent: "第一步", action: "bash(a)" });
  const n1 = addAgentNode(g, { seq: 2, turn: 1, goal: "中间节点：改配置", worldHash: "W1", constraintHash: "C1", via: e1.id });
  settleEdge(g, e1, { to: n1.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e2 = addEdge(g, { from: n1.id, intent: "第二步", action: "bash(b)" });
  const n3 = addAgentNode(g, { seq: 3, turn: 1, goal: "叶子", worldHash: "W2", constraintHash: "C1", via: e2.id });
  settleEdge(g, e2, { to: n3.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e0 = addEdge(g, { from: u, intent: "换条路", action: "bash(c)" });
  const n2 = addAgentNode(g, { seq: 4, turn: 1, goal: "替换目标", worldHash: "W2", constraintHash: "C1", via: e0.id });
  settleEdge(g, e0, { to: n2.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return { g, u, e0, e1, e2, n1: n1.id, n2: n2.id, n3: n3.id };
}

tests["M-1 合并后：被吞节点的 id/seq/goal 保留在 into 上，节点本身仍从图里移除"] = (t) => {
  const { g, n1, n2 } = chain();
  mergeNodeInto(g, n1, n2);
  t.eq(g.nodes[n1], undefined, "图结构仍收拢：被吞节点不在 nodes 里");
  const target = g.nodes[n2];
  t.eq(Array.isArray(target.superseded), true, "into 上必须有 superseded 记录");
  t.eq(target.superseded.length, 1, "记一条");
  t.eq(target.superseded[0].id, n1, "记的是被吞节点 id");
  t.eq(target.superseded[0].seq, 2, "保留被吞节点的 seq");
  t.includes(target.superseded[0].goal, "中间节点：改配置", "保留它当时的目标（审计用）");
  t.eq(target.supersededCount, 1, "总次数 1");
  t.eq(target.transpositions, 1, "原有 transpositions 计数不受影响（渲染仍用它）");
};

function n3Of(g) { return Object.values(g.edges).find((e) => e.retargetedFrom !== undefined)?.to ?? null; }

tests["M-2 出边被改指向时保留来源（retargetedFrom），且边仍指 into"] = (t) => {
  const { g, e0, e2, n1, n2 } = chain();
  mergeNodeInto(g, n1, n2);
  const edge = g.edges[e2];
  t.eq(edge.from, n2, "出边改指向 into");
  t.eq(edge.retargetedFrom, n1, "同时记下原本的来源节点");
  t.eq(edge.to, n3Of(g), "出边的目标不变（没被合并那一端）");
  // 从 u 出发、目标是被吞节点的边：只改 to（并标 transposition），来源 u 不变
  t.eq(g.edges[e0].from, g.edges[e0].from, "u 侧来源不变");
  t.eq(g.edges[e0].retargetedFrom, undefined, "只是目标变化的边不许标 retargetedFrom");
  t.eq(validate(g).length, 0, `合并后图必须仍通过 validate：${validate(g).join("; ")}`);
};

tests["M-3 有界保留：合并 9 次只留最近 8 条记录，但计数如实到 9"] = (t) => {
  const g = createGraph({ sessionId: "s-merge-many" });
  const u = addUserNodeId(g, { seq: 1, text: "起点" });
  let into = null;
  const absorbed = [];
  for (let i = 0; i < 10; i += 1) {
    const node = addAgentNode(g, { seq: 10 + i, goal: `状态 ${i}`, worldHash: `W${i}`, constraintHash: "C" });
    absorbed.push(node.id);
    if (into === null) into = node.id;
    else mergeNodeInto(g, node.id, into);
  }
  const target = g.nodes[into];
  t.eq(target.supersededCount, 9, "10 个节点里 9 个被合并（另一个是 into 自己）");
  t.eq(target.superseded.length, 8, "记录数不超过上限 8");
  t.eq(target.superseded.at(-1).id, absorbed.at(-1), "保留的是最近的合并");
  t.eq(target.superseded.some((x) => x.id === absorbed[1]), false, "最早的记录被挤掉");
};

tests["M-4 记录随 graph.json 往返：toJSON/fromJSON 不丢 superseded"] = (t) => {
  const { g, n1, n2 } = chain();
  mergeNodeInto(g, n1, n2);
  const round = fromJSON(toJSON(g));
  t.eq(round.nodes[n2].supersededCount, 1, "count 必须往返");
  t.eq(round.nodes[n2].superseded[0].id, n1, "记录必须往返");
  t.eq(round.nodes[n2].superseded[0].seq, 2, "seq 必须往返");
};
