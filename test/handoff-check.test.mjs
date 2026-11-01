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

tests["H-12 只有 WORKING 行（当前路径===工作路径）也算「当前位置」—— 不许误报 FAIL"] = async (t) => {
  const { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge } = await import("./graph-fixtures.mjs");
  const g = createGraph({ sessionId: "s-working-only" });
  const u = addUserNodeId(g, { seq: 9, text: "把设置改回侧边栏" });
  const e1 = addEdge(g, { from: u, intent: "看设置", action: "bash(grep)", evidence: { start: 10, end: 11 } });
  const n2 = addAgentNode(g, { seq: 12, goal: "", worldHash: "W1", constraintHash: "C1", via: e1 });
  settleEdge(g, e1, { to: n2.id, result: "unverified", verify: { kind: "no-exit", summary: "no exit" }, weak: "shell" });
  const e2 = addEdge(g, { from: n2.id, intent: "再试", action: "bash(curl)", evidence: { start: 13, end: 14 } });
  const n3 = addAgentNode(g, { seq: 15, goal: "", worldHash: "W2", constraintHash: "C1", via: e2 });
  settleEdge(g, e2, { to: n3.id, result: "unverified", verify: { kind: "no-exit", summary: "no exit" }, weak: "shell" });
  const result = checkGraph(g, {});
  const path = result.checks.find((c) => c.name.includes("⑥当前位置"));
  t.eq(path.level, "ok", `只有 WORKING 行时必须判 ok（实际 ${path.level}：${path.detail}）`);
};

tests["H-13 ⑬fold边界：openAtEnd>0 ⇒ fail；=0 ⇒ ok；旧 fold 无 boundary ⇒ 未采集(ok)"] = (t) => {
  const withMark = (boundary) =>
    mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: quality(), ...(boundary === undefined ? {} : { boundary }) }] });
  const bad = checkGraph(withMark({ overlapping: 5, openAtEnd: 1, unsettled: 0 }), {}).checks.find((c) => c.name.includes("⑬"));
  t.eq(bad.level, "fail", `切在调用中间必须 fail，实际 ${bad.level}`);
  const good = checkGraph(withMark({ overlapping: 5, openAtEnd: 0, unsettled: 1 }), {}).checks.find((c) => c.name.includes("⑬"));
  t.eq(good.level, "ok", `openAtEnd=0 必须 ok，实际 ${good.level}`);
  const legacy = checkGraph(withMark(undefined), {}).checks.find((c) => c.name.includes("⑬"));
  t.eq(legacy.level, "ok", "旧 fold 没有 boundary ⇒ 未采集（不失败）");
};

tests["H-14 ①根目标：agent-only 会话不适用（ok）；有 user 节点却漏记 root 才是缺陷（warn）"] = (t) => {
  const agentOnly = mkGraph();
  agentOnly.nodes = { n2: agentOnly.nodes.n2 };
  agentOnly.order = ["n2"];
  agentOnly.rootUserNodeIds = [];
  const r1 = checkGraph(agentOnly, {}).checks.find((c) => c.name.includes("①"));
  t.eq(r1.level, "ok", `agent-only 会话必须 ok，实际 ${r1.level}：${r1.detail}`);
  t.includes(r1.detail, "agent-only", "detail 要说明是 agent-only");

  const missingRoot = mkGraph();
  missingRoot.rootUserNodeIds = [];
  const r2 = checkGraph(missingRoot, {}).checks.find((c) => c.name.includes("①"));
  t.eq(r2.level, "warn", "有 user 节点但漏记 root ⇒ warn");
  t.includes(r2.detail, "漏记", "detail 要点名是 keeper 漏记");
};

tests["H-15 真空样本（区间无约束/失败边）⇒ ⑩ ok（不算缺陷），但 detail 必须说清是真空"] = (t) => {
  const q = { constraintRecall: 1, failureRecall: 1, expectedConstraints: 0, expectedFailures: 0, compressionRatio: 10, unknownIds: [], summaryTokens: 100 };
  const r = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {}).checks.find((c) => c.name.includes("⑩"));
  t.eq(r.level, "ok", `真空样本必须 ok，实际 ${r.level}：${r.detail}`);
  t.includes(r.detail, "真空样本", "detail 要标明真空");
};

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

tests["H-4 真空样本（期望全 0）⇒ ok 但必须标明真空（C38：逐会话不再告警，全体真空由 doctor 兜）"] = (t) => {
  const q = quality({ expectedConstraints: 0, expectedFailures: 0 });
  const result = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {});
  t.eq(byName(result, "⑩").level, "ok", "真空样本不再是逐会话 warn（C38）");
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

tests["H-11 预算检查必须用 ledger.budgetMax 做分母（不是 CLI 默认 500）"] = (t) => {
  const g = mkGraph();
  g.rootUserNodeIds = ["n1"];
  const result = checkGraph(g, { maxTokens: 800 });
  const row = result.checks.find((c) => c.name.includes("⑨"));
  t.eq(!!row, true, "必须有 ⑨ 预算检查项");
  t.eq(String(row.detail).includes("/800"), true, `分母应为 800：${row.detail}`);
  t.eq(String(row.detail).includes("/500"), false, `不许出现默认 500 分母：${row.detail}`);
};

tests["H-12 ⑭fold成本：遮蔽占读入 < 30% ⇒ warn；≥ 30% ⇒ ok；无 usage ⇒ 未采集 ok"] = (t) => {
  const thin = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, shadowedTokens: 1000, usage: { inputTokens: 10000 } }] }), {});
  t.eq(byName(thin, "⑭").level, "warn", "遮蔽只占 10% ⇒ 折太碎 warn");
  t.includes(byName(thin, "⑭").detail, "折太碎", "文案要点明折太碎");

  const healthy = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, shadowedTokens: 3000, usage: { inputTokens: 10000 } }] }), {});
  t.eq(byName(healthy, "⑭").level, "ok", "遮蔽占 30% 以上 ⇒ ok");

  const legacy = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1 }] }), {});
  t.eq(byName(legacy, "⑭").level, "ok", "旧 fold 没 usage ⇒ 不许 fail");
  t.includes(byName(legacy, "⑭").detail, "未采集", "要写「未采集」");

  const none = checkGraph(mkGraph({ foldMarks: [] }), {});
  t.eq(byName(none, "⑭").level, "ok", "没有 fold ⇒ ok");
  t.includes(byName(none, "⑭").detail, "没有 fold", "文案说明没有 fold");
};

tests["H-13 ⑭fold成本按最差一次判：多次 fold 里只要有一次 <30% 就 warn"] = (t) => {
  const mixed = checkGraph(
    mkGraph({
      foldMarks: [
        { at: now, foldCount: 1, shadowedTokens: 5000, usage: { inputTokens: 10000 } },
        { at: now, foldCount: 2, shadowedTokens: 500, usage: { inputTokens: 10000 } },
      ],
    }),
    {},
  );
  t.eq(byName(mixed, "⑭").level, "warn", "最差一次 5% ⇒ warn（不能被另一次健康样本掩盖）");
};

tests["H-14 ⑮fold悬空：fromBroken>0 ⇒ fail；liveUnsettled>0 ⇒ warn；全 0 ⇒ ok；无字段 ⇒ 未采集"] = (t) => {
  const broken = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, dangling: { liveUnsettled: 0, fromBroken: 2, residue: 0, candidates: 0 } }] }), {});
  t.eq(byName(broken, "⑮").level, "fail", "指向不存在节点 ⇒ fail（图坏了）");
  t.includes(byName(broken, "⑮").detail, "图损坏", "文案要点明数据问题");

  const live = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, dangling: { liveUnsettled: 3, fromBroken: 0, residue: 0, candidates: 0 } }] }), {});
  t.eq(byName(live, "⑮").level, "warn", "未结算边 ⇒ warn");
  t.includes(byName(live, "⑮").detail, "未结算", "文案说明未结算");

  const clean = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, dangling: { liveUnsettled: 0, fromBroken: 0, residue: 1, candidates: 0 } }] }), {});
  t.eq(byName(clean, "⑮").level, "ok", "全 0 ⇒ ok（residue 是正常分类，不判错）");

  const legacy = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1 }] }), {});
  t.eq(byName(legacy, "⑮").level, "ok", "旧 fold 无 dangling ⇒ 不许 fail");
  t.includes(byName(legacy, "⑮").detail, "未采集", "要写未采集");
};

tests["H-15 ⑯闭包自洽：seqStart>seqEnd 或 nodes>graphNodes ⇒ fail；一致 ⇒ ok（preGraph 会标注）"] = (t) => {
  const reversed = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, seqStart: 900, seqEnd: 100, closure: { nodes: 5, edges: 5, graphNodes: 100, preGraph: false } }] }), {});
  t.eq(byName(reversed, "⑯").level, "fail", "区间反了必须 fail");

  const tooMany = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, seqStart: 10, seqEnd: 20, closure: { nodes: 999, edges: 5, graphNodes: 10, preGraph: false } }] }), {});
  t.eq(byName(tooMany, "⑯").level, "fail", "nodes 超过图节点数必须 fail");

  const okMark = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, seqStart: 10, seqEnd: 20, closure: { nodes: 5, edges: 6, graphNodes: 50, preGraph: true } }] }), {});
  t.eq(byName(okMark, "⑯").level, "ok", "自洽 ⇒ ok");
  t.includes(byName(okMark, "⑯").detail, "早于本图", "preGraph 要在文案里标注");

  const legacy = checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1 }] }), {});
  t.eq(byName(legacy, "⑯").level, "ok", "旧 fold 无 closure ⇒ 不许 fail");
};
