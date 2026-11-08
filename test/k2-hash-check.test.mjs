/**
 * k2-hash-check.test.mjs — AX-03 预注册产物双哈希校验的回归
 *
 * 只读本地冻结产物与临时副本：**不调用模型、不发网络请求、不改仓库内冻结字节**。
 * 两头都钉住：
 *   · 正例 —— 当前冻结对通过（canonical 口径），只改缩进/键序仍通过；
 *   · 反例 —— 把 raw 文件哈希误写进 preregSha256、篡改答案/prereg、sidecar 字段错误、
 *             缺文件、源码模块缺失（门禁模式）都必须红。
 *
 * 冻结产物在 `tmp/`（git 忽略）里；干净 checkout 上不存在时，依赖它们的用例用
 * `t.skip` 明确跳过，不伪装成通过。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FROZEN_BASELINE,
  HASH_MANIFEST_SCHEMA,
  PROJECTION_FIELDS,
  buildHashManifest,
  canonicalJson,
  canonicalJsonSha256,
  sha256Bytes,
  verifyPreregArtifacts,
} from "../scripts/k2-hash-check.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(nodePath.join(HERE, ".."));
const CLI = nodePath.join(REPO, "scripts", "k2-hash-check.mjs");
const READER = nodePath.join(REPO, "scripts", "k2-value-reader.mjs");
const ARTIFACT_DIR = nodePath.join(REPO, "tmp", "axiom-2026-11-07", "ax03");
const PREREG = nodePath.join(ARTIFACT_DIR, "prereg.json");
const FIXTURES = nodePath.join(ARTIFACT_DIR, "fixtures.json");
const SIDECAR = nodePath.join(ARTIFACT_DIR, "hash-manifest.json");

export const tests = {};

const artifactsPresent = () => nodeFs.existsSync(PREREG) && nodeFs.existsSync(FIXTURES);
const sha256File = (file) => sha256Bytes(nodeFs.readFileSync(file));
const readJson = (file) => JSON.parse(nodeFs.readFileSync(file, "utf8"));
const writeJson = (file, value) => nodeFs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const cloneJson = (value) => JSON.parse(JSON.stringify(value));

function runCli(args, { cwd = REPO } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  const failing = payload?.checks ? [...new Set(payload.checks.filter((c) => c.status === "fail").map((c) => c.code ?? "UNKNOWN"))] : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, payload, failing };
}

/** 把冻结对复制到系统临时目录；返回路径与清理函数。 */
function makePair(label) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `k2h-${label}-`));
  const preregPath = nodePath.join(dir, "prereg.json");
  const fixturesPath = nodePath.join(dir, "fixtures.json");
  nodeFs.copyFileSync(PREREG, preregPath);
  nodeFs.copyFileSync(FIXTURES, fixturesPath);
  return { dir, preregPath, fixturesPath, cleanup: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
}

async function loadSourceModule() {
  return import(new URL("../scripts/k2-value-reader.mjs", import.meta.url).href);
}

tests["K2H-1 冻结产物双口径哈希：raw 与 canonical 各自等于基线且互不相同"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const preregBytes = nodeFs.readFileSync(PREREG);
  const fixturesBytes = nodeFs.readFileSync(FIXTURES);
  const preregRaw = sha256Bytes(preregBytes);
  const fixturesRaw = sha256Bytes(fixturesBytes);
  const preregCanonical = canonicalJsonSha256(JSON.parse(preregBytes.toString("utf8")));
  const fixturesCanonical = canonicalJsonSha256(JSON.parse(fixturesBytes.toString("utf8")));

  t.eq(preregBytes.length, FROZEN_BASELINE.preregBytes, "prereg 字节数必须等于冻结基线");
  t.eq(fixturesBytes.length, FROZEN_BASELINE.fixturesBytes, "fixtures 字节数必须等于冻结基线");
  t.eq(preregRaw, FROZEN_BASELINE.preregRawSha256, "prereg raw-bytes-sha256 必须等于基线");
  t.eq(fixturesRaw, FROZEN_BASELINE.fixturesRawSha256, "fixtures raw-bytes-sha256 必须等于基线");
  t.eq(preregCanonical, FROZEN_BASELINE.preregCanonicalJsonSha256, "prereg canonical-json-sha256 必须等于基线");
  t.eq(fixturesCanonical, FROZEN_BASELINE.fixturesCanonicalJsonSha256, "fixtures canonical-json-sha256 必须等于基线");
  t.ne(preregRaw, preregCanonical, "两个口径必须可区分（raw ≠ canonical）");
  t.ne(fixturesRaw, fixturesCanonical, "两个口径必须可区分（raw ≠ canonical）");
  t.eq(readJson(FIXTURES).preregSha256, preregCanonical, "fixtures.preregSha256 唯一合法口径是 canonical-json-sha256");
  t.ne(readJson(FIXTURES).preregSha256, preregRaw, "fixtures.preregSha256 绝不能等于 raw 文件哈希");

  // 键序无关：重排顶层键后 canonical 不变（证明 canonicalization 正确）。
  const prereg = readJson(PREREG);
  const reversed = {};
  for (const key of Object.keys(prereg).reverse()) reversed[key] = prereg[key];
  t.eq(canonicalJson(reversed), canonicalJson(prereg), "递归键排序后 canonical JSON 必须与键序无关");
  t.eq(canonicalJsonSha256(reversed), preregCanonical, "键序变化不得改变 canonical 哈希");
};

tests["K2H-2 基线校验（源码模块加载）：全部检查通过，C04/C05/C10 均 pass"] = async (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const k2 = await loadSourceModule();
  const result = verifyPreregArtifacts({
    preregPath: PREREG,
    fixturesPath: FIXTURES,
    sourceQuestions: k2.QUESTIONS,
    buildPreregFn: k2.buildPrereg,
  });
  t.eq(result.ok, true, `基线必须 PASS：${JSON.stringify(result.checks.filter((c) => c.status === "fail"))}`);
  t.eq(result.summary.failed, 0, "基线不得有 fail");
  t.eq(result.checks.find((c) => c.id === "C04")?.status, "pass", "C04 必须 pass");
  t.eq(result.checks.find((c) => c.id === "C05")?.status, "pass", "C05 必须 pass");
  t.eq(result.checks.find((c) => c.id === "C10")?.status, "pass", "C10 必须 pass");
  t.eq(result.checks.find((c) => c.id === "C07")?.status, "pass", "C07 必须 pass（源码 QUESTIONS 已加载）");
  for (const id of ["F01", "F02", "F03", "F04", "F05", "F06"]) {
    t.eq(result.checks.find((c) => c.id === id)?.status, "pass", `${id} 冻结基线必须 pass`);
  }
  t.eq(result.digests.questions.fromSource, FROZEN_BASELINE.questionsSha256, "源码投影 questionsSha256 必须等于基线");
  t.eq(result.digests.questions.fromFixturesProjection, FROZEN_BASELINE.questionsSha256, "fixtures 投影复算必须等于基线");
};

tests["K2H-3 sidecar：schema/两个产物的双哈希/字段语义全部与实际一致"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  if (!nodeFs.existsSync(SIDECAR)) return t.skip("hash-manifest.json 尚未生成（先跑 --emit-manifest）");
  const manifest = readJson(SIDECAR);
  const actual = buildHashManifest({ preregPath: PREREG, fixturesPath: FIXTURES });
  const preregArtifact = manifest.artifacts?.["prereg.json"];
  const fixturesArtifact = manifest.artifacts?.["fixtures.json"];

  t.eq(manifest.schema, HASH_MANIFEST_SCHEMA, "sidecar schema 必须是 k2-hash-semantics-v1");
  t.eq(Object.keys(manifest.artifacts ?? {}).sort(), ["fixtures.json", "prereg.json"], "sidecar 只记录两个冻结产物");
  for (const [name, artifact] of [
    ["prereg.json", preregArtifact],
    ["fixtures.json", fixturesArtifact],
  ]) {
    t.ok(artifact && typeof artifact === "object", `${name} 必须有 artifacts 条目`);
    t.eq(artifact.bytes, actual.artifacts[name].bytes, `${name} 字节数必须等于实际`);
    t.eq(artifact.rawBytesSha256, actual.artifacts[name].rawBytesSha256, `${name} raw-bytes-sha256 必须等于实际`);
    t.eq(artifact.canonicalJsonSha256, actual.artifacts[name].canonicalJsonSha256, `${name} canonical-json-sha256 必须等于实际`);
  }
  t.eq(
    manifest.fieldSemantics?.["fixtures.preregSha256"]?.semantics,
    "canonical-json-sha256",
    "preregSha256 语义必须声明为 canonical-json-sha256",
  );
  t.eq(
    manifest.fieldSemantics?.["fixtures.preregSha256"]?.value,
    readJson(FIXTURES).preregSha256,
    "sidecar 记录的 preregSha256 必须等于 fixtures 字段",
  );
  t.eq(
    manifest.fieldSemantics?.["fixtures.preregSha256"]?.mustNotCompareWith,
    "raw-bytes-sha256(prereg.json)",
    "必须显式禁止与 raw 文件哈希交叉比较",
  );
  t.eq(
    manifest.fieldSemantics?.["fixtures.questionsSha256"]?.projectionFields,
    [...PROJECTION_FIELDS],
    "questionsSha256 投影字段必须与产品口径一致",
  );
  t.eq(manifest.fieldSemantics?.["fixtures.questionsSha256"]?.excludedFields, ["hypothesis"], "hypothesis 必须被排除");
  t.eq(manifest.fieldSemantics?.["fixtures.questionsSha256"]?.value, readJson(FIXTURES).questionsSha256, "sidecar 记录的 questionsSha256 必须等于 fixtures 字段");
};

tests["K2H-4 校验器只读：跑前跑后冻结产物 raw sha256 不变"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const before = { prereg: sha256File(PREREG), fixtures: sha256File(FIXTURES) };
  const result = runCli(["--repo", REPO, "--json"]);
  const after = { prereg: sha256File(PREREG), fixtures: sha256File(FIXTURES) };
  t.eq(result.status, 0, `基线 CLI 必须 exit 0（实际 ${result.status}：${result.stderr.trim()}）`);
  t.eq(result.payload?.verdict, "PASS", "基线 CLI verdict 必须是 PASS");
  t.eq(before, after, "校验器不得修改冻结产物字节");
};

tests["K2H-5 反例：raw 文件哈希误写进 preregSha256 ⇒ exit 1 / HASH_MODE_MISMATCH"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("raw-mode");
  try {
    const fixtures = cloneJson(readJson(pair.fixturesPath));
    fixtures.preregSha256 = FROZEN_BASELINE.preregRawSha256;
    writeJson(pair.fixturesPath, fixtures);
    const result = runCli(["--prereg", pair.preregPath, "--fixtures", pair.fixturesPath, "--no-frozen", "--json"]);
    t.eq(result.status, 1, "误用 raw 口径必须 exit 1");
    t.eq(result.failing.includes("HASH_MODE_MISMATCH"), true, `必须报 HASH_MODE_MISMATCH：${result.failing.join(",")}`);
    t.eq(result.failing.includes("HASH_MODE_CONFUSION"), true, "C05 口径混淆守护也必须报红");
  } finally {
    pair.cleanup();
  }
};

tests["K2H-6 反例：篡改任一 answer ⇒ exit 1 / QUESTIONS_HASH_MISMATCH"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("answer-tamper");
  try {
    const fixtures = cloneJson(readJson(pair.fixturesPath));
    fixtures.questions[0].answer = `${fixtures.questions[0].answer}!`;
    writeJson(pair.fixturesPath, fixtures);
    const result = runCli(["--prereg", pair.preregPath, "--fixtures", pair.fixturesPath, "--no-frozen", "--json"]);
    t.eq(result.status, 1, "篡改答案必须 exit 1");
    t.eq(result.failing.includes("QUESTIONS_HASH_MISMATCH"), true, `必须报 QUESTIONS_HASH_MISMATCH：${result.failing.join(",")}`);
  } finally {
    pair.cleanup();
  }
};

tests["K2H-7 反例：篡改 prereg.objective ⇒ exit 1 / PREREG_CANONICAL_HASH_MISMATCH"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("prereg-tamper");
  try {
    const prereg = cloneJson(readJson(pair.preregPath));
    prereg.objective = `${prereg.objective}（篡改）`;
    writeJson(pair.preregPath, prereg);
    const result = runCli(["--prereg", pair.preregPath, "--fixtures", pair.fixturesPath, "--no-frozen", "--json"]);
    t.eq(result.status, 1, "篡改 prereg 必须 exit 1");
    t.eq(result.failing.includes("PREREG_CANONICAL_HASH_MISMATCH"), true, `必须报 PREREG_CANONICAL_HASH_MISMATCH：${result.failing.join(",")}`);
  } finally {
    pair.cleanup();
  }
};

tests["K2H-8 正例：只改缩进/顶层键序（raw 变、canonical 不变）⇒ 仍 PASS"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("reformat");
  try {
    const prereg = readJson(pair.preregPath);
    const reversed = {};
    for (const key of Object.keys(prereg).reverse()) reversed[key] = prereg[key];
    nodeFs.writeFileSync(pair.preregPath, `${JSON.stringify(reversed, null, 4)}\n`, "utf8");
    const rawNow = sha256File(pair.preregPath);
    const canonicalNow = canonicalJsonSha256(JSON.parse(nodeFs.readFileSync(pair.preregPath, "utf8")));
    const result = runCli(["--prereg", pair.preregPath, "--fixtures", pair.fixturesPath, "--no-frozen", "--json"]);
    t.ne(rawNow, FROZEN_BASELINE.preregRawSha256, "重排后 raw 哈希必须改变");
    t.eq(canonicalNow, FROZEN_BASELINE.preregCanonicalJsonSha256, "重排后 canonical 哈希必须不变");
    t.eq(result.status, 0, "canonical 语义未变时必须 exit 0（不得把格式化当篡改）");
    t.eq(result.payload?.summary?.failed, 0, "不得有 fail");
  } finally {
    pair.cleanup();
  }
};

tests["K2H-9 反例：sidecar 的 raw 记录与文件不符 ⇒ exit 1 / MANIFEST_RAW_MISMATCH"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("manifest-raw");
  try {
    const manifest = buildHashManifest({ preregPath: pair.preregPath, fixturesPath: pair.fixturesPath });
    manifest.artifacts["prereg.json"].rawBytesSha256 = "0".repeat(64);
    const manifestPath = nodePath.join(pair.dir, "hash-manifest.json");
    writeJson(manifestPath, manifest);
    const result = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(result.status, 1, "sidecar raw 错误必须 exit 1");
    t.eq(result.failing.includes("MANIFEST_RAW_MISMATCH"), true, `必须报 MANIFEST_RAW_MISMATCH：${result.failing.join(",")}`);
  } finally {
    pair.cleanup();
  }
};

tests["K2H-10 反例：sidecar 漏写 canonicalJsonSha256 ⇒ 不得默认通过（H3-O1）"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("manifest-missing-canonical");
  try {
    const manifest = buildHashManifest({ preregPath: pair.preregPath, fixturesPath: pair.fixturesPath });
    delete manifest.artifacts["prereg.json"].canonicalJsonSha256;
    const manifestPath = nodePath.join(pair.dir, "hash-manifest.json");
    writeJson(manifestPath, manifest);
    const result = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(result.status, 1, "缺 canonical 字段必须 exit 1");
    t.eq(result.failing.includes("MANIFEST_CANONICAL_MISSING"), true, `必须报 MANIFEST_CANONICAL_MISSING：${result.failing.join(",")}`);
  } finally {
    pair.cleanup();
  }
};

tests["K2H-11 反例：sidecar 的 fixtures canonical 记录错误 ⇒ exit 1 / MANIFEST_FIXTURES_CANONICAL_MISMATCH"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("manifest-fixtures-canonical");
  try {
    const manifest = buildHashManifest({ preregPath: pair.preregPath, fixturesPath: pair.fixturesPath });
    manifest.artifacts["fixtures.json"].canonicalJsonSha256 = "0".repeat(64);
    const manifestPath = nodePath.join(pair.dir, "hash-manifest.json");
    writeJson(manifestPath, manifest);
    const result = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(result.status, 1, "fixtures canonical 错误必须 exit 1");
    t.eq(
      result.failing.includes("MANIFEST_FIXTURES_CANONICAL_MISMATCH"),
      true,
      `必须报 MANIFEST_FIXTURES_CANONICAL_MISMATCH：${result.failing.join(",")}`,
    );
  } finally {
    pair.cleanup();
  }
};

tests["K2H-12 sidecar 生成闭环：emit ⇒ 校验全过；重复 emit 拒绝覆盖（exit 2）"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const pair = makePair("emit");
  try {
    const manifestPath = nodePath.join(pair.dir, "hash-manifest.json");
    const emitted = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--emit-manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(emitted.status, 0, `emit 必须 exit 0（实际 ${emitted.status}：${emitted.stderr.trim()}）`);
    t.eq(nodeFs.existsSync(manifestPath), true, "emit 必须真的写出 sidecar");
    const verified = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(verified.status, 0, "生成后复核必须 exit 0");
    t.eq(verified.payload?.summary?.failed, 0, "复核不得有 fail");
    t.eq(verified.payload?.summary?.skipped, 0, "带 sidecar 时不得跳过 M01-M06");
    const reEmit = runCli([
      "--prereg",
      pair.preregPath,
      "--fixtures",
      pair.fixturesPath,
      "--emit-manifest",
      manifestPath,
      "--no-frozen",
      "--json",
    ]);
    t.eq(reEmit.status, 2, "已存在 sidecar 时重复 emit 必须 exit 2");
  } finally {
    pair.cleanup();
  }
};

tests["K2H-13 反例：缺 prereg 文件 ⇒ exit 2（输入错误，不是哈希失败）"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "k2h-missing-"));
  try {
    const result = runCli([
      "--prereg",
      nodePath.join(dir, "does-not-exist.json"),
      "--fixtures",
      FIXTURES,
      "--no-frozen",
      "--json",
    ]);
    t.eq(result.status, 2, "文件缺失必须 exit 2");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["K2H-14 门禁模式：--require-source 在源码模块缺失时必须判红（H3-O2）"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const repo = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "k2h-nosource-"));
  const artifactDir = nodePath.join(repo, "tmp", "axiom-2026-11-07", "ax03");
  try {
    nodeFs.mkdirSync(artifactDir, { recursive: true });
    nodeFs.copyFileSync(PREREG, nodePath.join(artifactDir, "prereg.json"));
    nodeFs.copyFileSync(FIXTURES, nodePath.join(artifactDir, "fixtures.json"));
    const result = runCli(["--repo", repo, "--no-frozen", "--require-source", "--json"]);
    t.eq(result.status, 1, "缺源码模块且要求门禁时必须 exit 1");
    t.eq(result.failing.includes("SOURCE_REQUIRED_MISSING"), true, `必须报 SOURCE_REQUIRED_MISSING：${result.failing.join(",")}`);
  } finally {
    nodeFs.rmSync(repo, { recursive: true, force: true });
  }
};

tests["K2H-15 独立性：校验脚本不 import 宿主包，也不静态 import 产品 reader"] = (t) => {
  const source = nodeFs.readFileSync(CLI, "utf8");
  // 只判「真的 import 了宿主包」：注释里说明「不 import @deepseek-ai/*」不算违规。
  const hostImport = /(?:^|\n)\s*(?:import|export)[^\n]*from\s*["']@deepseek-ai\/|(?:^|\n)\s*import\s+["']@deepseek-ai\/|import\s*\(\s*["']@deepseek-ai\//;
  t.eq(hostImport.test(source), false, "校验脚本不得 import 宿主包");
  t.eq(/^\s*import[^\n]*k2-value-reader/m.test(source), false, "不得静态 import 产品 reader（只能按需动态加载）");
  const readerSource = nodeFs.readFileSync(READER, "utf8");
  t.notIncludes(readerSource, "k2-hash-check", "reader 默认路径不得接入本校验器");
  t.notIncludes(readerSource, "verifyPreregArtifacts", "reader 默认行为保持不变");
};

tests["K2H-16 内置自测：--self-test 全绿（12 个正反例）"] = (t) => {
  if (!artifactsPresent()) return t.skip("冻结产物不在 tmp/（干净 checkout）");
  const result = runCli(["--self-test", "--json"]);
  t.eq(result.status, 0, `self-test 必须 exit 0（实际 ${result.status}：${result.stderr.trim()}）`);
  t.eq(result.payload?.ok, true, "self-test verdict 必须是 PASS");
  t.eq(result.payload?.summary?.failed, 0, "self-test 不得有 failed");
  t.eq(result.payload?.summary?.total, 12, "self-test 用例数必须是 12");
};