/**
 * log-stats.test.mjs —— 会话日志的「可缓存聚合」（C465）
 *
 * 缓存最容易变成新的谎报来源（本周已栽两次：C459 的 mtime、C460 的占比）。
 * 所以这里的不变量必须钉死：**缓存里只存"发生过什么"，"最近一小时发生了什么"在回放时才算**。
 */
import { logCacheKey, summarizeLogEvents, replayLogStats } from "../scripts/log-stats.mjs";

export const tests = {};

const ev = (type, time, data) => ({ type, time, data });

tests["C465 缓存键：size 或 mtime 变一个就失效"] = (t) => {
  t.eq(logCacheKey({ size: 100, mtimeMs: 1000 }), "100:1000", "键 = size:mtime");
  t.eq(logCacheKey({ size: 100, mtimeMs: 1001 }) === logCacheKey({ size: 100, mtimeMs: 1000 }), false, "mtime 变 ⇒ 键变");
  t.eq(logCacheKey({ size: 101, mtimeMs: 1000 }) === logCacheKey({ size: 100, mtimeMs: 1000 }), false, "size 变 ⇒ 键变");
  t.eq(logCacheKey({}), "", "拿不到 stat ⇒ 空键（调用方据此重算）");
};

tests["C465 summarizeLogEvents：缓存读数与 fold 事件都不带时间窗"] = (t) => {
  const s = summarizeLogEvents([
    ev("assistant/message", 100, { usage: { inputTokens: 100, cacheReadTokens: 900 } }),
    ev("compaction/end", 200, { error: "boom" }),
    ev("compaction/end", 300, {}),
    ev("compaction/summary", 150, { usage: { inputTokens: 50, outputTokens: 5 }, model: "m" }),
  ], { session: "abc" });
  t.eq(s.calls, 1, "一次带 usage 的调用");
  t.eq(s.ratios.length, 1, "命中率逐条留着（断点要按顺序算）");
  t.eq(s.folds.length, 2, "两次 fold 事件都留着 —— 时间窗不在这一层做");
  t.eq(s.folds[0].ok, false, "失败的要带 error");
  t.eq(s.folds[1].ok, true, "成功的");
  t.eq(s.logUsage.model, "m", "最近一次摘要的 usage");
};

tests["C465 replayLogStats：同一份缓存，换个 since 结论就不同（这是关键不变量）"] = (t) => {
  const part = summarizeLogEvents([
    ev("compaction/end", 100, { error: "old" }),
    ev("compaction/end", 900, { error: "new" }),
    ev("compaction/end", 950, {}),
  ], { session: "s1" });
  const recent = replayLogStats([part], { since: 800 });
  t.eq(recent.foldFail, 1, "窗口内失败 1 次");
  t.eq(recent.foldFailAll, 2, "历史失败仍要算总数");
  t.eq(recent.foldOk, 1, "窗口内成功 1 次");
  t.eq(recent.errors.length, 1, "只有窗口内的错误进名单");
  t.includes(recent.errors[0].error, "new", "而且是对的哪一条");
  const all = replayLogStats([part], { since: 0 });
  t.eq(all.foldFail, 2, "since=0 ⇒ 两次都算窗口内");
};

tests["C465 replayLogStats：多份日志按顺序拼接时，缓存断点要算对（跨文件也要比）"] = (t) => {
  const a = summarizeLogEvents([ev("assistant/message", 1, { usage: { inputTokens: 10, cacheReadTokens: 990 } })]);
  const b = summarizeLogEvents([ev("assistant/message", 2, { usage: { inputTokens: 900, cacheReadTokens: 100 } })]);
  const r = replayLogStats([a, b], { since: 0 });
  t.eq(r.calls, 2, "两次调用");
  t.eq(r.breaks, 1, "命中率从 99% 掉到 10% ⇒ 一次断点（跨文件边界也算）");
  t.eq(r.cacheTokens, 1090, "缓存读加起来");
};

tests["C465 replayLogStats：坏数据不许产生 NaN"] = (t) => {
  const r = replayLogStats([null, undefined, {}], { since: 0 });
  t.eq(Number.isNaN(r.calls), false, "calls 不是 NaN");
  t.eq(r.breaks, 0, "没有数据就没有断点");
  t.eq(r.logUsage, null, "没有 usage 就是 null");
};
