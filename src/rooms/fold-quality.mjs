/**
 * fold-quality.mjs —— 一次 fold 的「保真度」指标（L1，零模型调用）
 *
 * 为什么（2026-11-01，`docs/压缩质量-现有观测盘点与缺口.md` §4 / `docs/压缩的重注入契约.md` §6）：
 *   压缩最该保住的三样东西里，出处（provenance）与预算（fallback）已经有指标了，
 *   但「**约束和失败边到底保住了没有**」一直只能靠人翻摘要。这两个是任务级的：
 *   丢一条约束 = 任务变了；丢一条失败边 = 下一个模型必然重踩。
 *
 * 判据全部是**机械字符串匹配**，不调用模型、不打分、不做语义判断：
 *   · `constraintRecall` = 最终摘要里逐字出现的约束条数 ÷ 图里抽取到的约束条数（必须 = 1）
 *   · `failureRecall`    = 最终摘要里出现 edge id 的失败边条数 ÷ 本次 fold 区间内的失败边条数
 *   · `compressionRatio` = 遮蔽 token ÷ 摘要 token（记录趋势，不设硬阈值）
 *
 * 边界（`docs/压缩的职责边界.md`）：只读本次会话的图 + 本次 fold 的摘要文本；
 *   不跨会话、不校验语义、不给「摘要质量打分」、不改变任何压缩行为 —— 纯观测。
 *
 * 为什么 `constraintRecall` 必须按**最终产物**算（而不是模型输出）：
 *   engine 在模型输出之后会**机械追加**约束段（实测模型在 15 条失败边压力下会丢 3 条约束），
 *   所以「最终产物 = 1」是设计保证；掉到 1 以下只可能是机械追加那段被删了/改坏了 —— 这正是要钉住的。
 *   想单独看模型自己的保真度，用 `measureFoldQuality({ modelText })` 的 `modelConstraintRecall`。
 */

import { failureEdges } from "./kifu-model.mjs";
import { collectConstraints, estimateTokens, isDanglingResidue } from "./ledger.mjs";

/** 边的 evidence 区间；数字与 `{start,end}` 两种形态都吃（老图/夹具）。 */
function evidenceSpan(edge) {
  const e = edge?.evidence;
  if (typeof e === "number" && Number.isFinite(e)) return { start: e, end: e };
  if (e !== null && typeof e === "object" && Number.isFinite(e.start)) {
    return { start: e.start, end: Number.isFinite(e.end) ? e.end : e.start };
  }
  return null;
}

/**
 * 本次 fold 区间内的失败边（与 `renderFacts` 的过滤口径一致）：
 *   · 排除 rewash 残留（`isDanglingResidue`，它们不是「哪一步失败了」）；
 *   · 给了 range 就只取 evidence 与区间**有交集**的边；
 *   · 没有位置信息的边保守保留（宁可多要一条，也不漏掉判据）。
 *
 * @param {object} graph 棋谱
 * @param {{start:number,end:number}|null} [range] 本次 fold 遮蔽的 seq 区间（null = 不按区间过滤）
 */
export function failuresInFoldRange(graph, range = null) {
  const all = failureEdges(graph).filter((edge) => !isDanglingResidue(edge, { graph }));
  if (range === null || range === undefined || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return all;
  return all.filter((edge) => {
    const span = evidenceSpan(edge);
    if (span === null) return true;
    return span.end >= range.start && span.start <= range.end;
  });
}

/** 摘要文本里是否**作为独立标识符**提到了这条边（`e1` 不能匹配 `e12`/`e123`）。 */
export function mentionsEdge(text, edgeId) {
  const id = String(edgeId ?? "").trim();
  if (id === "") return false;
  // 边界：前面不能是字母/数字/下划线（避免 "the1" 之类），后面不能紧跟数字（避免 e1 → e12）
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
  return re.test(String(text ?? ""));
}

/**
 * @param {object} args
 * @param {object} args.graph 棋谱
 * @param {{start:number,end:number}|null} [args.range] 本次 fold 的 seq 区间
 * @param {string} [args.summaryText] **最终产物**（模型输出 + 机械追加段）拼接文本
 * @param {string} [args.modelText] 仅模型输出（可空；用来单独看模型保真度）
 * @param {number|null} [args.summaryTokens] 摘要 token（不传则用 estimateTokens 现算）
 * @param {number|null} [args.shadowedTokens] 本次遮蔽 token（foldMarks 已有；不传则不算比值）
 * @returns {{constraintRecall:number, failureRecall:number, compressionRatio:number|null,
 *   expectedConstraints:number, expectedFailures:number, missingConstraints:string[],
 *   missingFailures:string[], summaryTokens:number, shadowedTokens:number|null,
 *   modelConstraintRecall:number|null}}
 */
export function measureFoldQuality({
  graph,
  range = null,
  summaryText = "",
  modelText = "",
  summaryTokens = null,
  shadowedTokens = null,
} = {}) {
  const text = String(summaryText ?? "");
  const constraints = collectConstraints(graph);
  const failures = failuresInFoldRange(graph, range);

  const missingConstraints = [];
  for (const constraint of constraints) {
    if (!text.includes(constraint)) missingConstraints.push(constraint);
  }
  const missingFailures = [];
  for (const edge of failures) {
    if (!mentionsEdge(text, edge.id)) missingFailures.push(edge.id);
  }

  let modelConstraintRecall = null;
  if (typeof modelText === "string" && modelText !== "") {
    let hit = 0;
    for (const constraint of constraints) if (modelText.includes(constraint)) hit += 1;
    modelConstraintRecall = constraints.length === 0 ? 1 : hit / constraints.length;
  }

  const tokens = Number.isFinite(summaryTokens) ? summaryTokens : text.trim() === "" ? 0 : estimateTokens(text);
  const shadowed = Number.isFinite(shadowedTokens) ? shadowedTokens : null;
  const compressionRatio = shadowed !== null && tokens > 0 ? Math.round((shadowed / tokens) * 100) / 100 : null;

  return {
    constraintRecall: constraints.length === 0 ? 1 : (constraints.length - missingConstraints.length) / constraints.length,
    failureRecall: failures.length === 0 ? 1 : (failures.length - missingFailures.length) / failures.length,
    compressionRatio,
    expectedConstraints: constraints.length,
    expectedFailures: failures.length,
    missingConstraints: missingConstraints.slice(0, 5),
    missingFailures: missingFailures.slice(0, 10),
    summaryTokens: tokens,
    shadowedTokens: shadowed,
    modelConstraintRecall,
  };
}
