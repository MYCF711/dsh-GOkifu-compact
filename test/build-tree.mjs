/**
 * build-tree.mjs —— 从已有 graph.json 一次性生成两层文件树（index / nodes）
 * 用途：给 v1.2.0 之前就存在的会话补文件（新会话由 #flush 自动写）；`--all` 用于
 *       批量修复「graph.json 被回洗/修复重写过、index.md 没跟上」的历史会话
 *
 * 不写 raw/：节点 JSON 与 graph.json 完全重复（v1.2.4 砍掉）。
 *
 * 用法：
 *   node test/build-tree.mjs                       # 默认会话（兼容旧调用）
 *   node test/build-tree.mjs <sessionDir>          # 指定会话
 *   node test/build-tree.mjs --all                 # 所有 index.md 落后 graph.json 的会话
 *   node test/build-tree.mjs --all --force         # 全部会话，不看时间
 */
import fs from "node:fs";
import path from "node:path";
import { fromJSON, renderIndexMd, renderNodeMd } from "../src/graph.mjs";

const CHESS_ROOT = path.join(process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home", "chess-context", "sessions");
const args = process.argv.slice(2);
const all = args.includes("--all");
const force = args.includes("--force");
const explicit = args.find((a) => !a.startsWith("--"));

function build(sessionDir) {
  const g = fromJSON(fs.readFileSync(path.join(sessionDir, "graph.json"), "utf8"));
  fs.writeFileSync(path.join(sessionDir, "index.md"), renderIndexMd(g), "utf8");
  fs.mkdirSync(path.join(sessionDir, "nodes"), { recursive: true });
  let n = 0;
  // 写所有节点（不只是 g.order）：被合并且仍被边引用的节点也要有文件
  for (const id of Object.keys(g.nodes)) {
    if (!g.nodes[id]) continue;
    fs.writeFileSync(path.join(sessionDir, "nodes", `${id}.md`), renderNodeMd(g, id), "utf8");
    n += 1;
  }
  return n;
}

/** index.md 是否落后 graph.json（超过 5 分钟） */
function stale(dir) {
  const index = path.join(dir, "index.md");
  if (!fs.existsSync(index)) return true;
  const g = fs.statSync(path.join(dir, "graph.json")).mtimeMs;
  return g - fs.statSync(index).mtimeMs > 5 * 60 * 1000;
}

if (all) {
  if (!fs.existsSync(CHESS_ROOT)) {
    console.error(`没有棋谱目录：${CHESS_ROOT}`);
    process.exit(1);
  }
  let rebuilt = 0;
  let nodes = 0;
  for (const d of fs.readdirSync(CHESS_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CHESS_ROOT, d.name);
    if (!fs.existsSync(path.join(dir, "graph.json"))) continue;
    if (!force && !stale(dir)) continue;
    try {
      nodes += build(dir);
      rebuilt += 1;
    } catch (error) {
      console.error(`  ! ${d.name}: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  console.log(`rebuilt ${rebuilt} 个会话（${nodes} 个节点文件）→ ${CHESS_ROOT}`);
} else {
  const sess = explicit ?? "D:/DeepSeek Harness/home/chess-context/sessions/session-5acafe42-b85b-4e06-845a-65428b43d7c0";
  console.log(`built ${build(sess)} nodes -> ${sess}`);
}
