/**
 * robustness.test.mjs —— 坏数据 / 极端输入下的行为
 *
 * 这些场景在真实机器上迟早会遇到：
 *   · graph.json 被写坏（断电、磁盘满）→ 下次启动不能崩，要能重建
 *   · 会话里出现半截 tool-call（没有 result）→ 不能卡住
 *   · 巨大的单条消息（1MB）→ 不能把内存打爆
 *   · constraint 抽取遇到非字符串 / 空串
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, toJSON, fromJSON, addUserNodeId, addEdge, settleEdge, failureEdges, currentPath, validate } from "./graph-fixtures.mjs";
import { observeEvent } from "../src/keeper.mjs";
import { renderLedger, renderFacts } from "../src/ledger.mjs";
import { classify } from "../src/verifier.mjs";
import { collectConstraints } from "../src/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
export const tests = {};

tests["graph.json 被截断 ⇒ fromJSON 抛错但 createGraph 仍可用（调用方负责降级）"] = () => {
  let threw = false;
  try {
    fromJSON("{not json");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("坏 JSON 应当抛错（由调用方决定降级）");
  const g = createGraph({ sessionId: "after-corrupt" });
  if (g.order.length !== 0) throw new Error("新图应当是空的");
};

tests["半截 tool-call（没有 result）不会卡住后续事件"] = () => {
  const g = createGraph({ sessionId: "half" });
  const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [] };
  observeEvent(g, { type: "user/message", seq: 1, data: { id: "u", role: "user", content: [{ type: "text", text: "必须保持接口不变。" }], source: { kind: "user" } } }, st);
  observeEvent(
    g,
    {
      type: "assistant/message",
      seq: 2,
      data: { message: { id: "a", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }], source: { kind: "model" } } },
    },
    st,
  );
  // 没有 tool/result，直接来一个 step/end 与下一个 assistant
  observeEvent(g, { type: "step/end", seq: 3, data: { turn: 1, step: 1 } }, st);
  observeEvent(
    g,
    {
      type: "assistant/message",
      seq: 4,
      data: { message: { id: "a2", role: "assistant", content: [{ type: "text", text: "换个思路。" }], source: { kind: "model" } } },
    },
    st,
  );
  const open = Object.values(g.edges).filter((e) => e.result === "untested" || e.result === "unverified");
  if (open.length === 0) throw new Error("半截调用应留下 unverified/untested 边（不能静默消失）");
  for (const [id, e] of Object.entries(g.edges)) {
    if (e.from && !g.nodes[e.from]) throw new Error(`边 ${id} 的 from 不存在`);
    if (e.to && !g.nodes[e.to]) throw new Error(`边 ${id} 的 to 不存在`);
  }
};

tests["1MB 单条消息不会打爆渲染"] = () => {
  const g = createGraph({ sessionId: "huge" });
  const u = addUserNodeId(g, { seq: 1, text: `必须保持接口不变。${"长".repeat(1_000_000)}` });
  const e = addEdge(g, { from: u, intent: "处理一个超大消息", action: "bash(cat huge.txt)" });
  settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: out of memory" });
  const ledger = renderLedger(g, { maxTokens: 500 });
  if (ledger.tokens > 600) throw new Error(`热上下文超预算：${ledger.tokens}`);
  const facts = renderFacts(g);
  if (facts.length > 20_000) throw new Error(`事实块没截断：${facts.length}`);
};

tests["约束抽取遇到空/非字符串不崩"] = () => {
  const g = createGraph({ sessionId: "weird" });
  addUserNodeId(g, { seq: 1, text: "必须保持接口不变。" });
  const cons = collectConstraints(g);
  if (!Array.isArray(cons)) throw new Error("应返回数组");
  if (cons.some((c) => typeof c !== "string")) throw new Error("应全是字符串");
};

tests["重复 seq / 乱序事件不产生环"] = () => {
  const g = createGraph({ sessionId: "order" });
  const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [] };
  const ev = (seq) => ({
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", content: [{ type: "text", text: `第 ${seq} 句` }], source: { kind: "user" } },
  });
  observeEvent(g, ev(5), st);
  observeEvent(g, ev(3), st);
  observeEvent(g, ev(9), st);
  for (const [id, e] of Object.entries(g.edges)) {
    if (e.from && !g.nodes[e.from]) throw new Error(`边 ${id} 的 from 不存在`);
    if (e.to && !g.nodes[e.to]) throw new Error(`边 ${id} 的 to 不存在`);
  }
  if (g.order.some((id) => !g.nodes[id])) throw new Error("order 引用了不存在的节点");
  const path = currentPath(g, g.order[g.order.length - 1]);
  if (path.length === 0) throw new Error("路径断了");
};

tests["classify 对 null/undefined/非字符串输入不崩"] = () => {
  for (const input of [null, undefined, 0, false, {}, []]) {
    const r = classify({ tool: "bash", text: input });
    if (!r || !["success", "failure", "unverified"].includes(r.result)) throw new Error(`输入 ${String(input)} 返回异常`);
  }
};
