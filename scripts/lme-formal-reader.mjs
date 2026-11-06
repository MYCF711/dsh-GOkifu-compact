#!/usr/bin/env node
/**
 * lme-formal-reader.mjs —— K-27 v2 正式 50/50 真实 reader
 *
 * 读取已预注册的 v2 夹具（只给 TR-01/02 加中英文别名），
 * 50 题 × full/compact 两臂 = 100 次显式模型调用。
 * 判分使用冻结门槛；本脚本不改默认行为，也不做结果后选题。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARMS,
  TYPES,
  assertValidFixtures,
  assertReaderPayload,
  makeReaderPayload,
  evaluateRun,
} from "./lme-task50.mjs";
import { buildMessages, normalizeReaderAnswer, postProcessAnswer, callTwoStep } from "./lme-pilot-reader.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FIXTURES = nodePath.join(HERE, "..", "evidence", "lme-task50-v2.fixtures.json");
const OUT = process.env.LME_FORMAL_OUT || nodePath.join(HERE, "..", "evidence", "lme-formal-reader-2026-11-07.json");
const MODEL = process.env.LME_READER_MODEL || "deepseek-v4.1-flash-1017";
const VARIANT = process.env.LME_READER_VARIANT || "v2";
const POSTPROCESS = process.env.LME_READER_POSTPROCESS || "none";
const ENDPOINT = process.env.LME_READER_ENDPOINT || "http://127.0.0.1:3425/v1/chat/completions";

async function callModel(payload) {
  const started = Date.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: buildMessages(payload, { variant: VARIANT }),
      temperature: 0,
      max_tokens: 2048,
      stream: false,
    }),
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

export function selection(fixtures) {
  return assertValidFixtures(fixtures);
}

export async function runFormal({ fixtures, log = console.log } = {}) {
  const questions = selection(fixtures);
  if (questions.length !== 50) throw new Error(`formal requires 50 questions; got ${questions.length}`);
  const calls = [];
  const results = [];
  for (const [index, item] of questions.entries()) {
    const pair = { id: item.id };
    for (const arm of ARMS) {
      const payload = makeReaderPayload(item, arm);
      assertReaderPayload(payload);
      log(`[${index + 1}/50] ${item.id} ${arm}`);
      let call;
      try {
        call = VARIANT === "v3" ? await callTwoStep(payload) : await callModel(payload);
      } catch (error) {
        call = { raw: null, finishReason: "error", usage: null, latencyMs: 0, error: String(error?.message ?? error) };
      }
      const answer = postProcessAnswer(normalizeReaderAnswer(call.raw), payload.context, { mode: POSTPROCESS });
      pair[arm] = answer;
      calls.push({
        id: item.id,
        type: item.type,
        arm,
        question: item.question,
        contextChars: payload.context.length,
        raw: call.raw,
        answer,
        finishReason: call.finishReason,
        usage: call.usage,
        latencyMs: call.latencyMs,
        ...(call.error ? { error: call.error } : {}),
      });
    }
    results.push(pair);
  }
  const evaluation = evaluateRun(fixtures, {
    schema: "lme-task50-results-v1",
    results,
    costs: { compressionRatio: "NOT_RUN", hotLedgerTokens: "NOT_RUN", readerLatencyMs: calls.reduce((n, c) => n + c.latencyMs, 0), readerCost: "NOT_RUN" },
  });
  return {
    schema: "lme-formal-reader-v1",
    status: "SCORED",
    variant: VARIANT,
    postprocess: POSTPROCESS,
    qualityGate: evaluation.qualityGate,
    passed: evaluation.passed,
    model: MODEL,
    endpoint: ENDPOINT,
    calls: calls.length,
    callsWithError: calls.filter((call) => call.error).length,
    usageTotals: calls.reduce(
      (acc, call) => {
        acc.inputTokens += Number(call.usage?.prompt_tokens ?? 0);
        acc.outputTokens += Number(call.usage?.completion_tokens ?? 0);
        acc.totalTokens += Number(call.usage?.total_tokens ?? 0);
        acc.latencyMs += Number(call.latencyMs ?? 0);
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 },
    ),
    byType: evaluation.byType,
    gates: evaluation.gates,
    thresholds: evaluation.thresholds,
    resultErrors: evaluation.resultErrors,
    unknownProcessIds: evaluation.unknownProcessIds,
    readerLimited: evaluation["reader-limited"],
    evaluation,
    callsDetail: calls,
    note: "Formal v2 run. Aliases are pre-registered for TR-01/02 only; no post-hoc question changes.",
  };
}

function renderMarkdown(report) {
  const e = report.evaluation;
  const lines = [];
  lines.push("# K-27 v2 正式 50/50 真实 reader");
  lines.push("");
  lines.push(`> 状态：**${report.qualityGate}** · 模型 \`${report.model}\` · 调用 ${report.calls} 次 · 错误 ${report.callsWithError} 次`);
  lines.push("");
  lines.push(`- full Acc：**${e.Acc_full}** · compact Acc：**${e.Acc_compact}** · Δtask：**${e["Δtask"]}**`);
  lines.push(`- 用量：input ${report.usageTotals.inputTokens} / output ${report.usageTotals.outputTokens} tokens；总延迟 ${report.usageTotals.latencyMs} ms`);
  lines.push("");
  lines.push("## 门槛");
  lines.push("");
  for (const [key, value] of Object.entries(report.gates)) lines.push(`- ${key}: **${value}**`);
  lines.push("");
  lines.push("## 分类");
  lines.push("");
  lines.push("| 类型 | full | compact | Δ |");
  lines.push("|---|---|---|---|");
  for (const type of TYPES) {
    const row = report.byType[type];
    lines.push(`| ${type} | ${row.Acc_full} | ${row.Acc_compact} | ${row["Δtask"]} |`);
  }
  lines.push("");
  const failed = report.evaluation.items.filter((item) => !item.full.correct || !item.compact.correct);
  lines.push("## 未全对题");
  lines.push("");
  if (failed.length === 0) lines.push("无。");
  else {
    lines.push("| 题 | full | compact | full 答案 | compact 答案 |");
    lines.push("|---|---|---|---|---|");
    for (const item of failed) {
      const f = report.callsDetail.find((call) => call.id === item.id && call.arm === "full")?.answer ?? "";
      const c = report.callsDetail.find((call) => call.id === item.id && call.arm === "compact")?.answer ?? "";
      lines.push(`| ${item.id} | ${item.full.correct ? "✓" : "✗"} | ${item.compact.correct ? "✓" : "✗"} | \`${String(f).replace(/\|/g, "\\|").slice(0, 80)}\` | \`${String(c).replace(/\|/g, "\\|").slice(0, 80)}\` |`);
    }
  }
  lines.push("");
  lines.push("## 预注册");
  lines.push("");
  lines.push("- v2 只给 TR-01/02 增加中文等价别名；题面、答案、grader、阈值、上下文逐字未改。");
  lines.push("- 判分是冻结夹具的机械判分；本报告不换题、不回调阈值。");
  lines.push("");
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--run")) {
    console.log(JSON.stringify({ status: "NOT_RUN", note: "formal reader requires --run (100 explicit calls)" }, null, 2));
    return 0;
  }
  const fixtures = JSON.parse(nodeFs.readFileSync(FIXTURES, "utf8"));
  const report = await runFormal({ fixtures });
  if (argv.includes("--write")) {
    nodeFs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n", "utf8");
    const md = OUT.replace(/\.json$/i, ".md");
    nodeFs.writeFileSync(md, renderMarkdown(report), "utf8");
    console.log(`wrote ${OUT}`);
    console.log(`wrote ${md}`);
  }
  console.log(JSON.stringify({ qualityGate: report.qualityGate, passed: report.passed, calls: report.calls, callsWithError: report.callsWithError, summary: { full: report.evaluation.Acc_full, compact: report.evaluation.Acc_compact, delta: report.evaluation["Δtask"] }, gates: report.gates }, null, 2));
  return report.passed ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
