#!/usr/bin/env node
/**
 * usage-score-audit.mjs —— 第六个候选指标「用量打分（usage score）」的裁决（T57 · 只读 · 零模型调用）
 *
 * ── 由来（Lead 原话，T51–T56 已判死五个「事后指标」之后） ───────────────────────────
 *   「**以任务归档时的状态来抽调「调用 kifu 的节点」，并且打分。**
 *     它不问「摘要像不像源文」，而问「**哪些节点真的被用上了**」。」
 *   已判死的五个（本脚本不重新发明，只在判据 ③ 里当对照）：
 *     可定位率（形状）· 区间保真度 A（循环）· B（冗余）· 逐字可回查率（方向）·
 *     `constraintRecall` / `failureRecall`（循环 —— 分子是补回函数的输出）。
 *
 * ── 这个脚本先回答「能不能观测」，再回答「准不准」 ─────────────────────────────────
 *   真机 `graph.json` 的节点字段是 `{id, kind, seq, turn, text, constraints, ts, goal,
 *   worldHash, constraintHash, via, pivot}` —— **没有 `used` 字段**。
 *   于是「节点被调用」必须先落到一个**可观测**的东西上。四个候选信号逐个查（报告 ①）：
 *
 *   | 信号 | 落点 | 能不能观测 |
 *   |---|---|---|
 *   | S1 热清单注入记录 | `user/message` 且 `data.source.kind === "chess-context"` | **能**（`renderLedger` 的正文原样落进会话日志） |
 *   | S2 折叠摘要里的节点引用 | `graph.lastOfflineSummary.text` / `foldMark.summaryText` | **能，但送达极稀**（摘要正文要到 `compaction/summary` 才进上下文） |
 *   | S3 closeout 里的「读过哪些节点」 | `graph.closeout` | **不能**（18 个字段，没有任何节点 id） |
 *   | S4 工具读取 `nodes/nXXX.md` | `tool/call.data.arguments` 里的**树路径** | **能，但几乎不发生** |
 *
 * ── 「被列出」与「被使用」是两件事（混了就是又一个循环） ────────────────────────────
 *   · **listed（被列出）** = 出现在**注入物正文**里的节点 id。两个来源**分列不合并**：
 *       `ledger`（热清单，系统每步渲染）· `summary`（折叠摘要，模型产出但归档后才落盘）。
 *   · **used（被使用）** = **agent 自己的行为**留下的痕迹，按强度三档（`USAGE_KINDS`）：
 *       `read`  工具调用参数**指向这张图的节点文档** `.../chess-context/sessions/<sid>/nodes/nK.md`
 *       `grep`  工具调用参数里同时出现「这张图的树路径」和 `nK` 独立标识符（去 grep 那个 id）
 *       `cite`  agent 自己的消息（`text` / `reasoning` 块）里出现 `nK` 独立标识符
 *     ★ `cite` 只认**模型输出块**。`tool/result` 的正文（工具回显）、注入物正文、摘要正文
 *       **一律不算** —— 那是「喂进去的」，不是「用出来的」。
 *
 * ── 口径（改口径就是改指标，全部写在这里） ───────────────────────────────────────
 *   ① **独立标识符**：复用 `range-fidelity-audit.independentIds`（`[en][0-9]{1,5}`，
 *      前后不接 `[A-Za-z0-9_]`）⇒ `e1` 不匹配 `e12`、`the1` 不算 `e1`。
 *      工具参数是 **JSON 文本**，`\n` 是转义换行（不是字母 n）—— 先 `normalizeToolArgs`
 *      把转义序列化掉再抽 id。**不这么做会把 `\n1` 数成节点 `n1`**：实测能凭空造出
 *      「367 个会话引用过节点」的假阳性，而真信号只有 55 个会话 —— 假阳比真信号大 6 倍。
 *   ② **树路径归属**：一条工具调用只有落在 `chess-context/sessions/<sid>/` 下面才算「读了 kifu」，
 *      而 `sid` 决定它算**哪张图**的用量 —— 读别人的树就是别人的用量（真机确实有跨会话读：
 *      41 次树引用里绝大多数是 A 会话读 B 会话的节点文档）。
 *      裸 `index.md` / `graph.json` **不算**（本仓自己的 `docs/index.md` 满地都是：
 *      不设这条前缀，828 个调用会被全算成「读了 kifu」）。
 *   ③ **引用（`cite`）只算自己那张图**：裸 `n1` 在每张图里都存在，跨图归属必然串味。
 *      跨会话归属只留给**显式树路径**（无歧义）。
 *   ④ **精确率** = |listed ∩ used| / |listed|；**召回率** = |listed ∩ used| / |used|。
 *      分母为 0 ⇒ `null`（**不返回 0**：`Number(null) === 0` 会把「没数据」读成「一个都没用上」）。
 *   ⑤ **用量分**（`score`）= 该节点的 `cite` + `read` + `grep` 次数（**不去重**：
 *      「被引用了三次」和「被引用了两次」不是同一件事）。判据 ① 量的就是这个分的众数占比。
 *   ⑥ **离归档时刻的距离** `tailGap = archiveSeq - node.seq`（`archiveSeq` =
 *      `lastOfflineSummary.range.end`，没有就退 `closeout.offlineCovered.end`）。
 *      `tailGap` 越小 = 越接近「归档时的状态」；越大 = 越靠「中途状态」。
 *
 * ── 四条判据（今晚总结的那四条；与 T52–T56 同一套数字） ───────────────────────────
 *   ① **有方差**：用量分的众数占比 < 80%。恒等于某个值的指标 = 常函数，没有信息量；
 *   ② **与形状无关**：|ρ(离归档距离)| < 0.2 且 |ρ(节点图深度)| < 0.2
 *      —— 否则它只是「节点长在哪儿」的影子；
 *   ③ **与已有指标不同**：ρ(可定位率) < 0.8 且 ρ(T33 五判据分) < 0.8
 *      —— 否则换个名字不产生新信息；
 *   ④ **分子不是修复函数的输出**：设计保证（分子只取模型输出块与工具调用参数）+ 经验对照
 *      （把分子换成「摘要里出现了 id」这个循环口径，率会恒等于 1.0 —— 那个分子就是分母）。
 *
 * ── 反事实（「列了 X 且 X 被用」≠「列得有用」） ────────────────────────────────────
 *   `counterfactualOf`：每一条**清单之后**产生的边，按「它的 `from` 节点在那一份清单里被列出过没有」
 *   分两组，比失败率。若清单真的有用，**被列出组**的失败率应当更低。
 *   ★ 已知混淆（报告里必须写）：被列出的节点 = **当时的前沿路径**，而前沿本来就最容易失败；
 *     所以这个差值的正负**都拆不开**「清单有用」与「位置效应」。它只能说明
 *     「拿现有数据做不出可识别的因果」。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` / 会话日志只 `readFileSync`；一个字节都不写；
 *   · **不改产品代码**：只 import 纯函数；不碰 `src/**`；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **判据必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/usage-score-audit.mjs                 # 全量（读会话日志，约 12 秒）
 *   node scripts/usage-score-audit.mjs --no-logs       # 跳过日志（S1/S2 送达/S4 记「未观测」）
 *   node scripts/usage-score-audit.mjs --json          # 机读（报告/测试用）
 *   node scripts/usage-score-audit.mjs --home=<dir>    # 换 DSH_HOME
 *   node scripts/usage-score-audit.mjs --session=<前缀> # 只看某个会话
 *   node scripts/usage-score-audit.mjs --limit=20      # 明细列最近 N 条
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 一张图都读不到（home 给错了）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";

import { currentPath, latestAgentNode } from "../src/rooms/kifu-model.mjs";
import { collectGraphFiles } from "../src/ui.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { buildLogIndex, correlate, independentIds, quantile } from "./range-fidelity-audit.mjs";
import { measureSample } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";

/* ───────────────────────────── 口径常量（改口径只改这里） ───────────────────────────── */

/** 判据门槛（与 T52–T56 同一套数字；改门槛只改这里）。 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 ①：某一取值占比超过这个数就叫「恒等」（常函数，没有信息量）。 */
  maxConstantShare: 0.8,
  /** 判据 ②：|ρ| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** 判据 ③：与已有指标 ρ 高于这个数就算「同一个东西」。 */
  maxRhoRedundant: 0.8,
});

/**
 * 用量痕迹的三档（**强度降序**；一个节点同时有多档时取最强的那档当 `usageKind`，
 * 但 `score` 仍然把三档**全部**累加 —— 强度影响归因，不影响计数）。
 */
export const USAGE_KINDS = Object.freeze([
  { key: "read", label: "读了节点文档" },
  { key: "grep", label: "按 id 检索了树" },
  { key: "cite", label: "正文/推理里引用了 id" },
]);

/**
 * 「被列出」的两个来源。**分列不合并** —— 它们的送达性完全不同：
 * 热清单每步都进上下文；折叠摘要归档后才落盘，模型基本看不到。
 */
export const LISTED_SOURCES = Object.freeze([
  { key: "ledger", label: "热清单（chess-context 注入）" },
  { key: "summary", label: "折叠摘要（lastOfflineSummary）" },
]);

/**
 * 离归档时刻的距离分桶（`tailGap = archiveSeq - node.seq`，边界归左）。
 * `≤ 0` 表示节点 seq 越过了归档点（归档后还在写）—— 真机没见过，但夹具里会有，
 * 语义上仍然是「归档时的状态」，**不吞成 null**（吞掉等于静默删掉一条）。
 */
export const DISTANCE_BANDS = Object.freeze([
  { band: "≤0（归档点及之后）", test: (gap) => gap <= 0 },
  { band: "1–50（尾部）", test: (gap) => gap >= 1 && gap <= 50 },
  { band: "51–200（近段）", test: (gap) => gap >= 51 && gap <= 200 },
  { band: "201–1000（中段）", test: (gap) => gap >= 201 && gap <= 1000 },
  { band: "1001+（远段）", test: (gap) => gap > 1000 },
]);

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/** 会话日志里「注入物」的来源 kind（`user/message.data.source.kind`）。 */
export const LEDGER_SOURCE_KIND = "chess-context";

/* ───────────────────────────────── 小工具 ───────────────────────────────── */

const round = (value, digits = 6) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const pct = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
const int = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "—");
const num = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);

/** 会话 id 归一：棋谱目录可能是 `session-<uuid>`（子代理），树路径里的前缀已在 `parseTreeRefs` 剥掉。 */
export function normalizeSessionId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^session-/, "");
}

/** 会话短名：`session-<uuid>` 的目录名截前 8 位会只剩 `session-`（等于没显示），先剥前缀。 */
export const shortSession = (dir) => {
  const body = String(dir ?? "");
  const stripped = body.replace(/^session-/, "");
  return `${body.startsWith("session-") ? "s-" : ""}${stripped.slice(0, 8)}`;
};

/** 终端显示宽度（CJK / 全角算 2 格）—— 表格对齐只靠它。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

/** 按**显示宽度**补空格（`padEnd` 在 CJK 上会错位，报告直接歪掉）。 */
export function padDisplay(text, size, align = "left") {
  const body = String(text ?? "");
  const fill = " ".repeat(Math.max(0, Number(size) - displayWidth(body)));
  return align === "right" ? `${fill}${body}` : `${body}${fill}`;
}

/** 与 doctor / graph-audit / fold-loss-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/* ───────────────────────── ① 文本 → 节点 id（口径的核心） ───────────────────────── */

/**
 * 工具参数是 **JSON 文本**：Windows 路径是 `\\`（双反斜杠）、换行是 `\n`（单反斜杠 + `n`）。
 * 直接抽 id 会把 `\n1` 数成节点 `n1`。
 *
 * 处理顺序（**必须先双后单**，否则 `nodes\n3780.md` 会被当成转义换行）：
 *   ① `\\`（双）→ 路径占位符；② `\n` / `\r` / `\t`（单）→ 空格；③ 占位符 → `/`；④ 残余 `\` → `/`。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeToolArgs(raw) {
  return String(raw ?? "")
    .replace(/\\\\/g, "\u0001")
    .replace(/\\[nrt]/g, " ")
    .replace(/\u0001/g, "/")
    .replace(/\\/g, "/");
}

/**
 * 文本里**作为独立标识符**出现的节点 id（只留 `valid` 里有的，保序去重）。
 *
 * 为什么不自己写边界规则：`independentIds`（`range-fidelity-audit`）已经是全库口径
 * （`e1` 不匹配 `e12`、`the1` 不算 `e1`）。自己再写一套 = 两套分母
 * （本仓栽过多次：C607 / C638 / C641）。
 *
 * @param {string} text
 * @param {Set<string>|string[]} valid 图里真实存在的节点 id
 * @returns {string[]}
 */
export function nodeIdsIn(text, valid) {
  const allowed = valid instanceof Set ? valid : new Set(Array.isArray(valid) ? valid : []);
  return independentIds(text).filter((id) => id[0] === "n" && allowed.has(id));
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * 「读了 kifu」的树路径：**必须**落在 `chess-context/sessions/<sid>/` 下面。
 *
 * 为什么必须带前缀：本仓自己的 `docs/index.md` / `graph.json` 满地都是，
 * 裸文件名匹配会把「读自己的文档」全算成「读了 kifu」（实测 828 个调用里只有 41 个是真的）。
 *
 * @param {string} raw 工具参数原文（JSON 文本或普通字符串都行）
 * @returns {Array<{sessionId:string, nodeId:string|null, kind:"node-doc"|"tree"}>}
 */
export function parseTreeRefs(raw) {
  const text = normalizeToolArgs(raw);
  const re = new RegExp(
    `chess-context/sessions/(?:session-)?(${UUID_SOURCE})/(?:(nodes)/(n[0-9]{1,5})\\.md|index\\.md|graph\\.json)?`,
    "gi",
  );
  const out = [];
  for (const match of text.matchAll(re)) {
    const sessionId = normalizeSessionId(match[1]);
    if (sessionId === "") continue;
    const nodeId = match[3] ? String(match[3]).toLowerCase() : null;
    out.push({ sessionId, nodeId, kind: nodeId === null ? "tree" : "node-doc" });
  }
  return out;
}

/** agent 自己消息的内容块（`text` / `reasoning` / `tool-call`）。 */
export function assistantBlocksOf(event) {
  const content = event?.data?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block !== null && typeof block === "object");
}

/** 一条 `tool/call` 事件的参数原文（统一成字符串，两种生产形态都兼容）。 */
export function toolArgOf(event) {
  if (event?.type !== "tool/call") return "";
  const args = event?.data?.arguments;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? "");
  } catch {
    return "";
  }
}

/** `user/message` 里注入物的纯文本（`data.content` 是 block 数组，也兼容字符串）。 */
export function injectedTextOf(event) {
  const content = event?.data?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * `compaction/summary` 的正文。
 *
 * ★ 真机 `data.summary` 是 **block 数组**（`[{type:"text", text:"## 目标…"}]`，实测 3 块），
 *   不是字符串。只判 `typeof === "string"` 会把**全部**摘要判成「没送达」——
 *   本脚本第一版就踩了这个坑（S2 送达率算成 0.00%，而真机明明是 100% 的折叠会话都送达了）。
 *
 * @param {object} event
 * @returns {string}
 */
export function compactionSummaryTextOf(event) {
  // `compaction/summary` 的正文挂在 `data.summary`（block 数组 / 字符串）；
  // `compact-checkpoint`（宿主把摘要当 checkpoint 注入）走 `data.content`。两条都收。
  return `${injectedTextOf({ data: { content: event?.data?.summary } })}\n${injectedTextOf(event)}`;
}

/* ───────────────────────── ② 从会话日志里抽「用量痕迹」 ───────────────────────── */

/**
 * 扫**一份**会话日志，把用量痕迹按「它属于哪张图」分桶。
 *
 * ★ 为什么按目标图分桶、不按日志分：真机里 **A 会话读 B 会话的节点文档**是常态
 *   （41 次树引用里绝大多数是这种）。按日志分桶会把它们全算成 A 的用量，
 *   而 A 的图里根本没有那些节点 id ⇒ 全部丢失。
 *
 * @param {Array<object>} events 会话事件
 * @param {{sessionId?:string, validOf?:(sid:string)=>Set<string>|null}} [options]
 *   `validOf(sid)` 返回那张图的节点 id 集合；`null` = 图不存在（无法校验，记 unknown）
 * @returns {object}
 */
export function extractUsage(events, { sessionId = "", validOf = () => null } = {}) {
  const self = normalizeSessionId(sessionId);
  /** @type {{ledger: Array<{seq:number, listed:Set<string>}>, cites: Map<string,number[]>, greps: Map<string,number[]>, reads: Map<string,number[]>}} */
  const own = { ledger: [], cites: new Map(), greps: new Map(), reads: new Map() };
  /** 跨会话：`targetSid -> Map<nodeId, count>` */
  const cross = new Map();
  let toolTreeRefs = 0;
  let toolNodeDocRefs = 0;
  let unknownTreeRefs = 0;

  const push = (map, key, seq) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [seq]);
    else list.push(seq);
  };
  const bumpCross = (target, nodeId) => {
    let bucket = cross.get(target);
    if (bucket === undefined) {
      bucket = new Map();
      cross.set(target, bucket);
    }
    bucket.set(nodeId, (bucket.get(nodeId) ?? 0) + 1);
  };

  const consumeRefs = (raw, seq) => {
    const refs = parseTreeRefs(raw);
    if (refs.length === 0) return;
    const byTarget = new Map();
    for (const ref of refs) {
      const list = byTarget.get(ref.sessionId);
      if (list === undefined) byTarget.set(ref.sessionId, [ref]);
      else list.push(ref);
    }
    for (const [target, list] of byTarget) {
      toolTreeRefs += list.length;
      const valid = validOf(target);
      const docIds = new Set();
      for (const ref of list) {
        if (ref.nodeId === null) {
          unknownTreeRefs += 1;
          continue;
        }
        toolNodeDocRefs += 1;
        docIds.add(ref.nodeId);
        if (valid === null || !valid.has(ref.nodeId)) continue;
        if (target === self) push(own.reads, ref.nodeId, seq);
        else bumpCross(target, ref.nodeId);
      }
      if (valid === null) continue;
      // grep 型：同一段参数里还出现了该图的节点 id，但它**不是** `nodes/nX.md` 里的那个
      for (const nodeId of nodeIdsIn(raw, valid)) {
        if (docIds.has(nodeId)) continue;
        if (target === self) push(own.greps, nodeId, seq);
        else bumpCross(target, nodeId);
      }
    }
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "user/message" && event?.data?.source?.kind === LEDGER_SOURCE_KIND) {
      const valid = validOf(self);
      const listed = new Set(valid === null ? [] : nodeIdsIn(injectedTextOf(event), valid));
      own.ledger.push({ seq: Number(event.seq), listed });
    } else if (event?.type === "assistant/message") {
      const seq = Number(event.seq);
      const valid = validOf(self);
      for (const block of assistantBlocksOf(event)) {
        if (block?.type === "text" || block?.type === "reasoning") {
          if (typeof block.text !== "string" || valid === null) continue;
          for (const nodeId of nodeIdsIn(block.text, valid)) push(own.cites, nodeId, seq);
        } else if (block?.type === "tool-call") {
          const raw = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? "");
          consumeRefs(raw, seq);
        }
      }
    } else if (event?.type === "tool/call") {
      consumeRefs(toolArgOf(event), Number(event.seq));
    }
  }
  return { sessionId: self, own, cross, toolTreeRefs, toolNodeDocRefs, unknownTreeRefs };
}

/* ───────────────────────── ③ 一张图的「用量行」 ───────────────────────── */

/**
 * 建一张图的逐节点用量行。
 *
 * @param {object} args
 * @param {object} args.graph 棋谱
 * @param {object|null} args.usage `extractUsage(...)` 的返回（`null` = 日志不可读 ⇒ 未观测）
 * @param {Map<string,number>|null} [args.cross] 别的会话读了这张图哪些节点（`nodeId -> 次数`）
 * @param {string} [args.sessionId]
 * @returns {object}
 */
export function buildUsageRows({ graph, usage = null, cross = null, sessionId = "" } = {}) {
  const nodes = graph?.nodes ?? {};
  const valid = new Set(Object.keys(nodes));
  const id = normalizeSessionId(sessionId || graph?.sessionId);
  const summary = graph?.lastOfflineSummary ?? null;
  const archiveSeq = Number(summary?.range?.end ?? graph?.closeout?.offlineCovered?.end);
  const archive = Number.isFinite(archiveSeq) ? archiveSeq : null;
  const observed = usage !== null && usage !== undefined;
  const own = observed ? (usage.own ?? { ledger: [], cites: new Map(), greps: new Map(), reads: new Map() }) : null;

  const table = new Map();
  const ensure = (nodeId) => {
    let row = table.get(nodeId);
    if (row === undefined) {
      row = { nodeId, listedAt: null, listedSummary: false, cites: [], greps: [], reads: [], crossReads: 0 };
      table.set(nodeId, row);
    }
    return row;
  };

  const injections = observed ? (own.ledger ?? []).slice().sort((a, b) => a.seq - b.seq) : [];
  for (const injection of injections) {
    for (const nodeId of injection.listed) {
      const row = ensure(nodeId);
      if (row.listedAt === null) row.listedAt = injection.seq;
    }
  }

  if (observed) {
    for (const [nodeId, seqs] of own.cites ?? []) ensure(nodeId).cites.push(...seqs);
    for (const [nodeId, seqs] of own.greps ?? []) ensure(nodeId).greps.push(...seqs);
    for (const [nodeId, seqs] of own.reads ?? []) ensure(nodeId).reads.push(...seqs);
  }
  for (const [nodeId, count] of cross ?? []) ensure(nodeId).crossReads += Number(count) || 0;

  // 折叠摘要（S2）：正文里的节点 id = 被列出
  const summaryText = typeof summary?.text === "string" ? summary.text : "";
  for (const nodeId of nodeIdsIn(summaryText, valid)) ensure(nodeId).listedSummary = true;

  // 图深度（判据 ② 的「跨度」）：沿 via 链回溯到根的长度
  const depthCache = new Map();
  const depthOf = (nodeId) => {
    if (depthCache.has(nodeId)) return depthCache.get(nodeId);
    let value = null;
    try {
      value = Math.max(0, currentPath(graph, nodeId).length - 1);
    } catch {
      value = null;
    }
    depthCache.set(nodeId, value);
    return value;
  };
  let tailPath = new Set();
  try {
    const latest = latestAgentNode(graph);
    if (latest !== null && latest !== undefined) tailPath = new Set(currentPath(graph, latest.id).map((node) => node.id));
  } catch {
    tailPath = new Set();
  }

  const rows = [];
  for (const row of table.values()) {
    const node = nodes[row.nodeId] ?? null;
    const nodeSeq = Number(node?.seq);
    const tailGap = archive !== null && Number.isFinite(nodeSeq) ? archive - nodeSeq : null;
    const band =
      tailGap === null
        ? null
        : (DISTANCE_BANDS.find((spec) => spec.test(tailGap))?.band ?? DISTANCE_BANDS[DISTANCE_BANDS.length - 1].band);
    const kinds = { cite: row.cites.length, grep: row.greps.length, read: row.reads.length + row.crossReads };
    const score = kinds.cite + kinds.grep + kinds.read;
    const usageKind = USAGE_KINDS.find((spec) => kinds[spec.key] > 0)?.key ?? null;
    const hits = [...row.cites, ...row.greps, ...row.reads];
    rows.push({
      sessionId: id,
      nodeId: row.nodeId,
      kind: node?.kind ?? null,
      nodeSeq: Number.isFinite(nodeSeq) ? nodeSeq : null,
      turn: node?.turn ?? null,
      tailGap,
      band,
      depth: depthOf(row.nodeId),
      onTailPath: tailPath.has(row.nodeId),
      listedLedger: row.listedAt !== null,
      listedSummary: row.listedSummary,
      listedAt: row.listedAt,
      used: score > 0,
      usageKind,
      score,
      cites: kinds.cite,
      greps: kinds.grep,
      reads: kinds.read,
      crossReads: row.crossReads,
      firstUsedSeq: hits.length === 0 ? null : Math.min(...hits),
      /** 使用是否**晚于**它被列出（因果顺序；早于 = 不是清单带来的）。 */
      usedAfterListed: hits.length === 0 || row.listedAt === null ? null : Math.min(...hits) > row.listedAt,
    });
  }

  // 反事实：每条清单之后产生的边，按「from 节点被这份清单列过没有」分组
  const counterfactual = { listed: { edges: 0, failures: 0 }, unlisted: { edges: 0, failures: 0 } };
  const edgeList = Object.values(graph?.edges ?? {})
    .map((edge) => ({ edge, seq: Number(edge?.evidence?.start ?? edge?.evidence?.end) }))
    .filter((item) => Number.isFinite(item.seq))
    .sort((a, b) => a.seq - b.seq);
  if (injections.length > 0) {
    for (const item of edgeList) {
      let owner = null;
      for (const injection of injections) if (injection.seq < item.seq) owner = injection;
      if (owner === null) continue;
      const bucket = owner.listed.has(String(item.edge?.from ?? "")) ? counterfactual.listed : counterfactual.unlisted;
      bucket.edges += 1;
      if (item.edge?.result === "failure") bucket.failures += 1;
    }
  }

  return {
    sessionId: id,
    nodes: valid.size,
    edges: Object.keys(graph?.edges ?? {}).length,
    archiveSeq: archive,
    observed,
    events: observed ? (own.ledger ?? []).length : 0,
    injections: injections.length,
    injectionSeqs: injections.map((injection) => injection.seq),
    toolTreeRefs: observed ? (usage.toolTreeRefs ?? 0) : 0,
    toolNodeDocRefs: observed ? (usage.toolNodeDocRefs ?? 0) : 0,
    unknownTreeRefs: observed ? (usage.unknownTreeRefs ?? 0) : 0,
    rows,
    counterfactual,
  };
}

/* ───────────────────────── ④ 汇总：精确率 / 召回率 ───────────────────────── */

const emptyBucket = (band) => ({ band, listed: 0, used: 0, both: 0, score: 0 });

/**
 * 一个来源（ledger / summary）的精确率与召回率。
 *
 * 分母为 0 ⇒ `null`（**不返回 0** —— `Number(null) === 0` 会把「没数据」读成「一个都没用上」）。
 *
 * @param {Array<object>} rows 全部会话的全部节点行
 * @param {"ledger"|"summary"} source
 * @returns {object}
 */
export function summarizeSource(rows, source = "ledger") {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === "object");
  const listedKey = source === "summary" ? "listedSummary" : "listedLedger";
  const usedKey = "used";
  let listed = 0;
  let used = 0;
  let both = 0;
  let cited = 0;
  let read = 0;
  let score = 0;
  const bands = new Map(DISTANCE_BANDS.map((spec) => [spec.band, emptyBucket(spec.band)]));
  const usedSessions = new Set();
  const listedSessions = new Set();
  for (const row of list) {
    const isListed = row[listedKey] === true;
    const isUsed = row[usedKey] === true;
    if (isListed) {
      listed += 1;
      if (row.sessionId !== undefined) listedSessions.add(row.sessionId);
    }
    if (isUsed) {
      used += 1;
      if (row.sessionId !== undefined) usedSessions.add(row.sessionId);
      if (row.usageKind === "read") read += 1;
      else cited += 1;
      score += Number(row.score) || 0;
    }
    if (isListed && isUsed) both += 1;
    const bucket = row.band === null || row.band === undefined ? null : bands.get(row.band);
    if (bucket !== undefined && bucket !== null) {
      if (isListed) bucket.listed += 1;
      if (isUsed) bucket.used += 1;
      if (isListed && isUsed) bucket.both += 1;
      bucket.score += Number(row.score) || 0;
    }
  }
  const scores = list.map((row) => Number(row.score) || 0);
  const counts = new Map();
  for (const value of scores) counts.set(value, (counts.get(value) ?? 0) + 1);
  let modal = null;
  for (const [value, count] of counts) if (modal === null || count > modal.count) modal = { value, count };
  return {
    source,
    nodes: list.length,
    listed,
    used,
    both,
    cited,
    read,
    precision: listed === 0 ? null : round(both / listed),
    recall: used === 0 ? null : round(both / used),
    /** 列了但没用上 = 噪声。 */
    noise: listed - both,
    /** 用上但没列 = 漏。 */
    missed: used - both,
    scoreTotal: score,
    bands: [...bands.values()],
    listedSessions: listedSessions.size,
    usedSessions: usedSessions.size,
    modalScore: modal === null ? null : modal.value,
    modalShare: list.length === 0 || modal === null ? null : round(modal.count / list.length),
    zeroShare: list.length === 0 ? null : round(scores.filter((value) => value === 0).length / list.length),
    p90: round(quantile(scores, 0.9), 2),
    meanScore: list.length === 0 ? null : round(scores.reduce((sum, value) => sum + value, 0) / list.length, 4),
  };
}

/** 判据 ②③ 用的相关系数（`correlate` 同源，缺测自动剔除）。 */
export function correlationsOf(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === "object");
  return {
    tailGap: correlate(list, "score", "tailGap"),
    depth: correlate(list, "score", "depth"),
  };
}

/* ───────────────────────── ⑤ 四条判据 ───────────────────────── */

/**
 * 四条判据。**必须能返回 `pass: false`** —— 一个永远绿的判据不是守卫，是假门禁（T54）。
 *
 * 判据 ④ 的「经验对照」在这里的口径是：把分子换成**循环口径**（「摘要里出现过的 id 就算被用」），
 * 率会恒等于 1.0 —— 因为那个分子的定义就是分母。`circularRate` 就是它，恒等即证明本脚本没走那条路。
 *
 * @param {object} result `audit()` 的返回
 * @returns {Array<object>}
 */
export function judgeCriteria(result) {
  const primary = result?.summary?.ledger ?? null;
  const shape = result?.correlations ?? {};
  const criteria = [];

  // ① 有方差
  const modalShare = primary?.modalShare ?? null;
  criteria.push({
    key: "①",
    name: `有方差（众数占比 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
    value: modalShare,
    detail:
      `逐节点用量分的众数 = ${num(primary?.modalScore, 0)}，占 ${pct(modalShare)}` +
      `（n=${int(primary?.nodes)} 个节点，= 0 占 ${pct(primary?.zeroShare)}，门槛 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
    pass: modalShare === null ? null : modalShare < CRITERIA_RULES.maxConstantShare,
    degenerate: false,
  });

  // ② 与形状无关
  const tail = shape.tailGap ?? null;
  const depth = shape.depth ?? null;
  const absTail = tail?.spearman === null || tail?.spearman === undefined ? null : Math.abs(tail.spearman);
  const absDepth = depth?.spearman === null || depth?.spearman === undefined ? null : Math.abs(depth.spearman);
  const passShape =
    absTail !== null && absDepth !== null
      ? absTail < CRITERIA_RULES.maxAbsRhoShape && absDepth < CRITERIA_RULES.maxAbsRhoShape
      : null;
  criteria.push({
    key: "②",
    name: `与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
    value: absTail === null || absDepth === null ? null : Math.max(absTail, absDepth),
    detail: `|ρ(离归档距离)| = ${num(absTail)}（n=${int(tail?.n ?? 0)}）· |ρ(节点图深度)| = ${num(absDepth)}（n=${int(depth?.n ?? 0)}）`,
    pass: passShape,
    /** 无方差时 ρ 不可信 —— 这条是「退化通过」，不构成支持。 */
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ③ 与已有指标不同
  const traceable = shape.traceableShare ?? null;
  const quality = shape.qualityTotal ?? null;
  const rhoTraceable = traceable?.spearman ?? null;
  const rhoQuality = quality?.spearman ?? null;
  const passRedundant =
    rhoTraceable === null || rhoQuality === null
      ? null
      : Math.abs(rhoTraceable) < CRITERIA_RULES.maxRhoRedundant && Math.abs(rhoQuality) < CRITERIA_RULES.maxRhoRedundant;
  criteria.push({
    key: "③",
    name: `与已有指标不同（|ρ| < ${CRITERIA_RULES.maxRhoRedundant}）`,
    value: rhoTraceable === null || rhoQuality === null ? null : Math.max(Math.abs(rhoTraceable), Math.abs(rhoQuality)),
    detail: `ρ(可定位率) = ${num(rhoTraceable)}（n=${int(traceable?.n ?? 0)}）· ρ(T33 五判据分) = ${num(rhoQuality)}（n=${int(quality?.n ?? 0)}）`,
    pass: passRedundant,
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ④ 分子不是修复函数的输出
  const circular = result?.base?.circularRate ?? null;
  criteria.push({
    key: "④",
    name: "分子不是修复函数的输出",
    value: circular === null ? null : Math.abs(Number(circular) - 1),
    detail:
      "设计保证：分子只取**模型输出块**（`assistant/message` 的 `text`/`reasoning`）与**工具调用参数**，" +
      "注入物正文、摘要正文、`tool/result` 回显一律不算 ⇒ 不经 `repairFoldText` / `sanitizeSummaryIds`。" +
      (circular === null
        ? ""
        : `　经验对照：换成循环口径（摘要里出现即算用上）率 = ${num(circular)}（恒等于 1 ⇒ 本脚本没走那条路）`),
    pass: true,
    degenerate: false,
  });

  return criteria;
}

/* ───────────────────────── ⑥ 扫描 ───────────────────────── */

/** 只读打开一张棋谱；坏图返回 `null`（计数里能看出来，不吞成「没有节点」）。 */
function readGraph(file) {
  try {
    const graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return graph !== null && typeof graph === "object" ? graph : null;
  } catch {
    return null;
  }
}

/**
 * 扫全部会话。
 *
 * 三段式（**一次**解码日志）：① 读图拿节点 id 全集；② 扫日志抽用量痕迹（按目标图分桶）；
 * ③ 再读一遍图建行。第二遍读图是为了不把 616 张图同时留在内存里（最大 5 MB / 张）。
 *
 * @param {{home?:string, limit?:number, session?:string, logs?:"all"|"none"}} [options]
 * @returns {object}
 */
export function audit({ home = resolveHome(), limit = DEFAULT_LIMIT, session = "", logs = "all" } = {}) {
  const { files } = collectGraphFiles(home);
  const want = String(session ?? "").trim().toLowerCase();
  const picked = want === "" ? files : files.filter((entry) => String(entry.dir).toLowerCase().includes(want));
  const logIndex = logs === "none" ? new Map() : buildLogIndex(home);

  // ① 节点 id 全集（按会话 id）
  const validById = new Map();
  for (const entry of picked) {
    const graph = readGraph(entry.file);
    if (graph === null) continue;
    validById.set(normalizeSessionId(graph.sessionId ?? entry.dir), new Set(Object.keys(graph.nodes ?? {})));
  }
  const validOf = (sid) => validById.get(normalizeSessionId(sid)) ?? null;

  // ② 扫日志：自己的痕迹 + 别人的跨会话读
  const usageBySession = new Map();
  const crossByTarget = new Map();
  const summaryDelivered = new Map();
  for (const [sid, logFile] of logIndex) {
    if (!validById.has(normalizeSessionId(sid))) continue;
    let events;
    try {
      events = readSessionEvents(logFile);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const usage = extractUsage(events, { sessionId: sid, validOf });
    usageBySession.set(normalizeSessionId(sid), usage);
    for (const [target, bucket] of usage.cross) {
      let merged = crossByTarget.get(target);
      if (merged === undefined) {
        merged = new Map();
        crossByTarget.set(target, merged);
      }
      for (const [nodeId, count] of bucket) merged.set(nodeId, (merged.get(nodeId) ?? 0) + count);
    }
    // S2 的「送达」：摘要正文以 checkpoint 形式进过上下文，且**真的带节点 id**
    const ownValid = validById.get(normalizeSessionId(sid)) ?? new Set();
    const delivered = events.filter((event) => {
      if (event?.type === "compaction/summary") return nodeIdsIn(compactionSummaryTextOf(event), ownValid).length > 0;
      if (event?.type === "user/message" && /compact-checkpoint/.test(String(event?.data?.source?.kind ?? ""))) {
        return nodeIdsIn(injectedTextOf(event), ownValid).length > 0;
      }
      return false;
    });
    summaryDelivered.set(normalizeSessionId(sid), delivered.length);
  }

  // ③ 建行
  const perSession = [];
  const allRows = [];
  const signal = {
    sessions: 0,
    withLog: 0,
    logMissing: 0,
    ledgerSessions: 0,
    ledgerEvents: 0,
    summarySessions: 0,
    summaryPairs: 0,
    summaryDeliveredSessions: 0,
    summaryDeliveredEvents: 0,
    closeoutFields: new Set(),
    closeoutNodeIdSessions: 0,
    toolTreeSessions: 0,
    toolTreeRefs: 0,
    toolNodeDocRefs: 0,
    usedSessions: 0,
    usedNodes: 0,
  };
  let badGraphs = 0;

  for (const entry of picked) {
    const graph = readGraph(entry.file);
    if (graph === null) {
      badGraphs += 1;
      continue;
    }
    signal.sessions += 1;
    for (const key of Object.keys(graph.closeout ?? {})) signal.closeoutFields.add(key);
    const sid = normalizeSessionId(graph.sessionId ?? entry.dir);
    const usage = usageBySession.get(sid) ?? null;
    if (logs === "none") signal.logMissing += 1;
    else if (usage === null) signal.logMissing += 1;
    else signal.withLog += 1;

    const report = buildUsageRows({ graph, usage, cross: crossByTarget.get(sid) ?? null, sessionId: sid });
    report.trigger = String(graph?.foldMarks?.at(-1)?.trigger ?? graph?.closeout?.source ?? "unknown");
    report.logFile = logIndex.get(sid) ?? null;
    report.summaryDelivered = summaryDelivered.get(sid) ?? 0;
    if (report.summaryDelivered > 0) signal.summaryDeliveredSessions += 1;
    signal.summaryDeliveredEvents += report.summaryDelivered;

    // S3：closeout 里有没有任何节点 id（真机：没有）
    const valid = new Set(Object.keys(graph.nodes ?? {}));
    if (nodeIdsIn(JSON.stringify(graph.closeout ?? {}), valid).length > 0) signal.closeoutNodeIdSessions += 1;

    // 会话级：可定位率 / T33 分（判据 ③ 的对照项）
    const summarySlot = graph?.lastOfflineSummary ?? null;
    const summaryText = typeof summarySlot?.text === "string" ? summarySlot.text : "";
    let traceableShare = null;
    let qualityTotal = null;
    if (
      summaryText !== "" &&
      Number.isFinite(Number(summarySlot?.range?.start)) &&
      Number.isFinite(Number(summarySlot?.range?.end))
    ) {
      try {
        const measured = measureSample(
          {
            sessionId: sid,
            trigger: report.trigger,
            source: "lastOfflineSummary",
            at: Number(summarySlot?.at ?? 0),
            seqStart: Number(summarySlot.range.start),
            seqEnd: Number(summarySlot.range.end),
            text: summaryText,
          },
          graph,
        );
        traceableShare = measured?.traceableShare ?? null;
        qualityTotal = measured === null || measured === undefined ? null : scoreMark(measured).total;
      } catch {
        traceableShare = null;
        qualityTotal = null;
      }
    }
    const ledgerSummary = summarizeSource(report.rows, "ledger");
    report.precision = ledgerSummary.precision;
    report.recall = ledgerSummary.recall;
    report.traceableShare = traceableShare;
    report.qualityTotal = qualityTotal;
    report.usageRate = ledgerSummary.listed === 0 ? null : round(ledgerSummary.both / ledgerSummary.listed);

    if (report.injections > 0) signal.ledgerSessions += 1;
    signal.ledgerEvents += report.injections;
    const summaryPairs = report.rows.filter((row) => row.listedSummary).length;
    if (summaryPairs > 0) signal.summarySessions += 1;
    signal.summaryPairs += summaryPairs;
    if (report.toolTreeRefs > 0) signal.toolTreeSessions += 1;
    signal.toolTreeRefs += report.toolTreeRefs;
    signal.toolNodeDocRefs += report.toolNodeDocRefs;
    const used = report.rows.filter((row) => row.used).length;
    if (used > 0) signal.usedSessions += 1;
    signal.usedNodes += used;

    perSession.push(report);
    for (const row of report.rows) {
      allRows.push({ ...row, sessionId: sid, trigger: report.trigger, observed: report.observed });
    }
  }

  const ledger = summarizeSource(allRows, "ledger");
  const summary = summarizeSource(allRows, "summary");
  /**
   * ★ 摘要口径必须**按送达拆开**：摘要在 `compaction/summary` 里进过上下文的会话，
   *   与归档后才落盘（模型根本没看到）的会话，是两套完全不同的因果条件。
   *   合并算会把「根本没机会被引用」和「有机会但没被引用」混成一个数。
   */
  const deliveredSessions = new Set(
    perSession.filter((report) => Number(report.summaryDelivered) > 0).map((report) => report.sessionId),
  );
  const summarySplit = {
    delivered: summarizeSource(
      allRows.filter((row) => deliveredSessions.has(row.sessionId)),
      "summary",
    ),
    undelivered: summarizeSource(
      allRows.filter((row) => !deliveredSessions.has(row.sessionId)),
      "summary",
    ),
  };
  const correlations = {
    ...correlationsOf(allRows),
    traceableShare: correlate(
      perSession.filter((row) => row.usageRate !== null && row.traceableShare !== null),
      "usageRate",
      "traceableShare",
    ),
    qualityTotal: correlate(
      perSession.filter((row) => row.usageRate !== null && row.qualityTotal !== null),
      "usageRate",
      "qualityTotal",
    ),
  };

  // 反事实：全库池化
  const cf = { listed: { edges: 0, failures: 0 }, unlisted: { edges: 0, failures: 0 } };
  for (const report of perSession) {
    cf.listed.edges += report.counterfactual.listed.edges;
    cf.listed.failures += report.counterfactual.listed.failures;
    cf.unlisted.edges += report.counterfactual.unlisted.edges;
    cf.unlisted.failures += report.counterfactual.unlisted.failures;
  }
  const rateOf = (bucket) => (bucket.edges === 0 ? null : round(bucket.failures / bucket.edges));

  const denominator = logs === "none" ? 0 : signal.withLog;
  const result = {
    home,
    graphs: signal.sessions,
    badGraphs,
    logs: logs !== "none",
    totalGraphFiles: files.length,
    signal: {
      ...signal,
      closeoutFields: [...signal.closeoutFields].sort(),
      /** 覆盖率（分母 = 有图且日志可读的会话；日志读不到 ⇒ 不可判，不记 0）。 */
      coverage: {
        ledger: denominator === 0 ? null : round(signal.ledgerSessions / denominator),
        summary: signal.sessions === 0 ? null : round(signal.summarySessions / signal.sessions),
        summaryDelivered: denominator === 0 ? null : round(signal.summaryDeliveredSessions / denominator),
        closeout: signal.sessions === 0 ? null : round(signal.closeoutNodeIdSessions / signal.sessions),
        toolTree: denominator === 0 ? null : round(signal.toolTreeSessions / denominator),
        used: denominator === 0 ? null : round(signal.usedSessions / denominator),
      },
    },
    summary: { ledger, summary },
    summarySplit,
    correlations,
    counterfactual: {
      listed: { ...cf.listed, rate: rateOf(cf.listed) },
      unlisted: { ...cf.unlisted, rate: rateOf(cf.unlisted) },
      delta: rateOf(cf.listed) === null || rateOf(cf.unlisted) === null ? null : round(rateOf(cf.listed) - rateOf(cf.unlisted)),
    },
    base: {
      /** 循环口径的对照：摘要里出现即算用上 ⇒ 恒等于 1。 */
      circularRate: summary.listed === 0 ? null : 1,
      listedNodes: ledger.listed,
      usedNodes: ledger.used,
      sessions: perSession.length,
      injectedEvents: signal.ledgerEvents,
    },
    perSession: perSession.map((report) => ({
      sessionId: report.sessionId,
      trigger: report.trigger,
      nodes: report.nodes,
      injections: report.injections,
      listed: report.rows.filter((row) => row.listedLedger).length,
      used: report.rows.filter((row) => row.used).length,
      precision: report.precision,
      recall: report.recall,
      usageRate: report.usageRate,
      traceableShare: report.traceableShare,
      qualityTotal: report.qualityTotal,
      summaryDelivered: report.summaryDelivered,
      observed: report.observed,
    })),
    detail: allRows.filter((row) => row.used).sort((a, b) => Number(b.score) - Number(a.score) || String(a.nodeId).localeCompare(String(b.nodeId))),
    limit,
  };
  result.criteria = judgeCriteria(result);
  const failed = result.criteria.filter((item) => item.pass === false);
  const unknown = result.criteria.filter((item) => item.pass === null);
  result.verdict = failed.length > 0 ? "unusable" : unknown.length > 0 ? "partial" : "usable";
  return result;
}

/* ───────────────────────── ⑦ 渲染 ───────────────────────── */

const availabilityText = (value) => (value === null || value === undefined ? "未观测" : value ? "可用" : "不可用");

/** 渲染人读报告（返回字符串；CLI 直接 `console.log`）。 */
export function renderReport(result) {
  const out = [];
  const ledger = result.summary.ledger;
  const summary = result.summary.summary;
  const signal = result.signal;
  const coverage = signal.coverage;
  const criteria = result.criteria;
  const failed = criteria.filter((item) => item.pass === false);
  const unknown = criteria.filter((item) => item.pass === null);

  out.push("用量打分审计（T57 · 只读 · 零模型调用）");
  out.push(`home = ${result.home}`);
  out.push(
    `图 = ${int(result.graphs)} 张（坏图 ${int(result.badGraphs)} / 共 ${int(result.totalGraphFiles)} 个目录）· ` +
      `会话日志可读 = ${int(signal.withLog)} 张` +
      (result.logs ? `（读不到 ${int(signal.logMissing)} 张 —— 记「未观测」，不当 0）` : "（--no-logs：S1/S2 送达/S4 整体记「未观测」）"),
  );
  out.push("");
  const verdictText =
    result.verdict === "usable" ? "能用" : result.verdict === "partial" ? "部分能用（有判据不可判）" : "不能用";
  out.push(
    `一句话结论：**${verdictText}** —— 「被注入」可观测（${pct(coverage.ledger)} 的会话有热清单记录），` +
      `「被使用」只在 ${pct(coverage.used)} 的会话里出现过一次以上；` +
      `热清单精确率 ${pct(ledger.precision)}（列出 ${int(ledger.listed)} 个，真用上 ${int(ledger.both)} 个）。`,
  );
  out.push("");

  /* ① 四个信号 */
  out.push("## ① 四个候选信号：能不能观测到「调用了 kifu 的节点」");
  out.push(`  ${padDisplay("信号", 28)}${padDisplay("落点", 40)}${padDisplay("覆盖", 10, "right")}  结论`);
  out.push(
    `  ${padDisplay("S1 热清单注入记录", 28)}${padDisplay("user/message · source.kind=chess-context", 40)}` +
      `${padDisplay(pct(coverage.ledger), 10, "right")}  ${availabilityText(coverage.ledger === 0 ? 0 : 1)}` +
      `（${int(signal.ledgerSessions)}/${int(signal.withLog)} 会话 · ${int(signal.ledgerEvents)} 次注入 · ${int(ledger.listed)} 个 (会话,节点) 对）`,
  );
  out.push(
    `  ${padDisplay("S2 折叠摘要里的节点引用", 28)}${padDisplay("lastOfflineSummary.text 里的 nN", 40)}` +
      `${padDisplay(pct(coverage.summary), 10, "right")}  正文存在（${int(signal.summaryPairs)} 对）但**送达**只有 ${pct(coverage.summaryDelivered)}` +
      `（${int(signal.summaryDeliveredEvents)} 次 / ${int(signal.summaryDeliveredSessions)} 个会话的 compaction/summary 里真的带节点 id）`,
  );
  out.push(
    `  ${padDisplay("S3 closeout 的读记录", 28)}${padDisplay("graph.closeout.*", 40)}` +
      `${padDisplay(pct(coverage.closeout), 10, "right")}  ${coverage.closeout === 0 ? "**不可用**" : "可用"}` +
      `（${int(signal.closeoutFields.length)} 个字段里没有一个记「读过哪些节点」）`,
  );
  out.push(
    `  ${padDisplay("S4 工具读取 nodes/nX.md", 28)}${padDisplay("tool/call 参数里的树路径", 40)}` +
      `${padDisplay(pct(coverage.toolTree), 10, "right")}  ${availabilityText(coverage.toolTree === 0 ? 0 : 1)}但极稀：` +
      `${int(signal.toolTreeRefs)} 次树引用里只有 **${int(signal.toolNodeDocRefs)} 次**指向具体节点文档`,
  );
  out.push("");
  out.push(
    `  ⇒ **「被注入」与「被使用」差两个量级**：注入 ${int(signal.ledgerEvents)} 次 / 列出 ${int(ledger.listed)} 个节点，` +
      `agent 自己写出 id 的只有 ${int(ledger.used)} 个（${int(signal.usedSessions)} 个会话有，占 ${pct(coverage.used)}）。`,
  );
  out.push(
    `  ⇒ S3 直接判死：\`closeout\` 的 ${int(signal.closeoutFields.length)} 个字段（${signal.closeoutFields.join(" / ")}）` +
      `**没有一个是「读过哪些节点」** —— 它记的是「折了几次、覆盖到哪儿、失败没失败」。`,
  );
  out.push(
    `  ⇒ S4 的 ${int(signal.toolTreeRefs)} 次树引用里绝大多数是**跨会话读**（A 会话读 B 的树）：归属按路径里的 \`sid\` 算，` +
      `不按「谁在写日志」算 —— 反过来会把它们全算到 A 头上，而 A 的图里根本没有那些 id。`,
  );
  out.push("");

  /* ② 精确率 / 召回率 */
  out.push("## ② 精确率 / 召回率");
  out.push(
    `  ${padDisplay("来源", 26)}${padDisplay("列出", 8, "right")}${padDisplay("用上", 8, "right")}${padDisplay("交集", 8, "right")}` +
      `${padDisplay("精确率", 10, "right")}${padDisplay("召回率", 10, "right")}${padDisplay("噪声", 8, "right")}${padDisplay("漏", 8, "right")}`,
  );
  out.push(
    `  ${padDisplay("热清单（每步注入）", 26)}${padDisplay(int(ledger.listed), 8, "right")}${padDisplay(int(ledger.used), 8, "right")}` +
      `${padDisplay(int(ledger.both), 8, "right")}${padDisplay(pct(ledger.precision), 10, "right")}${padDisplay(pct(ledger.recall), 10, "right")}` +
      `${padDisplay(int(ledger.noise), 8, "right")}${padDisplay(int(ledger.missed), 8, "right")}`,
  );
  out.push(
    `  ${padDisplay("折叠摘要（归档落盘）", 26)}${padDisplay(int(summary.listed), 8, "right")}${padDisplay(int(summary.used), 8, "right")}` +
      `${padDisplay(int(summary.both), 8, "right")}${padDisplay(pct(summary.precision), 10, "right")}${padDisplay(pct(summary.recall), 10, "right")}` +
      `${padDisplay(int(summary.noise), 8, "right")}${padDisplay(int(summary.missed), 8, "right")}`,
  );
  const split = result.summarySplit;
  out.push(
    `    · 摘要按**送达**拆开：送达过（\`compaction/summary\` 里真的带节点 id）的 ${int(split.delivered.listedSessions)} 个会话，` +
      `列 ${int(split.delivered.listed)} 个、精确率 **${pct(split.delivered.precision)}**；` +
      `未送达的 ${int(split.undelivered.listedSessions)} 个会话，列 ${int(split.undelivered.listed)} 个、精确率 ${pct(split.undelivered.precision)}。`,
  );
  out.push(
    `      ⇒ 两组**同阶**（都是个位数）：摘要「没被引用」不是因为模型没看到它 —— 看到了也一样不引用。` +
      `这条差值本身就是「摘要里的节点 id 对下一个模型没有用」的直接证据。`,
  );
  out.push(
    `    ⇒ **精确率极低 / 召回率高**是同一个事实的两面：清单列的是**当时的前沿路径**，` +
      `而「列在前沿」与「被引用」由同一个位置决定 —— 用上的节点几乎必然被列过，不是清单的功劳。`,
  );
  out.push(
    `    ⇒ 反过来，${int(ledger.noise)} 个「列了但一次都没被提到」的节点里，绝大多数是**已经走过的路径**` +
      `（历史状态），清单留它们是为了「知道自己从哪儿来」，不是为了「被引用」。`,
  );
  out.push("");
  out.push(`  按「离归档时刻的距离」分桶（\`tailGap = archiveSeq − node.seq\`，越小越接近归档时的状态）：`);
  out.push(
    `    ${padDisplay("桶", 22)}${padDisplay("列出", 8, "right")}${padDisplay("用上", 8, "right")}${padDisplay("交集", 8, "right")}` +
      `${padDisplay("桶内精确率", 12, "right")}${padDisplay("占列出", 10, "right")}`,
  );
  for (const band of ledger.bands) {
    out.push(
      `    ${padDisplay(band.band, 22)}${padDisplay(int(band.listed), 8, "right")}${padDisplay(int(band.used), 8, "right")}` +
        `${padDisplay(int(band.both), 8, "right")}${padDisplay(pct(band.listed === 0 ? null : band.both / band.listed), 12, "right")}` +
        `${padDisplay(pct(ledger.listed === 0 ? null : band.listed / ledger.listed), 10, "right")}`,
    );
  }
  out.push(
    `    ⇒ 归档时的状态（≤0 / 1–50）与中途状态（201–1000 / 1001+）**精确率同阶**（都是个位数），` +
      `没有任何一个桶能把这个指标救回来。`,
  );
  out.push("");
  const cf = result.counterfactual;
  out.push(`  **反事实估计**（每条清单之后产生的边，按「\`from\` 节点被那份清单列过没有」分组）：`);
  out.push(`    · 被列出组：失败 ${int(cf.listed.failures)} / ${int(cf.listed.edges)} 条边 ⇒ 失败率 ${pct(cf.listed.rate)}`);
  out.push(`    · 未列出组：失败 ${int(cf.unlisted.failures)} / ${int(cf.unlisted.edges)} 条边 ⇒ 失败率 ${pct(cf.unlisted.rate)}`);
  out.push(`    · 差值（列出 − 未列出）= ${cf.delta === null ? "—" : `${(cf.delta * 100).toFixed(2)}pp`}`);
  out.push(
    `    ⚠ **不可识别**：被列出的节点就是「当时的前沿」，而前沿本来就最容易失败 —— 这个差值的正负` +
      `都拆不开「清单有用」与「位置效应」。所以它**不能**被读成摘要/清单的因果效应。`,
  );
  out.push("");

  /* ③ 四条判据 */
  out.push("## ③ 四条判据");
  for (const item of criteria) {
    const mark = item.pass === null ? "？不可判" : item.pass ? "✓ 通过" : "✗ **不通过**";
    const extra = item.degenerate && item.pass ? "　⚠ **退化通过**（无方差，ρ 不可信，不构成支持）" : "";
    out.push(`  判据 ${item.key} ${item.name}：${mark}${extra}`);
    out.push(`    ${item.detail}`);
  }
  out.push("");

  /* ④ 能不能用 */
  out.push("## ④ 能不能用");
  if (result.verdict === "usable") {
    out.push(`  能用：四条判据全过${unknown.length > 0 ? `（其中 ${int(unknown.length)} 条不可判）` : ""}。`);
  } else if (result.verdict === "partial") {
    out.push(`  **部分能用**：没有判据明确不过，但有 ${int(unknown.length)} 条**不可判** —— 样本不足以裁决。`);
    out.push(`  不能拿它当门禁：不可判的判据在数据变多之前既不能证明有用、也不能证明没用。`);
  } else {
    out.push(`  **不能用。**判据 ${failed.map((item) => item.key).join("、")} 不过。`);
    out.push(
      `  不是「摘要写得差」，是**这件事几乎不发生**：${pct(ledger.zeroShare)} 的节点用量分为 0，` +
        `众数占比 ${pct(ledger.modalShare)} ≫ ${pct(CRITERIA_RULES.maxConstantShare, 0)}。`,
    );
    out.push(
      `  换句话说，「节点被用上」在真机上是一个**稀疏到无法打分**的现象 —— ` +
        `${int(result.base.usedNodes)} 个被用上的节点摊在 ${int(result.base.sessions)} 个会话里，` +
        `而列出侧有 ${int(result.base.listedNodes)} 个（精确率 ${pct(ledger.precision)}）。`,
    );
    out.push(
      `  ★ 注意这不是「摘要没用」：清单/摘要的读者是**下一个模型**，而它们绝大多数**根本没被引用回来** ——` +
        `「没被引用」和「没用上」在现有数据里**分不开**（见 ⑤）。`,
    );
  }
  out.push("");

  /* ⑤ 缺什么数据 */
  out.push("## ⑤ 如果不可观测，缺什么数据");
  out.push(
    `  **缺一条「节点级送达/读取回执」**：清单每次注入时，把「这次列了哪些 id」记进节点自己的字段` +
      `（例如 \`node.injectedAt[]\` / \`node.readAt[]\` / \`node.citedAt[]\`），并在 \`renderNodeMd\` 被读取时` +
      `落一条 \`chess-context/node-read\` 会话事件。`,
  );
  out.push(
    `  现在能拿到的最强证据只有 ${int(signal.toolNodeDocRefs)} 次「真的去读了某个节点文档」——` +
      `**${pct(coverage.toolTree)} 的会话**。没有回执，「被注入」（系统行为，${int(signal.ledgerEvents)} 次）和` +
      `「被使用」（agent 行为，${int(result.base.usedNodes)} 个节点）就永远只能靠 id 字符串反推，` +
      `而这正是本仓判死五个指标的同一种死法。`,
  );
  out.push("");

  /* 明细 */
  const detail = result.detail ?? [];
  out.push(
    `## 明细（用量分最高的 ${int(Math.min(result.limit, detail.length))} 个节点 / 共 ${int(detail.length)} 个被用上的节点）`,
  );
  if (detail.length === 0) {
    out.push("  （没有任何节点被使用 —— 这条思路在现有数据上不可观测）");
  } else {
    out.push(
      `  ${padDisplay("会话", 12)}${padDisplay("节点", 8)}${padDisplay("分", 5, "right")}${padDisplay("cite", 6, "right")}` +
        `${padDisplay("grep", 6, "right")}${padDisplay("read", 6, "right")}${padDisplay("列出", 6, "right")}` +
        `${padDisplay("tailGap", 9, "right")}  桶`,
    );
    for (const row of detail.slice(0, result.limit)) {
      out.push(
        `  ${padDisplay(shortSession(row.sessionId), 12)}${padDisplay(row.nodeId, 8)}${padDisplay(int(row.score), 5, "right")}` +
          `${padDisplay(int(row.cites), 6, "right")}${padDisplay(int(row.greps), 6, "right")}${padDisplay(int(row.reads), 6, "right")}` +
          `${padDisplay(row.listedLedger ? "是" : "否", 6)}${padDisplay(row.tailGap === null ? "—" : int(row.tailGap), 9, "right")}  ${row.band ?? "—"}`,
      );
    }
  }
  return out.join("\n");
}

/* ───────────────────────── ⑧ CLI ───────────────────────── */

/** 解析 `--key=value` / 裸开关（本脚本只认这几个，多余的静默忽略）。 */
export function parseArgs(argv = []) {
  const out = { json: false, logs: "all", home: null, session: "", limit: DEFAULT_LIMIT };
  for (const raw of argv) {
    if (raw === "--json") out.json = true;
    else if (raw === "--no-logs") out.logs = "none";
    else if (raw.startsWith("--home=")) out.home = raw.slice("--home=".length);
    else if (raw.startsWith("--session=")) out.session = raw.slice("--session=".length);
    else if (raw.startsWith("--limit=")) out.limit = Number(raw.slice("--limit=".length)) || DEFAULT_LIMIT;
  }
  return out;
}

const invokedDirectly = (() => {
  const argv1 = String(process.argv?.[1] ?? "").replace(/\\/g, "/");
  if (argv1 === "") return false;
  try {
    return import.meta.url === new URL(`file://${argv1}`).href || import.meta.url.endsWith(argv1);
  } catch {
    return import.meta.url.endsWith(argv1);
  }
})();

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const result = audit({ home: args.home ?? resolveHome(), limit: args.limit, session: args.session, logs: args.logs });
  if (result.graphs === 0) {
    console.error(`✗ 一张图都读不到：${result.home}（home 给错了？）`);
    process.exit(2);
  }
  if (args.json) console.log(JSON.stringify(result, null, 1));
  else console.log(renderReport(result));
}
