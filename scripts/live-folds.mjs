/**
 * live-folds.mjs —— 把 live `foldMarks` 汇总成可引用的证据（只读，不改任何图）
 *
 * 为什么需要它：`doctor` 只看最近 fold 的几个数，`evidence/折叠成本-实测-*.md` 是手工汇总；
 * 每轮巡检要回答「这次 fold 有没有 trigger / quality / closure」「成本效率多少」，
 * 手工抄数会漂。这里一次生成 `evidence/live-folds.json` + `.md`，字段全来自
 * `<DSH_HOME>/chess-context/sessions/<sid>/graph.json` 的 `foldMarks[i]`（provider 真实回报）。
 *
 * 只读：不写 home，不碰 profile patch；输出目录默认 `evidence/`（仓库内）。
 *
 * 用法：
 *   node scripts/live-folds.mjs                     # 读 DSH_HOME（或 ~/.dsh），写 evidence/live-folds.{json,md}
 *   node scripts/live-folds.mjs --home D:/x/home    # 指定 home
 *   node scripts/live-folds.mjs --dry-run           # 只打印摘要，不写文件
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

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

/** 扫 home 下所有会话图，按时间升序返回记录。 */
export function collectLiveFolds(home) {
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const records = [];
  let sessions = 0;
  let unreadable = 0;
  if (!nodeFs.existsSync(sessionsRoot)) return { records, sessions, unreadable };
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const graphFile = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    sessions += 1;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
    } catch {
      unreadable += 1;
      continue;
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    marks.forEach((mark, index) => records.push(foldRecord(entry.name, index, mark)));
  }
  records.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId) || a.fold - b.fold);
  return { records, sessions, unreadable };
}

/** 汇总：覆盖率 + 质量 + 成本 + 闭包。 */
export function summarizeFolds(records) {
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
  const closureRecords = records.filter((r) => r.closure !== null);
  const emptyClosure = closureRecords.filter((r) => (r.closure.nodes ?? 0) === 0 && (r.closure.edges ?? 0) === 0).length;
  return {
    total,
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
    },
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
export function renderMarkdown({ home, records, summary, generatedAt }) {
  const lines = [];
  lines.push("# live fold 证据（自动汇总）");
  lines.push("");
  lines.push(`> 生成于 **${generatedAt}**（UTC），数据源 \`${home}/chess-context/sessions/*/graph.json\` 的 \`foldMarks[i]\`。`);
  lines.push("> 生成命令：`node scripts/live-folds.mjs`（只读；重跑会覆盖本文件与同名 .json）。");
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
  lines.push(`- 有 usage 的 fold：**${summary.cost.count}** 次，比值 **${summary.cost.inputPerShadowedMin ?? "—"} – ${summary.cost.inputPerShadowedMax ?? "—"}**`);
  lines.push("- 判据：比值 ≥ 2 时 doctor 判 warn（读得比压的多一倍以上）");
  lines.push("");
  lines.push("## 闭包");
  lines.push("");
  lines.push(`- 有 closure 的 fold：**${summary.closure.count}** 次，其中空闭包 **${summary.closure.empty}** 次（新会话尚无节点时属正常）`);
  lines.push(`- **悬空（dangling）**：${summary.dangling.count} 次有记录 —— residue ${summary.dangling.residue} / candidates ${summary.dangling.candidates} / liveUnsettled ${summary.dangling.liveUnsettled} / fromBroken ${summary.dangling.fromBroken}（合同 §6-4：liveUnsettled 升高 = fold 切在动作中间）`);
  lines.push(`- **边界完整性**：${summary.boundary.count} 次有 boundary 记录，其中切点落在工具调用中间的 **${summary.boundary.openAtEnd}** 次（正常应为 0），区间内未结算边合计 **${summary.boundary.unsettled}** 条`);
  lines.push(`- 其中 **preGraph ${summary.closure.preGraph} 次**：折叠区间早于本图（重启续跑的历史没有节点可回查）—— C30 起每次 fold 都会记这个布尔值，老 fold 没有该字段`);
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
  const dryRun = argv.includes("--dry-run");
  const jsonOnly = argv.includes("--json-only");
  const { records, sessions, unreadable } = collectLiveFolds(home);
  const summary = summarizeFolds(records);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = { schema: SCHEMA, generatedAt, home, sessions, unreadable, summary, folds: records };
  if (!dryRun) {
    nodeFs.mkdirSync(nodePath.dirname(outBase), { recursive: true });
    nodeFs.writeFileSync(`${outBase}.json`, JSON.stringify(payload, void 0, 2) + "\n", "utf8");
    if (!jsonOnly) nodeFs.writeFileSync(`${outBase}.md`, renderMarkdown({ home, records, summary, generatedAt }) + "\n", "utf8");
  }
  console.log(`live folds：${summary.total} 次（${sessions} 个会话${unreadable > 0 ? `，${unreadable} 个图读不出` : ""}）`);
  console.log(`  覆盖率 trigger ${summary.coverage.trigger}/${summary.total} · quality ${summary.coverage.quality}/${summary.total} · closure ${summary.coverage.closure}/${summary.total} · usage ${summary.coverage.usage}/${summary.total}`);
  console.log(`  trigger 分布：${Object.entries(summary.triggerCounts).map(([k, v]) => `${k}=${v}`).join(" ") || "（无）"}`);
  console.log(`  质量：c=${summary.quality.constraintRecallMin ?? "—"} / f=${summary.quality.failureRecallMin ?? "—"} · 压缩比 ${summary.quality.compressionRatioMin ?? "—"}–${summary.quality.compressionRatioMax ?? "—"} · unknownIds ${summary.quality.unknownIdsTotal}`);
  console.log(`  成本：输入/遮蔽 ${summary.cost.inputPerShadowedMin ?? "—"}–${summary.cost.inputPerShadowedMax ?? "—"}（${summary.cost.count} 次有 usage）`);
  console.log(dryRun ? "（dry-run：未写文件）" : `已写 ${outBase}.json${jsonOnly ? "" : ` 与 ${outBase}.md`}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
