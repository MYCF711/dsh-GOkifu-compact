/**
 * offline-fold.test.mjs —— 离线折叠的**编排**（C496）
 *
 * 为什么单独测编排：真接入引擎时，模型调用要走宿主的 `ctx.llm`（那才是 DSH 的默认模型）。
 * 所以编排只依赖注入的 `callModel` —— 这里用假模型把整条链路跑通，不需要真调 API。
 */
import { runOfflineFold, allConstraints } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const graph = {
  rootUserNodeIds: ["n1"],
  nodes: {
    n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置", "不要粉色大象"] },
  },
  edges: {
    e1: { id: "e1", intent: "改 prod", action: "edit(prod.yml)", result: "failure", errorSnippet: "EACCES", evidence: { start: 2, end: 3 } },
  },
};
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const tr = (seq, text) => ({ type: "tool/result", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(1, "把构建跑通"), a(2, "先看配置"), tr(3, "x".repeat(5000)), a(4, "改 prod 配置"), u(5, "别动 prod")];
const measure = () => ({ constraintRecall: 1, failureRecall: 1 });

tests["C496 编排：一段到底就把整个区间标成覆盖，工具结果不进 prompt"] = async (t) => {
  let seen = "";
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async (prompt) => {
      seen = prompt;
      return { text: "## 目标\n- 把构建跑通", usage: { prompt_tokens: 10 }, model: "fake" };
    },
    measureQuality: measure,
  });
  t.eq(out.chunks.length, 1, "一条消息预算装得下 ⇒ 只有一段");
  t.eq(out.chunks[0].start, 1, "从 1 开始");
  t.eq(out.chunks[0].end, 5, "到 5 结束");
  t.eq(out.uncoveredTail, 0, "全覆盖");
  t.eq(seen.includes("x".repeat(100)), false, "5000 字符的工具结果不许进 prompt");
  t.includes(seen, "EACCES", "死路要进硬事实块");
};

tests["C496 编排：模型丢约束 ⇒ 机械补回，并记 repaired"] = async (t) => {
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: "## 目标\n- 把构建跑通", usage: null, model: "fake" }),
    measureQuality: measure,
  });
  const chunk = out.chunks[0];
  t.eq(chunk.repaired, 2, "两条约束都该补回");
  t.includes(chunk.text, "不许动 prod 配置", "补回的约束要在正文里");
  t.includes(chunk.text, "不要粉色大象", "每一条都要");
  t.eq(chunk.quality?.constraintRecall, 1, "补完质量应为 1");
};

tests["C496 编排：分段时从头往后推进，不许只压尾巴"] = async (t) => {
  const many = [];
  for (let i = 1; i <= 30; i += 1) many.push(i % 3 === 0 ? a(i, `步骤 ${i} ` + "y".repeat(200)) : u(i, `指令 ${i}`));
  const prompts = [];
  const out = await runOfflineFold({
    graph,
    events: many,
    rangeStart: 1,
    rangeEnd: 30,
    maxChars: 1200,
    maxChunks: 3,
    callModel: async (prompt) => {
      prompts.push(prompt);
      return { text: "## 目标\n- 把构建跑通\n- 不许动 prod 配置\n- 不要粉色大象", usage: null, model: "fake" };
    },
    measureQuality: measure,
  });
  t.eq(out.chunks.length > 1, true, "预算小 ⇒ 会被切成多段");
  t.eq(out.chunks[0].start, 1, "第一段从区间开头开始（不是从尾巴）");
  t.eq(out.chunks[1].start, out.chunks[0].end + 1, "第二段紧接第一段");
  t.eq(prompts.length, out.chunks.length, "每段各发一次请求");
};

tests["C496 编排：模型返回空 ⇒ 明确失败，不许写半截账"] = async (t) => {
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: "   ", usage: null, model: "fake" }),
    measureQuality: measure,
  });
  t.eq(out.failed, "empty-response", "空响应要能自证");
  t.eq(out.chunks.length, 0, "不许产生半截折叠记录");
  t.eq(out.uncoveredTail > 0, true, "没压成就还是欠着");
};

tests["C496 allConstraints 取全量（质量报告只给前 5 条，补回不能用它）"] = (t) => {
  const g = { nodes: { n1: { constraints: ["a"] }, n2: { constraints: ["b", "a"] } } };
  const all = allConstraints(g);
  t.eq(all.length, 2, "去重后两条");
  t.eq(all.includes("a") && all.includes("b"), true, "两条都在");
};

tests["C499 该不该走离线补折：只有「算不出区间」才走"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const base = { closeout: { folded: 0, foldNote: "nothing-to-fold:no-foldable-span" }, tailEvents: 100, enabled: true };
  t.eq(m.shouldTryOfflineFold(base).go, true, "算不出区间 + 尾巴够长 ⇒ 走离线");
  t.eq(m.shouldTryOfflineFold({ ...base, enabled: false }).why, "disabled", "用户关了就不走");
  t.eq(m.shouldTryOfflineFold({ ...base, closeout: { folded: 0, foldError: "timeout" } }).go, false, "超时不是这条路径的事");
  t.eq(m.shouldTryOfflineFold({ ...base, closeout: { folded: 2 } }).why, "already-folded", "已经折过就别重复花钱");
  t.eq(m.shouldTryOfflineFold({ ...base, tailEvents: 10 }).why, "tail-too-short", "尾巴太短不折");
};

tests["C499 结果翻译：有缺口就 partial，不许记成全压过"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const full = m.offlineFoldOutcome({ chunks: [{}], coveredStart: 1, coveredEnd: 100, uncoveredHead: 0, uncoveredTail: 0 }, { rangeStart: 1, rangeEnd: 100, maxSeq: 100 });
  t.eq(full.folded, 1, "折了 1 段");
  t.eq(full.partial, false, "全覆盖 ⇒ 不是 partial");
  const gap = m.offlineFoldOutcome({ chunks: [{}, {}], coveredStart: 500, coveredEnd: 900, uncoveredHead: 400, uncoveredTail: 0 }, { rangeStart: 100, rangeEnd: 900, maxSeq: 900 });
  t.eq(gap.partial, true, "前段没压 ⇒ partial");
  t.eq(gap.uncoveredHead, 400, "缺口大小要带出来");
  const empty = m.offlineFoldOutcome({ chunks: [], failed: "empty-response" }, { rangeStart: 1, rangeEnd: 100, maxSeq: 100 });
  t.eq(empty.folded, 0, "空响应 ⇒ 0 段");
  t.eq(empty.partial, true, "没压成当然算 partial");
};

tests["C502 写回棋谱：marks/closeout/lastOfflineSummary 一次到位，旧矛盾字段要清掉"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const g = {
    foldMarks: [],
    closeout: { at: 1, source: "archive", folded: 0, foldNote: "nothing-to-fold:no-foldable-span", foldError: "旧的错" },
  };
  const result = {
    chunks: [
      { start: 101, end: 200, text: "## 目标\n- x", quality: { constraintRecall: 1 }, repaired: 0, model: "m1", ms: 10, usage: null },
      { start: 201, end: 300, text: "## 目标\n- y", quality: { constraintRecall: 1 }, repaired: 2, model: "m1", ms: 20, usage: null },
    ],
    coveredStart: 101,
    coveredEnd: 300,
    uncoveredHead: 100,
    uncoveredTail: 0,
  };
  const out = m.applyOfflineFoldToGraph(g, result, { rangeStart: 1, rangeEnd: 300, provider: "magpie", model: "m1", now: 999 });
  t.eq(out.marksAdded, 2, "两段各一条 foldMark");
  t.eq(g.foldMarks.length, 2, "写进 foldMarks");
  t.eq(g.foldMarks[0].trigger, "archive-offline", "要能跟在线折叠区分");
  t.eq(g.foldMarks[1].qualityRepaired, 2, "补回条数要留痕");
  t.eq(g.closeout.source, "archive-offline", "closeout 来源改写");
  t.eq(g.closeout.folded, 2, "折了几段");
  t.eq(g.closeout.partial, true, "前段没压 ⇒ partial");
  t.eq(g.closeout.foldNote, undefined, "旧矛盾字段（nothing-to-fold）必须清掉");
  t.eq(g.closeout.foldError, undefined, "旧错误也必须清掉");
  t.eq(g.lastOfflineSummary.range.end, 300, "摘要区间记最后一段");
  t.includes(g.lastOfflineSummary.text, "- y", "摘要正文留最后一段");
};

tests["C502 空结果不许动棋谱（不许写半截账）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const g = { foldMarks: [], closeout: { source: "archive", folded: 0 } };
  const before = JSON.stringify(g);
  const out = m.applyOfflineFoldToGraph(g, { chunks: [], coveredStart: null, coveredEnd: null }, { rangeStart: 1, rangeEnd: 10 });
  t.eq(out.marksAdded, 0, "0 段");
  t.eq(JSON.stringify(g), before, "一个字都不该改 —— 没压成就还是原样欠着");
};

tests["C503 「超时」也是触发条件（否则 C501 那条分支是死代码）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const base = { enabled: true, tailEvents: 100, minEvents: 40 };
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "timeout" }).go, true, "在线超时 ⇒ 该走离线（日志还在）");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "no-foldable-span(surface=0,priced=3)" }).go, true, "带括号的形态也要认");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "no-target" }).go, false, "没有路由不是离线能救的");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "below-min-tokens" }).go, false, "尾巴太短按设计不折");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "timeout", closeout: { folded: 3 } }).why, "already-folded", "已折过仍然不重花");
};
