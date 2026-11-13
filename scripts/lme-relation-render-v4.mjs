#!/usr/bin/env node
/**
 * K-27 v4 关系行夹具渲染器（渲染消歧版，0 模型调用、0 语义猜测）。
 *
 * 为什么有 v4：v3 的关系行把 **状态词放在 `status=<值>` 的值位**上。
 * 真实 reader pilot 里 KU-01（题面问「最新**结算状态**是什么」）在 v3 compact 上
 * **3/3 样本都答成状态词 `settled`**（金标准 `later-ok`）——即 `status=` 这个键名
 * 与题面的「状态」同义对冲，模型把状态词的值当成了答案。同一题在 v1 compact 上是
 * `UNKNOWN / retained / later-ok`（1/3 对，不稳定），v3 把它变成「稳定地错」。
 *
 * v4 的唯一改动：**状态不再占 `key=value` 的值位**，改成行尾方括号标签：
 *
 *   v3：seq=303 e-ku01-a current=later-ok status=settled
 *   v4：seq=303 e-ku01-a current=later-ok [settled]
 *
 *   v3：seq=301 e-ku01-a old=failed status=superseded
 *   v4：seq=301 e-ku01-a old=failed [superseded]
 *
 *   v3：seq=374 e-ku08-a status=right-censored
 *   v4：seq=374 e-ku08-a [right-censored]
 *
 * 关键设计约束（为什么不在 v3 渲染器上加开关）：
 *   v3 的 `note` 字段里嵌了**生成器自身的 sha256**，任何对 `lme-relation-render.mjs`
 *   的改动都会让 v3 夹具无法逐字节重放（RL-1 会红）。所以 v4 走**独立新文件**：
 *   import v3 渲染器 → 拿它已经算好的行 → 只改状态 token 的**书写形态**。
 *   ⇒ 因此在数学上保证「v3 与 v4 除了状态书写形态以外逐字节相同」，不需要另做证明。
 *
 * 用法：
 *   node scripts/lme-relation-render-v4.mjs <v1-fixture> [out.json]
 *   node scripts/lme-relation-render-v4.mjs --stdout <v1-fixture>
 *   node scripts/lme-relation-render-v4.mjs --verify <v3.json> <v4.json>   # 只验「除状态形态外逐字相同」
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { renderFixture, sha256File } from "./lme-relation-render.mjs";

export const V4_SCHEMA = "lme-task50-fixtures-v1";

/** 行首形态：`seq=<n> <subject> ...`（主体里不含空白）。 */
const SEQ_PREFIX_RE = /^seq=(\d+)\s+\S+(?:\s|$)/;

/**
 * 把一行里的 `status=<token>` 改成 `[<token>]`。
 * 只认**独立的** status token（前后是行首/空白），不做任何子串替换。
 * 0 个 status ⇒ 该行是原文投影（ABS / before-after 比较题），**原样返回**；
 * >1 个 status ⇒ 渲染器不该产生这种行，直接抛错（不做猜测性改写）。
 */
export function disambiguateStatus(line) {
  if (!SEQ_PREFIX_RE.test(line)) throw new Error(`不是 seq 行，拒绝改写：${line}`);
  const tokens = line.split(/\s+/).filter(Boolean);
  const hits = tokens.map((token, index) => (token.startsWith("status=") ? index : -1)).filter((index) => index >= 0);
  if (hits.length === 0) return line;
  if (hits.length > 1) throw new Error(`一行出现 ${hits.length} 个 status token，拒绝猜测：${line}`);
  const index = hits[0];
  const status = tokens[index].slice("status=".length);
  if (status === "") throw new Error(`status 为空：${line}`);
  tokens[index] = `[${status}]`;
  return tokens.join(" ");
}

/** v4 行 → v3 行（用于 --verify 的反向还原与逐字比对）；原文投影行原样返回。 */
export function restoreStatus(line) {
  const match = /(?:^|\s)\[([^\]]+)\](?=\s|$)/.exec(line);
  if (!match) return line;
  return line.replace(match[0], `${match[0].startsWith(" ") ? " " : ""}status=${match[1]}`);
}

export function disambiguateCompact(text) {
  return String(text)
    .split("\n")
    .map((line) => (line.trim() === "" ? line : disambiguateStatus(line)))
    .join("\n");
}

function buildNote() {
  return [
    "K-27 v4 关系行夹具（渲染消歧版）：只在 v3 冻结夹具基础上把状态的**书写形态**从 `status=<词>` 改成行尾方括号 `[<词>]`，",
    "其余字节（主体 / 证据 seq / current / old / 附加字段 / 行序 / 行数）与 v3 逐字相同；状态词表与旧值标旧规则未变。",
    "题面、答案、evidenceSeqs、grader、applicability、fullContext 与 evidence/lme-task50.fixtures.json 逐字一致；v1 与 v3 文件本身未改字节。",
    "aliases 保持空（不得用别名把状态词或中文前后当等价答案）。",
    "为什么改形态：v3 pilot 的 KU-01 compact 3/3 样本答成状态词 settled（金标准 later-ok）—— status 占值位与题面的「状态」同义对冲。",
    `生成器 scripts/lme-relation-render-v4.mjs sha256=${sha256File(fileURLToPath(import.meta.url))}；`,
    "上游 v3 渲染器 scripts/lme-relation-render.mjs 未改。",
  ].join("");
}

/**
 * @param {object} v1Fixture 冻结的 v1 夹具
 * @returns {{fixture:object, derivations:Array}}
 */
export function renderFixtureV4(v1Fixture) {
  const { fixture: v3, derivations } = renderFixture(v1Fixture);
  const note = buildNote();
  const questions = v3.questions.map((question) => ({
    ...question,
    compactContext: disambiguateCompact(question.compactContext),
  }));
  return {
    fixture: {
      schema: V4_SCHEMA,
      frozen: true,
      note,
      questions,
    },
    derivations,
  };
}

/**
 * 只验「v4 与 v3 除状态书写形态外逐字相同」：
 * 把 v4 的每一行反向还原成 `status=<词>` 后，必须与 v3 的对应行**完全一致**；
 * 同时校验行数、行序、schema、frozen，以及除 note/compactContext 外的字段零漂移。
 */
export function verifyAgainstV3(v3Fixture, v4Fixture) {
  const issues = [];
  if (v3Fixture.schema !== v4Fixture.schema) issues.push(`schema 不同：${v3Fixture.schema} vs ${v4Fixture.schema}`);
  if (v3Fixture.frozen !== v4Fixture.frozen) issues.push("frozen 不同");
  if (v3Fixture.questions.length !== v4Fixture.questions.length) {
    issues.push(`题数不同：${v3Fixture.questions.length} vs ${v4Fixture.questions.length}`);
    return { ok: false, issues };
  }
  let changedLines = 0;
  let changedQuestions = 0;
  for (const [index, source] of v3Fixture.questions.entries()) {
    const target = v4Fixture.questions[index];
    if (source.id !== target.id) {
      issues.push(`第 ${index} 题 id 不同：${source.id} vs ${target.id}`);
      continue;
    }
    for (const key of new Set([...Object.keys(source), ...Object.keys(target)])) {
      if (key === "compactContext") continue;
      if (JSON.stringify(source[key]) !== JSON.stringify(target[key])) issues.push(`${source.id}.${key} 漂移`);
    }
    const sourceLines = String(source.compactContext).split("\n");
    const targetLines = String(target.compactContext).split("\n");
    if (sourceLines.length !== targetLines.length) {
      issues.push(`${source.id} 行数不同：${sourceLines.length} vs ${targetLines.length}`);
      continue;
    }
    let questionChanged = false;
    for (const [lineIndex, line] of sourceLines.entries()) {
      const restored = restoreStatus(targetLines[lineIndex]);
      if (restored !== line) issues.push(`${source.id} 第 ${lineIndex + 1} 行还原后不一致：${line} ≠ ${restored}`);
      if (targetLines[lineIndex] !== line) {
        changedLines += 1;
        questionChanged = true;
      }
      const hadStatus = /(?:^|\s)status=[^\s]+/.test(line);
      if (hadStatus) {
        if (/status=/.test(targetLines[lineIndex])) issues.push(`${source.id} 第 ${lineIndex + 1} 行仍含 status=：${targetLines[lineIndex]}`);
        if (!/\[[^\]]+\]/.test(targetLines[lineIndex])) issues.push(`${source.id} 第 ${lineIndex + 1} 行没有方括号状态标签：${targetLines[lineIndex]}`);
      } else if (targetLines[lineIndex] !== line) {
        issues.push(`${source.id} 第 ${lineIndex + 1} 行本无 status，却被改写：${targetLines[lineIndex]}`);
      }
    }
    if (questionChanged) changedQuestions += 1;
  }
  return { ok: issues.length === 0, issues, changedLines, changedQuestions };
}

function main(argv) {
  const args = argv.slice(2);
  const verifyAt = args.indexOf("--verify");
  if (verifyAt >= 0) {
    const [v3Path, v4Path] = args.filter((_arg, index) => index >= verifyAt && index <= verifyAt + 2).slice(1);
    if (!v3Path || !v4Path) {
      console.error("usage: node scripts/lme-relation-render-v4.mjs --verify <v3.json> <v4.json>");
      process.exit(2);
    }
    const report = verifyAgainstV3(JSON.parse(nodeFs.readFileSync(v3Path, "utf8")), JSON.parse(nodeFs.readFileSync(v4Path, "utf8")));
    console.log(JSON.stringify({ v3: v3Path, v4: v4Path, ...report }, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  const stdoutOnly = args.includes("--stdout");
  const rest = args.filter((arg) => arg !== "--stdout");
  const input = rest[0];
  const output = rest[1];
  if (!input) {
    console.error("usage: node scripts/lme-relation-render-v4.mjs [--stdout] <v1-fixture> [out.json]");
    process.exit(2);
  }
  if (output && nodePath.resolve(input) === nodePath.resolve(output)) {
    console.error("refusing to overwrite the source fixture");
    process.exit(2);
  }
  const source = JSON.parse(nodeFs.readFileSync(input, "utf8"));
  const { fixture: rendered, derivations } = renderFixtureV4(source);
  const report = {
    source: input,
    sourceSha256: sha256File(input),
    questions: rendered.questions.length,
    statusTags: rendered.questions.reduce((total, question) => total + (question.compactContext.match(/\[[^\]]+\]/g) ?? []).length, 0),
    derivations,
  };
  if (stdoutOnly || !output) {
    console.log(JSON.stringify({ ...report, fixture: rendered }, null, 2));
    return;
  }
  nodeFs.writeFileSync(output, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, output, outputSha256: sha256File(output) }, null, 2));
}

if (process.argv[1]?.endsWith("lme-relation-render-v4.mjs")) main(process.argv);
