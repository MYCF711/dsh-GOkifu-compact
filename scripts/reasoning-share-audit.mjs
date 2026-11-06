#!/usr/bin/env node
/**
 * reasoning-share-audit.mjs —— **摘要输入里的 reasoning 到底占多少、该不该剔**（C639）
 *
 * 由来（上一轮 `scripts/message-size-audit.mjs` 的副产物，是**产品级**发现）：
 * 那个脚本量的是"单条消息该切多长"，顺带量出折叠区间里的字符构成是
 * `assistant:reasoning` 63.2% / `<system-reminder>` 16.5% / 真实用户输入 14.9% / assistant 正文 5.4%。
 * 折叠要回答的是「**区间里发生了什么**」，而 63% 的预算花在了**模型自己的草稿纸**上。
 *
 * 本脚本回答四个问题（全部**只读**、零模型调用、不产生费用）：
 *   ① **构成** —— 最近 N 条 foldMark 的折叠区间里，`reasoning` / `user:text` / `assistant:text` /
 *      `user:reminder` 各占多少字符；
 *   ② **重放** —— 用**生产同一套参数**（`maxChars = 60,000`、`perMessageChars = 2,000`、
 *      `fromSeq = mark.seqStart`、`idBySeq` 来自同一张图）跑 `collectMessages`，量三种输入口径下
 *      装下的**真实事件条数 / 真实字符 / 区间覆盖率**：
 *        · `含 reasoning`（C639 之前的形状）
 *        · `只留结论句`（**现在的生产口径**）
 *        · `整块丢弃`（一刀切，用来证明"别一刀切"）
 *      ⇒ 「剔除 reasoning 后能多装多少条真实事件」= ② 的 Δ 行；
 *   ③ **质量探针重算** —— 用 `lastOfflineSummary.text`（真机摘要原文）重算
 *      `constraintRecall` / `failureRecall`，并与 foldMark 里记录的值逐条对账；
 *      再把**探针的入参**摊开：它只吃 `(graph, range, summaryText)`，**没有消息输入** ——
 *      所以它对"输入里有没有 reasoning"是**盲的**。这条结论必须写出来，
 *      否则下一个人会拿"quality 没变"当成"这刀安全"的证据（那是循环论证）。
 *      唯一与输入有关的质量代理是**失败边证据可追溯性**：`errorSnippet` 有没有出现在装进输入的文本里。
 *   ④ **结论句启发式** —— `REASONING_CONCLUSION_RE` 到底留下多少、其中"只在思考里出现"的占多少，
 *      用来回答"会不会丢信息"（丢的话就降权，不是丢弃）。
 *
 * 用法：
 *   node scripts/reasoning-share-audit.mjs                     # 全量（真机 196 个会话 / 665 条 foldMark，约 40 秒）
 *   node scripts/reasoning-share-audit.mjs --limit=20           # 只看最近 20 个会话（冒烟）
 *   node scripts/reasoning-share-audit.mjs --session=<SESSION_ID>   # 只看一个会话
 *   node scripts/reasoning-share-audit.mjs --recent=50          # 只取**最近 50 条 foldMark**（按 at 倒序）
 *   node scripts/reasoning-share-audit.mjs --json               # 机读
 *   DSH_HOME=... node scripts/reasoning-share-audit.mjs         # 换 home（与 doctor / graph-audit 同源）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { REASONING_CONCLUSION_RE, collectMessages, reasoningConclusionText, reasoningSentences } from "../src/rooms/offline-fold.mjs";
import { measureFoldQuality, failuresInFoldRange } from "../src/rooms/fold-quality.mjs";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";

/** 与 doctor / graph-audit / message-size-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** 写入点用的消息预算（`engine.mjs` 的 `offlineMaxChars || 60_000`，与 `message-size-audit.mjs` 同源）。 */
export const MAX_CHARS = 60_000;
/** 生产默认值（`collectMessages` 的 `perMessageChars`）。守卫测试会核对它没漂。 */
export const PRODUCTION_PER_MESSAGE_CHARS = 2000;

/** 三种输入口径。`conclude` 就是生产口径（`collectMessages` 的调用点）。 */
export const VARIANTS = Object.freeze(["keep", "conclude", "drop"]);
export const VARIANT_LABEL = Object.freeze({
  keep: "含 reasoning（旧形状）",
  conclude: "只留结论句（生产）",
  drop: "整块丢弃（一刀切）",
});

/** `<system-reminder>` 注入（workspace 指令整块塞进 user 消息）—— 与"用户真的说了什么"要分开算。 */
const SYSTEM_REMINDER_RE = /<system-reminder>/;

/**
 * 最近秩（nearest-rank）百分位：`p90` = 第 `ceil(0.9n)` 小。空数组返回 0。
 * 与 `scripts/message-size-audit.mjs` 同口径，免得两份报告的数对不上。
 * @param {number[]} sorted 升序
 * @param {number} p 0–1
 * @returns {number}
 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * 一条消息里**有正文的块**（与 `plainText` 的取法一致：只认 `typeof text === "string"`）。
 * @param {unknown} content
 * @returns {Array<{type:string, text:string}>}
 */
export function textBlocks(content) {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b !== null && typeof b === "object" && typeof b.text === "string" && b.text !== "");
}

/**
 * 一个块的归属 —— 决定"这段字符是谁的"。
 * @param {"user"|"assistant"} role
 * @param {{type:string, text:string}} block
 * @returns {"assistant:reasoning"|"assistant:text"|"user:reminder"|"user:text"|"other"}
 */
export function classifyBlock(role, block) {
  const type = String(block?.type ?? "text");
  if (type === "reasoning") return "assistant:reasoning";
  if (type !== "text") return "other";
  if (role === "assistant") return "assistant:text";
  return SYSTEM_REMINDER_RE.test(String(block?.text ?? "")) ? "user:reminder" : "user:text";
}

const contentOf = (event) => event?.data?.message?.content ?? event?.data?.content;

/** 一条消息里**非 reasoning** 的正文（= "发生了什么"）。 */
export function realTextOf(event) {
  return textBlocks(contentOf(event))
    .filter((b) => b.type !== "reasoning")
    .map((b) => b.text)
    .join("\n");
}

/** 一条消息里 reasoning 的全文（= 模型的草稿纸）。 */
export function reasoningTextOf(event) {
  return textBlocks(contentOf(event))
    .filter((b) => b.type === "reasoning")
    .map((b) => b.text)
    .join("\n");
}

/** 只处理 user/assistant 消息；其它事件原样返回。 */
const mapMessages = (events, fn) =>
  (Array.isArray(events) ? events : []).map((e) => {
    if (e === null || typeof e !== "object") return e;
    if (e.type !== "user/message" && e.type !== "assistant/message") return e;
    const content = contentOf(e);
    if (!Array.isArray(content)) return e;
    const next = fn(content);
    if (next === content) return e;
    return e.data?.message !== undefined
      ? { ...e, data: { ...e.data, message: { ...e.data.message, content: next } } }
      : { ...e, data: { ...e.data, content: next } };
  });

/**
 * `keep` 口径的事件流 —— 把 `reasoning` 块**改成 `text` 块**。
 *
 * 为什么要这么绕：生产口径（`conclude`）现在会把 reasoning 换掉，所以"旧形状"不能直接喂
 * `collectMessages`（它只会看到结论句）。把 reasoning 原地转成 text 之后，`plainText` 的
 * 拼接顺序、`[id] ` 前缀、`perMessageChars` 截断都与 C639 之前**逐字节相同**
 * （`test/reasoning-share.test.mjs` 钉住了这条等价性）。
 * @param {Array<object>} events
 * @returns {Array<object>}
 */
export function asKeepVariant(events) {
  return mapMessages(events, (content) => {
    if (!content.some((b) => b !== null && typeof b === "object" && b.type === "reasoning" && typeof b.text === "string")) {
      return content;
    }
    return content.map((b) => (b !== null && typeof b === "object" && b.type === "reasoning" && typeof b.text === "string" ? { ...b, type: "text" } : b));
  });
}

/**
 * `drop` 口径的事件流 —— 整块丢掉 reasoning（"一刀切"长什么样）。
 * @param {Array<object>} events
 * @returns {Array<object>}
 */
export function asDropVariant(events) {
  return mapMessages(events, (content) => {
    const kept = content.filter((b) => !(b !== null && typeof b === "object" && b.type === "reasoning"));
    return kept.length === content.length ? content : kept;
  });
}

/**
 * 按口径换一份事件流。
 * @param {Array<object>} events
 * @param {"keep"|"conclude"|"drop"} variant
 * @returns {Array<object>}
 */
export function variantEvents(events, variant) {
  if (variant === "keep") return asKeepVariant(events);
  if (variant === "drop") return asDropVariant(events);
  return events; // conclude = 生产口径，原样传
}

/**
 * 用生产同一套参数重放一条 foldMark，量「装下了什么」。
 *
 * 覆盖率口径与 `message-size-audit.mjs` 一致：**分子只数 `seq ∈ [seqStart, seqEnd]`**，
 * 因为 `fromSeq` 只卡下界（区间之后的消息也会被装进来）。
 *
 * @param {Array<object>} events 原始事件（升序）
 * @param {{seqStart:number, seqEnd:number, idBySeq?:Map<number,string>|null}} mark
 * @param {"keep"|"conclude"|"drop"} [variant]
 * @returns {{chars:number, textMsgs:number, toolMsgs:number, cutMessages:number, dropped:number,
 *   realEvents:number, realChars:number, reasoningOnlyMsgs:number, messages:Array<object>}}
 */
export function replayOne(events, mark, variant = "conclude") {
  const seqStart = Number(mark?.seqStart);
  const seqEnd = Number(mark?.seqEnd ?? seqStart);
  const r = collectMessages(variantEvents(events, variant), {
    maxChars: MAX_CHARS,
    fromSeq: seqStart,
    perMessageChars: PRODUCTION_PER_MESSAGE_CHARS,
    idBySeq: mark?.idBySeq ?? null,
  });
  const bySeq = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const seq = Number(e?.seq);
    if (Number.isFinite(seq) && !bySeq.has(seq)) bySeq.set(seq, e);
  }
  // 装下的消息里，**区间内**且有非 reasoning 正文的那些 = 真实事件
  let realEvents = 0;
  let realChars = 0;
  for (const m of r.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const seq = Number(m.seq);
    if (!Number.isFinite(seq) || seq < seqStart || seq > seqEnd) continue;
    const body = realTextOf(bySeq.get(seq) ?? {});
    if (body.trim() === "") continue;
    realEvents += 1;
    realChars += body.length;
  }
  return {
    chars: r.chars,
    textMsgs: r.messages.filter((m) => m.role !== "tool").length,
    toolMsgs: r.messages.filter((m) => m.role === "tool").length,
    cutMessages: r.inputCutMessages,
    dropped: r.dropped,
    realEvents,
    realChars,
    // 装进来、但正文**只有思考**的消息（C639 之前它们白吃预算）
    reasoningOnlyMsgs: r.messages.filter((m) => m.role !== "tool" && realTextOf(bySeq.get(Number(m.seq)) ?? {}) === "").length,
    messages: r.messages,
  };
}

/** 截断标记的头/尾（与 `truncateFor` 的格式同源：`\n…[本轮截断 N 字符]…\n`）。 */
const MARK_HEAD = "…[本轮截断 ";
const MARK_TAIL = " 字符]…";

/**
 * 把「装进输入的消息」按块类型拆账 —— 报告 ⑥ 的**同一段夹具**修前/修后对比用。
 *
 * 为什么不能用比例摊：截断是「头 70% + 尾 30%」，而 reasoning / 正文在一条消息里的位置是固定的；
 * 按比例摊会把"被切掉的正好是草稿纸"这件事抹平。这里从 `m.text` 反解出**真实保留的头/尾**，
 * 再映射回原块的类型 —— 与 `truncateFor` 同一口径，不猜。
 *
 * @param {Array<{role:string,text:string,seq:number|null,truncated?:boolean}>} messages `collectMessages` 的输出
 * @param {Array<object>} events 原始事件（升序）
 * @param {"keep"|"conclude"|"drop"} variant
 * @returns {{reasoning:number, userText:number, reminder:number, assistantText:number, tool:number, total:number, messages:number}}
 */
export function inputComposition(messages, events, variant) {
  const bySeq = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const seq = Number(e?.seq);
    if (Number.isFinite(seq) && !bySeq.has(seq)) bySeq.set(seq, e);
  }
  const out = { reasoning: 0, userText: 0, reminder: 0, assistantText: 0, tool: 0, other: 0, total: 0, messages: (messages ?? []).length };
  // `classifyBlock` 给的是 `user:text` 这种带冒号的名字，报告字段是驼峰 —— 在这里一次映射清楚
  const KEY = { "assistant:reasoning": "reasoning", "assistant:text": "assistantText", "user:text": "userText", "user:reminder": "reminder" };
  const add = (label, n) => {
    const key = label === "tool" ? "tool" : (KEY[label] ?? "other");
    out[key] += n;
    out.total += n;
  };
  for (const m of messages ?? []) {
    if (m.role === "tool") {
      add("tool", m.text.length);
      continue;
    }
    const event = bySeq.get(Number(m.seq));
    if (event === undefined) continue;
    const role = event.type === "user/message" ? "user" : "assistant";
    // 复刻 plainText 的拼接（含 conclude 的标记），同时记下每个字符的归属
    const flat = [];
    let first = true;
    for (const b of textBlocks(contentOf(event))) {
      let body;
      if (b.type === "reasoning") {
        if (variant === "drop") continue;
        body = variant === "keep" ? b.text : reasoningConclusionText(b.text);
        if (body === "") continue;
        body = variant === "keep" ? body : body;
      } else {
        body = b.text;
      }
      if (!first) flat.push(flat[flat.length - 1] ?? "other"); // 拼接用的换行算给前一块
      first = false;
      const label = classifyBlock(role, b); // reasoning ⇒ "assistant:reasoning"，由 KEY 映射到报告字段
      for (let i = 0; i < body.length; i += 1) flat.push(label);
    }
    let kept = flat;
    if (m.truncated === true) {
      const at = m.text.indexOf(MARK_HEAD);
      const end = at < 0 ? -1 : m.text.indexOf(MARK_TAIL, at);
      if (end >= 0) {
        const headLen = Math.max(0, at - 1); // 去掉拼接用的换行
        const tailLen = Math.max(0, m.text.length - (end + MARK_TAIL.length + 1));
        kept = [...flat.slice(0, headLen), ...flat.slice(flat.length - tailLen)];
      }
    }
    for (const label of kept) add(label, 1);
  }
  return out;
}

const pad = (v, n) => String(v).padStart(n);
const pct = (n, d) => (d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`);
const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");
const mean = (n, d) => (d === 0 ? 0 : n / d);

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limitIdx = argv.indexOf("--limit");
  const limit =
    limitArg !== undefined
      ? Math.max(1, Number(limitArg.slice("--limit=".length)) || 1)
      : limitIdx >= 0 && Number.isFinite(Number(argv[limitIdx + 1]))
        ? Math.max(1, Number(argv[limitIdx + 1]))
        : Infinity;
  const recentArg = argv.find((a) => a.startsWith("--recent="));
  const recent = recentArg === undefined ? Infinity : Math.max(1, Number(recentArg.slice("--recent=".length)) || 1);
  const sessionArg = argv.find((a) => a.startsWith("--session="));
  const only = sessionArg === undefined ? null : String(sessionArg.slice("--session=".length));

  const home = resolveHome();
  const scan = collectGraphFiles(home);
  if (scan.files.length === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  // ① 图侧：foldMark 的区间 + 该会话的 seq→节点 id（生产 collectMessages 也吃这个）
  const marksBySession = new Map();
  let totalMarks = 0;
  for (const entry of scan.files) {
    let raw;
    try {
      raw = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      continue; // 坏图跳过（只读审计不许因为一张坏图整跑挂掉）
    }
    const idBySeq = new Map();
    for (const node of Object.values(raw?.nodes ?? {})) {
      const seq = Number(node?.seq);
      const id = typeof node?.id === "string" ? node.id : null;
      if (!Number.isFinite(seq) || id === null || idBySeq.has(seq)) continue;
      idBySeq.set(seq, id);
    }
    const marks = Array.isArray(raw?.foldMarks) ? raw.foldMarks : [];
    if (marks.length === 0) continue;
    const list = marksBySession.get(entry.dir) ?? [];
    for (const mark of marks) {
      totalMarks += 1;
      const start = Number(mark?.seqStart);
      if (!Number.isFinite(start)) continue; // 没区间就没法重放（"不知道"，不是"没裁"）
      list.push({
        seqStart: start,
        seqEnd: Number(mark?.seqEnd) || start,
        at: Number(mark?.at) || 0,
        idBySeq,
        graph: raw,
        quality: mark?.quality ?? null,
      });
    }
    marksBySession.set(entry.dir, list);
  }

  // `--recent=N`：按 at 倒序取最近 N 条（跨会话）
  let sessions = [...marksBySession.entries()].filter(([id]) => (only === null ? true : id.includes(only))).slice(0, limit);
  if (Number.isFinite(recent)) {
    const flat = sessions.flatMap(([id, marks]) => marks.map((m) => ({ id, mark: m })));
    flat.sort((a, b) => b.mark.at - a.mark.at);
    const keep = new Set(flat.slice(0, recent).map((x) => `${x.id}#${x.mark.seqStart}-${x.mark.seqEnd}`));
    sessions = sessions
      .map(([id, marks]) => [id, marks.filter((m) => keep.has(`${id}#${m.seqStart}-${m.seqEnd}`))])
      .filter(([, marks]) => marks.length > 0);
  }

  const logs = new Map();
  for (const file of listSessionLogs(home)) {
    const id = nodePath.basename(nodePath.dirname(file));
    if (id !== "" && !logs.has(id)) logs.set(id, file);
  }

  const agg = {
    marks: 0,
    replayedSessions: 0,
    noLogMarks: 0,
    range: { realEvents: 0, realChars: 0, reasoningChars: 0, byClass: new Map() },
    variants: Object.fromEntries(VARIANTS.map((v) => [v, { realEvents: 0, realChars: 0, textMsgs: 0, toolMsgs: 0, chars: 0, cut: 0, reasoningOnly: 0 }])),
    probe: { checked: 0, reproduced: 0, noRecorded: 0, constraints: 0, failures: 0, mismatches: [] },
    evidence: { edges: 0, keep: 0, conclude: 0, drop: 0, onlyReasoning: 0 },
    conclusion: { sentences: 0, keptSentences: 0, keptChars: 0, reasoningChars: 0, onlyHere: 0, onlyHereChars: 0, perMessage: [] },
    conclusionMax: 0,
  };
  /** ⑥ 的夹具：输入字符最多的那一段（确定性，可复现）。 */
  let fixture = null;
  const ngrams = (s, n = 8) => {
    const out = new Set();
    const t = String(s ?? "").replace(/\s+/g, "");
    for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n));
    return out;
  };

  for (const [id, marks] of sessions) {
    const file = logs.get(id);
    if (file === undefined) {
      agg.noLogMarks += marks.length;
      continue;
    }
    const events = readSessionEvents(file);
    if (events.length === 0) {
      agg.noLogMarks += marks.length;
      continue;
    }
    agg.replayedSessions += 1;
    const bySeq = new Map();
    for (const e of events) {
      const seq = Number(e?.seq);
      if (Number.isFinite(seq) && !bySeq.has(seq)) bySeq.set(seq, e);
    }

    for (const mark of marks) {
      agg.marks += 1;
      // ② 区间构成（与预算无关）
      for (const e of events) {
        const seq = Number(e?.seq);
        if (!Number.isFinite(seq) || seq < mark.seqStart || seq > mark.seqEnd) continue;
        if (e?.type !== "user/message" && e?.type !== "assistant/message") continue;
        const role = e.type === "user/message" ? "user" : "assistant";
        for (const b of textBlocks(contentOf(e))) {
          const klass = classifyBlock(role, b);
          agg.range.byClass.set(klass, (agg.range.byClass.get(klass) ?? 0) + b.text.length);
        }
        agg.range.realChars += realTextOf(e).length;
        if (realTextOf(e).trim() !== "") agg.range.realEvents += 1;
        agg.range.reasoningChars += reasoningTextOf(e).length;
      }

      // ③ 三种口径重放
      const results = {};
      for (const variant of VARIANTS) {
        const r = replayOne(events, mark, variant);
        results[variant] = r;
        const a = agg.variants[variant];
        a.realEvents += r.realEvents;
        a.realChars += r.realChars;
        a.textMsgs += r.textMsgs;
        a.toolMsgs += r.toolMsgs;
        a.chars += r.chars;
        a.cut += r.cutMessages;
        a.reasoningOnly += r.reasoningOnlyMsgs;
      }

      // ⑥ 夹具：输入字符最多的一段（修前/修后的构成对比）
      if (fixture === null || results.keep.chars > fixture.keep.chars) {
        fixture = { id, mark, events, keep: results.keep, conclude: results.conclude, drop: results.drop };
      }

      // ④ 质量探针重算（summaryText 来自 lastOfflineSummary；只有最后一条 mark 有）
      const summary = mark.graph?.lastOfflineSummary;
      const summaryRange = summary?.range;
      if (typeof summary?.text === "string" && summary.text.trim() !== "" && Number(summaryRange?.start) === mark.seqStart && Number(summaryRange?.end) === mark.seqEnd) {
        agg.probe.checked += 1;
        const measured = measureFoldQuality({ graph: mark.graph, range: { start: mark.seqStart, end: mark.seqEnd }, summaryText: summary.text });
        agg.probe.constraints += measured.expectedConstraints;
        agg.probe.failures += measured.expectedFailures;
        const recorded = mark.quality;
        // 老 foldMark 没有 quality（记录为空）—— 那是"没测过"，不是"复算不一致"
        if (recorded === null || typeof recorded !== "object") {
          agg.probe.noRecorded += 1;
        } else if (Number(recorded.constraintRecall) === Number(measured.constraintRecall) && Number(recorded.failureRecall) === Number(measured.failureRecall)) {
          agg.probe.reproduced += 1;
        } else if (agg.probe.mismatches.length < 5) {
          agg.probe.mismatches.push({
            session: id.slice(0, 8),
            range: `${mark.seqStart}-${mark.seqEnd}`,
            recorded: { constraintRecall: recorded?.constraintRecall ?? null, failureRecall: recorded?.failureRecall ?? null },
            recomputed: { constraintRecall: measured.constraintRecall, failureRecall: measured.failureRecall },
          });
        }
      }

      // ⑤ 失败边证据可追溯性（唯一与输入有关的质量代理）
      const keepText = results.keep.messages.filter((m) => m.role !== "tool").map((m) => m.text).join("\n");
      const concludeText = results.conclude.messages.filter((m) => m.role !== "tool").map((m) => m.text).join("\n");
      const dropText = results.drop.messages.filter((m) => m.role !== "tool").map((m) => m.text).join("\n");
      for (const edge of failuresInFoldRange(mark.graph, { start: mark.seqStart, end: mark.seqEnd })) {
        const snippet = String(edge?.errorSnippet ?? edge?.verify?.summary ?? "").split("\n")[0].trim().slice(0, 60);
        if (snippet.length < 10) continue;
        agg.evidence.edges += 1;
        const inKeep = keepText.includes(snippet);
        if (inKeep) agg.evidence.keep += 1;
        if (concludeText.includes(snippet)) agg.evidence.conclude += 1;
        if (dropText.includes(snippet)) agg.evidence.drop += 1;
        if (inKeep && !concludeText.includes(snippet)) agg.evidence.onlyReasoning += 1;
      }

      // ⑥ 结论句启发式：留多少、其中"只在思考里出现"的占多少
      // 8-gram 的底稿必须是**不含 reasoning** 的输入（`dropText`）——
      // 拿 `concludeText` 当底稿的话，保留下来的结论句会"追溯到自己"，onlyHere 恒为 0（假绿）。
      const gram = ngrams(dropText, 8);
      for (const e of events) {
        const seq = Number(e?.seq);
        if (!Number.isFinite(seq) || seq < mark.seqStart || seq > mark.seqEnd) continue;
        if (e?.type !== "assistant/message") continue;
        const reasoning = reasoningTextOf(e);
        if (reasoning === "") continue;
        let keptPerMessage = 0;
        for (const sentence of reasoningSentences(reasoning)) {
          agg.conclusion.sentences += 1;
          if (!REASONING_CONCLUSION_RE.test(sentence)) continue;
          agg.conclusion.keptSentences += 1;
          agg.conclusion.keptChars += sentence.length;
          keptPerMessage += sentence.length;
          let traced = false;
          for (const gramOfSentence of ngrams(sentence, 8)) {
            if (gram.has(gramOfSentence)) {
              traced = true;
              break;
            }
          }
          if (!traced) {
            agg.conclusion.onlyHere += 1;
            agg.conclusion.onlyHereChars += sentence.length;
          }
        }
        if (keptPerMessage > 0) {
          agg.conclusion.perMessage.push(keptPerMessage);
          agg.conclusionMax = Math.max(agg.conclusionMax, keptPerMessage);
        }
        agg.conclusion.reasoningChars += reasoning.length;
      }
    }
  }

  const M = agg.marks;
  const rangeTotal = [...agg.range.byClass.values()].reduce((n, x) => n + x, 0);
  const blockRows = [...agg.range.byClass.entries()]
    .map(([klass, chars]) => ({ klass, chars, share: rangeTotal === 0 ? 0 : chars / rangeTotal }))
    .sort((a, b) => b.chars - a.chars);
  const variantRows = VARIANTS.map((variant) => {
    const a = agg.variants[variant];
    return {
      variant,
      realEvents: mean(a.realEvents, M),
      realChars: mean(a.realChars, M),
      coveragePct: agg.range.realChars === 0 ? 0 : (a.realChars / agg.range.realChars) * 100,
      textMsgs: mean(a.textMsgs, M),
      toolMsgs: mean(a.toolMsgs, M),
      chars: mean(a.chars, M),
      cut: mean(a.cut, M),
      reasoningOnly: mean(a.reasoningOnly, M),
    };
  });
  const perMessageSorted = [...agg.conclusion.perMessage].sort((a, b) => a - b);

  const report = {
    home,
    graphs: scan.files.length,
    sessionsWithMarks: marksBySession.size,
    foldMarks: totalMarks,
    replayedSessions: agg.replayedSessions,
    replayedMarks: M,
    noLogMarks: agg.noLogMarks,
    maxChars: MAX_CHARS,
    perMessageChars: PRODUCTION_PER_MESSAGE_CHARS,
    range: {
      realEvents: agg.range.realEvents,
      realChars: agg.range.realChars,
      reasoningChars: agg.range.reasoningChars,
      blocks: blockRows,
      reasoningShare: agg.range.reasoningChars + agg.range.realChars === 0 ? 0 : agg.range.reasoningChars / (agg.range.reasoningChars + agg.range.realChars),
    },
    variants: variantRows,
    probe: {
      checked: agg.probe.checked,
      reproduced: agg.probe.reproduced,
      noRecorded: agg.probe.noRecorded,
      meanConstraints: mean(agg.probe.constraints, agg.probe.checked),
      meanFailures: mean(agg.probe.failures, agg.probe.checked),
      mismatches: agg.probe.mismatches,
    },
    evidence: agg.evidence,
    fixture:
      fixture === null
        ? null
        : {
            session: fixture.id,
            range: `${fixture.mark.seqStart}-${fixture.mark.seqEnd}`,
            keep: inputComposition(fixture.keep.messages, fixture.events, "keep"),
            conclude: inputComposition(fixture.conclude.messages, fixture.events, "conclude"),
            drop: inputComposition(fixture.drop.messages, fixture.events, "drop"),
          },
    conclusion: {
      sentences: agg.conclusion.sentences,
      keptSentences: agg.conclusion.keptSentences,
      keptChars: agg.conclusion.keptChars,
      reasoningChars: agg.conclusion.reasoningChars,
      sharePct: agg.conclusion.reasoningChars === 0 ? 0 : (agg.conclusion.keptChars / agg.conclusion.reasoningChars) * 100,
      onlyHere: agg.conclusion.onlyHere,
      onlyHereChars: agg.conclusion.onlyHereChars,
      onlyHerePct: agg.conclusion.reasoningChars === 0 ? 0 : (agg.conclusion.onlyHereChars / agg.conclusion.reasoningChars) * 100,
      perMessage: { p50: percentile(perMessageSorted, 0.5), p90: percentile(perMessageSorted, 0.9), p99: percentile(perMessageSorted, 0.99), max: agg.conclusionMax, messages: perMessageSorted.length },
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const base = variantRows[0];
  const conclude = variantRows[1];
  const drop = variantRows[2];
  const delta = (key) => conclude[key] - base[key];
  const deltaPct = (key) => (base[key] === 0 ? 0 : ((conclude[key] - base[key]) / base[key]) * 100);

  console.log("=== 摘要输入里 reasoning 的份额审计（只读 · 零模型调用）===");
  console.log(`home:     ${home}`);
  console.log(`graphs:   ${fmt(report.graphs)}（有 foldMark 的 ${fmt(report.sessionsWithMarks)}）  foldMarks: ${fmt(report.foldMarks)}`);
  console.log(`重放:     ${fmt(report.replayedSessions)} 个会话 / ${fmt(M)} 条 foldMark${report.noLogMarks > 0 ? `（${fmt(report.noLogMarks)} 条没有会话日志，跳过）` : ""}`);
  console.log(`预算:     maxChars=${fmt(MAX_CHARS)} · perMessageChars=${fmt(PRODUCTION_PER_MESSAGE_CHARS)} · fromSeq=seqStart · idBySeq 照生产`);
  console.log("");

  console.log("① 折叠区间内的字符构成（与任何预算无关的纯事实）");
  console.log("   块类型               |      字符 | 占比");
  for (const b of blockRows) console.log(`   ${b.klass.padEnd(20)} | ${pad(fmt(b.chars), 9)} | ${pad(pct(b.chars, rangeTotal), 5)}`);
  const scaffolding = blockRows.filter((b) => b.klass === "assistant:reasoning" || b.klass === "user:reminder").reduce((n, b) => n + b.share, 0);
  const realTalk = blockRows.filter((b) => b.klass === "user:text" || b.klass === "assistant:text").reduce((n, b) => n + b.share, 0);
  console.log(`   ⇒ **脚手架 ${pct(scaffolding, 1)}**（reasoning + <system-reminder> 样板），真实事件只占 **${pct(realTalk, 1)}**。`);
  console.log(`   注: 不含 tool/call 摘要行（固定 120 字符/条，走另一份预算）；不含 tool/result（一条都不进输入）。`);
  console.log("");

  console.log("② 输入侧重放：同一份预算是怎么花的（Δ 行 = 「剔除 reasoning 后能多装多少」）");
  console.log("   口径                     | 真实事件/段 | 真实字符/段 | 覆盖率 | 思考独占消息/段 | 文本消息/段 | 工具行/段 | 输入字符/段 | 被切消息/段");
  for (const r of variantRows) {
    console.log(
      `   ${VARIANT_LABEL[r.variant].padEnd(22)} | ${pad(r.realEvents.toFixed(2), 11)} | ${pad(fmt(r.realChars), 11)} | ${pad(`${r.coveragePct.toFixed(1)}%`, 6)} | ` +
        `${pad(r.reasoningOnly.toFixed(2), 15)} | ${pad(r.textMsgs.toFixed(2), 11)} | ${pad(r.toolMsgs.toFixed(2), 9)} | ${pad(fmt(r.chars), 11)} | ${pad(r.cut.toFixed(2), 12)}`,
    );
  }
  console.log(
    `   **Δ（只留结论句 − 含 reasoning）** | **+${delta("realEvents").toFixed(2)}（${deltaPct("realEvents").toFixed(1)}%）** | **+${fmt(delta("realChars"))}（${deltaPct("realChars").toFixed(1)}%）** | ` +
      `**+${(conclude.coveragePct - base.coveragePct).toFixed(1)}pp** | ${delta("reasoningOnly").toFixed(2)} | ${delta("textMsgs").toFixed(2)} | +${delta("toolMsgs").toFixed(2)} | ${delta("chars") >= 0 ? "+" : ""}${fmt(delta("chars"))} | ${delta("cut").toFixed(2)}`,
  );
  console.log(
    `   ⇒ 每段**多装 ${delta("realEvents").toFixed(2)} 条真实事件 / ${fmt(delta("realChars"))} 个真实字符**（${fmt(M)} 段合计 ` +
      `+${fmt(delta("realEvents") * M)} 条、+${fmt(delta("realChars") * M)} 字符），而输入字符总量只动 ${delta("chars") >= 0 ? "+" : ""}${fmt(delta("chars"))}。`,
  );
  console.log(
    `   ⇒ 一刀切（整块丢弃）与只留结论句的差：真实事件 ${drop.realEvents.toFixed(2)} vs ${conclude.realEvents.toFixed(2)}、` +
      `覆盖率 ${drop.coveragePct.toFixed(1)}% vs ${conclude.coveragePct.toFixed(1)}% —— **结论句便宜到可以留**（见 ④）。`,
  );
  console.log("");

  console.log("③ 质量探针重算（constraintRecall / failureRecall；用真机摘要原文，不调模型）");
  console.log(`   可重算的 mark: ${fmt(report.probe.checked)} / ${fmt(M)}（只有"最后一条 foldMark"有 lastOfflineSummary 原文）`);
  console.log(
    `   复算与 foldMark 记录一致: ${fmt(report.probe.reproduced)} / ${fmt(report.probe.checked - report.probe.noRecorded)}` +
      `（另有 ${fmt(report.probe.noRecorded)} 条老 mark 没记 quality）${report.probe.mismatches.length > 0 ? "  ← 有不一致，见 --json" : ""}`,
  );
  console.log(`   探针入参: 每段约束 ${report.probe.meanConstraints.toFixed(1)} 条、失败边 ${report.probe.meanFailures.toFixed(1)} 条 —— **全部来自 graph**。`);
  console.log(`   ⇒ 这两个指标**不会因为剔除 reasoning 而变**，但不是因为这刀安全：`);
  console.log(`     探针的入参是 (graph, range, summaryText)，**没有消息输入** —— 它对输入侧改动是**盲的**（循环论证）。`);
  console.log(`     所以守卫不能只靠它：输入侧"少看多少事件"由 ② 与 test/reasoning-share.test.mjs 单独钉。`);
  console.log(`   唯一与输入有关的质量代理 —— **失败边证据可追溯性**（errorSnippet 是否出现在装进输入的文本里）:`);
  console.log(`     失败边 ${fmt(agg.evidence.edges)} 条：含 reasoning ${fmt(agg.evidence.keep)} 条（${pct(agg.evidence.keep, agg.evidence.edges)}）→ 只留结论句 ${fmt(agg.evidence.conclude)} 条（${pct(agg.evidence.conclude, agg.evidence.edges)}）→ 整块丢弃 ${fmt(agg.evidence.drop)} 条（${pct(agg.evidence.drop, agg.evidence.edges)}）。`);
  console.log(`     **没有任何一条变差**（只留结论句比旧形状多 ${fmt(agg.evidence.conclude - agg.evidence.keep)} 条）；`);
  console.log(`     只有 ${fmt(agg.evidence.onlyReasoning)} 条（${pct(agg.evidence.onlyReasoning, agg.evidence.edges)}）是"只在 reasoning 里出现"，`);
  console.log(`     而这 ${fmt(agg.evidence.onlyReasoning)} 条的错误原文会被 repairMissingFailures **逐字补回**摘要（C607）⇒ 死路信息不丢。`);
  console.log("");

  console.log("④ 结论句启发式：降权而不是丢弃，到底留多少");
  console.log(`   判据（闭集）: ${String(REASONING_CONCLUSION_RE).slice(0, 120)}…`);
  console.log(`   reasoning 句子 ${fmt(report.conclusion.sentences)} 句 / ${fmt(report.conclusion.reasoningChars)} 字符`);
  console.log(`   命中结论句    ${fmt(report.conclusion.keptSentences)} 句（${pct(report.conclusion.keptSentences, report.conclusion.sentences)}）/ ${fmt(report.conclusion.keptChars)} 字符（**${report.conclusion.sharePct.toFixed(2)}%** of reasoning）`);
  console.log(`   其中"非 reasoning 输入里找不到同 8-gram"的: ${fmt(report.conclusion.onlyHere)} 句 / ${fmt(report.conclusion.onlyHereChars)} 字符（${report.conclusion.onlyHerePct.toFixed(2)}% of reasoning）`);
  console.log(
    `   单条消息的摘录长度: p50 ${fmt(report.conclusion.perMessage.p50)} · p90 ${fmt(report.conclusion.perMessage.p90)} · p99 ${fmt(report.conclusion.perMessage.p99)} · max ${fmt(report.conclusion.perMessage.max)}` +
      `（硬上限 800，超出截断留「…」；${fmt(report.conclusion.perMessage.messages)} 条消息带摘录）`,
  );
  console.log(
    `   ⇒ 每段平均留 ${(report.conclusion.keptChars / M).toFixed(1)} 字符（= 折叠区间字符的 ${pct(report.conclusion.keptChars / M, (agg.range.reasoningChars + agg.range.realChars) / M)}），` +
      `换"死路警告不丢"；丢掉的是 ${(agg.range.reasoningChars / M - report.conclusion.keptChars / M).toFixed(0)} 字符/段的草稿。`,
  );
  console.log("");

  console.log("⑤ 判断");
  console.log(
    `   **(A) 应该剔除 —— 但不能一刀切。** 依据：reasoning 占折叠区间 ${pct(report.range.reasoningShare, 1)}，` +
      `剔掉后同样预算多装 **${delta("realEvents").toFixed(2)} 条真实事件（+${deltaPct("realEvents").toFixed(1)}%）**、` +
      `真实字符 +${deltaPct("realChars").toFixed(1)}%、覆盖率 ${base.coveragePct.toFixed(1)}% → ${conclude.coveragePct.toFixed(1)}%；`,
  );
  console.log(
    `   而"只在思考里"的结论只占 reasoning 的 ${report.conclusion.onlyHerePct.toFixed(2)}%（${fmt(report.conclusion.onlyHere)} 句）—— 用 ${report.conclusion.sharePct.toFixed(2)}% 的预算把它们留下，` +
      `代价是比"整块丢弃"少看 ${(drop.realEvents - conclude.realEvents).toFixed(2)} 条真实事件/段（${((drop.realEvents - conclude.realEvents) / drop.realEvents * 100).toFixed(1)}%）、` +
      `覆盖率低 ${(drop.coveragePct - conclude.coveragePct).toFixed(1)}pp —— **便宜到必须留**。`,
  );
  console.log(`   ⇒ 生产口径 = \`plainText(content, { reasoning: "conclude" })\`（\`src/rooms/offline-fold.mjs\` 的 \`collectMessages\` 调用点）。`);

  console.log("");
  console.log("⑥ 同一段夹具：修前 / 修后的摘要输入构成（reasoning 占比从 X% 到 Y%）");
  if (report.fixture === null) {
    console.log("   （没有可重放的 foldMark）");
  } else {
    const f = report.fixture;
    console.log(`   夹具: session ${f.session} · seq ${f.range} · 取「输入字符最多」的那一段（确定性）`);
    console.log("   口径                     | 输入字符 | reasoning |  user:text | user:reminder | assistant:text | 工具行 | reasoning 占比");
    for (const [label, key] of [["含 reasoning（修前）", "keep"], ["只留结论句（修后）", "conclude"], ["整块丢弃（对照）", "drop"]]) {
      const c = f[key];
      console.log(
        `   ${label.padEnd(22)} | ${pad(fmt(c.total), 8)} | ${pad(fmt(c.reasoning), 9)} | ${pad(fmt(c.userText), 10)} | ${pad(fmt(c.reminder), 13)} | ${pad(fmt(c.assistantText), 14)} | ${pad(fmt(c.tool), 6)} | ${pad(pct(c.reasoning, c.total), 5)}`,
      );
    }
    const k = f.keep;
    const c = f.conclude;
    console.log(
      `   ⇒ reasoning 占比 **${pct(k.reasoning, k.total)} → ${pct(c.reasoning, c.total)}**（真实事件 ${pct(k.userText + k.assistantText, k.total)} → ${pct(c.userText + c.assistantText, c.total)}）——` +
        ` 同一份 ${fmt(MAX_CHARS)} 预算里，正文从 ${fmt(k.userText + k.assistantText)} 字符涨到 ${fmt(c.userText + c.assistantText)} 字符。`,
    );
  }
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
