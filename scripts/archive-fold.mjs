/**
 * archive-fold.mjs —— **离线**给归档会话补一次摘要（C490）
 *
 * 由来（用户原话）：「需要的不是会话自己去压，而是归档的日志需要去调用**默认模型**压缩一次，
 * 这样就不用依赖对话模型」。
 *
 * 现在的收尾折叠挂在这条链上：归档事件 → `compactIfNeeded(agent)` → 要活着的 surface + 对话模型。
 * 归档后 session 已被摘除 ⇒ `no-foldable-span` ⇒ 尾巴永远压不了（真机 2026-11-03 验证）。
 *
 * 这个脚本绕开那条链：**直接读会话日志**（多帧 zstd，我们本来就会解），把尾部按预算拼成输入，
 * 用**独立的默认模型**跑一次摘要，结果写进我们自己的棋谱（foldMark + closeout）。
 *
 * 三条边界先说清楚（避免误解做了什么）：
 *   ① 我们**不动宿主的压缩历史** —— 宿主的 `session.v4.jsonl.zstd` 原样保留；
 *   ② 这里产出的是**我们账本上的一次折叠**：尾巴不再算欠账，摘要留在 `lastOfflineSummary`；
 *   ③ 重开会话时要不要把它注入回去，是下一步的事（本脚本只负责"压出来 + 记账"）。
 *
 * 用法：
 *   node scripts/archive-fold.mjs --session aa52f421            # 干跑：只打印将要发的输入
 *   node scripts/archive-fold.mjs --session aa52f421 --write    # 真调模型并写回棋谱
 *   node scripts/archive-fold.mjs --due --limit 2 --write       # 只补最旧的 2 个欠账
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "./session-scan.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";

// ★ C490：默认用 `deepseek-flash`，**不用** `group/...`。
//   真机实测（2026-11-03）：`group/deepseek-v4.1-flash1017` 被路由到 wps-lingxi 上游，
//   那个上游**忽略 `thinking:{type:"disabled"}`** —— reasoning 会把 max_tokens 吃光、`content` 回 null；
//   `deepseek-flash` 走 trustoken，实测 reasoning_tokens=0，开关生效。
export const DEFAULT_MODELS = Object.freeze(["deepseek-flash"]);
export const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";

/* ────────────────────────── 纯函数 ────────────────────────── */

/**
 * 从会话事件里挑出「值得压」的消息：只取 user/assistant 的文本，**跳过工具结果**。
 *
 * 为什么跳过工具结果：`tool/result` 在真机上占上下文 12%–77%（中位 44.9%，见 C481），
 * 而其中 93%–100% 没有被任何失败边引用。整段塞进摘要请求既贵又稀释重点。
 * 失败信息本来就在棋谱的 `errorSnippet` 里，走 facts 块。
 *
 * @param {Array<object>} events
 * @param {{maxChars?:number}} [options]
 * @returns {{messages:Array<{role:string, text:string}>, chars:number, dropped:number}}
 */
export function collectMessages(events, { maxChars = 60_000 } = {}) {
  const picked = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object") continue;
    if (e.type !== "user/message" && e.type !== "assistant/message") continue;
    const text = plainText(e.data?.message?.content ?? e.data?.content);
    if (text.trim() === "") continue;
    picked.push({ role: e.type === "user/message" ? "user" : "assistant", text });
  }
  // 从**最近**往前取，直到预算用完（尾部最相关；早期内容已经在既有棋谱里）
  const out = [];
  let chars = 0;
  let dropped = 0;
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const m = picked[i];
    if (chars + m.text.length > maxChars) {
      dropped = i + 1; // 剩下的更早消息都没放进去
      break;
    }
    out.push(m);
    chars += m.text.length;
  }
  out.reverse();
  return { messages: out, chars, dropped };
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
  lines.push(`## 目标（不可改写）`, `- ${String(root?.text ?? "(none)").split("\n")[0]}`);
  const constraints = [...new Set(nodes.flatMap((n) => (Array.isArray(n?.constraints) ? n.constraints : [])))].slice(0, 12);
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

/* ────────────────────────── 主流程 ────────────────────────── */

function plainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b?.text === "string" ? b.text : ""))
    .filter((x) => x !== "")
    .join("\n");
}

/** 读会话日志 → 事件数组（坏行跳过）。 */
export function readSessionEvents(logFile) {
  let text;
  try {
    text = decodeMultiFrameZstd(fs.readFileSync(logFile)).text;
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function findLogFile(home, sessionDirName) {
  const root = path.join(home, "sessions");
  let found = null;
  const walk = (dir) => {
    if (found !== null) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd") && p.includes(sessionDirName)) found = p;
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return found;
}

async function callModel({ baseUrl, apiKey, model, prompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }) },
      // ★ 思考模式**默认开着**（官方《Thinking Mode》），而且 reasoning 也吃 max_tokens ——
      //   真机实测：max_tokens=16 全被 reasoning 吃掉，`content` 直接是 null。
      //   摘要这种"照事实改写"的活不需要思考，显式关掉，既省钱又不至于返回空。
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (res.ok === false) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const text = json?.choices?.[0]?.message?.content ?? "";
    // ★ C490：空文本必须能自证 —— 打印 finish_reason 与 usage，否则只看到"返回空"没法排查
    return {
      text: String(text),
      usage: json?.usage ?? null,
      model: json?.model ?? model,
      finish: json?.choices?.[0]?.finish_reason ?? null,
      reasoningChars: String(json?.choices?.[0]?.message?.reasoning_content ?? "").length,
      raw: text === "" || text === null ? JSON.stringify(json).slice(0, 300) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const home = env.DSH_HOME ?? "";
  if (home === "") {
    console.error("缺 DSH_HOME");
    return 2;
  }
  const write = argv.includes("--write");
  const model = get("model", env.ARCHIVE_FOLD_MODEL ?? DEFAULT_MODELS[0]);
  const baseUrl = get("base", env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL);
  const apiKey = env.MAGPIE_API_KEY ?? "";
  const maxChars = Number(get("max-chars", 60_000));
  const limit = Number(get("limit", 1));
  const sessionsRoot = path.join(home, "chess-context", "sessions");

  // 选目标：--session 或 --due
  const targets = [];
  if (get("session", "") !== "") {
    const want = String(get("session", ""));
    const dir = fs.readdirSync(sessionsRoot).find((x) => x.includes(want));
    if (dir === undefined) {
      console.error(`找不到会话 ${want}`);
      return 2;
    }
    targets.push(dir);
  } else if (argv.includes("--due")) {
    for (const dir of fs.readdirSync(sessionsRoot)) {
      const file = path.join(sessionsRoot, dir, "graph.json");
      if (!fs.existsSync(file)) continue;
      try {
        const g = loadSessionGraph(file).graph;
        if (debtOfGraph(g).due) targets.push(dir);
      } catch {
        /* 坏图跳过 */
      }
    }
  }
  if (targets.length === 0) {
    console.log("没有目标（用 --session <id前缀> 或 --due）");
    return 1;
  }

  for (const dir of targets.slice(0, limit)) {
    const graphFile = path.join(sessionsRoot, dir, "graph.json");
    const { graph } = loadSessionGraph(graphFile);
    const debt = debtOfGraph(graph);
    const logFile = findLogFile(home, dir);
    if (logFile === null) {
      console.log(`  ✗ ${dir.slice(0, 16)} 找不到会话日志，跳过`);
      continue;
    }
    const events = readSessionEvents(logFile);
    const { messages, chars, dropped } = collectMessages(events, { maxChars });
    const end = debt.maxSeq;
    const start = debt.lastFoldSeq === null ? 1 : debt.lastFoldSeq + 1;
    const facts = renderFacts(graph, { start, end });
    const prompt = buildOfflinePrompt({ facts, messages });
    console.log(`== ${dir.slice(0, 16)} ==`);
    console.log(`  段 ${start}-${end} · 消息 ${messages.length} 条（${chars} 字符${dropped > 0 ? `，更早的 ${dropped} 条未放` : ""}）`);
    console.log(`  输入合计 ${prompt.length} 字符 · 模型 ${model}`);
    if (!write) {
      console.log("  （干跑：加 --write 才会真的调用模型并写回）");
      continue;
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await callModelSafe({ baseUrl, apiKey, model, prompt, maxTokens: 1600, timeoutMs: Number(get("timeout", 180_000)) });
    } catch (error) {
      console.log(`  ✗ 模型调用失败：${String(error?.message ?? error).slice(0, 200)}`);
      continue;
    }
    const ms = Date.now() - startedAt;
    const text = result.text.trim();
    if (text === "") {
      console.log(
        `  ✗ 模型返回空文本（finish=${result.finish ?? "?"} · reasoning=${result.reasoningChars ?? 0} 字符 · usage=${JSON.stringify(result.usage)}）`,
      );
      if (result.raw !== null) console.log(`    原始响应：${result.raw}`);
      continue;
    }
    // 写回：foldMark + closeout + lastOfflineSummary
    graph.foldMarks = Array.isArray(graph.foldMarks) ? graph.foldMarks : [];
    graph.foldMarks.push({
      at: Date.now(),
      seqStart: start,
      seqEnd: end,
      trigger: "archive-offline",
      shadowedTokens: null,
      measuredBefore: null,
      route: { provider: "magpie", model: result.model },
      fallback: null,
      ms,
      usage: result.usage,
      summaryChars: text.length,
      offline: true,
    });
    graph.lastOfflineSummary = { at: Date.now(), range: { start, end }, text, model: result.model };
    // ★ C490：折成功之后要**清掉旧的"没折成"说明**，否则图上会同时存在 folded:1 与 nothing-to-fold:*（自相矛盾）
    const baseCloseout = { ...(graph.closeout ?? {}) };
    delete baseCloseout.foldNote;
    delete baseCloseout.foldError;
    delete baseCloseout.chunkStopped;
    graph.closeout = {
      ...baseCloseout,
      at: Date.now(),
      source: "archive-offline",
      foldAttempted: true,
      folded: 1,
      foldOffline: true,
    };
    fs.writeFileSync(graphFile, JSON.stringify(graph, null, 1), "utf8");
    console.log(`  ✓ 已写回：摘要 ${text.length} 字符 · ${ms}ms · usage=${JSON.stringify(result.usage)}`);
  }
  return 0;
}

/** fetch 在部分 Node 上是全局的；这里包一层，失败时给出可读错误。 */
async function callModelSafe(args) {
  return callModel(args);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = main();
  if (code instanceof Promise) code.then((c) => (process.exitCode = c));
  else process.exitCode = code;
}
