#!/usr/bin/env node
/**
 * summary-usability-audit.mjs —— 摘要**可接手性**审计（T33 · **只读**）
 *
 * 为什么需要（用户原话）：
 *   「所有质量证据都来自探针（constraintRecall / failureRecall / sectionsMissing）。
 *    探针只回答『有没有提到』，**不回答『这条摘要能不能让下一个自己接着干活』**。」
 *
 * 这个脚本**不评分**（评分要人读、要判断，见报告），只做两件机器能做的事：
 *   ① 把真机摘要**原样导出**（`tmp/summary-samples.md`），供人逐条读；
 *   ② 给每条样本配一组**可核对的机械指标**（id 能否定位、seq 对不对得上、有没有幻觉 id、
 *      重复行、段结构、停在哪），让「读感」有证据支撑，而不是拍脑袋。
 *
 * 三条边界：
 *   · **纯只读**：会话棋谱只 `readFileSync`；唯一写盘是 `tmp/summary-samples.md`；
 *   · **不改产品代码**：不 import 任何会写盘的函数（`applyOfflineFoldToGraph` 一律不碰）；
 *   · **不调模型**：只做字符串统计。
 *
 * 抽样方法（确定性，可复现）：把「有正文的折痕」按字符数升序排列，切成 10 个等宽分位，
 *   每个分位取**中位**那条；第 1 分位取**最短**、第 10 分位取**最长**。
 *   ⇒ 覆盖整个长度分布，且**必含最短与最长**（用户硬要求）。
 *
 * 用法：
 *   node scripts/summary-usability-audit.mjs              # 导出 + 打印元信息
 *   node scripts/summary-usability-audit.mjs --json       # 额外打印机器可读的指标
 *   node scripts/summary-usability-audit.mjs --home <DIR> # 显式指定 DSH_HOME（默认读环境变量）
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownIds, findOutOfRangeIds, describeStructure, sectionNames } from "../src/rooms/fold-quality.mjs";
import { estimateTokens } from "../src/rooms/offline-fold.mjs";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
/** 唯一允许写的产物。 */
export const OUT = nodePath.join(ROOT, "tmp", "summary-samples.md");
/** 抽多少条（用户指定 10）。 */
export const SAMPLE_COUNT = 10;

/**
 * ★ **冻结样本集**（T33 首次分层抽样的快照，池 = 343 条 / 556 会话 / 947 折痕，2026-11-05 07:01:16）。
 *
 * 为什么必须冻结：补账进程**正在写**，同一份代码隔 3 分钟跑一次，池从 343 涨到 345，
 * 等宽分位的边界整体漂移 ⇒ 10 条样本换了 3 条。报告里的分数必须指向**固定的一组摘要**，
 * 否则「样本 3 = 5103 字符」这句话下一分钟就不成立。
 *
 * 复现：`--fresh` 按当前语料重新分层（方法见 `pickSampleIndices`）。
 * 冻结集本身**就是** `--fresh` 在 343 条池上的输出，不是挑出来的。
 */
export const FROZEN_SAMPLE_SESSIONS = Object.freeze([
  "session-e336b9dd-2dab-4149-b4e6-b2500627a5ca", // 556 字符（最短，截断的 tool_call）
  "fa14060a-67d6-4af8-8714-1666cb0519b3", // 4424
  "f631e4d5-b125-4dc2-8775-6d8f4f70fcfd", // 5103
  "2856b55d-d371-4a68-baca-e30f8e8cc1e3", // 5682
  "session-3f03c71c-e468-44f7-a600-26f60e0098b8", // 6068（单事件区间 seq 8-8）
  "71b54549-e0c2-4c0f-9baf-5ac715776003", // 6469
  "3c43529c-1267-46dd-9cc0-a6c7366898fc", // 6971（单事件区间 seq 11-11）
  "1e7305b7-7758-49c3-8068-777cbdbab697", // 7508
  "1919d402-fff6-467e-9526-e2c05f5aaabf", // 8095
  "session-f7f835b1-7109-4da3-9fd2-f8c708d5f1bf", // 13210（最长）
]);

/**
 * 解析 DSH_HOME。与 `scripts/last-summary.mjs` 保持同一套规则（别在脚本之间发明第二套）。
 * @param {string|null} [override]
 * @returns {string}
 */
export function resolveHome(override = null) {
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const env = String(process.env.DSH_HOME ?? "").trim();
  if (env !== "") return env;
  return nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

/**
 * ★ 核心：一条折痕的**正文**怎么取。
 *
 * 真机现状（2026-11-05 实测，这就是本轮最大的发现）：
 *   · `foldMarks` 共 **947** 条，`summaryText` **0** 条、`summaryTextRef` **0** 条；
 *   · 正文只活在 `graph.lastOfflineSummary.text` 这**一个槽**里（343 个会话）。
 *   ⇒ C642/T29 的「正文落盘」写回点**没有在生产数据里生效**（跑着的引擎仍是旧代码）。
 *   所以这里按**显式优先级**取，并把「这份正文是从哪来的」一并返回 —— 审计必须能说出
 *   「我评的到底是 mark 自己存的，还是单槽里借来的」，否则分母会被悄悄放大。
 *
 * @param {object} mark 一条 foldMark
 * @param {object|null} lastOfflineSummary `graph.lastOfflineSummary`
 * @returns {{text:string|null, source:"summaryText"|"summaryTextRef"|"lastOfflineSummary"|null}}
 */
export function resolveSummaryText(mark, lastOfflineSummary) {
  const m = mark !== null && typeof mark === "object" ? mark : {};
  if (typeof m.summaryText === "string" && m.summaryText !== "") return { text: m.summaryText, source: "summaryText" };
  const slot = lastOfflineSummary !== null && typeof lastOfflineSummary === "object" ? lastOfflineSummary : null;
  const slotText = typeof slot?.text === "string" && slot.text !== "" ? slot.text : null;
  if (slotText === null) return { text: null, source: null };
  const sameRange =
    Number(slot?.range?.start) === Number(m.seqStart) && Number(slot?.range?.end) === Number(m.seqEnd);
  // `summaryTextRef` 是 C642 的「只留引用」写法：正文在单槽里，引用指向它。
  if (m.summaryTextRef === "lastOfflineSummary" && sameRange) return { text: slotText, source: "summaryTextRef" };
  // 旧生产者：mark 只有 `summaryChars`，正文只在这个单槽里（区间必须对得上，别把别人的正文借过来）。
  if (sameRange) return { text: slotText, source: "lastOfflineSummary" };
  return { text: null, source: null };
}

/**
 * 扫全库，产出口径数字。纯函数（便于单测）。
 * @param {Array<{sessionId:string, marks:object[], lastOfflineSummary:object|null}>} sessions
 * @returns {{sessions:number, marks:number, byTrigger:Record<string,number>,
 *   bySource:Record<string,number>, pool:Array<object>, marksWithCharsOnly:number,
 *   sessionsWithText:number, sessionsWithMarks:number}}
 */
export function census(sessions) {
  const byTrigger = Object.create(null);
  const bySource = Object.create(null);
  const pool = [];
  let marks = 0;
  let marksWithCharsOnly = 0;
  let sessionsWithText = 0;
  let sessionsWithMarks = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const list = Array.isArray(session?.marks) ? session.marks : [];
    if (list.length > 0) sessionsWithMarks += 1;
    let sessionHasText = false;
    for (const mark of list) {
      marks += 1;
      const trigger = String(mark?.trigger ?? "undefined");
      byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
      const { text, source } = resolveSummaryText(mark, session?.lastOfflineSummary ?? null);
      bySource[source ?? "none"] = (bySource[source ?? "none"] ?? 0) + 1;
      if (text === null) {
        if (Number.isFinite(Number(mark?.summaryChars)) && Number(mark.summaryChars) > 0) marksWithCharsOnly += 1;
        continue;
      }
      sessionHasText = true;
      pool.push({
        sessionId: String(session.sessionId),
        trigger,
        source,
        text,
        chars: text.length,
        at: Number(mark?.at ?? session?.lastOfflineSummary?.at ?? 0),
        seqStart: Number(mark?.seqStart),
        seqEnd: Number(mark?.seqEnd),
        mark,
        lastOfflineSummary: session?.lastOfflineSummary ?? null,
      });
    }
    if (sessionHasText) sessionsWithText += 1;
  }
  pool.sort((a, b) => a.chars - b.chars || String(a.sessionId).localeCompare(String(b.sessionId)));
  return { sessions: sessions.length, marks, byTrigger, bySource, pool, marksWithCharsOnly, sessionsWithText, sessionsWithMarks };
}

/**
 * 确定性分层抽样：按字符数升序切 `count` 个等宽分位，每个分位取中位；
 * 首分位取**最短**、末分位取**最长**（用户硬要求：含最短和最长的）。
 * @param {Array<{chars:number}>} sortedPool 按 chars 升序
 * @param {number} [count]
 * @returns {number[]} 选中的下标（升序、无重复）
 */
export function pickSampleIndices(sortedPool, count = SAMPLE_COUNT) {
  const n = Array.isArray(sortedPool) ? sortedPool.length : 0;
  const k = Math.max(1, Math.min(Number(count) || SAMPLE_COUNT, n));
  const picked = new Set();
  for (let d = 0; d < k; d += 1) {
    const lo = Math.floor((d * n) / k);
    const hi = Math.floor(((d + 1) * n) / k) - 1;
    if (hi < lo) continue;
    // 首尾取端点，中间取中位 —— 端点保证「最短/最长」真的被抽到。
    const idx = d === 0 ? lo : d === k - 1 ? hi : Math.floor((lo + hi) / 2);
    picked.add(idx);
  }
  // 兜底：分位塌缩（n < k）时补足到 k 个不同下标
  for (let i = 0; picked.size < k && i < n; i += 1) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

/** 把 `## 标题` 切成 {段名: 段内正文} 的映射（同名取第一次出现）。 */
export function splitSections(text) {
  const out = Object.create(null);
  let current = "__preamble__";
  out[current] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = /^##[ \t]+(\S.*)$/.exec(line);
    if (heading !== null) {
      current = heading[1].replace(/[（(][^（()）]*[）)]\s*$/, "").replace(/[:：]\s*$/, "").trim();
      if (out[current] === undefined) out[current] = [];
      continue;
    }
    out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n").trim()]));
}

/** 数一个段落里的项目符号行（`- ` / `* ` 开头）。 */
function countBullets(sectionText) {
  return String(sectionText ?? "")
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

/**
 * 机械指标：机器能核对的都算出来，给「读感评分」当证据。
 * @param {object} sample `census.pool` 里的一条
 * @param {object} graph 该会话的棋谱
 * @returns {object}
 */
export function measureSample(sample, graph) {
  const text = String(sample.text ?? "");
  const range = { start: Number(sample.seqStart), end: Number(sample.seqEnd) };
  const sections = splitSections(text);
  const headings = sectionNames(text);
  const structure = describeStructure(text, { expectFailures: true });
  const unknown = findUnknownIds(graph, text);
  const outOfRange = findOutOfRangeIds(graph, range, text, { allow: null });

  // 独立 id（`n12` / `e34`，前后不接标识符字符）
  const ids = new Set();
  for (const match of text.matchAll(/[en][0-9]{1,5}/g)) {
    const at = match.index ?? 0;
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + match[0].length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    ids.add(match[0]);
  }
  const nodeIds = [...ids].filter((id) => id[0] === "n");
  const edgeIds = [...ids].filter((id) => id[0] === "e");

  // ★ 被 `sanitizeSummaryIds` 抹成 `n?`/`e?` 的引用 —— 它们**看起来**是定位锚点，实际指不到任何东西。
  //   真机样本 5/7 的折叠区间是单个事件（seq 8-8 / 11-11），整篇 id 因此全被抹掉。
  const placeholderMatches = [...text.matchAll(/[ne]\?/g)];
  const placeholderCount = placeholderMatches.length;
  /** 真实可定位的 id 占「全部引用」的比例；没有引用时记 null（不拿 0 冒充"很差"）。 */
  const idRefsTotal = ids.size + placeholderCount;
  const traceableShare = idRefsTotal === 0 ? null : Math.round((ids.size / idRefsTotal) * 1000) / 1000;

  // 工具调用泄漏（样本 1：模型没写摘要，把 `<tool_call>` 原样吐了出来）
  const toolCallLeak = (text.match(/<tool_call>|<function=|<\/function>/g) ?? []).length;
  // 系统提示词回灌（样本 10：`## 约束（逐字）` 里塞了整份系统提示词）
  const PROMPT_MARKERS = [
    /SOVEREIGN/,
    /system-reminder/i,
    /^# 歧义/,
    /推理过程用中文思考/,
    /web_search results are external/,
    /工具调用被拒绝时/,
  ];
  const promptEchoLines = text
    .split(/\r?\n/)
    .filter((line) => PROMPT_MARKERS.some((re) => re.test(line))).length;
  // `## 约束（逐字）` 与 `## 约束（逐字补充 · 离线压缩后自动补回）` 是否有重复行
  const verbatim = new Set(
    String(sections["约束"] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 20),
  );
  const constraintDupLines = String(sections["约束（逐字补充 · 离线压缩后自动补回，不许删）"] ?? sections["约束（逐字补充"] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && verbatim.has(line)).length;

  // `(seq a-b)` 这类**坐标断言**：能否与图里的 evidence 对上（可定位性的硬证据）
  let seqClaims = 0;
  let seqMatched = 0;
  const seqMismatch = [];
  for (const match of text.matchAll(/(?:\be(\d{1,4})\b)[^\n]{0,200}?\(seq (\d+)-(\d+)\)/g)) {
    seqClaims += 1;
    const edge = graph?.edges?.[`e${match[1]}`];
    const span = edge?.evidence ?? null;
    if (span !== null && Number(span.start) === Number(match[2]) && Number(span.end) === Number(match[3])) seqMatched += 1;
    else seqMismatch.push(`e${match[1]}:${match[2]}-${match[3]}`);
  }

  // 「现在停在哪」——下一个 agent 最需要的那句话
  const stoppedAt = /(?:当前停在|当前节点[：:]?|停在)\s*(n\d+)/.exec(text)?.[1] ?? null;
  const hasNextStepHeading = headings.some((name) => /下一步|接下来|待办|TODO/i.test(name));
  // 「下一步做什么」——排除「尚未/未验证」这种**状态描述**，只认动作性指令
  const nextActionLines = text
    .split(/\r?\n/)
    .filter((line) => /(?:下一步|接下来(?:要|应|先|需要)|待办|先(?:去|要|做))/.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== "");

  // 冗余：≥20 字符的重复行
  const seen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 20) continue;
    seen.set(trimmed, (seen.get(trimmed) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);
  const dupLineCount = repeated.reduce((n, [, count]) => n + (count - 1), 0);
  const dupCharShare =
    text.length === 0
      ? 0
      : Math.round(
          (repeated.reduce((n, [line, count]) => n + line.length * (count - 1), 0) / text.length) * 1000,
        ) / 1000;

  const emptyish = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:同上|略|……|\.\.\.|（略）|\(略\))$/.test(line)).length;

  const tokens = estimateTokens(text);
  const deadend = countBullets(sections["死路"] ?? sections["已探明死路"] ?? "");
  const unverified = countBullets(sections["未验证"] ?? "");
  const verified = countBullets(sections["已验证事实"] ?? sections["已验证"] ?? "");

  return {
    sessionId: sample.sessionId,
    trigger: sample.trigger,
    source: sample.source,
    at: Number(sample.at ?? 0),
    range,
    chars: text.length,
    tokens,
    tokensPerChar: text.length === 0 ? 0 : Math.round((tokens / text.length) * 1000) / 1000,
    lines: text.split(/\r?\n/).length,
    headings,
    sectionsPresent: structure.sectionsPresent,
    sectionsMissing: structure.sectionsMissing,
    endedCleanly: structure.endedCleanly,
    ids: ids.size,
    nodeIds: nodeIds.length,
    edgeIds: edgeIds.length,
    placeholders: placeholderCount,
    idRefsTotal,
    traceableShare,
    toolCallLeak,
    promptEchoLines,
    constraintDupLines,
    unknownIds: unknown.unknown,
    unknownChecked: unknown.checked,
    outOfRangeEarlier: outOfRange.earlier,
    outOfRangeLater: outOfRange.later,
    seqClaims,
    seqMatched,
    seqMismatch,
    stoppedAt,
    hasNextStepHeading,
    nextActionCount: nextActionLines.length,
    nextActions: nextActionLines.slice(0, 3),
    deadendBullets: deadend,
    unverifiedBullets: unverified,
    verifiedBullets: verified,
    dupLineCount,
    dupCharShare,
    emptyishLines: emptyish,
    usage: sample.mark?.usage ?? null,
    ms: sample.mark?.ms ?? null,
    model: sample.mark?.route?.model ?? sample.lastOfflineSummary?.model ?? null,
    inputTruncated: sample.mark?.inputTruncated ?? null,
    truncated: sample.mark?.truncated ?? null,
    quality: sample.mark?.quality ?? null,
  };
}

/** 只读打开一个会话棋谱；失败返回 null（不吞成"没有折痕"）。 */
function readGraph(graphFile) {
  try {
    return JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
  } catch {
    return null;
  }
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "时间未知";
  return new Date(n).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function pct(part, total) {
  return total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;
}

/** 选一个比正文里最长反引号串更长的围栏，保证原样导出不被截断。 */
function fenceFor(text) {
  let longest = 0;
  for (const match of String(text ?? "").matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(4, longest + 1));
}

/**
 * 渲染 `tmp/summary-samples.md`。
 * @param {{census:object, samples:Array<object>, home:string}} args
 * @returns {string}
 */
export function renderMarkdown({ census: c, samples, home, frozen = true, frozenMissing = [] }) {
  const out = [];
  out.push("# 摘要可接手性审计 · 真机样本（**生成物，勿手改**）");
  out.push("");
  out.push(`> 生成器：\`node scripts/summary-usability-audit.mjs\` · 只读数据源：\`${home.replace(/\\/g, "/")}/chess-context/sessions\``);
  out.push(`> 生成时间：${fmtTime(Date.now())} · 样本 **${samples.length}** 条 · 全库 **${c.marks}** 条折痕 / **${c.sessions}** 个会话`);
  out.push("");
  out.push("## 0. 口径（先看这个，否则下面的分母是假的）");
  out.push("");
  out.push("| 项 | 数量 |");
  out.push("|---|---|");
  out.push(`| 会话数 | ${c.sessions} |`);
  out.push(`| 折痕（foldMarks）总数 | ${c.marks} |`);
  out.push(`| 其中带 \`summaryText\` | ${c.bySource.summaryText ?? 0} |`);
  out.push(`| 其中带 \`summaryTextRef\` | ${c.bySource.summaryTextRef ?? 0} |`);
  out.push(`| 正文来自 \`lastOfflineSummary\` 单槽（旧生产者） | ${c.bySource.lastOfflineSummary ?? 0} |`);
  out.push(`| 只有 \`summaryChars\`、正文**不可复判** | ${c.marksWithCharsOnly} |`);
  out.push(`| 有正文的会话 | ${c.sessionsWithText} / ${c.sessions} |`);
  out.push("");
  out.push("**trigger 分布**（折痕条数）：");
  out.push("");
  out.push("| trigger | 条数 | 占比 |");
  out.push("|---|---|---|");
  for (const [trigger, count] of Object.entries(c.byTrigger).sort((a, b) => b[1] - a[1])) {
    out.push(`| ${trigger} | ${count} | ${pct(count, c.marks)} |`);
  }
  out.push("");
  out.push(
    "> ⚠ **trigger 维度无法覆盖**：全库 **0** 条折痕带正文，正文只存在于 `lastOfflineSummary` 单槽，" +
      "而只有 `archive-offline` 会写这个槽 ⇒ **10 条样本全部是 `archive-offline`**。" +
      "`pressure` / `tier2` / `context-overflow` 的摘要正文**已经永久丢失**，不可评。",
  );
  out.push("");
  out.push("## 1. 抽样方法（确定性，可复现）");
  out.push("");
  out.push(
    `把「有正文的 ${c.pool.length} 条」按**字符数升序**排列，切成 ${samples.length} 个等宽分位，` +
      "每个分位取**中位**那条；第 1 分位取**最短**、第 10 分位取**最长**。" +
      "⇒ 覆盖整个长度分布，且必含最短与最长（用户硬要求：不许挑漂亮样本）。",
  );
  out.push("");
  out.push(
    frozen
      ? "> ⚠ **样本集已冻结**（池 343 条 / 2026-11-05 07:01:16 的快照）：补账进程仍在写，" +
          `同一份代码隔 3 分钟跑，池就从 343 涨到 ${c.pool.length}，等宽分位边界整体漂移、样本换了 3 条。` +
          "报告里的分数必须指向固定的一组摘要，所以默认走 `FROZEN_SAMPLE_SESSIONS`；" +
          `\`--fresh\` 才按当前语料重新分层。${frozenMissing.length > 0 ? `（本次有 ${frozenMissing.length} 条冻结样本已解析不到：${frozenMissing.join("、")}）` : ""}`
      : "> 本次是 `--fresh` 重抽样：结果随语料变化，不可与历史报告直接比较。",
  );
  out.push("");
  out.push("## 2. 10 条样本 · 元信息");
  out.push("");
  out.push("| # | 会话 | 区间(seq) | trigger | 字符 | 估 token | 时间 | 模型 |");
  out.push("|---|---|---|---|---|---|---|---|");
  samples.forEach((s, i) => {
    out.push(
      `| ${i + 1} | \`${s.sessionId}\` | ${s.range.start}–${s.range.end} | ${s.trigger} | ${s.chars} | ${s.tokens} | ${fmtTime(s.at)} | ${s.model ?? "?"} |`,
    );
  });
  out.push("");
  out.push("## 3. 机械指标（机器能核对的证据，评分的依据）");
  out.push("");
  out.push("| # | 段齐 | 结尾干净 | 真 id(n/e) | `n?`占位 | 可定位率 | 幻觉 id | 越界·更晚 | seq 断言(对上/总数) | 停在哪 | 下一步 | 死路 | 未验证 | 重复行 | 提示词回灌 | 工具调用泄漏 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  samples.forEach((s, i) => {
    out.push(
      `| ${i + 1} | ${s.sectionsPresent}/3${s.sectionsMissing.length > 0 ? ` 缺${s.sectionsMissing.join("+")}` : ""} | ${s.endedCleanly ? "是" : "**否**"} | ` +
        `${s.ids} (${s.nodeIds}n/${s.edgeIds}e) | ${s.placeholders} | ${s.traceableShare === null ? "—" : `${(s.traceableShare * 100).toFixed(0)}%`} | ` +
        `${s.unknownIds.length === 0 ? "0" : `**${s.unknownIds.join(",")}**`} | ` +
        `${s.outOfRangeLater.length === 0 ? "0" : `**${s.outOfRangeLater.join(",")}**`} | ${s.seqMatched}/${s.seqClaims} | ` +
        `${s.stoppedAt ?? "**无**"} | ${s.nextActionCount} 条 | ${s.deadendBullets} | ${s.unverifiedBullets} | ${s.dupLineCount} | ${s.promptEchoLines} 行 | ${s.toolCallLeak} |`,
    );
  });
  out.push("");
  out.push("## 4. 逐条原文（**原样，未截断**）");
  out.push("");
  samples.forEach((s, i) => {
    const fence = fenceFor(s.text);
    out.push(`### 样本 ${i + 1} · \`${s.sessionId}\` · seq ${s.range.start}–${s.range.end} · ${s.chars} 字符 · ${fmtTime(s.at)}`);
    out.push("");
    out.push(
      `> trigger \`${s.trigger}\` · 正文来源 \`${s.source}\` · 模型 \`${s.model ?? "?"}\` · 耗时 ${s.ms ?? "?"}ms · ` +
        `inputTruncated \`${String(s.inputTruncated)}\` · truncated \`${String(s.truncated)}\``,
    );
    if (s.quality !== null && s.quality !== undefined) {
      out.push(
        `> 探针：约束召回 ${s.quality.constraintRecall ?? "?"}（${s.quality.expectedConstraints ?? "?"} 条）· ` +
          `失败召回 ${s.quality.failureRecall ?? "?"}（${s.quality.expectedFailures ?? "?"} 条）· ` +
          `缺段 ${(s.quality.sectionsMissing ?? []).join("/") || "无"} · 结尾干净 ${String(s.quality.endedCleanly ?? "?")} · ` +
          `摘要 ${s.quality.summaryTokens ?? "?"} tok`,
      );
    }
    if (s.nextActions.length > 0) {
      out.push(`> 「下一步」候选行：${s.nextActions.map((line) => `\`${line.slice(0, 60)}\``).join(" · ")}`);
    }
    out.push("");
    out.push(fence + "text");
    out.push(s.text);
    out.push(fence);
    out.push("");
  });
  out.push("---");
  out.push("");
  out.push("**本文件由脚本生成；评分与结论见交付报告，不写回这里。**");
  out.push("");
  return out.join("\n");
}

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
    return 1;
  }

  // ① 只读扫全库
  const sessions = [];
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null || typeof graph !== "object") continue;
    sessions.push({
      sessionId: String(graph.sessionId ?? entry.name),
      dir: entry.name,
      marks: Array.isArray(graph.foldMarks) ? graph.foldMarks : [],
      lastOfflineSummary: graph.lastOfflineSummary ?? null,
    });
  }
  const c = census(sessions);

  // ② 抽样：默认用**冻结集**（可复现），`--fresh` 才按当前语料重新分层
  const fresh = argv.includes("--fresh");
  const frozenMissing = [];
  let picked;
  if (fresh) {
    picked = pickSampleIndices(c.pool, SAMPLE_COUNT).map((i) => c.pool[i]);
  } else {
    const bySession = new Map(c.pool.map((s) => [s.sessionId, s]));
    picked = [];
    for (const sessionId of FROZEN_SAMPLE_SESSIONS) {
      const hit = bySession.get(sessionId);
      if (hit === undefined) frozenMissing.push(sessionId);
      else picked.push(hit);
    }
  }
  const samples = picked.map((sample) => {
    const dir = sessions.find((s) => s.sessionId === sample.sessionId)?.dir ?? sample.sessionId;
    const graph = readGraph(nodePath.join(sessionsDir, dir, "graph.json")) ?? { nodes: {}, edges: {} };
    // 正文必须跟着样本走 —— 指标算完就丢正文的话，导出文件里只剩空壳（本轮踩过）。
    return { ...measureSample(sample, graph), text: String(sample.text ?? "") };
  });

  if (samples.length === 0) {
    console.error("没有任何可复判的摘要正文（foldMark.summaryText 与 lastOfflineSummary 都为空）");
    return 1;
  }

  // ③ 唯一写盘
  nodeFs.mkdirSync(nodePath.dirname(OUT), { recursive: true });
  const markdown = renderMarkdown({ census: c, samples, home, fresh, frozenMissing });
  nodeFs.writeFileSync(OUT, markdown, "utf8");

  // ④ 打元信息（验收要的：会话/区间/trigger/字符数/时间）
  console.log("摘要可接手性审计（只读）");
  console.log(`home            : ${home}`);
  console.log(`会话 / 折痕     : ${c.sessions} / ${c.marks}`);
  console.log(
    `正文来源        : summaryText ${c.bySource.summaryText ?? 0} · summaryTextRef ${c.bySource.summaryTextRef ?? 0} · ` +
      `lastOfflineSummary ${c.bySource.lastOfflineSummary ?? 0} · 无正文 ${c.bySource.none ?? 0}`,
  );
  console.log(`不可复判        : ${c.marksWithCharsOnly} 条折痕只有 summaryChars、没有正文`);
  console.log(
    `trigger 分布    : ${Object.entries(c.byTrigger)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}=${n}`)
      .join(" · ")}`,
  );
  console.log(`可复判池        : ${c.pool.length} 条（${pct(c.pool.length, c.marks)}）· 长度 ${c.pool[0]?.chars ?? 0}–${c.pool[c.pool.length - 1]?.chars ?? 0} 字符`);
  console.log("");
  console.log(
    fresh
      ? `抽样            : --fresh —— 按字符数切 ${samples.length} 个等宽分位，各取中位（首=最短、末=最长）`
      : `样本集          : 冻结（T33 首次分层抽样快照，池 343 条 / 2026-11-05 07:01:16）· 命中 ${samples.length}/${FROZEN_SAMPLE_SESSIONS.length}${frozenMissing.length > 0 ? ` · 缺失 ${frozenMissing.length}` : ""}`,
  );
  if (c.pool.length !== 343) {
    console.log(`⚠ 语料漂移      : 冻结时池 343 条，当前 ${c.pool.length} 条（补账仍在写；` + "`--fresh` 才会跟着漂）");
  }
  console.log("");
  console.log("| # | 会话 | 区间(seq) | trigger | 字符 | 估token | 时间 |");
  console.log("|---|---|---|---|---|---|---|");
  samples.forEach((s, i) => {
    console.log(
      `| ${i + 1} | ${s.sessionId} | ${s.range.start}-${s.range.end} | ${s.trigger} | ${s.chars} | ${s.tokens} | ${fmtTime(s.at)} |`,
    );
  });
  console.log("");
  console.log("机械指标：");
  console.log("| # | 段齐 | 结尾干净 | 真id(n/e) | n?占位 | 可定位率 | 幻觉id | 越界更晚 | seq对上 | 停在哪 | 下一步 | 死路 | 未验证 | 重复行 | 提示词回灌 | 工具泄漏 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  samples.forEach((s, i) => {
    console.log(
      `| ${i + 1} | ${s.sectionsPresent}/3 | ${s.endedCleanly ? "是" : "否"} | ${s.ids}(${s.nodeIds}n/${s.edgeIds}e) | ${s.placeholders} | ` +
        `${s.traceableShare === null ? "—" : `${(s.traceableShare * 100).toFixed(0)}%`} | ${s.unknownIds.length === 0 ? "0" : s.unknownIds.join(",")} | ` +
        `${s.outOfRangeLater.length === 0 ? "0" : s.outOfRangeLater.join(",")} | ${s.seqMatched}/${s.seqClaims} | ${s.stoppedAt ?? "无"} | ` +
        `${s.nextActionCount} | ${s.deadendBullets} | ${s.unverifiedBullets} | ${s.dupLineCount} | ${s.promptEchoLines} | ${s.toolCallLeak} |`,
    );
  });
  console.log("");
  console.log(`已写 ${nodePath.relative(ROOT, OUT).replace(/\\/g, "/")}（${markdown.length} 字符）`);

  if (argv.includes("--json")) {
    console.log("");
    console.log(JSON.stringify({ census: { ...c, pool: c.pool.length }, samples }, null, 2));
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
