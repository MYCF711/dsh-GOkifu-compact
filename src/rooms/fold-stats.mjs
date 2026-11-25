/**
 * fold-stats.mjs —— 归档信号识别 + foldMark 的 usage 归一（C683 · P1 归位第五次搬迁）
 *
 * 两个纯函数，原来在 `src/engine.mjs` 的"归档判定"与"统计与日志"交界处：
 *   · `archivedIdsFromChange` —— 从宿主 durable 变更里认出"哪些会话被归档了"。
 *     过滤条件必须逐条钉住（domain/operation/table/value 三种形状），不能只靠"源码里有这几行"；
 *   · `newlyArchived` —— 两次快照取差集（只报新归档的，不重复报）。
 *   · `buildFoldMarkUsage` —— foldMark 的 usage 归一：真机 usage 里没有 model 字段，
 *     不补上就会让成本永远按默认模型估（C443）。
 *
 * 全部不碰 this / ctx / 磁盘 / 网络。**搬迁纪律**：逐字复制，逻辑零改动。
 */

/**
 * ★ C328：**归档信号只在这里解析一次**（纯函数，可单测）。
 *
 * 这条路径是本仓库最容易错的地方 —— C210 的设计（挂 `session/disposed`）在**真机上被证伪**过：
 * GUI 归档只往 `workspace.json` 写 `archivedSessionIds`，**不发那个事件**（C216）。
 * 所以过滤条件必须逐条钉住，不能只靠"源码里有这几行"。
 *
 * 认的形状：`{domain:"workspace", table:"", operation:"put", value:{archivedSessionIds:[…]}}`
 *   · `table` 可以是 `""` 或 `undefined`（都是 global 记录），其它表一律不认；
 *   · `value` 可能是对象，也可能是 JSON 字符串（durable 存储回放时见过）。
 *
 * @param {any} change
 * @param {{archivedSessionIds?: unknown[]} | null} [registry] 兜底来源（有一拍延迟，只当最后手段）
 * @returns {{ids: string[], trusted: boolean} | null} null = 不是归档信号
 */
export function archivedIdsFromChange(change, registry = null) {
  if (!change || change.domain !== "workspace") return null;
  if (change.operation !== "put") return null;
  const table = change.table;
  if (table !== "" && table !== undefined) return null;
  let value = change.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const ids = value?.archivedSessionIds;
  if (Array.isArray(ids)) return { ids: ids.map(String), trusted: true };
  const fromRegistry = registry?.archivedSessionIds;
  return Array.isArray(fromRegistry) ? { ids: fromRegistry.map(String), trusted: false } : null;
}

/**
 * ★ C328：从「上一份归档集合」到「这一份」的差分 —— 只挑**新出现**的 id。
 *
 * @param {Set<string>|Iterable<string>} previous
 * @param {Iterable<string>} current
 * @returns {string[]}
 */
export function newlyArchived(previous, current) {
  const seen = previous instanceof Set ? previous : new Set(previous ?? []);
  const out = [];
  for (const id of current ?? []) {
    const value = String(id);
    if (!seen.has(value)) out.push(value);
  }
  return out;
}

/**
 * ★ C443：foldMark 里那份 usage 的**唯一构造点**。纯函数。
 *
 * 为什么抽出来：C346/C398 修的就是"这里要写 model 与 finishReason"，
 * 但那两次都只能用**源码断言**验证（字段在不在那一行）。
 * 抽成纯函数后，可以**行为地**测：给一份没有 model 的真机 usage，看输出里有没有 model。
 *
 * @param {object|null} summaryUsage 宿主返回的 usage（可能没有 model）
 * @param {{provider?:string|null, model?:string|null, instructionTokens?:number|null}} extra
 * @returns {object|null}
 */
export function buildFoldMarkUsage(summaryUsage, { provider = null, model = null, instructionTokens = null } = {}) {
  if (summaryUsage === null || summaryUsage === undefined || typeof summaryUsage !== "object") return null;
  return {
    ...summaryUsage,
    provider: provider ?? null,
    model: model ?? null,
    instructionTokens: Number.isFinite(Number(instructionTokens)) ? Number(instructionTokens) : null,
  };
}
