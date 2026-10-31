/**
 * all.mjs —— 一键全量验证（不重启 DSH 的所有可跑项）
 * 用法：node test/all.mjs
 *
 * ★ TEST-GATE（task-149）：**只按子进程退出码判失败**。
 *   旧版用 `/failed|✗/` 正则猜输出 —— 测试名里可能含字面 `✗`（例如
 *   `✓ S10c-3 manifestError 进 ✗ 详情…`），既可能误报（把绿当红）也可能漏报
 *   （子进程真失败但输出恰好吃不到关键字）。退出码才是唯一权威。
 *
 *   子步骤超时 / 起不来 / 抛异常 ⇒ 一律算失败（不许当成「没输出=没事」）。
 */

import { execFileSync } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 默认步骤（导出给测试与文档用）。 */
export const STEPS = [
  ["单测", ["test/run.mjs"]],
  ["挂载校验", ["test/verify-install.mjs"]],
  ["真实模块", ["test/real-modules.mjs"]],
  ["真实事务", ["test/real-fold.mjs"]],
  ["性能基准", ["test/bench.mjs", "2000"]],
];

/**
 * 一个子步骤算不算通过。**唯一判据 = 退出码 0**（`status === 0`）。
 * @param {{status?:number|null, timedOut?:boolean, spawnError?:any}} result
 * @returns {boolean}
 */
export function stepPassed(result) {
  if (result === null || result === undefined) return false;
  if (result.timedOut === true) return false;
  if (result.spawnError) return false;
  return result.status === 0;
}

/**
 * 跑一个子步骤，返回 `{name, status, passed, output, timedOut}`（不抛 —— 全部收敛成结果）。
 * @param {string} name
 * @param {string[]} args
 * @param {{cwd?:string, timeout?:number, exec?:Function}} [options]
 */
export function runStep(name, args, { cwd = ROOT, timeout = 300_000, exec = execFileSync } = {}) {
  try {
    const output = exec(process.execPath, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    return { name, status: 0, passed: true, output: String(output ?? ""), timedOut: false };
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : null;
    const timedOut = Boolean(error?.signal) || String(error?.code ?? "") === "ETIMEDOUT";
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    return { name, status, passed: stepPassed({ status, timedOut, spawnError: status === null }), output, timedOut };
  }
}

/** 汇总：全部通过才 true。 */
export function allPassed(results) {
  return results.every((r) => r.passed === true);
}

async function main() {
  const results = [];
  for (const [name, args] of STEPS) {
    process.stdout.write(`\n===== ${name} =====\n`);
    const result = runStep(name, args);
    const tail = result.output.trim().split("\n").slice(-3).join("\n");
    console.log(tail);
    if (!result.passed) console.log(`✗ ${name} 退出码 ${result.status === null ? "(起不来/超时)" : result.status}`);
    results.push(result);
  }
  const bad = results.filter((r) => !r.passed).length;
  console.log(allPassed(results) ? "\n== 全部通过 ==" : `\n== ${bad} 组失败 ==`);
  if (!allPassed(results)) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
