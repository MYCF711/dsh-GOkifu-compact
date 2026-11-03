/**
 * progress-index.mjs —— 给 256 KB 的进度页生成「最近 30 轮」索引（C429）
 *
 * 由来：`docs/knowledge/进度.md` 已经有 **205 轮**、4000+ 行、256 KB。
 * 现状摘要只讲"现在是什么状态"，但"**最近改了什么**"仍要人从头往下翻。
 *
 * 这里的索引是**生成物**：插在现状摘要之后、第一个 `## 第 N 轮` 之前，写一次刷一次；
 * `test/progress-index.test.mjs` 会比对，手改会被打回。
 *
 * 用法：
 *   node scripts/progress-index.mjs --write
 *   node scripts/progress-index.mjs --check     # 不一致则退出码 1
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const FILE = nodePath.join(ROOT, "docs", "knowledge", "进度.md");
const MARK_OPEN = "<!-- PROGRESS-INDEX:BEGIN -->";
const MARK_CLOSE = "<!-- PROGRESS-INDEX:END -->";

/**
 * ★ C429：从进度页里抽轮次标题。纯函数。
 * @param {string} text
 * @returns {Array<{n:number, line:string}>} 按文件顺序（越新越下）
 */
export function parseRounds(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/^## 第 (\d+) 轮 · (.+)$/gm)) {
    out.push({ n: Number(m[1]), line: m[2].trim() });
  }
  return out;
}

/**
 * ★ C429：渲染「最近 N 轮」索引块。纯函数。
 * @param {ReturnType<typeof parseRounds>} rounds
 * @param {{keep?:number}} [options]
 * @returns {string}
 */
export function renderIndexBlock(rounds, { keep = 30 } = {}) {
  const recent = (rounds ?? []).slice(-Math.max(1, keep));
  const lines = [MARK_OPEN, "", `> **最近 ${recent.length} 轮**（自动生成：\`node scripts/progress-index.mjs --write\`；手改会被测试打回）`, ""];
  for (const r of recent) lines.push(`- **第 ${r.n} 轮** · ${r.line}`);
  lines.push("", MARK_CLOSE);
  return lines.join("\n");
}

/**
 * ★ C429：把索引块插到/替换到正确位置。纯函数。
 * 位置：现状摘要之后、第一个 `## 第 N 轮` 之前。
 * @param {string} text
 * @param {{keep?:number}} [options]
 * @returns {string}
 */
export function applyIndex(text, options = {}) {
  const src = String(text ?? "");
  const block = renderIndexBlock(parseRounds(src), options);
  const begin = src.indexOf(MARK_OPEN);
  if (begin >= 0) {
    const end = src.indexOf(MARK_CLOSE, begin);
    if (end < 0) throw new Error("索引块只有 BEGIN 没有 END（文件被手改坏了）");
    const tail = src.slice(end + MARK_CLOSE.length);
    const head = src.slice(0, begin).replace(/\n+$/, "\n\n");
    return head + block + tail;
  }
  const firstRound = /^## 第 \d+ 轮 /m.exec(src);
  if (firstRound === null) throw new Error("找不到任何 `## 第 N 轮`（结构变了，先确认再插）");
  const head = src.slice(0, firstRound.index).replace(/\n+$/, "\n\n");
  return head + block + "\n\n" + src.slice(firstRound.index);
}

export function main(argv = process.argv.slice(2)) {
  const text = nodeFs.readFileSync(FILE, "utf8");
  let next;
  try {
    next = applyIndex(text);
  } catch (error) {
    console.error(`✗ ${String(error?.message ?? error)}`);
    return 1;
  }
  if (argv.includes("--check")) {
    if (next !== text) {
      console.error("✗ 进度索引不是最新的 —— 跑 node scripts/progress-index.mjs --write");
      return 1;
    }
    console.log("✓ 进度索引最新");
    return 0;
  }
  if (next === text) {
    console.log("（无变化）");
    return 0;
  }
  // ★ C429：先写临时文件再替换 —— 上一轮的教训（异常写入把 250 KB 清成 0 字节）
  const tmp = `${FILE}.tmp`;
  nodeFs.writeFileSync(tmp, next, "utf8");
  nodeFs.renameSync(tmp, FILE);
  console.log(`✓ 已刷新进度索引（${parseRounds(next).length} 轮，显示最近 30 轮）`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
