/**
 * loop-guard.mjs —— 「思考死循环」的判据（C444）
 *
 * 由来（真机 2026-11-03）：DSH-GO 工作区一个会话进入了循环 ——
 * 连续多次 `bash(...)` 调用、没有新的文本产出、也没有任何进展；**手动压缩一次之后就好了**。
 *
 * 那个会话没有棋谱（我们的引擎当时没加载），所以看不到我们自己的观测；
 * 但从宿主 transcript 能清楚看到：**末尾连续 8 步都是同一个 `bash` 开头、零文本输出**。
 *
 * 判据选"连续相同动作"而不是"重复推理文本"，因为：
 *   · 推理文本每次措辞都会漂移，逐字比对抓不到；
 *   · 而**动作串**（`actionSummary(name, args)`）对同一命令是**逐字稳定**的 —— 它本来就是给热清单看的。
 *
 * 注意：判据只是**触发信号**，真正的处置（压缩一次）由引擎做，并且必须限流。
 */

/**
 * ★ C444：末尾连续相同的动作有多长。纯函数。
 * @param {Array<{action?: string, seq?: number}>} edges 按 seq 升序
 * @param {{minRepeat?: number}} [options]
 * @returns {{streak: number, action: string|null, looped: boolean}}
 */
export function loopStreak(edges, { minRepeat = 4 } = {}) {
  const list = Array.isArray(edges) ? edges.filter((e) => typeof e?.action === "string" && e.action !== "") : [];
  if (list.length === 0) return { streak: 0, action: null, looped: false };
  const last = list[list.length - 1].action;
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].action !== last) break;
    streak += 1;
  }
  return { streak, action: last, looped: streak >= Math.max(2, minRepeat) };
}

/**
 * ★ C444：现在该不该为"循环"折一次。纯函数（限流规则都放在这里，便于测）。
 *
 * 规则：
 *   · 连续相同动作 ≥ minRepeat（默认 4）；
 *   · 距离上一次"循环折叠"至少 minEventsAway 个事件（默认 120）——否则会把同一次循环反复折；
 *   · 本会话已经因为循环折过 maxTimes 次（默认 3）就停手，避免把长任务误判成循环后反复打断。
 *
 * @param {{streak: number, looped: boolean}} stat
 * @param {{seq: number, lastLoopFoldSeq?: number, loopFoldCount?: number,
 *          minEventsAway?: number, maxTimes?: number}} state
 * @returns {{fire: boolean, reason: string}}
 */
export function shouldFoldForLoop(stat, state) {
  const { looped } = stat ?? {};
  const minEventsAway = Number.isFinite(state?.minEventsAway) ? state.minEventsAway : 120;
  const maxTimes = Number.isFinite(state?.maxTimes) ? state.maxTimes : 3;
  const count = Number.isFinite(state?.loopFoldCount) ? state.loopFoldCount : 0;
  if (looped !== true) return { fire: false, reason: "no-loop" };
  if (count >= maxTimes) return { fire: false, reason: "already-folded-too-often" };
  const last = Number(state?.lastLoopFoldSeq);
  const seq = Number(state?.seq);
  if (Number.isFinite(last) && Number.isFinite(seq) && seq - last < minEventsAway) {
    return { fire: false, reason: "throttled" };
  }
  return { fire: true, reason: `loop(${stat.streak})` };
}
