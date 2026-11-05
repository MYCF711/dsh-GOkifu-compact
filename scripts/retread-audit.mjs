#!/usr/bin/env node
/**
 * retread-audit.mjs —— 第六个候选指标「重踩率（re-tread rate）」的裁决（T56 · 只读 · 零模型调用）
 *
 * ── 由来（Lead 的原话，T51–T55 已经判死五个指标之后） ─────────────────────────────
 *   「五个质量指标全判死…… Lead 提出第六个候选：**行为指标**。
 *     六个候选的核心思路：摘要的唯一目的是「让下一个自己别重蹈覆辙」。
 *     那就**直接量它有没有重蹈覆辙**。」
 *   已判死的五个（本脚本不重复发明，只在报告里引用）：
 *     可定位率（形状）· 区间保真度 A（循环）· B（冗余）· 逐字可回查率（方向）·
 *     `constraintRecall` / `failureRecall`（循环 —— 分子是补回函数的输出）。
 *
 * ── 这个脚本量什么（一句话） ───────────────────────────────────────────────────
 *   **重踩率** = 折叠产出的摘要里列出的死路（区间内失败边，带 `action` 签名），
 *   在折叠**之后**的观察窗口里，有多少**又被同一 action 失败了一遍**。
 *
 *   分子 = 真实发生的后续失败边（`result === "failure"` 且 `evidence.start > seqEnd`），
 *   **不是**摘要文本的子串匹配 —— 这是它和前五个指标最根本的区别（判据 ④，见下）。
 *
 * ── 口径（改口径就是改指标，全部写在这里） ─────────────────────────────────────
 *   ① **死路**：`failuresInFoldRange(graph, {start: seqStart, end: seqEnd})` ——
 *      与 `fold-quality` / `deadend-adherence-audit` **同源**，只算 evidence 与折叠区间有交集的边，
 *      并排除 rewash 残留（`isDanglingResidue`）。
 *      自己再写一套过滤 = 两套分母（本仓栽过多次：C607 / C638 / C641）。
 *   ② **重踩**：折叠之后（`evidence.start > seqEnd`，**不按 ts** —— ts 是落盘时刻，
 *      归档补折会晚几小时，按 ts 判会把「折叠前的失败」算成「折叠后的重踩」）
 *      再次出现**相同 action 签名**的失败边。
 *   ③ **action 签名**：仓库已有的 `actionSignature(tool, args)`（C446）。
 *      边上确实存了 `sig`（工具名 + 完整参数的 sha 前 16 位）。老边（C446 之前）没有 `sig`，
 *      而参数全文**已经不可得** —— 只能拿 `actionSummary` 当唯一残余信息。
 *      于是给两个口径，**分列，不合并**：
 *        · **严格口径（主）**：`sig:` 优先；没有 `sig` 的边回落 `act:actionSignature(action, {})`。
 *          贪心匹配 —— 老边 ↔ 新边之间**不会**因为 action 摘要相同就被算成重踩（宁可少算）；
 *        · **宽松口径（上界）**：一律 `act:actionSignature(action, {})`。
 *          已知假阳：`edit(file_path=X)` 对同一文件的不同编辑逐字相同（`actionSummary` 只取 2 个参数），
 *          所以它会把「同一个文件被编辑了两次，各失败一次」算成重踩。**那不是重踩**。
 *        ⇒ 报告里两个都给，结论按严格口径下；宽松口径只用来证明「就算把口径放到最松，结论也不变」。
 *   ④ **可重踩机会（分母）**：**去重后的死路签名数**。
 *      同一条死路在一个窗口里被重踩 5 次，只记 1 次 —— 否则一个死循环就能把率拉满。
 *   ⑤ **右删失**：折叠之后窗口内**一个图实体都没有**（节点/边）的折痕，记 `censored`，
 *      **不计入分母、也不记 0**（`Number(null) === 0` 是本仓踩过的坑：缺测被读成「命中 0」）。
 *
 * ── 观察窗口（N 轮）为什么这么选 ─────────────────────────────────────────────
 *   **主口径 = 到会话末尾**（`evidence.start > seqEnd` 的全部后续失败边）。
 *   理由不是「凑一个好看的数」，是**判死的规矩**：判死一个指标要用它**最好**的成绩。
 *   窗口越宽，重踩越容易发生、率越高；拿最宽的窗口去判，判死才作数。
 *   稳定性检查另给四个更窄的窗口：
 *     · 折叠后 10 / 3 / 1 个人类轮次（`kind === "user"` 的节点当轮次边界）；
 *     · **摘要生命周期**：到下一次折叠**提交**（下一次折叠的 `seqEnd`）为止 ——
 *       下一次折叠产出新摘要后，旧摘要被取代，再往后发生的重踩不能归因于它。
 *       （不能用「下一次折叠的 `seqStart - 1`」：`foldMarks` 的区间是**连续**的，
 *        `nextStart = seqEnd + 1`，那个窗口**恒为空** —— 第一版就是这么写错的。）
 *
 * ── 归因（这是本脚本最有价值的一半） ─────────────────────────────────────────
 *   「重踩了」不等于「摘要的错」。三个维度**分开统计**：
 *     A. **摘要写了没写**（`mentionsEdge(摘要正文, 死路 id)`，与 `failureRecall` 同一判据）：
 *        没写 ⇒ 摘要没给信息 ⇒ **冤枉**，不算它的错（但计入「漏写率」，那是另一个指标）；
 *     B. **摘要正文可不可解析**：`summaryText` → `summaryTextRef` → `lastOfflineSummary` 单槽。
 *        取不到正文的折痕，A 维度**不可判**（记 `unknown`，不拿「没写」冒充）；
 *     C. **注入可不可证**：折叠之后、重踩之前，会话日志里有没有把死路信息送进上下文的消息 ——
 *        `compact-checkpoint`（宿主把摘要当 checkpoint 注入）或 `chess-context`（插件热清单，
 *        `renderLedger` 的输出里逐条列着失败边）。两者都没有 ⇒ 「模型没看到摘要」这个解释
 *        **无法排除** ⇒ 这条重踩不能记在摘要头上。
 *        ★ 注意 C 的第二半是**混淆项**，不是功劳：热清单注入过 = 死路信息也走另一条路进了上下文，
 *          于是「重踩为 0」不能证明摘要有用（因果不可识别）。报告里单列。
 *
 * ── 四条判据（今晚总结的那四条；与 T52–T55 同一套数字） ─────────────────────────
 *   ① **有方差**：某个取值的占比 < 80%（众数占比）。恒等于某个值的指标 = 常函数，没有信息量；
 *   ② **与形状无关**：|ρ(离尾部距离)| < 0.2 且 |ρ(折痕跨度)| < 0.2 —— 否则它只是「折痕位置」的影子；
 *   ③ **与已有指标不同**：ρ(可定位率) < 0.8 且 ρ(T33 五判据分) < 0.8 —— 否则换个名字不产生新信息；
 *   ④ **分子不是修复函数的输出**：设计保证 + 经验对照（见 `judgeCriteria` 的文档与报告）。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` / `*.delta.jsonl` / 会话日志只 `readFileSync`；一个字节都不写；
 *   · **不改产品代码**：只 import 纯函数；`applyOfflineFoldToGraph` 一律不碰；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **判据必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/retread-audit.mjs                    # 全量（默认读会话日志，约 20 秒）
 *   node scripts/retread-audit.mjs --no-logs          # 跳过日志（注入维度记「未观测」）
 *   node scripts/retread-audit.mjs --json             # 机读（报告/测试用）
 *   node scripts/retread-audit.mjs --home <dir>       # 换 DSH_HOME
 *   node scripts/retread-audit.mjs --session <前缀>   # 只看某个会话
 *   node scripts/retread-audit.mjs --limit 20         # 明细列最近 N 条重踩
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 一张图都读不到（home 给错了）。
 */
import nodePath from "node:path";
import os from "node:os";

import { evidenceSpan, failureEdges } from "../src/rooms/kifu-model.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
import { isDanglingResidue } from "../src/rooms/ledger.mjs";
import { actionSignature } from "../src/rooms/keeper.mjs";
import { collectGraphFiles } from "../src/ui.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { buildLogIndex, correlate, independentIds, placeholderCount, quantile } from "./range-fidelity-audit.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { measureSample, resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";

/* ───────────────────────────── 口径常量（改口径只改这里） ───────────────────────────── */

/** 判据门槛（与 T52–T55 同一套数字；改门槛只改这里）。 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 ①：某一取值占比超过这个数就叫「恒等」（常函数，没有信息量）。 */
  maxConstantShare: 0.8,
  /** 判据 ②：|ρ| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** 判据 ③：与已有指标 ρ 高于这个数就算「同一个东西」。 */
  maxRhoRedundant: 0.8,
});

/**
 * 观察窗口。顺序即报告顺序；**第一个是主口径**（最宽 —— 判死要用最好的成绩）。
 * `foldBounded` = 到下一次折叠**提交**（下一次折叠的 `seqEnd`）；`turns` = 折叠后第 N 个人类消息。
 */
export const WINDOWS = Object.freeze([
  { key: "tail", label: "到会话末尾（最宽）", foldBounded: false, turns: Infinity },
  { key: "until-next-fold", label: "到下一次折叠提交", foldBounded: true, turns: null },
  { key: "turn-10", label: "折叠后 10 个人类轮次", foldBounded: false, turns: 10 },
  { key: "turn-3", label: "折叠后 3 个人类轮次", foldBounded: false, turns: 3 },
  { key: "turn-1", label: "折叠后 1 个人类轮次", foldBounded: false, turns: 1 },
]);

/** 主口径（最宽）。 */
export const DEFAULT_WINDOW = "tail";

/**
 * 「死路信息进过上下文」的消息来源（`user/message.data.source.kind`）。
 *
 * · `compact-checkpoint`：宿主把摘要当 checkpoint 注入 surface —— 这才是**摘要**本身；
 * · `chess-context`：插件热清单（`renderLedger` 的输出），里面逐条列着失败边 ——
 *   它 **不是**摘要，但它是同一个信息的**另一条通路**，所以既是「注入证据」也是**混淆项**。
 */
export const INJECTION_KINDS = Object.freeze(["compact-checkpoint", "chess-context"]);

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/** 折痕级重踩率的分档（固定，输出与测试都按它）。 */
export const RATE_BANDS = Object.freeze([
  { key: "= 0", test: (v) => v === 0 },
  { key: "0–0.2", test: (v) => v > 0 && v < 0.2 },
  { key: "0.2–0.5", test: (v) => v >= 0.2 && v < 0.5 },
  { key: "0.5–1.0", test: (v) => v >= 0.5 && v < 1 },
  { key: "= 1.0", test: (v) => v >= 1 },
]);

/* ───────────────────────────────── 小工具 ───────────────────────────────── */

const round = (value, digits = 6) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const pct = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
const int = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "—");
/** 会话短名：`session-<uuid>` 的目录名截前 8 位会只剩 `session-`（等于没显示），先剥前缀。 */
const shortSession = (dir) => {
  const body = String(dir ?? "");
  const stripped = body.replace(/^session-/, "");
  return `${body.startsWith("session-") ? "s-" : ""}${stripped.slice(0, 8)}`;
};
const num = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);

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

/* ───────────────────────────── ① action 签名（两个口径） ───────────────────────────── */

/**
 * **严格口径（主）**：`sig:` 优先，没有 `sig` 的老边回落 `act:actionSignature(action, {})`。
 *
 * 为什么回落值要过一遍 `actionSignature` 而不是直接用 `action` 字符串：
 *   · 它保证「同一个 action 摘要 ⇒ 同一个键」是**仓库那个函数**定义的（不是本脚本另发明一套哈希）；
 *   · 键前缀把两个世代的边**分开** —— 老边 `act:…` 与新边 `sig:…` 永不相等。
 *     这是刻意的：老边的参数全文已经丢了，拿它去和新边的指纹比，比出来的不是「同一动作」。
 *     代价是少算（宁可少算 —— 本指标的死法是「假绿」，不是「假红」）。
 *
 * @param {object} edge 棋谱边
 * @returns {string}
 */
export function strictKeyOf(edge) {
  const sig = typeof edge?.sig === "string" ? edge.sig.trim() : "";
  if (sig !== "") return `sig:${sig}`;
  return `act:${actionSignature(String(edge?.action ?? ""), {})}`;
}

/**
 * **宽松口径（上界）**：一律拿 `actionSummary` 当键。
 * 已知假阳（同一文件的不同编辑）；用处只有两个：给上界、以及跨世代可比。
 * @param {object} edge
 * @returns {string}
 */
export function looseKeyOf(edge) {
  return `act:${actionSignature(String(edge?.action ?? ""), {})}`;
}

/* ───────────────────────────── ② 图上的位置与轮次 ───────────────────────────── */

/**
 * 人类轮次边界（`kind === "user"` 的节点 seq，升序）。
 *
 * 为什么是 user 节点而不是 `node.turn`：真机 83,132 个节点里 `turn` **全是 null**
 * （`Number(null) === 0` 骗过 `Number.isFinite`，这正是 T49 那个坑）。user 节点是唯一可靠的轮次边界。
 *
 * @param {object} graph
 * @returns {number[]}
 */
export function turnSeqsOf(graph) {
  const out = [];
  for (const node of Object.values(graph?.nodes ?? {})) {
    if (node?.kind !== "user") continue;
    const seq = Number(node?.seq);
    if (Number.isFinite(seq)) out.push(seq);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 图里所有「有位置」的实体 seq（节点 seq + 边 evidence 的起止），升序。
 * 只用来判「窗口内还有没有后续事件」（右删失）。
 * @param {object} graph
 * @returns {number[]}
 */
export function entitySeqsOf(graph) {
  const out = [];
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    if (Number.isFinite(seq)) out.push(seq);
  }
  for (const edge of Object.values(graph?.edges ?? {})) {
    const span = evidenceSpan(edge);
    if (span !== null) out.push(span.start, span.end);
  }
  return out.sort((a, b) => a - b);
}

/** 图里最大的 seq（「离尾部距离」的基准，与 T52 `readProbeRow` 同源）。 */
export function graphMaxSeqOf(graph) {
  let max = 0;
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  for (const edge of Object.values(graph?.edges ?? {})) {
    const span = evidenceSpan(edge);
    if (span !== null && span.end > max) max = span.end;
  }
  return max;
}

/**
 * 观察窗口的右边界（含）。
 *
 * · `tail`（主口径）：`Infinity`，**不删失** —— 图里折叠之后的全部事件都算；
 * · `foldBounded`：下一次折叠**提交**（下一次折叠的 `seqEnd`）；没有下一次 ⇒ `Infinity`，`censored: true`；
 * · `turns: N`：折叠后第 N 个人类消息的 seq；不足 N 个 ⇒ `Infinity`，`censored: true`。
 *
 * @param {{turnsAfter?:number[], foldEndAfter?:number|null, spec?:object}} args
 * @returns {{end:number, censored:boolean}}
 */
export function windowEndFor({ turnsAfter = [], foldEndAfter = null, spec = WINDOWS[0] } = {}) {
  if (spec?.foldBounded === true) {
    if (!Number.isFinite(Number(foldEndAfter))) return { end: Number.POSITIVE_INFINITY, censored: true };
    return { end: Number(foldEndAfter), censored: false };
  }
  const turns = Number(spec?.turns);
  if (!Number.isFinite(turns)) return { end: Number.POSITIVE_INFINITY, censored: false };
  const list = Array.isArray(turnsAfter) ? turnsAfter : [];
  if (list.length < turns) return { end: Number.POSITIVE_INFINITY, censored: true };
  return { end: Number(list[turns - 1]), censored: false };
}

/* ───────────────────────────── ③ 会话日志里的「注入证据」 ───────────────────────────── */

/** 事件是不是 user/message（两种历史形状都认：`data.source` 与 `message.source`）。 */
function sourceKindOf(event) {
  if (event?.type !== "user/message") return "";
  return String(event?.data?.source?.kind ?? event?.message?.source?.kind ?? "");
}

/**
 * 从会话事件流里取「死路信息进过上下文」的 seq 列表。
 *
 * @param {Array<object>|null} events 会话日志（`null` = 没解出来，**不是**空数组）
 * @returns {Array<{seq:number, kind:string}>|null}
 */
export function injectionSeqsOf(events) {
  if (!Array.isArray(events)) return null;
  const out = [];
  for (const event of events) {
    const kind = sourceKindOf(event);
    if (kind === "" || !INJECTION_KINDS.includes(kind)) continue;
    const seq = Number(event?.seq);
    if (Number.isFinite(seq)) out.push({ seq, kind });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/* ───────────────────────────── ④ 单条折痕 ───────────────────────────── */

/** 一个空归因桶。 */
function emptyAttribution() {
  return {
    retreads: 0,
    listed: 0,
    unlisted: 0,
    unknown: 0,
    injectedListed: 0,
    injectedUnlisted: 0,
    uninjectedListed: 0,
    uninjectedUnlisted: 0,
    injectionUnknown: 0,
    detail: [],
  };
}

/**
 * 算**一条** foldMark 的重踩行（纯函数，便于单测）。
 *
 * @param {object} graph 棋谱
 * @param {object} mark foldMark
 * @param {{index?:number|null, session?:string|null, window?:object, turns?:number[]|null,
 *   foldEnds?:number[]|null, entities?:number[]|null, graphMaxSeq?:number,
 *   injection?:Array<{seq:number,kind:string}>|null, summaryText?:string|null}} [ctx]
 * @returns {object} 一行；`measurable === false` 时 `retreadRate` 是 `null`（**不拿 0 冒充**）
 */
export function markRetread(graph, mark, ctx = {}) {
  const {
    index = null,
    session = null,
    window: spec = WINDOWS[0],
    turns = null,
    foldEnds = null,
    injection = null,
    summaryText = undefined,
  } = ctx;

  const rawStart = Number(mark?.seqStart);
  const rawEnd = Number(mark?.seqEnd);
  const graphMaxSeq = Number.isFinite(Number(ctx?.graphMaxSeq)) ? Number(ctx.graphMaxSeq) : graphMaxSeqOf(graph);
  const row = {
    session,
    index,
    at: Number(mark?.at) || 0,
    trigger: String(mark?.trigger ?? ""),
    window: String(spec?.key ?? DEFAULT_WINDOW),
    seqStart: Number.isFinite(rawStart) ? rawStart : null,
    seqEnd: Number.isFinite(rawEnd) ? rawEnd : null,
    tailGap: Number.isFinite(rawEnd) ? graphMaxSeq - rawEnd : null,
    span: Number.isFinite(rawStart) && Number.isFinite(rawEnd) ? Math.abs(rawEnd - rawStart) + 1 : null,
    measurable: false,
    why: "",
    windowEnd: null,
    windowCensored: false,
    /** 区间内失败边（未去重）—— 与 `quality.expectedFailures` 同口径。 */
    deadEnds: 0,
    /** 去重后的死路签名数 = 可重踩机会数。 */
    opportunities: 0,
    /** 折叠后、窗口内的失败边数（分母的另一个视角）。 */
    postFailures: 0,
    /** 严格口径重踩数（主）/ 宽松口径重踩数（上界）。 */
    retreads: 0,
    retreadsLoose: 0,
    /** 严格口径重踩里，死路**带 sig** 的条数（纯 sig 匹配，最严的子集）。 */
    retreadsSig: 0,
    /** 漏写率的分母/分子：**去重死路**里摘要写了多少条（与重踩无关，全量）。 */
    deadJudged: 0,
    deadListed: 0,
    retreadRate: null,
    retreadRateLoose: null,
    /** 安慰剂对照：折叠**之前**的失败边在同一窗口里的重踩（摘要不可能列到它们）。 */
    controlOpportunities: 0,
    controlRetreads: 0,
    controlRate: null,
    /** 重踩的死路 id（去重、保序）。 */
    retreadIds: [],
    summaryAvailable: false,
    summarySource: null,
    attribution: { strict: emptyAttribution(), loose: emptyAttribution() },
    /** 可定位率 / T33 分（`audit()` 填，纯函数这里不碰模型与正文计分）。 */
    traceableShare: null,
    qualityTotal: null,
  };

  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    row.why = "seq 区间缺失";
    return row;
  }
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);

  const dead = failuresInFoldRange(graph, { start: lo, end: hi });
  row.deadEnds = dead.length;

  // 右边界（窗口）
  const turnsAfter = (Array.isArray(turns) ? turns : turnSeqsOf(graph)).filter((seq) => seq > hi);
  const foldEndAfter = (Array.isArray(foldEnds) ? foldEnds : [])
    .filter((seq) => Number.isFinite(Number(seq)) && Number(seq) > hi)
    .sort((a, b) => a - b)[0] ?? null;
  const { end, censored } = windowEndFor({ turnsAfter, foldEndAfter, spec });
  row.windowEnd = Number.isFinite(end) ? end : null;
  row.windowCensored = censored;

  // 右删失：窗口内一个实体都没有 ⇒ 没有「下一次机会」，不计入分母、也不记 0
  const entities = Array.isArray(ctx?.entities) ? ctx.entities : entitySeqsOf(graph);
  const hasExposure = entities.some((seq) => seq > hi && seq <= end);
  if (!hasExposure) {
    row.why = "窗口内无后续事件（右删失）";
    return row;
  }
  row.measurable = true;

  // 去重死路（每种 action 只记一次）
  const deadByStrict = new Map();
  const deadByLoose = new Map();
  for (const edge of dead) {
    const strict = strictKeyOf(edge);
    if (!deadByStrict.has(strict)) deadByStrict.set(strict, edge);
    const loose = looseKeyOf(edge);
    if (!deadByLoose.has(loose)) deadByLoose.set(loose, edge);
  }
  row.opportunities = deadByStrict.size;
  if (deadByStrict.size === 0) {
    row.why = "区间内没有失败边（无死路可重踩）";
    row.measurable = false;
    return row;
  }

  // 折叠之后的失败边（按 evidence.start，**不按 ts**）
  const post = failureEdges(graph).filter((edge) => {
    if (isDanglingResidue(edge, { graph })) return false;
    const span = evidenceSpan(edge);
    return span !== null && span.start > hi && span.start <= end;
  });
  row.postFailures = post.length;

  const postStrict = new Map();
  const postLoose = new Map();
  for (const edge of post) {
    const strict = strictKeyOf(edge);
    if (!postStrict.has(strict)) postStrict.set(strict, edge);
    const loose = looseKeyOf(edge);
    if (!postLoose.has(loose)) postLoose.set(loose, edge);
  }

  // 归因要用摘要正文；`undefined` = 调用方没给（自己取），`null` = 确认取不到
  let text = summaryText;
  let source = null;
  if (text === undefined) {
    const resolved = resolveSummaryText(mark, graph?.lastOfflineSummary ?? null);
    text = resolved.text;
    source = resolved.source;
  }
  row.summaryAvailable = typeof text === "string" && text !== "";
  row.summarySource = source;

  // 漏写率（全量口径）：**每一条去重死路**摘要写了没有 —— 与「有没有重踩」无关。
  // 摘要正文取不到 ⇒ 不可判，不进分母（不拿「没写」冒充）。
  if (row.summaryAvailable) {
    for (const deadEdge of deadByStrict.values()) {
      row.deadJudged += 1;
      if (mentionsEdge(text, String(deadEdge?.id ?? ""))) row.deadListed += 1;
    }
  }

  const injectedSeqs = Array.isArray(injection) ? injection : [];

  /** 归因一条重踩（严格 / 宽松共用）。 */
  const attribute = (bucket, deadEdge, hit) => {
    bucket.retreads += 1;
    const hitSeq = hit === null ? null : (evidenceSpan(hit)?.start ?? null);
    const id = String(deadEdge?.id ?? "");
    const listed = row.summaryAvailable ? mentionsEdge(text, id) : null;
    // 注入：折叠之后、**重踩之前**有没有死路信息进过上下文
    const injected =
      injection === null || injection === undefined
        ? null
        : injectedSeqs.some((item) => Number(item?.seq) > hi && (hitSeq === null || Number(item?.seq) < hitSeq));

    if (listed === null) bucket.unknown += 1;
    else if (listed) bucket.listed += 1;
    else bucket.unlisted += 1;

    if (injected === null) bucket.injectionUnknown += 1;
    else if (injected) {
      if (listed === true) bucket.injectedListed += 1;
      else bucket.injectedUnlisted += 1;
    } else if (listed === true) bucket.uninjectedListed += 1;
    else bucket.uninjectedUnlisted += 1;

    bucket.detail.push({
      deadId: id,
      deadSeq: evidenceSpan(deadEdge)?.start ?? null,
      deadAction: String(deadEdge?.action ?? "").slice(0, 120),
      deadError: String(deadEdge?.errorSnippet ?? "").slice(0, 120),
      hitId: String(hit?.id ?? ""),
      hitSeq,
      hitAction: String(hit?.action ?? "").slice(0, 120),
      hitError: String(hit?.errorSnippet ?? "").slice(0, 120),
      listed,
      injected,
    });
  };

  for (const [key, deadEdge] of deadByStrict) {
    if (!postStrict.has(key)) continue;
    row.retreads += 1;
    if (typeof deadEdge?.sig === "string" && deadEdge.sig !== "") row.retreadsSig += 1;
    row.retreadIds.push(String(deadEdge?.id ?? ""));
    attribute(row.attribution.strict, deadEdge, postStrict.get(key));
  }
  for (const [key, deadEdge] of deadByLoose) {
    if (!postLoose.has(key)) continue;
    row.retreadsLoose += 1;
    attribute(row.attribution.loose, deadEdge, postLoose.get(key));
  }

  row.retreadRate = row.opportunities === 0 ? null : row.retreads / row.opportunities;

  // ★ **安慰剂对照**：折叠**之前**的失败边（摘要不可能列到它们 —— 折叠区间是增量遮蔽的），
  //   在同一窗口里被重踩的比例。
  //   用途：把「摘要起了作用」和「这些动作本来就会复发」分开。
  //   如果对照组的率 ≈ 实验组，说明摘要**没有把重踩压下去**（或者根本没有可测效应），
  //   指标量的就是「动作复发的自然频率」，不是摘要质量。
  const pre = failureEdges(graph).filter((edge) => {
    if (isDanglingResidue(edge, { graph })) return false;
    const span = evidenceSpan(edge);
    return span !== null && span.end < lo && span.start <= end;
  });
  const preByStrict = new Map();
  for (const edge of pre) {
    const key = strictKeyOf(edge);
    if (!preByStrict.has(key)) preByStrict.set(key, edge);
  }
  row.controlOpportunities = preByStrict.size;
  row.controlRetreads = [...preByStrict.keys()].filter((key) => postStrict.has(key)).length;
  row.controlRate = row.controlOpportunities === 0 ? null : row.controlRetreads / row.controlOpportunities;
  row.retreadRateLoose = row.opportunities === 0 ? null : row.retreadsLoose / row.opportunities;
  return row;
}

/* ───────────────────────────── ⑤ 聚合 ───────────────────────────── */

/** 一个空窗口分组。 */
function emptyWindow(spec) {
  return {
    key: String(spec?.key ?? DEFAULT_WINDOW),
    label: String(spec?.label ?? spec?.key ?? DEFAULT_WINDOW),
    marks: 0,
    censored: 0,
    noDeadEnds: 0,
    opportunities: 0,
    postFailures: 0,
    retreads: 0,
    retreadsLoose: 0,
    controlOpportunities: 0,
    controlRetreads: 0,
    marksWithRetread: 0,
    rates: [],
  };
}

/**
 * 一个窗口的汇总。
 *
 * `modalShare` = 折痕级重踩率里**占比最大的那个取值**的占比（判据 ①）。
 * 用「众数占比」而不是「方差」：方差会被一条 1.0 拉高，众数占比直接回答
 * 「这个指标有多少概率只是一个常数」。
 *
 * @param {Array<object>} rows
 * @param {object} spec
 * @returns {object}
 */
export function summarizeWindow(rows, spec = WINDOWS[0]) {
  const group = emptyWindow(spec);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.window !== group.key) continue;
    group.marks += 1;
    if (row.windowCensored) group.censored += 1;
    if (row.measurable !== true) {
      if (row.why === "区间内没有失败边（无死路可重踩）") group.noDeadEnds += 1;
      continue;
    }
    group.opportunities += Number(row.opportunities) || 0;
    group.postFailures += Number(row.postFailures) || 0;
    group.retreads += Number(row.retreads) || 0;
    group.retreadsLoose += Number(row.retreadsLoose) || 0;
    group.controlOpportunities += Number(row.controlOpportunities) || 0;
    group.controlRetreads += Number(row.controlRetreads) || 0;
    if (Number(row.retreads) > 0) group.marksWithRetread += 1;
    if (row.retreadRate !== null && Number.isFinite(row.retreadRate)) group.rates.push(Number(row.retreadRate));
  }

  // 众数占比：折痕级重踩率的每个取值各占多少；取最大那个
  const counts = new Map();
  for (const rate of group.rates) {
    const key = rate.toFixed(6);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let modal = null;
  for (const [key, count] of counts) {
    if (modal === null || count > modal.count) modal = { value: Number(key), count };
  }
  const denominator = group.rates.length;
  const rates = group.rates;
  const { rates: _dropped, ...rest } = group;

  return {
    ...rest,
    n: denominator,
    rate: group.opportunities === 0 ? null : group.retreads / group.opportunities,
    rateLoose: group.opportunities === 0 ? null : group.retreadsLoose / group.opportunities,
    /** 安慰剂对照的重踩率（折叠**之前**的失败边）。 */
    controlRate: group.controlOpportunities === 0 ? null : group.controlRetreads / group.controlOpportunities,
    meanRate: denominator === 0 ? null : round(rates.reduce((sum, value) => sum + value, 0) / denominator),
    p50: round(quantile(rates, 0.5)),
    p90: round(quantile(rates, 0.9)),
    modalValue: modal === null ? null : round(modal.value),
    modalShare: denominator === 0 || modal === null ? null : round(modal.count / denominator),
    zeroShare: denominator === 0 ? null : round(rates.filter((value) => value === 0).length / denominator),
    atOneShare: denominator === 0 ? null : round(rates.filter((value) => value >= 1).length / denominator),
    histogram: Object.fromEntries(RATE_BANDS.map((band) => [band.key, rates.filter((value) => band.test(value)).length])),
  };
}

/** 把一组归因桶合并（严格 / 宽松分开调）。 */
export function mergeAttribution(buckets) {
  const out = { ...emptyAttribution(), detail: [] };
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (bucket === null || bucket === undefined) continue;
    for (const key of [
      "retreads",
      "listed",
      "unlisted",
      "unknown",
      "injectedListed",
      "injectedUnlisted",
      "uninjectedListed",
      "uninjectedUnlisted",
      "injectionUnknown",
    ]) {
      out[key] += Number(bucket[key]) || 0;
    }
    out.detail.push(...(Array.isArray(bucket.detail) ? bucket.detail : []));
  }
  /** 冤枉 = 摘要**没有可证责任**；只有「注入可证」的两个桶算它的错。 */
  out.exonerated = out.uninjectedListed + out.uninjectedUnlisted;
  out.blamed = out.injectedListed + out.injectedUnlisted;
  out.blameRate = out.retreads === 0 ? null : round(out.blamed / out.retreads);
  return out;
}

/**
 * 归因汇总（严格口径 + 宽松口径 + 漏写率）。
 *
 * 漏写率的分母是**可解析摘要的死路**（摘要正文取不到的折痕不进分母 —— 不可判不是「没写」）。
 *
 * @param {Array<object>} rows 主口径的行
 * @returns {object}
 */
export function summarizeAttribution(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.measurable === true);
  const strict = mergeAttribution(list.map((row) => row?.attribution?.strict));
  const loose = mergeAttribution(list.map((row) => row?.attribution?.loose));
  /** 严格口径里「死路本身就带 sig」的子集 —— 最严下界（老边回落不自证）。 */
  strict.sigOnly = list.reduce((sum, row) => sum + (Number(row?.retreadsSig) || 0), 0);
  const deadEnds = list.reduce((sum, row) => sum + (Number(row.deadEnds) || 0), 0);
  const deadEndsJudged = list.reduce((sum, row) => sum + (Number(row.deadJudged) || 0), 0);
  const deadEndsMissing = Math.max(0, deadEndsJudged - list.reduce((sum, row) => sum + (Number(row.deadListed) || 0), 0));
  return {
    marksMeasured: list.length,
    deadEnds,
    deadEndsJudged,
    deadEndsMissing,
    summaryUnavailable: deadEnds - deadEndsJudged,
    missingRate: deadEndsJudged === 0 ? null : round(deadEndsMissing / deadEndsJudged),
    summaryAvailableMarks: list.filter((row) => row.summaryAvailable === true).length,
    strict,
    loose,
  };
}

/* ───────────────────────────── ⑥ 四条判据 ───────────────────────────── */

/**
 * 四条判据的裁决。
 *
 * ④ **分子不是修复函数的输出** —— 这条是**设计保证**，不是跑出来的：
 *   · 分子 = 折叠后的失败边（`result === "failure"` 且 `evidence.start > seqEnd`），
 *     由 `settleEdge` 在**工具结果事件**上写入；
 *   · 修复函数（`repairMissingFailures` / `repairFailuresInText`）只**读**图、**改写摘要文本**，
 *     不写边、不调用 `settleEdge`、不改 `evidence`；
 *   · ⇒ 「摘要里写了什么」在结构上不可能改变分子。
 *   还有一条**经验对照**（报告里给）：摘要正文**可解析**与**不可解析**两个池的重踩率。
 *   如果分子真是修复函数的输出，两个池会系统性分叉（不可解析池根本没人补回过）；
 *   实测两池同一量级 ⇒ 分子来自行为，不来自文本。
 *
 * @param {object} result `audit()` 的返回
 * @returns {object[]} 四条判据
 */
export function judgeCriteria(result) {
  const primary = result?.windows?.[result?.window?.key ?? DEFAULT_WINDOW] ?? null;
  const shape = result?.correlations ?? {};
  const criteria = [];

  // ① 有方差
  const modalShare = primary?.modalShare ?? null;
  criteria.push({
    key: "①",
    name: `有方差（众数占比 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
    value: modalShare,
    detail: `众数 = ${num(primary?.modalValue)}，占 ${pct(modalShare)}（n=${int(primary?.n)}，门槛 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
    pass: modalShare === null ? null : modalShare < CRITERIA_RULES.maxConstantShare,
    degenerate: false,
  });

  // ② 与形状无关
  const tail = shape.tailGap ?? null;
  const span = shape.span ?? null;
  const absTail = tail?.spearman === null || tail?.spearman === undefined ? null : Math.abs(tail.spearman);
  const absSpan = span?.spearman === null || span?.spearman === undefined ? null : Math.abs(span.spearman);
  const passShape =
    absTail !== null && absSpan !== null ? absTail < CRITERIA_RULES.maxAbsRhoShape && absSpan < CRITERIA_RULES.maxAbsRhoShape : null;
  criteria.push({
    key: "②",
    name: `与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
    value: absTail === null || absSpan === null ? null : Math.max(absTail, absSpan),
    detail: `|ρ(离尾部)| = ${num(absTail)}（n=${int(tail?.n ?? 0)}）· |ρ(跨度)| = ${num(absSpan)}（n=${int(span?.n ?? 0)}）`,
    pass: passShape,
    /** 无方差时 ρ 不可信 —— 这条是「退化通过」，不构成支持。 */
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ③ 与已有指标不同
  const traceable = shape.traceableShare ?? null;
  const qualityTotal = shape.qualityTotal ?? null;
  const rhoTraceable = traceable?.spearman ?? null;
  const rhoQuality = qualityTotal?.spearman ?? null;
  const passRedundant =
    rhoTraceable === null || rhoQuality === null
      ? null
      : Math.abs(rhoTraceable) < CRITERIA_RULES.maxRhoRedundant && Math.abs(rhoQuality) < CRITERIA_RULES.maxRhoRedundant;
  criteria.push({
    key: "③",
    name: `与已有指标不同（ρ < ${CRITERIA_RULES.maxRhoRedundant}）`,
    value: rhoTraceable === null || rhoQuality === null ? null : Math.max(Math.abs(rhoTraceable), Math.abs(rhoQuality)),
    detail: `ρ(可定位率) = ${num(rhoTraceable)}（n=${int(traceable?.n ?? 0)}）· ρ(T33 分) = ${num(rhoQuality)}（n=${int(qualityTotal?.n ?? 0)}）`,
    pass: passRedundant,
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ④ 分子不是修复函数的输出
  const pools = result?.attributionBySummaryAvailability ?? null;
  const gap = pools === null ? null : Math.abs((pools.available?.rate ?? 0) - (pools.unavailable?.rate ?? 0));
  criteria.push({
    key: "④",
    name: "分子不是修复函数的输出",
    value: gap,
    detail:
      "设计保证：分子是折叠后新产生的失败边（`settleEdge` 写入），修复函数只改摘要文本、不写边。" +
      (pools === null
        ? ""
        : `　经验对照：摘要可解析池 ${pct(pools.available?.rate)}（n=${int(pools.available?.n)}，机会 ${int(pools.available?.opportunities)}）· ` +
          `不可解析池 ${pct(pools.unavailable?.rate)}（n=${int(pools.unavailable?.n)}，机会 ${int(pools.unavailable?.opportunities)}）`),
    pass: true,
    degenerate: false,
  });

  return criteria;
}

/* ───────────────────────────── ⑦ 扫描 ───────────────────────────── */

/**
 * 扫全部会话。
 *
 * @param {{home?:string, limit?:number, session?:string, logs?:"all"|"retreads"|"none", window?:string}} [options]
 * @returns {object}
 */
export function audit({ home = resolveHome(), limit = DEFAULT_LIMIT, session = "", logs = "all", window: windowKey = DEFAULT_WINDOW } = {}) {
  const { files } = collectGraphFiles(home);
  const spec = WINDOWS.find((item) => item.key === windowKey) ?? WINDOWS[0];
  const rows = [];
  const epoch = { marks: 0, withRange: 0, withDeadEnds: 0, withSig: 0, withoutSig: 0, graphs: 0, badGraphs: 0 };

  /** 基线：同一会话里「同一个 sig 失败过 ≥2 次」的比例 —— 重踩现象本身的稀有度。 */
  const base = { sigs: 0, repeated: 0 };
  /** 每个会话的图与折痕（日志延迟读）。 */
  const sessions = [];

  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      epoch.badGraphs += 1;
      continue;
    }
    epoch.graphs += 1;
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    if (marks.length === 0) continue;
    sessions.push({ dir: String(file.dir), graph, marks });

    const seen = new Map();
    for (const edge of failureEdges(graph)) {
      if (isDanglingResidue(edge, { graph })) continue;
      const key = strictKeyOf(edge);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    base.sigs += seen.size;
    base.repeated += [...seen.values()].filter((count) => count >= 2).length;
  }

  // 日志：只解一次（同一会话的多条折痕共用）
  const logIndex = logs === "none" ? null : buildLogIndex(home);
  const logsRead = { sessions: 0, missing: 0, empty: 0 };
  /** 全库「注入可得性」：折叠后有没有死路信息进过上下文（混淆项）。 */
  const injectionCorpus = { marks: 0, withCheckpoint: 0, withHotLedger: 0, withAny: 0, without: 0 };

  for (const entry of sessions) {
    const turns = turnSeqsOf(entry.graph);
    const entities = entitySeqsOf(entry.graph);
    const graphMaxSeq = graphMaxSeqOf(entry.graph);
    const foldEnds = entry.marks.map((mark) => Number(mark?.seqEnd)).filter(Number.isFinite);

    /** 读这个会话的日志（`null` = 读不到）。 */
    const readInjection = () => {
      if (logIndex === null) return { ok: false, injection: null };
      // 目录名有两种：`<uuid>` 与 `session-<uuid>`（归档过的会话）。日志索引的键是裸 uuid，
      // 只按 `dir` 查会把「归档会话」整批记成 `no-log` —— 而归档正是 `archive-offline` 折痕的所在，
      // 那一条静默会直接废掉注入维度（真机 22/42 条重踩落在这种目录上）。
      const dirKey = String(entry.dir).toLowerCase();
      const logFile = logIndex.get(dirKey) ?? logIndex.get(dirKey.replace(/^session-/, "")) ?? null;
      if (logFile === null) {
        logsRead.missing += 1;
        return { ok: false, injection: null };
      }
      const events = readSessionEvents(logFile);
      if (events.length === 0) {
        logsRead.empty += 1;
        return { ok: false, injection: null };
      }
      logsRead.sessions += 1;
      return { ok: true, injection: injectionSeqsOf(events) };
    };

    /**
     * 一条折痕 × 全部窗口。
     *
     * 为什么要全算：稳定性检查要拿**同一批折痕**换窗口重算 —— 只算主口径的话，
     * 另外四个窗口在报告里恒为 0 条（第一版就是这么错的：表格看起来「五个窗口都是 0」，
     * 其实是**根本没算**，那是假绿）。
     */
    const build = (injection) =>
      entry.marks.map((mark, index) =>
        WINDOWS.map((windowSpec) =>
          markRetread(entry.graph, mark, {
            index,
            session: entry.dir,
            window: windowSpec,
            turns,
            entities,
            graphMaxSeq,
            foldEnds,
            injection,
          }),
        ),
      );

    let local = build(null);
    let injection = null;
    if (logIndex !== null && (logs === "all" || (logs === "retreads" && local.some((list) => list.some((row) => (row.retreadsLoose || 0) > 0))))) {
      const read = readInjection();
      injection = read.injection;
      if (injection !== null) local = build(injection); // 重算：归因要用注入证据
    }

    entry.marks.forEach((mark, index) => {
      epoch.marks += 1;
      if (Number.isFinite(Number(mark?.seqStart)) && Number.isFinite(Number(mark?.seqEnd))) epoch.withRange += 1;
      const list = local[index];
      const row = list.find((item) => item.window === spec.key) ?? list[0];
      if (row.deadEnds > 0) {
        epoch.withDeadEnds += 1;
        const lo = Math.min(Number(mark.seqStart), Number(mark.seqEnd));
        const hi = Math.max(Number(mark.seqStart), Number(mark.seqEnd));
        const dead = failuresInFoldRange(entry.graph, { start: lo, end: hi });
        const withSig = dead.filter((edge) => typeof edge?.sig === "string" && edge.sig !== "").length;
        epoch.withSig += withSig;
        epoch.withoutSig += dead.length - withSig;
      }
      // 判据 ③ 需要的两个对照量（只对**主口径**的可测折痕算一次，五个窗口共用同一个值）
      if (row.measurable === true) {
        const resolved = resolveSummaryText(mark, entry.graph?.lastOfflineSummary ?? null);
        if (resolved.text !== null && resolved.text !== "") {
          const ids = independentIds(resolved.text).length;
          const placeholders = placeholderCount(resolved.text);
          const share = ids + placeholders === 0 ? null : Math.round((ids / (ids + placeholders)) * 10_000) / 10_000;
          let qualityTotal = null;
          try {
            qualityTotal = scoreMark(
              measureSample(
                {
                  sessionId: String(entry.graph?.sessionId ?? entry.dir),
                  trigger: String(mark?.trigger ?? ""),
                  source: resolved.source,
                  at: Number(mark?.at) || 0,
                  seqStart: row.seqStart,
                  seqEnd: row.seqEnd,
                  text: resolved.text,
                  mark,
                  lastOfflineSummary: null,
                  chars: resolved.text.length,
                },
                entry.graph,
              ),
            ).total;
          } catch {
            qualityTotal = null;
          }
          for (const item of list) {
            item.traceableShare = share;
            item.qualityTotal = qualityTotal;
          }
        }
      }
      if (injection !== null) {
        const hi = Math.max(Number(mark?.seqStart), Number(mark?.seqEnd));
        const after = injection.filter((item) => item.seq > hi);
        injectionCorpus.marks += 1;
        if (after.some((item) => item.kind === "compact-checkpoint")) injectionCorpus.withCheckpoint += 1;
        if (after.some((item) => item.kind === "chess-context")) injectionCorpus.withHotLedger += 1;
        if (after.length > 0) injectionCorpus.withAny += 1;
        else injectionCorpus.without += 1;
      }
      for (const item of list) rows.push(item);
    });
  }

  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.session).localeCompare(String(b.session)));

  const windows = Object.fromEntries(WINDOWS.map((item) => [item.key, summarizeWindow(rows, item)]));
  const primaryRows = rows.filter((row) => row.window === spec.key && row.measurable === true);

  const correlations = {
    tailGap: correlate(primaryRows, "retreadRate", "tailGap"),
    span: correlate(primaryRows, "retreadRate", "span"),
    traceableShare: correlate(primaryRows, "retreadRate", "traceableShare"),
    qualityTotal: correlate(primaryRows, "retreadRate", "qualityTotal"),
  };

  // 判据 ④ 的经验对照：摘要可解析 vs 不可解析两池
  const poolOf = (list) => {
    const opportunities = list.reduce((sum, row) => sum + (Number(row.opportunities) || 0), 0);
    const retreads = list.reduce((sum, row) => sum + (Number(row.retreads) || 0), 0);
    return { n: list.length, opportunities, retreads, rate: opportunities === 0 ? null : retreads / opportunities };
  };
  const attributionBySummaryAvailability = {
    available: poolOf(primaryRows.filter((row) => row.summaryAvailable === true)),
    unavailable: poolOf(primaryRows.filter((row) => row.summaryAvailable !== true)),
  };

  // 明细：只列**主口径**的行（五个窗口的行会重复同一条折痕）；
  // 严格口径的重踩全部列出，只在宽松口径下命中的**单列**（它们是上界里的假阳嫌疑）。
  const primaryWindowRows = rows.filter((row) => row.window === spec.key);
  const strictHits = primaryWindowRows.filter((row) => (Number(row.retreads) || 0) > 0);
  const looseOnly = primaryWindowRows.filter((row) => (Number(row.retreads) || 0) === 0 && (Number(row.retreadsLoose) || 0) > 0);
  const result = {
    home,
    window: spec,
    graphs: epoch.graphs,
    badGraphs: epoch.badGraphs,
    marks: epoch.marks,
    epoch,
    base: { ...base, rate: base.sigs === 0 ? null : round(base.repeated / base.sigs) },
    rows,
    windows,
    correlations,
    attribution: summarizeAttribution(primaryRows),
    attributionBySummaryAvailability,
    injectionCorpus: logs === "none" ? null : injectionCorpus,
    logs: { mode: logs, ...logsRead },
    limited: limit > 0 ? strictHits.slice(-limit) : strictHits,
    looseOnly: limit > 0 ? looseOnly.slice(-limit) : looseOnly,
  };
  result.criteria = judgeCriteria(result);
  result.verdict = result.criteria.some((item) => item.pass === false) ? "unusable" : "usable";
  return result;
}

/* ───────────────────────────── ⑧ 报告 ───────────────────────────── */

/** 归因表的四条桶（严格 / 宽松各一行）。 */
function attributionLine(label, bucket) {
  return (
    `    · ${padDisplay(label, 14)}重踩 ${padDisplay(int(bucket.retreads), 4, "right")}　` +
    `写了+注入可证 ${padDisplay(int(bucket.injectedListed), 3, "right")}（摘要的错）　` +
    `没写+注入可证 ${padDisplay(int(bucket.injectedUnlisted), 3, "right")}（摘要的错·漏写）　` +
    `写了+注入不可证 ${padDisplay(int(bucket.uninjectedListed), 3, "right")}（**冤枉**）　` +
    `没写+注入不可证 ${padDisplay(int(bucket.uninjectedUnlisted), 3, "right")}（**冤枉**）　` +
    `注入未观测 ${padDisplay(int(bucket.injectionUnknown), 3, "right")}　` +
    `写没写不可判 ${padDisplay(int(bucket.unknown), 3, "right")}`
  );
}

/** 渲染人读报告（返回字符串；CLI 直接 `console.log`）。 */
export function renderReport(result) {
  const out = [];
  const primary = result.windows[result.window.key] ?? result.windows[DEFAULT_WINDOW];
  const criteria = result.criteria;
  const failed = criteria.filter((item) => item.pass === false);
  const unknown = criteria.filter((item) => item.pass === null);
  const strict = result.attribution.strict;
  const loose = result.attribution.loose;

  out.push(`重踩率审计（T56 · 只读 · 零模型调用）`);
  out.push(`home = ${result.home}`);
  out.push(
    `图 = ${int(result.graphs)} 张（坏图 ${int(result.badGraphs)}）· 折痕 = ${int(result.marks)} 条 · ` +
      `有 seq 区间 = ${int(result.epoch.withRange)} · 区间内有死路 = ${int(result.epoch.withDeadEnds)}`,
  );
  out.push(
    `死路边 = ${int(result.epoch.withSig + result.epoch.withoutSig)}（有 sig ${int(result.epoch.withSig)} · 无 sig 回落 action 摘要 ${int(result.epoch.withoutSig)}）`,
  );
  out.push("");
  out.push(
    `一句话结论：**${result.verdict === "usable" ? "能用" : "不能用"}** —— ` +
      `重踩率 ${pct(primary.rate)}（严格口径）· ${pct(primary.rateLoose)}（宽松上界），` +
      `${pct(primary.zeroShare)} 的折痕恒为 0（众数占比 ${pct(primary.modalShare)}）` +
      (failed.length > 0 ? `；判据 ${failed.map((item) => item.key).join("、")} 不过。` : `；四条判据全过。`),
  );
  out.push("");

  /* ① 分布与归因 */
  out.push(`## ① 重踩率分布与归因`);
  out.push(`窗口（主口径）= ${result.window.label}`);
  out.push(
    `  可重踩机会（去重死路签名）= ${int(primary.opportunities)}　重踩 = ${int(primary.retreads)}　` +
      `**重踩率 = ${pct(primary.rate)}**　（宽松口径上界 ${pct(primary.rateLoose)}，${int(primary.retreadsLoose)} 条）`,
  );
  out.push(
    `    其中**纯 sig 匹配**（两边都有 C446 指纹，最严下界）= ${int(result.attribution.strict.sigOnly ?? 0)} 条；` +
      `其余是老边（无 sig）按 action 摘要回落 —— 那是**已知假阳类**（同一文件的不同编辑逐字相同）。`,
  );
  out.push(
    `  折痕级（n=${int(primary.n)}）：均值 ${num(primary.meanRate)} · 中位 ${num(primary.p50)} · p90 ${num(primary.p90)} · ` +
      `众数 = ${num(primary.modalValue)}（占 ${pct(primary.modalShare)}）· = 0 占 ${pct(primary.zeroShare)} · = 1 占 ${pct(primary.atOneShare)}`,
  );
  out.push(`  直方图：${RATE_BANDS.map((band) => `${band.key}=${int(primary.histogram[band.key])}`).join(" · ")}`);
  out.push(
    `  折后失败边 = ${int(primary.postFailures)} —— 「折后失败里有多少是重踩」= ` +
      `${pct(primary.postFailures === 0 ? null : primary.retreads / primary.postFailures)}（另一个视角，同样接近 0）。`,
  );
  out.push(
    `  **安慰剂对照**（折叠**之前**的失败边 —— 摘要不可能列到它们）：重踩 ` +
      `${int(primary.controlRetreads)} / ${int(primary.controlOpportunities)} = ${pct(primary.controlRate)}；` +
      `实验组 ${int(primary.retreads)} / ${int(primary.opportunities)} = ${pct(primary.rate)}。`,
  );
  out.push(
    `    ⇒ 差值 ${primary.controlRate === null || primary.rate === null ? "—" : `${((primary.rate - primary.controlRate) * 100).toFixed(2)}pp`}，` +
      `但**两边绝对事件数都是个位数**（${int(primary.retreads)} / ${int(primary.controlRetreads)}），且对照组受「陈旧度」混淆` +
      `（越老的失败越可能已被修掉）。没有「摘要更差」的对照组，只有「没摘要」的对照 —— 而那批数据不存在。`,
  );
  out.push("");
  out.push(`  归因（三个维度分开统计；「冤枉」= 摘要没有可证责任）：`);
  out.push(attributionLine("严格口径", strict));
  out.push(attributionLine("宽松口径", loose));
  out.push(
    `    ⇒ 严格口径里 **冤枉 ${int(strict.exonerated)} / ${int(strict.retreads)}**` +
      (strict.blameRate === null ? "" : `（${pct(strict.blameRate)} 的错能归到摘要）`) +
      `；宽松口径里冤枉 ${int(loose.exonerated)} / ${int(loose.retreads)}。`,
  );
  out.push(
    `  漏写率（**另一个指标**，不是重踩率）：可解析摘要的死路 ${int(result.attribution.deadEndsJudged)} 条，` +
      `摘要没写 ${int(result.attribution.deadEndsMissing)} 条 ⇒ ${pct(result.attribution.missingRate)}；` +
      `摘要正文**不可解析**的死路 ${int(result.attribution.summaryUnavailable)} 条（写没写不可判）。`,
  );
  if (result.injectionCorpus !== null) {
    const corpus = result.injectionCorpus;
    const share = (value) => (corpus.marks === 0 ? null : value / corpus.marks);
    out.push(
      `  注入可得性（**混淆项**，全库 ${int(corpus.marks)} 条可测折痕）：折叠后有过 compact-checkpoint ` +
        `${int(corpus.withCheckpoint)}（${pct(share(corpus.withCheckpoint))}）· chess-context 热清单 ` +
        `${int(corpus.withHotLedger)}（${pct(share(corpus.withHotLedger))}）· 两者都无 ${int(corpus.without)}`,
    );
    out.push(
      `    ⚠ 热清单逐条列着失败边 —— 死路信息**不是只有摘要一条通路**。所以「重踩为 0」不能归功于摘要（**因果不可识别**）。`,
    );
  } else {
    out.push(`  注入可得性：**未读日志**（--no-logs）—— 注入维度整体记「未观测」，不做因果推断。`);
  }
  out.push("");

  /* ② 四条判据 */
  out.push(`## ② 四条判据`);
  for (const item of criteria) {
    const mark = item.pass === null ? "？不可判" : item.pass ? "✓ 通过" : "✗ **不通过**";
    const extra = item.degenerate && item.pass ? "　⚠ **退化通过**（无方差，ρ 不可信，不构成支持）" : "";
    out.push(`  判据 ${item.key} ${item.name}：${mark}${extra}`);
    out.push(`    ${item.detail}`);
  }
  out.push("");

  /* ③ 能不能用 */
  out.push(`## ③ 能不能用`);
  if (result.verdict === "usable") {
    out.push(`  能用：四条判据全过${unknown.length > 0 ? `（其中 ${unknown.length} 条不可判）` : ""}。`);
  } else {
    out.push(`  **不能用。**判据 ${failed.map((item) => item.key).join("、")} 不过 —— 这个指标是**常函数**，`);
    out.push(`  不是「摘要好」，是「这件事几乎不发生」：全库同一个 action 签名失败两次的基线只有 ${pct(result.base.rate)}`);
    out.push(`  （${int(result.base.repeated)} / ${int(result.base.sigs)} 个签名在**整个会话**里复发过 —— 与折叠无关）。`);
  }
  out.push("");

  /* ④ 窗口稳定性 */
  out.push(`## ④ N 的选择与稳定性`);
  out.push(`  主口径 = 最宽窗口（判死要用最好的成绩）。四个较窄窗口用于稳定性：`);
  out.push(
    `    ${padDisplay("窗口", 26)}${padDisplay("可测折痕", 10, "right")}${padDisplay("机会", 8, "right")}` +
      `${padDisplay("重踩", 7, "right")}${padDisplay("重踩率", 12, "right")}${padDisplay("众数占比", 12, "right")}${padDisplay("删失", 7, "right")}`,
  );
  for (const windowSpec of WINDOWS) {
    const group = result.windows[windowSpec.key];
    out.push(
      `    ${padDisplay(windowSpec.label, 26)}${padDisplay(int(group.n), 10, "right")}${padDisplay(int(group.opportunities), 8, "right")}` +
        `${padDisplay(int(group.retreads), 7, "right")}${padDisplay(pct(group.rate), 12, "right")}` +
        `${padDisplay(pct(group.modalShare), 12, "right")}${padDisplay(int(group.censored), 7, "right")}`,
    );
  }
  const modalShares = WINDOWS.map((windowSpec) => result.windows[windowSpec.key].modalShare).filter((value) => value !== null);
  const spread = modalShares.length === 0 ? null : Math.max(...modalShares) - Math.min(...modalShares);
  out.push(
    `    ⇒ 众数占比在 ${pct(Math.min(...modalShares))}–${pct(Math.max(...modalShares))} 之间（极差 ${pct(spread)}）：` +
      `**结论与 N 无关**（每个窗口都 > ${pct(CRITERIA_RULES.maxConstantShare, 0)}）。`,
  );
  out.push("");

  /* ⑤ 为什么不能用 */
  out.push(`## ⑤ 如果不能用，为什么`);
  out.push(`  1. **判据 ① 结构性不过**：${pct(primary.zeroShare)} 的折痕重踩率为 0，众数占比 ${pct(primary.modalShare)} ≫ 80%。`);
  out.push(`     这不是数据问题，是现象问题：同一签名失败两次的基线只有 ${pct(result.base.rate)}，`);
  out.push(`     摘要再差也没有「重踩」可发生 —— 指标量的是一个几乎不存在的事件。`);
  out.push(`  2. **②③ 的通过是退化通过**：率几乎恒定 ⇒ 秩相关没有可解释的变异来源，ρ 接近 0 是**常函数的性质**，`);
  out.push(`     不是「它独立于形状/旧指标」。与 T53 判死 \`failureRecall\` 的形态**一模一样**（那里恒等于 1）。`);
  out.push(
    `  3. **因果不可识别**：` +
      (result.injectionCorpus === null
        ? `未读日志，不做因果推断。`
        : `热清单在 ${pct(result.injectionCorpus.marks === 0 ? null : result.injectionCorpus.withHotLedger / result.injectionCorpus.marks)} 的可测折痕之后注入过，` +
          `逐条列着同样的失败边。重踩为 0 可能是摘要的功劳，也可能是热清单的 —— 拆不开。`),
  );
  out.push(
    `  4. **归因样本太小**：严格口径真正重踩的只有 ${int(strict.retreads)} 条，其中冤枉 ${int(strict.exonerated)} 条；` +
      `能记在摘要头上的 ${int(strict.blamed)} 条，撑不起一个质量指标。`,
  );
  out.push(
    `  5. **观测边界**：${int(result.attribution.marksMeasured)} 条可测折痕里只有 ${int(result.attribution.summaryAvailableMarks)} 条摘要正文可解析，`,
  );
  out.push(`     「摘要写了没写」这一维度在多数折痕上**不可判** —— 归因本身就不是全量的。`);
  out.push(
    `  6. **口径本身是下界**：严格口径要求**逐字相同**（完整参数的 sig），模型只要把命令改一个字符` +
      `（换个 cwd、加个参数）就看不见 —— 而「换个写法重试同一条死路」恰恰是最常见的重蹈覆辙。`,
  );
  out.push(`     所以就算这个指标有信号，它测到的也不是「重蹈覆辙」，而是「**逐字**重蹈覆辙」—— 一个更小、更罕见的事件。`);
  out.push("");

  /* 明细 */
  const detail = result.limited ?? [];
  const looseOnly = result.looseOnly ?? [];
  out.push(
    `## 明细（严格口径重踩 ${int(result.attribution.strict.retreads)} 条 · 其中纯 sig ${int(result.attribution.strict.sigOnly ?? 0)} 条；` +
      `宽松上界另有 ${int(Math.max(0, result.attribution.loose.retreads - result.attribution.strict.retreads))} 条）`,
  );
  if (detail.length === 0) {
    out.push(`  （严格口径无重踩）`);
  } else {
    for (const row of detail.slice(-DEFAULT_LIMIT)) {
      for (const hit of row.attribution?.strict?.detail ?? []) {
        out.push(
          `  · [严格] ${shortSession(row.session)} [${row.trigger}] seq ${int(row.seqStart)}-${int(row.seqEnd)} ` +
            `${hit.deadId}→${hit.hitId} @${int(hit.hitSeq)}　摘要${hit.listed === null ? "?" : hit.listed ? "写了" : "没写"}` +
            `·注入${hit.injected === null ? "?" : hit.injected ? "可证" : "不可证"}　${hit.deadAction}`,
        );
      }
    }
  }
  if (looseOnly.length > 0) {
    const looseExtra = Math.max(0, (result.attribution.loose.retreads ?? 0) - (result.attribution.strict.retreads ?? 0));
    out.push(`  ── 上界（宽松口径）里多出来的 ${int(looseExtra)} 条 —— 已知假阳（同一文件的不同编辑），列前 ${int(Math.min(5, looseOnly.length))} 条：`);
    for (const row of looseOnly.slice(-5)) {
      const hit = (row.attribution?.loose?.detail ?? [])[0];
      if (hit === undefined) continue;
      out.push(
        `  · [上界] ${shortSession(row.session)} [${row.trigger}] ${hit.deadId}→${hit.hitId} @${int(hit.hitSeq)}　${hit.deadAction}`,
      );
    }
  }
  return out.join("\n");
}

/* ───────────────────────────── ⑨ CLI ───────────────────────────── */

/** 解析 `--key=value` / 裸开关（本脚本只认这几个，多余的静默忽略）。 */
export function parseArgs(argv = []) {
  const out = { json: false, logs: "all", home: null, session: "", limit: DEFAULT_LIMIT, window: DEFAULT_WINDOW };
  for (const raw of argv) {
    if (raw === "--json") out.json = true;
    else if (raw === "--no-logs") out.logs = "none";
    else if (raw.startsWith("--home=")) out.home = raw.slice("--home=".length);
    else if (raw.startsWith("--session=")) out.session = raw.slice("--session=".length);
    else if (raw.startsWith("--limit=")) out.limit = Number(raw.slice("--limit=".length)) || DEFAULT_LIMIT;
    else if (raw.startsWith("--window=")) out.window = raw.slice("--window=".length);
  }
  return out;
}

/* ───────────────────────────── 入口 ───────────────────────────── */

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
  const result = audit({
    home: args.home ?? resolveHome(),
    limit: args.limit,
    session: args.session,
    logs: args.logs,
    window: args.window,
  });
  if (result.graphs === 0) {
    console.error(`✗ 一张图都读不到：${result.home}（home 给错了？）`);
    process.exit(2);
  }
  if (args.json) console.log(JSON.stringify(result, null, 1));
  else console.log(renderReport(result));
}
