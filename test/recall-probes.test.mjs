/**
 * recall-probes.test.mjs —— 两个「一直存在」的探针的守卫（T55）
 *
 * 由来（Lead 的原话，T52/T53/T54 判死三个候选指标之后）：
 *   「仓库里一直有两个探针（`src/rooms/fold-quality.mjs`）：`constraintRecall` / `failureRecall`。
 *    它们**从来没做过形状无关性验证**。」「**这两个探针可能也不合格**（今晚已经判死三个）——
 *    别因为它们「一直存在」就放过。」「**特别检查「恒等于 1」**（那是 T53 口径 A 的死法）。」
 *   硬话：「**交付前你必须自己跑一遍**」「失败分支必须真红。」
 *
 * 这个文件钉住的**不是**「recall 算得对不对」（那是 `fold-quality` 自己的事），而是
 * **它能不能当摘要质量指标**。结论是不能（`node scripts/recall-probes-audit.mjs` 原样输出见报告），
 * 不能的方式很具体：
 *
 *   ① **它是循环的**：生产在模型输出之后**机械追加**缺失的约束（`repairMissingConstraints`）与
 *      缺失的失败边（`repairFailuresInText`），然后拿**同一份最终文本**算 recall
 *      ⇒ 分子是**补回函数的输出**。`offline-fold.mjs` 自己的注释就写着
 *      「`failureRecall` 按设计恒 = 1（最终产物口径）」。
 *   ② **恒等比例**：真机 constraintRecall 众数占比 99.9%、failureRecall 97.3%（有效分母池 99.9% / 95.4%）
 *      ⇒ 判据 2（> 80% 恒等 = T53 口径 A 的死法）**必红**。
 *   ③ **分母为 0 的折痕被记成满分**：40.0% 的 failureRecall 折痕 `expectedFailures = 0`
 *      ⇒ 「没东西可量」与「全都保住了」在分布上**不可区分**。
 *   ④ **它随记账动、不随摘要动**：T37 的区间重放让 failureRecall 平均掉 −0.41（206 条变化）
 *      —— 那是 T53 口径 B 的死法（量的是区间记账）；而对 T35/T42/T50 的改动**完全瞎**（Δ ≈ 0）。
 *
 * 不变量（本文件钉住）：
 *   · **缺测不许吞成 0**（`Number(null) === 0` 是本仓踩过的坑，T49）；
 *   · **分母为 0 单列 `trivial`**，不许混进「满分」；
 *   · **三条判据必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁），
 *     也**必须能返回「通过」**（否则是永远红的假门禁）；
 *   · **补回后必然 = 1**（循环性的可复现证明）；
 *   · **独立标识符边界**：`e1` 不匹配 `e12`（与 `mentionsEdge` / `independentIds` 同一条）；
 *   · **纯只读**：审计跑完，被读的目录一个字节都不变。
 */
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { measureFoldQuality, sanitizeSummaryIds } from "../src/rooms/fold-quality.mjs";
import { collectConstraints } from "../src/rooms/ledger.mjs";
import { repairFailuresInText, repairMissingConstraints } from "../src/rooms/offline-fold.mjs";
import { correlate } from "../scripts/range-fidelity-audit.mjs";
import {
  CRITERIA_RULES,
  PROBES,
  SPAN_BANDS,
  audit,
  criteria,
  main,
  oldBoundaryRemovals,
  oldBoundarySanitize,
  readProbeRow,
  recomputeProbes,
  repairSensitivity,
  replayCoverage,
  spanBandOf,
  summarizeExtremes,
  summarizeProbe,
  verdictOf,
} from "../scripts/recall-probes-audit.mjs";

export const tests = {};

/* ───────────────────────────── 夹具 ───────────────────────────── */

const CONSTRAINT_A = "不要改 src/rooms/engine.mjs 的折叠主链路";
const CONSTRAINT_B = "必须跑 node test/run.mjs";

/**
 * 最小棋谱：节点 seq 10/20/30/40/50，两条失败边（`to` 必须非空，否则 `classifyDangling`
 * 会把它们当残留过滤掉 —— 那是另一个探针的口径）。
 */
function makeGraph() {
  const nodes = Object.create(null);
  for (const [seq, id] of [
    [10, "n1"],
    [20, "n2"],
    [30, "n3"],
    [40, "n4"],
    [50, "n5"],
  ]) {
    nodes[id] = { id, seq, kind: "assistant", text: `node ${id}` };
  }
  nodes.n1.kind = "user";
  nodes.n1.constraints = [CONSTRAINT_A, CONSTRAINT_B];
  const edges = {
    e1: { id: "e1", from: "n1", to: "n2", result: "failure", evidence: { start: 12, end: 14 }, action: "edit(foo)", errorSnippet: "Error: boom" },
    e12: { id: "e12", from: "n2", to: "n3", result: "failure", evidence: { start: 20, end: 22 }, action: "bash(bar)", errorSnippet: "Error: baz" },
  };
  return { nodes, edges, order: ["n1", "n2", "n3", "n4", "n5"], foldMarks: [] };
}

/** 一条摘要正文（两条约束逐字 + 两条失败边 id）。 */
const FULL_TEXT = ["## 目标", `- ${CONSTRAINT_A}`, `- ${CONSTRAINT_B}`, "", "## 已探明死路", "- e1 edit(foo) → Error: boom", "- e12 bash(bar) → Error: baz"].join("\n");

/** 一条只有一半的摘要（1 条约束、1 条失败边）。 */
const HALF_TEXT = ["## 目标", `- ${CONSTRAINT_A}`, "", "## 已探明死路", "- e1 edit(foo) → Error: boom"].join("\n");

/** 一条 `user/message` 事件（`collectMessages` 只认这种形态的正文）。 */
const msg = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/** 一个临时 home（里面放一份 graph.json）；调用方负责 `rmSync`。 */
function makeHome(graph, sessionId = "11111111-2222-3333-4444-555555555555") {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "recall-probes-"));
  const dir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph), "utf8");
  return { home, sessionId, graphFile: nodePath.join(dir, "graph.json") };
}

/** 目录内容指纹（只读守卫用）。 */
function fingerprint(dir) {
  const hash = nodeCrypto.createHash("sha256");
  const walk = (current) => {
    for (const entry of nodeFs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D:${full}`);
        walk(full);
      } else {
        hash.update(`F:${full}:${nodeFs.statSync(full).size}:${nodeFs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** 造一组「探针行」（`summarizeProbe` / `criteria` 的输入）。 */
function makeRows(values, { denom = "expectedFailures", denomValue = 3, quality = null } = {}) {
  return values.map((value, index) => ({
    sessionId: `s${index}`,
    tailGap: index * 10,
    span: 10 + index,
    chars: 1000,
    truncated: false,
    usageHasCache: true,
    constraintRecall: value,
    failureRecall: value,
    expectedConstraints: denomValue,
    expectedFailures: denomValue,
    modelConstraintRecall: null,
    recomputed: null,
    qualityTotal: quality === null ? null : quality[index],
    repair: null,
  }));
}

/**
 * 把一组行拼成 `criteria()` 要的形状。
 *
 * ⚠ 这里**必须**用生产同一个 `correlate`（含并列取平均秩）—— 手搓一个「按位置排秩」的版本
 * 会把常数序列算成 ρ=1（本仓踩过的假门禁：两套口径 = 静默算错）。
 */
function makeResult(rows, quality = null) {
  const withQuality = quality === null ? rows : rows.map((row, index) => ({ ...row, qualityTotal: quality[index] }));
  return {
    summary: Object.fromEntries(PROBES.map((probe) => [probe.key, summarizeProbe(withQuality, probe.key)])),
    correlations: Object.fromEntries(
      PROBES.map((probe) => [
        probe.key,
        {
          tailGap: correlate(withQuality, probe.key, "tailGap"),
          span: correlate(withQuality, probe.key, "span"),
          qualityTotal: correlate(withQuality, probe.key, "qualityTotal"),
          qualityTotalEffective: correlate(
            withQuality.filter((row) => Number(row[probe.denom]) > 0),
            probe.key,
            "qualityTotal",
          ),
          traceableShare: correlate(withQuality, probe.key, "chars"),
        },
      ]),
    ),
  };
}

/* ───────────────────────────── ① 记录行：缺测不许吞成 0 ───────────────────────────── */

tests["readProbeRow: 没有 quality 记录时全是 null（不拿 0 冒充缺测）"] = (t) => {
  const graph = makeGraph();
  const row = readProbeRow({ at: 1000, seqStart: 10, seqEnd: 49, trigger: "pressure" }, graph, { sessionId: "s1", graphMaxSeq: 50 });
  t.eq(row.constraintRecall, null, "constraintRecall 缺测 ⇒ null");
  t.eq(row.failureRecall, null, "failureRecall 缺测 ⇒ null");
  t.eq(row.expectedConstraints, null, "分母缺测 ⇒ null");
  t.eq(row.tailGap, 1, "离尾部 = 50 − 49");
  t.eq(row.span, 40, "跨度 = 49 − 10 + 1");
  t.eq(row.usageHasCache, false, "没有 usage ⇒ 不算「有命中字段」");
};

tests["readProbeRow: 有记录时按值取，分母为 0 也照实记 0（不改成 1）"] = (t) => {
  const graph = makeGraph();
  const row = readProbeRow(
    {
      at: 2000,
      seqStart: 10,
      seqEnd: 50,
      trigger: "archive-offline",
      summaryChars: 1234,
      truncated: true,
      qualityRepaired: 2,
      usage: { cacheReadTokens: 77 },
      quality: { constraintRecall: 1, failureRecall: 0.5, expectedConstraints: 0, expectedFailures: 4, modelConstraintRecall: 1 },
    },
    graph,
    { sessionId: "s2", graphMaxSeq: 50 },
  );
  t.eq(row.constraintRecall, 1, "constraintRecall 照实取");
  t.eq(row.failureRecall, 0.5, "failureRecall 照实取");
  t.eq(row.expectedConstraints, 0, "分母 0 照实记 0");
  t.eq(row.truncated, true, "截断标记");
  t.eq(row.repaired, 2, "补回条数");
  t.eq(row.usageHasCache, true, "usage.cacheReadTokens 有值");
  t.eq(row.summaryChars, undefined, "summaryChars 不是本行的字段（避免两套口径）");
  t.eq(row.chars, 1234, "chars 从 summaryChars 来");
};

/* ───────────────────────────── ② 分布：恒等必须被量出来 ───────────────────────────── */

tests["summarizeProbe: 常数序列 ⇒ 众数占比 1、p10/p50/p90 全等（T53 口径 A 的形态）"] = (t) => {
  const stats = summarizeProbe(makeRows(Array.from({ length: 10 }, () => 1)), "failureRecall");
  t.eq(stats.all.n, 10, "n");
  t.eq(stats.all.mode, 1, "众数");
  t.eq(stats.all.modeShare, 1, "众数占比 = 1");
  t.eq(stats.all.distinct, 1, "只有一个不同取值");
  t.eq(stats.all.histogram["= 1.0"], 10, "直方图最高档全中");
  t.eq([stats.all.p10, stats.all.p50, stats.all.p90], [1, 1, 1], "三个分位全等");
};

tests["summarizeProbe: 分母为 0 的折痕单列 trivial（「没东西可量」不是「满分」）"] = (t) => {
  const rows = [
    ...makeRows([1, 1], { denom: "expectedFailures", denomValue: 0 }),
    ...makeRows([1, 0.5], { denom: "expectedFailures", denomValue: 4 }),
  ];
  const stats = summarizeProbe(rows, "failureRecall");
  t.eq(stats.pool, 4, "全池 4 条");
  t.eq(stats.trivialCount, 2, "分母为 0 的 2 条被单列");
  t.eq(stats.trivialShare, 0.5, "占比 50%");
  t.eq(stats.effective.n, 2, "有效分母池 2 条");
  t.eq(stats.effective.modeShare, 0.5, "有效池里 1 条 = 1.0、1 条 = 0.5");
  t.eq(stats.all.modeShare, 0.75, "全池众数占比（被 trivial 抬高了）");
};

tests["summarizeProbe: 有方差时众数占比 < 0.8（判据 2 不是永远红）"] = (t) => {
  const stats = summarizeProbe(makeRows([0, 0.25, 0.5, 0.75, 1, 1, 1, 1]), "failureRecall");
  t.eq(stats.all.modeShare, 0.5, "8 条里 4 条是 1.0");
  t.eq(stats.all.distinct, 5, "5 个不同取值");
  t.ok(stats.all.p10 < stats.all.p90, "p10 < p90（真的有分布）");
};

/* ───────────────────────────── ③ 三条判据：必须能红、也必须能绿 ───────────────────────────── */

tests["判据 2 能返回「不通过」：97% 恒等于 1 就是 T53 口径 A 的死法"] = (t) => {
  const rows = makeRows([...Array.from({ length: 33 }, () => 1), 0.5]);
  const list = criteria(makeResult(rows));
  const variance = list.filter((item) => item.id.endsWith(":variance"));
  t.eq(variance.length, PROBES.length, "每个探针一条方差判据");
  t.eq(variance.every((item) => item.pass === false), true, "97% 恒等 ⇒ 全部不通过");
  t.eq(verdictOf(makeResult(rows)).usable, false, "总裁决不能是「能用」");
};

tests["判据 2 能返回「通过」：有方差时不是永远红（假门禁检测）"] = (t) => {
  const rows = makeRows([0, 0.2, 0.4, 0.6, 0.8, 1, 0.5, 0.3]);
  const variance = criteria(makeResult(rows)).filter((item) => item.id.endsWith(":variance"));
  t.eq(variance.every((item) => item.pass === true), true, "8 个不同取值 ⇒ 通过");
};

tests["判据 1 能返回「不通过」：与离尾部距离强相关就是「测形状」"] = (t) => {
  // 探针 = 1 − tailGap / 1000 ⇒ 单调递减 ⇒ |ρ| = 1
  const rows = makeRows([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]).map((row, index) => ({
    ...row,
    tailGap: index * 100,
    constraintRecall: 1 - index / 10,
    failureRecall: 1 - index / 10,
  }));
  const shape = criteria(makeResult(rows)).filter((item) => item.id.endsWith(":shape"));
  t.eq(shape.every((item) => item.pass === false), true, "|ρ| ≥ 0.2 ⇒ 形状判据不通过");
};

tests["判据 1 能返回「通过」：与形状无关时不是永远红（假门禁检测）"] = (t) => {
  // 取值模式与「离尾部 / 跨度」的排序**正交**（4 个 1 与 4 个 0.5 交错成块 ⇒ ρ = 0）
  const rows = makeRows([1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1]).map((row, index) => ({ ...row, tailGap: index * 7, span: 10 + index }));
  const shape = criteria(makeResult(rows)).filter((item) => item.id.endsWith(":shape"));
  t.eq(shape.every((item) => item.pass === true), true, "|ρ| < 0.2 ⇒ 形状判据通过");
};

tests["判据 3：ρ(T33) 低/高都必须能判（且 null 不能当通过）"] = (t) => {
  // 探针单调 ↑、T33 也单调 ↑ ⇒ ρ = 1 ⇒ 通过
  const rows = [0, 0.2, 0.4, 0.6, 0.8, 1, 0.9, 0.7];
  const good = criteria(makeResult(makeRows(rows), rows.map((value) => value * 10))).filter((item) => item.id.endsWith(":explanatory"));
  t.eq(good.every((item) => item.pass === true), true, "ρ 高 ⇒ 通过");
  // 探针恒定 ⇒ ρ 无定义（null）⇒ 必须判不通过（**不能**把 null 当 0 之外的好消息）
  const flat = criteria(makeResult(makeRows(Array.from({ length: 8 }, () => 1)), Array.from({ length: 8 }, (_, i) => i))).filter((item) =>
    item.id.endsWith(":explanatory"),
  );
  t.eq(flat.every((item) => item.pass === false), true, "常数的秩相关无定义 ⇒ 不通过");
};

tests["verdictOf：两个探针都三条全过才算「能用」"] = (t) => {
  const pattern = [1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1];
  const rows = pattern.map((value, index) => ({
    sessionId: `s${index}`,
    tailGap: index * 7,
    span: 10 + index,
    chars: 1000,
    truncated: false,
    usageHasCache: true,
    constraintRecall: value,
    failureRecall: value,
    expectedConstraints: 3,
    expectedFailures: 3,
    modelConstraintRecall: null,
    recomputed: null,
    qualityTotal: value * 10,
    repair: null,
  }));
  const verdict = verdictOf(makeResult(rows));
  t.eq(verdict.total, 6, "2 探针 × 3 判据");
  t.eq(verdict.passed, 6, "六条全过");
  t.eq(verdict.usable, true, "能用");
  t.eq(verdict.reason, "两个探针三条判据全过", "理由");
};

/* ───────────────────────────── ④ 循环性：分子是补回函数的输出 ───────────────────────────── */

tests["循环性：机械补回把 recall 从 0.5 抬到 1.0（这就是「恒等于 1」的来源）"] = (t) => {
  const graph = makeGraph();
  const range = { start: 10, end: 50 };
  const before = measureFoldQuality({ graph, range, summaryText: HALF_TEXT });
  t.eq(before.constraintRecall, 0.5, "补回前：2 条约束只提到 1 条");
  t.eq(before.failureRecall, 0.5, "补回前：2 条失败边只提到 1 条");

  const missing = collectConstraints(graph).filter((item) => !HALF_TEXT.includes(item));
  const repaired = repairMissingConstraints(HALF_TEXT, missing);
  t.eq(repaired.repaired, 1, "补回 1 条约束");
  const afterConstraints = measureFoldQuality({ graph, range, summaryText: repaired.text });
  t.eq(afterConstraints.constraintRecall, 1, "补回后 constraintRecall 必然 = 1（**不是摘要变好了**）");

  const filled = repairFailuresInText(graph, range, repaired.text);
  t.ok(filled.repaired.length >= 1, "补回 e12");
  const afterFailures = measureFoldQuality({ graph, range, summaryText: filled.text });
  t.eq(afterFailures.failureRecall, 1, "补回后 failureRecall 必然 = 1（同一个循环）");
};

tests["failureRecall 的独立标识符边界：e1 ≠ e12（与 mentionsEdge 同一条）"] = (t) => {
  const graph = makeGraph();
  const range = { start: 10, end: 50 };
  const onlyE1 = measureFoldQuality({ graph, range, summaryText: "## 死路\n- 只有 e1 这条" });
  t.eq(onlyE1.failureRecall, 0.5, "只提 e1 ⇒ 1 / 2");
  const onlyE12 = measureFoldQuality({ graph, range, summaryText: "## 死路\n- 只有 e12 这条" });
  t.eq(onlyE12.failureRecall, 0.5, "只提 e12 ⇒ 1 / 2（e1 不能匹配 e12）");
  const both = measureFoldQuality({ graph, range, summaryText: "## 死路\n- e1 与 e12 都提" });
  t.eq(both.failureRecall, 1, "两条都提 ⇒ 1");
  const padded = measureFoldQuality({ graph, range, summaryText: "## 死路\n- the1 与 e123 都不是独立 id" });
  t.eq(padded.failureRecall, 0, "`the1` / `e123` 都不算（前后接标识符字符）");
};

/* ───────────────────────────── ⑤ 重算一致性：两套口径必须是同一件事 ───────────────────────────── */

tests["recomputeProbes：重算值 = 记录值（记录不是历史噪声）"] = (t) => {
  const graph = makeGraph();
  const range = { start: 10, end: 50 };
  const recomputed = recomputeProbes({ graph, range, text: HALF_TEXT });
  t.eq(recomputed.constraintRecall, 0.5, "重算 constraintRecall");
  t.eq(recomputed.failureRecall, 0.5, "重算 failureRecall");
  t.eq(recomputed.expectedConstraints, 2, "重算分母");
  t.eq(recomputed.expectedFailures, 2, "重算分母");
};

/* ───────────────────────────── ⑥ 修复敏感性：T35 / T37 ───────────────────────────── */

tests["oldBoundarySanitize：退化区间上旧界抹 id、当前界保留（T35 的生效面）"] = (t) => {
  const graph = makeGraph();
  const range = { start: 8, end: 8 };
  const text = "看到 n5 与 e1";
  const current = sanitizeSummaryIds(text, graph, range);
  const old = oldBoundarySanitize(text, graph, range);
  t.eq(current.text, text, "当前界：区间里没有实体 ⇒ 兜底不判「未来」⇒ 原样保留");
  t.eq(old, "看到 n? 与 e?", "旧界：span.end > 8 ⇒ 一律抹成占位符");
  t.eq(oldBoundaryRemovals(text, graph, range), 2, "生效面 = 2 个 id");
};

tests["oldBoundarySanitize：非退化区间上两者逐字相同（Δ 恒为 0 是定义保证）"] = (t) => {
  const graph = makeGraph();
  const range = { start: 10, end: 50 };
  const text = "看到 n5 与 e1，还有图里没有的 e999";
  t.eq(oldBoundarySanitize(text, graph, range), sanitizeSummaryIds(text, graph, range).text, "逐字相同");
  t.eq(oldBoundaryRemovals(text, graph, range), 0, "生效面 = 0");
};

tests["T37 重放：退化区间 8-8 会被纠正成 9-50（分母一变数就崩）"] = (t) => {
  const events = [msg(9, "第一条"), msg(20, "第二条"), msg(50, "第三条")];
  const replayed = replayCoverage(events, { start: 8, end: 8 });
  t.eq(replayed, { start: 9, end: 50 }, "coverageOf 的重放：8-8 ⇒ 9-50");
  // 8-8 里没有失败边（分母 0 ⇒ recall 1）；9-50 里有 2 条（摘要没提 ⇒ recall 0）
  const graph = makeGraph();
  const sensitivity = repairSensitivity({ graph, range: { start: 8, end: 8 }, text: "## 目标\n- 什么也没提", events });
  t.eq(sensitivity.t37.from, { start: 8, end: 8 }, "记的区间");
  t.eq(sensitivity.t37.to, { start: 9, end: 50 }, "重放后的区间");
  t.eq(sensitivity.t37.expectedFailures, { before: 0, after: 2 }, "分母从 0 变成 2");
  t.eq(sensitivity.t37.delta.failureRecall, -1, "failureRecall 从 1.00 掉到 0.00");
  t.eq(sensitivity.t37.applied, 1, "这条折痕的区间变了");
};

tests["repairSensitivity：没有日志时 T37 记 null（不许拿「没跑」冒充 Δ = 0）"] = (t) => {
  const graph = makeGraph();
  const sensitivity = repairSensitivity({ graph, range: { start: 10, end: 50 }, text: FULL_TEXT, events: null });
  t.eq(sensitivity.t37, null, "没有日志 ⇒ t37 为 null");
  t.eq(sensitivity.t35.delta.failureRecall, 0, "T35 的 Δ 仍是 0（文本已过更严的界）");
  t.eq(repairSensitivity({ graph, range: { start: 10, end: 50 }, text: "" }), null, "空文本 ⇒ 整条 null");
};

/* ───────────────────────────── ⑦ 分桶边界 ───────────────────────────── */

tests["spanBandOf：边界归左（1 = 单事件，200+ 是开区间）"] = (t) => {
  t.eq(spanBandOf(1), "1（单事件）", "1");
  t.eq(spanBandOf(2), "2–10", "2 归第二档");
  t.eq(spanBandOf(10), "2–10", "10");
  t.eq(spanBandOf(11), "11–50", "11");
  t.eq(spanBandOf(200), "51–200", "200");
  t.eq(spanBandOf(201), "200+", "201");
  t.eq(spanBandOf(null), null, "缺测 ⇒ null（不吞成第一档）");
  t.eq(spanBandOf(0), null, "0 不是合法跨度");
  t.eq(SPAN_BANDS.length, 5, "五档");
};

tests["summarizeExtremes：最高档与最低档的 T33 均分（区分度）"] = (t) => {
  const rows = [
    { sessionId: "a", failureRecall: 1, qualityTotal: 8, chars: 1000 },
    { sessionId: "b", failureRecall: 1, qualityTotal: 9, chars: 1000 },
    { sessionId: "c", failureRecall: 0.5, qualityTotal: 3, chars: 500 },
  ];
  const extremes = summarizeExtremes(rows);
  t.eq(extremes.failureRecall.top.n, 2, "最高档 2 条");
  t.eq(extremes.failureRecall.bottom.n, 1, "最低档 1 条");
  t.eq(extremes.failureRecall.gap, 5.5, "均分之差 8.5 − 3");
};

/* ───────────────────────────── ⑧ 纯只读 + 确定性 + CLI ───────────────────────────── */

tests["audit：纯只读（跑完被读目录一个字节都不变）"] = async (t) => {
  const graph = makeGraph();
  graph.foldMarks = [
    {
      at: 1000,
      seqStart: 10,
      seqEnd: 50,
      trigger: "archive-offline",
      summaryChars: FULL_TEXT.length,
      quality: { constraintRecall: 1, failureRecall: 1, expectedConstraints: 2, expectedFailures: 2 },
    },
    { at: 2000, seqStart: 10, seqEnd: 50, trigger: "pressure", summaryChars: 0, quality: null },
  ];
  const { home } = makeHome(graph);
  try {
    const before = fingerprint(home);
    const result = await audit({ home, asOf: null, replay: false });
    const after = fingerprint(home);
    t.eq(before, after, "目录指纹不变（纯只读）");
    t.eq(result.marks, 2, "两条折痕");
    t.eq(result.qualityPool, 1, "只有一条带 quality");
    t.eq(result.textPool, 0, "没有 lastOfflineSummary ⇒ 重算池为空");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["audit：确定性（同一份夹具跑两次，JSON 完全相等）"] = async (t) => {
  const graph = makeGraph();
  graph.lastOfflineSummary = { at: 1000, range: { start: 10, end: 50 }, text: FULL_TEXT, model: "m" };
  graph.foldMarks = [{ at: 1000, seqStart: 10, seqEnd: 50, trigger: "archive-offline", summaryChars: FULL_TEXT.length, quality: { constraintRecall: 1, failureRecall: 1, expectedConstraints: 2, expectedFailures: 2 } }];
  const { home } = makeHome(graph);
  try {
    const first = await audit({ home, asOf: null, replay: false });
    const second = await audit({ home, asOf: null, replay: false });
    t.eq(JSON.stringify(first.summary), JSON.stringify(second.summary), "分布相同");
    t.eq(JSON.stringify(first.correlations), JSON.stringify(second.correlations), "相关性相同");
    t.eq(first.textPool, 1, "重算池 1 条");
    t.eq(first.rows[0].recomputed.constraintRecall, 1, "重算 constraintRecall");
    t.eq(first.consistency.constraintRecall, 1, "记录 = 重算");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["main：没有棋谱目录 / --as-of 解析不了 ⇒ 退出码 2"] = async (t) => {
  const empty = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "recall-probes-empty-"));
  try {
    t.eq(await main(["--home", empty]), 2, "没有 chess-context/sessions ⇒ 2");
    const graph = makeGraph();
    graph.foldMarks = [];
    const { home } = makeHome(graph);
    try {
      t.eq(await main(["--home", home, "--as-of", "不是时间"]), 2, "--as-of 解析不了 ⇒ 2");
      t.eq(await main(["--home", home, "--limit", "abc"]), 2, "--limit 解析不了 ⇒ 2");
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    nodeFs.rmSync(empty, { recursive: true, force: true });
  }
};

/* ───────────────────────────── ⑨ 真机守卫（结论稳定性） ───────────────────────────── */

tests["真机：两个探针都判「恒等」（结论变了就必须重审，不许悄悄漂绿）"] = async (t) => {
  const home = String(process.env.DSH_HOME ?? "").trim() || nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    t.skip(`没有真机棋谱目录：${sessionsDir}`);
    return;
  }
  const result = await audit({ home, asOf: null, replay: false });
  if (result.qualityPool < 100) {
    t.skip(`真机样本太少（${result.qualityPool} 条），不足以判「恒等」`);
    return;
  }
  const list = criteria(result);
  const variance = list.filter((item) => item.id.endsWith(":variance"));
  t.eq(variance.length, PROBES.length, "每个探针一条方差判据");
  t.eq(
    variance.every((item) => item.pass === false),
    true,
    `两个探针都恒等于 ${CRITERIA_RULES.maxConstantShare} 以上（T53 口径 A 的死法）`,
  );
  t.eq(verdictOf(result).usable, false, "结论：不能当摘要质量指标");
  const shape = list.filter((item) => item.id.endsWith(":shape"));
  t.eq(
    shape.every((item) => item.vacuous === true),
    true,
    "形状判据的「通过」是 vacuous（序列恒等 ⇒ 无关是没信息）",
  );
};
