/**
 * overbudget-report.test.mjs —— 热清单超预算**离线归因**的回归（2026-11-02，C57）
 *
 * 背景：`ledger-budget.json` 只给聚合计数，聚合比例会被「一个长失败原因会话反复渲染」放大。
 * 这个脚本用当前 live 图在指定预算下逐会话重渲染，并把超限归成三类：
 *   · floor        —— 约束+根目标下限即超（不可裁）；
 *   · irreducible  —— 失败边已全部列出仍超（再省只能丢失败记忆）；
 *   · reducible?   —— 还有更省形态没被选中（**只有这一类**可能是渲染 bug）。
 *
 * 三类必须能被稳定区分，否则报告又会变成"数字很大但说明不了什么"。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { createGraph, addUserNodeId, addEdge, settleEdge, toJSON } from "./graph-fixtures.mjs";
import { classifyBudget, scanOverBudget, trendOverBudget } from "../scripts/overbudget-report.mjs";

export const tests = {};

const long = (n, tag) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);

/** 造一个假 home：slim（装得下）+ fat（失败边很多且原因很长）+ floor（约束巨大）。 */
function makeHome() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-overbudget-"));
  const sessionsRoot = nodePath.join(root, "chess-context", "sessions");
  const write = (name, graph) => {
    const dir = nodePath.join(sessionsRoot, name);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(graph), "utf8");
  };
  nodeFs.mkdirSync(sessionsRoot, { recursive: true });

  // slim：一条失败边、短原因 ⇒ 任何预算都装得下
  const slim = createGraph({ sessionId: "slim" });
  const su = addUserNodeId(slim, { seq: 1, text: "把测试跑绿" });
  const se = addEdge(slim, { from: su, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  settleEdge(slim, se, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: 1 !== 2" });
  write("session-slim", slim);

  // fat：8 条失败边、原因很长（≤10 ⇒ L5 会全列 ⇒ irreducible）
  const fat = createGraph({ sessionId: "fat" });
  const fu = addUserNodeId(fat, { seq: 1, text: "把构建跑通" });
  for (let i = 0; i < 8; i += 1) {
    const e = addEdge(fat, { from: fu, intent: `第 ${i} 次：${long(40, "换个写法")}`, action: `bash(attempt-${i})`, evidence: { start: 10 + i * 2, end: 11 + i * 2 } });
    settleEdge(fat, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `Error: ${long(140, "permission denied")}` });
  }
  write("session-fat", fat);

  // floor：6 条长约束（约束本身超 200 预算）
  const floor = createGraph({ sessionId: "floor" });
  addUserNodeId(floor, {
    seq: 1,
    text: "按约束改配置",
    constraints: Array.from({ length: 6 }, (_, i) => `约束 ${i}：${long(200, "不要动 prod 配置")}`),
  });
  write("session-floor", floor);

  return root;
}

tests["C57-1 classifyBudget 三态：within / irreducible / floor 必须能分开"] = (t) => {
  const base = {
    tokens: 600,
    level: 5,
    unyieldingTokens: 100,
    shownFailures: 8,
    failureCount: 8,
    fallback: "over-budget",
    attemptTokens: [{ level: 5, tokens: 600 }, { level: 4, tokens: 720 }],
  };
  t.eq(classifyBudget({ ...base, fallback: "none", tokens: 400 }, 500).reason, "within", "预算内");
  t.eq(classifyBudget(base, 500).reason, "irreducible", "所选已是最省尝试，仍超 ⇒ 只能删内容");
  t.eq(classifyBudget({ ...base, unyieldingTokens: 520 }, 500).reason, "floor", "约束+根目标下限即超");
  // ★ C63：只有「所选 tokens > 最省尝试 tokens」才是裁决 bug —— 不能再用 shown<count 猜
  t.eq(
    classifyBudget({ ...base, attemptTokens: [{ level: 5, tokens: 480 }, { level: 4, tokens: 600 }] }, 500).reason,
    "bug",
    "选了 600 而最省是 480 ⇒ 兜底裁决 bug",
  );
  t.eq(
    classifyBudget({ ...base, shownFailures: 5, failureCount: 20 }, 500).reason,
    "irreducible",
    "shown<count 但所选就是最省 ⇒ 不是 bug（旧判据在这里误报过）",
  );
  t.eq(classifyBudget(null, 500), null, "非对象 ⇒ null");
};

tests["C57-2 scanOverBudget：逐会话重渲染并归因，order 按超出量降序"] = (t) => {
  const home = makeHome();
  try {
    const report = scanOverBudget(home, { budget: 300 });
    t.eq(report.sessions, 3, "3 个会话图");
    t.eq(report.counts.within, 1, "slim 在预算内");
    t.eq(report.counts.irreducible >= 1, true, `fat 应至少归为 irreducible：${JSON.stringify(report.counts)}`);
    t.eq(report.counts.floor >= 1, true, `floor 应被认出：${JSON.stringify(report.counts)}`);
    t.eq(report.over.length, 2, `应有两个超预算会话：${report.over.map((r) => r.session)}`);
    t.eq(report.over.every((r) => r.over > 0), true, "清单里每条都必须真的超");
    t.eq(report.over[0].over >= report.over[1].over, true, "按超出量降序");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C57-3 空 home 不许抛：0 会话、0 超预算"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-overbudget-empty-"));
  try {
    const report = scanOverBudget(root, { budget: 500 });
    t.eq(report.sessions, 0, "0 会话");
    t.eq(report.over, [], "没有超预算条目");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C58 trendOverBudget：构成增删如实报告；头号来源变化要标出；无旧快照返回 null"] = (t) => {
  t.eq(trendOverBudget(null, { counts: {} }), null, "无旧快照 ⇒ null");
  const prev = { generatedAt: "2026-11-02T00:00:00Z", counts: { within: 22, irreducible: 1 }, over: [{ session: "a" }] };
  const now = { counts: { within: 20, irreducible: 3 }, over: [{ session: "b" }, { session: "c" }] };
  const trend = trendOverBudget(prev, now);
  t.eq(trend.countsDelta.within, -2, "within 减少 2");
  t.eq(trend.countsDelta.irreducible, 2, "irreducible 增加 2");
  t.eq(trend.topSessionChanged, true, "头号来源变了");
  t.eq(trend.topSession, "b", "报出新的头号来源");
  const same = trendOverBudget(prev, { counts: { within: 22, irreducible: 1 }, over: [{ session: "a" }] });
  t.eq(Object.keys(same.countsDelta).length, 0, "构成没变 ⇒ 无 delta");
  t.eq(same.topSessionChanged, false, "头号来源没变");
};
