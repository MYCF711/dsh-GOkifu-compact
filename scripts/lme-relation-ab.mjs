#!/usr/bin/env node
/**
 * lme-relation-ab.mjs —— K-27 关系行「渲染消歧」同窗配对对照的聚合与裁决（**0 模型调用**）。
 *
 * 输入：
 *   · 预注册   evidence/lme-relation-prereg-ab-v1v4-2026-11-09.json
 *   · 对照 run evidence/lme-pilot-reader-ab-v1-2026-11-09.json     （v1 现行基线）
 *   · 处理 run evidence/lme-pilot-reader-ab-v4-2026-11-09.json     （v4 消歧）
 *
 * 做什么：
 *   1. 逐项核对冻结输入哈希（夹具 / runner / grader / prompt 常量）——任一漂移直接判 INVALID；
 *   2. 核对两轮的 model / endpoint / variant / samplesPerArm 完全一致（不同窗不可比）；
 *   3. 有效性门：两轮 full 臂各自 30/30 样本 + 10/10 多数票；
 *   4. 按题配对，输出多数票 / 样本级 / 逐题翻转表 / KU-01 票型；
 *   5. 按预注册 decisionBands 给 **INVALID / NEGATIVE_SIGNAL / POSITIVE_SIGNAL / NO_DIFFERENCE / NOT_DECIDED**。
 *
 * 公开面红线：输出 JSON/MD **不含**逐样本原始模型输出（raw / trace / reasoning）。
 *
 * 用法：
 *   node scripts/lme-relation-ab.mjs                    # 打印 JSON 到 stdout
 *   node scripts/lme-relation-ab.mjs --write            # 落 evidence/lme-relation-ab-v1v4-2026-11-09.{json,md}
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const PREREG = nodePath.join(ROOT, "evidence", "lme-relation-prereg-ab-v1v4-2026-11-09.json");
export const CONTROL = nodePath.join(ROOT, "evidence", "lme-pilot-reader-ab-v1-2026-11-09.json");
export const TREATMENT = nodePath.join(ROOT, "evidence", "lme-pilot-reader-ab-v4-2026-11-09.json");
export const OUT_JSON = nodePath.join(ROOT, "evidence", "lme-relation-ab-v1v4-2026-11-09.json");
export const OUT_MD = nodePath.join(ROOT, "evidence", "lme-relation-ab-v1v4-2026-11-09.md");

const sha256 = (path) => crypto.createHash("sha256").update(nodeFs.readFileSync(path)).digest("hex");
const readJson = (path) => JSON.parse(nodeFs.readFileSync(path, "utf8"));

const STATUS_WORDS = ["current", "settled", "failed", "untested", "candidate", "residue", "superseded", "stale", "archived", "right-censored", "pending"];
export const STATUS_WORDS_FROZEN = Object.freeze(STATUS_WORDS);

/** 逐样本判分：样本优先，缺失时退回多数票答案（旧 run 只有 1 样本）。 */
export function samplesOf(row) {
  return Array.isArray(row.samples) && row.samples.length > 0 ? row.samples : [row.answer];
}

/**
 * @param {object} prereg
 * @param {object} control
 * @param {object} treatment
 * @param {{gradeAnswer:Function}} grader
 */
export function aggregateAb(prereg, control, treatment, { gradeAnswer }) {
  const issues = [];
  const checks = [];

  // ── 1. 冻结输入哈希 ────────────────────────────────────────────────
  const frozen = prereg.frozenInputs ?? {};
  const hashTargets = [
    ["v1Fixture", nodePath.join(ROOT, "evidence", "lme-task50.fixtures.json")],
    ["v3Fixture", nodePath.join(ROOT, "evidence", "lme-task50-v3-relation.fixtures.json")],
    ["v4Fixture", nodePath.join(ROOT, "evidence", "lme-task50-v4-status.fixtures.json")],
    ["rendererV3", nodePath.join(ROOT, "scripts", "lme-relation-render.mjs")],
    ["rendererV4", nodePath.join(ROOT, "scripts", "lme-relation-render-v4.mjs")],
    ["checkerV3", nodePath.join(ROOT, "scripts", "lme-relation-coverage.mjs")],
    ["grader", nodePath.join(ROOT, "scripts", "lme-task50.mjs")],
    ["runner", nodePath.join(ROOT, "scripts", "lme-pilot-reader.mjs")],
  ];
  for (const [key, path] of hashTargets) {
    const actual = sha256(path);
    const expected = frozen[key];
    checks.push({ id: `hash:${key}`, expected, actual, ok: expected === actual });
    if (expected !== actual) issues.push(`冻结输入漂移：${key} 期望 ${String(expected).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
  }

  // ── 2. 两轮同窗 ────────────────────────────────────────────────────
  const sameRun = (key, a, b) => {
    const ok = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    checks.push({ id: `run:${key}`, expected: a ?? null, actual: b ?? null, ok });
    if (!ok) issues.push(`两轮不一致（不可比）：${key} = ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  sameRun("model", control.model, treatment.model);
  sameRun("endpoint", control.endpoint, treatment.endpoint);
  sameRun("variant", control.variant, treatment.variant);
  sameRun("postprocess", control.postprocess, treatment.postprocess);
  sameRun("selectionRule", control.selectionRule, treatment.selectionRule);
  sameRun("selected", control.selected, treatment.selected);

  // ── 3. 有效性门 ────────────────────────────────────────────────────
  const validity = {};
  for (const [name, run] of [["control", control], ["treatment", treatment]]) {
    const rows = run.results ?? [];
    const fullRows = rows.filter((row) => row.arm === "full");
    let sampleCorrect = 0;
    let sampleTotal = 0;
    for (const row of fullRows) {
      const question = (run.selected ?? []).find((item) => item.id === row.id);
      for (const sample of samplesOf(row)) {
        sampleTotal += 1;
        const grade = gradeAnswer(question.answer, sample, question.grader, []);
        if (grade.correct) sampleCorrect += 1;
      }
    }
    const majorityCorrect = fullRows.filter((row) => row.grade?.correct).length;
    const pass = sampleCorrect === sampleTotal && sampleTotal === 30 && majorityCorrect === fullRows.length && majorityCorrect === 10;
    validity[name] = { sampleCorrect, sampleTotal, majorityCorrect, questions: fullRows.length, pass, calls: (run.summary ?? {}).calls ?? rows.length };
    checks.push({ id: `validity:${name}`, expected: "30/30 样本 且 10/10 多数票", actual: `${sampleCorrect}/${sampleTotal} 样本 · ${majorityCorrect}/${fullRows.length} 多数`, ok: pass });
    if (!pass) issues.push(`${name} 轮 full 有效性门未过：${sampleCorrect}/${sampleTotal} 样本 · ${majorityCorrect}/${fullRows.length} 多数`);
  }

  // ── 4. 按题配对 ────────────────────────────────────────────────────
  const byKey = (run) => new Map((run.results ?? []).map((row) => [`${row.id}:${row.arm}`, row]));
  const controlMap = byKey(control);
  const treatmentMap = byKey(treatment);
  const ids = [...new Set([...controlMap.keys(), ...treatmentMap.keys()].map((key) => key.split(":")[0]))];

  const perQuestion = ids.map((id) => {
    const pick = (map, arm) => {
      const row = map.get(`${id}:${arm}`);
      if (!row) return { votes: {}, majorityAnswer: null, majorityCorrect: false, sampleCorrect: 0, samples: 0, contextChars: null };
      const question = (control.selected ?? []).find((item) => item.id === id);
      const samples = samplesOf(row);
      const votes = {};
      let sampleCorrect = 0;
      for (const sample of samples) {
        votes[sample] = (votes[sample] ?? 0) + 1;
        if (gradeAnswer(question.answer, sample, question.grader, []).correct) sampleCorrect += 1;
      }
      return {
        votes,
        majorityAnswer: row.answer,
        majorityCorrect: Boolean(row.grade?.correct),
        gradeCode: row.grade?.code ?? null,
        sampleCorrect,
        samples: samples.length,
        contextChars: row.contextChars ?? null,
      };
    };
    const cFull = pick(controlMap, "full");
    const tFull = pick(treatmentMap, "full");
    const cCompact = pick(controlMap, "compact");
    const tCompact = pick(treatmentMap, "compact");
    const statusWordAsAnswer = STATUS_WORDS.includes(String(tCompact.majorityAnswer ?? "").trim());
    const flips = {
      regressed: cCompact.majorityCorrect && !tCompact.majorityCorrect,
      fixed: !cCompact.majorityCorrect && tCompact.majorityCorrect,
    };
    return {
      id,
      type: (control.selected ?? []).find((item) => item.id === id)?.type ?? null,
      full: { control: cFull, treatment: tFull },
      compact: { control: cCompact, treatment: tCompact },
      flips,
      treatmentStatusWordAsAnswer: statusWordAsAnswer,
    };
  });

  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  const compact = {
    control: {
      majorityCorrect: sum(perQuestion, (item) => (item.compact.control.majorityCorrect ? 1 : 0)),
      samplesCorrect: sum(perQuestion, (item) => item.compact.control.sampleCorrect),
      samplesTotal: sum(perQuestion, (item) => item.compact.control.samples),
      chars: sum(perQuestion, (item) => item.compact.control.contextChars ?? 0),
    },
    treatment: {
      majorityCorrect: sum(perQuestion, (item) => (item.compact.treatment.majorityCorrect ? 1 : 0)),
      samplesCorrect: sum(perQuestion, (item) => item.compact.treatment.sampleCorrect),
      samplesTotal: sum(perQuestion, (item) => item.compact.treatment.samples),
      chars: sum(perQuestion, (item) => item.compact.treatment.contextChars ?? 0),
    },
  };
  const regressions = perQuestion.filter((item) => item.flips.regressed).map((item) => item.id);
  const fixes = perQuestion.filter((item) => item.flips.fixed).map((item) => item.id);
  const full = {
    control: { majorityCorrect: sum(perQuestion, (item) => (item.full.control.majorityCorrect ? 1 : 0)), samplesCorrect: sum(perQuestion, (item) => item.full.control.sampleCorrect), samplesTotal: sum(perQuestion, (item) => item.full.control.samples) },
    treatment: { majorityCorrect: sum(perQuestion, (item) => (item.full.treatment.majorityCorrect ? 1 : 0)), samplesCorrect: sum(perQuestion, (item) => item.full.treatment.sampleCorrect), samplesTotal: sum(perQuestion, (item) => item.full.treatment.samples) },
  };

  // ── 5. 决策档 ──────────────────────────────────────────────────────
  const hashChecks = checks.filter((check) => check.id.startsWith("hash:"));
  const runChecks = checks.filter((check) => check.id.startsWith("run:"));
  const hashOk = hashChecks.every((check) => check.ok);
  const comparable = runChecks.every((check) => check.ok);
  let band = "NOT_DECIDED";
  let bandWhy = "";
  if (!hashOk) {
    band = "INVALID";
    bandWhy = "冻结输入哈希漂移：夹具 / 渲染器 / 检查器 / grader / runner 任一被改过，本轮不可用于裁决。";
  } else if (!comparable) {
    band = "INVALID";
    bandWhy = "两轮不同窗（model / endpoint / variant / postprocess / 选样 任一不同），compact 差异不可归因。";
  } else if (!validity.control.pass || !validity.treatment.pass) {
    band = "INVALID";
    bandWhy = "任一轮 full 有效性门未过：只报告，不解读 compact。";
  } else if (compact.treatment.majorityCorrect < compact.control.majorityCorrect || regressions.length > 0) {
    band = "NEGATIVE_SIGNAL";
    bandWhy = regressions.length > 0
      ? `出现回归题（对照多对 → 处理多错）：${regressions.join(", ")}`
      : `处理轮多数票 ${compact.treatment.majorityCorrect} < 对照轮 ${compact.control.majorityCorrect}`;
  } else if (compact.treatment.majorityCorrect >= compact.control.majorityCorrect && compact.treatment.samplesCorrect > compact.control.samplesCorrect) {
    band = "POSITIVE_SIGNAL";
    bandWhy = `多数票 ${compact.control.majorityCorrect} → ${compact.treatment.majorityCorrect}，样本级 ${compact.control.samplesCorrect}/${compact.control.samplesTotal} → ${compact.treatment.samplesCorrect}/${compact.treatment.samplesTotal}，无回归题`;
  } else if (compact.treatment.majorityCorrect === compact.control.majorityCorrect && compact.treatment.samplesCorrect === compact.control.samplesCorrect) {
    band = "NO_DIFFERENCE";
    bandWhy = `多数票与样本级完全相同（${compact.control.majorityCorrect}/10 · ${compact.control.samplesCorrect}/${compact.control.samplesTotal}），逐题零翻转`;
  } else {
    band = "NOT_DECIDED";
    bandWhy = "多数票相同但样本级有差异、且无回归题 —— 方向不明，不加样本、不换 prompt。";
  }

  const ku01 = perQuestion.find((item) => item.id === "KU-01") ?? null;

  const observedCalls = [control, treatment].reduce(
    (total, run) => total + (run.results ?? []).reduce((sub, row) => sub + samplesOf(row).length, 0),
    0,
  );
  const observedErrors = [control, treatment].reduce(
    (total, run) => total + (run.results ?? []).filter((row) => row.error || row.finishReason === "error").length,
    0,
  );

  return {
    schema: "k27-relation-ab-v1",
    generatedBy: "scripts/lme-relation-ab.mjs",
    modelCalls: 0,
    authorization: {
      preregStatus: prereg.approval?.status ?? null,
      runsAuthorized: prereg.approval?.runsAuthorized ?? null,
      runsObserved: 2,
      modelCallsPlanned: prereg.budget?.planned ?? null,
      modelCallsObserved: observedCalls,
      // runner 没有重试代码路径（每样本只发一次请求），且两轮 errorsObserved 为 0 ⇒ 重试 0 次。
      retriesObserved: observedErrors === 0 ? 0 : null,
      retriesBasis: "runner 单样本单次调用、无重试分支；errorsObserved=0 才记 0，否则记 null 不猜",
      errorsObserved: observedErrors,
    },
    experimentId: prereg.experimentId,
    preregSha256: sha256(PREREG),
    controlSha256: sha256(CONTROL),
    treatmentSha256: sha256(TREATMENT),
    decisionBand: band,
    decisionWhy: bandWhy,
    validity,
    full,
    compact,
    flips: { regressions, fixes },
    ku01: ku01
      ? {
        controlCompactVotes: ku01.compact.control.votes,
        treatmentCompactVotes: ku01.compact.treatment.votes,
        controlCompactMajorityCorrect: ku01.compact.control.majorityCorrect,
        treatmentCompactMajorityCorrect: ku01.compact.treatment.majorityCorrect,
        treatmentStatusWordAsAnswer: ku01.treatmentStatusWordAsAnswer,
        controlContextChars: ku01.compact.control.contextChars,
        treatmentContextChars: ku01.compact.treatment.contextChars,
      }
      : null,
    perQuestion,
    checks,
    issues,
    ok: issues.length === 0,
    preservedStatus: prereg.preservedStatus ?? {},
    note: "PILOT_ONLY：10 题 pilot 的 +1/−1 在噪声量级；本文件不代表 formal 50/50 通过，也不代表关系行有效，更不授权修改默认值。公开面不含逐样本原始模型输出。",
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# K-27 关系行「渲染消歧」同窗配对对照（v1 vs v4）");
  lines.push("");
  lines.push(`> **PILOT_ONLY / NOT_ADOPTED** · 预注册 \`evidence/lme-relation-prereg-ab-v1v4-2026-11-09.json\`（sha \`${report.preregSha256.slice(0, 12)}…\`）· **0 模型调用**（本文件只是聚合）。`);
  lines.push("");
  lines.push(`- 决策档：**${report.decisionBand}** —— ${report.decisionWhy}`);
  lines.push(`- 有效性门：对照 full ${report.validity.control.sampleCorrect}/${report.validity.control.sampleTotal} 样本 · ${report.validity.control.majorityCorrect}/${report.validity.control.questions} 多数；处理 full ${report.validity.treatment.sampleCorrect}/${report.validity.treatment.sampleTotal} 样本 · ${report.validity.treatment.majorityCorrect}/${report.validity.treatment.questions} 多数`);
  lines.push(`- compact 多数票：**${report.compact.control.majorityCorrect}/10 → ${report.compact.treatment.majorityCorrect}/10**；样本级 **${report.compact.control.samplesCorrect}/${report.compact.control.samplesTotal} → ${report.compact.treatment.samplesCorrect}/${report.compact.treatment.samplesTotal}**`);
  lines.push(`- compact 字符数：${report.compact.control.chars} → ${report.compact.treatment.chars}`);
  lines.push(`- 翻转：修好 ${report.flips.fixes.length ? report.flips.fixes.join(", ") : "无"}；回归 ${report.flips.regressions.length ? report.flips.regressions.join(", ") : "无"}`);
  lines.push("");
  if (report.ku01) {
    lines.push("## KU-01（唯一历史错题）");
    lines.push("");
    lines.push("| 臂 | 票型 | 多数票正确 | 上下文字符 |");
    lines.push("|---|---|---|---|");
    lines.push(`| v1 compact | ${JSON.stringify(report.ku01.controlCompactVotes)} | ${report.ku01.controlCompactMajorityCorrect ? "✅" : "❌"} | ${report.ku01.controlContextChars} |`);
    lines.push(`| v4 compact | ${JSON.stringify(report.ku01.treatmentCompactVotes)} | ${report.ku01.treatmentCompactMajorityCorrect ? "✅" : "❌"} | ${report.ku01.treatmentContextChars} |`);
    lines.push("");
    lines.push(`处理轮多数票是否仍是状态词：**${report.ku01.treatmentStatusWordAsAnswer ? "是（H1 未被支持）" : "否（H1 被支持）"}**`);
    lines.push("");
  }
  lines.push("## 逐题（compact 臂）");
  lines.push("");
  lines.push("| 题 | 类型 | v1 票型 | v1 多数 | v4 票型 | v4 多数 | 翻转 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const item of report.perQuestion) {
    const flip = item.flips.regressed ? "⚠ 回归" : item.flips.fixed ? "✅ 修好" : "";
    lines.push(`| ${item.id} | ${item.type} | ${JSON.stringify(item.compact.control.votes)} | ${item.compact.control.majorityCorrect ? "✅" : "❌"} | ${JSON.stringify(item.compact.treatment.votes)} | ${item.compact.treatment.majorityCorrect ? "✅" : "❌"} | ${flip} |`);
  }
  lines.push("");
  lines.push("## 自检");
  lines.push("");
  lines.push(`- 冻结输入哈希：${report.checks.filter((check) => check.id.startsWith("hash:")).filter((check) => check.ok).length}/${report.checks.filter((check) => check.id.startsWith("hash:")).length} 通过`);
  lines.push(`- 两轮同窗：${report.checks.filter((check) => check.id.startsWith("run:")).every((check) => check.ok) ? "一致" : "**不一致**"}`);
  lines.push(`- 问题项：${report.issues.length === 0 ? "0" : report.issues.join(" | ")}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(report.note);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const write = process.argv.includes("--write");
  const { gradeAnswer } = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "lme-task50.mjs")).href);
  const prereg = readJson(PREREG);
  const control = readJson(CONTROL);
  const treatment = readJson(TREATMENT);
  const report = aggregateAb(prereg, control, treatment, { gradeAnswer });
  if (!write) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  nodeFs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  nodeFs.writeFileSync(OUT_MD, renderMarkdown(report));
  console.log(JSON.stringify({
    decisionBand: report.decisionBand,
    compact: report.compact,
    flips: report.flips,
    ok: report.ok,
    out: [nodePath.relative(ROOT, OUT_JSON), nodePath.relative(ROOT, OUT_MD)],
  }, null, 2));
}

if (process.argv[1]?.endsWith("lme-relation-ab.mjs")) main();
