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

import { failureEdges, evidenceSpan } from "./kifu-model.mjs";
import { collectConstraints, estimateTokens, isDanglingResidue } from "./ledger.mjs";

/** 边的 evidence 区间；数字与 `{start,end}` 两种形态都吃（老图/夹具）。 */

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
export function findOutOfRangeIds(graph, range, summaryText, { allow = null } = {}) {
  // ★ C539：**硬事实里的 id 不算越界**。摘要的"已探明死路/已验证事实"整段来自 `renderFacts`，
  //   那些 e### 本来就跨整个会话（seq 远超本次折叠区间）—— 以前一律记成 `outOfRangeLater`，
  //   于是真机上每次离线折叠都背 13–18 条"越界"，而它们全是合法引用。
  const allowSet = allow instanceof Set ? allow : new Set(Array.isArray(allow) ? allow : []);
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
    if (allowSet.has(id)) continue;
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

/**
 * ★ C458：把摘要里**折叠时还不存在**的实体 id 替换成占位符（确定性修复，不靠提示词）。
 *
 * 由来：C455 把「只能引用事实块里出现过的 id」写进了提示词，规则从分支挪成无条件。
 * **重启后第一次折叠仍然编了 34 个**，而且是 `n3634,n3635,n3636,n3637` 这样的连续编号 ——
 * 正是那条规则明禁的写法。⇒ 提示词挡不住，必须有代码层兜底。
 *
 * 判据：id 在图里**存在**、且它的位置**不晚于折叠边界**（`span.end ≤ boundary`）才保留；
 * 其余（图里没有 / 晚于本次折叠）一律替换成 `n?` / `e?`。
 * ★ T35：`boundary` **不再是 `range.end`** —— 单事件折叠（`seq 8-8`）的区间里一个节点都没有，
 *   而 `range.end` 早于全图第一个实体 ⇒ 旧判据把全篇 `nN` 都判成「未来」（真机 51/365 摘要零锚点）。
 *   现在的界 = 折叠结束前最后一个**完整存在过**的实体的 seq（见下方注释）；取不到 ⇒ 兜底不判「未来」。
 * 这样 checkpoint 里不会出现指不到、或指向"未来"的编号；具体丢了几个记在 `removed` 里，由 foldMark 带走。
 *
 * @param {string} text
 * @param {object} graph
 * @param {{start:number,end:number}|null} range 为空时**不做处理**（无法判定"晚不晚"）
 * @returns {{text:string, removed:string[], checked:number}}
 */
export function sanitizeSummaryIds(text, graph, range) {
  const src = String(text ?? "");
  if (range === null || range === undefined || !Number.isFinite(range.end)) return { text: src, removed: [], checked: 0 };
  // ★ T35：界取「折叠结束前最后一个**完整存在过**的实体」的 seq —— 节点取 `seq`、边取 `evidence.end`，
  //   两者都只取 ≤ `range.end` 的。为什么不能只看节点：真机 387 条摘要实测，尾部常常只有边没有节点，
  //   只用节点会多抹 92 个正当 id（61 条摘要）；算上边之后，非退化区间与旧判据**逐条一致**（0 个 id 变化）。
  //   取不到（区间早于全图）⇒ `boundary === null` ⇒ **兜底不判「未来」**：
  //   抹掉全部锚点比留一个可疑 id 更坏（读者至少能用 id 回查棋谱）。
  //   注意：**图里没有**的 id 仍然抹成 `n?`/`e?`（C458 的另一半，与「未来」无关）。
  let boundary = null;
  const extend = (seq) => {
    if (Number.isFinite(seq) && seq <= range.end) boundary = boundary === null ? seq : Math.max(boundary, seq);
  };
  for (const node of Object.values(graph?.nodes ?? {})) extend(Number(node?.seq));
  for (const edge of Object.values(graph?.edges ?? {})) extend(Number(evidenceSpan(edge)?.end));
  const removed = [];
  let checked = 0;
  const out = src.replace(/[en][0-9]{1,4}/g, (id, offset) => {
    const before = offset > 0 ? src[offset - 1] : "";
    const after = src[offset + id.length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) return id; // 不是独立 id（比如文件名里的一段）
    checked += 1;
    const isEdge = id[0] === "e";
    const obj = isEdge ? graph?.edges?.[id] : graph?.nodes?.[id];
    if (obj === null || obj === undefined) {
      removed.push(id);
      return isEdge ? "e?" : "n?";
    }
    const span = isEdge ? evidenceSpan(obj) : Number.isFinite(obj.seq) ? { start: obj.seq, end: obj.seq } : null;
    if (boundary !== null && span !== null && span.end > boundary) {
      removed.push(id);
      return isEdge ? "e?" : "n?";
    }
    return id;
  });
  return { text: out, removed, checked };
}

export function measureFoldQuality({
  graph,
  range = null,
  summaryText = "",
  modelText = "",
  summaryTokens = null,
  shadowedTokens = null,
  /** ★ C539：来自硬事实块的 id（不参与越界判定）。 */
  allowedIds = null,
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
    // ★ C280：C212 早就把越界分成了 earlier / later，但**只存了合并后的数组**，
    //   结果 doctor 去读 `outOfRangeLater`（不存在）⇒ 永远读到空 ⇒ 一律报「全部是引用更早的，正常」。
    //   那是**仪器在撒谎**：真正"引用更晚（折叠时还不存在的实体）"的问题永远看不见。
    //   这里把三段都存下来：合并 / 更早（回溯 kifu，合法）/ 更晚（真问题）。
    ...((() => {
      const probe = findOutOfRangeIds(graph, range, summaryText || modelText, { allow: allowedIds });
      return {
        outOfRangeIds: probe.outOfRange,
        outOfRangeEarlier: probe.earlier,
        outOfRangeLater: probe.later,
      };
    })()),
    modelConstraintRecall,
    // ★ C528：**结构契约**。真机 <SESSION_ID> 那次摘要撞了 max_tokens，停在 `grep -n "` 上，
    //   而当时的质量指标（约束/失败召回）**全是 1**，看起来完美 —— 因为后面的段落整段没写。
    //   这里补两项机器判据：缺哪些必备段落、结尾是不是干净收束。
    ...describeStructure(text, { expectFailures: failures.length > 0 }),
  };
}

/** ★ C638：段名**别名表（闭集）**。真机摘要写的是 `## 已探明死路`，旧 `includes("## 死路")` 对它恒 false；
 *  只收同一段的另一种叫法 —— 放宽成模糊包含会让 `## 已探明死路` 也算成 `## 目标`，探针恒绿 = 等于没探针。 */
export const SECTION_ALIASES = { 目标: ["目标"], 棋谱: ["棋谱"], 死路: ["死路", "已探明死路"] };
/** 摘要必备的二级标题（缺了就说明被截断或跑偏）。 */
const REQUIRED_SECTIONS = ["目标", "棋谱"];
/** 只有当**折叠区间里确实有失败边**时，才要求「死路」这一段（否则模型省略它是合理的）。 */
const REQUIRED_SECTIONS_WITH_FAILURES = ["目标", "棋谱", "死路"];
/** `## ` 同级标题名；尾部括号注记算同一段（`## 棋谱（状态节点）` → `棋谱`，`### x` 不算）。 */
export const sectionNames = (text) =>
  String(text ?? "").split(/\r?\n/).map((line) => /^##[ \t]+(\S.*)$/.exec(line)?.[1]).filter((x) => x !== undefined)
    .map((name) => name.replace(/[（(][^（()）]*[）)]\s*$/, "").replace(/[:：]\s*$/, "").trim()).filter((name) => name !== "");

/**
 * ★ C528：结构契约 —— 「齐全」和「没被截断」是两件事，指标得分开看。
 * ★ C638：段名判定改成**别名全等**（`## 已探明死路` ⇒ 「死路」），旧写法 `includes("## 死路")` 恒假红。
 * @param {string} text
 * @returns {{sectionsMissing:string[], sectionsPresent:number, endedCleanly:boolean}}
 */
export function describeStructure(text, { expectFailures = false } = {}) {
  const body = String(text ?? "");
  const required = expectFailures === true ? REQUIRED_SECTIONS_WITH_FAILURES : REQUIRED_SECTIONS;
  const headings = sectionNames(body);
  const present = required.filter((name) => (SECTION_ALIASES[name] ?? [name]).some((alias) => headings.includes(alias)));
  const sectionsMissing = required.filter((name) => !present.includes(name));
  // 结尾干净 = 最后一行不以分隔符/半个句子结束（行尾是标点、括号闭合、或代码围栏）
  const trimmed = body.trimEnd();
  const lastLine = trimmed.slice(trimmed.lastIndexOf(String.fromCharCode(10)) + 1);
  // 结尾干净 = 最后一行不以分隔符结尾，且**引号/括号是配平的**（截断多半断在半个参数上）
  const count = (ch) => lastLine.split(ch).length - 1;
  const balanced = count('"') % 2 === 0 && count("(") === count(")") && count("[") === count("]");
  const tailBad = /[、，：]$|[,:(\[]$/.test(lastLine.trim());
  const endedCleanly = trimmed.length > 0 && balanced && !tailBad;
  return { sectionsMissing, sectionsPresent: present.length, endedCleanly };
}

/**
 * ★ C547：**把两种 usage 形状归一到一处**。
 *
 * 真机里同时存在两种：
 *   · 宿主在线折叠：`{inputTokens, outputTokens, cacheReadTokens}`（camelCase，inputTokens **不含**命中部分）
 *   · 离线折叠（我们自己调 provider）：`{prompt_tokens, completion_tokens, prompt_tokens_details:{cached_tokens}}`
 *
 * 以前 doctor 只读 camelCase ⇒ **离线折叠整个不进缓存统计**（真机 19 次离线折叠一次都没算进去）。
 *
 * @param {object|null|undefined} usage
 * @returns {{miss:number|null, hit:number|null, out:number|null, total:number|null}}
 */
export function normalizeUsage(usage) {
  const u = usage !== null && typeof usage === "object" ? usage : {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const miss = num(u.inputTokens) ?? num(u.prompt_tokens);
  const hit = num(u.cacheReadTokens) ?? num(u.prompt_tokens_details?.cached_tokens);
  const out = num(u.outputTokens) ?? num(u.completion_tokens);
  return { miss, hit, out, total: num(u.totalTokens) ?? num(u.total_tokens) };
}
