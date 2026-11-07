#!/usr/bin/env node
/**
 * lme-pilot-reader.mjs —— K-27 真实 reader 的预注册 10 题 pilot smoke
 *
 * 预注册规则（在任何模型调用之前固定，不许看结果换题）：
 *   · 五类 IE/MR/KU/TR/ABS 各取冻结夹具顺序里的前 2 题，共 10 题；
 *   · 每题 full/compact 两臂各一次，共 20 次显式调用；
 *   · reader 只看 makeReaderPayload 的四字段（id/arm/question/context），
 *     不传金标准、evidenceSeqs、grader、 applicability、另一臂。
 *
 * 这是 pilot，不是正式 50/50 质量门；输出文件明确写 PILOT_ONLY。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  TYPES,
  ARMS,
  assertValidFixtures,
  assertReaderPayload,
  makeReaderPayload,
  gradeAnswer,
} from "./lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = nodePath.join(HERE, "..", "evidence", "lme-task50.fixtures.json");
const FIXTURES_PATH = process.env.LME_PILOT_FIXTURES ? nodePath.resolve(process.env.LME_PILOT_FIXTURES) : DEFAULT_FIXTURES;
const DEFAULT_OUT = nodePath.join(HERE, "..", "evidence", "lme-pilot-reader-2026-11-07.json");
const MODEL = process.env.LME_READER_MODEL || "deepseek-v4.1-flash-1017";
const VARIANT = process.env.LME_READER_VARIANT || "v1";
const POSTPROCESS = process.env.LME_READER_POSTPROCESS || "none";
const ENDPOINT = process.env.LME_READER_ENDPOINT || "http://127.0.0.1:3425/v1/chat/completions";
const PER_TYPE = 2;

export function selectPilot(questions, { perType = PER_TYPE } = {}) {
  return TYPES.flatMap((type) => questions.filter((item) => item.type === type).slice(0, perType));
}

/** 只去首尾空白和一层包裹反引号/引号；不做语义改写，保留原始输出供复核。 */
export function normalizeReaderAnswer(raw) {
  let text = String(raw ?? "").trim();
  // 模型偶尔把答案包在 ``` 代码围栏里；先去掉这一层，再处理单引号/反引号。
  if (text.startsWith("```") && text.endsWith("```") && text.length >= 6) {
    text = text.slice(3, -3).trim();
  }
  const pairs = [["`", "`"], ['"', '"'], ["'", "'"], ["“", "”"]];
  for (const [left, right] of pairs) {
    if (text.startsWith(left) && text.endsWith(right) && text.length >= left.length + right.length) {
      text = text.slice(left.length, -right.length).trim();
      break;
    }
  }
  return text;
}

/**
 * v1n 确定性校验：纯数字答案必须是上下文中的独立 token；否则改成 UNKNOWN。
 * 只处理「数字编造/截断」，不改中文词、列表或 id。
 */
export function postProcessAnswer(answer, context, { mode = POSTPROCESS, question = "" } = {}) {
  const text = String(answer ?? "");
  // v1e：问题点名 missing/未记录实体时，任何非 UNKNOWN 答案都是越权回答。
  if (mode === "v1e" && /(?:\bmissing\b|未记录|未出现|not recorded)/i.test(String(question ?? "")) && text.trim() !== "UNKNOWN") {
    return "UNKNOWN";
  }
  if (mode !== "v1n" && mode !== "v1e") return answer;
  if (!/^\d+$/.test(text)) return answer;
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = new RegExp(`(?:^|[^0-9A-Za-z_-])${escaped}(?:$|[^0-9A-Za-z_-])`).test(String(context ?? ""));
  return present ? answer : "UNKNOWN";
}

export const READER_PROMPTS = Object.freeze({
  v1:
    "You answer a single question from the supplied context. " +
    "Use only the context. Do not explain. " +
    "For an id or list answer, output only the exact id(s) separated by commas. " +
    "If the context does not support an answer, output exactly UNKNOWN.",
  v1b:
    "You answer a single question from the supplied context. " +
    "Use only the context. Do not explain. " +
    "For an id or list answer, output only the exact id(s) separated by commas. " +
    "If the context does not explicitly contain the requested value, output exactly UNKNOWN. " +
    "Do not infer missing ids or seqs, and never use a status word (untested, right-censored, pending, archived) as the answer.",
  v2:
    "You answer a single question from the supplied context. " +
    "Silently find the smallest verbatim span that answers the question; do not show that step. " +
    "Output only the span, exactly as written: no explanation, no quotes, no code fence. " +
    "For a list answer, output the exact ids in the order they appear, comma-separated. " +
    "If no span explicitly records the requested value, output exactly UNKNOWN. " +
    "Never substitute a status word (untested, right-censored, pending) for UNKNOWN.",
  /**
   * v4（AX-27）：在 v2 的「逐字 span」基础上，专门处理**比较题**（之前/之后）。
   * v2 要求输出上下文原文 span，但 TR 题的金标准是单词 `before` / `after`，
   * 于是模型答对事实也判错。v4 显式要求：比较题只输出 before/after（或中文 之前/之后）。
   */
  v4:
    "You answer a single question from the supplied context. " +
    "Silently find the smallest verbatim span that answers the question; do not show that step. " +
    "If the question asks whether one event happened before or after another, output exactly one word: " +
    "`before` or `after` (中文题可输出 之前 / 之后)，不要输出别的文字。 " +
    "Otherwise output only the span, exactly as written: no explanation, no quotes, no code fence. " +
    "For a list answer, output the exact ids in the order they appear, comma-separated. " +
    "If no span explicitly records the requested value, output exactly UNKNOWN. " +
    "Never substitute a status word (untested, right-censored, pending) for UNKNOWN.",
  v3extract:
    "You are an evidence extractor. Find the shortest verbatim span in the context that answers the question. " +
    "Output only that span, exactly as written; no explanation, no quotes, no code fence. " +
    "If no span answers it, output exactly NONE.",
  v3answer:
    "You are a strict answer writer. You receive a question and an evidence span. " +
    "Output only the exact answer taken from the span; no explanation, no quotes, no code fence. " +
    "For a list answer, output the exact ids in the order they appear, comma-separated. " +
    "If the span is NONE or does not explicitly record the requested value, output exactly UNKNOWN. " +
    "Never substitute a status word (untested, right-censored, pending) for UNKNOWN.",
});

export function buildMessages(payload, { variant = "v1" } = {}) {
  if (variant === "v3extract" || variant === "v3answer") throw new Error("v3 is a two-step variant; use buildTwoStepMessages");
  const system = READER_PROMPTS[variant];
  if (!system) throw new Error(`unknown reader prompt variant: ${variant}`);
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Context:\n${payload.context}\n\nQuestion: ${payload.question}\n\nAnswer:`,
    },
  ];
}

export function buildTwoStepMessages(payload, { step }) {
  if (step === "extract") {
    return [
      { role: "system", content: READER_PROMPTS.v3extract },
      { role: "user", content: `Context:\n${payload.context}\n\nQuestion: ${payload.question}\n\nSpan:` },
    ];
  }
  if (step === "answer") throw new Error("answer step requires a span; use buildAnswerMessages");
  throw new Error(`unknown two-step: ${step}`);
}

export function buildAnswerMessages(payload, span) {
  return [
    { role: "system", content: READER_PROMPTS.v3answer },
    { role: "user", content: `Question: ${payload.question}\n\nEvidence span:\n${span}\n\nAnswer:` },
  ];
}

async function callChat(messages) {
  const started = Date.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: 2048, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const latencyMs = Date.now() - started;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`reader HTTP ${response.status}: ${String(body?.error?.message ?? JSON.stringify(body)).slice(0, 300)}`);
  const choice = body?.choices?.[0] ?? {};
  return {
    raw: choice?.message?.content ?? null,
    finishReason: choice?.finish_reason ?? null,
    usage: body?.usage ?? null,
    latencyMs,
  };
}

async function callModel(payload) {
  return callChat(buildMessages(payload, { variant: VARIANT }));
}

/** v3：先抽 evidence span，再只根据 span 回答；两步都记录原始输出。 */
export async function callTwoStep(payload) {
  const first = await callChat(buildTwoStepMessages(payload, { step: "extract" }));
  const span = String(first.raw ?? "").trim();
  const second = await callChat(buildAnswerMessages(payload, span === "" ? "NONE" : span));
  return {
    raw: second.raw,
    finishReason: second.finishReason,
    usage: {
      prompt_tokens: Number(first.usage?.prompt_tokens ?? 0) + Number(second.usage?.prompt_tokens ?? 0),
      completion_tokens: Number(first.usage?.completion_tokens ?? 0) + Number(second.usage?.completion_tokens ?? 0),
      total_tokens: Number(first.usage?.total_tokens ?? 0) + Number(second.usage?.total_tokens ?? 0),
    },
    latencyMs: first.latencyMs + second.latencyMs,
    trace: { extractRaw: first.raw, span, answerRaw: second.raw, extractFinishReason: first.finishReason, answerFinishReason: second.finishReason },
  };
}

export async function runPilot({ fixtures, log = console.log } = {}) {
  const questions = assertValidFixtures(fixtures);
  const selected = selectPilot(questions);
  if (selected.length !== TYPES.length * PER_TYPE) throw new Error(`pilot selection must be ${TYPES.length * PER_TYPE}; got ${selected.length}`);
  const results = [];
  for (const [index, item] of selected.entries()) {
    for (const arm of ARMS) {
      const payload = makeReaderPayload(item, arm);
      assertReaderPayload(payload);
      log(`[${index + 1}/${selected.length}] ${item.id} ${arm}`);
      let call;
      try {
        call = VARIANT === "v3" ? await callTwoStep(payload) : await callModel(payload);
      } catch (error) {
        call = { raw: null, finishReason: "error", usage: null, latencyMs: 0, error: String(error?.message ?? error) };
      }
      const answer = postProcessAnswer(normalizeReaderAnswer(call.raw), payload.context, { mode: POSTPROCESS, question: payload.question });
      const grade = gradeAnswer(item.answer, answer, item.grader, item.aliases ?? []);
      results.push({
        id: item.id,
        type: item.type,
        arm,
        question: item.question,
        contextChars: payload.context.length,
        raw: call.raw,
        answer,
        grade,
        finishReason: call.finishReason,
        usage: call.usage,
        latencyMs: call.latencyMs,
        trace: call.trace ?? null,
        ...(call.error ? { error: call.error } : {}),
      });
    }
  }
  return { ...summarize(selected, results), variant: VARIANT, postprocess: POSTPROCESS };
}

export function summarize(selected, results) {
  const byType = Object.fromEntries(TYPES.map((type) => [type, { full: { correct: 0, total: 0 }, compact: { correct: 0, total: 0 } }]));
  for (const row of results) {
    byType[row.type][row.arm].total += 1;
    if (row.grade.correct) byType[row.type][row.arm].correct += 1;
  }
  const fullCorrect = results.filter((row) => row.arm === "full" && row.grade.correct).length;
  const compactCorrect = results.filter((row) => row.arm === "compact" && row.grade.correct).length;
  const total = selected.length;
  const errors = results.filter((row) => row.error || !row.grade.correct).map((row) => ({ id: row.id, arm: row.arm, code: row.grade.code, error: row.error ?? null }));
  return {
    schema: "lme-pilot-reader-v1",
    status: "PILOT_ONLY",
    qualityGate: "NOT_APPLICABLE_PILOT",
    model: MODEL,
    endpoint: ENDPOINT,
    selectionRule: `first ${PER_TYPE} per type in frozen fixture order`,
    selected: selected.map((item) => ({ id: item.id, type: item.type, applicability: item.applicability, grader: item.grader, answer: item.answer })),
    summary: {
      questions: total,
      calls: results.length,
      fullCorrect,
      compactCorrect,
      delta: compactCorrect - fullCorrect,
      byType,
      errors,
      callsWithError: results.filter((row) => row.error).length,
      usageTotals: results.reduce(
        (acc, row) => {
          acc.inputTokens += Number(row.usage?.prompt_tokens ?? 0);
          acc.outputTokens += Number(row.usage?.completion_tokens ?? 0);
          acc.totalTokens += Number(row.usage?.total_tokens ?? 0);
          acc.latencyMs += Number(row.latencyMs ?? 0);
          return acc;
        },
        { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 },
      ),
    },
    results,
    note: "Pilot smoke only. It does not establish the formal 50/50 task-quality gate and does not change defaults.",
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# K-27 真实 reader pilot smoke（10 题 × 2 臂）");
  lines.push("");
  lines.push("> **PILOT_ONLY**：不是正式 50/50 质量门；预注册规则见文末，不换题、不回调阈值。");
  lines.push("");
  lines.push(`- 模型：\`${report.model}\``);
  lines.push(`- 调用：${report.summary.calls} 次（10 题 × full/compact）`);
  lines.push(`- 机械判分：full **${report.summary.fullCorrect}/${report.summary.questions}** · compact **${report.summary.compactCorrect}/${report.summary.questions}** · Δ **${report.summary.delta}**`);
  lines.push(`- 用量：input ${report.summary.usageTotals.inputTokens} / output ${report.summary.usageTotals.outputTokens} tokens；总延迟 ${report.summary.usageTotals.latencyMs} ms`);
  lines.push("");
  lines.push("| 题 | 类 | full | compact | full 答案 | compact 答案 |");
  lines.push("|---|---|---|---|---|---|");
  for (const id of [...new Set(report.results.map((row) => row.id))]) {
    const f = report.results.find((row) => row.id === id && row.arm === "full");
    const c = report.results.find((row) => row.id === id && row.arm === "compact");
    lines.push(`| ${id} | ${f.type} | ${f.grade.correct ? "✓" : "✗"} | ${c.grade.correct ? "✓" : "✗"} | \`${String(f.answer ?? "").replace(/\|/g, "\\|").slice(0, 80)}\` | \`${String(c.answer ?? "").replace(/\|/g, "\\|").slice(0, 80)}\` |`);
  }
  lines.push("");
  lines.push("## 预注册");
  lines.push("");
  lines.push(`- ${report.selectionRule}；五类各 2 题，共 10 题；每题两臂各一次。`);
  lines.push("- reader 只看 `{id,arm,question,context}` 四字段；金标准、证据、grader、applicability 不进入请求。");
  lines.push("- 判分是冻结夹具的机械判分；本 pilot 不据此改默认剪枝、不宣称正式质量门通过。");
  lines.push("");
  return lines.join("\n");
}

function readJson(path) {
  return JSON.parse(nodeFs.readFileSync(path, "utf8"));
}

async function main(argv = process.argv.slice(2)) {
  const run = argv.includes("--run");
  const write = argv.includes("--write");
  if (!run) {
    console.log(JSON.stringify({ status: "NOT_RUN", note: "pilot reader requires --run (explicit 20 model calls)" }, null, 2));
    return 0;
  }
  const fixtures = readJson(FIXTURES_PATH);
  const report = await runPilot({ fixtures });
  if (write) {
    const out = process.env.LME_PILOT_OUT || DEFAULT_OUT;
    nodeFs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
    const md = out.replace(/\.json$/i, ".md");
    nodeFs.writeFileSync(md, renderMarkdown(report), "utf8");
    console.log(`wrote ${out}`);
    console.log(`wrote ${md}`);
  }
  console.log(JSON.stringify(report.summary, null, 2));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
