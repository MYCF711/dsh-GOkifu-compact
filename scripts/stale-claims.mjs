#!/usr/bin/env node
/**
 * stale-claims.mjs —— 找出**已经过期**的「下一步 / 还没 / 待办」说法（C544）
 *
 * 由来：真机 2026-11-04，doctor 里挂着一句
 *   「离线压缩还有缺口 …… **这些还没进欠账，下一步做分段离线**」
 * 而 C519/C520/C522 早就做完了。这类句子不会自己消失，还专门在下一次排查时把人带偏。
 *
 * 判据（保守，宁可漏报不要误报）：
 *   一句话里同时出现
 *     ① 「还没 / 下一步 / 待做 / 未做 / 下一步要做」这类**将来时**词；
 *     ② 一个 `C###` 编号；
 *   而这个编号**已经出现在 CHANGELOG.md** 里 ⇒ 那条"下一步"很可能已经做完了。
 *
 * 用法：
 *   node scripts/stale-claims.mjs            # 只报，不改
 *   node scripts/stale-claims.mjs --json     # 机器读
 * 退出码：0 = 没问题；1 = 发现疑似过期。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/** 将来时词（尽量窄：只收"还没做"的语气，不收"下一步该做什么"这种建议）。 */
/** ★ C544：**只收"待办意图"**，不收泛泛的"还没"。
 *  第一版收 "还没" 造成大量误报 —— 像 `未采集（还没有 foldMark）` 描述的是**运行期状态**，
 *  不是"下一步要做什么"。要抓的是**承诺**，不是**现状**。 */
const FUTURE = ["下一步做", "下一步要", "下一步再", "待做", "留待", "尚未实现", "还没做", "还没实现", "TODO:"];

/**
 * 判断一行是不是"疑似过期"。
 * @param {string} line
 * @param {Set<string>} doneIds CHANGELOG 里已有的编号
 * @returns {{id:string, hit:string}|null}
 */
export function staleClaimInLine(line, doneIds) {
  const text = String(line ?? "");
  if (text.trim() === "") return null;
  const hit = FUTURE.find((w) => text.includes(w));
  if (hit === undefined) return null;
  // 一句话里可能提到多个编号：任一个已完工就算过期（因为"下一步"通常指整句的收尾项）
  for (const m of text.matchAll(/\bC(\d{1,4})\b/g)) {
    const id = `C${m[1]}`;
    if (doneIds.has(id)) return { id, hit };
  }
  return null;
}

/**
 * 扫一批文件。
 * @param {string[]} files 绝对路径
 * @param {Set<string>} doneIds
 * @returns {Array<{file:string, line:number, id:string, hit:string, text:string}>}
 */
export function scanFiles(files, doneIds) {
  const out = [];
  for (const file of files) {
    let text = "";
    try {
      text = nodeFs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const found = staleClaimInLine(lines[i], doneIds);
      if (found === null) continue;
      out.push({
        file: nodePath.relative(ROOT, file).split(nodePath.sep).join("/"),
        line: i + 1,
        id: found.id,
        hit: found.hit,
        text: lines[i].trim().slice(0, 160),
      });
    }
  }
  return out;
}

/** 递归收集目录下的 .md（跳过 node_modules / .git / evidence 生成物）。 */
export function collectDocs(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = nodeFs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * ★ C544：**代码注释也是"现状声明"**。上一轮那条过期结论就躺在 `scripts/doctor.mjs` 里 ——
 * 只扫 .md 会正好漏掉它。
 * @param {string} dir
 * @returns {string[]}
 */
export function collectCode(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = nodeFs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs") || e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** CHANGELOG 里已经出现过的编号。 */
function changelogIds() {
  const ids = new Set();
  try {
    const text = nodeFs.readFileSync(nodePath.join(ROOT, "CHANGELOG.md"), "utf8");
    for (const m of text.matchAll(/^### (C\d{1,4})\b/gm)) ids.add(m[1]);
  } catch {
    /* 没有 CHANGELOG 就当全集为空（不误报） */
  }
  return ids;
}

/** ★ C544：**日志类文档不算"现状"** —— 进度页/发布说明/evidence 是历史记录，
 *  那里的"还没"描述的是**当时**的状态，不该判成过期（第一版 18 条里 14 条就是这种误报）。 */
const HISTORICAL = [/docs[/]knowledge[/]进度[.]md$/, /docs[/]发布说明-/, /^evidence[/]/, /CHANGELOG[.]md$/];

/**
 * @param {string} rel 相对仓库根的路径（正斜杠）
 * @returns {boolean}
 */
function isHistorical(rel) {
  return HISTORICAL.some((re) => re.test(rel));
}

function main(argv) {
  const done = changelogIds();
  const all = [...collectDocs(nodePath.join(ROOT, "docs")), ...collectDocs(nodePath.join(ROOT, "evidence")), ...collectCode(nodePath.join(ROOT, "scripts")), ...collectCode(nodePath.join(ROOT, "src"))];
  const files = all.filter((f) => !isHistorical(nodePath.relative(ROOT, f).split(nodePath.sep).join("/")));
  const hits = scanFiles(files, done);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(hits, null, 1)}\n`);
  } else if (hits.length === 0) {
    console.log("✅ 没有发现「将来时 + 已完成编号」的过期说法");
  } else {
    console.log(`! 疑似过期 ${hits.length} 条（编号已在 CHANGELOG 里，但句子还写着"还没/下一步"）：`);
    for (const h of hits.slice(0, 20)) console.log(`  ${h.file}:${h.line}  [${h.id}] "${h.hit}" → ${h.text}`);
    if (hits.length > 20) console.log(`  …另 ${hits.length - 20} 条`);
  }
  return hits.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
