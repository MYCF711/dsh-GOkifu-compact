/**
 * transport-retry.test.mjs —— T67：离线摘要 TRANSPORT / 超时重试与 deadline 硬约束。
 *
 * 三个夹具都走真实 `runAutoBackfillOnce → 离线补折 → callModel`，不是只测脱离引擎的工具函数：
 *   ① TRANSPORT → 超时 → 成功：必须调用 3 次，退避 30s / 60s；
 *   ② 400 参数错：不得重试；
 *   ③ 剩余时间装不下“退避 + 1.2×预计段耗时”：不得重试，并留下 deadline 日志。
 * 假时钟 / 假 sleep 只替换时间源，不改变调用链与结局写回。
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
const LLM_STUB = nodePath.join(STUBS, "stub-llm-transport-retry.mjs");
const ENGINE_COPY = nodePath.join(SRC_DIR, ".engine-under-test-transport-retry.mjs");

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
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm-transport-retry.mjs"`);
  nodeFs.writeFileSync(ENGINE_COPY, patched, "utf8");
  cachedEngine = (await import(pathToFileURL(ENGINE_COPY).href)).default;
  return cachedEngine;
}

const SUMMARY = [
  "## 目标",
  "- 验证可恢复传输错误会在预算内退避重试，同时参数错误不重试",
  "",
  "## 已建立事实",
  "- 第一次是 TRANSPORT，第二次是超时，第三次才返回这份完整摘要",
  "- deadline 不够时保留原错误，不开一个注定被整段丢弃的调用",
  "- 这段正文故意超过骨架判据的四百字符下限，避免成功后又触发放大重试；".repeat(4),
  "",
  "## 当前节点",
  "- n2：三次调用与两次退避都已走到离线折叠写回点",
  "",
  "## 约束（逐字）",
  "- 把构建跑通",
].join("\n");

async function makeRig(kind) {
  const harness = await import("./engine-harness.test.mjs");
  const Engine = await loadEngine();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `gokifu-transport-${kind}-`));
  const id = `session-transport-${kind}`;
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
  // 自动补账不碰 5 分钟内仍在写的活会话；夹具把日志放到 10 分钟前。
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
  const infos = [];
  ctx.logger.info = (line) => infos.push(String(line));
  let now = Date.now();
  const delays = [];
  ctx.llm.stream = async function* (options) {
    ctx.streamCalls.push(options);
    const call = ctx.streamCalls.length;
    const mustFail = kind === "transport" ? call <= 2 : call === 1;
    if (mustFail) {
      if (kind === "deadline") now = Date.now() + 250_000;
      const failure = kind === "invalid"
        ? { message: "400 invalid parameters: timeout must be an integer", code: "INVALID_REQUEST" }
        : kind === "transport" && call === 2
          ? { message: "Request timed out", code: "TIMEOUT" }
          : { message: "Connection error.", code: "TRANSPORT" };
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { type: "finish", reason: { kind: "error", failure } };
      return;
    }
    yield { type: "reasoning-delta", text: SUMMARY };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const engine = new Engine(ctx, { graphDir, auto: false, closeoutTimeoutMs: 5_000 });
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
  return { graph, outcome, ctx, home, delays, infos };
}

tests["TRANSPORT → 超时 ⇒ 30s / 60s 退避后第三次成功"] = async (t) => {
  const { graph, outcome, ctx, home, delays } = await makeRig("transport");
  try {
    t.eq(ctx.streamCalls.length, 3, "两次可恢复错误之后必须真的发起第三次调用");
    t.eq(delays, [30_000, 60_000], "指数退避必须按 30s → 60s（random=0.5 时零偏移）");
    t.eq(outcome?.stopped, "done", "恢复成功的补账结局必须是 done");
    t.eq(outcome?.folded, 1, "恢复后必须折出一段");
    t.eq((graph?.foldMarks ?? []).length, 1, "恢复后必须真的落一条 foldMark");
    t.eq(graph?.foldMarks?.[0]?.trigger, "archive-offline", "必须走自动离线补折写回点");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["400 参数错误 ⇒ 不重试、不退避"] = async (t) => {
  const { graph, outcome, ctx, home, delays } = await makeRig("invalid");
  try {
    t.eq(ctx.streamCalls.length, 1, "永久性参数错误只能调用一次");
    t.eq(delays, [], "非 TRANSPORT / 非超时不许等待");
    t.eq(outcome?.stopped, "error", "T66 的错误分类保持不变");
    t.includes(outcome?.error ?? "", "400", "原始 400 错误必须保留");
    t.eq((graph?.foldMarks ?? []).length, 0, "失败不得写 foldMark");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["剩余预算装不下退避 + 预计段耗时 ⇒ 不重试"] = async (t) => {
  const { graph, outcome, ctx, home, delays, infos } = await makeRig("deadline");
  try {
    t.eq(ctx.streamCalls.length, 1, "会跨 deadline 时不得发起第二次调用");
    t.eq(delays, [], "预算不足时连退避等待都不应发生");
    t.eq(outcome?.stopped, "error", "跳过重试后仍保留 TRANSPORT 错误结局");
    t.includes(outcome?.error ?? "", "TRANSPORT", "原始错误码不得被预算分支吃掉");
    t.ok(infos.some((line) => /deadline|剩余/.test(line) && /不重试|跳过/.test(line)), "必须留下因 deadline 不重试的可观测日志");
    t.eq((graph?.foldMarks ?? []).length, 0, "预算不足不能写半截账");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
