/**
 * manual-fold.test.mjs —— 手动压缩命令 `/fold`（R17，方案 2）
 *
 * 三层：
 *   ① **纯决策层**（R17 `src/rooms/manual-fold.mjs`）：输入解析 / 能不能压 / 文案。
 *      这一层不碰宿主，断言的是**判据顺序**与「拿不到的数不许写成 0」。
 *   ② **命令接线**（engine）：`/fold` 真的注册进 `ctx.commands`，
 *      且**没有 commands 服务时压缩主路径一个字节不变**（不抛、不挂）。
 *   ③ **端到端**：用 harness 的假 ctx 跑 `foldNow` —— 回合开着必拒、没有区间必拒、
 *      正常路径真的调了 `compactRegion` 且返回人话。
 *
 * 为什么要有 ②③：R17 的价值全在「用户敲 /fold 会发生什么」。
 * 只测纯函数会漏掉「命令根本没注册上」「注册了但 handler 抛错」这两类真事故。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOLD_COMMAND_NAME,
  FOLD_COMMAND_DESCRIPTION,
  FOLD_USAGE,
  MANUAL_FOLD_KINDS,
  parseFoldInput,
  decideManualFold,
  renderFoldSuccess,
  renderFoldNoop,
} from "../src/rooms/manual-fold.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.join(HERE, "..", "src", "engine.mjs");

/**
 * 造 engine 副本（把 4 个宿主包换成同目录 stub），与 `engine-harness.test.mjs` 同一套做法。
 *
 * 为什么本文件自己造而不是复用 harness 的：`run.mjs` 按文件名过滤，
 * 单跑 `manual-fold` 时 harness 根本没被执行过 ⇒ 副本不存在（实测 ERR_MODULE_NOT_FOUND）。
 * 副本必须落在 `src/` 旁边，否则 engine 里的 `./rooms/*.mjs` 相对 import 会断。
 */
async function loadEngine() {
  const stubs = nodePath.join(HERE, "..", "src", ".harness-stubs");
  nodeFs.mkdirSync(stubs, { recursive: true });
  const w = (name, body) => nodeFs.writeFileSync(nodePath.join(stubs, name), body, "utf8");
  // 这几个 stub 与 engine-harness 逐字一致（谁改了都要两边同时改 —— 它们是宿主契约的镜像）。
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
  blocks() { return [{ type: "text", text: (globalThis.__D460_SUMMARY_TEXT__ ?? "## 目标\\n- mock summary") }]; }
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
  const patched = nodeFs
    .readFileSync(SRC, "utf8")
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm.mjs"`);
  nodeFs.writeFileSync(nodePath.join(HERE, "..", "src", ".engine-under-test.mjs"), patched, "utf8");
  return import(pathToFileURL(nodePath.join(HERE, "..", "src", ".engine-under-test.mjs")).href);
}

export const tests = {
  /* ───────────────────────── ① 纯决策层 ───────────────────────── */

  "MF-1 命令元数据：名字合宿主正则、描述非空（宿主 register 会直接抛 TypeError 的两条）"(t) {
    // 宿主 `dsh-commands` 的判据：COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
    t.eq(/^[a-z][a-z0-9_-]*$/.test(FOLD_COMMAND_NAME), true, `命令名 ${FOLD_COMMAND_NAME} 必须匹配宿主正则`);
    t.eq(FOLD_COMMAND_NAME, "fold", "命令名必须是 fold（方案 2 的对外契约）");
    t.eq(typeof FOLD_COMMAND_DESCRIPTION, "string", "描述必须是字符串");
    t.eq(FOLD_COMMAND_DESCRIPTION.trim().length > 0, true, "描述不许为空（宿主会抛 TypeError）");
    t.eq(FOLD_USAGE, "Usage: /fold (no arguments)", "用法提示与官方 /compact 同形");
    t.eq(MANUAL_FOLD_KINDS.includes("ok"), true, "分类表必须含 ok");
    t.eq(MANUAL_FOLD_KINDS.includes("open-turn"), true, "分类表必须含 open-turn");
  },

  "MF-2 parseFoldInput：无参数通过；任何参数一律回 USAGE（不静默忽略）"(t) {
    t.eq(parseFoldInput(""), { ok: true }, "空输入");
    t.eq(parseFoldInput("   "), { ok: true }, "纯空白也算无参数");
    t.eq(parseFoldInput(undefined), { ok: true }, "undefined 安全");
    t.eq(parseFoldInput(null), { ok: true }, "null 安全");
    for (const bad of ["now", " 1", "\nfoo", "x"]) {
      const r = parseFoldInput(bad);
      t.eq(r.ok, false, `${JSON.stringify(bad)} 必须被拒`);
      t.eq(r.kind, "args", "分类必须是 args");
      t.eq(r.text, FOLD_USAGE, "必须回 USAGE");
    }
  },

  "MF-3 decideManualFold：判据顺序是 busy-lock → open-turn → nothing → below-minimum → ok"(t) {
    // 全绿
    const ok = decideManualFold({ openTurn: false, lockActive: false, range: { start: 10, end: 20, shadowedTokens: 50_000 }, minFoldTokens: 8_000 });
    t.eq(ok.kind, "ok", "条件齐了必须 ok");
    t.eq(ok.ok, true, "ok 必须为 true");
    t.eq(ok.detail.shadowedTokens, 50_000, "detail 带原始数字");
    // 锁优先于回合（更根本的那一条先报）
    const lock = decideManualFold({ openTurn: true, lockActive: true, range: { start: 1, end: 2, shadowedTokens: 9e9 } });
    t.eq(lock.kind, "busy-lock", "锁在飞时先报 busy-lock（哪怕回合也开着）");
    // 回合
    const turn = decideManualFold({ openTurn: true, lockActive: false, range: { start: 1, end: 2, shadowedTokens: 9e9 } });
    t.eq(turn.kind, "open-turn", "回合开着必须拒");
    t.includes(turn.text, "回合还开着", "open-turn 必须说清原因");
    t.includes(turn.text, "/fold", "open-turn 必须给出下一步动作");
    // 没区间
    const none = decideManualFold({ openTurn: false, lockActive: false, range: null });
    t.eq(none.kind, "nothing-to-fold", "没有区间");
    // 区间太小
    const small = decideManualFold({ openTurn: false, lockActive: false, range: { start: 1, end: 2, shadowedTokens: 100 }, minFoldTokens: 8_000 });
    t.eq(small.kind, "below-minimum", "低于最小量");
    t.includes(small.text, "100", "below-minimum 必须报出实际数字");
    t.includes(small.text, "8000", "below-minimum 必须报出门槛");
    // minFoldTokens=0 ⇒ 不设门槛
    const noFloor = decideManualFold({ openTurn: false, lockActive: false, range: { start: 1, end: 2, shadowedTokens: 1 }, minFoldTokens: 0 });
    t.eq(noFloor.kind, "ok", "minFoldTokens=0 时不许拦");
    // 默认参数安全
    t.eq(decideManualFold().kind, "nothing-to-fold", "无参调用不许抛");
  },

  "MF-4 renderFoldSuccess：每个数字都来自宿主结果，拿不到的写「未知」而不是 0"(t) {
    const full = renderFoldSuccess(
      { shadowedSeqs: [1, 2, 3], shadowedRange: { start: 10, end: 20 }, shadowedTokenCount: 1234, summarySeq: 99 },
      5000,
    );
    t.includes(full, "3 条历史", "条数");
    t.includes(full, "seq 10–20", "区间");
    t.includes(full, "1234", "遮蔽 token");
    t.includes(full, "5000", "折叠后 token");
    // 拿不到 shadowedTokenCount ⇒ 明说未知，不许出现 "0 tokens"
    const unknown = renderFoldSuccess({ shadowedSeqs: [], shadowedRange: { start: 1, end: 2 } }, null);
    t.includes(unknown, "未知", "拿不到必须写未知");
    t.eq(/0 tokens/.test(unknown), false, "绝不许把「没测到」写成 0");
    t.eq(unknown.includes("压缩后"), false, "tokensAfter 为 null 时不许编一个数");
    // 空结果也不许抛
    t.eq(typeof renderFoldSuccess(null, null), "string", "null 结果必须安全");
  },

  "MF-5 renderFoldNoop：below-minimum 原样透传理由，其余给一句「无需压缩」"(t) {
    const below = decideManualFold({ range: { start: 1, end: 2, shadowedTokens: 5 }, minFoldTokens: 100 });
    t.eq(renderFoldNoop(below), below.text, "below-minimum 的理由必须原样透传");
    t.includes(renderFoldNoop({ kind: "nothing-to-fold" }), "没有可折", "其余给一句人话");
    t.eq(typeof renderFoldNoop(null), "string", "null 安全");
  },

  /* ───────────────────────── ② 命令接线 ───────────────────────── */

  "MF-6 有 commands 服务时 /fold 真的注册上（名字/描述/handler 三件套齐全）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const registered = [];
      const ctx = makeCtx({ commands: { register: (def) => { registered.push(def); return () => {}; } } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      t.eq(registered.length, 1, "必须注册且只注册一次");
      t.eq(registered[0].name, FOLD_COMMAND_NAME, "命令名");
      t.eq(registered[0].description, FOLD_COMMAND_DESCRIPTION, "描述");
      t.eq(typeof registered[0].handler, "function", "handler 必须是函数");
      engine.dispose?.();
    })();
  },

  "MF-7 没有 commands 服务时：不抛、不注册、压缩主路径照常（可选命令不许拖垮引擎）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const ctx = makeCtx({ commands: undefined });
      let engine = null;
      let threw = null;
      try {
        engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      } catch (error) {
        threw = error;
      }
      t.eq(threw, null, `没有 commands 时构造不许抛，实际 ${threw?.message}`);
      t.ok(engine !== null, "引擎必须照常构造出来");
      t.eq(typeof engine.foldNow, "function", "foldNow 必须仍然可用（只是没有命令入口）");
      engine.dispose?.();
    })();
  },

  "MF-8 同一个 ctx 里第二个引擎不许重复注册（宿主同名会抛 already registered）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const registered = [];
      const ctx = makeCtx({ commands: { register: (def) => { registered.push(def); return () => {}; } } });
      const a = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      const b = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      t.eq(registered.length, 1, "同一 ctx 只许注册一次");
      a.dispose?.();
      b.dispose?.();
    })();
  },

  /* ───────────────────────── ③ 端到端 ───────────────────────── */

  "MF-9 foldNow：回合开着必拒（open-turn），且**不**调 compactRegion（不许白花一次模型调用）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const ctx = makeCtx({ commands: { register: () => () => {} } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      const session = makeSession("fold-open-turn");
      session.append("turn/start", { turn: 1 });
      for (let i = 0; i < 12; i += 1) session.seed("user", `step ${i}`);
      const calls = [];
      engine.compactRegion = async (s, e) => { calls.push([s, e]); return { shadowedSeqs: [], shadowedRange: { start: s, end: e }, shadowedTokenCount: 0 }; };
      const out = await engine.foldNow({ session }, new AbortController().signal);
      t.eq(out.kind, "open-turn", `回合开着必须是 open-turn，实际 ${out.kind}`);
      t.eq(calls.length, 0, "被拒时绝不许调 compactRegion");
      t.includes(out.text, "回合还开着", "必须说清原因");
      engine.dispose?.();
    })();
  },

  "MF-10 foldNow：回合已结束 + 有区间 ⇒ 真的折了，返回人话且带 summarySeq"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const ctx = makeCtx({ commands: { register: () => () => {} } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules", minFoldTokens: 0, retainTokens: 0 });
      const session = makeSession("fold-ok");
      session.append("turn/start", { turn: 1 });
      for (let i = 0; i < 20; i += 1) session.seed("user", `step ${i}`);
      session.append("turn/end", { turn: 1 });
      const calls = [];
      engine.compactRegion = async (s, e) => {
        calls.push([s, e]);
        return { shadowedSeqs: [s, e], shadowedRange: { start: s, end: e }, shadowedTokenCount: 4242, summarySeq: 777 };
      };
      const out = await engine.foldNow({ session }, new AbortController().signal);
      t.eq(out.kind, "ok", `应当成功，实际 ${out.kind}：${out.text}`);
      t.eq(calls.length, 1, "必须恰好折一次");
      t.eq(out.summarySeq, 777, "summarySeq 必须透传（命令结果要用它做 sourceEventSeq）");
      t.includes(out.text, "4242", "文案必须带遮蔽 token");
      engine.dispose?.();
    })();
  },

  "MF-11 foldNow：没有可折区间 ⇒ nothing-to-fold，不调 compactRegion"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      const ctx = makeCtx({ commands: { register: () => () => {} } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      const session = makeSession("fold-empty");
      session.append("turn/start", { turn: 1 });
      session.append("turn/end", { turn: 1 });
      const calls = [];
      engine.compactRegion = async (s, e) => { calls.push([s, e]); return null; };
      const out = await engine.foldNow({ session }, new AbortController().signal);
      t.eq(calls.length, 0, "没区间时不许调 compactRegion");
      t.eq(out.kind === "ok", false, "没区间不许报成功");
      t.eq(typeof out.text, "string", "必须给出人话");
      t.eq(out.text.trim().length > 0, true, "文案不许为空");
      engine.dispose?.();
    })();
  },

  "MF-12 命令 handler：带参数回 USAGE（error 结果，text 非空 —— 宿主硬要求）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      let handler = null;
      const ctx = makeCtx({ commands: { register: (def) => { handler = def.handler; return () => {}; } } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules" });
      t.eq(typeof handler, "function", "handler 必须注册上");
      const session = makeSession("fold-args");
      const out = await handler({ agent: { session }, rawInput: " now", signal: new AbortController().signal, commandId: "cmd-1" });
      t.eq(out.kind, "error", "带参数必须是 error");
      t.eq(out.text, FOLD_USAGE, "必须是 USAGE");
      t.eq(out.text.trim().length > 0, true, "宿主要求 error text 非空");
      engine.dispose?.();
    })();
  },

  "MF-13 命令 handler：成功时返回 success + 合法 sourceEventSeq（宿主会校验非负安全整数）"(t) {
    return (async () => {
      const { default: Engine } = await loadEngine();
      let handler = null;
      const ctx = makeCtx({ commands: { register: (def) => { handler = def.handler; return () => {}; } } });
      const engine = new Engine(ctx, { auto: false, graphDir: makeGraphDir(), summaryMode: "rules", minFoldTokens: 0, retainTokens: 0 });
      const session = makeSession("fold-success");
      session.append("turn/start", { turn: 1 });
      for (let i = 0; i < 20; i += 1) session.seed("user", `step ${i}`);
      session.append("turn/end", { turn: 1 });
      engine.compactRegion = async (s, e) => ({ shadowedSeqs: [s, e], shadowedRange: { start: s, end: e }, shadowedTokenCount: 100, summarySeq: 42 });
      const out = await handler({ agent: { session }, rawInput: "", signal: new AbortController().signal, commandId: "cmd-2" });
      t.eq(out.kind, "success", `应当成功，实际 ${out.kind}：${out.text}`);
      t.eq(out.sourceEventSeq, 42, "sourceEventSeq 必须是 summarySeq");
      t.eq(Number.isSafeInteger(out.sourceEventSeq) && out.sourceEventSeq >= 0, true, "宿主要求非负安全整数");
      t.eq(typeof out.text, "string", "success text 必须是字符串");
      engine.dispose?.();
    })();
  },
};

/* ───────────────────────── 夹具 ───────────────────────── */

let graphSeq = 0;
function makeGraphDir() {
  graphSeq += 1;
  const dir = nodePath.join(HERE, ".harness", "graphs", `manual-fold-${process.pid}-${graphSeq}`);
  nodeFs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** 最小的假 ctx：只给 engine 构造与 /fold 用得到的东西。 */
function makeCtx({ commands } = {}) {
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    sessions: { async flush() {} },
    /**
     * ★ 必须给 tokenMeter：`#planManualFold` 拿不到它就返回 `{range:null}`，
     *   于是「有区间」的用例会全被判定成 nothing-to-fold（MF-10/MF-13 第一版就是这么红的）。
     *   这里按**每个 surface 节点 20k tokens** 计价 —— 与 test/manual-compact.test.mjs 的探针同口径。
     */
    tokenMeter: {
      measure(session) {
        const nodes = session.surface.nodes.map((s) => ({ seq: s, tokens: 20_000, heuristicTokens: 20_000 }));
        return { totalTokens: nodes.length * 20_000, surfaceTokens: nodes.length * 20_000, nodes };
      },
      estimateMessage() {
        return 500;
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 };
      },
      async *stream() {
        yield { type: "text-delta", text: "## 目标\n- mock" };
        yield { type: "finish", kind: "stop" };
      },
    },
    on() {},
    effect() {},
    /**
     * ★ 真机实测（2026-11-25，隔离实例 3099）：引擎读 `ctx.commands` 会被 cordis 拒绝
     *   （`cannot get property "commands" without inject`），必须走 `ctx.get("commands")`。
     *   所以夹具**只**提供 `get`，并且**故意不**提供 `ctx.commands` —— 这样一旦引擎退回
     *   直接属性读取，MF-6/8/12/13 会立刻红（真机同款失败）。
     */
    get(name) {
      return name === "commands" ? commands : undefined;
    },
  };
  return ctx;
}

/** 假 session：surface + 事件日志 + tokenMeter 需要的形状（与 engine-harness 同形）。 */
function makeSession(id) {
  let seq = 0;
  const log = [];
  const nodes = [];
  const session = {
    id,
    cwd: process.cwd(),
    surface: { nodes, get replaceGeneration() { return 0; } },
    get seq() {
      return seq;
    },
    nextSeq: () => seq++,
    eventAt: (s) => log[s],
    requestHeader: () => ({ config: { provider: "p", model: "m", maxTokens: 4096 } }),
    toolHistory: () => ({ tools: [] }),
    append(type, data, opts = {}) {
      const s = seq++;
      const event = { type, seq: s, data, ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }) };
      log.push(event);
      const surfaceable = ["system/message", "developer/message", "user/message", "assistant/message", "tool/result"].includes(type);
      if (surfaceable) nodes.push(s);
      return event;
    },
    seed(kind, text) {
      const data = kind === "system" ? {} : { id: `m${seq}`, role: kind, content: [{ type: "text", text }], source: { kind: "prompt" } };
      return session.append(kind === "system" ? "system/message" : `${kind}/message`, data, { surfaceOp: "append" });
    },
  };
  return session;
}
