/**
 * overbudget-report.mjs —— 热清单超预算的**离线归因**（2026-11-02，C57）
 *
 * 为什么需要：`ledger-budget.json` 只给聚合计数（over-budget 多少次、最大超多少）。
 * 聚合比例会误导 —— C48 的实测是「一个失败原因很长的会话反复渲染」把 26% 撑起来的，
 * 不是系统性退化。这个脚本用当前 live 图在**指定预算**下逐会话重渲染，直接回答：
 *   · 哪些会话超、超多少、落在哪一档；
 *   · 是「不可裁下限」超（约束+根目标）还是「已列全失败边仍超」（再省只能删失败记忆）；
 *   · 还是「明明有更省形式却没选」（这一种才可能是渲染 bug）。
 *
 * 只读；退出码永远 0（诊断工具不该让流水线红）。
 *
 * 用法：
 *   node scripts/overbudget-report.mjs [--home DIR] [--budget 500] [--json]
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

const { fromJSON } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "kifu-model.mjs")).href);
const { renderLedger } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "ledger.mjs")).href);

/** 单张图在预算下的结论（纯函数，供单测）。 */
export function classifyBudget(ledger, budget) {
  if (!ledger || typeof ledger !== "object") return null;
  const tokens = Number(ledger.tokens ?? 0);
  const over = Math.max(0, tokens - budget);
  const unyielding = Number(ledger.unyieldingTokens ?? 0);
  const shown = Number(ledger.shownFailures ?? 0);
  const total = Number(ledger.failureCount ?? 0);
  const fallback = typeof ledger.fallback === "string" ? ledger.fallback : "none";
  // 归因三态：设计内下限 / 已列全仍超（再省只能丢失败记忆）/ 仍有可能的省法（需排查）
  const reason =
    fallback === "none"
      ? "within"
      : unyielding >= budget
        ? "floor" // 约束+根目标本身就超预算
        : total > 0 && shown >= total
          ? "irreducible" // 失败边已列全，再省必须丢失败记忆
          : "reducible?"; // 还有更省形态没被选中 —— 需要看一眼
  return { tokens, over, fallback, level: ledger.level ?? null, unyieldingTokens: unyielding, shownFailures: shown, failureCount: total, reason };
}

/** 扫 home 下所有会话图；返回超预算清单（按超出量降序）。 */
export function scanOverBudget(home, { budget = 500 } = {}) {
  const sessionsRoot = nodePath.join(String(home ?? ""), "chess-context", "sessions");
  const result = { home: String(home ?? ""), budget, sessions: 0, unreadable: 0, over: [], counts: { within: 0, floor: 0, irreducible: 0, "reducible?": 0 } };
  if (!nodeFs.existsSync(sessionsRoot)) return result;
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    result.sessions += 1;
    let graph;
    try {
      graph = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
    } catch {
      result.unreadable += 1;
      continue;
    }
    const verdict = classifyBudget(renderLedger(graph, { maxTokens: budget }), budget);
    if (verdict === null) continue;
    result.counts[verdict.reason] = (result.counts[verdict.reason] ?? 0) + 1;
    if (verdict.reason !== "within") result.over.push({ session: entry.name, ...verdict });
  }
  result.over.sort((a, b) => b.over - a.over);
  return result;
}

/** CLI。 */
export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : nodePath.join(nodeOs.homedir(), ".dsh"));
  const budget = Number(getArg("budget", 500)) || 500;
  const asJson = argv.includes("--json");
  const report = scanOverBudget(home, { budget });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`热清单超预算离线归因（budget=${budget}，会话 ${report.sessions} 个${report.unreadable > 0 ? `，${report.unreadable} 个图读不出` : ""}）`);
  console.log(`  即期快照：within=${report.counts.within} / floor=${report.counts.floor} / irreducible=${report.counts.irreducible} / reducible?=${report.counts["reducible?"]}`);
  if (report.over.length === 0) {
    console.log("  ✓ 当前所有会话图都能装进预算");
    return 0;
  }
  for (const row of report.over) {
    const why =
      row.reason === "floor"
        ? "约束+根目标下限即超（不可裁）"
        : row.reason === "irreducible"
          ? `失败边已列全 ${row.shownFailures}/${row.failureCount}（再省必须丢失败记忆）`
          : `仍可能有更省形态（shown ${row.shownFailures}/${row.failureCount}，unyielding ${row.unyieldingTokens}）`;
    console.log(`  ! ${row.session.slice(0, 24)}… ${row.tokens}/${budget}（超 ${row.over}，L${row.level}）— ${why}`);
  }
  console.log("说明：即期快照 ≠ 累计计数。累计 over-budget 会随会话增长而放大（同一会话每步重渲染）。");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
