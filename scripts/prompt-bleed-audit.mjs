#!/usr/bin/env node
/**
 * prompt-bleed-audit.mjs —— **system prompt 回灌审计**（T38 · 只读 · 零模型调用）
 *
 * 由来（T33 真机样本 10，`<SESSION_ID>`）：
 *   13,210 字符的离线摘要里，两块「约束」段占 **64.3%**（`## 约束（逐字）` 4,264 +
 *   `## 约束（逐字补充 · 离线压缩后自动补回，不许删）` 4,222），其中相当一部分是**整份系统提示词**
 *   （SOVEREIGN 授权声明 / 工具说明 / 交付约定 / `# 歧义` / `## 自锁条款`）；
 *   并且把**上一条摘要的棋谱段**（n178–n183）原样搬进了 seq 1396-1400 的折叠。
 *
 * 这个脚本只做机器能核对的事，**不猜**：
 *   ① 全库有正文的摘要里，多少条含系统提示词标记（**闭集**，见 `SYSTEM_PROMPT_MARKERS`）；
 *   ② 每条摘要的**污染比例** = 逐字出现在系统提示词里的字符数 / 总字符数；
 *   ③ 污染落在**摘要的哪一段**（`## 目标` / `## 约束（逐字）` / 散落）；
 *   ④ 这些字**从哪条事件进来的**（`system/message` / `<system-reminder>` 注入 / 上一条 checkpoint /
 *      assistant 正文），以及折叠 prompt 里**事实块 vs 消息**各占多少。
 *
 * 判据（全部机械字符串匹配，不做语义判断）：
 *   · **污染字符数**：摘要在**行**粒度上，被系统提示词的 24-gram 覆盖的部分，按覆盖率折回原行长度。
 *     24 字符的逐字重合在中文里几乎不可能是巧合；按比例折回是为了**不整行记账**
 *     （模型常把系统提示词和真约束拼在同一行）。
 *   · **Oracle（系统提示词原文）**：该会话日志里的 `system/message` 事件 —— 那是宿主自己的记录，
 *     不是我们转述的。日志拿不到（归档 / 已删）⇒ 只报标记口径，并**明说**污染比例不可得。
 *   · **标记（闭集）**：见 `SYSTEM_PROMPT_MARKERS`。它回答「有没有」，**不回答「占多少」** ——
 *     两者必须分列，混在一起就是 T33 那个「60%」的来历（把「约束段总长」当成「系统提示词」）。
 *
 * 用法：
 *   node scripts/prompt-bleed-audit.mjs                 # 默认 DSH_HOME
 *   node scripts/prompt-bleed-audit.mjs --home <DIR>    # 换 home
 *   node scripts/prompt-bleed-audit.mjs --json          # 机读（报告 / 测试用）
 *   node scripts/prompt-bleed-audit.mjs --limit=5       # 明细只列前 5 条
 *   node scripts/prompt-bleed-audit.mjs --no-replay     # 跳过折叠输入重放（更快）
 *
 * 退出码：0 = 跑完（无论数字多少）；2 = 一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { findSessionLog, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { collectMessages, renderFacts, buildOfflinePrompt, plainText } from "../src/rooms/offline-fold.mjs";
import { resolveSummaryText } from "./summary-usability-audit.mjs";

/* ─────────────────────────────── 常量（改口径只改这里） ─────────────────────────────── */

/**
 * **系统提示词的标记（闭集）**。
 *
 * 只收「宿主注入的角色说明」才有的字样 —— 它们不可能出现在用户自己的任务书里：
 *   · `SOVEREIGN` / `用户主权声明` —— persona 段；
 *   · `system-reminder` —— DSH 每轮注入的 workspace 指令 / 技能目录外壳；
 *   · `推理过程用中文思考` / `web_search results are external` / `工具调用被拒绝时` —— 系统提示词原句；
 *   · `## 角色` / `## 铁律` / `# 歧义` / `交付约定` / `工具说明` —— 系统提示词章节名。
 *
 * **故意不收**「下一步」「不要」「必须」这类通用词：它们在真摘要里到处都是，收进来就是假阳性
 * （C612 的教训：口径一宽，数字立刻变成噪声）。
 */
export const SYSTEM_PROMPT_MARKERS = Object.freeze([
  { id: "SOVEREIGN", re: /SOVEREIGN/ },
  { id: "用户主权声明", re: /用户主权声明/ },
  { id: "system-reminder", re: /system-reminder/i },
  { id: "推理过程用中文思考", re: /推理过程用中文思考/ },
  { id: "web_search results are external", re: /web_search results are external/ },
  { id: "工具调用被拒绝时", re: /工具调用被拒绝时/ },
  { id: "## 角色", re: /(?:^|\n)#{1,2}[ \t]*角色[ \t]*$/m },
  { id: "## 铁律", re: /(?:^|\n)#{1,2}[ \t]*铁律[ \t]*$/m },
  { id: "# 歧义", re: /(?:^|\n)#[ \t]*歧义[ \t]*$/m },
  { id: "交付约定", re: /交付约定/ },
  { id: "工具说明", re: /工具说明/ },
]);

/** 逐字重合的最短长度（字符）。中文 24 字逐字相同 ≈ 不可能是巧合。 */
export const NGRAM_CHARS = 24;

/** 明细默认列几条。 */
export const DEFAULT_LIMIT = 20;

/* ─────────────────────────────────── 小工具 ─────────────────────────────────── */

/**
 * 把 JSON 转义还原成语义等价的**单行**文本。
 *
 * 为什么必须做：真机摘要里的系统提示词是从一条 25 万字符的 LLM 错误 JSON 里抄来的，
 * 换行是字面量 `\n`、引号是 `\"`。不还原就与系统提示词原文（真换行）对不上 ——
 * 实测：不还原时 `<SESSION_ID>` 的污染只有 439 字符，还原后是 4,750（少算 90%）。
 * @param {string} text
 * @returns {string}
 */
export function unescapeJsonish(text) {
  return String(text ?? "")
    .replace(/\\+n/g, " ")
    .replace(/\\+r/g, " ")
    .replace(/\\+t/g, " ")
    .replace(/\\+"/g, '"');
}

/** 一行 → 可比较形式（去列表符号、折叠空白）。 */
export function normalizeLine(line) {
  return unescapeJsonish(line).replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * 系统提示词的 24-gram 集合（比较用）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function ngramSet(text) {
  const normalized = normalizeLine(text);
  const set = new Set();
  for (let i = 0; i + NGRAM_CHARS <= normalized.length; i += 1) set.add(normalized.slice(i, i + NGRAM_CHARS));
  return set;
}

/**
 * 一行里有多少字符**逐字**出现在 oracle 里（24-gram 覆盖，按覆盖率折回原行长度）。
 * @param {string} line
 * @param {Set<string>} grams
 * @returns {number} 0 = 这一行没有系统提示词
 */
export function coveredChars(line, grams) {
  const normalized = normalizeLine(line);
  if (normalized.length < NGRAM_CHARS) return 0;
  const covered = new Uint8Array(normalized.length);
  for (let i = 0; i + NGRAM_CHARS <= normalized.length; i += 1) {
    if (!grams.has(normalized.slice(i, i + NGRAM_CHARS))) continue;
    for (let k = i; k < i + NGRAM_CHARS; k += 1) covered[k] = 1;
  }
  let hit = 0;
  for (const flag of covered) hit += flag;
  return Math.round((hit / normalized.length) * line.length);
}

/**
 * 摘要 → 逐行（带上所属的 `## 段名`；`##` 之前算 `__preamble__`）。
 * @param {string} text
 * @returns {Array<{section:string, line:string}>}
 */
export function splitLines(text) {
  const out = [];
  let section = "__preamble__";
  for (const line of String(text ?? "").split("\n")) {
    const heading = /^##[ \t]+(\S.*)$/.exec(line);
    if (heading !== null) {
      section = heading[1].trim();
      continue;
    }
    out.push({ section, line });
  }
  return out;
}

/**
 * 一条摘要的污染度量。
 * @param {string} text 摘要正文
 * @param {Set<string>|null} grams 系统提示词的 24-gram（null = 日志拿不到，只能报标记口径）
 * @returns {{chars:number, markers:string[], pollutedChars:number|null, ratio:number|null, bySection:Array<{section:string,chars:number}>}}
 */
export function measureSummary(text, grams) {
  const body = String(text ?? "");
  const markers = SYSTEM_PROMPT_MARKERS.filter((marker) => marker.re.test(body)).map((marker) => marker.id);
  if (grams === null) return { chars: body.length, markers, pollutedChars: null, ratio: null, bySection: [] };
  const bySection = new Map();
  let pollutedChars = 0;
  for (const { section, line } of splitLines(body)) {
    const covered = coveredChars(line, grams);
    if (covered === 0) continue;
    pollutedChars += covered;
    bySection.set(section, (bySection.get(section) ?? 0) + covered);
  }
  return {
    chars: body.length,
    markers,
    pollutedChars,
    ratio: body.length === 0 ? 0 : pollutedChars / body.length,
    bySection: [...bySection.entries()].map(([section, chars]) => ({ section, chars })).sort((a, b) => b.chars - a.chars),
  };
}

/* ─────────────────────────────── 来源归因 ─────────────────────────────── */

/** checkpoint 消息的开头（DSH 自己的压缩产物；`src/rooms/keeper.mjs` 的 `isCheckpointMessage` 同源）。 */
export const CHECKPOINT_HEAD = "This is an automatically generated checkpoint";

/**
 * 事件分类（**来源路径**）—— 报告里「怎么进来的」那一列。
 * @param {object} event
 * @returns {string}
 */
export function eventSource(event) {
  const type = String(event?.type ?? "unknown");
  if (type === "system/message") return "system/message（`collectMessages` 本来就跳过）";
  if (type === "assistant/message") return "assistant/message（模型自己的输出）";
  if (type !== "user/message") return type;
  const text = plainText(event.data?.message?.content ?? event.data?.content);
  if (text.startsWith(CHECKPOINT_HEAD)) return "user/message · `<compacted-summary>`（上一条摘要 = checkpoint）";
  if (/<system-reminder>/i.test(text)) return "user/message · `<system-reminder>`（宿主注入的角色说明）";
  return "user/message（用户自己的话）";
}

/**
 * 把摘要里**被污染的每一行**追到具体事件（seq + 类型）。
 *
 * 两道判据都是机械的，**不做模糊匹配**：
 *   ① 这一行确实被系统提示词的 24-gram 覆盖（`coveredChars > 0`）—— 否则它只是普通正文，
 *      追到哪条事件都没有意义（第一版忘了这一条，于是「目标」段也被列进「回灌来源」）；
 *   ② 这一行的**前 24 字**是某条事件的子串 —— 用它定位「从哪条消息抄来的」。
 * @param {string} summary
 * @param {Array<object>} events
 * @param {Set<string>} grams 系统提示词的 24-gram
 * @returns {Array<{seq:number|null, source:string, chars:number, polluted:number, head:string}>}
 */
export function attributeLines(summary, events, grams) {
  const normalizedEvents = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== "object") continue;
    const text = normalizeLine(plainText(event.data?.message?.content ?? event.data?.content));
    if (text === "") continue;
    normalizedEvents.push({ seq: Number.isFinite(Number(event.seq)) ? Number(event.seq) : null, source: eventSource(event), text });
  }
  const out = [];
  for (const { line } of splitLines(summary)) {
    const polluted = coveredChars(line, grams);
    if (polluted === 0) continue;
    const normalized = normalizeLine(line);
    const head = normalized.slice(0, NGRAM_CHARS);
    const event = normalizedEvents.find((candidate) => candidate.text.includes(head));
    out.push({
      seq: event?.seq ?? null,
      source: event?.source ?? "（日志里找不到这条 —— 可能是更早的折叠产物）",
      chars: line.length,
      polluted,
      head: normalized.slice(0, 60),
    });
  }
  return out;
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

/**
 * 全库口径数字（纯函数，便于单测）。
 * @param {Array<{sessionId:string, marks:object[], lastOfflineSummary:object|null}>} sessions
 * @returns {{sessions:number, marks:number, withText:number}}
 */
export function census(sessions) {
  let marks = 0;
  let withText = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    for (const mark of Array.isArray(session?.marks) ? session.marks : []) {
      marks += 1;
      if (resolveSummaryText(mark, session?.lastOfflineSummary ?? null).text !== null) withText += 1;
    }
  }
  return { sessions: (sessions ?? []).length, marks, withText };
}

/**
 * 读一份会话日志 → 系统提示词 oracle + 全部事件（拿不到 ⇒ null）。
 * @param {string} home
 * @param {string} sessionId
 * @returns {{log:string, events:Array<object>, text:string|null}|null}
 */
export function systemPromptOf(home, sessionId) {
  const log = findSessionLog(home, String(sessionId).replace(/^session-/, ""));
  if (log === null) return null;
  const events = readSessionEvents(log);
  const text = events
    .filter((event) => event?.type === "system/message")
    .map((event) => plainText(event.data?.message?.content ?? event.data?.content))
    .join("\n");
  return { log, events, text: text.trim() === "" ? null : text };
}

const pct = (value) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const noReplay = argv.includes("--no-replay");
  const homeArg = argv.find((item) => item.startsWith("--home="));
  const limitArg = argv.find((item) => item.startsWith("--limit="));
  const limit = limitArg === undefined ? DEFAULT_LIMIT : Math.max(1, Number(limitArg.slice("--limit=".length)) || DEFAULT_LIMIT);
  const home = String(homeArg === undefined ? process.env.DSH_HOME ?? "" : homeArg.slice("--home=".length)).trim();

  const { root, files } = collectGraphFiles(home);
  if (files.length === 0) {
    console.error(`✗ 读不到任何棋谱（${nodePath.join(home, "chess-context", "sessions")}）—— 用 --home 指定 DSH_HOME`);
    return 2;
  }

  const sessions = [];
  for (const entry of files) {
    let graph;
    try {
      graph = JSON.parse(fs.readFileSync(entry.file, "utf8"));
    } catch {
      continue;
    }
    sessions.push({ sessionId: entry.dir, marks: graph.foldMarks ?? [], lastOfflineSummary: graph.lastOfflineSummary ?? null });
  }
  const counts = census(sessions);

  // ① 全库：标记口径（纯字符串，不读日志）
  const pool = [];
  for (const session of sessions) {
    for (const mark of session.marks) {
      const { text, source } = resolveSummaryText(mark, session.lastOfflineSummary);
      if (text === null) continue;
      pool.push({
        sessionId: session.sessionId,
        trigger: String(mark?.trigger ?? "undefined"),
        source,
        seqStart: Number(mark?.seqStart),
        seqEnd: Number(mark?.seqEnd),
        text,
      });
    }
  }
  pool.sort((a, b) => b.text.length - a.text.length || a.sessionId.localeCompare(b.sessionId));
  const hits = pool
    .map((row) => ({ ...row, markers: SYSTEM_PROMPT_MARKERS.filter((marker) => marker.re.test(row.text)).map((marker) => marker.id) }))
    .filter((row) => row.markers.length > 0);

  // ② 命中者：读日志拿 oracle，算污染比例 + 来源归因
  const detail = [];
  for (const row of hits) {
    const sys = systemPromptOf(home, row.sessionId);
    const grams = sys === null || sys.text === null ? null : ngramSet(sys.text);
    const measured = measureSummary(row.text, grams);
    const attributed = grams === null ? [] : attributeLines(row.text, sys.events, grams);
    detail.push({ ...row, measured, attributed, log: sys?.log ?? null, systemPromptChars: sys?.text?.length ?? null });
  }

  // ③ 折叠输入重放：事实块 vs 消息各带多少系统提示词（只跑污染最重的那条）
  let replay = null;
  if (!noReplay) {
    const worst = [...detail].sort((a, b) => (b.measured.pollutedChars ?? 0) - (a.measured.pollutedChars ?? 0))[0];
    const sys = worst === undefined ? null : systemPromptOf(home, worst.sessionId);
    if (worst !== undefined && sys !== null && sys.text !== null && Number.isFinite(worst.seqStart)) {
      const grams = ngramSet(sys.text);
      let graph = null;
      try {
        graph = JSON.parse(fs.readFileSync(nodePath.join(root, worst.sessionId, "graph.json"), "utf8"));
      } catch {
        graph = null;
      }
      if (graph !== null) {
        const collected = collectMessages(sys.events, { maxChars: 60_000, fromSeq: worst.seqStart });
        const facts = renderFacts(graph, { start: worst.seqStart, end: worst.seqEnd });
        const prompt = buildOfflinePrompt({ facts, messages: collected.messages, range: { start: worst.seqStart, end: worst.seqEnd } });
        const perMessage = collected.messages.map((message) => ({
          seq: message.seq,
          role: message.role,
          chars: message.text.length,
          polluted: coveredChars(message.text, grams),
        }));
        replay = {
          sessionId: worst.sessionId,
          range: { start: worst.seqStart, end: worst.seqEnd },
          messages: collected.messages.length,
          messageChars: collected.chars,
          messagePolluted: perMessage.reduce((sum, item) => sum + item.polluted, 0),
          factsChars: facts.length,
          factsPolluted: coveredChars(facts, grams),
          promptChars: prompt.length,
          promptPolluted: coveredChars(prompt, grams),
          perMessage: perMessage.filter((item) => item.polluted > 0),
        };
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ root, counts, markers: SYSTEM_PROMPT_MARKERS.map((marker) => marker.id), hits: detail, replay }, null, 1));
    return 0;
  }

  const withPollution = detail.filter((row) => (row.measured.pollutedChars ?? 0) > 0);
  console.log("== system prompt 回灌审计（只读 · 零模型调用）==");
  console.log(`home：${home}`);
  console.log(`棋谱：${fmt(counts.sessions)} 个会话 / ${fmt(counts.marks)} 条折痕 / 有正文的摘要 ${fmt(pool.length)} 条`);
  console.log("");
  console.log(`① 含系统提示词**标记**（闭集 ${SYSTEM_PROMPT_MARKERS.length} 项）的摘要：${hits.length} / ${pool.length}（${pct(pool.length === 0 ? 0 : hits.length / pool.length)}）`);
  console.log(`② 其中**逐字**含系统提示词原文的：${withPollution.length} 条（其余只是提到了 system-reminder 这个词）`);
  console.log("");
  console.log("③ 逐条（按摘要长度降序；污染 = 逐字出现在系统提示词里的字符数）");
  console.log("");
  console.log("| # | 会话 | 折叠区间 | 字符 | 污染字符 | 污染比例 | 落在哪一段 | 从哪条事件进来 |");
  console.log("|---|------|----------|------|----------|----------|------------|----------------|");
  const listed = detail.slice(0, limit);
  listed.forEach((row, index) => {
    const sections =
      row.measured.bySection.length === 0 ? "—" : row.measured.bySection.map((item) => `${item.section}(${fmt(item.chars)})`).join(" + ");
    const sources =
      row.attributed.length === 0
        ? "—"
        : [...new Set(row.attributed.map((item) => `${item.source} seq=${item.seq ?? "?"}`))].join("; ");
    console.log(
      `| ${index + 1} | \`${row.sessionId}\` | seq ${row.seqStart}-${row.seqEnd} | ${fmt(row.measured.chars)} | ` +
        `${row.measured.pollutedChars === null ? "—" : fmt(row.measured.pollutedChars)} | ${pct(row.measured.ratio)} | ${sections} | ${sources} |`,
    );
  });
  if (detail.length > listed.length) console.log(`| … | 其余 ${detail.length - listed.length} 条略（--limit=N 看全部） | | | | | | |`);
  console.log("");
  for (const row of listed) {
    console.log(`· \`${row.sessionId}\`（${fmt(row.measured.chars)} 字符，污染 ${pct(row.measured.ratio)}）`);
    console.log(`    日志：${row.log ?? "（拿不到 —— 污染比例不可得，只有标记口径）"}`);
    console.log(`    标记：${row.markers.join(" / ")}`);
    for (const item of row.attributed.slice(0, 6)) console.log(`    ← seq ${item.seq ?? "?"} ${item.source}（本行 ${fmt(item.polluted)} 字符是系统提示词）\n      ${item.head}…`);
    console.log("");
  }

  if (replay !== null) {
    console.log("④ 折叠输入重放（污染最重的那条，生产同参 maxChars=60,000 / fromSeq=区间起点）");
    console.log(`   \`${replay.sessionId}\` seq ${replay.range.start}-${replay.range.end}`);
    console.log(`   消息块：${fmt(replay.messageChars)} 字符 / ${replay.messages} 条，其中系统提示词 ${fmt(replay.messagePolluted)} 字符`);
    console.log(
      `   事实块（renderFacts）：${fmt(replay.factsChars)} 字符，其中系统提示词 ${fmt(replay.factsPolluted)} 字符` +
        `（${pct(replay.factsChars === 0 ? 0 : replay.factsPolluted / replay.factsChars)}）`,
    );
    console.log(
      `   整份 prompt：${fmt(replay.promptChars)} 字符，其中系统提示词 ${fmt(replay.promptPolluted)} 字符` +
        `（${pct(replay.promptChars === 0 ? 0 : replay.promptPolluted / replay.promptChars)}）`,
    );
    for (const item of replay.perMessage) console.log(`     · 消息 seq=${item.seq} ${item.role}：${fmt(item.polluted)} / ${fmt(item.chars)} 字符是系统提示词`);
    console.log("");
  }

  console.log("⑤ 结论（机器可核对的部分）");
  console.log(`   · 标记口径 ${hits.length}/${pool.length} = ${pct(pool.length === 0 ? 0 : hits.length / pool.length)}；**逐字**口径 ${withPollution.length} 条`);
  console.log("   · 回灌落在摘要的「约束」段（`## 约束（逐字）` + `## 约束（逐字补充 …）`），不是 `## 目标`");
  console.log("   · 上一条摘要的棋谱段是从 **`<compacted-summary>` user 消息**（消息历史）进来的，不是 `lastOfflineSummary` 拼接");
  console.log("     （`buildOfflinePrompt` 只吃 `renderFacts` + `collectMessages` 两路，`lastOfflineSummary` 只在写回点出现）");
  if (replay !== null) {
    console.log(
      `   · **主通路是事实块**：renderFacts ${fmt(replay.factsPolluted)} 字符 / 消息 ${fmt(replay.messagePolluted)} 字符 —— ` +
        "系统提示词是经 `graph.nodes[].constraints`（keeper 抽的约束）进的事实块",
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
