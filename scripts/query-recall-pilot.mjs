#!/usr/bin/env node
/**
 * query-recall-pilot.mjs —— Q1 查询召回 Stage B runner（离线计划 / 真实 --run 两用）
 *
 * 预注册：`evidence/query-recall-prereg-v1.json`（experimentId = q1-query-recall-stage-b-1）
 *   20 题 × 2 臂（A0 基线 / A1 基线 + 召回块）× 3 样本 = **120 次硬上限**，0 重试，严格串行。
 *
 * 这个 runner 的存在意义只有一个：**让「召回块有没有帮到读者」这件事可被证伪**。
 * 所以它自己不做任何判断性的事 ——
 *   · 不生成 prompt（逐字复用冻结 reader 的 `buildMessages`）；
 *   · 不改 temperature / max_tokens（镜像冻结 reader 的 `callChat`，并由测试对源码逐字对账）；
 *   · 不改归一化（复用冻结 reader 的 `normalizeReaderAnswer` / `postProcessAnswer`）；
 *   · 不改判分（复用冻结 grader 的 `gradeAnswer`）；
 *   · 不放宽任何门槛（所有阈值逐条取自预注册；不满足即 NOT_ADOPTED）。
 *
 * 默认（无参数）是 **dry-run**：只展开 120 个请求计划、核对两臂同题同参数、预算与冻结 sha，
 * **一个网络请求都不发**（连 transport 都不构造）。只有同时给出
 *   `--run --authorize q1-query-recall-stage-b-1`
 * 才允许真实调用，且仍要求 Stage A PASS、声明真实最大图 p95（≤25ms，预注册 stageGate.perf）、
 * 显式 `LME_READER_MODEL` / `LME_READER_ENDPOINT`（本文件不写死模型 id，也不写死 endpoint）。
 *
 * 为什么不用 `lme-pilot-reader.mjs` 的 CLI 子进程（它是 reader 的唯一口径，但导出面不够）：
 *   ① 它只导出 `runPilot`，而 `runPilot` 的选择规则是「五类各前 2 题 = 10 题 × 2 臂」，
 *      与这里固定的 20 题顺序（B-01…B-20，每题先 A0×3 再 A1×3）不是同一个形状；
 *   ② 它只保留**被选中样本**的 raw，逐样本 raw / usage / 延迟会被它自己合并掉，
 *      而预注册要求逐样本记录（results 文件）；
 *   ③ 它的 `callChat` 没有导出，无法单次调用。
 *   因此这里复用它的**导出函数**（prompt / 归一化 / 事后处理），HTTP 传输按冻结源码镜像，
 *   并用测试 `test/query-recall-pilot.test.mjs` 对 `scripts/lme-pilot-reader.mjs` 源码做
 *   **逐字对账**（temperature 0 / max_tokens 2048 / stream false / 120s 超时 / variant 默认 v1 /
 *   postprocess 默认 none）—— 冻结脚本一改口径，这里立刻红。
 *
 * 用法：
 *   node scripts/query-recall-pilot.mjs                     # dry-run（默认；0 网络）
 *   node scripts/query-recall-pilot.mjs --run \
 *        --authorize q1-query-recall-stage-b-1 \
 *        --stage-a-p95 18.561                                # 真实运行（120 次，需 Lead 当轮授权）
 *   可选：--repo <dir>（测试用根目录；默认仓库根）· --overwrite（覆盖已存在的结果文件）
 *
 * 输出（只有真实 --run 才写，dry-run 不写任何文件）：
 *   evidence/query-recall-pilot.results.json  逐题逐样本（raw / normalized / 判定 / usage / 延迟 / 多数票）
 *   evidence/query-recall-pilot-public.json   公开聚合（无 raw、无 endpoint、无路径、无会话 id）
 *
 * 数据边界：题面 / 上下文 / 答案全部来自预注册 + 纯合成夹具（Stage A fixtures）；
 * 本 runner 不读任何真实会话、真实图或私有数据。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { renderQueryRecall } from "../src/rooms/query-recall.mjs";
import { buildMessages, normalizeReaderAnswer, postProcessAnswer } from "./lme-pilot-reader.mjs";
import { gradeAnswer } from "./lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/** 仓库根（测试可用 --repo 改根；只影响输入 JSON 与输出路径，不影响被 import 的实现）。 */
export const REPO = nodePath.resolve(HERE, "..");

/** 退出码（测试与文档共用一份）。 */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, PRECONDITION: 3 });

/** 真实运行的一次性授权口令（= 预注册 experimentId；两处必须同时相等）。 */
export const AUTHORIZE_TOKEN = "q1-query-recall-stage-b-1";

/** 预注册的硬上限与样本数 —— 不是「计划」，是天花板。 */
export const MAX_CALLS = 120;
export const SAMPLES_PER_ARM = 3;
export const ARMS = Object.freeze(["A0", "A1"]);

/** 输入 / 输出路径（仓库相对；公开面与私有面分开）。 */
export const PATHS = Object.freeze({
  prereg: "evidence/query-recall-prereg-v1.json",
  fixtures: "evidence/query-recall-stage-a.fixtures.json",
  stageAScript: "scripts/query-recall-stage-a.mjs",
  stageATest: "test/query-recall-stage-a.test.mjs",
  reader: "scripts/lme-pilot-reader.mjs",
  grader: "scripts/lme-task50.mjs",
  impl: "src/rooms/query-recall.mjs",
  stageAEvidence: "evidence/query-recall-stage-a.json",
  stageAPerf: "evidence/query-recall-stage-a-perf.json",
  results: "evidence/query-recall-pilot.results.json",
  public: "evidence/query-recall-pilot-public.json",
});

/**
 * 冻结 reader 的请求口径（镜像，不是重写）。测试会解析
 * `scripts/lme-pilot-reader.mjs` 源码逐字对账，任何一处漂移立刻红。
 */
export const TRANSPORT_SPEC = Object.freeze({ temperature: 0, maxTokens: 2048, stream: false, timeoutMs: 120_000 });

/** 冻结 reader 的其它默认值（同样由测试对账）。 */
export const READER_DEFAULTS = Object.freeze({ variant: "v1", postprocess: "none" });

/**
 * 请求口径对账：`TRANSPORT_SPEC` / `READER_DEFAULTS` 只是**声明的期望值**，必须与冻结 reader 源码逐字相等。
 * 真实运行前会调用它 —— 冻结 reader 的 temperature / max_tokens / stream / 超时 / variant / postprocess
 * 只要有一处与声明不同，就直接拒绝（不静默跟随、也不静默复制）。
 */
export function checkFrozenTransport({ repo = REPO, file = PATHS.reader } = {}) {
  let source;
  try {
    source = nodeFs.readFileSync(repoPath(repo, file), "utf8");
  } catch {
    return { ok: false, checks: [], errors: [`冻结 reader 缺失或不可读：${file}`], file };
  }
  const num = (pattern) => {
    const match = pattern.exec(source);
    return match === null ? null : Number(match[1].replace(/_/g, ""));
  };
  const text = (pattern) => {
    const match = pattern.exec(source);
    return match === null ? null : match[1];
  };
  const stream = text(/stream:\s*(true|false)/);
  const checks = [
    { name: "temperature", expected: TRANSPORT_SPEC.temperature, actual: num(/temperature:\s*(-?\d+(?:\.\d+)?)/) },
    { name: "maxTokens", expected: TRANSPORT_SPEC.maxTokens, actual: num(/max_tokens:\s*(\d+)/) },
    { name: "stream", expected: TRANSPORT_SPEC.stream, actual: stream === null ? null : stream === "true" },
    { name: "timeoutMs", expected: TRANSPORT_SPEC.timeoutMs, actual: num(/AbortSignal\.timeout\(\s*([\d_]+)\s*\)/) },
    { name: "variant", expected: READER_DEFAULTS.variant, actual: text(/LME_READER_VARIANT\s*\|\|\s*"([^"]+)"/) },
    { name: "postprocess", expected: READER_DEFAULTS.postprocess, actual: text(/LME_READER_POSTPROCESS\s*\|\|\s*"([^"]+)"/) },
  ].map((check) => ({ ...check, ok: check.actual !== null && check.actual === check.expected }));
  const errors = checks
    .filter((check) => !check.ok)
    .map((check) => `请求口径漂移：${check.name} 声明=${JSON.stringify(check.expected)} 冻结源码=${JSON.stringify(check.actual)}（${file}）`);
  return { ok: errors.length === 0, checks, errors, file };
}

/** 预注册要求的五条冻结输入（key → 仓库相对路径）。 */
const FROZEN_FILES = Object.freeze({
  stageAFixtures: PATHS.fixtures,
  stageAScript: PATHS.stageAScript,
  stageATest: PATHS.stageATest,
  reader: PATHS.reader,
  grader: PATHS.grader,
  // M-4：Lead 稍后在预注册 `frozenInputs` 里补这两个键；未登记时闸门不启用（不算过，也不算不过，
  // 输出里标 NOT_REGISTERED），一旦登记就必须逐字匹配 —— 不允许「没登记 = 免检」被当成默认。
  impl: PATHS.impl,
  stageAEvidenceSha256: PATHS.stageAEvidence,
});

/** 预注册里**必须**已登记的冻结键（缺 = 预注册不完整，直接拒绝）。 */
const REQUIRED_FROZEN_KEYS = Object.freeze(["stageAFixtures", "stageAScript", "stageATest", "reader", "grader"]);

/** 判定为 UNKNOWN 的归一化答案（预注册 grading.unknown）。 */
export const UNKNOWN_ANSWERS = Object.freeze(["unknown", "无法确定", "不知道"]);

/**
 * M-5：本实验的 20 题合成集**最高只能 POSITIVE_SIGNAL**，绝不 ADOPT。
 * 理由：题面里的 12 道「召回题」是 base 答案 + 召回块的直接答案 —— 它证明的是
 * 「读者会读召回块」，不是「真实工作里召回块带来收益」。真实收益只能由真实会话的
 * 端到端实验回答，不能由这套合成题回答。
 */
export const DECISION_CAP = "POSITIVE_SIGNAL";
export const DECISION_CAP_REASON =
  "决策上限：20 题合成集的题面 = base 答案 + 召回块直接答案，只能证明读者会读块，不能证明真实工作收益 ⇒ 最高 POSITIVE_SIGNAL，绝不 ADOPT";

/* ───────────────────────────── 小工具 ───────────────────────────── */

export const sha256File = (file) => nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex");
const shortSha = (value) => (typeof value === "string" && value.length > 12 ? `${value.slice(0, 12)}…` : String(value ?? "null"));
export const charLength = (text) => Array.from(String(text ?? "")).length;
const round = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const nowIso = () => new Date().toISOString();
const repoPath = (repo, relative) => nodePath.join(repo, ...String(relative).split("/"));
const relPath = (repo, absolute) => nodePath.relative(repo, absolute).split(nodePath.sep).join("/");

/** 排序后取分位（最近秩，与 Stage A 的 `percentile` 同口径；样本不足取最大）。 */
export function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[rank];
}

/** 读 JSON；缺失/坏 JSON 返回 null（由调用方给出人类可读的错误，不抛栈）。 */
export function readJsonFile(file) {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 按 `a.b.c` 取值；缺失返回 undefined。 */
function readPath(value, dotted) {
  let cursor = value;
  for (const key of String(dotted ?? "").split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * 预算闸：120 是硬上限，第 121 次 `take()` **直接抛**（在 transport 之前），
 * 所以「第 121 个调用」在结构上不存在。
 */
export function createBudget(cap = MAX_CALLS) {
  if (!Number.isInteger(cap) || cap <= 0) throw new Error(`budget cap must be a positive integer; got ${cap}`);
  if (cap > MAX_CALLS) throw new Error(`budget cap must not exceed the preregistered hard cap ${MAX_CALLS}; got ${cap}`);
  let used = 0;
  return {
    cap,
    get used() {
      return used;
    },
    take(label = "") {
      if (used >= cap) {
        const error = new Error(`budget exceeded: ${cap} calls are the hard cap, the ${used + 1}st call does not exist (${label})`);
        error.code = "BUDGET_EXCEEDED";
        throw error;
      }
      used += 1;
      return used;
    },
  };
}

/* ─────────────────────── 冻结输入 / Stage A 闸门 ─────────────────────── */

/**
 * 冻结 sha 对账：预注册 `frozenInputs` ↔ 实际文件字节，并检查预注册**内部自洽**
 * （stageGate / design 里写的 sha 必须与 frozenInputs 一致；篡改一处就红）。
 */
export function checkFrozenInputs({ repo = REPO, prereg } = {}) {
  const checks = [];
  const errors = [];
  const frozen = prereg?.frozenInputs;
  if (frozen === null || typeof frozen !== "object") {
    return { ok: false, checks, errors: ["预注册缺少 frozenInputs：无法核对冻结输入"] };
  }
  for (const [key, file] of Object.entries(FROZEN_FILES)) {
    const absolute = repoPath(repo, file);
    const raw = frozen[key];
    const registered = typeof raw === "string" && raw.trim() !== "";
    const expected = registered ? raw : null;
    const actual = nodeFs.existsSync(absolute) ? sha256File(absolute) : null;
    if (!registered) {
      // 新键（impl / stageAEvidenceSha256）尚未登记：不算过、也不算不过 —— 标 NOT_REGISTERED 并在输出里显形。
      if (REQUIRED_FROZEN_KEYS.includes(key)) {
        errors.push(`预注册 frozenInputs.${key} 缺失（这是必须登记的老键）`);
        checks.push({ key, file, expected: null, actual, ok: false, registered: false });
      } else {
        checks.push({ key, file, expected: null, actual, ok: true, registered: false });
      }
      continue;
    }
    const ok = actual !== null && actual === expected;
    checks.push({ key, file, expected, actual, ok, registered: true });
    if (!ok) {
      errors.push(
        actual === null
          ? `冻结输入缺失：${key}（${file}）`
          : `冻结输入不匹配：${key}（${file}）expected=${shortSha(expected)} actual=${shortSha(actual)}`,
      );
    }
  }
  const cross = [
    ["stageGate.stageA.fixture.sha256", readPath(prereg, "stageGate.stageA.fixture.sha256"), "stageAFixtures"],
    ["stageGate.stageA.script.sha256", readPath(prereg, "stageGate.stageA.script.sha256"), "stageAScript"],
    ["design.frozenReader.sha256", readPath(prereg, "design.frozenReader.sha256"), "reader"],
    ["design.grader.sha256", readPath(prereg, "design.grader.sha256"), "grader"],
  ];
  for (const [label, declared, key] of cross) {
    if (declared === undefined) continue;
    if (declared !== frozen[key]) {
      errors.push(`预注册内部不一致：${label}=${shortSha(declared)} ≠ frozenInputs.${key}=${shortSha(frozen[key])}`);
    }
  }
  const pathCross = [
    ["stageGate.stageA.fixture.path", readPath(prereg, "stageGate.stageA.fixture.path"), PATHS.fixtures],
    ["stageGate.stageA.script.path", readPath(prereg, "stageGate.stageA.script.path"), PATHS.stageAScript],
    ["design.frozenReader.path", readPath(prereg, "design.frozenReader.path"), PATHS.reader],
    ["design.grader.path", readPath(prereg, "design.grader.path"), PATHS.grader],
  ];
  for (const [label, declared, expectedPath] of pathCross) {
    if (declared === undefined) continue;
    if (String(declared).replace(/\\/g, "/") !== expectedPath) {
      errors.push(`预注册声明的路径与 runner 约定不一致：${label}=${String(declared)} ≠ ${expectedPath}`);
    }
  }
  const unregistered = checks.filter((check) => !check.registered).map((check) => check.key);
  return { ok: errors.length === 0, checks, errors, unregistered };
}

/** 把预注册 `required` 里的 `"a.b == c"` 字符串解析成实检；解析不了的算失败（不跳过）。 */
function checkRequired(evidence, required) {
  const items = [];
  for (const spec of Array.isArray(required) ? required : []) {
    const match = /^([A-Za-z0-9_.]+)\s*==\s*(.+)$/.exec(String(spec).trim());
    if (match === null) {
      items.push({ spec: String(spec), path: null, expected: null, actual: null, ok: false });
      continue;
    }
    const path = match[1];
    const expectedText = match[2].trim();
    const actual = readPath(evidence, path);
    let ok;
    if (expectedText === "true" || expectedText === "false") ok = String(actual) === expectedText;
    else if (expectedText !== "" && Number.isFinite(Number(expectedText))) ok = Number(actual) === Number(expectedText);
    else ok = String(actual) === expectedText.replace(/^["']|["']$/g, "");
    items.push({ spec: String(spec), path, expected: expectedText, actual: actual === undefined ? null : actual, ok });
  }
  return items;
}

/**
 * Stage A 闸门：证据文件必须存在、status == PASS、预注册 required 全部成立、
 * 且证据里的夹具 sha 与冻结值一致。**任何一条不成立 ⇒ 调用方必须在构造 transport 之前退出。**
 */
export function checkStageA({ repo = REPO, prereg } = {}) {
  const gate = prereg?.stageGate?.stageA;
  if (gate === null || typeof gate !== "object") {
    return { ok: false, status: "NO_GATE", file: null, errors: ["预注册缺少 stageGate.stageA"] };
  }
  const declaredFile = typeof gate.evidenceFile === "string" ? gate.evidenceFile : PATHS.stageAEvidence;
  const absolute = repoPath(repo, declaredFile);
  const result = { ok: false, status: "MISSING", file: declaredFile, command: gate.command ?? null, errors: [] };
  if (!nodeFs.existsSync(absolute)) {
    result.errors.push(`Stage A 证据缺失：${declaredFile}（先跑 ${gate.command ?? "Stage A"}）`);
    return result;
  }
  const evidence = readJsonFile(absolute);
  if (evidence === null) {
    result.status = "UNREADABLE";
    result.errors.push(`Stage A 证据无法解析：${declaredFile}`);
    return result;
  }
  const expectedFixturesSha = prereg?.frozenInputs?.stageAFixtures ?? null;
  const actualFixturesSha = nodeFs.existsSync(repoPath(repo, PATHS.fixtures)) ? sha256File(repoPath(repo, PATHS.fixtures)) : null;
  const evidenceFixturesSha = readPath(evidence, "fixtures.sha256") ?? null;
  const required = checkRequired(evidence, gate.required);
  // 防「预注册被删条」：硬性 belt checks 与 required 双保险。
  const belt = [
    { path: "status", expected: "PASS", actual: evidence.status ?? null, ok: evidence.status === "PASS" },
    { path: "aggregate.failed", expected: 0, actual: readPath(evidence, "aggregate.failed") ?? null, ok: Number(readPath(evidence, "aggregate.failed")) === 0 },
    { path: "aggregate.misses", expected: 0, actual: readPath(evidence, "aggregate.misses") ?? null, ok: Number(readPath(evidence, "aggregate.misses")) === 0 },
    {
      path: "aggregate.falsePositives",
      expected: 0,
      actual: readPath(evidence, "aggregate.falsePositives") ?? null,
      ok: Number(readPath(evidence, "aggregate.falsePositives")) === 0,
    },
    { path: "aggregate.evidence.hitRate", expected: 1, actual: readPath(evidence, "aggregate.evidence.hitRate") ?? null, ok: Number(readPath(evidence, "aggregate.evidence.hitRate")) === 1 },
    { path: "fixtures.sha256", expected: expectedFixturesSha, actual: evidenceFixturesSha, ok: expectedFixturesSha !== null && evidenceFixturesSha === expectedFixturesSha },
    { path: "fixtures(actual).sha256", expected: expectedFixturesSha, actual: actualFixturesSha, ok: expectedFixturesSha !== null && actualFixturesSha === expectedFixturesSha },
  ];
  for (const item of [...required, ...belt]) if (!item.ok) result.errors.push(`Stage A 未过：${item.path ?? item.spec}（expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}）`);
  result.status = typeof evidence.status === "string" ? evidence.status : "UNKNOWN";
  result.sha256 = sha256File(absolute);
  result.fixturesSha256 = evidenceFixturesSha;
  result.required = required;
  result.belt = belt;
  result.aggregate = {
    total: readPath(evidence, "aggregate.total") ?? null,
    passed: readPath(evidence, "aggregate.passed") ?? null,
    failed: readPath(evidence, "aggregate.failed") ?? null,
    misses: readPath(evidence, "aggregate.misses") ?? null,
    falsePositives: readPath(evidence, "aggregate.falsePositives") ?? null,
    hitRate: readPath(evidence, "aggregate.evidence.hitRate") ?? null,
    tasks: readPath(evidence, "fixtures.tasks") ?? null,
  };
  // M-4：Stage A 证据里若登记了 impl.sha256，就必须与当前实现逐字一致（未登记时标 NOT_REGISTERED）。
  const evidenceImplSha = readPath(evidence, "impl.sha256") ?? null;
  const currentImplSha = nodeFs.existsSync(repoPath(repo, PATHS.impl)) ? sha256File(repoPath(repo, PATHS.impl)) : null;
  const implCheck = {
    registered: evidenceImplSha !== null,
    declared: evidenceImplSha,
    actual: currentImplSha,
    ok: evidenceImplSha === null ? true : currentImplSha !== null && evidenceImplSha === currentImplSha,
  };
  if (!implCheck.ok) {
    result.errors.push(`Stage A 实现漂移：evidence.impl.sha256=${shortSha(evidenceImplSha)} ≠ 当前实现=${shortSha(currentImplSha)}（${PATHS.impl}）`);
  }
  result.impl = implCheck;
  result.ok = result.errors.length === 0;
  return result;
}

/**
 * M-4：Stage A 的性能证据从 `evidence/query-recall-stage-a-perf.json` 读取并校验
 * （预注册 `stageGate.perf`：`deltaError == false` 且 `renderMs.p95 <= 25`）。
 * **不接受**命令行裸声明 `--stage-a-p95`：p95 必须是可复算的落盘证据。
 */
export function checkStageAPerf({ repo = REPO, prereg = null, file = PATHS.stageAPerf } = {}) {
  const absolute = repoPath(repo, file);
  const result = {
    ok: false, file, errors: [], sha256: null, registeredSha256: null, shaOk: false,
    p95: null, renderP95: null, derivedP95: null, deltaError: null, samples: null, graphBytes: null, nodes: null, edges: null,
  };
  if (!nodeFs.existsSync(absolute)) {
    result.errors.push(`Stage A 性能证据缺失：${file}（预注册 stageGate.perf 要求 p95 ≤ 25 的可复算证据）`);
    return result;
  }
  const perf = readJsonFile(absolute);
  if (perf === null) {
    result.errors.push(`Stage A 性能证据无法解析：${file}`);
    return result;
  }
  result.sha256 = sha256File(absolute);
  result.registeredSha256 = readPath(prereg ?? {}, "stageGate.perf.sha256") ?? null;
  result.shaOk = typeof result.registeredSha256 === "string" && result.registeredSha256 === result.sha256;
  if (typeof result.registeredSha256 !== "string" || result.registeredSha256.trim() === "") {
    result.errors.push(`预注册未登记 stageGate.perf.sha256：性能证据必须按字节冻结（${file}）`);
  } else if (!result.shaOk) {
    result.errors.push(`Stage A 性能证据被改：registered=${shortSha(result.registeredSha256)} actual=${shortSha(result.sha256)}（${file}）`);
  }
  result.renderP95 = Number(readPath(perf, "bench.renderMs.p95") ?? NaN);
  result.derivedP95 = Number(readPath(perf, "bench.derivedRenderMs.p95") ?? 0);
  // 取两者最大值：派生查询（真实路径 / 符号驱动）的命中成本会被「固定 query」的 p95 掩盖，不能只看 renderMs。
  const derived = Number.isFinite(result.derivedP95) ? result.derivedP95 : 0;
  result.p95 = Math.max(Number.isFinite(result.renderP95) ? result.renderP95 : NaN, derived);
  result.deltaError = readPath(perf, "bench.deltaError") ?? null;
  result.samples = readPath(perf, "bench.samples") ?? null;
  result.graphBytes = readPath(perf, "bench.graphBytes") ?? null;
  result.nodes = readPath(perf, "bench.nodes") ?? null;
  result.edges = readPath(perf, "bench.edges") ?? null;
  const checks = [
    { name: "renderMs.p95", expected: "<=25", actual: result.renderP95, ok: Number.isFinite(result.renderP95) && result.renderP95 <= 25 },
    { name: "derivedRenderMs.p95", expected: "<=25", actual: result.derivedP95, ok: Number.isFinite(result.derivedP95) && result.derivedP95 <= 25 },
    { name: "p95(max)", expected: "<=25", actual: result.p95, ok: Number.isFinite(result.p95) && result.p95 <= 25 },
    { name: "deltaError", expected: false, actual: result.deltaError, ok: result.deltaError === false },
    { name: "perf.sha256", expected: result.registeredSha256, actual: result.sha256, ok: result.shaOk },
  ];
  result.checks = checks;
  for (const check of checks) {
    if (!check.ok && check.name !== "perf.sha256") {
      result.errors.push(`Stage A 性能未达标：${check.name}（expected ${JSON.stringify(check.expected)} actual ${JSON.stringify(check.actual)}）`);
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

/** 预注册的决策政策必须与代码一致（M-5：合成题集最高 POSITIVE_SIGNAL，饱和按可计分题）。 */
export function checkDecisionPolicy({ prereg = null, plan = null } = {}) {
  const errors = [];
  const cap = readPath(prereg ?? {}, "decisionCap") ?? null;
  const declaredScorable = readPath(prereg ?? {}, "saturation.scorableTasks") ?? null;
  const computedScorable = plan === null ? null : plan.tasks.filter((task) => String(task.gold).trim().toUpperCase() !== "UNKNOWN").length;
  if (cap !== DECISION_CAP) errors.push(`预注册 decisionCap=${JSON.stringify(cap)} ≠ 代码上限 ${JSON.stringify(DECISION_CAP)}`);
  if (declaredScorable !== computedScorable) errors.push(`预注册 saturation.scorableTasks=${JSON.stringify(declaredScorable)} ≠ 可计分题数 ${JSON.stringify(computedScorable)}`);
  return { ok: errors.length === 0, errors, decisionCap: cap, scorableTasks: computedScorable };
}

/* ───────────────────────────── 夹具与计划 ───────────────────────────── */

/** 读取并校验 Stage A 合成夹具（形状不对 ⇒ 使用错误，不是评测失败）。 */
export function loadFixtures({ repo = REPO } = {}) {
  const file = repoPath(repo, PATHS.fixtures);
  const fixtures = readJsonFile(file);
  const errors = [];
  if (fixtures === null) return { ok: false, errors: [`夹具缺失或无法解析：${PATHS.fixtures}`], fixtures: null };
  if (fixtures.schema !== "query-recall-stage-a-fixtures") errors.push(`夹具 schema 必须是 query-recall-stage-a-fixtures；实际 ${String(fixtures.schema)}`);
  if (fixtures.status !== "SYNTHETIC_ONLY") errors.push(`夹具 status 必须是 SYNTHETIC_ONLY；实际 ${String(fixtures.status)}`);
  if (fixtures.zeroModelCalls !== true) errors.push("夹具必须声明 zeroModelCalls = true");
  if (fixtures.graphs === null || typeof fixtures.graphs !== "object") errors.push("夹具缺少 graphs");
  if (!Array.isArray(fixtures.tasks)) errors.push("夹具缺少 tasks");
  return { ok: errors.length === 0, errors, fixtures };
}

/**
 * A1 = baseContext + 两个换行 + 召回块；召回块为空时**不追加任何字节**
 * （注入空块没有语义，只会让「两臂差异仅为召回块」这句话变模糊）。
 */
export function composeArmContext(baseContext, recallText) {
  return recallText === "" ? baseContext : `${baseContext}\n\n${recallText}`;
}

/**
 * 展开固定请求计划：20 题 × 2 臂 × 3 样本 = 120，顺序在第一次调用前就定死。
 * 这里同时做「两臂同题同参数」与「A1 - A0 仅为召回块」的结构核对。
 */
export function buildPlan({ repo = REPO, prereg } = {}) {
  const errors = [];
  const loaded = loadFixtures({ repo });
  if (!loaded.ok) return { ok: false, errors: loaded.errors, plan: null };
  const fixtures = loaded.fixtures;
  const design = prereg?.design;
  if (design === null || typeof design !== "object") return { ok: false, errors: ["预注册缺少 design"], plan: null };

  const tasks = design.taskSet?.tasks;
  const baseContext = design.contextBase;
  if (!Array.isArray(tasks)) return { ok: false, errors: ["预注册缺少 design.taskSet.tasks"], plan: null };
  if (typeof baseContext !== "string" || baseContext.trim() === "") return { ok: false, errors: ["预注册缺少 design.contextBase"], plan: null };

  const declaredCount = design.taskSet?.count;
  if (declaredCount !== tasks.length) errors.push(`预注册 taskSet.count=${String(declaredCount)} 与 tasks.length=${tasks.length} 不一致`);
  if (design.samplesPerArm !== SAMPLES_PER_ARM) errors.push(`预注册 samplesPerArm=${String(design.samplesPerArm)}，runner 固定 ${SAMPLES_PER_ARM}（不许自行放宽）`);
  const planned = design.plannedCalls;
  const maxCalls = design.maxCalls;
  const retries = design.retries;
  if (planned !== MAX_CALLS) errors.push(`预注册 plannedCalls=${String(planned)}，runner 固定 ${MAX_CALLS}`);
  if (maxCalls !== MAX_CALLS) errors.push(`预注册 maxCalls=${String(maxCalls)}，runner 固定 ${MAX_CALLS}`);
  if (retries !== 0) errors.push(`预注册 retries=${String(retries)}，runner 固定 0 重试`);
  if (design.budget?.hardCap !== undefined && design.budget.hardCap !== MAX_CALLS) errors.push(`预注册 budget.hardCap=${String(design.budget.hardCap)} ≠ ${MAX_CALLS}`);
  if (design.budget?.retries !== undefined && design.budget.retries !== 0) errors.push(`预注册 budget.retries=${String(design.budget.retries)} ≠ 0`);

  const armIds = Array.isArray(design.arms) ? design.arms.map((arm) => arm?.id) : [];
  if (JSON.stringify(armIds) !== JSON.stringify(ARMS)) errors.push(`预注册 arms 必须是 ${ARMS.join("/")}；实际 ${JSON.stringify(armIds)}`);

  const graphs = fixtures.graphs;
  const seen = new Set();
  const rows = [];
  for (const [index, task] of tasks.entries()) {
    const at = `tasks[${index}]`;
    const before = errors.length;
    const id = typeof task?.id === "string" ? task.id : "";
    if (id === "") errors.push(`${at} 缺少 id`);
    if (seen.has(id)) errors.push(`${at} 重复 id ${id}`);
    seen.add(id);
    const graphName = task?.graph;
    if (typeof graphName !== "string" || graphs[graphName] === null || typeof graphs[graphName] !== "object") {
      errors.push(`${id || at} 引用了不存在的图：${String(graphName)}`);
      continue;
    }
    const query = typeof task.query === "string" ? task.query : "";
    if (query.trim() === "") errors.push(`${id || at} 缺少 query`);
    if (typeof task.gold !== "string" || task.gold.trim() === "") errors.push(`${id || at} 缺少 gold`);
    if (!Array.isArray(task.aliases) || task.aliases.some((alias) => typeof alias !== "string")) errors.push(`${id || at} aliases 必须是字符串数组`);
    if (!["base-context", "recall"].includes(task.derivableFrom)) errors.push(`${id || at} derivableFrom 必须是 base-context 或 recall；实际 ${String(task.derivableFrom)}`);
    const limit = Number(task.options?.limit);
    const maxChars = Number(task.options?.maxChars);
    if (!Number.isFinite(limit) || limit <= 0) errors.push(`${id || at} options.limit 非法：${String(task.options?.limit)}`);
    if (!Number.isFinite(maxChars) || maxChars <= 0) errors.push(`${id || at} options.maxChars 非法：${String(task.options?.maxChars)}`);
    if (typeof task.family !== "string" || task.family === "") errors.push(`${id || at} 缺少 family`);
    if (errors.length > before) continue;

    const recall = renderQueryRecall(graphs[graphName], query, { limit, maxChars });
    const recallChars = charLength(recall.text);
    if (recallChars > maxChars) errors.push(`${id} 召回块 ${recallChars} 字符超过 maxChars=${maxChars}`);
    if (recall.items.length > limit) errors.push(`${id} 召回行 ${recall.items.length} 超过 limit=${limit}`);
    const contextA0 = baseContext;
    const contextA1 = composeArmContext(baseContext, recall.text);
    // 两臂差异只能是召回块（空块时逐字相同）。
    if (recall.text === "" && contextA1 !== contextA0) errors.push(`${id} 空召回时两臂上下文必须逐字相同`);
    if (recall.text !== "" && contextA1 !== `${contextA0}\n\n${recall.text}`) errors.push(`${id} A1 必须是 baseContext + 两换行 + 召回块`);
    rows.push({
      index,
      id,
      family: task.family,
      graph: graphName,
      query,
      gold: task.gold,
      aliases: task.aliases.slice(),
      derivableFrom: task.derivableFrom,
      options: { limit, maxChars },
      recall: { chars: recallChars, items: recall.items.length, truncated: recall.stats.truncated === true, text: recall.text },
      contextA0,
      contextA1,
      arms: {
        A0: { id, arm: "A0", question: query, context: contextA0 },
        A1: { id, arm: "A1", question: query, context: contextA1 },
      },
    });
  }

  const calls = rows.length * ARMS.length * SAMPLES_PER_ARM;
  if (calls !== MAX_CALLS) errors.push(`展开后的调用数 ${calls} ≠ 硬上限 ${MAX_CALLS}（20 题 × 2 臂 × 3 样本）`);

  const families = {};
  for (const row of rows) families[row.family] = (families[row.family] ?? 0) + 1;

  return {
    ok: errors.length === 0,
    errors,
    plan: {
      experimentId: prereg.experimentId ?? null,
      baseContext,
      tasks: rows,
      arms: ARMS.slice(),
      samplesPerArm: SAMPLES_PER_ARM,
      calls,
      retries: 0,
      maxCalls: MAX_CALLS,
      families,
      runOrder: "task-major：每题先 A0 × 3 样本，再 A1 × 3 样本",
    },
  };
}

/** 显示宽度（CJK 算 2 格）—— 只为把计划表对齐，不参与任何判定。 */
function displayWidth(value) {
  return Array.from(String(value ?? "")).reduce(
    (sum, char) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(char) ? 2 : 1),
    0,
  );
}

/** dry-run 的人类可读表格：逐题两臂字符数 + 合计 calls=120。 */
export function renderPlanTable(plan) {
  const pad = (value, width) => `${String(value)}${" ".repeat(Math.max(1, width - displayWidth(value)))}`;
  const lines = [];
  lines.push(`请求计划（${plan.tasks.length} 题 × ${plan.arms.length} 臂 × ${plan.samplesPerArm} 样本 = ${plan.calls}）`);
  lines.push(
    `${pad("题号", 6)}${pad("家族", 13)}${pad("图", 8)}${pad("limit", 7)}${pad("maxChars", 10)}${pad("A0字符", 9)}${pad("A1字符", 9)}${pad("召回字符", 11)}${pad("召回行", 9)}截断`,
  );
  for (const task of plan.tasks) {
    lines.push(
      `${pad(task.id, 6)}${pad(task.family, 13)}${pad(task.graph, 8)}${pad(task.options.limit, 7)}${pad(task.options.maxChars, 10)}${pad(charLength(task.contextA0), 9)}${pad(charLength(task.contextA1), 9)}${pad(task.recall.chars, 11)}${pad(task.recall.items, 9)}${task.recall.truncated ? "是" : "否"}`,
    );
  }
  lines.push(`合计：calls=${plan.calls}（hardCap=${plan.maxCalls}，retries=${plan.retries}，严格串行；${plan.runOrder}）`);
  return lines.join("\n");
}

/* ───────────────────────── 冻结 reader 的复用层 ───────────────────────── */

/**
 * reader 可见契约（与冻结 reader 同形）：恰好四字段 {id, arm, question, context}。
 * arm 用预注册的 A0/A1（只作记录；`buildMessages` 只读 question / context，从不读 arm）。
 * 金标准 / aliases / grader / 另一臂一律不进 payload。
 */
export function assertReaderPayload(payload) {
  if (payload === null || typeof payload !== "object") throw new Error("reader payload must be an object");
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["arm", "context", "id", "question"])) {
    throw new Error(`reader payload keys leaked or missing: ${keys.join(",")}`);
  }
  if (!ARMS.includes(payload.arm) || typeof payload.id !== "string" || typeof payload.question !== "string" || typeof payload.context !== "string") {
    throw new Error("reader payload has invalid field types");
  }
  return true;
}

/** 请求构造：prompt 逐字来自冻结 reader 的 `buildMessages`（不自造 prompt）。 */
export function buildRequest(task, arm, { variant = process.env.LME_READER_VARIANT || READER_DEFAULTS.variant } = {}) {
  const payload = task.arms?.[arm] ?? { id: task.id, arm, question: task.query, context: arm === "A0" ? task.contextA0 : task.contextA1 };
  assertReaderPayload(payload);
  return buildMessages({ id: payload.id, arm: payload.arm, question: payload.question, context: payload.context }, { variant });
}

/**
 * HTTP 传输：镜像冻结 reader 的 `callChat`（未导出）—— 同一组请求字段与超时。
 * endpoint / model 由环境变量注入（与冻结 reader 同一入口），本文件不写死模型 id 或 endpoint。
 */
export function createFetchTransport({ endpoint, model, timeoutMs = TRANSPORT_SPEC.timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch transport requires a fetch implementation");
  return async function httpTransport({ messages }) {
    const started = Date.now();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: TRANSPORT_SPEC.temperature,
        max_tokens: TRANSPORT_SPEC.maxTokens,
        stream: TRANSPORT_SPEC.stream,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`reader HTTP ${response.status}: ${String(body?.error?.message ?? JSON.stringify(body)).slice(0, 300)}`);
    const choice = body?.choices?.[0] ?? {};
    return {
      raw: choice?.message?.content ?? null,
      finishReason: choice?.finish_reason ?? null,
      usage: body?.usage ?? null,
      latencyMs,
    };
  };
}

/* ───────────────────────────── 执行（严格串行） ───────────────────────────── */

/**
 * 按计划逐题执行：每题先 A0 的 3 个样本、再 A1 的 3 个样本；await 逐次串行，**无重试**。
 * 任一样本失败 ⇒ 如实记 `ok:false` 与错误文本，然后继续（不重试、不补样、不追加）。
 */
export async function runStageB({ plan, transport, budget = createBudget(plan?.calls ?? MAX_CALLS), log = null, variant } = {}) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.tasks)) throw new Error("runStageB requires a plan");
  if (typeof transport !== "function") throw new Error("runStageB requires an explicitly injected transport");
  if (plan.calls !== MAX_CALLS) throw new Error(`plan.calls must be ${MAX_CALLS}; got ${plan.calls}`);
  const records = [];
  const startedAt = nowIso();
  for (const task of plan.tasks) {
    let line = `[${String(task.index + 1).padStart(2, "0")}/${plan.tasks.length}] ${task.id}`;
    for (const arm of plan.arms) {
      for (let sample = 0; sample < plan.samplesPerArm; sample += 1) {
        const index = budget.take(`${task.id}/${arm}/${sample}`);
        const messages = buildRequest(task, arm, { variant });
        let result;
        try {
          const response = await transport({ index, taskId: task.id, arm, sample, messages });
          const raw = response?.raw ?? null;
          const normalized = postProcessAnswer(normalizeReaderAnswer(raw), task.arms[arm].context, {
            mode: process.env.LME_READER_POSTPROCESS || READER_DEFAULTS.postprocess,
            question: task.query,
          });
          const graded = String(normalized).toLowerCase();
          result = {
            index,
            taskId: task.id,
            arm,
            sample,
            ok: raw !== null && raw !== undefined,
            raw: raw ?? null,
            normalized,
            graded,
            finishReason: response?.finishReason ?? null,
            usage: asUsage(response?.usage),
            latencyMs: Number(response?.latencyMs ?? 0),
            error: raw === null || raw === undefined ? "reader returned no content" : null,
          };
        } catch (error) {
          result = {
            index,
            taskId: task.id,
            arm,
            sample,
            ok: false,
            raw: null,
            normalized: "",
            graded: "",
            finishReason: "error",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            latencyMs: 0,
            error: String(error?.message ?? error),
          };
        }
        records.push(result);
      }
      const failed = records.filter((record) => record.taskId === task.id && record.arm === arm && record.ok === false).length;
      line += ` · ${arm} ${plan.samplesPerArm - failed}/${plan.samplesPerArm}`;
    }
    if (typeof log === "function") log(line);
  }
  return { records, callsUsed: budget.used, retriesUsed: 0, startedAt, finishedAt: nowIso() };
}

/** 兼容两种写法：传输层原始 usage（prompt_tokens…）与已归一化的 usage（inputTokens…）。 */
function asUsage(usage) {
  return {
    inputTokens: Number(usage?.inputTokens ?? usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? usage?.completion_tokens ?? 0),
    totalTokens: Number(usage?.totalTokens ?? usage?.total_tokens ?? 0),
  };
}

/* ───────────────────────────── 判定 ───────────────────────────── */

/** 单样本判定：UNKNOWN（不算对也不算错）/ CORRECT / WRONG（含编造）/ ERROR（调用失败）。 */
export function classifySample(task, graded, ok = true) {
  if (ok === false) return "ERROR";
  const value = String(graded ?? "").toLowerCase();
  if (UNKNOWN_ANSWERS.includes(value)) return "UNKNOWN";
  // 预注册 grading.normalize 的「小写 ASCII」对**两侧**都成立：金标准与 aliases 同样归一化后再逐字比。
  const gold = String(task.gold ?? "").toLowerCase();
  const aliases = Array.isArray(task.aliases) ? task.aliases.map((alias) => String(alias).toLowerCase()) : [];
  const grade = gradeAnswer(gold, value, "exact", aliases);
  return grade.correct ? "CORRECT" : "WRONG";
}

/** 3 样本多数票；平票取第 1 个样本（预注册 grading.majority）。 */
export function majorityOf(values) {
  const list = Array.isArray(values) ? values.map((value) => String(value ?? "")) : [];
  const counts = new Map();
  for (const value of list) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = 0;
  let answer = list[0] ?? "";
  for (const [value, count] of counts) {
    if (count > best) {
      best = count;
      answer = value;
    }
  }
  return { answer, count: best, votes: Object.fromEntries(counts) };
}

function summarizeArm(task, arm, samples) {
  const counts = { CORRECT: 0, UNKNOWN: 0, WRONG: 0, ERROR: 0 };
  for (const sample of samples) counts[sample.outcome] += 1;
  const usable = samples.filter((sample) => sample.outcome !== "ERROR");
  const majority = majorityOf(usable.map((sample) => sample.graded));
  const outcome = usable.length === 0 ? "INVALID" : classifySample(task, majority.answer, true);
  const walls = usable.map((sample) => sample.latencyMs);
  const usage = samples.reduce(
    (acc, sample) => ({
      inputTokens: acc.inputTokens + sample.usage.inputTokens,
      outputTokens: acc.outputTokens + sample.usage.outputTokens,
      totalTokens: acc.totalTokens + sample.usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  return {
    samples,
    counts,
    majority: { answer: majority.answer, count: majority.count, votes: majority.votes },
    outcome,
    invalid: counts.ERROR > 0 || usable.length === 0,
    usage,
    wallMs: { p50: percentile(walls, 50), p95: percentile(walls, 95), sum: walls.reduce((sum, value) => sum + value, 0), count: walls.length },
  };
}

/** 门槛全在这里：元数据来自预注册，判定是纯函数，可被 mock 逐条打红。 */
export function evaluateRun({ plan, records, stageA = { ok: true, p95Ms: null } } = {}) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.tasks)) throw new Error("evaluateRun requires a plan");
  const arms = Array.isArray(plan.arms) && plan.arms.length > 0 ? plan.arms : ARMS;
  const samplesPerArm = Number(plan.samplesPerArm ?? SAMPLES_PER_ARM);
  const expected = plan.tasks.length * arms.length * samplesPerArm;
  const errors = [];
  if (records.length !== expected) errors.push(`记录数 ${records.length} ≠ 期望 ${expected}（${plan.tasks.length} 题 × ${arms.length} 臂 × ${samplesPerArm} 样本）`);

  const byKey = new Map();
  for (const record of records) byKey.set(`${record.taskId}\u0000${record.arm}\u0000${record.sample}`, record);

  const perTask = [];
  for (const task of plan.tasks) {
    const row = { id: task.id, family: task.family ?? null, derivableFrom: task.derivableFrom ?? null, goldKind: String(task.gold).trim().toUpperCase() === "UNKNOWN" ? "abstention" : "exact", arms: {} };
    for (const arm of arms) {
      const samples = [];
      for (let sample = 0; sample < samplesPerArm; sample += 1) {
        const record = byKey.get(`${task.id}\u0000${arm}\u0000${sample}`);
        if (record === undefined) {
          errors.push(`缺少记录：${task.id}/${arm}/${sample}`);
          samples.push({ index: 0, sample, ok: false, raw: null, normalized: "", graded: "", outcome: "ERROR", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs: 0, error: "missing record", finishReason: "error" });
          continue;
        }
        const outcome = classifySample(task, record.graded, record.ok !== false);
        samples.push({
          index: record.index ?? 0,
          sample,
          ok: record.ok !== false,
          raw: record.raw ?? null,
          normalized: record.normalized ?? "",
          graded: record.graded ?? "",
          outcome,
          correct: outcome === "CORRECT",
          unknown: outcome === "UNKNOWN",
          wrong: outcome === "WRONG",
          usage: asUsage(record.usage),
          latencyMs: Number(record.latencyMs ?? 0),
          finishReason: record.finishReason ?? null,
          error: record.error ?? null,
        });
      }
      row.arms[arm] = summarizeArm(task, arm, samples);
    }
    const a0 = row.arms[arms[0]];
    const a1 = row.arms[arms[1] ?? arms[0]];
    // 「A0 对而 A1 错」：UNKNOWN 也算丢了答案（更严），但 INVALID（数据缺失/调用失败）不算回归 ——
    // 那种情况由 incomplete 统一降级为 NOT_DECIDED，不能拿来判 NEGATIVE_SIGNAL。
    row.regression = a0?.outcome === "CORRECT" && a1 !== undefined && a1.outcome !== "CORRECT" && a1.outcome !== "INVALID";
    row.fabrication = { A0: row.goldKind === "abstention" && a0?.outcome === "WRONG", A1: row.goldKind === "abstention" && a1?.outcome === "WRONG" };
    perTask.push(row);
  }

  const aggregateArm = (arm) => {
    const rows = perTask.map((row) => row.arms[arm]);
    const majorityCorrect = rows.filter((entry) => entry.outcome === "CORRECT").length;
    const inputTokens = rows.reduce((sum, entry) => sum + entry.usage.inputTokens, 0);
    const outputTokens = rows.reduce((sum, entry) => sum + entry.usage.outputTokens, 0);
    const walls = rows.flatMap((entry) => entry.samples.filter((sample) => sample.outcome !== "ERROR").map((sample) => sample.latencyMs));
    return {
      majorityCorrect,
      majorityUnknown: rows.filter((entry) => entry.outcome === "UNKNOWN").length,
      majorityWrong: rows.filter((entry) => entry.outcome === "WRONG").length,
      majorityInvalid: rows.filter((entry) => entry.outcome === "INVALID").length,
      unknownSamples: rows.reduce((sum, entry) => sum + entry.counts.UNKNOWN, 0),
      wrongSamples: rows.reduce((sum, entry) => sum + entry.counts.WRONG, 0),
      correctSamples: rows.reduce((sum, entry) => sum + entry.counts.CORRECT, 0),
      errorSamples: rows.reduce((sum, entry) => sum + entry.counts.ERROR, 0),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      tokensPerCorrectMajority: round(inputTokens / Math.max(1, majorityCorrect), 2),
      wallMs: { p50: percentile(walls, 50), p95: percentile(walls, 95), count: walls.length },
    };
  };

  const [armA, armB] = arms;
  const aggregate = { [armA]: aggregateArm(armA), [armB]: aggregateArm(armB) };
  const a0 = aggregate[armA];
  const a1 = aggregate[armB];

  const regression = perTask.filter((row) => row.regression).map((row) => row.id);
  const incomplete =
    errors.length > 0 ||
    a0.errorSamples > 0 ||
    a1.errorSamples > 0 ||
    a0.majorityInvalid > 0 ||
    a1.majorityInvalid > 0;
  // 饱和必须按「可计分题」算：gold 为 UNKNOWN 的弃答题记 UNKNOWN（不算对也不算错），
  // 用 plan.tasks.length 当分母会让 20/20 保护永远不可达（本集可计分题 = 18）。
  const scorableTasks = perTask.filter((row) => row.goldKind === "exact").length;
  const saturationTriggered =
    scorableTasks > 0 && (a0.majorityCorrect >= scorableTasks || a1.majorityCorrect >= scorableTasks);

  const gates = {
    stageA: stageA?.ok === true && Number.isFinite(Number(stageA?.p95Ms)) && Number(stageA.p95Ms) <= 25,
    stageAP95Ms: Number.isFinite(Number(stageA?.p95Ms)) ? Number(stageA.p95Ms) : null,
    pairedNoRegression: regression.length === 0,
    unknownNotIncreased: a1.unknownSamples <= a0.unknownSamples,
    tokenPositive: Number(a1.tokensPerCorrectMajority) <= Number(a0.tokensPerCorrectMajority),
    p95Positive: a1.wallMs.p95 !== null && a0.wallMs.p95 !== null && Number(a1.wallMs.p95) <= Number(a0.wallMs.p95) + 50,
    saturationCap: !saturationTriggered,
  };

  const decision = decide({ incomplete, regression, a0, a1, gates, saturationTriggered, plan, scorableTasks });

  const byFamily = {};
  for (const row of perTask) {
    const key = row.family ?? "unknown";
    const bucket = (byFamily[key] ??= { tasks: 0, [armA]: { correct: 0, unknown: 0, wrong: 0, unknownSamples: 0 }, [armB]: { correct: 0, unknown: 0, wrong: 0, unknownSamples: 0 } });
    bucket.tasks += 1;
    for (const arm of arms) {
      const entry = row.arms[arm];
      bucket[arm].correct += entry.outcome === "CORRECT" ? 1 : 0;
      bucket[arm].unknown += entry.outcome === "UNKNOWN" ? 1 : 0;
      bucket[arm].wrong += entry.outcome === "WRONG" ? 1 : 0;
      bucket[arm].unknownSamples += entry.counts.UNKNOWN;
    }
  }

  return {
    errors,
    incomplete,
    perTask,
    aggregate,
    byFamily,
    regression,
    saturationTriggered,
    gates,
    decision: decision.band,
    decisionReasons: decision.reasons,
    decisionCap: DECISION_CAP,
    decisionCapReason: DECISION_CAP_REASON,
    scorableTasks,
    adoption: decision.band === "ADOPT" ? "ADOPT" : "NOT_ADOPTED",
    abstentions: perTask.flatMap((row) => arms.filter((arm) => row.arms[arm].outcome === "UNKNOWN").map((arm) => ({ id: row.id, arm }))),
    fabrications: perTask.flatMap((row) => arms.filter((arm) => row.fabrication[arm]).map((arm) => ({ id: row.id, arm }))),
  };
}

/**
 * 判定顺序（逐条对应预注册 decisionBands，**只收紧不加宽**）：
 *   ① 数据不全（调用失败 / 记录缺失）⇒ NOT_DECIDED（不许拿残缺数据宣称结论）；
 *   ② 任一题 A0 对而 A1 错，或 A1 多数票 < A0 ⇒ NEGATIVE_SIGNAL；
 *   ③ 触发 saturationCap（任一臂 20/20）⇒ 最高 POSITIVE_SIGNAL，**绝不 ADOPT**；
 *   ④ A1 > A0 且五道门全过 ⇒ ADOPT；否则 POSITIVE_SIGNAL（有增益但不足以采纳）；
 *   ⑤ 多数票相同：样本级 / UNKNOWN / 翻转全相同 ⇒ NO_DIFFERENCE，否则 NOT_DECIDED。
 */
export function decide({ incomplete, regression, a0, a1, gates, saturationTriggered, plan, scorableTasks }) {
  const reasons = [];
  if (incomplete) {
    reasons.push("调用记录不完整（失败或缺失）：按预注册 retrySemantics 该题该臂作废，不重试、不补样");
    return { band: "NOT_DECIDED", reasons };
  }
  if (regression.length > 0) {
    reasons.push(`逐题回归：${regression.join(", ")}（A0 多数票对、A1 不对）`);
    return { band: "NEGATIVE_SIGNAL", reasons };
  }
  if (a1.majorityCorrect < a0.majorityCorrect) {
    reasons.push(`A1 多数票正确 ${a1.majorityCorrect} < A0 ${a0.majorityCorrect}`);
    return { band: "NEGATIVE_SIGNAL", reasons };
  }
  if (saturationTriggered) {
    reasons.push(`题集在可计分题上饱和（A0 ${a0.majorityCorrect}/${scorableTasks}，A1 ${a1.majorityCorrect}/${scorableTasks}）：饱和题集测不出进一步差异，最高只记 POSITIVE_SIGNAL`);
    return { band: "POSITIVE_SIGNAL", reasons, capped: true };
  }
  if (a1.majorityCorrect > a0.majorityCorrect) {
    reasons.push(`A1 多数票正确 ${a1.majorityCorrect} > A0 ${a0.majorityCorrect}`);
    reasons.push(`无逐题回归；UNKNOWN 样本 A1 ${a1.unknownSamples} vs A0 ${a0.unknownSamples}；tokens/正确题 A1 ${a1.tokensPerCorrectMajority} vs A0 ${a0.tokensPerCorrectMajority}；p95 A1 ${a1.wallMs.p95} vs A0 ${a0.wallMs.p95}`);
    const failed = Object.entries(gates).filter(([, value]) => value === false).map(([key]) => key);
    if (failed.length > 0) reasons.push(`未过的门：${failed.join(", ")}`);
    reasons.push(DECISION_CAP_REASON);
    return { band: DECISION_CAP, reasons, capped: true };
  }
  const sameSamples = a1.correctSamples === a0.correctSamples && a1.wrongSamples === a0.wrongSamples;
  const sameUnknown = a1.unknownSamples === a0.unknownSamples;
  if (sameSamples && sameUnknown) {
    reasons.push("两臂多数票、样本级判对与 UNKNOWN 全部相同，且无逐题翻转");
    return { band: "NO_DIFFERENCE", reasons };
  }
  reasons.push("多数票相同但样本级有差：不加样本、不换 prompt、只记录");
  return { band: "NOT_DECIDED", reasons };
}

/* ───────────────────────────── 输出文件 ───────────────────────────── */

/** 私有明细：逐题逐样本 raw / normalized / 判定 / usage / 延迟 / 多数票。 */
export function buildResultsFile({ plan, records, evaluation, stageA, frozen, declaration, run, perf = null }) {
  return {
    schema: "query-recall-pilot-results-v1",
    version: 1,
    experimentId: plan.experimentId,
    status: evaluation.incomplete ? "INCOMPLETE" : "SCORED",
    generatedAt: nowIso(),
    synthetic: true,
    stageAStatus: stageA.status,
    callsUsed: run.callsUsed,
    retriesUsed: run.retriesUsed,
    authorization: { token: declaration.token, stageAP95Ms: declaration.stageAP95Ms, stageAP95Source: PATHS.stageAPerf },
    stageA: {
      status: stageA.status,
      file: stageA.file,
      sha256: stageA.sha256 ?? null,
      fixturesSha256: stageA.fixturesSha256 ?? null,
      aggregate: stageA.aggregate ?? null,
      p95Ms: declaration.stageAP95Ms,
      impl: stageA.impl ?? null,
      perf: perf === null ? null : { file: PATHS.stageAPerf, sha256: perf.sha256, p95: perf.p95, deltaError: perf.deltaError, samples: perf.samples, graphBytes: perf.graphBytes, nodes: perf.nodes, edges: perf.edges },
    },
    frozen,
    reader: {
      variant: declaration.variant,
      postprocess: declaration.postprocess,
      temperature: TRANSPORT_SPEC.temperature,
      maxTokens: TRANSPORT_SPEC.maxTokens,
      samplesPerArm: plan.samplesPerArm,
      retries: plan.retries,
      model: declaration.model,
      endpointSource: "LME_READER_ENDPOINT（由运维注入，本文件不记录）",
    },
    run: {
      callsUsed: run.callsUsed,
      retriesUsed: run.retriesUsed,
      maxCalls: MAX_CALLS,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      runOrder: plan.runOrder,
      serial: true,
    },
    decision: evaluation.decision,
    adoption: evaluation.adoption,
    saturationTriggered: evaluation.saturationTriggered,
    decisionCap: evaluation.decisionCap ?? DECISION_CAP,
    decisionCapReason: evaluation.decisionCapReason ?? DECISION_CAP_REASON,
    scorableTasks: evaluation.scorableTasks ?? null,
    decisionReasons: evaluation.decisionReasons,
    gates: evaluation.gates,
    aggregate: evaluation.aggregate,
    byFamily: evaluation.byFamily,
    tasks: evaluation.perTask.map((row) => ({
      id: row.id,
      family: row.family,
      derivableFrom: row.derivableFrom,
      goldKind: row.goldKind,
      regression: row.regression,
      arms: Object.fromEntries(
        Object.entries(row.arms).map(([arm, entry]) => [
          arm,
          {
            outcome: entry.outcome,
            majority: entry.majority,
            counts: entry.counts,
            usage: entry.usage,
            wallMs: entry.wallMs,
            samples: entry.samples,
          },
        ]),
      ),
    })),
    calls: records.length,
    notes: [
      "私有明细文件：含逐样本 raw 回答（本题全部为纯合成文本）；公开面请看 query-recall-pilot-public.json。",
      "不写 endpoint；endpoint 只由 LME_READER_ENDPOINT 注入。",
      "本文件不构成采纳结论之外的任何质量/能力声明；生产默认仍为 NOT_ADOPTED。",
    ],
  };
}

/** 公开聚合：只有聚合与票型（无 raw、无 endpoint、无路径、无会话 id）。 */
export function buildPublicFile({ plan, evaluation, declaration, run, frozen, stageA = null, perf = null }) {
  const shas = {};
  for (const [key, entry] of Object.entries(frozen ?? {})) shas[key] = entry?.sha256 ?? null;
  return {
    schema: "query-recall-pilot-public-v1",
    version: 1,
    experimentId: plan.experimentId,
    status: evaluation.incomplete ? "INCOMPLETE" : "SCORED",
    generatedAt: nowIso(),
    synthetic: true,
    stageAStatus: stageA?.status ?? "PASS",
    stageAP95Ms: declaration.stageAP95Ms,
    callsUsed: run.callsUsed,
    retriesUsed: run.retriesUsed,
    maxCalls: MAX_CALLS,
    samplesPerArm: plan.samplesPerArm,
    model: declaration.model,
    arms: evaluation.aggregate,
    gates: evaluation.gates,
    decision: evaluation.decision,
    adoption: evaluation.adoption,
    saturationTriggered: evaluation.saturationTriggered,
    decisionCap: evaluation.decisionCap ?? DECISION_CAP,
    decisionCapReason: evaluation.decisionCapReason ?? DECISION_CAP_REASON,
    scorableTasks: evaluation.scorableTasks ?? null,
    stageAPerfSha256: perf?.sha256 ?? null,
    decisionReasons: evaluation.decisionReasons,
    byFamily: evaluation.byFamily,
    perTask: evaluation.perTask.map((row) => ({
      id: row.id,
      family: row.family,
      derivableFrom: row.derivableFrom,
      A0: { outcome: row.arms.A0.outcome, votes: row.arms.A0.majority.votes },
      A1: { outcome: row.arms.A1.outcome, votes: row.arms.A1.majority.votes },
      regression: row.regression,
    })),
    abstentions: evaluation.abstentions,
    fabrications: evaluation.fabrications,
    frozen: shas,
    privacy: {
      synthetic: true,
      rawAnswers: "not-in-this-file",
      endpoint: "not-recorded",
      paths: "not-recorded",
      sessionIds: "none",
    },
    notes: [
      "公开聚合：只含聚合与票型；raw 回答只在私有明细文件里。",
      "本题全部为纯合成题面/上下文/答案；不含真实会话、真实路径或私有数据。",
      "生产默认仍为 NOT_ADOPTED：本文件只记录本次预注册实验的判定。",
    ],
  };
}

/* ───────────────────────────── CLI ───────────────────────────── */

const USAGE = [
  "用法：",
  "  node scripts/query-recall-pilot.mjs                     # dry-run（默认；0 网络）",
  "  node scripts/query-recall-pilot.mjs --run --authorize q1-query-recall-stage-b-1",
  "可选：--repo <dir> · --overwrite · --help",
].join("\n");

function parseArgs(argv) {
  const parsed = { run: false, authorize: null, repo: REPO, overwrite: false, help: false, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const takeValue = (name) => {
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith("--")) {
        parsed.errors.push(`${name} 需要一个值`);
        return null;
      }
      index += 1;
      return String(next);
    };
    if (arg === "--run") parsed.run = true;
    else if (arg === "--overwrite") parsed.overwrite = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--authorize") parsed.authorize = takeValue("--authorize");
    else if (arg.startsWith("--authorize=")) parsed.authorize = arg.slice("--authorize=".length);
    else if (arg === "--repo") {
      const value = takeValue("--repo");
      if (value !== null) parsed.repo = nodePath.resolve(value);
    } else if (arg.startsWith("--repo=")) parsed.repo = nodePath.resolve(arg.slice("--repo=".length));
    else if (arg === "--stage-a-p95" || arg.startsWith("--stage-a-p95=")) {
      parsed.errors.push("--stage-a-p95 已废弃：p95 必须读自 evidence/query-recall-stage-a-perf.json（不接受裸声明）");
      if (arg === "--stage-a-p95" && argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith("--")) index += 1;
    }
    else {
      parsed.errors.push(`未知参数：${arg}`);
    }
  }
  return parsed;
}

/**
 * 入口：所有闸门（参数 / 授权 / 冻结 sha / Stage A / 计划）都在构造 transport 之前。
 * 测试通过注入 `transport` 复用同一套闸门，并断言 0 次调用。
 */
export async function main(argv = process.argv.slice(2), { transport, logger = console } = {}) {
  const out = (line = "") => logger.log(line);
  const fail = (line) => logger.error?.(line) ?? logger.log(line);
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return EXIT.OK;
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) fail(`参数错误：${error}`);
    fail(USAGE);
    return EXIT.USAGE;
  }
  // ① 预注册
  const preregFile = repoPath(args.repo, PATHS.prereg);
  if (!nodeFs.existsSync(preregFile)) {
    fail(`预注册缺失：${PATHS.prereg}（先登记预注册，再谈运行）`);
    return EXIT.PRECONDITION;
  }
  const prereg = readJsonFile(preregFile);
  if (prereg === null) {
    fail(`预注册无法解析：${PATHS.prereg}`);
    return EXIT.PRECONDITION;
  }

  // ② 冻结输入（预注册 sha ↔ 实际字节）
  const frozen = checkFrozenInputs({ repo: args.repo, prereg });
  if (!frozen.ok) {
    fail("冻结输入核对失败（预注册作废或文件被改）：");
    for (const error of frozen.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }

  // ②b 请求口径（与冻结 reader 源码逐字对账；漂移即拒绝，不静默跟随）
  const transportCheck = checkFrozenTransport({ repo: args.repo });
  if (!transportCheck.ok) {
    fail("请求口径与冻结 reader 不一致（拒绝运行）：");
    for (const error of transportCheck.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }

  // ③ Stage A 闸门（缺失/失败 ⇒ 在任何网络请求之前退出）
  const stageA = checkStageA({ repo: args.repo, prereg });
  if (!stageA.ok) {
    fail("Stage A 闸门未过（Stage B 一次调用都不许发）：");
    for (const error of stageA.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }

  // ③b Stage A 性能证据（M-4：p95 ≤ 25 必须是落盘证据，不接受命令行声明）
  const perf = checkStageAPerf({ repo: args.repo, prereg });
  if (!perf.ok) {
    fail("Stage A 性能闸门未过（Stage B 一次调用都不许发）：");
    for (const error of perf.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }

  // ④ 计划（20 题 × 2 臂 × 3 样本 = 120）
  const planned = buildPlan({ repo: args.repo, prereg });
  if (!planned.ok) {
    fail("请求计划不合法（夹具 / 预注册 / 实现三者对不上）：");
    for (const error of planned.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }
  const plan = planned.plan;
  const policy = checkDecisionPolicy({ prereg, plan });
  if (!policy.ok) {
    fail("预注册决策政策与代码不一致（拒绝运行）：");
    for (const error of policy.errors) fail(`  · ${error}`);
    return EXIT.PRECONDITION;
  }

  out("Q1 查询召回 Stage B · 计划核对");
  out("");
  out("冻结输入");
  for (const check of frozen.checks) out(`  ${check.file.padEnd(42)} sha256=${shortSha(check.actual)}  ${check.ok ? "ok" : "MISMATCH"}`);
  out(
    `Stage A：${stageA.status}（${stageA.file}；${String(stageA.aggregate?.passed ?? "?")}/${String(stageA.aggregate?.total ?? "?")}；hitRate=${String(stageA.aggregate?.hitRate ?? "?")}；misses=${String(stageA.aggregate?.misses ?? "?")}；falsePositives=${String(stageA.aggregate?.falsePositives ?? "?")}）`,
  );
  out(
    `Stage A 性能：p95=${perf.p95}ms（render ${perf.renderP95} / derived ${perf.derivedP95} 取 max；门槛 ≤25；deltaError=${String(perf.deltaError)}；samples=${String(perf.samples)}；图 ${String(perf.nodes)} 节点 / ${String(perf.edges)} 边）sha256=${shortSha(perf.sha256)} 已登记`,
  );
  out(`Stage A 实现：impl.sha256 ${perf && stageA.impl?.registered ? "已登记且一致" : "未在证据里登记（Lead 稍后补）"}${stageA.impl?.registered ? `（${shortSha(stageA.impl.declared)}）` : ""}`);
  out(
    `请求口径：temperature=${TRANSPORT_SPEC.temperature} · max_tokens=${TRANSPORT_SPEC.maxTokens} · stream=${TRANSPORT_SPEC.stream} · timeout=${TRANSPORT_SPEC.timeoutMs}ms · variant=${READER_DEFAULTS.variant} · postprocess=${READER_DEFAULTS.postprocess}（与冻结 reader 源码逐字一致）`,
  );
  out("");
  out(renderPlanTable(plan));
  const emptyRecall = plan.tasks.filter((task) => task.recall.chars === 0).map((task) => task.id);
  out(
    `两臂核对：${plan.tasks.length} 题同题同参数；A1 = A0 + 两换行 + 召回块（${plan.tasks.length - emptyRecall.length} 题）；空召回 ${emptyRecall.length} 题两臂逐字相同${emptyRecall.length > 0 ? `（${emptyRecall.join(", ")}）` : ""}`,
  );
  out("");

  if (!args.run) {
    out("授权：未授权（真实运行必须同时给 --run 与 --authorize q1-query-recall-stage-b-1）");
    out("网络：none（dry-run 不构造 transport、不发任何请求、不写任何文件）");
    return EXIT.OK;
  }

  // ⑤ 真实运行前的最后三道闸（全部在 transport 之前）
  if (args.authorize !== AUTHORIZE_TOKEN || prereg.experimentId !== AUTHORIZE_TOKEN) {
    fail(`拒绝运行：缺授权或口令不符（需要 --authorize ${AUTHORIZE_TOKEN}，且预注册 experimentId 必须同名）`);
    return EXIT.USAGE;
  }
  const model = process.env.LME_READER_MODEL ?? "";
  const endpoint = process.env.LME_READER_ENDPOINT ?? "";
  if (model.trim() === "" || endpoint.trim() === "") {
    fail("拒绝运行：必须显式设置 LME_READER_MODEL 与 LME_READER_ENDPOINT（runner 不写死模型 id / endpoint）");
    return EXIT.PRECONDITION;
  }
  const resultsFile = repoPath(args.repo, PATHS.results);
  const publicFile = repoPath(args.repo, PATHS.public);
  if (!args.overwrite && (nodeFs.existsSync(resultsFile) || nodeFs.existsSync(publicFile))) {
    fail(`拒绝运行：结果文件已存在（${PATHS.results} / ${PATHS.public}）；确要覆盖请加 --overwrite`);
    return EXIT.PRECONDITION;
  }

  const declaration = {
    token: args.authorize,
    stageAP95Ms: perf.p95,
    model,
    variant: process.env.LME_READER_VARIANT || READER_DEFAULTS.variant,
    postprocess: process.env.LME_READER_POSTPROCESS || READER_DEFAULTS.postprocess,
  };
  const runTransport = transport ?? createFetchTransport({ endpoint, model });
  const budget = createBudget(MAX_CALLS);
  out(`开始运行：${plan.tasks.length} 题 × ${plan.arms.length} 臂 × ${plan.samplesPerArm} 样本 = ${plan.calls} 次（严格串行、0 重试、硬上限 ${MAX_CALLS}）`);
  let run;
  try {
    run = await runStageB({ plan, transport: runTransport, budget, log: (line) => out(line), variant: declaration.variant });
  } catch (error) {
    fail(`运行中止：${String(error?.message ?? error)}`);
    return EXIT.FAIL;
  }
  if (run.callsUsed !== MAX_CALLS) {
    fail(`运行中止：实际调用 ${run.callsUsed} 次 ≠ 硬上限 ${MAX_CALLS}`);
    return EXIT.FAIL;
  }

  const evaluation = evaluateRun({ plan, records: run.records, stageA: { ok: stageA.ok && perf.ok, p95Ms: perf.p95 } });
  const frozenForOutput = {
    prereg: { file: PATHS.prereg, sha256: sha256File(preregFile) },
    fixtures: { file: PATHS.fixtures, sha256: frozen.checks.find((check) => check.key === "stageAFixtures")?.actual ?? null },
    stageAScript: { file: PATHS.stageAScript, sha256: frozen.checks.find((check) => check.key === "stageAScript")?.actual ?? null },
    stageATest: { file: PATHS.stageATest, sha256: frozen.checks.find((check) => check.key === "stageATest")?.actual ?? null },
    reader: { file: PATHS.reader, sha256: frozen.checks.find((check) => check.key === "reader")?.actual ?? null },
    grader: { file: PATHS.grader, sha256: frozen.checks.find((check) => check.key === "grader")?.actual ?? null },
    impl: { file: PATHS.impl, sha256: nodeFs.existsSync(repoPath(args.repo, PATHS.impl)) ? sha256File(repoPath(args.repo, PATHS.impl)) : null },
  };
  const results = buildResultsFile({ plan, records: run.records, evaluation, stageA, frozen: frozenForOutput, declaration, run, perf });
  const publicDoc = buildPublicFile({ plan, evaluation, declaration, run, frozen: frozenForOutput, stageA, perf });

  nodeFs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  nodeFs.writeFileSync(publicFile, `${JSON.stringify(publicDoc, null, 2)}\n`, "utf8");

  out("");
  out(`判定：${evaluation.decision}（adoption=${evaluation.adoption}；saturation=${evaluation.saturationTriggered}）`);
  for (const reason of evaluation.decisionReasons) out(`  · ${reason}`);
  out(
    `两臂：A0 多数票对 ${evaluation.aggregate.A0.majorityCorrect} · A1 ${evaluation.aggregate.A1.majorityCorrect}；UNKNOWN 样本 A0 ${evaluation.aggregate.A0.unknownSamples} / A1 ${evaluation.aggregate.A1.unknownSamples}`,
  );
  out(`已写入 ${relPath(args.repo, resultsFile)} 与 ${relPath(args.repo, publicFile)}`);
  return evaluation.incomplete ? EXIT.FAIL : EXIT.OK;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
