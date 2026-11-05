/**
 * truncation-criteria.test.mjs —— **两条「摘要被截断」判据的守卫**（T41 / C649）
 *
 * 这个文件钉的是 T40 审计给出的两处一行改动，以及它们**为什么不是放松**：
 *
 *   ① `looksTruncated` 的 token 判据：旧写法拿 `usage.outputTokens`（**含 reasoning**，见 CHANGELOG C73）
 *      比正文预算。真机 896 条离线折痕里 148 条因此报截断，而正文（同一个 CJK 估算器）最大只有
 *      4,939 token —— 撞的从来不是正文，是思考。于是「思考多」被当成「没写完」，每次都白付一次
 *      「放大 2×」重试（91 条确证付过第二次，≈ $0.7133）。现在改用 `estimateTokens(r.text)`，
 *      **与预算 `foldBudgetFor` 同一个估算器**。
 *   ② `isTruncatedFinish` 不认 `max(assumed)` —— 那是 C535 在 `finish` 读不到、completion 已经
 *      顶到 `maxTokens` 98% 时**反推**出来的值，语义逐字就是「撞满 max_tokens」。不认它，
 *      这条截断在 doctor / 面板 / `todayAggregate` 里永远落进三态的第三态「不知道」。
 *
 * ★ **判据是更准，不是更松**。所以下面每一处「不该报」都配了一处「必须仍然报」：
 *   · 正文 3,000 token / outputTokens 20,000 ⇒ **不许**报（假阳性反例）；
 *   · 正文 9,000 token ⇒ **必须**报（真截断）；
 *   · 正文正好 = 预算 8,192 ⇒ **必须**报（`>=` 不是 `>`）；
 *   · `finish = max-tokens` 与 C534 骨架判据**各自独立**仍然生效。
 *
 * ★ **失败分支必须真红**：`looksTruncated` 是 `runOfflineFold` 里的闭包，没法直接打。
 *   所以最后两条用例把源码复制一份、**把判据换回旧写法**（变异副本），再跑同一条夹具 ——
 *   如果副本不红，就说明上面的绿是假绿（测试自己写的恒真断言）。
 *   副本落在 `test/.tmp-truncation-criteria/`（不写 `src/`，跑完自己删），
 *   相对 import 改写成**绝对 file:// URL**，否则从临时目录解析不到。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HARD_MAX_TOKENS, estimateTokens, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_OFFLINE_MAX_TOKENS,
  offlineBudget,
} from "../scripts/summary-truncation-audit.mjs";
import { bodyTokensOf, criteriaOf, oldCapHit } from "../scripts/truncation-criteria-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const TMP = nodePath.join(HERE, ".tmp-truncation-criteria");

/** 默认配置下的离线预算（`budgetCap` 夹回 8,192）—— 判据里那个 `budget`。 */
const BUDGET = offlineBudget(DEFAULT_MAX_TOKENS, DEFAULT_OFFLINE_MAX_TOKENS);

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

/** 短 prompt（< 4,000 字符）—— 让 C534 的骨架判据**不参与**，单独验 finish / token 两条。 */
const events = () => [u(1, "把构建跑通"), a(2, "先看配置"), u(3, "别动 prod")];
/**
 * 长 prompt（> 4,000 字符）—— 专门给 C534 骨架判据用。
 * 每条消息被 `perMessageChars = 2000` 夹过，所以要**三条**才撑得到 4,000 以上。
 */
const longEvents = () => [u(1, "把构建跑通"), a(2, "x".repeat(2000)), u(3, "y".repeat(2000))];

/**
 * 造一段**正好** `tokens` 个 token 的正文（`estimateTokens` 是 CJK 0.6 / 其余 0.3 的加权）。
 * 纯 ASCII 是 0.3 token/字符，所以字符数 ≈ tokens / 0.3；再按实际估算值校正到「正好」。
 */
function bodyOf(tokens) {
  let n = Math.ceil(tokens / 0.3);
  while (estimateTokens("a".repeat(n)) < tokens) n += 1;
  while (n > 0 && estimateTokens("a".repeat(n)) > tokens) n -= 1;
  return "a".repeat(n);
}

/** 跑一次离线折叠，记录每次模型调用的入参（用来数「白付了几次」）。 */
async function fold({ text, usage, finish, evts = events }) {
  const calls = [];
  const out = await runOfflineFold({
    graph: graph(),
    events: evts(),
    rangeStart: 1,
    rangeEnd: 3,
    maxChars: 60_000,
    maxChunks: 1,
    maxTokens: BUDGET,
    maxTokensCap: BUDGET,
    deadline: Date.now() + 240_000,
    callModel: async (prompt, opts) => {
      calls.push({ promptChars: String(prompt ?? "").length, maxTokens: opts?.maxTokens });
      return { text, usage, model: "fake", ...(finish === undefined ? {} : { finish }) };
    },
    measureQuality: ({ graph: g, range, summaryText }) => measureFoldQuality({ graph: g, range, summaryText }),
  });
  return { out, chunk: out.chunks[0], calls };
}

/* ────────────────────────── ① 假阳性反例（验收硬要求） ────────────────────────── */

tests["C649 假阳性反例：outputTokens=20000 而正文只有 3000 token（预算 8192）⇒ **不许**判截断"] = async (t) => {
  const body = bodyOf(3000);
  t.eq(estimateTokens(body), 3000, "夹具正文必须正好 3,000 token（与预算同一个估算器）");
  t.eq(BUDGET, 8192, `默认配置下离线预算恒等于 8,192（实际 ${BUDGET}）`);
  const { chunk, calls } = await fold({ text: body, usage: { outputTokens: 20000 } });
  t.eq(chunk.truncated, false, "**正文没撞顶 ⇒ 不判截断**（旧判据在这里会说 20,000 ≥ 8,192）");
  t.eq(calls.length, 1, "不报警 ⇒ 一次多余的「放大 2×」重试都不该付");
};

tests["C649 真截断仍然报：正文 9000 token ≥ 预算 8192 ⇒ 判截断（更准不是更松）"] = async (t) => {
  const body = bodyOf(9000);
  t.eq(estimateTokens(body), 9000, "夹具正文必须正好 9,000 token");
  const { chunk, calls } = await fold({ text: body, usage: { outputTokens: 9000 } });
  t.eq(chunk.truncated, true, "正文撞顶 ⇒ 必须报");
  t.eq(calls.length, 2, "报截断 ⇒ 放大 2× 重试一次");
  t.eq(calls[1].maxTokens, Math.min(HARD_MAX_TOKENS, BUDGET * 2), `重试预算 = min(${HARD_MAX_TOKENS}, ${BUDGET}×2)`);
};

tests["C649 边界：正文正好 = 预算 8192 ⇒ 撞顶（判据是 ≥ 不是 >）；8,191 就不许报"] = async (t) => {
  const at = await fold({ text: bodyOf(BUDGET), usage: { outputTokens: BUDGET } });
  t.eq(at.chunk.truncated, true, "正好等于预算就算撞顶");
  const below = await fold({ text: bodyOf(BUDGET - 1), usage: { outputTokens: BUDGET - 1 } });
  t.eq(below.chunk.truncated, false, "差一个 token 就没撞顶 —— 阈值不许有别的偏移");
};

/* ────────────────────────── ② 另外两条判据不许被带坏 ────────────────────────── */

tests["C649 finish 判据仍独立生效：正文只有 100 token，但 finish=max-tokens ⇒ 仍判截断"] = async (t) => {
  const { chunk, calls } = await fold({ text: bodyOf(100), usage: { outputTokens: 100 }, finish: "max-tokens" });
  t.eq(calls[0].promptChars < 4000, true, "夹具的 prompt < 4,000 字符 ⇒ C534 骨架判据不参与");
  t.eq(chunk.truncated, true, "上游明说撞 max_tokens ⇒ 与正文长短无关");
};

tests["C649 C534 骨架判据仍独立生效：prompt > 4000 字符 ∧ 正文 < 400 字符 ⇒ 仍判截断"] = async (t) => {
  const body = bodyOf(100);
  t.eq(body.length < 400, true, `夹具正文只有 ${body.length} 字符（< 400）`);
  const { chunk, calls } = await fold({ text: body, usage: { outputTokens: 100 }, evts: longEvents });
  t.eq(calls[0].promptChars > 4000, true, `夹具的 prompt 有 ${calls[0].promptChars} 字符（> 4,000）`);
  t.eq(chunk.truncated, true, "只写了个骨架 ⇒ 仍然报（这条与 token 判据是两件事）");
};

tests["C649 别放松：provider 报满预算 + 正文只剩骨架（reasoning 吃光预算）⇒ 仍判截断"] = async (t) => {
  // 这是 C522「重试仍截断」的形状：completion_tokens 撞满 max_tokens，可正文只有一行骨架。
  // 判据比的是正文 ⇒ 正文没撞顶；但**正文过短**这一条把它兜住（reasoning 把预算吃光了）。
  // 没有这条，「思考多」和「思考把预算吃光」会被混成同一件事，后者就被静默放过了。
  const body = bodyOf(100);
  t.eq(body.length < 400, true, `夹具正文只有 ${body.length} 字符（< 400）`);
  const { chunk, calls } = await fold({ text: body, usage: { outputTokens: BUDGET } });
  t.eq(calls[0].promptChars < 4000, true, "prompt 很小 ⇒ C534 的 `fed > 4000` 那条不参与，只能是 `used ≥ 预算 ∧ 正文过短` 命中");
  t.eq(chunk.truncated, true, "provider 报满预算而正文只有骨架 ⇒ 摘要没写完，必须报");
  t.eq(calls.length, 2, "因此必须重试一次（账上不许记成成功）");
};

/* ────────────────────────── ③ isTruncatedFinish ────────────────────────── */

tests["C649 isTruncatedFinish：max(assumed) 是 C535 反推出来的截断，必须认"] = (t) => {
  t.eq(isTruncatedFinish("max(assumed)"), true, "C535 在 engine.mjs 里写的那个值 —— 语义就是撞满 max_tokens");
  t.eq(isTruncatedFinish("MAX(ASSUMED)"), true, "大小写不敏感（与既有拼法同一套归一化）");
  for (const ok of ["max-tokens", "max_tokens", "length", "LENGTH"]) t.eq(isTruncatedFinish(ok), true, `既有拼法 ${ok} 不许退化`);
  for (const no of ["stop", "end_turn", "tool-calls", "tool_calls", "completed", "", "max_turn_requests", "refusal", "cancelled"]) {
    t.eq(isTruncatedFinish(no), false, `${JSON.stringify(no)} 是正常结束/别的终态，不算截断`);
  }
  t.eq(isTruncatedFinish(null), false, "null 不算截断");
  t.eq(isTruncatedFinish(undefined), false, "undefined 不算截断");
  t.eq(isTruncatedFinish(123), false, "非字符串不算截断");
};

/* ────────────────────────── ④ 审计器口径 = 写入点口径 ────────────────────────── */

tests["C649 审计器口径：假想折痕（output 20000 / 正文 3000）上，旧判据说撞、新判据说没撞"] = (t) => {
  const mark = { seqStart: 1, seqEnd: 3, truncated: false, usage: { outputTokens: 20000 }, quality: { summaryTokens: 3000 } };
  const g = { lastOfflineSummary: { range: { start: 1, end: 3 }, text: bodyOf(3000) } };
  const c = criteriaOf(mark, g, BUDGET);
  t.eq(c.body.source, "exact", "正文能从 lastOfflineSummary 取回 ⇒ 精确值，不是代理");
  t.eq(c.oldCap, true, "旧判据：20,000 ≥ 8,192 ⇒ 说撞顶（这就是那 148 条）");
  t.eq(c.newCap, false, "新判据：正文 3,000 < 8,192 ⇒ 没撞顶");
  t.eq(oldCapHit(mark, BUDGET), true, "`oldCapHit` 与 `criteriaOf` 必须同口径");
  t.eq(c.skeleton, false, "写入点说 truncated=false ⇒ 不是骨架判据命中");
};

tests["C649 审计器口径不许漂：criteriaOf 的 newCap 与 runOfflineFold 的 truncated 必须一致"] = async (t) => {
  // 同一条夹具分别喂给「审计器的纯函数」和「真实编排」，两边必须给同一个答案。
  // [正文 token, provider 报的 outputTokens] —— 最后一档是「正文骨架 + 报满预算」（C522 形状）
  for (const [tokens, used] of [
    [3000, 20000],
    [BUDGET - 1, BUDGET - 1],
    [BUDGET, BUDGET],
    [9000, 9000],
    [100, BUDGET],
  ]) {
    const body = bodyOf(tokens);
    const mark = { seqStart: 1, seqEnd: 3, truncated: false, usage: { outputTokens: used }, quality: { summaryTokens: tokens, summaryChars: body.length } };
    const g = { lastOfflineSummary: { range: { start: 1, end: 3 }, text: body } };
    const c = criteriaOf(mark, g, BUDGET);
    const { chunk } = await fold({ text: body, usage: { outputTokens: used } });
    t.eq(chunk.truncated, c.newCap, `正文 ${tokens} / output ${used}：编排说 ${chunk.truncated}，审计器说 ${c.newCap} —— 两套口径会让人查错方向`);
    t.eq(bodyTokensOf(mark, g).tokens, tokens, `正文 token 复读 = ${tokens}`);
  }
};

/* ────────────────────────── ⑤ 失败分支必须真红（变异副本） ────────────────────────── */

/**
 * 变异副本：把两条判据**各自换回旧写法**，其余逐字不变。
 *
 * 为什么要文件副本而不是就地改：`looksTruncated` 是 `runOfflineFold` 里的闭包，
 * 从外面打不到；只有让整份源码换个判据再跑同一条夹具，才能证明「绿」不是测试自己写的。
 */
async function loadMutants() {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  nodeFs.mkdirSync(TMP, { recursive: true });
  const kifuUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "kifu-model.mjs")).href;
  const qualityUrl = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "fold-quality.mjs")).href;

  // ① 把 token 判据换回 `used >= budget`（含 reasoning 的旧写法）
  const foldSrc = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs"), "utf8");
  const newCriterion = 'if (estimateTokens(String(r?.text ?? "")) >= budget) return true;';
  if (!foldSrc.includes(newCriterion)) throw new Error(`变异点没找到（判据改了？）—— 这条自检必须跟着改：${newCriterion}`);
  const foldMutant = foldSrc
    .replace('from "./kifu-model.mjs"', `from ${JSON.stringify(kifuUrl)}`)
    .replace('from "./fold-quality.mjs"', `from ${JSON.stringify(qualityUrl)}`)
    .replace(
      newCriterion,
      '{ const used = Number(r?.usage?.completion_tokens ?? r?.usage?.outputTokens ?? NaN); if (Number.isFinite(used) && used >= budget) return true; }',
    );
  if (foldMutant === foldSrc) throw new Error("offline-fold 变异没生效 —— 自检会变成假绿");

  // ② 把 `max(assumed)` 从闭集里去掉
  const kifuSrc = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "kifu-model.mjs"), "utf8");
  const newFinish = 'return normalized === "maxtokens" || normalized === "length" || normalized === "max(assumed)";';
  if (!kifuSrc.includes(newFinish)) throw new Error(`变异点没找到（判据改了？）—— 这条自检必须跟着改：${newFinish}`);
  const kifuMutant = kifuSrc.replace(newFinish, 'return normalized === "maxtokens" || normalized === "length";');
  if (kifuMutant === kifuSrc) throw new Error("kifu-model 变异没生效 —— 自检会变成假绿");

  const foldFile = nodePath.join(TMP, "offline-fold-mutant.mjs");
  const kifuFile = nodePath.join(TMP, "kifu-model-mutant.mjs");
  nodeFs.writeFileSync(foldFile, foldMutant, "utf8");
  nodeFs.writeFileSync(kifuFile, kifuMutant, "utf8");
  try {
    const [foldMod, kifuMod] = await Promise.all([import(pathToFileURL(foldFile).href), import(pathToFileURL(kifuFile).href)]);
    return { runOfflineFold: foldMod.runOfflineFold, estimateTokens: foldMod.estimateTokens, isTruncatedFinish: kifuMod.isTruncatedFinish };
  } catch (error) {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
    throw error;
  }
}

tests["C649 真红自检：把 token 判据换回 `outputTokens >= budget`，那条假阳性反例必须翻成 truncated=true"] = async (t) => {
  const mutant = await loadMutants();
  try {
    const body = bodyOf(3000);
    const calls = [];
    const out = await mutant.runOfflineFold({
      graph: graph(),
      events: events(),
      rangeStart: 1,
      rangeEnd: 3,
      maxChars: 60_000,
      maxChunks: 1,
      maxTokens: BUDGET,
      maxTokensCap: BUDGET,
      deadline: Date.now() + 240_000,
      callModel: async (prompt, opts) => {
        calls.push(opts?.maxTokens);
        return { text: body, usage: { outputTokens: 20000 }, model: "fake" };
      },
      measureQuality: ({ graph: g, range, summaryText }) => measureFoldQuality({ graph: g, range, summaryText }),
    });
    t.eq(out.chunks[0].truncated, true, "**旧判据在这里必须报**（否则上面那条「不许报」是假绿）");
    t.eq(calls.length, 2, "旧判据多付的那一次重试必须真的发生 —— 这就是被省掉的钱");
  } finally {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
  }
};

tests["C649 真红自检：把 max(assumed) 从闭集里去掉，那条断言必须翻成 false"] = async (t) => {
  const mutant = await loadMutants();
  try {
    t.eq(mutant.isTruncatedFinish("max(assumed)"), false, "旧实现：不认 ⇒ 落进「不知道」");
    t.eq(isTruncatedFinish("max(assumed)"), true, "新实现：认 ⇒ 落进「截断」");
    t.ne(mutant.isTruncatedFinish("max(assumed)"), isTruncatedFinish("max(assumed)"), "两者必须不同，否则这条自检没有变异");
    // 既有拼法在旧实现里也是 true ⇒ 证明变异只打掉了新增的那一种
    t.eq(mutant.isTruncatedFinish("max_tokens"), true, "变异副本里 max_tokens 仍然认（只删了新增分支）");
  } finally {
    nodeFs.rmSync(TMP, { recursive: true, force: true });
  }
};
