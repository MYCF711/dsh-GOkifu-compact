#!/usr/bin/env node
/**
 * after-restart.mjs —— 重启后**一条命令**验收（C186）
 *
 * 把 `evidence/重启验收清单-2026-11-02.md` 的六步收敛成一次调用，全程**只读**、进程内完成
 * （不 spawn doctor / 不跑测试，几秒内出结论）。
 *
 * 用法：
 *   node scripts/after-restart.mjs                 # 默认 home（与 doctor 同源）
 *   DSH_HOME=... node scripts/after-restart.mjs
 *   node scripts/after-restart.mjs --json
 *
 * 退出码：全部必需项通过 ⇒ 0；否则 ⇒ 1。
 *
 * 检查项（必需 / 参考）：
 *   ① build.json 里有 buildId 且不是 unknown（新进程的标志）
 *   ② startedAt 晚于旧基线（2026-11-01T19:01:03Z = 03:01 启动的那次）
 *   ③ 棋谱结构自洽（复用 graph-audit 的 auditRoot）
 *   ④ 节点文档齐全（复用 node-docs 的 nodeDocStats；在途不算缺）
 *   ⑤ live fold 总数 ≥ 基线 20（重启后应有新 fold 或至少不倒退）
 *   ⑥ 新观测字段是否落盘（renderErrors / skipReasons / 归因三键）—— **参考项**：
 *      没出现只说明「还没发生 fold」，不算失败
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { auditRoot } from "./graph-audit.mjs";
import { nodeDocStats } from "../src/rooms/node-docs.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OLD_START = Date.parse("2026-11-01T19:01:03.335Z");
/** 基线从仓库里的证据文件读（避免硬编码漂移）；读不到才回落。 */
function foldBaseline() {
  try {
    const file = nodePath.join(HERE, "..", "evidence", "live-folds.json");
    const total = JSON.parse(nodeFs.readFileSync(file, "utf8"))?.summary?.total;
    return Number.isFinite(total) ? total : 20;
  } catch {
    return 20;
  }
}
const FOLD_BASELINE = foldBaseline();

function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim().length > 0) return env.trim();
  return nodePath.join(os.homedir(), ".dsh");
}

/** 读 build.json（缺失=从未启动过插件）。 */
function readBuildStamp(home) {
  const file = nodePath.join(home, "chess-context", "build.json");
  if (!nodeFs.existsSync(file)) return { file, stamp: null };
  try {
    return { file, stamp: JSON.parse(nodeFs.readFileSync(file, "utf8")) };
  } catch {
    return { file, stamp: null };
  }
}

/** live fold 总数（从图里的 foldMarks 求和，重放 delta 之后算）。 */
function countLiveFolds(sessionsDir) {
  let total = 0;
  let withFolds = 0;
  let sessions = 0;
  if (!nodeFs.existsSync(sessionsDir)) return { total, withFolds, sessions };
  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const graphFile = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    sessions += 1;
    try {
      const { graph } = loadSessionGraph(graphFile);
      const n = (graph.foldMarks ?? []).length;
      total += n;
      if (n > 0) withFolds += 1;
    } catch {
      /* 坏图由结构检查报 */
    }
  }
  return { total, withFolds, sessions };
}

/** 节点文档统计（在途 = 图仍在更新且节点刚创建）。 */
function countNodeDocs(sessionsDir) {
  let missing = 0;
  let inFlight = 0;
  if (!nodeFs.existsSync(sessionsDir)) return { missing, inFlight };
  const now = Date.now();
  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const graphFile = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let graph;
    try {
      graph = loadSessionGraph(graphFile).graph;
    } catch {
      continue;
    }
    const nodesDir = nodePath.join(sessionsDir, name, "nodes");
    const files = nodeFs.existsSync(nodesDir) ? nodeFs.readdirSync(nodesDir) : [];
    const stats = nodeDocStats({ graphNodes: Object.keys(graph.nodes ?? {}), files });
    for (const id of stats.missing) {
      const created = Number(graph.nodes?.[id]?.ts) || 0;
      const fresh = now - (Number(graph.updatedAt) || 0) < 120_000 && now - created < 120_000;
      if (fresh) inFlight += 1;
      else missing += 1;
    }
  }
  return { missing, inFlight };
}

function main() {
  const home = resolveHome();
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  const rows = [];

  const { stamp } = readBuildStamp(home);
  const buildId = typeof stamp?.buildId === "string" && stamp.buildId !== "unknown" ? stamp.buildId : null;
  rows.push({
    id: "①buildId",
    level: buildId === null ? "fail" : "ok",
    detail: buildId === null ? "build.json 无 buildId（仍是旧进程，重启未生效）" : `buildId=${buildId}`,
  });

  const startedAt = Number(stamp?.startedAt) || 0;
  rows.push({
    id: "②进程时间",
    level: startedAt > OLD_START ? "ok" : "fail",
    detail: startedAt === 0 ? "build.json 无 startedAt" : `startedAt=${new Date(startedAt).toISOString()}（旧基线 ${new Date(OLD_START).toISOString()}）`,
  });

  // ★ C191：与 doctor 同口径 —— 「旧版本反向 foldMark」是**历史记录**（C187 前的 tier-2），
  //   新代码不会再产生；它存在时只记 warn，不算验收失败（清理需宿主退出后跑 --repair-foldmarks）。
  const audits = auditRoot(sessionsDir);
  const legacyRangeOnly = [];
  const realBad = [];
  for (const row of audits) {
    const problems = row.problems ?? [];
    if (problems.length === 0) continue;
    const legacy = problems.filter((x) => /^foldMarks\[\d+\] seqStart>seqEnd$/.test(x));
    const rest = problems.filter((x) => !legacy.includes(x));
    if (rest.length > 0) realBad.push(row);
    else if (legacy.length > 0) legacyRangeOnly.push(row);
  }
  rows.push({
    id: "③结构自洽",
    level: realBad.length > 0 ? "fail" : legacyRangeOnly.length > 0 ? "warn" : "ok",
    detail:
      realBad.length > 0
        ? `${realBad.length} 个不自洽：${realBad.slice(0, 2).map((b) => b.session.slice(0, 12)).join(", ")}`
        : legacyRangeOnly.length > 0
          ? `${audits.length} 个会话自洽；${legacyRangeOnly.length} 个含旧版本反向 foldMark（C187 前，宿主退出后可 --repair-foldmarks 清理）`
          : `${audits.length} 个会话全部自洽`,
  });

  const docs = countNodeDocs(sessionsDir);
  rows.push({
    id: "④节点文档",
    level: docs.missing === 0 ? "ok" : "fail",
    detail: docs.missing === 0 ? `齐全（${docs.inFlight} 个在途）` : `${docs.missing} 个缺失（在途 ${docs.inFlight}）`,
  });

  const folds = countLiveFolds(sessionsDir);
  rows.push({
    id: "⑤live fold",
    level: folds.total >= FOLD_BASELINE ? "ok" : "warn",
    detail: `${folds.total} 次 / ${folds.withFolds} 个会话（基线 ${FOLD_BASELINE}）${folds.total < FOLD_BASELINE ? " —— 低于基线，可能读的是旧数据" : ""}`,
  });

  // ⑥ 新观测字段：参考项（没出现只说明还没发生 fold）
  const budgetFile = nodePath.join(home, "chess-context", "ledger-budget.json");
  let keys = [];
  if (nodeFs.existsSync(budgetFile)) {
    try {
      keys = Object.keys(JSON.parse(nodeFs.readFileSync(budgetFile, "utf8")));
    } catch {
      keys = [];
    }
  }
  const wanted = ["renderErrors", "skipReasons", "budgetFloorOver", "budgetIrreducible", "overBySession"];
  const present = wanted.filter((k) => keys.includes(k));
  rows.push({
    id: "⑥新观测字段",
    level: "info",
    detail: present.length === wanted.length ? `全部落盘：${present.join(", ")}` : `已落盘 ${present.length}/${wanted.length}（${present.join(", ") || "无"}）—— 未落盘的等下一次 fold 后再看`,
  });

  const failed = rows.filter((r) => r.level === "fail");
  const json = process.argv.includes("--json");
  if (json) {
    process.stdout.write(JSON.stringify({ home, ok: failed.length === 0, rows }, null, 2) + String.fromCharCode(10));
  } else {
    process.stdout.write(`重启后验收：${home}` + String.fromCharCode(10));
    for (const r of rows) {
      const mark = r.level === "fail" ? "✗" : r.level === "warn" ? "!" : r.level === "info" ? "·" : "✓";
      process.stdout.write(`  ${mark} ${r.id} — ${r.detail}` + String.fromCharCode(10));
    }
    process.stdout.write((failed.length === 0 ? "✅ 必需项全部通过" : `❌ ${failed.length} 个必需项未通过`) + String.fromCharCode(10));
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
