/**
 * cache-rate.mjs —— 用**真机会话数据**算缓存命中率（C362）
 *
 * 为什么：`结论速查 A1` 一直写着「缓存命中约 97%」，但那是从成本倒推的。真机会话文件里
 * 每条 assistant 消息都带 usage（`inputTokens` = 未命中、`cacheReadTokens` = 命中、`outputTokens`），
 * 把它们加起来就能**直接量**出来 —— 这也是唯一能证伪 A1 的方式。
 *
 * 关键口径（C361 已核实）：`inputTokens` **只含未命中**，`totalTokens = miss + hit + out`，
 * 所以命中率的分母是 `miss + hit`，不是 `inputTokens`。
 *
 * 用法：
 *   node scripts/cache-rate.mjs                 # 扫 DSH_HOME 下所有会话
 *   node scripts/cache-rate.mjs --json
 *   node scripts/cache-rate.mjs --min-size 500000
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "./session-scan.mjs";

/**
 * ★ C362：把一批 usage 汇总成命中率。纯函数。
 * @param {Array<{inputTokens?:number, cacheReadTokens?:number, outputTokens?:number}>} usages
 * @returns {{requests:number, miss:number, hit:number, output:number, hitRate:number|null}}
 */
export function aggregateCacheRate(usages) {
  let miss = 0;
  let hit = 0;
  let output = 0;
  let requests = 0;
  for (const u of usages ?? []) {
    const m = Number(u?.inputTokens);
    if (!Number.isFinite(m) || m < 0) continue;
    const h = Number(u?.cacheReadTokens);
    const o = Number(u?.outputTokens);
    miss += m;
    hit += Number.isFinite(h) && h > 0 ? h : 0;
    output += Number.isFinite(o) && o > 0 ? o : 0;
    requests += 1;
  }
  const denom = miss + hit;
  return { requests, miss, hit, output, hitRate: denom === 0 ? null : hit / denom };
}

/**
 * ★ C362：从一份会话文本里抽出所有 usage。纯函数（便于单测）。
 * @param {string} text
 * @returns {Array<object>}
 */
export function usagesFromSessionText(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("cacheReadTokens")) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = msg?.data?.usage ?? msg?.data?.message?.usage ?? null;
    if (usage && Number.isFinite(Number(usage.inputTokens))) out.push(usage);
  }
  return out;
}

/** 扫 DSH_HOME 下所有会话文件。 */
export function scanAllSessions(home, { minSize = 300_000, maxFiles = 400, grouped = false } = {}) {
  const root = nodePath.join(home, "sessions");
  const usages = [];
  const groups = [];
  let files = 0;
  if (!nodeFs.existsSync(root)) return { usages, files, groups };
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    for (const s of nodeFs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (!nodeFs.existsSync(file)) continue;
      if (nodeFs.statSync(file).size < minSize) continue;
      if (files >= maxFiles) return { usages, files, groups };
      try {
        const { text } = decodeMultiFrameZstd(nodeFs.readFileSync(file));
        const found = usagesFromSessionText(text);
        if (grouped) groups.push({ session: s.name, usages: found });
        usages.push(...found);
        files += 1;
      } catch {
        /* 损坏/格式变化：跳过 */
      }
    }
  }
  return { usages, files, groups };
}

/**
 * ★ C363：把「按会话分组的 usage」算成「每个会话花了多少」（纯函数，供单测）。
 * 用 flash 低峰价：miss $0.15 / hit $0.003 / out $0.6 每 1M。
 * @param {Array<{session:string, usages:object[]}>} groups
 * @returns {Array<{session:string, requests:number, hitRate:number, cost:number}>} 按 cost 降序
 */
export function sessionCosts(groups) {
  return (groups ?? [])
    .map((gr) => {
      const a = aggregateCacheRate(gr.usages);
      const cost = (a.miss * 0.15 + a.hit * 0.003 + a.output * 0.6) / 1e6;
      return { session: gr.session, requests: a.requests, hitRate: a.hitRate ?? 0, cost };
    })
    .filter((r) => r.requests > 0)
    .sort((x, y) => y.cost - x.cost);
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "") {
    console.log("需要 DSH_HOME（或 --home）");
    return 2;
  }
  const minSize = Number(getArg("min-size", "300000")) || 300_000;
  const bySession = argv.includes("--by-session");
  const { usages, files, groups } = scanAllSessions(home, { minSize, grouped: bySession });
  const agg = aggregateCacheRate(usages);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...agg, files }, null, 2));
    return 0;
  }
  console.log("== 真机缓存命中率 ==");
  console.log(`  会话文件 ${files} 个 · 请求 ${agg.requests} 次`);
  console.log(`  未命中 ${agg.miss.toLocaleString()} · 命中 ${agg.hit.toLocaleString()} · 输出 ${agg.output.toLocaleString()}`);
  console.log(`  命中率 **${agg.hitRate === null ? "?" : (agg.hitRate * 100).toFixed(1) + "%"}**（分母 = 未命中 + 命中）`);
  if (bySession) {
    // ★ C363：按会话算钱，看"钱花在哪"（flash 低峰价：miss 0.15 / hit 0.003 / out 0.6）
    const rows = sessionCosts(groups);
    const total = rows.reduce((n, r) => n + r.cost, 0);
    console.log("\n  最贵的 8 个会话（flash 低峰价估算）：");
    for (const r of rows.slice(0, 8)) {
      console.log(`   · ${r.session.slice(0, 22)}  $${r.cost.toFixed(2)}  (${r.requests} 次 · 命中 ${(r.hitRate * 100).toFixed(0)}%)`);
    }
    const top5 = rows.slice(0, 5).reduce((n, r) => n + r.cost, 0);
    console.log(`  合计 $${total.toFixed(2)}；最贵的 5 个占 ${((top5 / total) * 100).toFixed(0)}%`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
