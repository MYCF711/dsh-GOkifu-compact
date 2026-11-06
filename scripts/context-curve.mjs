/**
 * context-curve.mjs —— 一个会话里"上下文大小"随时间怎么变（C364）
 *
 * 为什么：折叠有没有**真的**在削上下文，只有看曲线才知道。
 * 每次请求的输入 = `inputTokens`(未命中) + `cacheReadTokens`(命中)（口径见 C361）。
 *   · 锯齿（升上去、被砍下来、再升）= 折叠在工作；
 *   · 单调上升 = 折叠没跟上（或根本没触发）。
 *
 * 用法：
 *   node scripts/context-curve.mjs --session <id 前缀>
 *   node scripts/context-curve.mjs --session <id 前缀> --json
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd, findSessionFile } from "./session-scan.mjs";
import { usagesFromSessionText } from "./cache-rate.mjs";

/**
 * ★ C364：从一串 usage 里算出"输入大小曲线"的统计与「掉头」次数。纯函数。
 * @param {Array<{inputTokens?:number, cacheReadTokens?:number}>} usages
 * @returns {{n:number, min:number, median:number, max:number, drops:number, dropThreshold:number,
 *            first:number, last:number}}
 */
export function curveStats(usages) {
  const sizes = (usages ?? [])
    .map((u) => Number(u?.inputTokens) + (Number(u?.cacheReadTokens) || 0))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (sizes.length === 0) {
    return { n: 0, min: 0, median: 0, max: 0, drops: 0, dropThreshold: 0, first: 0, last: 0 };
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // "掉头"定义：比上一次小 **30% 以上**（小抖动不算折叠）
  const dropThreshold = 0.3;
  let drops = 0;
  for (let i = 1; i < sizes.length; i += 1) {
    if (sizes[i] < sizes[i - 1] * (1 - dropThreshold)) drops += 1;
  }
  return {
    n: sizes.length,
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    drops,
    dropThreshold,
    first: sizes[0],
    last: sizes[sizes.length - 1],
  };
}

/**
 * ★ C375：把 foldMark 的 `at` 与请求时间轴对齐，算出「折后首个请求的真实大小」。纯函数。
 * 用来回答 K-22：`totalAfter`（宿主 meter）到底比真实请求大多少。
 * @param {Array<{at:number, totalAfter?:number}>} folds
 * @param {Array<{t:number, size:number}>} requests
 * @returns {Array<{at:number, totalAfter:number|null, prompt:number|null, gap:number|null}>}
 */
export function pairFoldsWithRequests(folds, requests) {
  const reqs = (requests ?? []).filter((r) => Number.isFinite(r?.t) && Number.isFinite(r?.size)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const f of folds ?? []) {
    if (!Number.isFinite(f?.at)) continue;
    const after = reqs.find((r) => r.t >= f.at) ?? null;
    const totalAfter = Number.isFinite(f?.totalAfter) ? f.totalAfter : null;
    out.push({
      at: f.at,
      totalAfter,
      prompt: after === null ? null : after.size,
      gap: after === null || totalAfter === null ? null : after.size - totalAfter,
    });
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  const prefix = getArg("session", null);
  if (home === "" || prefix === null) {
    console.log("需要 --session <id 前缀> 与 DSH_HOME（或 --home）");
    return 2;
  }
  const file = findSessionFile(home, prefix);
  if (file === null) {
    console.log(`找不到会话：${prefix}`);
    return 2;
  }
  const { text, frames } = decodeMultiFrameZstd(nodeFs.readFileSync(file));
  const stats = curveStats(usagesFromSessionText(text));
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ session: prefix, frames, ...stats }, null, 2));
    return 0;
  }
  console.log(`== 上下文曲线 · ${prefix} ==`);
  console.log(`  请求 ${stats.n} 次 · 输入 min ${stats.min.toLocaleString()} / 中位 ${stats.median.toLocaleString()} / max ${stats.max.toLocaleString()}`);
  console.log(
    `  明显回落（比上次小 >${Math.round(stats.dropThreshold * 100)}%）**${stats.drops}** 次` +
      (stats.drops === 0 ? "  ⇒ ⚠ 没看到折叠效果（或该会话没折叠）" : "  ⇒ 锯齿成立：折叠在工作"),
  );
  console.log(`  首 ${stats.first.toLocaleString()} → 末 ${stats.last.toLocaleString()}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
