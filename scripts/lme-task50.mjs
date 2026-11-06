#!/usr/bin/env node
/**
 * K-27 / LME-Task-50：冻结过程续接题与 full/compact 配对机械判分。
 *
 * 本文件没有模型客户端，也没有默认 reader。--validate 只检查冻结夹具；
 * --run 只读取已有 reader 结果。真实 reader 只能由调用方向 runReader 显式注入。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_SCHEMA = "lme-task50-fixtures-v1";
export const RESULTS_SCHEMA = "lme-task50-results-v1";
export const TYPES = Object.freeze(["IE", "MR", "KU", "TR", "ABS"]);
export const ARMS = Object.freeze(["full", "compact"]);
export const THRESHOLDS = Object.freeze({
  total: 50,
  perType: 10,
  compactAccuracy: 0.9,
  deltaTask: -0.05,
  typeCompactAccuracy: 0.8,
  typeDeltaTask: -0.1,
  absUnknown: 10,
  minFailureOrUpdate: 25,
});

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = nodePath.join(HERE, "..", "evidence", "lme-task50.fixtures.json");
const REQUIRED_KEYS = ["id", "type", "question", "answer", "evidenceSeqs", "grader", "applicability", "fullContext", "compactContext"];
const GRADERS = new Set(["exact", "set", "ordered", "UNKNOWN"]);
const APPLICABILITY = /^task-process\/(?:failure|update|boundary|empty|right-censored|multi-fold)$/;
const METADATA_KEY = /(?:["'](?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)["']\s*:|(?:^|\s)(?:answer|evidenceSeqs|grader|applicability|fullContext|compactContext)\s*[:=]|\bgold\b)/im;
const PROCESS_ID = /\b[ne]-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const READER_KEYS = ["arm", "context", "id", "question"];

function questionsOf(input) {
  return Array.isArray(input) ? input : input?.questions;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seqsIn(context) {
  return [...String(context).matchAll(/(?:^|\n)seq=(\d+)\b/g)].map((match) => Number(match[1]));
}

function round6(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function exactText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().replace(/\s+/g, " ") : null;
}

function listValue(value) {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) return value.map((entry) => String(entry).trim());
    return null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return listValue(parsed);
    } catch {
      return null;
    }
  }
  return text.split(/(?:,|;|\n|，|；)/).map((entry) => entry.trim()).filter(Boolean);
}

/** 机械判分：不做语义相似度、不调用 judge 模型。 */
export function gradeAnswer(expected, actual, grader) {
  if (!GRADERS.has(grader)) return { correct: false, code: "invalid-grader", message: `unsupported grader: ${grader}` };
  if (actual === undefined || actual === null || actual === "") return { correct: false, code: "missing-answer", message: "reader answer is missing" };
  if (grader === "UNKNOWN") {
    const ok = typeof actual === "string" && actual.trim() === "UNKNOWN";
    return { correct: ok, code: ok ? "ok" : "abstention-violation", message: ok ? "exact UNKNOWN" : "the only accepted answer is UNKNOWN" };
  }
  if (grader === "exact") {
    const want = exactText(expected);
    const got = exactText(actual);
    const ok = want !== null && got !== null && want === got;
    return { correct: ok, code: ok ? "ok" : "exact-mismatch", message: ok ? "exact match" : "trimmed, whitespace-normalized strings differ" };
  }
  const want = listValue(expected);
  const got = listValue(actual);
  if (!want || !got) return { correct: false, code: "invalid-list", message: "list grader requires an array or a delimited string" };
  if (grader === "set") {
    const expectedSet = [...new Set(want)].sort();
    const actualSet = [...new Set(got)].sort();
    const ok = JSON.stringify(expectedSet) === JSON.stringify(actualSet);
    const missing = expectedSet.filter((entry) => !actualSet.includes(entry));
    const extra = actualSet.filter((entry) => !expectedSet.includes(entry));
    return { correct: ok, code: ok ? "ok" : "set-mismatch", message: ok ? "set match" : `missing=${missing.join("|") || "none"}; extra=${extra.join("|") || "none"}` };
  }
  const ok = JSON.stringify(want) === JSON.stringify(got);
  return { correct: ok, code: ok ? "ok" : "ordered-mismatch", message: ok ? "ordered list match" : "ordered list differs in members or order" };
}

/** 返回所有数据错误；调用方不得把 errors 当 skip。 */
export function validateFixtures(input) {
  const errors = [];
  const questions = questionsOf(input);
  if (!Array.isArray(input) && input?.schema !== FIXTURE_SCHEMA) errors.push(`schema must be ${FIXTURE_SCHEMA}`);
  if (!Array.isArray(questions)) return { ok: false, errors: [...errors, "questions must be an array"], total: 0, validated: 0, byType: {}, failureOrUpdate: 0, leaks: [] };
  if (questions.length !== THRESHOLDS.total) errors.push(`question count must be ${THRESHOLDS.total}; got ${questions.length}`);
  const byType = Object.fromEntries(TYPES.map((type) => [type, 0]));
  const ids = new Set();
  const leaks = [];
  let failureOrUpdate = 0;
  questions.forEach((item, index) => {
    const at = `questions[${index}]`;
    if (!isObject(item)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const key of REQUIRED_KEYS) if (!Object.hasOwn(item, key)) errors.push(`${at} missing ${key}`);
    const id = typeof item.id === "string" ? item.id : "";
    if (!/^(?:IE|MR|KU|TR|ABS)-(?:0[1-9]|10)$/.test(id)) errors.push(`${at} has invalid id`);
    if (ids.has(id)) errors.push(`${at} duplicates id ${id}`);
    ids.add(id);
    if (!TYPES.includes(item.type)) errors.push(`${id || at} has invalid type`);
    else {
      byType[item.type] += 1;
      if (!id.startsWith(`${item.type}-`)) errors.push(`${id} id/type mismatch`);
    }
    if (typeof item.question !== "string" || item.question.trim() === "") errors.push(`${id || at} question must be non-empty`);
    if (!GRADERS.has(item.grader)) errors.push(`${id || at} has invalid grader`);
    if (!Array.isArray(item.evidenceSeqs) || item.evidenceSeqs.length === 0 || item.evidenceSeqs.some((seq) => !Number.isInteger(seq) || seq <= 0)) {
      errors.push(`${id || at} evidenceSeqs must be a non-empty positive integer array`);
    }
    if (typeof item.applicability !== "string" || !APPLICABILITY.test(item.applicability)) errors.push(`${id || at} applicability is outside task-process scope`);
    if (item.applicability === "task-process/failure" || item.applicability === "task-process/update") failureOrUpdate += 1;
    for (const arm of ARMS) {
      if (typeof item[`${arm}Context`] !== "string" || item[`${arm}Context`].trim() === "") errors.push(`${id || at} ${arm}Context must be non-empty text`);
    }
    if (typeof item.fullContext === "string" && typeof item.compactContext === "string") {
      if (item.fullContext === item.compactContext) {
        errors.push(`${id} compactContext duplicates fullContext`);
        leaks.push({ id, kind: "full-context-copied" });
      }
      if (METADATA_KEY.test(item.compactContext)) {
        errors.push(`${id} compactContext contains gold metadata`);
        leaks.push({ id, kind: "gold-metadata" });
      }
      const archiveLines = item.fullContext.split(/\r?\n/).filter((line) => line.includes("[archive-only]"));
      if (archiveLines.length === 0) errors.push(`${id} fullContext needs an archive-only line for leakage checking`);
      for (const line of archiveLines) {
        if (item.compactContext.includes(line)) {
          errors.push(`${id} compactContext leaks archive-only evidence`);
          leaks.push({ id, kind: "archive-only-line" });
        }
      }
      const fullSeqs = seqsIn(item.fullContext);
      if (new Set(fullSeqs).size !== fullSeqs.length) errors.push(`${id} fullContext has duplicate seq lines`);
      for (const seq of item.evidenceSeqs ?? []) if (!fullSeqs.includes(seq)) errors.push(`${id} evidence seq ${seq} is absent from fullContext`);
      for (const seq of seqsIn(item.compactContext)) if (!fullSeqs.includes(seq)) errors.push(`${id} compactContext has seq ${seq} absent from fullContext`);
    }
    if (item.type === "ABS") {
      if (item.grader !== "UNKNOWN" || item.answer !== "UNKNOWN") errors.push(`${id} ABS requires UNKNOWN answer and grader`);
    } else if (item.grader === "UNKNOWN") errors.push(`${id} non-ABS cannot use UNKNOWN grader`);
    if (["set", "ordered"].includes(item.grader)) {
      if (!Array.isArray(item.answer) || item.answer.length === 0 || item.answer.some((entry) => typeof entry !== "string" || entry.trim() === "")) errors.push(`${id} list answer must be a non-empty string array`);
    } else if (typeof item.answer !== "string" || item.answer.trim() === "") errors.push(`${id} exact answer must be non-empty text`);
    if (item.grader === "set" && Array.isArray(item.answer) && new Set(item.answer).size !== item.answer.length) errors.push(`${id} set answer contains duplicates`);
    if (gradeAnswer(item.answer, item.answer, item.grader).correct !== true) errors.push(`${id} gold answer does not pass its own grader`);
  });
  for (const type of TYPES) if (byType[type] !== THRESHOLDS.perType) errors.push(`${type} must contain 10 questions; got ${byType[type]}`);
  if (failureOrUpdate < THRESHOLDS.minFailureOrUpdate) errors.push(`failure/update forms must be at least 25; got ${failureOrUpdate}`);
  return { ok: errors.length === 0, errors, total: questions.length, validated: errors.length === 0 ? questions.length : 0, byType, failureOrUpdate, leaks };
}

export function assertValidFixtures(input) {
  const validation = validateFixtures(input);
  if (!validation.ok) throw new Error(`invalid LME-Task-50 fixtures:\n${validation.errors.join("\n")}`);
  return questionsOf(input);
}

/** reader 可见契约：恰好四个字段，没有金标准、证据标注或另一臂。 */
export function assertReaderPayload(payload) {
  if (!isObject(payload)) throw new Error("reader payload must be an object");
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(READER_KEYS)) throw new Error(`reader payload keys leaked or missing: ${keys.join(",")}`);
  if (!ARMS.includes(payload.arm) || typeof payload.id !== "string" || typeof payload.question !== "string" || typeof payload.context !== "string") {
    throw new Error("reader payload has invalid field types");
  }
  if (payload.arm === "compact" && METADATA_KEY.test(payload.context)) throw new Error("compact reader payload contains gold metadata");
  return true;
}

export function makeReaderPayload(item, arm) {
  if (!ARMS.includes(arm)) throw new Error(`unknown reader arm: ${arm}`);
  const payload = { id: item.id, arm, question: item.question, context: item[`${arm}Context`] };
  assertReaderPayload(payload);
  return payload;
}

/** 唯一的 reader 调用点；每次调用前再次检查四字段契约。 */
export async function runReader(fixtures, reader) {
  const questions = assertValidFixtures(fixtures);
  if (typeof reader !== "function") throw new Error("runReader requires an explicitly injected reader function");
  const results = [];
  for (const item of questions) {
    const pair = { id: item.id };
    for (const arm of ARMS) {
      const payload = makeReaderPayload(item, arm);
      assertReaderPayload(payload);
      pair[arm] = await reader(payload);
    }
    results.push(pair);
  }
  return { schema: RESULTS_SCHEMA, results };
}

/** Wilson score 95% CI；小样本不假装区间退化为一个点。 */
export function wilson95(correct, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = correct / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return { low: round6(Math.max(0, center - margin)), high: round6(Math.min(1, center + margin)) };
}

/** 配对差值的 95% CI：逐题差 c-full 的均值正态区间，保留所有分母。 */
export function pairedDelta95(differences) {
  const n = differences.length;
  if (n === 0) return { low: 0, high: 0 };
  const mean = differences.reduce((sum, value) => sum + value, 0) / n;
  if (n === 1) return { low: round6(mean), high: round6(mean) };
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / n);
  return { low: round6(Math.max(-1, mean - margin)), high: round6(Math.min(1, mean + margin)) };
}

function metricBlock(rows) {
  const total = rows.length;
  const fullCorrect = rows.filter((row) => row.full.correct).length;
  const compactCorrect = rows.filter((row) => row.compact.correct).length;
  const full = total ? fullCorrect / total : 0;
  const compact = total ? compactCorrect / total : 0;
  const delta = compact - full;
  return {
    total,
    fullCorrect,
    compactCorrect,
    Acc_full: round6(full),
    Acc_compact: round6(compact),
    "Δtask": round6(delta),
    ci95: {
      full: wilson95(fullCorrect, total),
      compact: wilson95(compactCorrect, total),
      delta: pairedDelta95(rows.map((row) => Number(row.compact.correct) - Number(row.full.correct))),
    },
    "reader-limited": rows.filter((row) => row["reader-limited"]).length,
  };
}

function unknownIds(prediction, item) {
  if (typeof prediction !== "string") return [];
  const known = new Set(String(item.fullContext).match(PROCESS_ID) ?? []);
  return [...new Set((prediction.match(PROCESS_ID) ?? []).filter((id) => !known.has(id)))].sort();
}

function validateResults(run, questions) {
  const errors = [];
  if (!isObject(run) || run.schema !== RESULTS_SCHEMA) errors.push(`results schema must be ${RESULTS_SCHEMA}`);
  if (!Array.isArray(run?.results)) return [...errors, "results must be an array"];
  const ids = questions.map((item) => item.id);
  const expected = new Set(ids);
  const seen = new Set();
  for (const [index, row] of run.results.entries()) {
    if (!isObject(row) || typeof row.id !== "string") {
      errors.push(`results[${index}] must contain id`);
      continue;
    }
    if (!expected.has(row.id)) errors.push(`results[${index}] has unknown id ${row.id}`);
    if (seen.has(row.id)) errors.push(`results contains duplicate id ${row.id}`);
    seen.add(row.id);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`results missing ${id}`);
  if (run.results.length !== THRESHOLDS.total) errors.push(`results must contain 50 rows; got ${run.results.length}`);
  return errors;
}

/** 对已存在的 full/compact 结果判分；错误答案和 reader-limited 都保留在 50 题分母中。 */
export function evaluateRun(fixtures, run) {
  const questions = assertValidFixtures(fixtures);
  const resultErrors = validateResults(run, questions);
  const byId = new Map(Array.isArray(run?.results) ? run.results.filter(isObject).map((row) => [row.id, row]) : []);
  const rows = questions.map((item) => {
    const result = byId.get(item.id) ?? {};
    const row = { id: item.id, type: item.type };
    for (const arm of ARMS) {
      const actual = result[arm];
      const grade = gradeAnswer(item.answer, actual, item.grader);
      row[arm] = { answer: actual ?? null, ...grade, unknownProcessIds: unknownIds(actual, item) };
    }
    row["reader-limited"] = !row.full.correct && !row.compact.correct;
    row.errors = ARMS.filter((arm) => !row[arm].correct).map((arm) => ({ arm, code: row[arm].code, message: row[arm].message }));
    return row;
  });
  const overall = metricBlock(rows);
  const byType = Object.fromEntries(TYPES.map((type) => [type, metricBlock(rows.filter((row) => row.type === type))]));
  const unknownProcessIds = rows.flatMap((row) => ARMS.flatMap((arm) => row[arm].unknownProcessIds.map((id) => ({ id: row.id, arm, processId: id }))));
  const gates = {
    dataComplete: resultErrors.length === 0,
    overallCompact: overall.Acc_compact >= THRESHOLDS.compactAccuracy - 1e-12,
    pairedDelta: overall["Δtask"] >= THRESHOLDS.deltaTask - 1e-12,
    perType: TYPES.every((type) => byType[type].Acc_compact >= THRESHOLDS.typeCompactAccuracy - 1e-12 && byType[type]["Δtask"] >= THRESHOLDS.typeDeltaTask - 1e-12),
    abstention: byType.ABS.compactCorrect === THRESHOLDS.absUnknown && rows.filter((row) => row.type === "ABS").every((row) => row.compact.answer === "UNKNOWN"),
    noUnknownProcessIds: unknownProcessIds.length === 0,
  };
  const passed = Object.values(gates).every(Boolean);
  return {
    schema: "lme-task50-evaluation-v1",
    status: "SCORED",
    qualityGate: passed ? "PASS" : "FAIL",
    passed,
    ...overall,
    byType,
    ci95Method: "Wilson score 95% CI for each arm; normal 95% CI of paired per-item compact-full differences",
    thresholds: THRESHOLDS,
    gates,
    resultErrors,
    unknownProcessIds,
    "reader-limited": rows.filter((row) => row["reader-limited"]).map((row) => row.id),
    items: rows,
  };
}

function readJson(path) {
  return JSON.parse(nodeFs.readFileSync(path, "utf8"));
}

export function main(argv = process.argv.slice(2)) {
  const validateOnly = argv.includes("--validate");
  const runIndex = argv.indexOf("--run");
  if ((validateOnly && runIndex !== -1) || (runIndex !== -1 && (argv.length !== 2 || runIndex !== 0)) || (!validateOnly && runIndex === -1 && argv.length !== 0)) {
    console.log(JSON.stringify({ status: "ERROR", qualityGate: "NOT_RUN", errors: ["usage: node scripts/lme-task50.mjs [--validate] or [--run <results.json>]"] }, null, 2));
    return 2;
  }
  try {
    const fixtures = readJson(DEFAULT_FIXTURES);
    const validation = validateFixtures(fixtures);
    if (!validation.ok) {
      console.log(JSON.stringify({ status: "ERROR", qualityGate: validateOnly || runIndex === -1 ? "NOT_RUN" : "FAIL", validation }, null, 2));
      return 1;
    }
    if (runIndex === -1) {
      console.log(JSON.stringify({ schema: "lme-task50-validation-v1", status: "NOT_RUN", reader: "NOT_RUN", qualityGate: "NOT_RUN", validation, note: "No reader was called and no task-quality score is claimed." }, null, 2));
      return 0;
    }
    const evaluation = evaluateRun(fixtures, readJson(nodePath.resolve(runIndex >= 0 ? argv[runIndex + 1] : "")));
    console.log(JSON.stringify(evaluation, null, 2));
    return evaluation.passed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "ERROR", qualityGate: runIndex === -1 ? "NOT_RUN" : "FAIL", errors: [String(error?.message ?? error)] }, null, 2));
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
