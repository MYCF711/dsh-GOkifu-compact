#!/usr/bin/env node
/**
 * backfill-forecast.mjs —— **补账清偿期的测算器**（只读，不调模型、不写盘）
 *
 * 由来（2026-11-05 真机）：欠账 218 个会话 / $5.29，自动补账近 24h 只折了 84 段，
 * 而新欠账还在涨。要回答的只有一个问题：**按现在的调度，多久能追平；卡在哪一项。**
 * 之前没人能答，因为"段"这个单位从来没被算清楚过 —— 218 个会话不等于 218 段
 * （中位会话要 3 段、最大的要 85 段）。
 *
 * 口径全部复用生产代码，不另起一套：
 *   · 欠账判定 / 债务规模：`src/rooms/closeout-backfill.mjs` 的 `listDebts` / `debtOfGraph`
 *     （与面板、`doctor`、引擎自动补账同源；`loadDebts` 需要"已重放 delta"的图，这里走
 *     `graph-audit.mjs` 的 `loadSessionGraph`，与 `scripts/` 的硬规矩一致）
 *   · **段耗时**与**每段覆盖多少事件**：直接量真机上已有的 `archive-offline` foldMark
 *     （`ms` / `seqStart` / `seqEnd` / `usage`）—— 不猜、不套默认值。
 *   · 单价：与 `scripts/backfill-plan.mjs` 同口径（冷缓存输入 $0.15/M、输出 $0.6/M）。
 *
 * 用法：
 *   node scripts/backfill-forecast.mjs                       # 表格（默认 --home $DSH_HOME）
 *   node scripts/backfill-forecast.mjs --home "D:/DeepSeek Harness/home"
 *   node scripts/backfill-forecast.mjs --seg-sec 169         # 换一个"每段秒数"假设
 *   node scripts/backfill-forecast.mjs --window 8            # 用最近 8 小时实测速率
 *   node scripts/backfill-forecast.mjs --json
 *
 * 退出码：0 正常；2 找不到图目录（不是错误，是"没数据可测"）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listDebts } from "../src/rooms/closeout-backfill.mjs";
import { listSessionLogs } from "../src/rooms/zstd-log.mjs";

/** 冷缓存输入单价（美元 / 百万 token）——与 `scripts/backfill-plan.mjs` 同源。 */
export const COLD_INPUT_PER_MTOK = 0.15;
/** 摘要输出单价（美元 / 百万 token）——同上。 */
export const OUTPUT_PER_MTOK = 0.6;

/** 真机默认调度参数（`src/engine.mjs` 的 `#startAutoBackfill` / `#autoBackfillTick`）。 */
export const DEFAULT_SCHEDULE = {
  intervalMin: 30,
  max: 5,
  rounds: 3,
  budgetSec: 420,
  maxTokensCap: 8192,
};

/**
 * ★ C599：**真机实测的段耗时模型**（`maxTokensCap` → 每段要几秒）。纯函数，便于单测。
 *
 * 依据（2026-11-05，88 条 `archive-offline` mark）：
 *   · 段耗时中位 **48s** / p90 197s / 均值 79s；
 *   · 出字速度 **127.6 token/s**（6,190 token ÷ 48.5s），输出中位 6,190 token
 *     ⇒ 时间**几乎全是产物长度决定的**，跟输入大小关系很小（输入中位 14,243 token）；
 *   · 输出 ≈ `maxTokensCap` 的 0.76 倍（6,190 / 8,192）⇒ 预算越大，段越慢。
 *
 * 两个必须建模的真机事实：
 *   ① **reasoning 不认 `reasoning_effort:"none"`**（真机仍产 3,436 token）⇒ 它会**挤占**输出预算；
 *   ② 产出过薄（< 1,200 token）会命中 `runOfflineFold` 的"被截断 ⇒ 放大 2 倍重试"，
 *      于是 **cap=4096 不是更快、而是更慢**（先跑一段残渣，再整段重跑）。
 *
 * @param {number} cap maxTokensCap
 * @param {{speed?:number, reasoningTokens?:number, hardCap?:number}} [measured]
 * @returns {{first:number, retry:number, seconds:number, outputTokens:number, retried:boolean, thin:boolean}}
 */
export function segmentPlan(cap, { outputTokens = 6190, speed = 127.6, reasoningTokens = 0, hardCap = 16_384 } = {}) {
  const budget = Math.max(1024, Math.min(Number(hardCap) || 16_384, Number(cap) || DEFAULT_SCHEDULE.maxTokensCap));
  const rate = Math.max(1, Number(speed) || 127.6);
  const perCap = (Number(outputTokens) || 6190) / DEFAULT_SCHEDULE.maxTokensCap;
  const typical = budget * perCap;
  // 真机 reasoning 最大 3,436 token：cap 小到装不下"思考 + 一段像样的正文"时，
  // 会命中 `looksTruncated`（正文 < 400 字符）⇒ 放大 2 倍重试 ⇒ **这一段实际花两次**。
  const thin = Number(reasoningTokens) > 0 && budget - Number(reasoningTokens) < 1_200;
  const effective = thin ? Math.max(0, budget - Number(reasoningTokens)) : typical;
  const first = Math.max(2, effective / rate);
  const retryCap = Math.min(Number(hardCap) || 16_384, budget * 2);
  const retry = thin ? Math.max(2, (retryCap * perCap) / rate) : 0;
  return { first, retry, seconds: first + retry, outputTokens: Math.round(effective), retried: thin, thin };
}

/**
 * ★ C599：**一轮 tick 能开几段**。纯函数，便于单测。
 *
 * 两层上限都要算：会话数 × 每会话轮数（`max × rounds`），以及时间预算能装下几段。
 * 这里**不加 1**（引擎的预算判据是"已超预算才 break"，可以多开一段；测算取保守口径）。
 *
 * @param {{budgetSec?:number, segmentSec?:number, max?:number, rounds?:number}} args
 * @returns {{segments:number, limitedBy:"sessions"|"budget"}}
 */
export function segmentsPerTick({ budgetSec = 420, segmentSec = 48, max = 5, rounds = 3 } = {}) {
  const bySessions = Math.max(0, Number(max) || 0) * Math.max(1, Number(rounds) || 1);
  const sec = Math.max(1, Number(segmentSec) || 1);
  const byBudget = Math.floor(Math.max(0, Number(budgetSec) || 0) / sec);
  return byBudget >= bySessions ? { segments: bySessions, limitedBy: "sessions" } : { segments: byBudget, limitedBy: "budget" };
}

/**
 * ★ C599：**调度吞吐模型**（段/小时）。纯函数，便于单测。
 *
 * 关键是"占空比"：预算 420s 而间隔 1800s ⇒ 一天里只有 23% 的时间在调模型，其余在等下一轮。
 * 引擎的 `_autoBackfillBusy` 会让重叠的 tick 直接返回，所以当 `预算 > 间隔` 时，
 * 实际节奏是 `max(间隔, 本轮耗时)` —— 这一点必须建模，否则"把预算调到 3600s"会算成神仙数字。
 *
 * @param {{intervalMin?:number, budgetSec?:number, segmentSec?:number, max?:number, rounds?:number}} schedule
 * @returns {{segmentsPerTick:number, tickPeriodSec:number, perHour:number, duty:number, limitedBy:string}}
 */
export function throughputPerHour({ intervalMin = 30, budgetSec = 420, segmentSec = 48, max = 5, rounds = 3 } = {}) {
  const tick = segmentsPerTick({ budgetSec, segmentSec, max, rounds });
  const intervalSec = Math.max(1, (Number(intervalMin) || 30) * 60);
  const busySec = tick.segments * Math.max(1, Number(segmentSec) || 1);
  const period = Math.max(intervalSec, busySec);
  return {
    segmentsPerTick: tick.segments,
    tickPeriodSec: period,
    perHour: tick.segments === 0 ? 0 : (tick.segments * 3600) / period,
    duty: Math.min(1, busySec / period),
    limitedBy: tick.limitedBy,
  };
}

/** 每段覆盖多少事件 / 段耗时 —— 全部从真机 foldMark 里量出来。 */
export function measureFromMarks(marks) {
  const list = (Array.isArray(marks) ? marks : []).filter((m) => String(m?.trigger) === "archive-offline");
  const spans = [];
  const secs = [];
  const outs = [];
  const reasons = [];
  for (const m of list) {
    const start = Number(m?.seqStart);
    const end = Number(m?.seqEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) spans.push(end - start + 1);
    const ms = Number(m?.ms);
    if (Number.isFinite(ms) && ms > 0) secs.push(ms / 1000);
    const out = Number(m?.usage?.outputTokens);
    if (Number.isFinite(out) && out > 0) outs.push(out);
    const rs = Number(m?.usage?.reasoningTokens);
    if (Number.isFinite(rs) && rs > 0) reasons.push(rs);
  }
  return {
    n: list.length,
    eventsPerSegment: quantile(spans, 0.5) ?? 232,
    segmentSec: quantile(secs, 0.5) ?? 48,
    p90Sec: quantile(secs, 0.9) ?? 197,
    meanSec: secs.length === 0 ? 79 : secs.reduce((a, b) => a + b, 0) / secs.length,
    outputTokens: quantile(outs, 0.5) ?? 6190,
    reasoningMax: reasons.length === 0 ? 0 : Math.max(...reasons),
  };
}

/** 分位数（最近秩法，不需要排序假设）。 */
export function quantile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = Math.round((list.length - 1) * Math.max(0, Math.min(1, p)));
  return list[Math.min(list.length - 1, Math.max(0, at))];
}

/**
 * 核心测算：把「欠账」变成「段数 / 小时数 / 钱」。纯函数（不碰磁盘），便于单测。
 *
 * @param {object} args
 * @param {Array<{sessionId:string, tail:number, gapEvents?:number, estTokens?:number|null}>} args.items `listDebts` 的产出
 * @param {{eventsPerSegment:number, segmentSec:number, maxTokensCap?:number}} args.measured
 * @param {typeof DEFAULT_SCHEDULE} [args.schedule]
 * @param {number} [args.efficiency] 实测用满率（实测段/小时 ÷ 配置上限），默认 1
 * @returns {object}
 */
export function forecast({ items = [], measured, schedule = DEFAULT_SCHEDULE, efficiency = 1 } = {}) {
  const eventsPerSegment = Math.max(1, Number(measured?.eventsPerSegment) || 232);
  const segmentSec =
    Number(measured?.segmentSec) > 0 ? Number(measured.segmentSec) : segmentPlan(schedule?.maxTokensCap ?? DEFAULT_SCHEDULE.maxTokensCap).seconds;
  const rows = (items ?? []).map((it) => {
    const events = Math.max(0, Number(it?.tail) || 0) + Math.max(0, Number(it?.gapEvents) || 0);
    return { sessionId: String(it?.sessionId ?? ""), events, segments: Math.max(1, Math.ceil(events / eventsPerSegment)) };
  });
  const totalSegments = rows.reduce((n, r) => n + r.segments, 0);
  const totalEvents = rows.reduce((n, r) => n + r.events, 0);
  const perSession = rows.map((r) => r.segments);
  const sched = { ...DEFAULT_SCHEDULE, ...(schedule ?? {}) };
  const rate = throughputPerHour({ ...sched, segmentSec });
  const eff = Math.max(0.01, Math.min(1, Number(efficiency) || 1));
  const hoursPerfect = rate.perHour === 0 ? Infinity : totalSegments / rate.perHour;
  const hoursReal = rate.perHour === 0 ? Infinity : totalSegments / (rate.perHour * eff);
  // 钱：段数 ×（每段输入 + 每段输出）。与面板 $5.29 同一口径（见 2026-11-05 核对）。
  const inTok = Number(measured?.inputTokens) > 0 ? Number(measured.inputTokens) : 14_246;
  const outTok = Number(measured?.outputTokens) > 0 ? Number(measured.outputTokens) : 6190;
  const costUsd = (totalSegments * (inTok * (COLD_INPUT_PER_MTOK / 1e6) + outTok * (OUTPUT_PER_MTOK / 1e6)));
  return {
    sessions: rows.length,
    totalEvents,
    totalSegments,
    segmentsMedian: quantile(perSession, 0.5) ?? 0,
    segmentsP90: quantile(perSession, 0.9) ?? 0,
    segmentsMax: perSession.length === 0 ? 0 : Math.max(...perSession),
    segmentSec,
    segmentsPerTick: rate.segmentsPerTick,
    tickPeriodSec: rate.tickPeriodSec,
    perHour: rate.perHour,
    limitedBy: rate.limitedBy,
    duty: rate.duty,
    efficiency: eff,
    hoursPerfect,
    hoursReal,
    perSessionInput: inTok,
    perSessionOutput: outTok,
    costUsd,
    rows,
  };
}

/**
 * ★ C599：**反解**——要 T 小时内追平，需要什么调度。纯函数。
 *
 * 三个数一起给，缺一个就会骗人：
 *   · 需要多少**段/小时**（= 段数 ÷ T）；
 *   · 在现有间隔下每轮要开几段 ⇒ 需要**几个会话**（每会话最多 `rounds` 段）；
 *   · 按实测用满率折算后需要**多少秒预算** ⇒ 倒推出**间隔上限**（预算塞不进一个间隔就要缩短间隔）。
 *
 * @param {object} args
 * @param {number} args.totalSegments 要折多少段
 * @param {number} args.hours 目标 T
 * @param {{intervalMin?:number, rounds?:number, segmentSec?:number, efficiency?:number, maxSessions?:number}} [args.schedule]
 * @returns {{hours:number, requiredPerHour:number, requiredSegmentsPerTick:number, requiredBudgetSec:number, requiredSessions:number, requiredIntervalMin:number, feasible:boolean, blocker:string}}
 */
export function invert({ totalSegments = 0, hours = 48, intervalMin = 30, rounds = 3, segmentSec = 48, efficiency = 1, maxSessions = 5 } = {}) {
  const target = Math.max(0.1, Number(hours) || 48);
  const perRound = Math.max(1, Number(rounds) || 1);
  const eff = Math.max(0.01, Math.min(1, Number(efficiency) || 1));
  const segSec = Math.max(1, Number(segmentSec) || 1);
  const requiredPerHour = totalSegments / target;
  // 现有间隔能装下几段就装几段；装不下就缩短间隔（而不是假装能装下）
  const ticksNow = 3600 / Math.max(60, (Number(intervalMin) || 30) * 60);
  const requiredSegmentsPerTick = requiredPerHour / ticksNow;
  const requiredSessions = Math.ceil(requiredSegmentsPerTick / perRound);
  // 预算按"实测用满率"折算：用满率 52% 时，想要 10 段就得给 10/0.52 段的预算
  const requiredBudgetSec = Math.ceil((requiredSegmentsPerTick * segSec) / eff / 30) * 30;
  // 一个间隔里最多只能跑 预算 秒 ⇒ 需要的最小间隔
  const requiredIntervalMin = Math.max(1, Math.ceil(requiredBudgetSec / 60));
  const sessionCap = Math.max(1, Number(maxSessions) || 5);
  const blockers = [];
  if (requiredSessions > sessionCap) blockers.push(`每轮会话数 ${requiredSessions} > 硬上限 ${sessionCap}`);
  if (requiredBudgetSec > (Number(intervalMin) || 30) * 60) blockers.push(`预算 ${requiredBudgetSec}s > 现间隔 ${Number(intervalMin) || 30}min`);
  const note = eff < 1 ? `预算已按实测用满率 ${(eff * 100).toFixed(0)}% 折算` : "预算按 100% 用满折算";
  return {
    hours: target,
    requiredPerHour,
    requiredSegmentsPerTick,
    requiredBudgetSec,
    requiredSessions,
    requiredIntervalMin,
    feasible: blockers.length === 0,
    blocker: (blockers.length === 0 ? "现上限之内（只需调预算）" : blockers.join("；")) + `；${note}`,
  };
}

/**
 * 读真机所有 foldMark（只要 `archive-offline` 的统计用，别的不留）。
 * ★ 吃**已经加载好的图**：`listDebts` 那趟已经把每张图读过一次，再读一遍要多花一倍时间
 *   （435 张图 × delta 重放）。真机实测这一趟就值几十秒 —— 测算器是给人随手跑的，不能这么慢。
 * @param {Map<string, object>} graphs 会话 id → 图
 * @returns {Array<object>}
 */
function readMarks(graphs) {
  const marks = [];
  for (const [sessionId, graph] of graphs) {
    for (const mark of Array.isArray(graph?.foldMarks) ? graph.foldMarks : []) {
      marks.push({ ...mark, _session: sessionId });
    }
  }
  return marks;
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "") {
    console.log("需要 --home <DSH_HOME>（或设 DSH_HOME）");
    return 2;
  }
  const sessionsRoot = getArg("graph-dir", nodePath.join(home, "chess-context", "sessions"));
  if (!nodeFs.existsSync(sessionsRoot)) {
    console.log(`找不到图目录：${sessionsRoot}（这台机器上没有欠账数据可测）`);
    return 2;
  }
  const { loadSessionGraph } = await import(pathToFileURL(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "graph-audit.mjs")).href);
  const t0 = Date.now();
  // 一次读盘：图既给 `listDebts` 判欠账，也给下面量段耗时，只读一遍
  const graphs = new Map();
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    try {
      const graph = loadSessionGraph(file).graph;
      if (graph !== null && graph !== undefined) graphs.set(entry.name, graph);
    } catch {
      /* 坏图跳过：一次测算不该整页 500 */
    }
  }
  const listed = listDebts({ sessionIds: [...graphs.keys()], limit: 100_000, loadGraph: (id) => graphs.get(id) ?? null });
  const marks = readMarks(graphs);
  const measured = { ...measureFromMarks(marks), inputTokens: quantile(marks.filter((m) => String(m?.trigger) === "archive-offline").map((m) => Number(m?.usage?.inputTokens)).filter((x) => x > 0), 0.5) };
  // 日志已不在的欠账补不了 —— 单独数出来，别让它稀释"能补多少"
  let noLog = 0;
  // ★ 与引擎同一招（C572）：**一次遍历**拿全部日志路径。按会话各走一遍树时，
  //   222 个欠账 × ~200ms ≈ 44s —— 测算器会慢到没人愿意随手跑。
  const allLogs = (() => {
    try {
      return listSessionLogs(home);
    } catch {
      return [];
    }
  })();
  for (const item of listed.items) {
    const want = String(item.sessionId).replace(/^session-/, "");
    if (!allLogs.some((p) => p.includes(want))) noLog += 1;
  }
  // 实测最近窗口的段速度（默认 6 小时，避开更早的死窗口）
  const windowH = Math.max(1, Number(getArg("window", 6)) || 6);
  const now = Date.now();
  const recent = marks.filter((m) => String(m?.trigger) === "archive-offline" && now - (Number(m?.at) || 0) < windowH * 3600e3).length;
  const schedule = {
    ...DEFAULT_SCHEDULE,
    intervalMin: Number(getArg("interval-min", DEFAULT_SCHEDULE.intervalMin)) || DEFAULT_SCHEDULE.intervalMin,
    max: Number(getArg("max", DEFAULT_SCHEDULE.max)) || DEFAULT_SCHEDULE.max,
    rounds: Number(getArg("rounds", DEFAULT_SCHEDULE.rounds)) || DEFAULT_SCHEDULE.rounds,
    budgetSec: Number(getArg("budget-sec", DEFAULT_SCHEDULE.budgetSec)) || DEFAULT_SCHEDULE.budgetSec,
    maxTokensCap: Number(getArg("max-tokens-cap", DEFAULT_SCHEDULE.maxTokensCap)) || DEFAULT_SCHEDULE.maxTokensCap,
  };
  // `--seg-sec` 直接把"每段秒数"钉成一个假设（真机报告里常见的 169s 就是这么来的）
  const segOverride = Number(getArg("seg-sec", 0));
  const speed = measured.outputTokens > 0 && measured.segmentSec > 0 ? measured.outputTokens / measured.segmentSec : 127.6;
  const capPlan = segmentPlan(schedule.maxTokensCap, { outputTokens: measured.outputTokens, speed, reasoningTokens: measured.reasoningMax });
  // ★ 容量按**均值**算，不按中位：一轮能装几段由平均值决定（p90=197s 的段会吃掉半轮预算）。
  //   用中位算会把容量高估 1.6 倍（48.5s vs 79s），于是"应该 99 小时"会被写成 60 小时。
  const segmentSec = segOverride > 0 ? segOverride : measured.meanSec;
  const measuredForRun = { ...measured, segmentSec, capSeconds: capPlan.seconds };
  const base = forecast({ items: listed.items, measured: measuredForRun, schedule, efficiency: 1 });
  const observedPerHour = recent / windowH;
  const ceilingPerHour = base.perHour;
  // ★ 用满率一律相对**真机默认调度**（间隔 30min / 预算 420s）算 —— 它描述的是"这台机器
  //   在现有配置下把预算用掉了多少"。若拿命令行改过的预算当基准，`--budget-sec 1800`
  //   会把用满率算成 19%，于是所有"要多少预算"的结论都虚高 4 倍（第一版就踩了这个）。
  const defaultCeiling = forecast({ items: listed.items, measured: measuredForRun, schedule: DEFAULT_SCHEDULE, efficiency: 1 }).perHour;
  const efficiency = defaultCeiling > 0 ? Math.max(0.01, Math.min(1, observedPerHour / defaultCeiling)) : 1;
  const real = forecast({ items: listed.items, measured: measuredForRun, schedule, efficiency });
  const out = {
    at: now,
    scanMs: Date.now() - t0,
    due: listed.due,
    noLog,
    measured: { ...measuredForRun, inputTokens: measured.inputTokens ?? null, speed },
    observed: { windowH, segments: recent, perHour: observedPerHour },
    schedule,
    base,
    real,
    sensitivity: [],
    targets: [24, 48, 72, 120].map((hours) =>
      invert({
        totalSegments: base.totalSegments,
        hours,
        intervalMin: schedule.intervalMin,
        rounds: schedule.rounds,
        segmentSec: base.segmentSec,
        efficiency,
        maxSessions: schedule.max,
      }),
    ),
  };
  for (const [max, rounds, budgetSec, cap] of [
    [5, 3, 420, 8192],
    [5, 3, 900, 8192],
    [5, 3, 1800, 8192],
    [5, 8, 900, 8192],
    [5, 8, 1800, 8192],
    [8, 8, 1800, 8192],
    [5, 8, 900, 4096],
    [5, 8, 900, 16384],
  ]) {
    const plan = segmentPlan(cap, { outputTokens: measured.outputTokens, speed, reasoningTokens: measured.reasoningMax });
    // 相对 cap 的缩放：以**实测均值**为锚，只让 cap 改变倍数（否则 base 用均值、表用"典型段"会自相矛盾）
    const segSec = segOverride > 0 ? segOverride : measured.meanSec * (plan.seconds / Math.max(1, capPlan.seconds));
    const rate = throughputPerHour({ ...schedule, max, rounds, budgetSec, maxTokensCap: cap, segmentSec: segSec });
    out.sensitivity.push({
      max,
      rounds,
      budgetSec,
      cap,
      segmentSec: segSec,
      retried: plan.retried === true,
      segmentsPerTick: rate.segmentsPerTick,
      perHour: rate.perHour,
      duty: rate.duty,
      hoursPerfect: rate.perHour === 0 ? Infinity : base.totalSegments / rate.perHour,
      hoursReal: rate.perHour === 0 ? Infinity : base.totalSegments / (rate.perHour * efficiency),
    });
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  const h = (x) => (Number.isFinite(x) ? `${x < 100 ? x.toFixed(1) : Math.round(x)}h` : "∞");
  const lines = [];
  lines.push(`== 补账测算（只读）==  ${base.sessions} 个欠账 · ${base.totalEvents.toLocaleString()} 欠账事件 · 需 **${base.totalSegments} 段**`);
  lines.push(`  每会话段数：中位 ${base.segmentsMedian} · p90 ${base.segmentsP90} · max ${base.segmentsMax}（按实测 ${measured.eventsPerSegment} 事件/段）`);
  lines.push(
    `  段耗时实测（${measured.n} 条 archive-offline）：中位 ${measured.segmentSec}s · **均值 ${measured.meanSec.toFixed(0)}s** · p90 ${measured.p90Sec}s · ` +
      `出字 ${measured.outputTokens} tok/段（${speed.toFixed(0)} tok/s）`,
  );
  lines.push(`  容量一律按**均值**算（一轮装几段由平均决定；按中位算会高估 ${(measured.meanSec / measured.segmentSec).toFixed(1)} 倍）`);
  lines.push(`  日志已不在、补不了的：${noLog} 个`);
  lines.push(`  估价（段数 × ${base.perSessionInput} in / ${base.perSessionOutput} out，$0.15/$0.60 每 M）：**$${base.costUsd.toFixed(2)}**`);
  lines.push(
    `  当前调度：每 ${schedule.intervalMin}min 一轮 · ≤${schedule.max} 会话 × ${schedule.rounds} 轮 · 预算 ${schedule.budgetSec}s ⇒ ` +
      `${base.segmentsPerTick} 段/轮（受限于${base.limitedBy === "budget" ? "预算" : "会话数×轮数"}）· 占空比 ${(base.duty * 100).toFixed(0)}%`,
  );
  lines.push(
    `    ⇒ 配置上限 ${ceilingPerHour.toFixed(1)} 段/h ⇒ 清偿 **${h(base.hoursPerfect)}**；` +
      `实测近 ${windowH}h ${observedPerHour.toFixed(1)} 段/h（用满率 ${(efficiency * 100).toFixed(0)}%）⇒ 清偿 **${h(real.hoursReal)}**`,
  );
  lines.push("");
  lines.push(`-- 敏感性（清偿小时 = ${base.totalSegments} 段 ÷ 段/h；max 是硬上限，>5 需改代码）--`);
  lines.push(`  max 轮 预算s    cap  段/轮  段/h   用满      按实测 ${(efficiency * 100).toFixed(0)}%`);
  for (const row of out.sensitivity) {
    const flag = row.retried ? "*" : " ";
    lines.push(
      `   ${String(row.max).padStart(3)} ${String(row.rounds).padStart(2)} ${String(row.budgetSec).padStart(5)} ${String(row.cap).padStart(6)}${flag} ${String(row.segmentsPerTick).padStart(5)} ${row.perHour.toFixed(1).padStart(6)} ${h(row.hoursPerfect).padStart(7)} ${h(row.hoursReal).padStart(12)}`,
    );
  }
  lines.push(`   * cap 太低：真机 reasoning 就有 3,436 token，正文档不下 ⇒ 触发"截断⇒放大 2 倍重试"，反而更慢`);
  lines.push("");
  for (const t of out.targets) {
    lines.push(
      `  ⇒ 要 **${t.hours}h** 内追平：${t.requiredPerHour.toFixed(1)} 段/h ⇒ 每轮 **${Math.max(1, t.requiredSessions)} 个会话 / ${t.requiredBudgetSec}s 预算**（间隔 ≤ ${t.requiredIntervalMin}min）· ${t.blocker}`,
    );
  }
  console.log(lines.join("\n"));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
