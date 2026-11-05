/**
 * finish-reason.test.mjs —— 「摘要怎么结束的」**补观测**的守卫（T42 / T44 · C650）
 *
 * ## 这个文件钉的是什么
 *
 * `looksTruncated` 的第一条分支是 `isTruncatedFinish(r.finish ?? r.finishReason)`，可离线这条路上它
 * **永远不可能命中**：`runOfflineFold` 的 chunk 只搬了 `usage` / `model`（`finish` 留在 `out` 上），
 * 写回点 `applyOfflineFoldToGraph` 因此从不写 `foldMark.finishReason`。
 * ⇒ 真机 911 条离线折痕**全部**落在「不知道」，审计器分不开「真撞顶」与「写完但没到 2×」。
 *
 * 本轮的改动**只补观测、不改行为**（计数不该变），所以守卫的形状是：
 *
 *   ① **给值就要带上去**：`callModel` 返回 `{ finish: "length" }` ⇒ chunk 与写回点两级都要有；
 *   ② **没给就一个字节都不写**：返回 `{}` ⇒ mark 上**没有** `finishReason` 这个键。
 *      写 `"undefined"` / `"unknown"` / `null` 都会把「不可判」伪装成「已采集」（三态里的第三态就没了）；
 *   ③ **向后兼容**：老 mark（没有该字段）照常读，且**不许**被当成「没截断」——
 *      缺键 + 老生产者的归「历史」，缺键 + 新生产者的归「真不可判」，两种修法完全不同；
 *   ④ **审计器跟随**：`truncation-criteria-audit` 的「不知道」按世代拆成多档（口径在
 *      `scripts/finish-reason-audit.mjs`，只有一份）；
 *   ⑤ **`callModel` 的字段集从源码读**：引擎那处只返回 `{text, usage, model}`（**没有** `finish`），
 *      脚本那处返回 `{…, finish, …}` —— 这条差异是真机「补了也不变色」的根因，必须钉住。
 *
 * ## 失败分支必须真红
 *
 * 最后两条用例各复制一份源码、把关键那一行**换回旧写法**（变异副本），再跑同一条夹具：
 *   · 拿掉写回点的 `finishReason` ⇒ 夹具②必须翻成「没有这个键」；
 *   · 把世代判断换成「一律历史」 ⇒ 夹具⑤的「真不可判」必须归零。
 * 副本落在 `test/.tmp-finish-reason/`（不写 `src/`，跑完自己删），相对 import 改写成绝对
 * `file://` URL，否则从临时目录解析不到。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyOfflineFoldToGraph, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import { FINISH_STATE, UNJUDGEABLE, finishStateOf, landingRates, returnKeysOf } from "../scripts/finish-reason-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const TMP = nodePath.join(HERE, ".tmp-finish-reason");
const FOLD_SOURCE = nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs");
const AUDIT_SOURCE = nodePath.join(ROOT, "scripts", "finish-reason-audit.mjs");

/* ────────────────────────── 夹具 ────────────────────────── */

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/** 最小图：没有失败边、没有约束 ⇒ 机械补回不会改写正文，断言可以直接比字符串。 */
const graph = () => ({
  rootUserNodeIds: ["n1"],
  order: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: [] } },
  edges: {},
});

const events = () => [u(1, "把构建跑通"), a(2, "先看配置"), u(3, "别动 prod")];

/**
 * 跑一次离线折叠：`replies[i]` 是第 i 次模型调用的返回（不够就复用最后一条）。
 * 记录每次调用的 `maxTokens` —— 夹具要能证明「重试那次拿的是 retryBudget」。
 *
 * @param {{replies:Array<object>}} args
 * @returns {Promise<{out:object, chunk:object, calls:number[]}>}
 */
async function fold({ replies }) {
  const calls = [];
  const out = await runOfflineFold({
    graph: graph(),
    events: events(),
    rangeStart: 1,
    rangeEnd: 3,
    maxChars: 60_000,
    maxChunks: 1,
    maxTokens: 8192,
    maxTokensCap: 8192,
    deadline: Date.now() + 240_000,
    callModel: async (_prompt, opts) => {
      calls.push(opts?.maxTokens);
      return replies[Math.min(calls.length - 1, replies.length - 1)];
    },
  });
  return { out, chunk: out.chunks[0], calls };
}

/** 短正文（< 400 字符）+ 小 prompt ⇒ C534 骨架判据不参与，只看 finish 那一条。 */
const shortReply = (extra = {}) => ({ text: "这一段的摘要。", usage: { outputTokens: 120 }, model: "fake", ...extra });

/** 把 `result` 写回一张新图，返回那条 foldMark。 */
function writeBack(result) {
  const g = graph();
  g.foldMarks = [];
  applyOfflineFoldToGraph(g, result, { rangeStart: 1, rangeEnd: 3, provider: "offline", model: "fake", now: 1_790_000_000_000 });
  return g.foldMarks[g.foldMarks.length - 1];
}

/** 把相对 import 改写成绝对 `file://`（临时目录里的副本要能解析到仓库）。 */
function rewriteImports(source, fromDir) {
  return String(source).replace(/(\bfrom\s*)(["'])(\.[^"']*)\2/g, (_m, kw, quote, spec) => `${kw}${quote}${pathToFileURL(nodePath.resolve(fromDir, spec)).href}${quote}`);
}

function resetTmp() {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  nodeFs.mkdirSync(TMP, { recursive: true });
}

/* ────────────────────────── ① 给值就要带上去 ────────────────────────── */

tests["T42① callModel 返回 finish ⇒ **chunk 必须带上**（以前它只活在栈上）"] = async (t) => {
  const { chunk } = await fold({ replies: [shortReply({ finish: "length" })] });
  t.eq(chunk.finish, "length", "chunk 是唯一会离开 `runOfflineFold` 的东西 —— finish 不在这里就是丢了");
  t.eq(chunk.truncated, true, "判据同时照旧命中（补观测不改行为）");
};

tests["T42② 写回点把 chunk.finish 写进 foldMark.finishReason"] = async (t) => {
  const { out } = await fold({ replies: [shortReply({ finish: "length" })] });
  const mark = writeBack(out);
  t.eq(mark.finishReason, "length", "`foldMark.finishReason` 是 doctor / 面板 / 三个审计器**唯一**读的字段");
  t.eq(mark.trigger, "archive-offline", "写回点只产这一种折痕");
  t.eq(isTruncatedFinish(mark.finishReason), true, "写下来的值必须被 isTruncatedFinish 认，否则等于没写");
};

tests["T42② 重试被采用时，记的是**被采用那一次**的 finish（不是第一次的）"] = async (t) => {
  // 首调撞顶（finish=length）⇒ 开重试；重试正常收尾（finish=stop、正文够长）⇒ 被采用。
  const { out, chunk, calls } = await fold({
    replies: [shortReply({ finish: "length" }), { text: "更长的摘要：" + "好".repeat(900), usage: { outputTokens: 700 }, model: "fake", finish: "stop" }],
  });
  t.eq(calls.length, 2, "两次调用（首调 + 放大重试）");
  t.eq(chunk.truncated, false, "重试被采用 ⇒ 不再截断");
  t.eq(chunk.finish, "stop", "finish 必须跟着被采用的那一次走（与 text / usage 同源）");
  t.eq(writeBack(out).finishReason, "stop", "写回点同样记被采用那次的");
};

/* ────────────────────────── ② 没给就一个字节都不写 ────────────────────────── */

tests["T42③ callModel 不给 finish（返回 {}）⇒ chunk 是 null、mark 上**没有这个键**"] = async (t) => {
  const { out, chunk } = await fold({ replies: [shortReply()] });
  t.eq(chunk.finish, null, "chunk 用 null 表示「上游没给」—— 不是 `undefined` 混进对象里");
  const mark = writeBack(out);
  t.eq(Object.hasOwn(mark, "finishReason"), false, "**不许**写这个键：写 \"unknown\" / \"undefined\" / null 都会把「不可判」伪装成「已采集」");
  t.eq(mark.finishReason, undefined, "读出来就是 undefined（三态里的第三态），不是字符串");
  t.eq(mark.truncated, false, "其余字段照常写（补观测不改变任何别的行为）");
};

tests["T42③ 空字符串 / 非字符串也不算给：`false` / `{}` 不许被 String() 成字符串"] = async (t) => {
  for (const finish of ["", 0, false, { kind: "max-tokens" }]) {
    const { out, chunk } = await fold({ replies: [shortReply({ finish })] });
    t.eq(chunk.finish, null, `finish=${JSON.stringify(finish)} 不是非空字符串 ⇒ 不采`);
    t.eq(Object.hasOwn(writeBack(out), "finishReason"), false, `finish=${JSON.stringify(finish)} 不许写进 mark`);
  }
};

/* ────────────────────────── ③ 向后兼容 ────────────────────────── */

tests["T42④ 向后兼容：老 mark（没有该字段）照常读，且**不许**被当成「没截断」"] = (t) => {
  const legacy = { seqStart: 1, seqEnd: 3, trigger: "archive-offline", truncated: false, at: 1_700_000_000_000 };
  const f = finishStateOf(legacy, { boundary: 1_790_000_000_000 });
  t.eq(f.state, FINISH_STATE.unjudgeable, "缺键 = 不可判（第三态），不是 clean");
  t.eq(f.why, UNJUDGEABLE.legacy, "at 早于分界线 ⇒ 生产者早于本改动（历史，永远补不回来）");
  t.eq(finishStateOf({ ...legacy, at: 1_790_000_001_000 }, { boundary: 1_790_000_000_000 }).why, UNJUDGEABLE.genuine, "新生产者还没给 ⇒ 真不可判（去查调用方）");
  t.eq(finishStateOf({ ...legacy, at: 1_790_000_001_000 }, { boundary: null }).why, UNJUDGEABLE.unknown, "判不了世代就明说不知道（不猜）");
  t.eq(isTruncatedFinish(undefined), false, "老 mark 走 isTruncatedFinish 也不许抛");
};

tests["T42④ 三态是**闭合**的：字符串取值只会落进 截断 / 没截断 / 值不认识 三档"] = (t) => {
  t.eq(finishStateOf({ finishReason: "max-tokens" }).state, FINISH_STATE.truncated, "max-tokens 认截断");
  t.eq(finishStateOf({ finishReason: "max(assumed)" }).state, FINISH_STATE.truncated, "C535 反推值认截断");
  t.eq(finishStateOf({ finishReason: "stop" }).state, FINISH_STATE.clean, "stop 是正常收尾");
  t.eq(finishStateOf({ finishReason: "end_turn" }).state, FINISH_STATE.clean, "下划线拼法同一件事（C320）");
  t.eq(finishStateOf({ finishReason: "tool-calls" }).state, FINISH_STATE.clean, "连字符拼法同一件事");
  t.eq(finishStateOf({ finishReason: "aborted" }).state, FINISH_STATE.unjudgeable, "别的终态不是「写完」，也不是「没写完」");
  t.eq(finishStateOf({ finishReason: "aborted" }).why, UNJUDGEABLE.valueUnknown, "值不认识要单独一档");
  t.eq(finishStateOf({ finishReason: null }).why, UNJUDGEABLE.nullValue, "显式 null 是「生产者说没采集」");
};

/* ────────────────────────── ④ 各路径落盘率 ────────────────────────── */

tests["T42④ landingRates：按 trigger 分组，string / null / 缺键三档不许混"] = (t) => {
  const rates = landingRates([
    { mark: { trigger: "archive-offline", at: 1 } },
    { mark: { trigger: "archive-offline", at: 2 } },
    { mark: { trigger: "pressure", finishReason: "stop" } },
    { mark: { trigger: "pressure", finishReason: null } },
  ]);
  const off = rates.find((r) => r.trigger === "archive-offline");
  const pre = rates.find((r) => r.trigger === "pressure");
  t.eq(off.marks, 2, "两条离线折痕");
  t.eq(off.rate, 0, "一条都没落盘 ⇒ 0.0%");
  t.eq(off.missing, 2, "缺键单独计数");
  t.eq(pre.rate, 0.5, "pressure 一条有值一条 null ⇒ 50%");
  t.eq(pre.nulls, 1, "null 不是「有值」");
  t.eq(landingRates([{ mark: { trigger: "tier2" } }])[0].noModel, true, "tier2 分段合并不调模型 ⇒ 缺键不是缺陷（口径与 instrument-audit 同源）");
};

/* ────────────────────────── ⑤ callModel 的字段集（从源码读） ────────────────────────── */

tests["T42⑤ 引擎那处 callModel **不返回** finish（这才是真机补了也不变色的根因）"] = (t) => {
  const source = nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
  const parsed = returnKeysOf(source, "const callModel = async (prompt, { maxTokens }) => {");
  t.eq(parsed.ok, true, `解析要成功（失败说明签名改了，审计该跟着改）：${parsed.why}`);
  t.eq(parsed.keys.includes("text"), true, "成功返回必须带 text（取错了 `return {…}` 就会少报）");
  t.eq(parsed.keys.includes("finish"), false, "引擎这条**没有** finish ⇒ 真机上「不可判」条数不会因为接线而下降");
  t.eq(parsed.all.length >= 2, true, "函数体里至少有两个 return 字面量（上下文失活那条是错误分支，不许拿来冒充契约）");
};

tests["T42⑤ 脚本那处 callModel **返回** finish（同一个写回点，两条路的字段集不一样）"] = (t) => {
  const source = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "archive-fold.mjs"), "utf8");
  const parsed = returnKeysOf(source, "async function callModel({ baseUrl, apiKey, model, prompt, maxTokens, timeoutMs }) {");
  t.eq(parsed.ok, true, `解析要成功：${parsed.why}`);
  t.eq(parsed.keys.includes("finish"), true, "HTTP 那条读的是 `choices[0].finish_reason`");
  t.eq(parsed.keys.length >= 4, true, `字段集不许少报：${parsed.keys.join(",")}`);
};

/* ────────────────────────── ⑥ 失败分支必须真红 ────────────────────────── */

/**
 * 变异副本：把它们各自换回旧写法（只动一行），再跑同一条夹具。
 * @param {"writeback"|"epoch"} kind
 */
async function loadMutant(kind) {
  resetTmp();
  if (kind === "writeback") {
    const source = nodeFs.readFileSync(FOLD_SOURCE, "utf8");
    const line = '...(typeof chunk.finish === "string" && chunk.finish !== "" ? { finishReason: chunk.finish } : {}),';
    if (!source.includes(line)) throw new Error(`变异点没找到（写回点改了？）—— 这条自检必须跟着改：${line}`);
    const mutant = rewriteImports(source.replace(line, "// (mutant) 写回点不写 finishReason"), nodePath.dirname(FOLD_SOURCE));
    const file = nodePath.join(TMP, "offline-fold-mutant.mjs");
    nodeFs.writeFileSync(file, mutant, "utf8");
    return import(pathToFileURL(file).href);
  }
  const source = nodeFs.readFileSync(AUDIT_SOURCE, "utf8");
  const line = "if (Number(at) < Number(boundary)) {";
  if (!source.includes(line)) throw new Error(`变异点没找到（世代判断改了？）—— 这条自检必须跟着改：${line}`);
  const mutant = rewriteImports(source.replace(line, "if (true) {"), nodePath.dirname(AUDIT_SOURCE));
  const file = nodePath.join(TMP, "finish-reason-audit-mutant.mjs");
  nodeFs.writeFileSync(file, mutant, "utf8");
  return import(pathToFileURL(file).href);
}

tests["T42⑥ 真红自检：拿掉写回点那一行，夹具②必须翻成「没有这个键」"] = async (t) => {
  const { out } = await fold({ replies: [shortReply({ finish: "length" })] });
  t.eq(writeBack(out).finishReason, "length", "真实现：写下来了（否则下面的变异没有意义）");
  const mutant = await loadMutant("writeback");
  const g = graph();
  g.foldMarks = [];
  mutant.applyOfflineFoldToGraph(g, out, { rangeStart: 1, rangeEnd: 3, provider: "offline", model: "fake", now: 1_790_000_000_000 });
  const mark = g.foldMarks[g.foldMarks.length - 1];
  t.eq(Object.hasOwn(mark, "finishReason"), false, "旧实现：字段根本不存在 —— 这条用例红了才说明上面的绿不是白捡的");
  t.eq(mutant.estimateTokens("中文"), 2, "副本的依赖要真的解析到（否则「红」是加载失败，不是判据失效）");
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};

tests["T42⑦ 真红自检：世代判断换回「一律历史」，夹具⑤的「真不可判」必须归零"] = async (t) => {
  const mark = { at: 1_790_000_001_000, truncated: false };
  t.eq(finishStateOf(mark, { boundary: 1_790_000_000_000 }).why, UNJUDGEABLE.genuine, "真实现：新生产者缺键 = 真不可判");
  const mutant = await loadMutant("epoch");
  t.eq(mutant.finishStateOf(mark, { boundary: 1_790_000_000_000 }).why, UNJUDGEABLE.legacy, "旧实现：全归历史 ⇒「真不可判」这一档在报告里永远看不见");
  t.eq(mutant.UNJUDGEABLE.genuine, "missing-genuine", "常量还在，但永远命中不到 —— 这正是「两套原因被并成一档」的形状");
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};
