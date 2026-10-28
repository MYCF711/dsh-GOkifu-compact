import {
  createGraph,
  addUserNode,
  addAgentNode,
  addEdge,
  settleEdge,
  failureEdges,
  currentPath,
  validate,
  mergeNodeInto,
  extractConstraints,
  renderMd,
  fromJSON,
  toJSON,
  hashSet,
} from "../src/graph.mjs";

export const tests = {
  "用户节点的原话逐字保存（不被 norm 改写）"() {
    const g = createGraph({ sessionId: "s1" });
    const text = "必须 用   两个空格\n\n\n不许改配色";
    const id = addUserNode(g, { seq: 1, text });
    if (g.nodes[id].text !== text) throw new Error(`原话被改写：${JSON.stringify(g.nodes[id].text)}`);
  },

  "约束抽取：必须/不许 留下，普通陈述不留"() {
    const text = "帮我把页面改一下。必须保留登录框。这个颜色不好看。不许动接口。";
    const got = extractConstraints(text);
    if (!got.some((s) => s.includes("必须保留登录框"))) throw new Error(`漏了 must：${JSON.stringify(got)}`);
    if (!got.some((s) => s.includes("不许动接口"))) throw new Error(`漏了 must-not：${JSON.stringify(got)}`);
    if (got.some((s) => s.includes("颜色不好看"))) throw new Error(`把普通陈述当约束：${JSON.stringify(got)}`);
    // 逐字：差一个「必须/最好」都不同
    if (!got[0].includes("必须")) throw new Error("约束句被改写了");
  },

  "状态哈希相同 ⇒ 置换：不新建节点，返回命中"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "目标：修好测试" });
    const e1 = addEdge(g, { from: u, intent: "先试 A", action: "bash(test)" });
    const n1 = addAgentNode(g, { seq: 5, goal: "A 完成", worldHash: "W1", constraintHash: "C1", via: e1 });
    settleEdge(g, e1, { to: n1.id, result: "failure", errorSnippet: "AssertionError: x" });

    const e2 = addEdge(g, { from: u, intent: "先试 B", action: "bash(test2)" });
    const n2 = addAgentNode(g, { seq: 9, goal: "B 完成", worldHash: "W1", constraintHash: "C1", via: e2 });
    if (n2.id !== n1.id) throw new Error(`同状态却新建了节点：${n1.id} vs ${n2.id}`);
    if (!n2.transposition) throw new Error("没有标记置换");
    if (n2.transposition.nodeId !== n1.id) throw new Error("置换命中节点不对");
    if (g.order.filter((id) => g.nodes[id].kind === "agent").length !== 1) throw new Error("节点数不对");
  },

  "不同状态 ⇒ 两个节点"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "x" });
    const e1 = addEdge(g, { from: u, action: "a" });
    const n1 = addAgentNode(g, { seq: 3, goal: "", worldHash: "W1", constraintHash: "C1", via: e1 });
    const e2 = addEdge(g, { from: u, action: "b" });
    const n2 = addAgentNode(g, { seq: 6, goal: "", worldHash: "W2", constraintHash: "C1", via: e2 });
    if (n1.id === n2.id) throw new Error("不同状态被合并了");
  },

  "pending 状态不入置换表（回填前不误判）"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "x" });
    const e1 = addEdge(g, { from: u, action: "a" });
    const n1 = addAgentNode(g, { seq: 3, goal: "", worldHash: "pending", constraintHash: "pending", via: e1 });
    const e2 = addEdge(g, { from: u, action: "b" });
    const n2 = addAgentNode(g, { seq: 6, goal: "", worldHash: "pending", constraintHash: "pending", via: e2 });
    if (n1.id === n2.id) throw new Error("两个 pending 节点被当成同一状态");
    if (Object.keys(g.stateIndex).length !== 0) throw new Error(`pending 不该进 stateIndex: ${JSON.stringify(g.stateIndex)}`);
  },

  "置换合并：from 节点的入边改指向 into，节点移除"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "x" });
    const e1 = addEdge(g, { from: u, action: "a" });
    const n1 = addAgentNode(g, { seq: 3, goal: "", worldHash: "pending", constraintHash: "pending", via: e1 });
    const e2 = addEdge(g, { from: n1.id, action: "b" });
    const n2 = addAgentNode(g, { seq: 6, goal: "", worldHash: "pending", constraintHash: "pending", via: e2 });
    const redirected = mergeNodeInto(g, n2.id, n1.id);
    if (!redirected.includes(e2)) throw new Error(`入边没被重定向：${JSON.stringify(redirected)}`);
    if (g.nodes[n2.id]) throw new Error("源节点未移除");
    if (g.edges[e2].to !== n1.id) throw new Error("边目标没改");
    if (g.edges[e2].transposition !== true) throw new Error("边没标置换");
    if (g.nodes[n1.id].transpositions !== 1) throw new Error("置换计数没加上");
  },

  "currentPath 沿 via 从根走到当前"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "root" });
    const e1 = addEdge(g, { from: u, action: "a" });
    const n1 = addAgentNode(g, { seq: 3, goal: "g1", worldHash: "W1", constraintHash: "C1", via: e1 });
    settleEdge(g, e1, { to: n1.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    const e2 = addEdge(g, { from: n1.id, action: "b" });
    const n2 = addAgentNode(g, { seq: 6, goal: "g2", worldHash: "W2", constraintHash: "C1", via: e2 });
    settleEdge(g, e2, { to: n2.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    const path = currentPath(g, n2.id).map((n) => n.id);
    if (JSON.stringify(path) !== JSON.stringify([u, n1.id, n2.id])) throw new Error(`路径不对：${JSON.stringify(path)}`);
  },

  "failureEdges 只返回失败，按 id 数字序"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "x" });
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const e = addEdge(g, { from: u, intent: `i${i}`, action: `a${i}` });
      settleEdge(g, e, { result: i % 3 === 0 ? "failure" : "success", errorSnippet: i % 3 === 0 ? "boom" : "" });
      ids.push(e);
    }
    const f = failureEdges(g).map((e) => e.id);
    if (f.length !== 4) throw new Error(`失败边数不对：${f.length}`);
    const nums = f.map((id) => Number(id.slice(1)));
    if (JSON.stringify(nums) !== JSON.stringify([...nums].sort((a, b) => a - b))) throw new Error("顺序不是 id 数字序");
  },

  "validate 抓到「失败边没有原因」与「user 原话为空」"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNode(g, { seq: 1, text: "" });
    const e = addEdge(g, { from: u, action: "x" });
    settleEdge(g, e, { result: "failure", verify: { kind: "none", summary: "" }, errorSnippet: "" });
    const problems = validate(g);
    if (!problems.some((p) => p.includes("失败边既无"))) throw new Error(`没抓到无原因失败边：${JSON.stringify(problems)}`);
    if (!problems.some((p) => p.includes("原话为空"))) throw new Error(`没抓到空 user：${JSON.stringify(problems)}`);
  },

  "序列化往返后图等价"() {
    const g = createGraph({ sessionId: "s1", cwd: "/tmp" });
    const u = addUserNode(g, { seq: 1, text: "必须保持" });
    const e = addEdge(g, { from: u, action: "bash(ls)" });
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    const back = fromJSON(toJSON(g));
    if (JSON.stringify(back) !== JSON.stringify(g)) throw new Error("往返不等价");
  },

  "renderMd 出人读棋谱（含节点、边、结果、置换标记）"() {
    const g = createGraph({ sessionId: "s-demo" });
    const u = addUserNode(g, { seq: 1, text: "把压缩改成增量" });
    const e = addEdge(g, { from: u, intent: "先改范围选择", action: "edit(range.mjs)" });
    const n = addAgentNode(g, { seq: 4, goal: "改完范围", worldHash: "abc123", constraintHash: "def456", via: e });
    settleEdge(g, e, { to: n.id, result: "failure", errorSnippet: "TypeError: x is undefined" });
    const md = renderMd(g);
    for (const needle of ["# 棋谱 s-demo", "USER", "STATE", "先改范围选择", "failure", "TypeError"]) {
      if (!md.includes(needle)) throw new Error(`md 缺 ${needle}`);
    }
  },

  "hashSet 与顺序无关，且空集合也稳定"() {
    if (hashSet(["b", "a"]) !== hashSet(["a", "b"])) throw new Error("顺序敏感");
    if (hashSet([]) !== hashSet([])) throw new Error("空集合不稳定");
  },
};

// ── P0（审查发现）：合并非叶子节点时出边也要改指向 ──
tests["mergeNodeInto 合并非叶子节点：入边与出边都改指向，不留悬空"] = async () => {
  const { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, mergeNodeInto, validate } = await import("../src/graph.mjs");
  const g = createGraph({ sessionId: "merge-mid" });
  const u = addUserNode(g, { seq: 1, text: "必须保持接口不变。" });
  const e1 = addEdge(g, { from: u, intent: "第一步", action: "bash(a)" });
  const mid = addAgentNode(g, { seq: 2, turn: 1, goal: "中间节点", worldHash: "W1", constraintHash: "C1", via: e1.id });
  settleEdge(g, e1, { to: mid.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e2 = addEdge(g, { from: mid.id, intent: "第二步", action: "bash(b)" });
  const leaf = addAgentNode(g, { seq: 3, turn: 1, goal: "叶子", worldHash: "W2", constraintHash: "C1", via: e2.id });
  settleEdge(g, e2, { to: leaf.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });

  // 合并中间节点（它有出边 e2）
  mergeNodeInto(g, mid.id, leaf.id);

  for (const [id, e] of Object.entries(g.edges)) {
    if (e.from && !g.nodes[e.from]) throw new Error(`边 ${id} 的 from 悬空：${e.from}`);
    if (e.to && !g.nodes[e.to]) throw new Error(`边 ${id} 的 to 悬空：${e.to}`);
  }
  if (g.order.some((id) => !g.nodes[id])) throw new Error("order 引用了已删除节点");
  if (g.nodes[mid.id]) throw new Error("被合并的节点还在");
};

// ── 手割分析（tewari）：判断一条失败边是不是纯亏 ──
tests["tewari：同起点有成功路径且不经过失败终点 → pure_loss"] = async () => {
  const { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, tewariAnalysis } = await import("../src/graph.mjs");
  const g = createGraph({ sessionId: "tewari" });
  const u = addUserNode(g, { seq: 1, text: "把数据算出来" });
  const eBad = addEdge(g, { from: u, intent: "直接改 prod 配置", action: "edit(prod.yml)" });
  settleEdge(g, eBad, { result: "failure", verify: { kind: "host-error", summary: "EACCES" }, errorSnippet: "EACCES: permission denied" });
  const eGood = addEdge(g, { from: u, intent: "改测试环境配置", action: "edit(staging.yml)" });
  const nGood = addAgentNode(g, { seq: 2, turn: 1, goal: "改 staging", worldHash: "W1", constraintHash: "C1", via: eGood.id });
  settleEdge(g, eGood, { to: nGood.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });

  const r = tewariAnalysis(g, g.edges[eBad]);
  if (!r) throw new Error("应返回分析结果");
  if (r.kind !== "pure_loss") throw new Error(`应判 pure_loss，实际 ${r.kind}`);
  if (r.alternatives !== 1) throw new Error(`替代路径数应为 1，实际 ${r.alternatives}`);
};

tests["tewari：同起点没有成功路径 → no_alternative"] = async () => {
  const { createGraph, addUserNode, addEdge, settleEdge, tewariAnalysis } = await import("../src/graph.mjs");
  const g = createGraph({ sessionId: "tewari2" });
  const u = addUserNode(g, { seq: 1, text: "唯一尝试" });
  const e = addEdge(g, { from: u, intent: "唯一的路", action: "try()" });
  settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
  const r = tewariAnalysis(g, g.edges[e]);
  if (r.kind !== "no_alternative") throw new Error(`应判 no_alternative，实际 ${r.kind}`);
};

tests["tewari：成功路径能到达失败终点 → detour"] = async () => {
  const { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, tewariAnalysis } = await import("../src/graph.mjs");
  const g = createGraph({ sessionId: "tewari3" });
  const u = addUserNode(g, { seq: 1, text: "目标 C" });
  // 失败路：u -> X -> C
  const eBad = addEdge(g, { from: u, intent: "绕路尝试", action: "x()" });
  const nX = addAgentNode(g, { seq: 2, turn: 1, goal: "X", worldHash: "WX", constraintHash: "C1", via: eBad.id });
  settleEdge(g, eBad, { to: nX.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
  // 成功路：u -> B -> X（能到达 X）
  const eGood = addEdge(g, { from: u, intent: "正确尝试", action: "b()" });
  const nB = addAgentNode(g, { seq: 3, turn: 1, goal: "B", worldHash: "WB", constraintHash: "C1", via: eGood.id });
  settleEdge(g, eGood, { to: nB.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const eBX = addEdge(g, { from: nB.id, intent: "B 到 X", action: "to_x()" });
  settleEdge(g, eBX, { to: nX.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });

  const r = tewariAnalysis(g, g.edges[eBad]);
  if (r.kind !== "detour") throw new Error(`应判 detour，实际 ${r.kind}`);
};

tests["tewari：失败之后走出成功 → profit（赚）"] = async () => {
  const { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, tewariAnalysis } = await import("../src/graph.mjs");
  const g = createGraph({ sessionId: "tewari4" });
  const u = addUserNode(g, { seq: 1, text: "目标" });
  const eBad = addEdge(g, { from: u, intent: "先试错的方案", action: "try_x()" });
  const nX = addAgentNode(g, { seq: 2, turn: 1, goal: "X", worldHash: "WX", constraintHash: "C1", via: eBad });
  settleEdge(g, eBad, { to: nX.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
  const eGood = addEdge(g, { from: nX.id, intent: "改用另一条路", action: "try_y()" });
  const nY = addAgentNode(g, { seq: 3, turn: 1, goal: "Y", worldHash: "WY", constraintHash: "C1", via: eGood });
  settleEdge(g, eGood, { to: nY.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const r = tewariAnalysis(g, g.edges[eBad]);
  if (r.kind !== "profit") throw new Error(`应判 profit，实际 ${r.kind}`);
};
