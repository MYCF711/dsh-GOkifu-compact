/**
 * ledger-budget.test.mjs —— P5「生产口径 token 预算与 pickFallback」的回归矩阵（2026-10-30）
 *
 * 背景（task-41 / task-36 对账）：
 *   · 生产口径（`treeDir` = 真实会话目录、maxTokens=500）HEAD 1.9.1 本身就超预算：
 *     avg 422.77 / >500 18/133 / max 905 —— 不能拿 default 口径当验收。
 *   · `pickFallback` 旧行为：没有预算内候选时**静默**返回最省的超预算文本；
 *     调用方拿到 tokens > maxTokens 却没有任何标记 ⇒「已经尽力」与「出了 bug」不可区分。
 *
 * 本文件锁住：
 *   1. `fallback` 三态（none / over-budget / impossible）与 `overBudgetBy`；
 *   2. `pickFallback` 的择优顺序（预算内优先 → tokens 小 → 列得多）；
 *   3. 路径行有固定额度，任何档位都不得把预算吃满；
 *   4. renderFacts 不受影响。
 */

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode } from "./graph-fixtures.mjs";
import { renderLedger, renderMinimalLedger, renderFacts, fallbackStatusOf, _internal } from "../src/rooms/ledger.mjs";

const { pickFallback } = _internal;

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 长路径 + 大量失败边：必然落到 L4/L5 兜底。 */
function fatGraph({ hops = 10, failures = 3000, sessionId = "fx-fat" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "目标".repeat(400) });
  let cursor = u;
  const ids = [u];
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `步 ${i}`, action: "bash(x)" });
    const a = addAgentNode(g, { seq: 3 + i, goal: `g${i}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = a;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    ids.push(a);
    cursor = a;
  }
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `失败 ${i}`, action: "bash(x)" });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: boom ${i}` });
  }
  return { g, ids };
}

/** 长路径但内容不大：用来测「路径行额度」。 */
function longChain({ hops = 200, sessionId = "fx-long" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。" });
  let cursor = u;
  const ids = [u];
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i} 步`, action: "bash(x)" });
    const a = addAgentNode(g, { seq: 3 + i * 2, goal: `s${i}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = a;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    ids.push(a);
    cursor = a;
  }
  return { g, ids };
}

/** 从清单里取所有路径行（CURRENT PATH / WORKING / # path:）。 */
const pathLines = (text) => text.split("\n").filter((l) => /^(CURRENT PATH:|WORKING:|# path:|# WORKING:)/.test(l));

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "P5-1 正常图：fallback=\"none\"，overBudgetBy=0，budgetMax=请求值"(t) {
    const g = createGraph({ sessionId: "fx-ok" });
    addUserNodeId(g, { seq: 1, text: "hi" });
    const r = renderLedger(g, { maxTokens: 500 });
    t.eq(r.fallback, "none", "正常图必须 none");
    t.eq(r.overBudgetBy, 0, "不得有超出量");
    t.eq(r.budgetMax, 500, "budgetMax 必须回显请求预算");
    t.ok(r.tokens <= 500, `tokens 必须 ≤500，实际 ${r.tokens}`);
  },

  "P5-2 兜底超限：over-budget 必须显式标记 + overBudgetBy = tokens - maxTokens"(t) {
    const { g } = fatGraph({ hops: 10, failures: 3000, sessionId: "fx-over" });
    const r = renderLedger(g, { maxTokens: 1 });
    t.ok(r.tokens > 1, `夹具必须超预算，实际 ${r.tokens}`);
    t.eq(r.fallback, "over-budget", "超预算必须显式标 over-budget，不许静默");
    t.eq(r.overBudgetBy, r.tokens - 1, "overBudgetBy 必须等于 tokens - maxTokens");
    t.eq(r.level, 5, "兜底档必须是 L5");
    t.ok(r.text.length > 0, "兜底也要给内容，不许返回空");
  },

  "P5-3 两状态判定纯函数：impossible 只在「没有非空文本」时出现"(t) {
    t.eq(fallbackStatusOf(null, 500), "impossible", "null → impossible");
    t.eq(fallbackStatusOf({ text: "", tokens: 0 }, 500), "impossible", "空文本 → impossible");
    t.eq(fallbackStatusOf({ text: "x".repeat(100), tokens: 600 }, 500), "over-budget", "超预算 → over-budget");
    t.eq(fallbackStatusOf({ text: "x".repeat(100), tokens: 400 }, 500), "none", "预算内 → none");
    t.eq(fallbackStatusOf({ text: "x", tokens: 500 }, 500), "none", "恰好等于预算 → none（≤ 不是 <）");
  },

  "P5-4 pickFallback 择优：预算内优先，其次 tokens 小，最后列得多"(t) {
    const over20 = { text: "a", tokens: 600, shownFailures: 20, level: 4 };
    const within10 = { text: "b", tokens: 480, shownFailures: 10, level: 5 };
    const within5 = { text: "c", tokens: 450, shownFailures: 5, level: 5 };
    t.eq(pickFallback([over20, within10], 500, 10).tokens, 480, "有预算内候选时不许选超预算的");
    t.eq(pickFallback([within10, within5], 500, 10).tokens, 450, "预算内选 tokens 最小");
    // 平手时列得多的胜（L4 的 20 条 > L5 的 10 条）
    const tieA = { text: "a", tokens: 450, shownFailures: 20, level: 4 };
    const tieB = { text: "b", tokens: 450, shownFailures: 10, level: 5 };
    t.eq(pickFallback([tieB, tieA], 500, 30).shownFailures, 20, "平手时列得多的胜");
    // 全都超预算 ⇒ 选最省的
    t.eq(pickFallback([{ text: "a", tokens: 900, shownFailures: 20 }, { text: "b", tokens: 700, shownFailures: 10 }], 500, 30).tokens, 700, "全超时选最省");
    t.eq(pickFallback([], 500, 0), null, "空 attempts → null（由上层判 impossible）");
  },

  "P5-5 路径行固定额度：任何档位都不得把预算吃满（≤150 字符 ≈ 50 token）"(t) {
    const { g } = longChain({ hops: 200 });
    for (const budget of [1e9, 500, 400, 300, 200, 100, 50, 10, 1]) {
      const r = renderLedger(g, { maxTokens: budget });
      const lines = pathLines(r.text);
      t.ok(lines.length > 0, `预算 ${budget}（L${r.level}）必须有路径行（不许静默省略）`);
      // L0–L2 是 full 形态（1.9.1 逐字兼容，路径必须完整）；固定额度只约束 L3+ 的降级档。
      if (r.level >= 3) {
        const chars = lines.reduce((n, l) => n + l.length + 1, 0);
        t.ok(chars <= 150, `预算 ${budget}（L${r.level}）的路径行 ${chars} 字符 > 150 额度：${lines.join(" | ").slice(0, 200)}`);
      }
    }
  },

  "P5-6 renderFacts 不受预算/兜底影响：同一图在 500 与 1 下 facts 逐字相同"(t) {
    const { g } = fatGraph({ hops: 6, failures: 50, sessionId: "fx-facts" });
    const f1 = renderFacts(g);
    const a = renderLedger(g, { maxTokens: 500 });
    const b = renderLedger(g, { maxTokens: 1 });
    t.eq(renderFacts(g), f1, "渲染两次 facts 必须一致");
    t.eq(a.fallback !== "impossible" && b.fallback !== "impossible", true, "两种预算都必须给出内容");
    // 预算只影响热清单，不影响硬事实
    t.eq(f1.includes("FAILED_ATTEMPTS"), true, "facts 里必须有失败清单");
  },

  "P5-7 兜底档的 tokens 不因预算更小而变大（单调）"(t) {
    const { g } = fatGraph({ hops: 10, failures: 200, sessionId: "fx-mono" });
    let prev = Infinity;
    for (const budget of [500, 300, 200, 100, 50, 10, 1]) {
      const r = renderLedger(g, { maxTokens: budget });
      t.ok(r.tokens <= prev, `预算 ${budget} 的 tokens ${r.tokens} 比上一档 ${prev} 还大`);
      prev = r.tokens;
    }
  },
};

tests["T-4 不可裁下限可量化：约束+根目标本身的 token 数 > 预算时如实标出（C44）"] = (t) => {
  const g = heavyGraph({ constraints: 6, failures: 2, sessionId: "fx-floor" });
  const led = renderLedger(g, { maxTokens: 200 });
  t.eq(typeof led.unyieldingTokens, "number", "必须给出不可裁下限的 token 数");
  t.ok(led.unyieldingTokens >= 200, `约束+根目标应超过 200 预算，实际 ${led.unyieldingTokens}`);
  t.eq(led.fallback, "over-budget", "底线超预算时必然 over-budget");
  const wide = renderLedger(g, { maxTokens: 5000 });
  t.ok(wide.unyieldingTokens > 0, "宽松预算下也要给出这个数（用于趋势）");
  t.ok(wide.unyieldingTokens < wide.tokens, "底线必须小于整段清单（否则说明统计把失败边也算进去了）");
};

/** C44 夹具：约束不小 + 少量失败边（约束+根目标本身就吃掉预算）。 */
function heavyGraph({ constraints = 6, failures = 2, sessionId = "fx-floor" } = {}) {
  const g = createGraph({ sessionId });
  const pad = (n, tag) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
  const cons = Array.from({ length: constraints }, (_, i) => `约束 ${i}：${pad(110, "不要动 prod 配置")}`);
  const u = addUserNodeId(g, { seq: 1, text: "把设置改回侧边栏", constraints: cons });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `尝试 ${i}`, action: `bash(x${i})`, evidence: { start: 2 + i, end: 3 + i } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: boom" });
  }
  return g;
}

tests["T-5 最小清单（C67）：renderMinimalLedger 必须标 minimal:true，且指标层能读到"] = (t) => {
  const g = createGraph({ sessionId: "fx-minimal" });
  const u = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
  addAgentNode(g, { seq: 2, goal: "跑测试", worldHash: "W1", constraintHash: "C1" });
  const led = renderMinimalLedger(g, { maxTokens: 500 });
  t.eq(led.minimal, true, "最小清单必须带 minimal:true（否则该字段永远无消费者）");
  t.eq(typeof led.tokens, "number", "仍要有 tokens");
  const full = renderLedger(g, { maxTokens: 500 });
  t.eq(full.minimal === true, false, "普通渲染不许冒充最小清单");
};
