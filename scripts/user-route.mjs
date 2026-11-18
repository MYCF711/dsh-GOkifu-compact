#!/usr/bin/env node
/**
 * user-route.mjs —— 会话级「棋路」导出 CLI（C667 初稿 / C668 接房间）
 *
 * 逻辑全在 `src/rooms/user-route.mjs`（R16）：本文件只做「找到会话 → 读图 → 调房间 → 打印」。
 * 为什么不在脚本里实现判据：R-A 明令 `src/**` 不得 import `scripts/**`，判据必须在房间里才能被引擎复用。
 *
 * 用法：
 *   node scripts/user-route.mjs --session <id>                 # 演练：打印摘要，不写盘
 *   node scripts/user-route.mjs --session <id> --json          # 打印容器 JSON（stdout）
 *   node scripts/user-route.mjs --session <id> --write         # 写 sessions/<id>/user-route.json
 *   node scripts/user-route.mjs --all [--write] [--limit N]    # 批量
 *
 * 诚实边界：
 *   · **C667 之前的图没有 `manual` 字段** ⇒ 旧会话导不出棋路（无法回溯，不猜）。
 *   · 子代理会话的 user 节点 `manual` 为 false（父代理的委派 prompt 没有 rpcId）⇒ 天然为空。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildUserRoute, writeUserRoute, readUserRouteCount, USER_ROUTE_FILE } from "../src/rooms/user-route.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "用法：",
  "  node scripts/user-route.mjs --session <sessionId> [--home <DSH_HOME>] [--json] [--write]",
  "  node scripts/user-route.mjs --all [--home <DSH_HOME>] [--write] [--limit <n>]",
  "",
  "  --session  会话 id（也接受唯一后缀）",
  "  --all      扫 home 下全部会话（默认只打印统计，--write 才落盘）",
  "  --home     DSH home（默认取 $DSH_HOME；都没有就报错，不猜绝对路径）",
  "  --json     把容器 JSON 打到 stdout",
  "  --write    落盘到 sessions/<safeSessionId>/" + USER_ROUTE_FILE,
  "  --limit    批量模式的最多处理数（默认 200）",
  "",
].join("\n");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

function homeDir() {
  // 不写死绝对 home：只认显式参数或宿主导出的 $DSH_HOME。
  const explicit = arg("home") ?? process.env.DSH_HOME;
  if (explicit) return explicit;
  process.stdout.write("❌ 缺 --home（或先导出 $DSH_HOME）\n");
  process.exit(2);
}

function sessionsRoot(home) {
  return nodePath.join(home, "chess-context", "sessions");
}

/** 找会话目录：先按 id 精确匹配，再按唯一后缀匹配。 */
function findSessionDir(home, wanted) {
  const root = sessionsRoot(home);
  if (!nodeFs.existsSync(root)) return { dir: null, reason: `没有会话目录：${root}` };
  const all = nodeFs.readdirSync(root).filter((d) => nodeFs.existsSync(nodePath.join(root, d, "graph.json")));
  const exact = all.find((d) => d === wanted);
  if (exact) return { dir: nodePath.join(root, exact), reason: null };
  const hits = all.filter((d) => d.includes(wanted));
  if (hits.length === 1) return { dir: nodePath.join(root, hits[0]), reason: null };
  if (hits.length === 0) return { dir: null, reason: `找不到会话：${wanted}` };
  return { dir: null, reason: `会话 id 不唯一（${hits.length} 个匹配），请给完整 id` };
}

function summarize(container) {
  const chars = container.messages.reduce((a, m) => a + m.text.length, 0);
  const first = container.messages[0];
  const last = container.messages[container.messages.length - 1];
  return {
    sessionId: container.sessionId,
    cwd: container.cwd,
    messages: container.messages.length,
    chars,
    spanSeq: first && last ? [first.seq, last.seq] : null,
  };
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length <= 2) {
    process.stdout.write(USAGE);
    return;
  }
  const home = homeDir();
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");

  if (process.argv.includes("--all")) {
    const root = sessionsRoot(home);
    if (!nodeFs.existsSync(root)) {
      process.stdout.write(`❌ 没有会话目录：${root}\n`);
      process.exit(3);
    }
    const limit = Number(arg("limit", "200")) || 200;
    const dirs = nodeFs.readdirSync(root).filter((d) => nodeFs.existsSync(nodePath.join(root, d, "graph.json"))).slice(0, limit);
    let sessions = 0, nonEmpty = 0, messages = 0, wrote = 0, skipped = 0;
    for (const d of dirs) {
      const dir = nodePath.join(root, d);
      let loaded;
      try {
        loaded = loadSessionGraph(nodePath.join(dir, "graph.json"));
      } catch {
        continue;
      }
      sessions += 1;
      const container = buildUserRoute(loaded.graph, { sessionId: d });
      if (container.messages.length > 0) {
        nonEmpty += 1;
        messages += container.messages.length;
      }
      if (!write) continue;
      const r = writeUserRoute(dir, loaded.graph, {
        sessionId: d,
        repaired: Boolean(loaded.deltaError || loaded.badTail),
      });
      if (r.written) wrote += 1;
      else if (r.reason && !/no-manual-messages/.test(r.reason)) skipped += 1;
    }
    process.stdout.write("== 会话级棋路导出 ==\n");
    process.stdout.write(`  home        ${home}\n`);
    process.stdout.write(`  扫描会话    ${sessions}\n`);
    process.stdout.write(`  有手动原话  ${nonEmpty}（${messages} 条）\n`);
    if (write) process.stdout.write(`  落盘        ${wrote} · 跳过（有原因）${skipped}\n`);
    else process.stdout.write(`  落盘        否（演练，加 --write 才写）\n`);
    process.stdout.write("\n  提示：C667 之前的图没有 manual 字段，旧会话天然为空 —— 这不是漏抓，是无法回溯。\n");
    return;
  }

  const wanted = arg("session");
  if (!wanted) {
    process.stdout.write(`❌ 缺 --session（或用 --all）\n\n${USAGE}`);
    process.exit(2);
  }
  const { dir, reason } = findSessionDir(home, wanted);
  if (!dir) {
    process.stdout.write(`❌ ${reason}\n`);
    process.exit(3);
  }
  const loaded = loadSessionGraph(nodePath.join(dir, "graph.json"));
  const sessionId = nodePath.basename(dir);
  const container = buildUserRoute(loaded.graph, { sessionId });

  if (asJson) process.stdout.write(`${JSON.stringify(container, null, 2)}\n`);
  else {
    const s = summarize(container);
    process.stdout.write("== 会话级棋路 ==\n");
    process.stdout.write(`  会话        ${s.sessionId}\n`);
    process.stdout.write(`  cwd         ${s.cwd || "(空)"}\n`);
    process.stdout.write(`  手动原话    ${s.messages} 条 · ${s.chars} 字\n`);
    process.stdout.write(`  seq 区间    ${s.spanSeq ? s.spanSeq.join(" → ") : "(无)"}\n`);
    process.stdout.write(`  delta 帧    ${loaded.deltaFrames}${loaded.deltaError ? `（异常：${loaded.deltaError}）` : ""}\n`);
    if (s.messages === 0) {
      process.stdout.write("\n  ⚠ 本会话没有「手动发送」的原话。可能原因：\n");
      process.stdout.write("     · 这是 C667 之前的旧图（当时还没记 manual 字段）—— 无法回溯；\n");
      process.stdout.write("     · 这是子代理会话（父代理的委派 prompt 没有 rpcId）；\n");
      process.stdout.write("     · 这一局确实没人手打。\n");
    }
  }

  if (!write) {
    process.stdout.write(`\n（演练：未写盘。加 --write 落到 ${nodePath.join(dir, USER_ROUTE_FILE)}）\n`);
    return;
  }
  const r = writeUserRoute(dir, loaded.graph, {
    sessionId,
    repaired: Boolean(loaded.deltaError || loaded.badTail),
  });
  const prev = readUserRouteCount(dir);
  if (!r.ok) {
    process.stdout.write(`❌ 未写盘：${r.reason}${prev !== null ? `（已有 ${prev} 条）` : ""}\n`);
    process.exit(3);
  }
  const stat = nodeFs.statSync(r.file);
  process.stdout.write(`\n✅ 已写 ${r.file}（${stat.size} B · ${r.count} 条）\n`);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();

export { buildUserRoute }; // 向后兼容：C667 的测试从这里拿纯函数
