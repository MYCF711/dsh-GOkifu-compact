/**
 * backfill-throughput.test.mjs —— 补账**吞吐**的三条守卫（C599，2026-11-05）
 *
 * 为什么要有这一组：真机上"218 个欠账 / 一天只折 84 段"被排查了三轮才看清，
 * 每次都是**同一个形状**：某个数写死了（轮数写死 3、会话数写死 5），
 * 于是"预算给了也不提速"，而代码里没有任何东西会红。
 *
 * 这一组钉住三件事：
 *   ① `roundsWithinBudget` 的算术（剩余预算 ÷ 实测段耗时 ⇒ 还能开几轮，且有界）；
 *   ② 离线折叠的**重试要先算得过来**（截止时间装不下就不开第二次，保住第一段）；
 *   ③ 引擎 tick 的补位/自适应轮数**仍然有界、仍然串行**（并发不许被顺手破掉）。
 *
 * 全部是纯函数 / 源码断言，不联网、不调模型、不写盘。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { roundsWithinBudget, runOfflineFold, HARD_MAX_TOKENS } from "../src/rooms/offline-fold.mjs";
import { segmentsPerTick, throughputPerHour, invert, segmentPlan, forecast } from "../scripts/backfill-forecast.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const read = (...parts) => nodeFs.readFileSync(nodePath.join(ROOT, ...parts), "utf8");

export const tests = {};

/* ───────────────────────── ① 轮数算术 ───────────────────────── */

tests["C599 roundsWithinBudget：剩余预算 ÷ 实测段耗时（并夹在上限内）"] = async (t) => {
  // 真机：段耗时中位 48.5s / 均值 79s，tick 预算 420s
  t.eq(roundsWithinBudget({ remainingMs: 420_000, segmentMs: 79_000 }), 5, "420s ÷ 79s = 5 轮");
  t.eq(roundsWithinBudget({ remainingMs: 420_000, segmentMs: 48_500 }), 8, "48.5s 的段能装满 8 轮（天花板）");
  t.eq(roundsWithinBudget({ remainingMs: 60_000, segmentMs: 79_000 }), 1, "只够 0.76 段 ⇒ 仍允许开 1 轮（≥60%）");
  t.eq(roundsWithinBudget({ remainingMs: 30_000, segmentMs: 79_000 }), 0, "只够 0.38 段 ⇒ 0 轮，别开了");
  t.eq(roundsWithinBudget({ remainingMs: 10_000_000, segmentMs: 1_000 }), 8, "算多大都不许突破天花板 8");
  t.eq(roundsWithinBudget({ remainingMs: 420_000, segmentMs: 0 }), 8, "段耗时还没测到 ⇒ 交给天花板，让第一段去测");
  t.eq(roundsWithinBudget({ remainingMs: 420_000, segmentMs: 79_000, cap: 3 }), 3, "cap 更小时按 cap");
  // 单调性：预算越多，轮数不下降（这条能抓住"把 budget 调大反而不干活"的回归）
  const a = roundsWithinBudget({ remainingMs: 180_000, segmentMs: 79_000, cap: 99 });
  const b = roundsWithinBudget({ remainingMs: 900_000, segmentMs: 79_000, cap: 99 });
  t.ok(b >= a, `预算从 180s 加到 900s，轮数不许减少（${a} → ${b}）`);
};

/* ───────────────────────── ② 截止时间感知的重试 ───────────────────────── */

const graph = {
  rootUserNodeIds: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] } },
  edges: {},
};
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(1, "把构建跑通"), a(2, "先看配置"), a(3, "改了本地配置"), u(4, "继续"), a(5, "跑通了")];
/** 同步自旋：让"这一次调用花了多久"变成一个**确定**的大数字（不用 sleep，不受调度抖动影响）。 */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 纯自旋 */
  }
};

tests["C599 重试要算得过来：截止时间装不下就不再调第二次（保住第一段）"] = async (t) => {
  let calls = 0;
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    // 真机：第一次调用 ~48-197s，第二次预算翻倍 ⇒ 撞 240s 截止 ⇒ `Promise.race` 返回空 ⇒ 整段作废
    deadline: Date.now() + 200,
    callModel: async () => {
      calls += 1;
      spin(calls === 1 ? 250 : 5); // 第一次就超过截止时间 ⇒ 第二次注定跑不完
      return { text: "## 目标\n- 把构建跑通", finish: "max_tokens", usage: { completion_tokens: 8192 }, model: "fake" };
    },
    measureQuality: () => null,
  });
  t.eq(calls, 1, "截止时间剩不下一次调用 ⇒ 只许调 1 次（第二次必然白花）");
  t.eq(out.chunks.length, 1, "第一段必须保住（以前会连它一起作废）");
  t.eq(out.chunks[0].truncated, true, "保住的同时要诚实标 truncated");
  t.eq(out.chunks[0].retrySkipped, true, "要留下'重试被截止时间挡掉'的痕迹，否则读图的人以为这条路不会重试");
};

tests["C599 时间够就照旧重试一次（这条保证上面的守卫没把正常路径关掉）"] = async (t) => {
  let calls = 0;
  const budgets = [];
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    deadline: Date.now() + 600_000,
    callModel: async (prompt, { maxTokens }) => {
      calls += 1;
      budgets.push(maxTokens);
      if (calls === 1) return { text: "## 目标", finish: "max_tokens", usage: { completion_tokens: maxTokens }, model: "fake" };
      return { text: "## 目标\n- 把构建跑通\n## 约束\n- 不许动 prod 配置", finish: "stop", usage: { completion_tokens: 40 }, model: "fake" };
    },
    measureQuality: () => null,
  });
  t.eq(calls, 2, "时间够 ⇒ 仍要放大重试一次");
  t.eq(out.chunks[0].truncated, false, "第二次没截断 ⇒ 记成完整");
  t.eq(out.chunks[0].retrySkipped, false, "正常重试不许被标成 skipped");
  t.ok(budgets[1] > budgets[0], `重试预算要更大（${budgets[0]} → ${budgets[1]}）`);
  t.ok(budgets[1] <= HARD_MAX_TOKENS, `重试预算不许突破硬上限 ${HARD_MAX_TOKENS}（实际 ${budgets[1]}）`);
};

/* ───────────────────────── ③ 引擎 tick 的有界性 ───────────────────────── */

tests["C599 tick：补位与自适应轮数都存在，而且仍然有界、仍然串行"] = async (t) => {
  const src = read("src", "engine.mjs");
  const at = src.indexOf("async #autoBackfillTick");
  t.ok(at > 0, "要有 #autoBackfillTick");
  const tick = src.slice(at, at + 12_000);
  t.includes(tick, "autoBackfillQueue", "要有补位队列（picked 全失败时一轮不许白跑）");
  t.includes(tick, "autoBackfillSegmentBlocker", "要有一个'还能不能再开一段'的统一判据");
  t.includes(tick, "roundsWithinBudget", "轮数要由剩余预算 ÷ 实测段耗时算");
  t.includes(tick, "_backfillSegMs", "要记实测段耗时（跨轮保留）");
  // 有界：三处硬上限都在
  t.includes(tick, "Math.min(10, ", "补位的总尝试次数要有硬上限");
  t.includes(tick, "Math.min(5, adaptive)", "每轮会话数上限仍然是 5");
  t.includes(tick, "cap: 8", "轮数天花板是 8");
  t.eq(/while \(true\)/.test(tick), false, "不许写死循环");
  t.eq(/for \(;;\)/.test(tick), false, "也不许写 for(;;)");
  // 串行：tick 里不许出现并发原语（并发 1 是硬约束）
  t.eq(/Promise\.all|Promise\.allSettled/.test(tick), false, "补账必须串行（并发会把磁盘/内存峰值放大到不可控）");
  // 保底轮数仍可配置，且是被 max() 抬起来的下界，不是天花板
  t.includes(tick, "const roundsFloor = Math.max(1, Math.min(8, Number(process.env.DSH_GOKIFU_AUTO_BACKFILL_ROUNDS) || 3))", "环境变量仍是保底轮数");
  t.includes(tick, "Math.max(roundsFloor, autoBackfillRounds(", "实际轮数 = max(保底, 预算算出来的)");
};

tests["C599 tick：一轮 0 产出不再把它算成'完成'（否则日志把失败报成成绩）"] = async (t) => {
  const src = read("src", "engine.mjs");
  const at = src.indexOf("async #autoBackfillTick");
  const tick = src.slice(at, at + 12_000);
  t.includes(tick, "if (marks > 0) done += 1;", "只有真折出东西才计入 done");
  t.includes(tick, "else idle += 1;", "0 产出的要单独计数");
  t.includes(tick, "if (foldedNow === 0) break;", "同一会话 0 产出就别连打（让补位换下一个）");
  t.includes(src, "report.attempts = attempts", "状态文件要能看出'试了几个、成了几个'");
};

/* ───────────────────────── ④ 测算器自身的算术 ───────────────────────── */

tests["C599 测算器：预算翻倍 ⇒ 吞吐翻倍，但被'会话数×轮数'封顶"] = async (t) => {
  const base = throughputPerHour({ intervalMin: 30, budgetSec: 420, segmentSec: 79, max: 5, rounds: 3 });
  const more = throughputPerHour({ intervalMin: 30, budgetSec: 900, segmentSec: 79, max: 5, rounds: 3 });
  t.ok(more.perHour > base.perHour, `预算 420→900 吞吐要涨（${base.perHour} → ${more.perHour}）`);
  const tiny = segmentsPerTick({ budgetSec: 60_000, segmentSec: 79, max: 5, rounds: 3 });
  t.eq(tiny.segments, 15, "预算再大也只到 5×3=15 段/轮");
  t.eq(tiny.limitedBy, "sessions", "这时瓶颈是会话数×轮数，不是预算");
  // ★ 占空比：预算 420 / 间隔 1800 ⇒ 一天里 77% 的时间在等下一轮
  const d = throughputPerHour({ intervalMin: 30, budgetSec: 420, segmentSec: 79, max: 5, rounds: 3 });
  t.ok(d.duty > 0.2 && d.duty < 0.3, `占空比要如实反映"预算只占间隔的一小部分"（实际 ${d.duty.toFixed(2)}）`);
  // 预算是间隔的两倍时不许算出"神仙速度"：受 `_autoBackfillBusy` 约束，节奏仍是 间隔/本轮耗时 里的大者
  const over = throughputPerHour({ intervalMin: 30, budgetSec: 1800, segmentSec: 79, max: 5, rounds: 3 });
  t.ok(over.perHour <= 3600 / 79 + 1e-6, `吞吐不许超过模型地板 3600/79（实际 ${over.perHour.toFixed(1)}）`);
};

tests["C599 测算器：目标时间越短，要求的会话数/预算越高（反解不许骗人）"] = async (t) => {
  const fast = invert({ totalSegments: 1050, hours: 24, intervalMin: 30, rounds: 3, segmentSec: 79, efficiency: 0.8, maxSessions: 5 });
  const slow = invert({ totalSegments: 1050, hours: 120, intervalMin: 30, rounds: 3, segmentSec: 79, efficiency: 0.8, maxSessions: 5 });
  t.ok(fast.requiredPerHour > slow.requiredPerHour, "24h 需要的段/小时必须高于 120h");
  t.ok(fast.requiredBudgetSec > slow.requiredBudgetSec, "24h 需要的预算必须更多");
  t.eq(fast.feasible, false, "24h 在 max=5 的硬上限下做不到 —— 必须诚实标出来");
  t.eq(slow.feasible, true, "120h 在现有上限内做得到");
  t.includes(fast.blocker, "硬上限", "做不到时要说是哪一项卡住");
};

tests["C599 测算器：cap 不是越小越快（reasoning 会吃掉预算，触发 2 倍重试）"] = async (t) => {
  const plan = segmentPlan(4096, { outputTokens: 6190, speed: 127.6, reasoningTokens: 3436 });
  t.eq(plan.retried, true, "cap=4096 装不下 3436 的思考 + 正常正文 ⇒ 会触发重试");
  t.ok(plan.seconds > 48, `cap=4096 的实际代价要高于 8192 的那 48s（实际 ${plan.seconds.toFixed(0)}s）`);
  const big = segmentPlan(16384, { outputTokens: 6190, speed: 127.6, reasoningTokens: 3436 });
  t.ok(big.seconds > 90, "cap=16384 要让一段跑 ~97s（真机 C595 已实测翻倍）");
  const norm = segmentPlan(8192, { outputTokens: 6190, speed: 127.6, reasoningTokens: 3436 });
  t.ok(Math.abs(norm.seconds - 48.5) < 3, `cap=8192 要能复现真机 ~48.5s（实际 ${norm.seconds.toFixed(1)}s）`);
};

tests["C599 测算器：段数按'每段覆盖多少事件'算，而不是'一个会话一段'"] = async (t) => {
  const items = [
    { sessionId: "a", tail: 100, gapEvents: 0 },
    { sessionId: "b", tail: 465, gapEvents: 0 },
    { sessionId: "c", tail: 0, gapEvents: 928 },
  ];
  const f = forecast({ items, measured: { eventsPerSegment: 232, segmentSec: 79, outputTokens: 6190, inputTokens: 14_243 } });
  t.eq(f.totalSegments, 1 + 3 + 4, "100→1、465→3、928→4（ceil）");
  t.eq(f.sessions, 3, "3 个会话");
  t.ok(f.totalSegments > f.sessions, "段数必须大于会话数 —— 这就是'218 个欠账不等于 218 段'的那条");
  t.ok(f.costUsd > 0, "要给出估价");
  // 钱的口径：段数 × (14.2k in × $0.15/M + 6.2k out × $0.6/M) ≈ $0.0059/段
  t.ok(Math.abs(f.costUsd / f.totalSegments - 0.00587) < 0.0005, `每段约 $0.0059（实际 ${(f.costUsd / f.totalSegments).toFixed(5)}）`);
};
