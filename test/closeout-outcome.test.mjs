/**
 * closeout-outcome.test.mjs —— 归档收尾「折了没有」必须落账（C466）
 *
 * 由来（2026-11-03 真机验证单）：两次归档都记下了 `closeout`（source=archive、尾巴 7706 / 1069 事件），
 * 但 `foldMarks` 是 0、会话日志里只有 `compaction/start` 没有 `end`，另一次是上游 **400**。
 * ⇒ 验证单要回答的问题（"尾巴压了没有"）在图上看不出来，只能人去翻日志。三种结局都要留痕。
 */
import { applyCloseoutOutcome } from "../src/rooms/closeout-plan.mjs";

export const tests = {};

tests["C466 折成功：分段折了几段要记下（不分段就是 1）"] = (t) => {
  const chunked = applyCloseoutOutcome({ source: "archive" }, { tier: "chunked", folded: 2, chunks: 3 }, null, 1000);
  t.eq(chunked.foldAttempted, true, "标记尝试过");
  t.eq(chunked.folded, 2, "折了 2 段");
  t.eq(chunked.chunkedChunks, 3, "总段数");
  t.eq(chunked.foldAt, 1000, "记录时刻");
  t.eq(chunked.source, "archive", "原有字段不许丢");
  const single = applyCloseoutOutcome({}, { tier: "single" }, null);
  t.eq(single.folded, 1, "不分段 = 1");
};

tests["C466 没东西可折 与 折失败 必须分开（这两种在运维上的含义完全相反）"] = (t) => {
  const nothing = applyCloseoutOutcome({}, null, null);
  t.eq(nothing.folded, 0, "没折");
  t.eq(nothing.foldNote, "nothing-to-fold", "说清是'没东西可折'");
  t.eq(nothing.foldError, undefined, "不是错误");
  const failed = applyCloseoutOutcome({}, null, new Error("400: upstream rejected"));
  t.eq(failed.folded, 0, "失败也是 0");
  t.includes(failed.foldError ?? "", "400", "错误文本留在图上 —— doctor 直接显示，不用翻日志");
  t.eq(failed.foldNote, undefined, "失败不许被打成'没东西可折'");
};

tests["C466 错误文本要截断（别让一整段 HTML 错误页把图撑爆）"] = (t) => {
  const long = applyCloseoutOutcome({}, null, new Error("x".repeat(5000)));
  t.eq((long.foldError ?? "").length <= 300, true, "最多 300 字符");
  // 字符串错误（不是 Error 实例）也要能处理
  const str = applyCloseoutOutcome({}, null, "boom");
  t.includes(str.foldError ?? "", "boom", "字符串错误照样记");
  // 老 closeout 没有 foldAttempted 时不许被当成已折过
  const legacy = applyCloseoutOutcome({ at: 1, eventsSinceLastFold: 7706, folds: 0, source: "archive" }, { tier: "chunked", folded: 1, chunks: 1 }, null);
  t.eq(legacy.foldAttempted, true, "补齐标记");
  t.eq(legacy.eventsSinceLastFold, 7706, "原有尾巴数保留（验证单要对账这个数）");
};

tests["C474 「没折」必须带原因：foldNote 要能区分'没内容'与'拿不到区间/超时'"] = (t) => {
  const noContent = applyCloseoutOutcome({ source: "archive" }, { tier: "single", skipped: "below-min-tokens" }, null);
  t.eq(noContent.folded, 0, "没折");
  t.includes(noContent.foldNote ?? "", "below-min-tokens", "原因要写进 closeout，而不是一句笼统的 nothing-to-fold");
  const timeout = applyCloseoutOutcome({}, { tier: "single", skipped: "timeout" }, null);
  t.includes(timeout.foldNote ?? "", "timeout", "超时也要单独能看出来");
  // 老行为（没有 skipped 字段）仍然是 nothing-to-fold
  const legacy = applyCloseoutOutcome({}, null, null);
  t.eq(legacy.foldNote, "nothing-to-fold", "没有原因时保持旧文案");
};

tests["C479 分段收尾没折完也要留原因（真机 c460d468：0/2 段、无任何原因）"] = (t) => {
  const partial = applyCloseoutOutcome({ source: "archive" }, { tier: "chunked", folded: 0, chunks: 2, stopped: "deadline", error: null }, null);
  t.eq(partial.folded, 0, "0 段折成");
  t.eq(partial.chunkedChunks, 2, "计划 2 段");
  t.eq(partial.chunkStopped, "deadline", "停在哪必须记下（deadline / error / done）");
  t.includes(partial.foldNote ?? "", "chunked-incomplete", "没折完要有可读结论");
  // 有错误时，错误优先于"没折完"
  const errored = applyCloseoutOutcome({}, { tier: "chunked", folded: 1, chunks: 3, stopped: "error", error: "429 rate limit" }, null);
  t.includes(errored.foldError ?? "", "429", "错误要原样留下");
  t.eq(errored.foldNote, undefined, "有错误就不该再写'没折完'");
  // 全部折完 ⇒ 不加噪音字段
  const all = applyCloseoutOutcome({}, { tier: "chunked", folded: 3, chunks: 3, stopped: "done", error: null }, null);
  t.eq(all.foldNote, undefined, "折完了不许写'没折完'");
  t.eq(all.folded, 3, "段数照记");
};
