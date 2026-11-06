/**
 * cache-rate.test.mjs —— 真机缓存命中率的算法（C362）
 *
 * A1「命中约 97%」以前是从成本倒推的；有了这个工具才是**直接量**出来的。
 */
import { aggregateCacheRate, usagesFromSessionText } from "../scripts/cache-rate.mjs";

export const tests = {};

tests["C362 命中率分母是 miss+hit（不是 inputTokens）"] = (t) => {
  // 真机样本形状：inputTokens 只含未命中
  const agg = aggregateCacheRate([
    { inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: 19584 },
    { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 0 },
  ]);
  t.eq(agg.requests, 2, "两条都要计");
  t.eq(agg.miss, 3158, "未命中相加");
  t.eq(agg.hit, 19584, "命中相加");
  t.eq(agg.output, 357, "输出相加");
  // 19584 / (3158 + 19584) = 0.8611...
  t.eq(Math.abs(agg.hitRate - 19584 / (3158 + 19584)) < 1e-12, true, `命中率算错：${agg.hitRate}`);

  // 空/异常输入不许崩，也不许算成 100%
  t.eq(aggregateCacheRate([]).hitRate, null, "空输入 ⇒ null");
  t.eq(aggregateCacheRate([{ inputTokens: "x" }]).requests, 0, "非法样本要跳过");
};

tests["C362 从会话文本抽 usage：只认 JSON 行，且取 data.usage"] = (t) => {
  const line = JSON.stringify({ type: "assistant/message", data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 } } });
  const usages = usagesFromSessionText([line, "不是 JSON 但含 cacheReadTokens", JSON.stringify({ data: {} })].join("\n"));
  t.eq(usages.length, 1, "只应抽出 1 条合法 usage");
  t.eq(usages[0].cacheReadTokens, 90, "字段要原样带出");
};

tests["C363 按会话算钱：贵的排前面，且成本记账口径正确"] = async (t) => {
  const { sessionCosts } = await import("../scripts/cache-rate.mjs");
  const groups = [
    { session: "cheap", usages: [{ inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 }] },
    { session: "pricey", usages: [{ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }] },
  ];
  const rows = sessionCosts(groups);
  t.eq(rows.map((r) => r.session), ["pricey", "cheap"], "贵的排前面");
  t.eq(Math.abs(rows[0].cost - 0.15) < 1e-9, true, `1M 未命中应 $0.15，实际 ${rows[0].cost}`);
  t.eq(Math.abs(rows[1].cost - 1000 * 0.15 / 1e6) < 1e-12, true, "小的按比例");
  t.eq(sessionCosts([]), [], "空输入空数组");
  t.eq(sessionCosts([{ session: "x", usages: [] }]).length, 0, "没有请求的会话不占位");
};
