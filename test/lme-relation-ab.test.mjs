/**
 * lme-relation-ab.test.mjs —— K-27 同窗配对对照聚合器（AB）的判据回归
 *
 * 盯住五件事：
 *   ① 两轮完全相同 ⇒ NO_DIFFERENCE（不许因为“跑了一遍”就算有提升）；
 *   ② 样本级 +1 且无回归 ⇒ POSITIVE_SIGNAL；多数票不变也照这条判；
 *   ③ 有一题从多对变多错 ⇒ NEGATIVE_SIGNAL（回归优先于任何样本级收益）；
 *   ④ 冻结输入哈希漂移 ⇒ INVALID（夹具/渲染器/检查器/grader/runner 任一被改就不可裁决）；
 *   ⑤ 任一轮 full 有效性门未过 ⇒ INVALID（full 掉了就什么都不解读）。
 *
 * 边界：0 模型调用、0 网络；只用合成 run 对象 + 真实预注册文件的哈希段。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateAb, PREREG } from "../scripts/lme-relation-ab.mjs";
import { gradeAnswer } from "../scripts/lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const prereg = JSON.parse(nodeFs.readFileSync(PREREG, "utf8"));

const SELECTED = prereg.design.selectedQuestions.map((id) => ({ id, type: id.split("-")[0], answer: null, grader: "exact" }));
const ANSWERS = Object.fromEntries([
  ["IE-01", "n-ie01-root"], ["IE-02", "e-ie02-parse"],
  ["MR-01", ["e-mr01-a", "e-mr01-b"]], ["MR-02", ["e-mr02-a", "e-mr02-c"]],
  ["KU-01", "later-ok"], ["KU-02", "retain-20"],
  ["TR-01", "before"], ["TR-02", "after"],
  ["ABS-01", "UNKNOWN"], ["ABS-02", "UNKNOWN"],
]);
const GRADERS = Object.fromEntries(Object.entries(ANSWERS).map(([id, answer]) => [id, Array.isArray(answer) ? "set" : "exact"]));
const selected = SELECTED.map((item) => ({ ...item, answer: ANSWERS[item.id], grader: GRADERS[item.id] }));

/** 造一轮合成 run：`overrides[`${id}:${arm}`] = [samples...]`。 */
function makeRun({ tag, overrides = {} } = {}) {
  const results = [];
  for (const item of selected) {
    for (const arm of ["full", "compact"]) {
      const key = `${item.id}:${arm}`;
      const samples = overrides[key] ?? [String(item.answer), String(item.answer), String(item.answer)];
      const votes = new Map();
      for (const sample of samples) votes.set(sample, (votes.get(sample) ?? 0) + 1);
      let answer = samples[0];
      let best = 0;
      for (const [value, count] of votes) if (count > best) { best = count; answer = value; }
      results.push({
        id: item.id,
        type: item.type,
        arm,
        question: item.id,
        contextChars: 100,
        raw: null,
        answer,
        grade: gradeAnswer(item.answer, answer, item.grader, []),
        finishReason: "stop",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        latencyMs: 1,
        samples,
      });
    }
  }
  return {
    schema: "lme-pilot-reader-v1",
    status: "PILOT_ONLY",
    model: "deepseek-v4.1-flash-1017",
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    variant: "v5cmp-en",
    postprocess: "none",
    selectionRule: tag,
    selected,
    summary: { calls: results.length },
    results,
  };
}

export const tests = {};

tests["AB-1 两轮完全相同 ⇒ NO_DIFFERENCE（跑一遍不等于有提升）"] = (t) => {
  const run = aggregateAb(prereg, makeRun({ tag: "same" }), makeRun({ tag: "same" }), { gradeAnswer });
  t.eq(run.decisionBand, "NO_DIFFERENCE", `实际 ${run.decisionBand}：${run.decisionWhy}`);
  t.eq(run.ok, true, `不应有问题项：${run.issues.join(" | ")}`);
  t.eq(run.flips.regressions, [], "不许凭空出现回归题");
  t.eq(run.compact.control.majorityCorrect, 10, "对照应为 10/10");
};

tests["AB-2 样本级 +1 且无回归 ⇒ POSITIVE_SIGNAL"] = (t) => {
  const control = makeRun({
    tag: "ab",
    overrides: { "KU-01:compact": ["later-ok", "UNKNOWN", "later-ok"] },
  });
  const treatment = makeRun({ tag: "ab" });
  const run = aggregateAb(prereg, control, treatment, { gradeAnswer });
  t.eq(run.decisionBand, "POSITIVE_SIGNAL", `实际 ${run.decisionBand}：${run.decisionWhy}`);
  t.eq(run.compact.control.samplesCorrect, 29, "对照样本级应为 29/30");
  t.eq(run.compact.treatment.samplesCorrect, 30, "处理样本级应为 30/30");
  t.eq(run.compact.control.majorityCorrect, 10, "多数票两轮都应是 10/10（+1 只体现在样本级）");
};

tests["AB-3 有题目从多对变多错 ⇒ NEGATIVE_SIGNAL（回归优先）"] = (t) => {
  const control = makeRun({ tag: "ab" });
  const treatment = makeRun({ tag: "ab", overrides: { "IE-01:compact": ["settled", "settled", "settled"] } });
  const run = aggregateAb(prereg, control, treatment, { gradeAnswer });
  t.eq(run.decisionBand, "NEGATIVE_SIGNAL", `实际 ${run.decisionBand}：${run.decisionWhy}`);
  t.eq(run.flips.regressions, ["IE-01"], "必须点名回归题 IE-01");
};

tests["AB-4 冻结输入哈希漂移 ⇒ INVALID"] = (t) => {
  const drifted = JSON.parse(JSON.stringify(prereg));
  drifted.frozenInputs.runner = "0".repeat(64);
  const run = aggregateAb(drifted, makeRun({ tag: "ab" }), makeRun({ tag: "ab" }), { gradeAnswer });
  t.eq(run.decisionBand, "INVALID", `实际 ${run.decisionBand}：${run.decisionWhy}`);
  t.eq(run.ok, false, "哈希漂移必须让 ok=false");
  t.eq(run.issues.some((issue) => issue.includes("runner")), true, `必须点名 runner：${run.issues.join(" | ")}`);
};

tests["AB-5 任一轮 full 有效性门未过 ⇒ INVALID（compact 不解读）"] = (t) => {
  const bad = makeRun({ tag: "ab", overrides: { "KU-01:full": ["UNKNOWN", "UNKNOWN", "UNKNOWN"] } });
  const run = aggregateAb(prereg, bad, makeRun({ tag: "ab" }), { gradeAnswer });
  t.eq(run.decisionBand, "INVALID", `实际 ${run.decisionBand}：${run.decisionWhy}`);
  t.eq(run.validity.control.pass, false, "对照 full 门必须判不过");
  t.eq(run.validity.treatment.pass, true, "处理 full 门应仍通过（证明判据只看坏的那一轮）");
};

tests["AB-6 公开聚合不含逐样本 raw / trace"] = (t) => {
  const run = aggregateAb(prereg, makeRun({ tag: "ab" }), makeRun({ tag: "ab" }), { gradeAnswer });
  const text = JSON.stringify(run);
  t.eq(/"raw"/.test(text), false, "公开聚合不得含 raw 字段");
  t.eq(/"trace"/.test(text), false, "公开聚合不得含 trace 字段");
  t.eq(run.modelCalls, 0, "聚合本身必须是 0 模型调用");
};
