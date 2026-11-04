#!/usr/bin/env node
/**
 * fold-loss-audit.mjs —— **失败边「折叠后消失」的只读定位**（C607）
 *
 * 为什么需要它：`scripts/doctor.mjs` 的「压缩保真度 · 丢失的失败边」只会点名 id
 * （`e694, e695, e696, e697`），不说**是哪一次 fold、哪一段区间、模型到底写没写**。
 * 于是「真丢了」和「探针没认出来」两件事长得一模一样 —— 而它们的修法完全相反
 * （改提示词 vs 改探针），改错一边就是往错的层打补丁。
 *
 * 这个脚本把三件事钉在一起，一眼可判：
 *   ① **哪一次 fold**：会话 id + `foldMarks` 下标 + `seqStart-seqEnd` + `trigger` + `summaryChars` + `quality`；
 *   ② **边在不在折叠区间里**：`evidence.start/end` 与 `[seqStart, seqEnd]` 有没有交集；
 *   ③ **摘要文本到底提没提**：逐字 id（`mentionsEdge`）/ 动作描述（文件名、错误短语）/ 区间记法（`e693—e698`）；
 *   ④ **走的是哪条路**：模型路径（`route.model` 有值、`fallback` 为空）还是规则摘要路径
 *      （`fallback === "rules"` 或 `tier2` 合并）。
 *
 * 判定（与任务书的 A/B/C 一一对应）：
 *   · **A 区间外** —— `seq` 不在 `[seqStart, seqEnd]` ⇒ 不是丢失，是 `quality` 探针分母算错；
 *   · **B 提示词没强制** —— 区间内、但摘要没**逐条**写出 id ⇒ 改 `renderFacts` / prompt；
 *   · **C 规则摘要路径** —— 走的是机械摘要 ⇒ 查它有没有漏失败边。
 *
 * 用法：
 *   node scripts/fold-loss-audit.mjs                          # 默认查 e694–e697（Lead 报的那 4 条）
 *   node scripts/fold-loss-audit.mjs --edges e3,e4            # 换目标边
 *   node scripts/fold-loss-audit.mjs --session fdd814b1       # 只看某个会话
 *   node scripts/fold-loss-audit.mjs --json                   # 机读
 *
 * 退出码：0 = 审计跑完（无论有没有命中）；1 = 一条都没命中（说明目标边/会话名给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { evidenceSpan } from "../src/rooms/kifu-model.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
import { renderFacts } from "../src/rooms/offline-fold.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
void HERE;

/** Lead 报的那 4 条（默认目标）。 */
const DEFAULT_EDGES = ["e694", "e695", "e696", "e697"];

/** 与 doctor / graph-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/**
 * 摘要里的**区间记法**（`e693—e698` / `e693-e698` / `e693～698` / `e693 至 e698`）。
 *
 * 为什么要认它：摘要把「连续 6 次同一动作失败」合并成一行是**压缩的本意**，
 * 但 `mentionsEdge` 是逐字匹配 ⇒ 中间那几条 `e694…e697` 会被记成「丢失」。
 * 这个函数只负责**把它识别出来**（判定用），不改变 `mentionsEdge` 的口径。
 *
 * @param {string} text
 * @returns {Array<{from:number, to:number, letter:string, raw:string}>}
 */
export function mentionedEdgeRanges(text) {
  const out = [];
  const re = /([en])\s?([0-9]{1,4})\s*(?:—|–|～|~|至|到|-{1,2})\s*(?:([en]))?\s?([0-9]{1,4})/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const letter = m[1];
    // `e693-n698` 这种跨类型写法不算（边只能和边成区间）
    if (m[3] !== undefined && m[3] !== letter) continue;
    const from = Number(m[2]);
    const to = Number(m[4]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    out.push({ from: Math.min(from, to), to: Math.max(from, to), letter, raw: m[0] });
  }
  return out;
}

/** 该 id 是否被摘要里的某个区间记法覆盖。 */
export function coveredByRange(text, edgeId) {
  const id = String(edgeId ?? "").trim();
  if (!/^[en][0-9]+$/.test(id)) return null;
  const want = Number(id.slice(1));
  for (const range of mentionedEdgeRanges(text)) {
    if (range.letter !== id[0]) continue;
    if (want >= range.from && want <= range.to) return range;
  }
  return null;
}

/**
 * 动作里**可辨认的那个词**（文件名 / 命令名）。
 *
 * 摘要写「对同一文件连续 edit → cannot modify」时，逐字 id 与文件名都没了 ——
 * 这一列就是用来区分「完全没提」与「提了动作但没提 id」的。
 * @param {string} action
 * @returns {string}
 */
export function actionToken(action) {
  const raw = String(action ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return "";
  const filePath = /file_path=([^),;]+)/.exec(raw);
  if (filePath !== null) {
    const base = filePath[1].split(/[\\/]/).filter((x) => x !== "").pop();
    if (base !== undefined && base !== "") return base;
  }
  const base = raw.split(/[\\/]/).filter((x) => x !== "").pop();
  return String(base ?? raw).slice(0, 60);
}

/** 错误短语（`cannot modify` / `exit 2` 这类）——摘要里剩下的那点线索。 */
export function errorPhrase(edge) {
  const text = String(edge?.errorSnippet ?? edge?.verify?.summary ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const head = text.split(/[：:]/)[0];
  return String(head ?? "").slice(0, 40).trim();
}

/**
 * 单条边的判定。
 * @returns {{id:string, span:string, inRange:boolean, byId:boolean, byAction:boolean, byError:boolean, range:object|null, verdict:string}}
 */
export function judgeEdge({ edge, text, range }) {
  const span = evidenceSpan(edge);
  const inRange = span === null ? false : span.end >= range.start && span.start <= range.end;
  const body = String(text ?? "");
  const byId = mentionsEdge(body, edge.id);
  const token = actionToken(edge?.action ?? edge?.intent);
  const byAction = token !== "" && body.includes(token);
  const phrase = errorPhrase(edge);
  const byError = phrase !== "" && body.includes(phrase);
  const covered = coveredByRange(body, edge.id);
  let verdict;
  if (!inRange) verdict = "区间外 ⇒ A（探针分母算错，不是丢失）";
  else if (byId) verdict = "已逐条提及 ⇒ 正常";
  else if (covered !== null) verdict = `被区间记法 \`${covered.raw}\` 吞掉（逐条 id 丢失）`;
  else if (byAction || byError) verdict = "只有动作/错误描述，没有 id（不可回查）";
  else verdict = "真丢失（动作与 id 都没有）";
  return {
    id: edge.id,
    span: span === null ? "?" : `${span.start}-${span.end}`,
    inRange,
    byId,
    byAction,
    byError,
    range: covered,
    verdict,
  };
}

/**
 * 一次 fold 是模型路径还是规则摘要路径。
 * @returns {{path:"model"|"rules", why:string}}
 */
export function foldPathOf(mark) {
  const why = [];
  if (mark?.fallback === "rules") why.push("fallback=rules");
  if (mark?.tier2 === true || mark?.trigger === "tier2") why.push("tier2 规则合并");
  if (why.length > 0) return { path: "rules", why: why.join(" + ") };
  const model = mark?.route?.model ?? null;
  const provider = mark?.route?.provider ?? null;
  return { path: "model", why: `route=${provider ?? "?"}/${model ?? "?"} · fallback=null · offline=${mark?.offline === true}` };
}

/** 摘要正文的取法：离线 fold 落在 `lastOfflineSummary`（区间要能对上）。 */
export function summaryTextFor(graph, mark) {
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") return { text: null, why: "没有 lastOfflineSummary" };
  const same = Number(last?.range?.start) === Number(mark?.seqStart) && Number(last?.range?.end) === Number(mark?.seqEnd);
  if (!same) {
    return {
      text: null,
      why: `lastOfflineSummary 是另一段（${last?.range?.start}-${last?.range?.end}），本次 fold 的正文未落盘（只有 summaryChars）`,
    };
  }
  return { text: last.text, why: `lastOfflineSummary.range=${last.range.start}-${last.range.end}` };
}

/** 扫描全部会话，找出「missingFailures 与目标边有交集」的 fold。 */
export function findLosses(sessionsDir, wantEdges, { sessionFilter = null } = {}) {
  const want = new Set(wantEdges);
  const hits = [];
  let sessions = 0;
  let marksWithQuality = 0;
  /** 全库口径：**到底几次里丢几条**（报告 ⑤ 要的「偶发」概率）。 */
  const stats = { foldsWithMissing: 0, missingEdges: 0, sessionsWithMissing: new Set() };
  /** 全库「不满」的 fold（报告 ⑤ 要看它是偶发还是系统性）。 */
  const missingFolds = [];
  for (const name of nodeFs.existsSync(sessionsDir) ? nodeFs.readdirSync(sessionsDir) : []) {
    if (sessionFilter !== null && !name.includes(sessionFilter)) continue;
    const file = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    sessions += 1;
    let graph = null;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch {
      continue;
    }
    for (const [index, mark] of (graph?.foldMarks ?? []).entries()) {
      const quality = mark?.quality;
      if (quality === null || typeof quality !== "object") continue;
      marksWithQuality += 1;
      const missing = Array.isArray(quality.missingFailures) ? quality.missingFailures.map(String) : [];
      if (missing.length > 0) {
        stats.foldsWithMissing += 1;
        stats.missingEdges += missing.length;
        stats.sessionsWithMissing.add(name);
        missingFolds.push({ session: name, index, graph, mark, missing });
      }
      if (!missing.some((id) => want.has(id))) continue;
      hits.push({ session: name, file, graph, index, mark, missing });
    }
  }
  return { hits, sessions, marksWithQuality, stats: { ...stats, sessionsWithMissing: stats.sessionsWithMissing.size }, missingFolds };
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "时间未知";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
}

function pct(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `${Math.round(n * 1000) / 1000}` : "—";
}

function reportHit(hit, wantEdges) {
  const { session, graph, index, mark, missing } = hit;
  const quality = mark.quality ?? {};
  const range = { start: Number(mark.seqStart), end: Number(mark.seqEnd) };
  const path = foldPathOf(mark);
  const summary = summaryTextFor(graph, mark);
  const text = summary.text ?? "";
  // 分母：本次区间内**应当**被写出来的失败边（与 fold-quality 同一口径）
  const inRange = failuresInFoldRange(graph, range);
  const rows = inRange.map((edge) =>
    judgeEdge({ edge, text, range: { start: range.start, end: range.end } }),
  );
  const targets = rows.filter((r) => wantEdges.includes(r.id));
  const lost = rows.filter((r) => !r.byId);
  const facts = renderFacts(graph, range).split("\n");
  const factsLines = facts.filter((line) => wantEdges.some((id) => mentionsEdge(line, id)));
  const deadEndLines = (() => {
    const body = String(text);
    const at = body.indexOf("## 已探明死路");
    if (at < 0) return [];
    const rest = body.slice(at);
    const next = rest.indexOf("\n## ", 4);
    const block = next < 0 ? rest : rest.slice(0, next);
    return block.split("\n").filter((line) => line.trim() !== "");
  })();

  const out = [];
  out.push("─".repeat(100));
  out.push(`## ${session} · foldMark #${index}`);
  out.push(`  at            ${fmtTime(mark.at)}`);
  out.push(`  seqStart-end  ${range.start}-${range.end}`);
  out.push(`  trigger       ${mark.trigger ?? "—"}`);
  out.push(`  summaryChars  ${mark.summaryChars ?? "—"}`);
  out.push(
    `  quality       constraintRecall=${pct(quality.constraintRecall)} · failureRecall=${pct(quality.failureRecall)}` +
      `（期望失败边 ${quality.expectedFailures ?? "?"} 条 / 丢 ${missing.length} 条）· expectedConstraints=${quality.expectedConstraints ?? "?"}` +
      ` · sectionsMissing=${JSON.stringify(quality.sectionsMissing ?? [])}`,
  );
  out.push(`  missingFailures  ${missing.join(", ")}`);
  out.push(`  路径          ${path.path === "model" ? "模型路径" : "规则摘要路径"}（${path.why}）`);
  out.push(`  摘要正文      ${summary.text === null ? `无 —— ${summary.why}` : `有 —— ${summary.why}，${text.length} 字符`}`);
  out.push(`  区间内失败边  ${rows.length} 条（分母）：${rows.map((r) => r.id).join(", ") || "(none)"}`);

  out.push("");
  out.push("  ── 判定表 ────────────────────────────────────────────────────────────────────────────────");
  out.push("  edge    evidence   在区间内  提到 id  提到动作  提到错误  区间记法    判定");
  for (const r of rows) {
    const mark0 = (b) => (b ? "✓" : "✗");
    out.push(
      `  ${r.id.padEnd(6)}  ${String(r.span).padEnd(10)} ${mark0(r.inRange).padEnd(8)}  ` +
        `${mark0(r.byId).padEnd(6)}  ${mark0(r.byAction).padEnd(7)}  ${mark0(r.byError).padEnd(7)}  ` +
        `${String(r.range?.raw ?? "—").padEnd(11)} ${r.verdict}`,
    );
  }

  out.push("");
  out.push("  ── 硬事实块里这 4 条（= 模型**看得到**逐条 id；按当前图重放）───────────────");
  if (factsLines.length === 0) out.push("  （事实块里没有这些边 —— 需要检查 renderFacts 是否漏渲染）");
  for (const line of factsLines) out.push(`  ${line}`);

  out.push("");
  out.push("  ── 摘要原文的「已探明死路」段 ────────────────────────────────────────────");
  if (summary.text === null) out.push(`  （正文未落盘）${summary.why}`);
  else if (deadEndLines.length === 0) out.push("  （摘要里没有「## 已探明死路」段）");
  else for (const line of deadEndLines) out.push(`  ${line}`);

  out.push("");
  out.push("  ── 分类 ────────────────────────────────────────────────────────────────");
  const anyOut = targets.some((r) => !r.inRange);
  const anyById = targets.every((r) => r.byId);
  const anyRange = targets.filter((r) => r.range !== null).length;
  if (anyOut) {
    out.push("  ⇒ **A**：目标边有落在折叠区间**之外**的 ⇒ quality 探针的分母算错（应只统计区间内的边）。");
  } else if (path.path === "rules") {
    out.push("  ⇒ **C**：走的是规则摘要路径 ⇒ 查机械摘要有没有逐条列失败边。");
  } else if (anyById) {
    out.push("  ⇒ 正常：目标边都被逐条提及（这一条 foldMark 不该出现在 doctor 的 missing 里）。");
  } else {
    out.push(
      `  ⇒ **B**：${targets.length} 条边**全部**落在折叠区间内（evidence ⊆ [${range.start}, ${range.end}]），` +
        `走的是模型路径，而摘要里**没有逐条 id** —— ` +
        `${anyRange > 0 ? `其中 ${anyRange} 条被合并成区间记法（\`${targets.find((r) => r.range !== null)?.range?.raw}\`）` : "也没有动作描述"}。` +
        "⇒ 改 `renderFacts` / prompt：死路必须**逐条**列（动作 + 为什么失败），禁止 `eA—eB` 区间合并。",
    );
  }
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const get = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? String(argv[i + 1]) : dflt;
  };
  const edgesArg = get("edges");
  const wantEdges = (edgesArg === null ? DEFAULT_EDGES : edgesArg.split(",")).map((x) => x.trim()).filter((x) => x !== "");
  const sessionFilter = get("session");
  const asJson = argv.includes("--json");
  const home = get("home", resolveHome());
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");

  const { hits, sessions, marksWithQuality, stats, missingFolds } = findLosses(sessionsDir, wantEdges, { sessionFilter });
  if (asJson) {
    const payload = {
      home,
      sessionsDir,
      wantEdges,
      sessions,
      marksWithQuality,
      stats,
      missingFolds: missingFolds.map((f) => ({ session: f.session, index: f.index, missing: f.missing })),
      hits: hits.map((hit) => {
        const range = { start: Number(hit.mark.seqStart), end: Number(hit.mark.seqEnd) };
        const summary = summaryTextFor(hit.graph, hit.mark);
        return {
          session: hit.session,
          index: hit.index,
          seqStart: range.start,
          seqEnd: range.end,
          trigger: hit.mark.trigger ?? null,
          summaryChars: hit.mark.summaryChars ?? null,
          quality: hit.mark.quality ?? null,
          missing: hit.missing,
          path: foldPathOf(hit.mark),
          summaryTextAvailable: summary.text !== null,
          summaryTextWhy: summary.why,
          edges: failuresInFoldRange(hit.graph, range).map((edge) =>
            judgeEdge({ edge, text: summary.text ?? "", range }),
          ),
        };
      }),
    };
    console.log(JSON.stringify(payload, null, 2));
    return hits.length === 0 ? 1 : 0;
  }

  console.log("=".repeat(100));
  console.log("fold-loss-audit · 失败边「折叠后消失」的只读定位（C607）");
  console.log(`home        ${home}`);
  console.log(`目标边      ${wantEdges.join(", ")}`);
  console.log(`会话        ${sessions} 个（含 quality 的 foldMark ${marksWithQuality} 条）${sessionFilter === null ? "" : ` · 过滤=${sessionFilter}`}`);
  console.log(
    `全库不满    ${stats.foldsWithMissing} 次 fold 的 missingFailures 非空（共记成丢失 ${stats.missingEdges} 条边，涉及 ${stats.sessionsWithMissing} 个会话）` +
      ` ⇒ 偶发率 ${marksWithQuality === 0 ? "—" : `${stats.foldsWithMissing}/${marksWithQuality}`}`,
  );
  console.log(`命中        ${hits.length} 次 fold 的 missingFailures 与目标边有交集`);
  if (hits.length === 0) {
    console.log("\n没有命中 —— 检查 --edges / --session，或该图早于 quality 字段（老 foldMark）。");
    return 1;
  }
  for (const hit of hits) console.log(reportHit(hit, wantEdges));

  // ★ 全库清单：13 次「不满」到底是偶发还是系统性？逐条给出可判定的证据。
  console.log("");
  console.log("─".repeat(100));
  console.log(`## 全库 missingFailures 清单（${missingFolds.length} 次 fold · 用来判断「偶发」还是「系统性」）`);
  console.log("  session                                    #   missing                        正文   区间记法");
  for (const f of missingFolds) {
    const summary = summaryTextFor(f.graph, f.mark);
    // 只看**边**的区间记法（`coveredByRange` 按 id 首字母匹配，节点区间 `n440—n443` 不会算进来）
    const coverOf = (id) => (summary.text === null ? null : coveredByRange(summary.text, id));
    const covered = f.missing.filter((id) => coverOf(id) !== null).length;
    const sample = f.missing.map(coverOf).find((r) => r !== null)?.raw ?? null;
    console.log(
      `  ${String(f.session).padEnd(42)} #${String(f.index).padEnd(2)}  ${f.missing.join(",").padEnd(30)}  ` +
        `${(summary.text === null ? "无" : "有").padEnd(4)}  ${covered > 0 ? `${covered}/${f.missing.length} 条被 \`${sample}\` 覆盖` : "—"}`,
    );
  }
  console.log("");
  console.log("=".repeat(100));
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
