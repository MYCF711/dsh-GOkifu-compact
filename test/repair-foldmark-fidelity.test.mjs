import { findFidelityMarks, repairGraphFidelity } from "../scripts/repair-foldmark-fidelity.mjs";

export const tests = {};

const CONSTRAINT = "只改本worktree，逐文件追加commit并push同一PR分支，禁止force/rebase/amend。";

function graph({ summaryText = "", lastOfflineSummary = null, missing = [CONSTRAINT], recall = 0 } = {}) {
  return {
    version: 1,
    sessionId: "fixture",
    order: ["n1"],
    nodes: { n1: { id: "n1", kind: "user", seq: 1, constraints: [CONSTRAINT] } },
    edges: {},
    foldMarks: [
      {
        at: 1,
        seqStart: 10,
        seqEnd: 20,
        trigger: "archive-offline",
        ...(summaryText === "" ? {} : { summaryText }),
        quality: {
          constraintRecall: recall,
          failureRecall: 1,
          expectedConstraints: 1,
          expectedFailures: 0,
          missingConstraints: missing,
          shadowedTokens: 100,
        },
      },
    ],
    lastOfflineSummary,
  };
}

tests["T97 缺约束：机械补回并更新 quality；原图不被修改"] = (t) => {
  const source = graph({ summaryText: "## 目标\n做一件事" });
  const before = JSON.stringify(source);
  t.eq(findFidelityMarks(source).length, 1, "能找到待修 mark");
  const result = repairGraphFidelity(source);
  t.eq(result.repaired.length, 1, "修了一条");
  t.eq(result.repaired[0].count, 1, "补回一条约束");
  t.includes(result.graph.foldMarks[0].summaryText, CONSTRAINT, "摘要包含逐字约束");
  t.eq(result.graph.foldMarks[0].quality.constraintRecall, 1, "constraintRecall 回到 1");
  t.eq(result.graph.foldMarks[0].quality.missingConstraints.length, 0, "missing 清空");
  t.eq(JSON.stringify(source), before, "纯函数不修改输入");
};

tests["T97 幂等：已补过的摘要再跑不追加第二行"] = (t) => {
  const once = repairGraphFidelity(graph({ summaryText: "## 目标\n做一件事" })).graph;
  const twice = repairGraphFidelity(once);
  t.eq(twice.repaired.length, 0, "第二次没有内容修复");
  t.eq(twice.skipped.length, 0, "第二次也不该有 skipped");
  const bullets = (twice.graph.foldMarks[0].summaryText.match(new RegExp(CONSTRAINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  t.eq(bullets, 1, "约束只出现一次");
};

tests["T97 摘要来源：mark.summaryText 缺失时用 lastOfflineSummary；都没有则跳过"] = (t) => {
  const last = graph({
    lastOfflineSummary: { at: 1, range: { start: 10, end: 20 }, text: "## 目标\n旧摘要" },
  });
  const r1 = repairGraphFidelity(last);
  t.includes(r1.graph.lastOfflineSummary.text, CONSTRAINT, "补回 lastOfflineSummary.text");
  t.eq(r1.graph.foldMarks[0].quality.constraintRecall, 1, "质量已修");
  const noSummary = graph({});
  const r2 = repairGraphFidelity(noSummary);
  t.eq(r2.repaired.length, 0, "没有摘要不修");
  t.eq(r2.skipped[0].reason, "NO_SUMMARY_TEXT", "明确记录原因");
};

tests["T97 指标旧但文本已完整：只修 metric，不追加内容"] = (t) => {
  const g = graph({ summaryText: `## 目标\n做一件事\n- ${CONSTRAINT}`, missing: [CONSTRAINT], recall: 0 });
  const r = repairGraphFidelity(g);
  t.eq(r.repaired[0].kind, "METRIC_ONLY", "只修指标");
  t.eq(r.repaired[0].count, 0, "没有追加");
  t.eq(r.graph.foldMarks[0].quality.constraintRecall, 1, "指标已修");
};
