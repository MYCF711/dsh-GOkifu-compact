/**
 * audit-field-reads.mjs —— 找「我们自己造的对象」上「读了但没人写」的字段（C281）
 *
 * 由来：C280 发现 doctor 一直在读 `quality.outOfRangeLater`，而这个字段**从来没人写过**
 * ⇒ 永远读到空 ⇒ 永远报「正常」。这类错最阴：不报错、不崩溃，只是**仪器一直在撒谎**。
 *
 * 为什么只扫这几个对象根：全量扫 `.xxx` 会把 `Array.prototype.sort` 这种全算进来（实测 265 条噪声）。
 * 这几个根是**我们自己造的**结构，字段集合完全由本仓库决定 —— 读了一个不存在的字段就一定是 bug：
 *   quality / closeout / dangling / boundary / closure / usage / outOfRange*
 *
 * 用法：node scripts/audit-field-reads.mjs [--json]
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/**
 * 宿主透传的字段：本仓库只读不写，值来自 `assembler.usage`（宿主 LLM 层）—— 不是幽灵。
 * 加新条目必须写清"谁写的"，否则这条清单会变成"把 bug 藏起来的地方"。
 */
export const HOST_PASSTHROUGH = Object.freeze({
  inputTokens: "宿主 assembler.usage",
  outputTokens: "宿主 assembler.usage",
  totalTokens: "宿主 assembler.usage",
  cacheReadTokens: "宿主 assembler.usage（实测存在：109466/1251/127101/16384）",
});

/** 只审计这些"自己造"的对象根。 */
export const OWNED_ROOTS = Object.freeze(["quality", "closeout", "dangling", "boundary", "closure", "usage"]);

function listSources() {
  const out = [];
  const walk = (rel) => {
    const dir = nodePath.join(ROOT, rel);
    if (!nodeFs.existsSync(dir)) return;
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const child = nodePath.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(child);
      } else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
        // 测试用的临时副本不在审计范围（它们不该待在 src/ 里，另案处理）
        if (entry.name.startsWith(".engine-under-test")) continue;
        out.push(child);
      }
    }
  };
  for (const dir of ["src", "scripts", "lib"]) walk(dir);
  return out;
}

/**
 * 纯函数：给一份 `[相对路径, 文本]` 列表，找出「读了但没人写」的字段。
 * @param {Array<[string, string]>} files
 */
export function auditOwnedFields(files) {
  const reads = new Map(); // field -> Set(files)
  for (const [rel, text] of files) {
    for (const root of OWNED_ROOTS) {
      const re = new RegExp(`\\.${root}\\??\\.([A-Za-z][A-Za-z0-9]*)`, "g");
      for (const m of text.matchAll(re)) {
        const field = m[1];
        if (!reads.has(field)) reads.set(field, new Set());
        reads.get(field).add(rel);
      }
    }
  }
  const ghosts = [];
  for (const [field, where] of reads) {
    if (HOST_PASSTHROUGH[field] !== undefined) continue;
    const written = files.some(([, text]) => {
      const f = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const asKey = new RegExp("\\b" + f + "\\s*:").test(text);
      const asShorthand = new RegExp("[{,]" + "\\s*" + f + "\\s*[,}]").test(text);
      const asAssign = new RegExp("\\." + f + "\\s*=").test(text);
      const asLiteral = text.includes(`"${field}"`) || text.includes(`'${field}'`);
      return asKey || asShorthand || asAssign || asLiteral;
    });
    if (!written) ghosts.push({ field, files: [...where].sort() });
  }
  ghosts.sort((a, b) => a.field.localeCompare(b.field));
  return { reads: [...reads.keys()].sort(), ghosts };
}

export function main(argv = process.argv.slice(2)) {
  const sources = listSources();
  const files = sources.map((rel) => [rel, nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8")]);
  const { reads, ghosts } = auditOwnedFields(files);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ sources: sources.length, fields: reads, ghosts }, null, 2));
    return 0;
  }
  console.log(`== 自有结构字段审计 ==  源 ${sources.length} 个 / 字段 ${reads.length} 个（${OWNED_ROOTS.join(" / ")}）`);
  if (ghosts.length === 0) {
    console.log("✅ 没有「读了但没人写」的字段");
    return 0;
  }
  console.log(`⚠ ${ghosts.length} 个字段只被读、没人写：`);
  for (const g of ghosts) console.log(`  · ${g.field}  ← ${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? " …" : ""}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
