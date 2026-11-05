/**
 * summary-truncation.test.mjs —— **「13% 摘要被截断」到底是真截断，还是仪器假阳性**（T40 / C648）
 *
 * 真机证据（2026-11-05 08:2x，`node scripts/doctor.mjs`）：
 *
 *   ! 摘要截断（finish_reason=length） — 891 条有截断证据的 fold 里 **118** 条被截断
 *
 * 审计器（`node scripts/summary-truncation-audit.mjs`）把 118 条拆开之后，结论是 **D（正常）**：
 *
 *   · **正文从来没撞顶**：`quality.summaryTokens`（与预算**同一个** CJK 估算器）最大 6,379 < 8,192
 *     ⇒ 0/118 条正文 ≥ 预算。撞顶的是 `usage.outputTokens` —— 它**含 reasoning**
 *     （CHANGELOG C73 记过；本机实测 outputTokens ÷ 正文 token 中位 3.40×）；
 *   · **截断组比对照更长**（summaryChars p50 7,131 vs 6,551）—— 真截断应该更短且在预算处堆积；
 *   · **质量不劣于对照**：constraintRecall 100.0% vs 99.9%、failureRecall 98.3% vs 97.0%；
 *   · **收尾完整率与对照无差别**：78.4% vs 77.7%（差 0.7 个点）—— 「断在半句」是模型基线，
 *     与 `truncated` 无关；
 *   · **残留 2/118（1.7%）丢死路**，由 C607/C641 的写回点机械补回兜住（本文件钉住）。
 *
 * ⇒ **不改 `maxTokens`，也不改分段阈值**。这个文件钉五件事：
 *   ① 预算公式：**只改 `maxTokens` 对离线预算恒等于 8192**（A 类在公式层就是空操作）；
 *   ② 判据拆解：`truncated` 只由「provider 输出（含 reasoning）≥ 正文预算」触发；
 *   ③ 假阳性可复现：正文完整收尾 + outputTokens 撞预算 ⇒ `truncated: true`，而正文 token 远低于预算；
 *   ④ 根因判定的四个分支**各自可达**（否则「判定函数」会退化成恒 D 的橡皮图章）；
 *   ⑤ 兜底真红：模型真断在死路中间时，写回点的机械补回把 `failureRecall` 拉回 1 ——
 *     **把补回拆掉（变异副本）必须掉回 0**，证明 ④⑤ 的绿不是假绿。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HARD_MAX_TOKENS,
  applyOfflineFoldToGraph,
  runOfflineFold,
} from "../src/rooms/offline-fold.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import {
  DEFAULT_MAX_TOKENS,
  classifyEvidence,
  classifyTail,
  offlineBudget,
  stripRepairSections,
  verdictOf,
} from "../scripts/summary-truncation-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const SRC = nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs");
const TMP = nodePath.join(HERE, ".tmp-summary-truncation");

/* ────────────────────────── 夹具 ────────────────────────── */

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/** 最小图：一条用户约束 + 一条在 [2,3] 区间内的失败边 `e1`。 */
const graph = () => ({
  rootUserNodeIds: ["n1"],
  order: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] } },
  edges: {
    e1: {
      id: "e1",
      from: "n1",
      to: "n2",
      intent: "改 prod 配置",
      action: "edit(prod.yml)",
      result: "failure",
      errorSnippet: "EACCES: permission denied",
      evidence: { start: 2, end: 3 },
    },
  },
});
const events = () => [u(1, "把构建跑通"), a(2, "先看配置"), u(3, "别动 prod")];
const measure = ({ graph: g, range, summaryText }) => measureFoldQuality({ graph: g, range, summaryText });

/** 完整收尾的摘要（含死路 e1）—— 真机里那 78.4% 的形状。 */
const COMPLETE = [
  "## 目标",
  "- 把构建跑通（硬约束：不许动 prod 配置）",
  "",
  "## 棋谱",
  "- n1 用户要求跑通构建 → 定位到配置缺失",
  "",
  "## 已探明死路",
  "- e1 「edit(prod.yml)」→ EACCES: permission denied",
  "",
  "## 当前节点",
  "- 停在 n1，还差一次构建。",
].join("\n");

/** **真被切断**的摘要：死路一条没写（连 id 都没有），且最后一行停在冒号上。 */
const CUT = [
  "## 目标",
  "- 把构建跑通（硬约束：不许动 prod 配置）",
  "",
  "## 棋谱",
  "- n1 用户要求跑通构建 → 定位到配置缺失",
  "",
  "## 约束（逐字）",
  "- 不许动 prod 配置",
  "- 要求：",
].join("\n");

/** 造一个 chunk（写回点的输入形状）。 */
const chunkOf = (text, quality) => ({ chunks: [{ start: 1, end: 3, text, quality, repaired: 0, truncated: true }] });

/**
 * **变异副本**：把写回点的「死路机械补回」拆掉，其余逐字不变。
 *
 * 为什么要有它：`failureRecall = 1` 这条断言有两种可能的解释 —— ①补回真的在跑；
 * ②测试自己写了个恒真的夹具。只有把补回拆掉的副本**必须掉到 0**，才能排除②。
 * 这是本仓库的既有纪律（`test/engine-retry-assembler.test.mjs` 的 `.engine-under-test*` 同一套做法）。
 *
 * 副本落在 `test/.tmp-summary-truncation/`（不写 `src/`，跑完自己删），
 * 相对 import 改写成**绝对 file:// URL**，否则从临时目录解析不到。
 */
async function loadMutant() {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  nodeFs.mkdirSync(TMP, { recursive: true });
  const original = nodeFs.readFileSync(SRC, "utf8");
  const kifuUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "kifu-model.mjs")).href;
  const qualityUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "fold-quality.mjs")).href;
  const target = "const filled = repairFailuresInText(graphRef, { start: chunk.start, end: chunk.end }, chunk.text);";
  if (!original.includes(target)) {
    throw new Error(`变异点没找到（源码改了？）—— 这条自检必须跟着改：${target}`);
  }
  const patched = original
    .replace('from "./kifu-model.mjs"', `from ${JSON.stringify(kifuUrl)}`)
    .replace('from "./fold-quality.mjs"', `from ${JSON.stringify(qualityUrl)}`)
    .replace(target, "const filled = { text: chunk.text, repaired: [] };");
  if (patched === original || patched.includes(target)) throw new Error("变异没生效 —— 自检会变成假绿");
  const file = nodePath.join(TMP, "offline-fold-mutant.mjs");
  nodeFs.writeFileSync(file, patched, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
  }
}

/* ────────────────────────── ① 预算公式 ────────────────────────── */

tests["C648 预算公式：只改 maxTokens 对离线预算恒等于 8192（「A 提高 maxTokens」是空操作）"] = (t) => {
  t.eq(offlineBudget(DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS), 8192, "默认配置下离线预算就是 8192");
  t.eq(offlineBudget(16384, 8192), 8192, "**只把 maxTokens 提到 16384，离线预算还是 8192** —— budgetCap 来自 offlineMaxTokens");
  t.eq(offlineBudget(16384, 16384), 16384, "只有 offlineMaxTokens 也提上去，预算才真的变大");
  t.eq(offlineBudget(65536, 65536), HARD_MAX_TOKENS, `预算被硬上界夹住（${HARD_MAX_TOKENS}）—— 提高上限不等于放开上限`);
  t.eq(DEFAULT_MAX_TOKENS, 8192, "默认值与 config-schema 的 maxTokens 默认一致");
};

/* ────────────────────────── ② 判据拆解 ────────────────────────── */

tests["C648 判据拆解：truncated 由「provider 输出（含 reasoning）≥ 正文预算」触发，而不是正文撞顶"] = (t) => {
  t.eq(classifyEvidence({ truncated: true, usage: { outputTokens: 9944 } }, 8192), "output-cap", "输出 token 撞预算 ⇒ output-cap");
  t.eq(classifyEvidence({ truncated: true, usage: { outputTokens: 307 } }, 8192), "skeleton", "没撞预算又判了截断 ⇒ 只可能是 C534 的骨架判据");
  t.eq(classifyEvidence({ truncated: true, usage: { outputTokens: 9000 }, finishReason: "length" }, 8192), "finish-max", "finish 是截断类 ⇒ 先判它");
  t.eq(classifyEvidence({ truncated: true, usage: { outputTokens: 9000 }, finishReason: "max_tokens" }, 8192), "finish-max", "max_tokens 也算截断类");
  // ★ 侧记（R07，这次不动代码）：C535 写的是 `max(assumed)`，而 `isTruncatedFinish` 只认
  //   `max_tokens` / `length` 两种写法 ⇒ 「撞满 98% 反推出来的截断」在 doctor 里永远落进「不知道」。
  t.eq(isTruncatedFinish("max(assumed)"), false, "max(assumed) 不是 close 集里的写法 —— 这是仪器的一个已知盲区（见报告）");
  t.eq(classifyEvidence({ truncated: false, usage: { outputTokens: 9999 } }, 8192), "clean", "写入点说没截断 ⇒ clean（不看 token）");
  t.eq(classifyEvidence({}, 8192), "unknown", "两个字段都没有 ⇒ 不知道，不许并进 clean");
  // ★ 关键：同一条 mark 里「正文 token」远低于预算，却因为 outputTokens 撞顶被判截断
  const real = { truncated: true, usage: { outputTokens: 9944 }, quality: { summaryTokens: 2994 } };
  t.eq(real.quality.summaryTokens < 8192, true, "真机形态：正文 2,994 token 远低于 8,192 预算");
  t.eq(classifyEvidence(real, 8192), "output-cap", "而判据仍然说「撞顶」—— 撞的是含 reasoning 的那个数");
};

/* ────────────────────────── ③ 假阳性可复现 ────────────────────────── */

tests["C648 假阳性复现：正文完整收尾 + outputTokens 撞预算 ⇒ truncated:true（这就是那 118 条）"] = async (t) => {
  const out = await runOfflineFold({
    graph: graph(),
    events: events(),
    rangeStart: 1,
    rangeEnd: 3,
    maxTokens: 4000,
    // 预算是 4,000；provider 报的输出是 9,000（reasoning 占大头）—— 正文只有几百 token
    callModel: async () => ({ text: COMPLETE, usage: { outputTokens: 9000 }, model: "fake" }),
    measureQuality: measure,
  });
  const chunk = out.chunks[0];
  t.eq(chunk.truncated, true, "outputTokens ≥ budget ⇒ 判「被截断」（旧判据的原样行为）");
  t.eq(chunk.quality.endedCleanly, true, "**但正文是完整收尾的** —— 这就是假阳性");
  t.eq((chunk.quality.sectionsMissing ?? []).length, 0, "七段该有的都在（目标/棋谱/死路）");
  t.eq(chunk.quality.summaryTokens < 4000, true, `正文只有 ${chunk.quality.summaryTokens} token，远低于 4,000 预算 —— 上限没有卡住它`);
  t.eq(chunk.quality.failureRecall, 1, "死路 id 逐条写出（failureRecall = 1）");
};

/* ────────────────────────── ④ 根因判定四分支可达 ────────────────────────── */

tests["C648 根因判定：D（真机形态）与 A/B/C 三个反例各自可达 —— 判定函数不许是恒 D 的橡皮图章"] = (t) => {
  // 真机形态：正文 0 条撞顶、收尾率与对照无差别、召回不劣 ⇒ D
  const real = verdictOf({
    total: 118,
    textCapHits: 0,
    cleanEndRate: 40 / 51,
    controlCleanEndRate: 241 / 310,
    inputRatio: 13946 / 12909,
    withinRequestedLength: false,
    recallNotWorse: true,
  });
  t.eq(real.verdict, "D", `真机数字必须判 D（实际 ${real.verdict}：${real.why}）`);
  t.includes(real.why, "仪器假阳性", "D 的结论要写清「是仪器在撒谎」");

  // A：正文撞顶占多数 ⇒ 提高 maxTokens 才有意义
  t.eq(verdictOf({ total: 10, textCapHits: 9, cleanEndRate: 0.1, controlCleanEndRate: 0.9 }).verdict, "A", "正文撞顶 90% ⇒ A");

  // B：模型写在「要求篇幅」以内仍然撞顶 ⇒ 是提示词要的篇幅超预算
  t.eq(verdictOf({ total: 10, textCapHits: 4, withinRequestedLength: true, cleanEndRate: 0.5, controlCleanEndRate: 0.9 }).verdict, "B", "篇幅没超要求却撞顶 ⇒ B");

  // C：输入是对照的 2×，且收尾完整率比对照低 40 个点 ⇒ 该分段
  t.eq(
    verdictOf({ total: 10, textCapHits: 0, cleanEndRate: 0.4, controlCleanEndRate: 0.85, inputRatio: 2.0, recallNotWorse: true }).verdict,
    "C",
    "输入翻倍且收尾明显更差 ⇒ C",
  );

  // D 的守门：收尾率比对照低 20 个点以上时，**不许**再判 D
  t.ne(verdictOf({ total: 10, textCapHits: 0, cleanEndRate: 0.3, controlCleanEndRate: 0.85, inputRatio: 2.0, recallNotWorse: true }).verdict, "D", "收尾明显更差时判 D 就是放水");
};

/* ────────────────────────── ⑤ 兜底真红 ────────────────────────── */

tests["C648 兜底：模型真断在死路中间 ⇒ 写回点机械补回把 failureRecall 拉回 1（C607/C641）"] = async (t) => {
  // 引擎路径（runOfflineFold）自己会补一次；脚本路径**只经过写回点** —— 两条路都必须兜住，
  // 所以这里直接打写回点（`applyOfflineFoldToGraph`），输入是**未经补回**的模型正文。
  const rawQuality = measureFoldQuality({ graph: graph(), range: { start: 1, end: 3 }, summaryText: CUT });
  t.eq(rawQuality.failureRecall, 0, "模型自己的正文里没有 e1 ⇒ **补回前 recall = 0**（这就是「真丢」）");
  t.eq(rawQuality.missingFailures.includes("e1"), true, "补回前的缺失清单必须点名 e1");

  const g = { ...graph(), foldMarks: [] };
  applyOfflineFoldToGraph(g, chunkOf(CUT, rawQuality), { now: 1, provider: "offline", model: "fake" });
  const mark = g.foldMarks[0];
  t.eq(mark.quality.failureRecall, 1, "写回点的机械补回覆盖了漏写的死路 ⇒ failureRecall = 1");
  t.eq((mark.quality.missingFailures ?? []).length, 0, "missingFailures 必须清空（不许留着当「已知丢失」）");
  // 最后一段的正文只存一份（`summaryTextRef` 指到 lastOfflineSummary，见 C642）
  t.includes(g.lastOfflineSummary?.text ?? "", "e1", "补回段里必须逐字带上 e1");
};

tests["C648 守卫自检：把写回点的机械补回拆掉，failureRecall 必须掉回 0（证明上一条不是假绿）"] = async (t) => {
  const mutant = await loadMutant();
  const rawQuality = measureFoldQuality({ graph: graph(), range: { start: 1, end: 3 }, summaryText: CUT });
  // 同一份 chunk（模型没写死路），走**拆掉补回**的副本
  const g = { ...graph(), foldMarks: [] };
  mutant.applyOfflineFoldToGraph(g, chunkOf(CUT, rawQuality), { now: 1 });
  t.eq(g.foldMarks[0].quality.failureRecall, 0, "拆掉补回 ⇒ failureRecall 掉回 0（上一条的绿确实依赖补回）");
  t.eq((g.foldMarks[0].quality.missingFailures ?? []).includes("e1"), true, "而且 missingFailures 里必须点名 e1");

  // 真模块：同一份输入必须是 1
  const real = { ...graph(), foldMarks: [] };
  applyOfflineFoldToGraph(real, chunkOf(CUT, rawQuality), { now: 1 });
  t.eq(real.foldMarks[0].quality.failureRecall, 1, "真模块 = 1 ⇒ 两个模块的唯一差别就是补回");
  t.includes(real.lastOfflineSummary?.text ?? "", "## 已探明死路（逐字补充", "真模块的正文里必须有补回段");
  t.notIncludes(g.lastOfflineSummary?.text ?? "", "## 已探明死路（逐字补充", "副本的正文里必须没有（否则变异没生效）");
};

/* ────────────────────────── ⑥ 正文实证的两个纯函数 ────────────────────────── */

tests["C648 正文实证：剪掉机械补回段才看得见「模型自己断在哪」，行尾分类三分"] = (t) => {
  const repaired = `${CUT}\n\n## 已探明死路（逐字补充 · 机械补回，不许重试）\n- e1 「改 prod 配置」→ EACCES: permission denied`;
  const stripped = stripRepairSections(repaired);
  t.eq(stripped.repairedSections, 1, "认得出 1 段机械补回");
  t.eq(stripped.modelText.includes("（逐字补充"), false, "补回段被剪掉了");
  t.eq(classifyTail(stripped.modelText), "unclosed", "模型最后一行停在「：」⇒ 真的断在半句");

  t.eq(classifyTail(COMPLETE), "clean", "完整收尾 ⇒ clean");
  // 死路行里的**嵌套命令引号**：行尾是完整标点，只是引号不配平 —— 不许算成「断在半句」
  t.eq(classifyTail('- e20 "bash(command=cd /tmp && node extract.js "E:\\A\\app.a")" → exit=0'), "clean", "引号配平 + 完整标点");
  t.eq(classifyTail('- e53 "bash(command=cat "/d/x/dsh-pr" → {'), "unclosed", "停在半个参数上 ⇒ 真断");
  t.eq(classifyTail(""), "unclosed", "空正文谈不上收尾");
};
