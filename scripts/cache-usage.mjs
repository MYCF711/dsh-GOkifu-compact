/**
 * cache-usage.mjs —— 上下文缓存命中率的**纯计算**（C220）
 *
 * ## 为什么要它
 *
 * 本机所有模型调用都走 magpie → DeepSeek，而 DeepSeek 的 disk cache 能把**重叠前缀**按「cache read」
 * 计费（便宜一个数量级）。实测（2026-11-02，3,793 次调用）：
 * **缓存读取 1,222,171,136 tokens vs 计费输入 48,834,911 tokens** —— 96% 的输入走的是缓存。
 *
 * 也就是说：**我们真正的成本大头不在我们注入了多少，而在"缓存有没有被我们自己破坏"**。
 * 而这件事此前没有任何观测 —— 只有 `usage` 里的 `cacheReadTokens` 一直躺着没人看。
 *
 * ## 判据
 *
 * - `ratio` = cacheRead / (input + cacheRead)：**单次调用**的缓存占比（0–1）；
 * - `ratioMedian`：整段会话的中位数（比均值抗极端值）；
 * - `breaks`：`ratio` 相对**上一次调用**骤降超过 {@link BREAK_DROP} ⇒ 记一次"缓存断点"
 *   （典型原因：surface 中间某条被改写 / 摘要 / 界面重新排列）。
 *
 * 纯函数，不碰 fs、不碰宿主：日志由调用方解出来喂进来（doctor 复用同一次解压）。
 */

/** 判「缓存断点」的下降幅度（30 个百分点）。低于它就只是抖动，不是断。 */
export const BREAK_DROP = 0.3;

/**
 * 一次调用的缓存占比。
 * @param {{inputTokens?: number, cacheReadTokens?: number}} usage
 * @returns {number|null} 0–1；分母为 0 / 字段缺失 ⇒ null（不猜）
 */
export function cacheRatio(usage) {
  const input = Number(usage?.inputTokens);
  const cache = Number(usage?.cacheReadTokens);
  if (!Number.isFinite(input) || !Number.isFinite(cache)) return null;
  const denom = input + cache;
  if (denom <= 0) return null;
  if (input < 0 || cache < 0) return null; // 负数说明日志坏了，不参与统计（不猜）
  return cache / denom;
}

/** 新建累加器。 */
export function createCacheUsage() {
  return { calls: 0, inputTokens: 0, cacheTokens: 0, ratios: [], breaks: 0, lastRatio: null };
}

/**
 * 累加一次调用的 usage（就地修改传入的累加器）。
 * @param {ReturnType<typeof createCacheUsage>} acc
 * @param {{inputTokens?: number, cacheReadTokens?: number}} usage
 * @returns {ReturnType<typeof createCacheUsage>}
 */
export function accumulateCacheUsage(acc, usage) {
  const target = acc && typeof acc === "object" && Array.isArray(acc.ratios) ? acc : createCacheUsage();
  const ratio = cacheRatio(usage);
  if (ratio === null) return target;
  target.calls += 1;
  target.inputTokens += Number(usage.inputTokens) || 0;
  target.cacheTokens += Number(usage.cacheReadTokens) || 0;
  target.ratios.push(ratio);
  if (target.lastRatio !== null && ratio < target.lastRatio - BREAK_DROP) target.breaks += 1;
  target.lastRatio = ratio;
  return target;
}

/**
 * 汇总成可读结果。
 * @param {ReturnType<typeof createCacheUsage>} acc
 * @returns {{calls:number, inputTokens:number, cacheTokens:number, ratioMedian:number|null, ratioMin:number|null, breaks:number, savedShare:number|null}}
 *          `savedShare` = cacheTokens / (inputTokens + cacheTokens)，即"总输入里有多少是缓存读的"
 */
export function summarizeCacheUsage(acc) {
  const ratios = Array.isArray(acc?.ratios) ? acc.ratios : [];
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
  const inputTokens = Number(acc?.inputTokens) || 0;
  const cacheTokens = Number(acc?.cacheTokens) || 0;
  const denom = inputTokens + cacheTokens;
  return {
    calls: Number(acc?.calls) || 0,
    inputTokens,
    cacheTokens,
    ratioMedian: median,
    ratioMin: sorted.length === 0 ? null : sorted[0],
    breaks: Number(acc?.breaks) || 0,
    savedShare: denom > 0 ? cacheTokens / denom : null,
  };
}
