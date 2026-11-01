/**
 * fold-properties.test.mjs —— 压缩**纯函数层**的不变量测试（2026-11-02，C60）
 *
 * `foldClosureOf`（可寻址闭包）、`foldBoundaryOf`（切点完整性）、`measureFoldQuality`（保真度）
 * 这三件事是「折叠是否可信」的机器判据，但此前只有少量手写夹具。这里用固定种子的随机图
 * 与随机区间，断言它们**永远**满足的代数性质：
 *
 *   · 闭包计数 = 暴力扫描结果；首尾 id 是最小/最大 id；`preGraph` 只在「区间早于本图」时为真；
 *   · 边界：`openAtEnd` = 恰好跨过终点的边数、`≤ overlapping`；`unsettled` = 未结算边数；
 *   · 保真度：摘要含全部约束/失败 id ⇒ 召回 1；缺一条 ⇒ 该条进 missing；
 *     编造的 `eN/nN` ⇒ 进 unknownIds；压缩比 = shadowed / summaryTokens。
 */

import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge, foldClosureOf, foldBoundaryOf } from "./graph-fixtures.mjs";
import { collectConstraints } from "../src/rooms/ledger.mjs";
import { measureFoldQuality, failuresInFoldRange } from "../src/rooms/fold-quality.mjs";

export const tests = {};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const word = (r, n) => Array.from({ length: n }, () => pick(r, ["改", "配置", "build", "cache", "test", "x"])).join("");
const num = (id) => Number(String(id).slice(1));

/** 随机图：seq 有空洞（模拟真实会话里的工具事件），边带证据区间。 */
function randomGraph(seed) {
  const r = rng(seed);
  const g = createGraph({ sessionId: `fold-fuzz-${seed}` });
  const constraints = Array.from({ length: Math.floor(r() * 4) }, () => `${word(r, 5)}：不允许 ${word(r, 4)}`);
  let cursor = addUserNodeId(g, { seq: 1, text: "跑构建", constraints });
  let seq = 2;
  const hops = 3 + Math.floor(r() * 12);
  for (let i = 0; i < hops; i += 1) {
    seq += Math.floor(r() * 4); // seq 空洞
    const e = addEdge(g, { from: cursor, intent: word(r, 6), action: `bash(${word(r, 5)})`, evidence: { start: seq, end: seq + Math.floor(r() * 3) } });
    seq += 2;
    const node = addAgentNode(g, { seq, goal: word(r, 5), worldHash: `W${seed}${i}`, constraintHash: "C1", via: e }).id;
    seq += 1 + Math.floor(r() * 3);
    const roll = r();
    if (roll < 0.6) settleEdge(g, e, { to: node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
    else if (roll < 0.85) settleEdge(g, e, { to: node, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    else settleEdge(g, e, { to: node, result: "unverified", verify: { kind: "none", summary: "" } });
    cursor = node;
  }
  return { g, maxSeq: seq };
}

tests["C60 闭包不变量：计数=暴力扫描、首尾=min/max id、preGraph 只在区间早于本图时为真"] = (t) => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
    const { g, maxSeq } = randomGraph(seed);
    const nodeSeqs = (g.order ?? []).map((id) => Number(g.nodes[id]?.seq));
    const minNodeSeq = Math.min(...nodeSeqs);
    for (const range of [{ start: 0, end: maxSeq }, { start: 5, end: 20 }, { start: 2, end: minNodeSeq - 1 }, { start: 1, end: 3 }]) {
      const closure = foldClosureOf(g, range);
      const where = `seed=${seed} range=${range.start}-${range.end}`;
      const wantNodes = (g.order ?? []).filter((id) => {
        const s = Number(g.nodes[id]?.seq);
        return Number.isFinite(s) && s >= range.start && s <= range.end;
      });
      const wantEdges = Object.values(g.edges).filter((e) => {
        const s = Number(e.evidence?.start);
        const en = Number(e.evidence?.end ?? s);
        return Number.isFinite(s) && Number.isFinite(en) && en >= range.start && s <= range.end;
      });
      t.eq(closure.nodes, wantNodes.length, `${where}：节点计数`);
      t.eq(closure.edges, wantEdges.length, `${where}：边计数`);
      const sortedNodes = [...wantNodes].sort((a, b) => num(a) - num(b));
      t.eq(closure.firstNode, sortedNodes[0] ?? null, `${where}：firstNode`);
      t.eq(closure.lastNode, sortedNodes.at(-1) ?? null, `${where}：lastNode`);
      const sortedEdges = [...wantEdges].map((e) => e.id).sort((a, b) => num(a) - num(b));
      t.eq(closure.firstEdge, sortedEdges[0] ?? null, `${where}：firstEdge`);
      t.eq(closure.lastEdge, sortedEdges.at(-1) ?? null, `${where}：lastEdge`);
      t.eq(closure.graphNodes, (g.order ?? []).filter((id) => g.nodes?.[id] !== undefined).length, `${where}：graphNodes`);
      const wantPreGraph = wantNodes.length === 0 && (nodeSeqs.length === 0 || range.end < minNodeSeq);
      t.eq(closure.preGraph, wantPreGraph, `${where}：preGraph 语义`);
    }
    t.eq(foldClosureOf(g, null), null, "null 区间 ⇒ null");
  }
};

tests["C60 边界不变量：openAtEnd = 恰跨终点的边数且 ≤ overlapping；unsettled = 未结算边数"] = (t) => {
  for (const seed of [1, 4, 9, 16]) {
    const { g, maxSeq } = randomGraph(seed);
    const edges = Object.values(g.edges);
    for (const range of [{ start: 0, end: maxSeq }, { start: 3, end: 12 }, { start: 6, end: 6 }]) {
      const b = foldBoundaryOf(g, range);
      const where = `seed=${seed} range=${range.start}-${range.end}`;
      const overlapping = edges.filter((e) => {
        const s = Number(e.evidence?.start);
        const en = Number(e.evidence?.end ?? s);
        return Number.isFinite(s) && Number.isFinite(en) && !(en < range.start || s > range.end);
      });
      const openAtEnd = overlapping.filter((e) => {
        const s = Number(e.evidence?.start);
        const en = Number(e.evidence?.end ?? s);
        return s <= range.end && en > range.end;
      });
      const unsettled = overlapping.filter((e) => e.result === "unverified" || e.result === "untested");
      t.eq(b.overlapping, overlapping.length, `${where}：overlapping`);
      t.eq(b.openAtEnd, openAtEnd.length, `${where}：openAtEnd`);
      t.eq(b.unsettled, unsettled.length, `${where}：unsettled`);
      t.eq(b.openAtEnd <= b.overlapping, true, `${where}：openAtEnd 不许超过 overlapping`);
    }
    const whole = foldBoundaryOf(g, { start: 0, end: maxSeq + 10 });
    t.eq(whole.openAtEnd, 0, "区间盖住全部证据 ⇒ 不可能切在调用中间");
    t.eq(foldBoundaryOf(g, null), null, "null 区间 ⇒ null");
  }
};

tests["C60 保真度：含全约束/全失败 id ⇒ 召回 1；缺一条进 missing；编造 id 进 unknownIds"] = (t) => {
  for (const seed of [2, 7, 11]) {
    const { g, maxSeq } = randomGraph(seed);
    const constraints = collectConstraints(g);
    const failures = failuresInFoldRange(g, null);
    const where = `seed=${seed}`;
    const full = ["## 目标", ...constraints.map((c) => `- ${c}`), "## 死路", ...failures.map((e) => `- ${e.id} "x" → boom (evidence seq 1-2)`)].join(String.fromCharCode(10));
    const good = measureFoldQuality({ graph: g, range: { start: 0, end: maxSeq }, summaryText: full, summaryTokens: 100, shadowedTokens: 1000 });
    t.eq(good.constraintRecall, 1, `${where}：约束召回必须 1`);
    t.eq(good.failureRecall, 1, `${where}：失败召回必须 1`);
    t.eq(good.unknownIds, [], `${where}：没有编造 id`);
    t.eq(good.compressionRatio, 10, `${where}：压缩比 = shadowed/summaryTokens`);
    t.eq(good.expectedConstraints, constraints.length, `${where}：约束计数`);
    t.eq(good.expectedFailures, failures.length, `${where}：区间失败计数`);

    if (constraints.length > 0) {
      const dropped = constraints[0];
      const bad = measureFoldQuality({ graph: g, range: null, summaryText: full.replace(dropped, ""), summaryTokens: 100, shadowedTokens: 1000 });
      t.eq(bad.constraintRecall < 1, true, `${where}：少一条约束必须掉召回`);
      t.eq(bad.missingConstraints.includes(dropped), true, `${where}：缺的约束要列出来`);
    }
    if (failures.length > 0) {
      const fid = failures[0].id;
      const bad = measureFoldQuality({ graph: g, range: null, summaryText: full.replace(fid, "e9999"), summaryTokens: 100, shadowedTokens: 1000 });
      t.eq(bad.failureRecall < 1, true, `${where}：少一条失败必须掉召回`);
      t.eq(bad.unknownIds.includes("e9999"), true, `${where}：编造的边 id 必须进 unknownIds`);
    }
  }
};
