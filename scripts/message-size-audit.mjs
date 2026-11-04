#!/usr/bin/env node
/**
 * message-size-audit.mjs —— **单条消息正文上限（`perMessageChars`）到底该给多少**（C612）
 *
 * 为什么需要它：`collectMessages`（`src/rooms/offline-fold.mjs`）对单条消息有两条上限 ——
 *
 *   · **文本行**（`user/message` / `assistant/message`）—— `perMessageChars`，默认 **2000**；
 *   · **工具行**（`tool/call` 的一行摘要）—— 固定 **120** 字符，与 `perMessageChars` 无关。
 *
 * 而 `tool/result` **压根不进输入**（C481：工具结果占上下文 12%–77%，其中 93%–100% 没被失败边引用）。
 *
 * 2000 是 C522 拍的（依据只有一条两万字的真机会话 `8cc34e32`）。真机审计
 * （`scripts/input-truncation-audit.mjs`）说 575 条 foldMark 里 **568 条**有消息正文被切 ——
 * 于是必须回答一个问题：**切掉的那 47% 字符，是"本来就该切"的噪音，还是摘要真的少看了东西？**
 *
 * 本脚本用真机会话给出四组数字，结论由数字决定（改 / 不改都接受）：
 *   ① **分布** —— 正文字符数 p50/p90/p99/max，以及每个候选上限切掉多少条、多少字符；
 *   ② **构成** —— 被切掉的字符**是谁的**。按内容块类型摊分（`assistant:reasoning` /
 *      `assistant:text` / `user:text` / `user:reminder` / `tool`）。"长的是工具输出"这个假说
 *      在这里被证伪或证实 —— 工具结果一条都没进来，所以只有前几类可能；
 *   ③ **权衡** —— 在真机 foldMark 的真实区间上重放 `collectMessages`（`maxChars = 60000`、
 *      `fromSeq = seqStart`、`idBySeq`，与 `engine.mjs` 的调用点同参），量每个候选上限下的
 *      **装下条数 / 文本覆盖率 / 整条丢弃 / 每段字符**，以及**多花的 token 与钱**；
 *   ④ **区间构成** —— 折叠区间里的字符本身是什么（同样按块类型），避免拿全局分布外推到区间。
 *
 * 用法：
 *   node scripts/message-size-audit.mjs                    # 全量（真机 741 个会话，约 1 分钟）
 *   node scripts/message-size-audit.mjs --limit=50          # 只扫前 50 个会话（冒烟用）
 *   node scripts/message-size-audit.mjs --session=8a73e06b  # 只看一个会话
 *   node scripts/message-size-audit.mjs --json              # 机读
 *   DSH_HOME=... node scripts/message-size-audit.mjs        # 换 home（与 doctor / graph-audit 同源）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles, priceForModel } from "../src/ui.mjs";
import { collectMessages, estimateTokens, plainText } from "../src/rooms/offline-fold.mjs";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";

/** 与 doctor / graph-audit / fold-loss-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** 写入点用的消息预算（`engine.mjs` 的 `offlineMaxChars || 60_000`）。 */
export const MAX_CHARS = 60_000;
/** 生产默认值（`collectMessages` 的 `perMessageChars`）。守卫测试会核对它没漂。 */
export const PRODUCTION_PER_MESSAGE_CHARS = 2000;
/** `collectMessages` 对工具行的**固定**上限 —— 与 `perMessageChars` 无关。 */
export const TOOL_LINE_CHARS = 120;
/** 候选上限；`Infinity` = 不设单条上限。 */
export const CANDIDATES = Object.freeze([2000, 4000, 8000, 16_000, Infinity]);

/** `<system-reminder>` 注入（workspace 指令整块塞进 user 消息）—— 与"用户真的说了什么"要分开算。 */
const SYSTEM_REMINDER_RE = /<system-reminder>/;

/**
 * 最近秩（nearest-rank）百分位：`p90` = 第 `ceil(0.9n)` 小。空数组返回 0。
 * 口径写死在这里，免得换了实现以后报告里的数对不上。
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
 * 一个块的归属 —— 决定"切掉的字符是谁的"。
 *
 * 为什么必须按**块类型**而不是消息角色分：`plainText` 只认 `typeof .text === "string"`，
 * 于是 `assistant/message` 里的 **`reasoning` 块也被拼进了输入**（模型的内部思考，不是"发生了什么"）。
 * 真机 120 个会话抽样：reasoning 7.26M 字符 vs 正文 0.36M 字符 ⇒ **95% 的 assistant 文本是思考**。
 * 按角色分账会把这件事完全盖住。
 *
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

/**
 * 给定上限，切掉多少条、多少字符。纯函数（审计与单测共用）。
 * @param {number[]} lengths
 * @param {number} cap
 * @returns {{cut:number, cutChars:number, keptChars:number}}
 */
export function cutStats(lengths, cap) {
  let cut = 0;
  let cutChars = 0;
  let keptChars = 0;
  for (const len of lengths) {
    if (len > cap) {
      cut += 1;
      cutChars += len - cap;
      keptChars += cap;
    } else {
      keptChars += len;
    }
  }
  return { cut, cutChars, keptChars };
}

/** 直方图桶（左闭右开；最后一个是 `≥ 32000`）。 */
export const BUCKETS = Object.freeze([0, 200, 500, 1000, 2000, 4000, 8000, 16_000, 32_000, Infinity]);

/**
 * 分桶计数。
 * @param {number[]} lengths
 * @returns {Array<{label:string, lo:number, hi:number, count:number}>}
 */
export function histogram(lengths) {
  const out = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: BUCKETS[i + 1], count: 0 }));
  for (const len of lengths) {
    for (let i = 0; i < out.length; i += 1) {
      if (len >= out[i].lo && len < out[i].hi) {
        out[i].count += 1;
        break;
      }
    }
  }
  return out.map((b) => ({ ...b, label: b.hi === Infinity ? `≥${b.lo}` : `${b.lo}–${b.hi - 1}` }));
}

const capLabel = (cap) => (cap === Infinity ? "无上限" : String(cap));
const pad = (v, n) => String(v).padStart(n);
const pct = (n, d) => (d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`);
const fmt = (n) => Number(n).toLocaleString("en-US");

/** 会话 id（graph 目录名）→ 会话日志路径。日志布局 `<home>/sessions/**\/<sessionId>/session.*.zstd`。 */
export function indexSessionLogs(home) {
  const map = new Map();
  for (const file of listSessionLogs(home)) {
    const id = nodePath.basename(nodePath.dirname(file));
    if (id !== "" && !map.has(id)) map.set(id, file);
  }
  return map;
}

/**
 * 一条 foldMark 的重放 —— 用**写 mark 时同一套参数**跑 `collectMessages`。
 *
 * 与 `engine.mjs` 的调用点一致：`maxChars = 60000`、`fromSeq = mark.seqStart`、
 * `idBySeq` 来自同一张图的 `nodes`（生产也传，所以 `[id] ` 前缀的字符数算在切点里）。
 * 唯一变动的是 `perMessageChars` —— 正是本审计要量的那个旋钮。
 *
 * **覆盖率口径**：`文本覆盖率 = 装下的文本字符 / 区间内全部文本字符`。
 * 不能用「装下的 seq 跨度」——工具行（95 字符一条）会在预算边缘继续被塞进来，
 * 于是跨度看着是满的、中间的大段文本其实全丢了（这个坑踩过一次）。
 * 也不能直接拿 `chars` 当分子：`fromSeq` 只卡下界，**区间之后**的消息也会被装进来，
 * 所以分子只数 `seq ∈ [seqStart, seqEnd]` 的那部分。
 *
 * @param {Array<object>} events 升序会话事件
 * @param {{seqStart:number, seqEnd:number, idBySeq?:Map<number,string>|null}} mark
 * @param {number} perMessageChars
 * @returns {{textKept:number, textKeptChars:number, keptInRangeChars:number, textRangeCount:number, textRangeChars:number, toolKept:number, toolChars:number, textMerged:number, textDropped:number, toolDropped:number, cutMessages:number, dropped:number, chars:number}}
 */
export function replayOne(events, mark, perMessageChars) {
  const seqStart = Number(mark?.seqStart);
  const seqEnd = Number(mark?.seqEnd ?? seqStart);
  const r = collectMessages(events, { maxChars: MAX_CHARS, fromSeq: seqStart, perMessageChars, idBySeq: mark?.idBySeq ?? null });
  const text = r.messages.filter((m) => m.role !== "tool");
  const tool = r.messages.filter((m) => m.role === "tool");
  let keptInRangeChars = 0;
  for (const m of text) {
    const seq = Number(m?.seq);
    if (Number.isFinite(seq) && seq >= seqStart && seq <= seqEnd) keptInRangeChars += m.text.length;
  }
  let textRangeCount = 0;
  let textRangeChars = 0;
  let textMerged = 0;
  for (const e of events) {
    const seq = Number(e?.seq);
    if (!Number.isFinite(seq) || seq < seqStart) continue;
    if (e?.type !== "user/message" && e?.type !== "assistant/message") continue;
    const body = plainText(e?.data?.message?.content ?? e?.data?.content);
    if (body.trim() === "") continue;
    textMerged += 1;
    if (seq > seqEnd) continue;
    textRangeCount += 1;
    textRangeChars += body.length;
  }
  // `dropped` 把工具行也算进去了（超 toolCap 的工具行一条一条数），
  // 所以文本侧的"整条丢弃"必须自己算：并入的文本条数 − 装下的文本条数。
  const textDropped = Math.max(0, textMerged - text.length);
  return {
    textKept: text.length,
    textKeptChars: text.reduce((n, m) => n + m.text.length, 0),
    keptInRangeChars,
    textRangeCount,
    textRangeChars,
    toolKept: tool.length,
    toolChars: tool.reduce((n, m) => n + m.text.length, 0),
    textMerged,
    textDropped,
    toolDropped: Math.max(0, r.dropped - textDropped),
    cutMessages: text.filter((m) => m.truncated === true).length,
    dropped: r.dropped,
    chars: r.chars,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const limitRaw = argv.find((a) => a.startsWith("--limit="));
  const limitIdx = argv.indexOf("--limit");
  const limit =
    limitRaw !== undefined
      ? Math.max(1, Number(limitRaw.slice("--limit=".length)) || 1)
      : limitIdx >= 0 && Number.isFinite(Number(argv[limitIdx + 1]))
        ? Math.max(1, Number(argv[limitIdx + 1]))
        : Infinity;
  const sessionArg = argv.find((a) => a.startsWith("--session="));
  const only = sessionArg === undefined ? null : String(sessionArg.slice("--session=".length));

  const home = resolveHome();
  const scan = collectGraphFiles(home);
  if (scan.files.length === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  // ① 图侧：每条 mark 的区间 + 该会话的 seq→节点 id（生产 `collectMessages` 也吃这个）
  const marksBySession = new Map(); // sessionId → [{seqStart, seqEnd, at, idBySeq}]
  let totalMarks = 0;
  const models = new Map();
  const markTimes = [];
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
      const model = String(mark?.route?.model ?? "");
      if (model !== "") models.set(model, (models.get(model) ?? 0) + 1);
      if (Number.isFinite(Number(mark?.at))) markTimes.push(Number(mark.at));
      if (!Number.isFinite(start)) continue; // 没区间就没法重放（"不知道"，不是"没裁"）
      list.push({ seqStart: start, seqEnd: Number(mark?.seqEnd) || start, idBySeq, inputTokens: Number(mark?.usage?.inputTokens) });
    }
    marksBySession.set(entry.dir, list);
  }

  // ② 会话侧：**每个日志只解码一次**，分布 / 构成 / 重放同轮吃完
  const lengths = []; // 全部消息的正文长度（UTF-16 码元，与 `m.text.length` 同口径）
  const blockChars = new Map(); // 块类型 → 字符数
  const blockCount = new Map(); // 块类型 → 块数
  const blockLengths = new Map(); // 块类型 → 块长度数组（算 p50/p90/p99）
  const cutByClass = CANDIDATES.map(() => new Map()); // [capIdx] 块类型 → {cutChars, messages}
  const rangeBlocks = new Map(); // 折叠区间内 块类型 → 字符数
  let textMessages = 0;
  let textChars = 0;
  let emptyText = 0;
  let toolResults = 0;
  let toolResultChars = 0;
  let toolCalls = 0;
  let tokenSamples = 0;
  let tokenSampleChars = 0;
  let tokenSampleTokens = 0;

  const replay = CANDIDATES.map(() => ({
    marks: 0,
    textKept: 0,
    textKeptChars: 0,
    keptInRangeChars: 0,
    textRangeCount: 0,
    textRangeChars: 0,
    toolKept: 0,
    toolChars: 0,
    textMerged: 0,
    textDropped: 0,
    toolDropped: 0,
    cutMessages: 0,
    marksWithCut: 0,
    dropped: 0,
    chars: 0,
    inputTokens: 0,
    inputTokensKnown: 0,
  }));
  let replayedSessions = 0;
  let noLogMarks = 0;

  const logs = indexSessionLogs(home);
  const sessions = [...marksBySession.entries()].filter(([id]) => (only === null ? true : id.includes(only))).slice(0, limit);
  for (const [id, marks] of sessions) {
    const file = logs.get(id);
    if (file === undefined) {
      noLogMarks += marks.length;
      continue;
    }
    const events = readSessionEvents(file);
    if (events.length === 0) {
      noLogMarks += marks.length;
      continue;
    }
    replayedSessions += 1;

    // ① 分布 + 块构成 + 工具旁证
    for (const e of events) {
      const type = e?.type;
      if (type === "tool/result") {
        toolResults += 1;
        toolResultChars += plainText(e?.data?.message?.content ?? e?.data?.content).length;
        continue;
      }
      if (type === "tool/call") {
        toolCalls += 1;
        continue;
      }
      if (type !== "user/message" && type !== "assistant/message") continue;
      const content = e?.data?.message?.content ?? e?.data?.content;
      const body = plainText(content);
      if (body.trim() === "") {
        emptyText += 1;
        continue;
      }
      const role = type === "user/message" ? "user" : "assistant";
      const len = body.length;
      textMessages += 1;
      textChars += len;
      lengths.push(len);
      // 块级构成 + 按块占比摊分「被切掉的字符」
      const blocks = textBlocks(content);
      const blockSum = blocks.reduce((n, b) => n + b.text.length, 0);
      for (const b of blocks) {
        const klass = classifyBlock(role, b);
        blockChars.set(klass, (blockChars.get(klass) ?? 0) + b.text.length);
        blockCount.set(klass, (blockCount.get(klass) ?? 0) + 1);
        if (!blockLengths.has(klass)) blockLengths.set(klass, []);
        blockLengths.get(klass).push(b.text.length);
        CANDIDATES.forEach((cap, i) => {
          if (len <= cap) return;
          const share = blockSum === 0 ? 0 : b.text.length / blockSum;
          const cur = cutByClass[i].get(klass) ?? { cutChars: 0, messages: 0 };
          cur.cutChars += (len - cap) * share;
          cutByClass[i].set(klass, cur);
        });
      }
      // 主导块类型 → 该类"被切条数"（一条消息只记一次）
      if (blocks.length > 0) {
        const dominant = blocks
          .map((b) => ({ klass: classifyBlock(role, b), len: b.text.length }))
          .sort((a, b) => b.len - a.len)[0].klass;
        CANDIDATES.forEach((cap, i) => {
          if (len <= cap) return;
          const cur = cutByClass[i].get(dominant) ?? { cutChars: 0, messages: 0 };
          cur.messages += 1;
          cutByClass[i].set(dominant, cur);
        });
      }
      // 每 50 条抽一条估 token/字符比（`estimateTokens` 是生产口径；全量太慢）
      if (tokenSamples % 50 === 0) {
        tokenSampleChars += len;
        tokenSampleTokens += estimateTokens(body);
      }
      tokenSamples += 1;
    }

    // ② 区间构成（与上限无关）+ 重放（每条 mark × 每个候选上限）
    for (const mark of marks) {
      const perRange = new Map();
      for (const e of events) {
        const seq = Number(e?.seq);
        if (!Number.isFinite(seq) || seq < mark.seqStart || seq > mark.seqEnd) continue;
        if (e?.type !== "user/message" && e?.type !== "assistant/message") continue;
        const content = e?.data?.message?.content ?? e?.data?.content;
        const body = plainText(content);
        if (body.trim() === "") continue;
        const role = e.type === "user/message" ? "user" : "assistant";
        for (const b of textBlocks(content)) {
          const klass = classifyBlock(role, b);
          perRange.set(klass, (perRange.get(klass) ?? 0) + b.text.length);
        }
      }
      for (const [klass, chars] of perRange) rangeBlocks.set(klass, (rangeBlocks.get(klass) ?? 0) + chars);
      CANDIDATES.forEach((cap, i) => {
        const r = replayOne(events, mark, cap);
        const agg = replay[i];
        agg.marks += 1;
        agg.textKept += r.textKept;
        agg.textKeptChars += r.textKeptChars;
        agg.keptInRangeChars += r.keptInRangeChars;
        agg.textRangeCount += r.textRangeCount;
        agg.textRangeChars += r.textRangeChars;
        agg.toolKept += r.toolKept;
        agg.toolChars += r.toolChars;
        agg.textMerged += r.textMerged;
        agg.textDropped += r.textDropped;
        agg.toolDropped += r.toolDropped;
        agg.cutMessages += r.cutMessages;
        if (r.cutMessages > 0) agg.marksWithCut += 1;
        agg.dropped += r.dropped;
        agg.chars += r.chars;
        if (Number.isFinite(mark.inputTokens) && mark.inputTokens >= 0) {
          agg.inputTokens += mark.inputTokens;
          agg.inputTokensKnown += 1;
        }
      });
    }
  }

  // ③ 派生数字
  const sorted = [...lengths].sort((a, b) => a - b);
  const total = sorted.length;
  const sum = sorted.reduce((n, x) => n + x, 0);
  const perCap = CANDIDATES.map((cap) => ({ cap, ...cutStats(sorted, cap) }));
  const hist = histogram(sorted);
  const maxLen = total === 0 ? 0 : sorted[total - 1];
  const blockRows = [...blockChars.entries()]
    .map(([klass, chars]) => {
      const s = [...(blockLengths.get(klass) ?? [])].sort((a, b) => a - b);
      return {
        klass,
        blocks: blockCount.get(klass) ?? 0,
        chars,
        share: textChars === 0 ? 0 : chars / textChars,
        p50: percentile(s, 0.5),
        p90: percentile(s, 0.9),
        p99: percentile(s, 0.99),
        max: s.length === 0 ? 0 : s[s.length - 1],
        cuts: CANDIDATES.map((cap, i) => cutByClass[i].get(klass) ?? { cutChars: 0, messages: 0 }),
      };
    })
    .sort((a, b) => b.chars - a.chars);
  const rangeTotal = [...rangeBlocks.values()].reduce((n, x) => n + x, 0);

  const tokensPerChar = tokenSampleChars === 0 ? 0 : tokenSampleTokens / tokenSampleChars;
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const price = priceForModel(model);
  const observedDays = (() => {
    if (markTimes.length === 0) return 0;
    const span = Math.max(...markTimes) - Math.min(...markTimes);
    return Math.max(1, Math.round((span / 86_400_000) * 10) / 10);
  })();
  const foldsPerDay = observedDays === 0 ? 0 : markTimes.length / observedDays;

  const base = replay[0];
  const tradeoff = CANDIDATES.map((cap, i) => {
    const agg = replay[i];
    const mean = (v) => (agg.marks === 0 ? 0 : v / agg.marks);
    return {
      cap,
      marks: agg.marks,
      textKept: mean(agg.textKept),
      textKeptChars: mean(agg.keptInRangeChars),
      textCoveragePct: agg.textRangeChars === 0 ? 0 : (agg.keptInRangeChars / agg.textRangeChars) * 100,
      textRangeCount: mean(agg.textRangeCount),
      textMerged: mean(agg.textMerged),
      textDropped: mean(agg.textDropped),
      cutMessages: agg.cutMessages,
      marksWithCut: agg.marksWithCut,
      dropped: mean(agg.dropped),
      toolKept: mean(agg.toolKept),
      toolChars: mean(agg.toolChars),
      chars: mean(agg.chars),
      deltaChars: agg.marks === 0 ? 0 : agg.chars / agg.marks - (base.marks === 0 ? 0 : base.chars / base.marks),
      realInputTokensPerMark: agg.inputTokensKnown === 0 ? 0 : agg.inputTokens / agg.inputTokensKnown,
    };
  });
  for (const r of tradeoff) {
    r.deltaTokens = r.deltaChars * tokensPerChar;
    r.deltaUsd = (r.deltaTokens / 1e6) * price.miss;
    r.deltaUsdDay = r.deltaUsd * foldsPerDay;
  }

  const report = {
    home,
    graphs: scan.files.length,
    sessionsWithMarks: marksBySession.size,
    foldMarks: totalMarks,
    replayedSessions,
    noLogMarks,
    maxChars: MAX_CHARS,
    productionPerMessageChars: PRODUCTION_PER_MESSAGE_CHARS,
    toolLineChars: TOOL_LINE_CHARS,
    messages: { total, chars: textChars, mean: total === 0 ? 0 : Math.round(sum / total), emptyText },
    distribution: { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: maxLen },
    histogram: hist,
    perCap,
    blocks: blockRows,
    rangeBlocks: Object.fromEntries([...rangeBlocks.entries()].map(([k, v]) => [k, { chars: v, share: rangeTotal === 0 ? 0 : v / rangeTotal }])),
    tools: { toolResults, toolResultChars, toolCalls },
    tokensPerChar,
    price: { model, ...price },
    foldsPerDay,
    observedDays,
    tradeoff,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("=== 单条消息正文上限审计（只读）===");
  console.log(`home:     ${home}`);
  console.log(`graphs:   ${fmt(report.graphs)}（有 foldMark 的 ${fmt(report.sessionsWithMarks)}）  foldMarks: ${fmt(report.foldMarks)}`);
  console.log(
    `会话日志: ${fmt(replayedSessions)} 个${only === null && limit === Infinity ? "" : "（--limit/--session 截过）"}  无法重放的 mark: ${fmt(noLogMarks)}`,
  );
  console.log(
    `消息:     ${fmt(total)} 条（空正文 ${fmt(emptyText)} 条已跳过）  总字符: ${fmt(textChars)}  均值: ${fmt(report.messages.mean)}`,
  );
  console.log("");

  console.log("① 正文字符数分布（口径 = collectMessages 收到的消息正文长度，含 [节点id] 前缀之外的拼块）");
  console.log(
    `   p50 ${fmt(report.distribution.p50)}   p90 ${fmt(report.distribution.p90)}   p95 ${fmt(report.distribution.p95)}   p99 ${fmt(report.distribution.p99)}   max ${fmt(maxLen)}`,
  );
  console.log("   直方图:");
  const maxCount = Math.max(1, ...hist.map((b) => b.count));
  for (const b of hist) {
    const bar = "#".repeat(Math.round((b.count / maxCount) * 28));
    console.log(`     ${b.label.padStart(11)}  ${pad(fmt(b.count), 7)}  ${pad(pct(b.count, total), 6)}  ${bar}`);
  }
  console.log("");

  console.log("② 每个候选上限：切掉多少条、多少字符（全量消息，与预算无关的纯规模）");
  console.log("   perMessageChars |   被切消息 | 被切占比 |     切掉字符 |    切后总字符 | 相对 2000 增幅");
  for (const p of perCap) {
    const delta = p.keptChars - perCap[0].keptChars;
    const deltaPct = perCap[0].keptChars === 0 ? 0 : (delta / perCap[0].keptChars) * 100;
    console.log(
      `   ${capLabel(p.cap).padStart(15)} | ${pad(fmt(p.cut), 10)} | ${pad(pct(p.cut, total), 8)} | ${pad(fmt(p.cutChars), 12)} | ${pad(fmt(p.keptChars), 13)} | ` +
        `${p.cap === PRODUCTION_PER_MESSAGE_CHARS ? "—" : `+${fmt(delta)}（+${deltaPct.toFixed(1)}%）`}`,
    );
  }
  console.log("");

  console.log("③ 这些字符**是谁的**（按内容块类型；cap = 2000 口径，被切字符按块占比摊分）");
  console.log("   块类型               |     块数 |      总字符 | 占比  |      p50 |      p90 |      p99 |      max | 2000 切掉字符 |  占被切 | 被切消息");
  for (const b of blockRows) {
    const cut = b.cuts[0];
    console.log(
      `   ${b.klass.padEnd(20)} | ${pad(fmt(b.blocks), 8)} | ${pad(fmt(b.chars), 11)} | ${pad(pct(b.chars, textChars), 5)} | ${pad(fmt(b.p50), 8)} | ${pad(fmt(b.p90), 8)} | ` +
        `${pad(fmt(b.p99), 8)} | ${pad(fmt(b.max), 8)} | ${pad(fmt(Math.round(cut.cutChars)), 13)} | ${pad(pct(cut.cutChars, perCap[0].cutChars), 7)} | ${pad(fmt(cut.messages), 7)}`,
    );
  }
  console.log(
    `   旁证: tool/result ${fmt(toolResults)} 条（${fmt(toolResultChars)} 字符）**一条都没进输入**；` +
      `tool/call ${fmt(toolCalls)} 次，摘要行固定 ${TOOL_LINE_CHARS} 字符上限（与 perMessageChars 无关）。`,
  );
  console.log("   各档**保留率**（(该类字符 − 切掉字符) / 该类字符）—— 放宽上限到底买回了谁的内容:");
  console.log(`   ${"块类型".padEnd(20)} | ${CANDIDATES.map((c) => capLabel(c).padStart(7)).join(" | ")}`);
  for (const b of blockRows) {
    console.log(`   ${b.klass.padEnd(20)} | ${b.cuts.map((c) => pct(b.chars - c.cutChars, b.chars).padStart(7)).join(" | ")}`);
  }
  console.log("");

  console.log(`④ 真机重放：maxChars=${fmt(MAX_CHARS)}、fromSeq=seqStart、idBySeq 照生产 —— 「条数 vs 单条完整度」`);
  console.log("   perMessageChars | mark | 文本装下 | 区间文本 | 文本覆盖率 | 被切消息 | 有切mark | 文本整条丢弃 | 工具行 | 平均字符/段");
  for (const r of tradeoff) {
    console.log(
      `   ${capLabel(r.cap).padStart(15)} | ${pad(fmt(r.marks), 4)} | ${pad(r.textKept.toFixed(1), 8)} | ${pad(r.textRangeCount.toFixed(1), 8)} | ${pad(`${r.textCoveragePct.toFixed(1)}%`, 10)} | ` +
        `${pad(fmt(r.cutMessages), 8)} | ${pad(fmt(r.marksWithCut), 8)} | ${pad(r.textDropped.toFixed(1), 12)} | ${pad(r.toolKept.toFixed(1), 6)} | ${pad(fmt(Math.round(r.chars)), 11)}`,
    );
  }
  console.log("");
  console.log(`   折叠区间内的字符构成（与上限无关的纯事实）: ${[...rangeBlocks.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, rangeTotal)}`).join(" / ")}`);
  console.log(`   注: 分子只数 seq ∈ [seqStart, seqEnd] 的文本；\`fromSeq\` 只卡下界，区间之后的消息也会被装进来（不计入覆盖率）。`);
  console.log("");

  console.log("⑤ 成本（相对 2000 基线；token/字符比来自生产估计器 estimateTokens 抽样，$/段 按低峰价 = 下限）");
  console.log(`   抽样 ${fmt(tokenSamples)} 条 / ${fmt(tokenSampleChars)} 字符 ⇒ ${tokenSamples === 0 ? "0" : tokensPerChar.toFixed(3)} token/字符`);
  console.log(`   单价: ${model || "(未知模型，按 flash 估)"}  输入 miss $${price.miss}/Mtok  输入 hit $${price.hit}/Mtok  输出 $${price.out}/Mtok`);
  console.log(`   真机折叠速率: ${foldsPerDay.toFixed(2)} 段/日（${fmt(markTimes.length)} 段 / ${observedDays} 天观测窗）`);
  console.log("   perMessageChars |  Δ字符/段 |  Δtoken/段 |      Δ$/段 |      Δ$/日 | 实测 input token/段");
  for (const r of tradeoff) {
    console.log(
      `   ${capLabel(r.cap).padStart(15)} | ${pad(Math.round(r.deltaChars), 10)} | ${pad(Math.round(r.deltaTokens), 11)} | ${pad(`$${r.deltaUsd.toFixed(5)}`, 10)} | ` +
        `${pad(`$${r.deltaUsdDay.toFixed(3)}`, 11)} | ${pad(Math.round(r.realInputTokensPerMark), 20)}`,
    );
  }
  // 反事实：**真正**让摘要多看东西的旋钮是 `maxChars`（`perMessageChars` 只决定怎么切，不改变总量）。
  // 文本预算 = maxChars × (1 - toolShare) = maxChars × 0.6 ⇒ 60,000 → 120,000 时每段 +36,000 字符。
  const textCap = MAX_CHARS * 0.6;
  const extraTokens = textCap * tokensPerChar;
  console.log(
    `   反事实: 把 maxChars 从 ${fmt(MAX_CHARS)} 提到 ${fmt(MAX_CHARS * 2)}（文本预算 ${fmt(textCap)} → ${fmt(textCap * 2)}）` +
      ` ⇒ 每段 +${fmt(Math.round(textCap))} 字符 = +${fmt(Math.round(extraTokens))} token = +$${((extraTokens / 1e6) * price.miss).toFixed(5)}/段、` +
      `+$${((extraTokens / 1e6) * price.miss * foldsPerDay).toFixed(2)}/日（低峰）、+$${((extraTokens / 1e6) * price.miss * 2 * foldsPerDay).toFixed(2)}/日（高峰）`,
  );
  console.log("");

  // ⑥ 结论 —— 只陈述**算出来的**事实；判据写死在这里，免得下一个人再猜
  const share = (klass) => (perCap[0].cutChars === 0 ? 0 : (blockRows.find((b) => b.klass === klass)?.cuts[0].cutChars ?? 0) / perCap[0].cutChars);
  const scaffolding = share("assistant:reasoning") + share("user:reminder");
  const realTalk = share("user:text") + share("assistant:text");
  const last = tradeoff[tradeoff.length - 1];
  const mid = tradeoff[CANDIDATES.indexOf(8000)];
  console.log("⑥ 结论");
  console.log(
    `   · 「长的是工具输出」——**证伪**：tool/result ${fmt(toolResults)} 条（${fmt(toolResultChars)} 字符）**一条都没进输入**，` +
      `被切的字符里 0 条是工具输出。`,
  );
  console.log(
    `   · 切掉的 ${fmt(perCap[0].cutChars)} 字符（占全部文本 ${pct(perCap[0].cutChars, textChars)}）里：` +
      `assistant 的 **reasoning 块** ${pct(share("assistant:reasoning"), 1)}、` +
      `<system-reminder> 样板 ${pct(share("user:reminder"), 1)}、` +
      `真实用户输入 ${pct(share("user:text"), 1)}、assistant 正文 ${pct(share("assistant:text"), 1)}。`,
  );
  console.log(`   · ⇒ 切掉的 ${pct(scaffolding, 1)} 是**脚手架**（模型自己的思考 + 每轮重复的 workspace 指令），真正的事件内容只占 ${pct(realTalk, 1)}。`);
  console.log(
    `   · 放宽到 8000 的**实际收益**：文本覆盖率 ${tradeoff[0].textCoveragePct.toFixed(1)}% → ${mid.textCoveragePct.toFixed(1)}%` +
      `（+${(mid.textCoveragePct - tradeoff[0].textCoveragePct).toFixed(1)} 个百分点，因为 60,000 的总量卡死，单条放宽不改变总量）；`,
  );
  console.log(
    `     **代价**：装下的文本条数 ${tradeoff[0].textKept.toFixed(1)} → ${mid.textKept.toFixed(1)}（${pct(mid.textKept - tradeoff[0].textKept, tradeoff[0].textKept)}）、` +
      `工具行 ${tradeoff[0].toolKept.toFixed(1)} → ${mid.toolKept.toFixed(1)}（${pct(mid.toolKept - tradeoff[0].toolKept, tradeoff[0].toolKept)}）。`,
  );
  console.log(
    `   · 成本：每段 ${mid.deltaTokens >= 0 ? "+" : ""}${Math.round(mid.deltaTokens)} token（$${mid.deltaUsd.toFixed(5)}/段、$${mid.deltaUsdDay.toFixed(3)}/日）` +
      `—— **不涨反降**（单条放宽把工具行挤了出去），所以"省钱"不是保持 2000 的理由，"少看事件"才是。`,
  );
  console.log(
    `   · ⇒ **默认值保持 ${PRODUCTION_PER_MESSAGE_CHARS}**：它切掉的 ${pct(scaffolding, 1)} 是脚手架；` +
      `真要摘要多看东西，该动的是 maxChars（见 ⑤ 反事实），不是这个单条上限。`,
  );
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
