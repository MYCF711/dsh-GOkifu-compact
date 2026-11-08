#!/usr/bin/env node
/**
 * k2-hash-check.mjs — AX-03 预注册产物双哈希语义校验器（k2-hash-semantics-v1）
 *
 * 背景：`tmp/axiom-2026-11-07/ax03/fixtures.json` 的 `preregSha256` 记录的是
 *   sha256(canonicalJson(prereg 对象))，
 * **不是** `prereg.json` 原文字节的 sha256。字段值本身正确，但字段名未声明口径，
 * 且项目里此前没有任何下游校验器。
 *
 * 本脚本只做两件事：
 *   1. 用两个**永不交叉**的口径校验 AX-03 冻结产物：
 *        - raw-bytes-sha256      = 文件原文字节（UTF-8）的 sha256
 *        - canonical-json-sha256 = JSON.parse 后递归键排序、紧凑 JSON、UTF-8、
 *                                  无末尾换行 的 sha256
 *      `fixtures.preregSha256` 的唯一合法口径是 **canonical-json-sha256(prereg)**；
 *      绝不与 `raw-bytes-sha256(prereg.json)` 比较。
 *   2. 提供 `verifyPreregArtifacts()` 与内置正反例自测（`--self-test`），
 *      证明「值正确、口径可区分、篡改可发现」。
 *
 * 边界：只读校验。默认模式不写任何文件、不调用模型、不发网络请求、不改冻结产物。
 * 依赖：仅 Node 内置模块；**不 import `@deepseek-ai/*`，也不静态 import 产品 reader**。
 *       C07/C10 需要源码 QUESTIONS/buildPrereg 时才**动态**加载 `scripts/k2-value-reader.mjs`；
 *       加载失败默认 skip，加 `--require-source` 则视为失败（门禁模式）。
 *       sidecar（v1 冻结产物按设计没有）默认缺失即 skip；加 `--require-manifest` 则视为失败，
 *       且 M01-M13 会逐项校验声明字段（schema / 双哈希 / semantics / mustNotCompareWith /
 *       questionsSha256.value / projectionFields / excludedFields / artifacts 集合）。
 *
 * 用法：
 *   node scripts/k2-hash-check.mjs [--repo <path>] [--json]
 *   node scripts/k2-hash-check.mjs --self-test [--json] [--require-source]
 *   node scripts/k2-hash-check.mjs --prereg <prereg.json> --fixtures <fixtures.json> [--manifest <hash-manifest.json>] [--no-frozen] [--require-source] [--require-manifest]
 *   node scripts/k2-hash-check.mjs --emit-manifest <path>
 *
 * 退出码：0 = 全部通过；1 = 哈希/字段不一致（含 --require-manifest 缺 sidecar）；2 = 参数或文件缺失。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ─────────────────────────── 常量 ─────────────────────────── */

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(nodePath.join(HERE, ".."));

export const FIXTURE_SCHEMA = "k2-value-reader-fixtures-v1";
export const HASH_MANIFEST_SCHEMA = "k2-hash-semantics-v1";

/** `questionsSha256` 的投影字段（与 scripts/k2-value-reader.mjs 的 questionsSha256 同源）。 */
export const PROJECTION_FIELDS = Object.freeze([
  "id",
  "origin",
  "kind",
  "sessionHash",
  "sourceSeq",
  "sourceTool",
  "question",
  "answer",
  "grader",
  "aliases",
]);

/** AX-03 冻结基线（独立复核确认的 P0 不变量）。 */
export const FROZEN_BASELINE = Object.freeze({
  preregPath: "tmp/axiom-2026-11-07/ax03/prereg.json",
  fixturesPath: "tmp/axiom-2026-11-07/ax03/fixtures.json",
  preregBytes: 2842,
  fixturesBytes: 7864,
  preregRawSha256: "193947bb8492755110addcbc56623d4725c30a9110a9623d950374ba8812ecc3",
  fixturesRawSha256: "3ce54ac77f9936e1b6a8a7433fc56dd04b163b5364765be2152e446d35c7f23b",
  preregCanonicalJsonSha256: "cda2f2d0a14b10589e842ae955a58101ca943b2d6c011735599cf674cd77ea78",
  fixturesCanonicalJsonSha256: "82f8c8da08db55e01cf65390d5dec001e3675810d7d1243dbbba9ed22b88cd71",
  questionsSha256: "2c4d5f0bc93f0c0bf83414ece95f9937cc3d1836039d31ff5aad23734c989cd6",
});

/** 默认仓库根 = 本脚本所在仓库；允许环境变量覆盖，便于在任意 checkout 复跑。 */
export const DEFAULT_REPO = process.env.K2_HASH_REPO ? nodePath.resolve(process.env.K2_HASH_REPO) : ROOT;

/* ─────────────────────────── 错误与基础工具 ─────────────────────────── */

/** 输入类错误（缺文件、坏参数、坏 JSON）→ 退出码 2。 */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 稳定序列化：递归按对象键排序，数组保持顺序，JSON.stringify 紧凑格式。
 * 必须与 scripts/k2-value-reader.mjs 的 canonicalJson 逐字同构；
 * 任何差异都会通过 FROZEN 基线检查（preregCanonicalJsonSha256）暴露。
 */
export function canonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node)) {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, walk(node[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function sha256Bytes(bytes) {
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(String(text), "utf8"));
}

export function canonicalJsonSha256(value) {
  return sha256Text(canonicalJson(value));
}

export function questionsProjection(questions) {
  if (!Array.isArray(questions)) throw new InputError("questions 不是数组");
  return questions.map((item) =>
    Object.fromEntries(PROJECTION_FIELDS.map((field) => [field, item[field]])),
  );
}

export function questionsSha256Of(questions) {
  return canonicalJsonSha256(questionsProjection(questions));
}

function readRequiredFile(filePath) {
  let stat;
  try {
    stat = nodeFs.statSync(filePath);
  } catch {
    throw new InputError(`文件不存在：${filePath}`);
  }
  if (!stat.isFile()) throw new InputError(`不是普通文件：${filePath}`);
  return nodeFs.readFileSync(filePath);
}

function parseJsonBytes(bytes, filePath) {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`JSON 解析失败：${filePath}：${error.message}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ─────────────────────────── 检查项构造 ─────────────────────────── */

function pass(id, title, actual, expected = null) {
  return { id, title, status: "pass", actual, expected };
}

function fail(id, title, actual, expected, code, hint = null) {
  return { id, title, status: "fail", actual, expected, code, ...(hint ? { hint } : {}) };
}

function skip(id, title, reason) {
  return { id, title, status: "skip", reason };
}

function eqCheck(id, title, actual, expected, code) {
  return actual === expected ? pass(id, title, actual, expected) : fail(id, title, actual, expected, code);
}

function summarizeChecks(checks) {
  const passed = checks.filter((item) => item.status === "pass").length;
  const failed = checks.filter((item) => item.status === "fail").length;
  const skipped = checks.filter((item) => item.status === "skip").length;
  return { total: checks.length, passed, failed, skipped, ok: failed === 0 };
}

function failingCodes(result) {
  return [...new Set(result.checks.filter((item) => item.status === "fail").map((item) => item.code ?? "UNKNOWN"))];
}

/* ─────────────────────────── 核心校验器 ─────────────────────────── */

/**
 * 校验 `fixtures.preregSha256` 是否**正确指向使用的 prereg**。
 *
 * 唯一合法比较（C04）：
 *   fixtures.preregSha256 === sha256(canonicalJson(JSON.parse(preregBytes)))
 *
 * 禁止比较（C05 显式守护）：
 *   fixtures.preregSha256 === sha256(preregBytes)   // raw 文件哈希，会把正确数据判红
 *
 * @param {object} options
 * @param {string} options.preregPath     prereg.json 路径
 * @param {string} options.fixturesPath   fixtures.json 路径
 * @param {string|null} [options.manifestPath]  hash-manifest.json；缺省时自动探测同目录
 * @param {Array|null} [options.sourceQuestions] 源码 QUESTIONS（用于复算 questionsSha256）
 * @param {Function|null} [options.buildPreregFn] buildPrereg（用于重建校验）
 * @param {boolean} [options.enforceFrozenBaseline=true] 是否对 AX-03 冻结基线做硬校验
 * @param {boolean} [options.requireSource=false] 门禁模式：源码模块缺失时 C07/C10 判 fail
 * @param {boolean} [options.requireManifest=false] 门禁模式：sidecar 缺失时 M00 判 fail
 * @param {object} [options.baseline=FROZEN_BASELINE]
 * @returns {{ok:boolean,verdict:string,checks:Array,digests:object,summary:object,manifest:object|null,suggestedManifest:object}}
 */
export function verifyPreregArtifacts({
  preregPath,
  fixturesPath,
  manifestPath = null,
  sourceQuestions = null,
  buildPreregFn = null,
  enforceFrozenBaseline = true,
  requireSource = false,
  requireManifest = false,
  baseline = FROZEN_BASELINE,
} = {}) {
  if (!preregPath || !fixturesPath) throw new InputError("必须提供 preregPath 与 fixturesPath");

  const preregBytes = readRequiredFile(preregPath);
  const fixturesBytes = readRequiredFile(fixturesPath);
  const prereg = parseJsonBytes(preregBytes, preregPath);
  const fixtures = parseJsonBytes(fixturesBytes, fixturesPath);

  const preregRawSha256 = sha256Bytes(preregBytes);
  const fixturesRawSha256 = sha256Bytes(fixturesBytes);
  const preregCanonicalJsonSha256 = canonicalJsonSha256(prereg);
  const fixturesCanonicalJsonSha256 = canonicalJsonSha256(fixtures);

  const checks = [];

  // C01-C03：产物基本契约
  checks.push(eqCheck("C01", "fixtures.schema 为夹具 schema", fixtures.schema, FIXTURE_SCHEMA, "FIXTURE_SCHEMA_MISMATCH"));
  checks.push(eqCheck("C02", "fixtures.frozen === true", fixtures.frozen, true, "FIXTURE_NOT_FROZEN"));
  checks.push(eqCheck("C03", "fixtures.taskId === prereg.taskId", fixtures.taskId, prereg.taskId, "TASK_ID_MISMATCH"));

  // C04：核心——preregSha256 必须是 canonical-json 口径
  if (fixtures.preregSha256 === preregCanonicalJsonSha256) {
    checks.push(
      pass(
        "C04",
        "fixtures.preregSha256 === sha256(canonicalJson(prereg))（唯一合法比较）",
        fixtures.preregSha256,
        preregCanonicalJsonSha256,
      ),
    );
  } else if (fixtures.preregSha256 === preregRawSha256) {
    checks.push(
      fail(
        "C04",
        "fixtures.preregSha256 === sha256(canonicalJson(prereg))（唯一合法比较）",
        fixtures.preregSha256,
        preregCanonicalJsonSha256,
        "HASH_MODE_MISMATCH",
        "该值等于 prereg.json 的 raw-bytes-sha256；preregSha256 记录的是 canonical-json 值，不是文件哈希",
      ),
    );
  } else {
    checks.push(
      fail(
        "C04",
        "fixtures.preregSha256 === sha256(canonicalJson(prereg))（唯一合法比较）",
        fixtures.preregSha256,
        preregCanonicalJsonSha256,
        "PREREG_CANONICAL_HASH_MISMATCH",
      ),
    );
  }

  // C05：语义守护——canonical 值绝不能等于 raw 文件哈希（防口径混淆）
  checks.push(
    fixtures.preregSha256 === preregRawSha256
      ? fail(
          "C05",
          "fixtures.preregSha256 不得等于 prereg.json 的 raw-bytes-sha256（口径混淆守护）",
          fixtures.preregSha256,
          `!= ${preregRawSha256}`,
          "HASH_MODE_CONFUSION",
        )
      : pass(
          "C05",
          "fixtures.preregSha256 不得等于 prereg.json 的 raw-bytes-sha256（口径混淆守护）",
          fixtures.preregSha256,
          `!= ${preregRawSha256}`,
        ),
  );

  // C06：两处 questionsSha256 一致
  checks.push(
    eqCheck(
      "C06",
      "fixtures.questionsSha256 === prereg.questionsSha256",
      fixtures.questionsSha256,
      prereg.questionsSha256,
      "QUESTIONS_HASH_FIELD_MISMATCH",
    ),
  );

  // C07：源码 QUESTIONS 复算
  if (Array.isArray(sourceQuestions)) {
    const sourceHash = questionsSha256Of(sourceQuestions);
    checks.push(
      eqCheck(
        "C07",
        "questionsSha256(源码 QUESTIONS) === prereg.questionsSha256",
        sourceHash,
        prereg.questionsSha256,
        "QUESTIONS_HASH_SOURCE_MISMATCH",
      ),
    );
  } else if (requireSource) {
    checks.push(
      fail(
        "C07",
        "questionsSha256(源码 QUESTIONS) === prereg.questionsSha256",
        "<source module unavailable>",
        prereg.questionsSha256,
        "SOURCE_REQUIRED_MISSING",
        "门禁模式（--require-source）要求加载源码 QUESTIONS；加载失败即失败",
      ),
    );
  } else {
    checks.push(
      skip(
        "C07",
        "questionsSha256(源码 QUESTIONS) === prereg.questionsSha256",
        "未加载源码 QUESTIONS（--repo 不可用或显式跳过）",
      ),
    );
  }

  // C08：fixtures.questions 的 10 字段投影复算
  const fixturesProjectionHash = questionsSha256Of(fixtures.questions);
  checks.push(
    eqCheck(
      "C08",
      "sha256(canonicalJson(projection(fixtures.questions))) === fixtures.questionsSha256",
      fixturesProjectionHash,
      fixtures.questionsSha256,
      "QUESTIONS_HASH_MISMATCH",
    ),
  );

  // C09：题号清单与顺序一致
  const fixtureIds = Array.isArray(fixtures.questions) ? fixtures.questions.map((item) => item.id) : null;
  const preregIds = Array.isArray(prereg.questionIds) ? prereg.questionIds : null;
  checks.push(
    JSON.stringify(fixtureIds) === JSON.stringify(preregIds)
      ? pass("C09", "prereg.questionIds 与 fixtures.questions[].id 顺序一致", JSON.stringify(fixtureIds), JSON.stringify(preregIds))
      : fail(
          "C09",
          "prereg.questionIds 与 fixtures.questions[].id 顺序一致",
          JSON.stringify(fixtureIds),
          JSON.stringify(preregIds),
          "QUESTION_IDS_MISMATCH",
        ),
  );

  // C10：用 buildPrereg 重建，证明 preregSha256 的来源可复现
  if (typeof buildPreregFn === "function" && Array.isArray(sourceQuestions)) {
    try {
      const rebuilt = buildPreregFn({
        questions: sourceQuestions,
        frozenAt: prereg.frozenAt,
        frozenAtRev: prereg.frozenAtRev,
      });
      const rebuiltCanonicalSha256 = canonicalJsonSha256(rebuilt);
      checks.push(
        eqCheck(
          "C10",
          "buildPrereg({frozenAt,frozenAtRev}) 重建对象的 canonical 哈希 === 磁盘 prereg",
          rebuiltCanonicalSha256,
          preregCanonicalJsonSha256,
          "REBUILD_MISMATCH",
        ),
      );
    } catch (error) {
      checks.push(
        fail(
          "C10",
          "buildPrereg({frozenAt,frozenAtRev}) 重建对象的 canonical 哈希 === 磁盘 prereg",
          `throw: ${error?.message ?? error}`,
          preregCanonicalJsonSha256,
          "REBUILD_FAILED",
        ),
      );
    }
  } else if (requireSource) {
    checks.push(
      fail(
        "C10",
        "buildPrereg({frozenAt,frozenAtRev}) 重建对象的 canonical 哈希 === 磁盘 prereg",
        "<source module unavailable>",
        preregCanonicalJsonSha256,
        "SOURCE_REQUIRED_MISSING",
        "门禁模式（--require-source）要求加载 buildPrereg；加载失败即失败",
      ),
    );
  } else {
    checks.push(skip("C10", "buildPrereg 重建校验（需要源码模块）", "未加载 buildPrereg"));
  }

  // F01-F06：AX-03 冻结基线（P0 不变量）
  if (enforceFrozenBaseline) {
    checks.push(
      eqCheck(
        "F01",
        "冻结基线：prereg.json / fixtures.json 字节数",
        `${preregBytes.length}/${fixturesBytes.length}`,
        `${baseline.preregBytes}/${baseline.fixturesBytes}`,
        "FROZEN_ARTIFACT_CHANGED",
      ),
      eqCheck(
        "F02",
        "冻结基线：prereg.json raw-bytes-sha256",
        preregRawSha256,
        baseline.preregRawSha256,
        "FROZEN_ARTIFACT_CHANGED",
      ),
      eqCheck(
        "F03",
        "冻结基线：fixtures.json raw-bytes-sha256",
        fixturesRawSha256,
        baseline.fixturesRawSha256,
        "FROZEN_ARTIFACT_CHANGED",
      ),
      eqCheck(
        "F04",
        "冻结基线：prereg.json canonical-json-sha256",
        preregCanonicalJsonSha256,
        baseline.preregCanonicalJsonSha256,
        "FROZEN_ARTIFACT_CHANGED",
      ),
      eqCheck(
        "F05",
        "冻结基线：fixtures.json canonical-json-sha256",
        fixturesCanonicalJsonSha256,
        baseline.fixturesCanonicalJsonSha256,
        "FROZEN_ARTIFACT_CHANGED",
      ),
      eqCheck(
        "F06",
        "冻结基线：questionsSha256",
        fixtures.questionsSha256,
        baseline.questionsSha256,
        "FROZEN_ARTIFACT_CHANGED",
      ),
    );
  }

  // M01-M13：sidecar（k2-hash-semantics-v1）——声明字段必须与冻结数据逐项一致。
  //
  // 兼容模式（默认）：没有 sidecar ⇒ skip，exit 0（v1 冻结产物按设计就没有 sidecar）。
  // 门禁模式（--require-manifest）：没有 sidecar ⇒ M00 fail，exit 1；不允许用 skip 冒充通过。
  // 显式 `--manifest <path>` 指向不存在的文件属于**输入错误**（exit 2），与“可选 sidecar
  // 缺失”区分开：前者是调用方指错了路径，后者是旧产物本来就没有声明文件。
  let effectiveManifestPath = manifestPath;
  if (!effectiveManifestPath) {
    const candidate = nodePath.join(nodePath.dirname(preregPath), "hash-manifest.json");
    if (nodeFs.existsSync(candidate)) effectiveManifestPath = candidate;
  }
  let manifest = null;
  if (effectiveManifestPath) {
    manifest = parseJsonBytes(readRequiredFile(effectiveManifestPath), effectiveManifestPath);
    const preregArtifact = manifest.artifacts?.[nodePath.basename(preregPath)] ?? {};
    const fixturesArtifact = manifest.artifacts?.[nodePath.basename(fixturesPath)] ?? {};
    const preregField = manifest.fieldSemantics?.["fixtures.preregSha256"] ?? {};
    const questionsField = manifest.fieldSemantics?.["fixtures.questionsSha256"] ?? {};
    const artifactKeys = Object.keys(manifest.artifacts ?? {}).sort();
    const expectedArtifactKeys = [nodePath.basename(fixturesPath), nodePath.basename(preregPath)].sort();
    const actualProjectionFields = JSON.stringify(questionsField.projectionFields ?? null);
    const expectedProjectionFields = JSON.stringify([...PROJECTION_FIELDS]);
    const actualExcludedFields = JSON.stringify(questionsField.excludedFields ?? null);
    const expectedExcludedFields = JSON.stringify(["hypothesis"]);
    checks.push(
      eqCheck(
        "M01",
        "hash-manifest.schema === k2-hash-semantics-v1",
        manifest.schema,
        HASH_MANIFEST_SCHEMA,
        "MANIFEST_SCHEMA_MISMATCH",
      ),
      eqCheck(
        "M02",
        "hash-manifest 记录的 prereg.json raw-bytes-sha256 等于实际字节",
        preregArtifact.rawBytesSha256,
        preregRawSha256,
        "MANIFEST_RAW_MISMATCH",
      ),
      eqCheck(
        "M03",
        "hash-manifest 记录的 fixtures.json raw-bytes-sha256 等于实际字节",
        fixturesArtifact.rawBytesSha256,
        fixturesRawSha256,
        "MANIFEST_RAW_MISMATCH",
      ),
      eqCheck(
        "M04",
        "hash-manifest.fieldSemantics.fixtures.preregSha256.value 等于实际字段",
        preregField.value,
        fixtures.preregSha256,
        "MANIFEST_FIELD_MISMATCH",
      ),
      // H3-O1：记录 canonical 摘要的字段缺失必须判红，不能靠 `??` 回退成“默认通过”。
      typeof preregArtifact.canonicalJsonSha256 === "string" && preregArtifact.canonicalJsonSha256 !== ""
        ? eqCheck(
            "M05",
            "hash-manifest 记录的 prereg canonical-json-sha256 等于实际对象",
            preregArtifact.canonicalJsonSha256,
            preregCanonicalJsonSha256,
            "MANIFEST_CANONICAL_MISMATCH",
          )
        : fail(
            "M05",
            "hash-manifest 记录的 prereg canonical-json-sha256 等于实际对象",
            "<missing>",
            preregCanonicalJsonSha256,
            "MANIFEST_CANONICAL_MISSING",
            "sidecar 一旦存在，canonicalJsonSha256 必须显式记录（H3-O1）",
          ),
      // M06：补齐 fixtures 侧的 canonical 记录校验（双哈希的另一半）。
      typeof fixturesArtifact.canonicalJsonSha256 === "string" && fixturesArtifact.canonicalJsonSha256 !== ""
        ? eqCheck(
            "M06",
            "hash-manifest 记录的 fixtures canonical-json-sha256 等于实际对象",
            fixturesArtifact.canonicalJsonSha256,
            fixturesCanonicalJsonSha256,
            "MANIFEST_FIXTURES_CANONICAL_MISMATCH",
          )
        : fail(
            "M06",
            "hash-manifest 记录的 fixtures canonical-json-sha256 等于实际对象",
            "<missing>",
            fixturesCanonicalJsonSha256,
            "MANIFEST_FIXTURES_CANONICAL_MISSING",
            "sidecar 一旦存在，fixtures 的 canonicalJsonSha256 必须显式记录",
          ),
      // M07-M13（G2-F1）：sidecar 是声明文档，声明本身也必须被校验 ——
      // 否则改一句 semantics 就能让“双哈希口径”变形而运行时仍然 exit 0。
      eqCheck(
        "M07",
        "hash-manifest.fieldSemantics.fixtures.preregSha256.semantics === canonical-json-sha256",
        preregField.semantics,
        "canonical-json-sha256",
        "MANIFEST_SEMANTICS_MISMATCH",
      ),
      eqCheck(
        "M08",
        "hash-manifest.fieldSemantics.fixtures.questionsSha256.semantics === projection-canonical-json-sha256",
        questionsField.semantics,
        "projection-canonical-json-sha256",
        "MANIFEST_QUESTIONS_SEMANTICS_MISMATCH",
      ),
      eqCheck(
        "M09",
        "hash-manifest.fieldSemantics.fixtures.preregSha256.mustNotCompareWith === raw-bytes-sha256(prereg.json)",
        preregField.mustNotCompareWith,
        "raw-bytes-sha256(prereg.json)",
        "MANIFEST_MUST_NOT_COMPARE_MISMATCH",
      ),
      eqCheck(
        "M10",
        "hash-manifest.fieldSemantics.fixtures.questionsSha256.value 等于实际 questionsSha256",
        questionsField.value,
        fixtures.questionsSha256,
        "MANIFEST_QUESTIONS_FIELD_MISMATCH",
      ),
      actualProjectionFields === expectedProjectionFields
        ? pass(
            "M11",
            "hash-manifest 的 questionsSha256 投影字段等于产品 10 字段口径",
            actualProjectionFields,
            expectedProjectionFields,
          )
        : fail(
            "M11",
            "hash-manifest 的 questionsSha256 投影字段等于产品 10 字段口径",
            actualProjectionFields,
            expectedProjectionFields,
            "MANIFEST_PROJECTION_FIELDS_MISMATCH",
          ),
      actualExcludedFields === expectedExcludedFields
        ? pass("M12", "hash-manifest 的 questionsSha256 排除字段恰好是 hypothesis", actualExcludedFields, expectedExcludedFields)
        : fail(
            "M12",
            "hash-manifest 的 questionsSha256 排除字段恰好是 hypothesis",
            actualExcludedFields,
            expectedExcludedFields,
            "MANIFEST_EXCLUDED_FIELDS_MISMATCH",
          ),
      JSON.stringify(artifactKeys) === JSON.stringify(expectedArtifactKeys)
        ? pass(
            "M13",
            "hash-manifest.artifacts 恰好包含 prereg.json / fixtures.json（不得有额外或缺失）",
            artifactKeys.join(","),
            expectedArtifactKeys.join(","),
          )
        : fail(
            "M13",
            "hash-manifest.artifacts 恰好包含 prereg.json / fixtures.json（不得有额外或缺失）",
            artifactKeys.join(",") || "<empty>",
            expectedArtifactKeys.join(","),
            "MANIFEST_ARTIFACTS_MISMATCH",
          ),
    );
  } else if (requireManifest) {
    checks.push(
      fail(
        "M00",
        "hash-manifest sidecar 必须存在（--require-manifest 门禁模式）",
        "<missing>",
        "hash-manifest.json",
        "MANIFEST_REQUIRED_MISSING",
        "兼容模式请去掉 --require-manifest；门禁模式要求 sidecar 与冻结产物同目录",
      ),
    );
  } else {
    checks.push(
      skip(
        "M01-M13",
        "hash-manifest sidecar 校验",
        "未提供且同目录不存在 hash-manifest.json（v1 冻结产物按设计没有 sidecar；需要门禁请加 --require-manifest）",
      ),
    );
  }

  const summary = summarizeChecks(checks);
  const suggestedManifest = buildHashManifestFromParts({
    preregPath,
    fixturesPath,
    prereg,
    fixtures,
    preregBytes,
    fixturesBytes,
  });

  return {
    ok: summary.ok,
    verdict: summary.ok ? "PASS" : "FAIL",
    checks,
    digests: {
      prereg: {
        path: preregPath,
        bytes: preregBytes.length,
        rawBytesSha256: preregRawSha256,
        canonicalJsonSha256: preregCanonicalJsonSha256,
      },
      fixtures: {
        path: fixturesPath,
        bytes: fixturesBytes.length,
        rawBytesSha256: fixturesRawSha256,
        canonicalJsonSha256: fixturesCanonicalJsonSha256,
      },
      questions: {
        fromSource: Array.isArray(sourceQuestions) ? questionsSha256Of(sourceQuestions) : null,
        fromPreregField: prereg.questionsSha256 ?? null,
        fromFixturesField: fixtures.questionsSha256 ?? null,
        fromFixturesProjection: fixturesProjectionHash,
      },
    },
    summary,
    manifest,
    suggestedManifest,
  };
}

/* ─────────────────────────── sidecar 生成 ─────────────────────────── */

function buildHashManifestFromParts({
  preregPath,
  fixturesPath,
  prereg,
  fixtures,
  preregBytes,
  fixturesBytes,
}) {
  const preregCanonicalJsonSha256 = canonicalJsonSha256(prereg);
  return {
    schema: HASH_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    generator: "scripts/k2-hash-check.mjs",
    artifacts: {
      [nodePath.basename(preregPath)]: {
        bytes: preregBytes.length,
        rawBytesSha256: sha256Bytes(preregBytes),
        canonicalJsonSha256: preregCanonicalJsonSha256,
      },
      [nodePath.basename(fixturesPath)]: {
        bytes: fixturesBytes.length,
        rawBytesSha256: sha256Bytes(fixturesBytes),
        canonicalJsonSha256: canonicalJsonSha256(fixtures),
      },
    },
    fieldSemantics: {
      "fixtures.preregSha256": {
        semantics: "canonical-json-sha256",
        value: fixtures.preregSha256,
        input: "JSON.parse(prereg.json bytes)",
        canonicalization:
          "recursive object-key sort (JS Object.keys().sort()); arrays preserve order; JSON.stringify compact; UTF-8; no trailing newline",
        mustNotCompareWith: "raw-bytes-sha256(prereg.json)",
      },
      "fixtures.questionsSha256": {
        semantics: "projection-canonical-json-sha256",
        value: fixtures.questionsSha256,
        projectionFields: [...PROJECTION_FIELDS],
        excludedFields: ["hypothesis"],
        canonicalization:
          "recursive object-key sort (JS Object.keys().sort()); arrays preserve order; JSON.stringify compact; UTF-8; no trailing newline",
      },
    },
  };
}

/** 供 CLI `--emit-manifest` 与测试使用：只读两个产物并返回 sidecar 对象。 */
export function buildHashManifest({ preregPath, fixturesPath }) {
  const preregBytes = readRequiredFile(preregPath);
  const fixturesBytes = readRequiredFile(fixturesPath);
  return buildHashManifestFromParts({
    preregPath,
    fixturesPath,
    prereg: parseJsonBytes(preregBytes, preregPath),
    fixtures: parseJsonBytes(fixturesBytes, fixturesPath),
    preregBytes,
    fixturesBytes,
  });
}

/* ─────────────────────────── 源码模块加载 ─────────────────────────── */

async function loadK2Module(repo) {
  const modulePath = nodePath.join(repo, "scripts", "k2-value-reader.mjs");
  if (!nodeFs.existsSync(modulePath)) {
    return { module: null, modulePath, error: `找不到 ${modulePath}` };
  }
  try {
    const module = await import(pathToFileURL(modulePath).href);
    return { module, modulePath, error: null };
  } catch (error) {
    return { module: null, modulePath, error: String(error?.message ?? error) };
  }
}

function repoHead(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/* ─────────────────────────── 输出 ─────────────────────────── */

function printHumanResult(result, { repo, repoHeadValue, moduleInfo }) {
  console.log("== AX-03 预注册产物哈希语义校验（k2-hash-semantics-v1）==");
  console.log(`repo      : ${repo}`);
  console.log(`HEAD      : ${repoHeadValue ?? "N/A"}`);
  console.log(`prereg    : ${result.digests.prereg.path} (${result.digests.prereg.bytes} bytes)`);
  console.log(`fixtures  : ${result.digests.fixtures.path} (${result.digests.fixtures.bytes} bytes)`);
  if (moduleInfo?.error) console.log(`source    : SKIP (${moduleInfo.error})`);
  console.log("");
  for (const item of result.checks) {
    const tag = item.status === "pass" ? "PASS" : item.status === "fail" ? "FAIL" : "SKIP";
    console.log(`[${tag}] ${item.id} ${item.title}`);
    if (item.status === "fail") {
      console.log(`       actual   = ${item.actual}`);
      console.log(`       expected = ${item.expected}`);
      if (item.code) console.log(`       code     = ${item.code}`);
      if (item.hint) console.log(`       hint     = ${item.hint}`);
    } else if (item.status === "skip") {
      console.log(`       reason   = ${item.reason}`);
    }
  }
  console.log("");
  console.log("digests:");
  console.log(`  prereg raw-bytes-sha256        = ${result.digests.prereg.rawBytesSha256}`);
  console.log(`  prereg canonical-json-sha256   = ${result.digests.prereg.canonicalJsonSha256}`);
  console.log(`  fixtures raw-bytes-sha256      = ${result.digests.fixtures.rawBytesSha256}`);
  console.log(`  fixtures canonical-json-sha256 = ${result.digests.fixtures.canonicalJsonSha256}`);
  console.log(`  questionsSha256 (source)       = ${result.digests.questions.fromSource ?? "N/A"}`);
  console.log(`  questionsSha256 (prereg 字段)  = ${result.digests.questions.fromPreregField}`);
  console.log(`  questionsSha256 (fixtures 字段)= ${result.digests.questions.fromFixturesField}`);
  console.log(`  questionsSha256 (投影复算)     = ${result.digests.questions.fromFixturesProjection}`);
  console.log("");
  const s = result.summary;
  console.log(`== ${result.verdict}（${s.total} checks: ${s.passed} pass, ${s.failed} fail, ${s.skipped} skip）==`);
}

/* ─────────────────────────── 自测（正反例） ─────────────────────────── */

function writeJsonFile(filePath, value) {
  nodeFs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function runSelfTest({ repo, requireSource = false }) {
  const baselinePreregPath = nodePath.join(repo, FROZEN_BASELINE.preregPath);
  const baselineFixturesPath = nodePath.join(repo, FROZEN_BASELINE.fixturesPath);
  const preregBytes = readRequiredFile(baselinePreregPath);
  const fixturesBytes = readRequiredFile(baselineFixturesPath);
  const preregObj = parseJsonBytes(preregBytes, baselinePreregPath);
  const fixturesObj = parseJsonBytes(fixturesBytes, baselineFixturesPath);
  const { module: k2, error: moduleError } = await loadK2Module(repo);
  const sourceQuestions = k2?.QUESTIONS ?? null;
  const buildPreregFn = k2?.buildPrereg ?? null;

  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "k2-hash-check-"));
  const cases = [];
  const record = (id, description, ok, detail) => {
    cases.push({ id, description, status: ok ? "pass" : "fail", detail });
  };

  try {
    const pair = (name) => {
      const dir = nodePath.join(root, name);
      nodeFs.mkdirSync(dir, { recursive: true });
      const preregPath = nodePath.join(dir, "prereg.json");
      const fixturesPath = nodePath.join(dir, "fixtures.json");
      return { dir, preregPath, fixturesPath };
    };
    const copyBaseline = (name) => {
      const p = pair(name);
      nodeFs.copyFileSync(baselinePreregPath, p.preregPath);
      nodeFs.copyFileSync(baselineFixturesPath, p.fixturesPath);
      return p;
    };
    const verify = (paths, extra = {}) =>
      verifyPreregArtifacts({
        preregPath: paths.preregPath,
        fixturesPath: paths.fixturesPath,
        sourceQuestions,
        buildPreregFn,
        requireSource,
        ...extra,
      });

    // T1：当前冻结对必须全过
    {
      const p = copyBaseline("t1-baseline");
      const result = verify(p);
      record(
        "T1",
        "当前冻结对：canonical 匹配 + 冻结基线 + 题集哈希四处一致 → PASS",
        result.ok && result.summary.failed === 0,
        `ok=${result.ok}, failed=${result.summary.failed}, failing=${failingCodes(result).join(",") || "none"}`,
      );
    }

    // T2：把 raw 文件哈希写进 preregSha256 → 必须报 HASH_MODE_MISMATCH
    {
      const p = copyBaseline("t2-raw-mode");
      const fixtures = cloneJson(fixturesObj);
      fixtures.preregSha256 = FROZEN_BASELINE.preregRawSha256;
      writeJsonFile(p.fixturesPath, fixtures);
      const result = verify(p, { enforceFrozenBaseline: false });
      record(
        "T2",
        "误把 prereg.json 的 raw-bytes-sha256 写入 fixtures.preregSha256 → FAIL/HASH_MODE_MISMATCH",
        !result.ok && failingCodes(result).includes("HASH_MODE_MISMATCH"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T3：篡改任一 answer → 投影 questionsSha256 改变 → FAIL
    {
      const p = copyBaseline("t3-answer-tamper");
      const fixtures = cloneJson(fixturesObj);
      fixtures.questions[0].answer = `${fixtures.questions[0].answer}!`;
      writeJsonFile(p.fixturesPath, fixtures);
      const result = verify(p, { enforceFrozenBaseline: false });
      record(
        "T3",
        "篡改任一 answer → FAIL/QUESTIONS_HASH_MISMATCH",
        !result.ok && failingCodes(result).includes("QUESTIONS_HASH_MISMATCH"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T4：篡改 prereg.objective → canonical 哈希改变 → FAIL
    {
      const p = copyBaseline("t4-prereg-tamper");
      const prereg = cloneJson(preregObj);
      prereg.objective = `${prereg.objective}（篡改）`;
      writeJsonFile(p.preregPath, prereg);
      const result = verify(p, { enforceFrozenBaseline: false });
      record(
        "T4",
        "篡改 prereg.objective → FAIL/PREREG_CANONICAL_HASH_MISMATCH",
        !result.ok && failingCodes(result).includes("PREREG_CANONICAL_HASH_MISMATCH"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T5：只改缩进/键序，raw 变、canonical 不变 → 按 canonical 校验仍 PASS
    {
      const p = copyBaseline("t5-reorder");
      const reversed = {};
      for (const key of Object.keys(preregObj).reverse()) reversed[key] = preregObj[key];
      const reorderedText = `${JSON.stringify(reversed, null, 4)}\n`;
      nodeFs.writeFileSync(p.preregPath, reorderedText, "utf8");
      const newRaw = sha256Bytes(Buffer.from(reorderedText, "utf8"));
      const newCanonical = canonicalJsonSha256(JSON.parse(reorderedText));
      const rawChanged = newRaw !== FROZEN_BASELINE.preregRawSha256;
      const canonicalSame = newCanonical === FROZEN_BASELINE.preregCanonicalJsonSha256;
      record(
        "T5a",
        "仅改 prereg 缩进/顶层键序：raw-bytes 哈希改变、canonical 哈希不变",
        rawChanged && canonicalSame,
        `rawChanged=${rawChanged}, canonicalSame=${canonicalSame}`,
      );
      const result = verify(p, { enforceFrozenBaseline: false });
      record(
        "T5b",
        "仅改 prereg 缩进/键序：canonical 语义校验仍 PASS（证明口径正确）",
        result.ok,
        `ok=${result.ok}, failing=${failingCodes(result).join(",") || "none"}`,
      );
    }

    // T6：同 T5 重排 + 原始 raw 哈希的 sidecar → canonical 通过、manifest raw 报 FILE_CHANGED
    {
      const p = copyBaseline("t6-manifest");
      const reversed = {};
      for (const key of Object.keys(preregObj).reverse()) reversed[key] = preregObj[key];
      nodeFs.writeFileSync(p.preregPath, `${JSON.stringify(reversed, null, 4)}\n`, "utf8");
      const manifest = buildHashManifest({ preregPath: baselinePreregPath, fixturesPath: baselineFixturesPath });
      const manifestPath = writeJsonFile(nodePath.join(p.dir, "hash-manifest.json"), manifest);
      const result = verify(p, { enforceFrozenBaseline: false, manifestPath });
      const c04 = result.checks.find((item) => item.id === "C04");
      record(
        "T6",
        "仅改缩进：canonical 校验 PASS，但 sidecar raw 校验 FAIL/MANIFEST_RAW_MISMATCH",
        !result.ok && c04?.status === "pass" && failingCodes(result).includes("MANIFEST_RAW_MISMATCH"),
        `ok=${result.ok}, C04=${c04?.status}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T7：preregSha256 = null → FAIL
    {
      const p = copyBaseline("t7-null");
      const fixtures = cloneJson(fixturesObj);
      fixtures.preregSha256 = null;
      writeJsonFile(p.fixturesPath, fixtures);
      const result = verify(p, { enforceFrozenBaseline: false });
      record(
        "T7",
        "fixtures.preregSha256 缺失/为 null → FAIL/PREREG_CANONICAL_HASH_MISMATCH",
        !result.ok && failingCodes(result).includes("PREREG_CANONICAL_HASH_MISMATCH"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T8：缺文件 → InputError（CLI 退出码 2 的语义）
    {
      let thrown = null;
      try {
        verify(
          { preregPath: nodePath.join(root, "does-not-exist.json"), fixturesPath: baselineFixturesPath },
          { enforceFrozenBaseline: false },
        );
      } catch (error) {
        thrown = error;
      }
      record(
        "T8",
        "缺 prereg 文件 → InputError（对应退出码 2）",
        thrown instanceof InputError,
        thrown ? `${thrown.name}: ${thrown.message}` : "未抛错",
      );
    }

    // T9：sidecar 漏写 prereg canonicalJsonSha256 → 必须 FAIL（H3-O1 修复）
    {
      const p = copyBaseline("t9-manifest-missing-canonical");
      const manifest = buildHashManifest({ preregPath: baselinePreregPath, fixturesPath: baselineFixturesPath });
      delete manifest.artifacts["prereg.json"].canonicalJsonSha256;
      const manifestPath = writeJsonFile(nodePath.join(p.dir, "hash-manifest.json"), manifest);
      const result = verify(p, { enforceFrozenBaseline: false, manifestPath });
      record(
        "T9",
        "sidecar 漏写 prereg canonicalJsonSha256 → FAIL/MANIFEST_CANONICAL_MISSING",
        !result.ok && failingCodes(result).includes("MANIFEST_CANONICAL_MISSING"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T10：门禁模式（--require-source）在源码模块缺失时必须判红（H3-O2 修复）
    {
      const p = copyBaseline("t10-require-source");
      const result = verify(p, { enforceFrozenBaseline: false, sourceQuestions: null, buildPreregFn: null, requireSource: true });
      record(
        "T10",
        "requireSource 且源码模块缺失 → FAIL/SOURCE_REQUIRED_MISSING（不允许以 skip 冒充全验）",
        !result.ok && failingCodes(result).includes("SOURCE_REQUIRED_MISSING"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T11：sidecar 的 fixtures canonical 记录错误 → FAIL/MANIFEST_FIXTURES_CANONICAL_MISMATCH
    {
      const p = copyBaseline("t11-manifest-fixtures-canonical");
      const manifest = buildHashManifest({ preregPath: baselinePreregPath, fixturesPath: baselineFixturesPath });
      manifest.artifacts["fixtures.json"].canonicalJsonSha256 = "0".repeat(64);
      const manifestPath = writeJsonFile(nodePath.join(p.dir, "hash-manifest.json"), manifest);
      const result = verify(p, { enforceFrozenBaseline: false, manifestPath });
      record(
        "T11",
        "sidecar 的 fixtures canonicalJsonSha256 错误 → FAIL/MANIFEST_FIXTURES_CANONICAL_MISMATCH",
        !result.ok && failingCodes(result).includes("MANIFEST_FIXTURES_CANONICAL_MISMATCH"),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    }

    // T12：兼容模式 vs 门禁模式 —— 无 sidecar 时默认 skip，--require-manifest 判红（G2-F2）
    {
      const p = copyBaseline("t12-require-manifest");
      const compat = verify(p, { enforceFrozenBaseline: false });
      const required = verify(p, { enforceFrozenBaseline: false, requireManifest: true });
      record(
        "T12",
        "无 sidecar：默认兼容模式 PASS/skip；--require-manifest 门禁 FAIL/MANIFEST_REQUIRED_MISSING",
        compat.ok && compat.checks.some((item) => item.id === "M01-M13" && item.status === "skip") &&
          !required.ok && failingCodes(required).includes("MANIFEST_REQUIRED_MISSING"),
        `compat=${compat.ok}/${compat.summary.skipped}skip, required=${required.ok}/${failingCodes(required).join(",")}`,
      );
    }

    // T13-T19（G2-F1）：sidecar 声明字段的五类语义篡改/多余 artifacts 都必须红。
    const mutationCase = (id, name, mutate, expectedCode) => {
      const p = copyBaseline(name);
      const manifest = buildHashManifest({ preregPath: baselinePreregPath, fixturesPath: baselineFixturesPath });
      mutate(manifest);
      const manifestPath = writeJsonFile(nodePath.join(p.dir, "hash-manifest.json"), manifest);
      const result = verify(p, { enforceFrozenBaseline: false, manifestPath });
      record(
        id,
        `${name} → FAIL/${expectedCode}`,
        !result.ok && failingCodes(result).includes(expectedCode),
        `ok=${result.ok}, failing=${failingCodes(result).join(",")}`,
      );
    };

    mutationCase(
      "T13",
      "sidecar 的 preregSha256.semantics 被改成 raw-bytes-sha256",
      (manifest) => {
        manifest.fieldSemantics["fixtures.preregSha256"].semantics = "raw-bytes-sha256";
      },
      "MANIFEST_SEMANTICS_MISMATCH",
    );

    mutationCase(
      "T14",
      "sidecar 的 questionsSha256.semantics 被改错",
      (manifest) => {
        manifest.fieldSemantics["fixtures.questionsSha256"].semantics = "canonical-json-sha256";
      },
      "MANIFEST_QUESTIONS_SEMANTICS_MISMATCH",
    );

    mutationCase(
      "T15",
      "sidecar 的 mustNotCompareWith 被删掉",
      (manifest) => {
        delete manifest.fieldSemantics["fixtures.preregSha256"].mustNotCompareWith;
      },
      "MANIFEST_MUST_NOT_COMPARE_MISMATCH",
    );

    mutationCase(
      "T16",
      "sidecar 的 questionsSha256.value 被篡改",
      (manifest) => {
        manifest.fieldSemantics["fixtures.questionsSha256"].value = "0".repeat(64);
      },
      "MANIFEST_QUESTIONS_FIELD_MISMATCH",
    );

    mutationCase(
      "T17",
      "sidecar 的 projectionFields 被删掉一个字段",
      (manifest) => {
        manifest.fieldSemantics["fixtures.questionsSha256"].projectionFields.pop();
      },
      "MANIFEST_PROJECTION_FIELDS_MISMATCH",
    );

    mutationCase(
      "T18",
      "sidecar 的 excludedFields 被改成空数组",
      (manifest) => {
        manifest.fieldSemantics["fixtures.questionsSha256"].excludedFields = [];
      },
      "MANIFEST_EXCLUDED_FIELDS_MISMATCH",
    );

    mutationCase(
      "T19",
      "sidecar 的 artifacts 多出第三个条目",
      (manifest) => {
        manifest.artifacts["prereg.json.bak"] = { bytes: 0, rawBytesSha256: "0".repeat(64), canonicalJsonSha256: "0".repeat(64) };
      },
      "MANIFEST_ARTIFACTS_MISMATCH",
    );
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }

  const failed = cases.filter((item) => item.status === "fail").length;
  const ok = failed === 0;
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          schema: "k2-hash-check-selftest-v1",
          ok,
          verdict: ok ? "PASS" : "FAIL",
          repo,
          requireSource,
          sourceModule: moduleError ? { loaded: false, error: moduleError } : { loaded: true },
          cases,
          summary: { total: cases.length, passed: cases.length - failed, failed },
        },
        null,
        2,
      ),
    );
  } else {
    console.log("== AX-03 hash check self-test（正反例）==");
    console.log(`repo: ${repo}`);
    if (moduleError) console.log(`source module: SKIP (${moduleError})`);
    for (const item of cases) {
      console.log(`[${item.status === "pass" ? "PASS" : "FAIL"}] ${item.id} ${item.description}`);
      if (item.status === "fail") console.log(`       detail = ${item.detail}`);
    }
    console.log(`== self-test ${ok ? "PASS" : "FAIL"}（${cases.length - failed}/${cases.length} passed, ${failed} failed）==`);
  }
  return ok ? 0 : 1;
}

/* ─────────────────────────── CLI ─────────────────────────── */

function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    preregPath: null,
    fixturesPath: null,
    manifestPath: null,
    emitManifest: null,
    json: false,
    selfTest: false,
    enforceFrozenBaseline: true,
    requireSource: false,
    requireManifest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new InputError(`参数 ${arg} 缺少值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--repo":
        options.repo = next();
        break;
      case "--prereg":
        options.preregPath = next();
        break;
      case "--fixtures":
        options.fixturesPath = next();
        break;
      case "--manifest":
        options.manifestPath = next();
        break;
      case "--emit-manifest":
        options.emitManifest = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--no-frozen":
        options.enforceFrozenBaseline = false;
        break;
      case "--require-source":
        options.requireSource = true;
        break;
      case "--require-manifest":
        options.requireManifest = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new InputError(`未知参数：${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`用法：
  node scripts/k2-hash-check.mjs [--repo <path>] [--json]
  node scripts/k2-hash-check.mjs --self-test [--json] [--require-source]
  node scripts/k2-hash-check.mjs --prereg <prereg.json> --fixtures <fixtures.json> [--manifest <hash-manifest.json>] [--no-frozen] [--require-source] [--require-manifest]
  node scripts/k2-hash-check.mjs --emit-manifest <path>

退出码：0 全部通过；1 哈希/字段不一致（含 --require-manifest 缺 sidecar）；2 参数或文件缺失。

兼容模式（默认）：旧 v1 冻结产物没有 sidecar ⇒ M01-M13 skip，exit 0。
门禁模式（--require-manifest）：sidecar 必须存在，缺失 ⇒ M00 fail，exit 1。
显式 --manifest 指向不存在的文件属于输入错误 ⇒ exit 2（调用方指错路径，不是旧产物缺声明）。`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  if (options.selfTest) {
    return runSelfTest({ repo: nodePath.resolve(options.repo), requireSource: options.requireSource });
  }

  const repo = nodePath.resolve(options.repo);
  const preregPath = options.preregPath
    ? nodePath.resolve(options.preregPath)
    : nodePath.join(repo, FROZEN_BASELINE.preregPath);
  const fixturesPath = options.fixturesPath
    ? nodePath.resolve(options.fixturesPath)
    : nodePath.join(repo, FROZEN_BASELINE.fixturesPath);
  const manifestPath = options.manifestPath ? nodePath.resolve(options.manifestPath) : null;

  const moduleInfo = await loadK2Module(repo);
  const sourceQuestions = moduleInfo.module?.QUESTIONS ?? null;
  const buildPreregFn = moduleInfo.module?.buildPrereg ?? null;

  const result = verifyPreregArtifacts({
    preregPath,
    fixturesPath,
    manifestPath,
    sourceQuestions,
    buildPreregFn,
    enforceFrozenBaseline: options.enforceFrozenBaseline,
    requireSource: options.requireSource,
    requireManifest: options.requireManifest,
  });

  let emittedPath = null;
  if (options.emitManifest) {
    const emitPath = nodePath.resolve(options.emitManifest);
    if (nodeFs.existsSync(emitPath)) throw new InputError(`拒绝覆盖已存在文件：${emitPath}`);
    if (!result.ok) {
      console.error("✗ 拒绝为未通过校验的产物对生成 sidecar（先修好哈希/字段）");
    } else {
      nodeFs.mkdirSync(nodePath.dirname(emitPath), { recursive: true });
      writeJsonFile(emitPath, result.suggestedManifest);
      emittedPath = emitPath;
      if (!options.json) console.log(`wrote ${emitPath}`);
    }
  }

  const payload = {
    schema: "ax03-hash-check-v1",
    generatedAt: new Date().toISOString(),
    subject: {
      repo,
      repoHead: repoHead(repo),
      preregPath,
      fixturesPath,
      manifestPath,
      sourceModule: moduleInfo.modulePath,
      sourceModuleLoaded: Boolean(moduleInfo.module),
      sourceModuleError: moduleInfo.error,
      requireSource: options.requireSource,
      requireManifest: options.requireManifest,
      emittedManifest: emittedPath,
    },
    verdict: result.verdict,
    ok: result.ok,
    hashSemantics: {
      fixtureField: "fixtures.preregSha256",
      declaredSemantics: "canonical-json-sha256",
      forbiddenComparison: "raw-bytes-sha256(prereg.json)",
      manifestSchema: HASH_MANIFEST_SCHEMA,
    },
    digests: result.digests,
    checks: result.checks,
    summary: result.summary,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printHumanResult(result, { repo, repoHeadValue: payload.subject.repoHead, moduleInfo });
    if (emittedPath) console.log(`manifest: ${emittedPath}`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof InputError) {
        console.error(`✗ ${error.message}`);
        process.exitCode = 2;
      } else {
        console.error(String(error?.stack ?? error));
        process.exitCode = 1;
      }
    });
}