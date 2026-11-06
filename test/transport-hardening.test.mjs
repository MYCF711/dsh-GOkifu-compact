/**
 * transport-hardening.test.mjs —— TRANSPORT 重试、deadline 硬取消与截断放大组合守卫。
 *
 * 三条都走 `runAutoBackfillOnce → #offlineCloseoutFold → runOfflineFold`，只替换 LLM 为假流：
 *   ① 前两次 finish error 已报告 usage，第三次成功 ⇒ foldMark 必须记三次之和；
 *   ② deadline 返回时必须已通过 AbortSignal 中断原流，不是只让 Promise.race 返回；
 *   ③ 首轮两次 TRANSPORT 后返回截断，放大轮三次 TRANSPORT 全失败 ⇒ 3 × (1 + 1) = 6 次是组合硬上限，六次全进账。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import nodeZlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = nodePath.join(HERE, "..", "src");
const STUBS = nodePath.join(SRC_DIR, ".harness-stubs");
const LLM_STUB = nodePath.join(STUBS, "stub-llm-transport-hardening.mjs");
const ENGINE_COPY = nodePath.join(SRC_DIR, ".engine-under-test-transport-hardening.mjs");

const LLM_SOURCE = `export class LlmError extends Error {
  constructor(message, code, cause) { super(message); this.code = code; this.cause = cause; }
}
export function contentHasImage(blocks) { return Array.isArray(blocks) && blocks.some((b) => b?.type === "image"); }
export function createUserMessage(input) { return { id: "m", role: "user", ...input }; }
export class BlockAssembler {
  constructor() { this.chunks = []; this.finish = { kind: "stop" }; this.usage = undefined; }
  push(chunk) {
    this.chunks.push(chunk);
    if (chunk?.type === "usage") this.usage = chunk.usage;
    if (chunk?.type === "finish") this.finish = chunk.reason ?? chunk.finish ?? { kind: "stop" };
  }
  blocks() {
    const out = [];
    for (const chunk of this.chunks) {
      if (chunk?.type === "text-delta") out.push({ type: "text", text: String(chunk.text ?? "") });
      if (chunk?.type === "reasoning-delta") out.push({ type: "reasoning", text: String(chunk.text ?? "") });
    }
    return out;
  }
}
`;

let cachedEngine = null;
async function loadEngine() {
  if (cachedEngine !== null) return cachedEngine;
  const harness = await import("./engine-harness.test.mjs");
  await harness.load();
  nodeFs.mkdirSync(STUBS, { recursive: true });
  nodeFs.writeFileSync(LLM_STUB, LLM_SOURCE, "utf8");
  const patched = nodeFs
    .readFileSync(nodePath.join(SRC_DIR, "engine.mjs"), "utf8")
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm-transport-hardening.mjs"`);
  nodeFs.writeFileSync(ENGINE_COPY, patched, "utf8");
  cachedEngine = (await import(pathToFileURL(ENGINE_COPY).href)).default;
  return cachedEngine;
}

const BODY = [
  "## 目标",
  "- 把构建跑通，并把每一次已经报告用量的模型调用都记进同一条折痕",
  "",
  "## 已建立事实",
  "- 失败响应也可以已经带 usage；正文是否被采用与是否付费是两个不同问题",
  "- 截断放大最多再开一轮，传输错误每轮最多三次，组合上限因此是六次",
  "- 这段正文刻意超过四百字符，避免最终成功响应再次触发截断放大；".repeat(4),
  "",
  "## 当前节点",
  "- n2：全部假流均已结束，结果已走到离线折叠写回点",
  "",
  "## 约束（逐字）",
  "- 把构建跑通",
].join("\n");

function usageFor(call) {
  return {
    inputTokens: 1000 + call,
    outputTokens: 100 + call,
    totalTokens: 1100 + call * 2,
    cacheReadTokens: call,
    reasoningTokens: call * 2,
  };
}

function sumUsage(list) {
  return {
    inputTokens: list.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: list.reduce((n, u) => n + u.outputTokens, 0),
    totalTokens: list.reduce((n, u) => n + u.totalTokens, 0),
    cacheReadTokens: list.reduce((n, u) => n + u.cacheReadTokens, 0),
    reasoningTokens: list.reduce((n, u) => n + u.reasoningTokens, 0),
  };
}

async function makeRig(kind) {
  const harness = await import("./engine-harness.test.mjs");
  const Engine = await loadEngine();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `gokifu-transport-hardening-${kind}-`));
  const id = `session-transport-hardening-${kind}`;
  const sessionsDir = nodePath.join(home, "sessions", "--ws--", id);
  nodeFs.mkdirSync(sessionsDir, { recursive: true });
  const events = Array.from({ length: 80 }, (_, i) => ({
    seq: i + 1,
    type: i % 2 === 0 ? "user/message" : "assistant/message",
    data: { message: { content: [{ type: "text", text: `第 ${i + 1} 步：把构建跑通` }] } },
  }));
  const logFile = nodePath.join(sessionsDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(
    logFile,
    nodeZlib.zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")),
  );
  const old = new Date(Date.now() - 600_000);
  nodeFs.utimesSync(logFile, old, old);

  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(profileDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(profileDir, "cordis.patch.yml"),
    ["- id: agent-default-model", "  config:", "    provider: mock", "    model: mock-model", ""].join("\n"),
    "utf8",
  );

  const graphDir = nodePath.join(home, "chess-context");
  const graphSessionDir = nodePath.join(graphDir, "sessions", id);
  nodeFs.mkdirSync(graphSessionDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(graphSessionDir, "graph.json"),
    JSON.stringify({
      version: 1,
      sessionId: id,
      cwd: home,
      rootUserNodeIds: ["n1"],
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "把构建跑通", constraints: ["把构建跑通"], ts: 1 },
        n2: { id: "n2", kind: "agent", seq: 80, text: "最后一步", ts: 2 },
      },
      edges: {},
      order: ["n1", "n2"],
      stateIndex: {},
      foldMarks: [],
      createdAt: 1,
      updatedAt: 2,
    }),
    "utf8",
  );

  const ctx = harness.makeCtx();
  const attemptUsages = [];
  let now = Date.now();
  const delays = [];
  ctx.llm.stream = async function* (options) {
    ctx.streamCalls.push(options);
    const call = ctx.streamCalls.length;
    const usage = usageFor(call);
    attemptUsages.push(usage);
    const transportFailure = call <= 2 || (kind === "combined" && call >= 4);
    if (transportFailure) {
      const failure = call === 2 || call === 5
        ? { message: "Request timed out", code: "TIMEOUT" }
        : { message: "Connection error.", code: "TRANSPORT" };
      yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "error", failure } };
      return;
    }
    if (kind === "combined" && call === 3) {
      yield { type: "text-delta", text: "## 目标\n- 这次成功但撞顶" };
      yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "length" } };
      return;
    }
    yield { type: "text-delta", text: BODY };
    yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const engine = new Engine(ctx, { graphDir, auto: false, closeoutTimeoutMs: 5_000 });
  // 这两个离线旋钮不在 resolveChess 白名单里；测试与既有 _transportRetry* 一样走实例接缝。
  // 组合夹具用假时钟跳过 180s 退避；真实 deadline 要足以容纳这些假等待。
  engine.chess.offlineFoldTimeoutMs = kind === "combined" ? 600_000 : 240_000;
  engine._transportRetryNow = () => now;
  engine._transportRetryRandom = () => 0.5;
  engine._transportRetrySleep = async (ms) => {
    delays.push(ms);
    now += ms;
  };
  const ran = await engine.runAutoBackfillOnce();
  if (ran.ok !== true) throw new Error(`自动补账夹具未跑通：${ran.error ?? "unknown"}`);
  const graph = await harness.readGraphReplayed(graphDir, id);
  const report = JSON.parse(nodeFs.readFileSync(nodePath.join(graphDir, "auto-backfill-state.json"), "utf8"));
  const outcome = report.results?.find((r) => r.id === id) ?? null;
  return { graph, outcome, ctx, home, delays, attemptUsages };
}

tests["① 两次失败 attempt 的 usage 必须与成功 attempt 一起进 foldMark"] = async (t) => {
  const rig = await makeRig("failed-usage");
  try {
    const mark = rig.graph?.foldMarks?.at(-1);
    const expected = sumUsage(rig.attemptUsages);
    console.log(`EVIDENCE ① attempts=${JSON.stringify(rig.attemptUsages)}`);
    console.log(`EVIDENCE ① foldMark.usage=${JSON.stringify(mark?.usage ?? null)} expected=${JSON.stringify(expected)}`);
    t.eq(rig.ctx.streamCalls.length, 3, "两次 TRANSPORT 后第三次成功，前置形状必须成立");
    t.eq(rig.delays, [30_000, 60_000], "仍走既有 30s/60s 假退避");
    t.eq(rig.outcome?.stopped, "done", "最终成功并落账");
    t.eq(mark?.usage, expected, "付了钱都进账：失败 attempt 的 input/output/total/cache/reasoning 一个都不能丢");
  } finally {
    nodeFs.rmSync(rig.home, { recursive: true, force: true });
  }
};

tests["② deadline 返回必须已通过 AbortSignal 真中断原流"] = async (t) => {
  const harness = await import("./engine-harness.test.mjs");
  const Engine = await loadEngine();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-transport-hardening-deadline-"));
  const id = "session-transport-hardening-deadline";
  const sessionsDir = nodePath.join(home, "sessions", "--ws--", id);
  nodeFs.mkdirSync(sessionsDir, { recursive: true });
  const events = Array.from({ length: 80 }, (_, i) => ({
    seq: i + 1,
    type: "user/message",
    data: { message: { content: [{ type: "text", text: `第 ${i + 1} 步：把构建跑通` }] } },
  }));
  const logFile = nodePath.join(sessionsDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(logFile, nodeZlib.zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")));
  const old = new Date(Date.now() - 600_000);
  nodeFs.utimesSync(logFile, old, old);
  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(profileDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(profileDir, "cordis.patch.yml"), ["- id: agent-default-model", "  config:", "    provider: mock", "    model: mock-model", ""].join("\n"), "utf8");
  const graphDir = nodePath.join(home, "chess-context");
  const graphSessionDir = nodePath.join(graphDir, "sessions", id);
  nodeFs.mkdirSync(graphSessionDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(graphSessionDir, "graph.json"), JSON.stringify({
    version: 1,
    sessionId: id,
    cwd: home,
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "把构建跑通", constraints: ["把构建跑通"], ts: 1 },
      n2: { id: "n2", kind: "agent", seq: 80, text: "最后一步", ts: 2 },
    },
    edges: {},
    order: ["n1", "n2"],
    stateIndex: {},
    foldMarks: [],
    createdAt: 1,
    updatedAt: 2,
  }));

  const ctx = harness.makeCtx();
  let seenSignal = null;
  let abortEvents = 0;
  let streamFinished = false;
  let rejectStream = null;
  let startedResolve = null;
  let finishedResolve = null;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  ctx.llm.stream = async function* (options) {
    ctx.streamCalls.push(options);
    seenSignal = options.signal ?? null;
    if (seenSignal !== null) seenSignal.addEventListener("abort", () => { abortEvents += 1; }, { once: true });
    startedResolve();
    try {
      yield { type: "usage", usage: usageFor(1) };
      await new Promise((_resolve, reject) => {
        rejectStream = reject;
        const onAbort = () => reject(seenSignal?.reason ?? new Error("aborted"));
        seenSignal?.addEventListener("abort", onAbort, { once: true });
        if (seenSignal?.aborted === true) onAbort();
      });
      yield { type: "text-delta", text: BODY };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      streamFinished = true;
      finishedResolve();
    }
  };
  // offlineMaxTokens 的最小值 1024 使 deadline 下限为 25.6s；这里使用真实计时器，不缩短取消语义。
  const engine = new Engine(ctx, { graphDir, auto: false });
  engine.chess.offlineMaxTokens = 1024;
  engine.chess.offlineFoldTimeoutMs = 0;
  const keepAlive = setInterval(() => {}, 1000);
  let ran;
  try {
    const running = engine.runAutoBackfillOnce();
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("夹具 5s 内没有进入 llm.stream")), 5_000))]);
    ran = await running;
    // 给 abort 触发的 generator finally 一个微任务/短时钟窗口；修前这里只会等到仍在运行。
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 50))]);
    const actual = {
      stopped: ran.ok === true ? "returned" : ran.error,
      signalPresent: seenSignal !== null,
      signalAborted: seenSignal?.aborted === true,
      abortEvents,
      streamFinished,
    };
    console.log(`EVIDENCE ② deadline-return=${JSON.stringify(actual)}`);
    t.eq(actual.signalPresent, true, "deadline 控制器的 AbortSignal 必须传进 llm.stream");
    t.eq(actual.signalAborted, true, "到点必须真的 abort，而不只是 race 返回");
    t.eq(actual.abortEvents, 1, "原流必须收到一次 abort 事件");
    t.eq(actual.streamFinished, true, "原 async generator 必须已进入 finally，不能在锁释放后继续跑");
  } finally {
    clearInterval(keepAlive);
    if (!streamFinished) rejectStream?.(new Error("fixture cleanup: stop non-aborted legacy stream"));
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 100))]);
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["③ TRANSPORT retry × 截断放大：组合硬上限 6 次且六次 usage 全进账"] = async (t) => {
  const rig = await makeRig("combined");
  try {
    const mark = rig.graph?.foldMarks?.at(-1);
    const expected = sumUsage(rig.attemptUsages);
    const budgets = rig.ctx.streamCalls.map((call) => call.maxTokens);
    console.log(`EVIDENCE ③ calls=${rig.ctx.streamCalls.length} maxTokens=${JSON.stringify(budgets)}`);
    console.log(`EVIDENCE ③ attempts=${JSON.stringify(rig.attemptUsages)}`);
    console.log(`EVIDENCE ③ foldMark.usage=${JSON.stringify(mark?.usage ?? null)} expected=${JSON.stringify(expected)}`);
    t.eq(rig.ctx.streamCalls.length, 6, "上限 = 每轮 1 首调 + 2 TRANSPORT 补试，再乘 1 首调 + 1 截断放大");
    t.eq(budgets, [8192, 8192, 8192, 16384, 16384, 16384], "只有第二轮允许 2× 输出预算；不允许第三轮放大");
    t.eq(rig.delays, [30_000, 60_000, 30_000, 60_000], "两轮各自最多两次退避");
    t.eq(rig.outcome?.stopped, "done", "放大轮耗尽后保留首段截断结果并落账");
    t.eq(mark?.usage, expected, "两轮六个 attempt（含五个失败、一个被放大替换的截断结果）全部计入");
  } finally {
    nodeFs.rmSync(rig.home, { recursive: true, force: true });
  }
};
