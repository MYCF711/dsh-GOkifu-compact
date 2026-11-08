#!/usr/bin/env node
/**
 * k2-v2-offline-replay.mjs —— K-2 normalize-v2 的**离线双列复算**（P08 前置件）
 *
 * 一条命令回答 P08 的三问，且**不碰任何官方历史**：
 *   ① 21 条冻结向量：v2 的 actualCorrect 是否逐条等于 expectCorrect（21/21，13 格式正 / 8 语义负）；
 *   ② T7 的 20 个 raw 文件用 **v1** `normalizeAnswer` + `gradeAnswer` 复算，是否与
 *      `k2-result.json` 的 20 行 answer / grade / raw **逐字一致**（20/20）——
 *      证明这次实现没有碰过 v1 的口径；
 *   ③ 同一批 raw 换成 v2 的第二列：只允许「格式假阴性 → 正确」这一种变化，
 *      不许 v1 对变 v2 错、不许 UNKNOWN 计数变化；**gate6 仍然 false**。
 *
 * 只读：不写 raw、不写 `k2-result.json`、不改预注册；`--write` 只追加一份公开冻结核对
 * （无回答正文、无题面、无会话 id、无本机绝对路径）。零模型：不 import 任何模型客户端，
 * 全程零网络请求（只读本地 JSON + 一次 `git worktree list` 用于找输入）。
 *
 * 输入从哪来：公有仓库的 `evidence/` 与本机 `tmp/`（`tmp/` 被 .gitignore，所以按
 * 「当前 worktree + 同仓其它 worktree」顺序探测）。可用环境变量显式覆盖：
 *   K2_V2_PUBLIC_PREREG / K2_V2_PRIVATE_PREREG / K2_V2_PRIVATE_PROPOSAL / K2_V2_RAW_DIR / K2_V2_RESULT
 *
 * 用法：
 *   node scripts/k2-v2-offline-replay.mjs             # 人读摘要
 *   node scripts/k2-v2-offline-replay.mjs --json      # 机器可读的**公开安全视图**（无回答正文）
 *   node scripts/k2-v2-offline-replay.mjs --json --verbose  # 含本地逐行对照（回答正文只在控制台，不落盘）
 *   node scripts/k2-v2-offline-replay.mjs --write     # 追加落盘 evidence/k2-normalize-v2-freeze-2026-11-08.json
 *   node scripts/k2-v2-offline-replay.mjs --verbose   # 人读摘要 + 逐行判分码
 * 退出码：0 = P08 全过；1 = 有判据不成立；2 = 本机输入不全（私有向量或官方历史不在）
 * 退出码：0 = P08 全过；1 = 有判据不成立；2 = 本机输入不全（私有向量或官方历史不在）
 */
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { QUESTIONS, normalizeAnswer, questionsSha256 } from "./k2-value-reader.mjs";
import { gradeAnswer } from "./lme-task50.mjs";
import {
  ALLOWED_TRANSFORMATIONS,
  FORBIDDEN_TRANSFORMATIONS,
  K2_V2_VERSION,
  ORDER_OF_OPERATIONS,
  gradeWithV2,
} from "./k2-normalize-v2.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
/** 本脚本所在 worktree 的根（= scripts/ 的上一级）。 */
export const REPO = nodePath.join(HERE, "..");

/** 输入相对路径。`tmp/` 在 .gitignore 里，所以新 worktree 不会自带，靠 discovery 找。 */
export const ARTIFACTS = Object.freeze({
  publicPrereg: "evidence/k2-normalize-v2-prereg.json",
  privatePrereg: "tmp/gold-quality-next/k2/prereg.json",
  privateProposal: "tmp/gold-quality-next/k2/proposal.json",
  rawDir: "tmp/gold-quality-2026-11-08/quality/raw/k2",
  result: "tmp/gold-quality-2026-11-08/quality/k2-result.json",
});

export const ENV_KEYS = Object.freeze({
  publicPrereg: "K2_V2_PUBLIC_PREREG",
  privatePrereg: "K2_V2_PRIVATE_PREREG",
  privateProposal: "K2_V2_PRIVATE_PROPOSAL",
  rawDir: "K2_V2_RAW_DIR",
  result: "K2_V2_RESULT",
});

/** P08 / 预注册里写死的期望值；复算结果必须逐项相等，否则本脚本 exit 1。 */
export const EXPECTED = Object.freeze({
  vectorCount: 21,
  formatPositive: 13,
  semanticNegative: 8,
  rawFiles: 20,
  v1FullCorrect: 7,
  v1CompactCorrect: 8,
  v2FullCorrect: 7,
  v2CompactCorrect: 9,
  changedRows: 1,
  changedRowId: "K2-N3",
  changedRowArm: "compact",
  changedRowCategory: "ordered-list-quote-format",
  unknownIncrease: 1,
  answerPresentPerArm: 10,
});

/** 公开冻结核对的落盘位置（追加，不覆盖别的证据）。 */
export const FREEZE_PATH = "evidence/k2-normalize-v2-freeze-2026-11-08.json";

/* ────────────────────────────── 哈希与 JSON ────────────────────────────── */

export function sha256Buffer(buffer) {
  return nodeCrypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), "utf8"));
}

export function sha256File(file) {
  return sha256Buffer(nodeFs.readFileSync(file));
}

/** 键排序的稳定 JSON：冻结哈希的口径（与预注册 `hashBasis` 一致）。 */
export function canonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, walk(node[key])]));
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/** 21 向量集的冻结哈希：`sha256(canonicalJson(vectors))`。 */
export function sha256Vectors(vectors) {
  return sha256Text(canonicalJson(vectors));
}

/**
 * 20 文件 raw 清单哈希，口径写死在 k2-rerun-prereg 的 selfCheck：
 *   `sha256sum *.json | sort | sha256sum`
 * 这里逐字等价复刻（`<hash> *<name>` 行、按行字典序排序、末尾换行），不依赖外部 coreutils。
 */
export function rawManifestSha256(rawDir) {
  const names = nodeFs.readdirSync(rawDir).filter((name) => name.endsWith(".json")).sort();
  const lines = names.map((name) => `${sha256File(nodePath.join(rawDir, name))} *${name}`);
  lines.sort();
  return { files: names.length, sha256: sha256Text(`${lines.join("\n")}\n`) };
}

function readJson(file) {
  return JSON.parse(nodeFs.readFileSync(file, "utf8"));
}

function exists(target) {
  try {
    nodeFs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────── 输入探测 ────────────────────────────── */

/** 同仓所有 worktree 的根路径（`tmp/` 不进 git，所以输入常在另一个 worktree 里）。 */
export function listWorktrees() {
  try {
    const out = execFileSync("git", ["-C", REPO, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 30000 });
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 探测输入：显式覆盖（环境变量 / --xxx）优先，其次当前 worktree，最后同仓其它 worktree。
 * @returns {Record<string, string|undefined>} 键同 ARTIFACTS，值 = 绝对路径（找不到就没有该键）
 */
export function discoverArtifacts({ overrides = {}, env = process.env } = {}) {
  const roots = [REPO, ...listWorktrees().filter((root) => nodePath.resolve(root) !== nodePath.resolve(REPO))];
  const found = {};
  for (const key of Object.keys(ARTIFACTS)) {
    const explicit = overrides[key] ?? env[ENV_KEYS[key]];
    if (explicit) {
      if (exists(explicit)) found[key] = nodePath.resolve(explicit);
      continue;
    }
    for (const root of roots) {
      const candidate = nodePath.join(root, ARTIFACTS[key]);
      if (exists(candidate)) {
        found[key] = candidate;
        break;
      }
    }
  }
  return found;
}

/* ────────────────────────────── 冻结输入核对 ────────────────────────────── */

function check(name, declared, actual, extra = {}) {
  return { name, declared: declared ?? null, actual: actual ?? null, ok: Boolean(declared) && declared === actual, ...extra };
}

/**
 * 预注册里声明的每个 sha256 都必须与真实文件一致 —— 这是「复算用的是冻结输入」的唯一证据。
 * 任何一项对不上都不该继续判 P08（宁可 exit 1，也不要拿错版本算出一个漂亮数字）。
 */
export function verifyFrozenInputs({ publicPrereg, privatePrereg, artifacts }) {
  const hashes = publicPrereg.hashes ?? {};
  const checks = [
    check("privatePreregSha256", hashes.privatePreregSha256, sha256File(artifacts.privatePrereg)),
    check("testVectorSetSha256", hashes.testVectorSetSha256, sha256Vectors(privatePrereg?.testVectors?.vectors ?? [])),
    check("readerScriptSha256", hashes.readerScriptSha256, sha256File(nodePath.join(REPO, "scripts", "k2-value-reader.mjs"))),
    check("graderScriptSha256", hashes.graderScriptSha256, sha256File(nodePath.join(REPO, "scripts", "lme-task50.mjs"))),
    check("questionsSha256", hashes.questionsSha256, questionsSha256(QUESTIONS)),
    check("rawManifestSha256", hashes.rawManifestSha256, rawManifestSha256(artifacts.rawDir).sha256),
    check("k2ResultSha256", hashes.k2ResultSha256, sha256File(artifacts.result)),
  ];
  if (artifacts.privateProposal && hashes.privateProposalSha256) {
    checks.push(check("privateProposalSha256", hashes.privateProposalSha256, sha256File(artifacts.privateProposal)));
  }
  return { checks, ok: checks.every((item) => item.ok) };
}

/* ────────────────────────────── 21 向量 ────────────────────────────── */

/**
 * 逐条跑 21 条冻结向量。返回 `matched`（actualCorrect === expectCorrect 的条数）与分类计数。
 * 只有 expectCorrect=true 的格式正例允许「v2 变对」；语义负例仍必须保持错误。
 */
export function runVectors(privatePrereg) {
  const vectors = privatePrereg?.testVectors?.vectors ?? [];
  const rows = vectors.map((vector) => {
    const graded = gradeWithV2(vector.expected, vector.actual, vector.grader, vector.aliases ?? []);
    const actualCorrect = graded.grade.correct === true;
    return {
      id: vector.id,
      category: vector.category,
      grader: vector.grader,
      expectCorrect: vector.expectCorrect === true,
      actualCorrect,
      ok: actualCorrect === (vector.expectCorrect === true),
      answer: graded.answer,
      code: graded.grade.code,
    };
  });
  const byCategory = {};
  for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
  return {
    total: rows.length,
    matched: rows.filter((row) => row.ok).length,
    byCategory,
    ids: rows.map((row) => row.id),
    rows,
  };
}

/* ────────────────────────────── T7 20 行双列复算 ────────────────────────────── */

function sameGrade(left, right) {
  return Boolean(left && right) && left.correct === right.correct && left.code === right.code && left.message === right.message;
}

function changeCategoryOf(grader, v1Answer, v2Answer) {
  if (v1Answer === v2Answer) return null;
  if (grader === "ordered" || grader === "set") return `${grader}-list-quote-format`;
  return "answer-wrapper-format";
}

function armStats(rows, column) {
  const stat = { full: { correct: 0, unknown: 0 }, compact: { correct: 0, unknown: 0 } };
  for (const row of rows) {
    const bucket = stat[row.arm];
    if (!bucket) continue;
    if (row[column].correct) bucket.correct += 1;
    if (row[column].answer === "UNKNOWN") bucket.unknown += 1;
  }
  return stat;
}

function degradedOf(rows, column) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, {});
    byId.get(row.id)[row.arm] = row;
  }
  const degraded = [];
  for (const [id, arms] of byId) {
    if (arms.full?.[column].correct && arms.compact && !arms.compact[column].correct) degraded.push(id);
  }
  return degraded;
}

/**
 * 用 20 个 raw 复算两列：v1 列必须与 `k2-result.json` 逐字一致（P08 的 20/20），
 * v2 列只允许格式假阴性变对。全程只读：输入哈希在前后各算一次。
 */
export function replayT7({ rawDir, resultPath }) {
  const before = { rawManifest: rawManifestSha256(rawDir), result: sha256File(resultPath) };
  const result = readJson(resultPath);
  const fixtures = new Map(QUESTIONS.map((item) => [item.id, item]));
  const official = new Map((result.results ?? []).map((row) => [`${row.id}/${row.arm}`, row]));
  const files = nodeFs.readdirSync(rawDir).filter((name) => name.endsWith(".json")).sort();
  const rows = [];
  const problems = [];

  for (const file of files) {
    const raw = readJson(nodePath.join(rawDir, file));
    const fixture = fixtures.get(raw.id);
    const key = `${raw.id}/${raw.arm}`;
    const officialRow = official.get(key);
    if (!fixture) {
      problems.push(`${file}: id ${raw.id} 不在冻结题集里`);
      continue;
    }
    if (!officialRow) {
      problems.push(`${file}: k2-result.json 里没有 ${key}`);
      continue;
    }
    if (raw.httpStatus !== 200) problems.push(`${file}: httpStatus=${raw.httpStatus}`);
    if (raw.error !== null && raw.error !== undefined) problems.push(`${file}: error=${raw.error}`);

    const v1Answer = normalizeAnswer(raw.raw);
    const v1Grade = gradeAnswer(fixture.answer, v1Answer, fixture.grader, fixture.aliases ?? []);
    const v2 = gradeWithV2(fixture.answer, raw.raw, fixture.grader, fixture.aliases ?? []);
    rows.push({
      file,
      id: raw.id,
      arm: raw.arm,
      grader: fixture.grader,
      rawMatchesOfficial: raw.raw === officialRow.raw,
      v1: { answer: v1Answer, ...v1Grade },
      v2: { answer: v2.answer, ...v2.grade },
      official: { answer: officialRow.answer, grade: officialRow.grade },
      v1AnswerMatchesOfficial: v1Answer === officialRow.answer,
      v1GradeMatchesOfficial: sameGrade(v1Grade, officialRow.grade),
      changed: v1Answer !== v2.answer,
      changeCategory: changeCategoryOf(fixture.grader, v1Answer, v2.answer),
    });
  }

  const after = { rawManifest: rawManifestSha256(rawDir), result: sha256File(resultPath) };
  const v1 = {
    fullCorrect: rows.filter((row) => row.arm === "full" && row.v1.correct).length,
    compactCorrect: rows.filter((row) => row.arm === "compact" && row.v1.correct).length,
    degraded: degradedOf(rows, "v1"),
    unknown: armStats(rows, "v1"),
  };
  const v2 = {
    fullCorrect: rows.filter((row) => row.arm === "full" && row.v2.correct).length,
    compactCorrect: rows.filter((row) => row.arm === "compact" && row.v2.correct).length,
    degraded: degradedOf(rows, "v2"),
    unknown: armStats(rows, "v2"),
  };
  const unknownIncrease = (stats) => stats.compact.unknown - stats.full.unknown;
  const changedRows = rows.filter((row) => row.changed);
  const regressionRows = rows.filter((row) => row.v1.correct && !row.v2.correct);
  const gainedRows = rows.filter((row) => !row.v1.correct && row.v2.correct);
  const acceptedAnswersStable = rows.filter((row) => row.v1.correct).every((row) => row.v2.answer === row.v1.answer);

  return {
    rawFiles: files.length,
    httpStatusOk: rows.filter((row) => rawHttpOk(rawDir, row.file)).length,
    readerErrors: problems.filter((item) => item.includes("error=") || item.includes("httpStatus=")).length,
    problems,
    rows,
    v1Replay: {
      total: rows.length,
      answerMatched: rows.filter((row) => row.v1AnswerMatchesOfficial).length,
      gradeMatched: rows.filter((row) => row.v1GradeMatchesOfficial).length,
      rawMatched: rows.filter((row) => row.rawMatchesOfficial).length,
      exact: rows.filter((row) => row.v1AnswerMatchesOfficial && row.v1GradeMatchesOfficial && row.rawMatchesOfficial).length,
    },
    v1: { ...v1, unknownIncrease: unknownIncrease(v1.unknown), abstentionClean: unknownIncrease(v1.unknown) <= 0 },
    v2: { ...v2, unknownIncrease: unknownIncrease(v2.unknown), abstentionClean: unknownIncrease(v2.unknown) <= 0 },
    changedRows: changedRows.map((row) => ({ id: row.id, arm: row.arm, category: row.changeCategory, fromCode: row.v1.code, toCode: row.v2.code })),
    regressionRows: regressionRows.map((row) => ({ id: row.id, arm: row.arm, code: row.v2.code })),
    gainedRows: gainedRows.map((row) => ({ id: row.id, arm: row.arm, category: row.changeCategory })),
    acceptedAnswersStable,
    readOnly: {
      rawManifestBefore: before.rawManifest.sha256,
      rawManifestAfter: after.rawManifest.sha256,
      resultBefore: before.result,
      resultAfter: after.result,
      identical: before.rawManifest.sha256 === after.rawManifest.sha256 && before.result === after.result,
    },
    resultMeta: {
      schema: result.schema,
      taskId: result.taskId,
      generatedAt: result.generatedAt,
      worktreeHead: result.worktreeHead,
      actualCalls: result.actualCalls,
      plannedCalls: result.plannedCalls,
      errors: Array.isArray(result.errors) ? result.errors.length : null,
      questionsSha256: result.questionsSha256,
      answerPresentCoverage: result.answerPresentCoverage,
    },
  };
}

/** 逐文件复读 httpStatus（行里没存，避免把整条 raw 留在内存报告里）。 */
function rawHttpOk(rawDir, file) {
  try {
    return readJson(nodePath.join(rawDir, file)).httpStatus === 200;
  } catch {
    return false;
  }
}

/* ────────────────────────────── 汇总 ────────────────────────────── */

/** 预注册 reportingContract 的 gate6 公式，本脚本只做算术，不改口径。 */
export function gate6Of({ replay }) {
  const noRegression = replay.v2.degraded.length === 0;
  const abstentionClean = replay.v2.unknownIncrease <= 0;
  const coverage = replay.resultMeta.answerPresentCoverage ?? {};
  const coverageOk = coverage.full === EXPECTED.answerPresentPerArm && coverage.compact === EXPECTED.answerPresentPerArm;
  return {
    noRegression,
    abstentionClean,
    answerPresentCoverage: { full: coverage.full ?? null, compact: coverage.compact ?? null, ok: coverageOk },
    gate6: noRegression && abstentionClean && coverageOk,
    reasons: [
      ...(noRegression ? [] : [`v2 degraded=${replay.v2.degraded.join(",")}`]),
      ...(abstentionClean ? [] : [`unknownIncrease=${replay.v2.unknownIncrease}`]),
      ...(coverageOk ? [] : ["answerPresentCoverage 不是 10/10 两臂"]),
    ],
  };
}

/**
 * 组装完整报告（内存态，**不进落盘路径**）。
 * 每个 `checks[]` 项都能独立判红 —— 不接受「总体看起来对」。
 */
export function buildReport(artifacts) {
  const publicPrereg = readJson(artifacts.publicPrereg);
  const privatePrereg = readJson(artifacts.privatePrereg);
  const frozen = verifyFrozenInputs({ publicPrereg, privatePrereg, artifacts });
  const rules = {
    orderOfOperations: JSON.stringify(ORDER_OF_OPERATIONS) === JSON.stringify(publicPrereg.rules?.orderOfOperations),
    allowedTransformations: JSON.stringify(ALLOWED_TRANSFORMATIONS) === JSON.stringify(publicPrereg.rules?.allowedTransformations),
    forbiddenTransformations: JSON.stringify(FORBIDDEN_TRANSFORMATIONS) === JSON.stringify(publicPrereg.rules?.forbiddenTransformations),
  };
  const vectors = runVectors(privatePrereg);
  const replay = replayT7({ rawDir: artifacts.rawDir, resultPath: artifacts.result });
  const gate = gate6Of({ replay });

  const vectorCountOk = vectors.total === EXPECTED.vectorCount && publicPrereg.testVectors?.count === EXPECTED.vectorCount;
  const categoryOk = vectors.byCategory["format-positive"] === EXPECTED.formatPositive && vectors.byCategory["semantic-negative"] === EXPECTED.semanticNegative;
  const changedOk =
    replay.changedRows.length === EXPECTED.changedRows &&
    replay.changedRows[0]?.id === EXPECTED.changedRowId &&
    replay.changedRows[0]?.arm === EXPECTED.changedRowArm &&
    replay.changedRows[0]?.category === EXPECTED.changedRowCategory &&
    replay.changedRows[0]?.toCode === "ok";
  const metricsOk =
    replay.v1.fullCorrect === EXPECTED.v1FullCorrect &&
    replay.v1.compactCorrect === EXPECTED.v1CompactCorrect &&
    replay.v2.fullCorrect === EXPECTED.v2FullCorrect &&
    replay.v2.compactCorrect === EXPECTED.v2CompactCorrect &&
    replay.v2.degraded.length === 0 &&
    replay.v1.degraded.length === 1 &&
    replay.v1.unknownIncrease === EXPECTED.unknownIncrease &&
    replay.v2.unknownIncrease === EXPECTED.unknownIncrease;

  const checks = [
    {
      id: "P08-A-vectors-21",
      ok: vectorCountOk && categoryOk && vectors.matched === EXPECTED.vectorCount,
      detail: `21 向量 matched=${vectors.matched}/${EXPECTED.vectorCount} · format-positive=${vectors.byCategory["format-positive"] ?? 0}/${EXPECTED.formatPositive} · semantic-negative=${vectors.byCategory["semantic-negative"] ?? 0}/${EXPECTED.semanticNegative}`,
    },
    {
      id: "P08-B-v1-replay-20",
      ok: replay.rawFiles === EXPECTED.rawFiles && replay.v1Replay.exact === EXPECTED.rawFiles && replay.problems.length === 0,
      detail: `v1 复算 exact=${replay.v1Replay.exact}/${EXPECTED.rawFiles}（answer ${replay.v1Replay.answerMatched} · grade ${replay.v1Replay.gradeMatched} · raw ${replay.v1Replay.rawMatched}）`,
    },
    {
      id: "P08-C-v2-format-only",
      ok:
        replay.regressionRows.length === 0 &&
        replay.gainedRows.every((row) => row.category !== null) &&
        replay.acceptedAnswersStable &&
        replay.changedRows.length === EXPECTED.changedRows &&
        replay.v2.unknownIncrease === replay.v1.unknownIncrease,
      detail: `regression=${replay.regressionRows.length} · gained=${replay.gainedRows.length} · 已接受答案保持不变=${replay.acceptedAnswersStable} · 改动行=${replay.changedRows.length}`,
    },
    {
      id: "P08-D-metrics",
      ok: metricsOk,
      detail: `v1 full=${replay.v1.fullCorrect} compact=${replay.v1.compactCorrect} degraded=${replay.v1.degraded.length} · v2 full=${replay.v2.fullCorrect} compact=${replay.v2.compactCorrect} degraded=${replay.v2.degraded.length} · unknownIncrease=${replay.v1.unknownIncrease}→${replay.v2.unknownIncrease}`,
    },
    { id: "P08-E-gate6-false", ok: gate.gate6 === false, detail: `gate6=false（${gate.reasons.join("；") || "无理由"}）` },
    { id: "P08-F-frozen-inputs", ok: frozen.ok, detail: `${frozen.checks.filter((item) => item.ok).length}/${frozen.checks.length} 哈希一致` },
    {
      id: "P08-G-rules-verbatim",
      ok: rules.orderOfOperations && rules.allowedTransformations && rules.forbiddenTransformations,
      detail: `规则逐字对齐=${Object.entries(rules).filter(([, ok]) => ok).length}/3`,
    },
    { id: "P08-H-history-readonly", ok: replay.readOnly.identical, detail: `raw 清单与 k2-result.json 前后哈希一致=${replay.readOnly.identical}` },
  ];

  return {
    schema: "k2-normalize-v2-offline-replay-v1",
    version: K2_V2_VERSION,
    status: checks.every((item) => item.ok) ? "PASS" : "FAIL",
    ok: checks.every((item) => item.ok),
    officialColumn: "raw",
    secondaryColumn: "v2",
    adoption: "NOT_ADOPTED",
    implementation: "APPLIED_OFFLINE_ONLY",
    modelCalls: 0,
    checks,
    rules,
    frozen,
    vectors,
    replay,
    gate,
    prereg: {
      publicSha256: sha256File(artifacts.publicPrereg),
      privatePreregSha256: sha256File(artifacts.privatePrereg),
      publicSchema: publicPrereg.schema,
      publicStatus: publicPrereg.status,
      declaredGate6: publicPrereg.officialK2?.gate6,
    },
    /** 冻结工具的 sha256 —— P08 要求「v2 grader 已实现且冻结，其 sha256 被记录」就落在这一块。 */
    tools: {
      normalizer: { path: "scripts/k2-normalize-v2.mjs", sha256: sha256File(nodePath.join(REPO, "scripts", "k2-normalize-v2.mjs")) },
      replay: { path: "scripts/k2-v2-offline-replay.mjs", sha256: sha256File(nodePath.join(REPO, "scripts", "k2-v2-offline-replay.mjs")) },
      test: { path: "test/k2-normalize-v2.test.mjs", sha256: sha256File(nodePath.join(REPO, "test", "k2-normalize-v2.test.mjs")) },
    },
    /** 复跑方式（命令原文，不含结果声明 —— 结果只认上面的 checks / metrics）。 */
    commands: [
      "node scripts/k2-v2-offline-replay.mjs --write",
      "node test/run.mjs k2-normalize-v2",
    ],
  };
}

/**
 * 落盘用的**公开**视图：只留计数、判分码、id/arm 与哈希。
 * 刻意剔除：raw / 回答正文 / 题面 / 逐条向量取值 / 会话 id / 本机绝对路径。
 */
export function sanitizeReport(report, extra = {}) {
  return {
    schema: "k2-normalize-v2-freeze-v1",
    version: report.version,
    status: report.status,
    generatedAt: extra.generatedAt ?? null,
    baseRev: extra.gitRev ?? null,
    baseBranch: extra.branch ?? null,
    adoption: report.adoption,
    implementation: report.implementation,
    officialColumn: report.officialColumn,
    secondaryColumn: report.secondaryColumn,
    modelCalls: report.modelCalls,
    prereg: report.prereg,
    tools: report.tools,
    commands: report.commands,
    frozenInputs: {
      ok: report.frozen.ok,
      checks: report.frozen.checks.map((item) => ({ name: item.name, declared: item.declared, actual: item.actual, ok: item.ok })),
    },
    rulesVerbatim: report.rules,
    testVectors: {
      total: report.vectors.total,
      matched: report.vectors.matched,
      byCategory: report.vectors.byCategory,
      ids: report.vectors.ids,
      outcomes: report.vectors.rows.map((row) => ({ id: row.id, category: row.category, grader: row.grader, expectCorrect: row.expectCorrect, actualCorrect: row.actualCorrect, ok: row.ok })),
    },
    offlineReplay: {
      rawFiles: report.replay.rawFiles,
      httpStatusOk: report.replay.httpStatusOk,
      readerErrors: report.replay.readerErrors,
      v1Replay: report.replay.v1Replay,
      v1: {
        fullCorrect: report.replay.v1.fullCorrect,
        compactCorrect: report.replay.v1.compactCorrect,
        degraded: report.replay.v1.degraded,
        unknownIncrease: report.replay.v1.unknownIncrease,
        abstentionClean: report.replay.v1.abstentionClean,
      },
      v2: {
        fullCorrect: report.replay.v2.fullCorrect,
        compactCorrect: report.replay.v2.compactCorrect,
        degraded: report.replay.v2.degraded,
        unknownIncrease: report.replay.v2.unknownIncrease,
        abstentionClean: report.replay.v2.abstentionClean,
        summarizeStatusWouldBe: report.replay.v2.degraded.length === 0 ? "PASS" : "REGRESSION",
      },
      changedRows: report.replay.changedRows,
      regressionRows: report.replay.regressionRows,
      gainedRows: report.replay.gainedRows,
      acceptedAnswersStable: report.replay.acceptedAnswersStable,
      rows: report.replay.rows.map((row) => ({
        id: row.id,
        arm: row.arm,
        grader: row.grader,
        v1: { correct: row.v1.correct, code: row.v1.code },
        v2: { correct: row.v2.correct, code: row.v2.code },
        answerChanged: row.changed,
        changeCategory: row.changeCategory,
        officialMatch: row.v1AnswerMatchesOfficial && row.v1GradeMatchesOfficial && row.rawMatchesOfficial,
      })),
      readOnly: report.replay.readOnly,
      resultMeta: report.replay.resultMeta,
    },
    gate6: {
      formula: "noRegression && abstentionClean && answerPresentCoverage.full == 10/10 && answerPresentCoverage.compact == 10/10",
      value: report.gate.gate6,
      noRegression: report.gate.noRegression,
      abstentionClean: report.gate.abstentionClean,
      answerPresentCoverage: report.gate.answerPresentCoverage,
      reasons: report.gate.reasons,
      summarizeStatusIsNotGate: true,
      formatNormalizationIsNotQualityGain: true,
      cannotRetroactivelyChangeT7: true,
    },
    checks: report.checks,
    note: "离线第二列复算：不改 raw / k2-result.json / 题面 / 答案 / alias / 阈值，不重跑模型；official 列仍是 raw。",
  };
}

/* ────────────────────────────── CLI ────────────────────────────── */

function parseArgs(argv) {
  const opts = { json: false, write: false, verbose: false, out: null };
  const overrides = {};
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--write") opts.write = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--public-prereg=")) overrides.publicPrereg = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--private-prereg=")) overrides.privatePrereg = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--private-proposal=")) overrides.privateProposal = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--raw-dir=")) overrides.rawDir = arg.split("=").slice(1).join("=");
    else if (arg.startsWith("--result=")) overrides.result = arg.split("=").slice(1).join("=");
  }
  return { opts, overrides };
}

function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", timeout: 30000 }).trim();
    } catch {
      return null;
    }
  };
  return { gitRev: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) };
}

function printHuman(report) {
  const lines = [];
  lines.push(`v2 版本：${report.version}`);
  lines.push(`预注册：${report.prereg.publicStatus}（public sha256 ${report.prereg.publicSha256.slice(0, 12)}… · private ${report.prereg.privatePreregSha256.slice(0, 12)}…）`);
  lines.push(`冻结输入：${report.frozen.checks.filter((item) => item.ok).length}/${report.frozen.checks.length} 哈希一致`);
  lines.push(`21 向量：${report.vectors.matched}/${report.vectors.total}（format-positive ${report.vectors.byCategory["format-positive"] ?? 0} · semantic-negative ${report.vectors.byCategory["semantic-negative"] ?? 0}）`);
  lines.push(`v1 复算：${report.replay.v1Replay.exact}/${report.replay.rawFiles} 逐字一致（answer ${report.replay.v1Replay.answerMatched} · grade ${report.replay.v1Replay.gradeMatched} · raw ${report.replay.v1Replay.rawMatched}）`);
  lines.push(`v1 列：full ${report.replay.v1.fullCorrect}/10 · compact ${report.replay.v1.compactCorrect}/10 · degraded ${report.replay.v1.degraded.join(",") || "0"} · unknownIncrease ${report.replay.v1.unknownIncrease}`);
  lines.push(`v2 列：full ${report.replay.v2.fullCorrect}/10 · compact ${report.replay.v2.compactCorrect}/10 · degraded ${report.replay.v2.degraded.join(",") || "0"} · unknownIncrease ${report.replay.v2.unknownIncrease}`);
  lines.push(`改动行：${report.replay.changedRows.map((row) => `${row.id}/${row.arm} ${row.fromCode}→${row.toCode}（${row.category}）`).join(" · ") || "0"}`);
  lines.push(`gate6：${report.gate.gate6}（${report.gate.reasons.join("；") || "无理由"}）`);
  for (const item of report.checks) lines.push(`  ${item.ok ? "✓" : "✗"} ${item.id} — ${item.detail}`);
  lines.push(`结论：${report.status}（official 列 = raw，v2 只作离线第二列；未采用）`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const { opts, overrides } = parseArgs(argv);
  const artifacts = discoverArtifacts({ overrides });
  const required = ["publicPrereg", "privatePrereg", "rawDir", "result"];
  const missing = required.filter((key) => !artifacts[key]);
  if (missing.length > 0) {
    const message = { status: "INCOMPLETE", missing, searched: Object.fromEntries(required.map((key) => [key, ARTIFACTS[key]])), note: "本机缺输入（私有向量或 T7 官方历史）。这不是通过，也不是失败。" };
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    return 2;
  }
  let report;
  try {
    report = buildReport(artifacts);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "ERROR", message: String(error?.message ?? error) }, null, 2)}\n`);
    return 1;
  }
  const info = { ...gitInfo(), generatedAt: new Date().toISOString() };
  const publicView = sanitizeReport(report, info);
  if (opts.write) {
    const path = opts.out ? nodePath.resolve(opts.out) : nodePath.join(REPO, FREEZE_PATH);
    nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
    nodeFs.writeFileSync(path, `${JSON.stringify(publicView, null, 2)}\n`, "utf8");
    process.stderr.write(`[write] ${path}\n`);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(opts.verbose ? report : publicView, null, 2)}\n`);
  else {
    printHuman(report);
    if (opts.verbose) {
      for (const row of report.replay.rows) {
        process.stdout.write(`  · ${row.id}/${row.arm} v1=${row.v1.code}(${row.v1.correct}) v2=${row.v2.code}(${row.v2.correct}) 改动=${row.changed} 类别=${row.changeCategory ?? "-"}\n`);
      }
    }
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();