/**
 * real-e2e.mjs —— 端到端：真实 bash 产生的失败 → 真实事务压缩 → 真实模型续跑
 *
 * 与 real-fold.mjs 的分工：
 *   · real-fold 用桩 llm，验证「事务链」；
 *   · 本文件用**真实模型**（magpie 默认路由组），验证「压缩之后 agent 还能不能接着干」。
 *
 * 用法：node test/real-e2e.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { createGraph, failureEdges } from "../src/rooms/kifu-model.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";
import { renderLedger, renderFacts } from "../src/rooms/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const WORK = nodePath.join(ROOT, "..", "..", "tmp", "dsh-gokifu-compact", "e2e");
const OUT = nodePath.join(ROOT, "evidence");
const BASE = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425/v1";
const MODEL = process.env.MAGPIE_MODEL ?? "group/deepseek-v4.1-flash1017";

const SCRIPTS = [
  [
    'import fs from "node:fs";',
    'const t = fs.readFileSync("data.jsonl", "utf8");',
    "console.log(JSON.parse(t).length);",
    "",
  ].join("\n"),
  [
    'import fs from "node:fs";',
    'const t = fs.readFileSync("data.jsonl", "utf8");',
    'const a = t.split(String.fromCharCode(10)).map((l) => JSON.parse(l));',
    "console.log(a.length);",
    "",
  ].join("\n"),
  [
    'import fs from "node:fs";',
    'const t = fs.readFileSync("data.jsonl", "utf8");',
    'const a = t.split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));',
    "console.log(a.length);",
    "",
  ].join("\n"),
  [
    'import fs from "node:fs";',
    'const t = fs.readFileSync("data.jsonl", "utf8");',
    "let n = 0;",
    "for (const l of t.split(String.fromCharCode(10))) {",
    "  if (!l.trim()) continue;",
    "  try { JSON.parse(l); n += 1; } catch {}",
    "}",
    "console.log(n);",
    "",
  ].join("\n"),
];

const INTENTS = ["整体解析 JSONL 文件", "按换行切分后逐行解析（不跳空行）", "跳过空行再逐行解析", "用 try/catch 跳过坏行"];

function prepareWorkspace() {
  nodeFs.rmSync(WORK, { recursive: true, force: true });
  nodeFs.mkdirSync(WORK, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(WORK, "data.jsonl"), '{"id":1}\n\n{"id":2}\n{bad json\n{"id":3}\n', "utf8");
  SCRIPTS.forEach((body, i) => nodeFs.writeFileSync(nodePath.join(WORK, `step${i + 1}.mjs`), body, "utf8"));
}

function runShell(cmd) {
  try {
    const out = execSync(cmd, { cwd: WORK, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    return { text: out, exit: 0 };
  } catch (error) {
    return { text: `${error.stdout ?? ""}${error.stderr ?? ""}[exit code: ${error.status ?? 1}]`, exit: error.status ?? 1 };
  }
}

function buildRealGraph() {
  const g = createGraph({ sessionId: "e2e", cwd: WORK });
  const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [] };
  let seq = 1;
  const push = (event) => observeEvent(g, event, st);

  push({
    type: "user/message",
    seq: seq++,
    data: {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "把 data.jsonl 里的有效记录数算出来。必须处理空行与坏行，不许改数据文件。" }],
      source: { kind: "user" },
    },
  });

  INTENTS.forEach((intent, i) => {
    const callId = `c${seq}`;
    push({
      type: "assistant/message",
      seq: seq++,
      data: {
        message: {
          id: `a${seq}`,
          role: "assistant",
          content: [
            { type: "text", text: `计划：${intent}。` },
            { type: "tool-call", id: callId, name: "bash", arguments: JSON.stringify({ command: `node step${i + 1}.mjs` }) },
          ],
          source: { kind: "model", provider: "p", model: "m" },
        },
      },
    });
    const r = runShell(`node step${i + 1}.mjs`);
    push({
      type: "tool/result",
      seq: seq++,
      data: {
        message: {
          id: `r${seq}`,
          role: "tool",
          toolCallId: callId,
          source: { kind: "tool", callId },
          content: [{ type: "text", text: r.text }],
          isError: false,
        },
      },
    });
    push({ type: "step/end", seq: seq++, data: { turn: 1, step: i + 1 } });
  });
  return g;
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
  const text = m.content && m.content.length > 0 ? m.content : m.reasoning_content ?? "";
  return { text, usage: json.usage ?? {}, finish: json.choices?.[0]?.finish_reason ?? null };
}

console.log(`== real-e2e（${MODEL}）==`);
prepareWorkspace();
const g = buildRealGraph();
const failures = failureEdges(g);
console.log(`真实调试历史：${g.order.length} 节点 / ${Object.keys(g.edges).length} 边 / ${failures.length} 失败`);
for (const e of failures) console.log(`  ${e.id} "${e.intent}" → ${(e.errorSnippet || "").split("\n")[0].slice(0, 70)}`);

const facts = renderFacts(g);
const ledger = renderLedger(g, { maxTokens: 500 });
console.log(`\n事实块 ${facts.length} 字符 / 热上下文 ${ledger.tokens} tokens（L${ledger.level}）`);

const transcript = g.order
  .map((id) => {
    const n = g.nodes[id];
    if (n.kind === "user") return `[USER] ${n.text}`;
    return Object.values(g.edges)
      .filter((e) => e.from === id)
      .map((e) => `[ASSISTANT] ${e.intent}\n[TOOL] ${e.action} → ${e.result === "failure" ? e.errorSnippet : e.verify?.summary}`)
      .join("\n");
  })
  .join("\n");

const instruction = [
  "你在压缩一段 AI 编程助手的历史。下面是【硬事实】与【原始对话】，请按指定结构输出一份棋谱摘要。",
  "",
  "[硬事实]",
  facts,
  "",
  "[原始对话]",
  transcript,
  "",
  "输出结构（严格遵守）：",
  "## 目标",
  "## 已探明死路（逐条保留，一条不许少）",
  "## 已验证事实",
  "## 未验证",
  "## 当前节点与下一步",
  "",
  "要求：整份不超过 1200 字；每条死路一行，带原因原文；不许合并死路。",
].join("\n");

const summaryOut = await callModel([{ role: "user", content: instruction }]);
const summary = summaryOut.text;
console.log(`\n棋谱摘要：${summary.length} 字符 / ${summaryOut.usage.total_tokens ?? "?"} tokens`);

const kept = failures.filter((e) => summary.includes((e.intent || "").slice(0, 6)) || summary.includes((e.errorSnippet || "").slice(0, 10)));
console.log(`失败边保留：${kept.length}/${failures.length}`);

const resumeQ = "你现在接手这个任务。只回答：1) 目标是什么；2) 哪些做法试过且失败（逐条）；3) 下一步做什么（一条命令）。";
const resumeOut = await callModel(
  [{ role: "user", content: `[压缩后的棋谱摘要]\n${summary}\n\n[当前热上下文]\n${ledger.text}\n\n[指令]\n${resumeQ}` }],
  2048,
);
const resumeText = resumeOut.text;
const resumeKept = failures.filter((e) => resumeText.includes((e.intent || "").slice(0, 6)));
console.log(`续跑回答：${resumeText.length} 字符，提到失败做法 ${resumeKept.length}/${failures.length}`);

const convoChars = transcript.length;
const ratio = convoChars / Math.max(1, summary.length);
console.log(`长度比（产物/原文）：${convoChars} 字符 → ${summary.length} 字符（${(summary.length / Math.max(1, convoChars)).toFixed(1)}×，小样本必然变长）`);

nodeFs.mkdirSync(OUT, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  graph: { nodes: g.order.length, edges: Object.keys(g.edges).length, failures: failures.length },
  factsChars: facts.length,
  ledgerTokens: ledger.tokens,
  ledgerLevel: ledger.level,
  summary: { chars: summary.length, tokens: summaryOut.usage.total_tokens ?? null, failureKept: kept.length, failureTotal: failures.length },
  resume: { chars: resumeText.length, failureMentioned: resumeKept.length, text: resumeText },
  lengthRatio: Number((summary.length / Math.max(1, convoChars)).toFixed(2)),
  convoChars,
};
nodeFs.writeFileSync(nodePath.join(OUT, "真实端到端测试.json"), JSON.stringify(report, null, 2), "utf8");

const md = [];
md.push("# 真实端到端测试：真实失败 → 真实压缩 → 真实续跑", "");
md.push(`> ${report.generatedAt}　模型：\`${MODEL}\``);
md.push(">");
md.push("> 调试历史由**真实 bash 执行**产生（真实 `node` 命令、真实报错），压缩后的摘要与续跑由**真实模型**完成。");
md.push("");
md.push("## 一 · 真实失败边");
md.push("");
md.push("| # | 意图 | 真实报错（首行） |");
md.push("|---|---|---|");
for (const e of failures) md.push(`| ${e.id} | ${e.intent} | ${(e.errorSnippet || "").split("\n")[0].slice(0, 100)} |`);
md.push("");
md.push("## 二 · 压缩结果");
md.push("");
md.push("| 指标 | 值 |");
md.push("|---|---|");
md.push(`| 原始对话 | ${convoChars} 字符 |`);
md.push(`| 棋谱摘要 | ${summary.length} 字符（${summaryOut.usage.total_tokens ?? "?"} tokens）|`);
md.push(`| 长度比（产物/原文） | **${(summary.length / Math.max(1, convoChars)).toFixed(1)}×（变长）** |`);
md.push(`| 失败边保留 | **${kept.length}/${failures.length}** |`);
md.push(`| 热上下文 | ${ledger.tokens} tokens（L${ledger.level}）|`);
md.push("");
md.push("## 三 · 压缩后能不能接着干");
md.push("");
md.push(`续跑回答提到 **${resumeKept.length}/${failures.length}** 条失败做法。`);
md.push("");
md.push("## 四 · 原始输出");
md.push("");
md.push("### 棋谱摘要");
md.push("```markdown");
md.push(summary);
md.push("```");
md.push("");
md.push("### 续跑回答");
md.push("```markdown");
md.push(resumeText);
md.push("```");
nodeFs.writeFileSync(nodePath.join(OUT, "真实端到端测试.md"), md.join("\n"), "utf8");
console.log(`\n已写入 evidence/真实端到端测试.md`);
