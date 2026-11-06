/**
 * closeout-plan.mjs —— 归档收尾折叠的**规划**（要不要分段、怎么切）
 *
 * 为什么单独成房间（C339）：这三件事原本都写在 `src/engine.mjs` 里，而 engine 顶部
 * `import "@deepseek-ai/schemastery"` 等宿主包 —— **离线脚本 import 不了**（测试靠打桩副本绕）。
 * 于是 `scripts/backfill-plan.mjs` 想复用它就只能复制一份逻辑，那正是 C300/C302 反复清理的重复。
 *
 * 这里只放**纯函数**：不碰 ctx、不碰模型、不碰文件。engine 与脚本共用同一份。
 *
 * 依赖约束：只许依赖 `./closeout-backfill.mjs`（欠账口径）与 `./kifu-model.mjs`。
 */
import { debtOfGraph } from "./closeout-backfill.mjs";

/** 分段收尾时的**单段输入上限**（保守值；宿主窗口大时可经 `closeoutMaxFoldTokens` 调大）。 */
export const CLOSEOUT_MAX_FOLD_TOKENS = 150_000;

/**
 * 收尾尾巴要不要分段：估得出来且超过单段上限才算。
 * @param {object} graph
 * @param {number} [maxTokens]
 * @returns {{est:number, tail:number}|null}
 */
export function closeoutExceedsLimit(graph, maxTokens = CLOSEOUT_MAX_FOLD_TOKENS) {
  if (graph === null || typeof graph !== "object") return null;
  let debt;
  try {
    debt = debtOfGraph(graph);
  } catch {
    return null;
  }
  const est = Number(debt?.estTokens);
  if (!Number.isFinite(est) || est <= maxTokens) return null;
  return { est, tail: Number(debt.tail) };
}

/**
 * 把尾巴切成首尾相接的若干段，每段不超过 `maxTokens`。
 * @param {{fromSeq?:number, tail?:number, tokensPerEvent?:number|null, maxTokens?:number, maxChunks?:number}} options
 * @returns {Array<{start:number, end:number, estTokens:number}>}
 */
export function planCloseoutChunks({
  fromSeq = 0,
  tail = 0,
  tokensPerEvent = null,
  maxTokens = CLOSEOUT_MAX_FOLD_TOKENS,
  maxChunks = 6,
} = {}) {
  const start0 = Number(fromSeq);
  const total = Number(tail);
  const per = Number(tokensPerEvent);
  if (!Number.isFinite(start0) || start0 < 0) return [];
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(per) || per <= 0) return [];
  const chunkEvents = Math.max(1, Math.floor(maxTokens / per));
  const chunks = [];
  let cursor = start0;
  const end0 = start0 + total;
  while (cursor < end0 && chunks.length < Math.max(1, maxChunks)) {
    const end = Math.min(end0, cursor + chunkEvents);
    chunks.push({ start: cursor, end, estTokens: Math.round((end - cursor) * per) });
    cursor = end;
  }
  return chunks;
}

/**
 * 预检 + 切分合成一条链：给一张图，直接算出要折成哪几段。
 * @param {object} graph
 * @param {{maxTokens?:number, maxChunks?:number}} [options]
 * @returns {{est:number, tail:number, chunks:Array<{start:number,end:number,estTokens:number}>}|null}
 *          null = 不需要分段（或估不出来）
 */
export function planChunkedCloseout(graph, { maxTokens = CLOSEOUT_MAX_FOLD_TOKENS, maxChunks = 6 } = {}) {
  let debt = null;
  try {
    debt = debtOfGraph(graph);
  } catch {
    debt = null;
  }
  // ★ C520：**有前段缺口时，要压的是那个洞**（C519 之后 `tail` 可能已经是 0）。
  //   不处理的话：`closeoutExceedsLimit` 看到 tail=0 直接返回 null ⇒ 分段计划 0 段 ⇒
  //   这类会话永远补不了（真机 session-00b50089：尾巴 0 事件、缺口 1,043k tok、0 段）。
  const gap = debt?.gap ?? null;
  const gapEvents = Number(gap?.events ?? 0);
  const tooBig = closeoutExceedsLimit(graph, maxTokens);
  if (tooBig === null && gapEvents === 0) return null;
  const tailEvents = Math.max(0, Number(tooBig?.tail ?? 0)) + gapEvents;
  // 起点就用缺口的 `from`（seq 从 1 开始，别减成 0）
  // ★ C577（复核发现的 off-by-one）：没有缺口时从 `lastFoldSeq` 起，会把**已经折过的那 1 个事件**
  //   再算一次（`lastFoldSeq` 本身已被覆盖）。起点必须是它的下一个。
  const fromSeq = gapEvents > 0 ? Math.max(1, Number(gap?.from ?? 1)) : Math.max(1, Number(debt?.lastFoldSeq ?? 0) + 1);
  const chunks = planCloseoutChunks({
    fromSeq,
    tail: tailEvents,
    tokensPerEvent: debt?.tokensPerEvent ?? null,
    maxTokens,
    maxChunks,
  });
  const est = tooBig?.est ?? (debt?.tokensPerEvent === null || debt?.tokensPerEvent === undefined ? null : Math.round(gapEvents * debt.tokensPerEvent));
  return { est, tail: tailEvents, chunks, ...(gapEvents > 0 ? { gap: { from: gap?.from, events: gapEvents } } : {}) };
}

/**
 * 逐段执行（C296）：`fold` 由调用方注入 —— 这样"全部成功 / 中途抛错 / 时间用完"三种结局
 * 都能用假 fold 直接跑出来，不用造完整引擎夹具。
 *
 * @param {object} options
 * @param {Array<{start:number,end:number}>} options.chunks
 * @param {number} options.deadline 绝对时间戳（Date.now() 口径）
 * @param {(start:number, end:number, remaining:number) => Promise<unknown>} options.fold
 * @param {() => number} [options.now]
 * @returns {Promise<{folded:number, stopped:"done"|"deadline"|"error", error:unknown}>}
 */
export async function runChunkedCloseout({ chunks = [], deadline = 0, fold, now = Date.now } = {}) {
  let folded = 0;
  for (const chunk of chunks) {
    const remaining = deadline - now();
    if (remaining <= 0) return { folded, stopped: "deadline", error: null };
    try {
      // ★ C531：**"调用了"不等于"折了"**。宿主 `compactRegion` 可能安静地什么都不做
      //   （真机 1286ce28：closeout.folded=1，而 ledgerBudget 为 null、foldMarks 一条没多）。
      //   `fold` 返回 `{folded:false}` 就说明这一段是空转 ⇒ 不计入，并且停下来说明原因。
      const r = await fold(chunk.start, chunk.end, remaining);
      if (r !== null && r !== undefined && typeof r === "object" && r.folded === false) {
        return { folded, stopped: "no-op", error: null };
      }
      folded += 1;
    } catch (error) {
      return { folded, stopped: "error", error };
    }
  }
  return { folded, stopped: "done", error: null };
}

/**
 * ★ C369：分段收尾的**超时建议**。纯函数。
 *
 * 依据：真机 63 次 fold 的耗时中位 **11.7s**、p90 **19.0s**（C368）。
 * 而默认单会话收尾超时是 90s —— 6 段 × p90 = 114s **会超**。
 *
 * @param {number} chunks 段数
 * @param {number} timeoutMs 当前配置的超时
 * @param {number|null} p90Ms 真机 p90（拿不到就留 null，不瞎报）
 * @returns {{ok:boolean, worstMs:number|null, message:string}}
 */
export function closeoutTimeoutAdvice(chunks, timeoutMs, p90Ms) {
  const n = Math.max(1, Number(chunks) || 1);
  if (!Number.isFinite(p90Ms) || p90Ms <= 0) {
    return { ok: true, worstMs: null, message: "" };
  }
  const worstMs = Math.round(n * p90Ms);
  if (worstMs <= timeoutMs) return { ok: true, worstMs, message: "" };
  return {
    ok: false,
    worstMs,
    message: `分段 ${n} 段 × p90 ${(p90Ms / 1000).toFixed(1)}s = ${(worstMs / 1000).toFixed(0)}s > 超时 ${(timeoutMs / 1000).toFixed(0)}s：建议调大 closeoutTimeoutMs 或 closeoutMaxFoldTokens`,
  };
}

/**
 * ★ C370（K-23）：从 foldMark.ms 里取耗时分位数。纯函数，引擎与离线脚本共用。
 * 真机（63 次）：中位 11.7s / p90 19.0s / max 34.5s。
 * @param {number[]} values 毫秒
 * @returns {{n:number, median:number|null, p90:number|null, max:number|null}}
 */
export function foldDurationStats(values) {
  const ms = (values ?? []).map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (ms.length === 0) return { n: 0, median: null, p90: null, max: null };
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  return { n: ms.length, median: at(0.5), p90: at(0.9), max: ms[ms.length - 1] };
}

/**
 * ★ C370：从一批 foldMark 里算 p90（只看最近 `window` 条）。纯函数。
 * @param {Array<{ms?:number}>} marks
 * @param {number} [window]
 * @returns {number|null}
 */
export function recentFoldP90(marks, window = 20) {
  const list = (Array.isArray(marks) ? marks : []).slice(-Math.max(1, window));
  return foldDurationStats(list.map((m) => m?.ms)).p90;
}

/**
 * ★ C466：收尾折叠的**结局**怎么写回 `closeout`（纯函数，好测）。
 *
 * 由来（2026-11-03 真机验证单）：两次归档都记下了 `closeout`（source=archive、尾巴 7706 / 1069 事件），
 * 但 `foldMarks` 是 0、日志里只有 `compaction/start` 没有 `end`，另一次是上游 400 ——
 * **"折了没有 / 失败了没有"在图上看不出来**，只能人去翻日志。这个函数把三种结局都写清楚：
 *
 *   · 折成功（分段）⇒ `folded = 段数`，并带 `chunkedChunks`；
 *   · 可折但没折（`result == null`）⇒ `folded = 0` + `foldNote: "nothing-to-fold"`；
 *   · 抛错/超时 ⇒ `folded = 0` + `foldError`（doctor 直接显示）。
 *
 * @param {object|null} closeout 现有 closeout（可为空）
 * @param {{tier?:string, folded?:number, chunks?:number}|null} result
 * @param {unknown} [error]
 * @param {number} [at]
 * @returns {object}
 */
export function applyCloseoutOutcome(closeout, result, error = null, at = Date.now()) {
  const base = closeout !== null && typeof closeout === "object" ? closeout : {};
  const next = { ...base, foldAttempted: true, foldAt: at };
  if (error !== null && error !== undefined) {
    next.folded = 0;
    const message = error instanceof Error ? error.message : String(error);
    next.foldError = String(message).slice(0, 300);
    return next;
  }
  if (result === null || result === undefined) {
    next.folded = 0;
    next.foldNote = "nothing-to-fold";
    return next;
  }
  // ★ C474：`skipped` 说明"为什么没折"，必须写进 closeout —— 否则 folded:0 只能读成"没内容"
  if (typeof result.skipped === "string" && result.skipped !== "") {
    next.folded = 0;
    next.foldNote = `nothing-to-fold:${result.skipped}`;
    return next;
  }
  if (result.tier === "chunked") {
    const folded = Number(result.folded) || 0;
    const chunks = Number(result.chunks) || 0;
    next.folded = folded;
    next.chunkedFolded = folded;
    next.chunkedChunks = chunks;
    // ★ C479：分段没折完必须留原因（deadline / error / 其它），否则 closeout 只剩一句 folded:0
    if (typeof result.stopped === "string" && result.stopped !== "") next.chunkStopped = result.stopped;
    if (typeof result.error === "string" && result.error !== "") next.foldError = result.error.slice(0, 300);
    else if (folded < chunks) next.foldNote = `chunked-incomplete:${folded}/${chunks}`;
    return next;
  }
  // ★ C572（审核发现，严重）：**离线结果以前落到这里，被写成 `folded: 1`** ——
  //   哪怕它 `folded:0 / stopped:"no-log"`、一段都没折。这正是 74 个"假成功"的生成器。
  //   离线结果必须按它自己的字段落账，尤其"零段不许折成 1"。
  if (result.tier === "offline") {
    const folded = Number(result.folded) || 0;
    next.folded = folded;
    if (typeof result.stopped === "string" && result.stopped !== "") next.foldNote = `offline:${result.stopped}`;
    // ★ C587（审核发现）：**别把真实的缺口抹掉**。以前只要 result.partial 不是 true 就删 partial，
    //   而 `offlineFoldOutcome` 只按 head/tail 算 partial、不看"上一轮留下的缺口还剩多少"
    //   ⇒ 一份"还有 300 事件缺口"的 closeout 会被删成"已结清"，与 `debtOfGraph` 相反。
    if (result.partial === true) next.partial = true;
    else if ("partial" in next && folded > 0 && Number(next.offlineUncoveredHead?.events ?? 0) === 0) delete next.partial;
    if (typeof result.coveredStart === "number") next.offlineCovered = { start: result.coveredStart, end: result.coveredEnd };
    if (typeof result.error === "string" && result.error !== "") next.foldError = result.error.slice(0, 300);
    if (folded > 0) next.foldOffline = true;
    return next;
  }
  next.folded = 1;
  return next;
}
