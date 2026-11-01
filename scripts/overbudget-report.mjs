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
  // ★ C63：判「所选是否已是最省的尝试」必须看**实际尝试过的 tokens**。
  //   旧判据用 `shown < count` 猜「还有更省形态」，结果把「L5 已省略 11 条、仍只超 3 tok」误报成可疑 ——
  //   L5 本身就是最省的一份，再省只能删内容。现在只有「所选 tokens > 最省尝试 tokens」才算裁决 bug。
  const attempts = Array.isArray(ledger.attemptTokens) ? ledger.attemptTokens.map((a) => Number(a.tokens)).filter(Number.isFinite) : null;
  const cheapest = attempts && attempts.length > 0 ? Math.min(...attempts) : null;
  const reason =
    fallback === "none"
      ? "within"
      : unyielding >= budget
        ? "floor" // 约束+根目标下限即超预算（不可裁）
        : cheapest !== null && tokens > cheapest
          ? "bug" // 所选的不是最省尝试 —— 兜底裁决有问题，需要排查
          : "irreducible"; // 已是最省仍是超预算：再省只能删内容（失败记忆 / 约束）
  return { tokens, over, fallback, level: ledger.level ?? null, unyieldingTokens: unyielding, shownFailures: shown, failureCount: total, cheapestTokens: cheapest, reason };
}

/** 扫 home 下所有会话图；返回超预算清单（按超出量降序）。 */
export function scanOverBudget(home, { budget = 500 } = {}) {
  const sessionsRoot = nodePath.join(String(home ?? ""), "chess-context", "sessions");
  const result = { home: String(home ?? ""), budget, sessions: 0, unreadable: 0, over: [], counts: { within: 0, floor: 0, irreducible: 0, "bug": 0 } };
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
    // ★ C64（专员审计 P2）：按**生产形状**渲染 —— 生产与 handoff-check 都带 treeDir（TRACE 行），
    //   不带会让贴边界的会话少算约 4%（实测 641 vs 666），可能误判 floor/irreducible。
    const verdict = classifyBudget(renderLedger(graph, { maxTokens: budget, treeDir: `sessions/${entry.name}`, traceRoot: "sessions" }), budget);
    if (verdict === null) continue;
    result.counts[verdict.reason] = (result.counts[verdict.reason] ?? 0) + 1;
    if (verdict.reason !== "within") result.over.push({ session: entry.name, ...verdict });
  }
  result.over.sort((a, b) => b.over - a.over);
  return result;
}

/**
 * 与上一次快照对比（C58）：每小时跑一次，最有用的是「超预算的构成变了没有」。
 * 只报事实变化，不给结论。
 */
export function trendOverBudget(prev, report) {
  if (!prev || typeof prev !== "object" || !report || typeof report !== "object") return null;
  const prevCounts = prev.counts && typeof prev.counts === "object" ? prev.counts : null;
  if (prevCounts === null) return null;
  const delta = {};
  for (const key of new Set([...Object.keys(prevCounts), ...Object.keys(report.counts ?? {})])) {
    const before = Number(prevCounts[key] ?? 0);
    const after = Number(report.counts?.[key] ?? 0);
    if (before !== after) delta[key] = after - before;
  }
  const prevTop = Array.isArray(prev.over) && prev.over.length > 0 ? prev.over[0].session : null;
  const nowTop = Array.isArray(report.over) && report.over.length > 0 ? report.over[0].session : null;
  return {
    previousAt: typeof prev.generatedAt === "string" ? prev.generatedAt : null,
    countsDelta: delta,
    topSessionChanged: prevTop !== nowTop,
    topSession: nowTop,
  };
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
  const out = getArg("out", "");
  const report = scanOverBudget(home, { budget });
  // C58：--out 写快照（json + 人读 md），并带上与上一次快照的对比
  if (out) {
    let previous = null;
    try {
      if (nodeFs.existsSync(`${out}.json`)) previous = JSON.parse(nodeFs.readFileSync(`${out}.json`, "utf8"));
    } catch {
      previous = null;
    }
    const trend = trendOverBudget(previous, report);
    const payload = { generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...report, trend };
    nodeFs.mkdirSync(nodePath.dirname(out), { recursive: true });
    nodeFs.writeFileSync(`${out}.json`, JSON.stringify(payload, null, 2) + String.fromCharCode(10), "utf8");
    const lines = [
      "# 热清单超预算快照（离线归因）",
      "",
      `- 时间：${payload.generatedAt} · budget=${budget} · 会话 ${report.sessions} 个`,
      `- 构成：within=${report.counts.within ?? 0} / floor=${report.counts.floor ?? 0} / irreducible=${report.counts.irreducible ?? 0} / bug=${report.counts.bug ?? 0}`,
      "",
      "| 会话 | tokens | 超出 | 档位 | 归因 |",
      "|---|---:|---:|---|---|",
      ...report.over.map((r) => `| ${r.session.slice(0, 24)}… | ${r.tokens} | ${r.over} | L${r.level} | ${r.reason} |`),
      "",
      trend
        ? `与上次对比（${trend.previousAt ?? "—"}）：${Object.entries(trend.countsDelta).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(" · ") || "构成无变化"}${trend.topSessionChanged ? ` · 头号来源变为 ${trend.topSession?.slice(0, 24)}…` : ""}`
        : "与上次对比：无旧快照（首次写入）",
      "",
    ];
    nodeFs.writeFileSync(`${out}.md`, lines.join(String.fromCharCode(10)), "utf8");
    console.log(`已写 ${out}.json 与 ${out}.md`);
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`热清单超预算离线归因（budget=${budget}，会话 ${report.sessions} 个${report.unreadable > 0 ? `，${report.unreadable} 个图读不出` : ""}）`);
  console.log(`  即期快照：within=${report.counts.within} / floor=${report.counts.floor} / irreducible=${report.counts.irreducible} / bug=${report.counts.bug}`);
  if (report.over.length === 0) {
    console.log("  ✓ 当前所有会话图都能装进预算");
    return 0;
  }
  for (const row of report.over) {
    const why =
      row.reason === "floor"
        ? "约束+根目标下限即超（不可裁）"
        : row.reason === "bug"
          ? `**所选不是最省尝试**（选了 ${row.tokens}，最省 ${row.cheapestTokens}）—— 兜底裁决 bug`
          : `已是最省尝试仍是超预算 ${row.tokens}（再省只能删内容：失败记忆/约束；shown ${row.shownFailures}/${row.failureCount}）`;
    console.log(`  ! ${row.session.slice(0, 24)}… ${row.tokens}/${budget}（超 ${row.over}，L${row.level}）— ${why}`);
  }
  console.log("说明：即期快照 ≠ 累计计数。累计 over-budget 会随会话增长而放大（同一会话每步重渲染）。");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
