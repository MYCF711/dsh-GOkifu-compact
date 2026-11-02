/**
 * live-bench.mjs —— 用真机数据生成「基准报告」（C376）
 *
 * 由来：`docs/` 里那些"真机数字"以前是**手抄**的（1072 passed / $0.83 / 40 分钟…），
 * 于是它们一路过期，最后连 HANDOFF 都在说旧事实（C373 就是被守卫逼着改的）。
 *
 * 这里把能机器算的全算掉：缓存命中率、花费分布、fold 耗时分布、欠账规模。
 *
 * 用法：
 *   node scripts/live-bench.mjs                 # 打到 stdout
 *   node scripts/live-bench.mjs --write         # 写入 docs/真机基准-自动生成.md
 *   node scripts/live-bench.mjs --json
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { scanAllSessions } from "./cache-rate.mjs";
import { aggregateCacheRate, sessionCosts } from "./cache-rate.mjs";
import { foldDurationStats } from "../src/rooms/closeout-plan.mjs";
import { buildPlan, summarizePlan, recommendMaxFoldTokens } from "./backfill-plan.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const OUT = nodePath.join(ROOT, "docs", "真机基准-自动生成.md");

/**
 * ★ C376：把各项实测汇总成一段 Markdown。纯函数（数据进、文本出），便于测试。
 * @param {{cache: object, folds: object, debt: object, sessions: number, files: number}} data
 * @returns {string}
 */
export function renderBenchDoc(data) {
  const { cache, folds, debt, files } = data;
  const hitPct = cache.hitRate === null ? "?" : (cache.hitRate * 100).toFixed(1);
  const lines = [
    "# 真机基准（自动生成，勿手改）",
    "",
    "> 由 `scripts/live-bench.mjs` 从 `DSH_HOME` 下的会话文件与棋谱算出。",
    "> 要更新：`node scripts/live-bench.mjs --write`。手改会被 `test/live-bench.test.mjs` 打回。",
    "",
    "## 一、缓存与花费",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 会话文件 | ${files} 个 |`,
    `| 请求数 | ${cache.requests.toLocaleString()} |`,
    `| 未命中 / 命中 / 输出 | ${cache.miss.toLocaleString()} / ${cache.hit.toLocaleString()} / ${cache.output.toLocaleString()} |`,
    `| **命中率** | **${hitPct}%**（分母 = 未命中 + 命中） |`,
    "",
    "## 二、花费分布（flash 低峰价估算）",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 全量估算 | **$${debt.totalCost.toFixed(2)}** |`,
    `| 最贵 5 个会话占比 | ${debt.top5Share === null ? "?" : (debt.top5Share * 100).toFixed(0) + "%"} |`,
    "",
    "## 三、折叠耗时",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 样本 | ${folds.n} 次 fold |`,
    `| 中位 / p90 / max | ${folds.median === null ? "?" : (folds.median / 1000).toFixed(1) + "s"} / ${
      folds.p90 === null ? "?" : (folds.p90 / 1000).toFixed(1) + "s"
    } / ${folds.max === null ? "?" : (folds.max / 1000).toFixed(1) + "s"} |`,
    "",
    "## 四、欠账（补账规模）",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 欠账会话 | ${debt.due ?? "?"} 个 |`,
    `| 估算 token | ${debt.tokens === null ? "?" : (debt.tokens / 1e6).toFixed(2) + " M"} |`,
    `| 段数 | ${debt.chunks ?? "?"} |`,
    `| 冷缓存估价 | ${debt.estCost === null ? "?" : "$" + debt.estCost.toFixed(2)} |`,
    `| 建议单段上限 | ${debt.recommendedMaxTokens === null ? "?" : debt.recommendedMaxTokens} |`,
    "",
  ];
  return lines.join("\n");
}

export async function buildBenchData(home) {
  const { usages, files } = scanAllSessions(home);
  const cache = aggregateCacheRate(usages);
  const rows = await buildPlan(home);
  const plan = summarizePlan(rows, { roughPerEvent: 154 });
  const dur = foldDurationStats(rows.flatMap((r) => r._ms ?? []));
  // 花费：按会话分组后取最贵 5 个占比
  const groups = [];
  {
    const { groups: groupsRaw } = scanAllSessions(home, { grouped: true });
    for (const g of groupsRaw ?? []) groups.push(g);
  }
  const costs = sessionCosts(groups);
  const totalCost = costs.reduce((n, r) => n + r.cost, 0);
  const top5 = costs.slice(0, 5).reduce((n, r) => n + r.cost, 0);
  return {
    files,
    cache,
    folds: dur,
    debt: {
      due: plan.total,
      tokens: plan.tokens,
      chunks: plan.chunks,
      estCost: plan.costUsd,
      recommendedMaxTokens: recommendMaxFoldTokens(rows)?.value ?? null,
      totalCost,
      top5Share: totalCost > 0 ? top5 / totalCost : null,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const home = process.env.DSH_HOME ?? "";
  if (home === "") {
    console.log("需要 DSH_HOME");
    return 2;
  }
  const data = await buildBenchData(home);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const doc = renderBenchDoc(data);
  if (argv.includes("--write")) {
    nodeFs.writeFileSync(OUT, doc, "utf8");
    console.log(`已写入 ${nodePath.relative(ROOT, OUT)}`);
    return 0;
  }
  process.stdout.write(doc);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
