/**
 * rooms.test.mjs —— 房间依赖方向的静态门禁（A2-1 起）
 *
 * 为什么需要它：A2/A3 的核心风险不是「代码写错」，而是**依赖方向悄悄倒流** ——
 * `src/` 里的房间回头 import 了 `scripts/` 或 `lib/` 的实现。一旦发生，
 * 「房间」就只是目录改名，契约文档里的 R-A/R-B 全部失效，而运行时**不会有任何报错**。
 *
 * 本文件按契约文档 §2.8 实现 R-A，并按 §4.1 的「新增房间检查清单」实现 C3：
 *
 *   R-A：`src/**` 不得 import `../scripts/` 或 `../lib/`
 *   C3 ：`src/rooms/` 下**每个** .mjs 文件都必须在 `ROOMS` 表里登记（反向也成立）
 *
 * 历史：A2-1 之前这里是**红 1 处** —— `src/ui.mjs:58` 从 `../scripts/install.mjs` 取
 * `parseEngineBlock/renderEngineBlock`。A2-1 把这段格式代码搬到 `src/rooms/preset-format.mjs`
 * 之后变绿。判据本身有自检（合成违规必须被检出），防止「正则写错 ⇒ 永远绿」。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SRC = nodePath.join(ROOT, "src");
/** 本文件自身路径（扫描时跳过：它的自检夹具里含旧路径字符串）。 */
const SELF = nodePath.join(HERE, "rooms.test.mjs");

/**
 * 房间登记表（C3）：`src/rooms/` 下每个文件都必须在这里有一行，且每个房间至少要有一条
 * 「只能依赖谁 / 绝不能依赖谁」的方向断言。新增房间不登记 ⇒ C3 红。
 *
 * `allowed` 是白名单（说明符前缀），`forbid` 是黑名单（正则）。房间的依赖面必须能被
 * 这两张表解释 —— 不许「悄悄多一个 import」。
 */
const ROOMS = {
  "preset-format": {
    file: "preset-format.mjs",
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "config-schema": {
    file: "config-schema.mjs",
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "kifu-persist": {
    file: "kifu-persist.mjs",
    allowed: ["node:fs", "node:path", "./kifu-model.mjs"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "hot-inject": {
    file: "hot-inject.mjs",
    allowed: ["./kifu-model.mjs", "./ledger.mjs"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "verify": {
    file: "verify.mjs",
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "fold-planner": {
    file: "fold-planner.mjs",
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "world": {
    file: "world.mjs",
    // 契约 R05：允许 R00（sha/hashSet）+ node:fs/node:path
    allowed: ["node:fs", "node:path", "./kifu-model.mjs"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "kifu-model": {
    file: "kifu-model.mjs",
    // 契约 R00：零仓库依赖，只允许 node:crypto
    allowed: ["node:crypto"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "keeper": {
    file: "keeper.mjs",
    // 契约 R03：允许 R00（图函数）+ R04（classify）
    allowed: ["./kifu-model.mjs", "./verify.mjs"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "ledger": {
    file: "ledger.mjs",
    // 契约 R06：允许 R00（图查询）+ R04（weakKindOf）；实现不用 node:path，故不登记
    allowed: ["./kifu-model.mjs", "./verify.mjs"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "facts-prompt": {
    file: "facts-prompt.mjs",
    // 契约 R07：零依赖（纯文本拼装，不 import 任何东西）
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "manual-compact": {
    file: "manual-compact.mjs",
    // R16（task-174）：手动压缩失败诊断。零依赖纯函数 —— 只吃 error 对象，不许碰宿主/engine/scripts/lib。
    allowed: [],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
  "migrate": {
    file: "migrate.mjs",
    // 契约 R14 + P6C-2：R00 只读、R01 路径规则（graphRoot）、R06 判据（classifyDangling 单一来源）、
    // node:fs/path/crypto；禁止 engine / scripts / lib / @deepseek-ai（R-E 另有断言）
    allowed: ["./kifu-model.mjs", "./kifu-persist.mjs", "./ledger.mjs", "node:fs", "node:path", "node:crypto"],
    forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//],
  },
};

/** 房间文件里所有「既不在 allowed 前缀里、也不命中 forbid」的说明符 = 意外依赖。 */
export function roomDependencyViolations(roomFile) {
  const entry = Object.values(ROOMS).find((r) => r.file === roomFile);
  if (!entry) return [{ file: roomFile, spec: "(未登记)", reason: "C3" }];
  const text = nodeFs.readFileSync(nodePath.join(SRC, "rooms", roomFile), "utf8");
  const bad = [];
  for (const spec of specifiersOf(text)) {
    if (entry.forbid.some((re) => re.test(spec))) {
      bad.push({ file: roomFile, spec, reason: "forbidden" });
      continue;
    }
    if (!entry.allowed.some((prefix) => spec === prefix || spec.startsWith(prefix))) {
      bad.push({ file: roomFile, spec, reason: "not-allowed" });
    }
  }
  return bad;
}

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

/* ─────────────── A3-2-fix（task-104）：门面删除后的两条新门禁 ─────────────── */

/** A3-2 删掉的 8 个旧门面文件名。它们只允许以 `src/rooms/<room>.mjs` 的形态存在。 */
export const DELETED_FACADES = ["verifier.mjs", "range.mjs", "worldstate.mjs", "graph.mjs", "keeper.mjs", "extract.mjs", "ledger.mjs", "summary-prompt.mjs"];

/** `src/` 顶层允许的模块（永久路径）：其余 .mjs 一律判违规（点开头的生成物不计）。 */
export const SRC_TOP_LEVEL_ALLOWED = ["engine.mjs", "ui.mjs"];

/**
 * 纯判据：给定 `src/` 顶层文件名列表，返回违规项。
 * 为什么需要：A3-2 删掉 8 个门面后，把任意一个门面恢复回来，全量测试仍然全绿
 * （旧 import 已经全改成 rooms 了）—— 门面就成了「删了也没人发现」的死文件。
 */
export function topLevelOffenders(names) {
  return names
    .filter((n) => !String(n).startsWith(".") && /\.(mjs|js)$/.test(n) && !SRC_TOP_LEVEL_ALLOWED.includes(n))
    .sort();
}

/**
 * 纯判据：从一段源码里抽出「引用已删门面」的说明符。
 * - 静态 `import … from` / 动态 `import(…)` / `require(…)` 都算；
 * - 按解析后的绝对路径判定：只有解析到 `src/<旧门面>.mjs` 才算违规；
 *   `src/rooms/ledger.mjs` 里的 `./ledger.mjs` 解析到 `src/rooms/ledger.mjs` ⇒ 放行；
 * - 字符串字面量里的例句（如本文件自检夹具）不是 import，不会被 specifiersOf 命中。
 */
export function deletedFacadeRefs(text, fileDir, root = ROOT) {
  const bad = [];
  const srcDir = nodePath.join(root, "src");
  for (const spec of specifiersOf(text)) {
    if (!String(spec).startsWith(".")) continue;
    const abs = nodePath.resolve(fileDir, spec);
    if (nodePath.dirname(abs) === srcDir && DELETED_FACADES.includes(nodePath.basename(abs))) bad.push(spec);
  }
  return bad;
}

/** 仓库根相对路径的加载点（夹具的 `__pick__("src/…")` 与 `join(SRC, …)`）。 */
export function deletedFacadeRepoRefs(text) {
  const bad = [];
  for (const re of [/__pick__\(\s*["']([^"']+)["']/g, /\bjoin\(\s*SRC\s*,\s*["']([^"']+)["']/g]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const rel = String(m[1]).replace(/\\/g, "/");
      if (DELETED_FACADES.includes(nodePath.posix.basename(rel)) && !rel.includes("/rooms/")) bad.push(m[1]);
    }
  }
  return bad;
}

/** 扫一片目录，返回所有「引用已删门面」的文件与说明符。 */
export function findDeletedFacadeReferences(dirs = [SRC, nodePath.join(ROOT, "test")], skip = [SELF]) {
  const out = [];
  for (const dir of dirs) {
    for (const file of listSources(dir)) {
      if (skip.includes(file)) continue; // 本文件自身：`__pick__("src/graph.mjs")` 是判据自检的字符串夹具，不是真加载
      const text = nodeFs.readFileSync(file, "utf8");
      const rel = nodePath.relative(ROOT, file).split(nodePath.sep).join("/");
      for (const spec of deletedFacadeRefs(text, nodePath.dirname(file))) out.push({ file: rel, spec });
      for (const spec of deletedFacadeRepoRefs(text)) out.push({ file: rel, spec });
    }
  }
  return out;
}

/* ─────────────── A3-3（task-105）：最终路径 + C1/R-C/R-E/R-F 四条收口门禁 ─────────────── */

const SCRIPTS = nodePath.join(ROOT, "scripts");
const LIB = nodePath.join(ROOT, "lib");

/** 契约 R09（engine-sheath）的 4 个已知宿主 specifier —— 多一个少一个都要红。 */
export const R09_DEEPSEEK_SPECIFIERS = [
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/schemastery",
];

/** 纯判据：rooms 表的「最终路径」必须与契约一致（`file === <id>.mjs`，且真的落在 src/rooms/）。 */
export function roomPathViolations(rooms = ROOMS, srcDir = SRC) {
  const out = [];
  for (const [id, entry] of Object.entries(rooms)) {
    if (entry.file !== `${id}.mjs`) out.push(`${id}: file=${entry.file}（契约要求 ${id}.mjs）`);
    else if (!nodeFs.existsSync(nodePath.join(srcDir, "rooms", entry.file))) out.push(`${id}: src/rooms/${entry.file} 不存在`);
  }
  return out;
}

/** 纯判据：一段源码里的宿主 specifier（去重排序）。 */
export function deepseekSpecifiers(text) {
  return [...new Set(specifiersOf(text).filter((s) => String(s).startsWith("@deepseek-ai/")))].sort();
}

/** C1/R-C：除 `src/engine.mjs`（R09）外，`src/**` 不得出现任何 `@deepseek-ai/*` 的 import。 */
export function c1Violations(srcDir = SRC) {
  const out = [];
  const engine = nodePath.join(srcDir, "engine.mjs");
  for (const file of listSources(srcDir)) {
    if (file === engine) continue;
    for (const spec of deepseekSpecifiers(nodeFs.readFileSync(file, "utf8"))) {
      out.push({ file: nodePath.relative(ROOT, file).split(nodePath.sep).join("/"), spec });
    }
  }
  return out;
}

/** R-E：engine 不得 import R14（migrate）；R14 存在时也不得 import engine。 */
export function rEViolations(engineText, migrateText = null) {
  const bad = [];
  for (const spec of specifiersOf(engineText)) {
    if (/(^|\/)migrate\.mjs$/.test(String(spec).replace(/\\/g, "/"))) bad.push({ where: "engine", spec });
  }
  if (migrateText !== null) {
    for (const spec of specifiersOf(migrateText)) {
      if (/(^|\/)engine\.mjs$/.test(String(spec).replace(/\\/g, "/"))) bad.push({ where: "migrate", spec });
    }
  }
  return bad;
}

/** R-F：`src/**`、`scripts/**`、`lib/**` 不得出现 `allowedModels` 字样（宿主全局配置，插件不读不写）。 */
export function bannedTokenHits(dirs = [SRC, SCRIPTS, LIB], token = "allowedModels") {
  const hits = [];
  for (const dir of dirs) {
    for (const file of listSources(dir)) {
      if (nodeFs.readFileSync(file, "utf8").includes(token)) hits.push(nodePath.relative(ROOT, file).split(nodePath.sep).join("/"));
    }
  }
  return hits;
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

  "A2-1：preset 块格式逐字未变（engineBlock 22 行 / 16 个配置键；S8 加 firstFoldRatio）"(t) {
    // 动态 import 房间，直接比对块内容 —— 这是「一个字节都不许变」的机器判据。
    return import(pathToFileURL(nodePath.join(SRC, "rooms", "preset-format.mjs")).href).then((room) => {
      const block = room.engineBlock();
      t.eq(block.length, 22, "engineBlock 行数");
      t.eq(block[0], "# ★ 压缩后端：棋谱式增量 fold（失败记忆 + 手割 + 置换检测）。", "首行注释");
      t.eq(block[3], "- id: gokifu-compact", "id 行");
      t.eq(block[4], "  name: 'dsh-gokifu-compact/engine'", "name 行（单引号）");
      t.eq(block[8], "    firstFoldRatio: 0.30      # 首折阈值：只作用于本会话第一次 fold（0 = 关闭）", "S8 首折行（紧跟在 thresholdRatio 之后）");
      t.eq(block[21], "    tier2After: 8", "末行");
      const parsed = room.parseEngineBlock(block.join("\n"));
      t.eq(Object.keys(parsed.config).length, 16, "配置键数");
      t.eq(parsed.config.thresholdRatio, 0.45, "thresholdRatio 数值型");
      t.eq(parsed.config.firstFoldRatio, 0.3, "firstFoldRatio 数值型（0.30 → 0.3）");
      t.eq(parsed.config.summarizationProvider, "", "空字符串写成 ''");
    });
  },

  "C3：src/rooms/ 下每个 .mjs 都必须在 ROOMS 表里登记（且表里不许有幽灵文件）"(t) {
    const files = nodeFs
      .readdirSync(nodePath.join(SRC, "rooms"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
      .map((e) => e.name)
      .sort();
    const registered = Object.values(ROOMS).map((r) => r.file).sort();
    t.eq(files, registered, "房间文件集合必须与 ROOMS 表登记完全一致（新增房间不登记 ⇒ 红）");
  },

  "C3 判据自检：未登记的房间文件必须被判为违规（防止表扫描写错导致永远绿）"(t) {
    const bad = roomDependencyViolations("__not_a_room__.mjs");
    t.eq(bad.length, 1, "未登记文件必须返回 1 条 C3 违规");
    t.eq(bad[0].reason, "C3", "原因必须是 C3");
  },

  "方向：preset-format / config-schema / kifu-persist / hot-inject / verify / fold-planner / world / kifu-model / keeper / ledger / facts-prompt / migrate 只允许各自的依赖面（不得 import @deepseek-ai/engine/scripts/lib）"(t) {
    for (const roomFile of ["preset-format.mjs", "config-schema.mjs", "kifu-persist.mjs", "hot-inject.mjs", "verify.mjs", "fold-planner.mjs", "world.mjs", "kifu-model.mjs", "keeper.mjs", "ledger.mjs", "facts-prompt.mjs", "migrate.mjs"]) {
      const bad = roomDependencyViolations(roomFile);
      t.eq(bad, [], `${roomFile} 依赖面违规：${bad.map((b) => `${b.spec} (${b.reason})`).join("; ")}`);
    }
  },

  "方向：config-schema 必须零 import（单一来源不许拉任何实现）"(t) {
    const text = nodeFs.readFileSync(nodePath.join(SRC, "rooms", "config-schema.mjs"), "utf8");
    t.eq(specifiersOf(text), [], "config-schema 出现任何 import 都必须红");
  },

  "门禁①（A3-2-fix）：src/ 顶层只允许 engine.mjs / ui.mjs —— 已删的 8 个门面不许复活"(t) {
    const names = nodeFs
      .readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    const bad = topLevelOffenders(names);
    t.eq(bad, [], `src/ 顶层出现非永久路径文件：${bad.join(", ")}（A3-2 已删门面不许恢复）`);
    // 判据自检：合成违规必须被检出（防止「读错目录 ⇒ 永远绿」）
    t.eq(topLevelOffenders(SRC_TOP_LEVEL_ALLOWED), [], "engine.mjs / ui.mjs 必须放行");
    t.eq(topLevelOffenders(["engine.mjs", "ui.mjs", "graph.mjs"]), ["graph.mjs"], "合成 graph.mjs 必须被检出");
    t.eq(topLevelOffenders([".engine-under-test.mjs", "engine.mjs"]), [], "harness 生成物（点开头）不计");
  },

  "门禁②（A3-2-fix）：src/ 与 test/ 不得引用已删的 8 个门面路径（import / __pick__ / join(SRC)）"(t) {
    const bad = findDeletedFacadeReferences();
    t.eq(bad, [], `仍有对已删门面的引用：${bad.map((b) => `${b.file} → ${b.spec}`).join("; ")}`);
    // 判据自检：合成的旧 import 必须被检出，rooms/ 与同目录房间必须放行
    t.eq(deletedFacadeRefs('import { x } from "../src/graph.mjs";', nodePath.join(ROOT, "test")), ["../src/graph.mjs"], "合成旧 import 必须被检出");
    t.eq(deletedFacadeRefs('import { y } from "../src/rooms/kifu-model.mjs";', nodePath.join(ROOT, "test")), [], "rooms/ 路径必须放行");
    t.eq(deletedFacadeRefs('import { z } from "./ledger.mjs";', nodePath.join(SRC, "rooms")), [], "房间内部 ./ledger.mjs 解析到 rooms/ ⇒ 放行");
    t.eq(deletedFacadeRefs('import { z } from "./ledger.mjs";', SRC), ["./ledger.mjs"], "src 顶层的 ./ledger.mjs 必须被检出");
    t.eq(deletedFacadeRepoRefs('const m = __pick__("src/graph.mjs");'), ["src/graph.mjs"], "夹具的 __pick__ 旧路径必须被检出");
    t.eq(deletedFacadeRepoRefs('const m = __pick__("src/rooms/kifu-model.mjs");'), [], "__pick__ 的 rooms 路径必须放行");
    t.eq(deletedFacadeRepoRefs('await import(nodePath.join(SRC, "graph.mjs"));'), ["graph.mjs"], "join(SRC, *) 旧路径必须被检出");
  },

  "A3-3：rooms 表的最终路径（每个房间 file === <id>.mjs 且都落在 src/rooms/；P6C-2 起 12 个）"(t) {
    const bad = roomPathViolations();
    t.eq(bad, [], `房间最终路径违规：${bad.join("; ")}`);
    // 契约最终路径集合：11 个房间（顺序无关）
    t.eq(Object.keys(ROOMS).sort(), ["config-schema", "facts-prompt", "fold-planner", "hot-inject", "keeper", "kifu-model", "kifu-persist", "ledger", "manual-compact", "migrate", "preset-format", "verify", "world"], "房间集合必须与契约 13 个一致（P6C-2 创建 R14 migrate；task-174 创建 R16 manual-compact）");
    // 判据自检
    t.eq(roomPathViolations({ world: { file: "worldx.mjs" } }), ["world: file=worldx.mjs（契约要求 world.mjs）"], "file 名不符必须被检出");
    t.eq(roomPathViolations({ ghost: { file: "ghost.mjs" } }), ["ghost: src/rooms/ghost.mjs 不存在"], "文件不存在必须被检出");
  },

  "C1/R-C：@deepseek-ai/* 只允许出现在 src/engine.mjs（R09），且 R09 恰好 4 个已知 specifier"(t) {
    const bad = c1Violations();
    t.eq(bad, [], `R09 之外出现宿主 import：${bad.map((b) => `${b.file} → ${b.spec}`).join("; ")}`);
    const engineSpecs = deepseekSpecifiers(nodeFs.readFileSync(nodePath.join(SRC, "engine.mjs"), "utf8"));
    t.eq(engineSpecs, R09_DEEPSEEK_SPECIFIERS, "R09 的宿主 specifier 集合必须恰好是契约里的 4 个（harness 的 4 条 stub 替换依赖它）");
    // 判据自检
    t.eq(deepseekSpecifiers('import x from "@deepseek-ai/dsh-llm";'), ["@deepseek-ai/dsh-llm"], "合成宿主 import 必须被检出");
    t.eq(deepseekSpecifiers('// 注释里提到 @deepseek-ai/dsh-compaction-basic 不算 import'), [], "注释/banner 文本不算 import（preset 块里必须能写官方包名）");
  },

  "R-E：src/engine.mjs 不得 import R14（migrate）；R14 若存在也不得 import engine"(t) {
    const engineText = nodeFs.readFileSync(nodePath.join(SRC, "engine.mjs"), "utf8");
    const migratePath = nodePath.join(SRC, "rooms", "migrate.mjs");
    const migrateText = nodeFs.existsSync(migratePath) ? nodeFs.readFileSync(migratePath, "utf8") : null;
    const bad = rEViolations(engineText, migrateText);
    t.eq(bad, [], `R-E 违规：${bad.map((b) => `${b.where} → ${b.spec}`).join("; ")}`);
    // 判据自检：合成的 engine→migrate / migrate→engine 都必须被检出
    t.eq(rEViolations('import { plan } from "./rooms/migrate.mjs";').length, 1, "engine import migrate 必须被检出");
    t.eq(rEViolations('import x from "./rooms/ledger.mjs";'), [], "engine import 非 migrate 房间必须放行");
    t.eq(rEViolations("", 'import { Engine } from "../engine.mjs";').length, 1, "migrate import engine 必须被检出");
  },

  "R-F：src/、scripts/、lib/ 不得出现 allowedModels 字样（宿主全局配置，插件不读不写）"(t) {
    const hits = bannedTokenHits();
    t.eq(hits, [], `出现 allowedModels 的文件：${hits.join(", ")}`);
    // 判据自检：临时目录里放一个含禁词的文件，必须被检出（防止「扫错目录 ⇒ 永远绿」）
    const tmpDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rooms-rf-"));
    try {
      nodeFs.writeFileSync(nodePath.join(tmpDir, "x.mjs"), "const allowedModels = 1;\n", "utf8");
      t.eq(bannedTokenHits([tmpDir]).length, 1, "合成 allowedModels 文件必须被检出");
      nodeFs.writeFileSync(nodePath.join(tmpDir, "y.mjs"), "const somethingElse = 1;\n", "utf8");
      t.eq(bannedTokenHits([tmpDir]).length, 1, "不含禁词的文件不得误报");
    } finally {
      nodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
};

// pathToFileURL 在上面动态 import 用例里用到
import { pathToFileURL } from "node:url";