#!/usr/bin/env node
/**
 * docs-index-check.mjs —— 「新增文档必须被索引」的机器检查（2026-11-02，C23）
 *
 * 为什么要有它：调研/证据文档是这个项目最主要的产出之一，但它们散在两个目录里：
 *   · `docs/research/` —— 调研与蒸馏（00 蒸馏 + 01–07 各专题）
 *   · `evidence/`       —— 实测数据（bench / 真实模型 / 巡检 / 成本）
 * 东西一多就会出现「新文件写了、但没人知道它在」的孤儿文档；而人肉维护索引一定会漏。
 *
 * 判据：两个目录各有一个 `README.md` 作为索引；**除 README 外每个 .md 的 basename 都必须
 * 出现在该索引文件里**。新增文档忘了登记 ⇒ exit 1（并列出缺失项）。
 *
 * 用法：
 *   node scripts/docs-index-check.mjs           # 人读
 *   node scripts/docs-index-check.mjs --json
 *
 * 边界：只读。它检查的是「文档可发现性」，不改任何文档、不碰压缩行为。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 需要索引的目录与其索引文件名（相对仓库根）。 */
export const INDEXED_DIRS = [
  { dir: "docs/research", index: "README.md", label: "research" },
  { dir: "evidence", index: "README.md", label: "evidence" },
];

/** 列出一个目录下所有 .md（不含索引自身与子目录）。 */
export function listMarkdown(root, { dir, index = "README.md" } = {}) {
  const abs = nodePath.join(root, dir);
  if (!nodeFs.existsSync(abs)) return [];
  return nodeFs
    .readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== index)
    .map((entry) => entry.name)
    .sort();
}

/** 索引文本里没有提到的文件（按 basename 判断 —— 索引里通常写 `docs/research/01-….md` 或纯文件名）。 */
export function missingFromIndex(indexText, files) {
  const text = String(indexText ?? "");
  return files.filter((file) => {
    const base = file.replace(/\.md$/, "");
    return !text.includes(file) && !text.includes(base);
  });
}

/**
 * 检查整个仓库。
 * @returns {{ok:boolean, missing:Array<{label:string,dir:string,file:string,index:string}>, checked:number}}
 */
export function checkRepo({ root = REPO } = {}) {
  const missing = [];
  let checked = 0;
  for (const spec of INDEXED_DIRS) {
    const indexPath = nodePath.join(root, spec.dir, spec.index);
    const indexText = nodeFs.existsSync(indexPath) ? nodeFs.readFileSync(indexPath, "utf8") : "";
    for (const file of listMarkdown(root, spec)) {
      checked += 1;
      if (missingFromIndex(indexText, [file]).length > 0) missing.push({ label: spec.label, dir: spec.dir, file, index: `${spec.dir}/${spec.index}` });
    }
  }
  return { ok: missing.length === 0, missing, checked };
}

function main() {
  const asJson = process.argv.includes("--json");
  const { ok, missing, checked } = checkRepo();
  if (asJson) {
    console.log(JSON.stringify({ ok, checked, missing }, null, 1));
  } else {
    console.log(`== 文档索引检查（${checked} 个文件 · ${INDEXED_DIRS.map((d) => `${d.dir}/${d.index}`).join(" · ")}）==`);
    if (ok) console.log("  ✓ 每个文档都在索引里（没有孤儿文档）");
    for (const m of missing) console.log(`  ✗ ${m.dir}/${m.file} —— 没出现在 ${m.index} 里`);
    console.log(`\n${ok ? "✅" : "❌"} 未索引文档 ${missing.length} 个`);
  }
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
