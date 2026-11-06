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
  main,
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

tests["K27 冻结夹具：50/50、五类各10、失败与更新30题，验证不宣称质量分"] = (t) => {
  const validation = validateFixtures(fixtures);
  t.eq(validation.ok, true, validation.errors.join("\n"));
  t.eq(validation.total, 50);
  t.eq(validation.byType, { IE: 10, MR: 10, KU: 10, TR: 10, ABS: 10 });
  t.eq(validation.failureOrUpdate, 30);
  const result = spawnSync(process.execPath, [SCRIPT, "--validate"], { cwd: ROOT, encoding: "utf8" });
  const out = JSON.parse(result.stdout);
  t.eq(result.status, 0, result.stderr);
  t.eq(out.qualityGate, "NOT_RUN", "--validate 不是任务质量通过");
  t.eq(out.reader, "NOT_RUN", "默认没有 reader");
};

tests["K27 机械判分：exact / set / ordered / UNKNOWN 各有真反例"] = (t) => {
  t.eq(gradeAnswer("a  b", "a b", "exact").correct, true);
  t.eq(gradeAnswer("a", "b", "exact").correct, false);
  t.eq(gradeAnswer(["a", "b"], "b,a", "set").correct, true);
  t.eq(gradeAnswer(["a", "b"], ["a", "b"], "ordered").correct, true);
  t.eq(gradeAnswer(["a", "b"], "b,a", "ordered").correct, false);
  t.eq(gradeAnswer("UNKNOWN", "UNKNOWN", "UNKNOWN").correct, true);
  t.eq(gradeAnswer("UNKNOWN", "guessed", "UNKNOWN").code, "abstention-violation");
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
};

tests["K27 同类两条 compact 错答必须真红，不能用总分掩盖分类退化"] = (t) => {
  const run = correctResults();
  run.results[0].compact = "wrong-1";
  run.results[1].compact = "wrong-2";
  const evaluation = evaluateRun(fixtures, run);
  t.eq(evaluation.qualityGate, "FAIL");
  t.eq(evaluation.Acc_compact, 0.96, "48/50 的总分仍高于 0.90");
  t.eq(evaluation.gates.perType, false, "IE 8/10 且 Δ=-0.2 必须红");
  t.eq(evaluation.byType.IE["Δtask"], -0.2);
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
  t.eq(evaluation.unknownProcessIds[0].processId, "n-not-in-context");
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
    t.eq(payload.context.includes("applicability"), false);
    t.eq(assertReaderPayload(payload), true);
  }
  t.eq(evaluateRun(fixtures, run).qualityGate, "PASS");
};

tests["K27 元数据泄漏必须真红：额外 answer、compact gold、缺类型都不许过"] = (t) => {
  const item = fixtures.questions[0];
  t.throws(() => assertReaderPayload({ ...makeReaderPayload(item, "compact"), answer: item.answer }), /keys leaked/);
  const bad = clone(fixtures);
  bad.questions[0].compactContext += '\napplicability="task-process/failure"';
  t.eq(validateFixtures(bad).ok, false, "compact 带 gold 元数据必须红");
  const missing = clone(fixtures);
  missing.questions = missing.questions.filter((item) => item.type !== "MR");
  t.eq(validateFixtures(missing).ok, false, "少一整类必须红");
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
  t.eq(main(["--validate", "--run", "x"]), 2, "互斥参数不许产生假分数");
};
