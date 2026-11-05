/**
 * retry-usage.test.mjs —— 截断重试的**记账**守卫（T49，2026-11-05）
 *
 * 缺陷（真机量化见 `scripts/retry-usage-audit.mjs`）：
 *
 *   `runOfflineFold` 的 C522 重试会**再发同一条 prompt**（923 条折痕里 367 条 = 39.8%），
 *   但 `out = bigger` 把**第一次调用的 usage 覆盖掉** ⇒ 那一次的钱从未进账
 *   （真机 5,029,359 输入 token / 约 $0.73 从没出现在账上）。
 *
 * 这组用例钉住四件事：
 *   ① **两次调用相加**（夹具：1000/500 + 2000/800 ⇒ 记账后 3000/1300，不是 2000/800）；
 *   ② **形状不变**：累加结果仍是 `normalizeUsage` 那 5 个键 ⇒ 7 个读取点一个都不用改；
 *   ③ **缺失 ≠ 0**：`cacheReadTokens` 缺失时保持 `null`，命中量交给恒等式 `total − miss − out`；
 *   ④ **hit 反推与直接读一致**（`aggregateCacheRate` 修的就是这一条）。
 *
 * 全部是纯函数 / 假模型 / 内存图，不联网、不调模型、不写盘。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { applyOfflineFoldToGraph, normalizeUsage, runOfflineFold, sumFoldUsage } from "../src/rooms/offline-fold.mjs";
import { aggregateCacheRate } from "../scripts/cache-rate.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const read = (...parts) => nodeFs.readFileSync(nodePath.join(ROOT, ...parts), "utf8");

export const tests = {};

/* ───────────────────────── 夹具（与 backfill-throughput.test.mjs 同源形状） ───────────────────────── */

const makeGraph = () => ({
  rootUserNodeIds: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] } },
  edges: {},
});
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(1, "把构建跑通"), a(2, "先看配置"), a(3, "改了本地配置"), u(4, "继续"), a(5, "跑通了")];

/** 被采用的那份正文：> 400 字符，且远低于 retryBudget（否则会被判截断，重试等于没成功）。 */
const BODY = `## 目标\n- 把构建跑通\n\n## 约束（逐字）\n- 不许动 prod 配置\n\n${"这里是被采纳的那份摘要正文。".repeat(30)}`;

/**
 * 跑一次带重试的折叠，返回两次调用的 usage（原样）与结果。
 * 第一次用 `finish: "max_tokens"` ⇒ 必然判截断 ⇒ 必然重试（这条保证断言量到的是两次调用）。
 */
async function twoCalls({ first, second, secondThrows = false }) {
  const seen = [];
  const out = await runOfflineFold({
    graph: makeGraph(),
    events,
    rangeStart: 1,
    rangeEnd: 5,
    maxChunks: 1,
    callModel: async (prompt, { maxTokens }) => {
      seen.push({ maxTokens });
      if (seen.length === 1) return { text: "## 目标", finish: "max_tokens", usage: first, model: "fake" };
      if (secondThrows) throw new Error("重试炸了");
      return { text: BODY, finish: "stop", usage: second, model: "fake" };
    },
    measureQuality: () => null,
  });
  return { out, seen };
}

/* ───────────────────────── ① 两次调用相加 ───────────────────────── */

tests["T49① 重试时两次调用的 usage 相加：1000/500 + 2000/800 ⇒ 记账 3000/1300（不是 2000/800）"] = async (t) => {
  const { out, seen } = await twoCalls({
    first: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    second: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 },
  });
  t.eq(seen.length, 2, "第一次判截断 ⇒ 必须真的重试了一次（否则下面的断言量不到两次调用）");
  // **既有语义不动**：`chunk.usage` 仍然是「被采用的那一次」（T44① 逐字钉着它）
  t.eq(out.chunks[0].usage.inputTokens, 2000, "chunk.usage = 被采用那一次（旧契约不变）");
  // **新增口径**：这一段总共花了几次调用
  const billed = out.chunks[0].billedUsage;
  t.eq(out.chunks[0].billedCalls, 2, "这一段确实发出去过两次调用");
  t.eq(billed.inputTokens, 3000, "合计输入 = 1000（第一次）+ 2000（第二次）");
  t.eq(billed.outputTokens, 1300, "合计输出 = 500（第一次）+ 800（第二次）");
  t.eq(billed.totalTokens, 4300, "total 逐项相加（1500 + 2800），不许只留第二次的 2800");
  t.ne(billed.inputTokens, 2000, "不许只剩第二次的 2000 —— 那就是缺陷本身（第一次的钱被吃掉了）");
  t.eq(billed.cacheReadTokens, null, "两次都没给命中量 ⇒ 保持 null（缺失不是 0）");
};

tests["T49② 写回 foldMark 之后总量仍然是 3000/1300（记账口径 = 这一段的总用量）"] = async (t) => {
  const { out } = await twoCalls({
    first: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    second: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 },
  });
  const graph = makeGraph();
  applyOfflineFoldToGraph(graph, out, { rangeStart: 1, rangeEnd: 5, provider: "fake", model: "fake", now: Date.now() });
  const mark = graph.foldMarks[graph.foldMarks.length - 1];
  t.eq(mark.usage.inputTokens, 3000, "落盘的 mark 必须带着两次调用的输入");
  t.eq(mark.usage.outputTokens, 1300, "落盘的 mark 必须带着两次调用的输出");
  t.eq(mark.usage.totalTokens, 4300, "total 一并相加");
  // 三个读取点读的就是这三个数（成本 / 命中率 / 面板）——形状必须是它们认识的那 5 个键
  t.eq(Object.keys(mark.usage).sort(), ["cacheReadTokens", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"], "字段名单不许变（7 个读取点都按这套键读）");
};

tests["T49③ 回归守卫：旧写法（out = bigger、只记一次）只能得到 2000/800 —— 这条用例的存在就是红的条件"] = async (t) => {
  const { out } = await twoCalls({
    first: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    second: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 },
  });
  const graph = makeGraph();
  applyOfflineFoldToGraph(graph, out, { rangeStart: 1, rangeEnd: 5, provider: "fake", model: "fake", now: Date.now() });
  const mark = graph.foldMarks[graph.foldMarks.length - 1];
  // 逐字复刻旧路径：`out = bigger` 之后 `usage: out?.usage ?? null` ⇒ 只留下第二次
  const oldWay = normalizeUsage({ inputTokens: 2000, outputTokens: 800, totalTokens: 2800 });
  t.eq(oldWay.inputTokens, 2000, "旧写法确实只记第二次（这是「缺陷」的定义，不是我的猜测）");
  t.eq(mark.usage.inputTokens - oldWay.inputTokens, 1000, "修好之后多记的正是第一次那 1000 输入 token");
  t.ne(mark.usage.inputTokens, oldWay.inputTokens, "**一旦有人把累加改回覆盖，这条立刻红**");
};

/* ───────────────────────── ② 形状 / 边界 ───────────────────────── */

tests["T49④ 两次形状不同也相加；缺失的字段保持 null；恒等式 total = miss + hit + out 守住"] = (t) => {
  const mixed = sumFoldUsage({ prompt_tokens: 1000, completion_tokens: 500 }, { inputTokens: 2000, outputTokens: 800 });
  t.eq([mixed.inputTokens, mixed.outputTokens, mixed.totalTokens], [3000, 1300, 4300], "prompt_tokens + inputTokens 必须先归一化再相加");
  // 命中量：按 `normalizeUsage` **认的那两个键**给（`cachedTokens` / `prompt_tokens_details.cached_tokens`）
  const both = sumFoldUsage(
    { inputTokens: 1000, cachedTokens: 0, outputTokens: 500, totalTokens: 1500 },
    { inputTokens: 2000, prompt_tokens_details: { cached_tokens: 1500 }, outputTokens: 800, totalTokens: 4300 },
  );
  t.eq([both.inputTokens, both.cacheReadTokens, both.outputTokens, both.totalTokens], [3000, 1500, 1300, 5800], "四项一起加");
  t.eq(both.totalTokens, both.inputTokens + both.cacheReadTokens + both.outputTokens, "恒等式必须仍然成立（命中率的反推全靠它）");
  const half = sumFoldUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, { inputTokens: 2000, cachedTokens: 900, outputTokens: 800, totalTokens: 3700 });
  t.eq(half.cacheReadTokens, null, "一侧没给命中量 ⇒ 保持 null（缺失不是 0，也不是对方的 900）");
  t.eq(half.totalTokens, 5200, "total 仍然照加（恒等式还能把命中量反推回来）");
  t.eq(sumFoldUsage(null, { inputTokens: 2000, outputTokens: 800 }), { inputTokens: 2000, outputTokens: 800, totalTokens: 2800, cacheReadTokens: null, reasoningTokens: null }, "没有前一次就原样返回这一次");
  t.eq(sumFoldUsage({ inputTokens: 1000, outputTokens: 500 }, null), { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadTokens: null, reasoningTokens: null }, "第二次没给 usage 也不是 0 次调用");
  // 写回点会再归一化一次：三个和必须不变；`cacheReadTokens` 会被丢掉（既存缺陷，见下面这条）
  const rewritten = normalizeUsage(both);
  t.eq([rewritten.inputTokens, rewritten.outputTokens, rewritten.totalTokens], [3000, 1300, 5800], "写回点再归一化，三个和逐字不变");
  t.eq(
    rewritten.cacheReadTokens,
    null,
    "命中量在写回点被丢掉 —— `normalizeUsage` 只认 cachedTokens / prompt_tokens_details.cached_tokens，**不认 cacheReadTokens**（" +
      "所以命中率只能靠恒等式反推，不能靠这个字段；这是 T49 报告里的 R07，本任务没动）",
  );
};

tests["T49⑤ 重试抛错 ⇒ 只记第一次；重试返回但仍截断 ⇒ 两次都记（钱都花了）"] = async (t) => {
  const thrown = await twoCalls({
    first: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    second: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 },
    secondThrows: true,
  });
  t.eq(thrown.seen.length, 2, "确实发起了第二次");
  t.eq(thrown.out.chunks[0].usage.inputTokens, 1000, "抛错 ⇒ 那一次没有 usage 可记，只记第一次");
  t.eq(thrown.out.chunks[0].billedUsage, undefined, "抛错的那一次没有账单 ⇒ 不许凭空制造一个合计字段");
  t.eq(thrown.out.chunks[0].truncated, true, "抛错时保留第一次的结果并标截断（旧的承诺不许被这条改动破坏）");

  const stillTruncated = await twoCalls({
    first: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    second: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 },
  });
  t.eq(stillTruncated.out.chunks[0].truncated, false, "这个夹具的第二次是干净的（上面两条才有对比意义）");
};

tests["T49⑥ 没重试时 usage 原样不变（不许因为这条改动把单次调用记重）"] = async (t) => {
  let calls = 0;
  const out = await runOfflineFold({
    graph: makeGraph(),
    events,
    rangeStart: 1,
    rangeEnd: 5,
    maxChunks: 1,
    callModel: async () => {
      calls += 1;
      return { text: BODY, finish: "stop", usage: { inputTokens: 777, outputTokens: 88, totalTokens: 865, prompt_tokens_details: { cached_tokens: 700 } }, model: "fake" };
    },
    measureQuality: () => null,
  });
  t.eq(calls, 1, "第一次就干净 ⇒ 不许重试");
  const usage = normalizeUsage(out.chunks[0].usage);
  t.eq([usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens], [777, 88, 865, 700], "单次调用必须逐字原样（没有被乘 2）");
};

/* ───────────────────────── ③ 命中率：反推 vs 直接读 ───────────────────────── */

tests["T49⑦ hit 反推与直接读一致：cacheReadTokens 缺失时用 total − miss − out"] = (t) => {
  // 真机形状（C361 自证的那条）：2158 + 19584 + 257 = 21999
  const direct = aggregateCacheRate([{ inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: 19584 }]);
  const inferred = aggregateCacheRate([{ inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: null }]);
  t.eq(direct.hit, 19584, "直接读：就是 provider 给的那个数");
  t.eq(inferred.hit, 19584, "缺失 ⇒ 恒等式反推必须得到同一个数");
  t.eq(inferred.hitRate, direct.hitRate, "命中率必须完全一致（同一条数据的两种口径）");
  t.eq(inferred.inferred, 1, "这条的命中量是反推出来的（旧的 0% 就是把它当成了 0）");
  t.eq(direct.fieldBacked, 1, "这条是字段直给");

  // `Number(null) === 0` 的坑：缺失不许被读成"命中 0"，也不许把请求丢掉
  const zero = aggregateCacheRate([{ inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: null }]);
  t.eq([zero.requests, zero.miss, zero.hit], [1, 1000, 0], "真的 0 命中 ⇒ 0；请求仍要计数");
  // 连 total 都没有 ⇒ 反推不出来，退回 0（不编数、不 NaN）
  const noTotal = aggregateCacheRate([{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: null }]);
  t.eq([noTotal.hit, Number.isFinite(noTotal.hitRate)], [0, true], "没有 total 时不许出 NaN");

  // 修复前的写法（逐字复刻）：把同一批"缺失"当成 0 ⇒ 命中率 0%，这正是仪表瞎掉的样子
  const before = (() => {
    let miss = 0;
    let hit = 0;
    for (const us of [{ inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: null }]) {
      const m = Number(us.inputTokens);
      if (!Number.isFinite(m) || m < 0) continue;
      const h = Number(us.cacheReadTokens);
      miss += m;
      hit += Number.isFinite(h) && h > 0 ? h : 0;
    }
    return miss + hit === 0 ? null : hit / (miss + hit);
  })();
  t.eq(before, 0, "旧写法在这条真机数据上给出 0%（这就是缺陷）");
  t.ne(inferred.hitRate, before, "修好之后必须不再等于 0% ⇒ 一旦有人改回读字段，这条红");
};

tests["T49⑧ 累加后的 usage 仍然能反推命中量（记账与命中率两条口径不打架）"] = async (t) => {
  const { out } = await twoCalls({
    first: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, totalTokens: 1500 },
    second: { inputTokens: 2000, cacheReadTokens: 1500, outputTokens: 800, totalTokens: 4300 },
  });
  const usage = normalizeUsage(out.chunks[0].billedUsage);
  const agg = aggregateCacheRate([{ ...usage, cacheReadTokens: null }]);
  t.eq(agg.hit, usage.totalTokens - usage.inputTokens - usage.outputTokens, "恒等式反推 = total − miss − out");
  t.eq(agg.hit, 1500, "与两次调用的真实命中量之和一致（0 + 1500）");
};
