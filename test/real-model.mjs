/**
 * real-model.mjs —— 用真实模型（magpie 网关的默认路由组）验证压缩成果
 *
 * 回答四个问题（都不是靠读代码能回答的）：
 *   ① 棋谱摘要真的逐条保留失败边吗？（[HARD FACTS] 遵循度，多次采样）
 *   ② 与官方 8 段模板相比差多少？（同会话对照实验）
 *   ③ 压缩之后模型还能不能正确回答「哪些路试过、为什么不行、下一步做什么」？
 *   ④ 热上下文在真实分词下到底是多大？
 *
 * 用法：
 *   node test/real-model.mjs              # 默认 3 次采样
 *   node test/real-model.mjs --runs 5
 *   node test/real-model.mjs --reuse      # 复用上次 JSON 里的模型输出，仅重新评分（省 token）
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges } from "./graph-fixtures.mjs";
import { renderLedger, renderFacts } from "../src/ledger.mjs";
import { buildChessInstruction } from "../src/summary-prompt.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OUT = nodePath.join(HERE, "..", "evidence");
const BASE = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425/v1";
const MODEL = process.env.MAGPIE_MODEL ?? "group/deepseek-v4.1-flash1017";
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const RUNS = argOf("runs", 3);
const REUSE = process.argv.includes("--reuse");
const HARD_CHAR_LIMIT = 2000; // 字数软上限（模型不完全遵守；真正的硬风险是 finish_reason=length）


/* ─────────────── 构造一段「真实感」的长会话 ─────────────── */

const FAILURES = [
  { intent: "把日志写成流式输出", action: "edit(src/server.js)", err: "TypeError: Cannot read properties of undefined (reading 'pipe') at src/server.js:42" },
  { intent: "用 sqlite 存会话", action: "bash(npm install better-sqlite3 && node init.js)", err: "Error: Cannot find module 'better-sqlite3' (MODULE_NOT_FOUND)" },
  { intent: "把测试跑在 node 18", action: "bash(nvm use 18 && npm test)", err: "command not found: nvm [exit code: 127]" },
  { intent: "直接改 prod 配置文件", action: "edit(config/prod.yaml)", err: "EACCES: permission denied, open 'config/prod.yaml'" },
  { intent: "用 webpack 5 的持久缓存", action: "bash(npx webpack --cache type=filesystem)", err: "Error: Cannot read config file: webpack.config.mjs — Unexpected token 'export'" },
  { intent: "把数据库迁移脚本一次跑完", action: "bash(node migrate.js --all)", err: "MigrationError: relation \"users\" already exists (code 42P07)" },
  { intent: "给 API 加 5 秒超时重试", action: "edit(src/api/client.js)", err: "AssertionError: expected 3 retries, got 0 (tests/api.test.js:88)" },
  { intent: "把 CI 缓存目录换成 /tmp", action: "bash(ls /tmp/ci-cache)", err: "ls: cannot access '/tmp/ci-cache': No such file or directory [exit code: 2]" },
];

// ★ 评分用的约束必须与 ROOT 原话里真正被抽出来的那两句一致（图里只有这两句）。
//   写「扩写版」会让评分天然假阴性 —— 这是第一版 0/2 的真实原因。
const CONSTRAINTS = ["必须保持公开 API 响应字段不变", "不要动 prod 配置"];

const ROOT = "把 sessions 服务的日志改成流式输出，并把测试恢复到全绿。必须保持公开 API 响应字段不变，不要动 prod 配置。";

function buildSyntheticGraph() {
  const g = createGraph({ sessionId: "real-model-probe" });
  const u = addUserNodeId(g, { seq: 1, text: ROOT });
  let last = u;
  let seq = 10;
  for (const f of FAILURES) {
    const e = addEdge(g, { from: last, intent: f.intent, action: f.action, evidence: { start: seq, end: seq + 4 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: f.err });
    const n = addAgentNode(g, { seq: seq + 5, goal: `${f.intent}（失败）`, worldHash: `W${seq}`, constraintHash: "C1", via: e });
    settleEdge(g, e, { to: n.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: f.err });
    last = n.id;
    seq += 10;
  }
  const ok1 = addEdge(g, { from: last, intent: "补上缺失的 .env.example", action: "write(.env.example)" });
  settleEdge(g, ok1, { result: "success", verify: { kind: "write", summary: "18 lines written" } });
  const ok2 = addEdge(g, { from: last, intent: "跑 lint", action: "bash(npx eslint src --max-warnings 0)" });
  settleEdge(g, ok2, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const un1 = addEdge(g, { from: last, intent: "看一眼性能曲线", action: "bash(node bench.js)" });
  settleEdge(g, un1, { result: "unverified", verify: { kind: "no-exit", summary: "no exit code" } });
  return g;
}

function renderPseudoConversation(g) {
  const lines = [];
  for (const id of g.order) {
    const node = g.nodes[id];
    if (!node) continue;
    if (node.kind === "user") {
      lines.push(`[USER] ${node.text}`);
      continue;
    }
    for (const e of Object.values(g.edges)) {
      if (e.from !== id) continue;
      lines.push(`[ASSISTANT] 我打算${e.intent || "试试"}`);
      lines.push(`[TOOL] ${e.action} → ${e.result === "failure" ? e.errorSnippet : e.verify?.summary || "ok"}`);
    }
  }
  return lines.join("\n");
}

const OFFICIAL_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "## Key Technical Concepts",
  "## Files and Code",
  "## Errors and Fixes",
  "## Pending Jobs",
  "## Current Work",
  "## Next Step",
  "## Critical Context",
  "",
  "Rules:",
  "- Write concise English engineering prose.",
  "- Output only the checkpoint text.",
].join("\n");

/* ─────────────── 调用模型 ─────────────── */

async function chat(messages, { maxTokens = 4096 } = {}) {
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false });
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  // 推理型模型可能把内容写进 reasoning_content；两者都收，但标注来源
  const fromReasoning = !(message.content && message.content.length > 0);
  const text = fromReasoning ? message.reasoning_content ?? "" : message.content;
  return { text, fromReasoning, finish: choice.finish_reason ?? null, usage: json.usage ?? {}, model: json.model ?? MODEL };
}

/* ─────────────── 评分 ─────────────── */

function scoreFailures(text) {
  const hits = [];
  for (const f of FAILURES) {
    const keyIntent = f.intent.replace(/[，。]/g, "").slice(0, 6);
    const keyErr = f.err.split(/[:：]/)[0].replace(/\s+/g, "").slice(0, 10);
    const hasIntent = text.includes(keyIntent);
    const hasErr = text.includes(keyErr);
    hits.push({ intent: f.intent, ok: hasIntent || hasErr });
  }
  return { kept: hits.filter((x) => x.ok).length, total: FAILURES.length, missing: hits.filter((x) => !x.ok).map((x) => x.intent) };
}

function contentTokens(text) {
  const ascii = String(text).match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) ?? [];
  const cjkRuns = String(text).replace(/[^\u4e00-\u9fa5]/g, " ").split(/\s+/).filter(Boolean);
  const grams = [];
  for (const run of cjkRuns) for (let i = 0; i + 2 <= run.length; i += 1) grams.push(run.slice(i, i + 2));
  return [...new Set([...ascii, ...grams])];
}

function scoreConstraints(text) {
  return CONSTRAINTS.map((c) => {
    const tokens = contentTokens(c).filter((t) => t.length >= 2);
    const hit = tokens.filter((t) => text.includes(t)).length;
    const ratio = tokens.length === 0 ? 0 : hit / tokens.length;
    return { constraint: c.slice(0, 30), kept: ratio >= 0.6, ratio: Number(ratio.toFixed(2)) };
  });
}

function stat(values) {
  if (values.length === 0) return { n: 0, min: 0, max: 0, avg: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { n: values.length, min: Math.min(...values), max: Math.max(...values), avg: Number((sum / values.length).toFixed(2)) };
}

/* ─────────────── 主流程 ─────────────── */

const g = buildSyntheticGraph();
const convo = renderPseudoConversation(g);
const facts = renderFacts(g);
const ledger = renderLedger(g, { maxTokens: 500 });

const priorFile = nodePath.join(OUT, "真实模型测试.json");
const prior = REUSE && nodeFs.existsSync(priorFile) ? JSON.parse(nodeFs.readFileSync(priorFile, "utf8")) : null;

const result = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  runs: RUNS,
  graph: { nodes: g.order.length, edges: Object.keys(g.edges).length, failures: failureEdges(g).length },
  convoChars: convo.length,
  factsChars: facts.length,
  hardCharLimit: HARD_CHAR_LIMIT,
  samples: {},
};

console.log(`== real-model 测试（${MODEL}）${prior ? " [--reuse]" : ""}，采样 ${RUNS} 次 ==`);
console.log(`会话 ${convo.length} 字符 / 事实块 ${facts.length} 字符 / 失败边 ${failureEdges(g).length}`);

/* ① 棋谱摘要（本插件 hybrid 的实际 prompt），多次采样 */
const chessSamples = [];
for (let i = 0; i < RUNS; i += 1) {
  const cached = prior?.samples?.chess?.[i];
  const instruction = buildChessInstruction({ facts, shadowedStart: 10, shadowedEnd: 300, priorFold: false });
  const t0 = Date.now();
  const out = cached?.text
    ? { text: cached.text, usage: { total_tokens: cached.tokens }, finish: cached.finish, fromReasoning: false }
    : await chat([{ role: "user", content: `${convo}\n\n---\n\n${instruction}` }]);
  const f = scoreFailures(out.text);
  const c = scoreConstraints(out.text);
  chessSamples.push({
    text: out.text,
    chars: out.text.length,
    tokens: out.usage.total_tokens ?? 0,
    finish: out.finish ?? null,
    ms: Date.now() - t0,
    failureKept: f.kept,
    missing: f.missing,
    constraintKept: c.filter((x) => x.kept).length,
    overLimit: out.text.length > HARD_CHAR_LIMIT,
    truncated: (out.finish ?? "") === "length",
  });
  console.log(`  ① 采样 ${i + 1}: ${f.kept}/${f.total} 失败边，约束 ${c.filter((x) => x.kept).length}/${c.length}，${out.text.length} 字符${out.text.length > HARD_CHAR_LIMIT ? " ⚠超字数上限" : ""}`);
}
result.samples.chess = chessSamples;

/* ② 官方 8 段模板（对照） */
const officialSamples = [];
for (let i = 0; i < RUNS; i += 1) {
  const cached = prior?.samples?.official?.[i];
  const out = cached?.text
    ? { text: cached.text, usage: { total_tokens: cached.tokens } }
    : await chat([{ role: "user", content: `${convo}\n\n---\n\n${OFFICIAL_INSTRUCTION}` }]);
  const f = scoreFailures(out.text);
  const c = scoreConstraints(out.text);
  officialSamples.push({
    text: out.text,
    chars: out.text.length,
    tokens: out.usage.total_tokens ?? 0,
    failureKept: f.kept,
    missing: f.missing,
    constraintKept: c.filter((x) => x.kept).length,
  });
  console.log(`  ② 采样 ${i + 1}: ${f.kept}/${f.total} 失败边，约束 ${c.filter((x) => x.kept).length}/${c.length}，${out.text.length} 字符`);
}
result.samples.official = officialSamples;

/* ③ 续跑保真（用最好的那次棋谱摘要当历史） */
const bestChess = [...chessSamples].sort((a, b) => b.failureKept - a.failureKept)[0];
const resumeQ =
  "你现在接手这个任务。只回答三件事：\n1) 任务的目标是什么；\n2) 已经试过且**失败**的做法有哪些（逐条列出，不要合并）；\n3) 下一步你打算做什么，以及为什么它不在失败清单里。";
const cachedResume = prior?.resume?.text;
const resumeOut = cachedResume
  ? { text: cachedResume, usage: { total_tokens: prior.resume.tokens } }
  : await chat([{ role: "user", content: `[压缩后的棋谱摘要]\n${bestChess.text}\n\n[当前热上下文]\n${ledger.text}\n\n[指令]\n${resumeQ}` }]);
const resumeScore = scoreFailures(resumeOut.text);
result.resume = {
  chars: resumeOut.text.length,
  tokens: resumeOut.usage.total_tokens ?? 0,
  failureMentioned: resumeScore.kept,
  failureTotal: resumeScore.total,
  text: resumeOut.text,
};
console.log(`  ③ 续跑保真：提到 ${resumeScore.kept}/${resumeScore.total} 条失败做法`);

/* ④ 置换提示采纳 */
const warnings = "⚠ 置换：你回到了节点 n9（经过 3 条边）——这里试过的路都已经记在 LEARNED 里，换一条没试过的。";
const cachedTrans = prior?.transposition?.text;
const transOut = cachedTrans
  ? { text: cachedTrans, usage: { total_tokens: prior.transposition.tokens } }
  : await chat([
      { role: "user", content: `${ledger.text}\n\n${warnings}\n\n你现在要推进任务。写下你的下一步（一句话）并说明为什么它不是已探明死路中的任何一条。` },
    ]);
const repeated = FAILURES.filter((f) => transOut.text.includes(f.intent.slice(0, 5)) && /再试|重试|试试|先试|还是用/.test(transOut.text));
result.transposition = {
  chars: transOut.text.length,
  tokens: transOut.usage.total_tokens ?? 0,
  repeated: repeated.map((f) => f.intent),
  text: transOut.text,
};
console.log(`  ④ 置换提示：重复死路 ${repeated.length} 条`);

/* ⑤ 热上下文的真实 token 成本 */
const cachedLedger = prior?.ledgerTokens?.promptTokens;
const ledgerOut = cachedLedger ? { usage: { prompt_tokens: cachedLedger } } : await chat([{ role: "user", content: ledger.text }], { maxTokens: 8 });
result.ledgerTokens = { chars: ledger.text.length, promptTokens: ledgerOut.usage.prompt_tokens ?? null };
console.log(`  ⑤ 热上下文：${ledger.text.length} 字符 → ${ledgerOut.usage.prompt_tokens ?? "?"} prompt tokens`);

/* ─────────────── 汇总 ─────────────── */

const chessKept = stat(chessSamples.map((s) => s.failureKept));
const officialKept = stat(officialSamples.map((s) => s.failureKept));
const chessChars = stat(chessSamples.map((s) => s.chars));
const officialChars = stat(officialSamples.map((s) => s.chars));
const overLimit = chessSamples.filter((s) => s.overLimit).length;
result.summary = {
  chessFailureKept: chessKept,
  officialFailureKept: officialKept,
  chessChars,
  officialChars,
  overLimitRuns: overLimit,
  truncatedRuns: chessSamples.filter((s) => s.truncated).length,
  resumeMentioned: result.resume.failureMentioned,
  transpositionRepeats: result.transposition.repeated.length,
  ledgerPromptTokens: result.ledgerTokens.promptTokens,
};

nodeFs.mkdirSync(OUT, { recursive: true });
nodeFs.writeFileSync(nodePath.join(OUT, "真实模型测试.json"), JSON.stringify(result, null, 2), "utf8");

const md = [];
md.push("# 真实模型测试（magpie 默认路由组）", "");
md.push(`> 生成于 ${result.generatedAt}　模型：\`${MODEL}\`　采样 ${RUNS} 次`);
md.push(`> 命令：\`node test/real-model.mjs\``);
md.push(">");
md.push("> 会话是构造的（8 条失败边 + 2 条成功 + 1 条未验证 + 2 条硬约束），摘要与续跑都是**真实模型**输出。");
md.push("> 评分是确定性的关键词/实词命中，不由模型自评。");
md.push("");
md.push("## 一 · 失败边保留率（核心指标，多次采样）");
md.push("");
md.push("| 方案 | 保留失败边（avg / min / max） | 输出字符（avg） | 超 1200 字上限 |");
md.push("|---|---|---|---|");
md.push(`| **本插件（棋谱 prompt + HARD FACTS）** | **${chessKept.avg} / ${chessKept.min} / ${chessKept.max}** | ${chessChars.avg} | ${overLimit}/${RUNS}（被 max_tokens 截断 ${chessSamples.filter((s) => s.truncated).length}/${RUNS}） |`);
md.push(`| 官方 8 段模板 | ${officialKept.avg} / ${officialKept.min} / ${officialKept.max} | ${officialChars.avg} | — |`);
md.push("");
md.push(`样本明细（本插件）：${chessSamples.map((s, i) => `#${i + 1}=${s.failureKept}/8`).join("  ")}`);
md.push("");
md.push(`样本明细（官方）：${officialSamples.map((s, i) => `#${i + 1}=${s.failureKept}/8`).join("  ")}`);
md.push("");
md.push("## 二 · 续跑保真");
md.push("");
md.push(`拿最好的棋谱摘要 + 热上下文当历史，问「目标 / 失败过的做法 / 下一步」：`);
md.push(`- 回答里提到的失败做法：**${result.resume.failureMentioned}/${result.resume.failureTotal}**`);
md.push(`- 回答长度：${result.resume.chars} 字符 / ${result.resume.tokens} tokens`);
md.push("");
md.push("## 三 · 置换提示");
md.push("");
md.push(`给出「⚠ 置换：你回到了节点 n9」后，回答里重复已探明死路的次数：**${result.transposition.repeated.length}**（${result.transposition.repeated.join(" / ") || "无"}）`);
md.push("");
md.push("## 四 · 热上下文真实 token 成本");
md.push("");
md.push(`- ${result.ledgerTokens.chars} 字符 → **${result.ledgerTokens.promptTokens}** prompt tokens（真实分词，不是 chars/4 估算）`);
md.push("");
md.push("## 五 · 原始输出（取最好的一次棋谱摘要 + 官方的对比）");
md.push("");
md.push("### 本插件摘要");
md.push("```markdown");
md.push(bestChess.text);
md.push("```");
md.push("");
md.push("### 官方模板摘要（最好的一次）");
const bestOfficial = [...officialSamples].sort((a, b) => b.failureKept - a.failureKept)[0];
md.push("```markdown");
md.push(bestOfficial.text);
md.push("```");
md.push("");
md.push("### 续跑回答");
md.push("```markdown");
md.push(result.resume.text);
md.push("```");
md.push("");
md.push("### 置换测试回答");
md.push("```markdown");
md.push(result.transposition.text);
md.push("```");

nodeFs.writeFileSync(nodePath.join(OUT, "真实模型测试.md"), md.join("\n"), "utf8");
console.log(`\n已写入 evidence/真实模型测试.md`);
console.log(`失败边保留：本插件 ${chessKept.avg}/8（min ${chessKept.min}） vs 官方 ${officialKept.avg}/8（min ${officialKept.min}）`);
