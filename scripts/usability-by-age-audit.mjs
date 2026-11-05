#!/usr/bin/env node
/**
 * usability-by-age-audit.mjs —— 摘要**可接手性**按「折痕年龄」分桶（T52 · 只读 · 零模型调用）
 *
 * 为什么需要（Lead 复跑 T33 后的原话）：
 *   「7.0 分**被老数据拖着**：段齐从 6/10 涨到 10/10，但样本 3/5 仍然是 0 个真 id。」
 *   假设：那 0% 是 **T37 修 `coverageOf` 之前**产生的退化区间（`seq 8-8` 那种）留下的折痕，
 *   **新折痕应该已经好了** —— 若成立，7.0 分要按「新折痕」重算。
 *
 * 本脚本只做一件事：**把 T33 的同一套判据按时间分桶重跑一遍**，让「新 / 老」两个数并排放着。
 *
 * 三条边界（与 T33 同一条线）：
 *   · **纯只读**：`graph.json` 只 `readFileSync`，**一个字节都不写**（T33 会写 `tmp/summary-samples.md`，本脚本不写）；
 *   · **不改 T33 的脚本**：机械指标**直接 import** T33 的 `measureSample` / `resolveHome` / `FROZEN_SAMPLE_SESSIONS`
 *     —— 判据只许有一份实现（本仓因为「两套口径」栽过很多次：C607 / C638 / C641）；
 *   · **不调模型**、不重启、不写 `docs/` `evidence/`。
 *
 * ── 口径（先看这里，否则下面的分母是假的） ─────────────────────────────────
 * ① **「折痕」= 可复判折痕**：真机 `foldMarks` 里 **0** 条带 `summaryText`，正文只活在
 *    `graph.lastOfflineSummary.text` 这**一个槽**里 ⇒ 一个会话最多只能复判**一条**折痕（最新那条）。
 *    全库 1104 条折痕里只有 **426** 条能复判，其余 **678** 条「只有 `summaryChars`、正文不可复判」，
 *    任何按它们的评分都是编的 —— 所以本脚本的**分母是 426，不是 1104**，并在输出里写明。
 * ② **年龄 = `foldMark.at`**（折痕自己的产生时刻），不是会话创建时间、不是文件 mtime。
 * ③ **分界线来自 `git log`**：T35 / T37 / T50 三个提交的 **commit time**（`%ct`），
 *    每次运行现算，不写死、不拍脑袋（`readGitCommitTime`）。提交号写死在 `LANDINGS` 里，
 *    时间从仓库现取；git 读不到时退回**记录值**并在输出里标 `fallback`（不许静默）。
 * ④ ⚠ **提交时间 ≠ 生效时间**：ESM 在宿主启动时加载，没重启就没生效（本仓已踩过两次：
 *    C641「补回从没跑过」、T33「正文落盘写回点没在生产数据里生效」）。本脚本**只按时间分桶**，
 *    但会额外量一个**数据内的指纹**：退化区间率（`seqStart === seqEnd`）。T37 的修复若真在跑，
 *    这个数必须是 0；不是 0 ⇒ 分桶名里的「T37 之后」跟代码无关，报告必须明说。
 *
 * ── 5 判据（**T33 的同一套**，满分各 2 分，总分 10） ─────────────────────────
 *   T33 报告的分项是：可接手 1.5 · 可定位 0.8 · 无幻觉 1.7 · 无冗余 1.5 · 长度 1.5 = **7.0 / 10**
 *   （`docs/knowledge/进度.md` 第 8 轮逐字记着这五个数）。T33 的分是人读出来的，脚本里没有实现；
 *   这里把同一个维度**机械化**成可复算的规则（每一条都只用 T33 `measureSample` 已经算出来的字段）：
 *
 *   | # | 判据 | 满分 | 规则（全部来自 `measureSample` 的字段） |
 *   |---|---|---|---|
 *   | 1 | 可接手 | 2.0 | 4 × 0.5：有「停在哪」· 有「下一步」≥1 行 · 死路 ≥1 条 · 已验证或未验证 ≥1 条 |
 *   | 2 | 可定位 | 2.0 | 按 `traceableShare` 分档：≥0.95→2 · ≥0.8→1.5 · ≥0.6→1 · ≥0.3→0.5 · 其余→0 |
 *   | 3 | 无幻觉 | 2.0 | 2 − 0.5×[有幻觉 id] − 0.5×[有越界·更晚] − 0.5×[seq 断言对不上]（下限 0） |
 *   | 4 | 无冗余 | 2.0 | 2 − 0.5×[重复行>0] − 0.5×[提示词回灌>0] − 0.75×[工具调用泄漏>0] − 0.25×[空话行>0]（下限 0） |
 *   | 5 | 长度 | 2.0 | 1000–8000 字符→2 · 500–1000 或 8000–16000→1 · 其余→0.5 |
 *
 *   这把尺子**先在 T33 的冻结 10 条上校准**（`§5`）：跑出来 7.5~7.6 vs T33 报告 7.0（偏差 +0.5 左右），
 *   逐项差 ≤0.25。所以：**跨桶比较可靠（同一把尺子），绝对分带 +0.5 的系统偏差**，报告里必须写这句话。
 *
 * ── 三档判据（`verdictOf`） ──────────────────────────────────────────────
 *   · `not-fixed` ：新折痕里**还有**整篇零锚点（`ids === 0 && placeholders > 0`）⇒ 0% 仍在
 *   · `fixed`     ：零锚点归零，**且**可定位率比老折痕高 ≥10pp ⇒ 假设成立
 *   · `partial`   ：零锚点归零，但可定位率涨幅 <10pp（含负增长）⇒ 只修掉了悬崖，没修掉地基
 *
 * 用法：
 *   node scripts/usability-by-age-audit.mjs                     # 全量，按提交时间分桶
 *   node scripts/usability-by-age-audit.mjs --as-of 2026-11-05T12:00:00+08:00   # 冻结快照（可复现）
 *   node scripts/usability-by-age-audit.mjs --json              # 机读（测试/报告用）
 *   node scripts/usability-by-age-audit.mjs --home <DIR>        # 显式指定 DSH_HOME
 *   node scripts/usability-by-age-audit.mjs --live-since <ISO>  # 运行中代码的加载时刻（人工提供，见 §0）
 *
 * 退出码：0 = 审计跑完（无论结论是「修好了」还是「没修好」）；2 = 读不到棋谱目录。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ★ 判据复用，不复制实现：机械指标与抽样池的口径只有 T33 那一份。
import { measureSample, resolveHome, FROZEN_SAMPLE_SESSIONS } from "./summary-usability-audit.mjs";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 三个已知上线时刻的**提交**（时间在运行时从 `git log %ct` 现取，见 `readGitCommitTime`）。
 * `at` 只是 git 读不到时的记录值 —— 输出里会标 `fallback`，不许静默用。
 */
export const LANDINGS = Object.freeze([
  {
    id: "T35",
    sha: "55b2d19",
    at: "2026-11-05T07:49:27+08:00",
    what: "sanitizeSummaryIds 的界改成「区间内最后一个实体」（整篇 n? 的那个根因）",
  },
  {
    id: "T37",
    sha: "360cd30",
    at: "2026-11-05T08:12:37+08:00",
    what: "退化区间上游根因：coverageOf 不再把不相交的跨度夹成一点",
  },
  {
    id: "T50",
    sha: "776174b",
    at: "2026-11-05T11:22:04+08:00",
    what: "normalizeUsage 认 cacheReadTokens（与可接手性无关，作为第三个分界）",
  },
]);

/** 桶顺序（固定，输出与测试都按它）。 */
export const BUCKET_ORDER = Object.freeze(["pre-T35", "T35..T37", "T37..T50", "post-T50"]);

/** 「新折痕」从哪个分界之后算起。T37 是 Lead 假设里点名的那条线。 */
export const NEW_SINCE = "T37";

/** 5 判据（键名 = `scoreMark` 的返回字段）。 */
export const CRITERIA = Object.freeze([
  { key: "handoff", name: "可接手", max: 2 },
  { key: "traceable", name: "可定位", max: 2 },
  { key: "noHallucination", name: "无幻觉", max: 2 },
  { key: "noRedundancy", name: "无冗余", max: 2 },
  { key: "length", name: "长度", max: 2 },
]);

/** T33 报告里逐字记着的分项（用来校准，见 `calibration`）。 */
export const T33_REPORTED = Object.freeze({ handoff: 1.5, traceable: 0.8, noHallucination: 1.7, noRedundancy: 1.5, length: 1.5, total: 7.0 });

/** 「三档判据」的名字与门槛（`verdictOf` 用；改门槛只改这里）。 */
export const VERDICT_RULES = Object.freeze({
  /** 可定位率涨幅达到这个数才算「修好了」（百分点 / 100）。 */
  minGain: 0.1,
});

/* ───────────────────────────── 分界：从 git 取，不拍脑袋 ───────────────────────────── */

/** 默认的执行器（可注入，测试用假 git）。 */
function defaultRun(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

/**
 * 一个提交的 **commit time**（毫秒）。读不到返回 `null`（不抛 —— 审计要能继续跑，但要标 fallback）。
 * @param {string} sha
 * @param {{cwd?:string, run?:Function}} [opts]
 * @returns {number|null}
 */
export function readGitCommitTime(sha, { cwd = ROOT, run = defaultRun } = {}) {
  if (typeof sha !== "string" || sha.trim() === "") return null;
  let result;
  try {
    result = run("git", ["log", "-1", "--format=%ct", sha.trim()], cwd);
  } catch {
    return null;
  }
  if (result === null || result === undefined || result.status !== 0) return null;
  const seconds = Number(String(result.stdout ?? "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * 三个分界的毫秒时刻。`source: "git"` = 现取；`"fallback"` = 用 `LANDINGS[].at`（git 不可用）。
 * 排序固定按 `LANDINGS` 的顺序，**并校验单调递增**（顺序错了说明 `LANDINGS` 被改坏）。
 * @param {{cwd?:string, run?:Function}} [opts]
 * @returns {{cuts:Record<string,number>, rows:Array<object>}}
 */
export function resolveCutPoints({ cwd = ROOT, run = defaultRun } = {}) {
  const rows = LANDINGS.map((entry) => {
    const fromGit = readGitCommitTime(entry.sha, { cwd, run });
    const fallback = Date.parse(entry.at);
    const ms = fromGit ?? fallback;
    return { ...entry, ms, source: fromGit === null ? "fallback" : "git" };
  });
  const cuts = Object.create(null);
  let previous = -Infinity;
  for (const row of rows) {
    if (!Number.isFinite(row.ms)) throw new Error(`分界时间读不出来：${row.id}（git 与记录值都失败）`);
    if (row.ms <= previous) throw new Error(`分界时间不单调：${row.id}=${row.ms} 不大于上一个 ${previous}（LANDINGS 顺序错了）`);
    previous = row.ms;
    cuts[row.id] = row.ms;
  }
  return { cuts, rows };
}

/**
 * 一条折痕落在哪个桶。**边界归右**（`at === cut` 视为「之后」）—— 提交那一刻起算「已上线」。
 * @param {number} at 折痕产生时刻（ms）
 * @param {Record<string, number>} cuts
 * @returns {string} `BUCKET_ORDER` 里的一个
 */
export function bucketOf(at, cuts) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) throw new Error(`折痕时间不是数：${at}`);
  if (ms >= Number(cuts.T50)) return "post-T50";
  if (ms >= Number(cuts.T37)) return "T37..T50";
  if (ms >= Number(cuts.T35)) return "T35..T37";
  return "pre-T35";
}

/** 老的 / 新的 二分（新 = `at >= cuts[NEW_SINCE]`）。 */
export function isNew(at, cuts) {
  return Number(at) >= Number(cuts[NEW_SINCE]);
}

/* ───────────────────────────── 5 判据（机械复刻 T33） ───────────────────────────── */

/** 半档取值（0 / 0.5 / 1 …）只用于可接手的 4 个开关。 */
const half = (cond) => (cond ? 0.5 : 0);

/**
 * 一条折痕的可接手性（0–10）。**只用 `measureSample` 已经算出来的字段**，不新增探针。
 * @param {object} m `measureSample` 的返回值
 * @returns {{handoff:number, traceable:number, noHallucination:number, noRedundancy:number, length:number, total:number}}
 */
export function scoreMark(m) {
  const handoff =
    half(m?.stoppedAt !== null && m?.stoppedAt !== undefined) +
    half(Number(m?.nextActionCount) > 0) +
    half(Number(m?.deadendBullets) > 0) +
    half(Number(m?.unverifiedBullets) > 0 || Number(m?.verifiedBullets) > 0);

  const share = m?.traceableShare;
  const traceable = share === null || share === undefined ? 0 : share >= 0.95 ? 2 : share >= 0.8 ? 1.5 : share >= 0.6 ? 1 : share >= 0.3 ? 0.5 : 0;

  let noHallucination = 2;
  if ((m?.unknownIds?.length ?? 0) > 0) noHallucination -= 0.5;
  if ((m?.outOfRangeLater?.length ?? 0) > 0) noHallucination -= 0.5;
  if ((m?.seqMismatch?.length ?? 0) > 0) noHallucination -= 0.5;
  noHallucination = Math.max(0, noHallucination);

  let noRedundancy = 2;
  if (Number(m?.dupLineCount) > 0) noRedundancy -= 0.5;
  if (Number(m?.promptEchoLines) > 0) noRedundancy -= 0.5;
  if (Number(m?.toolCallLeak) > 0) noRedundancy -= 0.75;
  if (Number(m?.emptyishLines) > 0) noRedundancy -= 0.25;
  noRedundancy = Math.max(0, noRedundancy);

  const chars = Number(m?.chars) || 0;
  const length = chars >= 1000 && chars <= 8000 ? 2 : (chars >= 500 && chars < 1000) || (chars > 8000 && chars <= 16000) ? 1 : 0.5;

  const total = handoff + traceable + noHallucination + noRedundancy + length;
  return { handoff, traceable, noHallucination, noRedundancy, length, total };
}

/**
 * 锚点三档（`traceableShare` 的心智模型，输出里当诊断用）：
 *   `good` ≥0.9 · `partial` 0.3–0.9 · `bad` <0.3（含「整篇零锚点」）。
 * @param {number|null} share
 * @returns {"good"|"partial"|"bad"}
 */
export function anchorTierOf(share) {
  const value = share === null || share === undefined ? 0 : Number(share);
  if (!Number.isFinite(value)) return "bad";
  if (value >= 0.9) return "good";
  if (value >= 0.3) return "partial";
  return "bad";
}

/* ───────────────────────────── 汇总（纯函数） ───────────────────────────── */

const mean = (values) => (values.length === 0 ? 0 : values.reduce((n, v) => n + v, 0) / values.length);
const round = (v, digits = 2) => Math.round(Number(v) * 10 ** digits) / 10 ** digits;

/**
 * 一个桶（或任意一组折痕）的统计。
 * 两个「可定位率」都给，因为它们回答不同的问题、也**确实会给出不同的排序**（老：池化 54.5% / 逐条均 61.4%）：
 *   · `traceableRate`      = Σids / Σ(ids+n?)（**池化**：全库一共丢了多少引用）
 *   · `traceableMeanShare` = mean(逐条 share)（**逐条均**：T33 打分用的就是这个口径）
 * @param {Array<object>} rows 每项 `{measured, score}` 或 `measured`（有 `traceableShare`）
 * @returns {object}
 */
export function summarizeBucket(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const measured = list.map((row) => row.measured ?? row);
  const scores = list.map((row) => row.score ?? scoreMark(row.measured ?? row));
  const ids = measured.reduce((n, m) => n + (Number(m.ids) || 0), 0);
  const placeholders = measured.reduce((n, m) => n + (Number(m.placeholders) || 0), 0);
  const refs = ids + placeholders;
  const shares = measured.map((m) => (m.traceableShare === null || m.traceableShare === undefined ? 0 : Number(m.traceableShare)));
  const zeroAnchor = measured.filter((m) => Number(m.ids) === 0 && Number(m.placeholders) > 0);
  const degenerate = measured.filter((m) => Number(m.range?.start) === Number(m.range?.end));
  const sections3 = measured.filter((m) => Number(m.sectionsPresent) === 3);
  return {
    n: list.length,
    ids,
    placeholders,
    refs,
    traceableRate: refs === 0 ? null : round(ids / refs, 4),
    traceableMeanShare: round(mean(shares), 4),
    traceableMedianShare: round(
      shares.length === 0 ? 0 : [...shares].sort((a, b) => a - b)[Math.floor(shares.length / 2)],
      4,
    ),
    zeroAnchor: zeroAnchor.length,
    zeroAnchorRate: list.length === 0 ? null : round(zeroAnchor.length / list.length, 4),
    degenerate: degenerate.length,
    sections3: sections3.length,
    sections3Rate: list.length === 0 ? null : round(sections3.length / list.length, 4),
    placeholdersPerMark: list.length === 0 ? 0 : round(placeholders / list.length, 1),
    anchors: {
      good: measured.filter((m) => anchorTierOf(m.traceableShare) === "good").length,
      partial: measured.filter((m) => anchorTierOf(m.traceableShare) === "partial").length,
      bad: measured.filter((m) => anchorTierOf(m.traceableShare) === "bad").length,
    },
    scores: Object.fromEntries(CRITERIA.map((c) => [c.key, round(mean(scores.map((s) => s[c.key])), 2)])),
    total: round(mean(scores.map((s) => s.total)), 2),
  };
}

/**
 * 老 vs 新（新 = `at >= cuts.NEW_SINCE`）。
 * @param {Array<object>} rows
 * @param {Record<string, number>} cuts
 * @returns {object}
 */
export function compareOldNew(rows, cuts) {
  const list = Array.isArray(rows) ? rows : [];
  const oldRows = list.filter((row) => !isNew(row.measured?.at ?? row.at, cuts));
  const newRows = list.filter((row) => isNew(row.measured?.at ?? row.at, cuts));
  const oldStats = summarizeBucket(oldRows);
  const newStats = summarizeBucket(newRows);
  const gainPp =
    oldStats.traceableRate === null || newStats.traceableRate === null
      ? null
      : round((newStats.traceableRate - oldStats.traceableRate) * 100, 1);
  return { old: oldStats, new: newStats, gainPp, cut: NEW_SINCE };
}

/**
 * 三档判据（见文件头）。**必须能返回 `not-fixed`**，否则这个守卫就是永远绿的假门禁。
 * @param {{newZeroAnchor:number, oldTraceableRate:number|null, newTraceableRate:number|null}} input
 * @returns {{tier:"fixed"|"partial"|"not-fixed", gainPp:number|null, reason:string}}
 */
export function verdictOf({ newZeroAnchor, oldTraceableRate, newTraceableRate } = {}) {
  const zero = Number(newZeroAnchor) || 0;
  const gainPp =
    oldTraceableRate === null || oldTraceableRate === undefined || newTraceableRate === null || newTraceableRate === undefined
      ? null
      : round((Number(newTraceableRate) - Number(oldTraceableRate)) * 100, 1);
  if (zero > 0) {
    return { tier: "not-fixed", gainPp, reason: `新折痕里仍有 ${zero} 条整篇零锚点 ⇒ 0% 仍在，T35/T37 没修好` };
  }
  if (gainPp !== null && gainPp >= VERDICT_RULES.minGain * 100) {
    return { tier: "fixed", gainPp, reason: `零锚点归零，可定位率 +${gainPp}pp ⇒ 假设成立` };
  }
  return {
    tier: "partial",
    gainPp,
    reason: `零锚点归零（悬崖没了），但可定位率 ${gainPp === null ? "无法比较" : `${gainPp >= 0 ? "+" : ""}${gainPp}pp`} < 10pp ⇒ 只修掉了悬崖，没修掉地基`,
  };
}

/* ───────────────────────────── 只读扫盘 ───────────────────────────── */

/** 只读打开一张棋谱；坏图跳过（不吞成「没有折痕」——计数里能看出来）。 */
function readGraph(file) {
  try {
    const graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return graph !== null && typeof graph === "object" ? graph : null;
  } catch {
    return null;
  }
}

/**
 * 扫全库，产出**可复判池**（一会话至多一条）。
 *
 * 为什么必须按 `slot.at` 配 mark（而不是只按区间）：`lastOfflineSummary` 只有**一个槽**，
 * 补账每折一次就把正文改写一次。T33 按「区间相同」配 mark，一旦同一区间被重折，
 * 就会把**旧的 at** 配到**新的正文**上（本仓所谓「两个数」的典型来源）。这里以 `slot.at` 为准，
 * 差 ≤5ms 才算同一次（生产者把同一个时间写了两次，实测 424/426 精确相等、2 条差 1–3ms）。
 *
 * @param {string} home
 * @param {{asOf?:number|null}} [opts] asOf = 只算 `at <= asOf` 的折痕（冻结快照，可复现）
 * @returns {{sessions:number, marks:number, charsOnly:number, pool:Array<object>, asOf:number|null}}
 */
export function collectPool(home, { asOf = null } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    return { sessions: 0, marks: 0, charsOnly: 0, beyondSnapshot: 0, pool: [], allMarks: [], asOf, missing: true };
  }
  let sessions = 0;
  let marks = 0;
  let charsOnly = 0;
  let beyondSnapshot = 0;
  const pool = [];
  // ★ 全折痕索引：退化区间的证伪**不能只看池** —— 池里一会话只有最新一条，
  //   而「T37 之后还产出退化区间」这种事实，任何一条折痕都算证据（它不必是最新的那条）。
  const allMarks = [];
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null) continue;
    sessions += 1;
    const list = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    marks += list.length;
    const sessionId = String(graph.sessionId ?? entry.name);
    for (const m of list) {
      const mAt = Number(m?.at);
      if (!Number.isFinite(mAt)) continue;
      if (asOf !== null && mAt > asOf) continue;
      allMarks.push({ sessionId, at: mAt, seqStart: Number(m?.seqStart), seqEnd: Number(m?.seqEnd), trigger: String(m?.trigger ?? "undefined") });
    }
    const slot = graph.lastOfflineSummary;
    const text = typeof slot?.text === "string" && slot.text !== "" ? slot.text : null;
    if (text === null) {
      charsOnly += list.filter((m) => Number(m?.summaryChars) > 0).length;
      continue;
    }
    const start = Number(slot?.range?.start);
    const end = Number(slot?.range?.end);
    const slotAt = Number(slot?.at);
    const sameRange = list.filter((m) => Number(m?.seqStart) === start && Number(m?.seqEnd) === end);
    if (sameRange.length === 0) {
      charsOnly += list.filter((m) => Number(m?.summaryChars) > 0).length;
      continue;
    }
    const mark =
      sameRange.find((m) => Number.isFinite(slotAt) && Math.abs(Number(m?.at) - slotAt) <= 5) ?? sameRange[sameRange.length - 1];
    const at = Number(mark?.at);
    if (!Number.isFinite(at)) continue;
    if (asOf !== null && at > asOf) {
      beyondSnapshot += 1;
      continue;
    }
    // ★ 「离会话尾部多远」—— 可定位率最强的单一解释变量（见 §5）。
    const sessionMaxSeq = Object.values(graph.nodes ?? {}).reduce((max, node) => {
      const seq = Number(node?.seq);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
    const sample = {
      sessionId,
      trigger: String(mark?.trigger ?? "undefined"),
      source: "lastOfflineSummary",
      text,
      chars: text.length,
      at,
      seqStart: start,
      seqEnd: end,
      mark,
      lastOfflineSummary: slot,
    };
    const measured = measureSample(sample, graph);
    pool.push({ sessionId, measured, score: scoreMark(measured), text, sessionMaxSeq });
  }
  pool.sort((a, b) => a.measured.at - b.measured.at || a.sessionId.localeCompare(b.sessionId));
  allMarks.sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId));
  return { sessions, marks, charsOnly, beyondSnapshot, pool, allMarks, asOf };
}

/** 按桶分组（保持 `BUCKET_ORDER` 顺序）。 */
export function groupByBucket(pool, cuts) {
  const groups = Object.fromEntries(BUCKET_ORDER.map((name) => [name, []]));
  for (const row of pool) groups[bucketOf(row.measured.at, cuts)].push(row);
  return groups;
}

/**
 * 跨度分档（归因用）：窄折痕天然引用不到区间内的实体 ⇒ 可定位率天然低。
 * 这不是新发明：`sanitizeSummaryIds` 会把 `span.end > 边界` 的 id 抹成 `n?`，
 * 而边界 = 「区间内最后一个实体」⇒ **区间越窄，被抹的比例越高**。
 * @param {Array<object>} rows
 * @returns {Array<{band:string, lo:number, hi:number, n:number, ids:number, placeholders:number, traceableRate:number|null}>}
 */
export function spanBands(rows) {
  const bands = [
    { band: "1 事件", lo: 1, hi: 1 },
    { band: "2–20", lo: 2, hi: 20 },
    { band: "21–100", lo: 21, hi: 100 },
    { band: "101–400", lo: 101, hi: 400 },
    { band: "401+", lo: 401, hi: Number.MAX_SAFE_INTEGER },
  ];
  return bands.map((b) => {
    const list = (Array.isArray(rows) ? rows : []).filter((row) => {
      const m = row.measured ?? row;
      const span = Number(m.range?.end) - Number(m.range?.start) + 1;
      return span >= b.lo && span <= b.hi;
    });
    const stats = summarizeBucket(list);
    return { band: b.band, lo: b.lo, hi: b.hi, n: stats.n, ids: stats.ids, placeholders: stats.placeholders, traceableRate: stats.traceableRate };
  });
}

/**
 * 「离会话尾部多远」分档（归因用）。`gap = 会话最大 seq − 折痕终点`：
 *   · `gap === 0` = 折到会话末尾 ⇒ 摘要里几乎没有「未来」实体可被抹（老折痕实测 99.6% 可定位）；
 *   · `gap` 越大 = 折的是历史中段 ⇒ 摘要引用的实体大量落在 `range.end` 之后 ⇒ sanitize 抹成 `n?`。
 * @param {Array<object>} rows
 * @returns {Array<{band:string, lo:number, hi:number, n:number, ids:number, placeholders:number, traceableRate:number|null}>}
 */
export function tailGapBands(rows) {
  const bands = [
    { band: "折到尾部(0)", lo: 0, hi: 0 },
    { band: "1–20", lo: 1, hi: 20 },
    { band: "21–100", lo: 21, hi: 100 },
    { band: "100+", lo: 101, hi: Number.MAX_SAFE_INTEGER },
  ];
  return bands.map((b) => {
    const list = (Array.isArray(rows) ? rows : []).filter((row) => {
      const m = row.measured ?? row;
      const gap = Number(row.sessionMaxSeq ?? NaN) - Number(m.range?.end);
      return Number.isFinite(gap) && gap >= b.lo && gap <= b.hi;
    });
    const stats = summarizeBucket(list);
    return { band: b.band, lo: b.lo, hi: b.hi, n: stats.n, ids: stats.ids, placeholders: stats.placeholders, traceableRate: stats.traceableRate };
  });
}

/* ───────────────────────────── 渲染 ───────────────────────────── */

const fmtTime = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "时间未知";
  return new Date(n).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
};
const pct = (v, digits = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${(Number(v) * 100).toFixed(digits)}%`);

/**
 * 算一次完整的审计（纯函数外壳：只读，不写盘）。
 * @param {{home:string, asOf?:number|null, liveSince?:number|null, run?:Function}} args
 * @returns {object}
 */
export function audit({ home, asOf = null, liveSince = null, run = defaultRun } = {}) {
  const { cuts, rows: landingRows } = resolveCutPoints({ run });
  const scanned = collectPool(home, { asOf });
  const pool = scanned.pool;
  const groups = groupByBucket(pool, cuts);
  const buckets = BUCKET_ORDER.map((name) => ({ name, ...summarizeBucket(groups[name]) }));
  const comparison = compareOldNew(pool, cuts);
  const verdict = verdictOf({
    newZeroAnchor: comparison.new.zeroAnchor,
    oldTraceableRate: comparison.old.traceableRate,
    newTraceableRate: comparison.new.traceableRate,
  });
  const newRows = pool.filter((row) => isNew(row.measured.at, cuts));
  const oldRows = pool.filter((row) => !isNew(row.measured.at, cuts));

  // ★ 全折痕口径（不止池）：退化区间是**产生时**就定死的形状，任何一条折痕都算证据。
  const degenerateAllNew = scanned.allMarks.filter(
    (mark) => isNew(mark.at, cuts) && Number(mark.seqStart) === Number(mark.seqEnd),
  );
  const degenerateAllByBucket = Object.fromEntries(
    BUCKET_ORDER.map((name) => {
      const list = scanned.allMarks.filter((mark) => bucketOf(mark.at, cuts) === name);
      return [name, { n: list.length, degenerate: list.filter((m) => Number(m.seqStart) === Number(m.seqEnd)).length }];
    }),
  );

  // ★ 校准：同一把尺子量 T33 的冻结 10 条（报告 7.0 分的那一组）。
  const bySession = new Map(pool.map((row) => [row.sessionId, row]));
  const frozenRows = FROZEN_SAMPLE_SESSIONS.map((id) => bySession.get(id)).filter(Boolean);
  const frozen = summarizeBucket(frozenRows);

  return {
    home,
    asOf: scanned.asOf,
    liveSince,
    sessions: scanned.sessions,
    marks: scanned.marks,
    charsOnly: scanned.charsOnly,
    beyondSnapshot: scanned.beyondSnapshot,
    poolSize: pool.length,
    unjudgeable: Math.max(0, scanned.marks - pool.length),
    landings: landingRows,
    cuts,
    buckets,
    comparison,
    verdict,
    newRows,
    oldRows,
    newDegenerate: newRows
      .filter((row) => Number(row.measured.range.start) === Number(row.measured.range.end))
      .map((row) => ({ sessionId: row.sessionId, seq: row.measured.range.start, at: row.measured.at })),
    degenerateAllNew,
    degenerateAllByBucket,
    allMarks: scanned.allMarks.length,
    newZeroAnchors: newRows
      .filter((row) => Number(row.measured.ids) === 0 && Number(row.measured.placeholders) > 0)
      .map((row) => ({ sessionId: row.sessionId, seq: [row.measured.range.start, row.measured.range.end], at: row.measured.at })),
    span: { old: spanBands(oldRows), new: spanBands(newRows) },
    tail: { old: tailGapBands(oldRows), new: tailGapBands(newRows) },
    frozen,
    frozenMissing: FROZEN_SAMPLE_SESSIONS.filter((id) => !bySession.has(id)),
  };
}

/**
 * 渲染成人读文本（数组，逐行）。
 * @param {object} result `audit()` 的返回
 * @returns {string[]}
 */
export function render(result) {
  const out = [];
  out.push("摘要可接手性 · 按折痕年龄分桶（T52 · 只读 · 零模型调用）");
  out.push(`home            : ${result.home}`);
  out.push(
    `语料            : ${result.sessions} 会话 / ${result.marks} 折痕 / 可复判池 ${result.poolSize} 条` +
      `（正文只活在 lastOfflineSummary 单槽 ⇒ 一会话至多一条；剩下 ${result.unjudgeable} 条折痕没有可复判正文` +
      `${result.beyondSnapshot > 0 ? `；${result.beyondSnapshot} 条晚于快照被排除` : ""}）`,
  );
  out.push(`快照            : as-of ${result.asOf === null ? "（未冻结，会随补账漂移）" : fmtTime(result.asOf)}`);
  out.push("");
  out.push("§0 分界（来自 git log 的 commit time，不是拍的）");
  for (const row of result.landings) {
    out.push(
      `  ${row.id}  ${row.sha}  ${fmtTime(row.ms)}  ${row.source === "git" ? "git" : "**fallback**"}  ${row.what}`,
    );
  }
  out.push(
    "  ⚠ 提交时间 ≠ 生效时间：ESM 在宿主启动时加载。本脚本按提交时间分桶，但「T37 之后」不等于「T37 的代码在跑」",
  );
  if (result.liveSince !== null) {
    out.push(
      `  运行中代码的加载时刻（人工提供）：${fmtTime(result.liveSince)} ⇒ ` +
        `${result.landings
          .filter((row) => row.ms > result.liveSince)
          .map((row) => row.id)
          .join(" / ") || "（无）"} 这些提交**没有进运行进程**`,
    );
  } else {
    out.push("  运行中代码的加载时刻：未提供（--live-since）—— 见报告 §5，别把「提交了」当「在跑」");
  }
  out.push("");

  out.push("§1 分桶统计（桶 = 折痕自己的 mark.at；新 = ≥" + result.comparison.cut + "）");
  out.push(
    "| 桶 | 折痕 | 可定位率(池化) | 可定位率(逐条均) | 段齐率 | n? 占位 | n?/条 | 整篇零锚点 | 退化区间 | 可接手 | 可定位 | 无幻觉 | 无冗余 | 长度 | 总分 |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const b of result.buckets) {
    out.push(
      `| ${b.name} | ${b.n} | ${pct(b.traceableRate)} | ${pct(b.traceableMeanShare)} | ${pct(b.sections3Rate)} | ` +
        `${b.placeholders} | ${b.placeholdersPerMark} | ${b.zeroAnchor}（${pct(b.zeroAnchorRate)}） | ${b.degenerate} | ` +
        `${b.scores.handoff} | ${b.scores.traceable} | ${b.scores.noHallucination} | ${b.scores.noRedundancy} | ${b.scores.length} | **${b.total}** |`,
    );
  }
  out.push("");
  out.push(
    "> 5 判据各 2 分、总分 10 分（T33 的同一套维度，机械化规则见文件头）。分桶的**每一条**都参与评分，不是抽样。",
  );
  out.push("");

  out.push("§2 新 vs 老（一个百分比 + 分母）");
  out.push(
    `  老折痕（< ${result.comparison.cut}）：可定位率 ${pct(result.comparison.old.traceableRate)}` +
      `（${result.comparison.old.ids} / ${result.comparison.old.refs} 引用 · ${result.comparison.old.n} 条折痕）`,
  );
  out.push(
    `  新折痕（≥ ${result.comparison.cut}）：可定位率 ${pct(result.comparison.new.traceableRate)}` +
      `（${result.comparison.new.ids} / ${result.comparison.new.refs} 引用 · ${result.comparison.new.n} 条折痕）`,
  );
  out.push(
    `  差 ${result.comparison.gainPp === null ? "—（有桶为空）" : `${result.comparison.gainPp >= 0 ? "+" : ""}${result.comparison.gainPp}pp`}` +
      `　（逐条均 ${pct(result.comparison.old.traceableMeanShare)} → ${pct(result.comparison.new.traceableMeanShare)}` +
      ` · 中位 ${pct(result.comparison.old.traceableMedianShare)} → ${pct(result.comparison.new.traceableMedianShare)}）`,
  );
  out.push(`  锚点三档（good≥0.9 / partial 0.3–0.9 / bad<0.3）：老 ${result.comparison.old.anchors.good}/${result.comparison.old.anchors.partial}/${result.comparison.old.anchors.bad}` +
    ` · 新 ${result.comparison.new.anchors.good}/${result.comparison.new.anchors.partial}/${result.comparison.new.anchors.bad}`);
  const oldTail = result.tail.old[0];
  const newTail = result.tail.new[0];
  out.push(
    `  ⚠ 形状不同、不能直接读成改进：老的「折到尾部」${oldTail.n} 条（可定位率 ${pct(oldTail.traceableRate)}），` +
      `新的 ${newTail.n} 条 —— 新折痕全是**追赶历史缺口**的补账折，天然离尾部远。`,
  );
  out.push("");

  out.push("§3 证伪：新折痕里还有没有「整篇零锚点」的");
  out.push(`  新折痕整篇零锚点：**${result.comparison.new.zeroAnchor} / ${result.comparison.new.n}**`);
  if (result.newZeroAnchors.length === 0) {
    out.push("  ⇒ 0% 这个数**没有**在新折痕里出现（反例：无）");
  } else {
    for (const row of result.newZeroAnchors) {
      out.push(`  ✗ 反例：${row.sessionId} seq ${row.seq[0]}-${row.seq[1]} @ ${fmtTime(row.at)}`);
    }
  }
  out.push(`  池内新折痕里**仍有退化区间**（seqStart === seqEnd）：${result.newDegenerate.length} 条`);
  for (const row of result.newDegenerate) {
    out.push(`  ✗ 反例（池内）：${row.sessionId} seq ${row.seq}-${row.seq} @ ${fmtTime(row.at)}`);
  }
  out.push(
    `  全库折痕口径（不止池，${result.allMarks} 条）：新折痕里退化区间 **${result.degenerateAllNew.length} 条**`,
  );
  for (const row of result.degenerateAllNew.slice(0, 12)) {
    out.push(`  ✗ 反例（全库）：${row.sessionId} seq ${row.seqStart}-${row.seqEnd} @ ${fmtTime(row.at)}`);
  }
  if (result.degenerateAllNew.length > 12) out.push(`  …还有 ${result.degenerateAllNew.length - 12} 条（--json 看全量）`);
  out.push(
    "  分桶（全折痕）：" +
      BUCKET_ORDER.map((name) => {
        const cell = result.degenerateAllByBucket[name];
        return `${name} ${cell.degenerate}/${cell.n}`;
      }).join(" · "),
  );
  if (result.degenerateAllNew.length > 0) {
    out.push("  ⇒ T37 的判据（跨度与欠账区间不相交时如实报实际跨度）**不会再产出这种形状**；它还在产出 ⇒ 修复没进运行进程");
  }
  out.push("");

  out.push("§4 新总分");
  out.push(
    `  **${result.comparison.new.total} / 10**（分母 ${result.comparison.new.n} 条新折痕）` +
      `　老折痕 ${result.comparison.old.total} / 10（${result.comparison.old.n} 条）` +
      `　差 ${(result.comparison.new.total - result.comparison.old.total >= 0 ? "+" : "") + round(result.comparison.new.total - result.comparison.old.total, 2)}`,
  );
  out.push(
    `  逐项：可接手 ${result.comparison.new.scores.handoff} · 可定位 ${result.comparison.new.scores.traceable} · ` +
      `无幻觉 ${result.comparison.new.scores.noHallucination} · 无冗余 ${result.comparison.new.scores.noRedundancy} · 长度 ${result.comparison.new.scores.length}`,
  );
  out.push(`  三档判据：**${result.verdict.tier}** —— ${result.verdict.reason}`);
  out.push("");

  out.push("§5 归因：可定位率跟着「折痕形状」走，不跟着提交走");
  out.push("（a）按跨度（`seqEnd − seqStart + 1`）：");
  out.push("| 跨度(事件) | 老折痕 | 可定位率 | 新折痕 | 可定位率 |");
  out.push("|---|---|---|---|---|");
  result.span.old.forEach((band, i) => {
    const other = result.span.new[i];
    out.push(`| ${band.band} | ${band.n} | ${pct(band.traceableRate)} | ${other.n} | ${pct(other.traceableRate)} |`);
  });
  out.push("（b）按「离会话尾部多远」（`会话最大 seq − seqEnd`）：");
  out.push("| 离尾部(事件) | 老折痕 | 可定位率 | 新折痕 | 可定位率 |");
  out.push("|---|---|---|---|---|");
  result.tail.old.forEach((band, i) => {
    const other = result.tail.new[i];
    out.push(`| ${band.band} | ${band.n} | ${pct(band.traceableRate)} | ${other.n} | ${pct(other.traceableRate)} |`);
  });
  out.push(
    "  ⇒ `sanitizeSummaryIds` 把 `span.end > 边界` 的 id 抹成 `n?`，边界 = 「区间内最后一个实体」：",
  );
  out.push("    **折到会话末尾的折痕几乎不会丢锚点（老 99.6%），折历史中段的会丢一半**；区间越窄也一样。");
  out.push("    形状是**生产条件**（补账追赶 vs 尾部折叠），不是 T35/T37 能改的东西。");
  out.push("");

  out.push("§6 尺子校准（同一套规则量 T33 冻结 10 条）");
  out.push(
    `  本脚本 ${result.frozen.total} / 10（${result.frozen.n} 条）vs T33 报告 ${T33_REPORTED.total} / 10` +
      `（偏差 ${(result.frozen.total - T33_REPORTED.total >= 0 ? "+" : "") + round(result.frozen.total - T33_REPORTED.total, 2)}）`,
  );
  out.push(
    "  | 判据 | 本脚本 | T33 报告 |\n  |---|---|---|\n" +
      CRITERIA.map((c) => `  | ${c.name} | ${result.frozen.scores[c.key]} | ${T33_REPORTED[c.key]} |`).join("\n"),
  );
  out.push("  ⇒ 跨桶比较可靠（同一把尺子）；绝对分带 +0.5 左右的系统偏差，别把 7.6 当成「比 T33 的 7.0 更好」。");
  if (result.frozenMissing.length > 0) out.push(`  ⚠ 冻结样本有 ${result.frozenMissing.length} 条已不在池里：${result.frozenMissing.join("、")}`);
  out.push("");
  return out;
}

/* ───────────────────────────── CLI ───────────────────────────── */

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const get = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : dflt;
  };
  const home = resolveHome(get("home"));
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    console.error(`没有棋谱目录：${sessionsDir}`);
    return 2;
  }
  const asOfRaw = get("as-of");
  const asOf = asOfRaw === null ? Date.now() : Date.parse(asOfRaw);
  if (!Number.isFinite(asOf)) {
    console.error(`--as-of 解析不了：${asOfRaw}`);
    return 2;
  }
  const liveRaw = get("live-since");
  const liveSince = liveRaw === null ? null : Date.parse(liveRaw);
  if (liveRaw !== null && !Number.isFinite(liveSince)) {
    console.error(`--live-since 解析不了：${liveRaw}`);
    return 2;
  }
  const result = audit({ home, asOf, liveSince });
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          home: result.home,
          asOf: result.asOf,
          liveSince: result.liveSince,
          sessions: result.sessions,
          marks: result.marks,
          charsOnly: result.charsOnly,
          poolSize: result.poolSize,
          landings: result.landings.map((row) => ({ id: row.id, sha: row.sha, ms: row.ms, source: row.source })),
          buckets: result.buckets,
          comparison: result.comparison,
          verdict: result.verdict,
          newDegenerate: result.newDegenerate,
          newZeroAnchors: result.newZeroAnchors,
          span: result.span,
          frozen: { n: result.frozen.n, total: result.frozen.total, scores: result.frozen.scores },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const line of render(result)) console.log(line);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
