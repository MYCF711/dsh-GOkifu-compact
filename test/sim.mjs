/**
 * sim.mjs —— 压缩策略模拟器（无 DSH 运行时也能量化「增量 fold」与「官方全量重摘要」的差别）
 *
 * 它**不是**真实 DSH 会话的替代品：surface 的 seq/事件语义被简化成
 * 「节点 = {seq, tokens}」，replace 直接把区间换成一个 checkpoint 节点。
 * 但它足以验证本插件的结构性质（fold 范围不重叠、保留率不衰减、失败清单恒在）。
 *
 * 官方策略模型（selectCompactableRange 的等价物）：每次从第一个非 system 节点压到
 * 保留边界 —— 因此**上一次的 checkpoint 必定被再摘要一次**，这就是 ρ^k 衰减的来源。
 */

import { planFold } from "../src/range.mjs";

export function createSim({ window = 1_000_000, systemTokens = 8000, toolsTokens = 12000, checkpointTokens = 700 } = {}) {
  let nextSeq = 1;
  const nodes = []; // {seq, tokens, kind:'system'|'plain'|'checkpoint'}
  nodes.push({ seq: nextSeq++, tokens: systemTokens, kind: "system" });
  const eventAt = (seq) => {
    const node = nodes.find((n) => n.seq === seq);
    if (node === undefined) return undefined;
    if (node.kind === "system") return { type: "system/message" };
    if (node.kind === "checkpoint") return { type: "user/message", data: { source: { kind: "compact-checkpoint" } } };
    return { type: "user/message", data: { source: { kind: "prompt" } } };
  };
  return {
    get window() {
      return window;
    },
    get nodes() {
      return nodes;
    },
    get surfaceNodes() {
      return nodes.map((n) => n.seq);
    },
    eventAt,
    /** 追加一段会话内容（一步 = 一条 user 或 assistant/tool 节点） */
    append({ tokens, kind = "plain" }) {
      const node = { seq: nextSeq++, tokens, kind };
      nodes.push(node);
      return node.seq;
    },
    /** 追加一步（4 个节点：user 800 / assistant 1200 / tool 4000 / assistant 1000） */
    appendStep(scale = 1) {
      this.append({ tokens: Math.round(800 * scale) });
      this.append({ tokens: Math.round(1200 * scale) });
      this.append({ tokens: Math.round(4000 * scale) });
      this.append({ tokens: Math.round(1000 * scale) });
      return 7000 * scale;
    },
    measure() {
      const total = nodes.reduce((sum, n) => sum + n.tokens, 0) + toolsTokens;
      const pricedNodes = nodes.map((n) => ({ seq: n.seq, tokens: n.tokens, heuristicTokens: n.tokens }));
      return { totalTokens: total, surfaceTokens: total - toolsTokens, nodes: pricedNodes };
    },
    /** 执行一次 replace：[start..end] → 一个 checkpoint 节点 */
    replace(start, end, tokens = checkpointTokens) {
      const startIdx = nodes.findIndex((n) => n.seq === start);
      const endIdx = nodes.findIndex((n) => n.seq === end);
      if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error(`replace: bad range ${start}-${end}`);
      const checkpoint = { seq: nextSeq++, tokens, kind: "checkpoint" };
      nodes.splice(startIdx, endIdx - startIdx + 1, checkpoint);
      return checkpoint.seq;
    },
  };
}

/**
 * 跑一条策略。返回每次请求的 totalTokens 序列与 fold 记录。
 * @param {'chess'|'official'} strategy
 */
export function runPolicy({
  strategy,
  steps = 120,
  scale = 1,
  window = 1_000_000,
  thresholdRatio = 0.45,
  headroom = 65536,
  reserved = 65536,
  retainRatio = 0.16,
  growthFloor = 40000,
  minFold = 8000,
  officialThresholdRatio = 0.8,
  /** 一次 fold 的摘要调用输入成本模型：'zero'（规则摘要，零模型调用）| 'replay'（回放被遮蔽量，官方做法） */
  foldCostModel = strategy === "official" ? "replay" : "zero",
  /** tier-2：surface 上 checkpoint 超过这么多就把最老的两条合并成一条 */
  tier2After = 8,
}) {
  const sim = createSim({ window });
  const messageBudget = window - reserved;
  const threshold = Math.floor(Math.min(window * (strategy === "official" ? officialThresholdRatio : thresholdRatio), messageBudget - headroom));
  const retainTokens = Math.floor(messageBudget * retainRatio);

  const requestTotals = [];
  const folds = [];
  let lastFoldTotal = 0;
  let summaryCostTokens = 0;

  const mergeTier2 = () => {
    if (tier2After <= 0) return 0;
    let merged = 0;
    for (;;) {
      const cps = sim.nodes.filter((n) => n.kind === "checkpoint");
      if (cps.length < tier2After) break;
      const [a, b] = cps;
      sim.replace(a.seq, b.seq);
      merged += 1;
    }
    return merged;
  };

  for (let step = 0; step < steps; step += 1) {
    sim.appendStep(scale);
    const measurement = sim.measure();
    requestTotals.push(measurement.totalTokens);

    const over = measurement.totalTokens >= threshold;
    if (!over) continue;

    if (strategy === "chess") {
      const growth = measurement.totalTokens - lastFoldTotal;
      if (folds.length > 0 && growth < growthFloor) continue;
      const planned = planFold({
        surfaceNodes: sim.surfaceNodes,
        pricedNodes: measurement.nodes,
        eventAt: (seq) => sim.eventAt(seq),
        retainTokens,
        minFoldTokens: minFold,
      });
      if (planned.range === null) continue;
      const before = measurement.totalTokens;
      if (foldCostModel === "replay") summaryCostTokens += planned.range.shadowedTokens;
      sim.replace(planned.range.start, planned.range.end);
      mergeTier2();
      folds.push({
        at: step,
        start: planned.range.start,
        end: planned.range.end,
        shadowedTokens: planned.range.shadowedTokens,
        before,
        after: sim.measure().totalTokens,
      });
      lastFoldTotal = sim.measure().totalTokens;
    } else {
      // 官方：从第一个非 system 节点压到「保留尾部」边界，且包含上一次 checkpoint
      const priced = measurement.nodes;
      let accumulated = 0;
      let keepFrom = priced.length;
      for (let i = priced.length - 1; i >= 0; i -= 1) {
        accumulated += priced[i].tokens;
        keepFrom = i;
        if (accumulated >= retainTokens) break;
      }
      const firstIdx = sim.eventAt(priced[0].seq)?.type === "system/message" ? 1 : 0;
      if (keepFrom <= firstIdx) continue;
      const before = measurement.totalTokens;
      if (foldCostModel === "replay") summaryCostTokens += priced.slice(firstIdx, keepFrom).reduce((x, n) => x + n.tokens, 0);
      // ★ 必须在 replace 之前判定：replace 会删掉旧节点的 seq
      const reSummarized = priced
        .slice(firstIdx, keepFrom)
        .some((n) => sim.eventAt(n.seq)?.data?.source?.kind === "compact-checkpoint");
      sim.replace(priced[firstIdx].seq, priced[keepFrom - 1].seq);
      folds.push({
        at: step,
        start: priced[firstIdx].seq,
        end: priced[keepFrom - 1].seq,
        shadowedTokens: priced.slice(firstIdx, keepFrom).reduce((s, n) => s + n.tokens, 0),
        before,
        after: sim.measure().totalTokens,
        reSummarizedPriorCheckpoint: reSummarized,
      });
      lastFoldTotal = sim.measure().totalTokens;
    }
  }

  return {
    strategy,
    steps,
    scale,
    window,
    threshold,
    retainTokens,
    requestTotals,
    folds,
    finalNodes: sim.nodes.length,
    checkpointsLeft: sim.nodes.filter((n) => n.kind === "checkpoint").length,
    summaryCostTokens,
    requestTokens: requestTotals.reduce((s, n) => s + n, 0),
    billedTokens: requestTotals.reduce((s, n) => s + n, 0) + summaryCostTokens,
    peakTokens: Math.max(...requestTotals),
    meanTokens: Math.round(requestTotals.reduce((s, n) => s + n, 0) / requestTotals.length),
  };
}

/**
 * 保留率模型：一段内容经历 k 次「重摘要」后还剩多少。
 * 官方：每轮重摘要一次，单轮保留 p（默认 0.7，取自 Compaction Cliff 的安全规则存活率口径）。
 * 本插件：每段只压一次，之后原样驻留 → 恒定 1。
 */
export function retentionAfter(folds, p = 0.7) {
  return Math.pow(p, Math.max(0, folds));
}
