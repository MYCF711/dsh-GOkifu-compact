/**
 * release-tool.test.mjs —— 发布工具「只有一个 / 默认预演 / 数字不漂」（C204/C208）
 *
 * 背景：C204 我另写了一个 `release-plan.mjs`，而仓库里**早就有** `scripts/release.mjs`
 * （默认预演、`--yes` 才 tag/push/npm/Release，体检还更全）。重复工具 = 两份真相。
 * C208 删掉重复的，并把这个「不许再有第二个」与「CHANGELOG 的测试文件数必须是真的」钉成判据。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const tests = {};
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const NL = String.fromCharCode(10);

tests["C204/C208 发布工具唯一且默认预演：release.mjs「--yes 才动手」，不许再有 release-plan.mjs"] = (t) => {
  const releasePath = nodePath.join(REPO, "scripts", "release.mjs");
  t.eq(nodeFs.existsSync(releasePath), true, "必须有 scripts/release.mjs（唯一发布工具）");
  t.eq(nodeFs.existsSync(nodePath.join(REPO, "scripts", "release-plan.mjs")), false, "不许再有一个重复的发布工具（C208 已删）");
  const src = nodeFs.readFileSync(releasePath, "utf8");
  t.includes(src, 'const DRY = !argv.has("--yes")', "release.mjs 必须默认预演：只有 --yes 才动手");
};

tests["C208 CHANGELOG 当前版本段的「N 个测试文件」必须等于磁盘 test/*.test.mjs 数量（增量请写「测试文件数 +N」）"] = (t) => {
  const changelog = nodeFs.readFileSync(nodePath.join(REPO, "CHANGELOG.md"), "utf8").split(String.fromCharCode(13)).join("");
  const version = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "package.json"), "utf8")).version;
  const marker = "## " + version;
  const at = changelog.indexOf(marker);
  if (at < 0) throw new Error("CHANGELOG 必须有「## " + version + "」段");
  const headEnd = changelog.indexOf(NL, at);
  const afterHead = changelog.slice(headEnd + 1);
  const nextSection = afterHead.indexOf(NL + "## ");
  const section = (nextSection >= 0 ? afterHead.slice(0, nextSection) : afterHead).trim();
  const actual = nodeFs.readdirSync(nodePath.join(REPO, "test")).filter((f) => f.endsWith(".test.mjs")).length;

  const nums = [];
  for (const piece of section.split("个测试文件")) {
    // 从片段末尾往前收数字（允许一个空格），避免依赖正则转义
    let i = piece.length - 1;
    while (i >= 0 && piece[i] === " ") i -= 1;
    let end = i;
    while (i >= 0 && piece.charCodeAt(i) >= 48 && piece.charCodeAt(i) <= 57) i -= 1;
    if (end > i) nums.push(Number(piece.slice(i + 1, end + 1)));
  }
  for (const n of nums) {
    t.eq(n, actual, "CHANGELOG 写「" + n + " 个测试文件」与实际 " + actual + " 不符 —— 增量请写「测试文件数 +N」");
  }
  t.eq(true, true, "扫描到 " + nums.length + " 处声明（实际 " + actual + " 个测试文件）");
};
