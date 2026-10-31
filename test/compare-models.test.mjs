/**
 * compare-models.test.mjs —— P2-1 多模型对比脚本（task-197）
 *
 * 纯函数 + 假 fetch；**不碰网络**（唯一的真实调用留在 CLI 的 --dry-run 路径：
 * 它只读 graph、不发请求）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  parseArgs,
  median,
  pickFoldSlice,
  buildComparisonPrompt,
  assessSummary,
  parseChatResponse,
  summarizeOnce,
  aggregateModel,
  buildReport,
  REQUIRED_SECTIONS,
  DEFAULT_MODELS,
} from "../scripts/compare-models.mjs";
import { createGraph, addUserNodeId, addEdge, settleEdge } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 一张带失败边的小图。 */
function graphWithFailures(n = 3) {
  const g = createGraph({ sessionId: "cmp", cwd: "/tmp" });
  const u = addUserNodeId(g, { seq: 1, text: "把 data.jsonl 算出来。不要动 prod 配置。" });
  for (let i = 0; i < n; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次换法`, action: `bash(npm test ${i})`, evidence: { start: 10 + i * 4, end: 13 + i * 4 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `SyntaxError: bad json line ${i}` });
  }
  return g;
}

/** 假 fetch：按脚本给定的状态与体返回；记录收到的请求。 */
function fakeFetch({ status = 200, body = null, throws = null, textOverride = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throws !== null) throw throws;
    return {
      status,
      async text() {
        return textOverride !== null ? textOverride : JSON.stringify(body ?? {});
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const okBody = (text) => ({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } });
const FULL_SUMMARY = ["## 目标", "- 把 data.jsonl 算出来", "## 已探明死路", "- e1 换法 → exit 1", "## 已验证事实", "- 无", "## 原始坐标", "- seq 10-13"].join("\n");

export const tests = {
  "CM-1 parseArgs：默认值 / 逗号模型 / repeat 与 max-tokens 数值化 / 未知开关报错"(t) {
    const d = parseArgs([], {});
    t.eq(d.models, [...DEFAULT_MODELS], "默认两个模型");
    t.eq(d.repeat, 3, "默认 repeat=3");
    t.eq(d.maxTokens, 900, "默认 maxTokens=900");
    t.eq(d.dryRun, false, "默认非 dry-run");

    const p = parseArgs(["--models=a,b", "--repeat=1", "--max-tokens=512", "--session=s1", "--dry-run"], {});
    t.eq(p.models, ["a", "b"], "逗号拆模型");
    t.eq(p.repeat, 1, "repeat=1（降次）");
    t.eq(p.maxTokens, 512, "maxTokens");
    t.eq(p.session, "s1", "session");
    t.eq(p.dryRun, true, "dry-run");

    let threw = false;
    try {
      parseArgs(["--bogus=1"], {});
    } catch (error) {
      threw = /未知开关/.test(String(error.message));
    }
    t.eq(threw, true, "未知开关必须报错（不许静默忽略）");
    t.eq(parseArgs(["--repeat=0"], {}).repeat, 1, "repeat=0 收敛到 1");
  },

  "CM-2 median：奇数取中、偶数取均值、空数组 null、非有限值被过滤"(t) {
    t.eq(median([3, 1, 2]), 2, "奇数");
    t.eq(median([4, 1, 3, 2]), 2.5, "偶数");
    t.eq(median([]), null, "空");
    t.eq(median([1, Number.NaN, 3, Infinity]), 2, "过滤 NaN/Infinity");
    t.eq(median(["5", 1]), 1, "字符串不算数");
  },

  "CM-3 pickFoldSlice：有 foldMark 用最近一段，没有则 null（= 全量）"(t) {
    const g = graphWithFailures(1);
    t.eq(pickFoldSlice(g), null, "没有 foldMark ⇒ null");
    g.foldMarks = [
      { seqStart: 5, seqEnd: 9 },
      { seqStart: 20, seqEnd: 30 },
    ];
    t.eq(pickFoldSlice(g), { start: 20, end: 30 }, "取最后一条");
    g.foldMarks = [{ seqStart: "x", seqEnd: 9 }];
    t.eq(pickFoldSlice(g), null, "非法字段 ⇒ null");
  },

  "CM-4 buildComparisonPrompt：同一 graph ⇒ 逐字节相同的 facts/instruction（模型唯一变量）"(t) {
    const g = graphWithFailures(3);
    const range = { start: 0, end: 99 };
    const a = buildComparisonPrompt(g, { range });
    const b = buildComparisonPrompt(g, { range });
    t.eq(a.facts, b.facts, "两次 facts 必须逐字节相同");
    t.eq(a.instruction, b.instruction, "两次 instruction 必须逐字节相同");
    t.eq(a.messages[0].role, "system", "system 承载 instruction");
    t.eq(a.messages[0].content, a.instruction, "system 内容就是 instruction");
    t.eq(a.messages.length, 2, "两条消息");
    t.eq(a.factsChars, a.facts.length, "factsChars 记账");
    t.includes(a.facts, "不要动 prod 配置", "facts 里必须有约束原话");
    t.includes(a.facts, "SyntaxError: bad json line 0", "facts 里必须有失败原因");
    const noRange = buildComparisonPrompt(g, {});
    t.eq(noRange.range, null, "不传 range ⇒ null");
    t.ok(a.factsTokens > 0, "factsTokens 必须为正");
  },

  "CM-4b range 真的进了 renderFacts：切片外的失败边不许出现在 prompt 里"(t) {
    const g = createGraph({ sessionId: "cmp-range", cwd: "/tmp" });
    const u = addUserNodeId(g, { seq: 1, text: "把 data.jsonl 算出来。" });
    const inside = addEdge(g, { from: u, intent: "切片内的失败", action: "bash(cmd-in)", evidence: { start: 10, end: 13 } });
    settleEdge(g, inside, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "INSIDE_SLICE_ERROR" });
    const outside = addEdge(g, { from: u, intent: "切片外的失败", action: "bash(cmd-out)", evidence: { start: 900, end: 913 } });
    settleEdge(g, outside, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "OUTSIDE_SLICE_ERROR" });
    const sliced = buildComparisonPrompt(g, { range: { start: 0, end: 99 } });
    t.includes(sliced.facts, "INSIDE_SLICE_ERROR", "切片内失败必须在 prompt 里");
    t.eq(sliced.facts.includes("OUTSIDE_SLICE_ERROR"), false, "切片外失败不许进 prompt（否则不同模型比的不是同一切片）");
    const full = buildComparisonPrompt(g, {});
    t.includes(full.facts, "OUTSIDE_SLICE_ERROR", "不传 range 时全量都要有");
  },

  "CM-5 assessSummary：四章节齐全才 complete，缺一节记 3/4"(t) {
    const full = assessSummary(FULL_SUMMARY);
    t.eq(full.complete, true, "四章节齐全");
    t.eq(full.sectionsPresent, 4, "4/4");
    t.eq(full.chars, FULL_SUMMARY.length, "字符数");
    t.ok(full.constraintBullets >= 4, "bullet 计数");
    const partial = assessSummary("## 目标\n- x\n## 已探明死路\n- y\n## 已验证事实\n- z");
    t.eq(partial.sectionsPresent, 3, "缺「原始坐标」⇒ 3/4");
    t.eq(partial.complete, false, "不完整");
    t.eq(partial.sections.coords, false, "coords=false");
    const empty = assessSummary("");
    t.eq(empty.sectionsPresent, 0, "空文本 0/4");
    t.eq(empty.chars, 0, "空字符");
    t.eq(assessSummary(null).sectionsPresent, 0, "null 安全");
    // 四章节清单本身是契约，改了就红
    t.eq(REQUIRED_SECTIONS.map((s) => s.heading), ["## 目标", "## 已探明死路", "## 已验证事实", "## 原始坐标"], "章节口径固定");
  },

  "CM-6 parseChatResponse：字符串 / 数组 content / 无 choices"(t) {
    t.eq(parseChatResponse(okBody("hello")).text, "hello", "字符串 content");
    const arr = parseChatResponse({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] });
    t.eq(arr.text, "ab", "数组 content 拼接");
    const none = parseChatResponse({});
    t.eq(none.text, null, "没有 choices ⇒ null（不许编造）");
    t.eq(parseChatResponse(okBody("x")).usage.total_tokens, 1200, "usage 透传");
  },

  "CM-7 summarizeOnce（假 fetch）：成功样本带延迟与 usage；HTTP 500 与网络异常都记失败"(t) {
    const fake = fakeFetch({ body: okBody(FULL_SUMMARY) });
    return (async () => {
      const r = await summarizeOnce({ fetchImpl: fake, baseUrl: "http://x/v1", apiKey: "", model: "m1", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
      t.eq(r.ok, true, "成功");
      t.eq(r.text, FULL_SUMMARY, "文本");
      t.eq(r.usage.total_tokens, 1200, "usage");
      t.eq(typeof r.latencyMs, "number", "延迟是数字");
      t.ok(r.latencyMs >= 0, "延迟非负");
      t.eq(fake.calls[0].url, "http://x/v1/chat/completions", "URL 拼接（去掉尾斜杠）");
      const body = JSON.parse(fake.calls[0].init.body);
      t.eq(body.model, "m1", "model 透传");
      t.eq(body.max_tokens, 10, "max_tokens 透传（同一上限）");
      t.eq(body.temperature, 0, "temperature=0（可复现）");

      const bad = await summarizeOnce({ fetchImpl: fakeFetch({ status: 500, textOverride: "boom" }), baseUrl: "http://x/v1", model: "m1", messages: [], maxTokens: 10 });
      t.eq(bad.ok, false, "HTTP 500 必须算失败");
      t.includes(bad.error, "HTTP 500", "错误里带状态码");
      t.includes(bad.error, "boom", "错误里带响应体");

      const thrown = await summarizeOnce({ fetchImpl: fakeFetch({ throws: new Error("ECONNREFUSED") }), baseUrl: "http://x/v1", model: "m1", messages: [], maxTokens: 10 });
      t.eq(thrown.ok, false, "网络异常必须算失败");
      t.includes(thrown.error, "ECONNREFUSED", "错误里带原因");

      const empty = await summarizeOnce({ fetchImpl: fakeFetch({ body: { choices: [{ message: { content: "   " } }] } }), baseUrl: "http://x/v1", model: "m1", messages: [], maxTokens: 10 });
      t.eq(empty.ok, false, "空摘要必须算失败（不许当成功样本）");
    })();
  },

  "CM-8 aggregateModel：失败不拉低中位，错误去重，成功数分开记"(t) {
    const runs = [
      { ok: true, latencyMs: 100, usage: { total_tokens: 1 }, assessment: { chars: 10, tokens: 5, sectionsPresent: 4, complete: true } },
      { ok: false, latencyMs: 900, usage: null, assessment: null, error: "HTTP 500: x" },
      { ok: true, latencyMs: 300, usage: { total_tokens: 2 }, assessment: { chars: 20, tokens: 9, sectionsPresent: 3, complete: false } },
      { ok: false, latencyMs: 900, usage: null, assessment: null, error: "HTTP 500: x" },
    ];
    const a = aggregateModel("m1", runs);
    t.eq(a.runs, 4, "总样本");
    t.eq(a.ok, 2, "成功样本");
    t.eq(a.failed, 2, "失败样本");
    t.eq(a.medianLatencyMs, 200, "中位只用成功样本（100/300 → 200，不被 900 拉高）");
    t.eq(a.medianChars, 15, "字符中位");
    t.eq(a.sectionsMedian, 3.5, "章节中位");
    t.eq(a.completeRuns, 1, "完整次数");
    t.eq(a.errors, ["HTTP 500: x"], "错误去重");
    t.eq(aggregateModel("m2", []), { model: "m2", runs: 0, ok: 0, failed: 0, errors: [], medianLatencyMs: null, medianChars: null, medianTokens: null, sectionsMedian: null, completeRuns: 0, usageSamples: [] }, "空样本全 null，不冒充 0");
  },

  "CM-9 buildReport：可直接落盘的形状（session/range/prompt/models/samples 齐全）"(t) {
    const g = graphWithFailures(2);
    const prompt = buildComparisonPrompt(g, {});
    const samples = {
      m1: [{ ok: true, latencyMs: 10, text: FULL_SUMMARY, assessment: assessSummary(FULL_SUMMARY), usage: { total_tokens: 3 } }],
      m2: [{ ok: false, latencyMs: 20, text: null, assessment: null, usage: null, error: "HTTP 502" }],
    };
    const report = buildReport({ session: "s1", range: null, prompt, models: ["m1", "m2"], repeat: 1, maxTokens: 900, baseUrl: "http://x/v1", samples });
    t.eq(report.session, "s1", "session");
    t.eq(report.repeat, 1, "repeat");
    t.eq(report.maxTokens, 900, "maxTokens");
    t.eq(report.prompt.factsChars, prompt.factsChars, "prompt 记账");
    t.eq(report.models.length, 2, "两个模型汇总");
    t.eq(report.models[0].ok, 1, "m1 成功 1");
    t.eq(report.models[1].failed, 1, "m2 失败 1");
    t.eq(typeof report.generatedAt, "string", "时间戳");
    // 可序列化（写证据文件的前提）
    t.ok(JSON.stringify(report).length > 100, "可 JSON 序列化");
  },

  "CM-10 CLI --dry-run：只读 graph、不发请求、退出码 0（含 --session 与自动选样本）"(t) {
    const home = nodePath.join(HERE, ".harness", "cmp-home");
    nodeFs.rmSync(home, { recursive: true, force: true });
    const sessDir = nodePath.join(home, "chess-context", "sessions", "sess-cmp");
    nodeFs.mkdirSync(sessDir, { recursive: true });
    const g = graphWithFailures(2);
    nodeFs.writeFileSync(nodePath.join(sessDir, "graph.json"), JSON.stringify(g, null, 1), "utf8");
    const script = nodePath.join(ROOT, "scripts", "compare-models.mjs");
    const run = (args) => {
      const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, DSH_HOME: home }, timeout: 60000 });
      return JSON.parse(out);
    };
    const auto = run(["--dry-run"]);
    t.eq(auto.dryRun, true, "dry-run");
    t.eq(auto.session, "sess-cmp", "自动挑到唯一会话");
    t.eq(auto.repeat, 3, "默认 repeat");
    t.eq(auto.models, [...DEFAULT_MODELS], "默认模型清单");
    t.ok(auto.factsChars > 0, "facts 非空");
    t.eq(auto.range, null, "没有 foldMark ⇒ 全量（range=null）");
    const explicit = run(["--dry-run", "--session=sess-cmp", "--repeat=1", "--models=a,b"]);
    t.eq(explicit.repeat, 1, "repeat 覆盖");
    t.eq(explicit.models, ["a", "b"], "models 覆盖");
  },
};
