/**
 * lme-alias-grader.test.mjs —— K-27 v2 的别名判分边界
 *
 * v2 只给 TR-01/02 增加“之前/之后”等价别名；题面、答案、grader、阈值、上下文均不变。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { gradeAnswer, validateFixtures } from "../scripts/lme-task50.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const V2 = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "evidence", "lme-task50-v2.fixtures.json"), "utf8"));

export const tests = {};

tests["K27-V2-1 exact 只接受声明的别名，不接受任意中文改写"] = (t) => {
  t.eq(gradeAnswer("before", "before", "exact").correct, true, "原答案");
  t.eq(gradeAnswer("before", "之前", "exact").correct, false, "未声明别名不许过");
  t.eq(gradeAnswer("before", "之前", "exact", ["之前"]).correct, true, "声明别名可过");
  t.eq(gradeAnswer("before", "之后", "exact", ["之前"]).correct, false, "错误别名必须红");
  t.eq(gradeAnswer("before", " 之前 ", "exact", ["之前"]).correct, true, "空白归一化后比对");
};

tests["K27-V2-2 v2 冻结夹具：50 题、schema/frozen 不变、只有 TR-01/02 带别名"] = (t) => {
  const v = validateFixtures(V2);
  t.eq(v.ok, true, `夹具必须合法：${v.errors.join("; ")}`);
  t.eq(V2.questions.length, 50, "50 题");
  t.eq(V2.schema, "lme-task50-fixtures-v1", "v2 只是新增可选别名，不换 schema");
  t.eq(V2.frozen, true, "must stay frozen");
  t.eq(V2.questions.filter((item) => Array.isArray(item.aliases) && item.aliases.length > 0).map((item) => item.id), ["TR-01", "TR-02"], "只允许这两题带别名");
  t.eq(V2.questions.find((item) => item.id === "TR-01").aliases, ["之前"], "TR-01 别名");
  t.eq(V2.questions.find((item) => item.id === "TR-02").aliases, ["之后"], "TR-02 别名");
};

tests["K27-V2-3 v1 金标准与题面逐字未改（只多 aliases 字段）"] = (t) => {
  const v1 = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "evidence", "lme-task50.fixtures.json"), "utf8"));
  t.eq(V2.questions.length, v1.questions.length, "题数一致");
  for (const [i, item] of V2.questions.entries()) {
    const orig = v1.questions[i];
    t.eq(item.id, orig.id, `${i} id`);
    t.eq(item.question, orig.question, `${item.id} 题面`);
    t.eq(item.answer, orig.answer, `${item.id} 答案`);
    t.eq(item.grader, orig.grader, `${item.id} grader`);
    t.eq(item.fullContext, orig.fullContext, `${item.id} full 上下文`);
    t.eq(item.compactContext, orig.compactContext, `${item.id} compact 上下文`);
  }
};
