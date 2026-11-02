#!/usr/bin/env node
/**
 * graph-audit.mjs —— 对**已有棋谱**做只读不变量体检（2026-11-02，C139）
 *
 * 为什么需要：`flush` 只在**写盘时**用 `validate()` 打一行告警，历史遗留的坏图（老版本合并 bug 留下的悬空边、
 * 回滚残骸、order 与节点表不一致）不会自己变好，也不会被 doctor 点名。
 * 这个脚本把「每张图是否自洽」变成可复核的一行结论。
 *
 * 检查项（都是纯结构，不跑模型、不写盘）：
 *   ① `validate()`（悬空边 / 失败边无原因 / agent 缺哈希）
 *   ② `stateIndex` 的 value 必须指向真实节点（悬空索引 = 命中后写出错边）
 *   ③ `order` 与 `nodes` 双向一致（缺节点 / 幽灵节点）
 *   ④ foldMark 的 closure 自洽（seqStart ≤ seqEnd、closure.nodes ≤ 折叠时 graphNodes）
 *
 * 用法：
 *   node scripts/graph-audit.mjs                     # 默认 home（与 doctor 同源）
 *   DSH_HOME=... node scripts/graph-audit.mjs        # 换 home
 *   node scripts/graph-audit.mjs --json              # 机读
 *
 * 退出码：发现任何不自洽 ⇒ 1；全绿 ⇒ 0。边界：只读。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { applyDelta, decodeDeltaFrames, fromJSON, renderNodeMd, sha, validate } from "../src/rooms/kifu-model.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes("--json");

/** 默认 home 的推导与 doctor 保持一致（DSH_HOME 优先）。 */
function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim().length > 0) return env.trim();
  return nodePath.join(os.homedir(), ".dsh");
}

/**
 * ★ C142（审查 P1-3）：`stateIndex` 必须在**原始 JSON** 上查 ——
 * `fromJSON()` 会无条件重建 stateIndex，所以在规范化后的图上查永远绿（假守护）。
 * @param {any} raw `JSON.parse(graph.json)` 的结果
 */
export function auditRawIndex(raw) {
  const problems = [];
  const nodes = raw?.nodes ?? {};
  for (const [key, id] of Object.entries(raw?.stateIndex ?? {})) {
    if (!nodes[id]) problems.push(`stateIndex["${key}"] → 不存在的节点 ${id}（原始文件）`);
  }
  return problems;
}

/**
 * 检查一张图，返回问题列表（空数组 = 自洽）。
 * @param {any} g 由 `fromJSON` 得到的图
 */
export function auditGraph(g) {
  const problems = [];
  for (const p of validate(g)) problems.push(p);

  for (const [key, id] of Object.entries(g.stateIndex ?? {})) {
    if (!g.nodes?.[id]) problems.push(`stateIndex["${key}"] → 不存在的节点 ${id}`);
  }

  const orderSet = new Set(g.order ?? []);
  for (const id of Object.keys(g.nodes ?? {})) {
    if (!orderSet.has(id)) problems.push(`order 缺节点 ${id}`);
  }
  for (const id of g.order ?? []) {
    if (!g.nodes?.[id]) problems.push(`order 有幽灵节点 ${id}`);
  }

  for (const [i, mark] of (g.foldMarks ?? []).entries()) {
    const start = Number(mark?.seqStart);
    const end = Number(mark?.seqEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && start > end) problems.push(`foldMarks[${i}] seqStart>seqEnd`);
    const c = mark?.closure;
    if (c && typeof c.nodes === "number" && typeof c.graphNodes === "number" && c.nodes > c.graphNodes) {
      problems.push(`foldMarks[${i}] closure.nodes(${c.nodes}) > graphNodes(${c.graphNodes})`);
    }
  }
  return problems;
}

/**
 * ★ C143（审查 P1-2 / P1-4）：读图必须**重放 delta** —— 运行时 `kifu-persist.load()` 就是这么干的。
 * 只读 `graph.json` 会得到一份「过期基线」：既会把只在 delta 里的节点当成不存在（误报陈旧 md）、
 * 也会漏掉 delta 里带 `delNodes` 的坏图（假绿）。
 * @returns {{raw: any, graph: any, deltaFrames: number}}
 */
export function loadSessionGraph(graphFile) {
  const text = nodeFs.readFileSync(graphFile, "utf8");
  const raw = JSON.parse(text);
  const graph = fromJSON(text);
  let deltaFrames = 0;
  let deltaError = null;
  let badTail = false;
  const deltaFile = `${graphFile}.delta.jsonl`;
  if (nodeFs.existsSync(deltaFile)) {
    try {
      const decoded = decodeDeltaFrames(nodeFs.readFileSync(deltaFile, "utf8"), sha(text).slice(0, 16));
      badTail = Boolean(decoded.badTail);
      for (const frame of decoded.frames) {
        applyDelta(graph, frame);
        deltaFrames += 1;
      }
    } catch (error) {
      // ★ C148（复审 P1-3）：**不许吞掉** —— 吞掉会让体检看到「部分回放」的图却报「全部自洽」。
      deltaError = String(error?.message ?? error).slice(0, 160);
    }
  }
  return { raw, graph, deltaFrames, deltaError, badTail };
}

/**
 * ★ C144：补写缺失的 `nodes/<id>.md`（**只增不删**）。
 *
 * 为什么安全：这些文件是**派生视图**（`renderNodeMd(graph, id)` 的确定性输出），
 * 真相在 `graph.json` + `delta`。缺文件的成因是历史缺陷（如 C142 的 P0：回滚清掉了 dirty，
 * 于是该节点的 md 永远没被写出来），补写等于重建视图，不会改变任何事实。
 *
 * 只写「缺的」，绝不删除/覆盖已存在的文件；返回写入的 id 列表。
 */
export function repairMissingDocs(sessionsDir, { dryRun = false } = {}) {
  const written = [];
  if (!nodeFs.existsSync(sessionsDir)) return written;
  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const graphFile = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    let loaded;
    try {
      loaded = loadSessionGraph(graphFile);
    } catch {
      continue;
    }
    const nodesDir = nodePath.join(sessionsDir, name, "nodes");
    const have = new Set(nodeFs.existsSync(nodesDir) ? nodeFs.readdirSync(nodesDir).map((f) => f.replace(/\.md$/i, "")) : []);
    const missing = Object.keys(loaded.graph.nodes ?? {}).filter((id) => !have.has(id));
    if (missing.length === 0) continue;
    if (!dryRun) nodeFs.mkdirSync(nodesDir, { recursive: true });
    for (const id of missing) {
      if (!dryRun) nodeFs.writeFileSync(nodePath.join(nodesDir, `${id}.md`), renderNodeMd(loaded.graph, id), "utf8");
      written.push(`${name}/${id}`);
    }
  }
  return written;
}

/** 扫一个 sessions 目录，返回每张图的问题。 */
export function auditRoot(sessionsDir) {
  const out = [];
  if (!nodeFs.existsSync(sessionsDir)) return out;
  for (const name of nodeFs.readdirSync(sessionsDir)) {
    const file = nodePath.join(sessionsDir, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let loaded;
    try {
      loaded = loadSessionGraph(file);
    } catch (error) {
      out.push({ session: name, problems: [`graph.json 无法解析：${String(error?.message ?? error).slice(0, 120)}`] });
      continue;
    }
    const problems = [...auditRawIndex(loaded.raw), ...auditGraph(loaded.graph)];
    if (loaded.deltaError) problems.push(`delta 帧无法回放（图可能停在部分回放）：${loaded.deltaError}`);
    if (loaded.badTail) problems.push("delta 尾部有残帧（写入中断留下的半帧）");
    out.push({ session: name, problems });
  }
  return out;
}

function main() {
  const home = resolveHome();
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");
  // ★ C144：`--repair` 先补写缺失的派生视图（只增不删），再体检
  if (process.argv.includes("--repair")) {
    const written = repairMissingDocs(sessionsDir, { dryRun: process.argv.includes("--dry-run") });
    const suffix = process.argv.includes("--dry-run") ? "（dry-run，未写盘）" : "";
    process.stdout.write(`补写缺失节点文档：${written.length} 个${suffix}` + String.fromCharCode(10));
    for (const item of written.slice(0, 12)) process.stdout.write(`  + ${item}` + String.fromCharCode(10));
  }
  const rows = auditRoot(sessionsDir);
  const bad = rows.filter((r) => r.problems.length > 0);
  if (asJson) {
    process.stdout.write(JSON.stringify({ home, sessions: rows.length, bad, ok: bad.length === 0 }, null, 2) + String.fromCharCode(10));
  } else {
    process.stdout.write(`棋谱体检：${home}` + String.fromCharCode(10));
    process.stdout.write(`  会话 ${rows.length} 个 · 不自洽 ${bad.length} 个` + String.fromCharCode(10));
    for (const row of bad.slice(0, 12)) {
      process.stdout.write(`  ✗ ${row.session}：${row.problems.slice(0, 3).join("; ")}${row.problems.length > 3 ? ` …共 ${row.problems.length} 条` : ""}` + String.fromCharCode(10));
    }
    if (bad.length === 0) process.stdout.write("  ✅ 全部自洽（悬空边 / 索引 / order / 闭包）" + String.fromCharCode(10));
  }
  process.exit(bad.length === 0 ? 0 : 1);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
