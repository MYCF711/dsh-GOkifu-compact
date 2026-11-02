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
 * 用法：
 *   node scripts/live-folds.mjs                     # 读 DSH_HOME（或 ~/.dsh），**只打印摘要**（安全默认）
 *   node scripts/live-folds.mjs --write             # 落盘 evidence/live-folds.{json,md}
 *   node scripts/live-folds.mjs --home D:/x/home    # 指定 home
 *   node scripts/live-folds.mjs --dry-run           # 同默认（保留旧参数，向后兼容）
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";

const REPO = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA = "gokifu/live-folds/v1";

/** 从一条 foldMark 提成扁平记录（缺失字段保留 undefined，汇总里单独报覆盖率）。 */
export function foldRecord(sessionId, index, mark) {
  const quality = mark?.quality ?? null;
  const closure = mark?.closure ?? null;
  const usage = mark?.usage ?? null;
  const shadowed = Number(mark?.shadowedTokens ?? quality?.shadowedTokens ?? 0);
  const input = Number(usage?.inputTokens ?? 0);
  return {
    sessionId,
    fold: index + 1,
    at: Number(mark?.at ?? 0) || null,
    trigger: typeof mark?.trigger === "string" ? mark.trigger : null,
    seqStart: mark?.seqStart ?? null,
    seqEnd: mark?.seqEnd ?? null,
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
 * 与上一次证据快照对比（C50）：每小时跑一次时，最值得看的是「这一小时发生了什么变化」。
 * 只做事实对比，不给结论：新增几次 fold、质量下限有没有变差、边界有没有回归、成本占比漂移多少。
 */
export function trendOf(prev, summary) {
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
  return {
    previousAt: typeof prev.generatedAt === "string" ? prev.generatedAt : null,
    newFolds: summary.total - prevTotal,
    qualityChanged,
    boundaryRegressed: Number(prevB.openAtEnd ?? 0) < Number(summary?.boundary?.openAtEnd ?? 0),
    costShareDelta,
    prevQuality: prevQ,
    prevBoundary: prevB,
  };
}

/** 扫 home 下所有会话图，按时间升序返回记录。 */
export function collectLiveFolds(home) {
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
    marks.forEach((mark, index) => records.push(foldRecord(entry.name, index, mark)));
    // C54：压缩无效（foldThrash）与「同一会话被反复折」是同一类健康信号，证据页要能看到
    if (typeof graph?.foldThrash === "number" && graph.foldThrash >= 2) thrash.push({ sessionId: entry.name, foldThrash: graph.foldThrash });
  }
  records.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId) || a.fold - b.fold);
  // ★ C198/C199：宿主直调 `compactRegion` 的折叠记在 `ledger-budget.json`（图的 foldMarks 里没有），
  //   证据页必须一并报出来，否则「压了多少次」永远偏低。
  let external = null;
  const budgetFile = nodePath.join(home, "chess-context", "ledger-budget.json");
  if (nodeFs.existsSync(budgetFile)) {
    try {
      const budget = JSON.parse(nodeFs.readFileSync(budgetFile, "utf8"));
      external = { folds: Number(budget.externalFolds ?? 0), last: budget.lastExternalFold ?? null };
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
        offenders.push(sessionId.slice(0, 20) + ":" + list[i - 1].closure.lastNode + "→" + list[i].closure.firstNode);
      }
    }
  }
  return { checked, offenders };
}

export function summarizeFolds(records, external = null) {
  const total = records.length;
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
  return {
    total,
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
  const lines = [];
  lines.push("# live fold 证据（自动汇总）");
  lines.push("");
  lines.push(`> 生成于 **${generatedAt}**（UTC），数据源 \`${home}/chess-context/sessions/*/graph.json\` 的 \`foldMarks[i]\`。`);
  lines.push("> 生成命令：`node scripts/live-folds.mjs --write`（只读采集；显式 --write 才覆盖本文件与同名 .json）。");
  lines.push("> 看数字先看这一行的生成时间；宿主里出现新 fold 后重跑即可刷新。");
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
    lines.push("## 与上次对比（C50）");
    lines.push("");
    lines.push(`- 上次快照：${trend.previousAt ?? "—"}`);
    lines.push(`- 新增 fold：**${trend.newFolds}** 次`);
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
  lines.push(`- 折叠最多的会话：${summary.bySession.top.map((e) => `${e.sessionId.slice(0, 22)}…（${e.folds} 次）`).join(" / ") || "（无）"}`);
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
      `| ${index + 1} | ${r.sessionId.slice(0, 22)}… | ${at} | ${r.trigger ?? "—"} | ${pad(r.shadowedTokens, 0)} | ${pad(r.inputTokens, 0)} | ${r.inputPerShadowed ?? "—"} | ${r.ms ?? "—"} | ${recall} | ${ratio} | ${closure} |`,
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
  // ★ C65（专员审计事故的教训）：诊断脚本的**默认行为不该是写仓库**。
  //   审计员把本脚本当只读跑，覆盖了两个已跟踪文件。现在默认只打印，落盘必须显式 --write。
  const dryRun = !argv.includes("--write");
  const jsonOnly = argv.includes("--json-only");
  const { records, sessions, unreadable, thrash = [] } = collectLiveFolds(home);
  const summary = summarizeFolds(records);
  // C54：压缩无效（连续 fold 间隔 <30 事件）—— 与「同一会话多折」一起看
  summary.thrash = { sessions: thrash.length, max: thrash.reduce((m, t) => Math.max(m, t.foldThrash ?? 0), 0), list: thrash.slice(0, 5) };
  // C50：先读旧快照再覆盖 —— 每小时一次，最有用的是「与上次相比变了什么」。
  let previous = null;
  try {
    if (nodeFs.existsSync(`${outBase}.json`)) previous = JSON.parse(nodeFs.readFileSync(`${outBase}.json`, "utf8"));
  } catch {
    previous = null;
  }
  const trend = trendOf(previous, summary);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = { schema: SCHEMA, generatedAt, home, sessions, unreadable, summary, trend, folds: records };
  if (!dryRun) {
    nodeFs.mkdirSync(nodePath.dirname(outBase), { recursive: true });
    nodeFs.writeFileSync(`${outBase}.json`, JSON.stringify(payload, void 0, 2) + "\n", "utf8");
    if (!jsonOnly) nodeFs.writeFileSync(`${outBase}.md`, renderMarkdown({ home, records, summary, generatedAt, trend }) + "\n", "utf8");
  }
  console.log(`live folds：${summary.total} 次（${sessions} 个会话${unreadable > 0 ? `，${unreadable} 个图读不出` : ""}）`);
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
    `  会话分布：${summary.bySession.sessionsWithFolds} 个会话有 fold · ` +
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
