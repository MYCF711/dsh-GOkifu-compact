/**
 * axiom-shadow.test.mjs —— AX-10 shadow 生成器的纯判据
 *
 * 纪律（与 AX-05 的测试同一条）：**只用合成夹具**，不读 live 会话、不读私有语料、**不调用模型**。
 * 真跑只在人工执行 `node scripts/axiom-shadow.mjs --live` 时发生（真实调用次数与用量记在
 * `tmp/axiom-2026-11-07/ax10/run.json`）。
 *
 * 这里钉住的都是「会让候选变成假绿」的机械判据：
 *   · 模型只能来自 `default-model.json`（拒绝 --model/--provider，源码里不许有模型名字面量）；
 *   · 两臂必须同源同题（配对断言四种红）；
 *   · 冻结 compact 不能当候选（逐字相同即红）；
 *   · 产物里不许出现私有正文（隐私自检 + 公开投影白名单）；
 *   · 缺样本不补合成（计划函数给 missing，不造条目）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ARMS,
  LIMITS,
  SCHEMA,
  assertArmParity,
  assertIsolated,
  auditSource,
  deriveValueFacts,
  fixtureLinesToEvents,
  frozenVerdict,
  guardSummary,
  k26Plan,
  k2Plan,
  k27Plan,
  loadDefaultModel,
  main,
  makeCallModel,
  parseArgs,
  parseDefaultModel,
  privacyCheck,
  privacyNeedles,
  publicItemView,
  renderReport,
  routeSummary,
  summarizeRun,
} from "../scripts/axiom-shadow.mjs";

export const tests = {};

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ax10-${tag}-`));
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了：测试不靠残留状态 */
  }
}

/** 一条合法的最小条目（K-26 形状），供配对断言用。 */
function fixtureItem(overrides = {}) {
  const arm = (id, factGuard, extra = {}) => ({
    arm: id,
    factGuard,
    status: "SCORED",
    source: { hash: "a".repeat(64) },
    question: null,
    model: "svc/model-a",
    inputChars: 1000,
    messages: 10,
    text: `# 摘要（${id}）\n- 目标：合成夹具`,
    ...extra,
  });
  return {
    schema: "axiom-ax10-shadow-item-v1",
    corpus: "k26",
    itemId: "synthetic-sample",
    index: 0,
    status: "SCORED",
    source: { kind: "session", sessionId: "session-secret-0001", graphPath: "x/graph.json", hash: "a".repeat(64), range: { start: 1, end: 9 } },
    arms: { "guard=false": arm("guard=false", false), "guard=true": arm("guard=true", true) },
    ...overrides,
  };
}

/* ───────────────────────── 1 · 两臂与上限 ───────────────────────── */

tests["两臂是闭集且只差开关"] = (t) => {
  t.eq(ARMS.length, 2, "必须恰好两臂");
  t.eq(
    ARMS.map((arm) => arm.id),
    ["guard=false", "guard=true"],
    "臂 id 顺序固定",
  );
  t.eq(
    ARMS.map((arm) => arm.factGuard),
    [false, true],
    "两臂只差 factGuard",
  );
  t.eq(LIMITS.maxCalls, 8, "默认调用上限");
  t.eq(SCHEMA, "axiom-ax10-shadow-run-v1", "schema");
};

/* ───────────────────────── 2 · 默认模型只读 ───────────────────────── */

tests["parseDefaultModel 只认冻结形状"] = (t) => {
  const good = parseDefaultModel('{"provider":"svc","model":"vendor/model-x","source":"profiles/desktop/cordis.patch.yml"}');
  t.ok(good.ok, "合法输入必须 ok");
  t.eq(good.provider, "svc", "provider");
  t.eq(good.model, "vendor/model-x", "model");

  const noModel = parseDefaultModel('{"provider":"svc"}');
  t.ok(!noModel.ok, "缺 model 必须不 ok");
  t.includes(noModel.errors.join("；"), "model", "错误里要点名 model");

  const blank = parseDefaultModel('{"provider":"  ","model":""}');
  t.ok(!blank.ok, "空串必须不 ok");

  const bad = parseDefaultModel("{not json");
  t.ok(!bad.ok, "坏 JSON 必须不 ok");
  t.eq(bad.model, null, "坏 JSON 不产出模型");
};

tests["loadDefaultModel 读不到就是 ok:false（不抛、不兜底）"] = (t) => {
  const missing = loadDefaultModel(path.join(os.tmpdir(), "ax10-does-not-exist", "default-model.json"));
  t.ok(!missing.ok, "读不到必须 not ok");
  t.eq(missing.model, null, "**不**回退到任何内置模型");
  t.eq(missing.provider, null, "provider 也不许猜");
  t.ok(missing.errors.length > 0, "必须给错误原因");

  const dir = tmpDir("model");
  try {
    const file = path.join(dir, "default-model.json");
    fs.writeFileSync(file, '{"provider":"svc","model":"vendor/model-x","source":"s"}', "utf8");
    const loaded = loadDefaultModel(file);
    t.ok(loaded.ok, "合法文件必须 ok");
    t.eq(loaded.model, "vendor/model-x", "model 原样读出");
    t.eq(String(loaded.sha256).length, 64, "要记文件 sha256（可复核）");
  } finally {
    cleanup(dir);
  }
};

/* ───────────────────────── 3 · 参数：不许自选模型 ───────────────────────── */

tests["parseArgs 拒绝 --model / --provider"] = (t) => {
  for (const flag of ["--model", "--provider"]) {
    const parsed = parseArgs([flag, "vendor/model-x"]);
    t.ok(!parsed.ok, `${flag} 必须被拒绝`);
    t.includes(parsed.errors.join("；"), "禁止", `${flag} 的错误要说「禁止」`);
  }
};

tests["parseArgs --live 必须给 home 与 default-model"] = (t) => {
  const parsed = parseArgs(["--live"]);
  t.ok(!parsed.ok, "缺参必须不 ok");
  t.includes(parsed.errors.join("；"), "--home", "点名 --home");
  t.includes(parsed.errors.join("；"), "--default-model", "点名 --default-model");
};

tests["parseArgs 数值夹取与 --only 校验"] = (t) => {
  const ok = parseArgs(["--k26-samples", "1", "--k2-sessions", "1", "--k27-questions", "1", "--max-calls", "4", "--only", "k26"]);
  t.ok(ok.ok, "合法参数");
  t.eq(ok.options.k26Samples, 1, "k26 样本数");
  t.eq(ok.options.maxCalls, 4, "调用上限");
  t.eq(ok.options.only, "k26", "only");

  const tooMany = parseArgs(["--k27-questions", "50"]);
  t.ok(!tooMany.ok, "超过 pilot 上限必须红");

  const badOnly = parseArgs(["--only", "k28"]);
  t.ok(!badOnly.ok, "未知语料必须红");
};

tests["assertIsolated 拒绝把产物写进 home"] = (t) => {
  let threw = false;
  try {
    assertIsolated({ home: path.join(os.tmpdir(), "ax10-home"), out: path.join(os.tmpdir(), "ax10-home", "tmp", "ax10") });
  } catch {
    threw = true;
  }
  t.ok(threw, "产物落在 home 内必须抛");

  const outside = assertIsolated({ home: path.join(os.tmpdir(), "ax10-home"), out: path.join(os.tmpdir(), "ax10-out") });
  t.eq(outside.home, path.resolve(path.join(os.tmpdir(), "ax10-home")), "home 被规范化返回");
};

/* ───────────────────────── 4 · 静态自检（反例必须红） ───────────────────────── */

tests["auditSource 本文件绿，反例红"] = (t) => {
  t.eq(auditSource(), [], "本文件必须过自己的静态自检");

  const withModel = 'const m = "gro" + "up/vendor-x";\nconst q = "vendor/model-y";';
  t.ok(auditSource(withModel).length >= 0, "合成源码不崩");

  const literalModel = 'const cfg = { model: "deep' + 'seek-chat" };';
  t.ok(auditSource(literalModel).length > 0, "出现模型名字面量必须红");

  const prefixed = 'const cfg = { model: "gro' + 'up/vendor-x" };';
  t.ok(auditSource(prefixed).length > 0, "出现 group/ 前缀模型名必须红");

  const globalKey = 'const k = "allowed' + 'Models";';
  t.ok(auditSource(globalKey).length > 0, "出现宿主全局模型白名单键必须红");

  const appender = 'fs.app' + 'endFileSync(file, "x");';
  t.ok(auditSource(appender).length > 0, "出现 append 写入必须红");

  const twoFetches = 'await fetch(a); await fet' + 'ch(b);';
  t.ok(auditSource(twoFetches).length > 0, "出现两个网络出口必须红");
};

/* ───────────────────────── 5 · K-27 适配器 ───────────────────────── */

tests["routeSummary：请求 id 相同即配对绿，上游回显不同只留痕"] = (t) => {
  const item = fixtureItem();
  item.arms["guard=false"].servedModels = ["upstream-a/model-x"];
  item.arms["guard=true"].servedModels = ["upstream-b/model-x"];
  const route = routeSummary(item, "vendor/model-x");
  t.eq(route.requested, "vendor/model-x", "请求 id 来自 AX-00 冻结值");
  t.eq(route.sameServed, false, "上游回显不同必须被识别（混淆项，留痕）");
  t.eq(route.arms["guard=false"], ["upstream-a/model-x"], "逐臂记下来源上游");
  t.ok(assertArmParity(item).ok, "上游回显不同**不算**配对违规（比的是请求模型 id）");

  item.route = route; // run*Item 会把 routeSummary 挂到条目上；这里手动对齐
  const run = summarizeRun({ plans: {}, items: [item], calls: [] });
  t.eq(run.totals.servedModelMixed, 1, "run.json 要数出这类条目");
};

tests["fixtureLinesToEvents 只认 seq 行，不猜角色"] = (t) => {
  const adapted = fixtureLinesToEvents("seq=101 root=n-ie01-root goal=repair\nseq=103 verified\nnot-a-seq-line");
  t.eq(adapted.events.length, 2, "两行可解析");
  t.eq(adapted.seqs, [101, 103], "seq 原样");
  t.eq(adapted.unparsed, ["not-a-seq-line"], "解析不了的行要单列（不静默丢）");
  t.eq(adapted.events[0].type, "user/message", "不猜角色：一律 user/message");
  t.eq(adapted.events[0].seq, 101, "事件 seq");

  const empty = fixtureLinesToEvents("");
  t.eq(empty.events.length, 0, "空输入不产出事件");
};

/* ───────────────────────── 6 · 两臂配对 ───────────────────────── */

tests["assertArmParity 同源同题绿，四种红"] = (t) => {
  const green = assertArmParity(fixtureItem());
  t.ok(green.ok, `合法条目必须绿：${green.violations.join("；")}`);

  const missingArm = fixtureItem();
  delete missingArm.arms["guard=true"];
  t.ok(!assertArmParity(missingArm).ok, "缺臂必须红");

  const sourceDifferent = fixtureItem();
  sourceDifferent.arms["guard=true"].source = { hash: "b".repeat(64) };
  t.includes(assertArmParity(sourceDifferent).violations.join("；"), "source.hash", "源不同必须红");

  const questionDifferent = fixtureItem();
  questionDifferent.arms["guard=true"].question = "另一题";
  t.includes(assertArmParity(questionDifferent).violations.join("；"), "question", "题不同必须红");

  const modelDifferent = fixtureItem();
  modelDifferent.arms["guard=true"].model = "svc/model-b";
  t.includes(assertArmParity(modelDifferent).violations.join("；"), "model", "模型不同必须红");

  const halfFailed = fixtureItem();
  halfFailed.arms["guard=true"].text = "";
  t.ok(!assertArmParity(halfFailed).ok, "标了 SCORED 却没有正文必须红");

  // ★ 一臂被守卫整份拒掉是**合法结局**（不是配对违规）：输入仍然同源，失败带原因就算绿。
  const guardRejected = fixtureItem();
  guardRejected.arms["guard=true"] = {
    arm: "guard=true",
    factGuard: true,
    status: "NOT_RUN",
    source: { hash: "a".repeat(64) },
    question: null,
    failed: "empty-response",
    error: "折叠没有产出（failed=empty-response）",
  };
  const rejected = assertArmParity(guardRejected);
  t.ok(rejected.ok, `一臂被拒 + 有原因 ⇒ 配对仍绿：${rejected.violations.join("；")}`);

  const noReason = fixtureItem();
  noReason.arms["guard=true"] = { arm: "guard=true", factGuard: true, status: "NOT_RUN", source: { hash: "a".repeat(64) }, question: null };
  t.ok(!assertArmParity(noReason).ok, "失败却没有原因必须红");
};

tests["frozenVerdict：逐字照抄冻结 compact 必须判 usedFrozen"] = (t) => {
  const frozen = "checkpoint fold-1: root=n-ie01-root\nhot: seq=103 verified root=n-ie01-root";
  const copy = frozenVerdict(frozen, frozen);
  t.ok(copy.usedFrozen, "逐字相同必须判为用了冻结文本");
  t.eq(copy.candidateChars, frozen.length, "长度记下来");
  t.eq(String(copy.frozenSha256).length, 64, "冻结文本哈希");

  const fresh = frozenVerdict("# 新生成的摘要\n- 目标：合成", frozen);
  t.ok(!fresh.usedFrozen, "不同文本不算照抄");
  t.ne(fresh.candidateSha256, fresh.frozenSha256, "两个哈希必须不同");
};

/* ───────────────────────── 7 · 守卫聚合只出计数 ───────────────────────── */

tests["guardSummary 只聚合，不带正文"] = (t) => {
  const record = {
    verdict: "UNVERIFIED",
    applied: true,
    degraded: false,
    facts: [
      { id: "f1", verdict: "SUPPORTED", claim: "私密句子一", quote: "私密引文一" },
      { id: "f2", verdict: "REJECTED", claim: "私密句子二", quote: "私密引文二" },
      { id: "f3", verdict: "PENDING", claim: "私密句子三", quote: "私密引文三" },
    ],
    narratives: [
      { id: "x1", verdict: "SUPPORTED" },
      { id: "x2", verdict: "REJECTED" },
    ],
    rejectedNarratives: 1,
    reasons: ["QUOTE_NOT_VERBATIM", "SUBJECT_MISMATCH", "QUOTE_NOT_VERBATIM"],
    valueFacts: 4,
  };
  const summary = guardSummary(record);
  t.eq(summary.verdict, "UNVERIFIED", "整份裁决词原样");
  t.eq(summary.facts.total, 3, "事实总数");
  t.eq(summary.facts.SUPPORTED, 1, "SUPPORTED 计数");
  t.eq(summary.facts.REJECTED, 1, "REJECTED 计数");
  t.eq(summary.facts.PENDING, 1, "PENDING 计数");
  t.eq(summary.narratives.REJECTED, 1, "叙事被拒计数");
  t.eq(summary.reasons, ["QUOTE_NOT_VERBATIM", "SUBJECT_MISMATCH"], "原因码去重排序");
  t.eq(summary.semanticEntailment, "NOT_PROVEN", "语义蕴含恒 NOT_PROVEN");
  const json = JSON.stringify(summary);
  t.notIncludes(json, "私密引文", "聚合里不许出现 quote");
  t.notIncludes(json, "私密句子", "聚合里不许出现 claim");

  t.eq(guardSummary(null), null, "没有守卫记录时返回 null");
};

/* ───────────────────────── 8 · 值事实派生 ───────────────────────── */

tests["deriveValueFacts 只挂唯一命中，且不改输入图"] = (t) => {
  const graph = {
    nodes: {},
    edges: {
      e1: { id: "e1", evidence: { start: 1, end: 44 } },
      e2: { id: "e2", evidence: { start: 1, end: 46 } },
      e3: { id: "e3", evidence: { start: 1, end: 44 } },
      e4: { id: "e4", evidence: { start: 1, end: 99 } },
    },
    rootUserNodeIds: [],
  };
  const writeResult = (seq) => ({
    seq,
    type: "tool/result",
    data: { message: { content: [{ type: "text", text: `<path>/w/demo/f${seq}.md</path>` }], isError: false, source: { callId: `c${seq}` } } },
  });
  const events = [
    { seq: 43, type: "tool/call", data: { callId: "c44", name: "write", arguments: { file_path: "/w/demo/f44.md" } } },
    writeResult(44),
    { seq: 45, type: "tool/call", data: { callId: "c46", name: "write", arguments: { file_path: "/w/demo/f46.md" } } },
    writeResult(46),
    { seq: 50, type: "tool/call", data: { callId: "c55", name: "write", arguments: { file_path: "/w/demo/f55.md" } } },
    writeResult(55),
  ];
  const before = JSON.stringify(graph);
  const derived = deriveValueFacts(graph, events, { rangeStart: 1, rangeEnd: 1_000_000 });

  t.eq(JSON.stringify(graph), before, "输入图必须一个字节都没变（不写 live 图）");
  t.eq(derived.facts, 3, "抽到 3 条值事实");
  t.eq(derived.attached.length, 1, "只有 seq 44 那条边唯一命中");
  t.eq(derived.attached[0].edge, "e2", "挂到 evidence.end === evidenceSeq 的边");
  t.eq(derived.attached[0].kind, "file_path", "种类来自 AX-02 抽取器");
  t.eq(derived.multi, 1, "多义（e1/e3 同时命中 seq 44）只计数，不猜挂哪条");
  t.ok(derived.graph.edges.e2.valueFacts.length > 0, "副本上确实挂了值事实");
  t.eq(derived.graph.edges.e1.valueFacts, undefined, "多义时不挂（不猜）");
  t.eq(derived.unmapped, 1, "没有对应边的值事实计入 unmapped");

  const off = deriveValueFacts(graph, events, { derive: false });
  t.eq(off.facts, 0, "derive=false 不抽");
  t.eq(off.attached.length, 0, "derive=false 不挂");
  t.eq(countOf(off.graph), countOf(graph), "derive=false 时图内容不变");
};

function countOf(graph) {
  let n = 0;
  for (const edge of Object.values(graph?.edges ?? {})) n += Array.isArray(edge?.valueFacts) ? edge.valueFacts.length : 0;
  return n;
}

/* ───────────────────────── 9 · 计划：顺序 / 上限 / 缺样本 ───────────────────────── */

tests["k26Plan 按冻结顺序取前 N，缺样本不补合成"] = (t) => {
  const samples = [{ sampleId: "s0", graphPath: "g0", summaryChars: 100 }, { sampleId: "s1", graphPath: "g1", summaryChars: 200 }];
  const plan = k26Plan(samples, 1);
  t.eq(plan.selected.length, 1, "取 1 个");
  t.eq(plan.selected[0].sampleId, "s0", "顺序即冻结顺序（不挑）");
  t.eq(plan.available, 2, "可用数");
  t.eq(plan.missing, 0, "够用时不报缺");

  const short = k26Plan(samples, 5);
  t.eq(short.selected.length, 2, "不足时给到可用为止");
  t.eq(short.missing, 3, "缺 3 个要报出来（不造样本）");

  const clamped = k26Plan(samples, 99);
  t.ok(clamped.requested <= LIMITS.k26Samples, "不得超过冻结上限");
};

tests["k2Plan 按会话去重且带上该会话的题"] = (t) => {
  const questions = [
    { id: "Q1", sessionHash: "aaaa" },
    { id: "Q2", sessionHash: "bbbb" },
    { id: "Q3", sessionHash: "aaaa" },
  ];
  const plan = k2Plan(questions, 1);
  t.eq(plan.selected.length, 1, "只取 1 个会话");
  t.eq(plan.selected[0].sessionHash, "aaaa", "首个出现的会话");
  t.eq(plan.selected[0].questions, ["Q1", "Q3"], "该会话的题一起带上");
  t.eq(plan.available, 2, "可用会话数");
};

tests["k27Plan 取前 N 题且受 pilot 上限约束"] = (t) => {
  const fixtures = [{ id: "IE-01", type: "IE" }, { id: "IE-02", type: "IE" }, { id: "MR-01", type: "MR" }];
  const plan = k27Plan(fixtures, 2);
  t.eq(plan.selected.map((entry) => entry.questionId), ["IE-01", "IE-02"], "顺序即夹具顺序");
  t.eq(plan.available, 3, "可用题数");
  const capped = k27Plan(fixtures, 99);
  t.ok(capped.requested <= LIMITS.k27PilotQuestions, "不得超过 pilot 上限");
};

/* ───────────────────────── 10 · 隐私 ───────────────────────── */

tests["privacyCheck 命中私有串就红"] = (t) => {
  const needle = "这是一段来自真实会话的私密正文，长度足够被当成探针";
  const clean = JSON.stringify({ a: 1, b: "聚合计数" });
  t.ok(privacyCheck(clean, [needle]).ok, "没有私有串时绿");
  const dirty = JSON.stringify({ leaked: needle.slice(0, 30) });
  t.ok(!privacyCheck(dirty, [needle]).ok, "含私有前缀必须红");

  const needles = privacyNeedles([
    {
      source: { sessionId: "session-とても-secret-0001" },
      arms: {
        "guard=false": { text: needle + needle },
        "guard=true": { text: needle, guard: { facts: [{ quote: "另一段来自真实会话的私密引文", value: "私密值足够长足够长" }] } },
      },
    },
  ]);
  t.ok(needles.some((item) => item.includes("session-")), "会话 id 进探针");
  t.ok(needles.some((item) => item === "另一段来自真实会话的私密引文"), "quote 进探针");
  t.ok(needles.every((item) => item.length >= 12), "太短的串不当探针");
};

tests["publicItemView 不带会话坐标"] = (t) => {
  const view = publicItemView(fixtureItem());
  const json = JSON.stringify(view);
  t.notIncludes(json, "session-secret-0001", "不许带 sessionId");
  t.notIncludes(json, "x/graph.json", "不许带 graphPath");
  t.eq(view.itemId, "synthetic-sample", "条目 id 保留（对应私有文件）");
  t.eq(view.arms["guard=true"].status, "SCORED", "两臂都在");
  t.notIncludes(JSON.stringify(view.arms), "# 摘要", "公开视图不带正文");
};

/* ───────────────────────── 11 · 汇总与报告 ───────────────────────── */

tests["summarizeRun 状态与用量"] = (t) => {
  const none = summarizeRun({ plans: {}, items: [], calls: [] });
  t.eq(none.status, "NOT_RUN", "没有条目 = NOT_RUN");

  const partial = summarizeRun({
    plans: { k26: { requested: 2, available: 2, missing: 0 } },
    items: [fixtureItem(), { ...fixtureItem({ itemId: "s2" }), status: "NOT_RUN" }],
    calls: [{ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
    maxCalls: 8,
  });
  t.eq(partial.status, "PARTIAL", "一成一败 = PARTIAL");
  t.eq(partial.totals.items, 2, "条目数");
  t.eq(partial.totals.scored, 1, "成功数");
  t.eq(partial.totals.notRun, 1, "失败数");
  t.eq(partial.totals.usage.promptTokens, 10, "prompt token 累加");
  t.eq(partial.totals.usage.completionTokens, 5, "completion token 累加");
  t.eq(partial.budget.callsUsed, 1, "调用数");
};

tests["renderReport 只出聚合且含必要小节"] = (t) => {
  const run = summarizeRun({
    plans: { k26: { requested: 1, available: 12, missing: 0 } },
    items: [fixtureItem()],
    calls: [{ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 7 } } }],
    rev: "deadbeef",
    defaultModel: { provider: "svc", model: "vendor/model-x", source: "profiles/desktop/cordis.patch.yml", sha256: "c".repeat(64) },
    limitations: ["合成限制一条"],
    generatedAt: "2026-11-07T00:00:00.000Z",
  });
  run.privacy = { checked: true, needles: 3, violations: 0 };
  const md = renderReport(run);
  t.includes(md, "# AX-10 · shadow 候选上下文（两臂）", "标题");
  t.includes(md, "deadbeef", "写 rev");
  t.includes(md, "vendor/model-x", "写模型（模型名不是隐私）");
  t.includes(md, "合成限制一条", "限制要写进报告");
  t.includes(md, "隐私自检", "隐私行");
  t.notIncludes(md, "# 摘要", "报告不许出现正文");
  t.notIncludes(md, "session-secret-0001", "报告不许出现会话 id");
};

/* ───────────────────────── 12 · 调用预算（不打网关） ───────────────────────── */

tests["makeCallModel 预算用尽先抛，不发请求"] = async (t) => {
  const calls = [];
  const callModel = makeCallModel({ endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "vendor/model-x", maxCalls: 0, calls });
  let error = null;
  try {
    await callModel("hello", { maxTokens: 8 });
  } catch (caught) {
    error = caught;
  }
  t.ok(error !== null, "超预算必须抛");
  t.includes(String(error.message), "上限", "错误要说清是上限");
  t.eq(calls.length, 0, "一次调用都没记（没有发出去）");
};

/* ───────────────────────── 13 · CLI：计划模式与 NOT_RUN ───────────────────────── */

tests["main 计划模式：零模型、写 plan.json"] = async (t) => {
  const dir = tmpDir("plan");
  try {
    const out = path.join(dir, "out");
    const modelFile = path.join(dir, "default-model.json");
    fs.writeFileSync(modelFile, '{"provider":"svc","model":"vendor/model-x","source":"s"}', "utf8");
    const code = await main(["--default-model", modelFile, "--out", out, "--k26-samples", "0"]);
    t.eq(code, 0, "计划模式退出码 0");
    const plan = JSON.parse(fs.readFileSync(path.join(out, "plan.json"), "utf8"));
    t.eq(plan.mode, "plan", "mode=plan");
    t.ok(plan.defaultModel.ok, "默认模型读到了");
    t.eq(plan.plans.k27.requested, 0, "没有请求 K-27");
    t.ok(!fs.existsSync(path.join(out, "run.json")), "计划模式不写 run.json（没跑就没有结果）");
  } finally {
    cleanup(dir);
  }
};

tests["main 模型不可用 ⇒ NOT_RUN 退出码 3，且不产物假结果"] = async (t) => {
  const dir = tmpDir("notrun");
  try {
    const home = path.join(dir, "home");
    const out = path.join(dir, "out");
    fs.mkdirSync(home, { recursive: true });
    const code = await main([
      "--live",
      "--home",
      home,
      "--default-model",
      path.join(dir, "missing-default-model.json"),
      "--out",
      out,
      "--k26-samples",
      "0",
    ]);
    t.eq(code, 3, "模型不可用必须 NOT_RUN");
    const run = JSON.parse(fs.readFileSync(path.join(out, "run.json"), "utf8"));
    t.eq(run.status, "NOT_RUN", "状态 NOT_RUN");
    t.eq(run.defaultModel.model, null, "不许补一个模型名");
    t.eq(run.corpora.k26.items.length, 0, "没有条目（不伪造）");
    t.ok(fs.existsSync(path.join(out, "report.md")), "报告仍要写（说明为什么 NOT_RUN）");
  } finally {
    cleanup(dir);
  }
};
