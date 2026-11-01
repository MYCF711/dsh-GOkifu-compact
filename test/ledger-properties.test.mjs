/**
 * ledger-properties.test.mjs —— 热清单渲染的**不变量测试**（2026-11-02，C59）
 *
 * 为什么要有：`ledger-boundary` / `c17-*` / `markers` 都是**手写夹具**，只覆盖作者想到的形状。
 * 压缩产物的风险恰恰在「长尾形状」：失败边 0 条 vs 40 条、约束 0 条 vs 12 条、
 * 预算 200 vs 无上限 —— 手写夹具要为每种组合写一遍，写不全。
 *
 * 这里用**固定种子**的伪随机图，跨多个预算断言一组必须永远成立的契约：
 *   ① 根目标与每条约束都在（逐字头段，不被裁掉）；
 *   ② `shown + omitted === failureCount`（失败边账目闭合）；
 *   ③ `tokens <= budget` 或 `fallback === "over-budget"`（超限必须自报，且 overBudgetBy 对得上）；
 *   ④ 出处覆盖率恒为 1（有失败边时）；`impossible` 永不出现；
 *   ⑤ 模型可见文本里不出现绝对路径、也不出现行动/认知指导（C45/C46 的判据在渲染侧也成立）；
 *   ⑥ 同一图重复渲染结果逐字相同（渲染必须纯）。
 *
 * 种子固定 ⇒ 失败可复现（`SEEDS` 数组就是用例清单）。
 */

import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge } from "./graph-fixtures.mjs";
import { renderLedger } from "../src/rooms/ledger.mjs";
import { RULES } from "../scripts/boundary-audit.mjs";

export const tests = {};

/** mulberry32：小而确定的 PRNG（同种子同序列 ⇒ 失败可复现）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const word = (r, n) => Array.from({ length: n }, () => pick(r, ["改", "配置", "build", "path", "重试", "缓存", "test", "x"])).join("");
const snip = (r) => pick(r, ["Error: EACCES: permission denied", "npm ERR! network timeout ETIMEDOUT", "AssertionError: 1 !== 2", "SyntaxError: unexpected token", "TypeError: undefined is not a function"]) + ` (${word(r, 6)})`;

/** 生成一张随机棋谱：长链 + 每跳多边（含长失败原因）+ 随机长约束，能压到 L4/L5 与超预算。 */
function randomGraph(seed) {
  const r = rng(seed);
  const g = createGraph({ sessionId: `fuzz-${seed}` });
  const constraintCount = Math.floor(r() * 9); // 0–8 条
  const constraints = Array.from({ length: constraintCount }, () =>
    `${word(r, 6)}：${"不许动 prod 配置，".repeat(1 + Math.floor(r() * 8))}${word(r, Math.floor(r() * 10))}`,
  );
  let cursor = addUserNodeId(g, { seq: 1, text: `${word(r, 12)} ${word(r, 8)}`, constraints });

  const hops = 6 + Math.floor(r() * 25); // 6–30 跳
  let seq = 2;
  for (let i = 0; i < hops; i += 1) {
    const edgesThisHop = 1 + Math.floor(r() * 3); // 每跳 1–3 条边
    for (let k = 0; k < edgesThisHop; k += 1) {
      const roll = r();
      const e = addEdge(g, { from: cursor, intent: `${word(r, 8)} ${k}`, action: `${pick(r, ["bash", "edit", "write"])}(${word(r, 6)})`, evidence: { start: seq, end: seq + 1 } });
      seq += 2;
      const node = addAgentNode(g, { seq, goal: word(r, 6), worldHash: `W${seed}-${i}-${k}`, constraintHash: "C1", via: e }).id;
      seq += 1;
      if (roll < 0.6) {
        const longReason = `${snip(r)} ${"重试后仍然失败，".repeat(1 + Math.floor(r() * 5))}`.slice(0, 260);
        settleEdge(g, e, { to: node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: longReason });
      } else if (roll < 0.88) {
        settleEdge(g, e, { to: node, result: "success", verify: { kind: "exit", summary: "exit 0" } });
      } else {
        settleEdge(g, e, { to: node, result: "unverified", verify: { kind: "none", summary: "" } });
      }
      // 制造一条「回到已访问位置」的边（transposition=true）—— 让置换告警行可达
      if (i > 1 && r() < 0.5) {
        const back = addEdge(g, { from: node, intent: `回到 previous`, action: `bash(back-${i})`, evidence: { start: seq, end: seq + 1 } });
        seq += 2;
        g.edges[back].transposition = true;
        settleEdge(g, back, { to: node, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: loop" });
      }
      cursor = node;
    }
  }
  return g;
}

const BUDGETS = [150, 250, 400, 600, 1_000_000];

tests["C59 渲染不变量：随机图 × 5 档预算（根/约束在、账目闭合、超限自报、无绝对路径、无指导、幂等；覆盖 200 次渲染）"] = (t) => {
  let sawOverBudget = 0;
  let sawOmitted = 0;
  // 40 个固定种子（斐波那契序列，天然互不相同且可复现）：50 次渲染 → 200 次渲染
  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025, 121393, 196418, 317811, 514229, 832040, 1346269, 2178309, 3524578, 5702887, 9227465, 14930352, 24157817, 39088169, 63245986, 102334155, 165580141];
  for (const seed of seeds) {
    const g = randomGraph(seed);
    const root = g.nodes[g.rootUserNodeIds[0]];
    const constraintTexts = g.rootUserNodeIds
      .flatMap((id) => g.nodes[id]?.constraints ?? [])
      .filter((c) => typeof c === "string" && c.trim() !== "");
    const failureIds = Object.values(g.edges).filter((e) => e.result === "failure");
    for (const budget of BUDGETS) {
      const led = renderLedger(g, { maxTokens: budget });
      const where = `seed=${seed} budget=${budget} L${led.level}`;
      t.eq(led.fallback === "impossible", false, `${where}：不许 impossible`);
      // ① 根目标与约束的头段必须在（clip 只裁尾部）
      if (root) t.eq(led.text.includes(root.text.slice(0, 12)), true, `${where}：根目标缺失`);
      for (const c of constraintTexts) {
        const head = c.replace(/^\s*[-*]\s+/, "").slice(0, 10);
        if (head.length >= 4) t.eq(led.text.includes(head), true, `${where}：约束头段缺失「${head}」`);
      }
      // ② 失败边账目闭合
      if (failureIds.length > 0) {
        t.eq(led.shownFailures + led.omittedEdges, failureIds.length, `${where}：shown+omitted 不等于失败边总数`);
        if (led.omittedEdges > 0) sawOmitted += 1;
      }
      // ③ 超限必须自报，且 overBudgetBy 对得上
      if (led.tokens > budget) {
        t.eq(led.fallback, "over-budget", `${where}：超限却没标 over-budget`);
        t.eq(led.overBudgetBy, led.tokens - budget, `${where}：overBudgetBy 与 tokens-budget 不符`);
      } else {
        t.eq(led.overBudgetBy, 0, `${where}：没超预算却报 overBudgetBy`);
      }
      // ③b C63：超预算时，所选必须就是**最省的尝试**（兜底裁决不许挑贵的）
      if (led.fallback === "over-budget") {
        sawOverBudget += 1;
        // ★ C64：字段缺失不许静默通过 —— attemptTokens 是「所选是否最省」的唯一凭据
        t.eq(Array.isArray(led.attemptTokens) && led.attemptTokens.length > 0, true, `${where}：over-budget 必须带 attemptTokens`);
        const cheapest = Math.min(...led.attemptTokens.map((a) => a.tokens));
        t.eq(led.tokens, cheapest, `${where}：兜底没选最省尝试（选了 ${led.tokens}，最省 ${cheapest}）`);
      }
      // ④ 出处覆盖率
      if (failureIds.length > 0) t.eq(led.provenanceCoverage, 1, `${where}：出处覆盖率应恒为 1`);
      // ⑤ 模型可见文本的硬约束
      t.eq(/[A-Za-z]:[\\/]/.test(led.text), false, `${where}：出现绝对路径`);
      for (const rule of RULES) {
        t.eq(rule.re.test(led.text), false, `${where}：命中审计规则 ${rule.id}（${rule.why}）`);
      }
      // ⑥ 幂等
      t.eq(renderLedger(g, { maxTokens: budget }).text === led.text, true, `${where}：同一图两次渲染不一致`);
    }
  }
  // 覆盖性断言：生成器必须真的把「超预算」与「省略分支」跑到，否则属性测试会退化成恒真
  t.eq(sawOverBudget > 0, true, "本轮必须至少渲染出一次 over-budget");
  t.eq(sawOmitted > 0, true, "本轮必须至少命中一次失败边省略");
};
