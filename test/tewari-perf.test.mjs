/**
 * tewari-perf.test.mjs —— P1 性能切片：手割分析缓存 + 换位索引的**语义不变**契约
 *
 * 这一组锁四件事：
 *   1. 同一张图重复调用 tewariAnalysis 只计算一次（缓存命中）；
 *   2. 图一改（settleEdge / 直接改边）缓存必须失效 —— 绝不能返回旧结论；
 *   3. renderLedger 一次渲染只对尾部 30 条失败边各算一次（旧版按档位重复，实测 6 档 ×30 条）；
 *   4. 关闭记忆化必须退化（变异自检）—— 证明省下来的真的是重复计算，不是假优化。
 *
 * 输出稳定性（逐字）由 ws-perf-p1/compare.mjs 在 133 张真实图上验证；
 * 这里用夹具锁语义边界，跑得快、能回归。
 */

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges, tewariAnalysis, _tewariStats, _tewariOptions } from "./graph-fixtures.mjs";
import { renderLedger } from "../src/ledger.mjs";

export const tests = {};

function resetStats() {
  _tewariStats.calls = 0;
  _tewariStats.computes = 0;
  _tewariStats.hits = 0;
}

/** u -eS1-> n1 成功；u -eS2-> n2 成功；u -eF-> n2 失败（同终点 ⇒ redundant）。 */
function tewariGraph() {
  const g = createGraph({ sessionId: "tewari-perf" });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。" });
  const n1 = addAgentNode(g, { seq: 10, goal: "A", worldHash: "W1", constraintHash: "C1" }).id;
  const n2 = addAgentNode(g, { seq: 11, goal: "B", worldHash: "W2", constraintHash: "C1" }).id;
  const s1 = addEdge(g, { from: u, intent: "走到 A", action: "bash(echo A)" });
  settleEdge(g, s1, { to: n1, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const s2 = addEdge(g, { from: u, intent: "走到 B", action: "bash(echo B)" });
  settleEdge(g, s2, { to: n2, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const f = addEdge(g, { from: u, intent: "直接去 B", action: "bash(echo B!)" });
  settleEdge(g, f, { to: n2, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
  return { g, u, n1, n2, f, s1, s2 };
}

/** 40 条失败边 + 若干成功边，用来逼出多个渲染档位。 */
function manyFailuresGraph(n = 40) {
  const g = createGraph({ sessionId: "tewari-many" });
  const u = addUserNodeId(g, { seq: 1, text: "别动 prod 配置。" });
  let last = u;
  for (let i = 0; i < n; i += 1) {
    const ok = addEdge(g, { from: u, intent: `成功路 ${i}`, action: `bash(echo ok${i})` });
    const node = addAgentNode(g, { seq: 100 + i, goal: `ok${i}`, worldHash: `W${i}`, constraintHash: "C1" }).id;
    settleEdge(g, ok, { to: node, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    const bad = addEdge(g, { from: last, intent: `失败路 ${i}`, action: `bash(echo bad${i})` });
    // ★ P6-A：无终点的失败边会被当 rewash 残留过滤掉 ⇒ 夹具必须给真实终点，否则 tewari 一次都不会算
    settleEdge(g, bad, { to: node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case ${i}` });
  }
  return g;
}

tests["tewari：同一张图重复调用只计算一次（缓存命中）"] = (t) => {
  const { g, f } = tewariGraph();
  resetStats();
  const a = tewariAnalysis(g, g.edges[f]);
  const b = tewariAnalysis(g, g.edges[f]);
  t.eq(_tewariStats.calls, 2, "两次调用");
  t.eq(_tewariStats.computes, 1, "只算一次");
  t.eq(_tewariStats.hits, 1, "第二次命中");
  t.eq(JSON.stringify(a), JSON.stringify(b), "两次结果逐字段相同");
  t.ok(a.redundantVs.length > 0, "应识别出同终点成功边");
};

tests["tewari：settleEdge 改终点后缓存必须失效"] = (t) => {
  const { g, f, n1 } = tewariGraph();
  resetStats();
  const before = tewariAnalysis(g, g.edges[f]);
  t.ok(before.redundantVs.length > 0, "改前：与 n2 同终点");
  settleEdge(g, f, { to: n1, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
  const after = tewariAnalysis(g, g.edges[f]);
  t.eq(_tewariStats.computes, 2, "图变了必须重算");
  t.ok(after.redundantVs.includes("e1"), "改后：与 e1（终点 n1）同终点");
  t.ok(!after.redundantVs.includes("e2"), "改后：不再与 e2 同终点");
};

tests["tewari：绕过 bump 的直接改边也不能拿到旧结论（结构签名兜底）"] = (t) => {
  const { g, f, n1 } = tewariGraph();
  resetStats();
  tewariAnalysis(g, g.edges[f]);
  // 直接改边（不经过 settleEdge / bumpRev）——生产里 keeper 有过这种写法，必须靠签名兜住
  g.edges[f].to = n1;
  const after = tewariAnalysis(g, g.edges[f]);
  t.eq(_tewariStats.computes, 2, "端点变了必须重算");
  t.ok(after.redundantVs.includes("e1"), "按新终点给出结论");
};

tests["renderLedger：一次渲染只算尾部 30 条，不再按档位重复"] = (t) => {
  const g = manyFailuresGraph(40);
  resetStats();
  const r = renderLedger(g, { maxTokens: 500, markers: "semantic", treeDir: "x" });
  t.ok(r.text.length > 0, "渲染非空");
  t.eq(_tewariStats.calls, 30, "只对最近 30 条失败边调用一次");
  t.eq(_tewariStats.computes, 30, "每条只算一次");
  t.eq(_tewariStats.hits, 0, "没有重复调用（去重发生在档位循环之前）");
};

tests["renderLedger：连续两次渲染输出逐字相同"] = (t) => {
  const g = manyFailuresGraph(12);
  const a = renderLedger(g, { maxTokens: 500, markers: "semantic", treeDir: "x" });
  const b = renderLedger(g, { maxTokens: 500, markers: "semantic", treeDir: "x" });
  t.eq(a.text, b.text, "文本逐字相同");
  t.eq(a.tokens, b.tokens, "tokens 相同");
  t.eq(a.level, b.level, "档位相同");
};

tests["变异自检：关闭记忆化必须退化（每次重算）"] = (t) => {
  const g = manyFailuresGraph(40);
  const prev = _tewariOptions.memo;
  _tewariOptions.memo = false;
  try {
    resetStats();
    renderLedger(g, { maxTokens: 500, markers: "semantic", treeDir: "x" });
    const calls = _tewariStats.calls;
    const computes = _tewariStats.computes;
    t.eq(calls, 30, "调用仍是 30 次（档位去重不依赖 graph 缓存）");
    t.eq(computes, calls, "每次都必须重算（真实退化）");
    t.eq(_tewariStats.hits, 0, "没有命中");
  } finally {
    _tewariOptions.memo = prev;
  }
};

tests["置换：索引化后提示仍按 path 上的换位边计数"] = (t) => {
  const g = createGraph({ sessionId: "tewari-transposition" });
  const u = addUserNodeId(g, { seq: 1, text: "把缓存换成 LRU。" });
  // 节点必须带 via（currentPath 沿 via 链回溯，不是沿边）
  const e1 = addEdge(g, { from: u, intent: "第一步", action: "bash(echo 1)" });
  const n1 = addAgentNode(g, { seq: 10, goal: "A", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  settleEdge(g, e1, { to: n1, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  g.edges[e1].transposition = true;
  const r = renderLedger(g, { maxTokens: 500, markers: "semantic", treeDir: "x" });
  t.includes(r.text, "置换：当前路径有 1 处回到已走过的状态", "置换提示保留");
};
