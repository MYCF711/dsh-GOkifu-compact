/**
 * build-stamp.mjs —— 「运行实例到底是哪一版代码」的落盘标记（2026-11-02，C34）
 *
 * 为什么需要：本机踩过两次同类陷阱 —— 磁盘上的插件代码已经更新，但**正在跑的进程还是旧代码**，
 * 于是新字段/新检查要等下一次重启才出现（C26 事故、以及 C30/C31 之后 doctor 的「未采集」）。
 * 光看磁盘文件或 package.json 都回答不了「现在跑的是哪版」。
 *
 * 做法：插件在**启动时**写 `<DSH_HOME>/chess-context/build.json`（版本 + 启动时间 + pid，一行小文件，
 * 与 profile patch 无关、不触发热重载）；doctor 读它并与仓库 package.json 比对 ⇒ 运行实例落后时直接报警。
 *
 * 纯函数 + 写盘，便于单测；所有写盘失败都静默返回 false（诊断设施不许影响压缩主路径）。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** 本仓 package.json 的版本（构建期常量，供写戳与自检共用）。 */
export function repoVersion() {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(nodeFs.readFileSync(file, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 本仓**构建标识**（2026-11-02，C53）：12 位十六进制，由 `package.json` 与 src 下所有 `.mjs` 的内容算出。
 *
 * 为什么版本号不够：semver 在整轮优化里一直停在 1.17.1，可磁盘代码每次提交都在变 ——
 * 只比版本号会把「运行实例是几小时前的代码」判成一致（实测：C44–C52 全部落盘，
 * doctor 仍显示「运行实例 v1.17.1 与磁盘一致」）。构建标识一比就能看出落后。
 */
export function repoBuildId(root = fileURLToPath(new URL("../..", import.meta.url))) {
  try {
    const files = [nodePath.join(root, "package.json")];
    const walk = (dir) => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".mjs")) files.push(full);
      }
    };
    walk(nodePath.join(root, "src"));
    const hash = nodeCrypto.createHash("sha256");
    for (const file of files.sort()) {
      hash.update(nodePath.relative(root, file));
      hash.update(nodeFs.readFileSync(file));
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

/**
 * 比较「运行实例的构建标识」与「磁盘当前构建标识」。
 * @returns {{state:"ok"|"stale"|"missing", running?:string, disk?:string}}
 */
export function compareBuildId(stamp, diskBuildId) {
  if (stamp === null || stamp === undefined) return { state: "missing", disk: diskBuildId };
  const running = typeof stamp.buildId === "string" ? stamp.buildId : "unknown";
  const disk = typeof diskBuildId === "string" ? diskBuildId : "unknown";
  if (running !== disk) return { state: "stale", running, disk };
  return { state: "ok", running, disk };
}

/** `dir/build.json` 的绝对路径（dir 传 `<home>/chess-context`；测试传临时目录）。 */
export function buildStampPath(dir) {
  return nodePath.join(String(dir ?? ""), "build.json");
}

/**
 * 启动时写戳（每次启动都重写：startedAt/pid 是「这一次进程」的事实）。
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeBuildStamp({ dir, version = repoVersion(), buildId = repoBuildId(), now = Date.now(), pid = process.pid } = {}) {
  try {
    if (typeof dir !== "string" || dir.trim() === "") return { ok: false, error: "no-dir" };
    // 只写**绝对路径**：相对路径会把 build.json 落到当前工作目录（实测：测试跑出了 test/build.json）。
    // 诊断设施宁可少写，也不许在仓库/测试目录里留垃圾。
    if (!nodePath.isAbsolute(dir)) return { ok: false, error: "not-absolute" };
    const file = buildStampPath(dir);
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${pid}`;
    nodeFs.writeFileSync(tmp, JSON.stringify({ schema: "gokifu/build-stamp/v1", version, buildId, startedAt: now, pid }, void 0, 2) + String.fromCharCode(10), "utf8");
    nodeFs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-11-05（真机事故）：戳可能是**已退出进程**写的
 *
 * 现场：`build.json` 里写着 pid 22508，而那个进程当晚早就没了；当前真正在跑的是 pid 4532。
 * 旧实现只做 `JSON.parse` 就把 stamp 当「运行实例的现状」交出去 ⇒ 所有据此判断
 * 「跑的是哪一版 / 面板活着吗」的诊断（checkup / doctor / accept-after-restart）都在
 * **拿死进程的旧值当真**：把「旧构建」误判成「功能 bug」，连续误判多次。
 *
 * 现在的口径：**不可信时明说不可信**。读戳必须校验写戳的 pid 是否还活着：
 *   · pid 活 ⇒ `state:"fresh"`、`usable:true`（可以据此判断运行版本）
 *   · pid 死 ⇒ `state:"stale"`、`stale:true`、`usable:false`（旧值**不许**当现值）
 *   · pid 缺失 / 探测出错 ⇒ `state:"unverifiable"`、`usable:false`（不知道就说不知道）
 *
 * 已知局限（写在这里免得下一个人重新踩）：pid 会被复用 —— 存活探测只能说「这个号有进程」，
 * 说不了「它是不是当初写戳的那个」。要更硬的证据得比对进程启动时间，那超出了这一层的范围。
 * ───────────────────────────────────────────────────────────────────────────── */

/** 有效 pid：正整数（`"22508"` 这种字符串也认，写盘方偶尔给字符串）。 */
function normalizePid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 进程是否还活着（只用 `process.kill(pid, 0)`，不起外部命令）。
 *
 * 语义（Windows 实测）：
 *   · 能发信号 ⇒ 活；
 *   · `EPERM` ⇒ 进程**存在**但没权限给它发信号（Windows 上 pid 4 / System 就是这种）⇒ 也算活；
 *   · 其余（`ESRCH` / `ERR_INVALID_ARG_TYPE` …）⇒ 死。
 *
 * @param {number|string} pid
 * @param {{kill?:(pid:number, signal:number)=>void}} [options] 测试注入用（默认 process.kill）
 * @returns {boolean}
 */
export function processIsAlive(pid, { kill = (target, signal) => process.kill(target, signal) } = {}) {
  const n = normalizePid(pid);
  if (n === null) return false;
  try {
    kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 旧口径的读法（原样保留）：返回原始 stamp 对象或 null，**不校验 pid**。 */
function readRawStamp(dir) {
  try {
    const file = buildStampPath(dir);
    if (!nodeFs.existsSync(file)) return null;
    const data = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    if (data === null || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/** 读一个 JSON 文件，并把「没有文件」与「文件坏了」分开（旧读法把两者都归成 null）。 */
function readJsonFile(file) {
  if (!nodeFs.existsSync(file)) return { status: "missing", value: null, path: file };
  try {
    const value = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", value: null, path: file };
    return { status: "ok", value, path: file };
  } catch {
    return { status: "invalid", value: null, path: file };
  }
}

/**
 * 读 stamp，并判断它**能不能**代表「现在在跑的是哪一版」。
 *
 * 两种调用方式（⚠ 向后兼容）：
 *   `readBuildStamp(dir)`            → 旧签名，返回原始 stamp 对象或 null（doctor.mjs、
 *                                     post-restart-check.mjs 仍这么用；本函数**不改变**它们的语义）
 *   `readBuildStamp({ dir, isAlive })` → 新签名，返回下面的判定对象
 *
 * @param {string|{dir?:string, isAlive?:(pid:number)=>boolean, now?:number}} target
 * @returns {{
 *   state:"fresh"|"stale"|"missing"|"invalid"|"unverifiable",
 *   stale:boolean, usable:boolean, path:string, dir:string,
 *   stamp:object|null, buildId:string|null, version:string|null,
 *   pid:number|null, pidAlive:boolean|null, startedAt:number|null, ageMs:number|null,
 *   reason:string
 * }} 新签名下：`stale:true` ⇔ 写戳的进程已退出（旧值不可当现值）；
 *    `usable:true` ⇔ 可以据此判断运行版本（只有 fresh 是）。
 */
export function readBuildStamp(target) {
  if (typeof target !== "object" || target === null) return readRawStamp(target);

  const { dir, isAlive = processIsAlive, now = Date.now() } = target;
  const file = buildStampPath(dir);
  const read = readJsonFile(file);
  const base = {
    path: file,
    dir: String(dir ?? ""),
    stamp: read.value,
    buildId: null,
    version: null,
    pid: null,
    pidAlive: null,
    startedAt: null,
    ageMs: null,
  };

  if (read.status === "missing") {
    return { ...base, state: "missing", stale: false, usable: false, reason: "没有 build.json（插件没写过戳，或版本早于该机制）" };
  }
  if (read.status === "invalid") {
    return { ...base, state: "invalid", stale: false, usable: false, reason: "build.json 不是合法 JSON（写盘可能中断）" };
  }

  const stamp = read.value;
  const buildId = typeof stamp.buildId === "string" && stamp.buildId !== "" ? stamp.buildId : null;
  const version = typeof stamp.version === "string" && stamp.version !== "" ? stamp.version : null;
  const pid = normalizePid(stamp.pid);
  // ⚠ `Number(null)` 是 0、`Number.isFinite(0)` 是 true ⇒ 必须先排除 null/0，否则「没写启动时间」会被当成 1970 年。
  const startedAt = Number.isFinite(Number(stamp.startedAt)) && Number(stamp.startedAt) > 0 ? Number(stamp.startedAt) : null;
  const ageMs = startedAt === null ? null : Math.max(0, Number(now) - startedAt);
  const filled = { ...base, buildId, version, pid, startedAt, ageMs };

  if (pid === null) {
    return { ...filled, state: "unverifiable", stale: false, usable: false, reason: "stamp 里没有可用的 pid，无法校验写它的进程是否还活着" };
  }

  let alive;
  try {
    alive = Boolean(isAlive(pid));
  } catch {
    alive = null;
  }
  if (alive === false) {
    return {
      ...filled,
      state: "stale",
      stale: true,
      usable: false,
      pidAlive: false,
      reason: `stamp 是 pid ${pid} 写的，那个进程已退出；无法据此判断运行版本`,
    };
  }
  if (alive === null) {
    return {
      ...filled,
      state: "unverifiable",
      stale: false,
      usable: false,
      pidAlive: null,
      reason: `pid ${pid} 的存活性探测出错，无法校验写这个 stamp 的进程是否还活着`,
    };
  }
  return { ...filled, state: "fresh", stale: false, usable: true, pidAlive: true, reason: `stamp 由 pid ${pid} 写、该进程仍存活` };
}

/** `dir/ui-route.json` 的绝对路径（dir 传 `<home>/chess-context`；测试传临时目录）。 */
export function uiRoutePath(dir) {
  return nodePath.join(String(dir ?? ""), "ui-route.json");
}

/**
 * 读面板心跳（`ui-route.json`），同样**校验写它的 pid**：心跳里的端口/state 可能属于
 * 一个早就退出的进程（真机：heartbeat 写着 pid 22508 / 端口 64535，而 64535 无人监听）。
 *
 * 返回形状与 `readBuildStamp({dir,isAlive})` 同构：
 * `{state, stale, usable, path, dir, heartbeat, pid, pidAlive, port, routeState, at, ageMs, reason}`
 * `state` ∈ `fresh | stale | missing | invalid | unverifiable`。
 *
 * @param {{dir?:string, isAlive?:(pid:number)=>boolean, now?:number}} [target]
 */
export function readUiRouteHeartbeat(target = {}) {
  const { dir, isAlive = processIsAlive, now = Date.now() } = target ?? {};
  const file = uiRoutePath(dir);
  const read = readJsonFile(file);
  const base = { path: file, dir: String(dir ?? ""), heartbeat: read.value, pid: null, pidAlive: null, port: null, routeState: null, at: null, ageMs: null };

  if (read.status === "missing") {
    return { ...base, state: "missing", stale: false, usable: false, reason: "没有 ui-route.json（该实例没写过面板心跳）" };
  }
  if (read.status === "invalid") {
    return { ...base, state: "invalid", stale: false, usable: false, reason: "ui-route.json 不是合法 JSON（写盘可能中断）" };
  }

  const heartbeat = read.value;
  const pid = normalizePid(heartbeat.pid);
  const rawPort = Number(heartbeat.port);
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;
  const routeState = typeof heartbeat.state === "string" ? heartbeat.state : null;
  // 同上：`at:null` 不许被当成 1970 年（那会让「多久前」变成一个巨大的假数）。
  const at = Number.isFinite(Number(heartbeat.at)) && Number(heartbeat.at) > 0 ? Number(heartbeat.at) : null;
  const ageMs = at === null ? null : Math.max(0, Number(now) - at);
  const filled = { ...base, heartbeat, pid, port, routeState, at, ageMs };

  if (pid === null) {
    return { ...filled, state: "unverifiable", stale: false, usable: false, reason: "心跳里没有可用的 pid，无法校验写它的进程是否还活着" };
  }

  let alive;
  try {
    alive = Boolean(isAlive(pid));
  } catch {
    alive = null;
  }
  if (alive === false) {
    return { ...filled, state: "stale", stale: true, usable: false, pidAlive: false, reason: `心跳过期：ui-route.json 是 pid ${pid} 写的，那个进程已退出` };
  }
  if (alive === null) {
    return { ...filled, state: "unverifiable", stale: false, usable: false, pidAlive: null, reason: `pid ${pid} 的存活性探测出错，无法校验这份心跳是否还新鲜` };
  }
  return { ...filled, state: "fresh", stale: false, usable: true, pidAlive: true, reason: `心跳新鲜：pid ${pid} 仍存活` };
}

/**
 * 比较「运行实例」与「磁盘代码」。
 * @returns {{state:"ok"|"stale"|"missing", running?:string, disk:string, startedAt?:number}}
 */
export function compareBuildStamp(stamp, diskVersion) {
  if (stamp === null || stamp === undefined) return { state: "missing", disk: diskVersion };
  const running = typeof stamp.version === "string" ? stamp.version : "unknown";
  if (running !== diskVersion) return { state: "stale", running, disk: diskVersion, startedAt: stamp.startedAt };
  return { state: "ok", running, disk: diskVersion, startedAt: stamp.startedAt };
}
