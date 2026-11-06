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

tests["C341 planRounds：按段数贪心装箱，每轮不超上限，大尾巴先补"] = async (t) => {
  const { planRounds } = await import("../scripts/backfill-plan.mjs");
  t.eq(typeof planRounds, "function", "必须导出 planRounds");

  const rounds = planRounds(
    [
      { sessionId: "big1", chunks: 6 },
      { sessionId: "big2", chunks: 6 },
      { sessionId: "s3", chunks: 3 },
      { sessionId: "s3b", chunks: 3 },
      { sessionId: "tiny", chunks: 1 },
    ],
    { maxChunksPerRound: 6 },
  );
  // 每轮都不许超上限
  for (const round of rounds) t.eq(round.chunks <= 6, true, `第 ${round.round} 轮超上限：${round.chunks}`);
  // 6 段的独占一轮（装不下别的）
  t.eq(rounds[0].sessions, ["big1"], "最大的先补且独占一轮");
  t.eq(rounds[1].sessions, ["big2"], "第二大也独占");
  // 3+3 能合成一轮
  t.eq(rounds[2].sessions.sort(), ["s3", "s3b"], "两个 3 段应合成一轮");
  // 所有会话都被排进去，一个不丢
  const all = rounds.flatMap((r) => r.sessions).sort();
  t.eq(all, ["big1", "big2", "s3", "s3b", "tiny"], "不许漏掉任何会话");
  // 轮次编号连续
  t.eq(rounds.map((r) => r.round), rounds.map((_, i) => i + 1), "轮次编号要连续");
  // 空输入
  t.eq(planRounds([]), [], "空输入 ⇒ 空批次");
};

tests["C342 调度口径：按「每次点击 20 个会话」算点击数，并点出「一次补不完」的会话"] = async (t) => {
  const { summarizePlan } = await import("../scripts/backfill-plan.mjs");
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, tail: 100, estTokens: 200000, chunks: 2, requiredChunks: 2, ...extra }));

  t.eq(summarizePlan(mk(0)).clicks, 0, "空计划 0 次点击");
  t.eq(summarizePlan(mk(1)).clicks, 1, "1 个会话 1 次");
  t.eq(summarizePlan(mk(20)).clicks, 1, "正好 20 个 ⇒ 1 次");
  t.eq(summarizePlan(mk(21)).clicks, 2, "21 个 ⇒ 2 次");
  t.eq(summarizePlan(mk(46)).clicks, 3, "46 个 ⇒ 3 次（真机就是这个量级）");

  // requiredChunks > 6 的会话要点出来（一次点击补不完）
  const rows = [...mk(2), { sessionId: "huge", tail: 100, estTokens: 2_000_000, chunks: 6, requiredChunks: 14 }];
  const plan = summarizePlan(rows);
  t.eq(plan.multiPass, 1, "只有那一个超大会话算 multiPass");
  // requiredChunks 缺失时不许误报
  t.eq(summarizePlan([{ sessionId: "x", tail: 1, estTokens: 1, chunks: 1 }]).multiPass, 0, "缺字段不误报");
};

tests["C343 recommendMaxFoldTokens：给出「调到多少能让最大的会话一次折完」"] = async (t) => {
  const { recommendMaxFoldTokens } = await import("../scripts/backfill-plan.mjs");
  t.eq(typeof recommendMaxFoldTokens, "function", "必须导出 recommendMaxFoldTokens");

  // 没有可估的会话 ⇒ null（不许瞎给建议）
  t.eq(recommendMaxFoldTokens([]), null, "空输入 null");
  t.eq(recommendMaxFoldTokens([{ estTokens: null }]), null, "全都估不出也要 null");

  // 2.0M / 6 段 ⇒ 需要 333,334 一段
  const rec = recommendMaxFoldTokens([{ estTokens: 2_000_000 }, { estTokens: 500_000 }]);
  t.eq(rec.needed, Math.ceil(2_000_000 / 6), "取最大需求（按 6 段）");
  t.eq(rec.value, rec.needed, "在上限内时直接用需求值");
  t.eq(rec.fits, true, "能装下");

  // 超上限 ⇒ 夹到上限，并标记 fits=false（诚实说补不完）
  const over = recommendMaxFoldTokens([{ estTokens: 9_000_000 }], { max: 800000 });
  t.eq(over.value, 800000, "夹到配置上限");
  t.eq(over.fits, false, "超上限要标 false，不能假装能一次补完");

  // 低于下限 ⇒ 抬到下限（配置有最小值）
  t.eq(recommendMaxFoldTokens([{ estTokens: 1000 }], { min: 20000 }).value, 20000, "低于下限要抬到下限");

  // 建议值必须落在配置允许区间内（20000–800000）
  const real = recommendMaxFoldTokens([{ estTokens: 1_146_214 }]);
  t.eq(real.value >= 20000 && real.value <= 800000, true, `建议值必须在配置区间内：${real.value}`);
};

tests["C368 耗时估算：真机中位/ p90 分位，且超时风险要按 p90 判"] = async (t) => {
  // C370 起分位统计住在 closeout-plan 房间（引擎与脚本共用一份），这里从房间取
  const { foldDurationStats } = await import("../src/rooms/closeout-plan.mjs");
  const { estimateSessionRuntime } = await import("../scripts/backfill-plan.mjs");
  t.eq(typeof foldDurationStats, "function", "房间必须导出 foldDurationStats");
  t.eq(typeof estimateSessionRuntime, "function", "脚本必须导出 estimateSessionRuntime");

  const d = foldDurationStats([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 20000]);
  t.eq(d.n, 10, "10 个样本");
  t.eq(d.median, 6000, "中位取第 5 个（0.5×10）");
  t.eq(d.p90, 20000, "p90 取最后一个");
  t.eq(foldDurationStats([]).median, null, "空样本 ⇒ null");
  t.eq(foldDurationStats([0, -1, null]).n, 0, "非法值要过滤");

  // 6 段 × p90 19s = 114s > 90s ⇒ risky
  const six = estimateSessionRuntime(6, 11746, 19000, 90000);
  t.eq(six.estMs, 6 * 11746, "估算用中位");
  t.eq(six.risky, true, "p90 × 段数超时就要标 risky");
  // 1 段不 risky
  t.eq(estimateSessionRuntime(1, 11746, 19000, 90000).risky, false, "单段不该 risky");
  // 没有样本 ⇒ 不估算、也不误报
  t.eq(estimateSessionRuntime(3, null, null, 90000), { estMs: null, risky: false }, "无样本 ⇒ 不估也不报险");
};

tests["C369 分段收尾的超时建议：段数 × p90 超了就点名，拿不到 p90 就不瞎报"] = async (t) => {
  const { closeoutTimeoutAdvice } = await import("../src/rooms/closeout-plan.mjs");
  t.eq(typeof closeoutTimeoutAdvice, "function", "必须导出 closeoutTimeoutAdvice");

  // 真机数字：6 段 × 19s = 114s > 90s ⇒ 必须报
  const bad = closeoutTimeoutAdvice(6, 90_000, 19_000);
  t.eq(bad.ok, false, "6 段 × p90 19s 应判超时");
  t.eq(bad.worstMs, 114_000, "worst = 段数 × p90");
  t.includes(bad.message, "closeoutTimeoutMs", "要给出可操作的旋钮");

  // 3 段 × 19s = 57s < 90s ⇒ 不报
  t.eq(closeoutTimeoutAdvice(3, 90_000, 19_000).ok, true, "3 段不该报");
  // 拿不到 p90 ⇒ 不瞎报（宁可不说）
  t.eq(closeoutTimeoutAdvice(6, 90_000, null), { ok: true, worstMs: null, message: "" }, "没有 p90 时不许猜");
  // 段数非法时按 1 段
  t.eq(closeoutTimeoutAdvice(0, 90_000, 200_000).ok, false, "段数 0 按 1 段算：200s > 90s");
};

tests["C370 K-23 接线：p90 从图上 foldMark 现算（不再依赖从未赋值的字段）"] = async (t) => {
  const { recentFoldP90, foldDurationStats } = await import("../src/rooms/closeout-plan.mjs");
  t.eq(typeof recentFoldP90, "function", "必须有 recentFoldP90");

  const marks = Array.from({ length: 10 }, (_, i) => ({ ms: (i + 1) * 1000 })); // 1s..10s
  // 只取最近 20 条：这里 10 条全取，p90 = 第 floor(10*0.9)=9 个 = 10000
  t.eq(recentFoldP90(marks), 10000, `最近 10 条 p90 应为 10000，实际 ${recentFoldP90(marks)}`);
  // window 生效：只取最近 3 条（8/9/10s）⇒ p90 = 最后一条 10000
  t.eq(recentFoldP90(marks, 3), 10000, "window=3 时取最近三条");
  // 没有 ms ⇒ null（不许瞎报）
  t.eq(recentFoldP90([{ ms: 0 }, { ms: null }]), null, "没有有效 ms ⇒ null");
  t.eq(recentFoldP90([]), null, "空数组 ⇒ null");

  // 真 Engine 接线：大尾巴进入分段收尾时，必须消费图上的 foldMark.ms 并打出 p90 警告。
  // 删除 recentFoldP90 import 后，引擎内部 catch 会把缺失绑定吞成 null，这条警告会消失。
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const { load, makeCtx, makeSession } = await import("./engine-harness.test.mjs");
  const { Engine } = await load();
  const runCloseout = async (ms) => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c370-"));
    const id = `sess-c370-${String(ms)}`;
    try {
      const ctx = makeCtx({ measureTotal: () => 10_000 });
      const engine = new Engine(ctx, { graphDir: dir, auto: false, closeoutMinEvents: 1, closeoutTimeoutMs: 90_000 });
      const session = makeSession({ id });
      for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
      await ctx.emitRaw("session/event", session, {
        type: "user/message",
        data: { id: "u", role: "user", content: [{ type: "text", text: "root" }], source: { kind: "prompt" } },
      });
      const graph = engine.graphs.get(id);
      t.eq(!!graph, true, "夹具必须先让引擎读到真图");
      for (const node of Object.values(graph.nodes)) node.seq = 200_000;
      graph.foldMarks = [{ seqStart: 0, seqEnd: 100, shadowedTokens: 100_000, ms }];
      await engine.closeoutNow({ session, options: {} });
      return ctx.warns;
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const warns = await runCloseout(100_000);
  t.eq(warns.some((line) => line.includes("6 段 × p90 100.0s = 600s > 超时 90s")), true,
    `p90 必须真的进入分段超时建议：${JSON.stringify(warns)}`);
  const noP90Warns = await runCloseout(null);
  t.eq(noP90Warns.some((line) => line.includes("× p90")), false,
    `没有有效 ms 时不许虚构 p90 警告：${JSON.stringify(noP90Warns)}`);
};

tests["C414 计划里也要列出「最小的三个」（验证通道要先从便宜的一端试）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "backfill-plan.mjs"), "utf8");
  t.includes(src, "最小的 ${smallest.length} 个", "必须打印最小三个（C414）");
  t.includes(src, "适合先验证通道", "要说明它们的用途");
  t.includes(src, "a.tail ?? 0) - (b.tail ?? 0)", "必须按 tail 升序（与默认降序相反）");
};
