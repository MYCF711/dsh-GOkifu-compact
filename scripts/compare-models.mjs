/**
 * compare-models.mjs —— 同一切片、同一 prompt、同一 maxTokens，横向对比多个摘要模型（P2-1 / task-197）
 *
 * 目的：回答「换个模型，摘要质量/延迟/成本差多少」——**只许换模型**，别的都不许变。
 * 因此脚本强制三件事：
 *   1. **同一 fold 切片**：从真实 graph 里取最近一次 fold 的范围（没有 foldMark 则全量），
 *      `renderFacts(g, { range })` 出来的硬事实块逐字节相同；
 *   2. **同一 instruction**：`buildChessInstruction()` 同一份（含约束/失败边口径），不做任何按模型改写；
 *   3. **同一 maxTokens**：所有模型同一个上限。
 *
 * 每个模型跑 N 次（默认 3），记：延迟中位、usage、失败、摘要长度、四章节完整度。
 *
 * 用法：
 *   node scripts/compare-models.mjs --session=<id> [--repeat=3] [--max-tokens=900]
 *                                   [--models=a,b] [--out=evidence/compare-models.json] [--dry-run]
 *   不传 --session 时自动挑「失败边最多」的真实会话。
 *
 * 退出码：0 = 至少一个模型有成功样本；1 = 全部失败；2 = 参数/环境错误（含 dry-run 成功时仍为 0）。
 *
 * ⚠ 本脚本**只读** DSH_HOME（graph.json）；唯一写的东西是 --out 指定的证据文件。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { fromJSON } from "../src/rooms/kifu-model.mjs";
import { renderFacts, estimateTokens } from "../src/rooms/ledger.mjs";
import { buildChessInstruction } from "../src/rooms/facts-prompt.mjs";
import { failureEdges } from "../src/rooms/kifu-model.mjs";

/** 摘要必须包含的四章节（与 engine.ruleSummary / 模型 instruction 同一口径）。 */
export const REQUIRED_SECTIONS = Object.freeze([
  { key: "goal", heading: "## 目标" },
  { key: "failures", heading: "## 已探明死路" },
  { key: "verified", heading: "## 已验证事实" },
  { key: "coords", heading: "## 原始坐标" },
]);

export const DEFAULT_MODELS = Object.freeze(["group/deepseek-v4.1-flash1017", "group/gokifu-compact"]);
export const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";
export const DEFAULT_MAX_TOKENS = 900;
export const DEFAULT_REPEAT = 3;

/* ────────────────────────── 纯函数（单测直接打） ────────────────────────── */

/**
 * 解析 CLI 参数（纯函数）。
 * @param {string[]} argv 不含 node/脚本名的参数数组
 * @param {Record<string,string|undefined>} [env]
 */
export function parseArgs(argv, env = {}) {
  const out = {
    session: "",
    graph: "",
    models: [...(env.COMPARE_MODELS ? env.COMPARE_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS)],
    repeat: DEFAULT_REPEAT,
    maxTokens: DEFAULT_MAX_TOKENS,
    baseUrl: env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.MAGPIE_API_KEY ?? "",
    timeoutMs: Number(env.COMPARE_TIMEOUT_MS ?? 120_000),
    out: nodePath.join("evidence", "compare-models.json"),
    dryRun: false,
    home: env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh"),
  };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (!arg.startsWith("--") || eq < 0) throw new Error(`无法识别的参数：${arg}（只接受 --key=value 或 --dry-run）`);
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case "session":
        out.session = value;
        break;
      case "graph":
        out.graph = value;
        break;
      case "models":
        out.models = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "repeat":
        out.repeat = Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : DEFAULT_REPEAT;
        break;
      case "max-tokens":
        out.maxTokens = Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : DEFAULT_MAX_TOKENS;
        break;
      case "base-url":
        out.baseUrl = value;
        break;
      case "api-key":
        out.apiKey = value;
        break;
      case "timeout-ms":
        out.timeoutMs = Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : out.timeoutMs;
        break;
      case "out":
        out.out = value;
        break;
      case "home":
        out.home = value;
        break;
      default:
        throw new Error(`未知开关 --${key}`);
    }
  }
  if (out.models.length === 0) throw new Error("--models 不能为空");
  return out;
}

/** 中位数（偶数取中间两个的均值；空数组 → null）。 */
export function median(values) {
  const nums = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

/**
 * 从 graph 里选 fold 切片：最近一条 foldMark 的 [seqStart, seqEnd]；没有则 null（= 全量）。
 * 为什么要它：不同模型必须看**同一段**历史，否则比的是「谁的切片大」而不是「谁的摘要好」。
 */
export function pickFoldSlice(g) {
  const marks = Array.isArray(g?.foldMarks) ? g.foldMarks : [];
  const last = marks.at(-1);
  if (!last || typeof last.seqStart !== "number" || typeof last.seqEnd !== "number") return null;
  return { start: last.seqStart, end: last.seqEnd };
}

/**
 * 构造「所有模型共享」的测试输入：硬事实块 + instruction + messages。
 * @returns {{facts:string, instruction:string, messages:Array<{role:string,content:string}>, range:{start:number,end:number}|null, factsChars:number, factsTokens:number}}
 */
export function buildComparisonPrompt(g, { range = null } = {}) {
  const facts = renderFacts(g, { range });
  const instruction = buildChessInstruction({
    facts,
    shadowedStart: range?.start,
    shadowedEnd: range?.end,
    priorFold: Array.isArray(g?.foldMarks) && g.foldMarks.length > 0,
  });
  return {
    facts,
    instruction,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: "Fold the conversation above into the required compact record. Output only the record." },
    ],
    range,
    factsChars: facts.length,
    factsTokens: estimateTokens(facts),
  };
}

/** 统计摘要的四章节完整度 + 长度 + 约束条数。 */
export function assessSummary(text) {
  const raw = typeof text === "string" ? text : "";
  const sections = {};
  for (const { key, heading } of REQUIRED_SECTIONS) sections[key] = raw.includes(heading);
  const present = Object.values(sections).filter(Boolean).length;
  return {
    chars: raw.length,
    tokens: estimateTokens(raw),
    sections,
    sectionsPresent: present,
    complete: present === REQUIRED_SECTIONS.length,
    constraintBullets: raw.split("\n").filter((line) => /^\s*[-*]\s/.test(line)).length,
  };
}

/** 把 OpenAI 兼容响应解析成 {text, usage, finish}（找不到就返回 null —— 不许编造）。 */
export function parseChatResponse(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  if (!choice) return { text: null, usage: json?.usage ?? null, finish: null };
  const content = choice.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : String(part?.text ?? ""))).join("")
        : null;
  return { text, usage: json?.usage ?? null, finish: choice.finish_reason ?? null };
}

/**
 * 调一次模型（单次样本）。fetch 可注入 ⇒ 单测用假 fetch，无需网络。
 * @returns {Promise<{ok:boolean, latencyMs:number, text:string|null, usage:any, finish:any, status:number|null, error:string|null}>}
 */
export async function summarizeOnce({ fetchImpl, baseUrl, apiKey, model, messages, maxTokens, timeoutMs = 120_000 }) {
  const startedAt = Date.now();
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, stream: false });
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const status = typeof response?.status === "number" ? response.status : null;
    const raw = typeof response?.text === "function" ? await response.text() : JSON.stringify(await response?.json?.());
    const okStatus = status === null ? true : status >= 200 && status < 300;
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    if (!okStatus) {
      return { ok: false, latencyMs, text: null, usage: json?.usage ?? null, finish: null, status, error: `HTTP ${status}: ${String(raw).slice(0, 300)}` };
    }
    const parsed = parseChatResponse(json);
    if (parsed.text === null || parsed.text.trim().length === 0) {
      return { ok: false, latencyMs, text: null, usage: parsed.usage, finish: parsed.finish, status, error: `响应里没有文本：${String(raw).slice(0, 300)}` };
    }
    return { ok: true, latencyMs, text: parsed.text, usage: parsed.usage, finish: parsed.finish, status, error: null };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      text: null,
      usage: null,
      finish: null,
      status: null,
      error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 汇总一个模型的 N 次样本：**只用成功样本**算中位，失败单独计数（不许把失败当 0 拉低中位）。
 * @returns {{model:string, runs:number, ok:number, failed:number, errors:string[], medianLatencyMs:number|null, medianChars:number|null, medianTokens:number|null, sectionsMedian:number|null, completeRuns:number, usageSamples:Array<object>}}
 */
export function aggregateModel(model, runs) {
  const list = Array.isArray(runs) ? runs : [];
  const good = list.filter((r) => r.ok);
  const errors = [...new Set(list.filter((r) => !r.ok).map((r) => r.error).filter(Boolean))];
  return {
    model,
    runs: list.length,
    ok: good.length,
    failed: list.length - good.length,
    errors,
    medianLatencyMs: median(good.map((r) => r.latencyMs)),
    medianChars: median(good.map((r) => r.assessment?.chars ?? r.text?.length ?? null)),
    medianTokens: median(good.map((r) => r.assessment?.tokens ?? null)),
    sectionsMedian: median(good.map((r) => r.assessment?.sectionsPresent ?? null)),
    completeRuns: good.filter((r) => r.assessment?.complete === true).length,
    usageSamples: good.map((r) => r.usage).filter((u) => u !== null && u !== undefined),
  };
}

/** 整个对比结果（可复现：把 prompt 与每样本都记下来）。 */
export function buildReport({ session, range, prompt, models, repeat, maxTokens, baseUrl, samples }) {
  return {
    generatedAt: new Date().toISOString(),
    session,
    range,
    repeat,
    maxTokens,
    baseUrl,
    prompt: { factsChars: prompt.factsChars, factsTokens: prompt.factsTokens, instructionChars: prompt.instruction.length, systemChars: prompt.messages[0].content.length },
    models: models.map((model) => aggregateModel(model, samples[model] ?? [])),
    samples,
  };
}

/* ────────────────────────── 真实数据（只读 DSH_HOME） ────────────────────────── */

/** 读一个会话的 graph（graph.json = 上一回合基线快照，足够做对比）。 */
export function loadGraph(home, sessionId) {
  const file = nodePath.join(home, "chess-context", "sessions", String(sessionId), "graph.json");
  if (!nodeFs.existsSync(file)) throw new Error(`找不到 graph：${file}`);
  return { graph: fromJSON(nodeFs.readFileSync(file, "utf8")), file };
}

/** 在真实会话里挑「失败边最多」的一个（没有就挑最大的）。 */
export function pickSession(home) {
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) throw new Error(`找不到棋谱目录：${root}`);
  let best = null;
  for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = nodePath.join(root, d.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    try {
      const g = fromJSON(nodeFs.readFileSync(file, "utf8"));
      const failures = failureEdges(g).length;
      if (best === null || failures > best.failures) best = { id: d.name, failures, graph: g };
    } catch {
      /* 坏图跳过 */
    }
  }
  if (best === null) throw new Error("没有任何可读的 graph.json");
  return best;
}

/* ────────────────────────── CLI ────────────────────────── */

async function main(argv) {
  const opts = parseArgs(argv, process.env);
  const picked = opts.graph ? { graph: fromJSON(nodeFs.readFileSync(opts.graph, "utf8")), id: nodePath.basename(nodePath.dirname(opts.graph)) } : opts.session ? { ...loadGraph(opts.home, opts.session), id: opts.session } : pickSession(opts.home);
  const graph = picked.graph;
  const sessionId = picked.id ?? graph.sessionId ?? "unknown";
  const range = pickFoldSlice(graph);
  const prompt = buildComparisonPrompt(graph, { range });
  const failures = failureEdges(graph, range ? undefined : undefined).length;

  if (opts.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          session: sessionId,
          range,
          models: opts.models,
          repeat: opts.repeat,
          maxTokens: opts.maxTokens,
          factsChars: prompt.factsChars,
          factsTokens: prompt.factsTokens,
          instructionChars: prompt.instruction.length,
          graphFailures: failures,
        },
        null,
        1,
      )}\n`,
    );
    return 0;
  }

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 没有全局 fetch（需要 Node 18+）");
  const samples = {};
  let anyOk = false;
  for (const model of opts.models) {
    samples[model] = [];
    for (let i = 0; i < opts.repeat; i += 1) {
      const run = await summarizeOnce({
        fetchImpl,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model,
        messages: prompt.messages,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
      });
      const enriched = { ...run, assessment: run.ok ? assessSummary(run.text) : null };
      samples[model].push(enriched);
      if (run.ok) anyOk = true;
      const line = run.ok
        ? `✓ ${model} #${i + 1} ${run.latencyMs} ms · ${enriched.assessment.chars} 字符 · ${enriched.assessment.sectionsPresent}/4 章节`
        : `✗ ${model} #${i + 1} ${run.latencyMs} ms · ${run.error}`;
      process.stdout.write(`  ${line}\n`);
    }
  }
  const report = buildReport({
    session: sessionId,
    range,
    prompt,
    models: opts.models,
    repeat: opts.repeat,
    maxTokens: opts.maxTokens,
    baseUrl: opts.baseUrl,
    samples,
  });
  const outPath = nodePath.isAbsolute(opts.out) ? opts.out : nodePath.join(process.cwd(), opts.out);
  nodeFs.mkdirSync(nodePath.dirname(outPath), { recursive: true });
  nodeFs.writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`, "utf8");
  process.stdout.write(`\n写入 ${outPath}\n`);
  for (const m of report.models) {
    process.stdout.write(
      `  ${m.model}: ${m.ok}/${m.runs} 成功 · 中位 ${m.medianLatencyMs ?? "—"} ms · ${m.medianChars ?? "—"} 字符 · 章节 ${m.sectionsMedian ?? "—"}/4（完整 ${m.completeRuns}/${m.ok}）\n`,
    );
  }
  return anyOk ? 0 : 1;
}

const isDirectRun = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`compare-models: ${error?.message ?? error}\n`);
      process.exitCode = 2;
    });
}
