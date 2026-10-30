/**
 * rooms.test.mjs —— 房间依赖方向的静态门禁（A2-1 起）
 *
 * 为什么需要它：A2/A3 的核心风险不是「代码写错」，而是**依赖方向悄悄倒流** ——
 * `src/` 里的房间回头 import 了 `scripts/` 或 `lib/` 的实现。一旦发生，
 * 「房间」就只是目录改名，契约文档里的 R-A/R-B 全部失效，而运行时**不会有任何报错**。
 *
 * 本文件按契约文档 §2.8 实现 R-A：
 *
 *   R-A：`src/**` 不得 import `../scripts/` 或 `../lib/`
 *
 * 历史：A2-1 之前这里是**红 1 处** —— `src/ui.mjs:58` 从 `../scripts/install.mjs` 取
 * `parseEngineBlock/renderEngineBlock`。A2-1 把这段格式代码搬到 `src/rooms/preset-format.mjs`
 * 之后变绿。判据本身有自检（合成违规必须被检出），防止「正则写错 ⇒ 永远绿」。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SRC = nodePath.join(ROOT, "src");

/* ───────────────────────────── 判据（纯函数） ───────────────────────────── */

/**
 * 从一个 JS/ESM 源文件文本里抽出所有 import/require 的说明符。
 * 只做静态扫描（不解析 AST）—— 本仓库的 import 形态固定，够用且零依赖。
 * @returns {string[]}
 */
export function specifiersOf(text) {
  const out = [];
  // import ... from "spec" / export ... from "spec"
  const fromRe = /(?:^|\n)\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
  // import "spec"
  const bareRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  // require("spec") / await import("spec")
  const callRe = /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [fromRe, bareRe, callRe]) {
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * R-A 判据：`src/**` 里出现的说明符不得指向仓库根的 `scripts/` 或 `lib/`。
 * 具体形态：`../scripts/…`、`../../scripts/…`、`../lib/…`，以及 Windows 分隔符变体。
 */
export function isReverseDependency(spec) {
  const norm = String(spec).replace(/\\/g, "/");
  // 任意层数的 ../ 之后紧跟 scripts/ 或 lib/
  return /^(?:\.\.\/)+(?:scripts|lib)\//.test(norm);
}

/** 递归列出目录下所有 .mjs/.js 文件（跳过 node_modules / .harness-stubs 等生成物）。 */
export function listSources(dir) {
  const out = [];
  const skip = new Set(["node_modules", ".harness-stubs", ".engine-under-test"]);
  const walk = (d) => {
    for (const ent of nodeFs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const abs = nodePath.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && (ent.name.endsWith(".mjs") || ent.name.endsWith(".js"))) out.push(abs);
    }
  };
  if (nodeFs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** 返回违规列表：[{file, spec}] */
export function findReverseDependencies(dir = SRC) {
  const bad = [];
  for (const file of listSources(dir)) {
    const text = nodeFs.readFileSync(file, "utf8");
    for (const spec of specifiersOf(text)) {
      if (isReverseDependency(spec)) bad.push({ file: nodePath.relative(ROOT, file).replace(/\\/g, "/"), spec });
    }
  }
  return bad;
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "R-A：src/** 不得 import ../scripts/ 或 ../lib/（反向依赖）"(t) {
    const bad = findReverseDependencies(SRC);
    t.eq(bad, [], `发现反向依赖：${bad.map((b) => `${b.file} → ${b.spec}`).join("; ")}`);
  },

  "R-A 判据自检：合成违规必须被检出（防止正则写错导致永远绿）"(t) {
    const cases = [
      ['import x from "../scripts/install.mjs";', true],
      ['import { y } from "../lib/client.js";', true],
      ['export { z } from "../../scripts/link-path.mjs";', true],
      ['const m = await import("../scripts/install.mjs");', true],
      ['import a from "../src/graph.mjs";', false],
      ['import b from "./rooms/preset-format.mjs";', false],
      ['import c from "../test/graph-fixtures.mjs";', false],
    ];
    for (const [text, expect] of cases) {
      const found = specifiersOf(text).some(isReverseDependency);
      t.eq(found, expect, `判据对 ${JSON.stringify(text)} 应返回 ${expect}`);
    }
  },

  "A2-1：src/ui.mjs 从房间取 preset 格式，不再碰 scripts/"(t) {
    const text = nodeFs.readFileSync(nodePath.join(SRC, "ui.mjs"), "utf8");
    t.includes(text, 'from "./rooms/preset-format.mjs"', "ui.mjs 必须从房间 import");
    t.notIncludes(text, 'from "../scripts/', "ui.mjs 不得再有对 scripts/ 的相对 import");
  },

  "A2-1：preset-format 房间的 8 个导出面齐全且 install.mjs 兼容再导一致"(t) {
    const room = nodeFs.readFileSync(nodePath.join(SRC, "rooms", "preset-format.mjs"), "utf8");
    for (const name of ["PKG_NAME", "ENTRY_ID", "replaceCompactionBlock", "engineBlock", "parseEngineBlock", "renderEngineBlock", "KEY_COMMENTS"]) {
      const declared = room.includes(`export const ${name}`) || room.includes(`export function ${name}`);
      t.eq(declared, true, `房间必须导出 ${name}`);
    }
    const install = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "install.mjs"), "utf8");
    t.includes(install, "export { PKG_NAME, ENTRY_ID, replaceCompactionBlock, engineBlock, parseEngineBlock, renderEngineBlock, KEY_COMMENTS }", "install.mjs 必须保留兼容再导");
    t.notIncludes(install, "export function replaceCompactionBlock", "install.mjs 不得再有自持实现");
  },

  "A2-1：preset 块格式逐字未变（engineBlock 21 行 / 15 个配置键）"(t) {
    // 动态 import 房间，直接比对块内容 —— 这是「一个字节都不许变」的机器判据。
    return import(pathToFileURL(nodePath.join(SRC, "rooms", "preset-format.mjs")).href).then((room) => {
      const block = room.engineBlock();
      t.eq(block.length, 21, "engineBlock 行数");
      t.eq(block[0], "# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。", "首行注释");
      t.eq(block[3], "- id: gokifu-compact", "id 行");
      t.eq(block[4], "  name: 'dsh-gokifu-compact/engine'", "name 行（单引号）");
      t.eq(block[20], "    tier2After: 8", "末行");
      const parsed = room.parseEngineBlock(block.join("\n"));
      t.eq(Object.keys(parsed.config).length, 15, "配置键数");
      t.eq(parsed.config.thresholdRatio, 0.45, "thresholdRatio 数值型");
      t.eq(parsed.config.summarizationProvider, "", "空字符串写成 ''");
    });
  },
};

// pathToFileURL 在上面动态 import 用例里用到
import { pathToFileURL } from "node:url";