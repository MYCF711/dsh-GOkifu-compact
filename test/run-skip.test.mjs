/**
 * run-skip.test.mjs —— 运行器自身的四态门禁（S10d，task-138）
 *
 * 为什么要有它：`test/run.mjs` 是**唯一**的判定器。它自己错了（把 skip 算成 pass、
 * 把空壳用例算成 pass），全仓 473 条用例的绿都失去意义。
 *
 * 做法：在临时目录里放四个**故意**不同形态的夹具 `.test.mjs`，用真的运行器
 * （`node test/run.mjs --dir=<tmp>`）跑它们，断言汇总行与退出码：
 *   · pass 用例     → 计入 passed
 *   · fail 用例     → 计入 failed
 *   · skip 用例     → 计入 skipped，**不算 pass、不算 failed**
 *   · 零断言用例    → 计入 failed（假绿必须红）
 *
 * 变异自检（见 ws-s10d/REPORT.md）：删掉运行器的 skip 分支、或删掉零断言检测，
 * 本文件必须变红。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const RUNNER = nodePath.join(HERE, "run.mjs");

/** 造一个夹具目录；每个元素是 [文件名, 源码]。 */
function makeFixtureDir(label, files) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-runskip-${label}-`));
  for (const [name, src] of files) nodeFs.writeFileSync(nodePath.join(dir, name), src, "utf8");
  return dir;
}

function runRunner(dir, args = []) {
  try {
    const out = execFileSync(process.execPath, [RUNNER, `--dir=${dir}`, ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? "spawn-error", out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const PASS_FIXTURE = [
  "a-pass.test.mjs",
  'export const tests = { "pass 用例：有断言"() { if (1 + 1 !== 2) throw new Error("数学坏了"); } };\n',
];
const FAIL_FIXTURE = [
  "b-fail.test.mjs",
  'export const tests = { "fail 用例：断言失败"(t) { t.eq(1, 2, "故意失败"); } };\n',
];
const SKIP_FIXTURE = [
  "c-skip.test.mjs",
  'export const tests = { "skip 用例：平台守卫"(t) { t.skip("非 Windows：本机跳过"); globalThis.__RAN_AFTER_SKIP = true; return; }, "skip 之后还能有别的用例"(t) { t.ok(true, "ok"); } };\n',
];
const ZERO_FIXTURE = [
  "d-zero.test.mjs",
  'export const tests = { "零断言用例：跑完什么都不验"() { const x = 1 + 1; return x; }, "零断言 + 注释"(t) { /* 这里什么都不做 */ } };\n',
];

export const tests = {
  "S10d-1 四态可区分：pass / fail / skip / 零断言，汇总行与退出码都对"(t) {
    const dir = makeFixtureDir("four", [PASS_FIXTURE, FAIL_FIXTURE, SKIP_FIXTURE, ZERO_FIXTURE]);
    try {
      const r = runRunner(dir);
      t.eq(r.code, 1, `有失败时 exit 必须 1，实际 ${r.code}\n${r.out}`);
      t.includes(r.out, "== 2 passed, 1 skipped, 3 failed ==", `汇总行必须四态分明，实际输出：\n${r.out}`);
      // pass 用例真的被执行且算 pass
      t.includes(r.out, "✓ pass 用例：有断言");
      // fail 用例算 failed
      t.includes(r.out, "✗ fail 用例：断言失败");
      // skip 用例：计入 skipped（带原因），不算 pass
      t.includes(r.out, "- skip 用例：平台守卫 (skipped: 非 Windows：本机跳过)");
      t.notIncludes(r.out, "✓ skip 用例：平台守卫", "skip 用例绝不允许算 pass");
      // 零断言用例：两条都要红，且理由写清「零断言」
      t.includes(r.out, "✗ 零断言用例：跑完什么都不验");
      t.includes(r.out, "✗ 零断言 + 注释");
      t.includes(r.out, "零断言");
      t.includes(r.out, "其中 2 条是零断言假绿，已计入 failed");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "S10d-2 skip 不导致失败：只有 pass + skip 的目录必须 exit 0，且 skipped 不计入 passed"(t) {
    const dir = makeFixtureDir("ok", [PASS_FIXTURE, SKIP_FIXTURE]);
    try {
      const r = runRunner(dir);
      t.eq(r.code, 0, `skip 不许让整轮变红，实际 ${r.code}\n${r.out}`);
      t.includes(r.out, "== 2 passed, 1 skipped, 0 failed ==", `skipped 不许算进 passed（应 2 passed 而非 3），实际：\n${r.out}`);
      t.notIncludes(r.out, "零断言");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "S10d-3 零断言严格报错：只有零断言用例的目录必须 exit 1（不许静默绿）"(t) {
    const dir = makeFixtureDir("zero", [ZERO_FIXTURE]);
    try {
      const r = runRunner(dir);
      t.eq(r.code, 1, `零断言必须红，实际 ${r.code}\n${r.out}`);
      t.includes(r.out, "== 0 passed, 0 skipped, 2 failed ==");
      t.includes(r.out, "零断言");
      // throw 风格的用例不算零断言（本仓 300+ 用例是这种写法，失败时会红）
      const THROW_FIXTURE = ["e-throw.test.mjs", String.raw`export const tests = { "throw 风格"() { if (1 !== 1) throw new Error("x"); } };`];
      const throwDir = makeFixtureDir("throw", [THROW_FIXTURE]);
      try {
        const r2 = runRunner(throwDir);
        t.eq(r2.code, 0, `throw 风格必须算有证明，实际 ${r2.code}\n${r2.out}`);
        t.includes(r2.out, "== 1 passed, 0 skipped, 0 failed ==");
      } finally {
        nodeFs.rmSync(throwDir, { recursive: true, force: true });
      }
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
