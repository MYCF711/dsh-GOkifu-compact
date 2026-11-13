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
  coverageOf,
  deriveValueFacts,
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
import { extractValueFacts, isValueFact } from "../src/rooms/tool-value-facts.mjs";

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
  t.includes(source, "factGuard: factGuard === true", "renderFacts 必须收到 factGuard（production 渲染入口）");
  t.includes(source, "maxValueFacts", "K-2 实验臂必须显式给出值事实渲染上限（否则 30+ 条短值会被 8 条截断）");
};

tests["K2-13 题集/判分/路由与 ax03 冻结预注册逐字相同（复跑不得改题）"] = (t) => {
  // ★ C660：冻结预注册已版本化到 `test/fixtures/ax03/`（原来读 git 忽略的 tmp/ ⇒ 干净 checkout 直接 ENOENT）。
  const preregPath = nodePath.join(HERE, "fixtures", "ax03", "prereg.json");
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

/* ═══════════════ K2-14+ · AX-21 派生挂边：唯一匹配才挂（K2-N4 形状） ═══════════════
 *
 * 由来（AX-20 已证实）：K2-N4 的候选回答是上下文里**另一条**响应的 `node_id` ——
 * 值事实被挂到了「`evidence.end` 恰好等于 evidenceSeq」的那条边上，而那条边属于**另一个**
 * GitHub 响应。旧实现的「多义」判据只看 end 的条数，一旦工具名能消歧也不会用它。
 *
 * 现在的判据（宁可不答，不许挂错）：
 *   ① `evidence.end === evidenceSeq` 只有一条 ⇒ 挂它（旧行为逐字不变）；
 *   ② 多于一条 ⇒ 用 `edge.action` 的工具名与 `fact.source` 的 `tool:<name>` 消歧；
 *      唯一命中才挂；0 条命中 ⇒ `unmapped`；仍多于一条 ⇒ `multi`（**都不挂**）。
 */

const k2Call = (seq, callId, name, args) => ({ type: "tool/call", seq, data: { callId, name, arguments: JSON.stringify(args) } });
const k2Result = (seq, callId, text) => ({ type: "tool/result", seq, data: { message: { content: [{ type: "text", text }], isError: false, source: { callId } } } });
/** 仓库 JSON：id / node_id / private 三条短值（K2-O3 + K2-N4 的答案来源）。 */
const REPO_JSON = '{"id": 1436032364, "node_id": "R_kgDOVZgdbA", "private": false}';
/** 另一条响应（commits/main）的 JSON：只有 node_id 是短值 —— 正是「另一条响应的 node_id」。 */
const COMMIT_JSON = '{"sha": "a3a49a38c44a2d3166c50f42cf18f631062c44ad", "node_id": "C_kwDOVZgdbNoAKGEzYTQ5"}';
const K2_N4_EVENTS = [
  k2Call(34, "c1", "github", { path: "repos/Betsy20/magpie-Jet-Hub" }),
  k2Result(35, "c1", REPO_JSON),
  k2Call(116, "c2", "github", { path: "repos/Betsy20/magpie-Jet-Hub/commits/main" }),
  k2Result(117, "c2", COMMIT_JSON),
];
const edgeOf = (graph, id) => graph.edges[id];

tests["K2-14 K2-N4 形状：两条响应的 node_id 各挂各的边（不许把另一条响应的值当答案）"] = (t) => {
  const graph = {
    rootUserNodeIds: [],
    nodes: {},
    edges: {
      e4: { id: "e4", action: "github(path=repos/Betsy20/magpie-Jet-Hub)", evidence: { start: 34, end: 35 } },
      e18: { id: "e18", action: "github(path=repos/Betsy20/magpie-Jet-Hub/commits/main)", evidence: { start: 116, end: 117 } },
    },
  };
  const before = JSON.stringify(graph);
  const derived = deriveValueFacts(graph, K2_N4_EVENTS, { rangeStart: 1, rangeEnd: 1_000_000 });

  t.eq(JSON.stringify(graph), before, "输入图必须一个字节都没变（不写 live 图）");
  t.eq(derived.facts, 4, "抽到 4 条值事实（仓库 3 条 + 提交 1 条）");
  t.eq(derived.attached.length, 4, "4 条全部唯一命中");
  t.eq(derived.unmapped, 0, "没有未命中");
  t.eq(derived.multi, 0, "没有多义");
  t.eq(derived.before, 0, "派生前图上 0 条值事实");
  t.eq(derived.before + derived.attached.length, 4, "派生后 4 条");

  const repoEdge = edgeOf(derived.graph, "e4").valueFacts;
  const commitEdge = edgeOf(derived.graph, "e18").valueFacts;
  t.eq(repoEdge.every((fact) => fact.evidenceSeq === 35), true, "e4 上的事实必须全部来自 seq 35（仓库 JSON）");
  t.eq(commitEdge.every((fact) => fact.evidenceSeq === 117), true, "e18 上的事实必须全部来自 seq 117（commits JSON）");
  t.eq(repoEdge.some((fact) => fact.kind === "id" && fact.value === "R_kgDOVZgdbA"), true, "仓库的 node_id 必须挂在仓库那条边上（K2-N4 的答案片段）");
  t.eq(repoEdge.some((fact) => fact.kind === "id" && fact.value === 1436032364), true, "仓库 id 必须留下（K2-O3）");
  t.eq(repoEdge.some((fact) => fact.kind === "boolean" && fact.value === false), true, "private=false 必须留下（K2-O3）");
  t.eq(commitEdge.some((fact) => fact.value === "R_kgDOVZgdbA"), false, "仓库的值**不许**挂到提交那条边上");
  t.eq(repoEdge.some((fact) => fact.value === "C_kwDOVZgdbNoAKGEzYTQ5"), false, "提交的值**不许**挂到仓库那条边上");
  for (const fact of [...repoEdge, ...commitEdge]) t.eq(isValueFact(fact), true, "每条都必须满足 AX-02 的六字段契约");
};

tests["K2-15 同 end 多边：工具名唯一匹配才挂；多义（multi）与无匹配（unmapped）都不挂"] = (t) => {
  /** 每次都给一条 seq 117 的边当对照：证明消歧只影响 seq 35 那组。 */
  const deriveWith = (edges) =>
    deriveValueFacts(
      { rootUserNodeIds: [], nodes: {}, edges: { ...edges, e18: { id: "e18", action: "github(path=repos/o/r/commits/main)", evidence: { start: 116, end: 117 } } } },
      K2_N4_EVENTS,
      { rangeStart: 1, rangeEnd: 1_000_000 },
    );

  // ① 同 end 两条边、工具名不同 ⇒ 工具名唯一匹配，挂 github 那条
  const byTool = deriveWith({
    e4: { id: "e4", action: "github(path=repos/o/r)", evidence: { start: 34, end: 35 } },
    e5: { id: "e5", action: "bash(command=gh api repos/o/r)", evidence: { start: 34, end: 35 } },
  });
  t.eq(byTool.multi, 0, "工具名能消歧 ⇒ 不算多义");
  t.eq(byTool.unmapped, 0, "两边都有对应边 ⇒ 没有未命中");
  t.eq(byTool.attached.filter((row) => row.edge === "e4").length, 3, "seq 35 的 3 条挂到 github 那条边");
  t.eq(byTool.attached.filter((row) => row.edge === "e18").length, 1, "seq 117 的 1 条挂到 commits 那条边");
  t.eq(edgeOf(byTool.graph, "e5").valueFacts, undefined, "不许挂到 bash 那条边（挂错 = 把另一条响应的值当答案）");

  // ② 同 end 两条边、工具名相同 ⇒ 多义，只计数不挂（宁可不答）
  const multi = deriveWith({
    e4: { id: "e4", action: "github(path=repos/o/r)", evidence: { start: 34, end: 35 } },
    e6: { id: "e6", action: "github(path=repos/o/other)", evidence: { start: 34, end: 35 } },
  });
  t.eq(multi.multi, 3, "seq 35 的 3 条全部多义");
  t.eq(multi.attached.filter((row) => row.edge === "e4" || row.edge === "e6").length, 0, "多义时两条边都不挂（不猜）");
  t.eq(edgeOf(multi.graph, "e4").valueFacts, undefined, "e4 不许挂");
  t.eq(edgeOf(multi.graph, "e6").valueFacts, undefined, "e6 不许挂");
  t.eq(multi.attached.filter((row) => row.edge === "e18").length, 1, "对照组的 seq 117 照旧唯一命中");

  // ③ 同 end 但有边、且没有一条是这次调用的工具 ⇒ unmapped（有边 ≠ 可挂）
  const unmapped = deriveWith({
    e5: { id: "e5", action: "bash(command=gh api repos/o/r)", evidence: { start: 34, end: 35 } },
    e7: { id: "e7", action: "read(file_path=x)", evidence: { start: 34, end: 35 } },
  });
  t.eq(unmapped.unmapped, 3, "工具名都对不上 ⇒ 3 条计入 unmapped");
  t.eq(unmapped.attached.filter((row) => row.edge === "e5" || row.edge === "e7").length, 0, "一条都不许挂");

  // ④ 边没有可解析的工具名（旧图/夹具）⇒ 不构成排除证据，唯一命中照旧挂
  const legacy = deriveWith({
    e9: { id: "e9", evidence: { start: 34, end: 35 } },
    e5: { id: "e5", action: "bash(command=x)", evidence: { start: 34, end: 35 } },
  });
  t.eq(legacy.attached.filter((row) => row.edge === "e9").length, 3, "旧图（无 action）与正确工具名等价 ⇒ 唯一命中");
  t.eq(edgeOf(legacy.graph, "e5").valueFacts, undefined, "仍然不许挂到 bash 那条边");
};

tests["K2-16 派生开关与无命中：derive=false 不抽不挂；没有对应边只计数"] = (t) => {
  const graph = {
    rootUserNodeIds: [],
    nodes: {},
    edges: { e4: { id: "e4", action: "github(path=repos/o/r)", evidence: { start: 34, end: 35 } } },
  };
  const before = JSON.stringify(graph);
  const off = deriveValueFacts(graph, K2_N4_EVENTS, { derive: false });
  t.eq(off.derive, false, "derive=false 原样带出");
  t.eq(off.facts, 0, "derive=false 不抽");
  t.eq(off.attached.length, 0, "derive=false 不挂");
  t.eq(off.before, 0, "derive=false 时 before 仍如实统计");
  t.eq(JSON.stringify(off.graph), before, "derive=false 时图内容不变（深拷贝，逐字相同）");
  t.eq(JSON.stringify(graph), before, "输入图不变");

  // 只有 seq 117 的边：seq 35 的 3 条没有对应边 ⇒ unmapped，一条都不挂
  const partial = deriveValueFacts(
    { rootUserNodeIds: [], nodes: {}, edges: { e18: { id: "e18", action: "github(path=commits)", evidence: { start: 116, end: 117 } } } },
    K2_N4_EVENTS,
    { rangeStart: 1, rangeEnd: 1_000_000 },
  );
  t.eq(partial.unmapped, 3, "seq 35 的 3 条没有对应边");
  t.eq(partial.attached.length, 1, "只有 seq 117 的那条挂上");
  t.eq(partial.attached[0].edge, "e18", "挂到唯一命中的边");
  t.eq(partial.attached[0].evidenceSeq, 117, "明细里带 evidenceSeq（可逐条回源）");

  // 证据区间不完整的边（没有 evidence.end）不参与挂边（不猜）
  const noEnd = deriveValueFacts(
    { rootUserNodeIds: [], nodes: {}, edges: { e4: { id: "e4", action: "github(path=repos/o/r)", evidence: { start: 34 } } } },
    K2_N4_EVENTS,
    { rangeStart: 1, rangeEnd: 1_000_000 },
  );
  t.eq(noEnd.attached.length, 0, "没有 evidence.end 的边不许被挂（否则就是按 start 猜）");
  t.eq(noEnd.unmapped, 4, "4 条全部计入 unmapped");
};

/* ═══════════════ K2-17+ · AX-22 派生路径的两个新形状（read 正文 / 顶层数组） ═══════════════
 *
 * 由来（AX-21 已证实，不是假设）：K-2 剩下的 4 题**不是**「派生挂边」的问题，是抽取器**根本不产**：
 *   · K2-N2 / K2-N3 的答案在 `read` 的**文件正文**里（`id: 'codearts',` / `'accio',`）；
 *   · K2-N5 / K2-N6 的答案在 GitHub `contents` 的**顶层 JSON 数组**里（`sha` / `size`）。
 * AX-22 给抽取器加了两个**默认关闭**的开关，**只有读形**打开；K-2 派生路径必须显式开
 * （否则 `collectFoldValueFacts` 不传 options ⇒ 一条都不产）。
 *
 * 这两组用例钉住的判据：
 *   ① 派生路径对 read/github 读形**打开**两个开关 ⇒ 值事实真的挂到那条边；
 *   ② 非读形工具（write / bash / todo_write）**保持默认 false** ⇒ 一条都不产（契约第 3 条）；
 *   ③ 答案片段的字符串覆盖（compact 臂）在「只有这两条边」的图上为真 —— 证明可见性来自派生。
 */

/** K2-N2 形状：`read` 回 provider-registry.js（前 50 行是文档注释，答案行在中间）。 */
const K2_READ_PROVIDERS = [
  "<path>/d/work/demo/vendor/lib/provider-registry.js</path>",
  "<type>file</type>",
  "<content>",
  "1: /**",
  "2:  * 各 provider 的元数据与能力声明。",
  "3:  */",
  "4: export const PROVIDER_REGISTRY = Object.freeze([",
  "5:   {",
  "6:     id: 'codearts',",
  "7:     label: 'CodeArts (华为云)',",
  "8:   },",
  "9: ]);",
  "</content>",
].join("\n");

/** K2-N3 形状：`read` 回 plugin.mjs，`DSH_PROVIDERS` 的前三个元素各占一行。 */
const K2_READ_PROVIDERS_LIST = [
  "<path>/d/work/demo/src/plugin.mjs</path>",
  "<type>file</type>",
  "<content>",
  "100:  * 注释：这一行是散文，不是值。",
  "101:  */",
  "102: export const DSH_PROVIDERS = [",
  "103:   'accio',",
  "104:   'astudio',",
  "105:   'autoclaw',",
  "106:   'autoclawintl',",
  "107: ];",
  "</content>",
].join("\n");

/** K2-N5 / K2-N6 形状：GitHub `contents` 目录列表（顶层 JSON 数组；sha / size 是答案）。 */
const K2_CONTENTS_ARRAY = [
  '[{"name":"accio-adapter.d.ts","path":"vendor/lib/accio-adapter.d.ts",',
  '"sha":"c6f9d7a186c54e87f79007f6e08626dcb8701e8c","size":23738,',
  '"url":"https://api.github.com/repos/o/r/contents/vendor/lib/accio-adapter.d.ts?ref=x","type":"file"}]',
].join("");

const K2_READ_EVENTS = [
  k2Call(170, "r1", "read", { file_path: "provider-registry.js" }),
  k2Result(171, "r1", K2_READ_PROVIDERS),
  k2Call(172, "r2", "read", { file_path: "plugin.mjs" }),
  k2Result(173, "r2", K2_READ_PROVIDERS_LIST),
];

/**
 * 一张**真图**（`createGraph` 的完整结构）：每条 span 一条边，边结算成 classify 的 read 弱成功。
 * 为什么不手写 `{nodes:{}, edges:{}}`：`renderFacts` 要读 `order` / `latestAgentNode`，
 * 手写对象会在渲染期 TypeError —— 那样用例测的是夹具形状，不是派生行为。
 */
function derivedGraphFor(spans) {
  const g = createGraph({ sessionId: "ax22", cwd: "/tmp" });
  const u = addUserNodeId(g, { seq: 1, text: "把这些结果读出来。" });
  const edgeIds = [];
  for (const [index, span] of spans.entries()) {
    const edgeId = addEdge(g, { from: u, intent: `第 ${index + 1} 步`, action: span.action, evidence: { start: span.start, end: span.end } });
    const agent = addAgentNode(g, { seq: span.end + 1, goal: `第 ${index + 1} 步`, worldHash: `W${index + 1}`, constraintHash: "C1", via: edgeId }).id;
    settleEdge(g, edgeId, { to: agent, result: "unverified", verify: { kind: "read", summary: "read" }, weak: "read" });
    edgeIds.push(edgeId);
  }
  return { graph: g, edgeIds };
}

tests["K2-17 AX-22 read 正文行值：派生路径把 <content> 短值行挂到 read 边（K2-N2/N3 形状）"] = (t) => {
  const { graph, edgeIds } = derivedGraphFor([
    { action: "read(file_path=provider-registry.js)", start: 170, end: 171 },
    { action: "read(file_path=plugin.mjs)", start: 172, end: 173 },
  ]);
  const before = JSON.stringify(graph);
  const derived = deriveValueFacts(graph, K2_READ_EVENTS, { rangeStart: 1, rangeEnd: 1_000_000 });

  t.eq(JSON.stringify(graph), before, "输入图必须一个字节都没变（不写 live 图）");
  t.eq(derived.facts, 8, "两条 read 各 1 条路径 + 2 / 4 条正文行值");
  t.eq(derived.attached.length, 8, "全部唯一命中（evidence.end === 结果 seq）");
  t.eq(derived.unmapped, 0, "没有未命中");
  t.eq(derived.multi, 0, "没有多义");

  const e31 = edgeOf(derived.graph, edgeIds[0]).valueFacts;
  const e32 = edgeOf(derived.graph, edgeIds[1]).valueFacts;
  t.eq(e31.map((fact) => fact.kind), ["file_path", "value", "value"], "e31 = 路径 + 两条带值行（注释/骨架不是值）");
  t.eq(e31[1].value, "id: 'codearts',", "K2-N2 的答案行（值 = 行文本）");
  t.eq(e31[1].quote, "id: 'codearts',", "quote 逐字（模型能照抄、守卫能回证）");
  t.eq(e31.every((fact) => fact.evidenceSeq === 171), true, "证据指针 = 这条结果事件的 seq");
  t.eq(e32.map((fact) => fact.value), ["/d/work/demo/src/plugin.mjs", "'accio',", "'astudio',", "'autoclaw',", "'autoclawintl',"], "K2-N3 的前几个元素各占一条");
  for (const fact of [...e31, ...e32]) {
    t.eq(isValueFact(fact), true, "每条都必须满足 AX-02 的六字段契约");
    t.eq(fact.source, "tool:read", "source 必须是 read");
  }

  // 字符串覆盖：只有这两条边时，两题的答案片段都在 compact 上下文里（≤ 8 条渲染上限）。
  const { facts, contexts } = buildContextsFromGraph(derived.graph, K2_READ_EVENTS, { factGuard: true });
  t.includes(facts, "VALUE_FACTS_VERBATIM", "值事实段必须渲染");
  t.eq(coverageOf({ answer: "codearts" }, contexts).compact, true, "K2-N2 的答案片段必须出现在 compact 上下文里");
  t.eq(coverageOf({ answer: ["accio", "astudio", "autoclaw"] }, contexts).compact, true, "K2-N3 的三个元素必须全部出现（ordered 判分前提）");
};

tests["K2-18 AX-22 顶层 JSON 数组：contents 结果的 sha / size 派生并挂边（K2-N5/N6 形状）"] = (t) => {
  const events = [k2Call(128, "c9", "github", { path: "repos/o/r/contents/vendor/lib?ref=abc" }), k2Result(129, "c9", K2_CONTENTS_ARRAY)];
  const { graph, edgeIds } = derivedGraphFor([
    { action: "github(path=repos/o/r/contents/vendor/lib)", start: 128, end: 129 },
  ]);
  const before = JSON.stringify(graph);
  const derived = deriveValueFacts(graph, events, { rangeStart: 1, rangeEnd: 1_000_000 });

  t.eq(JSON.stringify(graph), before, "输入图必须一个字节都没变");
  const facts = edgeOf(derived.graph, edgeIds[0]).valueFacts;
  t.eq(facts.map((fact) => fact.value), ["accio-adapter.d.ts", "vendor/lib/accio-adapter.d.ts", "c6f9d7a186c54e87f79007f6e08626dcb8701e8c", "23738", "file"], "对象字段按文档顺序（URL 长串跳过），数字字符串化");
  t.eq(facts.every((fact) => fact.kind === "value"), true, "顶层数组一律产 value 事实（不冒充 id/config）");
  t.eq(facts.every((fact) => isValueFact(fact)), true, "六字段契约");
  for (const fact of facts) t.ok(K2_CONTENTS_ARRAY.includes(fact.quote), `quote 必须是原 JSON 片段：${JSON.stringify(fact.quote)}`);

  const { contexts } = buildContextsFromGraph(derived.graph, events, { factGuard: true });
  t.eq(coverageOf({ answer: "c6f9d7a186c54e87f79007f6e08626dcb8701e8c" }, contexts).compact, true, "K2-N5 的 sha 必须出现在 compact 上下文里");
  t.eq(coverageOf({ answer: "23738" }, contexts).compact, true, "K2-N6 的 size 必须出现在 compact 上下文里");
};

tests["K2-19 AX-22 反例：非读形工具（write/bash/todo_write）的数组/正文一条都不派生；args 数组仍绝不抽"] = (t) => {
  const graph = { rootUserNodeIds: [], nodes: {}, edges: { e1: { id: "e1", action: "write(file_path=a.json)", evidence: { start: 1, end: 2 } } } };
  const shapes = [
    ["write", "write(file_path=a.json)", K2_CONTENTS_ARRAY],
    ["bash", "bash(command=cat a.json)", K2_READ_PROVIDERS],
    ["todo_write", "todo_write(todos=[object Object])", K2_CONTENTS_ARRAY],
  ];
  for (const [tool, action, result] of shapes) {
    const events = [k2Call(1, "c1", tool, { file_path: "a.json" }), k2Result(2, "c1", result)];
    const derived = deriveValueFacts(
      { rootUserNodeIds: [], nodes: {}, edges: { e1: { id: "e1", action, evidence: { start: 1, end: 2 } } } },
      events,
      { rangeStart: 1, rangeEnd: 1_000_000 },
    );
    t.eq(derived.facts, 0, `${tool}：非读形 ⇒ 一条事实都不许产（顶层数组/正文都不是返回值）`);
    t.eq(derived.attached.length, 0, `${tool}：不许挂任何边`);
  }

  // args 里的数组绝不成为事实（即使结果是空数组、两个开关都会被打开）。
  const argsEvents = [
    k2Call(10, "c1", "read", { file_path: "todos.json" }),
    k2Result(11, "c1", "[]"),
  ];
  const derived = deriveValueFacts(
    { rootUserNodeIds: [], nodes: {}, edges: { e9: { id: "e9", action: "read(file_path=todos.json)", evidence: { start: 10, end: 11 } } } },
    argsEvents,
    { rangeStart: 1, rangeEnd: 1_000_000 },
  );
  t.eq(derived.facts, 0, "空顶层数组 ⇒ 没有元素可抽（也不许回落去抽 args）");
  t.eq(derived.attached.length, 0, "一条都不挂");
};

tests["K2-20 AX-22 有界与幂等：长正文只留 maxFacts 条；两趟合并后旧形状不重复"] = (t) => {
  // ① 长正文：一条 read 结果里 200 行带值，派生出的该边事实仍 ≤ maxFacts（每边封顶）。
  const manyLines = Array.from({ length: 200 }, (_, index) => `${index + 1}:   id: 'provider-${index}',`).join("\n");
  const longRead = `<path>/d/work/demo/big.js</path>\n<type>file</type>\n<content>\n${manyLines}\n</content>`;
  const events = [k2Call(1, "c1", "read", { file_path: "big.js" }), k2Result(2, "c1", longRead)];
  const graph = { rootUserNodeIds: [], nodes: {}, edges: { e1: { id: "e1", action: "read(file_path=big.js)", evidence: { start: 1, end: 2 } } } };
  const derived = deriveValueFacts(graph, events, { rangeStart: 1, rangeEnd: 1_000_000 });
  const facts = edgeOf(derived.graph, "e1").valueFacts;
  t.eq(facts.length, 8, "每边由 maxFacts 封顶（1 条路径 + 7 条行值）");
  t.ok(derived.facts <= 8, `总事实数也必须封顶，实际 ${derived.facts}`);

  // ② 幂等 / 去重：GitHub 对象结果（旧形状）走两趟，事实集必须与只跑第一趟逐字段相同。
  const base = deriveValueFacts(
    { rootUserNodeIds: [], nodes: {}, edges: { e4: { id: "e4", action: "github(path=repos/o/r)", evidence: { start: 34, end: 35 } } } },
    K2_N4_EVENTS,
    { rangeStart: 1, rangeEnd: 1_000_000 },
  );
  const pairs = edgeOf(base.graph, "e4").valueFacts.map((fact) => [fact.kind, fact.value, fact.quote]);
  t.eq(pairs, [
    ["id", 1436032364, '"id": 1436032364'],
    ["id", "R_kgDOVZgdbA", '"node_id": "R_kgDOVZgdbA"'],
    ["boolean", false, '"private": false'],
  ], "旧形状逐字不变（两趟合并去重后不许翻倍，也不许新增 value 事实）");
};
