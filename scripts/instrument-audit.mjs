#!/usr/bin/env node
/**
 * instrument-audit.mjs —— 「折叠证据字段到底该不该有」的逐条判定（2026-11-05，C608）
 *
 * 为什么要它：真机 2026-11-05 03:1x，`doctor` 的「折叠证据字段（C398/C400）」报
 *   「最近 10 条 foldMark：usage.model 0 · finishReason 0 · measuredBefore 0 ⇒ 仪器未生效」，
 * 而同时「运行实例 buildId ≠ 磁盘」。两件事摆在一起，最容易得出的结论是"要重启" ——
 * 但那是**假设**，没人验证过。而它决定完全相反的两个动作：补字段（改 src/engine.mjs），
 * 还是改判据（分母里混进了"本来就不写这些字段"的 fold）。
 *
 * 为什么"本来就不写"是可能的：`graph.foldMarks` 有**四个写入点**，字段集各不相同 ——
 *   · `src/engine.mjs:3009`（`compactIfNeeded`：pressure / auto / context-overflow / archive /
 *     backfill / loop / disposed）⇒ 三个字段都写（`measuredBefore` 由 C400 的账本快照供，
 *     `finishReason` 由 C398 补上）
 *   · `src/engine.mjs:2671`（`recordFoldMark`：手动 `/compact`）⇒ 只写 `finishReason`
 *   · `src/engine.mjs:3201`（tier-2 分段合并）⇒ 一个都不写（**不调模型**，没有 usage/终止原因可言）
 *   · `src/rooms/offline-fold.mjs:808`（`archive-offline` 离线补折）⇒ 一个都不写：模型名落在
 *     `route.model`、截断证据落在 `truncated`。这两点各踩过一次 —— C604（180 条明明有
 *     `route.model`，判据只读 `usage.model` ⇒ 全判成"没有模型名"）、C584（`truncated` 没写进
 *     mark ⇒ 状态页永远报"新字段一个都没写"）。
 *
 * 所以"三个都是 0"可能有两个**性质完全不同**的原因，必须逐条说出**来路**与**该不该有**，
 * 而不是数一个总数。本脚本就是把这件判定固定下来，给 doctor 用同一个口径。
 *
 * 用法：
 *   node scripts/instrument-audit.mjs                      # 最近 10 条：逐条一行 + 统计 + 结论
 *   node scripts/instrument-audit.mjs --limit=20           # 换窗口
 *   node scripts/instrument-audit.mjs --sessions-dir=<dir> # 换数据源（测试夹具用）
 *   node scripts/instrument-audit.mjs --legacy             # 用**旧判据**（分母=全部）重算，供"旧判据会红"复现
 *   node scripts/instrument-audit.mjs --json               # 机读
 *
 * 退出码：0 = 判定完成（**"判据错"也是一个结论**，不是错误）；2 = 参数写错或数据源不存在。
 * 边界：只读（`graph.json` + delta 回放，与 doctor/fold-timeline 同源），不写盘、不跑模型。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";

/** C398（commit 1d7fc20）落地时刻：2026-11-03 05:03:58 +0800。更早的 foldMark 由**没有**这些字段的写入点产生。 */
export const C398_LANDED_AT = Date.parse("2026-11-02T21:03:58Z");

/** 默认窗口。与 doctor 的「最近 N 条」保持一致。 */
export const DEFAULT_LIMIT = 10;

/** 三种（+1 种"无需修复"）结论。前三条是任务书要求的原样措辞。 */
export const VERDICT = {
  INSTRUMENT: "仪器没生效",
  CRITERIA: "规则摘要路径本来就没有这些字段（doctor 判据错）",
  MIXED: "混合",
  HEALTHY: "无需修复（窗口内该有的 fold 都齐）",
};

/** 逐条判定里的"来路"标签（打印用；kind 是机读值）。 */
const KIND_LABEL = {
  model: "模型折叠",
  rules: "规则摘要降级",
  manual: "手动 /compact",
  offline: "离线补折",
  tier2: "tier-2 分段合并",
  legacy: "C398 前的旧记录",
};

/* ─────────────────────────── 字段探针 ─────────────────────────── */

/** `usage.model` 有没有值（C398 的原始判据）。 */
export function hasUsageModel(mark) {
  return typeof mark?.usage?.model === "string" && mark.usage.model !== "";
}

/** `route.model` 有没有值（C604：离线补折的模型名**只**落在这里）。 */
export function hasRouteModel(mark) {
  return typeof mark?.route?.model === "string" && mark.route.model !== "";
}

/** 「模型名有没有落点」= usage.model 或 route.model 任一个有值（C604 的口径）。 */
export function hasModelName(mark) {
  return hasUsageModel(mark) || hasRouteModel(mark);
}

/** `finishReason` 是**字符串**才算采集到（`null` = 没采集，不是"没有截断"）。 */
export function hasFinishReason(mark) {
  return typeof mark?.finishReason === "string";
}

/** `measuredBefore` 是**有限数**才算采集到（`null` = 没测，`0` 也不是有效测量）。 */
export function hasMeasuredBefore(mark) {
  return Number.isFinite(mark?.measuredBefore);
}

/* ─────────────────────── 来路 → 该不该有这些字段 ─────────────────────── */

/**
 * 一条 foldMark 的**来路**，以及**它的写入点本来会不会写**这些字段。
 *
 * 这是本脚本的核心判据（doctor 也用这一份，避免两边口径分裂）。每条规则都指到写入点源码行。
 *
 * @param {object} mark foldMark
 * @param {{c398At?: number}} [opts]
 * @returns {{
 *   kind: "model"|"rules"|"manual"|"offline"|"tier2"|"legacy",
 *   label: string, author: string,
 *   expects: {model: boolean, finish: boolean, measured: boolean},
 *   note: string
 * }}
 */
export function foldEvidenceExpectation(mark, opts = {}) {
  const c398At = Number.isFinite(opts?.c398At) ? opts.c398At : C398_LANDED_AT;
  const at = Number(mark?.at ?? 0);
  const trigger = typeof mark?.trigger === "string" ? mark.trigger : "(无 trigger)";
  const base = (kind, author, expects, note) => ({
    kind,
    label: KIND_LABEL[kind],
    author,
    expects: { model: false, finish: false, measured: false, ...expects },
    note,
  });

  // ① 离线补折：模型名 → route.model，截断 → truncated。三个字段都不是它的书写者。
  if (mark?.offline === true || trigger === "archive-offline") {
    return base("offline", "src/rooms/offline-fold.mjs:808", {}, "写入点只写 route.model + truncated，从不写这三个字段");
  }

  // ② tier-2：checkpoint 合并，**不调模型** ⇒ 没有 usage、没有终止原因。
  if (mark?.tier2 === true || trigger === "tier2") {
    return base("tier2", "src/engine.mjs:3201", {}, "分段合并不调模型 ⇒ 没有 usage/finishReason 可言");
  }

  // ③ C398 之前的旧记录：那时的写入点里根本没有这些字段（commit 1d7fc20 才加）。
  if (at > 0 && at < c398At) {
    return base("legacy", "(C398 之前的写入点)", {}, "C398 落地（2026-11-03 05:03）之前写下的，当时没有这些字段");
  }

  // ④ 规则摘要降级：没有模型调用 ⇒ 没有 usage.model / finishReason；但 `measuredBefore` 照写。
  if (mark?.fallback === "rules") {
    return base("rules", "src/engine.mjs:~2900（fallback=rules）", { measured: true }, "规则摘要不调模型 ⇒ 只有 measuredBefore 该有");
  }

  // ⑤ 手动 /compact：走 `recordFoldMark`，它只写 finishReason（不写 usage/measuredBefore）。
  if (trigger === "manual" || trigger === "host") {
    return base("manual", "src/engine.mjs:2671（recordFoldMark）", { finish: true }, "recordFoldMark 只写 finishReason");
  }

  // ⑥ 默认：`compactIfNeeded` 的模型路径 —— 三个字段都该有。
  return base("model", "src/engine.mjs:3009", { model: true, finish: true, measured: true }, "模型折叠路径，三个字段都该有");
}

/** 这条 foldMark 有没有"该写的字段"。没有 ⇒ 不该进 doctor 的分母。 */
export function hasExpectedEvidence(mark, opts = {}) {
  const { expects } = foldEvidenceExpectation(mark, opts);
  return expects.model || expects.finish || expects.measured;
}

/* ─────────────────────────── 逐条判定 ─────────────────────────── */

function isoOf(at) {
  const n = Number(at);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "(无 at)";
}

function shortSession(session) {
  const s = String(session ?? "");
  return s.replace(/^session-/, "").slice(0, 8) || "(未知会话)";
}

function oneRow(mark, index, opts) {
  const exp = foldEvidenceExpectation(mark, opts);
  const present = {
    model: hasModelName(mark),
    finish: hasFinishReason(mark),
    measured: hasMeasuredBefore(mark),
  };
  const missing = [];
  if (exp.expects.model && !present.model) missing.push("模型名");
  if (exp.expects.finish && !present.finish) missing.push("finishReason");
  if (exp.expects.measured && !present.measured) missing.push("measuredBefore");
  const expectsAny = exp.expects.model || exp.expects.finish || exp.expects.measured;
  return {
    index,
    at: Number(mark?.at ?? 0),
    atIso: isoOf(mark?.at),
    session: String(mark?.session ?? ""),
    trigger: typeof mark?.trigger === "string" ? mark.trigger : "(无 trigger)",
    kind: exp.kind,
    label: exp.label,
    author: exp.author,
    note: exp.note,
    expects: exp.expects,
    present,
    missing,
    needsEvidence: expectsAny,
    ok: expectsAny ? missing.length === 0 : true,
    values: {
      usageModel: hasUsageModel(mark) ? mark.usage.model : null,
      routeModel: hasRouteModel(mark) ? mark.route.model : null,
      finishReason: hasFinishReason(mark) ? mark.finishReason : null,
      measuredBefore: hasMeasuredBefore(mark) ? mark.measuredBefore : null,
    },
  };
}

/**
 * 窗口判定：最近 `limit` 条 foldMark 逐条判定 + 分字段统计 + 结论。
 *
 * 结论规则（`rawAllZero` = 旧判据在同一个窗口上数出来是不是全 0）：
 *   · 窗口里没有一条"该有" ⇒ **判据错**（doctor 的 0 是分母造成的假红）
 *   · "该有"的全缺 ⇒ **仪器没生效**
 *   · 一部分缺 ⇒ **混合**
 *   · 该有的都齐了，但窗口里仍有"本来不带"的 fold ⇒ **判据错**（分母确实混进了这些 fold；
 *     此时仪器已生效，两件事要分开说 —— `仪器：已生效` 另行打印）
 *   · 该有的都齐、窗口里也全是该有的 fold ⇒ **无需修复**（第 4 种：本窗口没有缺陷可修）
 *
 * @param {Array<object>} marks foldMark 列表（顺序无所谓，内部按 at 倒序）
 * @param {{limit?: number, c398At?: number}} [options]
 */
export function summarizeFoldEvidence(marks, options = {}) {
  const limit = Number.isFinite(options?.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const opts = { c398At: options?.c398At };
  const all = (Array.isArray(marks) ? marks : [])
    .filter((m) => m !== null && typeof m === "object")
    .slice()
    .sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0));
  const windowRows = all.slice(0, limit).map((m, i) => oneRow(m, i + 1, opts));

  const perField = {
    // `usage` / `route` 分开数：doctor 的旧文案与 C604 的读法都要能看见各自落点。
    model: { expect: 0, have: 0, usage: 0, route: 0 },
    finish: { expect: 0, have: 0 },
    measured: { expect: 0, have: 0 },
  };
  for (const row of windowRows) {
    for (const key of ["model", "finish", "measured"]) {
      if (!row.expects[key]) continue;
      perField[key].expect += 1;
      if (row.present[key]) perField[key].have += 1;
    }
    if (row.expects.model) {
      if (row.values.usageModel !== null) perField.model.usage += 1;
      if (row.values.routeModel !== null) perField.model.route += 1;
    }
  }

  // 旧判据（doctor C401 原文，**故意保留它的两个错误口径**）：分母 = 窗口内**全部** foldMark，
  // 且模型名**只读 `usage.model`**（C604 之前就是这么数的）。这里必须按旧口径复刻，
  // 否则"旧判据会不会红"就证明不了 —— 用新口径（认 route.model）去算旧判据，全 0 会算成非 0。
  const windowMarks = all.slice(0, limit);
  const oldCounts = {
    model: windowMarks.filter(hasUsageModel).length,
    finish: windowMarks.filter(hasFinishReason).length,
    measured: windowMarks.filter(hasMeasuredBefore).length,
  };
  const rawAllZero = oldCounts.model === 0 && oldCounts.finish === 0 && oldCounts.measured === 0;

  const byKind = {};
  for (const row of windowRows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

  const needs = windowRows.filter((r) => r.needsEvidence);
  const broken = needs.filter((r) => r.missing.length > 0);
  const stats = {
    window: windowRows.length,
    expected: needs.length,
    notApplicable: windowRows.length - needs.length,
    missing: broken.length,
    perField,
    byKind,
    oldCounts,
    rawAllZero,
    allExpectedMissing: needs.length > 0 && broken.length === needs.length,
  };

  let verdict;
  if (needs.length === 0) verdict = VERDICT.CRITERIA;
  else if (broken.length === needs.length) verdict = VERDICT.INSTRUMENT;
  else if (broken.length === 0) verdict = rawAllZero || needs.length < windowRows.length ? VERDICT.CRITERIA : VERDICT.HEALTHY;
  else verdict = VERDICT.MIXED;

  // 跨窗口证据：窗口内一条"该有"的都没有时，最近一条该有的是什么样（证明仪器到底活没活）。
  const latestExpectedMark = all.find((m) => hasExpectedEvidence(m, opts)) ?? null;
  const latestExpected = latestExpectedMark === null ? null : oneRow(latestExpectedMark, 0, opts);

  return { rows: windowRows, stats, verdict, latestExpected };
}

/**
 * 旧判据复刻（doctor C401 原文，**故意保留错误口径**）：分母 = 窗口内全部 foldMark。
 * 存在的意义只有两个：① 证明新判据改的是"分母"而不是"顺手放绿"；② 给"旧判据会红"当夹具。
 */
export function legacyEvidence(marks, options = {}) {
  const limit = Number.isFinite(options?.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const all = (Array.isArray(marks) ? marks : [])
    .filter((m) => m !== null && typeof m === "object")
    .slice()
    .sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0))
    .slice(0, limit);
  const counts = {
    window: all.length,
    model: all.filter((m) => hasUsageModel(m)).length,
    finish: all.filter((m) => hasFinishReason(m)).length,
    measured: all.filter((m) => hasMeasuredBefore(m)).length,
  };
  const allZero = counts.window > 0 && counts.model === 0 && counts.finish === 0 && counts.measured === 0;
  return {
    counts,
    allZero,
    verdict: allZero ? VERDICT.INSTRUMENT : null,
    detail:
      counts.window === 0
        ? "未采集（还没有 foldMark）"
        : `最近 ${counts.window} 条 foldMark：usage.model ${counts.model} · finishReason ${counts.finish} · measuredBefore ${counts.measured}` +
          (allZero ? " ⇒ **三个都是 0**：仪器未生效（C398/C400 需重启，或这几次走的是规则摘要）" : ""),
  };
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

const FLAG = (present, expects) => (expects ? (present ? "有" : "缺") : "—(不该有)");

/** 一条 foldMark 一行（人读）。 */
export function formatRow(row) {
  const v = row.values;
  // 模型名有两个落点（usage.model / route.model，见 C604）：只在"该有"时才判有/缺；
  // "不该有"的来路如果恰好写了 route.model，就把落点标出来（不写成"有"，免得与判据语义打架）。
  const modelWhere = v.usageModel ? "usage.model" : v.routeModel ? "route.model" : null;
  const modelCell = row.expects.model
    ? modelWhere
      ? `有(${modelWhere}=${v.usageModel ?? v.routeModel})`
      : "缺"
    : `—(不该有${modelWhere ? ` · ${modelWhere}=${v.usageModel ?? v.routeModel}` : ""})`;
  const finishCell = row.present.finish ? `有(${v.finishReason})` : FLAG(false, row.expects.finish);
  const measuredCell = row.present.measured ? `有(${v.measuredBefore})` : FLAG(false, row.expects.measured);
  const verdict = row.needsEvidence
    ? row.missing.length === 0
      ? "该有 · 都写了"
      : `**该有却没写：${row.missing.join("/")}**`
    : `本来就没有（${row.note}）`;
  return (
    `${String(row.index).padStart(2, " ")}  ${row.atIso}  ${shortSession(row.session)}  ` +
    `trigger=${row.trigger}  来路=${row.label}(${row.author})  ` +
    `model=${modelCell}  finishReason=${finishCell}  measuredBefore=${measuredCell}  ⇒ ${verdict}`
  );
}

/**
 * 整份报告（人读）。返回行数组。
 * @param {ReturnType<typeof summarizeFoldEvidence>} summary
 * @param {{legacy?: ReturnType<typeof legacyEvidence>, source?: string}} [extra]
 */
export function formatReport(summary, extra = {}) {
  const out = [];
  const st = summary.stats;
  out.push(`数据源：${extra.source ?? "(未知)"}`);
  out.push(`窗口：最近 ${st.window} 条 foldMark（按 foldMark.at 倒序）`);
  out.push("");
  for (const row of summary.rows) out.push(formatRow(row));
  out.push("");
  const kindParts = Object.entries(st.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`);
  out.push(
    `窗口构成：${kindParts.join(" · ") || "(空)"} ⇒ **该有 ${st.expected} 条 / 本来没有 ${st.notApplicable} 条**`,
  );
  const f = st.perField;
  out.push(
    `分字段（分母只算"写入点会写该字段"的 fold）：模型名 ${f.model.have}/${f.model.expect} · ` +
      `finishReason ${f.finish.have}/${f.finish.expect} · measuredBefore ${f.measured.have}/${f.measured.expect}` +
      ` ⇒ 该有却缺 **${st.missing}** 条`,
  );
  if (extra.legacy) {
    const lg = extra.legacy;
    out.push(`旧判据复刻（分母=全部 ${lg.counts.window} 条）：${lg.detail}`);
  }
  if (summary.latestExpected) {
    const le = summary.latestExpected;
    const v = le.values;
    out.push(
      `跨窗口证据：最近一条"该有"的 fold = ${le.atIso} · trigger=${le.trigger} · ${le.label} ⇒ ` +
        `模型名 ${le.present.model ? v.usageModel ?? v.routeModel : "缺"} · ` +
        `finishReason ${le.present.finish ? v.finishReason : "缺"} · ` +
        `measuredBefore ${le.present.measured ? v.measuredBefore : "缺"}`,
    );
  }
  // 「仪器活没活」与「判据对不对」是两件事，分开打：窗口里没有该有的 fold 时，
  // 用跨窗口的最近一条该有的 fold 来回答（而不是留一句"无从判定"）。
  const instrumentState =
    st.expected > 0
      ? st.missing === 0
        ? "已生效（窗口内该有的字段都写了）"
        : `未生效 / 有缺口（窗口内该有却缺 ${st.missing} 条）`
      : summary.latestExpected === null
        ? "无从判定（一条模型路径的 fold 都没有）"
        : summary.latestExpected.ok
          ? `已生效（本窗口没有该有的 fold；跨窗口最近一条 ${summary.latestExpected.atIso} 三个字段齐全）`
          : `未生效（本窗口没有该有的 fold；跨窗口最近一条 ${summary.latestExpected.atIso} 就缺字段）`;
  out.push(`仪器状态：${instrumentState}`);
  out.push(`结论：${summary.verdict}`);
  return out;
}

/* ─────────────────────────── 数据源 ─────────────────────────── */

/** 与 doctor / fold-timeline 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const raw = env?.DSH_HOME;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return nodePath.join(os.homedir(), ".dsh");
}

export function resolveSessionsDir({ env = process.env, sessionsDir = null } = {}) {
  if (typeof sessionsDir === "string" && sessionsDir.trim().length > 0) return sessionsDir.trim();
  return nodePath.join(resolveHome(env), "chess-context", "sessions");
}

/**
 * 收集所有会话的 foldMark（带 session 名）。
 * 刻意复用 `loadSessionGraph()`：它**会重放 delta**（C143 的教训 —— 只读 `graph.json`
 * 会拿到过期基线，最近的折叠恰好都在 delta 里）。doctor 用的是同一个 loader，
 * 所以这里的数字与 doctor 对得上（2026-11-05 实测两侧都是 387 条）。
 *
 * @param {{sessionsDir: string}} args
 * @returns {{marks: Array<object>, sessions: number, unreadable: number}}
 */
export function collectFoldMarks({ sessionsDir }) {
  const marks = [];
  let sessions = 0;
  let unreadable = 0;
  if (!nodeFs.existsSync(sessionsDir)) return { marks, sessions, unreadable };
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let loaded;
    try {
      loaded = loadSessionGraph(graphFile);
    } catch {
      unreadable += 1;
      continue;
    }
    sessions += 1;
    for (const mark of Array.isArray(loaded?.graph?.foldMarks) ? loaded.graph.foldMarks : []) {
      marks.push({ ...mark, session: entry.name });
    }
  }
  return { marks, sessions, unreadable };
}

/* ─────────────────────────── CLI ─────────────────────────── */

export function parseArgs(argv = []) {
  const args = { limit: DEFAULT_LIMIT, legacy: false, json: false, help: false, sessionsDir: null };
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (arg === "--json") args.json = true;
    else if (arg === "--legacy") args.legacy = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(n) || n <= 0) args.error = `--limit= 需要正整数，收到 ${JSON.stringify(arg)}`;
      else args.limit = n;
    } else if (arg.startsWith("--sessions-dir=")) args.sessionsDir = arg.slice("--sessions-dir=".length);
    else args.error = `未知参数 ${JSON.stringify(arg)}`;
  }
  return args;
}

const HELP = `instrument-audit —— 折叠证据字段逐条判定（C608）

用法：
  node scripts/instrument-audit.mjs                 # 最近 10 条：逐条一行 + 统计 + 结论
  node scripts/instrument-audit.mjs --limit=20
  node scripts/instrument-audit.mjs --sessions-dir=<dir>
  node scripts/instrument-audit.mjs --legacy        # 旧判据（分母=全部）重算，复现"假红"
  node scripts/instrument-audit.mjs --json

结论只有三种（外加"无需修复"）：
  · 仪器没生效
  · 规则摘要路径本来就没有这些字段（doctor 判据错）
  · 混合
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.error) {
    console.error(`✗ ${args.error}`);
    console.error(HELP);
    return 2;
  }
  const sessionsDir = resolveSessionsDir({ sessionsDir: args.sessionsDir });
  if (!nodeFs.existsSync(sessionsDir)) {
    console.error(`✗ 数据源不存在：${sessionsDir}（用 --sessions-dir=<dir> 或设 DSH_HOME）`);
    return 2;
  }
  const { marks, sessions, unreadable } = collectFoldMarks({ sessionsDir });
  const source = `${sessionsDir}（${sessions} 个会话 · ${marks.length} 条 foldMark${unreadable > 0 ? ` · ${unreadable} 个图读不出` : ""}）`;

  if (marks.length === 0) {
    if (args.json) console.log(JSON.stringify({ source, window: [], verdict: null, note: "没有 foldMark" }, null, 1));
    else console.log(`${source}\n\n没有 foldMark —— 无从判定（这不是"仪器没生效"的证据）。`);
    return 0;
  }

  const summary = summarizeFoldEvidence(marks, { limit: args.limit });
  const legacy = args.legacy ? legacyEvidence(marks, { limit: args.limit }) : null;

  if (args.json) {
    console.log(JSON.stringify({ source, ...summary, legacy }, null, 1));
    return 0;
  }

  console.log("== 折叠证据字段逐条判定（C608） ==");
  for (const line of formatReport(summary, { legacy, source })) console.log(line);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isMain) process.exit(main());
