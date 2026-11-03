/**
 * closeout-plan.test.mjs —— 分段收尾的计划（C520）
 *
 * 由来：C519 让「离线补折留下的前段缺口」计入欠账，但**计划**还是按尾巴算的 ——
 * 缺口型会话 `tail=0` ⇒ `closeoutExceedsLimit` 返回 null ⇒ 0 段 ⇒ 永远补不了
 * （真机 session-00b50089：尾巴 0 事件、缺口 1,043k tok、**0 段**）。
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
