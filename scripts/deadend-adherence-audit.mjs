#!/usr/bin/env node
/**
 * deadend-adherence-audit.mjs —— **「死路必须逐条写 id」的遵守率**（C645 · 只读 · 零模型调用）
 *
 * 由来（2026-11-05 05:5x，Lead 实测）：
 *   C607 给提示词加了硬规则「**一条边一行**，不许写 `e693—e698` 这种区间」，
 *   但真机统计只知道「19/579 条折痕 `failureRecall < 1`」，**不知道模型对这条规则的遵守率是多少**，
 *   更不知道它在变好还是变坏。没有度量就没法判「提示词还要不要更硬」——
 *   这是本项目的老毛病（先改，后猜，再改）。
 *
 * 本脚本把三件**互相独立**的事分开算，这是它存在的全部理由：
 *   ① **模型自己写了多少**（遵守率）—— 只看模型正文，**剥掉机械补回段**；
 *   ② **机械补回救了多少**（补回段里的 id）—— 那是代码的功劳，不是模型的；
 *   ③ **区间合并**（`e693—e698` / `e107/e113`）—— 这是「格式违规」，与「丢 id」分开统计。
 *   把 ① 和 ② 混在一起（只看最终正文的 `failureRecall`）就是**把补回当成模型的功劳**，
 *   那样遵守率永远 100%，提示词永远「够硬」—— 这是最坏的一种假绿。
 *
 * 判据（全部机械字符串匹配，不做语义判断）：
 *   · 分母 = `failuresInFoldRange(graph, {start: seqStart, end: seqEnd})` —— 与探针**同源**，
 *     排除 rewash 残留（`isDanglingResidue`），只算 evidence 与区间有交集的失败边；
 *   · 分子 = 模型正文里**作为独立标识符**出现 id 的边（`mentionsEdge`，`e1` 不匹配 `e12`）；
 *   · **遵守率 = 分子 / 分母**；
 *   · **补回后 = (分子 + 只在补回段出现的 id) / 分母** —— 补回跑过的话它必然 = 1。
 *
 * 为什么必须剥补回段（`test/deadend-adherence.test.mjs` 钉的就是这条）：
 *   `repairMissingFailures` 把漏掉的边**逐条**追加到摘要尾部（标题
 *   `## 已探明死路（逐字补充 · 机械补回，不许重试）`）。补回段里的每一行都是
 *   `- e694 「动作」→ 为什么失败`，**它能被 `mentionsEdge` 正常命中**。
 *   所以「对最终正文算 recall」在补回跑过之后恒 = 1，模型漏了 4 条也看不出来。
 *
 * 样本口径（**必须写在报告里，否则数字会被误读**）：
 *   摘要正文只落在 `graph.lastOfflineSummary` 里，而它**只保留每个会话的最后一段**
 *   （`structure-audit` / `fold-loss-audit` / `reasoning-share-audit` 三个脚本都写着同一条限制）。
 *   ⇒ 每个会话**最多一条**折痕可测，且只能是「最近的那次离线折叠」。
 *   `pressure` / `tier2` **不写正文**（它们走引擎的在线路径）⇒ 这两组的**正文口径恒为空**，
 *   报告里用**记录口径**（`quality.failureRecall`，那是折叠当时在最终正文上算的）兜底，
 *   两种口径**分列**，不合并。
 *
 * 用法：
 *   node scripts/deadend-adherence-audit.mjs                  # 默认 DSH_HOME
 *   node scripts/deadend-adherence-audit.mjs --home <dir>      # 换 home
 *   node scripts/deadend-adherence-audit.mjs --json            # 机读（报告/测试用）
 *   node scripts/deadend-adherence-audit.mjs --session fdd814  # 只看某个会话
 *   node scripts/deadend-adherence-audit.mjs --limit=10        # 明细只列最近 10 条
 *   node scripts/deadend-adherence-audit.mjs --now <iso>       # 固定「现在」（分桶可复现）
 *   node scripts/deadend-adherence-audit.mjs --no-git          # 不查提示词世代
 *   node scripts/deadend-adherence-audit.mjs --no-probe        # 不探宿主进程启动时刻
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";

/* ─────────────────────────────── 常量（改口径只改这里） ─────────────────────────────── */

/**
 * `repairMissingFailures` 写进摘要的段标题（`src/rooms/offline-fold.mjs`）。
 * 它前面的**全部**文字才算「模型自己写的」。
 */
export const REPAIR_FAILURES_HEADING = "## 已探明死路（逐字补充";

/**
 * `repairMissingConstraints` 的段标题。它同样被追加在尾部，且**排在补回段之前**
 * （`runOfflineFold` 里先补约束、再补死路）—— 切分点取两者**较早**的那个。
 */
export const REPAIR_CONSTRAINTS_HEADING = "## 约束（逐字补充";

/** 任务书的判据：遵守率 < 90% ⇒ 提示词还不够硬，要给出更硬的改法。 */
export const ADHERENCE_TARGET = 0.9;

/** 时间分桶窗口：最近 6 小时 vs 更早（用来判断 C607 的提示词改动有没有效果）。 */
export const BUCKET_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/** 报告里要固定顺序显示的分组（其余 trigger 追加在后面）。 */
export const TRIGGER_ORDER = ["archive-offline", "pressure", "tier2"];

/** 「没有 trigger 字段」的老折痕在报告里的名字（不编造）。 */
export const UNKNOWN_TRIGGER = "(无 trigger)";

/**
 * **区间合并**的两种写法（C607 明令禁止的那个动作）。
 *
 * 为什么必须用 `[ \t]*` 而不是 `\s*`：合规写法是**一行一条**——
 *   ```
 *   - e123 「动作」→ 为什么失败
 *   - e124 「动作」→ 为什么失败
 *   ```
 * 而断行**前面那个字符很容易正好是个 id**（真机 `session-example`：
 *   `…↻2，↑later-ok:e117` 换行 `- e164 \`bash(...\` → …`）。
 * `\s*` 会把那个换行 + 列表符号 `-` 当成区间破折号 ⇒ 这一条合规摘要被记成一次「区间合并」。
 * 实测（同一批 248 段正文）：`[ \t]*` 数出 16 次，`\s*` 数出 17 次 —— 多出来的那一次
 * 就是 `e117\n- e164`，**47 个 id 的差**（`164-117-1`）全是假的。
 * `scripts/fold-loss-audit.mjs` 的 `mentionedEdgeRanges` 用的就是 `\s*`：
 * 它那边是「判定用、宁可宽」，这里是**度量**用，宽一个字符就是假数据。
 *
 * 破折号族：`—` `–` `－` `~` `～` `-` / `--`。左右**只允许空格与制表符**。
 */
const DASH_RANGE_RE = /(?<![A-Za-z0-9_])e([0-9]{1,4})[ \t]*(?:—|–|－|~|～|-{1,2})[ \t]*e([0-9]{1,4})(?![0-9])/g;

/**
 * 斜杠合并（`e107/e113`）—— 真机里比破折号**更常见**的一种「省字数」写法。
 *
 * 它不是 C607 点名的那种，但它做的是同一件事：把两条边压成一个 token。
 * 注意：它**不会**让 id 消失（`e107` 与 `e113` 都还能被 `mentionsEdge` 命中），
 * 所以它只影响「格式违规」，不影响遵守率 —— 两者必须分开报，混在一起会得出
 * 「合并很多但没丢 id」这种自相矛盾的结论。
 */
const SLASH_RANGE_RE = /(?<![A-Za-z0-9_])e([0-9]{1,4})[ \t]*\/[ \t]*e?([0-9]{1,4})(?![0-9])/g;

/* ─────────────────────────────────── 小工具 ─────────────────────────────────── */

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "—");
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(2)}%`);
const int = (x) => (Number.isFinite(Number(x)) ? String(Math.round(Number(x))) : "—");

/** 与 doctor / graph-audit / fold-loss-audit / structure-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/* ─────────────────────────────── ① 剥机械补回段 ─────────────────────────────── */

/**
 * 把「最终正文」切成 **模型自己写的** 与 **机械补回的** 两半。
 *
 * 补回段是 `repairMissingConstraints` / `repairMissingFailures` **追加在尾部**的，
 * 顺序固定：`[模型正文] + [约束补回段] + [死路补回段]`。所以切分点 = 两个标题里**较早**的那个。
 *
 * 为什么不能只认死路那个标题：约束补回段在它**前面**，只切死路会把约束补回段
 * 留给「模型正文」—— 现在看起来无害（那里面不会有边 id），但那是**碰巧**，
 * 一旦补回格式变了（比如把 id 也写进约束行）就会静默把补回算成模型的功劳。
 *
 * @param {string} text 最终正文（`lastOfflineSummary.text`）
 * @returns {{modelText:string, repairText:string, hasRepairSection:boolean, cut:number}}
 */
export function splitModelText(text) {
  const body = String(text ?? "");
  const cuts = [body.indexOf(REPAIR_FAILURES_HEADING), body.indexOf(REPAIR_CONSTRAINTS_HEADING)].filter((i) => i >= 0);
  if (cuts.length === 0) return { modelText: body, repairText: "", hasRepairSection: false, cut: -1 };
  const cut = Math.min(...cuts);
  return { modelText: body.slice(0, cut), repairText: body.slice(cut), hasRepairSection: true, cut };
}

/* ─────────────────────────────── ② 区间合并计数 ─────────────────────────────── */

/**
 * 数一段正文里有多少**区间合并**写法，以及它们**吞掉了几个 id**。
 *
 * 「吞掉」的口径：`e693—e698` 只剩首尾两个 id 能被逐字命中，中间
 * `e694…e697` 共 `698-693-1 = 4` 个 id **在正文里不存在**。
 * 这个数只对**升序**区间有意义（`e698—e693` 也照样算，取绝对差）。
 *
 * `dashRanges` 保留**数值区间**：明细里要回答「这一个漏掉的 id 是不是被某个区间吞掉的」，
 * 只留 `e693—e698` 这种字符串还得再解析一次（两处解析必然分叉）。
 *
 * @param {string} text
 * @returns {{dash:string[], slash:string[], dashRanges:Array<{from:number,to:number,raw:string}>,
 *   dashSwallowed:number, slashSwallowed:number}}
 */
export function countRangeMerges(text) {
  const body = String(text ?? "");
  const dash = [];
  const dashRanges = [];
  let dashSwallowed = 0;
  for (const m of body.matchAll(DASH_RANGE_RE)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    dash.push(m[0]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    dashRanges.push({ from: Math.min(from, to), to: Math.max(from, to), raw: m[0] });
    if (from !== to) dashSwallowed += Math.abs(to - from) - 1;
  }
  const slash = [];
  let slashSwallowed = 0;
  for (const m of body.matchAll(SLASH_RANGE_RE)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    slash.push(m[0]);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) slashSwallowed += Math.abs(to - from) - 1;
  }
  return { dash, slash, dashRanges, dashSwallowed, slashSwallowed };
}

/**
 * 这个 id 是不是被某个**破折号区间**吞掉的（`e695` 落在 `e693—e698` 里）。
 *
 * 为什么要单独判：`missingIds` 只告诉你「丢了」，`dashRanges` 只告诉你「写了区间」。
 * 只有把两者对起来，才能回答「C607 那条规则到底解决的是不是**主要**丢因」——
 * 否则「合并 16 次」和「缺 11 条」是两个互不相干的数字，谁都能拿它编故事。
 *
 * @param {string} id `e695`
 * @param {Array<{from:number,to:number}>} ranges
 * @returns {boolean}
 */
export function coveredByDashRange(id, ranges) {
  const m = /^e([0-9]+)$/.exec(String(id ?? "").trim());
  if (m === null) return false;
  const n = Number(m[1]);
  return (Array.isArray(ranges) ? ranges : []).some((r) => n >= r.from && n <= r.to);
}

/* ─────────────────────────────── ③ 摘要正文的取法 ─────────────────────────────── */

/**
 * 摘要正文：只认 `lastOfflineSummary`，且**区间必须对得上**。
 *
 * 对不上就是「正文没落盘」—— 这时宁可说不知道，也不拿别的段冒充（那会把审计变成编造）。
 * 与 `scripts/structure-audit.mjs` / `scripts/fold-loss-audit.mjs` 同一实现，别分叉。
 *
 * @param {any} graph
 * @param {any} mark
 * @returns {{text:string|null, why:string}}
 */
export function summaryTextFor(graph, mark) {
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") {
    return { text: null, why: "没有 lastOfflineSummary" };
  }
  const same = Number(last?.range?.start) === Number(mark?.seqStart) && Number(last?.range?.end) === Number(mark?.seqEnd);
  if (!same) {
    return {
      text: null,
      why:
        `lastOfflineSummary 是另一段（${last?.range?.start}-${last?.range?.end}），` +
        `本次正文未落盘（只有 summaryChars=${mark?.summaryChars ?? "?"}）`,
    };
  }
  return { text: last.text, why: `lastOfflineSummary.range=${last.range.start}-${last.range.end}` };
}

/* ─────────────────────────────── ④ 单条折痕 ─────────────────────────────── */

/**
 * 算**一条** foldMark 的遵守率。
 *
 * @param {object} graph 棋谱
 * @param {object} mark foldMark
 * @param {{index?:number|null, session?:string|null}} [meta]
 * @returns {object} 一行（字段见实现；`measurable=false` 时分子分母都是 null，不写 0 冒充）
 */
export function markAdherence(graph, mark, { index = null, session = null } = {}) {
  const range = { start: Number(mark?.seqStart), end: Number(mark?.seqEnd) };
  let edges = [];
  try {
    edges = failuresInFoldRange(graph, range);
  } catch {
    // 坏图不许让整份报告失败（本仓体检脚本的老规矩）
    edges = [];
  }
  const quality = mark?.quality ?? null;
  const detected = summaryTextFor(graph, mark);
  /** @type {any} */
  const row = {
    session,
    index,
    seqStart: range.start,
    seqEnd: range.end,
    at: Number(mark?.at) || 0,
    trigger: String(mark?.trigger ?? ""),
    model: mark?.route?.model ?? null,
    fallback: mark?.fallback ?? null,
    summaryChars: Number(mark?.summaryChars) || 0,
    // 记录口径（折叠当时写下来的）—— 与正文口径**分列**，不混合
    recordedExpected: Number(quality?.expectedFailures) || 0,
    recordedRecall: Number.isFinite(Number(quality?.failureRecall)) ? Number(quality.failureRecall) : null,
    recordedMissing: Array.isArray(quality?.missingFailures) ? quality.missingFailures.map(String) : [],
    /** `quality.failuresRepaired` 在不在场 —— 不在场说明写它的进程早于 C607/C641。 */
    hasRepairedField: Object.prototype.hasOwnProperty.call(quality ?? {}, "failuresRepaired"),
    // 正文口径
    edges: edges.length,
    measurable: detected.text !== null,
    textWhy: detected.why,
    hasRepairSection: false,
    modelHit: null,
    repairedIds: [],
    missingIds: [],
    postHit: null,
    adherence: null,
    postAdherence: null,
    dash: [],
    slash: [],
    dashRanges: [],
    dashSwallowed: 0,
    slashSwallowed: 0,
  };
  if (detected.text === null) return row;

  const { modelText, repairText, hasRepairSection } = splitModelText(detected.text);
  const modelHitIds = [];
  const repairedIds = [];
  const missingIds = [];
  for (const edge of edges) {
    const id = String(edge?.id ?? "");
    if (mentionsEdge(modelText, id)) modelHitIds.push(id);
    else if (mentionsEdge(repairText, id)) repairedIds.push(id);
    else missingIds.push(id);
  }
  const merges = countRangeMerges(modelText);
  return {
    ...row,
    hasRepairSection,
    modelHit: modelHitIds.length,
    repairedIds,
    missingIds,
    postHit: modelHitIds.length + repairedIds.length,
    // 区间里一条失败边都没有 ⇒ 比例无定义（不是 100%，也不是 0%）
    adherence: edges.length === 0 ? null : modelHitIds.length / edges.length,
    postAdherence: edges.length === 0 ? null : (modelHitIds.length + repairedIds.length) / edges.length,
    dash: merges.dash,
    slash: merges.slash,
    dashRanges: merges.dashRanges,
    dashSwallowed: merges.dashSwallowed,
    slashSwallowed: merges.slashSwallowed,
    /** 漏掉的 id 里，被破折号区间吞掉的个数（归因用；剩下的才是「纯漏写」）。 */
    missingFromDash: missingIds.filter((id) => coveredByDashRange(id, merges.dashRanges)).length,
  };
}

/* ─────────────────────────────── ⑤ 聚合 ─────────────────────────────── */

/** 一个空分组（trigger / 时间桶共用同一形状）。 */
function emptyGroup(label) {
  return {
    label,
    marks: 0,
    measurable: 0,
    foldsWithEdges: 0,
    edges: 0,
    modelHit: 0,
    repaired: 0,
    dash: 0,
    slash: 0,
    dashSwallowed: 0,
    slashSwallowed: 0,
    foldsWithDash: 0,
    foldsWithSlash: 0,
    foldsWithRepair: 0,
    recordedExpected: 0,
    recordedWeighted: 0,
  };
}

/** 把一行并进分组（**不可测的行也要计数**，否则分母会静默变小）。 */
function addToGroup(group, row) {
  group.marks += 1;
  if (Number.isFinite(row.recordedRecall) && row.recordedExpected > 0) {
    group.recordedExpected += row.recordedExpected;
    group.recordedWeighted += row.recordedRecall * row.recordedExpected;
  }
  if (row.measurable !== true) return;
  group.measurable += 1;
  group.edges += row.edges;
  group.modelHit += row.modelHit ?? 0;
  group.repaired += row.repairedIds.length;
  group.dash += row.dash.length;
  group.slash += row.slash.length;
  group.dashSwallowed += row.dashSwallowed ?? 0;
  group.slashSwallowed += row.slashSwallowed ?? 0;
  if (row.edges > 0) group.foldsWithEdges += 1;
  if (row.dash.length > 0) group.foldsWithDash += 1;
  if (row.slash.length > 0) group.foldsWithSlash += 1;
  if (row.repairedIds.length > 0) group.foldsWithRepair += 1;
}

/** 分组收尾：把计数换成比例（分母为 0 时给 null，不给 0）。 */
export function finishGroup(group) {
  return {
    ...group,
    adherence: group.edges === 0 ? null : group.modelHit / group.edges,
    postAdherence: group.edges === 0 ? null : (group.modelHit + group.repaired) / group.edges,
    mergeRate: group.foldsWithEdges === 0 ? null : group.dash / group.foldsWithEdges,
    slashRate: group.foldsWithEdges === 0 ? null : group.slash / group.foldsWithEdges,
    recordedAdherence: group.recordedExpected === 0 ? null : group.recordedWeighted / group.recordedExpected,
  };
}

/**
 * 把行聚合成报告要的四个视图：总计 / 按 trigger / 按时间桶 / 合并率。
 *
 * 时间桶：`recent` = `at >= now - windowMs`，其余归 `earlier`。
 * **窗口是相对「现在」的**，所以要复现某次报告就传 `--now`。
 *
 * @param {Array<object>} rows
 * @param {{now?:number, windowMs?:number}} [options]
 */
export function summarize(rows, { now = Date.now(), windowMs = BUCKET_WINDOW_MS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const total = emptyGroup("全部");
  /** @type {Map<string, any>} */
  const byTrigger = new Map();
  const recent = emptyGroup("最近 6h");
  const earlier = emptyGroup("更早");

  for (const row of list) {
    addToGroup(total, row);
    const key = row.trigger === "" ? UNKNOWN_TRIGGER : row.trigger;
    if (!byTrigger.has(key)) byTrigger.set(key, emptyGroup(key));
    addToGroup(byTrigger.get(key), row);
    if (row.at >= now - windowMs) addToGroup(recent, row);
    else addToGroup(earlier, row);
  }

  // 分组顺序：先固定顺序，再按 marks 降序补剩下的
  const ordered = [];
  for (const name of TRIGGER_ORDER) if (byTrigger.has(name)) ordered.push(finishGroup(byTrigger.get(name)));
  const rest = [...byTrigger.values()].filter((g) => !TRIGGER_ORDER.includes(g.label)).sort((a, b) => b.marks - a.marks);
  for (const g of rest) ordered.push(finishGroup(g));

  return {
    now,
    windowMs,
    windowStart: now - windowMs,
    total: finishGroup(total),
    byTrigger: ordered,
    byBucket: { recent: finishGroup(recent), earlier: finishGroup(earlier) },
  };
}

/* ─────────────────────────────── ⑥ 扫描 ─────────────────────────────── */

/**
 * 扫全部会话，给每条 foldMark 算一行。
 *
 * @param {{home?:string, limit?:number, session?:string}} [opts]
 */
export function audit({ home = resolveHome(), limit = 0, session = "" } = {}) {
  const { files } = collectGraphFiles(home);
  const rows = [];
  /** 字段世代：这些字段各自是**某个提交之后**才写的，缺哪个就说明生产者比它老。 */
  const epoch = { marks: 0, failuresRepaired: 0, inputTruncated: 0, inputCutMessages: 0, quality: 0 };
  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      /* 坏图跳过：一张坏图不许让整份报告失败 */
      continue;
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    marks.forEach((mark, index) => {
      epoch.marks += 1;
      if (Object.prototype.hasOwnProperty.call(mark?.quality ?? {}, "failuresRepaired")) epoch.failuresRepaired += 1;
      if (Object.prototype.hasOwnProperty.call(mark ?? {}, "inputTruncated")) epoch.inputTruncated += 1;
      if (Object.prototype.hasOwnProperty.call(mark ?? {}, "inputCutMessages")) epoch.inputCutMessages += 1;
      if (mark?.quality !== null && typeof mark?.quality === "object") epoch.quality += 1;
      rows.push(markAdherence(graph, mark, { index, session: file.dir }));
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const limited = limit > 0 ? rows.slice(-limit) : rows;
  return { home, graphs: files.length, marks: rows.length, rows, limited, epoch };
}

/* ─────────────────────────────── ⑦ 世代（提示词到底生效没有） ─────────────────────────────── */

/** Shell 家族：探宿主启动时刻时往上走，遇到它们就停（它们是「谁拉起了 DSH」，不是 DSH 本身）。 */
const SHELL_NAMES = new Set([
  "explorer.exe",
  "bash.exe",
  "sh.exe",
  "dash.exe",
  "zsh.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "conhost.exe",
  "winpty.exe",
  "wt.exe",
  "openconsole.exe",
]);

/**
 * 宿主进程链（从当前进程往上走到根）。**只读**，拿不到就返回空数组。
 *
 * 为什么要它：ESM 在**宿主启动时**加载，改完 `src/rooms/offline-fold.mjs` 不重启不生效。
 * 「C607 的提示词有没有用」必须先回答「有没有任何一条折痕是在它生效之后写的」——
 * 否则遵守率再高也只是**改之前**的基线，拿它去评价改动等于自己骗自己。
 *
 * @param {{timeoutMs?:number}} [options]
 * @returns {Array<{pid:number, name:string, startedAt:number}>} 空数组 = 探不到（不是 0）
 */
export function hostProcessChain({ timeoutMs = 15_000 } = {}) {
  if (process.platform !== "win32") return [];
  const script = [
    `$id = ${process.pid}`,
    "$out = @()",
    "while ($id -gt 0) {",
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue',
    "  if (-not $p) { break }",
    '  $out += [pscustomobject]@{ pid = [int]$p.ProcessId; name = [string]$p.Name; started = $p.CreationDate.ToString("o") }',
    "  $id = [int]$p.ParentProcessId",
    "  if ($out.Count -gt 24) { break }",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const parsed = JSON.parse(String(out).trim() === "" ? "[]" : String(out));
    const chain = Array.isArray(parsed) ? parsed : [parsed];
    return chain
      .map((p) => ({ pid: Number(p?.pid), name: String(p?.name ?? ""), startedAt: Date.parse(String(p?.started ?? "")) }))
      .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.startedAt));
  } catch {
    return [];
  }
}

/**
 * 宿主启动时刻 = 进程链里**最老的、且不是 shell** 的那个。
 *
 * 为什么取最老：DSH 是 Electron 多进程（main + utility + renderer 各一个 pid），
 * 它们都在同一秒拉起；取最老的才是「模块被加载」的时刻。跳过 shell 是因为
 * `explorer.exe` 可能比 DSH 早开机好几天，把它算进来会让结论变成「提示词三个月没生效」。
 *
 * @param {Array<{pid:number,name:string,startedAt:number}>} chain
 * @returns {{pid:number, name:string, startedAt:number}|null}
 */
export function hostStartOf(chain) {
  const candidates = (Array.isArray(chain) ? chain : []).filter((p) => !SHELL_NAMES.has(String(p.name).toLowerCase()));
  if (candidates.length === 0) return null;
  return candidates.reduce((oldest, p) => (p.startedAt < oldest.startedAt ? p : oldest), candidates[0]);
}

/**
 * 提示词规则的**进仓库时刻**（`git log -S` 第一次出现该字符串）。
 *
 * 只回答「什么时候进仓库」，**不回答「什么时候生效」**—— 生效还取决于宿主重启
 * （见 `hostProcessChain`）。没有 .git（打包/离线）时返回 null，不报错。
 *
 * @param {{root?:string, needle?:string, file?:string}} [options]
 * @returns {{sha:string, at:number, iso:string}|null}
 */
export function promptGeneration({
  root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), ".."),
  needle = "一条边一行",
  file = "src/rooms/offline-fold.mjs",
} = {}) {
  try {
    const out = execFileSync("git", ["-C", root, "log", "--reverse", "--format=%h %aI", "-S", needle, "--", file], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    const first = String(out)
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x !== "")[0];
    if (first === undefined) return null;
    const [sha, ...rest] = first.split(" ");
    const at = Date.parse(rest.join(" "));
    if (!Number.isFinite(at)) return null;
    return { sha, at, iso: new Date(at).toISOString() };
  } catch {
    return null;
  }
}

/* ─────────────────────────────────── 输出 ─────────────────────────────────── */

/** 一行「分母 / 分子 / 比例」——报告里反复出现，抽出来免得每处写法不一样。 */
function rateLine(group) {
  return `${int(group.modelHit)} / ${int(group.edges)} = **${pct(group.adherence)}**`;
}

function render(result, { generation = null, host = null } = {}) {
  const { summary } = result;
  const total = summary.total;
  const lines = [];

  lines.push("# 死路逐条遵守率审计（只读 · 零模型调用）");
  lines.push("");
  lines.push(`home = ${result.home}`);
  lines.push(
    `审计时刻 = ${iso(summary.now)} · 时间桶窗口 = 最近 6h（${iso(summary.windowStart)} 起）`,
  );
  lines.push(
    `会话 **${result.graphs}** 个 · foldMark **${result.marks}** 条 · ` +
      `**可测（有摘要正文）${int(total.measurable)}** 条 · ` +
      `其中区间内有失败边的 **${int(total.foldsWithEdges)}** 段`,
  );
  lines.push("");
  lines.push(
    "> 样本口径：正文只落在 `graph.lastOfflineSummary`（**每个会话只保留最后一段**）⇒ 一个会话最多一条可测，",
  );
  lines.push("> 且只能是最近那次离线折叠。`pressure` / `tier2` 不写正文 ⇒ 这两组**正文口径恒为空**（用记录口径兜底，分列）。");
  lines.push("");

  /* ── ① 遵守率 ── */
  lines.push("## ① 遵守率（模型自己在「已探明死路」段逐条写 id 的比例）");
  lines.push("");
  lines.push(`- 分母：区间内的失败边 **${int(total.edges)}** 条（\`failuresInFoldRange\`，与探针同源）`);
  lines.push(`- 分子：模型正文里**逐条出现 id** 的 **${int(total.modelHit)}** 条（**已剥掉机械补回段**）`);
  lines.push(`- **遵守率 = ${rateLine(total)}**（判据 ≥ ${pct(ADHERENCE_TARGET)}）`);
  lines.push(
    `- 机械补回：**${int(total.repaired)}** 条只在补回段出现 ⇒ **补回后 = ${pct(total.postAdherence)}**` +
      `（补回跑过的话应恒 = 100%，缺口 ${pct(1 - (total.postAdherence ?? 0))}）`,
  );
  lines.push(
    `- 记录口径（\`quality.failureRecall\` 加权）= **${pct(total.recordedAdherence)}**` +
      ` · 带 \`quality.failuresRepaired\` 字段的折痕 **${int(result.repairedFieldCount)}** 条`,
  );
  lines.push("");
  const verdict =
    total.adherence === null
      ? "无法判定（没有可测样本）"
      : total.adherence < ADHERENCE_TARGET
        ? `**未达标**（${pct(total.adherence)} < ${pct(ADHERENCE_TARGET)}）—— 提示词还不够硬，见 ⑥`
        : `**达标**（${pct(total.adherence)} ≥ ${pct(ADHERENCE_TARGET)}）`;
  lines.push(`**判据结论：${verdict}**`);
  lines.push("");

  /* ── ② 按 trigger ── */
  lines.push("## ② 按 trigger 分组");
  lines.push("");
  lines.push("| trigger | 折痕 | 可测（有正文） | 有失败边 | 遵守率（正文口径） | 补回后 | 记录口径 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const g of summary.byTrigger) {
    lines.push(
      `| \`${g.label}\` | ${int(g.marks)} | ${int(g.measurable)} | ${int(g.foldsWithEdges)} | ` +
        `${g.adherence === null ? "—（无正文）" : `${pct(g.adherence)}（${int(g.modelHit)}/${int(g.edges)}）`} | ` +
        `${g.postAdherence === null ? "—" : pct(g.postAdherence)} | ${pct(g.recordedAdherence)} |`,
    );
  }
  lines.push("");
  lines.push(
    "> `pressure` / `tier2` 的「—（无正文）」是**样本缺失**，不是遵守率 100%。它们的记录口径（折叠当时在最终正文上算的）列在最后一列。",
  );
  lines.push("");

  /* ── ③ 时间分桶 ── */
  const { recent, earlier } = summary.byBucket;
  lines.push("## ③ 按时间分桶（最近 6h vs 更早）");
  lines.push("");
  lines.push(`| 桶 | 折痕 | 可测 | 有失败边 | 遵守率 | 补回后 | 记录口径 | 区间合并（破折号） |`);
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, g] of [
    ["最近 6h", recent],
    ["更早", earlier],
  ]) {
    lines.push(
      `| ${name} | ${int(g.marks)} | ${int(g.measurable)} | ${int(g.foldsWithEdges)} | ` +
        `${g.adherence === null ? "—" : `${pct(g.adherence)}（${int(g.modelHit)}/${int(g.edges)}）`} | ` +
        `${g.postAdherence === null ? "—" : pct(g.postAdherence)} | ${pct(g.recordedAdherence)} | ` +
        `${int(g.dash)} 次 / ${int(g.foldsWithEdges)} 段 |`,
    );
  }
  lines.push("");
  const delta =
    recent.adherence === null || earlier.adherence === null ? null : recent.adherence - earlier.adherence;
  lines.push(
    `- 差（最近 6h − 更早）= ${delta === null ? "—（一侧无可测样本，**不许**当成 0 或「变好」）" : `${(delta * 100).toFixed(2)} 个百分点`}`,
  );
  lines.push(
    `- 最近 6h 里**有失败边**的段 ${int(recent.foldsWithEdges)} 段、**有区间合并**的 ${int(recent.foldsWithDash)} 段；` +
      `更早分别是 ${int(earlier.foldsWithEdges)} / ${int(earlier.foldsWithDash)} 段`,
  );
  lines.push("");

  /* ── ④ 区间合并率 ── */
  lines.push("## ④ 区间合并率（C607 明令禁止的那个写法）");
  lines.push("");
  lines.push(
    `- **破折号区间**（\`e693—e698\`）：**${int(total.dash)}** 次 / ${int(total.foldsWithEdges)} 个有失败边的 fold ` +
      `= **${pct(total.mergeRate)}**（涉及 ${int(total.foldsWithDash)} 个 fold）`,
  );
  lines.push(
    `  - 这些区间一共**吞掉 ${int(total.dashSwallowed)} 个 id**（首尾之外的 id 在正文里根本不存在）`,
  );
  lines.push(
    `- **斜杠合并**（\`e107/e113\`）：**${int(total.slash)}** 次 / ${int(total.foldsWithEdges)} 个有失败边的 fold ` +
      `= **${pct(total.slashRate)}**（涉及 ${int(total.foldsWithSlash)} 个 fold）`,
  );
  lines.push("  - 斜杠合并**不丢 id**（两端都能被逐字命中）—— 它是格式违规，不是丢失，两者分开算。");
  lines.push("");

  /* ── ⑤ 明细 ── */
  // ★ 只用 `result.rows`（全量）算，`limited` 只决定**列几行**。
  //   第一版拿 `limited` 当分母，明细写「漏写 1 条」而 ① 写「缺口 11 条」——同一次报告里两个数打架。
  const badAll = result.rows.filter((r) => r.measurable && r.missingIds.length > 0);
  // `--limit` 只截**明细行数**，不截分母（第一版拿 `limited` 当分母，明细写 1 条、① 写缺口 11 条，同一次报告两个数打架）
  const bad = badAll.slice(-Math.max(1, result.limit));
  const missingTotal = badAll.reduce((n, r) => n + r.missingIds.length, 0);
  lines.push("## ⑤ 明细：漏写 id 的折痕（按时间升序）");
  lines.push("");
  if (badAll.length === 0) {
    lines.push("- 一条都没有：可测样本里模型**逐条写全**了。");
  } else {
    lines.push(
      `可测样本里漏写的有 **${badAll.length}** 条（占 ${int(total.measurable)} 条可测的 ` +
        `${pct(badAll.length / Math.max(1, total.measurable))}），一共漏 **${missingTotal}** 个 id` +
        `${bad.length < badAll.length ? `（下面只列最近 ${bad.length} 条，用 \`--limit\` 调）` : ""}：`,
    );
    lines.push("");
    for (const row of bad) {
      const causes = [];
      if (row.dash.length > 0) causes.push(`破折号区间 ${row.dash.map((x) => `\`${x}\``).join(" ")}`);
      if (row.slash.length > 0) causes.push(`斜杠合并 ${row.slash.map((x) => `\`${x}\``).join(" ")}`);
      const why = row.missingFromDash > 0 ? `被区间吞掉 ${int(row.missingFromDash)} 个` : "纯漏写（没写任何区间）";
      lines.push(
        `- \`${String(row.session ?? "").slice(0, 26)}\` · seq ${row.seqStart}-${row.seqEnd} · ${iso(row.at)} · ` +
          `遵守率 ${pct(row.adherence)}（${int(row.modelHit)}/${int(row.edges)}）· 漏 [${row.missingIds.join(", ")}]` +
          ` · 归因：${why}${causes.length > 0 ? ` · ${causes.join(" · ")}` : ""}`,
      );
    }
  }
  lines.push("");

  /* ── ⑥ 归因 + 提示词建议 ── */
  const fromDash = badAll.reduce((n, r) => n + (r.missingFromDash ?? 0), 0);
  const pureMiss = missingTotal - fromDash;
  lines.push("## ⑥ 缺口归因 + 提示词建议");
  lines.push("");
  lines.push(
    `- 漏掉的 ${int(missingTotal)} 个 id 里：**${int(fromDash)}** 个是**破折号区间吞的**（C607 那条规则的目标），` +
      `**${int(pureMiss)}** 个是**纯漏写**（没写任何区间，就是没写）`,
  );
  lines.push(
    `- 也就是说：C607 的规则即使 100% 生效，最多也只能补回 ${int(fromDash)} 个（` +
      `${pct(missingTotal === 0 ? 0 : fromDash / missingTotal)} 的缺口），剩下的 ${int(pureMiss)} 个要另想办法`,
  );
  lines.push("");
  if (total.adherence !== null && total.adherence >= ADHERENCE_TARGET) {
    lines.push(
      `- **不需要再改硬**：遵守率 ${pct(total.adherence)} 已 ≥ ${pct(ADHERENCE_TARGET)}。`,
    );
  } else {
    lines.push(`- **需要改硬**：遵守率 ${pct(total.adherence)} < ${pct(ADHERENCE_TARGET)}。具体改法见交付报告。`);
  }
  lines.push("");

  /* ── ⑦ 世代 ── */
  // ★ 逻辑要点：ESM 在**宿主启动时**加载，改文件**不会**热更新。
  //   所以「生效时刻」不是 `max(进仓库, 宿主启动)` —— 宿主启动**早于**进仓库时，
  //   新代码根本不在内存里，生效时刻是**未定**（要等下一次重启），不是「进仓库那一刻」。
  //   第一版写成 `max()`，于是在宿主比提交早 41 分钟的情况下报出「145 条折痕用过新提示词」——
  //   那是**凭空的判别力**，比没有结论更坏。
  lines.push("## ⑦ 世代：C607 的提示词到底生效了没有");
  lines.push("");
  if (generation === null) {
    lines.push("- 提示词进仓库时刻：**取不到**（没有 .git 或 `--no-git`）—— 无法判断，不猜。");
  } else {
    lines.push(`- 提示词规则「一条边一行」进仓库：**${generation.iso}**（${generation.sha}）`);
  }
  if (host === null) {
    lines.push("- 宿主启动时刻：**探不到**（非 Windows 或 `--no-probe`）—— 无法判断，不猜。");
  } else {
    lines.push(`- 宿主启动时刻：**${iso(host.startedAt)}**（\`${host.name}\` pid=${host.pid}）`);
    if (generation !== null) {
      if (host.startedAt < generation.at) {
        const gapMin = Math.round((generation.at - host.startedAt) / 60_000);
        lines.push(
          `- **宿主比提示词早启动 ${int(gapMin)} 分钟** ⇒ 新代码**不在内存里**（ESM 启动时加载，改文件不热更新）` +
            ` ⇒ 在宿主重启之前，**0 条折痕**用过新提示词`,
        );
        lines.push(
          `- **结论**：本报告的 ${pct(total.adherence)} 是 **C607 改动前的基线**；` +
            `拿它评价 C607 的改动 = 自己骗自己。要评价，先重启宿主，再跑一次本脚本对比。`,
        );
      } else {
        const afterCount = result.rows.filter((r) => r.measurable && r.at >= host.startedAt).length;
        lines.push(
          `- **宿主晚于提示词启动** ⇒ 生效时刻 = **${iso(host.startedAt)}** ⇒ ` +
            `在它之后写的**可测**折痕 **${int(afterCount)}** 条`,
        );
        lines.push(
          afterCount === 0
            ? "- **结论**：生效后还没有可测折痕 ⇒ ③ 的对比**暂时没有判别力**（不是「没效果」）。"
            : `- **结论**：已经有 ${int(afterCount)} 条可测折痕在生效之后写出 ⇒ ③ 的对比**有判别力**。`,
        );
      }
    }
  }
  const epoch = result.epoch ?? null;
  if (epoch !== null) {
    lines.push(
      `- 字段世代（**独立于进程探测**的数据证据）：${int(epoch.marks)} 条折痕里带 ` +
        `\`quality.failuresRepaired\` **${int(epoch.failuresRepaired)}** 条 · ` +
        `\`inputTruncated\` **${int(epoch.inputTruncated)}** 条 · ` +
        `\`inputCutMessages\` **${int(epoch.inputCutMessages)}** 条`,
    );
    if (epoch.marks > 0 && epoch.failuresRepaired === 0 && epoch.inputTruncated === 0) {
      lines.push(
        "  - 这三个字段分别是 C607 / C610 / C610 之后**每条折痕都写**的 ⇒ 全是 0 说明生产者**早于这三个提交**，与上面进程探测互相印证。",
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

/* ─────────────────────────────────── 入口 ─────────────────────────────────── */

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const nowRaw = get("now", "");
  const now = nowRaw === "" ? Date.now() : Date.parse(nowRaw);
  return {
    home: String(get("home", resolveHome())),
    limit: Number(get("limit", DEFAULT_LIMIT)) || DEFAULT_LIMIT,
    session: String(get("session", "") ?? ""),
    now: Number.isFinite(now) ? now : Date.now(),
    json: argv.includes("--json"),
    git: !argv.includes("--no-git"),
    probe: !argv.includes("--no-probe"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const scanned = audit({ home: opts.home, limit: 0, session: opts.session });
  if (scanned.graphs === 0) {
    console.error(`读不到任何会话图（home=${opts.home}）—— 检查 DSH_HOME / --home。`);
    return 2;
  }
  const summary = summarize(scanned.rows, { now: opts.now });
  const limited = opts.limit > 0 ? scanned.rows.slice(-opts.limit) : scanned.rows;
  const result = {
    home: scanned.home,
    graphs: scanned.graphs,
    marks: scanned.marks,
    rows: scanned.rows,
    limited,
    limit: opts.limit,
    summary,
    epoch: scanned.epoch,
    repairedFieldCount: scanned.rows.filter((r) => r.hasRepairedField).length,
  };
  if (opts.json) {
    const generation = opts.git ? promptGeneration() : null;
    const host = opts.probe ? hostStartOf(hostProcessChain()) : null;
    console.log(JSON.stringify({ ...result, generation, host }, null, 2));
    return 0;
  }
  const generation = opts.git ? promptGeneration() : null;
  const host = opts.probe ? hostStartOf(hostProcessChain()) : null;
  console.log(render(result, { generation, host }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
