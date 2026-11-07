/**
 * summary-prompt.mjs —— 棋谱摘要指令
 *
 * 与官方 compaction-basic 的差别（这是本插件的核心改造点之一）：
 *   官方：让模型从对话里「自己决定保留什么」→ 失败原因必然被当成噪音丢掉。
 *   本插件：把规则抽取的硬事实（根目标原话 / 约束 / 每条失败边 + 原因 + seq）
 *           作为 AUTHORITATIVE 输入塞进指令，模型只负责压缩表达与补写目标。
 *
 * 指令放在最后一条 user 消息里（不是单独 system），这样回放的前缀与真实请求
 * 逐字一致，提供方的 KV cache 能命中 —— 与官方实现同一策略。
 */

/**
 * 从 renderFacts 的文本里截取 CONSTRAINTS_VERBATIM 段。
 * 用途：摘要生成后**机械追加**到产物里 —— 不依赖模型遵守（实测 15 条失败边压力下模型会丢约束）。
 */
export function extractConstraintsBlock(facts) {
  const lines = String(facts ?? "").split("\n");
  const i = lines.findIndex((l) => l.trim() === "CONSTRAINTS_VERBATIM:");
  if (i < 0) return "";
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j].startsWith("* ")) out.push(lines[j].slice(2).trim());
    else break;
  }
  return out.join("\n");
}


export const CHESS_SUMMARY_OPEN = "<chess-fold>";
export const CHESS_SUMMARY_CLOSE = "</chess-fold>";

/* ═══════════════ AX-06：factGuard 的结构化产出契约（2026-11-07） ═══════════════
 *
 * 背景：K-26 证明「模型自由文本里的原子事实」不可回证（68 GOLD / 19 REJECTED / 5 PENDING）。
 * AX-06 让 hybrid 摘要**换一种产出形状**：模型不再写 Markdown 正文，而是产出
 * `{facts, narratives}` 两个数组 —— 事实候选带 subject/quote/evidenceSeq，叙事只能引用事实 id。
 * 冷代码（`fact-guard.mjs`）裁决通过后，才由本文件把这些候选**渲染成**摘要正文。
 *
 * 三条硬约束（对应任务卡）：
 *   ① 同一次模型调用：本文件只拼指令与渲染，**不调用模型**（零 import、零网络）。
 *   ② `factGuard` 关掉时本文件的输出**逐字不变**：所有新分支只在 `factGuard === true` 时执行。
 *   ③ 非法结构不许静默当成「没有事实」：由 `fact-guard.mjs` 出 `degraded:true + degradedReason`，
 *      引擎据此退回机械规则摘要（不把模型内容渲染成事实）。
 *
 * 依赖：**零**。本房间（R07）在 `test/rooms.test.mjs` 的 ROOMS 表里被钉成 `allowed: []`，
 * 所以裁决枚举只能以**字面镜像**出现在这里；单一来源仍是 `fact-guard.mjs` 的 `VERDICT`，
 * 两边一致性由 `test/engine-harness.test.mjs` 的对照断言钉住。
 */

/** `fact-guard.mjs` 的 `VERDICT` 字面镜像（本文件零 import，不能直接引用；有对照测试）。 */
export const GUARD_VERDICTS = Object.freeze(["SUPPORTED", "UNVERIFIED", "PENDING", "REJECTED"]);

/**
 * 值型事实段（AX-02 抽出 / AX-04 落边）。**只在 factGuard 开启时**拼进事实块。
 * 格式刻意短：一行一条，带 evidence seq；绝不复述整份工具结果。
 */
export function valueFactsBlock(valueFacts) {
  const rows = [];
  for (const fact of Array.isArray(valueFacts) ? valueFacts : []) {
    if (fact === null || typeof fact !== "object") continue;
    if (fact.value === undefined || fact.value === null) continue;
    const kind = String(fact.kind ?? "value");
    const value = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
    if (typeof value !== "string" || value === "") continue;
    const seq = Number.isSafeInteger(fact.evidenceSeq) ? fact.evidenceSeq : null;
    rows.push(`* ${kind}: ${value} (evidence seq ${seq === null ? "?" : seq})`);
  }
  if (rows.length === 0) return "";
  return [
    "VALUE_FACTS (extracted mechanically from successful tool results; each row is already backed by the evidence seq printed on it — cite that seq, never restate the whole tool output):",
    ...rows,
  ].join("\n");
}

/**
 * 事实块 + 值型事实段（**只在 factGuard 开启时**调用；关掉时事实块原样返回，
 * 所以 guard=false 的指令逐字等于旧版）。
 */
function withValueFacts(facts, valueFacts) {
  const block = valueFactsBlock(valueFacts);
  if (block === "") return facts;
  return `${String(facts ?? "")}\n\n${block}`;
}

/** factGuard 模式下的输出契约（JSON，一次模型调用；模型不写 Markdown 正文）。 */
const FACT_GUARD_CONTRACT = Object.freeze([
  "Output EXACTLY ONE JSON object and nothing else — no Markdown headings, no prose before or after, no code fences.",
  "",
  "{",
  '  "facts": [',
  '    { "id": "f1", "kind": "constraint|decision|state|failure|value|unverified", "subject": "user|assistant|tool|harness|system", "claim": "<one atomic sentence, checkable true or false>", "quote": "<fragment copied verbatim from the event at evidenceSeq>", "evidenceSeq": <seq>, "validAtSeq": <seq> }',
  "  ],",
  '  "narratives": [',
  '    { "id": "s1", "text": "<one or two lines of narrative>", "factRefs": ["f1"] }',
  "  ]",
  "}",
  "",
  "Rules that bind the JSON:",
  '- "facts" and "narratives" are the ONLY allowed top-level keys. Both are arrays; an empty array is valid.',
  "- id is non-empty and unique inside its array.",
  "- kind is one of: constraint | decision | state | failure | value | unverified. subject equals the role of the event at evidenceSeq: user | assistant | tool | harness | system.",
  "- evidenceSeq is one of the seq numbers of the folded segment above. quote appears verbatim in that event. A quote proves only that the string exists there, not that it supports the claim.",
  '- A claim with no quote and no evidenceSeq declares "status": "UNVERIFIED" (or "PENDING"); it is never rendered as a verified fact.',
  '- narratives[].factRefs names ids that exist in "facts". A narrative that cites no fact, or cites a rejected fact, is downgraded to UNVERIFIED or dropped before rendering.',
  "- A negation (没有任何 / 没有 / 不存在 / never / no hits) is admissible only when the quoted event itself carries that negation.",
  "- A decision to change something is not a change that already happened: completion words (已 / 完成 / 修复) are admissible only when the quoted event carries them.",
  "- A value is admissible only when the quoted event is the tool result that returned it; an argument passed into a call is not a returned value.",
]);

/** 供测试/诊断读取的契约（冻结副本，防止「契约是什么」变成口头约定）。 */
export function describeFactGuardPrompt() {
  return Object.freeze({
    verdicts: [...GUARD_VERDICTS],
    contract: [...FACT_GUARD_CONTRACT],
    valueFactsHeader: valueFactsBlock([{ kind: "value", value: "x", evidenceSeq: 0 }]).split("\n")[0],
  });
}

/**
 * factGuard 模式下「模型输出 → 结构化信封」的**抽取器**（纯字符串操作，不裁决）。
 *
 * 模型可能把 JSON 包在 ``` 围栏里、或在前后带一句废话 —— 这里只负责**找到那个对象**；
 * 「这个对象合不合法」由 `fact-guard.mjs` 判（坏 JSON / 顶层多字段 / 非数组都各自有 reason code）。
 * 抽不到任何 JSON ⇒ `{ok:false, reason:"BAD_JSON"}`，引擎会把**原文**交给守卫去出标准降级信封。
 *
 * @param {string} text 模型输出
 * @returns {{ok:true, value:unknown}|{ok:false, reason:string}}
 */
export function parseFactGuardEnvelope(text) {
  const body = String(text ?? "").trim();
  if (body === "") return { ok: false, reason: "EMPTY" };
  const candidates = [body];
  const fence = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of body.matchAll(fence)) {
    const inner = String(match[1] ?? "").trim();
    if (inner !== "") candidates.push(inner);
  }
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(body.slice(firstBrace, lastBrace + 1));

  let firstJson = null;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (firstJson === null) firstJson = parsed;
    if (isEnvelopeShaped(parsed)) return { ok: true, value: parsed };
  }
  // 解析成功但不是信封形状 ⇒ 原样交给守卫（它会给 UNSUPPORTED_SHAPE，比笼统的 BAD_JSON 精确）。
  if (firstJson !== null) return { ok: true, value: firstJson };
  return { ok: false, reason: "BAD_JSON" };
}

function isEnvelopeShaped(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.prototype.hasOwnProperty.call(value, "facts") || Object.prototype.hasOwnProperty.call(value, "narratives"))
  );
}

/** 一条裁决的 reason code 串（渲染「为什么它不算事实」）。 */
function reasonCodes(verdict) {
  const codes = (Array.isArray(verdict?.reasons) ? verdict.reasons : []).map((r) => String(r?.code ?? "")).filter((c) => c !== "");
  return codes.length > 0 ? codes.join(", ") : String(verdict?.verdict ?? "UNVERIFIED");
}

/** `（evidence seq N）` / `（缺 evidence seq）`。 */
function seqNote(fact) {
  return Number.isSafeInteger(fact?.evidenceSeq) ? `（evidence seq ${fact.evidenceSeq}）` : "（缺 evidence seq）";
}

/**
 * 把**已裁决**的信封渲染成摘要正文（只渲染通过的部分）。
 *
 * 渲染规则（每条都能被测试钉住）：
 *   · 只有 `verdict === "SUPPORTED"` 的事实进「已验证事实」以外的**事实段**（目标/棋谱/死路/已验证）；
 *   · `UNVERIFIED` / `PENDING` 的事实进「未验证」，**永不**出现在事实段；
 *   · `REJECTED` 的事实**整条丢弃**（连同引用它的叙事 —— 那条叙事也被守卫判成 REJECTED）；
 *   · 叙事单独成段（`## 叙事`），按 factRefs 回指事实 id —— 叙事本身**不是事实**；
 *   · 段名沿用旧模板（目标 / 棋谱 / 已探明死路 / 已验证事实 / 未验证 / 原始坐标），
 *     这样 `fold-quality` 的结构判据与 doctor 的口径都不变。
 *
 * @param {object} envelope `guardModelOutput()` 的信封（含 facts / narratives / summary）
 * @param {{range?:{start:number,end:number}|null}} [options]
 * @returns {{text:string, modelText:string, counts:object}}
 */
export function renderFactGuardedSummary(envelope, { range = null } = {}) {
  const facts = Array.isArray(envelope?.facts) ? envelope.facts : [];
  const narratives = Array.isArray(envelope?.narratives) ? envelope.narratives : [];
  const verified = facts.filter((fact) => fact?.verdict === GUARD_VERDICTS[0] && fact?.kind !== "unverified");
  const rejected = facts.filter((fact) => fact?.verdict === GUARD_VERDICTS[3]);
  const notVerified = facts.filter((fact) => !verified.includes(fact) && !rejected.includes(fact));
  const supportedNarratives = narratives.filter((item) => item?.verdict === GUARD_VERDICTS[0]);
  const openNarratives = narratives.filter((item) => item?.verdict !== GUARD_VERDICTS[0] && item?.verdict !== GUARD_VERDICTS[3]);

  const factLine = (fact) => `- [${String(fact?.id ?? "?")}] ${String(fact?.subject ?? "?")}: ${String(fact?.claim ?? "")}${seqNote(fact)}`;
  const goal = verified.filter((fact) => fact.kind === "constraint" || fact.kind === "decision");
  const states = verified.filter((fact) => fact.kind === "state");
  const failures = verified.filter((fact) => fact.kind === "failure");
  const values = verified.filter((fact) => fact.kind !== "constraint" && fact.kind !== "decision" && fact.kind !== "state" && fact.kind !== "failure");

  const lines = [];
  lines.push("## 目标");
  if (goal.length === 0) lines.push("- (none)");
  for (const fact of goal) lines.push(factLine(fact));
  lines.push("");
  lines.push("## 棋谱（状态节点）");
  if (states.length === 0) lines.push("- (none)");
  for (const fact of states) lines.push(factLine(fact));
  lines.push("");
  lines.push("## 已探明死路");
  if (failures.length === 0) lines.push("- (none)");
  for (const fact of failures) lines.push(factLine(fact));
  lines.push("");
  lines.push("## 已验证事实");
  if (values.length === 0) lines.push("- (none)");
  for (const fact of values) lines.push(factLine(fact));
  lines.push("");
  lines.push("## 未验证");
  if (notVerified.length === 0 && openNarratives.length === 0) lines.push("- (none)");
  for (const fact of notVerified) {
    lines.push(`- [${String(fact?.id ?? "?")}] ${String(fact?.claim ?? "")}（${String(fact?.verdict ?? "UNVERIFIED")}：${reasonCodes(fact)}）`);
  }
  for (const item of openNarratives) {
    lines.push(`- (叙事) ${String(item?.text ?? "")}（${String(item?.verdict ?? "UNVERIFIED")}：${reasonCodes(item)}）`);
  }
  lines.push("");
  lines.push("## 叙事");
  if (supportedNarratives.length === 0) lines.push("- (none)");
  for (const item of supportedNarratives) {
    const refs = (Array.isArray(item?.factRefs) ? item.factRefs : []).map((ref) => String(ref)).join(", ");
    lines.push(`- ${String(item?.text ?? "")}（引用事实：${refs}）`);
  }
  const modelText = lines.join("\n");
  lines.push("");
  lines.push("## 原始坐标");
  lines.push(`- 本段遮蔽 seq ${range?.start ?? "?"}-${range?.end ?? "?"}；逐字原文在 DSH 会话日志中（seq 可定位）。`);
  return {
    text: lines.join("\n"),
    modelText,
    counts: {
      facts: facts.length,
      supported: verified.length,
      unverified: notVerified.length,
      rejected: rejected.length,
      narratives: narratives.length,
      narrativesSupported: supportedNarratives.length,
      narrativesUnverified: openNarratives.length,
    },
  };
}

export function buildChessInstruction({
  facts,
  shadowedStart,
  shadowedEnd,
  priorFold = false,
  preGraph = false,
  factGuard = false,
  valueFacts = [],
}) {
  const guarded = factGuard === true;
  // ★ AX-06：值型事实段**只在** factGuard 开启时进事实块；关掉时这里是原来那个字符串引用。
  const factBlock = guarded ? withValueFacts(facts, valueFacts) : facts;
  const lines = [];
  lines.push(
    "You are the fold engine of a chess-record (棋谱) context system for an AI coding assistant. " +
      "Fold the conversation ABOVE into a compact record that lets another model resume the work with no loss of essential context.",
  );
  lines.push("");
  lines.push("The block below was extracted MECHANICALLY from the session log. It is authoritative.");
  lines.push("");
  lines.push(factBlock);
  lines.push("");
  if (preGraph) {
    // ★ C39：重启续跑的历史可能**早于棋谱**（C30 的 preGraph）。这段没有任何节点 id 可引用 ——
    //   明说这一点，避免模型给不存在的 nN 编号（幻觉探针 unknownIds 会把它抓出来）。
    lines.push(
      "NOTE: the folded segment predates the chess record, so it has NO node ids. Cite it by seq ranges only; " +
        "never introduce a node id that is not listed in the authoritative block above.",
    );
    lines.push("");
  }
  lines.push("Rules that bind your output:");
  lines.push("- ROOT_USER_REQUEST_VERBATIM and CONSTRAINTS_VERBATIM must be preserved word-for-word. Never paraphrase a constraint: the difference between 必须 and 最好 is a different task.");
  if (guarded) {
    // ★ AX-06：JSON 模式下没有「## 目标」段可抄，「N 条约束 ⇒ N 条事实」是同一道机械判据的换形。
    lines.push(
      "- Emit one fact with kind \"constraint\" for every CONSTRAINTS_VERBATIM bullet, quoting the bullet verbatim. " +
        "Count them: if the input lists N constraints, the JSON must contain N constraint facts. " +
        "实测：15 条失败边的压力下，模型曾把 3 条约束全丢 —— 约束丢失比失败边丢失更致命，因为它改变任务本身。",
    );
  } else {
    lines.push(
      "- COPY every CONSTRAINTS_VERBATIM bullet into your 「## 目标」 section **before** you write anything else. " +
        "Count them: if the input lists N constraints, your output must contain N bullets. " +
        "实测：15 条失败边的压力下，模型曾把 3 条约束全丢 —— 约束丢失比失败边丢失更致命，因为它改变任务本身。",
    );
  }
  lines.push("- If you must cut for length: cut narrative, cut pleasantries, cut redundant explanation — NEVER a constraint, NEVER a failed attempt.");
  if (guarded) {
    lines.push(
      "- Emit one fact with kind \"failure\" for every line under FAILED_ATTEMPTS, carrying its reason and evidence seq. " +
        "Never merge two dead ends into one fact, never drop one because it looks obsolete. They are why the next model will not walk into the same wall.",
    );
  } else {
    lines.push("- EVERY line under FAILED_ATTEMPTS must appear in your output — one line each, with its reason and evidence seq. Never merge two of them, never drop one because it looks obsolete. They are why the next model will not walk into the same wall.");
  }
  lines.push("- Never promote an UNVERIFIED_CLAIM to a verified fact. Only exit codes, test counts, diffs and explicit tool errors count as verification.");
  // ★ 真机（2026-11-07）：对话里出现「上下文已到 ~87%，后面我只报退出码」，而同一时刻
  //   宿主状态栏是 39%。根因不是模型算错，是**摘要把瞬时测量当事实存了下来**：
  //   历次折叠写进「压力 89% / 97% / 100%」「上下文压缩连续 4 次失败」，
  //   于是每一步注入（热清单 + 摘要）都在告诉下一个模型「你快满了」—— 而真实占用早就降下来了。
  //   瞬时量每步都在变，**只有宿主能给出当下值**；把它折进摘要 = 刻舟求剑，
  //   而且越折越吓人（连续失败次数会不断累积成一段恐怖叙事）。
  lines.push(
    "- NEVER carry a TRANSIENT MEASUREMENT into the summary: context-usage percentage (「压力 89%」「上下文已到 87%」), " +
      "remaining-token counts, TPS, cache-hit rate. They were true only for the instant they were observed; the next step " +
      "re-reads them from the host. A summary that says \"pressure 92%\" makes the next model believe a past instant is the " +
      "present — the exact opposite of what compression is for. Compress the WORK, not the gauge.",
  );
  // ★ 边界（boundary-audit 抓到过我的第一版）：只许写**输出格式**，不许解释「什么是事实」——
  //   那是 persona / AGENTS 的职责，压缩产物越界去教模型「怎么看待」就违反职责边界。
  lines.push(
    "- A compression failure is recorded as its raw error text only, with no gauge beside it: " +
      "write 「折叠失败：compactRegion: no open turn」, never 「折叠失败，压力 89%」.",
  );
  // ★ C455：**"别发明 id"这条规矩以前只在 preGraph 分支里出现** —— 常规折叠反而没写。
  //   而真机上确实有摘要写出「这次折叠时还不存在的 id」（doctor 的 outOfRangeLater，19 次，
  //   含 pressure 折叠；重渲染事实块确认那些 id 不在块里 ⇒ 不是我们喂的，是模型自己补的）。
  //   编号一旦进了 checkpoint，下一个模型就会拿它去查 —— 查不到，或者查到一个**未来**的状态。
  //   所以这条必须**无条件**出现，并且把"合法集合"说清楚：只能是上面那块里出现过的。
  lines.push(
    "- Cite ONLY ids that literally appear in the authoritative block above. Never guess, never continue a sequence " +
      "(n1, n2, n3 …). Never invent a node, an edge, a result, or a path. An id that is not in that block does not exist for you.",
  );
  lines.push("");
  if (guarded) {
    // ★ AX-06：guard 开启 ⇒ 产出形状换成 JSON 信封（facts + narratives），不再写 Markdown 正文。
    //   形状不对（坏 JSON / 缺数组 / 顶层多字段）由 `fact-guard.mjs` 显式 degraded，绝不静默放过。
    lines.push(...FACT_GUARD_CONTRACT);
  } else {
    lines.push("Output EXACTLY this Markdown structure. Keep every section, in order. Write \"(none)\" when empty — never drop a section.");
    lines.push("");
    lines.push("## 目标");
    lines.push("- <the user's current goal in 1-2 lines, then every constraint verbatim as its own bullet>");
    lines.push("");
    lines.push("## 棋谱（状态节点）");
    lines.push("- n<id> seq=<seq> 目标=<one line> 状态=<world8>/<constraint8>");
    lines.push("");
    // C47：标题只写事实（章节名）；「一条都不许丢」已在上面的规则里说过两遍，
    // 写进标题会随摘要**长期留在上下文里**，变成一条对后来模型的指令。
    lines.push("## 已探明死路");
    lines.push("- e<id> \"<intent>\" → <reason> (evidence seq <a-b>)");
    lines.push("");
    lines.push("## 已验证事实");
    lines.push("- <fact + the external signal that proves it: exit 0 / N tests passed / file path written>");
    lines.push("");
    lines.push("## 未验证");
    lines.push("- <claim + why it is unproven>");
    lines.push("");
    lines.push("## 当前节点与最近用户消息");
    lines.push("- 当前节点：n<id>（状态 <world8>/<constraint8>）");
    // ★ 边界（2026-11-01，见 docs/压缩的职责边界.md）：这里要**事实**，不要「下一步该做什么」。
    //   旧模板写的是 `- 下一步：<the single next action, ...>` —— 那会让摘要产出行动建议，
    //   而行动决策属于 AGENTS / persona / 模型自身；压缩产物只该回答「发生过什么、用户最后说了什么」。
    lines.push("- 最近一条用户消息（逐字摘录首行）：<verbatim first line of the latest user message>");
    lines.push("");
    lines.push("## 原始坐标");
    // ★ C64（专员审计 P0）：「需要时按 seq 回读」是**教模型何时恢复记忆**（职责边界 §2 明列禁止）。
    //   这里只陈述坐标事实（原文在哪、按什么可定位），何时回读由模型/AGENTS 决定。
    lines.push(`- 本段遮蔽 seq ${shadowedStart}-${shadowedEnd}；逐字原文在 DSH 会话日志中（seq 可定位）。`);
  }
  lines.push("");
  lines.push("Hard limits (a record over these limits counts as a failed fold):");
  // P1-9：旧文案「<1200 字符」与「每条失败边都必须出现」矛盾 —— 超过约 15 条死路就不可满足。
  lines.push(
    "- Length budget: about 40 characters per dead end plus 600 characters for everything else. " +
      "Never cut a dead end or a constraint to meet a length target — cut narrative instead.",
  );
  lines.push("- One line per dead end; no line longer than 120 characters.");
  lines.push("- No prose paragraphs. No restating the conversation. No section longer than 12 lines.");
  lines.push("");
  lines.push("Style:");
  lines.push("- Concise engineering prose. Narrative in Chinese; keep file paths, commands, error strings, identifiers, numbers and code fragments exactly as they appear.");
  lines.push("- Preserve user corrections faithfully — a correction outranks an earlier instruction.");
  lines.push("- Do NOT mention this summarization request, the compaction, or the checkpoint mechanism.");
  lines.push("- Output only the record text: do not call any tool, do not take any other action.");
  if (priorFold) {
    lines.push(
      `- The conversation above already contains a prior ${CHESS_SUMMARY_OPEN} record. Do NOT copy it verbatim: keep the lines that are still true (especially dead ends), drop what a newer fact supersedes, and merge newer information into one consolidated record under the same structure.`,
    );
  }
  return lines.join("\n");
}

