#!/usr/bin/env node
/**
 * K-27 v3 关系行夹具渲染器（0 模型调用、0 语义猜测）。
 *
 * 职责：只把 `fullContext` 里**已经存在的进程事件**投影成“关系行”，不改任何
 * 题面/答案/grader/evidenceSeqs；输出仍是 lme-task50-fixtures-v1 形状的夹具，
 * 唯一变化的字段是 `compactContext`。
 *
 * 关系行语义（对齐 docs/knowledge/长期记忆反哺-来源绑定与防过拟合.md §2.2）：
 *   seq=<n> <subject> current=<当前值> status=<状态> [<原行其它 key=value>]
 *   seq=<n> <subject> old=<旧值>     status=superseded
 *
 * 渲染规则（全部机械、可复算）：
 *   A. 值型题（非 ABS、非 before/after 比较题）才产关系行；
 *   B. 金标准是实体 id → 主体=该实体；否则若题面点名的实体是该行的“主体槽”，
 *      主体=题面实体；否则主体=承载金标准的 key（槽位），当前值=金标准；
 *   C. 主体是实体且有属性（result/class/later-ok）时，当前值取属性；属性是被禁
 *      状态词（failed/untested/…）时退化为 identity（current=主体本身）；
 *   D. `supersedes=<gold>` 时：被取代者单独成行（current=自己、status=superseded），
 *      取代者再补一行（current=属性或自己、status=当前状态）；
 *   E. 同主体更早出现的不同值 → `old=` 行，status=superseded；只有 current /
 *      constraint 两种槽位才允许“槽位旧值”行；
 *   F. 金标准在 fullContext 里没有字面命中时，只允许三种位置推导并留痕：
 *      折叠归属（fold-by-position）、最新事件 seq（latest-event-seq）、
 *      已结算失败边计数（distinct-failed-edge-count）；
 *   G. ABS 题只投影非 archive 证据行，不造任何关系行；before/after 比较题同理。
 *
 * 硬自检（不满足直接抛错，不写盘）：
 *   1. 当前行 seq 必须 ∈ evidenceSeqs；旧值行 seq 必须 ∈ fullContext 且早于当前行；
 *   2. current/old 的取值必须逐字出现在被引用行里（identity / 推导除外）；
 *   3. status 必须 ∈ STATUS_VOCAB；
 *   4. 不得出现 `[archive-only]`、金标准元数据（answer=/gold 等）。
 *
 * 用法：
 *   node scripts/lme-relation-render.mjs <v1-fixture> [out.json]
 *   node scripts/lme-relation-render.mjs --stdout <v1-fixture>
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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

/** 只允许出现在 status 位置、不允许出现在 current 位置的词（金标准本身即该词时例外）。 */
export const FORBIDDEN_AS_VALUE = Object.freeze(["retained", "earlier failure", "failed", "untested", "right-censored", "pending"]);

export const OLD_MARKERS = Object.freeze(["superseded", "old", "stale"]);

/** 允许做“槽位旧值”标记的槽位：只有真正会被新值取代的两种。 */
export const SUPERSEDING_SLOTS = Object.freeze(["current", "constraint"]);

const ENTITY_SOURCE = "(?:[ne]-[a-z0-9]+(?:-[a-z0-9]+)*|fold-\\d+)";
const ENTITY_RE = new RegExp(`\\b${ENTITY_SOURCE}\\b`, "g");
const ENTITY_TEST = new RegExp(`^${ENTITY_SOURCE}$`);
const SEQ_LINE_RE = /^seq=(\d+)\s+(.*)$/;
const ARCHIVE_MARK = "[archive-only]";
const META_RE = /(?:["'](?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)["']\s*:|(?:^|\s)(?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)\s*[:=]|\bgold\b)/im;

/** 事件行里的“主体槽”：这些键的值是某个主体。 */
const SUBJECT_KEYS = new Set([
  "edge",
  "root",
  "current",
  "constraint",
  "constraints",
  "checkpoint",
  "verified",
  "success",
  "failed",
  "failed-set",
  "residue-count",
  "event",
  "latest",
  "right-censored",
  "to",
  "inspected-edge-set",
  "inspected-node-set",
  "inspected-constraints",
  "path-length",
]);

/** 主体是实体时，属性只在这两种槽位下才取 result/class（避免把别的字段算到主体头上）。 */
const ATTRIBUTE_SLOTS = new Set(["edge", "constraint", "constraints", "event", "failed", "failed-set", "right-censored"]);

const RESULT_STATUS = new Map([
  ["failed", "failed"],
  ["later-ok", "settled"],
  ["untested", "untested"],
  ["right-censored", "right-censored"],
]);

const CLASS_STATUS = new Map([
  ["candidate", "candidate"],
  ["residue", "residue"],
  ["fresh-unsettled", "untested"],
]);

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
    } else {
      bare.push(token);
    }
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

function pairByValue(event, value) {
  return event.pairs.find((pair) => pair.items.includes(value)) ?? null;
}

function primarySubjectPair(event) {
  return event.pairs.find((pair) => SUBJECT_KEYS.has(pair.key)) ?? null;
}

function primarySubject(event) {
  const pair = primarySubjectPair(event);
  return pair ? pair.items[0] : null;
}

export function statusOf(event, subject) {
  const supersedes = event.pairs.find((pair) => pair.key === "supersedes");
  if (supersedes && supersedes.items.includes(subject)) return "superseded";
  const classPair = event.pairs.find((pair) => pair.key === "class");
  if (classPair && CLASS_STATUS.has(classPair.value)) return CLASS_STATUS.get(classPair.value);
  const resultPair = event.pairs.find((pair) => pair.key === "result");
  if (resultPair && RESULT_STATUS.has(resultPair.value)) return RESULT_STATUS.get(resultPair.value);
  if (event.pairs.some((pair) => pair.key === "right-censored")) return "right-censored";
  const failedSet = event.pairs.find((pair) => pair.key === "failed-set");
  if (failedSet) return failedSet.value === "none" ? "settled" : "failed";
  if (event.bare.includes("verified")) return "settled";
  for (const pair of event.pairs) {
    if (pair.key === "verified" || pair.key === "success" || pair.key === "later-ok") return "settled";
    if (pair.key === "current" || pair.key === "checkpoint" || pair.key === "latest" || pair.key === "root") return "current";
  }
  if (event.pairs.some((pair) => pair.key === "failed")) return "failed";
  return "current";
}

/**
 * 主体是实体时，它在**这一行**上的“当前值”：
 * 只在主体是该行主体槽的值、且槽位属于 ATTRIBUTE_SLOTS 时取 result/class；
 * `later-ok=<entity>` 这种状态槽取 “later-ok”（它是金标准出现过的真实词）；
 * 其余一律 identity（返回 subject）。
 */
export function attributeOf(event, subject) {
  const primary = primarySubjectPair(event);
  if (primary && primary.items[0] === subject) {
    if (!ATTRIBUTE_SLOTS.has(primary.key)) return null;
    for (const key of ["result", "class"]) {
      const pair = event.pairs.find((entry) => entry.key === key);
      if (!pair) continue;
      if (pair.items.includes(subject)) continue;
      if (FORBIDDEN_AS_VALUE.includes(pair.value)) continue;
      return pair.value;
    }
    if (event.pairs.some((pair) => pair.key === "later-ok" && pair.items.includes(subject))) return "later-ok";
    return null;
  }
  if (event.pairs.some((pair) => pair.key === "later-ok" && pair.items.includes(subject))) return "later-ok";
  return null;
}

function attributeOfUnused(event, subject) {
  const primary = primarySubjectPair(event);
  if (!primary || primary.items[0] !== subject) return null;
  if (!ATTRIBUTE_SLOTS.has(primary.key)) return null;
  for (const key of ["result", "class"]) {
    const pair = event.pairs.find((entry) => entry.key === key);
    if (!pair) continue;
    if (pair.items.includes(subject)) continue;
    if (FORBIDDEN_AS_VALUE.includes(pair.value)) continue;
    return pair.value;
  }
  if (event.pairs.some((pair) => pair.key === "later-ok" && pair.items.includes(subject))) return "later-ok";
  return null;
}

/** 更早一行里该主体的旧值（允许是被禁状态词：旧值就是要显式标旧）。 */
export function oldValueOf(event, subject) {
  if (!tokensOf(event).includes(subject)) return null;
  const primary = primarySubjectPair(event);
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
    if (!pair) continue;
    if (pair.items.includes(subject)) return key === "result" || key === "class" ? pair.value : key;
    if (!pair.items.some((item) => item === subject)) return pair.value;
  }
  return null;
}

/** 折叠归属：位于该事件之前的最后一个 `checkpoint=fold-N`。 */
export function foldAt(events, seq) {
  let fold = null;
  for (const event of events) {
    if (event.archiveOnly) continue;
    const checkpoint = event.pairs.find((pair) => pair.key === "checkpoint");
    if (checkpoint && event.seq <= seq) fold = checkpoint.value;
  }
  return fold;
}

function rowsText(rows) {
  return rows.map((row) => row.text).join("\n");
}

function buildRow(event, subject, value, status, { old = false, identity = false, tag = null, extraAux = [], keepState = false, dropValues = [] } = {}) {
  if (!STATUS_VOCAB.includes(status)) throw new Error(`seq=${event.seq} ${subject}: 非法 status ${status}`);
  const usedKeys = new Set();
  for (const pair of event.pairs) {
    if (pair.items.includes(value)) usedKeys.add(pair.key);
    if (pair.items.includes(subject)) usedKeys.add(pair.key);
    if (pair.key === subject) usedKeys.add(pair.key);
    if (pair.items.some((item) => dropValues.includes(item))) usedKeys.add(pair.key);
  }
  const aux = [];
  for (const pair of event.pairs) {
    if (usedKeys.has(pair.key)) continue;
    if (pair.key === "age") continue;
    if (!keepState && (pair.key === "result" || pair.key === "class")) continue;
    if (pair.key === "supersedes") continue;
    if (pair.items.includes(subject) || pair.items.includes(value)) continue;
    aux.push(`${pair.key}=${pair.value}`);
  }
  for (const entry of extraAux) aux.push(entry);
  const field = old ? "old" : "current";
  const parts = [`seq=${event.seq}`, subject, `${field}=${value}`, `status=${status}`, ...aux];
  return {
    seq: event.seq,
    subject,
    value,
    status,
    old,
    identity,
    tag,
    text: parts.filter(Boolean).join(" "),
  };
}

function plainEvidenceProjection(events) {
  return events.map((event) => event.raw).join("\n");
}

function derivedRow(question, events, value, derivations) {
  const all = parseContext(question.fullContext).filter((event) => !event.archiveOnly);
  const numeric = /^\d+$/.test(String(value));
  if (numeric) {
    const failedEdges = new Set();
    for (const event of all) {
      for (const pair of event.pairs) {
        if (pair.key === "failed") for (const item of pair.items) failedEdges.add(item);
      }
    }
    const basis = events[events.length - 1];
    if (basis && String(failedEdges.size) === String(value)) {
      derivations.push({
        id: question.id,
        kind: "distinct-failed-edge-count",
        value,
        seq: basis.seq,
        subject: "failed",
        counted: [...failedEdges],
      });
      return buildRow(basis, "failed", value, "settled", {
        tag: "derived:distinct-failed-edge-count",
        extraAux: ["count=failed-edges", `counted=${[...failedEdges].join(",")}`],
        dropValues: [...failedEdges],
      });
    }
    const latest = all.find((event) => event.pairs.some((pair) => pair.key === "latest" && pair.value === "true"));
    if (latest && String(latest.seq) === String(value)) {
      derivations.push({ id: question.id, kind: "latest-event-seq", value, seq: latest.seq, subject: "latest" });
      return buildRow(latest, "latest", value, "current", { tag: "derived:latest-event-seq" });
    }
  }
  if (isEntity(value)) {
    const containing = events.find((event) => foldAt(all, event.seq) === value);
    if (containing) {
      derivations.push({
        id: question.id,
        kind: "fold-by-position",
        value,
        seq: containing.seq,
        subject: "checkpoint",
        declaredAt: all.filter((event) => event.pairs.some((pair) => pair.key === "checkpoint" && pair.value === value)).map((event) => event.seq),
      });
      return buildRow(containing, "checkpoint", value, "current", {
        tag: "derived:fold-by-position",
        keepState: true,
      });
    }
  }
  throw new Error(`${question.id}: gold ${JSON.stringify(value)} 在 fullContext 里没有可投影的事实（禁止凭空造行）`);
}

function renderRelations(question, events, derivations) {
  const golds = Array.isArray(question.answer) ? question.answer : [question.answer];
  const all = parseContext(question.fullContext).filter((event) => !event.archiveOnly);
  const questionEntities = entitiesIn(question.question);
  const rows = [];

  for (const gold of golds) {
    const candidates = events.filter((event) => tokensOf(event).includes(String(gold)));
    const chosen = candidates.length > 0 ? candidates[candidates.length - 1] : null;

    if (!chosen) {
      rows.push(derivedRow(question, events, String(gold), derivations));
      continue;
    }

    const supersedes = chosen.pairs.find((pair) => pair.key === "supersedes");
    if (supersedes && supersedes.items.includes(String(gold))) {
      const winnerPair = chosen.pairs.find((pair) => pair.key !== "supersedes" && pair.items[0] !== String(gold));
      const winner = winnerPair ? winnerPair.items[0] : null;
      const winnerExtra = winner ? [`superseded-by=${winner}`] : [];
      const dropValues = winner ? [winner] : [];
      rows.push(
        buildRow(chosen, String(gold), String(gold), "superseded", {
          identity: true,
          tag: "superseded",
          extraAux: winnerExtra,
          dropValues,
        }),
      );
      if (winner) {
        const winnerAttribute = attributeOf(chosen, winner);
        rows.push(
          buildRow(chosen, winner, winnerAttribute ?? winner, statusOf(chosen, winner), {
            identity: !winnerAttribute,
            dropValues: [String(gold)],
          }),
        );
      }
      const supersededEarlier = all.filter((event) => event.seq < chosen.seq && tokensOf(event).includes(String(gold))).reverse();
      for (const event of supersededEarlier) {
        const oldValue = oldValueOf(event, String(gold));
        if (oldValue === null || oldValue === String(gold) || OLD_MARKERS.includes(oldValue)) continue;
        rows.push(buildRow(event, String(gold), oldValue, "superseded", { old: true }));
      }
      continue;
    }

    let subject;
    let value;
    let identity = false;
    if (isEntity(gold) && tokensOf(chosen).includes(String(gold))) {
      // 金标准是实体：主体=该实体；当前值优先取它自己的属性，取不到就 identity。
      subject = String(gold);
      const attribute = attributeOf(chosen, subject);
      if (attribute && attribute !== subject && !FORBIDDEN_AS_VALUE.includes(attribute)) value = attribute;
      else {
        value = subject;
        identity = true;
      }
    } else {
      // 金标准是值：主体=题面点名的实体（若它是该行主体槽的值），否则=承载该值的槽位。
      const primaryValue = primarySubject(chosen);
      const named = questionEntities.find((entity) => entity === primaryValue);
      if (named) subject = named;
      else {
        const holder = pairByValue(chosen, String(gold));
        if (!holder) throw new Error(`${question.id}: gold ${JSON.stringify(gold)} 在 seq=${chosen.seq} 上没有承载槽`);
        subject = holder.key;
      }
      value = String(gold);
    }

    let status = statusOf(chosen, subject);
    if (identity) {
      const holderKey = chosen.pairs.find((pair) => pair.items.includes(subject))?.key;
      if (holderKey === "current") status = "current";
    }
    rows.push(buildRow(chosen, subject, value, status, { identity }));

    if (isEntity(subject)) {
      const earlier = all.filter((event) => event.seq < chosen.seq && tokensOf(event).includes(subject)).reverse();
      for (const event of earlier) {
        const oldValue = oldValueOf(event, subject);
        if (oldValue === null || oldValue === value || OLD_MARKERS.includes(oldValue)) continue;
        rows.push(buildRow(event, subject, oldValue, "superseded", { old: true }));
      }
    } else if (SUPERSEDING_SLOTS.includes(subject)) {
      const earlier = all.filter((event) => event.seq < chosen.seq && event.pairs.some((pair) => pair.key === subject)).reverse();
      for (const event of earlier) {
        const oldValue = event.pairs.find((pair) => pair.key === subject).value;
        if (oldValue === value || OLD_MARKERS.includes(oldValue)) continue;
        rows.push(buildRow(event, subject, oldValue, "superseded", { old: true }));
      }
    }
  }

  // 右删失是被问状态的 sibling 事实：最新一行若显式标了 right-censored，补一条状态行（不造值）。
  if (rows.length > 0 && !rows.some((row) => row.old)) {
    const subject = rows[0].subject;
    const latest = all.filter((event) => tokensOf(event).includes(subject)).at(-1);
    if (latest && latest.pairs.some((pair) => pair.key === "right-censored") && rows[0].status !== "right-censored") {
      rows.push({
        seq: latest.seq,
        subject,
        value: null,
        status: "right-censored",
        old: false,
        identity: false,
        tag: "state:right-censored",
        text: `seq=${latest.seq} ${subject} status=right-censored`,
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    unique.push(row);
  }
  return unique;
}

export function renderQuestion(question, derivations = []) {
  const evidenceSeqs = new Set(question.evidenceSeqs ?? []);
  const events = parseContext(question.fullContext).filter((event) => !event.archiveOnly && evidenceSeqs.has(event.seq));
  const golds = Array.isArray(question.answer) ? question.answer : [question.answer];
  const isAbs = question.type === "ABS";
  const isComparison = golds.every((gold) => ["before", "after"].includes(String(gold)));
  if (isAbs || isComparison) {
    const text = plainEvidenceProjection(events);
    if (text.trim() === "") throw new Error(`${question.id}: 非 archive 证据行为空`);
    return { compactContext: text, rows: [], kind: isAbs ? "abs-plain" : "comparison-plain" };
  }
  const rows = renderRelations(question, events, derivations);
  if (rows.length === 0) throw new Error(`${question.id}: 值型题没有关系行`);
  const text = rowsText(rows);
  if (META_RE.test(text)) throw new Error(`${question.id}: compact 含金标准元数据`);
  if (text.includes(ARCHIVE_MARK)) throw new Error(`${question.id}: compact 复制了 archive-only 行`);
  const allSeqs = new Set(parseContext(question.fullContext).map((event) => event.seq));
  const currentSeqBySubject = new Map();
  for (const row of rows) {
    if (!row.old && row.value !== null) currentSeqBySubject.set(row.subject, row.seq);
  }
  for (const row of rows) {
    if (!allSeqs.has(row.seq)) throw new Error(`${question.id}: seq=${row.seq} 不在 fullContext`);
    if (row.value === null) continue;
    if (!row.old && !evidenceSeqs.has(row.seq)) throw new Error(`${question.id}: 当前行 seq=${row.seq} 不在 evidenceSeqs`);
    if (row.old) {
      const currentSeq = currentSeqBySubject.get(row.subject);
      if (currentSeq !== undefined && row.seq > currentSeq) {
        throw new Error(`${question.id}: 旧值行 seq=${row.seq} 不早于同主体当前行 seq=${currentSeq}`);
      }
    }
    if (row.tag?.startsWith("derived:")) continue;
    const event = parseContext(question.fullContext).find((entry) => entry.seq === row.seq);
    if (!row.identity && !tokensOf(event).includes(String(row.value))) {
      throw new Error(`${question.id}: ${row.old ? "old" : "current"}=${row.value} 不在 seq=${row.seq} 的原文里`);
    }
  }
  return { compactContext: text, rows, kind: "relation" };
}

export function renderFixture(fixture) {
  const derivations = [];
  const questions = fixture.questions.map((question) => {
    const rendered = renderQuestion(question, derivations);
    return { ...question, compactContext: rendered.compactContext };
  });
  const out = {
    schema: fixture.schema,
    frozen: fixture.frozen,
    note: [
      "K-27 v3 关系行夹具：只在 v1 冻结夹具基础上重投影 compactContext",
      "（关系行=主体+证据seq+当前值+状态；旧值显式标旧；ABS/before-after 比较题不造关系行）。",
      "题面、答案、evidenceSeqs、grader、applicability、fullContext 与 evidence/lme-task50.fixtures.json 逐字一致；v1 文件本身未改字节。",
      "aliases 保持空（不得用别名把状态词或中文前后当等价答案）。",
      `生成器 scripts/lme-relation-render.mjs sha256=${sha256File(fileURLToPath(import.meta.url))}。`,
    ].join(""),
    questions,
  };
  return { fixture: out, derivations };
}

export function sha256File(path) {
  return crypto.createHash("sha256").update(nodeFs.readFileSync(path)).digest("hex");
}

function main(argv) {
  const args = argv.slice(2);
  const stdoutOnly = args.includes("--stdout");
  const rest = args.filter((arg) => arg !== "--stdout");
  const input = rest[0];
  const output = rest[1];
  if (!input) {
    console.error("usage: node scripts/lme-relation-render.mjs [--stdout] <v1-fixture> [out.json]");
    process.exit(2);
  }
  if (output && nodePath.resolve(input) === nodePath.resolve(output)) {
    console.error("refusing to overwrite the source fixture");
    process.exit(2);
  }
  const fixture = JSON.parse(nodeFs.readFileSync(input, "utf8"));
  const { fixture: rendered, derivations } = renderFixture(fixture);
  const report = {
    source: input,
    sourceSha256: sha256File(input),
    questions: rendered.questions.length,
    relationCurrentRows: rendered.questions.reduce((total, question) => total + (question.compactContext.match(/ current=/g) ?? []).length, 0),
    relationOldRows: rendered.questions.reduce((total, question) => total + (question.compactContext.match(/ old=/g) ?? []).length, 0),
    derivations,
  };
  if (stdoutOnly || !output) {
    console.log(JSON.stringify({ ...report, fixture: rendered }, null, 2));
    return;
  }
  nodeFs.writeFileSync(output, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, output, outputSha256: sha256File(output) }, null, 2));
}

if (process.argv[1]?.endsWith("lme-relation-render.mjs")) main(process.argv);
