/**
 * closeout-backfill.mjs —— 归档收尾的「补账」房间（C216）
 *
 * ## 为什么会有这个房间
 *
 * 宿主的压缩契约是「**idle agent** 的 durable history」（`compactNow(agent, …)`，
 * 见 `@deepseek-ai/dsh-compaction` 的 api-catalog）。归档会话**没有 agent**：
 * 它的 durable history 是宿主自己的 `session.v4.jsonl.zstd`，插件既不能加载它，
 * 也不该去手改那份日志。所以「归档时没做收尾」的会话**只能等它重新变成 live**
 * （面板 / 命令把它 resume 起来）之后再补 —— 这就是本房间的全部职责：
 *
 *   ① 判定一笔债务（{@link debtOfGraph}）：最后一次 fold 之后还有多少事件、有没有 closeout；
 *   ② 把一批会话按债务大小排序、限量（{@link rankDebts}）；
 *   ③ 逐个**串行**补（{@link runBackfill}），一个失败不影响后面，结果逐条回报。
 *
 * ## 边界
 *
 * 它**不碰磁盘、不碰 ctx、不 import 宿主包**：读写（resume / closeout）都由调用方注入，
 * 于是单测可以拿纯数据把三条路径都跑一遍，生产里由 UI host 接 `sessionController` + 引擎。
 */

/** 与 `closeoutMinEvents` 的默认值一致（太少不值得花一次模型调用）。 */
export const DEFAULT_MIN_EVENTS = 40;

/** 一次请求最多补几个 —— 每个都是一次 resume + 一次模型调用，不能一把梭。 */
export const DEFAULT_LIMIT = 20;

/** 单个会话的硬超时（含 closeout 内部超时；这层是给「resume 卡死」兜底）。 */
export const DEFAULT_PER_ITEM_MS = 180_000;

/**
 * 判一笔债务。
 *
 * `tail` 的口径与引擎的 `closeout.eventsSinceLastFold` **同源**（最大节点 seq − 最后一次 fold 的 seqEnd），
 * 这样面板上看到的数字与 `doctor` / 图上的记录不会互相打架。
 *
 * @param {object} graph 会话棋谱（已重放 delta 的图）
 * @param {{minEvents?: number}} [options]
 * @returns {{maxSeq:number, lastFoldSeq:number|null, tail:number, closedOut:boolean, folded:boolean, due:boolean}}
 */
/**
 * ★ C476：**`closeout` 存在 ≠ 这笔账结清了。**
 *
 * 真机（2026-11-03「发布代码仓库并公开」）：归档后 `closeout` 写下了
 * `{source:"archive", foldAttempted:true, folded:0, foldNote:"nothing-to-fold"}`，
 * 于是 `due: false` —— 而那个会话有 **163 节点 / 200 条边、foldMarks 为 0、尾巴 1205 事件**。
 * 结果是：**只要尝试过一次（哪怕失败了），这笔账就永远不会再被补**。
 *
 * 判据改成"看结局"：
 *   · `folded > 0` / `chunkedFolded > 0` ⇒ 结清；
 *   · `foldNote: "nothing-to-fold:<reason>"` ⇒ 只有 reason 属于**真没内容**那一类才算结清；
 *   · 老记录（没有 reason，也没有 foldAttempted）⇒ 保持原语义（结清），不然会把历史欠账一次性翻出来；
 *   · `foldError` / `timeout` / `planner-null` / `no-target` ⇒ **未结清**，重开该会话时还能补。
 *
 * @param {object|null|undefined} closeout
 * @returns {boolean}
 */
export function closeoutSettles(closeout) {
  if (closeout === null || closeout === undefined || typeof closeout !== "object") return false;
  if (Number(closeout.folded) > 0 || Number(closeout.chunkedFolded) > 0) return true;
  if (typeof closeout.foldError === "string" && closeout.foldError !== "") return false;
  const note = String(closeout.foldNote ?? "");
  if (note.startsWith("nothing-to-fold:")) {
    // ★ C474 起才写原因；这些原因意味着"确实没东西可折"，结清
    const reason = note.slice("nothing-to-fold:".length).trim();
    return ["below-min-tokens", "empty", "nothing-to-fold"].includes(reason);
  }
  if (note === "nothing-to-fold") {
    // 老记录：只说"没东西可折"却给不出原因 ⇒ 保守当**未结清**（宁可多补一次）
    return false;
  }
  if (closeout.foldAttempted === true) return false; // 试过但结局不清
  return true; // 老 closeout（C466 之前写的）：保持原语义
}

export function debtOfGraph(graph, { minEvents = DEFAULT_MIN_EVENTS } = {}) {
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const last = marks.filter((mark) => Number.isFinite(Number(mark?.seqEnd))).at(-1);
  const lastFoldSeq = last === undefined ? null : Number(last.seqEnd);
  let maxSeq = 0;
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  const tail = lastFoldSeq === null ? maxSeq : Math.max(0, maxSeq - lastFoldSeq);
  // ★ C476：不是"有 closeout 就算结清"，而是**看结局**（见 closeoutSettles）
  const closedOut = closeoutSettles(graph?.closeout);
  // 有没有一条真正由收尾触发的折叠（archive / backfill）—— 只有 closeout 记录不算折过。
  // ★ C299：**分段收尾不进 foldMarks**（走 compactRegion），只留 `closeout.chunkedFolded`；
  //   不把它算进来，已经折完的会话会被当成"没折过"（与 doctor 的判断口径分裂）。
  const folded =
    marks.some((mark) => mark?.trigger === "archive" || mark?.trigger === "backfill") ||
    Number(graph?.closeout?.chunkedFolded) > 0;
  // ★ C286：估一下这次收尾折叠**大概要花多少输入 token**。
  //   为什么能估：每个 foldMark 都记了「折了多少事件(seqEnd-seqStart) / 遮蔽多少 token(shadowedTokens)」，
  //   用本会话自己的比值最准；没有历史 fold 时退回 0（调用方会跳过估计，不编数字）。
  //   用途：补账前告诉用户"这一次大概多少钱"。冷缓存 = 全额输入价（C284）。
  const ratios = marks
    .map((mark) => {
      const span = Number(mark?.seqEnd) - Number(mark?.seqStart);
      const shadowed = Number(mark?.shadowedTokens);
      return span > 0 && Number.isFinite(shadowed) && shadowed > 0 ? shadowed / span : null;
    })
    .filter((x) => x !== null);
  const tokensPerEvent = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const estTokens = tokensPerEvent === null ? null : Math.round(tail * tokensPerEvent);
  return {
    maxSeq,
    lastFoldSeq,
    tail,
    tokensPerEvent,
    estTokens,
    closedOut,
    folded,
    due: !closedOut && tail >= minEvents,
  };
}

/**
 * 列出「归档时没压完」的会话（`due === true` 的那些），按尾巴从大到小。
 *
 * 磁盘读写由调用方注入（`sessionIds` + `loadGraph`）：房间自己不碰 fs，
 * 单测可以拿纯数据把「有图/没图/坏图」三种情况都跑一遍；生产里 UI host 用
 * `kifu-persist` 的 store（**会重放 delta**，与引擎/doctor 同口径）喂进来。
 *
 * @param {object} options
 * @param {string[]} options.sessionIds 候选会话（通常是 sessions 目录下所有有 graph.json 的）
 * @param {(sessionId: string) => object | null} options.loadGraph 读一张**已重放 delta** 的图；抛错/返回 null = 跳过
 * @param {number} [options.minEvents]
 * @param {number} [options.limit] 最多返回几条（默认 {@link DEFAULT_LIMIT}）
 * @returns {{scanned:number, due:number, items:Array<{sessionId:string, tail:number}>}}
 */
export function listDebts({ sessionIds = [], loadGraph, minEvents = DEFAULT_MIN_EVENTS, limit = DEFAULT_LIMIT } = {}) {
  const items = [];
  let scanned = 0;
  for (const raw of sessionIds) {
    const sessionId = String(raw ?? "");
    if (sessionId === "" || typeof loadGraph !== "function") continue;
    scanned += 1;
    let graph = null;
    try {
      graph = loadGraph(sessionId);
    } catch {
      continue; // 坏图/读不出：跳过，不许让一次面板请求整页 500
    }
    if (!graph || typeof graph !== "object") continue;
    const debt = debtOfGraph(graph, { minEvents });
    if (!debt.due) continue;
    items.push({ sessionId, ...debt });
  }
  const ranked = rankDebts(items, { limit });
  return { scanned, due: items.length, items: ranked };
}

/**
 * 按债务大小排序并限量（尾巴最大的先补 —— 一次请求只能补几个时，先补最不完整的那几个）。
 * @param {Array<{sessionId:string, tail?:number}>} items
 * @param {{limit?: number}} [options]
 * @returns {Array<{sessionId:string, tail?:number}>}
 */
export function rankDebts(items, { limit = DEFAULT_LIMIT } = {}) {
  const list = Array.isArray(items) ? [...items] : [];
  list.sort((a, b) => (Number(b?.tail) || 0) - (Number(a?.tail) || 0));
  const capped = Math.max(0, Number(limit) || 0);
  return list.slice(0, capped);
}

/**
 * 逐个补做收尾：先 resume 成 live agent，再交给注入的 `closeout(agent)`。
 *
 * **串行**是刻意的：每个会话都要读一遍自己的 durable history，并发会把一次重启后的
 * 磁盘/内存峰值放大到不可控；而且模型调用本身也建议一个一个来。
 *
 * @param {object} options
 * @param {Array<{sessionId:string, tail?:number}>} options.items 已经排好序的债务清单
 * @param {(sessionId: string) => Promise<{agent?: object, session?: object, error?: unknown}>} options.resolveAgent
 *       把会话 resume 成 live agent（生产接宿主 `sessionController.agents.resolveAgent`）
 * @param {(agent: object) => Promise<object>} options.closeout 对 live agent 做一次收尾（生产接引擎 `closeoutNow`）
 * @param {boolean} [options.dryRun] 只回报「会补哪些」，不 resume、不调用模型
 * @param {(progress: object) => void} [options.onProgress] 每算完一条回调一次（面板/脚本用它打印进度）
 * @param {number} [options.perItemMs] 单个会话的硬超时
 * @returns {Promise<{total:number, done:number, folded:number, failed:number, dryRun:boolean, results:object[]}>}
 */
export async function runBackfill({
  items = [],
  resolveAgent,
  closeout,
  dryRun = false,
  onProgress = () => {},
  perItemMs = DEFAULT_PER_ITEM_MS,
} = {}) {
  const results = [];
  const push = (record) => {
    results.push(record);
    try {
      onProgress(record);
    } catch {
      /* 进度回调自己抛错不影响补账 */
    }
  };
  for (const item of items) {
    const sessionId = String(item?.sessionId ?? "");
    if (sessionId === "") continue;
    const base = { sessionId, tail: Number.isFinite(Number(item?.tail)) ? Number(item.tail) : null };
    if (dryRun) {
      push({ ...base, ok: false, skipped: "dry-run" });
      continue;
    }
    if (typeof resolveAgent !== "function" || typeof closeout !== "function") {
      push({ ...base, ok: false, error: "缺少 resolveAgent / closeout（调用方没接线）" });
      continue;
    }
    let agent = null;
    try {
      const resolved = await resolveAgent(sessionId);
      if (resolved && resolved.error !== undefined && resolved.error !== null) {
        const message = resolved.error?.message ?? resolved.error;
        push({ ...base, ok: false, error: String(message).slice(0, 200) });
        continue;
      }
      // 宿主两种返回都可能：直接给 agent，或 `{ agent }`
      agent = resolved && typeof resolved === "object" && resolved.session ? resolved : resolved?.agent ?? null;
      if (!agent || !agent.session) {
        push({ ...base, ok: false, error: "resume 没有拿到 live agent" });
        continue;
      }
    } catch (error) {
      push({ ...base, ok: false, error: String(error?.message ?? error).slice(0, 200) });
      continue;
    }
    try {
      const outcome = await withTimeout(Promise.resolve().then(() => closeout(agent)), perItemMs, sessionId);
      push({ ...base, ok: true, ...(outcome && typeof outcome === "object" ? outcome : {}) });
    } catch (error) {
      push({ ...base, ok: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  const done = results.filter((r) => r.ok === true).length;
  const folded = results.filter((r) => r.ok === true && r.folded === true).length;
  return {
    total: results.length,
    done,
    folded,
    failed: results.filter((r) => r.ok === false && r.skipped === undefined).length,
    dryRun,
    results,
  };
}

/**
 * 补账的完整一圈：**取消归档 → resume → 收尾 → 还原归档状态**。
 *
 * 为什么需要这一圈：归档会话能不能直接 resume 取决于宿主实现（`ArchivedSessionGate` 只拦
 * `agent/pre-step`，但 `sessionController.resolveAgent` 对归档会话的行为没有承诺）。
 * 既然「补完必须回到归档状态」是确定的，那就显式走一圈：先取消归档拿到 live agent，
 * 补完再原样归档回去 —— 失败也还原，绝不把用户的会话留在半途状态。
 *
 * @param {object} options
 * @param {Array<{sessionId:string, tail?:number}>} options.items
 * @param {{archivedSessionIds?: unknown[], unarchiveSession: Function, archiveSession: Function}} options.registry
 *       宿主的 workspace registry（`ctx.get("workspaceRegistry")`）
 * @param {Function} options.resolveAgent
 * @param {Function} options.closeout
 * @param {boolean} [options.dryRun]
 * @param {number} [options.perItemMs]
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<object>} 与 {@link runBackfill} 同形，另加 `restored`（成功归档回去的条数）
 */
export async function backfillArchivedSessions({ items = [], registry, resolveAgent, closeout, dryRun = false, perItemMs = DEFAULT_PER_ITEM_MS, onProgress = () => {} } = {}) {
  const archived = new Set((registry?.archivedSessionIds ?? []).map(String));
  const canCycle = Boolean(registry && typeof registry.unarchiveSession === "function" && typeof registry.archiveSession === "function");
  let restored = 0;
  const restore = async (id) => {
    if (!canCycle || !archived.has(id)) return false;
    try {
      await registry.archiveSession(id, {});
      restored += 1;
      return true;
    } catch {
      return false; // 归档不回去也不能让补账结果变成失败 —— 账已经补上了
    }
  };
  const resolveWrapped = async (id) => {
    if (!canCycle || !archived.has(id)) return resolveAgent(id);
    await registry.unarchiveSession(id);
    try {
      const resolved = await resolveAgent(id);
      const agent = resolved && typeof resolved === "object" && resolved.session ? resolved : resolved?.agent ?? null;
      if (!agent || !agent.session) throw new Error("resume 没有拿到 live agent");
      return resolved;
    } catch (error) {
      await restore(id); // 拿不到 agent：原样归档回去，别把会话留成"已取消归档"
      throw error;
    }
  };
  const closeoutWrapped = async (agent) => {
    const id = agent?.session?.id;
    try {
      return await closeout(agent);
    } finally {
      if (id !== undefined) await restore(String(id));
    }
  };
  const report = await runBackfill({ items, resolveAgent: resolveWrapped, closeout: closeoutWrapped, dryRun, perItemMs, onProgress });
  return { ...report, restored, canCycle };
}

/** 单条超时：超时按失败记，但**不**中断后面的会话。 */
function withTimeout(promise, ms, sessionId) {
  const limit = Number(ms);
  if (!Number.isFinite(limit) || limit <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`补做收尾超时（${limit}ms）：${sessionId}`)), limit);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
