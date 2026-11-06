/**
 * gap-coordinate-unit.test.mjs —— 「可折条数」与「seq 坐标」不得混用的**单元级**守卫。
 *
 * 为什么单独有这份（而不是只靠 gap-coordinate.test.mjs 的端到端）：
 *   那条端到端夹具假设「首轮**尾折** [9,10] 留下缺口」，但离线补账**设计就是从头取**
 *   （`offline-fold.mjs:342-343`、`:959-962`），首轮全折 [1,10] 后**根本没有缺口留给第二轮** ——
 *   它**复现不了自己想测的场景**，所以 P0 必须由「直接喂一个带缺口的图」的单元测试来守。
 *
 * P0（严格审核实测）：`gapEnd = from + events - 1` 把**可折条数**当 **seq 跨度**，
 *   混合非消息事件时窗口被算小 ⇒ 某些 seq **永久漏折**。
 */
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { uncoveredFoldable } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const msg = (seq, type = "user/message") => ({
  type, seq, data: { message: { content: [{ type: "text", text: "x" }] } },
});
const noise = (seq, type = "step/start") => ({ type, seq, data: {} });

/** 可折消息在 seq 1/3/5，中间夹着非消息事件 —— 条数 3，但坐标跨度是 1..5。 */
const mixed = () => [msg(1), noise(2), msg(3, "assistant/message"), noise(4), msg(5), noise(6, "turn/start")];

tests["gap.end 必须是真实 seq 终点，不是 from + events - 1"] = async (t) => {
  const graph = {
    closeout: { offlineUncoveredHead: { events: 3, from: 1, to: 5 } },
    foldMarks: [], nodes: {},
  };
  const gap = debtOfGraph(graph, { minEvents: 1 }).gap;
  t.eq(gap.from, 1, "缺口起点");
  t.eq(gap.events, 3, "缺口条数（用于判断值不值得折）");
  t.eq(gap.end, 5, "缺口终点必须是**真实 seq**（条数 3 ≠ 跨度）");
  t.ok(gap.end !== gap.from + gap.events - 1, "条数当跨度 = 3，会把 seq5 漏在窗外");
};

tests["老记录没有 to 时仍可读（向后兼容，不许炸）"] = async (t) => {
  const graph = { closeout: { offlineUncoveredHead: { events: 3, from: 1 } }, foldMarks: [], nodes: {} };
  const gap = debtOfGraph(graph, { minEvents: 1 }).gap;
  t.eq(gap.from, 1);
  t.eq(gap.events, 3);
  t.eq(gap.end, undefined, "老记录没有 to ⇒ 不虚构坐标（下游回退旧公式）");
};

tests["uncoveredFoldable 必须带回真实 seq 区间（headFrom/headTo/totalFoldable）"] = async (t) => {
  const events = mixed();
  const out = uncoveredFoldable(events, { rangeStart: 1, rangeEnd: 6, coveredStart: null, coveredEnd: null });
  t.eq(out.totalFoldable, 3, "总可折条数");
  t.eq(out.uncoveredHead, 0, "还没折 ⇒ head 缺口 0");
  // 已折到 seq3：剩下的可折缺口在 seq5
  const part = uncoveredFoldable(events, { rangeStart: 1, rangeEnd: 6, coveredStart: 1, coveredEnd: 3 });
  t.eq(part.uncoveredTail, 1, "coveredEnd=3 之后还剩 seq5 一条");
};

tests["混合非消息事件：条数 3 但坐标必须到 seq5"] = async (t) => {
  const events = mixed();
  // 已折 seq9/10 的尾巴场景改用「直接喂缺口」的图来守，不依赖端到端的方向假设。
  const graph = { closeout: { offlineUncoveredHead: { events: 3, from: 1, to: 5 } }, foldMarks: [], nodes: {} };
  const debt = debtOfGraph(graph, { minEvents: 1 });
  t.eq(debt.gap.end, 5, "第二轮窗口终点必须覆盖到 seq5");
  t.ok(debt.due, "还有缺口 ⇒ 仍欠账");
};
