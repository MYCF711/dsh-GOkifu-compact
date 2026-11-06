#!/usr/bin/env node
/**
 * archive-value-audit.mjs —— 归档补折的检索价值核算（只读 · 零模型调用）
 *
 * 归档补折发生在会话结束之后，没有后续请求可省；这里只核算它的**后续检索**。
 * 热清单注入与自动记忆注入是系统暴露，不进入「真实使用」分母。
 *
 * 真实使用只认三种可归属证据：
 *   ① 新会话 compaction/summary 中出现旧摘要独有整行，或旧图的显式树路径；
 *   ② agent 的 read/grep 工具调用在归档后指向旧图 nodes/nX.md / graph.json / lastOfflineSummary；
 *   ③ agent 发起 hindsight_* 调用后，其结果含旧摘要独有整行或旧图显式树路径。
 * 独有整行 = 规范化后 ≥48 字符、且只出现在一个归档会话的摘要正文里；共用行与裸 n1 都不算。
 *
 * 用法：node scripts/archive-value-audit.mjs [--home DIR] [--json] [--as-of ISO]
 * 退出码：0 审计完成；2 图目录/参数错误。所有输入只读，不落任何文件。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, estimateFoldCostUsd } from "../src/ui.mjs";
import { listDebts } from "../src/rooms/closeout-backfill.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { buildLogIndex } from "./range-fidelity-audit.mjs";
import { resolveSummaryText } from "./summary-usability-audit.mjs";
import { COLD_INPUT_PER_MTOK, OUTPUT_PER_MTOK, forecast, measureFromMarks, quantile } from "./backfill-forecast.mjs";

export const DEFAULT_HOME = process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
export const MIN_FINGERPRINT_CHARS = 48;
export const TASK_DEBT_SEGMENTS = 689;
export const VERDICT_RULES = Object.freeze({ minUsedSessionShare: 0.2, minUsesPerMark: 0.1, cheapUsd: 1 });
const TRUE_USE_KINDS = Object.freeze(["summary", "active", "memoryAgent"]);

export const bareSessionId = (value) => String(value ?? "").trim().toLowerCase().replace(/^session-(?=[0-9a-f]{8}-)/, "");
const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(2)}%`);
const usd = (value) => (value === null || !Number.isFinite(value) ? "—" : `$${Number(value).toFixed(4)}`);
const int = (value) => Math.max(0, Number(value) || 0).toLocaleString("en-US");

/** 四种真机 usage 形状统一为 estimateFoldCostUsd 的输入；cached 有对象与裸数两种。 */
export function normalizeUsage(usage = {}, route = {}) {
  const cached = typeof usage.cached === "number"
    ? usage.cached
    : usage.cached?.cacheReadTokens ?? usage.cached?.read ?? usage.cached_tokens;
  return {
    inputTokens: usage.inputTokens ?? usage.prompt_tokens ?? usage.input,
    cacheReadTokens: usage.cacheReadTokens ?? usage.prompt_tokens_details?.cached_tokens ?? cached ?? 0,
    outputTokens: usage.outputTokens ?? usage.completion_tokens ?? usage.output,
    totalTokens: usage.totalTokens ?? usage.total_tokens ?? usage.total,
    model: usage.model ?? route?.model,
  };
}

export function foldCost(mark) {
  const usage = normalizeUsage(mark?.usage, mark?.route);
  const value = estimateFoldCostUsd(usage, usage.model, { at: mark?.at ?? null });
  return { usage, costUsd: value };
}

export function unitCost(totalCostUsd, uses) {
  const n = Number(uses);
  const cost = Number(totalCostUsd);
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(n) || n <= 0) return null;
  return cost / n;
}

/** 只抽 chess-context/sessions/<sid>/ 下的引用；裸 graph.json / n1 一律不算。 */
export function extractTreeRefs(value) {
  const text = String(value ?? "");
  const re = /chess-context[\\/]+sessions[\\/]+((?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[\\/]+((?:nodes[\\/]+n[0-9]+\.md)|graph\.json))?/gi;
  const out = [];
  for (const match of text.matchAll(re)) {
    out.push({ source: bareSessionId(match[1]), asset: String(match[2] ?? "").toLowerCase().replaceAll("\\", "/") });
  }
  return out;
}

export function normalizeFingerprintLine(line) {
  return String(line ?? "").replace(/[\s\u00a0]+/g, " ").trim();
}

/** 从摘要正文抽可归属整行；标题、短套话、空行不进指纹库。 */
export function summaryFingerprints(text) {
  const out = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = normalizeFingerprintLine(raw);
    if (line.length < MIN_FINGERPRINT_CHARS || /^#{1,6}\s/.test(line)) continue;
    out.add(line);
  }
  return [...out];
}

/**
 * 共用行必须剔除，否则同一句模板会把几十个会话串成假使用。
 * value 可以是整段文本，也可以是 [{text, at}]；后者把指纹钉到产生它的折痕时刻，
 * 防止第一段归档之后出现的一行字，被倒算成第三段摘要的“提前使用”。
 */
export function buildFingerprintIndex(textBySource) {
  const owners = new Map();
  for (const [source, value] of textBySource) {
    const entries = typeof value === "string" ? [{ text: value, at: 0 }] : value;
    for (const entry of entries) {
      for (const line of summaryFingerprints(entry?.text)) {
        if (!owners.has(line)) owners.set(line, new Map());
        const bySource = owners.get(line);
        const key = bareSessionId(source);
        if (!bySource.has(key)) bySource.set(key, new Set());
        bySource.get(key).add(Number(entry?.at) || 0);
      }
    }
  }
  const index = new Map();
  for (const [line, bySource] of owners) {
    if (bySource.size !== 1) continue;
    const [source, ats] = [...bySource][0];
    index.set(line, { source, ats: [...ats] });
  }
  return index;
}

export function matchingSources(value, fingerprintIndex, { time = null } = {}) {
  const out = new Set();
  for (const raw of String(value ?? "").split(/\r?\n/)) {
    const owner = fingerprintIndex.get(normalizeFingerprintLine(raw));
    if (owner === undefined) continue;
    if (time !== null && !owner.ats.some((at) => at <= 0 || time > at)) continue;
    out.add(owner.source);
  }
  return out;
}

export function eventTime(event) {
  return finite(event?.time ?? event?.at ?? event?.ts);
}

export function eventText(event) {
  const data = event?.data ?? {};
  const raw = data.summary ?? data.text ?? data.content ?? data.message?.content ?? event?.summary ?? event?.content ?? "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((block) => typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "").join("\n");
  return raw === null || raw === undefined ? "" : JSON.stringify(raw);
}

function toolCallsOf(event) {
  if (event?.type === "tool/call") {
    return [{
      id: String(event?.data?.callId ?? event?.data?.id ?? ""),
      name: String(event?.data?.name ?? ""),
      arguments: typeof event?.data?.arguments === "string" ? event.data.arguments : JSON.stringify(event?.data?.arguments ?? {}),
    }];
  }
  if (event?.type !== "assistant/message") return [];
  const content = event?.data?.message?.content ?? event?.data?.content ?? event?.message?.content ?? [];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool-call").map((block) => ({
    id: String(block.id ?? ""),
    name: String(block.name ?? ""),
    arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}),
  }));
}

function afterArchive(time, source, archive, asOf) {
  const ats = archive.get(source)?.archiveAts ?? [];
  return time !== null && time <= asOf && ats.some((at) => at > 0 && time > at);
}

function matchedArchiveSources(text, fingerprintIndex, time = null) {
  const out = new Map();
  for (const ref of extractTreeRefs(text)) if (!out.has(ref.source)) out.set(ref.source, []);
  for (const source of matchingSources(text, fingerprintIndex, { time })) if (!out.has(source)) out.set(source, []);
  return out;
}

/**
 * 扫一份会话日志。返回值里的 hot / memoryAuto 是曝光，绝不是真实使用。
 * 每个 (reader, seq/callId, kind, source) 只记一次，assistant 与 tool/call 双写不会翻倍。
 */
export function scanSessionEvents(events, { readerSessionId, archive, fingerprintIndex, asOf = Date.now() } = {}) {
  const reader = bareSessionId(readerSessionId);
  const uses = [];
  const seenCalls = new Set();
  const emitted = new Set();
  const memoryCallIds = new Set();
  const countedMemoryCalls = new Set();
  let memoryCalls = 0;
  let unattributedActive = 0;
  let missingTimeCandidates = 0;
  const emit = (kind, source, event, callId = "", subkinds = []) => {
    if (!archive.has(source) || !afterArchive(eventTime(event), source, archive, asOf)) {
      if (archive.has(source) && eventTime(event) === null) missingTimeCandidates += 1;
      return;
    }
    const key = `${kind}|${reader}|${source}|${callId || `${event?.seq ?? "?"}:${eventTime(event) ?? "?"}`}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    uses.push({ kind, source, reader, time: eventTime(event), seq: event?.seq ?? null, callId, subkinds, key });
  };

  for (const event of Array.isArray(events) ? events : []) {
    for (const call of toolCallsOf(event)) {
      if (/^hindsight_/i.test(call.name)) {
        const time = eventTime(event);
        const key = call.id || `${event?.seq ?? "?"}:${call.name}:${call.arguments}`;
        if ((time === null || time <= asOf) && !countedMemoryCalls.has(key)) {
          countedMemoryCalls.add(key);
          memoryCalls += 1;
        }
        if (call.id !== "") memoryCallIds.add(call.id);
      }
    }
  }

  for (const event of Array.isArray(events) ? events : []) {
    const time = eventTime(event);
    if (time !== null && time > asOf) continue;
    const text = eventText(event);
    const kindOfMessage = String(event?.data?.source?.kind ?? event?.data?.message?.source?.kind ?? "");

    if (event?.type === "compaction/summary") {
      for (const source of matchedArchiveSources(text, fingerprintIndex, time).keys()) {
        if (source !== reader) emit("summary", source, event);
      }
      continue;
    }

    if (event?.type === "user/message" && kindOfMessage === "chess-context") {
      for (const source of matchedArchiveSources(text, fingerprintIndex, time).keys()) emit("hot", source, event);
      continue;
    }

    if (event?.type === "user/message" && /hindsight|memory-context|kifu-memory/i.test(kindOfMessage)) {
      for (const source of matchedArchiveSources(text, fingerprintIndex, time).keys()) emit("memoryAuto", source, event);
      continue;
    }

    if (event?.type === "tool/result") {
      const callId = String(event?.data?.callId ?? event?.data?.toolCallId ?? event?.data?.id ?? "");
      if (memoryCallIds.has(callId) || /^hindsight_/i.test(String(event?.data?.name ?? ""))) {
        for (const source of matchedArchiveSources(text, fingerprintIndex, time).keys()) emit("memoryAgent", source, event, callId);
      }
      continue;
    }

    for (const call of toolCallsOf(event)) {
      if (call.id !== "" && seenCalls.has(call.id)) continue;
      if (call.id !== "") seenCalls.add(call.id);
      if (/^hindsight_/i.test(call.name)) {
        // 显式查询是需求信号；只有结果真带回旧摘要才计 memoryAgent 使用。
        for (const source of matchedArchiveSources(call.arguments, fingerprintIndex, time).keys()) emit("memoryQuery", source, event, call.id);
      }
      if (!/^(read|grep)$/i.test(call.name)) continue;
      const refs = extractTreeRefs(call.arguments);
      for (const ref of refs) {
        const subkinds = [];
        if (/^nodes\/n[0-9]+\.md$/i.test(ref.asset)) subkinds.push("nodeDoc");
        if (ref.asset === "graph.json") subkinds.push("graphJson");
        if (/lastOfflineSummary/i.test(call.arguments)) subkinds.push("lastOfflineSummary");
        emit("active", ref.source, event, call.id, subkinds);
      }
      if (refs.length === 0 && /chess-context[\\/]+sessions/i.test(call.arguments) && /lastOfflineSummary/i.test(call.arguments)) {
        // 全树 grep 是真检索，但无法摊给某个源会话；单列，不进可归属分母。
        if (time !== null && time <= asOf) unattributedActive += 1;
      }
    }
  }
  return { uses, memoryCalls, unattributedActive, missingTimeCandidates };
}

export function summarizeUses(archive, allUses, { memoryCalls = 0, unattributedActive = 0 } = {}) {
  const signals = {};
  for (const kind of ["summary", "active", "hot", "memoryAgent", "memoryAuto", "memoryQuery"]) {
    const rows = allUses.filter((use) => use.kind === kind);
    signals[kind] = {
      events: rows.length,
      sourceSessions: new Set(rows.map((row) => row.source)).size,
      readerSessions: new Set(rows.map((row) => row.reader)).size,
      sourceReaderPairs: new Set(rows.map((row) => `${row.reader}|${row.source}`)).size,
      crossSessionEvents: rows.filter((row) => row.reader !== row.source).length,
    };
  }
  signals.active.nodeDoc = allUses.filter((row) => row.kind === "active" && row.subkinds.includes("nodeDoc")).length;
  signals.active.graphJson = allUses.filter((row) => row.kind === "active" && row.subkinds.includes("graphJson")).length;
  signals.active.lastOfflineSummary = allUses.filter((row) => row.kind === "active" && row.subkinds.includes("lastOfflineSummary")).length;

  const perSource = [];
  for (const [source, meta] of archive) {
    const rows = allUses.filter((use) => use.source === source && TRUE_USE_KINDS.includes(use.kind));
    const byKind = Object.fromEntries(TRUE_USE_KINDS.map((kind) => [kind, rows.filter((row) => row.kind === kind).length]));
    perSource.push({ source: meta.id, costUsd: meta.costUsd, marks: meta.marks, uses: rows.length, byKind });
  }
  perSource.sort((a, b) => b.uses - a.uses || b.costUsd - a.costUsd || a.source.localeCompare(b.source));
  const trueUses = perSource.reduce((sum, row) => sum + row.uses, 0);
  const usedSourceSessions = perSource.filter((row) => row.uses > 0).length;
  const totalCostUsd = perSource.reduce((sum, row) => sum + row.costUsd, 0);
  return {
    signals,
    memoryCalls,
    unattributedActive,
    trueUses,
    totalCostUsd,
    unitCostUsd: unitCost(totalCostUsd, trueUses),
    unitCostByKindUsd: Object.fromEntries(TRUE_USE_KINDS.map((kind) => [kind, unitCost(totalCostUsd, signals[kind].events)])),
    usedSourceSessions,
    zeroUseSessions: archive.size - usedSourceSessions,
    usedSessionShare: archive.size === 0 ? null : usedSourceSessions / archive.size,
    top1Share: trueUses === 0 ? null : (perSource[0]?.uses ?? 0) / trueUses,
    top5Share: trueUses === 0 ? null : perSource.slice(0, 5).reduce((sum, row) => sum + row.uses, 0) / trueUses,
    topSessions: perSource.slice(0, 10),
  };
}

/** 四选一判级。D 必须有独立的非检索价值证据，不能用「也许合规」冒充。 */
export function classifyVerdict({ marks, costUsd, trueUses, usedSessionShare, documentedNonRetrievalValue = false }, rules = VERDICT_RULES) {
  if (documentedNonRetrievalValue) return "D";
  const highUse = Number(usedSessionShare) >= rules.minUsedSessionShare && Number(trueUses) >= Number(marks) * rules.minUsesPerMark;
  if (highUse) return "A";
  return Number(costUsd) < rules.cheapUsd ? "B" : "C";
}

function parseArgs(argv) {
  const out = { home: DEFAULT_HOME, json: false, asOf: Date.now() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--home" && argv[i + 1]) out.home = argv[++i];
    else if (arg === "--as-of" && argv[i + 1]) {
      out.asOf = Date.parse(argv[++i]);
      if (!Number.isFinite(out.asOf)) throw new Error("--as-of 必须是可解析时间");
    } else throw new Error(`未知/缺值参数：${arg}`);
  }
  return out;
}

export function audit({ home = DEFAULT_HOME, asOf = Date.now(), includeDebt = true } = {}) {
  const scan = collectGraphFiles(home);
  if (!nodeFs.existsSync(scan.root)) throw new Error(`找不到棋谱目录：${scan.root}`);
  const graphs = new Map();
  const archive = new Map();
  const texts = new Map();
  const allMarks = [];
  const normalizedInputs = [];
  const normalizedOutputs = [];
  let graphsRead = 0;
  let graphErrors = 0;
  let usageKnown = 0;
  let marksWithText = 0;
  let fingerprintLines = 0;

  for (const entry of scan.files) {
    let graph;
    try {
      graph = loadSessionGraph(entry.file).graph;
      graphsRead += 1;
    } catch {
      graphErrors += 1;
      continue;
    }
    if (includeDebt) graphs.set(entry.dir, graph);
    const marks = (graph.foldMarks ?? []).filter((mark) => mark?.trigger === "archive-offline" && (mark?.at === null || mark?.at === undefined || Number(mark.at) <= asOf));
    if (marks.length === 0) continue;
    const source = bareSessionId(graph.sessionId ?? entry.dir);
    const meta = { id: entry.dir, latestAt: 0, archiveAts: [], marks: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    for (const mark of marks) {
      const { usage, costUsd } = foldCost(mark);
      meta.marks += 1;
      meta.latestAt = Math.max(meta.latestAt, Number(mark.at) || 0);
      if (Number(mark.at) > 0) meta.archiveAts.push(Number(mark.at));
      if (costUsd !== null) {
        usageKnown += 1;
        meta.costUsd += costUsd;
      }
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      meta.inputTokens += input + (Number(usage.cacheReadTokens) || 0);
      meta.outputTokens += output;
      normalizedInputs.push(input + (Number(usage.cacheReadTokens) || 0));
      normalizedOutputs.push(output);
      allMarks.push(mark);
      const resolved = resolveSummaryText(mark, graph.lastOfflineSummary ?? null);
      if (resolved.text) {
        marksWithText += 1;
        const entries = texts.get(source) ?? [];
        entries.push({ text: resolved.text, at: Number(mark.at) || 0 });
        texts.set(source, entries);
      }
    }
    archive.set(source, meta);
  }
  for (const entries of texts.values()) for (const entry of entries) fingerprintLines += summaryFingerprints(entry.text).length;
  const fingerprintIndex = buildFingerprintIndex(texts);

  const logIndex = buildLogIndex(home);
  const allUses = [];
  let logsRead = 0;
  let logErrors = 0;
  let memoryCalls = 0;
  let unattributedActive = 0;
  let missingTimeCandidates = 0;
  for (const [reader, file] of logIndex) {
    const events = readSessionEvents(file);
    if (events.length === 0) {
      logErrors += 1;
      continue;
    }
    logsRead += 1;
    const got = scanSessionEvents(events, { readerSessionId: reader, archive, fingerprintIndex, asOf });
    allUses.push(...got.uses);
    memoryCalls += got.memoryCalls;
    unattributedActive += got.unattributedActive;
    missingTimeCandidates += got.missingTimeCandidates;
  }

  const usageStats = summarizeUses(archive, allUses, { memoryCalls, unattributedActive });
  const totalCostUsd = [...archive.values()].reduce((sum, meta) => sum + meta.costUsd, 0);
  const medianInput = quantile(normalizedInputs, 0.5);
  const medianOutput = quantile(normalizedOutputs, 0.5);
  const typicalColdPerSegmentUsd = medianInput === null || medianOutput === null
    ? null
    : (medianInput * COLD_INPUT_PER_MTOK + medianOutput * OUTPUT_PER_MTOK) / 1e6;
  const meanActualPerSegmentUsd = allMarks.length === 0 ? null : totalCostUsd / allMarks.length;

  let debt = null;
  if (includeDebt) {
    const listed = listDebts({ sessionIds: [...graphs.keys()], loadGraph: (id) => graphs.get(id), limit: Number.MAX_SAFE_INTEGER });
    const measured = measureFromMarks(allMarks);
    measured.inputTokens = medianInput;
    const estimate = forecast({ items: listed.items, measured });
    debt = {
      sessions: listed.due,
      segments: estimate.totalSegments,
      coldCostUsd: estimate.costUsd,
      actualMeanCostUsd: estimate.totalSegments * meanActualPerSegmentUsd,
      taskBaselineSegments: TASK_DEBT_SEGMENTS,
      taskBaselineColdCostUsd: TASK_DEBT_SEGMENTS * typicalColdPerSegmentUsd,
      taskBaselineActualMeanCostUsd: TASK_DEBT_SEGMENTS * meanActualPerSegmentUsd,
    };
  }

  const verdict = classifyVerdict({ marks: allMarks.length, costUsd: totalCostUsd, trueUses: usageStats.trueUses, usedSessionShare: usageStats.usedSessionShare });
  const recommendation = verdict === "A" ? "继续" : verdict === "B" ? "降频" : verdict === "C" ? "停止自动归档补折；保留原始日志，确有查询时再按需补" : "保留（非检索价值另有证据）";
  return {
    asOf,
    home,
    coverage: { graphFiles: scan.files.length, graphsRead, graphErrors, logsFound: logIndex.size, logsRead, logErrors, fingerprintLines, uniqueFingerprintLines: fingerprintIndex.size, missingTimeCandidates },
    archive: { sessions: archive.size, marks: allMarks.length, usageKnown, marksWithText },
    cost: { totalCostUsd, meanActualPerSegmentUsd, medianInputTokens: medianInput, medianOutputTokens: medianOutput, typicalColdPerSegmentUsd, marksTimesTypicalColdUsd: allMarks.length * typicalColdPerSegmentUsd, totalInputTokens: normalizedInputs.reduce((a, b) => a + b, 0), totalOutputTokens: normalizedOutputs.reduce((a, b) => a + b, 0) },
    usage: usageStats,
    debt,
    verdict,
    recommendation,
    verdictRules: VERDICT_RULES,
    caveat: "金额是真实 usage × 路由模型 × 折叠时刻的既有价表估算，不是网关账单；未知模型按既有 priceForModel 回落。",
  };
}

export function renderReport(result) {
  const { archive: a, cost: c, usage: u, coverage: cov, debt: d } = result;
  const out = [];
  out.push("== 归档补折价值审计（只读 · 零模型调用） ==");
  out.push(`快照：${new Date(result.asOf).toISOString()} · home：${result.home}`);
  out.push(`样本：${a.sessions} 个归档会话 / ${a.marks} 条 archive-offline 折痕；图 ${cov.graphsRead}/${cov.graphFiles}，日志 ${cov.logsRead}/${cov.logsFound}（失败 ${cov.logErrors}）`);
  out.push("");
  out.push("① 成本（不与实时折叠混算）");
  out.push(`  折痕数 × 单次冷缓存中位成本：${a.marks} × ${usd(c.typicalColdPerSegmentUsd)} = ${usd(c.marksTimesTypicalColdUsd)}`);
  out.push(`  真实 usage 精算：${usd(c.totalCostUsd)}（usage 覆盖 ${a.usageKnown}/${a.marks}；均值 ${usd(c.meanActualPerSegmentUsd)}/段）`);
  out.push(`  token：输入 ${int(c.totalInputTokens)}（含 cache read）· 输出 ${int(c.totalOutputTokens)}；中位段 ${int(c.medianInputTokens)} / ${int(c.medianOutputTokens)}`);
  out.push(`  注：${result.caveat}`);
  out.push("");
  out.push("② 四种信号（事件 × 源会话去重；只计归档之后）");
  out.push("  信号                         次数   源会话   跨会话次数   总成本/次");
  const row = (label, s, cost = undefined) => out.push(`  ${label.padEnd(28)} ${String(s.events).padStart(5)}   ${String(s.sourceSessions).padStart(6)}   ${String(s.crossSessionEvents).padStart(10)}   ${cost === undefined ? "—" : usd(cost)}`);
  row("新会话 compaction/summary", u.signals.summary, u.unitCostByKindUsd.summary);
  row("agent read/grep", u.signals.active, u.unitCostByKindUsd.active);
  row("热清单 chess-context【曝光】", u.signals.hot);
  row("hindsight 结果【agent】", u.signals.memoryAgent, u.unitCostByKindUsd.memoryAgent);
  out.push(`    active 细分：nodes/nX.md ${u.signals.active.nodeDoc} · graph.json ${u.signals.active.graphJson} · lastOfflineSummary ${u.signals.active.lastOfflineSummary}；全树但无法归属 ${u.unattributedActive}`);
  out.push(`    hindsight 主动调用共 ${u.memoryCalls} 次；另有 memoryQuery ${u.signals.memoryQuery.events} / 自动记忆曝光 ${u.signals.memoryAuto.events}，均不冒充检索命中。`);
  out.push(`    摘要正文可建指纹 ${a.marksWithText}/${a.marks} 段；候选行 ${cov.fingerprintLines}，跨会话共用行剔除后 ${cov.uniqueFingerprintLines}。`);
  out.push("");
  out.push("③ 按源会话分布");
  out.push(`  有真实使用 ${u.usedSourceSessions}/${a.sessions}（${pct(u.usedSessionShare)}）· 零使用 ${u.zeroUseSessions}；Top1 / Top5 使用量占比 ${pct(u.top1Share)} / ${pct(u.top5Share)}`);
  if (u.trueUses === 0) out.push("  分布结论：基本没人用（0 次真实使用），不是少数会话反复使用。");
  else {
    out.push("  Top 源会话（真实使用次数 · 折痕 · 成本）：");
    for (const row of u.topSessions.filter((row) => row.uses > 0).slice(0, 5)) out.push(`    ${row.source} · ${row.uses} 次 · ${row.marks} 段 · ${usd(row.costUsd)}`);
  }
  out.push("");
  out.push("④ 单位成本");
  out.push(`  真实使用 = 新会话摘要 ${u.signals.summary.events} + 主动 read/grep ${u.signals.active.events} + agent 记忆命中 ${u.signals.memoryAgent.events} = ${u.trueUses} 次`);
  out.push("  热清单与自动记忆注入不计入分母；memoryQuery 没有结果命中也不计入。");
  out.push(u.unitCostUsd === null ? `  总成本 / 真实使用 = ${usd(c.totalCostUsd)} / 0 ⇒ 不可计算（分母为 0；接近纯浪费）` : `  总成本 / 真实使用 = ${usd(c.totalCostUsd)} / ${u.trueUses} = ${usd(u.unitCostUsd)}/次`);
  out.push("");
  out.push(`⑤ 判断：${result.verdict}`);
  out.push(`  规则：A=源会话使用率≥${pct(result.verdictRules.minUsedSessionShare)}且使用≥${result.verdictRules.minUsesPerMark}/段；B=非A且总成本<${usd(result.verdictRules.cheapUsd)}；C=非A且成本≥${usd(result.verdictRules.cheapUsd)}；D=另有非检索价值证据。`);
  out.push(`  证据：使用率 ${pct(u.usedSessionShare)} · ${u.trueUses}/${a.marks} 次/段 · 已花 ${usd(c.totalCostUsd)}；没有合规/审计必须生成摘要的证据，原始日志仍在。`);
  out.push("");
  out.push(`⑥ 建议：${result.recommendation}`);
  if (d) {
    out.push(`  当前真机欠账 ${d.sessions} 会话 / ${d.segments} 段：停止可避免冷缓存口径 ${usd(d.coldCostUsd)}；按历史真实均价 ${usd(d.actualMeanCostUsd)}。`);
    out.push(`  题给 689 段基准：689 × ${usd(c.typicalColdPerSegmentUsd)} = ${usd(d.taskBaselineColdCostUsd)}；按历史真实均价 = ${usd(d.taskBaselineActualMeanCostUsd)}。`);
  }
  out.push(`  已发生 ${usd(c.totalCostUsd)} 是沉没成本，不写成“可省”；停止的是后续欠账。按需补只服务真实查询，不再为无人检索的会话预付费。`);
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  try {
    const result = audit(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : renderReport(result));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
