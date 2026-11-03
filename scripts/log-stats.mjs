/**
 * log-stats.mjs —— 会话日志的「可缓存聚合」与回放（C465）
 *
 * 由来：doctor 剩下 2.75s 全在解 24 份会话日志（C463/C464 之后的最大一块）。
 * 日志是**追加写**的，落盘之后内容不再变 —— 所以「(path, size, mtime) 相同 ⇒ 聚合结果相同」，
 * 完全可以把每份日志的聚合缓存起来，下一轮只解变了的那几份。
 *
 * 但缓存最容易变成新的谎报来源（本周已栽两次：C459 的 mtime、C460 的占比），所以这里刻意做两件事：
 *   ① 只缓存**与时间无关**的量（每次调用的缓存读数、每次 fold 的事件与时间戳），
 *      时间窗过滤（"最近 1 小时"）**在回放时做**，不进缓存；
 *   ② 键里带 `size:mtimeMs`，任何一次写入都会让键失效。
 */

/**
 * 缓存键：内容变了（大小或 mtime 变）就失效。
 * @param {{size:number, mtimeMs:number}} stat
 * @returns {string}
 */
export function logCacheKey(stat) {
  const size = Number(stat?.size);
  const mtime = Number(stat?.mtimeMs);
  if (!Number.isFinite(size) || !Number.isFinite(mtime)) return "";
  return `${size}:${Math.round(mtime)}`;
}

/**
 * 从一份日志的**单次遍历**里收集可缓存的量（与时间无关）。
 *
 * @param {Array<object>} events 已解析的事件（升序）
 * @param {{session?:string}} [options]
 * @returns {{calls:number, inputTokens:number, cacheTokens:number, ratios:number[],
 *            folds:Array<{at:number, ok:boolean, error:string|null}>, logUsage:object|null}}
 */
export function summarizeLogEvents(events, { session = "" } = {}) {
  const out = { calls: 0, inputTokens: 0, cacheTokens: 0, ratios: [], folds: [], logUsage: null };
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object") continue;
    const at = typeof e.time === "number" ? e.time : 0;
    if (e.type === "assistant/message" && e.data?.usage) {
      const u = e.data.usage;
      const input = Number(u.inputTokens);
      const cache = Number(u.cacheReadTokens);
      if (Number.isFinite(input) && Number.isFinite(cache) && input >= 0 && cache >= 0 && input + cache > 0) {
        out.calls += 1;
        out.inputTokens += input;
        out.cacheTokens += cache;
        out.ratios.push(cache / (input + cache));
      }
    }
    if (e.type === "compaction/summary" && e.data?.usage) {
      if (out.logUsage === null || at > out.logUsage.at) {
        out.logUsage = {
          at,
          inputTokens: Number(e.data.usage.inputTokens) || 0,
          outputTokens: Number(e.data.usage.outputTokens) || 0,
          provider: e.data.provider ?? null,
          model: e.data.model ?? null,
          shadowedTokens: e.data.shadowedTokenCount ?? null,
          session,
        };
      }
      continue;
    }
    if (e.type !== "compaction/end") continue;
    const err = e.data?.error ?? null;
    out.folds.push({ at, ok: err === null || err === undefined, error: err === null || err === undefined ? null : String(err) });
  }
  return out;
}

/**
 * 把多份（可能来自缓存的）聚合按顺序回放成 doctor 要的指标。
 *
 * **时间窗在这里做**（`since`），不在缓存里做 —— 缓存只存"发生过什么"，不存"最近一小时发生了什么"。
 *
 * @param {Array<ReturnType<typeof summarizeLogEvents> & {session?:string}>} parts 按选中顺序
 * @param {{since?:number, breakDrop?:number, maxErrors?:number}} [options]
 * @returns {{calls:number, inputTokens:number, cacheTokens:number, ratios:number[], breaks:number,
 *            foldOk:number, foldFail:number, foldOkAll:number, foldFailAll:number,
 *            lastOkAt:number, lastFailAt:number, errors:Array<{session:string, error:string}>,
 *            logUsage:object|null}}
 */
export function replayLogStats(parts, { since = 0, breakDrop = 0.3, maxErrors = 3 } = {}) {
  const out = {
    calls: 0,
    inputTokens: 0,
    cacheTokens: 0,
    ratios: [],
    breaks: 0,
    foldOk: 0,
    foldFail: 0,
    foldOkAll: 0,
    foldFailAll: 0,
    lastOkAt: 0,
    lastFailAt: 0,
    errors: [],
    logUsage: null,
  };
  let lastRatio = null;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part === null || typeof part !== "object") continue;
    out.calls += Number(part.calls) || 0;
    out.inputTokens += Number(part.inputTokens) || 0;
    out.cacheTokens += Number(part.cacheTokens) || 0;
    for (const ratio of Array.isArray(part.ratios) ? part.ratios : []) {
      out.ratios.push(ratio);
      // ★ 断点判据与 cache-usage.mjs 的 BREAK_DROP 保持一致：命中率骤降超过阈值算一次断点
      if (lastRatio !== null && ratio < lastRatio - breakDrop) out.breaks += 1;
      lastRatio = ratio;
    }
    const session = typeof part.session === "string" ? part.session : "";
    for (const fold of Array.isArray(part.folds) ? part.folds : []) {
      const at = Number(fold?.at) || 0;
      if (fold?.ok) {
        out.foldOkAll += 1;
        out.lastOkAt = Math.max(out.lastOkAt, at);
        continue;
      }
      out.foldFailAll += 1;
      out.lastFailAt = Math.max(out.lastFailAt, at);
      if (at >= since) {
        out.foldFail += 1;
        if (out.errors.length < maxErrors) out.errors.push({ session, error: String(fold.error ?? "") });
      }
    }
    // 窗口内的成功数：只算 at >= since 的
    for (const fold of Array.isArray(part.folds) ? part.folds : []) {
      if (fold?.ok && (Number(fold?.at) || 0) >= since) out.foldOk += 1;
    }
    const u = part.logUsage;
    if (u && typeof u === "object" && (out.logUsage === null || (Number(u.at) || 0) > out.logUsage.at)) {
      out.logUsage = u.session === undefined || u.session === "" ? { ...u, session } : u;
    }
  }
  return out;
}
