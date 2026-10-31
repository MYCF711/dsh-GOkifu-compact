/**
 * test-gate.test.mjs —— `all.mjs` 与 `real-fold-trigger.mjs` 的门禁回归（TEST-GATE，task-149）
 *
 * 背景（AUD-2 实测）：
 *   · `all.mjs` 旧版用 `/failed|✗/` 正则猜子步骤是否失败 —— 测试名里出现字面 `✗`
 *     （例如 `✓ S10c-3 manifestError 进 ✗ 详情…`）就会被误判成失败；反过来真失败也可能漏判。
 *     **唯一权威是子进程退出码。**
 *   · `real-fold-trigger.mjs` 旧版通过 4/5 仍 exit 0 —— 任何 CI 都会把它当通过。
 *
 * 本文件不跑真实模型：直接测两个模块导出的纯函数/子步骤执行器（`runStep` 用假子进程）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { runStep, stepPassed, allPassed, STEPS } from "./all.mjs";
import { summarizeResults } from "./real-fold-trigger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

export const tests = {
  "TG-1 子步骤 exit 0 但输出含字面 ✗ ⇒ 必须算通过（不按字样猜）"(t) {
    const r = runStep("含✗但成功", ["-e", 'console.log("✓ S10c-3 manifestError 进 ✗ 详情"); console.log("== 5 passed, 0 skipped, 0 failed ==");']);
    t.eq(r.status, 0, `子进程退出码，实际 ${r.status}`);
    t.eq(r.passed, true, `exit 0 必须算通过，output=${JSON.stringify(r.output).slice(0, 160)}`);
    t.includes(r.output, "✗", "夹具本身必须真的输出 ✗（否则测不到误判）");
    t.eq(allPassed([r]), true, "allPassed 应为 true");
  },

  "TG-2 子步骤 exit≠0 ⇒ 必须红（哪怕输出里全是好话）"(t) {
    const r = runStep("好话但失败", ["-e", 'console.log("全部通过！0 failed"); process.exitCode = 3;']);
    t.eq(r.status, 3, `退出码应原样保留，实际 ${r.status}`);
    t.eq(r.passed, false, "exit 3 必须算失败");
    t.eq(allPassed([r]), false, "allPassed 应为 false");
    t.includes(r.output, "0 failed", "夹具输出里确实写着 0 failed（旧正则会漏判）");
  },

  "TG-3 起不来 / 超时 / 无退出码 ⇒ 一律红（不许当没事）"(t) {
    const missing = runStep("脚本不存在", [nodePath.join(HERE, "no-such-script.mjs")]);
    t.eq(missing.passed, false, "脚本不存在必须红");
    t.eq(missing.status !== null, true, `node 起不来时通常拿不到退出码（本机是 1，也可能 null）`);
    // 真正的「起不来」：exec 直接抛且没有 status（ENOENT / EACCES）
    const spawnFail = runStep("exec 抛错", ["-e", ""], { exec: () => { const e = new Error("ENOENT: no such file"); e.code = "ENOENT"; throw e; } });
    t.eq(spawnFail.passed, false, "ENOENT 必须红");
    t.eq(spawnFail.status, null, "没有退出码时 status=null");
    const timeout = runStep("超时", ["-e", "setTimeout(() => {}, 5000);"], { timeout: 300 });
    t.eq(timeout.passed, false, "超时必须红");
    t.eq(timeout.timedOut, true, "必须标记 timedOut");
    t.eq(stepPassed({ status: null, timedOut: false, spawnError: new Error("ENOENT") }), false, "spawnError 必须红");
    t.eq(stepPassed({ status: 0, timedOut: true }), false, "timedOut 优先于 status=0");
    t.eq(stepPassed({ status: 0 }), true, "status=0 才算通过");
    t.eq(stepPassed({ status: 2 }), false, "status=2 必须红");
  },

  "TG-4 real-fold-trigger 判定：4/5 必须失败；5/5 通过；N/A 不计失败"(t) {
    const ok = (step) => ({ step, status: "ok" });
    const fourOfFive = summarizeResults([ok("a"), ok("b"), ok("c"), ok("d"), { step: "overflow", status: "fail" }]);
    t.eq(fourOfFive.passed, false, "有一项 fail ⇒ 整体必须失败（旧版 4/5 仍 exit 0）");
    t.eq(fourOfFive.fail, 1, "fail 计数");
    t.includes(fourOfFive.text, "通过 4/5", `文案应写明通过数，实际 ${fourOfFive.text}`);
    const fiveOfFive = summarizeResults([ok("a"), ok("b"), ok("c"), ok("d"), ok("overflow")]);
    t.eq(fiveOfFive.passed, true, "5/5 必须通过");
    // ⑤ 无内容可压 ⇒ n/a，不计失败
    const withNa = summarizeResults([ok("a"), ok("b"), ok("c"), ok("d"), { step: "overflow", status: "n/a" }]);
    t.eq(withNa.passed, true, "N/A 不许算失败");
    t.eq(withNa.na, 1, "na 计数");
    t.includes(withNa.text, "N/A", "文案必须写明 N/A");
  },

  "TG-5 结构回归：all.mjs 不得再用 ✗/failed 字样判失败；real-fold-trigger 必须设退出码"(t) {
    const allSrc = nodeFs.readFileSync(nodePath.join(HERE, "all.mjs"), "utf8");
    // 去注释后再查：注释里会引用旧写法做说明，不算违规
    const allCode = allSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    t.notIncludes(allCode, "/failed|✗/", "all.mjs 代码里不许再用正则猜失败（按退出码判）");
    t.includes(allSrc, "export function stepPassed", "all.mjs 必须导出 stepPassed");
    t.eq(Array.isArray(STEPS), true, "STEPS 必须是数组");
    t.eq(STEPS.length >= 5, true, `至少 5 个步骤，实际 ${STEPS.length}`);

    const trigSrc = nodeFs.readFileSync(nodePath.join(HERE, "real-fold-trigger.mjs"), "utf8");
    t.includes(trigSrc, "process.exitCode = 1", "real-fold-trigger 必须设 exitCode=1");
    t.includes(trigSrc, "process.exitCode = 2", "依赖未提取必须给非 0（未运行≠通过）");
    t.includes(trigSrc, "export function summarizeResults", "必须导出 summarizeResults（供回归）");
    t.includes(trigSrc, "usage.prompt", "必须累计并打印 usage");
    t.includes(trigSrc, "compressibleTail", "必须有「无内容可压」判定（N/A）");
  },
};
