/**
 * offline-fold.mjs —— **离线归档压缩**的共享实现（C495）
 *
 * 由来：这套逻辑先写在 `scripts/archive-fold.mjs` 里跑通了（C490–C494），
 * 但它最终应该由**插件进程**来跑 —— 那样才能直接用 `ctx.llm` 调 DSH 的默认模型，
 * 而不是脚本自己拼一个 HTTP 请求。
 *
 * 所以这里把**纯逻辑**搬进 `src/rooms/`：脚本和引擎共用同一份，
 * 避免"脚本修了、引擎没修"（这周已经栽过两次：单段/分段、账本/引擎）。
 */
import fs from "node:fs";
import path from "node:path";

/** CJK 判定（与 ledger 的字符分类同口径）。 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 把内容块拼成纯文本。
 * @param {unknown} content
 * @returns {string}
 */
export function plainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b !== null && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter((x) => x !== "")
    .join("\n");
}

/**
 * ★ C494：**用 DSH 的默认模型**，不是脚本自己挑一个。
 *
 * DSH 的默认模型写在 profile 的 `cordis.patch.yml` 里（条目 `agent-default-model`），我们照它来。
 *
 * 注意区分两件事，别混：
 *   · **模型**：这里解决 —— 读 profile 配置，拿 `agent-default-model.model`；
 *   · **可折区间**：离线要读日志才有 —— 归档后宿主的 session surface 已经没了，
 *     `compactIfNeeded` 拿不到区间（`no-foldable-span`），这跟用哪个模型无关。
 *
 * @param {string} home DSH_HOME
 * @returns {{provider:string|null, model:string|null, source:string}}
 */
export function readDefaultModel(home) {
  const profilesDir = path.join(String(home ?? ""), "profiles");
  let entries = [];
  try {
    entries = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { provider: null, model: null, source: "no-profiles" };
  }
  for (const name of entries) {
    const file = path.join(profilesDir, name, "cordis.patch.yml");
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let inBlock = false;
    let provider = null;
    let model = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^-\s*id:\s*agent-default-model/.test(trimmed)) {
        inBlock = true;
        continue;
      }
      if (inBlock && /^-\s*id:/.test(trimmed)) break;
      if (!inBlock) continue;
      const pm = /^\s*provider:\s*(.+)$/.exec(line);
      if (pm !== null) provider = pm[1].trim().replace(/^["']|["']$/g, "");
      const mm = /^\s*model:\s*(.+)$/.exec(line);
      if (mm !== null) model = mm[1].trim().replace(/^["']|["']$/g, "");
    }
    if (model !== null) return { provider, model, source: `profiles/${name}/cordis.patch.yml` };
  }
  return { provider: null, model: null, source: "agent-default-model-not-found" };
}

/**
 * 从会话事件里挑出「值得压」的消息：只取 user/assistant 的文本，**跳过工具结果**。
 *
 * 为什么跳过工具结果：`tool/result` 在真机上占上下文 12%–77%（中位 44.9%，见 C481），
 * 而其中 93%–100% 没有被任何失败边引用。整段塞进摘要请求既贵又稀释重点。
 *
 * @param {Array<object>} events
 * @param {{maxChars?:number, fromSeq?:number|null}} [options]
 * @returns {{messages:Array<{role:string,text:string,seq:number|null}>, chars:number, dropped:number}}
 */
export function collectMessages(events, { maxChars = 60_000, fromSeq = null } = {}) {
  const picked = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object") continue;
    if (e.type !== "user/message" && e.type !== "assistant/message") continue;
    // ★ C493：分段离线时**从头往后**取（`fromSeq` 之后），与"尾巴优先"是两种取法
    if (fromSeq !== null && !(Number(e.seq) >= fromSeq)) continue;
    const text = plainText(e.data?.message?.content ?? e.data?.content);
    if (text.trim() === "") continue;
    picked.push({ role: e.type === "user/message" ? "user" : "assistant", text, seq: Number(e.seq) || null });
  }
  if (fromSeq !== null) {
    const out = [];
    let chars = 0;
    let dropped = 0;
    for (let i = 0; i < picked.length; i += 1) {
      const m = picked[i];
      if (chars + m.text.length > maxChars) {
        dropped = picked.length - i;
        break;
      }
      out.push(m);
      chars += m.text.length;
    }
    return { messages: out, chars, dropped };
  }
  const out = [];
  let chars = 0;
  let dropped = 0;
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const m = picked[i];
    if (chars + m.text.length > maxChars) {
      dropped = i + 1;
      break;
    }
    out.push(m);
    chars += m.text.length;
  }
  out.reverse();
  return { messages: out, chars, dropped };
}

/**
 * ★ C491：从「消息预算」反推**实际覆盖的区间**，并算清前后两段没覆盖到多少。
 * @param {{rangeStart:number, rangeEnd:number, seqs:number[]}} input
 * @returns {{start:number, end:number, uncoveredHead:number, uncoveredTail:number}}
 */
export function coverageOf({ rangeStart, rangeEnd, seqs }) {
  const list = (Array.isArray(seqs) ? seqs : []).filter((x) => Number.isFinite(x));
  const coveredStart = list.length > 0 ? Math.min(...list) : rangeStart;
  const coveredEnd = list.length > 0 ? Math.max(...list) : rangeStart;
  const start = Math.max(rangeStart, Math.min(coveredStart, rangeEnd));
  const end = Math.max(start, Math.min(rangeEnd, coveredEnd));
  return { start, end, uncoveredHead: Math.max(0, start - rangeStart), uncoveredTail: Math.max(0, rangeEnd - end) };
}

/**
 * ★ C492：**离线摘要丢掉的约束，机械补回去。**
 *
 * 约束**不是摘要**，是硬性事实：丢掉它，后续模型就可能去动本来不许动的东西。
 * @param {string} text
 * @param {string[]} missing
 * @returns {{text:string, repaired:number}}
 */
export function repairMissingConstraints(text, missing) {
  const list = (Array.isArray(missing) ? missing : []).map((x) => String(x ?? "").trim()).filter((x) => x !== "");
  if (list.length === 0) return { text: String(text ?? ""), repaired: 0 };
  const body = String(text ?? "").replace(/\s+$/, "");
  const lines = ["", "## 约束（逐字补充 · 离线压缩后自动补回，不许删）"];
  for (const c of list) lines.push(`- ${c}`);
  return { text: `${body}\n${lines.join("\n")}`, repaired: list.length };
}

/**
 * 棋谱里出现过的全部约束原文（补回时要用**全量**，不能只看质量报告的前 5 条）。
 * @param {object} graph
 * @returns {string[]}
 */
export function allConstraints(graph) {
  return [...new Set(Object.values(graph?.nodes ?? {}).flatMap((n) => (Array.isArray(n?.constraints) ? n.constraints : [])))];
}

/**
 * 从棋谱渲染「硬事实块」（目标 / 约束 / 死路 / 已验证 / 坐标）—— 与在线折叠同一套事实。
 * @param {object} graph
 * @param {{start:number, end:number}} range
 * @returns {string}
 */
export function renderFacts(graph, range) {
  const nodes = Object.values(graph?.nodes ?? {});
  const edges = Object.values(graph?.edges ?? {});
  const lines = [];
  const root = (graph?.rootUserNodeIds ?? []).map((id) => graph?.nodes?.[id]).filter(Boolean)[0];
  lines.push("## 目标（不可改写）", `- ${String(root?.text ?? "(none)").split("\n")[0]}`);
  const constraints = allConstraints(graph).slice(0, 12);
  if (constraints.length > 0) {
    lines.push("", "## 约束（一条都不许丢）");
    for (const c of constraints) lines.push(`- ${c}`);
  }
  const failures = edges.filter((e) => e?.result === "failure");
  lines.push("", "## 已探明死路（不许重试）");
  if (failures.length === 0) lines.push("- (none)");
  for (const e of failures.slice(-40)) {
    const label = String(e.intent || e.action || "").slice(0, 80);
    const err = String(e.errorSnippet || e.verify?.summary || "-").split("\n")[0].slice(0, 80);
    lines.push(`- ${e.id} "${label}" → ${err} (seq ${e.evidence?.start ?? "?"}-${e.evidence?.end ?? "?"})`);
  }
  const ok = edges.filter((e) => e?.result === "success").slice(-10);
  if (ok.length > 0) {
    lines.push("", "## 已验证事实");
    for (const e of ok) lines.push(`- ${e.id} ${String(e.action ?? "").slice(0, 80)} → ${e.verify?.summary ?? "ok"}`);
  }
  lines.push("", "## 原始坐标", `- 本段遮蔽 seq ${range.start}-${range.end}；逐字原文在 DSH 会话日志中（seq 可定位）。`);
  return lines.join("\n");
}

/**
 * 拼离线摘要的输入（纯函数，便于单测）。
 * @param {{facts:string, messages:Array<{role:string,text:string}>}} input
 * @returns {string}
 */
export function buildOfflinePrompt({ facts, messages }) {
  const body = (messages ?? []).map((m) => `### ${m.role}\n${m.text}`).join("\n\n");
  return [
    "你在为一个**已经归档**的会话做摘要。这些消息不会再被对话模型看到，只会进我们的棋谱。",
    "",
    "# 硬事实（必须全部保留，禁止改写约束与死路）",
    facts,
    "",
    "# 原始消息（按时间顺序，工具结果已省略）",
    body,
    "",
    "# 输出要求",
    "- 只输出摘要正文，用二级标题分节：目标 / 棋谱（状态节点） / 已探明死路 / 已验证事实 / 未验证 / 当前节点与最近用户消息 / 原始坐标。",
    "- 引用实体只能引用上面出现过的 `n123` / `e456`；不确定就写 `n?`。",
    "- 不要写「下一步该做什么」这类行动建议。",
  ].join("\n");
}

/**
 * ★ C496：**离线折叠的编排**（一次或多次），逻辑与 HTTP 解耦。
 *
 * 为什么单独抽：真正要接进引擎时，模型调用必须走宿主的 `ctx.llm`（那才是 DSH 的默认模型、
 * 带用量与错误处理）。所以这里只依赖一个注入的 `callModel(prompt, {maxTokens})`，
 * 脚本用 HTTP 实现它，引擎将来用 `ctx.llm.stream` 实现它 —— **同一份编排，两种传输**。
 *
 * @param {object} args
 * @param {object} args.graph 棋谱（渲染硬事实用）
 * @param {Array<object>} args.events 会话事件（升序）
 * @param {number} args.rangeStart 欠账区间起点
 * @param {number} args.rangeEnd 欠账区间终点
 * @param {number} [args.maxChars] 每段消息预算
 * @param {number} [args.maxChunks] 最多几段（1 = 只压尾部）
 * @param {(prompt:string, opts:{maxTokens:number}) => Promise<{text:string, usage:object|null, model:string|null, finish?:string|null}>} args.callModel
 * @param {(args:{graph:object, range:{start:number,end:number}, summaryText:string}) => object} args.measureQuality
 * @returns {Promise<{chunks:Array<object>, coveredStart:number|null, coveredEnd:number|null, uncoveredHead:number, uncoveredTail:number}>}
 */
export async function runOfflineFold({
  graph,
  events,
  rangeStart,
  rangeEnd,
  maxChars = 60_000,
  maxChunks = 1,
  callModel,
  measureQuality,
}) {
  const chunks = [];
  const limit = Math.max(1, Number(maxChunks) || 1);
  let cursor = rangeStart;
  let coveredStart = null;
  let coveredEnd = null;
  for (let n = 1; n <= limit; n += 1) {
    if (rangeEnd < cursor) break;
    const chunkStart = cursor;
    const { messages, chars, dropped } = collectMessages(events, {
      maxChars,
      fromSeq: limit > 1 ? chunkStart : null,
    });
    if (messages.length === 0) break;
    const seqs = messages.map((m) => m.seq);
    const cov = coverageOf({ rangeStart: chunkStart, rangeEnd, seqs });
    const start = limit > 1 ? chunkStart : cov.start;
    const end = cov.end;
    const facts = renderFacts(graph, { start, end });
    const prompt = buildOfflinePrompt({ facts, messages });
    const startedAt = Date.now();
    const out = await callModel(prompt, { maxTokens: 4000 });
    let text = String(out?.text ?? "").trim();
    if (text === "") {
      return { chunks, coveredStart, coveredEnd, uncoveredHead: 0, uncoveredTail: Math.max(0, rangeEnd - (coveredEnd ?? rangeStart)), failed: "empty-response" };
    }
    // 约束补回：用**全量**缺失清单（质量报告只给前 5 条）
    const missing = allConstraints(graph).filter((c) => !text.includes(c));
    let repaired = 0;
    if (missing.length > 0) {
      const fixed = repairMissingConstraints(text, missing);
      text = fixed.text;
      repaired = fixed.repaired;
    }
    const quality = typeof measureQuality === "function" ? measureQuality({ graph, range: { start, end }, summaryText: text }) : null;
    chunks.push({
      start,
      end,
      messages: messages.length,
      chars,
      dropped,
      text,
      repaired,
      quality,
      usage: out?.usage ?? null,
      model: out?.model ?? null,
      ms: Date.now() - startedAt,
    });
    coveredStart = coveredStart === null ? start : Math.min(coveredStart, start);
    coveredEnd = coveredEnd === null ? end : Math.max(coveredEnd, end);
    cursor = end + 1;
    if (end >= rangeEnd) break;
  }
  const uncoveredHead = coveredStart === null ? 0 : Math.max(0, coveredStart - rangeStart);
  const uncoveredTail = coveredEnd === null ? Math.max(0, rangeEnd - rangeStart + 1) : Math.max(0, rangeEnd - coveredEnd);
  return { chunks, coveredStart, coveredEnd, uncoveredHead, uncoveredTail };
}

/**
 * ★ C499：**该不该走离线补折**（纯函数，便于单测）。
 *
 * 触发条件（缺一不可）：
 *   · 用户没关（`chess.offlineCloseout !== false`）；
 *   · 这一次收尾**没折成**，而且原因是"算不出可折区间"（`no-foldable-span`）——
 *     其它失败（超时/400/余额）走原路径，离线也救不了；
 *   · 会话尾巴还够长（`minEvents`）。
 *
 * @param {{closeout?:object|null, reason?:string|null, tailEvents?:number, enabled?:boolean, minEvents?:number}} args
 * @returns {{go:boolean, why:string}}
 */
export function shouldTryOfflineFold({ closeout, reason, tailEvents, enabled = true, minEvents = 40 } = {}) {
  if (enabled !== true) return { go: false, why: "disabled" };
  // 顺序有意义：**已经折过**先判（不管原因写着什么，都不该再花一次钱）
  if (closeout?.folded > 0) return { go: false, why: "already-folded" };
  const note = String(reason ?? closeout?.foldNote ?? "");
  // ★ C503：**「在线路径放弃了」都算触发条件**。
  //   这里原来只认 `no-foldable-span`，于是 C501 加的"超时也走离线"实际是**死代码** ——
  //   reason 传进来的是 `"timeout"`，永远不匹配。教训：加分支时先测那个分支的输入。
  const isGiveUp = note.includes("no-foldable-span") || note === "timeout" || note.includes("timeout");
  if (!isGiveUp) return { go: false, why: "not-a-giveup-reason" };
  if (!(Number(tailEvents) >= Number(minEvents))) return { go: false, why: "tail-too-short" };
  return { go: true, why: "no-foldable-span" };
}

/**
 * ★ C499：把离线编排的结果翻译成 `applyCloseoutOutcome` 认的形状。
 *
 * 关键：**有缺口就写 `partial`** —— 只压了尾部不能记成"全压过"（C476 那个坑的第四次变体）。
 * @param {{chunks:Array<object>, coveredStart:number|null, coveredEnd:number|null, uncoveredHead:number, uncoveredTail:number, failed?:string}} result
 * @param {{rangeStart:number, rangeEnd:number, maxSeq:number}} range
 * @returns {object}
 */
export function offlineFoldOutcome(result, { rangeStart, rangeEnd, maxSeq } = {}) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (chunks.length === 0) {
    return { tier: "offline", folded: 0, chunks: 0, stopped: result?.failed ?? "empty", error: null, partial: true };
  }
  const end = Number(result.coveredEnd);
  const tail = Number.isFinite(end) ? Math.max(0, Number(maxSeq ?? rangeEnd) - end) : Number(rangeEnd ?? 0);
  const head = Number(result.uncoveredHead) || 0;
  return {
    tier: "offline",
    folded: chunks.length,
    chunks: chunks.length,
    stopped: "done",
    error: null,
    partial: head > 0 || tail > 0,
    ...(head > 0 ? { uncoveredHead: head } : {}),
    ...(tail > 0 ? { uncoveredTail: tail } : {}),
  };
}

/**
 * ★ C502：把离线折叠**写回棋谱**（`foldMarks` + `closeout` + `lastOfflineSummary`）。
 *
 * 为什么单独抽：这段是"账怎么记"，与"活怎么干"（读日志、调模型）无关。
 * 抽出来就能**不依赖引擎/harness** 直接单测 —— 上一轮那条端到端测试卡在假 session 上，
 * 提示我们：把"记账"和"驱动"分开，才测得动。
 *
 * @param {object} graph 棋谱（会被就地修改）
 * @param {{chunks:Array<object>, coveredStart:number|null, coveredEnd:number|null, uncoveredHead?:number, uncoveredTail?:number}} result
 * @param {{rangeStart:number, rangeEnd:number, provider?:string|null, model?:string|null, now?:number}} meta
 * @returns {{marksAdded:number, partial:boolean}}
 */
export function applyOfflineFoldToGraph(graph, result, meta = {}) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const now = Number.isFinite(meta.now) ? meta.now : Date.now();
  if (chunks.length === 0) return { marksAdded: 0, partial: true };
  const graphRef = graph ?? {};
  graphRef.foldMarks = Array.isArray(graphRef.foldMarks) ? graphRef.foldMarks : [];
  for (const chunk of chunks) {
    graphRef.foldMarks.push({
      at: now,
      seqStart: chunk.start,
      seqEnd: chunk.end,
      trigger: "archive-offline",
      shadowedTokens: null,
      measuredBefore: null,
      route: { provider: meta.provider ?? "offline", model: chunk.model ?? meta.model ?? null },
      fallback: null,
      ms: chunk.ms ?? null,
      usage: chunk.usage ?? null,
      summaryChars: String(chunk.text ?? "").length,
      quality: chunk.quality ?? null,
      qualityRepaired: chunk.repaired ?? 0,
      offline: true,
    });
  }
  const last = chunks[chunks.length - 1];
  graphRef.lastOfflineSummary = { at: now, range: { start: last.start, end: last.end }, text: String(last.text ?? ""), model: last.model ?? meta.model ?? null };
  const uncoveredHead = Number(result?.uncoveredHead) || 0;
  const uncoveredTail = Number(result?.uncoveredTail) || 0;
  const partial = uncoveredHead > 0 || uncoveredTail > 0;
  const base = { ...(graphRef.closeout ?? {}) };
  delete base.foldNote;
  delete base.foldError;
  delete base.chunkStopped;
  graphRef.closeout = {
    ...base,
    at: now,
    source: "archive-offline",
    foldAttempted: true,
    folded: chunks.length,
    foldOffline: true,
    offlineCovered: { start: result.coveredStart ?? last.start, end: result.coveredEnd ?? last.end },
    ...(partial ? { partial: true } : {}),
    ...(uncoveredHead > 0 ? { offlineUncoveredHead: { events: uncoveredHead } } : {}),
    ...(uncoveredTail > 0 ? { offlineUncoveredTail: { events: uncoveredTail } } : {}),
  };
  return { marksAdded: chunks.length, partial };
}
