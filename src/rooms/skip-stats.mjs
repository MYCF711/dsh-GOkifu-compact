/**
 * skip-stats.mjs —— 热清单注入的**统计口径**（C681 · P1 归位第三次搬迁）
 *
 * 四个纯函数，原来在 `src/engine.mjs` 的"统计与日志"类里：
 *   · `injectionErrorDelta` —— 这次「本该注入却没注入」算不算一次渲染失败；
 *   · `skipReasonKey` —— 跳过原因分布（identical / throttled-events / no-ledger… 都不是缺陷，但分布能回答"在哪一步被省掉"）；
 *   · `injectActionKey` —— append / replace 分别计数：**append 缓存友好、replace 会让 disk cache 从那条消息起失去前缀匹配**；
 *   · `bumpSkipReason` —— 有界累加（最多 8 个键，其余归 other，防止极端 reason 撑爆统计表）。
 *
 * 全部不碰 this / ctx / 磁盘 / 网络。**搬迁纪律**：逐字复制，逻辑零改动；engine 保留 import + export。
 */

/**
 * ★ C90：注入路径**渲染失败**的可观测性。
 *   `decideInjection` 的 catch 会返回 `{action:"skip", reason:"error:…"}` 并只写一行日志 ——
 *   此后这次「本该注入却没注入」在统计里完全消失（用户只看到模型突然不知道约束了）。
 *   这里把「是否算一次渲染失败」抽成纯函数，便于单测与复用。
 * @returns {1|0}
 */
export function injectionErrorDelta(result) {
  if (result === null || typeof result !== "object") return 0;
  if (result.action !== "skip") return 0;
  return typeof result.reason === "string" && result.reason.startsWith("error:") ? 1 : 0;
}

/**
 * ★ C91：跳过原因分布（与 C90 的 renderErrors 互补）。
 *   「注入没发生」有很多原因：identical（内容没变）/ throttled-events（限流）/ no-ledger（空图）…
 *   它们都不是缺陷，但**分布**能回答「热清单注入到底在哪一步被省掉」。
 *   error: 前缀交给 renderErrors（有形）单独计数，这里不重复记。
 * @returns {string|null} 要计入分布的原因键（null = 不计）
 */
export function skipReasonKey(result) {
  if (result === null || typeof result !== "object") return null;
  if (result.action !== "skip") return null;
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (reason === "" || reason.startsWith("error:")) return null;
  return reason;
}

/**
 * ★ C219：注入动作的统计键 —— append / replace 才计（skip 已由 skipReasons 覆盖）。
 *
 * 为什么要单独记它：**append 是缓存友好的（前缀不动，只在末尾追加），replace 是改写历史中间那条**
 * —— 后者会让 DeepSeek 的 disk cache 从那条消息起**失去前缀匹配**（见 docs/knowledge/上下文缓存-deepseek.md）。
 * 没有这个数字就只能靠猜"我们到底在不在破坏缓存"。
 * @param {object} result decideInjection 的返回
 * @returns {"append"|"replace"|null}
 */
export function injectActionKey(result) {
  if (result === null || typeof result !== "object") return null;
  if (result.action === "append" || result.action === "replace") return result.action;
  return null;
}

/** 有界累加：最多记 8 个原因键，其余归 "other"（防止某个极端 reason 把统计表撑爆）。 */
export function bumpSkipReason(map, key, limit = 8) {
  if (!key) return map;
  const stats = map && typeof map === "object" ? map : {};
  if (stats[key] !== undefined || Object.keys(stats).length < limit) {
    stats[key] = (Number.isFinite(stats[key]) ? stats[key] : 0) + 1;
  } else {
    stats.other = (Number.isFinite(stats.other) ? stats.other : 0) + 1;
  }
  return stats;
}
