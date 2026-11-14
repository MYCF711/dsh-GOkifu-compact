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
 * ★ AX-08（2026-11-07）补第 ⑦ 条 —— **值型事实的送达**：
 *   `config.factGuard === true` 时，`edge.valueFacts` 的**值集合**也参与「要不要注入」的判定。
 *   成功工具结果**不产生失败边**，所以上面 ③ 的判据（事件间隔 / 失败边增量 / digest）会让
 *   「一条新的 `Created file` 值」被静默挡到下一次失败为止（AX-08 卡说的「存了但没注入」）。
 *   现在：值集合变了 ⇒ 绕过限流立刻送达；值集合没变 ⇒ 仍按原判据跳过（不重复注入同值）。
 *   **guard 关掉时** `factsUnchanged` 恒真、`factDigest` 恒 `""` ⇒ ③ 的判据逐字不变。
 *
 * 错误语义：**全部吞错并返回原 decision** —— 注入失败绝不阻塞对话。
 *
 * 依赖：R00（`failureEdges`/`sha`）、R06（`renderLedger`）。
 */

import { failureEdges, sha } from "./kifu-model.mjs";
import { renderLedger, renderMinimalLedger, valueFactDigest } from "./ledger.mjs";

/** 限流：两次注入至少隔这么多事件。 */
export const INJECT_MIN_EVENTS = 40;

/** 限流：失败边至少多这么多条才允许再注入。 */
export const INJECT_MIN_FAILURE_DELTA = 5;

/**
 * ★ C600：清单**后面**还压着这么多条 surface 消息时，就地替换就不划算了 —— 改成「挂到末尾」。
 *
 * 为什么是「条数」而不是 token：这一步每回合都跑，数 token 要把整段 surface 走一遍（真机 590k
 * token 的会话上 ~15ms/步）。条数是个**廉价下界**：0 条 ⇒ 这次替换只作废它自己；>0 条 ⇒ 后面
 * 那一段全部重读。真机上这个下界几乎总是被跨过（`injectTail` 的 `3+` 桶占 100%），
 * 所以阈值取 3 只是为了让「刚注入完立刻再注入」这种短路径继续走就地替换（省一次 surface 写）。
 */
export const HOT_LEDGER_REPIN_AFTER = 3;

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
/**
 * ★ C460：把"清单后面还有几条消息"分桶。分桶而不是记原值，是为了让 doctor 一行说得完，
 * 也避免统计表被长尾撑爆（与 bumpSkipReason 同一个理由）。
 * @param {number} n
 */
export function afterTailBucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v === 1) return "1";
  if (v === 2) return "2";
  return "3+";
}

/**
 * ★ C460：surface 上这条消息**后面**还有几条消息（surface 位置 seq 更大的）。
 *
 * 用来回答医生那句话的前提：「replace 改写的是中间那条 ⇒ 从那里起前缀失配」——
 * 若它后面 0 条，那这次替换只作废它自己（与 append 的差别很小）；后面越多越贵。
 * @param {{surface?:{nodes?:number[]}}} session
 * @param {number} seq
 * @returns {number}
 */
export function countAfterSeq(session, seq) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || !Number.isFinite(seq)) return 0;
  let n = 0;
  for (const node of nodes) if (Number(node) > seq) n += 1;
  return n;
}

export function ledgerDigest(graph, { foldFailures = 0, failures = null } = {}) {
  const parts = [];
  const roots = graph.rootUserNodeIds.map((id) => graph.nodes[id]).filter(Boolean);
  for (const root of roots) {
    parts.push(root.text);
    parts.push(...(root.constraints ?? []));
  }
  // ★ C565：**复用调用方已经数过的失败边列表**。这一步每步都跑，而 `failureEdges` 要遍历全图。
  //   以前 `decideInjection` 里一共数了**三次**（zeroFailure / 限流判据 / digest）。
  const list = Array.isArray(failures) ? failures : failureEdges(graph);
  for (const e of list) {
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
export function pressureHintLine(pressure) {
  // ★ C663：可以传数字（旧形状，只有百分比），也可以传
  //   `{ pct, tokens, threshold, windowTokens }`。
  //   为什么要多这几个数：**裸百分比会被读成「上下文用了 93%」**，而它真正的分母是
  //   **自动折叠阈值**（窗口的 30%/45%）。实测一例：tokens=147,656 / threshold=300,000 /
  //   window=1,000,000 ⇒ 压力 49%，实际只占窗口 15%。到了 93% 那一档，窗口占用也才 28%。
  //   给模型看一个没有分子/分母的百分比，等于制造一个它无法证伪的错觉（本项目自己的铁律：
  //   没有定义式 + 分子 + 分母 + 时点的数字不可引用）。所以能带就带全。
  const obj = pressure !== null && typeof pressure === "object" ? pressure : { pct: pressure };
  const pct = Number(obj.pct);
  if (!Number.isFinite(pct) || pct < 80) return "";
  // ★ C336：**别提示做不到的动作**。第一版写的是"想现在压就调 manual compact"，
  //   但本插件**没有**给模型的手动压缩工具 —— 压缩是自动触发的，`/compact` 是**用户**的命令。
  //   让模型去调一个不存在的工具 = 制造幻觉动作。这里只**告知状态**。
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(Math.round(n));
  };
  const tokens = num(obj.tokens);
  const threshold = num(obj.threshold);
  const windowTokens = num(obj.windowTokens);
  const detail = tokens !== "" && threshold !== ""
    ? `（${tokens} / ${threshold} tokens 到折叠阈值${windowTokens !== "" ? `；窗口 ${windowTokens}，实际占用 ${Math.round((Number(obj.tokens) / Number(obj.windowTokens)) * 100)}%` : ""}）`
    : "";
  return `# 压力 ${Math.round(pct)}%${detail} —— 接近自动折叠阈值（会自动触发，无需动作）`;
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
 * v1.5.0 之前每个会话都**追加**清单、从不替换 —— 实测 session-example 的 surface 上
 * 还压着 44 条 / 295,255 字符 ≈ 9.8 万 token。surface 只支持 append/replace（不能删除节点），
 * 所以逐条**替换成一行占位**：内容已经过时（最新那条清单覆盖了同样的信息，全量轨迹在 graph.json），
 * 留着只是白占上下文。
 *
 * 幂等：占位本身很短（< 200 字符），下一次进来直接跳过。
 * @param {object} session
 * @param {{createUserMessage: Function, keep?: number}} args
 *   `keep` = 尾部保留几条**真清单**（默认 1；C600 的重挂路径传 0 —— 那一刻新清单正要写进去，
 *   旧的一条都不该留，否则每注入一次 surface 上就多一条 466 token 的真清单）。
 * @returns {number} 本次替换掉的条数
 */
export function elideLegacyLedgers(session, { createUserMessage, keep = 1 } = {}) {
  const nodes = session?.surface?.nodes ?? [];
  const seqs = [];
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "user/message" && event.data?.source?.kind === "chess-context") seqs.push(seq);
  }
  const keepCount = Math.max(0, Math.trunc(Number(keep)) || 0);
  if (seqs.length <= keepCount) return 0; // 没有「多余的」清单（正常形态）
  const keepFrom = seqs.length - keepCount;
  let elided = 0;
  for (let i = 0; i < keepFrom; i += 1) {
    const seq = seqs[i];
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
    // ★ C564：**只数一次失败边**。这一步每步都跑，而 `failureEdges` 要遍历全图边（0.8ms 于 6,010 边）。
    //   以前这里一次、下面限流判据再一次 —— 同一份数据数两遍。
    const failureList = failureEdges(graph);
    const failureCount = failureList.length;
    const zeroFailure = failureCount === 0 && warning === "";
    if (zeroFailure && !hasLedgerState(graph)) return { decision, action: "skip", reason: "no-ledger" };

    // ★ AX-08：**值型事实也要能送达**（「存了但没注入」的根因就在这一层）。
    //   既有判据全是「失败边」口径：事件间隔 + 失败边增量 + digest。而成功工具结果**不产生失败边** ——
    //   一条新的 `Created file` / API `id` 值在旧判据下会被 `throttled-events` / `throttled-failures`
    //   挡到下一次失败出现为止，成功的值于是永远进不了下一步的热清单。
    //   做法：guard 开启时额外算一份**值事实 digest**（guard 关掉 ⇒ `""` 且 `factsUnchanged` 恒真，
    //   旧判据一个字节都不动）；值变了就当成「有新的必须送达的信息」，绕过限流立刻注入；
    //   值没变则继续按原判据跳过（**不重复注入同值**）。
    const factGuardOn = config?.factGuard === true;
    const factDigest = factGuardOn ? valueFactDigest(graph) : "";
    const factsUnchanged = !factGuardOn || (state.lastLedgerFactDigest ?? "") === factDigest;
    // ★ C563：**先判"这次到底要不要写"，再渲染**。渲染是这条路上最贵的一步
    //   （真机最大会话 142.4ms → 优化后 ~25ms/次），而实测 3,418 步里只写了 28 次（1%）。
    //   以前是先渲染再限流 ⇒ **99% 的渲染白做**。这里把限流判据提前（它们不需要渲染文本），
    //   只保留"内容一字不差"这一条必须在渲染后判。
    const failureCountEarly = failureCount;
    const existingEarly = findLedgerNode(session);
    const digestEarly = ledgerDigest(graph, { foldFailures: state.foldFailures ?? 0, failures: failureList });
    const lostToFoldEarly =
      existingEarly === null && state.lastLedgerDigest === digestEarly && state.lastLedgerFailureCount !== undefined;
    // 清单还在、且 digest 与上次注入相同 ⇒ 内容没变（digest 只由根目标/约束/失败数决定）。
    // 这条必须在限流之前判，否则"内容没变"会被报成 "throttled-events"（语义没变，但原因变了）。
    if (existingEarly && warning === "" && state.lastLedgerDigest === digestEarly && factsUnchanged) {
      return { decision, action: "skip", reason: "identical" };
    }
    if (!lostToFoldEarly && warning === "" && factsUnchanged) {
      const minEventsEarly = (() => {
        const raw = Number(config?.hotLedgerMinEvents);
        return Number.isFinite(raw) && raw >= 1 ? Math.min(500, Math.trunc(raw)) : INJECT_MIN_EVENTS;
      })();
      const minFailureDeltaEarly = (() => {
        const raw = Number(config?.hotLedgerMinFailureDelta);
        return Number.isFinite(raw) && raw >= 0 ? Math.min(50, Math.trunc(raw)) : INJECT_MIN_FAILURE_DELTA;
      })();
      const eventsShort =
        typeof state.lastLedgerInjectSeq === "number" && session.seq - state.lastLedgerInjectSeq < minEventsEarly;
      const failuresShort =
        typeof state.lastLedgerFailureCount === "number" && failureCountEarly < state.lastLedgerFailureCount + minFailureDeltaEarly;
      if (eventsShort) return { decision, action: "skip", reason: "throttled-events" };
      if (failuresShort) return { decision, action: "skip", reason: "throttled-failures" };
    }

    const ledger = zeroFailure
      ? renderMinimalLedger(graph, { maxTokens: config.hotLedgerMaxTokens ?? 500, factGuard: factGuardOn })
      : renderLedger(graph, {
          maxTokens: config.hotLedgerMaxTokens ?? 500,
          markers: config.hotLedgerMarkers,
          treeDir: sessionDir,
          traceRoot: config.hotLedgerTraceRoot,
          // ★ AX-08：只有 guard 开启时值事实才进清单（关掉 ⇒ 渲染逐字不变）
          factGuard: factGuardOn,
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
    if (existing && messageText(existing.message) === ledgerText) {
      // ★ AX-08：值集合可能变了、但渲染出来的那几条一模一样（例如新值落在省略计数里）——
      //   记下 digest，别让「值变了」每步都重渲染一次；省略行本身的数字一变，上面那条就不成立了。
      state.lastLedgerFactDigest = factDigest;
      return { decision, action: "skip", reason: "identical" };
    }

    // 限流（与旧版一致：两次注入至少隔 40 个事件、失败边至少多 5 条）
    // 唯一例外：清单被 fold 压掉了（surface 上没有它）却又和上次同源 ⇒ 必须补回来。
    const lostToFold = existing === null && state.lastLedgerDigest === digest && state.lastLedgerFailureCount !== undefined;
    // 告警不走限流：它出现的那一刻就是必须被看见的那一刻。
    // ★ AX-08：值事实变了同样不走限流 —— 成功工具结果不产生失败边，按失败边口径永远等不到。
    if (!lostToFold && warning === "" && factsUnchanged) {
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
    //   文档：docs/knowledge/上下文缓存-单元语义-deepseek.md
    //
    // ★ C600（2026-11-05）：**上面那条「我们改的是尾部」被真机账单证伪了。**
    //   `surfaceOp: replace` 保留的是**旧槽位**，而旧槽位是**第一次注入时**的位置 —— 会话越长它越靠前，
    //   于是每次替换都把「它后面」的整段前缀作废。673 个会话 / 100,128 次请求实测
    //   （`scripts/cache-friendliness-audit.mjs`）：
    //     · replace 请求命中 **10.2%**，none 请求 **97.6%**；每次 replace 中位重读 **281,923** token；
    //     · 孤立 replace 的事件研究：前一次 **100%** → 这一次 **15.5%** → 后一次 **100%**（543 组）；
    //     · 拆账：新清单自己只 ≈466 token（**0.1%**），剩下 **99.9%** 是「清单后面整段被平移重读」。
    //   ⇒ 判据（**必要 vs 实现问题**）：
    //     · 清单内容确实变了（digest 变了 100%）⇒ 必须**送达**，这部分是必要的；
    //     · 但「必须送达」不等于「必须就地改写早期槽位」。送达方式是可选的，而就地改写让
    //       466 token 的信息变化赔上 281,923 token 的前缀重读 —— **那是实现，不是内容**。
    //   ⇒ 做法：清单**后面还压着消息**时不再就地改写，改成「新清单挂到末尾 + 上一条换成占位」。
    //     新清单仍是完整渲染（语义一条不少），surface 上仍只有一条真清单；差别只在**分叉点**：
    //     从「第一次注入的槽位」挪到「上一条清单的位置」—— 只差一个注入间隔。
    //     真机 append 组的中位 miss 是 1,991 token，比替换小两个数量级。
    const afterTailEarly = existing === null ? 0 : countAfterSeq(session, existing.seq);
    const repin = existing !== null && afterTailEarly > HOT_LEDGER_REPIN_AFTER;

    // ★ C360：**追加前先收缩历史**。`findLedgerNode` 只认**最后一条**清单，
    //   所以当它返回 null（清单被 fold 压掉、或上一版是旧格式）时，旧清单会一直留在 surface 上 ——
    //   实测一个会话残留 17 份真清单（修正口径后），而清理只在会话开头跑一次（`legacyElided`）。
    //   ⇒ 走到"追加"这条路时，顺手把更早的清单换成占位（保留最后一条），让常驻份数收敛到 1~2。
    //   ★ C600：**重挂路径要 keep:0** —— 此刻最后一条马上就会被新清单取代（下面 return 的 decision
    //     会被宿主落盘），留它一条就等于每注入一次多背 466 token 的过期清单。
    if (config.hotLedgerReplace && (existing === null || repin)) {
      try {
        elideLegacyLedgers(session, { createUserMessage, keep: repin ? 0 : 1 });
      } catch {
        /* 清理失败不影响本次注入 */
      }
    }

    if (existing && config.hotLedgerReplace && !repin) {
      try {
        session.append("user/message", message, {
          surfaceOp: { op: "replace", startSeq: existing.seq, endSeq: existing.seq },
          sourceEventSeqs: [existing.seq],
        });
        state.lastLedgerDigest = digest;
        state.lastLedgerInjectSeq = session.seq;
        state.lastLedgerFailureCount = ledger.failureCount;
        // ★ AX-08：记住这次送达的值事实 —— 下一次同样的值就回到「identical / same-digest」跳过
        //   （**不重复注入同值**）。guard 关掉时这里恒是 `""`，状态形状不新增语义。
        state.lastLedgerFactDigest = factDigest;
        log("debug", `chess-context: 替换失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens（surface 仍只有一条）`);
        // ★ C460：**这次替换到底作废了多少缓存**，取决于清单后面还有几条消息。
        //   doctor 一直说"replace = 改写 surface 中间那条 ⇒ 从那里起前缀失配"，但没说"中间"是哪儿。
        //   真机（C600，100,128 次请求）**100% 的替换都在 `3+` 桶** —— 清单从来不是最后一条。
        //   所以 `afterTail` 必须继续记：它是「就地替换划不划算」的唯一判据（见 HOT_LEDGER_REPIN_AFTER）。
        //   ★ C600：用**写之前**的 `afterTailEarly` —— 写完之后旧 seq 已经不在 surface 上，
        //     再数会把刚写进去的这条算进去（少报 1，判据就飘了）。
        return { decision, action: "replace", reason: "replaced", afterTail: afterTailEarly };
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
    state.lastLedgerFactDigest = factDigest;
    log(
      "debug",
      `chess-context: 注入失败清单 ${ledger.failureCount} 条 / ~${ledger.tokens} tokens` +
        (repin ? `（清单漂离尾部 ${afterTailEarly} 条 ⇒ 重挂到末尾，旧清单换占位）` : ""),
    );
    return { decision: { ...decision, messages: entered }, action: "append", reason: repin ? "repinned" : "appended" };
  } catch (error) {
    log("warn", `chess-context: 失败清单注入失败（继续本轮）：${String(error)}`);
    return { decision, action: "skip", reason: `error:${String(error?.message ?? error)}` };
  }
}