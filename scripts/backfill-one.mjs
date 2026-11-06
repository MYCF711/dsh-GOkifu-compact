/**
 * backfill-one.mjs —— **只补一个会话**，补完立刻验证（C415）
 *
 * 由来：补账默认是「按 tail 降序取前 20 个」（先碰最大的），一次点下去可能十几分钟、$1.6。
 * 真机上我们想先拿一个**小会话**验证「取消归档 → resume → 收尾折叠 → 归档回去」这条链，
 * 但旧面板不认识 `sessionIds` 参数 —— 带着它发请求会**静默跑 20 个**（C408/C409 的教训）。
 *
 * 这个脚本把顺序固化下来：
 *   ① 干跑拿清单 → ② 探 `sessionIds` 是否被支持（不支持就**拒绝**）→ ③ 只补一个 → ④ 立刻验证。
 *
 * 用法：
 *   node scripts/backfill-one.mjs --session <id 前缀>            # 指定（可写前缀）
 *   node scripts/backfill-one.mjs                               # 自动挑 tail 最小的那个
 *   node scripts/backfill-one.mjs --dry                                  # 只演不跑
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { sessionIdsProbe, listeningPorts, looksLikePanel } from "./accept-after-restart.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/**
 * ★ C415：从 dryRun 清单里挑目标。纯函数。
 * @param {Array<{sessionId:string, tail?:number}>} items
 * @param {string|null} prefix 用户给的前缀（可为 null = 自动挑最小）
 * @returns {{target: object|null, reason: string}}
 */
export function pickTarget(items, prefix) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { target: null, reason: "待补清单是空的（没有欠账）" };
  if (prefix === null || prefix === undefined || prefix === "") {
    const sorted = [...list].sort((a, b) => (Number(a?.tail) || 0) - (Number(b?.tail) || 0));
    return { target: sorted[0], reason: `自动挑 tail 最小的：${sorted[0].sessionId}（tail ${sorted[0].tail ?? "?"}）` };
  }
  const hit = list.filter((it) => String(it?.sessionId ?? "").startsWith(prefix));
  if (hit.length === 0) return { target: null, reason: `前缀 ${prefix} 在待补清单里没有匹配` };
  if (hit.length > 1) {
    return { target: null, reason: `前缀太短，匹配到 ${hit.length} 个：${hit.slice(0, 5).map((x) => x.sessionId).join(" / ")}` };
  }
  return { target: hit[0], reason: `指定：${hit[0].sessionId}（tail ${hit[0].tail ?? "?"}）` };
}

/**
 * ★ C415：能否安全地"只补一个"。纯函数。
 * @param {"supported"|"unsupported"|"unknown"} probe
 * @returns {{ok:boolean, why:string}}
 */
export function canRunSingle(probe) {
  if (probe === "supported") return { ok: true, why: "面板认识 sessionIds（C408）" };
  if (probe === "unsupported") {
    return { ok: false, why: "面板**不认识** sessionIds —— 带着它发真补账会静默跑满 20 个，先重启加载新代码" };
  }
  return { ok: false, why: "探不出 sessionIds 是否被支持（面板不可达？）—— 不敢冒险" };
}

async function postPanel(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/gokifu/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function discover(execFileSync) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15_000 });
    for (const port of listeningPorts(out)) {
      try {
        const r = await postPanel(port, { action: "health" });
        if (looksLikePanel(r.json)) return port;
      } catch {
        /* 不是面板 */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const { execFileSync } = await import("node:child_process");
  const port = Number(getArg("port", "")) || (await discover(execFileSync));
  if (port === null) {
    console.log("✗ 找不到面板（端口发现失败）—— 先确认 DSH 在跑");
    return 2;
  }
  const probe = sessionIdsProbe(await postPanel(port, { action: "backfill", dryRun: true, sessionIds: ["__probe__"] }));
  const gate = canRunSingle(probe);
  if (!gate.ok) {
    console.log(`✗ 不能只补一个：${gate.why}`);
    return 1;
  }
  const dry = await postPanel(port, { action: "backfill", dryRun: true });
  const items = Array.isArray(dry.json?.items) ? dry.json.items : [];
  const picked = pickTarget(items, getArg("session"));
  console.log(`目标：${picked.reason}`);
  if (picked.target === null) return 1;
  if (argv.includes("--dry")) {
    console.log("（--dry）到此为止，没有发真补账请求");
    return 0;
  }
  const id = picked.target.sessionId;
  console.log(`开始补：${id} …（每会话上限 ${getArg("perItemMs", "180000")}ms）`);
  const run = await postPanel(port, {
    action: "backfill",
    sessionIds: [id],
    perItemMs: Number(getArg("perItemMs", "180000")),
  });
  console.log(`返回：${JSON.stringify(run.json?.report ?? run.json).slice(0, 600)}`);
  return run.status === 200 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
