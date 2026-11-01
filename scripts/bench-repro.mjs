/**
 * bench-repro.mjs —— 一条命令复现 README 顶部的两个指标
 *
 *   node scripts/bench-repro.mjs
 *   # hot-list tokens: 351 (fixture=2000-edges, tier=L5)
 *   # failure-retention: 8 / 8
 *
 * 退出码：
 *   0  两个指标与基线一致
 *   2  数字漂移（算法或夹具变了，需要人工确认后更新基线）
 *   1  复跑失败（bench 跑不通 / 渲染抛错 / 保留数不足）
 */
import { spawnSync } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode } from "../test/graph-fixtures.mjs";
import { renderFacts } from "../src/rooms/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 基线：只在有意改变算法/夹具时更新，并同步 README。 */
const EXPECTED_TOKENS = 351;
const EXPECTED_TIER = 5;
const EXPECTED_RETENTION = 8;

function fail(code, message) {
  console.error(`\n[FAIL] ${message}`);
  process.exit(code);
}

/* ── 指标一：热清单 tokens（2000 边夹具，L5 降级档） ── */
const bench = spawnSync(process.execPath, [nodePath.join(ROOT, "test", "bench.mjs"), "2000"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (bench.status !== 0) {
  console.error(bench.stdout || "");
  console.error(bench.stderr || "");
  fail(1, "test/bench.mjs 2000 无法跑通");
}
const summary = (bench.stdout.match(/热上下文 (\d+) tokens（丢边 (\d+) 条）/) || []);
if (!summary.length) fail(1, "无法从 bench 输出解析热上下文 tokens");
const tokens = Number(summary[1]);
const omitted = Number(summary[2]);

let tier = null;
try {
  const raw = nodePath.join(ROOT, "evidence", "bench-2000.json");
  const { readFileSync } = await import("node:fs");
  tier = JSON.parse(readFileSync(raw, "utf8")).ledgerLevel ?? null;
} catch {
  /* tier 仅用于展示：证据文件缺失不阻塞复跑 */
}

/* ── 指标二：失败保留（8 条互不相同的失败原因是否逐字可见） ── */
const CAUSES = Array.from({ length: EXPECTED_RETENTION }, (_, i) => `ERR_${i}: unique failure cause ${i}`);
const g = createGraph({ sessionId: "bench-repro", cwd: process.cwd() });
let last = addUserNodeId(g, { seq: 1, text: "保持全部失败原因逐字可见，不得省略。" });
for (let i = 0; i < CAUSES.length; i += 1) {
  const edge = addEdge(g, {
    from: last,
    intent: `第 ${i} 步：尝试修复模块 ${i}`,
    action: `bash(npm test -- case${i})`,
    evidence: { start: 100 + i * 8, end: 104 + i * 8 },
  });
  settleEdge(g, edge, {
    to: null,
    result: "failure",
    verify: { kind: "exit", summary: "exit 1" },
    errorSnippet: CAUSES[i],
  });
  last = addAgentNode(g, { seq: 10 + i, turn: i, goal: `推进到第 ${i} 步`, worldHash: `W${i}`, constraintHash: "C1" });
}

let facts = "";
try {
  facts = renderFacts(g);
} catch (error) {
  fail(1, `renderFacts 抛错：${String(error?.message ?? error)}`);
}
const retained = CAUSES.filter((cause) => facts.includes(cause)).length;

/* ── 输出 ── */
console.log(`hot-list tokens: ${tokens} (fixture=2000-edges, tier=L${tier ?? "?"})`);
console.log(`failure-retention: ${retained} / ${EXPECTED_RETENTION}`);

if (retained < EXPECTED_RETENTION) {
  fail(1, `失败保留 ${retained}/${EXPECTED_RETENTION} —— 有失败原因被省略，违反「丢边不丢因」`);
}

let drift = 0;
if (tokens !== EXPECTED_TOKENS) {
  console.error(`[DRIFT] hot-list tokens 期望 ${EXPECTED_TOKENS}，实测 ${tokens}（差异 ${tokens - EXPECTED_TOKENS}）`);
  drift += 1;
}
if (tier !== null && tier !== EXPECTED_TIER) {
  console.error(`[DRIFT] 降级档期望 L${EXPECTED_TIER}，实测 L${tier}`);
  drift += 1;
}
if (omitted !== 0) console.error(`[WARN] 本次渲染省略了 ${omitted} 条边（降级不应丢边）`);

if (drift > 0) {
  console.error("[DRIFT] 数字与基线不一致：确认是有意改动后更新脚本里的 EXPECTED_* 与 README，再提交。");
  process.exit(2);
}
