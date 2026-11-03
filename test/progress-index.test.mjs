/**
 * progress-index.test.mjs —— 进度页「最近 30 轮」索引（C429）
 *
 * 进度页已 200+ 轮、4000+ 行：现状摘要讲"现在什么状态"，但"最近改了什么"仍要人往下翻。
 * 这个索引是生成物，必须与正文一致。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { applyIndex, parseRounds, renderIndexBlock } from "../scripts/progress-index.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FILE = nodePath.join(HERE, "..", "docs", "knowledge", "进度.md");

export const tests = {};

tests["C429 索引只取最近 N 轮，且从正文解析（不写死）"] = (t) => {
  const text = [
    "# 进度",
    "",
    "## 现状摘要",
    "",
    "## 第 1 轮 · 2026-01-01 · 甲",
    "",
    "## 第 2 轮 · 2026-01-02 · 乙",
    "",
    "## 第 3 轮 · 2026-01-03 · 丙",
    "",
  ].join("\n");
  t.eq(parseRounds(text).map((r) => r.n), [1, 2, 3], "解析出三轮");
  const block = renderIndexBlock(parseRounds(text), { keep: 2 });
  t.includes(block, "第 2 轮", "keep=2 应含第 2 轮");
  t.eq(block.includes("第 1 轮"), false, "keep=2 不该含第 1 轮");
  // 插入位置：第一个 `## 第 N 轮` 之前
  const out = applyIndex(text, { keep: 2 });
  t.ok(out.indexOf("PROGRESS-INDEX:BEGIN") < out.indexOf("## 第 1 轮"), "索引必须在第一轮之前");
  t.ok(out.indexOf("## 现状摘要") < out.indexOf("PROGRESS-INDEX:BEGIN"), "索引必须在现状摘要之后");
  // 幂等：再跑一次不变
  t.eq(applyIndex(out, { keep: 2 }), out, "重复 apply 必须幂等");
};

tests["C429 仓库里的进度页索引必须是最新的（否则手改/忘刷会被打回）"] = (t) => {
  const text = nodeFs.readFileSync(FILE, "utf8");
  t.eq(applyIndex(text) === text, true, "索引过期：跑 node scripts/progress-index.mjs --write");
  t.eq(text.includes("最近 30 轮"), true, "必须有「最近 30 轮」块");
  t.eq((text.match(/<!-- PROGRESS-INDEX:BEGIN -->/g) ?? []).length, 1, "只允许一个索引块");
};
