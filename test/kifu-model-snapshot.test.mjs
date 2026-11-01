/**
 * kifu-model-snapshot.test.mjs —— 快照回滚必须连 dirty 一起清（2026-11-02，C113）
 *
 * 真实风险链：
 *   1. fold 期间 `backfillState` 会合并节点（`mergeNodeInto`）⇒ dirty 记下 `delNodes: [n2]`；
 *   2. fold 失败 / 选中范围为空 ⇒ engine 用快照恢复图；
 *   3. 但 `Object.assign(g, fromJSON(snapshot))` **只覆盖图数据**，dirty 记账不是可枚举快照字段 ⇒
 *      回滚后 `delNodes` 还留着；
 *   4. 下一次非 full 落盘把这个 delta 帧写进 `delta.jsonl`；
 *   5. 之后 `load` 回放 delta ⇒ **把已经恢复的节点再删一遍**，重启后节点凭空消失。
 *
 * 所以 `restoreFromSnapshot` 的语义是「图 + dirty 一起回到快照那一刻」。
 */

import {
  addAgentNode,
  addEdge,
  addUserNode,
  clearDirty,
  createGraph,
  deltaFromDirty,
  fromJSON,
  mergeNodeInto,
  peekDirty,
  restoreFromSnapshot,
  settleEdge,
  toJSON,
} from "./graph-fixtures.mjs";

export const tests = {};

function build() {
  const g = createGraph({ sessionId: "s" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿" });
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  clearDirty(g);
  return { g, u, n };
}

tests["C113-1 旧写法（只 Object.assign）会留下陈旧 delNodes —— 这是 bug 的证据"] = (t) => {
  const { g, n } = build();
  const snap = toJSON(g);
  mergeNodeInto(g, n, g.order[0]);
  t.eq(peekDirty(g).delNodes.includes(n), true, "合并后 dirty 必须记下被删节点");

  Object.assign(g, fromJSON(snap)); // 旧写法：只恢复图
  t.eq(Object.keys(g.nodes).includes(n), true, "图确实恢复了");
  const delta = deltaFromDirty(g, peekDirty(g));
  t.eq(delta.delNodes.includes(n), true, `旧写法会把「删除已恢复节点」写进 delta（真实风险）：${JSON.stringify(delta.delNodes)}`);
};

tests["C113-2 restoreFromSnapshot：图恢复 + dirty 清空 ⇒ delta 不含任何删除"] = (t) => {
  const { g, n } = build();
  const snap = toJSON(g);
  mergeNodeInto(g, n, g.order[0]);
  restoreFromSnapshot(g, snap);
  t.eq(Object.keys(g.nodes).includes(n), true, "节点必须回来");
  t.eq(peekDirty(g).empty, true, `回滚后 dirty 必须干净：${JSON.stringify(peekDirty(g))}`);
  const delta = deltaFromDirty(g, peekDirty(g));
  t.eq(delta.delNodes.length, 0, "delta 不许再带删除记录");
  t.eq(delta.orderDrop.length, 0, "orderDrop 也不许带");
};
