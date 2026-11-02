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
import { execFileSync, spawnSync } from "node:child_process";
import { checkPanelCapabilities } from "./post-restart-check.mjs";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";

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

/**
 * ★ C338：从 `netstat -ano` 文本里找出**监听某端口的进程 pid**。
 *
 * 为什么需要：真机上同时有多个 DSH 进程 —— 心跳写着"面板注册在 pid 23748"，
 * 而真正在服务 64349 的是 **pid 24944**。不把这两个对上，验收结论会一直含糊
 * （"注册了但访问不到"到底是谁的问题？）。
 *
 * @param {string} netstatText
 * @param {number} port
 * @returns {number|null}
 */
export function listeningPidOf(netstatText, port) {
  const wanted = `:${port}`;
  for (const line of String(netstatText ?? "").split("\n")) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[1];
    if (!local.endsWith(wanted)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * ★ C395：**字段级陈旧探针**。能力探针只能证明"认不认识某个 action"，
 * 但我们发布的新东西经常是**新字段**（如 `today.truncated`）。它没出现时，面板看起来一切正常，
 * 而你却不知道"是没生效还是没数据"。这里把最新字段列成清单直接查。
 *
 * @param {any} stateJson 面板 `{"action":"state"}` 的返回
 * @returns {{ok:boolean, missing:string[]}}
 */
export function panelFieldProbe(stateJson) {
  const missing = [];
  if (stateJson === null || typeof stateJson !== "object") return { ok: false, missing: ["state 本身不可用"] };
  const today = stateJson.today;
  if (today === null || typeof today !== "object") missing.push("today");
  else if (!Number.isFinite(today.truncated)) missing.push("today.truncated");
  return { ok: missing.length === 0, missing };
}

/**
 * ★ C409：**参数级探针**。能力探针只知道"认识不认识这个 action"，
 * 但真正会坑人的是**参数没生效**：真机实例（C408）——面板认识 `backfill`，
 * 但不认识 `sessionIds` 参数，于是"只补一个小会话"的请求会**静默跑 20 个**。
 *
 * 探法：发一个肯定不存在的 id（`__probe__`）+干跑 —— 加载了新代码的面板会回 **400**（"都不在待补清单里"）；
 * 旧面板会忽略该参数、回 200 + 全量 items。两者都不会真补、不花钱。
 * @param {{status:number, json:any}} res
 * @returns {"supported"|"unsupported"|"unknown"}
 */
export function sessionIdsProbe(res) {
  const status = Number(res?.status);
  const json = res?.json ?? null;
  if (status === 400 && typeof json?.error === "string" && json.error.includes("待补清单")) return "supported";
  if (status === 200 && json?.dryRun === true) return "unsupported";
  return "unknown";
}

/**
 * ★ C410：从 `netstat -ano` 文本里取**本机监听的端口列表**（去重、排序）。
 * 用途：心跳被覆盖（port=null）时，靠扫描找回面板在哪个端口 ——
 * 否则所有"读心跳取端口"的工具会一起集体失效（真机事故 2026-11-03）。
 * @param {string} netstatText
 * @returns {number[]}
 */
export function listeningPorts(netstatText) {
  const ports = new Set();
  for (const line of String(netstatText ?? "").split("\n")) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    const m = /:([0-9]{2,5})$/.exec(local);
    if (m === null) continue;
    const port = Number(m[1]);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  // ★ C415：**只看高位端口**（面板不会在 80/443/445 这些系统端口），
  //   否则扫一圈 41 个端口 × 每个几百毫秒 = 整条命令挂住（真机：--dry 跑了 10 分钟没出结果）。
  return [...ports].filter((p) => p >= 1024 && p <= 65535).sort((a, b) => a - b);
}

/**
 * ★ C415：判断一个响应是不是**我们的面板**。纯函数。
 *
 * 真机教训（2026-11-03）：扫端口时发现本机有好几个本地服务对**任意 POST**都回 200 ⇒
 * 只看"状态码 200 + 能解析" 会把别人的服务当成面板，然后报「面板不可达/不认识」。
 * 面板的 health/state 必须带 `ok:true`，且带 `installed` 或 `presets` 这种只有我们有的字段。
 * @param {any} json
 * @returns {boolean}
 */
export function looksLikePanel(json) {
  if (json === null || typeof json !== "object") return false;
  if (json.ok !== true) return false;
  return typeof json.installed === "boolean" || Array.isArray(json.presets) || typeof json.profile === "string";
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  // ★ C332：优先用**面板自己写的心跳**里的端口 —— 真机上可能同时有多个 DSH 进程，
  //   硬编码端口会探到别人身上（实测：心跳写着 pid 19540，而 64349 是另一个进程）。
  const heartbeatPort = (() => {
    try {
      const file = nodePath.join(process.env.DSH_HOME ?? "", "chess-context", "ui-route.json");
      if (!nodeFs.existsSync(file)) return null;
      const hb = JSON.parse(nodeFs.readFileSync(file, "utf8"));
      return Number.isFinite(Number(hb?.port)) ? Number(hb.port) : null;
    } catch {
      return null;
    }
  })();
  // ★ C410：心跳拿不到端口时，**自己去找**（扫本机监听端口）。
  const explicitPort = Number(getArg("port", ""));
  const discoverPort = async () => {
    try {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15_000 });
      // ★ C415：给发现一个**总预算**（最多 12 个候选、最多 6 秒），不让验收命令因扫端口而挂住。
      const deadline = Date.now() + 6000;
      for (const candidate of listeningPorts(out).slice(0, 12)) {
        try {
          const res = await fetch(`http://127.0.0.1:${candidate}/gokifu/api`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "health" }),
            signal: AbortSignal.timeout(1500),
          });
          if (!res.ok) continue;
          const json = await res.json();
          if (looksLikePanel(json)) return candidate;
        } catch {
          /* 不是面板：试下一个 */
        }
        if (Date.now() > deadline) break;
      }
      return null;
    } catch {
      return null;
    }
  };
  const port = explicitPort || heartbeatPort || (await discoverPort()) || 64349;
  const home = getArg("home", process.env.DSH_HOME ?? "");
  // ★ C338：端口属主 vs 心跳 pid —— 真机上这俩经常不是同一个进程
  const heartbeatPid = (() => {
    try {
      const file = nodePath.join(home, "chess-context", "ui-route.json");
      if (!nodeFs.existsSync(file)) return null;
      const hb = JSON.parse(nodeFs.readFileSync(file, "utf8"));
      return Number.isInteger(Number(hb?.pid)) ? Number(hb.pid) : null;
    } catch {
      return null;
    }
  })();
  const ownerPid = (() => {
    try {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15000 });
      return listeningPidOf(out, port);
    } catch {
      return null;
    }
  })();
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

  // ★ C353：`buildOk` 不许写死 true —— 真机上"跑的是旧代码"是最常见的情形，
  //   验收脚本自己撒谎就等于没有验收。这里用心跳里的 buildId 与磁盘比。
  const build = (() => {
    let disk = null;
    try {
      disk = repoBuildId();
    } catch {
      disk = null;
    }
    let heartbeat = null;
    try {
      const file = nodePath.join(home, "chess-context", "ui-route.json");
      if (nodeFs.existsSync(file)) heartbeat = JSON.parse(nodeFs.readFileSync(file, "utf8"))?.buildId ?? null;
    } catch {
      heartbeat = null;
    }
    if (disk === null || heartbeat === null) return { ok: null, disk, heartbeat };
    return { ok: String(disk) === String(heartbeat), disk, heartbeat };
  })();
  // ★ C395：字段级探针（面板跑的代码是否已含最新字段）
  const fieldProbe = await (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/gokifu/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "state" }),
      });
      return panelFieldProbe(await res.json());
    } catch {
      return null;
    }
  })();
  // ★ C409：参数级探针（干跑 + 不存在的 id，不花钱）
  const paramProbe = await (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/gokifu/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "backfill", dryRun: true, sessionIds: ["__probe__"] }),
      });
      return sessionIdsProbe({ status: res.status, json: await res.json() });
    } catch {
      return "unknown";
    }
  })();
  const result = verdictOf({ caps, backfill, ...evidence, buildOk: build.ok });
  if (paramProbe === "unsupported") {
    result.todo.push("面板不认识 `sessionIds` 参数（C408）—— 别带着它发真补账请求，否则会静默跑 20 个");
  }
  if (fieldProbe !== null && !fieldProbe.ok) {
    result.todo.push(`面板代码比磁盘旧：缺字段 ${fieldProbe.missing.join(" / ")}（需重载或重启才能看到新数据）`);
    if (result.verdict === "ready") result.verdict = "partial";
  }
  const ownerNote =
    ownerPid === null || heartbeatPid === null
      ? ""
      : ownerPid === heartbeatPid
        ? `（端口 ${port} 与心跳是同一进程 ${ownerPid}）`
        : `（**端口 ${port} 属 pid ${ownerPid}，而心跳来自 pid ${heartbeatPid}** —— 插件没注册到 GUI 进程里）`;
  if (ownerNote !== "") result.line = `${result.line} ${ownerNote}`;
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ caps, backfill, ...evidence, ...result }, null, 2));
    return result.verdict === "stale" ? 1 : 0;
  }
  console.log("== 重启后验收（accept-after-restart）==");
  console.log(`  ${result.line}`);
  for (const item of result.todo) console.log(`   · ${item}`);
  // ★ C405：顺手把 doctor 的一句话也带上。「接管了没有」和「现在健康吗」是同一个时刻的两个问题，
  //   没道理让人为此再跑第二条命令。拿不到就不说（不猜）。
  const doctorLine = (() => {
    try {
      const r = spawnSync(process.execPath, [nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "doctor.mjs")], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, DSH_HOME: home },
      });
      const m = String(r.stdout ?? "").match(/错误\s*(\d+)\s*\/\s*警告\s*(\d+)/);
      return m === null ? null : `错误 ${m[1]} / 警告 ${m[2]}`;
    } catch {
      return null;
    }
  })();
  if (doctorLine !== null) console.log(`  doctor：${doctorLine}`);

  // ★ C386：验收完了人立刻要问「那现在补账多少、要几次、会不会超时」——
  //   把这三个数并到**同一条命令的输出里**，免得还要另跑 `backfill-plan`。
  try {
    const { buildPlan, summarizePlan, recommendMaxFoldTokens } = await import("./backfill-plan.mjs");
    const rows = await buildPlan(home);
    const plan = summarizePlan(rows, { roughPerEvent: 154 });
    const rec = recommendMaxFoldTokens(rows);
    console.log(
      `  补账：${plan.total} 个欠账 · ${(plan.tokens / 1e6).toFixed(2)} M tok · 冷缓存 **$${plan.costUsd.toFixed(2)}** · ` +
        `约 **${plan.clicks} 次点击**${plan.multiPass > 0 ? `（${plan.multiPass} 个超 6 段）` : ""}` +
        `${rec === null ? "" : `；建议 closeoutMaxFoldTokens ≈ **${rec.value}**`}`,
    );
  } catch (error) {
    console.log(`  补账：算不出来（${String(error?.message ?? error).slice(0, 80)}）—— 可单独跑 node scripts/backfill-plan.mjs`);
  }
  return result.verdict === "stale" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
