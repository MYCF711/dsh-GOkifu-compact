/**
 * query-recall-pilot.test.mjs —— Q1 查询召回 Stage B runner 的门禁（0 模型调用）
 *
 * 钉住的不是「召回质量」，而是 **Stage B 的评测装置本身能不能判红判绿**：
 *   ① 冻结 sha 对账（含 M-4 新增的 `frozenInputs.impl` / `stageAEvidenceSha256`）；
 *   ② Stage A 闸门（证据缺失 / 非 PASS / 实现漂移 ⇒ 联网前退出）；
 *   ③ Stage A 性能闸门（只认 `evidence/query-recall-stage-a-perf.json` 的 p95 ≤ 25，不收裸声明）；
 *   ④ 授权闸门（缺 --authorize / 口令不符 / 已废弃的 --stage-a-p95 ⇒ 0 次调用）；
 *   ⑤ 预算闸（120 硬上限，第 121 次调用在结构上不存在）；
 *   ⑥ 两臂差异仅为召回块（空召回时两臂逐字相同）；
 *   ⑦ mock 120 次后能算多数票 / UNKNOWN / 饱和 / 逐题回归 / 决策；
 *   ⑧ 篡改 prereg / fixture / evidence / impl / perf / reader 口径 ⇒ 必须拒绝；
 *   ⑨ M-5 决策上限：本合成题集最高 POSITIVE_SIGNAL，绝不 ADOPT；饱和按可计分题算。
 *
 * 真实树的 Stage A 冻结哈希可能正由 Lead 重新登记（本轮 fixtures/脚本已改）：
 * 因此**流水线用例都在临时树里跑**，临时树先按当前字节生成一份自洽的冻结清单，
 * 真实树只断言一条不变式 —— 「dry-run 的退出码必须与真实冻结状态一致」。
 *
 * 不联网、不写仓库 evidence、不 commit；临时目录用完即删（只落在 os.tmpdir）。
 */

import { spawnSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZE_TOKEN,
  DECISION_CAP,
  EXIT,
  MAX_CALLS,
  PATHS,
  READER_DEFAULTS,
  REPO,
  SAMPLES_PER_ARM,
  TRANSPORT_SPEC,
  buildPlan,
  buildPublicFile,
  buildRequest,
  buildResultsFile,
  charLength,
  checkFrozenInputs,
  checkDecisionPolicy,
  checkFrozenTransport,
  checkStageA,
  checkStageAPerf,
  classifySample,
  createBudget,
  evaluateRun,
  main,
  majorityOf,
  runStageB,
} from "../scripts/query-recall-pilot.mjs";
import { READER_PROMPTS } from "../scripts/lme-pilot-reader.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SCRIPT = nodePath.join(REPO, "scripts", "query-recall-pilot.mjs");
const readJson = (file) => JSON.parse(nodeFs.readFileSync(file, "utf8"));
const prereg = readJson(nodePath.join(REPO, PATHS.prereg));
const sha256 = (buffer) => nodeCrypto.createHash("sha256").update(buffer).digest("hex");

export const tests = {};

/* ───────────────────────────── 测试装置 ───────────────────────────── */

const REPO_FILES = [PATHS.prereg, PATHS.fixtures, PATHS.stageAEvidence, PATHS.stageAPerf, PATHS.stageAScript, PATHS.stageATest, PATHS.reader, PATHS.grader, PATHS.impl];

function at(dir, relative) {
  return nodePath.join(dir, ...relative.split("/"));
}

function shaOf(dir, relative) {
  return sha256(nodeFs.readFileSync(at(dir, relative)));
}

/**
 * 临时仓库树：先把当前字节复制进去，再**按这些字节生成一份自洽的冻结清单**
 * （预注册 frozenInputs + Stage A 证据的 fixtures/impl sha），这样流水线用例不受
 * 真实 pre reg 登记进度影响；`omit` / `mutate` 用来制造各种失败分支。
 */
function makeRepo({ omit = [], mutate = null, registerImpl = true, registerEvidence = true } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "q1-stage-b-"));
  for (const relative of REPO_FILES) {
    const target = at(dir, relative);
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
    nodeFs.writeFileSync(target, nodeFs.readFileSync(at(REPO, relative)));
  }
  for (const relative of omit) nodeFs.rmSync(at(dir, relative), { force: true });

  const hasEvidence = nodeFs.existsSync(at(dir, PATHS.stageAEvidence));
  if (hasEvidence) {
    const evidence = readJson(at(dir, PATHS.stageAEvidence));
    evidence.fixtures = { ...(evidence.fixtures ?? {}), sha256: shaOf(dir, PATHS.fixtures), tasks: evidence.fixtures?.tasks ?? null };
    if (registerImpl) evidence.impl = { ...(evidence.impl ?? {}), sha256: shaOf(dir, PATHS.impl) };
    else if (evidence.impl) delete evidence.impl.sha256;
    nodeFs.writeFileSync(at(dir, PATHS.stageAEvidence), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  const patched = readJson(at(dir, PATHS.prereg));
  patched.frozenInputs = {
    ...(patched.frozenInputs ?? {}),
    stageAFixtures: shaOf(dir, PATHS.fixtures),
    stageAScript: shaOf(dir, PATHS.stageAScript),
    stageATest: shaOf(dir, PATHS.stageATest),
    reader: shaOf(dir, PATHS.reader),
    grader: shaOf(dir, PATHS.grader),
  };
  if (registerImpl) patched.frozenInputs.impl = shaOf(dir, PATHS.impl);
  if (registerEvidence && hasEvidence) patched.frozenInputs.stageAEvidenceSha256 = shaOf(dir, PATHS.stageAEvidence);
  patched.stageGate.stageA.fixture.sha256 = shaOf(dir, PATHS.fixtures);
  patched.stageGate.stageA.script.sha256 = shaOf(dir, PATHS.stageAScript);
  if (nodeFs.existsSync(at(dir, PATHS.stageAPerf))) patched.stageGate.perf.sha256 = shaOf(dir, PATHS.stageAPerf);
  patched.design.frozenReader.sha256 = shaOf(dir, PATHS.reader);
  patched.design.grader.sha256 = shaOf(dir, PATHS.grader);
  nodeFs.writeFileSync(at(dir, PATHS.prereg), `${JSON.stringify(patched, null, 2)}\n`, "utf8");

  if (typeof mutate === "function") mutate(dir);
  return dir;
}

function cleanup(dir) {
  try {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

function writeJsonAt(dir, relative, value) {
  nodeFs.writeFileSync(at(dir, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tempPrereg(dir) {
  return readJson(at(dir, PATHS.prereg));
}

/** 计数型 spy transport：只证明「有没有调用」，不联网。 */
function makeSpyTransport() {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    throw new Error("spy transport must never be called in this test");
  };
  return { calls, transport };
}

/** 可编排的 mock transport：按 (task, arm) 返回脚本化答案；顺带记录调用顺序。 */
function makeMockTransport(plan, pick, { usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }, latencyMs = 10 } = {}) {
  const calls = [];
  const transport = async (request) => {
    const task = plan.tasks.find((entry) => entry.id === request.taskId);
    calls.push({ index: request.index, taskId: request.taskId, arm: request.arm, sample: request.sample });
    const answer = pick(task, request.arm, request.sample);
    return { raw: answer === null || answer === undefined ? null : String(answer), finishReason: "stop", usage: { ...usage }, latencyMs };
  };
  return { calls, transport };
}

/** 用脚本化答案直接造记录（跳过执行层，专测判定）。 */
function scriptedRecords(plan, pick) {
  const records = [];
  let index = 0;
  for (const task of plan.tasks) {
    for (const arm of plan.arms) {
      for (let sample = 0; sample < plan.samplesPerArm; sample += 1) {
        index += 1;
        const answer = pick(task, arm, sample);
        const raw = answer === null || answer === undefined ? null : String(answer);
        records.push({
          index,
          taskId: task.id,
          arm,
          sample,
          ok: raw !== null,
          raw,
          normalized: raw ?? "",
          graded: String(raw ?? "").toLowerCase(),
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          latencyMs: 10,
          finishReason: raw === null ? "error" : "stop",
          error: raw === null ? "reader returned no content" : null,
        });
      }
    }
  }
  return records;
}

/** 最小合成计划（只供 evaluateRun 用）。 */
function fakePlan(tasks) {
  return {
    experimentId: AUTHORIZE_TOKEN,
    baseContext: "合成基线",
    tasks: tasks.map((task, index) => ({
      index,
      id: task.id,
      family: task.family ?? "file",
      derivableFrom: task.derivableFrom ?? "recall",
      gold: task.gold,
      aliases: task.aliases ?? [],
      options: { limit: 6, maxChars: 1200 },
      recall: { chars: 0, items: 0, truncated: false, text: "" },
      contextA0: "合成基线",
      contextA1: "合成基线",
      arms: { A0: { id: task.id, arm: "A0", question: "q", context: "合成基线" }, A1: { id: task.id, arm: "A1", question: "q", context: "合成基线" } },
    })),
    arms: ["A0", "A1"],
    samplesPerArm: SAMPLES_PER_ARM,
    calls: tasks.length * 2 * SAMPLES_PER_ARM,
    retries: 0,
    maxCalls: MAX_CALLS,
  };
}

/** A0 只答基线可推的 8 题；A1 答对除弃答题外的全部。 */
function defaultPick(task, arm) {
  const abstentionGold = String(task.gold).trim().toUpperCase() === "UNKNOWN";
  if (arm === "A0") return task.derivableFrom === "base-context" ? task.gold : "UNKNOWN";
  return abstentionGold ? "UNKNOWN" : task.gold;
}

function spyLogger() {
  const lines = [];
  return { lines, logger: { log: (line = "") => lines.push(String(line)), error: (line = "") => lines.push(String(line)) } };
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 120_000, env: { ...process.env, ...env } });
}

async function runIn(dir, extraArgs = [], { transport, logger } = {}) {
  const spy = makeSpyTransport();
  const capture = spyLogger();
  const code = await main(["--repo", dir, ...extraArgs], { transport: transport ?? spy.transport, logger: logger ?? capture.logger });
  return { code, calls: spy.calls, lines: capture.lines, output: capture.lines.join("\n") };
}

async function withEnv(fn) {
  const saved = { model: process.env.LME_READER_MODEL, endpoint: process.env.LME_READER_ENDPOINT };
  process.env.LME_READER_MODEL = "test-reader-model";
  process.env.LME_READER_ENDPOINT = "http://127.0.0.1:1/v1/chat/completions";
  try {
    return await fn();
  } finally {
    if (saved.model === undefined) delete process.env.LME_READER_MODEL;
    else process.env.LME_READER_MODEL = saved.model;
    if (saved.endpoint === undefined) delete process.env.LME_READER_ENDPOINT;
    else process.env.LME_READER_ENDPOINT = saved.endpoint;
  }
}

/* ───────────────────────────── ① 冻结输入 / Stage A / 性能 ───────────────────────────── */

tests["真实树 dry-run：退出码必须与真实冻结状态一致（同步 ⇒ 0；未同步 ⇒ 拒绝并点名，且 0 调用）"] = async (t) => {
  const frozen = checkFrozenInputs({ repo: REPO, prereg });
  const stageA = checkStageA({ repo: REPO, prereg });
  const perf = checkStageAPerf({ repo: REPO, prereg });
  const plannedReal = buildPlan({ repo: REPO, prereg });
  const policy = plannedReal.ok ? checkDecisionPolicy({ prereg, plan: plannedReal.plan }) : { ok: false };
  const synced = frozen.ok && stageA.ok && perf.ok && plannedReal.ok && policy.ok;
  const spy = makeSpyTransport();
  const capture = spyLogger();
  const code = await main([], { transport: spy.transport, logger: capture.logger });
  t.eq(spy.calls.length, 0, "dry-run 一次调用都不许发");
  if (synced) {
    t.eq(code, EXIT.OK, "冻结状态自洽时 dry-run 必须 exit 0");
    t.includes(capture.lines.join("\n"), "calls=120", "自洽时必须打印 calls=120");
  } else {
    t.eq(code, EXIT.PRECONDITION, `冻结状态未同步时必须拒绝（当前未同步项：${frozen.errors.concat(stageA.errors, perf.errors).slice(0, 2).join("；")}）`);
    t.includes(capture.lines.join("\n"), "失败", "拒绝时必须说清哪一道闸门没过");
  }
};

tests["一致树：冻结输入 7 键全过（含 impl / stageAEvidenceSha256）"] = (t) => {
  const dir = makeRepo();
  try {
    const result = checkFrozenInputs({ repo: dir, prereg: tempPrereg(dir) });
    t.ok(result.ok, `一致树必须全过：${result.errors.join("；")}`);
    t.eq(result.checks.length, 7, "七个冻结键都要核对");
    t.eq(result.unregistered, [], "一致树里不应有未登记键");
    for (const check of result.checks) t.ok(check.registered && check.ok, `键 ${check.key} 必须已登记且匹配`);
  } finally {
    cleanup(dir);
  }
};

tests["一致树：Stage A PASS（15/15、hitRate=1）且 impl.sha256 与当前实现一致"] = (t) => {
  const dir = makeRepo();
  try {
    const gate = checkStageA({ repo: dir, prereg: tempPrereg(dir) });
    t.ok(gate.ok, `Stage A 必须 PASS：${gate.errors.join("；")}`);
    t.eq(gate.status, "PASS", "状态必须 PASS");
    t.eq(gate.aggregate.total, 15, "15 题");
    t.eq(gate.aggregate.passed, 15, "15 通过");
    t.eq(gate.aggregate.hitRate, 1, "证据命中率 1");
    t.eq(gate.aggregate.misses, 0, "0 漏召");
    t.eq(gate.aggregate.falsePositives, 0, "0 误召");
    t.eq(gate.impl.registered, true, "证据里必须登记 impl.sha256");
    t.eq(gate.impl.declared, shaOf(dir, PATHS.impl), "impl sha 必须等于当前实现");
    t.eq(gate.impl.ok, true, "impl 检查必须通过");
  } finally {
    cleanup(dir);
  }
};

tests["一致树：性能证据 p95 ≤ 25ms 且 deltaError=false"] = (t) => {
  const dir = makeRepo();
  try {
    const perf = checkStageAPerf({ repo: dir, prereg: tempPrereg(dir) });
    t.ok(perf.ok, `性能闸门必须过：${perf.errors.join("；")}`);
    t.ok(Number.isFinite(perf.p95) && perf.p95 <= 25, `p95 必须 ≤25：${perf.p95}`);
    t.eq(perf.deltaError, false, "deltaError 必须 false");
    t.ok(Number(perf.samples) > 0, "必须有样本数");
    t.eq(perf.checks.length, 5, "render / derived / max / deltaError / perf.sha256 五项检查");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ② 计划 / dry-run ───────────────────────────── */

tests["一致树：dry-run 恰好 120 计划、两臂同题同参数、0 次调用"] = async (t) => {
  const dir = makeRepo();
  try {
    const planned = buildPlan({ repo: dir, prereg: tempPrereg(dir) });
    t.ok(planned.ok, `计划必须成立：${planned.errors.join("；")}`);
    const plan = planned.plan;
    t.eq(plan.tasks.length, 20, "20 题");
    t.eq(plan.arms, ["A0", "A1"], "两臂 A0/A1");
    t.eq(plan.samplesPerArm, 3, "每臂 3 样本");
    t.eq(plan.calls, 120, "合计 120");
    t.eq(plan.calls, plan.tasks.length * plan.arms.length * plan.samplesPerArm, "20 × 2 × 3");
    t.eq(plan.retries, 0, "0 重试");
    for (const task of plan.tasks) {
      t.eq(task.arms.A0.question, task.arms.A1.question, `${task.id} 两臂题面相同`);
      t.eq(task.arms.A0.id, task.arms.A1.id, `${task.id} 两臂题号相同`);
      t.ok(task.recall.chars <= task.options.maxChars, `${task.id} 召回块不超 maxChars`);
      t.ok(task.recall.items <= task.options.limit, `${task.id} 召回行不超 limit`);
    }
    const result = await runIn(dir);
    t.eq(result.code, EXIT.OK, `一致树 dry-run 必须 exit 0：${result.output.slice(0, 300)}`);
    t.eq(result.calls.length, 0, "0 次调用");
    t.includes(result.output, "calls=120", "必须打印 calls=120");
    t.includes(result.output, "网络：none", "必须声明没有网络");
    t.includes(result.output, "两臂核对", "必须打印两臂核对");
    t.eq(nodeFs.existsSync(at(dir, PATHS.results)), false, "dry-run 不许写结果文件");
    t.eq(nodeFs.existsSync(at(dir, PATHS.public)), false, "dry-run 不许写公开文件");
  } finally {
    cleanup(dir);
  }
};

tests["一致树：dry-run CLI 逐题打印两臂字符数（20 行）"] = (t) => {
  const dir = makeRepo();
  try {
    const result = runCli(["--repo", dir]);
    t.eq(result.status, 0, `dry-run 必须 exit 0：${result.stderr}`);
    const output = String(result.stdout);
    t.includes(output, "calls=120", "必须打印 calls=120");
    t.includes(output, "retries=0", "必须打印 retries=0");
    t.includes(output, "网络：none", "必须声明未联网");
    t.includes(output, "p95=", "必须打印 Stage A 性能 p95");
    const rows = output.split(/\r?\n/).filter((line) => /^B-\d{2}\s/.test(line));
    t.eq(rows.length, 20, "每道题一行");
    for (const row of rows) t.ok(row.trim().split(/\s+/).length >= 8, `行内要有两臂字符数：${row}`);
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ③ 闸门：拒绝时 0 网络 ───────────────────────────── */

tests["Stage A 证据缺失 ⇒ PRECONDITION、0 次调用"] = async (t) => {
  const dir = makeRepo({ omit: [PATHS.stageAEvidence], registerEvidence: false });
  try {
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "Stage A 证据缺失必须拒绝");
    t.eq(result.calls.length, 0, "0 次调用");
    t.includes(result.output, "query-recall-stage-a.json", "要点名缺的是哪份证据");
    t.eq(nodeFs.existsSync(at(dir, PATHS.results)), false, "拒绝时不许写结果");
  } finally {
    cleanup(dir);
  }
};

tests["Stage A 非 PASS ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const evidence = readJson(at(root, PATHS.stageAEvidence));
      evidence.status = "FAIL";
      evidence.aggregate.failed = 1;
      writeJsonAt(root, PATHS.stageAEvidence, evidence);
      const patched = readJson(at(root, PATHS.prereg));
      patched.frozenInputs.stageAEvidenceSha256 = shaOf(root, PATHS.stageAEvidence);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "非 PASS 必须拒绝");
    t.eq(result.calls.length, 0, "0 次调用");
  } finally {
    cleanup(dir);
  }
};

tests["Stage A 证据里的 impl.sha256 被篡改 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const evidence = readJson(at(root, PATHS.stageAEvidence));
      evidence.impl.sha256 = "0".repeat(64);
      writeJsonAt(root, PATHS.stageAEvidence, evidence);
      const patched = readJson(at(root, PATHS.prereg));
      patched.frozenInputs.stageAEvidenceSha256 = shaOf(root, PATHS.stageAEvidence);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const gate = checkStageA({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(gate.ok, false, "impl 漂移必须判红");
    t.includes(gate.errors.join(" | "), "impl.sha256", "要点名 impl");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝运行");
    t.eq(result.calls.length, 0, "0 次调用");
  } finally {
    cleanup(dir);
  }
};

tests["Stage A 性能证据缺失 / p95=30 ⇒ 拒绝（不接受裸声明）"] = async (t) => {
  const missing = makeRepo({ omit: [PATHS.stageAPerf] });
  const slow = makeRepo({
    mutate: (root) => {
      const perf = readJson(at(root, PATHS.stageAPerf));
      perf.bench.renderMs.p95 = 30;
      writeJsonAt(root, PATHS.stageAPerf, perf);
      const patched = readJson(at(root, PATHS.prereg));
      patched.stageGate.perf.sha256 = shaOf(root, PATHS.stageAPerf);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const gateMissing = checkStageAPerf({ repo: missing });
    t.eq(gateMissing.ok, false, "缺性能证据必须判红");
    t.includes(gateMissing.errors.join(" | "), "query-recall-stage-a-perf.json", "要点名性能证据文件");
    const resultMissing = await runIn(missing, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(resultMissing.code, EXIT.PRECONDITION, "缺性能证据必须拒绝");
    t.eq(resultMissing.calls.length, 0, "0 次调用");

    const gateSlow = checkStageAPerf({ repo: slow, prereg: tempPrereg(slow) });
    t.eq(gateSlow.ok, false, "p95=30 必须判红");
    t.eq(gateSlow.p95, 30, "读到的 p95");
    const resultSlow = await runIn(slow, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(resultSlow.code, EXIT.PRECONDITION, "p95 超门槛必须拒绝");
    t.eq(resultSlow.calls.length, 0, "0 次调用");
  } finally {
    cleanup(missing);
    cleanup(slow);
  }
};

tests["性能证据被篡改（p95=1，prereg 的 sha 没更新）⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const perf = readJson(at(root, PATHS.stageAPerf));
      perf.bench.renderMs.p95 = 1;
      writeJsonAt(root, PATHS.stageAPerf, perf);
    },
  });
  try {
    const gate = checkStageAPerf({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(gate.ok, false, "字节被改必须判红");
    t.eq(gate.shaOk, false, "sha 必须不符");
    t.includes(gate.errors.join(" | "), "被改", "要点名性能证据被改");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝运行");
    t.eq(result.calls.length, 0, "0 次调用");
  } finally {
    cleanup(dir);
  }
};

tests["派生查询 p95 更高（render=1 / derived=30）⇒ 取 max 后拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const perf = readJson(at(root, PATHS.stageAPerf));
      perf.bench.renderMs.p95 = 1;
      perf.bench.derivedRenderMs.p95 = 30;
      writeJsonAt(root, PATHS.stageAPerf, perf);
      const patched = readJson(at(root, PATHS.prereg));
      patched.stageGate.perf.sha256 = shaOf(root, PATHS.stageAPerf);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const gate = checkStageAPerf({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(gate.shaOk, true, "sha 已同步");
    t.eq(gate.p95, 30, "取 max 后是 30");
    t.eq(gate.ok, false, "必须拒绝（派生查询不能被固定 query 掩盖）");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝运行");
    t.eq(result.calls.length, 0, "0 次调用");
  } finally {
    cleanup(dir);
  }
};

tests["预注册 decisionCap 被改成 ADOPT ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.decisionCap = "ADOPT";
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const result = await runIn(dir);
    t.eq(result.code, EXIT.PRECONDITION, "上限被改必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
    t.includes(result.output, "decisionCap", "要点名 decisionCap");
  } finally {
    cleanup(dir);
  }
};

tests["预注册 saturation.scorableTasks 与题集不符 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.saturation = { ...(patched.saturation ?? {}), scorableTasks: 20 };
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const result = await runIn(dir);
    t.eq(result.code, EXIT.PRECONDITION, "可计分题数漂移必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
    t.includes(result.output, "scorableTasks", "要点名 scorableTasks");
  } finally {
    cleanup(dir);
  }
};

tests["缺授权 / 口令不符 / 废弃的 --stage-a-p95 ⇒ 0 次调用"] = async (t) => {
  const dir = makeRepo();
  try {
    for (const extra of [["--run"], ["--run", "--authorize", "wrong-token"], ["--stage-a-p95", "18.561"]]) {
      const result = await runIn(dir, extra);
      t.eq(result.code, EXIT.USAGE, `必须 USAGE 退出：${extra.join(" ")}`);
      t.eq(result.calls.length, 0, `拒绝时必须 0 调用：${extra.join(" ")}`);
      if (extra[0] === "--stage-a-p95") t.includes(result.output, "已废弃", "要说明 p95 只认落盘证据");
    }
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ④ 预算硬上限 ───────────────────────────── */

tests["预算：第 121 次调用不存在"] = async (t) => {
  const budget = createBudget(MAX_CALLS);
  for (let index = 1; index <= MAX_CALLS; index += 1) t.eq(budget.take(`call-${index}`), index, `第 ${index} 次 take 成功`);
  let threw = null;
  try {
    budget.take("call-121");
  } catch (error) {
    threw = error;
  }
  t.ok(threw !== null, "第 121 次 take 必须抛");
  t.eq(threw?.code, "BUDGET_EXCEEDED", "错误类型可识别");
  let capThrew = false;
  try {
    createBudget(MAX_CALLS + 1);
  } catch {
    capThrew = true;
  }
  t.ok(capThrew, "cap 不许超过 120");

  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const mock = makeMockTransport(plan, defaultPick);
    const run = await runStageB({ plan, transport: mock.transport, budget: createBudget(MAX_CALLS) });
    t.eq(run.records.length, MAX_CALLS, "恰好 120 条记录");
    t.eq(run.callsUsed, MAX_CALLS, "用满 120");
    t.eq(mock.calls.length, MAX_CALLS, "transport 恰好 120 次");
    t.eq(mock.calls[0].index, 1, "第一次编号 1");
    t.eq(mock.calls[MAX_CALLS - 1].index, MAX_CALLS, "最后一次编号 120");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ⑤ 两臂差异 ───────────────────────────── */

tests["A0/A1 差异仅为召回块（空召回时逐字相同）"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    let emptyRecall = 0;
    for (const task of plan.tasks) {
      if (task.recall.chars === 0) {
        emptyRecall += 1;
        t.eq(task.contextA1, task.contextA0, `${task.id} 空召回两臂逐字相同`);
        continue;
      }
      t.eq(task.contextA1, `${task.contextA0}\n\n${task.recall.text}`, `${task.id} A1 = A0 + 两换行 + 召回块`);
      t.ok(task.contextA1.startsWith(task.contextA0), `${task.id} 保留完整基线`);
      t.includes(task.recall.text, "## 当前问题相关证据（机械召回）", `${task.id} 召回块带标题`);
      t.ok(charLength(task.contextA1) > charLength(task.contextA0), `${task.id} A1 更长`);
      const messages = buildRequest(task, "A1");
      t.eq(messages.length, 2, "system + user 两条消息");
      t.eq(messages[1].content, `Context:\n${task.contextA1}\n\nQuestion: ${task.query}\n\nAnswer:`, `${task.id} 请求逐字来自冻结 reader`);
    }
    t.ok(emptyRecall >= 1, "至少一道空召回题（B-19）");
    const payload = plan.tasks[0].arms.A1;
    t.eq(Object.keys(payload).sort(), ["arm", "context", "id", "question"], "payload 只有四字段");
    t.eq(JSON.stringify(payload).includes("gold"), false, "payload 不带金标准");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ⑥ 判定（mock） ───────────────────────────── */

tests["mock 120 次：A1 18/18 ⇒ 可计分题饱和 + 决策上限，只能 POSITIVE_SIGNAL"] = async (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const mock = makeMockTransport(plan, defaultPick);
    const run = await runStageB({ plan, transport: mock.transport, budget: createBudget(MAX_CALLS) });
    t.eq(run.records.length, 120, "120 条逐样本记录");
    t.eq(mock.calls.slice(0, 6).map((call) => `${call.taskId}/${call.arm}/${call.sample}`), ["B-01/A0/0", "B-01/A0/1", "B-01/A0/2", "B-01/A1/0", "B-01/A1/1", "B-01/A1/2"], "每题先 A0 × 3 再 A1 × 3");
    t.eq(mock.calls[6].taskId, "B-02", "按题号顺序");
    const evaluation = evaluateRun({ plan, records: run.records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.incomplete, false, "数据齐全");
    t.eq(evaluation.aggregate.A0.majorityCorrect, 8, "A0 只答得出基线 8 题");
    t.eq(evaluation.aggregate.A1.majorityCorrect, 18, "A1 答对 18 题");
    t.eq(evaluation.aggregate.A1.unknownSamples, 6, "A1 只在两道弃答题上 UNKNOWN");
    t.eq(evaluation.scorableTasks, 18, "可计分题 = 18（两道 UNKNOWN 题不算分）");
    t.eq(evaluation.saturationTriggered, true, "A1 18/18 必须算饱和");
    t.eq(evaluation.decision, "POSITIVE_SIGNAL", "饱和 + 上限 ⇒ POSITIVE_SIGNAL");
    t.eq(evaluation.adoption, "NOT_ADOPTED", "绝不 ADOPT");
    t.eq(evaluation.decisionCap, DECISION_CAP, "决策上限已写入结果");
    t.eq(evaluation.gates.saturationCap, false, "饱和门必须 false");
    t.eq(evaluation.gates.pairedNoRegression, true, "无逐题回归");
    t.eq(evaluation.gates.unknownNotIncreased, true, "UNKNOWN 不增");
    t.eq(evaluation.aggregate.A1.tokensPerCorrectMajority <= evaluation.aggregate.A0.tokensPerCorrectMajority, true, "token 效率不劣");
  } finally {
    cleanup(dir);
  }
};

tests["mock 有增益但不饱和（A1 17/18）⇒ 决策上限仍然只给 POSITIVE_SIGNAL"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const records = scriptedRecords(plan, (task, arm) => {
      if (arm === "A1" && task.id === "B-09") return "e9"; // 召回题答错，A0 在这题是 UNKNOWN
      return defaultPick(task, arm);
    });
    const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.aggregate.A0.majorityCorrect, 8, "A0 = 8");
    t.eq(evaluation.aggregate.A1.majorityCorrect, 17, "A1 = 17");
    t.eq(evaluation.saturationTriggered, false, "17 < 18 未饱和");
    t.eq(evaluation.regression, [], "无回归");
    t.eq(evaluation.gates.stageA, true, "Stage A 门过");
    t.eq(evaluation.decision, "POSITIVE_SIGNAL", "有增益也绝不 ADOPT（M-5 上限）");
    t.eq(evaluation.adoption, "NOT_ADOPTED", "不得采纳");
    t.includes(evaluation.decisionReasons.join(" "), "绝不 ADOPT", "理由里要写明上限");
  } finally {
    cleanup(dir);
  }
};

tests["mock 20/20 全可计分饱和 ⇒ 仍 POSITIVE_SIGNAL"] = (t) => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `T-${String(index + 1).padStart(2, "0")}`, family: "file", gold: "e2", aliases: ["e2"], derivableFrom: "recall" }));
  const plan = fakePlan(tasks);
  const records = scriptedRecords(plan, () => "e2");
  const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
  t.eq(evaluation.aggregate.A0.majorityCorrect, 20, "A0 饱和");
  t.eq(evaluation.aggregate.A1.majorityCorrect, 20, "A1 饱和");
  t.eq(evaluation.scorableTasks, 20, "20 道全可计分");
  t.eq(evaluation.saturationTriggered, true, "饱和必须识别");
  t.eq(evaluation.decision, "POSITIVE_SIGNAL", "只能 POSITIVE_SIGNAL");
  t.eq(evaluation.adoption, "NOT_ADOPTED", "不得采纳");
  t.eq(evaluation.gates.saturationCap, false, "饱和门 false");
};

tests["mock 逐题回归 ⇒ NEGATIVE_SIGNAL"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const records = scriptedRecords(plan, (task, arm) => (task.id === "B-01" && arm === "A1" ? "e9" : defaultPick(task, arm)));
    const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.regression, ["B-01"], "逐题回归被点名");
    t.eq(evaluation.decision, "NEGATIVE_SIGNAL", "有回归 ⇒ NEGATIVE_SIGNAL");
    t.eq(evaluation.adoption, "NOT_ADOPTED", "不得采纳");
  } finally {
    cleanup(dir);
  }
};

tests["mock UNKNOWN 增加 ⇒ 不得 ADOPT"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const records = scriptedRecords(plan, (task, arm) => {
      const abstentionGold = String(task.gold).trim().toUpperCase() === "UNKNOWN";
      if (arm === "A0") {
        if (abstentionGold) return "e9";
        if (task.id === "B-20") return "e1";
        return task.gold;
      }
      return abstentionGold ? "UNKNOWN" : task.gold;
    });
    const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.aggregate.A0.majorityCorrect, 17, "A0 = 17");
    t.eq(evaluation.aggregate.A1.majorityCorrect, 18, "A1 = 18");
    t.eq(evaluation.gates.unknownNotIncreased, false, "UNKNOWN 增加门必须红");
    t.eq(evaluation.decision, "POSITIVE_SIGNAL", "有增益但 UNKNOWN 变多 ⇒ 只记 POSITIVE_SIGNAL");
    t.eq(evaluation.adoption, "NOT_ADOPTED", "不得采纳");
  } finally {
    cleanup(dir);
  }
};

tests["mock 样本级全同 ⇒ NO_DIFFERENCE"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const records = scriptedRecords(plan, (task) => {
      if (String(task.gold).trim().toUpperCase() === "UNKNOWN") return "UNKNOWN";
      return task.id === "B-09" ? "e1" : task.gold; // 两臂都在同一题上答错 ⇒ 相等且不饱和
    });
    const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.aggregate.A0.majorityCorrect, evaluation.aggregate.A1.majorityCorrect, "两臂多数票相同");
    t.eq(evaluation.saturationTriggered, false, "17 < 18 未饱和");
    t.eq(evaluation.decision, "NO_DIFFERENCE", "全都相同且未饱和 ⇒ NO_DIFFERENCE");
  } finally {
    cleanup(dir);
  }
};

tests["调用失败（0 重试）⇒ INCOMPLETE 且不宣称结论"] = async (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const mock = makeMockTransport(plan, (task, arm) => (task.id === "B-05" && arm === "A1" ? null : defaultPick(task, arm)));
    const run = await runStageB({ plan, transport: mock.transport, budget: createBudget(MAX_CALLS) });
    t.eq(run.records.filter((record) => record.ok === false).length, SAMPLES_PER_ARM, "三个样本失败记三条，不补样");
    t.eq(run.records.length, MAX_CALLS, "仍是 120 条");
    const evaluation = evaluateRun({ plan, records: run.records, stageA: { ok: true, p95Ms: 17.64 } });
    t.eq(evaluation.incomplete, true, "数据不完整");
    t.eq(evaluation.decision, "NOT_DECIDED", "残缺数据不许下结论");
    t.eq(evaluation.adoption, "NOT_ADOPTED", "更不许采纳");
    t.eq(majorityOf(["e2", "e5", "e2"]).answer, "e2", "多数票取多数");
    t.eq(majorityOf(["e2", "e5", "e9"]).answer, "e2", "平票取第 1 个样本");
    t.eq(classifySample({ gold: "e2", aliases: ["E2"] }, "e2"), "CORRECT", "小写归一化后与 alias 相等");
    t.eq(classifySample({ gold: "e2", aliases: [] }, "unknown"), "UNKNOWN", "UNKNOWN 单独记");
    t.eq(classifySample({ gold: "UNKNOWN", aliases: [] }, "e9"), "WRONG", "弃答题编造记 WRONG");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ⑦ 篡改必须拒绝 ───────────────────────────── */

tests["prereg：frozenInputs.reader 篡改 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.frozenInputs.reader = "0".repeat(64);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "sha 不符必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
    t.includes(result.output, "reader", "要点名 reader");
  } finally {
    cleanup(dir);
  }
};

tests["prereg：frozenInputs.impl 篡改 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.frozenInputs.impl = "f".repeat(64);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const frozen = checkFrozenInputs({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(frozen.ok, false, "impl 冻结键不符必须红");
    t.includes(frozen.errors.join(" | "), "impl", "要点名 impl");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
  } finally {
    cleanup(dir);
  }
};

tests["prereg：stageAEvidenceSha256 篡改 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.frozenInputs.stageAEvidenceSha256 = "a".repeat(64);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const frozen = checkFrozenInputs({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(frozen.ok, false, "证据字节 sha 不符必须红");
    t.includes(frozen.errors.join(" | "), "stageAEvidenceSha256", "要点名证据 sha");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
  } finally {
    cleanup(dir);
  }
};

tests["prereg 内部不一致（stageGate 的 sha 与 frozenInputs 不同）⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const patched = readJson(at(root, PATHS.prereg));
      patched.stageGate.stageA.fixture.sha256 = "f".repeat(64);
      writeJsonAt(root, PATHS.prereg, patched);
    },
  });
  try {
    const result = await runIn(dir);
    t.eq(result.code, EXIT.PRECONDITION, "内部不一致必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
  } finally {
    cleanup(dir);
  }
};

tests["fixture 字节被篡改 ⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({ mutate: (root) => nodeFs.appendFileSync(at(root, PATHS.fixtures), "\n", "utf8") });
  try {
    t.ne(shaOf(dir, PATHS.fixtures), tempPrereg(dir).frozenInputs.stageAFixtures, "夹具 sha 已经变了");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "夹具被改必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
    t.includes(result.output, "stageAFixtures", "要点名夹具");
  } finally {
    cleanup(dir);
  }
};

tests["实现被篡改（impl 字节）⇒ 拒绝"] = async (t) => {
  const dir = makeRepo({ mutate: (root) => nodeFs.appendFileSync(at(root, PATHS.impl), "\n// tampered\n", "utf8") });
  try {
    const frozen = checkFrozenInputs({ repo: dir, prereg: tempPrereg(dir) });
    const stageA = checkStageA({ repo: dir, prereg: tempPrereg(dir) });
    t.eq(frozen.ok, false, "frozenInputs.impl 必须判红");
    t.eq(stageA.ok, false, "Stage A 的 impl.sha256 也必须判红");
    t.includes(stageA.errors.join(" | "), "impl.sha256", "要点名实现漂移");
    const result = await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN]);
    t.eq(result.code, EXIT.PRECONDITION, "必须拒绝");
    t.eq(result.calls.length, 0, "0 调用");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────────── ⑧ 输出面 / reader 口径 ───────────────────────────── */

tests["--run 写私有明细与公开聚合：公开面无 raw / endpoint / 路径"] = async (t) => {
  const dir = makeRepo();
  try {
    const outcome = await withEnv(async () => {
      const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
      const mock = makeMockTransport(plan, defaultPick);
      const capture = spyLogger();
      const code = await main(["--repo", dir, "--run", "--authorize", AUTHORIZE_TOKEN], { transport: mock.transport, logger: capture.logger });
      return { code, calls: mock.calls, output: capture.lines.join("\n") };
    });
    t.eq(outcome.code, EXIT.OK, `真实运行路径必须 exit 0：${outcome.output.slice(0, 400)}`);
    t.eq(outcome.calls.length, MAX_CALLS, "恰好 120 次调用");
    const results = readJson(at(dir, PATHS.results));
    const publicDoc = readJson(at(dir, PATHS.public));
    t.eq(results.schema, "query-recall-pilot-results-v1", "明细 schema");
    t.eq(results.callsUsed, MAX_CALLS, "明细记录 callsUsed");
    t.eq(results.retriesUsed, 0, "明细记录 retriesUsed");
    t.eq(results.stageAStatus, "PASS", "明细记录 Stage A 状态");
    t.eq(results.decision, "POSITIVE_SIGNAL", "明细记录判定（上限）");
    t.eq(results.decisionCap, DECISION_CAP, "明细记录决策上限");
    t.ok(results.stageA.perf.p95 !== undefined, "明细记录性能 p95");
    t.eq(results.stageA.impl.registered, true, "明细记录 impl 登记状态");
    t.eq(results.tasks.length, 20, "每题一条");
    const sample0 = results.tasks[0].arms.A0.samples[0];
    for (const key of ["raw", "normalized", "outcome", "usage", "latencyMs"]) t.ok(Object.hasOwn(sample0, key), `逐样本必须有 ${key}`);
    t.eq(results.tasks[0].arms.A0.samples.length, 3, "每臂 3 样本");
    t.ok(results.tasks[0].arms.A0.majority.answer !== undefined, "每臂有多数票");

    t.eq(publicDoc.schema, "query-recall-pilot-public-v1", "公开 schema");
    const publicText = JSON.stringify(publicDoc);
    t.eq(publicText.includes('"raw"'), false, "公开面无 raw");
    t.eq(publicText.includes("http://"), false, "公开面无 endpoint");
    t.eq(publicText.includes("127.0.0.1"), false, "公开面无本机地址");
    t.eq(publicText.includes("evidence/"), false, "公开面无路径");
    t.eq(publicText.includes("scripts/"), false, "公开面无路径");
    t.eq(/session-[0-9a-f]{8,}/i.test(publicText), false, "公开面无会话 id");
    t.eq(publicText.includes("test-reader-model"), true, "公开面记录模型 id");
    t.eq(publicDoc.decision, "POSITIVE_SIGNAL", "公开面记录判定");
    t.eq(publicDoc.decisionCap, DECISION_CAP, "公开面记录上限");
    t.eq(publicDoc.adoption, "NOT_ADOPTED", "公开面记录未采纳");
    t.ok(Array.isArray(publicDoc.perTask) && publicDoc.perTask.length === 20, "公开面逐题票型");
  } finally {
    cleanup(dir);
  }
};

tests["已存在结果文件（无 --overwrite）⇒ 拒绝覆盖，0 次调用"] = async (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      nodeFs.mkdirSync(nodePath.dirname(at(root, PATHS.results)), { recursive: true });
      nodeFs.writeFileSync(at(root, PATHS.results), "{}\n", "utf8");
    },
  });
  try {
    const result = await withEnv(async () => (await runIn(dir, ["--run", "--authorize", AUTHORIZE_TOKEN])).code);
    t.eq(result, EXIT.PRECONDITION, "已有结果必须拒绝覆盖");
  } finally {
    cleanup(dir);
  }
};

tests["请求口径与冻结 reader 源码对账（6 项）"] = (t) => {
  const source = nodeFs.readFileSync(nodePath.join(REPO, PATHS.reader), "utf8");
  t.eq(TRANSPORT_SPEC.temperature, 0, "temperature 0");
  t.eq(TRANSPORT_SPEC.maxTokens, 2048, "max_tokens 2048");
  t.eq(TRANSPORT_SPEC.stream, false, "stream false");
  t.eq(TRANSPORT_SPEC.timeoutMs, 120_000, "超时 120s");
  t.ok(/temperature:\s*0\b/.test(source), "源码 temperature: 0");
  t.ok(/max_tokens:\s*2048\b/.test(source), "源码 max_tokens: 2048");
  t.ok(/stream:\s*false\b/.test(source), "源码 stream: false");
  t.ok(/AbortSignal\.timeout\(120_000\)/.test(source), "源码 120s 超时");
  t.eq(READER_DEFAULTS.variant, "v1", "variant 默认 v1");
  t.eq(READER_DEFAULTS.postprocess, "none", "postprocess 默认 none");
  const parity = checkFrozenTransport({ repo: REPO });
  t.ok(parity.ok, `运行期对账必须过：${parity.errors.join("；")}`);
  t.eq(parity.checks.length, 6, "六项口径都要核对");
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const messages = buildRequest(plan.tasks[0], "A0");
    t.eq(messages[0].role, "system", "第一条 system");
    t.eq(messages[0].content, READER_PROMPTS.v1, "system prompt 逐字等于冻结 v1");
    t.includes(messages[1].content, "Context:\n", "user 以 Context: 开头");
  } finally {
    cleanup(dir);
  }
};

tests["冻结 reader 的 temperature 被改 ⇒ 对账拒绝"] = (t) => {
  const dir = makeRepo({
    mutate: (root) => {
      const file = at(root, PATHS.reader);
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, "utf8").replace("temperature: 0,", "temperature: 0.7,"), "utf8");
    },
  });
  try {
    const parity = checkFrozenTransport({ repo: dir });
    t.eq(parity.ok, false, "改动后必须对账失败");
    t.includes(parity.errors.join(" | "), "temperature", "要点名 temperature");
    t.ne(shaOf(dir, PATHS.reader), tempPrereg(dir).frozenInputs.reader, "字节也确实变了");
  } finally {
    cleanup(dir);
  }
};

tests["runner 不写死模型 id 与 endpoint（只从环境变量注入）"] = (t) => {
  const source = nodeFs.readFileSync(SCRIPT, "utf8");
  t.eq(/deepseek|gpt-|claude|grok/i.test(source), false, "源码不出现模型 id");
  t.eq(/https?:\/\//.test(source), false, "源码不出现写死的 endpoint");
  t.includes(source, "LME_READER_MODEL", "从环境变量取模型");
  t.includes(source, "LME_READER_ENDPOINT", "从环境变量取 endpoint");
};

tests["buildResultsFile / buildPublicFile 的分工（私有 vs 公开）"] = (t) => {
  const dir = makeRepo();
  try {
    const plan = buildPlan({ repo: dir, prereg: tempPrereg(dir) }).plan;
    const records = scriptedRecords(plan, defaultPick);
    const evaluation = evaluateRun({ plan, records, stageA: { ok: true, p95Ms: 17.64 } });
    const frozen = { reader: { file: PATHS.reader, sha256: shaOf(dir, PATHS.reader) } };
    const declaration = { token: AUTHORIZE_TOKEN, stageAP95Ms: 17.64, model: "m", variant: "v1", postprocess: "none" };
    const run = { callsUsed: MAX_CALLS, retriesUsed: 0, startedAt: "t0", finishedAt: "t1" };
    const perf = checkStageAPerf({ repo: dir });
    const results = buildResultsFile({ plan, records, evaluation, stageA: { status: "PASS", file: PATHS.stageAEvidence, sha256: "x", fixturesSha256: tempPrereg(dir).frozenInputs.stageAFixtures, aggregate: {}, impl: null }, frozen, declaration, run, perf });
    const publicDoc = buildPublicFile({ plan, evaluation, declaration, run, frozen, stageA: { status: "PASS" }, perf });
    t.eq(JSON.stringify(results).includes('"raw"'), true, "明细含 raw");
    t.eq(JSON.stringify(publicDoc).includes('"raw"'), false, "公开面不含 raw");
    t.eq(results.reader.temperature, 0, "明细记录 temperature");
    t.eq(results.reader.maxTokens, 2048, "明细记录 max_tokens");
    t.eq(results.stageA.perf.sha256, perf.sha256, "明细记录性能证据 sha");
    t.eq(publicDoc.callsUsed, MAX_CALLS, "公开面记录调用数");
    t.eq(publicDoc.decisionCap, DECISION_CAP, "公开面记录上限");
    t.eq(results.notes.length >= 1, true, "明细要有说明");
  } finally {
    cleanup(dir);
  }
};
