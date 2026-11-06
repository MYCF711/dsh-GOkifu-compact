/**
 * placeholder.test.mjs —— 死路段 `e?` 占位符的守卫（T30）
 *
 * 由来（2026-11-05，`node scripts/placeholder-audit.mjs` 真机输出）：
 *   死路段里 **811 条**行写成 `e?` / **204 条**折痕，而**真丢的 id 只有 6 个**（全机 10 个缺口的 60%）。
 *   把两个数放在一起才看得出这是个**假警报**：94.57% 的占位符**能反推出本该写哪个 id**
 *   （750 行靠行尾 `(seq a-b)` 精确命中 `evidence` 跨度），把 811 当丢失数会**高估 135 倍**。
 *
 * 真丢的那 6 个 id 全部是**跨界边**（`span.start ≤ 遮蔽终点 < span.end`）：
 *   `failuresInFoldRange` 把它算进本段区间，`sanitizeSummaryIds` 又把它的 id 抹成 `e?` ——
 *   两个判据在边界上打架，而**模型写的是对的**（它逐字照抄了事实块里的 `e###`）。
 *
 * 这个结论最容易被推翻的方式有四种，本文件四样都钉住：
 *   ① **有人把「就地认领」删了** ⇒ 死路段那行永远 `e?`，同一件事写两遍（本文件的真机夹具会红）；
 *   ② **认领越权**（把本段之外 / 有歧义 / 一行多个占位符的也硬认领）⇒ 写错 id 比 `e?` 更坏；
 *   ③ **审计口径退化**（反推退化成「猜」）⇒ 报告又会把可定位的算成丢；
 *   ④ **事实块被误判成「切了 id」** ⇒ 于是有人去改渲染（事实块里 id 一直都在，改它无效）。
 *
 * 真机夹具（真机 `session-8a49-b67bb112299e` 的 `foldMark`，逐字）：
 *   区间 `10-217`；`e46` 的 `evidence` 是 `216-218`（**跨界**）；
 *   模型原文 `- e? `` `Add-Type` 会把旧版 RC 文件版本的编译警告提升为错误；`` → Error: … (seq 216-218)`。
 */
// ★ 命名空间导入：旧实现缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉（C641 的教训）。
import * as offline from "../src/rooms/offline-fold.mjs";
import * as placeholderAudit from "../scripts/placeholder-audit.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";

export const tests = {};

const { renderFacts, repairMissingFailures, repairFailuresInText, runOfflineFold } = offline;

/* ───────────────────────── 真机夹具（形状逐字来自 graph.json） ───────────────────────── */

const DOCS = String.raw`D:\DeepSeek Harness\default-workspace\tmp\dsh-upgrade-0.2.2-rc.1`;

/** 造一条真机形状的失败边（动作是长 Windows 路径，错误是带引号 POSIX 路径 + 原因）。 */
const failedEdit = (id, start, end) => ({
  id,
  // `from`/`to` 必须在图里：`classifyDangling` 会把 `to == null` 的旧边归成 residue，
  // 而 residue **不是**「哪一步失败了」，探针会先把它排除掉（`failuresInFoldRange`）。
  from: "n461",
  to: "n462",
  intent: "把旧版 RC 文件版本的编译警告提升为错误",
  action: `edit(file_path=${DOCS}\\production\\run-tests.ps1)`,
  result: "failure",
  verify: { kind: "host-error", summary: `Error: cannot edit "${DOCS}/production/run-tests.ps1": file changed since it was read` },
  errorSnippet: `Error: cannot edit "${DOCS}/production/run-tests.ps1": file changed since it was read — re-read the file, then retry`,
  evidence: { start, end },
  ts: 1793746126291,
});

/**
 * 图：`e45` 成功（区间内）、`e46` **跨界**（216-218，区间 10-217）、`e47`/`e48` 本段之外。
 *
 * 为什么必须有「本段之外」的边：真机 748 行（92.69%）占位符都是它们 ——
 * 模型从**全局**事实块里抄了死路，sanitize 按设计抹掉 id。认领它们 = 撤掉 C458，本函数不干。
 */
function makeGraph() {
  return {
    rootUserNodeIds: ["n1"],
    order: ["n1", "n461", "n462"],
    nodes: {
      n1: { id: "n1", seq: 1, kind: "user", text: "把升级脚本跑通", constraints: ["只在白名单文件内改动"] },
      n461: { id: "n461", seq: 200, kind: "state", text: "改 run-tests.ps1" },
      n462: { id: "n462", seq: 210, kind: "state", text: "edit 被拒" },
    },
    edges: {
      e45: { id: "e45", from: "n461", to: "n462", action: "bash(npm test)", result: "success", verify: { summary: "12 passed" }, evidence: { start: 20, end: 22 } },
      e46: failedEdit("e46", 216, 218),
      e47: failedEdit("e47", 279, 283),
      e48: failedEdit("e48", 300, 305),
    },
  };
}

/** 本次 fold 的区间（真机那个 mark 的 `seqStart`/`seqEnd`）。 */
const RANGE = { start: 10, end: 217 };

/** 模型原文（真机 abridged）：三行占位符 —— 跨界 / 本段之外 / 反推不出。 */
const MODEL_TEXT = [
  "## 目标",
  "- 把升级脚本跑通",
  "",
  "## 已探明死路",
  `- e? 「把旧版 RC 文件版本的编译警告提升为错误」→ Error: cannot edit "run-tests.ps1": file changed since it was read (seq 216-218)`,
  `- e? 「以后那条」→ Error: cannot edit "run-tests.ps1": file changed since it was read (seq 279-283)`,
  "- e? 没有坐标的自由行 → 什么都没写",
  "",
  "## 约束（逐字）",
  "- 只在白名单文件内改动",
].join("\n");

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(10, "把升级脚本跑通"), a(200, "改 run-tests.ps1"), u(217, "跑完了吗")];

const countOf = (text, needle) => String(text).split(needle).length - 1;

/* ───────────── ① 真机复现：跨界占位符必须**就地**认领（不是再追加一行） ───────────── */

tests["T30 真机复现：跨界 `e?`（seq 216-218）必须就地认领成 e46，且不再追加重复行"] = (t) => {
  const graph = makeGraph();
  const fe = graph.edges.e46;
  const out = repairMissingFailures(MODEL_TEXT, [fe]);
  // ① 那一行本身要拿到 id（旧实现只追加，这一行永远是 e?）
  const deadLine = out.text.split("\n").find((line) => line.includes("e46"));
  t.eq(deadLine.startsWith("- e46 「"), true, "死路段**原来那一行**必须就地拿到 id（不是尾部另起一行）");
  t.eq(countOf(out.text, "e46"), 1, "同一条死路只许出现一次（旧实现是 e? 行 + 追加行 = 两遍）");
  t.eq(out.text.includes("逐字补充"), false, "认领干净了就不该再追加补回段");
  t.eq(out.repaired, ["e46"], "认领也算「补回」，要留痕");
  // ② 别的两行（本段之外 / 无坐标）**一个字节都不许动** —— 认领不是重写全文
  t.includes(out.text, "(seq 279-283)", "本段之外的 e? 不许动（sanitize 的设计）");
  t.includes(out.text, "- e? 没有坐标的自由行", "没有坐标就不许猜");
};

tests["T30 端到端：sanitize 抹掉的跨界 id 由补回认领，failureRecall = 1 且只有一行"] = async (t) => {
  const graph = makeGraph();
  // 模型照抄事实块（写的是具体 id）；sanitize 会把跨界的 e46 抹成 e?；补回再认领回来。
  const summary = MODEL_TEXT.replace("- e? 「把旧版 RC", "- e46 「把旧版 RC");
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: RANGE.start,
    rangeEnd: RANGE.end,
    callModel: async () => ({ text: summary, usage: null, model: "fake" }),
    measureQuality: ({ graph: g, range, summaryText }) => measureFoldQuality({ graph: g, range, summaryText }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.sanitized, 1, "sanitize 必须抹掉 1 个跨界 id（否则夹具没复现真机链路）");
  t.eq(chunk.quality.failureRecall, 1, "补回后 failureRecall 必须 = 1（契约：死路逐条出现）");
  t.eq(chunk.quality.failuresRepaired, 1, "补回 1 条要留痕");
  t.eq(countOf(chunk.text, "e46"), 1, "e46 只许出现一次");
  const deadLine = chunk.text.split("\n").find((line) => line.includes("e46"));
  t.eq(deadLine.startsWith("- e46 「"), true, "id 要落回死路段**原来那一行**（读者才定位得到）");
  t.eq(chunk.text.includes("逐字补充"), false, "就地认领之后不需要补回段");
};

/* ───────────── ② 认领的边界：越权比 e? 更坏 ───────────── */

tests["T30 不许越权：本段之外的 `e?`（span.start > 区间终点）不认领"] = (t) => {
  const graph = makeGraph();
  // 正文里只有 e47（279-283，本段之外）是 e?；e46 反而没写 —— 补回只该追加 e46，不许把 e47 认领进来
  const text = "- e? 「以后那条」→ Error: … (seq 279-283)";
  const out = repairFailuresInText(graph, RANGE, text);
  t.eq(out.repaired, ["e46"], "本段之外的边不算「漏写」，只补区间内的 e46");
  t.includes(out.text, "- e? 「以后那条」", "sanitize 抹掉的未来引用保持原样（C458 的设计）");
  t.includes(out.text, "(seq 279-283)", "那一行的坐标与文字一个字节都不许改");
  t.includes(out.text, "- e46 「", "区间内的 e46 仍然走追加（补回没被削弱）");
  t.eq(countOf(out.text, "e47"), 0, "**不许**把本段之外的 id 写回正文（越权）");
};

tests["T30 不许猜：一行多个占位符 / 没有坐标 —— 一律不认领"] = (t) => {
  const graph = makeGraph();
  const fe = graph.edges.e46;
  // ① 一行两个占位符：可能各指一条边，无法判定 ⇒ 只追加、不改写
  const multi = "- 同一目标 e35、e36、e?、e? → 已更新 (seq 216-218)";
  const outMulti = repairMissingFailures(multi, [fe]);
  t.includes(outMulti.text, multi, "多个占位符的行一个字都不许改");
  t.includes(outMulti.text, "- e46 「", "认领不掉就照旧追加（补回是兜底，不是可选项）");
  // ② 没有坐标：不猜
  const noSeq = "- e? 执行 `node x.mjs` → 失败";
  const outNoSeq = repairMissingFailures(noSeq, [fe]);
  t.includes(outNoSeq.text, noSeq, "没有坐标就不许改写（猜错 id 比 e? 更坏）");
  t.includes(outNoSeq.text, "- e46 「", "同上：追加兜底");
  // ③ 同跨度两条边：歧义
  const twin = { ...fe, id: "e90" };
  const out = repairMissingFailures("- e? 「x」→ y (seq 216-218)", [fe, twin]);
  t.includes(out.text, "- e? ", "同跨度两条边 ⇒ 歧义 ⇒ 不认领");
  t.eq(out.repaired, ["e46", "e90"], "认领不掉的两条照样追加（补回的兜底还在）");
  t.includes(out.text, "- e46 「", "兜底必须把 id 写出来");
  t.includes(out.text, "- e90 「", "两条都要留痕");
};

tests["T30 幂等：认领跑两遍不会长出第二行"] = (t) => {
  const graph = makeGraph();
  const once = repairFailuresInText(graph, RANGE, MODEL_TEXT);
  const twice = repairFailuresInText(graph, RANGE, once.text);
  t.eq(twice.text, once.text, "第二遍必须原样返回（mentionsEdge 已经命中）");
  t.eq(twice.repaired, [], "第二遍没有可补的");
  t.eq(countOf(twice.text, "e46"), 1, "e46 只出现一次");
};

tests["T30 部分认领：能定死的就地写回，定不死的仍走追加"] = (t) => {
  const graph = makeGraph();
  const fe = graph.edges.e46;
  const ghost = { id: "e999", action: "bash(ghost)", errorSnippet: "boom", evidence: { start: 900, end: 901 } };
  const out = repairMissingFailures(MODEL_TEXT, [fe, ghost]);
  t.includes(out.text, "- e46 「", "能定死的要就地写回");
  t.includes(out.text, "- e999 「bash(ghost)」→ boom", "定不死的照旧追加（补回没被削弱）");
  t.includes(out.text, "逐字补充", "追加段仍然存在（因为还有一条没认领）");
  t.eq(out.repaired, ["e46", "e999"], "两条都算补回");
};

/* ───────────── ③ 度量：反推与分类不许退化 ───────────── */

function makeFoldGraph() {
  const graph = makeGraph();
  graph.lastOfflineSummary = { at: 1793746126291, range: { ...RANGE }, text: MODEL_TEXT, model: "fake" };
  graph.foldMarks = [
    {
      at: 1793746126291,
      seqStart: RANGE.start,
      seqEnd: RANGE.end,
      trigger: "archive-offline",
      // ★ 真机那 6 条折痕**没有** `failuresRepaired` 字段（生产者早于 C641）—— 夹具照抄这个形状。
      quality: { expectedFailures: 1, failureRecall: 0, missingFailures: ["e46"] },
    },
  ];
  return graph;
}

tests["T30 审计：三条占位符分别归类成 跨界 / 本段之外 / 反推不出（并各自给 id）"] = (t) => {
  const row = placeholderAudit.scanFold(makeFoldGraph(), { session: "fixture" });
  t.ok(row !== null, "夹具必须有可测折痕");
  t.eq(row.placeholders.length, 3, "死路段里 3 条占位符行");
  t.eq(
    row.placeholders.map((p) => p.category),
    ["straddle", "future", "unresolved"],
    "分类：跨界（真丢）/ 本段之外（可定位）/ 反推不出（不猜）",
  );
  t.eq(row.placeholders[0].id, "e46", "跨界那条要反推出 e46（靠行尾坐标）");
  t.eq(row.placeholders[0].via, "seq", "反推依据必须是坐标（不是语义）");
  t.eq(row.placeholders[1].id, "e47", "本段之外那条也要反推出 id（它是可定位的）");
  t.eq(row.placeholders[2].id, null, "没有坐标的自由行不许猜出 id");
  t.eq(row.missingIds, ["e46"], "严格口径：区间内只有 e46 没被命中");
  t.eq(row.factsProbe, [{ id: "e46", inFacts: true, lineStart: row.factsProbe[0].lineStart }], "e46 在事实块里逐字存在（B 证伪）");
  t.eq(row.hasRepairedField, false, "夹具照抄真机：没有 failuresRepaired 字段 = 生产者早于 C641");
};

tests["T30 审计汇总：占位符行数 ≠ 丢的 id 数 —— 分母/分子不许混"] = (t) => {
  const row = placeholderAudit.scanFold(makeFoldGraph(), { session: "fixture" });
  const s = placeholderAudit.summarize([row], { now: 1793746126291 });
  t.eq(s.lines, 3, "占位符**行**数");
  t.eq(s.occurrences, 3, "占位符**出现**次数（每行一个）");
  t.eq(s.seqPinned, 2, "两条靠坐标反推");
  t.eq(s.missingIds, 1, "严格口径只有 1 个 id 被吃掉");
  t.eq(s.missingBehindPlaceholder, 1, "被吃掉的那个 id 能由占位符行定死");
  t.eq(s.futureLines, 1, "本段之外 1 行（可定位，不算丢）");
  t.eq(s.eatenLines, 1, "真丢 1 行（跨界）");
  t.eq(s.forms.map(([name]) => name), ["e?（半角，基准写法）"], "形态表只命中基准写法");
};

tests["T30 事实块：跨界的 id 一直都在（所以「改提示词」不是解）"] = (t) => {
  const facts = renderFacts(makeGraph(), RANGE);
  t.includes(facts, "- e46 ", "id 在行首，80 字符切的是动作/错误（C607 已修）");
  t.includes(facts, "(seq 216-218)", "坐标也在 ⇒ 模型能抄、也能定位");
  // 反向：本段之外的死路同样渲染（全局死路记忆，C607 的测试钉着这条）—— 它们被 sanitize 抹，
  // 所以「e? 很多」是 sanitize 的产物，不是渲染切掉了 id。
  t.includes(facts, "- e47 ", "本段之外的死路也在事实块里（这是设计，不是 bug）");
};
