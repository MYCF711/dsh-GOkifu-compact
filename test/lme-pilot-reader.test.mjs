/**
 * lme-pilot-reader.test.mjs —— K-27 pilot 的预注册与无泄漏判据
 *
 * 只测纯函数；不发模型请求、不写证据。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { selectPilot, normalizeReaderAnswer, buildMessages, buildTwoStepMessages, buildAnswerMessages, summarize, READER_PROMPTS } from "../scripts/lme-pilot-reader.mjs";
import { assertReaderPayload, makeReaderPayload, TYPES } from "../scripts/lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "evidence", "lme-task50.fixtures.json"), "utf8"));

export const tests = {};

tests["K27-P1 预注册选题：五类各 2 题，顺序取冻结夹具前两个"] = (t) => {
  const selected = selectPilot(FIXTURES.questions);
  t.eq(selected.length, 10, "必须 10 题");
  t.eq([...new Set(selected.map((item) => item.type))], TYPES, "五类齐全且顺序固定");
  for (const type of TYPES) t.eq(selected.filter((item) => item.type === type).length, 2, `${type} 必须 2 题`);
  t.eq(selected.map((item) => item.id), ["IE-01", "IE-02", "MR-01", "MR-02", "KU-01", "KU-02", "TR-01", "TR-02", "ABS-01", "ABS-02"], "ID 顺序必须固定");
  t.eq(selectPilot(FIXTURES.questions).map((item) => item.id), selected.map((item) => item.id), "两次选择必须一致");
};

tests["K27-P2 reader 只收到四字段，金标准/证据不进入请求"] = (t) => {
  for (const item of selectPilot(FIXTURES.questions)) {
    for (const arm of ["full", "compact"]) {
      const payload = makeReaderPayload(item, arm);
      assertReaderPayload(payload);
      const text = buildMessages(payload).map((message) => message.content).join("\n");
      for (const key of ["evidenceSeqs", "grader", "applicability", "answer"]) {
        t.eq(new RegExp(`(?:^|\\n)\\s*${key}\\s*:`).test(text), false, `${item.id}/${arm} 不许带 ${key} 字段`);
      }
      t.eq(text.includes(item.id), false, `${item.id}/${arm} 请求不许带题号以外的台账信息`);
    }
  }
};

tests["K27-P3 答案归一化只去首尾/一层包裹，不做语义改写"] = (t) => {
  t.eq(normalizeReaderAnswer(" UNKNOWN \n"), "UNKNOWN", "空白");
  t.eq(normalizeReaderAnswer("```n1```"), "n1", "一层反引号");
  t.eq(normalizeReaderAnswer('"a,b"'), "a,b", "一层双引号");
  t.eq(normalizeReaderAnswer("“20”"), "20", "一层中文引号");
  t.eq(normalizeReaderAnswer("retain-20"), "retain-20", "正文不许改");
};

tests["K27-P4 汇总按臂/类型计数，错误保留但不改分母"] = (t) => {
  const selected = selectPilot(FIXTURES.questions);
  const results = [];
  for (const item of selected) {
    for (const arm of ["full", "compact"]) {
      const correct = !(item.id === "KU-02" && arm === "compact");
      results.push({ id: item.id, type: item.type, arm, grade: { correct, code: correct ? "ok" : "exact-mismatch" }, error: null });
    }
  }
  const report = summarize(selected, results);
  t.eq(report.summary.questions, 10, "题数");
  t.eq(report.summary.calls, 20, "调用数");
  t.eq(report.summary.fullCorrect, 10, "full 全对");
  t.eq(report.summary.compactCorrect, 9, "compact 少 1");
  t.eq(report.summary.errors.length, 1, "错误保留");
  t.eq(report.summary.byType.KU.compact.correct, 1, "KU compact 1/2");
  t.eq(report.status, "PILOT_ONLY", "不许冒充正式质量门");
};

tests["K27-P5 提示词 v2 是独立预注册变体，v1 保持默认"] = (t) => {
  t.eq(READER_PROMPTS.v1.includes("Never substitute"), false, "v1 不含 v2 的弃答规则");
  t.eq(READER_PROMPTS.v2.includes("Never substitute a status word"), true, "v2 明确禁止用状态词代替 UNKNOWN");
  const payload = makeReaderPayload(selectPilot(FIXTURES.questions)[0], "compact");
  t.eq(buildMessages(payload)[0].content, READER_PROMPTS.v1, "默认仍是 v1");
  t.eq(buildMessages(payload, { variant: "v2" })[0].content, READER_PROMPTS.v2, "显式 v2");
  t.eq(buildMessages(payload, { variant: "v2" })[1].content.includes(payload.question), true, "题目仍在 user 消息");
};

tests["K27-P6 未知变体必须报错，不许静默回落"] = (t) => {
  const payload = makeReaderPayload(selectPilot(FIXTURES.questions)[0], "full");
  let message = "";
  try {
    buildMessages(payload, { variant: "v3" });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  t.eq(/unknown reader prompt variant|two-step/.test(message), true, "未知变体必须抛错");
};

tests["K27-P7 v3 两步协议：抽取只看上下文，回答只看 span"] = (t) => {
  const payload = makeReaderPayload(selectPilot(FIXTURES.questions)[3], "compact");
  const extract = buildTwoStepMessages(payload, { step: "extract" });
  t.eq(extract[0].content, READER_PROMPTS.v3extract, "抽取系统提示");
  t.eq(extract[1].content.includes(payload.context), true, "抽取看到上下文");
  t.eq(extract[1].content.includes("Evidence span"), false, "抽取阶段没有 span");
  const answer = buildAnswerMessages(payload, "span-fixture");
  t.eq(answer[0].content, READER_PROMPTS.v3answer, "回答系统提示");
  t.eq(answer[1].content.includes("span-fixture"), true, "回答只看 span");
  t.eq(answer[1].content.includes(payload.context), false, "回答不再看完整上下文");
  t.eq(READER_PROMPTS.v3answer.includes("Never substitute"), true, "弃答规则");
};
