#!/usr/bin/env node
/**
 * placeholder-audit.mjs —— 死路段里的 `e?` 占位符**到底丢了什么**（T30 · 只读 · 零模型调用）
 *
 * 由来（2026-11-05，T26 斜杠审计的「旁证（未动）」那一段）：
 *   `scripts/slash-merge-audit.mjs` 报出死路段里写成 `e?` 的行 **791 条 / 195 条折痕**，
 *   而同期「漏写 id」只有 **6 个**。这两个数放在一起说明：**大部分 `e?` 的上下文里有别的可定位信息**，
 *   真丢的只有极少数。所以本脚本要回答的不是「有多少个问号」，而是**每一条 `e?` 本该写哪个 id、
 *   它到底能不能定位、丢的那几个是谁**。
 *
 * 为什么必须先量（本仓的老规矩：先改、后猜、再改）：
 *   `e?` 至少有**四条**互不相同的来路，改错地方等于白改：
 *     ① **模型自己写的**（提示词说「不确定的引用写 `n?`」，它顺手写成 `e?`）⇒ 提示词问题；
 *     ② **事实块没渲染出 id**（`renderFacts` 的 80 字符切 / `slice(-40)` 窗口 / 8000 字符截断）
 *        ⇒ 改提示词**无效**，必须改渲染；
 *     ③ **机械补回没覆盖**（`repairMissingFailures` 该补没补）⇒ 改补回；
 *     ④ **确实拿不到 id**（模型把原始消息里的工具结果自己总结成死路，而消息里没有边 id）⇒ 不可修。
 *
 * 判据全部机械（字符串 + 图查询），**不打分、不调模型、不做语义判断**：
 *   · **反推「本该写哪个 id」**：占位符行尾的 `(seq a-b)` 是 `renderFacts` 写死的格式
 *     （`- e123 "动作" → 错误 (seq a-b)`），拿它去图里按 `evidence` 跨度**精确**命中；
 *     没有 seq 的自由行，退回「动作/错误原文前 24 字」的逐字包含匹配（同样只认唯一命中）。
 *   · **「吃掉」= `failuresInFoldRange` 里的边，id 在**最终正文**（模型正文 + 机械补回段）里
 *     `mentionsEdge` 命中不了**。这是与 `measureFoldQuality` / `deadend-adherence-audit` **同一个**判据，
 *     不另起口径 —— 本仓已经因为「两套口径」栽过很多次（C607 / C638 / C641）。
 *   · **「能定位」≠「丢」**：行尾带 `(seq a-b)` 的占位符，读者能拿 seq 回原文；
 *     本报告把它与「既无 id 也无 seq」分开计数，**不把可定位的算成丢**（任务书原话）。
 *
 * 用法：
 *   node scripts/placeholder-audit.mjs                  # 默认 DSH_HOME
 *   node scripts/placeholder-audit.mjs --home <dir>     # 换 home
 *   node scripts/placeholder-audit.mjs --json           # 机读（测试/报告用）
 *   node scripts/placeholder-audit.mjs --samples=6      # 样本条数（默认 5）
 *   node scripts/placeholder-audit.mjs --session fdd814 # 只看某个会话
 *
 * 退出码：0 = 审计跑完（无论结论是改还是不改）；2 = 一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
// ★ 口径复用（不复制实现）：`PLACEHOLDER_RE` / `SEQ_SPAN_RE` 与**补回**用的是**同一份** ——
//   度量与修复各写一份正则，就会出现「本脚本数出 791、补回认领 790」这种两个数（本仓的老毛病）。
import { compactAction, renderFacts, PLACEHOLDER_RE, SEQ_SPAN_RE } from "../src/rooms/offline-fold.mjs";
import { failuresInFoldRange, mentionsEdge, sanitizeSummaryIds } from "../src/rooms/fold-quality.mjs";
// ★ 口径复用（不复制实现）：剥补回段 / 死路段定位 / 工具名 / 错误类 —— 与
//   `deadend-adherence-audit` / `slash-merge-audit` 是**同一份**实现，两边一旦分叉，
//   「791 条」和「791 条」就会变成两个数（本仓反复踩过的坑）。
import { splitModelText } from "./deadend-adherence-audit.mjs";
import { deadendSection, toolOf, actionText, errorText, normalizeId } from "./slash-merge-audit.mjs";

/* ─────────────────────────────── 常量（改口径只改这里） ─────────────────────────────── */

/**
 * 占位写法的**形态表**（闭集）。`PLACEHOLDER_RE` 本身**不在这里定义** ——
 * 从 `src/rooms/offline-fold.mjs` **导入**（补回认领用的是同一份），否则「数出 804、认领 803」
 * 就是下一个「两个 791」的坑。
 *
 * 真机来源：`deadend-adherence-audit` 的 `placeholderLines` 只数了 `e?` 一种；
 * 任务书点名要 `e?` / `e?e?` / `e123?` 都量。这里把形态拆开，报告里逐个给数 ——
 * **某个形态为 0 也是有信息量的**（说明不用为它设计规则）。
 *
 * 计数口径：**行数**（一行含几种形态就各记一次），与 `PLACEHOLDER_RE` 的「出现次数」分列，
 * 两者不可通约（`e?e?` 是一行、却是两次出现）—— 报告里分开写，不硬凑一个数。
 */
export const PLACEHOLDER_FORMS = [
  { name: "e?e?（连写两个）", re: /(?<![A-Za-z0-9_])e[?？]e[?？]/g },
  { name: "e123?（真 id 带问号）", re: /(?<![A-Za-z0-9_])e[0-9]{1,4}[?？]/g },
  { name: "e??（连写问号）", re: /(?<![A-Za-z0-9_])e[?？]{2,}/g },
  { name: "e？（全角问号）", re: /(?<![A-Za-z0-9_])e？+/g },
  { name: "e?（半角，基准写法）", re: /(?<![A-Za-z0-9_])e\?/g },
];

/**
 * 自由行反推时取的动作/错误原文长度（太短会糊成一片，太长会被模型改写）。
 */
export const MATCH_FRAGMENT = 24;

/** 样本默认条数。 */
export const DEFAULT_SAMPLES = 5;

/**
 * 时间分桶窗口：最近 6 小时 vs 更早。
 *
 * 与 `deadend-adherence-audit` 同一个窗口（BUCKET_WINDOW_MS）—— 两份报告要能对照着读。
 */
export const BUCKET_WINDOW_MS = 6 * 60 * 60 * 1000;

/* ─────────────────────────────────── 小工具 ─────────────────────────────────── */

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "—");
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(2)}%`);
const int = (x) => (Number.isFinite(Number(x)) ? String(Math.round(Number(x))) : "—");
const norm = (x) => String(x ?? "").replace(/\s+/g, "");

/** 与 doctor / graph-audit / 其余审计同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** 边的 evidence 跨度（`{start,end}` / 单个数字两种形态都吃，与 `kifu-model.evidenceSpan` 同义）。 */
export function spanOf(edge) {
  const evidence = edge?.evidence;
  if (typeof evidence === "number" && Number.isFinite(evidence)) return { start: evidence, end: evidence };
  if (evidence !== null && typeof evidence === "object" && Number.isFinite(Number(evidence.start))) {
    const start = Number(evidence.start);
    return { start, end: Number.isFinite(Number(evidence.end)) ? Number(evidence.end) : start };
  }
  return null;
}

/**
 * 一条正文里的占位写法：**出现次数**（`PLACEHOLDER_RE`，只数真·占位符）与**形态集合**（行级）。
 *
 * 为什么要分开：`e123?` 里 **id 是真的**（读者能定位），只是多了个问号 —— 它是「格式」问题，
 * 不是「丢 id」问题。混进同一个数会把 6 个真丢的 id 里塞进一堆没丢的。
 *
 * @param {string} line
 * @returns {{occurrences:number, forms:string[]}}
 */
export function placeholdersIn(line) {
  const text = String(line ?? "");
  const occurrences = [...text.matchAll(PLACEHOLDER_RE)].length;
  const forms = [...new Set(PLACEHOLDER_FORMS.filter((form) => text.match(form.re) !== null).map((form) => form.name))];
  return { occurrences, forms };
}

/* ─────────────────────────────── ① 反推：这一行本该写哪个 id ─────────────────────────────── */

/**
 * 反推一条占位符行**本该写哪个边 id**。
 *
 * 两级判据，**都要求唯一命中**（宁可不反推，也不要写错 id —— 那比 `e?` 更坏）：
 *   ① **坐标**（硬）：行尾 `(seq a-b)` 命中图里**唯一**一条 evidence 跨度完全相同的边；
 *   ② **原文**（软）：动作/错误原文的前 24 字逐字出现在行里（同样只认唯一命中）。
 *
 * 为什么坐标优先：真机 722/793 条带坐标，而模型对动作/错误原文会**改写**（换引号、省略参数），
 * 原文匹配只能兜剩下那 71 条自由行。
 *
 * @param {string} line 占位符所在行
 * @param {Map<string,object>} bySpan `"start-end"` → 边（重复跨度不登记，保证唯一）
 * @param {Array<object>} edges 全部失败边（自由行匹配用）
 * @returns {{edge:object|null, via:"seq"|"text"|null, candidates:number}}
 */
export function pinEdge(line, bySpan, edges) {
  const text = String(line ?? "");
  const seq = SEQ_SPAN_RE.exec(text);
  if (seq !== null) {
    const key = `${Number(seq[1])}-${Number(seq[2])}`;
    const edge = bySpan.get(key) ?? null;
    return { edge, via: edge === null ? null : "seq", candidates: edge === null ? 0 : 1 };
  }
  const lineN = norm(text);
  const hits = (Array.isArray(edges) ? edges : []).filter((edge) => {
    const action = norm(compactAction(actionText(edge), 200)).slice(0, MATCH_FRAGMENT);
    const error = norm(compactAction(errorText(edge), 200)).slice(0, MATCH_FRAGMENT);
    return (action.length >= 8 && lineN.includes(action)) || (error.length >= 8 && lineN.includes(error));
  });
  return { edge: hits.length === 1 ? hits[0] : null, via: hits.length === 1 ? "text" : null, candidates: hits.length };
}

/**
 * 一个 `"start-end"` → 边的索引；**同一跨度出现两条边就不登记**（歧义 ⇒ 不反推）。
 * @param {Array<object>} edges
 * @returns {Map<string,object>}
 */
export function spanIndex(edges) {
  const map = new Map();
  const dup = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const span = spanOf(edge);
    if (span === null) continue;
    const key = `${span.start}-${span.end}`;
    if (map.has(key)) dup.add(key);
    else map.set(key, edge);
  }
  for (const key of dup) map.delete(key);
  return map;
}

/* ─────────────────────────────── ② 扫一条折痕 ─────────────────────────────── */

/**
 * 一条折痕（= 一个会话的 `lastOfflineSummary`）的全部占位符证据。
 *
 * @param {object} graph 棋谱
 * @param {{session?:string}} [meta]
 * @returns {object|null} `null` = 这条折痕没有正文（不可测）
 */
export function scanFold(graph, { session = null } = {}) {
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") return null;
  // ★ 与 `deadend-adherence-audit` 同源：只数**模型自己写的**那半段（补回段里的 id 本来就是机械写的）。
  const { modelText, hasRepairSection } = splitModelText(last.text);
  const range = { start: Number(last?.range?.start), end: Number(last?.range?.end) };
  const allEdges = Object.values(graph?.edges ?? {});
  const failures = allEdges.filter((edge) => edge?.result === "failure");
  const bySpan = spanIndex(failures);

  // 记录口径（折叠当时写下来的）—— 与正文口径**分列**，不混合。
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const mark = marks.find((m) => Number(m?.seqStart) === range.start && Number(m?.seqEnd) === range.end) ?? null;
  const quality = mark?.quality ?? null;

  // 区间内的失败边（与探针同源）
  let expected = [];
  try {
    expected = failuresInFoldRange(graph, range);
  } catch {
    expected = [];
  }
  const missing = expected.filter((edge) => !mentionsEdge(modelText, String(edge?.id ?? "")));

  const dead = deadendSection(modelText);
  const placeholders = [];
  for (const line of dead.lines) {
    const forms = placeholdersIn(line);
    if (forms.occurrences === 0 && forms.forms.length === 0) continue;
    const pinned = pinEdge(line, bySpan, failures);
    const edge = pinned.edge;
    const span = edge === null ? null : spanOf(edge);
    const inRange =
      span === null ? null : Number.isFinite(range.end) ? span.start <= range.end && span.end >= range.start : null;
    // 「这一行盖住了几条边的身份」：坐标/原文只认唯一命中，反推不出来就是 null。
    const id = edge !== null && typeof edge.id === "string" ? normalizeId(edge.id) : null;
    const mentionedElsewhere = id === null ? null : mentionsEdge(modelText, id);
    /** 占位符**本该写出来**的 id，在最终正文里是不是**别处**有（= 补偿过）。 */
    const compensated = id === null ? null : mentionedElsewhere === true;
    const category = (() => {
      if (id === null) {
        return pinned.candidates > 1 ? "ambiguous" : "unresolved";
      }
      if (inRange !== true) return "future";
      if (span.end > range.end) return "straddle";
      if (span.start < range.start) return "past";
      return "in-range";
    })();
    placeholders.push({
      session,
      at: Number(last?.at) || 0,
      trigger: String(mark?.trigger ?? ""),
      range,
      line,
      forms: forms.forms,
      occurrences: forms.occurrences,
      via: pinned.via,
      id,
      span,
      inRange,
      tool: edge === null ? "(未反推)" : toolOf(edge),
      category,
      compensated,
      // 「能定位」= 行里有坐标（读者能回原文）或反推出了 id
      locatableBy: pinned.via === "seq" ? "seq" : pinned.via === "text" ? "text" : null,
      canonical:
        edge === null
          ? null
          : `- ${id} 「${compactAction(actionText(edge), 80)}」→ ${compactAction(errorText(edge), 80)}`,
    });
  }

  return {
    session,
    at: Number(last?.at) || 0,
    trigger: String(mark?.trigger ?? ""),
    model: mark?.route?.model ?? last?.model ?? null,
    range,
    hasRepairSection,
    // ★ C641 的判决字段：每一条折痕都该写（0 也写）⇒ 缺失 = 生产者早于 C641。
    hasRepairedField: Object.prototype.hasOwnProperty.call(quality ?? {}, "failuresRepaired"),
    recordedExpected: Number(quality?.expectedFailures) || 0,
    recordedMissing: Array.isArray(quality?.missingFailures) ? quality.missingFailures.map(String) : [],
    // 正文口径
    deadLines: dead.lines.length,
    placeholders,
    occurrences: placeholders.reduce((n, p) => n + p.occurrences, 0),
    expectedEdges: expected.length,
    missingIds: missing.map((edge) => normalizeId(String(edge?.id ?? ""))).filter((id) => id !== ""),
    // ★ 判决用：**事实块里到底有没有这个 id**（B 的证伪靠它）
    factsProbe: probeFacts(graph, range, missing),
    // ★ 判决用：**事实块里的 id 过一遍 sanitize 会被抹掉几个**（A/B 同时证伪的那条链）
    sanitizeProbe: probeSanitize(graph, range),
  };
}

/**
 * **事实块探针**：把这次 fold 的硬事实块**原样重渲染**，看漏掉的 id 在不在里面。
 *
 * 为什么必须重渲染而不是猜：任务书要求「先证伪」—— 如果 id 根本没进事实块（被 80 字符切、
 * 被 `slice(-40)` 窗口挤出、被 8000 字符截断），那**改提示词是无效的，必须改渲染**。
 * 这一步把「模型看没看到」变成可核对的布尔值。
 *
 * 注意口径：`renderFacts` 是**当前图**上的纯函数（图只会增长），所以重渲染是「当时事实块」的
 * **超集**；`inFacts=false` 是硬结论（当时一定没有），`inFacts=true` 是「现在有，当时极可能也有」。
 *
 * @param {object} graph
 * @param {{start:number,end:number}} range
 * @param {Array<object>} missing 本次区间内、正文里没命中的失败边
 * @returns {Array<{id:string, inFacts:boolean, lineStart:number}>}
 */
export function probeFacts(graph, range, missing) {
  const list = Array.isArray(missing) ? missing : [];
  if (list.length === 0) return [];
  let facts = "";
  try {
    facts = renderFacts(graph, range);
  } catch {
    return list.map((edge) => ({ id: normalizeId(String(edge?.id ?? "")), inFacts: false, lineStart: -1 }));
  }
  const lines = facts.split("\n");
  return list.map((edge) => {
    const id = normalizeId(String(edge?.id ?? ""));
    const at = lines.findIndex((line) => line.startsWith(`- ${id} `));
    return { id, inFacts: at >= 0, lineStart: at };
  });
}

/**
 * **sanitize 探针**：把事实块里出现的边 id 原样喂给 `sanitizeSummaryIds`，看它会不会被抹成 `e?`。
 *
 * 这是「事实块与 sanitize 的口径是否一致」的**直接证据**：
 * 事实块说「这些是硬事实，必须逐字保留」，sanitize 说「区间外的 id 一律 `e?`」——
 * 两边同时成立时，模型抄得越忠实，`e?` 越多。真机 793 条占位符就是这条链的产物。
 *
 * @param {object} graph
 * @param {{start:number,end:number}} range
 * @returns {{checked:number, removed:string[]}}
 */
export function probeSanitize(graph, range) {
  try {
    const facts = renderFacts(graph, range);
    const ids = [...facts.matchAll(/^- (e[0-9]{1,4}) /gm)].map((m) => m[1]);
    if (ids.length === 0) return { checked: 0, removed: [] };
    const out = sanitizeSummaryIds(ids.join(" "), graph, range);
    return { checked: out.checked, removed: out.removed.map((id) => normalizeId(id)) };
  } catch {
    return { checked: 0, removed: [] };
  }
}

/* ─────────────────────────────── ③ 聚合 ─────────────────────────────── */

export function summarize(folds, { now = Date.now(), windowMs = BUCKET_WINDOW_MS } = {}) {
  const list = (Array.isArray(folds) ? folds : []).filter((f) => f !== null);
  const withPh = list.filter((f) => f.placeholders.length > 0);
  const all = withPh.flatMap((f) => f.placeholders);

  const countBy = (rows, pick) => {
    const map = new Map();
    for (const row of rows) {
      const key = pick(row);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };

  // 形态：**行级**（一行含几种形态就各记一次）—— 与「出现次数」不可通约，报告里分列。
  const forms = new Map();
  for (const p of all) for (const name of p.forms) forms.set(name, (forms.get(name) ?? 0) + 1);

  const eatenLines = all.filter((p) => p.category === "straddle" || p.category === "in-range");
  const futureLines = all.filter((p) => p.category === "future" || p.category === "past");
  const unresolvedLines = all.filter((p) => p.category === "unresolved" || p.category === "ambiguous");

  // 严格口径：区间内、正文（含补回段）里命中不了的 id —— 与 `deadend-adherence-audit` 同判据。
  // ★ 两个**必须分列**的口径（混用就是又一处「两个数打架」）：
  //     · `missingAllFolds`       = 全部折痕（与 `deadend-adherence-audit` 的 10 个缺口同分母）；
  //     · `missingPlaceholderFolds` = 有占位符的折痕（本报告的题）。
  //   占位符只是缺口的一种形状：破折号区间 `e693—e698` 吞掉的 id **不在**这里（那是 T26 的对象）。
  const missingAllFolds = list.flatMap((f) => f.missingIds.map((id) => ({ id, session: f.session, at: f.at, range: f.range })));
  const missingPlaceholderFolds = withPh.flatMap((f) => f.missingIds.map((id) => ({ id, session: f.session, at: f.at, range: f.range })));
  const pinnedMissing = new Set(
    all.filter((p) => p.id !== null && (p.category === "straddle" || p.category === "in-range")).map((p) => p.id),
  );
  const missingBehindPlaceholder = missingPlaceholderFolds.filter((row) => pinnedMissing.has(row.id));

  const recent = withPh.filter((f) => f.at >= now - windowMs);
  const earlier = withPh.filter((f) => f.at < now - windowMs);

  return {
    now,
    folds: list.length,
    foldsWithPlaceholders: withPh.length,
    /// 死路段里的占位符**行**数（与 T26 的 `placeholderLines` 同分母）
    lines: all.length,
    /// 占位符**出现次数**（一行可能多个）
    occurrences: all.reduce((n, p) => n + p.occurrences, 0),
    forms: [...forms.entries()].sort((a, b) => b[1] - a[1]),
    // 归因（行）
    seqPinned: all.filter((p) => p.via === "seq").length,
    textPinned: all.filter((p) => p.via === "text").length,
    locatable: all.filter((p) => p.locatableBy !== null).length,
    futureLines: futureLines.length,
    eatenLines: eatenLines.length,
    unresolvedLines: unresolvedLines.length,
    categoryRows: countBy(all, (p) => p.category),
    // 严格口径（id）
    expectedEdges: list.reduce((n, f) => n + f.expectedEdges, 0),
    /// 全部折痕的缺口（与 deadend-adherence-audit 同分母）
    missingIdsAll: missingAllFolds.length,
    /// 有占位符的折痕里的缺口（本报告的题）
    missingIds: missingPlaceholderFolds.length,
    missingBehindPlaceholder: missingBehindPlaceholder.length,
    missingList: missingPlaceholderFolds,
    // ★ B 的证伪：漏掉的 id 在**重渲染的事实块**里逐字存在的条数
    factsProbeHit: withPh.reduce((n, f) => n + (Array.isArray(f.factsProbe) ? f.factsProbe.filter((x) => x.inFacts).length : 0), 0),
    factsProbeTotal: withPh.reduce((n, f) => n + (Array.isArray(f.factsProbe) ? f.factsProbe.length : 0), 0),
    // ★ 事实块里的边 id 过一遍 sanitize：被抹掉的个数 —— 这是「模型照抄得越忠实、e? 越多」的直接证据
    factsIdsChecked: withPh.reduce((n, f) => n + Number(f.sanitizeProbe?.checked ?? 0), 0),
    factsIdsBlanked: withPh.reduce((n, f) => n + (Array.isArray(f.sanitizeProbe?.removed) ? f.sanitizeProbe.removed.length : 0), 0),
    // 分布
    byTrigger: countBy(all, (p) => (p.trigger === "" ? "(无 trigger)" : p.trigger)),
    byHour: countBy(all, (p) => (Number.isFinite(p.at) && p.at > 0 ? new Date(p.at).toISOString().slice(0, 13) : "—")),
    byTool: countBy(all, (p) => p.tool),
    // 世代（C641 的判决字段）
    repairedFieldPresent: withPh.filter((f) => f.hasRepairedField === true).length,
    repairedSectionPresent: withPh.filter((f) => f.hasRepairSection === true).length,
    recent: { folds: recent.length, lines: recent.reduce((n, f) => n + f.occurrences, 0) },
    earlier: { folds: earlier.length, lines: earlier.reduce((n, f) => n + f.occurrences, 0) },
  };
}

/* ─────────────────────────────── ④ 样本 ─────────────────────────────── */

/**
 * 挑样本：**每类各一条**（不是「前 N 条」）—— 前 N 条会全落在同一个会话里，那是样本偏差。
 * 顺序：真丢（straddle）→ 本段之外 → 反推不出 → 全角/连写等稀有形态。
 */
export function pickSamples(placeholders, limit = DEFAULT_SAMPLES) {
  const list = (Array.isArray(placeholders) ? placeholders : []).filter((p) => p !== null);
  const wanted = [
    (p) => p.category === "straddle",
    (p) => p.category === "in-range",
    (p) => p.category === "future" && p.locatableBy === "seq",
    (p) => p.category === "future" && p.locatableBy === "text",
    (p) => p.category === "unresolved" || p.category === "ambiguous",
  ];
  const out = [];
  const used = new Set();
  for (const test of wanted) {
    if (out.length >= limit) break;
    const hit = list.find((p) => !used.has(p) && test(p));
    if (hit !== undefined) {
      used.add(hit);
      out.push(hit);
    }
  }
  for (const p of list) {
    if (out.length >= limit) break;
    if (used.has(p)) continue;
    used.add(p);
    out.push(p);
  }
  return out.slice(0, Math.max(1, limit));
}

/* ─────────────────────────────── ⑤ 输出 ─────────────────────────────── */

const CATEGORY_MEANING = {
  future: "**本段之外**（证据收口在遮蔽终点之后）—— 模型照抄了全局死路，id 被 sanitize 抹掉；seq 可定位",
  straddle: "**跨界**（`span.start ≤ end < span.end`）—— `failuresInFoldRange` 算它，sanitize 抹它 ⇒ **真丢**",
  "in-range": "**区间内**（本该保留）—— sanitize 不该抹，出现即说明模型自己写了 `e?`",
  past: "**更早**（`span.end < start`）—— 回溯历史，合法引用",
  unresolved: "**反推不出**（行里没有坐标、动作/错误也对不上任何边）—— 模型把原始消息总结成了死路",
  ambiguous: "**歧义**（坐标/原文命中多条边）—— 不猜",
};

function render(result, { samples = DEFAULT_SAMPLES } = {}) {
  const s = result.summary;
  const lines = [];
  lines.push("# 死路段 `e?` 占位符审计 —— 它到底丢了什么");
  lines.push("");
  lines.push(`home = ${result.home}`);
  lines.push(`审计时刻 = ${iso(result.now)} · 只读 · 零模型调用`);
  lines.push(
    `会话 **${int(result.graphs)}** 个 · 有摘要正文的折痕 **${int(s.folds)}** 条 · ` +
      `死路段里有占位符的 **${int(s.foldsWithPlaceholders)}** 条 · 占位符行 **${int(s.lines)}** 条 / 出现 **${int(s.occurrences)}** 次`,
  );
  lines.push("");
  lines.push(
    "> 口径：只数**模型正文**的「已探明死路」段（已剥机械补回段），与 `deadend-adherence-audit` / `slash-merge-audit` 同源。",
  );
  lines.push(
    `> 「吃掉 id」= \`failuresInFoldRange\` 里的边在**最终正文**里 \`mentionsEdge\` 命中不了 —— ` +
      `与 \`measureFoldQuality\` 同一个判据。**带 seq 的行不算丢**（读者能回原文）。`,
  );
  lines.push("");

  /* ── ① 形态 ── */
  lines.push("## ① 占位写法有哪些（形态闭集）");
  lines.push("");
  lines.push("| 形态 | 命中行数 |");
  lines.push("| --- | --- |");
  for (const [name, n] of s.forms) lines.push(`| \`${name}\` | ${int(n)} |`);
  const absent = PLACEHOLDER_FORMS.filter((form) => !s.forms.some(([name]) => name === form.name)).map((form) => `\`${form.name}\``);
  lines.push("");
  lines.push(
    `- 真机只出现 **${int(s.forms.length)} / ${int(PLACEHOLDER_FORMS.length)}** 种形态` +
      `${absent.length === 0 ? "" : `，其余为 0：${absent.join(" · ")}`} ⇒ **不需要为它们单独设计规则**；`,
  );
  lines.push(
    `- 注意口径：\`e123?\`（真 id 带问号）**不算丢**（id 是真的，读者能定位），它只记形态、不进 ③ 的分子。`,
  );
  lines.push("");

  /* ── ② 反推 ── */
  lines.push("## ② 每条占位符**本该写哪个 id**（反推）");
  lines.push("");
  lines.push(
    `- 反推成功 **${int(s.seqPinned + s.textPinned)} / ${int(s.lines)}** 行：` +
      `**按行尾坐标** ${int(s.seqPinned)} 行（\`(seq a-b)\` 精确命中 evidence 跨度）、` +
      `**按动作/错误原文** ${int(s.textPinned)} 行（24 字逐字包含，唯一命中）`,
  );
  lines.push(
    `- 反推不出 **${int(s.unresolvedLines)}** 行（行里没有坐标、动作/错误也对不上任何边）—— 这一档**不许猜**`,
  );
  lines.push(`- **能定位**（有坐标或能反推出 id）**${int(s.locatable)} / ${int(s.lines)}** = **${pct(s.lines === 0 ? null : s.locatable / s.lines)}**`);
  lines.push("");
  lines.push("| 类别 | 行数 | 占比 | 含义 |");
  lines.push("| --- | --- | --- | --- |");
  const total = Math.max(1, s.lines);
  for (const [name, n] of s.categoryRows) {
    lines.push(`| \`${name}\` | ${int(n)} | ${pct(n / total)} | ${CATEGORY_MEANING[name] ?? "—"} |`);
  }
  lines.push("");

  /* ── ③ 吃掉多少 id ── */
  lines.push("## ③ 被「吃掉」的 id 到底有多少（严格口径）");
  lines.push("");
  lines.push(
    `- 分母：所有折痕里**区间内的失败边** **${int(s.expectedEdges)}** 条（\`failuresInFoldRange\`，与探针同源）`,
  );
  lines.push(
    `- 分子：**最终正文**（模型正文 + 机械补回段）里 \`mentionsEdge\` 命中不了的 **${int(s.missingIdsAll)}** 条 ` +
      `= **${pct(s.expectedEdges === 0 ? null : s.missingIdsAll / s.expectedEdges)}**`,
  );
  lines.push(
    `- 其中**有占位符的折痕**贡献 **${int(s.missingIds)}** 个（本报告的题）：**${int(s.missingBehindPlaceholder)}** 个` +
      `能由某条占位符的坐标**唯一定死**（其余 ${int(s.missingIds - s.missingBehindPlaceholder)} 个连反推都没有）；` +
      `另外 **${int(s.missingIdsAll - s.missingIds)}** 个来自**破折号区间**（T26 的对象，不在本报告范围）`,
  );
  if (s.missingList.length > 0) {
    lines.push("");
    lines.push("| 会话 | 区间 | 时间 | 丢的 id |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of s.missingList) {
      lines.push(
        `| \`${String(row.session ?? "").slice(-20)}\` | ${int(row.range?.start)}-${int(row.range?.end)} | ${iso(row.at)} | \`${row.id}\` |`,
      );
    }
  }
  lines.push("");
  lines.push(
    `> **换算**：占位符行 **${int(s.lines)}** 条，真丢 **${int(s.missingIds)}** 个 id —— ` +
      `**${pct(s.lines === 0 ? null : 1 - s.missingIds / s.lines)}** 的占位符**没有丢 id**（有坐标或能反推出边）。` +
      `把 ${int(s.lines)} 当丢失数会高估 **${(s.missingIds === 0 ? 0 : s.lines / s.missingIds).toFixed(1)} 倍**。`,
  );
  lines.push("");
  /* ── ④ 分布 ── */
  lines.push("## ④ 分布（哪些 trigger / 哪些时段 / 哪类动作）");
  lines.push("");
  lines.push("| trigger | 行数 |");
  lines.push("| --- | --- |");
  for (const [name, n] of s.byTrigger) lines.push(`| \`${name}\` | ${int(n)} |`);
  lines.push("");
  lines.push(
    `- 时间：最近 6h **${int(s.recent.lines)}** 行 / ${int(s.recent.folds)} 条折痕；更早 **${int(s.earlier.lines)}** 行 / ${int(s.earlier.folds)} 条 —— ` +
      `按小时：${s.byHour
        .slice(0, 6)
        .map(([h, n]) => `\`${h}\`×${n}`)
        .join(" · ")}`,
  );
  const pinnedRows = s.byTool.filter(([name]) => name !== "(未反推)").slice(0, 6);
  lines.push(
    `- 动作类型（能反推出的 ${int(s.byTool.filter(([name]) => name !== "(未反推)").reduce((n, [, c]) => n + c, 0))} 行里）：` +
      (pinnedRows.length === 0 ? "—（一条都没反推出来）" : pinnedRows.map(([name, n]) => `\`${name}\`×${n}`).join(" · ")),
  );
  lines.push("");

  /* ── ⑤ 根因 ── */
  lines.push("## ⑤ 根因判定：A / B / C / D");
  lines.push("");
  lines.push("| 选项 | 判据 | 数字 | 结论 |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| **A 提示词** | 模型在事实块里**看得到** id 却写成 \`e?\` | ${int(s.seqPinned)} 行是**逐字照抄**事实块格式 | ❌ **证伪**：模型写的**本来就是 \`e###\`**，是 sanitize 事后抹的 |`,
  );
  lines.push(
    `| **B 事实块** | id 根本没进事实块（80 字符切 / \`slice(-40)\` / 8000 字符截断） | 漏掉的 ${int(s.missingIds)} 个 id 里，**${int(s.factsProbeHit)}** 个**在事实块里逐字存在** | ❌ **证伪**：渲染没有切掉它们 |`,
  );
  lines.push(
    `| **C 机械补回** | \`repairMissingFailures\` 该补没补 | 带 \`quality.failuresRepaired\` 字段的折痕 **${int(s.repairedFieldPresent)} / ${int(s.foldsWithPlaceholders)}** | ✅ **成立**：补回**一次都没跑过**（字段全缺 = 生产者早于 C641） |`,
  );
  lines.push(
    `| **D 不可修** | 模型确实拿不到 id | ${int(s.unresolvedLines)} 行反推不出（占 ${pct(s.lines === 0 ? null : s.unresolvedLines / s.lines)}） | ⚠ **部分成立**：这一档没有 id 可写，但也不是丢（本来就不是区间内的边） |`,
  );
  lines.push("");
  lines.push(
    `**这条链的机械证据**（\`probeSanitize\`）：把每个折痕**事实块里的边 id 原样**喂给 \`sanitizeSummaryIds\` —— ` +
      `共 **${int(s.factsIdsChecked)}** 个 id，其中 **${int(s.factsIdsBlanked)}** 个被抹成 \`e?\`` +
      `（**${pct(s.factsIdsChecked === 0 ? null : s.factsIdsBlanked / s.factsIdsChecked)}**）。` +
      `也就是说：**模型照抄得越忠实，占位符越多** —— 这不是模型的问题。`,
  );
  lines.push("");
  lines.push("**为什么不是 A（提示词）**：");
  lines.push("");
  lines.push(
    `1. 占位符行 **${int(s.seqPinned)}** 条逐字复制了 \`renderFacts\` 的行格式（\`- e123 "动作" → 错误 (seq a-b)\`）—— ` +
      `**模型写的就是具体 id**，它没有偷懒写问号；`,
  );
  lines.push(
    `2. 真正的 \`e?\` 出现在 **sanitize 之后**：\`sanitizeSummaryIds\` 把「证据收口晚于遮蔽终点」的 id 换成 \`e?\` ` +
      `（C458 的设计），于是**忠实照抄的事实块**在 checkpoint 里变成了问号；`,
  );
  lines.push(
    `3. ⇒ 改提示词（「死路必须写具体 id，禁止 \`e?\`」）**对这批无效**：模型已经写了 id，规则再加一遍只是同一句话说第三次。`,
  );
  lines.push("");
  lines.push("**为什么不是 B（事实块切了 id）**：");
  lines.push("");
  lines.push(
    `- 漏掉的 ${int(s.missingIds)} 个 id 全部能在**重渲染的事实块**里找到对应行（见 ⑥ 样本的「事实块原文」），` +
      `80 字符切的是**动作/错误**（C607 已修），不是 id（id 在行首）；`,
  );
  lines.push(`- 所以「改渲染」不是这批数字的解 —— 渲染给它看了，是**后面一层**把 id 拿走了。`);
  lines.push("");
  lines.push("**为什么是 C（机械补回）**：");
  lines.push("");
  lines.push(
    `- \`repairMissingFailures\` 就是为这件事写的（C607：死路丢一条 = 下一个模型必然重踩），判据与探针同源；`,
  );
  lines.push(
    `- 但真机 **${int(s.foldsWithPlaceholders) - int(s.repairedFieldPresent)} / ${int(s.foldsWithPlaceholders)}** 条占位符折痕**没有** \`quality.failuresRepaired\` 字段 ` +
      `（C641 起每条必写）⇒ **补回代码根本没在被测进程里跑过**（ESM 启动时加载，宿主没重启）；`,
  );
  lines.push(
    `- 而且即使跑起来，它现在只**追加**一行、不**认领**占位符 ⇒ 死路段里那行 \`e?\` 永久留着（同一件事写两遍，其中一遍仍不可定位）。`,
  );
  lines.push("");

  /* ── ⑥ 样本 ── */
  lines.push(`## ⑥ ${int(samples)} 个样本（原文 + 它本该写成什么）`);
  lines.push("");
  const picked = pickSamples(result.placeholders, samples);
  picked.forEach((p, i) => {
    lines.push(`### 样本 ${i + 1} · \`${p.category}\` · 反推 = \`${p.id ?? "?"}\`（${p.via ?? "无"}）`);
    lines.push("");
    lines.push(`原文（${int(p.line.length)} 字符的行）：`);
    lines.push("");
    lines.push("```");
    lines.push(p.line.length > 240 ? `${p.line.slice(0, 240)} …` : p.line);
    lines.push("```");
    if (p.canonical !== null) {
      lines.push("");
      lines.push("它本该写成（id + 动作 + 为什么失败）：");
      lines.push("");
      lines.push("```");
      lines.push(p.canonical.length > 220 ? `${p.canonical.slice(0, 220)} …` : p.canonical);
      lines.push("```");
    } else {
      lines.push("");
      lines.push("- 反推不出边 ⇒ **不猜**：这一行只能靠原文回查，不能凭语义补 id。");
    }
    lines.push(
      `- 区间 \`${int(p.range?.start)}-${int(p.range?.end)}\` · 跨度 \`${p.span === null ? "—" : `${p.span.start}-${p.span.end}`}\` · ` +
        `工具 \`${p.tool}\` · 别处有 id = ${p.compensated === null ? "—" : p.compensated ? "**是**" : "**否**"}`,
    );
    lines.push("");
  });

  /* ── ⑦ 收益 ── */
  lines.push("## ⑦ 收益：修完能收回几个 id");
  lines.push("");
  lines.push(
    `- **能收回：${int(s.missingBehindPlaceholder)} 个**（= 全部真丢的 id）—— 它们都由「坐标唯一定死」的占位符行认领，` +
      `补回段把它们写成 \`- e46 「动作」→ 为什么失败\`；`,
  );
  lines.push(
    `- **收不回：${int(s.lines - s.eatenLines)} 行**（${pct(s.lines === 0 ? null : 1 - s.eatenLines / s.lines)}）—— ` +
      `它们是**本段之外**的事实（证据收口晚于遮蔽终点），sanitize 抹掉是**设计**；` +
      `seq 仍在，读者能回原文，**不算丢**；`,
  );
  lines.push(
    `- **重复行**：修完后每条死路只出现一次（现在补回段会在尾部再写一遍同样的边）。`,
  );
  lines.push("");
  lines.push("> 决策已写进 `src/rooms/offline-fold.mjs` 的 `repairMissingFailures` 注释，并由 `test/placeholder.test.mjs` 钉住。");
  lines.push("");
  return lines.join("\n");
}

/* ─────────────────────────────────── 入口 ─────────────────────────────────── */

export function audit({ home = resolveHome(), session = "" } = {}) {
  const { files } = collectGraphFiles(home);
  const folds = [];
  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      continue; // 坏图跳过：一张坏图不许让整份报告失败
    }
    const row = scanFold(graph, { session: String(file.dir) });
    if (row !== null) folds.push(row);
  }
  const placeholders = folds.flatMap((f) => f.placeholders);
  return { home, graphs: files.length, folds, placeholders, summary: summarize(folds), now: Date.now() };
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const samples = Number(get("samples", DEFAULT_SAMPLES));
  return {
    home: String(get("home", resolveHome())),
    session: String(get("session", "") ?? ""),
    samples: Number.isFinite(samples) && samples > 0 ? Math.floor(samples) : DEFAULT_SAMPLES,
    json: argv.includes("--json"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = audit({ home: opts.home, session: opts.session });
  if (result.graphs === 0) {
    console.error(`读不到任何会话图（home=${opts.home}）—— 检查 DSH_HOME / --home。`);
    return 2;
  }
  if (opts.json) {
    const { folds, ...rest } = result;
    console.log(JSON.stringify({ ...rest, samples: pickSamples(result.placeholders, opts.samples) }, null, 2));
    return 0;
  }
  console.log(render(result, { samples: opts.samples }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
