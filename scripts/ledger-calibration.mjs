/**
 * ledger-calibration.mjs —— 热清单 token 数的**真实会话校准**（2026-11-02，C72）
 *
 * 为什么需要：README/bench 报的 415 tokens 是 **2000 边合成夹具** 的数字，README 里也一直写着
 * 「真实会话口径未校准」。这句话留了很久 —— 合成夹具只能证明**上界形状**，回答不了
 * 「真实会话的热清单到底多大」。这个脚本用**当前 live 图**在预算 500 下按生产选项渲染，
 * 给出分布（min / p50 / p90 / max / 超预算个数）。
 *
 * 只读；默认只打印，`--write` 才落 `evidence/ledger-calibration.{json,md}`（C65 的安全默认约定）。
 *
 * 用法：
 *   node scripts/ledger-calibration.mjs [--home DIR] [--budget 500] [--write] [--json]
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

const { fromJSON } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "kifu-model.mjs")).href);
const { renderLedger } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "ledger.mjs")).href);

/** 百分位（最近秩法，0–100）。空数组返回 null。 */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const clamped = Math.min(100, Math.max(0, Number(p)));
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((clamped / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

/**
 * 纯汇总：把 [{session, tokens, fallback, level}] 变成分布。
 * @returns {{n:number, min:number|null, p50:number|null, p90:number|null, max:number|null, over:number, levels:Record<string,number>}}
 */
export function calibrate(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => Number.isFinite(e?.tokens)) : [];
  const tokens = list.map((e) => e.tokens).sort((a, b) => a - b);
  const levels = {};
  for (const e of list) {
    const key = Number.isFinite(e.level) ? `L${e.level}` : "?";
    levels[key] = (levels[key] ?? 0) + 1;
  }
  return {
    n: list.length,
    min: tokens[0] ?? null,
    p50: percentile(tokens, 50),
    p90: percentile(tokens, 90),
    max: tokens.at(-1) ?? null,
    over: list.filter((e) => e.fallback !== "none").length,
    levels,
  };
}

/** 扫 home 下所有图，按生产形状渲染并收集。 */
export function collectCalibration(home, { budget = 500 } = {}) {
  const sessionsRoot = nodePath.join(String(home ?? ""), "chess-context", "sessions");
  const entries = [];
  let unreadable = 0;
  if (!nodeFs.existsSync(sessionsRoot)) return { entries, unreadable, budget };
  for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph;
    try {
      graph = fromJSON(nodeFs.readFileSync(file, "utf8"));
    } catch {
      unreadable += 1;
      continue;
    }
    // 生产形状：带 treeDir（TRACE 行）与 traceRoot —— 与 hot-inject/doctor 同口径
    const led = renderLedger(graph, { maxTokens: budget, treeDir: `sessions/${entry.name}`, traceRoot: "sessions" });
    entries.push({ session: entry.name, tokens: led.tokens, fallback: led.fallback, level: led.level });
  }
  return { entries, unreadable, budget };
}

export function renderMarkdown({ generatedAt, summary, entries, budget }) {
  const lines = [
    "# 热清单 token 真实会话校准（C72）",
    "",
    `> 生成时间 ${generatedAt} · 预算 ${budget} · 会话 ${summary.n} 个`,
    "> 口径：**当前 live 图**按生产选项渲染（含 TRACE 行）；不是 bench 的 2000 边合成夹具。",
    "",
    "## 分布",
    "",
    `- **p50 = ${summary.p50 ?? "—"}** · p90 = ${summary.p90 ?? "—"} · min ${summary.min ?? "—"} · max ${summary.max ?? "—"}（tokens）`,
    `- 超预算会话：**${summary.over} / ${summary.n}**`,
    `- 档位分布：${Object.entries(summary.levels).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}`,
    "",
    "## 逐会话",
    "",
    "| 会话 | tokens | 档位 | fallback |",
    "|---|---:|---|---|",
    ...entries.map((e) => `| ${e.session.slice(0, 24)}… | ${e.tokens} | L${e.level} | ${e.fallback} |`),
    "",
  ];
  return lines.join(String.fromCharCode(10));
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : nodePath.join(nodeOs.homedir(), ".dsh"));
  const budget = Number(getArg("budget", 500)) || 500;
  const write = argv.includes("--write");
  const asJson = argv.includes("--json");
  const { entries, unreadable } = collectCalibration(home, { budget });
  const summary = calibrate(entries);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (asJson) {
    console.log(JSON.stringify({ generatedAt, budget, summary, entries }, null, 2));
    return 0;
  }
  console.log(`热清单校准（预算 ${budget}，会话 ${summary.n} 个${unreadable > 0 ? `，${unreadable} 个图读不出` : ""}）`);
  console.log(`  p50=${summary.p50} · p90=${summary.p90} · min=${summary.min} · max=${summary.max}（tokens）`);
  console.log(`  超预算 ${summary.over}/${summary.n} · 档位 ${Object.entries(summary.levels).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (write) {
    const base = nodePath.join(REPO, "evidence", "ledger-calibration");
    nodeFs.mkdirSync(nodePath.dirname(base), { recursive: true });
    nodeFs.writeFileSync(`${base}.json`, JSON.stringify({ generatedAt, budget, summary, entries }, null, 2) + String.fromCharCode(10), "utf8");
    nodeFs.writeFileSync(`${base}.md`, renderMarkdown({ generatedAt, summary, entries, budget }) + String.fromCharCode(10), "utf8");
    console.log(`已写 ${base}.json 与 ${base}.md`);
  } else {
    console.log("（默认不写盘；要落盘请加 --write）");
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
