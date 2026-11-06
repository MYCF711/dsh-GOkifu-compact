/**
 * retread.test.mjs —— 「重踩率」这个候选指标的度量守卫（T56）
 *
 * 为什么需要守卫：这个脚本的全部价值在**两个减法**上，两个都会静默地给出假绿 ——
 *   ① **「折叠之后」按 `evidence.start` 判，不按 `ts`**：
 *      归档补折（`archive-offline`）的摘要落盘时间比它折叠的事件晚几小时；
 *      按 `ts` 判会把**折叠之前**的失败算成「折叠之后的重踩」，
 *      重踩率立刻从 0.4% 涨到「随便多少」—— 而报告看起来完全正常。
 *   ② **分子是真实的后续失败边，不是摘要文本的子串**：
 *      摘要里有机械补回段（`## 已探明死路（逐字补充…）`），补回段里逐条写着死路 id；
 *      只要有人把分子写成「摘要里提到了死路 id 的数量」，补回跑过 ⇒ 分子恒等于死路数
 *      ⇒ 重踩率恒 = 1 ⇒ 与 T53 判死的 `failureRecall` **同一种死法**。
 *      这是本仓已经栽过五次的形状（可定位率 / A / B / 逐字可回查 / recall），
 *      所以这一条必须用「补回段写了、但折叠后没有失败边」的夹具**钉死**。
 *
 * 另外钉住四条判据的**可失败性**：判据 ① 必须能在「全部为 0」的池上返回 **不通过**。
 * 一个永远不会红的判据不是守卫，是假门禁（T54 的老教训）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉
//   （C641 的教训：具名导入缺符号 ⇒ 后面所有测试文件都不跑）。
import * as audit from "../scripts/retread-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";
import { actionSignature } from "../src/rooms/keeper.mjs";

export const tests = {};

const {
  CRITERIA_RULES,
  WINDOWS,
  strictKeyOf,
  looseKeyOf,
  markRetread,
  summarizeWindow,
  summarizeAttribution,
  judgeCriteria,
  injectionSeqsOf,
  turnSeqsOf,
  entitySeqsOf,
  windowEndFor,
  padDisplay,
  displayWidth,
  audit: scan,
  renderReport,
} = audit;

/* ───────────────────────────── 夹具 ───────────────────────────── */

const NOW = Date.now();

/** 造一张图：节点 + 边 + 折痕，全部显式给，不依赖任何默认值。 */
function makeGraph({ sessionId = "s-retread", nodes = [], edges = [], marks = [], lastOfflineSummary = null } = {}) {
  const g = createGraph({ sessionId, cwd: "E:/fixture" });
  g.nodes = {};
  g.order = [];
  for (const node of nodes) {
    g.nodes[node.id] = { kind: "agent", turn: null, text: "", ts: NOW, ...node };
    g.order.push(node.id);
  }
  g.edges = {};
  for (const edge of edges) {
    g.edges[edge.id] = {
      from: "n1",
      to: "n2",
      intent: "",
      result: "failure",
      action: "edit(file_path=E:/a.md)",
      verify: { kind: "none", summary: "" },
      errorSnippet: "Error: cannot modify",
      transposition: false,
      ts: NOW,
      ...edge,
    };
  }
  g.foldMarks = marks;
  g.lastOfflineSummary = lastOfflineSummary;
  return g;
}

/** 一条失败边（`evidence` 是 `{start,end}`；`sig` 可省）。 */
const fail = (id, start, { action = "edit(file_path=E:/a.md)", sig = null, end = start, ts = NOW } = {}) => ({
  id,
  result: "failure",
  action,
  ...(sig === null ? {} : { sig }),
  evidence: { start, end },
  ts,
});

/** 一条成功边（用来占位 / 造「折叠之前的死路」）。 */
const ok = (id, start, { action = "bash(command=npm test)", sig = null } = {}) => ({
  id,
  result: "success",
  action,
  ...(sig === null ? {} : { sig }),
  evidence: { start, end: start },
});

/** 一个折痕。 */
const markOf = (seqStart, seqEnd, extra = {}) => ({ at: NOW, seqStart, seqEnd, trigger: "pressure", ...extra });

const windowSpec = (key) => WINDOWS.find((item) => item.key === key);
/** 主口径（最宽）跑一行。 */
const runRow = (graph, mark, ctx = {}) => markRetread(graph, mark, { window: windowSpec("tail"), ...ctx });

/* ───────────────────────── ① 签名口径 ───────────────────────── */

tests["R-1 严格口径：sig 相同才算重踩；action 摘要相同但 sig 不同 ⇒ 只算宽松口径"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [
      // 两条**不同**的死路：e1 是「编辑 A」，e2 是「读 B」
      fail("e1", 20, { sig: "aaaa", action: "edit(file_path=E:/a.md)" }),
      fail("e2", 21, { sig: "bbbb", action: "read(file_path=E:/b.md)" }),
      // 折叠之后：e3 与 e1 **逐字相同**（sig 同）⇒ 严格口径重踩
      fail("e3", 300, { sig: "aaaa", action: "edit(file_path=E:/a.md)" }),
      // 折叠之后：e4 与 e2 的 action 摘要相同、但 args 不同（sig 不同）⇒ 只有宽松口径算
      fail("e4", 400, { sig: "cccc", action: "read(file_path=E:/b.md)" }),
    ],
    marks: [markOf(10, 25)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.measurable, true, "折叠后有后续事件 ⇒ 可测");
  t.eq(row.opportunities, 2, "区间内两种死路签名");
  t.eq(row.retreads, 1, "只有逐字相同的那一条算严格重踩");
  t.eq(row.retreadsLoose, 2, "宽松口径按 action 摘要算 ⇒ 两种都命中（上界）");
  t.eq(row.retreadRate, 0.5, "严格率 = 1/2");
  t.eq(row.retreadRateLoose, 1, "宽松上界 = 2/2");
};

tests["R-2 老边的天下：两边都没有 sig ⇒ 按 action 摘要回落，仍算重踩"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { action: "read(file_path=E:/x.md)" }), fail("e2", 300, { action: "read(file_path=E:/x.md)" })],
    marks: [markOf(10, 20)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.retreads, 1, "老边没有 sig，必须回落 action 摘要（否则 C446 之前的图全不可测）");
  t.eq(row.retreadsSig, 0, "纯 sig 子集 = 0（这条要能在报告里单列）");
};

tests["R-3 世代替换：死路带 sig、后来的失败没有 sig（或反之）⇒ 严格口径不算重踩"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    // e1 有 sig，e2 没有 —— 参数全文已不可得，不能假装「同一动作」
    edges: [fail("e1", 20, { sig: "cccc" }), fail("e2", 300, { sig: null })],
    marks: [markOf(10, 20)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.retreads, 0, "严格口径宁可不匹配：老边不能与指纹边互证");
  t.eq(row.retreadsLoose, 1, "宽松口径能匹配（上界），报告里单列");
  t.eq(strictKeyOf({ sig: "cccc", action: "x" }) === strictKeyOf({ action: "x" }), false, "两代键空间必须不同");
};

tests["R-4 actionSignature 是唯一签名来源（同 action ⇒ 同键，不同工具名 ⇒ 不同键）"] = (t) => {
  const a = looseKeyOf({ action: "bash(command=ls)" });
  const b = looseKeyOf({ action: "bash(command=ls)" });
  const c = looseKeyOf({ action: "edit(command=ls)" });
  t.eq(a, b, "同 action 摘要 ⇒ 同键");
  t.ne(a, c, "工具名不同 ⇒ 键必须不同");
  t.includes(a, actionSignature("bash(command=ls)", {}), "键里用的就是仓库那个 actionSignature");
};

/* ───────────────────────── ② 折叠后的判定 ───────────────────────── */

tests["R-5 折叠之后按 evidence.start 判，不按 ts（归档补折的 ts 会晚几小时）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [
      fail("e1", 150, { sig: "aaaa" }),
      // 证据在折叠区间**之前**，但 ts 很新（补折/重放）⇒ 不许算重踩
      fail("e2", 90, { sig: "aaaa", ts: NOW + 10 ** 7 }),
      // 证据在折叠之后，但 ts 很老 ⇒ 必须算重踩
      fail("e3", 300, { sig: "aaaa", ts: 1 }),
    ],
    marks: [markOf(100, 200)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.deadEnds, 1, "区间内的死路只有 e1（e2 的 evidence 在区间外）");
  t.eq(row.postFailures, 1, "折叠后的失败边只有 e3（e2 的 evidence 在之前）");
  t.eq(row.retreads, 1, "按 ts 判会把 e2 算进来、把 e3 漏掉 —— 这里必须只认 e3");
  t.eq(row.retreadIds, ["e1"], "重踩的死路 id");
};

tests["R-6 死路必须过生产口径：rewash 残留（无 to 且陈旧）不算死路"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [
      fail("e1", 20, { sig: "aaaa" }),
      // 残留：to 为 null 且 ts 是两小时前
      { ...fail("e2", 21, { sig: "zzzz" }), to: null, ts: NOW - 2 * 60 * 60 * 1000 },
    ],
    marks: [markOf(10, 30)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.deadEnds, 1, "残留边必须被 isDanglingResidue 排除（否则分母虚高）");
};

/* ───────────────────────── ③ 观察窗口 ───────────────────────── */

tests["R-7 窗口「到下一次折叠提交」：下一次折叠 seqEnd 之后的重踩不算"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 50 },
      { id: "n3", kind: "agent", seq: 300 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20), markOf(101, 200)],
  });
  const row = markRetread(g, g.foldMarks[0], { window: windowSpec("until-next-fold"), foldEnds: [20, 200] });
  t.eq(row.windowEnd, 200, "右边界 = 下一次折叠的 seqEnd");
  t.eq(row.postFailures, 0, "重踩发生在 300 > 200 ⇒ 不在窗口内");
  t.eq(row.retreads, 0, "窗口外的重踩不算");
  // 换最宽窗口就必须算
  const wide = runRow(g, g.foldMarks[0]);
  t.eq(wide.retreads, 1, "最宽窗口能看见它（说明窗口真的在切，不是恒 0）");
};

tests["R-8 窗口「折叠后 N 个人类轮次」：超出第 N 个用户消息的重踩不算"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "user", seq: 100 },
      { id: "n3", kind: "user", seq: 200 },
      { id: "n4", kind: "user", seq: 300 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 250, { sig: "aaaa" })],
    marks: [markOf(10, 20)],
  });
  const turns = turnSeqsOf(g);
  t.eq(turns, [10, 100, 200, 300], "轮次边界只认 kind=user 的节点");
  t.eq(markRetread(g, g.foldMarks[0], { window: windowSpec("turn-1"), turns }).retreads, 0, "1 轮窗口止于 seq 100");
  t.eq(markRetread(g, g.foldMarks[0], { window: windowSpec("turn-3"), turns }).retreads, 1, "3 轮窗口止于 seq 300 ⇒ 含 250");
};

tests["R-9 轮次不足 N ⇒ 右删失（窗口开到尾部，且记 censored）"] = (t) => {
  const { end, censored } = windowEndFor({ turnsAfter: [100], foldEndAfter: null, spec: windowSpec("turn-3") });
  t.eq(end, Number.POSITIVE_INFINITY, "不足 3 轮 ⇒ 右边界为 +∞");
  t.eq(censored, true, "必须记删失（报告里单列，别让读者以为观测满 3 轮）");
};

tests["R-10 右删失：折叠之后一个图实体都没有 ⇒ measurable=false、率是 null（不是 0）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" })],
    marks: [markOf(10, 20)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.measurable, false, "折叠后没有任何后续事件 ⇒ 不可测");
  t.eq(row.retreadRate, null, "**不许拿 0 冒充缺测**（Number(null)===0 是本仓踩过的坑）");
  t.includes(row.why, "右删失", "要说明为什么不可测");
};

tests["R-11 区间内没有失败边 ⇒ 率是 null（不是 100%，也不是 0%）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 200 },
    ],
    edges: [ok("e1", 20)],
    marks: [markOf(10, 20)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.deadEnds, 0, "区间里没有死路");
  t.eq(row.retreadRate, null, "没有可重踩机会 ⇒ 比例无定义");
  t.eq(row.measurable, false, "不计入分母");
};

/* ───────────────────────── ④ 去重与分母 ───────────────────────── */

tests["R-12 同一死路重踩 5 次只记 1 次机会 + 1 次重踩（防死循环把率拉满）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [
      fail("e1", 20, { sig: "aaaa" }),
      fail("e2", 21, { sig: "aaaa" }), // 区间内重复
      fail("e3", 300, { sig: "aaaa" }),
      fail("e4", 301, { sig: "aaaa" }),
      fail("e5", 302, { sig: "aaaa" }),
      fail("e6", 303, { sig: "aaaa" }),
      fail("e7", 304, { sig: "aaaa" }),
    ],
    marks: [markOf(10, 25)],
  });
  const row = runRow(g, g.foldMarks[0]);
  t.eq(row.opportunities, 1, "死路签名去重 ⇒ 1");
  t.eq(row.retreads, 1, "重踩也去重 ⇒ 1");
  t.eq(row.retreadRate, 1, "率 = 1（不是 5）");
  t.eq(row.postFailures, 5, "折后失败边仍然数满 5 条（另一个视角不丢）");
};

/* ───────────────────────── ⑤ 归因 ───────────────────────── */

tests["R-13 归因：摘要写了 + 注入可证 ⇒ 记「摘要的错」；没写 + 注入不可证 ⇒ 记「冤枉」"] = (t) => {
  // ① 摘要里写了 e1（独立标识符），重踩前有 compact-checkpoint
  const listed = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20, { summaryText: "## 已探明死路\n- e1 「edit」→ 文件不存在" })],
  });
  listed.lastOfflineSummary = null;
  const rowListed = runRow(listed, listed.foldMarks[0], { injection: [{ seq: 250, kind: "compact-checkpoint" }] });
  t.eq(rowListed.attribution.strict.injectedListed, 1, "写了 + 注入可证 ⇒ 摘要的错");
  t.eq(rowListed.attribution.strict.exonerated ?? 0, 0, "不算冤枉");

  // ② 摘要里**没有** e1，且没有任何注入证据
  const unlisted = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20, { summaryText: "## 目标\n做点别的（没写死路）" })],
  });
  unlisted.lastOfflineSummary = null;
  const rowUnlisted = runRow(unlisted, unlisted.foldMarks[0], { injection: [] });
  t.eq(rowUnlisted.attribution.strict.uninjectedUnlisted, 1, "没写 + 注入不可证 ⇒ **冤枉**（不算摘要的错）");
  t.eq(rowUnlisted.attribution.strict.unlisted, 1, "同时要计入「漏写率」的分子");
};

tests["R-14 e1 不许匹配 e12（与 mentionsEdge 同一判据）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e12", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20, { summaryText: "见 e12 那条" })],
  });
  g.lastOfflineSummary = null;
  const row = runRow(g, g.foldMarks[0], { injection: [] });
  t.eq(row.attribution.strict.unknown, 0, "摘要可解析");
  t.eq(row.attribution.strict.listed, 0, "只写了 e12 不等于写了 e1 —— 否则漏写率会被系统性低估");
  t.eq(row.attribution.strict.unlisted, 1, "e1 属于「没写」");
};

tests["R-15 摘要正文取不到 ⇒ 写没写记「不可判」，不记「没写」"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20)],
  });
  const row = runRow(g, g.foldMarks[0], { injection: [] });
  t.eq(row.summaryAvailable, false, "没有 summaryText / lastOfflineSummary");
  t.eq(row.attribution.strict.unknown, 1, "必须记 unknown");
  t.eq(row.attribution.strict.unlisted, 0, "**不许**拿「没写」冒充缺测");
};

tests["R-16 注入证据：只认 user/message 的两种 kind，且两代事件形状都吃"] = (t) => {
  const events = [
    { type: "user/message", seq: 100, data: { source: { kind: "compact-checkpoint" } } },
    { type: "user/message", seq: 200, message: { source: { kind: "chess-context" } } },
    { type: "assistant/message", seq: 300, data: { source: { kind: "compact-checkpoint" } } },
    { type: "user/message", seq: 400, data: { source: { kind: "user" } } },
    { type: "user/message", seq: "bad", data: { source: { kind: "chess-context" } } },
  ];
  const seqs = injectionSeqsOf(events);
  t.eq(seqs.length, 2, "只认这 2 条（assistant 的、普通 user 的、坏 seq 的都不算）");
  t.eq(seqs.map((item) => item.seq), [100, 200], "按 seq 升序");
  t.eq(injectionSeqsOf(null), null, "**没解出日志给 null，不是空数组**（空数组 = 确实没有注入）");
};

tests["R-17 注入必须发生在「折叠之后、重踩之前」"] = (t) => {
  const build = (injection) => {
    const g = makeGraph({
      nodes: [
        { id: "n1", kind: "user", seq: 10 },
        { id: "n2", kind: "agent", seq: 20 },
      ],
      edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
      marks: [markOf(10, 20, { summaryText: "e1 那条死路" })],
    });
    g.lastOfflineSummary = null;
    return runRow(g, g.foldMarks[0], { injection });
  };
  t.eq(build([{ seq: 250, kind: "compact-checkpoint" }]).attribution.strict.injectedListed, 1, "折叠后、重踩前 ⇒ 可证");
  t.eq(build([{ seq: 15, kind: "compact-checkpoint" }]).attribution.strict.uninjectedListed, 1, "折叠**之前**的注入不算");
  t.eq(build([{ seq: 900, kind: "compact-checkpoint" }]).attribution.strict.uninjectedListed, 1, "重踩**之后**的注入不算");
};

/* ───────────────────────── ⑥ 四条判据（必须能红） ───────────────────────── */

/** 造一个 judgeCriteria 能吃的 result 骨架。 */
function fakeResult({ rates = [], correlations = {}, pools = null } = {}) {
  const values = rates.filter((value) => Number.isFinite(value));
  const counts = new Map();
  for (const value of values) counts.set(value.toFixed(6), (counts.get(value.toFixed(6)) ?? 0) + 1);
  let modal = null;
  for (const [key, count] of counts) if (modal === null || count > modal.count) modal = { value: Number(key), count };
  return {
    window: WINDOWS[0],
    windows: {
      [WINDOWS[0].key]: {
        n: values.length,
        modalValue: modal === null ? null : modal.value,
        modalShare: values.length === 0 ? null : modal.count / values.length,
      },
    },
    correlations: {
      tailGap: correlations.tailGap ?? { n: 0, spearman: null },
      span: correlations.span ?? { n: 0, spearman: null },
      traceableShare: correlations.traceableShare ?? { n: 0, spearman: null },
      qualityTotal: correlations.qualityTotal ?? { n: 0, spearman: null },
    },
    attributionBySummaryAvailability: pools,
  };
}

tests["R-18 判据 ① 在「全部为 0」的池上必须返回**不通过**（假绿防线）"] = (t) => {
  const flat = judgeCriteria(fakeResult({ rates: Array.from({ length: 100 }, () => 0) }));
  t.eq(flat[0].pass, false, "100% 恒为 0 ⇒ 必须判不过");
  t.eq(flat[0].value, 1, "众数占比 = 1");
  const spread = judgeCriteria(fakeResult({ rates: [0, 0, 1, 0.5, 0, 1, 0.25, 0.75, 0, 0] }));
  t.eq(spread[0].pass, true, "有方差（众数占比 60% < 80%）⇒ 通过");
};

tests["R-19 判据 ②③ 在无方差时被标成「退化通过」，不冒充支持"] = (t) => {
  const criteria = judgeCriteria(
    fakeResult({
      rates: Array.from({ length: 10 }, () => 0),
      correlations: { tailGap: { n: 10, spearman: 0.01 }, span: { n: 10, spearman: -0.02 } },
    }),
  );
  t.eq(criteria[1].pass, true, "|ρ| 小 ⇒ 数字上通过");
  t.eq(criteria[1].degenerate, true, "但必须标退化（常函数的 ρ 不可信）");
  const strong = judgeCriteria(
    fakeResult({
      rates: [0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
      correlations: {
        tailGap: { n: 10, spearman: 0.9 },
        span: { n: 10, spearman: 0.8 },
        traceableShare: { n: 10, spearman: 0.95 },
        qualityTotal: { n: 10, spearman: 0.85 },
      },
    }),
  );
  t.eq(strong[1].pass, false, "|ρ| ≥ 0.2 ⇒ 判据 ② 必须红（它是形状的影子）");
  t.eq(strong[2].pass, false, "ρ ≥ 0.8 ⇒ 判据 ③ 必须红（和已有指标是同一个东西）");
};

tests["R-20 判据 ④ 的经验对照：两个池的率都要报出来"] = (t) => {
  const criteria = judgeCriteria(
    fakeResult({ rates: [0, 0, 1], pools: { available: { n: 2, opportunities: 10, rate: 0.1 }, unavailable: { n: 1, opportunities: 5, rate: 0.2 } } }),
  );
  t.eq(criteria[3].pass, true, "④ 永远是设计保证（分子不含文本）");
  t.includes(criteria[3].detail, "可解析池", "必须把两池的经验对照写进 detail");
  t.includes(criteria[3].detail, "不可解析池", "两池都要给（只给一个就是挑好看的）");
};

/* ───────────────────────── ⑦ 汇总 ───────────────────────── */

tests["R-21 汇总：机会数与重踩数都从行里加出来，率 = 重踩 / 机会（不是逐条平均）"] = (t) => {
  const rows = [
    { window: "tail", measurable: true, opportunities: 1, retreads: 1, retreadsLoose: 1, postFailures: 3, retreadRate: 1, deadEnds: 1, controlOpportunities: 0, controlRetreads: 0 },
    { window: "tail", measurable: true, opportunities: 9, retreads: 0, retreadsLoose: 0, postFailures: 1, retreadRate: 0, deadEnds: 9, controlOpportunities: 0, controlRetreads: 0 },
  ];
  const group = summarizeWindow(rows, WINDOWS[0]);
  t.eq(group.opportunities, 10, "机会数池化");
  t.eq(group.retreads, 1, "重踩数池化");
  t.eq(group.rate, 0.1, "池化率 = 1/10（**不是**逐条均值的 0.5）");
  t.eq(group.modalShare, 0.5, "众数占比按折痕级取值算");
};

tests["R-22 归因汇总：冤枉 = 两个「注入不可证」桶，blameRate 只在有重踩时定义"] = (t) => {
  const rows = [
    {
      window: "tail",
      measurable: true,
      summaryAvailable: true,
      deadEnds: 2,
      deadJudged: 2,
      deadListed: 1,
      attribution: {
        strict: { retreads: 2, listed: 1, unlisted: 1, unknown: 0, injectedListed: 1, injectedUnlisted: 0, uninjectedListed: 0, uninjectedUnlisted: 1, injectionUnknown: 0, detail: [] },
        loose: { retreads: 2, listed: 1, unlisted: 1, unknown: 0, injectedListed: 1, injectedUnlisted: 0, uninjectedListed: 0, uninjectedUnlisted: 1, injectionUnknown: 0, detail: [] },
      },
    },
  ];
  const summary = summarizeAttribution(rows);
  t.eq(summary.strict.blamed, 1, "只有「写了+注入可证」算摘要的错");
  t.eq(summary.strict.exonerated, 1, "冤枉 = 注入不可证的那条");
  t.eq(summary.strict.blameRate, 0.5, "blameRate = 1/2");
  t.eq(summary.missingRate, 0.5, "漏写率 = 1/2（另一个指标，别和重踩率混）");
  const empty = summarizeAttribution([]);
  t.eq(empty.strict.blameRate, null, "没有重踩 ⇒ 比例无定义（不是 0）");
};

/* ───────────────────────── ⑧ 端到端 ───────────────────────── */

/** 造一个临时 home（一张图 + 一条会话日志）。 */
function makeHome({ withLog = true } = {}) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "retread-home-"));
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const graphDir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(graphDir, { recursive: true });
  const graph = makeGraph({
    sessionId,
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 20 },
      { id: "n3", kind: "agent", seq: 300 },
    ],
    edges: [fail("e1", 20, { sig: "aaaa" }), fail("e2", 300, { sig: "aaaa" })],
    marks: [markOf(10, 20, { summaryText: "## 已探明死路\n- e1 「edit」→ 文件不存在" })],
  });
  graph.lastOfflineSummary = null;
  nodeFs.writeFileSync(nodePath.join(graphDir, "graph.json"), JSON.stringify(graph, null, 1));

  if (withLog) {
    const logDir = nodePath.join(home, "sessions", "cwd-hash");
    nodeFs.mkdirSync(logDir, { recursive: true });
    const events = [
      { type: "user/message", seq: 100, data: { source: { kind: "compact-checkpoint" } } },
      { type: "assistant/message", seq: 200, data: {} },
    ];
    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    nodeFs.writeFileSync(nodePath.join(logDir, `${sessionId}.zstd`), nodeZlib.zstdCompressSync(Buffer.from(text)));
  }
  return { home, sessionId };
}

tests["R-23 端到端：扫一张真图，汇总与明细对得上，报告里四条判据都在"] = (t) => {
  const { home } = makeHome({ withLog: false });
  try {
    const result = scan({ home, logs: "none" });
    t.eq(result.graphs, 1, "读到 1 张图");
    t.eq(result.marks, 1, "1 条折痕");
    const primary = result.windows[result.window.key];
    t.eq(primary.opportunities, 1, "1 个可重踩机会");
    t.eq(primary.retreads, 1, "1 次重踩");
    t.eq(primary.rate, 1, "重踩率 100%（单条夹具）");
    t.eq(result.criteria.length, 4, "四条判据都要在");
    t.eq(result.verdict, "unusable", "单条夹具的重踩率 100% ⇒ 众数占比 100% ⇒ 判据 ① 不过 ⇒ 必须判不能用");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["R-24 端到端：判据 ① 不过 ⇒ verdict 必须是 unusable（守卫不能永远绿）"] = (t) => {
  const { home } = makeHome({ withLog: false });
  try {
    const result = scan({ home, logs: "none" });
    t.eq(result.criteria[0].pass, false, "单条折痕率 = 100% ⇒ 众数占比 100% > 80% ⇒ 判据 ① 红");
    t.eq(result.verdict, "unusable", "**verdict 必须跟着红**");
    const text = renderReport(result);
    t.includes(text, "不能用", "报告必须给结论");
    t.includes(text, "判据 ①", "报告必须逐条列判据");
    t.includes(text, "## ④ N 的选择与稳定性", "报告必须给窗口稳定性");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["R-25 端到端：会话日志被读进来 ⇒ 注入维度可证（含 `session-` 前缀目录）"] = (t) => {
  const { home, sessionId } = makeHome({ withLog: true });
  try {
    const result = scan({ home, logs: "all" });
    t.eq(result.logs.sessions, 1, "日志必须被解出来（否则注入维度整批记 no-log）");
    const row = result.rows.find((item) => item.window === result.window.key);
    t.eq(row.attribution.strict.injectedListed, 1, "折叠后、重踩前的 compact-checkpoint ⇒ 注入可证");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  // 归档会话的目录名是 `session-<uuid>`，日志索引的键是裸 uuid —— 这条钉住那个前缀修复。
  const archived = makeHome({ withLog: true });
  try {
    const from = nodePath.join(archived.home, "chess-context", "sessions", archived.sessionId);
    const to = nodePath.join(archived.home, "chess-context", "sessions", `session-${archived.sessionId}`);
    nodeFs.renameSync(from, to);
    const result = scan({ home: archived.home, logs: "all" });
    t.eq(result.logs.sessions, 1, "`session-<uuid>` 目录也必须找得到日志");
  } finally {
    nodeFs.rmSync(archived.home, { recursive: true, force: true });
  }
};

tests["R-26 五个窗口**全部**算过 —— 不是只有主口径有数（第一版的假绿）"] = (t) => {
  const { home } = makeHome({ withLog: false });
  try {
    const result = scan({ home, logs: "none" });
    t.eq(Object.keys(result.windows).length, WINDOWS.length, "每个窗口都要有一组数");
    for (const spec of WINDOWS) {
      const group = result.windows[spec.key];
      t.ok(group.marks >= 1, `窗口 ${spec.key} 必须至少算过 1 条折痕（实际 ${group.marks}）`);
    }
    // 最宽的窗口必须能看见重踩；更窄的窗口允许看不见 —— 但「看不见」要是**算出来的 0**，不是没算
    t.eq(result.windows.tail.retreads, 1, "最宽窗口看见 1 次重踩");
    t.eq(result.windows["turn-1"].censored, 1, "该夹具折叠后没有人类消息 ⇒ 记右删失");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["R-27 报告里的表格按显示宽度对齐（CJK 不会把列挤歪）"] = (t) => {
  t.eq(displayWidth("abc"), 3, "ASCII 1 格");
  t.eq(displayWidth("中文"), 4, "CJK 2 格");
  t.eq(displayWidth(padDisplay("中文", 10)), 10, "补到 10 格");
  t.eq(displayWidth(padDisplay("abc", 10, "right")), 10, "右对齐也补到 10 格");
  t.includes(padDisplay("中文", 6), "中文", "内容不许被截断");
};

/* ───────────────────────── ⑨ 纯函数边界 ───────────────────────── */

tests["R-28 坏折痕/坏图不许让整份报告崩（本仓体检脚本的老规矩）"] = (t) => {
  const g = makeGraph({ nodes: [{ id: "n1", kind: "user", seq: 10 }], edges: [], marks: [{ at: 1 }, markOf(10, 20)] });
  const rows = g.foldMarks.map((mark, index) => runRow(g, mark, { index }));
  t.eq(rows[0].measurable, false, "没有 seq 区间 ⇒ 不可测");
  t.includes(rows[0].why, "seq 区间缺失", "要说清楚为什么");
  t.eq(rows[1].retreadRate, null, "区间里没有死路 ⇒ 无定义");
  const group = summarizeWindow(rows, WINDOWS[0]);
  t.eq(group.n, 0, "两条都不可测 ⇒ 分母 0");
  t.eq(group.rate, null, "分母 0 ⇒ 率 null（不是 0）");
};

tests["R-29 entitySeqsOf 认两种位置形态（节点 seq / 边 evidence 数字与 {start,end}）"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 10 },
      { id: "n2", kind: "agent", seq: 40 },
    ],
    edges: [
      { id: "e1", result: "failure", action: "x", evidence: 30 },
      { id: "e2", result: "failure", action: "y", evidence: { start: 20, end: 25 } },
    ],
  });
  const seqs = entitySeqsOf(g);
  t.eq(seqs.includes(30), true, "数字形态的 evidence 要认");
  t.eq(seqs.includes(20) && seqs.includes(25), true, "{start,end} 形态要认");
  t.eq(seqs.includes(40), true, "节点 seq 要认");
  t.eq(seqs, [...seqs].sort((a, b) => a - b), "必须升序（右删失判定靠它）");
};
