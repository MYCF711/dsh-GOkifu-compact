/**
 * add-changelog.mjs —— 按编号插入一条 CHANGELOG 条目（C403）
 *
 * 由来：这条命令是**为我们自己的流程**写的。本会话里"手写锚点做替换"已经静默失败过三次
 * （`### C401 · …` 与实际标题差几个字 ⇒ replace no-op ⇒ 条目根本没写进去，最后由 C172 才发现）。
 *
 * 锚点不可靠，但**结构是可靠的**：CHANGELOG 的条目块永远紧跟在索引表之后、按编号**降序**排列。
 * 所以这里按结构插入，不猜文本。
 *
 * 用法：
 *   node scripts/add-changelog.mjs --title "标题" --body-file <workspace>
 *   node scripts/add-changelog.mjs --c 404 --title "…" --body "…" --dry-run
 *   echo "正文" | node scripts/add-changelog.mjs --title "…"
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const FILE = nodePath.join(ROOT, "CHANGELOG.md");

/**
 * ★ C403：把一条条目插进 CHANGELOG 文本。纯函数。
 * 规则：插在**第一条 `### C…` 之前**（条目降序，最新在上）；编号重复直接抛错。
 * @param {string} text
 * @param {{c:number, title:string, body?:string}} entry
 * @returns {string}
 */
export function insertEntry(text, { c, title, body = "" }) {
  const src = String(text ?? "");
  if (!Number.isInteger(c) || c <= 0) throw new Error(`编号必须是正整数，收到 ${c}`);
  if (typeof title !== "string" || title.trim() === "") throw new Error("标题不能为空");
  if (new RegExp(`^### C${c}\\b`, "m").test(src)) throw new Error(`C${c} 已存在（编号重复）`);
  const firstEntry = /^### C\d+/m.exec(src);
  if (firstEntry === null) throw new Error("找不到任何 `### C<n>` 条目 —— 文件结构变了，先确认再插");
  const block = `### C${c} · ${title.trim()}\n\n${body.trim() === "" ? "" : `${body.trim()}\n\n`}`;
  return src.slice(0, firstEntry.index) + block + src.slice(firstEntry.index);
}

/** 现有最大编号。 */
export function maxNumber(text) {
  let max = 0;
  for (const m of String(text ?? "").matchAll(/^### C(\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const title = getArg("title");
  if (title === null) {
    console.log("用法：node scripts/add-changelog.mjs --title <标题> [--c <编号>] [--body <正文>|--body-file <文件>|--stdin] [--dry-run]");
    return 2;
  }
  const text = nodeFs.readFileSync(FILE, "utf8");
  const c = getArg("c") === null ? maxNumber(text) + 1 : Number(getArg("c"));
  const bodyFile = getArg("body-file");
  const body = bodyFile !== null ? nodeFs.readFileSync(bodyFile, "utf8") : (getArg("body") ?? (argv.includes("--stdin") ? nodeFs.readFileSync(0, "utf8") : ""));
  let next;
  try {
    next = insertEntry(text, { c, title, body });
  } catch (error) {
    console.error(`✗ ${String(error?.message ?? error)}`);
    return 1;
  }
  if (argv.includes("--dry-run")) {
    const first = next.split("\n").find((l) => l.startsWith(`### C${c} `));
    console.log(`（dry-run）将插入：${first}`);
    return 0;
  }
  nodeFs.writeFileSync(FILE, next, "utf8");
  // ★ C404：**连索引一起刷**。上一轮插完条目我还得手动跑一次 `changelog-index.mjs --write`，
  //   忘了就让 `C169` 红 —— 又一个"可以自动却靠人记得"的环节。这里直接接上。
  // ★ C404：连**索引**一起刷。上一轮插完条目我还得手动跑一次 `changelog-index.mjs --write`，
  //   忘了就让 `C169` 红 —— 又一个"可以自动却靠人记得"的环节。这里直接调那个脚本。
  let indexed = true;
  try {
    const r = spawnSync(process.execPath, [nodePath.join(HERE, "changelog-index.mjs"), "--write"], { encoding: "utf8" });
    indexed = r.status === 0;
  } catch {
    indexed = false;
  }
  console.log(`✓ 已插入 C${c} · ${title}${indexed ? "" : "（索引没刷成 —— 请跑 node scripts/changelog-index.mjs --write）"}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
