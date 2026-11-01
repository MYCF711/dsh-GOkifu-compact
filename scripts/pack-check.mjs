/**
 * pack-check.mjs —— 「npm 打包内容必须全部来自 git 跟踪文件」的机器检查（2026-11-02，C82）
 *
 * 为什么需要：发布路径是 `npm pack`，但开发时 `files` 白名单是**目录级**的 ——
 * 磁盘上任何一个没提交的新文档/证据都会被一起打进包里。历史上就出过
 * 「打包内容 ≠ 任何 commit（14 改 + 14 未跟踪）」的隐患（`docs/方案-持续优化.md` B4 ⛔）。
 *
 * 判据：`npm pack --dry-run --json` 的每个文件都必须在 `git ls-files` 里出现。
 *
 * ★ 一个坑（本轮实测踩到）：`git ls-files` 默认会把中文路径**转义成八进制**（`core.quotePath`），
 *   直接字符串比对会把 57 个中文文档全判成「未跟踪」。必须用
 *   `git -c core.quotePath=false ls-files -z` 或 `-z` + NUL 分隔。
 *
 * 用法：node scripts/pack-check.mjs [--json]   （只读：不生成 tarball，不写任何文件）
 * 退出码：0 全部有出处；1 有「打进包但 git 不跟踪」的文件。
 */

import { execFileSync, execSync } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 必须有出处的关键文件（缺一个就说明白名单/入口被改坏了）。 */
export const CRITICAL_FILES = ["src/ui.mjs", "src/engine.mjs", "src/rooms/ledger.mjs", "cordis.patch.yml", "scripts/cli.mjs", "lib/client.js"];

/**
 * 纯比较：把「包内文件」与「git 跟踪文件」对齐。
 * @returns {{packedCount:number, trackedCount:number, untracked:string[], missingCritical:string[], ok:boolean}}
 */
export function comparePack({ packed = [], tracked = [] } = {}) {
  const trackSet = new Set(tracked);
  const packSet = new Set(packed);
  const untracked = packed.filter((p) => !trackSet.has(p));
  const missingCritical = CRITICAL_FILES.filter((c) => !packSet.has(c));
  return {
    packedCount: packed.length,
    trackedCount: trackSet.size,
    untracked,
    missingCritical,
    ok: untracked.length === 0 && missingCritical.length === 0,
  };
}

function listTracked() {
  const out = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  return out.split("\u0000").filter(Boolean);
}

function listPacked() {
  // ★ Windows 上 npm 是 `npm.cmd`，execFileSync 直接调会 ENOENT —— 用 shell 跑一行命令。
  const out = execSync("npm pack --dry-run --json", { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first?.files ?? []).map((f) => f.path);
}

export function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const result = comparePack({ packed: listPacked(), tracked: listTracked() });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("== npm 打包出处检查（pack ⊆ git 跟踪）==");
    console.log(`  包内文件 ${result.packedCount} 个 / 跟踪文件 ${result.trackedCount} 个`);
    console.log(`  ${result.untracked.length === 0 ? "✓" : "✗"} 打进包但 git 不跟踪：${result.untracked.length} 个`);
    for (const p of result.untracked.slice(0, 10)) console.log(`    - ${p}`);
    console.log(`  ${result.missingCritical.length === 0 ? "✓" : "✗"} 关键文件齐全：${result.missingCritical.length === 0 ? CRITICAL_FILES.join(" · ") : `缺 ${result.missingCritical.join(", ")}`}`);
    console.log(`\n${result.ok ? "✅" : "❌"} ${result.ok ? "打包内容全部有出处（可从任意 commit 复现）" : "存在无出处文件 —— 发布前必须提交或从 files 白名单移除"}`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
