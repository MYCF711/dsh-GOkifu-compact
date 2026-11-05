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
import { evidenceSpan, isTruncatedFinish } from "./kifu-model.mjs";
import { failuresInFoldRange, mentionsEdge, sanitizeSummaryIds } from "./fold-quality.mjs";

/** CJK 判定（与 ledger 的字符分类同口径）。 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * ★ C647：**停止原因协议表**（`stopped` 的闭集 —— 全仓唯一登记处）。
 *
 * 由来（真机 2026-11-05，`node scripts/backfill-idle-audit.mjs` 原样输出）：欠账清零之后
 * `runOfflineFold` 拿到的是**空区间**（`rangeStart > rangeEnd`），于是它一条 chunk 都不产出、
 * 也不带 `failed`，`offlineFoldOutcome` 落到 `result?.failed ?? "empty"` ⇒ 状态文件里出现
 * 取值 `"empty"`；模型交空回答那条路写的是 `"empty-response"`。
 * **这两个值从来没在任何协议表里登记过**：`test/fold-protocol.test.mjs` 只抓「`stopped` 后跟一个
 * 字符串字面量」这种写法，而 `??` 右侧那个字面量按构造抓不到 ⇒「没登记」在测试里是隐形的。
 *
 * 为什么必须登记：`stopped` 是**跨进程**的（引擎 → `auto-backfill-state.json` → doctor/checkup/面板），
 * 下游只能靠这张表判断「这个结局算不算放弃」。表外的值 = 下游 quietly 当它不存在。
 *
 * 判据（由 `test/backfill-idle.test.mjs` 钉住）：源码里**任何** `stopped` 取值
 * （字面量或 `STOPPED_*` 常量）都必须在这张表里；新增取值先在这里写清语义，否则测试红。
 */
export const STOPPED_REASONS = Object.freeze({
  // 分段折叠（closeout-plan.mjs）
  deadline: "预算用尽（已折的段保留）",
  "no-op": "调用了但什么都没变（这一种必须转离线）",
  error: "折叠抛错（看错误内容决定）",
  done: "正常折完",
  // 离线补折（engine.mjs）
  busy: "同一会话已有人在补（同一轮不重复挑）",
  "no-log": "找不到会话日志",
  "empty-log": "日志为空",
  "no-range": "没有可折区间",
  "no-model": "拿不到模型",
  "inactive-context": "后台定时器拿不到宿主服务（等活跃回合）",
  // 离线编排（本文件）
  "empty-response": "模型交了空回答（不许写半截账）",
  empty: "区间为空 / 一条消息都没装下（零欠账时的正常结局）",
});

/** 正常折完。 */
export const STOPPED_DONE = "done";
/** 到点收工（已折的段照常写回）。 */
export const STOPPED_DEADLINE = "deadline";
/** 区间为空 —— 零欠账时 `runOfflineFold` 的真实结局。 */
export const STOPPED_EMPTY = "empty";
/** 模型交了空回答。 */
export const STOPPED_EMPTY_RESPONSE = "empty-response";

/**
 * 这个停止原因登记过吗（`stopped` 的闭集判据，纯函数）。
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isKnownStopped(reason) {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(STOPPED_REASONS, reason);
}

/**
 * ★ C639：reasoning 块里**值得占用摘要预算**的句子（结论句启发式，闭集）。
 *
 * 由来（真机 2026-11-05，`node scripts/reasoning-share-audit.mjs` 原样输出；718 条 foldMark 重放、
 * 221 个会话）：折叠区间内的字符构成是 `assistant:reasoning` **63.8%** / `<system-reminder>` 样板 16.5% /
 * 真实用户输入 14.5% / assistant 正文 5.2% —— 也就是说摘要的输入预算**有 63% 花在模型自己的草稿纸**上，
 * 而折叠要回答的是「区间里发生了什么」。
 *
 * 重放 `collectMessages`（maxChars=60,000、perMessageChars=2,000、fromSeq=seqStart，与生产同参）：
 *   · 装下的**真实事件** 10.61 → 15.47 条/段（**+45.9%**）；
 *   · 真实字符 19,487 → 26,533（**+36.2%**）；
 *   · 区间真实事件覆盖率 55.2% → **75.2%**（+20.0pp）；
 *   · 输入字符总量几乎不动（40,044 → 40,304）—— 换的是**构成**，不是变贵。
 *
 * 但**不能一刀切**：reasoning 里确实有"只有这里说过"的结论（"这条死路别再试"）。
 * 真机统计：结论句占 reasoning 字符的 **1.91%**（15,515 / 989,791 句），
 * 其中"非 reasoning 的输入里找不到同 8-gram"的只占 reasoning 字符的 **0.72%** —— 便宜，留着。
 *
 * 判据刻意只认**高信号**句式（死路 / 已验证 / 根因 / 别再试 / do not retry），
 * 不认"因为 / 所以 / 必须"这类连接词：宽口径实测会捞回 **7.5%** 的 reasoning 字符，等于没剔。
 */
export const REASONING_CONCLUSION_RE =
  /不要|别再|勿|禁止|不许|严禁|不可|死路|走不通|行不通|证伪|已验证|已确认|结论|根因|注意|当心|坑|失败|报错|错误|do not retry|don't retry|never retry|must not|dead end|already verified|root cause|the bug is|the fix is|keep in mind|gotcha|the trap/i;

/** 「思考摘录」的可见标记 —— 摘要里必须能分辨**这句话不是 assistant 说的**。 */
export const THINKING_EXCERPT_MARK = "（思考摘录）";

/** 单条消息保留的思考摘录上限（字符）。真机 p99 = 728、max = 4,324（病态数据），超过就截断留痕。 */
export const REASONING_CONCLUSION_MAX_CHARS = 800;

/**
 * 把 reasoning 文本切成句子（CJK 句末 / 英文「句号 + 空白」/ 换行）。
 * 为什么不能直接按 `.` 切：路径与文件名（`ledger.mjs`、`0.6`）会被切碎。
 * @param {string} text
 * @returns {string[]}
 */
export function reasoningSentences(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    for (const part of line.split(/(?<=[。；！？!?])|(?<=\.)\s+/)) {
      const sentence = part.trim();
      if (sentence !== "") out.push(sentence);
    }
  }
  return out;
}

/**
 * reasoning 文本 → **只保留结论句**的摘录（空串 = 这条思考没有值得留的东西）。
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function reasoningConclusionText(text, maxChars = REASONING_CONCLUSION_MAX_CHARS) {
  const kept = reasoningSentences(text).filter((sentence) => REASONING_CONCLUSION_RE.test(sentence));
  if (kept.length === 0) return "";
  const joined = kept.join(" ");
  const cap = Math.max(0, Number(maxChars) || 0);
  if (cap === 0 || joined.length <= cap) return joined;
  return `${joined.slice(0, cap)}…`;
}

/**
 * ★ T38：**宿主注入的角色说明**（闭集 —— 全仓唯一登记处）。
 *
 * 由来（真机 2026-11-05，`node scripts/prompt-bleed-audit.mjs` 原样输出）：
 *   有正文的摘要 392 条，含系统提示词标记的 11 条，其中**逐字**回灌的 1 条
 *   （`session-f7f835b1`：13,210 字符里 4,750 = **36.0%** 是系统提示词）。
 *   回灌全部落在摘要的「约束」段 —— 因为摘要 prompt 要求「把硬事实里的约束原样抄一遍」，
 *   而硬事实块里的约束**本身**就带着系统提示词（见下面的证据链）。
 *
 * 为什么只认**显式标记**、不认「像系统提示词的句子」：
 *   · 用户会把 system prompt 整段粘进对话（真实内容）—— 按内容判会**误伤**，那是把用户的
 *     任务书删掉，比回灌更严重（`test/prompt-bleed.test.mjs` ③ 钉住了这一条）；
 *   · 宿主注入的两类东西**自带首尾标记**，机械切除既精确又可审计；
 *   · 未闭合的开标签**不动**：宁可留着，也不吃掉用户后文（④ 钉住了这一条）。
 *
 * 剔除的是**注入外壳**，不是「系统提示词这个词」：`<compacted-summary>`（上一条摘要 = checkpoint）
 * 与 `system/message` 事件都不在这个清单里 —— 前者是真实历史（剔了会把上一条摘要的棋谱段一起删掉），
 * 后者 `collectMessages` 本来就跳过。
 */
export const HOST_ROLE_SPANS = Object.freeze([
  { id: "system-reminder", re: /<system-reminder>[\s\S]*?<\/system-reminder>/gi },
  { id: "sovereign", re: /\[用户启用[^\]]*用户主权声明\][\s\S]*?\[END:\s*SOVEREIGN DECLARATION\]/g },
]);

/**
 * ★ T38：把**宿主注入的角色说明**从一段文本里剔掉（纯字符串，不改别的）。
 *
 * 语义：删掉 `HOST_ROLE_SPANS` 命中的整段，并把留下的空行收敛（否则剔除后剩一堆空行，
 * 照样吃预算）。**没有命中就逐字返回**（`stripHostRoleText(x) === x`），这是「不误伤」的判据。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function stripHostRoleText(text) {
  let out = String(text ?? "");
  let changed = false;
  for (const span of HOST_ROLE_SPANS) {
    const next = out.replace(span.re, "\n");
    if (next !== out) {
      out = next;
      changed = true;
    }
  }
  if (!changed) return out;
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把内容块拼成纯文本。
 *
 * ★ C639：`reasoning` 块**默认保留**（`message-size-audit` 之类要的是"这条消息的全部文本"）；
 * 摘要输入在 `collectMessages` 里显式传 `{ reasoning: "conclude" }` —— 只留结论句（理由见上）。
 *
 * ★ T38：`hostRole` 同理 —— **默认 `keep`**（审计脚本按「这条消息的全部文本」拆账，
 * 默认就剔会让 `message-size-audit` / `reasoning-share-audit` 的数字与生产悄悄分叉）；
 * `collectMessages` 显式传 `{ hostRole: "strip" }`。
 *
 * @param {unknown} content
 * @param {{reasoning?: "keep"|"drop"|"conclude", hostRole?: "keep"|"strip"}} [options] `keep` = 老行为；
 *   `drop` = 整块丢掉；`conclude` = 只留结论句（带 `（思考摘录）` 标记）；
 *   `hostRole` 的 `strip` = 剔掉宿主注入的角色说明（见 `HOST_ROLE_SPANS`）。
 * @returns {string}
 */
export function plainText(content, { reasoning = "keep", hostRole = "keep" } = {}) {
  const strip = (text) => (hostRole === "strip" ? stripHostRoleText(text) : text);
  if (typeof content === "string") return strip(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b === null || typeof b !== "object" || typeof b.text !== "string" || b.text === "") continue;
    if (reasoning !== "keep" && b.type === "reasoning") {
      if (reasoning === "drop") continue;
      const conclusions = reasoningConclusionText(b.text);
      if (conclusions !== "") parts.push(`${THINKING_EXCERPT_MARK}${conclusions}`);
      continue;
    }
    parts.push(b.text);
  }
  return strip(parts.join("\n"));
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
 * @param {{maxChars?:number, fromSeq?:number|null, toolShare?:number, perMessageChars?:number, idBySeq?:Map<number,string>|null}} [options]
 *   `perMessageChars` = **单条消息正文上限**（默认 2000；低于 500 一律按 500 夹取）。
 *   为什么是 2000 而不是更大：见 `take()` 里 C612 的实测（`scripts/message-size-audit.mjs`）。
 * @returns {{messages:Array<{role:string,text:string,seq:number|null}>, chars:number, dropped:number, inputCutMessages:number, inputTruncated:boolean}}
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
    // ★ C639：**摘要输入只取「发生了什么」** —— reasoning 块（模型自己的草稿纸）占折叠区间字符的 63.8%，
    //   剔掉后同样预算能多装 45.9% 的真实事件（覆盖率 55.2% → 75.2%）。
    //   但**不整块丢**：只留结论句（`REASONING_CONCLUSION_RE`），因为"这条死路别再试"这类话常常只在思考里说。
    //   原样输出与判据见 `scripts/reasoning-share-audit.mjs`。
    // ★ T38：**宿主注入的角色说明也不进输入**（`<system-reminder>` 块 / SOVEREIGN 声明）。
    //   真机每段 2,000+ 字符的 workspace 指令与技能目录，与「这个区间发生了什么」无关；
    //   而且它们是**回灌的载体之一**（`scripts/prompt-bleed-audit.mjs` ④：prompt 25,429 字符里
    //   4,015 是这两类注入）。判据与误伤边界见 `HOST_ROLE_SPANS` / `stripHostRoleText`。
    const text = plainText(e.data?.message?.content ?? e.data?.content, { reasoning: "conclude", hostRole: "strip" });
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
    //
    // ★ C612：**2000 经真机审计后保留，别再往大改**（`scripts/message-size-audit.mjs` 原样输出；
    //   2026-11-05 快照：52,503 条消息 / 79.9M 字符、639 条 foldMark 重放、188 个会话日志）。
    //     · 分布：p50 791 / p90 3,283 / p95 5,008 / p99 14,317 / max 251,157 ⇒ 2000 只切 18.9% 的消息；
    //     · **切掉的 90.2% 是脚手架**：assistant 的 `reasoning` 块 56.6%（模型的内部思考）
    //       + `<system-reminder>` 样板 33.6%（每轮重复的 workspace 指令）；真实用户输入只占 7.2%、
    //       assistant 正文 2.6%。「长的是工具输出」**证伪**：`tool/result` 69,489 条（92.8M 字符）
    //       **一条都不进输入**（C481），`tool/call` 摘要行另有固定 120 字符上限，与这个旋钮无关。
    //     · **放宽不涨输入**：区间文本覆盖率 31.1%(2000) → 31.7%(4000) → 32.0%(8000)，
    //       因为总量卡在 `maxChars`（60,000 × 0.6 = 36,000 字符文本预算 —— 实测只覆盖 31%）。
    //       同样的 36,000 字符：2000 铺给 38.7 条消息，8000 只铺给 28.2 条（−27.2%），
    //       工具行 51.9 → 37.5（−27.8%）。**摘要要的是"区间里发生了什么"，少看 27% 的事件
    //       比少看每条消息的中段更亏**（截断还保留头 70% + 尾 30%，结论在尾部）。
    //     · 成本不增反降（8000 档 −1,008 字符/段 ≈ −343 token/段 ≈ −$0.010/日，低峰），
    //       所以"省钱"不是留着 2000 的理由，**"少看事件"才是**。
    //     · 要让摘要真多看东西，该动的是 `maxChars` 而不是这个单条上限：
    //       60,000 → 120,000 = +12,243 token/段 ≈ +$0.36/日（低峰）/ +$0.71/日（高峰）。
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
  // ★ C610：**输入侧裁切**聚合出来 —— 整条没放进去（`dropped`）与单条正文被切（`truncated: true`）都算。
  //   它答的是"模型看没看全"，与响应侧 `looksTruncated`（"模型写没写完"）是两件事，别混成一个字段。
  const inputCutMessages = out.filter((m) => m.truncated === true).length;
  return { messages: out, chars: out.reduce((n, m) => n + m.text.length, 0), dropped, inputCutMessages, inputTruncated: dropped > 0 || inputCutMessages > 0 };
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
 *
 * ★ T37：**消息整体落在欠账区间之外时，不许把区间夹成一点**。
 *
 * 由来（真机，`node scripts/degenerate-range-audit.mjs` 原样输出；125 条退化折痕 / 115 会话）：
 *   107 条折痕的区间是 `seq 8-8` / `9-9` / `11-11` 这种单点，而**区间里一条 user/assistant 消息都没有**
 *   （`区间内消息 0`），日志却有 500–1500 个事件、摘要 6000+ 字符 —— 也就是模型看的是整个会话。
 *
 * 机制（就是下面那两行 `Math.min/Math.max`）：
 *   · 上一段折叠留下**前缀缺口** `offlineUncoveredHead = {events: 8, from: 1}`（`uncoveredHead = start - rangeStart`）；
 *   · 下一段把欠账区间算成 `[1, 8]`，而第一条消息在 seq 9 ⇒ `coveredStart (9) > rangeEnd (8)`；
 *   · `Math.min(coveredStart, rangeEnd)` 把起点**压到 rangeEnd** ⇒ `start = end = 8`；
 *   · `fromHead` 式的取消息（C522：「补缺口必须从头取」）**不设上界**，于是 prompt 里是整段 9–501，
 *     账上只记 1 个事件。T35 的「未来」界（`span.end <= range.end` 的最后一个实体）因此取不到，
 *     全篇 `nN` 被抹成 `n?`（真机零锚点摘要 p50 锚点 = 0，正常区间 = 30）。
 *
 * 判据（只在这一种形状上改）：
 *   收集到的消息跨度与欠账区间**不相交**（`coveredEnd < rangeStart` 或 `coveredStart > rangeEnd`）
 *   ⇒ 夹出来的那个「区间」里什么都没有，是**账上的虚构**；此时如实报**真正被折的那一段**
 *   （`[coveredStart, coveredEnd]`），缺口按 `rangeStart/rangeEnd` 照旧算。
 *   消息跨度与欠账区间有交集时**一个字都不改** —— C491 的夹取契约（「宣称不超过欠账区间」）原样保留。
 *
 * 为什么不改「取消息」那一侧（给 head 模式加上界）：那会让 prompt 少看区间外的消息（实测摘要质量
 * 与正常区间持平：字符 p50 6225 vs 6243、constraintRecall/failureRecall 都 = 1），
 * 而且尾部要再折一次 = 再付一次模型钱。**错的是账，不是模型看到的输入。**
 *
 * @param {{rangeStart:number, rangeEnd:number, seqs:number[]}} input
 * @returns {{start:number, end:number, uncoveredHead:number, uncoveredTail:number}}
 */
export function coverageOf({ rangeStart, rangeEnd, seqs }) {
  const list = (Array.isArray(seqs) ? seqs : []).filter((x) => Number.isFinite(x));
  const coveredStart = list.length > 0 ? Math.min(...list) : rangeStart;
  const coveredEnd = list.length > 0 ? Math.max(...list) : rangeStart;
  // ★ T37：**欠账区间里一条消息都没收到** ⇒ 报实际跨度，别夹成一点（见上方 docblock）。
  //   注意 `[50, 999] @ 100..200` 这种「跨度包住区间」的夹取照旧走下面 —— 那时 `Math.min/Math.max`
  //   夹出来的是**有依据的**（区间本身被覆盖了），不是这里要修的退化。
  if (list.length > 0 && (coveredEnd < rangeStart || coveredStart > rangeEnd)) {
    return {
      start: coveredStart,
      end: coveredEnd,
      uncoveredHead: Math.max(0, coveredStart - rangeStart),
      uncoveredTail: Math.max(0, rangeEnd - coveredEnd),
    };
  }
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
 * ★ T30：**占位符的两种写法**（度量与补回**共用**这一份，别处不许复制）。
 *
 * · `PLACEHOLDER_RE`：`e?` / `e??` / `e？`（全角）。前面要 `(?<![A-Za-z0-9_])` —— 与 `mentionsEdge`
 *   同一边界规则（`the?` 不算独立 id）；后面**不加** `(?![0-9])` —— `e?123` 也是占位写法。
 * · `SEQ_SPAN_RE`：`renderFacts` 行尾的坐标 `(seq 333-337)`，模型常把半角括号换成全角。
 *
 * 为什么放在这里而不是审计脚本里：**补回**要用它做「就地认领」（见 `reclaimPlaceholders`），
 * 审计要用它数形态。两处各写一份 = 又一个「两个 791」的坑（本仓的老毛病）。
 */
export const PLACEHOLDER_RE = /(?<![A-Za-z0-9_])e[?？]+/g;

export const SEQ_SPAN_RE = /[（(]\s*seq\s*([0-9]+)\s*[-–—~]\s*([0-9]+)\s*[）)]/;

/**
 * ★ T30：**把死路段里的 `e?` 就地认领成具体 id**（补回的一半，且是**先做的那一半**）。
 *
 * 真机依据（2026-11-05，`node scripts/placeholder-audit.mjs` 原样输出；811 条占位符行 / 204 条折痕）：
 *   · **767 行反推得出「本该写哪个 id」**（750 行靠行尾 `(seq a-b)` 精确命中 `evidence` 跨度，
 *     17 行靠动作/错误原文 24 字逐字包含）；真丢的 id 全机只有 **10 个**（1.50% 的区间内失败边），
 *     其中 **6 个**是占位符形状（另外 4 个是破折号区间吞的，属 T26）；
 *   · 这 6 个 id **全部**是「跨界」边（`span.start ≤ 遮蔽终点 < span.end`）——
 *     `failuresInFoldRange` 把它算进区间，`sanitizeSummaryIds` 又把它的 id 抹成 `e?`；
 *   · 补回段以前只**追加**一行，于是同一件事在摘要里出现两次：`- e? "…" → …` 与
 *     `- e46 「…」→ …`。**id 是回来了，死路段那行仍然不可定位**（读者要往下滚才找得到）。
 *
 * 判据（**宁可不认领，也不要写错 id** —— 写错比 `e?` 更坏）：
 *   · 行内**恰好一个**占位符（多个占位符可能各指一条边，无法判定）；
 *   · 行尾坐标 `(seq a-b)` 在**本次缺失清单**里命中**唯一**一条边（同跨度多条 ⇒ 歧义 ⇒ 不认领）；
 *   · 同一条边只认领一次（别处已经写过就交给「已命中」判据）。
 *
 * 为什么只认**缺失清单**里的边：那份清单 = `failuresInFoldRange` = 本段区间内的失败边。
 * 区间**外**的 `e?`（真机 761 行，占 93.8%）是 sanitize 的**设计**（checkpoint 不许引用"未来"），
 * 认领它们等于把 C458 撤掉 —— 那不是本函数的职责。
 *
 * @param {string} text 摘要正文（已 sanitize）
 * @param {Array<object>} missing 本次区间内、正文里没逐条写出的失败边（**全量**，不是前 5 条）
 * @param {Set<string>} claimed 认领结果（就地更新；调用方据此决定还要追加哪几条）
 * @returns {string} 认领后的正文
 */
export function reclaimPlaceholders(text, missing, claimed = new Set()) {
  // 同一 evidence 跨度出现两条边 ⇒ 歧义 ⇒ 两条都不许用来认领
  const bySpan = new Map();
  const ambiguous = new Set();
  for (const edge of Array.isArray(missing) ? missing : []) {
    const span = evidenceSpan(edge);
    if (span === null || !Number.isFinite(span.start) || !Number.isFinite(span.end)) continue;
    const key = `${span.start}-${span.end}`;
    if (bySpan.has(key)) ambiguous.add(key);
    else bySpan.set(key, edge);
  }
  for (const key of ambiguous) bySpan.delete(key);
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      const marks = [...line.matchAll(PLACEHOLDER_RE)];
      if (marks.length !== 1) return line;
      const seq = SEQ_SPAN_RE.exec(line);
      if (seq === null) return line;
      const edge = bySpan.get(`${Number(seq[1])}-${Number(seq[2])}`);
      if (edge === undefined) return line;
      const id = String(edge.id);
      if (claimed.has(id)) return line;
      claimed.add(id);
      return line.replace(PLACEHOLDER_RE, id);
    })
    .join("\n");
}

/**
 * ★ C607：**摘要丢掉的死路，机械补回去**（与 `repairMissingConstraints` 同构）。
 *
 * 为什么死路要和约束一样兜底：约束与失败边是同一类东西 —— **不是摘要，是硬性事实**。
 * 丢一条约束 = 任务变了；丢一条死路 = **下一个模型必然重踩**（C492 的原话）。
 * `docs/方案书.md` 把「失败边逐条出现，不合并、不省略」写成硬契约，那就不能只靠提示词自觉
 * （C458 的原则：提示词挡不住的东西用代码挡）。
 *
 * 真机依据（2026-11-04 19:00:57Z，`session-fdd814b1` 的 `archive-offline`）：
 * 模型把 e693–e698 六条合并成 `e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）`，
 * `failureRecall` 掉到 0.43（7 条里丢 4 条），而合并出来的动作描述还是**错的**（4 个不同文件）。
 *
 * 补回的每一行都是「id + 动作 + 为什么失败」的可读句子（不是 id 堆砌）：
 * `- e694 「edit(file_path=full-host-verification.md)」→ cannot modify "full-host-verification.md": file has not been read…`
 *
 * ★ T30：**先就地认领，再追加**。真机 811 条 `e?` 里有 6 条能由行尾坐标唯一定死，
 *   以前它们会被**再追加一行** ⇒ 摘要里同一条死路出现两次，而死路段那行仍是 `e?`。
 *   认领之后：死路段那行拿到 id、补回段不再重复写它 —— 正文更短，且「一条边只出现一次」。
 *
 * @param {string} text 模型输出（可能已被 sanitize）
 * @param {Array<object>} missing 本次区间内、摘要里**没有逐条 id** 的失败边
 * @returns {{text:string, repaired:string[]}} 补回后的正文 + 补回的 id（含就地认领的）
 */
export function repairMissingFailures(text, missing) {
  const list = (Array.isArray(missing) ? missing : []).filter((e) => e !== null && typeof e === "object" && typeof e.id === "string" && e.id !== "");
  if (list.length === 0) return { text: String(text ?? ""), repaired: [] };
  /** 已被就地认领的 id（它们不需要（也不许）再追加一行）。 */
  const claimed = new Set();
  const body = reclaimPlaceholders(String(text ?? "").replace(/\s+$/, ""), list, claimed);
  /** 认领是一件**一件地**发生的：追加只写「认领不掉的」那几条。 */
  const rest = list.filter((e) => !claimed.has(String(e.id)));
  const repaired = list.map((e) => String(e.id));
  if (rest.length === 0) return { text: body, repaired };
  const lines = ["", "## 已探明死路（逐字补充 · 机械补回，不许重试）"];
  for (const e of rest) {
    const action = compactAction(String(e.intent || e.action || ""), 80);
    // ★ 补回行的错误原文**去掉双引号**：截断可能切在引号中间，而 `describeStructure` 的
    //   「结尾干净」判据数的是引号配平 —— 那会把「机械补回」误读成「摘要被截断」。
    const why = compactAction(String(e.errorSnippet || e.verify?.summary || "-").split("\n")[0], 80).replace(/"/g, "");
    lines.push(`- ${e.id} 「${action}」→ ${why}`);
  }
  return { text: `${body}\n${lines.join("\n")}`, repaired };
}

/**
 * ★ C641：**死路补回的共享接线**（引擎的 `runOfflineFold` 与写回点 `applyOfflineFoldToGraph` 共用）。
 *
 * 为什么要有这一层：C607 把补回写进了 `runOfflineFold`，但 `trigger=archive-offline` 的折痕
 * 有**两个**生产者 —— 引擎（走 `runOfflineFold`）与脚本（`scripts/archive-fold.mjs`：
 * 自己 `measureFoldQuality` 之后直接调 `applyOfflineFoldToGraph`）。脚本那条路**从不调用**补回，
 * 于是它的折痕必然 `failureRecall < 1` 且没有 `failuresRepaired`（真机 18 条里属于这一类的那部分）。
 *
 * 接线点选在**写回点**而不是各生产者内部：那是所有折痕的必经之路，与
 * `test/archive-fold.test.mjs` 的「写回必须走共享实现（否则字段又会分叉）」同一条纪律。
 * 判据与探针同源（`failuresInFoldRange` + `mentionsEdge`），补完 `failureRecall` 必然 = 1。
 *
 * 幂等：引擎那条路已经补过，这里 `missing` 为空 ⇒ 原样返回（不会重复堆砌）。
 *
 * @param {object} graph 棋谱
 * @param {{start:number, end:number}} range 这一段遮蔽的 seq 区间
 * @param {string} text 摘要正文（模型输出，可能已被 sanitize / 约束补回）
 * @returns {{text:string, repaired:string[]}} 补回后的正文 + 补回的 id（空数组 = 一条都没漏）
 */
export function repairFailuresInText(graph, { start, end } = {}, text) {
  const body = String(text ?? "");
  let missing = [];
  try {
    missing = failuresInFoldRange(graph, { start, end }).filter((edge) => !mentionsEdge(body, edge.id));
  } catch {
    // 诊断/补回失败都不许影响压缩主链路（C64 同一纪律）
    return { text: body, repaired: [] };
  }
  if (missing.length === 0) return { text: body, repaired: [] };
  return repairMissingFailures(body, missing);
}

/**
 * 从棋谱渲染「硬事实块」（目标 / 约束 / 死路 / 已验证 / 坐标）—— 与在线折叠同一套事实。
 * @param {object} graph
 * @param {{start:number, end:number}} range
 * @returns {string}
 */
/** ★ C533：事实块的硬上限（字符）。超过就截断并写明，不静默。 */
const MAX_FACTS_CHARS = 8000;

/**
 * ★ C607：**把动作里的路径压成文件名**（事实块与死路补回共用）。
 *
 * 真机（`session-fdd814b1` 的 `archive-offline` 那一次，2026-11-04 19:00:57Z）：
 * 6 条死路的动作都是
 * `edit(file_path=D:\DeepSeek Harness\default-workspace\projects\dsh\plugins\ptc-domain-presets\docs\<文件>)`，
 * 而 `renderFacts` 是**从左往右**切 80 字符 ⇒ 切在 `…\ptc-do` 上 ——
 * **真正有区分度的那一段（文件名）被切掉了**，6 条死路在事实块里长得一模一样。
 * 模型于是把它们合并成「对同一文件连续 edit（重复 6 次）」：它不是瞎写，
 * 是**我们把它写成了 6 条相同的事实**（而真相是 4 个不同文件）。
 * 压成 basename 之后，80 字符里保住的就是「哪个文件」—— 那才是读者要的。
 *
 * @param {string} text 动作或错误原文
 * @param {number} [maxChars]
 * @returns {string}
 */
export function compactAction(text, maxChars = 80) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return "";
  const base = (value) => String(value).split(/[\\/]/).filter((x) => x !== "").pop() ?? String(value);
  const compact = raw
    // `file_path=D:\…\x.md)` —— 值到 `)` / `,` / `;` 为止（路径里有空格，不能按空白切）
    .replace(/([A-Za-z_][A-Za-z0-9_]*)=((?:[A-Za-z]:)?[^),;]*[\\/][^),;]*)/g, (_m, key, value) => `${key}=${base(value)}`)
    // `"/d/…/x.md"` 这种带引号的裸路径
    .replace(/"((?:[A-Za-z]:)?[^"]*[\\/][^"]*)"/g, (_m, value) => `"${base(value)}"`);
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

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
    // ★ C607：切的是**压缩后**的动作 —— 保住「哪个文件」，而不是盘符与目录（见 compactAction）。
    const label = compactAction(String(e.intent || e.action || ""), 80);
    const err = compactAction(String(e.errorSnippet || e.verify?.summary || "-").split("\n")[0], 80);
    lines.push(`- ${e.id} "${label}" → ${err} (seq ${e.evidence?.start ?? "?"}-${e.evidence?.end ?? "?"})`);
  }
  const ok = edges.filter((e) => e?.result === "success").slice(-10);
  if (ok.length > 0) {
    lines.push("", "## 已验证事实");
    for (const e of ok) lines.push(`- ${e.id} ${compactAction(String(e.action ?? ""), 80)} → ${e.verify?.summary ?? "ok"}`);
  }
  // ★ C546：**把会变的东西从事实块里拿掉**。这行原来写在这里（`seq start-end` 每段都不同），
  //   而它排在消息前面 ⇒ 每一段的请求前缀立刻分叉，分段跑 6 段就是 6 次全价重读
  //   （真机 fold 缓存命中只有 10%）。现在改由 buildOfflinePrompt 追加在**末尾**。
  void range;
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
 * ★ C560：**输出预算的唯一算法**（脚本与引擎共用）。
 *
 * 以前两处各写各的：引擎在 `runOfflineFold` 里按输入自适应，脚本却固定 8192 ——
 * 大输入时脚本更容易被截断（而脚本正是我们用来验证引擎的工具，口径必须一致）。
 *
 * @param {number} inputChars 送进模型的字符数（prompt 全长）
 * @param {number} [configured] 配置值（默认 8192）
 * @returns {number} 实际 max_tokens（夹在 [1024, 16384]）
 */
/**
 * ★ C582：**按语言估 token**。官方《Token 用量计算》逐字：
 *   「1 个英文字符 ≈ 0.3 个 token；1 个中文字符 ≈ 0.6 个 token」。
 *
 * 旧写法一律用 `字符数 / 4`（≈0.25/字符），对**中文为主的 prompt 低估约 2.4 倍** ——
 * 于是 `foldBudgetFor` 给的输出预算偏小，摘要容易被截断（真机 12,000 字符的 prompt
 * 实际 6,751 tok，而旧估算只说 3,000）。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  let wide = 0;
  let points = 0;
  for (const ch of s) {
    // ★ C586：**用码点数而不是 `s.length`**。emoji / 代理对在 UTF-16 里占 2 个 length 单位，
    //   混用会让"窄字符数"算多，估出偏大的 token 数。
    points += 1;
    const c = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字 / 兼容表意 / 全角标点：按 0.6 计
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) wide += 1;
  }
  return Math.ceil(wide * 0.6 + (points - wide) * 0.3);
}

export function foldBudgetFor(input, configured = 8192) {
  const base = Number(configured) || 8192;
  const tokens = typeof input === "string" ? estimateTokens(input) : Math.ceil((Number(input) || 0) * 0.6);
  if (!Number.isFinite(tokens) || tokens <= 0) return Math.max(1024, Math.min(16384, base));
  return Math.max(1024, Math.min(16384, Math.max(base, tokens)));
}

/** ★ C599：所有 `max_tokens` 的硬上限（与 `foldBudgetFor` 的夹取上界、配置的 16,384 同一口径）。 */
export const HARD_MAX_TOKENS = 16_384;

/**
 * ★ C599：**按「剩余预算 ÷ 实测段耗时」算还能开几轮**。纯函数，便于单测。
 *
 * 为什么需要它（真机 2026-11-05，88 条 `archive-offline` 折痕）：
 *   · 段耗时 **中位 48.5s / 均值 79s / p90 196.8s**，而补账一轮 tick 的预算是 420s；
 *   · 老代码把轮数**写死 3**：先是一段 197s 的慢段，再硬开两段 ⇒ 这一轮被拖到 600s 以外
 *     （超预算 42%，而 `_autoBackfillBusy` 期间所有 tick 都直接 return）；
 *   · 反过来把 `DSH_GOKIFU_AUTO_BACKFILL_BUDGET_SEC` 调到 1800 时，写死 3 轮又只用掉 237s，
 *     **78% 的预算在空转** —— 这就是"给了预算也不提速"的结构性原因。
 *
 * 判据（`startRatio` 而不是 1）：
 *   剩余时间 ≥ 一段的 `startRatio` 才允许**开始**下一轮。宁可留一小截预算，也不要开一段
 *   明知跑不完的调用 —— 后者会撞 `deadline`，而 `Promise.race` 到点后**连已折的段一起作废**。
 *
 * @param {{remainingMs?:number, segmentMs?:number, cap?:number, startRatio?:number}} [args]
 * @returns {number} 还能开几轮（0 = 别再开了）；`segmentMs <= 0`（没测到）时返回 `cap`
 */
export function roundsWithinBudget({ remainingMs = 0, segmentMs = 0, cap = 8, startRatio = 0.6 } = {}) {
  const limit = Math.max(1, Math.min(64, Number(cap) || 1));
  const left = Number(remainingMs);
  const segment = Number(segmentMs);
  // 没测到段耗时（本轮第一段之前）⇒ 交给上限，让第一段自己去测
  if (!Number.isFinite(segment) || segment <= 0 || !Number.isFinite(left)) return limit;
  const ratio = Math.max(0.1, Math.min(1, Number(startRatio) || 0.6));
  if (left < segment * ratio) return 0;
  return Math.max(1, Math.min(limit, Math.floor(left / segment)));
}

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

export function buildOfflinePrompt({ facts, messages, range = null }) {
  const rangeSafe = range === null || range === undefined ? { start: "?", end: "?" } : range;
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
    // ★ C607：**死路必须逐条**（契约：`docs/方案书.md` §「失败边……逐条出现，不合并、不省略」）。
    //   真机 session-fdd814b1 那一次：模型把 e693–e698 合并成一行
    //   `e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）` ⇒ 中间 4 条 id 当场消失
    //   （failureRecall 0.43），而且「同一文件」本身是错的 —— 那 6 条是 **4 个不同文件**。
    "- 「已探明死路」**一条边一行**：`- e123 「动作」→ 为什么失败`；**不许**把连续几条合并成 " +
      "`e693—e698` 这种区间写法（中间几条的 id 会丢，回查不到原文）。" +
      "同一动作连着失败多次也**逐条**写 id，可以在行尾标「重复 N 次」。",
    // ★ T26（2026-11-05）：**斜杠合并（`e107/e113`）不在本规则禁止之列** —— 量出来的，不是拍的。
    //   度量脚本：`node scripts/slash-merge-audit.mjs`（只读 · 零模型调用）把真机一次度量（2026-11-05，93 次）拆成三档：
    //     · **43% 是成功边**（`e20/e21 成功`，写在「棋谱」「已验证事实」段）—— 本规则只写
    //       「「已探明死路」一条边一行」，成功边根本不在管辖内。`deadend-adherence-audit` 报的
    //       「60.40% 有斜杠」是**全正文**口径（分子是全篇 token、分母是有失败边的 fold），分母错了；
    //     · **42% 是死路段之外的叙述引用**（「…这正是 e26/e27 死路的成因」），其中约 95% 的两端
    //       在死路段**各自有独立行** —— 合并只是简写，死路清单本身仍逐条，信息一条没少；
    //     · **只有约 15%（14 次 / 154 个有失败边的折痕 ≈ 9%）落在死路段之内**，其中 9 次是
    //       同一工具 + 同一错误类（同一动作重复失败，共享描述本来就是事实）。
    //   **丢的 id 是 0**：斜杠两端都能被 `mentionsEdge` 逐字命中；同期 10 个漏写 id 全部来自
    //   破折号区间（4）与纯漏写（6），斜杠贡献 0。死路段的行级格式也已约 98% 合规
    //   （约 1140 条带 id 行里只有 26 条是多 id 行，全展开只多 63 行）。
    //   ⇒ **不改提示词**：为 0 个 id、为 2% 的行格式，去改「作用于所有折叠、且要重启宿主才生效」
    //     （ESM 启动时加载）的提示词，是拿最贵的杠杆换最便宜的收益；而且本规则已经写了
    //     「一条边一行」，再加一句只是把同一件事说第二遍。
    //   什么时候复议：死路段内合并率 ≥ 20%（现在约 9%），或出现「共享描述把两条边的错误写成同一个」
    //     的实例（现在 5 次里模型都把两种错误**并列写出**，没丢任何一种）。复议前先跑那个脚本，
    //     别凭印象改 —— 这条规则改一次，所有折叠的产物都跟着变。
    "- 「当前节点」要说清：现在停在哪、手上还差什么、下一步的**已知约束**（不是建议）。",
    "- 引用实体只能引用上面出现过的 `n123` / `e456`。",
    // ★ C538：消息前缀就是答案 —— 但不说清楚模型宁可写 `n?`（真机 3a3fb03c 连着 3 次全是 n?）。
    "- **原始消息行首的 `[n123]` 就是那一步的棋谱 id**：写状态节点时**必须**用它，不许写 `n?`；"+"只有整条消息前面确实没有方括号时才写 `n?`。",
    "- 不要写「下一步该做什么」这类行动建议。",
    // ★ C533：**篇幅与诚实**。以前没写长度上限，模型一路写到 4000 token 撞顶被截断（真机 8cc34e32）。
    `- 篇幅 **${len.min}–${len.max} 字**（按输入规模算出来的）；宁可少写，不要为凑篇幅重复。`,
    "- 只能写上面出现过的事实；推不出来的不要写（**不许编造**）。遇到不确定的引用写 `n?`。",
    "- 结尾另起一节 `## 约束（逐字）`，把「硬事实」里的约束**原样**抄一遍（这是机读的，不是给人看的）。",
    // ★ C546：**易变内容放最后**（段范围每段都变）—— 这样同一轮分段的请求共享同一段前缀，
  //   第 2 段起就能命中缓存。
    "","## 原始坐标（本段）",`- 本段遮蔽 seq ${rangeSafe.start}-${rangeSafe.end}；逐字原文在 DSH 会话日志中（seq 可定位）。`,
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
  /**
   * ★ C590：**截止时间（ms 时间戳）**。补账在后台跑，一次模型调用卡住会让
   *   `_autoBackfillBusy` 一直为真 ⇒ **后续每个 tick 都直接 return**（整机停补）。
   *   到了 deadline 就带着 `stopped:"deadline"` 提前收工，已折的段照常写回。
   */
  deadline = null,
  /** ★ C595：单段输出预算上限（默认 8192）。慢模型下这个数直接决定"跑不跑得完"。 */
  maxTokensCap = 8192,
  callModel,
  measureQuality,
}) {
  const chunks = [];
  let stoppedEarly = null;
  /** ★ C599：本段是否因为"截止时间装不下"而**跳过**了放大重试（诊断用，写进 chunk）。 */
  let skippedRetry = false;
  const limit = Math.max(1, Number(maxChunks) || 1);
  let cursor = rangeStart;
  let coveredStart = null;
  let coveredEnd = null;
  for (let n = 1; n <= limit; n += 1) {
    if (rangeEnd < cursor) break;
    // ★ C590：到点就收工（已折的段照常写回；outcome 会带 stopped:"deadline"、partial:true）
    if (deadline !== null && Number.isFinite(Number(deadline)) && Date.now() > Number(deadline)) {
      stoppedEarly = "deadline";
      break;
    }
    const chunkStart = cursor;
    skippedRetry = false;
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
    const { messages, chars, dropped, inputCutMessages, inputTruncated } = collectMessages(events, {
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
    const prompt = buildOfflinePrompt({ facts, messages, range: { start: chunkStart, end: rangeEnd } });
    const startedAt = Date.now();
    // ★ C540：**预算跟着输入长**。真机：13k 字符输入时 reasoning 就吃掉 6,936/8,192；
    //   38k 输入的思考只会更多 —— 固定 8192 会在大会话上再次"思考吃光"。
    //   口径：max(配置值, 输入字符/4)，夹到 [1024, 16384]。
    // ★ C587（审核发现）：这里原来传的是 `.length`（数字）⇒ 走 `*0.6` 的退化分支，
    //   C582 的"中文 0.6 / 英文 0.3"**在生产里根本没生效**（只有脚本那条路生效）。
    // ★ C595（真机 2026-11-04 22:1x）：**预算越大，慢模型越跑不完**。
    //   默认模型换成 `kimi-k3.1-pro` 后实测：8,192 预算 ≈ 169 秒/段；若按 C582 的语言估算
    //   放到 16,384，生成时间翻倍 ⇒ 撞上 C590 的 240 秒截止 ⇒ **每次都判 deadline、一段都不折**。
    //   摘要本身受 `suggestedLength` 约束（真机 8.8k 字符已够），没必要为了"给足"而让它慢一倍。
    const budgetCap = Math.max(1024, Math.min(16_384, Number(maxTokensCap) || 8_192));
    const budget = Math.min(budgetCap, foldBudgetFor(String(prompt ?? ""), maxTokens));
    let out = await callModel(prompt, { maxTokens: budget });
    // ★ C522：**被截断的摘要不能当完整**。真机 8cc34e32：completion_tokens 正好 4000（撞上限），
    //   摘要停在半句话上，后面的「已验证事实 / 未验证 / 原始坐标」全没了，而账上却记成成功。
    //   这里先放大 2× 重试一次；还截断就明确标 `truncated`，让 doctor/图能看见。
    // ★ C649：token 判据比**正文**（`estimateTokens`，与预算同源），不比含 reasoning 的 outputTokens（C73）—— 后者只在「正文只剩骨架」时才算数。
    // ★ T44：判据比的是**本次调用的预算**（重试用 `retryBudget` = 2×，拿第一次的 `budget` 比会把
    //   「写得更长、只是没到 2×」判成仍然截断并丢弃）；纯函数体逐字未动，只多绑一个局部名。
    const looksTruncated = (r, callBudget = budget) => {
      const budget = callBudget;
      const used = Number(r?.usage?.completion_tokens ?? r?.usage?.outputTokens ?? NaN);
      if (isTruncatedFinish(r?.finish ?? r?.finishReason) || /max/i.test(String(r?.finish ?? r?.finishReason ?? ""))) return true;
      if (estimateTokens(String(r?.text ?? "")) >= budget) return true;
      // ★ C534：**没撞上限，也可能没写完**。真机 3a3fb03c：completion 4000 里 reasoning 3816，
      //   正文只有 184 token（715 字符）—— 低于上限，旧判据放过它，于是"成功"却只有骨架。
      //   判据：输入不小（>4000 字符）而正文过短（<400 字符）⇒ 当没写完，放大重试。
      const produced = String(r?.text ?? "").trim().length;
      const fed = String(prompt ?? "").length;
      if (produced < 400 && (fed > 4000 || (Number.isFinite(used) && used >= budget))) return true;
      return false;
    };
    let truncated = looksTruncated(out, budget);
    if (truncated) {
      // ★ C599：**重试要先算得过来，否则退化成"整段白丢"**。
      //   真机依据（2026-11-05）：
      //     · 第一次调用已经花掉 48.5s（中位）/ 197s（p90），而重试的预算是 `budget*2`
      //       （实测出字 128 tok/s ⇒ 时间约翻倍）；
      //     · 补账 tick 给的 `deadline` 是 `max(240_000, offlineMaxTokens*25)` ≈ 240s；
      //     · 一旦重试跨过 deadline，引擎侧的 `Promise.race` 返回 `{chunks: []}`
      //       ⇒ **第一段能用的摘要连同这段时间一起作废**（24h 内 15 个会话落在 `offline:deadline`）。
      //   所以：只有"剩余时间 ≥ 已花时间 × 1.2"才开重试；算不下就保留第一次的结果并标 `truncated`
      //   —— 有据可查的"短摘要"远比"零产出"有用，而且不再多付一次模型钱。
      const retryBudget = Math.min(HARD_MAX_TOKENS, Math.max(1024, budget * 2));
      const spentMs = Date.now() - startedAt;
      const roomMs = deadline === null || !Number.isFinite(Number(deadline)) ? Infinity : Number(deadline) - Date.now();
      if (roomMs > spentMs * 1.2) {
        try {
          const bigger = await callModel(prompt, { maxTokens: retryBudget });
          if (!looksTruncated(bigger, retryBudget) && String(bigger?.text ?? "").trim() !== "") {
            out = bigger;
            truncated = false;
          }
        } catch {
          /* 重试失败就保留第一次的结果，并标记截断 */
        }
      } else {
        skippedRetry = true;
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
    // ★ C607：**死路逐条补回**（与上面的约束补回同构）。顺序有意义：死路段补在**约束段之前**，
    //   这样摘要结尾仍然是提示词要求的「## 约束（逐字）」。
    //   为什么必须兜底：`docs/方案书.md` 把「失败边逐条出现，不合并、不省略」写成硬契约，
    //   而真机已经出现过合并（session-fdd814b1：e693—e698 六条并一行，丢 4 条 id）。
    //   判据与探针同源（`failuresInFoldRange` + `mentionsEdge`），补完 `failureRecall` 必然 = 1。
    // ★ C641：**接线搬到 `repairFailuresInText`** —— 写回点（`applyOfflineFoldToGraph`）也要调它。
    //   原来这段只长在本函数里，而 `trigger=archive-offline` 有**两个**生产者：
    //   引擎（本函数）与脚本（`scripts/archive-fold.mjs`，自己算 quality 再调写回点）。
    //   脚本那条路**从不**经过这里 ⇒ 它写出的折痕永远 `failureRecall < 1` 且没有 `failuresRepaired`。
    const fixedFailures = repairFailuresInText(graph, { start, end }, text);
    text = fixedFailures.text;
    const repairedFailures = fixedFailures.repaired;
    const measured = typeof measureQuality === "function" ? measureQuality({ graph, range: { start, end }, summaryText: text }) : null;
    // ★ C607：**补回了几条要留痕**。`failureRecall` 按设计恒 = 1（最终产物口径），
    //   于是「模型自己漏了多少」在指标上看不见 —— 用这两个字段让它可见（doctor 只读已知字段，多出来的不碍事）。
    const quality =
      measured !== null && typeof measured === "object" && repairedFailures.length > 0
        ? { ...measured, failuresRepaired: repairedFailures.length, failuresRepairedIds: repairedFailures.slice(0, 10) }
        : measured;
    chunks.push({
      start,
      end,
      messages: messages.length,
      chars,
      dropped,
      // ★ C610：**输入侧裁切**（事件没放进去 / 单条被切），与下面的 `truncated` 是两件事
      inputTruncated,
      inputCutMessages,
      text,
      repaired,
      // ★ C607：机械补回了几条死路（>0 说明模型的「已探明死路」段没逐条写 id）
      repairedFailures: repairedFailures.length,
      sanitized,
      truncated,
      // ★ C599：标出"重试被截止时间挡掉了"，否则读图的人会以为这条路不会重试
      retrySkipped: skippedRetry,
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
  return { chunks, coveredStart, coveredEnd, uncoveredHead, uncoveredTail, ...(stoppedEarly !== null ? { failed: stoppedEarly } : {}) };
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
export function shouldTryOfflineFold({ closeout, reason, tailEvents, enabled = true, minEvents = 40, marks = null, stillDue = null } = {}) {
  if (enabled !== true) return { go: false, why: "disabled" };
  // 顺序有意义：**已经折过**先判（不管原因写着什么，都不该再花一次钱）
  // ★ C555：**"已经折过"要有证据**。真机（2026-11-04 4f3cae10）：旧代码写下 `folded: 1`，
  //   而 `foldMarks` 是 **0** —— 那一刻 `compactRegion` 空转了。若只看 `folded > 0`，
  //   这类"假冒成功"的会话会被判定"已折过"，永远走不到离线补折。
  //   `marks === null` 表示调用方没给证据 ⇒ 退回旧行为（保守）。
  const hasMarks = marks === null || marks === undefined ? null : Number(marks) > 0;
  // ★ C592（真机发现，**补账彻底停摆**）：`folded > 0` 不等于"没活了"。真机 21:37 重启后
  //   连续 12 分钟零折叠，前五名**全部**返回 `already-folded` —— 而 `debtOfGraph` 同时说 `due:true`
  //   （缺口 10158 / 4591、尾巴 3432…）。两套判据相反，于是每轮 5 个名额全被"已折过"占掉，
  //   一个都没真折。**还有欠账就必须允许再折**。
  if (closeout?.folded > 0 && hasMarks !== false && stillDue !== true) return { go: false, why: "already-folded" };
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
  // ★ C555：**`no-op` 也要算"放弃"**。C531 新增了"调用成功但什么都没变"这个停止原因，
  //   而这里没同步 —— 于是"空转 ⇒ 转离线"这条链在真机上永远不触发（与 C503 那次一模一样的坑）。
  const isGiveUp =
    note.includes("no-foldable-span") ||
    note === "timeout" ||
    note.includes("timeout") ||
    note === "no-op" ||
    note.includes("no-op") ||
    surfaceMissing;
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
    // ★ C647：三个取值都走协议表里的常量 —— `??` 右侧的字面量以前躲过了「字面量扫描」，
    //   于是 `"empty"` 从来没被登记过（见 STOPPED_REASONS 的 docblock）。
    return { tier: "offline", folded: 0, chunks: 0, stopped: result?.failed ?? STOPPED_EMPTY, error: null, partial: true };
  }
  const end = Number(result.coveredEnd);
  const tail = Number.isFinite(end) ? Math.max(0, Number(maxSeq ?? rangeEnd) - end) : Number(rangeEnd ?? 0);
  const head = Number(result.uncoveredHead) || 0;
  return {
    tier: "offline",
    folded: chunks.length,
    chunks: chunks.length,
    stopped: STOPPED_DONE,
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
/**
 * ★ C581：把两种 usage 形状归一。
 *
 * 真机（2026-11-04）发现两条路记的字段名不同：
 *   · 脚本（HTTP 原始响应）⇒ `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`
 *   · 引擎（宿主 Assembler）⇒ `inputTokens` / `outputTokens` / `totalTokens`（**没有** cache/reasoning）
 * 于是"这次折了多少钱、命中多少缓存、推理吃了多少"在图上读不出来。
 *
 * @param {object|null|undefined} u
 * @returns {{input:number|null, output:number|null, cached:number|null, reasoning:number|null, total:number|null}|null}
 */
export function normalizeUsage(u) {
  if (u === null || u === undefined || typeof u !== "object") return null;
  const pick = (...xs) => {
    for (const x of xs) {
      if (x === null || x === undefined) continue;
      const n = Number(x);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  const input = pick(u.inputTokens, u.prompt_tokens);
  const output = pick(u.outputTokens, u.completion_tokens);
  const cached = pick(u.cachedTokens, u.prompt_tokens_details?.cached_tokens);
  const reasoning = pick(u.reasoningTokens, u.completion_tokens_details?.reasoning_tokens);
  const total = pick(u.totalTokens, u.total_tokens) ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0));
  // ★ C587（审核发现，**这是我 C581 引入的回归**）：归一后的字段名必须和**读侧**一致。
  //   读侧（ui.mjs 的 estimateFoldCostUsd / fold-quality.mjs / doctor.mjs）读的都是
  //   `inputTokens / outputTokens / totalTokens / cacheReadTokens` —— 我改成 `input/output/...`
  //   之后，那 7 条已写入的 mark **成本全部算不出来（null）**。
  //   现在保留原字段名，额外补两个**新增**的（cached / reasoning）而不改名。
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cached,
    reasoningTokens: reasoning,
  };
}

/**
 * ★ C641：把「补回了几条死路」写进质量记录，并让 `failuresRepaired` **恒在场**（0 也写）。
 *
 * 为什么 0 也要写（原来只在 > 0 时写）：字段**缺失**同时意味着两件事 ——
 *   · 「补回跑了，一条都没漏」；
 *   · 「补回的代码根本没跑」。
 * 真机统计就栽在这上面：`failuresRepaired 出现 0 次` 被读成「补回一次都没生效」，而真相是
 * **写这些折痕的进程里还没有这段代码**（宿主启动时加载 ESM，改代码不重启不生效）。
 * 恒写之后只有三种读法：`> 0` 补了 N 条 · `=== 0` 跑了没漏 · **字段缺失** = 生产者比 C641 老。
 *
 * 补回后正文变了 ⇒ 记录里的 `failureRecall` / `missingFailures` 按**定义**重算
 * （补回的每一行都带 id ⇒ `mentionsEdge` 必真 ⇒ 召回 = 1）。这里没有整份重算，是因为
 * `measureFoldQuality` 的越界探针需要 `allowedIds`（事实块里的 id 跨整个会话），写回点拿不到 ——
 * 拿不到就别拿空的去重算，否则会凭空长出「越界引用」的假红。
 *
 * @param {object|null} recorded 生产者交上来的质量记录（可能为空）
 * @param {string[]} repairedIds 这一次在写回点补回的 id
 * @param {string} text 补回后的最终正文
 * @returns {object|null}
 */
function qualityWithFailureRepair(recorded, repairedIds, text) {
  if (recorded === null || typeof recorded !== "object") return recorded ?? null;
  const repaired = (Array.isArray(repairedIds) ? repairedIds : []).filter((id) => typeof id === "string" && id !== "");
  const previous = Number(recorded.failuresRepaired);
  const previousIds = (Array.isArray(recorded.failuresRepairedIds) ? recorded.failuresRepairedIds : []).filter((id) => typeof id === "string" && id !== "");
  const count = Math.max(Number.isFinite(previous) ? previous : 0, repaired.length);
  if (count === 0) return { ...recorded, failuresRepaired: 0 };
  const ids = (repaired.length > 0 ? repaired : previousIds).slice(0, 10);
  if (repaired.length === 0) return { ...recorded, failuresRepaired: count, failuresRepairedIds: ids };
  const tokens = estimateTokens(String(text ?? ""));
  const shadowed = Number(recorded.shadowedTokens);
  return {
    ...recorded,
    failureRecall: 1,
    missingFailures: [],
    failuresRepaired: count,
    failuresRepairedIds: ids,
    summaryTokens: Math.max(Number(recorded.summaryTokens) || 0, tokens),
    compressionRatio: Number.isFinite(shadowed) && tokens > 0 ? Math.round((shadowed / tokens) * 100) / 100 : recorded.compressionRatio,
  };
}

export function applyOfflineFoldToGraph(graph, result, meta = {}) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const now = Number.isFinite(meta.now) ? meta.now : Date.now();
  if (chunks.length === 0) return { marksAdded: 0, partial: true };
  const graphRef = graph ?? {};
  graphRef.foldMarks = Array.isArray(graphRef.foldMarks) ? graphRef.foldMarks : [];
  // ★ C642：**先把上一份正文落进它自己那条折痕**。`lastOfflineSummary` 是单槽的（只存最后一次
  //   折叠），本次写回就要覆盖它 —— 不搬走，那条折痕的正文从此永久消失。真机 541 条「不可复判」
  //   全是这么攒出来的：每一条都曾经是「最后一次折叠」，下一次折叠把它挤掉了。
  //   搬一次之后：每条折痕各存一份，`lastOfflineSummary` 只当最后一段的引用目标 ⇒ 全库无副本。
  //   判据与读取侧同源（区间全等 + 那条折痕还没存正文），且只认 `archive-offline`（只有它们
  //   走过本函数、才会写 `lastOfflineSummary`）。
  const previous = graphRef.lastOfflineSummary;
  if (previous !== null && previous !== undefined && typeof previous.text === "string" && previous.text !== "") {
    const start = Number(previous?.range?.start);
    const end = Number(previous?.range?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const owner = graphRef.foldMarks.find(
        (mark) =>
          mark !== null &&
          typeof mark === "object" &&
          String(mark.trigger) === "archive-offline" &&
          typeof mark.summaryText !== "string" &&
          Number(mark.seqStart) === start &&
          Number(mark.seqEnd) === end,
      );
      if (owner !== undefined) {
        owner.summaryText = previous.text;
        // 那条折痕当初只留了引用 ⇒ 正文已就地落盘，引用必须撤掉（留着等于「正文在哪」有两个
        // 说法，而它们迟早对不上 —— C587 就是同一个字段两个名字的代价）。
        delete owner.summaryTextRef;
      }
    }
  }
  /** 补回后的正文（最后一段原样进 `lastOfflineSummary` —— 它的折痕只存引用，不存副本）。 */
  const texts = [];
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    // ★ C641：**补回接在写回点**（见 `repairFailuresInText` 的注释）。这里是所有
    //   `trigger=archive-offline` 折痕的必经之路 —— 引擎那条路已经补过（幂等空转），
    //   脚本那条路**只在这里**补；补完再按最终正文写留痕字段（否则记录描述的是一份不存在的摘要）。
    const filled = repairFailuresInText(graphRef, { start: chunk.start, end: chunk.end }, chunk.text);
    const text = filled.text;
    texts.push(text);
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
      usage: normalizeUsage(chunk.usage),
      summaryChars: text.length,
      // ★ C642：**正文落盘**。三个审计器（structure / fold-loss / repair-coverage）要复判「模型
      //   到底写没写这一段」，唯一的依据是正文；只留 `summaryChars` 时它们只能报「不可复判，不猜」。
      //   最后一段例外：它的正文马上要原样写进 `lastOfflineSummary`（同一个字符串），这里只留
      //   **引用** —— 一条摘要只存一遍（写两份 = 磁盘成本凭空翻倍，这正是本轮的硬约束）。
      ...(isLast ? { summaryTextRef: "lastOfflineSummary" } : { summaryText: text }),
      quality: qualityWithFailureRepair(chunk.quality, filled.repaired, text),
      qualityRepaired: chunk.repaired ?? 0,
      // ★ C584：`truncated` 一直没写进 mark —— 而 status 用它判"跑的是不是新代码"
      //   ⇒ 无论代码多新，那行永远报「⚠ 新字段一个都没写」。写下来，让探测器不再撒谎。
      truncated: chunk.truncated === true,
      // ★ C610：**输入侧裁切单独记，绝不塞进 `truncated`** —— 两者答的不是同一个问题：
      //     · `truncated`（响应侧 `looksTruncated`）= 模型**写没写完**（上游撞 max-tokens / 正文只剩骨架）；
      //     · `inputTruncated`（输入侧 `collectMessages`）= 模型**看没看全**（事件整条没放进去，或正文被切）。
      //   合成就丢掉「输入被裁、模型正常收尾」—— 那正是假「没截断」的来源（`scripts/input-truncation-audit.mjs`）。
      //   取值只有三种：`true` 裁过 / `false` 没裁 / `null` 不知道（旧记录、生产者没给），绝不拿 `false` 冒充不知道。
      inputTruncated: typeof chunk.inputTruncated === "boolean" ? chunk.inputTruncated : null,
      // 被裁掉的**条数**（整条丢弃 + 正文被切），给 doctor / 审计一个可核对的整数；不知道就是 null
      inputCutMessages: Number.isFinite(Number(chunk?.inputCutMessages)) ? Math.max(0, Number(chunk.inputCutMessages)) : null,
      offline: true,
    });
  }
  const last = chunks[chunks.length - 1];
  // ★ C641：用**补回后**的正文 —— 否则 `lastOfflineSummary` 与 mark 里那份对不上，
  //   而审计（`scripts/repair-coverage-audit.mjs`）正是拿这份原文重放补回的。
  graphRef.lastOfflineSummary = { at: now, range: { start: last.start, end: last.end }, text: texts[texts.length - 1] ?? "", model: last.model ?? meta.model ?? null };
  const uncoveredHead = Number(result?.uncoveredHead) || 0;
  const uncoveredTail = Number(result?.uncoveredTail) || 0;
  // ★ C586：**"还有剩余缺口"也算没折完**。以前 `partial` 只看 uncoveredHead/Tail，
  //   而"上一轮留下的缺口只被补掉一部分"时 remaining > 0 却不算 partial
  //   ⇒ `closeoutSettles` 说结清、`debtOfGraph` 说还欠（两套口径给出相反答案）。
  const prevGapEvents = Number(meta?.previousGapEvents ?? NaN);
  const coveredCount = Math.max(0, Number(result?.coveredEnd ?? 0) - Number(result?.coveredStart ?? 0) + 1);
  const remainingGap = Number.isFinite(prevGapEvents) && prevGapEvents > 0 ? Math.max(0, prevGapEvents - coveredCount) : uncoveredHead;
  const partial = uncoveredHead > 0 || uncoveredTail > 0 || remainingGap > 0;
  const base = { ...(graphRef.closeout ?? {}) };
  delete base.foldNote;
  delete base.foldError;
  delete base.chunkStopped;
  // ★ C572（审核发现）：**旧缺口/部分标记要先清掉再按本次重算**。
  //   否则一次「覆盖了全部缺口」的折叠之后，旧的 `offlineUncoveredHead` 与 `partial:true` 还留着
  //   ⇒ `debtOfGraph` 永远 `due:true`（tail=0 也一样）⇒ 同一段被**无限重复补账**。
  delete base.partial;
  delete base.offlineUncoveredHead;
  delete base.offlineUncoveredTail;
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
      const prevGap = prevGapEvents;
      const gapFrom = Number(meta?.rangeStart ?? 1) || 1;
      const covered = coveredCount;
      // 有旧缺口 ⇒ 扣掉这次真压掉的事件，游标推到 coveredEnd+1
      const remaining = remainingGap;
      if (remaining <= 0) return {};
      const nextFrom = Number.isFinite(prevGap) && prevGap > 0 ? Math.max(gapFrom, Number(result?.coveredEnd ?? gapFrom) + 1) : gapFrom;
      return { offlineUncoveredHead: { events: remaining, from: nextFrom } };
    })(),
    ...(uncoveredTail > 0 ? { offlineUncoveredTail: { events: uncoveredTail } } : {}),
  };
  return { marksAdded: chunks.length, partial };
}
