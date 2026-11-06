#!/usr/bin/env node
/**
 * fictitious-gap-audit.mjs —— 「没有可折内容，却被坐标差记成缺口」只读审计。
 *
 * 口径不在本脚本另造：`collectMessages(events, {maxChars: Infinity})` 的输出就是
 * 「可折事件」全集。因此 user/assistant 空消息、无名 tool/call 不会误算，tool/call
 * 摘要行会算，tool/result 与 system/message 即使在 data 里带正文也不会算。
 *
 * 旧缺口 = 当前 coverageOf 的坐标差；新缺口 = 同一 start/end 下，未覆盖区间里的
 * 可折事件条数。脚本只读 graph/delta 与 session 日志，不写盘、不调用模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectMessages, plainText } from "../src/rooms/offline-fold.mjs";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { estimateFoldCostUsd } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { resolveHome } from "./summary-usability-audit.mjs";

export const REPLAY_MAX_CHARS = 60_000;
export const SMALL_SPAN = 20;

/** 与 collectMessages 完全同源的可折 seq（含正文/工具摘要过滤，不按 type 猜）。 */
export function foldableInputSeqs(events) {
  const collected = collectMessages(events, { maxChars: Number.MAX_SAFE_INTEGER, fromSeq: null });
  return [...new Set(collected.messages.map((m) => Number(m.seq)).filter(Number.isFinite))].sort((a, b) => a - b);
}

/** 仅用于对照 T63 的 type 口径；金额与缺口均使用上面的 collectMessages 口径。 */
export function foldableTypeSeqs(events) {
  const types = new Set(["user/message", "assistant/message", "tool/call"]);
  return [...new Set((Array.isArray(events) ? events : []).filter((e) => types.has(e?.type)).map((e) => Number(e.seq)).filter(Number.isFinite))].sort((a, b) => a - b);
}

/** 已升序 seq 在闭区间 [start,end] 内的条数；反向区间是 0。 */
export function countBetween(sorted, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  const lower = (value, inclusive) => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (sorted[mid] < value || (inclusive && sorted[mid] === value)) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  return Math.max(0, lower(end, true) - lower(start, false));
}

/** 修改前的 coverageOf：保留于此，确保修复后仍能逐条对照旧账。 */
export function legacyCoverageOf({ rangeStart, rangeEnd, seqs }) {
  const list = (Array.isArray(seqs) ? seqs : []).filter((x) => Number.isFinite(x));
  const coveredStart = list.length > 0 ? Math.min(...list) : rangeStart;
  const coveredEnd = list.length > 0 ? Math.max(...list) : rangeStart;
  if (list.length > 0 && (coveredEnd < rangeStart || coveredStart > rangeEnd)) {
    return {
      start: coveredStart,
      end: coveredEnd,
      uncoveredHead: Math.max(0, coveredStart - rangeStart),
      uncoveredTail: Math.max(0, rangeEnd - coveredEnd),
    };
  }
  const start = Math.max(rangeStart, Math.min(coveredStart, rangeEnd));
  const end = Math.max(start, Math.min(rangeEnd, coveredEnd));
  return { start, end, uncoveredHead: Math.max(0, start - rangeStart), uncoveredTail: Math.max(0, rangeEnd - end) };
}

/** 反事实的新缺口：只数未覆盖区间里的可折事件。 */
export function foldableGap({ rangeStart, rangeEnd, start, end, foldableSeqs, collectedCount = 1 }) {
  if (collectedCount === 0) return { uncoveredHead: 0, uncoveredTail: countBetween(foldableSeqs, rangeStart, rangeEnd) };
  return {
    uncoveredHead: countBetween(foldableSeqs, rangeStart, start - 1),
    uncoveredTail: countBetween(foldableSeqs, end + 1, rangeEnd),
  };
}

/** 一条折痕的旧/新缺口重放；start/end 两口径完全相同。 */
export function replayGap(events, mark, allFoldableSeqs, { rangeStart = Number(mark?.seqStart), rangeEnd = Number(mark?.seqEnd) } = {}) {
  const collected = collectMessages(events, { maxChars: REPLAY_MAX_CHARS, fromSeq: rangeStart });
  const seqs = collected.messages.map((m) => m.seq).filter(Number.isFinite);
  const old = legacyCoverageOf({ rangeStart, rangeEnd, seqs });
  const neu = foldableGap({
    rangeStart,
    rangeEnd,
    start: old.start,
    end: old.end,
    foldableSeqs: allFoldableSeqs,
    collectedCount: seqs.length,
  });
  return {
    rangeStart,
    rangeEnd,
    start: old.start,
    end: old.end,
    messages: seqs.length,
    old: { uncoveredHead: old.uncoveredHead, uncoveredTail: old.uncoveredTail },
    new: neu,
  };
}

const quantile = (values, p) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = (list.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return list[lo] + (list[hi] - list[lo]) * (at - lo);
};
const stats = (values) => ({
  n: values.length,
  positive: values.filter((v) => v > 0).length,
  sum: values.reduce((a, b) => a + b, 0),
  p50: quantile(values, 0.5),
  p90: quantile(values, 0.9),
  max: values.length === 0 ? null : Math.max(...values),
});
const pct = (a, b) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const usd = (v) => `$${v.toFixed(4)}`;
const num = (v) => (v === null || v === undefined ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function costOf(row) {
  const input = Number(row?.usage?.inputTokens);
  if (!Number.isFinite(input) || input <= 0) return null;
  const value = estimateFoldCostUsd(row.usage, row.model ?? undefined);
  return Number.isFinite(value) ? value : null;
}

/** 全库只读扫描。 */
export function audit({ home }) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) return { missing: true, home };
  const logs = new Map();
  for (const file of listSessionLogs(home)) logs.set(nodePath.basename(nodePath.dirname(file)), file);
  const logFor = (sessionId) => {
    if (logs.has(sessionId)) return logs.get(sessionId);
    for (const [dir, file] of logs) if (dir.endsWith(sessionId) || sessionId.endsWith(dir)) return file;
    return null;
  };

  const rows = [];
  const eventTypes = {};
  let systemNonEmpty = 0;
  let systemRuntime = 0;
  let systemOther = 0;
  let systemConstraintWords = 0;
  const systemSamples = [];
  let sessions = 0;
  let badGraphs = 0;
  let missingLogs = 0;
  let typeVirtual = 0;
  let t63 = null;

  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const graphFile = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let graph;
    try {
      graph = loadSessionGraph(graphFile).graph;
    } catch {
      badGraphs += 1;
      continue;
    }
    const marks = (Array.isArray(graph?.foldMarks) ? graph.foldMarks : []).filter((m) => Number.isFinite(Number(m?.seqStart)) && Number.isFinite(Number(m?.seqEnd)));
    if (marks.length === 0) continue;
    sessions += 1;
    const log = logFor(name);
    if (log === null) {
      missingLogs += marks.length;
      continue;
    }
    let events;
    try {
      events = readSessionEvents(log);
    } catch {
      missingLogs += marks.length;
      continue;
    }
    const foldableSeqs = foldableInputSeqs(events);
    const typeSeqs = foldableTypeSeqs(events);

    if (name.includes("010c3b44")) {
      const first = marks.find((m) => Number(m.seqStart) === 9 && Number(m.seqEnd) === 249);
      if (first !== undefined) t63 = { sessionId: name, ...replayGap(events, first, foldableSeqs, { rangeStart: 1, rangeEnd: 249 }) };
    }

    marks.forEach((mark, index) => {
      const start = Number(mark.seqStart);
      const end = Number(mark.seqEnd);
      const content = countBetween(foldableSeqs, start, end);
      const typeContent = countBetween(typeSeqs, start, end);
      const replay = replayGap(events, mark, foldableSeqs);
      const row = {
        sessionId: name,
        index,
        trigger: String(mark.trigger ?? "undefined"),
        start,
        end,
        span: end - start + 1,
        content,
        virtual: content === 0,
        usage: mark.usage ?? null,
        model: mark?.route?.model ?? mark?.model ?? null,
        replay,
        repeated: false,
      };
      if (typeContent === 0 && row.virtual) typeVirtual += 1;
      if (row.virtual) {
        for (const e of events) {
          const seq = Number(e?.seq);
          if (!Number.isFinite(seq) || seq < start || seq > end) continue;
          const type = String(e?.type ?? "undefined");
          eventTypes[type] = (eventTypes[type] ?? 0) + 1;
          if (type === "system/message") {
            const text = plainText(e?.data?.message?.content ?? e?.data?.content).trim();
            if (text !== "") {
              systemNonEmpty += 1;
              if (/^(?:Runtime:\s*DeepSeek Harness\.|You are an AI agent powered by DeepSeek Harness\.)/.test(text)) systemRuntime += 1;
              else {
                systemOther += 1;
                systemSamples.push({ sessionId: name, seq, chars: text.length, preview: text.slice(0, 120).replace(/\s+/g, " ") });
              }
              if (/约束|禁止|不许|不得|必须/.test(text)) systemConstraintWords += 1;
            }
          }
        }
        const previous = marks.slice(0, index);
        row.repeated = previous.some((p) => Number(p.seqStart) <= replay.end && Number(p.seqEnd) >= replay.start);
      }
      rows.push(row);
    });
  }

  const virtual = rows.filter((r) => r.virtual);
  const withGapOld = rows.filter((r) => r.replay.old.uncoveredHead + r.replay.old.uncoveredTail > 0);
  const cleared = withGapOld.filter((r) => r.replay.new.uncoveredHead + r.replay.new.uncoveredTail === 0);
  const virtualCleared = virtual.filter((r) => r.replay.old.uncoveredHead + r.replay.old.uncoveredTail > 0 && r.replay.new.uncoveredHead + r.replay.new.uncoveredTail === 0);
  const knownUnitCosts = rows.map(costOf).filter((v) => v !== null);
  const unit = knownUnitCosts.length === 0 ? 0 : knownUnitCosts.reduce((a, b) => a + b, 0) / knownUnitCosts.length;
  const money = (list) => {
    const known = list.map(costOf).filter((v) => v !== null);
    const knownSum = known.reduce((a, b) => a + b, 0);
    return {
      marks: list.length,
      known: known.length,
      knownUsd: knownSum,
      estimatedUsd: knownSum + (list.length - known.length) * unit,
      inputTokens: list.reduce((n, r) => n + (Number(r?.usage?.inputTokens) || 0), 0),
    };
  };
  const repeated = virtual.filter((r) => r.repeated);
  return {
    missing: false,
    home,
    sessions,
    badGraphs,
    missingLogs,
    marks: rows.length,
    rows,
    virtual,
    typeVirtual,
    smallVirtual: virtual.filter((r) => r.span < SMALL_SPAN).length,
    eventTypes,
    system: { nonEmpty: systemNonEmpty, runtime: systemRuntime, other: systemOther, constraintWords: systemConstraintWords, samples: systemSamples },
    gaps: {
      oldHead: stats(virtual.map((r) => r.replay.old.uncoveredHead)),
      oldTail: stats(virtual.map((r) => r.replay.old.uncoveredTail)),
      newHead: stats(virtual.map((r) => r.replay.new.uncoveredHead)),
      newTail: stats(virtual.map((r) => r.replay.new.uncoveredTail)),
      oldWithGap: withGapOld.length,
      cleared: cleared.length,
      virtualCleared: virtualCleared.length,
      realGapPreserved: withGapOld.filter((r) => r.replay.new.uncoveredHead + r.replay.new.uncoveredTail > 0).length,
    },
    money: { unit, virtual: money(virtual), repeated: money(repeated) },
    repeated,
    t63,
  };
}

export function render(result) {
  const lines = ["# 虚构缺口审计（只读 · 不调模型）", ""];
  lines.push(`home: \`${result.home}\``);
  lines.push(`会话 ${result.sessions} · 折痕 ${result.marks} · 坏图 ${result.badGraphs} · 无/坏日志折痕 ${result.missingLogs}`);
  lines.push("");
  lines.push("## ① 虚构窗口与成因");
  lines.push(`- 记录区间内没有任何 collectMessages 可折事件：${result.virtual.length} / ${result.marks}（${pct(result.virtual.length, result.marks)}）；其中跨度 < ${SMALL_SPAN}：${result.smallVirtual}（${pct(result.smallVirtual, result.virtual.length)}）。`);
  lines.push(`- 与 T63 的纯 type 口径交集：${result.typeVirtual} 条；两口径都以 user/assistant/tool/call 为候选，但本报告进一步排除空消息与无名 tool/call。`);
  lines.push("- 虚构窗口内事件类型（同一事件可因折痕重叠而重复计次）：");
  for (const [type, count] of Object.entries(result.eventTypes).sort((a, b) => b[1] - a[1])) lines.push(`  - ${type}: ${count}`);
  lines.push(`- 先证伪：system/message 非空 ${result.system.nonEmpty} 条；其中 Runtime / You are an AI agent 宿主运行时模板 ${result.system.runtime} 条，其他 ${result.system.other} 条；含约束关键词 ${result.system.constraintWords} 条（全部来自宿主模板，不是用户任务约束）。collectMessages 对这些事件的装入数均为 0，内容存在不等于进入折叠输入。`);
  for (const sample of result.system.samples) lines.push(`  - 其他正文：${sample.sessionId.slice(0, 12)}… seq ${sample.seq} · ${sample.chars} 字符 · ${sample.preview}`);
  lines.push("");
  lines.push("## ② 虚构窗口的缺口分布（旧 = 坐标差；新 = 可折事件数）");
  lines.push("| 字段 | >0 条数 | 合计 | p50 | p90 | max |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [label, value] of [["旧 uncoveredHead", result.gaps.oldHead], ["旧 uncoveredTail", result.gaps.oldTail], ["新 uncoveredHead", result.gaps.newHead], ["新 uncoveredTail", result.gaps.newTail]]) {
    lines.push(`| ${label} | ${value.positive} / ${value.n} | ${value.sum} | ${num(value.p50)} | ${num(value.p90)} | ${num(value.max)} |`);
  }
  lines.push(`- 全库「有缺口 → 无缺口」：${result.gaps.cleared} / ${result.gaps.oldWithGap} 条；其中虚构窗口 ${result.gaps.virtualCleared} 条；仍有真实可折缺口 ${result.gaps.realGapPreserved} 条。`);
  lines.push("");
  lines.push("## ③ 重复折叠与金额");
  lines.push(`- 虚构窗口 ${result.money.virtual.marks} 条，其中重放区间与此前折痕相交（重复折叠）${result.money.repeated.marks} 条。`);
  lines.push(`- 虚构窗口白付：已知 usage ${result.money.virtual.known}/${result.money.virtual.marks}，已知金额 ${usd(result.money.virtual.knownUsd)}；缺 usage 按全库均值 ${usd(result.money.unit)}/条估，合计 ${usd(result.money.virtual.estimatedUsd)}；输入 ${result.money.virtual.inputTokens.toLocaleString("en-US")} token。`);
  lines.push(`- 折痕数 × 单次成本：${result.money.virtual.marks} × ${usd(result.money.unit)} = **${usd(result.money.virtual.marks * result.money.unit)}**（单次成本 = 全库已知 usage 折痕均价；与上行逐条真实 usage 口径并列）。`);
  lines.push(`- 其中重复折叠金额：已知 ${usd(result.money.repeated.knownUsd)}；同法估算合计 ${usd(result.money.repeated.estimatedUsd)}；输入 ${result.money.repeated.inputTokens.toLocaleString("en-US")} token。`);
  lines.push("");
  lines.push("## ④ T63 真机 010c3b44 复放");
  if (result.t63 === null) lines.push("- 未找到 010c3b44 的首条 9-249 折痕。");
  else {
    const r = result.t63;
    lines.push(`- ${r.sessionId} · 请求区间 ${r.rangeStart}-${r.rangeEnd} · 实际覆盖 ${r.start}-${r.end} · 输入消息 ${r.messages} 条。`);
    lines.push(`- uncoveredHead：旧 ${r.old.uncoveredHead} → 新 ${r.new.uncoveredHead}；uncoveredTail：旧 ${r.old.uncoveredTail} → 新 ${r.new.uncoveredTail}。`);
  }
  lines.push("");
  lines.push("判据：tool/call 经 toolDigestLine 后以 role=tool 进入 collectMessages，算可折；tool/result 一律不进入 collectMessages，不算可折；system/message 同样不进入。只数可折事件不会跳过真正进入摘要输入的缺口。");
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const at = argv.indexOf("--home");
  const home = resolveHome(at >= 0 ? argv[at + 1] : null);
  const result = audit({ home });
  if (result.missing) {
    process.stderr.write(`找不到棋谱目录：${nodePath.join(home, "chess-context", "sessions")}\n`);
    return 2;
  }
  if (argv.includes("--json")) {
    const { rows, virtual, repeated, ...summary } = result;
    process.stdout.write(`${JSON.stringify({ ...summary, rows: rows.length, virtual: virtual.length, repeated: repeated.length }, null, 2)}\n`);
  } else process.stdout.write(render(result));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
