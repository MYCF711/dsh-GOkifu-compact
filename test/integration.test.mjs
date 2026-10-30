import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges } from "./graph-fixtures.mjs";
import { renderFacts, renderLedger } from "../src/rooms/ledger.mjs";
import { planFold } from "../src/rooms/fold-planner.mjs";
import { runPolicy } from "./sim.mjs";

/** 从 planFold 的输出判断「这次 fold 是否包含旧 checkpoint」——用 fold 记录间接验证。 */
export const tests = {
  "增量 fold：连续三次 fold 的遮蔽范围互不重叠，且都在上一个 checkpoint 之后"() {
    const r = runPolicy({ strategy: "chess", steps: 200, scale: 1, window: 200_000, reserved: 8192, headroom: 16384 });
    if (r.folds.length < 3) throw new Error(`fold 次数不足：${r.folds.length}`);
    for (let i = 1; i < r.folds.length; i += 1) {
      const prev = r.folds[i - 1];
      const cur = r.folds[i];
      // 每次 fold 的起点必须严格大于上一次的终点（中间隔着一个 checkpoint + 新内容）
      if (cur.start <= prev.end) throw new Error(`第 ${i} 次 fold 起点 ${cur.start} <= 上次终点 ${prev.end}（重叠 ⇒ 会重复摘要）`);
    }
  },

  "增量 fold 的 token 总量被压回带内（峰值不随步数线性膨胀）"() {
    const r = runPolicy({ strategy: "chess", steps: 300, scale: 1, window: 200_000, reserved: 8192, headroom: 16384 });
    const firstPeak = Math.max(...r.requestTotals.slice(0, 40));
    const lastPeak = Math.max(...r.requestTotals.slice(-40));
    if (lastPeak > firstPeak * 1.6) throw new Error(`后期峰值 ${lastPeak} 比早期 ${firstPeak} 胀了 >60%`);
    if (r.peakTokens >= r.window) throw new Error(`越窗：${r.peakTokens} >= ${r.window}`);
  },

  "官方策略确实会重摘要上一次 checkpoint（ρ^k 衰减的机制证据）"() {
    const r = runPolicy({ strategy: "official", steps: 200, scale: 1, window: 200_000, reserved: 8192, headroom: 16384 });
    const re = r.folds.filter((f) => f.reSummarizedPriorCheckpoint === true);
    if (re.length === 0) throw new Error("模拟里没重现「重摘要旧 checkpoint」—— 说明对照策略没写对");
  },

  "同一份数据两种策略：增量 fold 的累计计费不高于官方"() {
    const common = { steps: 200, scale: 1, window: 200_000, reserved: 8192, headroom: 16384 };
    const chess = runPolicy({ ...common, strategy: "chess" });
    const official = runPolicy({ ...common, strategy: "official" });
    if (chess.billedTokens > official.billedTokens) {
      throw new Error(`增量 fold 反而更贵：${chess.billedTokens} > ${official.billedTokens}`);
    }
  },

  "折叠后仍能从图里重建全部失败边（压缩不丢失败记忆）"() {
    const g = createGraph({ sessionId: "it1" });
    const u = addUserNodeId(g, { seq: 1, text: "必须让测试变绿；不要动 prod。" });
    let last = u;
    const N = 6;
    for (let i = 0; i < N; i += 1) {
      const e = addEdge(g, { from: last, intent: `尝试 ${i}`, action: `bash(test${i})`, evidence: { start: 100 + i * 10, end: 104 + i * 10 } });
      settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError #${i}: boom` });
      const n = addAgentNode(g, { seq: 200 + i, goal: `失败 ${i}`, worldHash: `W${i}`, constraintHash: "C", via: e });
      settleEdge(g, e, { to: n.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError #${i}: boom` });
      last = n.id;
    }
    const facts = renderFacts(g);
    const ledger = renderLedger(g, { maxTokens: 4000 });
    for (let i = 0; i < N; i += 1) {
      if (!facts.includes(`AssertionError #${i}: boom`)) throw new Error(`facts 丢了失败 ${i}`);
      if (!ledger.text.includes(`尝试 ${i}`)) throw new Error(`ledger 丢了失败 ${i}`);
    }
    if (failureEdges(g).length !== N) throw new Error("失败边数不对");
  },

  "planFold 幂等：同输入同输出（可重放）"() {
    const nodes = [{ seq: 1, tokens: 8000 }, { seq: 2, tokens: 1000 }, { seq: 3, tokens: 1000 }];
    const priced = nodes.map((n) => ({ seq: n.seq, tokens: n.tokens, heuristicTokens: n.tokens }));
    const eventAt = (seq) => (seq === 1 ? { type: "system/message" } : { type: "user/message" });
    const a = planFold({ surfaceNodes: [1, 2, 3], pricedNodes: priced, eventAt, retainTokens: 1000, minFoldTokens: 0 });
    const b = planFold({ surfaceNodes: [1, 2, 3], pricedNodes: priced, eventAt, retainTokens: 1000, minFoldTokens: 0 });
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("不幂等");
  },

  "溢出自救：绕过保留尾部与最小量门槛"() {
    const nodes = [{ seq: 1, tokens: 8000 }, { seq: 2, tokens: 500 }, { seq: 3, tokens: 500 }];
    const priced = nodes.map((n) => ({ seq: n.seq, tokens: n.tokens, heuristicTokens: n.tokens }));
    const eventAt = (seq) => (seq === 1 ? { type: "system/message" } : { type: "user/message" });
    const normal = planFold({ surfaceNodes: [1, 2, 3], pricedNodes: priced, eventAt, retainTokens: 2000, minFoldTokens: 5000 });
    if (normal.range !== null) throw new Error("常规路径应因门槛不足而放弃");
    const rescue = planFold({ surfaceNodes: [1, 2, 3], pricedNodes: priced, eventAt, retainTokens: 2000, minFoldTokens: 5000, overflow: true });
    if (rescue.range === null) throw new Error("溢出自救必须能压");
  },
};
