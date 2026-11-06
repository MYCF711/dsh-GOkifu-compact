/**
 * rollback-persist.test.mjs —— 回滚**不许跨过「已成功落盘」的边界**（C640）
 *
 * 真机现场（2026-11-05，<SESSION_ID>）：基线 `nextNode=3779`、n1..n3778 一个不缺，
 * **唯独 n3780 没有任何记录**；而 delta 里有一帧写着 `e3913 { from:"n3780", to:"n3781" }`，
 * `nodes/n3780.md` 还在 ⇒ 它曾经在内存里，只是图记录**永久消失了**。
 *
 * 复现链（四步，缺一步就复现不出来）：
 *   ① `compactIfNeeded` 入口拍快照（`toJSON` + `peekDirty`）；
 *   ② fold 期间（`await compactRegion` 里）keeper 照常落账，**1.2s debounce 的 flush 真的写了**
 *      —— 这些节点在**快照之后**创建 ⇒ 快照里没有它们，但它们是磁盘上的真实记录（dirty 已清）；
 *   ③ fold 失败 / 折不动 ⇒ `restoreFromSnapshot` 把图**整体**换回快照 ⇒ 它们从内存消失；
 *      而 dirty 清空后只回填「快照时刻的 dirty」⇒ 再没有任何路径会把它们写出来；
 *   ④ 回滚后的 `#flush({tree:true})` 一旦满足 `full || deltaBytes > compactLimit`
 *      ⇒ `kifu-persist.flush()` 重写基线 + `writeFileSync(deltaFile, "")` **清空 delta**
 *      ⇒ delta 层也没了。**图上没有、delta 也没有 = 记录永久丢失。**
 *
 * 还有一次「晚一步」的丢失（C640-2 钉的就是它）：就算 ④ 没跨过压缩阈值（delta 完好），
 * **下一次 `agent/status idle` 的 `#flush({full:true})` 照样重写基线并清空 delta** ⇒ 同样丢。
 * 所以「回滚时先别重写基线」（方案 B）只能把丢的**时机**往后推一步，不能修好。
 *
 * ⚠ 与任务书原文的差异（实测）：任务书写的顺序是「建 A → flush → 拍快照 → 建 B → 回滚 → flush」。
 *   按这个顺序 A 落在**快照里**，回滚会把它带回内存、重写基线也带着它 ⇒ **这条用例是绿的**，
 *   复现不出来。真正的必要条件是「**快照之后**创建、**回滚之前**已成功落盘」——
 *   C640-3 把这个口径差异也钉住了，免得下一个人照着错顺序写出一个永远绿的守卫。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import {
  addAgentNode,
  addEdge,
  addUserNode,
  applyDirtySnapshot,
  clearDirty,
  createGraph,
  deltaFromDirty,
  peekDirty,
  restoreFromSnapshot,
  settleEdge,
  toJSON,
  validate,
} from "./graph-fixtures.mjs";
import { createFsPort, createPersistStore } from "../src/rooms/kifu-persist.mjs";
import { auditGraph } from "../scripts/graph-audit.mjs";

/** 一个够大、够简单的用户原话：让 delta 帧跨过 64KB 的压缩阈值（第 ④ 步的必要条件）。 */
const PAD = "x".repeat(70 * 1024);

const SESSION = { id: "s-rollback", cwd: "D:/tmp/proj" };

/** 临时会话目录 + 落盘 store。 */
function newStore() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c640-"));
  return {
    root,
    store: createPersistStore({ port: createFsPort(), root }),
    dir: nodePath.join(root, "sessions", SESSION.id),
  };
}

/** 一张干净的小图（两条边：user → agent）。 */
function baseGraph() {
  const g = createGraph({ sessionId: SESSION.id });
  const u = addUserNode(g, { seq: 1, text: "根目标：把折叠跑绿" }).id;
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(node test/run.mjs)" });
  const a = addAgentNode(g, { seq: 2, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: a, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  clearDirty(g);
  return { g, u, e, a };
}

function size(p) {
  try {
    return nodeFs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** delta 压缩阈值：`max(DELTA_COMPACT_MIN, 基线×RATIO)`，与 kifu-persist 逐字一致。 */
function compactLimit(dir) {
  return Math.max(64 * 1024, Math.floor(size(nodePath.join(dir, "graph.json")) * 0.2));
}

export const tests = {};

/* ───────────── 真红：两条独立路径都必须丢记录 ───────────── */

tests["C640-1 真红：快照之后已成功落盘的节点，回滚 + tree 落盘后必须仍然可读"] = (t) => {
  const { root, store, dir } = newStore();
  try {
    const { g, a } = baseGraph();
    store.flush(SESSION, g, { tree: true }); // 基线
    // ① 拍快照（此刻 delta 是干净的）
    const snapshot = toJSON(g);
    const snapshotDirty = peekDirty(g);

    // ② fold 的 await 期间：真实事件建了节点，1.2s debounce 的 flush 真的把它写了
    const lost = addUserNode(g, { seq: 3, text: PAD }).id;
    const lostEdge = addEdge(g, { from: a, intent: "看日志", action: "bash(tail log)", evidence: { start: 20, end: 24 } });
    const r1 = store.flush(SESSION, g, { tree: false });
    t.eq(r1.wroteDelta, true, "它进了 delta 层（不是基线）");
    t.eq(peekDirty(g).empty, true, "flush 成功后 dirty 清空 —— 「已成功落盘」的定义就是这一句");

    // 第 ④ 步的必要条件：delta 必须已超过压缩阈值（否则回滚后的 flush 不会重写基线）
    const limit = compactLimit(dir);
    const deltaBytes = size(nodePath.join(dir, "graph.json.delta.jsonl"));
    t.eq(deltaBytes > limit, true, `夹具前提：delta(${deltaBytes}) > compactLimit(${limit}) ⇒ 回滚后的 flush 会走「重写基线 + 清空 delta」`);

    // ③ fold 失败 ⇒ 回滚到快照
    restoreFromSnapshot(g, snapshot, snapshotDirty);
    // ④ 引擎的回滚落盘：engine.mjs 三处 `this.#flush(session, { tree: true })`
    const r2 = store.flush(SESSION, g, { tree: true });
    t.eq(r2.wroteBaseline, true, "夹具确实命中了「重写基线 + 清空 delta」那条分支（否则这条用例什么都没测到）");

    // ★ 验收：回滚 + 落盘之后，磁盘上的图仍然必须读得到它
    const loaded = store.load(SESSION).graph;
    t.eq(
      Object.keys(loaded.nodes).includes(lost),
      true,
      `回滚后 ${lost} 的记录不许消失（磁盘上现在只有 ${Object.keys(loaded.nodes).join(",")}）`,
    );
    t.eq(Object.keys(loaded.edges).includes(lostEdge), true, `它那条边 ${lostEdge} 也不许消失（边在 delta 里、端点却没了 = 悬空边）`);
    t.eq(loaded.nodes[lost]?.text?.length, PAD.length, "内容必须逐字保留（不是补出来的桩）");
    t.eq(loaded.nodes[lost]?.stub, undefined, "不许用 stub 冒充—— stub 只该给「端点被删、边还在」的历史补位");
    t.eq(auditGraph(loaded), [], `落盘后的图必须自洽（悬空边/order 缺漏都不许有）：${auditGraph(loaded).join("; ")}`);
    t.eq(nodeFs.existsSync(nodePath.join(dir, "nodes", `${lost}.md`)), true, `派生视图 nodes/${lost}.md 必须存在（图与文档不许分叉）`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C640-2 真红：回滚后没跨阈值也不许在下一次 idle 的 full 落盘里丢（⇒「回滚时不重写基线」不够）"] = (t) => {
  const { root, store } = newStore();
  try {
    const { g, a } = baseGraph();
    store.flush(SESSION, g, { tree: true });
    const snapshot = toJSON(g);
    const snapshotDirty = peekDirty(g);

    // 这次不塞 70KB：让回滚后的 tree flush **不**跨阈值 —— 也就是方案 B 能做到的样子
    const lost = addUserNode(g, { seq: 3, text: "fold 期间的真实事件节点" }).id;
    const lostEdge = addEdge(g, { from: a, intent: "看日志", action: "bash(tail log)" });
    t.eq(store.flush(SESSION, g, { tree: false }).wroteDelta, true, "先真的落进 delta");

    restoreFromSnapshot(g, snapshot, snapshotDirty);
    const r2 = store.flush(SESSION, g, { tree: true });
    t.eq(r2.wroteBaseline, false, "前提：回滚后的这次 flush 没跨阈值（方案 B 就想要这个效果）");
    t.eq(Object.keys(store.load(SESSION).graph.nodes).includes(lost), true, "此刻磁盘上还有它（delta 帧还在）—— 方案 B 停在这一步，看起来「修好了」");

    // agent/status idle 边界 —— engine.mjs 的 `#flush(agent.session, { full: true })`
    const r3 = store.flush(SESSION, g, { full: true });
    t.eq(r3.wroteBaseline, true, "idle 边界一定会重写基线");
    const loaded = store.load(SESSION).graph;
    t.eq(Object.keys(loaded.nodes).includes(lost), true, `★ 真正的验收：idle full 落盘之后它仍然必须可读（否则方案 B 只是把丢失推迟了一次）`);
    t.eq(Object.keys(loaded.edges).includes(lostEdge), true, "边也一样");
    t.eq(auditGraph(loaded), [], `图必须自洽：${auditGraph(loaded).join("; ")}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

/* ───────────── 口径：任务书原文顺序复现不出来（把它钉住） ───────────── */

tests["C640-3 口径：A 在**快照之前**落盘时复现不出来 —— 必要条件写错就会得到一条永远绿的守卫"] = (t) => {
  const { root, store } = newStore();
  try {
    const { g } = baseGraph();
    store.flush(SESSION, g, { tree: true });
    // 「建 A → flush（dirty 清空）→ 拍快照」
    const A = addUserNode(g, { seq: 5, text: PAD }).id;
    t.eq(store.flush(SESSION, g, { tree: false }).wroteDelta, true, "A 落进 delta");
    const snapshot = toJSON(g);
    const snapshotDirty = peekDirty(g);
    // 「→ 建 B（引 A）→ 回滚 → 再 flush」
    const B = addUserNode(g, { seq: 6, text: "回滚点之后才建的 B" }).id;
    restoreFromSnapshot(g, snapshot, snapshotDirty);
    const r = store.flush(SESSION, g, { tree: true });
    t.eq(r.wroteBaseline, true, "回滚后这次 flush 确实跨过阈值重写了基线（A 也在这份基线里 —— 它在快照里）");

    const loaded = store.load(SESSION).graph;
    t.eq(Object.keys(loaded.nodes).includes(A), true, "A 在快照里 ⇒ 回滚会把它带回内存、重写基线也带着它 ⇒ **绿**（所以这个顺序不是复现）");
    t.eq(Object.keys(loaded.nodes).includes(B), false, "B 快照之后创建、从未落盘 ⇒ 被回滚掉是**正确**的（它从没写进磁盘，没有任何东西消失）");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

/* ───────────── 模型层：为什么「只把 id 重新标 dirty」是空操作 ───────────── */

tests["C640-4 模型层：deltaFromDirty 会跳过不在图里的 id ⇒「只把 id 重新标 dirty」不可能是修复"] = (t) => {
  // 这条是**语义钉子**，不是复现：方案 A 的字面形态（回滚后只把 id 放回 dirty）行不通，
  // 因为回滚已经把**内容**从 `g.nodes` 里删掉了，而 delta 帧只从图上取节点。
  const { g } = baseGraph();
  const ghost = "n999"; // 曾经落盘、但回滚后不在图里的 id（n3780 就是这个形状）
  applyDirtySnapshot(g, { nodes: [ghost], edges: [], delNodes: [], delEdges: [], orderAppend: [ghost], orderDrop: [] });
  t.eq(peekDirty(g).nodes.includes(ghost), true, "dirty 里确实有它 —— 方案 A 做到了这一步");

  const frame = deltaFromDirty(g, peekDirty(g));
  t.eq(frame.nodes[ghost] ?? null, null, `但 delta 帧里没有它（本帧节点 = ${JSON.stringify(Object.keys(frame.nodes))}）`);
  t.eq(Object.keys(frame.nodes).length, 0, "这一帧其实什么都没写 ⇒ 白写一帧，记录照样丢");
  t.eq(frame.orderAppend, [ghost], "order 里倒是留了个没有任何节点的 id —— 回放后就是「order 有幽灵节点」");
};

/* ───────────── 修完不许留下坏图 ───────────── */

tests["C640-5 修完的图必须自洽：order 齐全、id 不回收、未落盘的残骸一起丢弃"] = (t) => {
  const { root, store } = newStore();
  try {
    const { g, a } = baseGraph();
    store.flush(SESSION, g, { tree: true });
    const snapshot = toJSON(g);
    const snapshotDirty = peekDirty(g);

    const kept = addUserNode(g, { seq: 3, text: "快照之后、已落盘" }).id;
    const keptEdge = addEdge(g, { from: a, intent: "看日志", action: "bash(tail log)" });
    store.flush(SESSION, g, { tree: false }); // 已落盘

    // attempt 期间**还没落盘**的残骸：节点 + 引用它的边
    const ghost = addUserNode(g, { seq: 4, text: "attempt 里刚建、还没落盘" }).id;
    const ghostEdge = addEdge(g, { from: ghost, intent: "越界调用", action: "bash(rm -rf /)" });

    restoreFromSnapshot(g, snapshot, snapshotDirty);
    store.flush(SESSION, g, { tree: true });

    // ① 图自洽：order 与 nodes 双向一致、没有悬空边
    t.eq(auditGraph(g), [], `回滚后的内存图必须自洽：${auditGraph(g).join("; ")}`);
    t.eq(validate(g), [], `validate 不许报悬空边：${validate(g).join("; ")}`);

    // ② 已落盘的内容回来了
    t.eq(Object.keys(g.nodes).includes(kept), true, "已落盘的节点必须回来");
    t.eq(Object.keys(g.edges).includes(keptEdge), true, "已落盘的边必须回来");

    // ③ 未落盘的残骸一起丢弃 —— **不许**留下一条指向不存在节点的边（那正是我们在防的悬空边）
    t.eq(Object.keys(g.nodes).includes(ghost), false, "未落盘的 attempt 节点要丢掉（回滚的本意）");
    t.eq(Object.keys(g.edges).includes(ghostEdge), false, "引用它的那条边也必须一起丢，否则就是自己造一条悬空边");

    // ④ id 不许回收：否则以后新建的节点会占用**已落盘记录**的 id（真机 n3780 与 n3781 并存就是这么来的）
    t.eq(Number(g.nextNode) > Number(String(kept).slice(1)), true, `nextNode(${g.nextNode}) 必须大于保留下来的 id(${kept})，否则会复用`);
    const later = addUserNode(g, { seq: 9, text: "回滚之后才建的节点" }).id;
    t.ne(later, kept, `新节点不许复用已落盘记录的 id（拿到 ${later}，保留的是 ${kept}）`);
    t.eq(g.nodes[kept]?.text, "快照之后、已落盘", "保留节点的内容不许被后来的节点覆盖");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};
