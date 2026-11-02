/**
 * backfill-plan.mjs —— 补账到底要花多少、几轮能补完（离线，不调模型）
 *
 * 为什么需要：面板的「检查欠账」只在有宿主时能用；而"要不要现在补、补几轮、多少钱"
 * 这种事**离线也该能算清楚**。真机数据（2026-11-02）：35 个欠账、可估 11 个、
 * 合计 ≈ 5.51 M tok ≈ $0.83 —— 但没人能一眼看出"要跑几轮"。
 *
 * 口径全部复用生产代码，不另起一套：
 *   · 欠账判定：`rooms/closeout-backfill.mjs` 的 `debtOfGraph`
 *   · 分段：`engine.planChunkedCloseout`（预检 + 切分，C288/C289/C309 同一条链）
 *
 * 用法：
 *   node scripts/backfill-plan.mjs                 # 表格
 *   node scripts/backfill-plan.mjs --json
 *   node scripts/backfill-plan.mjs --home <DSH_HOME>
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { planChunkedCloseout, CLOSEOUT_MAX_FOLD_TOKENS, foldDurationStats } from "../src/rooms/closeout-plan.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/** 冷缓存下的输入单价（美元 / 百万 token）：与 成本模型-deepseek价格.md 同一口径。 */
export const COLD_INPUT_PER_MTOK = 0.15;
/** 每次补账除了折进去的尾巴，还要付一次摘要输出（保守按 2k token、$0.6/M 计）。 */
export const SUMMARY_OUTPUT_TOKENS = 2000;
export const OUTPUT_PER_MTOK = 0.6;

/**
 * ★ C339：把一批欠账算成「要几轮、多少钱」。纯函数，便于单测。
 *
 * @param {Array<{sessionId: string, tail: number, estTokens: number|null, chunks: number}>} rows
 * @param {{maxChunks?: number, coldInputPerMTok?: number}} [options]
 * @returns {{total:number, estimable:number, unknown:number, tokens:number, chunks:number,
 *            rounds:number, costUsd:number, rows: Array<object>}}
 */
export function summarizePlan(rows, { maxChunks = 6, coldInputPerMTok = COLD_INPUT_PER_MTOK, roughPerEvent = null } = {}) {
  let tokens = 0;
  let chunks = 0;
  let estimable = 0;
  let unknown = 0;
  let rough = 0;
  for (const row of rows ?? []) {
    // ★ C340：估不出的（没有历史折可采样）用**全局均值**粗估，并单独记数 ——
    //   真机上 46 个欠账里 33 个是这种"零 fold 会话"；不粗估，用户看到的就是"大部分算不出钱"。
    if (!Number.isFinite(row?.estTokens)) {
      if (Number.isFinite(roughPerEvent) && Number.isFinite(row?.tail) && row.tail > 0) {
        const est = Math.round(row.tail * roughPerEvent);
        rough += 1;
        tokens += est;
        chunks += 1;
        continue;
      }
      unknown += 1;
      continue;
    }
    estimable += 1;
    tokens += row.estTokens;
    chunks += Number.isFinite(row.chunks) && row.chunks > 0 ? row.chunks : 1;
  }
  const rounds = chunks === 0 ? 0 : Math.ceil(chunks / Math.max(1, maxChunks));
  // ★ C342：真正的调度单位是**每次点击最多 20 个会话**（DEFAULT_LIMIT），不是一个"6 段一轮"。
  //   另外：单会话一次最多折 6 段，`requiredChunks > 6` 的会话**一次点击补不完**。
  const multiPass = (rows ?? []).filter((r) => Number(r?.requiredChunks) > maxChunks).length;
  const clicks = (rows ?? []).length === 0 ? 0 : Math.ceil((rows ?? []).length / 20);
  // 每一段折叠都要付一次输入（该段 token）+ 一次摘要输出
  const costUsd = (tokens / 1_000_000) * coldInputPerMTok + (chunks * SUMMARY_OUTPUT_TOKENS / 1_000_000) * OUTPUT_PER_MTOK;
  return {
    total: (rows ?? []).length,
    estimable,
    rough,
    unknown,
    tokens,
    chunks,
    rounds,
    clicks,
    multiPass,
    costUsd: Math.round(costUsd * 100) / 100,
    rows: rows ?? [],
  };
}

/**
 * ★ C341：把补账排成**批次**（每轮最多 N 段）—— 把"13 轮"变成"第一轮补哪几个"。
 *
 * 贪心装箱：按段数从大到小放，装不下就开新批。这样大尾巴先补、批次数也接近最少。
 * 注意：这是**建议顺序**，不是调度器 —— 面板的实际分批由宿主那边控制。
 *
 * @param {Array<{sessionId:string, chunks:number}>} rows
 * @param {{maxChunksPerRound?: number}} [options]
 * @returns {Array<{round:number, sessions:string[], chunks:number}>}
 */
export function planRounds(rows, { maxChunksPerRound = 6 } = {}) {
  const cap = Math.max(1, Number(maxChunksPerRound) || 6);
  const items = (rows ?? [])
    .map((row) => ({ sessionId: String(row?.sessionId ?? "?"), chunks: Math.max(1, Number(row?.chunks) || 1) }))
    .sort((a, b) => b.chunks - a.chunks || a.sessionId.localeCompare(b.sessionId));
  const rounds = [];
  for (const item of items) {
    let placed = false;
    for (const round of rounds) {
      if (round.chunks + item.chunks <= cap) {
        round.sessions.push(item.sessionId);
        round.chunks += item.chunks;
        placed = true;
        break;
      }
    }
    if (!placed) rounds.push({ round: rounds.length + 1, sessions: [item.sessionId], chunks: item.chunks });
  }
  return rounds;
}

/**
 * ★ C343：给"一次补不完"的会话推荐一个 `closeoutMaxFoldTokens` 值。
 *
 * 逻辑很简单但很有用：要让最大的那个会话在 ≤6 段内折完，单段上限至少要
 * `ceil(estTokens / maxChunks)`。取所有会话的最大需求，再夹到配置允许的区间
 * （`config-schema` 里是 20000–800000）。
 *
 * @param {Array<{estTokens:number|null}>} rows
 * @param {{maxChunks?: number, min?: number, max?: number}} [options]
 * @returns {{value:number, needed:number|null, fits:boolean}|null} null = 没有可估的会话
 */
export function recommendMaxFoldTokens(rows, { maxChunks = 6, min = 20000, max = 800000 } = {}) {
  const needs = (rows ?? [])
    .map((r) => Number(r?.estTokens))
    .filter((x) => Number.isFinite(x) && x > 0)
    .map((est) => Math.ceil(est / Math.max(1, maxChunks)));
  if (needs.length === 0) return null;
  const needed = Math.max(...needs);
  const value = Math.min(max, Math.max(min, needed));
  return { value, needed, fits: needed <= max };
}

/**
 * 扫一遍会话目录/**
 * 扫一遍会话目录/**
 * 扫一遍会话目录，给每个欠账算尾巴/估算/段数（读图走 loadSessionGraph，脚本侧硬规矩 C183）。
 * @param {string} home
 * @param {{maxTokens?: number}} [options]
 */
/**
 * ★ C340：从**有折的会话**里算 tokens/事件 的全局均值（用于给"零 fold 会话"粗估）。
 * 真机实测（46 个欠账里 33 个零 fold）：均值约 143.7 tok/事件。
 * @param {Array<{tokensPerEvent: number|null}>} samples
 * @returns {number|null}
 */
export function averageTokensPerEvent(samples) {
  const values = (samples ?? []).map((x) => Number(x?.tokensPerEvent)).filter((x) => Number.isFinite(x) && x > 0);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * ★ C368：从真机 foldMark.ms 里取「一次折叠要多久」的分位数。纯函数。
 * 实测（62 个样本）：中位 **11.7s** / p90 **18.8s** / max 34.5s。
 * @param {number[]} values 毫秒
 * @returns {{n:number, median:number|null, p90:number|null, max:number|null}}
 */

/**
 * ★ C368：估算一个待补会话的**墙钟耗时**，并判断是否可能撞收尾超时。纯函数。
 * @param {number} chunks
 * @param {number|null} medianMs
 * @param {number|null} p90Ms
 * @param {number} timeoutMs
 * @returns {{estMs:number|null, risky:boolean}}
 */
export function estimateSessionRuntime(chunks, medianMs, p90Ms, timeoutMs) {
  const n = Math.max(1, Number(chunks) || 1);
  if (!Number.isFinite(medianMs)) return { estMs: null, risky: false };
  const estMs = Math.round(n * medianMs);
  const worst = Number.isFinite(p90Ms) ? n * p90Ms : estMs;
  return { estMs, risky: worst > timeoutMs };
}

export async function buildPlan(home, { maxTokens = CLOSEOUT_MAX_FOLD_TOKENS } = {}) {
  const { loadSessionGraph } = await import("./graph-audit.mjs");
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const rows = [];
  if (!nodeFs.existsSync(sessionsRoot)) return rows;
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph = null;
    try {
      graph = loadSessionGraph(file).graph;
    } catch {
      continue;
    }
    const debt = debtOfGraph(graph);
    if (!debt.due) continue;
    const planned = planChunkedCloseout(graph, { maxTokens });
    rows.push({
      sessionId: entry.name.slice(0, 18),
      tail: debt.tail,
      estTokens: Number.isFinite(debt.estTokens) ? debt.estTokens : null,
      tokensPerEvent: Number.isFinite(debt.tokensPerEvent) ? debt.tokensPerEvent : null,
      chunks: planned?.chunks?.length ?? 1,
      // ★ C342：**需要**多少段（不截断）vs **一次最多**给 6 段 —— 前者大于 6 的会话一次补不完
      _ms: (() => {
        const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
        return marks.map((m) => Number(m?.ms)).filter((x) => Number.isFinite(x) && x > 0);
      })(),
      requiredChunks: (() => {
        const est = Number.isFinite(debt.estTokens) ? debt.estTokens : null;
        const per = Number(debt.tokensPerEvent);
        if (est === null || !Number.isFinite(per) || per <= 0) return null;
        return Math.max(1, Math.ceil(est / maxTokens));
      })(),
    });
  }
  rows.sort((a, b) => (b.estTokens ?? -1) - (a.estTokens ?? -1));
  return rows;
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "") {
    console.log("需要 --home <DSH_HOME>（或设置 DSH_HOME）");
    return 2;
  }
  const rows = await buildPlan(home);
  const roughPerEvent = averageTokensPerEvent(rows);
  const plan = summarizePlan(rows, { roughPerEvent });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(
    `== 补账计划 ==  ${plan.total} 个欠账 · 精确可估 ${plan.estimable} · ` +
      `粗略可估 ${plan.rough}（按全局 ${roughPerEvent === null ? "?" : roughPerEvent.toFixed(0)} tok/事件）· 估不出 ${plan.unknown}`,
  );
  for (const row of rows.slice(0, 12)) {
    const est = row.estTokens === null ? "?" : `${Math.round(row.estTokens / 1000)}k tok`;
    console.log(`  · ${row.sessionId}  尾巴 ${row.tail} 事件 · ${est} · ${row.chunks} 段`);
  }
  if (rows.length > 12) console.log(`  · …另 ${rows.length - 12} 个`);
  const rounds = planRounds(rows);
  console.log(`
—— 建议批次（每轮最多 6 段）——`);
  for (const round of rounds.slice(0, 6)) {
    console.log(`  第 ${round.round} 轮：${round.chunks} 段 · ${round.sessions.join(" / ")}`);
  }
  if (rounds.length > 6) console.log(`  …共 ${rounds.length} 轮`);
  console.log(
    `合计 ≈ ${(plan.tokens / 1_000_000).toFixed(2)} M tok / ${plan.chunks} 段` +
      ` · 冷缓存估价 **$${plan.costUsd.toFixed(2)}**`,
  );
  const allMs = rows.flatMap((r) => r._ms ?? []);
  const dur = foldDurationStats(allMs);
  const timeoutMs = 90_000; // 与 closeoutTimeoutMs 默认一致
  const runtimes = rows.map((r) => estimateSessionRuntime(r.chunks, dur.median, dur.p90, timeoutMs));
  const risky = runtimes.filter((x) => x.risky).length;
  const totalMin = runtimes.reduce((n, x) => n + (x.estMs ?? 0), 0) / 60000;
  const rec = recommendMaxFoldTokens(rows);
  if (plan.multiPass > 0 && rec !== null) {
    console.log(
      `  ⇒ 建议把 \`closeoutMaxFoldTokens\` 调到 **${rec.value}**` +
        (rec.fits ? `（最大值会话需要 ${rec.needed}）` : `（⚠ 需要 ${rec.needed} 已超上限 ${800000}，最大的那个仍要重复点）`),
    );
  }
  if (dur.n > 0) {
    console.log(
      `耗时口径（真机 ${dur.n} 次 fold）：中位 **${(dur.median / 1000).toFixed(1)}s** · p90 ${(dur.p90 / 1000).toFixed(1)}s` +
        ` ⇒ 全量约 **${totalMin.toFixed(0)} 分钟**墙钟；` +
        (risky > 0 ? `**${risky} 个会话按 p90 估算会超过 ${timeoutMs / 1000}s 单会话超时**（调大 closeoutTimeoutMs 或 closeoutMaxFoldTokens）` : `没有会话会超时`),
    );
  }
  console.log(
    `调度口径：面板**每次点击最多 ${20} 个会话**、每个会话一次最多折 ${6} 段` +
      ` ⇒ 约 **${plan.clicks} 次点击**；` +
      (plan.multiPass > 0
        ? `其中 **${plan.multiPass} 个会话超过 6 段、一次补不完**（要重复点或调大 closeoutMaxFoldTokens）`
        : `没有会话超过 6 段`),
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
