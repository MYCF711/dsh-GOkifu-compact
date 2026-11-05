/**
 * prediction-hit.test.mjs —— 「把摘要当预测来打分」的度量守卫（T57）
 *
 * 为什么需要守卫：A（停点命中率）的全部价值在**四条边界**上，每一条都会静默地给出假绿 ——
 *
 *   ① **抽取只能落在 `## 当前节点` 段内**：
 *      `## 棋谱（状态节点）` 段里逐行就是 `- n<id> …`。只要把抽取写成「全文搜 `n\d+`」，
 *      命中的就是**最后一行**（= 折叠区间末节点）⇒ A 恒等于 1 ⇒ 与 T53 判死的
 *      `区间保真度 A`（85.6% 恒等于 1.0）**同一种死法**。
 *      本文件用「段外全是 id、段内没有 id」的夹具**钉死**这一条。
 *
 *   ② **`n?` 不是停点断言**：
 *      `停在 n?` 是「我不知道」，不是「停在 nX」。把它算成命中 = 把失败记成成功；
 *      把它算成 miss 也可以，但**必须在报告里单列**（敏感性口径）。
 *      两条口径都不许悄悄合并。
 *
 *   ③ **右删失 / 被人打断 ≠ 未命中**：
 *      折叠之后再没有 assistant 动作（会话就结束在折叠处）时，`hit` 必须是 `null`，
 *      **不是 `false`**。`Number(null) === 0` 会把「缺测」读成「命中 0」—— 本仓踩过。
 *      折叠后先插进一条 user 消息时，停点被人类改向取代，同样**不是摘要写错**。
 *
 *   ④ **判据必须能返回「不通过」**：
 *      一个永远不会红的判据不是守卫，是假门禁（T54 的老教训）。
 *      本文件用「全部命中」的退化桶验证判据 ① 会红、用「有方差」的桶验证它会绿，
 *      并验证 ②③ 在无方差时标记 `degenerate`（**退化通过不构成支持**）。
 *
 * 另钉住**四格**（T56 第 24 轮）：正向证据是「摘要**列了**死路 且 之后**避开了**」。
 * 只统计「重踩」= 只看到警告无效那一格，把正面证据整个漏掉。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉
//   （C641 的教训：具名导入缺符号 ⇒ 后面所有测试文件都不跑）。
import * as audit from "../scripts/prediction-hit-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";

export const tests = {};

const {
  MIN_CELL,
  STOP_PATTERNS,
  CRITERIA_RULES,
  splitSections,
  stopSectionOf,
  extractStopClaim,
  lastFoldedNode,
  firstActionAfter,
  markPrediction,
  summarizeA,
  cellOf,
  valueDistribution,
  fourCellOf,
  judgeCriteria,
  audit: scan,
  renderReport,
} = audit;

/* ───────────────────────────── 夹具 ───────────────────────────── */

const NOW = 1_790_000_000_000;

/**
 * 造一张图：节点 / 边 / 折痕全部显式给，不依赖任何默认值。
 * @param {{sessionId?:string, nodes?:Array<object>, edges?:Array<object>, marks?:Array<object>,
 *   lastOfflineSummary?:object|null}} [spec]
 */
function makeGraph({ sessionId = "s-prediction", nodes = [], edges = [], marks = [], lastOfflineSummary = null } = {}) {
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
      result: "success",
      action: "read(file_path=E:/a.md)",
      verify: { kind: "none", summary: "" },
      errorSnippet: "",
      transposition: false,
      ts: NOW,
      ...edge,
    };
  }
  g.foldMarks = marks;
  g.lastOfflineSummary = lastOfflineSummary;
  return g;
}

/** 一条直线链：n1(user) → n2(agent) → n3(agent) → n4(agent)，seq 1/5/9/13。 */
function linearChain() {
  return makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1, text: "开始" },
      { id: "n2", kind: "agent", seq: 5, via: "e1" },
      { id: "n3", kind: "agent", seq: 9, via: "e2" },
      { id: "n4", kind: "agent", seq: 13, via: "e3" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", evidence: { start: 3, end: 4 } },
      { id: "e2", from: "n2", to: "n3", evidence: { start: 7, end: 8 } },
      { id: "e3", from: "n3", to: "n4", evidence: { start: 11, end: 12 } },
    ],
    marks: [{ at: NOW, seqStart: 1, seqEnd: 9, trigger: "archive-offline" }],
  });
}

/** 造一段摘要：`## 当前节点` 段里放给定正文。 */
function summaryWith(sectionBody, extra = "") {
  return ["## 目标", "- 把这件事做完", "", "## 棋谱（状态节点）", "- n1 seq=1 目标=开始", "- n2 seq=5 目标=继续", "", "## 当前节点与最近用户消息", sectionBody, "", "## 原始坐标", "- 本段遮蔽 seq 1-9", extra].join("\n");
}

/* ───────────────────── ① 抽取：闭集与「段内」边界 ───────────────────── */

tests["T57 抽取：闭集里的两种句式各认一种（含 markdown 装饰）"] = (t) => {
  const cases = [
    ["当前停在 n30：助手刚检索", "n30"],
    ["现在停在 **n43**：刚把测试写入磁盘", "n43"],
    ["停在 [n37] 的 `grep` 之后", "n37"],
    ["当前停在「n9」", "n9"],
    ["当前停在 `n12`：跑完了", "n12"],
    ["当前节点：n45（状态 ab/cd）", "n45"],
    ["当前节点: n7", "n7"],
    ["- 现在停在 n27：正从 app.asar 抽源码", "n27"],
  ];
  for (const [body, expected] of cases) {
    const result = extractStopClaim(summaryWith(body));
    t.eq(result.claim, expected, `「${body}」应抽到 ${expected}`);
    t.eq(result.sectionScoped, true, "必须命中 `## 当前节点` 段");
  }
  t.eq(STOP_PATTERNS.length, 2, "闭集只有两种句式（加句式就是改口径，要同步文档与报告）");
};

tests["T57 抽取：`n1` 不许匹配 `n12`（边界）"] = (t) => {
  t.eq(extractStopClaim(summaryWith("停在 n12")).claim, "n12", "n12 要原样抽出");
  t.eq(extractStopClaim(summaryWith("停在 n1，然后 n12")).claim, "n1", "取第一个（n1 不是 n12 的前缀命中）");
  t.eq(extractStopClaim(summaryWith("停在 n1234567")).claim, null, "超过 6 位的 id 不是本仓的节点 id");
};

tests["T57 抽取：段外全是 id 时**一条都不算**（假绿的入口）"] = (t) => {
  // 段内没有任何 id，但别的段里全是 id —— 全文抽取的实现会在这里抽到最后一个 n99。
  const text = [
    "## 目标",
    "- 做完 n7",
    "",
    "## 棋谱（状态节点）",
    "- n1 seq=1 目标=a",
    "- n98 seq=90 目标=b",
    "- n99 seq=95 目标=c",
    "",
    "## 当前节点与最近用户消息",
    "当前停在 T10 收口阶段：手上还差最终 patch 与 sha256。",
    "",
    "## 原始坐标",
    "- 本段遮蔽 seq 1-95",
  ].join("\n");
  const result = extractStopClaim(text);
  t.eq(result.claim, null, "段内没有具体节点 id ⇒ 不是停点断言");
  t.eq(result.sectionScoped, true, "段是存在的（判的是段内无 id，不是没有段）");
  t.eq(result.nonClaim, "停在 <散文>（段内没有具体节点 id）", "归到「散文」而不是「无段」");
  t.ok(result.outsideNodeIds >= 4, `段外的 n<id> 只计数（实际 ${result.outsideNodeIds} 个）`);
};

tests["T57 抽取：`n?` / `e?` / 散文 / 无段 各归各桶（不合并）"] = (t) => {
  t.eq(extractStopClaim(summaryWith("当前停在 n?：预览测试还在跑")).nonClaim, "n? 占位（写不出节点）", "n? 是占位符");
  t.eq(extractStopClaim(summaryWith("当前停在 e? 报告已写入后的收尾节点")).nonClaim, "e? 占位（写的是边）", "e? 写的是边");
  t.eq(extractStopClaim(summaryWith("当前停在非 race 门禁已绿、文档已补写")).nonClaim, "停在 <散文>（段内没有具体节点 id）", "散文");
  const noSection = extractStopClaim("## 目标\n- 做完\n## 原始坐标\n- seq 1-9");
  t.eq(noSection.claim, null, "没有该段就不是断言");
  t.eq(noSection.sectionMissing, true, "要能区分「没有段」与「段内没 id」");
};

tests["T57 抽取：段标题本身不是断言；同一段多个 id 要报 conflicts"] = (t) => {
  t.eq(extractStopClaim(summaryWith("")).claim, null, "空段没有断言");
  // 两条**独立的停点断言**（不是「顺便提到另一个节点」—— 那不算冲突，报出来就是噪声）
  const multi = extractStopClaim(summaryWith("当前停在 n30：还在跑。现在停在 n29：上一步已确认。"));
  t.eq(multi.claim, "n30", "取第一个");
  t.eq(multi.conflicts, true, "段里出现第二个不同 id 要报冲突（报告里不能装作没有）");

  const single = extractStopClaim(summaryWith("当前停在 n30：上一已确认节点是 n29。"));
  t.eq(single.conflicts, false, "只是提到别的节点 ⇒ 不算冲突");
};

tests["T57 抽取：splitSections 认 CRLF 与三级标题"] = (t) => {
  const text = "## 目标\r\n- a\r\n### 子标题\r\n- b\r\n## 当前节点与最近用户消息\r\n停在 n3\r\n";
  const sections = splitSections(text);
  t.eq(sections.length, 2, "`###` 不算二级标题");
  t.eq(sections[1].heading, "当前节点与最近用户消息", "标题要原样保留");
  t.includes(sections[1].body, "停在 n3", "正文要能取到（CRLF 下别整段失配）");
  t.eq(stopSectionOf(text)?.includes("停在 n3"), true, "stopSectionOf 走同一条路径");
};

/* ───────────────────── ② 停点预测的验证 ───────────────────── */

tests["T57 验证：折叠区间末节点 / 之后第一个 assistant 动作 / via.from"] = (t) => {
  const graph = linearChain();
  const last = lastFoldedNode(graph, 9);
  t.eq(last?.id, "n3", "seq ≤ 9 的最后一个节点");

  const after = firstActionAfter(graph, 9);
  t.eq(after.firstAgent?.id, "n4", "折叠后第一个 assistant 动作");
  t.eq(after.viaFrom, "n3", "`via.from` = 这个动作基于哪个节点");
  t.eq(after.censored, false, "有后续动作 ⇒ 不删失");
  t.eq(after.superseded, false, "中间没有 user 消息");
};

tests["T57 验证：折叠后再没有 assistant 动作 ⇒ 右删失（hit 必须是 null，不是 false）"] = (t) => {
  const graph = linearChain();
  const row = markPrediction(graph, { at: NOW, seqStart: 1, seqEnd: 13, trigger: "archive-offline" }, {
    summaryText: summaryWith("当前停在 n4：做完了"),
  });
  t.eq(row.claim, "n4", "断言本身抽得到");
  t.eq(row.measurable, false, "没有后续动作 ⇒ 不可验证");
  t.eq(row.censored, true, "记右删失");
  t.eq(row.hit, null, "**hit 必须是 null**（`Number(null) === 0` 会把缺测读成「命中 0」）");
  t.eq(row.why, "折叠后再没有 assistant 动作（右删失）", "原因写清楚");
};

tests["T57 验证：折叠后先插进一条 user 消息 ⇒ 被人打断（不是未命中）"] = (t) => {
  const graph = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1, text: "开始" },
      { id: "n2", kind: "agent", seq: 5, via: "e1" },
      { id: "n3", kind: "user", seq: 9, text: "换个方向" },
      { id: "n4", kind: "agent", seq: 13, via: "e2" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", evidence: { start: 3, end: 4 } },
      { id: "e2", from: "n3", to: "n4", evidence: { start: 11, end: 12 } },
    ],
  });
  const row = markPrediction(graph, { at: NOW, seqStart: 1, seqEnd: 5, trigger: "archive-offline" }, {
    summaryText: summaryWith("当前停在 n2：做了一半"),
  });
  t.eq(row.measurable, false, "停点被人类改向取代 ⇒ 不可验证");
  t.eq(row.superseded, true, "记「被人打断」");
  t.eq(row.hit, null, "**不许记成未命中**（那是冤枉摘要）");
  t.eq(row.why.includes("user"), true, "原因要说明是 user 消息");
};

tests["T57 验证：三个判定各给一条（命中 / 差一个节点 / 重父化）"] = (t) => {
  // ① 命中：说停在 n3，via.from 也是 n3
  const hit = markPrediction(linearChain(), { at: NOW, seqStart: 1, seqEnd: 9 }, {
    summaryText: summaryWith("当前停在 n3：刚跑完测试"),
  });
  t.eq([hit.measurable, hit.exists, hit.isLast, hit.continues, hit.hit], [true, true, true, true, true], "① 全对");

  // ② 差一个节点：说停在 n2，实际末节点是 n3
  const stale = markPrediction(linearChain(), { at: NOW, seqStart: 1, seqEnd: 9 }, {
    summaryText: summaryWith("当前停在 n2：还在读文档"),
  });
  t.eq([stale.exists, stale.isLast, stale.continues, stale.hit], [true, false, false, false], "② 复制错 ⇒ 承接也错");

  // ③ 重父化：说停在 n3（= 末节点），但下一个动作的 via 指向 n1
  const reparent = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1, text: "开始" },
      { id: "n2", kind: "agent", seq: 5, via: "e1" },
      { id: "n3", kind: "agent", seq: 9, via: "e2" },
      { id: "n4", kind: "agent", seq: 13, via: "e3" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", evidence: { start: 3, end: 4 } },
      { id: "e2", from: "n2", to: "n3", evidence: { start: 7, end: 8 } },
      { id: "e3", from: "n1", to: "n4", evidence: { start: 11, end: 12 }, transposition: true },
    ],
  });
  const row = markPrediction(reparent, { at: NOW, seqStart: 1, seqEnd: 9 }, {
    summaryText: summaryWith("当前停在 n3：做完了"),
  });
  t.eq([row.isLast, row.continues, row.hit], [true, false, false], "③ 抄对了末节点，但图把动作重父化 ⇒ 未命中");
};

tests["T57 验证：没有停点断言的折痕 measurable 必须是 false（不进分母）"] = (t) => {
  const row = markPrediction(linearChain(), { at: NOW, seqStart: 1, seqEnd: 9 }, {
    summaryText: summaryWith("当前停在 n?：还没拿到输出"),
  });
  t.eq(row.claim, null, "没有断言");
  t.eq(row.measurable, false, "不进分母");
  t.eq(row.hit, null, "也不记 0");
  t.eq(row.extraction, "n? 占位（写不出节点）", "分类要能看见");
};

/* ───────────────────── ③ 聚合与样本量门槛 ───────────────────── */

tests["T57 聚合：命中率与三半分解"] = (t) => {
  /** 一条可验证的行。 */
  const row = (hit, { lastFolded = "n3", viaFrom = "n3", isLast = hit } = {}) => ({
    claim: hit ? "n3" : "n2",
    measurable: true,
    hit,
    exists: true,
    isLast,
    continues: hit,
    viaFrom,
    lastFolded,
    extraction: "claim",
  });
  // 7 命中 + 3 未命中 = 10 条（= MIN_CELL，刚好够算率）
  const rows = [
    ...Array.from({ length: 7 }, () => row(true)),
    ...Array.from({ length: 2 }, () => row(false)),
    row(false, { isLast: true, viaFrom: "n1", claim: "n3" }), // 重父化：抄对末节点但 via 指向别处
    { claim: "n3", measurable: false, hit: null, censored: true, extraction: "claim" },
    { claim: null, measurable: false, hit: null, extraction: "n? 占位（写不出节点）" },
  ];
  const bucket = summarizeA(rows);
  t.eq(bucket.claims, 11, "有断言的 11 条（含删失）");
  t.eq(bucket.measurable, 10, "可验证 10 条");
  t.eq(bucket.censored, 1, "右删失 1 条");
  t.eq(bucket.hits, 7, "命中 7 条");
  t.eq(bucket.rate, 0.7, "A = 命中 / 可验证");
  t.eq(bucket.copyShare, 0.8, "复制 8/10（重父化那条抄对了末节点）");
  t.eq(bucket.continueShare, 0.7, "承接 = A 本身");
  t.eq(bucket.rateSensitivity, 7 / 11, "敏感性口径：删失 + 占位都按 miss 计入");
  t.eq(bucket.modalShare, 0.7, "众数占比");
};

tests["T57 聚合：样本不足 MIN_CELL 时**不算率**（不许硬算）"] = (t) => {
  const rows = Array.from({ length: MIN_CELL - 1 }, () => ({
    claim: "n3",
    measurable: true,
    hit: true,
    exists: true,
    isLast: true,
    continues: true,
    extraction: "claim",
  }));
  const bucket = summarizeA(rows);
  t.eq(bucket.measurable, MIN_CELL - 1, "差一条");
  t.eq(bucket.rate, null, `**${MIN_CELL} 条以下不许给百分数**`);

  const enough = summarizeA([...rows, { ...rows[0] }]);
  t.eq(enough.measurable, MIN_CELL, "补齐");
  t.eq(enough.rate, 1, "够了才给率");

  const cell = cellOf(rows);
  t.eq(cell.insufficient, true, "cellOf 也要标记样本不足");
  t.eq(cell.rate, null, "cellOf 同样不给率");
};

tests["T57 聚合：取值分布（判据 ① 的输入）"] = (t) => {
  const dist = valueDistribution([
    { measurable: true, hit: true },
    { measurable: true, hit: true },
    { measurable: true, hit: false },
    { measurable: true, hit: true },
    { measurable: false, hit: null },
  ]);
  t.eq([dist.n, dist.ones, dist.zeros], [4, 3, 1], "只数可验证的");
  t.eq(dist.modalShare, 3 / 4, "众数占比");
  t.eq(valueDistribution([]).modalShare, null, "空池给 null（不是 0）");
};

/* ───────────────────── ④ 四条判据必须能红 ───────────────────── */

/** 造一个判据输入。 */
function criteriaInput(overrides = {}) {
  return {
    a: { modalShare: 0.5, measurable: 40 },
    b: { modalShare: 0.5, n: 40 },
    correlationsA: {
      tailGap: { n: 40, spearman: 0.05 },
      span: { n: 40, spearman: -0.05 },
      traceableShare: { n: 40, spearman: 0.1 },
      qualityTotal: { n: 40, spearman: 0.1 },
    },
    correlationsB: {
      tailGap: { n: 40, spearman: 0.05 },
      span: { n: 40, spearman: -0.05 },
      traceableShare: { n: 40, spearman: 0.1 },
      qualityTotal: { n: 40, spearman: 0.1 },
    },
    poolsA: { repaired: { n: 20, rate: 0.9 }, clean: { n: 20, rate: 0.9 } },
    poolsB: { repaired: { n: 20, rate: 0.1 }, clean: { n: 20, rate: 0.1 } },
    ...overrides,
  };
}

const byKey = (criteria, key) => criteria.find((item) => item.key === key);

tests["T57 判据：全绿输入下四条都通过"] = (t) => {
  const criteria = judgeCriteria(criteriaInput());
  t.eq(criteria.length, 8, "A/B 各四条");
  t.eq(criteria.filter((item) => item.pass === false), [], "没有红");
  t.eq(byKey(criteria, "A①").pass, true, "① 有方差");
  t.eq(byKey(criteria, "A②").pass, true, "② 与形状无关");
  t.eq(byKey(criteria, "A③").pass, true, "③ 与已有指标不同");
  t.eq(byKey(criteria, "A④").pass, true, "④ 分子不是修复函数输出");
};

tests["T57 判据 ①：众数占比 ≥ 80% 必须**红**（假门禁的入口）"] = (t) => {
  const criteria = judgeCriteria(criteriaInput({ a: { modalShare: 0.99, measurable: 237 }, b: { modalShare: 0.99, n: 630 } }));
  t.eq(byKey(criteria, "A①").pass, false, "A ① 必须红");
  t.eq(byKey(criteria, "B①").pass, false, "B ① 必须红");
  t.eq(byKey(criteria, "A②").degenerate, true, "无方差时 ② 是退化通过（不构成支持）");
  t.eq(byKey(criteria, "A③").degenerate, true, "③ 同理");
  t.eq(byKey(criteria, "A①").value, 0.99, "值要原样给出来");
};

tests["T57 判据 ②：|ρ| ≥ 0.2 必须红；ρ 缺失（null）是「不可判」不是通过"] = (t) => {
  const bad = judgeCriteria(
    criteriaInput({
      correlationsA: {
        tailGap: { n: 40, spearman: 0.4 },
        span: { n: 40, spearman: 0.1 },
        traceableShare: { n: 40, spearman: 0.1 },
        qualityTotal: { n: 40, spearman: 0.1 },
      },
    }),
  );
  t.eq(byKey(bad, "A②").pass, false, "|ρ|=0.4 ⇒ 红");

  const unknown = judgeCriteria(
    criteriaInput({
      correlationsA: {
        tailGap: { n: 0, spearman: null },
        span: { n: 0, spearman: null },
        traceableShare: { n: 0, spearman: null },
        qualityTotal: { n: 0, spearman: null },
      },
    }),
  );
  t.eq(byKey(unknown, "A②").pass, null, "ρ 算不出来 ⇒ 不可判（**不是通过**）");
  t.eq(byKey(unknown, "A③").pass, null, "③ 同理");
};

tests["T57 判据 ③：与已有指标 ρ ≥ 0.8 必须红（换名字不产生新信息）"] = (t) => {
  const criteria = judgeCriteria(
    criteriaInput({
      correlationsA: {
        tailGap: { n: 40, spearman: 0.05 },
        span: { n: 40, spearman: 0.05 },
        traceableShare: { n: 40, spearman: 0.85 },
        qualityTotal: { n: 40, spearman: 0.1 },
      },
    }),
  );
  t.eq(byKey(criteria, "A③").pass, false, "ρ=0.85 ⇒ 红");
};

tests["T57 判据 ④：两池样本不足 ⇒ 不可判（不拿 2 条算差值）"] = (t) => {
  const criteria = judgeCriteria(criteriaInput({ poolsA: { repaired: { n: 2, rate: 1 }, clean: { n: 200, rate: 0.98 } } }));
  t.eq(byKey(criteria, "A④").pass, null, "补回池只有 2 条 ⇒ 不可判（**不许因为漏填 insufficient 就通过**）");
  t.includes(byKey(criteria, "A④").detail, "设计保证", "不可判也要给出设计保证那半");
};

/* ───────────────────── ⑤ 四格（正向证据） ───────────────────── */

tests["T57 四格：列了且避开 = 正向证据；列了且重踩 = 警告无效"] = (t) => {
  // 折叠区间 1..9 里有两条失败边 e2 / e3；折叠后 e4 是 e2 同签名的重踩，e3 没被重踩。
  const graph = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1 },
      { id: "n2", kind: "agent", seq: 5, via: "e1" },
      { id: "n3", kind: "agent", seq: 9, via: "e2" },
      { id: "n4", kind: "agent", seq: 15, via: "e3" },
      { id: "n5", kind: "agent", seq: 21, via: "e4" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", result: "success", evidence: { start: 3, end: 4 } },
      { id: "e2", from: "n2", to: "n3", result: "failure", sig: "SAME", action: "bash(cmd=a)", errorSnippet: "boom", evidence: { start: 7, end: 8 } },
      { id: "e3", from: "n3", to: "n4", result: "failure", sig: "OTHER", action: "read(x)", errorSnippet: "nope", evidence: { start: 9, end: 10 } },
      { id: "e4", from: "n4", to: "n5", result: "failure", sig: "SAME", action: "bash(cmd=a)", errorSnippet: "boom", evidence: { start: 19, end: 20 } },
    ],
  });
  const text = ["## 已探明死路", "- e2 失败", "- e3 失败", "## 当前节点", "停在 n3"].join("\n");
  const cell = fourCellOf(graph, { seqStart: 1, seqEnd: 9 }, text);
  t.eq(cell.listedRetread, 1, "e2：摘要列了 + 之后重踩 ⇒ 警告无效");
  t.eq(cell.listedAvoided, 1, "e3：摘要列了 + 之后避开 ⇒ **正向证据**");
  t.eq(cell.unlistedRetread, 0, "没有漏写后重踩");
  t.eq(cell.unlistedAvoided, 0, "没有漏写后避开");

  const withoutText = fourCellOf(graph, { seqStart: 1, seqEnd: 9 }, null);
  t.eq(withoutText.unknown, 0, "正文取不到 ⇒ 四格整条排除（不记 0）");
  t.eq(fourCellOf(graph, { seqStart: null, seqEnd: null }, text), null, "区间缺失 ⇒ null");
};

/* ───────────────────── ⑥ 端到端（临时 home，只读） ───────────────────── */

/** 在临时目录里造一个最小 home（`<home>/chess-context/sessions/<dir>/graph.json`）。 */
function makeHome(graphs) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "prediction-home-"));
  const root = nodePath.join(home, "chess-context", "sessions");
  nodeFs.mkdirSync(root, { recursive: true });
  for (const [dir, graph] of graphs) {
    const session = nodePath.join(root, dir);
    nodeFs.mkdirSync(session, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(session, "graph.json"), JSON.stringify(graph), "utf8");
  }
  return home;
}

tests["T57 端到端：audit() 在临时 home 上跑通，A 与 B 分开报"] = (t) => {
  const graph = linearChain();
  const text = summaryWith("当前停在 n3：刚跑完测试");
  graph.lastOfflineSummary = { at: NOW, range: { start: 1, end: 9 }, text, model: "fixture" };
  const home = makeHome([["s-e2e-1", graph]]);
  const result = scan({ home, limit: 10, logs: "none" });

  t.eq(result.graphs, 1, "读到 1 张图");
  t.eq(result.epoch.marks, 1, "1 条折痕");
  t.eq(result.epoch.withSummary, 1, "摘要正文可解析");
  t.eq(result.a.claims, 1, "有停点断言");
  t.eq(result.a.measurable, 1, "可验证");
  t.eq(result.a.hits, 1, "命中");
  t.eq(result.a.rate, null, `只有 1 条 ⇒ **不算率**（MIN_CELL=${MIN_CELL}）`);
  t.eq(result.logs.mode, "none", "未读日志");
  t.eq(result.strata.observed, 0, "分层维度整体未观测");
  t.ok(result.b !== undefined && result.b !== null, "B 的窗口汇总必须存在（A/B 分开报）");
  t.eq(result.verdict.a, "unusable", "1 条 100% ⇒ 判据 ① 必红");
  t.includes(renderReport(result), "## ⑦ 如果 A 命中率高", "报告必须给出「是不是今晚第一个站得住的指标」那一节");
};

tests["T57 端到端：没有未命中时报告也不许把「不算率」写成 100%"] = (t) => {
  const graph = linearChain();
  graph.lastOfflineSummary = { at: NOW, range: { start: 1, end: 9 }, text: summaryWith("当前停在 n3"), model: "fixture" };
  const home = makeHome([["s-e2e-2", graph]]);
  const report = renderReport(scan({ home, limit: 10, logs: "none" }));
  t.includes(report, "样本不足", "样本不足要写在报告里");
  t.eq(report.includes("A = 100.00%"), false, "不许把 1/1 写成 100.00%");
};

tests["T57 端到端：home 给错 ⇒ 一张图都读不到（audit 返回 0，CLI 退出码 2）"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "prediction-empty-"));
  const result = scan({ home, limit: 10, logs: "none" });
  t.eq(result.graphs, 0, "空 home ⇒ 0 张图（调用方据此 exit 2，不假装跑通）");
  t.eq(result.a.rate, null, "没有数据 ⇒ 率是 null");
  t.eq(CRITERIA_RULES.maxConstantShare, 0.8, "门槛常量与 T52–T56 同一套");
};
