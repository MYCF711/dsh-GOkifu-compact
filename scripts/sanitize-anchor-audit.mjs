#!/usr/bin/env node
/**
 * sanitize-anchor-audit.mjs —— 「摘要锚点被 sanitize 抹掉」的只读审计（T35 · **只读**）
 *
 * 为什么需要（T33 审计的第一号发现，Lead 已确认最高优先）：
 *   真机 365 条可复判摘要里，**51 条（14.0%）一个真 id 都没有** —— 全篇 `nN` 被抹成 `n?`；
 *   108 条过半被抹。而探针全绿（`unknownIds: []`、`constraintRecall: 1`）——
 *   因为它**根本没有 id 可查**。
 *
 * 根因（`sanitizeSummaryIds` 的「未来」判据）：
 *   `archive-offline` 给单事件折叠记下的区间是 `seq 8-8` / `9-9` / `11-11` 这种**退化区间**：
 *   区间里一个节点都没有，而且早于全图第一个节点（真机 58/58 都是 `min(node.seq) > range.end`）。
 *   旧判据 `span.end > range.end` 于是对**全篇**每个 `nN` 成立 ⇒ 锚点被整篇抹掉。
 *
 * 这个脚本做三件事（全部机械可核对，不评分、不调模型）：
 *   ① 对每条零锚点摘要**逐条**确认：折叠区间里是不是真的一个节点都没有；
 *      抹掉的 id 在**折叠之前**是否真实存在（用节点的 `ts` 与折叠时刻 `mark.at` 判断：
 *      `ts <= at` 的实体在摘要生成时就已存在，`ts > at` 才是「未来」）；
 *   ② 给出「**应该保留但被抹**」的 id 数量（= 占位符个数；号码本身不可逆 —— 见下）；
 *   ③ **回放**当前判据：把每个 `n?` / `e?` 回填成图中真实存在、折叠前已存在的 id（模拟模型
 *      原本写的号码），再跑一次 `sanitizeSummaryIds`，看还能保住几个。修前应全灭、修后应全保住。
 *
 * 为什么「回放」而不是直接读回原文：sanitize 是**原地替换、没有逆映射**，历史摘要里的号码
 *   已经不可恢复（正文只存最终产物）。所以这里量的是**判据的行为**（同一个函数、同一份图），
 *   不是「历史摘要被修好了」—— 后者只有重折一次才能做到，而重折要调模型（本脚本禁止）。
 *
 * 边界：
 *   · **纯只读**：只 `readFileSync` 会话棋谱，**不写任何文件**（T33 的脚本会写 tmp/，这个不写）；
 *   · 不 import 任何会写盘的函数，不调模型；
 *   · 抽样口径与 T33 同源（`resolveSummaryText`：summaryText / summaryTextRef / lastOfflineSummary 单槽）。
 *
 * 用法：
 *   node scripts/sanitize-anchor-audit.mjs              # 全量逐条 + 汇总
 *   node scripts/sanitize-anchor-audit.mjs --limit 10   # 只看前 10 条（汇总仍是全量）
 *   node scripts/sanitize-anchor-audit.mjs --json       # 机器可读
 *   node scripts/sanitize-anchor-audit.mjs --home <DIR> # 显式指定 DSH_HOME（默认读环境变量）
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceSpan } from "../src/rooms/kifu-model.mjs";
import { sanitizeSummaryIds } from "../src/rooms/fold-quality.mjs";
import { resolveHome, resolveSummaryText } from "./summary-usability-audit.mjs";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 独立 id 的判定：`n12` / `e34`，前后都不能接标识符字符（`n99e2` / `xn9y` 不是 id）。
 * 与 `findOutOfRangeIds` / `sanitizeSummaryIds` 同源（同样手动查前后字符，不用转义词边界）。
 * @param {string} text
 * @returns {string[]} 去重、保序
 */
export function anchorIds(text) {
  const seen = new Set();
  const out = [];
  for (const match of String(text ?? "").matchAll(/[en][0-9]{1,5}/g)) {
    const at = match.index ?? 0;
    const before = at > 0 ? String(text)[at - 1] : "";
    const after = String(text)[at + match[0].length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    out.push(match[0]);
  }
  return out;
}

/**
 * 占位符统计：`n?` / `e?` 各几个（按**出现次数**，不是去重 —— 一个占位符 = 一个被抹的锚点）。
 * @param {string} text
 * @returns {{n:number, e:number, total:number}}
 */
export function countPlaceholders(text) {
  const body = String(text ?? "");
  const n = (body.match(/n\?/g) ?? []).length;
  const e = (body.match(/e\?/g) ?? []).length;
  return { n, e, total: n + e };
}

/** 图中实体（节点 + 边）的「存在区间」——边的 evidence 区间，节点退化成 `[seq,seq]`。 */
function entitySpans(graph) {
  const spans = [];
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    if (Number.isFinite(seq)) spans.push({ id: String(node?.id ?? ""), kind: "node", start: seq, end: seq, ts: Number(node?.ts) });
  }
  for (const edge of Object.values(graph?.edges ?? {})) {
    const span = evidenceSpan(edge);
    if (span !== null && Number.isFinite(span.start) && Number.isFinite(span.end)) {
      spans.push({ id: String(edge?.id ?? ""), kind: "edge", start: span.start, end: span.end, ts: Number(edge?.ts) });
    }
  }
  return spans;
}

/**
 * ★ 新旧两套「未来」判据的界，放在一起好对比：
 *   · `old` = `range.end`（**修前**的判据，也是这轮 bug 的来源）；
 *   · `next` = 折叠结束前最后一个**完整存在过**的实体的 seq（`max(span.end) where span.end <= range.end`）。
 *     取不到（区间早于全图）⇒ `null` ⇒ 兜底**不判未来**（方向必须是「保留」）。
 * @param {Array<{end:number}>} spans
 * @param {number} rangeEnd
 * @returns {{old:number, next:number|null}}
 */
export function boundaries(spans, rangeEnd) {
  let next = null;
  for (const span of spans) {
    if (!Number.isFinite(span.end) || span.end > rangeEnd) continue;
    if (next === null || span.end > next) next = span.end;
  }
  return { old: rangeEnd, next };
}

/**
 * 回放用文本：把每个 `n?` / `e?` 换成图中**真实存在、且折叠前已存在**（`ts <= mark.at`）的 id。
 *
 * 为什么这样换：模型原本写的号码不可恢复，但「它写的是不是真 id」正是要判的事 ——
 *   用真 id 回填后，旧判据抹光 = 这些真 id 被误判成「未来」；新判据保住 = 误判已修。
 * 确定性：节点按 `seq` 升序、边按 `evidence.start` 升序循环取（同一份图跑几次结果一致）。
 * 只取 `[en][0-9]{1,4}` 形态（`sanitizeSummaryIds` 的匹配面就是 1–4 位，5 位以上它不碰）。
 *
 * @param {string} text
 * @param {object} graph
 * @param {number} at 折叠时刻（`mark.at`）
 * @returns {{text:string, nodes:number, edges:number}} `nodes/edges` = 可用于回填的实体数
 */
export function buildProbeText(text, graph, at) {
  const live = (entity, pick) => {
    const ts = Number(entity?.ts);
    return !Number.isFinite(ts) || ts <= Number(at); // 没有时间戳就算「已存在」（保守：宁可保留）
  };
  const usable = (id) => /^[en][0-9]{1,4}$/.test(String(id ?? ""));
  const nodes = Object.values(graph?.nodes ?? {})
    .filter((node) => Number.isFinite(Number(node?.seq)) && usable(node?.id) && live(node))
    .sort((a, b) => Number(a.seq) - Number(b.seq) || String(a.id).localeCompare(String(b.id)))
    .map((node) => String(node.id));
  const edges = Object.values(graph?.edges ?? {})
    .map((edge) => ({ id: String(edge?.id ?? ""), span: evidenceSpan(edge), ts: Number(edge?.ts) }))
    .filter((edge) => usable(edge.id) && edge.span !== null && Number.isFinite(edge.span.start) && live(edge))
    .sort((a, b) => a.span.start - b.span.start || a.id.localeCompare(b.id))
    .map((edge) => edge.id);
  let ni = 0;
  let ei = 0;
  const out = String(text ?? "").replace(/[ne]\?/g, (placeholder) => {
    if (placeholder === "n?") return nodes.length === 0 ? placeholder : nodes[ni++ % nodes.length];
    return edges.length === 0 ? placeholder : edges[ei++ % edges.length];
  });
  return { text: out, nodes: nodes.length, edges: edges.length };
}

/**
 * 一条摘要的审计（纯函数）。
 * @param {{sessionId:string, trigger:string, text:string, seqStart:number, seqEnd:number, at:number}} sample
 * @param {object} graph
 * @returns {object}
 */
export function auditSummary(sample, graph) {
  const text = String(sample?.text ?? "");
  const start = Number(sample?.seqStart);
  const end = Number(sample?.seqEnd);
  const at = Number(sample?.at);
  const ids = anchorIds(text);
  const placeholders = countPlaceholders(text);
  const spans = entitySpans(graph);
  // 「区间内节点」：节点退化成 `[seq,seq]`，落在 `[start,end]` 里的个数（旧界 `range.end` 的全部依据）。
  const nodesInRange = spans.filter((span) => span.kind === "node" && span.start >= start && span.end <= end).length;
  const boundary = boundaries(spans, end);
  // 折叠前是否已存在：用**节点/边的 ts**（不是 seq）—— seq 只说明它排在哪，ts 才说明它在不在。
  const existedAtFold = spans.filter((span) => !Number.isFinite(span.ts) || span.ts <= at).length;
  const futureAtFold = spans.filter((span) => Number.isFinite(span.ts) && span.ts > at).length;
  // 旧判据会保住几个真 id（= 有 span.end <= range.end 的）；新判据跑当前代码。
  const keptOld = ids.filter((id) => {
    const span = spans.find((candidate) => candidate.id === id);
    return span !== undefined && span.end <= end;
  }).length;
  const probe = buildProbeText(text, graph, at);
  const replayed = sanitizeSummaryIds(probe.text, graph, { start, end });
  const keptCurrent = placeholders.total - replayed.removed.length;
  return {
    sessionId: String(sample?.sessionId ?? "?"),
    trigger: String(sample?.trigger ?? "?"),
    range: { start, end },
    chars: text.length,
    ids: ids.length,
    placeholders,
    nodesInRange,
    boundary,
    existedAtFold,
    futureAtFold,
    keptOld,
    keptCurrent,
    probe: { nodes: probe.nodes, edges: probe.edges },
  };
}

/**
 * 全库审计（纯函数，便于单测）。
 * @param {Array<{sessionId:string, marks:object[], lastOfflineSummary:object|null, graph:object}>} sessions
 * @returns {{summaries:number, zeroAnchor:object[], totals:object}}
 */
export function auditSessions(sessions) {
  const zeroAnchor = [];
  let summaries = 0;
  let flip = 0; // 非退化区间上「新判据会不会多抹」——每个发生翻转的实体记 1
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const graph = session?.graph ?? { nodes: {}, edges: {} };
    const spans = entitySpans(graph);
    for (const mark of Array.isArray(session?.marks) ? session.marks : []) {
      const { text } = resolveSummaryText(mark, session?.lastOfflineSummary ?? null);
      if (text === null) continue;
      summaries += 1;
      const row = auditSummary(
        {
          sessionId: session.sessionId,
          trigger: mark?.trigger,
          text,
          seqStart: mark?.seqStart,
          seqEnd: mark?.seqEnd,
          at: Number(mark?.at ?? session?.lastOfflineSummary?.at ?? 0),
        },
        graph,
      );
      // 风险探针：新界比旧界更靠前时，落在 (next, old] 里的实体从「保留」变成「抹掉」。
      if (row.boundary.next !== null && row.boundary.next < row.boundary.old) {
        flip += spans.filter((span) => span.end > row.boundary.next && span.end <= row.boundary.old).length;
      }
      if (row.ids === 0) zeroAnchor.push(row);
    }
  }
  const sum = (pick) => zeroAnchor.reduce((total, row) => total + Number(pick(row) ?? 0), 0);
  const totals = {
    summaries,
    zeroAnchor: zeroAnchor.length,
    /** 区间里一个节点都没有的（旧界因此没有依据）。 */
    noNodesInRange: zeroAnchor.filter((row) => row.nodesInRange === 0).length,
    /** 区间早于全图第一个实体（连「区间前最后一个实体」都取不到 ⇒ 走兜底）。 */
    boundaryUnknown: zeroAnchor.filter((row) => row.boundary.next === null).length,
    /** 带占位符的（= 真的被抹过的）。 */
    withPlaceholders: zeroAnchor.filter((row) => row.placeholders.total > 0).length,
    placeholders: sum((row) => row.placeholders.total),
    placeholdersN: sum((row) => row.placeholders.n),
    placeholdersE: sum((row) => row.placeholders.e),
    /** 「应该保留但被抹」：占位符个数（号码不可逆；其中折叠时已是未来的实体见 futureAtFold）。 */
    shouldKeep: sum((row) => row.placeholders.total),
    futureAtFold: sum((row) => row.futureAtFold),
    keptOld: sum((row) => row.keptOld),
    keptCurrent: sum((row) => row.keptCurrent),
    /** 非退化区间上判定发生变化的实体数（修后应保持 0 = 没有回归）。 */
    flipped: flip,
  };
  return { summaries, zeroAnchor, totals };
}

/** 只读打开一个会话棋谱；失败返回 null（不吞成「没有折痕」）。 */
function readGraph(graphFile) {
  try {
    return JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
  } catch {
    return null;
  }
}

function pct(part, total) {
  return total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;
}

/** 固定宽度打印（中文按 2 列宽，表格才不歪）。 */
function pad(value, width) {
  const text = String(value ?? "");
  let shown = 0;
  for (const char of text) shown += char.charCodeAt(0) > 255 ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - shown));
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const get = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : dflt;
  };
  const home = resolveHome(get("home"));
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(sessionsDir)) {
    console.error(`没有棋谱目录：${sessionsDir}`);
    return 1;
  }
  const limitArg = Number(get("limit", "0"));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : Infinity;

  // ① 只读扫全库
  const sessions = [];
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    const graph = readGraph(graphFile);
    if (graph === null || typeof graph !== "object") continue;
    sessions.push({
      sessionId: String(graph.sessionId ?? entry.name),
      dir: entry.name,
      marks: Array.isArray(graph.foldMarks) ? graph.foldMarks : [],
      lastOfflineSummary: graph.lastOfflineSummary ?? null,
      graph,
    });
  }
  const { summaries, zeroAnchor, totals } = auditSessions(sessions);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ home, sessions: sessions.length, summaries, totals, zeroAnchor }, null, 2));
    return 0;
  }

  // ② 元信息
  console.log("sanitize 锚点审计（T35 · 只读 · 不写盘）");
  console.log(`home            : ${home}`);
  console.log(`语料            : ${sessions.length} 会话 / ${sessions.reduce((n, s) => n + s.marks.length, 0)} 折痕 / ${summaries} 条可复判摘要`);
  console.log("T33 快照        : 51 / 365（14.0%，2026-11-05 07:01）—— 补账仍在写，池会漂；下面是**当前**全量");
  console.log(`零锚点          : ${zeroAnchor.length} 条（${pct(zeroAnchor.length, summaries)}）· 其中 ${totals.withPlaceholders} 条带 n?/e?（= 被抹过）`);
  console.log("");

  // ③ 逐条
  console.log(`## 1. 零锚点摘要逐条（${zeroAnchor.length} 条；全部列出，不截断）`);
  console.log("");
  console.log(
    "| # | 会话 | 区间(seq) | 字符 | 锚点 n?/e? | 真id | 区间内节点 | 区间前最后实体 | 折叠时已存在 | 折叠时未来 | 旧判据保留 | 当前判据保留 |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  zeroAnchor.slice(0, limit).forEach((row, index) => {
    console.log(
      `| ${index + 1} | ${row.sessionId} | ${row.range.start}–${row.range.end} | ${row.chars} | ` +
        `${row.placeholders.total} (${row.placeholders.n}n/${row.placeholders.e}e) | ${row.ids} | ` +
        `${row.nodesInRange} | ${row.boundary.next === null ? "—（取不到）" : row.boundary.next} | ` +
        `${row.existedAtFold} | ${row.futureAtFold} | ${row.keptOld} | ${row.keptCurrent} |`,
    );
  });
  if (zeroAnchor.length > limit) console.log(`\n…（--limit ${limit}，省略 ${zeroAnchor.length - limit} 条）`);
  console.log("");

  // ④ 汇总
  console.log("## 2. 汇总");
  console.log("");
  console.log(`可复判摘要            : ${summaries}`);
  console.log(`零锚点摘要            : ${zeroAnchor.length}（${pct(zeroAnchor.length, summaries)}）· 带占位符 ${totals.withPlaceholders}`);
  console.log(`  · 区间内 0 个节点   : ${totals.noNodesInRange} / ${zeroAnchor.length}（旧界 \`range.end\` 没有节点依据）`);
  console.log(`  · 区间早于全图首实体 : ${totals.boundaryUnknown} / ${zeroAnchor.length}（「区间前最后一个实体」也取不到 ⇒ 走兜底）`);
  console.log(`被抹锚点总数          : ${totals.placeholders}（n? ${totals.placeholdersN} / e? ${totals.placeholdersE}）`);
  console.log(`  · 折叠时已是未来     : ${totals.futureAtFold}（0 ⇒ 旧判据「晚于折叠」这一支**没有合法对象**，抹的全是已存在实体）`);
  console.log(`  · 旧判据保留         : ${totals.keptOld}`);
  console.log(`  · 当前判据保留       : ${totals.keptCurrent}（回放：占位符回填成图中真实 id 再跑一次当前 sanitize）`);
  console.log(`「应该保留但被抹」     : ${totals.shouldKeep} 个 id（= 占位符总数；号码不可逆，见文件头）`);
  console.log("");
  const replayZero = zeroAnchor.filter((row) => row.placeholders.total === 0 || row.keptCurrent === 0).length;
  console.log(`回放后零锚点          : ${replayZero} 条（修前 ${zeroAnchor.length} 条；差 ${zeroAnchor.length - replayZero} 条 = 当前判据救回）`);
  console.log(`  · 当前判据救回锚点   : ${totals.keptCurrent} / ${totals.placeholders}`);
  console.log(`  · 回放后仍零锚点     : ${zeroAnchor.filter((row) => row.placeholders.total === 0).length} 条**本来就没有 id**（不是被抹，另有 ${replayZero - zeroAnchor.filter((row) => row.placeholders.total === 0).length} 条救不回）`);
  console.log("");
  console.log(`非退化区间回归探针    : ${totals.flipped} 个实体的判定发生变化（0 = 新判据与旧判据逐条一致，只改退化区间）`);
  console.log("");
  console.log(`（只读脚本，未写任何文件；重折需调模型，本脚本不做 —— 历史摘要的号码只能靠重折恢复）`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
