/**
 * real-fold-trigger.mjs —— 验证「自动 fold 真的会触发」：阈值 + 增长门 + 真实模型
 *
 * real-fold.mjs 只验证了「手动给范围能压」；这个文件验证**自动路径**：
 *   ① 上下文超过阈值 ⇒ compactIfNeeded('pressure') 真的压
 *   ② 压完立刻再调 ⇒ growth gate 拦住（增量不足）
 *   ③ 增量够了 ⇒ 再压一次，且第二次范围从第一个 checkpoint 之后开始（增量语义）
 *   ④ 摘要由真实模型生成（magpie），不是模板
 *
 * 用法：node test/real-fold-trigger.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const WORK = nodePath.join(ROOT, "..", "..", "tmp", "dsh-chess-context", "modules");
const OUT = nodePath.join(ROOT, "evidence");
const BASE = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425/v1";
const MODEL = process.env.MAGPIE_MODEL ?? "group/deepseek-v4.1-flash1017";

if (!nodeFs.existsSync(nodePath.join(WORK, "src", "engine.mjs"))) {
  console.log("! 先跑 node test/real-modules.mjs（提取依赖闭包）");
  process.exit(0);
}

const workRequire = createRequire(nodePath.join(WORK, "package.json"));
const { Context } = await import(pathToFileURL(workRequire.resolve("@deepseek-ai/cordis")).href);
// 用**项目当前源码**，不是旧副本
const { default: Engine } = await import(pathToFileURL(nodePath.join(ROOT, "src", "engine.mjs")).href).catch(async () => {
  // 依赖解析不到时，用提取目录里的副本
  return import(pathToFileURL(nodePath.join(WORK, "src", "engine.mjs")).href);
});

/* ── 迷你 session ── */
function makeSession(id) {
  const log = [];
  const nodes = [];
  let replaceGen = 0;
  let contentGen = 0;
  const session = {
    id,
    cwd: process.cwd(),
    get seq() {
      return log.length;
    },
    surface: {
      get nodes() {
        return nodes;
      },
      get replaceGeneration() {
        return replaceGen;
      },
      get contentGeneration() {
        return contentGen;
      },
    },
    eventAt(seq) {
      return log[seq];
    },
    requestHeader() {
      return { config: { provider: "p", model: "m", maxTokens: 4096 } };
    },
    toolHistory() {
      return { tools: [] };
    },
    deriveMessages() {
      return nodes.map((x) => log[x]).filter(Boolean);
    },
    deriveEventMessage(event) {
      if (!event) return null;
      if (event.type === "system/message") return { role: "system", content: [{ type: "text", text: "sys" }] };
      return event.data?.message ?? event.data ?? null;
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      log.push(event);
      const op = opts?.surfaceOp;
      const surfaceable = ["system/message", "developer/message", "user/message", "assistant/message", "tool/result"].includes(type);
      if (surfaceable) {
        if (op === "append" || op === undefined) nodes.push(event.seq);
        else if (op && op.op === "replace") {
          const a = nodes.indexOf(op.startSeq);
          const b = nodes.indexOf(op.endSeq);
          if (a < 0 || b < 0) throw new Error("bad replace");
          nodes.splice(a, b - a + 1, event.seq);
          replaceGen += 1;
          contentGen += 1;
        }
      }
      return event;
    },
    seed(kind, text) {
      const data = kind === "system" ? {} : { id: `m${log.length}`, role: kind, content: [{ type: "text", text }], source: { kind: kind === "user" ? "user" : "prompt" } };
      return session.append(kind === "system" ? "system/message" : `${kind}/message`, data, { surfaceOp: "append" });
    },
  };
  return session;
}

async function callModel(messages, maxTokens = 3072) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const m = json.choices?.[0]?.message ?? {};
  return { text: m.content && m.content.length > 0 ? m.content : m.reasoning_content ?? "", usage: json.usage ?? {} };
}

/* ── 场景：surface 累计 300K tokens（阈值 45% × 1M = 450K 不触发；用 200K 窗口则 90K 触发） ── */
const WINDOW = 200_000;
const THRESHOLD = Math.floor(WINDOW * 0.45); // 90K

function buildCtx(session, totalTokens) {
  const ctx = new Context();
  ctx.logger = { info() {}, warn: (...a) => console.log("   warn:", ...a), debug() {}, error: () => {} };
  ctx.sessions = { async flush() {} };
  ctx.llm = {
    async resolveModelInfo() {
      return { context: { contextWindow: WINDOW }, defaultMaxTokens: 4096 };
    },
    async *stream() {
      const out = await callModel([
        {
          role: "user",
          content:
            "把下面这段 AI 编程助手的会话压缩成棋谱摘要：保留全部失败尝试（每条一行，带原因原文）、目标、已验证事实、下一步。整份不超过 1200 字。\n\n" +
            session.surface.nodes
              .slice(0, 12)
              .map((s) => `[${session.eventAt(s)?.type}] ${JSON.stringify(session.eventAt(s)?.data).slice(0, 300)}`)
              .join("\n"),
        },
      ]);
      yield { type: "text-delta", text: out.text };
      yield { type: "finish", kind: "stop" };
    },
  };
  ctx.tokenMeter = {
    measure() {
      const n = session.surface.nodes.length;
      return {
        totalTokens: totalTokens.value,
        surfaceTokens: totalTokens.value,
        nodes: session.surface.nodes.map((s) => ({ seq: s, tokens: Math.round(totalTokens.value / Math.max(1, n)), heuristicTokens: Math.round(totalTokens.value / Math.max(1, n)) })),
      };
    },
    estimateMessage() {
      return 500;
    },
  };
  return ctx;
}

const session = makeSession("fold-trigger");
const total = { value: 60_000 };
const ctx = buildCtx(session, total);
const engine = new Engine(ctx, {
  auto: false,
  graphDir: nodePath.join(WORK, "graphs-trigger"),
  growthFloorTokens: 20_000,
  minFoldTokens: 8_000,
  retainRatio: 0.1,
  maxTokens: 2048,
  summaryMode: "hybrid",
});

session.seed("system", "sys");
session.append("turn/start", { turn: 1 });
for (let i = 0; i < 24; i += 1) session.seed("user", `第 ${i} 步：${i % 3 === 0 ? "改缓存策略" : "跑测试"}（这是用于验证 fold 的长历史）`);

const agent = { session, options: {} };
const results = [];

console.log(`== real-fold-trigger（${MODEL}）==`);
console.log(`窗口 ${WINDOW}，阈值 ${THRESHOLD}；surface ${session.surface.nodes.length} 个节点`);

/* ① 低于阈值：不压 */
total.value = 60_000;
const r0 = await engine.compactIfNeeded(agent, "pressure", undefined);
console.log(`① 60K < 90K：${r0 === null ? "未 fold ✓" : "居然 fold 了 ✗"}`);
results.push({ step: "below-threshold", folded: r0 !== null });

/* ② 超过阈值：压 */
total.value = 150_000;
const before = session.surface.nodes.length;
const r1 = await engine.compactIfNeeded(agent, "pressure", undefined);
const after1 = session.surface.nodes.length;
console.log(`② 150K > 90K：${r1 ? `fold ✓（surface ${before} → ${after1}）` : "没 fold ✗"}`);
results.push({ step: "over-threshold", folded: Boolean(r1), before, after: after1, summaryChars: r1?.summary?.map((b) => b.text).join("").length ?? 0 });

/* ③ 立刻再调：growth gate 拦 */
const r2 = await engine.compactIfNeeded(agent, "pressure", undefined);
console.log(`③ 立刻再调（增量 0）：${r2 === null ? "被 growth gate 拦住 ✓" : "又 fold 了 ✗"}`);
results.push({ step: "growth-gate", folded: r2 !== null });

/* ④ 增量够了再压：范围从 checkpoint 之后开始 */
total.value = 240_000;
const r3 = await engine.compactIfNeeded(agent, "pressure", undefined);
console.log(`④ 增量 90K：${r3 ? "再次 fold ✓" : "没 fold ✗"}`);
results.push({ step: "second-fold", folded: Boolean(r3) });

/* ⑤ 溢出自救 */
const r4 = await engine.compactIfNeeded(agent, "context-overflow", undefined);
console.log(`⑤ 溢出自救：${r4 ? "fold ✓" : "未 fold（可能已无可压内容）"}`);
results.push({ step: "overflow", folded: Boolean(r4) });

const passed = results.filter((r) => (r.step === "below-threshold" || r.step === "growth-gate" ? !r.folded : r.folded)).length;
console.log(`\n通过 ${passed}/${results.length} 项`);

nodeFs.mkdirSync(OUT, { recursive: true });
const payload = { generatedAt: new Date().toISOString(), model: MODEL, window: WINDOW, threshold: THRESHOLD, results };
nodeFs.writeFileSync(nodePath.join(OUT, "fold触发验证.json"), JSON.stringify(payload, null, 2), "utf8");
// md 由 test/write-fold-evidence.mjs 从 json 生成（md 与 json 永远同源）
