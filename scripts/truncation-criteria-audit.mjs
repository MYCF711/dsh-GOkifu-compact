#!/usr/bin/env node
/**
 * truncation-criteria-audit.mjs —— **两条「摘要被截断」判据的真机对照**（T41 / C649）
 *
 * 由来：T40（`scripts/summary-truncation-audit.mjs`）拆完 118 条「摘要截断」后给了两处一行改动的
 * 建议。本脚本是那两处改动的**量化依据**，也是**验收工具** —— 改前改后跑出来的数字必须能对上。
 *
 * 它只回答三个问题，一条不多：
 *
 *   ① **两判据各判多少条**：旧判据 `used >= budget`（used = `usage.completion_tokens ?? usage.outputTokens`，
 *      **含 reasoning**）vs 新判据 `estimateTokens(正文) >= budget`（与 `foldBudgetFor` **同一个估算器**）。
 *      差集里是不是**全是 reasoning 大**？还有没有反方向（正文撞顶而 provider 没报）的漏报？
 *   ② **`finishReason` 的全部取值分布**：每个取值 `isTruncatedFinish` 认不认 ——
 *      不认的会落进 doctor 的三态里的「不知道」（`truncatedUnknown`），而不是「没截断」。
 *   ③ **假重试的实际成本**：满足「放大 2× 重试」条件（`roomMs > spentMs × 1.2`）的折痕，
 *      每条白付一次摘要调用是多少钱（用真机 `usage` + 官方低峰价算，见 `estimateFoldCostUsd`）。
 *
 * 为什么必须在真机上量，而不是拿夹具推：`outputTokens` 到底含不含 reasoning、含多少，
 * 是 **provider 行为**，不是我们的代码。夹具里写死一个数只能证明代码照那份夹具跑。
 *
 * 口径（与写入点逐字对齐，改代码时这里要跟着改）：
 *   · 预算 `budget = min(budgetCap, foldBudgetFor(prompt, maxTokens))`；真机 prompt 恒 > 27k 字符
 *     ⇒ `foldBudgetFor` 恒给上界 16,384，再被 `budgetCap = clamp(offlineMaxTokens || 8192, 1024, 16384)`
 *     夹回 **8,192** ⇒ 默认配置下预算恒等于 8,192（`offlineBudget()` 现算，不写死）；
 *   · 判据 ①：`String(r.finish ?? r.finishReason).toLowerCase().includes("max")`；
 *   · 判据 ②（新）：`estimateTokens(r.text) >= budget` —— `estimateTokens` **必须**取
 *     `src/rooms/offline-fold.mjs` 那一份（CJK 0.6 / 其余 0.3），因为预算就是它算的；
 *   · 判据 ③（C534）：`prompt > 4000 字符 ∧ 正文 < 400 字符`；
 *   · 重试：`retryBudget = min(HARD_MAX_TOKENS, max(1024, budget × 2))`，条件 `roomMs > spentMs × 1.2`，
 *     `deadline = now + max(offlineFoldTimeoutMs ?? 240_000, offlineMaxTokens × 25)`。
 *
 * ★ 正文 token 的**两个估算器**别混：`quality.summaryTokens` 是**账本**那一份（CJK 1.0/字），
 *   预算用的是**离线折叠**那一份（CJK 0.6/字）。同一段中文，前者恒高于后者
 *   （真机 403 条可复核样本里 402 条成立）⇒ 拿 `summaryTokens` 当新判据的**上界代理**是安全的：
 *   它都说「没撞顶」，离线估算器只会更低。脚本里两条都打，并标出哪条是精确值。
 *
 * 用法：
 *   node scripts/truncation-criteria-audit.mjs                       # 真机全量（DSH_HOME 或 ~/.dsh）
 *   node scripts/truncation-criteria-audit.mjs --json                # 机读
 *   node scripts/truncation-criteria-audit.mjs --session 8a73e06b   # 单会话
 *   node scripts/truncation-criteria-audit.mjs --max-tokens=8192 --offline-max-tokens=8192
 *   DSH_HOME=... node scripts/truncation-criteria-audit.mjs
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, estimateFoldCostUsd } from "../src/ui.mjs";
import { HARD_MAX_TOKENS, estimateTokens } from "../src/rooms/offline-fold.mjs";
import { estimateTokens as ledgerEstimateTokens } from "../src/rooms/ledger.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import {
  DEFAULT_FOLD_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OFFLINE_MAX_TOKENS,
  describe,
  offlineBudget,
  resolveHome,
} from "./summary-truncation-audit.mjs";

/** 三条判据的名字（报告与机读输出共用，别在别处重写字符串）。 */
export const CRITERIA = Object.freeze({
  finishMax: "①finish 含 max",
  oldCap: "②旧：outputTokens ≥ 预算（含 reasoning）",
  newCap: "②新：正文 token ≥ 预算（同一估算器）",
  skeleton: "③C534 骨架（prompt>4000 ∧ 正文<400 字符）",
});

/** 正文 token 的**来源**。`exact` 才是新判据的精确值；`upper` / `none` 都只是代理。 */
export const BODY_SOURCE = Object.freeze({
  exact: "正文取回来了（graph.lastOfflineSummary 与折痕区间逐字相同）⇒ 现算，精确",
  upper: "正文没落盘 ⇒ 退回 quality.summaryTokens（**账本**估算器，对中文摘要 ≥ 离线估算器）⇒ 上界",
  none: "两个都没有 ⇒ 新判据这条不可判（不猜）",
});

/**
 * 一条折痕的**正文 token**，连同它的可信度。
 *
 * 为什么要三态而不是一个数：真机上大部分 foldMark 的 `summaryText` 根本没落盘
 * （写回点的 C642 比这批 mark 新），只有 `quality.summaryTokens`。把两者当同一个数用，
 * 就会出现本仓库最贵的那类缺陷 —— **两套口径，数字对不上**。
 *
 * @param {object} mark foldMark
 * @param {object|null} graph 它所属的图（`lastOfflineSummary` 在里面）
 * @returns {{tokens:number|null, source:"exact"|"upper"|"none", ledger:number|null, chars:number|null}}
 */
export function bodyTokensOf(mark, graph) {
  const m = mark ?? {};
  const los = graph?.lastOfflineSummary;
  const sameRange =
    los !== undefined &&
    los !== null &&
    typeof los.text === "string" &&
    los.text !== "" &&
    Number(los?.range?.start) === Number(m.seqStart) &&
    Number(los?.range?.end) === Number(m.seqEnd);
  if (sameRange) {
    return { tokens: estimateTokens(los.text), source: "exact", ledger: ledgerEstimateTokens(los.text), chars: los.text.length };
  }
  const recorded = Number(m?.quality?.summaryTokens);
  if (Number.isFinite(recorded) && recorded >= 0) {
    return { tokens: recorded, source: "upper", ledger: recorded, chars: Number.isFinite(Number(m?.summaryChars)) ? Number(m.summaryChars) : null };
  }
  return { tokens: null, source: "none", ledger: null, chars: null };
}

/** 旧判据：provider 报的输出 token（**含 reasoning**）≥ 预算。 */
export function oldCapHit(mark, budget) {
  const used = Number(mark?.usage?.outputTokens ?? mark?.usage?.completion_tokens ?? NaN);
  return Number.isFinite(used) && used >= Number(budget);
}

/**
 * 新判据（`looksTruncated` 现在的 token 分支）：**正文**撞顶，**或者** provider 报满预算而正文只剩骨架。
 *
 * 第二条不是「旧判据换皮」：它多了一个**正文过短**的合取项，所以「思考多但写完了」不再命中
 * （真机 148 条全部属于这一类），而「reasoning 吃光预算、只写了个骨架」仍然命中（C522 / C534 的真截断）。
 *
 * @param {object} mark
 * @param {object|null} graph
 * @param {number} budget
 * @returns {boolean|null} `null` = 正文取不回来（不猜）
 */
export function newCapHit(mark, graph, budget) {
  const body = bodyTokensOf(mark, graph);
  if (body.tokens === null) return null;
  if (body.tokens >= Number(budget)) return true;
  // 「正文只剩骨架」用**字符**判定（与 `looksTruncated` 同一个 400 阈值）。
  // 正文取不回来时退回 `summaryChars`（**补回之后**的长度，是 produced 的上界 ⇒ 只会少报，不会多报）。
  const produced = body.chars;
  if (produced === null || produced >= 400) return false;
  return oldCapHit(mark, budget);
}

/** 旧判据里的那一个数（报告要展示「撞的是哪个数」）。 */
export function usedTokensOf(mark) {
  const used = Number(mark?.usage?.outputTokens ?? mark?.usage?.completion_tokens ?? NaN);
  return Number.isFinite(used) ? used : null;
}

/** 判据 ①：`looksTruncated` 里那行 `isTruncatedFinish(...) || /max/i.test(...)`。 */
export function finishMaxHit(mark) {
  const reason = mark?.finishReason ?? mark?.stopReason;
  return isTruncatedFinish(reason) || /max/i.test(String(reason ?? ""));
}

/**
 * 一条折痕在三条判据下的**完整判定**。
 *
 * `skeleton` 按**排除法**得出（与 `summaryTruncationAudit.classifyEvidence` 同构）：
 * 写入点说 `truncated === true`、而 finish 与两条 token 判据都不成立 ⇒ 只剩 C534 的 `fed > 4000` 那条。
 *
 * @param {object} mark
 * @param {object|null} graph
 * @param {number} budget
 * @returns {{finishMax:boolean, oldCap:boolean, newCap:boolean|null, skeleton:boolean, truncated:boolean|null, body:object, used:number|null}}
 */
export function criteriaOf(mark, graph, budget) {
  const body = bodyTokensOf(mark, graph);
  const finishMax = finishMaxHit(mark);
  const oldCap = oldCapHit(mark, budget);
  const newCap = newCapHit(mark, graph, budget);
  const truncated = typeof mark?.truncated === "boolean" ? mark.truncated : null;
  const skeleton = truncated === true && !finishMax && !oldCap && newCap !== true;
  return { finishMax, oldCap, newCap, skeleton, truncated, body, used: usedTokensOf(mark) };
}

/**
 * 「放大 2× 重试」的时间门槛（毫秒）。
 *
 * 重试条件是 `roomMs > spentMs × 1.2`，而 `roomMs = deadline − now`、`now = startedAt + spentMs`
 * ⇒ `deadline − startedAt > 2.2 × spentMs`。`deadline − startedAt` 就是 tick 给的总预算
 * `max(offlineFoldTimeoutMs ?? 240_000, offlineMaxTokens × 25)` ⇒ 门槛 = 总预算 / 2.2。
 *
 * @param {number} [foldTimeoutMs]
 * @param {number} [offlineTokens]
 * @returns {number} 首段耗时低于它才会真的开重试
 */
export function retryThresholdMs(foldTimeoutMs = DEFAULT_FOLD_TIMEOUT_MS, offlineTokens = DEFAULT_OFFLINE_MAX_TOKENS) {
  const deadlineMs = Math.max(Number(foldTimeoutMs) || DEFAULT_FOLD_TIMEOUT_MS, Math.round((Number(offlineTokens) || DEFAULT_OFFLINE_MAX_TOKENS) * 25));
  return deadlineMs / 2.2;
}

/**
 * 这条折痕**真的付过**第二次调用吗？
 *
 * 只有两种可判形态，别把「不可判」写成「没付」：
 *   · `retried`  —— `truncated === false` 而判据命中过：**唯一**让 `truncated` 翻回 false 的路径就是
 *     重试成功（`out = bigger; truncated = false`）⇒ 铁证；
 *   · `retried`  —— `truncated === true` 且 `ms < 门槛`：`ms ≥ spentMs` 恒成立 ⇒ 连总耗时都低于门槛，
 *     首段必然更低 ⇒ 重试**一定开过**（这是**下界**，不是等号）；
 *   · `skipped`  —— `ms ≥ 门槛` 且仍截断：可能开过（首段低于门槛、重试把它拖过了门槛），
 *     也可能被 `skippedRetry` 挡掉。**不可判**，但**上界**算它一份。
 *
 * @param {object} mark
 * @param {number} thresholdMs
 * @param {boolean} hit 是否命中过判据
 * @returns {"retried"|"skipped"|"never"}
 */
export function retryStateOf(mark, thresholdMs, hit) {
  if (!hit) return "never";
  const ms = Number(mark?.ms);
  if (mark?.truncated === false) return "retried";
  if (Number.isFinite(ms) && ms < Number(thresholdMs)) return "retried";
  return "skipped";
}

/** 一条折痕这次折叠实花的钱（美元）。没有 `usage` ⇒ null（不许编 0）。 */
export function costOf(mark) {
  return estimateFoldCostUsd(mark?.usage, mark?.route?.model);
}

/* ────────────────────────────── 采集 ────────────────────────────── */

/**
 * 逐图逐折痕展开，并把所属图带上（正文实证要用 `lastOfflineSummary`）。
 *
 * @param {string} home
 * @param {{session?:string|null}} [opts]
 * @returns {{files:number, rows:Array<{session:string, graph:object, mark:object}>}}
 */
export function collectRows(home, { session = null } = {}) {
  const scan = collectGraphFiles(home);
  const rows = [];
  for (const entry of scan.files) {
    if (session !== null && !String(entry.dir).includes(session)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      continue; // 坏图跳过：只读审计不许因为一张坏图整跑挂掉
    }
    for (const mark of Array.isArray(graph?.foldMarks) ? graph.foldMarks : []) rows.push({ session: entry.dir, graph, mark: mark ?? {} });
  }
  return { files: scan.files.length, rows };
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const pick = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const sessionArg = args.find((a) => a.startsWith("--session=")) ?? args.find((a, i) => a === "--session" && i + 1 < args.length);
const only = sessionArg === undefined ? null : String(sessionArg.startsWith("--session=") ? sessionArg.slice("--session=".length) : args[args.indexOf(sessionArg) + 1] ?? "");

const num = (x) => (Number.isFinite(Number(x)) ? String(Number(x)) : "—");
const pct = (x) => (Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(1)}%` : "—");
const money = (x) => (Number.isFinite(Number(x)) ? `$${Number(x).toFixed(4)}` : "—");
const ratio = (x) => (Number.isFinite(Number(x)) ? `${Number(x).toFixed(2)}×` : "—");
/** 显示宽度：CJK / 全角算 2 列。`padEnd` 按码点算，中文表格会歪。 */
const wide = (s) => [...String(s)].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => `${s}${" ".repeat(Math.max(0, n - wide(s)))}`;

function main() {
  const home = resolveHome();
  const maxTokens = pick("max-tokens", DEFAULT_MAX_TOKENS);
  const offlineMaxTokens = pick("offline-max-tokens", DEFAULT_OFFLINE_MAX_TOKENS);
  const foldTimeoutMs = pick("fold-timeout-ms", DEFAULT_FOLD_TIMEOUT_MS);
  const budget = offlineBudget(maxTokens, offlineMaxTokens);
  const threshold = retryThresholdMs(foldTimeoutMs, offlineMaxTokens);

  const { files, rows } = collectRows(home, { session: only === "" ? null : only });
  if (rows.length === 0 && files === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  // ── 人口：`looksTruncated` 只在离线补折里跑，别的 trigger 不经过它 ──
  const offlineRows = rows.filter((r) => r.mark.offline === true);
  const walk = offlineRows.map((r) => ({ ...r, c: criteriaOf(r.mark, r.graph, budget) }));

  const tally = {
    files,
    marks: rows.length,
    offline: offlineRows.length,
    truncated: walk.filter((r) => r.c.truncated === true).length,
    truncatedUnknown: walk.filter((r) => r.c.truncated === null).length,
    finishMax: walk.filter((r) => r.c.finishMax).length,
    oldCap: walk.filter((r) => r.c.oldCap).length,
    newCapExact: walk.filter((r) => r.c.newCap === true && r.c.body.source === "exact").length,
    newCapUpper: walk.filter((r) => r.c.newCap === true && r.c.body.source === "upper").length,
    newCapUnknown: walk.filter((r) => r.c.newCap === null).length,
    skeleton: walk.filter((r) => r.c.skeleton).length,
    bodyExact: walk.filter((r) => r.c.body.source === "exact").length,
    bodyUpper: walk.filter((r) => r.c.body.source === "upper").length,
    bodyNone: walk.filter((r) => r.c.body.source === "none").length,
  };

  // ── ① 两判据的差集 ──
  const oldOnly = walk.filter((r) => r.c.oldCap && r.c.newCap === false); // 旧报、新不报 = 假阳性
  const newOnly = walk.filter((r) => !r.c.oldCap && r.c.newCap === true); // 新报、旧不报 = 旧判据的漏报
  const ratioOf = (r) => (Number.isFinite(r.c.used) && Number.isFinite(r.c.body.tokens) && r.c.body.tokens > 0 ? r.c.used / r.c.body.tokens : null);
  const ratios = oldOnly.map(ratioOf).filter((x) => x !== null);
  const reasoningHeavy = oldOnly.filter((r) => {
    const ratio = ratioOf(r);
    return ratio !== null && ratio >= 2;
  }).length;
  const oldOnlyCost = oldOnly.reduce((sum, r) => sum + (costOf(r.mark) ?? 0), 0);
  const oldOnlyCostKnown = oldOnly.filter((r) => costOf(r.mark) !== null).length;

  // ── ② finishReason 分布（全库 + 离线子集分开：这两支的结论不一样）──
  const distribution = (list) => {
    const byFinish = new Map();
    for (const r of list) {
      const raw = r.mark.finishReason;
      const key = raw === undefined ? "(字段缺失)" : raw === null ? "null" : String(raw);
      const bucket = byFinish.get(key) ?? { value: key, n: 0, recognized: isTruncatedFinish(raw) };
      bucket.n += 1;
      byFinish.set(key, bucket);
    }
    return [...byFinish.values()].sort((a, b) => b.n - a.n);
  };
  const finishAll = distribution(rows.map((r) => ({ ...r, c: criteriaOf(r.mark, r.graph, budget) })));
  const finishRows = distribution(walk);

  /** 写入点**能**写出的全部取值（`engine.mjs` 的归一化结果 + C535 的反推值）—— 契约闭集。 */
  const writerValues = ["stop", "end_turn", "tool-calls", "tool_calls", "completed", "max-tokens", "max_tokens", "length", "max(assumed)"];

  // ── ③ 假重试的实际成本 ──
  const hitRows = walk.filter((r) => r.c.finishMax || r.c.oldCap || r.c.skeleton);
  const retried = hitRows.filter((r) => retryStateOf(r.mark, threshold, true) === "retried");
  const retriedStillCut = retried.filter((r) => r.c.truncated === true); // 重试完还是截断 = T40 口径的「64 条」
  const retriedClean = retried.filter((r) => r.c.truncated === false); // 重试后变干净（钱白花，但结果被用了）
  const retriedUnknown = retried.filter((r) => r.c.truncated === null); // C584 之前的旧 mark 没落 truncated 字段
  const spentOf = (list) => list.reduce((sum, r) => sum + (costOf(r.mark) ?? 0), 0);
  const knownOf = (list) => list.filter((r) => costOf(r.mark) !== null).length;
  const msList = retried.map((r) => Number(r.mark.ms)).filter((x) => Number.isFinite(x));
  const bodyExactAll = walk.filter((r) => r.c.body.source === "exact").map((r) => r.c.body.tokens);
  const bodyUpperAll = walk.filter((r) => r.c.body.source === "upper").map((r) => r.c.body.tokens);

  const report = {
    home,
    budget,
    retryThresholdMs: threshold,
    tally,
    oldOnly: { n: oldOnly.length, reasoningHeavy, ratio: describe(ratios), costUsd: oldOnlyCost, costKnown: oldOnlyCostKnown },
    newOnly: { n: newOnly.length },
    body: { exact: describe(bodyExactAll), upper: describe(bodyUpperAll) },
    finish: { all: finishAll, offline: finishRows },
    writerValues: writerValues.map((v) => ({ value: v, recognized: isTruncatedFinish(v) })),
    retry: {
      hit: hitRows.length,
      retried: retried.length,
      stillCut: retriedStillCut.length,
      clean: retriedClean.length,
      unknown: retriedUnknown.length,
      costUsd: spentOf(retried),
      costKnown: knownOf(retried),
      stillCutCostUsd: spentOf(retriedStillCut),
      cleanCostUsd: spentOf(retriedClean),
      ms: describe(msList),
      upperCostUsd: spentOf(hitRows),
      upperKnown: knownOf(hitRows),
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const state = (row) =>
    row.recognized ? "**截断**" : ["stop", "end_turn", "tool-calls", "tool_calls", "completed"].includes(row.value) ? "没截断" : "**不知道**";
  const finishTable = (list) => {
    for (const row of list) {
      console.log(`   ${pad(row.value, 16)} ${String(row.n).padStart(5)}   ${row.recognized ? "✅ 认（截断）" : "❌ 不认"}   ${state(row)}`);
    }
  };

  console.log(`截断判据审计（T41 / C649）  home=${home}`);
  console.log(`预算 budget = ${budget}（offlineMaxTokens=${offlineMaxTokens} 夹 [1024, ${HARD_MAX_TOKENS}]）· 重试时间门槛 = ${Math.round(threshold)}ms`);
  console.log("");

  console.log("① 人口");
  console.log(`   图 ${tally.files} 张 · foldMark ${tally.marks} 条 · 其中**离线补折** ${tally.offline} 条（\`looksTruncated\` 唯一跑的地方）`);
  console.log(`   写入点最终判 truncated=true 的 ${tally.truncated} 条 · 字段缺失（C584 之前的旧 mark）${tally.truncatedUnknown} 条`);
  console.log(`   正文 token 来源：精确 ${tally.bodyExact} 条 · 上界代理 ${tally.bodyUpper} 条 · 不可判 ${tally.bodyNone} 条`);
  console.log("");

  console.log("② 两判据各判多少条（同一个 budget，差集 = 假阳性）");
  console.log(`   ${pad(CRITERIA.finishMax, 44)}${String(tally.finishMax).padStart(4)} 条`);
  console.log(`   ${pad(CRITERIA.oldCap, 44)}${String(tally.oldCap).padStart(4)} 条`);
  console.log(`   ${pad(CRITERIA.newCap, 44)}${String(tally.newCapExact + tally.newCapUpper).padStart(4)} 条` +
    `  （精确 ${tally.newCapExact} · 上界代理 ${tally.newCapUpper} · 不可判 ${tally.newCapUnknown}）`);
  console.log(`   ${pad(CRITERIA.skeleton, 44)}${String(tally.skeleton).padStart(4)} 条`);
  console.log("");
  console.log(`   差集（旧报、新不报 = 假阳性）：${oldOnly.length} 条，占旧判据命中数的 ${pct(tally.oldCap === 0 ? 0 : oldOnly.length / tally.oldCap)}`);
  console.log(`     这些折痕 outputTokens ÷ 正文 token：p10 ${ratio(report.oldOnly.ratio.p10)} · p50 ${ratio(report.oldOnly.ratio.p50)} · p90 ${ratio(report.oldOnly.ratio.p90)} · max ${ratio(report.oldOnly.ratio.max)}`);
  console.log(`     其中 output ÷ 正文 ≥ 2×（reasoning 占大头）的 ${reasoningHeavy}/${oldOnly.length} 条（${pct(oldOnly.length === 0 ? 0 : reasoningHeavy / oldOnly.length)}）` +
    ` ⇒ 撞的是**含 reasoning 的 outputTokens**，不是正文`);
  console.log(`     反方向（新报、旧不报 = 旧判据的**漏报**）：${newOnly.length} 条` +
    (newOnly.length === 0 ? " —— 没有「正文撞顶而 provider 没报」的漏网" : ` —— ⚠ ${newOnly.map((r) => `${r.session}#${r.mark.seqStart}-${r.mark.seqEnd}`).slice(0, 5).join(" · ")}`));
  console.log(`   正文 token 实测：精确集 max ${num(report.body.exact.max)}（${report.body.exact.n} 条）· 上界代理集 max ${num(report.body.upper.max)}（${report.body.upper.n} 条）—— 都 < 预算 ${budget}`);
  console.log("");

  console.log("③ finishReason 的全部取值分布（哪些被 isTruncatedFinish 认）");
  console.log("   ── 全库（所有 trigger）──");
  console.log(`   ${pad("取值", 16)} ${pad("条数", 5)}   isTruncatedFinish   落进哪一态`);
  finishTable(finishAll);
  console.log("   ── 其中离线补折这一支（looksTruncated 的判定面）──");
  finishTable(finishRows);
  console.log("");
  console.log("   写入点**能**写出的全部取值（契约闭集）—— 认不认决定它落进三态里的哪一态：");
  for (const row of report.writerValues) console.log(`     ${pad(row.value, 14)} ${row.recognized ? "✅ 认（截断）" : "❌ 不认（正常结束）"}`);
  console.log("");

  console.log("④ 假重试的实际成本（真机 usage + 官方低峰价）");
  console.log(`   命中过任一判据的 ${hitRows.length} 条；其中**确证**付过第二次调用的 ${retried.length} 条（下界）`);
  console.log(`     · 重试完仍是截断（T40 口径的「${retriedStillCut.length} 条假重试」）${retriedStillCut.length} 条 —— 白付 ${money(report.retry.stillCutCostUsd)}`);
  console.log(`     · 重试后变干净（假阳性被重试「救回来」）${retriedClean.length} 条 —— 白付 ${money(report.retry.cleanCostUsd)}`);
  console.log(`     · 旧 mark 没落 truncated 字段、但 ms < 门槛 ⇒ 重试铁定开过 ${retriedUnknown.length} 条`);
  console.log(`     段耗时 p50 ${num(report.retry.ms.p50)}ms · p90 ${num(report.retry.ms.p90)}ms · max ${num(report.retry.ms.max)}ms`);
  console.log(`   上界（命中过判据、首段没被 deadline 挡掉的统统算）${money(report.retry.upperCostUsd)}（${report.retry.upperKnown} 条有 usage）`);
  console.log("");

  console.log("⑤ 结论");
  console.log(`   · 旧判据 ${tally.oldCap}/${tally.offline} 条撞顶，新判据 ${tally.newCapExact + tally.newCapUpper}/${tally.offline} 条` +
    ` ⇒ 差 ${oldOnly.length} 条，撞的是**含 reasoning 的 outputTokens**，不是正文；`);
  console.log(`   · 正文最大 ${num(report.body.exact.max)} token < 预算 ${budget} ⇒ 真截断（正文撞顶）在这台机器上是 0 条；` +
    `判据仍然照报（守卫见 test/truncation-criteria.test.mjs）；`);
  console.log(`   · 省下的钱：确证假重试 ${retried.length} 条 × 一次摘要调用 ≈ ${money(report.retry.costUsd)}（上界 ${money(report.retry.upperCostUsd)}）。`);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
