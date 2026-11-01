/**
 * patch-manifest.test.mjs —— `cordis.patch.yml` 与 `package.json` 的**身份一致性**（2026-11-02，C87）
 *
 * 安装能不能接管，最终只取决于 patch 里那一行引擎名：
 *   `name: '<包名>/engine'`
 * 包名改了而 patch 没重生成、或 patch 里的引擎行少了一个 preset，都是**装完不生效**级别的事故，
 * 而且 verify-install 只能在机器上发现问题 —— 仓库侧应该先有一条判据。
 *
 * 判据：
 *   ① 每个 preset 覆盖块都有且只有一个引擎行，名字必须正好是 `<package.json name>/engine`；
 *   ② 引擎行数量 = 官方 preset 数量（4）；
 *   ③ `insert` 里的 UI host 行也用同一个包名；
 *   ④ 不存在 `compaction-basic`（否则那个模式的压缩没被换掉）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const PATCH_FILE = nodePath.join(REPO, "cordis.patch.yml");
const PKG = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "package.json"), "utf8"));

export const tests = {};

const patchText = () => nodeFs.readFileSync(PATCH_FILE, "utf8");

tests["C87-1 引擎行 = `<包名>/engine`，且数量等于官方 preset 数（4 个）"] = (t) => {
  const text = patchText();
  const engineRows = [...text.matchAll(/^\s*name:\s*'([^']+\/engine)'\s*$/gm)].map((m) => m[1]);
  t.eq(engineRows.length, 4, `四个官方 preset 各要一行引擎，实际 ${engineRows.length}：${JSON.stringify(engineRows)}`);
  for (const row of engineRows) {
    t.eq(row, `${PKG.name}/engine`, `引擎名必须跟着 package.json 走（包名 ${PKG.name}）：${row}`);
  }
};

tests["C87-2 四个 preset 覆盖块齐全且 id 正确"] = (t) => {
  const text = patchText();
  const ids = [...text.matchAll(/^- id:\s*(preset-[a-z]+)\s*$/gm)].map((m) => m[1]);
  const want = ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"];
  t.eq(ids.length, want.length, `preset 覆盖块数量应为 ${want.length}，实际 ${ids.length}：${JSON.stringify(ids)}`);
  for (const id of want) t.eq(ids.includes(id), true, `缺 preset 覆盖块：${id}`);
};

tests["C87-3 UI host 行用同一个包名；patch 里不许再有 compaction-basic"] = (t) => {
  const text = patchText();
  const insertBlock = text.match(/- insert:\n(?:.*\n)*?\s*- id: gokifu-ui\n\s*name: '([^']+)'/);
  t.eq(insertBlock !== null, true, "patch 必须有 insert: gokifu-ui 块");
  t.eq(insertBlock[1], PKG.name, `UI host 行 name 必须是包名 ${PKG.name}，实际 ${insertBlock[1]}`);
  // ★ 只看**YAML 行**，不看注释 —— 头部注释会解释「把 compaction-basic 换成 …」，那是文档不是配置
  const lines = text.split(String.fromCharCode(10));
  const basicRows = lines.filter((line) => !line.trimStart().startsWith("#") && /^\s*name:\s*'@?deepseek-ai\/dsh-compaction-basic'/.test(line));
  t.eq(basicRows.length, 0, `patch 里不许再有 compaction-basic 配置行：${JSON.stringify(basicRows)}`);
  const basicIds = lines.filter((line) => /^\s*- id:\s*compaction-basic\s*$/.test(line));
  t.eq(basicIds.length, 0, "patch 里也不许再有 `- id: compaction-basic` 行");
};
