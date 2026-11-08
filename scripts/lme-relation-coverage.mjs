#!/usr/bin/env node
/**
 * K-27 离线关系覆盖检查器（0 模型调用、0 网络、0 落盘）。
 *
 * 检查对象：一份 lme-task50 形状的夹具（默认 v3 关系行夹具），可选同时给基线（v1）
 * 做“除 compactContext 外逐字未变”的比对。
 *
 * 逐题判定（与 docs/knowledge/长期记忆反哺-来源绑定与防过拟合.md §4 对齐）：
 *   R1 值型题：每个金标准至少一行同时含 主体 + 证据 seq + 当前值 + 状态，且 seq ∈ evidenceSeqs；
 *   R2 值位置不得放竞争状态词（retained / earlier failure 一律禁止；failed / untested /
 *      right-censored / pending 只有“它本身就是金标准”时才允许出现在 current 位置）；
 *   R3 旧值必须显式标旧：`old=<value> status=superseded|old|stale`，且 seq 早于同主体当前行；
 *   R4 ABS 题不得造关系行（金标准仍是 UNKNOWN）；
 *   R5 before/after 比较题不造关系行，但两条对照事件必须都在；
 *   R6 主体/当前值必须“落地”：逐字出现在被引用的 fullContext 行里，或与被引用主体同一
 *      （identity），或由位置推导（折叠归属 / 最新事件 seq / 已结算失败边计数）；
 *   R7 除 compactContext 外，题面/答案/evidenceSeqs/grader/applicability/fullContext 与基线逐字相同；
 *      `aliases` 必须为空（不许别名等价）。
 *
 * 用法：
 *   node scripts/lme-relation-coverage.mjs --fixtures <v3.json> [--baseline <v1.json>] [--json]
 *   node scripts/lme-relation-coverage.mjs --self-test --fixtures <v3.json> [--baseline <v1.json>]
 *
 * exit 0 = 全部通过；exit 1 = 有失败项；exit 2 = 用法/读取错误。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

export const STATUS_VOCAB = Object.freeze([
  "current",
  "settled",
  "failed",
  "untested",
  "candidate",
  "residue",
  "superseded",
  "stale",
  "archived",
  "right-censored",
  "pending",
]);

export const OLD_MARKERS = Object.freeze(["superseded", "old", "stale"]);

export const FORBIDDEN_AS_VALUE = Object.freeze(["retained", "earlier failure", "failed", "untested", "right-censored", "pending"]);

export const FORBIDDEN_ANYWHERE = Object.freeze(["retained", "earlier failure"]);

const ENTITY_SOURCE = "(?:[ne]-[a-z0-9]+(?:-[a-z0-9]+)*|fold-\\d+)";
const ENTITY_RE = new RegExp(`\\b${ENTITY_SOURCE}\\b`, "g");
const ENTITY_TEST = new RegExp(`^${ENTITY_SOURCE}$`);
const SEQ_LINE_RE = /^seq=(\d+)\s+(.*)$/;
const ARCHIVE_MARK = "[archive-only]";
const META_RE = /(?:["'](?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)["']\s*:|(?:^|\s)(?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)\s*[:=]|\bgold\b)/im;
const RELATION_RE = /^seq=(\d+)\s+(\S+)\s+(current|old)=(\S+)\s+status=(\S+)(?:\s+.*)?$/;
const STATE_RE = /^seq=(\d+)\s+(\S+)\s+status=(\S+)(?:\s+.*)?$/;

const COMPARISON_ANSWERS = new Set(["before", "after"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function entitiesIn(text) {
  return [...String(text).matchAll(ENTITY_RE)].map((match) => match[0]);
}

export function isEntity(value) {
  return ENTITY_TEST.test(String(value ?? ""));
}

export function parseEvent(line) {
  const match = SEQ_LINE_RE.exec(line);
  if (!match) return null;
  const seq = Number(match[1]);
  const body = match[2];
  const archiveOnly = body.includes(ARCHIVE_MARK);
  const tokens = body.replace(ARCHIVE_MARK, "").trim().split(/\s+/).filter(Boolean);
  const pairs = [];
  const bare = [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const value = token.slice(eq + 1);
      pairs.push({ key: token.slice(0, eq), value, items: value.split(",") });
    } else bare.push(token);
  }
  return { seq, archiveOnly, pairs, bare, raw: line };
}

export function parseContext(text) {
  return String(text)
    .split(/\r?\n/)
    .map(parseEvent)
    .filter(Boolean);
}

function tokensOf(event) {
  return event.pairs.flatMap((pair) => [pair.key, ...pair.items]).concat(event.bare);
}

/** 把 compactContext 拆成关系行 / 状态行 / 其它行。 */
export function parseCompact(text) {
  const rawLines = String(text).split(/\r?\n/);
  const lines = rawLines.filter((line) => line.trim() !== "");
  const relation = [];
  const state = [];
  const other = [];
  for (const [index, line] of rawLines.entries()) {
    if (line.trim() === "") continue;
    const lineNo = index + 1;
    const rel = RELATION_RE.exec(line);
    if (rel) {
      relation.push({ raw: line, lineNo, seq: Number(rel[1]), subject: rel[2], kind: rel[3], value: rel[4], status: rel[5] });
      continue;
    }
    const st = STATE_RE.exec(line);
    if (st) {
      state.push({ raw: line, lineNo, seq: Number(st[1]), subject: st[2], status: st[3] });
      continue;
    }
    other.push({ raw: line, lineNo });
  }
  return { lines, relation, state, other };
}

/** 折叠归属：位于该 seq 之前（含）的最后一个 checkpoint。 */
export function foldAt(context, seq) {
  let fold = null;
  for (const event of context) {
    if (event.archiveOnly) continue;
    const checkpoint = event.pairs.find((pair) => pair.key === "checkpoint");
    if (checkpoint && event.seq <= seq) fold = checkpoint.value;
  }
  return fold;
}

/** 独立重算的“行内状态”（不复用渲染器的逻辑，按文档规则重写一遍）。 */
export function statusFromLine(event, subject = null) {
  const supersedes = event.pairs.find((pair) => pair.key === "supersedes");
  if (subject && supersedes && supersedes.items.includes(subject)) return "superseded";
  // 分类（class）优先于裁决结果（result）：陈旧 untested 边的“当前分类”是 candidate/residue。
  const klass = event.pairs.find((pair) => pair.key === "class");
  if (klass) {
    if (klass.value === "candidate") return "candidate";
    if (klass.value === "residue") return "residue";
    if (klass.value === "fresh-unsettled") return "untested";
  }
  const result = event.pairs.find((pair) => pair.key === "result");
  if (result) {
    if (result.value === "failed") return "failed";
    if (result.value === "later-ok") return "settled";
    if (result.value === "untested") return "untested";
    if (result.value === "right-censored") return "right-censored";
  }
  if (event.pairs.some((pair) => pair.key === "right-censored")) return "right-censored";
  const failedSet = event.pairs.find((pair) => pair.key === "failed-set");
  if (failedSet) return failedSet.value === "none" ? "settled" : "failed";
  if (event.bare.includes("verified")) return "settled";
  for (const pair of event.pairs) {
    if (["verified", "success", "later-ok"].includes(pair.key)) return "settled";
    if (["current", "checkpoint", "latest", "root"].includes(pair.key)) return "current";
    if (pair.key === "failed") return "failed";
  }
  return "current";
}

/** 更早一行里该主体的旧值（独立实现）。 */
export function oldValueOf(event, subject) {
  if (!tokensOf(event).includes(subject)) return null;
  const primary = event.pairs.find((pair) => ["edge", "root", "current", "constraint", "constraints", "checkpoint", "verified", "success", "failed", "failed-set", "event", "latest", "right-censored", "to"].includes(pair.key));
  if (primary && primary.items[0] === subject) {
    for (const key of ["result", "class", "constraint", "current", "checkpoint", "failed-set", "path-length"]) {
      const pair = event.pairs.find((entry) => entry.key === key);
      if (!pair) continue;
      if (pair.items.includes(subject) && pair.items.length === 1) continue;
      return pair.value;
    }
    if (["failed", "later-ok", "success", "verified"].includes(primary.key)) return primary.key;
    return null;
  }
  for (const key of ["result", "class", "failed", "later-ok", "success", "verified"]) {
    const pair = event.pairs.find((entry) => entry.key === key);
    if (pair && pair.items.includes(subject)) return key === "result" || key === "class" ? pair.value : key;
  }
  return null;
}

/** 位置推导：折叠归属 / 最新事件 seq / 已结算失败边计数。 */
export function derivedFacts(question) {
  const context = parseContext(question.fullContext).filter((event) => !event.archiveOnly);
  const evidenceSeqs = new Set(question.evidenceSeqs ?? []);
  const facts = [];
  const foldDecls = context
    .filter((event) => event.pairs.some((pair) => pair.key === "checkpoint"))
    .map((event) => ({ seq: event.seq, fold: event.pairs.find((pair) => pair.key === "checkpoint").value }));
  for (const event of context) {
    if (!evidenceSeqs.has(event.seq)) continue;
    const fold = foldAt(context, event.seq);
    if (fold) facts.push({ kind: "fold-by-position", subject: "checkpoint", value: fold, seq: event.seq, declaredAt: foldDecls.filter((entry) => entry.fold === fold).map((entry) => entry.seq) });
  }
  const allSeqs = context.map((event) => event.seq);
  const latest = context.find((event) => event.pairs.some((pair) => pair.key === "latest" && pair.value === "true"));
  if (latest) facts.push({ kind: "latest-event-seq", subject: "latest", value: String(latest.seq), seq: latest.seq });
  const failed = new Set();
  for (const event of context) for (const pair of event.pairs) if (pair.key === "failed") for (const item of pair.items) failed.add(item);
  facts.push({ kind: "distinct-failed-edge-count", subject: "failed", value: String(failed.size), seq: Math.max(...(question.evidenceSeqs ?? [0])), counted: [...failed] });
  return facts;
}

/** 只有“带明确主体槽的实体行”才允许 status=current 覆盖（current 节点续接语义）。 */
function statusOverrideAllowed(event, subject, status) {
  if (status !== "current") return false;
  const currentPair = event.pairs.find((pair) => pair.key === "current");
  return Boolean(currentPair && currentPair.items.includes(subject));
}

function parseAux(row) {
  const match = /\sstatus=(\S+)(?:\s+(.*))?$/.exec(row.raw ?? "");
  if (!match || !match[2]) return [];
  return match[2]
    .trim()
    .split(/\s+/)
    .filter((token) => token.includes("="))
    .map((token) => ({ key: token.slice(0, token.indexOf("=")), value: token.slice(token.indexOf("=") + 1) }));
}

function checkAuxGrounding(row, event, facts, issues) {
  const derived = facts.find((fact) => fact.subject === row.subject && fact.value === row.value && fact.seq === row.seq);
  const pairs = event.pairs.map((pair) => `${pair.key}=${pair.value}`);
  const tokens = new Set(tokensOf(event));
  for (const aux of parseAux(row)) {
    if (pairs.includes(`${aux.key}=${aux.value}`)) continue;
    if (aux.key === "superseded-by" && aux.value.split(",").every((item) => tokens.has(item))) continue;
    if (derived && ["count", "counted"].includes(aux.key)) continue;
    issues.push(`第 ${row.lineNo} 行 seq=${row.seq} ${row.subject}: 附加字段 ${aux.key}=${aux.value} 不是被引用行的原文`);
  }
}

function checkRowGrounding(row, event, facts, issues) {
  const derived = facts.find((fact) => fact.subject === row.subject && fact.value === row.value && fact.seq === row.seq);
  if (row.value !== null && !row.identityExpected && !tokensOf(event).includes(row.value) && !derived) {
    issues.push(`第 ${row.lineNo} 行 seq=${row.seq} ${row.subject}: ${row.kind}=${row.value} 不是该行原文 token，也没有位置推导`);
  }
  const subjectGrounded = tokensOf(event).includes(row.subject) || row.subject === row.value || Boolean(derived);
  if (!subjectGrounded) issues.push(`第 ${row.lineNo} 行 seq=${row.seq} ${row.subject}: 主体在该行原文里查不到，也没有位置推导`);
  if (!STATUS_VOCAB.includes(row.status)) issues.push(`第 ${row.lineNo} 行 seq=${row.seq} ${row.subject}: status=${row.status} 不在状态词表`);
  checkAuxGrounding(row, event, facts, issues);
  if (derived) return derived;
  const expected = statusFromLine(event, row.subject);
  const compatible = row.status === expected || statusOverrideAllowed(event, row.subject, row.status);
  if (!compatible) issues.push(`第 ${row.lineNo} 行 seq=${row.seq} ${row.subject}: status=${row.status} 与该行状态 ${expected} 不符`);
  return null;
}

/**
 * 逐题检查。
 * @returns {{id:string,type:string,kind:string,covered:boolean,requirements:Array<{value:string,covered:boolean,by:string|null}>,issues:string[]}}
 */
export function checkQuestion(question) {
  const context = parseContext(question.fullContext);
  const bySeq = new Map(context.map((event) => [event.seq, event]));
  const compact = parseCompact(question.compactContext);
  const facts = derivedFacts(question);
  const gold = Array.isArray(question.answer) ? question.answer : [question.answer];
  const isAbs = question.type === "ABS";
  const isComparison = gold.every((value) => COMPARISON_ANSWERS.has(String(value)));
  const issues = [];
  const evidenceSeqs = new Set(question.evidenceSeqs ?? []);

  if (String(question.compactContext).trim() === "") issues.push("compactContext 为空");
  if (question.compactContext === question.fullContext) issues.push("compactContext 与 fullContext 相同");
  if (META_RE.test(question.compactContext)) issues.push("compactContext 含金标准元数据");
  for (const line of question.fullContext.split(/\r?\n/).filter((entry) => entry.includes(ARCHIVE_MARK))) {
    if (question.compactContext.includes(line)) issues.push("compactContext 复制了 archive-only 行");
  }
  for (const token of FORBIDDEN_ANYWHERE) {
    if (question.compactContext.includes(token)) issues.push(`compactContext 出现禁用竞争词 ${token}`);
  }
  for (const line of compact.lines) {
    const match = /^seq=(\d+)\b/.exec(line);
    if (match && !bySeq.has(Number(match[1]))) issues.push(`compact 行引用了 fullContext 里不存在的 seq=${match[1]}`);
  }

  // R4 / R5：ABS 与 before-after 不造关系行
  if (isAbs || isComparison) {
    if (compact.relation.length > 0) issues.push(`${isAbs ? "ABS" : "比较"}题造了 ${compact.relation.length} 条关系行`);
    if (isAbs && (question.grader !== "UNKNOWN" || question.answer !== "UNKNOWN")) issues.push("ABS 金标准不是 UNKNOWN/UNKNOWN");
    if (isComparison) {
      const subjects = [...new Set(compact.lines.flatMap((line) => entitiesIn(line)))];
      for (const seq of question.evidenceSeqs) {
        if (!compact.lines.some((line) => new RegExp(`^seq=${seq}\\b`).test(line))) issues.push(`比较题缺少证据行 seq=${seq}`);
      }
      if (subjects.length === 0) issues.push("比较题没有可见主体");
    }
    return { id: question.id, type: question.type, kind: isAbs ? "abs" : "comparison", covered: issues.length === 0, requirements: [], issues };
  }

  // R1/R2/R3/R6：值型题逐金标准覆盖
  const currentSeqBySubject = new Map();
  for (const row of compact.relation) {
    if (row.kind !== "current") continue;
    currentSeqBySubject.set(row.subject, Math.max(currentSeqBySubject.get(row.subject) ?? -1, row.seq));
  }
  for (const row of compact.relation) {
    const event = bySeq.get(row.seq);
    const at = `第 ${row.lineNo} 行 `;
    if (!event) {
      issues.push(`${at}seq=${row.seq} 不在 fullContext`);
      continue;
    }
    if (event.archiveOnly) issues.push(`${at}seq=${row.seq} 是 archive-only 行，不得进入关系行`);
    if (row.kind === "current") {
      if (!evidenceSeqs.has(row.seq)) issues.push(`${at}seq=${row.seq} 不在 evidenceSeqs`);
      if (FORBIDDEN_AS_VALUE.includes(row.value) && !gold.map(String).includes(row.value)) {
        issues.push(`${at}current=${row.value} 是竞争状态词，且不是该题金标准`);
      }
      if (!STATUS_VOCAB.includes(row.status)) issues.push(`${at}status=${row.status} 不在状态词表`);
      checkRowGrounding({ ...row, identityExpected: row.subject === row.value }, event, facts, issues);
    } else {
      if (!OLD_MARKERS.includes(row.status)) issues.push(`${at}旧值 status=${row.status} 未标旧`);
      if (FORBIDDEN_ANYWHERE.includes(row.value)) issues.push(`${at}old=${row.value} 是禁用竞争词`);
      const currentSeq = currentSeqBySubject.get(row.subject);
      if (currentSeq !== undefined && row.seq >= currentSeq) issues.push(`${at}旧值 seq=${row.seq} 不早于同主体当前行 seq=${currentSeq}`);
      if (!tokensOf(event).includes(row.value) && row.value !== row.subject) issues.push(`${at}old=${row.value} 不是 seq=${row.seq} 原文 token`);
    }
  }
  for (const row of compact.state) {
    const event = bySeq.get(row.seq);
    const at = `第 ${row.lineNo} 行 `;
    if (!event) issues.push(`${at}状态行 seq=${row.seq} 不在 fullContext`);
    if (!STATUS_VOCAB.includes(row.status)) issues.push(`${at}状态行 status=${row.status} 不在状态词表`);
  }

  const requirements = gold.map((value) => {
    const text = String(value);
    const candidates = compact.relation.filter((row) => {
      const matches = row.value === text || (row.kind === "current" && row.subject === text);
      if (!matches) return false;
      if (!evidenceSeqs.has(row.seq)) return false;
      if (!STATUS_VOCAB.includes(row.status)) return false;
      if (row.kind === "current" && FORBIDDEN_AS_VALUE.includes(row.value) && row.value !== text) return false;
      return true;
    });
    const by = candidates.length > 0 ? candidates[0].raw : null;
    if (!by && !isEntity(text)) issues.push(`金标准 ${JSON.stringify(text)} 没有 current 关系行`);
    if (!by && isEntity(text)) issues.push(`金标准实体 ${text} 既不是任何关系行的主体，也不是 current 值`);
    return { value: text, covered: Boolean(by), by };
  });

  // R3：同主体更早的不同值必须显式标旧
  for (const row of compact.relation.filter((entry) => entry.kind === "current" && isEntity(entry.subject))) {
    for (const event of context) {
      if (event.archiveOnly || event.seq >= row.seq) continue;
      if (!tokensOf(event).includes(row.subject)) continue;
      const oldValue = oldValueOf(event, row.subject);
      if (oldValue === null || oldValue === row.value || OLD_MARKERS.includes(oldValue)) continue;
      const marked = compact.relation.some(
        (entry) => entry.kind === "old" && entry.subject === row.subject && entry.seq === event.seq && OLD_MARKERS.includes(entry.status),
      );
      if (!marked) issues.push(`seq=${event.seq} ${row.subject}: 旧值 ${JSON.stringify(oldValue)} 未显式标旧`);
    }
  }

  return {
    id: question.id,
    type: question.type,
    kind: "relation",
    covered: requirements.every((entry) => entry.covered) && issues.length === 0,
    requirements,
    issues,
  };
}

/** 基线比对：除 compactContext 外逐字相同 + 不许 aliases + 题面/答案/阈值不变。 */
export function checkImmutable(baseline, candidate) {
  const issues = [];
  const list = (fixture) => (Array.isArray(fixture) ? fixture : fixture?.questions ?? []);
  const base = list(baseline);
  const next = list(candidate);
  if (base.length !== next.length) issues.push(`题数不同：${base.length} vs ${next.length}`);
  const byId = new Map(next.map((question) => [question.id, question]));
  for (const source of base) {
    const target = byId.get(source.id);
    if (!target) {
      issues.push(`缺题 ${source.id}`);
      continue;
    }
    for (const key of ["id", "type", "question", "answer", "evidenceSeqs", "grader", "applicability", "fullContext"]) {
      if (JSON.stringify(source[key]) !== JSON.stringify(target[key])) {
        issues.push(`${source.id}.${key} 与基线不同`);
      }
    }
    const aliases = target.aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 0)) {
      issues.push(`${source.id}.aliases 非空（禁止别名等价）`);
    }
    if (!isObject(target) || typeof target.compactContext !== "string" || target.compactContext.trim() === "") {
      issues.push(`${source.id}.compactContext 为空`);
    }
  }
  for (const question of next) {
    if (!base.some((source) => source.id === question.id)) issues.push(`多出题 ${question.id}`);
  }
  return { ok: issues.length === 0, issues };
}

export function checkFixture(candidate, { baseline = null } = {}) {
  const questions = Array.isArray(candidate) ? candidate : candidate?.questions ?? [];
  const results = questions.map(checkQuestion);
  const immutable = baseline ? checkImmutable(baseline, candidate) : { ok: true, issues: [] };
  const covered = results.filter((entry) => entry.covered).length;
  const failures = results.filter((entry) => !entry.covered);
  const valueQuestions = results.filter((entry) => entry.kind === "relation");
  return {
    schema: "k27-relation-coverage-v1",
    modelCalls: 0,
    totalQuestions: results.length,
    relationQuestions: valueQuestions.length,
    covered,
    failed: failures.length,
    coverage: `${covered}/${results.length}（值型题 ${valueQuestions.filter((entry) => entry.covered).length}/${valueQuestions.length}）`,
    immutable,
    results,
    ok: failures.length === 0 && immutable.ok,
  };
}

// ---------------------------------------------------------------------------
// 反例自测：对真实 v3 夹具做定向篡改，检查器必须把它们判红。
// ---------------------------------------------------------------------------

function cloneFixture(fixture) {
  return JSON.parse(JSON.stringify(fixture));
}

function mutate(fixture, id, fn) {
  const copy = cloneFixture(fixture);
  const target = copy.questions.find((question) => question.id === id);
  fn(target, copy);
  return copy;
}

export const COUNTEREXAMPLES = [
  {
    id: "C1-cross-line-split",
    expect: "金标准值被拆到另一行（主体行没有值）时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "checkpoint fold-1: earlier failure e-ku01-a retained\nhot: seq=303 current=later-ok";
      }),
  },
  {
    id: "C2-token-patch",
    expect: "只把金标准 token 贴到实体行、不给 seq/status/旧值语义时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=301 edge=e-ku01-a result=failed retained later-ok\nseq=303 current=later-ok";
      }),
  },
  {
    id: "C3-status-as-value",
    expect: "把竞争状态词放进 current 位置时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=301 e-ku01-a current=retained status=current";
      }),
  },
  {
    id: "C4-old-not-marked",
    expect: "旧值行未标旧（status 不是 superseded/old/stale）时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=later-ok status=settled\nseq=301 e-ku01-a old=failed status=current";
      }),
  },
  {
    id: "C5-old-dropped",
    expect: "有旧值却不标旧（直接删掉旧值行）时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=later-ok status=settled";
      }),
  },
  {
    id: "C6-abs-row-fabricated",
    expect: "ABS 题造关系行时必须判红",
    build: (fixture) =>
      mutate(fixture, "ABS-01", (question) => {
        question.compactContext = "seq=601 edge=e-abs01-missing current=failed status=failed";
      }),
  },
  {
    id: "C7-comparison-value-fabricated",
    expect: "before/after 比较题把 before 当值时必须判红",
    build: (fixture) =>
      mutate(fixture, "TR-01", (question) => {
        question.compactContext = "seq=401 edge=e-tr01-a result=failed\nseq=403 edge=e-tr01-a result=later-ok\nseq=403 e-tr01-a current=before status=settled";
      }),
  },
  {
    id: "C8-seq-not-in-evidence",
    expect: "关系行引用不在 evidenceSeqs 的 seq 时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=300 e-ku01-a current=later-ok status=settled";
      }),
  },
  {
    id: "C9-wrong-value",
    expect: "current 值不是金标准时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=failed status=settled";
      }),
  },
  {
    id: "C10-unknown-status",
    expect: "status 不在状态词表时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=later-ok status=fine";
      }),
  },
  {
    id: "C11-ungrounded-value",
    expect: "current 值/附加字段在原文里查不到时必须判红",
    build: (fixture) =>
      mutate(fixture, "IE-02", (question) => {
        question.compactContext = "seq=111 edge current=made-up status=failed reason=schema-mismatch";
      }),
  },
  {
    id: "C12-alias-added",
    expect: "给题目加 aliases 时必须判红（禁止别名等价）",
    build: (fixture) =>
      mutate(fixture, "TR-01", (question) => {
        question.aliases = ["之前"];
      }),
  },
  {
    id: "C13-answer-drift",
    expect: "改答案（哪怕只改一处）时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.answer = "earlier failure";
      }),
  },
  {
    id: "C14-fullcontext-drift",
    expect: "改 fullContext 时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.fullContext = question.fullContext.replace("result=later-ok", "result=settled");
      }),
  },
  {
    id: "C15-gold-metadata",
    expect: "compact 里出现金标准元数据时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=later-ok status=settled answer=later-ok";
      }),
  },
  {
    id: "C16-archive-leak",
    expect: "compact 复制 archive-only 行时必须判红",
    build: (fixture) =>
      mutate(fixture, "KU-01", (question) => {
        question.compactContext = "seq=303 e-ku01-a current=later-ok status=settled\nseq=302 [archive-only] first-verifier-log=archived";
      }),
  },
];

export function runSelfTest(candidate, { baseline = null } = {}) {
  const results = [];
  const baseRun = baseline ? checkFixture(baseline) : null;
  const candidateRun = checkFixture(candidate, { baseline });
  results.push({
    id: "T0-v1-negative-control",
    expect: "冻结 v1 夹具（无关系行）必须判红",
    pass: baseRun ? baseRun.ok === false : false,
    detail: baseRun ? `${baseRun.covered}/${baseRun.totalQuestions} covered，failed=${baseRun.failed}` : "未提供 baseline",
  });
  results.push({
    id: "T1-v3-positive",
    expect: "v3 夹具必须全绿",
    pass: candidateRun.ok === true,
    detail: candidateRun.coverage,
  });
  for (const example of COUNTEREXAMPLES) {
    const mutated = example.build(candidate);
    const run = checkFixture(mutated, { baseline: baseline ?? undefined });
    results.push({
      id: example.id,
      expect: example.expect,
      pass: run.ok === false,
      detail: run.results
        .filter((entry) => !entry.covered)
        .slice(0, 2)
        .flatMap((entry) => entry.issues)
        .slice(0, 2)
        .join(" | "),
    });
  }
  return {
    schema: "k27-relation-counterexample-v1",
    modelCalls: 0,
    total: results.length,
    passed: results.filter((entry) => entry.pass).length,
    failed: results.filter((entry) => !entry.pass).length,
    results,
    ok: results.every((entry) => entry.pass),
  };
}

// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(nodeFs.readFileSync(nodePath.resolve(path), "utf8"));
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const selfTest = args.includes("--self-test");
  const fixturesPath = args[args.indexOf("--fixtures") + 1];
  const baselinePath = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : null;
  if (!fixturesPath) {
    console.error("usage: node scripts/lme-relation-coverage.mjs --fixtures <v3.json> [--baseline <v1.json>] [--json] [--self-test]");
    process.exit(2);
  }
  const candidate = readJson(fixturesPath);
  const baseline = baselinePath ? readJson(baselinePath) : null;

  if (selfTest) {
    const report = runSelfTest(candidate, { baseline });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`# 反例自测：${report.passed}/${report.total} 通过（模型调用 ${report.modelCalls}）`);
      for (const entry of report.results) console.log(`${entry.pass ? "PASS" : "FAIL"} ${entry.id} — ${entry.expect}${entry.detail ? ` → ${entry.detail}` : ""}`);
    }
    process.exit(report.ok ? 0 : 1);
  }

  const report = checkFixture(candidate, { baseline });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`# 关系覆盖：${report.coverage}；失败 ${report.failed} 题（模型调用 ${report.modelCalls}）`);
    if (!report.immutable.ok) console.log(`不可变字段：FAILED\n- ${report.immutable.issues.join("\n- ")}`);
    for (const entry of report.results) {
      if (entry.covered) {
        console.log(`PASS ${entry.id} ${entry.kind}${entry.requirements.length ? ` (${entry.requirements.map((item) => item.value).join(", ")})` : ""}`);
      } else {
        console.log(`FAIL ${entry.id} ${entry.kind}`);
        for (const issue of entry.issues.slice(0, 8)) console.log(`  - ${issue}`);
      }
    }
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("lme-relation-coverage.mjs")) main(process.argv);
