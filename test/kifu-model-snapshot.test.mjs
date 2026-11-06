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
import { applyDelta, markNodeDeleted } from "../src/rooms/kifu-model.mjs";
import { createPersistStore, createFsPort } from "../src/rooms/kifu-persist.mjs";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

export const tests = {};

function build() {
  const g = createGraph({ sessionId: "s" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿" }).id;
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

tests["C114 端到端：回滚后落盘再 load，节点不许丢（C113 的真实验收）"] = (t) => {
  const NL = String.fromCharCode(10);
  void NL;
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c114-"));
  try {
    const store = createPersistStore({ port: createFsPort(), root });
    const { g, n } = build();
    const snap = toJSON(g);
    // ① 基线落盘（干净状态）
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });

    // ② fold 期间合并 → ③ 回滚（模拟 engine 的 restore）
    mergeNodeInto(g, n, g.order[0]);
    restoreFromSnapshot(g, snap);
    // ④ 回滚后落盘（真实 engine 现在走的是非 full 分支 —— delta）
    const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    t.eq(r.ok, true, "回滚后的落盘必须成功");

    // ⑤ 重新 load（等价于「下次重启」）
    const loaded = store.load({ id: "s1", cwd: "D:/tmp/proj" });
    const ids = Object.keys(loaded.graph.nodes);
    t.eq(ids.includes(n), true, `load 后节点 ${n} 必须还在（C113 之前的 bug 会把它删掉）：${ids.join(",")}`);
    t.eq(ids.length, 2, `节点数必须仍为 2，实际 ${ids.length}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C142-1 快照时刻未落盘的 dirty 必须在回滚后保留（否则那个节点永远写不下去）"] = (t) => {
  const { g } = build();
  // 关键：**不清 dirty** —— 模拟「本轮用户节点刚进 keeper、还没落盘就触发了 fold」
  const u2 = addUserNode(g, { seq: 50, text: "还没落盘的新节点" }).id;
  const pendingDirty = peekDirty(g);
  t.eq(pendingDirty.nodes.includes(u2), true, "夹具前提：新节点必须在 dirty 里");

  const snap = toJSON(g);
  // 失败尝试期间：合并了另一个节点（产生 delNodes）
  mergeNodeInto(g, g.order[0], g.order[0] === u2 ? g.order[1] : g.order[0]);

  restoreFromSnapshot(g, snap, pendingDirty);
  t.eq(Object.keys(g.nodes).includes(u2), true, "新节点必须还在图里");
  const after = peekDirty(g);
  t.eq(after.nodes.includes(u2), true, `回滚后 pending 节点必须仍在 dirty 里（否则不会落盘）：${JSON.stringify(after)}`);
  const delta = deltaFromDirty(g, after);
  t.eq(!!(delta.nodes && delta.nodes[u2]), true, "delta 帧必须带上这个还没落盘的节点");

  // 反证：**不带** dirty 快照去恢复（C113 的旧形态）⇒ pending 被抹掉，delta 里没有这个节点
  const g2 = build().g;
  const p2 = addUserNode(g2, { seq: 51, text: "另一个还没落盘的节点" }).id;
  const snap2 = toJSON(g2);
  const dirtyBefore2 = peekDirty(g2);
  t.eq(dirtyBefore2.nodes.includes(p2), true, "夹具前提：第二个节点也在 dirty 里");
  restoreFromSnapshot(g2, snap2); // 旧形态：不传 dirty
  t.eq(peekDirty(g2).empty, true, "旧形态会把 dirty 清空（这正是 C142 的 P0 根因）");
  t.eq(!!deltaFromDirty(g2, peekDirty(g2)).nodes[p2], false, "旧形态的 delta 不含该节点 ⇒ 重启后它会消失");
};

tests["C142-2 端到端：快照带 pending 节点 ⇒ 回滚 + 落盘 + load 后节点仍在"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c142-"));
  try {
    const store = createPersistStore({ port: createFsPort(), root });
    const { g } = build();
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true }); // 基线（干净）
    // 新增一个还没落盘的节点（dirty），然后拍快照
    const pending = addUserNode(g, { seq: 60, text: "fold 期间刚出现的节点" }).id;
    const snap = toJSON(g);
    const pendingDirty = peekDirty(g);
    // 失败尝试：删掉/合并点东西
    const victim = Object.keys(g.nodes).find((id) => id !== pending);
    if (victim) {
      delete g.nodes[victim];
      g.order = g.order.filter((x) => x !== victim);
    }
    restoreFromSnapshot(g, snap, pendingDirty);
    const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    t.eq(r.ok, true, "回滚后的落盘必须成功");

    const loaded = store.load({ id: "s1", cwd: "D:/tmp/proj" });
    t.eq(Object.keys(loaded.graph.nodes).includes(pending), true, `load 后 pending 节点必须还在（C142 的 P0）：${Object.keys(loaded.graph.nodes).join(",")}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C146 快照里「创建后又删除」的节点不许进 orderAppend（否则重放出幽灵节点）"] = (t) => {
  const { g } = build();
  const created = addUserNode(g, { seq: 70, text: "临时节点" }).id;
  const dirtyWithCreate = peekDirty(g);
  t.eq(dirtyWithCreate.orderAppend.includes(created), true, "夹具前提：创建后 orderAppend 里有它");

  // 构造「创建后又删除」：delNodes 有它、orderAppend 也有它
  const snapshot = { ...dirtyWithCreate, delNodes: [...dirtyWithCreate.delNodes, created] };
  const restored = restoreFromSnapshot(g, toJSON(g), snapshot);
  t.eq(peekDirty(restored).orderAppend.includes(created), false, `已删节点不许进 orderAppend（C146）：${JSON.stringify(peekDirty(restored).orderAppend)}`);

  // 端到端：把这份 delta 回放到一张干净图上，order 里不许留下幽灵
  const delta = deltaFromDirty(restored, peekDirty(restored));
  const target = build().g;
  applyDelta(target, delta);
  const ghosts = target.order.filter((id) => !target.nodes[id]);
  t.eq(ghosts.length, 0, `回放后 order 不许有幽灵节点：${ghosts.join(",")}`);
};

tests["C148 创建后立刻删除：orderAppend 必须被摘掉，回放后不许有幽灵 order"] = (t) => {
  const g = createGraph({ sessionId: "s" });
  const temp = addUserNode(g, { seq: 1, text: "临时" }).id;
  t.eq(peekDirty(g).orderAppend.includes(temp), true, "夹具前提：创建后进 orderAppend");
  markNodeDeleted(g, temp);
  t.eq(peekDirty(g).orderAppend.includes(temp), false, "markNodeDeleted 必须同时把它从 orderAppend 摘掉（复审 P1-4）");

  const delta = deltaFromDirty(g, peekDirty(g));
  t.eq((delta.orderAppend ?? []).includes(temp), false, "delta 的 orderAppend 不许含它");
  // 回放到**空图**（delta 只对它自己的基线有效；用 build() 会撞 id，那是夹具问题不是行为）
  const target = createGraph({ sessionId: "s-empty" });
  applyDelta(target, delta);
  t.eq(target.order.length, 0, `order 必须仍为空，实际 ${JSON.stringify(target.order)}`);
  t.eq(target.order.filter((id) => !target.nodes[id]).length, 0, "回放后不许出现幽灵 order");
};
