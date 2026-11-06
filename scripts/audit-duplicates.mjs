/**
 * audit-duplicates.mjs —— 找「同一段代码写了两遍」（C303）
 *
 * 由来：C300 发现 `countResolvedFailures` 在 ui 和 doctor 里各写一遍；
 * C302 发现 `evidence` 的读法抄了四份、默认值还不一样。**重复的代码不会一起改。**
 * 这两处都是靠"顺手看到"发现的 —— 太靠运气。这个脚本把它变成可重复的扫描。
 *
 * 做法（刻意简单，不引解析器）：
 *   1. 逐文件抽取 `function name(...) {…}` 与 `const name = (…) => {…}` 的函数体（花括号配对）；
 *   2. 去掉注释与空白做归一化；
 *   3. 归一化后**完全相同**且语句数 ≥ `MIN_LINES` 的，归为一组 —— 组内 ≥2 个函数就是嫌疑。
 *
 * 它不是判据（同名小工具函数重复是合理的），只是**清单**。所以：
 *   · 默认只打印前 N 组；`--json` 给机读；
 *   · 退出码永远 0。
 *
 * 用法：node scripts/audit-duplicates.mjs [--min 4] [--json]
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/** 这些组是"合理的重复"，不报（每条都要写清为什么）。 */
export const ALLOW = Object.freeze({
  // 空实现 / 一行包装，重复无害
  "return null;": "空实现",
  "throw new Error(\"not implemented\");": "占位实现",
  // ★ C306：`scripts/install.mjs` 是**独立发布**的 CLI（会被复制进 profile 单独运行），
  //   所以它不能 `import "../src/rooms/profile-io.mjs"` —— 这两份小工具必须各留一份。
  //   面板侧已改为引用 `src/rooms/profile-io.mjs`（唯一真相在这里），install 侧是有意的副本。
  "try{return nodeFs.existsSync(file)?nodeFs.readFileSync(file,\"utf8\"):null;}catch{return null;}":
    "install.mjs 是独立发布的 CLI，不能依赖 ../src（有意保留）",
  "const file=nodePath.join(profileDir,\"package.json\");try{if(!nodeFs.existsSync(file))return [];const pkg=JSON.parse(nodeFs.readFileSync(file,\"utf8\"));const bundles=pkg?.dsh?.profile?.bundles;return Array.isArray(bundles)?bundles.filter((b)=>typeof b===\"string\"&&b.trim()!==\"\"):[];}catch{return [];}":
    "同上：install.mjs 独立发布，需要自带一份读 profile bundles 的实现",
});

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
      } else if ((entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) && !entry.name.startsWith(".")) {
        out.push(child);
      }
    }
  };
  for (const dir of ["src", "scripts", "lib"]) walk(dir);
  return out;
}

/** 从 `{` 开始找配对的 `}`（跳过字符串/模板/注释，够用就行）。 */
function matchBrace(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    if (quote !== null) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 归一化：去注释、压空白、去尾部逗号差异。 */
export function normalizeBody(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:=+\-*/<>!&|?])\s*/g, "$1")
    .trim();
}

/**
 * 纯函数：给 `[相对路径, 文本]`，找出内容完全相同的函数体。
 * @returns {Array<{key:string, statements:number, sites:Array<{file:string,name:string}>}>}
 */
export function findDuplicateBodies(files, { minStatements = 4 } = {}) {
  const groups = new Map();
  const record = (file, name, body) => {
    const normalized = normalizeBody(body);
    if (normalized === "") return;
    if (ALLOW[normalized] !== undefined) return;
    const statements = (body.match(/[;}]/g) ?? []).length;
    if (statements < minStatements) return;
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push({ file, name });
  };

  for (const [file, text] of files) {
    // ① function 声明
    for (const m of text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const openParen = text.indexOf("(", m.index);
      // 找到参数表结束后的第一个 {
      let depth = 0;
      let i = openParen;
      for (; i < text.length; i += 1) {
        if (text[i] === "(") depth += 1;
        else if (text[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const brace = text.indexOf("{", i);
      if (brace < 0) continue;
      const end = matchBrace(text, brace);
      if (end < 0) continue;
      record(file, m[1], text.slice(brace + 1, end));
    }
    // ② const name = (...) => { ... }
    for (const m of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
      const brace = text.indexOf("{", m.index + m[0].length - 1);
      const end = matchBrace(text, brace);
      if (end < 0) continue;
      record(file, m[1], text.slice(brace + 1, end));
    }
  }

  const out = [];
  for (const [key, sites] of groups) {
    if (sites.length < 2) continue;
    // 同一文件里同名（重载/重复定义）不算"跨文件复制"，但也值得知道 —— 保留，标注文件数
    out.push({ key, statements: (key.match(/[;}]/g) ?? []).length, sites, files: new Set(sites.map((s) => s.file)).size });
  }
  out.sort((a, b) => b.statements - a.statements || b.sites.length - a.sites.length);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const minStatements = Math.max(1, Number(getArg("min", "4")) || 4);
  const files = listSources().map((rel) => [rel, nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8")]);
  const dupes = findDuplicateBodies(files, { minStatements });

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ files: files.length, dupes: dupes.map((d) => ({ statements: d.statements, files: d.files, sites: d.sites })) }, null, 2));
    return 0;
  }
  console.log(`== 重复函数体扫描 ==  文件 ${files.length} 个 · 完全相同且 ≥${minStatements} 条的组 ${dupes.length} 个`);
  if (dupes.length === 0) {
    console.log("✅ 没有跨文件完全相同的函数体");
    return 0;
  }
  for (const d of dupes.slice(0, 12)) {
    console.log(`  · ${d.statements} 条 · ${d.files} 个文件：${d.sites.map((s) => `${s.file}#${s.name}`).join("  |  ")}`);
  }
  if (dupes.length > 12) console.log(`  · …另 ${dupes.length - 12} 组`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
