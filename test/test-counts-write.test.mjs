/**
 * test-counts-write.test.mjs —— `--write` 不许丢掉 passed（C603）
 *
 * 由来：这个坑我自己踩过三次。`node scripts/test-counts.mjs --write` 会把
 * `counts-baseline.json` 重写成 `{total, files}`，**丢掉 `passed`/`passedAt`** ⇒
 *   ① C485（HANDOFF 的「全量 N passed」与实测一致）退化成**软绿**；
 *   ② `sync-doc-numbers` 读不到权威值，只能报「源缺失，不猜」。
 * 两边都**静默失效**，没有任何红灯。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
export const tests = {};

tests["C603 --write 保留 passed/passedAt（否则 C485 与 doc-numbers 双双静默失效）"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "tc-"));
  const baseline = nodePath.join(dir, "counts-baseline.json");
  nodeFs.writeFileSync(baseline, JSON.stringify({ passed: 1234, passedAt: "2026-01-01T00:00:00Z", total: 1, files: {} }), "utf8");
  // 用 `--write` 走真实入口（脚本内部用固定 BASELINE 常量，这里改成先备份再还原）
  const real = nodePath.join(ROOT, "test", "counts-baseline.json");
  const backup = nodeFs.readFileSync(real, "utf8");
  try {
    nodeFs.writeFileSync(real, nodeFs.readFileSync(baseline, "utf8"), "utf8");
    execFileSync(process.execPath, [nodePath.join(ROOT, "scripts", "test-counts.mjs"), "--write"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    const after = JSON.parse(nodeFs.readFileSync(real, "utf8"));
    t.eq(after.passed, 1234, "passed 必须原样保留");
    t.eq(after.passedAt, "2026-01-01T00:00:00Z", "passedAt 也必须保留");
    t.eq(Number(after.total) > 0, true, "total 仍然要写");
  } finally {
    nodeFs.writeFileSync(real, backup, "utf8");
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};
