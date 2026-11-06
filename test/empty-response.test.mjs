/**
 * empty-response.test.mjs —— 离线摘要「空正文」的三种不同结局。
 *
 * 真机事故（2026-11-05 07:37–07:38 UTC）：closeout 全是 offline:empty-response，
 * 但同毫秒原始流是 TRANSPORT / Connection error，不是模型正常结束后的空回答。
 * 本夹具把三件事分开：
 *   ① 只有 reasoning 块：上游确实产出了内容，不得谎报 empty-response；
 *   ② finish=error：传输失败必须保留 error / TRANSPORT，不得谎报 empty-response；
 *   ③ 正常 stop 且零文本、零 reasoning：这才是 empty-response，判据不许放宽。
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
const LLM_STUB = nodePath.join(STUBS, "stub-llm-empty-response.mjs");
const ENGINE_COPY = nodePath.join(SRC_DIR, ".engine-under-test-empty-response.mjs");

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
  await harness.load(); // 生成其余三种 @deepseek-ai 替身。
  nodeFs.mkdirSync(STUBS, { recursive: true });
  nodeFs.writeFileSync(LLM_STUB, LLM_SOURCE, "utf8");
  const patched = nodeFs
    .readFileSync(nodePath.join(SRC_DIR, "engine.mjs"), "utf8")
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm-empty-response.mjs"`);
  nodeFs.writeFileSync(ENGINE_COPY, patched, "utf8");
  cachedEngine = (await import(pathToFileURL(ENGINE_COPY).href)).default;
  return cachedEngine;
}

const REASONING_SUMMARY = [
  "## 目标",
  "- 把离线补账的空响应归因跑通，并保留传输错误",
  "",
  "## 已建立事实",
  "- 这一段正文只由 reasoning 块产出，但它是上游真实返回的内容",
  "- 空响应判据仍然只针对零文本且零 reasoning 的正常结束",
  "",
  "## 当前节点",
  "- n2：夹具已经跑到离线折叠写回点",
  "",
  "## 约束（逐字）",
  "- 把构建跑通",
].join("\n");

async function makeRig(kind) {
  const harness = await import("./engine-harness.test.mjs");
  const Engine = await loadEngine();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `gokifu-empty-${kind}-`));
  const id = `session-empty-${kind}`;
  const sessionsDir = nodePath.join(home, "sessions", "--ws--", id);
  nodeFs.mkdirSync(sessionsDir, { recursive: true });
  const events = Array.from({ length: 80 }, (_, i) => ({
    seq: i + 1,
    type: i % 2 === 0 ? "user/message" : "assistant/message",
    data: { message: { content: [{ type: "text", text: `第 ${i + 1} 步：把构建跑通` }] } },
  }));
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  nodeFs.writeFileSync(nodePath.join(sessionsDir, "session.v4.jsonl.zstd"), nodeZlib.zstdCompressSync(Buffer.from(jsonl, "utf8")));

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
  ctx.llm.stream = async function* (options) {
    ctx.streamCalls.push(options);
    if (kind === "throw") throw Object.assign(new Error("Connection error. [TRANSPORT]"), { code: "TRANSPORT" });
    if (kind === "reasoning") yield { type: "reasoning-delta", text: REASONING_SUMMARY };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: kind === "reasoning" ? 40 : 0, totalTokens: kind === "reasoning" ? 140 : 0 } };
    if (kind === "error") {
      yield { type: "finish", reason: { kind: "error", failure: { message: "Connection error.", code: "TRANSPORT" } } };
    } else {
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };
  const engine = new Engine(ctx, { graphDir, auto: false, closeoutTimeoutMs: 5_000 });
  const session = harness.makeSession({ id });
  await ctx.emitRaw("session/disposed", session);

  let graph = null;
  for (let i = 0; i < 120; i += 1) {
    graph = await harness.readGraphReplayed(graphDir, id);
    if (typeof graph?.closeout?.foldNote === "string" || typeof graph?.closeout?.foldError === "string") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { graph, ctx, home };
}

tests["只有 reasoning 块 ⇒ 不是 empty-response，正文必须进入 foldMark"] = async (t) => {
  const { graph, ctx, home } = await makeRig("reasoning");
  try {
    t.ne(graph?.closeout?.foldNote, "offline:empty-response", "reasoning 是上游真实内容，不得谎报空响应");
    t.eq(graph?.closeout?.folded, 1, "reasoning-only 应当完成这一段补折");
    t.eq((graph?.foldMarks ?? []).length, 1, "必须真的写一条 foldMark");
    t.includes(graph?.foldMarks?.[0]?.summaryText ?? graph?.lastOfflineSummary?.text ?? "", "只由 reasoning 块产出", "reasoning 正文不能滤没");
    t.eq(ctx.streamCalls.length, 1, "reasoning-only 不是截断空答，不应再白打一次放大重试");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["finish=error / TRANSPORT ⇒ 保留传输错误，不得写成 empty-response"] = async (t) => {
  const { graph, home } = await makeRig("error");
  try {
    t.eq(graph?.closeout?.foldNote, "offline:error", "错误结束必须进入 error 结局");
    t.ne(graph?.closeout?.foldNote, "offline:empty-response", "传输失败不是模型正常交空答");
    t.includes(graph?.closeout?.foldError ?? "", "Connection error.", "原始错误必须落盘");
    t.includes(graph?.closeout?.foldError ?? "", "TRANSPORT", "错误码也必须保留");
    t.eq(graph?.closeout?.folded, 0, "失败不能记成折过");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["stream 直接抛 TRANSPORT ⇒ 同样不得包装成 empty-response"] = async (t) => {
  const { graph, home } = await makeRig("throw");
  try {
    t.eq(graph?.closeout?.foldNote, "offline:error", "抛出的传输错误必须进入 error 结局");
    t.ne(graph?.closeout?.foldNote, "offline:empty-response", "异常不是模型正常交空答");
    t.includes(graph?.closeout?.foldError ?? "", "Connection error.", "直接抛错也必须落盘");
    t.includes(graph?.closeout?.foldError ?? "", "TRANSPORT", "直接抛错的错误码也必须保留");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["正常 stop + 零文本零 reasoning ⇒ 仍然是 empty-response（判据不放宽）"] = async (t) => {
  const { graph, home } = await makeRig("empty");
  try {
    t.eq(graph?.closeout?.foldNote, "offline:empty-response", "真正空回答必须继续真红");
    t.eq(graph?.closeout?.folded, 0, "空回答不许写账");
    t.eq((graph?.foldMarks ?? []).length, 0, "空回答不许产生 foldMark");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
