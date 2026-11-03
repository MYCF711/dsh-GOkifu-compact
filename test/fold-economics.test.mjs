/**
 * fold-economics.test.mjs —— 折叠划不划算的算法（C462）
 *
 * 这个脚本存在的理由：上一轮留了个待办「45% vs 70% 该不该改」，而**不能照抄官方**（人家压缩点在窗口顶部）。
 * 要回答它，只需要三个量：有效输入单价、单次折叠成本、单次折叠省下的上下文。
 */
import { effectiveInputPrice, foldPayback } from "../scripts/fold-economics.mjs";

export const tests = {};

tests["C462 有效输入单价：命中率越高越便宜，两端都要掐准"] = (t) => {
  const hit = 0.003;
  const miss = 0.15;
  t.eq(effectiveInputPrice({ hitRate: 1, hit, miss }), 0.003, "全命中 ⇒ 就是 hit 价");
  t.eq(effectiveInputPrice({ hitRate: 0, hit, miss }), 0.15, "全不命中 ⇒ 就是 miss 价");
  const half = effectiveInputPrice({ hitRate: 0.5, hit, miss });
  t.eq(Math.abs(half - (0.003 + 0.15) / 2) < 1e-12, true, "一半一半 ⇒ 两者均值");
  // 命中率越界要夹住（别让外部参数把结论翻掉）
  t.eq(effectiveInputPrice({ hitRate: 2, hit, miss }), 0.003, ">1 按 1");
  t.eq(effectiveInputPrice({ hitRate: -1, hit, miss }), 0.15, "<0 按 0");
};

tests["C462 回本点：折叠成本 ÷ 每次请求省下的钱"] = (t) => {
  // 一次折叠花 $0.03，省下 100k token，单价 $0.06/M ⇒ 每次请求省 $0.006 ⇒ 5 次回本
  const r = foldPayback({ foldCostUsd: 0.03, shadowedTokens: 100_000, pricePerMTok: 0.06 });
  t.eq(Math.abs(r.perRequestUsd - 0.006) < 1e-12, true, "每次请求省下的钱");
  t.eq(r.requestsNeeded, 5, "回本点 5 次");
  // 单价为零（全免费）⇒ 永远回不了本，但也不该崩
  t.eq(foldPayback({ foldCostUsd: 0.03, shadowedTokens: 100_000, pricePerMTok: 0 }).requestsNeeded, null, "单价 0 ⇒ null");
  // 脏数据：不许返回 Infinity/NaN
  t.eq(foldPayback({ foldCostUsd: 0, shadowedTokens: 100_000, pricePerMTok: 0.06 }).requestsNeeded, null, "成本 0 ⇒ null");
  t.eq(foldPayback({ foldCostUsd: 0.03, shadowedTokens: 0, pricePerMTok: 0.06 }).requestsNeeded, null, "没省下东西 ⇒ null");
  t.eq(Number.isNaN(foldPayback({ foldCostUsd: NaN, shadowedTokens: 1, pricePerMTok: 1 }).perRequestUsd), false, "非法输入不产生 NaN");
};

tests["C462 反直觉但重要：命中率高 ⇒ 回本点更高（缓存让「留着上下文」变便宜）"] = (t) => {
  const cheap = foldPayback({ foldCostUsd: 0.03, shadowedTokens: 100_000, pricePerMTok: effectiveInputPrice({ hitRate: 0.95, hit: 0.003, miss: 0.15 }) });
  const dear = foldPayback({ foldCostUsd: 0.03, shadowedTokens: 100_000, pricePerMTok: effectiveInputPrice({ hitRate: 0.3, hit: 0.003, miss: 0.15 }) });
  t.eq(cheap.requestsNeeded > dear.requestsNeeded, true, "命中率高（便宜）⇒ 要更多次请求才回本");
};
