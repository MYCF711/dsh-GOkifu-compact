/**
 * traceability.test.mjs —— 「摘要逐字可回查率」守卫（T54）
 *
 * 由来（Lead 在 T53 判死两个候选指标之后立的单）：
 *   「第三个候选：**摘要正文的逐字可回查率** —— 把摘要里每条「动作 → 结果」按 n-gram
 *    反查到折叠输入的**消息原文**（不看 id、不看区间）；不被 sanitize 截断，也不依赖折痕折在哪。」
 *   硬话：「**先算再下结论**：三条判据全过才叫能用。」「失败分支必须真红。」
 *
 * 这个文件钉住的**不是**「率算得对不对」，而是**它能不能当质量指标**。结论是不能
 * （`node scripts/traceability-audit.mjs` 原样输出见报告），不能的方式很具体：
 *
 *   ① **它确实躲开了前两个指标的死法**：与「离尾部距离」ρ≈0.05、与可定位率 ρ≈0.03、
 *      方差充足（p10 0.11 / p50 0.35 / p90 0.74）。这两条是**定义**保证的 ——
 *      U3 ③④ 把 `nN`/`eN`/`n?`/`(seq a-b)` 全去掉了，所以它**不可能**变成那两个指标。
 *   ② **但它对「摘要好不好」没有解释力**：与 T33 五判据机械分 ρ≈−0.03（门槛 > 0.3），
 *      而且「无冗余」那一维是**负**的（ρ≈−0.30）—— 抄得越逐字，重复行 / 工具调用泄漏越多。
 *   ③ **率的最高档与最低档质量分没有区别**（7.91 vs 7.86）⇒ 指标在最该有区分度的地方没有区分度。
 *   ④ **生产侧 5 种真改动没有一种能让它涨 ≥ 5pp**（最大 `perMessageChars` +0.74pp）⇒ 对代码不敏感。
 *
 * 不变量（本文件钉住）：
 *   · **抽取是闭集**：U1 项目符号 / U2 箭头 / U3 六步规范化 / U4 非空壳 / U5 可测（≥ n）；
 *   · **n-gram 不跨消息**：匹配必须在**某一条**输入消息里（跨两条拼出来的不是「原文」）；
 *   · **id 无关**：`e3` 与 `e?` 给出**同一个率**（这是「不循环」的判据）；
 *   · **太短的单元不进分母**（否则是拿 n 的取值冒充摘要质量 —— T53 的幸存者偏差教训）；
 *   · **三条判据的裁决必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import {
  CRITERIA_RULES,
  MIN_UNIT_CHARS,
  NGRAM_N,
  NGRAM_SWEEP,
  audit,
  auditMark,
  buildGramIndex,
  extractUnits,
  longestVerbatim,
  measureText,
  normalizeUnit,
  replayInput,
  repairSensitivity,
  splitUnit,
  summarizeExtremes,
  verdicts,
} from "../scripts/traceability-audit.mjs";

export const tests = {};

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 一条 user/assistant 消息（`collectMessages` 只认这两种 type 的文本）。 */
const msg = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
/** 一次工具调用（`collectMessages` 把它压成一行 `→ name(args)`）。 */
const toolCall = (seq, name, args) => ({ type: "tool/call", seq, data: { name, arguments: JSON.stringify(args) } });
/** 一条工具结果（`collectMessages` **一条都不装进输入** —— C481）。 */
const toolResult = (seq, text) => ({ type: "tool/result", seq, data: { content: [{ type: "text", text }] } });

/** 一张最小棋谱：节点 n1..n5 + 一条失败边 e3（evidence 12-14）。 */
function makeGraph() {
  const nodes = Object.create(null);
  for (const [seq, id] of [
    [10, "n1"],
    [20, "n2"],
    [30, "n3"],
    [40, "n4"],
    [50, "n5"],
  ]) {
    nodes[id] = { id, seq, kind: "assistant" };
  }
  const edges = {
    e3: {
      id: "e3",
      from: "n1",
      to: "n2",
      result: "failure",
      evidence: { start: 12, end: 14 },
      intent: "edit(file_path=foo.md)",
      errorSnippet: "Error: cannot modify foo.md",
      action: "edit(file_path=foo.md)",
    },
  };
  return { nodes, edges, foldMarks: [], order: [] };
}

/** 一条摘要正文：4 条可测单元 + 1 条太短（12–23 字符）+ 1 行非单元。 */
const SUMMARY = [
  "## 目标",
  "在隔离仓里做一件事（这行没有箭头，不是事实单元）。",
  "",
  "## 棋谱（状态节点）",
  "- n1 读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现 → 确认只认 user/assistant 消息",
  "- n2 跑 node test/run.mjs → 全量通过",
  "- n3 读取配置文件并确认 → 通过",
  "",
  "## 已探明死路",
  '- e3 "edit(file_path=foo.md)" → Error: cannot modify foo.md (seq 12-14)',
  '- e? "bash(command=rm -rf /tmp/x)" → Error: tool call timed out after 30000ms (seq 15-17)',
  "",
  "## 未验证",
  "- 还没有验证 → (略)",
].join("\n");

/** 输入消息：只包含「动作」侧的两段原文；工具结果（错误原文）**不在**输入里。 */
function sessionEvents() {
  return [
    { type: "step/start", seq: 1, data: {} },
    msg(10, "读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现"),
    toolResult(14, "Error: cannot modify foo.md"),
    toolCall(15, "bash", { command: "rm -rf /tmp/x" }),
    toolResult(17, "Error: tool call timed out after 30000ms"),
    msg(20, "跑 node test/run.mjs"),
    msg(30, "读取配置文件并确认"),
    msg(50, "另一个完全无关的消息，用来验证不跨消息匹配。"),
  ];
}

/* ───────────────────────────── ① 抽取规则（闭集） ───────────────────────────── */

tests["T54 口径常量：n = 24（≈ 一个短句，且与 placeholder-audit.MATCH_FRAGMENT 同一把尺子）"] = (t) => {
  t.eq(NGRAM_N, 24, "主口径 n 写死 24：24 字符 ≈ 中文 12 字 / 英文 4 个词");
  t.eq(MIN_UNIT_CHARS, 12, "空壳门槛 12（短于它的不是事实单元）");
  t.eq([...NGRAM_SWEEP], [8, 12, 16, 24, 32, 48], "稳定性扫描的 n 值固定");
  t.eq(CRITERIA_RULES.maxAbsRhoShape, 0.2, "判据 1 门槛：|ρ| < 0.2（任务书）");
  t.eq(CRITERIA_RULES.minExplanatoryRho, 0.3, "判据 3 门槛：ρ > 0.3（任务书）");
  t.eq(CRITERIA_RULES.minRepairGain, 0.05, "判据 2 门槛：≥ 5pp（20 单元里翻 1 条 = 5pp，小于它无法与噪声区分）");
};

tests["T54 U1/U2：只认「项目符号 + 箭头」的行（叙述、标题、无箭头行一律不是单元）"] = (t) => {
  const units = extractUnits(SUMMARY);
  t.eq(units.length, 5, "5 条项目符号行（`- 还没有验证 → (略)` 规范化后 < 12 ⇒ 不是单元）");
  t.eq(units.map((unit) => unit.section), ["棋谱（状态节点）", "棋谱（状态节点）", "棋谱（状态节点）", "已探明死路", "已探明死路"], "段名逐条跟着最近的 ## 走");
  t.eq(
    extractUnits("- 没有箭头的一行\n* 也没有箭头\n正文 → 不是项目符号\n## 标题 → 也不是单元").map((unit) => unit.content),
    [],
    "没有项目符号 / 没有箭头 ⇒ 一条都不抽",
  );
  t.eq(extractUnits("* 星号项目符号也算 → 结果").length, 1, "`*` 与 `-` 等价");
  t.eq(extractUnits("  - 缩进的项目符号也算 → 结果").length, 1, "缩进不影响（trim 之后按 U1 判）");
};

tests["T54 U3 规范化（6 步，顺序固定）：坐标 / 实体 / 占位符 / 强调符 / 空白"] = (t) => {
  t.eq(
    normalizeUnit('- e3 "动作" → 结果 (seq 12-14)'),
    '"动作" → 结果',
    "去项目符号 + 去半角括号坐标",
  );
  t.eq(normalizeUnit("- e3 动作 → 结果（seq 12–14）"), "动作 → 结果", "全角括号 + en dash 也去");
  t.eq(normalizeUnit("- e3 动作 → 结果 (seq 12—14)"), "动作 → 结果", "em dash 也去");
  t.eq(normalizeUnit("- e3 动作 → 结果 (seq 12~14)"), "动作 → 结果", "波浪号也去");
  t.eq(normalizeUnit("- n3634 与 e9442 → 结果"), "与 → 结果", "5 位编号（真机已有 n3634）必须认");
  t.eq(normalizeUnit("- the1 与 e12 → 结果"), "the1 与 → 结果", "`the1` 不算 `e1`（前置边界）");
  t.eq(normalizeUnit("- e1 与 e12 → 结果"), "与 → 结果", "`e1` 与 `e12` 各自独立匹配（后置边界）");
  t.eq(normalizeUnit("- e? 与 n？ → 结果"), "与 → 结果", "半角 + 全角占位符都去");
  t.eq(normalizeUnit("- **n1** 读了 `x.mjs` → **通过**"), "读了 x.mjs → 通过", "** / ` 只去格式、不去内容");
  t.eq(normalizeUnit("-   a   →    b  "), "a → b", "空白折叠 + 去首尾");
  t.eq(splitUnit("动作 → 结果"), { action: "动作", result: "结果" }, "按箭头拆两半（分解诊断用）");
  t.eq(splitUnit("只有动作"), { action: "只有动作", result: "" }, "没有箭头 ⇒ 结果为空串");
};

tests["T54 U4/U5：空壳丢弃、太短的单元单列（**不进分母**）"] = (t) => {
  t.eq(extractUnits("- (none)").length, 0, "`- (none)` 没有箭头 ⇒ 不是单元");
  t.eq(extractUnits("- → ").length, 0, "`- →` 规范化后是空串 ⇒ 丢弃");
  t.eq(extractUnits("- a → b").length, 0, "8 字符 < 12 ⇒ 空壳，丢弃");
  const units = extractUnits(SUMMARY);
  const measured = measureText(SUMMARY, null);
  t.eq(measured.units, units.length, "units = 抽取条数（5）");
  t.eq(measured.tooShort, 1, "`读取配置文件并确认 → 通过`（14 字符）< 24 ⇒ 记 tooShort");
  t.eq(measured.measurable, 4, "5 − 1 = 4 条可测");
  t.eq(measured.rate, null, "没有输入消息 ⇒ 不可测（**不是 0**）");
  const withText = measureText(SUMMARY, ["读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现"]);
  t.eq(withText.measurable, 4, "可测条数与有没有输入无关");
  t.notIncludes(JSON.stringify(withText), "null,\"rateAll\":null", "有输入时 rateAll 必须算出来");
};

/* ───────────────────────────── ② n-gram 反查 ───────────────────────────── */

tests["T54 最长逐字片段：命中 / 不命中 / **不跨消息**"] = (t) => {
  const texts = ["读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现", "跑 node test/run.mjs"];
  const index = buildGramIndex(texts, 8);
  const hit = longestVerbatim("读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现 → 确认只认 user/assistant 消息", texts, index, 8);
  t.eq(hit.best, 51, "动作侧逐字命中 51 字符（= 那条输入消息的全长）");
  t.eq(hit.messages, 1, "只在一条消息里出现 ⇒ 唯一（严格口径算它）");
  const miss = longestVerbatim("完全无关的一段话，输入里一个字都没有", texts, index, 8);
  t.eq(miss.best, 0, "不命中 ⇒ 0");
  t.eq(miss.messages, 0, "不命中时消息数必须是 0（⚠ `includes(\"\")` 恒真 ⇒ 曾把 0 算成「全部消息」）");

  // 跨消息：前半句在 m0、后半句在 m1 —— 拼起来能凑够 24 字符，但**没有任何一条消息**含它
  const split = ["前半句在第一条消息里", "后半句在第二条消息里"];
  const splitHit = longestVerbatim("前半句在第一条消息里后半句在第二条消息里", split, buildGramIndex(split, 8), 8);
  t.eq(splitHit.best, 10, "只能匹配到单条消息内的 10 字符（不足 24 ⇒ 不算回查）");
  t.eq(splitHit.best >= 24, false, "**跨两条消息拼出来的不算原文**");

  // 歧义：同一片段出现在两条消息里
  const dup = ["重复的片段重复的片段重复的片段", "另一条消息里也有重复的片段重复的片段"];
  const dupHit = longestVerbatim("重复的片段重复的片段", dup, buildGramIndex(dup, 8), 8);
  t.eq(dupHit.best, 10, "片段长度 10（= `重复的片段重复的片段`）");
  t.eq(dupHit.messages, 2, "出现在两条消息里 ⇒ messages = 2（严格口径不算「唯一」）");
};

tests["T54 measureText：主口径 / 动作半边 / 结果半边 / 严格口径"] = (t) => {
  const texts = replayInput(sessionEvents(), { seqStart: 1 }, null);
  const measured = measureText(SUMMARY, texts);
  t.eq(measured.measurable, 4, "4 条可测（14 字符那条太短，不进分母）");
  t.eq(measured.matched, 2, "命中 2 条（n1 的动作侧 48 字符、e? 的 tool-call 摘要行 29 字符）");
  t.eq(measured.rate, 0.5, "2 / 4 = 0.5");
  t.eq(measured.actionMatched, 2, "两条都是**动作**半边命中");
  t.eq(measured.resultMatched, 0, "结果半边一条都不命中 —— 错误原文来自 `tool/result`，而它**一条都不进输入**（C481）");
  t.eq(measured.actionRate, 0.5, "动作半边率");
  t.eq(measured.resultRate, 0, "结果半边率 = 0（结构性的，不是摘要写得差）");
  t.eq(measured.uniqueRate, 0.5, "两条都是唯一命中 ⇒ 严格口径同值");
  t.eq(measured.rateAll, 0.4, "全部单元口径（5 条分母）2 / 5 = 0.4 —— 短单元算失败");
  t.eq(measured.byN[32], 0.25, "n=32 时只剩 1 条（48 字符那段）⇒ 1 / 4");
  t.eq(measured.byN[48], 0.25, "n=48 时刚好还是那 1 条（48 ≥ 48）");
};

tests["T54 byN 的口径：任意 n 的率都从同一次最长片段算出来（不是各算一遍）"] = (t) => {
  // 造一条 30 字符的原文，看 n 门槛的跃变位置
  const texts = ["0123456789abcdefghijklmnopqrst"];
  const unit = "0123456789abcdefghijklmnopqrst";
  const index = buildGramIndex(texts, 8);
  const hit = longestVerbatim(unit, texts, index, 8);
  t.eq(hit.best, 30, "最长片段 = 整条 30 字符");
  const measured = measureText(`- n1 ${unit} → 结果`, texts);
  t.eq(measured.byN[24], 1, "n=24 ⇒ 命中（30 ≥ 24）");
  t.eq(measured.byN[32], 0, "n=32 ⇒ 不命中（30 < 32）");
  t.eq(measured.byN[8], 1, "n=8 ⇒ 命中");
};

/* ───────────────────────────── ③ 输入口径必须与生产一致 ───────────────────────────── */

tests["T54 输入重放：fromSeq = seqStart 头取、跳过 tool/result、单条上限 2000"] = (t) => {
  const events = [
    msg(5, "seqStart 之前的一条消息，不该进输入"),
    msg(10, "起始消息"),
    toolResult(11, "工具结果不该进输入"),
    toolCall(12, "bash", { command: "ls" }),
    msg(20, "x".repeat(3000)),
  ];
  const texts = replayInput(events, { seqStart: 10 }, null);
  t.eq(texts.length, 3, "只装 3 条：消息 10 / 工具行 12 / 消息 20（seq 5 与工具结果被挡掉）");
  t.eq(texts.some((text) => text.includes("seqStart 之前")), false, "fromSeq 之前的消息不进输入（头取，不是尾取）");
  t.eq(texts.some((text) => text.includes("工具结果不该进")), false, "`tool/result` 一条都不进输入（C481）");
  t.includes(texts[1], "→ bash(command=ls)", "工具调用被压成一行 `→ name(args)`");
  t.eq(texts[2].length > 2000, true, "3000 字符的消息被单条上限截断");
  t.eq(texts[2].length < 2200, true, "截断后 ≈ 2000 + 截断标记");

  // 旋钮：perMessageChars 放大 ⇒ 消息变长（判据 2 的输入侧改动）
  const wide = replayInput(events, { seqStart: 10 }, null, { perMessageChars: 1_000_000 });
  t.eq(wide[2].length, 3000, "perMessageChars 放大后 3000 字符原样进来");
  t.eq(wide[2].length > texts[2].length, true, "…严格更长（这正是判据 2 能测到的那点 Δ）");
};

tests["T54 输入带 id 前缀（`withId`）：`[n1] ` 是输入的一部分，不是摘要的一部分"] = (t) => {
  const idBySeq = new Map([[10, "n1"]]);
  const texts = replayInput([msg(10, "起始消息")], { seqStart: 10 }, idBySeq);
  t.eq(texts[0], "[n1] 起始消息", "生产会给消息加 `[id] ` 前缀（C538）");
};

/* ───────────────────────────── ④ id 无关（「不循环」的判据） ───────────────────────────── */

tests["T54 同一件事，id 被抹成 `e?` 与写成 `e3` ⇒ **同一个率**"] = (t) => {
  const texts = replayInput(sessionEvents(), { seqStart: 1 }, null);
  const withId = '- e3 "bash(command=rm -rf /tmp/x)" → Error: tool call timed out after 30000ms (seq 15-17)';
  const withPlaceholder = '- e? "bash(command=rm -rf /tmp/x)" → Error: tool call timed out after 30000ms (seq 15-17)';
  const a = measureText(withId, texts);
  const b = measureText(withPlaceholder, texts);
  t.eq(a.rate, b.rate, "id 写没写出来，率完全相同（U3 ③④ 把 id 去掉了）");
  t.eq(a.matched, 1, "这条单元能回查（动作侧的 tool-call 摘要行）");
  t.eq(b.matched, 1, "…换成占位符也一样");

  // 反过来：id **不能**冒充回查依据 —— 一条只有 id、内容完全不同的单元必须不命中
  const onlyIds = "- e3 n1 n2 n3 → e4";
  t.eq(measureText(onlyIds, texts).units, 0, "只有 id 与箭头（规范化后只剩 `→`）⇒ 不是单元");
  t.eq(measureText("- e3 完全不同的内容描述 → 完全不同的结果描述", texts).matched, 0, "只共享 id 不算回查");
};

/* ───────────────────────────── ⑤ 判据 2：修复前后 ───────────────────────────── */

tests["T54 判据 2：id 侧修复 Δ 恒为 0（定义保证 ⇒ 它不可能变成前两个指标）"] = (t) => {
  const graph = makeGraph();
  const text = '- e3 "edit(file_path=foo.md)" → Error: cannot modify foo.md (seq 12-14)';
  const repair = repairSensitivity({
    mark: { seqStart: 10, seqEnd: 20, trigger: "archive-offline", at: 1 },
    text,
    graph,
    events: sessionEvents(),
  });
  t.eq(repair["t30-claim"].delta, 0, "T30 认领（`e?` → `e3`）Δ = 0");
  t.eq(repair["t35-boundary"].delta, 0, "T35 sanitize 的界 Δ = 0");
  t.eq(repair["t30-claim"].applied, 0, "本条没有占位符 ⇒ 认领量 0");
  t.eq(repair.before, 0, "这条单元本来就不命中（错误原文不在输入里）");
};

tests["T54 判据 2：C607 死路补回**加行**，但补回行的「结果」来自工具输出 ⇒ 率不升"] = (t) => {
  const graph = makeGraph();
  // 正文里没提 e3 ⇒ 补回会追加一行
  const text = "- n1 读取 src/rooms/offline-fold.mjs 里的 collectMessages 实现 → 确认只认 user/assistant 消息";
  const repair = repairSensitivity({
    mark: { seqStart: 10, seqEnd: 20, trigger: "archive-offline", at: 1 },
    text,
    graph,
    events: sessionEvents(),
  });
  t.eq(repair["c607-repair"].applied, 1, "补回 1 行（e3 没被提到）");
  t.eq(repair.before, 1, "补回前：1 / 1 = 1.0");
  t.eq(repair["c607-repair"].after, 0.5, "补回后：1 / 2 = 0.5 —— 补回行的错误原文不在输入里");
  t.eq(repair["c607-repair"].delta, -0.5, "**补回让率下降**（指标惩罚了一个质量修复）");
};

/* ───────────────────────────── ⑥ 三条判据的裁决必须能返回「不通过」 ───────────────────────────── */

/** 裁决用的合成 result（只放 `verdicts` 需要的字段）。 */
function makeResult({ shapeRho = 0.05, qualityRho = -0.03, repairDelta = 0.007, sweepShape = [0.23, 0.14, 0.16, 0.05, -0.02, -0.03] } = {}) {
  const sweep = Object.fromEntries(NGRAM_SWEEP.map((n, index) => [n, { rhoShape: sweepShape[index] }]));
  return {
    n: NGRAM_N,
    correlations: {
      rateVsTailGap: { n: 346, pearson: 0.003, spearman: shapeRho },
      rateVsQuality: { n: 346, pearson: -0.04, spearman: qualityRho },
      rateVsTraceable: { n: 345, pearson: 0.08, spearman: 0.03 },
      rateVsChars: { n: 346, pearson: 0.16, spearman: 0.24 },
    },
    sweep,
    repair: {
      byChange: {
        "t30-claim": { pool: 346, meanDelta: 0, maxDelta: 0, changed: 0 },
        "t35-boundary": { pool: 346, meanDelta: 0, maxDelta: 0, changed: 0 },
        "c607-repair": { pool: 346, meanDelta: 0.0001, maxDelta: 0.035, changed: 1 },
        "per-message": { pool: 346, meanDelta: repairDelta, maxDelta: 0.16, changed: 54 },
        "max-chars": { pool: 346, meanDelta: 0.0001, maxDelta: 0.016, changed: 2 },
      },
    },
  };
}

tests["T54 裁决 1：与形状强相关 ⇒ 必须红（真机 0.05 ⇒ 绿）"] = (t) => {
  t.eq(verdicts(makeResult({ shapeRho: 0.35 })).find((v) => v.id === "shape-free").pass, false, "ρ=0.35 ⇒ 不通过");
  t.eq(verdicts(makeResult({ shapeRho: -0.25 })).find((v) => v.id === "shape-free").pass, false, "负相关也算强（|ρ|）");
  t.eq(verdicts(makeResult({ shapeRho: 0.05 })).find((v) => v.id === "shape-free").pass, true, "ρ=0.05 ⇒ 通过（门槛两侧都要能走）");
  // n 扫描里只要有一个 n（≥ 主口径）不过，判据 1 就不过
  t.eq(
    verdicts(makeResult({ sweepShape: [0.23, 0.14, 0.16, 0.05, 0.9, -0.03] })).find((v) => v.id === "shape-free").pass,
    false,
    "n=32 的 ρ=0.9 ⇒ 判据 1 红（结论不许只在某一个 n 上成立）",
  );
  t.includes(verdicts(makeResult()).find((v) => v.id === "shape-free").detail, "n=8", "detail 必须给出全 n 扫描");
};

tests["T54 裁决 2：所有改动 Δ < 5pp ⇒ 必须红（真机 +0.74pp ⇒ 红）"] = (t) => {
  t.eq(verdicts(makeResult()).find((v) => v.id === "sensitive").pass, false, "最大 Δ = 0.74pp < 5pp ⇒ 不敏感");
  t.eq(verdicts(makeResult({ repairDelta: 0.2 })).find((v) => v.id === "sensitive").pass, true, "若有改动 Δ = 20pp ⇒ 通过（门槛能走）");
  t.includes(verdicts(makeResult()).find((v) => v.id === "sensitive").detail, "per-message", "detail 必须点名是哪一项最大");
};

tests["T54 裁决 3：与质量无相关（ρ ≤ 0.3）⇒ 必须红（真机 −0.03 ⇒ 红）"] = (t) => {
  t.eq(verdicts(makeResult({ qualityRho: -0.03 })).find((v) => v.id === "explanatory").pass, false, "ρ=−0.03 ⇒ 无解释力");
  t.eq(verdicts(makeResult({ qualityRho: 0.29 })).find((v) => v.id === "explanatory").pass, false, "ρ=0.29 < 0.3 ⇒ 仍不通过（门槛是硬的）");
  t.eq(verdicts(makeResult({ qualityRho: 0.31 })).find((v) => v.id === "explanatory").pass, true, "ρ=0.31 ⇒ 通过");
  t.includes(verdicts(makeResult()).find((v) => v.id === "explanatory").detail, "可定位率", "detail 必须给出与旧指标的相关（> 0.8 = 同一个东西）");
};

tests["T54 裁决总表：真机形状是 1 / 3 ⇒ 结论「不能用」"] = (t) => {
  const all = verdicts(makeResult());
  t.eq(all.length, 3, "三条判据，一条不少");
  t.eq(all.map((entry) => entry.id), ["shape-free", "sensitive", "explanatory"], "顺序固定（报告与测试都按它）");
  t.eq(all.map((entry) => entry.pass), [true, false, false], "逐条：形状 ✅ · 会变 ❌ · 有解释力 ❌");
  t.eq(all.filter((entry) => entry.pass).length === 3, false, "**1 / 3 ⇒ 不能用**（全过才叫能用）");
};

/* ───────────────────────────── ⑦ 极端对照 ───────────────────────────── */

tests["T54 极端对照：率的最高档与最低档，质量分必须能分开（真机分不开 ⇒ 没有区分度）"] = (t) => {
  const rows = [
    { rate: 1, qualityTotal: 8.5, qualityHandoff: 2, qualityNoRedundancy: 2, chars: 6000, units: 10, sessionId: "a" },
    { rate: 1, qualityTotal: 7.5, qualityHandoff: 1, qualityNoRedundancy: 1.5, chars: 5000, units: 12, sessionId: "b" },
    { rate: 0, qualityTotal: 8, qualityHandoff: 1.5, qualityNoRedundancy: 2, chars: 6000, units: 7, sessionId: "c" },
    { rate: 0, qualityTotal: 7.5, qualityHandoff: 1, qualityNoRedundancy: 2, chars: 5500, units: 9, sessionId: "d" },
  ];
  const extremes = summarizeExtremes(rows);
  t.eq(extremes.top.n, 2, "率 ≥ 0.99 的 2 条");
  t.eq(extremes.bottom.n, 2, "率 = 0 的 2 条");
  t.eq(extremes.top.quality, 8, "最高档 T33 均分 8");
  t.eq(extremes.bottom.quality, 7.75, "最低档 T33 均分 7.75");
  t.eq(extremes.gap, 0.25, "差 0.25 分 ⇒ 没有区分度（< 0.5 就在报告里明说）");
  t.eq(summarizeExtremes([]).top.quality, null, "空集 ⇒ null（不拿 0 冒充）");
};

/* ───────────────────────────── ⑧ 一条折痕 ───────────────────────────── */

tests["T54 auditMark：率 / 离尾部 / 输入规模 / T33 分 / 修复 5 项都给"] = (t) => {
  const graph = makeGraph();
  const row = auditMark({
    mark: { at: 1000, seqStart: 10, seqEnd: 20, trigger: "archive-offline" },
    graph,
    text: SUMMARY,
    source: "lastOfflineSummary",
    events: sessionEvents(),
    graphMaxSeq: 50,
    sessionId: "fixture",
  });
  t.eq(row.tailGap, 30, "离尾部 50 − 20 = 30（落进 21–100 桶）");
  t.eq(row.span, 11, "跨度 11 个事件");
  t.eq(row.replayed, true, "有日志 ⇒ 可重放");
  t.eq(row.messages > 0, true, "装进输入的消息条数");
  t.eq(row.rate, 0.5, "可回查率 0.5");
  t.eq(row.measurable, 4, "4 条可测");
  t.eq(row.traceableShare, 0.8, "可定位率（对照物）：4 个真 id / (4 真 + 1 占位) = 0.8 —— 只作对照，不进指标");
  t.eq(Number.isFinite(row.qualityTotal), true, "T33 五判据机械分算得出来");
  t.eq(Object.keys(row.repair).length > 0, true, "修复 5 项都跑了");
  t.eq(row.repair["t30-claim"].delta, 0, "id 侧 Δ = 0");

  // 没有正文 ⇒ 一行空壳（不编数）
  const empty = auditMark({ mark: { at: 1, seqStart: 1, seqEnd: 1 }, graph, text: null, events: null, graphMaxSeq: 1 });
  t.eq(empty.hasText, false, "没有正文");
  t.eq(empty.rate, null, "没有正文 ⇒ 率不可测");
};

/* ───────────────────────────── ⑨ 端到端（临时 home，只读） ───────────────────────────── */

tests["T54 audit() 端到端：临时 home 只读、缺目录 ⇒ missing、坏图跳过"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "traceability-"));
  try {
    const sessionsDir = nodePath.join(home, "chess-context", "sessions");
    const graph = makeGraph();
    graph.sessionId = "sess-1";
    graph.foldMarks = [
      { at: 1000, seqStart: 10, seqEnd: 20, trigger: "archive-offline", summaryChars: 5973 },
      { at: 2000, seqStart: 30, seqEnd: 30, trigger: "archive-offline", summaryChars: 12 },
    ];
    graph.lastOfflineSummary = { at: 1000, range: { start: 10, end: 20 }, text: SUMMARY };
    nodeFs.mkdirSync(nodePath.join(sessionsDir, "sess-1"), { recursive: true });
    const graphFile = nodePath.join(sessionsDir, "sess-1", "graph.json");
    nodeFs.writeFileSync(graphFile, JSON.stringify(graph), "utf8");
    const before = nodeFs.readFileSync(graphFile, "utf8");

    const result = audit({ home });
    t.eq(result.missing, false, "有棋谱目录 ⇒ 不是 missing");
    t.eq(result.sessions, 1, "1 个会话");
    t.eq(result.marks, 2, "2 条折痕");
    t.eq(result.rows.length, 1, "只有 1 条有正文（单槽口径：range 对得上的那条）");
    t.eq(result.pool, 1, "可复判池 1");
    t.eq(result.measurable, 0, "没有日志 ⇒ 0 条可重放（率不可测）");
    t.eq(result.unmeasurable, 1, "…另 1 条记「不可重放」（不静默丢掉）");
    t.eq(result.summary.rate.n, 0, "不可测的折痕不进率的分布");
    t.eq(result.rows[0].units, 5, "抽取规则在端到端上也一致");

    // 只读：graph.json 一个字节都没变
    t.eq(nodeFs.readFileSync(graphFile, "utf8"), before, "graph.json 一个字节都没动");

    // 缺目录 ⇒ missing（不是「0 条折痕」）
    t.eq(audit({ home: nodePath.join(home, "nope") }).missing, true, "没有棋谱目录 ⇒ missing");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
