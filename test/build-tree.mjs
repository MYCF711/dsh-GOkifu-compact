/**
 * build-tree.mjs —— 从已有 graph.json 一次性生成三层文件树（index / nodes / raw）
 * 用途：给 v1.2.0 之前就存在的会话补文件（新会话由 #flush 自动写）
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
for (const id of g.order) {
  const node = g.nodes[id];
  if (!node) continue;
  fs.writeFileSync(path.join(SESS, "nodes", `${id}.md`), renderNodeMd(g, id), "utf8");
  fs.writeFileSync(
    path.join(SESS, "raw", `${node.seq}.md`),
    `# raw seq=${node.seq}\n\n\`\`\`json\n${JSON.stringify(node, null, 2)}\n\`\`\`\n`,
    "utf8",
  );
  n += 1;
}
console.log(`built ${n} nodes -> ${SESS}`);
