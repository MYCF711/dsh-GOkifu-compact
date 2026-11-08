/**
 * k2-normalize-v2.test.mjs —— K-2 normalize-v2 的冻结判据（P08 前置件）
 *
 * 这批用例钉住四件事：
 *   ① 实现的规则与预注册**逐字**一致（规则文案漂移 = 换了口径，必须红）；
 *   ② 21 条冻结向量 21/21（13 格式正例必须变对、8 语义负例必须保持错）；
 *   ③ T7 的 20 个 raw 用 **v1** 复算 20/20 与 `k2-result.json` 逐字一致（证明这次实现没碰 v1）；
 *   ④ v2 只作离线第二列：只让格式假阴性变对，不制造回归、不改 UNKNOWN 计数、gate6 仍 false。
 *
 * 本机没有私有向量（`tmp/` 不进 git）或没有 T7 官方历史时，相关用例**显式 skip**（不是静默通过）——
 * 与「干净 runner 上没有宿主 asar ⇒ C84 显式 skip」同一约定；有输入时任何不一致都必须红。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_TRANSFORMATIONS,
  FORBIDDEN_TRANSFORMATIONS,
  K2_V2_PREREG_SCHEMA,
  K2_V2_VERSION,
  ORDER_OF_OPERATIONS,
  gradeWithV2,
  normalizeAnswerV2,
  splitList,
  stripOneWrapper,
} from "../scripts/k2-normalize-v2.mjs";
import {
  EXPECTED,
  buildReport,
  discoverArtifacts,
  gate6Of,
  replayT7,
  runVectors,
  sha256File,
  sha256Vectors,
} from "../scripts/k2-v2-offline-replay.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/** 冻结工具的哈希（公开预注册里写死的值；实现变了这两行必须一起改 —— 那才是显式动作）。 */
const FROZEN_READER_SHA256 = "ea6512a00ce1f16585b198dc2322b13e6bf9813db5cf45c6a596c35d2e38e805";
const FROZEN_GRADER_SHA256 = "d8eaf62e1911a09021e825a85940db8a24676463232f9f20b486b6503511bee1";
/** 21 向量集的冻结哈希（预注册 testVectors.sha256）。 */
const FROZEN_VECTOR_SET_SHA256 = "e7ed12de8d9fd78e959ef0dc4027d2228dd8d3f94ef088c92419ee958b63c46a";

let artifactCache = null;
function artifacts() {
  if (artifactCache === null) artifactCache = discoverArtifacts();
  return artifactCache;
}

function readJson(file) {
  return JSON.parse(nodeFs.readFileSync(file, "utf8"));
}

function publicPrereg() {
  const path = artifacts().publicPrereg;
  return path ? readJson(path) : null;
}

function privatePrereg() {
  const path = artifacts().privatePrereg;
  return path ? readJson(path) : null;
}

/** 递归列出 `src/` 下的 .mjs / .js（产品侧）。 */
function listProductSources(dir = nodePath.join(ROOT, "src"), acc = []) {
  for (const name of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, name.name);
    if (name.isDirectory()) listProductSources(full, acc);
    else if (name.name.endsWith(".mjs") || name.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

export const tests = {};

tests["K2V2-0 v2 实现的规则文案与预注册逐字一致（口径漂移即红）"] = (t) => {
  const prereg = publicPrereg();
  if (prereg === null) {
    t.skip("本机没有公开预注册 evidence/k2-normalize-v2-prereg.json（脱离 GOkifu 私有工作树时正常）");
    return;
  }
  t.eq(K2_V2_VERSION, "k2-normalize-v2", "版本名冻结");
  t.eq(K2_V2_PREREG_SCHEMA, prereg.schema, "schema 必须与预注册一致");
  t.eq(prereg.status, "FROZEN", "预注册必须仍是 FROZEN（本实现不许回头改它）");
  t.eq(prereg.adoption, "NOT_ADOPTED", "v2 未采用：official 列仍是 raw");
  t.eq(prereg.officialK2.gate6, false, "公开预注册记录的 gate6 必须是 false");
  t.eq(ORDER_OF_OPERATIONS, prereg.rules.orderOfOperations, "7 步顺序必须逐字一致");
  t.eq(ALLOWED_TRANSFORMATIONS, prereg.rules.allowedTransformations, "允许变换逐字一致");
  t.eq(FORBIDDEN_TRANSFORMATIONS, prereg.rules.forbiddenTransformations, "禁止变换逐字一致");
  t.eq(prereg.testVectors.count, 21, "向量条数 21");
  t.eq(prereg.testVectors.valuesPublished, false, "公开预注册不许发布向量取值");
};

tests["K2V2-1 21 条冻结向量：格式正例必须变对、语义负例必须保持错（21/21）"] = (t) => {
  const prereg = privatePrereg();
  if (prereg === null) {
    t.skip("本机没有私有 21 向量预注册（tmp/gold-quality-next/k2/prereg.json，tmp/ 不进 git）");
    return;
  }
  const vectors = prereg?.testVectors?.vectors ?? [];
  t.eq(vectors.length, EXPECTED.vectorCount, "向量条数必须是 21");
  t.eq(sha256Vectors(vectors), FROZEN_VECTOR_SET_SHA256, "向量集 sha256 必须等于预注册冻结值");
  const publicOne = publicPrereg();
  if (publicOne) t.eq(publicOne.hashes.testVectorSetSha256, FROZEN_VECTOR_SET_SHA256, "公开预注册声明的向量哈希必须一致");
  const run = runVectors(prereg);
  t.eq(run.matched, EXPECTED.vectorCount, `必须 21/21；未过：${JSON.stringify(run.rows.filter((row) => !row.ok))}`);
  t.eq(run.byCategory["format-positive"], EXPECTED.formatPositive, "13 条格式正例");
  t.eq(run.byCategory["semantic-negative"], EXPECTED.semanticNegative, "8 条语义负例");
  const negatives = run.rows.filter((row) => row.category === "semantic-negative");
  t.eq(negatives.every((row) => row.actualCorrect === false), true, "语义负例一条都不许变对（翻译/大小写/别名/重排/缺元素/多元素/弃答）");
  const positives = run.rows.filter((row) => row.category === "format-positive");
  t.eq(positives.every((row) => row.actualCorrect === true), true, "格式正例必须全部变对");
};

tests["K2V2-2 T7 的 20 个 raw 用 v1 复算 20/20 与 k2-result.json 逐字一致"] = (t) => {
  const { rawDir, result } = artifacts();
  if (!rawDir || !result) {
    t.skip("本机没有 T7 官方历史（tmp/gold-quality-2026-11-08/quality/…，tmp/ 不进 git）");
    return;
  }
  const replay = replayT7({ rawDir, resultPath: result });
  t.eq(replay.rawFiles, EXPECTED.rawFiles, "20 个 raw 文件");
  t.eq(replay.httpStatusOk, EXPECTED.rawFiles, "20/20 httpStatus=200");
  t.eq(replay.problems, [], "复算期间不许有缺失项 / 非 200 / reader error");
  t.eq(replay.v1Replay.answerMatched, EXPECTED.rawFiles, "v1 answer 20/20");
  t.eq(replay.v1Replay.gradeMatched, EXPECTED.rawFiles, "v1 grade 20/20（correct/code/message 三项）");
  t.eq(replay.v1Replay.rawMatched, EXPECTED.rawFiles, "v1 raw 原文 20/20");
  t.eq(replay.v1Replay.exact, EXPECTED.rawFiles, "answer+grade+raw 同时一致 20/20");
  t.eq(replay.v1.fullCorrect, EXPECTED.v1FullCorrect, "v1 full 7/10（official 列）");
  t.eq(replay.v1.compactCorrect, EXPECTED.v1CompactCorrect, "v1 compact 8/10（official 列）");
  t.eq(replay.v1.degraded, ["K2-N3"], "v1 退化行恰好 K2-N3");
  t.eq(replay.v1.unknownIncrease, EXPECTED.unknownIncrease, "v1 UNKNOWN 增量 1");
  t.eq(replay.readOnly.identical, true, "复算前后 raw 清单与 k2-result.json 哈希必须一字不差（只读）");
};

tests["K2V2-3 v2 第二列只改格式假阴性：compact 8→9、degraded 1→0、无回归"] = (t) => {
  const { rawDir, result } = artifacts();
  if (!rawDir || !result) {
    t.skip("本机没有 T7 官方历史，无法做第二列复算");
    return;
  }
  const replay = replayT7({ rawDir, resultPath: result });
  t.eq(replay.v2.fullCorrect, EXPECTED.v2FullCorrect, "v2 full 必须仍是 7/10（不许凭空多对）");
  t.eq(replay.v2.compactCorrect, EXPECTED.v2CompactCorrect, "v2 compact 9/10");
  t.eq(replay.v2.degraded, [], "v2 不许再有退化行");
  t.eq(replay.regressionRows, [], "v1 对而 v2 错的行必须是 0（回归即红）");
  t.eq(replay.gainedRows.length, 1, "只允许 1 行从错变对");
  t.eq(replay.gainedRows[0].id, EXPECTED.changedRowId, "变对的行必须是 K2-N3（有序列表引号格式）");
  t.eq(replay.gainedRows[0].arm, EXPECTED.changedRowArm, "变对的臂必须是 compact");
  t.eq(replay.changedRows, [
    { id: EXPECTED.changedRowId, arm: EXPECTED.changedRowArm, category: EXPECTED.changedRowCategory, fromCode: "ordered-mismatch", toCode: "ok" },
  ], "改动行只有这一条，类别 = ordered-list-quote-format");
  t.eq(replay.acceptedAnswersStable, true, "v1 已判对的行的归一化值必须完全不变（v2 不许改写已接受的答案）");
  t.eq(replay.v2.unknownIncrease, replay.v1.unknownIncrease, "UNKNOWN 计数必须与 v1 相同（不许靠多弃答换少错）");
};

tests["K2V2-4 gate6 仍 false：summarizeStatus 不是 K-2 的门"] = (t) => {
  const { rawDir, result } = artifacts();
  if (!rawDir || !result) {
    t.skip("本机没有 T7 官方历史，无法算 gate6");
    return;
  }
  const replay = replayT7({ rawDir, resultPath: result });
  const gate = gate6Of({ replay });
  t.eq(gate.gate6, false, "gate6 必须 false（unknownIncrease 仍是 1）");
  t.eq(gate.abstentionClean, false, "abstentionClean 必须 false");
  t.eq(gate.reasons.some((reason) => reason.includes("unknownIncrease=1")), true, "理由必须点名 UNKNOWN 增量");
  t.eq(gate.answerPresentCoverage.full, 10, "answerPresentCoverage.full 10/10");
  t.eq(gate.answerPresentCoverage.compact, 10, "answerPresentCoverage.compact 10/10");
  // 对照：v2 的退化清单空了 ⇒ summarize.status 会变成 PASS，但那不是 gate6。
  t.eq(replay.v2.degraded.length === 0, true, "v2 退化清单为空（summarize 会 PASS）");
  t.eq(gate.gate6, false, "……所以这条对照说明 status 不能当门用");
  const prereg = publicPrereg();
  if (prereg) {
    t.eq(prereg.reportingContract.summarizeStatusIsNotGate, true, "预注册必须声明 summarizeStatusIsNotGate");
    t.eq(prereg.reportingContract.cannotRetroactivelyChangeT7, true, "预注册必须声明不能回改 T7");
    t.includes(String(prereg.offlineReplay?.summarizeStatusWarning ?? ""), "NOT the K-2 gate", "预注册必须写明 summarize.status 不是 K-2 的门");
  }
};

tests["K2V2-5 v1 归一化/判分与产品码未被改动：v2 只在离线脚本层"] = (t) => {
  t.eq(sha256File(nodePath.join(ROOT, "scripts", "k2-value-reader.mjs")), FROZEN_READER_SHA256, "v1 normalizeAnswer 所在的 reader 脚本必须逐字节未变");
  t.eq(sha256File(nodePath.join(ROOT, "scripts", "lme-task50.mjs")), FROZEN_GRADER_SHA256, "gradeAnswer 所在的判分脚本必须逐字节未变");
  const prereg = publicPrereg();
  if (prereg) {
    t.eq(prereg.hashes.readerScriptSha256, FROZEN_READER_SHA256, "预注册声明的 reader 哈希一致");
    t.eq(prereg.hashes.graderScriptSha256, FROZEN_GRADER_SHA256, "预注册声明的 grader 哈希一致");
  }
  const sources = listProductSources();
  t.eq(sources.length >= 10, true, `必须扫到足够多的产品源码（实际 ${sources.length}）`);
  const offenders = sources.filter((file) => nodeFs.readFileSync(file, "utf8").includes("k2-normalize-v2"));
  t.eq(offenders.map((file) => nodePath.relative(ROOT, file)), [], "产品源码（src/）里不许引用 k2-normalize-v2 —— 它默认关闭、只作离线第二列");
};

tests["K2V2-6 禁止变换一律不做：翻译/大小写/别名/重排/去重/丢元素都不许发生"] = (t) => {
  t.eq(normalizeAnswerV2("Created File"), "Created File", "大小写折叠禁止");
  t.eq(normalizeAnswerV2("已创建文件"), "已创建文件", "翻译/转写禁止");
  t.eq(normalizeAnswerV2("Created file（已创建）"), "Created file（已创建）", "附加解释不许被削掉");
  t.eq(normalizeAnswerV2("ACK, NAK"), "ACK, NAK", "列表元素的大小写原样保留");
  t.eq(normalizeAnswerV2("a, a, b", { grader: "ordered" }), "a, a, b", "ordered 禁止去重");
  t.eq(normalizeAnswerV2("b, a", { grader: "ordered" }), "b, a", "ordered 禁止重排（排序是判分器的事，不是归一化的事）");
  t.eq(gradeWithV2(["a", "b"], "b, a", "ordered").grade.correct, false, "重排后 ordered 必须判错");
  t.eq(gradeWithV2(["a", "b"], "a, a, b", "ordered").grade.correct, false, "多出来的重复元素也算多元素");
  t.eq(gradeWithV2(["a", "b"], "b, a", "set").grade.correct, true, "set 本身与顺序无关（归一化不替它排序）");
  t.eq(gradeWithV2(["a", "b", "c"], "'a', 'b'", "ordered").grade.correct, false, "缺元素仍必须错");
  t.eq(gradeWithV2("Created file", "`Created  file`", "exact").grade.correct, true, "一层反引号 + 既有空白折叠仍接受（v1 行为不许退化）");
  t.eq(gradeWithV2("UNKNOWN", "unknown", "UNKNOWN").grade.correct, false, "小写 unknown 不是弃答");
  t.eq(gradeWithV2("UNKNOWN", "`UNKNOWN`", "UNKNOWN").grade.correct, true, "一层反引号包裹的 UNKNOWN 仍被接受");
  // 结构断言：一层剥、可重复、按分隔符拆
  t.eq(stripOneWrapper("\"a'b\""), "a'b", "整串包裹只在没有同种引号时剥");
  t.eq(stripOneWrapper("'a', 'b'"), "'a', 'b'", "内层含同种引号 ⇒ 整串原样（v1 的假阴性源头，v2 必须不剥）");
  t.eq(splitList("[ 'a', 'b' ]"), [" 'a'", " 'b' "], "伪数组剥一层 [] 后再拆");
  t.eq(splitList('["a","b"]'), ["a", "b"], "合法 JSON 数组直接用");
  t.eq(splitList("a；b，c"), ["a", "b", "c"], "中文分号/逗号都是分隔符");
  const prereg = privatePrereg();
  if (prereg === null) {
    t.eq(true, true, "没有私有向量：幂等检查跳过（上面的探针已经是独立判据）");
    return;
  }
  const notIdempotent = (prereg.testVectors.vectors ?? []).filter((vector) => {
    const once = normalizeAnswerV2(vector.actual, { grader: vector.grader });
    const twice = normalizeAnswerV2(once, { grader: vector.grader });
    return once !== twice;
  });
  t.eq(notIdempotent.map((vector) => vector.id), [], "21 条向量上 v2 必须幂等（重复归一化不改变结果）");
};

tests["K2V2-7 零模型调用：v2 模块与复算脚本都不含网络/模型客户端"] = (t) => {
  const moduleSrc = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "k2-normalize-v2.mjs"), "utf8");
  const replaySrc = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "k2-v2-offline-replay.mjs"), "utf8");
  for (const [label, src] of [["k2-normalize-v2.mjs", moduleSrc], ["k2-v2-offline-replay.mjs", replaySrc]]) {
    t.eq(/https?:\/\//.test(src), false, `${label} 里不许出现任何 URL（零网络）`);
    t.eq(/chat\/completions|completions\s*\(|api[_-]?key/i.test(src), false, `${label} 里不许出现模型调用面`);
    t.eq(/\bfetch\s*\(/.test(src), false, `${label} 里不许 fetch`);
    t.eq(/@deepseek-ai\//.test(src), false, `${label} 不许 import 宿主 LLM 包`);
  }
  t.includes(moduleSrc, 'from "./lme-task50.mjs"', "v2 只能复用未改动的 gradeAnswer（import 而不是复制）");
  t.eq(new RegExp(`import\\s+[^;]*from\\s+["']\\.\\./`).test(moduleSrc), false, "v2 模块不得依赖 src/ 产品码");
};

tests["K2V2-8 端到端：P08 八项判据全绿且写死指标逐项相等"] = (t) => {
  const artifactsFound = artifacts();
  const required = ["publicPrereg", "privatePrereg", "rawDir", "result"];
  const missing = required.filter((key) => !artifactsFound[key]);
  if (missing.length > 0) {
    t.skip(`缺输入 ${missing.join(",")}（干净 runner 上没有 GOkifu 私有 tmp/ 时正常）`);
    return;
  }
  const report = buildReport(artifactsFound);
  t.eq(report.ok, true, `P08 必须全绿；不成立项：${JSON.stringify(report.checks.filter((item) => !item.ok))}`);
  t.eq(report.status, "PASS", "报告状态 PASS");
  t.eq(report.checks.length, 8, "八项判据一项不少");
  t.eq(report.checks.map((item) => item.id), ["P08-A-vectors-21", "P08-B-v1-replay-20", "P08-C-v2-format-only", "P08-D-metrics", "P08-E-gate6-false", "P08-F-frozen-inputs", "P08-G-rules-verbatim", "P08-H-history-readonly"], "判据 id 顺序固定");
  t.eq(report.gate.gate6, false, "端到端也算出 gate6=false");
  t.eq(report.modelCalls, 0, "模型调用 0");
  t.eq(report.officialColumn, "raw", "official 列仍是 raw（v2 只是第二列）");
  t.eq(report.frozen.ok, true, "冻结输入哈希全部一致");
};