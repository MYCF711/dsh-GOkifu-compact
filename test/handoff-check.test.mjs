/**
 * handoff-check.test.mjs —— 交接门禁里「保真度 / 幻觉探针」两项的回归（2026-11-01）
 *
 * 背景：`scripts/handoff-check.mjs` 原来只查重注入契约的 ①–⑨；`fold-quality` 落地后
 * `foldMarks[i].quality` 已经是 live 数据的一部分，门禁必须一起看 —— 否则「压缩产物交接合格」
 * 可能掩盖「约束/失败边丢了」。本文件用合成图直接调 `checkGraph()`（纯函数，不依赖 live home）。
 *
 * 只断言 ⑩/⑪ 两项，其余检查（①–⑨）由各自的单测覆盖，避免夹具噪声。
 */

import { checkGraph, omissionLines, parseOmissions } from "../scripts/handoff-check.mjs";
import { renderLedger, renderMinimalLedger, renderFacts } from "../src/rooms/ledger.mjs";

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

tests["C654 只有一条陈旧 result=failure/to=null：残留计数行与 ③ 都必须可见"] = (t) => {
  const injectedNow = Date.now();
  const graph = mkGraph();
  graph.sessionId = "s-c654-residue-only";
  graph.edges.e1.to = null;
  graph.edges.e1.ts = injectedNow - 60 * 60 * 1000;

  const ledger = renderLedger(graph, { now: injectedNow });
  t.includes(ledger.text, "# 另有 1 条无终点残留（rewash 历史，未展开；全文 graph.json）", "只有残留时也必须输出既有计数行与 graph 指针");
  t.notIncludes(ledger.text, "LEARNED", "residue 不许塞进 LEARNED");

  const result = checkGraph(graph, { now: injectedNow });
  const row = byName(result, "③");
  t.eq(row.level, "ok", `只有 residue 时 ③ 应验收计数行：${row.detail}`);
  t.includes(row.detail, "residue", "③ detail 必须明确区分 residue");
  t.includes(row.detail, "1 条", "③ detail 必须给出残留条数");
};

tests["C654 对照：普通非残留失败仍必须进入 LEARNED 并通过 ③"] = (t) => {
  const result = checkGraph(mkGraph(), { now });
  t.includes(result.ledger.text, "LEARNED (1 failed attempts):", "普通失败边必须保留 LEARNED");
  t.notIncludes(result.ledger.text, "无终点残留", "普通失败边不该被误分为 residue");
  const row = byName(result, "③");
  t.eq(row.level, "ok", `普通失败边有 LEARNED 时 ③ 应为 ok：${row.detail}`);
};

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

tests["T97 活跃会话：openAtEnd>0 降级为 warn，不阻断交接；非活跃仍 fail"] = (t) => {
  const withMark = () =>
    mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: quality(), boundary: { overlapping: 5, openAtEnd: 1, unsettled: 0 } }] });
  const active = checkGraph(withMark(), { activeSession: true }).checks.find((c) => c.name.includes("⑬"));
  t.eq(active.level, "warn", `活跃会话应 warn，实际 ${active.level}`);
  t.includes(active.detail, "活动窗口", "必须说明为什么降级");
  const inactive = checkGraph(withMark(), { activeSession: false }).checks.find((c) => c.name.includes("⑬"));
  t.eq(inactive.level, "fail", "非活跃会话仍必须 fail");
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

tests["H-13 ⑭fold成本判级用中位数（C553）：即便有一次 <30%，中位健康就不该红"] = (t) => {
  const mixed = checkGraph(
    mkGraph({
      foldMarks: [
        { at: now, foldCount: 1, shadowedTokens: 5000, usage: { inputTokens: 10000 } },
        { at: now, foldCount: 2, shadowedTokens: 500, usage: { inputTokens: 10000 } },
      ],
    }),
    {},
  );
  // ★ C553：两次样本（50% / 5%）中位 = 27.5% ⇒ 仍 <30% ⇒ warn。
  //   但**语义变了**：判的是"中位"，不是"最差的一次"。
  t.eq(byName(mixed, "⑭").level, "warn", "中位 27.5% < 30% ⇒ warn");
  t.includes(byName(mixed, "⑭").detail, "判级用中位数", "文案要说明判级口径");
  t.includes(byName(mixed, "⑭").detail, "1/2 次不足 30%", "要报出几次不足（比例信息）");

  // 一次极差 + 多次健康 ⇒ 中位健康 ⇒ 不该红（这正是 C553 修的东西）
  const mostlyHealthy = checkGraph(
    mkGraph({
      foldMarks: [
        { at: now, foldCount: 1, shadowedTokens: 8000, usage: { inputTokens: 10000 } },
        { at: now, foldCount: 2, shadowedTokens: 7000, usage: { inputTokens: 10000 } },
        { at: now, foldCount: 3, shadowedTokens: 6000, usage: { inputTokens: 10000 } },
        { at: now, foldCount: 4, shadowedTokens: 500, usage: { inputTokens: 10000 } },
      ],
    }),
    {},
  );
  t.eq(byName(mostlyHealthy, "⑭").level, "ok", "3 次健康 + 1 次极差 ⇒ 中位 65% ⇒ ok（一个离群样本不该判红）");
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

tests["H-16 ⑪幻觉探针：『图里有但不在本次折叠区间』也要 warn 并点名（C104 / C280）"] = (t) => {
  // ★ C280：只把「引用**更晚**」算问题（与 doctor 同口径）；「引用更早」是回溯 kifu，合法。
  const q = quality({ unknownIds: [], outOfRangeIds: ["e42"], outOfRangeEarlier: [], outOfRangeLater: ["e42"] });
  const row = byName(checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: q }] }), {}), "⑪");
  t.eq(row.level, "warn", "引用更晚的实体必须 warn");
  t.includes(row.detail, "更晚", "文案要指名方向（更晚 = 折叠时还不存在）");
  t.includes(row.detail, "e42", "要点名越界 id");

  // 只有「更早」的引用 ⇒ 不算问题，但要说一句（不静默）
  const earlierOnly = byName(
    checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: quality({ unknownIds: [], outOfRangeIds: ["n7"], outOfRangeEarlier: ["n7"], outOfRangeLater: [] }) }] }), {}),
    "⑪",
  );
  t.eq(earlierOnly.level, "ok", "只有更早的引用不该 warn");
  t.includes(earlierOnly.detail, "更早", "要在 ok 文案里说明有回溯引用");

  const clean = byName(
    checkGraph(mkGraph({ foldMarks: [{ at: now, foldCount: 1, quality: quality({ unknownIds: [], outOfRangeIds: [], outOfRangeEarlier: [], outOfRangeLater: [] }) }] }), {}),
    "⑪",
  );
  t.eq(clean.level, "ok", "没有越界引用应 ok");
};

tests["H-17 ⑯闭包自洽必须用**当时**的 graphNodes，不能被之后的合并缩图误伤（C106）"] = (t) => {
  const mk = (nodes, graphNodes) => ({
    at: now,
    foldCount: 1,
    seqStart: 10,
    seqEnd: 20,
    closure: { nodes, edges: 5, firstNode: "n1", lastNode: "n2", firstEdge: "e1", lastEdge: "e5", graphNodes },
  });
  // 折叠时图有 50 / 40 个节点；之后合并把当前图缩到很少（mkGraph 默认更小）—— 不许因此判 fail
  const graph = mkGraph({ foldMarks: [mk(50, 50), mk(40, 40)] });
  const row = byName(checkGraph(graph, {}), "⑯");
  t.eq(row.level, "ok", `历史上自洽的闭包不许被后来的缩图误判：${row.detail}`);

  // 真坏数据：nodes(60) > 当时的 graphNodes(50) ⇒ 必须 fail
  const broken = mkGraph({ foldMarks: [mk(60, 50)] });
  t.eq(byName(checkGraph(broken, {}), "⑯").level, "fail", "nodes 超过当时图节点数必须 fail");
};

tests["C656 ⑧省略行：CONSTRAINTS_OMITTED 必须被认出来（旧清单漏这一类 ⇒ 省略行从不被校验）"] = (t) => {
  const good = "CONSTRAINTS_OMITTED: 8 of 40 not listed (section over 8000 chars) — full text: graph.json nodes[*].constraints";
  const bad = "CONSTRAINTS_OMITTED: 8 of 40 not listed (section over 8000 chars)";
  t.eq(omissionLines(good).length, 1, "带指针的省略行必须被认出 —— ⑧ 才看得见它");
  t.eq(omissionLines(bad).length, 1, "反例前提：连丢了指针的那一行也要被认出，否则 ⑧ 无从判红");
  // 反例：旧清单的三种关键词都匹配不到这一行 ⇒ 这条守卫不是同义反复（C656 前 ⑧ 对约束省略是盲的）
  const OLD = /omitted for budget|FAILED_ATTEMPTS_OMITTED|DANGLING_RESIDUE/;
  t.eq(OLD.test(good), false, "旧正则确实漏了 CONSTRAINTS_OMITTED");
  t.eq(omissionLines("LEARNED (3 failed attempts):").length, 0, "不是省略行就不许误报");
};

tests["C656 ⑧端到端：约束病态超限的省略行带 graph.json 指针 ⇒ ⑧ ok（且确实产生了这一行）"] = (t) => {
  const g = mkGraph();
  // 40 × ~250 字符 ⇒ 越过 8,000 字符病态阀，主清单必然产生 CONSTRAINTS_OMITTED
  g.nodes.n1.constraints = Array.from({ length: 40 }, (_, i) => `约束 ${i + 1}：${"不许动 prod 配置，".repeat(20)}`);
  const led = renderLedger(g);
  t.includes(led.text, "CONSTRAINTS_OMITTED: ", "前置：病态超限必须产生省略行");
  const row = byName(checkGraph(g, {}), "⑧");
  t.eq(row.level, "ok", `⑧ 必须 ok（实际 ${row.level}：${row.detail}）`);
  t.includes(row.detail, "行省略", "⑧ 的 detail 必须报出它看到了省略行（不能是「本档没有省略行」）");
};

/* ───────────── C656 ⑧ 省略行：值事实三类 + 残留计数行（allowlist 漏检的补完） ───────────── */

/** 3 条合法值事实（`normalizeValueFact` 的六字段口径）—— 上限给 1 时必有 2 条被省略。 */
const VALUE_FACTS_3 = [0, 1, 2].map((i) => ({ kind: "value", value: `值${i}`, quote: `值${i}`, evidenceSeq: 10 + i, validAtSeq: 10 + i, source: "tool:bash" }));

/** mkGraph 的变体：把值事实挂在已有的边上；`failure:false` ⇒ 零失败边 ⇒ 走最小清单那条生产分支。 */
function mkFactGraph({ failure = true, facts = VALUE_FACTS_3 } = {}) {
  const g = mkGraph();
  if (!failure) g.edges.e1.result = "success";
  g.edges.e1.valueFacts = facts.map((f) => ({ ...f }));
  return g;
}

tests["C656 ⑧省略行结构判据：值事实 3 类 + 残留计数行全部被认出（旧 allowlist 漏这 4 类）"] = (t) => {
  // 相对 treeDir：既让 relTree 分支生效（指针变 `sessions/abc/graph.json`），又不在源码里留绝对路径
  const treeDir = "sessions/abc";
  const renderOpts = { maxTokens: 4000, factGuard: true, maxValueFacts: 1, treeDir, traceRoot: "sessions" };
  const main = renderLedger(mkFactGraph(), renderOpts);
  const minimal = renderMinimalLedger(mkFactGraph({ failure: false }), { maxTokens: 500, factGuard: true, maxValueFacts: 1 });
  const facts = renderFacts(mkFactGraph(), renderOpts);
  const pick = (text, needle) => String(text).split("\n").find((line) => line.includes(needle));

  // 残留计数行：陈旧失败 + to=null（C654 夹具同款）
  const residue = mkGraph();
  residue.sessionId = "fixture-c656-residue";
  residue.edges.e1.to = null;
  residue.edges.e1.ts = Date.now() - 60 * 60 * 1000;
  const residueLine = pick(renderLedger(residue).text, "条无终点残留");

  const cases = [
    ["主清单 值事实省略（# 另有 N 条值事实未展开）", pick(main.text, "条值事实未展开"), "未展开"],
    ["最小清单 值事实省略（同一句的 graph.json 变体）", pick(minimal.text, "条值事实未展开"), "未展开"],
    ["事实块 VALUE_FACTS_OMITTED", pick(facts, "VALUE_FACTS_OMITTED:"), "VALUE_FACTS_OMITTED"],
    ["主清单 残留计数行", residueLine, "条无终点残留"],
  ];
  // 旧 allowlist（C656 前 + t4 补完之后的那张表）：这 4 类一条都认不出来 ⇒ 这轮不是同义反复
  const OLD = /omitted for budget|FAILED_ATTEMPTS_OMITTED|DANGLING_RESIDUE|CONSTRAINTS_OMITTED/;
  for (const [label, line, needle] of cases) {
    t.ok(Boolean(line), `前置：${label} 必须真的渲染出来`);
    if (!line) continue;
    t.includes(line, needle, `${label} 的行文必须与模板一致（防止夹具其实没触发）`);
    t.eq(omissionLines(line).length, 1, `${label} 必须被 omitessionLines 认出（否则 ⑧ 永远看不到它）`);
    t.eq(OLD.test(line), false, `${label} 在旧 allowlist 下确实漏检（证明本轮修复不是同义反复）`);
    // 指针在场 ⇒ ⑧ 不红；把指针抹掉 ⇒ bad=1 ⇒ ⑧ 会红（判据本体 parseOmissions = ⑧ 用的那一份）
    t.eq(parseOmissions(line).bad.length, 0, `${label} 带 graph.json 回证指针 ⇒ ⑧ 不该红`);
    const stripped = line.split("graph.json").join("（无指针）");
    t.eq(parseOmissions(stripped).bad.length, 1, `${label} 抹掉指针后必须被 ⑧ 判红`);
  }
  // 没有省略时不许误报：普通 LEARNED 行不是省略行
  t.eq(omissionLines("LEARNED (3 failed attempts):").length, 0, "普通行不许误报");
};

tests["C656 ⑧端到端（主清单）：factGuard 开 ⇒ 值事实省略行被 ⑧ 看到并判 ok；关 ⇒ 那几行不渲染"] = (t) => {
  const g = mkFactGraph();
  const on = checkGraph(g, { factGuard: true, maxValueFacts: 1 });
  const onRow = byName(on, "⑧");
  t.eq(onRow.level, "ok", `值事实省略行带指针 ⇒ ⑧ 必须 ok：${onRow.detail}`);
  t.includes(onRow.detail, "行省略", "⑧ 必须真的把省略行看进去（不是「本档没有省略行」）");
  // 默认（factGuard=false）与生产默认一致：值事实段一行都不许出现 —— 这条同时守住「默认没被改动」
  const off = checkGraph(g, {});
  t.notIncludes(off.ledger.text, "条值事实未展开", "guard 关掉时不许出现值事实省略行");
  t.notIncludes(off.ledger.text, "VALUE FACTS", "guard 关掉时值事实段整段不渲染（AX-06 的默认口径）");
  t.eq(byName(off, "⑧").level, "ok", "guard 关掉时 ⑧ 仍 ok（没有省略行就没有可判的）");
};

tests["C656 ⑧端到端（最小清单）：零失败会话的值事实省略行带 graph.json 指针 ⇒ ⑧ ok"] = (t) => {
  const g = mkFactGraph({ failure: false });
  const r = checkGraph(g, { factGuard: true, maxValueFacts: 1 });
  const row = byName(r, "⑧");
  t.eq(row.level, "ok", `最小清单的值事实省略行带指针 ⇒ ⑧ ok：${row.detail}`);
  t.includes(row.detail, "行省略", "⑧ 必须看到这一行");
  t.includes(r.ledger.text, "条值事实未展开（见 graph.json 的 edges[*].valueFacts）", "最小清单没有 tree 前缀，指针退化为 graph.json（仍可回查）");
  t.eq(r.ledger.minimal, true, "零失败会话必须走最小清单（与生产同一条分支）");
};

/* ───────────── C656（t8）⑧ 判据收窄：行首产品形态 + 最小清单计数行纳入回证 ───────────── */

/** 收集 `ledger.mjs` 真实产出的**全部**省略行（9 类），供 ⑧ 判据逐类回归。 */
function productOmissionLines() {
  const out = [];
  const push = (label, text, needle) => {
    const line = String(text).split("\n").find((l) => l.includes(needle));
    out.push([label, line]);
  };
  // ① 主清单：失败边被裁（L4/L5 只留最近 10 条）
  // 30 条长失败边：L0–L4 都装不下 ⇒ 落到 L5（只留最近 10 条）才会出「dead ends omitted」行
  const many = mkGraph();
  const base = many.edges.e1;
  for (let i = 2; i <= 30; i += 1) {
    many.edges[`e${i}`] = { ...base, id: `e${i}`, intent: `试跑 ${i} ${'x'.repeat(120)}`, errorSnippet: `Error: boom ${i} ${'y'.repeat(120)}`, ts: base.ts + i };
  }
  push("①主清单 失败边被裁", renderLedger(many, { maxTokens: 500 }).text, "earlier dead ends omitted for budget");

  // ② 事实块：失败边省略（把上限压到 2 条）
  push("②事实块 FAILED_ATTEMPTS_OMITTED", renderFacts(many, { maxFailures: 2, headFailures: 1, treeDir: "sessions/abc", traceRoot: "sessions" }), "FAILED_ATTEMPTS_OMITTED:");

  // ③ 主清单：约束段病态超限（40 × 250 字符 > 8,000）
  const huge = mkGraph();
  huge.nodes.n1.constraints = Array.from({ length: 40 }, (_, i) => `约束 ${i + 1}：${"不许动 prod 配置，".repeat(20)}`);
  push("③主清单 CONSTRAINTS_OMITTED", renderLedger(huge, { maxTokens: 500 }).text, "CONSTRAINTS_OMITTED:");

  // ④⑤ 事实块：值事实省略 + 无终点残留
  const factGraph = mkFactGraph();
  const factOpts = { factGuard: true, maxValueFacts: 1, treeDir: "sessions/abc", traceRoot: "sessions" };
  push("④事实块 VALUE_FACTS_OMITTED", renderFacts(factGraph, factOpts), "VALUE_FACTS_OMITTED:");
  const residue = mkGraph();
  residue.sessionId = "fixture-c656-residue";
  residue.edges.e1.to = null;
  residue.edges.e1.ts = Date.now() - 60 * 60 * 1000;
  push("⑤事实块 DANGLING_RESIDUE", renderFacts(residue, { treeDir: "sessions/abc", traceRoot: "sessions" }), "DANGLING_RESIDUE:");

  // ⑥⑦ 主清单：值事实计数行 + 残留计数行
  push("⑥主清单 值事实未展开", renderLedger(factGraph, { maxTokens: 4000, ...factOpts }).text, "条值事实未展开");
  push("⑦主清单 无终点残留", renderLedger(residue).text, "条无终点残留");

  // ⑧ 最小清单：值事实计数行（无 tree 前缀，指针退化为 graph.json）
  const zeroFailure = mkFactGraph({ failure: false });
  push("⑧最小清单 值事实未展开", renderMinimalLedger(zeroFailure, { maxTokens: 500, factGuard: true, maxValueFacts: 1 }).text, "条值事实未展开");

  // ⑨ 最小清单：只给计数的 CONSTRAINTS 行（t8 新纳入回证校验）
  push("⑨最小清单 CONSTRAINTS 只给计数", renderMinimalLedger(zeroFailure, { maxTokens: 500 }).text, "CONSTRAINTS: ");

  return out;
}

tests["C656 ⑧判据收窄：普通用户文本里的「未展开」「FOO_OMITTED」不再假红（T7 实测反例）"] = (t) => {
  const g = mkGraph();
  g.nodes.n1.constraints = ["- 这段注释未展开说明，请补全", "别把 FOO_OMITTED 当真"];
  const text = renderLedger(g, { maxTokens: 4000 }).text;
  const bullets = text.split("\n").filter((line) => line.startsWith("- ") && (line.includes("未展开") || line.includes("FOO_OMITTED")));
  t.eq(bullets.length, 2, "前置：两条普通约束必须真的渲染出来");
  // 旧（t6）判据是**内容子串** ⇒ 两条都命中、又都没有 graph.json ⇒ ⑧ 假红（T7 实测 bad=2）
  const BROAD = /omitted for budget|\b[A-Z][A-Z0-9_]*_OMITTED\b|\bDANGLING_RESIDUE\b|未展开/;
  t.eq(bullets.filter((line) => BROAD.test(line)).length, 2, "旧判据确实把这两条当省略行 —— 这就是要修的面");
  t.eq(bullets.filter((line) => BROAD.test(line) && !line.includes("graph.json")).length, 2, "旧 ⑧ 的 bad 会是 2（假红）");
  // 新判据：行首锚定 ⇒ 一条都不该命中
  t.eq(omissionLines(text).length, 0, "普通用户文本不许被判成省略行");
  const row = byName(checkGraph(g, {}), "⑧");
  t.eq(row.level, "ok", `⑧ 必须 ok：${row.detail}`);
  t.includes(row.detail, "本档没有省略行", "没有省略行时必须如实说「本档没有省略行」");
};

tests["C656 ⑧判据收窄：产品省略行 9 类全部仍命中（行首锚定没漏），抹掉指针仍红"] = (t) => {
  const lines = productOmissionLines();
  t.eq(lines.length, 9, `产品省略行应有 9 类，实际 ${lines.length}`);
  for (const [label, line] of lines) {
    t.ok(Boolean(line), `前置：${label} 必须由真渲染器产出（夹具没触发就等于没测）`);
    if (!line) continue;
    t.eq(omissionLines(line).length, 1, `${label} 必须被 ⑧ 判据认出（行首锚定不许漏产品行）`);
    t.eq(parseOmissions(line).bad.length, 0, `${label} 带 graph.json 回证指针 ⇒ ⑧ 不该红`);
    const stripped = line.split("graph.json").join("（无指针）");
    t.eq(parseOmissions(stripped).bad.length, 1, `${label} 抹掉指针后必须判红（判据要能被同一个动作打红）`);
  }
};

tests["C656 ⑧最小清单：CONSTRAINTS 只给计数行纳入回证 —— 带指针 ok、抹 graph.json 判红"] = (t) => {
  const g = mkGraph();
  g.edges.e1.result = "success"; // 零失败边 ⇒ 生产走最小清单
  const led = renderMinimalLedger(g, { maxTokens: 500 });
  const line = led.text.split("\n").find((l) => l.startsWith("CONSTRAINTS: "));
  t.ok(Boolean(line), "前置：最小清单必须有 CONSTRAINTS 行");
  t.includes(line, "count only, not verbatim; full text: graph.json", "该行必须明说「不是逐字全文」并给回证位置");
  t.eq(omissionLines(line).length, 1, "「只给计数」也是回证行，必须纳入省略行集合（否则丢指针没人管）");
  t.eq(parseOmissions(line).bad.length, 0, "带指针 ⇒ ⑧ 不红");
  t.eq(parseOmissions(line.split("graph.json").join("（无指针）")).bad.length, 1, "抹掉 graph.json ⇒ ⑧ 必须红");
  const row = byName(checkGraph(g, {}), "⑧");
  t.eq(row.level, "ok", `⑧ 必须 ok：${row.detail}`);
  t.includes(row.detail, "1 行省略", "⑧ 必须把这一行算进省略行计数（不再是「本档没有省略行」）");
};
