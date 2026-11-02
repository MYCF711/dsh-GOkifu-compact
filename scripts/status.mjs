/**
 * status.mjs —— **一条命令看完现状**（C422）
 *
 * 由来：这些天我们攒了一堆检查工具（gate / doctor / accept-after-restart / backfill-plan /
 * live-bench / 各种 audit），但它们各自独立 —— 想知道"现在到底什么状态"要跑五六条命令，
 * 还得自己把结果拼起来。用户不该为此付费。
 *
 * 这里只做**编排与呈现**：每个数据源都复用现成脚本，不重新计算任何东西。
 *
 * 用法：
 *   node scripts/status.mjs            # 人看
 *   node scripts/status.mjs --json     # 机读
 *   node scripts/status.mjs --no-panel # 跳过面板探测（离线/无宿主时）
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/**
 * ★ C422：把各源的结果拼成一张表。纯函数（便于单测）。
 * @param {{gate?:string|null, tests?:{passed:number,failed:number}|null, doctor?:{bad:number,warn:number}|null,
 *          panel?:{ok:boolean, detail:string}|null, debt?:{due:number|null, costUsd:number|null, clicks:number|null}|null,
 *          bench?:{hitRate:number|null, totalCost:number|null}|null}} data
 * @returns {Array<[string, string]>}
 */
export function renderStatus(data) {
  const rows = [];
  const d = data ?? {};
  rows.push(["门禁", d.gate ?? "未采集"]);
  rows.push(["全量测试", d.tests === null || d.tests === undefined ? "未采集" : d.tests.passed < 0 ? "✓ 在门禁内全绿（未重跑）" : `${d.tests.passed} passed / ${d.tests.failed} failed`]);
  rows.push(["doctor", d.doctor === null || d.doctor === undefined ? "未采集" : `错误 ${d.doctor.bad} / 警告 ${d.doctor.warn}`]);
  rows.push(["面板", d.panel === null || d.panel === undefined ? "未采集" : d.panel.detail]);
  rows.push([
    "补账",
    d.debt === null || d.debt === undefined
      ? "未采集"
      : `${d.debt.due ?? "?"} 个欠账 · $${d.debt.costUsd === null ? "?" : d.debt.costUsd.toFixed(2)} · 约 ${d.debt.clicks ?? "?"} 次点击`,
  ]);
  rows.push([
    "真机基准",
    d.bench === null || d.bench === undefined
      ? "未采集"
      : `命中 ${d.bench.hitRate === null ? "?" : (d.bench.hitRate * 100).toFixed(1) + "%"} · 全量 $${d.bench.totalCost === null ? "?" : d.bench.totalCost.toFixed(2)}`,
  ]);
  return rows;
}

/** 跑一个脚本，返回 stdout（失败返回 null，不抛）。 */
function run(rel, args = [], timeout = 180_000) {
  const r = spawnSync(process.execPath, [nodePath.join(HERE, rel), ...args], { encoding: "utf8", timeout, cwd: ROOT });
  return r.status === 0 ? String(r.stdout ?? "") : null;
}

export async function main(argv = process.argv.slice(2)) {
  const data = {};

  // ① 门禁：只看最后一行（它自己会跑全量测试，这里不重复）
  const gateOut = run("gate.mjs", ["--no-pack"], 600_000);
  data.gate = gateOut === null ? "未采集（gate 失败）" : (gateOut.trim().split("\n").filter((l) => l.includes("门禁")).pop() ?? "见 gate 输出");
  // ★ C422：门禁里已经跑过全量测试 —— 它绿了就当作"测试也过了"的证据，不再重跑一遍。
  if (gateOut !== null && gateOut.includes("全量测试全绿")) data.tests = { passed: -1, failed: 0 };

  // ② doctor
  const docOut = run("doctor.mjs", ["--json"], 180_000);
  if (docOut !== null) {
    try {
      const j = JSON.parse(docOut);
      data.doctor = { bad: Number(j.bad ?? 0), warn: Number(j.warn ?? 0) };
    } catch {
      data.doctor = null;
    }
  }

  // ③ 面板（可跳过）
  if (!argv.includes("--no-panel")) {
    try {
      const mod = await import("./post-restart-check.mjs");
      const caps = await mod.checkPanelCapabilities(undefined, {});
      data.panel = { ok: caps.level === "ok", detail: caps.detail };
    } catch {
      data.panel = { ok: false, detail: "探测失败" };
    }
  }

  // ④ 补账规模
  const planOut = run("backfill-plan.mjs", ["--json"], 180_000);
  if (planOut !== null) {
    try {
      const p = JSON.parse(planOut);
      data.debt = { due: p.total ?? null, costUsd: Number.isFinite(p.costUsd) ? p.costUsd : null, clicks: p.clicks ?? null };
    } catch {
      data.debt = null;
    }
  }

  // ⑤ 真机基准：读生成物，不重算（重算要几十秒）
  try {
    const { default: nodeFs } = await import("node:fs");
    const doc = nodeFs.readFileSync(nodePath.join(ROOT, "docs", "真机基准-自动生成.md"), "utf8");
    const hit = doc.match(/\*\*命中率\*\* \| \*\*([\d.]+)%\*\*/);
    const cost = doc.match(/全量估算 \| \*\*\$([\d.]+)\*\*/);
    data.bench = {
      hitRate: hit === null ? null : Number(hit[1]) / 100,
      totalCost: cost === null ? null : Number(cost[1]),
    };
  } catch {
    data.bench = null;
  }

  const rows = renderStatus(data);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...data, rows }, null, 2));
    return 0;
  }
  console.log("== 现状（一条命令）==");
  for (const [k, v] of rows) console.log(`  · ${k}：${v}`);
  console.log("\n（重算基准：node scripts/live-bench.mjs --write；看补账细节：node scripts/backfill-plan.mjs）");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
