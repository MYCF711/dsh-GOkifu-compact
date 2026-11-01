/**
 * engine-retry-assembler.test.mjs —— B1：「摘要模型不可用 ⇒ 退回当前路由重试」这条分支
 * 在**新版宿主 `BlockAssembler`（`@deepseek-ai/dsh-llm@0.2.1-rc.5` 形状）**上必须仍然可用。
 *
 * 为什么要有这个测试：
 *   `src/engine.mjs` 的回退分支旧写法是**往旧实例回写**——
 *     `assembler.chunks.length = 0; for (const c of retry.chunks) assembler.push(c);
 *      assembler.finish = retry.finish; assembler.usage = retry.usage;`
 *   rc.5 的 `BlockAssembler` **没有 `chunks`**，且 `usage` / `finish` 是**只读 getter**
 *   （ESM 严格模式下赋值抛 TypeError）。而这段代码外面还包着一层
 *   `catch { if (mode !== "hybrid") throw; …退回规则摘要 }` ⇒
 *   **真实后果不是崩，而是回退分支静默失效、fold 降级成规则摘要**（摘要质量掉一档，且只留一条
 *   会误导人的 warn「摘要模型全部不可用」）。所以本用例的判据是「**不许降级成 rules**」。
 *
 * 做法（沿用 `test/engine-harness.test.mjs` 的「假 DSH」套路）：
 *   把 `src/engine.mjs` 源码读出来，把 `@deepseek-ai/*` 换成 stub 写到 `src/.engine-under-test-rc5.mjs`
 *   （点开头的生成物，`.gitignore` 与 package.json 的 `files` 都已排除），
 *   其中 llm 模块换成**复刻 rc.5 形状**的替身：没有 `chunks`、`usage`/`finish` 只读 getter。
 *   本文件先断言「替身形状确实是 rc.5 形状」（防止有人把替身改宽容来把用例弄绿）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = nodePath.join(HERE, "..", "src");
const SRC_ENGINE = nodePath.join(SRC_DIR, "engine.mjs");
// ★ 与 engine-harness 同一个生成目录：放 src/ 旁边是因为 engine.mjs 里有 `./rooms/*` 相对 import。
const STUBS = nodePath.join(SRC_DIR, ".harness-stubs");
const COPY = nodePath.join(SRC_DIR, ".engine-under-test-rc5.mjs");
const STUB_RC5 = nodePath.join(STUBS, "stub-llm-rc5.mjs");

/**
 * rc.5 形状的 llm 替身。**关键差异（就是这两条让旧代码红）**：
 *   · 没有 `chunks` 字段 ⇒ `assembler.chunks.length = 0` 直接 TypeError；
 *   · `usage` / `finish` 是 `get` ⇒ 严格模式赋值 TypeError。
 * 另外保留 rc.5 实测成员表：partials/order/push/ensure/assemble/mustGet/assembled/
 * blocks/interruptedBlocks/get usage/get finish/get replayState/message。
 */
const RC5_LLM_STUB = `export class LlmError extends Error {
  constructor(m, code, cause) { super(m); this.code = code; this.cause = cause; }
}
export function contentHasImage(blocks) {
  return Array.isArray(blocks) && blocks.some((b) => b && b.type === "image");
}
export function createUserMessage(input) {
  return { id: "m" + Math.random().toString(36).slice(2), role: "user", ...input };
}
/** 0.2.1-rc.5 形状：无 chunks；usage/finish 只读 getter。 */
export class BlockAssembler {
  #text = "";
  #usage = undefined;
  #finish = { kind: "stop" };
  constructor() {
    this.partials = [];
    this.order = [];
  }
  push(chunk) {
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.type === "text-delta") this.#text += String(chunk.text ?? "");
    else if (chunk.type === "usage") this.#usage = chunk.usage;
    else if (chunk.type === "finish") this.#finish = chunk.finish ?? this.#finish;
    this.partials.push(chunk);
  }
  ensure() { return this; }
  assemble() { return this.blocks(); }
  mustGet() { return this.blocks(); }
  blocks() {
    if (this.#text.length === 0) return [];
    return [{ type: "text", text: this.#text }];
  }
  interruptedBlocks() { return []; }
  get usage() { return this.#usage; }
  get finish() { return this.#finish; }
  get replayState() { return { partials: this.partials.length, order: this.order.length }; }
  get message() { return { id: "msg", role: "assistant", content: this.blocks() }; }
  get assembled() { return this.blocks(); }
}
`;

const BAD_MODEL = "ima/deepseek-v4.1-flash";
const BAD_PROVIDER = "magpie";
const ROUTED_TEXT = "## 目标\n- 来自当前路由（retry）的摘要";

/** 生成 rc.5 形状的 engine 副本并 import。 */
async function loadRc5Engine() {
  // 复用 engine-harness 的 stub 生成：schemastery / compaction / basic 三个与 llm 形状无关。
  const harness = await import("./engine-harness.test.mjs");
  const { graphDir } = await harness.load();
  nodeFs.mkdirSync(STUBS, { recursive: true });
  nodeFs.writeFileSync(STUB_RC5, RC5_LLM_STUB, "utf8");

  const patched = nodeFs
    .readFileSync(SRC_ENGINE, "utf8")
    .replace(`from "@deepseek-ai/schemastery"`, `from "./.harness-stubs/stub-schemastery.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
    .replace(`from "@deepseek-ai/dsh-compaction"`, `from "./.harness-stubs/stub-compaction.mjs"`)
    .replace(`from "@deepseek-ai/dsh-llm"`, `from "./.harness-stubs/stub-llm-rc5.mjs"`);
  if (!patched.includes(`stub-llm-rc5.mjs`)) {
    throw new Error("夹具构造失败：engine.mjs 的 @deepseek-ai/dsh-llm import 没被换掉（源码形状变了？）");
  }
  nodeFs.writeFileSync(COPY, patched, "utf8");
  const mod = await import(pathToFileURL(COPY).href);
  const stub = await import(pathToFileURL(STUB_RC5).href);
  return { Engine: mod.default, graphDir, BlockAssembler: stub.BlockAssembler };
}

/* ── 会话事件（与 engine-harness 同形，够 runStream/facts 用即可） ── */
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

/** 造一个「摘要模型配错、当前路由可用」的引擎 + 4 条真实事件。 */
async function makeRig() {
  const harness = await import("./engine-harness.test.mjs");
  const { Engine, graphDir, BlockAssembler } = await loadRc5Engine();
  const session = harness.makeSession({ id: "sess-retry-rc5" });
  const ctx = harness.makeCtx({ failModels: new Set([BAD_MODEL]) });
  // 覆盖 stream：第一次（配错的摘要模型）抛错；第二次（当前路由 p/m）成功且产出**可辨识**的文本。
  ctx.llm.stream = async function* (options) {
    ctx.streamCalls.push(options);
    if (options.model === BAD_MODEL) {
      throw new Error(`pi-ai provider "${options.provider}" has no configured model "${options.model}"`);
    }
    yield { type: "text-delta", text: ROUTED_TEXT };
    yield { type: "usage", usage: { inputTokens: 11, outputTokens: 22 } };
  };
  const engine = new Engine(ctx, {
    graphDir,
    auto: false,
    summarizationProvider: BAD_PROVIDER,
    summarizationModel: BAD_MODEL,
  });
  await ctx.emitRaw("session/event", session, userEvent("把测试跑绿。", 1));
  await ctx.emitRaw("session/event", session, assistantEvent("c1", "bash", { command: "npm test" }, 2));
  await ctx.emitRaw("session/event", session, resultEvent("c1", "boom\n[exit code: 1]", 3));
  await ctx.emitRaw("session/event", session, { type: "step/end", seq: 4, data: { turn: 1, step: 1 } });
  return { Engine, engine, ctx, session, BlockAssembler, graphDir };
}

tests["B1-0 夹具自检：替身确实是 rc.5 形状（没有 chunks；usage/finish 只读）"] = async () => {
  const { BlockAssembler } = await loadRc5Engine();
  const a = new BlockAssembler();
  const proto = Object.getPrototypeOf(a);
  if ("chunks" in a) throw new Error("替身有 chunks —— 那就复刻不出 rc.5 形状，本用例会假绿");
  for (const name of ["usage", "finish"]) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.get !== "function" || d.set !== undefined) {
      throw new Error(`替身的 ${name} 必须只有 getter（rc.5 只读），实际描述符 ${JSON.stringify(Object.keys(d ?? {}))}`);
    }
    let threw = false;
    try {
      a[name] = { kind: "error" };
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`替身的 ${name} 可写 —— 复刻不出 rc.5 的「只读 getter」，本用例会假绿`);
  }
  for (const name of ["push", "ensure", "assemble", "mustGet", "blocks", "interruptedBlocks"]) {
    if (typeof a[name] !== "function") throw new Error(`替身缺 rc.5 成员 ${name}`);
  }
  if (typeof a.replayState !== "object") throw new Error("替身缺 replayState");
  if (typeof a.message !== "object") throw new Error("替身缺 message");
};

tests["B1-1 回退分支在 rc.5 形状的 BlockAssembler 上必须真的走通（不得降级成规则摘要）"] = async (t) => {
  const { engine, ctx, session } = await makeRig();
  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  if (!out) throw new Error("summarize 返回空");

  // ① 旧代码在这里被外层 catch 吃成 degraded: "rules"（TYPE_ERROR → 规则摘要）
  t.eq(out.degraded, undefined, "回退分支不得降级成规则摘要（旧代码在 rc.5 形状上 TypeError ⇒ degraded=rules）");
  t.eq(ctx.streamCalls.length, 2, "必须两次调用：先配错的摘要模型，再退回当前路由");
  t.eq(ctx.streamCalls[0].model, BAD_MODEL, "第一次必须先用配置的摘要模型");
  t.eq(ctx.streamCalls[1].model, "m", "第二次必须退回当前路由模型 m");

  // ② provider/model 是 routed，不是配错的那个
  t.eq(out.provider, "p", "out.provider 必须是当前路由 p");
  t.eq(out.model, "m", "out.model 必须是当前路由 m");

  // ③ 摘要文本来自 **retry 那次** 的产出（换引用后 blocks() 读的是 retry 实例）
  const text = (out.summary ?? []).map((b) => String(b?.text ?? "")).join("\n");
  t.includes(text, ROUTED_TEXT, "摘要文本必须来自 retry 的产出");

  // ④ usage 来自 retry 实例的只读 getter（旧写法 assembler.usage = retry.usage 会 TypeError）
  t.eq(out.usage, { inputTokens: 11, outputTokens: 22 }, "usage 必须来自 retry 实例");

  // ⑤ 不该出现「摘要模型全部不可用」那条误导性 warn（那是旧代码吞掉 TypeError 的痕迹）
  t.notIncludes(ctx.warns.join("\n"), "全部不可用", "不得出现「摘要模型全部不可用」—— 说明回退其实成功了");
};
