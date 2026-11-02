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
import { addUserNodeId, addEdge, addAgentNode, settleEdge, createGraph } from "./graph-fixtures.mjs";
import { failureEdges, sha } from "../src/rooms/kifu-model.mjs";
import { renderLedger } from "../src/rooms/ledger.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";

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
    // ★ C160：占位是**模型可见文本** —— 不许点名内部文件名/内部字段名（模型会当成可读路径去试）
    t.eq(/graph\.json|foldMark|nodes\/|stateIndex|dirty/i.test(LEDGER_STUB_TEXT), false, `占位不许泄露内部实现名：${LEDGER_STUB_TEXT}`);
    t.includes(LEDGER_STUB_TEXT, "<chess-ledger>", "仍要保留标签名，让模型知道被折叠的是哪类块");
  },
};
/* ═══════════ OPT-EMPTY（task-130）：零失败边也要有最小注入 ═══════════ */

/** 一张**没有失败边**的图（有根目标 / 约束 / 当前目标 / 一条成功边）；`content=false` 时是空图。 */
function graphWithoutFailure({ content = true } = {}) {
  const g = createGraph({ sessionId: "s0", cwd: "D:/tmp/proj" });
  if (!content) return g;
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通" });
  g.nodes[u].constraints = ["不要动 prod 配置", "只改 tests/"];
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)" });
  const a = addAgentNode(g, { seq: 3, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  g.edges[e].to = a;
  settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return g;
}

Object.assign(tests, {
  "OPT-E-1 零失败边 + 有 goal/constraints ⇒ 注入一次，内容含 GOAL / CONSTRAINTS / no failed attempts"(t) {
    const g = graphWithoutFailure();
    t.eq(failureEdges(g).length, 0, "夹具必须零失败边");
    const session = makeSession({ id: "s0" });
    const state = makeState();
    const first = run(session, g, state);
    t.eq(first.action, "append", "零失败但有内容 ⇒ 必须注入（旧版会 skip no-ledger）");
    const message = commitAppend(session, first);
    const text = messageText(message);
    t.includes(text, "<chess-ledger>", "仍用既有清单格式");
    // ★ C224：契约 ① 认的是 **ROOT USER**（不是 GOAL）——最小清单改成逐字给根目标，
    //   与主清单一致；两者都渲染时 GOAL 只在「当前目标 ≠ 根目标」时出现。
    // ★ C224：最小清单与主清单同口径 —— 根目标逐字给（契约 ①），当前目标与根目标不同时再补一行。
    t.includes(text, "ROOT USER (verbatim): 把构建跑通", "必须逐字带根目标（契约 ①）");
    t.includes(text, "GOAL: 跑测试", "当前目标与根目标不同时必须也给出它");
    t.includes(text, "CONSTRAINTS: 2", "必须带约束数量");
    t.includes(text, "NO_FAILED_ATTEMPTS_YET", "必须明说「还没有失败」");
    // ★ C223：零失败会话占真实会话的约 26%，旧版最小清单**完全没有当前位置**（契约 ⑥ 违反）。
    //   handoff-check 在 live 上抓到 2 个会话（5df02bf8 / 30140e4c）就是这个原因。
    t.includes(text, "# path:", "最小清单也必须给出当前位置（契约 ⑥）");
    const lineCount = text.split("\n").length;
    t.eq(lineCount <= 7, true, `极简注入必须短（实际 ${lineCount} 行）`);
    // 第二步：同 digest 且清单还在 ⇒ 不重复注入（避免每步刷屏）
    const second = run(session, g, state);
    t.eq(second.action, "skip", "内容没变 ⇒ skip");
    t.ok(["identical", "same-digest"].includes(second.reason), `内容没变必须 skip（identical/same-digest），实际 ${second.reason}`);
  },

  "OPT-E-2 零失败边 + 无内容（空图）⇒ 仍然 skip"(t) {
    const g = graphWithoutFailure({ content: false });
    const session = makeSession({ id: "s-empty" });
    const state = makeState();
    const r = run(session, g, state);
    t.eq(r.action, "skip", "空图不许注入空壳");
    t.eq(r.reason, "no-ledger", `应为 no-ledger，实际 ${r.reason}`);
  },

  "OPT-E-3 有失败边路径字节不变（渲染 sha 逐字节钉住）"(t) {
    const g = graphWithFailure();
    const out = renderLedger(g, { maxTokens: 500 });
    t.eq(out.text.includes("NO_FAILED_ATTEMPTS_YET"), false, "有失败边时不许出现零失败行");
    // ★ 2026-11-01 基线更新（handoff-check 在 live 语料上抓到）：失败边行必须**物理上一行**。
    //   旧输出把多行 errorSnippet（`boom\n[exit code: 1]`）原样保留，一条边被拆成两行，
    //   `(seq …)` 落到第二行 ⇒ 模型看到的是「一条边两行」，出处覆盖率指标也会误判成「渲染在砍 seq」。
    //   现在 intent/reason 统一压成单行（换行→空格，字符数不变 186，sha 变）——这是**有意的字节变更**，
    //   基线从 c234c80… 换成 a80735d…，理由记录在此，下一次改动请照此写清原因。
    t.eq(sha(out.text), "a80735db778562028ef0fe1aa4a470ea0bd821dad222388d504bdbf7c0802ece", "有失败边的清单必须逐字节不变（单行失败边基线 sha，2026-11-01）");
    t.eq(out.text.length, 186, "字符数也必须不变");
  },

  "OPT-E-4 零失败清单被 fold 遮蔽 ⇒ 同源补回（绕过限流）"(t) {
    const g = graphWithoutFailure();
    const session = makeSession({ id: "s0b" });
    const state = makeState();
    const first = run(session, g, state);
    commitAppend(session, first);
    t.eq(ledgerMessagesIn(session).length, 1, "先有一条");
    // 模拟 fold 把它压掉：surface 上不再有清单节点
    session.surface.nodes.splice(session.surface.nodes.indexOf(ledgerMessagesIn(session)[0]), 1);
    t.eq(ledgerMessagesIn(session).length, 0, "清单已被遮蔽");
    const again = run(session, g, state);
    t.eq(again.action, "append", "被 fold 遮蔽后必须补回（lostToFold 绕过限流）");
    const text = messageText(commitAppend(session, again));
    t.includes(text, "NO_FAILED_ATTEMPTS_YET", "补回的仍是零失败清单");
  },
});

tests["C90 坏图时注入必须降级为 skip(error:)，绝不把异常抛给宿主"] = (t) => {
  // 图里有失败边（能走到渲染），但节点的 text 被塞成对象 —— 这正是历史上真实发生过的
  // worldHash 对象污染：renderLedger 对它调 .slice() 抛 TypeError。注入必须降级。
  const broken = graphWithFailure();
  // 结构漂移：renderLedger 依赖 rootUserNodeIds（缺失时对 undefined 调 .map 抛 TypeError）
  delete broken.rootUserNodeIds;
  const result = run(makeSession(), broken, makeState());
  t.eq(result.action, "skip", "坏图必须降级为 skip");
  t.eq(String(result.reason).startsWith("error:"), true, `reason 必须是 error: 前缀（供统计识别）：${result.reason}`);
  t.eq(result.decision.kind, "enter", "原 decision 必须原样返回（对话不中断）");
};

/* ───────────────────── C129：随机化不变量 ───────────────────── */

/** 确定性 PRNG（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function graphWithNFailures(n) {
  const g = createGraph({ sessionId: "prop", cwd: "D:/tmp/proj" });
  const st = makeState();
  observeEvent(g, userEvent("让测试变绿", 1), st);
  for (let i = 0; i < n; i += 1) {
    const seq = 10 + i * 4;
    observeEvent(g, assistantEvent(`p${i}`, "bash", { command: `npm test --case=${i}` }, seq), st);
    if (i === 0) {
      observeEvent(g, resultEvent(`p${i}`, "AssertionError: boom", seq + 1, true), st);
    } else {
      // 失败边需要有终点，才不会被当成残留
      observeEvent(g, resultEvent(`p${i}`, `ERR_${i}: unique failure ${i}`, seq + 1, true), st);
    }
  }
  return g;
}

tests["C129 随机化不变量：任何输入都不崩，动作合法，注入的消息必须带 <chess-ledger>"] = (t) => {
  const rand = rng(20261102);
  for (let i = 0; i < 15; i += 1) {
    const failures = Math.floor(rand() * 13); // 0..12
    const g = graphWithNFailures(failures);
    const session = makeSession();
    const state = makeState();
    const before = run(session, g, state);

    t.eq(["append", "replace", "skip"].includes(before.action), true, `第 ${i + 1} 组（failures=${failures}）动作非法：${before.action}`);
    if (before.action === "skip") {
      t.eq(Array.isArray(before.decision.messages), true, `第 ${i + 1} 组 skip 时也必须返回 decision`);
      continue;
    }
    const ledger = before.decision.messages.find((m) => m.source?.kind === "chess-context");
    t.eq(!!ledger, true, `第 ${i + 1} 组注入后必须有一条 chess-context 消息`);
    t.includes(messageText(ledger), "<chess-ledger>", `第 ${i + 1} 组注入的消息必须带 <chess-ledger> 骨架`);

    // 提交后：再加失败边 + 推进事件，第二次决策也必须合法
    commitAppend(session, before);
    for (let k = 0; k < Math.floor(rand() * 4); k += 1) {
      const seq = 400 + i * 10 + k * 2;
      observeEvent(g, assistantEvent(`q${i}-${k}`, "bash", { command: `false ${k}` }, seq), state);
      observeEvent(g, resultEvent(`q${i}-${k}`, `ERR_${i}_${k}: late`, seq + 1, true), state);
    }
    session.setSeq(session.seq + Math.floor(rand() * 60));
    const after = run(session, g, state);
    t.eq(["append", "replace", "skip"].includes(after.action), true, `第 ${i + 1} 组第二次动作非法：${after.action}`);
    const ledgers = after.decision.messages.filter((m) => m.source?.kind === "chess-context");
    t.eq(ledgers.length <= 2, true, `第 ${i + 1} 组决策里 chess-context 消息不该超过 2 条（实际 ${ledgers.length}）`);
  }
};

tests["C130 历史清单清理的随机化不变量：只动旧 chess-context，别人的消息一条都不碰"] = (t) => {
  const makeUserMessage = ({ content, source }) => ({ id: "stub", role: "user", content, source });
  const rand = rng(778899);
  let elidedTotal = 0;
  for (let i = 0; i < 12; i += 1) {
    const session = makeSession();
    const ledgerSeqs = [];
    const otherSeqs = [];
    const ledgerCount = Math.floor(rand() * 5); // 0..4 条历史清单
    for (let k = 0; k < ledgerCount; k += 1) {
      const long = rand() < 0.7;
      const text = long ? "<chess-ledger>" + "x".repeat(300 + Math.floor(rand() * 400)) : LEDGER_STUB_TEXT;
      ledgerSeqs.push(session.push({ content: [{ type: "text", text }], source: { kind: "chess-context", form: long ? "ledger" : "ledger-stub" } }));
      // 中间夹一条普通用户消息
      otherSeqs.push(session.push({ content: [{ type: "text", text: `普通消息 ${k}` }], source: { kind: "prompt" } }));
    }
    const before = [...session.surface.nodes];
    const latestSeqBefore = ledgerSeqs.length > 0 ? ledgerSeqs[ledgerSeqs.length - 1] : null;
    const latestTextBefore = latestSeqBefore === null ? null : messageText(session.eventAt(latestSeqBefore)?.data ?? {});
    const elided = elideLegacyLedgers(session, { createUserMessage: makeUserMessage });
    elidedTotal += elided;
    const after = [...session.surface.nodes];

    t.eq(after.length, before.length, `第 ${i + 1} 组 surface 长度必须不变（replace 不是 append）`);
    for (const seq of otherSeqs) t.eq(after.includes(seq), true, `第 ${i + 1} 组普通消息 ${seq} 被误动了`);
    // 非占位清单最多保留一条
    const nonStub = after.filter((seq) => {
      const ev = session.eventAt(seq);
      const text = messageText(ev?.data ?? {});
      return ev?.data?.source?.kind === "chess-context" && text.length > 200;
    });
    t.eq(nonStub.length <= 1, true, `第 ${i + 1} 组还有 ${nonStub.length} 条非占位清单（应该只剩最新一条）`);
    // ★ C143（审查 P1-6）：**最新一条必须原样保留** —— 只断言「非占位 ≤1」的话，
    //   全部替换成占位也能过（那份最新的清单就丢了）。
    if (latestSeqBefore !== null) {
      // 必须在**清理前**取原文，清理后逐字比对 —— 否则「先 stub 再断言长度」是循环论证
      t.eq(after.includes(latestSeqBefore), true, `第 ${i + 1} 组最新一条清单（${latestSeqBefore}）必须仍在 surface 上`);
      const latestTextAfter = messageText(session.eventAt(latestSeqBefore)?.data ?? {});
      t.eq(latestTextAfter === latestTextBefore, true, `第 ${i + 1} 组最新一条清单必须逐字未变（清理前 ${latestTextBefore.length} 字符 → 之后 ${latestTextAfter.length}）`);
    }
    // 幂等：再跑一次不该再动
    const again = elideLegacyLedgers(session, { createUserMessage: makeUserMessage });
    t.eq(again, 0, `第 ${i + 1} 组第二次清理必须无事可做（实际 ${again}）`);
  }
  t.eq(elidedTotal > 0, true, "随机样本必须至少发生一次清理（否则判据空转）");
};

tests["C248 注入节流间隔可配：hotLedgerMinEvents 生效（默认 40 = 旧行为）"] = (t) => {
  // 场景：刚注入过、只过了 10 个事件，且失败边没变多 ⇒ 默认配置下跳过（throttled-events）
  const build = () => {
    const g = graphWithFailure();
    const st = makeState();
    const session = makeSession({ id: "s-throttle", seq: 100 });
    const seeded = run(session, g, { ...st, lastLedgerInjectSeq: 90, lastLedgerFailureCount: failureEdges(g).length });
    return { g, session, st, seeded };
  };
  const a = build();
  t.eq(a.seeded.action, "skip", "默认配置（40 事件）下、只过 10 个事件 ⇒ 跳过");

  const b = build();
  const loose = run(b.session, b.g, { ...b.st, lastLedgerInjectSeq: 90, lastLedgerFailureCount: failureEdges(b.g).length }, { config: { ...CONFIG, hotLedgerMinEvents: 5 } });
  t.eq(loose.action !== "skip" || loose.reason !== "throttled-events", true, "把间隔改成 5 之后，10 个事件就不该再被节流挡下");

  // 非法值不许把行为改成"每步都写"：0 / -1 / NaN ⇒ 回落到默认 40
  const c = build();
  const bad = run(c.session, c.g, { ...c.st, lastLedgerInjectSeq: 90, lastLedgerFailureCount: failureEdges(c.g).length }, { config: { ...CONFIG, hotLedgerMinEvents: 0 } });
  t.eq(bad.reason, "throttled-events", "非法值（0）必须回落到默认 40，不许变成每步注入");
};

tests["C251 失败增量门槛可配：hotLedgerMinFailureDelta=0 时只按事件间隔节流"] = (t) => {
  const g = graphWithFailure();
  const st = makeState();
  const session = makeSession({ id: "s-delta", seq: 200 });
  // 每次都要新造一份（decideInjection 会更新 state，复用同一对象会让后面的用例看到前一次的结果）
  const seed = () => ({ ...st, lastLedgerInjectSeq: 10, lastLedgerFailureCount: failureEdges(g).length });
  const seeded = seed();
  const byDefault = run(session, g, seeded);
  t.eq(byDefault.reason, "throttled-failures", "默认（+5 条）⇒ 失败边没变多就被挡下");

  const zero = run(session, g, seed(), { config: { ...CONFIG, hotLedgerMinFailureDelta: 0 } });
  t.eq(zero.reason !== "throttled-failures", true, "设成 0 之后不该再被失败增量挡下");

  // 非法值回落默认 5（负数 / NaN）
  for (const bad of [-1, Number.NaN]) {
    const r = run(session, g, seed(), { config: { ...CONFIG, hotLedgerMinFailureDelta: bad } });
    t.eq(r.reason, "throttled-failures", `非法值 ${String(bad)} 必须回落到 5`);
  }
};
