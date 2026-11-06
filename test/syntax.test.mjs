/**
 * syntax.test.mjs —— 仓库里每个 .mjs 都必须能通过 `node --check`（C432）
 *
 * 由来：本会话里"改文件时把字符串写断"（`\n` 变真换行、转义被吞）反复出现过，
 * 每次都是跑测试/门禁时才炸 —— 而那时已经写坏了文件。
 * 这个检查把"语法坏了"变成**几秒内就能发现**的事，而不是等到某个测试挂掉再回头找。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

function listModules(dir, out = []) {
  for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) listModules(p, out);
    else if (e.name.endsWith(".mjs") || e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

export const tests = {};

tests["C432 每个 .mjs 都能通过 node --check（语法坏了要几秒内发现，而不是等测试炸）"] = (t) => {
  const files = ["src", "scripts", "lib"].flatMap((d) => (nodeFs.existsSync(nodePath.join(ROOT, d)) ? listModules(nodePath.join(ROOT, d)) : []));
  t.eq(files.length >= 40, true, `只扫到 ${files.length} 个模块 —— 目录结构变了？`);
  const bad = [];
  for (const file of files) {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status !== 0) {
      const first = String(r.stderr ?? "").split("\n").find((l) => l.includes("SyntaxError")) ?? "语法错误";
      bad.push(`${nodePath.relative(ROOT, file)}: ${first.trim()}`);
    }
  }
  t.eq(bad, [], `这些文件语法有问题：\n${bad.join("\n")}`);
};
