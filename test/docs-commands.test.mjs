/**
 * docs-commands.test.mjs —— 用户文档里的命令必须是真的（2026-11-02，C86）
 *
 * 为什么需要：README / QUICKSTART 是用户唯一会照抄的东西 —— 里面写一个已经不存在的脚本，
 * 用户就卡在第一步。这类腐坏没有任何门禁会红（boundary-audit 只看措辞，docs-index 只看索引）。
 *
 * 判据（只扫**面向用户**的两份文档，历史计划文档 `docs/方案-*.md` 不参与 —— 它记录的是当时的事实）：
 *   ① `node (scripts|test)/X.mjs` 引用的文件必须存在；
 *   ② `npx dsh-gokifu-compact <子命令>` 引用的子命令必须在 `scripts/cli.mjs` 里有分派。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

const USER_DOCS = [
  "README.md",
  "QUICKSTART.md",
  // ★ C125：把 docs/README.md 里标为「现行（会被人照着做）」的文档一并纳入 ——
  //   它们同样会被人照抄命令，此前完全没有判据。
  "docs/核查清单.md",
  "docs/工程教训集.md",
  "docs/性能与成本.md",
  "docs/P6C-停窗执行手册.md",
  "docs/落盘与回滚不变量.md",
];

function scan() {
  const paths = new Set();
  const subs = new Set();
  for (const doc of USER_DOCS) {
    const file = nodePath.join(REPO, doc);
    if (!nodeFs.existsSync(file)) continue;
    const text = nodeFs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/node ((?:scripts|test)\/[A-Za-z0-9_.-]+\.mjs)/g)) paths.add(m[1]);
    for (const m of text.matchAll(/npx dsh-gokifu-compact ([a-z][a-z-]*)/g)) subs.add(m[1]);
  }
  return { paths: [...paths].sort(), subs: [...subs].sort() };
}

tests["C86-1 用户文档里 `node scripts|test/X.mjs` 必须都真实存在"] = (t) => {
  const { paths } = scan();
  t.eq(paths.length >= 3, true, `至少要扫出 3 条命令，实际 ${paths.length}：${paths.join(", ")}`);
  for (const rel of paths) {
    t.eq(nodeFs.existsSync(nodePath.join(REPO, rel)), true, `文档引用了不存在的文件：${rel}（用户照抄会失败）`);
  }
};

tests["C86-2 用户文档里的 npx 子命令必须在 cli.mjs 里有分派"] = (t) => {
  const { subs } = scan();
  t.eq(subs.length >= 1, true, "至少要扫出一个 npx 子命令");
  const cli = nodeFs.readFileSync(nodePath.join(REPO, "scripts", "cli.mjs"), "utf8");
  for (const sub of subs) {
    t.eq(cli.includes(`command === "${sub}"`), true, `cli.mjs 没有分派子命令 "${sub}"（文档会误导用户）`);
  }
};

tests["C97-1 README 点名的 doctor 检查必须真实存在（文档与体检不许各说各话）"] = (t) => {
  const readme = nodeFs.readFileSync(nodePath.join(REPO, "README.md"), "utf8");
  const doctor = nodeFs.readFileSync(nodePath.join(REPO, "scripts", "doctor.mjs"), "utf8");
  // README 里承诺的三个共存检查（C94/C95/C96）
  const promised = ["第三方 preset 的压缩后端", "preset 覆盖唯一性", "insert id 唯一性"];
  for (const name of promised) {
    t.eq(readme.includes(name), true, `README 必须提到「${name}」（用户排查入口）`);
    t.eq(doctor.includes(name), true, `doctor.mjs 必须真有「${name}」这个检查（否则文档在骗人）`);
  }
};

tests["C98-1 QUICKSTART 必须给「重启后核对」入口（link 安装最常见的一条坑）"] = (t) => {
  const quick = nodeFs.readFileSync(nodePath.join(REPO, "QUICKSTART.md"), "utf8");
  t.eq(quick.includes("post-restart-check.mjs"), true, "QUICKSTART 必须提到 post-restart-check（否则用户不知道一条命令就能核对）");
  t.eq(quick.includes("第三方 preset 的压缩后端"), true, "QUICKSTART 必须解释第三方 preset 不走棋谱压缩");
  t.eq(quick.includes("insert id 唯一性"), true, "QUICKSTART 必须给出「页面消失」的排查入口");
};

tests["C99-1 QUICKSTART 不许写死 verify-install 的项数（检查项会随版本增加）"] = (t) => {
  const quick = nodeFs.readFileSync(nodePath.join(REPO, "QUICKSTART.md"), "utf8");
  for (const stale of ["18/18", "18 项", "19/19", "19 项"]) {
    t.eq(quick.includes(stale), false, `QUICKSTART 不许写死检查项数（出现过期的「${stale}」会让用户以为少了一项）`);
  }
  t.eq(quick.includes("运行期已产出棋谱"), true, "必须保留「哪一项可能短暂为红」的说明（否则用户会误判）");
};

tests["C125 被纳入检查的每份文档都必须存在（列表本身不许指向不存在的文件）"] = (t) => {
  for (const rel of USER_DOCS) {
    t.eq(nodeFs.existsSync(nodePath.join(REPO, rel)), true, `USER_DOCS 里的 ${rel} 不存在（要么文档改名，要么列表过期）`);
  }
};

tests["C310 文档里写的 `node test|scripts/xxx.mjs` 必须真的存在（路径拼错=照抄就报错）"] = (t) => {
  // 口径：只看**当前**文档（README / QUICKSTART / HANDOFF / docs/README / docs/knowledge/*）。
  //   历史方案与审计稿（docs/方案-*、docs/现状审计-*、docs/草稿-*）是**冻结的记录**，
  //   里面写着当时的路径是正常的 —— 改它们等于篡改历史，不该被这条门逼着改。
  const files = ["README.md", "QUICKSTART.md", "HANDOFF.md", "docs/README.md"];
  const kbDir = nodePath.join(ROOT, "docs", "knowledge");
  if (nodeFs.existsSync(kbDir)) {
    for (const n of nodeFs.readdirSync(kbDir)) if (n.endsWith(".md")) files.push(`docs/knowledge/${n}`);
  }
  const missing = [];
  let checked = 0;
  for (const rel of files) {
    const full = nodePath.join(ROOT, rel);
    if (!nodeFs.existsSync(full)) continue;
    const text = nodeFs.readFileSync(full, "utf8");
    for (const m of text.matchAll(/node\s+((?:test|scripts)\/[A-Za-z0-9_./-]+\.mjs)/g)) {
      checked += 1;
      if (!nodeFs.existsSync(nodePath.join(ROOT, m[1]))) missing.push(`${rel} → ${m[1]}`);
    }
  }
  t.eq(missing, [], `当前文档里引用了不存在的脚本：${missing.join("; ")}`);
  // 防"永远绿"：当前文档里本来就该有若干条这样的命令
  t.eq(checked >= 5, true, `只扫到 ${checked} 条 node 命令 —— 正则大概失配了`);
};
