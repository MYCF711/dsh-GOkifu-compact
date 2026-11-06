/**
 * 生成 test/fixtures/entry-argv/ 下的夹具（可重跑；夹具源码逐字取自 git HEAD 或工作区）。
 *
 * 为什么夹具要另存一份、而不是测试时现复制工作区文件：
 *   C-12 的负例是「**旧判据**在非 ASCII 文件名下静默不执行」。要让这条断言**永远**红，
 *   必须手里有一份旧判据的逐字副本 —— 否则修完之后就再也构造不出负例了。
 *   正例则是每次现复制工作区文件，保证测的是**这一版**代码。
 *
 * 夹具如何找到仓库（只用合法 ESM）：
 *   ESM 的 import 说明符必须是字符串字面量 ⇒ 静态 import 按原样保留；
 *   加载仓库模块改用 createRequire + require(绝对路径)（CJS 解析器接受原生路径）。
 *   引导块插在 nodePath 那行 import 之后，此时 nodePath 已绑定。
 *   为什么不用 dynamic import(原始路径)：Windows 绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = "D:/主工作区/projects/dsh-chess-context";
const OUT = nodePath.join(REPO, "test", "fixtures", "entry-argv");
const git = (rev) => execFileSync("git", ["-C", REPO, "show", rev], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const PREAMBLE = [
  "// ── 夹具专用引导（test/fixtures/entry-argv/gen.mjs 生成；勿手改）──",
  'import { createRequire as __createRequire__ } from "node:module";',
  'import { pathToFileURL as __pathToFileURL__ } from "node:url";',
  "// 仓库根：环境变量优先（被 import 时没有 CLI 参数可借）",
  'const __REPO__ = nodePath.resolve(process.env.GOKIFU_REPO_ROOT || process.argv[3] || ".");',
  'const __require__ = __createRequire__(__pathToFileURL__(nodePath.join(__REPO__, "package.json")));',
  "const __pick__ = (rel) => __require__(nodePath.join(__REPO__, rel));",
  "",
].join("\n");

/** 走行：静态 import 原样保留；仓库内相对导入改写成 __pick__()。 */
function rewire(text) {
  const lines = text.split("\n");
  const out = [];
  let rewired = 0;
  for (const line of lines) {
    const m = /^import (\{[^}]*\}) from "(\.\.?\/[^"]+)";$/.exec(line);
    if (!m) {
      out.push(line);
      if (line === 'import nodePath from "node:path";') out.push(PREAMBLE);
      continue;
    }
    const [, names, spec] = m;
    // task-59：夹具源也可以引 test/ 下的夹具层（"./graph-fixtures.mjs"）
    const rel = spec.startsWith("./")
      ? `test/${spec.slice(2)}`
      : nodePath.posix.normalize(spec.replace(/^\.\.\//, "")).replace(/^\.\.\//, "");
    if (!/^(src|scripts|lib|test)\//.test(rel)) throw new Error(`意外的相对导入：${spec}（夹具只支持仓库内模块）`);
    out.push(`const ${names} = __pick__(${JSON.stringify(rel)});`);
    rewired += 1;
  }
  if (rewired === 0) throw new Error("没有改写任何 import，夹具源结构变了？");
  if (!out.some((l) => l.includes("__REPO__ = nodePath.resolve"))) throw new Error("引导块没插进去（找不到 nodePath import）");
  return out.join("\n");
}

function writeIfChanged(file, text) {
  const prev = nodeFs.existsSync(file) ? nodeFs.readFileSync(file, "utf8") : null;
  if (prev === text) return "unchanged";
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
  return prev === null ? "created" : "updated";
}

/** 把本脚本逐字复制进 test/fixtures/entry-argv/gen.mjs（生成器与被生成的夹具住在一起，谁都能复跑）。 */
function mirrorSelf() {
  const self = nodePath.join(OUT, "gen.mjs");
  const prev = nodeFs.existsSync(self) ? nodeFs.readFileSync(self, "utf8") : null;
  const text = nodeFs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  if (prev === text) return "unchanged";
  nodeFs.writeFileSync(self, text, "utf8");
  return prev === null ? "created" : "updated";
}

/**
 * A3-2（2026-10-30）：旧门面删除后，夹具里从**历史 commit** 生成的 __pick__ 路径会指向已不存在的
 * src/graph.mjs / src/ledger.mjs。这里只做**模块路径**映射（不动被生成文件的任何判据代码）：
 * 旧路径 -> 新房间路径。历史 ab-old.mjs 的 judgeEntry 实现逐字保留，C-12 负例语义不变。
 */
const ROOM_ALIAS = {
  "src/graph.mjs": "src/rooms/kifu-model.mjs",
  "src/ledger.mjs": "src/rooms/ledger.mjs",
  "src/verifier.mjs": "src/rooms/verify.mjs",
  "src/range.mjs": "src/rooms/fold-planner.mjs",
  "src/worldstate.mjs": "src/rooms/world.mjs",
  "src/keeper.mjs": "src/rooms/keeper.mjs",
  "src/extract.mjs": "src/rooms/keeper.mjs",
  "src/summary-prompt.mjs": "src/rooms/facts-prompt.mjs",
};
const roomify = (text) =>
  Object.entries(ROOM_ALIAS).reduce((acc, [oldRel, newRel]) => acc.split(`__pick__(${JSON.stringify(oldRel)})`).join(`__pick__(${JSON.stringify(newRel)})`), text);


const jobs = [
  // C-12：旧判据（**必须是历史版本**）与修好后（工作区原文）各一份。
  // ★ task-59 发现：原写法用 `git("HEAD:...")`，但 HEAD 自 571a994（1.9.1 发布）起已经是
  //   修好的 judgeEntry —— 再跑生成器会把「负例」悄悄换成「正例」，C-12-1 变成假绿。
  //   旧判据（import.meta.url.endsWith(basename(...))）最后存在于 21be900；这里钉死。
  ["ab-old.mjs", roomify(rewire(git("21be900:test/ab-render.mjs")))],
  ["ab-now.mjs", roomify(rewire(nodeFs.readFileSync(nodePath.join(REPO, "test", "ab-render.mjs"), "utf8")))],
];
for (const [name, text] of jobs) console.log(name, writeIfChanged(nodePath.join(OUT, name), text));
// 负例保险：ab-old 里必须还能看到**旧判据**，否则 C-12-1 就不是负例了（会静默假绿）
{
  const oldText = nodeFs.readFileSync(nodePath.join(OUT, "ab-old.mjs"), "utf8");
  if (!/import\.meta\.url\.endsWith\(nodePath\.basename\(/.test(oldText)) {
    throw new Error("ab-old.mjs 里没有旧判据（import.meta.url.endsWith(...)）—— 负例失效，检查 OLD 基线 commit");
  }
}
console.log("gen.mjs", mirrorSelf());
