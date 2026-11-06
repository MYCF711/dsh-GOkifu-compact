#!/usr/bin/env node
/**
 * prediction-hit-audit.mjs —— 把摘要当**可验证的预测**来打分（T57 · 只读 · 零模型调用）
 *
 * ── 由来（用户的关键澄清，改掉了整个金标准） ─────────────────────────────────
 *   「归档就说明 user 觉得会话已经**结束**，注意是**结束**，不是成功和失败。
 *     这意味着你不需要去衡量成功和失败，因为很多时候 user 只是试探性地问一个问题。」
 *
 *   今晚（T51–T56）五个质量指标全倒在同一处：**「任务成没成」从来没被记录过**
 *   （`closeout` 只有 `partial` / `foldNote`）⇒ 所有指标只能拿别的指标互相校准 ⇒ **循环**。
 *   但「结束」不需要评判 —— 它是 user 的决定，是一个**确定的时刻**。
 *   于是金标准变成：**在这段确定的历史里，摘要说的东西对不对。**
 *
 * ── 摘要里有两类**能被归档时刻验证**的断言，本脚本把它们分开量 ──────────────────
 *
 *   | 断言 | 摘要里长什么样 | 归档时怎么验 | 方向 |
 *   |---|---|---|---|
 *   | **A 停点预测** | `## 当前节点` 段里的 `停在 nX` / `当前节点：nX` | 之后第一条 assistant 动作**基于哪个节点**（`via.from`）？是不是从 nX 继续？ | **正向**（说「我从这继续」，命中 = 摘要定位准） |
 *   | **B 死路预测** | `## 已探明死路` 列了 action X | 之后**有没有再出现** action X 的失败边？ | **反向**（说「别做 X」，重踩 = 强反例） |
 *
 *   **A 与 B 必须分开报**：A 是正向证据，B 是反向证据，混在一起会互相冲淡。
 *   T56 只算了 B；**A 从来没被测过**。
 *
 * ── A 的口径（这是本脚本全部价值所在，改口径就是改指标） ────────────────────────
 *
 *   ① **停点断言**是一个**闭集**（`STOP_PATTERNS`），且**只在前 `## 当前节点` 段内**抽：
 *      · 算：`停在 n<id>` / `现在停在 n<id>` / `当前停在 n<id>`（id 前允许 `**` `[` `「` 等装饰）；
 *      · 算：`当前节点：n<id>`；
 *      · **不算**（逐条计数，报告里列）：`停在 n?`（写不出节点）、`停在 e?`（写的是边）、
 *        `停在 <散文>`（如「停在 T10 收口阶段」）、没有该段、**段外**出现的节点 id。
 *      · 边界：`n1` **不**匹配 `n12`（`(?![0-9])`）；`e\d+` 是边不是节点；段标题本身不算。
 *      为什么必须限定在段内：`## 棋谱（状态节点）` 里逐行都是 `- n<id> …`，
 *      在全文里抽「n\d+」等于抽最后一行 —— 那是**复制**，不是**预测**。
 *
 *   ② **停点**（真值）= 折叠区间内 `seq ≤ seqEnd` 的**最后一个**节点。
 *      `seqEnd` 是折痕的右端点，`节点.seq` 是它落盘的位置 —— 两者同源（都来自会话日志 seq）。
 *
 *   ③ **之后第一条 assistant 动作** = `seq > seqEnd` 的第一个 `kind === "agent"` 节点；
 *      「基于哪个节点」= 它的 `via` 边（`from → to`）的 `from`。
 *      图的语义：每个 agent 节点由一条边从**上一个状态**指向它，所以 `via.from` 就是
 *      「这个动作是在哪个节点的基础上做的」。
 *
 *   ④ **右删失 / 被人打断**（**不计入分母、也不记 0**）：
 *      · `censored`：折叠之后再没有 agent 节点（会话就结束在折叠处）—— 没有「之后」可验；
 *      · `superseded`：折叠后、第一个 agent 动作**之前**插进了一条 user 消息 ——
 *        停点预测被人类改向取代，不是摘要写错。
 *      `Number(null) === 0` 是本仓踩过的坑：缺测被读成「命中 0」。
 *
 *   ⑤ **分解（必须两半都报）**：A 命中可以拆成
 *        · 定位（摘要写的节点在图中存在）
 *        · 复制（摘要写的 = 折叠区间末节点）
 *        · 承接（`via.from` = 摘要写的节点）
 *      拆开看才知道「命中」是不是**复制任务**。若 `via.from === 折叠区间末节点` 的比例
 *      本身就 ≈ 100%，那「承接」这一半**结构上不可能失败**，A 量的就是**复制准确率**。
 *      ⇒ 这是本脚本的**诚实性开关**：`structuralBaseline` 高而 `copyShare` 高，
 *         A 就是恒等式，不是质量指标。
 *
 *   ⑥ **选择偏差（敏感性口径）**：`停在 n?` 的折痕被排除在主分母外。
 *      它们恰恰是「摘要写不出停点」的失败 ⇒ 报告里再给一个把它们**按 miss** 计入的率。
 *      两个率的差就是**分母口径**带来的全部不确定性。
 *
 * ── B 的口径（与 T56 同源，不另发明） ───────────────────────────────────────
 *   直接复用 `scripts/retread-audit.mjs` 的 `markRetread` / `WINDOWS[0]`（tail）：
 *     · **严格口径（主）**：`sig:` 优先，老边回落 `act:actionSignature(action, {})`；
 *     · **宽松口径（上界）**：一律 `act:actionSignature(action, {})`（已知假阳：同文件不同编辑）；
 *     · **纯 sig 下界**：两边都带 C446 指纹的子集。
 *   另报**四格**（T56 的第 24 轮教训）：
 *     摘要**列了** → 之后重踩 = 警告无效；之后避开 = ✅ **摘要有效的正向证据**。
 *
 * ── 分层（因果可识别性） ─────────────────────────────────────────────────────
 *   按「折叠之后有没有 `chess-context` 热清单注入」分层（T56 实测 63.18% 有）。
 *   **对 A：这不是混淆项** —— A 的分子是「摘要写的 id vs 图里的 id」，与模型看没看到热清单无关。
 *   对 A 来说这一层是**安慰剂**：两格率应该一样（不一样就说明抽取有 bug）。
 *   **对 B：这是混淆项** —— 热清单逐条列着失败边，重踩为 0 不能归功于摘要。
 *
 * ── 四条判据（今晚总结的那四条，门槛与 T52–T56 同一套） ─────────────────────────
 *   ① **有方差**：众数占比 < 80%（恒等于某个值 = 常函数，没有信息量）；
 *   ② **与形状无关**：|ρ(tailGap)| < 0.2 且 |ρ(span)| < 0.2；
 *   ③ **与已有指标不同**：ρ(可定位率) < 0.8 且 ρ(T33 分) < 0.8；
 *   ④ **分子不是修复函数的输出**：设计保证 + 经验对照（摘要**被补回过** vs **没补回过**两池）。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` / `*.delta.jsonl` / 会话日志只 `readFileSync`；一个字节都不写；
 *   · **不改产品代码**：只 import 纯函数；`applyOfflineFoldToGraph` 一律不碰；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **判据必须能返回「不通过」**（否则守卫就是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/prediction-hit-audit.mjs                    # 全量（默认读会话日志，约 20 秒）
 *   node scripts/prediction-hit-audit.mjs --no-logs           # 跳过日志（分层维度记「未观测」）
 *   node scripts/prediction-hit-audit.mjs --json              # 机读（报告/测试用）
 *   node scripts/prediction-hit-audit.mjs --home <dir>        # 换 DSH_HOME
 *   node scripts/prediction-hit-audit.mjs --session <前缀>    # 只看某个会话
 *   node scripts/prediction-hit-audit.mjs --limit 20          # 明细列最近 N 条
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 一张图都读不到（home 给错了）。
 */
import nodePath from "node:path";
import os from "node:os";

import { collectGraphFiles } from "../src/ui.mjs";
import { evidenceSpan, failureEdges } from "../src/rooms/kifu-model.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
import { isDanglingResidue } from "../src/rooms/ledger.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";
import { measureSample } from "./summary-usability-audit.mjs";
import {
  CRITERIA_RULES,
  RATE_BANDS,
  WINDOWS,
  graphMaxSeqOf,
  injectionSeqsOf,
  markRetread,
  strictKeyOf,
  summarizeAttribution,
  summarizeWindow,
} from "./retread-audit.mjs";
import { buildLogIndex, correlate, independentIds, placeholderCount } from "./range-fidelity-audit.mjs";

/* ───────────────────────────── 口径常量（改口径只改这里） ───────────────────────────── */

/**
 * 停点断言的**闭集**。顺序即优先级；`key` 会出现在报告的「抽取规则」表里。
 *
 * `[ \t]*` 而不是 `\s*`：**只允许同一行内**的空白。
 * 为什么：真机里大量摘要是「当前停在 <散文>」这种**没有 id** 的写法
 * （`当前停在 T10 收口阶段：…`），用 `\s*` 会跨行吃到下一段的 `n30` ——
 * 那会把「写不出停点」记成「写对了」。
 *
 * 装饰字符类 `[「『\[【(（`*_>#]`：真机常见 `停在 **n43**` / `停在 [n37]` / `停在「n9」`。
 * 不包含 `：` 与中文 —— 那两个字符一出现就说明后面是**散文**，不是 id。
 */
export const STOP_PATTERNS = Object.freeze([
  {
    key: "停在 n<id>",
    re: /(?:当前|现在|目前|此时)?[ \t]*停在[ \t]*(?:节点)?[ \t]*[「『\[【(（`*_>#]*[ \t]*(n[0-9]{1,6})(?![0-9])/,
  },
  {
    key: "当前节点：n<id>",
    re: /当前(?:可见|原始|最新|所在)?[ \t]*节点[ \t]*[：:][ \t]*[「『\[【(（`*_>#]*[ \t]*(n[0-9]{1,6})(?![0-9])/,
  },
]);

/** 段标题里必须出现的词（`## 当前节点与最近用户消息` / `## 当前节点`）。 */
export const STOP_SECTION_KEYWORD = "当前节点";

/**
 * **不是**停点断言的三种形态（逐条计数，进报告）。
 *
 * 它们不是「漏抽」，是**判定**：`n?` 是「我不知道」，不是「停在 nX」。
 * 但报告里必须能看见它们 —— 否则「199 条断言」这种分母会被误读成「摘要在 199 条里给了停点」。
 */
export const NON_CLAIM_PATTERNS = Object.freeze([
  { key: "n? 占位（写不出节点）", re: /(?:停在|当前(?:可见)?节点[ \t]*[：:])[ \t]*[「『\[【(（`*_>#]*[ \t]*n[ \t]*\?/ },
  { key: "e? 占位（写的是边）", re: /(?:停在|当前(?:可见)?节点[ \t]*[：:])[ \t]*[「『\[【(（`*_>#]*[ \t]*e[ \t]*\?/ },
]);

/**
 * 样本量下限：某格 < 10 条**不许硬算率**（报告里写「样本不足」，不给百分数）。
 * 这条不是形式主义：T56 的归因桶里就有一格只有 2 条，百分比看起来很唬人。
 */
export const MIN_CELL = 10;

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/** 主口径（B 用最宽窗口 —— 判死要用最好的成绩，与 T56 一致）。 */
export const DEFAULT_WINDOW = "tail";

// 判据门槛就是 T52–T56 那一套，**不另起一份**（两套门槛 = 两套结论）。
export { CRITERIA_RULES };

/* ───────────────────────────── 小工具（与 retread-audit 同一套显示口径） ───────────────────────────── */

const round = (value, digits = 6) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 10 ** digits) / 10 ** digits;

/** 百分比；`null` 一律 `—`（**不拿 0 冒充缺测**）。 */
const pct = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;

const num = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);

const int = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "—");

/** 终端显示宽度（CJK / 全角算 2 格）—— 表格对齐只靠它。 */
function displayWidth(text) {
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
function padDisplay(text, size, align = "left") {
  const body = String(text ?? "");
  const fill = " ".repeat(Math.max(0, Number(size) - displayWidth(body)));
  return align === "right" ? `${fill}${body}` : `${body}${fill}`;
}

/** 会话短名：`session-<uuid>` 剥掉前缀再截 8 位（否则只剩 `session-`）。 */
const shortSession = (dir) => {
  const body = String(dir ?? "");
  const stripped = body.replace(/^session-/, "");
  return `${body.startsWith("session-") ? "s-" : ""}${stripped.slice(0, 8)}`;
};

/**
 * `seq` 的安全数字转换。
 *
 * ★ `Number(null) === 0`、`Number("") === 0` —— 缺字段会被读成「seq = 0」，
 * 于是「没有区间」的折痕被当成「区间 0..0」照样进分母。本仓踩过（T49 的 `turn` 全是 null）。
 * 这里显式把 `null` / `undefined` / 空串变成 `NaN`（后续 `Number.isFinite` 会拒掉）。
 *
 * @param {unknown} value
 * @returns {number}
 */
function toSeq(value) {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  return Number(value);
}

/** 与 doctor / graph-audit / retread-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/* ───────────────────────────── ① 摘要正文 → 停点断言 ───────────────────────────── */

/**
 * 把摘要按二级标题切成段。**不用正则跨行**：真机摘要有 `\r\n`，`^##…$` + `m` 在
 * 某些编辑器写出的文件上会整段失配（本脚本第一版就踩了，`hasSection` 恒 false）。
 *
 * @param {string} text
 * @returns {Array<{heading:string, body:string, line:number}>}
 */
export function splitSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    const heading = /^##(?!#)[ \t]*(.*)$/.exec(line);
    if (heading !== null) {
      if (current !== null) out.push(current);
      current = { heading: heading[1].trim(), body: "", line: index + 1 };
      continue;
    }
    if (current !== null) current.body += `${line}\n`;
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * 取 `## 当前节点…` 段的正文；没有这一段返回 `null`（**不是空字符串** —— 两者语义不同）。
 * @param {string} text
 * @returns {string|null}
 */
export function stopSectionOf(text) {
  const section = splitSections(text).find((item) => item.heading.includes(STOP_SECTION_KEYWORD));
  return section === undefined ? null : section.body;
}

/**
 * 从摘要里抽**停点断言**。
 *
 * @param {string} text 摘要正文（模型输出 + 机械追加段）
 * @returns {{claim:string|null, pattern:string|null, sectionScoped:boolean,
 *   nonClaim:string|null, conflicts:boolean, outsideNodeIds:number, sectionMissing:boolean}}
 */
export function extractStopClaim(text) {
  const body = String(text ?? "");
  const section = stopSectionOf(body);
  // 段外的节点 id 只**计数**，不参与判定 —— 用来证明「限定段内」不是没数据，是判定。
  const outside = section === null ? 0 : (body.replace(section, "").match(/n[0-9]{1,6}(?![0-9])/g) ?? []).length;

  const result = {
    claim: null,
    pattern: null,
    sectionScoped: section !== null,
    nonClaim: null,
    conflicts: false,
    outsideNodeIds: outside,
    sectionMissing: section === null,
  };
  if (section === null) return result;

  const scope = section;
  const hits = [];
  for (const pattern of STOP_PATTERNS) {
    // ★ 必须**全局**扫：只 `exec` 一次只能拿到第一个断言，
    //   「同一段里写了两个停点」这种冲突就永远看不见（报告会装作一致）。
    const re = new RegExp(pattern.re.source, "g");
    for (const match of scope.matchAll(re)) hits.push({ key: pattern.key, id: match[1], index: match.index });
  }
  hits.sort((a, b) => a.index - b.index);
  if (hits.length > 0) {
    result.claim = hits[0].id;
    result.pattern = hits[0].key;
    result.conflicts = new Set(hits.map((item) => item.id)).size > 1;
    return result;
  }

  for (const pattern of NON_CLAIM_PATTERNS) {
    if (pattern.re.test(scope)) {
      result.nonClaim = pattern.key;
      return result;
    }
  }
  result.nonClaim = "停在 <散文>（段内没有具体节点 id）";
  return result;
}

/* ───────────────────────────── ② 停点预测的验证 ───────────────────────────── */

/** 节点排序键：`seq` 升序，同 seq 用 `order` 兜底（保证确定性）。 */
function sortedNodes(graph, order = null) {
  const rank = order instanceof Map ? order : null;
  return Object.values(graph?.nodes ?? {})
    .filter((node) => node !== null && typeof node === "object")
    .map((node, index) => ({ node, rank: rank?.get(node.id) ?? index }))
    .sort((a, b) => Number(a.node.seq) - Number(b.node.seq) || a.rank - b.rank)
    .map((item) => item.node);
}

/**
 * 折叠区间的**末节点**（`seq ≤ seqEnd` 的最后一个）。
 *
 * 用 `seq` 而不是 `ts`：`ts` 是落盘时刻，归档补折会晚几小时（T56 的同一条教训）。
 *
 * @param {object} graph
 * @param {number} seqEnd
 * @param {Map<string,number>} [order]
 * @returns {object|null}
 */
export function lastFoldedNode(graph, seqEnd, order = null) {
  let last = null;
  for (const node of sortedNodes(graph, order)) {
    if (!Number.isFinite(Number(node.seq))) continue;
    if (Number(node.seq) <= Number(seqEnd)) last = node;
    else break;
  }
  return last;
}

/**
 * 折叠之后的第一条 **assistant 动作**，以及它基于哪个节点。
 *
 * · `firstAgent`：`seq > seqEnd` 的第一个 `kind === "agent"` 节点；
 * · `viaFrom`：`firstAgent.via` 边的 `from`（「这个动作是在哪个节点的基础上做的」）；
 * · `interruption`：`seq > seqEnd` 的第一条 **user** 消息 —— 若它排在 `firstAgent` 前面，
 *   停点预测被人类改向取代（`superseded`），**不是摘要写错**；
 * · `censored`：折叠之后再没有 agent 节点（会话就结束在折叠处）。
 *
 * @param {object} graph
 * @param {number} seqEnd
 * @param {Map<string,number>} [order]
 * @returns {{firstAgent:object|null, viaFrom:string|null, interruption:object|null,
 *   superseded:boolean, censored:boolean}}
 */
export function firstActionAfter(graph, seqEnd, order = null) {
  let firstAgent = null;
  let interruption = null;
  for (const node of sortedNodes(graph, order)) {
    if (!Number.isFinite(Number(node.seq))) continue;
    if (Number(node.seq) <= Number(seqEnd)) continue;
    if (node.kind === "user" && interruption === null) interruption = node;
    if (node.kind === "agent") {
      firstAgent = node;
      break;
    }
  }
  const viaFrom =
    firstAgent === null ? null : (graph?.edges?.[String(firstAgent.via ?? "")]?.from ?? null);
  const superseded = interruption !== null && (firstAgent === null || Number(interruption.seq) < Number(firstAgent.seq));
  return { firstAgent, viaFrom, interruption, superseded, censored: firstAgent === null };
}

/**
 * **四格**（T56 第 24 轮的教训）：把「摘要**列了**死路」× 「之后**重踩**了」交叉。
 *
 *   | | 之后重踩了 | 之后避开了 |
 *   |---|---|---|
 *   | 摘要列了 | 警告无效 | ✅ **摘要有效的正向证据** |
 *   | 摘要没列 | 漏写 | （无信息） |
 *
 * 只有「列了且避开了」才是摘要有用的证据；「没重踩」本身什么都不说明。
 *
 * 口径与 `retread-audit` **同源**：死路 = `failuresInFoldRange`（去重后的 `strictKeyOf`），
 * 重踩 = 折叠后（`evidence.start > seqEnd`）出现同一个签名。摘要正文取不到 ⇒ `unknown`。
 *
 * @param {object} graph
 * @param {object} mark
 * @param {string|null} text
 * @returns {{listedRetread:number, listedAvoided:number, unlistedRetread:number, unlistedAvoided:number, unknown:number}|null}
 */
export function fourCellOf(graph, mark, text) {
  const rawStart = toSeq(mark?.seqStart);
  const rawEnd = toSeq(mark?.seqEnd);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);
  const cell = { listedRetread: 0, listedAvoided: 0, unlistedRetread: 0, unlistedAvoided: 0, unknown: 0 };
  if (typeof text !== "string" || text === "") return cell;

  const post = new Set();
  for (const edge of failureEdges(graph)) {
    if (isDanglingResidue(edge, { graph })) continue;
    const span = evidenceSpan(edge);
    if (span !== null && span.start > hi) post.add(strictKeyOf(edge));
  }
  const seen = new Set();
  for (const edge of failuresInFoldRange(graph, { start: lo, end: hi })) {
    const key = strictKeyOf(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = mentionsEdge(text, String(edge?.id ?? ""));
    const retread = post.has(key);
    if (listed) {
      if (retread) cell.listedRetread += 1;
      else cell.listedAvoided += 1;
    } else if (retread) cell.unlistedRetread += 1;
    else cell.unlistedAvoided += 1;
  }
  return cell;
}

/* ───────────────────────────── ③ 单条折痕 ───────────────────────────── */
/**
 * 算**一条** foldMark 的停点预测行（纯函数，便于单测）。
 *
 * `measurable === false` 时 `hit` 是 `null`（**不拿 false 冒充「没命中」**）。
 *
 * @param {object} graph 棋谱
 * @param {object} mark foldMark
 * @param {{index?:number|null, session?:string|null, summaryText?:string|null|null,
 *   order?:Map<string,number>|null, injection?:Array<{seq:number,kind:string}>|null}} [ctx]
 * @returns {object}
 */
export function markPrediction(graph, mark, ctx = {}) {
  const { index = null, session = null, order = null, injection = null } = ctx;
  const rawStart = toSeq(mark?.seqStart);
  const rawEnd = toSeq(mark?.seqEnd);
  const row = {
    session,
    index,
    at: Number(mark?.at) || 0,
    trigger: String(mark?.trigger ?? ""),
    seqStart: Number.isFinite(rawStart) ? rawStart : null,
    seqEnd: Number.isFinite(rawEnd) ? rawEnd : null,
    /** 摘要里写的停点（`n<id>`）；`null` = 没有可解析的停点断言。 */
    claim: null,
    claimPattern: null,
    /**
     * 抽取分类（报告的「样本量」表按它分列，**不许合并**）：
     * `claim` / `摘要正文不可解析` / `没有 \`## 当前节点\` 段` /
     * `n? 占位（写不出节点）` / `e? 占位（写的是边）` / `停在 <散文>（段内没有具体节点 id）` / `区间缺失`。
     */
    extraction: "区间缺失",
    /** 折叠区间末节点（真值）。 */
    lastFolded: null,
    lastFoldedSeq: null,
    /** 折叠后第一条 assistant 动作。 */
    firstAgent: null,
    viaFrom: null,
    /** 三档可验证性。 */
    censored: true,
    superseded: false,
    noVia: false,
    /** 命中：`viaFrom === claim`。`null` = 不可验证。 */
    measurable: false,
    hit: null,
    /** 0/1 数值化（`correlate` 只认有限数字 —— 布尔值会被整批过滤掉，n 变 0）。 */
    hitValue: null,
    /** A 的三半分解（只在可验证时非 null）。 */
    exists: null,
    isLast: null,
    continues: null,
    tailGap: null,
    span: null,
    /** 摘要正文可解析 + 是否被机械补回过（判据 ④ 的经验对照）。 */
    summaryAvailable: false,
    summaryRepaired: false,
    /** 判据 ③ 需要的两个已有指标（`audit()` 填）。 */
    traceableShare: null,
    qualityTotal: null,
    /** B 的口径（`markRetread` 的字段原样带过来）。 */
    b: null,
    /** 分层：折叠之后有没有热清单 / checkpoint 注入（`null` = 没读日志）。 */
    hotLedger: null,
    checkpoint: null,
    why: "",
  };

  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return row;
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);

  // 正文（`undefined` = 调用方没给 ⇒ 自己取；`null` = 确认取不到）
  let text = ctx.summaryText;
  if (text === undefined) text = resolveSummaryText(mark, graph?.lastOfflineSummary ?? null).text;
  row.summaryAvailable = typeof text === "string" && text !== "";
  row.summaryRepaired = Number(mark?.qualityRepaired) > 0;

  const claim = row.summaryAvailable ? extractStopClaim(text) : null;
  if (!row.summaryAvailable) row.extraction = "摘要正文不可解析";
  else if (claim.sectionMissing) row.extraction = "没有 `## 当前节点` 段";
  else if (claim.claim === null) row.extraction = claim.nonClaim ?? "停在 <散文>（段内没有具体节点 id）";
  else {
    row.extraction = "claim";
    row.claim = claim.claim;
    row.claimPattern = claim.pattern;
  }

  const last = lastFoldedNode(graph, hi, order);
  const after = firstActionAfter(graph, hi, order);
  row.lastFolded = last?.id ?? null;
  row.lastFoldedSeq = Number.isFinite(Number(last?.seq)) ? Number(last.seq) : null;
  row.firstAgent = after.firstAgent?.id ?? null;
  row.viaFrom = after.viaFrom;
  row.censored = after.censored;
  row.superseded = after.superseded;
  row.noVia = after.firstAgent !== null && after.viaFrom === null;
  row.tailGap = Number.isFinite(Number(last?.seq)) ? graphMaxSeqOf(graph) - Number(last.seq) : null;
  row.span = hi - lo + 1;

  if (Array.isArray(injection)) {
    row.hotLedger = injection.some((item) => item.kind === "chess-context" && Number(item.seq) > hi);
    row.checkpoint = injection.some((item) => item.kind === "compact-checkpoint" && Number(item.seq) > hi);
  }

  if (row.claim === null) {
    row.why = "没有停点断言";
    return row;
  }
  if (row.censored) {
    row.why = "折叠后再没有 assistant 动作（右删失）";
    return row;
  }
  if (row.superseded) {
    row.why = "折叠后先插进一条 user 消息（停点被人类改向取代）";
    return row;
  }
  if (row.noVia) {
    row.why = "第一条 assistant 动作没有 via 边（图上无前驱）";
    return row;
  }

  row.measurable = true;
  row.exists = Object.prototype.hasOwnProperty.call(graph?.nodes ?? {}, row.claim);
  row.isLast = row.claim === row.lastFolded;
  row.continues = row.viaFrom === row.claim;
  row.hit = row.continues === true;
  row.hitValue = row.hit ? 1 : 0;
  return row;
}

/* ───────────────────────────── ④ 聚合 ───────────────────────────── */

/** 一个空桶。 */
function emptyBucket() {
  return {
    claims: 0,
    measurable: 0,
    hits: 0,
    misses: 0,
    censored: 0,
    superseded: 0,
    noVia: 0,
    rate: null,
    /** 敏感性口径：把不可验证的 claim 全按 miss 计入。 */
    rateSensitivity: null,
    /** 三半分解。 */
    existsShare: null,
    copyShare: null,
    continueShare: null,
    /** 结构基线：`via.from === 折叠区间末节点` 的比例（越高 ⇒ 「承接」越不可能失败）。 */
    structuralBaseline: null,
    /** 二值取值的众数占比（判据 ①）。 */
    modalShare: null,
    /** 抽取分类计数。 */
    extraction: Object.create(null),
    /** 分层计数。 */
    byHotLedger: { with: 0, without: 0, unknown: 0 },
    detail: [],
  };
}

/**
 * 把一批行聚合成 A 的口径数字。
 *
 * **样本不足时率是 `null`**（`measurable < MIN_CELL`），报告里写「样本不足」。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarizeA(rows) {
  const bucket = emptyBucket();
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row === null || row === undefined) continue;
    bucket.extraction[row.extraction] = (bucket.extraction[row.extraction] ?? 0) + 1;
    if (row.claim === null || row.claim === undefined) continue;
    bucket.claims += 1;
    if (row.measurable !== true) {
      if (row.censored) bucket.censored += 1;
      else if (row.superseded) bucket.superseded += 1;
      else if (row.noVia) bucket.noVia += 1;
      continue;
    }
    bucket.measurable += 1;
    if (row.hit === true) {
      bucket.hits += 1;
      bucket.detail.push(row);
    } else {
      bucket.misses += 1;
      bucket.detail.push(row);
    }
    if (row.hotLedger === true) bucket.byHotLedger.with += 1;
    else if (row.hotLedger === false) bucket.byHotLedger.without += 1;
    else bucket.byHotLedger.unknown += 1;
  }

  const enough = bucket.measurable >= MIN_CELL;
  bucket.rate = enough ? bucket.hits / bucket.measurable : null;
  bucket.rateSensitivity = bucket.claims >= MIN_CELL ? bucket.hits / bucket.claims : null;

  const share = (count) => (enough ? count / bucket.measurable : null);
  bucket.existsShare = share(list.filter((row) => row?.measurable === true && row.exists === true).length);
  bucket.copyShare = share(list.filter((row) => row?.measurable === true && row.isLast === true).length);
  bucket.continueShare = share(list.filter((row) => row?.measurable === true && row.continues === true).length);
  bucket.structuralBaseline = share(
    list.filter((row) => row?.measurable === true && row.viaFrom !== null && row.viaFrom === row.lastFolded).length,
  );
  bucket.modalShare =
    bucket.measurable === 0 ? null : Math.max(bucket.hits, bucket.misses) / bucket.measurable;
  bucket.detail.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.session).localeCompare(String(b.session)));
  return bucket;
}

/**
 * 一个分层的格（`MIN_CELL` 以下**不算率**，只给条数）。
 * @param {Array<object>} rows
 * @returns {{n:number, measurable:number, hits:number, rate:number|null, insufficient:boolean}}
 */
export function cellOf(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.measurable === true);
  const hits = list.filter((row) => row.hit === true).length;
  return {
    n: (Array.isArray(rows) ? rows : []).length,
    measurable: list.length,
    hits,
    rate: list.length >= MIN_CELL ? hits / list.length : null,
    insufficient: list.length < MIN_CELL,
  };
}

/**
 * A 的二值**取值分布**（判据 ① 用）。
 * @param {Array<object>} rows
 * @returns {{n:number, ones:number, zeros:number, modalShare:number|null}}
 */
export function valueDistribution(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.measurable === true);
  const ones = list.filter((row) => row.hit === true).length;
  const zeros = list.length - ones;
  return {
    n: list.length,
    ones,
    zeros,
    modalShare: list.length === 0 ? null : Math.max(ones, zeros) / list.length,
  };
}

/* ───────────────────────────── ⑤ 四条判据 ───────────────────────────── */

/**
 * 四条判据的裁决（A 与 B 各算一遍，**门槛同一套**）。
 *
 * 判据 ④ 是**设计保证 + 经验对照**：
 *   · A 的分子 = 「摘要写的节点 id」是否等于「`via.from`」—— 机械补回（`repairMissingFailures` /
 *     `repairMissingConstraints`）只往 `## 已探明死路` / `## 约束` 尾部追加文本，
 *     **不写 `## 当前节点` 段**、不改 `via`、不改 `evidence`；
 *   · B 的分子 = 折叠后新产生的失败边（`settleEdge` 写入），修复函数只改摘要文本、不写边（T56 已证）。
 *   经验对照：摘要**被补回过**（`qualityRepaired > 0`）与**没补回过**两池的率。
 *   若分子真是修复函数的输出，两池会系统性分叉。
 *
 * @param {{a:object, b:object, correlationsA:object, correlationsB:object,
 *   poolsA:object, poolsB:object}} input
 * @returns {Array<object>} 判据列表（每条带 `key` / `pass` / `detail`）
 */
export function judgeCriteria(input) {
  const criteria = [];
  const a = input?.a ?? null;
  const b = input?.b ?? null;
  const ca = input?.correlationsA ?? {};
  const cb = input?.correlationsB ?? {};

  const one = (prefix, bucket, correlations, pools, extraDetail) => {
    const out = [];
    // A 的桶用 `measurable`，B 的窗口汇总用 `n` —— 两个来源的字段名不同，这里统一。
    const sampleSize = bucket?.measurable ?? bucket?.n ?? null;

    // ① 有方差
    const modalShare = bucket?.modalShare ?? null;
    out.push({
      key: `${prefix}①`,
      name: `有方差（众数占比 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
      value: modalShare,
      detail: `众数占比 = ${pct(modalShare)}（n=${int(sampleSize)}，门槛 < ${pct(CRITERIA_RULES.maxConstantShare, 0)}）`,
      pass: modalShare === null ? null : modalShare < CRITERIA_RULES.maxConstantShare,
      degenerate: false,
    });

    // ② 与形状无关
    const absTail =
      correlations?.tailGap?.spearman === null || correlations?.tailGap?.spearman === undefined
        ? null
        : Math.abs(correlations.tailGap.spearman);
    const absSpan =
      correlations?.span?.spearman === null || correlations?.span?.spearman === undefined
        ? null
        : Math.abs(correlations.span.spearman);
    out.push({
      key: `${prefix}②`,
      name: `与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
      value: absTail === null || absSpan === null ? null : Math.max(absTail, absSpan),
      detail:
        `|ρ(离尾部)| = ${num(absTail)}（n=${int(correlations?.tailGap?.n ?? 0)}）· ` +
        `|ρ(跨度)| = ${num(absSpan)}（n=${int(correlations?.span?.n ?? 0)}）`,
      pass: absTail === null || absSpan === null ? null : absTail < CRITERIA_RULES.maxAbsRhoShape && absSpan < CRITERIA_RULES.maxAbsRhoShape,
      /** 无方差时 ρ 不可信 —— 这条是「退化通过」，不构成支持。 */
      degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
    });

    // ③ 与已有指标不同
    const rhoTraceable = correlations?.traceableShare?.spearman ?? null;
    const rhoQuality = correlations?.qualityTotal?.spearman ?? null;
    out.push({
      key: `${prefix}③`,
      name: `与已有指标不同（ρ < ${CRITERIA_RULES.maxRhoRedundant}）`,
      value: rhoTraceable === null || rhoQuality === null ? null : Math.max(Math.abs(rhoTraceable), Math.abs(rhoQuality)),
      detail: `ρ(可定位率) = ${num(rhoTraceable)} · ρ(T33 分) = ${num(rhoQuality)}`,
      pass:
        rhoTraceable === null || rhoQuality === null
          ? null
          : Math.abs(rhoTraceable) < CRITERIA_RULES.maxRhoRedundant && Math.abs(rhoQuality) < CRITERIA_RULES.maxRhoRedundant,
      degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
    });

    // ④ 分子不是修复函数的输出
    const repaired = pools?.repaired ?? null;
    const clean = pools?.clean ?? null;
    const gap =
      repaired === null || clean === null || repaired.rate === null || clean.rate === null
        ? null
        : Math.abs(repaired.rate - clean.rate);
    out.push({
      key: `${prefix}④`,
      name: "分子不是修复函数的输出",
      value: gap,
      detail:
        (extraDetail ?? "") +
        (repaired === null || clean === null
          ? "　经验对照：**未读到补回字段**，只有设计保证。"
          : `　经验对照：补回过 ${pct(repaired.rate)}（n=${int(repaired.n)}）· 没补回过 ${pct(clean.rate)}（n=${int(clean.n)}）` +
            `　差值 ${gap === null ? "—" : `${(gap * 100).toFixed(2)}pp`}`),
      // 设计保证成立；经验对照只在「两池都有 ≥ MIN_CELL」时才作数。
      // ★ 「样本不足」由**条数**判，不靠调用方记得填 `insufficient`（漏填 = 拿 2 条算差值）。
      pass:
        repaired === null || clean === null
          ? true
          : !(Number(repaired.n) >= MIN_CELL) || !(Number(clean.n) >= MIN_CELL)
            ? null
            : true,
      degenerate: false,
    });

    return out;
  };

  criteria.push(...one("A", a, ca, input?.poolsA ?? null, "设计保证：机械补回只追加 `## 已探明死路` / `## 约束` 段，不写 `## 当前节点` 段。"));
  criteria.push(...one("B", b, cb, input?.poolsB ?? null, "设计保证：分子是折叠后新产生的失败边（`settleEdge` 写入），修复函数只改摘要文本。"));
  return criteria;
}

/* ───────────────────────────── ⑥ 扫描 ───────────────────────────── */

/**
 * 扫全部会话。
 *
 * @param {{home?:string, limit?:number, session?:string, logs?:"all"|"none"}} [options]
 * @returns {object}
 */
export function audit({ home = resolveHome(), limit = DEFAULT_LIMIT, session = "", logs = "all" } = {}) {
  const { files } = collectGraphFiles(home);
  const rows = [];
  const epoch = { graphs: 0, badGraphs: 0, marks: 0, withRange: 0, withSummary: 0, withClaim: 0, measurable: 0 };
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
    const order = new Map((Array.isArray(graph?.order) ? graph.order : []).map((id, index) => [id, index]));
    sessions.push({ dir: String(file.dir), graph, marks, order });
    epoch.marks += marks.length;
  }

  const logIndex = logs === "none" ? null : buildLogIndex(home);
  const logsRead = { sessions: 0, missing: 0, empty: 0 };

  for (const entry of sessions) {
    // 日志：归档会话的目录名是 `session-<uuid>`，日志索引的键是裸 uuid（T56 的同一条坑）。
    let injection = null;
    if (logIndex !== null) {
      const dirKey = String(entry.dir).toLowerCase();
      const logFile = logIndex.get(dirKey) ?? logIndex.get(dirKey.replace(/^session-/, "")) ?? null;
      if (logFile === null) logsRead.missing += 1;
      else {
        const events = readSessionEvents(logFile);
        if (events.length === 0) logsRead.empty += 1;
        else {
          logsRead.sessions += 1;
          injection = injectionSeqsOf(events);
        }
      }
    }

    for (const [index, mark] of entry.marks.entries()) {
      const resolved = resolveSummaryText(mark, entry.graph?.lastOfflineSummary ?? null);
      const row = markPrediction(entry.graph, mark, {
        index,
        session: entry.dir,
        summaryText: resolved.text,
        order: entry.order,
        injection,
      });
      row.summarySource = resolved.source;
      if (Number.isFinite(toSeq(mark?.seqStart)) && Number.isFinite(toSeq(mark?.seqEnd))) epoch.withRange += 1;
      if (row.summaryAvailable) epoch.withSummary += 1;
      if (row.claim !== null) epoch.withClaim += 1;
      if (row.measurable === true) epoch.measurable += 1;

      // B：**完全复用** T56 的实现（不另发明口径）
      row.b = markRetread(entry.graph, mark, {
        index,
        session: entry.dir,
        window: WINDOWS[0],
        summaryText: resolved.text,
        injection,
      });

      // 判据 ③ 的两个已有指标：A 与 B **各要一份**（两边的可测折痕不是同一批），
      // 所以只要这条折痕在任一侧可测就都算，算完同时写回 `row` 与 `row.b`。
      if ((row.measurable === true || row.b?.measurable === true) && resolved.text !== null && resolved.text !== "") {
        const ids = independentIds(resolved.text).length;
        const placeholders = placeholderCount(resolved.text);
        const share = ids + placeholders === 0 ? null : Math.round((ids / (ids + placeholders)) * 10_000) / 10_000;
        let qualityTotal = null;
        try {
          qualityTotal =
            scoreMark(
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
            ).total ?? null;
        } catch {
          qualityTotal = null;
        }
        row.traceableShare = share;
        row.qualityTotal = qualityTotal;
        row.b.traceableShare = share;
        row.b.qualityTotal = qualityTotal;
      }

      // 分层与「被机械补回过」两个字段 A/B 共用（B 的行是另一个对象，要显式拷过去）
      row.b.summaryRepaired = row.summaryRepaired;
      row.b.hotLedger = row.hotLedger;
      row.b.checkpoint = row.checkpoint;

      // 四格（T56 第 24 轮）：摘要**列了** × 之后**重踩了**
      row.fourCell = fourCellOf(entry.graph, mark, resolved.text);
      rows.push(row);
    }
  }

  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.session).localeCompare(String(b.session)));

  const a = summarizeA(rows);
  const measurableRows = rows.filter((row) => row?.measurable === true);

  const correlationsA = {
    tailGap: correlate(measurableRows, "hitValue", "tailGap"),
    span: correlate(measurableRows, "hitValue", "span"),
    traceableShare: correlate(measurableRows, "hitValue", "traceableShare"),
    qualityTotal: correlate(measurableRows, "hitValue", "qualityTotal"),
  };

  // B 的窗口汇总（`summarizeWindow` 只认 `markRetread` 的行 —— 原样传进去）
  const bRows = rows.map((row) => row.b).filter((row) => row !== null && row !== undefined);
  const bWindow = summarizeWindow(bRows, WINDOWS[0]);
  const bParents = rows.filter((row) => row?.b?.measurable === true);
  const bMeasurable = bParents.map((row) => row.b);
  const correlationsB = {
    tailGap: correlate(bMeasurable, "retreadRate", "tailGap"),
    span: correlate(bMeasurable, "retreadRate", "span"),
    traceableShare: correlate(bMeasurable, "retreadRate", "traceableShare"),
    qualityTotal: correlate(bMeasurable, "retreadRate", "qualityTotal"),
  };
  const attribution = summarizeAttribution(bMeasurable);

  // 全库「注入可得性」：与 T56 的 `injectionCorpus` 同口径（**所有**读过日志的折痕），
  // 用来解释「为什么 A 可验证子集的热清单占比（25%）远低于 T56 报的 63%」——
  // 两者分母不同：可验证子集要求折叠后还有 assistant 动作，天然偏向会话末段的折痕。
  const corpusRows = rows.filter((row) => row.hotLedger === true || row.hotLedger === false);
  const injectionCorpus = {
    marks: corpusRows.length,
    withHotLedger: corpusRows.filter((row) => row.hotLedger === true).length,
    withCheckpoint: corpusRows.filter((row) => row.checkpoint === true).length,
    share: corpusRows.length === 0 ? null : corpusRows.filter((row) => row.hotLedger === true).length / corpusRows.length,
  };

  // 分层：热清单注入（A 是安慰剂，B 是混淆项）
  const known = measurableRows.filter((row) => row.hotLedger === true || row.hotLedger === false);
  const strata = {
    observed: known.length,
    withHotLedger: cellOf(known.filter((row) => row.hotLedger === true)),
    withoutHotLedger: cellOf(known.filter((row) => row.hotLedger === false)),
    checkpoint: cellOf(known.filter((row) => row.checkpoint === true)),
    hotLedgerShare: known.length === 0 ? null : known.filter((row) => row.hotLedger === true).length / known.length,
  };
  const bStrata = (predicate) => {
    const list = bParents.filter(predicate);
    const opportunities = list.reduce((sum, row) => sum + (Number(row.b?.opportunities) || 0), 0);
    const retreads = list.reduce((sum, row) => sum + (Number(row.b?.retreads) || 0), 0);
    return {
      n: list.length,
      opportunities,
      retreads,
      rate: opportunities === 0 || list.length < MIN_CELL ? null : retreads / opportunities,
      insufficient: list.length < MIN_CELL,
    };
  };
  const strataB = {
    withHotLedger: bStrata((row) => row?.hotLedger === true),
    withoutHotLedger: bStrata((row) => row?.hotLedger === false),
  };

  // 四格汇总（只在**摘要正文可解析**的折痕上作数）
  const fourCell = { listedRetread: 0, listedAvoided: 0, unlistedRetread: 0, unlistedAvoided: 0, unknown: 0 };
  for (const row of bParents) {
    const cell = row.fourCell;
    if (cell === null || cell === undefined) continue;
    for (const key of Object.keys(fourCell)) fourCell[key] += Number(cell[key]) || 0;
  }

  // 判据 ④ 的经验对照：摘要**被机械补回过** vs **没补回过**
  const poolOf = (list) => {
    const hits = list.filter((row) => row.hit === true).length;
    return {
      n: list.length,
      hits,
      rate: list.length >= MIN_CELL ? hits / list.length : null,
      insufficient: list.length < MIN_CELL,
    };
  };
  const poolsA = {
    repaired: poolOf(measurableRows.filter((row) => row.summaryRepaired === true)),
    clean: poolOf(measurableRows.filter((row) => row.summaryRepaired !== true)),
  };
  const bPoolOf = (list) => {
    const opportunities = list.reduce((sum, row) => sum + (Number(row.b?.opportunities) || 0), 0);
    const retreads = list.reduce((sum, row) => sum + (Number(row.b?.retreads) || 0), 0);
    return {
      n: list.length,
      opportunities,
      retreads,
      rate: opportunities === 0 || list.length < MIN_CELL ? null : retreads / opportunities,
      insufficient: list.length < MIN_CELL,
    };
  };
  const poolsB = {
    repaired: bPoolOf(bParents.filter((row) => row?.summaryRepaired === true)),
    clean: bPoolOf(bParents.filter((row) => row?.summaryRepaired !== true)),
  };

  // 明细：**全部未命中 + 最近 N 条**。未命中是这份报告里唯一有信息量的行，
  // 只列「最近 20 条」会把 3 条未命中埋在几百条命中里（第一版就是这样，报告看着全绿）。
  const missRows = a.detail.filter((row) => row.hit !== true);
  const recentRows = limit > 0 ? a.detail.slice(-limit) : a.detail;
  const detail = [...new Set([...missRows, ...recentRows])];

  const result = {
    home,
    graphs: epoch.graphs,
    badGraphs: epoch.badGraphs,
    epoch,
    logs: { mode: logs, ...logsRead },
    rows,
    a,
    b: { ...bWindow, attribution },
    bAttribution: attribution,
    fourCell,
    injectionCorpus,
    strata: { ...strata, b: strataB },
    correlationsA,
    correlationsB,
    poolsA,
    poolsB,
    detail,
    bDetail: limit > 0 ? bMeasurable.filter((row) => (Number(row.retreads) || 0) > 0).slice(-limit) : bMeasurable.filter((row) => (Number(row.retreads) || 0) > 0),
  };

  result.criteria = judgeCriteria({
    a: result.a,
    b: result.b,
    correlationsA,
    correlationsB,
    poolsA: {
      repaired: { ...poolsA.repaired, rate: poolsA.repaired.rate },
      clean: { ...poolsA.clean, rate: poolsA.clean.rate },
    },
    poolsB: {
      repaired: { ...poolsB.repaired, rate: poolsB.repaired.rate },
      clean: { ...poolsB.clean, rate: poolsB.clean.rate },
    },
  });

  const aFailed = result.criteria.filter((item) => item.key.startsWith("A") && item.pass === false);
  const bFailed = result.criteria.filter((item) => item.key.startsWith("B") && item.pass === false);
  result.verdict = {
    a: aFailed.length > 0 ? "unusable" : "usable",
    b: bFailed.length > 0 ? "unusable" : "usable",
    aFailed: aFailed.map((item) => item.key),
    bFailed: bFailed.map((item) => item.key),
  };
  return result;
}

/* ───────────────────────────── ⑦ 报告 ───────────────────────────── */

/** 渲染人读报告（返回字符串；CLI 直接 `console.log`）。 */
export function renderReport(result) {
  const out = [];
  const { a, b, epoch, strata, criteria } = result;
  const bAttribution = result.bAttribution ?? b.attribution;

  out.push("停点预测命中率审计（T57 · 只读 · 零模型调用）");
  out.push(`home = ${result.home}`);
  out.push(
    `图 = ${int(result.graphs)} 张（坏图 ${int(result.badGraphs)}）· 折痕 = ${int(epoch.marks)} 条 · ` +
      `有 seq 区间 = ${int(epoch.withRange)} · 摘要正文可解析 = ${int(epoch.withSummary)} · ` +
      `有停点断言 = ${int(epoch.withClaim)} · 可验证 = ${int(a.measurable)}`,
  );
  out.push("");
  out.push(
    `一句话结论：**A 停点命中率 ${result.verdict.a === "usable" ? "能用" : "不能用"}**` +
      `（判据 ${result.verdict.aFailed.length > 0 ? result.verdict.aFailed.join("、") : "全过"} 不过）· ` +
      `**B 重踩率 ${result.verdict.b === "usable" ? "能用" : "不能用"}**` +
      `（判据 ${result.verdict.bFailed.length > 0 ? result.verdict.bFailed.join("、") : "全过"} 不过）`,
  );
  out.push("");

  /* ① 抽取规则与样本量 */
  out.push("## ① 抽取规则（停点断言的闭集）与样本量");
  out.push(`  抽取范围：**只在 \`## ${STOP_SECTION_KEYWORD}\` 段内**（段外出现的 \`n<id>\` 一律不算）。`);
  out.push("  算（闭集，按出现位置取第一个）：");
  for (const pattern of STOP_PATTERNS) out.push(`    · ${pattern.key}`);
  out.push("  不算（逐条计数）：");
  const extraction = a.extraction ?? {};
  const order = [
    "摘要正文不可解析",
    "没有 `## 当前节点` 段",
    "n? 占位（写不出节点）",
    "e? 占位（写的是边）",
    "停在 <散文>（段内没有具体节点 id）",
    "claim",
  ];
  const seen = new Set(order);
  for (const key of order) {
    if (extraction[key] === undefined) continue;
    out.push(`    · ${padDisplay(key, 42)}${int(extraction[key])} 条`);
  }
  for (const [key, count] of Object.entries(extraction)) {
    if (seen.has(key)) continue;
    out.push(`    · ${padDisplay(key, 42)}${int(count)} 条`);
  }
  out.push(
    `  边界：\`n1\` 不匹配 \`n12\`（\`(?![0-9])\`）· \`e\\d+\` 是边不是节点 · 段标题本身不算 · ` +
      `同一段里出现多个不同 id 时报告 \`conflicts\`（本批 ${int(a.detail.filter((row) => row.conflicts === true).length)} 条）。`,
  );
  out.push(
    `  样本量：可解析摘要 ${int(epoch.withSummary)} 条 → **有停点断言 ${int(a.claims)} 条**` +
      `（占 ${pct(epoch.withSummary === 0 ? null : a.claims / epoch.withSummary)}）；` +
      `其中**可验证 ${int(a.measurable)} 条**（右删失 ${int(a.censored)} · 被人打断 ${int(a.superseded)} · 无 via ${int(a.noVia)}）。`,
  );
  out.push(
    `  ⚠ 被排除的 ${int(a.claims - a.measurable)} 条不是「没数据」，是**没有后续**可验 —— ` +
      `它们**不计入分母、也不记 0**（\`Number(null) === 0\` 是本仓踩过的坑）。`,
  );
  out.push("");

  /* ② A 命中率 */
  out.push("## ② A 停点命中率（正向证据）");
  out.push(
    `  **A = ${pct(a.rate)}**（${int(a.hits)} / ${int(a.measurable)}）` +
      (a.rate === null ? `　⚠ 样本不足 ${MIN_CELL} 条，**不硬算率**` : ""),
  );
  out.push(`  分解（三半，缺一不可）：`);
  out.push(`    · 定位：摘要写的节点在图中存在 —— ${pct(a.existsShare)}`);
  out.push(`    · 复制：摘要写的 = 折叠区间**末**节点 —— ${pct(a.copyShare)}`);
  out.push(`    · 承接：折叠后第一条 assistant 动作的 \`via.from\` = 摘要写的节点 —— ${pct(a.continueShare)}（**= A 本身，定义即此**）`);
  out.push(
    `    ⇒ 真正有信息的是**复制 − 承接** = ${pct(a.copyShare === null || a.continueShare === null ? null : a.copyShare - a.continueShare)}：` +
      `抄对了末节点、但图把下一个动作重父化（\`via.from\` 不是上一节点）的比例。`,
  );
  out.push(
    `  ⚠ **结构基线**：\`via.from === 折叠区间末节点\` 的比例 = ${pct(a.structuralBaseline)}。` +
      `这一格越接近 100%，「承接」就越**不可能失败** —— A 也就越接近「复制准确率」，而不是「预测」。`,
  );
  out.push(
    `  ⚠ **选择偏差（敏感性口径）**：把 \`停在 n?\` 等被排除的 ${int(a.claims - a.measurable)} 条按 **miss** 计入 ⇒ ` +
      `${pct(a.rateSensitivity)}（${int(a.hits)} / ${int(a.claims)}）。**两种分母口径都 > ${pct(CRITERIA_RULES.maxConstantShare, 0)}** —— ` +
      `所以判据 ① 的结论**不依赖**分母怎么选。`,
  );
  out.push(
    `  取值分布（判据 ①）：命中 ${int(a.hits)} · 未命中 ${int(a.misses)} · 众数占比 ${pct(a.modalShare)}`,
  );
  if (result.detail.length > 0) {
    out.push(`  明细（最近 ${result.detail.length} 条可验证折痕）：`);
    out.push(
      `    ${padDisplay("会话", 10)}${padDisplay("折痕", 6, "right")}${padDisplay("摘要说停在", 14, "right")}` +
        `${padDisplay("实际承接自", 14, "right")}${padDisplay("末节点", 10, "right")}${padDisplay("结果", 8, "right")}`,
    );
    for (const row of result.detail) {
      out.push(
        `    ${padDisplay(shortSession(row.session), 10)}${padDisplay(int(row.index), 6, "right")}` +
          `${padDisplay(row.claim ?? "—", 14, "right")}${padDisplay(row.viaFrom ?? "—", 14, "right")}` +
          `${padDisplay(row.lastFolded ?? "—", 10, "right")}  ${padDisplay(row.hit ? "✓ 命中" : "✗ 未命中", 9, "left")}`,
      );
    }
  }
  out.push("");

  /* ③ B 重踩率 */
  out.push("## ③ B 死路重踩率（反向证据 · 三档口径，与 T56 同源）");
  out.push(
    `  可重踩机会（去重死路签名）= ${int(b.opportunities)}　重踩 = ${int(b.retreads)}　` +
      `**严格口径 = ${pct(b.rate)}**　（可测折痕 n=${int(b.n)}）`,
  );
  out.push(
    `  三档：严格口径 ${pct(b.rate)}（${int(b.retreads)} 条）· 宽松上界 ${pct(b.rateLoose)}（${int(b.retreadsLoose)} 条）· ` +
      `纯 sig 下界 ${int(bAttribution.strict?.sigOnly ?? 0)} 条`,
  );
  out.push(
    `  折痕级：众数 = ${num(b.modalValue)}（占 ${pct(b.modalShare)}）· = 0 占 ${pct(b.zeroShare)} · ` +
      `直方图 ${RATE_BANDS.map((band) => `${band.key}=${int(b.histogram?.[band.key])}`).join(" · ")}`,
  );
  const strict = bAttribution.strict ?? {};
  const four = result.fourCell ?? { listedRetread: 0, listedAvoided: 0, unlistedRetread: 0, unlistedAvoided: 0, unknown: 0 };
  const fourTotal = four.listedRetread + four.listedAvoided + four.unlistedRetread + four.unlistedAvoided + four.unknown;
  out.push(
    `  **四格**（T56 第 24 轮的教训：正向证据是「列了且避开了」，不是「没重踩」）—— ` +
      `只在摘要正文可解析的折痕上作数（死路合计 ${int(fourTotal)} 条；正文取不到的折痕**整条排除**，不记 0）：`,
  );
  out.push(
    `    · 摘要**列了** ${int(four.listedRetread + four.listedAvoided)} 条 → 之后重踩 ${int(four.listedRetread)} 条（警告无效）· ` +
      `之后避开 ${int(four.listedAvoided)} 条（✅ 正向证据）`,
  );
  out.push(
    `    · 摘要**没列** ${int(four.unlistedRetread + four.unlistedAvoided)} 条 → 之后重踩 ${int(four.unlistedRetread)} 条 · ` +
      `之后避开 ${int(four.unlistedAvoided)} 条（无信息）`,
  );
  out.push(`    · 写没写**不可判** ${int(four.unknown)} 条（摘要正文取不到）`);
  out.push(
    `  归因：严格口径重踩 ${int(strict.retreads ?? 0)} 条，其中**冤枉**（注入不可证）${int(strict.exonerated ?? 0)} 条 · ` +
      `能记在摘要头上 ${int(strict.blamed ?? 0)} 条`,
  );
  out.push("");

  /* ④ 分层 */
  out.push("## ④ 分层：热清单注入（因果可识别性）");
  if (result.logs.mode === "none") {
    out.push("  **未读日志**（--no-logs）—— 分层维度整体记「未观测」，不做因果推断。");
  } else {
    out.push(
      `  可分层折痕 ${int(strata.observed)} 条（日志：读到 ${int(result.logs.sessions)} · 缺 ${int(result.logs.missing)} · 空 ${int(result.logs.empty)}）；` +
        `折叠后有 \`chess-context\` 热清单注入 **${pct(strata.hotLedgerShare)}**。`,
    );
    if (result.injectionCorpus !== null && result.injectionCorpus !== undefined) {
      out.push(
        `    （全库口径，与 T56 对齐：${int(result.injectionCorpus.withHotLedger)} / ${int(result.injectionCorpus.marks)} = ` +
          `${pct(result.injectionCorpus.share)} —— 比这里的 ${pct(strata.hotLedgerShare)} 高，因为「可验证」要求折叠后**还有 assistant 动作**，` +
          `天然偏向会话末段的折痕。两个分母都列出来，别拿一个去对另一个。）`,
      );
    }
    const cellLine = (label, cell) =>
      `    · ${padDisplay(label, 22)}n=${padDisplay(int(cell.measurable), 4, "right")}　` +
        `A 命中 ${padDisplay(int(cell.hits), 4, "right")}　**A = ${padDisplay(pct(cell.rate), 9, "right")}**` +
        (cell.insufficient ? "　⚠ 样本不足 10 条，不算率" : "");
    out.push(cellLine("有热清单注入", strata.withHotLedger));
    out.push(cellLine("无热清单注入", strata.withoutHotLedger));
    out.push(`    · ${padDisplay("compact-checkpoint", 22)}n=${int(strata.checkpoint.measurable)}　A = ${pct(strata.checkpoint.rate)}`);
    out.push(
      `  **对 A 这一层是安慰剂，不是混淆项**：A 的分子是「摘要写的 id vs 图里的 \`via.from\`」，` +
        `与模型看没看到热清单**无关** ⇒ 两格率应当一致；不一致就说明抽取有 bug。`,
    );
    out.push(
      `  **对 B 这一层是混淆项**：热清单逐条列着失败边 —— 死路信息**不是只有摘要一条通路**。`,
    );
    const bCell = (label, cell) =>
      `    · ${padDisplay(label, 22)}n=${padDisplay(int(cell.n), 4, "right")}　机会 ${padDisplay(int(cell.opportunities), 6, "right")}　` +
        `重踩 ${padDisplay(int(cell.retreads), 3, "right")}　**B = ${padDisplay(pct(cell.rate), 9, "right")}**` +
        (cell.insufficient ? "　⚠ 样本不足 10 条，不算率" : "");
    out.push(bCell("有热清单注入", strata.b.withHotLedger));
    out.push(bCell("无热清单注入", strata.b.withoutHotLedger));
  }
  out.push("");

  /* ⑤ 四条判据 */
  out.push("## ⑤ 四条判据（A 与 B 各算一遍，门槛同一套）");
  for (const item of criteria) {
    const mark = item.pass === null ? "？不可判" : item.pass ? "✓ 通过" : "✗ **不通过**";
    const extra = item.degenerate && item.pass ? "　⚠ **退化通过**（无方差，ρ 不可信，不构成支持）" : "";
    out.push(`  判据 ${item.key} ${item.name}：${mark}${extra}`);
    out.push(`    ${item.detail}`);
  }
  out.push("");

  /* ⑥ 结论 */
  out.push("## ⑥ 能不能用");
  out.push(`  **A：${result.verdict.a === "usable" ? "能用" : "不能用"}**`);
  if (result.verdict.a !== "usable") {
    out.push(
      `    · 判据 ${result.verdict.aFailed.join("、")} 不过：A 的众数占比 ${pct(a.modalShare)} ≫ ` +
        `${pct(CRITERIA_RULES.maxConstantShare, 0)}，是**常函数**。`,
    );
    out.push(
      `    · 根因不是数据，是**构造**：\`via.from === 折叠区间末节点\` 本身就有 ${pct(a.structuralBaseline)} —— ` +
        `「承接」这一半**结构上几乎不可能失败**，A 量到的是**复制准确率**，不是预测。`,
    );
    out.push(
      `    · 它属于今晚总结里的**第①类「不变量」**（必须 = 1，红了就是破了），不是**质量指标** —— ` +
        `不变量没有方差，不能当金标准用。`,
    );
  }
  out.push(`  **B：${result.verdict.b === "usable" ? "能用" : "不能用"}**（T56 已判死，本脚本只复核三档口径）`);
  out.push("");

  /* ⑦ 如果 A 命中率高，它是不是今晚第一个站得住的指标 */
  out.push("## ⑦ 如果 A 命中率高，它是不是今晚第一个站得住的指标");
  out.push(
    a.rate !== null && a.rate >= 0.9
      ? `  命中率 ${pct(a.rate)} 看着漂亮，但**不是**。理由三条，都能从上面的数字里读出来：`
      : `  命中率 ${pct(a.rate)} —— 连「高」都谈不上，问题更直接。理由：`,
  );
  out.push(
    `  1. **它是恒等式的重述**：结构基线 ${pct(a.structuralBaseline)}（\`via.from\` 就是折叠区间末节点）` +
      `⇒ 「从 nX 继续」在图上**没有第二个可能**。命中率高不是摘要准，是图**只有一条链**。`,
  );
  out.push(
    `  2. **判据 ① 结构性不过**：众数占比 ${pct(a.modalShare)} ≫ ${pct(CRITERIA_RULES.maxConstantShare, 0)}。` +
      `常函数与 T53 判死的 \`区间保真度 A\`（85.6% 恒等于 1.0）、T55 的 \`failureRecall\`（众数 97.3%）**同一种死法**。`,
  );
  out.push(
    `  3. **它度量的是「摘要抄对没抄对最后一个节点」**：\`## 棋谱（状态节点）\` 段里逐行就是 \`- n<id> …\`，` +
      `最后一个 id 是**最后一行**。把它抄进「当前节点」是一次**复制**，不是一次**判断**。`,
  );
  out.push(
    `  ⇒ 诚实回答：**A 不是今晚第一个站得住的指标**。它站得住的部分只有一条 —— ` +
      `**「摘要的停点字段与图一致」是一个可用的不变量**（失败 = 摘要陈旧，值得报警），` +
      `但它没有方差，不能区分好摘要和差摘要。`,
  );
  out.push(
    `  按本仓自己的三分类（\`docs/knowledge/进度.md\` 第 22 轮）：A 属于**②「缺陷探针」**，不是**③「代理分」** —— ` +
      `**抓得到坏，量不出好**。那 ${int(a.misses)} 条未命中（${int(a.misses)} 条里：差一个节点的陈旧 ${int(
        a.detail.filter((row) => row.hit !== true && row.isLast === false).length,
      )} 条 · 图把动作重父化的 ${int(a.detail.filter((row) => row.hit !== true && row.isLast === true).length)} 条）` +
      `是真问题，值得单独看；但「命中」那一格是基线，不是质量。`,
  );
  out.push(
    `  **能用的形态**：把它当**报警器**（命中率 < 95% 就说明摘要在系统性陈旧），而不是当**评分**。` +
      `这与 T51–T56 判死的五个指标不冲突 —— 它们死在「想量质量」，A 死在**同一个地方**，只是诚实地说出来了。`,
  );
  out.push("");

  /* ⑧ 复现 */
  out.push("## ⑧ 复现");
  out.push("  node scripts/prediction-hit-audit.mjs            # 本报告");
  out.push("  node scripts/prediction-hit-audit.mjs --json   # 机读（测试用）");
  out.push("  node test/run.mjs prediction-hit               # 守卫");
  return out.join("\n");
}

/* ───────────────────────────── 入口 ───────────────────────────── */

function parseArgs(argv) {
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
  const result = audit({
    home: args.home ?? resolveHome(),
    limit: args.limit,
    session: args.session,
    logs: args.logs,
  });
  if (result.graphs === 0) {
    console.error(`✗ 一张图都读不到：${result.home}（home 给错了？）`);
    process.exit(2);
  }
  if (args.json) console.log(JSON.stringify(result, (key, value) => (key === "rows" ? undefined : value), 1));
  else console.log(renderReport(result));
}
