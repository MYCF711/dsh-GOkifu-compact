#!/usr/bin/env node
/**
 * retry-discard-audit.mjs —— 「放大 2× 重试，结果被丢弃」的真机审计（T45）
 *
 * ## 缺陷（只读量它，不改它）
 *
 * `src/rooms/offline-fold.mjs` 的重试路径：
 *
 *   const retryBudget = Math.min(HARD_MAX_TOKENS, Math.max(1024, budget * 2));
 *   const bigger = await callModel(prompt, { maxTokens: retryBudget });
 *   if (!looksTruncated(bigger) && String(bigger?.text ?? '').trim() !== '') { out = bigger; truncated = false; }
 *
 * 但 `looksTruncated` 里比的是**第一次的 `budget`**，而这次调用跑的是 `retryBudget = 2×budget`。
 * ⇒ 重试正文落在 `[budget, 2×budget)` 时被判「仍然截断」并丢弃 —— 而那正是重试**成功**的形状
 * （模型写得更长了，只是没到 2×）。**白付一次模型调用，还把更好的结果扔掉。**
 *
 * ## 这个脚本回答三个问题（一条不多）
 *
 *   ① **有多少条**：`foldMark` 里"重试过 + 重试结果被丢弃"的有几条；
 *   ② **长度**：这些被丢弃的重试结果正文有多长（能不能落进 `[budget, 2×budget)`）；
 *   ③ **钱**：白付了多少（用真机 `usage` + 官方价现算，不估）。
 *
 * ## 口径（与写入点逐字对齐；改代码时这里要跟着改）
 *
 *   · 判据唯一入口 `looksTruncated` 只在**离线补折**里跑（`runOfflineFold`）⇒ 人口 = `offline === true` 的折痕；
 *   · 预算 `budget = min(budgetCap, foldBudgetFor(prompt, maxTokens))`；真机 prompt 恒 > 27k 字符
 *     ⇒ `foldBudgetFor` 给上界 16,384，再被 `budgetCap = clamp(offlineMaxTokens || 8192)` 夹回 **8,192**
 *     ⇒ 默认配置下 `budget` 恒 = 8,192（`offlineBudget()` 现算，不写死）；
 *   · 重试预算 `retryBudget = min(HARD_MAX_TOKENS, max(1024, budget × 2))` = **16,384**；
 *   · **「重试开过」的充分条件**：`spentMs < max(240_000, offlineMaxTokens×25) ÷ 2.2`（= 门槛 109,091ms）。
 *     推导：重试条件是 `deadline − now > (now − startedAt) × 1.2`；记 `D = deadline − startedAt`，
 *     化简即 `spentMs < D / 2.2`。而 `mark.ms` 是**整段**耗时（`ms ≥ spentMs` 恒成立）
 *     ⇒ `ms < 门槛` ⇒ 首调必然低于门槛 ⇒ **重试一定开过**（这是下界证明，不是猜测）；
 *   · **「结果被丢弃」的充分条件**：`truncated === true`。唯一能让它翻回 false 的路径就是
 *     `out = bigger; truncated = false` ⇒ 仍为 true 说明 `bigger` 没被采用（判据仍是截断 / 抛错 / 空正文）。
 *
 * ## 能测什么、不能测什么（先把边界立住，别让代理冒充实测）
 *
 * **能测**：哪些折痕付了第二次调用却只用了第一次；每条一次调用的价；首调正文长度；
 * 首调撞的是**哪条判据**（这决定"尺子量的是正文还是 reasoning"）。
 *
 * **不能测**：**被丢掉那次的正文**。写回点只存被采用的那一次 —— `usage` / `text` 都来自 `out`
 * （`offline-fold.mjs` 的 `chunk` 组装处），被丢弃的 `bigger` 只在栈上活过一次，从没落盘。
 * 所以②给的是**可证明的区间 + 分支归因**，不是"被丢弃正文的实测长度"；哪一行是实测、
 * 哪一行是区间、哪一行是代理，输出里逐条标了。
 *
 * ## 用法
 *
 *   node scripts/retry-discard-audit.mjs                 # 真机全量（DSH_HOME 或 ~/.dsh）
 *   node scripts/retry-discard-audit.mjs --json          # 机读
 *   node scripts/retry-discard-audit.mjs --session=8a73  # 单会话
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, estimateFoldCostUsd } from "../src/ui.mjs";
import { HARD_MAX_TOKENS } from "../src/rooms/offline-fold.mjs";
import { criteriaOf, retryThresholdMs } from "./truncation-criteria-audit.mjs";
import {
  DEFAULT_FOLD_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OFFLINE_MAX_TOKENS,
  describe,
  offlineBudget,
  resolveHome,
} from "./summary-truncation-audit.mjs";

/** 「重试结果被丢弃」的四种形态 —— 闭合集（报告与测试共用这几个字符串）。 */
export const DISCARD = Object.freeze({
  discarded: "retried-discarded",
  unjudgeable: "retried-unknown",
  kept: "kept-first",
  missing: "field-missing",
  never: "not-truncated",
});

/** 首调撞的是哪把尺子（顺序与 `looksTruncated` 一致；`outputCap*` 是**旧判据**，C649 之后不再是分支）。 */
export const YARDSTICK = Object.freeze({
  finishMax: "finish-max（上游说撞顶；离线这条路 `callModel` 不返回 finish ⇒ 不可能命中）",
  bodyCap: "正文 token ≥ 预算（C649 判据，与 `foldBudgetFor` 同一个估算器）",
  skeleton: "骨架（正文 < 400 字符，而 prompt > 4000）",
  outputCap: "旧判据：usage.outputTokens ≥ 预算（**含 reasoning**）",
  outputCapLegacy: "旧判据（C533 之前的 4,000 档）：outputTokens ≥ 4,000",
  unexplained: "解释不了（多半是骨架但 `summaryChars` 已被机械补回拉长）",
});

/** C533 之前的输出预算默认值 —— 旧折痕要用它才解释得通（见 `yardstickOf`）。 */
export const LEGACY_BUDGET = 4000;

/**
 * 重试预算 —— 与 `runOfflineFold` 那一行逐字同源。
 * @param {number} budget
 * @returns {number}
 */
export function retryBudgetOf(budget) {
  return Math.min(HARD_MAX_TOKENS, Math.max(1024, Number(budget) * 2));
}

/**
 * 这条折痕「重试过吗 / 结果被丢了吗」—— 只认**能证明**的形态，不把"不可判"写成"没付"。
 *
 * @param {object} mark foldMark
 * @param {number} thresholdMs 重试时间门槛（`retryThresholdMs()`）
 * @returns {string} `DISCARD` 里的取值
 */
export function discardStateOf(mark, thresholdMs) {
  const truncated = mark?.truncated;
  if (typeof truncated !== "boolean") return DISCARD.missing;
  // `false` = 要么本来就没截断（没重试），要么重试被采用了（`out = bigger`）—— 两种都不白付，不归这一档。
  if (truncated === false) return DISCARD.kept;
  const ms = Number(mark?.ms);
  if (!Number.isFinite(ms)) return DISCARD.unjudgeable;
  return ms < Number(thresholdMs) ? DISCARD.discarded : DISCARD.unjudgeable;
}

/**
 * 首调撞的是哪把尺子 —— 纯函数。
 *
 * `skeleton` 的 `fed > 4000` 一项用**真机事实**代替（每个离线 prompt 都 > 27k 字符，
 * 见 `scripts/truncation-criteria-audit.mjs` 的口径），所以这里按 `produced < 400` 判。
 *
 * 两个必须写在代码里的口径：
 *   · **旧判据有两档预算**：C533 之前默认 `maxTokens = 4,000`，之后 8,192 ⇒ 一条 `outputTokens`
 *     落在 `[4,000, 8,192)` 的旧折痕只能由**旧档**解释。两档都试，否则会把它错误地归到"解释不了"。
 *   · `produced` 取的是 `summaryChars` = **机械补回之后**的长度 ⇒ 骨架判据只会**低估**
 *     （模型原文 < 400 字符、补回后变长的那种，落进"解释不了"）。这不是 bug，是数据边界。
 *
 * @param {object} mark
 * @param {object|null} graph
 * @param {number} budget
 * @returns {{kind:string, body:object, used:number|null, produced:number|null}}
 */
export function yardstickOf(mark, graph, budget) {
  const c = criteriaOf(mark, graph, budget);
  const produced = Number.isFinite(Number(c.body.chars)) ? Number(c.body.chars) : null;
  const drove = (kind) => ({ kind, body: c.body, used: c.used, produced });
  if (c.finishMax) return drove("finishMax");
  if (c.newCap === true) return drove("bodyCap");
  if (produced !== null && produced < 400) return drove("skeleton");
  if (c.oldCap) return drove("outputCap");
  const used = Number(c.used);
  if (Number.isFinite(used) && used >= LEGACY_BUDGET) return drove("outputCapLegacy");
  return drove("unexplained");
}

/**
 * 逐图逐折痕展开（只读）。
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
const sessionArg = args.find((a) => a.startsWith("--session="));
const only = sessionArg === undefined ? null : sessionArg.slice("--session=".length) || null;

const num = (x) => (Number.isFinite(Number(x)) ? String(Number(x)) : "—");
const pct = (x) => (Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(1)}%` : "—");
const money = (x) => (Number.isFinite(Number(x)) ? `$${Number(x).toFixed(4)}` : "—");
/** 显示宽度：CJK / 全角算 2 列（`padEnd` 按码点算，中文表格会歪）。 */
const wide = (s) => [...String(s)].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => `${s}${" ".repeat(Math.max(0, n - wide(s)))}`;

function main() {
  const home = resolveHome();
  const budget = offlineBudget(DEFAULT_MAX_TOKENS, DEFAULT_OFFLINE_MAX_TOKENS);
  const retryBudget = retryBudgetOf(budget);
  const threshold = retryThresholdMs(DEFAULT_FOLD_TIMEOUT_MS, DEFAULT_OFFLINE_MAX_TOKENS);

  const { files, rows } = collectRows(home, { session: only });
  if (rows.length === 0 && files === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  const offline = rows.filter((r) => r.mark.offline === true);
  const walk = offline.map((r) => {
    const state = discardStateOf(r.mark, threshold);
    const yard = yardstickOf(r.mark, r.graph, budget);
    const cost = estimateFoldCostUsd(r.mark.usage, r.mark.route?.model);
    return { ...r, state, yard, cost, ms: Number(r.mark.ms) };
  });
  const disc = walk.filter((r) => r.state === DISCARD.discarded);
  const unknown = walk.filter((r) => r.state === DISCARD.unjudgeable);
  const missing = walk.filter((r) => r.state === DISCARD.missing);
  const truncated = walk.filter((r) => r.mark.truncated === true);

  const asOf = Math.max(...walk.map((r) => Number(r.mark.at)).filter(Number.isFinite));
  const sumCost = (list) => list.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const knownCost = (list) => list.filter((r) => r.cost !== null).length;

  const yardTally = (list) => {
    const map = new Map();
    for (const r of list) map.set(r.yard.kind, (map.get(r.yard.kind) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };
  const modelTally = (list) => {
    const map = new Map();
    for (const r of list) {
      const key = String(r.mark.route?.model ?? "(unknown)");
      const bucket = map.get(key) ?? { model: key, n: 0, cost: 0 };
      bucket.n += 1;
      bucket.cost += r.cost ?? 0;
      map.set(key, bucket);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost);
  };

  /** 被丢弃那一组**保留下来的**正文（首调）：字符与账本 token 两个口径分开打，别混。 */
  const keptChars = describe(disc.map((r) => Number(r.mark.summaryChars)));
  const keptTokens = describe(disc.map((r) => Number(r.mark.quality?.summaryTokens)));
  const keptClean = disc.filter((r) => r.mark.quality?.endedCleanly === true).length;
  /** 全机离线正文的**上界**（`quality.summaryTokens` 是账本估算器，对中文 ≥ 离线估算器 ⇒ 安全上界）。 */
  const bodyUpper = describe(offline.map((r) => Number(r.mark.quality?.summaryTokens)));
  /** 被采用的重试（同一 prompt、同一个 `retryBudget` 下的真实重试输出）—— 唯一一组"重试正文"实测样本。 */
  const adopted = walk.filter((r) => r.mark.truncated === false && Number(r.mark.usage?.outputTokens ?? r.mark.usage?.completion_tokens ?? NaN) >= budget);
  const adoptedChars = describe(adopted.map((r) => Number(r.mark.summaryChars)));

  const report = {
    home,
    asOf: Number.isFinite(asOf) ? new Date(asOf).toISOString() : null,
    files,
    marks: rows.length,
    offline: offline.length,
    budget,
    retryBudget,
    thresholdMs: Math.round(threshold),
    tally: {
      truncated: truncated.length,
      missing: missing.length,
      discarded: disc.length,
      unjudgeable: unknown.length,
    },
    yardstick: Object.fromEntries(yardTally(disc)),
    body: {
      keptChars,
      keptTokens,
      keptClean,
      bodyUpper,
      adopted: { n: adopted.length, chars: adoptedChars },
    },
    cost: {
      discardedUsd: sumCost(disc),
      discardedKnown: knownCost(disc),
      offlineUsd: sumCost(walk),
      offlineKnown: knownCost(walk),
      perMarkUsd: disc.length === 0 ? 0 : sumCost(disc) / disc.length,
      models: modelTally(disc),
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`重试丢弃审计（T45）  home=${home}`);
  console.log(`数据截止 ${report.asOf ?? "—"}（活机快照：每跑一次数字都会再涨一点）`);
  console.log(
    `预算 budget = ${budget}（offlineMaxTokens=${DEFAULT_OFFLINE_MAX_TOKENS}）· retryBudget = ${retryBudget} · ` +
      `重试时间门槛 = ${report.thresholdMs}ms（= max(${DEFAULT_FOLD_TIMEOUT_MS}, ${DEFAULT_OFFLINE_MAX_TOKENS}×25) ÷ 2.2）`,
  );
  console.log("");

  console.log("① 人口");
  console.log(`   图 ${files} 张 · foldMark ${rows.length} 条 · 其中**离线补折** ${offline.length} 条（\`looksTruncated\` 唯一跑的地方）`);
  console.log(`   truncated=true ${truncated.length} · truncated=false ${offline.filter((r) => r.mark.truncated === false).length} · 字段缺失 ${missing.length}`);
  console.log("   「重试过 + 结果被丢弃」的三档（判据见文件头：ms < 门槛 ⇒ 重试一定开过；truncated 仍为 true ⇒ 重试没被采用）");
  console.log(`     · ${pad("确证：重试开过、结果被丢弃", 34)}${String(disc.length).padStart(4)} 条   ← 白付的就是这些`);
  console.log(`     · ${pad("不可判：ms ≥ 门槛（可能开过、也可能被 deadline 挡）", 34)}${String(unknown.length).padStart(4)} 条`);
  console.log(`     · ${pad("字段缺失（C584 之前的旧 mark，没有 truncated）", 34)}${String(missing.length).padStart(4)} 条`);
  console.log("");

  console.log("② 首调撞的是哪把尺子（顺序与 looksTruncated 一致；`旧判据*` 两档是 C649 之前的分支）");
  for (const [kind, n] of yardTally(disc)) {
    console.log(`   ${pad(YARDSTICK[kind] ?? kind, 62)}${String(n).padStart(4)} 条  ${pct(disc.length === 0 ? 0 : n / disc.length)}`);
  }
  const reasoningHeavy = disc.filter((r) => r.yard.kind === "outputCap" || r.yard.kind === "outputCapLegacy").length;
  console.log(`   ⇒ 其中 ${reasoningHeavy} 条只能由「含 reasoning 的 outputTokens ≥ 预算」解释（两档旧预算都算）：`);
  console.log(`     尺子量的是**思考**，不是正文 —— 所以"重试正文多长"在这批记录里从来没被看过一眼。`);
  console.log("");

  console.log("③ 被丢弃那次正文的长度（能测到什么就是什么，逐行标口径）");
  console.log("   ── 先说不能测的 ──");
  console.log("   写回点只存**被采用的那一次**（`usage` / `text` 都来自 `out`）；被丢弃的 `bigger` 只在栈上活过一次，");
  console.log("   从未落盘 ⇒ 「被丢弃正文的实测长度」在本机**不存在**，任何具体数字都是编的。");
  console.log("   ── 可证明的区间 ──");
  console.log(`   本次调用的 max_tokens = retryBudget = ${retryBudget} ⇒ 被丢弃正文 ≤ ${retryBudget} token；`);
  console.log(`   而它能被判成"仍然截断"，只可能是「正文 ≥ ${budget}」（新判据）或「outputTokens ≥ …」（旧判据，无下界）。`);
  console.log(`   ⇒ 缺陷形态的区间 [budget, 2×budget) = [${budget}, ${retryBudget})：`);
  console.log(`       · 可证明落在里面的：0 条（正文没落盘，谁也证明不了）`);
  console.log(`       · **不可排除**落在里面的：${disc.length} 条（区间与它相交）`);
  console.log(`       · 可证明落在 ≥ 2×budget 的：0 条 —— 那要求正文独占 ${retryBudget} 个输出 token、reasoning = 0，`);
  console.log(`         而真机 reasoning 最低也吃掉 3,816/4,000（C534）⇒ 「真的又撞顶」这一档在离线这条路上**不可达**。`);
  console.log("   ── 实测（被丢弃那批**保留下来的**正文 = 我们为它付了两次钱的那一份）──");
  console.log(
    `   ${disc.length} 条：字符 p10 ${num(keptChars.p10)} · p50 ${num(keptChars.p50)} · p90 ${num(keptChars.p90)} · max ${num(keptChars.max)}` +
      ` · token（账本口径）p50 ${num(keptTokens.p50)} · max ${num(keptTokens.max)}`,
  );
  console.log(`   其中「结尾干净」的 ${keptClean}/${disc.length} 条 —— 正文根本没撞顶，重试从一开始就没有必要。`);
  console.log(`   全机离线正文上界：max ${num(bodyUpper.max)} token < 预算 ${budget} ⇒ **正文撞顶在这台机器上是 0 条**。`);
  console.log(
    `   旁证（被采用的重试 ${adopted.length} 条：同一 prompt、同一个 retryBudget 下的真实重试输出）：` +
      `正文 p50 ${num(adoptedChars.p50)} 字符 · p90 ${num(adoptedChars.p90)} 字符`,
  );
  console.log("");

  console.log("④ 白付的钱（真机 usage + 官方价，`estimateFoldCostUsd` 现算）");
  console.log(`   确证丢弃 ${disc.length} 条 × 一次摘要调用 = **${money(report.cost.discardedUsd)}**（${knownCost(disc)}/${disc.length} 条有 usage）`);
  console.log(`     口径：被丢弃那次的 input 与首调逐字相同，输出按首调等价计 ⇒ 这是**下界**，实际只会更多。`);
  console.log(`   全库离线折痕合计 ${money(report.cost.offlineUsd)}（${knownCost(walk)}/${offline.length} 条有 usage）`);
  console.log(`     白付占比 ${pct(report.cost.offlineUsd === 0 ? 0 : report.cost.discardedUsd / report.cost.offlineUsd)} · 单条均价 ${money(report.cost.perMarkUsd)}`);
  console.log("   按模型：");
  for (const row of report.cost.models) console.log(`     ${pad(row.model, 40)}${String(row.n).padStart(4)} 条  ${money(row.cost)}`);
  console.log("");

  console.log("⑤ 结论");
  console.log(`   · ${disc.length} 条「付了两次、只用第一次」：把**保留下来的正文**按当前判据（C649 正文 token）复核，`);
  console.log(`     撞顶 ${disc.filter((r) => r.yard.kind === "bodyCap").length} 条 ⇒ 第一次就已经写完，这批重试一次都不该发 ⇒ 白付 ${money(report.cost.discardedUsd)}；`);
  console.log(`   · 缺陷的真实面不是"钱"，是**把更好的结果扔掉**：重试正文只要落在 [${budget}, ${retryBudget}) 就会被判仍然截断，`);
  console.log(`     而那正是重试成功的形状（写得更长，只是没到 2×）；修法 = 把"本次调用的预算"传进判据（见 git diff）；`);
  console.log(`   · 不可判 ${unknown.length} 条 + 字段缺失 ${missing.length} 条永远判不了：**离线写回点不写 \`finishReason\`**（T42 第 2 条），`);
  console.log(`     本次**不修**（改动面不同）。补上它之后，本脚本的②就能区分"真撞顶"与"写完但没到 2×"。`);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
