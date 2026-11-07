/**
 * fact-guard.mjs —— AX-01：事实候选 / 叙事候选的**冷代码守卫**（2026-11-07）
 *
 * 背景（K-26 的负结果）：12 份归档摘要共 92 条原子事实 = **68 GOLD + 19 REJECTED + 5 PENDING**，
 * 已裁决 precision 只有 78.16%。失真类型集中在五类，全部是**可被冷代码识别的形态**：
 *
 *   ① 主体混同        —— 把 harness 注入写成「用户说」（subject 与证据事件的 role 不一致）
 *   ② 无源负向断言    —— 「日志无 X」这类否定句，引文里根本没有否定的来源
 *   ③ 过期「当前」    —— 节点当时的「当前」被后续修改推翻，却仍按当前陈述
 *   ④ 实参当返回值    —— 把 `fn(false)` 的实参写成「fn 返回 false」
 *   ⑤ 状态过度声称    —— 把「决定改」写成「已改完」
 *
 * 本房间只做一件事：**模型产出的事实候选 + 叙事，必须能被冷代码机械判定「能不能算事实」**。
 * 它不生成事实、不润色摘要、不调用模型 —— 判据全部是确定性的字符串/编号检查。
 *
 * ── 契约（AX-01 的产物，后续 AX-05/06/07/09 只许复用，不许复制）─────────────────
 *
 *   FactCandidate（事实候选）
 *     id            必填 · 同一样本内唯一 · 叙事靠它引用
 *     kind          必填 · constraint | decision | state | failure | value | unverified
 *     subject       必填 · user | assistant | tool | harness | system（**谁做的/谁说的**）
 *     claim         必填 · 单一、可判真假的短句
 *     quote         有证据时必填 · 证据事件里**逐字**存在的片段（可截断到 120 字符）
 *     evidenceSeq   有证据时必填 · 必须落在**同一会话**的事件里
 *     validAtSeq    事实成立的时点（节点当时）；缺省 = 会话最后一条事件的 seq
 *     evidenceSession  可选 · 与源会话不一致 ⇒ 跨会话 seq（红）
 *     status        可选 · SUPPORTED | UNVERIFIED | PENDING（**无证据时只允许后两者**）
 *     value         可选 · kind=value 时的 { name, value }
 *
 *   NarrativeCandidate（叙事候选）
 *     id        必填 · 样本内唯一
 *     text      必填 · 叙事正文
 *     factRefs  必填 · 引用的**事实 id** 列表；空数组 ⇒ 降级 UNVERIFIED（不能当事实渲染）
 *     validAtSeq 可选 · 叙事成立的时点
 *
 * ── 三条不可妥协的语义（写进返回值，不写在注释里靠人记）────────────────────
 *
 *   1. **无证据只能 UNVERIFIED / PENDING**：`status:"SUPPORTED"` 但没有 quote/evidenceSeq 时
 *      **不会**得到 SUPPORTED —— 降级成 UNVERIFIED（PENDING 声明保留 PENDING）。
 *   2. **quote 逐字命中 ≠ 语义蕴含已证明**：所有裁决都带 `entailmentProven:false`，
 *      信封带 `summary.semanticEntailment:"NOT_PROVEN"`。字符串存在只证明「这句话在原文里」，
 *      不证明「这句话支持这条 claim」—— 后者需要语义判断，本房间不冒充。
 *   3. **不支持的结构化输出必须显式 degraded**：坏 JSON / 顶层不是对象 / 未知顶层字段 /
 *      facts 或 narratives 不是数组 / 没有证据源 ⇒ `degraded:true` + `degradedReason`，
 *      **绝不**把不认识的形状当成「没有事实」静默放过。
 *
 * ── 开关 ────────────────────────────────────────────────────────────────────────
 *
 * `factGuard` 默认 **false**（`src/rooms/config-schema.mjs` 的 `FACT_GUARD_DEFAULT`，
 * 单一来源）。false 时 `guardModelOutput()` 只返回 `enabled:false / applied:false`，
 * **不解析、不裁决、不拒绝** —— 引擎侧因此可以保证「开关关掉 = 旧行为逐字不变」。
 *
 * 依赖：R15（`config-schema.mjs` 的默认值）。**零**其它依赖 —— 不 import 任何模型客户端，
 * 本文件里没有网络调用。纯函数，可脱离 DSH 单测。
 */

import { FACT_GUARD_DEFAULT } from "./config-schema.mjs";

/** 契约版本（随字段/裁决语义的破坏性变更递增）。 */
export const CONTRACT = "gokifu/fact-candidate/v1";

/** 开关默认值：与 `config-schema.mjs` 的 `factGuard` 默认值**同一处**。 */
export const DEFAULT_ENABLED = FACT_GUARD_DEFAULT;

/** quote 允许的截断长度（K-26 协议 §2：可截断到 120 字符）。 */
export const MAX_QUOTE_CHARS = 120;

/** 裁决枚举。**没有「银标」**：要么机械可回证，要么降级，要么拒绝。 */
export const VERDICT = Object.freeze({
  SUPPORTED: "SUPPORTED",
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  REJECTED: "REJECTED",
});

/** 事实候选的 kind 枚举（与 K-26 must-keep 的 constraint/failure/state/unverified 对齐）。 */
export const FACT_KINDS = Object.freeze(["constraint", "decision", "state", "failure", "value", "unverified"]);

/** 主体枚举 —— 必须与证据事件的 `role` 逐字一致。 */
export const SUBJECTS = Object.freeze(["user", "assistant", "tool", "harness", "system"]);

/** FactCandidate 允许出现的字段（**白名单**：多一个字段就红）。 */
export const FACT_FIELDS = Object.freeze([
  "id",
  "kind",
  "subject",
  "claim",
  "quote",
  "evidenceSeq",
  "validAtSeq",
  "evidenceSession",
  "status",
  "value",
]);

/** NarrativeCandidate 允许出现的字段（白名单）。 */
export const NARRATIVE_FIELDS = Object.freeze(["id", "text", "factRefs", "validAtSeq"]);

/** 模型输出的顶层信封允许的字段（白名单）。 */
export const ENVELOPE_FIELDS = Object.freeze(["facts", "narratives"]);

/** 拒绝/降级原因码。**每个码都是一条可复现的机械判据**（测试逐码钉住）。 */
export const REASONS = Object.freeze({
  // —— 结构 ——
  BAD_JSON: "BAD_JSON",
  UNSUPPORTED_SHAPE: "UNSUPPORTED_SHAPE",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  NO_SESSION_SOURCE: "NO_SESSION_SOURCE",
  MISSING_ID: "MISSING_ID",
  DUPLICATE_ID: "DUPLICATE_ID",
  MISSING_CLAIM: "MISSING_CLAIM",
  MISSING_TEXT: "MISSING_TEXT",
  UNKNOWN_KIND: "UNKNOWN_KIND",
  MISSING_SUBJECT: "MISSING_SUBJECT",
  // —— 证据 ——
  NO_EVIDENCE: "NO_EVIDENCE",
  INVALID_SEQ: "INVALID_SEQ",
  CROSS_SESSION_SEQ: "CROSS_SESSION_SEQ",
  FUTURE_EVIDENCE: "FUTURE_EVIDENCE",
  EVIDENCE_SEQ_NOT_FOUND: "EVIDENCE_SEQ_NOT_FOUND",
  QUOTE_NOT_VERBATIM: "QUOTE_NOT_VERBATIM",
  // —— 五类已知失真 ——
  SUBJECT_MISMATCH: "SUBJECT_MISMATCH",
  UNSOURCED_NEGATIVE: "UNSOURCED_NEGATIVE",
  STALE_CURRENT: "STALE_CURRENT",
  ARGUMENT_AS_RESULT: "ARGUMENT_AS_RESULT",
  STATUS_OVERCLAIM: "STATUS_OVERCLAIM",
  // —— 叙事 ——
  NO_FACT_REFS: "NO_FACT_REFS",
  MISSING_FACT_REF: "MISSING_FACT_REF",
  CITED_REJECTED_FACT: "CITED_REJECTED_FACT",
  CITED_UNVERIFIED_FACT: "CITED_UNVERIFIED_FACT",
  // —— 开关 ——
  GUARD_DISABLED: "GUARD_DISABLED",
});

/**
 * 一句话交代边界：quote 命中只证明**字符串存在**。
 * 这条文案会被写进每一次裁决，避免「逐字命中」被读成「语义已证明」。
 */
export const ENTAILMENT_NOTE =
  "quote 逐字命中只证明证据事件里存在这段字符串；是否支持 claim 属于语义判断，冷代码不判定（entailmentProven 恒为 false）";

/* ───────────────────────────── 归一化与字面判据 ───────────────────────────── */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** 空白/零宽归一化（K-26 踩过 raw/norm 空白假阴性）。 */
export function normalizeText(value) {
  return String(value ?? "")
    .replace(ZERO_WIDTH, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * quote 是否在证据文本里**逐字**出现。
 *
 * 三种容忍（都来自 K-26 协议，不是放水）：
 *   · 空白归一化后比较（换行/多空格不算不逐字）；
 *   · 尾部省略号 ⇒ 按截断处理（`……` / `...` / `…`）；
 *   · 超过 120 字符 ⇒ 按前 120 字符比较（协议允许截断）。
 */
export function quoteFound(quote, eventText) {
  const q = normalizeText(quote);
  const text = normalizeText(eventText);
  if (q === "" || text === "") return false;
  if (text.includes(q)) return true;
  const stem = q.replace(/[.。…]+$/, "").trim();
  if (stem !== q && stem.length >= 8 && text.includes(stem)) return true;
  if (q.length > MAX_QUOTE_CHARS) {
    const head = q.slice(0, MAX_QUOTE_CHARS).trim();
    if (head.length >= 8 && text.includes(head)) return true;
  }
  return false;
}

/** 否定标记：claim 里有、而引文里一个都没有 ⇒ 无源负向断言。 */
const NEGATIVE_MARKERS = Object.freeze(["没有任何", "没有", "不存在", "未出现", "从未", "零命中", "0 命中", "未发现", "未复现"]);

/** 完成体标记：claim 声称「已经……」时，引文里必须也有一个。 */
const COMPLETED_MARKERS = Object.freeze(["已", "完成", "修好", "修复", "解决", "通过", "合入", "落地"]);

/** 意愿标记：引文只有「决定/将/要/计划」这类时，不能支撑完成体 claim。 */
const INTENT_MARKERS = Object.freeze(["决定", "将", "计划", "打算", "准备", "要", "需要", "待"]);

/** 当前态标记：claim 说「当前/现在/目前」时，要检查它之后有没有更新证据。 */
const CURRENT_MARKERS = Object.freeze(["当前", "现在", "目前", "此刻"]);

/** 变更标记：出现在 validAtSeq 之后的事件里 ⇒ 原节点的「当前」可能已过期。 */
const CHANGE_MARKERS = Object.freeze(["改了", "改成", "改为", "修好", "修复", "更新为", "成功", "重新", "已改", "生效"]);

/** 返回值标记：claim 说「X 返回 Y」。 */
const RETURN_MARKERS = Object.freeze(["返回", "return", "回传"]);

/** 引文里自己就写了返回/赋值 ⇒ 不是「实参当返回值」。 */
const RETURN_SIGNAL = Object.freeze(["返回", "return", "=>", "→", "⇒", "="]);

const hasAny = (text, markers) => markers.some((marker) => text.includes(marker));

/** 取 claim 里「返回 X」的 X（取不到返回 null）。 */
function returnedValueToken(claim) {
  const m = /(?:返回|returns?|回传)\s*([A-Za-z_$][\w$]*|true|false|-?\d+)/i.exec(claim);
  return m ? m[1] : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeq(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function unknownFields(object, whitelist) {
  return Object.keys(object).filter((key) => !whitelist.includes(key));
}

function reason(code, detail) {
  return { code, detail };
}

function maxSeqOf(events) {
  let max = 0;
  for (const event of events) if (isSeq(event?.seq) && event.seq > max) max = event.seq;
  return max;
}

function findEvent(events, seq) {
  return events.find((event) => event?.seq === seq) ?? null;
}

/* ───────────────────────────── 事实裁决 ───────────────────────────── */

function factVerdict(candidate, verdict, reasons, extra = {}) {
  return {
    id: typeof candidate?.id === "string" ? candidate.id : null,
    kind: typeof candidate?.kind === "string" ? candidate.kind : null,
    subject: typeof candidate?.subject === "string" ? candidate.subject : null,
    claim: typeof candidate?.claim === "string" ? candidate.claim : null,
    verdict,
    reasons,
    evidenceSeq: isSeq(candidate?.evidenceSeq) ? candidate.evidenceSeq : null,
    validAtSeq: isSeq(candidate?.validAtSeq) ? candidate.validAtSeq : extra.validAtSeq ?? null,
    quoteVerbatim: extra.quoteVerbatim === true,
    sourceRole: extra.sourceRole ?? null,
    // 恒 false：机械命中不宣称语义蕴含。
    entailmentProven: false,
  };
}

/**
 * 裁决**一条**事实候选。
 *
 * @param {object} candidate   FactCandidate
 * @param {{sessionId:string, events:Array<{seq:number, role:string, text:string}>}} source
 * @param {{seenIds?: Set<string>}} [state] 同批次判重用的 id 集合
 * @returns {object} 裁决（含 verdict / reasons / evidenceSeq / validAtSeq / quoteVerbatim / entailmentProven）
 */
export function evaluateFactCandidate(candidate, source, state = {}) {
  const seenIds = state.seenIds ?? new Set();
  const events = Array.isArray(source?.events) ? source.events : [];

  /* ① 结构 ------------------------------------------------------------- */
  if (!isPlainObject(candidate)) {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNSUPPORTED_SHAPE, "事实候选必须是对象")]);
  }
  const extra = unknownFields(candidate, FACT_FIELDS);
  if (extra.length > 0) {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNKNOWN_FIELD, `事实候选出现未知字段：${extra.join(", ")}`)]);
  }
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (id === "") return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_ID, "事实候选必须有非空 id（叙事靠它引用）")]);
  if (seenIds.has(id)) return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.DUPLICATE_ID, `事实 id 重复：${id}`)]);
  seenIds.add(id);
  if (!FACT_KINDS.includes(candidate.kind)) {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNKNOWN_KIND, `未知 kind：${String(candidate.kind)}（允许 ${FACT_KINDS.join("/")}）`)]);
  }
  if (typeof candidate.subject !== "string" || candidate.subject === "") {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_SUBJECT, `事实缺少 subject（允许 ${SUBJECTS.join("/")}）`)]);
  }
  if (!SUBJECTS.includes(candidate.subject)) {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_SUBJECT, `未知 subject：${candidate.subject}`)]);
  }
  const claim = typeof candidate.claim === "string" ? candidate.claim.trim() : "";
  if (claim === "") {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_CLAIM, "事实候选必须有非空 claim（一条原子事实）")]);
  }

  /* ② 时点 ------------------------------------------------------------- */
  const sessionEnd = maxSeqOf(events);
  let validAtSeq;
  if (candidate.validAtSeq === undefined) validAtSeq = sessionEnd;
  else if (isSeq(candidate.validAtSeq)) validAtSeq = candidate.validAtSeq;
  else {
    return factVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.INVALID_SEQ, `validAtSeq 必须是非负整数（收到 ${JSON.stringify(candidate.validAtSeq)}）`)]);
  }

  /* ③ 证据存在性：无证据只能 UNVERIFIED / PENDING ------------------------ */
  const quote = typeof candidate.quote === "string" ? candidate.quote : "";
  const hasEvidence = quote.trim() !== "" && candidate.evidenceSeq !== undefined;
  if (!hasEvidence) {
    const declared = candidate.status === VERDICT.PENDING ? VERDICT.PENDING : VERDICT.UNVERIFIED;
    const reasons = [reason(REASONS.NO_EVIDENCE, "缺 quote 或 evidenceSeq —— 没有可回证的证据")];
    // 无源负向断言：连证据都没有的否定句直接拒绝（K-26 第 ② 类）。
    if (hasAny(claim, NEGATIVE_MARKERS)) {
      return factVerdict(candidate, VERDICT.REJECTED, [
        reason(REASONS.UNSOURCED_NEGATIVE, "否定句没有任何引文来源"),
        ...reasons,
      ], { validAtSeq });
    }
    return factVerdict(candidate, declared, reasons, { validAtSeq });
  }

  /* ④ 跨会话 ----------------------------------------------------------- */
  if (candidate.evidenceSession !== undefined && candidate.evidenceSession !== source?.sessionId) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.CROSS_SESSION_SEQ, `evidenceSeq 指向另一个会话：${String(candidate.evidenceSession)} ≠ ${String(source?.sessionId)}`),
    ], { validAtSeq });
  }

  /* ⑤ seq 合法 + 未来证据 ---------------------------------------------- */
  if (!isSeq(candidate.evidenceSeq)) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.INVALID_SEQ, `evidenceSeq 必须是非负整数（收到 ${JSON.stringify(candidate.evidenceSeq)}）`),
    ], { validAtSeq });
  }
  if (candidate.evidenceSeq > validAtSeq) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.FUTURE_EVIDENCE, `证据 seq ${candidate.evidenceSeq} 晚于事实时点 validAtSeq ${validAtSeq}`),
    ], { validAtSeq });
  }

  /* ⑥ 证据事件存在 + 主体一致 ------------------------------------------ */
  const event = findEvent(events, candidate.evidenceSeq);
  if (event === null) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.EVIDENCE_SEQ_NOT_FOUND, `会话 ${String(source?.sessionId)} 里没有 seq=${candidate.evidenceSeq} 的事件`),
    ], { validAtSeq });
  }
  if (event.role !== candidate.subject) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.SUBJECT_MISMATCH, `claim 主体是 ${candidate.subject}，但 seq=${candidate.evidenceSeq} 的事件 role 是 ${String(event.role)}`),
    ], { validAtSeq, sourceRole: event.role ?? null });
  }

  /* ⑦ 引文逐字 --------------------------------------------------------- */
  if (!quoteFound(quote, event.text)) {
    return factVerdict(candidate, VERDICT.REJECTED, [
      reason(REASONS.QUOTE_NOT_VERBATIM, `quote 未在 seq=${candidate.evidenceSeq} 的事件里逐字出现：${quote.slice(0, 40)}`),
    ], { validAtSeq, sourceRole: event.role ?? null });
  }

  /* ⑧ 五类已知失真的机械判据 ------------------------------------------- */
  const quoteText = normalizeText(quote);
  const reasons = [];

  // ② 无源负向断言：claim 有否定标记，而引文里一个否定标记都没有。
  if (hasAny(claim, NEGATIVE_MARKERS) && !hasAny(quoteText, NEGATIVE_MARKERS)) {
    reasons.push(reason(REASONS.UNSOURCED_NEGATIVE, "claim 是否定句，但引文全是肯定表述"));
  }

  // ⑤ 状态过度声称：claim 是完成体，引文只有意愿。
  if (hasAny(claim, COMPLETED_MARKERS) && !hasAny(quoteText, COMPLETED_MARKERS) && hasAny(quoteText, INTENT_MARKERS)) {
    reasons.push(reason(REASONS.STATUS_OVERCLAIM, "claim 声称「已经……」，引文只到「决定/将/要」"));
  }

  // ③ 过期「当前」：claim 说当前态，且它之后有带变更标记的证据，而该证据里没有这段引文。
  if (hasAny(claim, CURRENT_MARKERS)) {
    const later = events.filter((e) => isSeq(e?.seq) && e.seq > validAtSeq && hasAny(normalizeText(e.text), CHANGE_MARKERS));
    const restated = later.some((e) => quoteFound(quote, e.text));
    if (later.length > 0 && !restated) {
      const seqs = later.map((e) => e.seq).join(",");
      reasons.push(reason(REASONS.STALE_CURRENT, `validAtSeq=${validAtSeq} 之后还有变更证据（seq ${seqs}），「当前」已过期`));
    }
  }

  // ④ 实参当返回值：claim 说「X 返回 Y」，引文里 Y 只出现在调用实参位置。
  const token = returnedValueToken(claim);
  if (token) {
    const asArgument = new RegExp(`[A-Za-z_$][\\w$.]*\\s*\\([^)]*${escapeRegExp(token)}[^)]*\\)`).test(quoteText);
    if (asArgument && !hasAny(quoteText, RETURN_SIGNAL)) {
      reasons.push(reason(REASONS.ARGUMENT_AS_RESULT, `claim 里的返回值 ${token} 在引文中只是调用实参`));
    }
  }

  return factVerdict(candidate, reasons.length > 0 ? VERDICT.REJECTED : VERDICT.SUPPORTED, reasons, {
    validAtSeq,
    quoteVerbatim: true,
    sourceRole: event.role ?? null,
  });
}

/* ───────────────────────────── 叙事裁决 ───────────────────────────── */

function narrativeVerdict(candidate, verdict, reasons, extra = {}) {
  return {
    id: typeof candidate?.id === "string" ? candidate.id : null,
    text: typeof candidate?.text === "string" ? candidate.text : null,
    factRefs: Array.isArray(candidate?.factRefs) ? [...candidate.factRefs] : [],
    verdict,
    reasons,
    citedFacts: extra.citedFacts ?? [],
    entailmentProven: false,
  };
}

/**
 * 裁决**一条**叙事候选：叙事只能引用事实 id，且被引用的事实必须是 SUPPORTED。
 *
 * 降级规则（任务书 §1）：
 *   · 引用了不存在的事实 id ⇒ REJECTED（MISSING_FACT_REF）
 *   · 引用了被拒事实       ⇒ REJECTED（CITED_REJECTED_FACT）
 *   · 引用了未验证/待补证事实 ⇒ UNVERIFIED（CITED_UNVERIFIED_FACT，**降级不拒绝**）
 *   · 一条事实都没引用     ⇒ UNVERIFIED（NO_FACT_REFS，不能当事实渲染）
 *   · 全部引用 SUPPORTED   ⇒ SUPPORTED（但 entailmentProven 仍恒为 false）
 *
 * @param {object} candidate NarrativeCandidate
 * @param {Map<string, object>} factVerdicts 事实 id → 裁决
 * @param {{seenIds?: Set<string>}} [state]
 * @returns {object}
 */
export function evaluateNarrativeCandidate(candidate, factVerdicts, state = {}) {
  const seenIds = state.seenIds ?? new Set();

  if (!isPlainObject(candidate)) {
    return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNSUPPORTED_SHAPE, "叙事候选必须是对象")]);
  }
  const extra = unknownFields(candidate, NARRATIVE_FIELDS);
  if (extra.length > 0) {
    return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNKNOWN_FIELD, `叙事候选出现未知字段：${extra.join(", ")}`)]);
  }
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (id === "") return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_ID, "叙事候选必须有非空 id")]);
  if (seenIds.has(id)) return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.DUPLICATE_ID, `叙事 id 重复：${id}`)]);
  seenIds.add(id);
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (text === "") return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.MISSING_TEXT, "叙事候选必须有非空 text")]);
  if (!Array.isArray(candidate.factRefs) || candidate.factRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    return narrativeVerdict(candidate, VERDICT.REJECTED, [reason(REASONS.UNSUPPORTED_SHAPE, "factRefs 必须是非空字符串组成的数组")]);
  }

  const refs = candidate.factRefs.map((ref) => ref.trim());
  if (refs.length === 0) {
    return narrativeVerdict(candidate, VERDICT.UNVERIFIED, [reason(REASONS.NO_FACT_REFS, "叙事没有引用任何事实 id —— 不能当事实渲染")]);
  }

  const citedFacts = [];
  const reasons = [];
  let hasRejected = false;
  let hasUnverified = false;
  for (const ref of refs) {
    const fact = factVerdicts.get(ref) ?? null;
    if (fact === null) {
      reasons.push(reason(REASONS.MISSING_FACT_REF, `叙事引用了不存在的事实 id：${ref}`));
      hasRejected = true;
      citedFacts.push({ id: ref, verdict: null });
      continue;
    }
    citedFacts.push({ id: ref, verdict: fact.verdict });
    if (fact.verdict === VERDICT.REJECTED) {
      reasons.push(reason(REASONS.CITED_REJECTED_FACT, `叙事引用了被拒事实 ${ref}`));
      hasRejected = true;
    } else if (fact.verdict !== VERDICT.SUPPORTED) {
      reasons.push(reason(REASONS.CITED_UNVERIFIED_FACT, `叙事引用了未验证事实 ${ref}（${fact.verdict}）⇒ 降级 UNVERIFIED`));
      hasUnverified = true;
    }
  }

  if (hasRejected) return narrativeVerdict(candidate, VERDICT.REJECTED, reasons, { citedFacts });
  if (hasUnverified) return narrativeVerdict(candidate, VERDICT.UNVERIFIED, reasons, { citedFacts });
  return narrativeVerdict(candidate, VERDICT.SUPPORTED, reasons, { citedFacts });
}

/* ───────────────────────────── 信封 ───────────────────────────── */

function emptySummary() {
  return {
    total: 0,
    supported: 0,
    unverified: 0,
    pending: 0,
    rejected: 0,
    narratives: { total: 0, supported: 0, unverified: 0, rejected: 0 },
    // 恒为 NOT_PROVEN：见 ENTAILMENT_NOTE。
    semanticEntailment: "NOT_PROVEN",
  };
}

function envelope(overrides = {}) {
  return {
    contract: CONTRACT,
    enabled: DEFAULT_ENABLED,
    applied: false,
    degraded: false,
    degradedReason: null,
    degradedDetail: null,
    disabledReason: null,
    sessionId: null,
    facts: [],
    narratives: [],
    summary: emptySummary(),
    ...overrides,
  };
}

function degraded(reasonCode, detail, base = {}) {
  return envelope({ ...base, applied: false, degraded: true, degradedReason: reasonCode, degradedDetail: detail });
}

function tally(factVerdicts, narrativeVerdicts) {
  const summary = emptySummary();
  summary.total = factVerdicts.length;
  for (const verdict of factVerdicts) {
    if (verdict.verdict === VERDICT.SUPPORTED) summary.supported += 1;
    else if (verdict.verdict === VERDICT.UNVERIFIED) summary.unverified += 1;
    else if (verdict.verdict === VERDICT.PENDING) summary.pending += 1;
    else summary.rejected += 1;
  }
  summary.narratives.total = narrativeVerdicts.length;
  for (const verdict of narrativeVerdicts) {
    if (verdict.verdict === VERDICT.SUPPORTED) summary.narratives.supported += 1;
    else if (verdict.verdict === VERDICT.UNVERIFIED) summary.narratives.unverified += 1;
    else summary.narratives.rejected += 1;
  }
  return summary;
}

/**
 * 守卫一整份模型输出（事实候选 + 叙事）。
 *
 * @param {string|object} raw 模型的结构化输出（JSON 字符串或已解析对象）
 * @param {{factGuard?: boolean, session?: {sessionId: string, events: Array<object>}}} [options]
 * @returns {object} 信封
 */
export function guardModelOutput(raw, options = {}) {
  const enabled = (options.factGuard ?? DEFAULT_ENABLED) === true;
  const source = options.session ?? null;

  /* 开关关掉：完全不碰输入（旧行为逐字不变由引擎侧保证，这里保证「零裁决」） */
  if (!enabled) {
    return envelope({ enabled: false, applied: false, disabledReason: REASONS.GUARD_DISABLED, sessionId: source?.sessionId ?? null });
  }
  if (!source || !Array.isArray(source.events)) {
    return degraded(REASONS.NO_SESSION_SOURCE, "守卫需要证据源（{sessionId, events}）才能回证 quote 与 seq", {
      enabled: true,
      sessionId: source?.sessionId ?? null,
    });
  }

  /* 解析 + 形状：不支持的输出必须显式 degraded，绝不静默当成「没有事实」 */
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return degraded(REASONS.BAD_JSON, `模型输出不是合法 JSON：${String(error?.message ?? error)}`, {
        enabled: true,
        sessionId: source.sessionId,
      });
    }
  }
  if (!isPlainObject(parsed)) {
    return degraded(REASONS.UNSUPPORTED_SHAPE, `模型输出必须是 {facts, narratives} 对象（收到 ${Array.isArray(parsed) ? "数组" : typeof parsed}）`, {
      enabled: true,
      sessionId: source.sessionId,
    });
  }
  const extraTop = unknownFields(parsed, ENVELOPE_FIELDS);
  if (extraTop.length > 0) {
    return degraded(REASONS.UNKNOWN_FIELD, `模型输出出现未知顶层字段：${extraTop.join(", ")}`, {
      enabled: true,
      sessionId: source.sessionId,
    });
  }
  if (!Array.isArray(parsed.facts) || !Array.isArray(parsed.narratives)) {
    return degraded(REASONS.UNSUPPORTED_SHAPE, "facts 与 narratives 都必须是数组", {
      enabled: true,
      sessionId: source.sessionId,
    });
  }

  /* 事实 → 叙事（叙事只能引用事实 id） */
  const factState = { seenIds: new Set() };
  const factVerdicts = parsed.facts.map((candidate) => evaluateFactCandidate(candidate, source, factState));
  const factMap = new Map(factVerdicts.map((verdict) => [verdict.id, verdict]));
  const narrativeState = { seenIds: new Set() };
  const narrativeVerdicts = parsed.narratives.map((candidate) => evaluateNarrativeCandidate(candidate, factMap, narrativeState));

  return envelope({
    enabled: true,
    applied: true,
    sessionId: source.sessionId,
    facts: factVerdicts,
    narratives: narrativeVerdicts,
    summary: tally(factVerdicts, narrativeVerdicts),
  });
}

/* ───────────────────────────── 契约自述 ───────────────────────────── */

/** 冻结的契约描述（AX-05/06/07/09 复用它，不要各自抄一份字段表）。 */
export function describeContract() {
  return Object.freeze({
    contract: CONTRACT,
    defaultEnabled: DEFAULT_ENABLED,
    maxQuoteChars: MAX_QUOTE_CHARS,
    verdicts: Object.values(VERDICT),
    factKinds: [...FACT_KINDS],
    subjects: [...SUBJECTS],
    factFields: [...FACT_FIELDS],
    narrativeFields: [...NARRATIVE_FIELDS],
    envelopeFields: [...ENVELOPE_FIELDS],
    reasons: Object.freeze({ ...REASONS }),
    entailmentNote: ENTAILMENT_NOTE,
  });
}
