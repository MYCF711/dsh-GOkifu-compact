/**
 * dangling-exclusion.test.mjs —— P6-A「悬空边仅在分析中排除」回归矩阵（2026-10-30）
 *
 * 背景（ws-dangling 全库测量，133 会话 / 18,038 边）：
 *   · `to=null` 5,567 条：5,564 条是 1.9.1 rewash 清自环时抹掉 `to` 的**历史残留**
 *     （已结算却没有终点 = 不可能），只有 3 条是陈旧 untested；
 *   · 268 条无终点失败边占全部失败边的 27.8%（热清单里 28% 的「失败」是结构性死胡同）；
 *   · 另有 214 条 `from` 悬空（全在 session-5acafe42，mergeNodeInto 老 bug）—— 另一类，不得混入。
 *
 * 不变量：
 *   residue(e)        := e.to == null && (e.result !== "untested" || age > 10min)
 *   live_unsettled(e) := e.to == null && e.result === "untested" && age <= 10min
 *
 * 本文件锁住：只排除 residue、live_unsettled 必须保留、from 悬空单列、热清单/硬事实的区分、
 * 以及「把 live_unsettled 也排除」的变异必须被抓到。
 */

import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, failureEdges, tewariAnalysis, failureClass } from "../src/graph.mjs";
import { renderLedger, renderFacts, classifyDangling, danglingStats, isDanglingResidue, DANGLING_STALE_MS } from "../src/ledger.mjs";

/* ───────────────────────────── 夹具 ───────────────────────────── */

const NOW = 1_800_000_000_000;
const TEN_MIN = DANGLING_STALE_MS;

function baseGraph(sessionId = "fx-dangling") {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "把构建跑通。" });
  const e0 = addEdge(g, { from: u, intent: "起点", action: "bash(ls)" });
  const a = addAgentNode(g, { seq: 3, goal: "起点", worldHash: "W0", constraintHash: "C1", via: e0 }).id;
  g.edges[e0].to = a;
  settleEdge(g, e0, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return { g, u, a };
}

/** 一条已结算但没有终点的边（rewash 残留）。 */
function addResidue(g, from, { result = "failure", id = null } = {}) {
  const e = addEdge(g, { from, intent: "rewash 残留", action: "bash(x)" });
  g.edges[e].ts = NOW - 24 * 3600 * 1000;
  settleEdge(g, e, {
    result,
    verify: { kind: result === "failure" ? "exit" : "no-exit", summary: result === "failure" ? "exit 1" : "10 chars, no exit code" },
    errorSnippet: result === "failure" ? "boom" : "",
  });
  return e;
}

/** 一条真正有终点的失败边。 */
function addRealFailure(g, from, to) {
  const e = addEdge(g, { from, intent: "真失败", action: "bash(npm test)" });
  settleEdge(g, e, { to, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: real" });
  return e;
}

const learnedIds = (text) => text.split("\n").filter((l) => /^- e\d+ /.test(l)).map((l) => /^- (e\d+) /.exec(l)[1]);

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "P6A-1 classifyDangling：四类判定（residue / live-unsettled / from-broken / none）"(t) {
    const { g, u, a } = baseGraph();
    // residue：已结算（failure）且 to=null
    const r = addResidue(g, a, { result: "failure" });
    t.eq(classifyDangling(g.edges[r], { graph: g, now: NOW }), "residue", "已结算 + to=null = residue");
    // residue：unverified + to=null
    const r2 = addResidue(g, a, { result: "unverified" });
    t.eq(classifyDangling(g.edges[r2], { graph: g, now: NOW }), "residue", "unverified + to=null = residue");
    // ★ 年龄护栏：**刚结算**（ts 新鲜）的失败边不许当残留 —— keeper 先 settle、step/end 才回填 to
    const fresh = addEdge(g, { from: a, intent: "刚失败", action: "bash(x)" });
    settleEdge(g, fresh, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
    g.edges[fresh].ts = NOW - 1000;
    t.eq(classifyDangling(g.edges[fresh], { graph: g, now: NOW }), "live-unsettled", "刚结算的失败边必须按 live 保留（年龄护栏）");
    // live_unsettled：untested 且新鲜
    const live = addEdge(g, { from: a, intent: "正在跑", action: "bash(sleep 1)" });
    g.edges[live].ts = NOW - 1000;
    t.eq(classifyDangling(g.edges[live], { graph: g, now: NOW }), "live-unsettled", "新鲜 untested = live");
    // residue：untested 但超过 10 分钟
    const stale = addEdge(g, { from: a, intent: "陈旧", action: "bash(x)" });
    g.edges[stale].ts = NOW - TEN_MIN - 1;
    t.eq(classifyDangling(g.edges[stale], { graph: g, now: NOW }), "residue", "超过 10 分钟的 untested = residue");
    // 恰好 10 分钟仍是 live（> 才 stale）
    const edgeCase = addEdge(g, { from: a, intent: "边界", action: "bash(x)" });
    g.edges[edgeCase].ts = NOW - TEN_MIN;
    t.eq(classifyDangling(g.edges[edgeCase], { graph: g, now: NOW }), "live-unsettled", "恰 10 分钟 = live（用 > 不是 >=）");
    // from-broken：from 指向不存在的节点（另一类）
    const fb = addEdge(g, { from: "n-does-not-exist", intent: "from 悬空", action: "bash(x)" });
    settleEdge(g, fb, { to: a, result: "unverified", verify: { kind: "no-exit", summary: "x" } });
    t.eq(classifyDangling(g.edges[fb], { graph: g, now: NOW }), "from-broken", "from 悬空必须单独一类");
    // none：正常边
    const ok = addRealFailure(g, u, a);
    t.eq(classifyDangling(g.edges[ok], { graph: g, now: NOW }), "none", "有终点的边 = none");
    t.eq(classifyDangling(null), "none", "null 安全");
  },

  "P6A-2 danglingStats：三类计数互不重叠，全库形态可复现"(t) {
    const { g, u, a } = baseGraph("fx-stats");
    for (let i = 0; i < 3; i += 1) addResidue(g, a, { result: "failure" });
    const live = addEdge(g, { from: a, intent: "live", action: "bash(x)" });
    g.edges[live].ts = NOW - 1000;
    const fb = addEdge(g, { from: "n-missing", intent: "fb", action: "bash(x)" });
    settleEdge(g, fb, { to: a, result: "unverified", verify: { kind: "no-exit", summary: "x" } });
    const s = danglingStats(g, { now: NOW });
    t.eq(s.residue, 3, `residue 必须 3，实际 ${JSON.stringify(s)}`);
    t.eq(s.liveUnsettled, 1, "live_unsettled 必须 1");
    t.eq(s.fromBroken, 1, "from_broken 必须 1");
    // 三类不相交：逐边分类求和 = 边数里属于这三类的
    let sum = 0;
    for (const e of Object.values(g.edges)) {
      const k = classifyDangling(e, { graph: g, now: NOW });
      if (k === "residue" || k === "live-unsettled" || k === "from-broken") sum += 1;
    }
    t.eq(sum, 5, "分类总数必须等于三类之和（互不重叠）");
  },

  "P6A-3 热清单：无终点失败边不再展示（噪声 −100%），真失败仍在"(t) {
    const { g, u, a } = baseGraph("fx-hot");
    for (let i = 0; i < 5; i += 1) addResidue(g, a, { result: "failure" });
    const real = addRealFailure(g, u, a);
    const r = renderLedger(g, { maxTokens: 500, now: NOW });
    const ids = learnedIds(r.text);
    t.ok(ids.includes(real), `真失败 ${real} 必须留在 LEARNED：${ids.join(",")}`);
    for (const e of Object.values(g.edges)) {
      if (e.result === "failure" && e.to === null) {
        t.eq(ids.includes(e.id), false, `残留失败 ${e.id} 不许出现在 LEARNED`);
      }
    }
    t.eq(r.text.includes("rewash residue (no endpoint) omitted"), false, "热清单不该为残留单独占一行（token）");
  },

  "P6A-4 live_unsettled 必须保留：新产生的 untested 边仍在 UNVERIFIED_CLAIMS"(t) {
    const { g, a } = baseGraph("fx-live");
    const live = addEdge(g, { from: a, intent: "正在执行第 3 步", action: "bash(sleep 1)" });
    g.edges[live].ts = NOW - 1000;
    const r = renderLedger(g, { maxTokens: 500, now: NOW });
    t.ok(r.text.includes("UNVERIFIED (ran, but no external signal"), `必须有 UNVERIFIED 段：\n${r.text}`);
    t.ok(r.text.includes(live), `live_unsettled 边 ${live} 必须保留：\n${r.text}`);
    t.ok(r.text.includes("正在执行第 3 步"), "live 边的意图必须可见（防误清）");
  },

  "P6A-5 renderFacts：仍列全部失败边，但显式区分 DANGLING_RESIDUE 并计数"(t) {
    const { g, u, a } = baseGraph("fx-facts-d");
    for (let i = 0; i < 4; i += 1) addResidue(g, a, { result: "failure" });
    addRealFailure(g, u, a);
    const facts = renderFacts(g, { now: NOW });
    const failTotal = failureEdges(g).length;
    t.eq(failTotal, 5, "failureEdges 仍是全部 5 条（判定不变）");
    t.includes(facts, `FAILED_ATTEMPTS (5 listed of 5`, "硬事实仍列全部失败边");
    t.includes(facts, "DANGLING_RESIDUE: 4", "必须显式计数 4 条无终点残留");
    t.includes(facts, "excluded from hot-list analysis", "必须说明只影响热清单分析");
    t.includes(facts, "data kept in graph.json", "必须说明数据仍在（没剪）");
  },

  "P6A-6 from 悬空单独标记：不混入 to-null residue、不影响热清单过滤"(t) {
    const { g, u, a } = baseGraph("fx-from");
    const fb = addEdge(g, { from: "n-missing", intent: "from 悬空", action: "bash(x)" });
    settleEdge(g, fb, { to: a, result: "unverified", verify: { kind: "no-exit", summary: "x" } });
    const s = danglingStats(g, { now: NOW });
    t.eq(s.residue, 0, "from 悬空不许计入 residue");
    t.eq(s.fromBroken, 1, "from 悬空单独计数");
    const facts = renderFacts(g, { now: NOW });
    t.includes(facts, "FROM_DANGLING: 1", "硬事实必须单列 from 悬空");
    // 热清单不该把它当 residue 排除掉（它是 unverified 但 from 断了，仍应可见）
    const r = renderLedger(g, { maxTokens: 500, now: NOW });
    t.eq(r.text.includes(fb), true, `from 悬空边 ${fb} 不应被 residue 过滤误伤`);
  },

  "P6A-7 不改变 success/failure/dead/redundant 判定：failureEdges 与 tewari 逐字不变"(t) {
    const { g, u, a } = baseGraph("fx-judge");
    const f1 = addRealFailure(g, u, a);
    addResidue(g, a, { result: "failure" });
    const before = { count: failureEdges(g).length, tewari: JSON.stringify(tewariAnalysis(g, g.edges[f1])), cls: JSON.stringify(failureClass(g.edges[f1], tewariAnalysis(g, g.edges[f1]))) };
    renderLedger(g, { maxTokens: 500, now: NOW });
    renderFacts(g, { now: NOW });
    const after = { count: failureEdges(g).length, tewari: JSON.stringify(tewariAnalysis(g, g.edges[f1])), cls: JSON.stringify(failureClass(g.edges[f1], tewariAnalysis(g, g.edges[f1]))) };
    t.eq(after.count, before.count, "failureEdges 条数不变");
    t.eq(after.tewari, before.tewari, "tewari 不变");
    t.eq(after.cls, before.cls, "failureClass 不变");
  },

  "P6A-8 tokens：同一批边，无终点失败比真失败便宜（过滤真的省 token）"(t) {
    const mk = (withTo) => {
      const { g, u, a } = baseGraph(`fx-tok-${withTo}`);
      for (let i = 0; i < 40; i += 1) {
        if (withTo) addRealFailure(g, u, a);
        else addResidue(g, a, { result: "failure" });
      }
      return g;
    };
    const withTo = renderLedger(mk(true), { maxTokens: 500, now: NOW });
    const withoutTo = renderLedger(mk(false), { maxTokens: 500, now: NOW });
    t.ok(withoutTo.tokens < withTo.tokens, `无终点版本必须更省：${withoutTo.tokens} vs ${withTo.tokens}`);
    t.eq(learnedIds(withoutTo.text).length, 0, "无终点版本 LEARNED 应为空");
    t.eq(learnedIds(withTo.text).length > 0, true, "有终点版本 LEARNED 必须有内容");
  },
};
