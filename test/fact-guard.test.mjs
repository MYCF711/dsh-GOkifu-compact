/**
 * fact-guard.test.mjs —— AX-01：事实候选 / 叙事候选的冷代码守卫（2026-11-07）
 *
 * 这个文件钉住四件事，任何一条松掉都算失败：
 *
 *   ① **契约**：`FactCandidate` / `NarrativeCandidate` 的字段集合、裁决枚举、原因码是**冻结**的；
 *      叙事只能引用事实 id。
 *   ② **仪器不是恒真/恒假**：K-26 的形状（12 份样本 / 92 条 = 68 GOLD + 19 REJECTED + 5 PENDING）
 *      在夹具里逐条复判 —— 68 条 GOLD **一条都不许被机械规则误杀**，19 条 REJECTED **一条都不许漏**。
 *      另有变异自检：把 GOLD 的 quote 改一个字必须红，把 REJECTED 的证据修好必须绿。
 *   ③ **三条不可妥协的语义**：无证据只能 UNVERIFIED/PENDING；quote 逐字命中 ≠ 语义蕴含；
 *      不支持的结构化输出必须显式 degraded。
 *   ④ **零模型调用 + 默认关**：模块只有 `config-schema.mjs` 一个 import，没有任何网络/宿主 API；
 *      `factGuard` 默认 false 时守卫**完全不应用**（零裁决）。
 *
 * 夹具是**合成**的（`test/fixtures/fact-guard.json`，由 `tmp/axiom-2026-11-07/ax01/gen-fixture.mjs`
 * 生成并自校验）：只复刻 K-26 的形状与五类失真，不含任何私有会话正文、quote、sid 或路径。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const GUARD_URL = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "fact-guard.mjs")).href;
const SCHEMA_URL = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href;

const {
  CONTRACT,
  DEFAULT_ENABLED,
  MAX_QUOTE_CHARS,
  VERDICT,
  FACT_KINDS,
  SUBJECTS,
  FACT_FIELDS,
  NARRATIVE_FIELDS,
  ENVELOPE_FIELDS,
  REASONS,
  ENTAILMENT_NOTE,
  normalizeText,
  quoteFound,
  evaluateFactCandidate,
  evaluateNarrativeCandidate,
  guardModelOutput,
  describeContract,
} = await import(GUARD_URL);

const fixture = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "fixtures", "fact-guard.json"), "utf8"));

/** 跑一份样本（夹具的 facts / narratives 已经是纯契约候选）。 */
function guardSample(sample, factGuard = true) {
  return guardModelOutput(
    { facts: sample.facts, narratives: sample.narratives },
    { factGuard, session: { sessionId: sample.id, events: sample.events } },
  );
}

/** 裁决按 id 索引。 */
function byId(verdicts) {
  return new Map(verdicts.map((verdict) => [verdict.id, verdict]));
}

function codesOf(verdict) {
  return (verdict?.reasons ?? []).map((entry) => entry.code);
}

/** 最小合成会话（结构用例共用）。 */
const SESSION = {
  sessionId: "s-test",
  events: [
    { seq: 1, role: "user", text: "只改 fact-guard.mjs，不要动 engine.mjs。" },
    { seq: 2, role: "tool", text: "write: src/rooms/fact-guard.mjs（12,034 字节）" },
    { seq: 3, role: "assistant", text: "已按可写面停止。" },
  ],
};

const fact = (overrides = {}) => ({
  id: "f1",
  kind: "constraint",
  subject: "user",
  claim: "用户要求只改 fact-guard 房间",
  quote: "只改 fact-guard.mjs",
  evidenceSeq: 1,
  ...overrides,
});

const guardOne = (candidate, session = SESSION) => evaluateFactCandidate(candidate, session, { seenIds: new Set() });

export const tests = {
  /* ───────────────────────── ① 契约 ───────────────────────── */

  "契约冻结：FactCandidate / NarrativeCandidate 字段、裁决枚举、原因码（改一个就红）"(t) {
    t.eq([...FACT_FIELDS], ["id", "kind", "subject", "claim", "quote", "evidenceSeq", "validAtSeq", "evidenceSession", "status", "value"]);
    t.eq([...NARRATIVE_FIELDS], ["id", "text", "factRefs", "validAtSeq"]);
    t.eq([...ENVELOPE_FIELDS], ["facts", "narratives"]);
    t.eq([...FACT_KINDS], ["constraint", "decision", "state", "failure", "value", "unverified"]);
    t.eq([...SUBJECTS], ["user", "assistant", "tool", "harness", "system"]);
    t.eq(Object.values(VERDICT), ["SUPPORTED", "UNVERIFIED", "PENDING", "REJECTED"], "裁决枚举（没有银标）");
    t.eq(CONTRACT, "gokifu/fact-candidate/v1", "契约版本");
    t.eq(MAX_QUOTE_CHARS, 120, "quote 允许截断到 120 字符（K-26 协议 §2）");

    const contract = describeContract();
    t.eq(contract.contract, CONTRACT, "自述与常量同源");
    t.eq([...contract.factFields], [...FACT_FIELDS], "自述字段表");
    t.eq([...contract.subjects], [...SUBJECTS], "自述主体表");
    t.eq(contract.entailmentNote, ENTAILMENT_NOTE, "自述边界文案");
    t.includes(ENTAILMENT_NOTE, "语义", "边界文案必须写明「逐字命中 ≠ 语义蕴含」");

    const reasonCodes = Object.values(REASONS);
    t.eq(new Set(reasonCodes).size, reasonCodes.length, "原因码不许重复");
    for (const code of ["SUBJECT_MISMATCH", "UNSOURCED_NEGATIVE", "STALE_CURRENT", "ARGUMENT_AS_RESULT", "STATUS_OVERCLAIM", "QUOTE_NOT_VERBATIM", "CROSS_SESSION_SEQ", "FUTURE_EVIDENCE", "UNKNOWN_FIELD", "BAD_JSON", "UNSUPPORTED_SHAPE", "NO_EVIDENCE"]) {
      t.eq(reasonCodes.includes(code), true, `原因码 ${code} 必须在册`);
    }
  },

  "零模型调用：模块只有 config-schema 一个 import，没有网络/宿主/子进程 API"(t) {
    const source = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "fact-guard.mjs"), "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
    t.eq(specifiers, ["./config-schema.mjs"], "唯一允许的 import 是配置单一来源");
    for (const banned of ["@deepseek-ai/", "child_process", "fetch(", "XMLHttpRequest", "chat/completions", "http://", "https://"]) {
      t.eq(source.includes(banned), false, `不许出现 ${banned}（守卫是纯函数，不调模型）`);
    }
  },

  /* ─────────────────── ② K-26 形状：68 / 19 / 5 ─────────────────── */

  "K-26 形状：68 条 GOLD 一条都不许被机械规则误杀（逐条 SUPPORTED）"(t) {
    t.eq(fixture.k26Shape, { samples: 12, total: 92, gold: 68, rejected: 19, pending: 5 }, "夹具形状必须与 K-26 对齐（92 = 68 + 19 + 5，12 份样本）");
    let checkedGold = 0;
    for (const sample of fixture.samples) {
      const result = guardSample(sample);
      t.eq(result.degraded, false, `${sample.id} 不许被 degraded`);
      const verdicts = byId(result.facts);
      for (const expected of sample.expectFacts.filter((entry) => entry.verdict === "SUPPORTED")) {
        const verdict = verdicts.get(expected.id);
        t.eq(verdict?.verdict, VERDICT.SUPPORTED, `${sample.id}/${expected.id} 被误杀：${codesOf(verdict).join(",") || "（无原因）"}`);
        t.eq(verdict?.quoteVerbatim, true, `${sample.id}/${expected.id} 的 quote 必须逐字命中`);
        checkedGold += 1;
      }
    }
    t.eq(checkedGold, 68, "GOLD 复判条数");
  },

  "K-26 形状：19 条 REJECTED 逐条命中预期原因码（一条都不许漏）"(t) {
    let checked = 0;
    const seenCodes = new Set();
    for (const sample of fixture.samples) {
      const result = guardSample(sample);
      const verdicts = byId(result.facts);
      for (const expected of sample.expectFacts.filter((entry) => entry.verdict === "REJECTED")) {
        const verdict = verdicts.get(expected.id);
        t.eq(verdict?.verdict, VERDICT.REJECTED, `${sample.id}/${expected.id} 必须被拒（实际 ${verdict?.verdict}）`);
        t.eq(codesOf(verdict).includes(expected.code), true, `${sample.id}/${expected.id} 原因码应为 ${expected.code}，实际 ${codesOf(verdict).join(",") || "（无）"}`);
        seenCodes.add(expected.code);
        checked += 1;
      }
    }
    t.eq(checked, 19, "REJECTED 复判条数");
    // 五类已知失真全部被覆盖到
    for (const code of ["SUBJECT_MISMATCH", "UNSOURCED_NEGATIVE", "STALE_CURRENT", "ARGUMENT_AS_RESULT", "STATUS_OVERCLAIM"]) {
      t.eq(seenCodes.has(code), true, `五类已知失真必须有一类被夹具覆盖：${code}`);
    }
  },

  "K-26 形状：5 条 PENDING 既不算 supported 也不算 rejected（分母不许混）"(t) {
    let supported = 0;
    let pending = 0;
    let rejected = 0;
    let unverified = 0;
    for (const sample of fixture.samples) {
      const result = guardSample(sample);
      const verdicts = byId(result.facts);
      for (const expected of sample.expectFacts.filter((entry) => entry.verdict === "PENDING")) {
        const verdict = verdicts.get(expected.id);
        t.eq(verdict?.verdict, VERDICT.PENDING, `${sample.id}/${expected.id} 必须是 PENDING`);
        t.eq(codesOf(verdict).includes(REASONS.NO_EVIDENCE), true, "PENDING 的原因必须是 NO_EVIDENCE");
      }
      supported += result.summary.supported;
      pending += result.summary.pending;
      rejected += result.summary.rejected;
      unverified += result.summary.unverified;
    }
    t.eq(supported, 68, "supported 分母");
    t.eq(rejected, 19, "rejected 分母");
    t.eq(pending, 5, "pending 分母");
    t.eq(unverified, 0, "没有 UNVERIFIED（PENDING 声明不会被降级成 UNVERIFIED）");
    t.eq(supported + rejected + pending + unverified, 92, "分母必须凑满 92");
  },

  "五类已知失真 + 4 类结构失败：每类都有正反例（同一形态一个拒、一个过）"(t) {
    const lookup = new Map();
    for (const sample of fixture.samples) {
      const result = guardSample(sample);
      for (const verdict of result.facts) lookup.set(verdict.id, verdict);
    }
    t.eq(fixture.classes.length >= 9, true, "对照表至少 9 类（五类失真 + 4 类结构）");
    for (const entry of fixture.classes) {
      const rejected = lookup.get(entry.reject);
      const accepted = lookup.get(entry.accept);
      t.ok(rejected !== undefined, `${entry.code} 的反例 ${entry.reject} 必须在夹具里`);
      t.eq(rejected?.verdict, VERDICT.REJECTED, `${entry.code} 的反例必须红`);
      t.eq(codesOf(rejected).includes(entry.code), true, `${entry.code} 的反例原因码（实际 ${codesOf(rejected).join(",")}）`);
      t.ok(accepted !== undefined, `${entry.code} 的正例 ${entry.accept} 必须在夹具里`);
      t.eq(accepted?.verdict, VERDICT.SUPPORTED, `${entry.code} 的正例必须绿（否则就是恒假仪器）`);
    }
  },

  /* ───────────────── ③ 三条不可妥协的语义 ───────────────── */

  "无证据只能 UNVERIFIED / PENDING：SUPPORTED 声明会被降级，永不被当成事实"(t) {
    const noEvidence = guardOne({ id: "f1", kind: "state", subject: "user", claim: "用户要求只改 fact-guard 房间", status: "SUPPORTED" });
    t.eq(noEvidence.verdict, VERDICT.UNVERIFIED, "无 quote/seq 时声明 SUPPORTED ⇒ 降级 UNVERIFIED");
    t.eq(codesOf(noEvidence).includes(REASONS.NO_EVIDENCE), true, "原因必须是 NO_EVIDENCE");

    const declaredPending = guardOne({ id: "f1", kind: "state", subject: "user", claim: "待补证", status: "PENDING" });
    t.eq(declaredPending.verdict, VERDICT.PENDING, "显式 PENDING 保留 PENDING");

    const quoteNoSeq = guardOne(fact({ evidenceSeq: undefined }));
    t.eq(quoteNoSeq.verdict, VERDICT.UNVERIFIED, "只有 quote 没有 seq ⇒ UNVERIFIED");

    const seqNoQuote = guardOne(fact({ quote: undefined }));
    t.eq(seqNoQuote.verdict, VERDICT.UNVERIFIED, "只有 seq 没有 quote ⇒ UNVERIFIED");

    const emptyQuote = guardOne(fact({ quote: "   " }));
    t.eq(emptyQuote.verdict, VERDICT.UNVERIFIED, "空白 quote 等于没证据");
  },

  "quote 逐字：空白/全角/省略号/120 截断都容忍（防假阴性），转述必须红"(t) {
    t.eq(quoteFound("只改  fact-guard.mjs", "只改\nfact-guard.mjs，不要动 engine.mjs。"), true, "空白归一化不算不逐字");
    t.eq(quoteFound("只改 fact-guard.mjs……", "只改 fact-guard.mjs，不要动 engine.mjs。"), true, "尾部省略号按截断处理");
    const longText = "只改 fact-guard.mjs，不要动 engine.mjs。".repeat(8);
    const longQuote = `${longText}（这一段截断后才有的尾巴不在原文里）`;
    t.eq(quoteFound(longQuote, longText), true, "超长 quote 按前 120 字符比较");
    t.eq(quoteFound("转述拼接的内容", "只改 fact-guard.mjs，不要动 engine.mjs。"), false, "转述必须判不逐字");
    t.eq(quoteFound("只改 fact-guard.mjs", ""), false, "空证据文本");
    t.eq(normalizeText(" a\u200B  b "), "a b", "零宽字符要被清掉");

    const verdict = guardOne(fact({ claim: "quote 必须逐字", quote: "quote 必须逐字出现" }));
    t.eq(verdict.verdict, VERDICT.REJECTED, "转述的 quote 必须红");
    t.eq(codesOf(verdict).includes(REASONS.QUOTE_NOT_VERBATIM), true, "原因码 QUOTE_NOT_VERBATIM");
  },

  "quote 命中不宣称语义蕴含：所有裁决 entailmentProven 恒 false、信封恒 NOT_PROVEN"(t) {
    const sample = fixture.samples[0];
    const result = guardSample(sample);
    t.eq(result.summary.semanticEntailment, "NOT_PROVEN", "信封必须显式 NOT_PROVEN");
    for (const verdict of [...result.facts, ...result.narratives]) {
      t.eq(verdict.entailmentProven, false, `${verdict.id} 的 entailmentProven 必须恒 false`);
    }
    const supported = result.facts.find((verdict) => verdict.verdict === VERDICT.SUPPORTED);
    t.eq(supported?.quoteVerbatim, true, "SUPPORTED 只声明「quote 逐字」，不声明「语义蕴含」");
    t.eq(supported?.entailmentProven, false, "逐字命中不升级成蕴含");
  },

  "不支持的结构化输出必须显式 degraded（绝不静默当成「没有事实」）"(t) {
    const session = { sessionId: "s-test", events: SESSION.events };

    const badJson = guardModelOutput("{ not json", { factGuard: true, session });
    t.eq(badJson.degraded, true, "坏 JSON ⇒ degraded");
    t.eq(badJson.degradedReason, REASONS.BAD_JSON, "原因 BAD_JSON");
    t.eq(badJson.applied, false, "degraded 时不许应用");
    t.eq(badJson.facts, [], "degraded 时不产出裁决");

    const arrayTop = guardModelOutput("[]", { factGuard: true, session });
    t.eq(arrayTop.degraded, true, "顶层是数组 ⇒ degraded");
    t.eq(arrayTop.degradedReason, REASONS.UNSUPPORTED_SHAPE, "原因 UNSUPPORTED_SHAPE");

    const unknownTop = guardModelOutput({ facts: [], narratives: [], extra: 1 }, { factGuard: true, session });
    t.eq(unknownTop.degraded, true, "顶层未知字段 ⇒ degraded");
    t.eq(unknownTop.degradedReason, REASONS.UNKNOWN_FIELD, "原因 UNKNOWN_FIELD");

    const notArray = guardModelOutput({ facts: {}, narratives: [] }, { factGuard: true, session });
    t.eq(notArray.degraded, true, "facts 不是数组 ⇒ degraded");
    t.eq(notArray.degradedReason, REASONS.UNSUPPORTED_SHAPE, "原因 UNSUPPORTED_SHAPE");

    const noSource = guardModelOutput({ facts: [], narratives: [] }, { factGuard: true });
    t.eq(noSource.degraded, true, "没有证据源 ⇒ degraded");
    t.eq(noSource.degradedReason, REASONS.NO_SESSION_SOURCE, "原因 NO_SESSION_SOURCE");

    const goodString = guardModelOutput(JSON.stringify({ facts: [fact()], narratives: [] }), { factGuard: true, session });
    t.eq(goodString.degraded, false, "合法 JSON 字符串必须照常裁决");
    t.eq(goodString.applied, true, "合法输入必须 applied");
    t.eq(goodString.facts[0].verdict, VERDICT.SUPPORTED, "合法候选必须 SUPPORTED");
  },

  /* ─────────────────── 结构 / 证据硬失败 ─────────────────── */

  "序号硬失败：跨会话 / 未来证据 / 不存在的 seq / 非法 seq 各自红且原因码正确"(t) {
    const crossSession = guardOne(fact({ evidenceSession: "s-other" }));
    t.eq(crossSession.verdict, VERDICT.REJECTED, "跨会话 seq ⇒ 红");
    t.eq(codesOf(crossSession).includes(REASONS.CROSS_SESSION_SEQ), true, "原因 CROSS_SESSION_SEQ");

    const future = guardOne(fact({ evidenceSeq: 3, validAtSeq: 1 }));
    t.eq(future.verdict, VERDICT.REJECTED, "未来证据 ⇒ 红");
    t.eq(codesOf(future).includes(REASONS.FUTURE_EVIDENCE), true, "原因 FUTURE_EVIDENCE");

    const missingSeq = guardOne(fact({ evidenceSeq: 99, validAtSeq: 99 }));
    t.eq(missingSeq.verdict, VERDICT.REJECTED, "不存在的 seq ⇒ 红");
    t.eq(codesOf(missingSeq).includes(REASONS.EVIDENCE_SEQ_NOT_FOUND), true, "原因 EVIDENCE_SEQ_NOT_FOUND");

    const negativeSeq = guardOne(fact({ evidenceSeq: -1 }));
    t.eq(negativeSeq.verdict, VERDICT.REJECTED, "负 seq ⇒ 红");
    t.eq(codesOf(negativeSeq).includes(REASONS.INVALID_SEQ), true, "原因 INVALID_SEQ");

    const badValidAt = guardOne(fact({ validAtSeq: 1.5 }));
    t.eq(badValidAt.verdict, VERDICT.REJECTED, "非整数 validAtSeq ⇒ 红");
    t.eq(codesOf(badValidAt).includes(REASONS.INVALID_SEQ), true, "原因 INVALID_SEQ");

    // 缺省 validAtSeq = 会话末（不越时点）
    const defaulted = guardOne(fact({ evidenceSeq: 1 }));
    t.eq(defaulted.validAtSeq, 3, "缺省 validAtSeq 取会话最后一条事件");
    t.eq(defaulted.verdict, VERDICT.SUPPORTED, "缺省时点不制造假红");
  },

  "结构硬失败：未知字段 / 未知 kind / 缺 id / 重复 id / 缺 subject / 缺 claim 各自红"(t) {
    const unknownField = guardOne({ ...fact(), extra: 1 });
    t.eq(codesOf(unknownField).includes(REASONS.UNKNOWN_FIELD), true, "未知字段 ⇒ 红");

    const unknownKind = guardOne(fact({ kind: "vibes" }));
    t.eq(codesOf(unknownKind).includes(REASONS.UNKNOWN_KIND), true, "未知 kind ⇒ 红");

    const missingId = guardOne(fact({ id: "  " }));
    t.eq(codesOf(missingId).includes(REASONS.MISSING_ID), true, "缺 id ⇒ 红");

    const missingSubject = guardOne(fact({ subject: undefined }));
    t.eq(codesOf(missingSubject).includes(REASONS.MISSING_SUBJECT), true, "缺 subject ⇒ 红");

    const badSubject = guardOne(fact({ subject: "root" }));
    t.eq(codesOf(badSubject).includes(REASONS.MISSING_SUBJECT), true, "未知 subject ⇒ 红");

    const missingClaim = guardOne(fact({ claim: "  " }));
    t.eq(codesOf(missingClaim).includes(REASONS.MISSING_CLAIM), true, "缺 claim ⇒ 红");

    const state = { seenIds: new Set() };
    const first = evaluateFactCandidate(fact({ id: "dup" }), SESSION, state);
    const second = evaluateFactCandidate(fact({ id: "dup" }), SESSION, state);
    t.eq(first.verdict, VERDICT.SUPPORTED, "第一条 SUPPORTED");
    t.eq(codesOf(second).includes(REASONS.DUPLICATE_ID), true, "重复 id ⇒ 红");

    const notObject = evaluateFactCandidate("fact", SESSION, { seenIds: new Set() });
    t.eq(codesOf(notObject).includes(REASONS.UNSUPPORTED_SHAPE), true, "候选不是对象 ⇒ 红");
  },

  "无源负向断言：连证据都没有的否定句直接拒绝（不是「降级」）"(t) {
    const verdict = guardOne({ id: "f1", kind: "state", subject: "user", claim: "日志里没有任何失败输出" });
    t.eq(verdict.verdict, VERDICT.REJECTED, "无证据的否定句 ⇒ 红");
    t.eq(codesOf(verdict).includes(REASONS.UNSOURCED_NEGATIVE), true, "原因 UNSOURCED_NEGATIVE");
    t.eq(codesOf(verdict).includes(REASONS.NO_EVIDENCE), true, "同时保留 NO_EVIDENCE 作为旁证");
  },

  /* ───────────────────────── 叙事 ───────────────────────── */

  "叙事只能引用事实 id：不存在 ⇒ 拒；引用被拒事实 ⇒ 拒；引用未验证事实 ⇒ 降级；空引用 ⇒ 降级"(t) {
    const facts = new Map([
      ["ok", { id: "ok", verdict: VERDICT.SUPPORTED }],
      ["bad", { id: "bad", verdict: VERDICT.REJECTED }],
      ["pend", { id: "pend", verdict: VERDICT.PENDING }],
    ]);
    const judge = (candidate) => evaluateNarrativeCandidate(candidate, facts, { seenIds: new Set() });

    const supported = judge({ id: "n1", text: "叙事", factRefs: ["ok"] });
    t.eq(supported.verdict, VERDICT.SUPPORTED, "全部引用 SUPPORTED ⇒ SUPPORTED");
    t.eq(supported.entailmentProven, false, "叙事也不宣称语义蕴含");
    t.eq(supported.citedFacts, [{ id: "ok", verdict: "SUPPORTED" }], "引用明细");

    const missing = judge({ id: "n2", text: "叙事", factRefs: ["ghost"] });
    t.eq(missing.verdict, VERDICT.REJECTED, "引用不存在的事实 ⇒ 拒");
    t.eq(codesOf(missing).includes(REASONS.MISSING_FACT_REF), true, "原因 MISSING_FACT_REF");

    const citedRejected = judge({ id: "n3", text: "叙事", factRefs: ["ok", "bad"] });
    t.eq(citedRejected.verdict, VERDICT.REJECTED, "引用被拒事实 ⇒ 拒");
    t.eq(codesOf(citedRejected).includes(REASONS.CITED_REJECTED_FACT), true, "原因 CITED_REJECTED_FACT");

    const citedPending = judge({ id: "n4", text: "叙事", factRefs: ["pend"] });
    t.eq(citedPending.verdict, VERDICT.UNVERIFIED, "引用待补证事实 ⇒ 降级 UNVERIFIED");
    t.eq(codesOf(citedPending).includes(REASONS.CITED_UNVERIFIED_FACT), true, "原因 CITED_UNVERIFIED_FACT");

    const noRefs = judge({ id: "n5", text: "叙事", factRefs: [] });
    t.eq(noRefs.verdict, VERDICT.UNVERIFIED, "不引用事实 ⇒ 不能当事实渲染");
    t.eq(codesOf(noRefs).includes(REASONS.NO_FACT_REFS), true, "原因 NO_FACT_REFS");

    const badRefs = judge({ id: "n6", text: "叙事", factRefs: [1] });
    t.eq(badRefs.verdict, VERDICT.REJECTED, "factRefs 不是字符串数组 ⇒ 拒");

    const noText = judge({ id: "n7", text: "  ", factRefs: ["ok"] });
    t.eq(codesOf(noText).includes(REASONS.MISSING_TEXT), true, "缺 text ⇒ 拒");

    const unknown = judge({ id: "n8", text: "叙事", factRefs: ["ok"], extra: 1 });
    t.eq(codesOf(unknown).includes(REASONS.UNKNOWN_FIELD), true, "叙事未知字段 ⇒ 拒");
  },

  /* ─────────────────── 开关 / 确定性 / 变异自检 ─────────────────── */

  "factGuard 默认 false：守卫完全不应用（零解析、零裁决），且与 config-schema 同源": async (t) => {
    const schemaMod = await import(SCHEMA_URL);
    t.eq(DEFAULT_ENABLED, false, "守卫默认关");
    t.eq(schemaMod.FACT_GUARD_DEFAULT, DEFAULT_ENABLED, "默认值必须与 config-schema 同一处");
    t.eq(schemaMod.resolveConfig({}).factGuard, false, "resolveConfig 空输入 ⇒ false");

    const off = guardModelOutput({ facts: [fact()], narratives: [] }, { session: SESSION });
    t.eq(off.enabled, false, "未传开关 ⇒ 关");
    t.eq(off.applied, false, "关的时候不应用");
    t.eq(off.facts, [], "关的时候零裁决");
    t.eq(off.narratives, [], "关的时候零叙事裁决");
    t.eq(off.degraded, false, "关不是 degraded");
    t.eq(off.disabledReason, REASONS.GUARD_DISABLED, "必须显式说明为什么没裁决");
    t.eq(off.summary.supported, 0, "关的时候不许悄悄给 supported");

    // 关掉的守卫连坏输入都不该炸（引擎侧因此不需要 try/catch）
    const offBad = guardModelOutput("{ not json", { factGuard: false, session: SESSION });
    t.eq(offBad.applied, false, "关的时候坏 JSON 也不抛");

    const on = guardModelOutput({ facts: [fact()], narratives: [] }, { factGuard: true, session: SESSION });
    t.eq(on.enabled, true, "显式 true 才开");
    t.eq(on.applied, true, "开的时候应用");
  },

  "确定性：同一输入两次裁决逐字节相同（无隐藏状态/时间戳）"(t) {
    const sample = fixture.samples[3];
    const first = guardSample(sample);
    const second = guardSample(sample);
    t.eq(JSON.stringify(first), JSON.stringify(second), "同输入必须同输出");
    t.eq(first.summary.total, sample.facts.length, "总数");
    t.eq(first.summary.narratives.total, sample.narratives.length, "叙事总数");
  },

  "变异自检：GOLD 改一个字必须红，REJECTED 补上证据必须绿（仪器不是恒真/恒假）"(t) {
    const goldSample = fixture.samples[0];
    const gold = goldSample.facts.find((candidate) => candidate.id === "g0101");
    const tampered = guardModelOutput(
      { facts: [{ ...gold, quote: `${gold.quote}（篡改）` }], narratives: [] },
      { factGuard: true, session: { sessionId: goldSample.id, events: goldSample.events } },
    );
    t.eq(tampered.facts[0].verdict, VERDICT.REJECTED, "GOLD 的 quote 被改 ⇒ 必须红");
    t.eq(codesOf(tampered.facts[0]).includes(REASONS.QUOTE_NOT_VERBATIM), true, "原因 QUOTE_NOT_VERBATIM");

    // 转述型 REJECTED：把 quote 改回逐字 ⇒ 必须变绿
    const quoteSample = fixture.samples.find((sample) => sample.id === "s08");
    const notVerbatim = quoteSample.facts.find((candidate) => candidate.id === "r0801");
    const fixedQuote = guardModelOutput(
      { facts: [{ ...notVerbatim, quote: "quote 必须逐字" }], narratives: [] },
      { factGuard: true, session: { sessionId: quoteSample.id, events: quoteSample.events } },
    );
    t.eq(fixedQuote.facts[0].verdict, VERDICT.SUPPORTED, "quote 改回逐字 ⇒ 必须绿");

    // 主体混同型 REJECTED：把 subject 改成证据事件的 role ⇒ 必须变绿
    const subjectSample = fixture.samples.find((sample) => sample.id === "s05");
    const wrongSubject = subjectSample.facts.find((candidate) => candidate.id === "r0501");
    const fixedSubject = guardModelOutput(
      { facts: [{ ...wrongSubject, subject: "harness" }], narratives: [] },
      { factGuard: true, session: { sessionId: subjectSample.id, events: subjectSample.events } },
    );
    t.eq(fixedSubject.facts[0].verdict, VERDICT.SUPPORTED, "subject 改对 ⇒ 必须绿");

    // 未来证据型 REJECTED：补上时点 ⇒ 必须变绿
    const futureSample = fixture.samples.find((sample) => sample.id === "s10");
    const future = futureSample.facts.find((candidate) => candidate.id === "r1001");
    const fixedFuture = guardModelOutput(
      { facts: [{ ...future, validAtSeq: 3 }], narratives: [] },
      { factGuard: true, session: { sessionId: futureSample.id, events: futureSample.events } },
    );
    t.eq(fixedFuture.facts[0].verdict, VERDICT.SUPPORTED, "时点补对 ⇒ 必须绿");
  },
};
