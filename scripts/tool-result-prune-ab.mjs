#!/usr/bin/env node
/**
 * tool-result-prune-ab.mjs —— K-2「每步清掉原始工具结果」的离线 A/B。
 *
 * baseline   = user/assistant 文本 + 原始 tool/result；
 * every-step = user/assistant 文本 + 生产 renderFacts(graph)，不含原始 tool/result。
 *
 * 这里只做字符串级模拟：不调用 reader / 模型，不改 Engine，不写 DSH_HOME，也不改变默认 prune 行为。
 * 失败原因只由生产 renderFacts 渲染；snippet 检查复用 isRememberedByGraph 的前 60 字符口径。
 *
 * 用法：
 *   node scripts/tool-result-prune-ab.mjs --home <DSH_HOME> --limit 10 --json
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  CJK_TOKENS_PER_CHAR,
  LATIN_TOKENS_PER_CHAR,
  estimateTokensByOfficialRatio,
  isRememberedByGraph,
  measureToolResultShare,
} from "./tool-result-share.mjs";
import { decodeMultiFrameZstd } from "./session-scan.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { collectConstraints, renderFacts } from "../src/rooms/ledger.mjs";
import { failureEdges } from "../src/rooms/kifu-model.mjs";

const IMAGE_CHARS = 4000;
const IMAGE_TOKEN_ESTIMATE = estimateTokensByOfficialRatio("x".repeat(IMAGE_CHARS));

function ratio(recalled, denominator) {
  return denominator > 0 ? recalled / denominator : null;
}

/** 与 tool-result-share 的事件字段保持一致；数组块不额外添加分隔符。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") out += block.text;
    else if (typeof block.arguments === "string") out += block.arguments;
  }
  return out;
}

function imageBlocks(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => block?.type === "image").length;
}

function eventContent(event) {
  if (event?.type === "tool/result") return event.data?.message?.content;
  if (event?.type === "user/message" || event?.type === "assistant/message") {
    return event.data?.message?.content ?? event.data?.content;
  }
  return undefined;
}

/** 构造仅用于内存评测的上下文；返回的私有正文不会进入 CLI 报告。 */
function buildContexts(events, facts) {
  const baselineParts = [];
  const retainedParts = [];
  let baselineImages = 0;
  let retainedImages = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== "object") continue;
    const isTool = event.type === "tool/result";
    const isText = event.type === "user/message" || event.type === "assistant/message";
    if (!isTool && !isText) continue;
    const content = eventContent(event);
    const text = contentText(content);
    const images = imageBlocks(content);
    baselineParts.push(text);
    baselineImages += images;
    if (isText) {
      retainedParts.push(text);
      retainedImages += images;
    }
  }
  return {
    baselineText: baselineParts.join(""),
    everyStepText: retainedParts.join("") + facts,
    baselineImages,
    retainedImages,
  };
}

function countRecalledFailures(text, edges) {
  let recalled = 0;
  for (const edge of edges) {
    // 刻意逐边调用生产同口径函数：snippet.slice(0, 60)，且短于 12 字符不算命中。
    if (isRememberedByGraph(text, [edge])) recalled += 1;
  }
  return recalled;
}

function countRecalledConstraints(text, constraints) {
  let recalled = 0;
  for (const constraint of constraints) {
    const needle = String(constraint ?? "");
    if (needle !== "" && text.includes(needle)) recalled += 1;
  }
  return recalled;
}

function decide(baseline, everyStep, savedTokens) {
  const reasons = [];
  if (baseline.failureRecall === null || everyStep.failureRecall === null) reasons.push("failureRecall denominator=0");
  else if (everyStep.failureRecall < baseline.failureRecall) reasons.push("failureRecall regression");
  if (baseline.constraintRecall === null || everyStep.constraintRecall === null) reasons.push("constraintRecall denominator=0");
  else if (everyStep.constraintRecall < baseline.constraintRecall) reasons.push("constraintRecall regression");
  if (savedTokens <= 0) reasons.push("savedTokens<=0");
  return { decision: reasons.length === 0 ? "CANDIDATE" : "REJECT", reasons };
}

/**
 * 单会话纯函数评测。
 * factsText 是测试变异缝：正常调用与 CLI 都省略它，因而始终使用生产 renderFacts(graph)。
 */
export function evaluatePruneAB(events, graph, { factsText } = {}) {
  const share = measureToolResultShare(events);
  const facts = factsText === undefined ? renderFacts(graph) : String(factsText ?? "");
  const contexts = buildContexts(events, facts);
  const allFailures = failureEdges(graph);
  const snippetEdges = allFailures.filter((edge) => String(edge?.errorSnippet ?? "") !== "");
  const constraints = collectConstraints(graph);

  const baselineFailureRecalled = countRecalledFailures(contexts.baselineText, snippetEdges);
  const everyStepFailureRecalled = countRecalledFailures(contexts.everyStepText, snippetEdges);
  const baselineConstraintRecalled = countRecalledConstraints(contexts.baselineText, constraints);
  const everyStepConstraintRecalled = countRecalledConstraints(contexts.everyStepText, constraints);

  const baseline = {
    chars: share.toolChars + share.textChars,
    tokens: estimateTokensByOfficialRatio(contexts.baselineText) + contexts.baselineImages * IMAGE_TOKEN_ESTIMATE,
    failureRecalled: baselineFailureRecalled,
    failureRecall: ratio(baselineFailureRecalled, snippetEdges.length),
    constraintRecalled: baselineConstraintRecalled,
    constraintRecall: ratio(baselineConstraintRecalled, constraints.length),
  };
  const everyStep = {
    chars: share.textChars + facts.length,
    tokens: estimateTokensByOfficialRatio(contexts.everyStepText) + contexts.retainedImages * IMAGE_TOKEN_ESTIMATE,
    failureRecalled: everyStepFailureRecalled,
    failureRecall: ratio(everyStepFailureRecalled, snippetEdges.length),
    constraintRecalled: everyStepConstraintRecalled,
    constraintRecall: ratio(everyStepConstraintRecalled, constraints.length),
  };
  const savedChars = baseline.chars - everyStep.chars;
  const savedTokens = baseline.tokens - everyStep.tokens;
  return {
    toolResults: share.toolResults,
    toolResultChars: share.toolChars,
    retainedTextChars: share.textChars,
    factsChars: facts.length,
    failureEdges: allFailures.length,
    failureSnippetEdges: snippetEdges.length,
    missingSnippetEdges: allFailures.length - snippetEdges.length,
    constraints: constraints.length,
    baseline,
    everyStep,
    savedChars,
    savedTokens,
    ...decide(baseline, everyStep, savedTokens),
  };
}

function sessionLabel(sessionDirName) {
  const label = String(sessionDirName ?? "").replace(/^session-/, "").slice(0, 16);
  return label || "unknown";
}

function listLogs(home, limit) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".zstd")) out.push({ file, mtime: nodeFs.statSync(file).mtimeMs });
    }
  };
  walk(nodePath.join(home, "sessions"));
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function parseEvents(buffer) {
  const decoded = decodeMultiFrameZstd(buffer);
  const events = [];
  let badEventLines = 0;
  for (const line of decoded.text.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badEventLines += 1;
    }
  }
  return { events, badEventLines, frames: decoded.frames, okFrames: decoded.okFrames };
}

export function summarizePruneAB(rows) {
  const evaluatedRows = rows.filter((row) => row.status === "OK");
  const missingGraphSessions = rows.filter((row) => row.status === "MISSING_GRAPH").length;
  const readErrorSessions = rows.length - evaluatedRows.length - missingGraphSessions;
  const total = {
    toolResults: 0,
    toolResultChars: 0,
    retainedTextChars: 0,
    factsChars: 0,
    failureEdges: 0,
    failureSnippetEdges: 0,
    missingSnippetEdges: 0,
    constraints: 0,
  };
  const baseline = { chars: 0, tokens: 0, failureRecalled: 0, constraintRecalled: 0 };
  const everyStep = { chars: 0, tokens: 0, failureRecalled: 0, constraintRecalled: 0 };
  for (const row of evaluatedRows) {
    for (const key of Object.keys(total)) total[key] += row[key];
    for (const key of Object.keys(baseline)) {
      baseline[key] += row.baseline[key];
      everyStep[key] += row.everyStep[key];
    }
  }
  baseline.failureRecall = ratio(baseline.failureRecalled, total.failureSnippetEdges);
  baseline.constraintRecall = ratio(baseline.constraintRecalled, total.constraints);
  everyStep.failureRecall = ratio(everyStep.failureRecalled, total.failureSnippetEdges);
  everyStep.constraintRecall = ratio(everyStep.constraintRecalled, total.constraints);
  const savedChars = baseline.chars - everyStep.chars;
  const savedTokens = baseline.tokens - everyStep.tokens;
  const verdict = evaluatedRows.length > 0 ? decide(baseline, everyStep, savedTokens) : { decision: null, reasons: ["no evaluated session"] };
  let status = "OK";
  if (rows.length === 0) status = "NO_LOGS";
  else if (evaluatedRows.length === 0 && missingGraphSessions > 0) status = "NO_GRAPH";
  else if (evaluatedRows.length === 0) status = "READ_ERROR";
  else if (evaluatedRows.length !== rows.length) status = "PARTIAL";
  return {
    status,
    scannedSessions: rows.length,
    evaluatedSessions: evaluatedRows.length,
    missingGraphSessions,
    readErrorSessions,
    ...total,
    baseline,
    everyStep,
    savedChars,
    savedTokens,
    ...verdict,
  };
}

/** 只读扫描真实日志与 graph.json（含 delta 回放）；不返回正文、图内容或绝对路径。 */
export function scanHome(home, { limit = 10 } = {}) {
  const rows = [];
  for (const { file } of listLogs(home, limit)) {
    const sessionDirName = nodePath.basename(nodePath.dirname(file));
    const row = { session: sessionLabel(sessionDirName) };
    const graphFile = nodePath.join(home, "chess-context", "sessions", sessionDirName, "graph.json");
    if (!nodeFs.existsSync(graphFile)) {
      rows.push({ ...row, status: "MISSING_GRAPH", message: "未找到对应 graph.json，未评测" });
      continue;
    }
    try {
      const loaded = loadSessionGraph(graphFile);
      if (loaded.deltaError !== null) {
        rows.push({ ...row, status: "GRAPH_ERROR", message: "graph delta 回放失败，未评测" });
        continue;
      }
      const parsed = parseEvents(nodeFs.readFileSync(file));
      const result = evaluatePruneAB(parsed.events, loaded.graph);
      rows.push({
        ...row,
        status: "OK",
        frames: parsed.frames,
        okFrames: parsed.okFrames,
        badEventLines: parsed.badEventLines,
        deltaFrames: loaded.deltaFrames,
        warnings: loaded.badTail ? ["GRAPH_BAD_TAIL"] : [],
        ...result,
      });
    } catch {
      rows.push({ ...row, status: "READ_ERROR", message: "日志或图读取/评测失败，未评测" });
    }
  }
  const summary = summarizePruneAB(rows);
  return {
    status: summary.status,
    limit,
    tokenEstimate: { latinTokensPerChar: LATIN_TOKENS_PER_CHAR, cjkTokensPerChar: CJK_TOKENS_PER_CHAR },
    sessions: rows,
    summary,
  };
}

function pct(value) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function main(argv = process.argv.slice(2), { home = process.env.DSH_HOME ?? "", stdout = console.log, stderr = console.error } = {}) {
  const asJson = argv.includes("--json");
  const homeIndex = argv.indexOf("--home");
  const effectiveHome = homeIndex >= 0 ? String(argv[homeIndex + 1] ?? "") : String(home ?? "");
  if (effectiveHome === "" || effectiveHome.startsWith("--")) {
    if (asJson) stdout(JSON.stringify({ status: "NO_HOME", decision: null, message: "缺 DSH_HOME（或传 --home <dir>）" }, null, 2));
    else stderr("缺 DSH_HOME（或传 --home <dir>）");
    return 2;
  }
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 10;
  if (!Number.isInteger(limit) || limit <= 0) {
    if (asJson) stdout(JSON.stringify({ status: "INVALID_LIMIT", decision: null, message: "--limit 必须是正整数" }, null, 2));
    else stderr("--limit 必须是正整数");
    return 2;
  }

  const report = scanHome(effectiveHome, { limit });
  if (asJson) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    stdout(`== K-2 工具结果每步清理 · 离线 A/B（扫描 ${report.summary.scannedSessions} 份）==`);
    for (const row of report.sessions) {
      if (row.status !== "OK") {
        stdout(`  ! ${row.session}  ${row.status}：${row.message}`);
        continue;
      }
      stdout(
        `  · ${row.session}  ${row.decision} · saved ${row.savedChars} chars / ${row.savedTokens} tok` +
          ` · failure ${pct(row.baseline.failureRecall)}→${pct(row.everyStep.failureRecall)}` +
          ` · constraint ${pct(row.baseline.constraintRecall)}→${pct(row.everyStep.constraintRecall)}`,
      );
    }
    const s = report.summary;
    stdout(
      `汇总 ${s.status} · evaluated=${s.evaluatedSessions} · missingGraph=${s.missingGraphSessions}` +
        ` · saved=${s.savedChars} chars / ${s.savedTokens} tok · decision=${s.decision ?? "—"}`,
    );
    if (s.evaluatedSessions === 0) stdout("未形成评测结果：没有同时可读日志与图的会话。");
  }
  return report.summary.evaluatedSessions === 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
