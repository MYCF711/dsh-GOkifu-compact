#!/usr/bin/env node
/**
 * fold-timeline.mjs —— 一条命令打印「最近 N 次折叠的时间线」（2026-11-05，C599 同批）
 *
 * 为什么需要：今天连续踩了三个「静默停摆」类 bug（补账不跑、假成功、探测器恒假），
 * 共同点是**出问题时磁盘上看不出来**。`foldMarks` 里其实什么都有（谁折的、折了哪一段、
 * 摘要多长、花了多久、推理/缓存各多少），但此前只能 `node -e` 逐图 parse 才看得见 ——
 * 于是「折了 20 次」和「一次没折」在一屏之内的区别，只有临时写脚本的人知道。
 *
 * 数据源刻意复用 `graph-audit.mjs` 的 `loadSessionGraph()`：它**会重放 delta**
 * （C143 的教训 —— 只读 `graph.json` 会拿到一份过期基线，最近的折叠恰好都在 delta 里）。
 *
 * 用法：
 *   node scripts/fold-timeline.mjs                 # 最近 24 小时、最多 30 条
 *   node scripts/fold-timeline.mjs --hours=72      # 换窗口
 *   node scripts/fold-timeline.mjs --hours=0       # 不限时间（全部历史）
 *   node scripts/fold-timeline.mjs --limit=5       # 只看最近 5 条
 *   node scripts/fold-timeline.mjs --json          # 机读
 *
 * 退出码：0 = 打印完成（**没有折叠也是一种结果**，不是错误）；2 = 参数写错。
 * 边界：只读，不写盘、不跑模型。空数据打**一句人话**，不打空表。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";

/** 默认时间窗口（小时）。`--hours=0` = 不限。 */
export const DEFAULT_HOURS = 24;
/** 默认最多打印几条。 */
export const DEFAULT_LIMIT = 30;

/** 与 doctor / graph-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const raw = env?.DSH_HOME;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return nodePath.join(os.homedir(), ".dsh");
}

/** 会话目录名 → 8 位短 id（与 doctor 的 `replace(/^session-/, "").slice(0, 8)` 同口径）。 */
export function shortSessionId(name) {
  return String(name ?? "")
    .replace(/^session-/, "")
    .slice(0, 8);
}

/**
 * 解析命令行。写错的值**报错而不是静默回落** —— 静默回落会让 `--hours=7d` 打出一份
 * 「24 小时」的表，而用户以为自己在看 7 天。
 * @param {string[]} argv
 * @returns {{hours:number, limit:number, asJson:boolean, error:string|null}}
 */
export function parseArgs(argv = []) {
  const out = { hours: DEFAULT_HOURS, limit: DEFAULT_LIMIT, asJson: false, error: null };
  const readInt = (name, raw, { allowZero }) => {
    const text = String(raw ?? "").trim();
    if (!/^\d+$/.test(text)) return { error: `${name} 需要一个非负整数，收到「${raw}」` };
    const value = Number(text);
    if (!allowZero && value === 0) return { error: `${name} 必须大于 0（想不限时间请用 --hours=0）` };
    return { value };
  };
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (arg === "--json") {
      out.asJson = true;
      continue;
    }
    if (arg.startsWith("--hours=")) {
      const r = readInt("--hours", arg.slice("--hours=".length), { allowZero: true });
      if (r.error !== undefined) return { ...out, error: r.error };
      out.hours = r.value;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const r = readInt("--limit", arg.slice("--limit=".length), { allowZero: false });
      if (r.error !== undefined) return { ...out, error: r.error };
      out.limit = r.value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...out, error: null, help: true };
    }
    return { ...out, error: `未知参数「${arg}」（支持 --hours=24 / --limit=30 / --json）` };
  }
  return out;
}

/**
 * 从 foldMark 里读 usage —— **两种形状都要认**。
 *
 * ★ C587 的血泪教训：同一个字段在历史数据里至少有三种拼法（`inputTokens` / `prompt_tokens` /
 *   `input`），只认一种就会把「有数据」读成 `—`，于是时间线上"这次 fold 没花钱"是假象。
 * 真实数据（256 条 foldMark 实测）里出现过的键：
 *   inputTokens · outputTokens · totalTokens · cacheReadTokens · reasoningTokens
 *   prompt_tokens · completion_tokens · total_tokens · prompt_tokens_details.cached_tokens
 *   completion_tokens_details.reasoning_tokens · input · output · cached · reasoning
 *
 * @param {any} usage
 * @returns {{input:number|null, output:number|null, reasoning:number|null, cached:number|null}}
 */
export function readUsage(usage) {
  const u = usage !== null && typeof usage === "object" ? usage : {};
  // ★ 注意 `Number(null) === 0`：不判空会把「没采集」印成 0 token（假数据比空更坏）
  const num = (x) => {
    if (x === null || x === undefined || x === "") return null;
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    input: num(u.inputTokens) ?? num(u.prompt_tokens) ?? num(u.input),
    output: num(u.outputTokens) ?? num(u.completion_tokens) ?? num(u.output),
    reasoning: num(u.reasoningTokens) ?? num(u.reasoning) ?? num(u.completion_tokens_details?.reasoning_tokens),
    cached: num(u.cacheReadTokens) ?? num(u.cached) ?? num(u.prompt_tokens_details?.cached_tokens),
  };
}

/**
 * 扫一遍棋谱，收集折叠记录。
 *
 * @param {string} sessionsDir `<home>/chess-context/sessions`
 * @param {{hours?:number, limit?:number, now?:number}} [options]
 * @returns {{rows:object[], scanned:number, sessions:number, total:number, inWindow:number, missingDir:boolean, unreadable:number}}
 */
export function collectFolds(sessionsDir, { hours = DEFAULT_HOURS, limit = DEFAULT_LIMIT, now = Date.now() } = {}) {
  const out = { rows: [], scanned: 0, sessions: 0, total: 0, inWindow: 0, missingDir: false, unreadable: 0 };
  if (!nodeFs.existsSync(sessionsDir)) {
    out.missingDir = true;
    return out;
  }
  // `hours = 0` ⇒ 不限时间（用 -Infinity 表示"全部都在窗口内"）
  const cutoff = Number(hours) > 0 ? Number(now) - Number(hours) * 3600 * 1000 : Number.NEGATIVE_INFINITY;
  // ★ `Number(null) === 0`：字段缺了要印「—」，不许印成 0（0 毫秒 / 0 字会让人以为真的没内容）
  const num = (x) => {
    if (x === null || x === undefined || x === "") return null;
    return Number.isFinite(Number(x)) ? Number(x) : null;
  };
  const all = [];
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    out.scanned += 1;
    let loaded = null;
    try {
      // ★ C143：必须重放 delta（最近的折叠往往只在 delta 层）
      loaded = loadSessionGraph(graphFile);
    } catch {
      out.unreadable += 1; // 坏图由 `graph-audit.mjs` / doctor 的「棋谱结构自洽」报，这里只计数
      continue;
    }
    const marks = Array.isArray(loaded?.graph?.foldMarks) ? loaded.graph.foldMarks : [];
    if (marks.length === 0) continue;
    out.sessions += 1;
    out.total += marks.length;
    for (const mark of marks) {
      const atRaw = Number(mark?.at);
      const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : null;
      // 时间读不出来的记录**不进窗口筛选**（没法证明它在窗口外），排在最后并显示 "—"
      if (at !== null && at < cutoff) continue;
      const usage = readUsage(mark?.usage);
      all.push({
        at,
        atIso: at === null ? null : new Date(at).toISOString(),
        session: entry.name,
        sessionShort: shortSessionId(entry.name),
        trigger: typeof mark?.trigger === "string" && mark.trigger.length > 0 ? mark.trigger : "(未记)",
        seqStart: num(mark?.seqStart),
        seqEnd: num(mark?.seqEnd),
        summaryChars: num(mark?.summaryChars),
        ms: num(mark?.ms),
        reasoningTokens: usage.reasoning,
        cacheReadTokens: usage.cached,
        inputTokens: usage.input,
        outputTokens: usage.output,
        offline: mark?.offline === true,
        tier2: mark?.tier2 === true,
        shadowedTokens: num(mark?.shadowedTokens),
      });
    }
  }
  out.inWindow = all.length;
  // 最近的在前；时间缺失的沉到最后
  all.sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY));
  out.rows = all.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  return out;
}

/** 千分位（与 doctor 的 `toLocaleString("en-US")` 同口径）。 */
function n(value) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`（时间线要能和人眼对账，所以用本地时区）。 */
export function formatWhen(at) {
  if (!Number.isFinite(Number(at))) return "—";
  const d = new Date(Number(at));
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一行折叠。列序即契约：时间 · 会话(8) · 触发 · seq 区间 · 摘要字符数 · 耗时ms · reasoning · cached */
export function formatRow(row) {
  const range = row.seqStart === null || row.seqEnd === null ? "—" : `${n(row.seqStart)}→${n(row.seqEnd)}`;
  const chars = row.summaryChars === null ? "—" : `${n(row.summaryChars)} 字`;
  const ms = row.ms === null ? "—" : `${n(row.ms)} ms`;
  return [
    formatWhen(row.at),
    row.sessionShort,
    row.trigger,
    range,
    chars,
    ms,
    `reasoning ${n(row.reasoningTokens)}`,
    `cached ${n(row.cacheReadTokens)}`,
  ].join(" · ");
}

/**
 * 渲染整张表（纯函数，便于单测）。
 * @param {ReturnType<typeof collectFolds>} collected
 * @param {{hours:number, limit:number, home:string}} meta
 * @returns {string}
 */
export function renderTimeline(collected, { hours, limit, home }) {
  const windowText = Number(hours) > 0 ? `最近 ${hours} 小时` : "全部历史";
  const head = `== 折叠时间线（${windowText} · 最多 ${limit} 条）==`;
  const lines = [head];
  if (collected.missingDir) {
    lines.push(`  · 没有找到棋谱目录 —— ${nodePath.join(home, "chess-context", "sessions")} 不存在：本机还没跑过这个插件，或 DSH_HOME 指错了。`);
    return lines.join(String.fromCharCode(10));
  }
  if (collected.rows.length === 0) {
    // ★ 空数据给一句人话：不打表头下的空行，也不假装"0 条 = 健康"
    const where = collected.total > 0 ? `（全库共 ${n(collected.total)} 条 foldMark，都不在这个窗口里 —— 想看全部用 --hours=0）` : "（全库一条 foldMark 都没有）";
    lines.push(`  · ${windowText}没有折叠记录 ${where} —— 这段时间没触发压缩，不一定是故障。`);
    return lines.join(String.fromCharCode(10));
  }
  for (const row of collected.rows) lines.push(`  ${formatRow(row)}`);
  const bySession = new Set(collected.rows.map((r) => r.session)).size;
  const sum = (key) => collected.rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
  const msSum = sum("ms");
  const tail =
    `  ${n(collected.rows.length)} 条` +
    (collected.inWindow > collected.rows.length ? `（窗口内 ${n(collected.inWindow)} 条，只显示最近 ${n(collected.rows.length)} 条）` : "") +
    ` · 涉及 ${n(bySession)} 个会话 · 耗时合计 ${(msSum / 1000).toFixed(1)} s` +
    ` · reasoning 合计 ${n(sum("reasoningTokens"))} · cached 合计 ${n(sum("cacheReadTokens"))}`;
  lines.push(tail);
  if (collected.unreadable > 0) {
    lines.push(`  ⚠ 另有 ${n(collected.unreadable)} 个会话的 graph.json 读不出来（已跳过 —— 用 node scripts/graph-audit.mjs 看是哪几个）`);
  }
  return lines.join(String.fromCharCode(10));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== null) {
    process.stderr.write(`✗ ${args.error}${String.fromCharCode(10)}`);
    process.exit(2);
  }
  if (args.help === true) {
    process.stdout.write(
      "用法：node scripts/fold-timeline.mjs [--hours=24] [--limit=30] [--json]" + String.fromCharCode(10),
    );
    process.exit(0);
  }
  const home = resolveHome();
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  const collected = collectFolds(sessionsDir, { hours: args.hours, limit: args.limit });
  if (args.asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          home,
          sessionsDir,
          hours: args.hours,
          limit: args.limit,
          scanned: collected.scanned,
          sessions: collected.sessions,
          total: collected.total,
          inWindow: collected.inWindow,
          shown: collected.rows.length,
          missingDir: collected.missingDir,
          unreadable: collected.unreadable,
          rows: collected.rows,
        },
        null,
        1,
      ) + String.fromCharCode(10),
    );
    process.exit(0);
  }
  process.stdout.write(renderTimeline(collected, { hours: args.hours, limit: args.limit, home }) + String.fromCharCode(10));
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
