/**
 * peak-pricing.test.mjs —— 峰谷两档价（C452）
 *
 * 为什么:我们的价目一路用的是**低谷价**（C271/C345），而官方原文是
 * "Off-peak rates are half of the peak rates"。高峰时段换算成北京时间是
 * **工作日 09:00–12:00 与 14:00–18:00** —— 正好是大家干活的时候。
 * 也就是说白天看到的成本可能**低报一倍**，而"低报比不报更糟"（C345 的话）。
 */
import { isPeakUtc, priceForModel, estimateFoldCostUsd, PEAK_MULTIPLIER } from "../src/ui.mjs";
import { summarizePlan, PEAK_MULTIPLIER as PLAN_PEAK } from "../scripts/backfill-plan.mjs";

export const tests = {};

// 2026-11-02 是周一
const mon = (h, m = 0) => Date.UTC(2026, 10, 2, h, m);
const sat = (h, m = 0) => Date.UTC(2026, 10, 7, h, m);

tests["C452 高峰判据：UTC 工作日 01–04 与 06–10 才算，边界必须掐准"] = (t) => {
  t.eq(isPeakUtc(mon(0, 59)), false, "00:59 不是高峰");
  t.eq(isPeakUtc(mon(1)), true, "01:00 进高峰");
  t.eq(isPeakUtc(mon(3, 59)), true, "03:59 还在高峰");
  t.eq(isPeakUtc(mon(4)), false, "04:00 出高峰");
  t.eq(isPeakUtc(mon(5, 59)), false, "05:59 不是（两个高峰之间有缝）");
  t.eq(isPeakUtc(mon(6)), true, "06:00 进第二个高峰");
  t.eq(isPeakUtc(mon(9, 59)), true, "09:59 还在");
  t.eq(isPeakUtc(mon(10)), false, "10:00 出");
  t.eq(isPeakUtc(sat(2)), false, "周六不算高峰");
  t.eq(isPeakUtc(Date.UTC(2026, 10, 8, 2)), false, "周日不算高峰");
  t.eq(isPeakUtc(new Date("not a date")), false, "非法时间不许抛，按非高峰处理");
};

tests["C452 单价：峰时正好是低谷的 2 倍，且两个模型都跟着翻"] = (t) => {
  t.eq(PEAK_MULTIPLIER, 2, "倍数 = 2（官方：off-peak 是 peak 的一半）");
  const off = priceForModel("deepseek-flash", { at: mon(0) });
  const on = priceForModel("deepseek-flash", { at: mon(1) });
  t.eq(off.peak, false, "低谷");
  t.eq(on.peak, true, "高峰");
  t.eq(on.miss, off.miss * 2, "miss 翻倍");
  t.eq(on.hit, off.hit * 2, "hit 翻倍");
  t.eq(on.out, off.out * 2, "out 翻倍");
  const pro = priceForModel("deepseek-v4-pro", { at: mon(1) });
  t.eq(pro.miss, 1.32, "pro 峰时 miss = 0.66 × 2");
  // 认不出的模型名仍然回落 flash，但要标 matched=false（调用方据此标注"按 flash 估"）
  const unknown = priceForModel("magpie/whatever", { at: mon(0) });
  t.eq(unknown.matched, false, "认不出 ⇒ matched=false");
};

tests["C452 估算：同一份 usage，峰时金额必须是低谷的两倍"] = (t) => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 1_000_000 };
  const off = estimateFoldCostUsd(usage, "deepseek-flash", { at: mon(0) });
  const on = estimateFoldCostUsd(usage, "deepseek-flash", { at: mon(1) });
  t.eq(off.toFixed(3), "0.150", "低谷：1M miss = $0.15");
  t.eq(on.toFixed(3), "0.300", "高峰：1M miss = $0.30");
  t.eq(on, off * 2, "正好两倍");
};

tests["C452 补账计划：两个价一起给（$X 低谷 / $2X 高峰），不许只给低谷让人以为那是上限"] = (t) => {
  const plan = summarizePlan([{ estTokens: 10_000_000, chunks: 10, requiredChunks: 1 }], {});
  t.eq(plan.costUsdPeak, Math.round(plan.costUsd * PLAN_PEAK * 100) / 100, "高峰价 = 低谷 × 2（各自四舍五入到分）");
  t.eq(plan.costUsdPeak >= plan.costUsd, true, "高峰不许便宜过低谷");
};
