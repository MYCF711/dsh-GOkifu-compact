/**
 * cache-usage.test.mjs —— 上下文缓存命中率的纯计算（C220）
 *
 * 为什么值得钉：本机实测 **97% 的输入 token 走缓存读**（1.23B vs 39M），
 * 也就是说"贵不贵"主要由**缓存有没有被破坏**决定，而不是我们注入了多少。
 * 这个数字一旦算错（比如把 totalTokens 当分母），优化方向就会整个歪掉。
 */

import {
  cacheRatio,
  createCacheUsage,
  accumulateCacheUsage,
  summarizeCacheUsage,
  BREAK_DROP,
} from "../scripts/cache-usage.mjs";

export const tests = {};

tests["C220 单次占比：cacheRead / (input + cacheRead)，字段缺失或分母为 0 ⇒ null（不猜）"] = (t) => {
  t.eq(cacheRatio({ inputTokens: 5664, cacheReadTokens: 16384 }), 16384 / 22048, "占 = 缓存读 / 总输入");
  t.eq(cacheRatio({ inputTokens: 100, cacheReadTokens: 0 }), 0, "没命中就是 0");
  t.eq(cacheRatio({ inputTokens: 0, cacheReadTokens: 100 }), 1, "全命中就是 1");
  t.eq(cacheRatio({ inputTokens: 0, cacheReadTokens: 0 }), null, "分母 0 ⇒ null");
  t.eq(cacheRatio({ inputTokens: 100 }), null, "缺 cacheReadTokens ⇒ null（旧版本日志）");
  t.eq(cacheRatio(null), null, "null 不许抛");
  t.eq(cacheRatio({ inputTokens: -1, cacheReadTokens: 5 }), null, "负的 input 不可信 ⇒ null");
};

tests["C220 累加：tokens 求和 + 中位数 + 最低值；不看 totalTokens（那是含输出的）"] = (t) => {
  let acc = createCacheUsage();
  const calls = [
    { inputTokens: 100, cacheReadTokens: 900, totalTokens: 999999 }, // 命中 90%
    { inputTokens: 50, cacheReadTokens: 950 }, // 95%
    { inputTokens: 400, cacheReadTokens: 600 }, // 60%
    { inputTokens: 0, cacheReadTokens: 0 }, // 无效，忽略
    { inputTokens: 1000, cacheReadTokens: 0 }, // 0%
  ];
  for (const u of calls) acc = accumulateCacheUsage(acc, u);
  const s = summarizeCacheUsage(acc);
  t.eq(s.calls, 4, "无效的一条不计数");
  t.eq(s.inputTokens, 1550, "计费输入 = 100+50+400+1000");
  t.eq(s.cacheTokens, 2450, "缓存读 = 900+950+600+0");
  t.eq(Math.round(s.savedShare * 100), 61, "总占比 2450/(1550+2450) ≈ 61%");
  t.eq(s.ratioMin, 0, "最低命中率 0（有一次完全没命中）");
  t.ok(s.ratioMedian > 0.5 && s.ratioMedian <= 0.95, `中位数应在 60%~95% 之间，实际 ${s.ratioMedian}`);
};

tests["C220 缓存断点：较上一次骤降超过 30pp 记一次；小幅抖动不算"] = (t) => {
  let acc = createCacheUsage();
  const seq = [0.95, 0.94, 0.93, 0.5, 0.9, 0.2];
  for (const r of seq) acc = accumulateCacheUsage(acc, { inputTokens: Math.round((1 - r) * 1000), cacheReadTokens: Math.round(r * 1000) });
  const s = summarizeCacheUsage(acc);
  // 0.94→0.93 不算；0.93→0.5 算断；0.5→0.9 上升不算；0.9→0.2 算断
  t.eq(s.breaks, 2, `只该有 2 次断点，实际 ${s.breaks}`);
  t.eq(BREAK_DROP, 0.3, "阈值就是 30pp —— 改它要同时改文档里的口径");
  const steady = [0.9, 0.85, 0.8, 0.75].reduce((a, r) => accumulateCacheUsage(a, { inputTokens: 100, cacheReadTokens: 900 }), createCacheUsage());
  t.eq(summarizeCacheUsage(steady).breaks, 0, "全命中时不产生断点");
};

tests["C220 边界：空累加器 / 坏输入 / 跨会话拼错的对象都不抛"] = (t) => {
  const empty = summarizeCacheUsage(createCacheUsage());
  t.eq(empty.calls, 0, "没数据 ⇒ calls 0");
  t.eq(empty.ratioMedian, null, "没数据 ⇒ 中位数 null（不是 0）");
  t.eq(empty.savedShare, null, "没数据 ⇒ 占比 null");
  t.eq(accumulateCacheUsage(null, { inputTokens: 10, cacheReadTokens: 10 }).calls, 1, "传 null 时自己建累加器");
  t.eq(accumulateCacheUsage({}, { inputTokens: 10, cacheReadTokens: 10 }).calls, 1, "传坏对象时自己建累加器");
  t.eq(summarizeCacheUsage(null).calls, 0, "summarize(null) 不许抛");
};
