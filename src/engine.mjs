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

import { fromJSON, toJSON, sha, hashSet, mergeNodeInto, failureEdges, foldClosureOf, foldBoundaryOf } from "./rooms/kifu-model.mjs";
import { writeBuildStamp } from "./rooms/build-stamp.mjs";
import { observeEvent } from "./rooms/keeper.mjs";
import { createWorldTracker } from "./rooms/world.mjs";
import { planFold, isCheckpointSource } from "./rooms/fold-planner.mjs";
import { renderFacts, danglingStats } from "./rooms/ledger.mjs";
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
    this.graphs = new Map();
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
      lastFoldError: "",
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
    const result = this.persist.flush({ id: session.id, cwd: session.cwd }, g, { tree, full });
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
      if (status === "idle") {
        try {
          // 回合边界 = 提交点：落一份完整的 graph.json（外部读者/doctor/verify 直接读它）
          this.#flush(agent.session, { full: true });
        } catch {
          /* 落盘失败不阻塞 */
        }
      }
    });
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
    const mode = this.chess.summaryMode;

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
    this._lastSummaryChars = summary.reduce((n, b) => n + String(b.text ?? "").length, 0);
    this._lastSummaryText = summary.map((b) => String(b.text ?? "")).join("\n");
    this._lastSummaryModelText = modelText;
    this._lastSummaryProvider = used.provider;
    this._lastSummaryModel = used.model;
    if (assembler.usage !== undefined) this._lastSummaryUsage = assembler.usage;
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
    const prev = this._chessActiveRange ?? null;
    this._chessActiveRange = { start, end };
    // 2026-11-01（C14）：手动 `/compact` 走的是 compactNow → compactRegion，不经过 compactIfNeeded，
    // 所以此前**手动压缩没有任何 foldMark / 保真度样本**（覆盖缺口）。这里在手动深度标记生效时记下区间。
    if ((this._manualCompactDepth ?? 0) > 0) this._manualRange = { start, end };
    try {
      return await super.compactRegion(start, end, agent, signal);
    } finally {
      this._chessActiveRange = prev;
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
      if (measurement.totalTokens < spec.thresholdTokens) return null;
      const prune = this.ctx.get("toolResultPruner");
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = meter.measure(session);
      }
      if (measurement.totalTokens < spec.thresholdTokens) return null;
      // 增长门控：距上次 fold 的增量不足就不折腾（省掉一次模型调用）
      if (this.chess.growthFloorTokens > 0 && g.foldCount > 0) {
        const growth = measurement.totalTokens - (g.lastFoldTotalTokens ?? 0);
        if (growth < this.chess.growthFloorTokens) return null;
      }
    }

    // —— 状态哈希回填（只有在这里做，因为需要 stat 文件；fold 不频繁）——
    const world = st.world.hash();
    // P1-10：backfillState 会改哈希、合并节点 —— 如果后面 compactRegion 失败/返回 null，
    //   旧版会留下一个「被改写但 foldCount 没变」的图。这里先快照，任何未完成路径都恢复。
    const graphSnapshot = toJSON(g);
    const restore = () => {
      try {
        Object.assign(g, fromJSON(graphSnapshot));
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
      st.lastFoldError = String(error?.message ?? error).slice(0, 180);
      this.#flush(session, { tree: true });
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
      usage: summaryUsage === null ? null : { ...summaryUsage },
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
    return planned.range;
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
    const start = cps[0];
    const end = cps[1];
    if (start === undefined || end === undefined || start === end) return null;
    this._chessActiveRange = { start, end, tier2: true };
    let result;
    try {
      result = await this.compactRegion(start, end, agent, signal);
    } catch (error) {
      this.ctx.logger?.warn?.(`chess-context: tier-2 合并失败（不影响主流程）：${String(error)}`);
      return null;
    } finally {
      this._chessActiveRange = null;
    }
    if (result !== null && result !== undefined) {
      const g = this.#graph(session);
      // 2026-11-01（C11）：tier-2 合并**也是压缩生命周期的一部分** —— 它同样会产出摘要，
      // 所以同样要记保真度（此前 tier2 foldMark 没有 quality，医生只能对它「未采集」）。
      // 同时把 summarize 留下的 pending 摘要文本**消费掉**：谁生产谁消费，避免这些字段一直挂到
      // 下一次常规 fold（虽然那里会被覆盖，但两处生命周期共用一组字段本身就是隐患）。
      const summaryText = this._lastSummaryText ?? "";
      const summaryChars = this._lastSummaryChars ?? null;
      const modelText = this._lastSummaryModelText ?? "";
      this._lastSummaryChars = undefined;
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

/** resolveChess 的键序（与 A2-4 之前逐键同序；`onLedgerBudget` 是 engine 的注入位，不进 SCHEMA）。 */
const RESOLVE_ORDER = [
  "summaryMode", "thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "retainTokens",
  "summarizationProvider", "summarizationModel", "maxTokens", "growthFloorTokens", "minFoldTokens",
  "hotLedger", "hotLedgerMaxTokens", "hotLedgerMarkers", "hotLedgerTraceRoot", "hotLedgerReplace",
  "onLedgerBudget", "transposition", "tier2After", "graphDir", "worldHashMaxFiles",
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
