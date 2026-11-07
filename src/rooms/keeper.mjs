/**
 * keeper.mjs —— R03 事件→图（A3-1e，2026-10-30 从 src/keeper.mjs + src/extract.mjs 合并）
 *
 * 为什么合并：extract.mjs 只有 keeper 一个消费者（A1 §3.2 / 契约 R03 的「extract 并入本房间」）。
 * 本文件 = extract 的全部函数（stripIntentPrefix/intentFromAssistantText/actionSummary/
 * touchedPaths/writtenPathsFromResult）+ keeper 的全部函数（messageText/isCheckpointMessage/
 * isOwnMessage/isHumanMessage/injectionKind/observeEvent）。**零逻辑改动**。
 *
 * 旧路径 src/keeper.mjs 与 src/extract.mjs 都保留一行门面，全部旧 import 仍可用。
 */

import { addUserNode, addEdge, addAgentNode, settleEdge, extractConstraints, norm, sha } from "./kifu-model.mjs";
import { classify } from "./verify.mjs";
// ★ AX-04（2026-11-07）：成功工具结果的**短值**落边（K-2 已证实的退化，见 tool-value-facts.mjs 头注释）。
//   依赖面新增 R03 → AX-02 房间；`test/rooms.test.mjs` 的 keeper.allowed 需同步登记
//   `./tool-value-facts.mjs`，否则 C3 方向门禁会红（本任务可写路径不含该文件，见 REPORT「未验项」）。
import { extractValueFacts } from "./tool-value-facts.mjs";

/**
 * extract.mjs —— 从会话事件里抽取「意图 / 动作 / 约束」
 *
 * 全部是启发式，但必须**确定性**：同样的输入永远同样的输出，
 * 否则图不可复现、单测没法写。
 */

const INTENT_HINT_RE = /我要|我想|我将|接下来|下一步|先|然后|我会|准备|计划|先把|改成|let me|I'll|I will|next|first/i;

/**
 * 去掉「计划：」「我打算」「接下来我要」这类引导语 —— 它们不携带信息，
 * 却会让热上下文里的每一行都以同样的词开头（实测：8 条死路全以「计划：」开头，
 * 模型续跑时反而抓不到关键词）。
 */
const INTENT_PREFIX_RE = /^(?:计划[:：]|我打算|我将|我要|我会|接下来我?要?|下一步我?要?|然后我?要?|先|现在)\s*/;

export function stripIntentPrefix(text) {
  return norm(text).replace(INTENT_PREFIX_RE, "").trim();
}

/**
 * 从 assistant 的文本里取「预想道路」：一句意图级的话，不含实现细节。
 * 优先取最后一段里第一句像计划的话；取不到就用首句；都没有就空。
 */
export function intentFromAssistantText(text, limit = 200) {
  const body = norm(text);
  if (!body) return "";
  const sentences = body
    .split(/(?<=[。！？.!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 400);
  if (sentences.length === 0) return body.slice(0, limit);
  const hinted = sentences.filter((s) => INTENT_HINT_RE.test(s));
  const pick = hinted.length > 0 ? hinted[hinted.length - 1] : sentences[0];
  return stripIntentPrefix(pick).slice(0, limit);
}

/** 动作摘要：工具名 + 最关键参数（路径/命令/查询），≤240 字。 */
export function actionSummary(tool, args) {
  const name = String(tool ?? "?");
  const a = args && typeof args === "object" ? args : {};
  const parts = [];
  const push = (key) => {
    if (a[key] !== undefined && a[key] !== null && String(a[key]).length > 0) {
      parts.push(`${key}=${String(a[key]).replace(/\s+/g, " ")}`);
    }
  };
  // 不同工具的「关键参数」不同；按优先级取前两个，避免把整个 schema 抄进来
  const priority = ["file_path", "path", "command", "cmd", "pattern", "query", "url", "prompt", "description", "content"];
  for (const key of priority) {
    if (parts.length >= 2) break;
    push(key);
  }
  if (parts.length === 0) {
    const keys = Object.keys(a).slice(0, 2);
    for (const key of keys) push(key);
  }
  const body = parts.join(" ").slice(0, 200);
  return body ? `${name}(${body})` : name;
}

/** 键序无关的稳定 JSON —— 递归排序对象键（同样的参数永远同样的串，否则指纹不成立）。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

/**
 * ★ C461：这条用户消息是不是**换了件事**（任务切换）。
 *
 * 由来（外部资料，Claude Code 最佳实践逐字）："**Every request sends the whole conversation**, so a session
 * that's collected three unrelated tasks re-reads all three on every turn of the fourth." 官方给的解法是
 * 人与人之间的切换靠 `/clear`。我们没有 `/clear` 的等价物，但至少可以**发现**这件事已经发生 ——
 * 否则"旧任务的历史每轮都在付费"永远没人知道。
 *
 * 判据刻意保守（宁可漏报，不要天天喊"你要换会话了"）：
 *   · 与「根目标 + 约束」的词重叠极低（CJK 用双字组、ASCII 用整词）；
 *   · 且新消息本身有实质内容（太短的不判：`继续`、`好` 这类不构成切换）。
 *
 * @param {string} text 新的用户消息
 * @param {{rootText?:string, constraints?:string[]}} prior 之前的目标与约束
 * @param {{maxOverlap?:number, minChars?:number}} [options]
 * @returns {{pivot:boolean, overlap:number, reason:string}}
 */
export function taskPivotScore(text, { rootText = "", constraints = [] } = {}, { maxOverlap = 0.06, minChars = 8 } = {}) {
  const body = String(text ?? "").trim();
  if (body.length < minChars) return { pivot: false, overlap: 0, reason: "too-short" };
  const grams = (input) => {
    const out = new Set();
    const s = String(input ?? "");
    // ASCII 整词
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) out.add(`w:${m[0].toLowerCase()}`);
    // CJK 双字组（去标点/空白）
    const cjk = s.replace(/[^\u4e00-\u9fa5]/g, "");
    for (let i = 0; i + 1 < cjk.length; i += 1) out.add(`c:${cjk.slice(i, i + 2)}`);
    return out;
  };
  const priorText = `${rootText} ${(Array.isArray(constraints) ? constraints : []).join(" ")}`;
  const prior = grams(priorText);
  const now = grams(body);
  if (prior.size === 0 || now.size === 0) return { pivot: false, overlap: 0, reason: "no-tokens" };
  let hit = 0;
  for (const g of now) if (prior.has(g)) hit += 1;
  const overlap = hit / now.size;
  return { pivot: overlap <= maxOverlap, overlap, reason: overlap <= maxOverlap ? "low-overlap" : "related" };
}

/**
 * ★ C446：动作**指纹**（工具名 + 完整参数，键序无关）。给「循环判据」用，不给人看。
 *
 * 为什么不能只看 `actionSummary`：它只取 2 个关键参数，于是
 * `edit(file_path=D:/a/b.md)` 对**同一文件的每次不同编辑**都逐字相同。
 * 真机实测（36 个会话）：3 个会话出现连续 **5–6 次** `edit(...)`，`result` 全是 `success`
 * —— 那是真的在改代码，不是循环。用 action 当判据会把它们误判成思考死循环并强行折叠。
 *
 * 指纹把**参数全文**算进去：同一个命令重复跑 ⇒ 指纹相同；同一个文件的不同编辑 ⇒ 指纹不同。
 */
export function actionSignature(tool, args) {
  return sha(`${String(tool ?? "?")}\u0000${stableJson(args ?? {})}`).slice(0, 16);
}

/**
 * 文件触碰记录：写类/命令类工具都算「可能改变世界」。
 * @returns string[] 相对或绝对路径
 */
export function touchedPaths(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  const out = [];
  for (const key of ["file_path", "path", "target", "destination"]) {
    if (typeof a[key] === "string" && a[key].length > 0) out.push(a[key]);
  }
  return out;
}

/** 从工具结果里找「被写入/修改的文件」提示（部分工具只回文本）。 */
export function writtenPathsFromResult(text) {
  const body = String(text ?? "");
  const out = [];
  const re = /(?:^|\n)\s*(?:[A-Z]\s+)?((?:[A-Za-z]:)?[^\s:*?"<>|]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|py|go|rs|java|css|html|sh))\b/g;
  let m;
  while ((m = re.exec(body)) !== null && out.length < 20) out.push(m[1]);
  return out;
}


/**
 * keeper.mjs —— 把会话事件流归纳成棋谱（每步落账，零模型成本）
 *
 * 输入只有 event（DSH 的 SessionEvent），输出是对 graph 的增量修改。
 * 不碰 session、不碰文件系统、不 await —— 因此可以在同步的 session/event
 * 监听器里安全调用，也可以单测。
 */


const CHECKPOINT_KIND = "compact-checkpoint";
const OWN_SOURCE_KIND = "chess-context";

/**
 * 只有「人类真正说的话」才配当 UserNode（约束锚 + 根目标）。
 * ★ 2026-10-28 实测：user 角色的消息有 8 种 source.kind ——
 *   user / agent-instructions / runtime-context / skill-catalog / plugin:hindsight /
 *   agent-message / subagent-settled / chess-context。
 *   把它们都当用户消息，会把工作区说明和记忆注入抽成「约束」，污染整张棋谱。
 */
const HUMAN_SOURCES = new Set(["user", "prompt", "human"]);

/** 从 user/message 事件里取纯文本（多块拼接）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function isCheckpointMessage(message) {
  return message?.source?.kind === CHECKPOINT_KIND || message?.source?.kind === "compact-checkpoint";
}

export function isOwnMessage(message) {
  return message?.source?.kind === OWN_SOURCE_KIND;
}

/** 机器产物必须占正文（去空白后）的多少，才算「假人话」—— 低于这个比例一律算人话。 */
const MACHINE_SHARE = 0.9;

/** **强**机器行：只在命令回执 / 堆栈里出现的精确形状（人不会拿它开头）。 */
const MACHINE_STRONG_LINE =
  /^(?:\s+at\s+\S|\s+File "\S+", line \d+|\[[A-Z][A-Z0-9_]*\]|(?:npm|pnpm|yarn) (?:ERR!|error)|[✓✗✔✖]|Traceback \(most recent call last\)|panic: |HTTP\/\d(?:\.\d)? \d{3}\b)/;

/** **弱**机器行：可以和真人话混排（错误行 / 缩进续行 / 空行）—— 只用来凑覆盖率，不能单独定案。 */
const MACHINE_WEAK_LINE = /^(?:[{\[]|\s*$|\s+\S|[A-Za-z][\w-]*: |This error happened while )/;

/** 从 `from` 开始取一个完整 JSON 值的结束下标（尊重字符串转义）；未闭合返回 -1。 */
function jsonValueEnd(text, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** OpenAI 兼容形状的信封：`error` / `choices` / `chatcmpl-` 开头的 id / `object: "chat.completion*"`。 */
function isOpenAiEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.error !== undefined && value.error !== null) return true;
  if (Array.isArray(value.choices)) return true;
  if (typeof value.id === "string" && value.id.startsWith("chatcmpl")) return true;
  return value.object === "chat.completion" || value.object === "chat.completion.chunk";
}

/** 正文里机器产物占多少（0–1）；开头不是可识别的机器形状 ⇒ 0（= 人话）。 */
function machineOutputShare(body) {
  // ① JSON 文档序列：首个必须是 OpenAI 信封（后面可能还粘着请求体 / 响应体，残渣只算人话）
  if (body[0] === "{" || body[0] === "[") {
    let at = 0;
    let inside = 0;
    let docs = 0;
    let first;
    let parsed = true;
    while (at < body.length) {
      if (body[at] !== "{" && body[at] !== "[") {
        at += 1;
        continue;
      }
      const end = jsonValueEnd(body, at);
      const stop = end < 0 ? body.length : end; // 尾部被截断的文档整段算机器（真机 seq 1179 就是截断的）
      if (docs === 0) {
        try {
          first = JSON.parse(body.slice(at, stop));
        } catch {
          parsed = false;
          break;
        }
      }
      inside += stop - at;
      docs += 1;
      at = stop;
      if (end < 0) break;
    }
    if (parsed && docs > 0 && isOpenAiEnvelope(first)) return inside / body.length;
  }
  // ② 命令回执 / 堆栈 / HTTP 响应：首行必须是强机器行，或「弱错误行 + 至少一条强机器行」
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim() !== "") ?? "";
  const corroborated = MACHINE_WEAK_LINE.test(first) && lines.some((line) => MACHINE_STRONG_LINE.test(line));
  if (!MACHINE_STRONG_LINE.test(first) && !corroborated) return 0;
  let inside = 0;
  for (const line of lines) if (MACHINE_STRONG_LINE.test(line) || MACHINE_WEAK_LINE.test(line)) inside += line.length;
  return inside / body.length;
}

/**
 * 这条 user 消息是人打的字，还是系统/插件注入的上下文。
 *
 * ★ T38（2026-11-05）：`source.kind` 只说明「宿主把这条归到 user 轮」，**不说明它是人打的字**。
 *   真机反例（session-example seq 1179）：一条 **251,157 字符**的 LLM 错误 JSON
 *   （`{"id":"chatcmpl-…","error":{…}}` + 用户粘上的请求体）宿主标的 `kind: "user"`，
 *   于是 `extractConstraints` 从里面抽出 40 条「约束」灌进事实块 —— 整块 36% 是系统提示词。
 *
 *   判据是**闭集** + **锚在开头** + **绝对主体**，三条缺一不可：
 *     ① 闭集 —— 只认上面几种精确形状（OpenAI 信封 / 堆栈 / HTTP 状态行 / 命令回执），不猜语义；
 *     ② 锚在开头 —— 形状必须从正文第一个非空字符开始；用户正文里**引用**报错不算
 *        （贴一段日志再问「这是什么」是最常见的真实输入）；
 *     ③ 绝对主体 —— 机器产物必须占字符 ≥ `MACHINE_SHARE`，否则算人话。
 *   **保守优先：判不准就算人话。** 误判成机器会丢掉真实用户输入（不可恢复），
 *   留噪声只是多花 token。
 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind;
  if (kind === undefined || kind === null) {
    // 没有 source 的旧格式：保守当成注入，不建约束锚
    return false;
  }
  if (!HUMAN_SOURCES.has(String(kind))) return false;
  const body = messageText(message).replace(/\r\n/g, "\n").trim();
  if (body === "") return true;
  return machineOutputShare(body) < MACHINE_SHARE;
}


/** 注入来源的分类（只用于统计/调试，不进图）。 */
export function injectionKind(message) {
  const kind = String(message?.source?.kind ?? "unknown");
  return HUMAN_SOURCES.has(kind) ? null : kind;
}

/**
 * 观察一个事件，更新棋谱。
 * @param {object} g 棋谱（graph.mjs 的 createGraph 产物）
 * @param {object} event DSH 会话事件
 * @param {object} state 每会话的运行时状态 { pendingEdges: Map<callId, edgeId>, lastNodeId, touched: string[] }
 * @returns {{ changed: boolean, note?: string }}
 */
export function observeEvent(g, event, state) {
  switch (event.type) {
    case "user/message": {
      const message = event.data;
      if (!message || isCheckpointMessage(message) || isOwnMessage(message)) return { changed: false };
      if (!isHumanMessage(message)) {
        // 注入上下文：不计入棋谱（既不建 UserNode，也不参与约束抽取）
        state.injected = (state.injected ?? 0) + 1;
        return { changed: false, note: `ignored injection:${injectionKind(message)}` };
      }
      const text = messageText(message);
      if (!text.trim()) return { changed: false };
      const id = addUserNode(g, { seq: event.seq, turn: event.data?.turn ?? null, text, constraints: extractConstraints(text) });
      // ★ C461：换任务的那一条要留痕 —— 之后每轮请求都在为旧任务的历史付费（Claude Code 的解法是 /clear）
      try {
        const roots = (g.rootUserNodeIds ?? []).map((rid) => g.nodes?.[rid]).filter(Boolean);
        const prior = {
          rootText: roots.map((n) => n.text ?? "").join(" "),
          constraints: roots.flatMap((n) => (Array.isArray(n.constraints) ? n.constraints : [])),
        };
        const verdict = taskPivotScore(text, prior);
        if (verdict.pivot) {
          g.nodes[id].pivot = true;
          g.pivots = (Number.isFinite(g.pivots) ? g.pivots : 0) + 1;
          g.pivotAt = event.seq;
        }
      } catch {
        /* 打标失败不影响落账 */
      }
      state.lastUserNodeId = id;
      // 用户的新消息开启一条新的主路径：把当前 agent 节点挂到最近的 user 节点下
      state.lastNodeId = id;
      // 用户纠正 ⇒ 约束集变化 ⇒ 之后的节点必然是新状态
      state.constraintDirty = true;
      return { changed: true, note: `user node ${id}` };
    }

    case "assistant/message": {
      const message = event.data?.message;
      if (!message || !Array.isArray(message.content)) return { changed: false };
      const text = messageText(message);
      const intent = intentFromAssistantText(text);
      let changed = false;
      for (const block of message.content) {
        if (!block || block.type !== "tool-call") continue;
        const args = parseArgs(block.arguments);
        const edgeId = addEdge(g, {
          from: state.lastNodeId ?? null,
          intent,
          action: actionSummary(block.name, args),
          // ★ C446：指纹给循环判据用 —— 同一命令重复跑才算循环，同一文件的不同编辑不算
          sig: actionSignature(block.name, args),
          evidence: { start: event.seq, end: event.seq },
        });
        const callKey = block.id ?? edgeId;
        state.pendingEdges.set(callKey, edgeId);
        // ★ AX-04：结算时要看**实参**才能区分「github 读形（GET/HEAD）」与「写形（POST/PATCH…）」——
        //   `actionSummary` 只留 2 个关键参数，`method` 不在其中，从边上的 action 反推不出来。
        //   只活在内存里：与 pendingEdges 同生命周期，不进 graph.json / delta（不改磁盘形状）。
        (state.callInfo ??= new Map()).set(callKey, { name: block.name, args });
        (state.stepEdges ??= []).push(edgeId);
        for (const p of touchedPaths(block.name, args)) {
          state.touched.push(p);
          // 真的把路径喂给世界状态，否则 hash() 永远不变（置换判断失效）
          if (typeof state.touchPath === "function") state.touchPath(p);
        }
        changed = true;
      }
      if (changed) {
        state.lastAssistantText = intent;
        state.lastStepSeq = event.seq;
      }
      return { changed };
    }

    case "tool/result": {
      const message = event.data?.message;
      if (!message) return { changed: false };
      const callId = message.source?.callId ?? message.toolCallId;
      const edgeId = state.pendingEdges.get(callId);
      if (edgeId === undefined) return { changed: false };
      state.pendingEdges.delete(callId);
      // 这条 tool-call 的实参只在这条边结算时用一次；结算后立刻丢（不常驻内存）
      const call = state.callInfo?.get(callId);
      state.callInfo?.delete(callId);
      const text = messageText(message);
      const toolName = state.toolNameByCall?.get(callId) ?? guessToolFromEdge(g, edgeId);
      const verdict = classify({ tool: toolName, text, isError: message.isError === true });
      for (const p of writtenPathsFromResult(text)) {
        state.touched.push(p);
        if (typeof state.touchPath === "function") state.touchPath(p);
      }
      // ★ AX-04：**在结算之前**抽短值（判定要用 verdict，写边必须在 settleEdge 之后 —— 边对象由它返回）。
      //   `resultKind` 是**抽取器**的信任闸，和边上的 `result` 是两件事：
      //     · success            → 抽（有外部验证信号）；
      //     · weak（read/shell）  → 抽（工具自报无错、无外部验证）；**边的 result 仍是 unverified**；
      //     · failure / 无 weak 的 unverified → 空数组（失败结果不许进成功值事实）。
      //   github REST 工具（toolClass → "other"、classify 给 unverified 且**不带 weak**）是
      //   K-2 S2-Q3 的真实形状：读形（GET/HEAD）的结果就是「读到的值」，按 weak 放行；
      //   写形（POST/PATCH/PUT/DELETE / 带 body / confirm:true）**一律不放行** ——
      //   不许按工具名一刀切把写调用标成弱成功（那会把一次创建回执当成可复用事实）。
      const valueFacts = extractValueFacts({
        tool: call?.name ?? toolName,
        result: text,
        resultKind: resultKindForValueFacts(verdict, call?.name ?? toolName, call?.args),
        // 证据指针 = 这条 tool/result 的事件 seq（与下面回填的 evidence.end 同一个值）
        evidenceSeq: event.seq,
      });
      const edge = settleEdge(g, edgeId, {
        result: verdict.result,
        verify: verdict.verify,
        errorSnippet: verdict.errorSnippet,
        // S2a：只读弱成功（verdict.weak = "read"）原样落进边，供热清单的 WORKING 路径使用。
        // result 仍是 verdict.result（unverified）—— 失败集 / 事实块 / 手割一律看不到它。
        weak: verdict.weak ?? null,
      });
      if (edge.evidence && typeof edge.evidence === "object") edge.evidence.end = event.seq;
      // ★ AX-04：只在**真的抽出短值**时落字段 —— 旧图/无值的边**不长这个键**（graph.json 字节不变）。
      //   `delete` 与 settleEdge 清 weak 的语义一致：重新结算成「没有值」时不留陈旧事实。
      if (valueFacts.length > 0) edge.valueFacts = valueFacts;
      else delete edge.valueFacts;
      return { changed: true, note: `${edgeId} → ${verdict.result}` };
    }

    case "turn/end":
    case "step/end": {
      // 关闭步骤时，仍未结算的边标成 unverified（不是 success）
      let changed = false;
      for (const [callId, edgeId] of state.pendingEdges) {
        settleEdge(g, edgeId, { result: "unverified", verify: { kind: "no-result", summary: "step closed with no tool result" } });
        state.pendingEdges.delete(callId);
        // AX-04：没有结果的调用不会产事实，但实参缓存必须一起清（否则跨 step 常驻）
        state.callInfo?.delete(callId);
        changed = true;
      }
      // 一个 step 结束 = 一个状态节点（本步所有边指向它；下一步从这里出发）
      if (event.type === "step/end" && (state.stepEdges?.length ?? 0) > 0) {
        const edges = state.stepEdges.map((id) => g.edges[id]).filter(Boolean);
        const last = edges[edges.length - 1];
        const node = addAgentNode(g, {
          seq: event.seq,
          turn: event.data?.turn ?? null,
          goal: state.lastAssistantText ?? "",
          // ★ 用创建时刻的真实状态哈希（engine 注入 state.worldHashOf）。
          //   旧版一律写 "pending"，由 engine 在 fold 前**统一回填成同一个哈希** ——
          //   结果整段路径被判定为同一状态，fold 时折叠成一个节点（实测节点 5→2、边 from 悬空）。
          worldHash: typeof state.worldHashOf === "function" ? state.worldHashOf() : "pending",
          constraintHash: typeof state.constraintHashOf === "function" ? state.constraintHashOf() : "pending",
          via: last ? last.id : null,
        });
        for (const edge of edges) edge.to = node.id;
        state.lastNodeId = node.id;
        state.stepEdges = [];
        changed = true;
      }
      return { changed };
    }

    default:
      return { changed: false };
  }
}

function parseArgs(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function guessToolFromEdge(g, edgeId) {
  const edge = g.edges[edgeId];
  const m = /^([A-Za-z0-9_-]+)\(/.exec(edge?.action ?? "");
  return m ? m[1] : "unknown";
}

/* ─────────────── AX-04：成功工具结果的短值落边（K-2 退化修复） ─────────────── */

/**
 * **工具本身就是 GitHub REST 端点**的几种名字。
 *
 * 只认这几种，是因为「HTTP 方法在实参里」这件事只有这类工具成立：
 *   · `github`（DSH 的 github 工具：`{path, method?, body?, confirm?}`，method 缺省 GET）；
 *   · 少数命名空间形态（`mcp__github` / `github_api` …）。
 * **绝不能**用 `includes("github")` 之类的一刀切 ——
 *   `mcp__github__create_pull_request` 这类 MCP 工具的方法在**名字**里、实参里没有 `method`，
 *   按「无 method ⇒ GET」判就会把写调用标成弱成功（任务书 AX-04 明令禁止）。
 *   它们的 `toolClass` 已经是 mcp-read / mcp-write，走 classify 自己的 weak，不需要这里兜。
 */
const GITHUB_REST_TOOLS = new Set(["github", "github_api", "github__api", "mcp__github", "mcp__github_api"]);

/** HTTP 的读形方法（无副作用、结果就是「读到的值」）。 */
const GITHUB_READ_METHODS = new Set(["GET", "HEAD"]);

/** 这次 github 调用是不是**读形**（GET/HEAD，或没给 method 的缺省 GET）。 */
function githubReadShaped(toolName, args) {
  const name = String(toolName ?? "").trim().toLowerCase();
  if (!GITHUB_REST_TOOLS.has(name)) return false;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const method = typeof a.method === "string" ? a.method.trim().toUpperCase() : "";
  // 显式给了方法：只有 GET/HEAD 算读（POST/PATCH/PUT/DELETE/其它一律不是）
  if (method !== "") return GITHUB_READ_METHODS.has(method);
  // 没给方法 ⇒ 工具缺省 GET。但**出现写形状的实参**就不是读：
  //   `body` 只有写方法才带；`confirm: true` 是写方法的确认闸（读调用永远不会设）。
  if (a.body !== undefined && a.body !== null) return false;
  if (a.confirm === true) return false;
  return true;
}

/**
 * 给 `extractValueFacts` 的 `resultKind`（抽取器的**信任闸**，不是边上的 result）。
 *
 * ⚠ 这个函数**不许改 `verdict`**：边的 `result` 永远是 classify 的判定。
 *   github 读形在这里被当成 `weak` 只是「结果里的 id/private 是可回证的读到的值」，
 *   **不是**「这次调用成功了」—— 边仍然是 `unverified`（S2a 的弱成功语义）。
 *
 * @param {{result:string, weak?:string|null}} verdict classify 的返回值
 * @param {string} toolName tool-call 的工具名
 * @param {unknown} args tool-call 的实参
 * @returns {"success"|"failure"|"unverified"|"weak"|"read"|"shell"}
 */
function resultKindForValueFacts(verdict, toolName, args) {
  if (verdict.result === "success") return "success";
  if (verdict.result === "failure") return "failure";
  // 剩下的只有 unverified：classify 自己的弱成功（read / shell）优先
  if (verdict.weak) return verdict.weak;
  // K-2 S2-Q3 的真实形状：github 读形结果被 classify 判 unverified 且**没有** weak
  if (githubReadShaped(toolName, args)) return "weak";
  return "unverified";
}

