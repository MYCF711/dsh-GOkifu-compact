/**
 * engine.mjs —— DSH 压缩后端的棋谱实现
 *
 * 继承关系与边界（重要）：
 *   · 继承官方 BasicCompactionEngine：surface 事务（compaction/start → summary →
 *     replace → end 的锁与稳定性校验、<compacted-summary> 框定、checkpoint source、
 *     工具对边界）全部由官方实现负责 —— 这些是会话不变量，重写等于重交一遍 bug。
 *   · 只覆盖三处策略：
 *       1) summarize()        —— 换成棋谱摘要（规则事实 + 一次模型润色）
 *       2) compactIfNeeded()  —— 换成 growth-gated 增量 fold（不重摘要旧 checkpoint）
 *       3) 新增 graph keeper  —— 每步落账 + 每轮注入失败清单
 *
 * 结果：官方的事务安全 + 本插件的增量语义与失败记忆。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";

import z from "@deepseek-ai/schemastery";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";

import { peekDirty, restoreFromSnapshot, fromJSON, toJSON, sha, hashSet, mergeNodeInto, failureEdges, foldClosureOf, foldBoundaryOf } from "./rooms/kifu-model.mjs";
import { writeBuildStamp } from "./rooms/build-stamp.mjs";
import { observeEvent } from "./rooms/keeper.mjs";
import { createWorldTracker } from "./rooms/world.mjs";
import { isCheckpointSource, normalizeRange, planFold } from "./rooms/fold-planner.mjs";
import { debtOfGraph } from "./rooms/closeout-backfill.mjs";
import { renderFacts, danglingStats, estimateTokens } from "./rooms/ledger.mjs";
import { measureFoldQuality } from "./rooms/fold-quality.mjs";
import { buildChessInstruction, extractConstraintsBlock } from "./rooms/facts-prompt.mjs";
import { SCHEMA, BASE_KEYS as BASE_KEY_LIST, resolveConfig } from "./rooms/config-schema.mjs";
import { createFsPort, createPersistStore, graphRoot, sessionPaths } from "./rooms/kifu-persist.mjs";
import { decideInjection } from "./rooms/hot-inject.mjs";
import { touchedFilesBlock } from "./rooms/touched-files.mjs";
import { annotateManualCompactError } from "./rooms/manual-compact.mjs";

const BASE_KEYS = new Set(BASE_KEY_LIST);

/** ★ P2-2（task-192）：foldMarks 只留最近这么多条（可观测用，不是审计日志）。
 *  这是一条**统一规则**：常规 fold 与 tier-2 合并共用同一个上限（旧版 tier-2 单独用
 *  `tier2After×2`，两条路径各裁各的 ⇒ 行为不可预测）。要改只改这一个常量。 */
const FOLD_MARKS_KEEP = 20;

/** ★ 2026-11-01（调研候选 #1）：两次 fold 之间少于这么多**事件**，就算「压缩无效（thrashing）」。
 *  30 个事件约等于 10–15 步（一步通常 2~3 个事件）。取值依据：太大会漏判（正常的重压间隔也就几十事件），
 *  太小会把「小步高频压缩」误判成故障。只用于记录与提示，不影响是否 fold。 */
const THRASH_SEQ = 30;
/**
 * ★ C177：fold 连续失败后的**重试退避**（按事件计，不是按时间）。
 *
 * 为什么需要：`foldFailures` 以前只用于「告诉模型别乱压」的热清单告警，**不参与任何流程控制**。
 * 于是摘要模型坏掉（或命中持续 bug）时，**每个 pressure 事件都会再试一次** —— 每次都调一次模型，
 * 每次都失败。用户看到的是「上下文没被压，账单在涨」。
 *
 * 退避规则：第 k 次连续失败后，至少要再过 `min(BASE<<(k-1), CAP)` 个事件才允许重试；
 * `context-overflow`（自救路径）**不受限** —— 那是「不压就会溢出」的硬场景，宁可再试一次。
 */
/**
 * ★ C242（K-13）：**永久性错误不值得重试**。
 * 依据 DeepSeek 官方错误码表：400/401/402 是"配置或账户"问题，重试一万次结果一样；
 * 429/500/503 才是"再等一会儿可能就好"。
 * 为什么要单独判：我们的退避是**按事件数**的（不是按时间），对永久性错误一视同仁
 * ⇒ 每 30/60/120… 个事件就白花一次尝试，日志里全是同一条错。
 * @param {unknown} message
 * @returns {boolean}
 */
/**
 * ★ C288：收尾折叠前的**纯判定** —— 这张图的尾巴是不是大到"打了必败"。
 * 抽成导出函数是为了能单测（私有方法要建实例，测试里反而测不到真行为）。
 * @param {object} graph
 * @param {number} [maxTokens]
 * @returns {{est:number, tail:number}|null} null = 没问题（或估不出来）
 */
/**
 * ★ C289（K-15 第二步）：把**过大的尾巴**切成若干段，每段都在一次性折叠上限之内。
 * 纯函数：给定起点、尾巴事件数、以及"每个事件大概多少 token"，算出要折几段、每段的绝对区间。
 * 保守策略：
 *   · 每段事件数 = floor(maxTokens / tokensPerEvent)，至少 1；
 *   · 段数上限 maxChunks（默认 6）—— 宁可这次少折点，也不许无限循环；
 *   · 每段区间**首尾相接**（下一段的 start = 上一段的 end），保证不漏事件。
 * @param {{fromSeq?:number, tail:number, tokensPerEvent:number|null, maxTokens?:number, maxChunks?:number}} options
 * @returns {Array<{start:number, end:number, estTokens:number}>}
 */
/**
 * ★ C296：把"逐段折 + 超时预算"抽成一个**可测**的函数。
 *
 * 为什么抽：C291 修好了超时，但当时只有"源码里有这几行"的断言 —— **行为没被测过**。
 * 这里把循环换成注入式（`fold(start, end)` 由调用方给），测试就能用假的 fold 驱动：
 * 全部成功 / 中途抛错 / 时间用完，三种结局各验一次。
 *
 * @param {object} options
 * @param {Array<{start:number, end:number}>} options.chunks
 * @param {number} options.deadline 绝对时间戳（Date.now() 口径）
 * @param {(start:number, end:number, remaining:number) => Promise<unknown>} options.fold
 * @param {() => number} [options.now]
 * @returns {Promise<{folded:number, stopped:"done"|"deadline"|"error", error:unknown}>}
 */
/**
 * ★ C309：从一张图直接算出「收尾要折成哪几段」—— 把 C288 的预检与 C289 的切分接成一条**可测**的纯链路。
 *
 * 为什么再包一层：`closeoutExceedsLimit` 只答"要不要分段"，`planCloseoutChunks` 只答"怎么切"，
 * 而"给这张图，到底切出什么"没有可测入口（引擎里那段是私有方法，测不到）。
 *
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
  return { folded, stopped: chunks.length === 0 ? "done" : "done", error: null };
}

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

export function isPermanentSummaryError(message) {
  const text = String(message ?? "");
  if (text === "") return false;
  return /(^|[^0-9])(400|401|402)([^0-9]|$)/.test(text)
    || /invalid format/i.test(text)
    || /authentication fails?/i.test(text)
    || /insufficient balance/i.test(text)
    || /invalid api key/i.test(text);
}

const FOLD_RETRY_BASE_SEQ = 30;
const FOLD_RETRY_CAP_SEQ = 480;

/** 热清单标记档位（ledger.mjs 的 `markers` 选项）。 */

/* ───────────────── P7：fallback 仪表盘（engine 侧） ───────────────── */

/**
 * ★ P7（task-58）：把 `renderLedger` 的预算状态变成可记录、可测试的指标对象。
 *
 * 为什么必须做：task-54/55 复核指出 —— `renderLedger` 已经返回 `fallback/overBudgetBy/budgetMax`，
 * 但 **engine/ui/doctor 一个都不读**。死开关等于没有：超预算的会话照旧静默交付。
 *
 * `fallback` 三态（ledger.mjs 的 `fallbackStatusOf`）：
 *   none / over-budget（兜底超限，已是最省）/ impossible（连文本都构造不出 ⇒ 必须 error）。
 */
/**
 * ★ C64（专员审计 P1）：`measureFoldQuality` 是**纯诊断**，但此前在 fold 主链路上没有任何保护 ——
 * 图结构一旦漂移（例如缺 `order`），它抛异常就会把「已经成功提交的 fold」变成一次失败，
 * 与同函数里 logger/hook/persistBudget 的纪律（全部 try/catch、「不许影响压缩」）不一致。
 * 这里统一降级：诊断失败 ⇒ quality = null（doctor 已有「未采集」分支），压缩照常完成。
 */
export function safeMeasureFoldQuality(args) {
  try {
    return measureFoldQuality(args);
  } catch {
    return null;
  }
}

/**
 * ★ C90：注入路径**渲染失败**的可观测性。
 *   `decideInjection` 的 catch 会返回 `{action:"skip", reason:"error:…"}` 并只写一行日志 ——
 *   此后这次「本该注入却没注入」在统计里完全消失（用户只看到模型突然不知道约束了）。
 *   这里把「是否算一次渲染失败」抽成纯函数，便于单测与复用。
 * @returns {1|0}
 */
export function injectionErrorDelta(result) {
  if (result === null || typeof result !== "object") return 0;
  if (result.action !== "skip") return 0;
  return typeof result.reason === "string" && result.reason.startsWith("error:") ? 1 : 0;
}

/**
 * ★ C91：跳过原因分布（与 C90 的 renderErrors 互补）。
 *   「注入没发生」有很多原因：identical（内容没变）/ throttled-events（限流）/ no-ledger（空图）…
 *   它们都不是缺陷，但**分布**能回答「热清单注入到底在哪一步被省掉」。
 *   error: 前缀交给 renderErrors（有形）单独计数，这里不重复记。
 * @returns {string|null} 要计入分布的原因键（null = 不计）
 */
export function skipReasonKey(result) {
  if (result === null || typeof result !== "object") return null;
  if (result.action !== "skip") return null;
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (reason === "" || reason.startsWith("error:")) return null;
  return reason;
}

/**
 * ★ C219：注入动作的统计键 —— append / replace 才计（skip 已由 skipReasons 覆盖）。
 *
 * 为什么要单独记它：**append 是缓存友好的（前缀不动，只在末尾追加），replace 是改写历史中间那条**
 * —— 后者会让 DeepSeek 的 disk cache 从那条消息起**失去前缀匹配**（见 docs/knowledge/上下文缓存-deepseek.md）。
 * 没有这个数字就只能靠猜"我们到底在不在破坏缓存"。
 * @param {object} result decideInjection 的返回
 * @returns {"append"|"replace"|null}
 */
export function injectActionKey(result) {
  if (result === null || typeof result !== "object") return null;
  if (result.action === "append" || result.action === "replace") return result.action;
  return null;
}

/** 有界累加：最多记 8 个原因键，其余归 "other"（防止某个极端 reason 把统计表撑爆）。 */
export function bumpSkipReason(map, key, limit = 8) {
  if (!key) return map;
  const stats = map && typeof map === "object" ? map : {};
  if (stats[key] !== undefined || Object.keys(stats).length < limit) {
    stats[key] = (Number.isFinite(stats[key]) ? stats[key] : 0) + 1;
  } else {
    stats.other = (Number.isFinite(stats.other) ? stats.other : 0) + 1;
  }
  return stats;
}

export function ledgerBudgetMetrics(ledger) {
  const fallback = ledger && typeof ledger.fallback === "string" ? ledger.fallback : "未采集";
  return {
    fallback,
    level: Number.isFinite(ledger?.level) ? ledger.level : null,
    tokens: Number.isFinite(ledger?.tokens) ? ledger.tokens : null,
    budgetMax: Number.isFinite(ledger?.budgetMax) ? ledger.budgetMax : null,
    overBudgetBy: Number.isFinite(ledger?.overBudgetBy) ? ledger.overBudgetBy : 0,
    // ★ 2026-11-01（调研候选 #2 / 建议 I）：出处覆盖率（边行带 (seq …) 的比例，应恒为 1）。
    //   只是**观测**：任何 <1 都说明某条降级路径在砍出处，必须能被告警发现，而不是等到模型胡猜。
    provenanceCoverage: Number.isFinite(ledger?.provenanceCoverage) ? ledger.provenanceCoverage : null,
    // ★ 2026-11-01：分项占用（七段字符数 + total）。让 doctor / ledger-budget.json 能回答
    //   「这几次渲染的钱花在哪一段」——否则 sections 又是个只算不消费的指标（第 2 轮的教训）。
    sections: ledger?.sections && typeof ledger.sections === "object" ? { ...ledger.sections } : null,
    // ★ C44：不可裁下限（root + constraints）的 token 数 —— 用来区分「渲染超预算」与「底线即超预算」。
    unyieldingTokens: Number.isFinite(ledger?.unyieldingTokens) ? ledger.unyieldingTokens : null,
    // ★ C65（专员审计 P2）：traceRecent 此前只被一个测试读取（写入即弃）。接进 doctor 统计：
    //   dropped-for-budget = 「为装进预算而退回了旧 TRACE 形态」的次数，是成本换信息的真实频率。
    traceRecent: typeof ledger?.traceRecent === "string" ? ledger.traceRecent : null,
    // ★ C67（专员审计 P2 收尾）：`renderMinimalLedger` 的 `minimal: true` 此前无任何消费者。
    //   把「零失败边时的最小清单」渲染次数接进统计 —— 它回答「有多少次注入还没走到失败清单这一步」。
    minimal: ledger?.minimal === true,
    // ★ C49：本次列了几条失败边 / 一共几条 —— 用来判断超预算时「还有没有更省的形式」。
    shownFailures: Number.isFinite(ledger?.shownFailures) ? ledger.shownFailures : null,
    failureCount: Number.isFinite(ledger?.failureCount) ? ledger.failureCount : null,
  };
}

/** 预算状态对应的日志级别：impossible 必须 error，over-budget / 出处覆盖率下降至少 warn，其余 info。 */
export function ledgerBudgetLogLevel(metrics) {
  if (!metrics || metrics.fallback === "impossible") return "error";
  if (metrics.fallback === "over-budget") return "warn";
  if (Number.isFinite(metrics.provenanceCoverage) && metrics.provenanceCoverage < 1) return "warn";
  return "info";
}

/** 一行可读的日志文案（含 overBudgetBy —— 验收明确要求）。 */
export function ledgerBudgetLogLine(metrics, sessionId = "") {
  const who = sessionId ? ` session=${sessionId}` : "";
  // 只在覆盖率掉下来时才追加这一段 —— 正常路径的日志文案与旧版逐字一致（不给日志刷屏）。
  const prov =
    Number.isFinite(metrics?.provenanceCoverage) && metrics.provenanceCoverage < 1 ? ` provenance=${metrics.provenanceCoverage}` : "";
  if (metrics.fallback === "over-budget") {
    return `chess-context: 热清单兜底超限（over-budget）${who} tokens=${metrics.tokens} budget=${metrics.budgetMax} overBudgetBy=${metrics.overBudgetBy} level=L${metrics.level}${prov}`;
  }
  if (metrics.fallback === "impossible") {
    return `chess-context: 热清单无解（impossible）${who} level=L${metrics.level} —— 连最省兜底都构造不出，这是 bug，不是预算问题${prov}`;
  }
  return `chess-context: 热清单预算正常（${metrics.fallback}）${who} tokens=${metrics.tokens}/${metrics.budgetMax}${prov}`;
}

/**
 * 把一次渲染的 metrics 累计进统计对象（纯函数，便于单测；engine 的 `consumeLedgerBudget` 调用它）。
 *
 * 为什么单独抽出来：累计规则是**持久化文件的口径**（`ledger-budget.json` 被 doctor 读），
 * 旧文件没有 `provenanceMin` 字段 ⇒ 首次累计按 1 起算（1 = 没有观察到任何下降），
 * 不能因为旧文件缺字段就报成 0（那会让 doctor 误报「出处全丢了」）。
 */
export function accumulateLedgerBudget(stats, metrics, now = Date.now(), sessionId = "") {
  const target = stats ?? {};
  target[metrics.fallback] = (target[metrics.fallback] ?? 0) + 1;
  target.samples = (target.samples ?? 0) + 1;
  if (metrics.minimal === true) {
    target.minimalRenders = (Number.isFinite(target.minimalRenders) ? target.minimalRenders : 0) + 1;
  }
  if (metrics.traceRecent === "dropped-for-budget") {
    target.traceDropped = (Number.isFinite(target.traceDropped) ? target.traceDropped : 0) + 1;
  }
  target.maxOverBudgetBy = Math.max(Number.isFinite(target.maxOverBudgetBy) ? target.maxOverBudgetBy : 0, metrics.overBudgetBy ?? 0);
  // ★ C245：**over-budget 按成因归因**：超预算到底是「约束/根目标逐字保留那段就占了大半」，
  //   还是「失败边等可压缩内容占大头」？实测（session-1e82afca，579 tok / 预算 500）：
  //   CONSTRAINTS 198 + markers 图例 43 + ROOT 19 ⇒ 不可裁部分已占 45%，失败边只有 230。
  //   这两类的处置完全不同：前者只能改预算或改约束长度，后者才有"再压一点"的空间。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.tokens) &&
    metrics.tokens > 0 &&
    Number.isFinite(metrics.unyieldingTokens)
  ) {
    const by = target.overByCause && typeof target.overByCause === "object" ? { ...target.overByCause } : {};
    const cause = metrics.unyieldingTokens / metrics.tokens >= 0.4 ? "constraints" : "content";
    by[cause] = (Number.isFinite(by[cause]) ? by[cause] : 0) + 1;
    target.overByCause = by;
  }
  // ★ C244：**over-budget 按档位归因**。此前 1005 次超预算里只有 174 次有归因（floorOver 86 + irreducible 88），
  //   剩下 831 次「不知道为什么超」—— 而档位能直接回答：落在 L5（已是最省一份）就是设计内，
  //   落在 L0–L3 就说明还有压缩空间。一个字段把 831 次从"未知"变成"已知"。
  if (metrics.fallback === "over-budget" && Number.isFinite(metrics.level)) {
    const by = target.overByLevel && typeof target.overByLevel === "object" ? { ...target.overByLevel } : {};
    const key = `L${Math.max(0, Math.min(5, Math.trunc(metrics.level)))}`;
    by[key] = (Number.isFinite(by[key]) ? by[key] : 0) + 1;
    target.overByLevel = by;
  }
  // ★ C44：over-budget 里有多少次是「约束+根目标下限」本身就超预算（不可裁 ⇒ 设计内，不是渲染 bug）。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.unyieldingTokens) &&
    Number.isFinite(metrics.budgetMax) &&
    metrics.unyieldingTokens >= metrics.budgetMax
  ) {
    target.budgetFloorOver = (Number.isFinite(target.budgetFloorOver) ? target.budgetFloorOver : 0) + 1;
  }
  // ★ C49：超预算但**已经把失败边全列出来**（shownFailures === failureCount）⇒ 再省就只能删失败边，
  //   而「每条失败边都要出现」是合同红线（L4/L5 已经只在 >20/>10 条时才截）。这类超预算是设计内，
  //   与「明明有更省形式却仍超」区分开（后者才可能是渲染 bug）。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.shownFailures) &&
    Number.isFinite(metrics.failureCount) &&
    metrics.failureCount > 0 &&
    metrics.shownFailures >= metrics.failureCount
  ) {
    target.budgetIrreducible = (Number.isFinite(target.budgetIrreducible) ? target.budgetIrreducible : 0) + 1;
  }
  // ★ C48：超预算按会话归因 —— 只有一个会话反复超时，聚合数字会误导（"系统性问题" vs "这一个会话"）。
  //   有界保留前 8 个来源，避免 ledger-budget.json 无限增长。
  if (metrics.fallback === "over-budget" && typeof sessionId === "string" && sessionId.length > 0) {
    const by = target.overBySession && typeof target.overBySession === "object" ? { ...target.overBySession } : {};
    by[sessionId] = (Number.isFinite(by[sessionId]) ? by[sessionId] : 0) + 1;
    const entries = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8);
    target.overBySession = Object.fromEntries(entries);
  }
  if (Number.isFinite(metrics.provenanceCoverage)) {
    const prev = Number.isFinite(target.provenanceMin) ? target.provenanceMin : 1;
    target.provenanceMin = Math.min(prev, metrics.provenanceCoverage);
    if (metrics.provenanceCoverage < 1) target.provenanceLow = (Number.isFinite(target.provenanceLow) ? target.provenanceLow : 0) + 1;
  }
  // ★ 2026-11-01：分项占用按**样本累加**（平均 It 才代表"钱通常花在哪"）。
  //   只留最后一次会让"某次恰好被根目标占满"被误当成常态。
  if (metrics.sections && typeof metrics.sections === "object") {
    const acc = target.sectionsAvg && typeof target.sectionsAvg === "object" ? target.sectionsAvg : {};
    const next = { ...acc };
    for (const [key, value] of Object.entries(metrics.sections)) {
      if (Number.isFinite(value)) next[key] = (Number.isFinite(next[key]) ? next[key] : 0) + value;
    }
    target.sectionsAvg = next;
  }
  target.updatedAt = now;
  return target;
}

/** 预算统计文件的相对位置（相对 graphDir）：`<graphDir>/ledger-budget.json`。 */
/**
 * ★ C288：一次性收尾折叠的**输入上限**（估计值，150k tok）。
 * 超过它就去打模型必被拒绝（上下文超长）—— 实测本机 11/11 个可估欠账都超。
 * 现在只是**预检跳过 + 留日志**；真正的解是分段折叠（K-15 第二步）。
 */
export const CLOSEOUT_MAX_FOLD_TOKENS = 150_000;

export const name = "dsh-gokifu-compact";

/**
 * ★ A2-4（2026-10-30）：Config 由 `src/rooms/config-schema.mjs` 的 SCHEMA 生成 —— 默认值只有一个来源。
 *   逐键顺序/类型/默认值/描述与原手写字面量完全一致（`test/config-schema.test.mjs` 的 golden 钉住）。
 */
function zodField(entry) {
  let field;
  if (entry.type === "boolean") field = z.boolean();
  else if (entry.type === "number") field = z.number();
  else if (entry.type === "array") field = z.array(z.any());
  else field = z.string();
  if (entry.default !== undefined) field = field.default(entry.default);
  if (entry.desc) field = field.description(entry.desc);
  return field;
}

export const Config = z.object(Object.fromEntries(SCHEMA.map((entry) => [entry.key, zodField(entry)])));

function pickBase(config) {
  const out = {};
  for (const key of Object.keys(config ?? {})) if (BASE_KEYS.has(key)) out[key] = config[key];
  return out;
}

function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && env.length > 0) return env;
  return nodePath.join(os.homedir(), ".dsh");
}

export default class ChessCompactionEngine extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];

  static Config = Config;

  constructor(ctx, config = {}) {
    super(ctx, pickBase(config));
    this.chess = resolveChess(config);
    if (ctx !== null && typeof ctx === "object") {
      try {
        ENGINE_BY_CTX.set(ctx, this);
      } catch {
        /* WeakMap 只接受对象；ctx 异常时忽略（不影响压缩） */
      }
    }

    // ★ C214（真机复现：手动 `/compact` 必炸、自动 fold 正常）：
    //   手动走 `ctx.compaction.compactNow(...)`，如果**调用方把方法摘下来再调用**
    //   （`const fn = engine.compactNow; fn(...)`）或换了 receiver，`this` 就不是引擎实例，
    //   于是 `super.compactNow(...)` 的私有品牌检查直接抛
    //   `Receiver must be an instance of class ChessCompactionEngine`。
    //   自动路径由我们自己调用，所以从不触发 —— 这正是「只有手动坏」的原因。
    //   修法：三个公开入口在构造时**绑定到本实例**，摘下来调用也仍指向真身。
    for (const name of ["compactNow", "compactRegion", "compactIfNeeded"]) {
      const fn = this[name];
      if (typeof fn === "function") this[name] = fn.bind(this);
    }

    // ★ A2-2：落盘层交给 R01（kifu-persist）。engine 只留 graphs 缓存、debounce 定时器与日志。
    this.persist = createPersistStore({
      port: createFsPort(nodeFs),
      root: graphRoot({ graphDir: this.chess.graphDir, dshHome: resolveHome() }),
      onWarn: (level, line) => this.ctx?.logger?.[level]?.(line),
    });
    // ★ C34：记下「运行实例是哪一版代码」—— doctor 用它发现「磁盘已更新、进程还是旧代码」的陷阱。
    //   写在**图根目录的父目录**（live = <home>/chess-context；测试 = 临时目录），不碰真实 home。
    //   诊断设施，失败静默（不许影响压缩主路径）。
    try {
      const root = graphRoot({ graphDir: this.chess.graphDir, dshHome: resolveHome() });
      // 只认 live 布局（<home>/chess-context）：测试/自定义 graphDir 下不写，
      // 否则会在仓库或测试目录里留下 build.json（本轮实测踩过 test/build.json）。
      if (nodePath.basename(root) === "chess-context") writeBuildStamp({ dir: root });
    } catch {
      /* ignore */
    }
    // ★ C216：preset 的 compaction group 是 isolate 的 —— 根 realm 的 UI host（src/ui.mjs）
    //   用 ctx.get("compaction") 拿不到我们。挂到进程全局（Symbol.for，两边的键名一致），
    //   面板的「补做收尾」才有引擎可调。同一个进程里 4 个 preset 各建一个实例，最后一个生效即可。
    try {
      const key = Symbol.for("dsh-gokifu.engine");
      // ★ C216：**按 agent 的 ctx 反查真身**。同一个进程里每个 preset 的 compaction group 各有一个
      //   引擎实例，而事件是按 carrier 作用域派发的 —— 拿错实例去 flush 同一张图就是两个写者。
      //   面板只拿得到 agent，所以这里给它一个「按 ctx 找引擎」的入口，而不是裸实例。
      const forCtx = (c) => {
        try {
          return ENGINE_BY_CTX.get(c) ?? null;
        } catch {
          return null;
        }
      };
      globalThis[key] = {
        latest: this,
        forCtx,
        closeoutNow: (agent, options) => (forCtx(agent?.ctx) ?? this).closeoutNow(agent, options),
      };
    } catch {
      /* 没有 globalThis（极端沙箱）：补账入口退化，不影响主路径 */
    }
    this.graphs = new Map();
    /** ★ C149：这些会话的图是「读不出/版本不符 → 重建」出来的，落盘时不做按图清理。 */
    this.repairedGraphs = new Set();
    /** ★ C216：会话对象轻引用（按 id）。归档那一下宿主的 registry 只认 id，
     *  而收尾折叠需要 session（seq / cwd / surface），所以顺手留个引用。
     *  不必担心泄漏：`session/disposed` 时会删掉，且本引擎的图/运行时本来就是按会话常驻的。 */
    this.sessionRefs = new Map();
    /** ★ C216：当前已知的归档 id 集合 —— 用**前后差分**判断「刚被归档的是谁」。
     *  构造时先取一次宿主 registry 的基线；取不到就退化成「只认本进程活着的会话」。 */
    this.archivedIds = new Set();
    /** ★ C216：这份基线是不是「真基线」（构造时读到了宿主 registry）。
     *  为假时说明我们不知道历史归档有哪些 —— 那种情况下只对「本进程确实处理过事件」的会话收尾，
     *  免得把 26 条历史归档当成「刚归档」挨个白跑一次折叠。 */
    this.archivedBaselineKnown = false;
    /** ★ C216：每个会话最近一次收尾时刻 —— 归档的两种信号（durable 写入 / 宿主销毁）撞车时只收尾一次。 */
    this.closedOutAt = new Map();
    /** ★ C216：**曾经**被归档过的会话 id（只增不减）。
     *  归档 → 取消归档 → 打开继续用 之后，`archivedIds` 里就没有它了，
     *  但「归档时那次收尾没做」这笔账还在 ⇒ 这份集合才是补账的判据（见 #backfillIfPending）。 */
    this.everArchived = new Set();
    // 基线：能读到宿主 registry 就先记住「启动时已经归档的是哪些」，免得第一次 workspace 变更
    // 把历史归档全当成「刚归档」（那会对着早已结束的会话白跑一次收尾折叠，花一次模型调用）。
    try {
      const known = this.#workspaceRegistry()?.archivedSessionIds;
      if (Array.isArray(known)) {
        this.archivedIds = new Set(known.map(String));
        this.everArchived = new Set(this.archivedIds);
        this.archivedBaselineKnown = true;
      }
    } catch {
      /* registry 还没起来：退化成「只认本进程活着的会话」 */
    }
    /** 三层文件树已写过的会话（2000 边时 4000 文件会卡事件循环，只首次与 fold 后写） */
    /** debounce 写入的定时器；缺这一行会让每次「有变化」的事件都抛 TypeError（实测：落盘 debounce 完全失效）。 */
    this.flushTimers = new Map();
    /** ★ P3：每会话基线 graph.json 的内容哈希（16 位）；delta 帧用它做 generation 保护。 */
    /** ★ P3：已进入 graph.json/delta 但还没写过 nodes/<id>.md 的节点（fold 时补写）。 */
    this.runtime = new Map();
    /** ★ TIER2-SEMANTICS（task-142）：tier-2 重入保护 —— 常规 fold 之后与 pressure 分支都会收 checkpoint，
     *  同一时刻只允许一个 tier-2 在跑（防递归 / 二次 compactRegion）。 */
    this._tier2InFlight = false;
    /** ★ P7：热清单预算统计（跨会话累计；doctor 从这里读）。 */
    this.ledgerBudget = {
      none: 0,
      "over-budget": 0,
      impossible: 0,
      未采集: 0,
      maxOverBudgetBy: 0,
      // ★ 2026-11-01：出处覆盖率下限（初值 1 = 还没有观察到任何下降）+ 掉档次数。
      provenanceMin: 1,
      provenanceLow: 0,
      updatedAt: 0,
      samples: 0,
      // ★ C219：注入动作分布（append 缓存友好 / replace 改写历史）—— 见 injectActionKey
      injectActions: {},
    };
    if (this.chess.hotLedger) this.#bindLedger();
    this.#bindKeeper();
  }

  /* ────────────────────────── P7：预算消费 ────────────────────────── */

  /**
   * 消费一次 `renderLedger` 的预算状态：累计统计 → 记日志 → 落盘指标 → 回调钩子。
   * 返回值同时给出 metrics，便于测试直接断言（不依赖日志实现）。
   */
  consumeLedgerBudget(ledger, session = null) {
    const metrics = ledgerBudgetMetrics(ledger);
    // ★ 2026-11-01：累计规则抽到 `accumulateLedgerBudget()`（纯函数），这里只负责日志/钩子/落盘。
    accumulateLedgerBudget(this.ledgerBudget, metrics, Date.now(), session?.id ?? "");
    const level = ledgerBudgetLogLevel(metrics);
    const line = ledgerBudgetLogLine(metrics, session?.id ?? "");
    try {
      this.ctx?.logger?.[level]?.(line);
    } catch {
      /* 日志实现坏掉不许影响压缩 */
    }
    try {
      this.chess?.onLedgerBudget?.(metrics, session);
    } catch {
      /* 用户钩子异常不许影响压缩 */
    }
    this.#persistLedgerBudget();
    return metrics;
  }

  /** 供 doctor / 上层查询的浅拷贝。 */
  getLedgerBudgetStats() {
    return { ...this.ledgerBudget };
  }

  #persistLedgerBudget() {
    // ★ A2-2：原子写与失败收敛都在 R01（`persistBudget` 返回 {ok,error}，不抛）。
    this.persist.persistBudget(this.ledgerBudget);
  }

  /**
   * ★ C197：把「当前 token 压力 vs 触发阈值」记进 `ledger-budget.json`。
   *
   * 为什么需要：C196 发现「本会话距上次 fold 已 +13k 事件却没有新 foldMark」，
   * 但 doctor 看不到**当前 token 数**，无法判断是「还没到阈值」还是「fold 根本没被调用」。
   * 记下 `tokens / threshold / 距阈值还差多少`，这个疑问下次就有数字可查。
   *
   * 节流：同一会话 60 秒内或 token 变化 < 2% 时不重写（避免每步都落盘）。
   */
  #recordPressure(session, tokens, threshold, trigger) {
    try {
      const now = Date.now();
      const prev = this.ledgerBudget.pressure && typeof this.ledgerBudget.pressure === "object" ? this.ledgerBudget.pressure : null;
      const sameSession = prev !== null && prev.session === session.id;
      const recent = sameSession && now - (Number(prev.at) || 0) < 60_000;
      const barelyMoved = sameSession && Number.isFinite(prev.tokens) && Math.abs(tokens - prev.tokens) < Math.max(1000, prev.tokens * 0.02);
      if (prev !== null && (recent || barelyMoved)) return;
      this.ledgerBudget.pressure = {
        session: session.id,
        tokens: Math.round(tokens),
        threshold: Math.round(threshold),
        remaining: Math.max(0, Math.round(threshold - tokens)),
        trigger,
        at: now,
      };
      this.#persistLedgerBudget();
    } catch {
      /* 观测失败不许影响压缩 */
    }
  }
  /* ────────────────────────── 棋谱状态 ────────────────────────── */

  /** 会话的棋谱目录（三层树就长在这里：index.md + nodes/<id>.md + graph.json）。 */
  #sessionDir(session) {
    return sessionPaths(this.persist.root, session.id).dir;
  }

  #graphPath(session) {
    return sessionPaths(this.persist.root, session.id).graphFile;
  }
  #graph(session) {
    const key = session.id;
    let g = this.graphs.get(key);
    if (g !== undefined) return g;
    // ★ A2-2 行为变更①：读不出/版本不符不再静默建空图 —— R01 返回 repaired + 原因，这里打一行 warn。
    const loaded = this.persist.load({ id: key, cwd: session.cwd });
    if (loaded.repaired) {
      this.repairedGraphs.add(key);
      this.ctx.logger?.warn?.(`chess-context: 棋谱读不出或版本不符，已新建空图（${loaded.repairedReason}）：${this.#graphPath(session)}`);
    }
    g = loaded.graph;
    this.graphs.set(key, g);
    return g;
  }
  #runtimeFor(session) {
    const key = session.id;
    let st = this.runtime.get(key);
    if (st !== undefined) return st;
    st = {
      pendingEdges: new Map(), // callId -> edgeId
      lastNodeId: null,
      lastUserNodeId: null,
      constraintDirty: true,
      touched: [],
      world: createWorldTracker({ cwd: session.cwd ?? process.cwd(), maxFiles: this.chess.worldHashMaxFiles }),
      lastLedgerDigest: "",
      events: 0,
      legacyElided: false,
      // ★ 2026-10-29：压缩连续失败计数（热清单告警用）。成功一次清零。
      foldFailures: 0,
      lastFoldFailureSeq: 0,
      tier2Failures: 0,
      lastTier2FailureSeq: 0,
      lastFoldError: "",
      // ★ C242：上一次折叠是不是「永久性错误」（401/402/400…）—— 是的话下一次直接用规则摘要，别再花模型调用
      forceRulesNext: false,
    };
    const g = this.#graph(session);
    // 从磁盘恢复触碰集合与最后节点
    const lastAgent = [...g.order].reverse().map((id) => g.nodes[id]).find((n) => n?.kind === "agent");
    if (lastAgent) st.lastNodeId = lastAgent.id;
    for (const edge of Object.values(g.edges)) {
      for (const p of edgeTouchedPaths(edge)) st.touched.push(p);
    }
    st.world.restore(st.touched);
    // 把世界状态的读写能力注入 state（防御式：世界状态可能尚未构造）
    // ★ P0 修复（2026-10-28，实机 187 次 compression 失败）：world.hash() 返回
    //   { hash, mode, files } 对象，节点字段只允许字符串。旧版直接返回对象 ⇒
    //   graph.json 里 206/267 节点的 worldHash 是对象 ⇒ ledger 的 `.slice()` 抛
    //   "latest?.worldHash?.slice is not a function" ⇒ 压缩 100% 失败。
    st.worldHashOf = () => {
      if (!st.world || typeof st.world.hash !== "function") return "pending";
      const w = st.world.hash();
      if (typeof w === "string") return w;
      return typeof w?.hash === "string" ? w.hash : "pending";
    };
    // ★ P0 修复：st.constraints 从未被赋值 ⇒ constraintHash 恒为 "pending" ⇒
    //   stateIndex 永不建立、置换检测形同虚设。约束哈希直接由用户节点约束文本算。
    st.constraintHashOf = () => hashSet(collectConstraintText(g));
    st.touchPath = (p) => { if (st.world && typeof st.world.touch === "function") st.world.touch(p); };
    this.runtime.set(key, st);
    return st;
  }

  #flush(session, { tree = false, full = false } = {}) {
    const g = this.#graph(session);
    // ★ A2-2 行为变更②：写序/字节全在 R01；失败返回 {ok:false} 且 **dirty 不清**，这里打一行 warn。
    // ★ C149：把「本会话的图是刚重建出来的」告诉落盘方 —— 那种图上做「按图清理」会删掉旧图的真实文档。
    const result = this.persist.flush({ id: session.id, cwd: session.cwd }, g, { tree, full, repaired: this.repairedGraphs.has(session.id) });
    if (!result.ok) {
      this.ctx.logger?.warn?.(`chess-context: 棋谱落盘失败（不影响压缩）：${result.error}`);
    }
  }
  /**
   * 落盘（debounce）。以前是「每 25 个事件才写一次」，实测会导致：
   * 重启/崩溃时丢最后一个窗口的落账；外部观察（人看 graph.md）永远滞后。
   * 改成「有变化就排一次 1.2s 后的写」，同一会话的多次变化合并。
   */
  #scheduleFlush(session) {
    const key = session.id;
    if (this.flushTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      this.#flush(session);
    }, 1200);
    timer.unref?.();
    this.flushTimers.set(key, timer);
  }

  /* ────────────────────────── 每步落账 ────────────────────────── */

  #bindKeeper() {
    const { ctx } = this;
    ctx.on("session/event", (session, event) => {
      try {
        this.sessionRefs.set(session.id, session);
        const g = this.#graph(session);
        const st = this.#runtimeFor(session);
        st.events += 1;
        const result = observeEvent(g, event, st);
        if (!result.changed) return;
        this.#scheduleFlush(session);
      } catch (error) {
        ctx.logger?.warn?.(`chess-context: 事件落账失败：${String(error)}`);
      }
    });
    ctx.on("agent/status", ({ agent, status }) => {
      try {
        if (agent?.session?.id) this.sessionRefs.set(agent.session.id, agent.session);
      } catch {
        /* 引用只是便利，记不下不影响主路径 */
      }
      if (status === "idle") {
        try {
          // 回合边界 = 提交点：落一份完整的 graph.json（外部读者/doctor/verify 直接读它）
          this.#flush(agent.session, { full: true });
        } catch {
          /* 落盘失败不阻塞 */
        }
        // ★ C216：补账 —— 「归档时没做收尾」的会话一旦重新变成 live，就在第一个空闲点把那次收尾补上。
        try {
          this.#backfillIfPending(agent.session);
        } catch (error) {
          ctx.logger?.warn?.(`chess-context: 补做归档收尾失败（不影响会话）：${String(error)}`);
        }
      }
    });

    // ★ C210：择机收尾 —— 用户在**最后一个折点之后**继续聊，然后「做完就归档」，
    //   那一段只存在于图里、没有任何摘要 ⇒ kifu 不完整（有节点、没压缩产物）。
    //   收尾做三件事（全部 best-effort，绝不阻塞、绝不抛）：
    //     ① 立刻 `full` 落盘（节点/index/标量一次性写全，避免归档时文件还欠着）；
    //     ② 在图上记 `closeout`：归档时刻 + 距上次 fold 的事件数（doctor 据此报「归档时还有尾巴」）；
    //     ③ 若配置允许（`closeoutFold`，默认开）且尾巴够长，**异步**跑一次 `trigger: "archive"` 的折叠。
    //
    // ★ C216（2026-11-02 真机证伪 C210 的前提）：**GUI 归档不 emit `session/disposed`**。
    //   宿主侧证据（app.asar 随包代码）：
    //     · `workspaceRegistry.archiveSession()` 只在 durable state 的 `archivedSessionIds`
    //       里追加 id（`dsh-workspace/lib/index.js`），会话仍是 live 的；
    //     · `session/disposed` 只在 `detachEntered()` 里 emit（`dsh-session/lib/index.js`），
    //       即会话真的被移出 live store（删除 / 宿主退出）时才发；
    //     · 归档实现的是「闸门」而非「销毁」——`ArchivedSessionGate` 只拒 `agent/pre-step`。
    //   真机 1.17.5 实测：15:24 归档后 `closeout` 仍为 null，`graph.json` 连一次 full 落盘都没有。
    //   所以真正的归档信号是 workspace 域的 durable 写入：`domain/changed`（公开 emit 事件，
    //   见 dsh-tool-cordis 的 api-catalog：`{domain, table, key, operation, value}`）。
    //   两个入口共用同一段收尾，且按 id 去重（同一个会话只收尾一次）。
    ctx.on("session/disposed", (session) => {
      this.#closeout(session, "disposed");
      try {
        this.sessionRefs.delete(session?.id);
      } catch {
        /* 引用只是便利 */
      }
    });
    ctx.on("domain/changed", (change) => {
      try {
        this.#onWorkspaceChange(change);
      } catch (error) {
        ctx.logger?.warn?.(`chess-context: 归档信号处理失败（不影响宿主）：${String(error)}`);
      }
    });
  }

  /* ────────────────────────── 归档收尾（C210 / C216） ────────────────────────── */

  /**
   * 宿主 workspace registry：cordis 服务，可能还没起来/测试里没有，一律防御式取。
   * @returns {{archivedSessionIds?: unknown[]} | null}
   */
  #workspaceRegistry() {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      if (typeof ctx.get === "function") {
        const viaGet = ctx.get("workspaceRegistry");
        if (viaGet && typeof viaGet === "object") return viaGet;
      }
      const direct = ctx.workspaceRegistry;
      if (direct && typeof direct === "object") return direct;
    } catch {
      /* 服务未注入：走 change.value 兜底 */
    }
    return null;
  }

  /**
   * 从归档 id 反查会话对象：先问宿主 store（归档会话仍 live），再退到我们自己的轻引用。
   * @param {string} id
   * @returns {object | null}
   */
  #sessionRef(id) {
    if (typeof id !== "string" || id.length === 0) return null;
    try {
      const live = this.ctx?.sessions?.get?.(id);
      if (live) return live;
    } catch {
      /* store 接口不一定是 get()；继续用本地引用 */
    }
    return this.sessionRefs.get(id) ?? null;
  }

  /**
   * 从 `domain/changed` 里取出「当前归档集合」。
   * ★ 顺序是硬坑：`change.value` **必须**优先，`registry` 只能当兜底 ——
   *   `global.set()` 里 `emitChanged(...)` 是在 `registry.state = state` **之前**同步发出的
   *   （`dsh-storage-domain`：`await unit.setGlobal(value)` → `globalValue = value` → `emitChanged`；
   *    `dsh-workspace`：`await this.global.set(state); this.state = state;`），
   *   所以回调里回读 `registry.archivedSessionIds` 拿到的是**写入前的旧值**，
   *   差分永远是空 ⇒ 收尾永远不触发。宿主自己的 `WorkspaceFeed` 也只用 `change.value`，从不回读。
   * 载荷：workspace 的 global 记录 table 为 `""`，value 就是 `workspaceDomainState`
   * （含 `archivedSessionIds`，见 dsh-workspace/lib/types/spec.js）。
   * @param {object} change
   * @returns {{ids: string[], trusted: boolean} | null} null = 这条变更与归档无关 / 读不出来
   */
  #archivedIdsFrom(change) {
    if (!change || change.domain !== "workspace") return null;
    if (change.operation !== "put") return null;
    const table = change.table;
    if (table !== "" && table !== undefined) return null; // 只认 global 记录
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
    // 兜底（老宿主/形状异常）：回读 registry。它有一拍延迟，只能当最后手段。
    const fromRegistry = this.#workspaceRegistry()?.archivedSessionIds;
    return Array.isArray(fromRegistry) ? { ids: fromRegistry.map(String), trusted: false } : null;
  }

  /**
   * workspace 域任意写入 ⇒ 与上一次已知集合差分，挑出**刚被归档**的会话。
   * 归档写的就是这个 global 记录，所以归档/取消归档都会走到这里。
   * @param {object} change
   */
  #onWorkspaceChange(change) {
    const parsed = this.#archivedIdsFrom(change);
    if (parsed === null) return;
    const current = parsed.ids;
    const baselineKnown = this.archivedBaselineKnown;
    const previous = this.archivedIds;
    this.archivedIds = new Set(current);
    for (const id of current) this.everArchived.add(id);
    // 这一条载荷就是写入后的权威快照 ⇒ 从下一条起，差分是准的。
    if (parsed.trusted) this.archivedBaselineKnown = true;
    for (const id of current) {
      if (previous.has(id)) continue;
      // 只对**本进程真的处理过事件**的会话收尾；基线可信时才放纵到宿主 store 里的 live 会话。
      // 历史归档（启动前就归档了）既没有事件流也没有会话对象，硬做只会白花一次模型调用。
      const session = this.sessionRefs.get(id) ?? (baselineKnown ? this.#sessionRef(id) : null);
      if (!session) continue;
      this.#closeout(session, "archive");
    }
  }

  /** 把「agent 或 session」统一成 compactIfNeeded 能吃的形状（测试桩接收 {session}）。 */
  #asAgent(target) {
    if (target === null || typeof target !== "object") return null;
    if (target.session !== null && typeof target.session === "object") return target;
    return { session: target, options: {} };
  }

  /**
   * ★ C216：补账入口（给面板 / 维护脚本用）—— 对一个**已经 live** 的会话立刻做一次收尾，
   * 并等折叠真的出结果。与 #closeout 的差别只有一点：那条路在事件回调里、不能阻塞宿主；
   * 这条路有人在等响应，所以折叠要 await（内部仍有 closeoutTimeoutMs 的硬超时）。
   * @param {object} target 宿主 Agent（或测试里的 { session } / session 本身）
   * @param {{source?: string}} options 归因标签，写进 closeout.source 与 foldMark.trigger
   * @returns {Promise<{ok:boolean, sessionId?:string, eventsSinceLastFold?:number, folded?:boolean, foldError?:string|null, error?:string}>}
   */
  async closeoutNow(target, { source = "backfill" } = {}) {
    const ownerNow = ENGINE_BY_CTX.get(this?.ctx);
    if (ownerNow !== undefined && ownerNow !== this) return ownerNow.closeoutNow(target, { source });
    const agent = this.#asAgent(target);
    const session = agent?.session;
    if (!session || typeof session.id !== "string") return { ok: false, error: "no session" };
    try {
      this.#flush(session, { full: true });
    } catch {
      /* 落盘失败不阻塞收尾 */
    }
    const g = this.#graph(session);
    const last = (g.foldMarks ?? []).at(-1);
    const lastSeq = Number(last?.seqEnd);
    const endSeq = Number(session.seq);
    const eventsSinceLastFold = Number.isFinite(lastSeq) ? Math.max(0, endSeq - lastSeq) : endSeq;
    let folded = false;
    let foldError = null;
    if (this.chess.closeoutFold !== false && eventsSinceLastFold >= (this.chess.closeoutMinEvents ?? 40)) {
      try {
        const result = await this.#closeoutFold(agent, source);
        folded = result !== null && result !== undefined;
      } catch (error) {
        foldError = String(error?.message ?? error).slice(0, 200);
      }
    }
    g.closeout = { at: Date.now(), eventsSinceLastFold, folds: (g.foldMarks ?? []).length, source, folded };
    this.closedOutAt.set(session.id, { at: Date.now(), source });
    try {
      this.#flush(session, { full: true });
    } catch {
      /* 同上 */
    }
    return { ok: true, sessionId: session.id, eventsSinceLastFold, folded, foldError };
  }

  /**
   * ★ C216：补账 —— 「归档时没做收尾」的会话重新变成 live 时补做一次。
   *
   * 为什么只能这样补：宿主的压缩契约是「**idle agent** 的durable history」
   * （`compactNow(agent, …)`，见 `@deepseek-ai/dsh-compaction` 的 api-catalog），
   * 归档会话没有 agent、其 durable history 是 `session.v4.jsonl.zstd` —— 插件既不能加载它，
   * 也不该去手改宿主的 zstd 日志。所以「已归档会话的尾巴」离线补不了，只能在它**又被打开**时补。
   * 判据是 `everArchived`（只增不减）：归档 → 取消归档 → 继续用，仍然欠着这笔账。
   * @param {object} session
   */
  #backfillIfPending(session) {
    const id = session?.id;
    if (typeof id !== "string" || id.length === 0) return;
    if (!this.everArchived.has(id)) return; // 从没归档过：走正常 pressure 路径，别多事
    if (this.chess.closeoutFold === false) return; // 用户关了收尾折叠：这笔账留着，不假装补过
    const g = this.graphs.get(id);
    if (g === undefined) return; // 没处理过它的事件：不凭空建图
    if (g.closeout !== undefined) return; // 已经收过尾（或刚补过）
    const last = (g.foldMarks ?? []).at(-1);
    const lastSeq = Number(last?.seqEnd);
    const endSeq = Number(session.seq);
    const tail = Number.isFinite(lastSeq) ? Math.max(0, endSeq - lastSeq) : endSeq;
    if (!(tail >= (this.chess.closeoutMinEvents ?? 40))) return;
    this.ctx.logger?.info?.(`chess-context: 补做归档收尾（${id}，尾巴 ${tail} 事件）`);
    this.#closeout(session, "backfill");
  }

  /**
   * 收尾一次：落盘 → 记 `closeout` → 够长就异步折叠。
   * @param {object} session
   * @param {"archive" | "disposed" | "backfill"} source 哪个信号触发的（写进 closeout 便于事后归因）
   */
  #closeout(session, source = "disposed") {
    if (!session || typeof session.id !== "string") return;
    // ★ C216：同一次归档可能引来两个信号（workspace 域的 durable 写入 + 宿主顺手销毁了该会话），
    //   两者都能到 ⇒ 只让**先到的那个**做收尾，另一个在 10s 窗口内直接放行掉。
    //   注意只压「不同来源」的撞车：同一个来源再报一次（取消归档后再归档）仍然照做。
    const now = Date.now();
    const prev = this.closedOutAt.get(session.id);
    if (prev && prev.source !== source && now - prev.at < 10_000) return;
    this.closedOutAt.set(session.id, { at: now, source });
    try {
      this.#flush(session, { full: true });
    } catch {
      /* 落盘失败不阻塞归档 */
    }
    try {
      const g = this.#graph(session);
      const last = (g.foldMarks ?? []).at(-1);
      const lastSeq = Number(last?.seqEnd);
      const endSeq = Number(session.seq);
      const eventsSinceLastFold = Number.isFinite(lastSeq) ? Math.max(0, endSeq - lastSeq) : endSeq;
      g.closeout = { at: Date.now(), eventsSinceLastFold, folds: (g.foldMarks ?? []).length, source };
      this.#flush(session, { full: true });
      if (this.chess.closeoutFold !== false && eventsSinceLastFold >= (this.chess.closeoutMinEvents ?? 40)) {
        // ★ C298：分段收尾**不进 foldMarks**（走 compactRegion ⇒ 只记 ledger-budget.externalFolds），
        //   所以收尾账里 `folds` 永远停在折之前。这里等它跑完把"分段折了几段"补记到 closeout 上，
        //   否则 doctor/审计只会看到"记了 closeout 但没折过"，把已经折完的会话误报成欠账。
        const sessionId = session.id;
        void this.#closeoutFold(session, source).then((result) => {
          if (result === null || result === undefined || result.tier !== "chunked") return;
          if (!(Number(result.folded) > 0)) return;
          try {
            const live = this.graphs.get(sessionId);
            if (live === undefined || live === null) return;
            live.closeout = {
              ...(live.closeout ?? {}),
              chunkedFolded: Number(result.folded),
              chunkedChunks: Number(result.chunks),
              chunkedAt: Date.now(),
            };
            this.#flush(session, { full: true });
          } catch {
            /* 记账失败不影响归档 */
          }
        });
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`chess-context: 归档收尾记账失败（不影响归档）：${String(error)}`);
    }
  }

  /* ────────────────────────── 热上下文注入 ────────────────────────── */

  #bindLedger() {
    const { ctx } = this;
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision.kind !== "enter") return decision;
      try {
        const session = payload.agent.session;
        const st = this.#runtimeFor(session);
        // ★ A2-3：注入策略全在 R08（hot-inject）。engine 只负责端口注入与预算消费。
        const result = decideInjection({
          session,
          graph: this.#graph(session),
          state: st,
          config: this.chess,
          sessionDir: this.#sessionDir(session),
          decision,
          payloadMessages: payload.messages,
          createUserMessage,
          onBudget: (ledger, s) => this.consumeLedgerBudget(ledger, s),
          onLog: (level, line) => ctx.logger?.[level]?.(line),
        });
        // ★ C90：渲染/注入抛错时 decideInjection 只写日志 —— 这里记进统计，doctor 才看得见
        if (injectionErrorDelta(result) === 1) {
          this.ledgerBudget.renderErrors = (Number.isFinite(this.ledgerBudget.renderErrors) ? this.ledgerBudget.renderErrors : 0) + 1;
          this.#persistLedgerBudget();
        }
        // ★ C91：跳过原因分布（identical / throttled-events / no-ledger …），每 20 次落一次盘即可
        // ★ C219：注入动作分布（append / replace）—— 缓存友好性的**唯一**可观测信号
        const actionKey = injectActionKey(result);
        if (actionKey !== null) {
          const actions = this.ledgerBudget.injectActions && typeof this.ledgerBudget.injectActions === "object" ? this.ledgerBudget.injectActions : {};
          actions[actionKey] = (Number.isFinite(actions[actionKey]) ? actions[actionKey] : 0) + 1;
          this.ledgerBudget.injectActions = actions;
          this.ledgerBudget.updatedAt = Date.now();
          const totalActions = Object.values(actions).reduce((sum, n) => sum + (Number(n) || 0), 0);
          if (totalActions % 20 === 0) this.#persistLedgerBudget();
        }
        const skipKey = skipReasonKey(result);
        if (skipKey !== null) {
          this.ledgerBudget.skipReasons = bumpSkipReason(this.ledgerBudget.skipReasons, skipKey);
          const total = Object.values(this.ledgerBudget.skipReasons).reduce((sum, n) => sum + n, 0);
          if (total % 20 === 0) this.#persistLedgerBudget();
        }
        return result.decision;
      } catch (error) {
        // 双保险：R08 已全部吞错；这里再兜一层，注入失败绝不阻塞对话。
        ctx.logger?.warn?.(`chess-context: 失败清单注入失败（继续本轮）：${String(error)}`);
        return decision;
      }
    });
  }
  /* ────────────────────────── 摘要（唯一官方钩子） ────────────────────────── */

  /**
   * ★ S3（task-186）：把「本次 fold 的摘要来源」写进图（auto 与 manual 都经过 summarize）。
   *   `lastFoldMode` = "rules" | "hybrid" | "llm"；`lastFoldDegraded` 是同一个事实的布尔别名
   *   （热清单/诊断读哪个都行）。写失败绝不影响摘要本身。
   */
  #markFoldMode(g, mode) {
    try {
      if (g === null || typeof g !== "object") return;
      this._lastSummaryMode = mode;
      g.lastFoldMode = mode;
      g.lastFoldDegraded = mode === "rules";
    } catch {
      /* 图不可写时不打断摘要 */
    }
  }

  async summarize(input, agent, signal) {
    const session = agent.session;
    const g = this.#graph(session);
    // ★ C242：上一次是永久性错误 ⇒ 这一次不再花模型调用，直接规则摘要（消费后立即清标记）。
    const forcedRules = this.#runtimeFor(session)?.forceRulesNext === true;
    if (forcedRules) this.#runtimeFor(session).forceRulesNext = false;
    const mode = forcedRules ? "rules" : this.chess.summaryMode;

    // ★ 2026-10-29 真实 DSH 进程抓到（headless 实测）：规则摘要的返回值**必须**带 provider/model 字符串。
    //   官方 commitCompactionBody 把 summarize() 的 provider/model **不判空**地写进
    //   `compaction/summary` 事件；我们只返回 {summary, rawOutput, llmStreamCall} ⇒ 事件里出现
    //   `provider: undefined` ⇒ 真实 Session.append 抛
    //   `session event "compaction/summary" carries non-JSON-serializable data` ⇒ 每一次 fold 都失败。
    //   假 Session（单测 / real-fold）不校验 JSON 序列化，所以之前一直没暴露 —— **summaryMode: rules 在
    //   真实 DSH 里从未成功过**。规则摘要没有模型，就用当前路由做「记账口径」，没有路由则用哨兵值。
    const routed = routedTarget(session);
    const ruleResult = () => {
      const text = ruleSummary(g, this.#activeRange());
      // ★ 2026-11-01（C7）：**规则摘要也要记保真度**。以前只有模型路径设置 `_lastSummaryText`，
      //   于是 `summaryMode: rules` / hybrid 全挂后的降级 fold，`foldMark.quality` 永远是 null，
      //   doctor 只能写「未采集」—— 而「降级路径有没有丢约束/失败边」恰恰是最该被机器证明的。
      //   规则摘要是机械生成的（约束逐条、失败边逐条、带 evidence seq），recall 应恒为 1。
      this._lastSummaryChars = text.length;
      this._lastSummaryText = text;
      // 规则摘要是机械生成的，没有「模型自己的输出」这一层 ⇒ 显式清空，别让上一次的值串味。
      this._lastSummaryModelText = undefined;
      // ★ C143（审查 P1-5）：**route / usage 也必须清**。消费点无条件读取
      //   `_lastSummaryProvider/_Model/_Usage` ⇒ hybrid 降级后 `lastFoldUsage` 会记成
      //   「上一次模型调用的 usage + 当前时间」，UI（`src/ui.mjs`）照这个数字显示 —— 纯属伪造的账。
      this._lastSummaryProvider = undefined;
      this._lastSummaryModel = undefined;
      this._lastSummaryUsage = undefined;
      return {
        summary: [{ type: "text", text }],
        rawOutput: undefined,
        llmStreamCall: false,
        provider: routed?.provider ?? "chess-context",
        model: routed?.model ?? "rules",
      };
    };

    if (mode === "rules") {
      this.#markFoldMode(g, "rules");
      return ruleResult();
    }

    const target = summarizeTarget(this.chess, session, agent);
    if (target === undefined) {
      if (mode === "hybrid") {
        this.#markFoldMode(g, "rules");
        return ruleResult();
      }
      throw new Error("chess-context: no provider/model available for summarization");
    }

    const priorFold = hasPriorCheckpoint(session);
    const range = this.#activeRange();
    // C39：本段是否早于棋谱（重启续跑的历史没有节点可引用）—— 摘要指令据此提示「只按 seq 引用」。
    const preGraphFold = foldClosureOf(g, range)?.preGraph === true;
    const instruction = buildChessInstruction({
      // ★ 2026-11-01（调研候选 #3）：把会话目录（相对化后）传进事实块 —— 省略行要给出「去哪查」。
      facts: renderFacts(g, {
        range,
        treeDir: this.#sessionDir(session),
        traceRoot: this.chess.hotLedgerTraceRoot ?? "",
      }),
      shadowedStart: range?.start,
      shadowedEnd: range?.end,
      priorFold,
      preGraph: preGraphFold,
    });

    // ★ B1（2026-11-01）：`let` —— 下面的「摘要模型不可用 ⇒ 改走当前路由」分支要**换引用**，
    //   不能往这个实例回写（新版宿主 BlockAssembler 没有 chunks，usage/finish 是只读 getter）。
    let assembler = new BlockAssembler();
    const messages = [
      ...input.messages,
      { role: "user", content: [{ type: "text", text: instruction }] },
    ];
    const buildOptions = (t) => ({
      provider: t.provider,
      model: t.model,
      messages,
      toolHistory: session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.chess.maxTokens,
      sessionId: session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    });
    const runStream = async (t, into) => {
      for await (const chunk of this.ctx.llm.stream(buildOptions(t))) into.push(chunk);
      const finish = into.finish;
      if (finish?.kind === "error" || finish?.kind === "aborted") {
        throw new LlmError(finish.failure?.message ?? "summarization failed", finish.failure?.code, finish.failure);
      }
      if (finish?.kind === "max-tokens") {
        const error = new Error("chess-context: summarization truncated at the token cap (incomplete record)");
        error.code = "MAX_TOKENS";
        throw error;
      }
      return into;
    };

    // ★ 2026-10-29 实机暴露：preset 把摘要模型配成 `magpie/ima/deepseek-v4.1-flash`，
    //   而 magpie provider 的模型表里没有它 ⇒ 每次 fold 都抛
    //   `pi-ai provider "magpie" has no configured model "ima/deepseek-v4.1-flash"`，
    //   当前会话连试 8 次全失败（上下文只会继续涨 —— 和 P0 的后果一样，只是原因不同）。
    //   摘要模型不可用**不该让整条压缩链失败**：
    //     ① 退回「当前路由的模型」再试一次；
    //     ② 还不行且是 hybrid ⇒ **退回规则摘要（零模型调用）**，fold 必须能落地 ——
    //        压缩失败 = 上下文只增不减，比摘要质量下降严重得多。
    let used = target;
    try {
      try {
        await runStream(target, assembler);
      } catch (error) {
        const routed = routedTarget(session);
        const differs = routed !== undefined && (routed.provider !== target.provider || routed.model !== target.model);
        if (!differs || signal?.aborted) throw error;
        this.ctx.logger?.warn?.(
          `chess-context: 摘要模型 ${target.provider}/${target.model} 不可用（${String(error?.message ?? error)}），改用当前路由 ${routed.provider}/${routed.model} 重试一次`,
        );
        used = routed;
        // ★ B1（2026-11-01）：宿主 `@deepseek-ai/dsh-llm` 0.2.1-rc.5 的 `BlockAssembler`
        //   **没有 `chunks`**，且 `usage` / `finish` 是**只读 getter**（严格模式赋值抛 TypeError）。
        //   旧写法（`assembler.chunks.length = 0` + 逐块 push + 回写 finish/usage）会在这里炸；
        //   而外层还有一层 `catch { …退回规则摘要 }` ⇒ **回退分支静默失效、fold 降级成规则摘要**
        //   （表面只留一条会误导读者的 warn「摘要模型全部不可用」）。
        //   正确做法：**换引用** —— `runStream` 返回的就是装配完的那个实例，后文 `blocks()` / `usage`
        //   自然读到 retry 的产物。不要回写旧实例，也不要依赖 `chunks`。
        assembler = await runStream(routed, new BlockAssembler());
      }
    } catch (error) {
      if (mode !== "hybrid" || signal?.aborted) throw error;
      this.ctx.logger?.warn?.(
        `chess-context: 摘要模型全部不可用（${String(error?.message ?? error)}）——退回规则摘要（零模型调用），保证 fold 能落地`,
      );
      this.#markFoldMode(g, "rules");
      // ★ 2026-11-01（C7）：走同一个 ruleResult()，这样降级摘要也会被保真度指标统计到。
      return { ...ruleResult(), degraded: "rules" };
    }
    const raw = assembler.blocks();
    if (contentHasImage(raw)) throw new LlmError("chess summary cannot contain image output", "UNSUPPORTED_CONTENT");
    const summary = raw.filter((block) => block.type === "text");
    if (!summary.some((block) => String(block.text ?? "").trim().length > 0)) {
      throw new Error("chess-context: summarization produced no text summary content");
    }
    // 2026-11-01（C10）：把**模型自己的输出**单独留一份 —— 机械追加段（约束 / 最近访问的文件）之后，
    // 最终产物里约束必然齐，但那不是模型的功劳。modelConstraintRecall 回答的是
    // 「如果去掉机械兜底，模型会丢多少约束」—— 它是决定「机械兜底值不值得维护」的唯一观测。
    // 必须在下面 push 机械段**之前**取，否则它就不是「模型自己的输出」了。
    const modelText = summary.map((block) => String(block.text ?? "")).join(String.fromCharCode(10));
    // ★ 机械追加约束段：实测模型在 15 条失败边的压力下会把 3 条约束全丢（多规模测试 B 场景 0/3）。
    //   约束丢失 = 任务漂移，比失败边丢失更致命。所以约束不经过模型 —— 规则抽什么，产物里就有什么。
    const constraintsBlock = extractConstraintsBlock(renderFacts(g));
    if (constraintsBlock) {
      summary.push({ type: "text", text: `

## 约束（机械保留，逐字；不由模型改写）
${constraintsBlock.split("\n").map((l) => `- ${l}`).join("\n")}` });
    }
    // ★ 2026-11-01（调研候选 #4）：机械追加「最近访问的文件」。
    //   折叠段里的 read/edit/write 在摘要里只剩一句「改了接口」，然后模型就不知道是**哪个文件**；
    //   而路径本来就在图边的 action 里。机械解析、零模型调用、只进摘要（不进每步热清单）。
    const touchedBlock = touchedFilesBlock(g, range);
    if (touchedBlock) summary.push({ type: "text", text: touchedBlock });
    // 记账：这次摘要调用了多少 token（provider 真实 usage）。#commit 会把它写进 graph.lastFoldUsage，
    // doctor / 计费对账直接读，不用再翻会话日志里的 compaction/summary 事件。
    // ★ P2-2（task-192）：**路由无条件记录**（有的 provider 不回 usage，但 route 永远可得）；
    //   usage 只在真返回时记 —— foldMark.route 因此不会因为缺 usage 变成 null。
    // ★ 2026-11-01（real-model 实测发现）：摘要长度是压缩质量的另一半 —— 保真再高，
    //   如果模型不遵守长度预算写出一万多字，上下文成本会翻几倍。记进 foldMarks 供 doctor 追踪，
    //   但**不阻断**（拒绝会丢信息，比长度超标更糟；05 §7.1 的"整条拒绝"在这里不适用）。
    // ★ C237：把「我们自己加的指令」量出来（facts + 模板），供 foldMark 记录、doctor 显示。
    //   为什么值得记：讨论「input/shadowed = 1.4」时，没人知道那 40% 是不是我们造成的 ——
    //   实测一次 231k 的 fold 里我们只占 3,996 tok（1.7%），其余全是宿主送进来的消息。
    try {
      this._lastSummaryInstructionTokens = typeof instruction === "string" && instruction !== "" ? estimateTokens(instruction) : null;
    } catch {
      this._lastSummaryInstructionTokens = undefined;
    }
    this._lastSummaryChars = summary.reduce((n, b) => n + String(b.text ?? "").length, 0);
    this._lastSummaryText = summary.map((b) => String(b.text ?? "")).join("\n");
    this._lastSummaryModelText = modelText;
    this._lastSummaryProvider = used.provider;
    this._lastSummaryModel = used.model;
    if (assembler.usage !== undefined) this._lastSummaryUsage = assembler.usage;
    // ★ C317：**摘要被截断**必须能看出来。
    //   官方 API 文档（create-chat-completion）：`finish_reason="length"` 表示生成超过 max_tokens
    //   或上下文超限，此时**内容可能被截断**。以前我们完全没读这个字段 ——
    //   被截断的摘要与完整摘要在 foldMark 里长得一模一样（summaryChars 只是短一点）。
    //   防御式读取：宿主不同版本可能把它放在 raw / message / choice 上；读不到就是 null。
    // ★ C318：宿主的真实字段是 **`stopReason`**（实测 app.asar 里 `zStopReason = end_turn|max_tokens|max_turn_requests|refusal|cancelled`），
    //   不是 OpenAI 风格的 `finish_reason`。截断判断因此是 **`stopReason === "max_tokens"`**。
    //   仍然保留了 finish_reason / finishReason 等形状的兜底 —— 万一某些 provider 适配层透传原始值。
    this._lastSummaryFinishReason =
      raw?.stopReason ??
      raw?.stop_reason ??
      raw?.finish_reason ??
      raw?.finishReason ??
      raw?.choice?.finish_reason ??
      raw?.message?.finishReason ??
      null;
    this.#markFoldMode(g, mode);
    return {
      summary,
      rawOutput: raw,
      llmStreamCall: true,
      provider: used.provider,
      model: used.model,
      maxTokens: this.chess.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }

  /**
   * P2-14：官方 `/compact` 走 `compactNow → compactRegion`，不经过 compactIfNeeded，
   * 那时 `_chessActiveRange` 是 null，摘要里的「本段遮蔽 seq」会变成 undefined。
   * 这里在事务入口设置、finally 恢复（prev 支持嵌套）。
   */
  async compactRegion(start, end, agent, signal) {
    const ownerRegion = ENGINE_BY_CTX.get(this?.ctx);
    if (ownerRegion !== undefined && ownerRegion !== this) return ownerRegion.compactRegion(start, end, agent, signal);
    const prev = this._chessActiveRange ?? null;
    // ★ C198：**宿主直接调用** `compactRegion`（不走我们的 compactIfNeeded / compactNow）时，
    //   以前完全不留账 —— live 上表现为「上下文明显在被压（checkpoint 一条条出现），但 foldMarks 一动不动」，
    //   doctor 的「fold 新鲜度」还会误报「+13,326 事件没 fold」。
    //   判定：进入时 `_chessActiveRange` 为 null ⇒ 不是我们自己的路径（我们自己的路径会先 set 它）。
    const externalCall = prev === null && (this._manualCompactDepth ?? 0) === 0;
    this._chessActiveRange = { start, end };
    // 2026-11-01（C14）：手动 `/compact` 走的是 compactNow → compactRegion，不经过 compactIfNeeded，
    // 所以此前**手动压缩没有任何 foldMark / 保真度样本**（覆盖缺口）。这里在手动深度标记生效时记下区间。
    if ((this._manualCompactDepth ?? 0) > 0) this._manualRange = { start, end };
    try {
      const out = await super.compactRegion(start, end, agent, signal);
      if (externalCall) this.#recordExternalFold(agent, start, end);
      return out;
    } finally {
      this._chessActiveRange = prev;
    }
  }

  /**
   * ★ C198：给「宿主直接调用 compactRegion」的折叠补一条 foldMark（`trigger: "host"`）。
   *
   * 为什么必须记：不记的话，这些折叠在证据里**完全不存在** —— 保真度/边界/闭包/成本都缺样本，
   * 而 doctor 的「fold 新鲜度」还会显示「很久没 fold」。
   * 与 tier-2 同口径消费 `_lastSummary*` 字段（谁生产谁消费），失败不影响主流程。
   */
  #recordExternalFold(agent, start, end) {
    try {
      const session = agent?.session;
      if (session === null || session === undefined) return;
      const g = this.#graph(session);
      const summaryText = this._lastSummaryText ?? "";
      const summaryChars = this._lastSummaryChars ?? null;
      const modelText = this._lastSummaryModelText ?? "";
      this._lastSummaryChars = undefined;
      this._lastSummaryFinishReason = undefined;
      this._lastSummaryInstructionTokens = undefined;
      this._lastSummaryText = undefined;
      this._lastSummaryModelText = undefined;
      const range = { start, end };
      // ★ C198：记进**预算账本**（与 ledger-budget.json 同源），不写图 —— 图的 foldMarks 走
      //   基线/增量两条持久化路径，宿主外部折叠不该再往那套记账里塞一条（字段语义/清理规则都不同）。
      const budget = this.ledgerBudget ?? {};
      budget.externalFolds = (Number.isFinite(budget.externalFolds) ? budget.externalFolds : 0) + 1;
      budget.lastExternalFold = {
        at: Date.now(),
        session: session.id,
        seqStart: start,
        seqEnd: end,
        summaryChars,
      // ★ C317：`"length"` = 摘要被 max_tokens 截断（内容可能不完整）；null = 没采集到
      finishReason: this._lastSummaryFinishReason ?? null,
        closure: foldClosureOf(g, range),
        boundary: foldBoundaryOf(g, range),
        quality: summaryText === "" ? null : safeMeasureFoldQuality({ graph: g, range, summaryText, modelText }),
      };
      this.#persistLedgerBudget();
    } catch (error) {
      if (process.env.GOKIFU_DEBUG_C198 === "1") console.error("[C198] record failed:", error);
      /* 记账失败不许影响压缩 */
    }
  }

  /**
   * ★ C210：归档收尾折叠（best-effort）。
   *
   * 为什么单独一个方法：`session/disposed` 是 **void** 事件 —— 我们不能 await 太久，
   * 也不能让模型调用/落盘异常冒到宿主。这里用 `Promise.race` 给一个硬超时，
   * 超时/失败都只记一行日志，**归档继续**。
   *
   * @param {object} session
   * @returns {Promise<object|null>}
   */
  /**
   * ★ C288（K-15 的第一步）：**尾巴大到必然超模型窗口时，别去打那个必败的请求**。
   *   实测（2026-11-02）本机 11/11 个可估欠账都超过 150k tok（最大 1.24M）——
   *   一次性收尾折叠会被 provider 以「上下文超长」拒绝，白等一个 90s 超时 + 白花一次输入。
   *   这里只做**预检 + 明确日志**，不写 `g.closeout`（写了会永久挡住以后再补，那更糟）。
   *   真正的解是分段折叠（K-15 的第二步），那要改折叠区间规划，另案。
   */
  #closeoutTooBig(graph) {
    return closeoutExceedsLimit(graph);
  }

  async #closeoutFold(target, trigger = "archive") {
    const limitMs = this.chess.closeoutTimeoutMs ?? 90_000;
    {
      // 预检：太大就别打（省一次必败的模型调用 + 90 秒等待）
      const id = target?.session?.id ?? target?.id;
      const tooBig = this.#closeoutTooBig(typeof id === "string" ? this.graphs.get(id) : undefined);
      if (tooBig !== null) {
        // ★ C289：不再"跳过"，改成**分段折叠**（K-15 第二步）。
        const graph = typeof id === "string" ? this.graphs.get(id) : undefined;
        // ★ C309：预检 + 切分合成一个纯函数调用（可测），这里只管执行
        // ★ C316：单段上限可配（默认 150k 保守；宿主窗口 1M 时可调大以减少补账轮次）
        const configuredMax = Number(this.chess.closeoutMaxFoldTokens);
        const planned = planChunkedCloseout(graph, {
          maxTokens: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : CLOSEOUT_MAX_FOLD_TOKENS,
        });
        const chunks = planned?.chunks ?? [];
        const debt = (() => {
          try {
            return debtOfGraph(graph);
          } catch {
            return null;
          }
        })();
        if (chunks.length === 0) {
          this.ctx.logger?.warn?.(
            `chess-context: 归档收尾跳过（尾巴约 ${Math.round(tooBig.est / 1000)}k tok，超过一次性折叠上限，且切不出可折叠的分段）`,
          );
          return null;
        }
        this.ctx.logger?.info?.(
          `chess-context: 归档收尾分段折叠 ${chunks.length} 段（尾巴约 ${Math.round(tooBig.est / 1000)}k tok，单段上限 ${Math.round(CLOSEOUT_MAX_FOLD_TOKENS / 1000)}k）`,
        );
        // ★ C291：分段路径**必须**受同一个 `closeoutTimeoutMs` 约束 ——
        //   C289 把它写在了超时包装之外，6 段大折叠能跑两三分钟，等于把归档回调卡死。
        //   现在：整体 deadline + 每段各自的剩余时间 race，到点就停（已折的段保留）。
        const outcome = await runChunkedCloseout({
          chunks,
          deadline: Date.now() + limitMs,
          fold: async (start, end, remaining) => {
            let timer = null;
            const timeout = new Promise((resolve) => {
              timer = setTimeout(() => resolve("timeout"), remaining);
              if (typeof timer?.unref === "function") timer.unref();
            });
            try {
              const out = await Promise.race([this.compactRegion(start, end, this.#asAgent(target), undefined), timeout]);
              if (out === "timeout") throw Object.assign(new Error("chunk timeout"), { code: "CHUNK_TIMEOUT" });
              return out;
            } finally {
              if (timer !== null) clearTimeout(timer);
            }
          },
        });
        const folded = outcome.folded;
        const stopped = outcome.stopped;
        if (outcome.error !== null && outcome.error !== undefined) {
          this.ctx.logger?.warn?.(
            `chess-context: 分段收尾在第 ${folded + 1}/${chunks.length} 段失败（不影响归档）：${String(outcome.error)}`,
          );
        }
        // 说清"这次折到哪儿、还剩多少" —— 大到 6 段装不下的尾巴需要**再调一次**才能折完
        const covered = chunks[chunks.length - 1]?.end ?? 0;
        const totalEnd = (Number(debt?.lastFoldSeq ?? 0) || 0) + chunks.reduce((sum, c) => sum + (c.end - c.start), 0);
        const remaining = Math.max(0, (tooBig.tail ?? 0) - chunks.reduce((sum, c) => sum + (c.end - c.start), 0));
        this.ctx.logger?.info?.(
          `chess-context: 分段收尾完成 ${folded}/${chunks.length} 段（覆盖到 seq ${covered} / 尾巴 ${tooBig.tail} 事件，` +
            `还剩约 ${remaining} 事件；结束原因 ${stopped}${stopped === "deadline" ? `，已用满 ${limitMs}ms 预算` : ""} —— 装不下就再收一次）`,
        );
        void totalEnd;
        return { tier: "chunked", folded, chunks: chunks.length };
      }
    }
    const work = (async () => {
      try {
        return await this.compactIfNeeded(this.#asAgent(target), trigger, undefined);
      } catch (error) {
        this.ctx.logger?.warn?.(`chess-context: 归档收尾折叠失败（不影响归档）：${String(error)}`);
        return null;
      }
    })();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limitMs);
      if (typeof timer?.unref === "function") timer.unref();
    });
    try {
      const result = await Promise.race([work, timeout]);
      if (result === "timeout") this.ctx.logger?.warn?.(`chess-context: 归档收尾折叠超时（${limitMs}ms），已放弃本次收尾`);
      else if (result !== null && result !== undefined) this.ctx.logger?.info?.("chess-context: 归档收尾折叠完成");
      return result === "timeout" ? null : result;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * ★ task-174：官方 `/compact` 在「回合还开着」时抛
   *   `ManualCompactionError("busy", "manual compaction: the session already has an open turn")` ——
   *   用户只看到一句英文，不知道「要等本轮结束」。这里**只改错误可读性**：
   *   · 成功路径原样返回（不包装、不改返回值形状）；
   *   · 失败时把分类诊断挂到**原错误对象**上（`diagnosis` / `rawMessage`），并把 message 换成人话；
   *     `name` / `code` / `cause` / `stack` 全部保留（宿主按 code 分类，不按 message）。
   */
  async compactNow(agent, signal, sourceCommandId) {
    const ownerNow = ENGINE_BY_CTX.get(this?.ctx);
    if (ownerNow !== undefined && ownerNow !== this) return ownerNow.compactNow(agent, signal, sourceCommandId);
    this._manualCompactDepth = (this._manualCompactDepth ?? 0) + 1;
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId);
      // 2026-11-01（C14）：手动 /compact 也记一条 foldMark（trigger="manual"）+ 保真度样本。
      // 这是最后一块覆盖缺口：自动 fold / 规则降级 / tier-2 都有样本，只有手动压缩此前没有。
      const range = this._manualRange ?? null;
      if (result !== null && result !== undefined && range !== null) {
        this.recordFoldMark(agent.session, { range, trigger: "manual" });
      }
      return result;
    } catch (error) {
      annotateManualCompactError(error);
      throw error;
    } finally {
      this._manualCompactDepth = Math.max(0, (this._manualCompactDepth ?? 1) - 1);
      this._manualRange = null;
      // ★ C137：与 C136 同源 —— 手动压缩无论成功/失败，都不许把 summarize 的 pending 摘要留给下一次 fold。
      //   成功路径已经在 try 里把这三个字段消费掉了（记 foldMark 用），这里清的一次是**兜底**（异常/空返回）。
      this._lastSummaryChars = undefined;
      this._lastSummaryInstructionTokens = undefined;
      this._lastSummaryText = undefined;
      this._lastSummaryModelText = undefined;
      // ★ C148（复审 P2-2）：与 C143 的规则路径同源 —— route/usage 也必须清，
      //   否则下一次模型 fold 若 provider 不回 usage，会把**上一次手动压缩**的 usage 记成本次。
      this._lastSummaryProvider = undefined;
      this._lastSummaryModel = undefined;
      this._lastSummaryUsage = undefined;
    }
  }

  /**
   * 记一条 foldMark（公开方法 = 测试接缝，与 `consumeLedgerBudget` 同一性质）。
   *
   * 为什么抽出来：手动 `/compact` 的记账逻辑要和自动 fold 同口径（quality 来自 summarize 留下的
   * pending 摘要文本），但它不在 `compactIfNeeded` 里，没法复用内联代码。
   * **谁生产谁消费**：这里会清空 `_lastSummary*`，避免这些字段挂到下一次 fold。
   */
  recordFoldMark(session, { range = null, trigger = "manual", shadowedTokens = null } = {}) {
    const g = this.#graph(session);
    const summaryText = this._lastSummaryText ?? "";
    const summaryChars = this._lastSummaryChars ?? null;
    const modelText = this._lastSummaryModelText ?? "";
    this._lastSummaryChars = undefined;
    this._lastSummaryText = undefined;
    this._lastSummaryModelText = undefined;
    const quality = summaryText === "" ? null : safeMeasureFoldQuality({ graph: g, range, summaryText, modelText });
    const mark = {
      at: Date.now(),
      seqStart: range?.start ?? null,
      seqEnd: range?.end ?? null,
      trigger,
      // 2026-11-02（C24）：手动压缩同样记可寻址闭包（与自动 fold 同口径）
      closure: foldClosureOf(g, range),
      // C31：切点是否落在工具调用中间（正常应为 0）
      boundary: foldBoundaryOf(g, range),
      summaryChars,
      quality,
    };
    if (Number.isFinite(shadowedTokens)) mark.shadowedTokens = shadowedTokens;
    g.foldMarks.push(mark);
    if (g.foldMarks.length > FOLD_MARKS_KEEP) g.foldMarks = g.foldMarks.slice(-FOLD_MARKS_KEEP);
    this.#flush(session);
    return mark;
  }

  #activeRange() {
    return this._chessActiveRange ?? null;
  }

  /* ─────────────────── 触发策略：growth-gated 增量 fold ─────────────────── */

  async compactIfNeeded(agent, trigger, signal) {
    const ownerNeeded = ENGINE_BY_CTX.get(this?.ctx);
    if (ownerNeeded !== undefined && ownerNeeded !== this) return ownerNeeded.compactIfNeeded(agent, trigger, signal);
    const session = agent.session;
    const target = routedTarget(session);
    if (target === undefined) return null;

    // tier-2 先跑：surface 上的 checkpoint 太多时，把最老的两条合并成一条。
    // 它与压力无关（checkpoint 常驻本身就是成本），因此放在阈值判断之前。
    if (trigger === "pressure" && this.chess.tier2After > 0) {
      const merged = await this.#tier2IfNeeded(agent, signal);
      if (merged !== null && merged !== undefined) return merged;
    }
    const policy = resolvePolicy(this.chess, target);
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(session);

    // ★ C177：连续失败后的退避 —— 不给「坏掉的摘要路径」每个事件都再付一次模型调用。
    // ★ C179：`context-overflow` 也不再无限重试 —— 前 3 次仍然「宁可不惜代价自救」，
    //   从第 4 次起同样进退避窗口。理由：已连续失败 3 次的摘要路径，再试一次的成功率极低，
    //   而每一步都跑一次模型 = 溢出场景下最贵的死循环。
    {
      const stBackoff = this.#runtimeFor(session);
      const failures = stBackoff.foldFailures ?? 0;
      const overflow = trigger === "context-overflow";
      if (failures > 0 && (!overflow || failures >= 3)) {
        const wait = Math.min(FOLD_RETRY_BASE_SEQ * 2 ** Math.min(failures - 1, 6), FOLD_RETRY_CAP_SEQ);
        const since = session.seq - (stBackoff.lastFoldFailureSeq ?? 0);
        if (since < wait) return null;
      }
    }
    const g = this.#graph(session);
    const st = this.#runtimeFor(session);

    const overflow = trigger === "context-overflow";
    if (overflow) {
      const prune = this.ctx.get("toolResultPruner");
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = meter.measure(session);
      }
    }

    let spec;
    // ★ C216（真机第二轮）：**收尾折叠不受 token 压力门槛限制**。
    //   archive / backfill 的语义是「这段尾巴必须有个交代」，恰恰发生在**压力还不高**的时候
    //   （会话已经闲置很久、用户做完就归档）。旧代码让它们和 pressure 走同一道门槛 ⇒
    //   尾巴够长但没有到阈值时收尾折叠会静默什么都不做 —— 与不修没区别。
    //   仍然保留 retainTokens / minFoldTokens 的语义：真的没东西可折时 planFold 会返回 null。
    const forced = trigger === "archive" || trigger === "backfill" || trigger === "disposed";
    if (overflow) {
      spec = { thresholdTokens: 0, retainTokens: 0 };
    } else {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      if (info.context === undefined) {
        throw new Error(
          `chess-context: no context capacity for ${target.provider}/${target.model}; configure contextWindow on that adapter model`,
        );
      }
      const reserved = session.requestHeader()?.config?.maxTokens ?? info.defaultMaxTokens ?? 0;
      // ★ S8：本会话第一次 fold 用 firstFoldRatio（默认 0.30）削峰；之后回到 thresholdRatio。
      spec = resolveSpec(policy, info.context.contextWindow, reserved, g.foldCount === 0);
      // ★ C197：无论是否触发，都记一次「压力快照」（节流在方法内），让 doctor 能回答「还差多少」
      this.#recordPressure(session, measurement.totalTokens, spec.thresholdTokens, trigger);
      if (!forced && measurement.totalTokens < spec.thresholdTokens) return null;
      const prune = this.ctx.get("toolResultPruner");
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = meter.measure(session);
      }
      if (!forced && measurement.totalTokens < spec.thresholdTokens) return null;
      // 增长门控：距上次 fold 的增量不足就不折腾（省掉一次模型调用）。
      // archive / backfill 是**补账**，不是「长了没长」的问题 ⇒ 跳过这道门控（C216）。
      if (!forced && this.chess.growthFloorTokens > 0 && g.foldCount > 0) {
        const growth = measurement.totalTokens - (g.lastFoldTotalTokens ?? 0);
        if (growth < this.chess.growthFloorTokens) return null;
      }
    }

    // —— 状态哈希回填（只有在这里做，因为需要 stat 文件；fold 不频繁）——
    const world = st.world.hash();
    // P1-10：backfillState 会改哈希、合并节点 —— 如果后面 compactRegion 失败/返回 null，
    //   旧版会留下一个「被改写但 foldCount 没变」的图。这里先快照，任何未完成路径都恢复。
    const graphSnapshot = toJSON(g);
    // ★ C142：快照必须连**当时的 dirty** 一起拍。此时本轮用户节点刚进 keeper、还没落盘
    //   （flush 是 1.2s debounce）；只回图不清 dirty 会让下一次 delta 重删恢复的节点（C113），
    //   而只回图 + 清 dirty 会让这个还没落盘的节点永远写不下去（C142 的 P0）。
    const dirtySnapshot = peekDirty(g);
    const restore = () => {
      try {
        restoreFromSnapshot(g, graphSnapshot, dirtySnapshot);
      } catch {
        /* 快照本身坏了就放弃恢复（不掩盖原始错误） */
      }
    };
    backfillState(g, st, world.hash, this.chess);
    const range = this.#selectRange(session, measurement, g, spec, overflow);
    if (range === null) {
      restore();
      // ★ C112：回滚后必须走 `tree` 落盘 —— 否则 index.md 还停在回滚前的渲染上，
      //   nodes/*.md 也留着被回滚掉的节点（C110/C111 观测到的 94 个残骸正是这么来的）。
      this.#flush(session, { tree: true });
      return null;
    }

    // ★ P2-2（task-192）：fold 端到端耗时（summary + commit + flush）—— 写进 foldMarks.ms
    const foldStartedAt = Date.now();
    this._chessActiveRange = { start: range.start, end: range.end };
    let result;
    try {
      result = await this.compactRegion(range.start, range.end, agent, signal);
    } catch (error) {
      // fold 真的抛错：恢复图，保证「foldCount 没变 ⇒ 图也没变」
      restore();
      st.foldFailures += 1;
      st.lastFoldFailureSeq = session.seq;
      st.lastFoldError = String(error?.message ?? error).slice(0, 180);
      this.#flush(session, { tree: true });
      // ★ C242（K-13）：永久性错误 ⇒ ①退避顶到上限（别每 30 个事件白试一次）
      //   ②下次折叠强制走规则摘要（压缩不能因此不落地）。
      if (isPermanentSummaryError(st.lastFoldError)) {
        st.foldFailures = Math.max(st.foldFailures, 7); // 7 ⇒ wait = min(30×2^6, 480)
        st.forceRulesNext = true;
      }
      throw error;
    } finally {
      this._chessActiveRange = null;
    }
    if (result === null || result === undefined) {
      // ★ C112：同 range===null 分支 —— 回滚后必须 tree 落盘，让 index.md / nodes 跟上图
      restore();
      this.#flush(session, { tree: true });
      return null;
    }
    const after = meter.measure(session);
    // 压缩成功 ⇒ 告警计数清零（告警是「当前有故障」，不是「历史有过故障」）
    st.foldFailures = 0;
    st.lastFoldFailureSeq = 0;
    st.lastFoldError = "";
    // ★ 2026-11-01（调研候选 #1，学 Claude Code 的 "Autocompact is thrashing"）：
    //   **压缩无效**要当一等错误记下来，不能静默。判据是「两次 fold 之间隔了多少事件」——
    //   隔得太近说明上一次回收的空间立刻又满了（典型原因：压完没缩小、或会话本身在灌数据）。
    //   只记状态、不改行为；低于阈值就累计，否则清零（成功一次就恢复）。
    //   为什么放 graph 而不是运行时 state：跨重启可见，doctor/热清单都能读。
    const sinceLastFold = typeof g.lastFoldSeq === "number" ? session.seq - g.lastFoldSeq : Number.POSITIVE_INFINITY;
    if (g.foldCount > 0 && sinceLastFold < THRASH_SEQ) {
      g.foldThrash = (g.foldThrash ?? 0) + 1;
    } else {
      g.foldThrash = 0;
    }
    g.lastFoldSeq = session.seq;
    g.foldCount += 1;
    g.lastFoldTotalTokens = after.totalTokens;
    // 记「checkpoint 消息的 seq」，不是被遮蔽区间的起点 —— 后者 fold 之后已不在 surface 上，
    // 任何读这个字段做判断的地方都会拿到一个不存在的 seq（2026-10-29 实机：值一直是 9）。
    g.checkpointSeq = checkpointSeqs(session).at(-1) ?? null;
    // ★ P2-2（task-192）：每次 fold 的可观测字段 —— 路由、是否降级、耗时、真实 usage。
    //   旧图里的 foldMark 没有这些字段 ⇒ doctor 显示「—」（向后兼容）。
    //   **快照必须在下面清空 _lastSummary* 之前取**（否则 route 永远是 null —— 踩过）。
    const summaryMode = this._lastSummaryMode ?? null;
    const summaryChars = this._lastSummaryChars ?? null;
    const summaryText = this._lastSummaryText ?? "";
    const modelText = this._lastSummaryModelText ?? "";
    this._lastSummaryChars = undefined;
    this._lastSummaryText = undefined;
    this._lastSummaryModelText = undefined;
    // ★ 2026-11-01：保真度 L1（零模型调用）—— 前两项必须 = 1。
    //   接在这里是为了让它有**真实语料消费者**：只算不接的指标会一直算着假数（第 2 轮的教训）。
    const foldQuality = safeMeasureFoldQuality({
      graph: g,
      range,
      summaryText,
      // ★ 2026-11-01（C7）：不传 summaryTokens —— 让 fold-quality 用与账本/bench 同一套 CJK 感知口径
      //   （CJK 1 token/字 + 其余 1/4）现算。旧写法 `Math.ceil(summaryChars/2)` 对 ASCII 重的摘要会
      //   系统性高估 token ⇒ compressionRatio（遮蔽÷摘要）被系统性低估，指标失真。
      modelText,
      shadowedTokens: range?.shadowedTokens ?? null,
    });
    const summaryUsage = this._lastSummaryUsage ?? null;
    const summaryRoute = { provider: this._lastSummaryProvider ?? null, model: this._lastSummaryModel ?? null };
    this._lastSummaryMode = undefined;
    if (this._lastSummaryUsage !== undefined) {
      g.lastFoldUsage = {
        ...this._lastSummaryUsage,
        provider: this._lastSummaryProvider ?? null,
        model: this._lastSummaryModel ?? null,
        at: Date.now(),
      };
      this._lastSummaryUsage = undefined;
      this._lastSummaryProvider = undefined;
      this._lastSummaryModel = undefined;
    }
    g.foldMarks.push({
      at: Date.now(),
      seqStart: range.start,
      seqEnd: range.end,
      // 2026-11-02（C24）：可寻址闭包 —— 本次折叠覆盖了图里哪些节点/边（计数 + 首尾 id）。
      closure: foldClosureOf(g, range),
      // C31：切点是否落在工具调用中间（正常应为 0）
      boundary: foldBoundaryOf(g, range),
      // 2026-11-01（C12）：**为什么压**也要可观测 —— pressure（到阈值）/ context-overflow（已经溢出、被迫自救）。
      // overflow 出现说明「压缩没跟上上下文增长」，这是压缩健康的真实告警信号（此前只存在日志里）。
      trigger,
      shadowedTokens: range.shadowedTokens,
      totalAfter: after.totalTokens,
      foldCount: g.foldCount,
      route: summaryRoute,
      fallback: summaryMode === "rules" ? "rules" : null,
      ms: Math.max(0, Date.now() - foldStartedAt),
      usage: summaryUsage === null ? null : {
        ...summaryUsage,
        // ★ C237：我们自己的指令（facts + 模板）占多少 token —— 用它来回答「fold 输入里有多少是我们加的」。
        //   实测（session-1e82afca 一次 231k 的 fold）：指令 3,996 tok = **1.7%**，其余全是宿主送进来的消息。
        //   没有这个字段，每次讨论"输入/遮蔽 = 1.4"都会重新猜一遍。
        instructionTokens: Number.isFinite(this._lastSummaryInstructionTokens) ? this._lastSummaryInstructionTokens : null,
      },
      // 摘要总字符数（含机械追加的约束段与最近访问文件）。老 foldMark 没有该字段 ⇒ null。
      summaryChars,
      // 保真度：constraintRecall / failureRecall（应恒 1）/ compressionRatio（记趋势）。
      // 老 foldMark 没有该字段 ⇒ null，doctor 显示「—」。
      quality: foldQuality,
      // ★ 2026-11-01（调研建议 G-5，来自 docs/research/05-agi-memory-architectures.md §4.4）：
      //   把「边界切得好不好」从直觉变成数字 —— 记下**这次 fold 发生时**的悬空边分类快照。
      //   纯观测：不改任何行为，只是让 doctor 能回答"跨 fold 边界还挂着多少未结算的边"。
      //   liveUnsettled 高 = 切在了一个动作的中间（下一次 fold 前它可能永远不结算）。
      dangling: danglingStats(g, { now: Date.now() }),
    });
    // ★ P2-2：只保留最近 20 条（旧版无限增长 —— 2000 边/长期会话里 foldMarks 是纯膨胀）
    if (g.foldMarks.length > FOLD_MARKS_KEEP) g.foldMarks = g.foldMarks.slice(-FOLD_MARKS_KEEP);
    // ★ 2026-10-29 修复：这里原来传的是 `{ md: true }`，而 `#flush(session, { tree = false })`
    //   只认 `tree` —— 参数名不匹配 ⇒ fold 后**从不**重写 `nodes/*.md`，
    //   压缩后的节点详情停在第一次落盘的样子（Kimi 评估实测发现）。
    this.#flush(session, { tree: true });
    this.ctx.logger?.info?.(
      `chess-context: fold #${g.foldCount} 遮蔽 ${range.end - range.start >= 0 ? `${range.start}-${range.end}` : "?"} (~${range.shadowedTokens} tokens) → 总 ${after.totalTokens} tokens（死路 ${failureEdges(g).length} 条，节点 ${g.order.length}）`,
    );
    // ★ TIER2-SEMANTICS（task-142，方案 A）：checkpoint 常驻成本与「压力」无关，常规 fold 之后也要收。
    //   证据（ws-tier2-semantics/REPORT.md）：fold 的 range 从**上一个 checkpoint 之后**开始
    //   （实测 8 个 checkpoint 之后 start=1009 > cp8=1008）⇒ 旧 checkpoint 全部留在 surface 上，
    //   每 fold 一次 +1，数量随 fold 次数线性增长。旧版只在 trigger === "pressure" 收，
    //   auto / context-overflow 路径会无限堆积（旧的空 `#tier2` 调用不做事）。
    //   安全性：`#tier2IfNeeded` 只调 `compactRegion`（不会回到 `compactIfNeeded`）⇒ 无递归；
    //   另有 `_tier2InFlight` 防重入；`tier2After = 0` 直接跳过（与 compactIfNeeded 的守卫一致）。
    if (this.chess.tier2After > 0) {
      try {
        await this.#tier2IfNeeded(agent, signal);
      } catch (error) {
        this.ctx.logger?.warn?.(`chess-context: fold 后 tier-2 失败（不影响本次 fold）：${String(error)}`);
      }
    }
    return result;
  }

  #selectRange(session, measurement, g, spec, overflow) {
    // ★ C189：规划器是**按下标**走的（retain 尾部、checkpoint 起点、工具对边界都用 index），
    //   所以传进去的两个数组必须**按 seq 升序**、且逐位对齐。
    //   C187 已在 live 上证明「surface 顺序 ≠ seq 顺序」会发生 —— 若照原样传，
    //   主力 fold 也会算出反向区间或折错尾巴（不只是 tier-2）。
    const planned = planFold({
      surfaceNodes: session.surface.nodes,
      pricedNodes: measurement.nodes,
      eventAt: (seq) => session.eventAt(seq),
      retainTokens: spec.retainTokens,
      // ★ S4：用 resolveSpec 算出的窗口缩放值；overflow 路径没有 spec.minFoldTokens ⇒ 回落配置值
      minFoldTokens: spec.minFoldTokens ?? this.chess.minFoldTokens,
      overflow,
      balancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
      balancedAfter: (seq) => toolPairingBalancedAfter(session, seq),
    });
    if (planned.range === null) this.ctx.logger?.debug?.(`chess-context: 本次不 fold（${planned.reason}）`);
    // ★ C189：规划器按**下标**工作，而 surface 顺序不保证按 seq 递增（C187 在 live 上证明过）。
    //   主 fold 也走同一条规划器 ⇒ 这里做最后一道防线：区间反向就交换并留一行日志，
    //   绝不让 `seqStart > seqEnd` 的 foldMark 落到磁盘（doctor「结构自洽」会红）。
    const range = normalizeRange(planned.range);
    if (range !== null && range.reversed === true) {
      this.ctx.logger?.warn?.(
        `chess-context: 折叠区间反向（surface 顺序与 seq 顺序不一致）—— 已交换为 ${range.start}–${range.end}`,
      );
    }
    return range;
  }

  /**
   * tier-2：surface 上 checkpoint 数量到上限时，把**最老的两条**（连同它们之间的节点）
   * 合并成一条。零信息损失：合并后的记录由规则事实重建（失败边、约束、路径都在 graph 里）。
   * @returns 合并结果，或 null（不需要/无法合并）
   */
  async #tier2IfNeeded(agent, signal) {
    // ★ TIER2-SEMANTICS（task-142）：防重入 —— 常规 fold 之后与 pressure 分支都会调它。
    //   重入时直接放弃（宁可少合并一次，也不要在一个 fold 事务里套第二个 compactRegion）。
    if (this._tier2InFlight) return null;
    this._tier2InFlight = true;
    try {
      return await this.#tier2IfNeededUnsafe(agent, signal);
    } finally {
      this._tier2InFlight = false;
    }
  }

  async #tier2IfNeededUnsafe(agent, signal) {
    const session = agent.session;
    const cps = checkpointSeqs(session);
    if (cps.length < this.chess.tier2After) return null;
    // ★ C178：tier-2 也要退避 —— 它与 fold 共用 `compactRegion`（同样会跑一次摘要）。
    //   合并持续失败时，旧代码每个事件都再试一次 ⇒ 与 C177 同类的成本泄漏，只是换了一条路径。
    {
      const st2 = this.#runtimeFor(session);
      const failures2 = st2.tier2Failures ?? 0;
      if (failures2 > 0) {
        const wait2 = Math.min(FOLD_RETRY_BASE_SEQ * 2 ** Math.min(failures2 - 1, 6), FOLD_RETRY_CAP_SEQ);
        if (session.seq - (st2.lastTier2FailureSeq ?? 0) < wait2) return null;
      }
    }
    // ★ C187（live 实测抓到的真缺陷）：`checkpointSeqs` 返回的是 **surface 顺序**，
    //   而 surface 顺序在 fold/replace 之后**不保证按 seq 递增**。live 上就出现过
    //   `foldMarks[9] seqStart=17596 > seqEnd=7629` —— 合并出来的区间是反的，
    //   doctor「棋谱结构自洽」随即报红。
    //   修法：按 seq 排序后取**最老的两条**（语义仍是「合并最老的两个 checkpoint」），
    //   这样 start < end 恒成立。
    const ordered = cps.slice().sort((a, b) => a - b);
    const start = ordered[0];
    const end = ordered[1];
    if (start === undefined || end === undefined || start === end) return null;
    this._chessActiveRange = { start, end, tier2: true };
    let result;
    try {
      result = await this.compactRegion(start, end, agent, signal);
    } catch (error) {
      this.ctx.logger?.warn?.(`chess-context: tier-2 合并失败（不影响主流程）：${String(error)}`);
      {
        const st2 = this.#runtimeFor(session);
        st2.tier2Failures = (st2.tier2Failures ?? 0) + 1;
        st2.lastTier2FailureSeq = session.seq;
      }
      // ★ C136：失败时也必须清掉 summarize 留下的 pending 摘要 —— 否则「谁生产谁消费」被破坏：
      //   下一次 fold（尤其规则路径不再覆盖这些字段时）会把**上一次失败尝试的摘要**当成自己的，
      //   于是 summaryChars / quality 都是错的，而 foldMark 看起来完全正常。
      this._lastSummaryChars = undefined;
      this._lastSummaryInstructionTokens = undefined;
      this._lastSummaryText = undefined;
      this._lastSummaryModelText = undefined;
      return null;
    } finally {
      this._chessActiveRange = null;
    }
    if (result !== null && result !== undefined) {
      const st2 = this.#runtimeFor(session);
      st2.tier2Failures = 0;
      st2.lastTier2FailureSeq = 0;
      const g = this.#graph(session);
      // 2026-11-01（C11）：tier-2 合并**也是压缩生命周期的一部分** —— 它同样会产出摘要，
      // 所以同样要记保真度（此前 tier2 foldMark 没有 quality，医生只能对它「未采集」）。
      // 同时把 summarize 留下的 pending 摘要文本**消费掉**：谁生产谁消费，避免这些字段一直挂到
      // 下一次常规 fold（虽然那里会被覆盖，但两处生命周期共用一组字段本身就是隐患）。
      const summaryText = this._lastSummaryText ?? "";
      const summaryChars = this._lastSummaryChars ?? null;
      const modelText = this._lastSummaryModelText ?? "";
      this._lastSummaryChars = undefined;
      this._lastSummaryInstructionTokens = undefined;
      this._lastSummaryText = undefined;
      this._lastSummaryModelText = undefined;
      const quality =
        summaryText === "" ? null : safeMeasureFoldQuality({ graph: g, range: { start, end }, summaryText, modelText });
      g.foldMarks.push({ at: Date.now(), seqStart: start, seqEnd: end, tier2: true, trigger: "tier2", closure: foldClosureOf(g, { start, end }), boundary: foldBoundaryOf(g, { start, end }), summaryChars, quality });
      if (g.foldMarks.length > FOLD_MARKS_KEEP) g.foldMarks = g.foldMarks.slice(-FOLD_MARKS_KEEP);
      this.#flush(session);
      this.ctx.logger?.info?.(`chess-context: tier-2 合并最老的两个 checkpoint（seq ${start}–${end}）`);
    }
    return result;
  }
}

/* ────────────────────────────── 辅助 ────────────────────────────── */

/**
 * ★ C215：`ctx` → 真正的引擎实例。
 *
 * 为什么需要：C214 用 bind 解决了「方法被摘下来调」，但如果宿主/包装器把**整个对象**换成代理
 * （`{ctx, compactNow(){…}}` 或 Proxy），`this` 依然不是引擎 —— 私有字段的 brand check 仍会抛
 * `Receiver must be an instance of class …`。
 * 这里留一条**回退路**：入口方法开头用 `ctx` 反查真身，真身不等于 `this` 就转调真身。
 */
const ENGINE_BY_CTX = new WeakMap();

/** resolveChess 的键序（与 A2-4 之前逐键同序；`onLedgerBudget` 是 engine 的注入位，不进 SCHEMA）。 */
const RESOLVE_ORDER = [
  "summaryMode", "thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "retainTokens",
  "summarizationProvider", "summarizationModel", "maxTokens", "growthFloorTokens", "minFoldTokens",
  "hotLedger", "hotLedgerMaxTokens", "hotLedgerMinEvents", "hotLedgerMinFailureDelta", "hotLedgerMarkers", "hotLedgerTraceRoot", "hotLedgerReplace",
  "onLedgerBudget", "transposition", "tier2After", "closeoutFold", "closeoutMinEvents", "closeoutTimeoutMs", "graphDir", "worldHashMaxFiles",
];

/** ★ A2-4：净化语义全部在 R15（`resolveConfig`）；这里只负责 engine 的注入位与键序。 */
function resolveChess(config) {
  const c = config ?? {};
  const base = resolveConfig(c);
  const out = {};
  for (const key of RESOLVE_ORDER) {
    out[key] = key === "onLedgerBudget" ? (typeof c.onLedgerBudget === "function" ? c.onLedgerBudget : null) : base[key];
  }
  return out;
}
function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (config === undefined || !config.provider || !config.model) return undefined;
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
  const latest = session.requestHeader()?.config;
  if (latest && latest.provider && latest.model) return { provider: latest.provider, model: latest.model };
  if (agent?.options?.provider && agent.options.model) return { provider: agent.options.provider, model: agent.options.model };
  return undefined;
}

/** checkpoint 消息是否已在 surface 上（避免重复注入同一份清单）。 */
/** surface 上所有 checkpoint 消息的 seq（按表面顺序）。 */
function checkpointSeqs(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "user/message" && isCheckpointSource(event.data?.source)) out.push(seq);
  }
  return out;
}

function hasPriorCheckpoint(session) {
  const nodes = session.surface.nodes;
  for (let i = nodes.length - 1, seen = 0; i >= 0 && seen < 60; i -= 1, seen += 1) {
    const event = session.eventAt(nodes[i]);
    if (event?.type === "user/message" && isCheckpointSource(event.data?.source)) return true;
  }
  return false;
}

/**
 * 状态哈希回填 + 置换合并。
 * 在 fold 之前调用（此时 stat 成本可接受），把本段新增的 agent 节点打上真实哈希；
 * 若某节点与历史节点状态等价，则把它的入边并到历史节点上（不再新建分支）。
 */
function backfillState(g, st, worldHash, chess) {
  const constraintHash = hashSet(collectConstraintText(g));
  const pending = [...g.order].reverse().map((id) => g.nodes[id]).filter((n) => n && n.kind === "agent" && n.worldHash === "pending");
  for (const node of pending) {
    node.worldHash = worldHash;
    node.constraintHash = constraintHash;
    const key = `${worldHash}/${constraintHash}`;
    if (!chess.transposition) {
      g.stateIndex[key] = g.stateIndex[key] ?? node.id;
      continue;
    }
    const existing = g.stateIndex[key];
    if (existing !== undefined && existing !== node.id) {
      mergeNodeInto(g, node.id, existing);
    } else {
      g.stateIndex[key] = node.id;
    }
  }
  g.updatedAt = Date.now();
}

function collectConstraintText(g) {
  const out = [];
  for (const id of g.order) {
    const node = g.nodes[id];
    if (node?.kind === "user") out.push(...(node.constraints ?? []));
  }
  return out;
}

function edgeTouchedPaths(edge) {
  const m = /^(?:write|edit|write_file|edit_file)\(file_path=([^ ]+)/.exec(edge.action ?? "");
  return m ? [m[1]] : [];
}

/** 规则摘要：零模型调用，结构与棋谱摘要一致。 */
function ruleSummary(g, range) {
  const failures = failureEdges(g);
  const lines = [];
  lines.push("## 目标");
  const root = g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];
  lines.push(`- ${root ? root.text.split("\n")[0] : "(none)"}`);
  for (const c of collectConstraintText(g).slice(0, 12)) lines.push(`- ${c}`);
  lines.push("");
  lines.push("## 棋谱（状态节点）");
  const agents = g.order.map((id) => g.nodes[id]).filter((n) => n?.kind === "agent");
  if (agents.length === 0) lines.push("- (none)");
  for (const a of agents.slice(-20)) lines.push(`- ${a.id} seq=${a.seq} 目标=${a.goal || "-"} 状态=${String(a.worldHash).slice(0, 8)}/${String(a.constraintHash).slice(0, 8)}`);
  lines.push("");
  // C47：规则摘要同样只写章节名 —— 摘要会成为后续轮次的上下文内容，标题里的指令会一直生效。
  lines.push("## 已探明死路");
  if (failures.length === 0) lines.push("- (none)");
  for (const e of failures) lines.push(`- ${e.id} "${e.intent || e.action}" → ${(e.errorSnippet || e.verify?.summary || "-").split("\n")[0]} (evidence seq ${e.evidence?.start ?? "?"}-${e.evidence?.end ?? "?"})`);
  lines.push("");
  lines.push("## 已验证事实");
  const ok = Object.values(g.edges).filter((e) => e.result === "success").slice(-15);
  if (ok.length === 0) lines.push("- (none)");
  for (const e of ok) lines.push(`- ${e.id} ${e.action} → ${e.verify?.summary || "ok"}`);
  lines.push("");
  lines.push("## 未验证");
  const open = Object.values(g.edges).filter((e) => e.result === "unverified").slice(-10);
  if (open.length === 0) lines.push("- (none)");
  for (const e of open) lines.push(`- ${e.id} "${e.intent || e.action}"（无外部信号）`);
  lines.push("");
  // ★ 2026-11-01（C15 边界审计发现）：标题是旧版残留（内容早已改成「最近一条用户消息」事实），
  //   与 facts-prompt 的模板对齐，避免读者以为这里还会给行动建议。
  lines.push("## 当前节点与最近用户消息");
  const last = agents[agents.length - 1];
  lines.push(`- 当前节点：${last ? `${last.id}（状态 ${String(last.worldHash).slice(0, 8)}/${String(last.constraintHash).slice(0, 8)}）` : "(none)"}`);
  // ★ 边界（2026-11-01，见 docs/压缩的职责边界.md）：这里**只陈述事实**，不写「下一步该做什么」。
  //   旧版这行写的是「下一步：按最近一条用户指令继续；不要重试『已探明死路』里的任何一条」——
  //   那是**行为指导**，属于 AGENTS / persona 的职责，压缩替它做决定就是越权（而且会和 AGENTS 里的
  //   硬规则打架）。压缩能提供的是「最近一条用户指令是什么」，判断留给模型。
  const lastUser = [...g.order].reverse().map((id) => g.nodes[id]).find((n) => n?.kind === "user");
  const lastUserText = String(lastUser?.text ?? "").split("\n")[0].trim();
  lines.push(
    lastUser
      ? `- 最近一条用户消息（seq ${lastUser.seq}）：${lastUserText.slice(0, 120)}${lastUserText.length > 120 ? "…" : ""}`
      : "- 最近一条用户消息：(none)",
  );
  lines.push("");
  lines.push("## 原始坐标");
  // ★ C64：同上 —— 只陈述坐标，不写「按 seq 回读」这种动作指令。
  lines.push(`- 本段遮蔽 seq ${range?.start ?? "?"}-${range?.end ?? "?"}；逐字原文在 DSH 会话日志中（seq 可定位）。`);
  return lines.join("\n");
}
