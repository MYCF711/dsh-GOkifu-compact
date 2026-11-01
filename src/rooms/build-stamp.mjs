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

/** 读戳；没有/坏文件都返回 null（doctor 自己决定怎么报「未采集」）。 */
export function readBuildStamp(dir) {
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
