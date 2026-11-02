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

import { foldBoundaryOf, foldClosureOf } from "../src/rooms/kifu-model.mjs";
import { collectConstraints } from "../src/rooms/ledger.mjs";

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
  push(chunk) { this.chunks.push(chunk); if (chunk && chunk.usage !== undefined) this.usage = chunk.usage; }
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

export function makeSession({ id = "sess-1", tokensPerNode = 7000 } = {}) {
  let seq = 1000;
  const events = new Map();
  const nodes = [];
  const session = {
    id,
    cwd: process.cwd(),
    surface: { nodes },
    get seq() {
      return seq;
    },
    nextSeq: () => seq++,
    eventAt: (s) => events.get(s),
    requestHeader: () => ({ config: { provider: "p", model: "m", maxTokens: 4096 } }),
    toolHistory: () => ({ tools: [] }),
    /**
     * 真实 Session.append 的最小实现（P1-4 需要）：append / replace 两种 surfaceOp。
     * replace 必须引用当前 surface 上的连续节点，sourceEventSeqs 必须覆盖被遮蔽节点 —— 与真实
     * Session 的校验一致（见 test/real-ledger-replace.mjs 对真实包的验证）。
     */
    append(type, data, opts = {}) {
      const s = seq++;
      const event = { type, seq: s, data, ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }), ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }) };
      events.set(s, event);
      if (opts.surfaceOp === "append" || opts.surfaceOp === undefined) {
        nodes.push(s);
      } else if (opts.surfaceOp && opts.surfaceOp.op === "replace") {
        const startIdx = nodes.indexOf(opts.surfaceOp.startSeq);
        const endIdx = nodes.indexOf(opts.surfaceOp.endSeq);
        if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error("harness: replace 范围不在当前 surface 上");
        const shadowed = nodes.slice(startIdx, endIdx + 1);
        const cited = new Set(opts.sourceEventSeqs ?? []);
        const missing = shadowed.filter((x) => !cited.has(x));
        if (missing.length > 0) throw new Error(`harness: sourceEventSeqs 漏了 ${missing.join(",")}`);
        nodes.splice(startIdx, endIdx - startIdx + 1, s);
      } else {
        throw new Error("harness: 非法 surfaceOp");
      }
      return event;
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

export function makeCtx({ window = 200_000, measureTotal = () => 10_000, failModels = new Set(), usage = null, services = {} } = {}) {
  const listeners = new Map();
  const overlay = { ...services };
  const ctx = {
    logger: { info: () => {}, warn: (m) => ctx.warns.push(String(m)), debug: () => {}, error: (m) => ctx.errors.push(String(m)) },
    /** 记录 warn 文案（用于断言「摘要模型不可用时退回了路由」） */
    warns: [],
    /** ★ P7：记录 error 文案（impossible 必须是 error 级） */
    errors: [],
    /** 摘要（llm.stream）收到的 options，供断言 prompt 内容 */
    streamCalls: [],
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
      async *stream(options) {
        // 记录每次摘要调用的完整输入 —— 用来断言「硬事实块」真的带着失败边进了 prompt
        ctx.streamCalls.push(options);
        if (failModels.has(options.model)) {
          throw new Error(`pi-ai provider "${options.provider}" has no configured model "${options.model}"`);
        }
        yield { type: "text-delta", text: "## 目标\n- mock" };
        // ★ P2-2：只在显式传 usage 时产出（默认不产出 ⇒ 其它用例的 assembler.usage 仍是 undefined）
        if (usage !== null) yield { type: "usage", usage };
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
export async function load() {
  if (cached) return cached;
  // 每次运行从空图开始（否则上一轮的 graph.json 会被当成历史加载，门控全乱）
  nodeFs.rmSync(GRAPHS, { recursive: true, force: true });
  cached = await (async () => {
    const stubs = writeStubs();
    const mod = await import(stubs.engineUrl);
    // ★ 2026-11-01：把整个模块也带出来（`mod`），供纯函数单测用（accumulateLedgerBudget 等）。
    return { Engine: mod.default, graphDir: stubs.graphDir, mod };
  })();
  return cached;
}

/** 模拟 loop 的行为：把 pre-step decision 里新增的消息追加进 surface。 */
function applyDecision(session, decision, claimed) {
  for (const message of decision.messages) {
    if (!claimed.includes(message)) session.push("user/message", message);
  }
}

export function readGraph(graphDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const file = nodePath.join(graphDir, "sessions", safe, "graph.json");
  return JSON.parse(nodeFs.readFileSync(file, "utf8"));
}

/** 重放 delta 后读图（foldMarks 常落在增量里，只读基线会漏）——C210 测试用。 */
export async function readGraphReplayed(graphDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const file = nodePath.join(graphDir, "sessions", safe, "graph.json");
  const { loadSessionGraph } = await import("../scripts/graph-audit.mjs");
  return loadSessionGraph(file).graph;
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
  // ★ P0 回归（2026-10-28 实机：226 次压缩只成功 3 次，上下文涨到 66 万 token → 模型死循环）：
  //   worldstate.hash() 返回的是 { hash, mode, files } 对象，keeper 经 engine 注入的
  //   worldHashOf/constraintHashOf 落库时**必须已是字符串**。旧版把对象原样写进节点，
  //   随后 ledger 的 `.slice()` 对对象抛 TypeError，整条压缩链路回滚。
  //   这条断言走的是真实代码路径（keeper → addAgentNode ← engine.worldHashOf），
  //   纯函数单测传的是字符串假数据，正是它把契约不一致藏住的。
  for (const [field, value] of [["worldHash", agents[0].worldHash], ["constraintHash", agents[0].constraintHash]]) {
    if (typeof value !== "string") throw new Error(`${field} 不是字符串：${JSON.stringify(value)}（${typeof value}）`);
    if (value === "pending") throw new Error(`${field} 仍是 pending（engine 注入的哈希函数没生效）`);
  }
  const key = `${agents[0].worldHash}/${agents[0].constraintHash}`;
  if (g.stateIndex[key] !== agents[0].id) {
    throw new Error(`stateIndex 未建立：${key} → ${JSON.stringify(g.stateIndex)}`);
  }
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

tests["标记档位（hotLedgerMarkers）能一路传到热清单：off 不打标记、semantic 默认带语义"] = async () => {
  const { Engine, graphDir } = await load();
  const run = async (id, config) => {
    const session = makeSession({ id });
    const ctx = makeCtx();
    new Engine(ctx, { graphDir, auto: false, ...config });
    await ctx.emitRaw("session/event", session, userEvent("必须保持接口不变。", 1));
    await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
    await ctx.emitRaw("session/event", session, resultEvent("c1", "npm ERR! EACCES: permission denied\n[exit code: 1]", 3));
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
    const claimed = [{ id: "claimed-x", role: "user", content: [{ type: "text", text: "继续" }] }];
    const agent = { session, options: { provider: "p", model: "m" } };
    const decision = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1, signal: undefined }, () => ({ kind: "enter", messages: claimed }));
    return decision.messages.filter((m) => m.source?.kind === "chess-context")[0]?.content[0].text ?? "";
  };
  const semantic = await run("sess-markers-sem", { hotLedgerMarkers: "semantic" });
  if (!semantic.includes("blocked:permission")) throw new Error(`semantic 档没写出原因：\n${semantic}`);
  if (!semantic.includes("# markers:")) throw new Error(`semantic 档缺图例：\n${semantic}`);
  const terse = await run("sess-markers-terse", { hotLedgerMarkers: "terse" });
  if (!terse.includes("[blocked ")) throw new Error(`terse 档应只写三态：\n${terse}`);
  if (terse.includes("blocked:permission")) throw new Error(`terse 档不该带原因：\n${terse}`);
  const off = await run("sess-markers-off", { hotLedgerMarkers: "off" });
  if (off.includes("[blocked")) throw new Error(`off 档仍有标记：\n${off}`);
  if (off.includes("# markers:")) throw new Error(`off 档仍有图例：\n${off}`);
  const bogus = await run("sess-markers-bogus", { hotLedgerMarkers: "随便写的" });
  if (!bogus.includes("blocked:permission")) throw new Error("非法档位应回落到 semantic");
};

tests["P1-4：清单已在 surface 上时就地替换 —— surface 永远只有一条"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-replace" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });
  const agent = { session, options: {} };
  const claimed = [{ id: "claimed-r", role: "user", content: [{ type: "text", text: "继续" }] }];
  const ledgerSeqs = () => session.surface.nodes.filter((s) => session.eventAt(s)?.data?.source?.kind === "chess-context");

  // 先攒一条失败边 → 第一次注入（surface 上没有清单 ⇒ 追加）
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  const d1 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1 }, () => ({ kind: "enter", messages: claimed }));
  if (d1.messages.filter((m) => m.source?.kind === "chess-context").length !== 1) throw new Error("第一次应是追加");
  applyDecision(session, d1, claimed); // 真实 loop 会把 decision 里的新消息 append 进 surface
  if (ledgerSeqs().length !== 1) throw new Error("surface 上应有一条清单");
  const firstSeq = ledgerSeqs()[0];
  const firstText = session.eventAt(firstSeq).data.content[0].text;

  // 再攒 5 条失败边，并推进 45 个事件（越过「40 事件 / 失败边 +5」这两道限流门）
  for (let i = 0; i < 5; i += 1) {
    await ctx.emitRaw("session/event", session, assistantEvent(`c${i + 10}`, "bash", { command: `npm test ${i}` }, 10 + i * 3));
    await ctx.emitRaw("session/event", session, resultEvent(`c${i + 10}`, `boom ${i}\n[exit code: 1]`, 11 + i * 3));
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: 12 + i * 3, data: { turn: 1, step: 2 + i } });
  }
  for (let i = 0; i < 45; i += 1) session.nextSeq();

  const d2 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 2 }, () => ({ kind: "enter", messages: claimed }));
  if (d2.messages.filter((m) => m.source?.kind === "chess-context").length !== 0) {
    throw new Error("第二次应该是就地替换，不该再往 decision.messages 里加一条");
  }
  const after = ledgerSeqs();
  if (after.length !== 1) throw new Error(`surface 上清单节点数 ${after.length}（应恒为 1，P1-4 就是要消除累积）`);
  if (after[0] === firstSeq) throw new Error("还是旧节点（没有替换）");
  const newText = session.eventAt(after[0]).data.content[0].text;
  if (newText === firstText) throw new Error("内容没变（替换成了同一份）");
  if (!newText.includes("LEARNED (6 failed attempts")) throw new Error(`新清单没反映新的失败数：\n${newText.slice(0, 240)}`);

  // 失败数没变、事件间隔不够 ⇒ 限流门仍然拦住（不写日志、不碰 contentGeneration）
  const nodesBefore = session.surface.nodes.length;
  await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 3 }, () => ({ kind: "enter", messages: claimed }));
  if (session.surface.nodes.length !== nodesBefore) throw new Error("限流门没挡住（不该再注入）");
};

tests["P1-4 兜底：清单被 fold 遮蔽后，下一次 pre-step 立刻补回来（不等限流）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-refold" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });
  const agent = { session, options: {} };
  const claimed = [{ id: "claimed-f", role: "user", content: [{ type: "text", text: "继续" }] }];
  const ledgerSeqs = () => session.surface.nodes.filter((s) => session.eventAt(s)?.data?.source?.kind === "chess-context");

  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  const d1 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1 }, () => ({ kind: "enter", messages: claimed }));
  applyDecision(session, d1, claimed);

  // 模拟 fold：清单节点从 surface 上消失（被 checkpoint 遮蔽）
  const seq = ledgerSeqs()[0];
  session.surface.nodes.splice(session.surface.nodes.indexOf(seq), 1);
  if (ledgerSeqs().length !== 0) throw new Error("前置条件不对");

  const d2 = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 2 }, () => ({ kind: "enter", messages: claimed }));
  const reinjected = d2.messages.filter((m) => m.source?.kind === "chess-context");
  if (reinjected.length !== 1) throw new Error(`被 fold 遮蔽后应立刻补回，实际 ${reinjected.length}`);
  if (!reinjected[0].content[0].text.includes("LEARNED")) throw new Error("补回来的不是清单");
};

tests["P1-4 配套：历史遗留的旧清单被换成一行占位（surface 不再背旧账）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-legacy-elide" });
  const ctx = makeCtx();
  // 模拟旧版：surface 上已经压着 3 条长清单（每条 800 字符）
  for (let i = 0; i < 3; i += 1) {
    session.push("user/message", {
      id: `legacy-led-${i}`,
      role: "user",
      content: [{ type: "text", text: `LEGACY LEDGER ${i} ${"x".repeat(800)}` }],
      source: { kind: "chess-context", form: "ledger", digest: `old-${i}` },
    });
  }
  new Engine(ctx, { graphDir, auto: false });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const agent = { session, options: {} };
  const claimed = [{ id: "claimed-e", role: "user", content: [{ type: "text", text: "继续" }] }];
  const ledgerEvents = () =>
    session.surface.nodes
      .map((s) => session.eventAt(s))
      .filter((e) => e?.type === "user/message" && e.data?.source?.kind === "chess-context");

  await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1 }, () => ({ kind: "enter", messages: claimed }));
  const events = ledgerEvents();
  if (events.length !== 3) throw new Error(`清单节点数 ${events.length}（不该新增，应就地清理）`);
  const stubs = events.filter((e) => e.data.source.form === "ledger-stub");
  if (stubs.length !== 2) throw new Error(`占位数 ${stubs.length}（3 条里除最新那条外都该被清理）`);
  for (const stub of stubs) {
    const text = stub.data.content.map((b) => b.text).join("");
    if (text.length > 200) throw new Error(`占位没变短：${text.length} 字符`);
    if (!text.includes("elided")) throw new Error(`占位文案不对：${text}`);
  }
  const newest = events[events.length - 1];
  if (!newest.data.content[0].text.includes("<chess-ledger>")) throw new Error("最后一条应是刷新后的真清单");

  // 幂等：再来一次不应再产生占位
  const before = ledgerEvents().filter((e) => e.data.source.form === "ledger-stub").length;
  for (let i = 0; i < 45; i += 1) session.nextSeq();
  await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 2 }, () => ({ kind: "enter", messages: claimed }));
  const after = ledgerEvents().filter((e) => e.data.source.form === "ledger-stub").length;
  if (after !== before) throw new Error(`不幂等：占位从 ${before} 变成 ${after}`);
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

tests["fold 记账：checkpointSeq 记 checkpoint 消息的 seq，不是被遮蔽区间的起点"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-cpseq" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: nodePath.join(GRAPHS, "g-cpseq"), auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当 fold");
  const call = engine.compactCalls[0];
  const g = readGraph(nodePath.join(GRAPHS, "g-cpseq"), "sess-cpseq");
  // 2026-10-29 实机 bug：这里曾写 range.start（fold 后已不在 surface 上，实机一直是 9）
  if (g.checkpointSeq === call.start) {
    throw new Error(`checkpointSeq 不该是被遮蔽区间起点 ${call.start}`);
  }
  if (g.foldCount !== 1) throw new Error(`foldCount 应为 1，得到 ${g.foldCount}`);
  if (!Array.isArray(g.foldMarks) || g.foldMarks.length !== 1) throw new Error("foldMarks 应有 1 条");
  // ★ 2026-11-01（调研建议 G-5）：每次 fold 都要留下「边界结算状态」快照 ——
  //   让 doctor 能回答"跨 fold 边界还挂着多少未结算的边"，把边界切得好不好从直觉变成数字。
  // ★ 2026-11-01：摘要长度必须被记下来 —— 保真再高，模型不遵守长度预算也会让上下文成本翻倍。
  const chars = g.foldMarks[0].summaryChars;
  if (chars !== null && typeof chars !== "number") {
    throw new Error(`foldMarks[0].summaryChars 必须是数字或 null，得到 ${JSON.stringify(chars)}`);
  }
  // ★ 2026-11-01：保真度 L1 必须写进 foldMark（否则模块只会被单测调用，永远拿不到真实语料）。
  const quality = g.foldMarks[0].quality;
  if (quality === null || typeof quality !== "object") {
    throw new Error(`foldMarks[0].quality 必须是对象，得到 ${JSON.stringify(quality)}`);
  }
  for (const key of ["constraintRecall", "failureRecall", "compressionRatio"]) {
    const value = quality[key];
    if (value !== null && typeof value !== "number") {
      throw new Error(`foldMarks[0].quality.${key} 必须是数字或 null，得到 ${JSON.stringify(value)}`);
    }
  }
  const dangling = g.foldMarks[0].dangling;
  if (dangling === null || typeof dangling !== "object") throw new Error("foldMarks[0].dangling 必须是对象");
  for (const key of ["residue", "candidates", "liveUnsettled", "fromBroken"]) {
    if (typeof dangling[key] !== "number") throw new Error(`foldMarks[0].dangling.${key} 必须是数字，得到 ${JSON.stringify(dangling[key])}`);
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
  // ★ 2026-11-01（C12）：为什么压要可观测 —— 溢出自救必须记成 context-overflow，
  //   不能和正常 pressure 混在一起（overflow 出现 = 压缩没跟上增长，是健康告警）。
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const mark = (readGraph(graphDir, "sess-overflow").foldMarks ?? []).at(-1);
  if (mark?.trigger !== "context-overflow") throw new Error(`溢出自救的 foldMark.trigger 必须是 context-overflow，实际 ${JSON.stringify(mark?.trigger)}`);
};

/**
 * ★ P0 死亡循环的端到端回归（2026-10-28 实机 session-5acafe42）。
 *
 * 生产故障链：v1.3.4 把 worldstate.hash() 的 { hash, mode, files } 对象直接写进节点 →
 *   summarize() 里 renderFacts() 对对象调 .slice() → TypeError →
 *   compactRegion 事务回滚 → 226 次压缩只成功 3 次 → 上下文涨到 66 万 token →
 *   模型 reasoning 退化自我重复 → 被 magpie 判循环中断。
 *
 * 这个测试走的是**真实路径**：磁盘上的旧 graph.json → #graph() → fromJSON 修复 →
 * summarize() → renderFacts()。纯函数单测（传字符串假数据）正是当初漏掉这条链的原因。
 */
tests["P0 回归：旧磁盘棋谱（worldHash 是对象）也能跑完 summarize，不再抛 .slice is not a function"] = async () => {
  const { Engine } = await load();
  const dir = nodePath.join(GRAPHS, "legacy");
  const sessDir = nodePath.join(dir, "sessions", "sess-legacy");
  nodeFs.mkdirSync(sessDir, { recursive: true });
  const legacy = {
    version: 1, sessionId: "sess-legacy", cwd: "C:/tmp", createdAt: 1, updatedAt: 1,
    nextNode: 3, nextEdge: 2,
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "不许动 prod 配置。把构建跑通。", constraints: ["不许动 prod 配置"], ts: 1 },
      n2: {
        id: "n2", kind: "agent", seq: 2, goal: "试改 prod 配置",
        // 实机脏数据：worldstate.hash() 的返回值被原样写进了节点
        worldHash: { hash: "deadbeefdeadbeefdeadbeefdeadbeef", mode: "stat", files: 21 },
        constraintHash: "pending", via: "e1", ts: 1,
      },
    },
    edges: {
      e1: {
        id: "e1", from: "n1", to: "n2", intent: "直接改 prod 配置", action: "edit(file_path=prod.yml)",
        result: "failure", verify: { kind: "exit", summary: "EACCES" },
        errorSnippet: "Error: EACCES: permission denied, open 'prod.yml'",
        evidence: { start: 1, end: 2 }, transposition: false, ts: 1,
      },
    },
    order: ["n1", "n2"],
    stateIndex: { "[object Object]/pending": "n2" },
    rootUserNodeIds: ["n1"], checkpointSeq: null, foldCount: 0, lastFoldTotalTokens: 0, foldMarks: [],
  };
  nodeFs.writeFileSync(nodePath.join(sessDir, "graph.json"), JSON.stringify(legacy, null, 1), "utf8");

  const session = makeSession({ id: "sess-legacy" });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  // 旧版在这一行抛 TypeError：renderFacts → `latest?.worldHash?.slice(0, 12)`
  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || !Array.isArray(out.summary) || out.summary.length === 0) throw new Error("summarize 没产出内容");

  // 硬事实块必须带着失败边与原因进了 prompt（这是压缩不丢死路的前提）
  const options = ctx.streamCalls.at(-1);
  if (!options) throw new Error("llm.stream 没被调用");
  const instruction = options.messages.at(-1)?.content?.[0]?.text ?? "";
  for (const needle of ["e1", "EACCES", "不许动 prod 配置"]) {
    if (!instruction.includes(needle)) throw new Error(`硬事实块里没有 ${needle}：\n${instruction.slice(0, 600)}`);
  }
  // 内存图的字段必须已被 fromJSON 收敛成字符串 + 索引重建（否则下一次 flush 又写回脏数据）
  const g = engine.graphs.get("sess-legacy");
  if (typeof g.nodes.n2.worldHash !== "string") throw new Error(`加载后 worldHash 仍是 ${typeof g.nodes.n2.worldHash}`);
  if (g.nodes.n2.constraintHash === "pending") throw new Error("加载后 constraintHash 仍是 pending（置换检测仍不可用）");
  if (g.stateIndex[`${g.nodes.n2.worldHash}/${g.nodes.n2.constraintHash}`] !== "n2") {
    throw new Error(`stateIndex 未重建：${JSON.stringify(g.stateIndex)}`);
  }
};

tests["摘要模型不可用 ⇒ 退回当前路由模型重试一次（实机 `magpie/ima/...` 未配置）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-summarizer-fallback" });
  const ctx = makeCtx({ failModels: new Set(["ima/deepseek-v4.1-flash"]) });
  const engine = new Engine(ctx, {
    graphDir,
    auto: false,
    summarizationProvider: "magpie",
    summarizationModel: "ima/deepseek-v4.1-flash",
  });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || !Array.isArray(out.summary) || out.summary.length === 0) throw new Error("退回后仍没产出摘要");
  if (ctx.streamCalls.length !== 2) throw new Error(`应调用两次（坏的 + 路由的），实际 ${ctx.streamCalls.length}`);
  if (ctx.streamCalls[0].model !== "ima/deepseek-v4.1-flash") throw new Error("第一次应先用配置的模型");
  if (ctx.streamCalls[1].model !== "m") throw new Error(`第二次应退回路由模型 m，实际 ${ctx.streamCalls[1].model}`);
  if (out.model !== "m") throw new Error(`返回的 model 应是实际使用的 m，实际 ${out.model}`);
  if (!ctx.warns.some((w) => w.includes("不可用") && w.includes("重试"))) throw new Error(`没有告警：${JSON.stringify(ctx.warns)}`);
};

tests["摘要模型不可用、且路由模型就是它 ⇒ 不重试，退回规则摘要"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-summarizer-same" });
  const ctx = makeCtx({ failModels: new Set(["m"]) }); // 路由模型就是 m
  const engine = new Engine(ctx, { graphDir, auto: false, summarizationProvider: "p", summarizationModel: "m" });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (ctx.streamCalls.length !== 1) throw new Error(`同一个模型不该重试，实际调用 ${ctx.streamCalls.length} 次`);
  if (!out || out.degraded !== "rules") throw new Error("hybrid 下应退回规则摘要");
};

tests["index.md 每次落盘都刷新（不再等 fold —— 它是模型读的入口）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-index-fresh" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });
  const dir = nodePath.join(graphDir, "sessions", "sess-index-fresh");

  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const before = nodeFs.readFileSync(nodePath.join(dir, "index.md"), "utf8");

  await ctx.emitRaw("session/event", session, assistantEvent("c9", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c9", "AssertionError: nope\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const after = nodeFs.readFileSync(nodePath.join(dir, "index.md"), "utf8");
  if (after === before) throw new Error("index.md 没有刷新（还停在首次写入的版本）");
  if (!after.includes("AssertionError")) throw new Error(`index.md 里没有新的失败原因：\n${after.slice(0, 400)}`);
};

tests["hybrid 模式下摘要模型全挂 ⇒ 退回规则摘要（fold 必须能落地）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-rules-fallback" });
  const ctx = makeCtx({ failModels: new Set(["m", "ima/deepseek-v4.1-flash"]) }); // 配置的和路由的都挂
  const engine = new Engine(ctx, {
    graphDir,
    auto: false,
    summarizationProvider: "magpie",
    summarizationModel: "ima/deepseek-v4.1-flash",
  });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || out.llmStreamCall !== false) throw new Error("应退回规则摘要（llmStreamCall=false）");
  if (out.degraded !== "rules") throw new Error(`degraded 标记缺失：${JSON.stringify(out.degraded)}`);
  // ★ 真实 DSH 抓到的坑：compaction/summary 事件的 provider/model 不允许 undefined
  if (typeof out.provider !== "string" || out.provider.length === 0) throw new Error(`provider 必须是字符串：${JSON.stringify(out.provider)}`);
  if (typeof out.model !== "string" || out.model.length === 0) throw new Error(`model 必须是字符串：${JSON.stringify(out.model)}`);
  const text = out.summary.map((b) => b.text).join("\n");
  if (!text.includes("## 目标")) throw new Error(`规则摘要结构不对：\n${text.slice(0, 300)}`);
  if (!ctx.warns.some((w) => w.includes("退回规则摘要"))) throw new Error(`没有告警：${JSON.stringify(ctx.warns)}`);
};

tests["llm 模式下摘要模型全挂 ⇒ 直接抛错（用户明确要模型输出，不悄悄降级）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-llm-strict" });
  const ctx = makeCtx({ failModels: new Set(["m", "ima/deepseek-v4.1-flash"]) });
  const engine = new Engine(ctx, {
    graphDir,
    auto: false,
    summaryMode: "llm",
    summarizationProvider: "magpie",
    summarizationModel: "ima/deepseek-v4.1-flash",
  });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  let threw = false;
  try {
    await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("llm 模式不该悄悄降级");
};

/**
 * ★ 2026-10-29 自环回归（端到端）。
 *
 * 事故：`worldstate.touch()` 收到的是单个路径字符串却按可迭代对象遍历 ⇒ 触碰集合
 * 变成十来个单字符 ⇒ `worldHash` 对所有步骤恒定 ⇒ `addAgentNode` 每步命中同一个
 * `stateIndex` 节点 ⇒ `step/end` 把边的 `to` 指回 `from`（自环）。
 * 全库 6,158/10,045 = 61.3%，并让 `dead` 判定 109/109 全错。
 *
 * 这条用例必须走 **keeper → engine → addAgentNode** 的真实路径：
 * 纯函数单测传的是手工构造的哈希，正是它把「同一 stateKey 连续命中」这个场景藏住的。
 */
tests["★ 自环回归（端到端）：连续只读 step 不产生 from === to 的边"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-selfloop" });
  const ctx = makeCtx();
  new Engine(ctx, { graphDir, auto: false });

  await ctx.emitRaw("session/event", session, userEvent("只读核对一遍，不要改任何文件。", 1));
  let seq = 2;
  for (let step = 1; step <= 3; step += 1) {
    const callId = `c${step}`;
    await ctx.emitRaw("session/event", session, assistantEvent(callId, "bash", { command: "ls -la" }, seq++));
    await ctx.emitRaw("session/event", session, resultEvent(callId, "a.txt\nb.txt\n[exit code: 0]", seq++));
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: seq++, data: { turn: 1, step } });
  }
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const g = readGraph(graphDir, "sess-selfloop");
  const agents = Object.values(g.nodes).filter((n) => n.kind === "agent");
  const selfLoops = Object.values(g.edges).filter((e) => e.from && e.to && e.from === e.to);
  if (selfLoops.length > 0) {
    throw new Error(
      `端到端产生 ${selfLoops.length} 条自环边（${selfLoops.map((e) => `${e.id}:${e.from}→${e.to}`).join(",")}）—— ` +
        "这就是热清单 dead 标记全错的根源",
    );
  }
  if (agents.length < 3) throw new Error(`3 个只读 step 应产生 3 个状态节点（每步一个新局面），实际 ${agents.length}`);
  const health = Object.values(g.edges).length / agents.length;
  if (health > 2) throw new Error(`边/节点 ${health.toFixed(2)} > 2：图在原地打转`);
};

/* ═════════════════════════ P7：仪表盘接线（task-58） ═════════════════════════
 *
 * task-54/55 复核指出「仪表盘无消费者」：renderLedger 已经返回 fallback/overBudgetBy，
 * 但 engine/doctor 都不读 —— 死开关。这里用假 DSH 证明三件事真的接上了：
 *   ① 生产调用 TRACE 是相对路径且能拼回 index.md；
 *   ② over-budget 触发 warn（含 overBudgetBy）并落盘指标；
 *   ③ impossible 触发 error 级日志。
 */

const P7_GRAPH = () => nodePath.join(GRAPHS, "p7-instrument");

/** 跑一次热清单注入，返回注入文本。 */
async function runLedgerInjection({ id, config = {} } = {}) {
  const { Engine } = await load();
  nodeFs.rmSync(P7_GRAPH(), { recursive: true, force: true });
  const session = makeSession({ id });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { auto: false, graphDir: P7_GRAPH(), ...config });
  await ctx.emitRaw("session/event", session, userEvent("必须保持接口不变。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "npm ERR! EACCES: permission denied\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  const claimed = [{ id: "claimed-p7", role: "user", content: [{ type: "text", text: "继续" }] }];
  const agent = { session, options: { provider: "p", model: "m" } };
  const decision = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 1, signal: undefined }, () => ({ kind: "enter", messages: claimed }));
  const text = decision.messages.filter((m) => m.source?.kind === "chess-context")[0]?.content[0]?.text ?? "";
  return { text, ctx, engine, session };
}

tests["P7-1 生产调用：TRACE 是 `sessions/<sid>/index.md`，不泄漏绝对路径"] = async () => {
  const { text } = await runLedgerInjection({ id: "sess-p7-trace" });
  if (!text.includes("LEARNED")) throw new Error(`没有注入热清单：\n${text}`);
  if (!text.includes("TRACE: sessions/sess-p7-trace/index.md")) throw new Error(`TRACE 不是相对路径：\n${text}`);
  if (/(?:[A-Za-z]:[\/]|\/d\/|\/Users\/|DeepSeek Harness)/.test(text.split("\n").find((l) => l.startsWith("TRACE:")) ?? "")) {
    throw new Error(`TRACE 泄漏绝对路径：${text.split("\n").find((l) => l.startsWith("TRACE:"))}`);
  }
  // 可配置：traceRoot 显式传空串 ⇒ 退回 `<sid>/index.md`（用来证明开关真的生效）
  const { text: bare } = await runLedgerInjection({ id: "sess-p7-bare", config: { hotLedgerTraceRoot: "" } });
  if (!bare.includes("TRACE: sess-p7-bare/index.md")) throw new Error(`traceRoot="" 应输出无前缀路径：\n${bare}`);
};

tests["P7-2 over-budget：warn 日志含 overBudgetBy，且指标落盘可查"] = async () => {
  const { text, ctx, engine } = await runLedgerInjection({ id: "sess-p7-over", config: { hotLedgerMaxTokens: 1 } });
  if (!text) throw new Error("预算 1 也必须交付清单（兜底超限，不是消失）");
  const warn = ctx.warns.find((w) => w.includes("over-budget"));
  if (!warn) throw new Error(`over-budget 必须打 warn，实际 warns=${JSON.stringify(ctx.warns)}`);
  if (!warn.includes("overBudgetBy=")) throw new Error(`warn 必须含 overBudgetBy：${warn}`);
  if (!warn.includes("budget=1")) throw new Error(`warn 必须含预算值：${warn}`);
  const stats = engine.getLedgerBudgetStats();
  if ((stats["over-budget"] ?? 0) < 1) throw new Error(`统计里必须有 over-budget：${JSON.stringify(stats)}`);
  if (stats.maxOverBudgetBy <= 0) throw new Error(`maxOverBudgetBy 必须 > 0：${JSON.stringify(stats)}`);
  const file = nodePath.join(P7_GRAPH(), "ledger-budget.json");
  if (!nodeFs.existsSync(file)) throw new Error(`指标文件没落盘：${file}`);
  const disk = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  if ((disk["over-budget"] ?? 0) < 1) throw new Error(`磁盘统计里必须有 over-budget：${JSON.stringify(disk)}`);
};

tests["P7-3 impossible：必须 error 级，不许静默"] = async () => {
  const { Engine, graphDir } = await load();
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir, auto: false, graphDir: P7_GRAPH() });
  const metrics = engine.consumeLedgerBudget(
    { text: "", tokens: 0, level: 5, fallback: "impossible", budgetMax: 500, overBudgetBy: 0 },
    { id: "sess-p7-impossible" },
  );
  if (metrics.fallback !== "impossible") throw new Error(`metrics.fallback=${metrics.fallback}`);
  const err = ctx.errors.find((e) => e.includes("impossible"));
  if (!err) throw new Error(`impossible 必须打 error，实际 errors=${JSON.stringify(ctx.errors)}`);
  if ((engine.getLedgerBudgetStats().impossible ?? 0) !== 1) throw new Error("统计里必须记 1 次 impossible");
};

tests["P7-4 doctor：展示 fallback 分布与最大 overBudgetBy；缺文件写「未采集」"] = async () => {
  const { execFileSync } = await import("node:child_process");
  const home = nodePath.join(GRAPHS, "p7-home");
  nodeFs.rmSync(home, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(home, "chess-context"), { recursive: true });
  const file = nodePath.join(home, "chess-context", "ledger-budget.json");
  nodeFs.writeFileSync(file, JSON.stringify({ none: 3, "over-budget": 2, impossible: 1, maxOverBudgetBy: 42, updatedAt: 1_800_000_000_000 }), "utf8");
  const doctor = nodePath.join(HERE, "..", "scripts", "doctor.mjs");
  const run = (env) => {
    try {
      const out = execFileSync(process.execPath, [doctor, "--json"], { encoding: "utf8", env: { ...process.env, DSH_HOME: env }, timeout: 30000 });
      return JSON.parse(out);
    } catch (err) {
      // doctor 有 error 时 exit 1，但 --json 仍会输出完整 JSON
      return JSON.parse(String(err.stdout ?? "{}"));
    }
  };
  const withStats = run(home);
  const check = withStats.checks.find((c) => c.name === "热清单预算（fallback）");
  if (!check) throw new Error(`doctor 缺少 fallback 检查项：${JSON.stringify(withStats.checks.map((c) => c.name))}`);
  if (!check.detail.includes("none=3") || !check.detail.includes("over-budget=2") || !check.detail.includes("impossible=1")) {
    throw new Error(`分布不对：${check.detail}`);
  }
  if (!check.detail.includes("最大 overBudgetBy=42")) throw new Error(`最大 overBudgetBy 缺失：${check.detail}`);
  if (check.status !== "error") throw new Error(`有 impossible 时必须 error，实际 ${check.status}`);
  // ★ 2026-11-01（候选 #2）：旧版 ledger-budget.json 没有 provenanceMin ⇒ 必须写「未采集」，
  //   不许把它当成 0（那会把「没采集」误报成「出处全丢了」）。
  if (!check.detail.includes("provenanceMin=未采集")) throw new Error(`旧文件缺字段必须写「未采集」：${check.detail}`);
  // 新格式：覆盖率掉下来 ⇒ warn + 打印下限与掉档次数
  nodeFs.writeFileSync(
    file,
    JSON.stringify({ none: 3, "over-budget": 0, impossible: 0, maxOverBudgetBy: 0, provenanceMin: 0.5, provenanceLow: 2, updatedAt: 1_800_000_000_000 }),
    "utf8",
  );
  const withProv = run(home);
  const provCheck = withProv.checks.find((c) => c.name === "热清单预算（fallback）");
  if (!provCheck) throw new Error("doctor 缺少 fallback 检查项（新格式）");
  if (!provCheck.detail.includes("provenanceMin=0.5")) throw new Error(`覆盖率下限缺失：${provCheck.detail}`);
  if (!provCheck.detail.includes("<1 共 2 次")) throw new Error(`掉档次数缺失：${provCheck.detail}`);
  if (provCheck.status !== "warn") throw new Error(`覆盖率下降必须 warn，实际 ${provCheck.status}`);
  // 缺文件 ⇒ 明确「未采集」
  nodeFs.rmSync(file, { force: true });
  const empty = run(home);
  const emptyCheck = empty.checks.find((c) => c.name === "热清单预算（fallback）");
  if (!emptyCheck || !emptyCheck.detail.includes("未采集")) throw new Error(`缺文件必须写「未采集」：${JSON.stringify(emptyCheck)}`);
};

tests["P7-5 出处覆盖率：engine 累计 provenanceMin / provenanceLow，日志只在掉档时警告"] = async () => {
  const { Engine } = await load();
  const graphDir = nodePath.join(GRAPHS, "p7-provenance");
  nodeFs.rmSync(graphDir, { recursive: true, force: true });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { auto: false, graphDir });
  const led = (coverage, level = 0) => ({ text: "x", tokens: 10, level, fallback: "none", budgetMax: 500, overBudgetBy: 0, provenanceCoverage: coverage });
  engine.consumeLedgerBudget(led(1), { id: "sess-prov" });
  if (ctx.warns.some((w) => w.includes("provenance="))) throw new Error(`覆盖率 1 时不许警告：${JSON.stringify(ctx.warns)}`);
  engine.consumeLedgerBudget(led(0.5, 2), { id: "sess-prov" });
  const stats = engine.getLedgerBudgetStats();
  if (stats.provenanceMin !== 0.5) throw new Error(`provenanceMin 必须是 0.5，实际 ${stats.provenanceMin}`);
  if (stats.provenanceLow !== 1) throw new Error(`provenanceLow 必须是 1，实际 ${stats.provenanceLow}`);
  if (!ctx.warns.some((w) => w.includes("provenance=0.5"))) throw new Error(`掉档必须打 warn 且带数值，实际 warns=${JSON.stringify(ctx.warns)}`);
  // 落盘：doctor 读的就是这个文件
  const disk = JSON.parse(nodeFs.readFileSync(nodePath.join(graphDir, "ledger-budget.json"), "utf8"));
  if (disk.provenanceMin !== 0.5 || disk.provenanceLow !== 1) throw new Error(`落盘口径不对：${JSON.stringify(disk)}`);
  // 旧文件（没有该字段）首累计必须从 1 起算 —— 不许把「没采集」当成 0
  const { mod } = await load();
  const old = mod.accumulateLedgerBudget({ none: 5 }, { fallback: "none", overBudgetBy: 0, provenanceCoverage: 1 }, 1);
  // ★ C44：底线超预算的 over-budget 单独计数（设计内归因）
  const floorStats = mod.accumulateLedgerBudget({}, {
    fallback: "over-budget",
    overBudgetBy: 40,
    budgetMax: 500,
    unyieldingTokens: 520,
    provenanceCoverage: 1,
  });
  if (floorStats.budgetFloorOver !== 1) throw new Error(`底线超预算必须计 1，实际 ${floorStats.budgetFloorOver}`);
  const notFloor = mod.accumulateLedgerBudget({}, {
    fallback: "over-budget",
    overBudgetBy: 40,
    budgetMax: 500,
    unyieldingTokens: 200,
    provenanceCoverage: 1,
  });
  if (notFloor.budgetFloorOver !== undefined) throw new Error(`不是底线超预算时不许计数，实际 ${notFloor.budgetFloorOver}`);
  // ★ C48：超预算按会话归因（有界前 8）
  const bySession = mod.accumulateLedgerBudget({}, { fallback: "over-budget", overBudgetBy: 20, budgetMax: 500, provenanceCoverage: 1 }, 1, "session-a");
  mod.accumulateLedgerBudget(bySession, { fallback: "over-budget", overBudgetBy: 20, budgetMax: 500, provenanceCoverage: 1 }, 2, "session-a");
  mod.accumulateLedgerBudget(bySession, { fallback: "over-budget", overBudgetBy: 20, budgetMax: 500, provenanceCoverage: 1 }, 3, "session-b");
  if (bySession.overBySession["session-a"] !== 2) throw new Error(`session-a 应计 2，实际 ${JSON.stringify(bySession.overBySession)}`);
  if (bySession.overBySession["session-b"] !== 1) throw new Error(`session-b 应计 1，实际 ${JSON.stringify(bySession.overBySession)}`);
  const noneCase = mod.accumulateLedgerBudget({}, { fallback: "none", overBudgetBy: 0, budgetMax: 500, provenanceCoverage: 1 }, 1, "session-c");
  if (noneCase.overBySession !== undefined) throw new Error("非超预算不许记会话归因");
  // ★ C65：TRACE 为预算降级的次数必须被统计（traceRecent 不再是写入即弃的字段）
  const traced = mod.accumulateLedgerBudget({}, { fallback: "none", overBudgetBy: 0, provenanceCoverage: 1, traceRecent: "dropped-for-budget" });
  if (traced.traceDropped !== 1) throw new Error(`TRACE 降级应计 1，实际 ${traced.traceDropped}`);
  const notTraced = mod.accumulateLedgerBudget({}, { fallback: "none", overBudgetBy: 0, provenanceCoverage: 1, traceRecent: "full" });
  if (notTraced.traceDropped !== undefined) throw new Error("未降级不许计数");
  // ★ C67：最小清单（zero-failure 路径）的渲染次数必须被统计
  const mini = mod.accumulateLedgerBudget({}, { fallback: "none", overBudgetBy: 0, provenanceCoverage: 1, minimal: true });
  if (mini.minimalRenders !== 1) throw new Error(`最小清单应计 1，实际 ${mini.minimalRenders}`);
  const notMini = mod.accumulateLedgerBudget({}, { fallback: "none", overBudgetBy: 0, provenanceCoverage: 1 });
  if (notMini.minimalRenders !== undefined) throw new Error("非最小清单不许计数");
  // ★ C90：注入渲染失败必须能被统计（否则「本该注入却没注入」在指标里完全消失）
  if (mod.injectionErrorDelta({ action: "skip", reason: "error:boom" }) !== 1) throw new Error("error: 前缀的 skip 必须计 1");
  if (mod.injectionErrorDelta({ action: "skip", reason: "no-ledger" }) !== 0) throw new Error("普通 skip 不许计错");
  if (mod.injectionErrorDelta({ action: "append" }) !== 0) throw new Error("成功注入不许计错");
  if (mod.injectionErrorDelta(null) !== 0) throw new Error("null 不许抛/计数");
  // ★ C91：跳过原因分布（error: 交给 renderErrors，不在这里重复记）
  if (mod.skipReasonKey({ action: "skip", reason: "identical" }) !== "identical") throw new Error("普通跳过要记原因");
  if (mod.skipReasonKey({ action: "skip", reason: "error:boom" }) !== null) throw new Error("error: 不许重复记");
  if (mod.skipReasonKey({ action: "append" }) !== null) throw new Error("成功注入不记原因");
  // ★ C219：注入动作（append 缓存友好 / replace 改写历史中间那条 —— 后者让前缀缓存作废）
  if (mod.injectActionKey({ action: "append" }) !== "append") throw new Error("append 要计入动作分布");
  if (mod.injectActionKey({ action: "replace" }) !== "replace") throw new Error("replace 要计入动作分布");
  if (mod.injectActionKey({ action: "skip", reason: "identical" }) !== null) throw new Error("skip 由 skipReasons 管，不重复计");
  if (mod.injectActionKey(null) !== null) throw new Error("null 不许抛");
  const bumped = ["a", "a", "b"].reduce((m, k) => mod.bumpSkipReason(m, k), {});
  if (bumped.a !== 2 || bumped.b !== 1) throw new Error(`分布累加错：${JSON.stringify(bumped)}`);
  // 有界：超过 8 个键后新键一律归 other
  const many = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"].reduce((m, k) => mod.bumpSkipReason(m, k), {});
  if (many.k9 !== undefined || many.other !== 1) throw new Error(`有界归并错：${JSON.stringify(many)}`);
  if (many.k1 !== 1) throw new Error("已有键仍要正常累加");
  // ★ C49：已列全失败边仍超 ⇒ budgetIrreducible（设计内）；还有更省形式（shown < count）⇒ 不计
  const irre = mod.accumulateLedgerBudget({}, {
    fallback: "over-budget", overBudgetBy: 30, budgetMax: 500, unyieldingTokens: 300,
    shownFailures: 7, failureCount: 7, provenanceCoverage: 1,
  }, 1, "session-d");
  if (irre.budgetIrreducible !== 1) throw new Error(`列全失败边仍超必须计 1，实际 ${irre.budgetIrreducible}`);
  const reducible = mod.accumulateLedgerBudget({}, {
    fallback: "over-budget", overBudgetBy: 30, budgetMax: 500, unyieldingTokens: 100,
    shownFailures: 10, failureCount: 25, provenanceCoverage: 1,
  }, 1, "session-e");
  if (reducible.budgetIrreducible !== undefined) throw new Error("shown < count 时不许计不可约（还有更省形式）");
  if (old.provenanceMin !== 1) throw new Error(`旧文件首累计 provenanceMin 必须是 1，实际 ${old.provenanceMin}`);
};

tests["C4 折叠摘要机械追加「最近访问的文件」（零模型调用、只进摘要）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c4-touched");
  const session = makeSession({ id: "sess-c4-touched" });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  await ctx.emitRaw("session/event", session, userEvent("检查 src/a.mjs 和 src/b.mjs 的实现。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "read", { file_path: "src/a.mjs" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "const a = 1;", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  await ctx.emitRaw("session/event", session, assistantEvent("c2", "edit", { file_path: "src/b.mjs" }, 5));
  await ctx.emitRaw("session/event", session, resultEvent("c2", "ok", 6));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 7, data: { turn: 1, step: 2 } });
  engine._chessActiveRange = { start: 2, end: 7 };
  try {
    const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
    const text = out.summary.map((block) => String(block.text ?? "")).join("\n");
    if (!text.includes("最近访问的文件")) throw new Error(`摘要必须含「最近访问的文件」机械段：\n${text}`);
    if (!text.includes("src/a.mjs")) throw new Error(`摘要必须记住读过的 a.mjs：\n${text}`);
    if (!text.includes("src/b.mjs")) throw new Error(`摘要必须记住改过的 b.mjs：\n${text}`);
    if (!/\(seq \d+-\d+\)/.test(text)) throw new Error(`每个文件必须带 seq 出处（可回溯）：\n${text}`);
  } finally {
    engine._chessActiveRange = null;
  }
};

/* ═════════════ S8 首折削峰（task-170） ═════════════ */

/** 造一个可 fold 的会话：system + n 条 user。 */
function s8Session(id, n = 19) {
  const session = makeSession({ id });
  for (let i = 0; i < n; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  return session;
}

/** 200K 窗口、默认 headroom ⇒ 首折阈值 60K（0.30）、正常阈值 90K（0.45）。 */
const S8_WINDOW = 200_000;
const S8_FIRST = S8_WINDOW * 0.3;
const S8_NORMAL = S8_WINDOW * 0.45;

tests["S8-1 首折在 firstFoldRatio（0.30）触发：61K 就 fold，不必等到 90K"] = async () => {
  const { Engine, graphDir } = await load();
  const session = s8Session("sess-s8-first");
  const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => S8_FIRST + 1_000 });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error(`首折应在 ${S8_FIRST} 触发（实际没有 fold）`);
  if (engine.compactCalls.length !== 1) throw new Error(`compactRegion 调用 ${engine.compactCalls.length} 次`);
  const g = readGraph(graphDir, "sess-s8-first");
  if (g.foldCount !== 1) throw new Error(`foldCount 应为 1，实际 ${g.foldCount}`);
};

tests["S8-2 首折之后回到 thresholdRatio（0.45）：80K 不 fold，91K 才 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const session = s8Session("sess-s8-second", 19);
  let total = S8_FIRST + 1_000;
  const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => total });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const first = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!first) throw new Error("第一次 fold 应当发生（首折 60K）");
  // 首折之后：再补节点，让 80K 有内容可压，但阈值已回到 90K
  for (let i = 0; i < 10; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "y" }] });
  total = S8_FIRST + 20_000; // 80K：高于首折阈值、低于正常阈值
  const mid = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (mid !== null) throw new Error(`第二次（80K）不该 fold —— 首折之后必须回到 90K，实际 fold 了`);
  total = S8_NORMAL + 1_000; // 91K
  const second = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!second) throw new Error("第三次（91K）应当 fold（正常阈值 90K）");
  // graph.json 是「上一回合基线快照」（落后一回合），所以持久面用 compactCalls 断言
  if (engine.compactCalls.length !== 2) throw new Error(`compactRegion 应 2 次（首折 + 91K），实际 ${engine.compactCalls.length}`);
};

tests["S8-3 firstFoldRatio=0 关闭：61K 不 fold、91K 才 fold（与旧行为一致）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = s8Session("sess-s8-off");
  let total = S8_FIRST + 1_000;
  const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => total });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, firstFoldRatio: 0 });
  const early = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (early !== null) throw new Error("firstFoldRatio=0 时 61K 不该 fold");
  total = S8_NORMAL + 1_000;
  const later = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!later) throw new Error("91K 应当 fold（0.45）");
};

tests["S8-4 阈值边界：恰好等于首折阈值就 fold，少 1 token 不 fold"] = async () => {
  const { Engine, graphDir } = await load();
  // 少 1 token
  const sessionA = s8Session("sess-s8-edge-a");
  const ctxA = makeCtx({ window: S8_WINDOW, measureTotal: () => S8_FIRST - 1 });
  const engineA = new Engine(ctxA, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const a = await engineA.compactIfNeeded({ session: sessionA, options: {} }, "pressure", undefined);
  if (a !== null) throw new Error(`少 1 token（${S8_FIRST - 1}）不该 fold`);
  // 恰好等于
  const sessionB = s8Session("sess-s8-edge-b");
  const ctxB = makeCtx({ window: S8_WINDOW, measureTotal: () => S8_FIRST });
  const engineB = new Engine(ctxB, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const b = await engineB.compactIfNeeded({ session: sessionB, options: {} }, "pressure", undefined);
  if (!b) throw new Error(`恰好等于阈值（${S8_FIRST}）必须 fold（判定是 total < threshold 才跳过）`);
};

tests["S8-5 fold 次数最多 +1（首折提前一次）：之后的判定点与关闭 S8 完全一致"] = async () => {
  const { Engine, graphDir } = await load();
  const run = async (id, config) => {
    const session = s8Session(id, 19);
    let total = 0;
    const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => total });
    const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, ...config });
    const points = [];
    for (const step of [50_000, 61_000, 80_000, 91_000, 150_000, 300_000]) {
      total = step;
      for (let i = 0; i < 10; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "z" }] });
      const r = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
      if (r) points.push(step);
    }
    return points;
  };
  const withS8 = await run("sess-s8-count-on", {});
  const withoutS8 = await run("sess-s8-count-off", { firstFoldRatio: 0 });
  if (withS8.length < 1) throw new Error("至少应当有一次 fold");
  // 首折削峰的全部效果 = 第一次 fold 从 90K 提前到 60K，**最多多一次**；
  // 之后的判定点必须与关掉 S8 时逐点相同（否则就是「削峰把 fold 变密了」）。
  if (withS8.length > withoutS8.length + 1) throw new Error(`首折削峰让 fold 次数变多了：${withS8.length} > ${withoutS8.length} + 1`);
  const restWith = withS8.slice(1);
  if (JSON.stringify(restWith) !== JSON.stringify(withoutS8)) {
    throw new Error(`首折之后的判定点必须与关闭 S8 一致：开=${JSON.stringify(restWith)} 关=${JSON.stringify(withoutS8)}`);
  }
  if (withS8[0] !== 61_000) throw new Error(`第一次 fold 应在 61K（首折阈值 60K），实际 ${withS8[0]}`);
  if (withoutS8[0] !== 91_000) throw new Error(`关掉 S8 时第一次 fold 应在 91K（0.45），实际 ${withoutS8[0]}`);
};

tests["S8-6 首折阈值 <= retainTokens 时回退正常阈值（不许让压缩后端起不来）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = s8Session("sess-s8-guard");
  let total = S8_FIRST + 1_000;
  const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => total });
  // retainRatio 0.16 ⇒ retainTokens = 0.16×195904 ≈ 31K；firstFoldRatio 0.05 ⇒ 10K < retainTokens
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.16, firstFoldRatio: 0.05 });
  const early = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (early !== null) throw new Error("首折阈值低于 retainTokens 时必须回退到正常阈值（61K 不该 fold）");
  total = S8_NORMAL + 1_000;
  const later = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!later) throw new Error("回退后 91K 应当 fold");
};

tests["S8-7 溢出自救不受首折影响（overflow 的 threshold 恒为 0）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = s8Session("sess-s8-overflow");
  const ctx = makeCtx({ window: S8_WINDOW, measureTotal: () => 1_000 });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 10_000_000, minFoldTokens: 10_000_000 });
  const result = await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
  if (!result) throw new Error("溢出自救必须能压（与 firstFoldRatio 无关）");
};

/* ═════════════ S3 降级可见 / S4 minFold 缩放（task-186） ═════════════ */

/** 造一个「有失败边、可 fold」的会话（19 个 user 节点 + 1 条失败边）。 */
async function s34Session(ctx, id, { tokensPerNode = 7000 } = {}) {
  const session = makeSession({ id, tokensPerNode });
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  return session;
}

tests["S3-3 hybrid 摘要模型挂掉 ⇒ 规则摘要并把 lastFoldMode=rules 写进图（auto 路径同源）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "s3-degraded");
  const session = makeSession({ id: "sess-s3-degraded" });
  const ctx = makeCtx({ failModels: new Set(["m"]) });
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || out.degraded !== "rules") throw new Error("hybrid 下模型挂了应退回规则摘要");
  const g = engine.graphs.get("sess-s3-degraded");
  if (g?.lastFoldMode !== "rules") throw new Error(`内存图 lastFoldMode 应为 rules，实际 ${JSON.stringify(g?.lastFoldMode)}`);
  if (g?.lastFoldDegraded !== true) throw new Error("内存图 lastFoldDegraded 应为 true");
  // 落盘（回合边界 flush）后从 graph.json 读回，字段必须还在
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const disk = readGraph(dir, "sess-s3-degraded");
  if (disk.lastFoldMode !== "rules") throw new Error(`graph.json 里 lastFoldMode 应为 rules，实际 ${JSON.stringify(disk.lastFoldMode)}`);
  if (disk.lastFoldDegraded !== true) throw new Error("graph.json 里 lastFoldDegraded 应为 true");
};

tests["S3-4 正常 hybrid 摘要 ⇒ lastFoldMode=hybrid，热清单不显示降级提示"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-s3-normal" });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "s3-normal"), auto: false });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });

  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || out.llmStreamCall !== true) throw new Error("正常 hybrid 必须走模型（llmStreamCall=true）");
  const g = engine.graphs.get("sess-s3-normal");
  if (g?.lastFoldMode !== "hybrid") throw new Error(`lastFoldMode 应为 hybrid，实际 ${JSON.stringify(g?.lastFoldMode)}`);
  if (g?.lastFoldDegraded !== false) throw new Error("lastFoldDegraded 应为 false");

  const agent = { session, options: {} };
  const claimed = [{ id: "claimed-s3", role: "user", content: [{ type: "text", text: "继续" }] }];
  const decision = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 9 }, () => ({ kind: "enter", messages: claimed }));
  const injected = decision.messages.filter((m) => m.source?.kind === "chess-context").map((m) => m.content[0].text).join("\n");
  if (injected.includes("上次摘要是规则生成")) throw new Error(`正常 hybrid 摘要后的热清单不许带降级提示：\n${injected.slice(0, 240)}`);
};

tests["S3-5 规则摘要之后的热清单固定带「⚠ 上次摘要是规则生成」且 ≤500 tokens"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-s3-ledger" });
  const ctx = makeCtx({ failModels: new Set(["m"]) });
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "s3-ledger"), auto: false });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。必须保持 API 不变。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out || out.degraded !== "rules") throw new Error("前置：应退回规则摘要");

  const agent = { session, options: {} };
  const claimed = [{ id: "claimed-s3b", role: "user", content: [{ type: "text", text: "继续" }] }];
  const decision = await ctx.waterfall("agent/pre-step", { agent, messages: claimed, step: 9 }, () => ({ kind: "enter", messages: claimed }));
  const texts = decision.messages.filter((m) => m.source?.kind === "chess-context").map((m) => m.content[0].text);
  if (texts.length !== 1) throw new Error(`应注入 1 条清单，实际 ${texts.length}`);
  if (!texts[0].includes("⚠ 上次摘要是规则生成（无模型润色）")) throw new Error(`规则摘要后的热清单必须带提示：\n${texts[0].slice(0, 240)}`);
  const { estimateTokens } = await import("../src/rooms/ledger.mjs");
  const tokens = estimateTokens(texts[0]);
  if (tokens > 500) throw new Error(`带提示行的热清单 ${tokens} tokens 超预算`);
  // 清单里同一条提示只出现一次（固定一行，不重复）
  const count = texts[0].split("上次摘要是规则生成").length - 1;
  if (count !== 1) throw new Error(`提示行应恰好 1 次，实际 ${count}`);
};

tests["S4-1 200K 窗口：minFold 默认缩放到 16000 —— 12000 的可压量不再触发 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const build = async (id) => {
    const ctx = makeCtx({ window: 200_000, measureTotal: () => 100_000 });
    const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, id), auto: false, growthFloorTokens: 0, retainRatio: 0.1 });
    const session = makeSession({ id, tokensPerNode: 2_000 });
    for (let i = 0; i < 16; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
    return { engine, session, ctx };
  };
  // 默认（缩放 16000）：可压 6 节点 × 2000 = 12000 < 16000 ⇒ 不 fold
  const a = await build("sess-s4-scaled");
  const scaled = await a.engine.compactIfNeeded({ session: a.session, options: {} }, "pressure", undefined);
  if (scaled !== null) throw new Error("默认缩放到 16000 后，12000 的可压量不该 fold（旧的 8000 会 fold）");
  // 显式 8000 ⇒ 立即 fold（显式配置优先）
  const b = await build("sess-s4-explicit");
  const explicitEngine = new Engine(b.ctx, { graphDir: nodePath.join(graphDir, "sess-s4-explicit"), auto: false, growthFloorTokens: 0, minFoldTokens: 9000, retainRatio: 0.1 });
  const explicit = await explicitEngine.compactIfNeeded({ session: b.session, options: {} }, "pressure", undefined);
  if (!explicit) throw new Error("显式 minFoldTokens: 9000 时必须 fold（显式配置优先）");
};

tests["S4-2 1M 窗口：minFold 缩放到 80000 —— 20000 的可压量不 fold；显式 8000 才 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const build = async (id) => {
    const ctx = makeCtx({ window: 1_000_000, measureTotal: () => 320_000 });
    const session = makeSession({ id, tokensPerNode: 2_000 });
    for (let i = 0; i < 60; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
    return { ctx, session };
  };
  const a = await build("sess-s4-1m");
  const engineA = new Engine(a.ctx, { graphDir: nodePath.join(graphDir, "sess-s4-1m"), auto: false, growthFloorTokens: 0, retainRatio: 0.1 });
  const scaled = await engineA.compactIfNeeded({ session: a.session, options: {} }, "pressure", undefined);
  if (scaled !== null) throw new Error("1M 窗口默认 minFold=80000 时，20000 的可压量不该 fold");
  const b = await build("sess-s4-1m-explicit");
  const engineB = new Engine(b.ctx, { graphDir: nodePath.join(graphDir, "sess-s4-1m-explicit"), auto: false, growthFloorTokens: 0, minFoldTokens: 9000, retainRatio: 0.1 });
  const explicit = await engineB.compactIfNeeded({ session: b.session, options: {} }, "pressure", undefined);
  if (!explicit) throw new Error("1M 窗口 + 显式 9000 必须 fold");
};

tests["S4-3 50K 小窗口：缩放值仍是 8000（max(8000, 4000)），照常 fold"] = async () => {
  const { Engine, graphDir } = await load();
  const ctx = makeCtx({ window: 50_000, measureTotal: () => 20_000 });
  const session = makeSession({ id: "sess-s4-small", tokensPerNode: 2_000 });
  for (let i = 0; i < 20; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "sess-s4-small"), auto: false, growthFloorTokens: 0, headroomTokens: 4096, retainRatio: 0.1 });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("50K 窗口下 minFold 仍是 8000，34000 的可压量必须 fold（不许被缩放误伤）");
};

tests["S4-5 headroom 按窗口封顶：100K 窗口阈值回到 45%，64K 窗口不再抛错"] = async () => {
  const { Engine, graphDir } = await load();
  // 100K 窗口、占用 30K：旧代码 headroom=65536 把阈值压到 26272（26.3%）⇒ 会误压；
  // 修好后 headroom 封顶为 messageBudget×25% ⇒ 阈值 45000（45%）⇒ 不该 fold。
  const ctx = makeCtx({ window: 100_000, measureTotal: () => 30_000 });
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "s4-5-small"), auto: false, growthFloorTokens: 0, retainRatio: 0.1 });
  const session = makeSession({ id: "sess-s4-small", tokensPerNode: 500 });
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const folded = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (folded !== null) throw new Error("100K 窗口 + 30K 占用：阈值应是 45%（45K），不该 fold（旧代码的绝对 headroom 会压到 26K）");
  // 64K 窗口：旧代码 messageBudget(57344) − headroom(65536) < 0 ⇒ 直接抛错（压缩完全不可用）；
  // 修好后 headroom 按窗口封顶 ⇒ 正常返回 null。
  const ctx2 = makeCtx({ window: 64_000, measureTotal: () => 10_000 });
  const engine2 = new Engine(ctx2, { graphDir: nodePath.join(graphDir, "s4-5-tiny"), auto: false, growthFloorTokens: 0, retainRatio: 0.1 });
  const session2 = makeSession({ id: "sess-s4-tiny", tokensPerNode: 500 });
  for (let i = 0; i < 8; i += 1) session2.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  let threw = null;
  try {
    await engine2.compactIfNeeded({ session: session2, options: {} }, "pressure", undefined);
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  if (threw !== null) throw new Error(`64K 窗口不该抛错（headroom 应按窗口封顶），实际抛了：${threw}`);
};

tests["S4-4 overflow 路径不受缩放影响（spec.minFoldTokens 缺省时回落配置值）"] = async () => {
  const { Engine, graphDir } = await load();
  const ctx = makeCtx({ window: 200_000, measureTotal: () => 1_000 });
  const session = makeSession({ id: "sess-s4-overflow", tokensPerNode: 2_000 });
  for (let i = 0; i < 20; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "sess-s4-overflow"), auto: false, growthFloorTokens: 10_000_000, minFoldTokens: 10_000_000 });
  const result = await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
  if (!result) throw new Error("溢出自救必须能压（minFold 缩放不该拦住 overflow）");
};

/* ═════════════ P2-2 fold 可观测（task-192） ═════════════ */

/** 造一个可 fold 的会话并给 graph 记上失败边（让 selectRange 有东西可压）。 */
async function p22Session(ctx, id, n = 19) {
  const session = makeSession({ id });
  for (let i = 0; i < n; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  return session;
}

tests["P2-2-1 foldMark 追加 route/fallback/ms/usage，并记 foldCount"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "p22-fields");
  // 让桩 provider 回一次 usage —— 才能断言 foldMark.usage 真的把摘要 usage 记下来了
  const ctx = makeCtx({ measureTotal: () => 300_000, usage: { inputTokens: 1200, outputTokens: 300 } });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-p22");
  // 真实流程里 fold 的 compactRegion 会调 summarize；stub 不会 ⇒ 先手动调一次，让 _lastSummary* 有值
  await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当 fold");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 标量 foldMarks 靠 idle 全量 flush 提交
  const g = readGraph(dir, "sess-p22");
  const mark = (g.foldMarks ?? []).at(-1);
  if (!mark) throw new Error("没有 foldMark");
  if (mark.foldCount !== 1) throw new Error(`foldCount 应为 1，实际 ${mark.foldCount}`);
  if (!mark.route || mark.route.provider !== "p" || mark.route.model !== "m") throw new Error(`route 不对：${JSON.stringify(mark.route)}`);
  if (mark.fallback !== null) throw new Error(`正常 hybrid 的 fallback 应为 null，实际 ${JSON.stringify(mark.fallback)}`);
  if (typeof mark.ms !== "number" || mark.ms < 0) throw new Error(`ms 应为非负数字，实际 ${JSON.stringify(mark.ms)}`);
  if (mark.usage === null || typeof mark.usage !== "object") throw new Error(`usage 应记录本次摘要 usage，实际 ${JSON.stringify(mark.usage)}`);
  if (typeof mark.usage.inputTokens !== "number" && typeof mark.usage.outputTokens !== "number") {
    throw new Error(`usage 必须带 inputTokens/outputTokens：${JSON.stringify(mark.usage)}`);
  }
  // ★ 2026-11-01（保真度 L1）：每次 fold 必须留下「约束/失败边有没有留住」的机器判据。
  // ★ 2026-11-01（C12）：常规 fold 必须记触发原因（pressure），与溢出自救区分开
  if (mark.trigger !== "pressure") throw new Error(`常规 fold 的 trigger 必须是 pressure，实际 ${JSON.stringify(mark.trigger)}`);
  // ★ 2026-11-02（C24）：必须记可寻址闭包（本次折叠覆盖了图里哪些节点/边）
  if (!mark.closure || typeof mark.closure !== "object") throw new Error(`foldMark 必须带 closure（可寻址闭包）：${JSON.stringify(mark.closure)}`);
  if (typeof mark.closure.nodes !== "number" || typeof mark.closure.edges !== "number") {
    throw new Error(`closure 必须带 nodes/edges 计数：${JSON.stringify(mark.closure)}`);
  }
  // ★ 2026-11-02（C31）：必须记折叠边界完整性（切点是否落在工具调用中间 = openAtEnd 应为 0）
  if (!mark.boundary || typeof mark.boundary !== "object") throw new Error(`foldMark 必须带 boundary：${JSON.stringify(mark.boundary)}`);
  if (typeof mark.boundary.openAtEnd !== "number" || typeof mark.boundary.unsettled !== "number") {
    throw new Error(`boundary 必须带 openAtEnd/unsettled 计数：${JSON.stringify(mark.boundary)}`);
  }
  if (mark.boundary.openAtEnd !== 0) throw new Error(`正常 fold 的切点不许落在工具调用中间，实际 openAtEnd=${mark.boundary.openAtEnd}`);
  if (!mark.quality || typeof mark.quality !== "object") throw new Error(`foldMark 必须带 quality（保真度 L1）：${JSON.stringify(mark)}`);
  if (mark.quality.constraintRecall !== 1) throw new Error(`constraintRecall 应恒为 1，实际 ${mark.quality.constraintRecall}（缺：${JSON.stringify(mark.quality.missingConstraints)}）`);
  if (!(mark.quality.failureRecall >= 0 && mark.quality.failureRecall <= 1)) {
    throw new Error(`failureRecall 必须是 0–1，实际 ${mark.quality.failureRecall}`);
  }
  if (typeof mark.quality.expectedFailures !== "number" || typeof mark.quality.expectedConstraints !== "number") {
    throw new Error(`quality 必须带期望条数：${JSON.stringify(mark.quality)}`);
  }
  if (!(mark.quality.summaryTokens > 0)) throw new Error(`quality.summaryTokens 必须 > 0，实际 ${mark.quality.summaryTokens}`);
  if (mark.quality.shadowedTokens === null || mark.quality.shadowedTokens <= 0) throw new Error(`quality.shadowedTokens 必须来自本次 fold 区间，实际 ${mark.quality.shadowedTokens}`);
  if (mark.quality.compressionRatio === null || !(mark.quality.compressionRatio > 0)) {
    throw new Error(`有 shadowedTokens + summaryTokens 时必须能算 compressionRatio，实际 ${mark.quality.compressionRatio}`);
  }
  // ★ 2026-11-01（C7）：compressionRatio 必须严格等于 shadowedTokens / summaryTokens（四舍五入两位）——
  //   不许出现「比值和两个源数对不上」的指标（第 2 轮 provenanceCoverage 口径错误的同类问题）。
  const expectedRatio = Math.round((mark.quality.shadowedTokens / mark.quality.summaryTokens) * 100) / 100;
  if (mark.quality.compressionRatio !== expectedRatio) {
    throw new Error(`compressionRatio 必须 = shadowed/summary = ${expectedRatio}，实际 ${mark.quality.compressionRatio}`);
  }
  // ★ 2026-11-01（C10）：hybrid 路径必须记录「纯模型输出」的约束召回（不含机械追加段）——
  //   它是「如果去掉机械兜底，模型会丢多少约束」的唯一观测，必须能回答。
  if (typeof mark.quality.modelConstraintRecall !== "number") {
    throw new Error(`hybrid fold 必须记录 modelConstraintRecall，实际 ${JSON.stringify(mark.quality.modelConstraintRecall)}`);
  }
  if (!(mark.quality.modelConstraintRecall >= 0 && mark.quality.modelConstraintRecall <= 1)) {
    throw new Error(`modelConstraintRecall 必须在 0–1，实际 ${mark.quality.modelConstraintRecall}`);
  }
};

tests["P2-2-2 规则降级（模型全挂）⇒ foldMark.fallback=rules"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "p22-degraded");
  const ctx = makeCtx({ measureTotal: () => 300_000, failModels: new Set(["m"]) });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-p22-degraded");
  await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("模型挂掉时也必须 fold 成功（规则兜底）");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 标量 foldMarks 靠 idle 全量 flush 提交
  const mark = (readGraph(dir, "sess-p22-degraded").foldMarks ?? []).at(-1);
  if (mark?.fallback !== "rules") throw new Error(`降级时 fallback 应为 rules，实际 ${JSON.stringify(mark?.fallback)}`);
  // ★ 2026-11-01（C7）：规则摘要（降级路径）也必须记保真度 —— 以前 only 模型路径设置 _lastSummaryText，
  //   降级 fold 的 quality 永远是 null，doctor 只能写「未采集」。
  if (!mark.quality || typeof mark.quality !== "object") throw new Error(`规则摘要也必须记 quality，实际 ${JSON.stringify(mark.quality)}`);
  if (mark.quality.constraintRecall !== 1) {
    throw new Error(`规则摘要逐条抄约束，constraintRecall 必须 = 1，实际 ${mark.quality.constraintRecall}（缺 ${JSON.stringify(mark.quality.missingConstraints)}）`);
  }
  if (!(mark.quality.summaryTokens > 0)) throw new Error(`规则摘要摘要 token 必须 > 0，实际 ${mark.quality.summaryTokens}`);
  if (!(mark.quality.compressionRatio > 0)) throw new Error(`规则摘要也要有 compressionRatio，实际 ${mark.quality.compressionRatio}`);
  // ★ 2026-11-01（C10）：规则摘要没有「模型自己的输出」这一层 ⇒ modelConstraintRecall 必须 null，
  //   不许把上一次模型 fold 的值串过来（跨 fold 串味）。
  if (mark.quality.modelConstraintRecall !== null) {
    throw new Error(`规则摘要的 modelConstraintRecall 必须 null，实际 ${JSON.stringify(mark.quality.modelConstraintRecall)}`);
  }
};

tests["P2-2-3 foldMarks 只保留最近 20 条（旧版无限增长）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "p22-trim");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-p22-trim");
  await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!(await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined))) throw new Error("第一次应 fold");
  // 手工塞到 25 条（模拟长期会话的历史积累），再折一次 → 必须裁到 20
  const file = nodePath.join(dir, "sessions", "sess-p22-trim", "graph.json");
  const g = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  g.foldMarks = Array.from({ length: 25 }, (_, i) => ({ at: 1_700_000_000_000 + i, seqStart: i, seqEnd: i + 1, shadowedTokens: 100, totalAfter: 1000 }));
  nodeFs.writeFileSync(file, JSON.stringify(g, null, 1), "utf8");
  // 新引擎从磁盘重新加载（旧引擎缓存的是内存图）
  const ctx2 = makeCtx({ measureTotal: () => 300_000 });
  const engine2 = new Engine(ctx2, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session2 = makeSession({ id: "sess-p22-trim" });
  for (let i = 0; i < 30; i += 1) session2.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  await engine2.summarize({ messages: [] }, { session: session2, options: {} }, undefined);
  if (!(await engine2.compactIfNeeded({ session: session2, options: {} }, "pressure", undefined))) throw new Error("第二次应 fold");
  // graph.json 是「上一回合基线快照」——标量 foldMarks 靠回合边界 idle 的全量 flush 提交
  await ctx2.emitRaw("agent/status", { agent: { session: session2 }, status: "idle" });
  const after = readGraph(dir, "sess-p22-trim");
  if (after.foldMarks.length !== 20) throw new Error(`foldMarks 必须裁到 20 条，实际 ${after.foldMarks.length}`);
  if (after.foldMarks.at(-1).route === undefined) throw new Error("最新一条必须是刚写的（带 route 字段）");
};

tests["P2-2-4 doctor：显示最近 5 次 fold；旧图缺字段显示「—」"] = async () => {
  const { execFileSync } = await import("node:child_process");
  const home = nodePath.join(GRAPH_PATH_HOME(), "p22-home");
  nodeFs.rmSync(home, { recursive: true, force: true });
  const sessDir = nodePath.join(home, "chess-context", "sessions", "sess-p22-doc");
  nodeFs.mkdirSync(sessDir, { recursive: true });
  const marks = [
    {
      at: 1_800_000_600_000,
      seqStart: 9,
      seqEnd: 20,
      shadowedTokens: 12000,
      foldCount: 6,
      route: { provider: "magpie", model: "m" },
      fallback: null,
      ms: 42,
      usage: { inputTokens: 1200, outputTokens: 300 },
      trigger: "pressure",
      closure: { nodes: 3, edges: 2, firstNode: "n1", lastNode: "n3", firstEdge: "e1", lastEdge: "e2" },
      // ★ 保真度 L1（2026-11-01）：最近一次 fold 的机器判据
      quality: {
        constraintRecall: 1,
        failureRecall: 1,
        compressionRatio: 24,
        expectedConstraints: 2,
        expectedFailures: 0,
        missingConstraints: [],
        missingFailures: [],
        summaryTokens: 500,
        shadowedTokens: 12000,
        modelConstraintRecall: 0.5,
      },
    },
    // 5 条旧图（没有 route/fallback/ms/usage/quality）
    ...[5, 4, 3, 2, 1].map((k) => ({ at: 1_800_000_000_000 + k, seqStart: k, seqEnd: k + 1, shadowedTokens: 1000 * k })),
  ];
  const graph = {
    version: 1, sessionId: "sess-p22-doc", cwd: "/tmp", createdAt: 1, updatedAt: 1,
    nodes: {}, edges: {}, order: [], rootUserNodeIds: [], checkpointSeq: null,
    foldCount: 6, lastFoldTotalTokens: 0, foldMarks: marks,
  };
  nodeFs.writeFileSync(nodePath.join(sessDir, "graph.json"), JSON.stringify(graph, null, 1), "utf8");
  const doctor = nodePath.join(HERE, "..", "scripts", "doctor.mjs");
  let parsed;
  try {
    const out = execFileSync(process.execPath, [doctor, "--json"], { encoding: "utf8", env: { ...process.env, DSH_HOME: home }, timeout: 30000 });
    parsed = JSON.parse(out);
  } catch (error) {
    parsed = JSON.parse(String(error.stdout ?? "{}"));
  }
  const check = (parsed.checks ?? []).find((c) => c.name.includes("最近 5 次 fold"));
  if (!check) throw new Error(`doctor 缺「最近 5 次 fold」检查项：${JSON.stringify((parsed.checks ?? []).map((c) => c.name))}`);
  const lines = check.detail.split("\n");
  if (lines.length !== 5) throw new Error(`应显示 5 条（总共 6 条，取最近 5 条），实际 ${lines.length}：\n${check.detail}`);
  if (!lines[0].includes("magpie/m")) throw new Error(`最新一条必须显示路由：${lines[0]}`);
  if (!lines[0].includes("42 ms")) throw new Error(`最新一条必须显示耗时：${lines[0]}`);
  if (!lines[0].includes("in 1200 / out 300")) throw new Error(`最新一条必须显示 usage：${lines[0]}`);
  if (!lines[0].includes("fallback —")) throw new Error(`正常 fold 的 fallback 应显示「—」：${lines[0]}`);
  // ★ 2026-11-01（C12）：为什么压也要看得见
  if (!lines[0].includes("触发 pressure")) throw new Error(`最近一次 fold 必须显示触发原因：${lines[0]}`);
  if (!lines[0].includes("closure 3n/2e")) throw new Error(`最近一次 fold 必须显示闭包规模：${lines[0]}`);
  // 旧图那几条：route/ms/usage 都必须是「—」
  for (const line of lines.slice(1)) {
    if (!line.includes("路由 —")) throw new Error(`旧图缺 route 必须显示「—」：${line}`);
    if (!line.includes("— ms")) throw new Error(`旧图缺 ms 必须显示「—」：${line}`);
    if (!line.includes("· —")) throw new Error(`旧图缺 usage 必须显示「—」：${line}`);
  }
  // ★ 保真度 L1（2026-11-01）：doctor 必须显示「约束/失败边有没有留住」，且召回 <1 时必须升级告警。
  const runDoctor = () => {
    try {
      const out = execFileSync(process.execPath, [doctor, "--json"], { encoding: "utf8", env: { ...process.env, DSH_HOME: home }, timeout: 30000 });
      return JSON.parse(out);
    } catch (error) {
      return JSON.parse(String(error.stdout ?? "{}"));
    }
  };
  const triggerCheck = (parsed.checks ?? []).find((c) => c.name === "fold 触发原因");
  if (!triggerCheck) throw new Error(`doctor 缺「fold 触发原因」检查项：${JSON.stringify((parsed.checks ?? []).map((c) => c.name))}`);
  if (triggerCheck.status !== "ok") throw new Error(`只有 pressure 时应 ok，实际 ${triggerCheck.status}：${triggerCheck.detail}`);
  if (!triggerCheck.detail.includes("pressure=1")) throw new Error(`必须显示触发原因分布：${triggerCheck.detail}`);
  // ★ 2026-11-01（C20）/ C43：fold 成本口径必须可观测（share 判据 + ratio 对照）
  const costCheck = (parsed.checks ?? []).find((c) => c.name.includes("fold 成本"));
  if (!costCheck) throw new Error(`doctor 缺「fold 成本」检查项：${JSON.stringify((parsed.checks ?? []).map((c) => c.name))}`);
  if (costCheck.status !== "ok") throw new Error(`比值 0.10 应 ok，实际 ${costCheck.status}：${costCheck.detail}`);
  if (!costCheck.detail.includes("0.10")) throw new Error(`必须显示比值（对照口径）：${costCheck.detail}`);
  if (!costCheck.detail.includes("遮蔽占读入")) throw new Error(`必须显示 C43 的「遮蔽占读入」：${costCheck.detail}`);
  const fidelityOf = (p) => (p.checks ?? []).find((c) => c.name.includes("压缩保真度"));
  const okFidelity = fidelityOf(parsed);
  if (!okFidelity) throw new Error(`doctor 缺「压缩保真度」检查项：${JSON.stringify((parsed.checks ?? []).map((c) => c.name))}`);
  if (okFidelity.status !== "ok") throw new Error(`召回全 1 时保真度应为 ok，实际 ${okFidelity.status}：${okFidelity.detail}`);
  if (!okFidelity.detail.includes("constraintRecall min=1")) throw new Error(`必须显示约束召回：${okFidelity.detail}`);
  if (!okFidelity.detail.includes("compressionRatio 24")) throw new Error(`必须显示压缩比：${okFidelity.detail}`);
  if (!okFidelity.detail.includes("模型自身约束召回 0.5")) throw new Error(`必须显示模型自身召回（和最终产物区分开）：${okFidelity.detail}`);
  // 变异：约束丢一条 + 失败边丢一条 ⇒ 必须 error 并点名
  marks[0].quality = { ...marks[0].quality, constraintRecall: 0.5, failureRecall: 0.5, missingConstraints: ["不要动 prod 配置"], missingFailures: ["e12"] };
  marks[0].trigger = "context-overflow";
  marks[0].usage = { ...marks[0].usage, inputTokens: 60000 }; // 60000/12000 = 5.0 ⇒ 成本效率必须 warn
  nodeFs.writeFileSync(nodePath.join(sessDir, "graph.json"), JSON.stringify(graph, null, 1), "utf8");
  const degradedParsed = runDoctor();
  const degraded = fidelityOf(degradedParsed);
  if (!degraded || degraded.status !== "error") throw new Error(`约束召回 <1 必须 error，实际 ${JSON.stringify(degraded)}`);
  const costAfter = (degradedParsed.checks ?? []).find((c) => c.name.includes("fold 成本"));
  if (!costAfter || costAfter.status !== "warn") throw new Error(`遮蔽占读入 20% 必须 warn，实际 ${JSON.stringify(costAfter)}`);
  if (!costAfter.detail.includes("折得太碎/太早")) throw new Error(`必须说明含义（C43：share<30%）:${costAfter.detail}`);
  const overflowCheck = (degradedParsed.checks ?? []).find((c) => c.name === "fold 触发原因");
  if (!overflowCheck || overflowCheck.status !== "warn") throw new Error(`出现 context-overflow 必须 warn，实际 ${JSON.stringify(overflowCheck)}`);
  if (!overflowCheck.detail.includes("被迫自救")) throw new Error(`必须说明 overflow 的含义：${overflowCheck.detail}`);
  const namedC = (parsed.checks ?? []).find((c) => c.name.includes("丢失的约束"));
  const namedAfter = (degraded && (runDoctor().checks ?? []).find((c) => c.name.includes("丢失的约束"))) || namedC;
  if (!namedAfter || !namedAfter.detail.includes("prod")) throw new Error(`必须点名丢失的约束，实际 ${JSON.stringify(namedAfter)}`);
};

tests["C14 手动 /compact 也记 foldMark + 保真度（覆盖最后一条压缩路径）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c14-manual");
  const session = makeSession({ id: "sess-c14-manual" });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  // 让图里真的有约束与失败边（keeper 真跑）
  await ctx.emitRaw("session/event", session, userEvent("硬约束：不要动 prod 配置。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "ERR_EACCES: permission denied", 3, true));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  // 真实流程里 summarize() 会留下 pending 摘要文本；这里直接给（与 P2-2-1 处理桩的方式一致）
  const NL = String.fromCharCode(10);
  const summary = ["## 目标", "- 硬约束：不要动 prod 配置。", "## 已探明死路", '- e1 "npm test" → ERR_EACCES (evidence seq 2-3)'].join(NL);
  engine._lastSummaryText = summary;
  engine._lastSummaryChars = summary.length;
  engine._lastSummaryModelText = summary;
  const mark = engine.recordFoldMark(session, { range: { start: 2, end: 4 }, trigger: "manual" });
  if (mark.trigger !== "manual") throw new Error(`手动压缩的 foldMark.trigger 必须是 manual，实际 ${JSON.stringify(mark.trigger)}`);
  if (mark.seqStart !== 2 || mark.seqEnd !== 4) throw new Error(`foldMark 区间错：${mark.seqStart}-${mark.seqEnd}`);
  if (!mark.quality || typeof mark.quality !== "object") throw new Error(`手动压缩也必须记保真度，实际 ${JSON.stringify(mark.quality)}`);
  if (!(mark.quality.expectedConstraints >= 1)) {
    throw new Error(`手动压缩的保真度样本必须是有内容的（期望约束 >= 1），实际 ${mark.quality.expectedConstraints}`);
  }
  if (mark.quality.constraintRecall !== 1) throw new Error(`约束逐字都在摘要里，recall 必须 1，实际 ${mark.quality.constraintRecall}`);
  // ★ 2026-11-02（C24）：手动压缩也记可寻址闭包（区间 2-4 覆盖 e1 与 n2）
  if (!mark.closure || typeof mark.closure.nodes !== "number") throw new Error(`手动压缩也要记 closure，实际 ${JSON.stringify(mark.closure)}`);
  // 谁生产谁消费：pending 摘要字段必须被清掉，不能挂到下一次 fold
  if (engine._lastSummaryText !== undefined || engine._lastSummaryModelText !== undefined) {
    throw new Error("recordFoldMark 必须消费掉 _lastSummaryText/_lastSummaryModelText（避免串到下一次 fold）");
  }
  // 落盘可查（doctor/handoff-check 读的是 graph.json）
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const disk = (readGraph(dir, "sess-c14-manual").foldMarks ?? []).at(-1);
  if (disk?.trigger !== "manual") throw new Error(`graph.json 里必须能看到手动压缩记录，实际 ${JSON.stringify(disk?.trigger)}`);
};

tests["C14b 手动 /compact 的接线：compactNow → compactRegion 记区间 → recordFoldMark"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c14-wiring");
  const session = makeSession({ id: "sess-c14-wire" });
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  const seqA = session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "一" }] });
  const seqB = session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "二" }] });
  // 桩基类的 compactNow 是空的（返回 null）⇒ 临时替换成「模拟宿主」：算出 range、调 compactRegion、返回成功。
  // 这一步正是 C14 里唯一没被覆盖的接线（真实宿主就是这么做的）。
  const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(engine));
  const original = baseProto.compactNow;
  baseProto.compactNow = async function (agent) {
    await this.compactRegion(seqA, seqB, agent);
    return { ok: true };
  };
  try {
    // summarize 在 compactRegion 里会留下 pending 摘要文本；这里直接给（与 P2-2-1 处理桩的方式一致）
    engine._lastSummaryText = ["## 目标", "- x"].join(String.fromCharCode(10));
    engine._lastSummaryChars = 8;
    engine._lastSummaryModelText = engine._lastSummaryText;
    await engine.compactNow({ session, options: {} });
    const mark = (engine.graphs.get(session.id)?.foldMarks ?? []).at(-1);
    if (mark?.trigger !== "manual") throw new Error(`手动 /compact 必须记 trigger=manual，实际 ${JSON.stringify(mark?.trigger)}`);
    if (mark.seqStart !== seqA || mark.seqEnd !== seqB) throw new Error(`手动压缩记的区间错：${mark.seqStart}-${mark.seqEnd}（期望 ${seqA}-${seqB}）`);
    if (engine._lastSummaryText !== undefined) throw new Error("recordFoldMark 之后 pending 摘要必须被消费");
  } finally {
    baseProto.compactNow = original;
  }
};

/** doctor 夹具的上级目录（test/.harness/graphs）。 */
function GRAPH_PATH_HOME() {
  return GRAPHS;
}

tests["C7：规则摘要路径也必须记 quality（降级时不能成为指标盲区）"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-rules-quality" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  // summaryMode: rules ⇒ 走 ruleResult()，完全不调模型。旧版只有模型路径设置 _lastSummaryText，
  // 于是 rules 降级时 foldMarks.quality 缺失 —— 而「降级」恰恰是最需要看保真度的时候。
  const engine = new Engine(ctx, {
    graphDir: nodePath.join(GRAPHS, "g-rules-quality"),
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    summaryMode: "rules",
  });
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当 fold");
  const g = readGraph(nodePath.join(GRAPHS, "g-rules-quality"), "sess-rules-quality");
  const mark = (g.foldMarks ?? []).at(-1);
  if (!mark) throw new Error("foldMarks 应有记录");
  if (mark.quality === null || typeof mark.quality !== "object") {
    throw new Error(`规则摘要路径也必须记 quality，实际 ${JSON.stringify(mark.quality)}`);
  }
  for (const key of ["constraintRecall", "failureRecall"]) {
    if (typeof mark.quality[key] !== "number") {
      throw new Error(`rules 路径的 quality.${key} 必须是数字，得到 ${JSON.stringify(mark.quality[key])}`);
    }
  }
};

tests["C61 引擎级折叠不变量：约束/失败边一条不少、闭包与区间一致、foldMark 字段齐全"] = async () => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-foldprops" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const sessionId = "sess-foldprops";
  // 结构：10 个 prompt → 失败边 → 再 10 个 prompt。
  // 这样失败边落在「可折叠的头部」而不是「保留的尾部」，fold 区间才会覆盖到它们（与真实会话一致）。
  for (let i = 0; i < 10; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  await ctx.emitRaw("session/event", session, userEvent("把构建跑通。不要动 prod 配置。", session.nextSeq()));
  for (let i = 0; i < 10; i += 1) {
    await ctx.emitRaw("session/event", session, assistantEvent(`c${i}`, "bash", { command: `t${i}` }, session.nextSeq()));
    await ctx.emitRaw("session/event", session, resultEvent(`c${i}`, `boom ${i}
[exit code: 1]`, session.nextSeq()));
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: session.nextSeq(), data: { turn: 1, step: i + 1 } });
  }
  for (let i = 0; i < 10; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "tail" }] });

  // 真实流程里 fold 的 compactRegion 会调 summarize；stub 不会 ⇒ 先手动调一次，让 _lastSummary* 有值
  await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 回合边界 flush（graph.json 只在 idle 落盘）
  const before = readGraph(graphDir, sessionId);
  const failuresBefore = Object.values(before.edges).filter((e) => e.result === "failure").length;
  const constraintsBefore = collectConstraints({
    nodes: before.nodes,
    order: before.order ?? Object.keys(before.nodes),
    rootUserNodeIds: before.rootUserNodeIds ?? [],
  }).length;
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当发生 fold");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // foldMarks 靠 idle 全量 flush 提交
  const after = readGraph(graphDir, sessionId);
  const mark = after.foldMarks.at(-1);
  if (!mark) throw new Error("fold 后必须留下 foldMark");

  // ① 失败边一条不少（折叠只换摘要，不许删记忆）
  const failuresAfter = Object.values(after.edges).filter((e) => e.result === "failure").length;
  if (failuresAfter !== failuresBefore) throw new Error(`失败边从 ${failuresBefore} 变成 ${failuresAfter}`);
  // ② 约束一条不少
  const constraintsAfter = collectConstraints({
    nodes: after.nodes,
    order: after.order ?? Object.keys(after.nodes),
    rootUserNodeIds: after.rootUserNodeIds ?? [],
  }).length;
  if (constraintsAfter !== constraintsBefore) throw new Error(`约束从 ${constraintsBefore} 变成 ${constraintsAfter}`);
  if (constraintsAfter < 1) throw new Error("夹具应有至少一条约束");
  // ③ 闭包与区间一致（暴力重算，用 fold 后的图 —— 册折叠范围内的实体在折叠后仍可枚举）
  const closure = foldClosureOf({ nodes: after.nodes, order: after.order ?? Object.keys(after.nodes), edges: after.edges }, { start: mark.seqStart, end: mark.seqEnd });
  if (mark.closure.nodes !== closure.nodes || mark.closure.edges !== closure.edges) {
    throw new Error(`闭包计数不一致：记录 ${JSON.stringify(mark.closure)} vs 重算 ${JSON.stringify(closure)}`);
  }
  if (mark.closure.preGraph !== closure.preGraph) throw new Error("preGraph 标记不一致");
  // ④ 边界完整性：切点在 step 边界 ⇒ openAtEnd 必须为 0
  const boundary = foldBoundaryOf({ edges: after.edges }, { start: mark.seqStart, end: mark.seqEnd });
  if (mark.boundary.openAtEnd !== boundary.openAtEnd) throw new Error(`边界记录不一致：${mark.boundary.openAtEnd} vs ${boundary.openAtEnd}`);
  if (mark.boundary.openAtEnd !== 0) throw new Error(`切在 tool 调用中间（openAtEnd=${mark.boundary.openAtEnd}）`);
  // ⑤ foldMark 字段齐全
  if (mark.trigger !== "pressure") throw new Error(`trigger 应为 pressure，实际 ${mark.trigger}`);
  if (!mark.quality || typeof mark.quality !== "object") throw new Error("缺 quality");
  if (!(mark.quality.constraintRecall >= 0 && mark.quality.constraintRecall <= 1)) throw new Error("constraintRecall 非法");
  if (mark.quality.expectedConstraints < 1) throw new Error(`expectedConstraints=${mark.quality.expectedConstraints}`);
  if (mark.quality.expectedFailures < 1) {
    throw new Error(`fold 区间应覆盖失败边：range=${mark.seqStart}-${mark.seqEnd} 失败边=${failuresBefore}`);
  }
  if (!Array.isArray(mark.quality.unknownIds)) throw new Error("缺 unknownIds");
  if (!mark.dangling || typeof mark.dangling !== "object") throw new Error("缺 dangling 快照");
  if (!Number.isFinite(mark.summaryChars) || mark.summaryChars <= 0) throw new Error("缺 summaryChars");
};

tests["C62 连续折叠不变量：区间单调、失败边只增不减、每次都有 quality，且不重扫已折区域"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c62-multifold");
  const session = makeSession({ id: "sess-c62" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const sid = "sess-c62";

  const seedTurn = async (tag) => {
    for (let i = 0; i < 6; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: `pre-${tag}-${i}` }] });
    await ctx.emitRaw("session/event", session, assistantEvent(`c-${tag}`, "bash", { command: `t-${tag}` }, session.nextSeq()));
    await ctx.emitRaw("session/event", session, resultEvent(`c-${tag}`, `boom ${tag}
[exit code: 1]`, session.nextSeq()));
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: session.nextSeq(), data: { turn: 1, step: 1 } });
    for (let i = 0; i < 6; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: `post-${tag}-${i}` }] });
  };

  let lastEnd = -1;
  let lastFailures = -1;
  const marks = [];
  for (let round = 0; round < 3; round += 1) {
    await seedTurn(round);
    await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
    const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
    if (!result) throw new Error(`第 ${round + 1} 次应发生 fold`);
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    const g = readGraph(dir, sid);
    const mark = (g.foldMarks ?? []).at(-1);
    marks.push(mark);
    if (!mark) throw new Error(`第 ${round + 1} 次没有 foldMark`);
    // 区间单调：新一次的开始必须晚于上一次的结束（不许重扫已折区域）
    if (round > 0 && mark.seqStart <= lastEnd) throw new Error(`第 ${round + 1} 次从 ${mark.seqStart} 开始，上一次结束于 ${lastEnd}（重叠重扫）`);
    lastEnd = mark.seqEnd;
    // 失败边只增不减
    const failures = Object.values(g.edges).filter((e) => e.result === "failure").length;
    if (lastFailures >= 0 && failures < lastFailures) throw new Error(`失败边从 ${lastFailures} 掉到 ${failures}`);
    lastFailures = failures;
    // 每次都要有 quality / closure / boundary
    if (!mark.quality || mark.quality.expectedConstraints < 0) throw new Error(`第 ${round + 1} 次 quality 缺失`);
    if (!mark.closure || typeof mark.closure.nodes !== "number") throw new Error(`第 ${round + 1} 次 closure 缺失`);
    if (!mark.boundary || typeof mark.boundary.openAtEnd !== "number") throw new Error(`第 ${round + 1} 次 boundary 缺失`);
  }
  if (marks.length !== 3) throw new Error(`应留 3 条 foldMark，实际 ${marks.length}`);
  if (lastFailures < 3) throw new Error(`三次折叠后失败边应 >=3，实际 ${lastFailures}`);
};

tests["C134 fold 中途抛错：图与计数器必须原子（不留下「改了一半」的图）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c134-atomic");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c134");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 先落一版基线
  const before = readGraph(dir, "sess-c134");
  const beforeNodes = Object.keys(before.nodes).sort();
  const beforeMarks = (before.foldMarks ?? []).length;
  const beforeFoldCount = before.foldCount ?? 0;

  // 让真实的 compactRegion 事务在半途炸掉（harness 的 ctx 提供的是桩）
  const original = engine.compactRegion.bind(engine);
  engine.compactRegion = async () => {
    throw new Error("injected-boom");
  };
  let threw = false;
  try {
    await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  } catch {
    threw = true;
  } finally {
    engine.compactRegion = original;
  }
  if (!threw) throw new Error("compactRegion 抛错时 compactIfNeeded 必须把错抛出来（不许静默）");

  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 回滚后的图落盘
  const after = readGraph(dir, "sess-c134");
  const afterNodes = Object.keys(after.nodes).sort();
  if (JSON.stringify(afterNodes) !== JSON.stringify(beforeNodes)) {
    throw new Error(`fold 失败后节点集变了：${beforeNodes.length} → ${afterNodes.length}`);
  }
  if ((after.foldMarks ?? []).length !== beforeMarks) {
    throw new Error(`fold 失败后不许新增 foldMark：${beforeMarks} → ${(after.foldMarks ?? []).length}`);
  }
  if ((after.foldCount ?? 0) !== beforeFoldCount) {
    throw new Error(`fold 失败后 foldCount 不许变：${beforeFoldCount} → ${after.foldCount}`);
  }
};

tests["C135 手动 /compact 的深度记账：结束后必须回到外层值（不归零、不外溢）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c135-manual");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c135");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const before = readGraph(dir, "sess-c135");
  const beforeNodes = Object.keys(before.nodes).sort();
  const beforeMarks = (before.foldMarks ?? []).length;

  // ① 顶层调用：深度从 0 → 1 → 0
  const first = await engine.compactNow({ session }, undefined, "cmd-1");
  if ((engine._manualCompactDepth ?? 0) !== 0) throw new Error(`顶层调用后深度必须归零，实际 ${engine._manualCompactDepth}`);
  if (engine._manualRange !== null && engine._manualRange !== undefined) throw new Error(`_manualRange 必须清空，实际 ${JSON.stringify(engine._manualRange)}`);

  // ② 嵌套调用（外层已经深度 1）：内层结束后必须回到 1，而不是被清零
  engine._manualCompactDepth = 1;
  try {
    await engine.compactNow({ session }, undefined, "cmd-2");
    if ((engine._manualCompactDepth ?? 0) !== 1) throw new Error(`嵌套调用后深度必须回到外层值 1，实际 ${engine._manualCompactDepth}`);
  } finally {
    engine._manualCompactDepth = 0;
  }

  // 桩 compactNow 返回 null ⇒ 不许凭「调用过」就记 foldMark
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const after = readGraph(dir, "sess-c135");
  if (JSON.stringify(Object.keys(after.nodes).sort()) !== JSON.stringify(beforeNodes)) throw new Error("手动压缩后节点集变了");
  if ((after.foldMarks ?? []).length !== beforeMarks) throw new Error("compactNow 返回 null 时不许新增 foldMark（防「假装压过」）");
  void first;
};

tests["C137 手动 /compact 结束后不许把 pending 摘要留给下一次 fold（与 C136 同源）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c137-manual-pending");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c137");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  // 模拟：summarize 留下 pending（无论是因为异常还是桩不消费）
  engine._lastSummaryText = "STALE-FROM-MANUAL";
  engine._lastSummaryChars = engine._lastSummaryText.length;
  engine._lastSummaryModelText = engine._lastSummaryText;
  // ★ C148（复审 P2-2）：route/usage 也必须清 —— 否则下一次模型 fold 若 provider 不回 usage，
  //   会把**上一次手动压缩**的 usage 记成本次。
  engine._lastSummaryProvider = "p";
  engine._lastSummaryModel = "m";
  engine._lastSummaryUsage = { inputTokens: 9, outputTokens: 9 };
  await engine.compactNow({ session }, undefined, "cmd-1");

  if (engine._lastSummaryText !== undefined) throw new Error(`手动压缩后 _lastSummaryText 必须清空，实际 ${JSON.stringify(engine._lastSummaryText)}`);
  if (engine._lastSummaryChars !== undefined) throw new Error("手动压缩后 _lastSummaryChars 必须清空");
  if (engine._lastSummaryModelText !== undefined) throw new Error("手动压缩后 _lastSummaryModelText 必须清空");
  if (engine._lastSummaryProvider !== undefined) throw new Error("手动压缩后 _lastSummaryProvider 必须清空（复审 P2-2）");
  if (engine._lastSummaryModel !== undefined) throw new Error("手动压缩后 _lastSummaryModel 必须清空");
  if (engine._lastSummaryUsage !== undefined) throw new Error("手动压缩后 _lastSummaryUsage 必须清空（否则下一次 fold 记假 usage）");
};

tests["C138 foldThrash：两次 fold 间隔 <30 事件要累计，拉开间隔后必须清零"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c138-thrash");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.05 });
  const session = makeSession({ id: "sess-c138" });
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: `seed ${i}` }] });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", ["boom", "[exit code: 1]"].join(String.fromCharCode(10)), 3));

  const fold = async () => {
    await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
    const r = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    return r;
  };

  if ((await fold()) === null) throw new Error("第 1 次 fold 应当成功（夹具不够？）");
  const g1 = readGraph(dir, "sess-c138");
  if ((g1.foldCount ?? 0) < 1) throw new Error("foldCount 应 >= 1");
  if ((g1.foldThrash ?? 0) !== 0) throw new Error(`第一次 fold 不该计 thrash，实际 ${g1.foldThrash}`);

  // 第二次：只推进 <30 个事件 ⇒ 必须累计 thrash
  for (let i = 0; i < 3; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: `soon ${i}` }] });
  const second = await fold();
  if (second !== null) {
    const g2 = readGraph(dir, "sess-c138");
    if ((g2.foldThrash ?? 0) < 1) throw new Error(`间隔 <30 事件的第二次 fold 必须计 thrash，实际 ${g2.foldThrash ?? 0}`);
  }

  // 第三次：推进 >=30 事件 ⇒ thrash 必须清零
  const gap = 40;
  for (let i = 0; i < gap; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: `later ${i}` }] });
  const third = await fold();
  if (third !== null) {
    const g3 = readGraph(dir, "sess-c138");
    if ((g3.foldThrash ?? 0) !== 0) throw new Error(`间隔 >=30 事件后 thrash 必须清零，实际 ${g3.foldThrash}`);
  }
};

tests["C143 规则降级 fold 不许带「上一次模型调用」的 route/usage（伪造的账）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c143-rules-route");
  const ctx = makeCtx({ measureTotal: () => 300_000, usage: { inputTokens: 999, outputTokens: 111 } });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, summaryMode: "rules" });
  const session = await p22Session(ctx, "sess-c143");
  // 制造「上一次模型调用」的残留
  engine._lastSummaryProvider = "p";
  engine._lastSummaryModel = "m";
  engine._lastSummaryUsage = { inputTokens: 999, outputTokens: 111 };

  const rule = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!Array.isArray(rule.summary)) throw new Error("规则摘要必须返回 summary");
  if (engine._lastSummaryProvider !== undefined) throw new Error("规则路径必须清掉 provider（否则 foldMark.route 记的是上次的）");
  if (engine._lastSummaryModel !== undefined) throw new Error("规则路径必须清掉 model");
  if (engine._lastSummaryUsage !== undefined) throw new Error("规则路径必须清掉 usage（否则 lastFoldUsage 是伪造的账）");
  if (engine._lastSummaryModelText !== undefined) throw new Error("模型文本也必须清空");
};

tests["C177 fold 连续失败必须退避：窗口内不再重试（省掉模型调用），越界后恢复；overflow 前 3 次不受限"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c177-backoff");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c177");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  // 让 compactRegion 一直抛错，模拟「摘要路径坏掉」
  const original = engine.compactRegion.bind(engine);
  let attempts = 0;
  engine.compactRegion = async () => {
    attempts += 1;
    throw new Error("injected-persistent-boom");
  };
  try {
    // 第 1 次：真的要试（并失败）
    let threw = false;
    try {
      await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("首次失败必须抛错（_lastSummary 那套约定）");
    if (attempts !== 1) throw new Error(`首次应尝试 1 次，实际 ${attempts}`);

    // 第 2 次：还在退避窗口内（30 事件）⇒ 必须直接跳过，不再尝试
    const second = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
    if (second !== null) throw new Error(`退避窗口内必须返回 null，实际 ${JSON.stringify(second)}`);
    if (attempts !== 1) throw new Error(`退避窗口内不许再尝试（attempts 应仍为 1，实际 ${attempts}）`);

    // 推进事件越过窗口 ⇒ 允许再试一次
    for (let i = 0; i < 60; i += 1) session.nextSeq(); // 推进事件，越过退避窗口
    let threw2 = false;
    try {
      await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
    } catch {
      threw2 = true;
    }
    if (!threw2) throw new Error("越过退避窗口后应再试并再次失败（抛错）");
    if (attempts !== 2) throw new Error(`越过窗口后应尝试第 2 次，实际 ${attempts}`);

    // overflow 自救路径不受退避限制
    session.nextSeq(); // 只推进 1 个事件 —— 仍在退避窗口内，但 overflow 不受限
    let threw3 = false;
    try {
      await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
    } catch {
      threw3 = true;
    }
    if (!threw3) throw new Error("overflow 前 3 次必须尝试（C179 起从第 4 次才有上限）");
    if (attempts !== 3) throw new Error(`overflow 应再尝试一次，实际 ${attempts}`);
  } finally {
    engine.compactRegion = original;
  }

};

tests["C179 连续失败 3 次后，overflow 自救也必须退避（溢出场景不许每步都跑一次模型）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c179-overflow-cap");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c179");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const original = engine.compactRegion.bind(engine);
  let attempts = 0;
  engine.compactRegion = async () => {
    attempts += 1;
    throw new Error("injected-always-boom");
  };
  try {
    // 连续 3 次 overflow 尝试（前 3 次允许 —— 自救优先）
    for (let i = 0; i < 3; i += 1) {
      session.nextSeq();
      try {
        await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
      } catch {
        /* 预期抛错 */
      }
    }
    if (attempts !== 3) throw new Error(`前 3 次 overflow 应各尝试一次（期望 3，实际 ${attempts}）`);

    // 第 4 次（仍在窗口内）：必须直接跳过
    session.nextSeq();
    const fourth = await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
    if (fourth !== null) throw new Error(`第 4 次 overflow 在窗口内必须返回 null，实际 ${JSON.stringify(fourth)}`);
    if (attempts !== 3) throw new Error(`第 4 次不许再尝试（应仍为 3，实际 ${attempts}）`);

    // 推进事件越过窗口：允许再试
    for (let i = 0; i < 300; i += 1) session.nextSeq();
    try {
      await engine.compactIfNeeded({ session, options: {} }, "context-overflow", undefined);
    } catch {
      /* 预期抛错 */
    }
    if (attempts !== 4) throw new Error(`越过窗口后应允许再试（期望 4，实际 ${attempts}）`);
  } finally {
    engine.compactRegion = original;
  }
};

tests["C198 宿主直接调 compactRegion 也必须记账（trigger=host 进预算账本），否则证据里整段折叠不存在"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c198-external");
  const ctx = makeCtx({ measureTotal: () => 200_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c198");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const nodes = session.surface.nodes;
  const startSeq = nodes[1];
  const endSeq = nodes[nodes.length - 2];
  // 模拟「摘要已产出」的现场（宿主 compactRegion 内部会设置这些字段）
  engine._lastSummaryText = "摘要正文：约束 C1、失败 e1";
  engine._lastSummaryChars = 20;
  engine._lastSummaryModelText = "摘要正文：约束 C1、失败 e1";

  // 宿主直接调用（不经过 compactIfNeeded / compactNow）
  await engine.compactRegion(startSeq, endSeq, { session, options: {} }, undefined);

  const stats = engine.getLedgerBudgetStats();
  if (stats.externalFolds !== 1) throw new Error(`必须记 1 次外部折叠，实际 ${JSON.stringify(stats.externalFolds)}`);
  const last = stats.lastExternalFold;
  if (!last) throw new Error("必须留下 lastExternalFold 明细");
  if (last.seqStart !== startSeq || last.seqEnd !== endSeq) throw new Error(`区间必须一致：${last.seqStart}-${last.seqEnd} vs ${startSeq}-${endSeq}`);
  if (!last.closure || typeof last.closure.nodes !== "number") throw new Error("必须带 closure（可寻址）");
  if (!last.boundary || typeof last.boundary.openAtEnd !== "number") throw new Error("必须带 boundary（切点检查）");
  if (!last.quality || last.quality.constraintRecall !== 1) throw new Error(`必须带 quality（摘要提到 C1 ⇒ 召回 1），实际 ${JSON.stringify(last.quality)}`);
  if (engine._lastSummaryText !== undefined) throw new Error("pending 摘要必须被消费掉（谁生产谁消费）");
};

tests["C198 我们自己的 pressure fold 不算「外部折叠」（不能把自己的账记两遍）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c198-internal");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c198b");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("pressure fold 应该发生");
  const stats = engine.getLedgerBudgetStats();
  if (stats.externalFolds !== undefined) throw new Error(`自己的 fold 不许计入 externalFolds，实际 ${stats.externalFolds}`);
};

tests["C210 归档（session/disposed）必须收尾：记 closeout，并真的发起一次收尾折叠"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c210-closeout");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c210");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const callsBefore = (engine.compactCalls ?? []).length;

  await ctx.emitRaw("session/disposed", session);
  // 收尾折叠是异步的（disposed 是 void 事件）：等它把 compactRegion 调起来
  for (let i = 0; i < 40 && (engine.compactCalls ?? []).length === callsBefore; i += 1) await new Promise((r) => setTimeout(r, 20));
  const calls = engine.compactCalls ?? [];
  if (calls.length <= callsBefore) throw new Error("归档必须发起一次收尾折叠（compactRegion 没被调用）");
  const last = calls.at(-1);
  if (!(Number.isFinite(last.start) && Number.isFinite(last.end) && last.start <= last.end)) {
    throw new Error(`收尾折叠的区间必须有序：${JSON.stringify(last)}`);
  }

  const g = await readGraphReplayed(dir, "sess-c210");
  if (!g.closeout || typeof g.closeout.eventsSinceLastFold !== "number") throw new Error("必须记 closeout（归档时刻 + 距上次 fold 的事件数）");
  if (g.closeout.eventsSinceLastFold < 5) throw new Error(`closeout 必须记下尾巴事件数，实际 ${g.closeout.eventsSinceLastFold}`);
};

tests["C210 归档收尾有两道保险：尾巴太短不折叠；折叠失败也绝不抛给宿主"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c210-guard");
  // ① 尾巴太短（closeoutMinEvents 很大）⇒ 不折叠，但 closeout 仍要记
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 99999 });
  const session = await p22Session(ctx, "sess-c210-guard");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  await ctx.emitRaw("session/disposed", session);
  await new Promise((r) => setTimeout(r, 60));
  const g1 = await readGraphReplayed(dir, "sess-c210-guard");
  if ((g1.foldMarks ?? []).some((m) => m.trigger === "archive")) throw new Error("尾巴不足时不许折叠");
  if (!g1.closeout) throw new Error("即便不折叠，closeout 也必须记下来");

  // ② 折叠抛错（provider 炸）⇒ disposed 不允许把异常抛出去
  const ctx2 = makeCtx({ measureTotal: () => 300_000, failModels: new Set(["group/deepseek-v4.1-flash1017"]) });
  const engine2 = new Engine(ctx2, { graphDir: nodePath.join(graphDir, "c210-fail"), auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 1, closeoutTimeoutMs: 2000 });
  const session2 = await p22Session(ctx2, "sess-c210-fail");
  await ctx2.emitRaw("agent/status", { agent: { session: session2 }, status: "idle" });
  await ctx2.emitRaw("session/disposed", session2); // 不许 reject / throw
  await new Promise((r) => setTimeout(r, 80));
  const g2 = await readGraphReplayed(nodePath.join(graphDir, "c210-fail"), "sess-c210-fail");
  if (!g2.closeout) throw new Error("失败路径也必须留下 closeout 记录");
};

tests["C222 K-2 已否决：工具结果清理不许挪到每一步（只在 overflow / fold 前）"] = async () => {
  // 否决依据（docs/knowledge/进度.md 第 6 轮）：本会话实测 tool/result 501 条、单条中位 576 字符、
  // 最大 23.8k、**0 条 ≥25k** —— 压力在条数不在单条；而 C220 证明 97% 的输入走缓存命中，
  // 提前裁只会破坏前缀缓存，得不偿失。这条守卫防止"以后有人觉得该每步都裁"再犯一次。
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "engine.mjs"), "utf8");
  const calls = [...src.split("pruneSession(").slice(1)];
  const viaPrune = calls.filter((m) => src.slice(Math.max(0, m.index - 60), m.index).includes("prune."));
  if (viaPrune.length !== 2) throw new Error(`pruneSession 只允许在 overflow 与 fold 前各调一次，实际 ${viaPrune.length} 次`);
  const start = src.indexOf("#bindLedger() {");
  const end = src.indexOf(String.fromCharCode(10) + "  #", start + 10);
  if (start < 0 || end < 0) throw new Error("找不到 #bindLedger 的边界（守卫失效要修守卫，不是删守卫）");
  const ledgerBody = src.slice(start, end);
  if (ledgerBody.includes("pruneSession")) throw new Error("每步注入路径里不许清理工具结果（K-2 已否决）");
};

tests["C216 GUI 归档不发 session/disposed：必须认 workspace 域的 durable 写入（domain/changed）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-archive");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c216");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const callsBefore = (engine.compactCalls ?? []).length;

  // 真机 1.17.5 的归档路径：只写 workspace 域 global 记录，会话仍 live、不发 session/disposed
  const archived = { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: ["sess-c216"] } };
  await ctx.emitRaw("domain/changed", archived);
  for (let i = 0; i < 40 && (engine.compactCalls ?? []).length === callsBefore; i += 1) await new Promise((r) => setTimeout(r, 20));
  if ((engine.compactCalls ?? []).length <= callsBefore) throw new Error("归档必须发起一次收尾折叠（compactRegion 没被调用）");

  const g = await readGraphReplayed(dir, "sess-c216");
  if (!g.closeout) throw new Error("归档必须记 closeout（没有就等于「归档了但没补收尾」）");
  if (g.closeout.source !== "archive") throw new Error(`closeout 要能归因到 archive，实际 ${JSON.stringify(g.closeout.source)}`);
  if (typeof g.closeout.eventsSinceLastFold !== "number" || g.closeout.eventsSinceLastFold < 5) {
    throw new Error(`closeout 必须记下尾巴事件数，实际 ${JSON.stringify(g.closeout.eventsSinceLastFold)}`);
  }

  // 同一条 durable 写入被重复广播（宿主重放 / 后续无关变更）不许重复收尾
  const atBefore = g.closeout.at;
  await ctx.emitRaw("domain/changed", archived);
  await new Promise((r) => setTimeout(r, 60));
  if ((await readGraphReplayed(dir, "sess-c216")).closeout.at !== atBefore) throw new Error("重复广播同一个归档不许重复收尾");

  // 取消归档 → 继续聊 → 再归档：必须能再收尾一次（否则「恢复会话接着用」永远收不了尾）
  await ctx.emitRaw("domain/changed", { ...archived, value: { archivedSessionIds: [] } });
  await ctx.emitRaw("domain/changed", archived);
  await new Promise((r) => setTimeout(r, 80));
  const atAfterSecond = (await readGraphReplayed(dir, "sess-c216")).closeout.at;
  if (atAfterSecond === atBefore) throw new Error("取消归档后再归档必须能重新收尾");

  // 同一次归档撞上两个信号（durable 写入 + 宿主顺手销毁）：只许收尾一次
  await ctx.emitRaw("session/disposed", session);
  await new Promise((r) => setTimeout(r, 60));
  if ((await readGraphReplayed(dir, "sess-c216")).closeout.at !== atAfterSecond) {
    throw new Error("归档 + 销毁是同一个收尾的两个信号，10s 内只许算一次");
  }
};

tests["C216 归档信号只认 workspace 的 global 记录：别的域 / 别的表 / delete 都不许触发收尾"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-scope");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c216b");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const id = "sess-c216b";
  const noisy = [
    { domain: "session", table: "", key: "", operation: "put", value: { archivedSessionIds: [id] } },
    { domain: "workspace", table: "workspaces", key: "w1", operation: "put", value: { archivedSessionIds: [id] } },
    { domain: "workspace", table: "", key: "", operation: "delete", value: { archivedSessionIds: [id] } },
  ];
  for (const change of noisy) await ctx.emitRaw("domain/changed", change);
  await new Promise((r) => setTimeout(r, 80));
  if ((await readGraphReplayed(dir, "sess-c216b")).closeout) throw new Error("非 workspace-global-put 的变更不许触发归档收尾");

  // 反向确认：同样一份载荷，走对的门就能收尾
  await ctx.emitRaw("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: [id] } });
  await new Promise((r) => setTimeout(r, 80));
  const g = await readGraphReplayed(dir, "sess-c216b");
  if (!g.closeout) throw new Error("workspace/global/put 必须触发归档收尾");
};

tests["C216 归档信号只认 change.value：registry 在回调里落后一拍（读到的是旧值）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-stale-registry");
  // 模拟宿主真实时序：`global.set()` 里 emitChanged 是在 `registry.state = state` **之前**同步发出的，
  // 所以回调里回读 registry.archivedSessionIds 拿到的是写入前的旧值（这里就是空数组）。
  const staleRegistry = { archivedSessionIds: [] };
  const ctx = makeCtx({ measureTotal: () => 300_000, services: { workspaceRegistry: staleRegistry } });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c216e");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const callsBefore = (engine.compactCalls ?? []).length;

  await ctx.emitRaw("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: ["sess-c216e"] } });
  for (let i = 0; i < 40 && (engine.compactCalls ?? []).length === callsBefore; i += 1) await new Promise((r) => setTimeout(r, 20));
  const g = await readGraphReplayed(dir, "sess-c216e");
  if (!g.closeout) throw new Error("载荷里已经写着新归档集合，回读 registry 拿到旧值也不许影响收尾");
  if ((engine.compactCalls ?? []).length <= callsBefore) throw new Error("必须真的发起收尾折叠");
};

tests["C216 归档时没压完的会话：再次打开（变 live）时自动补做收尾（backfill）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-backfill");
  // 开机时它已经在归档集合里（历史归档）—— 这正是「补账」要覆盖的情形
  const ctx = makeCtx({ measureTotal: () => 300_000, services: { workspaceRegistry: { archivedSessionIds: ["sess-c216f"] } } });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const before = (engine.compactCalls ?? []).length;

  // 用户把它恢复/打开：事件进来 + 一次空转
  const session = await p22Session(ctx, "sess-c216f");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  for (let i = 0; i < 40 && (engine.compactCalls ?? []).length === before; i += 1) await new Promise((r) => setTimeout(r, 20));

  const g = await readGraphReplayed(dir, "sess-c216f");
  if (!g.closeout) throw new Error("恢复后的会话必须补做收尾（closeout 没写）");
  if (g.closeout.source !== "backfill") throw new Error(`补账要能归因到 backfill，实际 ${JSON.stringify(g.closeout.source)}`);
  if ((engine.compactCalls ?? []).length <= before) throw new Error("补账必须真的发起一次折叠");

  // 第二个空转点不许再补一次
  const at = g.closeout.at;
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  await new Promise((r) => setTimeout(r, 80));
  if ((await readGraphReplayed(dir, "sess-c216f")).closeout.at !== at) throw new Error("同一次欠账只许补一次");
};

tests["C216 收尾折叠不受 token 压力门槛限制：压力不高时 pressure 不折，archive 必须折"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-forced");
  // 200K 窗口、只用了 10K ⇒ 远低于阈值：pressure 不该动，archive 必须动（补账不是「长了没长」的问题）
  const ctx = makeCtx({ measureTotal: () => 10_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c216g");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const calls0 = (engine.compactCalls ?? []).length;
  await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  const calls1 = (engine.compactCalls ?? []).length;
  if (calls1 !== calls0) throw new Error("压力不足时 pressure 不该真的 fold");

  await engine.compactIfNeeded({ session, options: {} }, "archive", undefined);
  if ((engine.compactCalls ?? []).length <= calls1) throw new Error("archive 必须绕过压力门槛真的折一次");
};

tests["C216 closeoutNow（面板补账入口）：await 到折叠真的出结果，不是 fire-and-forget"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-closeout-now");
  // 压力只用了 10K（阈值远高于此）：走的是「强制收尾」而不是 pressure
  const ctx = makeCtx({ measureTotal: () => 10_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 5, closeoutTimeoutMs: 5000 });
  const session = await p22Session(ctx, "sess-c216h");
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  const before = (engine.compactCalls ?? []).length;
  const r = await engine.closeoutNow({ session, options: {} });
  if (!r || r.ok !== true) throw new Error(`closeoutNow 必须返回结果，实际 ${JSON.stringify(r)}`);
  if (r.folded !== true) throw new Error(`closeoutNow 必须真的折了（folded），实际 ${JSON.stringify(r)}`);
  if ((engine.compactCalls ?? []).length <= before) throw new Error("closeoutNow 返回前必须已经调用过 compactRegion");

  const g = await readGraphReplayed(dir, "sess-c216h");
  if (g.closeout?.source !== "backfill") throw new Error(`closeout.source 应为 backfill，实际 ${JSON.stringify(g.closeout)}`);
  if (g.closeout.folded !== true) throw new Error("closeout 必须记下这次到底折没折（folded）");
};

tests["C216 归档收尾不会碰「启动前就已归档」的历史会话（没有会话对象 ⇒ 不白跑模型）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c216-history");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, closeoutMinEvents: 1, closeoutTimeoutMs: 2000 });
  await p22Session(ctx, "sess-c216c");
  await ctx.emitRaw("agent/status", { agent: { session: makeSession({ id: "sess-c216d" }) }, status: "idle" });
  const callsBefore = (engine.compactCalls ?? []).length;
  // 一次无关的 workspace 变更，携带了 26 个历史归档 id（真机就是这个规模）
  const history = Array.from({ length: 26 }, (_, i) => `session-archived-${i}`);
  await ctx.emitRaw("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: history } });
  await new Promise((r) => setTimeout(r, 120));
  if ((engine.compactCalls ?? []).length !== callsBefore) throw new Error("历史归档不许触发收尾折叠");
};

tests["C214 手动压缩入口必须「摘下方法也能调」：compactNow/compactRegion 在构造时就绑定到实例"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c214-bind");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c214");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  // ① 摘下来的方法（模拟 command-compact 之类把函数拿走再调）
  const detachedNow = engine.compactNow;
  const detachedRegion = engine.compactRegion;
  if (detachedNow !== undefined) {
    // 桩基类 compactNow 返回 null；关键是「不许抛 Receiver must be an instance…」
    await detachedNow({ session, options: {} }, undefined, "cmd-test");
  }
  const nodes = session.surface.nodes;
  await detachedRegion(nodes[1], nodes[nodes.length - 1], { session, options: {} }, undefined);

  // ② bind 之后，方法不再是「未绑定」状态：调用它不需要靠调用方给 this
  if (Object.prototype.hasOwnProperty.call(engine.compactNow, "prototype")) throw new Error("绑定后的 compactNow 不该是普通函数（应是 bound function）");
  if (Object.prototype.hasOwnProperty.call(engine.compactRegion, "prototype")) throw new Error("compactRegion 也必须是 bound function");
  if (typeof engine.compactIfNeeded !== "function") throw new Error("compactIfNeeded 仍必须可调用");
};

tests["C215 就算整个对象被换成代理：入口方法也能按 ctx 反查真身（不再抛 Receiver must be an instance）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "c215-proxy");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1 });
  const session = await p22Session(ctx, "sess-c215");
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });

  // 模拟「宿主持有的是代理对象」：只有 ctx，方法来自原型
  const proxyLike = { ctx, compactNow: Engine.prototype.compactNow, compactRegion: Engine.prototype.compactRegion };
  // ① 原型方法 + 外来 this ⇒ 必须转调真身而不是抛私有品牌错误
  await proxyLike.compactNow.call(proxyLike, { session, options: {} }, undefined, "cmd-proxy");
  const nodes = session.surface.nodes;
  await proxyLike.compactRegion.call(proxyLike, nodes[1], nodes[nodes.length - 1], { session, options: {} }, undefined);

  // ② 真身仍可用（guard 不能把正常路径带坏）—— 已经折过，返回 null 也算正常，**不许抛**
  const again = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!(again === null || again === undefined || typeof again === "object")) throw new Error(`真身调用必须返回对象或 null，实际 ${typeof again}`);
  // ③ 没有 ctx 登记的陌生 this：回退到原样执行（guard 不许凭空造 owner）
  const stranger = { ctx: {} };
  const owner = Object.getPrototypeOf(Engine.prototype);
  if (typeof owner?.compactNow === "function") {
    // 桩基类可调用；关键是「不因为 guard 抛异常」
    await Engine.prototype.compactNow.call(stranger, { session, options: {} }, undefined, "cmd-stranger");
  }
};

tests["C242 永久性错误（400/401/402）不值得重试：判别式 + 顶到最大退避 + 下次强制规则摘要"] = async () => {
  const { mod } = await load();
  const isPermanent = mod.isPermanentSummaryError;
  if (typeof isPermanent !== "function") throw new Error("isPermanentSummaryError 必须导出（可测）");
  // 该判「永久」的
  for (const msg of [
    "401 - Authentication Fails",
    "402 - Insufficient Balance",
    "400 - Invalid Format: bad body",
    "provider error: invalid api key",
    '{"code":401,"message":"Unauthorized"}',
  ]) {
    if (isPermanent(msg) !== true) throw new Error(`应判永久性错误：${msg}`);
  }
  // 不该判「永久」的（429/503 是"等一会儿可能就好"）
  for (const msg of ["429 - Rate Limit Reached", "503 - Server Overloaded", "500 - Server Error", "socket hang up", "", null]) {
    if (isPermanent(msg) !== false) throw new Error(`不该判永久性错误：${String(msg)}`);
  }
  // 反证：数字必须整段匹配，别把 "1401 tokens" 当成 401
  if (isPermanent("shadowed 1401 tokens") !== false) throw new Error("1401 不该命中 401");

  // 接线守卫（静态）：判别式必须真的被用上 —— 两处，缺一处这个候选就是摆设。
  const nodeFs2 = await import("node:fs");
  const src = nodeFs2.readFileSync("src/engine.mjs", "utf8");
  if (!/if \(isPermanentSummaryError\(st\.lastFoldError\)\)/.test(src)) {
    throw new Error("失败分支必须按永久性错误分类");
  }
  if (!/const mode = forcedRules \? "rules" : this\.chess\.summaryMode;/.test(src)) {
    throw new Error("summarize 必须消费 forceRulesNext（消费后清标记）");
  }
};

tests["C244 over-budget 必须按档位归因（落在 L5 = 设计内，落在 L0–L3 = 还有空间）"] = async () => {
  const { mod } = await load();
  const acc = mod.accumulateLedgerBudget;
  if (typeof acc !== "function") throw new Error("accumulateLedgerBudget 必须导出");
  let stats = {};
  // 两次 L4 超预算 + 一次 L5 超预算 + 一次正常（不记）
  stats = acc(stats, { fallback: "over-budget", level: 4, overBudgetBy: 30, provenanceCoverage: 1 }, 1);
  stats = acc(stats, { fallback: "over-budget", level: 4, overBudgetBy: 20, provenanceCoverage: 1 }, 2);
  stats = acc(stats, { fallback: "over-budget", level: 5, overBudgetBy: 90, provenanceCoverage: 1 }, 3);
  stats = acc(stats, { fallback: "none", level: 1, overBudgetBy: 0, provenanceCoverage: 1 }, 4);
  const by = stats.overByLevel;
  if (!by || typeof by !== "object") throw new Error("必须落 overByLevel 字段");
  if (by.L4 !== 2) throw new Error(`L4 应为 2，实际 ${by.L4}`);
  if (by.L5 !== 1) throw new Error(`L5 应为 1，实际 ${by.L5}`);
  if (by.L1 !== undefined) throw new Error("预算内的渲染不该进 overByLevel");
  // 档位越界要夹紧（不许写出 L9 这种键）
  const clamped = acc({}, { fallback: "over-budget", level: 9, overBudgetBy: 1, provenanceCoverage: 1 }, 5);
  if (!clamped.overByLevel.L5) throw new Error("level 必须夹紧到 0..5");
};

tests["C245 over-budget 要区分成因：约束/根目标占大半（压不动）vs 内容占大头（还能压）"] = async () => {
  const { mod } = await load();
  const acc = mod.accumulateLedgerBudget;
  // 579 tok 里 unyielding 260 ⇒ 45% ⇒ 约束占大头
  let s1 = acc({}, { fallback: "over-budget", level: 4, tokens: 579, unyieldingTokens: 260, overBudgetBy: 79, provenanceCoverage: 1 }, 1);
  if (s1.overByCause?.constraints !== 1) throw new Error(`应记为 constraints，实际 ${JSON.stringify(s1.overByCause)}`);
  // unyielding 只占 10% ⇒ 内容占大头（这份还有压缩空间）
  let s2 = acc(s1, { fallback: "over-budget", level: 5, tokens: 600, unyieldingTokens: 60, overBudgetBy: 100, provenanceCoverage: 1 }, 2);
  if (s2.overByCause?.content !== 1) throw new Error(`应记为 content，实际 ${JSON.stringify(s2.overByCause)}`);
  if (s2.overByCause.constraints !== 1) throw new Error("两类要分别累计，不许互相覆盖");
  // 预算内的渲染不记
  let s3 = acc(s2, { fallback: "none", level: 1, tokens: 300, unyieldingTokens: 200, overBudgetBy: 0, provenanceCoverage: 1 }, 3);
  if ((s3.overByCause.constraints ?? 0) + (s3.overByCause.content ?? 0) !== 2) throw new Error("预算内不许进 overByCause");
};

tests["C288 收尾折叠预检：尾巴估值超过上限时不许去打那个必败的模型请求"] = async () => {
  const { mod } = await load();
  if (typeof mod.closeoutExceedsLimit !== "function") throw new Error("必须导出纯判定 closeoutExceedsLimit");
  if (mod.CLOSEOUT_MAX_FOLD_TOKENS !== 150_000) throw new Error(`上限应为 150k，实际 ${mod.CLOSEOUT_MAX_FOLD_TOKENS}`);

  // 1000 tok/事件 × 尾巴 199900 ≈ 2e8 tok ⇒ 远超上限
  const big = { nodes: { n1: { seq: 200_000 } }, foldMarks: [{ seqStart: 0, seqEnd: 100, shadowedTokens: 100_000 }] };
  const bigVerdict = mod.closeoutExceedsLimit(big);
  if (bigVerdict === null) throw new Error("大尾巴必须被判为过大");
  if (!(bigVerdict.est > mod.CLOSEOUT_MAX_FOLD_TOKENS)) throw new Error(`估值应超上限：${JSON.stringify(bigVerdict)}`);
  if (!Number.isFinite(bigVerdict.tail)) throw new Error("要带回尾巴事件数（日志要用）");

  // 10 tok/事件 × 尾巴 20 ⇒ 远低于上限
  const small = { nodes: { n1: { seq: 120 } }, foldMarks: [{ seqStart: 0, seqEnd: 100, shadowedTokens: 1_000 }] };
  if (mod.closeoutExceedsLimit(small) !== null) throw new Error("小尾巴不该被判为过大");

  // 估不出来（没有历史 fold）⇒ null，不许瞎猜
  if (mod.closeoutExceedsLimit({ nodes: { n1: { seq: 99_999 } }, foldMarks: [] }) !== null) throw new Error("没有历史 fold ⇒ 判 null");
  if (mod.closeoutExceedsLimit(null) !== null) throw new Error("null 图 ⇒ null");

  // 源码接线：跳过路径必须写日志、且**不许**写 g.closeout（写了会永久挡住以后补账）
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "engine.mjs"), "utf8");
  const block = src.slice(src.indexOf("#closeoutTooBig(graph)"), src.indexOf("async #closeoutFold"));
  if (!block.includes("closeoutExceedsLimit")) throw new Error("私有方法必须委托给纯判定");
  const skip = src.slice(src.indexOf("const tooBig = this.#closeoutTooBig"), src.indexOf("const limitMs"));
  if (skip.includes(".closeout =")) throw new Error("预检路径不许写 g.closeout");
  if (!src.includes("归档收尾跳过")) throw new Error("跳过时必须写日志说明原因");
};

tests["C289 分段收尾：过大的尾巴要切成首尾相接、每段不超上限的若干块"] = async () => {
  const { mod } = await load();
  if (typeof mod.planCloseoutChunks !== "function") throw new Error("必须导出 planCloseoutChunks");

  // 1000 tok/事件、单段上限 150k ⇒ 每段 150 事件；尾巴 13785 事件 ⇒ 6 段封顶（36 万事件以内都够）
  const chunks = mod.planCloseoutChunks({ fromSeq: 1000, tail: 13_785, tokensPerEvent: 1000 });
  if (chunks.length === 0) throw new Error("必须切出段");
  if (chunks.length > 6) throw new Error(`段数必须有上限（默认 6），实际 ${chunks.length}`);
  // 首尾相接 + 不越界
  let cursor = 1000;
  for (const c of chunks) {
    if (c.start !== cursor) throw new Error(`段必须首尾相接：期望 ${cursor}，实际 ${c.start}`);
    if (c.end <= c.start) throw new Error("段的 end 必须大于 start");
    if (c.estTokens > mod.CLOSEOUT_MAX_FOLD_TOKENS) throw new Error(`单段估值超上限：${c.estTokens}`);
    cursor = c.end;
  }
  if (cursor > 1000 + 13_785) throw new Error("不许折到尾巴之外");

  // 尾巴小 ⇒ 一段就够
  const one = mod.planCloseoutChunks({ fromSeq: 0, tail: 50, tokensPerEvent: 100 });
  if (one.length !== 1) throw new Error(`小尾巴应一段：${JSON.stringify(one)}`);
  if (one[0].end !== 50) throw new Error("一段要覆盖整个尾巴");

  // 缺 tokensPerEvent（估不出来）⇒ 不切（不许瞎猜）
  if (mod.planCloseoutChunks({ fromSeq: 0, tail: 1000, tokensPerEvent: null }).length !== 0) {
    throw new Error("没有估值时不许切段");
  }
  if (mod.planCloseoutChunks({ fromSeq: 0, tail: 0, tokensPerEvent: 100 }).length !== 0) throw new Error("尾巴 0 ⇒ 不切");

  // 接线：超限路径必须真的走分段，而不是直接跳过
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "engine.mjs"), "utf8");
  if (!src.includes("归档收尾分段折叠")) throw new Error("超限时必须走分段折叠并写日志");
  if (!src.includes("this.compactRegion(start, end, this.#asAgent(target)")) throw new Error("每段必须真的调 compactRegion");
};

tests["C291 分段收尾必须受同一个超时预算（不能绕开 closeoutTimeoutMs）"] = () => {
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "engine.mjs"), "utf8");
  if (!src.includes("deadline: Date.now() + limitMs")) throw new Error("分段循环必须用同一个 limitMs 算 deadline");
  if (!src.includes("runChunkedCloseout")) throw new Error("分段循环必须走可测的 runChunkedCloseout");
  const log = src.slice(src.indexOf("结束原因"), src.indexOf("结束原因") + 400);
  if (!log.includes("预算")) throw new Error("到点时要说明用满了预算");
};


tests["C296 分段收尾三种结局必须真的跑出来（全部成功 / 中途抛错 / 时间用完）"] = async () => {
  const { mod } = await load();
  if (typeof mod.runChunkedCloseout !== "function") throw new Error("必须导出 runChunkedCloseout");
  const chunks = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 30 },
  ];

  // ① 全部成功
  const okCalls = [];
  const okOut = await mod.runChunkedCloseout({
    chunks,
    deadline: Date.now() + 60_000,
    fold: async (start, end) => {
      okCalls.push([start, end]);
    },
  });
  if (okOut.folded !== 3 || okOut.stopped !== "done") throw new Error(`全部成功应 folded=3/done：${JSON.stringify(okOut)}`);
  if (JSON.stringify(okCalls) !== JSON.stringify([[0, 10], [10, 20], [20, 30]])) {
    throw new Error(`每段都要被调、且顺序正确：${JSON.stringify(okCalls)}`);
  }

  // ② 第二段抛错：第一段的成果必须保留，且 stop 记为 error
  const errOut = await mod.runChunkedCloseout({
    chunks,
    deadline: Date.now() + 60_000,
    fold: async (start) => {
      if (start === 10) throw new Error("boom");
    },
  });
  if (errOut.folded !== 1) throw new Error(`出错前的段必须保留：folded=${errOut.folded}`);
  if (errOut.stopped !== "error") throw new Error(`应记 error：${errOut.stopped}`);
  if (!(errOut.error instanceof Error)) throw new Error("要把错误带出来（日志要用）");

  // ③ 时间用完：第一段跑完后 deadline 已过 ⇒ 不再继续
  let t = 0;
  const timeOut = await mod.runChunkedCloseout({
    chunks,
    deadline: 100,
    now: () => t,
    fold: async () => {
      t = 200; // 这一段"花掉了"超过预算的时间
    },
  });
  if (timeOut.folded !== 1) throw new Error(`只用了一段：folded=${timeOut.folded}`);
  if (timeOut.stopped !== "deadline") throw new Error(`应记 deadline：${timeOut.stopped}`);

  // ④ 空清单：不调 fold，直接 done
  const emptyOut = await mod.runChunkedCloseout({ chunks: [], deadline: Date.now() + 1000, fold: async () => {} });
  if (emptyOut.folded !== 0 || emptyOut.stopped !== "done") throw new Error(`空清单应 0/done：${JSON.stringify(emptyOut)}`);
};
