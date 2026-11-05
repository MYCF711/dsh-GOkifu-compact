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
  // ★ C493：**只压了一部分不算结清**。分段离线压缩会留下 `partial: true`，
  //   这时 folded>0 也不能算完成，否则那段没压的内容会永远从欠账里消失。
  if (closeout.partial === true) return false;
  // ★ C572：**`folded: false` 是判决，不是"缺字段"**。C557 之后没折成会显式写 `folded:false`，
  //   但它落到下面的"老记录 ⇒ 结清"分支 ⇒ **一次失败的补账就把欠账从列表里抹掉**。
  if (closeout.foldAttempted === true && Number(closeout.folded) === 0) return false;
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
  // ★ C569：**「说折了」还要「真有折叠记录」**。真机（2026-11-06 全库扫描 312 个会话）：
  //   **74 个**会话的 closeout 写着 `folded > 0`，而 `foldMarks` 是 **0** —— 旧代码空转留下的假成功。
  //   若仍然按 closeout 判结清，这 74 个会话的尾巴**永远不会进欠账**，也就永远不会被补。
  //   证据与 `folded` 同口径：有 archive/backfill/archive-offline 的 mark，或有 chunkedFolded。
  const closeoutSettlesRaw = closeoutSettles(graph?.closeout);
  const foldedEvidence =
    (Array.isArray(graph?.foldMarks) ? graph.foldMarks : []).some(
      (m) =>
        m?.trigger === "archive" ||
        m?.trigger === "backfill" ||
        m?.trigger === "archive-offline" ||
        // ★ C572：`session/disposed` 收尾走的也是单段折叠，mark 的 trigger 是 "disposed"
        m?.trigger === "disposed",
    ) || Number(graph?.closeout?.chunkedFolded) > 0;
  const claimsFolded = Number(graph?.closeout?.folded) > 0;
  const closedOut = closeoutSettlesRaw && (claimsFolded ? foldedEvidence : true);
  // 有没有一条真正由收尾触发的折叠（archive / backfill）—— 只有 closeout 记录不算折过。
  // ★ C299：**分段收尾不进 foldMarks**（走 compactRegion），只留 `closeout.chunkedFolded`；
  //   不把它算进来，已经折完的会话会被当成"没折过"（与 doctor 的判断口径分裂）。
  // ★ C577（复核发现）：这里与上面的 `foldedEvidence` **必须同一口径** ——
  //   否则同一个函数对同一条 mark 给出相反判断（`disposed` 收尾折过的会话：
  //   `closedOut` 说结清、`folded` 说没折）。
  const folded =
    marks.some(
      (mark) =>
        mark?.trigger === "archive" ||
        mark?.trigger === "backfill" ||
        mark?.trigger === "archive-offline" ||
        mark?.trigger === "disposed",
    ) || Number(graph?.closeout?.chunkedFolded) > 0;
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
  // ★ C519：**离线补折留下的"洞"也要算欠账**。
  //   离线补折是"从尾巴往前压"的：压完尾巴后 `foldMarks` 前进到 maxSeq，欠账数字变 0 ——
  //   但前段（head）那段**从来没被压过**，如果不记着它，这个洞就**永久消失**了
  //   （真机 2026-11-04：8cc34e32 前段 8,000+ 事件就是这样被"折过去了"）。
  //   所以把 `closeout.offlineUncoveredHead` 当成**未结清的欠账**带出来。
  const gapEvents = Math.max(0, Number(graph?.closeout?.offlineUncoveredHead?.events ?? 0));
  // ★ C523：兼容两种历史写法（`from` 是新的，`start` 是脚本早期写的）—— 两种都要认，否则游标永远是 1
  const gapHead = graph?.closeout?.offlineUncoveredHead ?? {};
  const gapStart = Number(gapHead.from ?? gapHead.start ?? 1) || 1;
  const hasGap = gapEvents > 0;
  const estTokens = tokensPerEvent === null ? null : Math.round((tail + gapEvents) * tokensPerEvent);
  /* ★ C649：**「有洞」不等于「只看洞」**。老写法是
   *     `due = 有洞 ? 洞 ≥ 阈值 : 未结清 && 尾巴 ≥ 阈值`
   *   —— 只要有一个洞，**整条尾巴就不参与判定**了。
   *
   *   真机（2026-11-05 全库对账，`scripts/tail-gap-audit.mjs`）：
   *   **39 个会话 / 约 2.9 万事件**就这么从欠账里消失。它们的 closeout 里同时写着两件事：
   *     `offlineUncoveredHead: {events: 5}`（前段 5 个事件没压）
   *     `offlineUncoveredTail: {events: 339}`（尾巴 339 个事件没压）
   *   而 `due` 只看了前者（5 < 40 ⇒ 不欠），于是后者永远补不到。
   *   最刺眼的是 `19e24ef7` 那一类：尾巴 363 / 缺口 5 ⇒ 判"不欠"。
   *
   *   本模块自己的另外两处口径都是**相加**的（`estTokens` 的 `tail + gapEvents`、
   *   `rankDebts` 的 `tail + gapEvents`、`closeout-plan` 的 `tooBig.tail + gapEvents`）——
   *   只有 `due` 是"取代"。所以这不是另一种口径，是漏算。
   *
   *   判据改成**各自独立**：洞够大算欠，尾巴够大也算欠。两个方向都只会让 `due` **变宽**
   *   （严格放宽，不会把任何原本 due 的会话变回不欠），已有用例语义不变。 */
  const due = (hasGap && gapEvents >= minEvents) || (!closedOut && tail >= minEvents);
  return {
    maxSeq,
    lastFoldSeq,
    tail,
    tokensPerEvent,
    estTokens,
    closedOut,
    folded,
    // 有洞时**仍然欠着**，哪怕尾巴已经归零
    gapEvents: hasGap ? gapEvents : 0,
    ...(hasGap ? { gap: { from: gapStart, events: gapEvents } } : {}),
    due,
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
  // ★ C520：排序要算上**前段缺口**。C519 之后 `tail` 可能已经是 0，而 `gapEvents` 还有上万 ——
  //   只按 tail 排，这些会话会永远排在最后，永远轮不到（等于没修）。
  const weight = (x) => (Number(x?.tail) || 0) + (Number(x?.gapEvents) || 0);
  list.sort((a, b) => weight(b) - weight(a));
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
/**
 * ★ C518：把「图上写的结局」翻译成补账记录里的字段。
 *
 * 为什么需要：`closeout()` 返回的是**调用结果**，而账本在图上。两者不一致时，
 * 界面上"成功了"会掩盖真实失败（真机 c460d468 就是这样）。这里以图为准。
 *
 * @param {(sessionId: string) => object|null} readGraph
 * @param {string} sessionId
 * @param {number} budgetMs 最多等多久让异步落盘落定
 * @returns {Promise<{folded:boolean, foldNote?:string, foldError?:string, partial?:boolean, fromGraph:true}|null>}
 */
async function outcomeFromGraph(readGraph, sessionId, budgetMs) {
  const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0);
  let closeout = null;
  for (;;) {
    try {
      const g = readGraph(sessionId);
      closeout = g?.closeout ?? null;
    } catch {
      closeout = null;
    }
    if (closeout !== null && closeout !== undefined) {
      const hasVerdict =
        "folded" in closeout || "chunkedFolded" in closeout || "foldError" in closeout || "foldNote" in closeout || "partial" in closeout;
      if (hasVerdict) break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (closeout === null || closeout === undefined) return null;
  const folded = Number(closeout.folded) > 0 || Number(closeout.chunkedFolded) > 0;
  return {
    fromGraph: true,
    folded,
    ...(closeout.foldNote === undefined || closeout.foldNote === null ? {} : { foldNote: String(closeout.foldNote) }),
    ...(closeout.foldError === undefined || closeout.foldError === null ? {} : { foldError: String(closeout.foldError).slice(0, 300) }),
    ...(closeout.partial === true ? { partial: true } : {}),
    ...(closeout.foldOffline === true ? { foldOffline: true } : {}),
  };
}

export async function runBackfill({
  items = [],
  resolveAgent,
  closeout,
  /**
   * ★ C518：**读回图上的真实结局**。`closeout()` 的返回值是"调用成功"，
   * 不等于"真的折了" —— 真机（2026-11-04 c460d468）面板报 `folded:1`，图上写的是
   * `folded:0 / foldError:"start seq 496 not found in surface"`。
   * 给了这个函数就以图为准；不给就退回旧行为（调用方自己负责诚实）。
   * @type {((sessionId: string) => object|null) | undefined}
   */
  readGraph,
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
      const merged = { ...base, ok: true, ...(outcome && typeof outcome === "object" ? outcome : {}) };
      // ★ C518：以**图上的结局**为准（最多等 1.5s，让 C514 的异步落盘落定）
      if (typeof readGraph === "function") {
        const truth = await outcomeFromGraph(readGraph, sessionId, 1500);
        if (truth !== null) Object.assign(merged, truth);
      }
      push(merged);
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
