#!/usr/bin/env node
/**
 * archive-quadrant-audit.mjs —— **归档时刻四格审计**（T57 · 只读 · 零模型调用）
 *
 * ── 它是来收拾 T56 的两个残局的 ────────────────────────────────────────────────
 * T56（`scripts/retread-audit.mjs`）判死了「重踩率」，留下两条能救命的线索：
 *   ① **因果不可识别**：63.18% 的折痕之后注入过 `chess-context` 热清单（逐条列着同样的失败边），
 *      39.88% 有 `compact-checkpoint` ⇒ 死路信息**不止摘要一条通路**，重踩为 0 说不清是谁的功劳；
 *   ② **口径是下界**：严格口径要求 action 签名**逐字相同**，模型改一个字符就看不见 ——
 *      而「换个写法重试同一条死路」恰恰是最常见的重蹈覆辙。
 *
 * 本脚本按 Lead 的两条改造重做这件事：
 *
 *   **改造 A · 观测点移到归档时刻（closeout）**
 *     不是「折叠后 N 轮」而是**归档时冻结**：折叠时未来未知（只能问「像不像」），
 *     归档时全轨迹已知（能问「有没有用」）。
 *     口径：`观测窗 = (fold.seqEnd, archiveSeq]`，`archiveSeq` = 归档快照里最后一条事件的 seq。
 *     **只有归档过的会话才进样本** —— 活会话的「未来」还在写，那是右删失，不是观测。
 *
 *   **改造 B · 只用没有热清单注入的折痕（天然对照组）**
 *     分层 = 折叠之后、归档之前有没有 `chess-context` 注入。**两层分开算，绝不合并**：
 *     混在一起就是 T56 那个「因果不可识别」。合并只允许出现在一句结论里，且要写明是池化值。
 *
 * ── 四格（Lead 的表） ─────────────────────────────────────────────────────────
 *   |                      | 归档前重踩了       | 归档时确认避开        |
 *   | 摘要列了这条死路     | 警告无效（可能没看）| ✅ **摘要有效的正向证据** |
 *   | 摘要没列             | 漏写               | （无信息 · 基线）      |
 *
 *   · **精确率** = `避开 / 列了`      —— 「列了的里面有多少真的有用」
 *   · **召回率** = `列了 / 避开`      —— 「有用的里面有多少被列到了」
 *   · 两者都接近 1 时**没有信息量**：单看精确率会把「列了也没用」读成「很准」。
 *     真正回答「摘要有用吗」的是**反事实**：`避开率(列了) − 避开率(没列)`，附 Fisher 精确检验。
 *
 * ── 两条口径（分列，不合并） ───────────────────────────────────────────────────
 *   **口径 P（前瞻性 · 记录）**：`trigger ∉ {archive-offline, ""}` 的活折痕。
 *     摘要先于尾部存在 ⇒ 因果上唯一站得住的一条。治疗变量取 `foldMark.quality.missingFailures`
 *     （折叠**当时**在最终正文上算的「模型漏写了哪些 id」）。
 *     ⚠ `missingFailures` 只留前 10 条（`measureFoldQuality` 的 `slice(0, 10)`）：
 *       清单满 10 条时「不在清单里」**不等于**「写了」⇒ 记 `unknown`，不拿它冒充 `listed`。
 *
 *   **口径 R（回溯性 · 正文）**：`trigger === "archive-offline"` 的补折。
 *     摘要是**在归档时**从它自己那段区间生成出来的（`runOfflineFold` 在归档路径上跑）——
 *     它**不可能**影响它之前的轨迹 ⇒ **因果结构性无效**，只能做描述统计。
 *     治疗变量取摘要正文，并且**必须剥掉机械补回段**（见下）。
 *
 *   为什么口径 R 还要算：它是现在**唯一有正文**的一条路（`summaryText` 落盘率 0 / 1152），
 *   不给它数字，「四格到底长什么样」就没人见过。但它一条结论都担不起 —— 报告里逐处标注。
 *
 * ── ★ 治疗变量被修复函数污染（本脚本最重要的发现之一） ──────────────────────────
 *   `repairFailuresInText` / `repairMissingFailures`（`src/rooms/offline-fold.mjs`）会把模型
 *   漏掉的死路**逐条机械追加**到摘要尾部的 `## 已探明死路（逐字补充 · 机械补回，不许重试）` 段。
 *   于是对**最终正文**算 `mentionsEdge` 在补回跑过之后**恒 = 1**（`failureRecall ≡ 1`）——
 *   「摘要列了这条死路」会从「模型的观察」退化成「补回函数的输出」。
 *   这直接踩穿判据 ④（分子不是修复函数的输出）的**镜像**：那条只盯分子，本脚本连**行**一起盯。
 *   ⇒ 切分点复用 `deadend-adherence-audit.mjs` 的 `splitModelText`（**只留一份**，两个审计器同源）。
 *
 * ── 三档重踩判据（T56 的严格口径是下界） ────────────────────────────────────────
 *   T1 **逐字相同**（严格 / 下界）：`sig:` 优先，老边回落 `act:actionSignature(action, {})`。
 *      含义：同一个工具、**完整参数**逐字相同地又失败一次。
 *      误判风险：**只会少算** —— 改一个字符（换 cwd / 加参数 / 改引号）就看不见；
 *      且老边回落只取 actionSummary 的 2 个参数 ⇒ 同一文件的不同编辑会被当成同一条。
 *   T2 **同工具 + 参数前缀**（中档）：工具名相同，且参数串的公共前缀 ≥ `PREFIX_MIN` 字符。
 *      含义：又打到了**同一个目标/目录**上（换了个文件名，但显然是同一处死路）。
 *      误判风险：**会多算** —— 同一个目录下两个不相关的文件也会命中；参数越短越容易误伤。
 *   T3 **同工具 + 同错误类**（宽松 / 上界）：工具名相同，且错误串归一化后同类。
 *      含义：同一个工具**又栽在同一类错误**上（哪怕换了目标）。
 *      误判风险：**大量假阳** —— `read` / `edit` / `bash` 就三个工具，「同工具」几乎免费；
 *      错误类把「ENOENT 于 A」和「ENOENT 于 B」并成一条，那不是重踩，只是同一个坑有多个入口。
 *   ⇒ 三档**不是嵌套包含关系**（T1 的边不一定满足 T2 的前缀长度，T3 的边也未必逐字相同）。
 *     结论必须写明「哪一档下成立」；只报一档 = 换个数就换结论。
 *
 * ── 四条判据（与 T52–T56 同一套数字） ───────────────────────────────────────────
 *   ① 有方差：结果变量（重踩/避开）的众数占比 < 80%（两层各算，取最差那层）；
 *   ② 与形状无关：|ρ(离归档距离)| < 0.2 且 |ρ(折痕跨度)| < 0.2；
 *   ③ 与已有指标不同：|ρ(可定位率)| < 0.8 且 |ρ(T33 分)| < 0.8；
 *   ④ 分子不是修复函数的输出：分子（重踩）是 `settleEdge` 写的边 —— 设计保证；
 *      **行（listed）是不是修复函数的输出** —— 本脚本新增的一问，经验值 + 设计值都给。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` / `*.zstd` 只 `readFileSync`；一个字节都不写；
 *   · 不改 `src/**`、不调模型、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · 判据必须能返回「不通过」（否则是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/archive-quadrant-audit.mjs                 # 全量
 *   node scripts/archive-quadrant-audit.mjs --no-logs       # 不读日志（分层记「未观测」）
 *   node scripts/archive-quadrant-audit.mjs --json          # 机读（测试用）
 *   node scripts/archive-quadrant-audit.mjs --home <dir>     # 换 DSH_HOME
 *   node scripts/archive-quadrant-audit.mjs --session <前缀> # 只看某个会话
 *   node scripts/archive-quadrant-audit.mjs --limit=20       # 明细列最近 N 条重踩
 *
 * 退出码：0 = 审计跑完（无论结论）；2 = 一张图都读不到（home 给错了）。
 */
import nodePath from "node:path";
import os from "node:os";

import { collectGraphFiles } from "../src/ui.mjs";
import { evidenceSpan, failureEdges } from "../src/rooms/kifu-model.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
import { isDanglingResidue } from "../src/rooms/ledger.mjs";
import { actionSignature } from "../src/rooms/keeper.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { buildLogIndex, correlate, independentIds, placeholderCount, quantile } from "./range-fidelity-audit.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { measureSample, resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";
// ★ 切分点只留一份：机械补回段的标题由 `deadend-adherence-audit.mjs` 定义，
//   本脚本 import 它 —— 两处各写一个字符串，哪天标题改了就会静默分叉（C300 的老账）。
import { splitModelText } from "./deadend-adherence-audit.mjs";
import { padDisplay } from "./retread-audit.mjs";

/* ───────────────────────────── 口径常量（改口径只改这里） ───────────────────────────── */

/** 判据门槛（与 T52–T56 同一套数字）。 */
export const CRITERIA_RULES = Object.freeze({
  /** ① 某一取值占比超过这个数就叫「恒等」（常函数，没有信息量）。 */
  maxConstantShare: 0.8,
  /** ② |ρ| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** ③ 与已有指标 ρ 高于这个数就算「同一个东西」。 */
  maxRhoRedundant: 0.8,
});

/** 四格的最小可下结论样本量（任一格 < 它 ⇒ 只报数、不报率）。 */
export const MIN_CELL = 10;

/**
 * 治疗变量的常函数门槛。
 *
 * 为什么单列：①只查**结果**有没有方差。但四格矩阵要估的是**行**的效应 ——
 * 行若是 98% 一个值（模型几乎必列），就**没有对照组**，效应不可识别。
 * 这不是「判据 ① 通过」能救的（T56 就是在这里被判死的，只是当时看的是结果）。
 */
export const MAX_TREATMENT_SHARE = 0.95;

/** T2 的参数公共前缀门槛（字符）。12 能区分「同目录不同文件」与「同文件不同参数」。 */
export const PREFIX_MIN = 12;

/** 观测窗口的分档（固定，输出与测试都按它）。 */
export const OUTCOME_BANDS = Object.freeze([
  { key: "= 0", test: (v) => v === 0 },
  { key: "0–0.2", test: (v) => v > 0 && v < 0.2 },
  { key: "0.2–0.5", test: (v) => v >= 0.2 && v < 0.5 },
  { key: "0.5–1.0", test: (v) => v >= 0.5 && v < 1 },
  { key: "= 1.0", test: (v) => v >= 1 },
]);

/**
 * 三档重踩判据。顺序 = 报告顺序 = 从严到松。
 * `meaning` / `risk` 直接进报告 —— 换档不换说明，等于让人拿错档还在读对的结论。
 */
export const TIERS = Object.freeze([
  {
    key: "T1",
    label: "逐字相同（严格 · 下界）",
    meaning: "同一个工具、**完整参数逐字相同**地又失败了一次（`sig:` 优先，老边回落 actionSummary）。",
    risk: "**只会少算**：模型改一个字符（换 cwd、加参数、改引号、换个写法）就看不见；老边没有 `sig`，回落只取 2 个参数 ⇒ 同一文件的不同编辑会被并成一条。",
  },
  {
    key: "T2",
    label: "同工具 + 参数前缀（中档）",
    meaning: `工具名相同，且参数串公共前缀 ≥ ${PREFIX_MIN} 字符（又打到了同一个目标/目录上）。`,
    risk: "**会多算**：同一个目录下两个不相关的文件也会命中；参数越短越容易误伤（纯文件名相同就能凑够前缀）。",
  },
  {
    key: "T3",
    label: "同工具 + 同错误类（宽松 · 上界）",
    meaning: "工具名相同，且错误串归一化后属于同一类（又栽在同一类错误上，哪怕换了目标）。",
    risk: "**大量假阳**：全库就 `read`/`edit`/`bash` 几个工具，「同工具」几乎免费；错误类把「ENOENT 于 A」与「ENOENT 于 B」并成一条 —— 那不是重踩，是同一个坑有多个入口。",
  },
]);

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/**
 * 两条口径。`prospective` 决定因果能不能用；`treatment` 决定从哪取「列没列」。
 * 顺序即报告顺序（P 在前 —— 它是唯一站得住的那条）。
 */
export const ACCOUNTS = Object.freeze([
  {
    key: "P",
    label: "口径 P · 前瞻性（记录）",
    treatment: "record",
    prospective: true,
    causal: "摘要先于尾部存在 ⇒ 因果成立；但治疗变量来自记录（`quality.missingFailures`），受 10 条截断影响。",
  },
  {
    key: "R",
    label: "口径 R · 回溯性（正文）",
    treatment: "text",
    prospective: false,
    causal: "**因果结构性无效**：摘要在归档时从它自己的区间生成，不可能影响它之前的轨迹。只做描述统计。",
  },
]);

/** 分层：热清单注入 / 无热清单注入。`unobserved` 是第三态，绝不是「无」。 */
export const STRATA = Object.freeze([
  { key: "hot", label: "有热清单注入（chess-context）" },
  { key: "cold", label: "无热清单注入（天然对照组）" },
]);

/* ───────────────────────────────── 小工具 ───────────────────────────────── */

const round = (value, digits = 6) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const pct = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : `${(Number(value) * 100).toFixed(digits)}%`;
const int = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "—");
const num = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
const pp = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(2)}pp`;
/** 会话短名：目录名截前 8 位（`session-` 前缀先剥掉，否则只剩 `session-`）。 */
const shortSession = (dir) => {
  const body = String(dir ?? "");
  const stripped = body.replace(/^session-/, "");
  return `${body.startsWith("session-") ? "s-" : ""}${stripped.slice(0, 8)}`;
};

/** 与 doctor / graph-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/* ───────────────────────── ① 治疗变量：列没列（两个来源） ───────────────────────── */

/**
 * **正文口径**：剥掉机械补回段之后，模型自己在正文里点名了这条边吗？
 *
 * 返回 `via` 三态，**不许并成两态**：
 *   · `model`   —— 模型自己写了（正向证据）；
 *   · `repair`  —— 只有机械补回段写了（**不能算模型的功劳**）；
 *   · `absent`  —— 两处都没有（真漏写）。
 *
 * @param {string|null} summaryText 摘要正文（`null` = 取不到 ⇒ 不可判）
 * @param {string} edgeId 死路 id
 * @returns {{listed:boolean|null, via:"model"|"repair"|"absent"|"unreadable"}}
 */
export function treatmentFromText(summaryText, edgeId) {
  if (typeof summaryText !== "string" || summaryText === "") return { listed: null, via: "unreadable" };
  const { modelText, repairText, hasRepairSection } = splitModelText(summaryText);
  if (mentionsEdge(modelText, edgeId)) return { listed: true, via: "model" };
  if (hasRepairSection && mentionsEdge(repairText, edgeId)) return { listed: false, via: "repair" };
  return { listed: false, via: "absent" };
}

/**
 * **记录口径**：折叠当时算出来的 `quality.missingFailures` 里有没有这条边。
 *
 * 为什么满 10 条就记 `unknown`：`measureFoldQuality` 返回 `missingFailures.slice(0, 10)`
 * —— 清单被截断时，「不在清单里」既可能是写了、也可能是排在第 11 条。
 * 拿它冒充 `listed` 会**系统性高估遵守率**（正是 `deadend-adherence-audit` 反复警告的那条假绿）。
 *
 * @param {object} mark foldMark
 * @param {string} edgeId
 * @returns {{listed:boolean|null, via:string}}
 */
export function treatmentFromRecord(mark, edgeId) {
  const quality = mark?.quality;
  if (quality === null || quality === undefined || typeof quality !== "object") {
    return { listed: null, via: "unrecorded" };
  }
  const missing = Array.isArray(quality.missingFailures) ? quality.missingFailures.map(String) : null;
  if (missing === null) return { listed: null, via: "unrecorded" };
  const id = String(edgeId ?? "");
  if (missing.includes(id)) return { listed: false, via: "record-missing" };
  if (missing.length >= 10) return { listed: null, via: "record-truncated" };
  return { listed: true, via: "record-listed" };
}

/** 按口径取治疗变量（唯一分派点 —— 别在别处再写一次 if）。 */
export function treatmentOf({ account, mark, summaryText, edgeId }) {
  return account?.treatment === "text"
    ? treatmentFromText(summaryText, edgeId)
    : treatmentFromRecord(mark, edgeId);
}

/* ───────────────────────── ② action 签名 / 三档判据 ───────────────────────── */

/**
 * **严格键**：`sig:` 优先，老边回落 `act:actionSignature(action, {})`。
 *
 * 两个世代**永不相等**（前缀不同）：老边的参数全文已经丢了，拿它去和新边的指纹比，
 * 比出来的不是「同一动作」。代价是少算 —— 本指标的死法是「假绿」，不是「假红」。
 *
 * @param {object} edge
 * @returns {string}
 */
export function signatureKeyOf(edge) {
  const sig = typeof edge?.sig === "string" ? edge.sig.trim() : "";
  if (sig !== "") return `sig:${sig}`;
  return `act:${actionSignature(String(edge?.action ?? ""), {})}`;
}

/** `edit(file_path=x)` → `edit`；没有括号就是整串。 */
export function toolOfAction(action) {
  const body = String(action ?? "");
  const at = body.indexOf("(");
  return (at < 0 ? body : body.slice(0, at)).trim();
}

/** `edit(file_path=x)` → `file_path=x`；没有括号就是空串。 */
export function argsOfAction(action) {
  const body = String(action ?? "");
  const at = body.indexOf("(");
  if (at < 0) return "";
  const close = body.lastIndexOf(")");
  return (close <= at ? body.slice(at + 1) : body.slice(at + 1, close)).replace(/\s+/g, " ").trim();
}

/** 两个串的公共前缀长度（逐字符，不做规范化之外的任何猜测）。 */
export function commonPrefixLen(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && left[i] === right[i]) i += 1;
  return i;
}

/**
 * 错误类归一化（**闭集**，只认这些类；认不出就退回「归一化后的前 60 字符」）。
 *
 * 为什么不做语义聚类：错误类一旦靠「像不像」判断，就成了模型输出的一部分；
 * 这里的每一类都是**字面量**，改一个类就是改口径，看得见。
 *
 * @param {string} snippet
 * @returns {string}
 */
export function errorClassOf(snippet) {
  const text = String(snippet ?? "").toLowerCase();
  if (/eacces|eperm|permission denied|权限不足|access denied/.test(text)) return "permission";
  if (/enoent|not found|no such file|不存在/.test(text)) return "missing";
  if (/etimedout|timeout|timed out|超时/.test(text)) return "timeout";
  if (/econnrefused|connection refused|连接被拒/.test(text)) return "refused";
  const exit = text.match(/exit(?:ed)? (?:with )?(?:code )?(\d+)/);
  if (exit !== null) return `exit-${exit[1]}`;
  return (
    text
      // Windows 盘符路径 与 POSIX 路径**都**归一 —— 只认一种，跨平台的同类错误会被拆成两类。
      .replace(/[a-z]:[\\/][^\s"')]+/g, "<path>")
      .replace(/(?:\/[^\s:()"'*?<>]+)+/g, "<path>")
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "empty"
  );
}

/**
 * 一条**折叠后**的失败边算不算重踩了某条死路（三档）。
 *
 * @param {string} tierKey `T1` | `T2` | `T3`
 * @param {object} dead 折叠区间内的死路
 * @param {object} post 折叠后、归档前的失败边
 * @returns {boolean}
 */
export function tierHit(tierKey, dead, post) {
  if (dead === null || typeof dead !== "object" || post === null || typeof post !== "object") return false;
  if (tierKey === "T1") return signatureKeyOf(post) === signatureKeyOf(dead);
  const sameTool = toolOfAction(post.action) === toolOfAction(dead.action);
  if (!sameTool) return false;
  if (tierKey === "T2") return commonPrefixLen(argsOfAction(post.action), argsOfAction(dead.action)) >= PREFIX_MIN;
  if (tierKey === "T3") return errorClassOf(post.errorSnippet) === errorClassOf(dead.errorSnippet);
  return false;
}

/* ───────────────────────── ③ 图上的位置（归档时刻） ───────────────────────── */

/** 图里最大的 seq（节点 seq + 边 evidence 的起止）—— 归档快照的「会话最后一条事件」。 */
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

/** 图里所有实体的 seq（判「窗口内还有没有后续事件」用）。 */
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

/**
 * 归档观测点。**改造 A 的闸门就在这里**。
 *
 * `archived` 为假 ⇒ 会话还在写，「未来」随时会变 ⇒ 右删失，不进样本
 * （T56 把所有会话都算进去，等于把「还没发生」当成「没发生」）。
 *
 * @param {object} graph
 * @returns {{archived:boolean, archiveSeq:number, why:string}}
 */
export function archivePointOf(graph) {
  const closeout = graph?.closeout;
  const archived = closeout !== null && closeout !== undefined && typeof closeout === "object";
  const archiveSeq = graphMaxSeqOf(graph);
  if (!archived) return { archived: false, archiveSeq, why: "会话未归档（未来未知 ⇒ 右删失）" };
  if (!(archiveSeq > 0)) return { archived: false, archiveSeq, why: "归档快照里没有任何有位置的实体" };
  return { archived: true, archiveSeq, why: "" };
}

/**
 * 一条折痕的归档观测窗。
 *
 * @param {object} graph
 * @param {object} mark
 * @param {{archived?:boolean, archiveSeq?:number, entities?:number[]}} [ctx]
 * @returns {{filable:boolean, lo:number|null, hi:number|null, archiveSeq:number, why:string,
 *   tailGap:number|null, span:number|null}}
 */
export function archiveWindowOf(graph, mark, ctx = {}) {
  const archiveSeq = Number.isFinite(Number(ctx.archiveSeq)) ? Number(ctx.archiveSeq) : graphMaxSeqOf(graph);
  const rawStart = Number(mark?.seqStart);
  const rawEnd = Number(mark?.seqEnd);
  const row = {
    filable: false,
    lo: null,
    hi: null,
    archiveSeq,
    why: "",
    tailGap: null,
    span: null,
  };
  // ★ 改造 A 的闸门**长在这里**，不在调用方：谁调这个函数都绕不过「未归档不许进样本」。
  if (ctx.archived === false) {
    row.why = "会话未归档（未来未知 ⇒ 右删失）";
    return row;
  }
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    row.why = "seq 区间缺失";
    return row;
  }
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);
  row.lo = lo;
  row.hi = hi;
  row.tailGap = archiveSeq - hi;
  row.span = Math.abs(rawEnd - rawStart) + 1;
  if (!(archiveSeq > hi)) {
    row.why = "折叠区间已到归档点（窗口为空）";
    return row;
  }
  const entities = Array.isArray(ctx.entities) ? ctx.entities : entitySeqsOf(graph);
  if (!entities.some((seq) => seq > hi && seq <= archiveSeq)) {
    row.why = "窗口内无后续事件（右删失）";
    return row;
  }
  row.filable = true;
  return row;
}

/* ───────────────────────── ④ 分层（热清单 / 无热清单） ───────────────────────── */

/** 「死路信息进过上下文」的消息来源（`user/message.data.source.kind`）。 */
export const INJECTION_KINDS = Object.freeze(["compact-checkpoint", "chess-context"]);

/** 事件是不是 user/message（两种历史形状都认）。 */
function sourceKindOf(event) {
  if (event?.type !== "user/message") return "";
  return String(event?.data?.source?.kind ?? event?.message?.source?.kind ?? "");
}

/**
 * 从会话事件流里取注入事件的 seq（`null` = 日志没解出来，**不是**空数组）。
 * @param {Array<object>|null} events
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

/**
 * 分层：折叠之后、归档之前，有没有热清单注入。
 *
 * `observed === false` 是**第三态**（日志读不到）—— 不许并进 `cold`
 * （那会把「不知道」算成「对照组」，凭空造出一批假对照）。
 *
 * @param {Array<{seq:number,kind:string}>|null} injection
 * @param {{hi:number, archiveSeq:number}} range
 * @returns {{observed:boolean, key:"hot"|"cold"|"unobserved", hotLedger:boolean|null,
 *   checkpoint:boolean|null, injections:number}}
 */
export function stratumOf(injection, { hi = 0, archiveSeq = Number.POSITIVE_INFINITY } = {}) {
  if (!Array.isArray(injection)) {
    return { observed: false, key: "unobserved", hotLedger: null, checkpoint: null, injections: 0 };
  }
  const after = injection.filter((item) => Number(item?.seq) > Number(hi) && Number(item?.seq) <= Number(archiveSeq));
  const hotLedger = after.some((item) => item.kind === "chess-context");
  const checkpoint = after.some((item) => item.kind === "compact-checkpoint");
  return {
    observed: true,
    key: hotLedger ? "hot" : "cold",
    hotLedger,
    checkpoint,
    injections: after.length,
  };
}

/* ───────────────────────── ⑤ 四格与精确率/召回率 ───────────────────────── */

/** 一个空四格。 */
export function emptyQuadrant() {
  return {
    listedRetread: 0,
    listedAvoided: 0,
    unlistedRetread: 0,
    unlistedAvoided: 0,
    /** 行不可判（没正文 / 记录被截断 / 没记录）—— **不进任何格**，单独数。 */
    unjudged: 0,
    /** 重踩判据没给出答案（死路或后续边缺 action）—— 同样不进格。 */
    undecided: 0,
  };
}

/** logΓ（Lanczos，g=7）—— Fisher 精确检验要用。 */
function logGamma(z) {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = coefficients[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += coefficients[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log C(n, k)（越界返回 -Infinity）。 */
function logChoose(n, k) {
  if (k < 0 || n < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Fisher 精确检验（**双侧**，2×2）。
 *
 * 为什么不用 z 检验：这里的小格经常是 0–15，正态近似会把 p 值算小（假显著）。
 * 四格的意义就在于**格小**，所以必须用精确检验。
 *
 * @param {number} a 行1列1
 * @param {number} b 行1列2
 * @param {number} c 行2列1
 * @param {number} d 行2列2
 * @returns {number|null} p 值；总样本为 0 时 `null`（不是 1）
 */
export function fisherExact(a, b, c, d) {
  const cells = [a, b, c, d].map((value) => Math.max(0, Math.round(Number(value) || 0)));
  const [A, B, C, D] = cells;
  const n = A + B + C + D;
  if (n === 0) return null;
  const row1 = A + B;
  const col1 = A + C;
  const lo = Math.max(0, col1 - (n - row1));
  const hi = Math.min(row1, col1);
  if (hi < lo) return null;
  const logP = (x) => logChoose(row1, x) + logChoose(n - row1, col1 - x) - logChoose(n, col1);
  const observed = logP(A);
  const threshold = observed + Math.log1p(1e-9);
  let total = 0;
  for (let x = lo; x <= hi; x += 1) {
    const value = logP(x);
    if (value <= threshold) total += Math.exp(value);
  }
  return Math.min(1, total);
}

/**
 * 四格 + 精确率/召回率 + 反事实。
 *
 * **精确率** = 避开 / 列了；**召回率** = 列了 / 避开。
 * 两者都在「列了」这一侧 —— 所以要回答「摘要有用吗」必须看 `avoidRateGap`（没列 − 列了），
 * 只有它 > 0 才说明「列了」把避开率抬起来了。
 *
 * @param {Array<{listed:boolean|null, retreaded:boolean|null}>} rows
 * @returns {object}
 */
export function buildQuadrant(rows) {
  const cells = emptyQuadrant();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.listed === null || row?.listed === undefined) {
      cells.unjudged += 1;
      continue;
    }
    if (row?.retreaded === null || row?.retreaded === undefined) {
      cells.undecided += 1;
      continue;
    }
    if (row.listed === true) {
      if (row.retreaded) cells.listedRetread += 1;
      else cells.listedAvoided += 1;
    } else if (row.retreaded) {
      cells.unlistedRetread += 1;
    } else {
      cells.unlistedAvoided += 1;
    }
  }
  const listed = cells.listedRetread + cells.listedAvoided;
  const unlisted = cells.unlistedRetread + cells.unlistedAvoided;
  const retreaded = cells.listedRetread + cells.unlistedRetread;
  const avoided = cells.listedAvoided + cells.unlistedAvoided;
  const judged = listed + unlisted;
  const rateListed = listed === 0 ? null : cells.listedRetread / listed;
  const rateUnlisted = unlisted === 0 ? null : cells.unlistedRetread / unlisted;
  return {
    ...cells,
    listed,
    unlisted,
    retreaded,
    avoided,
    judged,
    /** 精确率 = 列了的有用比例（避开 / 列了）。 */
    precision: listed === 0 ? null : cells.listedAvoided / listed,
    /** 召回率 = 有用的列了比例（列了 / 避开）。 */
    recall: avoided === 0 ? null : cells.listedAvoided / avoided,
    /** 重踩率（列了侧 / 没列侧）—— 反事实的两个臂。 */
    retreadRateListed: rateListed,
    retreadRateUnlisted: rateUnlisted,
    avoidRateListed: rateListed === null ? null : 1 - rateListed,
    avoidRateUnlisted: rateUnlisted === null ? null : 1 - rateUnlisted,
    /** 反事实：没列 − 列了的重踩率差（> 0 ⇒ 列了把重踩压下去了）。 */
    retreadGapUnlistedMinusListed:
      rateListed === null || rateUnlisted === null ? null : rateUnlisted - rateListed,
    /** 治疗变量是不是常函数（列了占比）。 */
    listedShare: judged === 0 ? null : round(listed / judged),
    /** 最小格（样本量闸门用它）。 */
    minCell: Math.min(cells.listedRetread, cells.listedAvoided, cells.unlistedRetread, cells.unlistedAvoided),
    /** Fisher 精确检验（双侧）。格小时只有它可信。 */
    fisherP: fisherExact(cells.listedRetread, cells.listedAvoided, cells.unlistedRetread, cells.unlistedAvoided),
    /** 样本量够不够下结论（四格全 ≥ MIN_CELL）。 */
    sufficient:
      cells.listedRetread >= MIN_CELL &&
      cells.listedAvoided >= MIN_CELL &&
      cells.unlistedRetread >= MIN_CELL &&
      cells.unlistedAvoided >= MIN_CELL,
  };
}

/** 直方图（折痕级重踩率的分档）。 */
function histogramOf(rates) {
  return Object.fromEntries(OUTCOME_BANDS.map((band) => [band.key, rates.filter((value) => band.test(value)).length]));
}

/**
 * 一条折痕的重踩行（纯函数，便于单测）。
 *
 * @param {object} args
 * @param {object} args.graph
 * @param {object} args.mark
 * @param {object} args.account 口径（`ACCOUNTS` 的一项）
 * @param {object} args.window `archiveWindowOf` 的结果
 * @param {Array<object>|null} [args.injection] 注入事件（`null` = 日志读不到）
 * @param {string|null} [args.summaryText]
 * @returns {object}
 */
export function markQuadrant({ graph, mark, account, window: windowRow, injection = null, summaryText = null }) {
  const hi = Number(windowRow?.hi);
  const archiveSeq = Number(windowRow?.archiveSeq);
  const stratum = stratumOf(injection, { hi, archiveSeq });
  const row = {
    session: null,
    index: null,
    trigger: String(mark?.trigger ?? ""),
    account: String(account?.key ?? "P"),
    prospective: account?.prospective !== false,
    lo: Number.isFinite(Number(windowRow?.lo)) ? Number(windowRow?.lo) : null,
    hi: Number.isFinite(hi) ? hi : null,
    archiveSeq: Number.isFinite(archiveSeq) ? archiveSeq : null,
    tailGap: windowRow?.tailGap ?? null,
    span: windowRow?.span ?? null,
    stratum: stratum.key,
    hotLedger: stratum.hotLedger,
    checkpoint: stratum.checkpoint,
    injections: stratum.injections,
    deadEnds: 0,
    judged: 0,
    unjudged: 0,
    /** 三档各自的重踩条数（折叠级）。 */
    retreads: Object.fromEntries(TIERS.map((tier) => [tier.key, 0])),
    /** 三档各自的「列了且重踩」条数 —— 左上格，用来验证归因真的落到格子里。 */
    listedRetreads: Object.fromEntries(TIERS.map((tier) => [tier.key, 0])),
    rows: [],
    traceableShare: null,
    qualityTotal: null,
    summaryAvailable: typeof summaryText === "string" && summaryText !== "",
  };
  if (windowRow?.filable !== true) return row;

  const dead = failuresInFoldRange(graph, { start: row.lo, end: row.hi });
  row.deadEnds = dead.length;
  if (dead.length === 0) return row;

  const post = failureEdges(graph).filter((edge) => {
    if (isDanglingResidue(edge, { graph })) return false;
    const span = evidenceSpan(edge);
    return span !== null && span.start > row.hi && span.start <= row.archiveSeq;
  });

  for (const deadEdge of dead) {
    const treatment = treatmentOf({ account, mark, summaryText, edgeId: String(deadEdge?.id ?? "") });
    // 三档各扫一遍后续失败边（`some` 短路；三档互不包含，不能由一档推另一档）
    const hits = {};
    for (const tier of TIERS) hits[tier.key] = post.some((candidate) => tierHit(tier.key, deadEdge, candidate));
    const cell = {
      deadId: String(deadEdge?.id ?? ""),
      deadSeq: evidenceSpan(deadEdge)?.start ?? null,
      deadAction: String(deadEdge?.action ?? "").slice(0, 120),
      deadError: String(deadEdge?.errorSnippet ?? "").slice(0, 120),
      listed: treatment.listed,
      via: treatment.via,
      hits,
    };
    row.rows.push(cell);
    if (treatment.listed === null) row.unjudged += 1;
    else row.judged += 1;
    for (const tier of TIERS) {
      if (hits[tier.key] !== true) continue;
      row.retreads[tier.key] += 1;
      if (treatment.listed === true) row.listedRetreads[tier.key] += 1;
    }
  }
  return row;
}

/* ───────────────────────── ⑥ 判据 ───────────────────────── */

/**
 * 四条判据的裁决。
 *
 * ②③④ 与 T52–T56 同源；① 在这里被**加强**了一次：
 * T56 只问「结果有没有方差」，但四格矩阵要估的是**行**的效应 ——
 * 行若恒等于一个值（模型几乎必列，补回函数又兜底），就**没有对照组**。
 * 所以 ① 同时报「结果众数占比」和「治疗列了占比」，两个都过才算过。
 *
 * @param {object} result `audit()` 的返回
 * @returns {object[]}
 */
export function judgeCriteria(result) {
  const criteria = [];
  const byAccount = result?.byAccount ?? {};

  /* ① 有方差 */
  const detailRows = [];
  let worstModal = null;
  let worstListed = null;
  for (const account of ACCOUNTS) {
    for (const stratum of STRATA) {
      const quadrant = byAccount?.[account.key]?.strata?.[stratum.key]?.quadrant ?? null;
      if (quadrant === null || quadrant.judged === 0) continue;
      const modal = Math.max(quadrant.listedRetread, quadrant.listedAvoided, quadrant.unlistedRetread, quadrant.unlistedAvoided) / quadrant.judged;
      const listedShare = quadrant.listedShare;
      detailRows.push(
        `${account.key}/${stratum.key} 众数占比 ${pct(modal)}（列了 ${pct(listedShare)}，n=${int(quadrant.judged)}）`,
      );
      worstModal = worstModal === null ? modal : Math.max(worstModal, modal);
      if (listedShare !== null) worstListed = worstListed === null ? listedShare : Math.max(worstListed, listedShare);
    }
  }
  criteria.push({
    key: "①",
    name: `有方差（结果众数占比 < ${pct(CRITERIA_RULES.maxConstantShare, 0)} 且 治疗列了占比 < ${pct(MAX_TREATMENT_SHARE, 0)}）`,
    value: worstModal,
    treatmentShare: worstListed,
    detail:
      detailRows.length === 0
        ? "没有任何分层能判（四格全空）"
        : `各分层：${detailRows.join(" · ")}`,
    pass:
      worstModal === null || worstListed === null
        ? null
        : worstModal < CRITERIA_RULES.maxConstantShare && worstListed < MAX_TREATMENT_SHARE,
    degenerate: false,
  });

  /* ② 与形状无关（因果口径 P） */
  const shape = result?.correlations?.P ?? {};
  const tail = shape.tailGap ?? null;
  const span = shape.span ?? null;
  const absTail = tail?.spearman === null || tail?.spearman === undefined ? null : Math.abs(tail.spearman);
  const absSpan = span?.spearman === null || span?.spearman === undefined ? null : Math.abs(span.spearman);
  criteria.push({
    key: "②",
    name: `与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
    value: absTail === null || absSpan === null ? null : Math.max(absTail, absSpan),
    detail: `口径 P：|ρ(离归档距离)| = ${num(absTail)}（n=${int(tail?.n ?? 0)}）· |ρ(折痕跨度)| = ${num(absSpan)}（n=${int(span?.n ?? 0)}）`,
    pass: absTail !== null && absSpan !== null ? absTail < CRITERIA_RULES.maxAbsRhoShape && absSpan < CRITERIA_RULES.maxAbsRhoShape : null,
    degenerate: worstModal !== null && worstModal >= CRITERIA_RULES.maxConstantShare,
  });

  /* ③ 与已有指标不同（只有正文口径算得出来 —— 报告里写明） */
  const usedAccount = result?.correlationAccount ?? "P";
  const shape3 = result?.correlations?.[usedAccount] ?? {};
  const traceable = shape3.traceableShare ?? null;
  const qualityTotal = shape3.qualityTotal ?? null;
  const rhoTraceable = traceable?.spearman ?? null;
  const rhoQuality = qualityTotal?.spearman ?? null;
  criteria.push({
    key: "③",
    name: `与已有指标不同（ρ < ${CRITERIA_RULES.maxRhoRedundant}）`,
    value: rhoTraceable === null || rhoQuality === null ? null : Math.max(Math.abs(rhoTraceable), Math.abs(rhoQuality)),
    detail:
      `口径 ${usedAccount}：ρ(可定位率) = ${num(rhoTraceable)}（n=${int(traceable?.n ?? 0)}）· ` +
      `ρ(T33 分) = ${num(rhoQuality)}（n=${int(qualityTotal?.n ?? 0)}）` +
      (usedAccount === "R" ? "　⚠ 只有回溯性折痕有正文（口径 P 的正文落盘率 0）⇒ 这条判据**只能在因果无效的那条口径上算**。" : ""),
    pass:
      rhoTraceable === null || rhoQuality === null
        ? null
        : Math.abs(rhoTraceable) < CRITERIA_RULES.maxRhoRedundant && Math.abs(rhoQuality) < CRITERIA_RULES.maxRhoRedundant,
    degenerate: worstModal !== null && worstModal >= CRITERIA_RULES.maxConstantShare,
  });

  /* ④ 分子不是修复函数的输出（行也一起查） */
  const repair = result?.repairContamination ?? null;
  const numeratorClean = true; // 设计保证：分子是折叠后新产生的失败边（settleEdge 写入），修复函数只改文本
  const rowClean = repair === null ? null : repair.textAccountJudged === 0 ? null : repair.repairedShare === 0;
  criteria.push({
    key: "④",
    name: "分子不是修复函数的输出（行也不是）",
    value: repair === null ? null : repair.repairedShare,
    detail:
      `分子：${numeratorClean ? "设计保证 —— 重踩 = 折叠后新产生的失败边（`settleEdge` 写入），修复函数只改摘要文本、不写边。" : "未验证。"}` +
      (repair === null
        ? "　行：无正文口径样本，不可判。"
        : `　行（运行 ` + "`repairFailuresInText`" + ` 的痕迹）：正文口径可判 ${int(repair.textAccountJudged)} 条死路里，` +
          `**${int(repair.repairedOnly)} 条只出现在机械补回段**（占 ${pct(repair.repairedShare)}）—— ` +
          `这些「列了」是补回函数的输出，不是模型的观察。`),
    pass: rowClean === null ? null : numeratorClean && rowClean,
    degenerate: false,
  });

  return criteria;
}

/* ───────────────────────── ⑦ 扫描 ───────────────────────── */

/**
 * 扫全部会话。
 *
 * @param {{home?:string, limit?:number, session?:string, logs?:"all"|"none"}} [options]
 * @returns {object}
 */
export function audit({ home = resolveHome(), limit = DEFAULT_LIMIT, session = "", logs = "all" } = {}) {
  const { files } = collectGraphFiles(home);
  const logIndex = logs === "none" ? null : buildLogIndex(home);

  const funnel = {
    graphs: 0,
    badGraphs: 0,
    foldMarks: 0,
    noRange: 0,
    /** 改造 A 的闸门：未归档（右删失）。 */
    liveSession: 0,
    /** 折叠区间已到归档点 / 窗口内无后续事件。 */
    emptyWindow: 0,
    /** 通过归档闸门的折痕（「可归档观测」）。 */
    filable: 0,
    /** 口径 P / R 各多少条。 */
    prospective: 0,
    retrospective: 0,
    unknownTrigger: 0,
    /** 日志读不到（分层不可观测）。 */
    logMissing: 0,
    /** 有死路的折痕。 */
    withDeadEnds: 0,
    /** 区间内没有死路（不是「没重踩」，是「没有可重踩的东西」）。 */
    noDeadEnds: 0,
    deadEnds: 0,
    /** 行可判（治疗变量给得出答案）的死路。 */
    judged: 0,
    unjudged: 0,
    /** 带正文（`summaryText` / `summaryTextRef`）的折痕 —— 正文落盘率。 */
    summaryTextMarks: 0,
  };
  const unjudgedBy = Object.create(null);
  const repairContamination = { textAccountJudged: 0, repairedOnly: 0, repairedShare: null, summaryTextMarks: 0, marksWithSummaryTextField: 0 };

  /** 每个口径 × 层的死路行（判据与四格都从这里来）。 */
  const cellRows = Object.fromEntries(
    ACCOUNTS.map((account) => [account.key, Object.fromEntries(STRATA.map((stratum) => [stratum.key, []]))]),
  );
  /** 每个口径 × 层的**折痕**数（「各多少条折痕」）。 */
  const markCount = Object.fromEntries(ACCOUNTS.map((account) => [account.key, Object.create(null)]));
  /** 折痕级行（判据 ②③ 用）。 */
  const foldRows = [];

  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      funnel.badGraphs += 1;
      continue;
    }
    funnel.graphs += 1;
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    if (marks.length === 0) continue;
    funnel.foldMarks += marks.length;

    const point = archivePointOf(graph);
    const entities = entitySeqsOf(graph);

    /** 日志只读一次（同一会话的多条折痕共用）。 */
    let injection = null;
    let logRead = false;
    const readInjection = () => {
      if (logRead) return injection;
      logRead = true;
      if (logIndex === null) return null;
      const dirKey = String(file.dir).toLowerCase();
      const logFile = logIndex.get(dirKey) ?? logIndex.get(dirKey.replace(/^session-/, "")) ?? null;
      if (logFile === null) return null;
      const events = readSessionEvents(logFile);
      if (events.length === 0) return null;
      return injectionSeqsOf(events);
    };

    marks.forEach((mark, index) => {
      const windowRow = archiveWindowOf(graph, mark, { archived: point.archived, archiveSeq: point.archiveSeq, entities });
      if (!Number.isFinite(Number(mark?.seqStart)) || !Number.isFinite(Number(mark?.seqEnd))) {
        funnel.noRange += 1;
        return;
      }
      if (!point.archived) {
        funnel.liveSession += 1;
        return;
      }
      if (!windowRow.filable) {
        funnel.emptyWindow += 1;
        return;
      }
      funnel.filable += 1;

      const trigger = String(mark?.trigger ?? "");
      const account = trigger === "archive-offline" ? ACCOUNTS[1] : trigger === "" ? null : ACCOUNTS[0];
      if (account === null) {
        funnel.unknownTrigger += 1;
        return;
      }
      if (account.key === "P") funnel.prospective += 1;
      else funnel.retrospective += 1;

      injection = logIndex === null ? null : logRead ? injection : readInjection();
      if (injection === null) {
        funnel.logMissing += 1;
        return;
      }

      const resolved = resolveSummaryText(mark, graph?.lastOfflineSummary ?? null);
      const summaryText = account.treatment === "text" ? resolved.text : null;
      if (typeof resolved.text === "string" && resolved.text !== "") {
        funnel.summaryTextMarks += 1;
        repairContamination.summaryTextMarks += 1;
      }

      const row = markQuadrant({ graph, mark, account, window: windowRow, injection, summaryText });
      row.session = String(file.dir);
      row.index = index;
      if (row.deadEnds === 0) {
        funnel.noDeadEnds += 1;
        return;
      }
      funnel.withDeadEnds += 1;
      /** 分层里有多少**条折痕**（用户要的「各多少条折痕」，不是死路数）。 */
      markCount[account.key][row.stratum] = (markCount[account.key][row.stratum] ?? 0) + 1;
      funnel.deadEnds += row.deadEnds;
      funnel.judged += row.judged;
      funnel.unjudged += row.unjudged;
      for (const cell of row.rows) {
        if (cell.listed !== null) continue;
        unjudgedBy[cell.via] = (unjudgedBy[cell.via] ?? 0) + 1;
      }
      if (account.treatment === "text") {
        repairContamination.textAccountJudged += row.judged;
        repairContamination.repairedOnly += row.rows.filter((cell) => cell.via === "repair").length;
      }

      // 折痕级行（判据 ②③ 用：主口径 P 全部 + 口径 R 全部，**分开存**）
      const rate = row.judged === 0 ? null : row.retreads.T1 / row.judged;
      let traceableShare = null;
      let qualityTotal = null;
      if (typeof summaryText === "string" && summaryText !== "") {
        try {
          const ids = independentIds(summaryText).length;
          const placeholders = placeholderCount(summaryText);
          traceableShare = ids + placeholders === 0 ? null : Math.round((ids / (ids + placeholders)) * 10_000) / 10_000;
          qualityTotal = scoreMark(
            measureSample(
              {
                sessionId: String(graph?.sessionId ?? file.dir),
                trigger,
                source: resolved.source,
                at: Number(mark?.at) || 0,
                seqStart: row.lo,
                seqEnd: row.hi,
                text: summaryText,
                mark,
                lastOfflineSummary: null,
                chars: summaryText.length,
              },
              graph,
            ),
          ).total;
        } catch {
          traceableShare = null;
          qualityTotal = null;
        }
      }
      foldRows.push({
        account: account.key,
        stratum: row.stratum,
        rate,
        tailGap: row.tailGap,
        span: row.span,
        traceableShare,
        qualityTotal,
        deadEnds: row.deadEnds,
        judged: row.judged,
        retreads: row.retreads,
        session: row.session,
        trigger,
        lo: row.lo,
        hi: row.hi,
      });

      for (const cell of row.rows) {
        const bucket = cellRows[account.key][row.stratum];
        if (bucket === undefined) continue;
        for (const tier of TIERS) {
          bucket.push({ listed: cell.listed, retreaded: cell.hits[tier.key] === true, tier: tier.key, cell });
        }
      }
    });
  }

  repairContamination.repairedShare =
    repairContamination.textAccountJudged === 0 ? null : round(repairContamination.repairedOnly / repairContamination.textAccountJudged);

  /* 四格：口径 × 层 × 档 */
  const byAccount = {};
  for (const account of ACCOUNTS) {
    const strata = {};
    for (const stratum of STRATA) {
      const bucket = cellRows[account.key][stratum.key] ?? [];
      const tiers = {};
      for (const tier of TIERS) {
        const rows = bucket.filter((item) => item.tier === tier.key);
        const quadrant = buildQuadrant(rows);
        // 折痕级重踩率（同一档）
        const foldRates = foldRows
          .filter((row) => row.account === account.key && row.stratum === stratum.key && row.judged > 0)
          .map((row) => (Number(row.retreads?.[tier.key]) || 0) / row.judged);
        tiers[tier.key] = {
          quadrant,
          marks: foldRates.length,
          meanRate: foldRates.length === 0 ? null : round(foldRates.reduce((sum, value) => sum + value, 0) / foldRates.length),
          p50: round(quantile(foldRates, 0.5)),
          p90: round(quantile(foldRates, 0.9)),
          histogram: histogramOf(foldRates),
        };
      }
      strata[stratum.key] = { key: stratum.key, label: stratum.label, tiers, quadrant: tiers.T1.quadrant };
    }
    // 池化值**只用于一句话结论**，且必须标注
    const pooled = {};
    for (const tier of TIERS) {
      pooled[tier.key] = buildQuadrant((cellRows[account.key].hot ?? []).concat(cellRows[account.key].cold ?? []).filter((item) => item.tier === tier.key));
    }
    byAccount[account.key] = { key: account.key, label: account.label, causal: account.causal, strata, pooled, marks: markCount[account.key] };
  }

  /* 反事实：两层之间「避开率」的差 */
  const counterfactual = {};
  for (const account of ACCOUNTS) {
    const rows = {};
    for (const tier of TIERS) {
      const hot = byAccount[account.key].strata.hot.tiers[tier.key].quadrant;
      const cold = byAccount[account.key].strata.cold.tiers[tier.key].quadrant;
      rows[tier.key] = {
        hotAvoidRate: hot.avoidRateListed === null && hot.avoidRateUnlisted === null ? null : (hot.avoided ?? 0) / Math.max(1, hot.judged),
        coldAvoidRate: cold.avoidRateListed === null && cold.avoidRateUnlisted === null ? null : (cold.avoided ?? 0) / Math.max(1, cold.judged),
        /** 无热清单 − 有热清单 的避开率差。 */
        gap: null,
        fisherP: fisherExact(hot.avoided ?? 0, hot.retreaded ?? 0, cold.avoided ?? 0, cold.retreaded ?? 0),
      };
      rows[tier.key].gap =
        rows[tier.key].hotAvoidRate === null || rows[tier.key].coldAvoidRate === null
          ? null
          : round(rows[tier.key].coldAvoidRate - rows[tier.key].hotAvoidRate);
    }
    counterfactual[account.key] = rows;
  }

  /* 判据 ②③ 的相关：**按口径分开**（P 是因果口径，R 是描述口径）。
     ② 的两个量（离归档距离 / 跨度）两条口径都有；③ 的两个量（可定位率 / T33 分）**只有正文口径有正文**
     —— `summaryText` 落盘率 0 / 1152，正文只落在 `lastOfflineSummary`（`archive-offline` 那一槽）。 */
  const correlationOf = (accountKey) => {
    const folds = foldRows.filter((row) => row.account === accountKey && row.rate !== null);
    return {
      tailGap: correlate(folds, "rate", "tailGap"),
      span: correlate(folds, "rate", "span"),
      traceableShare: correlate(folds, "rate", "traceableShare"),
      qualityTotal: correlate(folds, "rate", "qualityTotal"),
    };
  };
  const correlations = { P: correlationOf("P"), R: correlationOf("R") };
  /** ③ 用**有数据的那条口径**（现在只可能是 R）—— 并在报告里写明是哪一条。 */
  const correlationAccount = correlations.P.traceableShare.n > 0 ? "P" : "R";

  const result = {
    home,
    graphs: funnel.graphs,
    badGraphs: funnel.badGraphs,
    marks: funnel.foldMarks,
    funnel,
    unjudgedBy,
    repairContamination,
    byAccount,
    counterfactual,
    correlations,
    correlationAccount,
    foldRows,
    sample: {
      minCell: MIN_CELL,
      /** 任一格 < 10 的口径/层/档（只报数、不报率）。 */
      insufficient: [],
      sufficient: [],
    },
  };

  for (const account of ACCOUNTS) {
    for (const stratum of STRATA) {
      for (const tier of TIERS) {
        const quadrant = byAccount[account.key].strata[stratum.key].tiers[tier.key].quadrant;
        const entry = { account: account.key, stratum: stratum.key, tier: tier.key, judged: quadrant.judged, minCell: quadrant.minCell };
        if (quadrant.sufficient) result.sample.sufficient.push(entry);
        else result.sample.insufficient.push(entry);
      }
    }
  }

  result.criteria = judgeCriteria(result);
  const failed = result.criteria.filter((item) => item.pass === false);
  /**
   * 四态，**样本量单独一态**：
   *   · `unusable`     —— 有条判据被判死（指标是常函数 / 与形状或旧指标同源）；
   *   · `insufficient` —— 判据全过，但**没有任何口径/层/档的四格都 ≥ MIN_CELL** ⇒ 一个率都不该被引用；
   *   · `partial`      —— 部分分层够样本；
   *   · `usable`       —— 全部分层都够。
   * 为什么不让 `insufficient` 混进 `usable`：那正是「拿 3 个事件算 99.7% 精确率」的形状。
   */
  result.verdict =
    failed.length > 0
      ? "unusable"
      : result.sample.sufficient.length === 0
        ? "insufficient"
        : result.sample.sufficient.length < result.sample.insufficient.length + result.sample.sufficient.length
          ? "partial"
          : "usable";
  result.limited = limit > 0 ? foldRows.filter((row) => row.account === "P").slice(-limit) : [];
  return result;
}

/* ───────────────────────── ⑧ 报告 ───────────────────────── */

/** 四格表（一格一行，宽表对不齐反而没人看）。 */
function quadrantLines(quadrant, indent = "    ") {
  const out = [];
  out.push(
    `${indent}┌────────────────┬──────────────┬──────────────┐`,
    `${indent}│                │ 归档前重踩   │ 归档时避开   │`,
    `${indent}├────────────────┼──────────────┼──────────────┤`,
    `${indent}│ 摘要**列了**   │ ${padDisplay(int(quadrant.listedRetread), 12, "right")} │ ${padDisplay(int(quadrant.listedAvoided), 12, "right")} │`,
    `${indent}│ 摘要**没列**   │ ${padDisplay(int(quadrant.unlistedRetread), 12, "right")} │ ${padDisplay(int(quadrant.unlistedAvoided), 12, "right")} │`,
    `${indent}└────────────────┴──────────────┴──────────────┘`,
  );
  return out;
}

/** 一条四格的读数行。 */
function quadrantReadout(quadrant, indent = "    ") {
  return (
    `${indent}精确率（列了的有用比例）= ${pct(quadrant.precision)}　` +
    `召回率（有用的列了比例）= ${pct(quadrant.recall)}　` +
    `列了占比 = ${pct(quadrant.listedShare)}\n` +
    `${indent}反事实：重踩率 列了 ${pct(quadrant.retreadRateListed)} vs 没列 ${pct(quadrant.retreadRateUnlisted)}　` +
    `⇒ 差 ${pp(quadrant.retreadGapUnlistedMinusListed)}（> 0 才是「列了把重踩压下去」）　` +
    `Fisher p = ${num(quadrant.fisherP)}　最小格 = ${int(quadrant.minCell)}` +
    (quadrant.sufficient ? "" : `　⚠ **< ${MIN_CELL}，样本不足以下结论**`)
  );
}

/** 渲染人读报告。 */
export function renderReport(result) {
  const out = [];
  const funnel = result.funnel;

  out.push("归档时刻四格审计（T57 · 只读 · 零模型调用）");
  out.push(`home = ${result.home}`);
  out.push(
    `图 = ${int(funnel.graphs)} 张（坏图 ${int(funnel.badGraphs)}）· 折痕 = ${int(funnel.foldMarks)} 条 · ` +
      `通过归档闸门 = ${int(funnel.filable)} 条（前瞻性 ${int(funnel.prospective)} · 回溯性 ${int(funnel.retrospective)}）`,
  );
  out.push("");

  /* ⓪ 漏斗 */
  out.push("## ⓪ 样本漏斗（先看这个 —— 后面的率全是在它上面算的）");
  out.push(`  折痕总数                     ${padDisplay(int(funnel.foldMarks), 8, "right")}`);
  out.push(`  − 无 seq 区间                ${padDisplay(int(funnel.noRange), 8, "right")}`);
  out.push(`  − 会话未归档（右删失）        ${padDisplay(int(funnel.liveSession), 8, "right")}　← **改造 A 的闸门**`);
  out.push(`  − 窗口为空 / 无后续事件       ${padDisplay(int(funnel.emptyWindow), 8, "right")}`);
  out.push(`  = 可归档观测                 ${padDisplay(int(funnel.filable), 8, "right")}`);
  out.push(`     · 前瞻性（口径 P，因果有效） ${padDisplay(int(funnel.prospective), 7, "right")}`);
  out.push(`     · 回溯性（口径 R，因果无效） ${padDisplay(int(funnel.retrospective), 7, "right")}`);
  out.push(`     · trigger 缺失（不可分类）   ${padDisplay(int(funnel.unknownTrigger), 7, "right")}`);
  out.push(`  − 日志读不到（分层不可观测）   ${padDisplay(int(funnel.logMissing), 8, "right")}`);
  out.push(`  − 区间内没有死路              ${padDisplay(int(funnel.noDeadEnds), 8, "right")}`);
  out.push(`  = 有死路的折痕                ${padDisplay(int(funnel.withDeadEnds), 8, "right")}`);
  out.push(`     · 死路（四格的分母）        ${padDisplay(int(funnel.deadEnds), 7, "right")}`);
  out.push(`     · 行可判（治疗给得出答案）   ${padDisplay(int(funnel.judged), 7, "right")}`);
  out.push(`     · 行不可判                  ${padDisplay(int(funnel.unjudged), 7, "right")}　${Object.entries(result.unjudgedBy).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  out.push(`  · 带摘要正文的折痕            ${padDisplay(int(funnel.summaryTextMarks), 8, "right")}　← 正文落盘率 = ${pct(funnel.filable === 0 ? null : funnel.summaryTextMarks / funnel.filable)}`);
  out.push("");

  /* ① 分层与四格 */
  out.push("## ① 分层与四格（**两层分开算，绝不合并**）");
  for (const account of ACCOUNTS) {
    const group = result.byAccount[account.key];
    out.push("");
    out.push(`### ${account.label}`);
    out.push(`  ${account.causal}`);
    for (const stratum of STRATA) {
      const block = group.strata[stratum.key];
      const quadrant = block.quadrant;
      out.push("");
      out.push(
        `  ▸ ${stratum.label}：**折痕 ${int(group.marks?.[stratum.key] ?? 0)} 条** · 死路 ${int(quadrant.judged)} 条可判 · 不可判 ${int(quadrant.unjudged)} 条`,
      );
      out.push(...quadrantLines(quadrant, "    "));
      out.push(quadrantReadout(quadrant, "    "));
    }
    out.push("");
    out.push(
      `  ⚠ 池化（**只用于一句话结论，不作因果**）：T1 重踩率 ${pct(group.pooled.T1.retreadRateListed)}（列了侧）· ` +
        `列了占比 ${pct(group.pooled.T1.listedShare)}`,
    );
  }
  out.push("");

  /* ② 三档重踩判据 */
  out.push("## ② 三档重踩判据（每档的含义与误判风险）");
  for (const tier of TIERS) {
    out.push("");
    out.push(`### ${tier.key} · ${tier.label}`);
    out.push(`  含义：${tier.meaning}`);
    out.push(`  误判风险：${tier.risk}`);
    out.push(
      `  ${padDisplay("口径/层", 22)}${padDisplay("重踩", 7, "right")}${padDisplay("避开", 7, "right")}` +
        `${padDisplay("重踩率(列)", 12, "right")}${padDisplay("重踩率(没列)", 14, "right")}${padDisplay("差", 10, "right")}${padDisplay("最小格", 8, "right")}`,
    );
    for (const account of ACCOUNTS) {
      for (const stratum of STRATA) {
        const quadrant = result.byAccount[account.key].strata[stratum.key].tiers[tier.key].quadrant;
        if (quadrant.judged === 0) continue;
        out.push(
          `  ${padDisplay(`${account.key}/${stratum.key}`, 22)}${padDisplay(int(quadrant.retreaded), 7, "right")}` +
            `${padDisplay(int(quadrant.avoided), 7, "right")}${padDisplay(pct(quadrant.retreadRateListed), 12, "right")}` +
            `${padDisplay(pct(quadrant.retreadRateUnlisted), 14, "right")}${padDisplay(pp(quadrant.retreadGapUnlistedMinusListed), 10, "right")}` +
            `${padDisplay(int(quadrant.minCell), 8, "right")}`,
        );
      }
    }
  }
  out.push("");

  /* ③ 四条判据 */
  out.push("## ③ 四条判据");
  for (const item of result.criteria) {
    const mark = item.pass === null ? "？不可判" : item.pass ? "✓ 通过" : "✗ **不通过**";
    const extra = item.degenerate && item.pass ? "　⚠ **退化通过**（无方差，ρ 不可信，不构成支持）" : "";
    out.push(`  判据 ${item.key} ${item.name}：${mark}${extra}`);
    out.push(`    ${item.detail}`);
  }
  out.push("");

  /* ④ 反事实 */
  out.push("## ④ 反事实：无热清单 vs 有热清单");
  out.push("  「避开率」= 归档时确认避开的比例（1 − 重踩率）。两层的差若显著为负，说明热清单在起作用、不是摘要。");
  for (const account of ACCOUNTS) {
    out.push("");
    out.push(`  ▸ ${account.label}`);
    out.push(
      `    ${padDisplay("档", 6)}${padDisplay("有热清单避开率", 16, "right")}${padDisplay("无热清单避开率", 16, "right")}${padDisplay("差(无−有)", 12, "right")}${padDisplay("Fisher p", 12, "right")}`,
    );
    for (const tier of TIERS) {
      const cf = result.counterfactual[account.key][tier.key];
      out.push(
        `    ${padDisplay(tier.key, 6)}${padDisplay(pct(cf.hotAvoidRate), 16, "right")}${padDisplay(pct(cf.coldAvoidRate), 16, "right")}` +
          `${padDisplay(pp(cf.gap), 12, "right")}${padDisplay(num(cf.fisherP), 12, "right")}`,
      );
    }
  }
  out.push("");
  out.push(
    `  治疗变量常函数检查：列了占比 ${
      result.byAccount.P.pooled.T1.listedShare === null ? "—" : pct(result.byAccount.P.pooled.T1.listedShare)
    }（口径 P 池化）· ${result.byAccount.R.pooled.T1.listedShare === null ? "—" : pct(result.byAccount.R.pooled.T1.listedShare)}（口径 R 池化）。`,
  );
  out.push(
    `  ⇒ 行接近 1 时**没有对照组**：不管结果怎么变，都不可能是「列了」造成的（差异全落在不可识别的混淆里）。`,
  );
  out.push("");

  /* ⑤ 能不能用 */
  out.push("## ⑤ 能不能用");
  const failed = result.criteria.filter((item) => item.pass === false);
  const undecidable = result.criteria.filter((item) => item.pass === null);
  if (result.verdict === "usable") {
    out.push(`  **能用**：四条判据全过，且每个口径/层/档的四格都 ≥ ${MIN_CELL}。`);
  } else if (result.verdict === "partial") {
    out.push(
      `  **部分能用**：没有判据被判死，${result.sample.sufficient.length} 组分层够样本（见 ⑥）—— 只有这几组能报率。`,
    );
  } else if (result.verdict === "insufficient") {
    out.push(
      `  **样本不足以下结论（按「不能用」处理）。**四条判据没有一条被判死${undecidable.length > 0 ? `（${undecidable.length} 条不可判）` : ""}，` +
        `但**没有任何一组分层的四格全 ≥ ${MIN_CELL}** —— 这时报出来的任何「精确率 / 召回率」都是拿个位数事件算的。`,
    );
  } else {
    out.push(`  **不能用。**判据 ${failed.map((item) => item.key).join("、")} 不过。`);
  }
  out.push(`  **分层结论（哪一层能用）**：`);
  const perStratum = [];
  for (const account of ACCOUNTS) {
    for (const stratum of STRATA) {
      const quadrant = result.byAccount[account.key].strata[stratum.key].tiers.T1.quadrant;
      const verdict =
        quadrant.judged === 0
          ? "**不可用**（四格全空）"
          : !quadrant.sufficient
            ? `**不可用**（最小格 ${int(quadrant.minCell)} < ${MIN_CELL}，样本不足）`
            : quadrant.listedShare !== null && quadrant.listedShare >= MAX_TREATMENT_SHARE
              ? `**不可用**（治疗变量是常函数：列了 ${pct(quadrant.listedShare)} ≥ ${pct(MAX_TREATMENT_SHARE, 0)}，没有对照组）`
              : "可用";
      perStratum.push(`    · ${account.key}/${stratum.key}：${verdict}`);
    }
  }
  out.push(...perStratum);
  out.push("");

  /* ⑥ 样本量 */
  out.push("## ⑥ 样本量够不够（老实说）");
  out.push(`  门槛：四格**每一格**都要 ≥ ${MIN_CELL} 才能报率（否则只报数）。`);
  if (result.sample.sufficient.length === 0) {
    out.push(`  ⇒ **没有一个口径/层/档同时满足**（${result.sample.insufficient.length} 组里 0 组够）。`);
  } else {
    out.push(
      `  ⇒ 够的组合：${result.sample.sufficient.map((item) => `${item.account}/${item.stratum}/${item.tier}`).join("、")}；` +
        `不够的 ${result.sample.insufficient.length} 组。`,
    );
  }
  const worst = result.sample.insufficient.slice().sort((a, b) => a.minCell - b.minCell)[0] ?? null;
  if (worst !== null) {
    out.push(`  最差的格：${worst.account}/${worst.stratum}/${worst.tier} 最小格 = ${int(worst.minCell)}（判死样本 ${int(worst.judged)} 条）。`);
  }
  out.push(
    `  结论：**${result.sample.sufficient.length === 0 ? "样本不足以下任何结论 —— 一个率都不该被引用。" : "只有上面列出的组合可以报率，其余只能报数。"}**`,
  );
  out.push("");

  /* 明细 */
  const detail = result.limited ?? [];
  out.push(`## 明细（口径 P 最近 ${int(detail.length)} 条折痕）`);
  if (detail.length === 0) {
    out.push("  （口径 P 没有可列折痕）");
  } else {
    for (const row of detail.slice(-DEFAULT_LIMIT)) {
      out.push(
        `  · ${shortSession(row.session)} [${row.trigger || "∅"}/${row.stratum}] seq ${int(row.lo)}-${int(row.hi)} ` +
          `死路 ${int(row.deadEnds)} · 可判 ${int(row.judged)} · 重踩 T1/T2/T3 = ` +
          `${int(row.retreads.T1)}/${int(row.retreads.T2)}/${int(row.retreads.T3)} · 离归档 ${int(row.tailGap)}`,
      );
    }
  }
  return out.join("\n");
}

/* ───────────────────────── ⑨ CLI ───────────────────────── */

/** 解析 `--key=value` / 裸开关。 */
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

/* ───────────────────────── 入口 ───────────────────────── */

/**
 * CLI 主体（导出是为了让守卫能直接断言退出码 —— 起子进程测退出码会让 run.mjs 慢 3 秒）。
 * @param {string[]} [argv]
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = audit({
    home: args.home ?? resolveHome(),
    limit: args.limit,
    session: args.session,
    logs: args.logs,
  });
  if (result.graphs === 0) {
    console.error(`✗ 一张图都读不到：${result.home}（home 给错了？）`);
    return 2;
  }
  if (args.json) console.log(JSON.stringify(result, null, 1));
  else console.log(renderReport(result));
  return 0;
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
  process.exitCode = main();
}
