/**
 * render-index-perf.test.mjs —— P2 性能切片：renderIndexMd / renderNodeMd 索引化的**语义不变**契约
 *
 * 锁四件事：
 *   1. 新索引版输出与旧 O(N×E) 参考实现**逐字节相同**（renderIndexMd 与 renderNodeMd）；
 *   2. 同一张图连续渲染 N 个节点只建一次索引（`_graphIndexStats.builds === 1`）；
 *   3. 关掉 memo 必须退化（每个渲染器各建一次，builds === 调用次数）；
 *   4. 图变了（新增边）必须重建索引，输出要反映新边。
 */

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, renderIndexMd, renderNodeMd, _graphIndexStats, _graphIndexOptions } from "./graph-fixtures.mjs";

export const tests = {};

/* ── 旧实现（O(N×E)）逐字抄本，仅作为对本测试的参考实现 ─────────── */
function legacyRenderNodeMd(g, nodeId) {
  const n = g.nodes[nodeId];
  if (!n) return "";
  const cut = (x, k) => String(x ?? "").slice(0, k);
  const lines = [`# ${nodeId} · ${n.kind.toUpperCase()}  seq=${n.seq}`, ""];
  if (n.kind === "user") {
    lines.push("## 原话", "", ...String(n.text ?? "").split("\n").map((l) => `> ${l}`), "");
    if (n.constraints?.length) lines.push("## 约束", "", ...n.constraints.map((c) => `- ${c}`), "");
  } else {
    if (n.goal) lines.push("## 评语（LLM 当时的目标）", "", n.goal, "");
    else if (n.via && g.edges[n.via]) {
      const via = g.edges[n.via];
      const text = via.intent || via.action;
      if (text) lines.push(`## 评语（来自入边 ${n.via}，非 LLM 原话）`, "", text, "");
    }
    lines.push("## 状态", "", `- worldHash: \`${cut(n.worldHash, 12)}\``, `- constraintHash: \`${cut(n.constraintHash, 12)}\``, "");
  }
  const ins = Object.values(g.edges).filter((e) => e.to === nodeId);
  lines.push("## 入边", "");
  if (ins.length === 0) lines.push("（无）");
  else for (const e of ins) lines.push(`- ${e.id} ← ${e.from}: ${cut(e.intent || e.action, 80)}${e.result ? ` [${e.result}]` : ""}`);
  lines.push("");
  const outs = Object.values(g.edges).filter((e) => e.from === nodeId);
  lines.push("## 出边", "");
  if (outs.length === 0) lines.push("（无）");
  else for (const e of outs) lines.push(`- ${e.id} → ${e.to ?? "(未结算)"}: ${cut(e.intent || e.action, 80)}${e.result ? ` [${e.result}]` : ""}${e.result === "failure" ? ` [verify:${e.verify?.kind ?? "none"}]` : ""}${e.errorSnippet ? ` — ${cut(e.errorSnippet, 400)}` : ""}`);
  lines.push("");
  lines.push("## 原始记录", "", "（raw/ 已砍掉：节点数据在 graph.json，见 docs/CHANGELOG v1.2.4）", "");
  return lines.join("\n");
}

function legacyRenderIndexMd(g) {
  const cut = (x, k) => String(x ?? "").slice(0, k);
  const depth = new Map();
  const hasIn = new Set(Object.values(g.edges).filter((e) => e.to).map((e) => e.to));
  const roots = Object.keys(g.nodes).filter((id) => !hasIn.has(id));
  const queue = roots.map((id) => [id, 0]);
  while (queue.length > 0) {
    const [id, d] = queue.shift();
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const e of Object.values(g.edges)) {
      if (e.from === id && e.to && !depth.has(e.to)) queue.push([e.to, d + 1]);
    }
  }
  const lines = [
    `# 棋谱 ${g.sessionId}`,
    "",
    `> 节点 ${Object.keys(g.nodes).length} · 边 ${Object.keys(g.edges).length} · fold ${g.foldCount} 次 · updated ${new Date(g.updatedAt).toISOString()}`,
    "",
    "## 落子顺序（缩进 = 深度；每个节点只出现一次）",
    "",
  ];
  for (const id of g.order) {
    const n = g.nodes[id];
    if (!n) continue;
    const d = depth.get(id) ?? 0;
    const indent = "  ".repeat(Math.min(d, 12));
    const label = n.kind === "user" ? "USER" : "STATE";
    const title = n.kind === "user" ? cut(n.text, 40) : n.goal ? cut(n.goal, 40) : "(无目标)";
    lines.push(`${indent}- [${id}](./nodes/${id}.md) ${label} seq=${n.seq} ${title}`);
    const outs = Object.values(g.edges).filter((e) => e.from === id);
    for (const e of outs) {
      const mark = e.result === "success" ? "✓" : e.result === "failure" ? "✗" : "?";
      lines.push(`${indent}  - ${e.id} ${mark} ${cut(e.intent || e.action, 30)}${e.result === "failure" && e.verify?.kind === "text" ? " [text:?]" : ""}`);
    }
  }
  lines.push("", "## 失败边全表（含跨边 / 置换边）", "");
  let failCount = 0;
  for (const e of Object.values(g.edges)) {
    if (e.result !== "failure") continue;
    failCount += 1;
    const from = e.from ?? "?";
    const to = e.to ?? "(未结算)";
    lines.push(
      `- ${e.id} ${from} → ${to}: ${cut(e.intent || e.action, 60)} — ${cut(e.errorSnippet || e.verify?.summary || "(无原因)", 160)} [verify:${e.verify?.kind ?? "none"}]${e.verify?.kind === "text" ? " [text:?]" : ""}`,
    );
  }
  if (failCount === 0) lines.push("（无）");
  return lines.join("\n");
}

/** 分支 + 失败 + 置换边的混合图。 */
function mixedGraph() {
  const g = createGraph({ sessionId: "render-index-perf" });
  const u = addUserNodeId(g, { seq: 1, text: "把 sessions 日志改成流式。不要动 prod。" });
  const a = addAgentNode(g, { seq: 10, goal: "第一步", worldHash: "W1", constraintHash: "C1" }).id;
  const e1 = addEdge(g, { from: u, intent: "第一步", action: "bash(echo 1)" });
  settleEdge(g, e1, { to: a, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  for (let i = 0; i < 6; i += 1) {
    const f = addEdge(g, { from: a, intent: `失败 ${i}`, action: `bash(echo bad${i})` });
    settleEdge(g, f, { to: null, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `Error: case ${i}` });
  }
  const b = addAgentNode(g, { seq: 20, goal: "第二步", worldHash: "W2", constraintHash: "C1" }).id;
  const e2 = addEdge(g, { from: a, intent: "第二步", action: "bash(echo 2)" });
  settleEdge(g, e2, { to: b, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  g.edges[e2].transposition = true;
  return g;
}

tests["renderIndexMd：索引版与旧 O(N×E) 实现逐字节相同"] = (t) => {
  const g = mixedGraph();
  t.eq(renderIndexMd(g), legacyRenderIndexMd(g), "整篇 index.md 相同");
};

tests["renderNodeMd：每个节点都与旧实现逐字节相同"] = (t) => {
  const g = mixedGraph();
  let bad = 0;
  for (const id of Object.keys(g.nodes)) if (renderNodeMd(g, id) !== legacyRenderNodeMd(g, id)) bad += 1;
  t.eq(bad, 0, "所有节点 md 相同");
};

tests["索引复用：连续渲染 N 个节点只建一次索引"] = (t) => {
  const g = mixedGraph();
  _graphIndexStats.builds = 0;
  renderIndexMd(g); // 第一次：建索引
  for (const id of Object.keys(g.nodes)) renderNodeMd(g, id);
  renderIndexMd(g);
  t.eq(_graphIndexStats.builds, 1, `只建一次（实际 ${_graphIndexStats.builds}）`);
};

tests["变异自检：关闭 memo 必须退化（每次渲染各建一次）"] = (t) => {
  const g = mixedGraph();
  const prev = _graphIndexOptions.memo;
  _graphIndexOptions.memo = false;
  try {
    _graphIndexStats.builds = 0;
    const n = Object.keys(g.nodes).length;
    for (const id of Object.keys(g.nodes)) renderNodeMd(g, id);
    t.eq(_graphIndexStats.builds, n, `每个节点都要重建（${n} 次）`);
    t.eq(renderIndexMd(g), legacyRenderIndexMd(g), "关 memo 时输出仍与旧实现相同");
  } finally {
    _graphIndexOptions.memo = prev;
  }
};

tests["缓存失效：新增边后必须重建并反映到输出"] = (t) => {
  const g = mixedGraph();
  renderIndexMd(g);
  const beforeBuilds = _graphIndexStats.builds;
  const e = addEdge(g, { from: g.order[0], intent: "新增失败", action: "bash(false)" });
  settleEdge(g, e, { to: null, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: new" });
  const out = renderIndexMd(g);
  t.ok(_graphIndexStats.builds > beforeBuilds, "结构变了必须重建");
  t.includes(out, "新增失败", "输出包含新增边");
  t.eq(out, legacyRenderIndexMd(g), "重建后的输出仍与旧实现相同");
};

tests["规模：2000 边渲染不退化（索引版应远低于 200ms）"] = (t) => {
  const g = createGraph({ sessionId: "render-index-scale" });
  let last = addUserNodeId(g, { seq: 1, text: "root" });
  for (let i = 0; i < 2000; i += 1) {
    const eid = addEdge(g, { from: last, intent: `step ${i}`, action: `bash(npm test ${i})` });
    settleEdge(g, eid, { to: null, result: i % 4 === 0 ? "failure" : "success", verify: { kind: "exit", summary: "exit" }, errorSnippet: i % 4 === 0 ? `Error ${i}` : "" });
    const node = addAgentNode(g, { seq: 2 + i, goal: `g${i}`, worldHash: `W${i}`, constraintHash: "C" }).id;
    g.edges[eid].to = node;
    last = node;
  }
  const t0 = Date.now();
  const out = renderIndexMd(g);
  const ms = Date.now() - t0;
  t.ok(out.length > 0, "输出非空");
  t.ok(ms < 200, `2000 边渲染 ${ms}ms < 200ms`);
};
