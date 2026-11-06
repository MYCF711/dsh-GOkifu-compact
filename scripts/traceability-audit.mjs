#!/usr/bin/env node
/**
 * traceability-audit.mjs —— 「摘要逐字可回查率」审计（T54 · 只读 · 零模型调用）
 *
 * ── 由来（Lead 的原话，T53 判死两个候选指标之后） ──────────────────────────────
 *   「第三个候选：**摘要正文的逐字可回查率** —— 把摘要里每条「动作 → 结果」按 n-gram
 *    反查到折叠输入的**消息原文**（不看 id、不看区间）；不被 sanitize 截断，也不依赖折痕折在哪。」
 *
 * 前两个候选的死因（别重复发明）：
 *   · 可定位率   —— 是**折痕形状**的函数（尾部 99.6% vs 中段 43.9%），与代码质量无关；
 *   · 区间保真度 —— 口径 A 85.6% 恒等于 1.0（**循环**，量的是 sanitize 的输出）；
 *                   口径 B 与可定位率 ρ=0.895（**就是它**）。
 *
 * ── 这个指标量的是什么（一句话） ────────────────────────────────────────────
 *   **摘要里的「动作 → 结果」有多少条能在「模型当时看到的输入消息」里逐字找回来。**
 *   它完全不看 `nN`/`eN`、不看 `(seq a-b)` ⇒ 结构上**不可能**被 `sanitizeSummaryIds` 影响，
 *   也不可能被「折痕折在哪」影响。这两条是**定义**保证的，不是跑出来的。
 *
 * ── 抽取规则（**闭集** · 5 条，改这里就是改指标） ─────────────────────────────
 *   U1 **项目符号行**：`^\s*[-*][ \t]+`（Markdown 列表项）。非列表行一律不是事实单元 ——
 *      摘要里的叙述段、标题、代码块都不算。
 *   U2 **含箭头**：`→`（U+2192）/ `->` / `⇒`。这是「动作 → 结果」的语法标记；
 *      没有箭头就没有「动作 → 结果」这个断言，不抽。
 *   U3 **规范化（顺序固定，只去格式、不去内容）**：
 *      ① 去项目符号；
 *      ② 去坐标 `(seq a-b)`（全/半角括号、`-`/`–`/`—`/`~` 四种连字符）；
 *      ③ 去**实体引用** `[en]\d{1,5}`（独立标识符边界 —— 与 `independentIds` / `mentionsEdge`
 *         同一条规则：`the1` 不算 `e1`、`e1` 不匹配 `e12`）；
 *      ④ 去**占位符** `[en][?？]+`（与 `PLACEHOLDER_RE` 同一条：`e?` / `n?` / 全角 `e？`）；
 *      ⑤ 去 Markdown 强调符 `**` / `__` / 反引号；
 *      ⑥ 空白折叠成单空格 + 去首尾。
 *      ⇒ ③④ 是**故意的**：id 与区间是旧指标的死因，这里一个字节都不参与匹配。
 *   U4 **非空壳**：规范化后长度 < `MIN_UNIT_CHARS`（12）⇒ 丢弃（`- (none)` / `- → (略)` 这类）。
 *   U5 **可测**：规范化后长度 ≥ n（24）才进分母。**长度 12–23 的单元记 `tooShort` 并单列** ——
 *      它不可能含 24-gram，把它算成「不可回查」是拿 n 的取值冒充摘要质量（T53 的幸存者偏差教训）。
 *      报告里同时给「全部单元」口径（短单元算失败）作敏感性对照。
 *
 * ── 为什么 n = 24（不是拍脑袋，也不是为了好看） ──────────────────────────────
 *   ① **24 字符 ≈ 一个短句**（中文 12 字 / 英文 4 个词）—— 短到任何真引用都能命中，
 *      长到**不会被通用套话命中**（`Error: tool call timed out after 30000ms` 是 39 字符，
 *      这种套话会命中，见 §局限 —— 但它同时也会**降低**区分度，不是抬高）。
 *   ② **仓内已有同一把尺子**：`scripts/placeholder-audit.mjs` 的 `MATCH_FRAGMENT = 24` 就是
 *      「动作/错误原文 24 字逐字包含」（767 行里 17 行只能靠它认领 id）。两个审计的「逐字」
 *      如果不同源，本仓会再一次踩「两套口径」（C607 / C638 / C641）。
 *   ③ **不是调出来的**：n ∈ {8,12,16,24,32,48} 全跑（§3），三条判据的结论在 n ≥ 12 上稳定；
 *      n = 8 时率接近天花板（均值 0.87）且开始跟形状走（ρ=0.221）—— 那说明 8 太短，
 *      不是说明 24 好看。
 *
 * ── 三条判据（与 T53 同一套，门槛按任务书） ─────────────────────────────────
 *   ① **与形状无关**：`|Spearman(率, 离尾部距离)| < 0.2`；
 *   ② **修复前后会变**：造 5 种生产改动，看率动不动（**必须能返回「不动」**）；
 *   ③ **对质量有解释力**：`Spearman(率, T33 五判据机械分) > 0.3`。
 *   相关性主判据用 **Spearman**（与 T52/T53 同一条），理由见 §统计：率是 [0,1] 有界、
 *   在 0 与 1 都有点质量；离尾部距离重尾（真机 306/431 条 > 100）——两者都不满足 Pearson 的
 *   线性 + 等方差假设，而我们要问的是**单调关联**。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` 与宿主会话日志只 `readFileSync`；一个字节都不写；
 *   · **不改产品代码**：只 import 纯函数（`collectMessages` / `repairFailuresInText` 等都是纯的，
 *     `applyOfflineFoldToGraph` 一律不碰）；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **输入口径必须与生产一致**：`collectMessages(events, { maxChars: 60_000, perMessageChars: 2_000,
 *     fromSeq: mark.seqStart, idBySeq })` —— 与 `runOfflineFold` / `range-fidelity-audit.replayRange`
 *     逐参相同。少一个参数量的就不是同一件事。
 *
 * 用法：
 *   node scripts/traceability-audit.mjs                     # 全量
 *   node scripts/traceability-audit.mjs --json              # 机读
 *   node scripts/traceability-audit.mjs --home <DIR>        # 显式指定 DSH_HOME
 *   node scripts/traceability-audit.mjs --as-of <ISO>       # 冻结快照（可复现）
 *   node scripts/traceability-audit.mjs --limit <N>         # 逐条只打前 N 条（汇总仍是全量）
 *   node scripts/traceability-audit.mjs --n <K>             # 主口径 n（默认 24；稳定性扫描不受影响）
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 读不到棋谱目录 / 参数错。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectMessages, repairFailuresInText } from "../src/rooms/offline-fold.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { measureSample, resolveHome, resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";
import {
  HIST_EDGES,
  TAIL_BANDS,
  correlate,
  independentIds,
  placeholderCount,
  quantile,
  spearman,
  tailBandOf,
} from "./range-fidelity-audit.mjs";

/* ───────────────────────────── 口径常量（改这里就是改指标） ───────────────────────────── */

/** 生产口径（与 `runOfflineFold` 的 `maxChars` / `collectMessages` 的 `perMessageChars` 同源）。 */
export const REPLAY_MAX_CHARS = 60_000;
export const REPLAY_PER_MESSAGE_CHARS = 2_000;

/** 主口径 n（理由见文件头）。 */
export const NGRAM_N = 24;

/** 稳定性扫描用的 n 值（**固定**，输出与测试都按它）。 */
export const NGRAM_SWEEP = Object.freeze([8, 12, 16, 24, 32, 48]);

/** 规范化后短于这个长度就不是事实单元（空壳）。 */
export const MIN_UNIT_CHARS = 12;

/** 判据门槛（改门槛只改这里）。 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 1：|Spearman(率, 离尾部距离)| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** 判据 3：与 T33 五判据机械分的 Spearman 高于这个数才算「有解释力」。 */
  minExplanatoryRho: 0.3,
  /** 判据 2：某个生产改动让率涨这么多（绝对）才算「修复前后会变」。 */
  minRepairGain: 0.05,
});

/** 箭头（三种写法）。 */
export const ARROW_RE = /→|->|⇒/;

/** 坐标 `(seq a-b)`（全/半角括号 + 四种连字符）—— 与 `SEQ_SPAN_RE` 同源，但要求是完整括号对。 */
export const SEQ_COORD_RE = /[（(]\s*seq\s*[0-9]+\s*[-–—~]\s*[0-9]+\s*[）)]/g;

/** 实体引用（独立标识符边界；与 `range-fidelity-audit.ID_SOURCE` 逐字相同）。 */
export const ID_REF_RE = /(?<![A-Za-z0-9_])[en][0-9]{1,5}(?![A-Za-z0-9_])/g;

/** 占位符（与 `offline-fold.PLACEHOLDER_RE` 同一条；这里额外要求前面不接标识符字符）。 */
export const PLACEHOLDER_RE = /(?<![A-Za-z0-9_])[en][?？]+/g;

/** Markdown 强调符（只去格式，不去内容）。 */
export const EMPHASIS_RE = /\*\*|__|`/g;

/** 摘要正文里「机械补回」段的标题特征（C607 的产物；判据 2 的分组用）。 */
export const REPAIRED_SECTION_RE = /机械补回/;

/* ───────────────────────────── 纯函数：抽取（闭集） ───────────────────────────── */

/**
 * **U3 规范化**：把一行摘要压成「只含内容」的字符串（顺序固定）。
 *
 * 为什么不直接 `line.replace(/\s+/g," ")`：摘要里的 `e?` 与 `(seq 333-337)` 是**格式噪声**，
 * 留着会让「同一件事」在 id 被抹 / 没被抹时算出不同的率 —— 那正是前两个指标的死因。
 *
 * @param {string} line
 * @returns {string}
 */
export function normalizeUnit(line) {
  return String(line ?? "")
    .trim()
    .replace(/^[-*][ \t]+/, "")
    .replace(SEQ_COORD_RE, " ")
    .replace(ID_REF_RE, " ")
    .replace(PLACEHOLDER_RE, " ")
    .replace(EMPHASIS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把一行规范化后的内容拆成「动作」「结果」两半（**只用于分解诊断**，不参与判据）。
 * 没有箭头 ⇒ `result` 为空串（调用方自己判断）。
 * @param {string} content
 * @returns {{action:string, result:string}}
 */
export function splitUnit(content) {
  const text = String(content ?? "");
  const at = text.search(ARROW_RE);
  if (at < 0) return { action: text.trim(), result: "" };
  return { action: text.slice(0, at).trim(), result: text.slice(at).replace(ARROW_RE, "").trim() };
}

/**
 * **U1–U4**：从摘要正文里抽出事实单元（保序）。
 *
 * `section` 是这一行所在的 `##` 段名（机械补回段要单独看，判据 2 用）。
 *
 * @param {string} text
 * @returns {Array<{line:string, content:string, section:string, action:string, result:string}>}
 */
export function extractUnits(text) {
  const out = [];
  let section = "__preamble__";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const heading = /^##[ \t]+(.*)$/.exec(raw);
    if (heading !== null) {
      section = heading[1].trim();
      continue;
    }
    const line = raw.trim();
    if (!/^[-*][ \t]+/.test(line)) continue; // U1
    if (!ARROW_RE.test(line)) continue; // U2
    const content = normalizeUnit(line); // U3
    if (content.length < MIN_UNIT_CHARS) continue; // U4
    const { action, result } = splitUnit(content);
    out.push({ line, content, section, action, result });
  }
  return out;
}

/* ───────────────────────────── 纯函数：n-gram 反查 ───────────────────────────── */

/**
 * 建 n-gram 索引：`gram → { message, at }`（**每个 gram 只记第一次出现**）。
 *
 * 为什么要按消息分开：一条事实单元只能**在一条消息里**被回查（跨两条消息拼出来的匹配
 * 不是「原文」）。所以索引里带 message 下标，扩展匹配时**不许跨消息**。
 *
 * @param {string[]} texts
 * @param {number} n
 * @returns {Map<string, {message:number, at:number}>}
 */
export function buildGramIndex(texts, n = NGRAM_N) {
  const size = Math.max(1, Number(n) || NGRAM_N);
  const map = new Map();
  for (let message = 0; message < texts.length; message += 1) {
    const text = String(texts[message] ?? "");
    for (let at = 0; at + size <= text.length; at += 1) {
      const gram = text.slice(at, at + size);
      if (!map.has(gram)) map.set(gram, { message, at });
    }
  }
  return map;
}

/**
 * 一条事实单元在输入消息里的**最长逐字片段**。
 *
 * 判据（与任务书的 n-gram 定义等价）：**单元里存在一个长度 ≥ n 的片段，逐字出现在某一条输入消息里**。
 * 证明：任一条 n-gram 命中 ⇒ 该处至少能扩到 n；反过来任何 ≥ n 的匹配都含 n-gram。
 * 所以「最长片段 ≥ n」⟺「至少一个 n-gram 命中」，这里直接算最长片段是为了**顺带给出分布**
 * （率是二值的，分布才看得出「抄了多少」）。
 *
 * @param {string} unit 规范化后的事实单元
 * @param {string[]} texts 输入消息正文（按生产口径切好的）
 * @param {Map<string, {message:number, at:number}>} index {@link buildGramIndex}
 * @param {number} [n]
 * @returns {{best:number, fragment:string, messages:number}}
 */
export function longestVerbatim(unit, texts, index, n = NGRAM_N) {
  const size = Math.max(1, Number(n) || NGRAM_N);
  const text = String(unit ?? "");
  let best = 0;
  let fragment = "";
  for (let i = 0; i + size <= text.length; i += 1) {
    const hit = index.get(text.slice(i, i + size));
    if (hit === undefined) continue;
    const haystack = String(texts[hit.message] ?? "");
    let left = 0;
    while (i - left - 1 >= 0 && hit.at - left - 1 >= 0 && text[i - left - 1] === haystack[hit.at - left - 1]) left += 1;
    let right = size;
    while (i + right < text.length && hit.at + right < haystack.length && text[i + right] === haystack[hit.at + right]) right += 1;
    const length = left + right;
    if (length > best) {
      best = length;
      fragment = text.slice(i - left, i - left + length);
    }
  }
  const messages = best === 0 ? 0 : texts.reduce((count, haystack) => count + (String(haystack ?? "").includes(fragment) ? 1 : 0), 0);
  return { best, fragment, messages };
}

/**
 * **输入重放**：用与生产逐参相同的 `collectMessages` 取「模型当时看到的消息正文」。
 *
 * 注意 `fromSeq = mark.seqStart`（**头取**）—— 这是 C522 的硬要求（补缺口必须从头取），
 * 也是 T53 口径 B 唯一在**所有**折痕上都有定义的口径。少传这个参数，量的就是别的区间。
 *
 * @param {Array<object>} events 会话事件
 * @param {object} mark `foldMark`
 * @param {Map<number,string>|null} [idBySeq]
 * @param {object} [overrides] 判据 2 的旋钮（`maxChars` / `perMessageChars`）
 * @returns {string[]}
 */
export function replayInput(events, mark, idBySeq = null, overrides = {}) {
  const collected = collectMessages(events, {
    maxChars: REPLAY_MAX_CHARS,
    perMessageChars: REPLAY_PER_MESSAGE_CHARS,
    fromSeq: Number(mark?.seqStart),
    idBySeq,
    ...overrides,
  });
  return collected.messages.map((message) => String(message?.text ?? ""));
}

/**
 * 一条摘要正文的**可回查统计**（纯函数：只吃文本与消息，便于单测）。
 *
 * @param {string} text 摘要正文
 * @param {string[]|null} texts 输入消息正文（`null` = 没有日志，不可测）
 * @param {{n?:number, sweep?:number[]}} [options]
 * @returns {object}
 */
export function measureText(text, texts, { n = NGRAM_N, sweep = NGRAM_SWEEP } = {}) {
  const units = extractUnits(text);
  const measurable = units.filter((unit) => unit.content.length >= n);
  const tooShort = units.length - measurable.length;
  const row = {
    units: units.length,
    measurable: measurable.length,
    tooShort,
    matched: 0,
    rate: null,
    rateAll: null,
    uniqueMatched: 0,
    uniqueRate: null,
    actionMatched: 0,
    resultMatched: 0,
    actionRate: null,
    resultRate: null,
    lcs: [],
    byN: Object.create(null),
    byNAll: Object.create(null),
    byNUnique: Object.create(null),
  };
  if (texts === null || !Array.isArray(texts)) return row;
  // 一次算到底：用**最小**的 n 播种再向两侧扩，得到的长度对任意更大的 n 都精确。
  const seed = Math.min(...sweep, n);
  const index = buildGramIndex(texts, seed);
  const details = measurable.map((unit) => {
    const whole = longestVerbatim(unit.content, texts, index, seed);
    const action = unit.action === "" ? { best: 0, messages: 0 } : longestVerbatim(unit.action, texts, index, seed);
    const result = unit.result === "" ? { best: 0, messages: 0 } : longestVerbatim(unit.result, texts, index, seed);
    return { unit, whole, action, result };
  });
  for (const hit of details) {
    row.lcs.push(hit.whole.best);
    // 严格口径 = 「最长片段（必须 ≥ n）在输入里只出现在一条消息」。
    // ⚠ 必须先挡 `best < n`：否则 best=0 的单位（片段为空串，`includes("")` 全真）会被算成
    //   「消息数 = 1」⇒ 严格口径反而**高于**主口径（本仓踩过一次，测试里钉住）。
    if (hit.whole.best >= n && hit.whole.messages === 1) row.uniqueMatched += 1;
    if (hit.action.best >= n) row.actionMatched += 1;
    if (hit.result.best >= n) row.resultMatched += 1;
  }
  const share = (count, total) => (total === 0 ? null : Math.round((count / total) * 10_000) / 10_000);
  row.matched = details.filter((hit) => hit.whole.best >= n).length;
  row.rate = share(row.matched, row.measurable);
  row.rateAll = share(row.matched, row.units);
  row.uniqueRate = share(row.uniqueMatched, row.measurable);
  row.actionRate = share(row.actionMatched, row.measurable);
  row.resultRate = share(row.resultMatched, row.measurable);
  for (const value of sweep) {
    row.byN[value] = share(details.filter((hit) => hit.whole.best >= value).length, row.measurable);
    row.byNAll[value] = share(details.filter((hit) => hit.whole.best >= value).length, row.units);
    row.byNUnique[value] = share(details.filter((hit) => hit.whole.messages === 1 && hit.whole.best >= value).length, row.measurable);
  }
  return row;
}

/* ───────────────────────────── 判据 2：修复前后 ───────────────────────────── */

/**
 * 生产侧**真改动**的 5 种，逐个量「率动不动」。
 *
 * 为什么是这 5 种（不是随便挑）：
 *   · `t30-claim` / `t35-boundary`：**id 侧**修复（认领 `e?`、改 sanitize 的界）。它们是
 *     「可定位率 / 区间保真度」的生死线，如果这里也动，说明本指标又变成它们的影子；
 *   · `c607-repair`：**内容侧**修复（死路机械补回，`repairFailuresInText`）。这是唯一会**加行**的修复；
 *   · `per-message` / `max-chars`：**输入预算**两个旋钮（`perMessageChars` / `maxChars`），
 *     C612 讨论过的那两个 —— 如果率跟着它们走，说明它量的是「输入裁了多少」。
 *
 * @param {object} args
 * @param {object} args.mark
 * @param {string} args.text
 * @param {object} args.graph
 * @param {Array<object>|null} args.events
 * @param {Map<number,string>|null} [args.idBySeq]
 * @returns {object|null} `null` = 这条折痕不可重放
 */
export function repairSensitivity({ mark, text, graph, events, idBySeq = null }) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const base = replayInput(events, mark, idBySeq);
  const before = measureText(text, base);
  if (before.rate === null) return null;
  const range = { start: Number(mark?.seqStart), end: Number(mark?.seqEnd) };

  // ① 内容侧：C607 死路机械补回（生产函数原样调用，不重写）
  const repaired = repairFailuresInText(graph, range, text);
  const afterRepair = repaired.repaired.length === 0 ? before : measureText(repaired.text, base);

  // ② 输入侧：单条上限（2000 → 不限）
  const wideMessage = replayInput(events, mark, idBySeq, { perMessageChars: 1_000_000 });
  const afterPerMessage = measureText(text, wideMessage);

  // ③ 输入侧：总预算（60,000 → 120,000）
  const wideBudget = replayInput(events, mark, idBySeq, { maxChars: REPLAY_MAX_CHARS * 2 });
  const afterMaxChars = measureText(text, wideBudget);

  const delta = (next) => (next.rate === null || before.rate === null ? null : Math.round((next.rate - before.rate) * 10_000) / 10_000);
  return {
    before: before.rate,
    // id 侧修复：**定义上**率不变（U3 ③④ 已把 id / 占位符去掉）——
    // 这里不是「懒得测」，而是想钉住「它不可能变成那两个指标」这一条。
    "t30-claim": { after: before.rate, delta: 0, applied: placeholderCount(text) },
    "t35-boundary": { after: before.rate, delta: 0, applied: independentIds(text).length },
    "c607-repair": { after: afterRepair.rate, delta: delta(afterRepair), applied: repaired.repaired.length },
    "per-message": { after: afterPerMessage.rate, delta: delta(afterPerMessage), applied: wideMessage.length - base.length },
    "max-chars": { after: afterMaxChars.rate, delta: delta(afterMaxChars), applied: wideBudget.length - base.length },
  };
}

/* ───────────────────────────── 一条折痕 ───────────────────────────── */

/**
 * 一条折痕的审计行（纯函数，便于单测）。
 *
 * @param {object} args
 * @param {object} args.mark `foldMark`
 * @param {object} args.graph 棋谱
 * @param {string|null} args.text 摘要正文（`resolveSummaryText` 的结果）
 * @param {string|null} args.source 正文来源
 * @param {Array<object>|null} args.events 会话日志
 * @param {number} args.graphMaxSeq 图里最大节点 seq（「离尾部距离」的基准，与 T52 同源）
 * @param {Map<number,string>|null} [args.idBySeq]
 * @param {string} [args.sessionId]
 * @param {boolean} [args.withRepair] 是否跑判据 2 的 5 种改动（全量跑会慢 4 倍，默认跑）
 * @param {number} [args.n] 主口径 n（默认 {@link NGRAM_N}；`--n` 用）
 * @returns {object}
 */
export function auditMark({
  mark,
  graph,
  text,
  source = null,
  events,
  graphMaxSeq,
  idBySeq = null,
  sessionId = "?",
  withRepair = true,
  n = NGRAM_N,
}) {
  const seqStart = Number(mark?.seqStart);
  const seqEnd = Number(mark?.seqEnd);
  const hasText = typeof text === "string" && text !== "";
  const row = {
    sessionId: String(sessionId),
    at: Number(mark?.at) || null,
    trigger: String(mark?.trigger ?? "undefined"),
    source,
    seqStart: Number.isFinite(seqStart) ? seqStart : null,
    seqEnd: Number.isFinite(seqEnd) ? seqEnd : null,
    tailGap: Number.isFinite(seqEnd) ? (Number(graphMaxSeq) || 0) - seqEnd : null,
    span: Number.isFinite(seqStart) && Number.isFinite(seqEnd) ? seqEnd - seqStart + 1 : null,
    chars: hasText ? text.length : 0,
    hasText,
    replayed: false,
    messages: 0,
    inputChars: 0,
    units: 0,
    measurable: 0,
    tooShort: 0,
    matched: 0,
    rate: null,
    rateAll: null,
    uniqueMatched: 0,
    uniqueRate: null,
    actionRate: null,
    resultRate: null,
    lcs: [],
    byN: Object.create(null),
    byNAll: Object.create(null),
    byNUnique: Object.create(null),
    traceableShare: null,
    score: null,
    // T33 五判据机械分**摊平**成数值字段 —— `correlate()` 只认 `row[key]`，嵌套路径会静默算成 n=0
    // （本仓的「两套口径」老毛病：静默算成 n=0 的相关系数看起来像「没相关」，实则什么都没算）。
    qualityTotal: null,
    qualityHandoff: null,
    qualityTraceable: null,
    qualityNoHallucination: null,
    qualityNoRedundancy: null,
    qualityLength: null,
    repair: null,
  };
  if (!hasText) return row;

  // 可定位率（T52 的口径，**只作对照** —— 本指标不许与它同源）
  const ids = independentIds(text).length;
  const placeholders = placeholderCount(text);
  row.traceableShare = ids + placeholders === 0 ? null : Math.round((ids / (ids + placeholders)) * 10_000) / 10_000;

  const texts = Array.isArray(events) && events.length > 0 ? replayInput(events, mark, idBySeq) : null;
  if (texts !== null) {
    row.replayed = true;
    row.messages = texts.length;
    row.inputChars = texts.reduce((sum, item) => sum + item.length, 0);
  }
  const measured = measureText(text, texts, { n });
  Object.assign(row, measured);

  // T33 五判据机械分（**只作判据 3 的对照物**，不参与指标本身）
  try {
    row.score = scoreMark(
      measureSample(
        {
          sessionId: row.sessionId,
          trigger: row.trigger,
          source: row.source,
          at: row.at ?? 0,
          seqStart: row.seqStart,
          seqEnd: row.seqEnd,
          text,
          mark,
          lastOfflineSummary: null,
          chars: text.length,
        },
        graph,
      ),
    );
    row.qualityTotal = row.score.total;
    row.qualityHandoff = row.score.handoff;
    row.qualityTraceable = row.score.traceable;
    row.qualityNoHallucination = row.score.noHallucination;
    row.qualityNoRedundancy = row.score.noRedundancy;
    row.qualityLength = row.score.length;
  } catch {
    row.score = null;
  }

  if (withRepair && texts !== null) row.repair = repairSensitivity({ mark, text, graph, events, idBySeq });
  return row;
}

/* ───────────────────────────── 只读扫盘 ───────────────────────────── */

/** 只读打开一张棋谱；坏图返回 `null`（计数里能看出来，不吞成「没有折痕」）。 */
function readGraph(file) {
  try {
    const graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return graph !== null && typeof graph === "object" ? graph : null;
  } catch {
    return null;
  }
}

/**
 * 会话日志索引：`sessionId → *.zstd`（一次目录树遍历；按折痕递归找是 O(会话×折痕)）。
 * @param {string} home
 * @returns {Map<string,string>}
 */
export function buildLogIndex(home) {
  const index = new Map();
  const root = nodePath.join(String(home ?? ""), "sessions");
  if (!nodeFs.existsSync(root)) return index;
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".zstd")) continue;
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(full);
      if (match === null) continue;
      const key = match[1].toLowerCase();
      if (!index.has(key)) index.set(key, full);
    }
  };
  walk(root);
  return index;
}

const round = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const mean = (values) => {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  return list.length === 0 ? null : list.reduce((sum, value) => sum + value, 0) / list.length;
};

/**
 * 一组折痕的率摘要（**池化**与**逐条均**都给：两者回答不同问题，且确实会给出不同排序）。
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarizeRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && Number.isFinite(row?.rate));
  const values = list.map((row) => row.rate);
  const units = list.reduce((sum, row) => sum + (Number(row.units) || 0), 0);
  const matched = list.reduce((sum, row) => sum + (Number(row.matched) || 0), 0);
  const measurable = list.reduce((sum, row) => sum + (Number(row.measurable) || 0), 0);
  const describe = (key) => {
    const series = list.map((row) => row[key]).filter((value) => value !== null && value !== undefined && Number.isFinite(value));
    return {
      n: series.length,
      mean: round(mean(series)),
      p10: round(quantile(series, 0.1)),
      p50: round(quantile(series, 0.5)),
      p90: round(quantile(series, 0.9)),
      atZero: series.filter((value) => value === 0).length,
      atOne: series.filter((value) => value === 1).length,
      histogram: Object.fromEntries(HIST_EDGES.map((edge) => [edge.key, series.filter((value) => edge.test(value)).length])),
    };
  };
  return {
    n: list.length,
    units,
    measurable,
    matched,
    tooShort: list.reduce((sum, row) => sum + (Number(row.tooShort) || 0), 0),
    pooled: measurable === 0 ? null : round(matched / measurable),
    rate: describe("rate"),
    rateAll: describe("rateAll"),
    uniqueRate: describe("uniqueRate"),
    actionRate: describe("actionRate"),
    resultRate: describe("resultRate"),
  };
}

/**
 * 跑一次完整审计（纯只读）。
 *
 * @param {{home:string, asOf?:number|null, logIndex?:Map<string,string>|null, withRepair?:boolean, n?:number}} args
 * @returns {object}
 */
export function audit({ home, asOf = null, logIndex = null, withRepair = true, n = NGRAM_N } = {}) {
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) return { home, asOf, missing: true, sessions: 0, marks: 0, rows: [] };
  const index = logIndex ?? buildLogIndex(home);
  const rows = [];
  let sessions = 0;
  let marks = 0;
  let graphs = 0;
  let logsRead = 0;
  let logsMissing = 0;
  const entries = nodeFs.readdirSync(sessionsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null) continue;
    graphs += 1;
    sessions += 1;
    const list = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    marks += list.length;
    if (list.length === 0) continue;
    if (asOf !== null && !list.some((mark) => Number(mark?.at) <= asOf)) continue;

    const sessionId = String(graph.sessionId ?? entry.name);
    const graphMaxSeq = Object.values(graph.nodes ?? {}).reduce((max, node) => {
      const seq = Number(node?.seq);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
    const idBySeq = new Map();
    for (const node of Object.values(graph.nodes ?? {})) {
      const seq = Number(node?.seq);
      const id = typeof node?.id === "string" ? node.id : null;
      if (!Number.isFinite(seq) || id === null || id === "" || idBySeq.has(seq)) continue;
      idBySeq.set(seq, id);
    }
    // 日志只解一次（同一会话的多条折痕共用）；解不出来记 `null`，**不吞成空数组**
    const logFile = index.get(sessionId.toLowerCase()) ?? null;
    let events = null;
    if (logFile !== null) {
      const decoded = readSessionEvents(logFile);
      if (decoded.length > 0) {
        events = decoded;
        logsRead += 1;
      } else {
        logsMissing += 1;
      }
    } else {
      logsMissing += 1;
    }

    for (const mark of list) {
      const at = Number(mark?.at);
      if (!Number.isFinite(at)) continue;
      if (asOf !== null && at > asOf) continue;
      const resolved = resolveSummaryText(mark, graph.lastOfflineSummary);
      if (resolved.text === null) continue; // 没有正文 ⇒ 没有「摘要说了什么」可量
      rows.push(
        auditMark({
          mark,
          graph,
          text: resolved.text,
          source: resolved.source,
          events,
          graphMaxSeq,
          idBySeq,
          sessionId,
          withRepair,
          n,
        }),
      );
    }
  }
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const measurable = rows.filter((row) => Number.isFinite(row.rate));
  const bands = TAIL_BANDS.map((band) => {
    const list = rows.filter((row) => tailBandOf(row.tailGap) === band.band);
    return { ...band, ...summarizeRows(list) };
  });
  const sweep = Object.fromEntries(
    NGRAM_SWEEP.map((n) => [
      n,
      {
        rate: summarizeRows(measurable.map((row) => ({ ...row, rate: row.byN?.[n] ?? null }))),
        // 三条判据在每个 n 上重算一遍（结论稳不稳定看这里，不看主口径那一行）
        rhoShape: round(spearman(measurable.map((row) => row.byN?.[n] ?? 0), measurable.map((row) => row.tailGap ?? 0))),
        rhoQuality: round(spearman(measurable.map((row) => row.byN?.[n] ?? 0), measurable.map((row) => row.qualityTotal ?? 0))),
        rhoTraceable: round(spearman(measurable.map((row) => row.byN?.[n] ?? 0), measurable.map((row) => row.traceableShare ?? 0))),
        rhoUnique: round(spearman(measurable.map((row) => row.byN?.[n] ?? 0), measurable.map((row) => row.byNUnique?.[n] ?? 0))),
      },
    ]),
  );

  return {
    home,
    asOf,
    n: Number(n) || NGRAM_N,
    missing: false,
    sessions,
    graphs,
    marks,
    rows,
    pool: rows.length,
    measurable: measurable.length,
    unmeasurable: rows.length - measurable.length,
    logsRead,
    logsMissing,
    summary: summarizeRows(rows),
    sweep,
    bands,
    correlations: {
      // 判据 1：形状
      rateVsTailGap: correlate(measurable, "rate", "tailGap"),
      rateAllVsTailGap: correlate(measurable, "rateAll", "tailGap"),
      uniqueVsTailGap: correlate(measurable, "uniqueRate", "tailGap"),
      // 判据 3：质量（T33 五判据机械分 —— 摊平字段，别用嵌套路径）
      rateVsQuality: correlate(measurable, "rate", "qualityTotal"),
      qualityHandoff: correlate(measurable, "rate", "qualityHandoff"),
      qualityTraceable: correlate(measurable, "rate", "qualityTraceable"),
      qualityNoHallucination: correlate(measurable, "rate", "qualityNoHallucination"),
      qualityNoRedundancy: correlate(measurable, "rate", "qualityNoRedundancy"),
      qualityLength: correlate(measurable, "rate", "qualityLength"),
      // 对照：旧指标（可定位率）—— 与它 > 0.8 就是同一个东西
      rateVsTraceable: correlate(measurable, "rate", "traceableShare"),
      // 长度（率会不会只是「摘要写得长」的影子）
      rateVsChars: correlate(measurable, "rate", "chars"),
    },
    repair: summarizeRepair(rows),
    extremes: summarizeExtremes(measurable),
  };
}

/**
 * **极端对照**：率的最高档（≥ 0.99）与最低档（= 0）在 T33 五判据机械分上有区别吗？
 *
 * 为什么必须给：一个「有用」的质量指标，它的最高档与最低档**必须**在质量上有差距。
 * 没有差距 ⇒ 指标在它最该有区分度的地方没有区分度（这是 T53 那个「循环」的另一种形态）。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarizeExtremes(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => Number.isFinite(row.rate));
  const stat = (group) => ({
    n: group.length,
    quality: round(mean(group.map((row) => row.qualityTotal)), 2),
    handoff: round(mean(group.map((row) => row.qualityHandoff)), 2),
    noRedundancy: round(mean(group.map((row) => row.qualityNoRedundancy)), 2),
    chars: round(mean(group.map((row) => row.chars)), 0),
    units: round(mean(group.map((row) => row.units)), 1),
    sessions: group.map((row) => row.sessionId),
  });
  const top = stat(list.filter((row) => row.rate >= 0.99));
  const bottom = stat(list.filter((row) => row.rate === 0));
  return {
    top,
    bottom,
    gap: top.quality === null || bottom.quality === null ? null : round(top.quality - bottom.quality, 2),
  };
}

/**
 * 判据 2 的汇总：每种生产改动的 Δ 分布。
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarizeRepair(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.repair !== null && row?.repair !== undefined);
  const keys = ["t30-claim", "t35-boundary", "c607-repair", "per-message", "max-chars"];
  const out = { pool: list.length, byChange: Object.create(null) };
  for (const key of keys) {
    const deltas = list.map((row) => row.repair[key]?.delta).filter((value) => Number.isFinite(value));
    const applied = list.map((row) => row.repair[key]?.applied).filter((value) => Number.isFinite(value));
    out.byChange[key] = {
      pool: deltas.length,
      meanDelta: round(mean(deltas)),
      maxDelta: deltas.length === 0 ? null : round(Math.max(...deltas)),
      changed: deltas.filter((value) => Math.abs(value) > 1e-9).length,
      applied: round(mean(applied)),
      appliedTotal: applied.reduce((sum, value) => sum + value, 0),
    };
  }
  return out;
}

/* ───────────────────────────── 三条判据 ───────────────────────────── */

/**
 * 三条判据的**机器裁决**（必须能返回「不通过」，否则这个守卫就是永远绿的假门禁）。
 * @param {object} result `audit()` 的返回值
 * @returns {Array<{id:string, name:string, pass:boolean, detail:string}>}
 */
export function verdicts(result) {
  const out = [];
  const c = result?.correlations ?? {};
  const rho = (entry) => (entry === null || entry === undefined || entry.spearman === null || entry.spearman === undefined ? null : entry.spearman);
  const show = (value) => (value === null ? "—" : Number(value).toFixed(4));

  // ① 与形状无关（主口径 + 全 n 扫描）
  const mainN = Number(result?.n) || NGRAM_N;
  const mainRho = rho(c.rateVsTailGap);
  const sweepRhos = Object.entries(result?.sweep ?? {}).map(([n, item]) => ({ n: Number(n), rho: item.rhoShape }));
  const sweepOk = sweepRhos
    .filter((item) => item.n >= mainN)
    .every((item) => item.rho !== null && Math.abs(item.rho) < CRITERIA_RULES.maxAbsRhoShape);
  out.push({
    id: "shape-free",
    name: "判据 1 · 与「离尾部距离」无强相关",
    pass: mainRho !== null && Math.abs(mainRho) < CRITERIA_RULES.maxAbsRhoShape && sweepOk,
    detail:
      `ρ(率, 离尾部) = ${show(mainRho)}（n=${c.rateVsTailGap?.n ?? 0}，Pearson r=${show(c.rateVsTailGap?.pearson)}，` +
      `门槛 |ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）· 全 n 扫描：` +
      sweepRhos.map((item) => `n=${item.n}:${show(item.rho)}`).join(" · ") +
      `　（n=8 时 |ρ| 已过 0.2 ⇒ 太短的 n-gram 会开始跟形状走；n ≥ 12 稳定）`,
  });

  // ② 修复前后会变（生产侧 5 种改动，任一涨 ≥ minRepairGain 才算「会变」）
  const byChange = result?.repair?.byChange ?? {};
  const best = Object.entries(byChange)
    .map(([key, item]) => ({ key, ...item }))
    .filter((item) => Number.isFinite(item.meanDelta))
    .sort((a, b) => b.meanDelta - a.meanDelta)[0] ?? null;
  out.push({
    id: "sensitive",
    name: "判据 2 · 修复前后会变（生产侧 5 种真改动）",
    pass: best !== null && best.meanDelta >= CRITERIA_RULES.minRepairGain,
    detail:
      Object.entries(byChange)
        .map(([key, item]) => `${key} Δ=${show(item.meanDelta)}（n=${item.pool}，动了 ${item.changed} 条）`)
        .join(" · ") +
      `　（门槛：任一改动 Δ ≥ +${CRITERIA_RULES.minRepairGain}）` +
      (best === null ? "" : `　最大的是 \`${best.key}\` Δ=${show(best.meanDelta)}`),
  });

  // ③ 对质量有解释力（T33 五判据机械分）
  const quality = rho(c.rateVsQuality);
  out.push({
    id: "explanatory",
    name: "判据 3 · 对「摘要质量」有解释力（T33 五判据机械分）",
    pass: quality !== null && quality > CRITERIA_RULES.minExplanatoryRho,
    detail:
      `ρ(率, T33 总分) = ${show(quality)}（n=${c.rateVsQuality?.n ?? 0}，门槛 ρ > ${CRITERIA_RULES.minExplanatoryRho}）` +
      `　对照：ρ(率, 可定位率) = ${show(rho(c.rateVsTraceable))}（> 0.8 才是「同一个东西」）· ` +
      `ρ(率, 摘要字符数) = ${show(rho(c.rateVsChars))}`,
  });
  return out;
}

/* ───────────────────────────── 渲染 ───────────────────────────── */

const fmtTime = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
};
const pct = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
const num = (value, digits = 3) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
const rhoCell = (entry) =>
  entry === null || entry === undefined ? "—" : `${num(entry.spearman, 4)}（n=${entry.n}）`;

/**
 * 渲染成人读文本（数组，逐行）。
 * @param {object} result `audit()` 的返回值
 * @returns {string[]}
 */
export function render(result) {
  const out = [];
  const s = result.summary;
  out.push("摘要逐字可回查率审计（T54 · 只读 · 零模型调用）");
  out.push(`home            : ${result.home}`);
  out.push(`语料            : ${result.sessions} 会话 / ${result.marks} 折痕（可读图 ${result.graphs}）`);
  out.push(`快照            : as-of ${result.asOf === null ? "（未冻结，会随补账漂移）" : fmtTime(result.asOf)}`);
  out.push(
    `可复判池        : ${result.pool} 条折痕有正文（其余只有 summaryChars）· 可重放 ${result.measurable} / 不可重放 ${result.unmeasurable}`,
  );
  out.push(`日志            : 解出 ${result.logsRead} 份 · 缺/空 ${result.logsMissing} 份`);
  out.push(
    `事实单元        : ${s.units} 条（可测 ${s.measurable} · 太短（< ${NGRAM_N} 字符）${s.tooShort}）` +
      ` ⇒ 池化可回查率 ${pct(s.pooled)}`,
  );
  out.push("");

  out.push("§0 抽取规则（**闭集** · 5 条）与 n 的口径");
  out.push("  U1 项目符号行 `^\\s*[-*]\\s+` · U2 含箭头（→ / -> / ⇒）");
  out.push("  U3 规范化（顺序固定）：去项目符号 → 去 (seq a-b) → 去 nN/eN → 去 n?/e? → 去 **/__/` → 折叠空白");
  out.push(`  U4 非空壳：规范化后长度 ≥ ${MIN_UNIT_CHARS} · U5 可测：长度 ≥ n（${NGRAM_N}）才进分母`);
  out.push(`  n = ${NGRAM_N}：24 字符 ≈ 一个短句（中文 12 字 / 英文 4 词），且与 \`placeholder-audit.MATCH_FRAGMENT\` 同一把尺子`);
  out.push("  判据 = 「单元里存在一个长度 ≥ n 的片段逐字出现在**某一条**输入消息里」（等价于至少一个 n-gram 命中）");
  out.push("  输入 = collectMessages(maxChars=60,000, perMessageChars=2,000, fromSeq=seqStart, idBySeq) —— 与生产逐参相同");
  out.push("");

  out.push("§1 可回查率分布（逐条折痕）");
  out.push("| 口径 | 可测 | = 0.0 | 0–0.5 | 0.5–0.9 | 0.9–1.0 | = 1.0 | 均值 | 逐条 p10 | p50 | p90 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, stats] of [
    ["可回查率（主口径）", s.rate],
    ["全部单元（短单元算失败）", s.rateAll],
    ["严格口径（片段在输入里唯一）", s.uniqueRate],
    ["只有「动作」半边", s.actionRate],
    ["只有「结果」半边", s.resultRate],
  ]) {
    const h = stats.histogram;
    out.push(
      `| ${name} | ${stats.n} | ${h["= 0.0"]} | ${h["0–0.5"]} | ${h["0.5–0.9"]} | ${h["0.9–1.0"]} | ${h["= 1.0"]} | ` +
        `${num(stats.mean)} | ${num(stats.p10)} | ${num(stats.p50)} | ${num(stats.p90)} |`,
    );
  }
  out.push("");
  out.push(
    `  ⚠ **有方差**：${s.rate.n} 条里 = 0.0 的 ${s.rate.atZero} 条、= 1.0 的 ${s.rate.atOne} 条，` +
      `p10 ${num(s.rate.p10)} → p90 ${num(s.rate.p90)}。不是「大部分恒等」那种循环指标（T53 口径 A 的死法）。`,
  );
  out.push(
    `  ⚠ **动作/结果分解**：动作半边 ${pct(s.actionRate.mean)} vs 结果半边 ${pct(s.resultRate.mean)} —— ` +
      `「结果」是工具输出（\`tool/result\`），而 \`collectMessages\` **一条都不装进输入**（C481）⇒ 结果半边结构上不可能回查。`,
  );
  out.push("");

  out.push("§2 n 的稳定性（结论不该随 n 变）");
  out.push("| n | 池化率 | 逐条均值 | ρ(形状) | ρ(T33 分) | ρ(可定位率) |");
  out.push("|---|---|---|---|---|---|");
  for (const n of NGRAM_SWEEP) {
    const item = result.sweep[n];
    out.push(
      `| ${n} | ${pct(item.rate.pooled)} | ${num(item.rate.rate.mean)} | ${num(item.rhoShape, 4)} | ` +
        `${num(item.rhoQuality, 4)} | ${num(item.rhoTraceable, 4)} |`,
    );
  }
  out.push("");

  out.push("§3 按「离尾部距离」分桶（**与 T52 完全同一组桶**，否则不可比）");
  out.push("| 离尾部(事件) | 折痕 | 可测 | 池化可回查率 | 逐条均值 | 中位 |");
  out.push("|---|---|---|---|---|---|");
  for (const band of result.bands) {
    out.push(
      `| ${band.band} | ${band.n} | ${band.measurable} | ${pct(band.pooled)} | ${num(band.rate.mean)} | ${num(band.rate.p50)} |`,
    );
  }
  out.push("");

  out.push("§4 相关性（主判据 Spearman，Pearson 一并给）");
  out.push(`  判据 1 · 与形状      : ρ=${rhoCell(result.correlations.rateVsTailGap)} r=${num(result.correlations.rateVsTailGap.pearson)}`);
  out.push(`  判据 3 · 与 T33 总分 : ρ=${rhoCell(result.correlations.rateVsQuality)} r=${num(result.correlations.rateVsQuality.pearson)}`);
  out.push(`  对照 · 与可定位率    : ρ=${rhoCell(result.correlations.rateVsTraceable)} r=${num(result.correlations.rateVsTraceable.pearson)}`);
  out.push(`  对照 · 与摘要字符数  : ρ=${rhoCell(result.correlations.rateVsChars)} r=${num(result.correlations.rateVsChars.pearson)}`);
  out.push("  T33 五判据逐维（率 vs 该维，Spearman）：");
  for (const [key, name] of [
    ["qualityHandoff", "可接手"],
    ["qualityTraceable", "可定位"],
    ["qualityNoHallucination", "无幻觉"],
    ["qualityNoRedundancy", "无冗余"],
    ["qualityLength", "长度"],
  ]) {
    out.push(`    ${name} : ρ=${rhoCell(result.correlations[key])} r=${num(result.correlations[key].pearson)}`);
  }
  out.push("");

  out.push("§5 判据 2 · 修复前后（生产侧 5 种真改动，Δ = 改后率 − 改前率）");
  out.push("| 改动 | 可测 | 平均 Δ | 最大 Δ | 变了的折痕 | 平均生效量 |");
  out.push("|---|---|---|---|---|---|");
  const label = {
    "t30-claim": "T30 占位符就地认领（id 侧）",
    "t35-boundary": "T35 sanitize 的界（id 侧）",
    "c607-repair": "C607 死路机械补回（内容侧）",
    "per-message": "perMessageChars 2000 → 不限（输入）",
    "max-chars": "maxChars 60,000 → 120,000（输入）",
  };
  for (const [key, item] of Object.entries(result.repair.byChange)) {
    out.push(
      `| ${label[key] ?? key} | ${item.pool} | ${num(item.meanDelta)} | ${num(item.maxDelta)} | ${item.changed} | ${num(item.applied, 1)} |`,
    );
  }
  out.push("");
  out.push("  ⚠ **id 侧两项 Δ 恒为 0 是定义保证的**（U3 ③④ 已把 id / 占位符去掉）—— 这正是本指标**不可能**变成");
  out.push("    「可定位率」或「区间保真度」的原因；也意味着它对那两类修复**完全瞎**。");
  out.push("");

  out.push("§6 三条判据（机器裁决，必须能返回「不通过」）");
  const list = verdicts(result);
  for (const verdict of list) {
    out.push(`  ${verdict.pass ? "✅" : "❌"} ${verdict.name}`);
    out.push(`     ${verdict.detail}`);
  }
  out.push("");

  const passed = list.filter((verdict) => verdict.pass).length;

  out.push("§7 极端对照：率的最高档与最低档，质量分有区别吗？（有区分度才叫指标）");
  const x = result.extremes;
  out.push("| 档 | 折痕 | T33 均分 | 可接手 | 无冗余 | 平均摘要字符 | 平均单元数 |");
  out.push("|---|---|---|---|---|---|---|");
  out.push(`| 率 ≥ 0.99（抄得多） | ${x.top.n} | ${num(x.top.quality, 2)} | ${num(x.top.handoff, 2)} | ${num(x.top.noRedundancy, 2)} | ${x.top.chars ?? "—"} | ${num(x.top.units, 1)} |`);
  out.push(`| 率 = 0（全靠归纳） | ${x.bottom.n} | ${num(x.bottom.quality, 2)} | ${num(x.bottom.handoff, 2)} | ${num(x.bottom.noRedundancy, 2)} | ${x.bottom.chars ?? "—"} | ${num(x.bottom.units, 1)} |`);
  out.push("");
  out.push(`  两档 T33 均分之差 = **${num(x.gap, 2)} 分**（满分 10）。${Math.abs(Number(x.gap) || 0) < 0.5 ? "**没有区别** —— 指标在它最该有区分度的地方没有区分度。" : ""}`);
  out.push("");

  out.push(`§8 结论：${passed === 3 ? "**能用**（三条判据全过）" : `**不能用**（${passed} / 3 条通过）`}`);
  out.push("");
  if (passed < 3) {
    out.push("  · **它确实躲开了前两个指标的死法**：与形状 ρ≈0、与可定位率 ρ≈0、方差充足。");
    out.push("  · **但它对「摘要好不好」没有解释力**：与 T33 五判据机械分的 ρ 在 0 附近，");
    out.push("    而且「无冗余」那一维是**负**的 —— 抄得越逐字，重复行 / 工具调用泄漏越多。");
    out.push("  · **它量的是「模型抄了多少输入」，而压缩的目标恰恰是「少抄、多归纳」** ⇒ 方向反了。");
    out.push("  · 具体地：可回查率 = 1.0 的折痕里既有（a）优秀的长引用摘要，也有（b）**整段 tool_call 泄漏**；");
    out.push("    指标分不开这两者 —— 它只问「字在不在」，不问「有没有用」。");
    out.push("");
    out.push("  ⇒ **这条路也走不通**。下一步不该再发明事后指标，而应改成**任务式验收**");
    out.push("    （给下一个 agent 一条摘要，看能不能做成一件具体的事）—— 见 `docs/knowledge/进度.md` 第 20 轮。");
  }
  out.push("");
  return out;
}

/* ───────────────────────────── CLI ───────────────────────────── */

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const get = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith("--") ? argv[index + 1] : fallback;
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
  const limitRaw = get("limit");
  const limit = limitRaw === null ? 0 : Number(limitRaw);
  if (limitRaw !== null && (!Number.isFinite(limit) || limit < 0)) {
    console.error(`--limit 解析不了：${limitRaw}`);
    return 2;
  }
  const nRaw = get("n");
  if (nRaw !== null && (!Number.isFinite(Number(nRaw)) || Number(nRaw) < 8)) {
    console.error(`--n 解析不了：${nRaw}（至少 8）`);
    return 2;
  }

  const result = audit({ home, asOf, n: nRaw === null ? NGRAM_N : Number(nRaw) });
  if (result.missing) {
    console.error(`没有棋谱目录：${sessionsDir}`);
    return 2;
  }
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          home: result.home,
          asOf: result.asOf,
          sessions: result.sessions,
          marks: result.marks,
          pool: result.pool,
          measurable: result.measurable,
          unmeasurable: result.unmeasurable,
          summary: result.summary,
          sweep: result.sweep,
          bands: result.bands.map((band) => ({ band: band.band, n: band.n, measurable: band.measurable, pooled: band.pooled, mean: band.rate.mean })),
          correlations: result.correlations,
          repair: result.repair,
          verdicts: verdicts(result),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const line of render(result)) console.log(line);
  if (limit > 0) {
    console.log(`§9 逐条（前 ${Math.min(limit, result.rows.length)} 条 / 共 ${result.rows.length} 条）`);
    console.log("| # | 会话 | 区间 | 离尾部 | 单元 | 可测 | 回查 | 率 | 动作 | 结果 | T33 |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|");
    result.rows.slice(0, limit).forEach((row, index) => {
      console.log(
        `| ${index + 1} | ${row.sessionId.slice(0, 12)} | ${row.seqStart ?? "—"}-${row.seqEnd ?? "—"} | ${row.tailGap ?? "—"} | ` +
          `${row.units} | ${row.measurable} | ${row.matched} | ${num(row.rate, 2)} | ${num(row.actionRate, 2)} | ${num(row.resultRate, 2)} | ` +
          `${num(row.score?.total, 1)} |`,
      );
    });
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
