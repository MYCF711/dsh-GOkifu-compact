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
 *   node scripts/backfill-forecast.mjs --home "<DSH_HOME_OR_INSTALL_DIR> Harness/home"
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

/**
 * ★ C602：**引擎实配**（不是历史口径）。每个字段都钉到源码行 —— 别再漂。
 *
 * 2026-11-05 之前这里写的是 30min / 420s / 写死 3 轮，而 C601 早把引擎换成
 * 10min / 1800s / **动态轮数**了。测算器没跟着改，于是同一批欠账被算成 83h，
 * 实配只要 19h —— 差 4.3 倍全是配置差出来的，不是模型变快了。
 *
 *   · `intervalMin`  = 10   —— `src/engine.mjs:2026`
 *     `Math.max(5, Number(process.env.DSH_GOKIFU_AUTO_BACKFILL_MIN) || 10) * 60_000`
 *   · `max`          = 5    —— `src/engine.mjs:2113-2114`
 *     （积压 >100 ⇒ 5 个；进来后仍过 `Math.max(0, Math.min(5, adaptive))`）
 *   · `rounds`       = 3    —— `src/engine.mjs:2241` 的**保底**轮数（`roundsFloor`）
 *   · `roundsCap`    = 8    —— `src/engine.mjs:2242` → `src/rooms/offline-fold.mjs:417-426`
 *     （实际轮数 = `max(保底, min(8, floor(剩余预算 ÷ 实测段耗时)))`，**不是写死 3**）
 *   · `budgetSec`    = 1800 —— `src/engine.mjs:2195`
 *     （`|| (dueNow > 100 ? 1800 : 240)`；真机积压 >100，走 1800s 分支）
 *   · `maxTokensCap` = 8192 —— `src/rooms/offline-fold.mjs:390` 的 `foldBudgetFor` 默认值
 *
 * `roundsCap <= 0` 表示**关掉动态轮数**（退回写死 `rounds` 轮的旧行为）。
 */
export const DEFAULT_SCHEDULE = {
  // ★ C606（T9 未完成，Lead 收尾）：**默认值必须等于引擎实配**，否则同一个欠账会被算成两种清偿期。
  //   引擎：间隔 `src/engine.mjs:2026` = 10 分钟；预算 `:2195` = 积压>100 时 1800 秒；
  //   轮数由剩余预算 ÷ 实测段耗时动态算（`roundsCap` = 8）。
  intervalMin: 10,
  max: 5,
  rounds: 3,
  roundsCap: 8,
  budgetSec: 1800,
  maxTokensCap: 8192,
};

/**
 * ★ C602：**旧口径**（C601 之前：30min 间隔 / 420s 预算 / 写死 3 轮）。
 *
 * 它只剩两个用途，别拿来当默认值：
 *   ① 输出里的**对照行** —— 让人一眼看到"83h vs 19h"是配置差出来的；
 *   ② **用满率的分母**（见 `buildReport`）—— `recent` 那批折痕是在旧口径下跑出来的，
 *      拿实配当分母会把"配置升级"重复算成"用满率下降"，把 19h 又算回 83h。
 */
export const LEGACY_SCHEDULE = {
  intervalMin: 30,
  max: 5,
  rounds: 3,
  roundsCap: 0, // 0 = 不按预算加轮（旧口径写死 3 轮）
  budgetSec: 420,
  maxTokensCap: 8192,
};

/**
 * ★ **每轮会话数的代码硬上限** = `src/engine.mjs:2114` 的 `Math.max(0, Math.min(5, adaptive))`。
 *
 * 环境变量 `DSH_GOKIFU_AUTO_BACKFILL_MAX` 只是喂给 `adaptive` 的**输入**，进来之后**仍要过这道
 * `Math.min(5, ...)`** ⇒ 把它设成 8 不会多补一个会话，只会让人以为改过了。
 * 所以测算器可以模拟 `--max=8`，但必须在输出里把这件事说破（见 `HARD_CAP_MARK`），
 * 否则"值不值得改代码"会被答成"改个环境变量就行"。
 */
export const HARD_MAX_SESSIONS = 5;

/** 超过硬上限时输出里**必须原样出现**的那句话（别让人误以为改个 env 就行）。 */
export const HARD_CAP_MARK = "需改代码（`Math.min(5, ...)`）";

/** 结论要给的三个追平档位（小时）。 */
export const TARGET_HOURS = [24, 48, 72];

/** 敏感性矩阵：`[max, rounds, budgetSec, maxTokensCap]`。 */
export const SENSITIVITY_MATRIX = [
  [5, 3, 420, 8192],
  [5, 3, 900, 8192],
  [5, 3, 1800, 8192],
  [5, 8, 900, 8192],
  [5, 8, 1800, 8192],
  [8, 8, 1800, 8192],
  [5, 8, 900, 4096],
  [5, 8, 900, 16384],
];

/* ───────────────────────── 命令行解析（纯函数，便于单测） ───────────────────────── */

/**
 * 每个 `--选项` 的取值契约。
 *
 * 为什么要有这张表：旧版用 `argv.indexOf("--max")` 取值，**等号写法 `--max=8` 匹配不上**
 * ⇒ 静默回落到 5，输出看起来跟没传一样。测算器的用途是回答"值不值得改代码提高上限"，
 * 静默夹一个数就是给出错误结论 —— 所以这里改成"两种写法都认 + 越界就明说 + 非法就退出"。
 */
const OPTION_SPECS = {
  home: { key: "home", kind: "string", label: "DSH_HOME 路径" },
  "graph-dir": { key: "graphDir", kind: "string", label: "图目录路径" },
  "seg-sec": { key: "segSec", kind: "num", min: 0, max: 86_400, label: "每段秒数（0 = 用实测均值）" },
  window: { key: "window", kind: "num", min: 0.1, max: 8760, label: "实测窗口（小时）" },
  "interval-min": { key: "intervalMin", kind: "num", min: 1, max: 1440, label: "每轮间隔（分钟）" },
  max: { key: "max", kind: "int", min: 1, max: 1000, label: "每轮会话数" },
  rounds: { key: "rounds", kind: "int", min: 1, max: 100, label: "每会话轮数" },
  "budget-sec": { key: "budgetSec", kind: "num", min: 1, max: 86_400, label: "每轮预算（秒）" },
  "max-tokens-cap": { key: "maxTokensCap", kind: "int", min: 1024, max: 65_536, label: "单段输出上限（token）" },
};

/** 用法说明（`--help` 与参数报错时都打它）。 */
export function usage() {
  return [
    "用法：node scripts/backfill-forecast.mjs [选项]",
    "  --home <dir>            DSH_HOME（默认 $DSH_HOME）",
    "  --graph-dir <dir>       图目录（默认 <home>/chess-context/sessions）",
    `  --max=<n>               每轮会话数；>${HARD_MAX_SESSIONS} 只是**情景模拟**：${HARD_CAP_MARK}`,
    "  --rounds=<n>            每会话**保底**轮数（实际轮数 = max(保底, 预算÷段耗时)，天花板 8）",
    "  --budget-sec=<s>        每轮时间预算（秒）",
    "  --interval-min=<min>    每轮间隔（分钟）",
    "  --max-tokens-cap=<n>    单段输出上限（token）",
    "  --seg-sec=<s>           直接钉住每段秒数（0 = 用真机实测均值）",
    "  --window=<h>            实测速率窗口（小时，默认 6）",
    "  --json                  输出 JSON",
    "  --help                  打这张表",
    "两种写法都认：`--max 8` 与 `--max=8`。",
  ].join("\n");
}

/**
 * 解析命令行。**纯函数**（不碰磁盘），返回 `{options, errors, help}`。
 * 任何非法取值都进 `errors`（人话），由 `main` 转成退出码 1。
 *
 * @param {string[]} [argv]
 * @returns {{options:object, errors:string[], help:boolean}}
 */
export function parseCli(argv = []) {
  const options = {
    home: process.env.DSH_HOME ?? "",
    graphDir: null,
    segSec: 0,
    window: 6,
    intervalMin: DEFAULT_SCHEDULE.intervalMin,
    max: DEFAULT_SCHEDULE.max,
    rounds: DEFAULT_SCHEDULE.rounds,
    budgetSec: DEFAULT_SCHEDULE.budgetSec,
    maxTokensCap: DEFAULT_SCHEDULE.maxTokensCap,
    json: false,
  };
  const errors = [];
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? "");
    if (raw === "--json") {
      options.json = true;
      continue;
    }
    if (raw === "--help" || raw === "-h") {
      help = true;
      continue;
    }
    if (!raw.startsWith("--")) {
      errors.push(`多余的参数 "${raw}"（本脚本只认 --选项，见 --help）`);
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const spec = OPTION_SPECS[name];
    if (spec === undefined) {
      errors.push(`未知参数 --${name}（见 --help）`);
      continue;
    }
    let value;
    if (eq >= 0) value = raw.slice(eq + 1);
    else {
      value = argv[i + 1];
      i += 1;
      if (value === undefined || String(value).startsWith("--")) {
        errors.push(`--${name} 缺少取值（应为：--${name}=<${spec.label}>）`);
        continue;
      }
    }
    if (spec.kind === "string") {
      if (String(value) === "") errors.push(`--${name} 不能是空字符串（应为：${spec.label}）`);
      else options[spec.key] = String(value);
      continue;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      errors.push(`--${name} 必须是数字（${spec.label}），收到 "${value}"`);
      continue;
    }
    if (spec.kind === "int" && !Number.isInteger(num)) {
      errors.push(`--${name} 必须是整数（${spec.label}），收到 "${value}"`);
      continue;
    }
    if (num < spec.min || num > spec.max) {
      errors.push(`--${name} 超出范围 ${spec.min}..${spec.max}（${spec.label}），收到 "${value}"`);
      continue;
    }
    options[spec.key] = num;
  }
  return { options, errors, help };
}

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
 * ★ C602：**每会话每轮能连开几段** —— 与引擎同一算术。
 *
 * 引擎：`const rounds = Math.max(roundsFloor, autoBackfillRounds(segMs, 剩余预算))`
 * （`src/engine.mjs:2241-2242`），而 `autoBackfillRounds` 就是
 * `roundsWithinBudget({ remainingMs, segmentMs, cap: 8 })`（`src/rooms/offline-fold.mjs:417-426`）：
 * `max(保底, min(天花板, floor(剩余 ÷ 段耗时)))`。
 *
 * 为什么要单独一个函数：预算 1800s 时写死 3 轮只用掉 237s（**78% 预算空转**），
 * 而按预算动态加轮才能算出"实配 19h"而不是旧口径的 83h。
 *
 * @param {{budgetSec?:number, segmentSec?:number, rounds?:number, roundsCap?:number}} [args]
 * @returns {number} 整数轮数；`roundsCap <= 0` ⇒ 关掉动态，直接返回保底轮数
 */
export function roundsForBudget({ budgetSec = 0, segmentSec = 0, rounds = 3, roundsCap = 0 } = {}) {
  const floor = Math.max(1, Math.floor(Number(rounds) || 1));
  const cap = Number(roundsCap) > 0 ? Math.max(floor, Math.floor(Number(roundsCap))) : floor;
  const fit = Math.floor(Math.max(0, Number(budgetSec) || 0) / Math.max(1, Number(segmentSec) || 1));
  return Math.max(floor, Math.min(cap, fit));
}

/**
 * ★ C599：**一轮 tick 能开几段**。纯函数，便于单测。
 *
 * 两层上限都要算：会话数 × 每会话轮数（`max × rounds`），以及时间预算能装下几段。
 * 这里**不加 1**（引擎的预算判据是"已超预算才 break"，可以多开一段；测算取保守口径）。
 *
 * `rounds` 是**已经解析好的**每会话轮数（动态轮数先过 `roundsForBudget`，见 `throughputPerHour`）。
 *
 * @param {{budgetSec?:number, segmentSec?:number, max?:number, rounds?:number}} args
 * @returns {{segments:number, limitedBy:"sessions"|"budget"}}
 */
export function segmentsPerTick({ budgetSec = DEFAULT_SCHEDULE.budgetSec, segmentSec = 48, max = DEFAULT_SCHEDULE.max, rounds = DEFAULT_SCHEDULE.rounds } = {}) {
  const bySessions = Math.max(0, Number(max) || 0) * Math.max(1, Number(rounds) || 1);
  const sec = Math.max(1, Number(segmentSec) || 1);
  const byBudget = Math.floor(Math.max(0, Number(budgetSec) || 0) / sec);
  return byBudget >= bySessions ? { segments: bySessions, limitedBy: "sessions" } : { segments: byBudget, limitedBy: "budget" };
}

/**
 * ★ C599：**调度吞吐模型**（段/小时）。纯函数，便于单测。
 *
 * 关键是"占空比"：预算只占间隔的一小部分时，一天里大部分时间在等下一轮。
 * 引擎的 `_autoBackfillBusy` 会让重叠的 tick 直接返回，所以当 `预算 > 间隔` 时，
 * 实际节奏是 `max(间隔, 本轮耗时)` —— 这一点必须建模，否则"把预算调到 3600s"会算成神仙数字。
 *
 * ★ C602：轮数不再写死 —— `rounds` 是**保底**，`roundsCap` 是天花板，实际轮数由
 * `roundsForBudget` 按 `预算 ÷ 段耗时` 算（与 `src/engine.mjs:2242` 同口径）。
 *
 * @param {{intervalMin?:number, budgetSec?:number, segmentSec?:number, max?:number, rounds?:number, roundsCap?:number}} schedule
 * @returns {{segmentsPerTick:number, tickPeriodSec:number, perHour:number, duty:number, limitedBy:string, rounds:number}}
 */
export function throughputPerHour({
  intervalMin = DEFAULT_SCHEDULE.intervalMin,
  budgetSec = DEFAULT_SCHEDULE.budgetSec,
  segmentSec = 48,
  max = DEFAULT_SCHEDULE.max,
  rounds = DEFAULT_SCHEDULE.rounds,
  roundsCap = DEFAULT_SCHEDULE.roundsCap,
} = {}) {
  const perSession = roundsForBudget({ budgetSec, segmentSec, rounds, roundsCap });
  const tick = segmentsPerTick({ budgetSec, segmentSec, max, rounds: perSession });
  const intervalSec = Math.max(1, (Number(intervalMin) || DEFAULT_SCHEDULE.intervalMin) * 60);
  const busySec = tick.segments * Math.max(1, Number(segmentSec) || 1);
  const period = Math.max(intervalSec, busySec);
  return {
    segmentsPerTick: tick.segments,
    tickPeriodSec: period,
    perHour: tick.segments === 0 ? 0 : (tick.segments * 3600) / period,
    duty: Math.min(1, busySec / period),
    limitedBy: tick.limitedBy,
    rounds: perSession,
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
    // ★ C602：本轮实际开的轮数（= max(保底, 预算÷段耗时)，天花板 8）—— 不是配置里的保底值
    rounds: rate.rounds,
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
 * ★ C602：**整段取整**。引擎一轮只能开**整段**（`Math.floor(预算 ÷ 段耗时)`，
 * `src/rooms/offline-fold.mjs:425`），所以反解不能拿"小数段"去算预算：
 * 48h 档需要 10.49 段时，旧实现给 780s（只装得下 10 段）⇒ 实际 50.4h（慢 2.4h / +5%）。
 * 现在：段数先 `ceil` 到整段，预算 = `ceil(整段数 ÷ 用满率) × 段耗时` ——
 * 预算**一定是段耗时的整数倍**，装得下它自己报的整段数（见 `fitsSegments`）。
 *
 * @param {object} args
 * @param {number} args.totalSegments 要折多少段
 * @param {number} args.hours 目标 T
 * @param {{intervalMin?:number, rounds?:number, segmentSec?:number, efficiency?:number, maxSessions?:number}} [args.schedule]
 * @returns {{hours:number, requiredPerHour:number, requiredSegmentsPerTick:number, requiredWholeSegments:number, requiredBudgetSec:number, requiredBudgetSegments:number, fitsSegments:boolean, requiredSessions:number, requiredIntervalMin:number, segmentSec:number, feasible:boolean, blocker:string}}
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
  // ★ C602：引擎只开整段 ⇒ 小数段一律向上取整（10.49 段 = 11 段预算）
  const requiredWholeSegments = Math.ceil(requiredSegmentsPerTick);
  const requiredSessions = Math.ceil(requiredWholeSegments / perRound);
  // 预算按"实测用满率"折算：用满率 52% 时，想要 10 段就得给 10/0.52 段的预算。
  // 再 `ceil` 到**整段边界**：`ceil(整段数 ÷ 用满率)` 个段时长 —— 这样
  // `floor(预算 ÷ 段耗时) ≥ 整段数` 恒成立（不再是"780s 只装得下 10 段"）。
  const requiredBudgetSegments = Math.ceil(requiredWholeSegments / eff);
  const requiredBudgetSec = Math.ceil(requiredBudgetSegments * segSec);
  const fitsSegments = Math.floor(requiredBudgetSec / segSec + 1e-9) >= requiredWholeSegments;
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
    requiredWholeSegments,
    requiredBudgetSec,
    requiredBudgetSegments,
    fitsSegments,
    requiredSessions,
    requiredIntervalMin,
    segmentSec: segSec,
    feasible: blockers.length === 0,
    blocker: (blockers.length === 0 ? "现上限之内（只需调预算）" : blockers.join("；")) + `；${note}`,
  };
}

/**
 * 把「实测 + 欠账 + 调度」算成完整报告对象。**纯函数**（不碰磁盘、不调模型），便于单测。
 *
 * 从 `main` 里抽出来的原因：`--max=8` 那条情景必须能被**离线**断言（不能靠跑真机数据），
 * 否则"旧实现会静默夹到 5"这件事永远没测试守着。
 *
 * @param {object} args
 * @param {Array<object>} [args.items] `listDebts` 的产出
 * @param {object} [args.measured] `measureFromMarks` 的产出（`meanSec` 必须是真的实测值）
 * @param {number} [args.recent] 近 `windowH` 小时的实测段数
 * @param {number} [args.windowH] 实测窗口（小时）
 * @param {typeof DEFAULT_SCHEDULE} [args.schedule]
 * @param {number} [args.segOverride] `--seg-sec` 的钉死值（0 = 用实测均值）
 * @returns {object}
 */
export function buildReport({ items = [], measured = {}, recent = 0, windowH = 6, schedule = DEFAULT_SCHEDULE, segOverride = 0 } = {}) {
  const sched = { ...DEFAULT_SCHEDULE, ...(schedule ?? {}) };
  const windowHNum = Math.max(0.1, Number(windowH) || 6);
  const meanSec = Number(measured.meanSec) > 0 ? Number(measured.meanSec) : 48;
  // 出字速度：段耗时与输出 token 都是实测的，别在这里塞常数（硬规矩：数字必须来自真机折痕）
  const speed = Number(measured.outputTokens) > 0 && Number(measured.segmentSec) > 0 ? Number(measured.outputTokens) / Number(measured.segmentSec) : 127.6;
  const capPlan = segmentPlan(sched.maxTokensCap, { outputTokens: measured.outputTokens, speed, reasoningTokens: measured.reasoningMax });
  // ★ 容量按**均值**算，不按中位：一轮能装几段由平均值决定（p90=197s 的段会吃掉半轮预算）。
  //   用中位算会把容量高估 1.6 倍（48.5s vs 79s），于是"应该 99 小时"会被写成 60 小时。
  const segmentSec = Number(segOverride) > 0 ? Number(segOverride) : meanSec;
  const measuredForRun = { ...measured, segmentSec, capSeconds: capPlan.seconds };
  const base = forecast({ items, measured: measuredForRun, schedule: sched, efficiency: 1 });
  const observedPerHour = Number(recent) / windowHNum;
  // ★ 用满率一律相对**观测发生时的调度**算 —— 它描述的是"这台机器把那套调度用掉了多少"。
  //   ★ C602：基准固定成**旧口径**（30min / 420s），不是 `DEFAULT_SCHEDULE`。`recent` 那批折痕
  //   是在旧口径下跑出来的；拿实配（10min/1800s）当分母会把"配置升级"重复算成"用满率下降"，
  //   把 19h 又算回 83h。命令行改过的预算更不许当基准（`--budget-sec 1800` 会把用满率算成 19%，
  //   于是所有"要多少预算"的结论都虚高 4 倍 —— 第一版就踩了这个）。
  const legacy = forecast({ items, measured: measuredForRun, schedule: LEGACY_SCHEDULE, efficiency: 1 });
  const efficiency = legacy.perHour > 0 ? Math.max(0.01, Math.min(1, observedPerHour / legacy.perHour)) : 1;
  const real = forecast({ items, measured: measuredForRun, schedule: sched, efficiency });
  const out = {
    at: Date.now(),
    scanMs: 0,
    due: items.length,
    noLog: 0,
    hardMax: HARD_MAX_SESSIONS,
    overHardCap: Number(sched.max) > HARD_MAX_SESSIONS,
    hardCapNote: HARD_CAP_MARK,
    measured: { ...measuredForRun, inputTokens: Number.isFinite(Number(measured.inputTokens)) && Number(measured.inputTokens) > 0 ? Number(measured.inputTokens) : null, speed },
    observed: { windowH: windowHNum, segments: Number(recent) || 0, perHour: observedPerHour },
    schedule: sched,
    base,
    real,
    // ★ C602：旧口径（30min/420s/写死 3 轮）的同一批欠账 —— 输出里的对照行靠它算"差几倍"
    legacy,
    sensitivity: [],
    // ★ 反解一律按**真实硬上限**（5）判可行性：`--max=8` 只是"如果改了代码会怎样"，
    //   不能让 invert 拿 8 当上限，否则它会说"做得到"—— 那就是骗人。
    targets: TARGET_HOURS.map((hours) =>
      invert({
        totalSegments: base.totalSegments,
        hours,
        intervalMin: sched.intervalMin,
        rounds: sched.rounds,
        segmentSec: base.segmentSec,
        efficiency,
        maxSessions: HARD_MAX_SESSIONS,
      }),
    ),
  };
  for (const [max, rounds, budgetSec, cap] of SENSITIVITY_MATRIX) {
    const plan = segmentPlan(cap, { outputTokens: measured.outputTokens, speed, reasoningTokens: measured.reasoningMax });
    // 相对 cap 的缩放：以**实测均值**为锚，只让 cap 改变倍数（否则 base 用均值、表用"典型段"会自相矛盾）
    const segSec = Number(segOverride) > 0 ? Number(segOverride) : meanSec * (plan.seconds / Math.max(1, capPlan.seconds));
    const rate = throughputPerHour({ ...sched, max, rounds, budgetSec, maxTokensCap: cap, segmentSec: segSec });
    out.sensitivity.push({
      max,
      // ★ C602：显示**实际轮数**（= max(保底, min(8, 预算÷段耗时))），不是配置里的保底值 ——
      //   否则 `5 会话 × 3 轮` 旁边写出 `25 段/轮` 会自相矛盾。
      rounds: rate.rounds,
      roundsFloor: rounds,
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
  return out;
}

/**
 * 把报告对象渲染成文本。**纯函数**，`main` 只负责 `console.log`。
 *
 * 三处必须说到的实话（否则"值不值得改代码"会被答错）：
 *   ① `--max>5` 的调度是**情景模拟**，真机跑不到（`Math.min(5, ...)` 写死在引擎里）；
 *   ② 敏感性表里 max>5 的行同样要标出来 —— 那张表最容易被当成"配置建议"；
 *   ③ 末尾三条反解（T = 24 / 48 / 72 小时）是这份报告的**结论行**，要能一眼看出每轮要几个会话。
 *   ④ ★ C602：**旧口径 / 实配对照行**必须打出来 —— 同一批欠账 83h 变 19h 是配置差出来的，
 *      不是模型变快；不打这一行，读的人会以为测算器在挑好看的数字。
 *
 * @param {object} out `buildReport` 的产出
 * @returns {string}
 */
export function formatReport(out) {
  const { base, real, measured, schedule, observed } = out;
  const windowH = observed.windowH;
  const efficiency = real.efficiency;
  const h = (x) => (Number.isFinite(x) ? `${x < 100 ? x.toFixed(1) : Math.round(x)}h` : "∞");
  const lines = [];
  lines.push(`== 补账测算（只读）==  ${base.sessions} 个欠账 · ${base.totalEvents.toLocaleString()} 欠账事件 · 需 **${base.totalSegments} 段**`);
  lines.push(`  每会话段数：中位 ${base.segmentsMedian} · p90 ${base.segmentsP90} · max ${base.segmentsMax}（按实测 ${measured.eventsPerSegment} 事件/段）`);
  lines.push(
    `  段耗时实测（${measured.n} 条 archive-offline）：中位 ${measured.segmentSec}s · **均值 ${measured.meanSec.toFixed(0)}s** · p90 ${measured.p90Sec}s · ` +
      `出字 ${measured.outputTokens} tok/段（${measured.speed.toFixed(0)} tok/s）`,
  );
  lines.push(`  容量一律按**均值**算（一轮装几段由平均决定；按中位算会高估 ${(measured.meanSec / measured.segmentSec).toFixed(1)} 倍）`);
  lines.push(`  日志已不在、补不了的：${out.noLog} 个`);
  lines.push(`  估价（段数 × ${base.perSessionInput} in / ${base.perSessionOutput} out，$0.15/$0.60 每 M）：**$${base.costUsd.toFixed(2)}**`);
  lines.push(
    `  当前调度：每 ${schedule.intervalMin}min 一轮 · ≤${schedule.max} 会话 × ${base.rounds} 轮 · 预算 ${schedule.budgetSec}s ⇒ ` +
      `${base.segmentsPerTick} 段/轮（受限于${base.limitedBy === "budget" ? "预算" : "会话数×轮数"}）· 占空比 ${(base.duty * 100).toFixed(0)}%`,
  );
  // ★ 情景标注：`--max>5` 必须当场说破，否则读的人会以为"改个 env 就行"。
  if (out.overHardCap === true) {
    lines.push(
      `  ⚠ 上面这行是**情景模拟**（--max=${schedule.max}），真机配不出来：每轮会话数硬上限 ${out.hardMax} —— ` +
        `${out.hardCapNote}，改 env 不管用（DSH_GOKIFU_AUTO_BACKFILL_MAX 进来后仍过 Math.min(${out.hardMax}, adaptive)）`,
    );
  }
  lines.push(
    `    ⇒ 配置上限 ${base.perHour.toFixed(1)} 段/h ⇒ 清偿 **${h(base.hoursPerfect)}**；` +
      `实测近 ${windowH}h ${observed.perHour.toFixed(1)} 段/h（用满率 ${(efficiency * 100).toFixed(0)}%）⇒ 清偿 **${h(real.hoursReal)}**`,
  );
  // ★ C602：**新旧口径对照行**。同一批欠账、同一个段耗时，两套调度差几倍全在这一行里。
  //   没有它，没人知道"83h 变 19h"是配置改出来的（模型没变快、并发也没加）。
  const legacyHours = out.legacy?.hoursPerfect ?? NaN;
  const speedup = Number.isFinite(legacyHours) && base.hoursPerfect > 0 ? legacyHours / base.hoursPerfect : NaN;
  lines.push(
    `  旧口径(30min/420s) = ${h(legacyHours)} · 实配(${schedule.intervalMin}min/${schedule.budgetSec}s) = ${h(base.hoursPerfect)}` +
      (Number.isFinite(speedup) && speedup > 0 ? `（相差 ${speedup.toFixed(1)}×）` : ""),
  );
  lines.push("");
  lines.push(`-- 敏感性（清偿小时 = ${base.totalSegments} 段 ÷ 段/h；max 是硬上限，>${out.hardMax} ${out.hardCapNote}）--`);
  lines.push(`  max 轮 预算s    cap  段/轮  段/h   用满      按实测 ${(efficiency * 100).toFixed(0)}%`);
  for (const row of out.sensitivity) {
    const flag = row.retried ? "*" : " ";
    const over = row.max > out.hardMax ? `   ← ${out.hardCapNote}` : "";
    lines.push(
      `   ${String(row.max).padStart(3)} ${String(row.rounds).padStart(2)} ${String(row.budgetSec).padStart(5)} ${String(row.cap).padStart(6)}${flag} ${String(row.segmentsPerTick).padStart(5)} ${row.perHour.toFixed(1).padStart(6)} ${h(row.hoursPerfect).padStart(7)} ${h(row.hoursReal).padStart(12)}${over}`,
    );
  }
  lines.push(`   * cap 太低：真机 reasoning 就有 3,436 token，正文档不下 ⇒ 触发"截断⇒放大 2 倍重试"，反而更慢`);
  lines.push("");
  lines.push(`-- 结论：要 T 小时追平 ⇒ 每轮 X 个会话 / Y 秒预算（T = ${out.targets.map((t) => t.hours).join(" / ")} 小时）--`);
  for (const t of out.targets) {
    const sessions = Math.max(1, t.requiredSessions);
    const over = sessions > out.hardMax ? `   ← ${out.hardCapNote}（每轮会话数 ${sessions} > 硬上限 ${out.hardMax}）` : "";
    // ★ C602：**当场验算**预算装得下几整段 —— 旧实现 48h 档给 780s 只装得下 10 段，
    //   实际要跑 50.4h（+5%）。这里把 `floor(预算 ÷ 段耗时)` 与所需整段数并排放，装不下会打 ✗。
    const fitSegments = Math.floor(t.requiredBudgetSec / t.segmentSec + 1e-9);
    const fitNote = `；验算：floor(${Math.round(t.requiredBudgetSec)}s ÷ ${Math.round(t.segmentSec)}s) = ${fitSegments} 整段 ≥ 需 ${t.requiredWholeSegments} 段 ${t.fitsSegments ? "✓" : "✗"}`;
    lines.push(
      `  要 ${t.hours} 小时追平 ⇒ 每轮 ${sessions} 个会话 / ${t.requiredBudgetSec} 秒预算（${t.requiredPerHour.toFixed(1)} 段/h · 间隔 ≤ ${t.requiredIntervalMin}min${fitNote}）${over}`,
    );
  }
  return lines.join("\n");
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
  const { options, errors, help } = parseCli(argv);
  if (help === true) {
    console.log(usage());
    return 0;
  }
  // ★ 参数非法必须真红：静默取值会让"值不值得改代码"这个结论建立在错的调度上
  //   （旧版 `--max=8` 就是这么被静默夹成 5 的 —— 见 test/backfill-forecast.test.mjs）
  if (errors.length > 0) {
    console.error(`✗ 参数不合法：\n  · ${errors.join("\n  · ")}\n\n${usage()}`);
    return 1;
  }
  const home = options.home;
  if (home === "") {
    console.error("需要 --home <DSH_HOME>（或设 DSH_HOME）");
    return 2;
  }
  const sessionsRoot = options.graphDir ?? nodePath.join(home, "chess-context", "sessions");
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
  const windowH = Math.max(1, Number(options.window) || 6);
  const now = Date.now();
  const recent = marks.filter((m) => String(m?.trigger) === "archive-offline" && now - (Number(m?.at) || 0) < windowH * 3600e3).length;
  const schedule = {
    ...DEFAULT_SCHEDULE,
    intervalMin: options.intervalMin,
    max: options.max,
    rounds: options.rounds,
    budgetSec: options.budgetSec,
    maxTokensCap: options.maxTokensCap,
  };
  // `--seg-sec` 直接把"每段秒数"钉成一个假设（真机报告里常见的 169s 就是这么来的）
  const out = buildReport({ items: listed.items, measured, recent, windowH, schedule, segOverride: options.segSec });
  // 扫描耗时是 IO 事实，由 `main` 补上（`buildReport` 是纯函数，不读时钟）
  out.at = now;
  out.scanMs = Date.now() - t0;
  out.due = listed.due;
  out.noLog = noLog;
  if (options.json === true) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log(formatReport(out));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
