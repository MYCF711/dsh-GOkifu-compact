/**
 * summary-refs.test.mjs —— 摘要引用探针的口径（C456）
 *
 * 这个探针存在的唯一理由：**验证 C455（提示词补规则）到底有没有用**。
 * 所以它最容易犯的错不是算错数，而是**用错分母**：
 *   · 把没有 `quality` 的老折叠算进分母 ⇒ 比例永远"很健康"；
 *   · 拿总数比 ⇒ 折叠越多越像恶化；
 *   · 把「引用更早的实体」（回溯历史 kifu）算成问题 ⇒ 天天报警，最后没人看。
 */
import { summarizeRefs, compareWithBaseline } from "../scripts/summary-refs.mjs";

export const tests = {};

const mark = (at, trigger, quality) => ({ at, trigger, ...(quality === undefined ? {} : { quality }) });

tests["C456 只统计带 quality 的折叠（老折叠没采集方向，混进分母会把比例算漂亮）"] = (t) => {
  const marks = [
    mark(100, "pressure", { unknownIds: [], outOfRangeLater: ["n9"], outOfRangeEarlier: [] }),
    mark(200, "pressure"), // 没有 quality
    mark(300, "tier2"),
  ];
  const r = summarizeRefs(marks);
  t.eq(r.folds, 3, "折叠总数照实记");
  t.eq(r.withQuality, 1, "只有 1 条能判方向");
  t.eq(r.foldsWithLater, 1, "分母是 1，不是 3");
};

tests["C456 三种引用分开数：更晚=问题，更早=正常，未知=编造/旧编号"] = (t) => {
  const marks = [
    mark(100, "pressure", { unknownIds: ["n999"], outOfRangeLater: ["e7", "n8"], outOfRangeEarlier: ["n1"] }),
    mark(200, "tier2", { unknownIds: [], outOfRangeLater: ["n10"], outOfRangeEarlier: [] }),
  ];
  const r = summarizeRefs(marks);
  t.eq(r.later, 3, "更晚的 id 共 3 个");
  t.eq(r.earlier, 1, "更早的单独计数（不算问题）");
  t.eq(r.unknown, 1, "未知 id 单独计数");
  t.eq(r.foldsWithLater, 2, "两条折叠都有更晚引用");
  t.eq(r.byTrigger.pressure, 1, "按 trigger 分组要能看出 pressure 也有");
  t.eq(r.byTrigger.tier2, 1, "tier2 单独一组");
};

tests["C456 since：只看基线时间点之后的折叠（验证 C455 必须这样比）"] = (t) => {
  const marks = [mark(100, "pressure", { outOfRangeLater: ["n9"] }), mark(500, "pressure", { outOfRangeLater: [] })];
  const all = summarizeRefs(marks);
  t.eq(all.foldsWithLater, 1, "全量里 1 条");
  const recent = summarizeRefs(marks, { since: 400 });
  t.eq(recent.folds, 1, "只看 400 之后：1 条");
  t.eq(recent.foldsWithLater, 0, "那条是干净的 ⇒ 修复后应为 0");
};

tests["C456 compareWithBaseline：没有基线要说清怎么建，而不是假装通过"] = (t) => {
  const cur = summarizeRefs([mark(1, "pressure", { outOfRangeLater: [] })]);
  const none = compareWithBaseline(cur, null);
  t.eq(none.hasBaseline, false, "没有基线");
  t.includes(none.line, "--write", "要告诉人怎么建基线");
  const withBase = compareWithBaseline(cur, { since: 0, withQuality: 4, foldsWithLater: 2 });
  t.eq(withBase.hasBaseline, true, "有基线");
  t.includes(withBase.line, "基线当时", "要把两边摆在一起");
  t.eq(withBase.beforeRatio, 0.5, "基线时 2/4 = 50%");
  t.eq(withBase.afterRatio, 0, "现在 0/1 = 0%");
};

tests["C456 分母为 0 时不许除出 Infinity（空库上跑探针不能崩）"] = (t) => {
  const empty = summarizeRefs([]);
  t.eq(empty.withQuality, 0, "没有折叠");
  const cmp = compareWithBaseline(empty, { since: 0, withQuality: 0, foldsWithLater: 0 });
  t.eq(cmp.afterRatio, null, "分母 0 ⇒ null，不是 NaN/Infinity");
  t.includes(cmp.line, "—", "比例位显示破折号");
};

tests["C469 按「有没有跑过清洗」分队列：时间基线会把旧代码的折叠一直算进分子"] = (t) => {
  const marks = [
    // 修复前：没有 sanitizedIds 字段
    mark(100, "pressure", { unknownIds: [], outOfRangeLater: ["n9"], outOfRangeEarlier: [] }),
    mark(200, "pressure", { unknownIds: [], outOfRangeLater: [], outOfRangeEarlier: [] }),
    // 修复后：字段存在（哪怕是 0）
    // ★ 注意：`sanitizedIds` 在 **foldMark 顶层**（engine 就是这么写的），不在 quality 里
    { ...mark(300, "pressure", { unknownIds: [], outOfRangeLater: [], outOfRangeEarlier: [] }), sanitizedIds: 0, sanitizeRan: true },
    { ...mark(400, "pressure", { unknownIds: [], outOfRangeLater: ["n7"], outOfRangeEarlier: [] }), sanitizedIds: 3 },
  ];
  const r = summarizeRefs(marks);
  t.eq(r.protectedFolds, 2, "有字段的两条是修复后队列");
  t.eq(r.protectedWithLater, 1, "修复后仍有一条带更晚实体（说明清洗没挡住，要查）");
  t.eq(r.unprotectedFolds, 2, "没有字段的是修复前队列");
  t.eq(r.unprotectedWithLater, 1, "修复前的历史账");
  t.eq(r.foldsWithLater, 2, "总数仍然是 2（两个队列加起来）");
  // 真实场景：7 条"新折叠"其实都是重启前旧代码跑的 ⇒ 不该算进修复后队列
  const realish = [mark(500, "pressure", { outOfRangeLater: ["n1"] }), mark(600, "pressure", { outOfRangeLater: ["n2"] })];
  const rr = summarizeRefs(realish, { since: 400 });
  t.eq(rr.protectedFolds, 0, "时间过滤后仍然没有修复后样本");
  t.includes(rr.protectedFolds === 0 ? "**还没有**" : "ok", "**还没有**", "空队列必须明说，别让人以为 0% 就是修好了");
};

tests["C482 「跑过清洗」要能证明：sanitizeRan 或替换数>0；空转的单列一栏"] = (t) => {
  const mk = (at, extra, later) => ({ at, trigger: "pressure", quality: { unknownIds: [], outOfRangeLater: later, outOfRangeEarlier: [] }, ...extra });
  const marks = [
    mk(100, { sanitizedIds: 0, sanitizeRan: false }, ["n9"]), // 空转（range 为空）
    mk(200, { sanitizedIds: 3, sanitizeRan: true }, []), // 真跑过且干净
    mk(300, { sanitizedIds: 6 }, []), // 老记录：替换数>0 ⇒ 也算跑过
    mk(400, { sanitizedIds: 0 }, ["n8"]), // 老记录且替换 0 ⇒ 说不清
  ];
  const r = summarizeRefs(marks);
  t.eq(r.protectedFolds, 2, "真跑过的 2 条（含老记录里替换数>0 的）");
  t.eq(r.protectedWithLater, 0, "跑过的里面没有'更晚实体'");
  t.eq(r.unconfirmedFolds, 1, "老记录且替换 0 ⇒ 未确认");
  t.eq(r.unconfirmedWithLater, 1, "而它确实带更晚实体 —— 正是真机那条的样子");
  t.eq(r.unprotectedFolds, 1, "sanitizeRan:false 明确没跑的，算未保护而不是未确认");
};

tests["C483 按官方比例估算 token：中英分开算（0.3 / 0.6）"] = async (t) => {
  const m = await import("../scripts/tool-result-share.mjs");
  t.eq(m.estimateTokensByOfficialRatio("hello world"), 3, "11 个英文字符 × 0.3 ≈ 3");
  t.eq(m.estimateTokensByOfficialRatio("上下文压缩"), 3, "5 个中文字符 × 0.6 = 3");
  t.eq(m.estimateTokensByOfficialRatio(""), 0, "空串 0");
  const mixed = m.estimateTokensByOfficialRatio("bash 输出 ok");
  t.eq(mixed > 0, true, "混排也要算得出来");
  // 同样的字符数，中文比英文贵一倍 —— 这是官方口径的直接后果
  t.eq(
    m.estimateTokensByOfficialRatio("中中中中中") > m.estimateTokensByOfficialRatio("aaaaa"),
    true,
    "5 个中文应比 5 个英文贵",
  );
};
