/**
 * lme-relation-coverage.test.mjs —— K-27 v3 关系行夹具与离线覆盖检查的回归（RL2）
 *
 * 盯住四件事：
 *   ① v1 冻结夹具字节未变；v3 能由 v1 + 渲染器确定性重放（证明 v3 不是手改出来的）；
 *   ② v3 关系覆盖 50/50（值型 38/38、ABS/比较题零关系行），且除 compactContext 外逐字未变；
 *   ③ v1 负对照必须红（检查器不是“凡有 token 都算过”）；
 *   ④ --self-test 的定向篡改全部判红（反例数只许长，不许悄悄缩）；
 *   ⑤ checker v2 补掉的两类“槽位”负覆盖盲点（RL2 X17 删槽位旧值行 / X21 槽位旧值冒充 current）保持判红。
 *
 * 边界：0 模型调用、0 网络；只读 evidence/ 与 scripts/，临时重渲染写到 os.tmpdir()。
 * 说明：本夹具状态是 FROZEN_NOT_RUN / NOT_ADOPTED —— 本文件只冻结离线关系覆盖，不宣称质量。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkFixture, runSelfTest } from "../scripts/lme-relation-coverage.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const V1 = nodePath.join(ROOT, "evidence", "lme-task50.fixtures.json");
const V3 = nodePath.join(ROOT, "evidence", "lme-task50-v3-relation.fixtures.json");
const V4 = nodePath.join(ROOT, "evidence", "lme-task50-v4-status.fixtures.json");
const RENDERER = nodePath.join(ROOT, "scripts", "lme-relation-render.mjs");
const RENDERER_V4 = nodePath.join(ROOT, "scripts", "lme-relation-render-v4.mjs");
const COVERAGE = nodePath.join(ROOT, "scripts", "lme-relation-coverage.mjs");

/** 冻结值（K5 §4.6：新夹具 + 检查器 + 预期覆盖率一起冻结哈希）。 */
const FROZEN = Object.freeze({
  v1: "6a68e82b87ac1a0d27ede0f9d2af41c3d0d8bdcb462a9b80a104c4d98ad86082",
  v3: "9055b1b9b5c39d8238d6635434ddd6cb236672c5c9b8f041b4bd548132f240d9",
  renderer: "306dd46eb7ba43731c3846a9a7d7ff32fbc9d80a3cf937dd91da610a3b64d3f9",
  // checker v3：双形态（`status=<词>` / `[<词>]`）+ C19–C22 四条 v4 负例；v2 的 c8960385… 已被取代。
  checker: "4a667ec1c8d13ef1e201c31cdfbc5c5c51701624b6eabcef578962869c55e3d0",
  // v4（渲染消歧）：只把状态的书写形态从 `status=<词>` 改成行尾 `[<词>]`，其余字节与 v3 相同。
  v4: "fd3e0d15f4bd499ed2415788fbef297786f3b506f7982720e2bdb6aa1e0ad644",
  rendererV4: "9c8fe134f8c212db48562ad1a7ba4f11d65761094e120883b8b3ae98699425f1",
});

const sha256 = (file) => crypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(nodeFs.readFileSync(file, "utf8"));

export const tests = {};

tests["RL-1 冻结字节：v1 未改、v3 可由 v1 + 渲染器确定性重放"] = (t) => {
  t.eq(sha256(V1), FROZEN.v1, "v1 夹具字节必须等于 K5 冻结值");
  t.eq(sha256(V3), FROZEN.v3, "v3 夹具字节必须等于交付冻结值");
  t.eq(sha256(V4), FROZEN.v4, "v4 夹具字节必须等于交付冻结值");
  t.eq(sha256(RENDERER), FROZEN.renderer, "v3 渲染器字节必须等于冻结值（v4 走独立文件，不许改它）");
  t.eq(sha256(RENDERER_V4), FROZEN.rendererV4, "v4 渲染器字节必须等于冻结值");
  t.eq(sha256(COVERAGE), FROZEN.checker, "检查器字节必须等于冻结值");

  const out = nodePath.join(nodeOs.tmpdir(), `k27-relation-rerender-${process.pid}.json`);
  try {
    const run = spawnSync(process.execPath, [RENDERER, V1, out], { cwd: ROOT, encoding: "utf8" });
    t.eq(run.status, 0, `重渲染必须成功：${(run.stderr || "").slice(0, 400)}`);
    t.eq(sha256(out), FROZEN.v3, "重渲染结果必须与 v3 逐字节相同（否则 v3 是手改的）");
  } finally {
    nodeFs.rmSync(out, { force: true });
  }
};

tests["RL-2 关系覆盖 50/50（值型 38/38）且除 compactContext 外逐字未变"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const run = checkFixture(v3, { baseline: v1 });
  t.eq(run.ok, true, `覆盖失败题：${JSON.stringify(run.results.filter((entry) => !entry.covered).map((entry) => entry.id))}`);
  t.includes(run.coverage, "50/50", "总覆盖必须是 50/50");
  t.includes(run.coverage, "值型题 38/38", "值型题必须是 38/38");
  t.eq(run.immutable.ok, true, `不可变字段漂移：${run.immutable.issues.join(" | ")}`);

  // 不只检查 checker 列的 8 个字段：逐题所有字段（compactContext 除外）都必须逐字相同
  const byId = new Map(v3.questions.map((question) => [question.id, question]));
  const drift = [];
  for (const source of v1.questions) {
    const target = byId.get(source.id);
    if (!target) {
      drift.push(`${source.id}.<missing>`);
      continue;
    }
    for (const key of new Set([...Object.keys(source), ...Object.keys(target)])) {
      if (key === "compactContext") continue;
      if (JSON.stringify(source[key]) !== JSON.stringify(target[key])) drift.push(`${source.id}.${key}`);
    }
  }
  t.eq(drift, [], `非 compact 字段差异必须为 0 处：${drift.slice(0, 8).join(" / ")}`);
  t.eq(
    v1.questions.filter((question) => question.compactContext !== byId.get(question.id)?.compactContext).length,
    50,
    "50/50 题的 compactContext 都必须被重投影",
  );
  t.eq(v3.questions.every((question) => question.aliases === undefined || question.aliases.length === 0), true, "aliases 必须为空（禁止别名等价）");
};

tests["RL-3 ABS/比较题零关系行；v1 负对照必须红"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const base = checkFixture(v1);
  t.eq(base.ok, false, "v1（无关系行）必须被判红 —— 检查器不得把 token 在场当成关系覆盖");
  const baseValue = base.results.filter((entry) => entry.kind === "relation");
  t.eq(baseValue.length, 38, "v1 值型题必须是 38 道");
  t.eq(baseValue.every((entry) => entry.covered === false), true, "v1 值型题必须 0/38 覆盖");

  const run = checkFixture(v3, { baseline: v1 });
  const abs = run.results.filter((entry) => entry.kind === "abs");
  const comparison = run.results.filter((entry) => entry.kind === "comparison");
  t.eq(abs.length, 10, "ABS 必须是 10 道");
  t.eq(abs.every((entry) => entry.covered), true, "ABS 必须 10/10 通过（零关系行 + UNKNOWN）");
  t.eq(comparison.length, 2, "before/after 比较题必须是 2 道");
  t.eq(comparison.every((entry) => entry.covered), true, "比较题必须 2/2 通过（零关系行 + 两条对照事件都在）");
};

tests["RL-4 反例自测：v1 负对照 + 定向篡改全部判红（条数只许长）"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const report = runSelfTest(v3, { baseline: v1 });
  t.eq(report.ok, true, `未判红的反例：${JSON.stringify(report.results.filter((entry) => !entry.pass).map((entry) => entry.id))}`);
  t.eq(report.failed, 0, "反例必须 0 条漏判");
  t.eq(report.total >= 24, true, `反例数 ${report.total} 不得少于 checker v3 冻结时的 24 条（删反例要显式改基线）`);
  // 同一套反例换成 v4 夹具做底也必须全绿 —— v4 形态不许靠“换底”绕过任何一条负例。
  const v4Report = runSelfTest(readJson(V4), { baseline: v1 });
  t.eq(v4Report.ok, true, `v4 底下的漏判：${JSON.stringify(v4Report.results.filter((entry) => !entry.pass).map((entry) => entry.id))}`);
  t.eq(v4Report.total, report.total, "v3/v4 两底的反例条数必须一致");
};

tests["RL-5 离线工具零网络/零模型调用（静态断言）"] = (t) => {
  for (const file of [RENDERER, RENDERER_V4, COVERAGE]) {
    const source = nodeFs.readFileSync(file, "utf8");
    const network = /(fetch\s*\(|XMLHttpRequest|https?:\/\/|node:https?\b|node:net\b|chat\/completions|api\.openai|api\.anthropic)/.test(source);
    t.eq(network, false, `${nodePath.basename(file)} 不得含网络/模型调用（离线检查必须是 0 调用）`);
  }
};

/** RL2 复核指出的两类槽位负覆盖盲点：删槽位旧值行 / 槽位旧值冒充 current。 */
function slotTamper(v3, mode) {
  const copy = JSON.parse(JSON.stringify(v3));
  const question = copy.questions.find((entry) => entry.id === "KU-02");
  question.compactContext =
    mode === "drop"
      ? "seq=313 constraint current=retain-20 status=current"
      : "seq=313 constraint current=retain-20 status=current\nseq=311 constraint current=retain-10 status=current";
  return copy;
}

tests["RL-6 槽位旧值行被删必须判红（RL2 X17 盲点回归）"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const run = checkFixture(slotTamper(v3, "drop"), { baseline: v1 });
  t.eq(run.ok, false, "删掉 KU-02 的 seq=311 constraint old=retain-10 后检查器必须判红");
  const issues = run.results.flatMap((entry) => entry.issues);
  t.eq(
    issues.some((issue) => issue.includes("槽位旧值") && issue.includes("seq=311")),
    true,
    `必须点名槽位旧值未标旧：${issues.slice(0, 3).join(" | ")}`,
  );
};

tests["RL-7 槽位旧值冒充 current 必须判红（RL2 X21 盲点回归）"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const run = checkFixture(slotTamper(v3, "as-current"), { baseline: v1 });
  t.eq(run.ok, false, "把槽位旧值写成 current=retain-10 后检查器必须判红");
  const issues = run.results.flatMap((entry) => entry.issues);
  t.eq(
    issues.some((issue) => issue.includes("最新值事件")),
    true,
    `必须点名“current 不是最新值事件”：${issues.slice(0, 3).join(" | ")}`,
  );
};

// ---------------------------------------------------------------------------
// v4（渲染消歧）：状态不占 `key=value` 值位，改成行尾 `[<词>]`。
// 盯住三件事：① 确定性重放逐字节相同；② 与 v3 只差状态书写形态（逐行反向还原必须相等）；
// ③ 覆盖判据一条不松（50/50、值型 38/38），且 compact 里再没有 `status=` 值位。
// ---------------------------------------------------------------------------

tests["RL-8 v4 确定性重放，且与 v3 只差状态书写形态"] = (t) => {
  const v1 = readJson(V1);
  const v3 = readJson(V3);
  const v4 = readJson(V4);
  const out = nodePath.join(nodeOs.tmpdir(), `k27-relation-v4-rerender-${process.pid}.json`);
  try {
    const run = spawnSync(process.execPath, [RENDERER_V4, V1, out], { cwd: ROOT, encoding: "utf8" });
    t.eq(run.status, 0, `v4 重渲染必须成功：${(run.stderr || "").slice(0, 400)}`);
    t.eq(sha256(out), FROZEN.v4, "v4 重渲染结果必须与冻结 v4 逐字节相同");
  } finally {
    nodeFs.rmSync(out, { force: true });
  }
  const verify = spawnSync(process.execPath, [RENDERER_V4, "--verify", V3, V4], { cwd: ROOT, encoding: "utf8" });
  t.eq(verify.status, 0, `v4↔v3 逐行比对必须通过：${(verify.stderr || verify.stdout || "").slice(0, 400)}`);
  const report = JSON.parse(verify.stdout);
  t.eq(report.issues, [], `v4 与 v3 除状态形态外不得有任何漂移：${report.issues.slice(0, 5).join(" / ")}`);
  t.eq(report.changedQuestions > 0, true, "必须真的改写了题（否则消歧根本没生效）");
  // v3 与 v4 的题面/答案等字段逐字相同
  const byId = new Map(v4.questions.map((question) => [question.id, question]));
  const drift = [];
  for (const source of v3.questions) {
    const target = byId.get(source.id);
    for (const key of new Set([...Object.keys(source), ...Object.keys(target)])) {
      if (key === "compactContext" || key === "note") continue;
      if (JSON.stringify(source[key]) !== JSON.stringify(target[key])) drift.push(`${source.id}.${key}`);
    }
  }
  t.eq(drift, [], `v3↔v4 的非 compact 字段差异必须为 0 处：${drift.slice(0, 8).join(" / ")}`);
  t.eq(v4.frozen, true, "v4 必须标 frozen");
  t.eq(v3.note !== v4.note, true, "v4 的 note 必须写清自己与 v3 的差别（不许沿用 v3 说明）");
};

tests["RL-9 v4 覆盖判据一条不松：50/50、值型 38/38、不可变字段零漂移"] = (t) => {
  const v1 = readJson(V1);
  const v4 = readJson(V4);
  const run = checkFixture(v4, { baseline: v1 });
  t.eq(run.ok, true, `v4 覆盖失败题：${JSON.stringify(run.results.filter((entry) => !entry.covered).map((entry) => entry.id))}`);
  t.includes(run.coverage, "50/50", "v4 总覆盖必须是 50/50");
  t.includes(run.coverage, "值型题 38/38", "v4 值型题必须是 38/38");
  t.eq(run.immutable.ok, true, `v4 不可变字段漂移：${run.immutable.issues.join(" | ")}`);
};

tests["RL-10 v4 的 compact 里再没有 status= 值位，每处状态都变成方括号标签"] = (t) => {
  const v3 = readJson(V3);
  const v4 = readJson(V4);
  let v3StatusTokens = 0;
  let v4StatusTokens = 0;
  let v4Tags = 0;
  for (const question of v3.questions) v3StatusTokens += (question.compactContext.match(/(?:^|\s)status=[^\s]+/g) ?? []).length;
  for (const question of v4.questions) {
    v4StatusTokens += (question.compactContext.match(/(?:^|\s)status=[^\s]+/g) ?? []).length;
    v4Tags += (question.compactContext.match(/(?:^|\s)\[[^\]]+\]/g) ?? []).length;
  }
  t.eq(v3StatusTokens > 0, true, "v3 里必须本来就有 status= 值位（否则本消歧没有对象）");
  t.eq(v4StatusTokens, 0, `v4 里不许再出现 status= 值位，实际 ${v4StatusTokens} 处`);
  t.eq(v4Tags, v3StatusTokens, `v4 的方括号标签数（${v4Tags}）必须等于 v3 的 status 值位数（${v3StatusTokens}）`);
  // 原文投影行（ABS / before-after 比较题）逐字不变
  for (const id of ["ABS-01", "ABS-10", "TR-01", "TR-02"]) {
    const a = v3.questions.find((question) => question.id === id);
    const b = v4.questions.find((question) => question.id === id);
    t.eq(a.compactContext, b.compactContext, `${id} 是原文投影题，v4 必须逐字不变`);
  }
};

