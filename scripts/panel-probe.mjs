#!/usr/bin/env node
/**
 * panel-probe.mjs —— **只读**探针：正在运行的 DSH 面板 API 到底有哪些路由可用
 *
 * 为什么要有它（2026-11-05）：
 *   面板路由是 `ctx.webServer.register({kind:"prefix", path:"/gokifu/api", handler})` 注册的
 *   单条 **POST-only** 通道（见 `src/ui.mjs` 的 `applyInner` / `registerFallbackRoute`）。
 *   「路由在不在」与「action 通不通」是两件事，而过去两次真机事故都栽在这上面：
 *     · C332：插件实例被热重载/卸载后 `/gokifu/api` 变 404/405，doctor、测试、门禁全绿；
 *     · C588：路由在、handler 也在，但补账分支引用了不存在的 `bridge0` ⇒ 一调就 500。
 *   所以这份探针只做一件事：**把"现在到底哪些路径答话"钉成一张表**。
 *
 * 只读铁律（本脚本的合同）：
 *   1. **只发 GET / HEAD**。绝不 POST —— `action:"backfill"` 会真 resume 归档会话、真调模型，
 *      `action:"save"` 会写 preset。探针不许有副作用。
 *   2. **不写任何文件**（连临时文件都不写，输出只走 stdout）。
 *   3. **只访问本机回环**（127.0.0.1 / localhost / ::1）。URL 里出现其它 host 直接 refused。
 *   4. 不安装、不重启、不 kill 任何进程。
 *
 * 路由名的来源：**读 `src/ui.mjs` 解析，不靠猜**。任务书里那串 `/api/health`、`/api/models`…
 * 是「文档以为的形状」，本脚本会把它们与源码实际注册形状并排打出来 —— 差异本身就是结论。
 *
 * 用法：
 *   node scripts/panel-probe.mjs          # 默认：表格 + 补账专节 + 结论
 *   node scripts/panel-probe.mjs --json   # 机器可读（同样只读）
 *
 * 退出码：0 = 面板可达（路由表已产出）；1 = 面板未响应（端口无监听）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeUrl from "node:url";
import { execFileSync } from "node:child_process";
import { readUiRouteHeartbeat } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 与 `src/ui.mjs:resolveHome()` 同公式：$DSH_HOME 优先，否则 `%USERPROFILE%\DeepSeek Harness\home`。 */
const DSH_HOME =
  process.env.DSH_HOME ??
  nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home");

/** 路由心跳文件（`src/ui.mjs:routeHeartbeatFile()`）——面板「最近一次注册/卸载」的落盘事实。 */
const ROUTE_HEARTBEAT = nodePath.join(DSH_HOME, "chess-context", "ui-route.json");

/** 响应体截断长度（任务书要求「前 120 字」）。 */
const BODY_LIMIT = 120;
/** 端口存活判断的短超时：连不上就该立刻判死，不要等。 */
const LIVENESS_TIMEOUT_MS = 900;
/** 单条路由请求超时：面板 route 里有目录扫描（P4 缓存后仍是 ms 级），4s 足够。 */
const REQUEST_TIMEOUT_MS = 4000;
/** 允许访问的 host（只读铁律 3）。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 任务书（docs/项目任务书-2026-11-05.md 的 D5 项）假定的「文档路由」。
 * 这些**不是**源码里注册的名字 —— 留着它们是为了把「文档说有 / 实际不通」变成可复现的一行。
 */
const DOC_CLAIMED_ROUTES = [
  "/",
  "/api/health",
  "/api/models",
  "/api/defaults",
  "/api/prompt",
  "/api/folds",
  "/api/update",
  "/api/backfill",
];

/* ────────────────────────────── 小工具 ────────────────────────────── */

const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));

/** JSON 压成单行（探针的表格要一行一路由，不能带换行）。 */
function squeeze(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 前 N 字（按码点截，不切坏代理对）。 */
function head(text, n = BODY_LIMIT) {
  const chars = [...squeeze(text)];
  if (chars.length <= n) return chars.join("");
  return chars.slice(0, n).join("") + `…(+${chars.length - n} 字)`;
}

/** 只读铁律 3：非回环 host 一律拒绝（含 0.0.0.0 / 局域网 IP / 域名 / 公网）。 */
function assertLoopback(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法 URL：${url}`);
  }
  if (parsed.protocol !== "http:") throw new Error(`只允许 http 回环：收到 ${parsed.protocol}`);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`拒绝访问非回环地址：${host}（只读探针只打本机）`);
  return parsed;
}

/* ─────────────────────────── 1. 端口发现 ─────────────────────────── */

/**
 * `netstat -ano` 里的**本机**监听端口。只收回环 host（127.0.0.1 / ::1），
 * `0.0.0.0` 与局域网地址一律不收 —— 任务书要求「只试本机」。
 */
function loopbackListenerPorts() {
  let out = "";
  try {
    out = execFileSync("netstat", ["-ano"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // 非 Windows / netstat 不可用：退回 ss（Linux）。
    try {
      out = execFileSync("ss", ["-ltn"], { encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
      const ports = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*LISTEN\s+\d+\s+\d+\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s/.exec(line);
        if (!m) continue;
        if (!LOOPBACK_HOSTS.has(m[1].replace(/^\[|\]$/g, ""))) continue;
        ports.add(Number(m[2]));
      }
      return [...ports].filter((p) => Number.isInteger(p) && p > 0).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  const ports = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = /^\s*TCP\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s/.exec(line);
    if (!m) continue;
    const host = m[1].replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(host)) continue;
    const port = Number(m[2]);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/* ─────────────────────────── 2. 路由来源 ─────────────────────────── */

/**
 * 从 `src/ui.mjs` **解析**出真实注册的路由（不猜）。
 * 同时抓 `action === "…"` 的分支名 —— 单条 POST 通道的能力面就是这串 action。
 */
function parseRoutesFromSource() {
  const file = nodePath.join(REPO, "src", "ui.mjs");
  const src = nodeFs.readFileSync(file, "utf8");
  const routes = [];
  const seen = new Set();

  const routeRe = /kind:\s*["']([A-Za-z]+)["']\s*,\s*\n?\s*path:\s*["']([^"']+)["']/g;
  let m;
  while ((m = routeRe.exec(src)) !== null) {
    const key = `${m[1]} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ kind: m[1], path: m[2] });
  }

  const actions = [];
  const actionRe = /action\s*===\s*["']([^"']+)["']/g;
  while ((m = actionRe.exec(src)) !== null) {
    if (!actions.includes(m[1])) actions.push(m[1]);
  }

  return { file, routes, actions, bytes: Buffer.byteLength(src, "utf8") };
}

/* ─────────────────────────── 3. 只读请求 ─────────────────────────── */

/**
 * 发一条**只读**请求（GET / HEAD 白名单）。
 * @returns {Promise<{ok:boolean,status?:number,contentType?:string,body?:string,ms:number,error?:string}>}
 */
async function probe(port, method, path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const verb = String(method).toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") {
    // 只读铁律 1 的运行时兜底：写操作在类型层就被挡住。
    return { ok: false, ms: 0, error: `拒绝发送 ${verb}（只读探针只允许 GET/HEAD）` };
  }
  const url = `http://127.0.0.1:${port}${path}`;
  assertLoopback(url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: verb,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/plain, */*" },
    });
    const body = verb === "HEAD" ? "" : await res.text().catch(() => "");
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
      ms: Date.now() - started,
    };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.name ?? "fetch-failed";
    return { ok: false, ms: Date.now() - started, error: String(code) };
  }
}

/* ─────────────────────────── 4. 表格渲染 ─────────────────────────── */

/** 一行 = 方法 路径 → 状态码 · Content-Type · 前 120 字响应。 */
function renderRow(method, path, result) {
  if (!result.ok) {
    return `${pad(method, 6)}${pad(path, 24)} → 连接失败 · ${result.error}`;
  }
  const ct = result.contentType === "" ? "(无 content-type)" : squeeze(result.contentType);
  const body = result.body === "" ? "(空响应体)" : head(result.body);
  return `${pad(method, 6)}${pad(path, 24)} → ${result.status} · ${ct} · ${body}`;
}

/* ─────────────────────────── 5. 主流程 ─────────────────────────── */

async function main() {
  const asJson = process.argv.includes("--json");
  const out = [];
  const emit = (line = "") => {
    out.push(line);
    if (!asJson) console.log(line);
  };

  emit("════════ 面板只读探针 · panel-probe（GET/HEAD only，不写文件、不出网）════════");
  emit(`时间          ：${new Date().toISOString()}`);
  emit(`仓库          ：${REPO}`);
  emit(`DSH_HOME      ：${DSH_HOME}`);

  /* ── 5.1 心跳 ── */
  // ★ C604：心跳**先验写它的 pid**。真机（2026-11-05）：`ui-route.json` 写着 pid 22508 / port 64535，
  //   而 22508 早已退出、64535 无人监听 —— 旧版只看 `state` 就把这个死端口当「端口来源」。
  const hbRead = readUiRouteHeartbeat({ dir: nodePath.dirname(ROUTE_HEARTBEAT) });
  const hb = { ok: hbRead.state === "fresh", stale: hbRead.state === "stale", value: hbRead.heartbeat, error: hbRead.reason };
  emit("");
  emit("── 1. 路由心跳（src/ui.mjs:routeHeartbeatFile）──");
  emit(`文件          ：${ROUTE_HEARTBEAT}`);
  if (hbRead.state === "missing") {
    emit("读取          ：（没有 ui-route.json）");
  } else if (hbRead.state === "invalid") {
    emit(`读取          ：❌ ${hb.error}`);
  } else {
    emit(`内容          ：${squeeze(JSON.stringify(hb.value))}`);
    const at = Number(hb.value?.at);
    emit(
      `判定          ：state=${hb.value?.state ?? "?"} · port=${hb.value?.port ?? "null"} · pid=${hb.value?.pid ?? "null"}` +
        (Number.isFinite(at) ? ` · 写入于 ${new Date(at).toISOString()}` : ""),
    );
    // 过期/不可校验的心跳：端口只是旧值，**不许**进候选
    if (hb.stale) {
      emit(`心跳过期 ⇒ 忽略其端口（pid ${hbRead.pid ?? "?"} 已退出，心跳里的 port=${hbRead.port ?? "null"} 不是现值）`);
    } else if (!hb.ok) {
      emit(`心跳不可校验 ⇒ 忽略其端口（${hb.error}）`);
    }
  }

  /* ── 5.2 磁盘 buildId vs 运行 buildId ── */
  let diskBuild = "unknown";
  try {
    const stamp = await import(nodeUrl.pathToFileURL(nodePath.join(REPO, "src", "rooms", "build-stamp.mjs")).href);
    diskBuild = stamp.repoBuildId();
  } catch (error) {
    diskBuild = `unknown(${String(error?.message ?? error).slice(0, 60)})`;
  }
  const hbBuild = hb.ok ? String(hb.value?.buildId ?? "null") : hb.stale ? "null（心跳过期，不作数）" : "null";
  emit("");
  emit("── 2. 构建标识（运行实例 vs 磁盘）──");
  emit(`磁盘 buildId  ：${diskBuild}`);
  emit(`心跳 buildId  ：${hbBuild}`);
  emit(
    `判定          ：${
      hb.ok ? (hbBuild === diskBuild ? "✅ 一致（跑的就是仓库这份）" : "⚠ 不一致（跑的是旧构建，源码改动要重启才生效）") : "⚠ 心跳不是新鲜的 —— 不作「跑的是哪一版」的结论"
    }`,
  );

  /* ── 5.3 端口发现 ── */
  emit("");
  emit("── 3. 端口发现（只试本机回环）──");
  // ★ C604：只有 fresh 心跳的端口才算候选（死进程的端口是旧值）
  const hbPort = hb.ok && Number.isFinite(Number(hb.value?.port)) && Number(hb.value?.port) > 0 ? Number(hb.value.port) : null;
  const discovered = loopbackListenerPorts();
  emit(`心跳端口      ：${hbPort ?? "(无)"}`);
  emit(`netstat 回环  ：${discovered.length} 个 → ${discovered.join(", ") || "(无)"}`);

  // 候选顺序：心跳端口优先，其余按端口号；去重。
  const candidates = [...new Set([...(hbPort ? [hbPort] : []), ...discovered])];

  /** 命中面板的判据：GET /gokifu/api 返回 404 以外的东西（405 就说明 handler 跑过了）。 */
  const hits = [];
  const deadPorts = [];
  await Promise.all(
    candidates.map(async (port) => {
      const r = await probe(port, "GET", "/gokifu/api", LIVENESS_TIMEOUT_MS);
      if (r.ok) hits.push({ port, result: r });
      else deadPorts.push({ port, error: r.error });
    }),
  );
  hits.sort((a, b) => a.port - b.port);

  // 面板 = 响应体里带「只接受 POST」的那一个（插件自己的门禁文案）。
  const panelHit = hits.find((h) => h.result.body.includes("只接受 POST")) ?? null;
  const panelPort = panelHit?.port ?? null;

  emit(`探测结果      ：${hits.length} 个端口有 HTTP 应答 → ${hits.map((h) => `${h.port}(${h.result.status})`).join(", ") || "(无)"}`);
  if (hbPort !== null && !hits.some((h) => h.port === hbPort)) {
    emit(`⚠ 心跳端口 ${hbPort} 无监听 —— 心跳是旧的（进程已退出 / 端口已换），以实测命中为准。`);
  }
  emit(`${panelPort === null ? "❌" : "✅"} 面板端口    ：${panelPort ?? "未找到"}`);

  /* ── 5.4 源码路由 ── */
  const source = parseRoutesFromSource();
  emit("");
  emit("── 4. 源码里真实注册的路由（解析 src/ui.mjs，不猜）──");
  emit(`文件          ：${source.file}（${source.bytes} 字节）`);
  if (source.routes.length === 0) {
    emit("❌ 没解析出任何路由 —— 源码形状变了，探针要跟着改。");
  }
  for (const r of source.routes) {
    emit(`  kind=${pad(r.kind, 7)}path=${r.path}`);
  }
  emit(`  action 分支 ：${source.actions.join(" | ") || "(无)"}`);

  /* ── 5.5 路由表 ── */
  emit("");
  emit("── 5. 路由表（每个路由一行：方法 路径 → 状态码 · Content-Type · 前 120 字）──");

  // 若面板不可达，仍要把「未响应」写清楚，而不是空表或异常栈。
  if (panelPort === null) {
    // 任务书要求：连不上时**明写**「面板未响应 / 端口 X 无监听」，不许留空表。
    // ★ C604：过期心跳不许说成「端口 X 无监听」—— 那个端口本来就不是现值。
    const deadNote = hb.stale
      ? `面板未响应 / 心跳过期（pid ${hbRead.pid ?? "?"} 已退出，不拿它的 port 当现值），回环端口也全部无应答`
      : hbPort !== null
        ? `面板未响应 / 端口 ${hbPort} 无监听`
        : "面板未响应 / 无已知端口（心跳缺失，回环端口也全部无应答）";
    emit("");
    for (const path of [...new Set([...source.routes.map((r) => r.path), ...DOC_CLAIMED_ROUTES])]) {
      emit(`${pad("GET", 6)}${pad(path, 24)} → 未探测 · ${deadNote}`);
    }
    emit("");
    emit(`❌ ${deadNote} —— 上面没有任何一条真实状态码。`);
    emit("   排查：GUI 进程还在吗（netstat 找 LISTENING）？插件被热重载卸载了吗（心跳 state=closed）？");
    emit("   注意：只读探针不重启、不拉起任何进程。");
    if (asJson) console.log(JSON.stringify({ reachable: false, port: hbPort, heartbeatState: hbRead.state, stale: hb.stale, rows: [] }, null, 2));
    process.exitCode = 1;
    return;
  }

  const rows = [];
  /** 源码路由：GET 打一遍（只读），HEAD 做方法能力对照。 */
  for (const r of source.routes) {
    const get = await probe(panelPort, "GET", r.path);
    rows.push({ method: "GET", path: r.path, source: "src/ui.mjs", ...get });
    emit(renderRow("GET", r.path, get));
    const headRes = await probe(panelPort, "HEAD", r.path);
    rows.push({ method: "HEAD", path: r.path, source: "src/ui.mjs", ...headRes });
    emit(renderRow("HEAD", r.path, headRes));
  }

  // prefix 路由的「子路径也命中」证据：/gokifu/api/health 必须落到同一个 handler。
  const prefix = source.routes.find((r) => r.kind === "prefix");
  if (prefix) {
    const child = `${prefix.path}/health`;
    const childRes = await probe(panelPort, "GET", child);
    rows.push({ method: "GET", path: child, source: "prefix 子路径", ...childRes });
    emit(renderRow("GET", child, childRes));
  }

  // 文档假定路由：让「文档说有 / 源码里没有」变成一行实测。
  emit("");
  emit("── 6. 文档假定的路由（任务书 D5 列表；源码里**没有**这些 path）──");
  for (const path of DOC_CLAIMED_ROUTES) {
    if (source.routes.some((r) => r.path === path)) continue;
    const res = await probe(panelPort, "GET", path);
    rows.push({ method: "GET", path, source: "doc-claimed", ...res });
    emit(renderRow("GET", path, res));
  }

  /* ── 5.6 补账专节 ── */
  emit("");
  emit("── 7. 补账通道（本轮重点）──");
  const backfillRow = rows.find((r) => r.method === "GET" && r.path === (prefix?.path ?? "/gokifu/api"));
  if (backfillRow?.ok) {
    if (backfillRow.status === 405) {
      emit("路由存在性  ：✅ 存在（GET 405 + 插件自己的「只接受 POST」文案 ⇒ handler 已注册并执行；");
      emit("                 未注册时这里会是 404，不是 405）");
    } else if (backfillRow.status === 404) {
      emit("路由存在性  ：❌ 404 —— 路由没注册（插件被卸载 / 初始化失败），面板此刻不可用");
    } else if (backfillRow.status >= 500) {
      emit(`路由存在性  ：❌ ${backfillRow.status} —— 路由在，但 handler 抛错`);
      emit(`响应体原文  ：${squeeze(backfillRow.body)}`);
    } else {
      emit(`路由存在性  ：${backfillRow.status} · ${head(backfillRow.body)}`);
    }
  }
  emit('动作级验证  ：⛔ 未执行 —— 补账是 POST {action:"backfill"}（dryRun 也是 POST）。');
  emit("             本探针的合同是「只发 GET/HEAD」，所以「补账 200 还是 500」这一条**本轮验不到**；");
  emit("             能验的只有「路由在不在」（上面那行）。要验动作级，得由人在面板上点，或显式授权一次 POST。");

  // 运行副本静态检查：bridge0 是否还活着（C588 的现场）。
  emit("");
  emit("── 8. 补账通道的静态证据（运行副本是否还带着 bridge0 这个 bug）──");
  const runningCopy = runningPluginCopy();
  if (!runningCopy) {
    emit("运行副本    ：未定位到（profile 的 node_modules 里没找到 dsh-gokifu-compact）");
  } else {
    emit(`运行副本    ：${runningCopy}`);
    try {
      const code = stripComments(nodeFs.readFileSync(nodePath.join(runningCopy, "src", "ui.mjs"), "utf8"));
      const hasBridge0 = /(^|[^A-Za-z0-9_$.])bridge0([^A-Za-z0-9_]|$)/.test(code);
      emit(`去注释后含 bridge0：${hasBridge0 ? "❌ 是（补账通道必抛 ReferenceError: bridge0 is not defined）" : "✅ 否（C588 已修：用的是 bridge.isBackfillBusy）"}`);
      const idx = code.indexOf("isBackfillBusy");
      if (idx >= 0) emit(`isBackfillBusy 上下文：${head(code.slice(Math.max(0, idx - 60), idx + 40), 120)}`);
    } catch (error) {
      emit(`读取失败    ：${String(error?.message ?? error)}`);
    }
  }

  /* ── 5.7 结论 ── */
  emit("");
  emit("── 9. 结论 ──");
  const okCount = rows.filter((r) => r.ok && r.status < 400).length;
  emit(`真实路由数  ：${source.routes.length}（prefix 单通道，POST-only）`);
  emit(`GET 成功(<400)：${okCount} 条；GET 405（POST-only 门禁）：${rows.filter((r) => r.ok && r.status === 405).length} 条；401/404：${rows.filter((r) => r.ok && (r.status === 401 || r.status === 404)).length} 条`);
  emit(`面板可用    ：${backfillRow?.ok && backfillRow.status !== 404 ? "✅ 路由在（POST 通道）" : "❌ 路由不在"}`);
  emit("文档说有、实际不通：");
  emit("  · /api/health、/api/models、/api/defaults、/api/prompt、/api/folds、/api/update、/api/backfill —— 源码里没有这些 path；");
  emit("    能力全在单条 POST /gokifu/api 的 body.action 里（GET 打不到，一律 405 或 401）。");
  emit("  · 面板页面本身不是 HTTP 路由（是 DSH GUI 的 slot：lib/client.js 的 ctx.slots.register），没有可 GET 的 HTML。");
  emit("  · 补账的「能不能真跑」只有 POST 能验；GET 只能证明路由活着（405 而非 404）。");

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          reachable: true,
          panelPort,
          heartbeat: hb.ok ? hb.value : null,
          diskBuildId: diskBuild,
          routes: source.routes,
          actions: source.actions,
          rows,
        },
        null,
        2,
      ),
    );
  }
  process.exitCode = 0;
}

/** 定位「正在跑的那份插件副本」：`<DSH_HOME>/profiles/<profile>/node_modules/dsh-gokifu-compact`。 */
function runningPluginCopy() {
  const profilesRoot = nodePath.join(DSH_HOME, "profiles");
  let names = [];
  try {
    names = nodeFs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    const dir = nodePath.join(profilesRoot, name, "node_modules", "dsh-gokifu-compact");
    try {
      if (nodeFs.existsSync(nodePath.join(dir, "src", "ui.mjs"))) found.push(dir);
    } catch {
      /* 读不到就当没有 */
    }
  }
  return found[0] ?? null;
}

/** 去注释（只处理 `//` 与 `/* *\/`，字符串里的 `//` 可能误伤，但这里只做「有没有 bridge0」的存在性判断）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

await main();
