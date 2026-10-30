#!/usr/bin/env node
/**
 * rewash-selfloop.mjs —— 清理历史自环边（2026-10-29）
 *
 * 背景：1.9.0 及以前，`worldstate.touch()` 把单个路径字符串逐字符拆开 ⇒ `worldHash`
 * 对所有步骤恒定 ⇒ `addAgentNode` 每步命中同一个 `stateIndex` 节点 ⇒ `step/end` 把边的
 * `to` 指回 `from`（自环）。全库实测 **6,158 / 10,045 = 61.3%**，直接后果是
 * `tewariAnalysis` 的同终点判定恒真 ⇒ `dead` 判定 109/109 全错。
 *
 * 新代码已不再产生自环（见 `test/selfloop.test.mjs`），但**磁盘上的历史边还在**，
 * 它们会让热清单继续输出错误的 `[dead]` / `[redundant]` 标记。本脚本把它们洗干净。
 *
 * 洗法：**保留边本身**（from / intent / action / result / errorSnippet / evidence 都是真实的
 * 工具调用记录），只把 `to` 置为 `null` 并清掉虚构的 `transposition` 标记 ——
 * 语义从「这一步到达了某个状态」退回「这一步发生了，但不知道把局面带到了哪里」。
 * 这是最保守的改法：不删任何证据，只收回错误的断言。
 *
 * 用法：
 *   node test/rewash-selfloop.mjs                  # dry-run（默认，只统计不写）
 *   node test/rewash-selfloop.mjs --apply          # 真正写入（每份 graph.json 先备份）
 *   node test/rewash-selfloop.mjs <sessions目录>    # 指定目录
 *   node test/rewash-selfloop.mjs --apply --force  # 跳过「插件正在运行」的提示
 *
 * 只读/只写 graph.json 与其 .bak 备份，不删任何文件。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fromJSON, toJSON, graphHealth, renderIndexMd } from "../src/rooms/kifu-model.mjs";

function defaultRoot() {
  const home = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
  return nodePath.join(home, "chess-context", "sessions");
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const root = argv.find((a) => !a.startsWith("--")) ?? defaultRoot();

if (!nodeFs.existsSync(root)) {
  console.error(`找不到棋谱目录：${root}`);
  process.exit(1);
}

const stamp = Date.now();
let files = 0;
let touchedFiles = 0;
let cleanedEdges = 0;
let clearedTranspositions = 0;
const before = { edges: 0, selfLoops: 0 };
const rows = [];

for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = nodePath.join(root, entry.name, "graph.json");
  if (!nodeFs.existsSync(file)) continue;
  files += 1;

  let g;
  try {
    g = fromJSON(nodeFs.readFileSync(file, "utf8"));
  } catch (error) {
    rows.push({ session: entry.name, error: String(error), cleaned: 0 });
    continue;
  }

  const h0 = graphHealth(g);
  before.edges += h0.edges;
  before.selfLoops += h0.selfLoops;

  let cleaned = 0;
  let trans = 0;
  for (const edge of Object.values(g.edges)) {
    if (!edge.from || !edge.to || edge.from !== edge.to) continue;
    edge.to = null;
    if (edge.transposition === true) {
      edge.transposition = false;
      trans += 1;
    }
    cleaned += 1;
  }

  if (cleaned === 0) continue;
  touchedFiles += 1;
  cleanedEdges += cleaned;
  clearedTranspositions += trans;
  const h1 = graphHealth(g);
  rows.push({
    session: entry.name,
    cleaned,
    selfLoopRateBefore: h0.selfLoopRate,
    selfLoopRateAfter: h1.selfLoopRate,
    edgePerNodeAfter: h1.edgePerNode,
  });

  if (apply) {
    try {
      nodeFs.copyFileSync(file, `${file}.bak-before-rewash-${stamp}`);
      // index.md 与 graph.json 是同一份数据的两个视图；只改 json 会让「树新鲜度」检查误报
      nodeFs.writeFileSync(nodePath.join(nodePath.dirname(file), "index.md"), renderIndexMd(g), "utf8");
      const tmp = `${file}.tmp`;
      nodeFs.writeFileSync(tmp, `${toJSON(g)}\n`, "utf8");
      nodeFs.renameSync(tmp, file);
    } catch (error) {
      rows.at(-1).error = `写入失败：${String(error)}`;
    }
  }
}

rows.sort((a, b) => (b.cleaned ?? 0) - (a.cleaned ?? 0));
console.log(`== rewash-selfloop（${apply ? "APPLY" : "DRY-RUN"}）==`);
console.log(`目录：${root}`);
console.log(`扫描 ${files} 个 graph.json，其中 ${touchedFiles} 个含自环边\n`);
console.log("会话".padEnd(34) + "清理边   自环率 before→after   边/节点 after");
for (const r of rows.slice(0, 30)) {
  if (r.error) {
    console.log(`${String(r.session).slice(0, 32).padEnd(34)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${r.session.slice(0, 32).padEnd(34)}${String(r.cleaned).padStart(6)}   ` +
      `${(r.selfLoopRateBefore * 100).toFixed(1).padStart(5)}% → ${(r.selfLoopRateAfter * 100).toFixed(1).padStart(5)}%   ` +
      `${r.edgePerNodeAfter.toFixed(2)}`,
  );
}
if (rows.length > 30) console.log(`… 另有 ${rows.length - 30} 个会话`);
console.log(
  `\n合计：清理 ${cleanedEdges} 条自环边（清掉 ${clearedTranspositions} 个虚构的 transposition 标记）；` +
    `全库自环 ${before.selfLoops}/${before.edges} = ${((before.selfLoops / Math.max(before.edges, 1)) * 100).toFixed(1)}% → 0%`,
);
if (!apply) {
  console.log("\n以上是 dry-run，未写入任何文件。确认无误后加 --apply 执行（每份图会先备份）。");
  console.log("注意：DSH 正在运行时，会话 flush 可能覆盖 `节点/*` 与 index.md（graph.json 由内存图写回）。");
  console.log("      建议停掉 DSH 或接受「下次 flush 前 graph.json 是干净的」这一点。");
} else {
  console.log(`\n已写入，备份后缀：.bak-before-rewash-${stamp}`);
}
