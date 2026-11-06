#!/usr/bin/env node
/**
 * input-truncation-audit.mjs —— **「输入被裁」到底有没有被记下来**（C610）
 *
 * 为什么需要它：`src/rooms/offline-fold.mjs` 有**两条**截断来源，但只有一条进了账：
 *
 *   · **响应侧**（`:751` 附近）—— `looksTruncated(...)` 判「模型没写完」，落 `foldMark.truncated`；
 *   · **输入侧**（`:195` 附近）—— `collectMessages` 的 `truncateFor` 给被丢的消息打 `truncated: true`、
 *     并把整条没放进去的消息数进 `dropped`，**但这两样都没有写进 foldMark**。
 *
 * 后果：**「输入被裁、模型正常收尾」这一情形，foldMark 记成 `truncated: false`** ——
 * 一条**假「没截断」**。而对摘要来说，"模型没写完"（输出短了）与"模型没看全输入"（事件没进去）
 * 是**两件不同的事**，混成一个字段以后就没法分了。
 *
 * 这个脚本把这件事变成可复核的两组数字：
 *   ① **字段存在性** —— 真机 foldMark 里到底有没有任何字段记录"输入被裁"（没有 = 压根没记）；
 *   ② **重放复算** —— 用**写 mark 时同一套参数**（`maxChars` / `fromSeq = seqStart`）把
 *      `collectMessages` 在该会话的真实事件上重跑一遍，看这一条 mark 的输入侧当时是否被裁过
 *      （整条丢弃 `dropped > 0`，或单条正文被切 `message.truncated === true`）；
 *   ③ **交叉表** —— ②的结果 × `foldMark.truncated`，点名那批**假「没截断」**。
 *
 * 用法：
 *   node scripts/input-truncation-audit.mjs                # 全量（真机 ~520 个会话，1~2 分钟）
 *   node scripts/input-truncation-audit.mjs --limit 50     # 只扫前 50 个有 mark 的会话（冒烟用）
 *   node scripts/input-truncation-audit.mjs --session <SESSION_ID>
 *   node scripts/input-truncation-audit.mjs --json         # 机读
 *   DSH_HOME=... node scripts/input-truncation-audit.mjs   # 换 home（与 doctor / graph-audit 同源）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 连一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 *
 * 参数口径（与 `src/engine.mjs` 的离线补折调用点一致）：
 *   `maxChars: Number(this.chess.offlineMaxChars) || 60_000`、`maxChunks: 1`、
 *   `fromSeq: (maxChunks > 1 || fromHead) ? chunkStart : null`。
 *   重放取 `fromSeq = mark.seqStart` —— 头取（fromHead）是**更严**的一侧：
 *   它把 [seqStart, …] 全部纳入预算竞争，尾巴取法只会裁得更少，所以这里的数是上界。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { collectMessages } from "../src/rooms/offline-fold.mjs";
import { listSessionLogs, readSessionEvents } from "../src/rooms/zstd-log.mjs";

/** 与 doctor / graph-audit / fold-loss-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** 写入点用的消息预算（`engine.mjs` 的 `offlineMaxChars || 60_000`）。 */
const DEFAULT_MAX_CHARS = 60_000;

/**
 * 一条 mark 的「输入侧」判定 —— 纯函数，便于单测/复核。
 *
 * @param {Array<{truncated?:boolean}>} messages `collectMessages` 交出来的消息
 * @param {number} dropped 整条没放进去的消息数
 * @returns {{inputTruncated:boolean, dropped:number, cutMessages:number}}
 */
export function inputSideOf(messages, dropped) {
  const list = Array.isArray(messages) ? messages : [];
  const cutMessages = list.filter((m) => m?.truncated === true).length;
  const droppedCount = Math.max(0, Number(dropped) || 0);
  return { inputTruncated: droppedCount > 0 || cutMessages > 0, dropped: droppedCount, cutMessages };
}

/** 会话 id（graph 目录名）→ 会话日志路径。日志布局是 `<home>/sessions/**\/<sessionId>/session.*.zstd`。 */
export function indexSessionLogs(home) {
  const map = new Map();
  for (const file of listSessionLogs(home)) {
    const id = nodePath.basename(nodePath.dirname(file));
    if (id !== "" && !map.has(id)) map.set(id, file);
  }
  return map;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const limitArg = args.find((a) => a.startsWith("--limit="));
const sessionArg = args.find((a) => a.startsWith("--session="));
const limit = limitArg === undefined ? Infinity : Math.max(1, Number(limitArg.slice("--limit=".length)) || 1);
const only = sessionArg === undefined ? null : String(sessionArg.slice("--session=".length));

function main() {
  const home = resolveHome();
  const scan = collectGraphFiles(home);
  if (scan.files.length === 0) {
    console.error(`✗ 没找到任何 graph.json（home=${home}）—— 用 DSH_HOME 指定真机 home 再跑。`);
    process.exit(2);
  }

  // ① 先把**不需要日志**的那部分算完（字段存在性 + 计数分布）
  const perSession = new Map(); // id → {file, marks:[]}
  let totalMarks = 0;
  const presence = { inputTruncated: 0, inputDropped: 0, inputCutMessages: 0, dropped: 0 };
  const finishDist = new Map(); // `${truncated}` → 条数
  for (const entry of scan.files) {
    let raw;
    try {
      raw = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    } catch {
      continue; // 坏图跳过（只读审计不许因为一张坏图整跑挂掉）
    }
    const marks = Array.isArray(raw?.foldMarks) ? raw.foldMarks : [];
    if (marks.length === 0) continue;
    for (const mark of marks) {
      totalMarks += 1;
      const m = mark ?? {};
      // 字段存在性：**有键就算**（哪怕值是 false —— 那也是有证据的"没裁"）
      for (const key of Object.keys(presence)) {
        if (Object.prototype.hasOwnProperty.call(m, key)) presence[key] += 1;
      }
      const t = m.truncated === true ? "true" : m.truncated === false ? "false" : "missing";
      finishDist.set(t, (finishDist.get(t) ?? 0) + 1);
    }
    perSession.set(entry.dir, { file: entry.file, marks });
  }

  // ② 重放：按会话读一次日志，逐条 mark 用**同一套参数**复算输入侧
  const logs = indexSessionLogs(home);
  const sessions = [...perSession.entries()].filter(([id]) => (only === null ? true : id.includes(only))).slice(0, limit);
  const cross = new Map(); // `${truncated}|${input}` → 条数
  let replayed = 0;
  let noLog = 0;
  let inputCut = 0;
  let cutByDrop = 0;
  let cutByTruncateMessage = 0;
  const samples = [];
  for (const [id, info] of sessions) {
    const logFile = logs.get(id);
    if (logFile === undefined) {
      noLog += info.marks.length;
      continue;
    }
    const events = readSessionEvents(logFile);
    if (events.length === 0) {
      noLog += info.marks.length;
      continue;
    }
    for (const mark of info.marks) {
      const start = Number(mark?.seqStart);
      if (!Number.isFinite(start)) continue; // 没有区间就没法重放（不是"没裁"，是"不知道"）
      const { messages, dropped } = collectMessages(events, { maxChars: DEFAULT_MAX_CHARS, fromSeq: start });
      const side = inputSideOf(messages, dropped);
      replayed += 1;
      const t = mark?.truncated === true ? "true" : mark?.truncated === false ? "false" : "missing";
      const key = `${t}|${side.inputTruncated ? "cut" : "whole"}`;
      cross.set(key, (cross.get(key) ?? 0) + 1);
      if (side.inputTruncated) {
        inputCut += 1;
        if (side.dropped > 0) cutByDrop += 1;
        if (side.cutMessages > 0) cutByTruncateMessage += 1;
        if (samples.length < 5) {
          samples.push({
            session: id,
            seqStart: start,
            seqEnd: Number(mark?.seqEnd) || null,
            trigger: String(mark?.trigger ?? ""),
            truncated: mark?.truncated === true ? true : mark?.truncated === false ? false : null,
            dropped: side.dropped,
            cutMessages: side.cutMessages,
            keptMessages: messages.length,
          });
        }
      }
    }
  }

  const pct = (n, d) => (d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`);
  const crossOf = (t, input) => cross.get(`${t}|${input}`) ?? 0;
  const recorded = presence.inputTruncated + presence.inputDropped + presence.inputCutMessages + presence.dropped;
  const report = {
    home,
    graphs: scan.files.length,
    sessionsWithMarks: perSession.size,
    foldMarks: totalMarks,
    presence,
    recordedMarks: recorded,
    truncatedDist: Object.fromEntries(finishDist),
    replayed,
    noLog,
    inputCut,
    inputCutPct: totalMarks === 0 ? 0 : inputCut / totalMarks,
    cutByDrop,
    cutByTruncateMessage,
    cross: {
      "true|cut": crossOf("true", "cut"),
      "true|whole": crossOf("true", "whole"),
      "false|cut": crossOf("false", "cut"),
      "false|whole": crossOf("false", "whole"),
      "missing|cut": crossOf("missing", "cut"),
      "missing|whole": crossOf("missing", "whole"),
    },
    samples,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("=== 输入侧截断审计（只读）===");
  console.log(`home:   ${home}`);
  console.log(`graphs: ${report.graphs}（有 foldMark 的 ${report.sessionsWithMarks}）  foldMarks: ${report.foldMarks}`);
  console.log("");
  console.log("① 字段存在性 —— 写入点到底记没记「输入被裁」");
  for (const key of ["inputTruncated", "inputDropped", "inputCutMessages", "dropped"]) {
    console.log(`   ${key.padEnd(17)} ${presence[key]}`);
  }
  console.log(
    recorded === 0
      ? `   ⇒ **一条都没记**（0/${report.foldMarks}）—— 「输入被裁」在 foldMark 里压根没有字段。`
      : `   ⇒ 有字段的 mark：${recorded}/${report.foldMarks}（${pct(recorded, report.foldMarks)}）`,
  );
  console.log("");
  console.log("② 重放复算 —— 用写 mark 时同一套参数（maxChars=60000, fromSeq=seqStart）复跑 collectMessages");
  console.log(`   可重放 marks: ${replayed}（无会话日志 ${report.noLog}，无 seqStart 的为不知道）`);
  console.log(`   整条被丢弃（dropped>0）:      ${cutByDrop}`);
  console.log(`   单条正文被切（truncated）:    ${cutByTruncateMessage}`);
  console.log(`   ⇒ 输入侧被裁过:               ${inputCut}（占全部 foldMark 的 ${pct(inputCut, report.foldMarks)}）`);
  console.log("");
  console.log("③ 交叉表（foldMark.truncated × 输入侧是否被裁）");
  console.log(`   truncated=true   & 输入被裁 : ${report.cross["true|cut"]}`);
  console.log(`   truncated=true   & 输入完整 : ${report.cross["true|whole"]}`);
  console.log(`   truncated=false  & 输入被裁 : ${report.cross["false|cut"]}   ← **假「没截断」**（模型收尾了，但输入少了一截）`);
  console.log(`   truncated=false  & 输入完整 : ${report.cross["false|whole"]}`);
  console.log(`   truncated 缺失    & 输入被裁 : ${report.cross["missing|cut"]}`);
  console.log(`   truncated 缺失    & 输入完整 : ${report.cross["missing|whole"]}`);
  console.log("");
  if (samples.length > 0) {
    console.log("④ 样本（前 5 条「输入被裁」的 mark）");
    for (const s of samples) {
      console.log(
        `   ${s.session} #${s.seqStart}-${s.seqEnd} trigger=${s.trigger || "?"} truncated=${String(s.truncated)} ` +
          `dropped=${s.dropped} cutMessages=${s.cutMessages} kept=${s.keptMessages}`,
      );
    }
    console.log("");
  }
  console.log("⑤ 结论");
  if (recorded === 0) {
    console.log("   **没有任何字段记录「输入被裁」** ⇒ 这是要修的第一件事。");
  }
  if (report.cross["false|cut"] > 0) {
    console.log(
      `   ${report.cross["false|cut"]} 条 mark 是 truncated:false 但输入侧裁过 —— 假「没截断」，` +
        `占 truncated:false 的 ${pct(report.cross["false|cut"], report.cross["false|cut"] + report.cross["false|whole"])}。`,
    );
  } else if (replayed > 0) {
    console.log("   重放里没有「truncated:false 但输入被裁」的样本 —— 这一步收益低，可以降优先级。");
  }
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  main();
}
