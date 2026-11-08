/**
 * live-folds.mjs —— 把 live `foldMarks` 汇总成可引用的证据（**默认只打印**；--write 才落盘）
 *
 * 为什么需要它：`doctor` 只看最近 fold 的几个数，`evidence/折叠成本-实测-*.md` 是手工汇总；
 * 每轮巡检要回答「这次 fold 有没有 trigger / quality / closure」「成本效率多少」，
 * 手工抄数会漂。这里一次生成 `evidence/live-folds.json` + `.md`，字段全来自
 * `<DSH_HOME>/chess-context/sessions/<sid>/graph.json` 的 `foldMarks[i]`（provider 真实回报）。
 *
 * 只读：不写 home，不碰 profile patch；输出目录默认 `evidence/`（仓库内）。
 *
 * ★ t3（公开脱敏与快照语义）：证据页会进公开仓库，所以**运行时标识不进证据**：
 *   · `sessionId` 只写稳定 pseudonym `s_<12hex>`（同一 id 永远同名；加盐见 `pseudonymOf`）；
 *   · `home` 只写 `<DSH_HOME>`（真实路径不落盘）；闭包链 offender / 会话分布 top 同样脱敏。
 *   同时把「新增 fold N 次」改写成「**净变化** N 次（本次快照 − 上次快照）」，
 *   并在证据页显式声明：本页是快照、不是累计台账。
 *
 * 用法：
 *   node scripts/live-folds.mjs                     # 读 DSH_HOME（或 ~/.dsh），**只打印摘要**（安全默认）
 *   node scripts/live-folds.mjs --write             # 落盘 evidence/live-folds.{json,md}
 *   node scripts/live-folds.mjs --home D:/x/home    # 指定 home
 *   node scripts/live-folds.mjs --previous <file>   # 与哪份旧快照对比（默认 = 同目录同名 .json）
 *   node scripts/live-folds.mjs --salt <salt>       # pseudonym 的盐（默认取 GOKIFU_PSEUDONYM_SALT / 固定值）
 *   node scripts/live-folds.mjs --dry-run           # 同默认（保留旧参数，向后兼容）
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";

const REPO = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA = "gokifu/live-folds/v1";

/** 公开证据里 home 的固定写法（真实路径不落盘）。 */
export const HOME_REDACTED = "<DSH_HOME>";

/** pseudonym 前缀；`s_` + 12 位十六进制 = 48 bit，会话量级下碰撞可忽略。 */
export const PSEUDONYM_PREFIX = "s_";

/** 默认盐是**公开固定值**（保证跨运行/跨机器同名）；换成私有盐见 `pseudonymOf` 的说明。 */
export const DEFAULT_PSEUDONYM_SALT = "gokifu/live-folds/v1";

/**
 * 把运行时会话 id 映射成**稳定 pseudonym**（`s_<12hex>`）。
 *
 * · 稳定：同一原始 id 在默认盐下永远得到同一个 pseudonym —— 快照对比、逐会话表、闭包链才连得上；
 * · 可加盐/映射私有：`GOKIFU_PSEUDONYM_SALT` 或 `--salt` 换成私有盐（盐本身**不写进证据**）。
 *   换盐 = 全套改名，跨运行历史不可比，所以只在你确定要切断关联时换；
 * · 单向：48 bit SHA-256 截断 + 原始 id 是高熵 UUID，不做明文回映射；
 *   需要回查原始会话时，用同一私盐按本函数重算比对（不要在公开证据里放映射表）。
 *
 * @param {string} sessionId 原始会话目录名（如 `session-<uuid>`）
 * @param {string} [salt]
 * @returns {string} `s_` + 12 位小写十六进制
 */
export function pseudonymOf(sessionId, salt = process.env.GOKIFU_PSEUDONYM_SALT || DEFAULT_PSEUDONYM_SALT) {
  const digest = nodeCrypto.createHash("sha256").update(`${salt}\u0000${String(sessionId ?? "")}`, "utf8").digest("hex");
  return `${PSEUDONYM_PREFIX}${digest.slice(0, 12)}`;
}

/** 把 home 的两种写法归一（正/反斜杠、大小写、末尾斜杠），只用于「两次快照是否同源」判断。 */
function normalizeHome(home) {
  return String(home ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 外部折叠（`ledger-budget.json` 的 `lastExternalFold`）里的 session 也要脱敏。 */
export function redactExternalLast(last, salt) {
  if (!last || typeof last !== "object") return last ?? null;
  const { session, ...rest } = last;
  if (typeof session !== "string" || session === "") return rest;
  return { ...rest, session: pseudonymOf(session, salt) };
}

/** 从一条 foldMark 提成扁平记录（缺失字段保留 undefined，汇总里单独报覆盖率）。 */
export function foldRecord(sessionId, index, mark, salt = process.env.GOKIFU_PSEUDONYM_SALT || DEFAULT_PSEUDONYM_SALT) {
  const quality = mark?.quality ?? null;
  const closure = mark?.closure ?? null;
  const usage = mark?.usage ?? null;
  const shadowed = Number(mark?.shadowedTokens ?? quality?.shadowedTokens ?? 0);
  const input = Number(usage?.inputTokens ?? 0);
  return {
    // ★ t3：这里就是唯一出口 —— 之后所有消费方（summary/bySession/证据页/逐会话表）拿到的都是 pseudonym。
    sessionId: pseudonymOf(sessionId, salt),
    fold: index + 1,
    at: Number(mark?.at ?? 0) || null,
    trigger: typeof mark?.trigger === "string" ? mark.trigger : null,
    seqStart: mark?.seqStart ?? null,
    seqEnd: mark?.seqEnd ?? null,
    hasRange: Number.isFinite(Number(mark?.seqStart)) && Number.isFinite(Number(mark?.seqEnd)),
    summaryChars: mark?.summaryChars ?? null,
    shadowedTokens: shadowed,
    inputTokens: input || null,
    outputTokens: Number(usage?.outputTokens ?? 0) || null,
    inputPerShadowed: shadowed > 0 && input > 0 ? Number((input / shadowed).toFixed(2)) : null,
    // C43：遮蔽占读入的比例与 ROI（旧口径 input/shadowed 含 host 固定开销，不能单独判错）
    shadowedShare: shadowed > 0 && input > 0 ? Number((shadowed / input).toFixed(3)) : null,
    ms: Number(mark?.ms ?? 0) || null,
    route: mark?.route ?? null,
    fallback: mark?.fallback ?? null,
    quality: quality
      ? {
          constraintRecall: quality.constraintRecall ?? null,
          failureRecall: quality.failureRecall ?? null,
          compressionRatio: quality.compressionRatio ?? null,
          expectedConstraints: quality.expectedConstraints ?? null,
          expectedFailures: quality.expectedFailures ?? null,
          unknownIds: Array.isArray(quality.unknownIds) ? quality.unknownIds.length : null,
          summaryTokens: quality.summaryTokens ?? null,
        }
      : null,
    closure: closure
      ? {
          nodes: closure.nodes ?? null,
          edges: closure.edges ?? null,
          firstNode: closure.firstNode ?? null,
          lastNode: closure.lastNode ?? null,
          // C30 起才有：区间早于本图（重启续跑的历史没有节点可回查）
          preGraph: typeof closure.preGraph === "boolean" ? closure.preGraph : null,
          graphNodes: closure.graphNodes ?? null,
        }
      : null,
    dangling: mark?.dangling ?? null,
    // C31 起才有：切点是否落在工具调用中间
    boundary: mark?.boundary
      ? { overlapping: mark.boundary.overlapping ?? null, openAtEnd: mark.boundary.openAtEnd ?? null, unsettled: mark.boundary.unsettled ?? null }
      : null,
  };
}

/**
 * 与上一次证据快照对比（C50 / t3）：每小时跑一次时，最值得看的是「这两次快照之间净变了什么」。
 * 只做事实对比，不给结论：净变化几折、质量下限有没有变差、边界有没有回归、成本占比漂移多少。
 *
 * ★ t3 语义纠正：`newFolds`（历史字段名）**是两次快照的净变化**，不是「这段时间累计新增折数」，
 *   更不是调用量 —— 折痕修复/会话归档/home 迁移都可能让它变小。证据页据此改写文案。
 * ★ 脱敏后的快照只记 `<DSH_HOME>`，所以「是否跨 home」只有**旧版（未脱敏）快照**能自动判定；
 *   判定不了就返回 null，绝不猜「同源」。
 *
 * @param {object} prev 旧快照 JSON
 * @param {object} summary 本次 summary
 * @param {{home?:string}} [options] 本次真实 home（只用于同源判断，不落盘）
 */
export function trendOf(prev, summary, { home } = {}) {
  if (!prev || typeof prev !== "object" || !summary || typeof summary !== "object") return null;
  const prevTotal = Number(prev?.summary?.total ?? (Array.isArray(prev?.folds) ? prev.folds.length : NaN));
  if (!Number.isFinite(prevTotal)) return null;
  const prevQ = prev?.summary?.quality ?? {};
  const prevB = prev?.summary?.boundary ?? {};
  const prevCost = prev?.summary?.cost ?? {};
  const q = (o, k) => (o && o[k] !== undefined ? o[k] : null);
  const qualityChanged = ["constraintRecallMin", "failureRecallMin", "unknownIdsTotal"].some((k) => q(prevQ, k) !== q(summary.quality, k));
  const costShareDelta =
    typeof prevCost.shadowedShareMin === "number" && typeof summary?.cost?.shadowedShareMin === "number"
      ? summary.cost.shadowedShareMin - prevCost.shadowedShareMin
      : null;
  const prevHomeRaw = typeof prev?.home === "string" ? prev.home : null;
  const previousHomeRedacted = prevHomeRaw === null || prevHomeRaw === HOME_REDACTED;
  const previousHomeChanged =
    previousHomeRedacted || typeof home !== "string" ? null : normalizeHome(prevHomeRaw) !== normalizeHome(home);
  return {
    previousAt: typeof prev.generatedAt === "string" ? prev.generatedAt : null,
    // 历史字段名；语义见本函数注释：= 快照差（净变化）
    newFolds: summary.total - prevTotal,
    netChange: summary.total - prevTotal,
    trendKind: "net-change",
    qualityChanged,
    boundaryRegressed: Number(prevB.openAtEnd ?? 0) < Number(summary?.boundary?.openAtEnd ?? 0),
    costShareDelta,
    previousHomeRedacted,
    previousHomeChanged,
    prevQuality: prevQ,
    prevBoundary: prevB,
  };
}

/** 扫 home 下所有会话图，按时间升序返回记录（★ t3：输出里只有 pseudonym，没有原始会话 id）。 */
export function collectLiveFolds(home, { salt = process.env.GOKIFU_PSEUDONYM_SALT || DEFAULT_PSEUDONYM_SALT } = {}) {
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const records = [];
  const thrash = [];
  let sessions = 0;
  let unreadable = 0;
  if (!nodeFs.existsSync(sessionsRoot)) return { records, sessions, unreadable, thrash };
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    sessions += 1;
    let graph;
    try {
      // ★ C199：必须**重放 delta** —— 与运行时 load / doctor / graph-audit / handoff-check 同口径。
      //   只读基线会漏掉「fold 之后才写进 delta 的那条 foldMark」（live 实测：证据 25 次 vs 实际 26 次）。
      graph = loadSessionGraph(graphFile).graph;
    } catch {
      // 回退：老图/不完整图（loadSessionGraph 会因 version 不符直接拒绝）仍按裸基线读，
      // 否则「历史证据」会整段消失。真正的坏图仍计入 unreadable。
      try {
        graph = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
      } catch {
        unreadable += 1;
        continue;
      }
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    marks.forEach((mark, index) => records.push(foldRecord(entry.name, index, mark, salt)));
    // C54：压缩无效（foldThrash）与「同一会话被反复折」是同一类健康信号，证据页要能看到
    if (typeof graph?.foldThrash === "number" && graph.foldThrash >= 2) {
      thrash.push({ sessionId: pseudonymOf(entry.name, salt), foldThrash: graph.foldThrash });
    }
  }
  records.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId) || a.fold - b.fold);
  // ★ C198/C199：宿主直调 `compactRegion` 的折叠记在 `ledger-budget.json`（图的 foldMarks 里没有），
  //   证据页必须一并报出来，否则「压了多少次」永远偏低。★ t3：其中的 session 也脱敏。
  let external = null;
  const budgetFile = nodePath.join(home, "chess-context", "ledger-budget.json");
  if (nodeFs.existsSync(budgetFile)) {
    try {
      const budget = JSON.parse(nodeFs.readFileSync(budgetFile, "utf8"));
      external = { folds: Number(budget.externalFolds ?? 0), last: redactExternalLast(budget.lastExternalFold, salt) };
    } catch {
      external = { folds: 0, last: null, error: "ledger-budget.json 读不出" };
    }
  }
  return { records, sessions, unreadable, thrash, external };
}

/** 汇总：覆盖率 + 质量 + 成本 + 闭包。 */
/**
 * ★ C103：折叠闭包的**节点级**单调性。
 *   注意：`seqStart/seqEnd` 区间**允许重叠** —— fold 后 surface 上的 checkpoint 节点可能带着
 *   比上一次 fold 结束更早的 seq，于是下一次 fold 的区间起点会「回落」。
 *   真正要防的是**节点级重复折叠**：同一批节点被折两次 = 白花一次摘要成本、且摘要可能失真。
 *   判据：同会话按时间排序后，第 N+1 次 fold 的 `closure.firstNode` 必须晚于第 N 次的 `closure.lastNode`。
 */
export function closureChainOf(records) {
  const bySession = new Map();
  for (const r of records ?? []) {
    if (!r?.closure || typeof r.closure.firstNode !== "string") continue;
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  const num = (id) => Number(String(id).replace(/^[^0-9]+/, "")) || 0;
  let checked = 0;
  const offenders = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    for (let i = 1; i < list.length; i += 1) {
      checked += 1;
      const prevLast = num(list[i - 1].closure.lastNode);
      const nextFirst = num(list[i].closure.firstNode);
      if (nextFirst <= prevLast) {
        // ★ t3：会话已是 pseudonym（foldRecord 出口统一脱敏），这里不再截断，便于逐条核对。
        offenders.push(`${sessionId}:${list[i - 1].closure.lastNode}→${list[i].closure.firstNode}`);
      }
    }
  }
  return { checked, offenders };
}

export function summarizeFolds(records, external = null) {
  // ★ C211：`recordFoldMark(range=null)` 这类「手工压缩」记录没有区间，也没有 quality/closure ——
  //   把它们算进「fold 次数」会让证据与磁盘对不上（实测 28 vs 29）。单列成 manual。
  const ranged = records.filter((r) => r.hasRange !== false);
  const manual = records.length - ranged.length;
  const total = ranged.length;
  const countField = (field) => records.filter((r) => r[field] !== null && r[field] !== undefined).length;
  const triggerCounts = {};
  for (const r of records) if (r.trigger !== null) triggerCounts[r.trigger] = (triggerCounts[r.trigger] ?? 0) + 1;
  const qualityRecords = records.filter((r) => r.quality !== null);
  const ratios = qualityRecords.map((r) => r.quality.compressionRatio).filter((v) => Number.isFinite(v));
  const constraints = qualityRecords.map((r) => r.quality.constraintRecall).filter((v) => Number.isFinite(v));
  const failures = qualityRecords.map((r) => r.quality.failureRecall).filter((v) => Number.isFinite(v));
  const unknown = qualityRecords.reduce((sum, r) => sum + (r.quality.unknownIds ?? 0), 0);
  const costRecords = records.filter((r) => r.inputPerShadowed !== null);
  const costRatios = costRecords.map((r) => r.inputPerShadowed);
  const costShares = costRecords.map((r) => r.shadowedShare).filter((v) => v !== null);
  const closureRecords = records.filter((r) => r.closure !== null);
  const emptyClosure = closureRecords.filter((r) => (r.closure.nodes ?? 0) === 0 && (r.closure.edges ?? 0) === 0).length;
  // ★ t3：成本区间上限会被少数「小遮蔽量」样本抬高（share > 100%，即摘要输入比被遮蔽内容还少）。
  //   证据页/下游文档必须把「样本数 + 主要路由」一起报，不能再说「那唯一 1 次的异常样本」。
  const overInputRecords = costRecords.filter((r) => typeof r.shadowedShare === "number" && r.shadowedShare > 1);
  const overModels = new Map();
  for (const r of overInputRecords) {
    const model = r.route && typeof r.route.model === "string" && r.route.model !== "" ? r.route.model : "（未记录）";
    overModels.set(model, (overModels.get(model) ?? 0) + 1);
  }
  const overInputModels = [...overModels.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  return {
    total,
    manual,
    // ★ C199：宿主直调 compactRegion 的折叠（C198 记账）。它们不在图的 foldMarks 里，
    //   但对「这台机器到底压了多少次」是必须的。
    external,
    coverage: {
      trigger: countField("trigger"),
      quality: qualityRecords.length,
      closure: closureRecords.length,
      usage: countField("inputTokens"),
    },
    triggerCounts,
    quality: {
      count: qualityRecords.length,
      constraintRecallMin: constraints.length ? Math.min(...constraints) : null,
      failureRecallMin: failures.length ? Math.min(...failures) : null,
      compressionRatioMin: ratios.length ? Math.min(...ratios) : null,
      compressionRatioMax: ratios.length ? Math.max(...ratios) : null,
      unknownIdsTotal: unknown,
    },
    cost: {
      count: costRecords.length,
      inputPerShadowedMin: costRatios.length ? Math.min(...costRatios) : null,
      inputPerShadowedMax: costRatios.length ? Math.max(...costRatios) : null,
      shadowedShareMin: costShares.length ? Math.min(...costShares) : null,
      shadowedShareMax: costShares.length ? Math.max(...costShares) : null,
      // share > 1（>100%）的样本：上限由谁抬高，读证据的人必须看得到
      overInput: overInputRecords.length,
      overInputModels: overInputModels.slice(0, 3),
    },
    // C103：闭包节点级单调性（节点不许被折两次）
    closureChain: closureChainOf(records),
    // C54：同一会话被折了多少次（多折 = 反复压缩，配合 foldThrash 看）
    bySession: (() => {
      const counts = new Map();
      for (const r of records) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1);
      const entries = [...counts.entries()].map(([sessionId, folds]) => ({ sessionId, folds })).sort((a, b) => b.folds - a.folds);
      return {
        sessionsWithFolds: entries.length,
        multiFold: entries.filter((e) => e.folds >= 3).length,
        top: entries.slice(0, 3),
      };
    })(),
    closure: { count: closureRecords.length, empty: emptyClosure, preGraph: closureRecords.filter((r) => r.closure.preGraph === true).length },
    boundary: {
      count: records.filter((r) => r.boundary !== null).length,
      openAtEnd: records.reduce((sum, r) => sum + (r.boundary?.openAtEnd ?? 0), 0),
      unsettled: records.reduce((sum, r) => sum + (r.boundary?.unsettled ?? 0), 0),
    },
    // C35：fold 时刻的悬空统计（合同 §6 第 4 行：liveUnsettled 升高 = fold 切在动作中间）
    dangling: {
      count: records.filter((r) => r.dangling !== null).length,
      residue: records.reduce((sum, r) => sum + (r.dangling?.residue ?? 0), 0),
      candidates: records.reduce((sum, r) => sum + (r.dangling?.candidates ?? 0), 0),
      liveUnsettled: records.reduce((sum, r) => sum + (r.dangling?.liveUnsettled ?? 0), 0),
      fromBroken: records.reduce((sum, r) => sum + (r.dangling?.fromBroken ?? 0), 0),
    },
  };
}

const pad = (value, width) => String(value ?? "—").padStart(width);

/** Markdown 证据页（内容里带生成时间，按 evidence/README 的判据看这里而不是 mtime）。 */
export function renderMarkdown({ home, records, summary, generatedAt, trend = null }) {
  void home; // ★ t3：真实 home 不落公开页；数据源一律写 `<DSH_HOME>`
  const lines = [];
  lines.push("# live fold 证据（自动汇总）");
  lines.push("");
  lines.push(`> 生成于 **${generatedAt}**（UTC），数据源 \`${HOME_REDACTED}/chess-context/sessions/*/graph.json\` 的 \`foldMarks[i]\`。`);
  lines.push("> 生成命令：`node scripts/live-folds.mjs --write`（只读采集；显式 --write 才覆盖本文件与同名 .json）。");
  lines.push("> 看数字先看这一行的生成时间；宿主里出现新 fold 后重跑即可刷新。");
  lines.push("");
  lines.push("## 快照语义（必读）");
  lines.push("");
  lines.push("- 本页是**生成时刻的快照**，不是累计台账：`summary.total` = 这一次扫描到的 `foldMark` 条数；同一会话之后再折，只会让下一次快照变大。");
  lines.push("- 会话标识一律是**稳定 pseudonym**（`s_<12hex>`，同一会话同一名字）；原始 session id 与 home 真实路径**不写入公开证据**。");
  lines.push("- 「与上次对比」给的是**两次快照的净变化**（本次 total − 上次 total），**不是**这段时间的累计新增折数、也不是调用量；折痕修复 / 会话归档 / home 迁移都可能让它变小或不可比。");
  lines.push("- 跨 home 的两份快照不可当「纯增长」读：data source 已脱敏成 `<DSH_HOME>`，只有旧版未脱敏快照才能自动判定是否同源。");
  lines.push("");
  lines.push("## 覆盖率");
  lines.push("");
  lines.push("| 项 | 有值的 fold / 总数 |");
  lines.push("|---|---:|");
  lines.push(`| trigger | ${summary.coverage.trigger} / ${summary.total} |`);
  lines.push(`| quality（保真度） | ${summary.coverage.quality} / ${summary.total} |`);
  lines.push(`| closure（可寻址闭包） | ${summary.coverage.closure} / ${summary.total} |`);
  lines.push(`| usage（provider 真实 token） | ${summary.coverage.usage} / ${summary.total} |`);
  lines.push("");
  lines.push("## 质量");
  lines.push("");
  lines.push(`- 有 quality 样本：**${summary.quality.count}** 次`);
  lines.push(`- constraintRecall min：**${summary.quality.constraintRecallMin ?? "—"}** · failureRecall min：**${summary.quality.failureRecallMin ?? "—"}**`);
  lines.push(`- compressionRatio：**${summary.quality.compressionRatioMin ?? "—"} – ${summary.quality.compressionRatioMax ?? "—"}**`);
  lines.push(`- unknownIds（幻觉探针命中）：**${summary.quality.unknownIdsTotal}**`);
  lines.push("");
  lines.push("## 成本（摘要输入 ÷ 被遮蔽 token）");
  lines.push("");
  lines.push(`- 有 usage 的 fold：**${summary.cost.count}** 次 · **遮蔽占读入 ${summary.cost.shadowedShareMin === null ? "—" : (summary.cost.shadowedShareMin * 100).toFixed(0) + "%"} – ${summary.cost.shadowedShareMax === null ? "—" : (summary.cost.shadowedShareMax * 100).toFixed(0) + "%"}**（C43 口径）`);
  if (summary.cost.overInput > 0) {
    const top = (summary.cost.overInputModels ?? [])[0];
    lines.push(
      `- **比值 > 100% 的样本 ${summary.cost.overInput} 次**${top ? `（其中 ${top.count} 次路由 \`${top.model}\`）` : ""}：这些是「摘要输入 < 被遮蔽 token」的小遮蔽量样本，**上限由它们抬高，不是模型好坏**；判据看下限与样本量。`,
    );
  }
  lines.push(`- 对照：input/shadowed ${summary.cost.inputPerShadowedMin ?? "—"} – ${summary.cost.inputPerShadowedMax ?? "—"}（含 host 工具/system 固定开销）`);
  lines.push("- 判据：遮蔽占读入 < 30% 时 doctor 判 warn（折得太碎/太早）；比值本身不判错");
  lines.push("");
  lines.push("## 闭包");
  lines.push("");
  lines.push(`- 有 closure 的 fold：**${summary.closure.count}** 次，其中空闭包 **${summary.closure.empty}** 次（新会话尚无节点时属正常）`);
  lines.push(`- **悬空（dangling）**：${summary.dangling.count} 次有记录 —— residue ${summary.dangling.residue} / candidates ${summary.dangling.candidates} / liveUnsettled ${summary.dangling.liveUnsettled} / fromBroken ${summary.dangling.fromBroken}（合同 §6-4：liveUnsettled 升高 = fold 切在动作中间）`);
  lines.push(`- **边界完整性**：${summary.boundary.count} 次有 boundary 记录，其中切点落在工具调用中间的 **${summary.boundary.openAtEnd}** 次（正常应为 0），区间内未结算边合计 **${summary.boundary.unsettled}** 条`);
  lines.push(`- 其中 **preGraph ${summary.closure.preGraph} 次**：折叠区间早于本图（重启续跑的历史没有节点可回查）—— C30 起每次 fold 都会记这个布尔值，老 fold 没有该字段`);
  lines.push("");
  if (trend) {
    lines.push("## 与上次对比（快照差 = 净变化）");
    lines.push("");
    lines.push(`- 上次快照：${trend.previousAt ?? "—"}`);
    if (trend.previousHomeChanged === true) {
      lines.push("- 上次快照的数据源与本次**不同**（跨 home 对比，含迁移差异 —— 净变化不等于纯增长）");
    } else if (trend.previousHomeRedacted) {
      lines.push("- 上次快照的数据源已脱敏（`<DSH_HOME>`），无法自动判定是否同源；若两次来自不同 home，净变化含迁移差异");
    }
    const net = Number(trend.newFolds ?? 0);
    lines.push(`- 净变化：**${net >= 0 ? "+" : ""}${net}** 次（本次快照 − 上次快照；**不是**累计新增折数，也不是调用量）`);
    lines.push(`- 质量下限变化：${trend.qualityChanged ? "**有变化**" : "无变化"}（上次 c=${trend.prevQuality?.constraintRecallMin ?? "—"} / f=${trend.prevQuality?.failureRecallMin ?? "—"} · unknownIds ${trend.prevQuality?.unknownIdsTotal ?? "—"}）`);
    lines.push(`- 边界回归（openAtEnd 增加）：${trend.boundaryRegressed ? "**是 —— 必须排查**" : "无"}`);
    lines.push(`- 遮蔽占读入漂移（下限）：${trend.costShareDelta === null ? "—" : `${(trend.costShareDelta * 100).toFixed(1)} 个百分点`}`);
    lines.push("");
  }
  lines.push("## 闭包链（C103）");
  lines.push("");
  lines.push(`- 检查 **${summary.closureChain.checked}** 对相邻 fold（同会话、按时间排序）`);
  lines.push(`- 节点级重叠：**${summary.closureChain.offenders.length}** 处${summary.closureChain.offenders.length > 0 ? `（${summary.closureChain.offenders.join(" / ")}）` : "（节点没有被折两次）"}`);
  lines.push("- 说明：`seqStart/seqEnd` **区间允许重叠**（fold 后的 checkpoint 节点可能带更早的 seq）；真正要防的是**节点级重复折叠**，判据看 closure 首尾节点。");
  lines.push("");
  lines.push("## 会话分布（C54）");
  lines.push("");
  lines.push(`- 有 fold 的会话：**${summary.bySession.sessionsWithFolds}** 个，其中 **${summary.bySession.multiFold}** 个被折过 ≥3 次`);
  lines.push(`- 折叠最多的会话：${summary.bySession.top.map((e) => `${e.sessionId}（${e.folds} 次）`).join(" / ") || "（无）"}`);
  lines.push(`- 压缩无效（foldThrash ≥2，连续两次 fold 间隔 <30 事件）：${summary.thrash && summary.thrash.sessions > 0 ? `**${summary.thrash.sessions} 个会话，最深 ${summary.thrash.max} 次**` : "0 个"}`);
  lines.push("");
  lines.push("## 逐次明细");
  lines.push("");
  lines.push("| # | 会话 | 时间 | trigger | 遮蔽 tok | 输入 tok | 输入/遮蔽 | ms | c/f 召回 | 压缩比 | 闭包 n/e |");
  lines.push("|---:|---|---|---|---:|---:|---:|---:|---|---:|---|");
  records.forEach((r, index) => {
    const at = r.at === null ? "—" : new Date(r.at).toISOString().slice(0, 19).replace("T", " ");
    const recall = r.quality === null ? "—" : `${r.quality.constraintRecall ?? "—"}/${r.quality.failureRecall ?? "—"}`;
    const ratio = r.quality?.compressionRatio === null || r.quality === null ? "—" : r.quality.compressionRatio;
    const closure = r.closure === null ? "—" : `${r.closure.nodes ?? "—"}/${r.closure.edges ?? "—"}`;
    lines.push(
      `| ${index + 1} | ${r.sessionId} | ${at} | ${r.trigger ?? "—"} | ${pad(r.shadowedTokens, 0)} | ${pad(r.inputTokens, 0)} | ${r.inputPerShadowed ?? "—"} | ${r.ms ?? "—"} | ${recall} | ${ratio} | ${closure} |`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

/** CLI 入口：返回退出码（只读工具，永不因「没有 fold」失败）。 */
export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : nodePath.join(nodeOs.homedir(), ".dsh"));
  const outBase = getArg("out", nodePath.join(REPO, "evidence", "live-folds"));
  // ★ t3：对比基线可单独指定（默认仍是同目录同名 .json），这样「旧 1674 快照 → 新快照」的
  //   净变化记录不会因为连续刷新一次就被覆盖成 +1。
  const previousFile = getArg("previous", `${outBase}.json`);
  // ★ t3：pseudonym 的盐（默认公开固定值）；私有盐不进证据，只影响本次映射。
  const salt = getArg("salt", process.env.GOKIFU_PSEUDONYM_SALT || DEFAULT_PSEUDONYM_SALT);
  // ★ C65（专员审计事故的教训）：诊断脚本的**默认行为不该是写仓库**。
  //   审计员把本脚本当只读跑，覆盖了两个已跟踪文件。现在默认只打印，落盘必须显式 --write。
  const dryRun = !argv.includes("--write");
  const jsonOnly = argv.includes("--json-only");
  const { records, sessions, unreadable, thrash = [] } = collectLiveFolds(home, { salt });
  const summary = summarizeFolds(records);
  // C54：压缩无效（连续 fold 间隔 <30 事件）—— 与「同一会话多折」一起看
  summary.thrash = { sessions: thrash.length, max: thrash.reduce((m, t) => Math.max(m, t.foldThrash ?? 0), 0), list: thrash.slice(0, 5) };
  // C50：先读旧快照再覆盖 —— 每小时一次，最有用的是「与上次相比变了什么」。
  let previous = null;
  try {
    if (nodeFs.existsSync(previousFile)) previous = JSON.parse(nodeFs.readFileSync(previousFile, "utf8"));
  } catch {
    previous = null;
  }
  const trend = trendOf(previous, summary, { home });
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = {
    schema: SCHEMA,
    generatedAt,
    // ★ t3：公开证据只写 `<DSH_HOME>`；`homeRedacted` 让读者一眼看出这是脱敏值而不是空值。
    home: HOME_REDACTED,
    homeRedacted: true,
    sessions,
    unreadable,
    summary,
    trend,
    semantics: {
      snapshot: true,
      notCumulative: true,
      trendIsNetChange: true,
      sessionIds: "pseudonym",
      home: "redacted",
    },
    folds: records,
  };
  if (!dryRun) {
    nodeFs.mkdirSync(nodePath.dirname(outBase), { recursive: true });
    nodeFs.writeFileSync(`${outBase}.json`, JSON.stringify(payload, void 0, 2) + "\n", "utf8");
    if (!jsonOnly) nodeFs.writeFileSync(`${outBase}.md`, renderMarkdown({ home, records, summary, generatedAt, trend }) + "\n", "utf8");
  }
  console.log(`live folds：${summary.total} 次（${sessions} 个会话${unreadable > 0 ? `，${unreadable} 个图读不出` : ""}）`);
  console.log(`  源：${HOME_REDACTED}（真实路径不写入证据）· 会话标识：pseudonym ${PSEUDONYM_PREFIX}<12hex>${salt === DEFAULT_PSEUDONYM_SALT ? "（默认盐）" : "（私有盐）"}`);
  if (trend) {
    console.log(
      `  与上次（${trend.previousAt ?? "—"}）净变化：${trend.newFolds >= 0 ? "+" : ""}${trend.newFolds} 次` +
        (trend.previousHomeChanged === true
          ? "（跨 home，含迁移差异）"
          : trend.previousHomeRedacted
            ? "（上次数据源已脱敏，无法自动判定同源）"
            : ""),
    );
  }
  console.log(`  覆盖率 trigger ${summary.coverage.trigger}/${summary.total} · quality ${summary.coverage.quality}/${summary.total} · closure ${summary.coverage.closure}/${summary.total} · usage ${summary.coverage.usage}/${summary.total}`);
  console.log(`  trigger 分布：${Object.entries(summary.triggerCounts).map(([k, v]) => `${k}=${v}`).join(" ") || "（无）"}`);
  console.log(`  质量：c=${summary.quality.constraintRecallMin ?? "—"} / f=${summary.quality.failureRecallMin ?? "—"} · 压缩比 ${summary.quality.compressionRatioMin ?? "—"}–${summary.quality.compressionRatioMax ?? "—"} · unknownIds ${summary.quality.unknownIdsTotal}`);
  const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);
  console.log(
    `  成本：遮蔽占读入 ${pct(summary.cost.shadowedShareMin)}–${pct(summary.cost.shadowedShareMax)}` +
      `（对照 input/shadowed ${summary.cost.inputPerShadowedMin ?? "—"}–${summary.cost.inputPerShadowedMax ?? "—"}，${summary.cost.count} 次有 usage）`,
  );
  console.log(`  闭包链：检查 ${summary.closureChain.checked} 对相邻 fold · 节点级重叠 ${summary.closureChain.offenders.length} 处${summary.closureChain.offenders.length > 0 ? "（" + summary.closureChain.offenders.slice(0, 3).join(" / ") + "）" : ""}`);
  console.log(
    `  会话分布：${summary.bySession.sessionsWithFolds} 个会话有 fold` +
      (summary.manual > 0 ? `（另有 ${summary.manual} 条手工压缩记录，无区间）` : "") + ` · ` +
      `multi-fold(≥3) ${summary.bySession.multiFold} 个 · foldThrash ${summary.thrash.sessions} 个`,
  );
  if (summary.external && Number(summary.external.folds) > 0) {
    const last = summary.external.last;
    console.log(
      `  外部折叠（宿主直调 compactRegion，C198）：${summary.external.folds} 次` +
        (last ? ` · 最近 ${last.seqStart}-${last.seqEnd}（${new Date(last.at).toISOString()}）` : ""),
    );
  }
  console.log(dryRun ? "（dry-run：未写文件；要落盘请加 --write）" : `已写 ${outBase}.json${jsonOnly ? "" : ` 与 ${outBase}.md`}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
