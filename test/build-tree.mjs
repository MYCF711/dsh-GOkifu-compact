/**
 * build-tree.mjs —— 从已有 graph.json 一次性生成两层文件树（index / nodes）
 * 用途：给 v1.2.0 之前就存在的会话补文件（新会话由 #flush 自动写）
 *
 * 不写 raw/：节点 JSON 与 graph.json 完全重复（v1.2.4 砍掉）。
 *
 * 用法：node test/build-tree.mjs [<sessionDir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fromJSON, renderIndexMd, renderNodeMd } from "../src/graph.mjs";

const SESS = process.argv[2] ?? "D:/DeepSeek Harness/home/chess-context/sessions/session-5acafe42-b85b-4e06-845a-65428b43d7c0";
const g = fromJSON(fs.readFileSync(path.join(SESS, "graph.json"), "utf8"));

fs.writeFileSync(path.join(SESS, "index.md"), renderIndexMd(g), "utf8");
fs.mkdirSync(path.join(SESS, "nodes"), { recursive: true });
let n = 0;
// 写所有节点（不只是 g.order）：被合并且仍被边引用的节点也要有文件
for (const id of Object.keys(g.nodes)) {
  if (!g.nodes[id]) continue;
  fs.writeFileSync(path.join(SESS, "nodes", `${id}.md`), renderNodeMd(g, id), "utf8");
  n += 1;
}
console.log(`built ${n} nodes -> ${SESS}`);
