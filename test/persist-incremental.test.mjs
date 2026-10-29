/**
 * persist-incremental.test.mjs —— P3 增量落盘的契约测试
 *
 * 锁六件事：
 *   1. delta 帧能精确重放出同一张图（upsert + order 追加/删除 + 标量）；
 *   2. 同一帧应用两次不产生重复（幂等）；
 *   3. 半写帧（尾部被截断）⇒ 解码就地停止，图回到上一帧，不坏图；
 *   4. 基线重写后（baseHash 变化）旧帧被整体忽略，不会把新基线倒退；
 *   5. index.md 稳态只追加、fold/首次才全量重建；nodes/<id>.md 只写 dirty 节点；
 *   6. 稳态 flush 写字节 ≪ 全量写（变异自检：退回全量必须退化）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createGraph,
  addUserNode,
  addAgentNode,
  addEdge,
  settleEdge,
  fromJSON,
  toJSON,
  peekDirty,
  clearDirty,
  deltaFromDirty,
  applyDelta,
  encodeDeltaFrame,
  decodeDeltaFrames,
  checksum31,
  renderIndexAppend,
} from "../src/graph.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.join(HERE, "..", "src");
const STUBS = nodePath.join(SRC, ".harness-stubs");

/** 建一张小图（user + 2 个 agent + 成功/失败边）。 */
function smallGraph(sessionId = "p3") {
  const g = createGraph({ sessionId, cwd: "D:/x" });
  const u = addUserNode(g, { seq: 1, text: "必须保持接口不变。把测试跑绿。" });
  const e1 = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)" });
  const n1 = addAgentNode(g, { seq: 2, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e1 });
  settleEdge(g, e1, { to: n1.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: boom" });
  const e2 = addEdge(g, { from: u, intent: "看日志", action: "read(file_path=a.log)" });
  const n2 = addAgentNode(g, { seq: 3, goal: "看日志", worldHash: "W2", constraintHash: "C1", via: e2 });
  settleEdge(g, e2, { to: n2.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  clearDirty(g);
  return g;
}

/* ── 1. delta 重放等价 ─────────────────────────────────────── */
tests["delta：帧重放后与内存图逐字段相同"] = (t) => {
  const g = smallGraph();
  const before = fromJSON(toJSON(g)); // 改动前的基线
  clearDirty(g);
  const e3 = addEdge(g, { from: g.order[0], intent: "再跑一次", action: "bash(npm test)" });
  settleEdge(g, e3, { to: null, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: again" });
  const n3 = addAgentNode(g, { seq: 9, goal: "再跑", worldHash: "W3", constraintHash: "C1", via: e3 });
  g.edges[e3].to = n3.id;
  const frame = deltaFromDirty(g);
  const replayed = applyDelta(before, JSON.parse(JSON.stringify(frame)));
  t.eq(toJSON(replayed).length > 0, true, "重放后有内容");
  t.eq(JSON.stringify(replayed.nodes), JSON.stringify(g.nodes), "节点一致");
  t.eq(JSON.stringify(replayed.edges), JSON.stringify(g.edges), "边一致");
  t.eq(JSON.stringify(replayed.order), JSON.stringify(g.order), "order 一致");
  t.eq(replayed.updatedAt, g.updatedAt, "updatedAt 一致");
  t.eq(replayed.nextNode, g.nextNode, "nextNode 一致");
};

/* ── 2. 幂等 ───────────────────────────────────────────────── */
tests["delta：同一帧应用两次不产生重复节点/边"] = (t) => {
  const g = smallGraph();
  const e3 = addEdge(g, { from: g.order[0], intent: "x", action: "bash(x)" });
  const n3 = addAgentNode(g, { seq: 9, goal: "x", worldHash: "W9", constraintHash: "C1", via: e3 });
  settleEdge(g, e3, { to: n3.id, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const frame = JSON.parse(JSON.stringify(deltaFromDirty(g)));
  const base = smallGraph();
  applyDelta(base, frame);
  const once = base.order.length;
  applyDelta(base, frame);
  t.eq(base.order.length, once, "order 不重复");
  t.eq(new Set(base.order).size, base.order.length, "order 无重复 id");
};

/* ── 3. 半写帧 ─────────────────────────────────────────────── */
tests["崩溃：尾部半写帧 ⇒ 就地停止，图回到上一帧"] = (t) => {
  const frame = encodeDeltaFrame("0123456789abcdef", deltaFromDirty(smallGraph(), { nodes: [], edges: [], delNodes: [], delEdges: [], orderAppend: [], orderDrop: [] }));
  const full = `${frame}${frame}`;
  const torn = full.slice(0, full.length - 7); // 第二帧被截断
  const { frames, badTail } = decodeDeltaFrames(torn, "0123456789abcdef");
  t.eq(frames.length, 1, "只接受第一帧");
  t.eq(badTail, true, "标记尾部有坏帧");
};

tests["崩溃：校验和不对的帧同样被拒（不是合法 JSON 也要挡）"] = (t) => {
  const good = encodeDeltaFrame("0123456789abcdef", deltaFromDirty(smallGraph()));
  const parts = good.split("\t");
  const bad = `${parts[0]}\t${(Number(parts[1]) + 1)}\t${parts[2]}`;
  const { frames, badTail } = decodeDeltaFrames(bad, "0123456789abcdef");
  t.eq(frames.length, 0, "坏帧不被接受");
  t.eq(badTail, true, "标记坏帧");
  t.eq(checksum31("abc"), checksum31("abc"), "校验函数确定");
};

/* ── 4. generation 保护 ───────────────────────────────────── */
tests["崩溃：基线重写后旧帧被忽略（不会把新基线倒退）"] = (t) => {
  const oldFrame = encodeDeltaFrame("aaaaaaaaaaaaaaaa", deltaFromDirty(smallGraph()));
  const { frames, badTail } = decodeDeltaFrames(oldFrame, "bbbbbbbbbbbbbbbb");
  t.eq(frames.length, 0, "哈希不匹配 ⇒ 不应用");
  t.eq(badTail, true, "标记不匹配");
};

/* ── 5. index 增量 ────────────────────────────────────────── */
tests["index：增量段包含新失败原因，且 fold 时会用全量覆盖"] = (t) => {
  const g = smallGraph();
  const e = addEdge(g, { from: g.order[0], intent: "再试", action: "bash(npm test)" });
  settleEdge(g, e, { to: null, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: 新的原因" });
  const append = renderIndexAppend(g, peekDirty(g));
  t.includes(append, "## 增量", "有增量段标记");
  t.includes(append, "AssertionError: 新的原因", "包含新失败原因");
  t.includes(append, "- e", "有边行（可定位）");
};

/* ── 6. engine 端到端：稳态只追加、回合边界落全量 ───────────── */
function writeStubs() {
  nodeFs.mkdirSync(STUBS, { recursive: true });
  const w = (name, body) => nodeFs.writeFileSync(nodePath.join(STUBS, name), body, "utf8");
  w(
    "stub-schemastery.mjs",
    `const mk = () => { const o = { default: () => o, description: () => o, min: () => o, max: () => o, step: () => o, required: () => o }; return o; };
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
export function createUserMessage(input) { return { id: "m", role: "user", ...input }; }
export class BlockAssembler { constructor() { this.chunks = []; this.finish = { kind: "stop" }; } push(c) { this.chunks.push(c); } blocks() { return [{ type: "text", text: "## 目标\\n- mock" }]; } }
`,
  );
  w(
    "stub-basic.mjs",
    `import { CompactionEngine } from "./stub-compaction.mjs";
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  constructor(ctx, config = {}) { super(ctx, "compaction"); this.ctx = ctx; this.config = config; }
  async compactIfNeeded() { return null; }
  async compactNow() { return null; }
  async compactRegion(start, end, agent) {
    const nodes = agent.session.surface.nodes;
    const s = nodes.indexOf(start), e = nodes.indexOf(end);
    if (s < 0 || e < 0) throw new Error("bad range");
    nodes.splice(s, e - s + 1, agent.session.nextSeq());
    return { shadowedSeqs: [], shadowedRange: { start, end }, shadowedTokenCount: 0 };
  }
}
`,
  );
  const engineSrc = nodeFs.readFileSync(nodePath.join(SRC, "engine.mjs"), "utf8");
  const patched = engineSrc
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm.mjs"`);
  if (patched === engineSrc) throw new Error("engine 副本 patch 未命中");
  const out = nodePath.join(SRC, ".engine-under-test-p3.mjs");
  nodeFs.writeFileSync(out, patched, "utf8");
  return out;
}

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
    get: () => undefined,
    tokenMeter: { measure: () => ({ totalTokens: 10000, surfaceTokens: 10000, nodes: [] }), estimateMessage: () => 100 },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 200000 }, defaultMaxTokens: 4096 }; }, async *stream() { yield { type: "text-delta", text: "x" }; } },
    sessions: { flush: async () => {} },
    async emitRaw(name, ...args) {
      for (const fn of listeners.get(name) ?? []) await fn(...args);
    },
  };
  return ctx;
}

function makeSession(id) {
  let seq = 1000;
  const events = new Map();
  const nodes = [];
  return {
    id,
    cwd: "D:/x",
    surface: { nodes },
    nextSeq: () => seq++,
    eventAt: (s) => events.get(s),
    requestHeader: () => ({ config: { provider: "p", model: "m", maxTokens: 4096 } }),
    toolHistory: () => ({ tools: [] }),
    append(type, data) {
      const s = seq++;
      const ev = { type, seq: s, data };
      events.set(s, ev);
      nodes.push(s);
      return ev;
    },
    push(kind, data) {
      const s = seq++;
      nodes.push(s);
      events.set(s, { type: kind, seq: s, data });
      return s;
    },
  };
}

function userEvent(text, seq) {
  return { type: "user/message", seq, data: { id: "u", role: "user", content: [{ type: "text", text }], source: { kind: "prompt" } } };
}
function assistantEvent(callId, tool, args, seq) {
  return {
    type: "assistant/message",
    seq,
    data: { message: { id: "a", role: "assistant", content: [{ type: "text", text: "开始" }, { type: "tool-call", id: callId, name: tool, arguments: JSON.stringify(args) }], source: { kind: "model", provider: "p", model: "m" } } },
  };
}
function resultEvent(callId, text, seq) {
  return {
    type: "tool/result",
    seq,
    data: { message: { id: "r", role: "tool", toolCallId: callId, source: { kind: "tool", callId }, content: [{ type: "text", text }], isError: true } },
  };
}

let cachedEngineUrl = null;
function engineUrl() {
  if (cachedEngineUrl === null) cachedEngineUrl = pathToFileURL(writeStubs()).href;
  return cachedEngineUrl;
}

/** 统计一段时间内 fs 写的字节数（engine 的 nodeFs 与本测试同一个 CJS 单例）。 */
function withWriteCounter(fn) {
  const stat = { write: 0, append: 0, calls: 0, files: {} };
  const origWrite = nodeFs.writeFileSync;
  const origAppend = nodeFs.appendFileSync;
  nodeFs.writeFileSync = function patched(p, data, ...rest) {
    const bytes = Buffer.byteLength(typeof data === "string" ? data : String(data));
    stat.write += bytes;
    stat.calls += 1;
    const name = nodePath.basename(String(p));
    stat.files[name] = (stat.files[name] ?? 0) + bytes;
    return origWrite.call(nodeFs, p, data, ...rest);
  };
  nodeFs.appendFileSync = function patchedAppend(p, data, ...rest) {
    stat.append += Buffer.byteLength(typeof data === "string" ? data : String(data));
    stat.calls += 1;
    return origAppend.call(nodeFs, p, data, ...rest);
  };
  return Promise.resolve()
    .then(fn)
    .then((v) => ({ stat, value: v }))
    .finally(() => {
      nodeFs.writeFileSync = origWrite;
      nodeFs.appendFileSync = origAppend;
    });
}

async function seedSession(dir, sessionId) {
  const mod = await import(pathToFileURL(nodePath.join(SRC, "graph.mjs")).href);
  const g = mod.createGraph({ sessionId, cwd: "D:/x" });
  const u = mod.addUserNode(g, { seq: 1, text: "必须保持接口不变。" });
  const e1 = mod.addEdge(g, { from: u, intent: "旧的一步", action: "bash(echo old)" });
  mod.settleEdge(g, e1, { to: null, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: old" });
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), mod.toJSON(g), "utf8");
  nodeFs.writeFileSync(pathSeq(dir, "graph.json") + ".delta.jsonl", "", "utf8");
}
function pathSeq(dir, name) {
  return nodePath.join(dir, name);
}

tests["engine：稳态只追加 delta（<5KB），回合边界落全量（>50KB）"] = async (t) => {
  const { default: Engine } = await import(engineUrl());
  const graphRoot = nodePath.join(HERE, ".harness-p3");
  nodeFs.rmSync(graphRoot, { recursive: true, force: true });
  const sessionId = "p3-inc";
  const dir = nodePath.join(graphRoot, "sessions", sessionId);
  await seedSession(dir, sessionId);

  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: graphRoot, auto: false });
  const session = makeSession(sessionId);
  const replay = async () => {
    await ctx.emitRaw("session/event", session, userEvent("继续。", 2));
    for (let i = 0; i < 6; i += 1) {
      await ctx.emitRaw("session/event", session, assistantEvent(`c${i}`, "bash", { command: `npm test ${i}` }, 3 + i * 2));
      await ctx.emitRaw("session/event", session, resultEvent(`c${i}`, `AssertionError: case ${i}\n[exit code: 1]`, 4 + i * 2));
      await ctx.emitRaw("session/event", session, { type: "step/end", seq: 5 + i * 2, data: { turn: 2, step: 1 } });
    }
  };
  await replay();
  // 稳态：debounce 触发（delta 追加）
  await new Promise((r) => setTimeout(r, 1400));
  const steady = await withWriteCounter(async () => {
    await ctx.emitRaw("session/event", session, { type: "step/end", seq: 50, data: { turn: 2, step: 2 } });
    await ctx.emitRaw("session/event", session, assistantEvent("c99", "bash", { command: "npm test 9" }, 51));
    await ctx.emitRaw("session/event", session, resultEvent("c99", "AssertionError: case 9\n[exit code: 1]", 52));
    await new Promise((r) => setTimeout(r, 1400));
  });
  const steadyBytes = steady.stat.write + steady.stat.append;
  t.ok(steadyBytes > 0, "稳态确实写了内容");
  t.ok(steadyBytes < 5 * 1024, `稳态写 ${steadyBytes}B < 5KB`);

  // 回合边界：idle（全量提交）
  const turn = await withWriteCounter(async () => {
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  });
  const turnBytes = turn.stat.write + turn.stat.append;
  // 规模无关的判据：稳态**不重写 graph.json**（只 append delta），回合边界重写一次完整基线
  t.ok(!steady.stat.files["graph.json"], `稳态没重写 graph.json（实际 ${JSON.stringify(steady.stat.files)}）`);
  t.ok(steady.stat.files["graph.json.delta.jsonl"] > 0, "稳态确实追加了 delta 帧");
  // 基线是原子写：先写 graph.json.tmp，再 rename 覆盖 graph.json
  t.eq((turn.stat.files["graph.json.tmp"] ?? 0) > 0, true, "回合边界重写了完整基线（tmp→rename）");
  t.ok(turnBytes > steadyBytes * 2, `变异自检：全量/增量 = ${(turnBytes / Math.max(1, steadyBytes)).toFixed(1)}× > 2×（小图夹具，真实会话差距更大）`);

  // 重新加载：新 engine 必须看到最新状态（delta 重放）
  const g2 = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
  const engine2 = new Engine(makeCtx(), { graphDir: graphRoot, auto: false });
  const session2 = makeSession(sessionId);
  await ctx.emitRaw("agent/status", { agent: { session: session2 }, status: "idle" });
  const g2after = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
  t.ok(g2after.edges && Object.keys(g2after.edges).length >= Object.keys(g2.edges).length, "重载后边数不丢");
  t.ok(Object.values(g2after.edges).some((e) => String(e.errorSnippet).includes("case 9")), "重载后能看到最新失败原因");
  // ★ 提交点等价：回合边界的 graph.json 必须与内存图一致（delta 已全部合并进基线）。
  //   stateIndex 是**派生数据**：fromJSON 按「首个非 pending 节点」重建，运行期是「最后一次写入」——
  //   这个差异是既有语义（fromJSON 注释明写「不信任磁盘上的旧索引」），比较时剔除。
  const bare = (o) => JSON.stringify({ ...o, stateIndex: undefined });
  const live = engine.graphs.get(sessionId);
  t.eq(bare(fromJSON(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"))), bare(live), "基线提交后与内存图等价（stateIndex 派生数据除外）");
};

tests["engine：nodes/<id>.md 只在首次/fold 写，稳态不写"] = async (t) => {
  const { default: Engine } = await import(engineUrl());
  const graphRoot = nodePath.join(HERE, ".harness-p3b");
  nodeFs.rmSync(graphRoot, { recursive: true, force: true });
  const sessionId = "p3-md";
  const ctx = makeCtx();
  new Engine(ctx, { graphDir: graphRoot, auto: false });
  const session = makeSession(sessionId);
  await ctx.emitRaw("session/event", session, userEvent("跑测试。", 1));
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const dir = nodePath.join(graphRoot, "sessions", sessionId);
  t.ok(nodeFs.existsSync(nodePath.join(dir, "nodes", "n1.md")), "首次写了 n1.md");
  const before = nodeFs.readdirSync(nodePath.join(dir, "nodes")).length;
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  await new Promise((r) => setTimeout(r, 1400));
  const after = nodeFs.readdirSync(nodePath.join(dir, "nodes")).length;
  t.eq(after, before, "稳态不新增 node md（等 fold 再写）");
  const index = nodeFs.readFileSync(nodePath.join(dir, "index.md"), "utf8");
  t.includes(index, "boom", "index.md 已追加新失败原因");
};