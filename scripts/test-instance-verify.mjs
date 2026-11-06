#!/usr/bin/env node
/**
 * test-instance-verify.mjs —— 用磁盘上的新代码起真 Engine，重放真机日志验证 T63/T64/T66/T67。
 *
 * 边界：
 *   · live home 只用于 find/read/copy 来源；所有 Engine 写入都落在 test/.harness-test-instance/；
 *   · 复制后的日志才交给 Engine，源日志做前后 sha256 对照；
 *   · summarizationProvider/Model 显式指向假路由，不创建或修改任何 cordis.patch.yml；
 *   · ctx.llm.stream 是异步生成器假模型；TRANSPORT、正文、reasoning 全部由夹具控制。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeCrypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { collectMessages, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { findSessionLog, listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const TEST_ROOT = nodePath.join(REPO, "test", ".harness-test-instance");
const SRC_DIR = nodePath.join(REPO, "src");
const STUBS = nodePath.join(SRC_DIR, ".harness-stubs");
const LLM_STUB = nodePath.join(STUBS, "stub-llm-test-instance.mjs");
const ENGINE_COPY = nodePath.join(SRC_DIR, ".engine-under-test-test-instance.mjs");
const REAL_SESSION = "010c3b44";
const TIMEOUT_MS = 240_000;

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

const SUMMARY = [
  "## 目标",
  "- 重放真机会话日志，验证测试实例中的离线补账行为",
  "",
  "## 已建立事实",
  "- 这份正文由受控假模型返回，不访问任何真实模型或网络",
  "- 小缺口必须与后续未折内容合并，传输错误必须保留原始分类",
  "- 退避只发生在预算允许时，第三次调用必须真实进入假模型流",
  "- 这段正文刻意超过四百字符，避免触发与本次验证无关的短摘要放大重试；".repeat(5),
  `- ${"verified-".repeat(60)}`,
  "",
  "## 当前节点",
  "- 测试实例已经完成真机日志重放",
  "",
  "## 约束（逐字）",
  "- 真机日志只读，隔离 home 之外不写任何补账产物",
].join("\n");

let cached = null;
async function loadTestEngine() {
  if (cached !== null) return cached;
  cached = (async () => {
    const harness = await import("../test/engine-harness.test.mjs");
    await harness.load();
    nodeFs.mkdirSync(STUBS, { recursive: true });
    nodeFs.writeFileSync(LLM_STUB, LLM_SOURCE, "utf8");
    const patched = nodeFs
      .readFileSync(nodePath.join(SRC_DIR, "engine.mjs"), "utf8")
      .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
      .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
      .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
      .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm-test-instance.mjs"`);
    nodeFs.writeFileSync(ENGINE_COPY, patched, "utf8");
    const Engine = (await import(pathToFileURL(ENGINE_COPY).href)).default;
    return { Engine, harness };
  })();
  return cached;
}

function liveHome() {
  const env = String(process.env.DSH_HOME ?? "").trim();
  if (env !== "") return nodePath.resolve(env);
  return nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

const sha256 = (file) => nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex");

function stageLog(sourceHome, needle, home) {
  const sourceLog = findSessionLog(sourceHome, needle);
  if (sourceLog === null) throw new Error(`找不到真机日志：${sourceHome} / ${needle}`);
  const sessionId = nodePath.basename(nodePath.dirname(sourceLog));
  const before = { sha256: sha256(sourceLog), size: nodeFs.statSync(sourceLog).size, mtimeMs: nodeFs.statSync(sourceLog).mtimeMs };
  const dir = nodePath.join(home, "sessions", "--test-instance--", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const isolatedLog = nodePath.join(dir, "session.v4.jsonl.zstd");
  nodeFs.copyFileSync(sourceLog, isolatedLog);
  const old = new Date(Date.now() - 600_000);
  nodeFs.utimesSync(isolatedLog, old, old);
  return {
    sessionId,
    sourceLog,
    isolatedLog,
    before,
    proveUnchanged() {
      const after = { sha256: sha256(sourceLog), size: nodeFs.statSync(sourceLog).size, mtimeMs: nodeFs.statSync(sourceLog).mtimeMs };
      return { ...after, unchanged: JSON.stringify(after) === JSON.stringify(before) };
    },
  };
}

function graphFile(home, id) {
  return nodePath.join(home, "chess-context", "sessions", id, "graph.json");
}

function writeGraph(home, id, graph) {
  const file = graphFile(home, id);
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, JSON.stringify(graph), "utf8");
  return file;
}

function readGraph(home, id) {
  return loadSessionGraph(graphFile(home, id)).graph;
}

function graphFromRealLog(id, events) {
  const messages = collectMessages(events, { maxChars: Number.MAX_SAFE_INTEGER }).messages;
  const seqs = messages.map((m) => Number(m.seq)).filter(Number.isFinite);
  const first = Math.min(...seqs);
  const last = Math.max(...seqs);
  if (!(seqs.length >= 40 && last - first + 1 >= 40)) {
    throw new Error(`真机日志可折事件不足：messages=${seqs.length}, first=${first}, last=${last}`);
  }
  return {
    version: 1,
    sessionId: id,
    cwd: "",
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: first, text: String(messages[0]?.text ?? "").slice(0, 200), constraints: [], ts: 1 },
      n2: { id: "n2", kind: "agent", seq: last, text: String(messages.at(-1)?.text ?? "").slice(0, 200), ts: 2 },
    },
    edges: {},
    order: ["n1", "n2"],
    stateIndex: {},
    foldMarks: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

async function withIsolatedHome(label, options, fn) {
  const sourceHome = nodePath.resolve(options.liveHome ?? liveHome());
  nodeFs.mkdirSync(TEST_ROOT, { recursive: true });
  const ownsRoot = typeof options.root !== "string" || options.root === "";
  const root = ownsRoot ? nodeFs.mkdtempSync(nodePath.join(TEST_ROOT, `${label}-`)) : options.root;
  const home = nodePath.join(root, label);
  nodeFs.mkdirSync(home, { recursive: true });
  const previous = new Map();
  const env = {
    DSH_HOME: home,
    DSH_GOKIFU_NO_HEAL: "1",
    DSH_GOKIFU_AUTO_BACKFILL_DELAY_SEC: "3600",
    DSH_GOKIFU_AUTO_BACKFILL_MAX: "1",
    DSH_GOKIFU_AUTO_BACKFILL_ROUNDS: "1",
    DSH_GOKIFU_AUTO_BACKFILL_BUDGET_SEC: "240",
  };
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const engines = [];
  try {
    return await fn({
      home,
      sourceHome,
      root,
      register(engine) {
        engines.push(engine);
        return engine;
      },
    });
  } finally {
    for (const engine of engines) {
      try { clearTimeout(engine?._autoBackfill?.first); } catch { /* ignore */ }
      try { clearInterval(engine?._autoBackfill?.timer); } catch { /* ignore */ }
      try {
        for (const timer of engine?.flushTimers?.values?.() ?? []) clearTimeout(timer);
        engine?.flushTimers?.clear?.();
      } catch { /* ignore */ }
    }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (ownsRoot && options.keep !== true) nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

async function makeEngine(home, ctx, register, extra = {}) {
  const { Engine } = await loadTestEngine();
  const engine = new Engine(ctx, {
    graphDir: nodePath.join(home, "chess-context"),
    auto: false,
    autoBackfill: true,
    summarizationProvider: "test-provider",
    summarizationModel: "fake-model",
    offlineMaxChars: 10_000_000,
    offlineFoldTimeoutMs: TIMEOUT_MS,
    closeoutTimeoutMs: 5_000,
    ...extra,
  });
  engine._llmHandle = ctx.llm;
  return register(engine);
}

function logEvidence(staged, home) {
  return {
    sourceLog: staged.sourceLog,
    isolatedLog: staged.isolatedLog,
    isolatedHome: home,
    sourceSha256: staged.before.sha256,
    sourceAfter: staged.proveUnchanged(),
  };
}

/** 直接取真机图上当前的 1–8 事件缺口；按日志大小选最小的三份，降低重放成本。 */
function smallGapCandidates(home, limit = 3) {
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const logs = listSessionLogs(home);
  const candidates = [];
  for (const name of nodeFs.readdirSync(sessionsRoot)) {
    const file = nodePath.join(sessionsRoot, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph;
    try { graph = loadSessionGraph(file).graph; } catch { continue; }
    const debt = debtOfGraph(graph);
    const start = Number(debt.gap?.from ?? 0);
    const span = Number(debt.gap?.events ?? 0);
    if (!(span >= 1 && span <= 8) || !debt.due || start <= 0 || debt.maxSeq - start + 1 < 40) continue;
    const sourceLog = logs.find((p) => nodePath.basename(nodePath.dirname(p)) === name) ??
      logs.find((p) => p.includes(name)) ?? logs.find((p) => p.includes(name.replace(/^session-/, "")));
    if (sourceLog === undefined) continue;
    try {
      const stat = nodeFs.statSync(sourceLog);
      if (Date.now() - stat.mtimeMs < 300_000) continue;
      candidates.push({
        sessionId: name,
        graph,
        sourceLog,
        logBytes: stat.size,
        sourceMark: { index: null, start, end: start + span - 1, span },
        debt,
      });
    } catch { continue; }
  }
  candidates.sort((a, b) => a.logBytes - b.logBytes || a.sessionId.localeCompare(b.sessionId));
  return candidates.slice(0, limit);
}

export async function verifySmallWindows(options = {}) {
  return withIsolatedHome("t63", options, async ({ home, sourceHome, register }) => {
    const candidates = smallGapCandidates(sourceHome, 3);
    if (candidates.length === 0) throw new Error("真机图中没有可重放的 1–8 事件小缺口");
    const { harness } = await loadTestEngine();
    const cases = [];
    for (const candidate of candidates) {
      const caseHome = nodePath.join(home, candidate.sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
      nodeFs.mkdirSync(caseHome, { recursive: true });
      process.env.DSH_HOME = caseHome;
      const staged = stageLog(sourceHome, candidate.sessionId, caseHome);
      writeGraph(caseHome, candidate.sessionId, candidate.graph);
      const ctx = harness.makeCtx();
      ctx.llm.stream = async function* (streamOptions) {
        ctx.streamCalls.push(streamOptions);
        yield { type: "text-delta", text: SUMMARY };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
        yield { type: "finish", reason: { kind: "stop" } };
      };
      const engine = await makeEngine(caseHome, ctx, register);
      const beforeCount = candidate.graph.foldMarks.length;
      const ran = await engine.runAutoBackfillOnce();
      const graph = readGraph(caseHome, candidate.sessionId);
      const newMarks = (graph.foldMarks ?? []).slice(beforeCount).map((m) => ({
        start: Number(m.seqStart), end: Number(m.seqEnd), span: Number(m.seqEnd) - Number(m.seqStart) + 1,
      }));
      const evidence = logEvidence(staged, caseHome);
      cases.push({
        sessionId: candidate.sessionId,
        ...evidence,
        sourceMark: candidate.sourceMark,
        legacyWindow: { start: candidate.sourceMark.start, end: candidate.sourceMark.end, span: candidate.sourceMark.span },
        expectedMergedEnd: candidate.debt.maxSeq,
        newMarks,
        modelCalls: ctx.streamCalls.length,
        runOk: ran.ok,
        sourceUnchanged: evidence.sourceAfter.unchanged,
      });
    }
    const pass = cases.every((c) =>
      c.runOk === true && c.newMarks.length > 0 && c.newMarks[0].span >= 20 &&
      c.newMarks.every((m) => m.span >= 9) && c.sourceUnchanged === true,
    );
    return {
      id: "T63",
      pass,
      expected: "每条真机小缺口的旧窗口为 1–8；真 Engine 新首折 >=20，且所有新折痕均不为 1–8；源日志哈希不变",
      actual: cases.map((c) => ({ sessionId: c.sessionId, old: c.legacyWindow, newMarks: c.newMarks, calls: c.modelCalls })),
      cases,
      isolatedHome: home,
    };
  });
}

export async function verifyFictitiousGap(options = {}) {
  return withIsolatedHome("t64", options, async ({ home, sourceHome }) => {
    const staged = stageLog(sourceHome, REAL_SESSION, home);
    const events = readSessionEvents(staged.isolatedLog);
    const leading = events.filter((e) => Number(e.seq) >= 1 && Number(e.seq) <= 8);
    const leadingFoldable = collectMessages(leading, { maxChars: Number.MAX_SAFE_INTEGER }).messages.length;
    const result = await runOfflineFold({
      graph: { sessionId: staged.sessionId, nodes: {}, edges: {}, foldMarks: [] },
      events,
      rangeStart: 1,
      rangeEnd: 8,
      fromHead: true,
      callModel: async () => ({
        text: SUMMARY,
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        model: "fake-model",
        finish: "stop",
      }),
      measureQuality: () => null,
    });
    const evidence = logEvidence(staged, home);
    const actual = {
      leadingEvents: leading.length,
      leadingFoldable,
      leadingTypes: leading.map((e) => e.type),
      coveredStart: result.coveredStart,
      legacyUncoveredHead: result.coveredStart === null ? null : result.coveredStart - 1,
      uncoveredHead: result.uncoveredHead,
      uncoveredTail: result.uncoveredTail,
    };
    const pass = actual.leadingEvents === 8 && actual.leadingFoldable === 0 && actual.coveredStart === 9 &&
      actual.legacyUncoveredHead === 8 && actual.uncoveredHead === 0 && actual.uncoveredTail === 0 && evidence.sourceAfter.unchanged;
    return {
      id: "T64",
      pass,
      expected: { leadingEvents: 8, leadingFoldable: 0, coveredStart: 9, legacyUncoveredHead: 8, uncoveredHead: 0, uncoveredTail: 0 },
      actual,
      ...evidence,
      isolatedHome: home,
    };
  });
}

export async function verifyTransportClassification(options = {}) {
  return withIsolatedHome("t66", options, async ({ home, sourceHome, register }) => {
    const staged = stageLog(sourceHome, REAL_SESSION, home);
    const events = readSessionEvents(staged.isolatedLog);
    writeGraph(home, staged.sessionId, graphFromRealLog(staged.sessionId, events));
    const { harness } = await loadTestEngine();
    const ctx = harness.makeCtx();
    ctx.llm.stream = async function* (streamOptions) {
      ctx.streamCalls.push(streamOptions);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { type: "finish", reason: { kind: "error", failure: { message: "Connection error.", code: "TRANSPORT" } } };
    };
    const engine = await makeEngine(home, ctx, register);
    const session = harness.makeSession({ id: staged.sessionId });
    session.cwd = home;
    await ctx.emitRaw("session/disposed", session);
    let graph = null;
    for (let i = 0; i < 150; i += 1) {
      graph = readGraph(home, staged.sessionId);
      if (typeof graph?.closeout?.foldNote === "string" || typeof graph?.closeout?.foldError === "string") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const evidence = logEvidence(staged, home);
    const actual = {
      foldNote: graph?.closeout?.foldNote ?? null,
      foldError: graph?.closeout?.foldError ?? null,
      folded: graph?.closeout?.folded ?? null,
      foldMarks: (graph?.foldMarks ?? []).length,
      modelCalls: ctx.streamCalls.length,
    };
    const pass = actual.foldNote === "offline:error" && actual.foldNote !== "offline:empty-response" &&
      String(actual.foldError).includes("TRANSPORT") && actual.folded === 0 && actual.foldMarks === 0 && evidence.sourceAfter.unchanged;
    return {
      id: "T66",
      pass,
      expected: { foldNote: "offline:error", notFoldNote: "offline:empty-response", foldErrorIncludes: "TRANSPORT", folded: 0, foldMarks: 0 },
      actual,
      ...evidence,
      isolatedHome: home,
    };
  });
}

async function transportRetryCase(label, randomValues, expectedDelays, options) {
  return withIsolatedHome(label, options, async ({ home, sourceHome, register }) => {
    const staged = stageLog(sourceHome, REAL_SESSION, home);
    const events = readSessionEvents(staged.isolatedLog);
    writeGraph(home, staged.sessionId, graphFromRealLog(staged.sessionId, events));
    const { harness } = await loadTestEngine();
    const ctx = harness.makeCtx();
    let now = Date.now();
    const started = now;
    const callTimes = [];
    const delays = [];
    ctx.llm.stream = async function* (streamOptions) {
      ctx.streamCalls.push(streamOptions);
      callTimes.push(now);
      const call = ctx.streamCalls.length;
      if (call <= 2) {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        yield { type: "finish", reason: { kind: "error", failure: { message: `Connection error ${call}.`, code: "TRANSPORT" } } };
        return;
      }
      yield { type: "reasoning-delta", text: SUMMARY };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    const engine = await makeEngine(home, ctx, register);
    let randomIndex = 0;
    engine._transportRetryNow = () => now;
    engine._transportRetryRandom = () => randomValues[randomIndex++] ?? 0.5;
    engine._transportRetrySleep = async (ms) => { delays.push(ms); now += ms; };
    // foldDeadline 在此之后才会计算，因此这是保守下界：连下界都没超过，就一定没超过真实 deadline。
    const deadlineFloor = Date.now() + TIMEOUT_MS;
    const ran = await engine.runAutoBackfillOnce();
    const graph = readGraph(home, staged.sessionId);
    const state = JSON.parse(nodeFs.readFileSync(nodePath.join(home, "chess-context", "auto-backfill-state.json"), "utf8"));
    const outcome = state.results?.find((r) => r.id === staged.sessionId) ?? null;
    const evidence = logEvidence(staged, home);
    const actual = {
      calls: ctx.streamCalls.length,
      delays,
      callOffsetsMs: callTimes.map((t) => t - started),
      fakeElapsedMs: now - started,
      deadlineFloor,
      allCallsBeforeDeadline: callTimes.every((t) => t < deadlineFloor),
      stopped: outcome?.stopped ?? null,
      folded: outcome?.folded ?? null,
      foldMarks: (graph?.foldMarks ?? []).length,
      runOk: ran.ok,
    };
    const pass = actual.calls === 3 && JSON.stringify(actual.delays) === JSON.stringify(expectedDelays) &&
      actual.allCallsBeforeDeadline && actual.stopped === "done" && actual.folded === 1 && actual.foldMarks === 1 &&
      actual.runOk === true && evidence.sourceAfter.unchanged;
    return {
      pass,
      expected: { calls: 3, delays: expectedDelays, allCallsBeforeDeadline: true, stopped: "done", folded: 1, foldMarks: 1 },
      actual,
      ...evidence,
      isolatedHome: home,
    };
  });
}

export async function verifyTransportRetry(options = {}) {
  const centered = await transportRetryCase("t67-centered", [0.5, 0.5], [30_000, 60_000], options);
  const jittered = await transportRetryCase("t67-jitter", [0, 1], [24_000, 72_000], options);
  return {
    id: "T67",
    pass: centered.pass && jittered.pass,
    expected: "两次 TRANSPORT 后真的第三次调用；中心抖动 30s/60s，端点抖动 24s/72s；所有调用都在保守 deadline 下界之前",
    actual: { centered: centered.actual, jittered: jittered.actual },
    cases: { centered, jittered },
    isolatedHomes: [centered.isolatedHome, jittered.isolatedHome],
  };
}

const VERIFIERS = [
  ["T63", verifySmallWindows],
  ["T64", verifyFictitiousGap],
  ["T66", verifyTransportClassification],
  ["T67", verifyTransportRetry],
];

export async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = nodePath.join(TEST_ROOT, `run-${stamp}-${process.pid}`);
  nodeFs.mkdirSync(root, { recursive: true });
  console.log(`TEST-INSTANCE liveHome(read-only)=${liveHome()}`);
  console.log(`TEST-INSTANCE isolatedRoot=${root}`);
  const results = [];
  for (const [id, verify] of VERIFIERS) {
    try {
      const result = await verify({ root, keep: true, liveHome: liveHome() });
      results.push(result);
      console.log(`\n${id} ${result.pass ? "PASS" : "FAIL"}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      const result = { id, pass: false, expected: "验证正常跑完且判据为真", actual: { error: String(error?.stack ?? error) } };
      results.push(result);
      console.log(`\n${id} FAIL`);
      console.log(JSON.stringify(result, null, 2));
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n== test-instance: ${passed} passed, ${results.length - passed} failed ==`);
  return results.every((r) => r.pass) ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
