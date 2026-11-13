#!/usr/bin/env node
/**
 * graph-cache-memory.mjs —— 冷图缓存到底占多少内存、回收后能不能还回去（C659，**只读**）。
 *
 * 背景：`graphs` / `runtime` 是按会话常驻的（C656 之前**没有清理路径**）。一台机器上
 * 一千多个会话、单张图最大 ~10 MB JSON —— 进程活久了就是「窗口早关了，图还在内存里」。
 * C656 加了闸门，C659 补了静默窗口 / full 窗口 / sessionRefs 释放。这个脚本把
 * 「值多少、还回去多少」变成**可复跑的一个数**，而不是某次对话里的截图。
 *
 * 只读保证：
 *   · 只 `readFileSync` 真实 `graph.json`；落盘根指向 `os.tmpdir()`，全程**不调 flush**；
 *   · 回收只做 `Map.delete`（源码里没有任何 rm/unlink/write）；
 *   · 前后比对每张图的 mtime，必须**逐个未变**，否则脚本判红。
 *
 * 用法：
 *   node scripts/graph-cache-memory.mjs                          # 默认取最大的 12 张
 *   node scripts/graph-cache-memory.mjs --all                     # 全部（慢，堆会真涨）
 *   node scripts/graph-cache-memory.mjs --top 100 --soak 60       # 回收后空转 60s 采 RSS
 *   node scripts/graph-cache-memory.mjs --home <DSH_HOME>/chess-context --json
 *
 * 退出码：0 = 全部断言通过；1 = 有断言不成立（回收没生效 / 磁盘被写 / 堆没回落）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/** 默认 home：`$DSH_HOME/chess-context`，再退回本机常见位置。 */
export function defaultHome() {
  const candidates = [];
  if (process.env.DSH_HOME) candidates.push(nodePath.join(process.env.DSH_HOME, "chess-context"));
  if (process.env.CHESS_CONTEXT_HOME) candidates.push(process.env.CHESS_CONTEXT_HOME);
  candidates.push(nodePath.join(nodeOs.homedir(), ".dsh", "chess-context"));
  return candidates.find((dir) => nodeFs.existsSync(nodePath.join(dir, "sessions"))) ?? null;
}

/** 只读扫出所有会话的 graph.json（按字节降序）。 */
export function scanGraphs(chessContextRoot) {
  const sessionsDir = nodePath.join(chessContextRoot, "sessions");
  const files = [];
  let entries;
  try {
    entries = nodeFs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsDir, entry.name, "graph.json");
    try {
      const st = nodeFs.statSync(file);
      files.push({ id: entry.name, file, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 没有 graph.json 的会话目录（未触发过压缩）—— 正常 */
    }
  }
  return files.sort((a, b) => b.size - a.size);
}

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
const gc2 = () => {
  global.gc();
  global.gc();
};

/* ─────────────────────────── 子进程：真正量 ─────────────────────────── */

async function childMain(chessContextRoot, topN, soakSeconds) {
  const { load: loadEngine, makeCtx } = await import(new URL("../test/engine-harness.test.mjs", import.meta.url).href);
  const all = scanGraphs(chessContextRoot);
  const picked = topN === 0 ? all : all.slice(0, Math.max(1, topN));
  if (picked.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "没有可用的 graph.json", home: chessContextRoot }, null, 2));
    return 1;
  }
  const pickedBytes = picked.reduce((sum, f) => sum + f.size, 0);
  const mtimeBefore = picked.map((f) => f.mtimeMs);

  const { Engine } = await loadEngine();
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-mem-"));
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  // 本测量直接把图塞进缓存，不走事件路径 ⇒ lastSeenAt 为空，静默窗口自然不挡；
  // 但显式压到 0 更稳（不依赖实现细节）。
  engine.coldGraphQuietMs = 0;

  gc2();
  const base = process.memoryUsage();

  const shapes = [];
  for (const f of picked) {
    const graph = JSON.parse(nodeFs.readFileSync(f.file, "utf8"));
    shapes.push({ id: f.id, bytes: f.size, nodes: Object.keys(graph.nodes ?? {}).length, edges: Object.keys(graph.edges ?? {}).length });
    engine.graphs.set(f.id, graph);
    engine.runtime.set(f.id, { events: 0 });
    engine.lastFlush.set(f.id, { ok: true, full: true, at: Date.now() });
  }
  gc2();
  const loaded = process.memoryUsage();
  const resident = engine.getGraphCacheStats();

  const release = engine.releaseColdGraphs({ keep: [], reason: "graph-cache-memory" });
  // 给 V8 一拍机会清大对象（同步 gc 之外还要等一次事件循环）
  await new Promise((resolve) => setTimeout(resolve, 80));
  gc2();
  const after = process.memoryUsage();
  const stats = engine.getGraphCacheStats();

  const mtimeAfter = picked.map((f) => nodeFs.statSync(f.file).mtimeMs);
  const unchanged = mtimeBefore.every((m, i) => m === mtimeAfter[i]);

  // 空转采 RSS：长跑进程的真实收益是「不再继续增长」，不是「当场还给系统」（V8 保留页）
  const soak = [];
  for (let i = 0; i < soakSeconds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    soak.push({ atSec: i + 1, rssMB: mb(process.memoryUsage().rss), heapMB: mb(process.memoryUsage().heapUsed) });
  }

  nodeFs.rmSync(dir, { recursive: true, force: true });

  const heapGrew = loaded.heapUsed - base.heapUsed;
  const heapRetained = after.heapUsed - base.heapUsed;
  const rssGrew = loaded.rss - base.rss;
  const rssRetained = after.rss - base.rss;
  const biggest = picked[0];

  const checks = [
    { id: "released-all", ok: release.released.length === picked.length, detail: `${release.released.length}/${picked.length}` },
    { id: "graphs-empty", ok: stats.graphs === 0, detail: `graphs=${stats.graphs}` },
    { id: "runtime-empty", ok: stats.runtime === 0, detail: `runtime=${stats.runtime}` },
    { id: "sessionRefs-empty", ok: stats.sessionRefs === 0, detail: `sessionRefs=${stats.sessionRefs}` },
    { id: "lastSeen-empty", ok: stats.lastSeen.length === 0, detail: `lastSeen=${stats.lastSeen.length}` },
    { id: "heap-freed", ok: picked.length < 3 || heapRetained < heapGrew * 0.35, detail: `grew=${mb(heapGrew)}MB retained=${mb(heapRetained)}MB` },
    { id: "disk-untouched", ok: unchanged, detail: unchanged ? `${picked.length}/${picked.length} mtime 未变` : "有图被写过" },
  ];
  const ok = checks.every((check) => check.ok);

  console.log(
    JSON.stringify(
      {
        ok,
        home: chessContextRoot,
        totalGraphFiles: all.length,
        picked: picked.length,
        pickedBytes,
        pickedMiB: mb(pickedBytes),
        biggest: { sessionId: biggest.id, bytes: biggest.size },
        nodes: shapes.reduce((sum, s) => sum + s.nodes, 0),
        edges: shapes.reduce((sum, s) => sum + s.edges, 0),
        heapBaseMB: mb(base.heapUsed),
        heapLoadedMB: mb(loaded.heapUsed),
        heapAfterReleaseMB: mb(after.heapUsed),
        heapGrewMB: mb(heapGrew),
        heapRetainedMB: mb(heapRetained),
        rssBaseMB: mb(base.rss),
        rssLoadedMB: mb(loaded.rss),
        rssAfterReleaseMB: mb(after.rss),
        rssGrewMB: mb(rssGrew),
        rssRetainedMB: mb(rssRetained),
        perGraphKB: picked.length > 0 ? Math.round(heapGrew / picked.length / 1024) : 0,
        released: release.released.length,
        skipped: release.skipped,
        soak,
        checks,
      },
      null,
      2,
    ),
  );
  return ok ? 0 : 1;
}

/* ─────────────────────────── 父进程：解析参数 ─────────────────────────── */

async function main(argv) {
  const get = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  if (argv.includes("--child")) {
    const root = argv[argv.indexOf("--child") + 1];
    const topN = Number(get("top", 12));
    const soak = Math.max(0, Number(get("soak", 0)));
    return childMain(root, Number.isFinite(topN) ? topN : 12, Number.isFinite(soak) ? soak : 0);
  }
  const home = get("home") ?? defaultHome();
  if (home === null || !nodeFs.existsSync(nodePath.join(home, "sessions"))) {
    console.error(`找不到 chess-context 落盘根（试过 $DSH_HOME/chess-context 与 ~/.dsh/chess-context）。用 --home 指定。`);
    return 2;
  }
  const top = argv.includes("--all") ? "0" : String(get("top", "12"));
  const soak = String(get("soak", "0"));
  const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--child", home, "--top", top, "--soak", soak], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  return child.status ?? 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
