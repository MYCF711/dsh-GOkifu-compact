/**
 * fold-economics.mjs —— 折叠到底划不划算：一次折叠要多少次请求才回本（C462）
 *
 * 由来（上一轮留下的待办）：Claude Code 的压缩点在"near the top"（1M 窗口），
 * 我们默认 `thresholdRatio = 0.45`，比它激进得多。**能不能照抄？** 不能 —— 两边缓存经济学不同。
 * 这个脚本用**我们自己的实测数据**把这个问题算清楚，免得下次又拍脑袋改默认值。
 *
 * 三个量决定答案：
 *   ① 有效输入单价：缓存命中 94% 时，1 token 的实际价钱 ≈ 0.94×hit + 0.06×miss（官方两档价，C452）；
 *   ② 一次折叠花多少钱：foldMark 里的真实 usage × 当时那个时刻的价（C453 按时刻计价）；
 *   ③ 一次折叠省下多少上下文：`shadowedTokens` —— 之后**每一次**请求都少付这么多。
 *
 * 回本判据：`需要多少次后续请求` = 折叠成本 ÷ （每次请求省下的钱）。
 * 这个数远小于会话剩余步数 ⇒ 折叠**永远划算**，阈值高低是二阶问题。
 *
 * 用法：
 *   node scripts/fold-economics.mjs                 # 全库
 *   node scripts/fold-economics.mjs --hit 0.94      # 手动指定缓存命中率
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";
import { estimateFoldCostUsd, priceForModel, PEAK_MULTIPLIER } from "../src/ui.mjs";
import { sessionFiles, loadEvents } from "./action-cost.mjs";

/**
 * 有效输入单价（美元 / 每 1M token）：缓存命中按 hit 价、未命中按 miss 价加权。
 * @param {{hitRate:number, hit:number, miss:number}} input
 * @returns {number}
 */
export function effectiveInputPrice({ hitRate, hit, miss }) {
  const r = Math.min(1, Math.max(0, Number(hitRate) || 0));
  const h = Number(hit);
  const m = Number(miss);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return r * h + (1 - r) * m;
}

/**
 * 一次折叠的**回本点**：省下的上下文在多少次请求后抵消折叠成本。
 * @param {{foldCostUsd:number, shadowedTokens:number, pricePerMTok:number}} input
 * @returns {{perRequestUsd:number, requestsNeeded:number|null}}
 */
export function foldPayback({ foldCostUsd, shadowedTokens, pricePerMTok }) {
  const cost = Number(foldCostUsd);
  const tokens = Number(shadowedTokens);
  const price = Number(pricePerMTok);
  if (!Number.isFinite(cost) || cost <= 0) return { perRequestUsd: 0, requestsNeeded: null };
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(price) || price <= 0) {
    return { perRequestUsd: 0, requestsNeeded: null };
  }
  const perRequestUsd = (tokens / 1_000_000) * price;
  return { perRequestUsd, requestsNeeded: perRequestUsd === 0 ? null : cost / perRequestUsd };
}

/** 从会话日志估缓存命中率（命中 / (命中 + 未命中)）。 */
export function hitRateFromFile(file) {
  const { events } = loadEvents(file);
  let hit = 0;
  let miss = 0;
  for (const ev of events) {
    if (ev?.type !== "assistant/message") continue;
    const u = ev.usage ?? ev.data?.usage;
    if (!u) continue;
    if (Number.isFinite(u.cacheReadTokens)) hit += u.cacheReadTokens;
    if (Number.isFinite(u.inputTokens)) miss += u.inputTokens;
  }
  return hit + miss === 0 ? null : { hit, miss, hitRate: hit / (hit + miss) };
}

function main(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = get("home", process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home");
  const override = get("hit", null);

  const cache =
    override !== null
      ? { hitRate: Number(override), hit: null, miss: null, source: "--hit 手动指定" }
      : (() => {
          const files = sessionFiles(home);
          if (files.length === 0) return { hitRate: 0.9, hit: null, miss: null, source: "没有会话日志，按 90% 估" };
          const got = hitRateFromFile(files[0].file);
          if (got === null) return { hitRate: 0.9, hit: null, miss: null, source: "日志里没有 usage，按 90% 估" };
          return { ...got, source: path.basename(path.dirname(files[0].file)).slice(0, 20) };
        })();

  const priceOff = priceForModel("deepseek-flash", { at: new Date("2026-11-03T00:00:00Z") });
  const pricePerMTok = effectiveInputPrice({ hitRate: cache.hitRate, hit: priceOff.hit, miss: priceOff.miss });

  // 扫 foldMarks：真实成本 + 遮蔽量
  const root = path.join(home, "chess-context", "sessions");
  const rows = [];
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(root, d.name, "graph.json");
      if (!fs.existsSync(file)) continue;
      let graph;
      try {
        ({ graph } = loadSessionGraph(file));
      } catch {
        continue;
      }
      for (const mark of graph.foldMarks ?? []) {
        const usage = mark?.usage;
        if (!usage) continue;
        const cost = estimateFoldCostUsd(usage, usage.model, { at: mark.at ?? null });
        if (!Number.isFinite(cost)) continue;
        rows.push({ session: d.name.slice(0, 16), at: mark.at ?? 0, cost, shadowedTokens: Number(mark.shadowedTokens) || 0, trigger: mark.trigger ?? "?" });
      }
    }
  }

  console.log("== 折叠经济学（C462）==");
  console.log(
    `  缓存命中率 ${(cache.hitRate * 100).toFixed(1)}%（来源：${cache.source}）` +
      (cache.hit !== null ? ` · 命中 ${(cache.hit / 1e6).toFixed(1)}M / 未命中 ${(cache.miss / 1e6).toFixed(1)}M` : ""),
  );
  console.log(`  有效输入单价 ≈ $${pricePerMTok.toFixed(4)} / 1M tok（低谷价；高峰 ×${PEAK_MULTIPLIER} 同理放大）`);
  if (rows.length === 0) {
    console.log("  没有带 usage 的 foldMark —— 无从计算");
    return 0;
  }
  const paybacks = rows
    .map((r) => ({ ...r, ...foldPayback({ foldCostUsd: r.cost, shadowedTokens: r.shadowedTokens, pricePerMTok }) }))
    .filter((r) => r.requestsNeeded !== null)
    .sort((a, b) => a.requestsNeeded - b.requestsNeeded);
  const costTotal = rows.reduce((s, r) => s + r.cost, 0);
  const shadowedTotal = rows.reduce((s, r) => s + r.shadowedTokens, 0);
  const med = paybacks.length === 0 ? null : paybacks[Math.floor(paybacks.length / 2)].requestsNeeded;
  console.log(`  fold ${rows.length} 次 · 合计 $${costTotal.toFixed(3)} · 合计遮蔽 ${(shadowedTotal / 1e6).toFixed(2)} M tok`);
  console.log(
    `  回本点（折叠后还需要多少次请求才抵消这次折叠的钱）：中位 **${med === null ? "—" : Math.ceil(med)}** 次` +
      `（最省 ${paybacks.length > 0 ? Math.ceil(paybacks[0].requestsNeeded) : "—"} / 最贵 ${paybacks.length > 0 ? Math.ceil(paybacks.at(-1).requestsNeeded) : "—"}）`,
  );
  // 判读用测出来的数说话，不要背台词
  const paybackLabel = med === null ? "算不出" : `约 ${Math.ceil(med)} 次请求`;
  if (med !== null && med <= 20) {
    console.log(`  判读：回本点中位 ${paybackLabel} —— 会话动辄成百上千步，**折叠本身很划算**；`);
    console.log("        阈值高低（45% vs 70%）此时是**二阶问题**，真正决定账单的是「步数 × 每步上下文」，即前缀缓存有没有被打断（A1）。");
  } else if (med !== null) {
    console.log(`  判读：回本点中位 ${paybackLabel} —— 折叠成本要较长会话才摊平；短会话里折叠可能**不划算**（但保真是另一笔账）。`);
  } else {
    console.log("  判读：数据不足（缺 usage 或缺 shadowedTokens），不下结论。");
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));