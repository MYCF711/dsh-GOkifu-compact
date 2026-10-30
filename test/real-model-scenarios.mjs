/**
 * real-model-scenarios.mjs —— 不同规模下的摘要保真（真实模型）
 *
 * 之前的 real-model.mjs 只测了 8 条失败边。实际会话里失败边从几条到上百条都有，
 * 摘要模型在不同规模下是否还能逐条保留？这个文件测 3 个场景：
 *   A 小：5 条失败边 + 2 条约束
 *   B 中：15 条失败边 + 3 条约束
 *   C 大：30 条失败边 + 3 条约束
 *
 * 评分是确定性的关键词匹配（不靠人眼）：
 *   · 每条失败边的「意图关键词」是否出现在摘要里
 *   · 每条约束是否逐字出现
 *   · 是否出现「合并」迹象（两条失败被写成一句）
 *
 * 用法：node test/real-model-scenarios.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addEdge, settleEdge } from "./graph-fixtures.mjs";
import { renderFacts, renderLedger } from "../src/rooms/ledger.mjs";
import { extractConstraintsBlock } from "../src/rooms/facts-prompt.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OUT = nodePath.join(HERE, "..", "evidence");
const BASE = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425/v1";
const MODEL = process.env.MAGPIE_MODEL ?? "group/deepseek-v4.1-flash1017";

const FAIL_KINDS = [
  ["整体解析 JSONL 文件", "SyntaxError: Unexpected non-whitespace character after JSON"],
  ["按换行切分但不跳空行", "SyntaxError: Unexpected end of JSON input"],
  ["跳过空行但不处理坏行", "SyntaxError: Expected property name"],
  ["用 md5 做缓存键", "TypeError: crypto.createHash is not a function"],
  ["直接改 prod 配置", "EACCES: permission denied, open '/etc/app/config.yml'"],
  ["用 sqlite 存会话", "Error: Cannot find module 'better-sqlite3'"],
  ["把测试跑在 node 18", "command not found: nvm"],
  ["用 fetch 拉本地文件", "TypeError: Failed to parse URL from ./data.json"],
  ["用 window 判断环境", "ReferenceError: window is not defined"],
  ["递归扫描 node_modules", "RangeError: Maximum call stack size exceeded"],
  ["用 execSync 跑交互式命令", "Error: spawn vim ENOENT"],
  ["把 token 写进日志", "SECURITY: token leaked in logs"],
  ["用 Date.now() 当唯一 ID", "AssertionError: duplicate id at millisecond boundary"],
  ["假设 readdir 返回有序", "AssertionError: expected ['b','a'] to equal ['a','b']"],
  ["用 try/catch 吞掉所有错误", "AssertionError: expected 3 records, got 0"],
  ["在 forEach 里 await", "AssertionError: expected 3 results, got 0"],
  ["用 JSON.stringify 比较对象", "AssertionError: key order differs"],
  ["把 Buffer 当字符串", "TypeError: buf.split is not a function"],
  ["用 process.exit 代替 return", "process exited before flush"],
  ["假设 cwd 是项目根", "ENOENT: no such file or directory, open 'package.json'"],
  ["用 setTimeout 等待网络", "AssertionError: response not ready after 100ms"],
  ["把 ESM 当 CJS 引入", "ReferenceError: require is not defined in ES module scope"],
  ["用 == 比较 NaN", "AssertionError: NaN !== NaN"],
  ["假设 Object.keys 顺序稳定", "AssertionError: key order changed between runs"],
  ["把 Promise 当同步值", "TypeError: result.then is not a function"],
  ["用 decodeURI 处理完整 URL", "URIError: URI malformed"],
  ["把数字当字符串拼接", "AssertionError: expected '12' to equal 3"],
  ["用全局变量存请求上下文", "AssertionError: context leaked between requests"],
  ["假设 crypto.randomUUID 一定存在", "TypeError: crypto.randomUUID is not a function"],
  ["用 JSON.parse 解析 YAML", "SyntaxError: Unexpected token 'a'"],
];

const CONSTRAINT_POOL = [
  "必须保持公开 API 响应字段不变，不许改接口契约。",
  "不许动 prod 配置文件，任何改动只能走测试环境。",
  "所有新增依赖必须走内部镜像，不许直连 npm。",
];

const SCENARIOS = [
  { id: "A-小", failures: 5, constraints: 2, note: "5 条失败边" },
  { id: "B-中", failures: 15, constraints: 3, note: "15 条失败边" },
  { id: "C-大", failures: 30, constraints: 3, note: "30 条失败边" },
];

function buildGraph(scenario) {
  const g = createGraph({ sessionId: scenario.id });
  const cons = CONSTRAINT_POOL.slice(0, scenario.constraints).join(" ");
  const u = addUserNodeId(g, { seq: 1, text: `把 data.jsonl 里的有效记录数算出来，并修好解析器。${cons}` });
  let last = u;
  for (let i = 0; i < scenario.failures; i += 1) {
    const [intent, err] = FAIL_KINDS[i % FAIL_KINDS.length];
    const e = addEdge(g, {
      from: last,
      intent: `第 ${i + 1} 次尝试：${intent}`,
      action: `bash(npm test -- case${i + 1})`,
      evidence: { start: 10 + i * 4, end: 13 + i * 4 },
    });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: err });
    last = u;
  }
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
  return { text: m.content && m.content.length > 0 ? m.content : m.reasoning_content ?? "", usage: json.usage ?? {} };
}

/** 确定性评分：失败边的「意图关键词」与约束是否出现；是否出现合并。 */
function score(summary, g) {
  const failures = Object.values(g.edges).filter((e) => e.result === "failure");
  const norms = summary.replace(/\s+/g, " ");
  const kept = failures.filter((e) => {
    const m = /第 \d+ 次尝试：(.+)$/.exec(e.intent);
    const key = m ? m[1] : e.intent;
    return norms.includes(key.slice(0, 8)) || norms.includes(key.slice(0, 6));
  });
  const cons = (g.nodes[g.rootUserNodeIds[0]]?.constraints ?? []);
  const consKept = cons.filter((c) => norms.includes(c.slice(0, 10))).length;
  // 合并迹象：出现「等 N 条」「其余失败」「类似问题」这类词
  const merged = /(等\s*\d+\s*(条|种)|其余失败|类似问题|等等)/.test(summary);
  return { failureTotal: failures.length, failureKept: kept.length, constraintTotal: cons.length, constraintKept: consKept, merged };
}

console.log(`== real-model-scenarios（${MODEL}）==`);
const report = [];
for (const scenario of SCENARIOS) {
  const g = buildGraph(scenario);
  const facts = renderFacts(g);
  const ledger = renderLedger(g, { maxTokens: 500 });
  const transcript = g.order
    .map((id) => {
      const n = g.nodes[id];
      if (n.kind === "user") return `[USER] ${n.text}`;
      return Object.values(g.edges)
        .filter((e) => e.from === id)
        .map((e) => `[ASSISTANT] ${e.intent}\n[TOOL] ${e.action} → ${e.errorSnippet}`)
        .join("\n");
    })
    .join("\n");

  const instruction = [
    "你在压缩一段 AI 编程助手的历史。下面是【硬事实】与【原始对话】，请按指定结构输出棋谱摘要。",
    "",
    "[硬事实]",
    facts,
    "",
    "[原始对话]",
    transcript,
    "",
    "输出结构：## 目标 / ## 已探明死路（逐条保留，一条不许少）/ ## 已验证事实 / ## 未验证 / ## 当前节点与下一步",
    "要求：每条死路一行，带原因原文；不许合并；不许用「等 N 条」省略。",
  ].join("\n");

  const t0 = Date.now();
  const out = await callModel([{ role: "user", content: instruction }]);
  const ms = Date.now() - t0;
  // 模拟 engine.summarize 的机械追加：约束不经过模型，由规则拼回产物。
  // 不这么做的话，这里评的是「模型是否听话」，而真实产物是「模型输出 + 机械段」。
  let finalSummary = out.text;
  const constraintsBlock = extractConstraintsBlock(facts);
  if (constraintsBlock) {
    finalSummary += "## 约束（机械保留，逐字；不由模型改写）" + String.fromCharCode(10) + constraintsBlock.split(String.fromCharCode(10)).map((l) => "- " + l).join(String.fromCharCode(10));
  }
  const sc = score(finalSummary, g);
  const tokens = out.usage.total_tokens ?? null;

  report.push({
    scenario: scenario.id,
    note: scenario.note,
    factsChars: facts.length,
    ledgerTokens: ledger.tokens,
    summaryChars: finalSummary.length,
    tokens,
    ms,
    ...sc,
  });

  console.log(
    `${scenario.id}（${scenario.note}）：失败边 ${sc.failureKept}/${sc.failureTotal}，约束 ${sc.constraintKept}/${sc.constraintTotal}` +
      `${sc.merged ? "，⚠ 有合并迹象" : ""}，摘要 ${finalSummary.length} 字符 / ${tokens ?? "?"} tokens / ${ms}ms`,
  );
}

nodeFs.mkdirSync(OUT, { recursive: true });
nodeFs.writeFileSync(nodePath.join(OUT, "真实模型多规模测试.json"), JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, report }, null, 2), "utf8");

const md = [];
md.push("# 真实模型多规模测试：5 / 15 / 30 条失败边", "");
md.push(`> ${new Date().toISOString()}　模型：\`${MODEL}\``);
md.push(">");
md.push("> 评分是确定性的关键词匹配：每条失败边的「意图关键词」是否出现、每条约束是否逐字出现、是否出现合并省略。");
md.push("");
md.push("| 场景 | 失败边保留 | 约束 | 摘要字符 | tokens | 耗时 | 合并迹象 |");
md.push("|---|---|---|---|---|---|---|");
for (const r of report) {
  md.push(`| ${r.scenario}（${r.note}） | **${r.failureKept}/${r.failureTotal}** | ${r.constraintKept}/${r.constraintTotal} | ${r.summaryChars} | ${r.tokens ?? "?"} | ${r.ms}ms | ${r.merged ? "⚠ 有" : "无"} |`);
}
md.push("");
md.push("## 结论");
md.push("");
const allFull = report.every((r) => r.failureKept === r.failureTotal);
const consFull = report.every((r) => r.constraintKept === r.constraintTotal);
md.push(`- 失败边全保留：**${allFull ? "是" : "否"}**（三个规模都是 ${report.map((r) => `${r.failureKept}/${r.failureTotal}`).join("、")}）`);
md.push(`- 约束全保留：**${consFull ? "是" : "否"}**`);
md.push(`- 合并省略：${report.some((r) => r.merged) ? "出现过" : "**一次都没有**"}`);
nodeFs.writeFileSync(nodePath.join(OUT, "真实模型多规模测试.md"), md.join("\n"), "utf8");
console.log(`\n已写入 evidence/真实模型多规模测试.md`);
