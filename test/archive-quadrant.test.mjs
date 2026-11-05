/**
 * archive-quadrant.test.mjs —— **归档时刻四格审计的守卫**（T57）
 *
 * 为什么需要守卫：这个脚本的全部价值在**四个减法/切分**上，每一个错了都会静默地给出假绿 ——
 *
 *   ① **「列了」必须剥掉机械补回段**：
 *      `repairFailuresInText` 把模型漏掉的死路逐条追加到 `## 已探明死路（逐字补充…）`。
 *      对最终正文算 `mentionsEdge`，补回跑过之后**恒 = 1** ⇒ 四格退化成「一行全是列了」
 *      ⇒ 精确率恒 100% ⇒ 结论「摘要很准，不用改」—— 而真相可能是模型一条都没写。
 *      这是本仓栽过五次的形状（可定位率 / A / B / 逐字可回查 / recall），
 *      所以必须用「补回段写了、但折叠后没有失败边」的夹具**钉死**。
 *
 *   ② **归档闸门必须真能挡住**：
 *      改造 A 的全部意义是「活会话的未来说不准」。如果没有 `closeout` 的会话也进样本，
 *      「还没发生」会被算成「没发生」—— 避开率凭空变高，而且没人看得出。
 *
 *   ③ **分层必须分三态（hot / cold / 未观测）**：
 *      日志读不到并进 `cold` 就是**凭空造对照组**。这一条错了，反事实那节的差值是假的。
 *
 *   ④ **四格必须能返回「样本不足」**：
 *      最小格 < 10 时仍报率 = 拿 3 个事件算 99.7% 精确率。
 *
 *   ⑤ **判据 ① 必须能红**：
 *      一个永远不会红的判据不是守卫，是假门禁（T54 的老教训）。
 *
 * 另有端到端一条：真读一个临时 home（graph.json + zstd 日志），汇总与四格对得上。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉
//   （C641 的教训：具名导入缺符号 ⇒ 后面所有测试文件都不跑）。
import * as audit from "../scripts/archive-quadrant-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";
import { REPAIR_FAILURES_HEADING } from "../scripts/deadend-adherence-audit.mjs";

export const tests = {};

const {
  ACCOUNTS,
  STRATA,
  TIERS,
  MIN_CELL,
  PREFIX_MIN,
  MAX_TREATMENT_SHARE,
  treatmentFromText,
  treatmentFromRecord,
  treatmentOf,
  signatureKeyOf,
  toolOfAction,
  argsOfAction,
  commonPrefixLen,
  errorClassOf,
  tierHit,
  graphMaxSeqOf,
  entitySeqsOf,
  archivePointOf,
  archiveWindowOf,
  injectionSeqsOf,
  stratumOf,
  buildQuadrant,
  emptyQuadrant,
  fisherExact,
  markQuadrant,
  judgeCriteria,
  renderReport,
  parseArgs,
  main,
} = audit;

const NOW = Date.now();

/* ───────────────────────────── 夹具 ───────────────────────────── */

/**
 * 造一张图。
 * `closeout` 显式给 `null` = **未归档**（改造 A 会挡掉它）。
 */
function makeGraph({ sessionId = "s-quadrant", nodes = [], edges = [], marks = [], closeout = { at: NOW }, lastOfflineSummary = null } = {}) {
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
      // ★ `to` 必须指向一个真节点：`isDanglingResidue` 会把「已结算但无终点」的边当残留滤掉，
      //   那样夹具里的死路会**整批消失**，四格全 0（假绿）。
      to: "n2",
      intent: "",
      result: "failure",
      action: "edit(file_path=E:/proj/src/alpha.mjs)",
      verify: { kind: "none", summary: "" },
      errorSnippet: "Error: cannot modify",
      transposition: false,
      ts: NOW,
      ...edge,
    };
  }
  g.foldMarks = marks;
  g.closeout = closeout;
  g.lastOfflineSummary = lastOfflineSummary;
  return g;
}

/** 一条失败边。 */
const failEdge = (id, start, { action = "edit(file_path=E:/proj/src/alpha.mjs)", sig = null, error = "Error: cannot modify", end = start } = {}) => ({
  id,
  result: "failure",
  action,
  ...(sig === null ? {} : { sig }),
  errorSnippet: error,
  evidence: { start, end },
});

/** 一条成功边（占位，让「折叠后」有事件可看）。 */
const okEdge = (id, start, { action = "bash(command=npm test)" } = {}) => ({
  id,
  result: "success",
  action,
  evidence: { start, end: start },
});

/** 一条折痕。 */
const markOf = (seqStart, seqEnd, extra = {}) => ({ at: NOW, seqStart, seqEnd, trigger: "pressure", ...extra });

const accountOf = (key) => ACCOUNTS.find((item) => item.key === key);

/* ─────────────────────── ① 治疗变量：正文口径（剥补回段） ─────────────────────── */

tests["A-1 正文口径：模型自己写了 ⇒ listed=true via=model"] = (t) => {
  const text = ["## 已探明死路", "- e1 「edit(file_path=alpha)」→ cannot modify"].join("\n");
  t.eq(treatmentFromText(text, "e1"), { listed: true, via: "model" }, "正文里逐条写了" );
};

tests["A-2 正文口径：**只有机械补回段写了** ⇒ listed=false via=repair（不能算模型的功劳）"] = (t) => {
  const text = [
    "## 已探明死路",
    "- (none)",
    "",
    `${REPAIR_FAILURES_HEADING} · 机械补回，不许重试）`,
    "- e3 「edit(file_path=beta)」→ cannot modify",
  ].join("\n");
  // 这是本文件存在的**第一理由**：不剥补回段的话，这条会算成 listed=true，
  // 精确率从 0 变成 100%，结论反向。
  t.eq(treatmentFromText(text, "e3"), { listed: false, via: "repair" }, "补回段里的 id 不算模型写的");
  t.ok(text.includes("e3"), "对照：e3 确实出现在最终正文里（否则这条测试是空的）");
};

tests["A-3 正文口径：两处都没有 ⇒ absent；取不到正文 ⇒ null（不可判，不是「没写」）"] = (t) => {
  t.eq(treatmentFromText("## 已探明死路\n- (none)", "e9"), { listed: false, via: "absent" }, "真漏写");
  t.eq(treatmentFromText(null, "e9"), { listed: null, via: "unreadable" }, "没有正文 ⇒ 不可判");
  t.eq(treatmentFromText("", "e9"), { listed: null, via: "unreadable" }, "空正文同样不可判");
};

tests["A-4 正文口径：`e1` 不许匹配 `e12`（边界）"] = (t) => {
  const text = "## 已探明死路\n- e12 「x」→ y";
  t.eq(treatmentFromText(text, "e1").listed, false, "e1 不该被 e12 命中");
  t.eq(treatmentFromText(text, "e12").listed, true, "e12 自己命中");
};

/* ─────────────────────── ② 治疗变量：记录口径（10 条截断） ─────────────────────── */

tests["A-5 记录口径：missingFailures 点名 ⇒ listed=false"] = (t) => {
  t.eq(treatmentFromRecord({ quality: { missingFailures: ["e3", "e7"] } }, "e3"), { listed: false, via: "record-missing" }, "被记成漏写");
  t.eq(treatmentFromRecord({ quality: { missingFailures: ["e3"] } }, "e1"), { listed: true, via: "record-listed" }, "不在清单里且未截断 ⇒ 写了");
};

tests["A-6 记录口径：**清单满 10 条就是未知**（`slice(0, 10)` 的缺口）"] = (t) => {
  const full = Array.from({ length: 10 }, (_v, i) => `e${i + 1}`);
  t.eq(treatmentFromRecord({ quality: { missingFailures: full } }, "e99"), { listed: null, via: "record-truncated" }, "满 10 条 ⇒ 不可判，不许冒充写了");
  t.eq(treatmentFromRecord({ quality: { missingFailures: ["e1"] } }, "e99"), { listed: true, via: "record-listed" }, "未截断才敢判");
  t.eq(treatmentFromRecord({ quality: null }, "e1"), { listed: null, via: "unrecorded" }, "没有 quality ⇒ 不可判");
  t.eq(treatmentFromRecord({}, "e1"), { listed: null, via: "unrecorded" }, "缺 missingFailures ⇒ 不可判");
};

tests["A-7 口径分派：text 口径查正文，record 口径查记录（别在别处再写一次 if）"] = (t) => {
  const text = "## 已探明死路\n- e1 「x」→ y";
  const mark = { quality: { missingFailures: [] } };
  t.eq(treatmentOf({ account: accountOf("R"), mark, summaryText: text, edgeId: "e1" }).via, "model", "R 走正文");
  t.eq(treatmentOf({ account: accountOf("P"), mark, summaryText: text, edgeId: "e1" }).via, "record-listed", "P 走记录");
};

/* ─────────────────────── ③ 三档判据 ─────────────────────── */

tests["A-8 T1：sig 相同才算；sig 不同但 action 相同 ⇒ 不是 T1"] = (t) => {
  const dead = { action: "edit(file_path=a.mjs)", sig: "aaaa", errorSnippet: "x" };
  t.eq(tierHit("T1", dead, { action: "edit(file_path=a.mjs)", sig: "aaaa" }), true, "sig 相同");
  t.eq(tierHit("T1", dead, { action: "edit(file_path=a.mjs)", sig: "bbbb" }), false, "**改一个字符就看不见**（T56 的下界）");
};

tests["A-9 T1 回落：两边都没有 sig ⇒ 按 actionSummary 相等（老边的唯一残余信息）"] = (t) => {
  const dead = { action: "edit(file_path=a.mjs)" };
  t.eq(tierHit("T1", dead, { action: "edit(file_path=a.mjs)" }), true, "action 摘要相同");
  t.eq(tierHit("T1", dead, { action: "edit(file_path=b.mjs)" }), false, "不同文件不算");
  // 世代不可比：老边 act: 与新边 sig: 前缀不同 ⇒ 永不相等
  t.eq(signatureKeyOf({ action: "edit(file_path=a.mjs)" }).startsWith("act:"), true, "老边 act:");
  t.eq(signatureKeyOf({ action: "edit(file_path=a.mjs)", sig: "aaaa" }).startsWith("sig:"), true, "新边 sig:");
};

tests["A-10 T2：同工具 + 参数前缀 ≥ 12 才算；不同工具一律不算"] = (t) => {
  const dead = { action: "edit(file_path=E:/proj/src/alpha.mjs)", errorSnippet: "x" };
  t.eq(commonPrefixLen(argsOfAction(dead.action), argsOfAction("edit(file_path=E:/proj/src/beta.mjs)")) >= PREFIX_MIN, true, "（前置）前缀够长");
  t.eq(tierHit("T2", dead, { action: "edit(file_path=E:/proj/src/beta.mjs)" }), true, "同一目录换个文件名 ⇒ T2");
  t.eq(tierHit("T2", dead, { action: "read(file_path=E:/proj/src/alpha.mjs)" }), false, "不同工具不算");
  t.eq(tierHit("T2", dead, { action: "edit(file_path=D:/other/z.mjs)" }), false, "前缀不够不算");
};

tests["A-11 T3：同工具 + 同错误类；错误类不同就不算"] = (t) => {
  const dead = { action: "edit(file_path=a.mjs)", errorSnippet: "Error: EACCES permission denied" };
  t.eq(tierHit("T3", dead, { action: "edit(file_path=b.mjs)", errorSnippet: "Error: EACCES permission denied" }), true, "换了目标、同一类错误");
  t.eq(tierHit("T3", dead, { action: "edit(file_path=b.mjs)", errorSnippet: "Error: ENOENT no such file" }), false, "不同错误类");
  t.eq(tierHit("T3", dead, { action: "bash(command=ls)", errorSnippet: "Error: EACCES permission denied" }), false, "不同工具不算");
};

tests["A-12 错误类归一化：闭集 + 路径/数字归一（改一个路径不该换类）"] = (t) => {
  t.eq(errorClassOf("Error: EACCES: permission denied, open 'x'"), "permission", "权限");
  t.eq(errorClassOf("Error: ENOENT: no such file or directory"), "missing", "缺文件");
  t.eq(errorClassOf("bash: timeout"), "timeout", "超时");
  t.eq(errorClassOf("exit code 1"), "exit-1", "退出码");
  t.eq(
    errorClassOf("TypeError: x is not a function at /d/a/b.mjs:12:3"),
    errorClassOf("TypeError: x is not a function at /d/c/d.mjs:99:7"),
    "POSIX 路径与行号归一后同类（只认 Windows 盘符会把跨平台同类错误拆两类）",
  );
  t.eq(
    errorClassOf("Error: ENOENT: open 'D:\a\b.txt'"),
    errorClassOf("Error: ENOENT: open 'D:\c\d.txt'"),
    "Windows 路径同样归一",
  );
};

tests["A-13 三档不是嵌套关系（不许由一档推另一档）"] = (t) => {
  // 同一工具、同错误类，但参数前缀极短 ⇒ T3 命中、T2 不命中
  const dead = { action: "edit(a=1)", errorSnippet: "boom" };
  const post = { action: "edit(b=2)", errorSnippet: "boom" };
  t.eq(tierHit("T2", dead, post), false, "前缀不足 ⇒ T2 不中");
  t.eq(tierHit("T3", dead, post), true, "错误类相同 ⇒ T3 中");
  t.eq(tierHit("T1", dead, post), false, "不同 action ⇒ T1 不中");
};

tests["A-14 action 解析：`tool(args)` 两种边界（无括号 / 参数里带括号）"] = (t) => {
  t.eq(toolOfAction("bash(command=echo hi)"), "bash", "工具名");
  t.eq(argsOfAction("bash(command=echo hi)"), "command=echo hi", "参数");
  t.eq(toolOfAction("read"), "read", "无括号");
  t.eq(argsOfAction("read"), "", "无括号 ⇒ 空串");
  t.eq(argsOfAction("bash(command=echo (hi))"), "command=echo (hi)", "参数里带括号按**最后一个** ) 切");
};

/* ─────────────────────── ④ 归档闸门（改造 A） ─────────────────────── */

tests["A-15 未归档 ⇒ archived=false（活会话的「未来」还在写，那是右删失不是观测）"] = (t) => {
  const g = makeGraph({
    nodes: [{ id: "n1", kind: "user", seq: 1 }, { id: "n2", kind: "agent", seq: 900 }],
    edges: [okEdge("e1", 900)],
    closeout: null,
  });
  const point = archivePointOf(g);
  t.eq(point.archived, false, "没有 closeout");
  t.ok(point.why.includes("右删失"), `原因要写清：${point.why}`);
  const windowRow = archiveWindowOf(g, markOf(10, 100), { archived: point.archived, archiveSeq: point.archiveSeq });
  t.eq(windowRow.filable, false, "未归档 ⇒ 一条都不许进样本");
};

tests["A-16 归档快照里没有任何实体 ⇒ 也不算归档观测"] = (t) => {
  const g = makeGraph({ nodes: [], edges: [], closeout: { at: NOW } });
  t.eq(archivePointOf(g).archived, false, "空图 ⇒ archiveSeq = 0");
};

tests["A-17 窗口为空（折叠区间已到归档点）⇒ filable=false"] = (t) => {
  const g = makeGraph({
    nodes: [{ id: "n1", kind: "user", seq: 1 }, { id: "n2", kind: "agent", seq: 100 }],
    edges: [okEdge("e1", 100)],
  });
  const windowRow = archiveWindowOf(g, markOf(10, 100), { archiveSeq: graphMaxSeqOf(g) });
  t.eq(windowRow.filable, false, "seqEnd = archiveSeq ⇒ 没有未来");
  t.eq(windowRow.tailGap, 0, "离归档距离 = 0");
};

tests["A-18 窗口内没有实体（右删失）⇒ filable=false，不是「避开了」"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1 },
      { id: "n2", kind: "agent", seq: 50 },
      { id: "n3", kind: "agent", seq: 900 },
    ],
    edges: [okEdge("e1", 50), okEdge("e2", 900)],
  });
  // 把 n3 藏起来：让「900」只出现在归档点之外…… 这里直接用 entities 注入更直白
  const windowRow = archiveWindowOf(g, markOf(10, 50), { archiveSeq: 900, entities: [1, 50] });
  t.eq(windowRow.filable, false, "窗口 (50, 900] 内一个实体都没有");
  t.ok(windowRow.why.includes("右删失"), `原因要写清：${windowRow.why}`);
};

tests["A-19 正常归档折痕 ⇒ filable=true，tailGap/span 算对"] = (t) => {
  const g = makeGraph({
    nodes: [{ id: "n1", kind: "user", seq: 1 }, { id: "n2", kind: "agent", seq: 900 }],
    edges: [okEdge("e1", 900)],
  });
  const windowRow = archiveWindowOf(g, markOf(10, 100), { archiveSeq: 900 });
  t.eq(windowRow.filable, true, "有未来");
  t.eq([windowRow.lo, windowRow.hi], [10, 100], "区间");
  t.eq(windowRow.tailGap, 800, "离归档 800");
  t.eq(windowRow.span, 91, "跨度 = 100-10+1");
};

tests["A-20 折痕区间反了（seqStart > seqEnd）也要归一"] = (t) => {
  const g = makeGraph({
    nodes: [{ id: "n1", kind: "user", seq: 1 }, { id: "n2", kind: "agent", seq: 900 }],
    edges: [okEdge("e1", 900)],
  });
  const windowRow = archiveWindowOf(g, markOf(100, 10), { archiveSeq: 900 });
  t.eq([windowRow.lo, windowRow.hi], [10, 100], "方向自愈（C194 的同一类风险）");
  t.eq(windowRow.filable, true, "仍然可观测");
};

/* ─────────────────────── ⑤ 分层（hot / cold / 未观测） ─────────────────────── */

tests["A-21 分层：日志读不到 ⇒ **未观测**，绝不许并进 cold"] = (t) => {
  const stratum = stratumOf(null, { hi: 100, archiveSeq: 900 });
  t.eq(stratum.observed, false, "observed=false");
  t.eq(stratum.key, "unobserved", "第三态");
  t.eq(stratum.hotLedger, null, "不知道就是 null，不是 false");
};

tests["A-22 分层：热清单在折叠后注入 ⇒ hot；只在折叠前注入 ⇒ 不算"] = (t) => {
  const injection = [
    { seq: 50, kind: "chess-context" },
    { seq: 200, kind: "chess-context" },
  ];
  t.eq(stratumOf(injection, { hi: 100, archiveSeq: 900 }).key, "hot", "200 > 100 ⇒ hot");
  t.eq(stratumOf([{ seq: 50, kind: "chess-context" }], { hi: 100, archiveSeq: 900 }).key, "cold", "50 < 100 ⇒ 折叠前，不算");
};

tests["A-23 分层：只有 compact-checkpoint 也算 cold（它是摘要本身，不是热清单）"] = (t) => {
  const stratum = stratumOf([{ seq: 200, kind: "compact-checkpoint" }], { hi: 100, archiveSeq: 900 });
  t.eq(stratum.key, "cold", "没有热清单 ⇒ cold");
  t.eq(stratum.checkpoint, true, "但 checkpoint 要单独记下来");
  t.eq(stratum.hotLedger, false, "hotLedger=false");
};

tests["A-24 分层：归档点之后的注入不算（那是**下一个任务**的事）"] = (t) => {
  t.eq(stratumOf([{ seq: 5_000, kind: "chess-context" }], { hi: 100, archiveSeq: 900 }).key, "cold", "5000 > 900 ⇒ 越界，不算");
};

tests["A-25 注入事件解析：两种历史形状都认（data.source / message.source）"] = (t) => {
  const events = [
    { type: "user/message", seq: 10, data: { source: { kind: "chess-context" } } },
    { type: "user/message", seq: 20, message: { source: { kind: "compact-checkpoint" } } },
    { type: "assistant/message", seq: 30, data: { source: { kind: "chess-context" } } },
    { type: "user/message", seq: 40, data: { source: { kind: "human" } } },
  ];
  t.eq(injectionSeqsOf(events), [{ seq: 10, kind: "chess-context" }, { seq: 20, kind: "compact-checkpoint" }], "只留两种注入源");
  t.eq(injectionSeqsOf(null), null, "没解出来 ⇒ null（不是空数组）");
};

/* ─────────────────────── ⑥ 四格与精确率/召回率 ─────────────────────── */

tests["A-26 四格：精确率/召回率/反事实差的定义"] = (t) => {
  const rows = [
    // 列了 + 重踩 3
    ...Array.from({ length: 3 }, () => ({ listed: true, retreaded: true })),
    // 列了 + 避开 17
    ...Array.from({ length: 17 }, () => ({ listed: true, retreaded: false })),
    // 没列 + 重踩 1
    { listed: false, retreaded: true },
    // 没列 + 避开 4
    ...Array.from({ length: 4 }, () => ({ listed: false, retreaded: false })),
  ];
  const q = buildQuadrant(rows);
  t.eq([q.listedRetread, q.listedAvoided, q.unlistedRetread, q.unlistedAvoided], [3, 17, 1, 4], "四格");
  t.eq(q.precision, 17 / 20, "精确率 = 避开/列了");
  t.eq(q.recall, 17 / 21, "召回率 = 列了/避开");
  t.eq(q.retreadRateListed, 3 / 20, "列了侧重踩率");
  t.eq(q.retreadRateUnlisted, 1 / 5, "没列侧重踩率");
  t.eq(q.retreadGapUnlistedMinusListed, 1 / 5 - 3 / 20, "反事实差 = 没列 − 列了");
  t.eq(q.listedShare, 20 / 25, "列了占比");
  t.eq(q.minCell, 1, "最小格 = 1（unlistedRetread）");
  t.eq(q.sufficient, false, "最小格 1 < 10 ⇒ 样本不足");
};

tests["A-27 四格：行不可判（listed=null）**不进任何格**，单独数 unjudged"] = (t) => {
  const q = buildQuadrant([
    { listed: null, retreaded: true },
    { listed: null, retreaded: false },
    { listed: true, retreaded: false },
  ]);
  t.eq(q.unjudged, 2, "不可判 2 条");
  t.eq(q.judged, 1, "可判 1 条");
  t.eq([q.listedRetread, q.listedAvoided, q.unlistedRetread, q.unlistedAvoided], [0, 1, 0, 0], "不可判的不许算成「没列」");
};

tests["A-28 四格：全空时率是 null，不是 0（缺测 ≠ 命中 0）"] = (t) => {
  const q = buildQuadrant([]);
  t.eq(q.precision, null, "精确率 null");
  t.eq(q.recall, null, "召回率 null");
  t.eq(q.listedShare, null, "列了占比 null");
  t.eq(q.sufficient, false, "空样本永远不够");
  t.eq(buildQuadrant([]).judged, 0, "空桶");
  t.eq(emptyQuadrant().unjudged, 0, "空桶（原始字段）");
};

tests["A-29 Fisher 精确检验：已知值（双侧）"] = (t) => {
  // 经典「品茶」2×2：[[3,1],[1,3]] 双侧 p = 34/70
  t.ok(Math.abs(fisherExact(3, 1, 1, 3) - 34 / 70) < 1e-12, "经典值 34/70（浮点容差 1e-12）");
  t.eq(fisherExact(0, 5, 0, 5), 1, "完全一致 ⇒ p = 1");
  t.eq(fisherExact(0, 0, 0, 0), null, "空表 ⇒ null（不是 1）");
  const extreme = fisherExact(10, 0, 0, 10);
  t.ok(extreme !== null && extreme < 0.001, `完全分离要显著（p=${extreme}）`);
};

/* ─────────────────────── ⑦ 判据必须能红 ─────────────────────── */

tests["A-30 判据 ① 必须能红：常函数池 ⇒ 不通过"] = (t) => {
  const result = {
    byAccount: {
      P: {
        strata: {
          hot: { quadrant: buildQuadrant(Array.from({ length: 50 }, () => ({ listed: true, retreaded: false }))) },
          cold: { quadrant: buildQuadrant([]) },
        },
      },
      R: {
        strata: {
          hot: { quadrant: buildQuadrant([]) },
          cold: { quadrant: buildQuadrant([]) },
        },
      },
    },
    correlations: { P: { tailGap: { n: 0, spearman: null }, span: { n: 0, spearman: null } }, R: {} },
    correlationAccount: "P",
    repairContamination: { textAccountJudged: 0, repairedOnly: 0, repairedShare: null },
  };
  const criteria = judgeCriteria(result);
  t.eq(criteria.length, 4, "四条");
  t.eq(criteria[0].pass, false, "**全部避开 ⇒ 众数占比 100% ⇒ ① 必须红**（否则就是假门禁）");
  t.eq(criteria[0].value, 1, "众数占比 = 1");
};

tests["A-31 判据 ① 也要能绿：四格摊开且治疗不是一个值"] = (t) => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({ listed: true, retreaded: false })),
    ...Array.from({ length: 20 }, () => ({ listed: true, retreaded: true })),
    ...Array.from({ length: 20 }, () => ({ listed: false, retreaded: false })),
    ...Array.from({ length: 20 }, () => ({ listed: false, retreaded: true })),
  ];
  const result = {
    byAccount: {
      P: {
        strata: {
          hot: { quadrant: buildQuadrant(rows) },
          cold: { quadrant: buildQuadrant([]) },
        },
      },
      R: { strata: { hot: { quadrant: buildQuadrant([]) }, cold: { quadrant: buildQuadrant([]) } } },
    },
    correlations: { P: { tailGap: { n: 50, spearman: 0.01 }, span: { n: 50, spearman: 0.02 } }, R: {} },
    correlationAccount: "P",
    repairContamination: { textAccountJudged: 0, repairedOnly: 0, repairedShare: null },
  };
  const criteria = judgeCriteria(result);
  t.eq(criteria[0].value, 0.25, "众数占比 25%（四格各 20 条）");
  t.eq(criteria[0].treatmentShare, 0.5, "列了占比 50%");
  t.eq(criteria[0].pass, true, "25% < 80% 且列了占比 50% < 95% ⇒ 绿");
};

tests["A-32 判据 ④ 必须能红：治疗变量被机械补回污染时"] = (t) => {
  const result = {
    byAccount: { P: { strata: { hot: { quadrant: buildQuadrant([]) }, cold: { quadrant: buildQuadrant([]) } } }, R: { strata: { hot: { quadrant: buildQuadrant([]) }, cold: { quadrant: buildQuadrant([]) } } } },
    correlations: { P: {}, R: {} },
    correlationAccount: "R",
    repairContamination: { textAccountJudged: 100, repairedOnly: 40, repairedShare: 0.4 },
  };
  const criteria = judgeCriteria(result);
  t.eq(criteria[3].pass, false, "40% 的「列了」来自补回函数 ⇒ ④ 必须红");
  t.eq(criteria[3].value, 0.4, "污染比例原样带出来");
};

/* ─────────────────────── ⑧ 折痕行 ─────────────────────── */

tests["A-33 折痕行：三档各算各的，listed 来自口径"] = (t) => {
  const g = makeGraph({
    nodes: [
      { id: "n1", kind: "user", seq: 1 },
      { id: "n2", kind: "agent", seq: 60 },
      { id: "n3", kind: "agent", seq: 900 },
    ],
    edges: [
      // 折叠区间内的两条死路
      failEdge("e1", 20, { action: "edit(file_path=E:/proj/src/alpha.mjs)", sig: "1111" }),
      failEdge("e2", 30, { action: "read(file_path=E:/proj/beta.md)", sig: "2222" }),
      // 折叠之后的失败边：e11 与 e1 逐字相同；e12 与 e2 同工具+前缀
      failEdge("e11", 200, { action: "edit(file_path=E:/proj/src/alpha.mjs)", sig: "1111" }),
      failEdge("e12", 300, { action: "read(file_path=E:/proj/gamma.md)", sig: "3333" }),
    ],
  });
  const row = markQuadrant({
    graph: g,
    mark: markOf(10, 100, { quality: { missingFailures: ["e2"] } }),
    account: accountOf("P"),
    window: archiveWindowOf(g, markOf(10, 100), { archiveSeq: 900 }),
    injection: [],
  });
  t.eq(row.deadEnds, 2, "区间内 2 条死路");
  t.eq(row.judged, 2, "两条都可判（记录口径）");
  t.eq(row.retreads.T1, 1, "T1：只有 e1（sig 相同）");
  t.eq(row.retreads.T2, 2, "T2：e2 的前缀是 `file_path=E:/proj/` = 18 字符 ≥ 12，e1 同 action 也命中");
  t.eq(row.retreads.T3, 2, "T3：两条的错误类都相同");
  t.eq(row.listedRetreads.T1, 1, "e1 列了且重踩 ⇒ 左上格");
  t.eq(row.listedRetreads.T2, 1, "T2 的左上格同样只有 e1（e2 是没列那一行）");
};

tests["A-34 折痕行：窗口不可观测时全空（不许硬算）"] = (t) => {
  const g = makeGraph({ nodes: [{ id: "n1", kind: "user", seq: 1 }, { id: "n2", kind: "agent", seq: 100 }], edges: [okEdge("e1", 100)] });
  const row = markQuadrant({
    graph: g,
    mark: markOf(10, 100),
    account: accountOf("P"),
    window: archiveWindowOf(g, markOf(10, 100), { archiveSeq: 100 }),
    injection: [],
  });
  t.eq(row.deadEnds, 0, "窗口不可观测 ⇒ 不数死路");
  t.eq(row.judged, 0, "不判");
  t.eq(row.retreads.T1, 0, "不重踩（也不是「避开了」）");
};

/* ─────────────────────── ⑨ 端到端（真读临时 home） ─────────────────────── */

/** 造一个临时 home：一个会话图 + 一份 zstd 日志。 */
function makeHome({ withLog = true, hotLedger = true } = {}) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "archive-quadrant-"));
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const graphDir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(graphDir, { recursive: true });

  const graph = makeGraph({
    sessionId,
    nodes: [
      { id: "n1", kind: "user", seq: 1 },
      { id: "n2", kind: "agent", seq: 60 },
      { id: "n3", kind: "agent", seq: 900 },
    ],
    edges: [
      failEdge("e1", 20, { action: "edit(file_path=E:/proj/src/alpha.mjs)", sig: "1111" }),
      failEdge("e2", 30, { action: "read(file_path=E:/proj/beta.md)", sig: "2222" }),
      failEdge("e11", 200, { action: "edit(file_path=E:/proj/src/alpha.mjs)", sig: "1111" }),
    ],
    marks: [markOf(10, 100, { quality: { missingFailures: ["e2"] } })],
    closeout: { at: NOW, source: "archive" },
  });
  nodeFs.writeFileSync(nodePath.join(graphDir, "graph.json"), JSON.stringify(graph, null, 1));

  if (withLog) {
    const logDir = nodePath.join(home, "sessions", "cwd-hash");
    nodeFs.mkdirSync(logDir, { recursive: true });
    const events = hotLedger
      ? [{ type: "user/message", seq: 400, data: { source: { kind: "chess-context" } } }]
      : [{ type: "user/message", seq: 400, data: { source: { kind: "compact-checkpoint" } } }];
    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    nodeFs.writeFileSync(nodePath.join(logDir, `${sessionId}.zstd`), nodeZlib.zstdCompressSync(Buffer.from(text)));
  }
  return { home, sessionId };
}

tests["A-35 端到端：读临时 home，漏斗与四格对得上"] = (t) => {
  const { home } = makeHome();
  try {
    const result = audit.audit({ home, logs: "all" });
    t.eq(result.graphs, 1, "1 张图");
    t.eq(result.funnel.foldMarks, 1, "1 条折痕");
    t.eq(result.funnel.filable, 1, "通过归档闸门");
    t.eq(result.funnel.prospective, 1, "pressure ⇒ 前瞻性");
    t.eq(result.funnel.deadEnds, 2, "区间内 2 条死路");
    t.eq(result.funnel.logMissing, 0, "日志读到了");
    t.eq(result.funnel.summaryTextMarks, 0, "pressure 不落正文（正文口径不可判）");

    const hot = result.byAccount.P.strata.hot.tiers.T1.quadrant;
    // e1 列了且被 e11 逐字重踩；e2 没列（missingFailures）且折叠后没有再失败 ⇒ 没列 + 避开
    t.eq([hot.listedRetread, hot.listedAvoided, hot.unlistedRetread, hot.unlistedAvoided], [1, 0, 0, 1], "四格");
    t.eq(result.byAccount.P.strata.cold.tiers.T1.quadrant.judged, 0, "冷层没有样本");
    t.eq(result.byAccount.P.marks.hot, 1, "热清单层 1 条折痕");

    // 单条夹具：结果摊平（50/50）⇒ ① 判据本身不红；但四格最小格 = 0 ⇒ **样本不足以判**
    t.eq(result.criteria[0].pass, true, "夹具太小，① 的数值本身不过线（真正的红在 A-30 钉）");
    t.eq(result.verdict, "insufficient", "**样本不足必须单独一态**，不许混进 usable");
    t.eq(result.sample.sufficient.length, 0, "最小格 0 ⇒ 一组都不够");

    const report = renderReport(result);
    t.includes(report, "归档时刻四格审计", "报告标题");
    t.includes(report, "样本漏斗", "必须打漏斗（否则率会被误读）");
    t.includes(report, "样本不足以下结论", "最小格 < 10 必须明说");
    t.includes(report, "T1 · 逐字相同", "三档都要列");
    t.includes(report, "T2 · 同工具 + 参数前缀", "三档都要列");
    t.includes(report, "T3 · 同工具 + 同错误类", "三档都要列");
    t.eq(JSON.parse(JSON.stringify(result.funnel)).foldMarks, 1, "结果可 JSON 序列化（--json 用）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["A-36 端到端：没有日志 ⇒ 分层记「未观测」，四格全空（不是全避开）"] = (t) => {
  const { home } = makeHome({ withLog: false });
  try {
    const result = audit.audit({ home, logs: "all" });
    t.eq(result.funnel.logMissing, 1, "日志读不到要计数");
    t.eq(result.funnel.withDeadEnds, 0, "没有一条能进四格");
    t.eq(result.byAccount.P.strata.hot.tiers.T1.quadrant.judged, 0, "热层空");
    t.eq(result.byAccount.P.strata.cold.tiers.T1.quadrant.judged, 0, "冷层也空（**不许**把未观测算成 cold）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["A-37 端到端：只有 compact-checkpoint 的会话落在 cold 层"] = (t) => {
  const { home } = makeHome({ hotLedger: false });
  try {
    const result = audit.audit({ home, logs: "all" });
    t.eq(result.byAccount.P.marks.cold, 1, "cold 层 1 条折痕");
    t.eq(result.byAccount.P.strata.cold.tiers.T1.quadrant.judged, 2, "死路进 cold 层");
    t.eq(result.byAccount.P.strata.hot.tiers.T1.quadrant.judged, 0, "hot 层空");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["A-38 一张图都没有 ⇒ 退出码 2（home 给错了要说清楚）"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "archive-quadrant-empty-"));
  try {
    const original = console.error;
    let stderr = "";
    console.error = (message) => {
      stderr += String(message);
    };
    let code = 0;
    try {
      code = main([`--home=${home}`]);
    } finally {
      console.error = original;
    }
    t.eq(code, 2, "读不到任何会话图要退 2，不许安静地报 0 条");
    t.includes(stderr, "一张图都读不到", "错误信息要指路");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ─────────────────────── ⑩ 命令行参数 ─────────────────────── */

tests["A-39 参数解析：默认值与各开关"] = (t) => {
  t.eq(parseArgs([]), { json: false, logs: "all", home: null, session: "", limit: 20 }, "默认");
  t.eq(parseArgs(["--json", "--no-logs"]).logs, "none", "--no-logs");
  t.eq(parseArgs(["--json"]).json, true, "--json");
  t.eq(parseArgs(["--home=E:/x"]).home, "E:/x", "--home=");
  t.eq(parseArgs(["--limit=5"]).limit, 5, "--limit=");
  t.eq(parseArgs(["--session=abc"]).session, "abc", "--session=");
};

tests["A-40 口径与常量：三条口径/两层/三档的口径说明不能少"] = (t) => {
  t.eq(ACCOUNTS.map((item) => item.key), ["P", "R"], "两条口径按报告顺序");
  t.eq(ACCOUNTS[0].prospective, true, "P = 前瞻性");
  t.eq(ACCOUNTS[1].prospective, false, "R = 回溯性");
  t.eq(STRATA.map((item) => item.key), ["hot", "cold"], "两层");
  t.eq(TIERS.map((item) => item.key), ["T1", "T2", "T3"], "三档");
  for (const tier of TIERS) {
    t.ok(String(tier.meaning).length > 10, `${tier.key} 必须写含义（换档不换说明就会让人拿错档读对的结论）`);
    t.ok(String(tier.risk).length > 10, `${tier.key} 必须写误判风险`);
  }
  t.eq(MIN_CELL, 10, "样本门槛");
  t.eq(PREFIX_MIN, 12, "T2 前缀门槛");
  t.ok(MAX_TREATMENT_SHARE > 0.8, "治疗常函数门槛要严于判据 ①，否则两处口径打架");
};
