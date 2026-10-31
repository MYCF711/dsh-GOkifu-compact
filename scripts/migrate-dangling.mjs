#!/usr/bin/env node
/**
 * migrate-dangling.mjs —— P6-C 悬空边 sidecar 归档 CLI（R10 调用 R14）
 *
 * 逻辑全在 `src/rooms/migrate.mjs`（R14）；本文件只做参数解析、输出与退出码。
 * 也可以经 `dsh-gokifu-compact migrate-dangling …` 进入（`scripts/cli.mjs` 转发）。
 *
 * 用法：
 *   node scripts/migrate-dangling.mjs                        # dry-run（默认，不写任何文件）
 *   node scripts/migrate-dangling.mjs --json                 # dry-run + JSON
 *   node scripts/migrate-dangling.mjs --apply                # 真执行（先整目录备份；120s 新鲜度守卫）
 *   node scripts/migrate-dangling.mjs --verify --backup=<dir>  # 只读校验
 *   node scripts/migrate-dangling.mjs --rollback=<dir>       # 从备份逐字恢复
 *   node scripts/migrate-dangling.mjs --merge-sidecar=<file|dir>          # 回灌 sidecar（默认 dry-run）
 *   node scripts/migrate-dangling.mjs --merge-sidecar=<file|dir> --apply  # 真回灌（备份到 --backup-dir）
 *   --root=<sessionsRoot>  --backup-dir=<dir>  --now=<epochMs>
 *
 * 退出码：0 正常；1 校验失败/执行失败；2 参数错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { dryRun, apply, verify, rollback, mergeMany, sessionsRoot, backupsRoot } from "../src/rooms/migrate.mjs";

function parseArgs(argv) {
  const opts = { mode: "dry-run", json: false, force: false, only: null, root: sessionsRoot(), backupRoot: backupsRoot(), backupDir: "", mergeTarget: "", now: Date.now() };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.mode = "dry-run";
    else if (arg === "--apply") { opts.applyMerge = true; if (!opts.mergeTarget) opts.mode = "apply"; }
    else if (arg === "--force") opts.force = true;
    else if (arg === "--verify") opts.mode = "verify";
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--backup-dir=")) opts.backupRoot = arg.slice("--backup-dir=".length);
    else if (arg.startsWith("--backup=")) opts.backupDir = arg.slice("--backup=".length);
    else if (arg.startsWith("--rollback=")) {
      opts.mode = "rollback";
      opts.backupDir = arg.slice("--rollback=".length);
    } else if (arg.startsWith("--merge-sidecar=")) {
      opts.mode = "merge";
      opts.mergeTarget = arg.slice("--merge-sidecar=".length);
      if (opts.mergeTarget.length === 0) {
        console.error("--merge-sidecar= 需要一个 sidecar 文件或会话目录");
        process.exit(2);
      }
    } else if (arg.startsWith("--sessions=")) {
      opts.only = arg.slice("--sessions=".length).split(",").map((x) => x.trim()).filter(Boolean);
    } else if (arg.startsWith("--now=")) opts.now = Number(arg.slice("--now=".length));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`migrate-dangling —— P6-C 悬空边 sidecar 归档工具（R14）
  node scripts/migrate-dangling.mjs [--dry-run] [--root=<sessionsRoot>] [--json]   # dry-run（默认）
  --sessions=<a,b>  只处理指定会话；--force  跳过 apply 的 120s 新鲜度守卫（危险）
  node scripts/migrate-dangling.mjs --apply [--force]                   # 执行（整目录备份 + 120s 新鲜度守卫）
  node scripts/migrate-dangling.mjs --verify --backup=<backupDir>       # 只读校验
  node scripts/migrate-dangling.mjs --rollback=<backupDir>              # 从备份恢复
  node scripts/migrate-dangling.mjs --merge-sidecar=<file|dir> [--apply] [--backup-dir=<dir>]
        # 回灌 sidecar：默认 dry-run（只报告将合并几条）；--apply 才写（先备份 graph.json/index.md）

默认路径：<DSH_HOME>/chess-context/sessions ；备份：<DSH_HOME>/chess-context/migrate-backups`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  let code = 0;
  try {
    if (opts.mode === "dry-run") {
      result = dryRun(opts.root, { now: opts.now, only: opts.only });
    } else if (opts.mode === "apply") {
      result = apply(opts.root, { now: opts.now, backupRoot: opts.backupRoot, only: opts.only, maxAgeMs: opts.force ? 0 : undefined });
    } else if (opts.mode === "merge") {
      result = mergeMany(opts.mergeTarget, { apply: opts.applyMerge, backupRoot: opts.backupRoot, now: opts.now });
      if (!result.ok) code = 1;
    } else if (opts.mode === "merge") {
    console.log(`== migrate-dangling ${result.mode} ==`);
    console.log(`target: ${result.target}`);
    console.log(`sessions: ${result.sessions}｜merged ${result.merged}｜skipped ${result.skipped}`);
    if (result.backupDirs.length) console.log(`backup: ${result.backupDirs.join(", ")}`);
    if (result.errors.length) console.log(`errors:\n- ${result.errors.join("\n- ")}`);
    if (!opts.applyMerge) console.log("（dry-run：什么都没写；加 --apply 才回灌）");
  } else if (opts.mode === "verify") {
      result = verify(opts.root, { now: opts.now, backupDir: opts.backupDir, only: opts.only });
      if (!result.ok) code = 1;
    } else {
      result = rollback(opts.backupDir);
    }
  } catch (error) {
    console.error(`✗ ${String(error?.message ?? error)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 1));
  } else if (opts.mode === "dry-run") {
    console.log("== migrate-dangling dry-run ==");
    console.log(`root: ${result.root}`);
    console.log(`sessions: ${result.sessions}（affected ${result.affectedSessions}）`);
    console.log(`residue（将归档）: ${result.residue}`);
    console.log(`candidates（保留，P6C-1）: ${result.candidates}`);
    console.log(`liveUnsettled: ${result.liveUnsettled}（保留）`);
    console.log(`fromBroken: ${result.fromBroken}（保留）`);
    console.log(`sidecar edges: ${result.sidecarEdges}`);
    console.log(`graph bytes: ${result.graphBytesBefore} → ${result.graphBytesAfter}（${result.deltaBytes}）`);
    if (result.badGraphs.length) console.log(`坏图 ${result.badGraphs.length} 个：${result.badGraphs.map((b) => `${b.session}(${b.reason})`).join("; ")}`);
  } else if (opts.mode === "verify") {
    console.log(
      result.ok
        ? `✓ verify ok：sidecar ${result.sidecarEdges} 条 / residue ${result.residue} / candidates ${result.candidates} / fromBroken ${result.fromBroken}`
        : `✗ verify 失败：${result.problems.join("; ")}`,
    );
    if (result.badGraphs.length) console.log(`坏图 ${result.badGraphs.length} 个：${result.badGraphs.map((b) => b.session).join(", ")}`);
  } else {
    console.log(JSON.stringify(result, null, 1));
  }
  process.exit(code);
}

/** 只在被直接执行时跑 main（被 import 时保持安静）。 */
const direct = process.argv[1] && nodePath.basename(process.argv[1]) === "migrate-dangling.mjs" && nodeFs.existsSync(process.argv[1]);
if (direct) main();