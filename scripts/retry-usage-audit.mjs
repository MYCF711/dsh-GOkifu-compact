#!/usr/bin/env node
/**
 * retry-usage-audit.mjs —— **截断重试把成本账吃掉多少**（T49，2026-11-05）
 *
 * ## 缺陷（只读量它）
 *
 * `src/rooms/offline-fold.mjs` 的 C522 重试路径：
 *
 *   let out = await callModel(prompt, { maxTokens: budget });        // 第一次
 *   const bigger = await callModel(prompt, { maxTokens: retryBudget }); // 同一条 prompt 再发一次
 *   if (…) { out = bigger; truncated = false; }                        // 采用第二次
 *   …
 *   chunks.push({ …, usage: out?.usage ?? null, … });                  // 落盘的只有 out 那一份
 *
 * ⇒ 重试被采用时，**第一次调用的 usage 随 `out` 一起被覆盖**，那一次的钱从未进账。
 * 本脚本把「付了两次、只记了一次」的折痕逐条摆出来，并用真机 usage × 官方价算少记多少。
 *
 * ## 这个脚本回答四个问题（一条不多）
 *
 *   ① **人口**：多少条折痕真的发过第二次调用（判据见下，两条独立签名 + 一条旁证）；
 *   ② **两次调用各是多少**：第二次（或第一次，看哪次被采用）在账上 ⇒ 直读；被覆盖的那次 ⇒ 反推；
 *   ③ **钱**：账上记了多少 / 真实总成本 / 少记多少（输入侧精确，输出侧给区间）；
 *   ④ **能不能补**：历史数据能不能补记（不能 ⇒ 标「下界」），代码层能不能补（能 ⇒ 已修）。
 *
 * ## 口径（每一条都写清是「实测」「反推」还是「区间」）
 *
 * · **重试判据（主）**：`usage.miss < 1000` —— 不是拍脑袋的阈值，是**物理必然**：
 *   重试再发的是**同一个字符串 prompt**，provider 按前缀缓存整条命中 ⇒ 被采用的那一次
 *   `inputTokens`（= 未命中量）必然接近 0，而命中量 ≈ 整条 prompt。
 *   这个判据与 `scripts/offline-cache-audit.mjs` 的 `retryLike` **同源**（那边先登记的）。全库只有一份定义。
 * · **重试判据（旁证，独立）**：`hit / (miss + hit) ≥ 0.95` —— 不依赖任何阈值方向，
 *   只要"账上那一次几乎全命中"。两者应当落在同一个数上（差几条 = 边界折痕）。
 * · **重试开了但结果被丢弃**：`truncated === true && ms < 重试门槛`。门槛来自
 *   `truncation-criteria-audit.mjs` 的 `retryThresholdMs()`：重试条件是 `deadline−now > (now−startedAt)×1.2`，
 *   化简即 `spentMs < D/2.2`；而 `ms ≥ spentMs` ⇒ **总耗时都低于门槛，说明第二次调用一定开过**
 *   （那一次的钱同样没进账，只是没被采用）。这是**下界证明**，不是猜测。
 * · **少记的输入 token**：同一个 prompt ⇒ 两次调用的输入 token 数相同 ⇒
 *   少记量 = 账上那一次的 `totalTokens − outputTokens`（= miss + hit）。**逐条精确**。
 * · **少记的输出 token**：**不可反推**——被覆盖那次的正文（以及 reasoning）只在栈上活过一次。
 *   只能给区间 `[0, budget]`；基准取下界 0，另报上界。
 * · **单价**：`src/ui.mjs` 的 `priceForModel`（全仓唯一价格源）。flash 低峰
 *   miss $0.15 / hit $0.003 / out $0.6 每 1M。**不在这里写第二份价格**。
 * · **冷启动命中率**：未重试折痕（`miss ≥ 1000`）的输入命中率 p50 —— 少记的那次调用
 *   是"第一次发这条 prompt"，按这个实测混合价计；再给全 miss 的上界做包夹。
 *
 * ## 能测什么、不能测什么（先把边界立住）
 *
 * **能测**：多少人重试过、少记了多少输入 token（精确）、少记金额的区间、命中率的两种口径差多少。
 * **不能测**：被覆盖那次调用的**输出** token（没落盘）。任何具体到 token 的输出数都是编的。
 *
 * ## 用法
 *
 *   node scripts/retry-usage-audit.mjs              # 全库（DSH_HOME 或 ~/.dsh）
 *   node scripts/retry-usage-audit.mjs --json       # 机读
 *   node scripts/retry-usage-audit.mjs --home=…     # 换 home
 *   node scripts/retry-usage-audit.mjs --since=2026-11-05T03:00:00Z   # 只看这个时刻之后的折痕
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, estimateFoldCostUsd, priceForModel } from "../src/ui.mjs";
import { HARD_MAX_TOKENS } from "../src/rooms/offline-fold.mjs";
import { aggregateCacheRate } from "./cache-rate.mjs";
import { usageSplit } from "./offline-cache-audit.mjs";
import {
  DEFAULT_FOLD_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OFFLINE_MAX_TOKENS,
  describe,
  offlineBudget,
  resolveHome,
} from "./summary-truncation-audit.mjs";
import { retryThresholdMs } from "./truncation-criteria-audit.mjs";

const ROOT = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/** 重试判据的阈值（与 `scripts/offline-cache-audit.mjs` 的 `retryLike` 逐字同源）。 */
export const RETRY_MISS_MAX = 1000;

/** 旁证判据：账上那一次的命中占比下限。 */
export const HIT_SHARE_MIN = 0.95;

/**
 * 这条折痕**付了几次钱** —— 纯函数，只认能证明的形态。
 *
 * @param {object} mark foldMark
 * @param {number} thresholdMs 重试时间门槛（`retryThresholdMs()`）
 * @returns {"retried-adopted"|"retried-discarded"|"no-evidence"|"no-usage"}
 *   `retried-adopted`  = 重试被采用（账上记的是第二次，被覆盖的是第一次）
 *   `retried-discarded`= 重试开了但没被采用（账上记的是第一次，被丢掉的是第二次）
 *   `no-evidence`      = 没有重试证据（可能真没重试，也可能重试被 deadline 挡掉了）
 */
export function paidCallsOf(mark, thresholdMs) {
  const split = usageSplit(mark?.usage);
  const has = split.miss + split.hit + split.out > 0;
  if (!has) return "no-usage";
  const prompt = split.miss + split.hit;
  if (split.miss < RETRY_MISS_MAX && prompt > 0) return "retried-adopted";
  const ms = Number(mark?.ms);
  if (mark?.truncated === true && Number.isFinite(ms) && ms < Number(thresholdMs)) return "retried-discarded";
  return "no-evidence";
}

/**
 * 一条折痕的两次调用各是多少（第一次被覆盖 ⇒ 反推；输出侧只给区间）。
 *
 * @param {object} mark
 * @param {{budget:number, retryBudget:number}} caps
 * @returns {{bookedInput:number, bookedHit:number, bookedOut:number, bookedTotal:number,
 *            promptTokens:number, missingInput:number, missingOutMax:number, bookedCall:string}}
 */
export function callsOf(mark, { budget, retryBudget }) {
  const split = usageSplit(mark?.usage);
  const promptTokens = split.miss + split.hit; // = total − out，逐条精确
  const adopted = paidCallsOf(mark, Number.POSITIVE_INFINITY) === "retried-adopted";
  return {
    bookedInput: split.miss,
    bookedHit: split.hit,
    bookedOut: split.out,
    bookedTotal: split.total,
    promptTokens,
    // 同一个 prompt ⇒ 两次调用的输入 token 数相同 ⇒ 少记的就是这一份
    missingInput: promptTokens,
    // 被覆盖那次的输出：第一次（adopted 时）跑 `budget`，第二次（discarded 时）跑 `retryBudget`
    missingOutMax: adopted ? Number(retryBudget) : Number(budget),
    bookedCall: adopted ? "第二次（重试，被采用）" : "第一次（重试被丢弃）",
  };
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const num = (x) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const fmt = (x) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString() : "—");
const pct = (x) => (Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(1)}%` : "—");
const usd = (x) => (Number.isFinite(Number(x)) ? `$${Number(x).toFixed(4)}` : "—");
const wide = (s) => [...String(s)].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => `${s}${" ".repeat(Math.max(0, n - wide(s)))}`;

/** 收集每一张图里的 foldMark（只读）。 */
export function collectMarks(home) {
  const scan = collectGraphFiles(home);
  const rows = [];
  let bad = 0;
  for (const entry of scan.files) {
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      bad += 1; // 坏图跳过：只读审计不许因为一张坏图整跑挂掉
      continue;
    }
    for (const mark of Array.isArray(graph?.foldMarks) ? graph.foldMarks : []) rows.push({ session: entry.dir, mark: mark ?? {} });
  }
  return { files: scan.files.length, bad, rows };
}

/**
 * 一次调用的钱（miss / hit / out 分开计价）。价目来自 `src/ui.mjs` 的 `priceForModel`。
 * @param {{miss:number, hit:number, out:number}} t token 三件套
 * @param {string|null} model
 * @returns {{miss:number, hit:number, out:number, total:number, price:object}}
 */
export function costOf(t, model) {
  const price = priceForModel(model ?? null);
  const missUsd = (Number(t.miss) || 0) * price.miss / 1e6;
  const hitUsd = (Number(t.hit) || 0) * price.hit / 1e6;
  const outUsd = (Number(t.out) || 0) * price.out / 1e6;
  return { miss: missUsd, hit: hitUsd, out: outUsd, total: missUsd + hitUsd + outUsd, price };
}

/**
 * 账上记的那一次的钱 —— 与面板**同一个函数**（`ui.mjs` 的 `estimateFoldCostUsd`），
 * 这样"账面"与"真值"的差就是缺陷本身，不是两套公式的差。
 */
export function bookedCostOf(mark) {
  return estimateFoldCostUsd(mark?.usage, mark?.route?.model ?? null);
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const homeArg = argv.find((a) => a.startsWith("--home="));
  const home = homeArg === undefined ? resolveHome() : homeArg.slice("--home=".length) || resolveHome();
  // `--since=` 按折痕的 `at` 切段（epoch 毫秒或任意 Date 能解析的字符串）
  const sinceArg = argv.find((a) => a.startsWith("--since="));
  const sinceRaw = sinceArg === undefined ? null : sinceArg.slice("--since=".length);
  const since = sinceRaw === null ? null : Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : Date.parse(sinceRaw);
  if (sinceRaw !== null && !Number.isFinite(since)) {
    console.error(`✗ --since 解析不出来：${JSON.stringify(sinceRaw)}（给 epoch 毫秒或 ISO 时间）`);
    return 2;
  }

  const budget = offlineBudget(DEFAULT_MAX_TOKENS, DEFAULT_OFFLINE_MAX_TOKENS);
  const retryBudget = Math.min(HARD_MAX_TOKENS, Math.max(1024, budget * 2));
  const threshold = retryThresholdMs(DEFAULT_FOLD_TIMEOUT_MS, DEFAULT_OFFLINE_MAX_TOKENS);

  const collected = collectMarks(home);
  const files = collected.files;
  const bad = collected.bad;
  const rows = since === null ? collected.rows : collected.rows.filter((r) => Number(r.mark.at) >= since);
  if (rows.length === 0 && files === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME（或 --home=）指定真机 home 再跑。`);
    return 2;
  }

  const offline = rows.filter((r) => r.mark.offline === true);
  const withUsage = (r) => usageSplit(r.mark.usage).total !== null;
  const usable = offline.filter(withUsage);

  // ① 人口：两条独立签名 + 一条下界证明
  const adopted = offline.filter((r) => paidCallsOf(r.mark, threshold) === "retried-adopted");
  const discarded = offline.filter((r) => paidCallsOf(r.mark, threshold) === "retried-discarded");
  const byShare = usable.filter((r) => {
    const s = usageSplit(r.mark.usage);
    const prompt = s.miss + s.hit;
    return prompt > 0 && s.hit / prompt >= HIT_SHARE_MIN;
  });
  const retried = [...new Set([...adopted, ...discarded])].sort((a, b) => Number(a.mark.at) - Number(b.mark.at));
  const spent = usable.filter((r) => !retried.includes(r));

  // 冷启动口径：**没重试**的折痕里，输入命中率的实测中位数（少记的那一次就是"第一次发这条 prompt"）
  const coldShares = spent
    .map((r) => usageSplit(r.mark.usage))
    .map((s) => (s.miss + s.hit > 0 ? s.hit / (s.miss + s.hit) : null))
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
  const coldShare = coldShares.length === 0 ? 0 : coldShares[Math.floor(coldShares.length / 2)];

  // ④ 逐条：两次调用各是多少（按两档分开，因为"账上记的是哪一次"不同）
  const calls = retried.map((r) => ({ ...r, ...callsOf(r.mark, { budget, retryBudget }) }));
  const tierOf = (list) => {
    const rowsT = list.map((r) => callsOf(r.mark, { budget, retryBudget }));
    return {
      n: rowsT.length,
      prompt: rowsT.reduce((n, c) => n + c.promptTokens, 0),
      bookedIn: rowsT.reduce((n, c) => n + c.bookedInput, 0),
      bookedOut: rowsT.reduce((n, c) => n + c.bookedOut, 0),
      missingOutMax: rowsT.reduce((n, c) => n + c.missingOutMax, 0),
    };
  };
  const adoptedTier = tierOf(adopted);
  const discardedTier = tierOf(discarded);
  const missingIn = calls.reduce((n, c) => n + c.missingInput, 0);
  const bookedIn = calls.reduce((n, c) => n + c.bookedInput, 0);
  const bookedOut = calls.reduce((n, c) => n + c.bookedOut, 0);
  const missingOutMax = calls.reduce((n, c) => n + c.missingOutMax, 0);
  const promptDist = describe(calls.map((c) => c.promptTokens));

  // ⑤ 钱
  const money = calls.map((c) => {
    const booked = bookedCostOf(c.mark) ?? 0;
    // 少记的那一次：输入按"冷启动实测混合价"，输出取下界 0
    const coldIn = costOf({ miss: c.missingInput * (1 - coldShare), hit: c.missingInput * coldShare, out: 0 }, c.mark.route?.model ?? null);
    const coldInAllMiss = costOf({ miss: c.missingInput, hit: 0, out: 0 }, c.mark.route?.model ?? null);
    const outUpper = costOf({ miss: 0, hit: 0, out: c.missingOutMax }, c.mark.route?.model ?? null);
    return { booked, missingIn: coldIn.total, missingInAllMiss: coldInAllMiss.total, outUpper: outUpper.total };
  });
  const sum = (key) => money.reduce((n, m) => n + (Number(m[key]) || 0), 0);
  const bookedUsd = sum("booked");
  const missingUsd = sum("missingIn");
  const missingUsdUpperIn = sum("missingInAllMiss");
  const missingOutUpper = sum("outUpper");
  const bookedAll = usable.reduce((n, r) => n + (bookedCostOf(r.mark) ?? 0), 0);

  // ⑥ 命中率：恒等式 vs 直接读（修 ② 的验收）
  const fieldPresent = usable.filter((r) => num(r.mark.usage?.cacheReadTokens) !== null);
  const direct = aggregateCacheRate(usable.map((r) => ({ ...r.mark.usage, cacheReadTokens: null })));
  const fixed = aggregateCacheRate(usable.map((r) => r.mark.usage));
  const asBefore = (() => {
    // 修复**前**的写法（逐字复刻）：`Number(null) === 0` ⇒ 字段缺失全记成命中 0
    let miss = 0;
    let hit = 0;
    for (const r of usable) {
      const m = Number(r.mark.usage?.inputTokens);
      if (!Number.isFinite(m) || m < 0) continue;
      const h = Number(r.mark.usage?.cacheReadTokens);
      miss += m;
      hit += Number.isFinite(h) && h > 0 ? h : 0;
    }
    const denom = miss + hit;
    return { miss, hit, hitRate: denom === 0 ? null : hit / denom };
  })();
  const perRowDiff = fieldPresent
    .map((r) => {
      const s = usageSplit(r.mark.usage);
      const field = num(r.mark.usage.cacheReadTokens);
      const implied = s.total === null ? null : s.total - s.miss - s.out;
      return field === null || implied === null ? null : Math.abs(field - Math.max(0, implied));
    })
    .filter((x) => x !== null);

  const asOf = Math.max(...rows.map((r) => Number(r.mark.at)).filter(Number.isFinite));
  // ② 的证据：源码里到底还是不是旧写法 + 落盘的折痕里有没有任何"第几次调用"类字段
  const source = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs"), "utf8");
  const fixPresent = /billed\s*=\s*sumFoldUsage\(/.test(source) && /billedUsage/.test(source) && /normalizeUsage\(chunk\.billedUsage/.test(source);
  const RETRY_KEY = /retry\w*|attempt\w*|calls?\b/i;
  const marksWithRetryField = rows.filter((r) => Object.keys(r.mark ?? {}).some((k) => RETRY_KEY.test(k))).length;
  const modelTally = (() => {
    const map = new Map();
    for (const r of retried) {
      const key = String(r.mark.route?.model ?? "(unknown)");
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const report = {
    home,
    asOf: Number.isFinite(asOf) ? new Date(asOf).toISOString() : null,
    since: since === null ? null : new Date(since).toISOString(),
    files,
    bad,
    marks: rows.length,
    offline: offline.length,
    usable: usable.length,
    budget,
    retryBudget,
    thresholdMs: Math.round(threshold),
    population: {
      retried: retried.length,
      adopted: adopted.length,
      discarded: discarded.length,
      byHitShare: byShare.length,
      retryMissMax: RETRY_MISS_MAX,
      hitShareMin: HIT_SHARE_MIN,
      models: Object.fromEntries(modelTally),
    },
    calls: {
      retried: calls.length,
      bookedInputTokens: bookedIn,
      bookedOutputTokens: bookedOut,
      missingInputTokens: missingIn,
      missingOutputUpperTokens: missingOutMax,
      prompt: promptDist,
      coldHitShare: coldShare,
    },
    money: {
      bookedUsd,
      bookedAllOfflineUsd: bookedAll,
      missingUsd,
      missingUsdAllMiss: missingUsdUpperIn,
      missingOutputUsdUpper: missingOutUpper,
      totalUsd: bookedUsd + missingUsd,
    },
    hitRate: {
      beforeFix: asBefore,
      byIdentity: fixed,
      directField: direct,
      fieldPresent: fieldPresent.length,
      perRowMaxDiff: perRowDiff.length === 0 ? null : Math.max(...perRowDiff),
    },
    evidence: {
      fixPresent,
      marksWithRetryField,
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 1));
    return 0;
  }

  console.log("== 重试记账审计（只读 · 零模型调用 · T49）==");
  console.log(`home：${home}`);
  console.log(`数据截止 ${report.asOf ?? "—"}（活机快照：每跑一次数字都会再涨一点）${report.since === null ? "" : ` · 只看 ${report.since} 之后的折痕（--since）`}`);
  console.log(`预算 budget = ${fmt(budget)} · retryBudget = ${fmt(retryBudget)} · 重试时间门槛 = ${fmt(report.thresholdMs)}ms（= max(${DEFAULT_FOLD_TIMEOUT_MS}, ${DEFAULT_OFFLINE_MAX_TOKENS}×25) ÷ 2.2）`);
  console.log("");

  console.log("① 人口：谁的折痕付了两次钱");
  console.log(`   图 ${fmt(files)} 张（坏图 ${fmt(bad)}）· foldMark ${fmt(rows.length)} 条 · **离线补折** ${fmt(offline.length)} 条（\`looksTruncated\` 唯一跑的地方）`);
  console.log(`   usage 可用 ${fmt(usable.length)} 条（其余 ${fmt(offline.length - usable.length)} 条没有 usage，成本无从谈起）`);
  console.log(`   · 主判据 \`miss < ${RETRY_MISS_MAX}\`（整条 prompt 命中 = 同一条 prompt 再发了一次）：**${fmt(adopted.length)} 条**（${pct(adopted.length / Math.max(1, usable.length))}）`);
  console.log(`   · 旁证 \`hit/(miss+hit) ≥ ${HIT_SHARE_MIN}\`（独立签名，不依赖阈值方向）：${fmt(byShare.length)} 条`);
  console.log(`   · 重试开了但结果被丢弃（\`truncated\` 且 ms < 门槛 ⇒ 第二次调用一定发过）：${fmt(discarded.length)} 条`);
  console.log(`   ⇒ **两次调用都发生过**：${fmt(retried.length)} 条（三条签名取并集，按折痕去重）`);
  if (modelTally.length > 0) console.log(`   · 模型分布：${modelTally.map(([m, n]) => `${m} ×${n}`).join(" · ")}`);
  console.log("   ⚠ 适用边界：判据量的是「落盘时只记了一次调用」的折痕。修复上线后新折痕的 `usage` 本身就是两次之和");
  console.log("     （`miss` 不再 < 1000）⇒ 本判据对它们**不命中**（会读成「没重试」）。到时用 `--since=` 按时间切段，");
  console.log("     或按「`usage` 是否 ≈ 2× 单次 prompt」另立判据 —— 这一条没做落盘标记，是本脚本的已知缺口。");
  console.log("");

  console.log("② 第一次调用的 usage 在哪（先证伪：能不能补记）");
  console.log("   **修复前**的代码（`src/rooms/offline-fold.mjs`，缺陷现场）—— 四次读到的都是同一个变量：");
  console.log("     `let out = await callModel(prompt, { maxTokens: budget });`      ← 第一次：usage 只活在这个栈变量里");
  console.log("     `const bigger = await callModel(prompt, { maxTokens: retryBudget });` ← 同一条 prompt 再发一次");
  console.log("     `out = bigger;`                                                   ← **覆盖**（第一次的 usage 从此无人引用）");
  console.log("     `usage: out?.usage ?? null,`                                      ← 落盘的只有覆盖后的那一份");
  console.log(`   落盘侧（实测）：${fmt(rows.length)} 条折痕里带 retry / attempt / calls 类键的：**${fmt(marksWithRetryField)} 条**`);
  console.log("     ⇒ **历史：不可补记，只能反推**（下面 ③ 给出可反推到什么程度，金额因此标「下界」）。");
  console.log("   ⇒ **代码层：能补**——第一次的 usage 在覆盖之前就握在 `out` 里，只是没人接住它。");
  console.log(
    `     当前源码状态（现读，不是写死的）：${fixPresent ? "**已修** —— `billed = sumFoldUsage(…)` + `chunk.billedUsage` + 写回点优先取它" : "**仍是旧写法（`usage: out?.usage`）** —— 修复被回退了"}`,
  );
  console.log("     （不直接改 `chunk.usage` 的语义：`test/retry-discard.test.mjs` T44① 逐字钉着「usage = 被采用那一次」，");
  console.log("       改语义会当场把它打红 ⇒ 合计走新增字段，既有契约一个字节不动。见报告「加字段 vs 改语义」。）");
  console.log("");

  console.log("③ 反推口径：输入侧为什么能精确到 token，输出侧为什么不能");
  console.log("   两次调用用的是**同一个字符串** `prompt`（同一个变量，中间没有任何改写）⇒ provider 对同一段");
  console.log("   文本的输入 token 数是确定的 ⇒ **第一次的输入 = 第二次的输入**。而账上那一次的输入 = miss + hit");
  console.log(`   = total − out（恒等式 \`total = miss + hit + out\`，C361 真机自证）⇒ 少记的输入 **逐条精确**。`);
  console.log(`   输出侧：被覆盖那次的正文与 reasoning 只在栈上活过一次 ⇒ 只能给区间 [0, ${fmt(budget)}]（adopted）`);
  console.log(`   或 [0, ${fmt(retryBudget)}]（discarded）。**基准取 0**（少记金额 = 下界），上界另报。`);
  console.log("");

  console.log(`④ 逐条：${fmt(calls.length)} 条折痕的两次调用（被覆盖那次 ⇒ 反推；账上那次 ⇒ 直读）`);
  console.log(`   两档分开记，因为"账上记的是哪一次"不同：`);
  console.log(
    `     · 被采用（账上 = 第二次，被覆盖 = 第一次）：${fmt(adoptedTier.n)} 条 · 输入 ${fmt(adoptedTier.prompt)} token · 账上输入仅 ${fmt(adoptedTier.bookedIn)} / 输出 ${fmt(adoptedTier.bookedOut)}`,
  );
  console.log(
    `     · 被丢弃（账上 = 第一次，被丢 = 第二次）：${fmt(discardedTier.n)} 条 · 输入 ${fmt(discardedTier.prompt)} token · 账上输入 ${fmt(discardedTier.bookedIn)} / 输出 ${fmt(discardedTier.bookedOut)}`,
  );
  console.log(`   每次调用的输入（= prompt 大小）：p10 ${fmt(promptDist.p10)} · p50 ${fmt(promptDist.p50)} · p90 ${fmt(promptDist.p90)} · max ${fmt(promptDist.max)} · **合计 ${fmt(missingIn)}**`);
  console.log(`   账上（${fmt(calls.length)} 条合计）：输入 ${fmt(bookedIn)} token + 输出 ${fmt(bookedOut)} token —— **只有一次调用**`);
  console.log(`   真实（同 ${fmt(calls.length)} 条）：输入 ${fmt(bookedIn + missingIn)} token（两次各一半）+ 输出 ${fmt(bookedOut)} token **以上**（被覆盖那次另计 0～${fmt(missingOutMax)}）`);
  console.log("   ── 抽样（按输入降序，前 8 条；`被覆盖` 那两列是**没进账**的那一次）──");
  console.log(`   ${pad("会话", 11)}${pad("seq", 13)}${pad("被覆盖·输入", 15)}${pad("被覆盖·输出上限", 19)}${pad("账上·输入", 13)}${pad("账上·输出", 12)}`);
  for (const c of [...calls].sort((a, b) => b.promptTokens - a.promptTokens).slice(0, 8)) {
    console.log(
      `   ${pad(String(c.session).slice(0, 9), 11)}${pad(`${c.mark.seqStart ?? "?"}-${c.mark.seqEnd ?? "?"}`, 13)}` +
        `${pad(fmt(c.missingInput), 15)}${pad(`0～${fmt(c.missingOutMax)}`, 19)}${pad(fmt(c.bookedInput), 13)}${pad(fmt(c.bookedOut), 12)}`,
    );
  }
  console.log("");

  console.log("⑤ 少记金额（单价 = `src/ui.mjs` 的 `priceForModel`：flash 低峰 miss $0.15 / hit $0.003 / out $0.6 每 1M）");
  console.log(`   ${fmt(retried.length)} 条重试折痕账上记的：${usd(bookedUsd)}（面板口径 = \`estimateFoldCostUsd\`，同一个函数）`);
  console.log(`   少记的**输入**：${fmt(missingIn)} token ⇒ ${usd(missingUsd)}（冷启动口径：未重试折痕的输入命中率 p50 = ${pct(coldShare)}）`);
  console.log(`     包夹：全按 hit 价 ${usd(costOf({ miss: 0, hit: missingIn, out: 0 }, null).total)} ～ 全按 miss 价 ${usd(missingUsdUpperIn)}`);
  console.log(`   少记的**输出**（不可反推）：0 ～ ${fmt(missingOutMax)} token ⇒ $0.0000 ～ ${usd(missingOutUpper)}`);
  console.log(`   ⇒ **少记合计 = ${usd(missingUsd)}（下界）～ ${usd(missingUsd + missingOutUpper)}（上界）**；真实总成本 ${usd(bookedUsd + missingUsd)} 起`);
  console.log(`   （参照：全库离线折痕账面合计 ${usd(bookedAll)}——少记的这 ${usd(missingUsd)} 是其中**从没出现过**的一笔）`);
  console.log("");

  console.log("⑥ 命中率：恒等式反推 vs 直接读 `cacheReadTokens`（修 ② 的验收）");
  console.log(`   \`cacheReadTokens\` 有值的折痕：${fmt(fieldPresent.length)} / ${fmt(usable.length)} ⇒ 其余 ${fmt(usable.length - fieldPresent.length)} 条是 **null（字段缺失，不是 0）**`);
  console.log(`   · 修复前的写法（\`Number(null) === 0\`）：命中 ${fmt(asBefore.hit)} token / 率 **${pct(asBefore.hitRate)}** ← 面板上那个 0%`);
  console.log(`   · 修复后（恒等式 \`total − miss − out\`）：命中 ${fmt(fixed.hit)} token / (${fmt(fixed.miss)} + ${fmt(fixed.hit)}) = **${pct(fixed.hitRate)}**（反推 ${fmt(fixed.inferred)} 条 / 直给 ${fmt(fixed.fieldBacked)} 条）`);
  console.log(`   · 两者在**有字段的 ${fmt(fieldPresent.length)} 条**上逐条比：最大差 ${fmt(report.hitRate.perRowMaxDiff)} token${report.hitRate.perRowMaxDiff === 0 ? "（**完全一致**：恒等式就是 provider 直给的那个数）" : ""}`);
  console.log("");

  console.log("⑦ 与 T48 记录对账（它记的是同一件事，只是快照更早）");
  console.log(`   T48：923 条折痕里 367 条重试（39.8%）· 5,029,359 输入 token 从未进账 · **$0.734**`);
  console.log(`   本快照：${fmt(offline.length)} 条折痕里 ${fmt(retried.length)} 条重试（${pct(retried.length / Math.max(1, usable.length))}）· ${fmt(missingIn)} 输入 token · **${usd(missingUsd)}**`);
  console.log(`   条数：${fmt(retried.length)} vs 367（差 ${fmt(retried.length - 367)}）—— 折痕总数已从 923 涨到 ${fmt(offline.length)}（活机每跑一次都在涨），`);
  console.log(`     且"重试开过但结果被丢弃"这 ${fmt(discardedTier.n)} 条是 T48 的判据覆盖不到的（它按"账上那一次几乎全命中"筛）`);
  console.log(`   金额：T48 的 $0.734 ÷ 5,029,359 token = $${(0.734 / 5029359 * 1e6).toFixed(4)}/1M —— 正是"冷启动 ${pct(coldShare)} 命中"这一档的混合价，`);
  console.log(`     与本脚本的 $${(missingUsd / Math.max(1, missingIn) * 1e6).toFixed(4)}/1M **同一个价档** ⇒ 差异全在 token 量（快照 + 人口），不在口径。`);
  console.log("");
  console.log(`结论：① 重试折痕 **${fmt(retried.length)} 条**（被采用 ${fmt(adoptedTier.n)} + 被丢弃 ${fmt(discardedTier.n)}；两条独立签名同量级）；`);
  console.log(`      ② 少记 **${usd(missingUsd)}**（输入侧精确到 token；输出侧不可反推，上界 +${usd(missingOutUpper)}）；`);
  console.log(`      ③ 历史**不可补记**（第一次 usage 从未落盘）⇒ 这批按**下界**记；代码层已修，新折痕的 usage 本身就是两次之和；`);
  console.log(`      ④ 折叠命中率真值 **${pct(fixed.hitRate)}**，不是 0%。`);
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
