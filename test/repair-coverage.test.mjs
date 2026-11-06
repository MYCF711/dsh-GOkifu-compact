/**
 * repair-coverage.test.mjs —— **「死路补回到底有没有接线」的守卫**（C641）
 *
 * 由来（真机统计自相矛盾，两条同时成立）：
 *   · 534 条 `trigger=archive-offline` 的 foldMark 里 `quality.failuresRepaired` **出现 0 次**；
 *   · 同一批里 `failureRecall < 1` 的有 **18 条**。
 *   按 C607 的设计 `failureRecall` 应恒 = 1（补回后重新测量），两条同时成立只可能是补回**没跑**。
 *   逐条审计（`scripts/repair-coverage-audit.mjs`，真机 18/18）给出的结论是 **A 类**：
 *   补回函数**没被执行** —— 写这些折痕的进程里还没有这段代码（宿主启动时加载 ESM，
 *   改代码不重启不生效；进程 02:30:34 启动，补回 03:11:46 才进仓库）。
 *
 * 但审计同时挖出**第二条、代码级**的缺口，本文件钉的就是它：
 *   `trigger=archive-offline` 有**两个**生产者 —— 引擎（`runOfflineFold`）与脚本
 *   （`scripts/archive-fold.mjs`：自己 `measureFoldQuality` 之后直接调 `applyOfflineFoldToGraph`）。
 *   C607 的补回只长在 `runOfflineFold` 里面 ⇒ 脚本那条路**永远**补不回来，
 *   它的折痕会一直 `failureRecall < 1` 且没有 `failuresRepaired`（**重启也不会好**）。
 *
 * 修法：把补回接到**写回点**（`applyOfflineFoldToGraph`）—— 那是所有折痕的必经之路
 * （与 `test/archive-fold.test.mjs` 的「写回必须走共享实现」同一条纪律），
 * 并让 `failuresRepaired` **恒在场**（0 也写）：字段缺失只该有一种解释 ——「生产者比 C641 老」。
 *
 * 本文件在**旧实现**下必红（见交付报告里的 A/B 对照：`git stash` 后跑本文件）。
 */
// ★ 用「命名空间导入」：旧实现里没有 `repairFailuresInText`，具名导入会让整个 run.mjs 在
//   import 阶段崩掉（它不接 import 错误）—— 那样**后面所有测试文件都不会跑**，
//   一次回归把全库变成"跑不了"。命名空间导入下，缺函数只让**这一条用例**红。
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import * as offlineFold from "../src/rooms/offline-fold.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";

const { applyOfflineFoldToGraph, repairFailuresInText, runOfflineFold } = offlineFold;

export const tests = {};

/* ───────────────────── 真机夹具（`<SESSION_ID>` 的 archive-offline 折痕） ───────────────────── */
/**
 * 那一条 mark 的形状（逐字来自 graph.json）：
 *   `seqStart=10 seqEnd=217` · `quality.failureRecall=0.75` · `expectedFailures=4` ·
 *   `quality.missingFailures=["e46"]` · **没有** `failuresRepaired`。
 * 4 条失败边的 evidence 都落在区间内，摘要里只提到了 e43 / e44 / e45。
 */
const failedEdit = (id, file, start, end) => ({
  id,
  // `from`/`to` 必须在图里：`classifyDangling` 会把 `to == null` 的旧边归成 residue，
  // 而 residue **不是**「哪一步失败了」，探针会先把它们排除掉（`failuresInFoldRange`）。
  from: "n1",
  to: "n2",
  intent: "",
  result: "failure",
  action: `edit(file_path=${file})`,
  errorSnippet: `Error: cannot modify "${file}": file has not been read`,
  evidence: { start, end },
  ts: 1793746126291,
});

function makeGraph() {
  return {
    rootUserNodeIds: ["n1"],
    order: ["n1", "n2"],
    nodes: {
      n1: { id: "n1", seq: 5, kind: "user", text: "把这批文档改完并核验", constraints: ["不许动 prod 配置"] },
      n2: { id: "n2", seq: 12, kind: "state", text: "连续 edit 被拒" },
    },
    edges: {
      e43: failedEdit("e43", "full-host-verification.md", 20, 22),
      e44: failedEdit("e44", "hmr-verification.md", 24, 26),
      e45: failedEdit("e45", "model-verification.md", 28, 30),
      e46: failedEdit("e46", "nested-verification.md", 32, 34),
      // 区间**外**（300 > 217）：不是这次的死路，补回时不许越权带进来
      e47: failedEdit("e47", "outside-range.md", 300, 301),
    },
  };
}

/** 真机摘要（abridged）：逐条写了 3 条，第 4 条（e46）整条消失 ⇒ failureRecall 0.75。 */
const SUMMARY_MISSING_E46 = [
  "## 目标",
  "- 把这批文档改完并核验",
  "",
  "## 已探明死路",
  '- e43 「edit(file_path=full-host-verification.md)」→ cannot modify（file has not been read）',
  '- e44 「edit(file_path=hmr-verification.md)」→ cannot modify（file has not been read）',
  '- e45 「edit(file_path=model-verification.md)」→ cannot modify（file has not been read）',
  "",
  "## 约束（逐字）",
  "- 不许动 prod 配置",
].join("\n");

/** 真机记录的那份 quality（补回前算的）。 */
const RECORDED_QUALITY = Object.freeze({
  constraintRecall: 1,
  failureRecall: 0.75,
  expectedConstraints: 1,
  expectedFailures: 4,
  missingConstraints: [],
  missingFailures: ["e46"],
  summaryTokens: 320,
  shadowedTokens: null,
  compressionRatio: null,
  unknownIds: [],
  outOfRangeIds: [],
  outOfRangeEarlier: [],
  outOfRangeLater: [],
  modelConstraintRecall: 0.9,
});

const countOf = (text, needle) => String(text).split(needle).length - 1;

/* ───────────────────────── ① A 类：写回点必须补回（旧实现必红） ───────────────────────── */

tests["C641 写回点补回：脚本生产者（quality 已记 failureRecall=0.75）⇒ mark 必须补回 e46 并改成 1"] = (t) => {
  const graph = makeGraph();
  const chunk = { start: 10, end: 217, text: SUMMARY_MISSING_E46, quality: { ...RECORDED_QUALITY }, repaired: 0 };
  applyOfflineFoldToGraph(graph, { chunks: [chunk] }, { now: 1, provider: "magpie", model: "group/deepseek-v4.1-flash1017" });
  const mark = graph.foldMarks[0];

  t.eq(mark.quality.failureRecall, 1, "补回后 failureRecall 必须 = 1（契约：死路逐条出现）");
  t.eq(mark.quality.missingFailures, [], "补回后 missingFailures 必须清空");
  t.eq(mark.quality.failuresRepaired, 1, "补回的条数要留痕（旧实现这里是 undefined）");
  t.eq(mark.quality.failuresRepairedIds, ["e46"], "补回的是哪一条也要留痕");
  t.includes(graph.lastOfflineSummary.text, "- e46 「edit(file_path=nested-verification.md)」", "补回行写进摘要原文（id + 动作）");
  t.includes(graph.lastOfflineSummary.text, "file has not been read", "补回行要带「为什么失败」");
  t.eq(countOf(graph.lastOfflineSummary.text, "e46"), 1, "同一条边只许补一行（补回不是堆砌）");
  t.eq(graph.lastOfflineSummary.text.length, mark.summaryChars, "summaryChars 必须与落盘的摘要逐字对得上");
  t.eq(mark.quality.constraintRecall, 1, "约束侧字段原样保留（补回不许改别的指标）");
  t.eq(mark.quality.modelConstraintRecall, 0.9, "模型侧保真度原样保留（那是「模型自己漏了多少」的唯一证据）");
};

/* ───────────────────── ② 统计口径：没补回也要留痕（0 与「没有这个字段」必须能分开） ───────────────────── */

tests["C641 没补回也要留痕：failuresRepaired=0（否则「0 次」分不清「没跑」与「跑了没漏」）"] = (t) => {
  const graph = makeGraph();
  const full = `${SUMMARY_MISSING_E46}\n- e46 「edit(file_path=nested-verification.md)」→ cannot modify`;
  const chunk = { start: 10, end: 217, text: full, quality: { ...RECORDED_QUALITY, failureRecall: 1, missingFailures: [] }, repaired: 0 };
  applyOfflineFoldToGraph(graph, { chunks: [chunk] }, { now: 2 });
  const mark = graph.foldMarks[0];
  t.eq(mark.quality.failuresRepaired, 0, "一条都没漏 ⇒ 0（**必须写**，不许省略）");
  t.eq(mark.quality.failuresRepairedIds, undefined, "没补回就不该有 id 列表");
  t.eq(mark.quality.failureRecall, 1, "本来就该是 1");
  t.eq(countOf(full, "e46"), 1, "已经写了的别再补（否则摘要里每条死路出现两次）");
};

/* ───────────────────────── ③ 幂等：引擎路已补 ⇒ 写回点空转 ───────────────────────── */

tests["C641 幂等：runOfflineFold 补过的正文，写回点再补一次必须一行都不加"] = async (t) => {
  const graph = makeGraph();
  const events = [
    { type: "user/message", seq: 10, data: { message: { content: [{ type: "text", text: "把这批文档改完" }] } } },
    { type: "assistant/message", seq: 12, data: { message: { content: [{ type: "text", text: "先看 full-host" }] } } },
    { type: "user/message", seq: 217, data: { message: { content: [{ type: "text", text: "改完了吗" }] } } },
  ];
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 10,
    rangeEnd: 217,
    callModel: async () => ({ text: SUMMARY_MISSING_E46, usage: null, model: "fake" }),
    measureQuality: ({ graph: g, range, summaryText }) => measureFoldQuality({ graph: g, range, summaryText }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.repairedFailures, 1, "引擎那条路：模型丢了 e46 ⇒ 补回 1 条");
  t.eq(chunk.quality.failureRecall, 1, "引擎那条路：补回后召回 = 1");
  t.eq(chunk.quality.failuresRepaired, 1, "引擎那条路：留痕字段由 runOfflineFold 写");

  applyOfflineFoldToGraph(graph, out, { now: 3, provider: "offline", model: "fake" });
  const mark = graph.foldMarks[0];
  t.eq(mark.quality.failuresRepaired, 1, "写回点不许把 1 覆盖成 0");
  t.eq(mark.quality.failuresRepairedIds, ["e46"], "id 列表也要保住");
  t.eq(countOf(graph.lastOfflineSummary.text, "e46"), 1, "同一条边只出现一次（幂等）");
  t.eq(graph.lastOfflineSummary.text, chunk.text, "落盘摘要与 chunk 正文逐字一致");
};

/* ───────────────────────── ④ 不越权：区间外的死路不许带进来 ───────────────────────── */

tests["C641 不越权：evidence 落在折叠区间外的失败边不许补回"] = (t) => {
  const graph = makeGraph();
  const { text, repaired } = repairFailuresInText(graph, { start: 10, end: 217 }, SUMMARY_MISSING_E46);
  t.eq(repaired, ["e46"], "只补区间内缺的那一条");
  t.eq(text.includes("e47"), false, "e47 在区间外（seq 300）⇒ 不许补");
};

/* ───────────────────── ⑤ 探针失败不许影响写回（C64 同一纪律） ───────────────────── */

tests["C641 探针抛错 ⇒ 写回照常（原文落盘，mark 照写，不许整段失败）"] = (t) => {
  const graph = {
    nodes: {},
    get edges() {
      throw new Error("bad graph: edges exploded");
    },
  };
  const chunk = { start: 1, end: 2, text: "## 目标\n- 原样", quality: { failureRecall: 1, missingFailures: [] }, repaired: 0 };
  applyOfflineFoldToGraph(graph, { chunks: [chunk] }, { now: 4 });
  const mark = graph.foldMarks[0];
  t.eq(graph.lastOfflineSummary.text, "## 目标\n- 原样", "补回不可用 ⇒ 正文原样落盘");
  t.eq(mark.quality.failuresRepaired, 0, "留痕字段仍然要写（0 = 跑了没漏）");
  t.eq(repairFailuresInText(graph, { start: 1, end: 2 }, "x").text, "x", "纯函数自己也吞掉诊断异常");
};

/* ───────────────────── ⑥ 结构守卫：接线点不许被搬回生产者内部 ───────────────────── */

tests["C641 接线守卫：runOfflineFold 与 applyOfflineFoldToGraph 都必须调 repairFailuresInText"] = (t) => {
  const src = offlineFoldSource();
  const applyAt = src.indexOf("export function applyOfflineFoldToGraph");
  const runAt = src.indexOf("export async function runOfflineFold");
  t.eq(applyAt > 0, true, "写回点必须存在");
  t.eq(runAt > 0, true, "编排函数必须存在");
  const applyBody = src.slice(applyAt);
  const runBody = src.slice(runAt, applyAt);
  t.includes(applyBody, "repairFailuresInText(graphRef", "写回点必须补回（脚本那条生产者只经过这里）");
  t.includes(runBody, "repairFailuresInText(graph", "编排函数也要补回（chunk 的 quality 是模型保真度的唯一来源）");
  // 旧写法（内联 IIFE）不许回来：那意味着「补回只有一条路走得到」
  t.eq(runBody.includes("const missingFailureEdges = (() =>"), false, "补回判据不许再内联在 runOfflineFold 里");
  t.includes(applyBody, "qualityWithFailureRepair(", "留痕字段必须由写回点统一补");
};

/** 读源码（结构守卫用；按本文件位置解析，不依赖 cwd —— run.mjs 可在任意目录被拉起）。 */
function offlineFoldSource() {
  return nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "rooms", "offline-fold.mjs"), "utf8");
}
