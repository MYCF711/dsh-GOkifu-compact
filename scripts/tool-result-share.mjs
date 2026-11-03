/**
 * tool-result-share.mjs —— 上下文里**工具结果**占了多少，以及清掉它会不会伤到死路（C481）
 *
 * 由来（候选 K-2）：官方把"清工具结果"称作最安全的轻压缩，我们也一直有这个候选 ——
 * 但**从没量过**：它到底能省多少？清掉之后，图里那些失败边的错误文本还在不在？
 *
 * 这个脚本只回答三个数（不猜、不改产品）：
 *   ① 一次会话里，tool/result 的字符占全部消息字符的比例（粗估 token 用同比例）；
 *   ② 其中**已经被图引用的**（错误片段出现在某条失败边的 errorSnippet 里 / 被 evidence 覆盖）有多少；
 *   ③ 剩下那部分才是**可安全清掉**的上限。
 *
 * 用法：
 *   node scripts/tool-result-share.mjs                # 扫最近 10 份会话日志
 *   node scripts/tool-result-share.mjs --limit 30
 *   node scripts/tool-result-share.mjs --json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "./session-scan.mjs";

/** 粗略 token 估算：中英混排下 1 token ≈ 3.6 字符（与本仓库 token-calib 的口径同量级）。 */
export const CHARS_PER_TOKEN = 3.6;

/**
 * 从一段文本里取「工具结果」与「其它消息」的字数（纯函数，便于单测）。
 *
 * @param {Array<object>} events 会话事件（升序）
 * @returns {{toolChars:number, textChars:number, toolResults:number, textMessages:number}}
 */
export function measureToolResultShare(events) {
  let toolChars = 0;
  let textChars = 0;
  let toolResults = 0;
  let textMessages = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (e === null || typeof e !== "object") continue;
    if (e.type === "tool/result") {
      toolResults += 1;
      toolChars += contentChars(e.data?.message?.content);
      continue;
    }
    if (e.type === "user/message" || e.type === "assistant/message") {
      textMessages += 1;
      textChars += contentChars(e.data?.message?.content ?? e.data?.content);
    }
  }
  return { toolChars, textChars, toolResults, textMessages };
}

function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") n += block.text.length;
    // 工具调用参数也算"上下文里要发出去的东西"
    else if (typeof block.arguments === "string") n += block.arguments.length;
    else if (block.type === "image") n += 4000; // 图片按"贵"记（不精确，但比当 0 强）
  }
  return n;
}

/**
 * 判断一段工具结果是否"已经被图记住"——即它的错误片段出现在某条失败边的 errorSnippet 里。
 *
 * 为什么这么判：清掉工具结果是安全的**前提**是"死路不丢"。我们的死路记在边上
 * （`errorSnippet` / `result: "failure"`），所以只要错误文本在边上出现过，清掉原始结果不损失信息。
 *
 * @param {string} text 工具结果文本
 * @param {Array<object>} edges 图里的边
 * @returns {boolean}
 */
export function isRememberedByGraph(text, edges) {
  const body = String(text ?? "");
  if (body === "") return false;
  for (const edge of Array.isArray(edges) ? edges : []) {
    const snippet = String(edge?.errorSnippet ?? "");
    if (snippet === "") continue;
    // 边上的片段是截断过的（通常 200–400 字符）—— 用它的前 60 字符去正文里找
    const needle = snippet.slice(0, 60);
    if (needle.length >= 12 && body.includes(needle)) return true;
  }
  return false;
}

/**
 * 汇总一份会话的可清理上限。
 * @param {Array<object>} events
 * @param {Array<object>} edges
 * @returns {{toolChars:number, textChars:number, toolShare:number|null, rememberedChars:number, prunableChars:number, prunableShare:number|null}}
 */
export function summarizeOverlap(events, edges) {
  const base = measureToolResultShare(events);
  let rememberedChars = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== "tool/result") continue;
    const text = plainText(e.data?.message?.content);
    if (isRememberedByGraph(text, edges)) rememberedChars += text.length;
  }
  const total = base.toolChars + base.textChars;
  return {
    ...base,
    toolShare: total > 0 ? base.toolChars / total : null,
    rememberedChars,
    prunableChars: Math.max(0, base.toolChars - rememberedChars),
    prunableShare: base.toolChars > 0 ? Math.max(0, base.toolChars - rememberedChars) / base.toolChars : null,
  };
}

function plainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

/* ───────────────────────── CLI ───────────────────────── */

function listLogs(home, limit) {
  const root = path.join(home, "sessions");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd")) out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function loadEdges(home, sessionDirName) {
  const file = path.join(home, "chess-context", "sessions", sessionDirName, "graph.json");
  if (!fs.existsSync(file)) return [];
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, "utf8"))?.edges ?? {});
  } catch {
    return [];
  }
}

export function main(argv = process.argv.slice(2), { home = process.env.DSH_HOME ?? "" } = {}) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
  };
  if (home === "") {
    console.error("缺 DSH_HOME（或传 --home）");
    return 2;
  }
  const limit = getArg("limit", 10);
  const rows = [];
  for (const { file } of listLogs(home, limit)) {
    const sessionDirName = path.basename(path.dirname(file));
    let events;
    try {
      events = decodeMultiFrameZstd(fs.readFileSync(file)).text.split("\n").filter(Boolean);
    } catch {
      continue;
    }
    const parsed = [];
    for (const line of events) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        /* 坏行跳过 */
      }
    }
    const s = summarizeOverlap(parsed, loadEdges(home, sessionDirName));
    rows.push({ session: sessionDirName.replace(/^session-/, "").slice(0, 16), ...s });
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ rows, charsPerToken: CHARS_PER_TOKEN }, null, 2));
    return 0;
  }
  console.log(`== 工具结果占比（最近 ${rows.length} 份会话日志）==`);
  const fmt = (n) => `${Math.round(n / 1000)}k`;
  for (const r of rows) {
    const share = r.toolShare === null ? "—" : `${(r.toolShare * 100).toFixed(1)}%`;
    const pShare = r.prunableShare === null ? "—" : `${(r.prunableShare * 100).toFixed(1)}%`;
    console.log(
      `  · ${r.session}  工具结果 ${fmt(r.toolChars)} 字符（占 ${share}）· 已被图记住 ${fmt(r.rememberedChars)}` +
        ` · **可安全清掉上限** ${fmt(r.prunableChars)} 字符（占工具结果 ${pShare}）`,
    );
  }
  const withData = rows.filter((r) => r.toolShare !== null);
  if (withData.length > 0) {
    const medTool = median(withData.map((r) => r.toolShare));
    const medPrune = median(withData.map((r) => r.prunableShare ?? 0));
    console.log(
      `  中位：工具结果占上下文 **${(medTool * 100).toFixed(1)}%**，其中可安全清掉 **${(medPrune * 100).toFixed(1)}%**` +
        `（≈ 上下文总量的 ${(medTool * medPrune * 100).toFixed(1)}%）`,
    );
  }
  return 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
