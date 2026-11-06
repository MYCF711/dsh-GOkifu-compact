/**
 * perf-probe.test.mjs —— 延迟探针的**统计口径**要有判据（C283）
 *
 * 探针本身不发网络请求就能测的部分：summarize() 的 p50 算法、探针清单的形状。
 * 为什么值得测：p50 算错不会报错，只会让人**误以为快/慢**。
 */
import { summarize, PROBES } from "../scripts/perf-probe.mjs";

export const tests = {};

tests["C283 延迟汇总：p50 取中位数，空输入不许崩"] = (t) => {
  t.eq(summarize([10, 20, 30]), { count: 3, min: 10, p50: 20, max: 30 }, "奇数个取中间");
  t.eq(summarize([30, 10, 20, 40]), { count: 4, min: 10, p50: 25, max: 40 }, "偶数个取中间两个的平均（四舍五入）");
  t.eq(summarize([]), { count: 0, min: null, p50: null, max: null }, "空输入不许崩");
  // 坏值（NaN/undefined）要被忽略，不许污染统计
  t.eq(summarize([10, Number.NaN, 30]).count, 2, "NaN 不计入样本");
};

tests["C283 探针清单：三个只读探针，且补账探针必须是 dryRun"] = (t) => {
  const ids = PROBES.map((p) => p.id);
  t.eq(ids, ["state", "models", "backfill-dry"], "探针清单必须等于这三个（改清单要改这条）");
  const backfill = PROBES.find((p) => p.id === "backfill-dry");
  t.eq(backfill.body.action, "backfill", "补账探针调 backfill");
  t.eq(backfill.body.dryRun, true, "补账探针必须 dryRun（绝不 resume / 不调模型）");
  // 所有探针都必须带 action（否则服务端只会回未知 action）
  for (const probe of PROBES) {
    t.eq(typeof probe.body?.action, "string", `${probe.id} 必须带 action`);
  }
};
