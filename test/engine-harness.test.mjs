/**
 * engine-harness.test.mjs —— 用「假 DSH」跑通 engine 的接线
 *
 * 为什么要有这个测试：DSH 里的 @deepseek-ai/* 只能由宿主的解析器提供，
 * 纯 node 下 import 不到。办法是把 engine.mjs 的源码读出来，把那几个包名
 * 换成同目录的 stub，再写到临时文件里 import —— 这样能在不重启 DSH 的前提下
 * 验证「构造不抛错 / 事件落账 / 注入 ledger / fold 范围选择 / 增长门控」。
 *
 * 它替代不了重启后的真实验证（见 docs/重启后验证清单.md），但能挡住接线错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.join(HERE, "..", "src", "engine.mjs");
// ★ engine.mjs 里有 ./graph.mjs 这类相对 import，所以副本必须放在 src/ 旁边，
//   不能放到 test/ 下（否则相对路径断掉）。
const TMP = nodePath.join(HERE, "..", "src");
const STUBS = nodePath.join(TMP, ".harness-stubs");
const GRAPHS = nodePath.join(HERE, ".harness", "graphs");

/* ───────────────────────── stub 生成 ───────────────────────── */

function writeStubs() {
  nodeFs.mkdirSync(STUBS, { recursive: true });
  const w = (name, body) => nodeFs.writeFileSync(nodePath.join(STUBS, name), body, "utf8");

  w(
    "stub-schemastery.mjs",
    `const mk = () => {
  const o = { default: () => o, description: () => o, min: () => o, max: () => o, step: () => o, required: () => o };
  return o;
};
const z = { object: mk, array: mk, boolean: mk, string: mk, number: mk, natural: mk, union: mk, const: mk, any: mk };
export default z;
`,
  );

  w(
    "stub-compaction.mjs",
    `export function toolPairingBalancedBefore() { return true; }
export function toolPairingBalancedAfter() { return true; }
export function isCompactCheckpointSource(source) { return Boolean(source && source.kind === "compact-checkpoint"); }
export function compactCheckpointSource(id) { return { kind: "compact-checkpoint", compactionId: id }; }
export class CompactionEngine { constructor(ctx, name) { this.ctx = ctx; if (ctx && name) ctx[name] = this; } }
`,
  );

  w(
    "stub-llm.mjs",
    `export class LlmError extends Error { constructor(m, code, cause) { super(m); this.code = code; this.cause = cause; } }
export function contentHasImage(blocks) { return Array.isArray(blocks) && blocks.some((b) => b && b.type === "image"); }
export function createUserMessage(input) { return { id: "m" + Math.random().toString(36).slice(2), role: "user", ...input }; }
export class BlockAssembler {
  constructor() { this.chunks = []; this.finish = { kind: "stop" }; this.usage = undefined; }
  push(chunk) { this.chunks.push(chunk); }
  blocks() { return [{ type: "text", text: "## 目标\\n- mock summary" }]; }
}
`,
  );

  w(
    "stub-basic.mjs",
    `import { CompactionEngine } from "./stub-compaction.mjs";
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  constructor(ctx, config = {}) {
    super(ctx, "compaction");
    this.ctx = ctx;
    this.config = { auto: config.auto !== false };
    this.compactCalls = [];
    if (this.config.auto) this._registerAutomaticCompaction();
  }
  _registerAutomaticCompaction() { this.autoRegistered = true; }
  async compactIfNeeded() { return null; }
  async compactNow() { return null; }
  async compactRegion(start, end, agent) {
    this.compactCalls.push({ start, end });
    const nodes = agent.session.surface.nodes;
    const sIdx = nodes.indexOf(start);
    const eIdx = nodes.indexOf(end);
    if (sIdx < 0 || eIdx < 0) throw new Error("bad range");
    const cp = { seq: agent.session.nextSeq(), kind: "checkpoint" };
    nodes.splice(sIdx, eIdx - sIdx + 1, cp.seq);
    return { shadowedSeqs: [], shadowedRange: { start, end }, shadowedTokenCount: 0 };
  }
}
`,
  );

  const engineSrc = nodeFs.readFileSync(SRC, "utf8");
  const patched = engineSrc
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm.mjs"`);
  nodeFs.writeFileSync(nodePath.join(TMP, ".engine-under-test.mjs"), patched, "utf8");
  return { engineUrl: pathToFileURL(nodePath.join(TMP, ".engine-under-test.mjs")).href, graphDir: GRAPHS };
}

/* ───────────────────────── 假 session / ctx ───────────────────────── */

function makeSession({ id = "sess-1", tokensPerNode = 7000 } = {}) {
  let seq = 1000;
  const events = new Map();
  const nodes = [];
  const session = {
    id,
    cwd: process.cwd(),
    surface: { nodes },
    nextSeq: () => seq++,
    eventAt: (s) => events.get(s),
    requestHeader: () => ({ config: { provider: "p", model: "m", maxTokens: 4096 } }),
    toolHistory: () => ({ tools: [] }),
    append() {
      throw new Error("harness: append 未实现（engine 不该在事件回调里 append）");
    },
    seedSystem() {
      const s = seq++;
      nodes.push(s);
      events.set(s, { type: "system/message", seq: s, data: {} });
      return s;
    },
    push(kind, data) {
      const s = seq++;
      nodes.push(s);
      events.set(s, { type: kind === "system" ? "system/message" : "user/message", seq: s, data });
      return s;
    },
  };
  session.seedSystem();
  session.tokensPerNode = tokensPerNode;
  return session;
}

function makeCtx({ window = 200_000, measureTotal = () => 10_000 } = {}) {
  const listeners = new Map();
  const overlay = {};
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
    get(name) {
      return overlay[name];
    },
    tokenMeter: {
      measure(session) {
        const total = measureTotal(session);
        const nodes = session.surface.nodes.map((s) => ({ seq: s, tokens: session.tokensPerNode, heuristicTokens: session.tokensPerNode }));
        return { totalTokens: total, surfaceTokens: total, nodes };
      },
      estimateMessage: () => 100,
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: window }, defaultMaxTokens: 4096 };
      },
      async *stream() {
        yield { type: "text-delta", text: "## 目标\n- mock" };
      },
    },
    sessions: { flush: async () => {} },
    /** 多参数事件（如 session/event 的 (session, event)） */
    async emitRaw(name, ...args) {
      for (const fn of listeners.get(name) ?? []) await fn(...args);
    },
    /** waterfall（payload, next），末尾返回 defaultDecision(payload) */
    async waterfall(name, payload, defaultDecision) {
      const arr = listeners.get(name) ?? [];
      const run = async (i, p) => (i >= arr.length ? defaultDecision(p) : arr[i](p, () => run(i + 1, p)));
      return run(0, payload);
    },
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  };
  return ctx;
}

function userEvent(text, seq) {
  return { type: "user/message", seq, data: { id: "u", role: "user", content: [{ type: "text", text }], source: { kind: "prompt" } } };
}
function assistantEvent(callId, tool, args, seq, text = "接下来我要试试这个办法。") {
  return {
    type: "assistant/message",
    seq,
    data: {
      message: {
        id: "a",
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "tool-call", id: callId, name: tool, arguments: JSON.stringify(args) },
        ],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
  };
}
function resultEvent(callId, text, seq, isError = false) {
  return {
    type: "tool/result",
    seq,
    data: {
      message: {
        id: "r",
        role: "tool",
        toolCallId: callId,
        source: { kind: "tool", callId },
        content: [{ type: "text", text }],
        isError,
      },
    },
  };
}

/* ───────────────────────── 测试 ───────────────────────── */

let cached;
async function load() {
  if (cached) return cached;
  // 每次运行从空图开始（否则上一轮的 graph.json 会被当成历史加载，门控全乱）
  nodeFs.rmSync(GRAPHS, { recursive: true, force: true });
  cached = await (async () => {
    const stubs = writeStubs();
    const mod = await import(stubs.engineUrl);
    return { Engine: mod.default, graphDir: stubs.graphDir };
  })();
  return cached;
}

/** 模拟 loop 的行为：把 pre-step decision 里新增的消息追加进 surface。 */
function applyDecision(session, decision, claimed) {
  for (const message of decision.messages) {
    if (!claimed.includes(message)) session.push("user/message", message);
  }
}

function readGraph(graphDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const file = nodePath.join(graphDir, "sessions", safe, "graph.json");
  return JSON.parse(nodeFs.readFileSync(file, "utf8"));
}

tests["engine 能加载并构造；注册成 ctx.compaction；auto=true 时注册自动压缩"] = async () => {
  const { Engine } = await load();
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: nodePath.join(GRAPHS, "g1"), auto: true });
  if (!engine) throw new Error("构造返回空");
  if (ctx.compaction !== engine) throw new Error("没有注册成 ctx.compaction");
  if (!engine.autoRegistered) throw new Error("auto=true 时应注册自动压缩");
};

tests["auto=false：不注册自动压缩，但 keeper 与 ledger 仍然挂上"] = async () => {
  const { Engine } = await load();
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: nodePath.join(GRAPHS, "g2"), auto: false });
  if (engine.autoRegistered) throw new Error("auto=false 仍注册了自动压缩");
  if (ctx.listenerCount("session/event") === 0) throw new Error("没挂 session/event（落账失效）");
  if (ctx.listenerCount("agent/pre-step") === 0) throw new Error("没挂 pre-step（注入失效）");
};

tests["事件落账：user/assistant/tool/step 走完后 graph.json 有节点与失败边"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-log" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });

  await ctx.emitRaw("session/event", session, userEvent("必须保持接口不变。先修测试。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "AssertionError: boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const g = readGraph(graphDir, "sess-log");
  const users = Object.values(g.nodes).filter((n) => n.kind === "user");
  const agents = Object.values(g.nodes).filter((n) => n.kind === "agent");
  const failures = Object.values(g.edges).filter((e) => e.result === "failure");
  if (users.length !== 1) throw new Error(`user 节点 ${users.length}`);
  if (agents.length !== 1) throw new Error(`agent 节点 ${agents.length}`);
  if (failures.length !== 1) throw new Error(`失败边 ${failures.length}`);
  if (!failures[0].errorSnippet.includes("AssertionError")) throw new Error("失败原因没落盘");
};

tests["失败清单注入：pre-step 返回的 messages 里多一条 chess-context 消息"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-ledger" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });

  await ctx.emitRaw("session/event", session, userEvent("必须保持接口不变。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const claimed = [{ id: "claimed-1", role: "user", content: [{ type: "text", text: "继续" }] }];
  const agent = { session, options: { provider: "p", model: "m" } };
  const decision = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1, signal: undefined }, () => ({ kind: "enter", messages: claimed }));
  if (decision.kind !== "enter") throw new Error(`decision 不对：${decision.kind}`);
  const injected = decision.messages.filter((m) => m.source?.kind === "chess-context");
  if (injected.length !== 1) throw new Error(`注入条数 ${injected.length}`);
  if (!injected[0].content[0].text.includes("LEARNED")) throw new Error("注入内容不是失败清单");
};

tests["注入去重：同一份清单不重复注入"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-dedup" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });
  await ctx.emitRaw("session/event", session, userEvent("x", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "t" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "err\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const agent = { session, options: {} };
  const claimed = [{ id: "c", role: "user", content: [] }];
  const d1 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1 }, () => ({ kind: "enter", messages: claimed }));
  applyDecision(session, d1, claimed); // 真实环境：进入步骤的批次会 append 进历史
  const d2 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 2 }, () => ({ kind: "enter", messages: claimed }));
  const n1 = d1.messages.filter((m) => m.source?.kind === "chess-context").length;
  const n2 = d2.messages.filter((m) => m.source?.kind === "chess-context").length;
  if (n1 !== 1) throw new Error(`第一次注入 ${n1}`);
  // 第二次不新增（真实环境里上一轮那条已 append 进 surface，模型仍看得到）
  if (n2 !== 0) throw new Error(`第二次不该重复注入，得到 ${n2}`);
};

tests["阈值门控：低于阈值不 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-threshold" });
  const ctx = makeCtx({ measureTotal: () => 30_000 }); // 200K × 0.45 = 90K
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0 });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (result !== null) throw new Error("低于阈值却 fold 了");
};

tests["超过阈值 ⇒ 选中「checkpoint 之后」的范围（增量语义）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-range" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  // 造 20 个节点（含 system）：1 + 19
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const firstPlainSeq = session.surface.nodes[1]; // ★ 必须在 fold 之前取（fold 会替换 surface）
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当 fold");
  if (engine.compactCalls.length !== 1) throw new Error(`compactRegion 调用 ${engine.compactCalls.length} 次`);
  const call = engine.compactCalls[0];
  if (call.start !== firstPlainSeq) {
    // 无 checkpoint 时，起点必须是第一个非 system 节点
    throw new Error(`起点应为 ${firstPlainSeq}，得到 ${call.start}`);
  }
};

tests["增长门控：fold 之后增量不足则不再次 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-growth" });
  let total = 300_000;
  const ctx = makeCtx({ measureTotal: () => total });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 50_000, minFoldTokens: 0, retainRatio: 0.1 });
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const first = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!first) throw new Error("第一次应当 fold");
  // 增量只有 10K < 50K
  total = 310_000;
  const second = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (second !== null) throw new Error("增量不足却 fold 了");
  // 增量 60K ≥ 50K ⇒ 放行（但可能因 checkpoint 在末尾而没有可压内容）
  total = 360_000;
  const third = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (third === null) {
    // 若范围为空（checkpoint 在末尾）也算合理；但不能抛错
  }
};

tests["溢出自救：绕过阈值与增长门控"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-overflow" });
  const ctx = makeCtx({ measureTotal: () => 1_000 }); // 远低于阈值
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 10_000_000, minFoldTokens: 10_000_000 });
  for (let i = 0; i < 5; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const result = await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
  if (!result) throw new Error("溢出自救必须能压");
};
