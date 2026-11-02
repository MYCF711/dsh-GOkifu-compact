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

/**
 * ★ C323（K-18）：**doctor 读的 foldMark 字段，必须在 foldMark 的构造里真的有写入**。
 *
 * 由来：C317→C321 连错五轮，最后一错是「`finishReason` 写进了 `ledger-budget.lastExternalFold`，
 * 而 doctor 读的是 `foldMarks[]`」—— 字段**确实有人写**，所以 C281 那套「读了但没人写」放过它，
 * 但 doctor 永远读到 null，仪器继续静默。
 *
 * 做法：从 `src/engine.mjs` 的 `const mark = {…}` 取出真实键集合，
 * 再去各处找 `mark?.X` / `mark.X` / `foldMark.X` 这类读取，不在集合里、也不在白名单 ⇒ 违规。
 *
 * @param {string} engineText src/engine.mjs 全文
 * @param {Array<[string, string]>} files 要检查的读取方
 * @returns {string[]}
 */
export function auditMarkFieldWrites(engineText, files) {
  // foldMark 有**多个构造点**（recordFoldMark / 自动 fold / tier2），必须取并集 ——
  // 只看一个会误报（实测：`ms`/`route` 只在自动 fold 那处写）。
  const written = new Set();
  let cursor = 0;
  while (cursor >= 0) {
    const at = engineText.indexOf("foldMarks.push(", cursor);
    if (at < 0) break;
    const block = engineText.slice(at, at + 2500);
    for (const line of block.split("\n")) {
      const key = line.trim().split(":")[0].split(",")[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) written.add(key);
    }
    cursor = at + 1;
  }
  // 也收 recordFoldMark 那条（const mark = {…} 后再 push）
  const markStart = engineText.indexOf("const mark = {");
  if (markStart >= 0) {
    const markEnd = engineText.indexOf("\n    };", markStart);
    const body = markEnd > markStart ? engineText.slice(markStart, markEnd) : engineText.slice(markStart, markStart + 4000);
    for (const line of body.split("\n")) {
      const key = line.trim().split(":")[0].split(",")[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) written.add(key);
    }
  }
  if (written.size === 0) return ["找不到任何 foldMark 构造点 —— 检查器本身失效，先修它"];

  // 宿主/历史字段：没有写入者但有明确出处，允许读
  const allowed = new Set(["usage", "at", "seqStart", "seqEnd", "trigger", "shadowedTokens", "closure", "boundary"]);

  const problems = [];
  for (const [rel, text] of files) {
    // 注释里的示例不算读取（否则本检查器会把自己和文档注释判成 bug）
    const code = String(text ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    const pieces = code.match(/(?:mark|foldMark)\s*\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    for (const piece of pieces) {
      const field = piece.split(".").pop().trim();
      if (allowed.has(field) || written.has(field)) continue;
      problems.push(`${rel} 读了 foldMark.${field}，但 foldMark 构造里没有这个键（C323）`);
    }
  }
  return [...new Set(problems)];
}

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
  // ★ C323：第二条检查 —— foldMark 的读写一致性（C321 那类"写进别的文件"就靠这条抓）
  const engineText = nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
  // 不审自己：本文件里的正则/注释天然包含 `foldMark.X` 这样的字面量
  const markProblems = auditMarkFieldWrites(
    engineText,
    files.filter(([rel]) => rel.split(nodePath.sep).join("/") !== "scripts/audit-field-reads.mjs"),
  );
  if (markProblems.length > 0) {
    console.log(`⚠ foldMark 字段读写不一致 ${markProblems.length} 条：`);
    for (const p of markProblems) console.log(`  · ${p}`);
  } else {
    console.log("✅ foldMark 字段读写一致（读到的一定在构造里写过）");
  }
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
