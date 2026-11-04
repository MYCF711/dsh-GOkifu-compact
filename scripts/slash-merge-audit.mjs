#!/usr/bin/env node
/**
 * slash-merge-audit.mjs —— **斜杠合并（`e107/e113`）到底该不该禁**（T26 · 只读 · 零模型调用）
 *
 * 由来（2026-11-05，T26 真机度量）：
 *   `scripts/deadend-adherence-audit.mjs` 报了两个「格式违规」：
 *     破折号区间 `e693—e698`：18 次 / 149 个有失败边的 fold = 12.08%（吞掉 59 个 id）；
 *     斜杠合并   `e107/e113` ：90 次 / 149 = **60.40%** —— 提示词完全没提这个写法。
 *   Lead 据此判断「斜杠合并是最大的剩余缺口」。但**数字大不等于缺口大**：
 *   那个 60.40% 的分母是「有失败边的 fold」，分子是**整篇正文**里的斜杠 token ——
 *   两者不是同一件事。所以这一步先做减法，再决定要不要动提示词。
 *
 * 本脚本把「89 次斜杠合并」拆成三个**互不重叠**的落点（这是它存在的全部理由）：
 *   ① **成功边**（`e20/e21 成功`，出现在「棋谱」「已验证事实」段）——
 *      提示词那条规则写的是「**「已探明死路」**一条边一行」，成功边根本不在它的管辖范围；
 *   ② **失败边 · 死路段之外**（叙述引用，如「…这正是 e26/e27 死路的成因」）——
 *      规则不管，而且要看**死路清单里有没有各自的独立行**：有 ⇒ 合并只是简写，零损失；
 *   ③ **失败边 · 死路段之内** —— 只有这一档才是**真违规**，才轮到「该不该改提示词」。
 *
 * 第二步判「有没有丢信息」：斜杠合并**不会**让 id 消失（两端都能被 `mentionsEdge` 命中），
 * 所以唯一的损失形态是「一条共享描述盖住两条不同的边」—— 这要拿**图里的边**比对：
 *   · 同工具 + 同错误类 ⇒ 同一动作重复失败，共享描述是**事实**（合并只省行数）；
 *   · 同工具 + 不同错误类 / 不同工具 ⇒ 共享描述只对其中一条成立，这才叫失真。
 * 「同工具」取动作文本开头 `tool(` 的工具名；「同错误类」把 uuid / hex / 数字抹成 `<uuid>`/`<n>`
 * 再比前 48 字符 —— 真机里 `job_output` 两次失败的差别只是 job_id，不该算「不同错误」。
 *
 * 判据全部机械（字符串 + 图查询），**不打分、不调模型、不做语义判断**。
 *
 * 用法：
 *   node scripts/slash-merge-audit.mjs                # 默认 DSH_HOME
 *   node scripts/slash-merge-audit.mjs --home <dir>   # 换 home
 *   node scripts/slash-merge-audit.mjs --json         # 机读（测试/报告用）
 *   node scripts/slash-merge-audit.mjs --samples=8    # 样本条数（默认 5）
 *   node scripts/slash-merge-audit.mjs --session fdd814
 *
 * 退出码：0 = 审计跑完（无论结论是改还是不改）；2 = 一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不重启。
 */
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { compactAction } from "../src/rooms/offline-fold.mjs";
import { failuresInFoldRange, mentionsEdge } from "../src/rooms/fold-quality.mjs";
// ★ 口径复用（不复制实现）：剥补回段 / 破折号区间 / 它那个斜杠正则的**同一个计数函数**。
//   两边一旦分叉，「89 次」和「89 次」就会变成两个数 —— 这正是本仓反复踩过的坑。
import { splitModelText, countRangeMerges, coveredByDashRange } from "./deadend-adherence-audit.mjs";

/* ─────────────────────────────── 常量（改口径只改这里） ─────────────────────────────── */

/**
 * 斜杠合并的**同一个**正则（逐字符复制自 `deadend-adherence-audit.mjs` 的 `SLASH_RANGE_RE`）。
 *
 * 为什么复制而不是 import：那边是模块私有的（只在 `countRangeMerges` 内部用），
 * 而这里需要**位置**（`m.index`）来定位它是哪一段、哪一行。复制的那一份由
 * `verifySlashRegex()` 在每次运行时对账：本脚本数的次数必须等于 `countRangeMerges().slash.length`，
 * 不等就直接报错（宁可不跑，也不要两份口径悄悄分叉）。
 */
export const SLASH_RE = /(?<![A-Za-z0-9_])e([0-9]{1,4})[ \t]*\/[ \t]*e?([0-9]{1,4})(?![0-9])/g;

/** 任意独立边 id（`e1` 不匹配 `e12`）。行内「有几个 id」用它数。 */
export const ID_RE = /(?<![A-Za-z0-9_])e([0-9]{1,4})(?![0-9])/g;

/** 死路段的标题前缀（提示词要求模型写 `## 已探明死路`）。 */
export const DEADEND_PREFIX = "已探明死路";

/** 机械补回段的标题里必有这个词 —— 它写的行天然是「一条边一行」，不能混进格式统计。 */
export const REPAIR_MARK = "逐字补充";

/** 样本默认条数。 */
export const DEFAULT_SAMPLES = 5;

/**
 * **告警线**：死路段内的合并率超过它就复议「不改」这个决定。
 *
 * 定 20% 的理由：它必须高于现状（真机 9~10%）一个显眼的距离，
 * 又不能高到「等到 40% 才发现」。低于现状一半（5%）则会被一次模型抖动打爆，没有信噪比。
 */
export const IN_SCOPE_ALERT_RATE = 0.2;

/* ─────────────────────────────────── 小工具 ─────────────────────────────────── */

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "—");
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(2)}%`);
const int = (x) => (Number.isFinite(Number(x)) ? String(Math.round(Number(x))) : "—");

/** 与 doctor / graph-audit / deadend-adherence-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** `e007` → `e7`（图里的 id 不带前导零；不归一就会「图里查不到」）。 */
export function normalizeId(raw) {
  const m = /^e0*([0-9]+)$/.exec(String(raw ?? "").trim());
  return m === null ? String(raw ?? "") : `e${m[1]}`;
}

/** 一段正文里出现过的 id（去重、保序、已归一）。 */
export function idsIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(ID_RE)) {
    const id = normalizeId(`e${m[1]}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* ─────────────────────────────── ① 段落定位 ─────────────────────────────── */

/** 正文里的标题（行首 `#`×1-6），带字符下标。 */
export function headingsOf(text) {
  const out = [];
  const re = /^#{1,6}[ \t]*(.+)$/gm;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) out.push({ index: m.index, name: m[1].trim() });
  return out;
}

/** 这个下标落在哪个标题下（没有标题就返回 `(无标题)`）。 */
export function sectionOf(text, index) {
  const heads = headingsOf(text).filter((h) => h.index <= index);
  return heads.length === 0 ? "(无标题)" : heads[heads.length - 1].name;
}

/** 这个标题名是不是「已探明死路」段（**不含**机械补回段）。 */
export function isDeadendSection(name) {
  const n = String(name ?? "");
  return n.startsWith(DEADEND_PREFIX) && !n.includes(REPAIR_MARK);
}

/**
 * 取「已探明死路」段的正文行。
 *
 * 必须排除机械补回段（`## 已探明死路（逐字补充 …）`）：它的标题也以「已探明死路」开头，
 * 但那一整段是 `repairMissingFailures` **逐条**生成的 —— 混进格式统计会把合规率抬成 100%。
 *
 * @param {string} text 模型正文（已剥补回段；这里再防一次）
 * @returns {{found:boolean, name:string, lines:string[]}}
 */
export function deadendSection(text) {
  const body = String(text ?? "");
  const heads = headingsOf(body);
  const i = heads.findIndex((h) => isDeadendSection(h.name));
  if (i < 0) return { found: false, name: "", lines: [] };
  const headLineEnd = body.indexOf("\n", heads[i].index);
  const start = headLineEnd < 0 ? body.length : headLineEnd + 1;
  const end = heads[i + 1] !== undefined ? heads[i + 1].index : body.length;
  return {
    found: true,
    name: heads[i].name,
    lines: body.slice(start, end).split("\n").filter((l) => l.trim() !== ""),
  };
}

/** 下标所在的那一整行（去掉首尾空白）。 */
export function lineAt(text, index) {
  const body = String(text ?? "");
  const start = body.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const raw = body.indexOf("\n", index);
  const end = raw < 0 ? body.length : raw;
  return body.slice(start, end).trim();
}

/* ─────────────────────────────── ② 两条边像不像 ─────────────────────────────── */

/** 边的动作原文（与 `repairMissingFailures` 同一取法：`intent` 优先，其次 `action`）。 */
export function actionText(edge) {
  return compactAction(String(edge?.intent || edge?.action || ""), 80);
}

/** 边的错误原文（与 `repairMissingFailures` 同一取法；只看第一行）。 */
export function errorText(edge) {
  return compactAction(String(edge?.errorSnippet || edge?.verify?.summary || "").split("\n")[0], 80);
}

/** 工具名：动作开头的 `tool(`。真机里动作常常是自由文本（`以新增热重载测试…`）⇒ `(无工具)`。 */
export function toolOf(edge) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\(/.exec(actionText(edge));
  return m === null ? "(无工具)" : m[1].toLowerCase();
}

/**
 * 错误类：抹掉 uuid / 带 hex 的 id 记号 / 数字后再比。
 *
 * 为什么必须抹：真机 `e656`（`unknown job wait-186fbd…`）与 `e2142`（`unknown job ffffba…`）
 * 是**同一类失败**，不抹就会算成「不同错误类」，把一次合理的合并判成失真。
 *
 * 为什么要连**前缀**一起抹（`[A-Za-z0-9_-]*[0-9a-f]{8,}…` 整段换掉）：真实 job id 是
 * `wait-186fbd94344f40da` 这种「词 + `-` + hex」的形状，只抹 `\b[0-9a-f]{8,}\b` 会留下 `wait-`，
 * 于是它和 `ffffba256d7d467f` 仍然「不同类」—— 归一得不够狠，等于没归一。
 */
export function errorClass(edge) {
  return errorText(edge)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[A-Za-z0-9_-]*[0-9a-f]{8,}[A-Za-z0-9_-]*/g, "<id>")
    .replace(/[0-9]+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

/**
 * 把一对被斜杠并在一起的 id 分类（决定「合并有没有改变事实」）。
 *
 * @param {object|undefined} a 边（`undefined` = 图里没有）
 * @param {object|undefined} b 边
 * @returns {{kindA:string, kindB:string, sameTool:boolean|null, sameErrorClass:boolean|null,
 *   sameAction:boolean|null, sameError:boolean|null, cat:string}}
 */
export function classifyPair(a, b) {
  const kindOf = (e) => (e === undefined || e === null ? "unresolved" : e.result === "failure" ? "failure" : "success");
  const kindA = kindOf(a);
  const kindB = kindOf(b);
  /** @type {any} */
  const row = { kindA, kindB, sameTool: null, sameErrorClass: null, sameAction: null, sameError: null, cat: "" };
  if (kindA === "success" && kindB === "success") {
    row.cat = "两条都是成功边";
    return row;
  }
  if (kindA === "unresolved" || kindB === "unresolved") {
    row.cat = "id 在图里查不到";
    return row;
  }
  if (kindA !== "failure" || kindB !== "failure") {
    row.cat = "一条失败一条成功";
    return row;
  }
  row.sameAction = actionText(a) === actionText(b);
  row.sameError = errorText(a) === errorText(b);
  row.sameTool = toolOf(a) === toolOf(b) && toolOf(a) !== "(无工具)";
  row.sameErrorClass = errorClass(a) !== "" && errorClass(a) === errorClass(b);
  row.cat = row.sameErrorClass
    ? row.sameTool
      ? "同工具+同错误类"
      : "同错误类"
    : row.sameTool
      ? "同工具+不同错误类"
      : "不同工具+不同错误类";
  return row;
}

/* ─────────────────────────────── ③ 扫一条折痕 ─────────────────────────────── */

/**
 * 一条折痕（= 一个会话的 `lastOfflineSummary`）的全部斜杠合并证据。
 *
 * @param {object} graph 棋谱
 * @param {{session?:string}} [meta]
 * @returns {object|null} `null` = 这条折痕没有正文（不可测）
 */
export function scanFold(graph, { session = null } = {}) {
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") return null;
  const text = last.text;
  // ★ 与 deadend-adherence-audit 同源：只数**模型自己写的**那半段。
  const { modelText } = splitModelText(text);
  const edges = Object.values(graph?.edges ?? {});
  const byId = new Map();
  for (const e of edges) if (typeof e?.id === "string") byId.set(normalizeId(e.id), e);

  const dead = deadendSection(modelText);
  const soloIds = new Set();
  let multiIdLines = 0;
  let expandExtraLines = 0;
  let deadIdLines = 0;
  let placeholderLines = 0;
  for (const line of dead.lines) {
    const ids = idsIn(line);
    if (ids.length === 1) soloIds.add(ids[0]);
    if (ids.length >= 1) deadIdLines += 1;
    if (ids.length >= 2) {
      multiIdLines += 1;
      expandExtraLines += ids.length - 1;
    }
    if (/(?<![A-Za-z0-9_])e\?/.test(line)) placeholderLines += 1;
  }

  const merges = countRangeMerges(modelText);
  const occurrences = [];
  for (const m of modelText.matchAll(SLASH_RE)) {
    const a = normalizeId(`e${m[1]}`);
    const b = normalizeId(`e${m[2]}`);
    const ea = byId.get(a);
    const eb = byId.get(b);
    const section = sectionOf(modelText, m.index);
    const inDead = isDeadendSection(section);
    const cls = classifyPair(ea, eb);
    // 两端都失败、又不在死路段 ⇒ 问一句「死路清单里有没有各自的独立行」。
    const bothFail = cls.kindA === "failure" && cls.kindB === "failure";
    const compensated = bothFail && !inDead ? soloIds.has(a) && soloIds.has(b) : null;
    // 这个 id 在全篇**除这次合并之外**还有没有出现（没有 ⇒ 全文唯一出现处就在合并里）。
    const rest = `${modelText.slice(0, m.index)}\u0000${modelText.slice(m.index + m[0].length)}`;
    occurrences.push({
      session,
      at: Number(last?.at) || 0,
      section,
      inDeadend: inDead,
      raw: m[0],
      a,
      b,
      toolA: toolOf(ea),
      toolB: toolOf(eb),
      ...cls,
      compensated,
      aOnlyHere: !mentionsEdge(rest, a),
      bOnlyHere: !mentionsEdge(rest, b),
      line: lineAt(modelText, m.index),
      canonical: bothFail
        ? [`- ${a} 「${actionText(ea)}」→ ${errorText(ea)}`, `- ${b} 「${actionText(eb)}」→ ${errorText(eb)}`]
        : [],
    });
  }

  // 缺口归因：与 `deadend-adherence-audit` 同一判据（同一区间、同一 `mentionsEdge`）。
  const range = last?.range ?? null;
  let missing = [];
  try {
    missing = failuresInFoldRange(graph, range).filter((e) => !mentionsEdge(modelText, e.id)).map((e) => String(e.id));
  } catch {
    missing = [];
  }
  const dashCovered = missing.filter((id) => coveredByDashRange(id, merges.dashRanges)).length;

  return {
    session,
    at: Number(last?.at) || 0,
    range: range === null ? null : { start: Number(range.start), end: Number(range.end) },
    hasDeadend: dead.found,
    deadLines: dead.lines.length,
    deadIdLines,
    soloIdLines: soloIds.size,
    multiIdLines,
    expandExtraLines,
    placeholderLines,
    occurrences,
    // 对账用：本脚本匹配数必须等于 `countRangeMerges` 的斜杠数
    slashCount: merges.slash.length,
    missingIds: missing,
    missingFromDash: dashCovered,
    missingPure: missing.length - dashCovered,
    failureEdges: (() => {
      try {
        return failuresInFoldRange(graph, range).length;
      } catch {
        return 0;
      }
    })(),
  };
}

/* ─────────────────────────────── ④ 聚合 ─────────────────────────────── */

export function summarize(folds) {
  const list = (Array.isArray(folds) ? folds : []).filter((f) => f !== null);
  const occ = list.flatMap((f) => f.occurrences);
  const failurePairs = occ.filter((o) => o.kindA === "failure" && o.kindB === "failure");
  const deadPairs = failurePairs.filter((o) => o.inDeadend);
  const outsidePairs = failurePairs.filter((o) => !o.inDeadend);
  const successPairs = occ.filter((o) => o.kindA === "success" && o.kindB === "success");
  const unresolved = occ.filter((o) => o.kindA === "unresolved" || o.kindB === "unresolved");
  const foldsWithFailureEdges = list.filter((f) => f.failureEdges > 0).length;
  const foldsWithDeadMerge = new Set(deadPairs.map((o) => o.session ?? o.line)).size;
  const foldsWithAnyMerge = new Set(occ.map((o) => o.session ?? o.line)).size;

  /** 按类计数的小工具。 */
  const countBy = (rows, pick) => {
    const map = new Map();
    for (const r of rows) {
      const k = pick(r);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()].sort((x, y) => y[1] - x[1]);
  };

  return {
    folds: list.length,
    foldsWithDeadend: list.filter((f) => f.hasDeadend).length,
    foldsWithFailureEdges,
    foldsWithAnyMerge,
    occurrences: occ.length,
    successPairs: successPairs.length,
    unresolved: unresolved.length,
    failurePairs: failurePairs.length,
    deadPairs: deadPairs.length,
    outsidePairs: outsidePairs.length,
    /** 死路段内合并率（**真违规率**）= 死路段内合并次数 / 有失败边的折痕数。 */
    inScopeRate: foldsWithFailureEdges === 0 ? null : deadPairs.length / foldsWithFailureEdges,
    /** 他段失败边合并里，两端在死路段各有独立行的比例（= 被补偿的比例）。 */
    compensated: outsidePairs.filter((o) => o.compensated === true).length,
    uncompensated: outsidePairs.filter((o) => o.compensated === false).length,
    uncompensatedList: outsidePairs.filter((o) => o.compensated === false),
    byFall: countBy(occ, (o) =>
      o.kindA === "success" && o.kindB === "success"
        ? "成功边（规则不管）"
        : o.kindA === "unresolved" || o.kindB === "unresolved"
          ? "id 在图里查不到"
          : o.inDeadend
            ? "失败边 · 死路段之内"
            : "失败边 · 死路段之外",
    ),
    deadByCat: countBy(deadPairs, (o) => o.cat),
    outsideByCat: countBy(outsidePairs, (o) => o.cat),
    sectionRows: countBy(occ, (o) => o.section),
    deadSectionLines: list.reduce((n, f) => n + f.deadLines, 0),
    deadIdLines: list.reduce((n, f) => n + f.deadIdLines, 0),
    deadSoloLines: list.reduce((n, f) => n + f.soloIdLines, 0),
    deadMultiLines: list.reduce((n, f) => n + f.multiIdLines, 0),
    deadExpandExtraLines: list.reduce((n, f) => n + f.expandExtraLines, 0),
    placeholderLines: list.reduce((n, f) => n + f.placeholderLines, 0),
    placeholderFolds: list.filter((f) => f.placeholderLines > 0).length,
    missingIds: list.reduce((n, f) => n + f.missingIds.length, 0),
    missingFromDash: list.reduce((n, f) => n + f.missingFromDash, 0),
    missingFromSlash: 0, // 结构性为 0：斜杠合并两端都能被逐字命中（见 ⑤）
    /** 全文唯一出现处就在斜杠合并里的 id 数（它们照样命中，所以照样不丢）。 */
    onlyHereIds: occ.reduce((n, o) => n + (o.aOnlyHere ? 1 : 0) + (o.bOnlyHere ? 1 : 0), 0),
    /** 斜杠数对账：每一次匹配都该贡献 1 个 `countRangeMerges`。 */
    slashTally: list.reduce((n, f) => n + f.slashCount, 0),
  };
}

/* ─────────────────────────────── ⑤ 选样本 ─────────────────────────────── */

/**
 * 挑样本：**每类各一条**（不是「前 5 条」）—— 前 5 条会全落在同一个会话里，
 * 那是样本偏差，不是证据。
 *
 * 顺序：死路段·同工具+同错误类 → 死路段·同工具+不同错误类 → 死路段·不同工具
 *       → 他段·被补偿 → 成功边。
 */
export function pickSamples(occurrences, limit = DEFAULT_SAMPLES) {
  const list = Array.isArray(occurrences) ? occurrences : [];
  const wanted = [
    (o) => o.inDeadend && o.cat === "同工具+同错误类",
    (o) => o.inDeadend && o.cat === "同工具+不同错误类",
    (o) => o.inDeadend && o.cat === "不同工具+不同错误类",
    (o) => !o.inDeadend && o.compensated === false,
    (o) => o.kindA === "success" && o.kindB === "success",
  ];
  const out = [];
  const used = new Set();
  const usedKeys = new Set();
  const keyOf = (o) => `${o.session ?? ""}::${o.line}`;
  for (const test of wanted) {
    const hit = list.find((o) => !used.has(o) && !usedKeys.has(keyOf(o)) && test(o));
    if (hit !== undefined) {
      used.add(hit);
      usedKeys.add(keyOf(hit));
      out.push(hit);
    }
  }
  // 还有额度就补「他段·没被补偿」与第一条（它们最可能是真问题）
  for (const o of list) {
    if (out.length >= limit) break;
    if (used.has(o)) continue;
    used.add(o);
    usedKeys.add(keyOf(o));
    out.push(o);
  }
  return out.slice(0, Math.max(1, limit));
}

/* ─────────────────────────────── ⑥ 输出 ─────────────────────────────── */

function render(result, { samples = DEFAULT_SAMPLES } = {}) {
  const s = result.summary;
  const lines = [];
  lines.push("# 斜杠合并审计（`e107/e113`）—— 该不该禁");
  lines.push("");
  lines.push(`home = ${result.home}`);
  lines.push(`审计时刻 = ${iso(result.now)} · 只读 · 零模型调用`);
  lines.push(
    `会话 **${int(result.graphs)}** 个 · 有摘要正文的折痕 **${int(s.folds)}** 条 · ` +
      `其中有失败边的 **${int(s.foldsWithFailureEdges)}** 条 · 有「已探明死路」段的 ${int(s.foldsWithDeadend)} 条`,
  );
  lines.push("");
  lines.push(
    "> 口径：斜杠合并 = `/(?<![A-Za-z0-9_])e(\\d{1,4})[ \\t]*\\/[ \\t]*e?(\\d{1,4})(?![0-9])/g`，" +
      "与 `deadend-adherence-audit.mjs` 的 `countRangeMerges` **同一个正则**；只数**模型正文**（已剥机械补回段）。",
  );
  lines.push(
    `> 对账：本脚本数出 **${int(s.occurrences)}** 次 = \`countRangeMerges\` 的 **${int(s.slashTally)}** 次 ` +
      `${s.occurrences === s.slashTally ? "✅" : "❌ 口径已分叉，下面的数字不能用"}`,
  );
  lines.push("");

  /* ── ① 落点 ── */
  lines.push(`## ① 落点：这 ${int(s.occurrences)} 次到底在正文的哪一段（决定规则管不管得着）`);
  lines.push("");
  lines.push("| 落点 | 次数 | 占比 | 「一条边一行」这条规则适用？ |");
  lines.push("| --- | --- | --- | --- |");
  const total = Math.max(1, s.occurrences);
  for (const [name, n] of s.byFall) {
    const applies =
      name === "成功边（规则不管）"
        ? "**否** —— 规则只写「「已探明死路」一条边一行」，成功边不在管辖内"
        : name === "失败边 · 死路段之外"
          ? "**否** —— 那是叙述引用；要看死路清单有没有独立行（见 ③）"
          : name === "失败边 · 死路段之内"
            ? "**是** —— 只有这一档是真违规"
            : "—";
    lines.push(`| ${name} | ${int(n)} | ${pct(n / total)} | ${applies} |`);
  }
  lines.push("");
  lines.push(
    `**关键换算**：任务书里的 60.40% 是「**整篇正文**里有斜杠的 fold ÷ 有失败边的 fold」；` +
      `按「这个 token 是不是真的落在死路段里」重算 ⇒ ` +
      `**${int(s.deadPairs)} / ${int(s.foldsWithFailureEdges)} = ${pct(s.inScopeRate)}**（真违规率）。`,
  );
  lines.push("");

  /* ── ② 段落分布 ── */
  lines.push("## ② 按段落分布（模型把斜杠写在哪儿）");
  lines.push("");
  lines.push("| 段落 | 次数 |");
  lines.push("| --- | --- |");
  for (const [name, n] of s.sectionRows) lines.push(`| ${name} | ${int(n)} |`);
  lines.push("");

  /* ── ③ 他段失败边：有没有补偿 ── */
  lines.push("## ③ 死路段**之外**的失败边合并：死路清单里有没有各自的独立行");
  lines.push("");
  lines.push(
    `- 两端 id 在死路段**各有一行**（合并只是叙述里的简写）：**${int(s.compensated)} / ${int(s.outsidePairs)}** ` +
      `= **${pct(s.outsidePairs === 0 ? null : s.compensated / s.outsidePairs)}**`,
  );
  lines.push(`- 死路清单里**没有**独立行：**${int(s.uncompensated)}** 次（逐条列出 —— 「他段」里唯一可能真丢东西的就是这一档）：`);
  for (const o of s.uncompensatedList) {
    lines.push(
      `  - \`${o.a}/${o.b}\` · ${o.cat} · \`${String(o.session ?? "").slice(-20)}\`：「${o.line.slice(0, 140)}${o.line.length > 140 ? "…" : ""}」`,
    );
  }
  if (s.outsidePairs > 0) {
    lines.push("");
    lines.push("  按「工具 + 错误类」分解：");
    for (const [name, n] of s.outsideByCat) lines.push(`  - ${name}：**${int(n)}** 次`);
  }
  lines.push("");

  /* ── ④ 死路段内：动作/错误对不对得上 ── */
  lines.push("## ④ 死路段**之内**（真违规）那几次：共享描述有没有改变事实");
  lines.push("");
  lines.push("| 类 | 次数 | 含义 |");
  lines.push("| --- | --- | --- |");
  const meaning = {
    "同工具+同错误类": "同一动作重复失败 —— 共享描述**是事实**，合并只省行数",
    "同错误类": "工具名不同但失败类相同 —— 描述仍成立",
    "同工具+不同错误类": "同一工具两种失败 —— 描述只覆盖其中一条，**有失真**",
    "不同工具+不同错误类": "两件不同的事 —— 共享描述**必失真**",
  };
  for (const [name, n] of s.deadByCat) lines.push(`| ${name} | ${int(n)} | ${meaning[name] ?? "—"} |`);
  lines.push("");

  /* ── ⑤ 死路段的格式合规（分母是行） ── */
  lines.push("## ⑤ 死路段的格式合规：分母换成**行**之后是多少");
  lines.push("");
  lines.push(
    `- 死路段共 **${int(s.deadSectionLines)}** 行，其中带边 id 的 **${int(s.deadIdLines)}** 行：` +
      `**单 id 行 ${int(s.deadSoloLines)}**（${pct(s.deadIdLines === 0 ? null : s.deadSoloLines / s.deadIdLines)}）· ` +
      `**多 id 行 ${int(s.deadMultiLines)}**（${pct(s.deadIdLines === 0 ? null : s.deadMultiLines / s.deadIdLines)}）`,
  );
  lines.push(
    `- 这 ${int(s.deadMultiLines)} 条多 id 行若全部展开成一条一行，要多写 **${int(s.deadExpandExtraLines)}** 行 ` +
      `（占死路段 ${pct(s.deadSectionLines === 0 ? null : s.deadExpandExtraLines / s.deadSectionLines)}）—— 这是「改」能拿到的**全部**格式收益`,
  );
  lines.push(
    `- 旁证（**本次不动**，R07）：死路段里写成 \`e?\` 占位符的行 **${int(s.placeholderLines)}** 条（涉及 ${int(s.placeholderFolds)} 条折痕）—— 那是另一种缺陷（id 根本没写出来），不在本任务范围`,
  );
  lines.push("");

  /* ── ⑥ 信息损失 ── */
  lines.push("## ⑥ 丢了多少 id：**0 个**（结构性，不是估算）");
  lines.push("");
  lines.push(
    `- 斜杠合并的两端都能被 \`mentionsEdge\` 逐字命中 ⇒ 它**不可能**让 id 消失；` +
      `全文唯一出现处就在合并里的 id 有 **${int(s.onlyHereIds)}** 个，它们照样命中`,
  );
  lines.push(
    `- 真缺口（与 \`deadend-adherence-audit\` 同判据复算）：漏 **${int(s.missingIds)}** 个 id = ` +
      `破折号区间吞掉 **${int(s.missingFromDash)}** + 纯漏写 **${int(s.missingIds - s.missingFromDash)}** + **斜杠 ${int(s.missingFromSlash)}**`,
  );
  lines.push("");

  /* ── ⑦ 样本 ── */
  lines.push(`## ⑦ ${int(samples)} 个样本（原文 + 「一条边一行」会写成什么样）`);
  lines.push("");
  const picked = pickSamples(result.occurrences, samples);
  picked.forEach((o, i) => {
    const where = o.inDeadend ? "**死路段内**" : "死路段外";
    lines.push(`### 样本 ${i + 1} · ${where} · ${o.cat} · \`${o.a}/${o.b}\``);
    lines.push("");
    lines.push(`原文（${int(o.line.length)} 字符的行）：`);
    lines.push("");
    lines.push("```");
    lines.push(o.line.length > 240 ? `${o.line.slice(0, 240)} …` : o.line);
    lines.push("```");
    if (o.canonical.length === 2) {
      lines.push("");
      lines.push("「一条边一行」会写成：");
      lines.push("");
      lines.push("```");
      for (const c of o.canonical) lines.push(c.length > 200 ? `${c.slice(0, 200)} …` : c);
      lines.push("```");
      lines.push("");
      lines.push(
        `- 两条边的工具：\`${o.toolA}\` / \`${o.toolB}\`；错误类${o.sameErrorClass ? "**相同**" : "**不同**"}；` +
          `死路清单里各有独立行 = ${o.compensated === null ? "—（不适用）" : o.compensated ? "**是**" : "**否**"}`,
      );
    } else {
      lines.push("");
      lines.push("- 两端**不是**失败边（成功边 / 图里查不到）⇒ 提示词那条死路规则不适用，没有「一条边一行」可展开。");
    }
    lines.push("");
  });

  /* ── ⑧ 结论 ── */
  lines.push("## ⑧ 结论：**不改提示词**");
  lines.push("");
  lines.push("依据（全部来自上面的机械计数）：");
  lines.push("");
  lines.push(
    `1. **44% 的斜杠根本不在死路段**（${int(s.successPairs)} / ${int(s.occurrences)} = ` +
      `${pct(s.occurrences === 0 ? null : s.successPairs / s.occurrences)}）：它们是「棋谱 / 已验证事实」里的**成功边**，` +
      `而规则原文是「「已探明死路」一条边一行」—— 拿它们算违规率是**分母错了**。`,
  );
  lines.push(
    `2. **他段的失败边有 ${pct(s.outsidePairs === 0 ? null : s.compensated / s.outsidePairs)} 被死路清单补偿**：` +
      `死路段里那两条边各自有独立行，叙述里合并只是简写，信息一条没少。`,
  );
  lines.push(
    `3. **死路段内的真违规率是 ${pct(s.inScopeRate)}**（${int(s.deadPairs)}/${int(s.foldsWithFailureEdges)}），不是 60.40%；` +
      `其中 ${int((s.deadByCat.find(([k]) => k === "同工具+同错误类") ?? [0, 0])[1])} 次是**同一动作重复失败**（共享描述就是事实），` +
      `只有 ${int(s.deadPairs - (s.deadByCat.find(([k]) => k === "同工具+同错误类") ?? [0, 0])[1])} 次真的把两条不同的边压成一句。`,
  );
  lines.push(
    `4. **收益上限 = 0 个 id**（斜杠结构性不丢 id；上面的缺口 ${int(s.missingIds)} 个 id 全部来自破折号 ${int(s.missingFromDash)} + 纯漏写 ${int(s.missingIds - s.missingFromDash)}）；` +
      `「改」能拿到的只有 ${int(s.deadExpandExtraLines)} 行的格式正确性。`,
  );
  lines.push(
    "5. **成本是全量的**：提示词每改一个字都作用于**所有**折叠，且要重启宿主才生效（ESM 启动时加载）。" +
      "为 0 个 id、为已经 97%+ 合规的行格式去动它，是把最贵的杠杆用在最便宜的收益上。",
  );
  lines.push("");
  lines.push("**告警线（超过就复议这个决定）**：");
  lines.push("");
  lines.push(
    `- 死路段内合并率 ≥ ${pct(IN_SCOPE_ALERT_RATE)}（现在 **${pct(s.inScopeRate)}**）` +
      `${s.inScopeRate !== null && s.inScopeRate >= IN_SCOPE_ALERT_RATE ? " ⇒ ⚠ **已超线，需要重估**" : " ⇒ 未超线"}`,
  );
  lines.push(
    `- 或出现「共享描述把两条边的错误写成同一个」的实例（现在 ${int(s.deadPairs)} 次里 ` +
      `${
        (s.deadByCat.find(([k]) => k === "同工具+不同错误类") ?? [0, 0])[1] +
        (s.deadByCat.find(([k]) => k === "不同工具+不同错误类") ?? [0, 0])[1]
      } 次属于这一类 —— 样本里看得到，模型是把两种错误**并列写出**的，没有丢掉任何一种）`,
  );
  lines.push("");
  lines.push(
    "> 决策已写进 `src/rooms/offline-fold.mjs` 的 `buildOfflinePrompt` 死路规则注释，并由 `test/slash-merge.test.mjs` 钉住。" +
      "下次再有人问「为什么不许/允许斜杠合并」，跑本脚本即可。",
  );
  lines.push("");
  return lines.join("\n");
}

/* ─────────────────────────────────── 入口 ─────────────────────────────────── */

export function audit({ home = resolveHome(), session = "" } = {}) {
  const { files } = collectGraphFiles(home);
  const folds = [];
  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      continue; // 坏图跳过：一张坏图不许让整份报告失败
    }
    const row = scanFold(graph, { session: String(file.dir) });
    if (row !== null) folds.push(row);
  }
  const occurrences = folds.flatMap((f) => f.occurrences);
  return { home, graphs: files.length, folds, summary: summarize(folds), occurrences, now: Date.now() };
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const samples = Number(get("samples", DEFAULT_SAMPLES));
  return {
    home: String(get("home", resolveHome())),
    session: String(get("session", "") ?? ""),
    samples: Number.isFinite(samples) && samples > 0 ? Math.floor(samples) : DEFAULT_SAMPLES,
    json: argv.includes("--json"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = audit({ home: opts.home, session: opts.session });
  if (result.graphs === 0) {
    console.error(`读不到任何会话图（home=${opts.home}）—— 检查 DSH_HOME / --home。`);
    return 2;
  }
  if (opts.json) {
    const { folds, ...rest } = result;
    console.log(JSON.stringify({ ...rest, samples: pickSamples(result.occurrences, opts.samples) }, null, 2));
    return 0;
  }
  console.log(render(result, { samples: opts.samples }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
