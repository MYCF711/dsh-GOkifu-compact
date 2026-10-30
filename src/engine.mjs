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

import { fromJSON, toJSON, sha, hashSet, mergeNodeInto, failureEdges } from "./graph.mjs";
import { observeEvent } from "./keeper.mjs";
import { createWorldTracker } from "./worldstate.mjs";
import { planFold, isCheckpointSource } from "./range.mjs";
import { renderFacts } from "./ledger.mjs";
import { buildChessInstruction, extractConstraintsBlock } from "./summary-prompt.mjs";
import { SCHEMA, BASE_KEYS as BASE_KEY_LIST, resolveConfig } from "./rooms/config-schema.mjs";
import { createFsPort, createPersistStore, graphRoot, sessionPaths } from "./rooms/kifu-persist.mjs";
import { decideInjection } from "./rooms/hot-inject.mjs";

const BASE_KEYS = new Set(BASE_KEY_LIST);

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
export function ledgerBudgetMetrics(ledger) {
  const fallback = ledger && typeof ledger.fallback === "string" ? ledger.fallback : "未采集";
  return {
    fallback,
    level: Number.isFinite(ledger?.level) ? ledger.level : null,
    tokens: Number.isFinite(ledger?.tokens) ? ledger.tokens : null,
    budgetMax: Number.isFinite(ledger?.budgetMax) ? ledger.budgetMax : null,
    overBudgetBy: Number.isFinite(ledger?.overBudgetBy) ? ledger.overBudgetBy : 0,
  };
}

/** 预算状态对应的日志级别：impossible 必须 error，over-budget 至少 warn，其余 info。 */
export function ledgerBudgetLogLevel(metrics) {
  if (!metrics || metrics.fallback === "impossible") return "error";
  if (metrics.fallback === "over-budget") return "warn";
  return "info";
}

/** 一行可读的日志文案（含 overBudgetBy —— 验收明确要求）。 */
export function ledgerBudgetLogLine(metrics, sessionId = "") {
  const who = sessionId ? ` session=${sessionId}` : "";
  if (metrics.fallback === "over-budget") {
    return `chess-context: 热清单兜底超限（over-budget）${who} tokens=${metrics.tokens} budget=${metrics.budgetMax} overBudgetBy=${metrics.overBudgetBy} level=L${metrics.level}`;
  }
  if (metrics.fallback === "impossible") {
    return `chess-context: 热清单无解（impossible）${who} level=L${metrics.level} —— 连最省兜底都构造不出，这是 bug，不是预算问题`;
  }
  return `chess-context: 热清单预算正常（${metrics.fallback}）${who} tokens=${metrics.tokens}/${metrics.budgetMax}`;
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
    this.graphs = new Map();
    /** 三层文件树已写过的会话（2000 边时 4000 文件会卡事件循环，只首次与 fold 后写） */
    /** debounce 写入的定时器；缺这一行会让每次「有变化」的事件都抛 TypeError（实测：落盘 debounce 完全失效）。 */
    this.flushTimers = new Map();
    /** ★ P3：每会话基线 graph.json 的内容哈希（16 位）；delta 帧用它做 generation 保护。 */
    /** ★ P3：已进入 graph.json/delta 但还没写过 nodes/<id>.md 的节点（fold 时补写）。 */
    this.runtime = new Map();
    /** ★ P7：热清单预算统计（跨会话累计；doctor 从这里读）。 */
    this.ledgerBudget = { none: 0, "over-budget": 0, impossible: 0, 未采集: 0, maxOverBudgetBy: 0, updatedAt: 0, samples: 0 };
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
    this.ledgerBudget[metrics.fallback] = (this.ledgerBudget[metrics.fallback] ?? 0) + 1;
    this.ledgerBudget.samples += 1;
    this.ledgerBudget.maxOverBudgetBy = Math.max(this.ledgerBudget.maxOverBudgetBy, metrics.overBudgetBy);
    this.ledgerBudget.updatedAt = Date.now();
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
        return result.decision;
      } catch (error) {
        // 双保险：R08 已全部吞错；这里再兜一层，注入失败绝不阻塞对话。
        ctx.logger?.warn?.(`chess-context: 失败清单注入失败（继续本轮）：${String(error)}`);
        return decision;
      }
    });
  }
  /* ────────────────────────── 摘要（唯一官方钩子） ────────────────────────── */

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
    const ruleResult = () => ({
      summary: [{ type: "text", text: ruleSummary(g, this.#activeRange()) }],
      rawOutput: undefined,
      llmStreamCall: false,
      provider: routed?.provider ?? "chess-context",
      model: routed?.model ?? "rules",
    });

    if (mode === "rules") return ruleResult();

    const target = summarizeTarget(this.chess, session, agent);
    if (target === undefined) {
      if (mode === "hybrid") return ruleResult();
      throw new Error("chess-context: no provider/model available for summarization");
    }

    const priorFold = hasPriorCheckpoint(session);
    const range = this.#activeRange();
    const instruction = buildChessInstruction({
      facts: renderFacts(g, { range }),
      shadowedStart: range?.start,
      shadowedEnd: range?.end,
      priorFold,
    });

    const assembler = new BlockAssembler();
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
        const retry = new BlockAssembler();
        await runStream(routed, retry);
        used = routed;
        assembler.chunks.length = 0;
        for (const chunk of retry.chunks) assembler.push(chunk);
        assembler.finish = retry.finish;
        assembler.usage = retry.usage;
      }
    } catch (error) {
      if (mode !== "hybrid" || signal?.aborted) throw error;
      this.ctx.logger?.warn?.(
        `chess-context: 摘要模型全部不可用（${String(error?.message ?? error)}）——退回规则摘要（零模型调用），保证 fold 能落地`,
      );
      return {
        summary: [{ type: "text", text: ruleSummary(g, this.#activeRange()) }],
        rawOutput: undefined,
        llmStreamCall: false,
        provider: routed?.provider ?? "chess-context",
        model: routed?.model ?? "rules",
        degraded: "rules",
      };
    }
    const raw = assembler.blocks();
    if (contentHasImage(raw)) throw new LlmError("chess summary cannot contain image output", "UNSUPPORTED_CONTENT");
    const summary = raw.filter((block) => block.type === "text");
    if (!summary.some((block) => String(block.text ?? "").trim().length > 0)) {
      throw new Error("chess-context: summarization produced no text summary content");
    }
    // ★ 机械追加约束段：实测模型在 15 条失败边的压力下会把 3 条约束全丢（多规模测试 B 场景 0/3）。
    //   约束丢失 = 任务漂移，比失败边丢失更致命。所以约束不经过模型 —— 规则抽什么，产物里就有什么。
    const constraintsBlock = extractConstraintsBlock(renderFacts(g));
    if (constraintsBlock) {
      summary.push({ type: "text", text: `

## 约束（机械保留，逐字；不由模型改写）
${constraintsBlock.split("\n").map((l) => `- ${l}`).join("\n")}` });
    }
    // 记账：这次摘要调用了多少 token（provider 真实 usage）。#commit 会把它写进 graph.lastFoldUsage，
    // doctor / 计费对账直接读，不用再翻会话日志里的 compaction/summary 事件。
    if (assembler.usage !== undefined) {
      this._lastSummaryUsage = assembler.usage;
      this._lastSummaryProvider = used.provider;
      this._lastSummaryModel = used.model;
    }
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
    try {
      return await super.compactRegion(start, end, agent, signal);
    } finally {
      this._chessActiveRange = prev;
    }
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
      spec = resolveSpec(policy, info.context.contextWindow, reserved);
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
      this.#flush(session);
      return null;
    }

    this._chessActiveRange = { start: range.start, end: range.end };
    let result;
    try {
      result = await this.compactRegion(range.start, range.end, agent, signal);
    } catch (error) {
      // fold 真的抛错：恢复图，保证「foldCount 没变 ⇒ 图也没变」
      restore();
      st.foldFailures += 1;
      st.lastFoldError = String(error?.message ?? error).slice(0, 180);
      this.#flush(session);
      throw error;
    } finally {
      this._chessActiveRange = null;
    }
    if (result === null || result === undefined) {
      restore();
      this.#flush(session);
      return null;
    }
    const after = meter.measure(session);
    // 压缩成功 ⇒ 告警计数清零（告警是「当前有故障」，不是「历史有过故障」）
    st.foldFailures = 0;
    st.lastFoldError = "";
    g.foldCount += 1;
    g.lastFoldTotalTokens = after.totalTokens;
    // 记「checkpoint 消息的 seq」，不是被遮蔽区间的起点 —— 后者 fold 之后已不在 surface 上，
    // 任何读这个字段做判断的地方都会拿到一个不存在的 seq（2026-10-29 实机：值一直是 9）。
    g.checkpointSeq = checkpointSeqs(session).at(-1) ?? null;
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
      shadowedTokens: range.shadowedTokens,
      totalAfter: after.totalTokens,
    });
    this.#tier2(session, g);
    // ★ 2026-10-29 修复：这里原来传的是 `{ md: true }`，而 `#flush(session, { tree = false })`
    //   只认 `tree` —— 参数名不匹配 ⇒ fold 后**从不**重写 `nodes/*.md`，
    //   压缩后的节点详情停在第一次落盘的样子（Kimi 评估实测发现）。
    this.#flush(session, { tree: true });
    this.ctx.logger?.info?.(
      `chess-context: fold #${g.foldCount} 遮蔽 ${range.end - range.start >= 0 ? `${range.start}-${range.end}` : "?"} (~${range.shadowedTokens} tokens) → 总 ${after.totalTokens} tokens（死路 ${failureEdges(g).length} 条，节点 ${g.order.length}）`,
    );
    return result;
  }

  #selectRange(session, measurement, g, spec, overflow) {
    const planned = planFold({
      surfaceNodes: session.surface.nodes,
      pricedNodes: measurement.nodes,
      eventAt: (seq) => session.eventAt(seq),
      retainTokens: spec.retainTokens,
      minFoldTokens: this.chess.minFoldTokens,
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
      g.foldMarks.push({ at: Date.now(), seqStart: start, seqEnd: end, tier2: true });
      if (g.foldMarks.length > this.chess.tier2After * 2) g.foldMarks = g.foldMarks.slice(-this.chess.tier2After);
      this.#flush(session);
      this.ctx.logger?.info?.(`chess-context: tier-2 合并最老的两个 checkpoint（seq ${start}–${end}）`);
    }
    return result;
  }

  /** 记录一次常规 fold 的元数据（tier-2 由 #tier2IfNeeded 自己记）。 */
  #tier2(_session, _g) {
    /* 保留方法名以免外部调用点断裂；真正的合并在 #tier2IfNeeded。 */
  }
}

/* ────────────────────────────── 辅助 ────────────────────────────── */

/** resolveChess 的键序（与 A2-4 之前逐键同序；`onLedgerBudget` 是 engine 的注入位，不进 SCHEMA）。 */
const RESOLVE_ORDER = [
  "summaryMode", "thresholdRatio", "headroomTokens", "retainRatio", "retainTokens",
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
  return { target, thresholdRatio: chess.thresholdRatio, headroomTokens: chess.headroomTokens, retainRatio: chess.retainRatio, retainTokens: chess.retainTokens };
}

function resolveSpec(policy, contextWindow, reservedCompletionTokens) {
  const messageBudget = contextWindow - (reservedCompletionTokens ?? 0);
  if (messageBudget <= 0) throw new Error(`chess-context: ${contextWindow}-token window reserves ${reservedCompletionTokens} completion tokens; no message budget`);
  const pressureBudget = messageBudget - policy.headroomTokens;
  if (pressureBudget <= 0) {
    throw new Error(
      `chess-context: ${contextWindow}-token window reserves ${reservedCompletionTokens} + ${policy.headroomTokens} headroom; no pressure budget (lower maxTokens/headroomTokens)`,
    );
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget));
  const retainTokens = policy.retainTokens === undefined ? Math.floor(messageBudget * policy.retainRatio) : policy.retainTokens;
  if (retainTokens >= thresholdTokens) {
    throw new Error(`chess-context: retainTokens (${retainTokens}) must be less than threshold (${thresholdTokens})`);
  }
  return { thresholdTokens, retainTokens, contextWindow };
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
  lines.push("## 已探明死路（逐条保留，一条不许少）");
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
  lines.push("## 当前节点与下一步");
  const last = agents[agents.length - 1];
  lines.push(`- 当前节点：${last ? `${last.id}（状态 ${String(last.worldHash).slice(0, 8)}/${String(last.constraintHash).slice(0, 8)}）` : "(none)"}`);
  lines.push("- 下一步：按最近一条用户指令继续；不要重试“已探明死路”里的任何一条。");
  lines.push("");
  lines.push("## 原始坐标");
  lines.push(`- 本段遮蔽 seq ${range?.start ?? "?"}-${range?.end ?? "?"}；逐字原文在 DSH 会话日志中，按 seq 回读。`);
  return lines.join("\n");
}
