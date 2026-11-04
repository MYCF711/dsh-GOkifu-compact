/**
 * deadend-adherence.test.mjs —— **「死路逐条写 id」遵守率的度量守卫**（C645）
 *
 * 为什么需要守卫：这个脚本的全部价值在**一个减法**上 ——
 *   「最终正文里的 id」−「机械补回段里的 id」=「模型自己写的 id」。
 * 这个减法写错（哪怕只错成「不剥补回段」），结论会**反向**：
 *   补回跑过 ⇒ 最终正文 `failureRecall` 恒 = 1 ⇒ 遵守率恒 = 100% ⇒
 *   「C607 的提示词够硬，不用改」—— 而真相可能是模型一条都没写。
 * 假绿的后果不是少个数字，是**把该改的提示词判成不用改**。
 *
 * 所以本文件钉四件事，缺一条这个度量就退化成「自证清白」：
 *   ① **剥补回段**：补回段里的 id 不许算成模型写的（否则 0.75 会变成 1.00）；
 *   ② **切分点取较早的标题**：约束补回段排在死路补回段**之前**，只切死路会把约束段
 *      留给「模型正文」—— 现在无害，但那是**碰巧**；
 *   ③ **区间合并的假阳**：合规写法是「一行一条」（`- e123 …\n- e124 …`），
 *      用 `\s*` 匹配破折号就会把换行 + 列表符号 `-` 当成区间
 *      ⇒ 每一条合规摘要都被记成「合并」，合并率 100%，真合并被淹没；
 *   ④ **分母为 0 时给 null**：没有失败边的区间不是「100% 遵守」，也不是 0%。
 *
 * 另有两条**真机夹具**（`session-fdd814b1` 的 `e693—e698`、端到端读临时 home），
 * 保证口径在真数据形状上算得出来、且明细与汇总对得上。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉
//   （C641 的教训：具名导入缺符号 ⇒ 后面所有测试文件都不跑）。
import * as audit from "../scripts/deadend-adherence-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";

export const tests = {};

const { splitModelText, countRangeMerges, coveredByDashRange, markAdherence, summarize, summaryTextFor, audit: scan } = audit;

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 一条**新鲜**的失败边（`to` 必须在图里、`ts` 必须新鲜，否则 `isDanglingResidue` 会把它当残留滤掉）。 */
const failureEdge = (id, { start, end, action = "edit(file_path=x.md)", error = "Error: cannot modify" }) => ({
  id,
  from: "n1",
  to: "n2",
  intent: "",
  result: "failure",
  action,
  verify: { kind: "none", summary: "" },
  errorSnippet: error,
  evidence: { start, end },
  transposition: false,
  ts: Date.now(),
});

/** 区间 1–12 内有 e1..e4 四条失败边；e99 在区间外（300 > 12，不许被补回带进来）。 */
function makeGraph() {
  const g = createGraph({ sessionId: "sess-deadend", cwd: "E:/x" });
  g.nodes = {
    n1: { id: "n1", kind: "user", seq: 1, turn: 1, text: "目标：修压缩", constraints: ["只读 home"], ts: 1 },
    n2: { id: "n2", kind: "agent", seq: 5, turn: 1, text: "连续 edit 被拒", ts: 2 },
  };
  g.order = ["n1", "n2"];
  g.nextNode = 3;
  g.edges = {
    e1: failureEdge("e1", { start: 5, end: 6, action: "edit(file_path=a.md)" }),
    e2: failureEdge("e2", { start: 7, end: 8, action: "edit(file_path=b.md)" }),
    e3: failureEdge("e3", { start: 9, end: 10, action: "edit(file_path=c.md)" }),
    e4: failureEdge("e4", { start: 11, end: 12, action: "edit(file_path=d.md)" }),
    e99: failureEdge("e99", { start: 300, end: 301, action: "edit(file_path=outside.md)" }),
  };
  g.nextEdge = 100;
  // 正文落盘（区间对得上）—— 没有它就 `summaryTextFor` 一律返回 null，所有正文口径都不可测。
  g.lastOfflineSummary = { at: 1_000, range: { start: 1, end: 12 }, text: FINAL_TEXT, model: "test/model" };
  return g;
}

/** 模型自己写的部分：只逐条写了 e1 / e2 / e3。 */
const MODEL_TEXT = [
  "## 目标",
  "- 把压缩链路修到可交付",
  "## 棋谱（状态节点）",
  "- n1 用户提出目标",
  "## 已探明死路",
  "- e1 「edit(a.md)」→ 没读过",
  "- e2 「edit(b.md)」→ 没读过",
  "- e3 「edit(c.md)」→ 没读过",
].join("\n");

/** 机械补回段（`repairMissingFailures` 的逐字形状）：把漏掉的 e4 追加进来。 */
const REPAIR_TEXT = ["## 已探明死路（逐字补充 · 机械补回，不许重试）", "- e4 「edit(d.md)」→ 没读过"].join("\n");

const FINAL_TEXT = `${MODEL_TEXT}\n\n${REPAIR_TEXT}`;

const markOf = (over = {}) => ({
  at: 1_000,
  seqStart: 1,
  seqEnd: 12,
  trigger: "archive-offline",
  summaryChars: FINAL_TEXT.length,
  route: { provider: "magpie", model: "test/model" },
  fallback: null,
  quality: { expectedFailures: 4, failureRecall: 1, missingFailures: [] },
  ...over,
});

/* ─────────────────────── ① 剥补回段（真红核心） ─────────────────────── */

tests["C645 补回段里的 id 不许算成模型写的（否则 0.75 会变成 1.00）"] = (t) => {
  const split = splitModelText(FINAL_TEXT);
  t.eq(split.hasRepairSection, true, "正文里有补回段标题 ⇒ 必须认出来");
  t.includes(split.modelText, "e3", "模型写的那几条留在 modelText 里");
  t.notIncludes(split.modelText, "e4", "**补回的 e4 不许出现在模型正文里**");
  t.includes(split.repairText, "e4", "补回段里当然有 e4");
  t.eq(split.modelText.trimEnd(), MODEL_TEXT, "切分后模型正文要与原文逐字一致（不许顺手 trim 掉内容）");

  // 端到端：4 条边，模型写 3 条 ⇒ 0.75；补回 1 条 ⇒ 补回后 1.00
  const row = markAdherence(makeGraph(), markOf(), { index: 0, session: "sess-deadend" });
  t.eq(row.edges, 4, "区间内有 4 条失败边（e99 在区间外）");
  t.eq(row.modelHit, 3, "模型逐条写了 3 条");
  t.eq(row.repairedIds, ["e4"], "补回救了 e4");
  t.eq(row.missingIds, [], "补回后没有漏的");
  t.eq(row.adherence, 0.75, "**遵守率必须是 0.75**（把补回算成模型的就会变成 1）");
  t.eq(row.postAdherence, 1, "补回后 = 1（这是代码的功劳）");
};

tests["C645 没有补回段时原样返回（减法不能把正文切短）"] = (t) => {
  const split = splitModelText(MODEL_TEXT);
  t.eq(split.hasRepairSection, false, "没有补回标题 ⇒ hasRepairSection=false");
  t.eq(split.modelText, MODEL_TEXT, "原样返回");
  t.eq(split.repairText, "", "补回段为空");
  t.eq(splitModelText(null).modelText, "", "null 不许炸");
};

tests["C645 切分点取较早的标题（约束补回段排在死路段之前）"] = (t) => {
  const text = [MODEL_TEXT, "## 约束（逐字补充 · 离线压缩后自动补回，不许删）", "- 只读 home", REPAIR_TEXT].join("\n\n");
  const split = splitModelText(text);
  t.notIncludes(split.modelText, "逐字补充", "两个补回段都要剥掉，不能只剥死路段");
  t.includes(split.repairText, "e4", "死路补回段在 repairText 里");
  t.eq(split.cut, text.indexOf("## 约束（逐字补充"), "切在**较早**的那个标题上");
};

/* ─────────────────────── ② 区间合并（假阳守卫） ─────────────────────── */

tests["C645 合规的「一行一条」不许被当成区间合并（`\\s*` 会把换行+列表符号当破折号）"] = (t) => {
  // 真机形状（`session-8ef298d6` 的逐字片段）：断行**前面那个字符正好是个 id 引用**。
  //   `…↻2，↑later-ok:e117` ⏎ `- e164 \`bash(...\` → …`
  // 宽口径 `\s*` 会把「e117 + 换行 + `- ` + e164」读成区间 `e117–e164`（凭空吞掉 46 个 id）。
  const compliant = [
    "## 已探明死路",
    "- e123 「edit(a.md)」→ 没读过",
    "- e124 「edit(b.md)」→ 与 e123 同因，↑later-ok:e123",
    "- e164 「bash(...)」→ sed: can't read docs/x.md",
  ].join("\n");
  const merges = countRangeMerges(compliant);
  t.eq(merges.dash, [], "**合规写法必须 0 次合并**（`\\s*` 口径这里会数出 `e123\\n- e164` 一次）");
  t.eq(merges.dashSwallowed, 0, "没吞掉任何 id（`\\s*` 口径会凭空吞掉 40 个）");
  t.eq(merges.slash, [], "斜杠也是 0 次");
};

tests["C645 破折号 / 连字符 / 斜杠都要认出来，并且算得出吞了几个 id"] = (t) => {
  const em = countRangeMerges("e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）");
  t.eq(em.dash, ["e693—e698"], "全角破折号要认");
  t.eq(em.dashSwallowed, 4, "693..698 中间吞掉 e694–e697 共 4 个");

  const hyphen = countRangeMerges("e56-e58 `bash(...)` → exit 2");
  t.eq(hyphen.dash, ["e56-e58"], "半角连字符要认");
  t.eq(hyphen.dashSwallowed, 1, "56..58 中间吞掉 e57 共 1 个");

  const spaced = countRangeMerges("e37 – e41 全部超时");
  t.eq(spaced.dash, ["e37 – e41"], "两侧带空格也要认");
  t.eq(spaced.dashSwallowed, 3, "37..41 中间吞掉 3 个");

  const slash = countRangeMerges("e107/e113 读写 workspace-tree.json 被拒");
  t.eq(slash.slash, ["e107/e113"], "斜杠合并要认出来");
  t.eq(slash.dash, [], "斜杠不是破折号（两种口径分开）");

  t.eq(countRangeMerges("").dash.length, 0, "空串不炸");
  t.eq(countRangeMerges(null).dash.length, 0, "null 不炸");
  t.eq(coveredByDashRange("e695", em.dashRanges), true, "e695 落在 e693—e698 里");
  t.eq(coveredByDashRange("e692", em.dashRanges), false, "e692 不在区间里");
  t.eq(coveredByDashRange("n695", em.dashRanges), false, "节点 id 不算边");
};

/* ─────────────────────── ③ 单条 / 聚合的边界 ─────────────────────── */

tests["C645 区间里没有失败边 ⇒ 比例是 null，不是 100% 也不是 0%"] = (t) => {
  const graph = makeGraph();
  // 换一段**没有失败边**的区间，并让正文落盘到这一段（否则「可测」本身就为假，测不到分母为 0 的分支）
  graph.lastOfflineSummary = { at: 1_000, range: { start: 101, end: 200 }, text: "## 目标\n- 这一段没有失败边", model: "m" };
  const row = markAdherence(graph, markOf({ seqStart: 101, seqEnd: 200 }), { index: 0, session: "s" });
  t.eq(row.edges, 0, "区间 101–200 里没有失败边");
  t.eq(row.measurable, true, "正文取得到 ⇒ 可测");
  t.eq(row.adherence, null, "**分母为 0 时给 null**（给 1 就是假绿：把「没有边」算成「全写」）");
  t.eq(row.postAdherence, null, "补回后同样是 null");
  t.eq(row.dash, [], "没有正文里的区间");

  const group = summarize([row], { now: 10_000 });
  t.eq(group.total.edges, 0, "分母为 0");
  t.eq(group.total.adherence, null, "汇总也不许编出 100%");
  t.eq(group.total.measurable, 1, "但「可测 1 条」要如实计数");
};

tests["C645 正文落盘不了 ⇒ measurable=false（宁可说不知道，不拿别的段冒充）"] = (t) => {
  const graph = makeGraph();
  graph.lastOfflineSummary = { at: 1, range: { start: 1, end: 12 }, text: FINAL_TEXT, model: "m" };
  const other = markOf({ seqStart: 20, seqEnd: 30 });
  t.eq(summaryTextFor(graph, other).text, null, "区间对不上 ⇒ 取不到正文");
  const row = markAdherence(graph, other, { index: 1, session: "s" });
  t.eq(row.measurable, false, "取不到正文 ⇒ 不可测");
  t.eq(row.modelHit, null, "不可测时分子是 null（不写 0 冒充「一条都没写」）");
  t.eq(row.adherence, null, "不可测时遵守率是 null");
};

/* ─────────────────────── ④ 时间分桶 / 汇总 ─────────────────────── */

tests["C645 时间分桶：6h 边界与「一侧无样本」都不许编数"] = (t) => {
  const now = 100 * 3_600_000;
  const mk = (at, hit, edges) => ({
    at,
    trigger: "archive-offline",
    measurable: true,
    edges,
    modelHit: hit,
    repairedIds: [],
    missingIds: [],
    dash: [],
    slash: [],
    dashSwallowed: 0,
    slashSwallowed: 0,
    recordedExpected: 0,
    recordedRecall: null,
  });
  const rows = [
    mk(now - 1_000, 3, 4), // 最近
    mk(now - 5 * 3_600_000, 1, 1), // 最近（5h < 6h）
    mk(now - 7 * 3_600_000, 2, 2), // 更早（7h > 6h）
  ];
  const s = summarize(rows, { now });
  t.eq(s.byBucket.recent.edges, 5, "最近 6h：4+1 条边");
  t.eq(s.byBucket.recent.modelHit, 4, "最近 6h：3+1 条命中");
  t.eq(s.byBucket.recent.adherence, 0.8, "最近 6h = 4/5");
  t.eq(s.byBucket.earlier.adherence, 1, "更早 = 2/2");
  t.eq(s.total.adherence, 6 / 7, "全部 = 6/7");
  t.eq(s.byTrigger.length, 1, "只有 archive-offline 一组");
  t.eq(s.byTrigger[0].label, "archive-offline", "分组名");
};

/* ─────────────────────── ⑤ 真机夹具（fdd814b1） ─────────────────────── */

tests["C645 真机：session-fdd814b1 的 `e693—e698` 必须归因成「区间吞掉 4 个」"] = (t) => {
  const g = createGraph({ sessionId: "session-fdd814b1", cwd: "E:/x" });
  g.nodes = {
    n1: { id: "n1", kind: "user", seq: 1, turn: 1, text: "目标", constraints: [], ts: 1 },
    n2: { id: "n2", kind: "agent", seq: 5, turn: 1, text: "跑", ts: 2 },
  };
  g.order = ["n1", "n2"];
  g.nextNode = 3;
  g.edges = {};
  for (let i = 693; i <= 698; i += 1) g.edges[`e${i}`] = failureEdge(`e${i}`, { start: i, end: i + 1 });
  g.nextEdge = 700;
  const text = [
    "## 已探明死路",
    "e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）。",
  ].join("\n");
  g.lastOfflineSummary = { at: 1, range: { start: 693, end: 698 }, text, model: "m" };
  const row = markAdherence(g, markOf({ seqStart: 693, seqEnd: 698, summaryChars: text.length }), { index: 0, session: "session-fdd814b1" });
  t.eq(row.edges, 6, "区间内 6 条失败边");
  t.eq(row.modelHit, 2, "逐字只命中首尾两个 id");
  t.eq(row.adherence, 2 / 6, "遵守率 0.333（真机 failureRecall 0.43 的口径差来自别的边）");
  t.eq(row.missingFromDash, 4, "**6 − 2 = 4 个 id 被区间吞掉**");
  t.eq(row.dash, ["e693—e698"], "区间写法被认出来");
};

/* ─────────────────────── ⑥ 端到端（读临时 home） ─────────────────────── */

tests["C645 端到端：读一个临时 home，明细与汇总对得上"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "deadend-adherence-"));
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "sess-real");
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = makeGraph();
    g.foldMarks = [
      // 更早的一条：**区间与 lastOfflineSummary 对不上** ⇒ 正文没落盘 ⇒ 不可测，
      // 但它必须进总数（否则「可测 1 / 总 1」会让人以为全库都有正文）。
      { at: 500, seqStart: 20, seqEnd: 30, trigger: "archive-offline", summaryChars: 900, quality: { failureRecall: 0.5, expectedFailures: 4, missingFailures: ["e3", "e4"] } },
      // 最近的一条：正文落盘，模型写 3/4、补回 1
      markOf({ at: 1_000, summaryChars: FINAL_TEXT.length }),
    ];
    g.lastOfflineSummary = { at: 1_000, range: { start: 1, end: 12 }, text: FINAL_TEXT, model: "m" };
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g));

    const scanned = scan({ home });
    t.eq(scanned.graphs, 1, "读到 1 个会话");
    t.eq(scanned.marks, 2, "两条 foldMark 都要进来（不可测的也要计数）");
    t.eq(scanned.rows.filter((r) => r.measurable).length, 1, "只有一条有正文");
    t.eq(scanned.rows.filter((r) => !r.measurable).length, 1, "另一条如实报「不可测」");

    const s = summarize(scanned.rows, { now: 2_000 });
    t.eq(s.total.marks, 2, "总数含不可测");
    t.eq(s.total.measurable, 1, "可测 1 条");
    t.eq(s.total.edges, 4, "分母只算可测那条的 4 条边");
    t.eq(s.total.adherence, 0.75, "遵守率 0.75");
    t.eq(s.total.repaired, 1, "补回 1 条");
    t.eq(s.total.postAdherence, 1, "补回后 1.00");

    const bad = scanned.rows.filter((r) => r.measurable && r.missingIds.length > 0);
    t.eq(bad.length, 0, "补回后没有漏的 ⇒ 明细为空（补回不算模型的功劳，但也不算漏）");

    // 记录口径：那条不可测的 failureRecall=0.5、expected=4 ⇒ 加权 0.5
    const unmeasured = scanned.rows.find((r) => !r.measurable);
    t.eq(unmeasured.recordedRecall, 0.5, "记录口径原样带出来（与正文口径分列）");
    t.eq(unmeasured.hasRepairedField, false, "老折痕没有 failuresRepaired 字段 ⇒ 世代证据");

    t.eq(JSON.parse(JSON.stringify(s)).total.adherence, 0.75, "汇总可 JSON 序列化（--json 用）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C645 一张图都没有 ⇒ 退出码 2（home 给错了要说清楚）"] = async (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "deadend-empty-"));
  try {
    const code = await audit.main(["--home", home, "--no-git", "--no-probe"]);
    t.eq(code, 2, "读不到任何会话图要退 2，不许安静地报 0 条");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
