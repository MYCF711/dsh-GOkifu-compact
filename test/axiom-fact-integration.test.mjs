/**
 * axiom-fact-integration.test.mjs —— AX-09 · 三路径集成行为测试（2026-11-07）
 *
 * 任务卡（`docs/任务书-两条公理纠偏-2026-11-07.md` §5 AX-09）只有一句判据：
 *   **同一条事件流上，online（engine.summarize）/ offline（offline-fold）/ ledger（热清单）
 *   对同一候选的接受/拒绝一致、成功值可见、后续修正 supersede 旧状态、guard=false 全部旧行为。**
 *
 * 本文件的结构（三条路径**共用同一份夹具**，不是三份夹具互相对得上）：
 *
 *   test/fixtures/axiom-fact-integration.json
 *     ├─ events[]        一条 18 事件的会话流（user / assistant / tool-call / tool-result / step-end）
 *     ├─ modelOutput     一份模型输出（9 条事实候选 + 5 条叙事）
 *     └─ expectations    冻结的预期裁决（谁 SUPPORTED / 谁 REJECTED / 为什么）
 *            │
 *            ├─ online  ── engine.summarize（真 engine + 假 ctx，见 test/engine-harness.test.mjs）
 *            ├─ offline ── offline-fold.runOfflineFold / guardOfflineFoldOutput
 *            └─ ledger  ── keeper.observeEvent 落图（AX-04 的 valueFacts）→ renderLedger / hot-inject
 *
 * 四条「不得冒充」的纪律（每条都有机器判据，见用例 ⑦⑧）：
 *   ① 三路径**不许各有一份裁决**：online/offline 都必须 import `fact-guard.mjs` 的
 *      `guardModelOutput`；ledger 只读 `edge.valueFacts`，**不** import 守卫也不 import 抽取器。
 *   ② 一致性必须**行为上**成立：同一份信封 + 同一份证据源 ⇒ 逐字段相同的裁决（不是「看起来像」）。
 *   ③ 证据源的差异必须**被隔离**：两条路径的证据源只差 `tool/call` 摘要行（离线多这一类），
 *      用例 ⑧ 用一个只引用 tool/call seq 的候选证明「差异在源、不在判据」，并把它钉成已知边界。
 *   ④ 夹具是**唯一输入**：预期裁决冻结在 fixture 里，测试不按实现反推期望值。
 *
 * 注：跑这条用例会像其它 engine 用例一样，在 `src/.harness-stubs/`、`src/.engine-under-test.mjs`、
 * `test/.harness/` 下产生**被测 harness 的临时件**（三处都在 `.gitignore` 里，`run.mjs` 退出时删除）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, toJSON, fromJSON, validate, failureEdges } from "../src/rooms/kifu-model.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";
import { guardModelOutput, describeContract, CONTRACT, REASONS, VERDICT, DEFAULT_ENABLED } from "../src/rooms/fact-guard.mjs";
import { extractValueFacts, isValueFact, VALUE_FACT_KINDS } from "../src/rooms/tool-value-facts.mjs";
import { buildGuardSource, collectFoldValueFacts, guardOfflineFoldOutput, applyOfflineGuard, runOfflineFold, buildOfflinePrompt, foldMarkSummaryText } from "../src/rooms/offline-fold.mjs";
import { renderLedger, renderMinimalLedger, renderFacts, collectValueFacts, valueFactDigest } from "../src/rooms/ledger.mjs";
import { decideInjection, messageText as injectMessageText } from "../src/rooms/hot-inject.mjs";
import { resolveConfig, FACT_GUARD_DEFAULT, describe as describeField } from "../src/rooms/config-schema.mjs";
import { describeFactGuardPrompt } from "../src/rooms/facts-prompt.mjs";
import { makeSession, makeCtx, load as loadEngineHarness } from "./engine-harness.test.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const FIXTURE_PATH = nodePath.join(HERE, "fixtures", "axiom-fact-integration.json");
const FIXTURE = JSON.parse(nodeFs.readFileSync(FIXTURE_PATH, "utf8"));
const SESSION_ID = FIXTURE.sessionId;
const SESSION_SAFE = SESSION_ID.replace(/[^A-Za-z0-9._-]/g, "_");
const GRAPHS = nodePath.join(HERE, ".harness", "graphs", "ax09");
const WRITTEN_PATH = FIXTURE.values.writtenPath;

/* ═══════════════════════════ 夹具装配（三条路径共用） ═══════════════════════════ */

/**
 * 把夹具事件按顺序 append 进假 session，并把 `key → 真实 seq` 记下来。
 * 真实 seq 由 session 分配（harness 从 1000 起），所以夹具用 key 引用事件、测试把它解析成 seq。
 * **解析只是编号映射，不参与任何裁决** —— 裁决只吃 `{seq, role, text}` 与候选本身。
 */
function buildStream() {
  const session = makeSession({ id: SESSION_ID });
  const seqs = new Map();
  const events = [];
  for (const spec of FIXTURE.events) {
    if (seqs.has(spec.key)) throw new Error(`夹具事件 key 重复：${spec.key}`);
    const event = session.append(spec.type, spec.data);
    seqs.set(spec.key, event.seq);
    events.push({ key: spec.key, type: spec.type, seq: event.seq, data: spec.data });
  }
  const seqOf = (key) => {
    const value = seqs.get(key);
    if (!Number.isSafeInteger(value)) throw new Error(`夹具引用了不存在的事件 key：${key}`);
    return value;
  };
  const range = { start: Math.min(...events.map((e) => e.seq)), end: Math.max(...events.map((e) => e.seq)) };
  return { session, events, seqs, seqOf, range };
}

/** 用**真 keeper**（R03 + AX-04）把同一批事件落成图。三条路径里的 ledger 臂就用这张图。 */
function buildGraph(events) {
  const g = createGraph({ sessionId: SESSION_ID });
  const state = {
    pendingEdges: new Map(),
    lastNodeId: null,
    lastUserNodeId: null,
    constraintDirty: true,
    touched: [],
    stepEdges: [],
  };
  for (const event of events) observeEvent(g, event, state);
  return g;
}

/** 夹具里的 `evidenceKey / validAtKey` → 真实 seq；**不留**夹具专用字段（守卫的字段白名单很严）。 */
function modelEnvelope(seqOf) {
  const facts = FIXTURE.modelOutput.facts.map((fact) => {
    const out = { id: fact.id, kind: fact.kind, subject: fact.subject, claim: fact.claim };
    if (fact.quote !== undefined) out.quote = fact.quote;
    if (fact.evidenceKey !== undefined) out.evidenceSeq = seqOf(fact.evidenceKey);
    if (fact.validAtKey !== undefined) out.validAtSeq = seqOf(fact.validAtKey);
    if (fact.value !== undefined) out.value = fact.value;
    return out;
  });
  const narratives = FIXTURE.modelOutput.narratives.map((item) => ({ id: item.id, text: item.text, factRefs: [...item.factRefs] }));
  return { facts, narratives };
}

function writeGraphDir(name, graph) {
  const dir = nodePath.join(GRAPHS, name);
  const sessDir = nodePath.join(dir, "sessions", SESSION_SAFE);
  nodeFs.mkdirSync(sessDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sessDir, "graph.json"), toJSON(graph), "utf8");
  return dir;
}

/* ═══════════════════════════ 三条路径 ═══════════════════════════ */

/**
 * online：**真 engine 的 summarize 钩子**（R09，唯一官方钩子）。
 * 假 ctx 只 stub `@deepseek-ai/*`；模型输出由 `globalThis.__D460_SUMMARY_TEXT__` 喂给假 BlockAssembler
 * —— 与既有 engine-harness 用例同一套装置，因此不碰生产实例、不调真模型。
 */
async function runOnline({ id, graph, session, range, factGuard, modelText }) {
  const { Engine } = await loadEngineHarness();
  const dir = writeGraphDir(id, graph);
  const ctx = makeCtx();
  globalThis.__D460_SUMMARY_TEXT__ = modelText;
  try {
    const engine = new Engine(ctx, factGuard === undefined ? { graphDir: dir, auto: false } : { graphDir: dir, auto: false, factGuard });
    engine._chessActiveRange = range;
    const out = await engine.summarize({ messages: [] }, { session }, undefined);
    const instruction = ctx.streamCalls.at(-1)?.messages?.at(-1)?.content?.[0]?.text ?? "";
    const text = (out?.summary ?? []).map((block) => String(block.text ?? "")).join("\n");
    return { out, engine, ctx, instruction, text, calls: ctx.streamCalls.length };
  } finally {
    globalThis.__D460_SUMMARY_TEXT__ = undefined;
  }
}

/** offline：**真离线补折编排**（runOfflineFold + 注入的 callModel，零网络）。 */
async function runOffline({ graph, events, range, factGuard, modelText }) {
  const calls = [];
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: range.start,
    rangeEnd: range.end,
    factGuard,
    sessionId: SESSION_ID,
    maxChunks: 1,
    callModel: async (text, opts) => {
      calls.push({ text, opts });
      return { text: modelText, model: "fake-ax09", usage: { inputTokens: 1, outputTokens: 1 }, finish: "stop" };
    },
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  return { out, chunk: out.chunks[0] ?? null, calls };
}

/* ── ledger 臂：热清单（R06）+ 注入判决（R08）的假 session port ── */

const INJECT_CONFIG = { hotLedgerReplace: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerTraceRoot: "sessions", hotLedger: true };

function makeInjectSession(id) {
  let seq = 1000;
  const events = new Map();
  const nodes = [];
  return {
    id,
    surface: { nodes },
    get seq() {
      return seq;
    },
    eventAt: (s) => events.get(s),
    append(type, data, opts = {}) {
      const s = seq++;
      const event = { type, seq: s, data };
      events.set(s, event);
      const op = opts.surfaceOp;
      if (op && op.op === "replace") {
        const i = nodes.indexOf(op.startSeq);
        if (i < 0) throw new Error("harness: 锚点不在 surface 上");
        nodes.splice(i, 1, s);
      } else nodes.push(s);
      return event;
    },
    push(data) {
      const s = seq++;
      nodes.push(s);
      events.set(s, { type: "user/message", seq: s, data });
      return s;
    },
  };
}

function makeInjectState(over = {}) {
  return { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [], ...over };
}

function injectRun(session, graph, state, config = INJECT_CONFIG) {
  return decideInjection({
    session,
    graph,
    state,
    config,
    sessionDir: "",
    decision: { kind: "enter", messages: [] },
    payloadMessages: [],
    createUserMessage: (input) => ({ id: `m-${Math.random().toString(36).slice(2)}`, role: "user", ...input }),
  });
}

/** surface 上最后一条真清单的正文（没有就空串）。 */
function injectedLedgerText(session) {
  const last = [...session.surface.nodes]
    .reverse()
    .map((seq) => session.eventAt(seq))
    .find((event) => event?.data?.source?.kind === "chess-context");
  return last ? injectMessageText(last.data) : "";
}

/** 把首次注入的那条消息真正放进 surface（模拟宿主落盘）。 */
function commitInjection(session, result) {
  const message = result.decision.messages.find((m) => m?.source?.kind === "chess-context");
  if (message) session.push(message);
  return message;
}

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

/** 按 `## ` 切段（同名段合并）。 */
function sections(text) {
  const buckets = {};
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    const match = /^##[ \t]+(.+)$/.exec(line);
    if (match) {
      current = match[1].trim();
      buckets[current] = buckets[current] ?? [];
      continue;
    }
    if (current !== null) buckets[current].push(line);
  }
  const out = {};
  for (const [name, lines] of Object.entries(buckets)) out[name] = lines.join("\n");
  return out;
}

/** 裁决数组 → `{id: verdict}`（逐条对齐用）。 */
function verdictMap(verdicts, key = "id") {
  const out = {};
  for (const item of Array.isArray(verdicts) ? verdicts : []) out[item?.[key] ?? "?"] = item?.verdict ?? null;
  return out;
}

/** 值事实集合（有序数组，用于跨路径对拍）。 */
function valueKeySet(facts) {
  return (Array.isArray(facts) ? facts : [])
    .map((fact) => `${fact.kind}|${typeof fact.value}|${String(fact.value)}|${fact.evidenceSeq}|${fact.source ?? "?"}`)
    .sort();
}

function readSource(rel) {
  return nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");
}

/* ═════════════════════════════════ 用例 ═════════════════════════════════ */

tests["AX-09 ⓪ 同一事件流：夹具 → session / 事件数组 / 图 三处 seq 逐条一致，两条证据源对消息事件逐条同文"] = (t) => {
  const { session, events, seqOf } = buildStream();
  const graph = buildGraph(events);
  t.eq(events.length, FIXTURE.events.length, "事件条数必须与夹具一致");
  const surface = session.surface.nodes;
  t.eq(surface.slice(surface.length - events.length), events.map((e) => e.seq), "事件数组的 seq 必须就是 surface 上的节点（同一条流，不是副本）");
  t.eq(events.map((e) => e.key), FIXTURE.events.map((e) => e.key), "顺序必须与夹具一致（同一事件流）");

  // 图必须由同一批事件落成（keeper 的边数/节点数/失败边就是这批事件的产物）
  t.eq(validate(graph), [], "keeper 落出来的图必须通过 R00 校验");
  t.eq(Object.keys(graph.edges).length, 4, "4 次工具调用 ⇒ 4 条边");
  t.eq(failureEdges(graph).length, 1, "1 条失败边（isError 的那次 bash）");
  for (const edge of Object.values(graph.edges)) {
    t.eq(edge.evidence.start <= seqOf("t4") && edge.evidence.end >= seqOf("u1"), true, `边 ${edge.id} 的证据区间必须落在本事件流内`);
  }

  // 两条守卫证据源：对**消息事件**逐条同文，差别只在 tool/call 摘要行
  const offlineSource = buildGuardSource(events, { sessionId: SESSION_ID });
  const messageEvents = events.filter((e) => e.type !== "tool/call");
  const engineShape = buildGuardSource(messageEvents, { sessionId: SESSION_ID });
  t.eq(engineShape.sessionId, offlineSource.sessionId, "两个源必须指向同一个会话（跨会话 seq 判据依赖它）");
  t.eq(offlineSource.events.length - engineShape.events.length, events.filter((e) => e.type === "tool/call").length, "差集必须恰好是 tool/call 摘要行");
  const bySeq = new Map(offlineSource.events.map((e) => [e.seq, e]));
  for (const event of engineShape.events) {
    const twin = bySeq.get(event.seq);
    t.ok(twin !== undefined, `seq ${event.seq} 必须在两份源里都存在`);
    t.eq(twin, event, `seq ${event.seq} 的 role/text 必须逐字相同（否则「同一证据」是假的）`);
  }
  // 反向：tool/call 行确实只在离线源里（钉子，避免未来有人以为两条源本来一样）
  for (const seq of events.filter((e) => e.type === "tool/call").map((e) => e.seq)) {
    t.eq(engineShape.events.some((e) => e.seq === seq), false, `seq ${seq} 是 tool/call，在线源不该有它`);
    t.eq(offlineSource.events.some((e) => e.seq === seq), true, `seq ${seq} 是 tool/call，离线源应该有它`);
  }
  // 种子 system 事件（空文本）两边都不计入
  t.eq(offlineSource.events.length, events.filter((e) => e.type !== "system/message" && e.type !== "step/end").length, "离线源 = 除 system（空）与 step/end 之外的每个非空事件");
};

tests["AX-09 ① 三路径同一裁决：online 报告 === offline 记录 === 参考信封（逐条对齐夹具冻结的预期）"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);

  const engineShape = buildGuardSource(events.filter((e) => e.type !== "tool/call"), { sessionId: SESSION_ID });
  const offlineShape = buildGuardSource(events, { sessionId: SESSION_ID });
  const reference = guardModelOutput(envelope, { factGuard: true, session: engineShape });
  const referenceOfflineShape = guardModelOutput(envelope, { factGuard: true, session: offlineShape });

  /* ① 两个证据源形状 ⇒ 同一份裁决（源差异对这批候选无影响；证明见用例 ⑧ 的隔离实验） */
  t.eq(referenceOfflineShape.facts, reference.facts, "两种证据源对同一批事实候选必须给出逐字段相同的裁决");
  t.eq(referenceOfflineShape.narratives, reference.narratives, "叙事裁决同理");
  t.eq(referenceOfflineShape.summary, reference.summary, "汇总计数同理");

  /* ② 夹具冻结的预期（**先写预期、再跑实现**；不是按实现反推） */
  t.eq(verdictMap(reference.facts), FIXTURE.expectations.facts, "逐条裁决必须等于夹具里冻结的预期");
  t.eq(verdictMap(reference.narratives), FIXTURE.expectations.narratives, "叙事裁决必须等于夹具里冻结的预期");
  for (const [id, codes] of Object.entries(FIXTURE.expectations.factReasons)) {
    const verdict = reference.facts.find((f) => f.id === id);
    t.eq((verdict?.reasons ?? []).map((r) => r.code), codes, `${id} 的拒绝原因码必须等于预期`);
  }
  const s = reference.summary;
  const expected = FIXTURE.expectations.summary;
  t.eq([s.total, s.supported, s.unverified, s.pending, s.rejected], [expected.total, expected.supported, expected.unverified, expected.pending, expected.rejected], "事实分母必须等于预期");
  t.eq([s.narratives.total, s.narratives.supported, s.narratives.unverified, s.narratives.rejected], [expected.narratives.total, expected.narratives.supported, expected.narratives.unverified, expected.narratives.rejected], "叙事分母必须等于预期");
  t.eq(s.semanticEntailment, "NOT_PROVEN", "机械命中不许宣称语义蕴含（契约恒 false/NOT_PROVEN）");
  t.eq(reference.facts.every((f) => f.entailmentProven === false), true, "每条事实裁决的 entailmentProven 必须恒 false");

  /* ③ online：真 engine.summarize 的报告必须与参考信封同数 */
  const online = await runOnline({ id: "ax09-on", graph, session, range, factGuard: true, modelText: raw });
  t.eq(online.calls, 1, "同一次模型调用：裁决不许再发一个请求");
  t.eq(online.out.factGuard?.enabled, true, "引擎必须报告守卫已启用");
  t.eq(online.out.factGuard?.applied, true, "合法结构必须 applied");
  t.eq(online.out.factGuard?.degraded, false, "合法结构不许降级");
  t.eq(online.out.factGuard?.degradedReason, null, "没有降级原因");
  t.eq(
    [online.out.factGuard.facts, online.out.factGuard.supported, online.out.factGuard.unverified, online.out.factGuard.pending, online.out.factGuard.rejected],
    [s.total, s.supported, s.unverified, s.pending, s.rejected],
    "online 的事实计数必须等于参考信封",
  );
  t.eq(
    [online.out.factGuard.narratives, online.out.factGuard.narrativesSupported],
    [s.narratives.total, s.narratives.supported],
    "online 的叙事计数必须等于参考信封",
  );
  t.eq(online.out.factGuard.evidenceEvents, engineShape.events.length, "online 实际读到的证据事件数必须等于消息证据源条数");
  t.eq(online.out.degraded, undefined, "事实被拒 ≠ 结构降级");

  /* ④ offline：真离线编排的留痕记录必须与参考信封**逐字段**相同 */
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: raw });
  t.eq(offline.calls.length, 1, "离线臂同样只许一次模型调用");
  t.eq(offline.chunk?.guard?.facts, reference.facts, "离线记录的 facts 必须与参考信封逐字段相同（不许自己再判一遍）");
  t.eq(offline.chunk?.guard?.narratives, reference.narratives, "离线记录的 narratives 必须逐字段相同");
  t.eq(offline.chunk?.guard?.summary, reference.summary, "离线记录的 summary 必须逐字段相同");
  t.eq(offline.chunk?.guard?.verdict, "UNVERIFIED", "整份摘要的汇总裁决（有未验证正文 ⇒ UNVERIFIED）");
  t.eq(offline.chunk?.guard?.rejectedNarratives, 1, "被拒叙事恰好 1 条");

  /* ⑤ 三处汇总必须同一份（online 报告 / offline 记录 / 参考信封） */
  t.eq(
    [offline.chunk.guard.summary.supported, offline.chunk.guard.summary.rejected],
    [online.out.factGuard.supported, online.out.factGuard.rejected],
    "online 与 offline 的接受/拒绝计数必须相等",
  );
  // ledger 臂不重判模型事实 —— 它只按 AX-02 的存储契约接收值事实（见用例 ③ 的 malformed 判据）
  t.eq(collectValueFacts(graph).total, 5, "ledger 臂读到 5 条值事实（与两条裁决路径用的同一事件流）");
};

tests["AX-09 ② 无证据事实不落、被拒叙事不渲染（online 段落 / offline 正文同一判据）"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);
  const online = await runOnline({ id: "ax09-render-on", graph, session, range, factGuard: true, modelText: raw });
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: raw });
  const onlineSections = sections(online.text);

  /* ① 被拒事实 / 引用被拒事实的叙事：两条渲染产物都一个字都不能有 */
  for (const claim of FIXTURE.expectations.rendered.mustNotContainClaims) {
    t.notIncludes(online.text, claim, `被拒事实的 claim 不许渲染：${claim}`);
    t.notIncludes(offline.chunk.text, claim, `被拒事实的 claim 不许进离线正文：${claim}`);
  }
  for (const narrative of FIXTURE.expectations.rendered.mustNotContainNarratives) {
    t.notIncludes(online.text, narrative, `引用被拒事实的叙事不许渲染：${narrative}`);
    t.notIncludes(offline.chunk.text, narrative, `引用被拒事实的叙事不许进离线正文：${narrative}`);
  }

  /* ② 被接受的事实：online 必须在事实段里带 claim + evidence seq */
  for (const id of FIXTURE.expectations.rendered.mustContainFacts) {
    const verdict = envelope.facts.find((f) => f.id === id);
    t.includes(online.text, `[${id}]`, `被接受的事实必须带 id：${id}`);
    t.includes(online.text, verdict.claim, `被接受的事实必须保留 claim：${id}`);
    t.includes(online.text, `（evidence seq ${verdict.evidenceSeq}）`, `被接受的事实必须带可回证的 evidence seq：${id}`);
  }
  t.includes(onlineSections["目标"] ?? "", "[f-constraint]", "constraint 事实进「目标」段");
  t.includes(onlineSections["棋谱（状态节点）"] ?? "", "[f-build-new]", "state 事实进「棋谱」段");
  t.includes(onlineSections["已探明死路"] ?? "", "[f-fail]", "failure 事实进「已探明死路」段");
  t.includes(onlineSections["已验证事实"] ?? "", "src/a.mjs 已创建", "成功 write 的值事实进「已验证事实」段");

  /* ③ 无证据事实：只能进「未验证」，且必须写明原因码 */
  for (const id of FIXTURE.expectations.rendered.unverifiedIds) {
    if (id.startsWith("f-")) {
      t.includes(onlineSections["未验证"] ?? "", `[${id}]`, `无证据事实只能进「未验证」：${id}`);
      t.includes(onlineSections["未验证"] ?? "", "NO_EVIDENCE", "无证据必须写明 NO_EVIDENCE");
      t.notIncludes(onlineSections["叙事"] ?? "", `[${id}]`, `无证据事实不许出现在「叙事」段：${id}`);
    }
  }
  t.includes(onlineSections["未验证"] ?? "", "用户已经同意删除全部测试。", "无 factRefs 的叙事只能进「未验证」");
  t.includes(onlineSections["未验证"] ?? "", "NO_FACT_REFS", "无引用叙事必须写明 NO_FACT_REFS");
  t.includes(onlineSections["未验证"] ?? "", "CITED_UNVERIFIED_FACT", "引用未验证事实的叙事必须标明降级原因");

  /* ④ 被接受的叙事：online 进「叙事」段；offline 正文必须有，且带非 SUPPORTED 的机器标记行 */
  t.includes(onlineSections["叙事"] ?? "", "构建改成 npm。", "SUPPORTED 叙事必须渲染");
  t.includes(onlineSections["叙事"] ?? "", "引用事实：f-build-new", "叙事必须标出引用的事实 id");
  t.includes(offline.chunk.text, "构建改成 npm。", "离线正文必须保留被接受的叙事");
  t.includes(offline.chunk.text, "已创建 src/a.mjs；仓库 id 4242、private=false。", "离线正文必须保留引用成功值事实的叙事");
  t.includes(offline.chunk.text, "> 事实守卫：UNVERIFIED", "离线正文必须带机器标记行（读者看不到 JSON 里的裁决）");
  t.includes(offline.chunk.text, "NO_EVIDENCE", "标记行必须列出原因码");

  /* ⑤ 机械补回不受影响（防「守卫把正文清空了反而更绿」） */
  t.includes(online.text, "## 约束（机械保留，逐字；不由模型改写）", "在线路径的约束机械补回必须保留");
  t.includes(online.text, "不许动 prod 配置", "约束内容必须还在");
  t.includes(offline.chunk.text, "## 已探明死路（逐字补充", "离线路径的死路机械补回必须保留");
  t.includes(offline.chunk.text, "EACCES", "补回的死路必须带原因原文");
};

tests["AX-09 ③ 成功值可见且可回证：keeper 边 / 离线抽取 / 热清单 / 注入消息 / 事实块五处同一批值"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);
  const keeperFacts = Object.values(graph.edges).flatMap((edge) => (Array.isArray(edge.valueFacts) ? edge.valueFacts : []));
  const offlineFacts = collectFoldValueFacts(events, { rangeStart: range.start, rangeEnd: range.end });

  /* ① 存储侧与离线抽取器必须产出**同一批**值（同源、同契约） */
  t.eq(valueKeySet(keeperFacts), valueKeySet(offlineFacts), "keeper（AX-04）与 offline（AX-07）抽出的值事实必须同一批");
  t.eq(keeperFacts.length, 5, "5 条值事实：file_created / id / boolean / config / file_updated");
  t.eq(keeperFacts.every((fact) => isValueFact(fact)), true, "每条都必须满足 AX-02 的六字段契约");
  t.eq(keeperFacts.map((fact) => fact.source).sort(), ["tool:bash", "tool:bash", "tool:bash", "tool:edit", "tool:write"], "source 必须指回产出它的工具");

  /* ② 热清单：每条值一行、带原文 seq、种类在闭集内 */
  const ledger = renderLedger(graph, { factGuard: true });
  t.eq(ledger.valueFactStats, { total: 5, shown: 5, omitted: 0, malformed: 0 }, "热清单必须 5 条全展开、0 条坏数据");
  t.ne(ledger.text, renderLedger(graph).text, "非恒真控制：guard=true 的热清单必须真的比 guard=false 多出内容");
  for (const fact of keeperFacts) {
    t.eq(VALUE_FACT_KINDS.includes(fact.kind), true, `值事实 kind 必须在 AX-02 闭集内：${fact.kind}`);
    t.includes(ledger.text, String(fact.value), `值必须逐字可见：${fact.kind}`);
    t.includes(ledger.text, `(seq ${fact.evidenceSeq})`, `每条值都必须带原文 seq：${fact.kind}`);
  }
  // K-2 的两个退化形状，逐字钉住（S1-Q1 成功 write 的 Created file / S2-Q3 仓库 API 的 id、private）
  t.includes(ledger.text, `- e1 file_created ${WRITTEN_PATH} (seq ${seqOf("t1")})`, "S1-Q1：Created file 的路径必须可见且可回证");
  t.includes(ledger.text, `- e2 id ${FIXTURE.values.apiId} (seq ${seqOf("t2")})`, "S2-Q3：仓库 id 必须可见且可回证");
  t.includes(ledger.text, `- e2 boolean private=${FIXTURE.values.apiPrivate} (seq ${seqOf("t2")})`, "S2-Q3：private 必须带键名 + 可回证");
  t.includes(ledger.text, `- e4 file_updated ${WRITTEN_PATH} (seq ${seqOf("t4")})`, "修正后的写回执同样可见");
  t.eq(/VALUE FACTS \(verbatim; source seq per line\):/.test(ledger.text), true, "值事实段必须有固定标题（不是隐身字段）");
  // 长值（936 字 description）**一条都没进**热清单：只留短值，不回灌
  t.eq(ledger.text.includes("这是一个刻意做长的仓库描述"), false, "长 description 不许进热清单（只留短值）");

  /* ③ 离线提示词：同一批值以 `seq + quote` 的形式喂给模型（不是全文回灌） */
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: raw });
  const prompt = offline.calls[0]?.text ?? "";
  t.includes(prompt, "## 成功工具结果的值（可回证）", "离线提示词必须有值事实段");
  for (const fact of offlineFacts) {
    t.includes(prompt, `seq ${fact.evidenceSeq}`, `离线提示词必须给证据 seq：${fact.kind}`);
    t.includes(prompt, fact.quote, `离线提示词必须给逐字 quote（模型能照抄、守卫能回证）：${fact.kind}`);
  }
  t.eq(JSON.stringify(offlineFacts).length < raw.length * 2, true, "值事实不许把整份工具结果搬进提示词");
  t.includes(offline.chunk.text, "已创建 src/a.mjs；仓库 id 4242、private=false。", "被接受的值叙事必须落进离线正文");

  /* ④ 在线事实块：同一批值以 `kind: value (evidence seq N)` 的形式进摘要指令 */
  const online = await runOnline({ id: "ax09-values-on", graph, session, range, factGuard: true, modelText: raw });
  t.includes(online.instruction, "VALUE_FACTS (extracted mechanically from successful tool results", "在线事实块必须有值事实段");
  t.includes(online.instruction, `* file_created: ${WRITTEN_PATH} (evidence seq ${seqOf("t1")})`, "在线事实块必须带路径 + seq");
  t.includes(online.instruction, `* id: ${FIXTURE.values.apiId} (evidence seq ${seqOf("t2")})`, "在线事实块必须带 API id + seq");
  t.includes(online.instruction, `* boolean: ${FIXTURE.values.apiPrivate} (evidence seq ${seqOf("t2")})`, "在线事实块必须带 boolean + seq");
  t.includes(online.instruction, `* file_updated: ${WRITTEN_PATH} (evidence seq ${seqOf("t4")})`, "在线事实块必须带修正后的值");

  /* ⑤ 摘要硬事实块（renderFacts，AX-08 的第三个消费者） */
  const factsOn = renderFacts(graph, { factGuard: true });
  t.includes(factsOn, "VALUE_FACTS_VERBATIM (5 of 5", "摘要硬事实块必须列全 5 条");
  for (const fact of keeperFacts) t.includes(factsOn, `evidence=seq ${fact.evidenceSeq}`, `摘要硬事实块必须带 evidence=seq：${fact.kind}`);

  /* ⑤.b 零失败最小清单（renderMinimalLedger）：零失败会话的唯一注入内容，同样必须带值 */
  const minimal = renderMinimalLedger(graph, { factGuard: true });
  t.includes(minimal.text, `- e1 file_created ${WRITTEN_PATH} (seq ${seqOf("t1")})`, "零失败最小清单也必须带值事实（否则零失败会话静默丢值）");
  t.eq(minimal.valueFactStats.total, 5, "最小清单同样要报值事实的条数账");

  /* ⑥ 热清单注入（R08）：guard 开启时同一批值真的到达下一步 */
  const injectSession = makeInjectSession("ax09-inject-values");
  const injected = injectRun(injectSession, graph, makeInjectState(), { ...INJECT_CONFIG, factGuard: true });
  commitInjection(injectSession, injected);
  const injectedText = injectedLedgerText(injectSession);
  t.includes(injectedText, "VALUE FACTS", "注入消息必须有值事实段");
  t.includes(injectedText, `file_created ${WRITTEN_PATH} (seq ${seqOf("t1")})`, "注入消息必须带 Created file 路径 + seq");
  t.includes(injectedText, `id ${FIXTURE.values.apiId} (seq ${seqOf("t2")})`, "注入消息必须带 API id + seq");
  t.includes(injectedText, `private=${FIXTURE.values.apiPrivate} (seq ${seqOf("t2")})`, "注入消息必须带 private + seq");

  /* ⑦ 契约一致性（接受/拒绝）：ledger 按 AX-02 的存储契约接收值事实 —— 抽取器不可能产出的形状必须被两边同时拒 */
  t.eq(collectValueFacts(graph).malformed, 0, "真实的 5 条必须 0 malformed（否则下面的「拒绝」是恒真）");
  const mutants = [
    ["未知 kind", (f) => ({ ...f, kind: "not_a_kind" })],
    ["文件类值不是字符串", (f) => ({ ...f, kind: "file_created", value: 42 })],
    ["boolean 值不是布尔", (f) => ({ ...f, kind: "boolean", value: "false" })],
    ["quote 为空", (f) => ({ ...f, quote: "" })],
    ["evidenceSeq 为负", (f) => ({ ...f, evidenceSeq: -1 })],
    ["evidenceSeq 非整数", (f) => ({ ...f, evidenceSeq: 1.5 })],
    ["值为空串", (f) => ({ ...f, value: "" })],
  ];
  for (const [label, mutate] of mutants) {
    const broken = fromJSON(toJSON(graph));
    broken.edges.e9 = {
      id: "e9",
      from: "n5",
      to: "n5",
      intent: "脏数据",
      action: "write(file_path=D:/x/a.mjs)",
      result: "success",
      verify: { kind: "write", summary: "ok" },
      evidence: { start: seqOf("t1"), end: seqOf("t1") },
      transposition: false,
      ts: 1,
      valueFacts: [mutate(keeperFacts[0])],
    };
    const collected = collectValueFacts(broken);
    t.eq(isValueFact(mutate(keeperFacts[0])), false, `AX-02 契约必须拒绝：${label}`);
    t.eq(collected.malformed, 1, `ledger 必须把「${label}」计入 malformed（不许静默丢）`);
    t.eq(collected.facts.length, 5, `ledger 只许收下真实那 5 条，不许收「${label}」`);
  }
};

tests["AX-09 ④ 后续修正 supersede 旧状态：旧「当前」主张被拒、引用它的叙事消失、热清单换成修正后的目标"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);
  const oldFact = envelope.facts.find((f) => f.id === "f-build-old");
  const newFact = envelope.facts.find((f) => f.id === "f-build-new");
  t.ok(oldFact !== undefined && newFact !== undefined, "夹具必须同时有修正前/修正后的两条状态候选");

  /* ① 裁决层：同一句「当前……」在修正**到达之前**是 SUPPORTED，到达之后必须 REJECTED(STALE_CURRENT) */
  const prefixEvents = events.filter((e) => e.seq <= seqOf("step2"));
  const prefixSource = buildGuardSource(prefixEvents, { sessionId: SESSION_ID });
  const beforeCorrection = guardModelOutput(envelope, { factGuard: true, session: prefixSource });
  const beforeVerdict = beforeCorrection.facts.find((f) => f.id === "f-build-old");
  t.eq(beforeVerdict?.verdict, "SUPPORTED", "修正事件还没出现时，这句「当前」必须是通过的（否则下面那条拒绝就没有意义）");
  const fullSource = buildGuardSource(events, { sessionId: SESSION_ID });
  const afterCorrection = guardModelOutput(envelope, { factGuard: true, session: fullSource });
  const afterVerdict = afterCorrection.facts.find((f) => f.id === "f-build-old");
  t.eq(afterVerdict?.verdict, "REJECTED", "修正事件到达后，旧「当前」必须被拒");
  t.eq(afterVerdict?.reasons?.map((r) => r.code), ["STALE_CURRENT"], "拒绝原因必须是 STALE_CURRENT（过期「当前」）");
  t.eq(afterCorrection.facts.find((f) => f.id === "f-build-new")?.verdict, "SUPPORTED", "修正后的「当前」必须通过");
  t.eq(afterCorrection.narratives.find((n) => n.id === "n-old")?.verdict, "REJECTED", "引用旧状态事实的叙事必须被拒");
  t.eq(afterCorrection.narratives.find((n) => n.id === "n-new")?.verdict, "SUPPORTED", "引用新状态事实的叙事必须通过");

  /* ② 渲染层：两条路径都只留新状态，旧状态一个字不落 */
  const online = await runOnline({ id: "ax09-supersede-on", graph, session, range, factGuard: true, modelText: raw });
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: raw });
  t.includes(online.text, "当前构建用 npm", "在线渲染必须出现修正后的状态");
  t.notIncludes(online.text, "当前构建用 pnpm", "在线渲染不许出现被取代的旧状态");
  t.notIncludes(online.text, "当前构建用 pnpm，方案已验证。", "引用旧状态的叙事不许出现在在线摘要里");
  t.includes(offline.chunk.text, "构建改成 npm。", "离线正文必须保留修正后的叙事");
  t.notIncludes(offline.chunk.text, "当前构建用 pnpm，方案已验证。", "离线正文不许保留引用旧状态的叙事");
  t.eq(offline.chunk.guard.rejectedNarratives, 1, "离线记录必须记下「丢了 1 条被拒叙事」");

  /* ③ 热清单层：CURRENT GOAL 从修正前的目标换成修正后的目标（旧状态不再是「当前」） */
  const prefixGraph = buildGraph(prefixEvents);
  const beforeLedger = renderLedger(prefixGraph, { factGuard: true }).text;
  const afterLedger = renderLedger(graph, { factGuard: true }).text;
  t.includes(beforeLedger, "CURRENT GOAL: 直接读 prod 配置试试。", "修正前的热清单：当前目标必须还是那条旧尝试");
  t.notIncludes(beforeLedger, "把构建脚本换成 npm。", "修正前的热清单不许出现修正后的目标");
  t.includes(afterLedger, "CURRENT GOAL: 把构建脚本换成 npm。", "修正后的热清单：当前目标必须换成修正后的目标");
  t.notIncludes(afterLedger, "CURRENT GOAL: 直接读 prod 配置试试。", "旧目标不许继续占着 CURRENT GOAL");
  // ROOT USER 仍逐字保留旧原话 —— 这是**历史**，不是「当前状态」（supersede 不等于抹掉历史）
  t.includes(afterLedger, "ROOT USER (verbatim): 把构建跑通", "根目标原话必须逐字保留（历史不能被 supersede）");

  /* ④ 值事实层：修正带来的新值让 digest 变化，注入侧据此把新状态送达（旧状态不再被重复注入） */
  const beforeDigest = valueFactDigest(prefixGraph);
  const afterDigest = valueFactDigest(graph);
  t.ne(beforeDigest, afterDigest, "修正后的值集合必须让 digest 变化");
  t.eq(afterLedger.includes(`file_updated ${WRITTEN_PATH} (seq ${seqOf("t4")})`), true, "修正后的值必须带自己的（更晚的）seq");
  t.ok(seqOf("t4") > seqOf("t1"), "修正的证据 seq 必须晚于原值（可排序 = 可判断谁取代谁）");

  // 注入侧：先注入修正前的清单，再拿修正后的图 —— guard=true 必须立刻替换送达
  const sessionOn = makeInjectSession("ax09-supersede-on");
  const stateOn = makeInjectState();
  commitInjection(sessionOn, injectRun(sessionOn, prefixGraph, stateOn, { ...INJECT_CONFIG, factGuard: true }));
  const delivered = injectRun(sessionOn, graph, stateOn, { ...INJECT_CONFIG, factGuard: true });
  t.eq(delivered.action, "replace", "值集合变了 ⇒ 必须立刻替换送达（不许被失败边口径的限流挡住）");
  t.includes(injectedLedgerText(sessionOn), `file_updated ${WRITTEN_PATH} (seq ${seqOf("t4")})`, "送达的清单必须是修正后的值");
  t.includes(injectedLedgerText(sessionOn), "CURRENT GOAL: 把构建脚本换成 npm。", "送达的清单必须带修正后的目标");

  // 反例：guard 关掉时同一对图必须仍按旧判据跳过（证明上面那条不是「限流被改坏了」）
  const sessionOff = makeInjectSession("ax09-supersede-off");
  const stateOff = makeInjectState();
  commitInjection(sessionOff, injectRun(sessionOff, prefixGraph, stateOff));
  const skipped = injectRun(sessionOff, graph, stateOff);
  t.eq(skipped.action, "skip", "guard 关掉时值变化不许绕过限流（旧行为逐字不变）");
  t.eq(skipped.reason, "identical", "guard 关掉时渲染结果一字不差 ⇒ identical");
};

tests["AX-09 ⑤ factGuard:false ⇒ 三路径全部旧行为（指令 / 产物 / 折痕 / 渲染逐字不变）"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);

  /* ① online：默认不传 与 显式 false 必须逐字节相同，并且完全不解析模型输出 */
  const implicit = await runOnline({ id: "ax09-off-implicit", graph, session, range, modelText: raw });
  const explicit = await runOnline({ id: "ax09-off-explicit", graph, session, range, factGuard: false, modelText: raw });
  t.eq(implicit.instruction, explicit.instruction, "guard 关掉时指令必须逐字节相同（默认 = 显式 false）");
  t.eq(implicit.text, explicit.text, "guard 关掉时摘要正文必须逐字相同");
  t.eq(implicit.out.summary, explicit.out.summary, "返回值形状与内容必须逐字相同");
  // 旧行为 = **把模型输出原样当摘要**（不解析、不裁决、不过滤）
  t.eq(implicit.out.summary[0]?.text, raw, "guard 关掉时模型输出必须原样落进摘要（零解析）");
  // 非恒真控制：guarded 臂（用例 ①②④）之所以看不到这些 claim，是**守卫删掉的**，不是它们本来就不在
  // 模型输出里 —— 关掉开关，同一份输出原样落进摘要，被拒的 claim 也就在里面。
  t.includes(implicit.text, "当前构建用 pnpm", "guard 关掉时被拒的 claim 会原样进摘要（证明「被拒」是守卫做的）");
  t.includes(implicit.text, "用户创建了 src/a.mjs", "同上：主体混同的 claim 在关掉时也在正文里");
  t.eq(implicit.out.factGuard, undefined, "guard 关掉时不许出现 factGuard 报告");
  t.eq(implicit.engine._lastSummaryFactGuard, undefined, "guard 关掉时不许留下守卫状态");
  t.eq(Object.keys(implicit.out).sort(), ["llmStreamCall", "maxTokens", "model", "provider", "rawOutput", "summary"], "返回值不许新增字段");
  t.notIncludes(implicit.instruction, "VALUE_FACTS", "guard 关掉时值事实不许进事实块");
  t.notIncludes(implicit.instruction, "## 成功工具结果的值", "guard 关掉时不许出现值事实段");
  t.notIncludes(implicit.instruction, '"facts": [', "guard 关掉时不许要求 JSON 信封");
  t.includes(implicit.instruction, "Output EXACTLY this Markdown structure", "guard 关掉时必须还是旧的 Markdown 输出契约");
  t.eq(implicit.calls, 1, "guard 关掉时同样是一次模型调用");

  /* ② offline：提示词逐字不变、chunk 不长新键、正文 = 模型原文（+ 机械补回） */
  const offline = await runOffline({ graph, events, range, factGuard: false, modelText: raw });
  t.eq("guard" in offline.chunk, false, "guard 关掉时 chunk 不许长 guard 键");
  t.eq("valueFacts" in offline.chunk, false, "guard 关掉时 chunk 不许长 valueFacts 键");
  t.eq(offline.chunk.text.startsWith(raw), true, "guard 关掉时离线正文必须原样包含模型输出");
  t.notIncludes(offline.calls[0].text, "事实守卫", "guard 关掉时提示词里没有守卫段");
  t.notIncludes(offline.calls[0].text, "## 成功工具结果的值", "guard 关掉时提示词里没有值事实段");
  t.notIncludes(offline.calls[0].text, "Output EXACTLY ONE JSON object", "guard 关掉时不许要求 JSON 信封");
  const promptBase = buildOfflinePrompt({ facts: "F", messages: [{ role: "user", nodeId: "n1", seq: 1, text: "hi" }] });
  const promptOff = buildOfflinePrompt({
    facts: "F",
    messages: [{ role: "user", nodeId: "n1", seq: 1, text: "hi" }],
    factGuard: false,
    valueFacts: collectFoldValueFacts(events, { rangeStart: range.start, rangeEnd: range.end }),
  });
  t.eq(promptOff, promptBase, "guard 关掉时值事实参数不许影响提示词（逐字）");
  // 折痕写回：guard 关掉时 foldMark 与 lastOfflineSummary 都不长 guard 键
  const { applyOfflineFoldToGraph } = await import("../src/rooms/offline-fold.mjs");
  const written = fromJSON(toJSON(graph));
  applyOfflineFoldToGraph(written, offline.out, { rangeStart: range.start, rangeEnd: range.end, maxSeq: range.end });
  const mark = (written.foldMarks ?? []).at(-1);
  t.eq(mark?.guard, undefined, "guard 关掉时折痕不许带 guard 记录");
  t.eq(foldMarkSummaryText(written, mark).includes("事实守卫"), false, "guard 关掉时折痕正文不许出现守卫标记");

  /* ③ ledger / hot-inject：默认、显式 false、删掉 valueFacts 三者逐字节相同 */
  // 注意：**用同一批事件重建**一张图再删字段，而不是 `fromJSON(toJSON())` 往返 ——
  //   加载边界会按约束历史回填 constraintHash（fromJSON 的既有修复），那会让 CURRENT_STATE_KEY 变化，
  //   与「valueFacts 有没有渲染」无关。这里要隔离的变量只有 valueFacts。
  const withoutFacts = buildGraph(events);
  for (const edge of Object.values(withoutFacts.edges)) delete edge.valueFacts;
  t.eq(renderLedger(graph).text, renderLedger(graph, { factGuard: false }).text, "renderLedger 默认 = factGuard:false（逐字）");
  t.eq(renderLedger(graph).text, renderLedger(withoutFacts).text, "guard 关掉时 valueFacts 不许改变热清单（一个字符都不许）");
  t.notIncludes(renderLedger(graph).text, "VALUE FACTS", "guard 关掉时热清单没有值事实段");
  t.eq(renderFacts(graph), renderFacts(withoutFacts), "guard 关掉时摘要硬事实块逐字相同");
  t.notIncludes(renderFacts(graph), "VALUE_FACTS", "guard 关掉时硬事实块没有值事实段");
  t.eq(renderMinimalLedger(graph).text, renderMinimalLedger(withoutFacts).text, "guard 关掉时最小清单逐字相同");
  const injectA = injectRun(makeInjectSession("ax09-off-a"), graph, makeInjectState());
  const injectB = injectRun(makeInjectSession("ax09-off-b"), withoutFacts, makeInjectState());
  t.eq(injectedLedgerText((() => { const s = makeInjectSession("ax09-off-c"); commitInjection(s, injectA); return s; })()), injectedLedgerText((() => { const s = makeInjectSession("ax09-off-d"); commitInjection(s, injectB); return s; })()), "guard 关掉时注入的消息逐字相同");
  const secondOff = (() => {
    const s = makeInjectSession("ax09-off-e");
    const st = makeInjectState();
    commitInjection(s, injectRun(s, graph, st));
    return injectRun(s, graph, st);
  })();
  t.eq(secondOff.action, "skip", "guard 关掉时第二次注入仍按旧判据跳过");
  t.eq(secondOff.reason, "identical", "guard 关掉时同内容 ⇒ identical（旧判据逐字不变）");
};

tests["AX-09 ⑥ 失败边不产值 / 旧图无 valueFacts / 开关默认 false"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);

  /* ① 失败边：一条值都不许产（边上连键都不长），渲染/抽取两侧都不许把它当成功值 */
  const failed = failureEdges(graph)[0];
  t.eq(failed?.id, "e3", "失败边必须是那次 isError 的 bash 调用");
  t.eq("valueFacts" in failed, false, "失败边不许有 valueFacts 字段");
  const failedSeq = seqOf("t3");
  t.eq(collectFoldValueFacts(events, { rangeStart: range.start, rangeEnd: range.end }).some((f) => f.evidenceSeq === failedSeq), false, "离线抽取器不许从失败结果里产值");
  t.eq(extractValueFacts({ tool: "bash", result: "Error: EACCES: permission denied, open 'prod.yml'", resultKind: "failure", isError: true, evidenceSeq: failedSeq }).length, 0, "AX-02 抽取器对失败结果必须返回空数组");
  t.eq(renderLedger(graph, { factGuard: true }).text.includes(`(seq ${failedSeq})`), false, "热清单不许把失败结果渲成值事实");

  /* ② 旧图（没有 valueFacts 字段）：guard 关掉时行为逐字不变；序列化/回放不长出该键 */
  const oldGraph = buildGraph(events);
  for (const edge of Object.values(oldGraph.edges)) delete edge.valueFacts;
  t.eq(toJSON(oldGraph).includes("valueFacts"), false, "没有值的图，JSON 里不许出现这个键（旧图形状不变）");
  t.eq(toJSON(fromJSON(toJSON(oldGraph))).includes("valueFacts"), false, "加载边界往返之后同样不许长出这个键");
  t.eq(renderLedger(oldGraph).text, renderLedger(graph).text, "旧图与带值图的 guard=false 渲染必须逐字相同");
  t.eq(renderFacts(oldGraph), renderFacts(graph), "摘要硬事实块同理");
  t.eq(valueFactDigest(oldGraph), "", "没有值事实时 digest 必须是空串（hot-inject 据此认为「值没变」）");
  t.ne(valueFactDigest(graph), "", "有值事实时 digest 不许为空（否则送达判据恒真）");

  /* ③ 开关默认 false（四处同源：配置默认 / 守卫默认 / 契约自述 / resolveConfig） */
  t.eq(FACT_GUARD_DEFAULT, false, "config-schema 的默认值必须是 false");
  t.eq(DEFAULT_ENABLED, false, "fact-guard 的默认值必须与配置同源且为 false");
  t.eq(describeContract().defaultEnabled, false, "契约自述必须写清默认关");
  t.eq(resolveConfig({}).factGuard, false, "空配置 ⇒ false");
  t.eq(resolveConfig({ factGuard: true }).factGuard, true, "字面 true 可开启（实验线）");
  for (const value of ["true", 1, null, "yes"]) t.eq(resolveConfig({ factGuard: value }).factGuard, false, `非字面 true 不许开启实验线：${JSON.stringify(value)}`);
  t.eq(describeField("factGuard")?.default, false, "配置表里的默认值同样必须是 false");
  t.eq(collectValueFacts(graph).total, 5, "值事实收集本身与开关无关（开关在渲染/指令侧）");

  /* ④ 默认关闭的引擎：同一份 JSON 模型输出必须原样落进摘要（旧行为），一次都不许裁决 */
  const byDefault = await runOnline({ id: "ax09-default-online", graph, session, range, modelText: raw });
  t.eq(byDefault.out.factGuard, undefined, "默认构造的引擎不许产生守卫报告");
  t.eq(byDefault.out.summary[0]?.text, raw, "默认关闭时模型输出原样进摘要");
};

tests["AX-09 ⑦ 三路径没有三份裁决：静态判据（唯一判据来源）+ 行为判据（同输入同输出）+ 不新增第二个评委"] = async (t) => {
  const engineSrc = readSource("src/engine.mjs");
  const offlineSrc = readSource("src/rooms/offline-fold.mjs");
  const ledgerSrc = readSource("src/rooms/ledger.mjs");
  const guardSrc = readSource("src/rooms/fact-guard.mjs");
  const promptSrc = readSource("src/rooms/facts-prompt.mjs");

  /* ① 唯一判据来源：两个裁决路径都必须 import 同一份守卫 */
  t.includes(engineSrc, 'import { guardModelOutput } from "./rooms/fact-guard.mjs"', "online 必须 import fact-guard 的 guardModelOutput");
  t.includes(engineSrc, "guardModelOutput(", "online 必须真的调用它");
  t.includes(offlineSrc, 'import { FACT_KINDS, SUBJECTS, guardModelOutput } from "./fact-guard.mjs"', "offline 必须 import 同一份守卫");
  t.includes(offlineSrc, "return guardModelOutput(raw", "offline 的守卫必须是一次纯转调（不是自己判）");
  t.includes(offlineSrc, 'from "./tool-value-facts.mjs"', "offline 必须复用 AX-02 的抽取器");
  t.includes(engineSrc, 'import { isValueFact } from "./rooms/tool-value-facts.mjs"', "online 必须复用 AX-02 的契约校验器");

  /* ② 不许复制实现：裁决判据（verdict / reason code / 主体枚举）只许出现在 fact-guard.mjs */
  const reasonCodes = Object.values(REASONS);
  t.ok(reasonCodes.length >= 20, "守卫必须真的有一张原因码表（否则下面的「没复制」是恒真）");
  for (const code of ["QUOTE_NOT_VERBATIM", "SUBJECT_MISMATCH", "STALE_CURRENT", "CROSS_SESSION_SEQ", "FUTURE_EVIDENCE"]) {
    t.eq(reasonCodes.includes(code), true, `原因码必须登记在 fact-guard：${code}`);
    t.notIncludes(engineSrc, code, `online 不许复制原因码：${code}`);
    t.notIncludes(offlineSrc, code, `offline 不许复制原因码：${code}`);
    t.notIncludes(ledgerSrc, code, `ledger 不许复制原因码：${code}`);
    t.notIncludes(promptSrc, code, `facts-prompt 不许复制原因码：${code}`);
  }
  for (const [name, src] of [["engine", engineSrc], ["offline-fold", offlineSrc], ["ledger", ledgerSrc]]) {
    t.notIncludes(src, "function evaluateFactCandidate", `${name} 不许自带一份事实裁决器`);
    t.notIncludes(src, "function evaluateNarrativeCandidate", `${name} 不许自带一份叙事裁决器`);
  }
  t.includes(guardSrc, "export function evaluateFactCandidate", "裁决器只许在 fact-guard.mjs 里定义");
  t.includes(guardSrc, "export function evaluateNarrativeCandidate", "叙事裁决器同上");

  /* ③ ledger 的依赖面：只读 `edge.valueFacts`，不 import 守卫/抽取器（R06 的允许依赖仍是 R00 + R04） */
  t.notIncludes(ledgerSrc, 'from "./fact-guard.mjs"', "ledger 不许 import 守卫（它不裁决，只读）");
  t.notIncludes(ledgerSrc, 'from "./tool-value-facts.mjs"', "ledger 不许 import 抽取器（否则等于第二条抽取路径）");
  t.includes(ledgerSrc, "edge.valueFacts", "ledger 必须只读边上已有的值事实");
  t.eq(describeFactGuardPrompt().verdicts, Object.values(VERDICT), "facts-prompt 的裁决枚举镜像必须与 fact-guard 逐字一致");
  t.eq(describeContract().reasons, REASONS, "契约自述的原因码表必须就是 REASONS（同一份）");

  /* ④ 行为：同输入同输出 + 离线入口是纯转调 + 不新增第二个模型调用 */
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const envelope = modelEnvelope(seqOf);
  const raw = JSON.stringify(envelope);
  const source = buildGuardSource(events, { sessionId: SESSION_ID });
  const a = guardModelOutput(envelope, { factGuard: true, session: source });
  const b = guardModelOutput(JSON.parse(JSON.stringify(envelope)), { factGuard: true, session: buildGuardSource(events, { sessionId: SESSION_ID }) });
  t.eq(a, b, "同一输入（内容相同、对象不同）必须给出逐字段相同的裁决（纯函数、确定性）");
  t.eq(a.contract, CONTRACT, "信封必须带契约版本");
  t.eq(guardOfflineFoldOutput(raw, { events, sessionId: SESSION_ID, factGuard: true }), a, "离线入口必须是纯转调：与直接调守卫逐字段相同");
  t.eq(guardOfflineFoldOutput(raw, { events, sessionId: SESSION_ID, factGuard: false }).applied, false, "守卫关掉时离线入口不裁决");
  const applied = applyOfflineGuard(a, raw);
  t.eq(applied.record.facts, a.facts, "applyOfflineGuard 必须逐字段转写信封（不重新裁决）");
  t.eq(applied.record.narratives, a.narratives, "叙事裁决同样逐字段转写");
  t.eq(applied.record.semanticEntailment, "NOT_PROVEN", "转写不许把「逐字命中」升级成「语义已证明」");

  // 不新增第二个 LLM 评委：两条路径各自恰好一次模型调用（用例 ① 已断言，这里再钉一条端到端）
  const online = await runOnline({ id: "ax09-judge-on", graph, session, range, factGuard: true, modelText: raw });
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: raw });
  t.eq(online.calls, 1, "online 只许一次模型调用");
  t.eq(offline.calls.length, 1, "offline 只许一次模型调用");
  t.eq(online.out.factGuard.supported, offline.chunk.guard.summary.supported, "同一个裁判 ⇒ 同一个接受数");
};

tests["AX-09 ⑧ 已知边界（隔离实验）：证据源只差 tool/call 摘要行 —— 差异在源、不在判据"] = async (t) => {
  const { session, events, seqOf, range } = buildStream();
  const graph = buildGraph(events);
  const toolCallSeq = seqOf("c2");
  const candidate = {
    id: "f-toolcall",
    kind: "value",
    subject: "tool",
    claim: "调用过 gh api",
    quote: "bash(command=gh api repos/x/y)",
    evidenceSeq: toolCallSeq,
    validAtSeq: toolCallSeq,
  };
  // 带一条引用它的叙事：否则离线侧会把「整段都被拒/没有正文」判成 empty-response（不写半截账），
  // 于是拿不到 chunk —— 那是 AX-07 的既有语义，与本例要证明的「源差异」无关。
  const envelope = { facts: [candidate], narratives: [{ id: "n-toolcall", text: "已经调用过 gh api。", factRefs: ["f-toolcall"] }] };

  /* ① 参考层：同一份候选，只换证据源，裁决就不同 —— 但原因码来自**同一张表** */
  const engineShape = buildGuardSource(events.filter((e) => e.type !== "tool/call"), { sessionId: SESSION_ID });
  const offlineShape = buildGuardSource(events, { sessionId: SESSION_ID });
  const onlineVerdict = guardModelOutput(envelope, { factGuard: true, session: engineShape }).facts[0];
  const offlineVerdict = guardModelOutput(envelope, { factGuard: true, session: offlineShape }).facts[0];
  t.eq(onlineVerdict.verdict, "REJECTED", "在线证据源没有 tool/call 行 ⇒ 该候选必须被拒");
  t.eq(onlineVerdict.reasons.map((r) => r.code), ["EVIDENCE_SEQ_NOT_FOUND"], "拒绝原因必须是「该 seq 不在证据里」");
  t.eq(offlineVerdict.verdict, "SUPPORTED", "离线证据源有 tool/call 行 ⇒ 同一候选通过");
  t.eq(REASONS.EVIDENCE_SEQ_NOT_FOUND, "EVIDENCE_SEQ_NOT_FOUND", "原因码必须来自 fact-guard 的登记表（不是别处自造）");
  // 隔离：把 tool/call 从离线源里去掉 ⇒ 与在线源得到同一个裁决 ⇒ 差异的唯一变量就是那一类事件
  const offlineMinusCall = guardModelOutput(envelope, { factGuard: true, session: buildGuardSource(events.filter((e) => e.type !== "tool/call"), { sessionId: SESSION_ID }) }).facts[0];
  t.eq(offlineMinusCall, onlineVerdict, "去掉 tool/call 行后，离线源与在线源必须给出**逐字段相同**的裁决");

  /* ② 两条真路径复现同一差异（不是只在参考层成立） */
  const online = await runOnline({ id: "ax09-boundary-on", graph, session, range, factGuard: true, modelText: JSON.stringify(envelope) });
  t.eq(online.out.factGuard.rejected, 1, "online 必须拒掉这条候选");
  t.eq(online.out.factGuard.supported, 0, "online 一条都不许接受");
  t.notIncludes(online.text, "调用过 gh api", "被拒候选不许出现在摘要里");
  const offline = await runOffline({ graph, events, range, factGuard: true, modelText: JSON.stringify(envelope) });
  t.eq(offline.chunk.guard.facts[0].verdict, "SUPPORTED", "offline 会接受同一条候选（证据源里真有那一行）");
  t.includes(offline.chunk.guard.facts[0].reasons.length === 0 ? "ok" : "bad", "ok", "接受时不许带原因码");
  // 台账（写进 REPORT 的边界结论）：这一类差异只可能发生在「引用 tool/call seq」的候选上；
  // 本夹具的主候选集（用例 ①②③④）全部引用消息事件，两个源的裁决逐字段相同。
  t.eq(FIXTURE.modelOutput.facts.every((fact) => fact.evidenceKey !== "c1" && fact.evidenceKey !== "c2" && fact.evidenceKey !== "c3" && fact.evidenceKey !== "c4"), true, "主候选集不许引用 tool/call seq（否则上面的「同一裁决」就不成立）");
};
