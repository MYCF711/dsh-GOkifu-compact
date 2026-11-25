/**
 * scripts-inventory.test.mjs —— 工装不许有"没人提过的脚本"（C676 · 繁复收敛 P4）
 *
 * ## 这条门禁要防的是什么
 * `scripts/` 有 140 个 `.mjs`。真正会腐烂的不是数量，而是**长出一个谁都不认识的文件**：
 * 它不被 `gate.mjs` 收编、不被 `test/` 引用、不在 `package.json` 里，也没在任何文档里出现过 ——
 * 下一个人只会当它是"要跑的东西"，然后白跑一次。
 *
 * 参考方案 §6.5：**"不要把一次性分析脚本留成常驻入口。它们是证据，不是工装"**。
 *
 * ## 判据（为什么要用"全仓语料"而不是只看 gate/test）
 * 我第一版只查 `gate.mjs` / `test/` / `package.json` 三处，结果报出 **71 个"孤儿"** —— 全是假的：
 * 这些脚本是被 **CHANGELOG / docs / 别的脚本**引用的（它们是有记录的一次性证据）。
 * ⇒ 判据改成：**脚本只要在全仓语料里出现过就不算孤儿**；语料 = gate + package.json + 全部 test +
 * 全部 scripts + docs/*.md + CHANGELOG + AGENTS + README。
 *
 * 这个改法本身就是一条教训：**"包含某段文字"当判据会两头出错** —— 判宽了假绿，判窄了假红。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
export const tests = {};

/** 读一个目录下所有指定后缀的文件内容（拼成一段语料）。 */
function readAll(dir, ext) {
  const abs = nodePath.join(ROOT, dir);
  if (!nodeFs.existsSync(abs)) return "";
  return nodeFs
    .readdirSync(abs, { withFileTypes: true })
    .flatMap((e) => {
      const rel = nodePath.join(dir, e.name);
      if (e.isDirectory()) return [readAll(rel, ext)];
      return e.name.endsWith(ext) ? [nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8")] : [];
    })
    .join("\n");
}

tests["C676 scripts/ 里每个脚本都必须被全仓某处引用（不许长出没人认识的文件）"] = (t) => {
  const scripts = nodeFs
    .readdirSync(nodePath.join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  t.ok(scripts.length >= 140, `脚本总数 ${scripts.length} 小于基线 140`);

  // 语料：本文件**必须排除**（它的注释里写着"scripts/"，但更重要的是它不该成为任何脚本的引用方）。
  const corpus = [
    nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "gate.mjs"), "utf8"),
    nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"),
    nodeFs.readFileSync(nodePath.join(ROOT, "CHANGELOG.md"), "utf8"),
    nodeFs.existsSync(nodePath.join(ROOT, "AGENTS.md")) ? nodeFs.readFileSync(nodePath.join(ROOT, "AGENTS.md"), "utf8") : "",
    nodeFs.existsSync(nodePath.join(ROOT, "README.md")) ? nodeFs.readFileSync(nodePath.join(ROOT, "README.md"), "utf8") : "",
    readAll("scripts", ".mjs"),
    readAll("test", ".mjs"),
    readAll("docs", ".md"),
  ].join("\n");

  const dead = scripts.filter((name) => !corpus.includes(name));
  t.eq(JSON.stringify(dead), "[]", `这些脚本全仓没人提过，要么登记进 gate/docs，要么删掉：${JSON.stringify(dead)}`);
};

tests["C676 gate.mjs 收编数不许退化（一条命令覆盖的门禁只能增不能减）"] = (t) => {
  const gateSrc = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "gate.mjs"), "utf8");
  const wired = nodeFs
    .readdirSync(nodePath.join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs") && f !== "gate.mjs" && gateSrc.includes(f));
  // 基线 14（2026-11-26，main@9ead062）。掉下去意味着"某个门禁被移出 gate.mjs"，那是退化。
  t.ok(wired.length >= 14, `gate.mjs 收编的脚本数 ${wired.length} 小于基线 14`);
};