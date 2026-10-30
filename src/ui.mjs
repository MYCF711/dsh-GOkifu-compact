/**
 * ui.mjs —— 「上下文压缩」详情页的 host 半（HTTP 路由 + 状态/配置读写）
 *
 * 为什么需要 host 半：引擎挂在 **agent preset 的 compaction group（isolate realm）** 里，
 * 浏览器页面摸不到它；而配置又写在 preset 的 `cordis.patch.yml`（磁盘文件）。
 * 所以页面只做 UI，数据由这里通过 `ctx.webServer` 的具名路由提供：
 *
 *   POST /gokifu/api  {action:"state"|"save"|"health"|"defaults", patch?, sessionId?}
 *
 * 设计约束（都是实机踩出来的）：
 *   · 只走 webServer 具名路由，不用 Typert —— Typert 的 remote-client 是 DSH 构建期生成的，
 *     第三方插件拿不到那条流水线；`register({kind, path, handler})` 是公开的、够用。
 *   · 写配置**必须**走文本级块替换（`src/rooms/preset-format.mjs` 的 renderEngineBlock），
 *     因为 preset 里那一块前后都有别的行；用 YAML 库整份重写会丢注释与顺序。
 *   · 保存后必须重启才生效（插件在 boot 时读 preset），所以返回值带 `restartRequired`。
 *
 * 安全（2026-10-30 实装，WS-UIAUDIT A1/A2）：
 *   · **CSRF**：DSH 的 webServer 不做任何 Origin 校验（`asar/webserver.js` 全文无 origin 字样），
 *     路由 handler 自己负责。这里对每个 POST 校验三件事：
 *       ① Host 必须是回环地址（防 DNS rebinding）——**fail closed**：绑到 `0.0.0.0` 也不放行，
 *          非回环 Host 只有出现在 `DSH_GOKIFU_ALLOWED_HOSTS`（逗号分隔）里才通过
 *          （「绑 0.0.0.0」只表示监听所有网卡，不等于「信任任意域名解析到本机」）
 *       ② 带 Origin 时必须是同源（协议+主机+端口与 Host 一致）
 *       ③ 带 Sec-Fetch-Site 时只允许 same-origin / none（**same-site 也不行**：
 *          127.0.0.1:19401 → 127.0.0.1:19400 的跨站简单请求实测就是 `same-site`）
 *     再要求 `content-type: application/json` —— 表单与 `text/plain` 都进不来。
 *   · **真实调用方核对**（不是凭猜）：唯一的浏览器调用方是 `lib/client.js` 的
 *     `fetch("/gokifu/api", {method:"POST", headers:{"content-type":"application/json"}})`。
 *     本机 Chromium 实测（`tmp/dsh-gokifu-compact/ws-csrf/browser-origin-probe.mjs`）：
 *     同源 POST 必带 `origin: http://127.0.0.1:<port>` + `sec-fetch-site: same-origin`；
 *     跨站 `text/plain` 简单请求带 `origin: <攻击者源>` + `sec-fetch-site: same-site`。
 *     ⇒ 浏览器永远不会「不带 Origin」发 POST，所以**缺 Origin 只可能是非浏览器本机调用**
 *     （curl / node / 测试），策略是「允许，但只允许打回环 Host」。
 *   · **备份**：每次 save 的 `.bak-before-ui-<ts>` 轮转到最多 {@link BACKUP_KEEP} 份；
 *     preset 里一旦出现密钥样式（键名以 key/secret/token/password/credential 结尾，
 *     或值形如 `sk-…` / PEM 私钥），**不生成明文备份**，返回 `backupSkipped` 说明原因。
 *
 * 配置正确性（2026-10-30 实装，WS-UIAUDIT B4/B5/B6）：
 *   · **B4 不许撒谎**：`state.config` 与 `save.effectiveConfig` 给的是**引擎生效值**
 *     （缺失键补默认、非法值按 `engine.mjs` 规则净化、`retainRatio ≥ thresholdRatio` 那条修正也照做），
 *     文件里实际写了什么另走 `presetConfig`；每键来源在 `configOrigins`（preset/default/sanitized/adjusted），
 *     没写的键在 `unconfiguredKeys`。
 *   · **B5 空串不是 0**：数字字段收到 `""`/空白/`null` → 400「…不能为空」；
 *     非十进制字面量（`0x10`/`1e3`/`true`）→ 400「必须是数字」；越界 → 400「超出范围」。
 *     错误信息一律用中文字段名（{@link FIELD_LABELS}）。
 *   · **B6 不静默丢**：`save` 带白名单外的键 → **不写任何东西**，400 且响应体带 `skipped` 列表。
 *
 * 性能（2026-10-30 实装，P4）：
 *   · 首屏 `state` 原本对 133 个 `graph.json`（33MB）**全量 parse**，实测 342~400ms。
 *     现按 `(绝对路径, mtimeMs, size)` 缓存「聚合摘要」（只存 foldMarks / 计数，不存整图）；
 *     同一次请求里 `latest` 与 `today` 共用一次目录扫描；热路径 = 一次 readdir + N 次 stat。
 *   · 失效规则：mtime 或 size 任一变化即重读；坏图缓存「坏」；会话目录消失时清对应缓存。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
// ★ A2-1（2026-10-30）：preset 块格式的唯一定义在 R13 的 preset-format 子房间（src/rooms/）。
//   旧写法 import "../scripts/install.mjs" 是本仓库唯一的反向依赖（R-A 红点）。
import { parseEngineBlock, renderEngineBlock, ENTRY_ID, PKG_NAME } from "./rooms/preset-format.mjs";
// ★ A2-4（2026-10-30）：默认值/中文名/净化规则全部来自 R15（config-schema），页面不再各留一份。
import { configDefaults, fieldLabels, describeConfig as describeConfigFromSchema, validatePatch } from "./rooms/config-schema.mjs";

/**
 * 本文件所在目录（真实路径）。
 *
 * 为什么不用 `new URL(import.meta.url).pathname`：pathname 是**百分号编码**串
 * （`/D:/%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/…`），拼出来的路径在磁盘上不存在 ⇒
 * `readFileSync` ENOENT ⇒ `readVersion()` 的 catch 吞成 `null` ⇒ 页面标题渲染成 `v?`
 * （`lib/client.js:197` 的 `v${state?.version ?? "?"}`）。
 * `fileURLToPath` 是 Node 官方解码入口（空格 `%20`、中文、`~` 的 `%7E` 一并还原）。
 */
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

export const name = "dsh-gokifu-compact/ui";
export const inject = ["webServer"];

/** 与 engine.mjs 的 Config 保持一致的默认值（页面用来显示「默认」）。 */
/** 与 R15（config-schema）保持一致的默认值（页面用来显示「默认」）。 */
export const DEFAULTS = Object.freeze(configDefaults());
function resolveHome() {
  return process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home");
}

/** 找 preset 文件：优先含我们引擎行的那些；找不到就报错给页面。 */
export function findPresetFiles(home = resolveHome()) {
  const root = nodePath.join(home, "preset-bundles");
  if (!nodeFs.existsSync(root)) return [];
  const out = [];
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "cordis.patch.yml");
    if (!nodeFs.existsSync(file)) continue;
    const text = nodeFs.readFileSync(file, "utf8");
    if (text.includes(PKG_NAME) || text.includes("- id: compaction-basic")) {
      out.push({ name: entry.name, file, text });
    }
  }
  return out;
}

/* ─────────────────── 棋谱扫描/解析缓存（P4：首屏 state 性能） ───────────────────
 *
 * 现场（perf task-26）：live 132~133 个 graph.json / 33MB，首屏 state 一次要把它们**全部** parse 一遍
 * （todayAggregate），耗时 342~400ms，分解为 existsSync 76.5 + readFile 160.3 + JSON.parse 20.3 + 聚合 2.7。
 * 但 state 只在页面打开/保存后调用，绝大多数文件自上次调用以来根本没变 ⇒ 按 (path, mtimeMs, size) 缓存
 * 「解析后真正被用到的字段」，热路径只剩一次目录扫描 + 133 次 stat。
 *
 * 三条纪律：
 *   · 缓存值**只存聚合用得到的字段**（foldMarks / 计数），不存整张图 —— 133 张图全留会占上百 MB。
 *   · 坏图（JSON.parse 失败）也缓存"坏"这个事实，否则一个坏文件会每次被重新读一遍。
 *   · 同一个请求里 latestGraph 与 todayAggregate **共用一次扫描**（否则 readdir+stat 要跑两遍）。
 */
const GRAPH_CACHE = new Map();
const GRAPH_CACHE_MAX = 2000;

/** 目录扫描：{root, files:[{dir,file,mtimeMs,size}]}（不读文件内容）。 */
function collectGraphFiles(home = resolveHome()) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const files = [];
  let entries;
  try {
    entries = nodeFs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, files };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "graph.json");
    // throwIfNoEntry:false 比 existsSync+statSync 少一次系统调用（这条在 133 个会话上是真金白银）
    const stat = nodeFs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    files.push({ dir: entry.name, file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return { root, files };
}

/** 每个文件的聚合摘要缓存（key = 绝对路径 + mtimeMs + size）。 */
function graphSummary(entry) {
  const cached = GRAPH_CACHE.get(entry.file);
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) return cached;
  let summary = null;
  try {
    const g = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    summary = {
      foldMarks: g.foldMarks ?? [],
      foldCount: g.foldCount ?? 0,
      lastFoldTotalTokens: g.lastFoldTotalTokens ?? 0,
      checkpointSeq: g.checkpointSeq ?? null,
      lastFoldUsage: g.lastFoldUsage ?? null,
      failures: Object.values(g.edges ?? {}).filter((edge) => edge?.result === "failure").length,
      nodes: Object.keys(g.nodes ?? {}).length,
      edges: Object.keys(g.edges ?? {}).length,
    };
  } catch {
    summary = null; // 坏图：缓存「坏」这个事实，别每次重读
  }
  const row = { mtimeMs: entry.mtimeMs, size: entry.size, summary };
  if (GRAPH_CACHE.size >= GRAPH_CACHE_MAX) GRAPH_CACHE.clear();
  GRAPH_CACHE.set(entry.file, row);
  return row;
}

/** 丢掉已消失会话的缓存条目（只清当前 root 下的，别的 home 不动）。 */
function pruneGraphCache(root, files) {
  const alive = new Set(files.map((f) => f.file));
  const prefix = root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`;
  for (const key of GRAPH_CACHE.keys()) {
    if (key.startsWith(prefix) && !alive.has(key)) GRAPH_CACHE.delete(key);
  }
}

/** 最近活跃的棋谱（按 graph.json mtime）。 */
export function latestGraphFrom(scan) {
  const best = scan.files.reduce((acc, file) => (acc === null || file.mtimeMs > acc.mtimeMs ? file : acc), null);
  if (best === null) return null;
  const summary = graphSummary(best).summary;
  if (summary === null) return null;
  return {
    session: best.dir,
    updatedAt: best.mtimeMs,
    foldCount: summary.foldCount,
    totalAfter: summary.lastFoldTotalTokens,
    checkpointSeq: summary.checkpointSeq,
    lastFold: summary.foldMarks.length > 0 ? summary.foldMarks[summary.foldMarks.length - 1] : null,
    lastUsage: summary.lastFoldUsage,
    failures: summary.failures,
    nodes: summary.nodes,
    edges: summary.edges,
  };
}

/** 今天的 fold 汇总（按 foldMarks.at，不按文件 mtime）。 */
export function todayAggregateFrom(scan) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let folds = 0;
  let shadowed = 0;
  const sessions = new Set();
  let totalSessions = 0;
  let totalFailures = 0;
  for (const file of scan.files) {
    totalSessions += 1;
    const summary = graphSummary(file).summary;
    if (summary === null) continue;
    const marks = summary.foldMarks.filter((mark) => (mark.at ?? 0) >= from);
    if (marks.length > 0) {
      folds += marks.length;
      sessions.add(file.dir);
      shadowed += marks.reduce((sum, mark) => sum + (mark.shadowedTokens ?? 0), 0);
    }
    totalFailures += summary.failures;
  }
  return { folds, shadowed, sessions: sessions.size, totalSessions, totalFailures };
}

/** 一次扫描 + 清缓存，给同一个请求里的两个聚合用。 */
function scanGraphs(home = resolveHome()) {
  const scan = collectGraphFiles(home);
  pruneGraphCache(scan.root, scan.files);
  return scan;
}

/** 兼容旧调用点（单独调用 = 自己扫一次）。 */
function latestGraph(home = resolveHome()) {
  return latestGraphFrom(scanGraphs(home));
}

/** 兼容旧调用点（单独调用 = 自己扫一次）。 */
function todayAggregate(home = resolveHome()) {
  return todayAggregateFrom(scanGraphs(home));
}

/** 安装/单实例/摘要模型 三项体检（比 test/doctor.mjs 轻，够页面用）。 */
function health(home = resolveHome(), presets = findPresetFiles(home)) {
  const withOurs = presets.filter((p) => p.text.includes(ENTRY_ID));
  const withNative = presets.filter((p) => /^\s*- id: compaction-basic\s*$/m.test(p.text));
  const profilePkgFile = nodePath.join(home, "profiles", "desktop", "package.json");
  let profileOk = false;
  let inBundles = false;
  if (nodeFs.existsSync(profilePkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(profilePkgFile, "utf8"));
      profileOk = Boolean(pkg.dependencies?.[PKG_NAME]) || nodeFs.existsSync(nodePath.join(home, "profiles", "desktop", "node_modules", PKG_NAME));
      inBundles = (pkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
    } catch {
      /* ignore */
    }
  }
  return {
    installed: profileOk,
    mounted: withOurs.length > 0,
    singleInstance: withNative.length === 0,
    notInBundles: !inBundles,
    presets: presets.map((p) => ({ name: p.name, file: p.file })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON: ${String(error?.message ?? error)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/* ───────────────────────── 请求可信度（CSRF 防护） ───────────────────────── */

/** 每个 preset 最多保留几份 `.bak-before-ui-*`（轮转上限）。 */
export const BACKUP_KEEP = 5;
/** 备份文件名标记（保持旧命名，旧备份会被同一轮转逻辑收编）。 */
export const BACKUP_MARK = ".bak-before-ui-";

/** 键名以这些词结尾 ⇒ 视为密钥载体（注意 `headroomTokens` 之类复数不会被误判）。 */
const SECRET_KEY_RE = /(key|secret|password|passwd|credential|token)$/i;
/** 值层面的密钥样式（常见 token 前缀 + PEM 私钥头）。 */
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpsr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** 去掉 IPv6 的方括号并转小写，便于比较 Host 与 Origin。 */
function normalizeHostname(value) {
  return String(value ?? "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/** 补零到 4 位（IPv6 分组比较用）。 */
const pad16 = (part) => (part === "" ? "0" : part.padStart(4, "0"));

/**
 * 把主机名归一到可比较的形式：大小写不敏感 + IPv6 展开成 8 组定长。
 * `[::1]` 与 `[0:0:0:0:0:0:0:1]` 必须被当成同一台机器，否则 Host/Origin 比对会误判成跨源。
 * （只处理字面量，不做 DNS；内嵌 IPv4 的 `::ffff:1.2.3.4` 形式不展开，够用即可。）
 */
export function canonicalHostname(value) {
  const h = normalizeHostname(value);
  if (!h.includes(":")) return h;
  const [headText, tailText] = h.split("::");
  const head = headText === "" ? [] : headText.split(":");
  if (tailText === undefined) return head.map(pad16).join(":");
  const tail = tailText === "" ? [] : tailText.split(":");
  const zeros = Math.max(0, 8 - head.length - tail.length);
  return [...head, ...new Array(zeros).fill("0"), ...tail].map(pad16).join(":");
}

/** `::1` 的规范形（回环 IPv6）。 */
const LOOPBACK_V6 = canonicalHostname("::1");

/** `host:port` / `[::1]:port` → { hostname, port }；缺端口按 http 的 80 算。非法返回 null。 */
export function parseAuthority(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (m === null) return null;
  const hostname = canonicalHostname(m[1]);
  if (hostname === "") return null;
  const port = m[2] === undefined ? "80" : String(Number(m[2]));
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return { hostname, port };
}

/**
 * 回环主机名（含 localhost 子域、IPv4 127/8、IPv6 ::1 的各种写法）。
 * 注意：`[::1]`、`[0:0:0:0:0:0:0:1]`、`[::0:1]` 经 {@link canonicalHostname} 都归一到同一串。
 */
export function isLoopbackHostname(hostname) {
  const h = canonicalHostname(hostname);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === LOOPBACK_V6) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** content-type 必须是 application/json（允许带 charset 等参数）。 */
export function isJsonContentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return false;
  return /^application\/json\s*(;|$)/i.test(raw.trim());
}

/**
 * 判断一个 POST 是否来自可信调用方。
 *
 * 顺序：Host（防 rebinding）→ Sec-Fetch-Site（浏览器自报跨站直接拒）→ Origin（同源比对）。
 * 返回 `{ ok, status?, reason?, mode }`；`mode` 用于区分「浏览器同源」与「本机无 Origin 调用」。
 *
 * ⚠ **fail closed**（task-34）：服务器绑到 `0.0.0.0` 时**不会**因此放行任何 Host ——
 *   非回环 Host 只有在 `allowedHosts`（`DSH_GOKIFU_ALLOWED_HOSTS`）里显式列过才通过。
 *   否则「绑 0.0.0.0」就等于「任何域名只要解析到本机就能打这个写配置接口」（DNS rebinding）。
 *
 * @param {{headers?: Record<string, unknown>}} req
 * @param {{allowedHosts?: string[], boundAllInterfaces?: boolean}} [options]
 */
export function checkRequestTrust(req, options = {}) {
  const headers = req?.headers ?? {};
  const hostRaw = headers.host;
  const host = parseAuthority(hostRaw);
  if (host === null) return { ok: false, status: 403, reason: "缺少或非法的 Host 头", mode: "bad-host" };

  const allowedHosts = (options.allowedHosts ?? []).map(canonicalHostname);
  const explicitlyAllowed = allowedHosts.includes(host.hostname);
  const loopback = isLoopbackHostname(host.hostname);
  if (!loopback && !explicitlyAllowed) {
    const hint = options.boundAllInterfaces === true
      ? `服务器绑在 0.0.0.0 也不无条件放行：要放行请显式设 DSH_GOKIFU_ALLOWED_HOSTS=${host.hostname}`
      : "需要时设 DSH_GOKIFU_ALLOWED_HOSTS";
    return { ok: false, status: 403, reason: `拒绝非本机 Host：${host.hostname}（防 DNS rebinding；${hint}）`, mode: "untrusted-host" };
  }

  const site = Array.isArray(headers["sec-fetch-site"]) ? headers["sec-fetch-site"][0] : headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, reason: `拒绝跨站请求（sec-fetch-site: ${site}）`, mode: "cross-site" };
  }

  const originRaw = headers.origin;
  if (originRaw === undefined) {
    // 浏览器对 POST 必带 Origin（本机 Chromium 实测见文件头注释）⇒ 走到这里的是本机工具。
    return { ok: true, mode: "local-no-origin" };
  }
  const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
  if (typeof origin !== "string" || origin === "" || origin === "null") {
    return { ok: false, status: 403, reason: `拒绝非法 Origin：${String(origin)}`, mode: "bad-origin" };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, status: 403, reason: `非法 Origin：${origin}`, mode: "bad-origin" };
  }
  const originPort = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : String(Number(parsed.port));
  const originHost = canonicalHostname(parsed.hostname);
  if (explicitlyAllowed) {
    // 运营者显式放行的主机（DSH_GOKIFU_ALLOWED_HOSTS）：只比主机名 ——
    // 因为这种部署通常是「本机 http 被反代/隧道包成 https」，端口与协议在插件这侧看不到真值。
    if (originHost !== host.hostname) {
      return { ok: false, status: 403, reason: `跨源请求被拒（origin=${origin}，host=${String(hostRaw)}）`, mode: "cross-origin" };
    }
    return { ok: true, mode: "allowlisted-host" };
  }
  // DSH 的 webServer 是纯 node:http（无 TLS），所以默认路径只接受 http 同源。
  if (parsed.protocol !== "http:") {
    return { ok: false, status: 403, reason: `只接受 http 同源调用，收到 ${parsed.protocol}`, mode: "bad-origin" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, status: 403, reason: "Origin 不得带凭据", mode: "bad-origin" };
  }
  if (originHost !== host.hostname || originPort !== host.port) {
    return { ok: false, status: 403, reason: `跨源请求被拒（origin=${origin}，host=${String(hostRaw)}）`, mode: "cross-origin" };
  }
  return { ok: true, mode: "same-origin" };
}

/**
 * 找出一段 YAML 文本里的密钥样式内容。
 * **只返回键名，不回传值** —— 这个结果会进 HTTP 响应，值绝不能外泄。
 *
 * @param {string} text
 * @returns {string[]} 命中的键名（值层面的命中记为 `<value-pattern>`）
 */
export function findSecretLike(text) {
  const hits = [];
  const src = String(text ?? "");
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    if (!SECRET_KEY_RE.test(m[1])) continue;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    if (value === "" || value === "''" || value === '""' || value === "null" || value === "~") continue;
    hits.push(m[1]);
  }
  if (SECRET_VALUE_RE.test(src)) hits.push("<value-pattern>");
  return hits;
}

/** 列出某 preset 的备份（按时间戳升序）。 */
export function listBackups(presetFile) {
  const dir = nodePath.dirname(presetFile);
  const prefix = `${nodePath.basename(presetFile)}${BACKUP_MARK}`;
  let names;
  try {
    names = nodeFs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(prefix)).sort().map((n) => nodePath.join(dir, n));
}

/** 只保留最近 `keep` 份备份，返回被删掉的文件名。 */
export function pruneBackups(presetFile, keep = BACKUP_KEEP) {
  const backups = listBackups(presetFile);
  const removed = [];
  while (backups.length > keep) {
    const file = backups.shift();
    try {
      nodeFs.rmSync(file);
      removed.push(nodePath.basename(file));
    } catch {
      /* 删不掉就留着，下一次再试 */
    }
  }
  return removed;
}

/**
 * 中文键名 —— 错误信息里必须出现用户认得的名字，而不是 `tier2After` 这种配置键。
 * 与 `lib/client.js` 的 `FIELDS[].label` 保持一致（host 侧不能 import 浏览器半，只能各留一份；
 * `test/ui-config.test.mjs` 有一致性断言钉住这两份）。
 */
/**
 * 中文键名 —— 错误信息里必须出现用户认得的名字，而不是 `tier2After` 这种配置键。
 * 与 `lib/client.js` 的 `FIELDS[].label` 保持一致（host 侧不能 import 浏览器半，只能各留一份；
 * `test/ui-config.test.mjs` 有一致性断言钉住这两份）。
 */
export const FIELD_LABELS = Object.freeze(fieldLabels());
/**
 * 把 preset 里「实际写了什么」翻译成「引擎实际生效什么」。
 *
 * 为什么需要它（WS-UIAUDIT B4）：真实 preset 只有 14 个键，而引擎会给缺失键补默认值
 * （`engine.mjs` 的 `Config` 默认 + `resolveChess()` 兜底）。页面按「文件里有没有」渲染，
 * 就会把生效中的 `hotLedgerReplace: true` 显示成未勾选 —— 页面在撒谎。
 * 这里按引擎的规则算出生效值，并逐键标注来源（preset / default / sanitized / adjusted）。
 *
 * ⚠ 这是 `src/engine.mjs`（`Config` 默认值 + `resolveChess()`）的**镜像**，不是真实调用：
 *    ui.mjs 不能 import engine.mjs（那会拉起 dsh-compaction/llm 等 peer 依赖）。
 *    `test/ui-config.test.mjs` 有一条静态断言逐键比对 `DEFAULTS` 与 engine.mjs 的 schema 默认值，
 *    规则若有变动（例如再出现 4096/2048/8192 那种三处不一致）必须同步这里与那条测试。
 *
 * @param {Record<string, unknown>} presetConfig 从 preset 文本解析出来的原始键值
 * @returns {{effective: Record<string, unknown>, origins: Record<string, string>, unconfiguredKeys: string[]}}
 */
/**
 * 「preset 里写了什么 → 引擎实际生效什么」+ 逐键来源（default / preset / sanitized / adjusted）。
 * ★ A2-4：实现已搬到 R15（`config-schema.describeConfig`）—— 这里只保留导出名与返回形状，
 *   避免页面与引擎各算一套（那正是 `hotLedgerReplace` 显示成未勾选的起因）。
 */
export function describeConfig(presetConfig = {}) {
  return describeConfigFromSchema(presetConfig);
}
/**
 * 校验并规整页面提交的 patch。
 *
 * 两条硬规则（WS-UIAUDIT B5/B6）：
 *   · 数字字段：空串 / 空白 / null **不是 0** —— 直接报错，绝不静默写成 0（`Number("")===0` 的坑）。
 *     非十进制字面量（`0x10`、`1e3`、`true`）也拒。
 *   · 白名单外的键**不静默丢**：这里仍然只是收集到 `skipped`（纯函数好测），
 *     真正「不许静默」由 `saveConfig`（默认 strictKeys）与路由的 400 保证。
 */
/**
 * 校验并规整页面提交的 patch。
 *
 * 两条硬规则（WS-UIAUDIT B5/B6）：
 *   · 数字字段：空串 / 空白 / null **不是 0** —— 直接报错，绝不静默写成 0（`Number("")===0` 的坑）。
 *     非十进制字面量（`0x10`、`1e3`、`true`）也拒。
 *   · 白名单外的键**不静默丢**：收集到 `skipped`（纯函数好测），真正「不许静默」由 `saveConfig`
 *     与路由的 400 保证。
 *
 * ★ A2-4：规则与中文文案已搬到 R15（`config-schema.validatePatch`），这里只保留导出名与返回形状。
 */
export function sanitizePatch(patch) {
  return validatePatch(patch);
}
/**
 * 把 patch 写进 preset（带轮转备份；含密钥时不落明文备份）；返回改动清单 + 生效值。
 *
 * `strictKeys`（默认开） = WS-UIAUDIT B6 的修法：白名单外的键**不许静默丢弃**。
 * 抛出的错误对象上挂 `.skipped`，路由据此回 400 并把键名带回给页面 ——
 * 这样「提交了不支持的键」在现有页面（`client.js` 只渲染 `error` 文本）里也一定看得见。
 * 只有显式传 `{strictKeys:false}` 才退回旧行为（保留给离线批处理，仓库内无调用方）。
 */
export function saveConfig(patch, options = {}) {
  const home = options.home ?? resolveHome();
  const { patch: clean, skipped } = sanitizePatch(patch);
  if (skipped.length > 0 && options.strictKeys !== false) {
    const error = new Error(`不支持的配置键：${skipped.join("、")}（只有 ${Object.keys(DEFAULTS).length} 个已知键可以通过页面写入，这些键一个都没写）`);
    error.skipped = skipped;
    throw error;
  }
  for (const key of Object.keys(clean)) {
    if (SECRET_KEY_RE.test(key)) throw new Error(`含密钥的键不允许通过页面写入：${label(key)}`);
  }
  const presets = findPresetFiles(home).filter((p) => p.text.includes(ENTRY_ID));
  if (presets.length === 0) throw new Error(`没有找到含 ${ENTRY_ID} 的 preset（先跑 install）`);
  const changed = [];
  const pruned = [];
  let backup = null;
  let backupSkipped = null;
  let lastConfig = null;
  for (const preset of presets) {
    const parsed = parseEngineBlock(preset.text);
    if (parsed === null) continue;
    const next = { ...parsed.config, ...clean };
    lastConfig = next;
    const block = renderEngineBlock(next, parsed.indent, parsed.commentLines);
    const text = preset.text.replace(parsed.raw, block);
    if (text === preset.text) continue;
    // 密钥面：源文件里已有密钥样式 ⇒ 不复制整份文件（否则每个备份都是明文副本）。
    // 新块里出现源文件没有的密钥样式 ⇒ 直接拒绝写（防止页面把密钥带进来）。
    const secretInSource = findSecretLike(preset.text);
    const secretInNew = findSecretLike(block).filter((key) => !secretInSource.includes(key));
    if (secretInNew.length > 0) {
      throw new Error(`拒绝写入疑似密钥（${secretInNew.join("、")}）：密钥不得进 preset，也不得进备份`);
    }
    if (secretInSource.length > 0) {
      backupSkipped = {
        file: preset.file,
        keys: [...new Set(secretInSource)],
        reason: "preset 含疑似密钥，已跳过明文备份（旧备份也不会被这份密钥覆盖）",
      };
    } else {
      // 同一毫秒内多次保存（或一次保存命中多个 preset）时也不能互相覆盖。
      const stamp = `${Date.now()}`;
      let candidate = `${preset.file}${BACKUP_MARK}${stamp}`;
      let n = 1;
      while (nodeFs.existsSync(candidate)) {
        n += 1;
        candidate = `${preset.file}${BACKUP_MARK}${stamp}-${n}`;
      }
      backup = candidate;
      nodeFs.copyFileSync(preset.file, backup);
      pruned.push(...pruneBackups(preset.file, options.backupKeep ?? BACKUP_KEEP));
    }
    nodeFs.writeFileSync(preset.file, text, "utf8");
    changed.push(preset.file);
  }
  const described = describeConfig(lastConfig ?? {});
  return {
    changed,
    skipped,
    backup,
    backupSkipped,
    prunedBackups: pruned,
    restartRequired: changed.length > 0,
    // 写完之后「引擎会拿到的生效值」（关闭缺口 B4：页面据此显示真实生效值，而不是文件里有没有）
    effectiveConfig: described.effective,
    configOrigins: described.origins,
    unconfiguredKeys: described.unconfiguredKeys,
  };
}

export function apply(ctx) {
  // 绑定 0.0.0.0 = 本机之外也能访问。**这不构成放行理由**（task-34）：
  // 非回环 Host 仍然必须出现在 DSH_GOKIFU_ALLOWED_HOSTS 里，否则一律按不可信拒绝（fail closed）。
  // 这里的 boundAllInterfaces 只用于把 403 的文案写得更可操作。
  let boundAllInterfaces = false;
  try {
    boundAllInterfaces = String(ctx?.webServer?.host ?? "") === "0.0.0.0";
  } catch {
    boundAllInterfaces = false;
  }
  const allowedHosts = String(process.env.DSH_GOKIFU_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const route = {
    kind: "prefix",
    path: "/gokifu/api",
    handler: async (req, res) => {
      try {
        if (req.method === "OPTIONS") return sendJson(res, 204, {});
        if (req.method !== "POST") return sendJson(res, 405, { error: "只接受 POST" });
        const trust = checkRequestTrust(req, { allowedHosts, boundAllInterfaces });
        if (!trust.ok) return sendJson(res, trust.status ?? 403, { error: trust.reason, code: trust.mode });
        if (!isJsonContentType(req.headers?.["content-type"])) {
          return sendJson(res, 415, { error: "只接受 content-type: application/json", code: "bad-content-type" });
        }
        const body = await readBody(req);
        const action = String(body.action ?? "state");
        if (action === "state") {
          const home = resolveHome();
          const allPresets = findPresetFiles(home);
          const presets = allPresets.filter((p) => p.text.includes(ENTRY_ID));
          const parsed = presets.length > 0 ? parseEngineBlock(presets[0].text) : null;
          const presetConfig = parsed?.config ?? {};
          const described = describeConfig(presetConfig);
          // ★ P4：两个聚合共用一次目录扫描；解析结果按 (path, mtime, size) 命中缓存。
          const scan = scanGraphs(home);
          return sendJson(res, 200, {
            ok: true,
            version: readVersion(),
            // ★ B4：`config` 给的是**引擎生效值**（缺失键补默认、非法值按引擎规则净化）。
            //   页面直接渲染它就不会再把 true/semantic 显示成「未配置/空」。
            config: described.effective,
            // 文件里实际写了哪些键（诊断用；也是「哪些是用户显式设过」的事实来源）
            presetConfig,
            configOrigins: described.origins,
            unconfiguredKeys: described.unconfiguredKeys,
            defaults: DEFAULTS,
            fieldLabels: FIELD_LABELS,
            configFile: presets[0]?.file ?? null,
            latest: latestGraphFrom(scan),
            today: todayAggregateFrom(scan),
            health: health(home, allPresets),
          });
        }
        if (action === "defaults") return sendJson(res, 200, { ok: true, defaults: DEFAULTS, fieldLabels: FIELD_LABELS });
        if (action === "save") {
          const result = saveConfig(body.patch ?? {}, { home: resolveHome() });
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "health") {
          const home = resolveHome();
          const scan = scanGraphs(home);
          return sendJson(res, 200, { ok: true, health: health(home), latest: latestGraphFrom(scan), today: todayAggregateFrom(scan) });
        }
        return sendJson(res, 400, { error: `未知 action: ${action}` });
      } catch (error) {
        const payload = { error: String(error?.message ?? error) };
        // B6：白名单外的键必须可见 —— 键名跟着 400 回给页面。
        if (Array.isArray(error?.skipped) && error.skipped.length > 0) payload.skipped = error.skipped;
        return sendJson(res, 400, payload);
      }
    },
  };
  ctx.effect(() => ctx.webServer.register(route), "gokifu-ui: /gokifu/api");
}

function readVersion() {
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
