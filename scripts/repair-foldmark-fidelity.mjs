#!/usr/bin/env node
/**
 * repair-foldmark-fidelity.mjs —— 修历史 foldMark 丢失的「约束」保真度（T97）
 *
 * 背景：旧离线 fold 在机械补回（C492）之前生成，摘要里可能漏掉用户约束。
 * 这类记录不会自愈：handoff ⑩ 会永久 FAIL。只改**已归档且不活跃**的会话，
 * 把缺失约束按机械补回段追加到摘要，并重算 constraintRecall。
 *
 * 安全边界：
 *   · 默认 dry-run，只打印；
 *   · --apply 才写，先备份 <graph.json>.bak-fidelity-<ts>，tmp+rename 原子替换；
 *   · 只改 foldMark 摘要/质量字段，不删边、不合并、不改其它历史；
 *   · 活跃会话默认跳过（fold 未收口，交给 handoff 的 WARN）。
 *
 * 用法：
 *   node scripts/repair-foldmark-fidelity.mjs
 *   node scripts/repair-foldmark-fidelity.mjs --apply
 *   node scripts/repair-foldmark-fidelity.mjs --home <DSH_HOME>
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { repairMissingConstraints } from "../src/rooms/offline-fold.mjs";
import { constraintsInFoldRange } from "../src/rooms/fold-quality.mjs";
import { estimateTokens } from "../src/rooms/ledger.mjs";
import { indexSessionLogs, isSessionActive } from "./session-activity.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function summaryOf(graph, mark) {
  if (typeof mark?.summaryText === "string" && mark.summaryText !== "") return { text: mark.summaryText, kind: "mark" };
  const last = graph?.lastOfflineSummary;
  const sameRange =
    last?.range &&
    Number(last.range.start) === Number(mark?.seqStart) &&
    Number(last.range.end) === Number(mark?.seqEnd);
  if (sameRange && typeof last?.text === "string" && last.text !== "") return { text: last.text, kind: "lastOfflineSummary" };
  return null;
}

/** 哪些 mark 需要修：有 missingConstraints 或 constraintRecall<1，且有可定位的摘要。 */
export function findFidelityMarks(graph) {
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const recall = Number(mark?.quality?.constraintRecall ?? 1);
    const missing = Array.isArray(mark?.quality?.missingConstraints) ? mark.quality.missingConstraints : [];
    if (recall >= 1 && missing.length === 0) continue;
    const summary = summaryOf(graph, mark);
    out.push({
      index: i,
      seqStart: mark?.seqStart,
      seqEnd: mark?.seqEnd,
      trigger: mark?.trigger ?? "?",
      summaryKind: summary?.kind ?? null,
      hasSummary: summary !== null,
      declaredMissing: missing.length,
    });
  }
  return out;
}

/** 纯函数：修一张图，返回新图与修复统计（不改输入）。 */
export function repairGraphFidelity(graph, { now = Date.now() } = {}) {
  const next = clone(graph);
  const marks = Array.isArray(next?.foldMarks) ? next.foldMarks : [];
  const repaired = [];
  const skipped = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const recall = Number(mark?.quality?.constraintRecall ?? 1);
    const declared = Array.isArray(mark?.quality?.missingConstraints) ? mark.quality.missingConstraints : [];
    if (recall >= 1 && declared.length === 0) continue;
    const summary = summaryOf(next, mark);
    if (summary === null) {
      skipped.push({ index: i, reason: "NO_SUMMARY_TEXT", trigger: mark?.trigger ?? "?" });
      continue;
    }
    const range = { start: Number(mark.seqStart), end: Number(mark.seqEnd) };
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
      skipped.push({ index: i, reason: "NO_RANGE", trigger: mark?.trigger ?? "?" });
      continue;
    }
    const constraints = constraintsInFoldRange(next, range);
    const missing = constraints.filter((constraint) => !String(summary.text).includes(constraint));
    if (missing.length === 0) {
      // 指标旧了但文本其实完整：只修正质量字段，不算内容修复。
      mark.quality.constraintRecall = 1;
      mark.quality.missingConstraints = [];
      mark.quality.expectedConstraints = constraints.length;
      repaired.push({ index: i, kind: "METRIC_ONLY", count: 0, trigger: mark?.trigger ?? "?" });
      continue;
    }
    const result = repairMissingConstraints(summary.text, missing);
    if (result.repaired === 0) {
      skipped.push({ index: i, reason: "NO_REPAIR", trigger: mark?.trigger ?? "?" });
      continue;
    }
    if (summary.kind === "mark") mark.summaryText = result.text;
    else next.lastOfflineSummary.text = result.text;
    mark.summaryChars = result.text.length;
    mark.quality.constraintRecall = 1;
    mark.quality.missingConstraints = [];
    mark.quality.expectedConstraints = constraints.length;
    mark.quality.summaryTokens = estimateTokens(result.text);
    mark.quality.constraintsRepaired = result.repaired;
    repaired.push({ index: i, kind: "CONSTRAINTS_APPENDED", count: result.repaired, trigger: mark?.trigger ?? "?" });
  }
  return { graph: next, repaired, skipped, at: now };
}

function listGraphDirs(sessionsRoot) {
  if (!nodeFs.existsSync(sessionsRoot)) return [];
  return nodeFs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.join(sessionsRoot, entry.name))
    .filter((dir) => nodeFs.existsSync(nodePath.join(dir, "graph.json")));
}

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const homeIdx = argv.indexOf("--home");
  const home = homeIdx >= 0 && argv[homeIdx + 1] ? argv[homeIdx + 1] : process.env.DSH_HOME?.trim() || nodePath.join(os.homedir(), ".dsh");
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsRoot)) {
    console.error(`没有会话目录：${sessionsRoot}`);
    return 2;
  }
  let changed = 0;
  let repairedCount = 0;
  let activeSkipped = 0;
  const logIndex = indexSessionLogs(home);
  for (const dir of listGraphDirs(sessionsRoot)) {
    const graphFile = nodePath.join(dir, "graph.json");
    if (isSessionActive(dir, { logIndex })) {
      activeSkipped += 1;
      console.log(`⏸ ${nodePath.basename(dir)} 活动窗口内，跳过`);
      continue;
    }
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
    } catch (error) {
      console.log(`✗ ${nodePath.basename(dir)} 读图失败：${String(error?.message ?? error).slice(0, 100)}`);
      continue;
    }
    const result = repairGraphFidelity(graph);
    if (result.repaired.length === 0 && result.skipped.length === 0) continue;
    const count = result.repaired.reduce((sum, row) => sum + row.count, 0);
    changed += result.repaired.length > 0 ? 1 : 0;
    repairedCount += count;
    const detail = [
      ...result.repaired.map((row) => `#${row.index} ${row.kind}+${row.count}`),
      ...result.skipped.map((row) => `#${row.index} ${row.reason}`),
    ].join(" · ");
    console.log(`${apply ? "✎" : "·"} ${nodePath.basename(dir)} ${detail}`);
    if (!apply || result.repaired.length === 0) continue;
    const backup = `${graphFile}.bak-fidelity-${Date.now()}`;
    nodeFs.copyFileSync(graphFile, backup);
    const tmp = `${graphFile}.tmp-fidelity-${process.pid}`;
    nodeFs.writeFileSync(tmp, `${JSON.stringify(result.graph)}\n`, "utf8");
    nodeFs.renameSync(tmp, graphFile);
    const readBack = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
    const bad = (readBack.foldMarks ?? []).filter((mark) => Number(mark?.quality?.constraintRecall ?? 1) < 1);
    if (bad.length > 0) {
      console.error(`✗ ${nodePath.basename(dir)} 写后仍有 ${bad.length} 条低召回`);
      return 1;
    }
    console.log(`  ✓ 已备份 ${nodePath.basename(backup)} 并重读通过`);
  }
  console.log(`\n${apply ? "apply" : "dry-run"}：会话 ${changed} 个需修，补回约束 ${repairedCount} 条，活跃跳过 ${activeSkipped} 个`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
