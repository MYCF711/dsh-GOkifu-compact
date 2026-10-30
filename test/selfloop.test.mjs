/**
 * selfloop.test.mjs —— 自环 / 图坍缩回归测试（2026-10-29）
 *
 * 事故现场（三份独立评估共同指向）：
 *   全库 9,882 条边里 **6,031 条是自环**（60.9%），边/节点 3.33，极端会话 530 边 / 23 节点。
 *   直接后果：`tewariAnalysis` 的「同终点」判定恒真 ⇒ `dead` 判定 109/109 全错、
 *   `redundant` 135 条全假 ⇒ 热清单告诉模型「这条路永远别试」，而真相只是
 *   「同一步里另一条命令成功了」。**这比信息缺失严重，因为它是有毒的确定性陈述。**
 *
 * 两个根因（都已修）：
 *   1. `worldstate.touch(paths)` 收到的是**单个路径字符串**（engine 的 `st.touchPath`），
 *      却按可迭代对象遍历 ⇒ 路径被逐字符拆开 ⇒ 触碰集合是十来个字符 ⇒
 *      `hash()` 对所有会话、所有步骤返回**同一个哈希**；
 *   2. `addAgentNode` 命中 `stateIndex` 就复用，**不排除本步起点** ⇒
 *      `step/end` 把边的 `to` 指回 `from` ⇒ 自环。
 *
 * 修复前这 4 个用例全红；它们本可以提前一天抓住它（当时 125 个用例无一覆盖 `from === to`）。
 */

import {
  createGraph,
  addUserNodeId,
  addAgentNode,
  addEdge,
  settleEdge,
  tewariAnalysis,
  failureClass,
  graphHealth,
} from "./graph-fixtures.mjs";
import { createWorldTracker } from "../src/rooms/world.mjs";

const W = "w1";
const C = "c1";

/** 造一张最小可用的图：user 节点 + 一步（若干工具边）+ step 节点。 */
function oneStep(g, { fromEdgeId = null, hash = W, actions = ["bash(ls)"], results = ["success"] } = {}) {
  // 本步的起点 = 上一步的终点（与 keeper 的 state.lastNodeId 语义一致）
  const startId = fromEdgeId ? g.edges[fromEdgeId].to : g.order[0];
  const edges = actions.map((action, i) => {
    const id = addEdge(g, { from: startId, intent: `试${i}`, action });
    settleEdge(g, id, { result: results[i] ?? "unverified", verify: { kind: "none", summary: "" } });
    return id;
  });
  const node = addAgentNode(g, {
    seq: 10,
    goal: "一步",
    worldHash: hash,
    constraintHash: C,
    via: edges.at(-1),
  });
  for (const id of edges) g.edges[id].to = node.id;
  return { node: node.id, edges };
}

export const tests = {
  "★ 自环禁止：同一个 stateKey 连续两步不能把边指回起点"() {
    const g = createGraph({ sessionId: "sl1" });
    addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
    const s1 = oneStep(g);
    // 第二步：世界状态没变（只读命令），stateKey 与第一步完全相同
    const s2 = oneStep(g, { fromEdgeId: s1.edges.at(-1) });
    if (s2.node === s1.node) {
      throw new Error(`第二步复用了起点的节点 ${s1.node} —— 这就是自环的成因`);
    }
    for (const id of s2.edges) {
      if (g.edges[id].from === g.edges[id].to) throw new Error(`边 ${id} 是自环（from === to === ${g.edges[id].from}）`);
    }
  },

  "真正的置换仍然生效：回到**更早**的状态才复用节点"() {
    const g = createGraph({ sessionId: "sl2" });
    addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
    const s1 = oneStep(g, { hash: "A" });          // 状态 A
    const s2 = oneStep(g, { fromEdgeId: s1.edges.at(-1), hash: "B" }); // 状态 B
    // 从 B 再走一步，回到状态 A —— 这是真正的置换（换一条路回到之前卡住的地方）
    const s3 = oneStep(g, { fromEdgeId: s2.edges.at(-1), hash: "A" });
    if (s3.node !== s1.node) throw new Error(`回到状态 A 应复用 ${s1.node}，实际新建了 ${s3.node}`);
    if (s3.node === s2.node) throw new Error("不应复用起点节点");
  },

  "tewariAnalysis：自环边不参与手割（返回 null）"() {
    const g = createGraph({ sessionId: "sl3" });
    addUserNodeId(g, { seq: 1, text: "目标" });
    const s1 = oneStep(g);
    const id = addEdge(g, { from: s1.node, intent: "读文件", action: "read(x)" });
    settleEdge(g, id, { to: s1.node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
    if (tewariAnalysis(g, g.edges[id]) !== null) throw new Error("自环边不该得到手割结论");
  },

  "failureClass：自环边不得判 dead"() {
    const g = createGraph({ sessionId: "sl4" });
    addUserNodeId(g, { seq: 1, text: "目标" });
    const s1 = oneStep(g); // 同起点有一条成功边
    const id = addEdge(g, { from: s1.node, intent: "读文件", action: "read(x)" });
    settleEdge(g, id, { to: s1.node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
    const cls = failureClass(g.edges[id], tewariAnalysis(g, g.edges[id]));
    if (cls.kind === "dead") throw new Error("自环边被判 dead —— 这正是 109/109 误报的来源");
  },

  "worldstate.touch：收到字符串时不逐字符拆分"() {
    const w = createWorldTracker({ cwd: "D:/proj" });
    w.touch("D:/proj/a.txt");
    if (w.size !== 1) throw new Error(`一个路径被拆成了 ${w.size} 条（旧版逐字符遍历）`);
    w.touch(["D:/proj/b.txt", "D:/proj/c.txt"]);
    if (w.size !== 3) throw new Error(`数组入参应加 2 条，实际 size=${w.size}`);
    w.touch("x");
    if (w.size !== 3) throw new Error("单字符应被丢弃（旧数据里的脏元素）");
  },

  "worldstate.hash：不同路径集合必须给出不同哈希"() {
    const a = createWorldTracker({ cwd: "D:/p" });
    const b = createWorldTracker({ cwd: "D:/p" });
    a.touch("D:/p/one.txt");
    b.touch("D:/p/two.txt");
    if (a.hash().hash === b.hash().hash) throw new Error("不同触碰集合给出了同一个哈希 —— 置换判据会恒真");
  },

  "graphHealth：识别自环与边/节点比"() {
    const g = createGraph({ sessionId: "sl5" });
    addUserNodeId(g, { seq: 1, text: "目标" });
    const s1 = oneStep(g);
    for (let i = 0; i < 3; i += 1) {
      const id = addEdge(g, { from: s1.node, intent: `圈${i}`, action: "read(y)" });
      settleEdge(g, id, { to: s1.node, result: "unverified", verify: { kind: "read", summary: "" } });
    }
    const h = graphHealth(g);
    if (h.selfLoops !== 3) throw new Error(`应识别出 3 条自环，实际 ${h.selfLoops}`);
    if (h.healthy) throw new Error("自环率 100% 不应判健康");
    if (Math.abs(h.edgePerNode - h.edges / h.nodes) > 1e-9) throw new Error("边/节点比算错");
  },

  "graphHealth：干净 DAG 判健康"() {
    const g = createGraph({ sessionId: "sl6" });
    addUserNodeId(g, { seq: 1, text: "目标" });
    let prev = null;
    for (const h of ["A", "B", "C"]) prev = oneStep(g, { fromEdgeId: prev?.edges.at(-1), hash: h });
    const health = graphHealth(g);
    if (health.selfLoops !== 0) throw new Error(`干净 DAG 出现 ${health.selfLoops} 条自环`);
    if (!health.healthy) throw new Error(`干净 DAG 被判不健康：${JSON.stringify(health)}`);
  },
};

/**
 * ★ 2026-10-29：热清单的 WORKING 行不能拿自环成功边当锚点。
 * 实测渲染成「WORKING: n22 → n22」—— 一句没有任何信息的废话，还让模型以为
 * 工作路径就是原地打转。
 *
 * ★ 2026-10-30（task-33 · 修假绿）：原来这条用例写着 `if (!line) return;` ——
 * 「没有 WORKING 行也算通过」。这正是 reviewer 记的「早退 return 计 pass」：
 *   · 渲染回归成不印 WORKING 行（S2a 之前就是这个状态）⇒ 用例仍然绿；
 *   · 正则不匹配（行格式变了）⇒ 也静默通过。
 * 现在改成显式断言，并用**两种自环位置**覆盖真实事故形态：
 *   形态 1 自环加在前进边之前；形态 2 自环加在前进边之后（最后一条 success 边就是自环
 *   —— 只有这一形态能重现「WORKING: n22 → n22」，因为锚点是「最后一条成功边」）。
 */
function workingFixture(loopPlacement) {
  const g = createGraph({ sessionId: `sl7-${loopPlacement}` });
  addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  const s1 = oneStep(g);
  let s2;
  let loop;
  if (loopPlacement === "before") {
    loop = addEdge(g, { from: s1.node, intent: "原地读", action: "read(x)" });
    settleEdge(g, loop, { to: s1.node, result: "success", verify: { kind: "read", summary: "ok" } });
    s2 = oneStep(g, { fromEdgeId: s1.edges.at(-1), hash: "NEXT" });
  } else {
    s2 = oneStep(g, { fromEdgeId: s1.edges.at(-1), hash: "NEXT" });
    loop = addEdge(g, { from: s2.node, intent: "原地读", action: "read(x)" });
    settleEdge(g, loop, { to: s2.node, result: "success", verify: { kind: "read", summary: "ok" } });
  }
  return { g, s1, s2, loop };
}

tests["热清单：自环成功边不参与 WORKING 路径"] = async () => {
  const { renderLedger } = await import("../src/rooms/ledger.mjs");
  for (const placement of ["before", "after"]) {
    const { g, s2, loop } = workingFixture(placement);
    if (g.edges[loop].from !== g.edges[loop].to) throw new Error("前置：夹具里的那条边必须是自环");
    const out = renderLedger(g, { maxTokens: 3000, treeDir: "/tmp/t" });
    const line = out.text.split("\n").find((l) => l.startsWith("WORKING:"));
    // ① 必须有 WORKING 行（旧写法在这里 `return` ⇒ 渲染回归时静默变绿）
    if (!line) throw new Error(`热清单必须给出 WORKING 行（形态 ${placement}）：\n${out.text}`);
    // ② 行里必须真的有节点 id（旧写法在正则不匹配时也静默通过）
    if (!/WORKING:\s*\S+\s*→\s*\S+/.test(line)) throw new Error(`WORKING 行格式不对（形态 ${placement}）：${line}`);
    const ids = line
      .slice("WORKING:".length)
      .split(" → ")
      .map((s) => s.replace(/ \(.*\)$/, "").trim())
      .filter(Boolean);
    if (ids.length < 2) throw new Error(`WORKING 行至少要有两个节点（形态 ${placement}）：${line}`);
    // ③ 相邻两跳不许是同一节点 —— 自环进链就是这个形态（「WORKING: n22 → n22」）
    for (let i = 1; i < ids.length; i += 1) {
      if (ids[i] === ids[i - 1]) throw new Error(`WORKING 路径里出现自环跳 ${ids[i]} → ${ids[i]}（形态 ${placement}）：${line}`);
    }
    // ④ 必须真的指到「前进一步」的终点：锚点不许落在自环边上
    if (ids.at(-1) !== s2.node) throw new Error(`WORKING 的终点应是真实前进的 ${s2.node}，实际 ${ids.at(-1)}（形态 ${placement}）：${line}`);
  }
};
