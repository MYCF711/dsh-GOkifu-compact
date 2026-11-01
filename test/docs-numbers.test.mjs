/**
 * docs-numbers.test.mjs —— 文档里的**关键数字锚**必须与代码一致（2026-11-02，C100）
 *
 * 前面几轮反复踩到同一类问题：文档写死的数字过期（bench 447/446/430、verify-install 18 项、
 * doctor 警告数、fold 次数…）。逐个人肉修复不可持续 —— 这里把**代码里已有唯一来源**的锚变成判据：
 *
 *   ① 文档里「boundary-audit N 条规则」的 N 必须等于 `RULES.length`；
 *   ② 文档里 bench 的 `**N tokens**` 必须等于 `scripts/bench-repro.mjs` 的 `EXPECTED_TOKENS`。
 *
 * 只在**面向用户/合同的文档**里查（README / 职责边界 / 重注入契约 / 发布就绪）；
 * 历史计划文档（`docs/方案-*.md`）与 evidence 快照记录的是「当时的事实」，不参与。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../scripts/boundary-audit.mjs";
import { SCHEMA } from "../src/rooms/config-schema.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

const CHECKED_DOCS = ["README.md", "docs/压缩的职责边界.md", "docs/压缩的重注入契约.md", "docs/发布就绪-2026-11-02.md"];

const read = (rel) => nodeFs.readFileSync(nodePath.join(REPO, rel), "utf8");

tests["C100-1 文档「boundary-audit N 条规则」必须等于 RULES.length"] = (t) => {
  let seen = 0;
  for (const rel of CHECKED_DOCS) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    const text = read(rel);
    for (const m of text.matchAll(/boundary-audit`?[^\n]{0,24}?(\d+)\s*条规则/g)) {
      seen += 1;
      t.eq(Number(m[1]), RULES.length, `${rel} 里的「${m[1]} 条规则」与代码 RULES.length=${RULES.length} 不一致`);
    }
  }
  t.eq(seen > 0, true, "至少要有一处文档提到 boundary-audit 的规则条数（否则这条判据形同虚设）");
};

tests["C100-2 文档里 bench 的「N tokens」必须等于 bench-repro 的 EXPECTED_TOKENS"] = (t) => {
  const src = read("scripts/bench-repro.mjs");
  const m = src.match(/const EXPECTED_TOKENS = (\d+);/);
  t.eq(m !== null, true, "bench-repro.mjs 必须有 EXPECTED_TOKENS 常量");
  const expected = Number(m[1]);
  let seen = 0;
  for (const rel of CHECKED_DOCS) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    const text = read(rel);
    for (const hit of text.matchAll(/\*\*(\d+) tokens\*\*/g)) {
      seen += 1;
      t.eq(Number(hit[1]), expected, `${rel} 里的「${hit[1]} tokens」与 EXPECTED_TOKENS=${expected} 不一致（改了基线就要同步文档）`);
    }
  }
  t.eq(seen > 0, true, "至少要有一处文档写 bench 的 tokens 数");
};

tests["C101-1 文档「fold 间隔 < N 事件」必须等于 engine 的 THRASH_SEQ"] = (t) => {
  const engine = read("src/engine.mjs");
  const m = engine.match(/const THRASH_SEQ = (\d+);/);
  t.eq(m !== null, true, "engine.mjs 必须有 THRASH_SEQ 常量");
  const expected = Number(m[1]);
  let seen = 0;
  for (const rel of [...CHECKED_DOCS, "docs/压缩质量-现有观测盘点与缺口.md"]) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    for (const hit of read(rel).matchAll(/间隔\s*<?\s*(\d+)\s*事件/g)) {
      seen += 1;
      t.eq(Number(hit[1]), expected, `${rel} 里的「间隔 ${hit[1]} 事件」与 THRASH_SEQ=${expected} 不一致`);
    }
  }
  t.eq(seen > 0, true, "至少要有一处文档写 thrash 窗口（否则判据形同虚设）");
};

tests["C101-2 文档里的 hotLedgerMaxTokens 默认值必须等于配置 schema"] = (t) => {
  const entry = SCHEMA.find((row) => row.key === "hotLedgerMaxTokens");
  t.eq(!!entry, true, "config-schema 必须有 hotLedgerMaxTokens");
  const expected = Number(entry.default);
  t.eq(Number.isFinite(expected), true, "默认值必须是数字");
  let seen = 0;
  for (const rel of ["README.md", "QUICKSTART.md"]) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    const text = read(rel);
    const docLines = text.split(String.fromCharCode(10)).filter((line) => line.includes("hotLedgerMaxTokens"));
    for (const line of docLines) {
      const hit = line.match(/(\d{2,5})/);
      if (hit === null) continue;
      seen += 1;
      t.eq(Number(hit[1]), expected, `${rel} 里的 hotLedgerMaxTokens=${hit[1]} 与 schema 默认 ${expected} 不一致`);
    }
  }
  t.eq(seen > 0, true, "用户文档至少要提一次 hotLedgerMaxTokens 的数值");
};

tests["C117 现行文档里的「N passed」必须带时间戳或当次输出提示（否则必然过期）"] = (t) => {
  // 纪律：测试数会变，写死就一定会过期。允许两种写法：
  //   ① 「当次输出」+ 时间戳；② 明确标注「以当次输出为准」。
  // 历史文档（方案-*.md / P0-*.md / 现状审计）不参与 —— 它们记录的是当时的事实。
  let seen = 0;
  for (const rel of CHECKED_DOCS) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    const lines = read(rel).split(String.fromCharCode(10));
    for (const [i, line] of lines.entries()) {
      if (!/[0-9]+ passed/.test(line)) continue;
      seen += 1;
      const context = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
      const dated = /20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(context);
      const live = context.includes("当次输出");
      t.eq(dated && live, true, `${rel}:${i + 1} 的「N passed」必须同时带时间戳与「当次输出」提示（测试数会变，写死必过期）`);
    }
  }
  t.eq(seen > 0, true, "至少要有一处现行文档记录测试数（否则判据形同虚设）");
};
