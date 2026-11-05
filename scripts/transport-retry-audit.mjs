#!/usr/bin/env node
/**
 * transport-retry-audit.mjs —— TRANSPORT 补账失败的只读频率 / 恢复审计（T67）。
 *
 * 三类证据分开，绝不把旧 `empty-response` 全部冒充 TRANSPORT：
 *   · direct：新 closeout.foldError 本身带 TRANSPORT；
 *   · raw-stream：旧 empty-response 与 ≤1s 的同会话 assistant/attempt TRANSPORT 对上；
 *   · batch-only：原始流没有留下，但与已确认事故同处 5 分钟故障批次（只进 cohort，不进 confirmed）。
 *
 * 历史 closeout 会被后来的 done 覆盖。本脚本除当前 graph.json / delta 外，还读取
 * 会话日志中 **tool/result 保存的历史审计输出**（不是 assistant 的总结），借此恢复
 * 「当时确实是 empty-response、后来又成功」的同会话时间链。成功只认 archive-offline
 * foldMark 或 offline:done closeout。
 *
 * 分母是仍存留的 archive-offline 成功 + error/empty-response 失败；被覆盖且没有
 * 历史工具输出的失败无法恢复，所以频率是**可复核下限**，不是全知全量。
 *
 * 用法：node scripts/transport-retry-audit.mjs [--json]
 * 边界：只读；不写图、不写状态、不调模型、不重启。日期一律 UTC。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath } from "node:url";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";

const DAY = 86_400_000;
const RAW_LINK_MS = 1_000;
const BATCH_MS = 300_000;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function dayOf(at) {
  return new Date(Number(at)).toISOString().slice(0, 10);
}

function pct(n, d) {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—";
}

function quantiles(values) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0, min: null, p50: null, p90: null, max: null };
  const at = (p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  return { n: xs.length, min: xs[0], p50: at(0.5), p90: at(0.9), max: xs.at(-1) };
}

function minutes(ms) {
  return Number.isFinite(ms) ? `${(ms / 60_000).toFixed(1)}m` : "—";
}

function toolText(event) {
  if (event?.type !== "tool/result") return "";
  const content = event?.data?.message?.content;
  return Array.isArray(content) ? content.map((b) => String(b?.text ?? "")).join("\n") : "";
}

/** 从 empty-response-audit 的 tool/result 原文恢复当时的 closeout；assistant 总结一律不认。 */
export function historicalCloseouts(event) {
  const text = toolText(event);
  if (!text.includes("closeout {") || !/offline:(?:empty-response|error)/.test(text)) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("closeout {")) continue;
    const id = lines[i - 1].trim();
    if (!/^(?:session-)?[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) continue;
    try {
      const c = JSON.parse(line.slice("closeout ".length));
      const at = Number(c.foldAt ?? c.at);
      if (!Number.isFinite(at) || !/^offline:(?:empty-response|error)$/.test(String(c.foldNote ?? ""))) continue;
      out.push({ id, at, note: c.foldNote, error: String(c.foldError ?? ""), origin: "historical-tool-result", evidenceAt: Number(event.time) || null });
    } catch {
      /* 半行 / 被截断的工具输出跳过 */
    }
  }
  return out;
}

function transportAttempt(event) {
  if (event?.type !== "assistant/attempt") return null;
  const stream = Array.isArray(event?.data?.stream) ? event.data.stream : [];
  let transport = false;
  let usage = null;
  for (const part of stream) {
    const chunk = part?.chunk ?? {};
    if (chunk.type === "usage") usage = chunk.usage ?? null;
    if (chunk.type !== "finish") continue;
    const reason = chunk.reason ?? chunk.finish ?? {};
    const failure = reason?.failure ?? reason?.reason?.failure ?? {};
    if (String(failure?.code ?? "").toUpperCase() === "TRANSPORT") transport = true;
  }
  if (!transport) return null;
  return { at: Number(event.time), seq: Number(event.seq) || null, usage };
}

function currentGraphRecords(root) {
  const sessions = new Map();
  const closeouts = [];
  const successes = [];
  let graphDirs = 0;
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    graphDirs += 1;
    const id = entry.name;
    const graphFile = nodePath.join(root, id, "graph.json");
    const graph = readJson(graphFile, null);
    const records = [];
    if (graph !== null) records.push(graph);
    const deltaFile = `${graphFile}.delta.jsonl`;
    if (nodeFs.existsSync(deltaFile)) {
      for (const line of nodeFs.readFileSync(deltaFile, "utf8").split("\n")) {
        if (line === "") continue;
        try {
          const first = line.indexOf("\t");
          const second = line.indexOf("\t", first + 1);
          const frame = JSON.parse(line.slice(second + 1));
          if (frame?.scalars && typeof frame.scalars === "object") records.push(frame.scalars);
        } catch {
          /* 坏 delta 行不影响其它证据 */
        }
      }
    }
    const session = { id, closeouts: [], successes: [] };
    const seenCloseout = new Set();
    const seenSuccess = new Set();
    for (const record of records) {
      const c = record?.closeout;
      const at = Number(c?.foldAt);
      if (Number.isFinite(at) && typeof c?.foldNote === "string") {
        const key = `${at}|${c.foldNote}|${c.foldError ?? ""}`;
        if (!seenCloseout.has(key)) {
          seenCloseout.add(key);
          const row = { id, at, note: c.foldNote, error: String(c.foldError ?? ""), origin: "graph" };
          session.closeouts.push(row);
          closeouts.push(row);
        }
        if (c.foldNote === "offline:done") {
          const key = `done|${at}`;
          if (!seenSuccess.has(key)) {
            seenSuccess.add(key);
            const row = { id, at, origin: "closeout" };
            session.successes.push(row);
            successes.push(row);
          }
        }
      }
      for (const mark of Array.isArray(record?.foldMarks) ? record.foldMarks : []) {
        const atMark = Number(mark?.at);
        if (mark?.trigger !== "archive-offline" || !Number.isFinite(atMark)) continue;
        const key = `${atMark}|${mark.seqStart ?? ""}|${mark.seqEnd ?? ""}`;
        if (seenSuccess.has(key)) continue;
        seenSuccess.add(key);
        const row = { id, at: atMark, origin: "foldMark", ms: Number(mark.ms) || null };
        session.successes.push(row);
        successes.push(row);
      }
    }
    sessions.set(id, session);
  }
  return { graphDirs, sessions, closeouts, successes };
}

/** 同一份成功可能同时有 foldMark 与 closeout；分母只计一次（1s 内视为同次）。 */
function dedupeSuccesses(rows) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id) || a.at - b.at || a.origin.localeCompare(b.origin));
  const out = [];
  for (const row of sorted) {
    const prev = out.at(-1);
    if (prev !== undefined && prev.id === row.id && Math.abs(prev.at - row.at) <= 1_000) {
      if (prev.origin !== "foldMark" && row.origin === "foldMark") out[out.length - 1] = row;
      continue;
    }
    out.push(row);
  }
  return out;
}

export async function audit(home) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const current = currentGraphRecords(root);
  const historical = [];
  const transportBySession = new Map();
  const logs = listSessionLogs(home);
  let rawTransportAttempts = 0;
  for (const file of logs) {
    const id = nodePath.basename(nodePath.dirname(file));
    for (const event of readSessionEvents(file)) {
      const attempt = transportAttempt(event);
      if (attempt !== null && Number.isFinite(attempt.at)) {
        rawTransportAttempts += 1;
        if (!transportBySession.has(id)) transportBySession.set(id, []);
        transportBySession.get(id).push(attempt);
      }
      historical.push(...historicalCloseouts(event));
    }
  }

  const candidates = new Map();
  for (const row of [...current.closeouts, ...historical]) {
    if (row.note !== "offline:error" && row.note !== "offline:empty-response") continue;
    const key = `${row.id}|${row.at}|${row.note}`;
    if (!candidates.has(key)) candidates.set(key, row);
  }

  const confirmed = [];
  const unverified = [];
  for (const row of candidates.values()) {
    if (row.note === "offline:error" && /TRANSPORT/i.test(row.error)) {
      confirmed.push({ ...row, verification: "direct" });
      continue;
    }
    if (row.note !== "offline:empty-response") continue;
    const nearest = (transportBySession.get(row.id) ?? [])
      .map((a) => ({ ...a, distance: Math.abs(a.at - row.at) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest !== undefined && nearest.distance <= RAW_LINK_MS) {
      confirmed.push({ ...row, verification: "raw-stream", raw: nearest });
    } else {
      unverified.push(row);
    }
  }

  const cohort = [...confirmed];
  for (const row of unverified) {
    const near = confirmed.some((c) => Math.abs(c.at - row.at) <= BATCH_MS);
    if (near) cohort.push({ ...row, verification: "batch-only" });
  }
  cohort.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const successes = dedupeSuccesses(current.successes);
  const recovered = [];
  for (const incident of cohort) {
    const success = successes
      .filter((s) => s.id === incident.id && s.at > incident.at)
      .sort((a, b) => a.at - b.at)[0];
    if (success !== undefined) recovered.push({ ...incident, successAt: success.at, recoveryMs: success.at - incident.at, successOrigin: success.origin });
  }

  const failures = [...candidates.values()];
  const days = new Map();
  const bucket = (at) => {
    const day = dayOf(at);
    if (!days.has(day)) days.set(day, { day, success: 0, failures: 0, confirmed: 0, batchOnly: 0, recovered: 0 });
    return days.get(day);
  };
  for (const row of successes) bucket(row.at).success += 1;
  for (const row of failures) bucket(row.at).failures += 1;
  for (const row of cohort) bucket(row.at)[row.verification === "batch-only" ? "batchOnly" : "confirmed"] += 1;
  for (const row of recovered) bucket(row.at).recovered += 1;

  return {
    home,
    generatedAt: new Date().toISOString(),
    graphs: current.graphDirs,
    logs: logs.length,
    rawTransportAttempts,
    candidates: candidates.size,
    excludedLegacy: unverified.length - cohort.filter((r) => r.verification === "batch-only").length,
    confirmed,
    cohort,
    recovered,
    recoveryMs: quantiles(recovered.map((r) => r.recoveryMs)),
    confirmedRecoveryMs: quantiles(recovered.filter((r) => r.verification !== "batch-only").map((r) => r.recoveryMs)),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    successes: successes.length,
    failures: failures.length,
  };
}

function print(report) {
  console.log("== TRANSPORT 补账重试只读审计（UTC；不发模型请求）==");
  console.log(`DSH_HOME ${report.home}`);
  console.log(`证据面：graph ${report.graphs} 张 · 会话日志 ${report.logs} 份 · 原始 TRANSPORT attempt ${report.rawTransportAttempts} 次（宿主内部 retry 不折算成折叠次数）`);
  console.log(`旧 empty-response 候选 ${report.candidates} 条；批次外且无法核验、已排除 ${report.excludedLegacy} 条`);
  console.log("");
  console.log("① 频率（分母 = 存留的 archive-offline 成功 + error/empty-response 失败；被覆盖且无历史工具输出的失败不可恢复）");
  console.log("日期(UTC)    成功  失败  TRANSPORT确认  同批次补入  合计  占折叠结局  后来成功");
  for (const d of report.days) {
    const transport = d.confirmed + d.batchOnly;
    const denominator = d.success + d.failures;
    console.log(`${d.day}  ${String(d.success).padStart(4)}  ${String(d.failures).padStart(4)}  ${String(d.confirmed).padStart(12)}  ${String(d.batchOnly).padStart(10)}  ${String(transport).padStart(4)}  ${pct(transport, denominator).padStart(10)}  ${String(d.recovered).padStart(8)}`);
  }
  console.log(`合计：成功 ${report.successes} · 失败 ${report.failures} · TRANSPORT confirmed ${report.confirmed.length} · cohort ${report.cohort.length}`);
  console.log("");
  console.log("② 可恢复比例（同会话、失败之后才出现的 archive-offline foldMark / offline:done）");
  console.log(`confirmed：${report.recovered.filter((r) => r.verification !== "batch-only").length}/${report.confirmed.length} = ${pct(report.recovered.filter((r) => r.verification !== "batch-only").length, report.confirmed.length)}`);
  console.log(`cohort（含 batch-only）：${report.recovered.length}/${report.cohort.length} = ${pct(report.recovered.length, report.cohort.length)}`);
  for (const r of report.recovered) {
    console.log(`  ${r.id} · ${new Date(r.at).toISOString()} → ${new Date(r.successAt).toISOString()} · ${minutes(r.recoveryMs)} · ${r.verification} · ${r.successOrigin}`);
  }
  console.log("");
  console.log("③ 恢复时间分布（失败后到第一次同会话成功）");
  console.log(`confirmed n=${report.confirmedRecoveryMs.n} · min ${minutes(report.confirmedRecoveryMs.min)} · p50 ${minutes(report.confirmedRecoveryMs.p50)} · p90 ${minutes(report.confirmedRecoveryMs.p90)} · max ${minutes(report.confirmedRecoveryMs.max)}`);
  console.log(`cohort    n=${report.recoveryMs.n} · min ${minutes(report.recoveryMs.min)} · p50 ${minutes(report.recoveryMs.p50)} · p90 ${minutes(report.recoveryMs.p90)} · max ${minutes(report.recoveryMs.max)}`);
  const latestDay = report.cohort.length > 0 ? dayOf(Math.max(...report.cohort.map((r) => r.at))) : null;
  const latestCount = latestDay === null ? 0 : report.cohort.filter((r) => dayOf(r.at) === latestDay).length;
  const rate = report.cohort.length > 0 ? report.recovered.length / report.cohort.length : 0;
  console.log(`公式估计（最近事故日频率 × cohort 可恢复比例）：${latestCount} × ${report.recovered.length}/${report.cohort.length} = ${(latestCount * rate).toFixed(2)} 段/事故日`);
  console.log("注意：这是自然恢复率外推的上界，不是 30–120s 内重试的已证收益；恢复若长于 fold deadline，仍只能由后续 tick 救回。");
}

async function main() {
  const home = process.env.DSH_HOME ?? nodePath.join(nodeOs.homedir(), ".dsh");
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) {
    console.error(`✗ 棋谱目录不存在：${root}`);
    process.exitCode = 2;
    return;
  }
  const report = await audit(home);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
