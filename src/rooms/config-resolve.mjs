/**
 * config-resolve.mjs —— 配置解析与压缩规格推导（R16）
 *
 * 从 `src/engine.mjs` 搬出的**纯函数**（C687 P1 第八次归位）：
 *   · `resolveChess`      —— 宿主 config → engine 的 `this.chess`（键序 + 注入位）
 *   · `routedTarget`      —— 会话当前路由（合成会话没有 requestHeader ⇒ 容错）
 *   · `resolvePolicy`     —— chess → 策略对象（只挑压缩相关的 6 个键）
 *   · `resolveSpec`       —— 策略 + 窗口 → 阈值/保留量/最小折量（S8 首折削峰、C21 小窗口封顶）
 *   · `summarizeTarget`   —— 摘要该用哪个 provider/model（三选一）
 *
 * 为什么成房间：这五个函数**零宿主依赖**（只吃普通对象、只吐普通对象），
 *   却长期埋在 4270 行的 engine 里 —— 改一个阈值算法要在引擎里翻 100 行。
 *   搬出来后 `resolveSpec` 的边界（小窗口、首折、retain ≥ threshold）可以脱离宿主单测。
 *
 * ★ 铁律：本房间**不产生任何事实** —— 只做纯计算，不读文件、不碰 ctx、不调模型。
 *
 * 依赖：`./config-schema.mjs`（`resolveConfig` 的净化语义在 R15，这里只负责 engine 的键序与注入位）。
 */

import { resolveConfig } from "./config-schema.mjs";

/** resolveChess 的键序（与 A2-4 之前逐键同序；`onLedgerBudget` 是 engine 的注入位，不进 SCHEMA）。 */
const RESOLVE_ORDER = [
  "summaryMode", "thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "retainTokens",
  "summarizationProvider", "summarizationModel", "maxTokens", "growthFloorTokens", "minFoldTokens",
  "hotLedger", "hotLedgerMaxTokens", "hotLedgerMinEvents", "hotLedgerMinFailureDelta", "hotLedgerMarkers", "hotLedgerTraceRoot", "hotLedgerReplace",
  "onLedgerBudget", "transposition", "tier2After", "closeoutFold", "closeoutMinEvents", "closeoutTimeoutMs", "graphDir", "worldHashMaxFiles",
  // ★ AX-06（2026-11-07）：事实守卫开关（默认 false，语义在 `resolveConfig` 里净化：只有字面 true 才开）。
  //   不加进这张白名单 ⇒ 宿主传进来的 `factGuard` 会被 `resolveChess` 静默丢掉（开关永远打不开）。
  "factGuard",
  // ★ Q1 B-1（2026-11-16）：锚点召回开关。**必须**进这张白名单 —— 否则 UI 里打开了 `queryRecall`，
  //   `resolveChess` 也会把它丢掉（`this.chess.queryRecall` 恒 `undefined`），热注入永远看不到开关。
  "queryRecall",
];

/** ★ A2-4：净化语义全部在 R15（`resolveConfig`）；这里只负责 engine 的注入位与键序。 */
function resolveChess(config) {
  const c = config ?? {};
  const base = resolveConfig(c);
  const out = {};
  for (const key of RESOLVE_ORDER) {
    out[key] = key === "onLedgerBudget" ? (typeof c.onLedgerBudget === "function" ? c.onLedgerBudget : null) : base[key];
  }
  // ★ C688：`autoArchiveBackfill` 已收编进 SCHEMA（此前是唯一一个不在 SCHEMA 里的键，
  //   默认值散在 5 处）。语义不变：只有**字面 true** 才开（实验开关不靠真值转换）。
  //   默认值由 SCHEMA 说了算 —— 这里不再写字面量 `false`。
  out.autoArchiveBackfill = c.autoArchiveBackfill === true;
  return out;
}
function routedTarget(session) {
  // ★ C597（真机状态文件定位，根因在**我们自己的代码**里，不是宿主）：
  //   `TypeError: session.requestHeader is not a function` —— 自动补账 tick 传进来的 target 是
  //   `{id, cwd}` 这种**合成会话**（它没有 requestHeader 方法），这里直接调就抛，
  //   而且抛在**任何模型调用之前** ⇒ 五个会话全部 `stopped:"error"`、图上什么都不写。
  //   补账是后台 job，本来就没有"当前路由"，容错即可。
  const header = typeof session?.requestHeader === "function" ? session.requestHeader() : null;
  const config = header?.config;
  if (config === undefined || config === null || !config.provider || !config.model) return undefined;
  return { provider: config.provider, model: config.model };
}

function resolvePolicy(chess, target) {
  return {
    target,
    thresholdRatio: chess.thresholdRatio,
    firstFoldRatio: chess.firstFoldRatio,
    headroomTokens: chess.headroomTokens,
    retainRatio: chess.retainRatio,
    retainTokens: chess.retainTokens,
    minFoldTokens: chess.minFoldTokens,
  };
}

/**
 * 压力阈值与保留量（S8：首折削峰）。
 *
 * `firstFold` 为真且 `firstFoldRatio > 0` 时，阈值用 `min(窗口×firstFoldRatio, pressureBudget)`；
 * 否则用 `thresholdRatio`（0.45）。**overflow 路径不经过这里**（那边 thresholdTokens=0）。
 *
 * 边界：如果首折阈值小到 `<= retainTokens`（例如 firstFoldRatio 配得比 retainRatio 还低），
 * 退回正常阈值 —— 否则会撞上下面的 "retainTokens must be less than threshold" 抛错，
 * 一个「想省首折」的配置不该让整个压缩后端起不来。
 */
function resolveSpec(policy, contextWindow, reservedCompletionTokens, firstFold = false) {
  const messageBudget = contextWindow - (reservedCompletionTokens ?? 0);
  if (messageBudget <= 0) throw new Error(`chess-context: ${contextWindow}-token window reserves ${reservedCompletionTokens} completion tokens; no message budget`);
  // ★ 2026-11-02（C21，07 调研 + 实测）：`headroomTokens` 是**绝对值**（默认 65536），小窗口下会吃掉阈值：
  //   100K 窗口把 45% 压成 26.3%，≤73,728 窗口直接抛错（压缩完全不可用 —— 上下文只增不减，最坏的一种）。
  //   这里按 **messageBudget 的 25%** 给 headroom 封顶：大窗口行为完全不变（200K/1M 仍由 thresholdRatio 主导），
  //   小窗口回到配置的比例语义，也不再抛错。
  const HEADROOM_MAX_RATIO = 0.25;
  const headroomTokens = Math.min(Number.isFinite(Number(policy.headroomTokens)) ? Number(policy.headroomTokens) : 0, Math.floor(messageBudget * HEADROOM_MAX_RATIO));
  const pressureBudget = messageBudget - headroomTokens;
  if (pressureBudget <= 0) {
    throw new Error(
      `chess-context: ${contextWindow}-token window reserves ${reservedCompletionTokens} + ${policy.headroomTokens} headroom; no pressure budget (lower maxTokens/headroomTokens)`,
    );
  }
  const normalThreshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget));
  const useFirstFold = firstFold === true && Number(policy.firstFoldRatio) > 0;
  let thresholdTokens = useFirstFold ? Math.floor(Math.min(contextWindow * policy.firstFoldRatio, pressureBudget)) : normalThreshold;
  const retainTokens = policy.retainTokens === undefined ? Math.floor(messageBudget * policy.retainRatio) : policy.retainTokens;
  if (useFirstFold && thresholdTokens <= retainTokens) thresholdTokens = normalThreshold;
  if (retainTokens >= thresholdTokens) {
    throw new Error(`chess-context: retainTokens (${retainTokens}) must be less than threshold (${thresholdTokens})`);
  }
  // ★ S4（task-186）：minFoldTokens 默认按窗口缩放 —— `max(8000, 窗口×0.08)`。
  //   旧默认恒 8000：小窗口下「1.2 步就够 fold」的夹具会被反复触发（每步都在压）。
  //   显式配置优先：`minFoldTokens` 只要不是默认哨兵值 8000（preset 模板总写 8000 ⇒ 无法区分
  //   「没配」与「配了默认值」），就按用户给的值走。
  const DEFAULT_MIN_FOLD = 8000;
  const configuredMinFold = Number(policy.minFoldTokens);
  const scaledMinFold = Math.max(DEFAULT_MIN_FOLD, Math.floor(contextWindow * 0.08));
  const minFoldTokens = Number.isFinite(configuredMinFold) && configuredMinFold !== DEFAULT_MIN_FOLD ? configuredMinFold : scaledMinFold;
  return { thresholdTokens, retainTokens, contextWindow, minFoldTokens };
}

function summarizeTarget(chess, session, agent) {
  if (chess.summarizationProvider.length > 0 && chess.summarizationModel.length > 0) {
    return { provider: chess.summarizationProvider, model: chess.summarizationModel };
  }
  // ★ C605：同族第二处（合成会话没有 requestHeader）
  const latest = typeof session?.requestHeader === "function" ? session.requestHeader()?.config : undefined;
  if (latest && latest.provider && latest.model) return { provider: latest.provider, model: latest.model };
  if (agent?.options?.provider && agent.options.model) return { provider: agent.options.provider, model: agent.options.model };
  return undefined;
}


export { RESOLVE_ORDER, resolveChess, routedTarget, resolvePolicy, resolveSpec, summarizeTarget };
