#!/usr/bin/env node
/**
 * repair-node-docs.mjs —— 补写缺失的 `nodes/<id>.md`（C554）+ 清理陈旧 md（C607）
 *
 * 由来：doctor 报「12 个节点缺 nodes/<id>.md（**热清单省略行会指向它们 ⇒ 空指针**）」。
 * 那些节点都在**归档会话**里：md 是**按落盘节流延迟写**的，会话在被节流窗口内归档，
 * 这次写入就再也不会发生（归档后引擎不再碰它）。
 *
 * 为什么不是"删掉了事"：热清单的省略行是 `nodes/<id>.md` 的形式，
 * md 不在 = 让人（和模型）去读一个不存在的文件 —— 那是实打实的空指针。
 *
 * 另一个方向（文件比节点多）是**陈旧工件**：节点被回滚/合并删除后 md 没清。
 * 它不误导阅读（热清单只引用图里存在的节点），但会一直躺在盘上（live 实测 39 个，
 * 全部紧邻 maxNode —— 「写了又回滚」的残骸）。清理必须**显式**：
 * `--prune`（预演）/ `--prune --write`（真删）。
 *
 * ★ C607 两条口径：
 *   ① **在途不补**：节点刚创建（<2 分钟）**且**图仍在写（2 分钟内更新过）⇒ md 只是还没轮到写。
 *      这时补出来的是**不完整快照**（节点还在长），比缺失更坏 —— 跳过并单列。
 *      判据与 doctor C110 共用 `splitMissingNodeDocs`（两边各写一套迟早会打架：
 *      repair 跳过的，doctor 会当成"缺"一直红）。
 *   ② **陈旧 md 的删除有三条护栏**（与引擎 `src/rooms/kifu-persist.mjs` 的 `pruneStaleNodeDocs` 同源）：
 *      只认 `^n[0-9]+\.md$`；**图不可信时一个都不删**（读不出 / 空图 / 空 order /
 *      delta 只回放了一部分）；默认只预演，`--write` 才真删，且**先打印清单与总数再删**。
 *
 * 用法：
 *   node scripts/repair-node-docs.mjs                  # 预演：报缺多少（在途单列，不算缺）
 *   node scripts/repair-node-docs.mjs --write          # 真补（跳过在途）
 *   node scripts/repair-node-docs.mjs --prune          # 预演：列出将删的陈旧 md（一个都不删）
 *   node scripts/repair-node-docs.mjs --prune --write  # 真删陈旧 md（先打印清单与总数）
 *   node scripts/repair-node-docs.mjs --json
 *
 * 退出码：0 = 无事可做（或 `--write` 全部成功）；1 = 预演发现待办；2 = 有写/删失败。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";
import { renderNodeMd } from "../src/rooms/kifu-model.mjs";

/**
 * 「在途」窗口（ms）。**与 doctor C110 同一个常量** —— 两边必须同口径，
 * 否则会出现「repair 跳过了它、doctor 却一直报缺」的死结。
 *
 * 为什么是 2 分钟：`nodes/*.md` 的写出是**节流**的（dirty 攒进 pending，下一次落盘才写），
 * 而落盘由会话事件驱动。2 分钟 ≫ 一次落盘间隔、又 ≪ 「这个人早就不用了」的量级，
 * 所以它同时满足两件事：活跃会话里的正常中间态不误报；真·静止的会话立刻报警。
 * ★ C148 的补充：只看 `graph.updatedAt` 会让「一直活跃的会话里**永久**缺失的 md」永远算在途、
 *   永不报警 —— 所以必须**同时**要求「节点自己也是刚创建的」（按节点 ts）。
 */
export const IN_FLIGHT_MS = 120_000;

/** 一次最多打印多少行（真实数据可能几百个，别把终端刷爆）。 */
const MAX_LINES = 40;

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

/**
 * ★ C607：把「缺失」拆成**真缺失**与**在途**两段（纯函数，doctor 与 repair 共用）。
 *
 * 在途 = 图最近 `IN_FLIGHT_MS` 内更新过（会话仍在写）**且** 节点本身也是最近创建的。
 * 两个条件缺一不可：只满足前者 ⇒ 活跃会话里的真·永久缺失被永久掩盖（C148）；
 * 只满足后者 ⇒ 图早就不写了，那就是真缺失。
 *
 * 保守方向：`ts` 缺失 / `updatedAt` 缺失 ⇒ 一律算**真缺失**（宁可多报，不许假绿）。
 *
 * @param {object} graph
 * @param {string[]} missing `missingNodeDocs` 的结果
 * @param {number} [now] 注入时间（测试用）
 * @returns {{missing:string[], inFlight:Array<{id:string,nodeAgeMs:number,graphAgeMs:number}>}}
 */
export function splitMissingNodeDocs(graph, missing, now = Date.now()) {
  const graphAgeMs = now - (Number(graph?.updatedAt) || 0);
  const real = [];
  const inFlight = [];
  for (const id of Array.isArray(missing) ? missing : []) {
    const nodeAgeMs = now - (Number(graph?.nodes?.[id]?.ts) || 0);
    if (graphAgeMs < IN_FLIGHT_MS && nodeAgeMs < IN_FLIGHT_MS) inFlight.push({ id, nodeAgeMs, graphAgeMs });
    else real.push(id);
  }
  return { missing: real, inFlight };
}

/**
 * ★ C607：找出「md 在、节点已不在图里」的陈旧文档（纯函数）。
 *
 * 护栏（与引擎 `pruneStaleNodeDocs` 同源）：**只认 `^n[0-9]+\.md$`** ——
 * `notes.md` / `n9.md.bak` / 目录一律不碰。名字不合规的文件不归我们管。
 *
 * @param {object} graph
 * @param {string[]} files `nodes/` 目录里的**文件名**
 * @returns {string[]} 陈旧文档的节点 id（升序）
 */
export function orphanNodeDocs(graph, files) {
  const ids = new Set(Object.keys(graph?.nodes ?? {}));
  const out = [];
  for (const name of Array.isArray(files) ? files : []) {
    const text = String(name);
    if (!/^n[0-9]+\.md$/.test(text)) continue;
    const id = text.slice(0, -3);
    if (ids.has(id)) continue;
    out.push(id);
  }
  return out.sort();
}

/** 把一列条目排成多行（超过 MAX_LINES 行就收口）。 */
function formatRows(rows) {
  const lines = rows.slice(0, MAX_LINES).map((row) => `  ${row}`);
  if (rows.length > MAX_LINES) lines.push(`  … 另有 ${rows.length - MAX_LINES} 个`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const prune = argv.includes("--prune");
  const asJson = argv.includes("--json");
  const home = resolveHome();
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const now = Date.now();
  /** @type {Array<{session:string, missing:string[], inFlight:Array<{id:string,nodeAgeMs:number}>, written:string[], orphans:string[], deleted:string[], pruneSkipReason:string|null, writeErrors:string[]}>} */
  const sessions = [];
  const unreadable = [];
  const writeErrors = [];
  let scanned = 0;

  if (nodeFs.existsSync(sessionsRoot)) {
    const entries = nodeFs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const dir = nodePath.join(sessionsRoot, entry.name);
      const graphFile = nodePath.join(dir, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      let loaded;
      try {
        // 与 doctor 同一条路径：**必须重放 delta**，否则「只在 delta 里、其实还活着」的节点
        // 会被当成不存在（误报陈旧 ⇒ 删掉真文档）。
        loaded = loadSessionGraph(graphFile);
      } catch (error) {
        // 读不出（旧版本图 / 坏图）⇒ 这个会话的图**不可信**：补写与删除都不许做。
        unreadable.push(`${entry.name.slice(0, 16)}: ${String(error?.message ?? error).slice(0, 60)}`);
        continue;
      }
      const graph = loaded.graph;
      scanned += 1;
      const nodesDir = nodePath.join(dir, "nodes");
      const files = nodeFs.existsSync(nodesDir)
        ? nodeFs
            .readdirSync(nodesDir, { withFileTypes: true })
            .filter((item) => item.isFile())
            .map((item) => item.name)
        : [];
      const have = new Set(files.map((name) => String(name).replace(/\.md$/i, "")));
      const split = splitMissingNodeDocs(graph, missingNodeDocs(graph, (id) => have.has(id)), now);

      // ── 陈旧 md：三条护栏，任一条不满足就一个都不删 ──
      let orphans = [];
      let pruneSkipReason = null;
      if (Object.keys(graph?.nodes ?? {}).length === 0 || (graph?.order ?? []).length === 0) {
        pruneSkipReason = "图是空的（读不出/被重建）—— 按「不在图里」删会把整个 nodes/ 清空";
      } else if (loaded.deltaError) {
        pruneSkipReason = `delta 回放失败（${String(loaded.deltaError).slice(0, 40)}）—— 只看到部分图`;
      } else if (loaded.badTail) {
        pruneSkipReason = "delta 尾部残帧 —— 只看到部分图";
      } else {
        orphans = orphanNodeDocs(graph, files);
      }

      // ── 真补：只补真缺失，**在途一个都不补**（补进去的是不完整快照）──
      const written = [];
      const sessionErrors = [];
      if (write && split.missing.length > 0) {
        try {
          nodeFs.mkdirSync(nodesDir, { recursive: true });
        } catch (error) {
          sessionErrors.push(`mkdir nodes/: ${String(error?.message ?? error).slice(0, 60)}`);
        }
        if (sessionErrors.length === 0) {
          for (const id of split.missing) {
            try {
              const text = renderNodeMd(graph, id);
              if (text === "") continue;
              nodeFs.writeFileSync(nodePath.join(nodesDir, `${id}.md`), text, "utf8");
              written.push(id);
            } catch (error) {
              sessionErrors.push(`${id}: ${String(error?.message ?? error).slice(0, 60)}`);
            }
          }
        }
      }
      writeErrors.push(...sessionErrors.map((line) => `${entry.name.slice(0, 16)}: ${line}`));

      // 被护栏挡下的会话也要进报告 —— 否则「一个都没删」和「没扫到」长得一样。
      if (split.missing.length === 0 && split.inFlight.length === 0 && orphans.length === 0 && sessionErrors.length === 0) {
        if (!(prune && pruneSkipReason)) continue;
      }
      sessions.push({
        session: entry.name,
        missing: split.missing,
        inFlight: split.inFlight.map((item) => ({ id: item.id, nodeAgeMs: item.nodeAgeMs })),
        written,
        orphans,
        deleted: [],
        pruneSkipReason,
        writeErrors: sessionErrors,
      });
    }
  }

  const sum = (pick) => sessions.reduce((total, row) => total + pick(row), 0);
  const totals = {
    scanned,
    missing: sum((row) => row.missing.length),
    inFlight: sum((row) => row.inFlight.length),
    orphans: sum((row) => row.orphans.length),
    written: sum((row) => row.written.length),
    deleted: 0,
    // 真的有节点文档问题的会话数（不是扫到的会话数）
    sessions: sessions.length,
    unreadable: unreadable.length,
    writeErrors: writeErrors.length,
  };
  const sessionTag = (name) => String(name).slice(0, 16);

  // ── 预演输出：**删除清单必须在删之前打印** ──
  if (!asJson) {
    if (totals.missing > 0) {
      console.log(`! 待补 ${totals.missing} 个节点文档（${sessions.filter((row) => row.missing.length > 0).length} 个会话）：`);
      const rows = [];
      for (const row of sessions) for (const id of row.missing) rows.push(`${sessionTag(row.session)}:${id}`);
      console.log(formatRows(rows));
      if (!write) console.log("  真补：node scripts/repair-node-docs.mjs --write");
    }
    if (totals.inFlight > 0) {
      console.log(
        `⏳ 另有 ${totals.inFlight} 个在途（节点创建 <${Math.round(IN_FLIGHT_MS / 1000)} 秒、图仍在写 ⇒ md 按落盘节流延迟写出）：**不补** —— 补进去的是不完整快照`,
      );
      const rows = [];
      for (const row of sessions) for (const item of row.inFlight) rows.push(`${sessionTag(row.session)}:${item.id}（创建于 ${Math.round(item.nodeAgeMs / 1000)}s 前）`);
      console.log(formatRows(rows));
    }
    if (prune && totals.orphans > 0) {
      console.log(`🧹 陈旧 md ${totals.orphans} 个（节点已不在任何图里；${sessions.filter((row) => row.orphans.length > 0).length} 个会话）—— 将删除：`);
      const rows = [];
      for (const row of sessions) for (const id of row.orphans) rows.push(`${sessionTag(row.session)}:${id}`);
      console.log(formatRows(rows));
      if (!write) console.log("  真删：node scripts/repair-node-docs.mjs --prune --write");
    } else if (totals.orphans > 0) {
      console.log(`ℹ️  另有 ${totals.orphans} 个陈旧 md（节点已不在图里；不影响引用，仅计数）—— 预演清理：--prune`);
    }
    for (const row of sessions) {
      if (row.pruneSkipReason) console.log(`⚠️  ${sessionTag(row.session)} 跳过陈旧 md 清理：${row.pruneSkipReason}`);
    }
    if (unreadable.length > 0) {
      console.log(`⚠️  ${unreadable.length} 个会话的图读不出（旧版本/坏图）—— 补写与删除都不会碰：${unreadable.slice(0, 2).join(" / ")}`);
    }
    if (writeErrors.length > 0) {
      for (const line of writeErrors.slice(0, 10)) console.log(`✗ ${line}`);
    }
    if (totals.missing === 0 && totals.inFlight === 0 && totals.orphans === 0 && unreadable.length === 0) {
      console.log("✅ 没有缺失的 nodes/<id>.md，也没有陈旧 md");
    }
  }

  // ── 真删（只有 `--prune --write`；清单已在上面打完）──
  if (write && prune) {
    for (const row of sessions) {
      if (row.orphans.length === 0) continue;
      const nodesDir = nodePath.join(sessionsRoot, row.session, "nodes");
      for (const id of row.orphans) {
        try {
          nodeFs.unlinkSync(nodePath.join(nodesDir, `${id}.md`));
          row.deleted.push(id);
          totals.deleted += 1;
        } catch (error) {
          writeErrors.push(`${sessionTag(row.session)}:${id} 删除失败 ${String(error?.message ?? error).slice(0, 60)}`);
        }
      }
    }
    totals.writeErrors = writeErrors.length;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ sessions, totals }, null, 1)}\n`);
  } else if (write) {
    // 只报**真做过**的事：只删不补时不许打「已补写 0 个」（读着像写失败了）。
    const parts = [];
    if (totals.written > 0) parts.push(`✅ 已补写 ${totals.written} 个节点文档（${sessions.filter((row) => row.written.length > 0).length} 个会话）`);
    if (totals.deleted > 0) parts.push(`🧹 已删除 ${totals.deleted} 个陈旧 md`);
    if (parts.length > 0) console.log(parts.join(" · "));
  }

  if (writeErrors.length > 0) return 2;
  if (!write && (totals.missing > 0 || (prune && totals.orphans > 0))) return 1;
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main(process.argv.slice(2)));
}

// ROOT 保留给将来（当前只用于定位仓库，避免 lint 报未使用）
void ROOT;
