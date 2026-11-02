/**
 * accept-after-restart.mjs —— 重启后**一条命令**判断「新代码接管了没有、补账通道通不通」
 *
 * 为什么需要：本仓库所有面板/归档/补账的改动都要重启才生效，而"有没有生效"以前要靠人
 * 东拼西凑（buildId？启动戳？面板某个按钮？）。C293/C294 已经证明**时间戳会骗人**，
 * 所以这里只认三件硬证据：
 *   ① 面板**能力探针**：它认不认识 `backfill` / `update`（C294）
 *   ② 面板 `backfill` 的**干跑**能不能给出欠账清单（通道通不通）
 *   ③ 最新会话的图上有没有 **`closeout`** 与 **`foldMark.finishReason`**（C216 / C321 真的跑了吗）
 *
 * 用法：
 *   node scripts/accept-after-restart.mjs            # 打当前宿主
 *   node scripts/accept-after-restart.mjs --port 64349 --json
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { checkPanelCapabilities } from "./post-restart-check.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/**
 * ★ C330：把三条证据判成一句话（纯函数，可单测）。
 * @param {{caps: {level: string, known: string[], unknown: string[]},
 *          backfill: {reachable: boolean, due: number|null, error: string|null},
 *          closeout: {seen: boolean, sessions: number},
 *          truncation: {collected: number, truncated: number},
 *          buildOk: boolean}} evidence
 * @returns {{verdict: "ready"|"stale"|"partial", line: string, todo: string[]}}
 */
export function verdictOf({ caps, backfill, closeout, truncation, buildOk }) {
  const unknown = caps?.unknown ?? [];
  const todo = [];
  if (unknown.length > 0) {
    todo.push(`面板还不认识这些 action：${unknown.join(" / ")} ⇒ 插件的新代码没接管，**先重启 DSH**`);
  }
  if (buildOk === false) todo.push("运行实例的 buildId 与磁盘不一致 ⇒ 跑的不是仓库里这份代码");
  if (backfill?.reachable === false) {
    todo.push(`面板 backfill 通道不通：${backfill.error ?? "未知原因"}`);
  }
  if (closeout !== undefined && closeout.seen === false) {
    todo.push("还没有任何会话留下 `closeout` ⇒ 归档收尾没跑过（**归档一个会话**再看；解析侧已由 C328 测住）");
  }
  if (truncation !== undefined && truncation.collected === 0) {
    todo.push("还没有 foldMark 带 `finishReason` ⇒ 截断仪器未采集（要等重启后第一次折叠）");
  }

  const stale = unknown.length > 0 || buildOk === false;
  if (stale) {
    return { verdict: "stale", line: "❌ 还没接管：跑的是旧代码，重启后再来一次", todo };
  }
  if (todo.length > 0) {
    return { verdict: "partial", line: "⚠ 代码接管了，但还有事没发生（看下面的清单）", todo };
  }
  const due = backfill?.due;
  return {
    verdict: "ready",
    line:
      "✅ 接管完成：面板认识新 action、补账通道通" +
      (Number.isFinite(due) ? `、当前欠账 ${due} 个` : "") +
      "、归档收尾与截断仪器都有数据",
    todo,
  };
}

/** 读所有会话图的 closeout / finishReason 概览（离线，可单测）。 */
export function scanEvidence(sessionsRoot) {
  const out = { closeout: { seen: false, sessions: 0 }, truncation: { collected: 0, truncated: 0 } };
  if (!nodeFs.existsSync(sessionsRoot)) return out;
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let g = null;
    try {
      g = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (g?.closeout !== undefined) out.closeout.seen = true;
    for (const mark of Array.isArray(g?.foldMarks) ? g.foldMarks : []) {
      if (typeof mark?.finishReason === "string") {
        out.truncation.collected += 1;
        if (/max[-_]?tokens|length/i.test(mark.finishReason)) out.truncation.truncated += 1;
      }
    }
  }
  out.closeout.sessions = out.closeout.seen ? 1 : 0;
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = Number(getArg("port", "64349")) || 64349;
  const home = getArg("home", process.env.DSH_HOME ?? "");
  const caps = await checkPanelCapabilities(undefined, { port });

  let backfill = { reachable: false, due: null, error: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`http://127.0.0.1:${port}/gokifu/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "backfill", dryRun: true }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (json !== null && typeof json.error === "string") backfill = { reachable: false, due: null, error: json.error };
    else backfill = { reachable: true, due: Number(json?.due ?? NaN), error: null };
  } catch (error) {
    backfill = { reachable: false, due: null, error: String(error) };
  }

  const sessionsRoot = home === "" ? "" : nodePath.join(home, "chess-context", "sessions");
  const evidence = sessionsRoot === "" ? { closeout: { seen: false, sessions: 0 }, truncation: { collected: 0, truncated: 0 } } : scanEvidence(sessionsRoot);

  const result = verdictOf({ caps, backfill, ...evidence, buildOk: true });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ caps, backfill, ...evidence, ...result }, null, 2));
    return result.verdict === "stale" ? 1 : 0;
  }
  console.log("== 重启后验收（accept-after-restart）==");
  console.log(`  ${result.line}`);
  for (const item of result.todo) console.log(`   · ${item}`);
  return result.verdict === "stale" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
