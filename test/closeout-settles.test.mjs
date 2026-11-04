/**
 * closeout-settles.test.mjs —— 「有 closeout」不等于「这笔账结清了」（C476）
 *
 * 真机：归档后写了 `{foldAttempted:true, folded:0, foldNote:"nothing-to-fold"}`，于是 `due:false`；
 * 而那个会话有 163 节点 / 尾巴 1205 事件、foldMarks 为 0 ⇒ **尝试过一次就永远不会再补**。
 */
import { closeoutSettles, debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const tests = {};

tests["C476 只有结局能结清账：folded>0 或「确实没内容」"] = (t) => {
  t.eq(closeoutSettles({ folded: 1 }), true, "折成了 ⇒ 结清");
  t.eq(closeoutSettles({ folded: 0, chunkedFolded: 2 }), true, "分段折成 ⇒ 结清");
  t.eq(closeoutSettles({ folded: 0, foldNote: "nothing-to-fold:below-min-tokens" }), true, "低于最小阈值 = 真没内容");
  t.eq(closeoutSettles(null), false, "没有 closeout ⇒ 没结清");
};

tests["C476 失败/未知原因不许结清（否则这笔账永远补不上）"] = (t) => {
  t.eq(closeoutSettles({ folded: 0, foldError: "400 upstream" }), false, "失败 ⇒ 未结清");
  t.eq(closeoutSettles({ folded: 0, foldNote: "nothing-to-fold:timeout" }), false, "超时不是'没内容'");
  t.eq(closeoutSettles({ folded: 0, foldNote: "nothing-to-fold:planner-null" }), false, "算不出区间也不是'没内容'");
  t.eq(closeoutSettles({ folded: 0, foldNote: "nothing-to-fold" }), false, "老记录给不出原因 ⇒ 保守当未结清（宁可多补一次）");
  t.eq(closeoutSettles({ folded: 0, foldAttempted: true }), false, "试过但结局不清 ⇒ 未结清");
};

tests["C476 老 closeout（C466 之前写的）保持原语义 —— 不然会把历史欠账一次性翻出来"] = (t) => {
  t.eq(closeoutSettles({ at: 1, eventsSinceLastFold: 100, folds: 0, source: "disposed" }), true, "老记录仍算结清");
};

tests["C476 debtOfGraph 真的会因此重新算账（真机会话的形状）"] = (t) => {
  const graph = {
    nodes: { n1: { seq: 10 }, n2: { seq: 1205 } },
    foldMarks: [],
    closeout: { source: "archive", foldAttempted: true, folded: 0, foldNote: "nothing-to-fold:planner-null" },
  };
  const r = debtOfGraph(graph);
  t.eq(r.folded, false, "没有 archive/backfill 折叠记录");
  t.eq(r.closedOut, false, "这次尝试不算结清");
  t.eq(r.due, true, "于是它重新出现在欠账里 —— 重开该会话时还能补");
  // ★ C569：**"说折了"不算数，要有折叠记录**。旧版本这里只改 folded 字段就当折完了 ——
  //   而真机有 74 个会话正是这个形状（closeout.folded>0 / foldMarks=0），于是永远不进欠账。
  const claimOnly = debtOfGraph({ ...graph, closeout: { ...graph.closeout, folded: 1 } });
  t.eq(claimOnly.due, true, "只写 folded:1、没有 mark ⇒ 仍然欠着（假成功不许当结清）");
  t.eq(claimOnly.closedOut, false, "没证据就不算结清");

  // 真折过一次（有 mark）之后才不再欠
  const done = debtOfGraph({
    ...graph,
    foldMarks: [{ trigger: "archive", seqStart: 1, seqEnd: 1205, at: 1 }],
    closeout: { ...graph.closeout, folded: 1 },
  });
  t.eq(done.due, false, "有 archive mark ⇒ 折完了，不再欠");
};

tests["C477 引擎补账与账本必须共用同一条判据（同一个坑不能在两处各挖一个）"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine.mjs"), "utf8");
  t.eq(src.includes("closeoutSettles"), true, "引擎必须导入并使用 closeoutSettles");
  // 旧判据「有 closeout 就跳过」不许再出现（那正是 C476/C477 的病根）
  const bad = /if \(g\.closeout !== undefined\) return;/;
  t.eq(bad.test(src), false, "「有 closeout 就跳过补账」的旧判据必须删掉");
};

tests["C478 补账计划要区分「从没试过」与「试过没成」（处置顺序不同）"] = async (t) => {
  const m = await import("../scripts/backfill-plan.mjs");
  const fresh = m.debtAttemptState({ nodes: {}, foldMarks: [] });
  t.eq(fresh.retried, false, "没有 closeout ⇒ 从没试过");
  t.eq(fresh.note, null, "没有原因");
  const failed = m.debtAttemptState({ closeout: { foldAttempted: true, folded: 0, foldNote: "nothing-to-fold:planner-null" } });
  t.eq(failed.retried, true, "试过没成 ⇒ 标出来");
  t.includes(failed.note ?? "", "planner-null", "原因要带出来（用户才知道先查什么）");
  const errored = m.debtAttemptState({ closeout: { folded: 0, foldError: "400: upstream rejected" } });
  t.eq(errored.retried, true, "失败也要标");
  t.includes(errored.note ?? "", "400", "错误摘要带出来");
  const done = m.debtAttemptState({ closeout: { folded: 2 } });
  t.eq(done.retried, false, "真折成了 ⇒ 不算'试过没成'");
};

tests["C493 只压了一部分不算结清（partial），否则没压的那段永远消失"] = (t) => {
  t.eq(closeoutSettles({ folded: 1, partial: true }), false, "partial ⇒ 未结清");
  t.eq(closeoutSettles({ folded: 1, partial: false }), true, "明确非 partial ⇒ 结清");
  const r = debtOfGraph({
    nodes: { n1: { seq: 1 }, n2: { seq: 9000 } },
    foldMarks: [{ seqEnd: 5000, trigger: "archive-offline" }],
    closeout: { folded: 1, partial: true, offlineUncoveredTail: { start: 5001, end: 9000, events: 4000 } },
  });
  t.eq(r.due, true, "还有 4000 事件没压 ⇒ 仍然 due");
  t.eq(r.tail, 4000, "尾巴就是没压的那段");
};

tests["C569 分段折过的会话（chunkedFolded>0、无 mark）不许被算成欠账"] = (t) => {
  // 分段折叠走 compactRegion，**不写 foldMark**（C299），只记 closeout.chunkedFolded。
  // 所以「结清要看证据」的证据里必须包含它，否则所有分段折完的会话都会被重新拉进欠账。
  const g = {
    nodes: { n1: { seq: 10 }, n2: { seq: 9000 } },
    foldMarks: [],
    closeout: { source: "archive", foldAttempted: true, folded: 2, chunkedFolded: 2 },
  };
  const r = debtOfGraph(g);
  t.eq(r.closedOut, true, "分段折过 ⇒ 结清");
  t.eq(r.due, false, "不许再欠（否则会无限重复补账）");
};
