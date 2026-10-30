import { selectIncrementalRange, nextSeqAfterLastCheckpoint, hasSystemHead } from "../src/rooms/fold-planner.mjs";

/** 构造 surface + pricedNodes */
function surface(seqs, { systemHead = false, cpAt = null, balanced = () => true } = {}) {
  const events = new Map();
  seqs.forEach((seq, i) => {
    if (i === 0 && systemHead) events.set(seq, { type: "system/message" });
    else if (seq === cpAt) events.set(seq, { type: "user/message", data: { source: { kind: "compact-checkpoint" } } });
    else events.set(seq, { type: "user/message", data: { source: { kind: "prompt" } } });
  });
  return {
    surfaceNodes: seqs,
    pricedNodes: seqs.map((seq) => ({ seq, tokens: 1000, heuristicTokens: 1000 })),
    eventAt: (seq) => events.get(seq),
    balanced,
  };
}

export const tests = {
  "增量 fold：起点在上一个 checkpoint 之后（不重摘要旧 checkpoint）"() {
    const s = surface([10, 11, 12, 13, 14, 15, 16, 17], { systemHead: true, cpAt: 13 });
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: s.pricedNodes,
      retainTokens: 2000,
      hasSystemHead: true,
      foldStartSeq: 14,
      minFoldTokens: 0,
    });
    if (range === null) throw new Error("应当有可压范围");
    if (range.start !== 14) throw new Error(`起点应在 checkpoint 之后（14），得到 ${range.start}`);
    if (range.end !== 15) throw new Error(`终点应保留 2 个尾部（15），得到 ${range.end}`);
  },

  "无 checkpoint 时从 surface 头（跳过 system）开始"() {
    const s = surface([1, 2, 3, 4, 5], { systemHead: true });
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: s.pricedNodes,
      retainTokens: 2000,
      hasSystemHead: true,
      foldStartSeq: null,
      minFoldTokens: 0,
    });
    if (range.start !== 2) throw new Error(`起点应跳过 system head（2），得到 ${range.start}`);
  },

  "保留尾部：retainTokens 决定终点"() {
    const s = surface([1, 2, 3, 4, 5, 6, 7, 8]);
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: s.pricedNodes,
      retainTokens: 3000,
      hasSystemHead: false,
      foldStartSeq: null,
      minFoldTokens: 0,
    });
    if (range.end !== 5) throw new Error(`终点应为 5（保留 6/7/8），得到 ${range.end}`);
  },

  "minFoldTokens 门槛：遮蔽量不足就不压"() {
    const s = surface([1, 2, 3, 4, 5]);
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: s.pricedNodes,
      retainTokens: 2000,
      hasSystemHead: false,
      foldStartSeq: null,
      minFoldTokens: 5000,
    });
    if (range !== null) throw new Error(`遮蔽 3000 < 门槛 5000，应当返回 null，得到 ${JSON.stringify(range)}`);
  },

  "工具对不平衡时向后让路（宁可少压，不切断 pair）"() {
    const s = surface([1, 2, 3, 4, 5, 6], { balanced: (seq) => seq !== 2 });
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: s.pricedNodes,
      retainTokens: 1000,
      hasSystemHead: false,
      foldStartSeq: 2,
      minFoldTokens: 0,
      balancedBefore: s.balanced,
    });
    if (range.start === 2) throw new Error("起点落在不平衡处");
    if (range.start !== 3) throw new Error(`起点应让到 3，得到 ${range.start}`);
  },

  "checkpoint 在末尾 ⇒ nextSeq 为 null（调用方据此跳过 fold）"() {
    const s = surface([1, 2, 3, 4], { cpAt: 4 });
    const cp = nextSeqAfterLastCheckpoint(s.surfaceNodes, s.eventAt);
    if (!cp.found) throw new Error("应 found");
    if (cp.nextSeq !== null) throw new Error(`应为 null，得到 ${cp.nextSeq}`);
  },

  "nextSeqAfterLastCheckpoint 找 checkpoint 的下一个 seq"() {
    const s = surface([10, 11, 12, 13], { cpAt: 11 });
    const cp = nextSeqAfterLastCheckpoint(s.surfaceNodes, s.eventAt);
    if (cp.nextSeq !== 12) throw new Error(`得到 ${cp.nextSeq}`);
    if (!cp.found) throw new Error("应 found");
  },

  "没有 checkpoint 时 found=false（从头压，而不是不压）"() {
    const s = surface([10, 11], {});
    const cp = nextSeqAfterLastCheckpoint(s.surfaceNodes, s.eventAt);
    if (cp.found) throw new Error("不该 found");
    if (cp.nextSeq !== null) throw new Error("nextSeq 应 null");
  },

  "hasSystemHead 判定"() {
    const s1 = surface([1, 2], { systemHead: true });
    if (!hasSystemHead(s1.eventAt, s1.surfaceNodes)) throw new Error("应识别 system head");
    const s2 = surface([1, 2]);
    if (hasSystemHead(s2.eventAt, s2.surfaceNodes)) throw new Error("误判 system head");
  },

  "surface 与 pricedNodes 不一致 ⇒ null（不猜）"() {
    const s = surface([1, 2, 3]);
    const range = selectIncrementalRange({
      surfaceNodes: s.surfaceNodes,
      pricedNodes: [{ seq: 1, heuristicTokens: 1000 }],
      retainTokens: 0,
      hasSystemHead: false,
      foldStartSeq: null,
    });
    if (range !== null) throw new Error("长度不一致时应返回 null");
  },
};
