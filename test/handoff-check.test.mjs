/**
 * handoff-check.test.mjs —— 交接门禁里「保真度 / 幻觉探针」两项的回归（2026-11-01）
 *
 * 背景：`scripts/handoff-check.mjs` 原来只查重注入契约的 ①–⑨；`fold-quality` 落地后
 * `foldMarks[i].quality` 已经是 live 数据的一部分，门禁必须一起看 —— 否则「压缩产物交接合格」
 * 可能掩盖「约束/失败边丢了」。本文件用合成图直接调 `checkGraph()`（纯函数，不依赖 live home）。
 *
 * 只断言 ⑩/⑪ 两项，其余检查（①–⑨）由各自的单测覆盖，避免夹具噪声。
 */

import { checkGraph } from "../scripts/handoff-check.mjs";

export const tests = {};

const now = Date.now();

/** 最小棋谱：user 根 + agent 当前节点 + 一条失败边（让 renderLedger 有东西可渲染）。 */
function mkGraph({ foldMarks = [] } = {}) {
  const nodes = {
    n1: { id: "n1", kind: "user", seq: 1, text: "把测试跑绿", ts: now - 5000 },
    n2: { id: "n2", kind: "agent", seq: 2, goal: "跑测试", ts: now - 1000 },
  };
  const g = {
    version: 1,
    sessionId: "s-handoff",
    cwd: "E:/x",
    order: ["n1", "n2"],
    nodes,
    edges: {
      e1: {
        id: "e1",
        from: "n1",
        to: "n2",
        intent: "npm test",
        action: "bash(command=npm test)",
        result: "failure",
        errorSnippet: "ERR_EACCES: permission denied",
        evidence: { start: 10, end: 12 },
        verify: { kind: "exit", summary: "exit 1" },
        ts: now - 1000,
      },
    },
    nextNode: 3,
    nextEdge: 2,
    rootUserNodeIds: ["n1"],
    foldMarks,
  };
  return g;
}

/** 一条质量样本（默认全部健康）。 */
function quality(over = {}) {
  return {
    constraintRecall: 1,
    failureRecall: 1,
    compressionRatio: 12,
    expectedConstraints: 2,
    expectedFailures: 1,
    missingConstraints: [],
    missingFailures: [],
    unknownIds: [],
    summaryTokens: 300,
    shadowedTokens: 3600,
    ...over,
  };
}

const byName = (result, prefix) => result.checks.find((c) => c.name.startsWith(prefix));

tests["H-11 空图 ⇒ ①根目标不适用（ok），不许当成「缺 rootUserNodeIds」告警"] = (t) => {
  const empty = {
    version: 1,
    sessionId: "s-empty",
    cwd: "E:/x",
    order: [],
    nodes: {},
    edges: {},
    nextNode: 1,
    nextEdge: 1,
    rootUserNodeIds: [],
    foldMarks: [],
  };
  const r1 = checkGraph(empty, {});
  const root1 = r1.checks.find((c) => c.name.includes("①根目标"));
  t.eq(root1.level, "ok", `空图应是 ok，实际 ${root1.level}：${root1.detail}`);
  t.includes(root1.detail, "空图", "detail 要说清是空图（不是缺 rootUserNodeIds）");

  const noRoot = mkGraph();
  noRoot.rootUserNodeIds = [];
  const r2 = checkGraph(noRoot, {});
  const root2 = r2.checks.find((c) => c.name.includes("①根目标"));
  t.eq(root2.level, "warn", "有节点但没有 rootUserNodeIds ⇒ 仍是 warn");
  t.includes(root2.detail, "rootUserNodeIds", "detail 要指出缺字段");
};

tests["H-1 有健康质量样本 ⇒ ⑩保真度 ok、⑪幻觉探针 ok"] = (t) => {
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: quality() }] }), {});
  t.eq(byName(result, "⑩").level, "ok", "召回全 1 应为 ok");
  t.includes(byName(result, "⑩").detail, "constraintRecall=1", "要显示约束召回");
  t.includes(byName(result, "⑩").detail, "failureRecall=1", "要显示失败边召回");
  t.eq(byName(result, "⑪").level, "ok", "没有未知 id 应为 ok");
};

tests["H-2 constraintRecall < 1 ⇒ 必须 fail，并点名丢失的约束"] = (t) => {
  const q = quality({ constraintRecall: 0.5, missingConstraints: ["不要动 prod 配置"] });
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {});
  t.eq(byName(result, "⑩").level, "fail", "丢约束是任务级事故，必须 fail");
  t.includes(byName(result, "⑩").detail, "prod", "必须点名丢失的那条约束");
};

tests["H-3 failureRecall < 1 ⇒ warn（丢失败边 = 下一个模型重踩）"] = (t) => {
  const q = quality({ failureRecall: 0.5, missingFailures: ["e12"] });
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {});
  t.eq(byName(result, "⑩").level, "warn", "丢失败边先 warn");
  t.includes(byName(result, "⑩").detail, "e12", "必须点名丢失的失败边");
};

tests["H-4 真空样本（期望全 0）⇒ warn，不许当成『全保住了』"] = (t) => {
  const q = quality({ expectedConstraints: 0, expectedFailures: 0 });
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {});
  t.eq(byName(result, "⑩").level, "warn", "真空样本必须是 warn（不是 ok）");
  t.includes(byName(result, "⑩").detail, "真空", "必须写明真空样本");
};

tests["H-5 摘要提到图里没有的 eN ⇒ ⑪幻觉探针 warn 并点名"] = (t) => {
  const q = quality({ unknownIds: ["e99", "n77"] });
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {});
  const probe = byName(result, "⑪");
  t.eq(probe.level, "warn", "未知 id 必须 warn");
  t.includes(probe.detail, "e99", "必须点名编造的 e99");
  t.includes(probe.detail, "n77", "必须点名编造的 n77");
};

tests["H-6 没有 fold 记录 ⇒ ⑩/⑪ 都 ok（不许给没 fold 过的会话加噪声）"] = (t) => {
  const result = checkGraph(mkGraph({ foldMarks: [] }), {});
  t.eq(byName(result, "⑩").level, "ok", "没有 fold 就没有压缩产物可评");
  t.includes(byName(result, "⑩").detail, "没有 fold", "要说清为什么是 ok");
  t.eq(byName(result, "⑪").level, "ok", "没有样本时探针不告警");
};

tests["H-8 触发原因 pressure ⇒ ⑫ ok 并显示分布"] = (t) => {
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, trigger: "pressure", quality: quality() }] }), {});
  const trigger = byName(result, "⑫");
  t.eq(trigger.level, "ok", "只有 pressure 应为 ok");
  t.includes(trigger.detail, "pressure=1", "必须显示触发原因分布");
  t.notIncludes(trigger.detail, "被迫自救", "没有 overflow 时不许吓人");
};

tests["H-9 出现 context-overflow ⇒ ⑫ warn（压缩没跟上增长，已被迫自救）"] = (t) => {
  const result = checkGraph(
    mkGraph({
      foldMarks: [
        { at: now, foldCount: 1, trigger: "pressure", quality: quality() },
        { at: now + 1, foldCount: 2, trigger: "context-overflow", quality: quality() },
      ],
    }),
    {},
  );
  const trigger = byName(result, "⑫");
  t.eq(trigger.level, "warn", "overflow 必须 warn");
  t.includes(trigger.detail, "被迫自救", "必须说明 overflow 的含义");
  t.includes(trigger.detail, "context-overflow=1", "分布里要看到 overflow 计数");
};

tests["H-10 有 fold 但缺 trigger ⇒ ⑫ warn『未采集』；没有 fold ⇒ ok"] = (t) => {
  const legacy = byName(checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1 }] }), {}), "⑫");
  t.eq(legacy.level, "warn", "旧版本折叠缺 trigger 要 warn");
  t.includes(legacy.detail, "都没有 trigger", "必须写清是旧版本折叠");
  const empty = byName(checkGraph(mkGraph({ foldMarks: [] }), {}), "⑫");
  t.eq(empty.level, "ok", "没有 fold 的会话不该被 ⑫ 告警");
};

tests["H-7 有 fold 但缺 quality ⇒ ⑩ warn『未采集』（旧版本折叠）"] = (t) => {
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, seqStart: 1, seqEnd: 9 }] }), {});
  const fidelity = byName(result, "⑩");
  t.eq(fidelity.level, "warn", "旧版本折叠缺 quality 要 warn");
  t.includes(fidelity.detail, "都没有 quality", "必须说明是旧版本折叠");
};
