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
/**
 * fold 的成本口径（2026-11-02，C43）。
 *
 * 为什么改口径：旧指标是 `input / shadowed`，live 里读到 2.11 就报「读两倍才压一倍」。
 * 但摘要请求的 input **包含 host 的固定开销**（工具 schema、system、AGENTS、保留尾部、旧 checkpoint），
 * 这些开销与压缩策略无关；把它算进「fold 效率」会把工具多的会话误判成压缩问题。
 *
 * 现在的三个数各回答一件事：
 *   · `share`  = shadowed / input   —— 这次 fold「读了这么多、其中多少是真要压的」；share 低才说明折得太碎/太早；
 *   · `ratio`  = input / shadowed   —— 旧口径，保留做对照（含固定开销，不单独判错）；
 *   · `roi`    = (shadowed - summary) / input —— 每读 1 token 换回多少**永久**上下文缩减。
 *
 * @returns {{inputTokens:number, shadowedTokens:number, summaryTokens:number|null, ratio:number, share:number, savedTokens:number, roi:number}|null}
 */
export function foldCostMetrics({ inputTokens, shadowedTokens, summaryTokens = null } = {}) {
  const input = Number(inputTokens);
  const shadowed = Number(shadowedTokens);
  if (!Number.isFinite(input) || input <= 0) return null;
  if (!Number.isFinite(shadowed) || shadowed <= 0) return null;
  const summary = Number.isFinite(Number(summaryTokens)) && Number(summaryTokens) > 0 ? Number(summaryTokens) : null;
  const saved = Math.max(0, shadowed - (summary ?? 0));
  return {
    inputTokens: input,
    shadowedTokens: shadowed,
    summaryTokens: summary,
    ratio: input / shadowed,
    share: shadowed / input,
    savedTokens: saved,
    roi: saved / input,
  };
}

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
/**
 * 幻觉探针（零模型调用）：摘要里出现的 `eN` / `nN` 必须能在图里找到。
 *
 * 为什么（2026-11-01，L1 分层评估里唯一还没做的零成本项）：
 *   摘要由模型生成，它**可能写出不存在的边 id**（"e99 说明……"），而后续模型会把编号当事实引用。
 *   这类幻觉不需要模型判断就能抓：图里有就是有，没有就是没有。
 *
 * 只认 `e12` / `n3` 这种**带字母前缀**的写法，所以 "第 3 步" / "step 3" 不会误报。
 * 返回 `{checked, unknown}`：checked 是摘要里提到的 id 总数，unknown 是图里找不到的那些（去重、保序）。
 */
export function findUnknownIds(graph, summaryText) {
  const text = String(summaryText ?? "");
  // ★ C105：被「置换合并」吞掉的节点 id 仍然**是真实存在过的事实** —— 合并会把它从 nodes 里删掉，
  //   只留在 survive 节点的 `superseded[]` 里。若只查 `graph.nodes`，摘要正常引用「n9 那条死路」
  //   就会被误判成幻觉（假红）。这里把合并历史里的 id 也算作「已知」。
  const merged = new Set();
  for (const node of Object.values(graph?.nodes ?? {})) {
    if (Array.isArray(node?.superseded)) {
      for (const rec of node.superseded) {
        if (rec && typeof rec.id === "string") merged.add(rec.id);
      }
    }
  }
  const seen = new Set();
  const unknown = [];
  for (const match of text.matchAll(/[en][0-9]{1,4}/g)) {
    const at = match.index ?? 0;
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + match[0].length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const known = id[0] === "e" ? Boolean(graph?.edges?.[id]) : Boolean(graph?.nodes?.[id]) || merged.has(id);
    if (!known) unknown.push(id);
  }
  return { checked: seen.size, unknown };
}


/**
 * ★ C104：摘要引用的 id **是否落在这次折叠的区间内**。
 *
 * 幻觉探针（`findUnknownIds`）只回答「图里有没有」；但还有一种更隐蔽的错：
 * 摘要写到了**别处**的边/节点（例如引用上一次 fold 之前的死路，或引用尚未发生的事），
 * 编号真实存在、图里查得到，于是探针沉默 —— 可这次 fold 的摘要根本没有覆盖它。
 *
 * 判据：id 在图里存在，但它的 seq 跨度与 `range` **不相交** ⇒ 出界。
 * `range` 为空（手动/tier-2 合并等无法界定）时不判，返回空数组。
 * @returns {{checked:number, outOfRange:string[]}}
 */
export function findOutOfRangeIds(graph, range, summaryText) {
  const text = String(summaryText ?? "");
  if (range === null || range === undefined || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    return { checked: 0, outOfRange: [], earlier: [], later: [] };
  }
  const seen = new Set();
  const outOfRange = [];
  const earlier = [];
  const later = [];
  // 注意：这里刻意不用 backslash 转义的词边界（历史上有过被脚本写坏成控制字符的坑），
  // 改成「匹配后手动检查前后字符是不是标识符字符」，语义等价且不依赖转义。
  for (const match of text.matchAll(/[en][0-9]{1,4}/g)) {
    const at = match.index ?? 0;
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + match[0].length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    const id = match[0];
    if (seen.has(id) || outOfRange.length >= 20) continue;
    seen.add(id);
    const isEdge = id[0] === "e";
    const edge = isEdge ? graph?.edges?.[id] : null;
    const node = isEdge ? null : (graph?.nodes?.[id] ?? null);
    if (isEdge && (edge === null || edge === undefined)) continue; // 不存在的 id 归幻觉探针，这里不重复报
    if (!isEdge && (node === null || node === undefined)) continue;
    let span = null;
    if (edge !== null) span = evidenceSpan(edge);
    else if (node !== null && Number.isFinite(node.seq)) span = { start: node.seq, end: node.seq };
    if (span === null) continue;
    // ★ C212：越界要分方向 ——
    //   · 引用**更早**的实体（span.end < range.start）= 摘要转述历史 kifu（合法，甚至是好事）；
    //   · 引用**更晚**的实体（span.start > range.end）= 折叠时那段还没被折进来，属于编造/错引。
    //   以前两者混在一个数组里，doctor 只能笼统报「越界 id」，于是把正常的回溯也当成问题。
    if (span.end < range.start) earlier.push(id);
    else if (span.start > range.end) later.push(id);
  }
  return { checked: seen.size, outOfRange: [...earlier, ...later], earlier, later };
}

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
    // ★ 2026-11-01：幻觉探针 —— 摘要里提到的 eN/nN 必须都在图里（见 findUnknownIds）。
    unknownIds: findUnknownIds(graph, summaryText || modelText).unknown,
    // C104：引用存在但**不在本次折叠区间内**的 id（幻觉探针抓不到的那一类）
    outOfRangeIds: findOutOfRangeIds(graph, range, summaryText || modelText).outOfRange,
    modelConstraintRecall,
  };
}
