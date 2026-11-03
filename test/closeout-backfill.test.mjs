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

tests["C297 补账要能接受「分段收尾」的返回形状（{tier:'chunked', folded}）而不崩"] = async (t) => {
  const mod = await import("../src/rooms/closeout-backfill.mjs");
  const calls = [];
  const registry = {
    archivedSessionIds: ["s1"],
    unarchiveSession: async (id) => calls.push(["unarchive", id]),
    archiveSession: async (id) => calls.push(["archive", id]),
  };
  // C289 之后，大尾巴走分段：closeout 可能返回 {tier:"chunked", folded, chunks}
  const result = await mod.backfillArchivedSessions({
    items: [{ sessionId: "s1", tail: 20000 }],
    registry,
    resolveAgent: async (id) => {
      calls.push(["resolve", id]);
      return { session: { id } };
    },
    closeout: async () => {
      calls.push(["closeout"]);
      return { tier: "chunked", folded: 3, chunks: 6 };
    },
    dryRun: false,
  });
  t.eq(calls.map((c) => c[0]), ["unarchive", "resolve", "closeout", "archive"], `顺序必须是 取消归档 → resume → 收尾 → 归档回去：${JSON.stringify(calls)}`);
  t.eq(result.done, 1, `应当完成 1 个：${JSON.stringify(result)}`);
  t.eq(result.failed ?? 0, 0, `分段收尾不该被当成失败：${JSON.stringify(result)}`);
  t.eq(result.restored, 1, "收尾后必须归档回去");
};

tests["C299 「折过了」要认分段收尾（closeout.chunkedFolded），否则与 doctor 口径分裂"] = async (t) => {
  const mod = await import("../src/rooms/closeout-backfill.mjs");
  const base = {
    nodes: { n1: { seq: 100 } },
    foldMarks: [{ seqStart: 0, seqEnd: 50, shadowedTokens: 1000, trigger: "pressure" }],
    closeout: { at: 1, chunkedFolded: 3 },
  };
  t.eq(mod.debtOfGraph(base).folded, true, "只有 closeout.chunkedFolded 也必须算折过");
  t.eq(mod.debtOfGraph({ ...base, closeout: { at: 1 } }).folded, false, "没有分段数、也没有 archive foldMark ⇒ 不算折过");
};

tests["C515 欠账必须按 foldMarks 算，不许按 lastFoldSeq —— 两者在真机上会差两千事件"] = async (t) => {
  // 真机样本（a09a4535，2026-11-04）：会话跑到 5862，最后一次折叠**区间**只到 1874，
  // 而 `lastFoldSeq` 记的是「那次折叠时会话的 seq」= 3544。用 lastFoldSeq 算尾巴会漏掉 1670 个事件。
  const g = mkGraph({
    seqs: [1, 1874, 3544, 5862],
    marks: [
      { seqStart: 8, seqEnd: 340, trigger: "pressure" },
      { seqStart: 343, seqEnd: 1874, trigger: "pressure" },
    ],
  });
  g.lastFoldSeq = 3544; // 诱饵：真机上它就是这么写的
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.lastFoldSeq, 1874, "欠账起点必须取 foldMark.seqEnd");
  t.eq(debt.tail, 5862 - 1874, `尾巴必须按 foldMark 算（实际 ${debt.tail}）`);
  t.eq(debt.tail > 1000, true, "这条会话确实还有一大截没折");
};

tests["C515 foldMarks 为空但 lastFoldSeq 有值 ⇒ 仍然算欠账（不许被那个字段骗过去）"] = async (t) => {
  const g = mkGraph({ seqs: [1, 3000] });
  g.lastFoldSeq = 2900; // 诱导：看起来"刚折过"
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.lastFoldSeq, null, "没有 foldMark 就没有折叠区间");
  t.eq(debt.tail >= 2999, true, `没折过就该整段欠着（实际 ${debt.tail}）`);
};

tests["C518 补账以图上的结局为准：调用成功 ≠ 真的折了"] = async (t) => {
  const calls = [];
  const report = await runBackfill({
    items: [{ sessionId: "s1", tail: 100 }],
    resolveAgent: async () => ({ session: { id: "s1" } }),
    // 引擎返回"成功"，但图上写的是失败 —— 真机 c460d468 的形状
    closeout: async () => {
      calls.push("closeout");
      return { folded: true };
    },
    readGraph: () => ({ closeout: { folded: 0, chunkedFolded: 0, foldError: "Error: compactRegion: start seq 496 not found in surface" } }),
  });
  t.eq(calls.length, 1, "收尾要被调用一次");
  const r = report.results[0];
  t.eq(r.ok, true, "调用本身是成功的");
  t.eq(r.folded, false, "但图上没折成 ⇒ folded 必须是 false");
  t.eq(r.fromGraph, true, "要标明这个结论来自图");
  t.includes(String(r.foldError), "not found in surface", "失败原因要带出来，别只给个 false");
  t.eq(report.folded, 0, "汇总也不能虚报成功");
};

tests["C518 图上真折成了 ⇒ folded=true，并带 foldNote/partial"] = async (t) => {
  const report = await runBackfill({
    items: [{ sessionId: "s2", tail: 100 }],
    resolveAgent: async () => ({ session: { id: "s2" } }),
    closeout: async () => ({ folded: true }),
    readGraph: () => ({ closeout: { folded: 2, partial: true, foldOffline: true } }),
  });
  const r = report.results[0];
  t.eq(r.folded, true, "图上折了 2 段");
  t.eq(r.partial, true, "有缺口要带 partial");
  t.eq(r.foldOffline, true, "离线补折要能看出来");
  t.eq(report.folded, 1, "汇总计 1 个会话折成");
};

tests["C518 没给 readGraph ⇒ 退回旧行为（但记录不带 fromGraph）"] = async (t) => {
  const report = await runBackfill({
    items: [{ sessionId: "s3", tail: 100 }],
    resolveAgent: async () => ({ session: { id: "s3" } }),
    closeout: async () => ({ folded: true }),
  });
  const r = report.results[0];
  t.eq(r.folded, true, "旧行为保持不变");
  t.eq(r.fromGraph, undefined, "没有图就没有 fromGraph 标记");
};

tests["C519 离线补折留下的前段缺口也算欠账 —— 否则这个洞永久消失"] = async (t) => {
  const g = mkGraph({ seqs: [1, 9000], marks: [{ seqStart: 8000, seqEnd: 9000, trigger: "archive-offline" }] });
  g.closeout = { at: 1, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true, partial: true, offlineUncoveredHead: { from: 1, events: 7999 } };
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.tail, 0, "尾巴已经折干净");
  t.eq(debt.gapEvents, 7999, "但前段还欠着 7,999 个事件");
  t.eq(debt.due, true, "有洞就必须继续算欠账");
  t.eq(debt.gap.from, 1, "洞的起点要带出来");

  // 没有洞的老图不受影响
  const g2 = mkGraph({ seqs: [1, 100], marks: [{ seqStart: 1, seqEnd: 100, trigger: "archive" }] });
  g2.closeout = { at: 1, source: "archive", foldAttempted: true, folded: 1 };
  const d2 = debtOfGraph(g2, { minEvents: 40 });
  t.eq(d2.gapEvents, 0, "没有洞就是 0");
  t.eq(d2.due, false, "无洞无尾巴 ⇒ 不欠");
};

tests["C520 排序要算上前段缺口 —— 否则 tail=0 的会话永远排最后、永远轮不到"] = async (t) => {
  const items = [
    { sessionId: "small-tail", tail: 1200, gapEvents: 0 },
    { sessionId: "big-gap", tail: 0, gapEvents: 12000 },
    { sessionId: "mid", tail: 5000, gapEvents: 0 },
  ];
  const ranked = rankDebts(items, { limit: 3 });
  t.eq(ranked[0].sessionId, "big-gap", "缺口 12k 的必须排第一（tail+gap 最大）");
  t.eq(ranked[1].sessionId, "mid", "其次 5k");
  t.eq(ranked[2].sessionId, "small-tail", "最后才是 1.2k");
  const one = rankDebts(items, { limit: 1 });
  t.eq(one[0].sessionId, "big-gap", "只补一个时也必须先补缺口最大的");
};
