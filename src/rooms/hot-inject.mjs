/**
 * hot-inject —— 每步注入策略（R08，A2-3，2026-10-30）
 *
 * 职责：在 `agent/pre-step` 的 waterfall 里决定「注入 / 替换 / 跳过」，把热清单变成
 * surface 上**唯一**一条；带限流、去重、fold 失败告警、历史清单占位清理。
 *
 * 从 `src/engine.mjs` 搬出：`#bindLedger`、`foldFailureWarning`、`ledgerDigest`、
 * `currentLedgerNode`（→ `findLedgerNode`）、`messageTextOf`（→ `messageText`）、
 * `elideLegacyLedgers`。
 *
 * ★ 本房间**不 import DSH**：`createUserMessage` 与日志都由 R09 以参数注入。
 *   它只吃一个 session port：`{id, seq, surface:{nodes}, eventAt(seq), append(type,data,opts)}`。
 *
 * ★ 六条行为契约（改任何一条 = 改行为，必须单列并复核）：
 *   ① surface 只留一条（replace，不追加）；
 *   ② digest 只算骨架（失败边 + 根目标 + 约束；**不含** CURRENT PATH / CURRENT GOAL）；
 *   ③ 限流：两次注入至少隔 40 个事件、失败边至少多 5 条；
 *   ④ 内容一字不差 ⇒ 不动（不碰 contentGeneration）；
 *   ⑤ 替换锚点失效 ⇒ 退回追加，绝不丢信息；
 *   ⑥ 清单被 fold 遮蔽后同源 ⇒ **绕过限流**立刻补回。
 *
 * 错误语义：**全部吞错并返回原 decision** —— 注入失败绝不阻塞对话。
 *
 * 依赖：R00（`failureEdges`/`sha`）、R06（`renderLedger`）。
 */

import { failureEdges, sha } from "./kifu-model.mjs";
import { renderLedger, renderMinimalLedger } from "./ledger.mjs";

/** 限流：两次注入至少隔这么多事件。 */
export const INJECT_MIN_EVENTS = 40;

/** 限流：失败边至少多这么多条才允许再注入。 */
export const INJECT_MIN_FAILURE_DELTA = 5;

/** 历史清单的占位文案（**冻结**：`<200 字符` 是幂等判据；`form:"ledger-stub"` 是过滤依据）。 */
// ★ C160：占位文案**不点名内部文件名** —— 模型看到 `graph.json` 会把它当成可读路径去尝试，
//   而真相是「这条已过时、以最新那条为准」。仍然保留标签名，让模型知道被折叠的是哪类块。
export const LEDGER_STUB_TEXT = "[stale chess-ledger elided — superseded by the latest <chess-ledger>; the plugin keeps the full trace]";

/** 消息的纯文本（用于「内容一字不差就不动」的判定）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * ★ OPT-EMPTY（task-130）：这张图有没有「值得注入」的最小状态？
 * 空图（连 root / agent / constraints 都没有）⇒ 仍然 skip，不拿一行空壳占位。
 */
export function hasLedgerState(graph) {
  const nodes = graph?.nodes ?? {};
  if ((graph?.rootUserNodeIds ?? []).some((id) => nodes[id])) return true;
  if (Object.values(nodes).some((n) => n?.kind === "agent" && (n.goal || n.worldHash))) return true;
  return Object.values(nodes).some((n) => (n.constraints ?? []).length > 0);
}

/**
 * 热上下文的「骨架摘要」：只由失败边 + 根目标 + 约束决定。
 * 不含 CURRENT PATH / CURRENT GOAL —— 它们每一步都变，用整段文本做 digest
 * 会导致每步都判定「清单变了」并重新注入（实测一轮 6 条）。
 *
 * `foldFailures > 0` 时追加 `|fold-fail-N` 后缀（告警出现时必须绕过「同 digest」判据）。
 */
export function ledgerDigest(graph, { foldFailures = 0 } = {}) {
  const parts = [];
  const roots = graph.rootUserNodeIds.map((id) => graph.nodes[id]).filter(Boolean);
  for (const root of roots) {
    parts.push(root.text);
    parts.push(...(root.constraints ?? []));
  }
  for (const e of failureEdges(graph)) {
    parts.push(`${e.id}:${e.verify?.kind ?? ""}:${(e.errorSnippet || e.verify?.summary || "").slice(0, 80)}`);
  }
  const base = sha(parts.join(String.fromCharCode(0)));
  return foldFailures > 0 ? `${base}|fold-fail-${foldFailures}` : base;
}

/**
 * 热清单里的「压缩失效」告警行。
 * 只有当前确实连续失败时才出现（成功一次就清零）—— 它是状态，不是历史账本。
 */
/**
 * ★ C335：压力提示行（≥80% 才有，否则空串）。抽成纯函数是为了**能单测格式**，
 * 不用造一个完整的注入夹具。
 * @param {number|null} pressurePct
 * @returns {string}
 */
export function pressureHintLine(pressurePct) {
  const pct = Number(pressurePct);
  if (!Number.isFinite(pct) || pct < 80) return "";
  return `# 压力 ${Math.round(pct)}% —— 想现在压就调 manual compact`;
}

export function foldFailureWarning(state) {
  if (typeof state?.foldFailures !== "number" || state.foldFailures <= 0) return "";
  const err = String(state.lastFoldError ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
  // ★ 边界（2026-11-01，见 docs/压缩的职责边界.md）：只报**压缩自身的状态**（失败了几次、错误原文、
  //   上下文没被压小），不指导主 agent 该怎么做。旧版末尾还有一句
  //   "Tell the user once, then continue; do not retry the failing summarizer yourself." ——
  //   那是行为指导，属于 AGENTS / persona；「告诉用户」是宿主 UI 的职责，压缩不该借模型之口转述。
  return (
    `⚠ CONTEXT COMPRESSION IS FAILING (${state.foldFailures} consecutive folds failed${err ? `; last error: ${err}` : ""}). ` +
    "The conversation above was NOT compacted — context keeps growing and will keep costing more."
  );
}

/**
 * 当前 surface 上最后一条热清单节点（P1-4）。
 * 返回 `{ seq, message }` —— `seq` 是替换锚点（必须**是当前 surface 节点**，
 * 真实 Session 对「替换已被遮蔽的 seq」会直接抛错，见 test/real-ledger-replace.mjs）。
 */
export function findLedgerNode(session) {
  const nodes = session?.surface?.nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = session.eventAt(nodes[i]);
    if (event?.type !== "user/message") continue;
    if (event.data?.source?.kind === "chess-context") return { seq: nodes[i], message: event.data };
  }
  return null;
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
export function elideLegacyLedgers(session, { createUserMessage }) {
  const nodes = session?.surface?.nodes ?? [];
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
    if (messageText(event.data).length <= 200) continue; // 已经是占位
    const stub = createUserMessage({
      content: [{ type: "text", text: LEDGER_STUB_TEXT }],
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

/**
 * 决定这一轮要不要注入/替换热清单。
 *
 * @param {object} args
 * @param {object} args.session           session port（只读 id/seq/surface/eventAt，写只经 append）
 * @param {object} args.graph             当前图（R00）
 * @param {object} args.state             运行态（读 foldFailures/lastFoldError/legacyElided + 三个 lastLedger*）
 * @param {object} args.config            配置（hotLedgerMaxTokens/hotLedgerMarkers/hotLedgerTraceRoot/hotLedgerReplace）
 * @param {string} args.sessionDir        三层树目录（TRACE 行用）
 * @param {object} args.decision          waterfall 当前的 decision（必须 kind==="enter"）
 * @param {Array}  args.payloadMessages   本轮 claims 的原始消息（用于定位插入点）
 * @param {Function} args.createUserMessage  R09 注入（不 import DSH）
 * @param {Function} [args.onBudget]      (ledger, session) => void（P7 预算消费，归 R09）
 * @param {Function} [args.onLog]         (level, line) => void
 * @returns {{decision: object, action: "replace"|"append"|"skip", reason: string}}
 */
export function decideInjection({
  session,
  graph,
  state,
  config = {},
  sessionDir = "",
  decision,
  payloadMessages = [],
  createUserMessage,
  onBudget = () => {},
  onLog = () => {},
  // ★ C335：上下文压力百分比（0–100）。≥80 时在清单前加**一行**提示 ——
  //   启发来自 Focus 论文（agent 自主决定何时整理上下文）：把"要不要提前压"从不可见变成可决策。
  //   默认 null ⇒ 一行都不加，既有渲染与预算**零变化**（这也是不改 renderLedger 的原因）。
  pressurePct = null,
}) {
  const log = (level, line) => {
    try {
      onLog(level, line);
    } catch {
      /* 日志实现坏掉不许影响注入 */
    }
  };
  try {
    // ★ 历史包袱清理（P1-4 配套，一次性）：旧版每个会话追加几十~上百条清单，逐条换成占位。
    if (config.hotLedgerReplace && !state.legacyElided) {
      state.legacyElided = true;
      const n = elideLegacyLedgers(session, { createUserMessage });
      if (n > 0) log("info", `chess-context: 清理历史清单 ${n} 条（换成一行占位，surface 不再背旧账）`);
    }

    // ★ 2026-10-29（三份评估共同的 P0-2）：压缩「连续失败」必须被看见。
    //   一条失败边都没有时也要注入 —— 「没有失败边 + 压缩坏了」才是最危险的组合。
    const warning = foldFailureWarning(state);
    // ★ OPT-EMPTY（task-130）：零失败边 **不再整段跳过** —— 26% 的真实会话没有任何失败边，
    //   旧逻辑让它们连根目标/约束都拿不到。现在仍然走 renderLedger（零失败时它输出
    //   ROOT / CONSTRAINTS / CURRENT GOAL / WORKING + 一行 NO_FAILED_ATTEMPTS_YET）；
    //   只有**空图**（无 root / 无 agent / 无约束）才 skip。
    //   限流与 digest 全部沿用既有规则：digest = 根目标 + 约束（零失败时天然稳定），
    //   同源且清单还在 ⇒ same-digest skip；被 fold 遮蔽 ⇒ lostToFold 补回。
    const zeroFailure = failureEdges(graph).length === 0 && warning === "";
    if (zeroFailure && !hasLedgerState(graph)) return { decision, action: "skip", reason: "no-ledger" };

    const ledger = zeroFailure
      ? renderMinimalLedger(graph, { maxTokens: config.hotLedgerMaxTokens ?? 500 })
      : renderLedger(graph, {
          maxTokens: config.hotLedgerMaxTokens ?? 500,
          markers: config.hotLedgerMarkers,
          treeDir: sessionDir,
          traceRoot: config.hotLedgerTraceRoot,
        });
    // ★ P7：消费 fallback（over-budget 记 warn + overBudgetBy；impossible 记 error），并落盘给 doctor。
    try {
      onBudget(ledger, session);
    } catch {
      /* 预算统计失败不许影响注入 */
    }

    // ★ C335：压力 ≥80% 时加一行（约 20 token）。**不加**到 renderLedger 里，是为了让默认路径
    //   （没有压力信息 / 压力不高）一个字符都不变 —— 既有的 token 预算断言全部不受影响。
    const pressureLine = pressureHintLine(pressurePct);
    const head = [warning, pressureLine].filter((line) => line !== "").join("\n");
    const ledgerText = head === "" ? ledger.text : `${head}\n${ledger.text}`;
    if (!ledgerText) return { decision, action: "skip", reason: "empty" };

    const digest = ledgerDigest(graph, { foldFailures: state.foldFailures ?? 0 });
    const existing = findLedgerNode(session);
    // 内容一字不差：不动（既不写日志，也不碰 surface 的 contentGeneration）
    if (existing && messageText(existing.message) === ledgerText) return { decision, action: "skip", reason: "identical" };

    // 限流（与旧版一致：两次注入至少隔 40 个事件、失败边至少多 5 条）
    // 唯一例外：清单被 fold 压掉了（surface 上没有它）却又和上次同源 ⇒ 必须补回来。
    const lostToFold = existing === null && state.lastLedgerDigest === digest && state.lastLedgerFailureCount !== undefined;
    // 告警不走限流：它出现的那一刻就是必须被看见的那一刻。
    if (!lostToFold && warning === "") {
      // ★ C248：间隔可配（默认 40 = 旧行为）。见 config-schema 里 `hotLedgerMinEvents` 的说明。
      const minEvents = (() => {
        const raw = Number(config?.hotLedgerMinEvents);
        return Number.isFinite(raw) && raw >= 1 ? Math.min(500, Math.trunc(raw)) : INJECT_MIN_EVENTS;
      })();
      if (typeof state.lastLedgerInjectSeq === "number" && session.seq - state.lastLedgerInjectSeq < minEvents) {
        return { decision, action: "skip", reason: "throttled-events" };
      }
      // ★ C251：**失败边增量门槛也可配**（默认 5 = 旧行为）。
      //   实测这个门槛才是主要拦截者（`throttled-failures=2514` vs `throttled-events=109`）：
      //   「失败边没多 5 条就不刷新」= 位置/目标变了也不刷新。设成 **0** 就是"只按事件间隔节流"。
      const minFailureDelta = (() => {
        const raw = Number(config?.hotLedgerMinFailureDelta);
        return Number.isFinite(raw) && raw >= 0 ? Math.min(50, Math.trunc(raw)) : INJECT_MIN_FAILURE_DELTA;
      })();
      if (typeof state.lastLedgerFailureCount === "number" && ledger.failureCount < state.lastLedgerFailureCount + minFailureDelta) {
        return { decision, action: "skip", reason: "throttled-failures" };
      }
      if (state.lastLedgerDigest === digest && existing) return { decision, action: "skip", reason: "same-digest" };
    }

    const message = createUserMessage({
      content: [{ type: "text", text: ledgerText }],
      source: { kind: "chess-context", form: "ledger", digest },
    });

    // ★ C268（依据 DeepSeek KV 缓存文档，2026-11-02 抓取）：
    //   缓存命中要求**完整匹配某个已落盘的「缓存前缀单元」**，单元产生于「用户输入结束处」等位置
    //   （另有公共前缀检测、固定 token 间隔两种）。所以：
    //   · **改动点越靠后，作废的单元越少** —— 就地替换末尾这条清单，前缀单元照常命中；
    //   · 反过来，若在开头插一条新消息，等于把后面所有单元全部作废。
    //   这也是 C220 实测「断点只占 2.6%」的原因：我们改的是尾部。
    //   文档：docs/knowledge/上下文缓存-单元语义-deepseek.md
    if (existing && config.hotLedgerReplace) {
      try {
        session.append("user/message", message, {
          surfaceOp: { op: "replace", startSeq: existing.seq, endSeq: existing.seq },
          sourceEventSeqs: [existing.seq],
        });
        state.lastLedgerDigest = digest;
        state.lastLedgerInjectSeq = session.seq;
        state.lastLedgerFailureCount = ledger.failureCount;
        log("debug", `chess-context: 替换失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens（surface 仍只有一条）`);
        return { decision, action: "replace", reason: "replaced" };
      } catch (error) {
        // 锚点失效（例如刚好被 fold 遮蔽）→ 退回追加路径，绝不因为这里失败而丢信息
        log("warn", `chess-context: 失败清单替换失败，退回追加：${String(error)}`);
      }
    }

    const lastClaimed = decision.messages.findLastIndex((m) => payloadMessages.includes(m));
    const entered = decision.messages.toSpliced(Math.max(lastClaimed, 0) + 1, 0, message);
    state.lastLedgerDigest = digest;
    state.lastLedgerInjectSeq = session.seq;
    state.lastLedgerFailureCount = ledger.failureCount;
    log("debug", `chess-context: 注入失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens`);
    return { decision: { ...decision, messages: entered }, action: "append", reason: "appended" };
  } catch (error) {
    log("warn", `chess-context: 失败清单注入失败（继续本轮）：${String(error)}`);
    return { decision, action: "skip", reason: `error:${String(error?.message ?? error)}` };
  }
}