/**
 * verify-graphs.mjs —— 全库棋谱健康检查（P0 worldHash 类型契约的验收工具）
 *
 * 用途：把 `<DSH_HOME>/chess-context/sessions/<sessionId>/graph.json` 全部过一遍
 * `fromJSON()`，校验三件事：
 *   1. 加载后 agent 节点的 `worldHash` / `constraintHash` 全是**字符串**
 *      （事故：v1.3.4 把 `worldstate.hash()` 的 `{hash,mode,files}` 对象写进了节点，
 *       ledger 的 `.slice()` 抛 TypeError → 226 次压缩只成功 3 次）
 *   2. 加载后 `renderFacts()` 不抛错（这是 summarize() 的第一步，抛错 = 压缩 100% 失败）
 *   3. 重新序列化（下一次 flush 写回的形态）不再有对象残留
 * 另外报告 `stateIndex` 的条目数（置换检测是否可用）—— 加载时按节点字段重建。
 *
 * 用法：
 *   node test/verify-graphs.mjs                 # 用 DSH_HOME 或默认路径
 *   node test/verify-graphs.mjs <sessions目录>  # 指定目录
 *   node test/verify-graphs.mjs --json          # 只输出 JSON（给脚本用）
 *
 * 退出码：0 = 全健康；1 = 有任何一条不健康（对象残留 / renderFacts 抛错 / 解析失败）。
 * 注意：本脚本**只读**，不写任何 graph.json —— 磁盘痊愈靠插件下次 flush。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fromJSON, toJSON, graphHealth } from "../src/graph.mjs";
import { renderFacts, renderLedger } from "../src/ledger.mjs";

function defaultRoot() {
  const home = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
  return nodePath.join(home, "chess-context", "sessions");
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const root = argv.find((a) => !a.startsWith("--")) ?? defaultRoot();

if (!nodeFs.existsSync(root)) {
  console.error(`找不到棋谱目录：${root}`);
  process.exit(1);
}

const rows = [];
let bad = 0;

for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = nodePath.join(root, entry.name, "graph.json");
  if (!nodeFs.existsSync(file)) continue;

  const row = {
    session: entry.name,
    agents: 0,
    objectWorldHashBefore: 0,
    objectWorldHashAfter: 0,
    stateIndexBefore: 0,
    stateIndexAfter: 0,
    factsChars: 0,
    ledgerTokens: 0,
    edges: 0,
    nodes: 0,
    selfLoops: 0,
    selfLoopRate: 0,
    edgePerNode: 0,
    warnings: [],
    problems: [],
  };

  let raw;
  try {
    raw = nodeFs.readFileSync(file, "utf8");
  } catch (error) {
    row.problems.push(`读文件失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    row.problems.push(`JSON 解析失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  const agentsOf = (g) => Object.values(g.nodes ?? {}).filter((n) => n && n.kind === "agent");
  row.agents = agentsOf(parsed).length;
  row.objectWorldHashBefore = agentsOf(parsed).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  row.stateIndexBefore = Object.keys(parsed.stateIndex ?? {}).length;

  let g;
  try {
    g = fromJSON(raw);
  } catch (error) {
    row.problems.push(`fromJSON 失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  row.objectWorldHashAfter = agentsOf(g).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  row.stateIndexAfter = Object.keys(g.stateIndex ?? {}).length;
  if (row.objectWorldHashAfter > 0) row.problems.push(`加载后仍有 ${row.objectWorldHashAfter} 个对象的 worldHash`);

  for (const node of agentsOf(g)) {
    if (typeof node.worldHash !== "string") row.problems.push(`${node.id}.worldHash 类型 ${typeof node.worldHash}`);
    if (typeof node.constraintHash !== "string") row.problems.push(`${node.id}.constraintHash 类型 ${typeof node.constraintHash}`);
  }

  try {
    row.factsChars = renderFacts(g).length;
  } catch (error) {
    row.problems.push(`renderFacts 抛错：${String(error)}`);
  }

  // 热清单也过一遍：它每步都渲染，是这条链路上最先炸的消费者之一
  try {
    row.ledgerTokens = renderLedger(g, { maxTokens: 500 }).tokens;
  } catch (error) {
    row.problems.push(`renderLedger 抛错：${String(error)}`);
  }

  const h = graphHealth(g);
  row.edges = h.edges;
  row.nodes = h.nodes;
  row.selfLoops = h.selfLoops;
  row.selfLoopRate = h.selfLoopRate;
  row.edgePerNode = h.edgePerNode;
  if (h.selfLoopRate >= 0.05) {
    row.warnings.push(`自环 ${h.selfLoops}/${h.edges} = ${(h.selfLoopRate * 100).toFixed(1)}% 图已坍缩，手割结论不可信`);
  }
  // 边/节点比只是信息：一步 K 次工具调用 ⇒ K 条边 + 1 节点。>8 才可能是异常（重试风暴）。
  if (h.edgePerNode > 8) row.warnings.push(`边/节点 ${h.edgePerNode.toFixed(2)} 大于 8，疑似重试风暴`);

  const round = JSON.parse(toJSON(g));
  const objectAfterRound = agentsOf(round).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  if (objectAfterRound > 0) row.problems.push(`重新序列化后仍有 ${objectAfterRound} 个对象`);

  if (row.problems.length > 0) bad += 1;
  rows.push(row);
}

const total = rows.reduce(
  (acc, r) => ({
    sessions: acc.sessions + 1,
    agents: acc.agents + r.agents,
    before: acc.before + r.objectWorldHashBefore,
    after: acc.after + r.objectWorldHashAfter,
    idxBefore: acc.idxBefore + r.stateIndexBefore,
    idxAfter: acc.idxAfter + r.stateIndexAfter,
    edges: acc.edges + r.edges,
    nodes: acc.nodes + r.nodes,
    selfLoops: acc.selfLoops + r.selfLoops,
    unhealthyGraphs: acc.unhealthyGraphs + (r.selfLoopRate >= 0.05 ? 1 : 0),
  }),
  { sessions: 0, agents: 0, before: 0, after: 0, idxBefore: 0, idxAfter: 0, edges: 0, nodes: 0, selfLoops: 0, unhealthyGraphs: 0 },
);

const summary = {
  root,
  sessions: total.sessions,
  agents: total.agents,
  objectWorldHash: { before: total.before, after: total.after },
  stateIndex: { before: total.idxBefore, after: total.idxAfter },
  unhealthySessions: bad,
  graphHealth: {
    edges: total.edges,
    nodes: total.nodes,
    selfLoops: total.selfLoops,
    selfLoopRate: total.edges > 0 ? total.selfLoops / total.edges : 0,
    edgePerNode: total.nodes > 0 ? total.edges / total.nodes : 0,
    collapsedGraphs: total.unhealthyGraphs,
  },
};

if (asJson) {
  console.log(JSON.stringify({ summary, rows }, null, 1));
} else {
  console.log(`== verify-graphs（${root}）==`);
  for (const r of rows) {
    const mark = r.problems.length === 0 ? "✓" : "✗";
    console.log(
      `  ${mark} ${r.session.slice(0, 34).padEnd(36)} agent ${String(r.agents).padStart(4)}  ` +
        `对象 ${r.objectWorldHashBefore}→${r.objectWorldHashAfter}  ` +
        `stateIndex ${r.stateIndexBefore}→${r.stateIndexAfter}  ` +
        `facts ${r.factsChars} 字 / ledger ${r.ledgerTokens} tok` +
        (r.problems.length ? `\n      ${r.problems.join("\n      ")}` : ""),
    );
  }
  console.log(
    `\n合计：${summary.sessions} 个会话 / ${summary.agents} 个 agent 节点 / ` +
      `对象 worldHash ${summary.objectWorldHash.before} → ${summary.objectWorldHash.after} / ` +
      `stateIndex ${summary.stateIndex.before} → ${summary.stateIndex.after}`,
  );
  const gh = summary.graphHealth;
  console.log(
    "图结构：边 " + gh.edges + " / 节点 " + gh.nodes + " / 自环 " + gh.selfLoops +
      " = " + (gh.selfLoopRate * 100).toFixed(1) + "% / 边节点比 " + gh.edgePerNode.toFixed(2) +
      " / 坍缩图 " + gh.collapsedGraphs + " 个",
  );
  console.log(bad === 0 ? "== 全部健康 ==" : bad + " 个会话不健康");
  if (gh.collapsedGraphs > 0) {
    console.log("");
    console.log("⚠ " + gh.collapsedGraphs + " 个图存在自环坍缩（修复前版本产生的历史边）；新产生的边已不再自环。");
    console.log("  历史边可用：node test/rewash-selfloop.mjs --apply（默认 dry-run）");
  }

}

process.exitCode = bad === 0 ? 0 : 1;
