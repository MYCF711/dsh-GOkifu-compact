#!/usr/bin/env node
/**
 * p6c-preflight.mjs —— P6-C 停窗预检（**只读**；不写 live、不启停 DSH）
 *
 * 用途：在主人给「停窗授权」之后、真正 `--apply` 之前，确认这个窗口是安全的：
 *   ① DSH 是否真的停了（端口 19387 连不上 + 进程列表里没有桌面实例）；
 *   ② live 会话有多少、`graph.json` 的总字节与**只对 graph.json 的哈希**（作为 apply 前后的对账基线）；
 *   ③ live profile 的 mtime / sha256（确认停窗期间没人动配置）；
 *   ④ 备份盘空间是否够（备份 = 整目录拷贝，估算 ≥ 会话树大小的 1.2 倍且 ≥ 30MB）。
 *
 * 判据：检测到 DSH 仍在运行 ⇒ **拒绝 apply 预检**（exit 1）。
 * 本脚本**没有任何写操作**：不建目录、不写文件、不改 mtime；只 stat / read / 连端口 / 列进程。
 *
 * 用法：
 *   node scripts/p6c-preflight.mjs                 # 人类可读
 *   node scripts/p6c-preflight.mjs --json          # 机器可读（对账基线可存档）
 *   node scripts/p6c-preflight.mjs --root=<sessionsRoot> --port=0 --proc-name=   # 夹具/只读模式
 *
 * 退出码：0 = 可以开窗（ready）；1 = 不可以（DSH 在跑 / 空间不足 / 会话根不存在）；2 = 参数错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeNet from "node:net";
import nodeCrypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { sessionsRoot, backupsRoot } from "../src/rooms/migrate.mjs";

const DEFAULT_PORT = 19387;
const DEFAULT_PROC = "DeepSeek Harness.exe";
const DEFAULT_MIN_FREE_MB = 30;

function parseArgs(argv) {
  const opts = { root: sessionsRoot(), backupRoot: backupsRoot(), port: DEFAULT_PORT, procName: DEFAULT_PROC, minFreeMb: DEFAULT_MIN_FREE_MB, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--backup-root=")) opts.backupRoot = arg.slice("--backup-root=".length);
    else if (arg.startsWith("--port=")) opts.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--proc-name=")) opts.procName = arg.slice("--proc-name=".length);
    else if (arg.startsWith("--min-free-mb=")) opts.minFreeMb = Number(arg.slice("--min-free-mb=".length));
    else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.port) || opts.port < 0) {
    console.error("--port 需要一个 >=0 的整数（0 = 跳过端口检查）");
    process.exit(2);
  }
  if (!Number.isFinite(opts.minFreeMb) || opts.minFreeMb < 0) {
    console.error("--min-free-mb 需要一个 >=0 的数字");
    process.exit(2);
  }
  return opts;
}

/** 端口是否有人监听（只连一下，不发数据）。 */
function portOpen(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = nodeNet.connect({ host: "127.0.0.1", port, timeout: 800 });
    const done = (value) => {
      sock.destroy();
      resolve(value);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * 当前用户可见的同名进程数（Windows 用 tasklist /FO CSV；其它平台不适用）。
 *
 * ⚠ 为什么必须用 CSV 而不是默认表格格式（2026-10-31 实测，P6-C 停窗流程因此完全卡死）：
 * `tasklist` 在**没有匹配进程**时会打印一行**本地化提示** —— 中文系统是
 * 「信息: 没有运行的任务匹配指定标准。」。默认表格格式下这一行既不是空行、
 * 也不以 `INFO:` 开头（`INFO:` 只出现在英文系统），而 `spawnSync(..., encoding:"utf8")`
 * 会把 GBK 字节解成 U+FFFD，于是旧逻辑的过滤条件全部放行 ⇒ 把它算成 **1 个进程**
 * ⇒ `running = portOpen || count > 0` 恒为 true ⇒ **预检永远拒绝**。
 * 实测现场：主人已完全退出桌面实例（`portOpen=false`），预检却报 `procCount=1`
 * 并 exit 1，脚本窗口显示「退出码 1」。
 *
 * CSV 模式下**匹配到的进程行一定以 `"` 开头**，本地化提示行不会，因此计数可靠；
 * 再按映像名（第一个 CSV 字段）复核一次，双重保险。
 */
function processCount(name) {
  if (process.platform !== "win32" || !name) return { applicable: process.platform === "win32", count: 0 };
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  if (r.status !== 0) return { applicable: true, count: 0, error: String(r.stderr ?? "").trim() };
  const want = name.toLowerCase();
  const count = String(r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .filter((l) => l.slice(1, 1 + want.length).toLowerCase() === want).length;
  return { applicable: true, count };
}

function sha256(buf) {
  return nodeCrypto.createHash("sha256").update(buf).digest("hex");
}

/** 扫描会话根：会话数、graph.json 字节、**只对 graph.json 的哈希**、delta 文件数。只读。 */
function scanSessions(root) {
  if (!nodeFs.existsSync(root)) return { root, exists: false, count: 0, graphBytes: 0, deltaFiles: 0, totalBytes: 0, combined: null, perSession: [] };
  const dirs = nodeFs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => nodePath.join(root, d.name))
    .filter((dir) => nodeFs.existsSync(nodePath.join(dir, "graph.json")))
    .sort();
  const perSession = [];
  let graphBytes = 0;
  let deltaFiles = 0;
  let totalBytes = 0;
  for (const dir of dirs) {
    const graphFile = nodePath.join(dir, "graph.json");
    const buf = nodeFs.readFileSync(graphFile); // 只读
    const bytes = buf.length;
    graphBytes += bytes;
    const deltaFile = `${graphFile}.delta.jsonl`;
    if (nodeFs.existsSync(deltaFile)) deltaFiles += 1;
    let sessionBytes = bytes;
    if (nodeFs.existsSync(deltaFile)) sessionBytes += nodeFs.statSync(deltaFile).size;
    totalBytes += sessionBytes;
    perSession.push({ id: nodePath.basename(dir), sha256: sha256(buf), bytes });
  }
  // 汇总哈希：按会话 id 排序后逐行 `<id> <sha256>` —— 只含 graph.json，不含 delta（delta 一直在动）。
  const combined = sha256(perSession.map((x) => `${x.id} ${x.sha256}`).join("\n"));
  return { root, exists: true, count: dirs.length, graphBytes, deltaFiles, totalBytes, combined, perSession };
}

function checkProfile(profileFile) {
  if (!nodeFs.existsSync(profileFile)) return { path: profileFile, exists: false };
  const st = nodeFs.statSync(profileFile);
  return { path: profileFile, exists: true, mtime: new Date(st.mtimeMs).toISOString(), bytes: st.size, sha256: sha256(nodeFs.readFileSync(profileFile)) };
}

/** 备份盘空间：从备份目录（不存在就向上找已存在的祖先）取 statfs。 */
function checkBackup(backupRoot, sessionBytes, minFreeMb) {
  let probe = nodePath.resolve(backupRoot);
  while (!nodeFs.existsSync(probe)) {
    const parent = nodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const requiredBytes = Math.max(Math.ceil(minFreeMb * 1024 * 1024), Math.ceil(sessionBytes * 1.2));
  try {
    const st = nodeFs.statfsSync(probe);
    const freeBytes = Number(st.bsize) * Number(st.bavail);
    return { dir: backupRoot, probe, exists: nodeFs.existsSync(backupRoot), freeBytes, requiredBytes, ok: freeBytes >= requiredBytes };
  } catch (error) {
    return { dir: backupRoot, probe, exists: nodeFs.existsSync(backupRoot), freeBytes: null, requiredBytes, ok: false, error: String(error?.message ?? error) };
  }
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`p6c-preflight —— P6-C 停窗预检（只读）
  node scripts/p6c-preflight.mjs [--json] [--root=<sessionsRoot>] [--backup-root=<dir>]
                                 [--port=${DEFAULT_PORT}|0] [--proc-name="${DEFAULT_PROC}"] [--min-free-mb=${DEFAULT_MIN_FREE_MB}]

退出码：0 = 可以开窗；1 = 不可以（DSH 在跑 / 空间不足 / 会话根不存在）；2 = 参数错误。
本脚本只读：不写 live、不建目录、不启停 DSH。`);
    return 0;
  }

  const portIsOpen = await portOpen(opts.port);
  const proc = processCount(opts.procName);
  const running = portIsOpen || proc.count > 0;
  const sessions = scanSessions(opts.root);
  const profileFile = nodePath.join(nodePath.dirname(nodePath.dirname(opts.root)), "profiles", "desktop", "cordis.patch.yml");
  const profile = checkProfile(profileFile);
  const backup = checkBackup(opts.backupRoot, sessions.totalBytes, opts.minFreeMb);
  const sessionsOk = sessions.exists && sessions.count > 0;
  const ready = !running && sessionsOk && backup.ok;

  const result = {
    ok: ready,
    ready,
    checkedAt: new Date().toISOString(),
    runtime: { port: opts.port, portOpen: portIsOpen, procName: opts.procName, procCount: proc.count, procApplicable: proc.applicable, running },
    sessions,
    profile,
    backup,
    verdict: ready
      ? "可以开窗：DSH 未运行、会话根可读、备份空间足够"
      : running
        ? `拒绝 apply 预检：检测到 DSH 正在运行（${portIsOpen ? `端口 ${opts.port} 可连接` : "端口未开放"}${proc.count > 0 ? `；进程 ${proc.count} 个` : ""}）—— 先完全退出桌面实例（含托盘），再重跑本预检`
        : !sessionsOk
          ? `拒绝 apply 预检：会话根不存在或为空（${opts.root}）`
          : `拒绝 apply 预检：备份空间不足（需要 ${fmtBytes(backup.requiredBytes)}，可用 ${fmtBytes(backup.freeBytes)}）`,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 1));
    return ready ? 0 : 1;
  }

  const mark = (okv) => (okv ? "✓" : "✗");
  console.log(`== P6-C 停窗预检 · ${result.checkedAt} ==`);
  console.log(`会话根 : ${sessions.root}`);
  console.log(`${mark(!running)} DSH 运行态：端口 ${opts.port || "(跳过)"} ${portIsOpen ? "可连接" : "不可连接"}；进程 ${opts.procName || "(跳过)"} ${proc.count} 个`);
  console.log(`${mark(sessionsOk)} 会话数：${sessions.count}（graph.json ${fmtBytes(sessions.graphBytes)}；delta 文件 ${sessions.deltaFiles} 个；合计 ${fmtBytes(sessions.totalBytes)}）`);
  console.log(`  graph.json-only sha256：${sessions.combined ?? "(无会话)"}`);
  console.log(`${mark(profile.exists)} profile：${profile.path}${profile.exists ? `（mtime ${profile.mtime}，sha256 ${profile.sha256.slice(0, 16)}…）` : "（不存在）"}`);
  console.log(`${mark(backup.ok)} 备份盘：${backup.dir}${backup.exists ? "" : "（尚未创建，apply 时自动建）"}，可用 ${fmtBytes(backup.freeBytes)} / 需要 ${fmtBytes(backup.requiredBytes)}`);
  if (backup.error) console.log(`  备份空间检查错误：${backup.error}`);
  console.log(`\n${ready ? "✓ 可以开窗" : "✗ 不可以开窗"}：${result.verdict}`);
  return ready ? 0 : 1;
}

process.exitCode = await main();
