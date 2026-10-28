/**
 * measure-billing.mjs —— **真实计费口径**审计（不是模拟）
 *
 * 为什么要有这个工具：项目里唯一还挂着「只有模拟口径」标签的指标就是省了多少钱。
 * 模拟靠假设（每步多少 token、压缩比多少），而 DSH 会话日志里其实有**每一次请求的真实 usage**：
 *
 *   assistant/message.data.usage = { inputTokens, outputTokens, totalTokens, cacheReadTokens }
 *   · prompt  = inputTokens + cacheReadTokens
 *   · 未缓存  = inputTokens          （真正按原价计费的部分）
 *   · 缓存命中 = cacheReadTokens     （按缓存价计费 —— 所以「省 token」不等于「省钱」）
 *
 * 本工具把四件事算清楚：
 *   1. 真实 prompt 规模与**缓存命中率**（缓存让「历史」的边际成本远低于名义 token 数）
 *   2. 热清单自己占了多少 prompt（含「陈旧副本」占多少 —— 那是 P1-4 修掉的浪费）
 *   3. 每次 fold 的收支：遮蔽多少 token → 换成多少 token 的 checkpoint × 之后还有多少次请求
 *   4. 汇总成 json，便于和 magpie 的 usage.jsonl 对账
 *
 * 用法：
 *   node test/measure-billing.mjs [sessionDir...]        # 省略=扫描 DSH_HOME 下全部会话
 *   node test/measure-billing.mjs --json <out.json>
 *
 * 依赖：解压 .zstd 多帧用 python + zstandard（node 的 zlib 只解第一帧；本机 python 有 zstandard）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
const dirs = args.filter((a) => !a.startsWith("--") && a !== jsonOut);

function sessionsRoot() {
  return nodePath.join(process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh"), "sessions");
}

/** 递归找所有 session.v4.jsonl.zstd */
function findSessionFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name === "session.v4.jsonl.zstd") out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

const PY_DECOMPRESS = `
import sys, zstandard
with open(sys.argv[1], 'rb') as f:
    sys.stdout.buffer.write(zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True).read())
`;

function readEvents(file) {
  const buf = execFileSync("python", ["-c", PY_DECOMPRESS, file], { maxBuffer: 512 * 1024 * 1024 });
  const events = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return events;
}

const approxTokens = (chars) => Math.ceil(chars / 3);
const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

function textChars(message) {
  const content = message?.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) if (block && typeof block.text === "string") n += block.text.length;
  return n;
}

/** 一条消息（事件）在 surface 上占多少字符（用于估算 token）。 */
function eventChars(event) {
  if (event.type === "tool/result") return textChars(event.data?.message);
  if (event.type === "system/message") return textChars(event.data?.message);
  return textChars(event.data);
}

export function auditSession(file) {
  const events = readEvents(file);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const surface = [];
  const row = {
    session: nodePath.basename(nodePath.dirname(file)),
    events: events.length,
    requests: 0,
    promptTokens: 0,
    uncachedPromptTokens: 0,
    cachedPromptTokens: 0,
    outputTokens: 0,
    ledgerPromptTokens: 0,
    staleLedgerPromptTokens: 0,
    currentLedgerPromptTokens: 0,
    checkpoints: 0,
    folds: { attempts: 0, ok: 0, failed: 0, shadowedTokens: 0, summaryTokens: 0, requestsAfterFolds: 0 },
    ledgerEvents: { append: 0, replace: 0, stub: 0 },
    maxLedgerNodes: 0,
  };

  for (const event of events) {
    const type = event.type;
    if (type === "compaction/start") row.folds.attempts += 1;
    if (type === "compaction/end") {
      if (event.data?.error) row.folds.failed += 1;
      else row.folds.ok += 1;
    }

    // 请求：记录当时的 surface 组成
    if (type === "assistant/message" && event.data?.usage) {
      const u = event.data.usage;
      const prompt = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
      row.requests += 1;
      row.promptTokens += prompt;
      row.uncachedPromptTokens += u.inputTokens ?? 0;
      row.cachedPromptTokens += u.cacheReadTokens ?? 0;
      row.outputTokens += u.outputTokens ?? 0;
      const ledgers = surface.filter((seq) => {
        const e = bySeq.get(seq);
        return e?.type === "user/message" && e.data?.source?.kind === "chess-context";
      });
      let ledgerChars = 0;
      let staleChars = 0;
      ledgers.forEach((seq, i) => {
        const chars = eventChars(bySeq.get(seq));
        ledgerChars += chars;
        if (i < ledgers.length - 1) staleChars += chars;
      });
      row.ledgerPromptTokens += approxTokens(ledgerChars);
      row.staleLedgerPromptTokens += approxTokens(staleChars);
      row.currentLedgerPromptTokens += approxTokens(ledgerChars - staleChars);
      row.maxLedgerNodes = Math.max(row.maxLedgerNodes, ledgers.length);
      if (row.folds.ok > 0) row.folds.requestsAfterFolds += 0; // 下面统一算
    }

    // 更新 surface（append / replace）
    if (SURFACE_TYPES.has(type)) {
      const op = event.surfaceOp;
      if (op === "append") surface.push(event.seq);
      else if (op && op.op === "replace") {
        const startIdx = surface.indexOf(op.startSeq);
        const endIdx = surface.indexOf(op.endSeq);
        if (startIdx >= 0 && endIdx >= startIdx) {
          const shadowedSeqs = surface.slice(startIdx, endIdx + 1);
          // fold 的 replace：被遮蔽的是一段历史，换成 checkpoint
          if (type === "user/message" && event.data?.source?.kind === "compact-checkpoint") {
            let shadowedChars = 0;
            for (const seq of shadowedSeqs) shadowedChars += eventChars(bySeq.get(seq) ?? {});
            row.folds.shadowedTokens += approxTokens(shadowedChars);
            row.folds.summaryTokens += approxTokens(eventChars(event));
            row.checkpoints += 1;
          }
          surface.splice(startIdx, endIdx - startIdx + 1, event.seq);
        }
      }
      if (type === "user/message" && event.data?.source?.kind === "chess-context") {
        if (event.data.source.form === "ledger-stub") row.ledgerEvents.stub += 1;
        else if (op && op.op === "replace") row.ledgerEvents.replace += 1;
        else row.ledgerEvents.append += 1;
      }
    }
  }

  // 「fold 之后还有多少次请求」：按每个 checkpoint 的创建位置数它之后的请求数
  let after = 0;
  const requestSeqs = events.filter((e) => e.type === "assistant/message" && e.data?.usage).map((e) => e.seq);
  for (const event of events) {
    if (event.type === "user/message" && event.data?.source?.kind === "compact-checkpoint") {
      after += requestSeqs.filter((seq) => seq > event.seq).length;
    }
  }
  row.folds.requestsAfterFolds = after;
  row.cacheRatio = row.promptTokens > 0 ? row.cachedPromptTokens / row.promptTokens : 0;
  row.ledgerShare = row.promptTokens > 0 ? row.ledgerPromptTokens / row.promptTokens : 0;
  row.staleLedgerShare = row.promptTokens > 0 ? row.staleLedgerPromptTokens / row.promptTokens : 0;
  row.meanPrompt = row.requests > 0 ? Math.round(row.promptTokens / row.requests) : 0;
  row.meanLedger = row.requests > 0 ? Math.round(row.ledgerPromptTokens / row.requests) : 0;
  row.foldGrossSavings = row.folds.shadowedTokens - row.folds.summaryTokens;
  row.foldNetBillable = row.foldGrossSavings * 1; // 净 token 数（缓存折扣见报告）
  return row;
}

const root = sessionsRoot();
const files = dirs.length > 0 ? dirs.map((d) => (nodeFs.statSync(d).isDirectory() ? nodePath.join(d, "session.v4.jsonl.zstd") : d)) : findSessionFiles(root);
const rows = [];
for (const file of files) {
  if (!nodeFs.existsSync(file)) continue;
  try {
    rows.push(auditSession(file));
  } catch (error) {
    rows.push({ session: nodePath.basename(nodePath.dirname(file)), error: String(error?.message ?? error) });
  }
}
rows.sort((a, b) => (b.promptTokens ?? 0) - (a.promptTokens ?? 0));

const sum = rows.reduce(
  (acc, r) => {
    if (r.error) return acc;
    acc.requests += r.requests;
    acc.promptTokens += r.promptTokens;
    acc.uncached += r.uncachedPromptTokens;
    acc.cached += r.cachedPromptTokens;
    acc.output += r.outputTokens;
    acc.ledger += r.ledgerPromptTokens;
    acc.stale += r.staleLedgerPromptTokens;
    acc.shadowed += r.folds.shadowedTokens;
    acc.summary += r.folds.summaryTokens;
    acc.foldsOk += r.folds.ok;
    acc.foldsFailed += r.folds.failed;
    return acc;
  },
  { requests: 0, promptTokens: 0, uncached: 0, cached: 0, output: 0, ledger: 0, stale: 0, shadowed: 0, summary: 0, foldsOk: 0, foldsFailed: 0 },
);

if (jsonOut) nodeFs.writeFileSync(jsonOut, JSON.stringify({ rows, sum }, null, 1), "utf8");

console.log("== measure-billing：真实 usage 口径 ==");
console.log(
  "session".padEnd(30),
  "reqs".padStart(5),
  "prompt".padStart(12),
  "未缓存".padStart(11),
  "缓存命中".padStart(11),
  "命中率".padStart(7),
  "清单占比".padStart(9),
  "陈旧清单".padStart(9),
  "fold ok/fail".padStart(12),
);
for (const r of rows) {
  if (r.error) {
    console.log(`${String(r.session).slice(0, 28).padEnd(30)}  ERROR ${r.error.slice(0, 60)}`);
    continue;
  }
  console.log(
    String(r.session).slice(0, 28).padEnd(30),
    String(r.requests).padStart(5),
    String(r.promptTokens).padStart(12),
    String(r.uncachedPromptTokens).padStart(11),
    String(r.cachedPromptTokens).padStart(11),
    `${(r.cacheRatio * 100).toFixed(0)}%`.padStart(7),
    `${(r.ledgerShare * 100).toFixed(1)}%`.padStart(9),
    String(r.staleLedgerPromptTokens).padStart(9),
    `${r.folds.ok}/${r.folds.failed}`.padStart(12),
  );
}
console.log(
  `\n合计：${sum.requests} 次请求 · prompt ${sum.promptTokens.toLocaleString()} tok（未缓存 ${sum.uncached.toLocaleString()} + 缓存 ${sum.cached.toLocaleString()}，命中率 ${((sum.cached / Math.max(sum.promptTokens, 1)) * 100).toFixed(1)}%）`,
);
console.log(
  `清单自身占 prompt ${sum.ledger.toLocaleString()} tok（${((sum.ledger / Math.max(sum.promptTokens, 1)) * 100).toFixed(2)}%），其中**陈旧副本 ${sum.stale.toLocaleString()} tok** ← P1-4 修掉的就是这块`,
);
console.log(
  `fold：成功 ${sum.foldsOk} / 失败 ${sum.foldsFailed}；遮蔽 ${sum.shadowed.toLocaleString()} tok → checkpoint ${sum.summary.toLocaleString()} tok（净 ${(sum.shadowed - sum.summary).toLocaleString()} tok）`,
);
