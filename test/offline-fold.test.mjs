/**
 * offline-fold.test.mjs —— 离线折叠的**编排**（C496）
 *
 * 为什么单独测编排：真接入引擎时，模型调用要走宿主的 `ctx.llm`（那才是 DSH 的默认模型）。
 * 所以编排只依赖注入的 `callModel` —— 这里用假模型把整条链路跑通，不需要真调 API。
 */
import { runOfflineFold, allConstraints } from "../src/rooms/offline-fold.mjs";
// ★ AX-07：离线守卫的**判据来源**（本文件只做「两条路径给出同一个裁决」的对拍，不自己判）。
import * as offlineFold from "../src/rooms/offline-fold.mjs";
import { guardModelOutput } from "../src/rooms/fact-guard.mjs";
import { isValueFact } from "../src/rooms/tool-value-facts.mjs";

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

tests["C505 离线摘要编造的 id 必须被代码清掉（提示词挡不住）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    // 模型"编"了图里不存在的 n999 / e999，还引用了区间之后的实体
    callModel: async () => ({ text: "## 目标\n- 把构建跑通\n\n## 棋谱\n- n999 干了某件事\n- e999 也试过\n- 不许动 prod 配置\n- 不要粉色大象", usage: null, model: "fake" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.sanitized >= 2, true, `编造的 id 至少要清掉 2 个，实际 ${chunk.sanitized}`);
  t.eq(chunk.text.includes("n999"), false, "n999 不许留在正文里");
  t.eq(chunk.text.includes("e999"), false, "e999 也不许留");
  t.includes(chunk.text, "n?", "换成 n? 占位（读者能看出这里被清过）");
};

tests["C505 合法实体不许被误伤"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: "## 已探明死路\n- e1 \"改 prod\" → EACCES\n- 不许动 prod 配置\n- 不要粉色大象", usage: null, model: "fake" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.sanitized, 0, "e1 在图里且区间内 ⇒ 不该被清");
  t.includes(chunk.text, "e1", "合法实体要留着");
};

tests["C517 「surface 里找不到这段」也是放弃理由 —— 归档后补账失败的正是它"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const base = { enabled: true, tailEvents: 1531, minEvents: 40 };
  const real = "Error: compactRegion: start seq 496 not found in surface";
  t.eq(m.shouldTryOfflineFold({ ...base, reason: real }).go, true, "真机那条错误必须触发离线补折");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "compactRegion: start seq 12 not found in surface" }).go, true, "换 seq 也一样");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "MAX_TOKENS" }).go, false, "截断不是 surface 问题，别乱走离线");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "余额不足（402）" }).go, false, "没钱走离线也一样没钱");
};

tests["C521 摘要输入必须带「agent 做过什么」——真机 95% 的 assistant 消息没有文本块"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  // 一行工具摘要：JSON arguments 只取最能说明意图的那个键
  t.eq(m.toolDigestLine({ name: "bash", arguments: "{\"command\":\"npm test\"}" }), "→ bash(command=npm test)", "bash 取 command");
  t.eq(m.toolDigestLine({ name: "read", arguments: "{\"file_path\":\"a/b.mjs\"}" }), "→ read(file_path=a/b.mjs)", "read 取 file_path");
  t.includes(m.toolDigestLine({ name: "bash", arguments: "{\"command\":\"" + "x".repeat(200) + "\"}" }), "…", "超长要截（这里是前缀截断）");
  t.eq(m.toolDigestLine({ name: "" }), "", "没名字就不产生行");

  const events = [
    u(1, "把构建跑通"),
    { type: "tool/call", seq: 2, data: { name: "bash", arguments: "{\"command\":\"npm test\"}" } },
    { type: "tool/result", seq: 3, data: { content: [{ type: "text", text: "x".repeat(4000) }] } },
    a(4, "测试过了"),
  ];
  const got = m.collectMessages(events, { maxChars: 10_000 });
  const toolLines = got.messages.filter((x) => x.role === "tool");
  t.eq(toolLines.length, 1, "工具调用要变成一行");
  t.includes(toolLines[0].text, "npm test", "要能看出跑了什么");
  t.eq(got.messages.some((x) => x.text.includes("x".repeat(100))), false, "工具**结果**仍然不进（那才是几千字符的东西）");
};

tests["C521 工具行有预算上限：不许把用户诉求挤掉"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const events = [u(1, "目标：修好日志")];
  for (let i = 2; i <= 200; i += 1) events.push({ type: "tool/call", seq: i, data: { name: "bash", arguments: `{"command":"cmd-${i}-${"y".repeat(60)}"}` } });
  const got = m.collectMessages(events, { maxChars: 6000, toolShare: 0.4 });
  const userChars = got.messages.filter((x) => x.role !== "tool").reduce((n, x) => n + x.text.length, 0);
  const toolChars = got.messages.filter((x) => x.role === "tool").reduce((n, x) => n + x.text.length, 0);
  t.eq(userChars > 0, true, "用户那条必须还在");
  t.eq(toolChars <= 6000 * 0.4 + 200, true, `工具行不能超过 40% 预算（实际 ${toolChars}）`);
};

tests["C522 被截断的摘要不许当完整：撞上限就放大 2× 重试一次"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const budgets = [];
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    maxTokens: 4000,
    callModel: async (prompt, { maxTokens }) => {
      budgets.push(maxTokens);
      if (budgets.length === 1) return { text: "## 目标\n- 半句话" + "字".repeat(8000), usage: { completion_tokens: maxTokens }, model: "fake" };
      return { text: "## 目标\n- 把构建跑通\n\n## 已验证事实\n- 全须全尾\n- 不许动 prod 配置\n- 不要粉色大象", usage: { completion_tokens: 300 }, model: "fake" };
    },
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(budgets.length, 2, "撞上限要重试一次");
  t.eq(budgets[1], budgets[0] * 2, "第二次预算放大 2×");
  t.eq(out.chunks[0].truncated, false, "重试成功就不算截断");
  t.includes(out.chunks[0].text, "全须全尾", "用的是第二次的正文");
};

tests["C522 重试仍截断 ⇒ 明确标 truncated（账上不许记成功）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    maxTokens: 4000,
    callModel: async (prompt, { maxTokens }) => ({ text: "## 目标\n- 还是半句", usage: { completion_tokens: maxTokens }, model: "fake" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks[0].truncated, true, "两次都撞上限 ⇒ 必须标出来");
};

tests["C522 约束空白变体就地还原原文，不重复补段"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: "## 目标\n- 把构建跑通\n- 不许动 prod 配置\n- 不要 粉色 大象", usage: null, model: "fake" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks[0].repaired, 0, "空格式差异不算丢失，不许重复补");
  t.includes(out.chunks[0].text, "不要粉色大象", "空白变体要还原为逐字原文");
  t.notIncludes(out.chunks[0].text, "不要 粉色 大象", "模型变体不得留在最终产物");
  t.eq(out.chunks[0].text.includes("## 约束（逐字补充"), false, "不许追加重复补段");
};

tests["C653 空白变体必须就地还原逐字原文，完全缺失仍追加且无重复补段"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const { measureFoldQuality } = await import("../src/rooms/fold-quality.mjs");
  const original = "只改本worktree";
  const variant = "只改本 worktree";
  const verbatimGraph = {
    rootUserNodeIds: ["n1"],
    order: ["n1"],
    nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "遵守工作区边界", constraints: [original] } },
    edges: {},
  };
  const modelText = `## 目标\n- 遵守工作区边界\n\n## 棋谱\n- n1 记录约束\n\n## 约束（逐字）\n- ${variant}`;
  const out = await m.runOfflineFold({
    graph: verbatimGraph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: modelText, usage: null, model: "fake" }),
    measureQuality: measureFoldQuality,
  });
  const chunk = out.chunks[0];
  t.eq(chunk.quality?.constraintRecall, 1, "真实 measureFoldQuality：最终产物必须逐字包含约束原文");
  t.includes(chunk.text, original, "模型空白变体必须就地替换为棋谱里的原文");
  t.notIncludes(chunk.text, variant, "模型变体不得继续留在最终产物里");
  t.eq(chunk.text.split(original).length - 1, 1, "原文只出现一次，不许再追加一份");
  t.eq(chunk.text.includes("## 约束（逐字补充"), false, "只有空白差异时不得生成重复补段");
  t.eq(chunk.repaired, 0, "就地还原不是追加补段");

  const withMissing = {
    ...verbatimGraph,
    nodes: {
      n1: { ...verbatimGraph.nodes.n1, constraints: [original, "不要粉色大象"] },
    },
  };
  const appended = await m.runOfflineFold({
    graph: withMissing,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    callModel: async () => ({ text: modelText, usage: null, model: "fake" }),
    measureQuality: measureFoldQuality,
  });
  const fixed = appended.chunks[0];
  t.eq(fixed.quality?.constraintRecall, 1, "空白变体还原 + 完全缺失追加之后，真实召回仍须为 1");
  t.eq(fixed.repaired, 1, "只有完全缺失的那条走原追加路径");
  t.eq(fixed.text.split("## 约束（逐字补充").length - 1, 1, "完全缺失只产生一个补段");
  t.eq(fixed.text.split(original).length - 1, 1, "补段不得重复写已就地还原的原文");
  t.includes(fixed.text, "- 不要粉色大象", "完全缺失的约束仍按原路逐字追加");
};

tests["C532 一次都没折过的会话必须从头部开始（否则前段永远补不上）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const events = [];
  for (let i = 1; i <= 40; i += 1) events.push(u(i, `第 ${i} 步：` + "x".repeat(300)));
  const calls = [];
  const out = await m.runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 40,
    maxChars: 3000,
    fromHead: true,
    callModel: async (prompt) => {
      calls.push(prompt);
      return { text: "## 目标\n- 把构建跑通\n## 棋谱\n- 逐步推进", usage: null, model: "fake" };
    },
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks.length, 1, "一段");
  t.includes(out.chunks[0].start <= 3 ? "head" : "tail", "head", "必须从**开头**取（start 很靠前）");
  t.eq(out.chunks[0].start, 1, `起点必须是 1，实际 ${out.chunks[0].start}`);
};

tests["C533 prompt 必须有篇幅与诚实约束（以前没有 ⇒ 一路写到撞顶）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const prompt = m.buildOfflinePrompt({ facts: "## 目标\n- x", messages: [{ role: "user", text: "hi" }] });
  t.includes(prompt, "按输入规模算出来的", "篇幅要按输入规模给（C540 之后不再是固定值）");
  t.includes(prompt, "不许编造", "要明说禁止编造");
  t.includes(prompt, "约束（逐字）", "要约好机读的约束段，减少机械补回");
};

tests["C533 事实块必须有长度上限（病态数据不许把 prompt 撑爆）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const long = "很长的约束".repeat(2000);
  const facts = m.renderFacts({ rootUserNodeIds: ["n1"], nodes: { n1: { id: "n1", kind: "user", text: long, constraints: [long] } }, edges: {} }, { start: 1, end: 2 });
  t.eq(facts.length <= 8200, true, `事实块必须 ≤ ~8000 字符，实际 ${facts.length}`);
  t.includes(facts, "事实块已截断", "截断要写明（不静默）");
};

tests["C534 没撞上限也可能没写完：正文过短要重试（真机 reasoning 吃掉 3816/4000）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const big = { type: "user/message", seq: 1, data: { message: { content: [{ type: "text", text: "很长的历史".repeat(900) }] } } };
  const calls = [];
  const out = await m.runOfflineFold({
    graph,
    events: [big],
    rangeStart: 1,
    rangeEnd: 1,
    maxTokens: 4000,
    callModel: async (prompt, { maxTokens }) => {
      calls.push({ maxTokens, fed: prompt.length });
      if (calls.length === 1) return { text: "## 目标\n骨架", usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3816 } }, model: "fake" };
      return { text: "## 目标\n- 把构建跑通\n## 棋谱\n- 详细内容".repeat(30), usage: { completion_tokens: 2000 }, model: "fake" };
    },
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(calls.length, 2, "正文过短必须重试一次");
  t.eq(calls[1].maxTokens, 8000, "重试预算放大 2×");
  t.eq(out.chunks[0].text.length > 400, true, "用重试那次的长文本");
};

tests["C537 prompt 要求「每个状态节点得出了什么」（只写编号串不算）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const prompt = m.buildOfflinePrompt({ facts: "x", messages: [{ role: "user", text: "hi" }] });
  t.includes(prompt, "得出了什么", "要有这句");
  t.includes(prompt, "只写编号串不算", "要明确否掉编号串");
  t.includes(prompt, "手上还差什么", "当前节点要交代差什么");
};

tests["C540 建议篇幅按输入规模给（固定 800–2500 在两端都不合适）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const small = m.suggestedLength(3000);
  const mid = m.suggestedLength(14000);
  const big = m.suggestedLength(38000);
  t.eq(small.max < mid.max, true, "小输入上限要小（否则是扩写）");
  t.eq(big.min > small.min, true, "大输入下限要大（否则细节丢光）");
  t.eq(big.max <= 3000, true, "上限不超过 3000 字");
  t.eq(mid.min < mid.max, true, "区间必须有效");

  const prompt = m.buildOfflinePrompt({ facts: "x".repeat(1000), messages: [{ role: "user", text: "y".repeat(14000) }] });
  t.includes(prompt, "按输入规模算出来的", "prompt 里要说明是算出来的");
};

tests["C555 no-op 必须能触发离线补折（真机 4f3cae10 就是空转）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const base = { closeout: null, tailEvents: 757, enabled: true, minEvents: 40 };
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "no-op" }).go, true, "C531 的停止原因要算「放弃」");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "no-foldable-span" }).go, true, "老原因仍然可用");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "timeout" }).go, true, "超时仍可用");
  t.eq(m.shouldTryOfflineFold({ ...base, reason: "随便什么" }).go, false, "其它原因不许乱花钱");
};

tests["C555 「已折过」要有证据：folded>0 但没有 marks 就是假冒成功"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const closeout = { folded: 1 };
  const base = { closeout, reason: "no-op", tailEvents: 757, enabled: true, minEvents: 40 };
  t.eq(m.shouldTryOfflineFold({ ...base, marks: 0 }).go, true, "folded=1 但 0 条 marks ⇒ 仍该走离线");
  t.eq(m.shouldTryOfflineFold({ ...base, marks: 3 }).go, false, "真有 3 条 marks ⇒ 已折过，别再花钱");
  t.eq(m.shouldTryOfflineFold({ ...base }).go, false, "没给证据时退回旧行为（保守）");
};

tests["C581 usage 两种形状归一（脚本 snake_case / 引擎 camelCase）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  t.eq(m.normalizeUsage(null), null, "null 不炸");
  // ★ C587：归一结果**保留读侧字段名**（ui/fold-quality/doctor 都读 inputTokens/outputTokens）
  const eng = m.normalizeUsage({ inputTokens: 14889, outputTokens: 6686, totalTokens: 21575 });
  t.eq(eng.inputTokens, 14889, "引擎形输入");
  t.eq(eng.outputTokens, 6686, "引擎形输出");
  t.eq(eng.totalTokens, 21575, "引擎形总量");
  const scr = m.normalizeUsage({
    prompt_tokens: 6623,
    completion_tokens: 7558,
    total_tokens: 14181,
    prompt_tokens_details: { cached_tokens: 9216 },
    completion_tokens_details: { reasoning_tokens: 4638 },
  });
  t.eq(scr.cacheReadTokens, 9216, "脚本形缓存命中");
  t.eq(scr.reasoningTokens, 4638, "脚本形推理");
  t.eq(scr.totalTokens, 14181, "脚本形总量");
};

tests["C584 离线 mark 必须写 truncated（否则 status 永远报「跑的还是旧代码」）"] = async (t) => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/rooms/offline-fold.mjs", import.meta.url), "utf8");
  t.includes(src, "truncated: chunk.truncated === true", "mark 要写 truncated");
  t.includes(src, "让探测器不再撒谎", "注释要说明它曾经漏写");
};

tests["C586 估算用码点（emoji/代理对不重复计）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  t.eq(m.estimateTokens(""), 0, "空串为 0");
  t.eq(m.estimateTokens("😀".repeat(100)), 30, "emoji 100 个 ≈ 30（按码点，不按 UTF-16 单位）");
  t.eq(m.estimateTokens("中".repeat(100)), 60, "中文 0.6/字");
  t.eq(m.estimateTokens("a".repeat(100)), 30, "英文 0.3/字");
};

tests["C586 剩余缺口也算 partial（两套口径不许打架）"] = async (t) => {
  const g = { version: 1, nodes: { n1: { id: "n1", kind: "user", seq: 1 }, n2: { id: "n2", kind: "agent", seq: 500 } }, edges: {}, foldMarks: [], closeout: {} };
  await import("../src/rooms/offline-fold.mjs").then((m) =>
    m.applyOfflineFoldToGraph(
      g,
      { chunks: [{ start: 1, end: 100, text: "## 目标" }], coveredStart: 1, coveredEnd: 100, uncoveredHead: 0, uncoveredTail: 0 },
      { model: { model: "m" }, rangeStart: 1, previousGapEvents: 400 },
    ),
  );
  t.eq(g.closeout.partial, true, "旧缺口还剩 300 ⇒ 必须标 partial");
  t.eq(Number(g.closeout.offlineUncoveredHead?.events), 300, "剩余缺口要写清");
};

tests["C590 补账必须有截止时间（卡死一次会停掉整个后台补账）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  // deadline 已过期 ⇒ 一段都不折，并老实写 stopped:"deadline"
  const out = await m.runOfflineFold({
    graph: { nodes: { n1: { id: "n1", seq: 1 } }, edges: {}, foldMarks: [] },
    events: Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, type: "user/message", text: "x" })),
    rangeStart: 1,
    rangeEnd: 50,
    deadline: Date.now() - 1,
    callModel: async () => {
      throw new Error("不该被调用");
    },
    measureQuality: () => null,
  });
  t.eq(out.chunks.length, 0, "到点就不折");
  t.eq(out.failed, "deadline", "要写明为什么没折");
  const oc = m.offlineFoldOutcome(out, { rangeStart: 1, rangeEnd: 50, maxSeq: 50 });
  t.eq(oc.stopped, "deadline", "outcome 要带出去");
  t.eq(oc.partial, true, "没折完必须 partial");
};

tests["C592 还有欠账就必须允许再折（already-folded 不许封印缺口）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  const base = { reason: "no-foldable-span", tailEvents: 5000, minEvents: 40 };
  const sealed = m.shouldTryOfflineFold({ ...base, closeout: { folded: 1 }, marks: 1, stillDue: true });
  t.eq(sealed.go, true, "due=true ⇒ 必须允许再折（真机前五名全被封印、12 分钟零折叠）");
  const done = m.shouldTryOfflineFold({ ...base, closeout: { folded: 1 }, marks: 1, stillDue: false });
  t.eq(done.go, false, "确实没欠账才算已折过");
  t.eq(done.why, "already-folded", "原因要对");
};

tests["C595 单段输出预算默认封顶 8192（慢模型下预算翻倍就跑不完）"] = async (t) => {
  const m = await import("../src/rooms/offline-fold.mjs");
  let seenMax = null;
  await m.runOfflineFold({
    graph: { nodes: { n1: { id: "n1", seq: 1 } }, edges: {}, foldMarks: [] },
    events: Array.from({ length: 400 }, (_, i) => ({ seq: i + 1, type: "user/message", text: "中".repeat(40) })),
    rangeStart: 1,
    rangeEnd: 400,
    callModel: async (_prompt, opts) => {
      seenMax = opts.maxTokens;
      return { text: "## 目标" + "中".repeat(50), usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
    },
    measureQuality: () => null,
  });
  t.eq(seenMax <= 8192, true, `预算必须 ≤ 8192（实际 ${seenMax}）——真机 kimi 8k≈169s、16k≈340s>240s 截止`);
};

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * AX-07 · 离线归档补折接入**同一守卫**（复用 AX-01 `guardModelOutput` / AX-02 `extractValueFacts`）
 *
 * 本节的判据只有一句：**离线路径不许有自己的一套裁决**。
 * 所以每条用例要么是「与 `guardModelOutput` 逐字段对拍」，要么是「guard=false 时旧字节不变」。
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

const AX07_SESSION = "session-ax07";
/** 守卫证据源：一条 user + 一条 assistant + 一条工具调用 + 一条成功结果（seq 1/2/3/4）。 */
const AX07_EVENTS = [
  u(1, "把构建跑通"),
  a(2, "先看配置"),
  { type: "tool/call", seq: 3, data: { name: "bash", arguments: "{\"command\":\"npm test\"}" } },
  tr(4, "ok"),
];
const ax07Graph = () => ({
  rootUserNodeIds: ["n1"],
  nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] } },
  edges: {},
  foldMarks: [],
});

tests["AX-07① online/offline 同输入：接受/拒绝逐字段一致（离线不许多一套裁决）"] = async (t) => {
  // 六种输入覆盖：全过 / 降级 UNVERIFIED / 整段被拒 / 坏 JSON / 未知顶层字段 / 形状不对
  const raws = [
    JSON.stringify({
      facts: [{ id: "f1", kind: "constraint", subject: "user", claim: "用户要求把构建跑通", quote: "把构建跑通", evidenceSeq: 1, validAtSeq: 2 }],
      narratives: [{ id: "nar1", text: "## 目标\n- 把构建跑通", factRefs: ["f1"], validAtSeq: 2 }],
    }),
    JSON.stringify({
      facts: [{ id: "f1", kind: "state", subject: "user", claim: "构建可能有问题" }],
      narratives: [{ id: "nar1", text: "## 未验证\n- 构建可能有问题", factRefs: ["f1"] }],
    }),
    JSON.stringify({
      facts: [{ id: "f1", kind: "constraint", subject: "user", claim: "用户说不许动 prod", quote: "不许动 prod", evidenceSeq: 1 }],
      narratives: [{ id: "nar1", text: "## 目标\n- 不许动 prod", factRefs: ["f1"] }],
    }),
    "## 目标\n- 模型没按格式来",
    JSON.stringify({ facts: [], narratives: [], extra: 1 }),
    JSON.stringify({ facts: {}, narratives: [] }),
  ];
  const source = offlineFold.buildGuardSource(AX07_EVENTS, { sessionId: AX07_SESSION });
  for (const raw of raws) {
    const online = guardModelOutput(raw, { factGuard: true, session: source });
    const { record } = offlineFold.applyOfflineGuard(offlineFold.guardOfflineFoldOutput(raw, { events: AX07_EVENTS, sessionId: AX07_SESSION }), raw);
    t.eq(record.facts, online.facts, `facts 必须逐字段一致：${raw.slice(0, 40)}`);
    t.eq(record.narratives, online.narratives, `narratives 必须逐字段一致：${raw.slice(0, 40)}`);
    t.eq(record.summary, online.summary, `summary 必须逐字段一致：${raw.slice(0, 40)}`);
    t.eq(record.applied, online.applied, "applied 一致");
    t.eq(record.degraded, online.degraded, "degraded 一致");
    t.eq(record.degradedReason, online.degradedReason, "degradedReason 一致");
  }
  // 判据来源（静态）：本文件**必须** import 那两个房间，而不是在自己家里再写一份
  const src = (await import("node:fs")).readFileSync(new URL("../src/rooms/offline-fold.mjs", import.meta.url), "utf8");
  t.includes(src, 'from "./fact-guard.mjs"', "离线路径必须 import AX-01 的守卫");
  t.includes(src, 'from "./tool-value-facts.mjs"', "离线路径必须 import AX-02 的抽取器");
  t.notIncludes(src, "QUOTE_NOT_VERBATIM", "原因码表不许在本文件里复制第二份（复制 = 第二条事实质量路径）");
};

tests["AX-07② factGuard=false ⇒ 提示词与 chunk 形状逐字不变（默认关闭）"] = async (t) => {
  const messages = [{ role: "user", nodeId: "n1", seq: 1, text: "hi" }];
  const valueFacts = [{ kind: "id", value: 4242, quote: "4242", evidenceSeq: 2, validAtSeq: 2, source: "tool:bash" }];
  t.eq(offlineFold.buildOfflinePrompt({ facts: "F", messages }), offlineFold.buildOfflinePrompt({ facts: "F", messages, factGuard: false, valueFacts }), "guard=false 时值事实不许影响提示词");
  t.notIncludes(offlineFold.buildOfflinePrompt({ facts: "F", messages, factGuard: false, valueFacts }), "事实守卫", "关掉守卫 ⇒ 提示词里根本没有守卫段");
  // 默认值来自 R15 的单一来源；本刀**不许**把它改成 true
  t.eq((await import("../src/rooms/fact-guard.mjs")).DEFAULT_ENABLED, false, "factGuard 默认必须仍为 false");

  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    callModel: async () => ({ text: "## 目标\n- 把构建跑通\n- 不许动 prod 配置", usage: null, model: "fake-model" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks.length, 1, "正常折一段");
  t.eq("guard" in out.chunks[0], false, "guard=false ⇒ chunk 不长 guard 键（旧形状）");
  t.eq("valueFacts" in out.chunks[0], false, "guard=false ⇒ chunk 不长 valueFacts 键（旧形状）");
};

tests["AX-07③ 无证据事实只能 UNVERIFIED：摘要必须带标记，不许当事实写账"] = async (t) => {
  const raw = JSON.stringify({
    facts: [{ id: "f1", kind: "state", subject: "user", claim: "构建可能有问题" }],
    narratives: [{ id: "nar1", text: "## 未验证\n- 构建可能有问题", factRefs: ["f1"] }],
  });
  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => ({ text: raw, usage: null, model: "fake-model" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.guard.verdict, "UNVERIFIED", "无证据事实 ⇒ 整份摘要降级 UNVERIFIED（不是 SUPPORTED）");
  t.eq(chunk.guard.facts[0].verdict, "UNVERIFIED", "逐条裁决同样是 UNVERIFIED");
  t.eq(chunk.guard.facts[0].entailmentProven, false, "逐字命中不许宣称语义蕴含");
  t.eq(chunk.text.split("\n")[0], `${offlineFold.GUARD_MARK_PREFIX}UNVERIFIED（NO_EVIDENCE、CITED_UNVERIFIED_FACT）`, "正文第一行必须是机器标记");
  t.includes(chunk.text, "构建可能有问题", "正文本身保留（降级不是删掉）");
};

tests["AX-07④ 引用被拒事实 ⇒ 整段拒绝，且不写半截账（guard.verdict = REJECTED）"] = async (t) => {
  // quote 不在 seq=1 的事件里 ⇒ QUOTE_NOT_VERBATIM ⇒ 事实被拒；叙事又引用了它 ⇒ 一起拒
  const raw = JSON.stringify({
    facts: [{ id: "f1", kind: "constraint", subject: "user", claim: "用户说不许动 prod", quote: "不许动 prod", evidenceSeq: 1 }],
    narratives: [{ id: "nar1", text: "## 目标\n- 不许动 prod 配置", factRefs: ["f1"] }],
  });
  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => ({ text: raw, usage: null, model: "fake-model" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks.length, 0, "被拒的叙事不许留下折痕");
  // `stopped` 是**冻结的跨进程闭集**（`STOPPED_REASONS`），本刀不往表里加值 ⇒ 复用 empty-response；
  // 「为什么没有正文」由结果上的 guard 记录承载。
  t.eq(out.failed, "empty-response", "没有可回证的正文 ⇒ 与空回答同构（不许写半截账）");
  t.eq(offlineFold.isKnownStopped(out.failed), true, "停止原因必须在 STOPPED_REASONS 里登记");
  t.eq(out.guard.verdict, "REJECTED", "守卫裁决必须留在结果上（stopped 表是闭集，不能塞语义）");
  t.eq(out.guard.facts[0].reasons[0].code, "QUOTE_NOT_VERBATIM", "逐条原因码来自 AX-01");
  t.eq(out.guard.narratives[0].reasons[0].code, "CITED_REJECTED_FACT", "叙事因引用被拒事实而被拒");
  const graph = ax07Graph();
  const before = JSON.stringify(graph);
  const applied = offlineFold.applyOfflineFoldToGraph(graph, out, { rangeStart: 1, rangeEnd: 4, now: 1 });
  t.eq(applied.marksAdded, 0, "0 段 ⇒ 0 条折痕");
  t.eq(JSON.stringify(graph), before, "一个字都不许改（欠账留着下一轮补）");
  t.eq(offlineFold.offlineFoldOutcome(out, { rangeStart: 1, rangeEnd: 4, maxSeq: 4 }).stopped, "empty-response", "outcome 要把它带出去");
};

tests["AX-07⑤ 坏 JSON ⇒ 显式 degraded + 标记，正文不丢（不许静默当没有事实）"] = async (t) => {
  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => ({ text: "## 目标\n- 模型没按格式来", usage: null, model: "fake-model" }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.guard.verdict, "DEGRADED", "坏 JSON ⇒ DEGRADED（不是 SUPPORTED）");
  t.eq(chunk.guard.degraded, true, "degraded 必须为真");
  t.eq(chunk.guard.degradedReason, "BAD_JSON", "原因码来自 AX-01");
  t.eq(chunk.guard.applied, false, "degraded 时 applied=false");
  t.includes(chunk.text, "## 目标\n- 模型没按格式来", "正文原样保留（有据可查的短摘要比零产出有用）");
  t.includes(chunk.text, `${offlineFold.GUARD_MARK_PREFIX}DEGRADED（BAD_JSON）`, "降级必须有标记");
};

tests["AX-07⑥ valueFacts：成功结果进硬事实块且满足 AX-02 契约；没有成功结果时为空数组"] = async (t) => {
  const events = [
    u(1, "把构建跑通"),
    { type: "tool/call", seq: 2, data: { name: "write", arguments: "{\"file_path\":\"/tmp/a.txt\"}" } },
    tr(3, "<path>/tmp/a.txt</path>\n<type>file</type>\n<content>\nhi\n</content>"),
    tr(4, "Error: EACCES: permission denied"),
  ];
  const facts = offlineFold.collectFoldValueFacts(events, { rangeStart: 1, rangeEnd: 4 });
  t.eq(facts.length > 0, true, "成功 write 回执必须抽出值事实");
  t.eq(facts.every((fact) => isValueFact(fact)), true, "每条都必须满足 AX-02 的六字段契约");
  t.eq(facts.every((fact) => fact.evidenceSeq === 3), true, "证据指针必须是成功结果的 seq（错误结果 seq=4 一条都不许产）");
  const block = offlineFold.renderValueFactsBlock(facts);
  t.includes(block, "## 成功工具结果的值（可回证）", "值事实块要有标题");
  t.includes(block, "seq 3", "每条都要带 seq（模型才写得出 evidenceSeq）");
  t.eq(offlineFold.renderValueFactsBlock([]), "", "空数组 ⇒ 空串（不许长出空段落）");

  // 提示词：守卫开启才出现这一段；关掉时逐字没有
  const messages = [{ role: "user", nodeId: "n1", seq: 1, text: "hi" }];
  t.includes(offlineFold.buildOfflinePrompt({ facts: "F", messages, factGuard: true, valueFacts: facts }), "## 成功工具结果的值（可回证）", "guard=true ⇒ 值事实进提示词");
  t.notIncludes(offlineFold.buildOfflinePrompt({ facts: "F", messages }), "成功工具结果的值", "guard=false ⇒ 提示词里没有这一段");

  // 端到端：没有成功结果的会话 ⇒ valueFacts 为空、守卫照常工作（空数组是正常返回值，不是错误）
  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: [u(1, "把构建跑通"), a(2, "好")],
    rangeStart: 1,
    rangeEnd: 2,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => ({
      text: JSON.stringify({
        facts: [{ id: "f1", kind: "constraint", subject: "user", claim: "用户要求把构建跑通", quote: "把构建跑通", evidenceSeq: 1 }],
        narratives: [{ id: "nar1", text: "## 目标\n- 把构建跑通", factRefs: ["f1"] }],
      }),
      usage: null,
      model: "fake-model",
    }),
    measureQuality: () => ({ constraintRecall: 1 }),
  });
  t.eq(out.chunks[0].valueFacts, [], "没有成功工具结果 ⇒ valueFacts 是空数组");
  t.eq(out.chunks[0].guard.valueFacts, 0, "留痕里记 0（不是缺字段）");
  t.eq(out.chunks[0].guard.verdict, "SUPPORTED", "空 valueFacts 不影响裁决");
};

tests["AX-07⑦ 旧图无 guard 字段：写回不长新键（guard=false）/ 长了也照常（guard=true）"] = async (t) => {
  // 旧图：没有 foldMarks / closeout / lastOfflineSummary
  const legacyGraph = { nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "x" } }, edges: {} };
  const chunk = { start: 1, end: 1, text: "## 目标\n- x", model: "m1", ms: 1, usage: null };
  offlineFold.applyOfflineFoldToGraph(legacyGraph, { chunks: [chunk], coveredStart: 1, coveredEnd: 1 }, { rangeStart: 1, rangeEnd: 1, now: 1 });
  t.eq("guard" in legacyGraph.foldMarks[0], false, "guard=false ⇒ 折痕不长 guard 键");
  t.eq("guard" in legacyGraph.lastOfflineSummary, false, "guard=false ⇒ lastOfflineSummary 不长 guard 键");

  const guardedGraph = { nodes: { n1: { id: "n1", seq: 1, kind: "user", text: "x" } }, edges: {} };
  const guardedChunk = { ...chunk, guard: { verdict: "SUPPORTED", facts: [], narratives: [], summary: null }, valueFacts: [] };
  offlineFold.applyOfflineFoldToGraph(guardedGraph, { chunks: [guardedChunk], coveredStart: 1, coveredEnd: 1 }, { rangeStart: 1, rangeEnd: 1, now: 1 });
  t.eq(guardedGraph.foldMarks[0].guard.verdict, "SUPPORTED", "guard=true ⇒ 折痕带裁决");
  t.eq(guardedGraph.lastOfflineSummary.guard.verdict, "SUPPORTED", "lastOfflineSummary 带同一份裁决");
};

tests["AX-07⑧ lastOfflineSummary 与 foldMark 的正文必须一致（单副本协议 + 同一份裁决）"] = async (t) => {
  const graph = ax07Graph();
  const result = {
    chunks: [
      { start: 1, end: 2, text: "## 目标\n- 第一段", model: "m1", ms: 1, usage: null, guard: { verdict: "SUPPORTED", facts: [], narratives: [] } },
      { start: 3, end: 4, text: "## 目标\n- 第二段", model: "m1", ms: 2, usage: null, guard: { verdict: "UNVERIFIED", facts: [], narratives: [] } },
    ],
    coveredStart: 1,
    coveredEnd: 4,
    uncoveredHead: 0,
    uncoveredTail: 0,
  };
  offlineFold.applyOfflineFoldToGraph(graph, result, { rangeStart: 1, rangeEnd: 4, now: 1 });
  const [first, last] = graph.foldMarks;
  t.includes(first.summaryText, "第一段", "非最后一段：正文直接存在折痕里");
  t.eq("summaryText" in last, false, "最后一段：只存引用（一条摘要只存一遍）");
  t.eq(last.summaryTextRef, "lastOfflineSummary", "引用指向 lastOfflineSummary");
  t.eq(offlineFold.foldMarkSummaryText(graph, last), graph.lastOfflineSummary.text, "按引用解析出来的正文必须与 lastOfflineSummary 逐字相同");
  t.includes(graph.lastOfflineSummary.text, "第二段", "解析到的是最后一段正文");
  t.eq(last.guard, graph.lastOfflineSummary.guard, "两处的裁决必须是同一份（不许一处 SUPPORTED 一处 UNVERIFIED）");
  t.eq(offlineFold.foldMarkSummaryText(graph, first), first.summaryText, "非引用折痕的解析就是它自己");
  t.eq(offlineFold.foldMarkSummaryText(graph, null), "", "null 折痕解析成空串（不炸）");
};

tests["AX-07⑨ 守卫不新增第二次模型调用，路由仍来自 callModel（不脚本另选）"] = async (t) => {
  const calls = [];
  const graph = ax07Graph();
  const out = await runOfflineFold({
    graph,
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => {
      calls.push(1);
      return {
        text: JSON.stringify({
          facts: [{ id: "f1", kind: "constraint", subject: "user", claim: "用户要求把构建跑通", quote: "把构建跑通", evidenceSeq: 1 }],
          narratives: [{ id: "nar1", text: "## 目标\n- 把构建跑通", factRefs: ["f1"] }],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "fake-model",
      };
    },
    measureQuality: () => null,
  });
  t.eq(calls.length, 1, "守卫在同一份输出上裁决，不许再发一次（禁止第二个 LLM 评委）");
  // 路由只能来自调用方注入的 callModel（引擎/脚本各自从默认配置取），守卫不许另选模型
  t.eq(out.chunks[0].model, "fake-model", "chunk.model 必须就是 callModel 交回的那个");
  offlineFold.applyOfflineFoldToGraph(graph, out, { rangeStart: 1, rangeEnd: 4, now: 1 });
  t.eq(graph.foldMarks[0].route.model, "fake-model", "折痕的路由必须与 callModel 一致（守卫不改路由）");
};

tests["AX-07⑩ 守卫的标记不破坏机械补回（缺约束仍补、且只补一次）"] = async (t) => {
  const raw = JSON.stringify({
    facts: [{ id: "f1", kind: "state", subject: "user", claim: "构建可能有问题" }],
    narratives: [{ id: "nar1", text: "## 目标\n- 构建可能有问题", factRefs: ["f1"] }],
  });
  const out = await runOfflineFold({
    graph: ax07Graph(),
    events: AX07_EVENTS,
    rangeStart: 1,
    rangeEnd: 4,
    factGuard: true,
    sessionId: AX07_SESSION,
    callModel: async () => ({ text: raw, usage: null, model: "fake-model" }),
    measureQuality: () => ({ constraintRecall: 0 }),
  });
  const chunk = out.chunks[0];
  t.eq(chunk.repaired, 1, "模型漏掉的那条约束仍要机械补回");
  t.includes(chunk.text, "- 不许动 prod 配置", "补回的约束要在正文里");
  t.eq(chunk.text.split("## 约束（逐字补充").length - 1, 1, "只补一次");
  t.eq(chunk.text.split(offlineFold.GUARD_MARK_PREFIX).length - 1, 1, "标记行只有一行（补回不许复制它）");
};

/* ══════════════════════ AX-21 · 离线路径复用「结果算不算可信」的同一份判据 ══════════════════════
 *
 * 由来（AX-20 已证实，不是假设）：旧版 `collectFoldValueFacts` 自己写了一个三元判 resultKind，
 * 漏掉 keeper 私有的 `githubReadShaped` 映射 ⇒ GitHub **读形**结果（classify 给 unverified 且
 * 不带 weak）在离线路径**一条值都抽不出来**。K-2 的 K2-O3（id / private）与 K2-N4（node_id）
 * 的答案片段因此根本不在折叠上下文里。
 *
 * 本节的判据：**同一个工具结果文本，在线与离线给出的 resultKind 必须逐字段相同**（不是「各有一套
 * 差不多」）—— 所以正例与反例成对出现，且反例必须在两条路径都不产事实。
 */

const ax21Call = (seq, callId, name, args) => ({ type: "tool/call", seq, data: { callId, name, arguments: JSON.stringify(args) } });
const ax21Result = (seq, callId, text) => ({ type: "tool/result", seq, data: { message: { content: [{ type: "text", text }], isError: false, source: { callId } } } });
/** K-2 S2-Q3 的真实形状：GitHub 仓库 API 的 JSON。 */
const AX21_REPO_JSON = '{"id": 4242, "node_id": "R_demo4242", "private": false, "default_branch": "main"}';

tests["AX-21① GitHub 读形（缺省 method / GET / HEAD）⇒ 离线也抽出 id / node_id / private"] = (t) => {
  const shapes = [
    ["缺省 method", { path: "repos/octo/demo-repo" }],
    ["显式 GET", { path: "repos/octo/demo-repo", method: "GET" }],
    ["HEAD", { path: "repos/octo/demo-repo", method: "HEAD" }],
  ];
  for (const [label, args] of shapes) {
    const facts = offlineFold.collectFoldValueFacts([ax21Call(34, "c1", "github", args), ax21Result(35, "c1", AX21_REPO_JSON)], { rangeStart: 1, rangeEnd: 100 });
    const pairs = facts.map((fact) => [fact.kind, fact.value]);
    t.eq(pairs.some(([kind, value]) => kind === "id" && value === 4242), true, `${label}：仓库 id 必须留下（K2-O3 的答案片段）`);
    t.eq(pairs.some(([kind, value]) => kind === "id" && value === "R_demo4242"), true, `${label}：node_id 必须留下（K2-N4 的答案片段）`);
    t.eq(pairs.some(([kind, value]) => kind === "boolean" && value === false), true, `${label}：private=false 必须留下（false 不是「没有」）`);
    t.eq(facts.every((fact) => fact.evidenceSeq === 35), true, `${label}：证据指针 = 结果事件 seq`);
    t.eq(facts.every((fact) => fact.source === "tool:github"), true, `${label}：source 归一成工具名（派生挂边靠它匹配）`);
    t.eq(facts.every((fact) => isValueFact(fact)), true, `${label}：每条都必须满足 AX-02 的契约`);
  }
};

tests["AX-21② GitHub 写形（POST/PATCH/PUT/DELETE / body / confirm）⇒ 离线一条事实都不产"] = (t) => {
  const shapes = [
    ["POST", { path: "repos/o/r", method: "POST", body: { name: "x" } }],
    ["PATCH", { path: "repos/o/r", method: "PATCH", body: { private: true } }],
    ["PUT", { path: "repos/o/r", method: "PUT", body: { a: 1 } }],
    ["DELETE", { path: "repos/o/r", method: "DELETE" }],
    ["缺省 method 但带 body", { path: "repos/o/r", body: { name: "x" } }],
    ["缺省 method 但 confirm:true", { path: "repos/o/r", confirm: true }],
  ];
  for (const [label, args] of shapes) {
    const facts = offlineFold.collectFoldValueFacts([ax21Call(34, "c1", "github", args), ax21Result(35, "c1", AX21_REPO_JSON)], { rangeStart: 1, rangeEnd: 100 });
    t.eq(facts, [], `${label}：写调用不许被当成弱成功（任务书 AX-04 明令）`);
  }
  // 反例必须是「工具名/实参」在起作用，不是「什么 github 结果都抽不出」：
  const readFacts = offlineFold.collectFoldValueFacts([ax21Call(34, "c1", "github", { path: "repos/o/r" }), ax21Result(35, "c1", AX21_REPO_JSON)], { rangeStart: 1, rangeEnd: 100 });
  t.ok(readFacts.length > 0, "同一份结果文本，读形必须抽得出（否则上面的空数组什么都没证明）");
};

tests["AX-21③ 判据来源（静态）：离线 import 共享判据，不再自己写 resultKind 三元"] = async (t) => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/rooms/offline-fold.mjs", import.meta.url), "utf8");
  t.includes(src, "resultKindForValueFacts", "离线必须复用 AX-02 的信任闸判据");
  t.includes(src, "resultKindForValueFacts(verdict", "必须真的调用它（import 了不用 = 还是自己判）");
  t.notIncludes(src, 'verdict?.result === "success"', "旧的私有三元已经删掉（两份实现迟早只修好一份）");
};
