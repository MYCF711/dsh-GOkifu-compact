/**
 * closeout-plan.test.mjs —— 分段收尾的计划（C520）
 *
 * 由来：C519 让「离线补折留下的前段缺口」计入欠账，但**计划**还是按尾巴算的 ——
 * 缺口型会话 `tail=0` ⇒ `closeoutExceedsLimit` 返回 null ⇒ 0 段 ⇒ 永远补不了
 * （真机 <SESSION_ID>：尾巴 0 事件、缺口 1,043k tok、**0 段**）。
 */
import { planChunkedCloseout } from "../src/rooms/closeout-plan.mjs";

export const tests = {};


tests["C520 只有前段缺口（尾巴已归零）也必须能切出分段，且第一段从缺口起点开始"] = async (t) => {
  const g = {
    nodes: { n1: { seq: 1 }, n2: { seq: 12000 } },
    foldMarks: [{ seqStart: 11500, seqEnd: 12000, trigger: "archive-offline", shadowedTokens: 50000 }],
    closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true, partial: true, offlineUncoveredHead: { from: 1, events: 11499 } },
  };
  const planned = planChunkedCloseout(g, { maxTokens: 150_000, maxChunks: 6 });
  t.eq(planned !== null, true, "有缺口就必须能给出计划（以前返回 0 段）");
  t.eq(planned.chunks.length > 0, true, `必须切出分段，实际 ${planned?.chunks?.length}`);
  t.eq(planned.chunks[0].start, 1, "第一段从缺口起点（from=1）开始");
  t.eq(planned.gap.events, 11499, "计划里要带出缺口大小");

  // 尾巴和缺口都没有 ⇒ 仍然返回 null（不伪造工作量）
  const empty = { nodes: { n1: { seq: 1 } }, foldMarks: [], closeout: { at: 1, source: "archive", foldAttempted: true, folded: 1 } };
  t.eq(planChunkedCloseout(empty, { maxTokens: 150_000 }), null, "没有活可干时不许编出一个计划");
};

tests["C531 「调用了」不等于「折了」：空转的段不许计入 folded"] = async (t) => {
  const m = await import("../src/rooms/closeout-plan.mjs");
  const chunks = [{ start: 1, end: 100 }, { start: 101, end: 200 }];

  // 正常：两段都真折了
  const ok = await m.runChunkedCloseout({ chunks, deadline: Date.now() + 10_000, fold: async () => ({ ok: true }) });
  t.eq(ok.folded, 2, "两段都算");

  // 空转：宿主返回但什么都没变 —— 真机 <SESSION_ID> 就是这个形状
  const noop = await m.runChunkedCloseout({ chunks, deadline: Date.now() + 10_000, fold: async () => ({ folded: false, skipped: "no-op" }) });
  t.eq(noop.folded, 0, "空转一段都不许算");
  t.eq(noop.stopped, "no-op", "要说明停下来的原因（好让上层去走离线补折）");

  // 第一段成功、第二段空转 ⇒ 只算一段，且停下
  let n = 0;
  const partial = await m.runChunkedCloseout({ chunks, deadline: Date.now() + 10_000, fold: async () => (++n === 1 ? { ok: true } : { folded: false }) });
  t.eq(partial.folded, 1, "只算真正折掉的那一段");
  t.eq(partial.stopped, "no-op", "空转就停（继续折后面也是空转）");
};
