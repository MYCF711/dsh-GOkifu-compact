#!/usr/bin/env node
/**
 * summary-truncation-audit.mjs —— **118 条「摘要被截断」到底是真截断，还是仪器假阳性**（T40 / C648）
 *
 * 由来（真机 2026-11-05 08:2x，`node scripts/doctor.mjs` 原样输出）：
 *
 *   ! 摘要截断（finish_reason=length） — 891 条有截断证据的 fold 里 **118** 条被截断
 *     （其中 **118** 条来自 `truncated`：离线补折拿不到上游 finish）…… · 另有 150 条不知道
 *
 * 13% 的摘要「写到一半停了」—— 如果为真，这是最贵的一类缺陷：后面的结论/死路全丢，
 * 而账上记成成功。**但这个结论此前只有计数，没有拆解**。本脚本把它拆成六组可复核的数字：
 *
 *   ① **路径**：118 条分别来自哪条产线（`archive-offline` / `pressure` / `tier2` / manual）；
 *   ② **判据**：`looksTruncated` 的三条判据里，**具体哪一条**命中的
 *      （`finish` 含 max / `outputTokens ≥ budget` / C534 正文 < 400 字符）；
 *   ③ **位置**：`summaryChars` 分布 vs **同 trigger 未截断**对照 —— 真截断应该在预算处堆积；
 *   ④ **上限**：正文 token（`quality.summaryTokens`，与预算**同一个估算器**）到底撞没撞 `budget`；
 *      provider 报的 `usage.outputTokens`（**含 reasoning**，见 CHANGELOG C73）与 `budget` 的关系；
 *   ⑤ **质量**：`constraintRecall` / `failureRecall` / `sectionsMissing` / `endedCleanly` 对比对照；
 *   ⑥ **兜底**：机械补回（C522 约束 / C607+C641 死路）到底补回了多少条，剩下的真丢有几条。
 *
 * 为什么必须做这一层：`truncated` 这个字段被 doctor / 面板 / `todayAggregate` 当成
 * 「内容可能被截断」的**结论**在用。如果它其实是「provider 把 reasoning 也算进 outputTokens
 * 撞了正文预算」，那 13% 就是**仪器假阳性**，去改 `maxTokens` 只会把盲区从 8192 抬到 16384 ——
 * 那比不改更坏（真截断从此不再报警）。
 *
 * 用法：
 *   node scripts/summary-truncation-audit.mjs                 # 全量（真机 ~570 个会话）
 *   node scripts/summary-truncation-audit.mjs --json          # 机读
 *   node scripts/summary-truncation-audit.mjs --session <SESSION_ID>
 *   node scripts/summary-truncation-audit.mjs --max-tokens=8192 --offline-max-tokens=8192
 *   DSH_HOME=... node scripts/summary-truncation-audit.mjs    # 换 home（与 doctor 同源）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 *
 * 口径（与写入点逐字对齐，改代码时这里要跟着改）：
 *   · 预算 `budget = min(budgetCap, foldBudgetFor(prompt, maxTokens))`（`runOfflineFold`）；
 *     `budgetCap = clamp(offlineMaxTokens || 8192, 1024, HARD_MAX_TOKENS)`；
 *   · 判据 `looksTruncated`：`finish` 含 "max" ∨ `outputTokens ≥ budget` ∨ (prompt>4000 字符 ∧ 正文<400 字符)；
 *   · 重试条件 `roomMs > spentMs × 1.2`，`deadline = now + max(offlineFoldTimeoutMs||240_000, offlineMaxTokens×25)`。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, estimateFoldCostUsd } from "../src/ui.mjs";
import { HARD_MAX_TOKENS, foldBudgetFor, suggestedLength } from "../src/rooms/offline-fold.mjs";
import { describeStructure } from "../src/rooms/fold-quality.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";

/** `config-schema.mjs` 的 `maxTokens` 默认值（摘要输出上限）。 */
export const DEFAULT_MAX_TOKENS = 8192;
/** `chess.offlineMaxTokens` 未配置时的默认值（`engine.mjs` 的离线补折调用点）。 */
export const DEFAULT_OFFLINE_MAX_TOKENS = 8192;
/** `chess.offlineFoldTimeoutMs` 未配置时的默认值。 */
export const DEFAULT_FOLD_TIMEOUT_MS = 240_000;

/** 与 doctor / graph-audit / input-truncation-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/**
 * 离线折叠的**实际输出预算** —— 与 `runOfflineFold` 的公式逐字一致。
 *
 * 为什么要显式复算而不是写 `8192`：`budget = min(budgetCap, foldBudgetFor(prompt, maxTokens))`。
 * 两处都可能变（`maxTokens` 是配置、`budgetCap` 来自另一个键 `offlineMaxTokens`），
 * 而 **只改 `maxTokens` 对离线预算恒等于空操作**（`foldBudgetFor` 的 `max(base, est)` 会被
 * `budgetCap` 再夹回 8192）—— 这条正是「A 类：提高 maxTokens」能不能成立的全部依据。
 *
 * @param {number} [maxTokens] `chess.maxTokens`（摘要输出上限，默认 8192）
 * @param {number} [offlineMaxTokens] `chess.offlineMaxTokens`（离线预算上限，未配置 = 8192）
 * @param {number} [promptChars] 送进模型的 prompt 字符数（真机都在 27k 字符以上 ⇒ estTokens ≥ 8192）
 * @returns {number} 实际 `max_tokens`
 */
export function offlineBudget(maxTokens = DEFAULT_MAX_TOKENS, offlineMaxTokens = DEFAULT_OFFLINE_MAX_TOKENS, promptChars = 200_000) {
  const cap = Math.max(1024, Math.min(HARD_MAX_TOKENS, Number(offlineMaxTokens) || DEFAULT_OFFLINE_MAX_TOKENS));
  return Math.min(cap, foldBudgetFor("x".repeat(Math.max(0, Number(promptChars) || 0)), maxTokens));
}

/** `looksTruncated` 的三条判据 —— 闭集（`test/summary-truncation.test.mjs` 钉住顺序与语义）。 */
export const EVIDENCE = Object.freeze({
  "finish-max": "上游 finishReason 是截断类（max_tokens / length）",
  "output-cap": "provider 报的输出 token（**含 reasoning**）≥ 正文预算",
  skeleton: "C534：prompt > 4000 字符而正文 < 400 字符（模型只写了个骨架）",
  clean: "有证据的「没截断」（上游 finish 是 stop 类，或写入点判了 false）",
  unknown: "两个字段都没有（不知道）",
});

/**
 * 一条 foldMark 的**截断证据来自哪条判据** —— 纯函数。
 *
 * ★ 口径必须与 `scripts/doctor.mjs` 的那段**逐字一致**（三态分开：截断 / 有证据的没截断 / 不知道），
 * 否则本脚本的「118」会和 doctor 的「118」对不上 —— 那正是这个仓库栽过很多次的「两套口径」。
 * 顺序与 `looksTruncated` 一致：`finish` 是截断类先判，然后才是 token 上限，最后是 C534 的骨架判据。
 *
 * @param {object} mark foldMark
 * @param {number} budget 本次折叠的输出预算（`offlineBudget()`）
 * @returns {"finish-max"|"output-cap"|"skeleton"|"clean"|"unknown"}
 */
export function classifyEvidence(mark, budget) {
  const m = mark ?? {};
  const reason = m.finishReason ?? m.stopReason;
  if (isTruncatedFinish(reason)) return "finish-max";
  if (m.truncated === true) {
    const used = Number(m?.usage?.outputTokens ?? m?.usage?.completion_tokens);
    return Number.isFinite(used) && used >= Number(budget) ? "output-cap" : "skeleton";
  }
  // 有证据的「没截断」：上游给了非截断的 finish，或写入点明确判了 false
  if (typeof reason === "string" || m.truncated === false) return "clean";
  return "unknown";
}

/** 摘要**正文**的 token 数（`quality.summaryTokens` 与预算用同一个 CJK 感知估算器）。 */
export function summaryTokensOf(mark) {
  const recorded = Number(mark?.quality?.summaryTokens);
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  return null;
}

/** 升序分位数（p ∈ [0,1]，最邻近秩）。 */
export function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const at = Math.min(list.length - 1, Math.max(0, Math.ceil(p * list.length) - 1));
  return list[at];
}

/** 一组数的 min / p10 / p50 / p90 / max / mean。 */
export function describe(list) {
  const values = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(Number(x))).map(Number);
  if (values.length === 0) return { n: 0, min: null, p10: null, p50: null, p90: null, max: null, mean: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: Math.min(...values),
    p10: percentile(values, 0.1),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
    mean: Math.round(sum / values.length),
  };
}

/** 机械补回段的标题（**只认这两个**，别处的 `##` 一律算模型自己写的）。 */
export const REPAIR_HEADINGS = Object.freeze(["## 约束（逐字补充", "## 已探明死路（逐字补充"]);

/**
 * 把机械补回段从正文里剪掉，只留**模型自己写的**那一截。
 *
 * 为什么必须剪：`endedCleanly` 是在**补回之后**的正文上算的 —— 补回段本身就是一行完整的
 * `- 约束原文`，会把「模型断在半句」这件事盖掉。判「模型写没写完」只能看它自己写的那截。
 *
 * @param {string} text 最终正文（模型输出 + 机械补回）
 * @returns {{modelText:string, repairedSections:number}}
 */
export function stripRepairSections(text) {
  const body = String(text ?? "");
  let cut = body.length;
  let sections = 0;
  for (const heading of REPAIR_HEADINGS) {
    const at = body.indexOf(heading);
    if (at >= 0 && at < cut) cut = at;
  }
  for (const heading of REPAIR_HEADINGS) if (body.includes(heading)) sections += 1;
  return { modelText: body.slice(0, cut).trimEnd(), repairedSections: sections };
}

/**
 * **根因判定**（A/B/C/D）—— 纯函数，输入是聚合统计，输出是判定 + 每类为什么被否。
 *
 * 判据（顺序有意义：先排「改预算能救」的那一类，D 放在最后 —— 它是**没有缺陷**的结论，
 * 必须前面全部被数字否掉才成立）：
 *   · **A 输出预算太小**：**正文** token 撞顶（`summaryTokens ≥ budget`）的比例 ≥ 50%
 *     ⇒ 提高 `maxTokens` 有效（并给出成本）；
 *   · **B 提示词太长**：模型写在「要求篇幅」以内（`summaryChars ≤ suggestedLength.max`）就撞顶
 *     ⇒ 是提示词把篇幅要到预算放不下，压提示词；
 *   · **C 输入太长**：截断组输入显著长于对照（`≥ 1.5×`）**且**正文收尾完整率比对照低 20 个点以上
 *     ⇒ 模型写不完，该分段（`chunkedFolded`）；
 *   · **D 正常**：正文没撞顶（`textCapHits = 0`）且收尾完整率**与对照无差别**（差 < 10 个点）
 *     且两项召回不劣于对照 ⇒ `truncated` 是**仪器假阳性**（reasoning 被算进 outputTokens），
 *     机械补回已兜底 ⇒ 不改代码。
 *
 * 为什么 D 的判据要**和对照比**而不是设一个绝对线：真机对照组的收尾完整率就是 77.7%
 * （模型本来就常在清单里收尾）。设绝对线（例如 ≥ 80%）会让判定在 78.4% 这种噪声上翻转 ——
 * 那不是判据，那是拍脑袋。
 *
 * @param {object} stats
 * @returns {{verdict:"A"|"B"|"C"|"D", why:string, refuted:object}}
 */
export function verdictOf(stats = {}) {
  const total = Math.max(0, Number(stats.total) || 0);
  const textCapHits = Math.max(0, Number(stats.textCapHits) || 0);
  const cleanEndRate = Number(stats.cleanEndRate);
  const controlEndRate = stats.controlCleanEndRate === null || stats.controlCleanEndRate === undefined ? null : Number(stats.controlCleanEndRate);
  const inputRatio = Number(stats.inputRatio);
  const withinRequested = stats.withinRequestedLength === true;
  const recallNotWorse = stats.recallNotWorse === true;
  const textCapRate = total === 0 ? 0 : textCapHits / total;
  const fmt = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "?");
  const gap = Number.isFinite(cleanEndRate) && controlEndRate !== null ? cleanEndRate - controlEndRate : null;
  const refuted = {};
  if (textCapRate >= 0.5) {
    return {
      verdict: "A",
      why: `正文 token 撞顶 ${textCapHits}/${total}（${fmt(textCapRate)} ≥ 50%）⇒ 提高 maxTokens 能救`,
      refuted,
    };
  }
  refuted.A = `正文撞顶 ${textCapHits}/${total}（${fmt(textCapRate)} < 50%）—— 预算没有卡住正文`;
  if (withinRequested && textCapHits > 0) {
    return { verdict: "B", why: `模型写在要求篇幅以内仍撞顶 ${textCapHits} 条 ⇒ 提示词要的篇幅本身超预算`, refuted };
  }
  refuted.B = "模型写的篇幅超过提示词要求的上限 ⇒ 篇幅不是约束（压提示词改不了任何一条）";
  if (Number.isFinite(inputRatio) && inputRatio >= 1.5 && gap !== null && gap <= -0.2) {
    return {
      verdict: "C",
      why: `截断组输入是对照的 ${inputRatio.toFixed(2)}×（≥ 1.5×）且收尾完整率 ${fmt(cleanEndRate)} 比对照 ${fmt(controlEndRate)} 低 ${fmt(-gap)}（≥ 20 个点）⇒ 该分段`,
      refuted,
    };
  }
  refuted.C =
    `输入长度比 ${Number.isFinite(inputRatio) ? inputRatio.toFixed(2) : "?"}×（< 1.5×）；` +
    `收尾完整率 ${fmt(cleanEndRate)} vs 对照 ${fmt(controlEndRate)}（差 ${gap === null ? "?" : fmt(gap)}，不显著）`;
  if (textCapHits === 0 && gap !== null && gap > -0.1 && recallNotWorse) {
    return {
      verdict: "D",
      why:
        `正文 0 条撞顶、收尾完整率 ${fmt(cleanEndRate)} 与对照 ${fmt(controlEndRate)} 无差别（差 ${fmt(gap)}）、` +
        `两项召回不劣于对照 ⇒ 仪器假阳性（reasoning 被算进 outputTokens），机械补回已兜底`,
      refuted,
    };
  }
  return {
    verdict: "C",
    why: `兜底判据不成立（正文撞顶 ${textCapHits}、收尾差 ${gap === null ? "?" : fmt(gap)}、召回不劣 ${recallNotWorse}）⇒ 按输入过长处理`,
    refuted,
  };
}

/**
 * 正文**最后一行**的分类 —— 三种，因为「引号/括号不配平」有两种完全不同的来源：
 *   · `unclosed`  ：行尾是 `；，：、` 或半个参数（`[,:([{`）⇒ **句子/列表没写完**，真断；
 *   · `quote-only`：行尾是完整标点，只是引号/括号不配平 ⇒ **不是模型断的**：
 *     死路行的动作被 `compactAction(text, 80)` 切在 80 字符上（真机 `- e20 "bash(command=cd …`），
 *     括号本来就不闭合。C607 的 `repairMissingFailures` 专门为此去引号，本分类器同理；
 *   · `clean`     ：以上都不是。
 *
 * 为什么不能只看 `describeStructure.endedCleanly`：它把后两种都算成"不干净"，
 * 于是「模型写完了、只是死路行动作被 80 字符切过」会被误读成截断 —— 那正是 C607 要修的假阳性。
 *
 * @param {string} text
 * @returns {"clean"|"unclosed"|"quote-only"}
 */
export function classifyTail(text) {
  const body = String(text ?? "").trimEnd();
  if (body === "") return "unclosed";
  const lastLine = body.slice(body.lastIndexOf(String.fromCharCode(10)) + 1).trim();
  if (/[、，：；]$|[,:([{]$/.test(lastLine)) return "unclosed";
  const count = (ch) => lastLine.split(ch).length - 1;
  const balanced = count('"') % 2 === 0 && count("(") === count(")") && count("[") === count("]");
  return balanced ? "clean" : "quote-only";
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
const maxTokens = pick("max-tokens", DEFAULT_MAX_TOKENS);
const offlineMaxTokens = pick("offline-max-tokens", DEFAULT_OFFLINE_MAX_TOKENS);
const foldTimeoutMs = pick("fold-timeout-ms", DEFAULT_FOLD_TIMEOUT_MS);
const sessionArg = args.find((a) => a.startsWith("--session="));
const only = sessionArg === undefined ? null : String(sessionArg.slice("--session=".length));

/** 收集：每条 mark 带上它所属的图（正文实证要用 `lastOfflineSummary`）。 */
export function collectMarks(home, { session = null } = {}) {
  const scan = collectGraphFiles(home);
  const rows = [];
  for (const entry of scan.files) {
    if (session !== null && !String(entry.dir).includes(session)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      continue; // 坏图跳过（只读审计不许因为一张坏图整跑挂掉）
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    for (const mark of marks) rows.push({ session: entry.dir, graph, mark: mark ?? {} });
  }
  return { files: scan.files.length, rows };
}

function main() {
  const home = resolveHome();
  const { files, rows } = collectMarks(home, { session: only });
  if (rows.length === 0 && files === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }
  const budget = offlineBudget(maxTokens, offlineMaxTokens);
  const retryRoomMs = foldTimeoutMs; // deadline ≈ now + 240s；重试条件 roomMs > spentMs×1.2 ⇒ spentMs < 109s
  const retryThresholdMs = retryRoomMs / 2.2;

  const truncated = [];
  const control = [];
  const byTrigger = new Map();
  const byEvidence = new Map();
  const byFinish = new Map();
  let total = 0;

  for (const row of rows) {
    const { mark } = row;
    total += 1;
    const trigger = String(mark.trigger ?? "(缺失)");
    const evidence = classifyEvidence(mark, budget);
    const isTrunc = evidence !== "clean" && evidence !== "unknown";
    const bucket = byTrigger.get(trigger) ?? { total: 0, truncated: 0, clean: 0, unknown: 0 };
    bucket.total += 1;
    bucket[isTrunc ? "truncated" : evidence === "clean" ? "clean" : "unknown"] += 1;
    byTrigger.set(trigger, bucket);
    byEvidence.set(evidence, (byEvidence.get(evidence) ?? 0) + 1);
    const finish = mark.finishReason === undefined ? "(缺失)" : String(mark.finishReason);
    byFinish.set(finish, (byFinish.get(finish) ?? 0) + 1);
    if (isTrunc) truncated.push(row);
    else if (evidence === "clean" && trigger === "archive-offline") control.push(row);
  }

  // ③ 位置（summaryChars）：截断 vs 同 trigger 对照
  const charsTrunc = describe(truncated.map((r) => Number(r.mark.summaryChars)));
  const charsControl = describe(control.map((r) => Number(r.mark.summaryChars)));
  const buckets = [0, 2000, 4000, 6000, 8000, 10000, 12000, 16000, Infinity];
  const histTrunc = new Array(buckets.length - 1).fill(0);
  const histControl = new Array(buckets.length - 1).fill(0);
  const bin = (list, hist) => {
    for (const r of list) {
      const n = Number(r.mark.summaryChars);
      if (!Number.isFinite(n)) continue;
      for (let i = 0; i < hist.length; i += 1) {
        if (n >= buckets[i] && n < buckets[i + 1]) {
          hist[i] += 1;
          break;
        }
      }
    }
  };
  bin(truncated, histTrunc);
  bin(control, histControl);

  // ④ 上限：正文 token（与预算同一估算器）vs provider outputTokens
  const textTokens = truncated.map((r) => summaryTokensOf(r.mark)).filter((x) => x !== null);
  const outputTokens = truncated.map((r) => Number(r.mark?.usage?.outputTokens ?? r.mark?.usage?.completion_tokens)).filter((x) => Number.isFinite(x));
  const textCapHits = textTokens.filter((x) => x >= budget).length;
  const outputCapHits = outputTokens.filter((x) => x >= budget).length;
  const overHardMax = outputTokens.filter((x) => x > HARD_MAX_TOKENS).length;
  const ratios = truncated
    .map((r) => {
      const st = summaryTokensOf(r.mark);
      const out = Number(r.mark?.usage?.outputTokens);
      return Number.isFinite(st) && st > 0 && Number.isFinite(out) ? out / st : null;
    })
    .filter((x) => x !== null);
  const controlRatios = control
    .map((r) => {
      const st = summaryTokensOf(r.mark);
      const out = Number(r.mark?.usage?.outputTokens);
      return Number.isFinite(st) && st > 0 && Number.isFinite(out) ? out / st : null;
    })
    .filter((x) => x !== null);

  // ⑤ 质量：两项召回 + 结构
  const rate = (list, fn) => (list.length === 0 ? null : list.filter(fn).length / list.length);
  const quality = {
    truncated: {
      n: truncated.length,
      constraintRecall1: rate(truncated, (r) => Number(r.mark?.quality?.constraintRecall) === 1),
      failureRecall1: rate(truncated, (r) => Number(r.mark?.quality?.failureRecall) === 1),
      sectionsMissing0: rate(truncated, (r) => (r.mark?.quality?.sectionsMissing ?? []).length === 0),
      endedCleanly: rate(truncated, (r) => r.mark?.quality?.endedCleanly === true),
      summaryTokens: describe(textTokens),
    },
    control: {
      n: control.length,
      constraintRecall1: rate(control, (r) => Number(r.mark?.quality?.constraintRecall) === 1),
      failureRecall1: rate(control, (r) => Number(r.mark?.quality?.failureRecall) === 1),
      sectionsMissing0: rate(control, (r) => (r.mark?.quality?.sectionsMissing ?? []).length === 0),
      endedCleanly: rate(control, (r) => r.mark?.quality?.endedCleanly === true),
      summaryTokens: describe(control.map((r) => summaryTokensOf(r.mark)).filter((x) => x !== null)),
    },
  };
  // sectionsMissing 的分段名分布（哪一段真的缺）
  const missingDist = new Map();
  for (const r of truncated) for (const name of r.mark?.quality?.sectionsMissing ?? []) missingDist.set(name, (missingDist.get(name) ?? 0) + 1);

  // ⑥ 正文实证：能从 `lastOfflineSummary` 取回原文的那几条。
  //   ★ 关键对照组：**同样的取法也要跑一遍未截断的对照** —— 只有两组一起看，
  //     「结尾断在半句」才分得清是「截断造成的」还是「模型本来就这样收尾」。
  //     真机（2026-11-05）：截断组 40/51 = 78.4% 完整，对照组 241/310 = 77.7% 完整 ⇒ **没有差别**。
  const recoveredOf = (list) => {
    const rows = [];
    for (const row of list) {
      const los = row.graph?.lastOfflineSummary;
      if (typeof los?.text !== "string" || los.text === "") continue;
      if (Number(los?.range?.start) !== Number(row.mark.seqStart) || Number(los?.range?.end) !== Number(row.mark.seqEnd)) continue;
      const { modelText, repairedSections } = stripRepairSections(los.text);
      const structure = describeStructure(modelText, { expectFailures: Number(row.mark?.quality?.expectedFailures) > 0 });
      rows.push({
        session: row.session,
        seqStart: row.mark.seqStart,
        seqEnd: row.mark.seqEnd,
        chars: los.text.length,
        modelChars: modelText.length,
        repairedSections,
        endedCleanly: structure.endedCleanly,
        tail: classifyTail(modelText),
        tailText: modelText.slice(-80),
      });
    }
    const clean = rows.filter((r) => r.tail === "clean").length;
    return {
      n: rows.length,
      clean,
      unclosed: rows.filter((r) => r.tail === "unclosed").length,
      quoteOnly: rows.filter((r) => r.tail === "quote-only").length,
      cleanRate: rows.length === 0 ? null : clean / rows.length,
      samples: rows,
    };
  };
  const recoveredReport = recoveredOf(truncated);
  const controlRecovered = recoveredOf(control);

  // ⑦ 机械兜底
  const repair = {
    constraintRepaired: truncated.filter((r) => Number(r.mark?.qualityRepaired) > 0).length,
    constraintRepairedTotal: truncated.reduce((n, r) => n + Math.max(0, Number(r.mark?.qualityRepaired) || 0), 0),
    failuresRepairedField: truncated.filter((r) => Number.isFinite(Number(r.mark?.quality?.failuresRepaired))).length,
    failureRecallBelow1: truncated.filter((r) => Number(r.mark?.quality?.failureRecall) < 1).map((r) => ({
      session: r.session,
      seqStart: r.mark.seqStart,
      seqEnd: r.mark.seqEnd,
      failureRecall: Number(r.mark?.quality?.failureRecall),
      missingFailures: r.mark?.quality?.missingFailures ?? [],
    })),
  };

  // ⑧ 成本（118 条实际花的钱 + 会开重试的那部分）
  const costKnown = truncated.map((r) => estimateFoldCostUsd(r.mark?.usage ?? null, r.mark?.route?.model ?? null)).filter((x) => x !== null);
  const costTotal = costKnown.reduce((a, b) => a + b, 0);
  const retryRows = truncated.filter((r) => Number(r.mark?.ms) < retryThresholdMs);
  const retryCost = retryRows
    .map((r) => estimateFoldCostUsd(r.mark?.usage ?? null, r.mark?.route?.model ?? null))
    .filter((x) => x !== null)
    .reduce((a, b) => a + b, 0);

  // 判定
  const inputTokensTrunc = describe(truncated.map((r) => Number(r.mark?.usage?.inputTokens)));
  const inputTokensControl = describe(control.map((r) => Number(r.mark?.usage?.inputTokens)));
  const inputLenRatio =
    Number.isFinite(inputTokensTrunc.p50) && Number.isFinite(inputTokensControl.p50) && inputTokensControl.p50 > 0
      ? inputTokensTrunc.p50 / inputTokensControl.p50
      : null;
  const recallNotWorse =
    (quality.truncated.constraintRecall1 ?? 1) >= (quality.control.constraintRecall1 ?? 0) &&
    (quality.truncated.failureRecall1 ?? 1) >= (quality.control.failureRecall1 ?? 0);
  const cleanEndRate = recoveredReport.cleanRate ?? quality.truncated.endedCleanly ?? 0;
  // 提示词"要求篇幅"按**这一批 mark 的实际输入规模**复算（不要拿一个拍来的常数）：
  //   inputTokens 是 token，`suggestedLength` 吃字符 ⇒ 用 CJK 0.6 tok/字符 反算字符数。
  const promptChars = Number.isFinite(inputTokensTrunc.p50) ? Math.round(inputTokensTrunc.p50 / 0.6) : 200_000;
  const requested = suggestedLength(promptChars);
  const withinRequestedLength = charsTrunc.p50 !== null && Number.isFinite(requested.max) ? Number(charsTrunc.p50) <= requested.max : false;
  const verdict = verdictOf({
    total: truncated.length,
    textCapHits,
    cleanEndRate,
    controlCleanEndRate: controlRecovered.cleanRate,
    inputRatio: inputLenRatio,
    withinRequestedLength,
    recallNotWorse,
  });

  // 与 doctor 「891 条有截断证据的 fold 里 118 条被截断」同一套三态口径
  const known = truncated.length + (byEvidence.get("clean") ?? 0);
  const report = {
    home,
    graphs: files,
    foldMarks: total,
    known,
    unknown: byEvidence.get("unknown") ?? 0,
    truncatedRate: known === 0 ? null : truncated.length / known,
    budget,
    hardMaxTokens: HARD_MAX_TOKENS,
    truncated: truncated.length,
    control: control.length,
    byTrigger: Object.fromEntries([...byTrigger.entries()].sort((a, b) => b[1].total - a[1].total)),
    byEvidence: Object.fromEntries([...byEvidence.entries()].sort((a, b) => b[1] - a[1])),
    byFinishReason: Object.fromEntries([...byFinish.entries()].sort((a, b) => b[1] - a[1])),
    summaryChars: { truncated: charsTrunc, control: charsControl, histTrunc, histControl, buckets: buckets.slice(0, -1) },
    outputCap: { budget, textTokens: describe(textTokens), textCapHits, outputTokens: describe(outputTokens), outputCapHits, overHardMax, outOverSummary: describe(ratios), controlOutOverSummary: describe(controlRatios) },
    quality,
    missingSections: Object.fromEntries([...missingDist.entries()].sort((a, b) => b[1] - a[1])),
    recovered: { ...recoveredReport, samples: recoveredReport.samples.filter((r) => r.tail !== "clean") },
    controlRecovered: { n: controlRecovered.n, clean: controlRecovered.clean, unclosed: controlRecovered.unclosed, quoteOnly: controlRecovered.quoteOnly, cleanRate: controlRecovered.cleanRate },
    repair,
    cost: { usd: costTotal, known: costKnown.length, retryRows: retryRows.length, retryUsd: retryCost, retryThresholdMs },
    inputTokens: { truncated: inputTokensTrunc, control: inputTokensControl, ratio: inputLenRatio },
    verdict,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (x) => (x === null || x === undefined ? "?" : `${(Number(x) * 100).toFixed(1)}%`);
  const num = (x) => (x === null || x === undefined ? "—" : String(x));
  const line = (label, a, b) => `   ${String(label).padEnd(24)} ${String(a).padStart(12)} ${String(b).padStart(12)}`;

  console.log("=== 摘要截断审计（只读）===");
  console.log(`home:   ${home}`);
  console.log(`graphs: ${files}    foldMarks: ${total}`);
  console.log(`预算:   budget ≡ ${budget} tok（maxTokens=${maxTokens} · offlineMaxTokens=${offlineMaxTokens} ⇒ budgetCap=` +
    `${Math.max(1024, Math.min(HARD_MAX_TOKENS, offlineMaxTokens))}）  硬上界 HARD_MAX_TOKENS=${HARD_MAX_TOKENS}`);
  console.log("");

  const knownRate = report.known === 0 ? 0 : truncated.length / report.known;
  console.log(`   口径（与 doctor 逐字一致）：**${report.known}** 条有截断证据的 fold 里 **${truncated.length}** 条被截断` +
    `（${pct(knownRate)}），另有 ${report.unknown} 条不知道（两个字段都没有）—— doctor 的口径到这里为止，下面开始拆它`);
  console.log("");

  console.log("① 路径 × 证据 —— 118 条从哪来");
  console.log("   trigger           total   truncated    clean   unknown");
  for (const [trigger, b] of [...byTrigger.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`   ${trigger.padEnd(16)} ${String(b.total).padStart(6)} ${String(b.truncated).padStart(11)} ${String(b.clean).padStart(8)} ${String(b.unknown).padStart(9)}`);
  }
  console.log("   ── 判据（looksTruncated 哪一条命中的）──");
  for (const [key, n] of [...byEvidence.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${key.padEnd(16)} ${String(n).padStart(6)}   ${EVIDENCE[key] ?? ""}`);
  console.log("   ── finishReason 分布（全库）──");
  for (const [key, n] of [...byFinish.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`   ${key.padEnd(16)} ${String(n).padStart(6)}`);
  console.log("");

  console.log("② 截断位置：summaryChars 分布（vs 同 trigger `archive-offline` 未截断对照）");
  console.log(line("", `截断(${charsTrunc.n})`, `对照(${charsControl.n})`));
  for (const key of ["min", "p10", "p50", "p90", "max", "mean"]) console.log(line(key, charsTrunc[key], charsControl[key]));
  console.log("   直方图（字符 → 条数）");
  for (let i = 0; i < histTrunc.length; i += 1) {
    const label = buckets[i + 1] === Infinity ? `${buckets[i]}+` : `${buckets[i]}–${buckets[i + 1]}`;
    console.log(line(label, histTrunc[i], histControl[i]));
  }
  console.log("");

  console.log("③ 是不是到了输出上限（正文 token 与预算用**同一个** CJK 估算器）");
  console.log(`   正文 token（quality.summaryTokens）: p50 ${num(report.outputCap.textTokens.p50)} · max ${num(report.outputCap.textTokens.max)}` +
    ` ⇒ **${textCapHits}/${truncated.length}** 条 ≥ budget(${budget})（${pct(truncated.length ? textCapHits / truncated.length : 0)}）`);
  console.log(`   provider outputTokens（含 reasoning）: p50 ${num(report.outputCap.outputTokens.p50)} · max ${num(report.outputCap.outputTokens.max)}` +
    ` ⇒ **${outputCapHits}/${truncated.length}** 条 ≥ budget（${pct(truncated.length ? outputCapHits / truncated.length : 0)}）`);
  console.log(`   其中 ${overHardMax}/${truncated.length} 条 outputTokens > 硬上界 ${HARD_MAX_TOKENS} ⇒ provider **不按 max_tokens 夹 outputTokens**（reasoning 在限额之外）`);
  console.log(`   outputTokens ÷ 正文 token：截断 p50 ${Number(report.outputCap.outOverSummary.p50).toFixed(2)}× / 对照 p50 ${Number(report.outputCap.controlOutOverSummary.p50).toFixed(2)}×（CHANGELOG C73 记过 1.6×–11.6×）`);
  console.log("");

  console.log("④ 质量对比（截断 vs 同 trigger 对照）");
  console.log(line("指标", `截断(${quality.truncated.n})`, `对照(${quality.control.n})`));
  console.log(line("constraintRecall = 1", pct(quality.truncated.constraintRecall1), pct(quality.control.constraintRecall1)));
  console.log(line("failureRecall = 1", pct(quality.truncated.failureRecall1), pct(quality.control.failureRecall1)));
  console.log(line("sectionsMissing = []", pct(quality.truncated.sectionsMissing0), pct(quality.control.sectionsMissing0)));
  console.log(line("endedCleanly", pct(quality.truncated.endedCleanly), pct(quality.control.endedCleanly)));
  console.log(line("summaryTokens p50", quality.truncated.summaryTokens.p50, quality.control.summaryTokens.p50));
  console.log(`   缺的段落：${[...missingDist.entries()].map(([k, v]) => `${k} ${v}`).join(" · ") || "（无）"}`);
  console.log("");

  console.log("⑤ 正文实证（能从 lastOfflineSummary 取回原文的 mark：剪掉机械补回段再看结尾）");
  console.log(line("", `截断(${recoveredReport.n})`, `对照(${controlRecovered.n})`));
  console.log(line("完整收尾", recoveredReport.clean, controlRecovered.clean));
  console.log(line("行尾没收尾", recoveredReport.unclosed, controlRecovered.unclosed));
  console.log(line("仅引号/括号不配平", recoveredReport.quoteOnly, controlRecovered.quoteOnly));
  console.log(line("完整收尾率", pct(recoveredReport.cleanRate), pct(controlRecovered.cleanRate)));
  console.log(`   ⇒ 两组几乎相同（差 ${recoveredReport.cleanRate === null || controlRecovered.cleanRate === null ? "?" : ((recoveredReport.cleanRate - controlRecovered.cleanRate) * 100).toFixed(1)} 个点）` +
    " ⇒ 「断在半句」是**模型/提示词的基线行为**，与 truncated 无关");
  for (const s of recoveredReport.samples.filter((r) => r.tail === "unclosed").slice(0, 5)) {
    console.log(`   ✗ ${String(s.session).slice(0, 8)} #${s.seqStart}-${s.seqEnd} 断在：${JSON.stringify(s.tailText)}`);
  }
  console.log("");

  console.log("⑥ 机械补回兜底");
  console.log(`   约束补回（C522）: ${repair.constraintRepaired}/${truncated.length} 条有过补回，共补 ${repair.constraintRepairedTotal} 条约束`);
  console.log(`   死路补回（C607/C641）: ${repair.failuresRepairedField}/${truncated.length} 条带 failuresRepaired 字段` +
    `（构建早于 C641 时为 0 —— 这批 mark 的构建就没有这个字段）`);
  console.log(`   failureRecall < 1 的: ${repair.failureRecallBelow1.length} 条` +
    (repair.failureRecallBelow1.length === 0 ? "" : ` —— ${repair.failureRecallBelow1.map((r) => r.missingFailures.join("/") || "?").join(" · ")}`));
  console.log("");

  console.log("⑦ 成本");
  console.log(`   这 ${costKnown.length} 条折叠实花 ≈ $${costTotal.toFixed(4)}（flash 低谷价；其中正文 token 可测的 ${report.outputCap.textTokens.n} 条）`);
  console.log(`   其中 ${retryRows.length}/${truncated.length} 条（ms < ${Math.round(retryThresholdMs)}ms）满足「放大 2× 重试」条件` +
    ` ⇒ 假阳性每次白付一次摘要调用 ≈ $${retryCost.toFixed(4)}`);
  console.log("");

  console.log("⑧ 根因判定");
  console.log(`   A 输出预算太小？ 否 —— 正文撞顶 ${textCapHits}/${truncated.length}（max ${num(report.outputCap.textTokens.max)} < ${budget}）；` +
    `且只改 maxTokens 对离线预算恒等于 ${offlineBudget(16384, offlineMaxTokens)}（budgetCap 来自 offlineMaxTokens）`);
  console.log(`   B 提示词太长？   否 —— 提示词要求 ${requested.min}–${requested.max} 字，模型写 ${num(charsTrunc.p50)} 字（${(Number(charsTrunc.p50) / requested.max).toFixed(2)}× 上限）`);
  console.log(`   C 输入太长？     否 —— 截断组输入 p50 ${num(inputTokensTrunc.p50)} vs 对照 ${num(inputTokensControl.p50)}（${inputLenRatio === null ? "?" : `${inputLenRatio.toFixed(2)}×`}），` +
    `收尾完整率 ${pct(recoveredReport.cleanRate)} vs 对照 ${pct(controlRecovered.cleanRate)}`);
  console.log(`   D 正常           ${verdict.verdict === "D" ? "✅" : "✗"}`);
  console.log(`   ⇒ **${verdict.verdict}** —— ${verdict.why}`);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
