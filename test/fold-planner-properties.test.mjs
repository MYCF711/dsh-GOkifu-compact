/**
 * fold-planner-properties.test.mjs —— 折叠范围规划器的**不变量**（2026-11-02，C127）
 *
 * 为什么需要：`planFold` 决定「这一次压哪一段」—— 它是压缩的核心决策，而现有用例都是**手挑**的少量场景
 * （幂等、溢出自救）。手挑场景证明不了「随机输入下仍守规矩」。
 *
 * 这里用固定种子生成 40 组输入（含/不含 checkpoint、含/不含 system head、常规/溢出、不同保留量与最小量），
 * 断言四条不变量：
 *   ① 不崩：返回结构必须是 `{range, reason, checkpointAtTail}` 之一形态，`range===null` 时 reason 必须已知；
 *   ② 区间合法：`range.start ≤ range.end`，且两端都在 surface 的 seq 范围内；
 *   ③ **溢出绕过门槛**：`overflow=true` 且可行时不许因 `minFoldTokens` 放弃（与 integration 的用例同口径，随机化验证）；
 *   ④ 常规路径不越过门槛：`overflow=false` 且返回区间时，被折叠的计价 tokens 必须 ≥ `minFoldTokens`。
 *
 * 只测**纯函数**，不碰 fs、不调模型。
 */

import { planFold } from "../src/rooms/fold-planner.mjs";

export const tests = {};

/** 确定性 PRNG（mulberry32）：同一种子必须给出同一组用例。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNOWN_REASONS = new Set(["empty-surface", "checkpoint-at-tail", "no-foldable-span", "ok"]);

function makeCase(rand) {
  const n = 3 + Math.floor(rand() * 8); // 3..10 个节点
  const seqs = [];
  let seq = 1;
  for (let i = 0; i < n; i += 1) {
    seqs.push(seq);
    seq += 1 + Math.floor(rand() * 3); // 事件间隔 1..3
  }
  const withSystemHead = rand() < 0.5;
  const checkpointAt = rand() < 0.4 ? Math.floor(rand() * n) : -1; // -1 = 没有 checkpoint
  const priced = seqs.map((s, i) => ({ seq: s, tokens: 200 + Math.floor(rand() * 3000), heuristicTokens: 0 }));
  const eventAt = (target) => {
    const idx = seqs.indexOf(target);
    if (idx === 0 && withSystemHead) return { type: "system/message" };
    if (idx === checkpointAt) return { type: "user/message", data: { source: { kind: "compact-checkpoint" } } };
    return { type: "user/message" };
  };
  return {
    surfaceNodes: seqs,
    pricedNodes: priced,
    eventAt,
    retainTokens: [0, 500, 2000][Math.floor(rand() * 3)],
    minFoldTokens: [0, 1500, 4000][Math.floor(rand() * 3)],
    overflow: rand() < 0.35,
    seqs,
    priced,
  };
}

const tokensBetween = (priced, start, end) => priced.filter((p) => p.seq >= start && p.seq <= end).reduce((sum, p) => sum + p.tokens, 0);

tests["C127-1 结构合法：返回形态固定，range===null 时 reason 必须已知"] = (t) => {
  const rand = rng(20261102);
  for (let i = 0; i < 40; i += 1) {
    const c = makeCase(rand);
    const out = planFold(c);
    t.eq(typeof out === "object" && out !== null, true, `第 ${i + 1} 组返回值必须是对象`);
    t.eq(typeof out.checkpointAtTail, "boolean", `第 ${i + 1} 组必须给出 checkpointAtTail`);
    t.eq(KNOWN_REASONS.has(out.reason), true, `第 ${i + 1} 组 reason 未知：${out.reason}`);
    if (out.range === null) t.eq(out.reason !== "ok", true, `第 ${i + 1} 组 range 为 null 时 reason 不许是 ok`);
  }
};

tests["C127-2 区间合法：start ≤ end，且两端都落在 surface 的 seq 范围内"] = (t) => {
  const rand = rng(7);
  let produced = 0;
  for (let i = 0; i < 40; i += 1) {
    const c = makeCase(rand);
    const { range } = planFold(c);
    if (range === null) continue;
    produced += 1;
    t.eq(range.start <= range.end, true, `第 ${i + 1} 组区间反向：${range.start} > ${range.end}`);
    t.eq(c.seqs.includes(range.start), true, `第 ${i + 1} 组 start ${range.start} 不在 surface 里`);
    t.eq(c.seqs.includes(range.end), true, `第 ${i + 1} 组 end ${range.end} 不在 surface 里`);
  }
  t.eq(produced > 0, true, "随机用例必须至少产生一次可折叠区间（否则判据空转）");
};

tests["C127-3 常规路径不越门槛：返回区间时被折叠 tokens 必须 ≥ minFoldTokens"] = (t) => {
  const rand = rng(99);
  let checked = 0;
  for (let i = 0; i < 40; i += 1) {
    const c = makeCase(rand);
    if (c.overflow) continue; // 溢出路径按设计绕过门槛
    const { range } = planFold(c);
    if (range === null) continue;
    checked += 1;
    const folded = tokensBetween(c.priced, range.start, range.end);
    t.eq(folded >= c.minFoldTokens, true, `第 ${i + 1} 组只折了 ${folded} tokens，低于门槛 ${c.minFoldTokens}`);
  }
  t.eq(checked > 0, true, "至少要有一个常规路径样本被检查");
};

tests["C127-4 幂等：同输入两次必须逐字节相同（可重放）"] = (t) => {
  const rand = rng(1234);
  for (let i = 0; i < 20; i += 1) {
    const c = makeCase(rand);
    const a = JSON.stringify(planFold(c));
    const b = JSON.stringify(planFold(c));
    t.eq(a, b, `第 ${i + 1} 组不幂等`);
  }
};

tests["C127-5 溢出只会更宽松：常规能折时溢出必须也能折，且起点不晚于常规"] = (t) => {
  const rand = rng(424242);
  let pairs = 0;
  for (let i = 0; i < 40; i += 1) {
    const c = makeCase(rand);
    const normal = planFold({ ...c, overflow: false });
    if (normal.range === null) continue;
    const rescue = planFold({ ...c, overflow: true });
    pairs += 1;
    t.eq(rescue.range !== null, true, `第 ${i + 1} 组常规能折、溢出却不能折（溢出应更宽松）`);
    t.eq(rescue.range.start <= normal.range.start, true, `第 ${i + 1} 组溢出起点 ${rescue.range.start} 晚于常规 ${normal.range.start}`);
  }
  t.eq(pairs > 0, true, "至少要有一次「常规可折」的对照");
};

/** 更容易产生「可折叠区间」的用例生成器（minFold 小、节点更大）—— 用于尾部保留量的判据。 */
function makeCaseFoldable(rand) {
  const n = 4 + Math.floor(rand() * 7); // 4..10
  const seqs = [];
  let seq = 1;
  for (let i = 0; i < n; i += 1) {
    seqs.push(seq);
    seq += 1;
  }
  const priced = seqs.map((x) => ({ seq: x, tokens: 400 + Math.floor(rand() * 2100), heuristicTokens: 0 }));
  const eventAt = () => ({ type: "user/message" });
  return {
    surfaceNodes: seqs,
    pricedNodes: priced,
    eventAt,
    retainTokens: [0, 500, 2000][Math.floor(rand() * 3)],
    minFoldTokens: [0, 200][Math.floor(rand() * 2)],
    overflow: false,
    seqs,
    priced,
  };
}

tests["C128 尾部保留量不超界：常规折叠后未折的尾巴 ≤ retainTokens + 单个最大节点"] = (t) => {
  // 规划器从尾部按 retainTokens 累积，允许「最后多加一个节点」，所以上界是 retain + maxNode。
  const rand = rng(31415);
  let checked = 0;
  for (let i = 0; i < 40; i += 1) {
    const c = makeCaseFoldable(rand);
    const { range } = planFold(c);
    if (range === null) continue;
    checked += 1;
    const tail = c.priced.filter((p) => p.seq > range.end).reduce((sum, p) => sum + p.tokens, 0);
    const maxNode = Math.max(...c.priced.map((p) => p.tokens));
    t.eq(tail <= c.retainTokens + maxNode, true, `第 ${i + 1} 组尾部保留 ${tail} 超过上界 ${c.retainTokens + maxNode}（retain=${c.retainTokens}）`);
  }
  t.eq(checked >= 8, true, `至少要检查 8 个可折叠样本，实际 ${checked}（否则判据样本不足）`);
};

tests["C174 规划器在 1,500 节点量级：必须给出合法区间、尾部不超界、耗时受控"] = (t) => {
  // live 最大会话约 1.4k 节点 —— 决策路径必须在这个量级上仍然「快且不越界」。
  const N = 1500;
  const surfaceNodes = [];
  const pricedNodes = [];
  const eventAt = new Map();
  for (let i = 1; i <= N; i += 1) {
    const isTool = i % 5 === 0;
    const kind = isTool ? "assistant/tool-call" : i % 5 === 1 ? "user/message" : "assistant/message";
    const ev = {
      type: "session/event",
      seq: i,
      data: isTool
        ? { call: { id: `c${i}`, name: "bash", arguments: { command: `cmd${i}` } } }
        : { source: { kind: "prompt" }, content: [{ type: "text", text: `第 ${i} 步` }] },
    };
    surfaceNodes.push(i);
    pricedNodes.push({ seq: i, tokens: isTool ? 40 : 120, kind });
    eventAt.set(i, ev);
  }
  // 末尾留一段「不压」的尾部：retainTokens 越小，区间端点越靠前
  const started = Date.now();
  const out = planFold({
    surfaceNodes,
    pricedNodes,
    eventAt: (seq) => eventAt.get(seq),
    retainTokens: 6000,
    minFoldTokens: 1000,
  });
  const ms = Date.now() - started;
  t.eq(out.reason, "ok", `1,500 节点必须能规划出区间（reason=${out.reason}）`);
  t.eq(ms < 2000, true, `规划耗时 ${ms}ms 异常偏慢（1,500 节点）`);
  const { start, end } = out.range;
  t.eq(start >= 1 && end <= N, true, `区间必须落在 [1,${N}]，实际 ${start}–${end}`);
  t.eq(start <= end, true, `区间反向：${start}–${end}`);
  // 尾部保留量不许超 retainTokens 太多（一个节点 + 一个工具对）
  let tailTokens = 0;
  for (const p of pricedNodes) if (p.seq > end) tailTokens += p.tokens;
  t.eq(tailTokens <= 6000 + 2 * 120 + 2, true, `尾部保留 ${tailTokens} tokens 超界（retain=6000）`);
  // overflow 模式：尾部保留为 0 ⇒ 区间必须直接吃到末尾
  const ovf = planFold({ surfaceNodes, pricedNodes, eventAt: (seq) => eventAt.get(seq), retainTokens: 6000, minFoldTokens: 1000, overflow: true });
  if (ovf.reason === "ok") t.eq(ovf.range.end >= N - 1, true, `overflow 区间应接近末尾，实际 end=${ovf.range.end}`);
};
