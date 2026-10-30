/**
 * bench.mjs —— 性能与体量基准（真实规模，不是玩具）
 *
 * 回答：在一个 5000 条边的长会话里，
 *   · 每个事件落账多久（这决定每步的额外开销）
 *   · 渲染热上下文 / 事实块 / 棋谱 md 多久
 *   · graph.json 多大、落盘多久
 *
 * 用法：node test/bench.mjs [edges]
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges, renderMd, toJSON } from "./graph-fixtures.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";
import { renderLedger, renderFacts } from "../src/rooms/ledger.mjs";
import { selectIncrementalRange } from "../src/rooms/fold-planner.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OUT = nodePath.join(HERE, "..", "evidence");
const N = Number(process.argv[2] ?? 5000);

function timed(fn, iterations = 1) {
  fn(); // 预热
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  return (performance.now() - t0) / iterations;
}

function buildLargeGraph(edgeCount) {
  const g = createGraph({ sessionId: "bench", cwd: process.cwd() });
  const u = addUserNodeId(g, {
    seq: 1,
    text: "必须保持公开 API 响应字段不变，不要动 prod 配置。把 sessions 服务日志改成流式，并让测试全绿。",
  });
  let last = u;
  const kinds = ["failure", "failure", "success", "unverified"];
  for (let i = 0; i < edgeCount; i += 1) {
    const result = kinds[i % kinds.length];
    const e = addEdge(g, {
      from: last,
      intent: `第 ${i} 步：尝试把 ${i % 7} 号模块的缓存换成 LRU`,
      action: `bash(npm test -- --filter case${i})`,
      evidence: { start: 100 + i * 8, end: 104 + i * 8 },
    });
    settleEdge(g, e, {
      to: null,
      result,
      verify: result === "failure" ? { kind: "exit", summary: "exit 1" } : { kind: "exit", summary: "exit 0" },
      errorSnippet: result === "failure" ? `AssertionError: expected ${i} to equal ${i + 1} at suite/case${i}.test.js:42` : "",
    });
    const node = addAgentNode(g, {
      seq: 200 + i * 8,
      turn: Math.floor(i / 4),
      goal: `推进到第 ${i} 步`,
      worldHash: `W${i}`,
      constraintHash: "C1",
      via: e.id,
    });
    settleEdge(g, e, {
      to: node.id,
      result,
      verify: result === "failure" ? { kind: "exit", summary: "exit 1" } : { kind: "exit", summary: "exit 0" },
      errorSnippet: result === "failure" ? `AssertionError: expected ${i} to equal ${i + 1} at suite/case${i}.test.js:42` : "",
    });
    last = node.id;
  }
  return g;
}

console.log(`== bench：${N} 条边 ==`);
const g = buildLargeGraph(N);

const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [] };
const evAssistant = {
  type: "assistant/message",
  seq: 999_001,
  data: {
    message: {
      id: "a",
      role: "assistant",
      content: [
        { type: "text", text: "接下来我要把这个模块的缓存换掉。" },
        { type: "tool-call", id: "call_x", name: "bash", arguments: '{"command":"npm test"}' },
      ],
      source: { kind: "model", provider: "p", model: "m" },
    },
  },
};
const evResult = {
  type: "tool/result",
  seq: 999_002,
  data: {
    message: {
      id: "r",
      role: "tool",
      toolCallId: "call_x",
      source: { kind: "tool", callId: "call_x" },
      content: [{ type: "text", text: "AssertionError: boom\n[exit code: 1]" }],
      isError: false,
    },
  },
};

const observeMs = timed(() => {
  // 每次用一份浅拷贝的 state，避免 pendingEdges 累加影响测量
  const s2 = { ...st, pendingEdges: new Map(), stepEdges: [] };
  observeEvent(g, evAssistant, s2);
  observeEvent(g, evResult, s2);
}, 200);

const ledgerMs = timed(() => renderLedger(g, { maxTokens: 500 }), 100);
const factsMs = timed(() => renderFacts(g), 50);
const mdMs = timed(() => renderMd(g), 20);
const jsonMs = timed(() => toJSON(g), 20);
const json = toJSON(g);

const priced = g.order.map((id, i) => ({ seq: g.nodes[id].seq, tokens: 3000, heuristicTokens: 3000 }));
const surface = g.order.map((id) => g.nodes[id].seq);
const rangeMs = timed(() => {
  selectIncrementalRange({
    surfaceNodes: surface,
    pricedNodes: priced,
    retainTokens: 150_000,
    hasSystemHead: false,
    foldStartSeq: null,
    minFoldTokens: 8000,
  });
}, 50);

const ledger = renderLedger(g, { maxTokens: 500 });
const facts = renderFacts(g);
const md = renderMd(g);

const rows = [
  ["事件落账（assistant + tool/result 一对）", `${observeMs.toFixed(3)} ms`, "每步调用两次"],
  ["渲染热上下文（≤500 token 预算）", `${ledgerMs.toFixed(3)} ms`, `${ledger.tokens} tokens / 降级档 ${ledger.level}`],
  ["渲染硬事实块（摘要 prompt 用）", `${factsMs.toFixed(3)} ms`, `${facts.length} 字符`],
  ["渲染棋谱 md（人读）", `${mdMs.toFixed(3)} ms`, `${md.length} 字符`],
  ["序列化 graph.json", `${jsonMs.toFixed(3)} ms`, `${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB`],
  ["增量 fold 范围选择", `${rangeMs.toFixed(3)} ms`, `${surface.length} 个 surface 节点`],
];

console.log("");
console.log("| 操作 | 耗时 | 备注 |");
console.log("|---|---|---|");
for (const [a, b, c] of rows) console.log(`| ${a} | ${b} | ${c} |`);

const stats = {
  generatedAt: new Date().toISOString(),
  edges: N,
  nodes: g.order.length,
  failures: failureEdges(g).length,
  ledgerTokens: ledger.tokens,
  ledgerLevel: ledger.level,
  ledgerOmitted: ledger.omittedEdges,
  factsChars: facts.length,
  mdChars: md.length,
  jsonBytes: Buffer.byteLength(json),
  ms: {
    observePair: Number(observeMs.toFixed(3)),
    renderLedger: Number(ledgerMs.toFixed(3)),
    renderFacts: Number(factsMs.toFixed(3)),
    renderMd: Number(mdMs.toFixed(3)),
    serialize: Number(jsonMs.toFixed(3)),
    selectRange: Number(rangeMs.toFixed(3)),
  },
};

nodeFs.mkdirSync(OUT, { recursive: true });
nodeFs.writeFileSync(nodePath.join(OUT, `bench-${N}.json`), JSON.stringify(stats, null, 2), "utf8");
console.log(`\n已写入 evidence/bench-${N}.json`);
console.log(`失败边 ${stats.failures} 条，热上下文 ${stats.ledgerTokens} tokens（丢边 ${stats.ledgerOmitted} 条）`);
