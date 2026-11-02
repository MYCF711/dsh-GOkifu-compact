/**
 * closeout-backfill.test.mjs —— 归档「补账」房间的回归（2026-11-02，C216）
 *
 * 判据三条：
 *   ① 债务口径必须与引擎写进图里的 `closeout.eventsSinceLastFold` **同源**
 *      （最大节点 seq − 最后一次 fold 的 seqEnd），否则面板与 doctor 会各说各话；
 *   ② 有 closeout 的会话不再算欠账（补过就翻篇），且「有 closeout 但没真折过」要能分辨；
 *   ③ 补账是串行、逐条回报：一条失败不许带走后面的，dry-run 不许调用模型。
 */

import { debtOfGraph, rankDebts, runBackfill, listDebts, backfillArchivedSessions } from "../src/rooms/closeout-backfill.mjs";

export const tests = {};

/** 造一张最小图：nodes 的 seq 决定 maxSeq。 */
function mkGraph({ seqs = [], marks = [], closeout } = {}) {
  const nodes = {};
  for (const [i, seq] of seqs.entries()) nodes[`n${i + 1}`] = { id: `n${i + 1}`, seq };
  const graph = { nodes, edges: {}, order: Object.keys(nodes), foldMarks: marks };
  if (closeout !== undefined) graph.closeout = closeout;
  return graph;
}

tests["C216 债务口径：没有 fold 过 ⇒ 尾巴 = 最大节点 seq；fold 过 ⇒ 尾巴 = 最大 seq − 最后 fold 的 seqEnd"] = (t) => {
  const never = debtOfGraph(mkGraph({ seqs: [1, 5, 12] }), { minEvents: 5 });
  t.eq(never.lastFoldSeq, null, "没 fold 过时 lastFoldSeq 必须是 null（不是 0）");
  t.eq(never.tail, 12, "没 fold 过 ⇒ 整段都是未压缩的尾巴");
  t.eq(never.due, true, "12 ≥ 5 ⇒ 欠账");

  const folded = debtOfGraph(mkGraph({ seqs: [1, 40, 90], marks: [{ seqStart: 1, seqEnd: 80, trigger: "pressure" }] }), { minEvents: 5 });
  t.eq(folded.lastFoldSeq, 80, "以最后一次 fold 的 seqEnd 为起点");
  t.eq(folded.tail, 10, "90 - 80 = 10");
  t.eq(folded.due, true, "10 ≥ 5 ⇒ 欠账");

  const small = debtOfGraph(mkGraph({ seqs: [1, 40, 90], marks: [{ seqStart: 1, seqEnd: 88, trigger: "pressure" }] }), { minEvents: 5 });
  t.eq(small.tail, 2, "88 → 90 只差 2");
  t.eq(small.due, false, "尾巴太小不算欠账（别为了 2 个事件花一次模型调用）");
};

tests["C216 补过就翻篇：有 closeout ⇒ 不算欠账，但「记了 closeout 却没真折过」要能分辨"] = (t) => {
  const closed = debtOfGraph(mkGraph({ seqs: [1, 999], closeout: { at: 1, eventsSinceLastFold: 999, source: "backfill" } }), { minEvents: 5 });
  t.eq(closed.closedOut, true, "必须看得出已经收过尾");
  t.eq(closed.due, false, "收过尾的会话不再欠账");
  t.eq(closed.folded, false, "只有 closeout 记录、没有 archive/backfill 折叠 ⇒ folded=false");

  const reallyFolded = debtOfGraph(
    mkGraph({ seqs: [1, 999], closeout: { at: 1 }, marks: [{ seqStart: 1, seqEnd: 900, trigger: "backfill" }] }),
    { minEvents: 5 },
  );
  t.eq(reallyFolded.folded, true, "有 trigger=backfill 的 foldMark ⇒ folded=true");
};

tests["C216 排序与限量：尾巴最大的先补，limit 生效"] = (t) => {
  const ranked = rankDebts(
    [
      { sessionId: "a", tail: 10 },
      { sessionId: "b", tail: 900 },
      { sessionId: "c", tail: 40 },
    ],
    { limit: 2 },
  );
  t.eq(ranked.length, 2, "limit 生效");
  t.eq(ranked[0].sessionId, "b", "最大的排最前");
  t.eq(ranked[1].sessionId, "c", "其次");
  t.eq(rankDebts([{ sessionId: "a", tail: 1 }], { limit: 0 }).length, 0, "limit=0 一个都不补");
};

tests["C216 补账串联：dry-run 不 resume、不调模型；失败的不带走后面的"] = async (t) => {
  let resolved = 0;
  let closed = 0;
  const dry = await runBackfill({
    items: [{ sessionId: "s1", tail: 500 }],
    resolveAgent: async () => {
      resolved += 1;
      return { agent: { session: { id: "s1" } } };
    },
    closeout: async () => {
      closed += 1;
      return { folded: true };
    },
    dryRun: true,
  });
  t.eq(resolved, 0, "dry-run 不许 resume（那是真加载 19MB 会话）");
  t.eq(closed, 0, "dry-run 不许调用模型");
  t.eq(dry.total, 1, "dry-run 也要回报会补哪些");
  t.eq(dry.results[0].skipped, "dry-run", "逐条标明是演练");

  const order = [];
  const real = await runBackfill({
    items: [
      { sessionId: "bad", tail: 900 },
      { sessionId: "ok", tail: 500 },
      { sessionId: "boom", tail: 400 },
    ],
    resolveAgent: async (id) => {
      order.push(`resume:${id}`);
      if (id === "bad") return { error: { message: "session not found" } };
      return { agent: { session: { id } } };
    },
    closeout: async (agent) => {
      order.push(`close:${agent.session.id}`);
      if (agent.session.id === "boom") throw new Error("provider 炸了");
      return { folded: true, eventsSinceLastFold: 500 };
    },
  });
  t.eq(order.join(","), "resume:bad,resume:ok,close:ok,resume:boom,close:boom", "必须串行，且失败后继续");
  t.eq(real.total, 3, "三条都有回报");
  t.eq(real.done, 1, "只有 ok 成功");
  t.eq(real.folded, 1, "只有 ok 真的折了");
  t.eq(real.failed, 2, "resume 失败 + 折叠抛错都算失败");
  t.eq(real.results[0].error, "session not found", "resume 失败要带原因");
  t.eq(real.results[2].error, "provider 炸了", "折叠抛错要带原因（不许静默）");
};

tests["C216 补账容错：没接线 / 没拿到 agent / 抛异常，都逐条回报而不是整批崩"] = async (t) => {
  const bare = await runBackfill({ items: [{ sessionId: "s1", tail: 100 }] });
  t.eq(bare.results[0].ok, false, "没接线必须报失败");
  t.includes(bare.results[0].error, "resolveAgent", "要说清缺哪个接线");

  const noAgent = await runBackfill({
    items: [{ sessionId: "s1", tail: 100 }],
    resolveAgent: async () => ({}),
    closeout: async () => ({ folded: true }),
  });
  t.eq(noAgent.results[0].ok, false, "resume 没给 agent 要算失败");
  t.includes(noAgent.results[0].error, "live agent", "错误文案要能指认原因");

  const thrown = await runBackfill({
    items: [{ sessionId: "s1", tail: 100 }],
    resolveAgent: async () => {
      throw new Error("host exploded");
    },
    closeout: async () => ({ folded: true }),
  });
  t.eq(thrown.results[0].ok, false, "resolveAgent 抛异常也必须被收住");
  t.eq(thrown.results[0].error, "host exploded", "原样带出原因");
};

tests["C216 列出债务清单：坏图/无图只跳过，不许让整批请求挂掉"] = (t) => {
  const graphs = {
    big: { nodes: { n1: { seq: 5000 } }, foldMarks: [] },
    small: { nodes: { n1: { seq: 3 } }, foldMarks: [] },
    done: { nodes: { n1: { seq: 900 } }, foldMarks: [], closeout: { at: 1 } },
  };
  const listed = listDebts({
    sessionIds: ["big", "small", "done", "missing", "boom"],
    minEvents: 40,
    limit: 10,
    loadGraph: (id) => {
      if (id === "boom") throw new Error("坏图");
      return graphs[id] ?? null;
    },
  });
  t.eq(listed.scanned, 5, "五个候选都扫过（坏图算扫过、不算欠账）");
  t.eq(listed.due, 1, "只有 big 真的欠账（small 尾巴太小、done 已收尾）");
  t.eq(listed.items.length, 1, "清单里只有 big");
  t.eq(listed.items[0].sessionId, "big", "清单项带 sessionId");
  t.eq(listed.items[0].tail, 5000, "清单项带尾巴大小（面板要显示它）");
};

tests["C216 补账一圈：取消归档 → resume → 收尾 → **原样归档回去**（失败也还原）"] = async (t) => {
  const archivedIds = ["a1", "a2"];
  const calls = [];
  const registry = {
    archivedSessionIds: archivedIds,
    async unarchiveSession(id) {
      calls.push("unarchive:" + id);
      const i = archivedIds.indexOf(id);
      if (i >= 0) archivedIds.splice(i, 1);
    },
    async archiveSession(id) {
      calls.push("archive:" + id);
      if (!archivedIds.includes(id)) archivedIds.push(id);
    },
  };
  const report = await backfillArchivedSessions({
    items: [
      { sessionId: "a1", tail: 900 },
      { sessionId: "a2", tail: 500 },
    ],
    registry,
    resolveAgent: async (id) => {
      if (id === "a2") throw new Error("resume failed");
      return { agent: { session: { id } } };
    },
    closeout: async (agent) => ({ folded: true, sessionId: agent.session.id }),
  });
  t.eq(calls.join(","), "unarchive:a1,archive:a1,unarchive:a2,archive:a2", "先取消归档、补完再归档回去；失败那条也要还原");
  t.eq(report.done, 1, "只有 a1 补成功");
  t.eq(report.restored, 2, "两条都回到了归档状态（a1 补完归档、a2 resume 失败也还原归档）");
  t.eq(archivedIds.sort().join(","), "a1,a2", "补完账后归档状态必须与开始时一致");
  t.eq(report.canCycle, true, "接上了 registry 就要回报 canCycle");
};

tests["C216 没接 registry 时退化成「只 resume 不收归档状态」：不假装自己能还原"] = async (t) => {
  const report = await backfillArchivedSessions({
    items: [{ sessionId: "x", tail: 100 }],
    registry: undefined,
    resolveAgent: async (id) => ({ agent: { session: { id } } }),
    closeout: async () => ({ folded: true }),
  });
  t.eq(report.canCycle, false, "没接线要如实说");
  t.eq(report.done, 1, "仍然把账补了");
  t.eq(report.restored, 0, "没接线就没有还原动作");
};

tests["C286 欠账估算：用本会话历史 tokens/事件 折算，没有历史就不编数字"] = async (t) => {
  const mod = await import("../src/rooms/closeout-backfill.mjs");

  // 有历史：两次 fold 各 100 事件 / 10000 token ⇒ 100 tok/事件
  const withHistory = {
    nodes: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`n${i}`, { seq: (i + 1) * 100 }])),
    foldMarks: [
      { seqStart: 0, seqEnd: 100, shadowedTokens: 10_000 },
      { seqStart: 100, seqEnd: 200, shadowedTokens: 10_000 },
    ],
  };
  const d = mod.debtOfGraph(withHistory);
  t.eq(d.tail, 300, `尾巴 = maxSeq 500 − 上次 fold 结尾 200：${d.tail}`);
  t.eq(Math.round(d.tokensPerEvent), 100, `比值该是 100 tok/事件：${d.tokensPerEvent}`);
  t.eq(d.estTokens, 30_000, `估算 = 300 × 100：${d.estTokens}`);

  // 没有历史 fold ⇒ 没有比值、也不许瞎估
  const noHistory = { nodes: { n1: { seq: 10 } }, foldMarks: [] };
  const d2 = mod.debtOfGraph(noHistory);
  t.eq(d2.tokensPerEvent, null, "没有 fold 历史 ⇒ 比值 null");
  t.eq(d2.estTokens, null, "没有 fold 历史 ⇒ 估算 null（不编数字）");
};
