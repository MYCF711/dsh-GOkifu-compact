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

tests["C340 零 fold 的会话用全局均值粗估，且必须与精确估计分开点名"] = async (t) => {
  const { summarizePlan, averageTokensPerEvent } = await import("../scripts/backfill-plan.mjs");
  t.eq(typeof averageTokensPerEvent, "function", "必须导出 averageTokensPerEvent");

  // 均值只统计"有值且为正"的样本
  t.eq(averageTokensPerEvent([{ tokensPerEvent: 100 }, { tokensPerEvent: 200 }, { tokensPerEvent: null }]), 150, "忽略空样本");
  t.eq(averageTokensPerEvent([]), null, "没有样本 ⇒ null（不许瞎编）");

  const rows = [
    { sessionId: "a", tail: 1000, estTokens: 500_000, chunks: 3 },
    { sessionId: "b", tail: 2000, estTokens: null, chunks: 1 }, // 零 fold，靠粗估
  ];
  const plan = summarizePlan(rows, { roughPerEvent: 150 });
  t.eq(plan.estimable, 1, "精确可估 1 个");
  t.eq(plan.rough, 1, "粗略可估 1 个");
  t.eq(plan.unknown, 0, "不要再算成估不出");
  t.eq(plan.tokens, 500_000 + 2000 * 150, "粗估要计入总量（2000×150）");

  // 没给均值 ⇒ 退回"估不出"（不许静默按 0 算）
  const noRough = summarizePlan(rows);
  t.eq(noRough.unknown, 1, "没有均值时必须老实说估不出");
  t.eq(noRough.rough, 0, "不许凭空粗估");
};
