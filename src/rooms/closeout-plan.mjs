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
  const tooBig = closeoutExceedsLimit(graph, maxTokens);
  if (tooBig === null) return null;
  let debt = null;
  try {
    debt = debtOfGraph(graph);
  } catch {
    debt = null;
  }
  const chunks = planCloseoutChunks({
    fromSeq: Number(debt?.lastFoldSeq ?? 0),
    tail: tooBig.tail,
    tokensPerEvent: debt?.tokensPerEvent ?? null,
    maxTokens,
    maxChunks,
  });
  return { est: tooBig.est, tail: tooBig.tail, chunks };
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
      await fold(chunk.start, chunk.end, remaining);
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
