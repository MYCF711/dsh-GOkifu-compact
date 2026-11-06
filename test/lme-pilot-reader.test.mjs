/**
 * lme-pilot-reader.test.mjs —— K-27 pilot 的预注册与无泄漏判据
 *
 * 只测纯函数；不发模型请求、不写证据。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { selectPilot, normalizeReaderAnswer, buildMessages, summarize } from "../scripts/lme-pilot-reader.mjs";
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
