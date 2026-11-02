#!/usr/bin/env node
/**
 * consistency-check.mjs —— 「证据 ↔ 源数据」交叉核对（C200）
 *
 * 为什么需要：C143→C199 一共五次同族事故，都是「某个工具读的不是同一份真相」。
 * 每次都是**人肉比对数字**才发现的。这个脚本把那次比对固化成一条命令：
 *
 *   ① 磁盘真相：逐会话 `loadSessionGraph`（重放 delta）后的 foldMarks 总数、会话数、节点数；
 *   ② 证据：`evidence/live-folds.json` 的 `summary.total`；
 *   ③ 外部折叠：`ledger-budget.json` 的 `externalFolds`（不重复计入 ①）。
 *
 * 三者对不上 ⇒ exit 1，并直接告诉你「该跑 `--write` 还是真有问题」。
 *
 * 用法：
 *   node scripts/consistency-check.mjs                 # 默认检查仓库 evidence/
 *   node scripts/consistency-check.mjs --json
 *   DSH_HOME=... node scripts/consistency-check.mjs
 *
 * 退出码：0 = 一致；1 = 不一致（或读不到）。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

function resolveHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim().length > 0 ? env.trim() : nodePath.join(nodeOs.homedir(), ".dsh");
}

/** 磁盘真相：重放 delta 后逐会话统计。 */
export function scanDisk(home) {
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const out = { sessions: 0, foldMarks: 0, nodes: 0, edges: 0, unreadable: 0, deltaOnlyMarks: 0 };
  if (!nodeFs.existsSync(sessionsRoot)) return out;
  for (const name of nodeFs.readdirSync(sessionsRoot)) {
    const graphFile = nodePath.join(sessionsRoot, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    out.sessions += 1;
    let replayed;
    try {
      replayed = loadSessionGraph(graphFile).graph;
    } catch {
      out.unreadable += 1;
      continue;
    }
    out.foldMarks += (replayed.foldMarks ?? []).length;
    out.nodes += Object.keys(replayed.nodes ?? {}).length;
    out.edges += Object.keys(replayed.edges ?? {}).length;
    // 基线里没有、但重放后有的 foldMark ⇒ 说明「只读基线」的工具会漏（C199 的病根）
    try {
      const raw = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
      const rawCount = Array.isArray(raw.foldMarks) ? raw.foldMarks.length : 0;
      const replayedCount = (replayed.foldMarks ?? []).length;
      if (replayedCount > rawCount) out.deltaOnlyMarks += replayedCount - rawCount;
    } catch {
      /* 基线坏了，上面已经算 unreadable 或仍可 replay */
    }
  }
  return out;
}

/** 证据文件与预算账本。 */
export function readEvidence(home) {
  const out = { evidenceTotal: null, evidencePath: null, externalFolds: null, budgetPath: null };
  const evidencePath = nodePath.join(REPO, "evidence", "live-folds.json");
  out.evidencePath = evidencePath;
  if (nodeFs.existsSync(evidencePath)) {
    try {
      out.evidenceTotal = Number(JSON.parse(nodeFs.readFileSync(evidencePath, "utf8"))?.summary?.total ?? NaN);
    } catch {
      out.evidenceTotal = NaN;
    }
  }
  const budgetPath = nodePath.join(home, "chess-context", "ledger-budget.json");
  out.budgetPath = budgetPath;
  if (nodeFs.existsSync(budgetPath)) {
    try {
      out.externalFolds = Number(JSON.parse(nodeFs.readFileSync(budgetPath, "utf8"))?.externalFolds ?? 0);
    } catch {
      out.externalFolds = NaN;
    }
  }
  return out;
}

export function check({ home = resolveHome() } = {}) {
  const disk = scanDisk(home);
  const evidence = readEvidence(home);
  const problems = [];
  if (disk.unreadable > 0) problems.push(`${disk.unreadable} 个会话的图读不出来（先跑 graph-audit 看具体会话）`);
  if (evidence.evidenceTotal === null) problems.push("没有 evidence/live-folds.json（先跑 node scripts/live-folds.mjs --write）");
  else if (!Number.isFinite(evidence.evidenceTotal)) problems.push("evidence/live-folds.json 里的 summary.total 不是数字");
  else if (evidence.evidenceTotal !== disk.foldMarks) {
    problems.push(
      `证据 fold 数 ${evidence.evidenceTotal} ≠ 磁盘 ${disk.foldMarks}` +
        (disk.deltaOnlyMarks > 0 ? `（其中 ${disk.deltaOnlyMarks} 条只在 delta 里 ⇒ 证据过期，跑 --write）` : "（证据过期或工具读错源，跑 --write 再判断）"),
    );
  }
  if (!Number.isFinite(evidence.externalFolds)) problems.push("ledger-budget.json 读不出（externalFolds 无法核对）");
  return { home, disk, evidence, problems, ok: problems.length === 0 };
}

function main() {
  const json = process.argv.includes("--json");
  const result = check();
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
  } else {
    const d = result.disk;
    process.stdout.write(`一致性核对：${result.home}` + String.fromCharCode(10));
    process.stdout.write(`  磁盘（重放 delta）：${d.sessions} 会话 / ${d.nodes} 节点 / ${d.edges} 边 / ${d.foldMarks} 条 foldMark` + String.fromCharCode(10));
    process.stdout.write(`  证据 live-folds.json：${result.evidence.evidenceTotal ?? "—"} 次 fold` + String.fromCharCode(10));
    process.stdout.write(`  外部折叠（宿主直调）：${result.evidence.externalFolds ?? "—"} 次` + String.fromCharCode(10));
    if (d.deltaOnlyMarks > 0) process.stdout.write(`  · 其中 ${d.deltaOnlyMarks} 条 foldMark 只在 delta 里（只读基线的工具会漏）` + String.fromCharCode(10));
    process.stdout.write((result.ok ? "✅ 一致" : `❌ ${result.problems.length} 处不一致：${result.problems.join(" / ")}`) + String.fromCharCode(10));
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
