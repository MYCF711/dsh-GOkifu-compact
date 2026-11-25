/**
 * retry-policy.mjs —— 折叠失败退避的**纯策略**（C680 · P1 归位第二次搬迁）
 *
 * 这两个函数原来在 `src/engine.mjs` 的"错误与重试"类里：
 *   · 纯函数：只吃 `kind`（和可选的 base/cap），不碰 this / ctx / 磁盘 / 网络；
 *   · 事件退避（seq 数）与时间退避（毫秒）分成两条：官方对 429 说的是"放慢节奏"，
 *     那是时间语义，只数事件会漏。
 *
 * **搬迁纪律**：主体逐字复制，逻辑零改动；engine 保留 import + export。
 */

/**
 * ★ C367：早期退避只能数**事件**，但官方对 429 说的是「放慢节奏」——那是**时间**语义。
 *  所以在事件退避之外，再加一道**最小等待毫秒数**（仅对限流/过载生效，其它类型 0 = 不影响旧行为）。
 * 官方并发限制：`deepseek-flash` 2500 / `deepseek-v4-pro` 500（账号级）。
 * @param {string} kind
 * @returns {number} 毫秒
 */
export function retryMinDelayMs(kind) {
  if (kind === "rate-limit") return 30_000;
  if (kind === "overload") return 5_000;
  return 0;
}

export function retryBackoffFor(kind, { base = 30, cap = 480 } = {}) {
  if (kind === "rate-limit") return { base, cap: cap * 2 };
  if (kind === "overload") return { base: Math.round(base * 2), cap };
  return { base, cap };
}
