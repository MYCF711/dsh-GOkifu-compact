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
  // 真折过一次之后就不再欠
  const done = debtOfGraph({ ...graph, closeout: { ...graph.closeout, folded: 1 } });
  t.eq(done.due, false, "折完之后不再欠");
};

tests["C477 引擎补账与账本必须共用同一条判据（同一个坑不能在两处各挖一个）"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine.mjs"), "utf8");
  t.eq(src.includes("closeoutSettles"), true, "引擎必须导入并使用 closeoutSettles");
  // 旧判据「有 closeout 就跳过」不许再出现（那正是 C476/C477 的病根）
  const bad = /if \(g\.closeout !== undefined\) return;/;
  t.eq(bad.test(src), false, "「有 closeout 就跳过补账」的旧判据必须删掉");
};
