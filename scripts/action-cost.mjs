/**
 * action-cost.mjs —— **哪个动作最费钱**（K-13 / C451）
 *
 * 由来：Chip Huyen 那篇讲 agent 效率时列了四个指标（平均几步、平均多少钱、单动作耗时、**有没有特别费钱的动作**）。
 * 我们前三个有仪器，第四个没有 —— 而它恰恰最可执行：如果 `read` 一个 200 KB 文件要烧 5 万 input tokens，
 * 那"少读整文件、用 grep 定位"就是一条能立刻落地的规矩。
 *
 * 数据来源：宿主会话日志（多帧 zstd，见 docs/knowledge/宿主会话文件格式-zstd多帧.md）。
 * 每条 `assistant/message` 都带 `usage`：
 *   `{ inputTokens, outputTokens, totalTokens, cacheReadTokens }`
 * 其中 **`inputTokens` 是未命中缓存的输入**（C361/C411 核过口径：官方的 prompt_tokens = hit + miss，
 * 宿主的 inputTokens 记的是 miss）。
 *
 * 归因方式（这里有个坑，必须写清）：
 *   一步的开销 = **上一步产生的工具结果**（它被塞回上下文）+ 模型自己的推理。
 *   所以把「第 N 次请求的 inputTokens」记到「第 N-1 步的那个动作」头上。
 *
 * 用法：
 *   node scripts/action-cost.mjs                 # 最大那个会话
 *   node scripts/action-cost.mjs --session 8a73e0
 *   node scripts/action-cost.mjs --json --top 15
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "./session-scan.mjs";

/* ───────────────────────── 纯函数 ───────────────────────── */

const byNum = (a, b) => a - b;

/** 中位数（空数组 ⇒ null，别返回 0 —— 0 会被当成"真的很便宜"）。 */
export function median(list) {
  const xs = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x)).sort(byNum);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 分位数（p 是 0~1；空数组 ⇒ null）。 */
export function percentile(list, p) {
  const xs = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x)).sort(byNum);
  if (xs.length === 0) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)));
  return xs[i];
}

/** 从 assistant 消息里取第一个 tool-call 的「工具名 + 关键参数」——与热清单同一形态。 */
export function firstToolCall(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const call = blocks.find((b) => b !== null && b !== undefined && b.type === "tool-call");
  if (call === undefined) return null;
  const args = (() => {
    try {
      return typeof call.arguments === "string" ? JSON.parse(call.arguments) : (call.arguments ?? {});
    } catch {
      return {};
    }
  })();
  const key = ["file_path", "path", "command", "cmd", "pattern", "query", "url"].map((k) => args?.[k]).find((v) => typeof v === "string" && v !== "");
  return { id: call.id ?? null, tool: String(call.name ?? "?"), arg: key === undefined ? "" : String(key).slice(0, 120), calls: blocks.filter((b) => b?.type === "tool-call").length };
}

function resultText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * 把「每一步的 usage」归因到「上一步的动作」。
 *
 * 注意两条口径：
 *   · 一条 assistant 消息带**多个** tool-call 时，只归因到**第一个**（其余在同一步内，无法再拆分）；
 *   · `compaction/summary` 这类事件的 usage 不参与（它不是动作的结果）。
 *
 * @param {Array<object>} events 按 seq 升序
 * @returns {{steps: Array<{tool:string, arg:string, resultChars:number|null, inputTokens:number|null,
 *            cacheReadTokens:number|null, outputTokens:number|null, seq:number|null}>,
 *           unattributed: number}}
 */
export function attributeCosts(events) {
  const steps = [];
  let pending = null;      // 本步的 tool-call（等待"下一次请求"来结算）
  let pendingChars = null; // 本步工具结果的字符数
  let lastCtx = null;      // 上一个请求的上下文大小（= 这条动作发生时的基线）
  let unattributed = 0;
  let resets = 0;
  for (const ev of events) {
    if (ev === null || typeof ev !== "object") continue;
    if (ev.type === "assistant/message") {
      // ★ usage 在事件顶层或 data 下都见过 —— 两处都要看（否则"可归因步骤"会全是 0）
      const usage = ev.usage ?? ev.data?.usage ?? null;
      const ctx =
        usage === null
          ? null
          : (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0) +
            (Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0);
      if (pending !== null) {
        if (usage === null) {
          unattributed += 1;
        } else {
          // 增量 = **这一次请求的上下文** − **上一次请求的上下文**
          // 只有这样才能把"这条动作让上下文涨了多少"与"会话已经多长"分开。
          let delta = null;
          if (lastCtx !== null && ctx !== null) {
            const d = ctx - lastCtx;
            if (d < 0) resets += 1;
            else delta = d;
          }
          steps.push({
            tool: pending.tool,
            arg: pending.arg,
            resultChars: pendingChars,
            inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
            cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
            outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
            contextTokens: ctx,
            inputDelta: delta,
            seq: Number.isFinite(ev.seq) ? ev.seq : null,
          });
        }
      }
      const call = firstToolCall(ev.data?.message ?? ev.message);
      pending = call === null ? null : { tool: call.tool, arg: call.arg };
      pendingChars = null;
      if (ctx !== null) lastCtx = ctx;
      continue;
    }
    if (ev.type === "tool/result") {
      if (pending === null) continue;
      const text = resultText(ev.data?.message ?? ev.message);
      pendingChars = (pendingChars ?? 0) + text.length;
    }
  }
  return { steps, unattributed, resets };
}

/** 按工具聚合：次数、结果字符中位/p90、下一步 input tokens 中位。 */
export function byTool(steps) {
  const groups = new Map();
  for (const s of steps) {
    const g = groups.get(s.tool) ?? { tool: s.tool, count: 0, chars: [], inputs: [], outputs: [], deltas: [] };
    g.count += 1;
    if (Number.isFinite(s.resultChars)) g.chars.push(s.resultChars);
    if (Number.isFinite(s.contextTokens)) g.inputs.push(s.contextTokens);
    if (Number.isFinite(s.outputTokens)) g.outputs.push(s.outputTokens);
    if (Number.isFinite(s.inputDelta)) g.deltas.push(s.inputDelta);
    groups.set(s.tool, g);
  }
  return [...groups.values()]
    .map((g) => ({
      tool: g.tool,
      count: g.count,
      charsMedian: median(g.chars),
      charsP90: percentile(g.chars, 0.9),
      inputMedian: median(g.inputs),
      inputP90: percentile(g.inputs, 0.9),
      outputMedian: median(g.outputs),
      deltaMedian: median(g.deltas),
      deltaP90: percentile(g.deltas, 0.9),
      // 累计增量：真正决定"这个工具一共让我花了多少上下文"的是 **步数 × 中位增量**
      deltaTotal: g.deltas.reduce((a, b) => a + b, 0),
    }))
    // 按**增量中位**排：这才是"这个动作平均让上下文涨多少"
    .sort((a, b) => (b.deltaMedian ?? 0) - (a.deltaMedian ?? 0));
}

/** 单条最贵的动作（按工具结果字符数；下一步 input tokens 一并带出）。 */
export function topActions(steps, { top = 10, key = "resultChars" } = {}) {
  const field = key === "delta" ? "inputDelta" : "resultChars";
  return [...steps]
    .filter((s) => Number.isFinite(s[field]))
    .sort((a, b) => b[field] - a[field])
    .slice(0, Math.max(1, top));
}

/* ───────────────────────── 读日志 ───────────────────────── */

export function sessionFiles(home) {
  const root = path.join(home, "sessions");
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".zstd")) out.push({ file: p, size: fs.statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => b.size - a.size);
}

export function loadEvents(file) {
  const { text, frames, okFrames } = decodeMultiFrameZstd(fs.readFileSync(file));
  const events = [];
  let bad = 0;
  for (const line of String(text).split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  return { events, frames, okFrames, bad };
}

/* ───────────────────────── CLI ───────────────────────── */

function main(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = get("home", process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home");
  const top = Number(get("top", 10));
  const asJson = argv.includes("--json");
  const prefix = get("session", null);

  const files = sessionFiles(home);
  const target = prefix === null ? files[0] : files.find((f) => f.file.includes(prefix));
  if (target === undefined) {
    console.log(`找不到会话日志（${prefix ?? "最大的那个"}）· home=${home}`);
    return 2;
  }
  const { events, frames, okFrames, bad } = loadEvents(target.file);
  const { steps, unattributed, resets } = attributeCosts(events);
  const tools = byTool(steps);
  const topList = topActions(steps, { top, key: "delta" });

  if (asJson) {
    console.log(JSON.stringify({ file: target.file, frames, okFrames, bad, steps: steps.length, unattributed, tools, top: topList }, null, 2));
    return 0;
  }

  console.log(`== 动作开销 · ${path.basename(path.dirname(target.file))} ==`);
  console.log(`  帧 ${okFrames}/${frames} 可解 · 事件 ${events.length} · 可归因步骤 ${steps.length}${bad > 0 ? ` · 坏行 ${bad}` : ""}${unattributed > 0 ? ` · 无法归因 ${unattributed}` : ""}`);
  const fmt = (x) => (x === null || x === undefined ? "—" : Math.round(x).toLocaleString("en-US"));
  console.log("  按工具（**累计**上下文增量，降序 = 一共最贵在前）：");
  for (const t of [...tools].sort((a, b) => (b.deltaTotal ?? 0) - (a.deltaTotal ?? 0)).slice(0, 6)) {
    console.log(`    ${t.tool.padEnd(18)} 共 +${fmt(t.deltaTotal)} tok（${t.count} 次 × 中位 ${fmt(t.deltaMedian)}）`);
  }
  console.log("  按工具（**单次**上下文增量中位，降序 = 单步最贵在前）：");
  for (const t of tools.slice(0, 15)) {
    console.log(
      `    ${t.tool.padEnd(18)} ${String(t.count).padStart(4)} 次 · 涨上下文 中位 ${fmt(t.deltaMedian)} / p90 ${fmt(t.deltaP90)} · 结果字符 中位 ${fmt(t.charsMedian)} / p90 ${fmt(t.charsP90)}`,
    );
  }
  console.log(`  单条最贵的 ${topList.length} 个动作（按**这一步让上下文涨了多少**）：`);
  for (const x of topList) {
    console.log(`    +${String(x.inputDelta).padStart(8)} tok  ${x.tool}(${x.arg.slice(0, 56)}) · 结果 ${x.resultChars ?? "—"} 字符`);
  }
  if (resets > 0) console.log(`  （${resets} 步的增量是负的 —— 中间发生过折叠/重置，已从增量统计里剔除）`);
  console.log("  ⚠ 口径：开销归因到**上一步的动作**（它的工具结果被塞回上下文）；一条消息多个 tool-call 只算第一个。");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));