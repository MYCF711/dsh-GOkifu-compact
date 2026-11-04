#!/usr/bin/env node
/**
 * repair-node-docs.mjs —— 补写缺失的 `nodes/<id>.md`（C554）
 *
 * 由来：doctor 报「4 个节点缺 nodes/<id>.md（**热清单省略行会指向它们 ⇒ 空指针**）」。
 * 那些节点都在**归档会话**里：md 是**按落盘节流延迟写**的，会话在被节流窗口内归档，
 * 这次写入就再也不会发生（归档后引擎不再碰它）。
 *
 * 为什么不是"删掉了事"：热清单的省略行是 `nodes/<id>.md` 的形式，
 * md 不在 = 让人（和模型）去读一个不存在的文件 —— 那是实打实的空指针。
 *
 * 用法：
 *   node scripts/repair-node-docs.mjs            # 只报缺多少
 *   node scripts/repair-node-docs.mjs --write     # 真补
 *   node scripts/repair-node-docs.mjs --json
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";
import { renderNodeMd } from "../src/rooms/kifu-model.mjs";

/** 与其余脚本同口径的 home（`DSH_HOME` 优先）。 */
function resolveHome() {
  const env = String(process.env.DSH_HOME ?? "").trim();
  if (env !== "") return env;
  return nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 找出"图里有、磁盘上没有"的节点文档。纯函数（给单测用）。
 *
 * @param {object} graph
 * @param {(id:string) => boolean} exists md 是否存在
 * @returns {string[]} 缺失的节点 id（升序，稳定）
 */
export function missingNodeDocs(graph, exists) {
  const out = [];
  for (const id of Object.keys(graph?.nodes ?? {})) {
    if (typeof id !== "string" || id === "") continue;
    if (exists(id) === true) continue;
    out.push(id);
  }
  return out.sort();
}

export async function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const asJson = argv.includes("--json");
  const home = resolveHome();
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const report = [];
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = nodePath.join(sessionsRoot, entry.name);
      const graphFile = nodePath.join(dir, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      let graph = null;
      try {
        ({ graph } = loadSessionGraph(graphFile));
      } catch {
        continue;
      }
      const nodesDir = nodePath.join(dir, "nodes");
      const missing = missingNodeDocs(graph, (id) => nodeFs.existsSync(nodePath.join(nodesDir, `${id}.md`)));
      if (missing.length === 0) continue;
      if (write) {
        try {
          nodeFs.mkdirSync(nodesDir, { recursive: true });
          for (const id of missing) {
            const text = renderNodeMd(graph, id);
            if (text === "") continue;
            nodeFs.writeFileSync(nodePath.join(nodesDir, `${id}.md`), text, "utf8");
          }
        } catch (error) {
          report.push({ session: entry.name, missing: missing.length, written: 0, error: String(error?.message ?? error) });
          continue;
        }
      }
      report.push({ session: entry.name, missing: missing.length, written: write ? missing.length : 0, sample: missing.slice(0, 3) });
    }
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  } else if (report.length === 0) {
    console.log("✅ 没有缺失的 nodes/<id>.md");
  } else {
    const total = report.reduce((n, r) => n + r.missing, 0);
    console.log(`${write ? "已补写" : "! 缺失"} ${total} 个节点文档（${report.length} 个会话）：`);
    for (const r of report.slice(0, 10)) {
      console.log(`  ${r.session.slice(0, 20)} · ${r.missing} 个${r.sample ? `（如 ${r.sample.join(", ")}）` : ""}`);
    }
    if (!write) console.log("  真补：node scripts/repair-node-docs.mjs --write");
  }
  return report.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main(process.argv.slice(2)));
}

// ROOT 保留给将来（当前只用于定位仓库，避免 lint 报未使用）
void ROOT;
