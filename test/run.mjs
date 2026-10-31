/**
 * 极简测试运行器（零依赖）。
 * 用法：node test/run.mjs [filter]
 *       node test/run.mjs --dir=<其他目录> [filter]   # 只给 run-skip 自己的夹具用
 *
 * ★ S10d（2026-10-31）：两种「假绿」被堵死 ——
 *   ① **显式 skip**：`t.skip(reason)` ⇒ 计入 skipped，不执行后续断言、**不算 pass**、不算 failed；
 *      退出码只看 failed（skipped 不导致失败）。
 *   ② **零断言检测**：用例跑完既没有调过任何断言、也没有 `t.skip(...)` ⇒ 计入 zeroAssertion
 *      并**按失败处理**（旧版这种用例会安安静静地算一条 pass —— 那是最坏的一种假绿）。
 *
 * 汇总行固定格式：`== <passed> passed, <skipped> skipped, <failed> failed ==`
 * （zeroAssertion 非 0 时额外打一行，并已经计进 failed）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const dirArg = args.find((a) => a.startsWith("--dir="));
const HERE = dirArg ? nodePath.resolve(dirArg.slice("--dir=".length)) : nodePath.dirname(fileURLToPath(import.meta.url));
const filter = args.find((a) => !a.startsWith("--")) ?? "";

let pass = 0;
let skipped = 0;
let fail = 0;
let zeroAssertions = 0;
const failures = [];

const files = nodeFs
  .readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => (filter ? f.includes(filter) : true))
  .sort();

for (const file of files) {
  const mod = await import(pathToFileURL(nodePath.join(HERE, file)).href);
  const tests = mod.tests ?? {};
  console.log(`\n── ${file} ──`);
  for (const [name, fn] of Object.entries(tests)) {
    const t = makeT();
    try {
      await fn(t);
    } catch (error) {
      fail += 1;
      failures.push({ file, name, error });
      console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split("\n").join("\n    ")}`);
      continue;
    }
    // 失败断言优先于 skip（先断言错、再 skip 的用例必须红）
    if (t.failed.length > 0) {
      fail += 1;
      failures.push({ file, name, error: new Error(t.failed.join("\n")) });
      console.log(`  ✗ ${name}\n    ${t.failed.join("\n").split("\n").join("\n    ")}`);
      continue;
    }
    if (t.skipped) {
      skipped += 1;
      console.log(`  - ${name} (skipped: ${t.skipReason})`);
      continue;
    }
    // ★ S10d：零断言 = 假绿。既没断言、也没 skip 证明 ⇒ 红（不再默默算 pass）。
    //   「throws 证明」也算证据：本仓大量用例用 `if (bad) throw new Error(...)` 的写法（不是 t.eq），
    //   它们失败时确实会红；真正的假绿是**连 throw 都没有**的空壳用例 ⇒ 用源码里的 throw/assert 判定。
    const hasThrowProof = /throw|assert/.test(String(fn));
    if (t.assertions === 0 && !hasThrowProof) {
      zeroAssertions += 1;
      const error = new Error(
        "零断言：用例跑完既没调用任何断言，也没有 t.skip(reason) 说明为什么跳过 —— " +
          "这种「跑完就绿」的用例是假绿来源。加断言，或用 t.skip 明确跳过。",
      );
      fail += 1;
      failures.push({ file, name, error });
      console.log(`  ✗ ${name}\n    ${error.message}`);
      continue;
    }
    pass += 1;
    console.log(`  ✓ ${name}`);
  }
}

function makeT() {
  const failed = [];
  const t = {
    failed,
    /** 本用例调用过的断言次数（供运行器做零断言检测）。 */
    assertions: 0,
    skipped: false,
    skipReason: "",
    /** ★ S10d：显式跳过 —— 不计 pass、不计 failed；调用后不应再断言。 */
    skip(reason = "") {
      t.skipped = true;
      t.skipReason = String(reason ?? "").trim() || "no reason given";
    },
    ok(cond, msg = "expected truthy") {
      t.assertions += 1;
      if (!cond) failed.push(`ok: ${msg}`);
    },
    eq(actual, expected, msg = "") {
      t.assertions += 1;
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) failed.push(`eq: ${msg}\n  actual:   ${a}\n  expected: ${b}`);
    },
    ne(actual, unexpected, msg = "") {
      t.assertions += 1;
      if (JSON.stringify(actual) === JSON.stringify(unexpected)) failed.push(`ne: ${msg} (got ${JSON.stringify(actual)})`);
    },
    includes(haystack, needle, msg = "") {
      t.assertions += 1;
      if (!String(haystack).includes(needle)) failed.push(`includes: ${msg}\n  needle: ${needle}\n  in: ${String(haystack).slice(0, 800)}`);
    },
    notIncludes(haystack, needle, msg = "") {
      t.assertions += 1;
      if (String(haystack).includes(needle)) failed.push(`notIncludes: ${msg}\n  needle: ${needle}`);
    },
    throws(fn, msg = "") {
      t.assertions += 1;
      let threw = false;
      try {
        fn();
      } catch {
        threw = true;
      }
      if (!threw) failed.push(`throws: ${msg}`);
    },
  };
  return t;
}

console.log(`\n== ${pass} passed, ${skipped} skipped, ${fail} failed ==`);
if (zeroAssertions > 0) console.log(`   （其中 ${zeroAssertions} 条是零断言假绿，已计入 failed）`);
if (fail > 0) {
  for (const f of failures) console.error(`\n[${f.file}] ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
