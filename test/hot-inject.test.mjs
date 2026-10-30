/**
 * hot-inject.test.mjs —— R08 注入策略直测（A2-3，2026-10-30）
 *
 * 为什么需要：`engine-harness` 是端到端（真 engine + 假 ctx），它证明了「能跑」，
 * 但**六条行为契约各自独立红**这件事只有直测能证明（契约 R08 明确要求每条一个用例）。
 *
 * 本文件用假 session port（`{id, seq, surface:{nodes}, eventAt, append}`）+ 真 graph（经 keeper 落账），
 * 覆盖：surface 只留一条 / digest 只算骨架 / 限流 / 内容相同 skip / replace 退回 append /
 * fold 遮蔽同源补回 / never-throws。
 */

import {
  INJECT_MIN_EVENTS,
  INJECT_MIN_FAILURE_DELTA,
  LEDGER_STUB_TEXT,
  decideInjection,
  elideLegacyLedgers,
  findLedgerNode,
  foldFailureWarning,
  ledgerDigest,
  messageText,
} from "../src/rooms/hot-inject.mjs";
import { addUserNodeId, createGraph } from "./graph-fixtures.mjs";
import { observeEvent } from "../src/keeper.mjs";

/* ───────────────────────── 夹具 ───────────────────────── */

const CONFIG = { hotLedgerReplace: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerTraceRoot: "sessions", hotLedger: true };

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
    /** 直接塞一条已存在的 surface 消息（模拟历史遗留/上一轮注入）。 */
    push(data) {
      const s = current++;
      nodes.push(s);
      events.set(s, { type: "user/message", seq: s, data });
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

/** 一张至少有一条失败边的图。 */
function graphWithFailure(cwd = "D:/tmp/proj") {
  const g = createGraph({ sessionId: "s1", cwd });
  const st = makeState();
  observeEvent(g, userEvent("把注入房间抽出来", 1), st);
  observeEvent(g, assistantEvent("c1", "bash", { command: "npm test" }, 2), st);
  observeEvent(g, resultEvent("c1", "boom\n[exit code: 1]", 3, true), st);
  return g;
}

function makeDecision(payloadMessages) {
  return { kind: "enter", messages: [...payloadMessages] };
}

const createUserMessage = ({ content, source }) => ({ role: "user", content, source });

function run(session, graph, state, over = {}) {
  const payloadMessages = over.payloadMessages ?? [{ id: "claimed" }];
  const decision = over.decision ?? makeDecision(payloadMessages);
  return decideInjection({
    session,
    graph,
    state,
    config: CONFIG,
    sessionDir: "D:/tmp/ghost/sessions/s1",
    decision,
    payloadMessages,
    createUserMessage,
    onBudget: () => {},
    onLog: () => {},
    ...over,
  });
}

function ledgerMessagesIn(session) {
  return session.surface.nodes.filter((seq) => session.eventAt(seq)?.data?.source?.kind === "chess-context");
}

/** 模拟 DSH 内核：append 分支的 message 由内核写进 surface（本房间只返回 decision）。 */
function commitAppend(session, result) {
  const message = result.decision.messages.find((m) => m.source?.kind === "chess-context");
  if (message) session.push(message);
  return message;
}

/* ───────────────────────── 用例 ───────────────────────── */

export const tests = {
  "契约①：surface 只留一条 —— 第二次注入走 replace，节点数不增长"(t) {
    const g = graphWithFailure();
    const session = makeSession();
    const state = makeState();
    const first = run(session, g, state);
    t.eq(first.action, "append", "首次应追加");
    commitAppend(session, first);
    t.eq(ledgerMessagesIn(session).length, 1, "surface 上一条清单");

    // 让 digest 变化（加 5 条失败边，跨过 +5 门槛），并拉开事件距离（绕过限流）
    for (let i = 0; i < 5; i += 1) {
      observeEvent(g, assistantEvent(`c2-${i}`, "bash", { command: "npx tsc" }, 4 + i * 2), state);
      observeEvent(g, resultEvent(`c2-${i}`, `type error ${i}`, 5 + i * 2, true), state);
    }
    session.setSeq(session.seq + INJECT_MIN_EVENTS);
    const second = run(session, g, state);
    t.eq(second.action, "replace", "已有清单 + digest 变了 ⇒ 必须 replace");
    t.eq(ledgerMessagesIn(session).length, 1, "surface 仍然只有一条（不是追加）");
    t.eq(session.appended.at(-1).opts.surfaceOp?.op, "replace", "最后一次 append 必须带 surfaceOp:replace");
  },

  "契约②：digest 只算骨架 —— 路径变化不变、失败边变化才变"(t) {
    const g = graphWithFailure();
    const before = ledgerDigest(g);
    // 只加节点（CURRENT PATH 会变），不加失败边
    addUserNodeId(g, { seq: 90, turn: 9, text: "新的一步（不影响骨架）" });
    t.eq(ledgerDigest(g), before, "加节点 ⇒ digest 不变（CURRENT PATH 不进 digest）");
    // 加失败边
    const st = makeState();
    observeEvent(g, assistantEvent("c3", "bash", { command: "false" }, 91), st);
    observeEvent(g, resultEvent("c3", "exit 1", 92, true), st);
    t.ne(ledgerDigest(g), before, "加失败边 ⇒ digest 必须变");
    // fold 失败后缀
    t.includes(ledgerDigest(g, { foldFailures: 3 }), "|fold-fail-3", "foldFailures>0 必须带后缀");
  },

  "契约③：限流 40 events / +5 failures；告警绕过限流"(t) {
    const g = graphWithFailure();
    const session = makeSession();
    const state = makeState();
    run(session, g, state);
    // digest 变了但事件差 1 < 40 ⇒ skip
    observeEvent(g, assistantEvent("c4", "bash", { command: "false" }, 10), state);
    observeEvent(g, resultEvent("c4", "x", 11, true), state);
    const throttled = run(session, g, state);
    t.eq(throttled.action, "skip", "事件间隔不足 ⇒ skip");
    t.eq(throttled.reason, "throttled-events", "原因必须是事件限流");
    // 拉开事件但失败边只多 1 条（< +5）⇒ skip
    session.setSeq(session.seq + INJECT_MIN_EVENTS);
    const byFailures = run(session, g, state);
    t.eq(byFailures.action, "skip", "失败边增量不足 ⇒ skip");
    t.eq(byFailures.reason, "throttled-failures", "原因必须是失败边限流");
    // 告警存在 ⇒ 绕过限流
    state.foldFailures = 2;
    state.lastFoldError = "MAX_TOKENS";
    const warned = run(session, g, state);
    t.ne(warned.action, "skip", "有告警时必须注入（绕过限流）");
    t.includes(foldFailureWarning(state), "CONTEXT COMPRESSION IS FAILING", "告警文案");
  },

  "契约④：内容一字不差 ⇒ skip 且不 append"(t) {
    const g = graphWithFailure();
    const session = makeSession();
    const state = makeState();
    const first = run(session, g, state);
    t.eq(first.action, "append", "首次注入");
    commitAppend(session, first);
    const countBefore = session.appended.length;
    const second = run(session, g, state);
    t.eq(second.action, "skip", "同内容 ⇒ skip");
    t.eq(second.reason, "identical", "原因 identical");
    t.eq(session.appended.length, countBefore, "不许再 append");
  },

  "契约⑤：替换锚点抛错 ⇒ 退回追加，不丢信息"(t) {
    const g = graphWithFailure();
    const session = makeSession();
    const state = makeState();
    // 预置一条旧清单（surface 上有它，但 append 的 replace 会抛）
    const old = createUserMessage({ content: [{ type: "text", text: "OLD LEDGER" }], source: { kind: "chess-context", form: "ledger" } });
    session.push(old);
    const origAppend = session.append;
    session.append = function (type, data, opts = {}) {
      if (opts.surfaceOp?.op === "replace") throw new Error("anchor gone");
      return origAppend.call(this, type, data, opts);
    };
    const warns = [];
    const r = run(session, g, state, { onLog: (lvl, line) => warns.push([lvl, line]) });
    t.eq(r.action, "append", "replace 失败必须退回 append");
    t.ok(warns.some(([lvl, line]) => lvl === "warn" && line.includes("替换失败")), "必须 warn 一行");
    const injected = r.decision.messages.find((m) => m.source?.kind === "chess-context");
    t.ok(injected !== undefined, "decision.messages 必须含新清单");
  },

  "契约⑥：清单被 fold 遮蔽、同 digest ⇒ 绕过限流立即补回"(t) {
    const g = graphWithFailure();
    const session = makeSession();
    const state = makeState();
    const first = run(session, g, state);
    commitAppend(session, first);
    const digest = state.lastLedgerDigest;
    t.ok(typeof digest === "string" && digest.length > 0, "首轮必须记下 digest");
    // 模拟 fold：surface 上的清单节点被遮蔽（从 nodes 移除，event 仍在）
    session.surface.nodes.splice(0);
    session.setSeq(session.seq + 1); // 事件差远小于 40
    const r = run(session, g, state);
    t.eq(r.action, "append", "被遮蔽 + 同 digest ⇒ 立即补回");
    commitAppend(session, r);
    t.eq(ledgerMessagesIn(session).length, 1, "补回后 surface 上又有一条");
  },

  "never-throws：session port 所有方法都抛 ⇒ 返回原 decision（action=skip）"(t) {
    const g = graphWithFailure();
    const boom = () => {
      throw new Error("port down");
    };
    const session = {
      id: "s1",
      get seq() {
        return boom();
      },
      surface: {
        get nodes() {
          return boom();
        },
      },
      eventAt: boom,
      append: boom,
    };
    const payloadMessages = [{ id: "claimed" }];
    const decision = makeDecision(payloadMessages);
    const r = run(session, g, makeState(), { payloadMessages, decision });
    t.eq(r.action, "skip", "必须 skip");
    t.eq(r.decision, decision, "必须原样返回 decision（同一个对象）");
  },

  "附加：历史清单占位清理（elideLegacyLedgers）与 findLedgerNode/messageText"(t) {
    const session = makeSession();
    const old1 = createUserMessage({ content: [{ type: "text", text: "A".repeat(500) }], source: { kind: "chess-context", form: "ledger" } });
    const old2 = createUserMessage({ content: [{ type: "text", text: "B".repeat(500) }], source: { kind: "chess-context", form: "ledger" } });
    session.push(old1);
    const keepSeq = session.push(old2);
    const n = elideLegacyLedgers(session, { createUserMessage });
    t.eq(n, 1, "两条旧清单 ⇒ 换掉 1 条（保留最后一条）");
    const kept = findLedgerNode(session);
    t.eq(kept.seq, keepSeq, "findLedgerNode 必须返回最后一条");
    const stub = session.eventAt(session.surface.nodes[0])?.data;
    t.eq(stub?.source?.form, "ledger-stub", "占位 form");
    t.eq(messageText(stub), LEDGER_STUB_TEXT, "占位文案必须逐字一致");
    t.ok(LEDGER_STUB_TEXT.length < 200, "占位必须 <200 字符（幂等判据）");
  },
};