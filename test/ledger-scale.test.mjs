/**
 * ledger-scale.test.mjs —— 热上下文在「失败边很多」时的硬预算行为
 *
 * 背景（bench 实测）：1201 条失败边时，旧版 renderLedger 输出 28,800 tokens ——
 * 比它要省的上下文还大。新版必须满足：
 *   · 少于 30 条：逐条列出，omittedEdges === 0
 *   · 上千条：tokens 受 maxTokens 约束（±20%），且必须有汇总行说明省略了多少条
 *   · 无论多少条：根用户的约束必须在
 */

import { createGraph, addUserNode, addEdge, settleEdge } from "../src/graph.mjs";
import { renderLedger, renderFacts } from "../src/ledger.mjs";

export const tests = {};

function buildGraph(n) {
  const g = createGraph({ sessionId: "scale" });
  const u = addUserNode(g, { seq: 1, text: "必须保持公开 API 响应字段不变，不要动 prod 配置。把测试跑绿。" });
  let last = u;
  for (let i = 0; i < n; i += 1) {
    const e = addEdge(g, { from: last, intent: `第 ${i} 次尝试：换一种缓存策略`, action: `bash(npm test -- case${i})`, evidence: { start: i * 10 + 2, end: i * 10 + 5 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42` });
    last = u;
  }
  return g;
}

tests["30 条失败边：逐条列出，不省略"] = () => {
  const g = buildGraph(30);
  const r = renderLedger(g, { maxTokens: 1200 });
  if (r.omittedEdges !== 0) throw new Error(`不该省略，实际 ${r.omittedEdges}`);
  if (r.shownFailures !== 30) throw new Error(`展示 ${r.shownFailures}`);
  if (!r.text.includes("LEARNED (30 failed attempts")) throw new Error("缺失败边标题");
  if (!r.text.includes("必须保持公开 API 响应字段不变")) throw new Error("缺约束");
};

tests["1000 条失败边：token 受预算约束，且汇总行说明省略数"] = () => {
  const g = buildGraph(1000);
  const r = renderLedger(g, { maxTokens: 500 });
  if (r.tokens > 500 * 1.2) throw new Error(`超预算：${r.tokens} tokens（预算 500）`);
  if (r.level !== 4 && r.level !== 5) throw new Error(`应降到 L4/L5，实际 L${r.level}`);
  if (r.omittedEdges <= 0) throw new Error("1000 条应省略一部分");
  if (!r.text.includes("earlier dead ends omitted for budget")) throw new Error("缺汇总行（模型不知道还有多少条）");
  if (!r.text.includes("LEARNED (1000 failed attempts")) throw new Error("总数必须写真实值");
};

tests["1000 条失败边：摘要的事实块仍全量（或明确说明省略范围）"] = () => {
  const g = buildGraph(1000);
  const facts = renderFacts(g);
  // 800 条上限：必须有一条 OMITTED 行说明省略了哪些 id
  if (!facts.includes("FAILED_ATTEMPTS_OMITTED")) throw new Error("事实块缺省略说明");
  const listed = (facts.match(/^\* e\d+/gm) ?? []).length;
  if (listed < 500) throw new Error(`事实块列得太少：${listed}`);
  // 第一条与最后一条必须在（根因 + 当前状态）
  if (!facts.includes("* e1 ")) throw new Error("缺最早的失败边 e1");
  if (!facts.includes("* e1000 ")) throw new Error("缺最近的失败边 e1000");
};

tests["约束在极端规模下仍然逐字保留"] = () => {
  const g = buildGraph(1000);
  const facts = renderFacts(g);
  if (!facts.includes("必须保持公开 API 响应字段不变")) throw new Error("约束丢了");
  if (!facts.includes("不要动 prod 配置")) throw new Error("约束丢了（第二条）");
};
