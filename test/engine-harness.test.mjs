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

export function makeCtx({ window = 200_000, measureTotal = () => 10_000, failModels = new Set() } = {}) {
  const listeners = new Map();
  const overlay = {};
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

export function readGraph(graphDir, sessionId) {
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
  // 缺文件 ⇒ 明确「未采集」
  nodeFs.rmSync(file, { force: true });
  const empty = run(home);
  const emptyCheck = empty.checks.find((c) => c.name === "热清单预算（fallback）");
  if (!emptyCheck || !emptyCheck.detail.includes("未采集")) throw new Error(`缺文件必须写「未采集」：${JSON.stringify(emptyCheck)}`);
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

tests["S8-5 fold 次数不增：首折只把第一次提前，之后的判定点与关闭 S8 完全一致"] = async () => {
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
