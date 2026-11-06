#!/usr/bin/env node
/**
 * human-message-audit.mjs —— 「宿主标了 user，但正文是机器产物」的只读审计（T38）
 *
 * 为什么需要它：`src/rooms/keeper.mjs` 的 `isHumanMessage` 只用 `source.kind` 判断
 * 「这条 user 消息是不是人打的字」。真机反例（2026-11-05）：
 *
 *   <redacted> seq 1179 —— 一条 **251,157 字符**的 LLM 错误 JSON
 *   （`{"id":"chatcmpl-…","error":{…}}` + 用户粘的请求体），宿主标的 `source.kind = "user"`。
 *   ⇒ 被当成「人打的字」⇒ `extractConstraints` 抽出 40 条「约束」⇒ 渲染进
 *     `## 约束（一条都不许丢）` —— 整块 36% 是系统提示词。
 *
 * 本脚本回答三个问题（数字说话，改/不改都接受）：
 *   ① **有多少**：`source.kind ∈ {user,prompt,human}` 的消息里，多少条**看起来像机器输出**
 *      （JSON 信封 / 堆栈 / HTTP 响应 / 命令回执）；
 *   ② **怎么分**：每条的分类（`error-json` / `stack-trace` / `http-response` / `tool-receipt` / `真·人话`）；
 *   ③ **污染多大**：这些「假人话」一共贡献了多少条**约束锚**（`extractConstraints` 逐条重算），
 *      以及它们占「人话」字符总量的多少。
 *
 * 分类器是**闭集**（只认下面几种精确形状）且**锚在开头**（正文里引用报错不算），并要求机器
 * 产物占正文的 ≥90%（`MACHINE_SHARE`）—— 与 `isHumanMessage` 同一套判据，但**独立实现**：
 * 生产判据是「被测对象」，这里是对照组，两边不一致会在 ④ 里单独打一行。
 *
 * 用法：
 *   node scripts/human-message-audit.mjs                     # 全量（真机 784 个会话，约 15 秒）
 *   node scripts/human-message-audit.mjs --limit=50           # 只扫前 50 个会话（冒烟用）
 *   node scripts/human-message-audit.mjs --session=8a73e06b   # 只看一个会话（id 前缀）
 *   node scripts/human-message-audit.mjs --json               # 机读
 *   node scripts/human-message-audit.mjs --home=<workspace>        # 换 home（默认 DSH_HOME，否则 ~/.dsh）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 一条会话日志都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { extractConstraints } from "../src/rooms/kifu-model.mjs";
import { isHumanMessage } from "../src/rooms/keeper.mjs";

/** 生产判据认的「人打的字」来源（与 `keeper.mjs` 的 `HUMAN_SOURCES` 同源）。 */
export const HUMAN_SOURCES = Object.freeze(["user", "prompt", "human"]);

/** 机器产物必须占正文（去空白后）的多少，才算「假人话」。判不准 ⇒ 人话（保守优先）。 */
export const MACHINE_SHARE = 0.9;

/** 分类标签（报告里的口径，顺序即输出顺序）。 */
export const CATEGORIES = Object.freeze(["真·人话", "error-json", "stack-trace", "http-response", "tool-receipt"]);

/**
 * **强**机器行：只在命令回执 / 堆栈里出现的形状 —— 人不会拿它开头。
 * 每一项都是**精确字面**（闭集），不猜语义。
 */
const STRONG_LINE =
  /^(?:\s+at\s+\S|\s+File "\S+", line \d+|\[[A-Z][A-Z0-9_]*\]|(?:npm|pnpm|yarn) (?:ERR!|error)|[✓✗✔✖]|Traceback \(most recent call last\)|panic: |HTTP\/\d(?:\.\d)? \d{3}\b)/;
/** **弱**机器行：可以和真人话混排（错误行 / 缩进续行 / 空行）—— 只用来凑覆盖率，不能单独定案。 */
const WEAK_LINE = /^(?:[{\[]|\s*$|\s+\S|[A-Za-z][\w-]*: |This error happened while )/;

/**
 * 从 `from` 开始取一个完整 JSON 值的结束下标（尊重字符串与转义）；未闭合返回 -1。
 * 只做括号配平，不做语法校验（调用方再 `JSON.parse`）。
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
export function jsonValueEnd(text, from) {
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

/**
 * OpenAI（兼容）形状的信封：`error` / `choices` / `chatcmpl-` 开头的 `id` / `object: "chat.completion*"`。
 *
 * 为什么这四种就够、且不会误伤配置：配置里不会出现 `error` / `choices` 这两个顶层键，
 * 更不会用 `chatcmpl` 当 id 前缀 —— 那是 OpenAI 的 completion id 专有前缀。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOpenAiEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (v.error !== undefined && v.error !== null) return true;
  if (Array.isArray(v.choices)) return true;
  if (typeof v.id === "string" && v.id.startsWith("chatcmpl")) return true;
  return v.object === "chat.completion" || v.object === "chat.completion.chunk";
}

/**
 * 「这篇正文里机器产物占多少 + 属于哪一类」。**判不准一律返回 `真·人话`**。
 *
 * 三条铁律（与 `keeper.isHumanMessage` 一致）：
 *   ① **闭集** —— 只认 `STRONG_LINE` / `WEAK_LINE` / OpenAI 信封，不猜；
 *   ② **锚在开头** —— 形状必须从正文第一个非空字符开始（用户正文里**引用**报错不算，
 *      那是最常见的真实输入：贴一段日志再问「这是什么」）；
 *   ③ **绝对主体** —— 机器产物必须占字符的 ≥ `MACHINE_SHARE`，否则算人话
 *      （宁可留噪声，不许丢真实用户输入）。
 *
 * @param {string} text
 * @returns {{kind: (typeof CATEGORIES)[number], share: number}} `kind = "真·人话"` 表示不是机器产物
 */
export function classifyMachineOutput(text) {
  const body = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (body === "") return { kind: "真·人话", share: 0 };
  // ① JSON 文档序列（OpenAI 信封 + 后面粘着的请求体 / 响应体；残渣只算人话）
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
      const stop = end < 0 ? body.length : end; // 尾部被截断的文档：整段都算机器（真机 seq 1179 就是截断的）
      if (docs === 0) {
        try {
          first = JSON.parse(body.slice(at, stop));
        } catch {
          parsed = false; // 开头的 JSON 都不完整 ⇒ 不是信封 ⇒ 走下面的行判据
          break;
        }
      }
      inside += stop - at;
      docs += 1;
      at = stop;
      if (end < 0) break;
    }
    if (parsed && docs > 0 && isOpenAiEnvelope(first)) {
      const share = inside / body.length;
      return { kind: share >= MACHINE_SHARE ? "error-json" : "真·人话", share };
    }
  }
  // ② 命令行回执 / 堆栈 / HTTP 响应：首行必须是**强**机器行，或「弱错误行 + 至少一条强行」
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim() !== "") ?? "";
  if (!STRONG_LINE.test(first) && !(WEAK_LINE.test(first) && lines.some((line) => STRONG_LINE.test(line)))) {
    return { kind: "真·人话", share: 0 };
  }
  let inside = 0;
  for (const line of lines) if (STRONG_LINE.test(line) || WEAK_LINE.test(line)) inside += line.length;
  const share = inside / body.length;
  if (share < MACHINE_SHARE) return { kind: "真·人话", share };
  if (/^HTTP\//.test(first)) return { kind: "http-response", share };
  if (/^(?:Traceback \(most recent call last\)|panic: |\s+at\s|\s+File ")/.test(first) || /(?:Error|Exception):/.test(first)) {
    return { kind: "stack-trace", share };
  }
  return { kind: "tool-receipt", share };
}

/** `--home=` 优先，其次 `DSH_HOME`，最后 `~/.dsh`（与本仓 doctor / graph-audit 同源）。 */
export function resolveHome(env = process.env, argv = []) {
  const fromArg = argv.find((arg) => arg.startsWith("--home="));
  if (fromArg !== undefined && fromArg.length > "--home=".length) return fromArg.slice("--home=".length);
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  // 本机 DSH 装在 `<workspace> Harness` 下，`~/.dsh` 里没有 sessions：两个候选都试，谁有日志用谁。
  const profile = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const hasSessions = (home) => {
    try {
      return nodeFs.existsSync(nodePath.join(home, "sessions"));
    } catch {
      return false;
    }
  };
  const fallback = nodePath.join(profile, ".dsh");
  const machine = nodePath.resolve(profile, "..", "DeepSeek Harness", "home");
  if (hasSessions(fallback)) return fallback;
  if (hasSessions(machine)) return machine;
  return fallback;
}

/** 一条 user 消息的正文（与 `keeper.messageText` 同口径：只认 `.type === "text"` 的块）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const pad = (v, n) => String(v).padStart(n);
/** 按显示宽度补空格（CJK 算 2 列）—— 中文标签也要对齐。 */
const label = (text, width) => {
  const w = [...String(text)].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(text) + " ".repeat(Math.max(0, width - w));
};
/** 右对齐版（表头用）。 */
const rlabel = (text, width) => {
  const w = [...String(text)].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return " ".repeat(Math.max(0, width - w)) + String(text);
};
const pct = (n, d) => (d === 0 ? "0.00%" : `${((n / d) * 100).toFixed(2)}%`);

/**
 * 扫一批会话日志，产出行级明细（纯函数，便于自检）。
 * @param {string[]} logs 会话日志绝对路径
 * @returns {{events:number, messages:number, kinds:Array<[string,number]>, rows:Array<object>}}
 */
export function auditLogs(logs) {
  const kinds = new Map();
  const rows = [];
  let events = 0;
  let messages = 0;
  for (const file of logs) {
    const sessionId = nodePath.basename(nodePath.dirname(file)).replace(/^session-/, "");
    const list = readSessionEvents(file);
    events += list.length;
    for (const event of list) {
      if (event?.type !== "user/message") continue;
      messages += 1;
      const message = event.data;
      const kind = message?.source?.kind;
      const key = kind === undefined || kind === null ? "<无 source>" : String(kind);
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
      if (!HUMAN_SOURCES.includes(key)) continue;
      const text = messageText(message);
      const verdict = classifyMachineOutput(text);
      rows.push({
        sessionId,
        seq: event.seq ?? null,
        kind: key,
        chars: text.length,
        category: verdict.kind,
        machine: verdict.kind !== "真·人话",
        share: verdict.share,
        constraints: extractConstraints(text).length,
        productionHuman: isHumanMessage(message),
        head: text.slice(0, 120).replace(/\s+/g, " "),
      });
    }
  }
  return { events, messages, kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]), rows };
}

/**
 * 汇总成报告（数字口径全部在这里，报告与 `--json` 共用）。
 * @param {{events:number, messages:number, kinds:Array<[string,number]>, rows:Array<object>}} scan
 */
export function summarize(scan) {
  const rows = scan.rows;
  const byCategory = {};
  for (const row of rows) {
    const bucket = (byCategory[row.category] ??= { count: 0, chars: 0, constraints: 0 });
    bucket.count += 1;
    bucket.chars += row.chars;
    bucket.constraints += row.constraints;
  }
  const fake = rows.filter((row) => row.machine).sort((a, b) => b.chars - a.chars);
  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
  return {
    events: scan.events,
    messages: scan.messages,
    kinds: scan.kinds,
    humanMessages: rows.length,
    byCategory,
    fake,
    nearMiss: rows.filter((row) => !row.machine && row.share >= 0.5).sort((a, b) => b.share - a.share),
    // 生产判据（isHumanMessage）与审计独立实现的分歧 —— 两条判据必须一致，否则是漂了。
    disagreements: rows.filter((row) => row.machine !== !row.productionHuman),
    totals: {
      humanChars: sum(rows, "chars"),
      fakeChars: sum(fake, "chars"),
      humanConstraints: sum(rows, "constraints"),
      fakeConstraints: sum(fake, "constraints"),
      // 「修前 = kind 命中就算人话」；「修后 = 生产 isHumanMessage」。差集就是这次修掉的东西。
      legacyHuman: rows.length,
      currentHuman: rows.filter((row) => row.productionHuman).length,
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const only = argv.find((arg) => arg.startsWith("--session="))?.slice("--session=".length) ?? null;
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg === undefined ? Infinity : Number(limitArg.slice("--limit=".length)) || Infinity;
  const home = resolveHome(process.env, argv);
  const all = listSessionLogs(home);
  if (all.length === 0) {
    console.error(`✗ 一条会话日志都读不到（home=${home}）—— 用 DSH_HOME 或 --home= 指定真机 home 再跑。`);
    process.exitCode = 2;
    return;
  }
  const logs = (only === null ? all : all.filter((file) => file.includes(only))).slice(0, limit);
  const report = summarize(auditLogs(logs));
  const { totals } = report;

  if (asJson) {
    console.log(JSON.stringify({ home, scanned: logs.length, ...report }, null, 2));
    return;
  }

  console.log("=== 「假人话」审计（宿主标 user，正文却是机器产物）—— 只读 ===");
  console.log(`home:      ${home}`);
  console.log(`会话日志:  ${fmt(logs.length)} 个${limitArg === undefined && only === null ? "" : "（--limit/--session 截过）"}   消息事件: ${fmt(report.events)} 条`);
  console.log("");
  console.log(`① source.kind 分布（user 角色消息 ${fmt(report.messages)} 条，共 ${report.kinds.length} 种）`);
  for (const [kind, count] of report.kinds) {
    console.log(`   ${label(kind, 26)} ${pad(fmt(count), 7)}${HUMAN_SOURCES.includes(kind) ? "  ← 算人话" : ""}`);
  }
  console.log("");
  console.log(`② 分类统计（human 判据命中的 ${fmt(report.humanMessages)} 条）`);
  console.log(`   ${label("类别", 16)} ${rlabel("条数", 7)}  ${rlabel("占比", 8)}  ${rlabel("字符", 10)}  ${rlabel("占比", 8)}`);
  for (const category of CATEGORIES) {
    const bucket = report.byCategory[category] ?? { count: 0, chars: 0 };
    console.log(
      `   ${label(category, 16)} ${pad(fmt(bucket.count), 7)}  ${pad(pct(bucket.count, report.humanMessages), 8)}  ${pad(fmt(bucket.chars), 10)}  ${pad(pct(bucket.chars, totals.humanChars), 8)}`,
    );
  }
  console.log(
    `   ${label("假人话小计", 14)} ${pad(fmt(report.fake.length), 7)}  ${pad(pct(report.fake.length, report.humanMessages), 8)}  ${pad(fmt(totals.fakeChars), 10)}  ${pad(pct(totals.fakeChars, totals.humanChars), 8)}`,
  );
  console.log("");
  console.log("③ 约束锚贡献（`extractConstraints` 逐条重算）");
  console.log(`   human 消息总计:   ${fmt(totals.humanConstraints)} 条约束锚`);
  console.log(`   假人话贡献:       ${fmt(totals.fakeConstraints)} 条（${pct(totals.fakeConstraints, totals.humanConstraints)}）`);
  for (const row of report.fake) {
    console.log(`     · ${label(row.category, 12)} seq ${pad(row.seq, 6)}  ${pad(fmt(row.chars), 8)} 字符  ${pad(row.constraints, 3)} 条约束  session-${row.sessionId}`);
    console.log(`       ${row.head}`);
  }
  console.log("");
  console.log("④ 修前 / 修后（同一批消息，两条判据）");
  console.log(`   修前（kind ∈ {${HUMAN_SOURCES.join(", ")}} 即算人话）: ${fmt(totals.legacyHuman)} 条 / ${fmt(totals.humanConstraints)} 条约束锚`);
  console.log(`   修后（生产 isHumanMessage）:                        ${fmt(totals.currentHuman)} 条 / ${fmt(totals.humanConstraints - totals.fakeConstraints)} 条约束锚`);
  console.log(`   被排除:                                             ${fmt(totals.legacyHuman - totals.currentHuman)} 条 / ${fmt(totals.fakeConstraints)} 条约束锚`);
  console.log(`   生产判据 vs 本脚本独立实现，不一致:                 ${fmt(report.disagreements.length)} 条${report.disagreements.length === 0 ? "（一致）" : "（← 两边判据漂了，要查）"}`);
  console.log("");
  console.log(`⑤ 近失（机器产物占比 ≥50% 但 <${MACHINE_SHARE}，按保守优先放过）: ${fmt(report.nearMiss.length)} 条`);
  for (const row of report.nearMiss.slice(0, 20)) {
    console.log(`     · share ${row.share.toFixed(3)}  seq ${pad(row.seq, 6)}  ${pad(fmt(row.chars), 8)} 字符  session-${row.sessionId}`);
    console.log(`       ${row.head}`);
  }
  console.log("");
  console.log(
    report.fake.length === 0
      ? "✅ 没有「假人话」（每条 human 消息的正文都经得起人话判据）"
      : `⚠ ${fmt(report.fake.length)} 条「假人话」贡献了 ${fmt(totals.fakeConstraints)} 条约束锚（占 ${pct(totals.fakeConstraints, totals.humanConstraints)}）`,
  );
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
