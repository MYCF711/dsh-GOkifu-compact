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
export function scanAllSessions(home, { minSize = 300_000, maxFiles = 400 } = {}) {
  const root = nodePath.join(home, "sessions");
  const usages = [];
  let files = 0;
  if (!nodeFs.existsSync(root)) return { usages, files };
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    for (const s of nodeFs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (!nodeFs.existsSync(file)) continue;
      if (nodeFs.statSync(file).size < minSize) continue;
      if (files >= maxFiles) return { usages, files };
      try {
        const { text } = decodeMultiFrameZstd(nodeFs.readFileSync(file));
        usages.push(...usagesFromSessionText(text));
        files += 1;
      } catch {
        /* 损坏/格式变化：跳过 */
      }
    }
  }
  return { usages, files };
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
  const { usages, files } = scanAllSessions(home, { minSize });
  const agg = aggregateCacheRate(usages);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...agg, files }, null, 2));
    return 0;
  }
  console.log("== 真机缓存命中率 ==");
  console.log(`  会话文件 ${files} 个 · 请求 ${agg.requests} 次`);
  console.log(`  未命中 ${agg.miss.toLocaleString()} · 命中 ${agg.hit.toLocaleString()} · 输出 ${agg.output.toLocaleString()}`);
  console.log(`  命中率 **${agg.hitRate === null ? "?" : (agg.hitRate * 100).toFixed(1) + "%"}**（分母 = 未命中 + 命中）`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
