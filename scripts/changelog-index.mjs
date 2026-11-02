#!/usr/bin/env node
/**
 * changelog-index.mjs —— 给 170 条 C 轮条目生成/校验一份「一行一条」的导航索引（C169）
 *
 * 为什么需要：`CHANGELOG.md` 现在有 170 条 `### C<n>` 条目、几千行。想找「哪一轮改了什么」
 * 只能从上往下滚。索引把它压成 170 行，且**与正文同步由机器保证**（会红）。
 *
 * 用法：
 *   node scripts/changelog-index.mjs            # 打印索引（不改文件）
 *   node scripts/changelog-index.mjs --write    # 重写 CHANGELOG 顶部的索引块
 *   node scripts/changelog-index.mjs --check    # 校验索引块与正文一致（不一致 exit 1）
 *
 * 索引块格式（`<!-- C-INDEX:BEGIN -->` … `<!-- C-INDEX:END -->`）：
 *   | C1 | 标题首句（≤60 字） |
 * 边界：只读正文，除 `--write` 外不写盘；只处理 `### C<数字>` 形式的标题。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FILE = nodePath.join(HERE, "..", "CHANGELOG.md");
const BEGIN = "<!-- C-INDEX:BEGIN -->";
const END = "<!-- C-INDEX:END -->";

/** 从 CHANGELOG 正文抽出所有条目（按出现顺序）。 */
export function parseEntries(text) {
  const out = [];
  for (const line of text.split(String.fromCharCode(10))) {
    const m = line.match(/^### (C\d+) · (.+)$/);
    if (!m) continue;
    out.push({ id: m[1], title: m[2].trim() });
  }
  return out;
}

/** 生成索引块（含首尾标记）。 */
export function renderIndex(entries) {
  const lines = [BEGIN, "", "| 轮次 | 一句话 |", "|---|---|"];
  for (const e of entries) {
    const short = e.title.length > 60 ? `${e.title.slice(0, 58)}…` : e.title;
    lines.push(`| ${e.id} | ${short.replace(/\|/g, "/")} |`);
  }
  lines.push("", END);
  return lines.join(String.fromCharCode(10));
}

/** 取文件里现有的索引块（没有则 null）。 */
export function existingIndex(text) {
  const s = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (s < 0 || e < 0 || e < s) return null;
  return text.slice(s, e + END.length);
}

function main() {
  const text = nodeFs.readFileSync(FILE, "utf8");
  const entries = parseEntries(text);
  const want = renderIndex(entries);
  if (process.argv.includes("--write")) {
    const have = existingIndex(text);
    const next = have === null ? `${want}${String.fromCharCode(10, 10)}${text}` : text.replace(have, want);
    nodeFs.writeFileSync(FILE, next, "utf8");
    process.stdout.write(`已写入索引：${entries.length} 条` + String.fromCharCode(10));
    return;
  }
  if (process.argv.includes("--check")) {
    const have = existingIndex(text);
    if (have === null) {
      process.stdout.write(`❌ CHANGELOG 缺少索引块（先跑 --write）` + String.fromCharCode(10));
      process.exit(1);
    }
    if (have !== want) {
      const missing = entries.filter((e) => !have.includes(`| ${e.id} |`)).map((e) => e.id);
      process.stdout.write(`❌ 索引与正文不一致（缺：${missing.slice(0, 8).join(", ") || "无缺项，可能是顺序/文案变化"}；先跑 --write）` + String.fromCharCode(10));
      process.exit(1);
    }
    process.stdout.write(`✅ 索引与正文一致（${entries.length} 条）` + String.fromCharCode(10));
    return;
  }
  process.stdout.write(want.split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)) + String.fromCharCode(10));
  process.stdout.write(`…（共 ${entries.length} 条；用 --write 落盘、--check 校验）` + String.fromCharCode(10));
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
