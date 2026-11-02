/**
 * audit-duplicates.test.mjs —— 「同一段代码写了两遍」的扫描器自己要有判据（C303）
 *
 * 它靠肉眼看不出重复：C303 那两处**函数名都不一样**（evidenceSpan vs evidenceSpanOf），
 * 内容一字不差。所以扫描器必须能认出「改名复制」。
 */
import { findDuplicateBodies, normalizeBody, ALLOW } from "../scripts/audit-duplicates.mjs";

export const tests = {};

tests["C303 能认出「改名复制」：函数名不同、内容一字不差"] = (t) => {
  const a = `function evidenceSpan(edge) {\n  const e = edge?.evidence;\n  if (typeof e === "number") return { start: e, end: e };\n  if (e) return { start: e.start, end: e.end };\n  return null;\n}`;
  const b = `function evidenceSpanOf(edge) {\n  const e = edge?.evidence;\n  if (typeof e === "number") return { start: e, end: e };\n  if (e) return { start: e.start, end: e.end };\n  return null;\n}`;
  const dupes = findDuplicateBodies([["a.mjs", a], ["b.mjs", b]], { minStatements: 3 });
  t.eq(dupes.length, 1, `必须认出一组：${JSON.stringify(dupes)}`);
  t.eq(dupes[0].files, 2, "跨两个文件");
  t.eq(dupes[0].sites.length, 2, "两个站点");
};

tests["C303 内容不同就不算重复（注释/空白差异也不算不同）"] = (t) => {
  const a = `function f(x) {\n  return x + 1;\n}\n`;
  const b = `function f(x) {\n  return x + 2;\n}\n`;
  t.eq(findDuplicateBodies([["a.mjs", a], ["b.mjs", b]], { minStatements: 1 }).length, 0, "内容不同不算重复");

  const c = `function g(x) {\n  // 同样的逻辑，只是多一行注释\n  return x + 1;\n}\n`;
  t.eq(normalizeBody("{ return x + 1; }"), normalizeBody("{\n  // 注释\n  return x + 1;\n}"), "注释不该影响归一化");
  t.eq(findDuplicateBodies([["a.mjs", a], ["c.mjs", c]], { minStatements: 1 }).length, 1, "只是注释不同仍算重复");
};

tests["C303 白名单必须写明理由（否则会变成「把重复藏起来的地方」）"] = (t) => {
  for (const [key, why] of Object.entries(ALLOW)) {
    t.eq(typeof why === "string" && why.length > 0, true, `白名单 ${key} 必须写理由`);
  }
};


tests["C323 foldMark 字段读写一致性：写进别的文件而读 foldMarks 必须被抓到"] = async (t) => {
  const { auditMarkFieldWrites } = await import("../scripts/audit-field-reads.mjs");
  t.eq(typeof auditMarkFieldWrites, "function", "必须导出 auditMarkFieldWrites");

  const engine = "g.foldMarks.push({\n      at: 1,\n      seqStart: 1,\n      summaryChars: 3,\n    });";
  // 读一个构造里没有的字段 ⇒ 必须报（C321 的 bug 形态）
  const bad = auditMarkFieldWrites(engine, [["scripts/doctor.mjs", "const v = mark?.finishReason;"]]);
  t.eq(bad.length, 1, `必须抓到：${JSON.stringify(bad)}`);
  t.includes(bad[0], "finishReason", "要点名字段");

  // 构造里有 ⇒ 不报
  const engine2 = "g.foldMarks.push({\n      finishReason: null,\n    });";
  t.eq(auditMarkFieldWrites(engine2, [["scripts/doctor.mjs", "const v = mark?.finishReason;"]]), [], "有写入就不该报");

  // 白名单（宿主透传）不报
  t.eq(auditMarkFieldWrites(engine, [["a.mjs", "const u = mark?.usage;"]]), [], "usage 是宿主字段");
  // 注释里的示例不算读取
  t.eq(auditMarkFieldWrites(engine, [["a.mjs", "// 例如 foldMark.whatever\nconst x = 1;"]]), [], "注释不算读取");
  // 找不到构造点 ⇒ 检查器自己要报（防永远绿）
  t.eq(auditMarkFieldWrites("const q = 1;", []).length, 1, "找不到 anchor 必须报");
};
