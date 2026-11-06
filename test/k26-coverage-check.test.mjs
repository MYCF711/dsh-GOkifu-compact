/**
 * k26-coverage-check.test.mjs —— K-26C 覆盖检查器的纯判据
 *
 * 只测锚点覆盖公式与清单校验；不读 live 摘要、不发模型。
 */

import { computeCoverage, validateMustKeep } from "../scripts/k26-coverage-check.mjs";

export const tests = {};

tests["K26C-1 锚点覆盖：命中/缺失/空清单"] = (t) => {
  const summary = "用户要求不重启 DSH；失败是 not a git repository。";
  const mustKeep = [
    { kind: "constraint", text: "不重启 DSH", sourceSeq: 10, anchor: "不重启 DSH" },
    { kind: "failure", text: "not a git repository", sourceSeq: 22, anchor: "not a git repository" },
    { kind: "state", text: "当前节点 n2", sourceSeq: 30, anchor: "n2" },
  ];
  const r = computeCoverage(summary, mustKeep);
  t.eq(r.status, "OK", "有清单");
  t.eq(r.total, 3, "总数");
  t.eq(r.matched, 2, "命中 2");
  t.eq(r.coverage, 2 / 3, "覆盖率");
  t.eq(r.missing.map((m) => m.kind), ["state"], "缺失项");

  const empty = computeCoverage(summary, []);
  t.eq(empty.status, "NOT_RUN", "空清单必须 NOT_RUN");
  t.eq(empty.coverage, null, "不能编造 0 覆盖");
};

tests["K26C-2 清单校验：kind/seq/anchor 缺一不可"] = (t) => {
  t.eq(validateMustKeep([{ kind: "constraint", text: "x", sourceSeq: 1, anchor: "x" }]), [], "合法清单");
  const errors = validateMustKeep([{ kind: "other", text: "", sourceSeq: "1", anchor: "" }]);
  t.eq(errors.length, 4, "四项都报错");
};

tests["K26C-3 同义改写不算锚点命中（下界口径）"] = (t) => {
  const r = computeCoverage("用户说不要重启。", [
    { kind: "constraint", text: "用户要求不得重启 DSH", sourceSeq: 10, anchor: "不得重启" },
  ]);
  t.eq(r.matched, 0, "同义改写不冒充命中");
  t.eq(r.coverage, 0, "下界为 0");
};
