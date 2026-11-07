/**
 * k2-value-reader.test.mjs —— AX-03 预注册与 reader 夹具的纯函数判据
 *
 * 只测纯函数与本地文件：**不发模型请求、不读 live home、不写证据**。
 * 真实 reader 由 AX-12 执行；这里证明的是「题面/金标准/判分/弃答/调用上限在调用前已冻结」
 * 与「reader 请求不可能夹带金标准」。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABSTENTION,
  ARM_MAPPING,
  ARMS,
  GRADERS,
  LIMITS,
  ORIGINAL_QUESTION_COUNT,
  QUESTIONS,
  READER,
  READER_PROMPT,
  REQUIRED_NEW_KINDS,
  SCHEMA,
  answerPieces,
  assertReaderPayload,
  assertValidQuestions,
  buildContexts,
  buildContextsFromGraph,
  buildFixturesDocument,
  buildMessages,
  buildPrereg,
  leakPrecheck,
  makeReaderPayload,
  normalizeAnswer,
  questionsSha256,
  resolveSession,
  runReader,
  summarize,
  validateQuestions,
} from "../scripts/k2-value-reader.mjs";
import { addAgentNode, addEdge, addUserNodeId, createGraph, settleEdge } from "./graph-fixtures.mjs";
import { extractValueFacts } from "../src/rooms/tool-value-facts.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SCRIPT = nodePath.join(HERE, "..", "scripts", "k2-value-reader.mjs");

function sourceOf() {
  return nodeFs.readFileSync(SCRIPT, "utf8");
}

export const tests = {};

tests["K2-1 预注册：10 题、原 4 题保留、新增覆盖 write/read/api、调用上限 20≤24"] = (t) => {
  const validation = validateQuestions(QUESTIONS);
  t.eq(validation.errors, [], "冻结题集必须零错误");
  t.eq(validation.ok, true, "冻结题集必须通过校验");
  t.eq(QUESTIONS.length, LIMITS.questions, "题数必须等于 LIMITS.questions");
  t.eq(validation.byOrigin["original-4"], ORIGINAL_QUESTION_COUNT, "原 4 题必须保留");
  for (const kind of REQUIRED_NEW_KINDS) t.ok(validation.byKind[kind] > 0, `新增成功值题必须覆盖 ${kind}`);
  t.eq(validation.plannedCalls, QUESTIONS.length * ARMS.length, "计划调用 = 题数 × 臂数");
  t.ok(validation.plannedCalls <= LIMITS.maxCalls, `计划调用 ${validation.plannedCalls} 必须 ≤ 上限 ${LIMITS.maxCalls}`);
  t.eq(LIMITS.retries, 0, "不重试：失败样本原样进分母");
  t.eq(ARMS, ["full", "compact"], "两臂顺序固定（成对调用）");
  t.eq(SCHEMA, "k2-value-reader-prereg-v1", "schema 冻结");
};

tests["K2-2 每题有 sourceSeq 与明确答案（UNKNOWN 只能配 UNKNOWN 判分）"] = (t) => {
  for (const item of QUESTIONS) {
    t.ok(Number.isInteger(item.sourceSeq) && item.sourceSeq > 0, `${item.id} 必须有正整数 sourceSeq`);
    t.ok(/^[0-9a-f]{16}$/.test(item.sessionHash), `${item.id} 必须有 16 位会话哈希`);
    t.ok(GRADERS.includes(item.grader), `${item.id} 判分器必须在冻结集合内`);
    const pieces = answerPieces(item);
    t.ok(pieces.length > 0, `${item.id} 必须有明确答案`);
    for (const piece of pieces) t.ok(piece.trim() !== "", `${item.id} 答案片段不得为空`);
  }
  // 反例：空答案 / 缺 sourceSeq / UNKNOWN 配错判分器都必须红。
  const broken = (patch) => QUESTIONS.map((item, index) => (index === 0 ? { ...item, ...patch } : item));
  t.ok(!validateQuestions(broken({ sourceSeq: 0 })).ok, "sourceSeq=0 必须红");
  t.ok(!validateQuestions(broken({ answer: "" })).ok, "空答案必须红");
  t.ok(!validateQuestions(broken({ answer: "UNKNOWN", grader: "exact" })).ok, "UNKNOWN 配 exact 必须红");
  t.ok(!validateQuestions(broken({ sessionHash: "zzz" })).ok, "非法会话哈希必须红");
  t.ok(!validateQuestions(QUESTIONS.slice(0, 9)).ok, "少一题必须红（不许静默缩题）");
  t.eq(ABSTENTION.answer, "UNKNOWN", "弃答答案必须是逐字 UNKNOWN");
};

tests["K2-3 冻结哈希：稳定且改一题即变"] = (t) => {
  const a = questionsSha256(QUESTIONS);
  const b = questionsSha256(QUESTIONS);
  t.eq(a, b, "同一题集两次哈希必须相同");
  t.eq(a.length, 64, "哈希是 sha256 十六进制");
  const mutated = QUESTIONS.map((item, index) => (index === 2 ? { ...item, answer: "0" } : item));
  t.ne(questionsSha256(mutated), a, "改答案必须改变冻结哈希");
  const reordered = [...QUESTIONS].reverse();
  t.ne(questionsSha256(reordered), a, "改题序也必须改变冻结哈希（题序是协议的一部分）");
};

tests["K2-4 reader 请求恰好四字段：金标准/判分器/来源坐标都不进请求"] = (t) => {
  for (const item of QUESTIONS) {
    for (const arm of ARMS) {
      const payload = makeReaderPayload(item, arm, `[${arm}] context`);
      t.eq(Object.keys(payload).sort(), ["arm", "context", "id", "question"], `${item.id}/${arm} 只允许四字段`);
      const text = buildMessages(payload)
        .map((message) => message.content)
        .join("\n");
      for (const key of ["answer", "aliases", "grader", "sourceSeq", "sessionHash", "origin", "applicability"]) {
        t.notIncludes(payload.question, `${key}=`, `${item.id}/${arm} 题面不得带 ${key}`);
      }
      t.notIncludes(text, JSON.stringify(item.answer), `${item.id}/${arm} 请求不得整体夹带金标准对象`);
      t.includes(payload.context, "context", `${item.id}/${arm} 上下文必须是传入值`);
    }
  }
  // 反例：多带一个字段必须抛。
  t.throws(() => assertReaderPayload({ id: "x", arm: "full", question: "q", context: "c", answer: "gold" }), "多字段必须抛");
  t.throws(() => assertReaderPayload({ id: "x", arm: "full", question: "q" }), "缺 context 必须抛");
  t.throws(() => assertReaderPayload({ id: "x", arm: "compact", question: "q", context: '{"grader":1}' }), "compact 台账元数据必须抛");
};

tests["K2-5 泄漏预检：题面含答案必红，干净题集必绿"] = (t) => {
  const clean = leakPrecheck({ fixtures: QUESTIONS, contexts: null });
  t.eq(clean.ok, true, "冻结题集的泄漏预检必须通过");
  t.eq(clean.checked, QUESTIONS.length * ARMS.length, "每题两臂都要检查");
  t.eq(clean.mode, "structure", "无上下文时是结构模式");

  const leaked = QUESTIONS.map((item, index) => (index === 4 ? { ...item, question: `${item.question}（答案：${answerPieces(item)[0]}）` } : item));
  const bad = leakPrecheck({ fixtures: leaked, contexts: null });
  t.eq(bad.ok, false, "题面写死答案必须判红");
  t.ok(bad.errors.some((line) => line.includes("题面含答案片段")), "必须指出是题面泄漏");

  // 上下文级：compact 上下文出现台账字段名必须红。
  const contexts = Object.fromEntries(QUESTIONS.map((item) => [item.id, { full: "raw", compact: "clean facts" }]));
  contexts[QUESTIONS[0].id] = { full: "raw", compact: 'facts "answer": "Created file"' };
  const contextLeak = leakPrecheck({ fixtures: QUESTIONS, contexts });
  t.eq(contextLeak.ok, false, "compact 上下文含台账字段名必须判红");
  t.eq(contextLeak.mode, "structure+context", "带上下文时模式必须升级");
  t.ok(contextLeak.errors.some((line) => line.includes("compact") && line.includes("金标准")), "必须指出是台账泄漏");
};

tests["K2-6 判分：exact/set/ordered/UNKNOWN 都有正反例"] = async (t) => {
  const fixtures = [
    { ...QUESTIONS[0], contexts: { full: "x Created file x", compact: "x Created file x" } }, // exact
    { ...QUESTIONS[2], contexts: { full: "x 1436032364 x false x", compact: "y" } }, // set
    { ...QUESTIONS[6], contexts: { full: "accio astudio autoclaw", compact: "y" } }, // ordered
  ];
  const answers = {
    "K2-O1": "Created file",
    "K2-O3": "false, 1436032364",
    "K2-N3": "accio,astudio,autoclaw",
  };
  const report = await runReader({ fixtures }, async (payload) => (payload.arm === "full" ? (answers[payload.id] ?? "UNKNOWN") : "UNKNOWN"));
  t.eq(report.calls, fixtures.length * ARMS.length, "每题两臂各一次");
  t.eq(report.byArm.full.correct, fixtures.length, "full 臂全对");
  t.eq(report.byArm.compact.correct, 0, "compact 臂全错（答案只在 full 上下文里）");
  t.eq(report.degraded.length, fixtures.length, "退化清单必须逐题列出");
  t.eq(report.status, "REGRESSION", "有退化就不是 PASS");

  // 弃答：UNKNOWN 判分只接受逐字 UNKNOWN。
  const abstain = [{ ...QUESTIONS[0], answer: "UNKNOWN", grader: "UNKNOWN", aliases: [], contexts: { full: "x", compact: "y" } }];
  const okRun = await runReader({ fixtures: abstain }, async () => "UNKNOWN");
  t.eq(okRun.byArm.full.correct, 1, "逐字 UNKNOWN 必须判对");
  const badRun = await runReader({ fixtures: abstain }, async () => "untested");
  t.eq(badRun.byArm.full.correct, 0, "状态词代替 UNKNOWN 必须判错");
  t.eq(badRun.results[0].grade.code, "abstention-violation", "弃答违规码固定");

  // 不靠「多弃答」换「少错」：compact 的 UNKNOWN 多于 full 必须 abstentionClean=false。
  const drift = [{ ...QUESTIONS[1], contexts: { full: "has", compact: "has" } }];
  const driftRun = await runReader({ fixtures: drift }, async (payload) => (payload.arm === "compact" ? "UNKNOWN" : answerPieces(QUESTIONS[1])[0]));
  t.eq(driftRun.byArm.compact.unknown, 1, "compact 多了一个 UNKNOWN");
  t.eq(driftRun.abstentionClean, false, "靠增加弃答换少错必须判负");
};

tests["K2-7 上下文构造：tool/result 只进 full，compact = 文本 + 生产 facts"] = (t) => {
  const events = [
    { type: "user/message", data: { message: { content: [{ type: "text", text: "U" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "A" }] } } },
    { type: "tool/result", data: { message: { content: [{ type: "text", text: "TOOLTEXT" }] } } },
    { type: "step/start" },
  ];
  const contexts = buildContexts(events, "FACTS");
  t.eq(contexts.full, "UATOOLTEXT", "full 臂 = 文本 + 原始工具结果");
  t.eq(contexts.compact, "UAFACTS", "compact 臂 = 文本 + 生产 renderFacts 输出");
  t.notIncludes(contexts.compact, "TOOLTEXT", "compact 臂不得含原始工具结果");
  t.eq(buildContexts([], ""), { full: "", compact: "" }, "空输入");
  t.eq(buildContexts([{ type: "tool/result", data: { message: { content: "plain" } } }], "").full, "plain", "字符串 content 兼容");
};

tests["K2-8 无模型副作用：没有 fetch、没有宿主 import、没有默认 reader"] = (t) => {
  const source = sourceOf();
  t.notIncludes(source, "fetch(", "脚本不得自己发请求");
  t.notIncludes(source, "@deepseek-ai/", "脚本不得 import 宿主包");
  t.notIncludes(source, "openai", "脚本不得内置模型客户端");
  t.includes(source, "readFileSync", "只读会话日志");
  for (const message of buildMessages(makeReaderPayload(QUESTIONS[0], "full", "ctx"))) {
    t.eq(message.role === "system" || message.role === "user", true, "只有 system/user 两条消息");
  }
  t.includes(READER_PROMPT, "output exactly UNKNOWN", "提示词必须写死弃答规则");
  t.eq(READER.model, "deepseek-v4.1-flash-1017", "reader 路由冻结");
  t.eq(READER.endpoint, "http://127.0.0.1:3425/v1/chat/completions", "reader 端点冻结");
  t.eq(READER.temperature, 0, "解码参数冻结");
  t.eq(READER.stream, false, "非流式（便于逐条落盘原始输出）");
  t.eq(ARM_MAPPING.full.includes("baseline"), true, "full 必须显式映射到 baseline");
  t.eq(ARM_MAPPING.compact.includes("every-step"), true, "compact 必须显式映射到 every-step");
};

tests["K2-9 runReader 必须显式注入 reader；缺会话必须抛（不静默 skip）"] = async (t) => {
  let threw = false;
  try {
    await runReader({ fixtures: [{ ...QUESTIONS[0], contexts: { full: "a", compact: "b" } }] }, null);
  } catch {
    threw = true;
  }
  t.eq(threw, true, "没有显式 reader 必须抛（本模块没有默认模型客户端）");
  t.throws(() => resolveSession("", "0000000000000000"), "缺 home 必须抛");
  t.throws(() => resolveSession("/ax03-nonexistent-home", "0000000000000000"), "找不到 sessions 必须抛");
  t.throws(() => assertValidQuestions(QUESTIONS.slice(0, 9)), "少题必须抛（不静默 skip）");
};

tests["K2-10 预注册与夹具产物：字段齐全、调用预算一致、不含上下文正文"] = (t) => {
  const prereg = buildPrereg({ frozenAtRev: "deadbeef", frozenAt: "2026-11-07T00:00:00.000Z" });
  t.eq(prereg.schema, SCHEMA, "prereg schema");
  t.eq(prereg.taskId, "AX-03", "任务编号");
  t.eq(prereg.frozenAtRev, "deadbeef", "冻结 rev 必须记录");
  t.eq(prereg.questionIds.length, QUESTIONS.length, "题号清单");
  t.eq(prereg.questionsSha256, questionsSha256(QUESTIONS), "prereg 与题集哈希一致");
  t.eq(prereg.realRun.executor, "AX-12", "真实运行归属 AX-12");
  t.eq(prereg.realRun.editor, "forbidden", "禁止看到结果后改题");
  t.eq(prereg.validation.ok, true, "prereg 自带校验结论");

  const document = buildFixturesDocument({ questions: QUESTIONS, prereg, coverage: [], sources: [], leak: { ok: true } });
  t.eq(document.schema, "k2-value-reader-fixtures-v1", "fixtures schema");
  t.eq(document.frozen, true, "夹具必须显式冻结");
  t.eq(document.questionsSha256, prereg.questionsSha256, "两份产物哈希一致");
  t.eq(document.callBudget.plannedCalls, QUESTIONS.length * ARMS.length, "调用预算 = 题数 × 臂数");
  t.ok(document.callBudget.plannedCalls <= document.callBudget.maxCalls, "预算不得超过上限");
  t.includes(document.contextBuilder, "buildReaderFixtures", "夹具必须声明上下文构造入口");
  for (const item of document.questions) {
    t.eq("contexts" in item, false, `${item.id} 夹具不得冻结 compact 正文（必须由 AX-12 现场生成）`);
  }
};

tests["K2-11 summarize：分母保留、退化逐题列出、NOT_RUN 不冒充 PASS"] = (t) => {
  const fixtures = QUESTIONS.slice(0, 2);
  const idle = summarize(fixtures, []);
  t.eq(idle.status, "NOT_RUN", "零调用不得冒充 PASS");
  t.eq(idle.calls, 0, "零调用");

  const results = [];
  for (const item of fixtures) {
    for (const arm of ARMS) {
      results.push({ id: item.id, kind: item.kind, arm, answer: "x", grade: { correct: arm === "full" }, error: null });
    }
  }
  const report = summarize(fixtures, results);
  t.eq(report.questions, fixtures.length, "题数");
  t.eq(report.calls, results.length, "调用数");
  t.eq(report.byArm.full.total, fixtures.length, "full 分母");
  t.eq(report.byArm.compact.total, fixtures.length, "compact 分母");
  t.eq(report.degraded.length, fixtures.length, "退化清单逐题");
  t.eq(report.maxCalls, LIMITS.maxCalls, "上限随报告带出");
  t.eq(normalizeAnswer("  `UNKNOWN` \n"), "UNKNOWN", "答案归一化只去一层包裹");
};

/* ═════════════════ AX-20：K-2 复跑只看「compact 臂有没有开 factGuard」 ═════════════════
 *
 * AX-12 已证实：候选上下文里**没有**成功结果的字面值 ⇒ 10 题退化 7 题。
 * AX-18 把字面 quote（`— Created file`）补进了值事实行，但 `factGuard !== true` 时
 * `valueFactLines()` 一行都不产出 ⇒ 不显式开开关，AX-18 的修复**逐字等于没做**。
 * 这两个用例钉住「compact 臂默认开」+「题集与 ax03 冻结预注册逐字相同」。
 */

/** K-2 S1-Q1 的真实形状：成功 `write` 的回执（字面值长在 `<content>` 里）。 */
const createdFileResult = (path) => `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`;

/** 一张「成功工具结果」图：user →（成功边）→ agent，边上挂着 AX-02 抽出的值事实。 */
function valueFactGraph() {
  const g = createGraph({ sessionId: "ax20", cwd: "/tmp" });
  const u = addUserNodeId(g, { seq: 1, text: "把 a.mjs 建出来。" });
  const edgeId = addEdge(g, { from: u, intent: "写文件", action: "write(file_path=D:/x/a.mjs)", evidence: { start: 4, end: 5 } });
  const agent = addAgentNode(g, { seq: 6, goal: "写文件", worldHash: "W1", constraintHash: "C1", via: edgeId }).id;
  const settled = settleEdge(g, edgeId, { to: agent, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  settled.valueFacts = extractValueFacts({ tool: "write", result: createdFileResult("D:/x/a.mjs"), resultKind: "success", evidenceSeq: 5 });
  return g;
}

tests["K2-12 compact 臂默认开 factGuard：AX-18 的字面 quote 必须进上下文（否则 K2-O1 必然答不出）"] = (t) => {
  const events = [
    { type: "user/message", data: { message: { content: [{ type: "text", text: "U" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "A" }] } } },
    { type: "tool/result", data: { message: { content: [{ type: "text", text: "TOOLTEXT" }] } } },
  ];
  const g = valueFactGraph();
  t.eq(extractValueFacts({ tool: "write", result: createdFileResult("D:/x/a.mjs"), resultKind: "success", evidenceSeq: 5 }).length > 0, true, "夹具必须先抽出事实（否则本用例什么都没证明）");

  const on = buildContextsFromGraph(g, events, { factGuard: true });
  t.includes(on.facts, "VALUE_FACTS_VERBATIM", "guard 打开必须有值事实段");
  t.includes(on.facts, "— Created file", "行尾必须带 AX-18 的字面 quote");
  t.eq(on.contexts.compact, "UA" + on.facts, "compact = 文本 + facts（逐字拼接）");
  t.notIncludes(on.contexts.compact, "TOOLTEXT", "compact 臂不得含原始工具结果");
  t.eq(on.contexts.full, "UATOOLTEXT", "full 臂保持原始 tool/result 逐字不变");

  const dflt = buildContextsFromGraph(g, events);
  t.eq(dflt.factGuard, true, "factGuard 默认值必须为 true（compact 臂定义的一部分）");
  t.eq(dflt.facts, on.facts, "省略选项时必须等于显式 true");

  const off = buildContextsFromGraph(g, events, { factGuard: false });
  t.notIncludes(off.facts, "VALUE_FACTS_VERBATIM", "guard 关闭时不得出现值事实段");
  t.notIncludes(off.facts, "Created file", "guard 关闭时字面 quote 不得渲染（零差异契约）");

  // 源码钉住：compact 臂的渲染入口必须把 factGuard 传进生产 renderFacts，且默认 true。
  const source = sourceOf();
  t.includes(source, "{ factGuard = true }", "默认值必须写死 true");
  t.includes(source, "renderFacts(graph, { factGuard: factGuard === true })", "renderFacts 必须收到 factGuard（production 渲染入口）");
};

tests["K2-13 题集/判分/路由与 ax03 冻结预注册逐字相同（复跑不得改题）"] = (t) => {
  const preregPath = nodePath.join(HERE, "..", "tmp", "axiom-2026-11-07", "ax03", "prereg.json");
  t.eq(nodeFs.existsSync(preregPath), true, "ax03 冻结预注册必须存在（只读对照）");
  const prereg = JSON.parse(nodeFs.readFileSync(preregPath, "utf8"));
  t.eq(questionsSha256(QUESTIONS), prereg.questionsSha256, "题集哈希必须与冻结预注册逐字相同");
  t.eq(QUESTIONS.map((item) => item.id), prereg.questionIds, "题号与顺序必须相同");
  t.eq(LIMITS.maxCalls, prereg.limits.maxCalls, "调用上限必须相同");
  t.eq(LIMITS.retries, prereg.limits.retries, "retries 必须相同（0）");
  t.eq(READER.model, prereg.reader.model, "reader 模型必须相同");
  t.eq(READER.endpoint, prereg.reader.endpoint, "reader 端点必须相同");
  t.eq(READER.temperature, prereg.reader.temperature, "解码温度必须相同");
  t.eq(READER.stream, prereg.reader.stream, "流式开关必须相同");
  t.eq(JSON.stringify(ARM_MAPPING), JSON.stringify(prereg.armMapping), "臂映射必须逐字相同");
  t.eq(ABSTENTION.answer, prereg.abstention.answer, "弃答答案必须相同");
  t.eq([...GRADERS], [...prereg.graders], "判分器集合必须相同");
  t.eq(validateQuestions(QUESTIONS).byOrigin["original-4"], prereg.originalQuestionCount, "原 4 题必须保留");
};
