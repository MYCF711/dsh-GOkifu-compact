/**
 * k26-fact-guard-eval.test.mjs —— AX-05 复判脚本的纯判据
 *
 * 只用**合成夹具**：不读 live 会话、不读私有 labels、不调用模型。
 * 私有语料只在人工跑脚本时经 CLI 传入（见 scripts/k26-fact-guard-eval.mjs 的用法）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TIERS,
  HARD_FAILURE_CLASSES,
  SCHEMA,
  aggregate,
  auditSource,
  buildCorpus,
  buildEvents,
  buildReport,
  checkFrozenAlignment,
  classifyQuote,
  extractEvidenceSeq,
  extractQuote,
  extractTier,
  extractTierTable,
  inferKind,
  inferSubject,
  parseDossier,
  parseLabels,
  privacyCheck,
  readGitRev,
  renderMarkdown,
  replayFact,
  roleOfEventType,
  runProbes,
  statusToTier,
  stripWrappingMarks,
  tierCensus,
} from "../scripts/k26-fact-guard-eval.mjs";
import { REASONS, VERDICT, DEFAULT_ENABLED } from "../src/rooms/fact-guard.mjs";

export const tests = {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "k26-fact-guard-eval.mjs");

/* ── 合成档案（形状抄自真实审稿档案，内容全是假数据）────────────────────── */

const DOSSIER = [
  "# 合成样本",
  "| `sampleId` | `aaaaaaaaaaaa` |",
  "## 1. Facts 总表",
  "| # | 原子事实 | evidenceSeq | proposed |",
  "|---|---|---|---|",
  "| F1 | 用户要求转成 md | 9 | **GOLD** |",
  "| F2 | 日志里没有任何命中 | 5 | **REJECTED** |",
  "",
  "## 2. 三审",
  "### F1 · 第一件事 — seq 9",
  "- **fact**：用户要求把上一条回答转成 md 文件。",
  "- **quote（逐字）**：",
  "  > 转成md文件给我",
  "- **proposed：GOLD**",
  "",
  "### F2 · 第二件事",
  "- **fact（摘要原句）**：日志里没有任何命中。",
  "- **evidenceSeq**：`5`",
  "- **quote**（逐字）：",
  "```text",
  "grep 命中 3 处：a.js:1",
  "```",
  "- **proposed**：**REJECTED**",
  "",
  "### F1 · 三审里第二次出现的标题",
  "- **fact**：这条不该被收第二次。",
  "",
].join("\n");

const LABELS = [
  JSON.stringify({
    sampleId: "aaaaaaaaaaaa",
    atomicFacts: [
      { text: "用户要求转成 md 文件", status: "supported", evidenceSeq: 9, quote: "转成md文件给我" },
      { text: "日志里没有任何命中", status: "not-supported", evidenceSeq: 5, quote: "grep 命中 3 处：a.js:1" },
      { text: "待补证的一条", status: "pending", evidenceSeq: 7, quote: "" },
      { text: "不认识的档位", status: "weird", evidenceSeq: 8, quote: "" },
    ],
  }),
].join("\n");

const MANIFEST = {
  samples: [
    { sampleId: "aaaaaaaaaaaa", graphPath: "fixture-sample/graph.json" },
    { sampleId: "bbbbbbbbbbbb", graphPath: "fixture-sample/graph.json" },
  ],
};

/** 一段最小的会话日志（jsonl 文本，行内形状抄自真实事件）。 */
const LOG = [
  JSON.stringify({ type: "user/message", seq: 9, data: { content: [{ type: "text", text: "把上一条回答转成md文件给我" }], role: "user" } }),
  JSON.stringify({ type: "tool/result", seq: 5, data: { message: { role: "tool", content: [{ type: "text", text: "grep 命中 3 处：a.js:1 b.js:2" }] } } }),
  JSON.stringify({ type: "tool/call", seq: 6, data: { name: "bash", arguments: '{"command":"ls -la"}' } }),
  JSON.stringify({ type: "assistant/message", seq: 8, data: { content: [{ type: "text", text: "已完成" }], role: "assistant" } }),
  JSON.stringify({ type: "agent/inbox/spliced", seq: 4, data: { content: [{ type: "text", text: "<workspace>文件策略</workspace>" }] } }),
  JSON.stringify({ type: "system/message", seq: 3, data: { content: [{ type: "text", text: "系统级提示" }] } }),
  "{ 坏行，应当跳过",
].join("\n");

/* ── 抽取层 ─────────────────────────────────────────────────────────── */

tests["AX05-1 quote 抽取：块引用 / 围栏 / 内联 code span"] = (t) => {
  const blockquote = "### F1 x\n- **quote（逐字）**：\n  > 第一行\n  > 第二行\n- 别的\n";
  t.eq(extractQuote(blockquote), "第一行\n第二行", "块引用多行合并");

  const fenced = "### F2 x\n- **quote**：\n\n```text\n原文一行\n```\n";
  t.eq(extractQuote(fenced), "原文一行", "代码围栏取内容");

  const inline = "### F3 x\n- **quote**（逐字）：`内联引用`\n";
  t.eq(extractQuote(inline), "内联引用", "围栏前的行内引用不被当成空");

  t.eq(extractQuote("### F4 x\n- **fact**：没有引文\n"), "", "没有 quote 块就是空串");
};

tests["AX05-2 包裹标记：长围栏优先 + 字面 \\n 归一"] = (t) => {
  t.eq(stripWrappingMarks("``带单反引号 `x` 的双反引号包裹``"), "带单反引号 `x` 的双反引号包裹", "双反引号不能被单反引号剥掉");
  t.eq(stripWrappingMarks("`https://a.example/x\\n第二行`"), "https://a.example/x\n第二行", "内联 code span 里的字面 \\n 是原文换行");
  t.eq(stripWrappingMarks("**加粗的一整段**"), "加粗的一整段", "成对强调");
  t.eq(stripWrappingMarks("原文含 **内部** 强调"), "原文含 **内部** 强调", "内部强调不许被剥");
};

tests["AX05-3 档位抽取：两种 proposed 写法 + 表格回落"] = (t) => {
  t.eq(extractTier("- **proposed：GOLD**"), "GOLD", "**proposed：X**");
  t.eq(extractTier("- **proposed**：**REJECTED**（理由）"), "REJECTED", "**proposed**：**X**");
  t.eq(extractTier("proposed = pending"), "PENDING", "小写 + 等号");
  t.eq(extractTier("- 没有任何结论"), null, "没有就是 null，不猜");

  const table = extractTierTable("| # | 事实 | seq | proposed |\n|---|---|---|---|\n| F1 | 甲 | 74 | **GOLD** |\n| F2 | 乙 | 73 / 92 | PENDING |\n");
  t.eq(table.get("F1").tier, "GOLD", "表格档位");
  t.eq(table.get("F1").evidenceSeq, 74, "表格 seq");
  t.eq(table.get("F2").tier, "PENDING", "表格里写着 PENDING 就是 PENDING");
};

tests["AX05-4 seq / claim 抽取"] = (t) => {
  t.eq(extractEvidenceSeq("- **evidenceSeq**：`117`（tool/result）", "### F1 x"), 117, "显式 evidenceSeq 优先");
  t.eq(extractEvidenceSeq("没有显式字段", "### F1 · x — seq 42"), 42, "标题里的 seq");
  t.eq(extractEvidenceSeq("见 seq=88 的事件", "### F1 x"), 88, "正文首个 seq 提及");
  t.eq(extractEvidenceSeq("什么也没有", "### F1 x"), null, "抽不到就是 null");
};

tests["AX05-5 parseDossier：8 条真事 + 重复标题只收第一次"] = (t) => {
  const parsed = parseDossier(DOSSIER);
  t.eq(parsed.sampleId, "aaaaaaaaaaaa", "样本 id");
  t.eq(parsed.facts.length, 2, "重复标题不重复收");
  t.eq(parsed.facts[0].factId, "F1", "第一条编号");
  t.eq(parsed.facts[0].tier, "GOLD", "第一条档位");
  t.eq(parsed.facts[0].evidenceSeq, 9, "第一条 seq");
  t.eq(parsed.facts[0].quote, "转成md文件给我", "第一条 quote");
  t.ok(parsed.facts[0].claim.includes("转成 md"), "第一条 claim 用 fact 行");
  t.eq(parsed.facts[1].tier, "REJECTED", "第二条档位");
  t.eq(parsed.facts[1].evidenceSeq, 5, "第二条 seq 来自显式字段");
  t.eq(parsed.facts[1].claim, "日志里没有任何命中。", "摘要原句形式的 claim 也要抽到");
};

tests["AX05-6 parseLabels：status → 档位，未知不收"] = (t) => {
  t.eq(statusToTier("supported"), "GOLD", "supported");
  t.eq(statusToTier("not-supported"), "REJECTED", "not-supported");
  t.eq(statusToTier("pending"), "PENDING", "pending");
  t.eq(statusToTier("weird"), null, "未知档位");
  const facts = parseLabels(LABELS);
  t.eq(facts.length, 4, "四个都读进来（档位未知留 null）");
  t.eq(facts.map((f) => f.tier), ["GOLD", "REJECTED", "PENDING", null], "档位映射");
  t.eq(facts[0].factId, "L1", "编号带前缀，避免和档案的 F1 撞");
  t.eq(parseLabels("坏行\n").length, 0, "坏 JSON 跳过不抛");
};

tests["AX05-7 buildCorpus：样本序号 + 来源计数"] = (t) => {
  const corpus = buildCorpus({
    manifest: MANIFEST,
    labelsText: LABELS,
    dossiers: [{ name: "d1.md", text: DOSSIER }],
  });
  t.eq(corpus.facts.length, 6, "labels 4 + 档案 2");
  t.eq(corpus.provenance.fromLabels, 4, "labels 条数");
  t.eq(corpus.provenance.fromDossiers, 2, "档案条数");
  t.eq(corpus.provenance.withClaim, 6, "都有 claim");
  t.eq(corpus.provenance.withoutTier, 1, "有一条档位未知");
  t.ok(corpus.facts.every((f) => f.sampleIndex === 0), "都落在样本 0");
  const census = tierCensus(corpus.facts);
  t.eq(census.totals.facts, 6, "census 总数");
  t.eq(census.totals.GOLD, 2, "census GOLD（labels 1 + 档案 1）");
  t.eq(census.totals.unresolved, 1, "census 未定档");
};

tests["AX05-8 冻结分母对账：一致 / 不一致都要说"] = (t) => {
  const audit = { totals: { facts: 6, gold: 2, rejected: 2, pending: 1 } };
  const ok = checkFrozenAlignment({ facts: 6, GOLD: 2, REJECTED: 2, PENDING: 1 }, audit);
  t.eq(ok.ok, true, "逐项一致");
  t.eq(ok.mismatches.length, 0, "无差异项");

  const bad = checkFrozenAlignment({ facts: 6, GOLD: 3, REJECTED: 2, PENDING: 1 }, audit);
  t.eq(bad.ok, false, "GOLD 多一条必须红");
  t.eq(bad.mismatches[0].key, "GOLD", "差异项定位到 GOLD");
  t.eq(bad.mismatches[0].expect, 2, "报出冻结值");

  // 逐样本：总数对得上但样本之间错位，也必须红
  const perAudit = {
    totals: { facts: 2, gold: 1, rejected: 1, pending: 0 },
    samples: [
      { index: 0, sampleId: "aaaaaaaaaaaa", facts: 2, gold: 1, rejected: 1, pending: 0 },
      { index: 1, sampleId: "bbbbbbbbbbbb", facts: 2, gold: 1, rejected: 1, pending: 0 },
    ],
  };
  const swapped = checkFrozenAlignment(
    { facts: 4, GOLD: 2, REJECTED: 2, PENDING: 0 },
    { ...perAudit, totals: { facts: 4, gold: 2, rejected: 2, pending: 0 } },
    [
      { sampleIndex: 0, facts: 2, GOLD: 2, REJECTED: 0, PENDING: 0 },
      { sampleIndex: 1, facts: 2, GOLD: 0, REJECTED: 2, PENDING: 0 },
    ],
    ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
  );
  t.eq(swapped.ok, false, "逐样本错位必须红（总数对得上也不行）");
  t.eq(swapped.perSample.length, 2, "逐样本逐条对账");
  t.eq(swapped.perSample[0].ok, false, "s0 对不上");
};

/* ── 事件源 ─────────────────────────────────────────────────────────── */

tests["AX05-9 buildEvents：主体映射与文本抽取"] = (t) => {
  const events = buildEvents(LOG);
  t.eq(events.length, 6, "坏行被跳过");
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  t.eq(bySeq.get(9).role, "user", "user/message");
  t.eq(bySeq.get(5).role, "tool", "tool/result");
  t.eq(bySeq.get(6).text, '{"command":"ls -la"}', "tool/call 取 arguments");
  t.eq(bySeq.get(8).role, "assistant", "assistant/message");
  t.eq(bySeq.get(4).role, "harness", "未归类事件按 harness");
  t.eq(bySeq.get(3).role, "system", "system/message");
  t.ok(bySeq.get(9).text.includes("转成md文件给我"), "content 文本块");

  t.eq(roleOfEventType("job/settled"), "tool", "job/* 也是 tool");
  t.eq(roleOfEventType("request/header"), "harness", "未知事件不当成用户");
};

tests["AX05-10 classifyQuote：逐字 / 归错 seq / 跨事件 / 根本没有"] = (t) => {
  const events = [
    { seq: 1, role: "user", text: "第一句原文在这里，长度足够" },
    { seq: 2, role: "tool", text: "另外一段完全不同的输出文本" },
  ];
  t.eq(classifyQuote("第一句原文在这里", events, 1), "verbatim", "逐字");
  t.eq(classifyQuote("另外一段完全不同", events, 1), "foundElsewhere", "在别的 seq 命中");
  t.eq(classifyQuote("第一句原文在这里\n\n另外一段完全不同", events, 1), "multiEventJoin", "跨两个事件拼接");
  t.eq(classifyQuote("会话里不存在的一段话", events, 1), "notFound", "根本没有");
};

/* ── 复判 ───────────────────────────────────────────────────────────── */

tests["AX05-11 replayFact：role 臂与 claim 臂"] = (t) => {
  const events = [
    { seq: 4, role: "harness", text: "runtime context: 文件策略 conservative" },
    { seq: 9, role: "user", text: "把回答转成md文件给我" },
  ];
  const source = { sessionId: "fixture-source", events };
  const good = replayFact(
    { sampleIndex: 0, factId: "F1", tier: "GOLD", claim: "用户要求把回答转成 md", quote: "转成md文件给我", evidenceSeq: 9 },
    source,
  );
  t.eq(good.verdict, VERDICT.SUPPORTED, "主体为 user 且引文逐字 ⇒ 放行");
  t.eq(good.quoteKind, "verbatim", "引文逐字");
  t.eq(good.subjectFromClaim, false, "role 臂不推断主体");

  const missing = replayFact({ sampleIndex: 0, factId: "F2", tier: "GOLD", claim: "x", quote: "y", evidenceSeq: 99 }, source);
  t.eq(missing.verdict, VERDICT.REJECTED, "seq 不存在必须拒");
  t.ok(missing.codes.includes(REASONS.EVIDENCE_SEQ_NOT_FOUND), "原因码是 EVIDENCE_SEQ_NOT_FOUND");
  t.eq(missing.eventFound, false, "不编造事件");

  // claim 臂：claim 里写「系统注入」，但证据是 user 事件 ⇒ 主体混同被抓到。
  const mixed = replayFact(
    { sampleIndex: 0, factId: "F3", tier: "REJECTED", claim: "系统注入了文件策略", quote: "把回答转成md文件给我", evidenceSeq: 9 },
    source,
    { subjectMode: "claim" },
  );
  t.eq(mixed.subject, "harness", "claim 臂按主体词推断");
  t.ok(mixed.codes.includes(REASONS.SUBJECT_MISMATCH), "主体与事件 role 不一致 ⇒ SUBJECT_MISMATCH");

  t.eq(inferKind("用户要求不得重启"), "constraint", "kind 推断 constraint");
  t.eq(inferKind("工具退出码 1"), "failure", "kind 推断 failure");
  t.eq(inferKind("某个普通状态"), "state", "kind 兜底 state");
  t.eq(inferSubject("随便一句没有主体词的话"), null, "推断不出主体就是 null");
};

/* ── 五类硬失败反例 ─────────────────────────────────────────────────── */

tests["AX05-12 五类硬失败：每类都有红例和对照"] = (t) => {
  const probes = runProbes();
  t.eq(probes.batch, 10, "五类 × 两条");
  t.eq(probes.failed, 0, "全部通过");
  t.eq(probes.passed, 10, "全部通过（计数）");
  for (const klass of HARD_FAILURE_CLASSES) {
    const red = probes.rows.find((r) => r.klass === klass && r.name.endsWith("/red"));
    const green = probes.rows.find((r) => r.klass === klass && r.name.endsWith("/green"));
    t.ok(Boolean(red && green), `${klass} 有红有绿`);
    t.eq(red.verdict, VERDICT.REJECTED, `${klass} 红例被拒`);
    t.ok(red.codes.includes(klass), `${klass} 红例原因码命中`);
    t.eq(green.verdict, VERDICT.SUPPORTED, `${klass} 对照例通过`);
  }
};

/* ── 聚合 ───────────────────────────────────────────────────────────── */

const syntheticRows = [
  { sampleIndex: 0, factId: "F1", tier: "GOLD", verdict: "SUPPORTED", codes: [], quoteKind: "verbatim" },
  { sampleIndex: 0, factId: "F2", tier: "GOLD", verdict: "REJECTED", codes: [REASONS.QUOTE_NOT_VERBATIM], quoteKind: "notFound" },
  { sampleIndex: 0, factId: "F3", tier: "REJECTED", verdict: "REJECTED", codes: [REASONS.UNSOURCED_NEGATIVE], quoteKind: "verbatim" },
  { sampleIndex: 1, factId: "F1", tier: "REJECTED", verdict: "SUPPORTED", codes: [], quoteKind: "verbatim" },
  { sampleIndex: 1, factId: "F2", tier: "PENDING", verdict: "SUPPORTED", codes: [], quoteKind: "verbatim" },
];

tests["AX05-13 aggregate：两种 precision 分开算，PENDING 不算 GOLD"] = (t) => {
  const stats = aggregate(syntheticRows, { totals: { facts: 5, gold: 2, rejected: 2, pending: 1 } });
  t.eq(stats.precision.labelAdjudicated.numerator, 2, "人工口径分子 = GOLD");
  t.eq(stats.precision.labelAdjudicated.denominator, 4, "人工口径分母 = GOLD + REJECTED（PENDING 不进）");
  t.eq(stats.precision.labelAdjudicated.value, 0.5, "人工口径值");
  t.eq(stats.precision.labelAllFacts.denominator, 5, "全事实口径分母含 PENDING");
  t.eq(stats.precision.guardAccepted.numerator, 1, "守卫放行里真金数");
  t.eq(stats.precision.guardAccepted.denominator, 3, "守卫放行数");
  t.eq(stats.pending.countedAsGold, false, "PENDING 永不计入 GOLD");
  t.eq(stats.pending.shapeAcceptedOnly, 1, "PENDING 只能算形状被接受");
  t.eq(stats.confusion.rejectedGold, 1, "人工 GOLD 被守卫拒");
  t.eq(stats.confusion.acceptedRejected, 1, "人工 REJECTED 被守卫放行");
  t.eq(stats.instrument.constantTrue, false, "不是恒真");
  t.eq(stats.instrument.constantFalse, false, "不是恒假");
  t.eq(stats.frozenQuoteVerbatim.verbatim, 4, "quote 分类计数");
  t.eq(stats.frozenQuoteVerbatim.notFound, 1, "quote 分类计数（notFound）");
  t.eq(stats.quoteMissBreakdown.goldRejectedByQuote, 1, "GOLD 被拒里按引文的那部分");
  t.eq(stats.hardFailures.length, 5, "五类硬失败都要出账");
};

tests["AX05-14 aggregate：恒真 / 恒假的识别"] = (t) => {
  const allAccepted = aggregate(
    syntheticRows.map((r) => ({ ...r, verdict: "SUPPORTED", codes: [] })),
    { totals: { facts: 5, gold: 2, rejected: 2, pending: 1 } },
  );
  t.eq(allAccepted.instrument.constantTrue, true, "全放行 = 恒真");
  const allRejected = aggregate(
    syntheticRows.map((r) => ({ ...r, verdict: "REJECTED", codes: [REASONS.QUOTE_NOT_VERBATIM] })),
    { totals: { facts: 5, gold: 2, rejected: 2, pending: 1 } },
  );
  t.eq(allRejected.instrument.constantFalse, true, "全拒 = 恒假");
};

/* ── 自证 ───────────────────────────────────────────────────────────── */

tests["AX05-15 auditSource：真源码通过，植入出口必红"] = (t) => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const clean = auditSource(source);
  t.eq(clean.ok, true, `本脚本不得有模型/网络出口（命中：${clean.hits.join(", ")}）`);

  t.eq(auditSource("const r = await fetch('x');").ok, false, "fetch 必红");
  t.eq(auditSource("const cp = await import('node:child_process');").ok, false, "子进程必红");
  t.eq(auditSource("const u = 'https://host/v1/chat/completions';").ok, false, "模型端点必红");
  t.eq(auditSource("// 注释里提到 fetch( 不算\nconst a = 1;").ok, true, "注释里出现不算（注释被剥掉）");
};

tests["AX05-16 privacyCheck：正文回查 + sid 形态"] = (t) => {
  const facts = [{ sampleIndex: 0, factId: "F1", claim: "用户要求把回答转成 md 文件并脱敏", quote: "转成md文件给我" }];
  t.eq(privacyCheck(JSON.stringify({ ok: 1 }), facts).ok, true, "干净产物通过");

  const leaky = privacyCheck(JSON.stringify({ note: "用户要求把回答转成 md 文件并脱敏" }), facts);
  t.eq(leaky.ok, false, "claim 泄进产物必须红");
  t.eq(leaky.violations.length, 1, "定位到一条违规");
  t.eq(leaky.violations[0].field, "claim", "指出是哪个字段");

  const sidShape = ["session", "1234abcd", "0000", "0000", "0000", "000000000000"].join("-");
  const sid = privacyCheck(sidShape, facts);
  t.eq(sid.ok, false, "sid 形态必红");
  t.ok(sid.shapeHits.includes("session-id"), "识别为 session-id");
};

/* ── 报告 ───────────────────────────────────────────────────────────── */

function syntheticReport() {
  const corpus = buildCorpus({ manifest: MANIFEST, labelsText: LABELS, dossiers: [{ name: "d1.md", text: DOSSIER }] });
  const census = tierCensus(corpus.facts);
  const audit = {
    totals: { facts: census.totals.facts, gold: census.totals.GOLD, rejected: census.totals.REJECTED, pending: census.totals.PENDING },
  };
  const alignment = checkFrozenAlignment(census.totals, audit);
  const source = {
    sessionId: null,
    events: buildEvents(LOG),
  };
  const rows = corpus.facts.map((f) => replayFact(f, source));
  const stats = aggregate(rows, { totals: census.totals });
  return {
    corpus,
    census,
    stats,
    report: buildReport({
      rev: "0".repeat(40),
      corpus,
      census,
      alignment,
      sources: [source],
      rows,
      stats,
      probes: runProbes(),
      sourceAudit: { ok: true, hits: [] },
      privacy: { ok: true, violations: [], shapeHits: [] },
      subjectMode: "role",
      generatedAt: "2026-01-01T00:00:00.000Z",
    }),
  };
}

tests["AX05-17 buildReport：只出聚合，正文一个字都不许进"] = (t) => {
  const { corpus, report } = syntheticReport();
  t.eq(report.schema, SCHEMA, "schema");
  t.eq(report.alignment.ok, true, "对齐标记");
  t.eq(report.selfCheck.privacy.ok, true, "自证通过");
  t.eq(report.instrument.probes.passed, 10, "探针计数进报告");
  t.eq(report.mode.modelCalls, 0, "模型调用 0");
  t.eq(report.replay.perFact.length, corpus.facts.length, "逐条坐标齐全");

  const serialized = JSON.stringify(report);
  const privacy = privacyCheck(serialized, corpus.facts);
  t.eq(privacy.ok, true, "report.json 里没有私有正文");

  const md = renderMarkdown(report);
  t.eq(privacyCheck(md, corpus.facts).ok, true, "REPORT.md 里没有私有正文");
  t.ok(md.includes("机械形状 ≠ 语义 precision"), "必须写明两种口径的区别");
  t.ok(md.includes("PENDING"), "必须交代 PENDING 处理");
  t.ok(md.includes("未验与已知限制"), "必须写未验项");
};

tests["AX05-18 报告不把 PENDING 说成 GOLD，也不宣称语义已证明"] = (t) => {
  const { report } = syntheticReport();
  const md = renderMarkdown(report);
  t.eq(report.frozen.pending, report.replay.pending.frozen, "PENDING 分母一致");
  t.eq(report.replay.pending.countedAsGold, false, "PENDING 不计入 GOLD");
  t.ok(!/PENDING[^\n]{0,20}算作 GOLD/.test(md), "不许把 PENDING 算成 GOLD");
  t.ok(md.includes("不宣称"), "必须显式写「不宣称」");
};

tests["AX05-19 默认开关仍然是 false（复判不许改运行期行为）"] = (t) => {
  t.eq(DEFAULT_ENABLED, false, "fact-guard 默认 false");
  const { report } = syntheticReport();
  t.eq(report.guard.defaultEnabled, false, "报告里要写明默认 false");
};

tests["AX05-20 档位枚举只有三种，没有银标"] = (t) => {
  t.eq([...TIERS], ["GOLD", "REJECTED", "PENDING"], "三档");
  t.eq(TIERS.includes("SILVER"), false, "不许有银标");
};

tests["AX05-21 readGitRev：普通仓库 / 链接 worktree / 取不到"] = (t) => {
  const sha = "1".repeat(40);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ax05-rev-"));
  try {
    // ① 普通仓库：.git 是目录，HEAD 指向 ref，ref 在 .git/refs 下
    const plain = path.join(root, "plain");
    fs.mkdirSync(path.join(plain, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(plain, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(plain, ".git", "refs", "heads", "main"), `${sha}\n`);
    t.eq(readGitRev(plain), sha, "普通仓库");

    // ② 链接 worktree：.git 是文件，ref 存在 commondir 指向的公共目录里
    const common = path.join(root, "common");
    const linked = path.join(root, "linked");
    fs.mkdirSync(path.join(common, "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(linked, ".git-link"), { recursive: true });
    fs.writeFileSync(path.join(common, "refs", "heads", "task-x"), `${sha}\n`);
    fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(linked, ".git-link")}\n`);
    fs.writeFileSync(path.join(linked, ".git-link", "HEAD"), "ref: refs/heads/task-x\n");
    fs.writeFileSync(path.join(linked, ".git-link", "commondir"), `../../common\n`);
    t.eq(readGitRev(linked), sha, "链接 worktree 走 commondir");

    // ③ 取不到就返回 null，不许抛
    t.eq(readGitRev(path.join(root, "missing")), null, "没有 .git 返回 null");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
