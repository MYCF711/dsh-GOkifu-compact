/**
 * retry-discard.test.mjs —— 「放大 2× 重试，结果被丢弃」的守卫（T44）
 *
 * ## 这个文件钉的是什么
 *
 * `runOfflineFold` 的重试路径：首调被判截断 ⇒ 用 `retryBudget = min(HARD_MAX_TOKENS, max(1024, budget×2))`
 * 再调一次。但 `looksTruncated(bigger)` 里比的是**第一次的 `budget`** ⇒
 * 重试正文落在 `[budget, 2×budget)` 时被判「仍然截断」并**丢弃** ——
 * 而那正是重试**成功**的形状（模型写得更长了，只是没到 2×）。白付一次调用，还把更好的结果扔掉。
 *
 * 三条夹具（与任务书一一对应，也对应 `node test/run.mjs retry-discard` 打出来的三行）：
 *
 *   ① **采用**   —— 重试正文 9,000 token ∈ `[8,192, 16,384)` ⇒ 必须用重试那份（旧实现丢）；
 *   ② **仍截断** —— 重试正文仍是**骨架**（280 字符 < 400，而 prompt > 4,000）⇒ 仍然判截断（不许放宽）；
 *   ③ **又撞顶** —— 重试正文 = 16,384 token（= 2×budget）⇒ 判截断（真的又撞顶）。
 *
 * ## 「不许放宽」在这里到底指什么（一条容易写歪的口径）
 *
 * 判据本体是 `estimateTokens(正文) >= 预算` ⇒ **正文 < 预算 = 没撞顶 = 不截断**，这是 C649 的语义，
 * 不能为了「别放宽」把它改成 `<=`（`test/truncation-criteria.test.mjs` 的反例：正文 3,000 token
 * 配 outputTokens 20,000 ⇒ **不许**报）。所以「重试结果仍然 < budget ⇒ 仍然判截断」唯一能落地的分支
 * 是 **C534 骨架判据**：正文短到只剩骨架（< 400 字符）时仍然判截断 —— ② 钉的就是这一条。
 *
 * 另外两条「不许放宽」的硬约束，夹具里一并钉住：
 *   · **首调仍按 `budget` 判**：① 的首调正文正好 = 8,192 token ⇒ 必须触发重试（`calls.length === 2`）。
 *     谁把 `retryBudget` 传到第一个调用点，这里立刻红 —— 那等于把首调的闸门放松一倍；
 *   · **判据本体一个字不动**：源码里三条判据必须与 C649 逐字相同（最后一条用例）。
 *
 * ## 失败分支必须真红
 *
 * `looksTruncated` 是 `runOfflineFold` 里的闭包，从外面打不到。所以最后一条用例把源码复制一份、
 * 把**重试那一处调用点**换回旧写法（`looksTruncated(bigger, budget)`），再跑同一条夹具①——
 * 旧实现必须交回 `truncated: true` 且正文是首调那份。副本落在 `test/.tmp-retry-discard/`
 * （不写 `src/`，跑完自己删），相对 import 改写成绝对 `file://` URL，否则从临时目录解析不到。
 *
 * 真机依据（`node scripts/retry-discard-audit.mjs`）：确证 68 条「付了两次、只用第一次」，
 * 白付 $0.5425；被丢掉那次的字节从未落盘 ⇒ 这类缺陷在指标上是隐形的，只能靠夹具钉住。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HARD_MAX_TOKENS, estimateTokens, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { DISCARD, retryBudgetOf, discardStateOf } from "../scripts/retry-discard-audit.mjs";
import { DEFAULT_FOLD_TIMEOUT_MS, DEFAULT_MAX_TOKENS, DEFAULT_OFFLINE_MAX_TOKENS, offlineBudget } from "../scripts/summary-truncation-audit.mjs";
import { retryThresholdMs } from "../scripts/truncation-criteria-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const TMP = nodePath.join(HERE, ".tmp-retry-discard");
const SOURCE = nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs");

/** 默认配置下的离线预算（引擎那侧 `budgetCap` 夹回 8,192）与它的 2×。 */
const BUDGET = offlineBudget(DEFAULT_MAX_TOKENS, DEFAULT_OFFLINE_MAX_TOKENS);
const RETRY_BUDGET = retryBudgetOf(BUDGET);

/* ────────────────────────── 夹具 ────────────────────────── */

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/**
 * 长 prompt（> 4,000 字符）—— 骨架判据的 `fed > 4000` 那一项才成立。
 * 每条消息被 `perMessageChars = 2000` 夹过，所以要**三条**才撑得到 4,000 以上。
 */
const events = () => [u(1, "把构建跑通"), a(2, "x".repeat(2000)), u(3, "y".repeat(2000))];

/** 不带失败边/约束的最小图 —— 机械补回不会改写正文，断言可以直接比字符串。 */
const graph = () => ({
  rootUserNodeIds: ["n1"],
  order: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: [] } },
  edges: {},
});

/** 造一段 `estimateTokens` 正好等于 `tokens` 的正文（全 ASCII ⇒ 0.3 token/字符）。 */
function bodyOf(tokens) {
  let n = Math.ceil(Number(tokens) / 0.3);
  while (estimateTokens("a".repeat(n)) < Number(tokens)) n += 1;
  while (n > 0 && estimateTokens("a".repeat(n)) > Number(tokens)) n -= 1;
  return "a".repeat(n);
}

/**
 * 跑一次离线折叠：第 i 次模型调用返回 `texts[i]`（不够就复用最后一条）。
 * 记录每次调用的 `maxTokens` —— 夹具要证明「重试那次拿到的真的是 retryBudget」。
 */
async function fold({ texts, usages = [10_000, 12_000] }) {
  const calls = [];
  const out = await runOfflineFold({
    graph: graph(),
    events: events(),
    rangeStart: 1,
    rangeEnd: 3,
    maxChars: 60_000,
    maxChunks: 1,
    maxTokens: BUDGET,
    maxTokensCap: BUDGET,
    deadline: Date.now() + 240_000,
    callModel: async (_prompt, opts) => {
      calls.push(opts?.maxTokens);
      const i = calls.length - 1;
      return { text: texts[Math.min(i, texts.length - 1)], usage: { outputTokens: usages[Math.min(i, usages.length - 1)] }, model: "fake" };
    },
  });
  return { chunk: out.chunks[0], calls };
}

/* ────────────────────────── ① 采用 ────────────────────────── */

tests["T44① 重试正文落在 [budget, 2×budget) ⇒ **必须采用**（旧实现丢弃）"] = async (t) => {
  t.eq(BUDGET, 8192, "默认配置下离线预算恒 = 8,192（口径写死在审计与夹具里，先自证）");
  t.eq(RETRY_BUDGET, HARD_MAX_TOKENS, "retryBudget = min(16,384, 2×8,192) = 16,384");

  const first = bodyOf(BUDGET); // 正好撞顶 ⇒ 首调判截断 ⇒ 开重试
  const retry = bodyOf(9_000); // ∈ [8,192, 16,384) —— 缺陷形态的那一格
  const { chunk, calls } = await fold({ texts: [first, retry] });

  t.eq(calls.length, 2, "首调正文 = budget ⇒ 必须触发重试（首调仍按 budget 判，没被放宽）");
  t.eq(calls[1], RETRY_BUDGET, "重试那次调用拿到的 max_tokens 必须 = retryBudget，不是 budget");
  t.eq(chunk.truncated, false, "重试正文 9,000 token < 16,384 ⇒ **不许**再判截断（旧实现这里就是丢弃点）");
  t.eq(chunk.text, retry, "必须用重试那份正文 —— 它比首调长，是更好的结果");
  t.eq(chunk.usage?.outputTokens, 12_000, "usage 也要换成重试那份（否则账上记的是被丢弃那次的钱）");
};

/* ────────────────────────── ② 仍截断（不许放宽） ────────────────────────── */

tests["T44② 重试正文仍是骨架（< 400 字符）⇒ 仍然判截断，不许因为“是重试”就放行"] = async (t) => {
  const first = bodyOf(BUDGET);
  const retry = "a".repeat(280); // < 400 字符 ⇒ C534 骨架判据；estimateTokens = 84，远 < 任何预算
  const { chunk, calls } = await fold({ texts: [first, retry], usages: [10_000, 16_384] });

  t.eq(calls.length, 2, "重试开过");
  t.eq(estimateTokens(retry) < BUDGET, true, "这条重试正文确实远 < budget（84 token）");
  t.eq(chunk.truncated, true, "骨架仍然判截断 —— 判据更准不等于更松");
  t.eq(chunk.text, first, "被丢弃的骨架不许顶掉首调那份完整正文");
};

/* ────────────────────────── ③ 又撞顶 ────────────────────────── */

tests["T44③ 重试正文 = 2×budget ⇒ 仍判截断（真的又撞顶）"] = async (t) => {
  const first = bodyOf(BUDGET);
  const retry = bodyOf(RETRY_BUDGET); // 正好 16,384 token = 本次调用的上限
  const { chunk, calls } = await fold({ texts: [first, retry], usages: [10_000, 16_384] });

  t.eq(calls.length, 2, "重试开过");
  t.eq(estimateTokens(retry), RETRY_BUDGET, "重试正文正好等于 retryBudget（>= 不是 >）");
  t.eq(chunk.truncated, true, "正文撞满 2×budget ⇒ 仍然是截断，得让 doctor / 图看得见");
  t.eq(chunk.text, first, "撞顶的那份不采用（首调那份同样截断，但至少有据可查）");
};

/* ────────────────────────── ④ 审计器口径 ────────────────────────── */

tests["T44④ 审计器的“丢弃”判定只认能证明的那一档（ms 门槛 + truncated）"] = (t) => {
  const threshold = retryThresholdMs(DEFAULT_FOLD_TIMEOUT_MS, DEFAULT_OFFLINE_MAX_TOKENS);
  t.eq(threshold, 240_000 / 2.2, "门槛 = max(240,000, 8,192×25) ÷ 2.2 —— 与重试条件 spentMs < D/2.2 同源");
  t.eq(discardStateOf({ truncated: true, ms: 1_000 }, threshold), DISCARD.discarded, "ms < 门槛 ⇒ 重试一定开过且没被采用");
  t.eq(discardStateOf({ truncated: true, ms: 200_000 }, threshold), DISCARD.unjudgeable, "ms ≥ 门槛 ⇒ 不可判，不许写成“没付”");
  t.eq(discardStateOf({ truncated: false, ms: 1_000 }, threshold), DISCARD.kept, "truncated=false ⇒ 要么没重试，要么重试被采用");
  t.eq(discardStateOf({ ms: 1_000 }, threshold), DISCARD.missing, "字段缺失（旧 mark）单独一档，别并进上面任何一档");
  t.eq(retryBudgetOf(4096), 8192, "retryBudget 的两倍关系（小预算档）");
};

/* ────────────────────────── ⑤ 判据本体不许动 ────────────────────────── */

tests["T44⑤ 只加了参数：三条判据与两处调用点逐字可查（函数体一个字没动）"] = (t) => {
  const src = nodeFs.readFileSync(SOURCE, "utf8");
  t.includes(src, "const looksTruncated = (r, callBudget = budget) => {", "签名接受“本次调用的预算”，默认是 budget");
  t.includes(src, "const budget = callBudget;", "只多绑一个局部名 —— 下面三条判据因此逐字不变");
  t.includes(src, 'if (estimateTokens(String(r?.text ?? "")) >= budget) return true;', "判据①（C649 正文 token）逐字未动");
  t.includes(src, 'if (produced < 400 && (fed > 4000 || (Number.isFinite(used) && used >= budget))) return true;', "判据②（C534 骨架）逐字未动");
  t.includes(src, "let truncated = looksTruncated(out, budget);", "首调调用点：传 budget");
  t.includes(src, "if (!looksTruncated(bigger, retryBudget) && String(bigger?.text ?? \"\").trim() !== \"\") {", "重试调用点：传 retryBudget");
  t.notIncludes(src, "looksTruncated(bigger) &&", "旧写法必须彻底消失（否则缺陷还在）");
};

/* ────────────────────────── ⑥ 失败分支必须真红（变异副本） ────────────────────────── */

/**
 * 变异副本：把**重试那一处调用点**换回旧写法（其余逐字不变）。
 *
 * 这就是缺陷本身：重试的结果仍然拿第一次的 `budget` 去判。
 */
async function loadMutant() {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  nodeFs.mkdirSync(TMP, { recursive: true });
  const kifuUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "kifu-model.mjs")).href;
  const qualityUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "fold-quality.mjs")).href;
  const src = nodeFs.readFileSync(SOURCE, "utf8");
  const fixed = "looksTruncated(bigger, retryBudget)";
  if (!src.includes(fixed)) throw new Error(`变异点没找到（调用点改了？）—— 这条自检必须跟着改：${fixed}`);
  const mutated = src
    .replace('from "./kifu-model.mjs"', `from ${JSON.stringify(kifuUrl)}`)
    .replace('from "./fold-quality.mjs"', `from ${JSON.stringify(qualityUrl)}`)
    .replace(fixed, "looksTruncated(bigger, budget)");
  if (mutated === src) throw new Error("变异没生效 —— 自检会变成假绿");
  const file = nodePath.join(TMP, "offline-fold-mutant.mjs");
  nodeFs.writeFileSync(file, mutated, "utf8");
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod.runOfflineFold;
  } catch (error) {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
    throw error;
  }
}

tests["T44⑥ 真红自检：把重试调用点换回 `looksTruncated(bigger)`，夹具①必须翻成“丢弃”"] = async (t) => {
  const runMutant = await loadMutant();
  try {
    const first = bodyOf(BUDGET);
    const retry = bodyOf(9_000);
    const calls = [];
    const out = await runMutant({
      graph: graph(),
      events: events(),
      rangeStart: 1,
      rangeEnd: 3,
      maxChars: 60_000,
      maxChunks: 1,
      maxTokens: BUDGET,
      maxTokensCap: BUDGET,
      deadline: Date.now() + 240_000,
      callModel: async (_prompt, opts) => {
        calls.push(opts?.maxTokens);
        const i = calls.length - 1;
        return { text: [first, retry][Math.min(i, 1)], usage: { outputTokens: [10_000, 12_000][Math.min(i, 1)] }, model: "fake" };
      },
    });
    const chunk = out.chunks[0];
    t.eq(calls.length, 2, "旧实现也会重试（钱照付）");
    t.eq(calls[1], RETRY_BUDGET, "旧实现的第二次调用预算同样是 retryBudget —— 正因如此才判错");
    t.eq(chunk.truncated, true, "**旧实现必须红**：9,000 < 16,384 却判“仍然截断”");
    t.eq(chunk.text, first, "**旧实现必须红**：更好的重试正文被丢弃，用的是首调那份");
  } finally {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
  }
};
