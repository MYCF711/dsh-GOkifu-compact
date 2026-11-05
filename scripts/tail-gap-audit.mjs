#!/usr/bin/env node
/**
 * tail-gap-audit.mjs —— 「归档时的未折尾巴」与「现在到底还欠多少」的**逐会话对账**（C649）
 *
 * ## 由来（2026-11-05 真机，Lead 观测到的数字矛盾）
 *
 * 同一台机器、同一时刻，两个工具给出差 10 倍的数字：
 *
 * ```
 * scripts/backfill-forecast.mjs  →  欠账 7 个会话 / 6,164 事件 / 需 29 段
 * scripts/doctor.mjs     C516    →  71 个会话归档时仍有 ≥1000 事件未折（合计 146,981）
 * ```
 *
 * 71 与 7 **不是同一批会话，也不是同一时刻**，两个数都没有算错：
 *
 *   · **doctor 的口径**：`closeout.eventsSinceLastFold` —— 归档**那一刻**写下的快照，
 *     写完就不再变；判据只要求「有 closeout」，不问那之后又折过多少。
 *     它回答的是历史问题：「归档时到底落下多少没折」。
 *   · **debt 的口径**：`debtOfGraph().due` —— **现在**现算（`maxSeq − 最后一条 foldMark.seqEnd`），
 *     且要求「未结清」。它回答的是运维问题：「现在还有什么值得再花一次模型调用」。
 *
 * 本脚本把两套口径摆在同一行上逐个对账，并回答第三个问题：
 * **不 due 的那些，是补完了、补不了、还是被口径挡住了。**
 *
 * ## 它证明过的两类「不是时间差」的分歧（C649）
 *
 * ① **小缺口压制尾巴**（已修，`closeout-backfill.mjs`）：
 *    离线补折常留下一个很小的前缀缺口（真机 5–11 个事件），而老判据写成
 *    `due = 有洞 ? 洞≥阈值 : 未结清 && 尾巴≥阈值` —— **有洞就只看洞**。
 *    于是「折了一段、还有 1000+ 事件尾巴」的会话从欠账里**整段消失**
 *    （同一个 closeout 里明明写着 `offlineUncoveredTail: {events: 339}`）。
 *    本机实测：39 个会话 / 29,069 事件就是这么消失的。
 * ② **closeout 判结清但尾巴还在**（未修，属产品决策）：
 *    `closeoutSettles` 对「有 folded 判决」或「C466 之前的老记录」返回结清，
 *    于是 `!closedOut` 直接把整条尾巴挡在欠账之外。本机 26 个会话属于这一类。
 *
 * ## 边界
 *
 * **只读**：不写盘、不调模型、不 resume 任何会话（唯一的外部读是 `<home>/chess-context` 与
 * `<home>/sessions`）。判据一律走**真函数**（`debtOfGraph` / `loadSessionGraph`），不另起一套。
 *
 * 用法：
 *   node scripts/tail-gap-audit.mjs                       # 默认 --home $DSH_HOME
 *   node scripts/tail-gap-audit.mjs --home "D:/DeepSeek Harness/home"
 *   node scripts/tail-gap-audit.mjs --min 40              # due 阈值（与 closeoutMinEvents 同义）
 *   node scripts/tail-gap-audit.mjs --tail 1000           # doctor 那条的「大尾巴」阈值
 *   node scripts/tail-gap-audit.mjs --json                # 机读
 *
 * 退出码：0 正常；2 找不到图目录（没数据可对账，不是错误）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { debtOfGraph, DEFAULT_MIN_EVENTS } from "../src/rooms/closeout-backfill.mjs";
import { listSessionLogs } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

/** doctor C516 那条检查的「大尾巴」门槛（≥ 这个数才进榜）。 */
export const BIG_TAIL_MIN = 1000;

/**
 * ★ C649：**与 `scripts/doctor.mjs` 的 C516 块逐字同构**的归档尾巴判据。
 *
 * 为什么抄一份而不是 import：doctor 是**模块级执行**的脚本（import 它就会跑完整体检、还会
 * 在 stdout 打一屏），没法当库用；而这个判据很短（10 行），抄过来比把 doctor 拆成库安全得多。
 * 代价是两边可能漂 —— 所以 `test/tail-gap.test.mjs` 会**拿 doctor 的真实输出对账**：
 * 同一个夹具下，本函数的数必须与 doctor 报的数一致，漂了就红。
 *
 * 语义（C604 之后）：
 *   · `closeout.eventsSinceLastFold` 有值 ⇒ 用它（**快照**，归档那一刻的尾巴）；
 *   · 没值 ⇒ 现算 `maxEventSeq − max(foldMark.seqEnd)`（注意是 **max**，不是「最后一条」——
 *     老代码拿 `lastFoldSeq` 当尾巴，把「折到哪」当「还剩多少」）；
 *   · 连节点 seq 都没有 ⇒ `null`（**未采集**，不许编造数字进榜）。
 *
 * @param {object} graph 已重放 delta 的图
 * @returns {{tail:number|null, from:"closeout.eventsSinceLastFold"|"computed"|"unmeasured",
 *            lastEnd:number, maxEventSeq:number, nodes:number, marks:number, closed:boolean}}
 */
export function archiveTailOf(graph) {
  const marks = (Array.isArray(graph?.foldMarks) ? graph.foldMarks : []).filter((m) => Number.isFinite(m?.seqEnd));
  const lastEnd = marks.length > 0 ? Math.max(...marks.map((m) => Number(m.seqEnd))) : 0;
  let maxEventSeq = 0;
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    if (Number.isFinite(seq) && seq > maxEventSeq) maxEventSeq = seq;
  }
  const closed = graph?.closeout !== undefined && graph?.closeout !== null;
  const raw = graph?.closeout?.eventsSinceLastFold;
  let tail = null;
  let from = "unmeasured";
  if (Number.isFinite(Number(raw))) {
    tail = Math.max(0, Number(raw));
    from = "closeout.eventsSinceLastFold";
  } else if (maxEventSeq > 0) {
    tail = Math.max(0, maxEventSeq - lastEnd);
    from = "computed";
  }
  return { tail, from, lastEnd, maxEventSeq, nodes: Object.keys(graph?.nodes ?? {}).length, marks: marks.length, closed };
}

/**
 * 给一行下判决 —— **分类**（能补 / 补不了 / 已补完 / 口径挡住）。
 *
 * 顺序有意义：
 *   ① 图读不出、日志没了、图上 0 节点 ⇒ **补不了**（无论欠多少，都动不了）；
 *   ② `due` ⇒ 能补（这就是面板/自动补账会挑的那种）；
 *   ③ closeout 判结清但尾巴还 ≥ 阈值 ⇒ 口径挡住（不是"补完了"，是"不追"）；
 *   ④ 剩下的都 < 阈值 ⇒ 已补完（含"只差一个小缺口、不值得再折"）。
 *
 * @param {object} row {@link auditHome} 的产出一行
 * @param {{minEvents?:number}} [options]
 * @returns {{code:string, label:string, canFix:boolean}}
 */
export function classifyRow(row, { minEvents = DEFAULT_MIN_EVENTS } = {}) {
  const min = Number(minEvents) > 0 ? Number(minEvents) : DEFAULT_MIN_EVENTS;
  const tail = Number(row?.tailNow) || 0;
  const gap = Number(row?.gap) || 0;
  // 「小缺口压制尾巴」的形状：未结清 + 缺口小于阈值 + 尾巴还很大。
  // C649 之前这种行会被判成"不欠"（尾巴整段消失）；之后判 due。形状本身要一直能数出来，
  // 否则下一次回归没人看得见。
  const suppressedShape = row?.closedOut !== true && gap > 0 && gap < min && tail >= min;
  if (row?.loadError) return { code: "bad-graph", label: "图读不出（补不了）", canFix: false };
  if (row?.hasLog === false) return { code: "no-log", label: "会话日志已不在（补不了）", canFix: false };
  if (Number(row?.nodes) === 0) return { code: "empty-graph", label: "图上 0 个节点 ⇒ 算不出折叠区间（补不了）", canFix: false };
  if (row?.due === true) {
    return {
      code: "due",
      label: `欠账（尾巴 ${tail} ≥ ${min}${gap > 0 ? ` · 另有缺口 ${gap}` : ""}）${suppressedShape ? " · 小缺口压制形状（C649 修）" : ""}`,
      canFix: true,
    };
  }
  if (suppressedShape) {
    return {
      code: "gap-suppressed",
      label: `**小缺口压制**：缺口 ${gap} < ${min}，尾巴 ${tail} 被整段忽略（旧判据）`,
      canFix: true,
    };
  }
  if (row?.closedOut === true && (tail >= min || gap >= min)) {
    return {
      code: "settled-big-tail",
      label: `closeout 判结清，但尾巴 ${tail}${gap > 0 ? ` / 缺口 ${gap}` : ""} 还在（marks=${row?.marks ?? 0}）⇒ 当前口径不追`,
      canFix: false,
    };
  }
  if (tail < min && gap < min) {
    return { code: "done", label: `已折完（尾巴 ${tail}${gap > 0 ? ` · 缺口 ${gap}` : ""} < ${min}）`, canFix: false };
  }
  return { code: "other", label: `其它（尾巴 ${tail} · 缺口 ${gap} · 结清=${row?.closedOut === true}）`, canFix: false };
}

/**
 * ★ C649：**用两个合成图探出「现在这份 `debtOfGraph` 的实际判据」**。
 *
 * 为什么探而不是写死一句话：这份报告要能同时贴「修前 / 修后」两次输出，
 * 而判据就在被测的那份代码里。写死描述的话，修前那次会显示修后的文案 —— 那份证据就废了。
 * 两个探针只差一个"5 个事件的小缺口"，其余完全相同：
 *   · 两个都说 due   ⇒ 缺口与尾巴**各自独立**判（C649 之后）；
 *   · 带洞的说不欠    ⇒ **有缺口就只看缺口**（C649 之前的旧判据，尾巴被整段忽略）。
 *
 * @param {{minEvents?:number}} [options]
 * @returns {{gapSuppressesTail:boolean, withGap:boolean, withoutGap:boolean, text:string}}
 */
export function detectDueRule({ minEvents = DEFAULT_MIN_EVENTS } = {}) {
  const min = Number(minEvents) > 0 ? Number(minEvents) : DEFAULT_MIN_EVENTS;
  const build = (gap) => ({
    // 尾巴 ~1000 事件、没有折痕；有洞那版再挂一个远小于阈值的缺口
    nodes: { n1: { seq: 1 }, n2: { seq: 1001 } },
    foldMarks: [],
    closeout:
      gap > 0
        ? { at: 1, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true, partial: true, offlineUncoveredHead: { from: 1, events: gap } }
        : { at: 1, source: "archive-offline", foldAttempted: true, folded: 0, foldError: "probe" },
  });
  const withGap = debtOfGraph(build(5), { minEvents: min }).due === true;
  const withoutGap = debtOfGraph(build(0), { minEvents: min }).due === true;
  const gapSuppressesTail = withGap === false && withoutGap === true;
  return {
    gapSuppressesTail,
    withGap,
    withoutGap,
    text: gapSuppressesTail
      ? "**有缺口就只看缺口**（旧判据：尾巴 1000 被 5 个事件的缺口整段忽略）"
      : "缺口与尾巴**各自独立**判（C649 起：5 个事件的小缺口不再吃掉 1000 的尾巴）",
  };
}

/**
 * 汇总分类计数（**报告里的"数字分解"就是这段**）。
 * @param {Array<object>} rows
 * @param {{minEvents?:number}} [options]
 * @returns {object}
 */
export function summarizeRows(rows, { minEvents = DEFAULT_MIN_EVENTS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = new Map();
  const sum = { tail: 0, gap: 0 };
  const out = {
    total: list.length,
    dueNow: 0,
    dueNowTail: 0,
    cannot: { total: 0, noLog: 0, emptyGraph: 0, badGraph: 0, tail: 0 },
    done: 0,
    settledBigTail: 0,
    settledBigTailTail: 0,
    settledNoMarks: 0,
    other: 0,
    // 「小缺口压制尾巴」的形状：被 C649 修掉的那一类（现在它们已经 due，但形状要能数出来）
    gapSuppressedShape: 0,
    gapSuppressedTail: 0,
    gapSuppressedFixed: 0,
  };
  const min = Number(minEvents) > 0 ? Number(minEvents) : DEFAULT_MIN_EVENTS;
  for (const row of list) {
    const { code } = classifyRow(row, { minEvents: min });
    const tail = Number(row?.tailNow) || 0;
    const gap = Number(row?.gap) || 0;
    buckets.set(code, (buckets.get(code) ?? 0) + 1);
    sum.tail += tail;
    sum.gap += gap;
    // 「小缺口压制尾巴」的形状：被 C649 修掉的那一类。**形状一直数**，
    // 因为修好之后它们会变成 due（`gapSuppressedFixed` 就是"已经被救回来"的个数）。
    if (row?.loadError == null && row?.closedOut !== true && gap > 0 && gap < min && tail >= min) {
      out.gapSuppressedShape += 1;
      out.gapSuppressedTail += tail;
      if (row?.due === true) out.gapSuppressedFixed += 1;
    }
    if (code === "due") {
      out.dueNow += 1;
      out.dueNowTail += tail;
    } else if (code === "gap-suppressed") {
      // 已经被上面那条形状统计数过了 —— 它**现在不 due**，别混进"能补"
    } else if (code === "no-log" || code === "empty-graph" || code === "bad-graph") {
      out.cannot.total += 1;
      out.cannot.tail += tail;
      if (code === "no-log") out.cannot.noLog += 1;
      if (code === "empty-graph") out.cannot.emptyGraph += 1;
      if (code === "bad-graph") out.cannot.badGraph += 1;
    } else if (code === "settled-big-tail") {
      out.settledBigTail += 1;
      out.settledBigTailTail += tail;
      if (Number(row?.marks) === 0) out.settledNoMarks += 1;
    } else if (code === "done") {
      out.done += 1;
    } else {
      out.other += 1;
    }
  }
  return { ...out, tailSum: sum.tail, gapSum: sum.gap, buckets: Object.fromEntries(buckets) };
}

/**
 * 读 `auto-backfill-state.json`（只读）—— 「最近一轮挑过谁、结局是什么」。
 * 冷却（45 分钟）是引擎内存里的 Map，磁盘上只有这一份痕迹；它**不影响 `due`**，只影响每轮挑谁。
 * @param {string} chessRoot `<home>/chess-context`
 * @returns {{at:number|null, byId:Map<string, object>}}
 */
export function readBackfillState(chessRoot) {
  const file = nodePath.join(String(chessRoot ?? ""), "auto-backfill-state.json");
  const byId = new Map();
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
      const id = String(r?.id ?? "");
      if (id !== "") byId.set(id, r);
    }
    return { at: Number.isFinite(Number(parsed?.at)) ? Number(parsed.at) : null, byId };
  } catch {
    return { at: null, byId };
  }
}

/**
 * 扫描整个 home，逐会话算两套口径。
 *
 * @param {object} options
 * @param {string} options.home DSH home
 * @param {number} [options.minEvents] `debtOfGraph` 的阈值（默认 40，与 `closeoutMinEvents` 同义）
 * @param {number} [options.tailMin] 进入「大尾巴」榜的门槛（默认 1000，与 doctor C516 同义）
 * @param {(id:string)=>boolean} [options.isArchived] 归档判定（可选，只用于报告列）
 * @returns {{scanned:number, rows:object[], big:object[], state:object, logRoot:boolean}}
 */
export function auditHome({ home = "", minEvents = DEFAULT_MIN_EVENTS, tailMin = BIG_TAIL_MIN, isArchived = null } = {}) {
  const root = nodePath.join(String(home), "chess-context", "sessions");
  const sessionsRoot = nodePath.join(String(home), "sessions");
  const logRoot = nodeFs.existsSync(sessionsRoot);
  const logs = (() => {
    try {
      return listSessionLogs(String(home));
    } catch {
      return [];
    }
  })();
  const state = readBackfillState(nodePath.join(String(home), "chess-context"));
  const rows = [];
  const entries = nodeFs.existsSync(root) ? nodeFs.readdirSync(root, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    const id = entry.name;
    const short = id.replace(/^session-/, "");
    // `null` = **未采集**（这台 home 根本没有 `<home>/sessions`，例如夹具/隔离 home）——
    // 不许把"没扫到日志目录"说成"日志已不在"，那是两条完全不同的结论。
    const hasLog = logRoot ? logs.some((p) => p.includes(short)) : null;
    let loaded = null;
    try {
      loaded = loadSessionGraph(file);
    } catch (error) {
      rows.push({
        sessionId: id,
        short8: short.slice(0, 8),
        loadError: String(error?.message ?? error).slice(0, 120),
        hasLog,
        logRoot,
        archived: isArchived === null ? null : Boolean(isArchived(id)),
        lastPick: state.byId.get(id) ?? null,
      });
      continue;
    }
    const g = loaded.graph;
    const snap = archiveTailOf(g);
    const debt = debtOfGraph(g, { minEvents });
    rows.push({
      sessionId: id,
      short8: short.slice(0, 8),
      loadError: null,
      hasLog,
      logRoot,
      archived: isArchived === null ? null : Boolean(isArchived(id)),
      nodes: snap.nodes,
      marks: snap.marks,
      closed: snap.closed,
      tailArchive: snap.tail,
      tailFrom: snap.from,
      tailNow: debt.tail,
      gap: debt.gapEvents,
      closedOut: debt.closedOut,
      folded: debt.folded,
      due: debt.due,
      maxSeq: debt.maxSeq,
      lastFoldSeq: debt.lastFoldSeq,
      source: typeof g?.closeout?.source === "string" ? g.closeout.source : null,
      lastPick: state.byId.get(id) ?? null,
    });
  }
  const big = rows.filter((r) => r.loadError === null && r.closed === true && r.tailArchive !== null && r.tailArchive >= Number(tailMin));
  return { scanned: rows.length, rows, big, state, logRoot };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

function pad(text, width) {
  // 中文字符按 2 列算 —— 否则 `toLocaleString`/中文标签会把表格挤歪
  const s = String(text ?? "");
  let w = 0;
  for (const ch of s) w += /[\u2e80-\uffff]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

function main() {
  const args = process.argv.slice(2);
  const pick = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const home = pick("--home", process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh"));
  const minEvents = Number(pick("--min", DEFAULT_MIN_EVENTS)) || DEFAULT_MIN_EVENTS;
  const tailMin = Number(pick("--tail", BIG_TAIL_MIN)) || BIG_TAIL_MIN;
  const asJson = args.includes("--json");
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) {
    console.log(`找不到图目录：${root}（这台机器上没有可对账的数据）`);
    return 2;
  }
  const archived = (() => {
    try {
      const j = JSON.parse(nodeFs.readFileSync(nodePath.join(home, "storages", "workspace.json"), "utf8"));
      const set = new Set((j?.global?.archivedSessionIds ?? []).map(String));
      return (id) => set.has(id) || set.has(`session-${String(id).replace(/^session-/, "")}`);
    } catch {
      return null;
    }
  })();
  const t0 = Date.now();
  const rule = detectDueRule({ minEvents });
  const report = auditHome({ home, minEvents, tailMin, isArchived: archived });
  const ms = Date.now() - t0;
  const bigRows = [...report.big].sort((a, b) => Number(b.tailArchive) - Number(a.tailArchive));
  const stats = summarizeRows(bigRows, { minEvents });
  const bigArchiveSum = bigRows.reduce((s, r) => s + (Number(r.tailArchive) || 0), 0);
  // 反方向：现在 due、但不在「归档时大尾巴」榜里的那些 —— 多半是还没归档的活会话
  const dueAll = report.rows.filter((r) => r.loadError === null && r.due === true);
  const dueOutside = dueAll.filter((r) => !report.big.includes(r));
  const dueInside = dueAll.filter((r) => report.big.includes(r));
  const sum = (list, key) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          at: Date.now(),
          home,
          scanMs: ms,
          scanned: report.scanned,
          minEvents,
          tailMin,
          logRoot: report.logRoot,
          big: { sessions: bigRows.length, archiveTailSum: bigArchiveSum, stats, rows: bigRows },
          dueAll: { sessions: dueAll.length, tailSum: sum(dueAll, "tailNow"), gapSum: sum(dueAll, "gap"), insideBig: dueInside.length, outsideBig: dueOutside.length },
          dueOutside,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const line = (s = "") => console.log(s);
  line(`== 归档尾巴缺口审计（只读）==  ${home}`);
  line(`口径 A（doctor C516）：closeout.eventsSinceLastFold = **归档那一刻的快照**，缺失时现算 maxSeq − max(foldMark.seqEnd)`);
  line(`口径 B（debt）：debtOfGraph() 现算 tail = maxSeq − 最后一条 foldMark.seqEnd；due 判据探针：${rule.text}`);
  line(`扫描 ${report.scanned} 个有 graph.json 的会话 · ${(ms / 1000).toFixed(1)}s · 会话日志目录${report.logRoot ? "在" : "**不在**"}`);
  line(`归档时尾巴 ≥${tailMin} 的：**${bigRows.length}** 个（合计 ${bigArchiveSum.toLocaleString("en-US")}）· 其中现在 due 的：**${stats.dueNow}** 个（合计 ${stats.dueNowTail.toLocaleString("en-US")}）`);
  line();
  line("— 逐条（口径 A 的每一个）—   * = closeout 缺 eventsSinceLastFold，归档时尾巴是现算的（C604 兜底）");
  line(`  ${pad("#", 4)}${pad("id", 11)}${pad("归档时", 10)}${pad("现在尾巴", 10)}${pad("缺口", 7)}${pad("结清", 6)}${pad("在due", 7)}判定 / 为什么不在 due 里`);
  bigRows.forEach((row, i) => {
    const { label } = classifyRow(row, { minEvents });
    const pickNote = row.lastPick ? ` · 最近一轮：${String(row.lastPick.stopped ?? row.lastPick.error ?? "?").slice(0, 40)}` : "";
    // `*` = 这条 closeout 没有 `eventsSinceLastFold`，归档时尾巴是**现算**的（C604 的兜底）
    const from = row.tailFrom === "computed" ? "*" : "";
    line(
      `  ${pad(i + 1, 4)}${pad(row.short8, 11)}${pad(`${row.tailArchive}${from}`, 10)}${pad(row.tailNow, 10)}${pad(row.gap, 7)}${pad(
        row.closedOut ? "是" : "否",
        6,
      )}${pad(row.due ? "是" : "否", 7)}${label}${pickNote}`,
    );
  });
  line();
  line("— 分类统计（就是这 71 个的分解）—");
  line(`  能补（现在 due）        ：${stats.dueNow} 个 · 合计尾巴 ${stats.dueNowTail.toLocaleString("en-US")}`);
  line(`  补得了但没进队列        ：${stats.gapSuppressedShape - stats.gapSuppressedFixed} 个（被旧判据的「有洞只看洞」挡住）`);
  line(
    `    其中「小缺口压制」形状：${stats.gapSuppressedShape} 个 · 合计尾巴 ${stats.gapSuppressedTail.toLocaleString("en-US")}` +
      (rule.gapSuppressesTail
        ? `（旧判据下**全部被忽略**：${stats.gapSuppressedShape - stats.gapSuppressedFixed} 个判成不欠）`
        : `（C649 起已计入欠账：${stats.gapSuppressedFixed} 个恢复可见）`),
  );
  line(`  补不了                  ：${stats.cannot.total} 个（图里 0 节点 ${stats.cannot.emptyGraph} · 日志缺失 ${stats.cannot.noLog} · 坏图 ${stats.cannot.badGraph}）`);
  line(`  已补完（< ${minEvents}）           ：${stats.done} 个`);
  line(`  口径挡住（closeout 判结清，尾巴仍在）：${stats.settledBigTail} 个 · 合计尾巴 ${stats.settledBigTailTail.toLocaleString("en-US")}（其中图上一条折痕都没有 ${stats.settledNoMarks} 个）`);
  if (stats.other > 0) line(`  其它                    ：${stats.other} 个`);
  line();
  line("— 反方向：现在 due 但**不在**上面榜单里的 —");
  const archOutside = dueOutside.filter((r) => r.archived === true).length;
  line(
    `  ${dueOutside.length} 个（合计尾巴 ${sum(dueOutside, "tailNow").toLocaleString("en-US")}）：` +
      `已归档 ${archOutside} 个（归档那一刻的尾巴 < ${tailMin}，所以进不了口径 A 的榜）· 未归档 ${dueOutside.length - archOutside} 个`,
  );
  for (const row of dueOutside.sort((a, b) => Number(b.tailNow) - Number(a.tailNow)).slice(0, 10)) {
    const log = row.hasLog === null ? "日志目录未采集" : row.hasLog ? "日志在" : "**日志缺失**";
    const arch = row.archived === null ? "" : row.archived ? " · 已归档" : " · 未归档";
    line(`    ${pad(row.short8, 11)}尾巴 ${pad(row.tailNow, 6)}缺口 ${pad(row.gap, 5)}${log}${arch} · closeout=${row.source ?? "无"}`);
  }
  if (dueOutside.length > 10) line(`    …另 ${dueOutside.length - 10} 个（--json 可看全量）`);
  line(`  ⇒ 未归档的那些是活会话/没有 closeout 的，尾巴正在长，收尾时自动处理；已归档的那些是「归档时尾巴不够大」。`);
  line();
  line("— 一句话 —");
  line(
    `口径 A 的 ${bigRows.length} 个与现在 due 的 ${dueAll.length} 个，**交集只有 ${dueInside.length} 个**：` +
      `${bigRows.length} 里 ${stats.dueNow} 个现在真欠、${stats.done} 个已折完、${stats.settledBigTail} 个被 closeout 判结清、${stats.cannot.total} 个补不了；` +
      `due 的另外 ${dueOutside.length} 个根本不在 A 的榜单里（未归档 ${dueOutside.length - archOutside} · 归档时尾巴不足 ${tailMin} 的 ${archOutside}）。`,
  );
  line(
    `  两个数字都对，只是回答的不是同一个问题；唯一真正的错是「小缺口把大尾巴挤掉」那 ${stats.gapSuppressedShape} 个` +
      (rule.gapSuppressesTail ? "（**还没修**：判据仍是有洞只看洞）" : "（C649 已修）") +
      "。",
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
