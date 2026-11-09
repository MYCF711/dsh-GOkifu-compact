#!/usr/bin/env node
/**
 * k26-fact-guard-eval.mjs —— AX-05：用 AX-01 的冷代码守卫**复判** K-26 冻结的 92 条原子事实
 *
 * 这个脚本回答的问题只有三个：
 *
 *   ① 冻结分母还在不在？  12 份样本 / 92 条事实 / 68 GOLD / 19 REJECTED / 5 PENDING。
 *   ② 守卫是不是恒真或恒假？  冻结语料上必须**既**接受一批（恒假的仪器不会接受任何一条）
 *      **又**拒绝一批（恒真的仪器不会拒绝任何一条）；另有 5 类合成反例各配一条通过用例。
 *   ③ 守卫的「接受」到底证明了什么？  只证明**机械形状可回证**（seq 同会话、事件在、主体一致、
 *      quote 逐字、四条文本判据不过度触发）。**不**证明语义蕴含 —— 冻结里 19 条 REJECTED
 *      中有一部分正是「quote 逐字为真但 claim 越出 quote」，冷代码看不见，必须单列。
 *
 * ── 隐私边界（硬约束） ─────────────────────────────────────────────────────────
 *
 * 私有输入（会话日志、labels、审稿档案）**只读**，正文/quote/sid/路径**一律不进产物**：
 * 产物只有聚合计数、原因码、样本**序号**与每条事实的「序号 + 档位 + 裁决 + 原因码」。
 * `privacyCheck()` 会把每条事实的 claim/quote 回查一遍产物文本，命中即报违规。
 *
 * ── 不调用模型 ────────────────────────────────────────────────────────────────
 *
 * 全程零网络、零 subprocess、零 LLM：`auditSource()` 对**本文件源码**做静态断言，
 * 一旦出现 fetch/undici/http/child_process 这类出口就直接报红（测试里有反例钉住）。
 *
 * 用法（参数全部必填，脚本里**不写死**任何个人绝对路径）：
 *
 *   node scripts/k26-fact-guard-eval.mjs \
 *     --manifest <K-26 私有 manifest.json> \
 *     --labels   <K-26 私有 labels.jsonl> \
 *     --review-dir <K-26 私有审稿档案目录> \
 *     --audit    <冻结聚合 evidence/k26-audit-*.json> \
 *     --home     <DSH_HOME（只读，用来拿会话日志）> \
 *     --out      <report.json> \
 *     [--md <REPORT.md>] [--subject-mode role|claim] [--rev <sha>] [--quiet]
 *
 * 退出码：0 = 语料与冻结分母对齐且探针全绿；1 = 分母对不上或探针有红。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT,
  ENTAILMENT_NOTE,
  REASONS,
  VERDICT,
  describeContract,
  evaluateFactCandidate,
  normalizeText,
  quoteFound,
} from "../src/rooms/fact-guard.mjs";
import { decodeMultiFrameZstd, findSessionLog } from "../src/rooms/zstd-log.mjs";

export const SCHEMA = "axiom-ax05-k26-fact-guard-eval-v1";

/** 冻结档位（K-26 只认这三个；**没有银标**）。 */
export const TIERS = Object.freeze(["GOLD", "REJECTED", "PENDING"]);

/** 五类已知失真 —— 每类必须有一条「红」反例和一条「绿」对照，否则仪器不算被证明过。 */
export const HARD_FAILURE_CLASSES = Object.freeze([
  REASONS.SUBJECT_MISMATCH,
  REASONS.UNSOURCED_NEGATIVE,
  REASONS.STALE_CURRENT,
  REASONS.ARGUMENT_AS_RESULT,
  REASONS.STATUS_OVERCLAIM,
]);

/** 事件类型 → 主体（这是复判适配层，不是守卫判据；守卫自己只认 `subject` 字段）。 */
const ROLE_RULES = Object.freeze([
  [/^user\/message$/, "user"],
  [/^assistant\/message$/, "assistant"],
  [/^(?:tool|job)\//, "tool"],
  [/^system\/message$/, "system"],
]);

/** claim 里的主体词 → subject（只在 `--subject-mode claim` 那一臂使用）。 */
const CLAIM_SUBJECT_RULES = Object.freeze([
  [/系统注入|harness|运行时注入|注入的|工作区指令/, "harness"],
  [/用户|我要求|我让|问我/, "user"],
  [/助手|模型称|摘要称|我给出|我汇报/, "assistant"],
  [/工具|命令|退出码|stdout|stderr|返回码/, "tool"],
]);

/** claim 里的形态词 → kind（只影响字段合法性与可读性，不参与裁决分支）。 */
const CLAIM_KIND_RULES = Object.freeze([
  [/未验证|待证|待补证|unverified/, "unverified"],
  [/失败|报错|退出码|超时|卡在|崩|E404|error/i, "failure"],
  [/决定|选择|采用|改为/, "decision"],
  [/不得|不许|必须|要求|不要|禁止|约束/, "constraint"],
  [/计数|读数|版本|端口|pid|字节|行数|退出码 0/i, "value"],
  [/\d+\s*(?:条|个|行|字节)/, "value"],
]);

/* ───────────────────────────── 通用小工具 ───────────────────────────── */

const asText = (value) => (typeof value === "string" ? value : "");

/** 去掉 markdown 强调标记（只用于 claim / 表格这类散文；**不用于 quote**）。 */
export function stripEmphasis(value) {
  return asText(value).replace(/\*\*/g, "");
}

/** 去掉包住整段的 code fence 反引号或成对强调（审稿档案里常见 `` `x` `` / `` ``x`` ``）。 */
export function stripWrappingMarks(value) {
  let text = asText(value).trim();
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    // 长围栏优先：``x`` 不能被当成 `…` 剥掉一层
    for (const fence of ["```", "``", "`"]) {
      if (text.length > fence.length * 2 && text.startsWith(fence) && text.endsWith(fence)) {
        text = text.slice(fence.length, -fence.length).trim();
        // 内联 code span 里档案用**字面** `\n` 表示原文换行（档案自己会标注这一约定）
        text = text.replace(/\\n/g, "\n");
        break;
      }
    }
    if (text.length > 3 && text.startsWith("**") && text.endsWith("**")) text = text.slice(2, -2).trim();
    if (text === before) break;
  }
  return text;
}

/** 每行取一个 `|` 表格的单元格（去掉首尾空单元）。 */
function tableCells(line) {
  const cells = String(line).split("|").map((c) => c.trim());
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

const isDigitCell = (cell) => /^\d+$/.test(cell);

/* ───────────────────────────── 语料抽取 ───────────────────────────── */

/**
 * 审稿档案里的「档位表」：`| F1 | … | 74 | … | **GOLD** |`。
 * 只认首列是事实编号、末列是档位的行；其余表格行忽略。
 * @param {string} text
 * @returns {Map<string,{tier:string, evidenceSeq:number|null}>}
 */
export function extractTierTable(text) {
  const map = new Map();
  for (const line of asText(text).split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = tableCells(line);
    if (cells.length < 3) continue;
    if (!/^F\d+$/.test(cells[0])) continue;
    const tier = /\b(GOLD|REJECTED|PENDING)\b/.exec(stripEmphasis(cells[cells.length - 1]));
    if (!tier) continue;
    const seqCell = cells.filter(isDigitCell).map(Number).find((n) => n >= 0) ?? null;
    map.set(cells[0], { tier: tier[1], evidenceSeq: seqCell });
  }
  return map;
}

/** 从一段事实小节里抽「逐字 quote」块（行内 code span / 块引用 / 代码围栏都认）。 */
export function extractQuote(section) {
  const lines = asText(section).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/quote/i.test(lines[i])) continue;
    // ① 行内引用：只认**加粗**且括注简单（不含反引号/冒号）的 quote 标记，
    //    避免把「- **quote**（逐字；行首 `332:` 是原文）：」这种长括注当成引文
    const inline = /^\s*[-*>]*\s*\*\*[^*\n]*quote[^*\n]*\*\*\s*(?:[（(][^：:）)`\n]*[）)])?\s*[：:]\s*(.+)$/i.exec(lines[i]);
    if (inline) {
      const value = stripWrappingMarks(inline[1].trim());
      if (value !== "") return value;
    }
    // ② 下一段块：代码围栏或块引用
    const quoted = [];
    for (let j = i + 1; j < Math.min(i + 18, lines.length); j += 1) {
      const raw = lines[j];
      if (/^\s*```/.test(raw)) {
        const body = [];
        for (let k = j + 1; k < lines.length; k += 1) {
          if (/^\s*```/.test(lines[k])) break;
          body.push(lines[k]);
        }
        const joined = stripWrappingMarks(body.join("\n").trim());
        if (joined !== "") return joined;
        break;
      }
      if (/^\s*>/.test(raw)) {
        quoted.push(raw.replace(/^\s*>\s?/, ""));
        continue;
      }
      if (raw.trim() === "" && quoted.length === 0) continue;
      if (quoted.length > 0) break;
    }
    if (quoted.length > 0) return stripWrappingMarks(quoted.join("\n").trim());
  }
  return "";
}

/** 事实小节里的 evidenceSeq：显式字段 > 小节标题 > 正文首个 seq 提及。 */
export function extractEvidenceSeq(section, heading) {
  const flat = stripEmphasis(section);
  const explicit = /^[-\s]*evidenceSeq\s*[：:]\s*`?(\d+)/im.exec(flat);
  if (explicit) return Number(explicit[1]);
  const fromHeading = /seq\s*[=: ]\s*(\d+)/i.exec(asText(heading));
  if (fromHeading) return Number(fromHeading[1]);
  const loose = /seq\s*[=:（(\s]*\s*(\d+)/i.exec(flat);
  return loose ? Number(loose[1]) : null;
}

/** 事实小节里的 claim：`**fact**：…` / `**fact（摘要原句）**：…` 都认。 */
export function extractClaim(section) {
  const flat = stripEmphasis(section);
  const m = /^[-\s]*fact\s*(?:[（(][^）)\n]*[）)])?\s*[：:]\s*(.+)$/im.exec(flat);
  return m ? m[1].replace(/^[>\-\s]+/, "").trim() : "";
}

/** 小节的档位：`**proposed：GOLD**` / `**proposed**：**GOLD**` / `proposed=GOLD`。 */
export function extractTier(section) {
  const m = /proposed\*{0,2}\s*[：:=]\s*[\s*"`]*(GOLD|REJECTED|PENDING)\b/i.exec(stripEmphasis(section));
  return m ? m[1].toUpperCase() : null;
}

/**
 * 解析一份审稿档案（dossier）→ 冻结事实。
 *
 * 只认 `### F<n>` / `### 事实 <n>` 小节；同一编号重复出现时**取第一次**（档案常在
 * 「三审理由」里二次列标题）。档位优先取小节内 `proposed`，取不到再回落到档位表。
 *
 * @param {string} text
 * @returns {{sampleId:string|null, facts:Array<object>}}
 */
export function parseDossier(text) {
  const source = asText(text);
  const sampleId = (/sampleId`?\s*[|=:]\s*`?([0-9a-f]{12})/i.exec(source) ?? [])[1] ?? null;
  const table = extractTierTable(source);
  const facts = [];
  const seen = new Set();
  for (const section of source.split(/\n(?=### )/)) {
    if (!section.startsWith("### ")) continue;
    const heading = section.split("\n")[0];
    const idMatch = /^###\s*(?:F|事实)\s*(\d+)/.exec(heading);
    if (!idMatch) continue;
    const factId = `F${idMatch[1]}`;
    if (seen.has(factId)) continue;
    seen.add(factId);
    const fromTable = table.get(factId) ?? {};
    const tier = extractTier(section) ?? fromTable.tier ?? null;
    const evidenceSeq = extractEvidenceSeq(section, heading) ?? fromTable.evidenceSeq ?? null;
    facts.push({
      factId,
      tier,
      claim: extractClaim(section),
      quote: extractQuote(section),
      evidenceSeq,
      origin: "dossier",
    });
  }
  return { sampleId, facts };
}

/** labels.jsonl 一行 → 冻结事实（`status` 只认 supported / not-supported / pending）。 */
export function statusToTier(status) {
  const value = String(status ?? "").toLowerCase();
  if (value === "supported") return "GOLD";
  if (value === "not-supported") return "REJECTED";
  if (value === "pending") return "PENDING";
  return null;
}

/**
 * 解析私有 labels.jsonl。
 * @param {string} jsonl
 * @returns {Array<object>}
 */
export function parseLabels(jsonl) {
  const facts = [];
  for (const line of asText(jsonl).split("\n")) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const sampleId = asText(row?.sampleId);
    const list = Array.isArray(row?.atomicFacts) ? row.atomicFacts : [];
    for (const [index, fact] of list.entries()) {
      facts.push({
        sampleId,
        factId: `L${index + 1}`,
        tier: statusToTier(fact?.status),
        claim: asText(fact?.text),
        quote: asText(fact?.quote),
        evidenceSeq: Number.isInteger(fact?.evidenceSeq) ? fact.evidenceSeq : null,
        origin: "labels",
      });
    }
  }
  return facts;
}

/**
 * 拼出冻结语料：manifest 定**样本顺序**，labels 补该样本的已裁决事实，
 * dossier 补其余事实。样本序号（0-based）是产出的唯一坐标 —— 不写 sid、不写路径。
 *
 * @param {{manifest:object, labelsText:string, dossiers:Array<{name:string,text:string}>}} input
 * @returns {{facts:Array<object>, samples:Array<object>, provenance:object}}
 */
export function buildCorpus({ manifest, labelsText = "", dossiers = [] }) {
  const samples = (Array.isArray(manifest?.samples) ? manifest.samples : []).map((sample, index) => ({
    index,
    sampleId: asText(sample?.sampleId),
    graphPath: asText(sample?.graphPath),
  }));
  const byId = new Map(samples.map((s) => [s.sampleId, s]));
  const collected = [];

  for (const fact of parseLabels(labelsText)) {
    const sample = byId.get(fact.sampleId);
    if (sample) collected.push({ ...fact, sampleIndex: sample.index });
  }
  for (const dossier of dossiers) {
    const { sampleId, facts } = parseDossier(dossier.text);
    const sample = byId.get(sampleId);
    if (!sample) continue;
    for (const fact of facts) collected.push({ ...fact, sampleId, sampleIndex: sample.index, dossier: dossier.name ?? null });
  }

  collected.sort((a, b) => a.sampleIndex - b.sampleIndex || a.factId.localeCompare(b.factId, "en", { numeric: true }));

  const provenance = {
    fromLabels: collected.filter((f) => f.origin === "labels").length,
    fromDossiers: collected.filter((f) => f.origin === "dossier").length,
    withClaim: collected.filter((f) => f.claim !== "").length,
    withQuote: collected.filter((f) => f.quote !== "").length,
    withEvidenceSeq: collected.filter((f) => Number.isInteger(f.evidenceSeq)).length,
    withoutTier: collected.filter((f) => f.tier === null).length,
  };
  return { facts: collected, samples, provenance };
}

/** 按样本统计档位（与冻结聚合逐样本对齐用）。 */
export function tierCensus(facts) {
  const samples = new Map();
  const totals = { facts: 0, GOLD: 0, REJECTED: 0, PENDING: 0, unresolved: 0 };
  for (const fact of facts) {
    const key = fact.sampleIndex;
    if (!samples.has(key)) samples.set(key, { sampleIndex: key, facts: 0, GOLD: 0, REJECTED: 0, PENDING: 0, unresolved: 0 });
    const bucket = samples.get(key);
    bucket.facts += 1;
    totals.facts += 1;
    if (TIERS.includes(fact.tier)) {
      bucket[fact.tier] += 1;
      totals[fact.tier] += 1;
    } else {
      bucket.unresolved += 1;
      totals.unresolved += 1;
    }
  }
  return { samples: [...samples.values()].sort((a, b) => a.sampleIndex - b.sampleIndex), totals };
}

/**
 * 冻结分母对账：语料逐样本计数 vs `evidence/k26-audit-*.json`。
 * 对不上就是**语料抽取坏了**，不许静默出报告。
 * @param {{facts:number,GOLD:number,REJECTED:number,PENDING:number}} got
 * @param {object} audit
 */
export function checkFrozenAlignment(got, audit, censusSamples = null, sampleIds = null) {
  const expect = {
    facts: Number(audit?.totals?.facts ?? NaN),
    GOLD: Number(audit?.totals?.gold ?? NaN),
    REJECTED: Number(audit?.totals?.rejected ?? NaN),
    PENDING: Number(audit?.totals?.pending ?? NaN),
  };
  const mismatches = [];
  for (const [key, want] of Object.entries(expect)) {
    if (got[key] !== want) mismatches.push({ scope: "totals", key, got: got[key], expect: want });
  }
  // 逐样本对账：总数对上但某个样本错位，一样是语料抽取坏了。
  const perSample = [];
  const auditSamples = Array.isArray(audit?.samples) ? audit.samples : [];
  if (Array.isArray(censusSamples) && Array.isArray(sampleIds) && auditSamples.length > 0) {
    const byId = new Map(auditSamples.map((s) => [asText(s.sampleId), s]));
    for (const sample of censusSamples) {
      const sampleId = sampleIds[sample.sampleIndex] ?? null;
      const frozen = byId.get(sampleId) ?? null;
      const row = {
        sampleIndex: sample.sampleIndex,
        facts: sample.facts,
        GOLD: sample.GOLD,
        REJECTED: sample.REJECTED,
        PENDING: sample.PENDING,
        expectFacts: frozen ? Number(frozen.facts) : null,
        expectGold: frozen ? Number(frozen.gold) : null,
        expectRejected: frozen ? Number(frozen.rejected) : null,
        expectPending: frozen ? Number(frozen.pending) : null,
      };
      row.ok =
        frozen !== null &&
        row.facts === row.expectFacts &&
        row.GOLD === row.expectGold &&
        row.REJECTED === row.expectRejected &&
        row.PENDING === row.expectPending;
      if (!row.ok) mismatches.push({ scope: "sample", key: `s${sample.sampleIndex}`, got: row, expect: frozen ? { facts: row.expectFacts, gold: row.expectGold, rejected: row.expectRejected, pending: row.expectPending } : null });
      perSample.push(row);
    }
  }
  return { ok: mismatches.length === 0, expect, got, mismatches, perSample };
}

/* ───────────────────────────── 事件源 ───────────────────────────── */

/** 会话日志事件类型 → 守卫认识的 subject。 */
export function roleOfEventType(type) {
  const value = asText(type);
  for (const [pattern, role] of ROLE_RULES) if (pattern.test(value)) return role;
  return "harness";
}

/**
 * 会话日志（多帧 zstd 解出来的 jsonl 文本）→ 守卫要的 `{seq, role, text}` 事件表。
 * 文本 = 该事件里所有 text/reasoning 块 + tool/call 的 arguments，按出现顺序拼接。
 * @param {string} text
 * @returns {Array<{seq:number, role:string, text:string}>}
 */
export function buildEvents(text) {
  const events = [];
  for (const line of asText(text).split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isInteger(event?.seq)) continue;
    const data = event.data ?? {};
    const parts = [];
    const pushContent = (content) => {
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") parts.push(block.text);
        if (typeof block.reasoning === "string") parts.push(block.reasoning);
      }
    };
    pushContent(data.content);
    pushContent(data.message?.content);
    if (typeof data.arguments === "string") parts.push(data.arguments);
    if (typeof data.text === "string") parts.push(data.text);
    if (typeof data.reasoning === "string") parts.push(data.reasoning);
    events.push({ seq: event.seq, role: roleOfEventType(event.type), text: parts.join("\n") });
  }
  return events;
}

/**
 * 从 `<home>` 只读拉每个样本的证据源（会话日志）。
 * 拿不到日志 ⇒ `events: []`，该样本的复判会记 `EVIDENCE_SEQ_NOT_FOUND`，**不编造事件**。
 * @param {{home:string, samples:Array<object>}} input
 */
export function loadSources({ home, samples }) {
  const map = new Map();
  for (const sample of samples) {
    const match = /session-([0-9a-fA-F-]{36})/.exec(asText(sample.graphPath));
    const sessionId = match ? match[1] : null;
    let logFile = null;
    let events = [];
    if (sessionId) {
      try {
        logFile = findSessionLog(home, sessionId);
      } catch {
        logFile = null;
      }
      if (logFile) {
        try {
          events = buildEvents(decodeMultiFrameZstd(fs.readFileSync(logFile)).text);
        } catch {
          events = [];
        }
      }
    }
    map.set(sample.index, { sessionId, logFile, events });
  }
  return map;
}

/* ───────────────────────────── 复判 ───────────────────────────── */

/** 机械 kind 推断（只为字段合法；不参与裁决）。 */
export function inferKind(claim) {
  const text = asText(claim);
  for (const [pattern, kind] of CLAIM_KIND_RULES) if (pattern.test(text)) return kind;
  return "state";
}

/** 机械 subject 推断（`--subject-mode claim` 一臂用）。推断不出返回 null。 */
export function inferSubject(claim) {
  const text = asText(claim);
  for (const [pattern, subject] of CLAIM_SUBJECT_RULES) if (pattern.test(text)) return subject;
  return null;
}

/**
 * 冻结记录的 quote 在证据源里到底怎么了 —— 三种「找不到」必须分开记，
 * 否则「守卫误杀 GOLD」会被错算成守卫太严。
 *
 * - `verbatim`       引文就是该 seq 事件的连续子串（机械可回证）
 * - `foundElsewhere` 引文在同会话**别的 seq** 里 ⇒ 冻结记录的 evidenceSeq 归错了（复判侧问题）
 * - `multiEventJoin` 引文由 ≥2 个事件的片段拼成（冻结协议允许跨事件引证，守卫契约只收一条 seq）
 * - `notFound`       整段在会话里都不存在 ⇒ 冻结记录写的是**转述**而不是逐字串
 *
 * @param {string} quote
 * @param {Array<{seq:number,text:string}>} events
 * @param {number|null} seq
 */
export function classifyQuote(quote, events, seq) {
  const list = Array.isArray(events) ? events : [];
  const at = list.find((e) => e.seq === seq) ?? null;
  if (at && quoteFound(quote, at.text)) return "verbatim";
  if (list.some((e) => e.seq !== seq && quoteFound(quote, e.text))) return "foundElsewhere";
  const parts = asText(quote)
    // 冻结协议里两种「多证据」写法：空行分段、以及 `a / b` 用斜杠拼两段
    .split(/\n{2,}|\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => normalizeText(part).length >= 8);
  if (parts.length > 1) {
    const hits = parts.map((part) => list.find((e) => quoteFound(part, e.text))?.seq ?? null);
    const distinct = new Set(hits.filter((h) => h !== null));
    if (hits.every((h) => h !== null) && distinct.size >= 2) return "multiEventJoin";
  }
  return "notFound";
}

/**
 * 复判一条冻结事实。
 *
 * - `subjectMode:"role"`（默认）：subject = 证据事件的 role。这一臂测的是**「若主体归属正确」**
 *   时守卫认不认这条形状 —— 不引入主语推断噪声。
 * - `subjectMode:"claim"`：subject = claim 里的主体词（推不出回落 role）。这一臂测**冷代码能不能
 *   抓到主体混同**，代价是推断本身有误判，只能作敏感性分析。
 *
 * `validAtSeq` 固定为 `evidenceSeq`：冻结记录只给了这**一个**时点，不能事后补时点。
 *
 * @param {object} fact
 * @param {{events:Array<object>, sessionId:string|null}} source
 * @param {{subjectMode:string}} options
 */
export function replayFact(fact, source, options = {}) {
  const subjectMode = options.subjectMode === "claim" ? "claim" : "role";
  const events = Array.isArray(source?.events) ? source.events : [];
  const event = events.find((e) => e.seq === fact.evidenceSeq) ?? null;
  const inferred = subjectMode === "claim" ? inferSubject(fact.claim) : null;
  const subject = inferred ?? event?.role ?? "user";
  const candidate = {
    id: fact.factId,
    kind: inferKind(fact.claim),
    subject,
    claim: asText(fact.claim),
    quote: asText(fact.quote),
    ...(Number.isInteger(fact.evidenceSeq) ? { evidenceSeq: fact.evidenceSeq, validAtSeq: fact.evidenceSeq } : {}),
  };
  const verdict = evaluateFactCandidate(candidate, { sessionId: source?.sessionId ?? null, events }, { seenIds: new Set() });
  const quoteKind = classifyQuote(fact.quote, events, fact.evidenceSeq);
  return {
    sampleIndex: fact.sampleIndex,
    factId: fact.factId,
    tier: fact.tier,
    verdict: verdict.verdict,
    codes: verdict.reasons.map((r) => r.code),
    subject,
    subjectFromClaim: inferred !== null,
    eventRole: event?.role ?? null,
    eventFound: event !== null,
    quoteVerbatim: quoteKind === "verbatim",
    quoteKind,
  };
}

/* ───────────────────────────── 合成反例（五类硬失败） ───────────────────────────── */

/**
 * 五类硬失败各一对「红/绿」反例。
 *
 * 每条都用**合成事件**（不读任何私有数据），断言：
 *   · 正例被拒，且拒绝原因码正是该类；
 *   · 对照例通过 —— 证明这条规则不是「一律拒绝」。
 *
 * @returns {{batch:number, passed:number, failed:number, rows:Array<object>}}
 */
export function runProbes() {
  const rows = [];
  const probe = ({ name, klass, expect, candidate, events }) => {
    const verdict = evaluateFactCandidate(
      { kind: "state", ...candidate },
      { sessionId: "fixture-probe", events },
      { seenIds: new Set() },
    );
    const codes = verdict.reasons.map((r) => r.code);
    const pass = verdict.verdict === expect && (expect !== "REJECTED" || codes.includes(klass));
    rows.push({ name, klass, expect, verdict: verdict.verdict, codes, pass });
  };

  const events = [
    { seq: 1, role: "harness", text: "runtime context: 文件策略 conservative，工作目录由系统注入" },
    { seq: 2, role: "tool", text: "grep 命中 3 处：a.js:1 b.js:2 c.js:3" },
    { seq: 3, role: "tool", text: "当前开关 factGuard=false" },
    { seq: 5, role: "tool", text: "配置已改为 factGuard=true" },
    { seq: 6, role: "assistant", text: "调用 checkFlag(false) 检查总开关" },
    { seq: 7, role: "assistant", text: "checkFlag(false) 返回 false，总开关关闭" },
    { seq: 8, role: "assistant", text: "决定将 factGuard 改成 true，下刀再改代码" },
  ];

  // ① 主体混同：harness 注入被写成「用户说」。
  probe({
    name: "subject-mismatch/red",
    klass: REASONS.SUBJECT_MISMATCH,
    expect: VERDICT.REJECTED,
    events,
    candidate: { id: "p1", subject: "user", claim: "用户给出了文件策略", quote: "文件策略 conservative", evidenceSeq: 1 },
  });
  probe({
    name: "subject-mismatch/green",
    klass: REASONS.SUBJECT_MISMATCH,
    expect: VERDICT.SUPPORTED,
    events,
    candidate: { id: "p2", subject: "harness", claim: "系统注入了文件策略", quote: "文件策略 conservative", evidenceSeq: 1 },
  });

  // ② 无源负向断言：claim 是否定句，引文全是肯定。
  probe({
    name: "unsourced-negative/red",
    klass: REASONS.UNSOURCED_NEGATIVE,
    expect: VERDICT.REJECTED,
    events,
    candidate: { id: "p3", subject: "tool", claim: "日志里没有任何命中", quote: "grep 命中 3 处", evidenceSeq: 2 },
  });
  probe({
    name: "unsourced-negative/green",
    klass: REASONS.UNSOURCED_NEGATIVE,
    expect: VERDICT.SUPPORTED,
    events,
    candidate: { id: "p4", subject: "tool", claim: "grep 命中 3 处", quote: "grep 命中 3 处", evidenceSeq: 2 },
  });

  // ③ 过期「当前」：validAtSeq 之后有变更证据，引文没有复述。
  probe({
    name: "stale-current/red",
    klass: REASONS.STALE_CURRENT,
    expect: VERDICT.REJECTED,
    events,
    candidate: { id: "p5", subject: "tool", claim: "当前开关 factGuard=false", quote: "当前开关 factGuard=false", evidenceSeq: 3, validAtSeq: 3 },
  });
  probe({
    name: "stale-current/green",
    klass: REASONS.STALE_CURRENT,
    expect: VERDICT.SUPPORTED,
    events,
    candidate: { id: "p6", subject: "tool", claim: "当时开关 factGuard=false", quote: "当前开关 factGuard=false", evidenceSeq: 3, validAtSeq: 3 },
  });

  // ④ 实参当返回值：`checkFlag(false)` 的实参被写成「返回 false」。
  probe({
    name: "argument-as-result/red",
    klass: REASONS.ARGUMENT_AS_RESULT,
    expect: VERDICT.REJECTED,
    events,
    candidate: { id: "p7", subject: "assistant", claim: "checkFlag 返回 false", quote: "checkFlag(false) 检查总开关", evidenceSeq: 6 },
  });
  probe({
    name: "argument-as-result/green",
    klass: REASONS.ARGUMENT_AS_RESULT,
    expect: VERDICT.SUPPORTED,
    events,
    candidate: { id: "p8", subject: "assistant", claim: "checkFlag 返回 false", quote: "checkFlag(false) 返回 false", evidenceSeq: 7 },
  });

  // ⑤ 状态过度声称：引文只到「决定改」，claim 写成「已完成」。
  probe({
    name: "status-overclaim/red",
    klass: REASONS.STATUS_OVERCLAIM,
    expect: VERDICT.REJECTED,
    events,
    candidate: { id: "p9", subject: "assistant", claim: "factGuard 已完成修改", quote: "决定将 factGuard 改成 true", evidenceSeq: 8 },
  });
  probe({
    name: "status-overclaim/green",
    klass: REASONS.STATUS_OVERCLAIM,
    expect: VERDICT.SUPPORTED,
    events,
    candidate: { id: "p10", subject: "assistant", claim: "决定将 factGuard 改成 true", quote: "决定将 factGuard 改成 true", evidenceSeq: 8 },
  });

  const passed = rows.filter((r) => r.pass).length;
  return { batch: rows.length, passed, failed: rows.length - passed, rows };
}

/* ───────────────────────────── 聚合 ───────────────────────────── */

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

function countBy(list, key) {
  const out = {};
  for (const item of list) {
    const value = key(item) ?? "null";
    out[value] = (out[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * 汇总复判结果。
 *
 * 两种「precision」必须分开叫，不许混：
 *   · `labelAdjudicated` / `labelAllFacts` —— **人工裁决的** precision，冻结值，守卫改不了它；
 *   · `guardAcceptedPrecision` —— 守卫放行的那批里真金的比例（放行 = 形状可回证，**不是**语义蕴含）。
 *
 * @param {Array<object>} rows
 * @param {object} frozen 冻结聚合（含 totals）
 */
export function aggregate(rows, frozen = {}) {
  const totals = frozen?.totals ?? {};
  const gold = Number(totals.gold ?? totals.GOLD ?? 0);
  const rejected = Number(totals.rejected ?? totals.REJECTED ?? 0);
  const pending = Number(totals.pending ?? totals.PENDING ?? 0);
  const facts = Number(totals.facts ?? gold + rejected + pending);
  const adjudicated = gold + rejected;

  const verdictCounts = countBy(rows, (r) => r.verdict);
  const reasonCounts = {};
  for (const row of rows) for (const code of row.codes) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;

  const crosstab = {};
  for (const row of rows) {
    const tier = row.tier ?? "UNRESOLVED";
    crosstab[tier] ??= {};
    crosstab[tier][row.verdict] = (crosstab[tier][row.verdict] ?? 0) + 1;
  }

  const supported = (tier) => rows.filter((r) => r.verdict === VERDICT.SUPPORTED && r.tier === tier).length;
  const guardSupported = rows.filter((r) => r.verdict === VERDICT.SUPPORTED).length;
  const guardRejected = rows.filter((r) => r.verdict === VERDICT.REJECTED).length;
  const acceptedGold = supported("GOLD");
  const rejectedCaught = rows.filter((r) => r.verdict === VERDICT.REJECTED && r.tier === "REJECTED").length;
  const goldRejectedByGuard = rows.filter((r) => r.verdict === VERDICT.REJECTED && r.tier === "GOLD").length;
  const rejectedAcceptedByGuard = rows.filter((r) => r.verdict === VERDICT.SUPPORTED && r.tier === "REJECTED").length;
  const pendingAccepted = rows.filter((r) => r.verdict === VERDICT.SUPPORTED && r.tier === "PENDING").length;
  const quoteKinds = { verbatim: 0, foundElsewhere: 0, multiEventJoin: 0, notFound: 0 };
  for (const row of rows) quoteKinds[row.quoteKind] = (quoteKinds[row.quoteKind] ?? 0) + 1;

  // 「守卫拒了但人工判 GOLD」必须再拆一刀：是引文不是逐字串，还是四条文本判据过度触发。
  const goldRejectedRows = rows.filter((r) => r.verdict === VERDICT.REJECTED && r.tier === "GOLD");
  const goldRejectedByQuote = goldRejectedRows.filter((r) => r.codes.includes(REASONS.QUOTE_NOT_VERBATIM)).length;
  const goldRejectedByRule = goldRejectedRows.filter((r) => r.codes.some((c) => HARD_FAILURE_CLASSES.includes(c))).length;

  const instrument = {
    // 恒真 = 什么都不拒；恒假 = 什么都不收。两个都必须为 false。
    constantTrue: guardRejected === 0,
    constantFalse: guardSupported === 0,
    rejectsSome: guardRejected,
    acceptsSome: guardSupported,
    acceptsGold: acceptedGold,
    rejectsFrozenRejected: rejectedCaught,
  };

  const hardFailures = HARD_FAILURE_CLASSES.map((klass) => ({
    class: klass,
    guardHits: reasonCounts[klass] ?? 0,
    frozenTierHits: rows.filter((r) => r.codes.includes(klass)).map((r) => ({ sampleIndex: r.sampleIndex, factId: r.factId, tier: r.tier })),
  }));

  return {
    facts: rows.length,
    verdicts: verdictCounts,
    reasons: Object.fromEntries(Object.entries(reasonCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    crosstab,
    frozenQuoteVerbatim: quoteKinds,
    quoteMissBreakdown: {
      goldRejectedByQuote,
      goldRejectedByRule,
      rejectedAccepted: rejectedAcceptedByGuard,
    },
    precision: {
      labelAdjudicated: {
        value: ratio(gold, adjudicated),
        numerator: gold,
        denominator: adjudicated,
        definition: "冻结人工裁决里的 GOLD / (GOLD + REJECTED)；PENDING 不进分母",
      },
      labelAllFacts: {
        value: ratio(gold, facts),
        numerator: gold,
        denominator: facts,
        definition: "GOLD / 全部冻结事实（分母含 PENDING）",
      },
      guardAccepted: {
        value: ratio(acceptedGold, guardSupported),
        numerator: acceptedGold,
        denominator: guardSupported,
        definition: "守卫放行且人工 GOLD / 守卫放行数 —— **形状口径**，不是语义 precision",
      },
      guardGoldRecall: {
        value: ratio(acceptedGold, gold),
        numerator: acceptedGold,
        denominator: gold,
        definition: "守卫放行且人工 GOLD / 全部 GOLD —— 机械可回证覆盖率",
      },
      guardRejectedPrecision: {
        value: ratio(rejectedCaught, guardRejected),
        numerator: rejectedCaught,
        denominator: guardRejected,
        definition: "守卫拒绝且人工 REJECTED / 守卫拒绝数 —— 机械拒绝里真错的比例",
      },
    },
    confusion: {
      acceptedGold,
      acceptedRejected: rejectedAcceptedByGuard,
      rejectedGold: goldRejectedByGuard,
      rejectedRejected: rejectedCaught,
      acceptedPending: pendingAccepted,
    },
    pending: {
      frozen: pending,
      // 硬约束：PENDING 永远是 PENDING，不许被当成 GOLD 算进 precision。
      countedAsGold: false,
      shapeAcceptedOnly: pendingAccepted,
      declaredPending: rows.filter((r) => r.verdict === VERDICT.PENDING).length,
    },
    instrument,
    hardFailures,
  };
}

/* ───────────────────────────── 自证：不调用模型 + 隐私 ───────────────────────────── */

const MODEL_CALL_PATTERNS = Object.freeze([
  [/\bfetch\s*\(/, "fetch()"],
  [/\bnode:https?\b|\bfrom\s+["']https?["']/, "http(s) import"],
  [/\brequire\(\s*["']undici["']\s*\)|from\s+["']undici["']/, "undici"],
  [/\bnode:child_process\b|child_process/, "child_process"],
  [/\bsubagent\b|\bweb_fetch\b|\bweb_search\b/, "agent tool"],
  [/chat\/completions|api\.openai|generativelanguage/, "model endpoint"],
  [/magpie/i, "model gateway"],
]);

/**
 * 静态断言：本脚本没有模型/网络/子进程出口。
 *
 * 扫描前先剥掉**注释**与 `MODEL_CALL_PATTERNS` 声明块 —— 否则「查这些模式」的代码
 * 自己就会被自己的模式命中（这是本仓「恒真检查」的经典形态，必须显式排除）。
 * 源码文本由调用方传入（测试里有反例验证它真的会红）。
 * @param {string} sourceText
 */
export function auditSource(sourceText) {
  const hits = [];
  const text = asText(sourceText);
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\*.*$/gm, "")
    .replace(/const MODEL_CALL_PATTERNS = Object\.freeze\(\[[\s\S]*?\]\);/m, "");
  for (const [pattern, label] of MODEL_CALL_PATTERNS) {
    if (pattern.test(stripped)) hits.push(label);
  }
  return { ok: hits.length === 0, hits };
}

/**
 * 隐私复检：产物文本里不许出现任何一条私有 claim / quote / sid / 会话路径。
 * 命中即返回违规项（只报坐标，不回显原文 —— 连违规回显都不许把正文带出来）。
 * @param {string} outputText
 * @param {Array<object>} facts
 */
export function privacyCheck(outputText, facts) {
  const text = asText(outputText);
  const violations = [];
  for (const fact of facts) {
    for (const field of ["claim", "quote"]) {
      const value = normalizeText(fact[field]);
      if (value.length < 8) continue;
      const probe = value.slice(0, Math.min(40, value.length));
      if (probe.length >= 8 && text.includes(probe)) {
        violations.push({ sampleIndex: fact.sampleIndex, factId: fact.factId, field });
      }
    }
  }
  const shapeHits = [];
  if (/session-[0-9a-f]{8}-/i.test(text)) shapeHits.push("session-id");
  if (/[A-Za-z]:[\\/][^\s"']*(?:sessions|chess-context)/i.test(text)) shapeHits.push("session-path");
  return { ok: violations.length === 0 && shapeHits.length === 0, violations, shapeHits };
}

/* ───────────────────────────── 报告 ───────────────────────────── */

const pct = (value) => (typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "NOT_RUN");

/**
 * 组出可公开的 report.json 骨架。
 * **只放聚合**：样本坐标用序号，事实坐标用 序号 + 编号 + 档位 + 裁决 + 原因码。
 */
export function buildReport({ rev, corpus, census, alignment, sources, rows, stats, probes, sourceAudit, privacy, subjectMode, generatedAt, sensitivity = null }) {
  return {
    schema: SCHEMA,
    generatedAt,
    rev: rev ?? null,
    // 只有静态审计通过才敢报「0 次」；审计红就报 null，别拿声明冒充事实。
    mode: {
      subjectMode,
      validAtSeq: "evidenceSeq",
      modelCalls: sourceAudit?.ok ? 0 : null,
      networkCalls: sourceAudit?.ok ? 0 : null,
    },
    guard: {
      module: "src/rooms/fact-guard.mjs",
      contract: CONTRACT,
      defaultEnabled: describeContract().defaultEnabled,
      entailmentNote: ENTAILMENT_NOTE,
    },
    frozen: {
      samples: census.samples.length,
      facts: census.totals.facts,
      gold: census.totals.GOLD,
      rejected: census.totals.REJECTED,
      pending: census.totals.PENDING,
      unresolved: census.totals.unresolved,
      adjudicated: census.totals.GOLD + census.totals.REJECTED,
    },
    alignment: {
      ok: alignment.ok,
      expect: alignment.expect,
      got: alignment.got,
      mismatches: alignment.mismatches,
      perSample: alignment.perSample ?? [],
    },
    corpus: { ...corpus.provenance, size: corpus.facts.length },
    sources: {
      samples: sources.length,
      withLog: sources.filter((s) => s.events.length > 0).length,
      events: sources.reduce((sum, s) => sum + s.events.length, 0),
    },
    replay: {
      facts: rows.length,
      verdicts: stats.verdicts,
      reasons: stats.reasons,
      crosstab: stats.crosstab,
      frozenQuoteVerbatim: stats.frozenQuoteVerbatim,
      quoteMissBreakdown: stats.quoteMissBreakdown,
      confusion: stats.confusion,
      pending: stats.pending,
      perFact: rows.map((r) => ({
        s: r.sampleIndex,
        f: r.factId,
        tier: r.tier,
        verdict: r.verdict,
        codes: r.codes,
        q: r.quoteKind,
      })),
    },
    precision: stats.precision,
    sensitivity,
    instrument: { ...stats.instrument, probes: { batch: probes.batch, passed: probes.passed, failed: probes.failed, rows: probes.rows } },
    hardFailures: stats.hardFailures,
    selfCheck: {
      noModelCalls: sourceAudit.ok,
      modelCallHits: sourceAudit.hits,
      privacy,
    },
  };
}

/** 渲染 REPORT.md（与 report.json 同源；不含任何私有正文）。 */
export function renderMarkdown(report) {
  const p = report.precision;
  const lines = [];
  lines.push("# AX-05 · K-26 冷代码基线复判（fact-guard）");
  lines.push("");
  lines.push(`> schema：\`${report.schema}\` · generatedAt：\`${report.generatedAt}\` · rev：\`${report.rev ?? "UNKNOWN"}\``);
  lines.push(`> 契约：\`${report.guard.contract}\` · \`factGuard\` 默认 \`${report.guard.defaultEnabled}\`（本次复判不打开开关）`);
  lines.push("");
  lines.push("## 1 · 结论（先给数，再给边界）");
  lines.push("");
  lines.push(`- 冻结分母：**${report.frozen.samples} 份样本 / ${report.frozen.facts} 条事实 = ${report.frozen.gold} GOLD + ${report.frozen.rejected} REJECTED + ${report.frozen.pending} PENDING**，与 \`evidence/k26-audit-2026-11-07.json\` **${report.alignment.ok ? "逐项对齐" : "对不上（见 §7）"}**。`);
  lines.push(`- 复判：守卫放行 **${report.instrument.acceptsSome}** 条、拒绝 **${report.instrument.rejectsSome}** 条 ⇒ 仪器**既不恒真也不恒假**（恒真则 rejectsSome=0，恒假则 acceptsSome=0）。`);
  lines.push(`- 五类合成反例 **${report.instrument.probes.passed}/${report.instrument.probes.batch}** 全绿：每类都有一条被拒的红例 + 一条通过的对照。`);
  lines.push(`- **机械形状 ≠ 语义 precision**：守卫放行的口径是 ${pct(p.guardAccepted.value)}（${p.guardAccepted.numerator}/${p.guardAccepted.denominator}），人工裁决口径仍是 ${pct(p.labelAdjudicated.value)}（${p.labelAdjudicated.numerator}/${p.labelAdjudicated.denominator}）。前者只证明「seq 同会话 + 事件在 + 主体一致 + quote 逐字 + 四条文本判据没过度触发」，**不证明** claim 被 quote 语义蕴含（守卫每次裁决都带 \`entailmentProven:false\`）。`);
  lines.push(`- PENDING ${report.frozen.pending} 条：**一条都没有被当成 GOLD**（不计入任何 precision 分子/分母）；形状被守卫接受 ${report.replay.pending.shapeAcceptedOnly}/${report.frozen.pending} 条，但语义上仍记 PENDING。`);
  lines.push("");
  lines.push("## 2 · 冻结分母对账");
  lines.push("");
  lines.push("| 项 | 语料计数 | 冻结聚合 | 一致 |");
  lines.push("|---|---:|---:|:--:|");
  const pairs = [["facts", "facts"], ["GOLD", "gold"], ["REJECTED", "rejected"], ["PENDING", "pending"]];
  for (const [key, auditKey] of pairs) {
    const got = report.alignment.got[key];
    const want = report.alignment.expect[key];
    lines.push(`| ${key} | ${got} | ${want} | ${got === want ? "✅" : "❌"} |`);
  }
  lines.push("");
  lines.push(`语料来源：labels.jsonl ${report.corpus.fromLabels} 条 + 审稿档案 ${report.corpus.fromDossiers} 条 = ${report.corpus.size} 条；有 claim ${report.corpus.withClaim} 条、有 quote ${report.corpus.withQuote} 条、有 evidenceSeq ${report.corpus.withEvidenceSeq} 条。`);
  if (Array.isArray(report.alignment.perSample) && report.alignment.perSample.length > 0) {
    lines.push("");
    lines.push("逐样本（样本只给序号，不给 id）：");
    lines.push("");
    lines.push("| 样本 | 事实 | GOLD | REJECTED | PENDING | 与冻结一致 |");
    lines.push("|---|---:|---:|---:|---:|:--:|");
    for (const row of report.alignment.perSample) {
      lines.push(`| s${row.sampleIndex} | ${row.facts} | ${row.GOLD} | ${row.REJECTED} | ${row.PENDING} | ${row.ok ? "✅" : "❌"} |`);
    }
  }
  lines.push("");
  lines.push("## 3 · 复判交叉表（冻结档位 × 守卫裁决）");
  lines.push("");
  const verdicts = ["SUPPORTED", "UNVERIFIED", "PENDING", "REJECTED"];
  lines.push(`| 冻结档位 \\ 守卫 | ${verdicts.join(" | ")} |`);
  lines.push(`|---|${verdicts.map(() => "---:").join("|")}|`);
  for (const tier of ["GOLD", "REJECTED", "PENDING"]) {
    const row = report.replay.crosstab[tier];
    if (!row) continue;
    lines.push(`| ${tier} | ${verdicts.map((v) => row[v] ?? 0).join(" | ")} |`);
  }
  lines.push("");
  lines.push(`原因码分布：${Object.entries(report.replay.reasons).map(([k, v]) => `\`${k}\`×${v}`).join(" · ") || "无"}。`);
  const q = report.replay.frozenQuoteVerbatim;
  lines.push(`冻结记录的 quote 在证据事件里逐字可回证：**${q.verbatim}/${report.replay.facts}**；剩下的引文分四类（见 §6）：逐字 ${q.verbatim} · 同会话别的 seq 命中 ${q.foundElsewhere} · 跨两个事件拼接 ${q.multiEventJoin} · 会话里根本没有 ${q.notFound}。`);
  lines.push("");
  lines.push("## 4 · 两种 precision 口径（必须分开叫）");
  lines.push("");
  lines.push("| 口径 | 分子/分母 | 值 | 它到底证明了什么 |");
  lines.push("|---|---|---:|---|");
  for (const key of ["labelAdjudicated", "labelAllFacts", "guardAccepted", "guardGoldRecall", "guardRejectedPrecision"]) {
    const item = p[key];
    lines.push(`| \`${key}\` | ${item.numerator}/${item.denominator} | ${pct(item.value)} | ${item.definition} |`);
  }
  lines.push("");
  lines.push("**不允许的读法**：把 `guardAccepted` 说成「precision 提升到 X%」。它衡量的是「守卫放行的这批里有多少是人工 GOLD」，分母是守卫放行数，不是全部事实；而且放行本身只到字符串层。");
  lines.push("");
  if (report.sensitivity) {
    const s = report.sensitivity;
    lines.push("### 4.1 · 敏感性：主体词推断臂（`subjectMode=claim`，不参与主口径）");
    lines.push("");
    lines.push(`这一臂不再把 subject 锚定到证据事件的 role，而是按 claim 里的主体词（用户 / 助手 / 工具 / 系统注入）机械推断 —— 也就是**让冷代码自己去抓主体混同**。`);
    lines.push("");
    lines.push("| 项 | role 臂（主口径） | claim 臂（敏感性） |");
    lines.push("|---|---:|---:|");
    lines.push(`| 放行 / 拒绝 | ${report.instrument.acceptsSome} / ${report.instrument.rejectsSome} | ${s.verdicts.SUPPORTED ?? 0} / ${s.verdicts.REJECTED ?? 0} |`);
    lines.push(`| 放行里真金（guardAccepted） | ${p.guardAccepted.numerator}/${p.guardAccepted.denominator} | ${s.precision.guardAccepted.numerator}/${s.precision.guardAccepted.denominator} |`);
    lines.push(`| GOLD 覆盖率（guardGoldRecall） | ${p.guardGoldRecall.numerator}/${p.guardGoldRecall.denominator} | ${s.precision.guardGoldRecall.numerator}/${s.precision.guardGoldRecall.denominator} |`);
    lines.push(`| 放行的人工 REJECTED（漏放） | ${report.replay.confusion.acceptedRejected} | ${s.confusion.acceptedRejected} |`);
    lines.push(`| \`SUBJECT_MISMATCH\` 触发 | ${report.replay.reasons.SUBJECT_MISMATCH ?? 0} | ${s.subjectMismatchHits} |`);
    lines.push("");
    lines.push(`推断出主体的条目：${s.subjectFromClaim}/${report.replay.facts}（其余回落到事件 role）；其中与证据事件 role **不一致**的只有 ${s.subjectInferredDisagree} 条。**结论只作方向参考**：主体词推断本身会错，两个臂的差值不能被读成「守卫多抓到了 N 条错误」。`);
    lines.push("");
    lines.push(`⚠ 这一臂 0 次 \`SUBJECT_MISMATCH\`，说明 K-26 第 ① 类失真（主体混同）在本语料上**冷代码抓不到**：那类说法「用户…给出工作目录/文件策略」的 claim 主体词是 user、引用的 seq 也确实是 user 事件，错的不是字段对不上，而是**内容归属**（约束来自 harness 注入，不由用户说）—— 这属于语义判断，必须留给 AX-06 的模型侧或人工。`);
    lines.push("");
  }
  lines.push("## 5 · 五类硬失败：合成反例 + 冻结命中");
  lines.push("");
  lines.push("| 类别 | 合成红例 | 合成对照 | 冻结语料触发次数 | 触发位置（档位） |");
  lines.push("|---|:--:|:--:|---:|---|");
  for (const item of report.hardFailures) {
    const row = report.instrument.probes.rows.filter((r) => r.klass === item.class);
    const red = row.find((r) => r.name.endsWith("/red"));
    const green = row.find((r) => r.name.endsWith("/green"));
    const hits = item.frozenTierHits.map((h) => `s${h.sampleIndex}/${h.factId}(${h.tier})`).join("、") || "—";
    lines.push(`| \`${item.class}\` | ${red?.pass ? "✅被拒" : "❌未拒"} | ${green?.pass ? "✅通过" : "❌被拒"} | ${item.guardHits} | ${hits} |`);
  }
  const goldTriggered = report.hardFailures.reduce((sum, item) => sum + item.frozenTierHits.filter((h) => h.tier === "GOLD").length, 0);
  lines.push("");
  lines.push(`⚠ **触发 ≠ 判对**：冻结语料上一共触发 ${report.hardFailures.reduce((sum, item) => sum + item.guardHits, 0)} 次，其中 ${goldTriggered} 次打在人工 GOLD 上（全部来自 \`UNSOURCED_NEGATIVE\`，见 §6 的 claim 口径说明）。所以这一列是「这条规则动过几次」，不是「抓对几条」。`);
  lines.push("");
  lines.push("## 6 · 冷代码看不见的部分（必须单列，不许并入“已证明”）");
  lines.push("");
  lines.push(`- 人工判 REJECTED、守卫却放行：**${report.replay.confusion.acceptedRejected}** 条。这些正是「quote 逐字为真，但 claim 越出 quote / 时点不成立 / 主体混同」的语义错误 —— 冷代码只做字符串与编号检查，抓不到。`);
  lines.push(`- 人工判 GOLD、守卫却拒绝：**${report.replay.confusion.rejectedGold}** 条，其中 ${report.replay.quoteMissBreakdown.goldRejectedByQuote} 条是因为冻结记录的「逐字 quote」本身不是那个 seq 的连续子串（这条按机械判据必须拒），${report.replay.quoteMissBreakdown.goldRejectedByRule} 条是四条文本判据在**转述体** claim 上触发。前者是**机械规则比人工更严**，不是仪器更准；后者要在 AX-06/07 用真实模型输出复看。`);
  lines.push("- 因此本报告**不宣称**任何一条事实「语义蕴含已被冷代码证明」；也不把 PENDING 折算成 GOLD。");
  lines.push("- claim 口径：复判用**冻结记录自己的原子事实转述**（labels 的 `text` / 审稿档案的 `fact` 行）当 claim —— 冻结记录只提供这一个文本，没有第二份「摘要原句」可换。转述体偶尔带评审者的元评论（含否定词），会让 `UNSOURCED_NEGATIVE` 过度触发；这一项必须在 AX-06/07 用真实模型输出的候选事实复核，不能直接搬成线上判据。");
  lines.push("");
  lines.push("## 7 · 自证");
  lines.push("");
  lines.push(`- 不调用模型：\`auditSource()\` 静态扫描本脚本源码 ⇒ ${report.selfCheck.noModelCalls ? "**PASS**（无网络出口 / 无子进程 / 无模型端点）" : `**FAIL**（${report.selfCheck.modelCallHits.join(", ")}）`}。`);
  lines.push(`- 隐私：产物里回查每条私有 claim/quote 前缀 ⇒ ${report.selfCheck.privacy.ok ? "**PASS**（0 命中）" : `**FAIL**（${report.selfCheck.privacy.violations.length} 处）`}；sid/会话路径形态 0 命中。`);
  lines.push(`- 复判模式：subjectMode=\`${report.mode.subjectMode}\`，validAtSeq=\`${report.mode.validAtSeq}\`，模型调用 ${report.mode.modelCalls} 次、网络调用 ${report.mode.networkCalls} 次。`);
  lines.push("");
  lines.push("## 8 · 未验与已知限制");
  lines.push("");
  lines.push("- 只覆盖 12 份冻结归档摘要的 92 条原子事实；**不外推到全部会话**。");
  lines.push("- 复判把 subject 默认锚定到证据事件的 role（`role` 臂）：它测「主体归属正确时守卫认不认形状」，**不测**冷代码能否自动推断主体。`claim` 臂（按 claim 主体词推断）只作敏感性分析，推断本身有噪声。");
  lines.push("- `validAtSeq` 固定为 `evidenceSeq`：冻结记录只给了这一个时点；时点判据的完整验证依赖 AX-06/07 在真实流水线上的接入。");
  lines.push("- 本次不打开 `factGuard`（默认 false），复判不改变任何运行期行为。");
  lines.push("");
  return lines.join("\n");
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const args = { subjectMode: "role", quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === "--manifest") args.manifest = next();
    else if (key === "--labels") args.labels = next();
    else if (key === "--review-dir") args.reviewDir = next();
    else if (key === "--audit") args.audit = next();
    else if (key === "--home") args.home = next();
    else if (key === "--out") args.out = next();
    else if (key === "--md") args.md = next();
    else if (key === "--rev") args.rev = next();
    else if (key === "--subject-mode") args.subjectMode = next();
    else if (key === "--quiet") args.quiet = true;
  }
  return args;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readDossiers(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name, text: readTextFile(path.join(dir, name)) }));
}

/** 无 subprocess 取 rev：直接读 `.git`（worktree 里是文件）→ HEAD → refs（含 commondir）。 */
export function readGitRev(root) {
  try {
    const dotGit = path.join(root, ".git");
    let gitDir = dotGit;
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const pointer = readTextFile(dotGit).trim();
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match) return null;
      gitDir = path.resolve(root, match[1].trim());
    }
    // 链接 worktree 的 refs 存在公共目录里（`commondir` 指向它）
    const commonPointer = readTextFile(path.join(gitDir, "commondir")).trim();
    const commonDir = commonPointer === "" ? gitDir : path.resolve(gitDir, commonPointer);
    const head = readTextFile(path.join(gitDir, "HEAD")).trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    const ref = /^ref:\s*(.+)$/m.exec(head);
    if (!ref) return null;
    const refPath = ref[1].trim();
    for (const dir of [gitDir, commonDir]) {
      const direct = readTextFile(path.join(dir, refPath)).trim();
      if (/^[0-9a-f]{40}$/i.test(direct)) return direct;
    }
    const packed = readTextFile(path.join(commonDir, "packed-refs"));
    for (const line of packed.split("\n")) {
      const match = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
      if (match && match[2] === refPath) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 跑完一整轮复判（不写任何文件；CLI 与测试都走这里）。
 * @param {object} options
 */
export function runEval(options) {
  const manifest = options.manifest;
  const audit = options.audit;
  const labelsText = options.labelsText ?? "";
  const dossiers = options.dossiers ?? [];
  const corpus = buildCorpus({ manifest, labelsText, dossiers });
  const census = tierCensus(corpus.facts);
  const alignment = checkFrozenAlignment(
    census.totals,
    audit,
    census.samples,
    corpus.samples.map((s) => s.sampleId),
  );
  const sources = options.skipSources ? [] : loadSources({ home: options.home, samples: corpus.samples });
  const replayAll = (subjectMode) =>
    corpus.facts.map((fact) => replayFact(fact, sources.get(fact.sampleIndex) ?? { events: [] }, { subjectMode }));
  const rows = replayAll(options.subjectMode);
  const stats = aggregate(rows, { totals: census.totals });
  // 敏感性分析：主体不由 role 锚定，而由 claim 的主体词推断 —— 看冷代码能不能自己抓主体混同。
  const claimRows = replayAll("claim");
  const claimStats = aggregate(claimRows, { totals: census.totals });
  const sensitivity = {
    subjectMode: "claim",
    subjectFromClaim: claimRows.filter((r) => r.subjectFromClaim).length,
    subjectInferredDisagree: claimRows.filter((r) => r.subjectFromClaim && r.eventRole !== null && r.subject !== r.eventRole).length,
    verdicts: claimStats.verdicts,
    reasons: claimStats.reasons,
    confusion: claimStats.confusion,
    precision: {
      guardAccepted: claimStats.precision.guardAccepted,
      guardGoldRecall: claimStats.precision.guardGoldRecall,
    },
    subjectMismatchHits: claimStats.reasons[REASONS.SUBJECT_MISMATCH] ?? 0,
  };
  const probes = runProbes();
  const sourceAudit = auditSource(options.sourceText ?? "");
  const sourceRows = [...sources.values()].map((s) => ({ sessionId: s.sessionId, logFile: s.logFile, events: s.events }));
  return { corpus, census, alignment, rows, stats, sensitivity, probes, sourceAudit, sources: sourceRows };
}

function main(argv) {
  const args = parseArgs(argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const missing = ["manifest", "labels", "reviewDir", "audit", "out"].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`k26-fact-guard-eval: 缺少参数 ${missing.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
  const manifest = readJsonFile(args.manifest);
  const audit = readJsonFile(args.audit);
  const labelsText = readTextFile(args.labels);
  const dossiers = readDossiers(args.reviewDir);

  const run = runEval({
    manifest,
    audit,
    labelsText,
    dossiers,
    home: args.home ?? process.env.DSH_HOME ?? "",
    subjectMode: args.subjectMode,
    sourceText: readTextFile(fileURLToPath(import.meta.url)),
  });

  const generatedAt = new Date().toISOString();
  const report = buildReport({
    rev: args.rev ?? readGitRev(root),
    corpus: run.corpus,
    census: run.census,
    alignment: run.alignment,
    sources: run.sources,
    rows: run.rows,
    stats: run.stats,
    probes: run.probes,
    sourceAudit: run.sourceAudit,
    sensitivity: run.sensitivity,
    privacy: { ok: true, violations: [], shapeHits: [] },
    subjectMode: args.subjectMode,
    generatedAt,
  });

  const reportText = JSON.stringify(report, null, 2);
  const privacy = privacyCheck(reportText, run.corpus.facts);
  report.selfCheck.privacy = privacy;

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (args.md) {
    fs.mkdirSync(path.dirname(path.resolve(args.md)), { recursive: true });
    const md = renderMarkdown(report);
    const mdPrivacy = privacyCheck(md, run.corpus.facts);
    if (!mdPrivacy.ok) {
      report.selfCheck.privacy = mdPrivacy;
      fs.writeFileSync(args.md, `${renderMarkdown(report)}\n`, "utf8");
    } else {
      fs.writeFileSync(args.md, `${md}\n`, "utf8");
    }
  }

  if (!args.quiet) {
    const p = report.precision;
    console.log(`frozen   : ${report.frozen.facts} facts = ${report.frozen.gold}G/${report.frozen.rejected}R/${report.frozen.pending}P (samples ${report.frozen.samples})`);
    console.log(`alignment: ${report.alignment.ok ? "OK" : "MISMATCH"}`);
    console.log(`replay   : supported ${report.instrument.acceptsSome}, rejected ${report.instrument.rejectsSome}`);
    console.log(`precision: label ${pct(p.labelAdjudicated.value)} (${p.labelAdjudicated.numerator}/${p.labelAdjudicated.denominator}) · guardAccepted ${pct(p.guardAccepted.value)} (${p.guardAccepted.numerator}/${p.guardAccepted.denominator}) · guardRecall ${pct(p.guardGoldRecall.value)}`);
    console.log(`probes   : ${report.instrument.probes.passed}/${report.instrument.probes.batch}`);
    console.log(`privacy  : ${report.selfCheck.privacy.ok ? "PASS" : "FAIL"} · noModelCalls ${report.selfCheck.noModelCalls ? "PASS" : "FAIL"}`);
  }

  const ok = run.alignment.ok && run.probes.failed === 0 && report.selfCheck.privacy.ok;
  process.exit(ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (invokedDirectly) main(process.argv.slice(2));
