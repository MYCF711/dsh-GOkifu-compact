import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_SCHEMA,
  RESULTS_SCHEMA,
  THRESHOLDS,
  assertReaderPayload,
  evaluateRun,
  gradeAnswer,
  makeReaderPayload,
  runReader,
  validateFixtures,
  wilson95,
} from "../scripts/lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "lme-task50.mjs");
const fixtures = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "evidence", "lme-task50.fixtures.json"), "utf8"));
const byId = new Map(fixtures.questions.map((item) => [item.id, item]));
const correctResults = () => ({
  schema: RESULTS_SCHEMA,
  results: fixtures.questions.map((item) => ({ id: item.id, full: item.answer, compact: item.answer })),
});
const clone = (value) => JSON.parse(JSON.stringify(value));
export const tests = {};

tests["K27 冻结夹具：50/50、五类各10、失败与更新34题，验证不宣称质量分"] = (t) => {
  const validation = validateFixtures(fixtures);
  t.eq(validation.ok, true, validation.errors.join("\n"));
  t.eq(validation.total, 50);
  t.eq(validation.validated, 50);
  t.eq(validation.byType, { IE: 10, MR: 10, KU: 10, TR: 10, ABS: 10 });
  t.eq(validation.failureOrUpdate, 34);
  const result = spawnSync(process.execPath, [SCRIPT, "--validate"], { cwd: ROOT, encoding: "utf8" });
  const out = JSON.parse(result.stdout);
  t.eq(result.status, 0, result.stderr);
  t.eq(out.qualityGate, "NOT_RUN", "--validate 不是任务质量通过");
  t.eq(out.reader, "NOT_RUN", "默认没有 reader");
  const defaultRun = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  t.eq(defaultRun.status, 0, defaultRun.stderr);
  t.eq(JSON.parse(defaultRun.stdout).status, "NOT_RUN", "无参数也只验证，绝不默认跑 reader");
};

tests["K27 机械判分：exact / set / ordered / UNKNOWN 各有真反例"] = (t) => {
  t.eq(gradeAnswer("a  b", "a b", "exact").correct, true);
  t.eq(gradeAnswer("a", "b", "exact").correct, false);
  t.eq(gradeAnswer(["a", "b"], "b,a", "set").correct, true);
  t.eq(gradeAnswer(["a", "b"], "a", "set").correct, false);
  t.eq(gradeAnswer(["a", "b"], ["a", "b"], "ordered").correct, true);
  t.eq(gradeAnswer(["a", "b"], "b,a", "ordered").correct, false);
  t.eq(gradeAnswer("UNKNOWN", "UNKNOWN", "UNKNOWN").correct, true);
  t.eq(gradeAnswer("UNKNOWN", "guessed", "UNKNOWN").code, "abstention-violation");
  t.eq(gradeAnswer("UNKNOWN", "unknown", "UNKNOWN").correct, false);
};

tests["K27 正确配对结果：总分、五类、ABS 与区间都通过"] = (t) => {
  const evaluation = evaluateRun(fixtures, correctResults());
  t.eq(evaluation.qualityGate, "PASS");
  t.eq(evaluation.Acc_full, 1);
  t.eq(evaluation.Acc_compact, 1);
  t.eq(evaluation["Δtask"], 0);
  t.eq(evaluation.byType.ABS.compactCorrect, 10);
  t.eq(evaluation["reader-limited"], []);
  t.eq(evaluation.ci95.compact.low > 0.9, true, "50/50 的 Wilson 下界仍不是 1");
  t.eq(evaluation.ci95.delta, { low: 0, high: 0 });
  t.eq(evaluation.byType.IE.ci95.compact.low > 0.5, true, "五类也各带区间");
  t.eq(evaluation.costs.readerCost, "NOT_RUN", "无真实成本时不编造");
};

tests["K27 门槛边界绿样本再改错一条 compact 必须真红"] = (t) => {
  const run = correctResults();
  for (const id of ["IE-01", "IE-02", "MR-01", "KU-01", "TR-01"]) {
    const row = run.results.find((entry) => entry.id === id);
    row.full = "reader-wrong";
    row.compact = "reader-wrong";
  }
  const boundaryGreen = evaluateRun(fixtures, run);
  t.eq(boundaryGreen.qualityGate, "PASS", "45/50 且五类均到底线、Δ=0 的合成样本必须绿");
  t.eq(boundaryGreen["reader-limited"].length, 5);
  run.results.find((entry) => entry.id === "IE-03").compact = "wrong-once";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.qualityGate, "FAIL");
  t.eq(evaluation.Acc_compact, 0.88, "只额外改错一条 compact：44/50");
  t.eq(evaluation.gates.overallCompact, false);
  t.eq(evaluation.gates.perType, false, "IE 7/10 必须红");
  t.eq(evaluation.byType.IE["Δtask"], -0.1);
  t.eq(evaluation.items.find((item) => item.id === "IE-03").errors[0].code, "exact-mismatch");
};

tests["K27 总分仍过线但单类配对下降超过0.10也必须红"] = (t) => {
  const run = correctResults();
  run.results[0].compact = "wrong-1";
  run.results[1].compact = "wrong-2";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.Acc_compact, 0.96);
  t.eq(evaluation.gates.overallCompact, true);
  t.eq(evaluation.gates.pairedDelta, true, "总 Δ=-0.04 仍过线");
  t.eq(evaluation.byType.IE.Acc_compact, 0.8);
  t.eq(evaluation.byType.IE["Δtask"], -0.2);
  t.eq(evaluation.gates.perType, false);
  t.eq(evaluation.qualityGate, "FAIL");
};

tests["K27 ABS 编造一个答案也必须红，其他指标不能抵消"] = (t) => {
  const run = correctResults();
  const abs = run.results.find((row) => row.id === "ABS-01");
  abs.compact = "invented-answer";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.qualityGate, "FAIL");
  t.eq(evaluation.gates.abstention, false);
  t.eq(evaluation.byType.ABS.compactCorrect, 9);
};

tests["K27 full/compact 同错标 reader-limited 并保留分母"] = (t) => {
  const run = correctResults();
  run.results[0].full = "wrong-full";
  run.results[0].compact = "wrong-compact";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.total, 50);
  t.eq(evaluation["reader-limited"], ["IE-01"]);
  t.eq(evaluation.items[0]["reader-limited"], true);
};

tests["K27 未出现的过程 id 必须报出，不能编造节点或边"] = (t) => {
  const run = correctResults();
  run.results[0].compact = "n-not-in-context";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.gates.noUnknownProcessIds, false);
  t.eq(evaluation.qualityGate, "FAIL");
  t.eq(evaluation.unknownProcessIds[0].processId, "n-not-in-context");
  run.results[0].compact = "e999";
  const numeric = evaluateRun(fixtures, run);
  t.eq(numeric.unknownProcessIds[0].processId, "e999", "真实图常用的数字 id 也不许编造");
};

tests["K27 reader 只收四字段：无答案、证据、判分器和另一臂上下文"] = async (t) => {
  const seen = [];
  const answers = new Map(fixtures.questions.map((item) => [item.id, { full: item.answer, compact: item.answer }]));
  const run = await runReader(fixtures, async (payload) => {
    seen.push(payload);
    return answers.get(payload.id)[payload.arm];
  });
  t.eq(seen.length, 100);
  for (const payload of seen) {
    t.eq(Object.keys(payload).sort(), ["arm", "context", "id", "question"]);
    t.eq("answer" in payload, false);
    t.eq("evidenceSeqs" in payload, false);
    t.eq("grader" in payload, false);
    const item = byId.get(payload.id);
    const otherArm = payload.arm === "full" ? "compact" : "full";
    t.eq(payload.question, item.question);
    t.eq(payload.context, item[`${payload.arm}Context`], "只能收到当前臂原文");
    t.eq(payload.context === item[`${otherArm}Context`], false, "不得收到另一臂上下文");
    t.eq(payload.context.includes("applicability"), false);
    t.eq(Object.isFrozen(payload), true);
    t.eq(assertReaderPayload(payload), true);
  }
  t.eq(evaluateRun(fixtures, run).qualityGate, "PASS");
};

tests["K27 元数据泄漏必须真红：额外 answer、compact gold、缺类型都不许过"] = (t) => {
  const item = fixtures.questions[0];
  for (const key of ["answer", "evidenceSeqs", "grader", "fullContext", "compactContext"]) {
    t.throws(() => assertReaderPayload({ ...makeReaderPayload(item, "compact"), [key]: "leak" }), `${key} 泄漏必须红`);
  }
  const bad = clone(fixtures);
  bad.questions[0].compactContext += '\napplicability="task-process/failure"';
  t.eq(validateFixtures(bad).ok, false, "compact 带 gold 元数据必须红");
  const archiveLeak = clone(fixtures);
  archiveLeak.questions[0].compactContext = archiveLeak.questions[0].fullContext;
  t.eq(validateFixtures(archiveLeak).leaks.some((hit) => hit.kind === "full-context-copied"), true, "复制 full 必须红");
  const missing = clone(fixtures);
  missing.questions = missing.questions.filter((item) => item.type !== "MR");
  t.eq(validateFixtures(missing).ok, false, "少一整类必须红");
  const personal = clone(fixtures);
  personal.questions[0].applicability = "personal-memory/preference";
  t.eq(validateFixtures(personal).ok, false, "个人长期记忆题越界必须红");
  const thawed = clone(fixtures);
  thawed.frozen = false;
  t.eq(validateFixtures(thawed).ok, false, "未冻结夹具必须红");
};

tests["K27 结果缺题、重题都保留 dataComplete=false，不静默 skip"] = (t) => {
  const missing = correctResults();
  missing.results.pop();
  t.eq(evaluateRun(fixtures, missing).gates.dataComplete, false);
  const duplicate = correctResults();
  duplicate.results[1].id = duplicate.results[0].id;
  const evaluation = evaluateRun(fixtures, duplicate);
  t.eq(evaluation.gates.dataComplete, false);
  t.eq(evaluation.total, 50, "分母仍是冻结的50题");
  const missingArm = correctResults();
  delete missingArm.results[0].compact;
  t.eq(evaluateRun(fixtures, missingArm).gates.dataComplete, false, "缺 compact 臂不是完整配对");
};

tests["K27 --run 只评已有结果：正确文件 exit0，分类退化 exit1"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "lme-task50-"));
  try {
    const file = nodePath.join(dir, "results.json");
    nodeFs.writeFileSync(file, JSON.stringify(correctResults()), "utf8");
    const good = spawnSync(process.execPath, [SCRIPT, "--run", file], { cwd: ROOT, encoding: "utf8" });
    t.eq(good.status, 0, good.stderr);
    t.eq(JSON.parse(good.stdout).qualityGate, "PASS");
    const bad = correctResults();
    bad.results[0].compact = "bad-1";
    bad.results[1].compact = "bad-2";
    nodeFs.writeFileSync(file, JSON.stringify(bad), "utf8");
    const failed = spawnSync(process.execPath, [SCRIPT, "--run", file], { cwd: ROOT, encoding: "utf8" });
    t.eq(failed.status, 1, failed.stdout);
    t.eq(JSON.parse(failed.stdout).qualityGate, "FAIL");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["K27 Wilson 区间与阈值常量固定，不随结果回调"] = (t) => {
  const ci = wilson95(45, 50);
  t.eq(ci.low < 0.9 && ci.high > 0.9, true, "45/50 的区间跨过 0.90");
  t.eq(THRESHOLDS.compactAccuracy, 0.9);
  t.eq(THRESHOLDS.deltaTask, -0.05);
  t.eq(THRESHOLDS.typeCompactAccuracy, 0.8);
  t.eq(THRESHOLDS.typeDeltaTask, -0.1);
  t.eq(FIXTURE_SCHEMA, "lme-task50-fixtures-v1");
  t.eq(byId.get("ABS-01").answer, "UNKNOWN");
  const conflict = spawnSync(process.execPath, [SCRIPT, "--validate", "--run", "x"], { cwd: ROOT, encoding: "utf8" });
  t.eq(conflict.status, 2, "互斥参数不许产生假分数");
  t.eq(JSON.parse(conflict.stdout).qualityGate, "NOT_RUN");
};
