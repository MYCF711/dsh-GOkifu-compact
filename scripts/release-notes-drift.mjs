/**
 * release-notes-drift.mjs —— 发布说明落下了哪些改动（C354）
 *
 * 由来：发布说明是**用户唯一会读的版本级文档**，而它只在"我想起来"的时候才更新。
 * 本会话里它已经落后过两次（C327 补到 C326、C337 补到 C336），每次都是靠人翻 CHANGELOG。
 *
 * 这里把"翻"变成一条命令：CHANGELOG 里有、发布说明里没提到的 C 编号，全部列出来。
 *
 * 用法：
 *   node scripts/release-notes-drift.mjs            # 列缺失
 *   node scripts/release-notes-drift.mjs --json     # 机器可读
 *   node scripts/release-notes-drift.mjs --file docs/发布说明-1.17.6.md
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/**
 * ★ C354：从 CHANGELOG 里取所有 `### C<数字>` 的编号（去重、升序）。纯函数。
 * @param {string} changelog
 * @returns {number[]}
 */
export function changelogNumbers(changelog) {
  const out = new Set();
  for (const m of String(changelog ?? "").matchAll(/^###\s+C(\d+)\b/gm)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * ★ C354：从发布说明里取"被提到过的" C 编号（`C123` 这种写法即可，也认 `C1–C130` 范围）。纯函数。
 * @param {string} notes
 * @returns {Set<number>}
 */
export function mentionedNumbers(notes) {
  const text = String(notes ?? "");
  const out = new Set();
  for (const m of text.matchAll(/C(\d+)\s*[–—-]\s*C?(\d+)/g)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 2000) {
      for (let i = from; i <= to; i++) out.add(i);
    }
  }
  for (const m of text.matchAll(/C(\d+)/g)) out.add(Number(m[1]));
  return out;
}

/**
 * ★ C354：算出发布说明漏掉的编号。纯函数。
 * @param {string} changelog
 * @param {string} notes
 * @returns {{all:number[], mentioned:number[], missing:number[]}}
 */
export function driftOf(changelog, notes, { since = 0 } = {}) {
  const all = changelogNumbers(changelog);
  const mentioned = mentionedNumbers(notes);
  // ★ C354：**只关心"本版之内新增的"**。发布说明只覆盖一个版本，拿 C1 起的全量去比会报
  //   200 多条"历史遗漏"（那些属于更早版本的说明），等于把工具变成噪音源。
  const scoped = all.filter((n) => n >= since);
  const missing = scoped.filter((n) => !mentioned.has(n));
  return { all, scoped, mentioned: all.filter((n) => mentioned.has(n)), missing };
}

/**
 * ★ C421：**反向漂移** —— 发布说明里提到、但 CHANGELOG 里**根本没有**的编号。
 *
 * 为什么需要：反向（报还欠）能抳 "忘了写"；但"写错号"（如 `C42` 写成 `C421`）
 * 在反向里看不出来 —— 导航会指向一个不存在的条目。
 * @param {string} changelog
 * @param {string} notes
 * @param {{since?:number}} [options] 只看 since 之后的（避开早期文档里的历史引用）
 * @returns {number[]} 不存在但被引用的编号
 */
export function phantomMentions(changelog, notes, { since = 0 } = {}) {
  const all = new Set(changelogNumbers(changelog));
  const out = [];
  for (const n of mentionedNumbers(notes)) {
    if (n >= since && !all.has(n)) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const notesFile = getArg("file", "docs/发布说明-1.17.6.md");
  const changelog = nodeFs.readFileSync(nodePath.join(ROOT, "CHANGELOG.md"), "utf8");
  const notesPath = nodePath.join(ROOT, notesFile);
  if (!nodeFs.existsSync(notesPath)) {
    console.log(`发布说明不存在：${notesFile}`);
    return 2;
  }
  const notes = nodeFs.readFileSync(notesPath, "utf8");
  const rawSince = getArg("since", "");
  const mentionedMax = Math.max(0, ...mentionedNumbers(notes));
  // 默认从"发布说明最后提到的那条 +1"开始 —— 也就是**自上次更新以来的漂移**
  const since = rawSince === "" ? mentionedMax + 1 : Number(String(rawSince).replace(/^C/i, "")) || 0;
  const { all, scoped, missing } = driftOf(changelog, notes, { since });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ changelog: all.length, missing }, null, 2));
    return 0;
  }
  console.log(`== 发布说明漂移检查 · ${notesFile} ==`);
  console.log(`  CHANGELOG 共 ${all.length} 条；本次范围 C${since} 起（${scoped.length} 条）· 已提到 ${scoped.length - missing.length} 条`);
  if (missing.length === 0) {
    console.log("  ✅ 没有遗漏");
    return 0;
  }
  // ★ C355：门禁的参考门只把 `!`/`✗` 开头的行当作摘要 —— 用 ⚠ 会被静默吞掉
  console.log(`  ! 漏了 ${missing.length} 条：${missing.map((n) => `C${n}`).join(" / ")}`);
  // ★ C421：反向——发布说明引用了不存在的编号（导航会指向空处）
  const phantom = phantomMentions(changelog, notes, { since });
  if (phantom.length > 0) {
    console.log(`  ! 引用了不存在的编号 ${phantom.length} 个：${phantom.map((n) => `C${n}`).join(" / ")}`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
