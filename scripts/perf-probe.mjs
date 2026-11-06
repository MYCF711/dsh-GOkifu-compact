/**
 * perf-probe.mjs —— 量一下面板接口的**真实延迟与载荷大小**（C283）
 *
 * 为什么需要：性能和"感觉快了"不是一个东西。重启后最容易退化的往往不是功能，而是接口变慢
 * （比如缓存策略改错、扫描变大）。这个脚本让"变慢"变成**可比的两个数字**：
 * 重启前跑一次、重启后跑一次，同一口径对比。
 *
 * 用法：
 *   node scripts/perf-probe.mjs                 # 默认 127.0.0.1:<LOCAL_SERVICE_PORT>
 *   node scripts/perf-probe.mjs --port 64349 --rounds 5
 *   node scripts/perf-probe.mjs --json
 *
 * 退出码：永远 0（它是**测量**，不是判据）；接口不可达时打印原因并以 0 退出。
 */
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

/** 要量的接口。`body` 是 POST 的 JSON；`dryRun` 的补账接口只读、不 resume。 */
export const PROBES = Object.freeze([
  { id: "state", label: "/state（面板首屏）", body: { action: "state" } },
  { id: "models", label: "/models（模型目录）", body: { action: "models" } },
  { id: "backfill-dry", label: "/backfill dryRun（欠账体检）", body: { action: "backfill", dryRun: true } },
]);

/** 纯函数：把若干次采样汇总成一行结论（便于测试与复用）。 */
export function summarize(samples) {
  const ok = samples.filter((n) => Number.isFinite(n));
  if (ok.length === 0) return { count: 0, min: null, p50: null, max: null };
  const sorted = [...ok].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { count: sorted.length, min: sorted[0], p50, max: sorted[sorted.length - 1] };
}

async function probeOnce(url, body) {
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ms: Date.now() - started, bytes: Buffer.byteLength(text), status: res.status };
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = Number(getArg("port", "64349")) || 64349;
  const rounds = Math.max(1, Math.min(20, Number(getArg("rounds", "3")) || 3));
  const url = `http://127.0.0.1:${port}/gokifu/api`;
  const asJson = argv.includes("--json");

  const rows = [];
  for (const probe of PROBES) {
    const samples = [];
    let bytes = 0;
    let status = 0;
    for (let i = 0; i < rounds; i += 1) {
      try {
        const one = await probeOnce(url, probe.body);
        samples.push(one.ms);
        bytes = one.bytes;
        status = one.status;
      } catch (error) {
        rows.push({ id: probe.id, label: probe.label, error: String(error?.message ?? error).slice(0, 120) });
        break;
      }
    }
    if (samples.length > 0) {
      rows.push({ id: probe.id, label: probe.label, status, bytes, ...summarize(samples) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ url, rounds, rows }, null, 2));
    return 0;
  }
  console.log(`== 面板接口延迟（${url}，每个探针 ${rounds} 次）==`);
  for (const row of rows) {
    if (row.error !== undefined) {
      console.log(`  ! ${row.label}：${row.error}`);
      continue;
    }
    // 非 200 要说人话：最常见的原因是运行实例还没更新（不认识这个 action），不是"接口坏了"
    const hint = row.status === 200 ? "" : "  ← 非 200：多半是运行实例还没更新（重启后才有这个接口）";
    console.log(
      `  · ${row.label}：p50 ${row.p50} ms（min ${row.min} / max ${row.max}）· 载荷 ${(row.bytes / 1024).toFixed(1)} KB · HTTP ${row.status}${hint}`,
    );
  }
  console.log("\n（这是测量不是判据：重启前后各跑一次，同口径对比。）");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
