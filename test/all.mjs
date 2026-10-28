/**
 * all.mjs —— 一键全量验证（不重启 DSH 的所有可跑项）
 * 用法：node test/all.mjs
 */
import { execFileSync } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const steps = [
  ["单测", ["test/run.mjs"]],
  ["挂载校验", ["test/verify-install.mjs"]],
  ["真实模块", ["test/real-modules.mjs"]],
  ["真实事务", ["test/real-fold.mjs"]],
  ["性能基准", ["test/bench.mjs", "2000"]],
];
let bad = 0;
for (const [name, args] of steps) {
  process.stdout.write(`\n===== ${name} =====\n`);
  try {
    const out = execFileSync(process.execPath, args, { cwd: nodePath.join(HERE, ".."), encoding: "utf8", timeout: 300_000 });
    const tail = out.trim().split("\n").slice(-3).join("\n");
    console.log(tail);
    if (/failed|✗|== [1-9]\d* 项失败/.test(out) && !/0 failed/.test(out)) bad += 1;
  } catch (error) {
    bad += 1;
    console.log((error.stdout ?? "") + (error.stderr ?? ""));
    console.log(`✗ ${name} 退出码 ${error.status}`);
  }
}
console.log(bad === 0 ? "\n== 全部通过 ==" : `\n== ${bad} 组失败 ==`);
if (bad > 0) process.exitCode = 1;
