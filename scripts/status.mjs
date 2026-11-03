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
  // ★ C454：**动作开销**也进日常视图。C451 做了 `action-cost`，但"要专门跑的脚本"= 没人跑（C447 同一个坑）。
  //   这里只报两个数：累计最贵的工具 + 单次最贵 —— 都不需要跑全量报告就能看出趋势。
  rows.push([
    "动作开销",
    d.actionCost === null || d.actionCost === undefined
      ? "未采集"
      : `${d.actionCost.topByTotal} 累计 ${Math.round((d.actionCost.topTotal ?? 0) / 1000).toLocaleString("en-US")}k tok` +
        `（${d.actionCost.topCount} 次 × 中位 ${d.actionCost.topMedian}）· 单次最贵 ${d.actionCost.topMedianMax ?? "—"} tok`,
  ]);
  // ★ C447：**循环形状**要出现在日常视图里。C446 做了 loop-report，但"要专门去跑的脚本"
  //   等于没有 —— 这条项目的坑一直是"仪器能跑，但没人跑，于是假绿"。
  rows.push([
    "循环形状",
    d.loop === null || d.loop === undefined
      ? "未采集"
      : `${d.loop.loopSessions}/${d.loop.sessions} 会话（${(d.loop.loopRate * 100).toFixed(1)}%）· 最长 ${d.loop.longest} 连击 · 折叠后变短 ${d.loop.pressureBroke}/${d.loop.pressureAfterLoop}` +
        (d.loop.sigEdges === 0 ? " · ⚠ 老棋谱无指纹（口径偏宽）" : ""),
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
  // ★ C431：`--fast` 跳过门禁（要跑全量测试，约 40s）——"快看一眼"与"交付前验一遍"不该共用同一个耗时下限。
  const fast = argv.includes("--fast");
  const gateOut = fast ? null : run("gate.mjs", ["--no-pack"], 600_000);
  data.gate = fast
    ? "未跑（--fast）"
    : gateOut === null
      ? "未采集（gate 失败）"
      : (gateOut.trim().split(String.fromCharCode(10)).filter((l) => l.includes("门禁")).pop() ?? "见 gate 输出");
  // ★ C422：门禁里已经跑过全量测试 —— 它绿了就当作"测试也过了"的证据，不再重跑一遍。
  if (!fast && gateOut !== null && gateOut.includes("全量测试全绿")) data.tests = { passed: -1, failed: 0 };

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
      // ★ C439：**端口不能写死 64349**。这已经是第三个地方犯同一个错（C388/C412）：
      //   GUI 重启后换到 56319，而这里还在探 64349 ⇒ 误报「面板不可达」。
      //   这里复用 accept-after-restart 导出的两个纯函数：心跳端口 → 扫描发现 → 才回退 64349。
      const mod = await import("./post-restart-check.mjs");
      const helper = await import("./accept-after-restart.mjs");
      const nodePath2 = (await import("node:path")).default;
      const nodeFs2 = (await import("node:fs")).default;
      const { execFileSync } = await import("node:child_process");
      const home = process.env.DSH_HOME ?? "";
      const heartbeatPort = (() => {
        try {
          const file = nodePath2.join(home, "chess-context", "ui-route.json");
          if (!nodeFs2.existsSync(file)) return null;
          const hb = JSON.parse(nodeFs2.readFileSync(file, "utf8"));
          // ★ C439：`Number(null)` 是 **0**，而 `Number.isFinite(0)` 是 **true** ⇒ `port:null` 会被当成端口 0。
        return hb?.port === null || hb?.port === undefined ? null : Number.isFinite(Number(hb.port)) ? Number(hb.port) : null;
        } catch {
          return null;
        }
      })();
      const discover = async () => {
        try {
          const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15_000 });
          for (const candidate of helper.listeningPorts(out)) {
            try {
              const res = await fetch(`http://127.0.0.1:${candidate}/gokifu/api`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "health" }),
                signal: AbortSignal.timeout(4000),
              });
              if (helper.looksLikePanel(await res.json())) return candidate;
            } catch {
              /* 不是面板 */
            }
          }
          return null;
        } catch {
          return null;
        }
      };
      const panelPort = heartbeatPort ?? (await discover()) ?? 64349;
      const caps = await mod.checkPanelCapabilities(undefined, { port: panelPort });
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

  // ⑤b 动作开销（C451/C454）—— 解一个会话日志，实测 ~1s
  try {
    const mod = await import("./action-cost.mjs");
    const files = mod.sessionFiles(process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home");
    if (files.length === 0) {
      data.actionCost = null;
    } else {
      const { events } = mod.loadEvents(files[0].file);
      const { steps } = mod.attributeCosts(events);
      const tools = mod.byTool(steps);
      const byTotal = [...tools].sort((a, b) => (b.deltaTotal ?? 0) - (a.deltaTotal ?? 0));
      const top = byTotal[0] ?? null;
      const maxSingle = steps.reduce((m, x) => (Number.isFinite(x.inputDelta) ? Math.max(m, x.inputDelta) : m), 0);
      data.actionCost =
        top === null
          ? null
          : {
              topByTotal: top.tool,
              topTotal: top.deltaTotal ?? 0,
              topCount: top.count,
              topMedian: Math.round(top.deltaMedian ?? 0),
              topMedianMax: Math.round(maxSingle),
            };
    }
  } catch {
    data.actionCost = null;
  }

  // ⑥ 循环形状（C447）—— 直接 import 纯函数，不 spawn；实测 36 个会话 0.36s
  try {
    const mod = await import("./loop-report.mjs");
    const home = process.env.DSH_HOME ?? mod.defaultHome();
    const reports = mod.listGraphs(home).map(({ graph }) => {
      const edges = mod.orderedEdges(graph);
      const overall = mod.streakRuns(edges, { minRepeat: 4 });
      overall.sigEdges = edges.filter((e) => typeof e.sig === "string" && e.sig !== "").length;
      return { overall, folds: mod.streaksAroundFolds(graph, edges) };
    });
    data.loop = mod.summarize(reports);
  } catch {
    data.loop = null;
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
