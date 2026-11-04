#!/usr/bin/env node
/**
 * backfill-state.mjs —— 一条命令看「后台自动补账现在到底在干什么」
 *
 * 为什么需要（C593/C594 真机教训，2026-11-04）：补账连续零产出，而
 *   · 日志在宿主控制台里（看不到）
 *   · 图上一个字段都不写（`chunks.length === 0` 时直接 return）
 * ⇒ "零产出" 与 "从没跑过" 在磁盘上长得一模一样。引擎现在每轮写
 *   `<chess-context>/auto-backfill-state.json`：arped 布防标记、挑中谁、每个会话的结局、异常。
 *
 * 用法：
 *   node scripts/backfill-state.mjs          # 最近一轮的状态
 *   node scripts/backfill-state.mjs --json   # 原样输出
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { graphRoot } from "../src/rooms/kifu-persist.mjs";

const home = process.env.DSH_HOME ?? nodePath.join(nodePath.dirname(nodePath.dirname(process.env.USERPROFILE ?? "")), "DeepSeek Harness", "home");
const root = graphRoot({ dshHome: home });
const file = nodePath.join(root, "auto-backfill-state.json");

if (!nodeFs.existsSync(file)) {
  console.log(`== 还没有状态文件 ==\n   ${file}\n   可能：① 这一版还没重启（引擎不会写）；② 自动补账被关掉了。`);
  process.exit(0);
}
const raw = nodeFs.readFileSync(file, "utf8");
if (process.argv.includes("--json")) {
  console.log(raw.trim());
  process.exit(0);
}
let s = null;
try {
  s = JSON.parse(raw);
} catch {
  console.log(`✗ 状态文件不是合法 JSON：${file}`);
  process.exit(1);
}
const ago = (t) => {
  const ms = Date.now() - Number(t ?? 0);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return ms < 60_000 ? `${Math.round(ms / 1000)} 秒前` : `${Math.round(ms / 60_000)} 分钟前`;
};
console.log("== 后台自动补账状态 ==");
if (s.armed === true && s.picked === undefined) {
  console.log(`  · 已布防（${ago(s.at)}）· 每 ${Math.round(Number(s.everyMs) / 60000)} 分钟一轮，首轮 +${Math.round(Number(s.firstDelayMs) / 1000)}s · pid ${s.pid}`);
  console.log("  · 还没有跑过第一轮 —— 若超过首轮时间仍然是这条，说明定时器没跑起来");
  process.exit(0);
}
if (typeof s.error === "string") {
  console.log(`  · ❌ 最近一轮**抛错**（${ago(s.at)}）：${s.error}`);
  process.exit(0);
}
console.log(`  · 最近一轮：${ago(s.at)} · 欠账 ${s.due ?? "?"} 个 · 每轮最多 ${s.max ?? "?"} 个 · 用时 ${Math.round(Number(s.doneMs ?? 0) / 1000)}s`);
console.log(`  · 挑中：${(s.picked ?? []).length === 0 ? "（空）" : (s.picked ?? []).map((x) => String(x).slice(0, 12)).join(" · ")}`);
for (const r of Array.isArray(s.results) ? s.results : []) {
  const head = `  - ${String(r.id ?? "").slice(0, 12)}`;
  const tail = `折了 ${r.folded ?? 0} 段` + (r.stopped ? ` · 停止原因 ${r.stopped}` : "") + (r.partial ? " · 仍有缺口" : "") + (r.error ? ` · 错误 ${String(r.error).slice(0, 80)}` : "");
  console.log(`${head} → ${tail}`);
}
if ((s.results ?? []).length === 0 && (s.picked ?? []).length > 0) {
  console.log("  ⚠ 挑中了但没有任何结局记录 ⇒ 说明在记录之前就抛错了（看上一行的 error）");
}
