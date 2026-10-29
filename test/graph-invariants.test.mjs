/**
 * graph-invariants.test.mjs —— S1a「图不变量门禁」的回归矩阵（2026-10-29）
 *
 * 为什么要有这个文件：
 *   审计测到历史自环 624 条、2 张坍缩图；`verify-graphs` 把它们**打印成 ✓ 并退出 0**
 *   （复现见计划表 §S1a）。任何只测「好图是绿的」的测试都发现不了这件事 ——
 *   所以这里把**边界、坏图、以及 CLI 退出码**一起测住，并且默认模式（兼容）与
 *   --strict（门禁）分别断言。
 *
 * 覆盖（对齐任务书第 2 条 + 2026-10-29 收口 7 项）：
 *   空图 / 单节点 / 正常链 / 正常分支 / 自环 / 边节点比超阈 / 坍缩图 / 退化图（N=0,E>0）/
 *   边界恰好等于阈值（8 恰好绿、8.5 红；自环率 5% 恰好红、4% 绿；自环 0 条绿）/
 *   默认阈值下 L>0 且 rate<5%（self-loop 红、collapsed 绿 ⇒ 蕴含方向是 collapsed ⇒ self-loop）/
 *   多图中只有一张坏图（唯一 id 合并、断言真实汇总值，证明全局聚合会稀释）/ 0 阈值不误伤空图 /
 *   CLI 退出码 0/1/2 / --json 结构 / 阈值真的生效（--max-edge-per-node=20 转绿）/
 *   严格模式逐图 ✓/✗、末尾结论、JSON 裁决与退出码一致 / 空目录不假绿 /
 *   与 graphHealth 口径逐值一致。
 *
 * 夹具纪律：
 *   · 全部写在 `os.tmpdir()` 下（`mkdtempSync`），**绝不触碰** `DSH_HOME/chess-context`；
 *   · 每个 CLI 调用前都有 `assertInsideTmp()` 守卫 —— 手滑写成真实路径会当场抛错；
 *   · 用例结束即删夹具目录。
 *
 * 变异自检（证明不是假绿）不在本文件里跑：它会把整个仓库复制到 `os.tmpdir()` 的副本，
 * **只在副本里变异和运行**（正式源码全程只读，开始/结束 tree sha256 必须一致）。
 * 单独脚本：
 *   `node /d/主工作区/tmp/dsh-gokifu-compact/s1a/mutation-selfcheck.mjs`
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createGraph,
  addUserNodeId,
  addAgentNode,
  addEdge,
  settleEdge,
  graphHealth,
} from "./graph-fixtures.mjs";
import { DEFAULT_LIMITS, checkGraph, checkGraphs, measureGraph, parseArgs } from "./graph-invariants.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const VERIFY = nodePath.join(HERE, "verify-graphs.mjs");
const TMP = nodePath.resolve(os.tmpdir());

/* ───────────────────────────── 夹具 ───────────────────────────── */

/**
 * 严格禁止夹具跑到真实棋谱目录外面。**每个** CLI 调用都先过这道守卫。
 */
function assertInsideTmp(root) {
  const resolved = nodePath.resolve(root);
  if (resolved !== TMP && !resolved.startsWith(`${TMP}${nodePath.sep}`)) {
    throw new Error(`夹具目录必须在 ${TMP} 下，实际 ${resolved} —— 拒绝触碰真实棋谱数据`);
  }
}

function withRoot(label, fn) {
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-graphinv-${label}-`));
  try {
    assertInsideTmp(root);
    return fn(root);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

function writeGraph(root, name, g) {
  const dir = nodePath.join(root, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
}

/** 空图：0 节点 / 0 边。 */
function emptyGraph() {
  return createGraph({ sessionId: "fx-empty" });
}

/** 单节点：1 个 user 节点、0 条边。 */
function singleNodeGraph() {
  const g = createGraph({ sessionId: "fx-single" });
  addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  return g;
}

/** 正常链：user + steps 步，每步 1 条边 + 1 个 agent 节点。edgePerNode = steps/(steps+1)。 */
function chainGraph(steps = 3, sessionId = "fx-chain") {
  const g = createGraph({ sessionId });
  let prev = addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  for (let i = 1; i <= steps; i += 1) {
    const edge = addEdge(g, { from: prev, intent: `第 ${i} 步`, action: "bash(ls)" });
    const agent = addAgentNode(g, { seq: i * 3, goal: `第 ${i} 步`, worldHash: `w${i}`, constraintHash: "c1", via: edge });
    settleEdge(g, edge, { to: agent.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    prev = agent.id;
  }
  return g;
}

/** 正常分支：user + 1 个 agent，从 user 发出 branches 条边（一步 K 次工具调用）。 */
function branchGraph(branches = 3, sessionId = "fx-branch") {
  const g = createGraph({ sessionId });
  const user = addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  let first = null;
  for (let i = 0; i < branches; i += 1) {
    const edge = addEdge(g, { from: user, intent: `工具 ${i}`, action: "bash(ls)" });
    settleEdge(g, edge, { result: "unverified", verify: { kind: "no-exit", summary: "" } });
    if (first === null) first = edge;
  }
  const agent = addAgentNode(g, { seq: 9, goal: "一步", worldHash: "w1", constraintHash: "c1", via: first });
  for (const edge of Object.values(g.edges)) if (!edge.to) edge.to = agent.id;
  return g;
}

/**
 * 自环/比率夹具：agents 个 agent 节点 + totalEdges 条边，其中 selfLoops 条是自环。
 * 节点数 = 1 + agents ⇒ edgePerNode = totalEdges / (1 + agents)。
 */
function loopRateGraph({ selfLoops = 0, totalEdges = 10, agents = 1, sessionId = "fx-loop" } = {}) {
  const g = createGraph({ sessionId });
  const user = addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  const agentIds = [];
  for (let i = 0; i < agents; i += 1) {
    const edge = addEdge(g, { from: user, intent: `正常 ${i}`, action: "bash(ls)" });
    const agent = addAgentNode(g, { seq: 10 + i, goal: "", worldHash: `w${i}`, constraintHash: "c1", via: edge });
    settleEdge(g, edge, { to: agent.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    agentIds.push(agent.id);
  }
  for (let i = agents + selfLoops; i < totalEdges; i += 1) {
    const edge = addEdge(g, { from: user, intent: `填充 ${i}`, action: "bash(ls)" });
    settleEdge(g, edge, { to: agentIds[i % agentIds.length], result: "unverified", verify: { kind: "no-exit", summary: "" } });
  }
  for (let i = 0; i < selfLoops; i += 1) {
    const edge = addEdge(g, { from: user, intent: `自环 ${i}`, action: "read(x)" });
    settleEdge(g, edge, { to: user, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  }
  return g;
}

/**
 * 退化图：N=0 且 E>0 —— 边表还在，节点表被清空（历史脏数据 / 合并事故的形态）。
 * 三条边的 from/to 指向已不存在的节点，且 from !== to ⇒ 自环率为 0，
 * 旧口径的 edgePerNode 因分母为 0 记 0、自环率 0 也绿 ⇒ 必须由独立判据抓。
 */
function degenerateGraph({ edges = 2, sessionId = "fx-degenerate" } = {}) {
  const g = createGraph({ sessionId });
  const a = addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  const b = addUserNodeId(g, { seq: 2, text: "重申" });
  for (let i = 0; i < edges; i += 1) {
    const edge = addEdge(g, { from: a, intent: `悬空 ${i}`, action: "bash(x)" });
    settleEdge(g, edge, { to: b, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  }
  g.nodes = {};
  g.order = [];
  g.rootUserNodeIds = [];
  g.stateIndex = {};
  return g;
}

/**
 * 把一张图的 node/edge id 全部加上前缀后取出来。
 * 用途：「多图合并」对照必须**真的相加**，不能靠两张图恰好都叫 n1/e1 撞成一张。
 */
function prefixGraph(g, prefix) {
  const nodes = {};
  for (const [id, node] of Object.entries(g.nodes)) nodes[`${prefix}${id}`] = { ...node, id: `${prefix}${id}` };
  const edges = {};
  for (const [id, edge] of Object.entries(g.edges)) {
    edges[`${prefix}${id}`] = {
      ...edge,
      id: `${prefix}${id}`,
      from: edge.from ? `${prefix}${edge.from}` : edge.from,
      to: edge.to ? `${prefix}${edge.to}` : edge.to,
    };
  }
  return { nodes, edges };
}

/* ───────────────────────────── CLI ───────────────────────────── */

function runCli(root, args = []) {
  assertInsideTmp(root);
  const result = spawnSync(process.execPath, [VERIFY, root, ...args], { encoding: "utf8", timeout: 20000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", signal: result.signal };
}

/** CLI 红必须「红得对」：退出码 1 + 指名道姓 + 有数值，而不只是非零。 */
function assertRed(t, run, { session, needles }) {
  t.eq(run.code, 1, "退出码必须是 1");
  for (const needle of needles) t.includes(run.stdout, needle, `输出必须含 ${needle}`);
  if (session) t.includes(run.stdout, session, "输出必须点名失败图");
  // 旧版这两句都是恒真：断言了一个从未出现过的字符串；真正该锁的是「红的时候不许说绿」。
  t.notIncludes(run.stdout, "== 全部健康 ==", "严格模式红时不得打印旧健康结论");
  t.notIncludes(run.stdout, "张图全部满足不变量", "严格模式红时不得同时说全部满足不变量");
}

/** 找到某张图的逐图状态行（含 facts 的那行），用来断言 ✓/✗ 与最终结论一致。 */
function rowLineOf(run, session) {
  return run.stdout.split("\n").find((line) => line.includes("facts") && line.includes(session)) ?? "";
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "度量口径：measureGraph 与 graphHealth 逐值一致（6 种图）"(t) {
    const samples = {
      empty: emptyGraph(),
      single: singleNodeGraph(),
      chain: chainGraph(4),
      branch: branchGraph(3),
      selfLoop: loopRateGraph({ selfLoops: 3, totalEdges: 4, agents: 0 }),
      storm: loopRateGraph({ selfLoops: 0, totalEdges: 17, agents: 1 }),
    };
    for (const [name, g] of Object.entries(samples)) {
      const a = measureGraph(g);
      const b = graphHealth(g);
      t.eq(
        { edges: a.edges, nodes: a.nodes, selfLoops: a.selfLoops, selfLoopRate: a.selfLoopRate, edgePerNode: a.edgePerNode },
        { edges: b.edges, nodes: b.nodes, selfLoops: b.selfLoops, selfLoopRate: b.selfLoopRate, edgePerNode: b.edgePerNode },
        `${name} 的两个口径必须逐值相同`,
      );
    }
  },

  "边界：空图/单节点分母为 0 时给 0（不是 NaN/Infinity）"(t) {
    for (const g of [emptyGraph(), singleNodeGraph()]) {
      const m = measureGraph(g);
      t.eq(m.edges, 0, "边 0");
      t.ok(Number.isFinite(m.edgePerNode) && m.edgePerNode === 0, `edgePerNode 应为 0，实际 ${m.edgePerNode}`);
      t.ok(Number.isFinite(m.selfLoopRate) && m.selfLoopRate === 0, `selfLoopRate 应为 0，实际 ${m.selfLoopRate}`);
    }
  },

  "边界：未结算边（to=null）不算自环"(t) {
    const g = createGraph({ sessionId: "fx-open" });
    const user = addUserNodeId(g, { seq: 1, text: "目标" });
    const edge = addEdge(g, { from: user, intent: "没结算", action: "bash(x)" });
    // 故意不 settleEdge ⇒ to 仍是 null
    const m = measureGraph(g);
    t.eq(m.selfLoops, 0, "to=null 不算自环");
    t.eq(m.openEdges, 1, "未结算边单独计数");
    t.ok(checkGraph({ session: "fx-open", graph: g }).ok, `单条未结算边不应判红：${JSON.stringify(m)}`);
  },

  "好图：空图 / 单节点 / 正常链 / 正常分支 必须全绿"(t) {
    const ok = [
      ["empty", emptyGraph()],
      ["single", singleNodeGraph()],
      ["chain", chainGraph(3)],
      ["branch", branchGraph(3)],
    ].map(([name, g]) => [name, checkGraph({ session: `fx-${name}`, graph: g })]);
    for (const [name, item] of ok) {
      t.ok(item.ok, `${name} 必须绿，实际红：${JSON.stringify(item.violations)}`);
      t.eq(item.violations, [], `${name} 不该有任何违反`);
    }
    t.eq(checkGraphs([]).ok, true, "空集合整体应绿（0 张图由 CLI 另行判「门禁空转」）");
  },

  "坏图：自环必须判红，并给出边 id 与条数"(t) {
    const g = loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0 });
    const item = checkGraph({ session: "fx-selfloop", sessionId: "sid-1", graph: g });
    t.eq(item.ok, false, "自环图必须红");
    const v = item.violations.find((x) => x.code === "self-loop");
    t.ok(Boolean(v), `必须报 self-loop，实际 ${JSON.stringify(item.violations.map((x) => x.code))}`);
    t.eq(v.value, 3, "自环数");
    t.eq(v.limit, 0, "默认上界 0");
    t.eq(item.metrics.selfLoopEdges.length, 3, "边 id 必须逐条给出");
    for (const id of item.metrics.selfLoopEdges) t.ok(/^e\d+$/.test(id), `边 id 形态异常：${id}`);
  },

  "坏图：边/节点比超阈判红；恰好等于 8 必须绿（判据是 > 不是 >=）"(t) {
    const at8 = branchGraph(16); // 16 边 / 2 节点 = 8.0
    const over = branchGraph(17); // 17 / 2 = 8.5
    t.eq(measureGraph(at8).edgePerNode, 8, "夹具必须恰好 8");
    t.eq(checkGraph({ session: "fx-at8", graph: at8 }).ok, true, "恰好 8 必须绿");
    const item = checkGraph({ session: "fx-over", graph: over });
    t.eq(item.ok, false, "8.5 必须红");
    const v = item.violations.find((x) => x.code === "edge-per-node");
    t.ok(Boolean(v), "必须报 edge-per-node");
    t.eq(v.limit, 8, "默认上界 8");
    t.ok(Math.abs(v.value - 8.5) < 1e-9, `数值应为 8.5，实际 ${v.value}`);
    t.includes(v.message, "8.50", "文案必须带两位小数数值");
  },

  "坏图：坍缩图在放宽自环数后仍能独立触发（自环率恰好 5% 是红）"(t) {
    const g = loopRateGraph({ selfLoops: 2, totalEdges: 40, agents: 5 }); // 40/6 ≈ 6.67，2/40 = 5%
    const m = measureGraph(g);
    t.eq(m.edges, 40, "边数");
    t.eq(m.nodes, 6, "节点数");
    t.eq(m.selfLoops, 2, "自环 2 条");
    t.eq(m.selfLoopRate, 0.05, "自环率恰 5%");

    const loose = { ...DEFAULT_LIMITS, maxSelfLoops: 2 };
    const item = checkGraph({ session: "fx-collapsed", graph: g, limits: loose });
    t.eq(item.ok, false, "放宽自环数（2 ≤ 2）后，坍缩判据必须独立把它判红");
    t.eq(item.violations.map((v) => v.code), ["collapsed-graph"], "只该坍缩判据红（自环/比率都在界内）");
    t.eq(item.violations[0].value, 0.05, "自环率数值");
  },

  "默认阈值：L>0 但自环率 4% ⇒ self-loop 红、collapsed-graph 绿（蕴含方向是 collapsed ⇒ self-loop）"(t) {
    // 2 条自环 / 50 条边 = 4%：默认 maxSelfLoops=0 下自环判据红，但坍缩判据（≥5%）不成立。
    // 这条用例专门锁住方向：self-loop 红 **不能**推出 collapsed 红。
    const g = loopRateGraph({ selfLoops: 2, totalEdges: 50, agents: 6 });
    const m = measureGraph(g);
    t.ok(Math.abs(m.selfLoopRate - 0.04) < 1e-12, `自环率应 4%，实际 ${m.selfLoopRate}`);
    const item = checkGraph({ session: "fx-low-rate", graph: g }); // 默认阈值
    t.eq(item.ok, false, "整体必须红（有自环）");
    t.eq(item.violations.map((v) => v.code), ["self-loop"], "只该 self-loop 红；collapsed-graph 必须绿");

    // 反向蕴含（默认阈值下成立）：collapsed-graph 红 ⇒ 同一张图上 self-loop 必然也红。
    const five = loopRateGraph({ selfLoops: 2, totalEdges: 40, agents: 5 }); // 2/40 = 5%
    const fiveItem = checkGraph({ session: "fx-five", graph: five });
    t.eq(fiveItem.violations.map((v) => v.code), ["self-loop", "collapsed-graph"], "5% 时两条判据同时红");
  },

  "坏图：N=0 且 E>0 的退化图必须判红（ratio=0 不能放过）"(t) {
    const g = degenerateGraph({ edges: 2 });
    const m = measureGraph(g);
    t.eq([m.nodes, m.edges, m.selfLoops], [0, 2, 0], "0 节点 / 2 边 / 0 自环");
    t.eq(m.edgePerNode, 0, "分母为 0 时比率沿用既有口径记 0（不引入 Infinity）");
    const item = checkGraph({ session: "fx-degenerate", graph: g });
    t.eq(item.ok, false, "退化图必须红（旧口径下 ratio=0、自环率=0 ⇒ 全绿）");
    const v = item.violations.find((x) => x.code === "degenerate-graph");
    t.ok(Boolean(v), `必须报 degenerate-graph，实际 ${JSON.stringify(item.violations.map((x) => x.code))}`);
    t.eq(v.value, 2, "value 用边数（有限数，不是 Infinity）");
    t.ok(Number.isFinite(v.value), "value 必须是有限数，JSON.stringify 不会把它变成 null");
    t.includes(v.message, "0 个节点", "文案必须点名 0 节点");
    const round = JSON.parse(JSON.stringify(item));
    t.eq(round.violations.find((x) => x.code === "degenerate-graph")?.value, 2, "JSON 序列化后 value 不能变成 null");
    t.notIncludes(JSON.stringify(item), "Infinity", "详情里不得出现 Infinity");
  },

  "好图：空图（N=0,E=0）与有节点有边的图都不得误报退化"(t) {
    for (const [name, g] of [
      ["empty", emptyGraph()],
      ["single", singleNodeGraph()],
      ["chain", chainGraph(3)],
      ["branch", branchGraph(3)],
    ]) {
      const item = checkGraph({ session: name, graph: g });
      t.eq(item.ok, true, `${name} 必须绿，实际红：${JSON.stringify(item.violations)}`);
      t.eq(item.violations.some((v) => v.code === "degenerate-graph"), false, `${name} 不得报退化图`);
    }
  },

  "边界：自环率 4% < 5% 必须绿（同一放宽配置）"(t) {
    const g = loopRateGraph({ selfLoops: 2, totalEdges: 50, agents: 6 }); // 2/50 = 4%，50/7 ≈ 7.14
    const m = measureGraph(g);
    t.ok(Math.abs(m.selfLoopRate - 0.04) < 1e-12, `自环率应 4%，实际 ${m.selfLoopRate}`);
    const item = checkGraph({ session: "fx-4pct", graph: g, limits: { ...DEFAULT_LIMITS, maxSelfLoops: 2 } });
    t.eq(item.ok, true, `4% 必须绿，实际红：${JSON.stringify(item.violations)}`);
  },

  "边界：--max-self-loop-rate=0 不能把空图/无自环图判红"(t) {
    const limits = { ...DEFAULT_LIMITS, maxSelfLoopRate: 0 };
    for (const [name, g] of [["empty", emptyGraph()], ["single", singleNodeGraph()], ["chain", chainGraph(3)]]) {
      const item = checkGraph({ session: name, graph: g, limits });
      t.eq(item.ok, true, `${name} 在 0 阈值下必须仍绿（判据要求 L>0），实际红：${JSON.stringify(item.violations)}`);
    }
    const looped = checkGraph({ session: "looped", graph: loopRateGraph({ selfLoops: 1, totalEdges: 10, agents: 2 }), limits });
    t.eq(looped.ok, false, "有自环时 0 阈值必须红");
    t.ok(looped.violations.some((v) => v.code === "collapsed-graph"), "0 阈值下应有 collapsed-graph");
  },

  "多图：只有一张坏图时必须整体红，且只点名那一张（全局聚合会稀释）"(t) {
    const good1 = loopRateGraph({ selfLoops: 0, totalEdges: 10, agents: 9 }); // 10 边 / 10 节点 = 1.0
    const good2 = chainGraph(5); // 5 边 / 6 节点
    const bad = branchGraph(17); // 17 边 / 2 节点 = 8.5
    const m1 = measureGraph(good1);
    const m2 = measureGraph(good2);
    const m3 = measureGraph(bad);
    t.eq([m1.edges, m1.nodes], [10, 10], "good1 夹具");
    t.eq([m2.edges, m2.nodes], [5, 6], "good2 夹具");
    t.eq([m3.edges, m3.nodes], [17, 2], "bad 夹具");
    t.eq(m3.edgePerNode, 8.5, "坏图自身必须恰好 8.5");

    const result = checkGraphs([
      { session: "fx-good-1", graph: good1 },
      { session: "fx-good-2", graph: good2 },
      { session: "fx-bad", graph: bad },
    ]);
    t.eq(result.ok, false, "有一张坏图必须整体红");
    t.eq(result.failed.length, 1, "只该有 1 张失败");
    t.eq(result.failed[0].session, "fx-bad", "必须点名 fx-bad");

    // ★ 三张图的 node/edge id 都从 n1/e1 开始 —— 直接 spread 会撞 id，合并结果根本不是相加。
    //   这里逐张加唯一前缀，然后断言**真实汇总值**：32 边 / 18 节点。
    const merged = [prefixGraph(good1, "g1:"), prefixGraph(good2, "g2:"), prefixGraph(bad, "bad:")].reduce(
      (acc, part) => ({ nodes: { ...acc.nodes, ...part.nodes }, edges: { ...acc.edges, ...part.edges } }),
      { nodes: {}, edges: {} },
    );
    const glob = measureGraph(merged);
    t.eq(glob.edges, m1.edges + m2.edges + m3.edges, "合并后的边数必须等于逐图相加");
    t.eq(glob.nodes, m1.nodes + m2.nodes + m3.nodes, "合并后的节点数必须等于逐图相加");
    t.eq([glob.edges, glob.nodes], [32, 18], "唯一 id 合并后的真实汇总值");
    t.ok(Math.abs(glob.edgePerNode - 32 / 18) < 1e-12, `合并口径应为 32/18 ≈ 1.78，实际 ${glob.edgePerNode}`);
    t.ok(glob.edgePerNode < 8, `合并口径 1.78 < 8 —— 证明全局聚合会把 8.5 的坏图稀释掉`);
  },

  "parseArgs：默认值 / 显式阈值 / 非法值 / 未知参数 / 多余位置参数"(t) {
    const base = parseArgs([]);
    t.eq(base.limits, { ...DEFAULT_LIMITS }, "默认阈值");
    t.eq([base.json, base.strict, base.errors, base.root], [false, false, [], null], "默认开关");

    const explicit = parseArgs(["D:/x", "--strict", "--json", "--max-self-loops=2", "--max-edge-per-node=8.5", "--max-self-loop-rate=0.1"]);
    t.eq(explicit.errors, [], "合法参数不该报错");
    t.eq(explicit.root, "D:/x", "位置参数是 root");
    t.eq(explicit.strict, true, "strict");
    t.eq(explicit.json, true, "json");
    t.eq(explicit.limits, { maxSelfLoops: 2, maxEdgePerNode: 8.5, maxSelfLoopRate: 0.1 }, "显式阈值生效");

    const bad = [
      ["--max-self-loops=abc", "--max-self-loops"],
      ["--max-self-loops=-1", "--max-self-loops"],
      ["--max-self-loops=1.5", "--max-self-loops"],
      ["--max-self-loop-rate=2", "--max-self-loop-rate"],
      ["--nope=1", "--nope"],
      ["--strct", "--strct"],
    ];
    for (const [arg, needle] of bad) {
      const parsed = parseArgs([arg]);
      t.ok(parsed.errors.length > 0, `${arg} 必须报错`);
      t.includes(parsed.errors.join("\n"), needle, `${arg} 的错误要指出参数名`);
    }
    t.ok(parseArgs(["a", "b"]).errors.length > 0, "多余位置参数必须报错");
  },

  "CLI 兼容：默认模式对同样的坏图仍 exit 0（1.9.1 行为不变）"(t) {
    withRoot("compat", (root) => {
      writeGraph(root, "fx-selfloop", loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0 }));
      writeGraph(root, "fx-storm", loopRateGraph({ selfLoops: 0, totalEdges: 17, agents: 1 }));
      writeGraph(root, "fx-chain", chainGraph(3));
      const run = runCli(root);
      t.eq(run.code, 0, `默认模式必须保持 exit 0，实际 ${run.code}`);
      t.includes(run.stdout, "== 全部健康 ==", "默认输出仍是旧的总结句");
      t.notIncludes(run.stdout, "严格门禁", "默认模式不得打印严格段");
    });
  },

  "CLI 默认 --json：不得出现 strict 字段（旧消费方零影响）"(t) {
    withRoot("json-compat", (root) => {
      writeGraph(root, "fx-selfloop", loopRateGraph({ selfLoops: 2, totalEdges: 3, agents: 0 }));
      const run = runCli(root, ["--json"]);
      t.eq(run.code, 0, "默认 JSON 退出码 0");
      const payload = JSON.parse(run.stdout);
      t.ok(payload.summary && Array.isArray(payload.rows), "旧字段必须在");
      t.eq(Object.prototype.hasOwnProperty.call(payload, "strict"), false, "默认模式不得注入 strict 字段");
    });
  },

  "CLI --strict：自环图 exit 1，输出含图标识/边 id/数值"(t) {
    withRoot("strict-selfloop", (root) => {
      const g = loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0, sessionId: "sid-selfloop" });
      writeGraph(root, "fx-selfloop", g);
      const ids = measureGraph(g).selfLoopEdges;
      const run = runCli(root, ["--strict"]);
      assertRed(t, run, { session: "fx-selfloop", needles: ["self-loop:", "自环 3 条 > 上界 0", "collapsed-graph:", "自环率 100.0%"] });
      t.includes(run.stdout, "✗ 1 / 1 张图违反不变量", "必须给出失败计数");
      t.includes(run.stdout, "graph.sessionId=sid-selfloop", "图内 sessionId 与目录名不同时两者都要打印");
      for (const id of ids) t.includes(run.stdout, id, `必须打印自环边 id ${id}`);
    });
  },

  "CLI --strict：边节点比越界 exit 1，数值必须完整"(t) {
    withRoot("strict-ratio", (root) => {
      writeGraph(root, "fx-storm", branchGraph(17));
      const run = runCli(root, ["--strict"]);
      assertRed(t, run, { session: "fx-storm", needles: ["edge-per-node:", "边/节点 8.50 > 上界 8", "17 条边 / 2 个节点"] });
    });
  },

  "CLI --strict：坍缩图（放宽 self-loops 后）仍 exit 1"(t) {
    withRoot("strict-collapsed", (root) => {
      writeGraph(root, "fx-collapsed", loopRateGraph({ selfLoops: 2, totalEdges: 40, agents: 5 }));
      const run = runCli(root, ["--strict", "--max-self-loops=2"]);
      assertRed(t, run, { session: "fx-collapsed", needles: ["collapsed-graph:", "自环率 5.0% ≥ 上界 5.0%"] });
      t.notIncludes(run.stdout, "self-loop:", "自环数在放宽后不该报");
    });
  },

  "CLI --strict：多图只有一张坏图 ⇒ exit 1 且只点名它"(t) {
    withRoot("strict-mixed", (root) => {
      writeGraph(root, "fx-good-chain", chainGraph(4));
      writeGraph(root, "fx-good-branch", branchGraph(3));
      writeGraph(root, "fx-bad-storm", branchGraph(17));
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 1, "必须 exit 1");
      t.includes(run.stdout, "✗ 1 / 3 张图违反不变量", "失败计数 1/3");
      t.includes(run.stdout, "✗ fx-bad-storm", "必须点名坏图");
      t.notIncludes(run.stdout, "✗ fx-good-chain", "好图不得被点名");
      t.notIncludes(run.stdout, "✗ fx-good-branch", "好图不得被点名");
    });
  },

  "CLI --strict：空图 / 单节点 / 正常链 / 正常分支 全绿 exit 0"(t) {
    withRoot("strict-good", (root) => {
      writeGraph(root, "fx-empty", emptyGraph());
      writeGraph(root, "fx-single", singleNodeGraph());
      writeGraph(root, "fx-chain", chainGraph(3));
      writeGraph(root, "fx-branch", branchGraph(3));
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 0, `好图必须 exit 0，实际 ${run.code}\n${run.stdout}\n${run.stderr}`);
      t.includes(run.stdout, "✓ 4 张图全部满足不变量");
    });
  },

  "CLI --strict：阈值真的生效（--max-edge-per-node=20 ⇒ 8.5 转绿；=4 ⇒ 1.5 转红）"(t) {
    withRoot("strict-threshold", (root) => {
      writeGraph(root, "fx-storm", branchGraph(17)); // 8.5
      writeGraph(root, "fx-branch", branchGraph(3)); // 1.5
      const loose = runCli(root, ["--strict", "--max-edge-per-node=20"]);
      t.eq(loose.code, 0, `20 阈值下应全绿，实际 ${loose.code}\n${loose.stdout}`);
      const tight = runCli(root, ["--strict", "--max-edge-per-node=4"]);
      t.eq(tight.code, 1, "4 阈值下应红");
      t.includes(tight.stdout, "✗ fx-storm", "8.5 超 4");
      t.notIncludes(tight.stdout, "✗ fx-branch", "1.5 不超 4");
    });
  },

  "CLI --strict：空目录（0 张图）不得假绿"(t) {
    withRoot("strict-empty-dir", (root) => {
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 1, "0 张图必须是 1（门禁空转 ≠ 通过）");
      t.includes(run.stdout, "没有可检查的图（0 张）");
    });
  },

  "CLI --strict --json：strict 字段与退出码一致"(t) {
    withRoot("strict-json", (root) => {
      writeGraph(root, "fx-good", chainGraph(3));
      writeGraph(root, "fx-bad", branchGraph(17));
      const run = runCli(root, ["--strict", "--json"]);
      t.eq(run.code, 1, "有条坏图必须 exit 1");
      const payload = JSON.parse(run.stdout);
      t.eq(payload.strict.enabled, true, "enabled");
      t.eq(payload.strict.ok, false, "ok=false");
      t.eq(payload.strict.checked, 2, "检查 2 张");
      t.eq(payload.strict.failed, 1, "1 张失败");
      const bad = payload.strict.graphs.find((x) => x.session === "fx-bad");
      t.eq(bad.ok, false, "坏图 ok=false");
      t.eq(bad.violations.map((v) => v.code), ["edge-per-node"], "判据代号");
      t.eq(payload.strict.limits, { ...DEFAULT_LIMITS }, "阈值必须写进 JSON");
      const good = payload.strict.graphs.find((x) => x.session === "fx-good");
      t.eq(good.violations, [], "好图无违反");
      t.ok(good.metrics && good.metrics.edges === 3, "好图度量在 JSON 里");
    });
  },

  "CLI --strict：逐图状态、末尾结论与退出码一致（旧版先打 ✓ 再声称全部健康）"(t) {
    withRoot("strict-consistent", (root) => {
      writeGraph(root, "fx-selfloop", loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0, sessionId: "sid-selfloop" }));
      writeGraph(root, "fx-good", chainGraph(3));
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 1, "有不变量违反必须 exit 1");
      const badRow = rowLineOf(run, "fx-selfloop");
      const goodRow = rowLineOf(run, "fx-good");
      t.ok(/^  ✗ /.test(badRow), `坏图的逐图状态行必须是 ✗，实际：${badRow}`);
      t.ok(/^  ✓ /.test(goodRow), `好图的逐图状态行必须是 ✓，实际：${goodRow}`);
      t.notIncludes(run.stdout, "== 全部健康 ==", "严格模式不得回落到只看 problems 的旧健康结论");
      t.includes(run.stdout, "✗ 1 / 2 张图违反不变量", "最终严格结论必须与退出码一致（1 红 / 2 张）");
      t.notIncludes(run.stdout, "张图全部满足不变量", "最终结论不得同时声称全部满足");
    });
  },

  "CLI --strict --json：summary.unhealthySessions 与 strict.failed 同口径（不能一个 0 一个 1）"(t) {
    withRoot("strict-json-consistent", (root) => {
      writeGraph(root, "fx-good", chainGraph(3));
      writeGraph(root, "fx-bad", branchGraph(17));
      const run = runCli(root, ["--strict", "--json"]);
      t.eq(run.code, 1, "exit 1");
      const payload = JSON.parse(run.stdout);
      t.eq(payload.strict.failed, 1, "1 张不变量失败");
      t.eq(payload.strict.problemSessions, 0, "0 个 problems 会话");
      t.eq(payload.summary.unhealthySessions, 1, "unhealthySessions 必须把不变量失败算进去，不能与 strict.failed 矛盾");
      t.eq(payload.strict.ok, false, "strict.ok 是最终裁决，必须为 false");
      t.eq(payload.summary.unhealthySessions, payload.strict.failed + payload.strict.problemSessions, "两字段相加 = 健康失败会话数");
    });
  },

  "CLI --strict：problems 失败（坏 JSON）必须同时影响逐图状态、结论与 JSON 裁决"(t) {
    withRoot("strict-problems", (root) => {
      writeGraph(root, "fx-good", chainGraph(3));
      nodeFs.mkdirSync(nodePath.join(root, "fx-broken"), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(root, "fx-broken", "graph.json"), "{ not json", "utf8");
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 1, "有 health problem 必须 exit 1");
      const brokenRow = rowLineOf(run, "fx-broken");
      t.ok(/^  ✗ /.test(brokenRow), `解析失败的图逐图状态必须是 ✗，实际：${brokenRow}`);
      t.includes(run.stdout, "✓ 1 张图全部满足不变量；但 1 个会话健康检查失败", "不变量绿也必须交代健康失败");
      const jsonRun = runCli(root, ["--strict", "--json"]);
      t.eq(jsonRun.code, 1, "JSON 模式同退出码");
      const payload = JSON.parse(jsonRun.stdout);
      t.eq(payload.strict.ok, false, "strict.ok 必须与退出码 1 一致");
      t.eq(payload.strict.problemSessions, 1, "problemSessions 计数");
      t.eq(payload.summary.unhealthySessions, 1, "unhealthySessions 计数");
      t.eq(payload.strict.checked, 1, "只有 1 张图参与了不变量判定");
    });
  },

  "CLI --strict --json：同一张图既 problems 又不变量失败时只计一次"(t) {
    withRoot("strict-overlap", (root) => {
      const g = loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0, sessionId: "sid-overlap" });
      g.rootUserNodeIds = "n1"; // 让 renderFacts / renderLedger 抛错（problems），同时图又有自环
      writeGraph(root, "fx-overlap", g);
      const run = runCli(root, ["--strict", "--json"]);
      t.eq(run.code, 1, "exit 1");
      const payload = JSON.parse(run.stdout);
      t.eq(payload.strict.failed, 1, "不变量失败 1 张");
      t.eq(payload.strict.problemSessions, 1, "problems 失败 1 张（同一张图）");
      t.eq(payload.summary.unhealthySessions, 1, "同一会话只能计一次（并集去重，不是相加）");
      t.eq(payload.strict.ok, false, "strict.ok 必须与退出码一致");
      const text = runCli(root, ["--strict"]);
      t.notIncludes(text.stdout, "另有 1 个会话健康检查失败", "被不变量点名的图不该在『另有』里重复出现");
    });
  },

  "CLI --strict：N=0,E>0 退化图 exit 1，输出可 JSON 序列化的详情"(t) {
    withRoot("strict-degenerate", (root) => {
      writeGraph(root, "fx-degenerate", degenerateGraph({ edges: 2 }));
      const text = runCli(root, ["--strict"]);
      t.eq(text.code, 1, "退化图必须 exit 1（旧口径 ratio=0 ⇒ 假绿）");
      t.includes(text.stdout, "✗ fx-degenerate", "必须点名");
      t.includes(text.stdout, "degenerate-graph:", "必须给出判据代号");
      t.includes(text.stdout, "有 2 条边但 0 个节点", "必须给出边/节点数");
      const run = runCli(root, ["--strict", "--json"]);
      t.eq(run.code, 1, "JSON 模式同退出码");
      t.notIncludes(run.stdout, "Infinity", "JSON 里不得出现 Infinity（stringify 会变 null）");
      const payload = JSON.parse(run.stdout);
      const graph = payload.strict.graphs.find((x) => x.session === "fx-degenerate");
      const v = graph.violations.find((x) => x.code === "degenerate-graph");
      t.ok(Boolean(v), "JSON 必须含 degenerate-graph");
      t.eq(v.value, 2, "value 是有限边数");
      t.ok(Number.isFinite(v.value), "value 必须可 JSON 序列化为数字");
      t.eq(graph.metrics.edgePerNode, 0, "metric 仍是 0（不引入 Infinity）");
      t.eq(payload.summary.unhealthySessions, 1, "退化图在严格模式下必须计入 unhealthySessions");
    });
  },

  "CLI 默认文本模式：不打印 row.warnings（它们只在 --json 的 rows 里）"(t) {
    withRoot("warn-text", (root) => {
      writeGraph(root, "fx-storm", branchGraph(17)); // edgePerNode 8.5 ⇒ 「疑似重试风暴」
      writeGraph(root, "fx-selfloop", loopRateGraph({ selfLoops: 3, totalEdges: 3, agents: 0 })); // ⇒ 「图已坍缩」
      const text = runCli(root);
      t.eq(text.code, 0, "默认模式仍 exit 0");
      t.notIncludes(text.stdout, "疑似重试风暴", "旧文本模式不打印 warnings");
      t.notIncludes(text.stdout, "图已坍缩", "旧文本模式不打印 warnings");
      const payload = JSON.parse(runCli(root, ["--json"]).stdout);
      const storm = payload.rows.find((r) => r.session === "fx-storm");
      const loop = payload.rows.find((r) => r.session === "fx-selfloop");
      t.ok(storm.warnings.some((w) => w.includes("疑似重试风暴")), "警告必须保留在 JSON rows 里");
      t.ok(loop.warnings.some((w) => w.includes("图已坍缩")), "警告必须保留在 JSON rows 里");
    });
  },

  "CLI：参数错误 exit 2，--help exit 0"(t) {
    withRoot("cli-args", (root) => {
      const unknown = runCli(root, ["--strct"]);
      t.eq(unknown.code, 2, "未知参数必须 exit 2（不能静默忽略）");
      t.includes(unknown.stderr, "未知参数 --strct", "要指出拼错的参数");
      const badValue = runCli(root, ["--max-edge-per-node=abc"]);
      t.eq(badValue.code, 2, "非法数值必须 exit 2");
      const extra = runCli(root, ["--strict", "extra"]);
      t.eq(extra.code, 2, "多余位置参数必须 exit 2");
      const help = runCli(root, ["--help"]);
      t.eq(help.code, 0, "--help 必须是 0");
      t.includes(help.stdout, "--max-self-loop-rate", "用法里要有阈值参数");
    });
  },
};
