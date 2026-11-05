/**
 * cache-friendliness.test.mjs —— 「注入动作」必须对缓存友好（C600，2026-11-05）
 *
 * ## 这条守卫保护什么
 *
 * 真机账单（`scripts/cache-friendliness-audit.mjs`，673 个会话 / 100,128 次请求）：
 *
 * | 本轮注入动作 | 请求数 | 命中率 | 每次中位 miss |
 * |---|---|---|---|
 * | append  |   678 | 74.6% |   1,991 |
 * | replace | 1,606 | 10.2% | 281,923 |
 * | none    | 97,844 | 97.6% |    976 |
 *
 * 孤立 replace 的事件研究（前后两次都不是 replace 的那 543 组）：
 * **前一次 100% → 这一次 15.5% → 后一次 100%** —— 替换只在它自己那一发上收费，
 * 但那一发把「清单后面」的整段前缀全部作废。
 *
 * ## 所以守卫断言的是两件事
 *
 * ① **同样内容重复注入 ⇒ 第二次不许写 surface**（`skip`）。不写 = 前缀一个字节都不变
 *    ⇒ 缓存必然命中。这是「同内容」这条路径的守卫：任何把它变成 replace/append 的改动都要红。
 * ② **清单已经漂离尾部 ⇒ 第二次必须 append（挂到末尾），不是 replace（就地改写早期槽位）**。
 *    这是 C600 的修复本体：`surfaceOp: replace` 保留的是**第一次注入时**的槽位，
 *    会话越长它越靠前，于是 466 token 的信息变化赔上 281,923 token 的前缀重读。
 *
 * 反方向也要守住：**清单本来就是最后一条时仍然就地替换**（`afterTail <= 3`）——
 * 那种情况下替换只作废它自己，退回追加反而让 surface 多背一条真清单。这条同时保护
 * `test/hot-inject.test.mjs` 的契约①（surface 只留一条）。
 *
 * ★ 语义不许退化：重挂路径的清单必须是**完整渲染**（根的失败边一条不少），
 *   旧清单变成占位文案（`LEDGER_STUB_TEXT`）但内容仍在 graph 里 —— 断言见 T4。
 */

import {
  HOT_LEDGER_REPIN_AFTER,
  LEDGER_STUB_TEXT,
  decideInjection,
  elideLegacyLedgers,
  messageText,
} from "../src/rooms/hot-inject.mjs";
import { addUserNodeId, addEdge, addAgentNode, settleEdge, createGraph } from "./graph-fixtures.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";
import {
  PRICES,
  attributeRequests,
  charsToTokens,
  classifyLedgerLine,
  decomposeReplaceCost,
  eventStudy,
  firstDiff,
  gapBuckets,
  lcpChars,
  messageTextOf,
  replaceCounterfactual,
  requestCost,
  stablePrefixCeiling,
  summarizeByAction,
} from "../scripts/cache-friendliness-audit.mjs";

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

const CONFIG = { hotLedgerReplace: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerTraceRoot: "sessions", hotLedger: true };

/**
 * 假 session port。**与真 Session 的关键语义一致**：
 * `surfaceOp: "append"` ⇒ 挂到末尾；`surfaceOp: {op:"replace"}` ⇒ 就地占位（位置不动）。
 * 这正是本文件要测的那个差别 —— 用"追加"模拟真 Session 会把缓存救回来。
 */
function makeSession({ id = "s1", seq = 1000 } = {}) {
  let current = seq;
  const events = new Map();
  const nodes = [];
  const appended = [];
  const session = {
    id,
    surface: { nodes },
    get seq() {
      return current;
    },
    setSeq(v) {
      current = v;
    },
    eventAt: (s) => events.get(s),
    append(type, data, opts = {}) {
      const s = current++;
      const event = { type, seq: s, data, ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }), ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }) };
      events.set(s, event);
      appended.push({ seq: s, opts });
      if (opts.surfaceOp === undefined || opts.surfaceOp === "append") nodes.push(s);
      else if (opts.surfaceOp?.op === "replace") {
        const i = nodes.indexOf(opts.surfaceOp.startSeq);
        if (i < 0) throw new Error("harness: 锚点不在 surface 上");
        nodes.splice(i, 1, s);
      } else throw new Error("harness: 非法 surfaceOp");
      return event;
    },
    /** 直接塞一条已存在的 surface 消息（模拟历史遗留 / 普通对话）。 */
    push(data, { type = "user/message" } = {}) {
      const s = current++;
      nodes.push(s);
      events.set(s, { type, seq: s, data });
      return s;
    },
    appended,
  };
  return session;
}

function makeState(over = {}) {
  return {
    pendingEdges: new Map(),
    lastNodeId: null,
    lastUserNodeId: null,
    constraintDirty: true,
    lastAssistantText: "",
    lastStepSeq: 0,
    stepEdges: [],
    toolNameByCall: new Map(),
    touched: [],
    injected: 0,
    foldFailures: 0,
    lastFoldError: "",
    legacyElided: false,
    worldHashOf: () => "pending",
    constraintHashOf: () => "pending",
    touchPath: () => {},
    ...over,
  };
}

const userEvent = (text, seq) => ({ type: "user/message", seq, data: { id: "u", role: "user", content: [{ type: "text", text }], source: { kind: "prompt" } } });
const assistantEvent = (callId, tool, args, seq) => ({
  type: "assistant/message",
  seq,
  data: { message: { id: "a", role: "assistant", content: [{ type: "text", text: "试试" }, { type: "tool-call", id: callId, name: tool, arguments: JSON.stringify(args) }], source: { kind: "model", provider: "p", model: "m" } } },
});
const resultEvent = (callId, text, seq, isError = false) => ({
  type: "tool/result",
  seq,
  data: { message: { id: "r", role: "tool", toolCallId: callId, source: { kind: "tool", callId }, content: [{ type: "text", text }], isError } },
});

function graphWithFailure(cwd = "D:/tmp/proj") {
  const g = createGraph({ sessionId: "s1", cwd });
  const st = makeState();
  observeEvent(g, userEvent("把注入房间抽出来", 1), st);
  observeEvent(g, assistantEvent("c1", "bash", { command: "npm test" }, 2), st);
  observeEvent(g, resultEvent("c1", "boom\n[exit code: 1]", 3, true), st);
  return g;
}

function makeDecision(payloadMessages = []) {
  return { kind: "enter", messages: [...payloadMessages] };
}

/** 跑一次注入；把 decision 里那条清单消息提交进 session（等价于宿主落盘）。 */
function run(session, g, state, payload = []) {
  const createUserMessage = (args) => ({ id: "ledger", role: "user", ...args });
  const result = decideInjection({
    session,
    graph: g,
    state,
    config: CONFIG,
    sessionDir: "/tmp/sessions/s1",
    decision: makeDecision(payload),
    payloadMessages: payload,
    createUserMessage,
  });
  const message = result.decision.messages.find((m) => m.source?.kind === "chess-context");
  if (message) session.push({ content: message.content, source: message.source });
  return { ...result, message };
}

/** surface 上的 chess-context 消息，按 form 分类。 */
function ledgerKinds(session) {
  const out = { live: 0, stub: 0, seqs: [] };
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq);
    if (ev?.type !== "user/message" || ev?.data?.source?.kind !== "chess-context") continue;
    out.seqs.push(seq);
    if (messageText(ev.data).length <= 200) out.stub += 1;
    else out.live += 1;
  }
  return out;
}

/** 让 digest 变化并跨过限流：加 5 条失败边 + 推进 seq。 */
function churn(g, state, session, { edges = 5, tag = "c2" } = {}) {
  const base = Number(session.seq) + 1;
  for (let i = 0; i < edges; i += 1) {
    observeEvent(g, assistantEvent(`${tag}-${i}`, "bash", { command: "npx tsc" }, base + i * 2), state);
    observeEvent(g, resultEvent(`${tag}-${i}`, `type error ${i}`, base + i * 2 + 1, true), state);
  }
  session.setSeq(session.seq + 40);
}

/** 在 surface 上塞 `n` 条普通消息（模拟"清单后面又聊了很多"）。 */
function bury(session, n) {
  for (let i = 0; i < n; i += 1) {
    session.push({ content: [{ type: "text", text: `普通消息 ${i}` }], source: { kind: "prompt" } });
  }
}

/* ───────────────────────── ① 同内容：第二次不许写 surface ───────────────────────── */

tests["C600 守卫①：同样内容重复注入 ⇒ 第二次必须 skip（不写 surface ⇒ 前缀不可能失配）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState();

  const first = run(session, g, state);
  t.eq(first.action, "append", "首次必须追加");
  const writesAfterFirst = session.surface.nodes.length;
  t.eq(writesAfterFirst, 1, "首次只许有一条 surface 消息");

  // 内容一字不差 + 事件距离也已经够远（把限流排除掉）
  session.setSeq(session.seq + 200);
  const second = run(session, g, state);
  t.eq(second.action, "skip", `同样内容 ⇒ 必须 skip，实际 ${second.action}`);
  t.eq(second.reason, "identical", "跳过原因必须是 identical（不是被限流）");
  t.eq(session.surface.nodes.length, writesAfterFirst, "skip 时**不许**有任何 surface 写（写 = 前缀变）");
  t.eq(session.appended.length, 0, "skip 时一次 session.append 都不许发生");
  t.eq(session.surface.nodes.length, 1, "surface 长度不变");
};

/* ───────────────────────── ② 漂离尾部：必须 append 而不是 replace ───────────────────────── */

tests["C600 守卫②：清单漂离尾部 ⇒ 第二次注入必须是 append（挂末尾），不是 replace（改早期槽位）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState();

  run(session, g, state);
  const firstLedgerSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.data?.source?.kind === "chess-context");
  t.eq(typeof firstLedgerSeq, "number", "首次注入后 surface 上必须有一条清单");

  // ★ 关键：清单后面压着消息（真机 100% 的替换都处在这个状态）
  bury(session, HOT_LEDGER_REPIN_AFTER + 5);
  churn(g, state, session);
  t.eq(session.surface.nodes.indexOf(firstLedgerSeq) < session.surface.nodes.length - 1, true, "清单已经不是最后一条（这正是要修的那个状态）");

  const second = run(session, g, state);
  t.eq(second.action, "append", `清单漂离尾部 ⇒ 必须追加，实际 ${second.action}`);
  t.eq(second.reason, "repinned", "跳过原因必须标明是重挂（不是普通追加）");

  // 重挂只产生**一次** surface 写：把旧清单换成占位（就地替换）。新清单走 decision.messages。
  t.eq(session.appended.length, 1, `重挂只许有一次 surface 写（占位），实际 ${session.appended.length}`);
  t.eq(session.appended[0].opts.surfaceOp?.op, "replace", "那一次必须是就地替换（换成占位）");
  t.eq(session.appended[0].opts.surfaceOp?.startSeq, firstLedgerSeq, "占位必须替换的是**旧清单**那个槽位");

  const kinds = ledgerKinds(session);
  t.eq(kinds.live, 1, `surface 上只许有一条真清单（实际 ${kinds.live}）`);
  t.eq(kinds.stub >= 1, true, "旧清单必须换成占位（否则每次注入都多背 466 token）");
  t.eq(kinds.seqs.at(-1), session.surface.nodes.at(-1), "真清单必须是 surface 的最后一条");
};

tests["C600 守卫③：清单本来就是最后一条 ⇒ 仍然就地替换（afterTail ≤ 阈值，保护契约①）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState();

  run(session, g, state);
  churn(g, state, session);

  const second = run(session, g, state);
  t.eq(second.action, "replace", "清单就是最后一条时，就地替换只作废它自己 ⇒ 保持旧行为");
  t.eq(second.afterTail, 0, "afterTail 必须是 0（写之前数的，这就是判据）");
  t.eq(ledgerKinds(session).live, 1, "surface 仍然只有一条真清单");
  t.eq(ledgerKinds(session).stub, 0, "没有历史清单 ⇒ 不许凭空造占位");
};

tests["C600 守卫④：重挂一次之后，再注入仍然是 append（不会退回到 replace）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState();

  run(session, g, state);
  bury(session, HOT_LEDGER_REPIN_AFTER + 5);
  churn(g, state, session);
  t.eq(run(session, g, state).action, "append", "第一次重挂");

  bury(session, HOT_LEDGER_REPIN_AFTER + 5);
  churn(g, state, session, { tag: "c3" });
  const third = run(session, g, state);
  t.eq(third.action, "append", `重挂是稳定的（第三次也必须 append），实际 ${third.action}`);
  t.eq(ledgerKinds(session).live, 1, "每次重挂都只留一条真清单（占位不算）");
};

/* ───────────────────────── ③ 语义不许退化 ───────────────────────── */

tests["C600 守卫⑤：重挂后的清单是完整渲染 —— 根的失败边一条不少（省缓存不许靠少注入）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState();

  const first = run(session, g, state);
  const firstText = messageText({ content: first.message.content });

  bury(session, HOT_LEDGER_REPIN_AFTER + 5);
  churn(g, state, session, { edges: 6, tag: "deep" });
  const second = run(session, g, state);
  t.eq(second.action, "append", "重挂");
  const secondText = messageText({ content: second.message.content });

  // 清单骨架两版都在
  for (const marker of ["<chess-ledger>", "</chess-ledger>", "ROOT USER (verbatim)"]) {
    t.eq(firstText.includes(marker), true, `首版必须含 ${marker}`);
    t.eq(secondText.includes(marker), true, `重挂版必须含 ${marker}`);
  }
  // 旧版里出现过的失败边 id，新版必须**全部**还在（失败边是累积的，不许因为重挂而丢）
  const ids = (text) => new Set([...String(text).matchAll(/\b(e\d+)\b/g)].map((m) => m[1]));
  const before = ids(firstText);
  const after = ids(secondText);
  const missing = [...before].filter((id) => !after.has(id));
  t.eq(missing, [], `重挂后丢了旧版的边：${missing.join(",")}`);
  // 新的失败边必须被算进去（内容没少 = 也得多）
  t.eq(after.size > before.size, true, `重挂后必须比旧版多出新失败边（旧 ${before.size} → 新 ${after.size}）`);
  // 占位文案是冻结的：它必须明说"被最新的取代"，否则模型会以为旧清单还是当前状态
  t.eq(LEDGER_STUB_TEXT.includes("superseded by the latest"), true, "占位文案必须说清「以最新那条为准」");
};

tests["C600 守卫⑥：hotLedgerReplace=false ⇒ 一条都不许替换（退回纯追加的旧语义）"] = (t) => {
  const g = graphWithFailure();
  const session = makeSession();
  const state = makeState({ legacyElided: true });
  const cfg = { ...CONFIG, hotLedgerReplace: false };
  const createUserMessage = (args) => ({ id: "ledger", role: "user", ...args });
  const decide = () =>
    decideInjection({ session, graph: g, state, config: cfg, sessionDir: "/tmp/s", decision: makeDecision(), payloadMessages: [], createUserMessage });

  const first = decide();
  const m1 = first.decision.messages.find((m) => m.source?.kind === "chess-context");
  session.push({ content: m1.content, source: m1.source });
  bury(session, HOT_LEDGER_REPIN_AFTER + 5);
  churn(g, state, session);

  const second = decide();
  t.eq(second.action, "append", "关掉替换 ⇒ 一律追加");
  t.eq(session.appended.filter((a) => a.opts.surfaceOp !== undefined).length, 0, "关掉替换后不许出现任何 surfaceOp 写");
};

/* ───────────────────────── ④ 审计脚本本身 ───────────────────────── */

const T0 = 1_793_600_000_000;
const injection = (seq, op, text = "<chess-ledger>x</chess-ledger>", digest = "d") => ({
  type: "user/message",
  seq,
  time: T0 + seq * 1000,
  data: { content: [{ type: "text", text }], source: { kind: "chess-context", form: "ledger", digest } },
  ...(typeof op === "string" ? { surfaceOp: op } : { surfaceOp: op }),
});
const request = (seq, { miss = 0, hit = 1_000, out = 10 } = {}) => ({
  type: "assistant/message",
  seq,
  time: T0 + seq * 1000,
  data: { usage: { inputTokens: miss, cacheReadTokens: hit, outputTokens: out, totalTokens: miss + hit + out } },
});

tests["C600 审计①：请求按「前面最近一次注入动作」归因（replace / append / none 三组）"] = (t) => {
  const rows = attributeRequests([
    request(1, { miss: 900, hit: 100 }), // 前面没有注入 ⇒ none
    injection(2, "append"),
    request(3, { miss: 1_000, hit: 9_000 }), // append
    injection(4, { op: "replace", startSeq: 2, endSeq: 2 }),
    request(5, { miss: 90_000, hit: 10_000 }), // replace
    request(6, { miss: 500, hit: 9_500 }), // 已经被上一次请求认领 ⇒ none
  ]);
  t.eq(rows.length, 4, `四条带 usage 的请求，实际 ${rows.length}`);
  t.eq(rows.map((r) => r.action), ["none", "append", "replace", "none"], "归因必须是「只付一次」");
  t.eq(rows[2].miss, 90_000, "replace 的 miss 要原样带出");
  t.eq(rows[0].gapSec, null, "第一条没有前序 ⇒ gap 为 null（不许算成 0 秒）");
  t.eq(rows[1].gapSec, 2, "相邻请求间隔按秒");

  const sum = summarizeByAction(rows);
  t.eq(sum.replace.requests, 1, "replace 组 1 条");
  t.eq(Math.abs(sum.replace.hitRate - 0.1) < 1e-12, true, `replace 命中率 10%，实际 ${sum.replace.hitRate}`);
  t.eq(Math.abs(sum.append.hitRate - 0.9) < 1e-12, true, "append 命中率 90%");
  t.eq(sum.none.hitRate !== null, true, "none 组有样本 ⇒ 命中率不是 null");
  t.eq(summarizeByAction([]).replace.hitRate, null, "空输入 ⇒ null（不许是 0 —— 0 会被读成「全 miss」）");
};

tests["C600 审计②：分解必须把 replace 的账拆成「必要（新清单）+ 实现（后面重读）」"] = (t) => {
  // 新清单 2,000 字符 ⇒ ≈500 token；替换那次 miss 90,000
  const text = "x".repeat(2_000);
  const rows = attributeRequests([
    injection(1, "append", text),
    request(2, { miss: 1_000, hit: 99_000 }),
    injection(3, { op: "replace", startSeq: 1, endSeq: 1 }, text),
    request(4, { miss: 90_000, hit: 10_000 }),
  ]);
  const d = decomposeReplaceCost(rows);
  t.eq(d.replaceRequests, 1, "一次 replace");
  t.eq(d.totalMiss, 90_000, "miss 合计");
  t.eq(d.necessaryTokens, charsToTokens(2_000), "必要部分 = 新清单自己的 token");
  t.eq(d.implementationTokens, 90_000 - charsToTokens(2_000), "剩下全算实现代价");
  t.eq(d.necessaryShare < 0.01, true, `必要占比必须 <1%（实际 ${(d.necessaryShare * 100).toFixed(2)}%）`);
  t.eq(Math.abs(d.necessaryCost - (500 * PRICES.miss) / 1e6) < 1e-12, true, "必要部分的钱按 miss 价算");

  // 反事实：同一批请求按「同会话非 replace 的命中率」付费
  const cf = replaceCounterfactual(rows);
  t.eq(Math.abs(cf.baselineHitRate - 99_000 / 100_000) < 1e-12, true, `基线命中率，实际 ${cf.baselineHitRate}`);
  t.eq(cf.actual > cf.counterfactual, true, "实际必须比反事实贵（否则这个动作不亏，就不该动它）");
  t.eq(cf.wasted > 0, true, "差价必须为正");
  t.eq(replaceCounterfactual([]).wasted, 0, "空输入 ⇒ 0");
};

tests["C600 审计③：「稳定前缀」的天花板必须能被算出来（这条用来证伪 brief 提的修法）"] = (t) => {
  // 旧清单 2,000 字符，新版共享 25% 前缀 ⇒ 就算拉到 100% 也只多命中 ~375 token
  const pairs = [{ oldChars: 2_000, newChars: 2_000, lcpChars: 500 }];
  const ceil = stablePrefixCeiling(pairs, PRICES, 1);
  t.eq(Math.abs(ceil.medianLcpShare - 0.25) < 1e-12, true, "LCP 中位占比 25%");
  t.eq(ceil.extraHitTokensIfPerfect, charsToTokens(1_500), "拉到 100% 只多命中 1,500 字符");
  t.eq(ceil.extraHitTokensPerReplace, charsToTokens(1_500), "单次只多这么多");
  // 每次多省 = 1500/4 token × (miss - hit) 价差
  t.eq(Math.abs(ceil.extraSavingIfPerfect - (375 * (PRICES.miss - PRICES.hit)) / 1e6) < 1e-15, true, "省下的钱按价差算");
  t.eq(ceil.extraSavingIfPerfect < 0.001, true, "结论：稳定前缀每次只值 <0.1 美分（所以它不是解）");
};

tests["C600 审计④：间隔分桶与事件研究 —— 用同一口径排除「缓存 TTL 过期」这个混淆项"] = (t) => {
  const rows = [
    { action: "none", miss: 100, hit: 9_900, out: 0, gapSec: 2 },
    { action: "replace", miss: 9_000, hit: 1_000, out: 0, gapSec: 7 },
    { action: "none", miss: 200, hit: 9_800, out: 0, gapSec: 20 },
  ];
  const buckets = gapBuckets(rows, [[0, 5], [5, 30]]);
  t.eq(buckets.length, 2, "两个桶");
  t.eq(Math.abs(buckets[0].byAction.none.hitRate - 0.99) < 1e-12, true, "0–5s 桶里 none 命中 99%");
  t.eq(buckets[0].byAction.replace.requests, 0, "0–5s 桶里没有 replace");
  t.eq(Math.abs(buckets[1].byAction.replace.hitRate - 0.1) < 1e-12, true, "5–30s 桶里 replace 命中 10%");

  const study = eventStudy(rows);
  t.eq(study.isolated.samples, 1, "孤立 replace 1 组");
  t.eq(study.isolated.before, 0.99, "前一次 99%");
  t.eq(study.isolated.at, 0.1, "这一次 10%");
  t.eq(study.isolated.after, 9_800 / 10_000, "后一次立刻回到基线");
  t.eq(eventStudy([]).isolated.samples, 0, "空输入不崩");
};

tests["C600 审计⑤：纯函数口径 —— LCP / 首行差异 / 区段分类 / 价格"] = (t) => {
  t.eq(lcpChars("abcdef", "abcxyz"), 3, "LCP = 3");
  t.eq(lcpChars("", "abc"), 0, "空串 ⇒ 0");
  t.eq(lcpChars("abc", "abcdef"), 3, "短的是前缀 ⇒ 3");

  const d = firstDiff("A\nB\nC", "A\nB2\nC");
  t.eq(d.lineIndex, 1, "第 1 行开始不同（0 基）");
  t.eq(d.section, "other", "B 不是已知骨架行");
  t.eq(firstDiff("<chess-ledger>\nCURRENT PATH: n1", "<chess-ledger>\nCURRENT PATH: n2").section, "current-path", "CURRENT PATH 要认出来");
  t.eq(firstDiff("<chess-ledger>\nUNVERIFIED: 1", "<chess-ledger>\nUNVERIFIED: 2").section, "unverified", "UNVERIFIED 要认出来");
  t.eq(classifyLedgerLine("  "), "blank", "空行");
  t.eq(classifyLedgerLine('* e12 "跑测试" → exit 1'), "failure-edge", "失败边行");

  t.eq(messageTextOf("abc"), "abc", "字符串内容原样");
  t.eq(messageTextOf([{ type: "text", text: "a" }, { type: "reasoning", text: "b" }, { type: "text", text: "c" }]), "a\nc", "只拼 text 块（reasoning 不算）");
  t.eq(messageTextOf(null), "", "非法输入 ⇒ 空串");

  // 价格口径：1M 未命中 = $0.15，1M 命中 = $0.003（= 1/50）
  t.eq(Math.abs(requestCost({ miss: 1e6, hit: 0, out: 0 }) - 0.15) < 1e-12, true, "1M miss = $0.15");
  t.eq(Math.abs(requestCost({ miss: 0, hit: 1e6, out: 0 }) - 0.003) < 1e-12, true, "1M hit = $0.003");
  t.eq(PRICES.miss / PRICES.hit, 50, "价差必须是 50 倍（官方口径：cache 命中价是 miss 的 1/50）");
};

tests["C600 审计⑥：elideLegacyLedgers 的 keep 参数（重挂路径要 keep:0）"] = (t) => {
  const makeUserMessage = ({ content, source }) => ({ id: "stub", role: "user", content, source });
  const session = makeSession();
  const long = "<chess-ledger>" + "x".repeat(400);
  const s1 = session.push({ content: [{ type: "text", text: long }], source: { kind: "chess-context", form: "ledger" } });
  const s2 = session.push({ content: [{ type: "text", text: long }], source: { kind: "chess-context", form: "ledger" } });

  t.eq(elideLegacyLedgers(session, { createUserMessage: makeUserMessage, keep: 1 }), 1, "keep:1 ⇒ 只清更早的那条");
  t.eq(ledgerKinds(session).live, 1, "还剩一条真清单");
  t.eq(ledgerKinds(session).seqs.includes(s2), true, "最新那条必须原样保留");

  const s3 = session.push({ content: [{ type: "text", text: long }], source: { kind: "chess-context", form: "ledger" } });
  t.eq(elideLegacyLedgers(session, { createUserMessage: makeUserMessage, keep: 0 }), 2, "keep:0 ⇒ 把剩下两条真清单都换成占位（占位自己跳过）");
  t.eq(ledgerKinds(session).live, 0, "一条真清单都不留（新清单马上要写进去）");
  t.eq(session.surface.nodes.length, 3, "surface 长度不许变（replace 不是 append）");
  t.eq(session.surface.nodes.includes(s3), false, "被清掉的那条不再占 surface 槽位（换成占位的新 seq）");
  t.eq(elideLegacyLedgers(session, { createUserMessage: makeUserMessage, keep: 0 }), 0, "幂等：已经是占位就不再动");
  t.eq(s1 !== s2, true, "夹具自检");
};
