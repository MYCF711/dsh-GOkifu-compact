#!/usr/bin/env node
/**
 * release-plan.mjs —— 发布前**只读**体检 + 打印确切命令（C204）
 *
 * 为什么：发布步骤散落在 `evidence/发布核对-*.md` 里，靠人照着敲；漏一步（比如世界脏、tag 已存在、
 * 版本没对齐）就要回滚。这个脚本**不执行任何写操作**，只回答三件事：
 *
 *   ① 现在能不能发（前置条件逐条给结论）；
 *   ② 要发的话，**逐条命令**是什么（含 `git tag` / `npm publish`）；
 *   ③ 发出去会是什么内容（版本、包内文件数、buildId）。
 *
 * 用法：
 *   node scripts/release-plan.mjs            # 人读
 *   node scripts/release-plan.mjs --json
 *
 * 退出码：前置条件全满足 ⇒ 0；有阻塞项 ⇒ 1。
 * **永不会**执行 tag / publish / push —— 那是主人的动作。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { repoBuildId, repoVersion } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** 纯函数：根据事实给出前置条件结论（便于单测）。 */
export function planRelease(facts) {
  const problems = [];
  const notes = [];
  if (facts.dirty) problems.push("工作树不干净（有未提交改动）—— 先提交或 stash");
  if (!facts.version) problems.push("package.json 没有 version");
  if (facts.tagExists) problems.push(`tag ${facts.tagName} 已存在（版本号没升？）`);
  if (facts.registryVersion === facts.version) notes.push(`registry 已经是 ${facts.version}（这版已发过）`);
  if (facts.versionMismatch) problems.push(`package.json ${facts.version} ≠ HANDOFF 记录的 ${facts.handoffVersion}`);
  if (facts.testCount === null) notes.push("HANDOFF 里没读到测试数（发布前建议补一次全量）");
  const tagName = facts.tagName;
  const commands = [
    `node test/run.mjs                      # 串行全量（当次输出为准）`,
    `node scripts/bench-repro.mjs           # 415 tokens / 8-8`,
    `node scripts/handoff-check.mjs         # FAIL 0 / WARN 0`,
    `node scripts/doctor.mjs                # 0 错误`,
    `node scripts/boundary-audit.mjs        # 0 条`,
    `git tag -a ${tagName} -m "${facts.version}"`,
    `npm publish`,
    `git push origin ${tagName}             # 只有主人授权才执行`,
  ];
  return { ok: problems.length === 0, problems, notes, commands, tagName };
}

function main() {
  const version = repoVersion();
  const dirty = git(["status", "--porcelain"]).length > 0;
  const tagName = `v${version}`;
  let tagExists = false;
  try {
    git(["rev-parse", "--verify", `refs/tags/${tagName}`]);
    tagExists = true;
  } catch {
    tagExists = false;
  }
  const handoff = nodeFs.existsSync(nodePath.join(REPO, "HANDOFF.md")) ? nodeFs.readFileSync(nodePath.join(REPO, "HANDOFF.md"), "utf8") : "";
  const handoffVersion = handoff.match(/\\|\\s*版本\\s*\\|\\s*\\*\\*([0-9.]+)\\*\\*/)?.[1] ?? null;
  const testCount = handoff.match(/全量 \*\*(\d+) passed/)?.[1] ?? null;
  let buildId = null;
  try {
    buildId = repoBuildId(REPO);
  } catch {
    buildId = null;
  }
  let registryVersion = null;
  try {
    registryVersion = execFileSync("npm", ["view", "dsh-gokifu-compact", "version"], { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" }).trim();
  } catch {
    registryVersion = null;
  }
  const plan = planRelease({
    dirty,
    version,
    tagName,
    tagExists,
    handoffVersion,
    versionMismatch: handoffVersion !== null && handoffVersion !== version,
    testCount,
    registryVersion,
  });
  const json = process.argv.includes("--json");
  if (json) {
    process.stdout.write(JSON.stringify({ version, tagName, tagExists, registryVersion, buildId, testCount, ...plan }, null, 2) + String.fromCharCode(10));
  } else {
    process.stdout.write(`发布计划：${version}（tag ${tagName}）` + String.fromCharCode(10));
    process.stdout.write(`  registry 当前：${registryVersion ?? "—"} · 本地 buildId：${buildId ?? "—"} · 全量测试：${testCount ?? "—"}` + String.fromCharCode(10));
    for (const note of plan.notes) process.stdout.write(`  · ${note}` + String.fromCharCode(10));
    if (plan.problems.length > 0) for (const p of plan.problems) process.stdout.write(`  ✗ ${p}` + String.fromCharCode(10));
    process.stdout.write((plan.ok ? "✅ 前置条件满足；下面是主人执行的动作（本脚本不会执行）" : "❌ 有阻塞项，先处理") + String.fromCharCode(10));
    for (const c of plan.commands) process.stdout.write(`    ${c}` + String.fromCharCode(10));
  }
  process.exit(plan.ok ? 0 : 1);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
