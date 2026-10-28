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
  renderIndexMd,
  renderNodeMd,
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

/** 热清单标记档位（ledger.mjs 的 `markers` 选项）。 */
const MARKER_MODES = new Set(["semantic", "terse", "off"]);

export const name = "dsh-gokifu-compact";

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
  hotLedgerMarkers: z.string().default("semantic").description("失败边标记档位：semantic=带语义（blocked:permission）+动态图例；terse=只写三态；off=不打标记"),
  hotLedgerReplace: z.boolean().default(true).description("热清单就地替换 surface 上的旧节点（surface 永远只有一条）；false=退回追加（长会话会累积）"),
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
    /** 三层文件树已写过的会话（2000 边时 4000 文件会卡事件循环，只首次与 fold 后写） */
    this.treeWritten = new Set();
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
      legacyElided: false,
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

  #flush(session, { tree = false } = {}) {
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
      // 三层文件树（v1.2.0）：index.md + nodes/*.md + raw/*.md
      // 只在「首次」和「fold 后」写 —— 2000 边时 4000 个文件会卡住事件循环；
      // 中间状态的 flush 只写 graph.json（下次 fold 会整体刷新树）。
      const firstWrite = !this.treeWritten.has(session.id);
      if (tree || firstWrite) {
        this.treeWritten.add(session.id);
        const nodesDir = nodePath.join(dir, "nodes");
        nodeFs.mkdirSync(nodesDir, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(dir, "index.md"), renderIndexMd(g), "utf8");
        // 写**所有**节点（g.nodes），不只是 g.order —— 被合并且仍被边引用的节点也要有文件
        for (const id of Object.keys(g.nodes)) {
          const n = g.nodes[id];
          if (!n) continue;
          nodeFs.writeFileSync(nodePath.join(nodesDir, `${id}.md`), renderNodeMd(g, id), "utf8");
        }
        // raw/ 不写：节点 JSON 与 graph.json 完全重复（190 文件 / 417KB 浪费）。
        // 真正的「原始记录」应该是事件原文，等以后从 session 日志接。
      }
      // graph.md 不再自动写（177KB/次是纯 IO 浪费；三层文件树已是人读视图）
      // 需要时：node test/build-md.mjs <sessionDir>

      // ★ JSON 最后写（原子 rename = 提交点）：md 先就绪，读者以 graph.json 的 updatedAt 为准
      nodeFs.writeFileSync(tmp, toJSON(g), "utf8");
      nodeFs.renameSync(tmp, this.#graphPath(session));
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
        const st = this.#runtimeFor(session);
        // ★ 历史包袱清理（P1-4 配套，一次性）：旧版在每个会话里追加了几十条~上百条清单，
        //   它们不能被「删除」（surface 只有 append/replace），但可以逐条替换成一行占位。
        //   实测 session-5acafe42 的 surface 上还压着 **44 条 / 295,255 字符 ≈ 9.8 万 token** 的旧清单。
        //   只保留最后一条（当前清单），其余换成占位；每条只做一次（stub < 200 字符 ⇒ 下次跳过）。
        if (this.chess.hotLedgerReplace && !st.legacyElided) {
          st.legacyElided = true;
          const n = elideLegacyLedgers(session);
          if (n > 0) ctx.logger?.info?.(`chess-context: 清理历史清单 ${n} 条（换成一行占位，surface 不再背旧账）`);
        }
        const g = this.#graph(session);
        if (failureEdges(g).length === 0) return decision;
        const ledger = renderLedger(g, { maxTokens: this.chess.hotLedgerMaxTokens, markers: this.chess.hotLedgerMarkers });
        if (!ledger.text || ledger.tokens === 0) return decision;
        // digest 只算「骨架」：失败边集合 + 根目标 + 约束。
        // 不含 CURRENT PATH / CURRENT GOAL —— 它们每步都变，会让清单每步重注入一次（实测 6 条/轮）。
        const digest = ledgerDigest(g);
        // ★ P1-4 彻底修法（2026-10-29）：surface 上**只留一条**热清单。
        //   旧版每次都**追加**一条新 user 消息、旧的不替换 —— 实测真实会话累积 131 条 / 508,308 字符
        //   （约 20 万 token）：一个压缩插件自己的热上下文成了最大的上下文消费者。
        //   现在：找到当前 surface 上最后一条 chess-context 节点，用 DSH 官方的
        //   `surfaceOp: {op:"replace", startSeq, endSeq}` 就地替换（官方 system-prompt / tool-result-pruner
        //   用的就是这个机制，真实包上的行为见 test/real-ledger-replace.mjs）。
        const existing = currentLedgerNode(session);
        // 内容一字不差：不动（既不写日志，也不碰 surface 的 contentGeneration）
        if (existing && messageTextOf(existing.message) === ledger.text) return decision;

        // 限流（与旧版一致：两次注入至少隔 40 个事件、失败边至少多 5 条）——
        // 替换不占额外 prompt，但会写一条日志事件并推进 surface 的 contentGeneration，
        // 所以节奏保持原样，只把「累积」这一条去掉。
        // 唯一例外：清单被 fold 压掉了（surface 上没有它）却又和上次同源 ⇒ 必须补回来。
        const lostToFold = existing === null && st.lastLedgerDigest === digest && st.lastLedgerFailureCount !== undefined;
        if (!lostToFold) {
          if (typeof st.lastLedgerInjectSeq === "number" && session.seq - st.lastLedgerInjectSeq < 40) return decision;
          if (typeof st.lastLedgerFailureCount === "number" && ledger.failureCount < st.lastLedgerFailureCount + 5) return decision;
          if (st.lastLedgerDigest === digest && existing) return decision;
        }

        const message = createUserMessage({
          content: [{ type: "text", text: ledger.text }],
          source: { kind: "chess-context", form: "ledger", digest },
        });

        if (existing && this.chess.hotLedgerReplace) {
          try {
            session.append("user/message", message, {
              surfaceOp: { op: "replace", startSeq: existing.seq, endSeq: existing.seq },
              sourceEventSeqs: [existing.seq],
            });
            st.lastLedgerDigest = digest;
            st.lastLedgerInjectSeq = session.seq;
            st.lastLedgerFailureCount = ledger.failureCount;
            ctx.logger?.debug?.(
              `chess-context: 替换失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens（surface 仍只有一条）`,
            );
            return decision; // 不进 decision.messages：surface 已经是新的，本轮的 deriveMessages 会带上它
          } catch (error) {
            // 锚点失效（例如刚好被 fold 遮蔽）→ 退回追加路径，绝不因为这里失败而丢信息
            ctx.logger?.warn?.(`chess-context: 失败清单替换失败，退回追加：${String(error)}`);
          }
        }

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
    //   摘要模型不可用**不该让整条压缩链失败**：退回「当前路由的模型」再试一次。
    let used = target;
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
    hotLedgerMarkers: MARKER_MODES.has(c.hotLedgerMarkers) ? c.hotLedgerMarkers : "semantic",
    hotLedgerReplace: c.hotLedgerReplace !== false,
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

/**
 * 当前 surface 上最后一条热清单节点（P1-4）。
 * 返回 `{ seq, message }` —— `seq` 是替换时要用锚点（必须**是当前 surface 节点**，
 * 真实 Session 对「替换已被遮蔽的 seq」会直接抛错，见 test/real-ledger-replace.mjs）。
 */
function currentLedgerNode(session) {
  const nodes = session.surface?.nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = session.eventAt(nodes[i]);
    if (event?.type !== "user/message") continue;
    if (event.data?.source?.kind === "chess-context") return { seq: nodes[i], message: event.data };
  }
  return null;
}

/** 消息的纯文本（用于「内容一字不差就不动」的判定）。 */
function messageTextOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

/**
 * 清理历史遗留的热清单（P1-4 配套，一次性 pass）。
 *
 * v1.5.0 之前每个会话都**追加**清单、从不替换 —— 实测 session-5acafe42 的 surface 上
 * 还压着 44 条 / 295,255 字符 ≈ 9.8 万 token。surface 只支持 append/replace（不能删除节点），
 * 所以逐条**替换成一行占位**：内容已经过时（最新那条清单覆盖了同样的信息，全量轨迹在 graph.json），
 * 留着只是白占上下文。
 *
 * 幂等：占位本身很短（< 200 字符），下一次进来直接跳过。
 * @returns {number} 本次替换掉的条数
 */
function elideLegacyLedgers(session) {
  const nodes = session.surface?.nodes ?? [];
  const seqs = [];
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "user/message" && event.data?.source?.kind === "chess-context") seqs.push(seq);
  }
  if (seqs.length <= 1) return 0; // 只有一条（正常形态）
  const keep = seqs[seqs.length - 1];
  let elided = 0;
  for (const seq of seqs) {
    if (seq === keep) continue;
    const event = session.eventAt(seq);
    if (typeof event?.data?.content === "string") continue;
    if (!Array.isArray(event?.data?.content)) continue;
    if (messageTextOf(event.data).length <= 200) continue; // 已经是占位
    const stub = createUserMessage({
      content: [
        {
          type: "text",
          text: "[stale chess-ledger elided — superseded by the latest <chess-ledger>; full trace in graph.json]",
        },
      ],
      source: { kind: "chess-context", form: "ledger-stub" },
    });
    try {
      session.append("user/message", stub, {
        surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      elided += 1;
    } catch {
      /* 该节点已不在 surface 上（并发 fold）—— 跳过即可 */
    }
  }
  return elided;
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
