/**
 * 极简测试运行器（零依赖）。
 * 用法：node test/run.mjs [filter]
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";

let pass = 0;
let fail = 0;
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
      if (t.failed.length > 0) throw new Error(t.failed.join("\n"));
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      fail += 1;
      failures.push({ file, name, error });
      console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split("\n").join("\n    ")}`);
    }
  }
}

function makeT() {
  const failed = [];
  const t = {
    failed,
    ok(cond, msg = "expected truthy") {
      if (!cond) failed.push(`ok: ${msg}`);
    },
    eq(actual, expected, msg = "") {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) failed.push(`eq: ${msg}\n  actual:   ${a}\n  expected: ${b}`);
    },
    ne(actual, unexpected, msg = "") {
      if (JSON.stringify(actual) === JSON.stringify(unexpected)) failed.push(`ne: ${msg} (got ${JSON.stringify(actual)})`);
    },
    includes(haystack, needle, msg = "") {
      if (!String(haystack).includes(needle)) failed.push(`includes: ${msg}\n  needle: ${needle}\n  in: ${String(haystack).slice(0, 800)}`);
    },
    notIncludes(haystack, needle, msg = "") {
      if (String(haystack).includes(needle)) failed.push(`notIncludes: ${msg}\n  needle: ${needle}`);
    },
    throws(fn, msg = "") {
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

console.log(`\n== ${pass} passed, ${fail} failed ==`);
if (fail > 0) {
  for (const f of failures) console.error(`\n[${f.file}] ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
