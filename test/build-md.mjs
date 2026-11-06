/**
 * build-md.mjs —— 按需从 graph.json 生成整篇 graph.md（人读视图）
 * 为什么不自动写：三层文件树（index/nodes/raw）已经是人读视图，
 * 每次 flush 再写 177KB 的 graph.md 是纯 IO 浪费。
 *
 * 用法：node test/build-md.mjs [<sessionDir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fromJSON, renderMd } from "../src/rooms/kifu-model.mjs";

const SESS = process.argv[2] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "chess-context", "sessions", "example-session");
const g = fromJSON(fs.readFileSync(path.join(SESS, "graph.json"), "utf8"));
const md = renderMd(g);
fs.writeFileSync(path.join(SESS, "graph.md"), md, "utf8");
console.log(`graph.md written: ${md.length} chars -> ${SESS}`);
