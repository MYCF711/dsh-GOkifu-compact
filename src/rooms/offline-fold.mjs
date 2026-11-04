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
import { sanitizeSummaryIds } from "./fold-quality.mjs";

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
/**
 * ★ C521：把一次工具调用压成**一行**（name + 关键参数），给摘要当"做过什么"的骨架。
 *
 * 为什么必须有：真机会话里 **95% 的 assistant 消息没有文本块**（4,728 条只有 287 条有 text），
 * 真正干活的记录在 `tool/call` 事件里（同一会话 4,509 次）。
 * 只喂 user/assistant 文本 ⇒ 摘要在讲"用户说了什么"，却不知道"agent 做了什么"。
 *
 * @param {{name?:string, arguments?:string}} data
 * @param {number} maxArgChars
 * @returns {string}
 */
export function toolDigestLine(data, maxArgChars = 80) {
  const name = String(data?.name ?? "").trim();
  if (name === "") return "";
  let args = data?.arguments;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      // 只挑最能说明意图的那个参数（按常见键顺序）
      const key = ["command", "file_path", "path", "pattern", "query", "url", "title", "prompt"].find((k) => typeof parsed?.[k] === "string");
      args = key === undefined ? args : `${key}=${parsed[key]}`;
    } catch {
      /* 不是 JSON 就原样用 */
    }
  } else if (args !== null && typeof args === "object") {
    args = Object.entries(args).slice(0, 2).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  }
  const raw = String(args ?? "").replace(/\s+/g, " ").trim();
  const cut = raw.length > maxArgChars;
  const body = cut ? `${raw.slice(0, maxArgChars)}…` : raw;
  return `→ ${name}(${body})`;
}

export function collectMessages(events, { maxChars = 60_000, fromSeq = null, toolShare = 0.4, perMessageChars = 2000, idBySeq = null } = {}) {
  // ★ C538：**把棋谱里的节点 id 一起喂进去**。以前消息不带 id，模型只能写 `n?`，
  //   而"引用要能回溯"正是这本棋谱的意义（真机 3a3fb03c：11 条状态节点全是 `n?`）。
  // ★ C538：**最近的节点**也算（消息大多落在两个节点之间）。只给"精确匹配"的加前缀时，
  //   模型看到的绝大多数字消息没有 id，于是照样写 `n?`（真机 3a3fb03c：11 条全是 n?）。
  const sorted = (() => {
    if (!(idBySeq instanceof Map)) return null;
    return [...idBySeq.entries()].filter(([seq, id]) => Number.isFinite(seq) && typeof id === "string" && id !== "").sort((a, b) => a[0] - b[0]);
  })();
  const nearestId = (seq) => {
    const target = Number(seq);
    if (!Number.isFinite(target) || sorted === null || sorted.length === 0) return null;
    let best = null;
    for (const [nodeSeq, id] of sorted) {
      if (nodeSeq > target) break;
      best = id;
    }
    return best ?? sorted[0][1];
  };
  const idOf = (seq) => {
    const id = idBySeq instanceof Map ? (idBySeq.get(Number(seq)) ?? nearestId(seq)) : idBySeq?.[Number(seq)];
    return typeof id === "string" && id !== "" ? id : null;
  };
  const withId = (seq, text) => {
    const id = idOf(seq);
    return id === null ? text : `[${id}] ${text}`;
  };
  const picked = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object") continue;
    if (e.type !== "user/message" && e.type !== "assistant/message") continue;
    // ★ C493：分段离线时**从头往后**取（`fromSeq` 之后），与"尾巴优先"是两种取法
    if (fromSeq !== null && !(Number(e.seq) >= fromSeq)) continue;
    const text = plainText(e.data?.message?.content ?? e.data?.content);
    if (text.trim() === "") continue;
    picked.push({ role: e.type === "user/message" ? "user" : "assistant", text: withId(e.seq, text), nodeId: idOf(e.seq), seq: Number(e.seq) || null });
  }
  // ★ C521：把工具调用也编进时间线（受 toolShare 预算约束），否则摘要只剩"用户说了什么"
  const toolLines = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object" || e.type !== "tool/call") continue;
    if (fromSeq !== null && !(Number(e.seq) >= fromSeq)) continue;
    const line = toolDigestLine(e.data);
    if (line !== "") toolLines.push({ role: "tool", text: withId(e.seq, line), nodeId: idOf(e.seq), seq: Number(e.seq) || null });
  }
  const merged = [...picked, ...toolLines].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  // ★ C521：**两份预算**。工具行最多占 toolShare（默认 40%），文本行吃剩下的 ——
  //   否则工具行会把"用户到底要什么"挤掉（测试里钉住了）。
  // 没有工具行时**不预留**工具预算（否则小预算下文本一条都放不进来 —— C490 那条就是这个形状）
  const hasTools = toolLines.length > 0;
  const toolCap = hasTools ? Math.max(0, Math.floor(maxChars * Math.max(0, Math.min(1, Number(toolShare) || 0)))) : 0;
  const textCap = Math.max(0, maxChars - toolCap);
  const out = [];
  let toolChars = 0;
  let textChars = 0;
  let dropped = 0;
  /** ★ C522：单条就超预算时**截断它**，而不是把后面所有内容一起放弃。
   *  真机 `8cc34e32` 开头就是一条两万字的大提示 —— 老逻辑下 head 模式只装进 1 条就 break，
   *  于是"补缺口"补了个寂寞（覆盖 8-11 四步）。 */
  const clamp = (len, room) => {
    if (room < 500) return null;
    const keepHead = Math.floor(room * 0.7);
    const keepTail = room - keepHead - 10;
    return { keepHead, keepTail, len };
  };
  const truncateFor = (m, room) => {
    const plan = clamp(m.text.length, room);
    if (plan === null) return null;
    const text = `${m.text.slice(0, plan.keepHead)}
…[本轮截断 ${m.text.length - plan.keepHead - Math.max(0, plan.keepTail)} 字符]…
${plan.keepTail > 0 ? m.text.slice(-plan.keepTail) : ""}`;
    return { ...m, text, truncated: true };
  };
  const take = (m) => {
    const cap = m.role === "tool" ? toolCap : textCap;
    const used = m.role === "tool" ? toolChars : textChars;
    let item = m;
    // ★ C522：**单条也设上限**（默认 2000 字符）。真机 8cc34e32 的头几条是两万字的大提示，
    //   不设上限时它们会把整个预算吃光，覆盖区间只有 seq 8-12（两万多个事件里的 4 步）。
    const perCap = m.role === "tool" ? 120 : Math.max(500, Number(perMessageChars) || 2000);
    if (item.text.length > perCap) {
      const cut = truncateFor(m, perCap);
      if (cut === null) return false;
      item = cut;
    }
    if (used + item.text.length > cap) {
      item = truncateFor(item, cap - used);
      if (item === null) return false;
    }
    if (m.role === "tool") toolChars += item.text.length;
    else textChars += item.text.length;
    out.push(item);
    return true;
  };
  // ★ C521/C522：**工具行超预算只是"这条不要"**（跳过继续）；文本行走 `take`（单条超预算会被截断）；
  //   只有当文本行连 500 字符都放不下时，才算真正到边界。
  if (fromSeq !== null) {
    for (let i = 0; i < merged.length; i += 1) {
      const m = merged[i];
      if (take(m)) continue;
      if (m.role === "tool") {
        dropped += 1;
        continue;
      }
      dropped = merged.length - i;
      break;
    }
  } else {
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const m = merged[i];
      if (take(m)) continue;
      if (m.role === "tool") {
        dropped += 1;
        continue;
      }
      dropped = i + 1;
      break;
    }
    out.reverse();
  }
  return { messages: out, chars: out.reduce((n, m) => n + m.text.length, 0), dropped };
}

/**
 * ★ C521：工具行只占**一部分**预算（默认 40%）—— 全塞工具等于把用户诉求挤掉。
 * 超了就**从最早的开始丢**（保留最近的：它们才是当前状态）。
 * @param {Array<{role:string,text:string}>} messages
 * @param {number} budgetChars
 */
function limitToolLines(messages, budgetChars) {
  let used = 0;
  for (const m of messages) if (m.role === "tool") used += m.text.length;
  if (used <= budgetChars) return;
  for (let i = 0; i < messages.length && used > budgetChars; i += 1) {
    if (messages[i].role !== "tool") continue;
    used -= messages[i].text.length;
    messages.splice(i, 1);
    i -= 1;
  }
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
/** ★ C533：事实块的硬上限（字符）。超过就截断并写明，不静默。 */
const MAX_FACTS_CHARS = 8000;

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
  // ★ C533：**事实块也要有上限**。`maxChars` 只管消息，事实块以前是无界的 ——
  //   病态数据（超长约束/死路行）会把 prompt 撑到几十万字符，模型直接 400 或超窗。
  const text = lines.join("\n");
  if (text.length <= MAX_FACTS_CHARS) return text;
  return `${text.slice(0, MAX_FACTS_CHARS)}${String.fromCharCode(10)}- …（事实块已截断：原 ${text.length} 字符，只保留前 ${MAX_FACTS_CHARS}）`;
}

/**
 * 拼离线摘要的输入（纯函数，便于单测）。
 * @param {{facts:string, messages:Array<{role:string,text:string}>}} input
 * @returns {string}
 */
/**
 * ★ C540：**建议篇幅按输入规模给**。固定「800–2500 字」在两端都不合适：
 *   · 输入 38k 字符时，2500 字是 15:1 压缩 —— 细节丢光；
 *   · 输入 4k 字符时，2500 字又是"扩写" —— 模型开始编。
 * 取「输入的 1/6」，夹在 600–3000 字之间。
 * @param {number} inputChars
 * @returns {{min:number, max:number}}
 */
export function suggestedLength(inputChars) {
  const chars = Number(inputChars);
  if (!Number.isFinite(chars) || chars <= 0) return { min: 600, max: 2500 };
  const target = Math.round(chars / 6);
  const max = Math.min(3000, Math.max(800, Math.round(target * 1.6)));
  const min = Math.max(400, Math.min(max - 200, Math.round(target * 0.6)));
  return { min, max };
}

export function buildOfflinePrompt({ facts, messages }) {
  const inputChars = (messages ?? []).reduce((n, m) => n + String(m?.text ?? "").length, 0) + String(facts ?? "").length;
  const len = suggestedLength(inputChars);
  // ★ C538：id **单独标在标题行** —— 混在正文里模型不认（真机连着 3 次全写 n?）。
  const body = (messages ?? []).map((m) => `### ${m.role}${typeof m.nodeId === "string" && m.nodeId !== "" ? ` · ${m.nodeId}` : ""}\n${m.text}`).join("\n\n");
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
    // ★ C537：**只列节点编号没用**。真机读摘要时发现「棋谱」只有 `n43 → n44 → …` 的链条，
    //   说不出每步**得出了什么**，读者还得回去翻原文 —— 那等于没压。
    "- 「棋谱」每一条都要写成「哪个节点 做了什么 → **得出了什么**」，一条一句；只写编号串不算。",
    "- 「当前节点」要说清：现在停在哪、手上还差什么、下一步的**已知约束**（不是建议）。",
    "- 引用实体只能引用上面出现过的 `n123` / `e456`。",
    // ★ C538：消息前缀就是答案 —— 但不说清楚模型宁可写 `n?`（真机 3a3fb03c 连着 3 次全是 n?）。
    "- **原始消息行首的 `[n123]` 就是那一步的棋谱 id**：写状态节点时**必须**用它，不许写 `n?`；"+"只有整条消息前面确实没有方括号时才写 `n?`。",
    "- 不要写「下一步该做什么」这类行动建议。",
    // ★ C533：**篇幅与诚实**。以前没写长度上限，模型一路写到 4000 token 撞顶被截断（真机 8cc34e32）。
    `- 篇幅 **${len.min}–${len.max} 字**（按输入规模算出来的）；宁可少写，不要为凑篇幅重复。`,
    "- 只能写上面出现过的事实；推不出来的不要写（**不许编造**）。遇到不确定的引用写 `n?`。",
    "- 结尾另起一节 `## 约束（逐字）`，把「硬事实」里的约束**原样**抄一遍（这是机读的，不是给人看的）。",
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
  // ★ C533：默认给 8192，不再 4000。真机实测：这个模型的 **reasoning 会吃掉 3816/4000**，
  //   正文只剩 184 token（715 字符）—— 摘要"看着成功"，其实只有半个骨架。
  maxTokens = 8192,
  /**
   * ★ C522：**从区间开头取**（而不是从尾巴）。补缺口时必须为 true ——
   *   否则"欠账区间 1-21543"永远只压最后那段，缺口原地不动。
   */
  fromHead = false,
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
    // ★ C538：seq → 节点 id（同一 seq 多个节点时取第一个；没有就留空）
    const idBySeq = (() => {
      const map = new Map();
      for (const node of Object.values(graph?.nodes ?? {})) {
        const seq = Number(node?.seq);
        const id = typeof node?.id === "string" ? node.id : typeof node?.id === "string" ? node.id : null;
        if (!Number.isFinite(seq) || id === null || map.has(seq)) continue;
        map.set(seq, id);
      }
      return map;
    })();
    const { messages, chars, dropped } = collectMessages(events, {
      maxChars,
      fromSeq: limit > 1 || fromHead === true ? chunkStart : null,
      idBySeq,
    });
    if (messages.length === 0) break;
    const seqs = messages.map((m) => m.seq);
    const cov = coverageOf({ rangeStart: chunkStart, rangeEnd, seqs });
    const start = limit > 1 ? chunkStart : cov.start;
    const end = cov.end;
    const facts = renderFacts(graph, { start, end });
    const prompt = buildOfflinePrompt({ facts, messages });
    const startedAt = Date.now();
    // ★ C540：**预算跟着输入长**。真机：13k 字符输入时 reasoning 就吃掉 6,936/8,192；
    //   38k 输入的思考只会更多 —— 固定 8192 会在大会话上再次"思考吃光"。
    //   口径：max(配置值, 输入字符/4)，夹到 [1024, 16384]。
    const fedChars = String(prompt ?? "").length;
    const budget = Math.max(1024, Math.min(16384, Math.max(Number(maxTokens) || 8192, Math.ceil(fedChars / 4))));
    let out = await callModel(prompt, { maxTokens: budget });
    // ★ C522：**被截断的摘要不能当完整**。真机 8cc34e32：completion_tokens 正好 4000（撞上限），
    //   摘要停在半句话上，后面的「已验证事实 / 未验证 / 原始坐标」全没了，而账上却记成成功。
    //   这里先放大 2× 重试一次；还截断就明确标 `truncated`，让 doctor/图能看见。
    const looksTruncated = (r) => {
      const used = Number(r?.usage?.completion_tokens ?? r?.usage?.outputTokens ?? NaN);
      if (String(r?.finish ?? r?.finishReason ?? "").toLowerCase().includes("max")) return true;
      if (Number.isFinite(used) && used >= budget) return true;
      // ★ C534：**没撞上限，也可能没写完**。真机 3a3fb03c：completion 4000 里 reasoning 3816，
      //   正文只有 184 token（715 字符）—— 低于上限，旧判据放过它，于是"成功"却只有骨架。
      //   判据：输入不小（>4000 字符）而正文过短（<400 字符）⇒ 当没写完，放大重试。
      const produced = String(r?.text ?? "").trim().length;
      const fed = String(prompt ?? "").length;
      if (fed > 4000 && produced < 400) return true;
      return false;
    };
    let truncated = looksTruncated(out);
    if (truncated) {
      try {
        const bigger = await callModel(prompt, { maxTokens: budget * 2 });
        if (!looksTruncated(bigger) && String(bigger?.text ?? "").trim() !== "") {
          out = bigger;
          truncated = false;
        }
      } catch {
        /* 重试失败就保留第一次的结果，并标记截断 */
      }
    }
    let text = String(out?.text ?? "").trim();
    if (text === "") {
      return { chunks, coveredStart, coveredEnd, uncoveredHead: 0, uncoveredTail: Math.max(0, rangeEnd - (coveredEnd ?? rangeStart)), failed: "empty-response" };
    }
    // ★ C505：**提示词挡不住的东西用代码挡**（C458 同一原则）。
    //   离线摘要的实体引用现在靠提示词约束；真机 5 条离线折叠恰好没编 id，
    //   但那是运气不是保证 —— 这里补上在线折叠早就有的 sanitize 兜底：
    //   折叠区间外 / 图里没有的 `n123`、`e456` 一律换成 `n?` / `e?`。
    const cleaned = sanitizeSummaryIds(text, graph, { start, end });
    text = cleaned.text;
    const sanitized = cleaned.removed.length;

    // 约束补回：用**全量**缺失清单（质量报告只给前 5 条）
    // ★ C522：判重要**忽略空白差异**。真机 8cc34e32：模型写的是「开启 superagent 模式」，
    //   原文是「开启superagent模式」—— 逐字比较判不出来，于是整段约束被重复补了一遍。
    const squeeze = (x) => String(x ?? "").replace(/\s+/g, "");
    const squeezedText = squeeze(text);
    const missing = allConstraints(graph).filter((c) => !squeezedText.includes(squeeze(c)));
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
      sanitized,
      truncated,
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
  // ★ C517：**第三种放弃理由：surface 供不上这段**。
  //   真机（2026-11-04 c460d468，归档后补账）：
  //     `foldError: "Error: compactRegion: start seq 496 not found in surface"`
  //   —— 归档/恢复之后宿主的 surface 里没有这些消息，在线折叠**永远折不了**。
  //   这正是离线补折存在的理由，可它只认前两种原因 ⇒ 白白失败。
  const surfaceMissing = /not found in surface|surface/i.test(note) && /compact|fold|region/i.test(note + " fold");
  const isGiveUp =
    note.includes("no-foldable-span") || note === "timeout" || note.includes("timeout") || surfaceMissing;
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
    // ★ C522：**缺口要带游标，而且要往前走**。只记 events 的话，下次还是从同一个起点开始，
    //   每次都在补同一段（真机 8cc34e32 就这样原地打转）。
    ...(() => {
      const prevGap = Number(meta?.previousGapEvents ?? NaN);
      const gapFrom = Number(meta?.rangeStart ?? 1) || 1;
      const covered = Math.max(0, Number(result?.coveredEnd ?? 0) - Number(result?.coveredStart ?? 0) + 1);
      // 有旧缺口 ⇒ 扣掉这次真压掉的事件，游标推到 coveredEnd+1
      const remaining = Number.isFinite(prevGap) && prevGap > 0 ? Math.max(0, prevGap - covered) : uncoveredHead;
      if (remaining <= 0) return {};
      const nextFrom = Number.isFinite(prevGap) && prevGap > 0 ? Math.max(gapFrom, Number(result?.coveredEnd ?? gapFrom) + 1) : gapFrom;
      return { offlineUncoveredHead: { events: remaining, from: nextFrom } };
    })(),
    ...(uncoveredTail > 0 ? { offlineUncoveredTail: { events: uncoveredTail } } : {}),
  };
  return { marksAdded: chunks.length, partial };
}
