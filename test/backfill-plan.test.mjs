/**
 * backfill-plan.test.mjs —— 「补账要几轮、多少钱」的算法必须可复算（C339）
 *
 * 为什么值得单测：这个数字会直接决定用户"现在补还是以后补"。
 * 算错方向比算错 1% 更伤：说成 1 轮，用户点下去发现要跑 8 轮。
 */
import { summarizePlan, COLD_INPUT_PER_MTOK } from "../scripts/backfill-plan.mjs";

export const tests = {};

tests["C339 summarizePlan：段数决定轮次，估不出的不计钱但要点数"] = (t) => {
  const rows = [
    { sessionId: "a", tail: 9000, estTokens: 1_000_000, chunks: 6 },
    { sessionId: "b", tail: 3000, estTokens: 500_000, chunks: 3 },
    { sessionId: "c", tail: 100, estTokens: null, chunks: 1 }, // 估不出
  ];
  const plan = summarizePlan(rows, { maxChunks: 6 });
  t.eq(plan.total, 3, "总数含估不出的");
  t.eq(plan.estimable, 2, "可估 2 个");
  t.eq(plan.unknown, 1, "估不出 1 个");
  t.eq(plan.tokens, 1_500_000, "只累加可估的 token");
  t.eq(plan.chunks, 9, "段数 6+3");
  t.eq(plan.rounds, 2, "9 段 / 每轮 6 ⇒ 2 轮");
  t.eq(plan.costUsd > 0, true, "要给出估价");
};

tests["C339 轮次按 6 段一轮向上取整；空计划是 0 轮 0 元"] = (t) => {
  t.eq(summarizePlan([{ estTokens: 1, chunks: 6 }]).rounds, 1, "正好 6 段 ⇒ 1 轮");
  t.eq(summarizePlan([{ estTokens: 1, chunks: 7 }]).rounds, 2, "7 段 ⇒ 2 轮");
  const empty = summarizePlan([]);
  t.eq([empty.rounds, empty.costUsd, empty.total], [0, 0, 0], "空计划全 0");
  // 单价口径要能被参数覆盖（改价时不用改代码逻辑）
  const cheap = summarizePlan([{ estTokens: 1_000_000, chunks: 0 }], { coldInputPerMTok: COLD_INPUT_PER_MTOK / 2 });
  const full = summarizePlan([{ estTokens: 1_000_000, chunks: 0 }]);
  t.eq(cheap.costUsd < full.costUsd, true, "单价减半 ⇒ 估价更低");
};
