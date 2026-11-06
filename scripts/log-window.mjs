/**
 * log-window.mjs —— 「该看哪几份会话日志」的纯函数（C218）
 *
 * ## 为什么要有它
 *
 * 真实事故（`docs/方案-持续优化.md` 的 C-18）：`doctor` 只看**最新 6 份**会话日志，
 * 而 01:12:14 那次真实 fold 落在**第 7 份**里 ⇒ 它报「最近压缩尝试 成功 0 / 失败 0」。
 * 仪器自己静默失效比没有仪器更糟 —— 没人会去查一个"显示一切正常"的东西。
 *
 * ## 判据
 *
 * 1. **先按时间窗**：窗口内发生过写入的日志都要看（fold 一定伴随日志写入）；
 * 2. **再兜底取最新 N 份**：窗口内一份都没有（安静期/时钟跳变）时仍然能给出答案；
 * 3. **最后按上限截断**：每份日志都要解 zstd，不能无上限（一次 doctor 不能因为你开了 200 个会话就变慢 200 倍）。
 *
 * 纯函数：不碰 fs，`files` 由调用方给（`{ file, mtime, session }`），所以可以拿假数据把三条都测到。
 */

/** 默认上限：24 份。窗口内再多也只看最近 24 份 —— 解压是有成本的。 */
export const DEFAULT_LIMIT = 24;

/** 兜底份数：窗口内一份都没有时，至少还看这么多（旧行为就是 6）。 */
export const DEFAULT_HEAD = 6;

/**
 * @param {Array<{file: string, mtime: number, session?: string}>} files 全部候选日志
 * @param {{now?: number, windowMs?: number, head?: number, limit?: number}} [options]
 * @returns {Array<{file: string, mtime: number, session?: string}>} 按 mtime 从新到旧
 */
export function selectSessionLogs(files, { now = Date.now(), windowMs, head = DEFAULT_HEAD, limit = DEFAULT_LIMIT } = {}) {
  const all = Array.isArray(files) ? files.filter((x) => x && typeof x.file === "string") : [];
  const sorted = [...all].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
  const capped = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT;
  const headN = Number.isFinite(Number(head)) && Number(head) > 0 ? Number(head) : DEFAULT_HEAD;
  const cutoff = Number.isFinite(Number(windowMs)) ? now - Number(windowMs) : Number.NEGATIVE_INFINITY;

  const picked = [];
  const seen = new Set();
  const push = (item) => {
    if (picked.length >= capped || seen.has(item.file)) return;
    seen.add(item.file);
    picked.push(item);
  };
  for (const item of sorted) {
    if ((Number(item.mtime) || 0) >= cutoff) push(item);
  }
  // 兜底：窗口内没有/不够时，最新的几份总要看到（否则安静期会显示「一个 fold 都没有」）
  for (const item of sorted.slice(0, headN)) push(item);
  return picked;
}
