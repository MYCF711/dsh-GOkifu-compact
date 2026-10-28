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

import {
  createGraph,
  addAgentNode,
  fromJSON,
  toJSON,
  renderMd,
  sha,
  hashSet,
  validate,
  mergeNodeInto,
  failureEdges,
} from "./graph.mjs";
import { observeEvent } from "./keeper.mjs";
import { createWorldTracker } from "./worldstate.mjs";
import { planFold, isCheckpointSource } from "./range.mjs";
import { renderLedger, renderFacts, renderTranspositionWarning, estimateTokens } from "./ledger.mjs";
import { buildChessInstruction, extractConstraintsBlock } from "./summary-prompt.mjs";

const BASE_KEYS = new Set([
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
]);

const SUMMARY_MODE = new Set(["hybrid", "rules", "llm"]);

export const name = "dsh-kifu-context";

export const Config = z.object({
  /* —— 与官方后端的同名键（语义一致，默认值不同） —— */
  thresholdRatio: z.number().default(0.45).description("窗口占比：压力超过 min(窗口×该值, 窗口−输出预留−余量) 才 fold"),
  headroomTokens: z.number().default(65536).description("路由输出预留之外的额外压力余量"),
  retainRatio: z.number().default(0.16).description("逐字保留的近期尾部（占 窗口−输出预留 的比例）"),
  retainTokens: z.number().description("逐字保留的近期尾部（绝对 token）；与 retainRatio 互斥"),
  summarizationProvider: z.string().default("").description("摘要模型 provider；留空=跟随最近一次路由"),
  summarizationModel: z.string().default("").description("摘要模型 model；留空=跟随最近一次路由"),
  maxTokens: z.number().default(2048).description("摘要输出上限"),
  compactionRetries: z.number().default(1),
  maxOverflowRetries: z.number().default(1),
  modelPolicies: z.array(z.any()).default([]),
  auto: z.boolean().default(true),

  /* —— 棋谱扩展 —— */
  summaryMode: z.string().default("hybrid").description("hybrid=规则事实+模型润色；rules=零模型调用；llm=完全交给模型"),
  growthFloorTokens: z.number().default(40000).description("距上次 fold 至少新增这么多 token 才再次 fold（0=关闭增长门控）"),
  minFoldTokens: z.number().default(8000).description("被遮蔽内容少于这么多 token 就不 fold（摘要本身要花钱）"),
  hotLedger: z.boolean().default(true).description("每轮注入失败清单（热上下文）"),
  hotLedgerMaxTokens: z.number().default(500).description("失败清单的 token 上限"),
  transposition: z.boolean().default(true).description("置换检测：同一状态再次到达时不新建节点"),
  tier2After: z.number().default(8).description("checkpoint 超过这么多时合并最老的两段（tier-2）"),
  graphDir: z.string().default("").description("棋谱落盘目录；留空 = <DSH_HOME>/chess-context"),
  worldHashMaxFiles: z.number().default(200).description("世界状态哈希最多 stat 多少个文件"),
});

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

function safeId(id) {
  return String(id ?? "session").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export default class ChessCompactionEngine extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];

  static Config = Config;

  constructor(ctx, config = {}) {
    super(ctx, pickBase(config));
    this.chess = resolveChess(config);
    this.graphs = new Map();
    /** debounce 写入的定时器；缺这一行会让每次「有变化」的事件都抛 TypeError（实测：落盘 debounce 完全失效）。 */
    this.flushTimers = new Map();
    this.runtime = new Map();
    if (this.chess.hotLedger) this.#bindLedger();
    this.#bindKeeper();
  }

  /* ────────────────────────── 棋谱状态 ────────────────────────── */

  #dir() {
    return this.chess.graphDir.length > 0 ? this.chess.graphDir : nodePath.join(resolveHome(), "chess-context");
  }

  #graphPath(session) {
    return nodePath.join(this.#dir(), "sessions", safeId(session.id), "graph.json");
  }

  #graph(session) {
    const key = session.id;
    let g = this.graphs.get(key);
    if (g !== undefined) return g;
    const file = this.#graphPath(session);
    try {
      g = fromJSON(nodeFs.readFileSync(file, "utf8"));
      // 恢复后把 checkpoint 位置与 fold 计数接上
    } catch {
      g = createGraph({ sessionId: key, cwd: session.cwd ?? process.cwd() });
    }
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
    st.worldHashOf = () => (st.world && typeof st.world.hash === "function" ? st.world.hash() : "pending");
    st.constraintHashOf = () => (st.constraints && typeof st.constraints.hash === "function" ? st.constraints.hash() : "pending");
    st.touchPath = (p) => { if (st.world && typeof st.world.touch === "function") st.world.touch(p); };
    this.runtime.set(key, st);
    return st;
  }

  #flush(session) {
    const g = this.#graph(session);
    const dir = nodePath.dirname(this.#graphPath(session));
    try {
      nodeFs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.#graphPath(session)}.tmp`;
      // P1-11：落盘前校验图不变量（悬空边 / 失败边没原因 / agent 缺哈希）。
      // 审查实测 live graph 155 条边里 115 条 from 悬空而无人发现 —— 校验结果至少进日志。
      const problems = validate(g);
      if (problems.length > 0) {
        this.ctx.logger?.warn?.(`chess-context: 棋谱不变量告警 ${problems.length} 条：${problems.slice(0, 3).join("; ")}`);
      }
      nodeFs.writeFileSync(tmp, toJSON(g), "utf8");
      nodeFs.renameSync(tmp, this.#graphPath(session));
      nodeFs.writeFileSync(nodePath.join(dir, "graph.md"), renderMd(g), "utf8");
    } catch (error) {
      this.ctx.logger?.warn?.(`chess-context: 棋谱落盘失败（不影响压缩）：${String(error)}`);
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
          this.#flush(agent.session, { md: true });
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
        const g = this.#graph(session);
        if (failureEdges(g).length === 0) return decision;
        const ledger = renderLedger(g, { maxTokens: this.chess.hotLedgerMaxTokens });
        if (!ledger.text || ledger.tokens === 0) return decision;
        // digest 只算「骨架」：失败边集合 + 根目标 + 约束。
        // 不含 CURRENT PATH / CURRENT GOAL —— 它们每步都变，会让清单每步重注入一次（实测 6 条/轮）。
        const digest = ledgerDigest(g);
        const st = this.#runtimeFor(session);
        // 只有当「同一份清单已经挂在当前 surface 上」时才跳过 ——
        // 只比 digest 会漏：清单可能已被上一次 fold 压掉，那时必须重新注入。
        // ★ 限流（P1-4 缓解）：失败边每变一次就注入一条新 user 消息，旧的不替换 ——
        //   真实会话已累积 131 条 / 508,308 字符（约 20 万 token）。这里强制两次注入至少隔 40 个事件
        //   （约 20 轮），把注入条数压到原来的 1/20。彻底修法（替换旧消息）见 HANDOFF P1-4。
        if (typeof st.lastLedgerInjectSeq === "number" && session.seq - st.lastLedgerInjectSeq < 40) return decision;
        // P1-4（进一步）：失败边数量增长不足 5 条时也不注入 —— 失败边是热清单的主体，
        //   只改结尾不改变信息量。真实会话的 131 次注入里绝大多数是「只多了一条死路」。
        if (typeof st.lastLedgerFailureCount === "number" && ledger.failureCount < st.lastLedgerFailureCount + 5) return decision;
        if (st.lastLedgerDigest === digest && alreadyVisible(session, digest)) return decision;
        if (alreadyVisible(session, digest)) {
          st.lastLedgerDigest = digest;
          return decision;
        }
        const message = createUserMessage({
          content: [{ type: "text", text: ledger.text }],
          source: { kind: "chess-context", form: "ledger", digest },
        });
        const lastClaimed = decision.messages.findLastIndex((m) => payload.messages.includes(m));
        const entered = decision.messages.toSpliced(Math.max(lastClaimed, 0) + 1, 0, message);
        st.lastLedgerDigest = digest;
        st.lastLedgerInjectSeq = session.seq;
        st.lastLedgerFailureCount = ledger.failureCount;
        ctx.logger?.debug?.(`chess-context: 注入失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens`);
        return { ...decision, messages: entered };
      } catch (error) {
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

    if (mode === "rules") {
      const text = ruleSummary(g, this.#activeRange());
      return { summary: [{ type: "text", text }], rawOutput: undefined, llmStreamCall: false };
    }

    const target = summarizeTarget(this.chess, session, agent);
    if (target === undefined) {
      if (mode === "hybrid") {
        const text = ruleSummary(g, this.#activeRange());
        return { summary: [{ type: "text", text }], rawOutput: undefined, llmStreamCall: false };
      }
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
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.chess.maxTokens,
      sessionId: session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish?.kind === "error" || finish?.kind === "aborted") {
      throw new LlmError(finish.failure?.message ?? "summarization failed", finish.failure?.code, finish.failure);
    }
    if (finish?.kind === "max-tokens") {
      const error = new Error("chess-context: summarization truncated at the token cap (incomplete record)");
      error.code = "MAX_TOKENS";
      throw error;
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
    return {
      summary,
      rawOutput: raw,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
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
    g.foldCount += 1;
    g.lastFoldTotalTokens = after.totalTokens;
    g.checkpointSeq = range.start;
    g.foldMarks.push({
      at: Date.now(),
      seqStart: range.start,
      seqEnd: range.end,
      shadowedTokens: range.shadowedTokens,
      totalAfter: after.totalTokens,
    });
    this.#tier2(session, g);
    this.#flush(session, { md: true });
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

function resolveChess(config) {
  const c = config ?? {};
  const mode = SUMMARY_MODE.has(c.summaryMode) ? c.summaryMode : "hybrid";
  const out = {
    summaryMode: mode,
    thresholdRatio: num(c.thresholdRatio, 0.45),
    headroomTokens: num(c.headroomTokens, 65536),
    retainRatio: num(c.retainRatio, 0.16),
    retainTokens: numberOrUndefined(c.retainTokens),
    summarizationProvider: str(c.summarizationProvider, ""),
    summarizationModel: str(c.summarizationModel, ""),
    maxTokens: num(c.maxTokens, 2048),
    growthFloorTokens: num(c.growthFloorTokens, 40000),
    minFoldTokens: num(c.minFoldTokens, 8000),
    hotLedger: c.hotLedger !== false,
    hotLedgerMaxTokens: num(c.hotLedgerMaxTokens, 500),
    transposition: c.transposition !== false,
    tier2After: num(c.tier2After, 8),
    graphDir: str(c.graphDir, ""),
    worldHashMaxFiles: num(c.worldHashMaxFiles, 200),
  };
  if (out.retainRatio >= out.thresholdRatio) out.retainRatio = Math.max(0.05, out.thresholdRatio - 0.05);
  return out;
}

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function str(value, fallback) {
  return typeof value === "string" ? value : fallback;
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

/**
 * 热上下文的「骨架摘要」：只由失败边 + 根目标 + 约束决定。
 * 不含 CURRENT PATH / CURRENT GOAL —— 它们每一步都变，用整段文本做 digest
 * 会导致每步都判定「清单变了」并重新注入（实测一轮 6 条）。
 */
function ledgerDigest(g) {
  const parts = [];
  const roots = g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean);
  for (const root of roots) {
    parts.push(root.text);
    parts.push(...(root.constraints ?? []));
  }
  for (const e of failureEdges(g)) {
    parts.push(`${e.id}:${e.verify?.kind ?? ""}:${(e.errorSnippet || e.verify?.summary || "").slice(0, 80)}`);
  }
  return sha(parts.join(String.fromCharCode(0)));
}

function alreadyVisible(session, digest) {
  const nodes = session.surface.nodes;
  for (let i = nodes.length - 1, seen = 0; i >= 0 && seen < 40; i -= 1, seen += 1) {
    const event = session.eventAt(nodes[i]);
    if (event?.type !== "user/message") continue;
    const source = event.data?.source;
    if (source?.kind === "chess-context" && source.digest === digest) return true;
  }
  return false;
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

export { estimateTokens, renderTranspositionWarning };
