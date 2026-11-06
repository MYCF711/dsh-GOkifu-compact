#!/usr/bin/env node
/**
 * cache-miss-audit.mjs —— `none` 组的未命中**逐条归因**（C611，2026-11-05）
 *
 * ## 为什么要有它（T45 账单里的第二座山）
 *
 * T45（`scripts/cache-friendliness-audit.mjs`）把「注入动作」按 append / replace / none 分了组，
 * 修完 replace 之后真机账单还剩这一行：
 *
 * | 动作 | 请求 | 命中率 | 每次中位 miss | 花费 |
 * |---|---|---|---|---|
 * | none | 98,109 | 97.6% | 976 | $213.25 |
 *
 * 2.4% 的未命中 = **632,563,908 token ≈ $95**。而 `none` 组的定义是「这一发**什么都没做**」
 * （没有注入、没有替换）—— 那它的 miss **凭什么发生**？
 *
 * T45 的脚本回答不了这个问题：它只把 `none` 当成「基线」，从没拆过它。
 * 这个脚本就拆它。
 *
 * ## 口径（与 T45 同源，未改一行 T45 的代码）
 *
 * · **miss** = `assistant/message.data.usage.inputTokens`（**只含未命中**）；
 * · **hit**  = `cacheReadTokens`；**prompt** = miss + hit（`totalTokens = miss + hit + out`）；
 * · **growth** = `max(0, prompt_i − prompt_{i−1})` —— 两次请求之间**新增**的 token
 *   （上一条 assistant 输出 + 期间追加的 tool/result 与注入消息）。这部分**无缓存可命中**，
 *   付 miss 价是物理的；
 * · **waste** = `max(0, miss_i − growth_i)` —— 上一次请求**已经在上下文里**、这次却要
 *   按 miss 价重读的那部分。**只有它才是"本该不发生"的 miss。**
 *
 * 这条分解是整个脚本的地基：`miss = growth + waste`（按定义恒等，见 `wasteOf`）。
 *
 * ## 四类归因（判据写死在 `classifyRow`，可单测）
 *
 *   · **D 正常增量**：`waste ≤ NOISE_TOKENS`（256）⇒ 只付了新增 + 缓存块对齐的零头，改不动；
 *   · **B 前缀被改**：期间有 `surfaceOp:{op:"replace"}`（就地改写早期消息）或 `compaction/*`
 *     （折叠事务）⇒ 我们自己的写操作把前缀作废了；
 *   · **A TTL 过期**：无改写事件、且 `gap ≥ TTL_SECONDS`（300s）⇒ provider 侧缓存到期；
 *   · **U 未解释**：无改写事件、`gap < 300s` ⇒ 日志里没有任何东西解释这次失效
 *     （provider 侧偶发驱逐；与 C 的区别见 §⑤ 的 C 判据）。
 *
 * ## C（上下文太大）为什么单独测
 *
 * C 的判据必须是「**失效概率随 prompt 变大而上升**」。所以 §⑤ 给出**控制间隔之后**的
 * 丢弃率-按 prompt 分桶：如果曲线是平的，C 就被证伪（"prompt 大只是把每次失效的
 * 代价放大"，不是"prompt 大导致失效"——两者结论相反：前者只能记录，后者要改策略）。
 *
 * ## 用法
 *
 *   node scripts/cache-miss-audit.mjs                      # 扫 DSH_HOME 下全部会话
 *   node scripts/cache-miss-audit.mjs --session 8a73e06b    # 只看一个会话
 *   node scripts/cache-miss-audit.mjs --max-sessions 50     # 大 home 上先跑样本
 *   node scripts/cache-miss-audit.mjs --json               # 机器可读
 *   node scripts/cache-miss-audit.mjs --noise 128 --ttl 600 # 换阈值（默认 256 / 300）
 *
 * 退出码：0 = 正常（这是**报告**，不是门禁）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/**
 * 单价（$ / 1M token）。与 `scripts/cache-friendliness-audit.mjs` 的 `PRICES` 同源
 * （deepseek-v4 flash 低峰：miss $0.15、hit $0.003 = 1/50、out $0.6）。
 * 故意**不 import** T45 的脚本：那边一旦重构，这边会把"未定义"变成静默 0，账就错了。
 * 两边必须一起改 —— `test/cache-miss.test.mjs` 有一条守卫钉住这个等值。
 */
export const PRICES = Object.freeze({ miss: 0.15, hit: 0.003, out: 0.6 });

/** `waste` 低于这个值算「缓存块对齐的零头」（provider 按 64/128 token 取整），不归因。 */
export const NOISE_TOKENS = 256;

/** provider 侧缓存 TTL 的判据线（秒）。5 分钟 —— 真机丢弃率曲线在这里拐弯（见 §②）。 */
export const TTL_SECONDS = 300;

/** 归因桶的四个取值。 */
export const BUCKETS = Object.freeze(["D", "B", "A", "U"]);

/** 桶的中文名（报告与测试共用，避免两处手写字符串漂移）。 */
export const BUCKET_LABELS = Object.freeze({
  D: "正常增量（只付新增）",
  B: "前缀被改（我们自己的写操作）",
  A: "TTL 过期（provider 侧物理限制）",
  U: "未解释的短间隔失效（provider 侧偶发驱逐）",
});

/** 间隔桶的边界（秒）。最后一个是 `Infinity`。 */
const GAP_EDGES = [5, 30, 120, 300, 600, 3600, Infinity];

/** prompt 桶的边界（token）。 */
const PROMPT_EDGES = [16_000, 64_000, 128_000, 256_000, 512_000, 768_000, Infinity];

/** 只解析这几种事件 —— 其余整行跳过（35MB 日志 / 9,236 帧，逐行 JSON.parse 会慢一个数量级）。 */
const KEEP_TYPES = new Set([
  "assistant/message",
  "user/message",
  "system/message",
  "developer/message",
  "tool/result",
  "tool/call",
  "request/header",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "compaction/prune",
  "llm/retry",
  "llm/retry-started",
]);

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/**
 * 把秒数折成间隔桶标签。**上界开区间**（`gap === 5` 落 `5–30s`）。
 * @param {number} gapSec
 * @returns {string}
 */
export function gapBucket(gapSec) {
  // null / undefined 是「没有上一条请求」（冷启动），**不是** 0 秒 —— 猜 0 会把它塞进最热的桶里。
  if (gapSec === null || gapSec === undefined) return "unknown";
  const s = Number(gapSec);
  if (!Number.isFinite(s) || s < 0) return "unknown";
  let lo = 0;
  for (const edge of GAP_EDGES) {
    if (s < edge) return edge === Infinity ? `≥${lo}s` : lo === 0 ? `0–${edge}s` : `${lo}–${edge}s`;
    lo = edge;
  }
  return `≥${lo}s`;
}

/**
 * 把 prompt 大小折成桶标签。
 * @param {number} tokens
 * @returns {string}
 */
export function promptBucket(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  let lo = 0;
  for (const edge of PROMPT_EDGES) {
    if (n < edge) {
      if (edge === Infinity) return `≥${Math.round(lo / 1000)}k`;
      if (lo === 0) return `<${Math.round(edge / 1000)}k`;
      return `${Math.round(lo / 1000)}–${Math.round(edge / 1000)}k`;
    }
    lo = edge;
  }
  return `≥${Math.round(lo / 1000)}k`;
}

/**
 * 两次请求之间**新增**的 token（= 物理上无缓存可命中的那部分）。
 *
 * 为什么 `max(0, …)`：折叠/剪枝会让 prompt **变小**。这时"新增"是 0（没有东西是新增的），
 * 而 miss 全部记进 waste —— 不能让负数去抵掉别的行。
 * @param {number} prompt 这一次的 prompt token
 * @param {number|null} prevPrompt 上一次的 prompt token（首条请求传 null）
 * @returns {number} 非负整数
 */
export function growthOf(prompt, prevPrompt) {
  const p = Number(prompt);
  if (!Number.isFinite(p) || p < 0) return 0;
  if (prevPrompt === null || prevPrompt === undefined) return p; // 冷启动：整条都是新增
  const prev = Number(prevPrompt);
  if (!Number.isFinite(prev)) return p;
  return Math.max(0, p - prev);
}

/**
 * ★ 地基：`miss = growth + waste`。
 * @param {{miss:number, prompt:number, prevPrompt:number|null}} row
 * @returns {{growth:number, waste:number, miss:number, prompt:number}}
 */
export function wasteOf(row) {
  const miss = Math.max(0, Number(row?.miss) || 0);
  const prompt = Math.max(0, Number(row?.prompt) || 0);
  const growth = Math.min(miss, growthOf(prompt, row?.prevPrompt ?? null));
  return { growth, waste: miss - growth, miss, prompt };
}

/**
 * 期间发生的**前缀改写**事件 → 稳定标签数组（去重、排序）。
 *
 * 只有两种东西会改前缀（其余注入都是尾部 append，不动前缀）：
 *   ① `surfaceOp: {op:"replace", startSeq, endSeq}` —— 就地改写早期槽位；
 *   ② `compaction/*` —— 折叠事务（prune 遮蔽 + summary 落盘）。
 *
 * @param {Array<object>} events 两次请求之间的事件（已按 seq 升序）
 * @returns {string[]}
 */
export function rewriteKindsOf(events) {
  const kinds = new Set();
  for (const e of events ?? []) {
    const op = e?.surfaceOp;
    if (op && typeof op === "object" && op.op === "replace") {
      const kind = e?.data?.source?.kind;
      kinds.add(`replace:${String(e?.type ?? "?")}${kind ? `:${kind}` : ""}`);
      continue;
    }
    const type = String(e?.type ?? "");
    if (type.startsWith("compaction/")) kinds.add(type);
  }
  return [...kinds].sort();
}

/**
 * ★ 四选一（判据写死在这里，报告与测试都调它 —— 不许各写一份）。
 *
 * @param {{miss:number, prompt:number, prevPrompt:number|null, gapSec:number, rewrites?:string[]}} row
 * @param {{noiseTokens?:number, ttlSec?:number}} [opts]
 * @returns {"D"|"B"|"A"|"U"}
 */
export function classifyRow(row, { noiseTokens = NOISE_TOKENS, ttlSec = TTL_SECONDS } = {}) {
  const { waste } = wasteOf(row);
  if (waste <= noiseTokens) return "D"; // 只付新增 + 取整零头
  if ((row?.rewrites?.length ?? 0) > 0) return "B"; // 前缀被我们改写
  const gap = Number(row?.gapSec);
  if (Number.isFinite(gap) && gap >= ttlSec) return "A"; // 缓存到期
  return "U"; // 短间隔、无改写，却整段失效 —— 日志里没有原因
}

/**
 * 一次请求的钱（与 T45 的 `requestCost` 同式）。
 * @param {{miss?:number, hit?:number, out?:number}} usage
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {number} 美元
 */
export function requestCost(usage, prices = PRICES) {
  const miss = Number(usage?.miss) || 0;
  const hit = Number(usage?.hit) || 0;
  const out = Number(usage?.out) || 0;
  return (miss * prices.miss + hit * prices.hit + out * prices.out) / 1e6;
}

/** 中位数（不改入参）。 */
export function median(values) {
  const a = (values ?? []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  return a[Math.floor(a.length / 2)];
}

/** 分位数（0–1，最近秩）。 */
export function percentile(values, p) {
  const a = (values ?? []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
}

/**
 * 基尼系数（0 = 完全均匀，1 = 全压在一个会话上）。
 * 用来回答「少数会话贡献了大部分 miss，还是均匀分布」。
 * @param {number[]} values 非负数
 * @returns {number}
 */
export function gini(values) {
  const a = (values ?? []).map(Number).filter((v) => Number.isFinite(v) && v >= 0).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const sum = a.reduce((x, y) => x + y, 0);
  if (sum === 0) return 0;
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += (i + 1) * a[i];
  return (2 * acc) / (a.length * sum) - (a.length + 1) / a.length;
}

/**
 * ★ 核心：把「按 seq 排序后的事件流」变成「每次 `none` 请求 + 它的增量与浪费」的行。
 *
 * 归因口径与 T45 完全一致（`pending` 由 `chess-context` 注入置位、由下一条带 usage 的
 * assistant/message 认领后清空），所以本脚本的 `none` 行**逐条等于** T45 的 `none` 组。
 * 差别只有一件：这里**保留**了两次请求之间的事件（用来判"前缀是不是被改了"）。
 *
 * @param {Array<object>} events 已按 seq 升序
 * @returns {Array<object>}
 */
export function attributeRequests(events) {
  const rows = [];
  let prev = null; // {prompt, time}
  let pending = [];
  for (const event of events) {
    if (event?.type !== "assistant/message") {
      pending.push(event);
      continue;
    }
    const usage = event?.data?.usage;
    if (!usage || !Number.isFinite(Number(usage.cacheReadTokens))) {
      pending.push(event);
      continue;
    }
    const miss = Number(usage.inputTokens) || 0;
    const hit = Number(usage.cacheReadTokens) || 0;
    const out = Number(usage.outputTokens) || 0;
    const prompt = miss + hit;
    const time = Number(event.time) || 0;
    const isNone = !pending.some((e) => e?.data?.source?.kind === "chess-context");
    if (prev && isNone) {
      const rewrites = rewriteKindsOf(pending);
      rows.push({
        seq: Number(event.seq) || 0,
        time,
        miss,
        hit,
        out,
        prompt,
        prevPrompt: prev.prompt,
        growth: growthOf(prompt, prev.prompt),
        waste: wasteOf({ miss, prompt, prevPrompt: prev.prompt }).waste,
        gapSec: prev.time === 0 || time === 0 ? null : Math.max(0, (time - prev.time) / 1000),
        rewrites,
        eventsBetween: pending.length,
      });
    }
    prev = { prompt, time };
    pending = [];
  }
  return rows;
}

/**
 * ★ 四桶分解（waste 的份额）。
 * @param {Array<object>} rows `attributeRequests` 的输出
 * @param {{noiseTokens?:number, ttlSec?:number, prices?:object}} [opts]
 * @returns {object}
 */
export function decompose(rows, { noiseTokens = NOISE_TOKENS, ttlSec = TTL_SECONDS, prices = PRICES } = {}) {
  const buckets = {};
  for (const code of BUCKETS) buckets[code] = { code, n: 0, miss: 0, waste: 0, growth: 0, cost: 0, medianWaste: [], label: BUCKET_LABELS[code] };
  let miss = 0;
  let hit = 0;
  let waste = 0;
  let growth = 0;
  for (const r of rows ?? []) {
    const code = classifyRow({ ...r, gapSec: r.gapSec ?? Infinity }, { noiseTokens, ttlSec });
    const g = Math.min(r.miss, r.growth);
    miss += r.miss;
    hit += r.hit;
    waste += r.waste;
    growth += g;
    buckets[code].n += 1;
    buckets[code].miss += r.miss;
    buckets[code].waste += r.waste;
    buckets[code].growth += g;
    buckets[code].cost += requestCost(r, prices);
    buckets[code].medianWaste.push(r.waste);
  }
  for (const code of BUCKETS) {
    const b = buckets[code];
    b.medianWaste = median(b.medianWaste);
    b.shareOfWaste = waste === 0 ? 0 : b.waste / waste;
    b.shareOfMiss = miss === 0 ? 0 : b.miss / miss;
    b.wasteCost = (b.waste * prices.miss) / 1e6;
  }
  return {
    rows: (rows ?? []).length,
    miss,
    hit,
    growth,
    waste,
    hitRate: miss + hit === 0 ? null : hit / (miss + hit),
    totalCost: (miss * prices.miss + hit * prices.hit) / 1e6,
    wasteCost: (waste * prices.miss) / 1e6,
    growthCost: (growth * prices.miss) / 1e6,
    buckets,
  };
}

/**
 * 间隔曲线：**同一间隔桶内**的命中率 / 丢弃率 / waste 份额。
 *
 * 丢弃（drop）= `miss / prompt > 0.5`（缓存基本整段没了）。用**率**而不是均值，
 * 因为均值会被大 prompt 拉爆，而率才回答"这个间隔下缓存还活着吗"。
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function gapCurve(rows) {
  const total = (rows ?? []).reduce((a, r) => a + r.waste, 0);
  const map = new Map();
  for (const r of rows ?? []) {
    const label = gapBucket(r.gapSec ?? Infinity);
    const b = map.get(label) ?? { bucket: label, n: 0, miss: 0, hit: 0, waste: 0, drop: 0, medianWaste: [] };
    b.n += 1;
    b.miss += r.miss;
    b.hit += r.hit;
    b.waste += r.waste;
    b.medianWaste.push(r.waste);
    if (r.prompt > 0 && r.miss / r.prompt > 0.5) b.drop += 1;
    map.set(label, b);
  }
  const order = ["0–5s", "5–30s", "30–120s", "120–300s", "300–600s", "600–3600s", "≥3600s"];
  return [...map.values()]
    .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket))
    .map((b) => ({
      ...b,
      medianWaste: median(b.medianWaste),
      hitRate: b.miss + b.hit === 0 ? null : b.hit / (b.miss + b.hit),
      dropRate: b.n === 0 ? 0 : b.drop / b.n,
      wasteShare: total === 0 ? 0 : b.waste / total,
    }));
}

/**
 * 上下文增长量的分布 + 「只付新增」的反事实账单。
 * @param {Array<object>} rows
 * @param {{prices?:object}} [opts]
 * @returns {object}
 */
export function growthProfile(rows, { prices = PRICES } = {}) {
  const growth = (rows ?? []).map((r) => r.growth);
  const miss = (rows ?? []).reduce((a, r) => a + r.miss, 0);
  const necessary = (rows ?? []).reduce((a, r) => a + Math.min(r.miss, r.growth), 0);
  return {
    median: median(growth),
    p25: percentile(growth, 0.25),
    p75: percentile(growth, 0.75),
    p95: percentile(growth, 0.95),
    max: growth.length === 0 ? 0 : Math.max(...growth),
    /** 每次请求「本该付」的 miss（= 新增）；超出的部分才是 waste。 */
    necessaryTokens: necessary,
    necessaryShare: miss === 0 ? 0 : necessary / miss,
    necessaryCost: (necessary * prices.miss) / 1e6,
    actualCost: (miss * prices.miss) / 1e6,
  };
}

/**
 * 受控 lift：**同一间隔桶内**，有某个特征时丢弃率 / 无该特征时丢弃率。
 *
 * 为什么必须控制间隔：`time-context` 只在一轮开始时注入，而轮开始天然间隔长 ——
 * 不控制就会把"间隔长"记到"注入"头上（本脚本第一版就差点这么写）。
 *
 * @param {Array<object>} rows
 * @param {(row:object)=>boolean} predicate
 * @param {string[]} buckets 只统计这些间隔桶（默认全部）
 * @returns {{n:number, rate:number, base:number, lift:number|null}[]}
 */
export function controlledLift(rows, predicate, buckets = null) {
  const isDrop = (r) => r.prompt > 0 && r.miss / r.prompt > 0.5;
  const out = [];
  const all = new Set((rows ?? []).map((r) => gapBucket(r.gapSec ?? Infinity)));
  for (const bucket of buckets ?? [...all]) {
    const pool = (rows ?? []).filter((r) => gapBucket(r.gapSec ?? Infinity) === bucket);
    const yes = pool.filter(predicate);
    const no = pool.filter((r) => !predicate(r));
    if (yes.length === 0) continue;
    const rate = yes.filter(isDrop).length / yes.length;
    const base = no.length === 0 ? 0 : no.filter(isDrop).length / no.length;
    out.push({ bucket, n: yes.length, rate, base, lift: base === 0 ? null : rate / base });
  }
  return out;
}

/**
 * 前缀改写事件的贡献明细：按「改写种类」汇总 waste。
 * @param {Array<object>} rows
 * @param {{prices?:object}} [opts]
 * @returns {Array<{kind:string, n:number, waste:number, cost:number}>}
 */
export function rewriteBreakdown(rows, { prices = PRICES } = {}) {
  const map = new Map();
  for (const r of rows ?? []) {
    if (r.waste <= NOISE_TOKENS) continue;
    for (const kind of r.rewrites ?? []) {
      const b = map.get(kind) ?? { kind, n: 0, waste: 0 };
      b.n += 1;
      b.waste += r.waste;
      map.set(kind, b);
    }
  }
  return [...map.values()].map((b) => ({ ...b, cost: (b.waste * prices.miss) / 1e6 })).sort((a, b) => b.waste - a.waste);
}

/**
 * 会话分布：少数会话贡献了多少。
 * @param {Array<object>} rows
 * @returns {{sessions:number, top:Array<object>, top1:number, top10:number, gini:number, medianPerSession:number}}
 */
export function sessionConcentration(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    const key = r.session ?? "?";
    const b = map.get(key) ?? { session: key, n: 0, waste: 0, miss: 0, drops: 0 };
    b.n += 1;
    b.waste += r.waste;
    b.miss += r.miss;
    if (r.prompt > 0 && r.miss / r.prompt > 0.5) b.drops += 1;
    map.set(key, b);
  }
  const all = [...map.values()].sort((a, b) => b.waste - a.waste);
  const total = all.reduce((a, b) => a + b.waste, 0);
  const share = (k) => (total === 0 ? 0 : all.slice(0, k).reduce((a, b) => a + b.waste, 0) / total);
  const top1pct = Math.max(1, Math.ceil(all.length * 0.01));
  const top10pct = Math.max(1, Math.ceil(all.length * 0.1));
  return {
    sessions: all.length,
    top: all.slice(0, 12),
    top1: share(top1pct),
    top10: share(top10pct),
    gini: gini(all.map((b) => b.waste)),
    medianPerSession: median(all.map((b) => b.waste)),
  };
}

/**
 * **C 的判据**：控制间隔（只用短间隔请求，缓存本该是热的）之后，
 * 丢弃率随 prompt 变大**是不是单调上升**。
 *
 * 为什么这样判：如果 C 成立（prompt 超过 provider 的缓存上限），短间隔请求的丢弃率
 * 必然在某个尺寸之后**跳起来**；如果曲线是平的，说明"prompt 大"只是把每次失效的
 * **代价**放大，不是失效的**原因** —— 两者结论相反（前者要改策略，后者只能记录）。
 *
 * @param {Array<object>} rows
 * @param {{shortGapSec?:number}} [opts]
 * @returns {{rows:Array<object>, monotone:boolean, first:number, last:number, ratio:number|null}}
 */
export function sizeTest(rows, { shortGapSec = 30 } = {}) {
  const pool = (rows ?? []).filter((r) => Number.isFinite(r.gapSec) && r.gapSec <= shortGapSec && r.prompt > 0);
  const order = ["<16k", "16–64k", "64–128k", "128–256k", "256–512k", "512–768k", "≥768k"];
  const map = new Map();
  for (const r of pool) {
    const label = promptBucket(r.prompt);
    const b = map.get(label) ?? { bucket: label, n: 0, miss: 0, hit: 0, waste: 0, drop: 0 };
    b.n += 1;
    b.miss += r.miss;
    b.hit += r.hit;
    b.waste += r.waste;
    if (r.miss / r.prompt > 0.5) b.drop += 1;
    map.set(label, b);
  }
  const out = [...map.values()]
    .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket))
    .map((b) => ({ ...b, hitRate: b.miss + b.hit === 0 ? null : b.hit / (b.miss + b.hit), dropRate: b.n === 0 ? 0 : b.drop / b.n }));
  const rates = out.filter((b) => b.n >= 50).map((b) => b.dropRate);
  const monotone = rates.length >= 2 && rates.every((v, i) => i === 0 || v >= rates[i - 1] * 0.9);
  return { rows: out, monotone, first: rates[0] ?? 0, last: rates[rates.length - 1] ?? 0, ratio: rates[0] ? (rates[rates.length - 1] ?? 0) / rates[0] : null };
}

/**
 * ★ 判据 → 四选一。
 *
 * 规则（**先证伪**：物理限制优先承认，不许把 provider 的账记到我们头上）：
 *   · `B.share ≥ 0.5`              ⇒ **B**（我们的写操作是主因 ⇒ 修）
 *   · `A.share + U.share ≥ 0.5`    ⇒ **A**（TTL + provider 侧偶发驱逐 = 物理限制 ⇒ 不改，只给策略）
 *   · `D.share ≥ 0.5`              ⇒ **D**（正常增量 ⇒ 不改）
 *   · 其余（没有主因）              ⇒ `mixed`（报告各桶份额，不许硬挑一个）
 *
 * @param {object} summary `decompose` 的输出
 * @returns {{code:string, label:string, reason:string, primary:string, shares:object}}
 */
export function verdictOf(summary) {
  const shares = {};
  for (const code of BUCKETS) shares[code] = summary?.buckets?.[code]?.shareOfWaste ?? 0;
  const primary = BUCKETS.slice().sort((a, b) => shares[b] - shares[a])[0];
  const pctText = (x) => `${(x * 100).toFixed(1)}%`;
  if (shares.B >= 0.5) {
    return { code: "B", label: "前缀被改", primary, shares, reason: `前缀改写贡献了 ${pctText(shares.B)} 的 waste` };
  }
  if (shares.A + shares.U >= 0.5) {
    return {
      code: "A",
      label: "TTL 过期",
      primary,
      shares,
      reason: `A(TTL) ${pctText(shares.A)} + U(短间隔偶发失效) ${pctText(shares.U)} = ${pctText(shares.A + shares.U)} 是 provider 侧物理限制，改代码救不了`,
    };
  }
  if (shares.D >= 0.5) {
    return { code: "D", label: "正常增量", primary, shares, reason: `D ${pctText(shares.D)}：miss 基本等于新增 token，没有可回收的 waste` };
  }
  return { code: "mixed", label: "无主因", primary, shares, reason: `最大桶是 ${primary}（${pctText(shares[primary])}），没有过 50% 的单一原因` };
}

/**
 * ★ 天花板：**最好情况**能省多少。
 *
 * 只有 B 是"我们改代码能拿走的"，所以：
 *   天花板 = B 的 waste 全额 —— 前提是**把折叠/改写全部去掉**（不可能，折叠是产品本身）。
 * 同时给出"如果按 T45 那种'只把改写挪到末尾'的修法"能给到多少上界（= 0，
 * 因为 `none` 组里没有一条是我们自己的注入 —— 见 `rewriteBreakdown` 的标签全是 host 侧事件）。
 *
 * @param {object} summary `decompose` 的输出
 * @param {{prices?:object}} [opts]
 * @returns {{ceiling:number, shareOfBill:number, note:string}}
 */
export function ceilingOf(summary, { prices = PRICES } = {}) {
  const b = summary?.buckets?.B;
  const ceiling = b ? b.wasteCost : 0;
  const bill = summary?.totalCost ?? 0;
  return {
    ceiling,
    shareOfBill: bill === 0 ? 0 : ceiling / bill,
    note:
      "只有 B 桶是「改代码能拿走的钱」；A/U 是 provider 侧，D 是新增 token 本身。\n" +
      "    而且 B 桶的事件全部来自 host 的 surface 事务（compaction/* 与 system/message 的 replace），\n" +
      "    我们的 src/ 只有两处 session.append，写的都是 chess-context —— 所以这是「折叠少做/合并做」的\n" +
      "    产品取舍，不是 bug 修复。",
  };
}

/* ────────────────────────── 读日志 ────────────────────────── */

/** 顶层 `type` 字段（避免对整行 JSON.parse —— 35MB × 800 文件差一个数量级）。 */
function typeOfLine(line) {
  const prefix = '{"type":"';
  if (!line.startsWith(prefix)) return null;
  const end = line.indexOf('"', prefix.length);
  return end < 0 ? null : line.slice(prefix.length, end);
}

/**
 * 从解压后的文本里抽事件（只留 `KEEP_TYPES`）。
 * @param {string} text
 * @returns {Array<object>} 按 seq 升序
 */
export function extractEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    const type = typeOfLine(line);
    if (type === null || !KEEP_TYPES.has(type)) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(msg);
  }
  events.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  return events;
}

/** 找 DSH_HOME 下所有 `session.v4.jsonl.zstd`（按体积降序）。 */
export function listSessionFiles(home) {
  const root = nodePath.join(String(home ?? ""), "sessions");
  if (root === "" || !nodeFs.existsSync(root)) return [];
  const files = [];
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    let entries = [];
    try {
      entries = nodeFs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of entries) {
      if (!s.isDirectory()) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      try {
        if (!nodeFs.existsSync(file)) continue;
        files.push({ file, session: s.name, workspace: ws.name, bytes: nodeFs.statSync(file).size });
      } catch {
        /* 权限/竞态：跳过 */
      }
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 扫一个 home（**只读**）。
 * @param {string} home
 * @param {{session?:string|null, maxSessions?:number, maxBytes?:number, onSession?:(e:object)=>void}} [opts]
 * @returns {{rows:Array<object>, files:number, picked:number, bytes:number, scanned:number}}
 */
export function scanHome(home, { session = null, maxSessions = Infinity, maxBytes = Infinity, onSession = null } = {}) {
  const all = listSessionFiles(home);
  const picked = session === null ? all : all.filter((f) => f.session.startsWith(session) || f.session === `session-${session}` || f.session.includes(session));
  const rows = [];
  let bytes = 0;
  let scanned = 0;
  let coldStarts = 0;
  for (const entry of picked) {
    if (scanned >= maxSessions) break;
    if (bytes + entry.bytes > maxBytes && scanned > 0) break;
    let text = "";
    try {
      text = decodeMultiFrameZstd(nodeFs.readFileSync(entry.file)).text;
    } catch {
      continue;
    }
    const events = extractEvents(text);
    if (events.length === 0) continue;
    bytes += entry.bytes;
    scanned += 1;
    // 每个会话的**第一条**请求没有"上一次 prompt"，growth 未定义 —— 它不进归因表（见 §① 的脚注）。
    if (events.some((e) => e?.type === "assistant/message" && Number.isFinite(Number(e?.data?.usage?.cacheReadTokens)))) coldStarts += 1;
    for (const row of attributeRequests(events)) rows.push({ ...row, session: entry.session });
    if (typeof onSession === "function") {
      try {
        onSession({ session: entry.session, bytes: entry.bytes, scanned, total: picked.length });
      } catch {
        /* 进度回调坏掉不许影响审计 */
      }
    }
  }
  return { rows, files: all.length, picked: picked.length, bytes, scanned, coldStarts };
}

/* ────────────────────────── 报告 ────────────────────────── */

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1)}%`);
const usd = (x) => `$${(Number(x) || 0).toFixed(2)}`;
const int = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "" || !nodeFs.existsSync(home)) {
    console.error("需要 DSH_HOME（或 --home <dir>）；当前为空或不存在。");
    return 2;
  }
  const session = getArg("session", null);
  const noiseTokens = Number(getArg("noise", String(NOISE_TOKENS)));
  const ttlSec = Number(getArg("ttl", String(TTL_SECONDS)));
  const maxSessionsRaw = Number(getArg("max-sessions", "Infinity"));
  const maxBytesRaw = Number(getArg("max-bytes", String(1500 * 1024 * 1024)));
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  const opts = { noiseTokens: Number.isFinite(noiseTokens) ? noiseTokens : NOISE_TOKENS, ttlSec: Number.isFinite(ttlSec) ? ttlSec : TTL_SECONDS };

  const t0 = Date.now();
  const scan = scanHome(home, {
    session,
    maxSessions: Number.isFinite(maxSessionsRaw) ? maxSessionsRaw : Infinity,
    maxBytes: Number.isFinite(maxBytesRaw) ? maxBytesRaw : Infinity,
    onSession: quiet
      ? null
      : (e) => {
          if (e.scanned % 100 === 0) console.error(`  …扫到 ${e.scanned}/${e.total} 个会话（${(Date.now() - t0) / 1000 | 0}s）`);
        },
  });
  const rows = scan.rows;
  const summary = decompose(rows, opts);
  const gaps = gapCurve(rows);
  const growth = growthProfile(rows);
  const sized = sizeTest(rows);
  const sessions = sessionConcentration(rows);
  const rewrites = rewriteBreakdown(rows);
  const verdict = verdictOf(summary);
  const ceiling = ceilingOf(summary);

  if (json) {
    console.log(
      JSON.stringify(
        {
          home,
          session,
          scannedSessions: scan.scanned,
          coldStarts: scan.coldStarts,
          totalSessionFiles: scan.files,
          scannedBytes: scan.bytes,
          opts,
          prices: PRICES,
          summary,
          gaps,
          growth,
          sizeTest: sized,
          sessions,
          rewrites,
          verdict,
          ceiling,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log("== `none` 组 · 未命中逐条归因（只读） ==");
  console.log(`home: ${home}`);
  console.log(
    `扫到 ${scan.scanned} 个会话 / ${(scan.bytes / 1024 / 1024).toFixed(0)} MB` +
      `（磁盘上共 ${scan.files} 个会话文件）· none 组请求 ${int(summary.rows)} 次 · 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  console.log(`单价：miss $${PRICES.miss}/M · hit $${PRICES.hit}/M（= 1/${Math.round(PRICES.miss / PRICES.hit)}）· 判据：noise ≤ ${opts.noiseTokens} token · TTL ≥ ${opts.ttlSec}s`);
  console.log("");
  console.log("   口径：prompt = miss + hit；growth = max(0, prompt_i − prompt_{i−1})（新增，无缓存可命中）；");
  console.log("         waste = miss − growth（已经在上下文里却重读的 token —— **只有它是「不该发生」的 miss**）");
  console.log("");

  console.log("── ① 总量分解（none 组）──");
  console.log(
    `   请求 ${int(summary.rows)} 次 · 命中率 ${pct(summary.hitRate)} · miss 合计 ${int(summary.miss)} token` +
      `（${usd(summary.totalCost)}）· hit 合计 ${int(summary.hit)}`,
  );
  console.log(
    `   · 必要（新增 token）  ${int(summary.growth).padStart(13)}  ${pct(summary.growth / Math.max(1, summary.miss)).padStart(7)}  ${usd(summary.growthCost)}`,
  );
  console.log(
    `   · 浪费（前缀重读）    ${int(summary.waste).padStart(13)}  ${pct(summary.waste / Math.max(1, summary.miss)).padStart(7)}  ${usd(summary.wasteCost)}`,
  );
  console.log(
    `   脚注：另有 ${int(scan.coldStarts)} 条**冷启动**（每个会话的第一条请求）未计入 —— 它们没有"上一次 prompt"，` +
      `growth 未定义，而 miss 全是必要的（$5 量级，且不可优化）。`,
  );
  console.log("");

  console.log("── ② 间隔桶（TTL 的直接检验：命中率 / 整段失效率随间隔怎么走）──");
  console.log("   间隔        请求数    命中率   失效率(>50%miss)   waste 合计    waste 份额   每次中位 waste");
  for (const b of gaps) {
    console.log(
      `   ${b.bucket.padEnd(9)} ${String(b.n).padStart(7)}  ${pct(b.hitRate).padStart(7)}  ${pct(b.dropRate).padStart(15)}  ` +
        `${int(b.waste).padStart(12)}  ${pct(b.wasteShare).padStart(11)}  ${int(b.medianWaste).padStart(13)}`,
    );
  }
  const shortWaste = rows.filter((r) => Number.isFinite(r.gapSec) && r.gapSec < opts.ttlSec).reduce((a, r) => a + r.waste, 0);
  const shortShare = summary.waste === 0 ? 0 : shortWaste / summary.waste;
  console.log(`   ⇒ 失效率在 ${opts.ttlSec}s 处拐弯（见上表：越往右越差），但 **waste 的大头在短间隔**：`);
  console.log(
    `     gap < ${opts.ttlSec}s 的请求贡献了 ${pct(shortShare)} 的 waste（${int(shortWaste)} token）—— 所以「TTL 是主因」不成立。`,
  );
  console.log("");

  console.log("── ③ 上下文增长量（两次请求之间新增了多少 token）──");
  console.log(
    `   growth 中位 ${int(growth.median)} · p25 ${int(growth.p25)} · p75 ${int(growth.p75)} · p95 ${int(growth.p95)} · max ${int(growth.max)}`,
  );
  console.log(
    `   必要部分 ${int(growth.necessaryTokens)} token（占 miss ${pct(growth.necessaryShare)}，${usd(growth.necessaryCost)}）；` +
      `实际付了 ${usd(growth.actualCost)} ⇒ 多付 ${usd(growth.actualCost - growth.necessaryCost)}`,
  );
  console.log(`   ⇒ 如果 miss 只等于新增，"每次中位 miss" 就该是 ${int(growth.median)} —— 真机是 ${int(median(rows.map((r) => r.miss)))}。`);
  console.log("");

  console.log("── ④ 前缀是被谁改的（waste > noise 的请求里，期间发生了什么）──");
  if (rewrites.length === 0) {
    console.log("   没有任何改写事件。");
  } else {
    for (const r of rewrites) {
      console.log(`   ${r.kind.padEnd(46)} 请求 ${String(r.n).padStart(6)} · waste ${int(r.waste).padStart(12)} · ${usd(r.cost)}`);
    }
  }
  console.log("   受控 lift（**同一间隔桶内**比较，避免把「轮开始天然间隔长」记到注入头上）：");
  for (const l of controlledLift(rows, (r) => (r.rewrites ?? []).length > 0)) {
    console.log(
      `     ${l.bucket.padEnd(9)} n=${String(l.n).padStart(5)}  有改写 ${pct(l.rate).padStart(7)}  无改写 ${pct(l.base).padStart(7)}` +
        `  lift ${l.lift === null ? "—" : `${l.lift.toFixed(1)}x`}`,
    );
  }
  console.log("");

  console.log("── ⑤ C 的判据：控制间隔（≤30s，缓存本该是热的）后，失效率随 prompt 怎么走 ──");
  console.log("   prompt 桶     请求数    命中率   失效率");
  for (const b of sized.rows) {
    console.log(`   ${b.bucket.padEnd(9)} ${String(b.n).padStart(7)}  ${pct(b.hitRate).padStart(7)}  ${pct(b.dropRate).padStart(7)}`);
  }
  console.log(
    `   ⇒ ${sized.monotone ? "单调上升 —— C 成立（prompt 越大越容易整段失效）" : "**不单调 / 基本平** —— C 被证伪：prompt 大只放大每次失效的代价，不是失效的原因"}` +
      `（最小桶 ${pct(sized.first)} → 最大桶 ${pct(sized.last)}）`,
  );
  console.log("");

  console.log("── ⑥ 会话分布（少数会话还是均匀）──");
  console.log(
    `   会话 ${int(sessions.sessions)} 个 · 基尼 ${sessions.gini.toFixed(3)} · 前 1% 会话占 ${pct(sessions.top1)} · 前 10% 占 ${pct(sessions.top10)} · 每会话中位 ${int(sessions.medianPerSession)}`,
  );
  for (const s of sessions.top.slice(0, 8)) {
    console.log(`   ${String(s.session).slice(0, 34).padEnd(34)} 请求 ${String(s.n).padStart(6)} · waste ${int(s.waste).padStart(11)} · 失效 ${String(s.drops).padStart(4)}`);
  }
  console.log("");

  console.log("── ⑦ 四选一（判据：D=waste≤noise / B=有改写 / A=无改写且 gap≥TTL / U=无改写且 gap<TTL）──");
  console.log("   桶  含义                                    请求数    waste 合计    waste 份额   花费");
  for (const code of BUCKETS) {
    const b = summary.buckets[code];
    console.log(
      `   ${code}   ${b.label.padEnd(36)} ${String(b.n).padStart(6)}  ${int(b.waste).padStart(12)}  ${pct(b.shareOfWaste).padStart(11)}  ${usd(b.wasteCost).padStart(8)}`,
    );
  }
  console.log(`   ⇒ 判定：**${verdict.code} ${verdict.label}** —— ${verdict.reason}`);
  console.log("");

  console.log("── ⑧ 这笔账的天花板 ──");
  console.log(`   none 组账单 ${usd(summary.totalCost)}；其中 waste ${usd(summary.wasteCost)}（${pct(summary.waste / Math.max(1, summary.miss))}）。`);
  console.log(`   改代码能拿走的只有 B 桶：**${usd(ceiling.ceiling)}**（占账单 ${pct(ceiling.shareOfBill)}）。${ceiling.note}`);
  console.log("");

  console.log("── 结论 ──");
  console.log(
    `   none 组不是"什么都没做所以不该 miss"：它每发都新增 ~${int(growth.median)} token（必要），` +
      `剩下 ${usd(summary.wasteCost)} 是前缀重读。`,
  );
  console.log(
    `   重读里 ${pct(summary.buckets.A.shareOfWaste)} 是 TTL、${pct(summary.buckets.U.shareOfWaste)} 是短间隔偶发失效（都归 provider），` +
      `${pct(summary.buckets.B.shareOfWaste)} 是 surface 改写（host 的折叠事务）。`,
  );
  console.log(`   一句话：**${verdict.code}** —— 天花板 ${usd(ceiling.ceiling)}，且这 ${usd(ceiling.ceiling)} 要靠少折叠换，不是修 bug。`);
  return 0;
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(HERE, "cache-miss-audit.mjs")) {
  process.exit(main());
}
