/**
 * fold-per-session.mjs —— 从 `evidence/live-folds.json` 重新生成「逐会话折叠表」（C473）
 *
 * 由来：`evidence/fold质量-多会话-2026-11-02.md` 是**手写快照**，一旦 live-folds 刷新就过期，
 * 而 C118-2 会拿它跟数据比 —— 于是每一次刷新数据都要手动改文档（改漏就红）。
 * 生成物的正确姿势是**有生成器**，不是"下次记得手改"。
 *
 * 用法：node scripts/fold-per-session.mjs [--write]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUT = "evidence/fold质量-多会话-2026-11-02.md";

/**
 * 从 live-folds 数据渲染逐会话表（纯函数，便于单测）。
 * @param {{folds:Array<object>}} evidence
 * @returns {string}
 */
export function renderPerSession(evidence) {
  const folds = Array.isArray(evidence?.folds) ? evidence.folds : [];
  const bySession = new Map();
  for (const f of folds) {
    if (!f || typeof f.sessionId !== "string") continue;
    if (!bySession.has(f.sessionId)) bySession.set(f.sessionId, []);
    bySession.get(f.sessionId).push(f);
  }
  const rows = [...bySession.entries()]
    .map(([sessionId, list]) => {
      const quality = list.filter((x) => x.quality !== null && x.quality !== undefined).length;
      const withBoundary = list.filter((x) => x.boundary && typeof x.boundary.openAtEnd === "number");
      const openSum = withBoundary.reduce((n, x) => n + (x.boundary.openAtEnd ?? 0), 0);
      const recall = list.map((x) => x.quality?.constraintRecall).filter((x) => typeof x === "number");
      return {
        sessionId,
        folds: list.length,
        quality,
        boundaryCount: withBoundary.length,
        openSum,
        minRecall: recall.length === 0 ? null : Math.min(...recall),
        tier2: list.filter((x) => x.trigger === "tier2").length,
      };
    })
    .sort((a, b) => b.folds - a.folds);
  const boundaryTotal = folds.filter((x) => x.boundary && typeof x.boundary.openAtEnd === "number").length;
  const lines = [];
  lines.push("# 逐会话折叠质量（**生成物**，勿手改）");
  lines.push("");
  lines.push(`> 生成器：\`node scripts/fold-per-session.mjs --write\` · 数据源：\`evidence/live-folds.json\``);
  lines.push(`> 共 **${folds.length} 次 fold / ${rows.length} 个有 fold 的会话**；其中 **${boundaryTotal} 次带 boundary**，openAtEnd 合计 **${rows.reduce((n, r) => n + r.openSum, 0)}**。`);
  lines.push("");
  lines.push("| fold 次数 | 会话 | quality | boundary | openAtEnd | 约束召回最小值 | tier2 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.folds} | \`${r.sessionId.slice(0, 22)}…\` | ${r.quality} | ${r.boundaryCount} | ${r.openSum} | ${r.minRecall ?? "—"} | ${r.tier2} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(argv) {
  const evidence = JSON.parse(fs.readFileSync("evidence/live-folds.json", "utf8"));
  const text = renderPerSession(evidence);
  if (argv.includes("--write")) {
    fs.writeFileSync(path.resolve(OUT), text, "utf8");
    console.log(`已写 ${OUT}（${text.split("\n").length} 行）`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
