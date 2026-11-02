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
import { existingIndex, parseEntries, renderIndex } from "../scripts/changelog-index.mjs";

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

tests["C124 HANDOFF 顶部的「当前状态」块必须与 package.json 版本一致"] = (t) => {
  const handoff = read("HANDOFF.md");
  const head = handoff.slice(0, 4000);
  t.includes(head, "## ✅ 当前状态", "HANDOFF 顶部必须有「当前状态」块（新读者先看这里，别让他翻 600 行日志）");
  const pkg = JSON.parse(read("package.json"));
  t.includes(head, `**${pkg.version}**`, `当前状态块必须写当前版本 ${pkg.version}`);
  // 旧版把「1.17.0 候选（未发布）」当标题，实际已 1.17.1 —— 这种漂移必须能被抓
  t.eq(head.includes("1.17.0 候选（**未发布**，当前工作树）"), false, "顶部不许再留过期的「候选未发布」标题（它曾被当成现状）");
  t.includes(head, "唯一待办", "当前状态块必须明确「唯一待办」（重启 DSH）");
};

tests["C143-2 现行文档里的「N 警告」（doctor 警告数）也必须带时间戳 + 当次输出"] = (t) => {
  // 与 C117 同一纪律：doctor 警告数会随 live 数据变化（本轮就因 delta 重放从 4 变 5）。
  let seen = 0;
  for (const rel of CHECKED_DOCS) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    const lines = read(rel).split(String.fromCharCode(10));
    for (const [i, line] of lines.entries()) {
      if (!/[0-9]+ 警告/.test(line)) continue;
      seen += 1;
      const context = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
      const dated = /20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(context);
      const live = context.includes("当次输出");
      t.eq(dated && live, true, `${rel}:${i + 1} 的「N 警告」必须同时带时间戳与「当次输出」提示（live 数据会变）`);
    }
  }
  t.eq(seen > 0, true, "至少要有一处现行文档记录 doctor 警告数（否则判据形同虚设）");
};

tests["C152 根目录计划表必须带「已停止更新」横幅（别让它被当成现值）"] = (t) => {
  const text = read("计划表.md");
  const head = text.slice(0, 1200);
  t.includes(head, "已停止更新", "顶部必须有「已停止更新」字样");
  t.eq(/20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(head), true, "横幅必须带日期（否则无法判断过期程度）");
  t.includes(head, "HANDOFF.md", "必须指向当前状态的真实出处");
  t.includes(head, "CHANGELOG.md", "必须指向逐条改动记录");
};

tests["C158 现行文档里的「N passed」必须彼此一致（单一真相，防一处更新一处忘）"] = (t) => {
  const seen = [];
  for (const rel of CHECKED_DOCS) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    for (const m of read(rel).matchAll(/(\d+)\s+passed/g)) seen.push({ rel, n: Number(m[1]) });
  }
  t.eq(seen.length > 0, true, "至少要有一处现行文档记录测试数");
  const values = new Set(seen.map((x) => x.n));
  t.eq(values.size, 1, `现行文档之间的测试数必须一致，实际：${seen.map((x) => x.rel + "=" + x.n).join(" / ")}`);
  const only = [...values][0];
  t.eq(only >= 800, true, `测试数 ${only} 明显偏低（可能忘更新）：${seen.map((x) => x.rel).join(" / ")}`);
};

tests["C165 HANDOFF 的「当前状态」块不许写坏：每行都是表格行，且行标签不重复"] = (t) => {
  const text = read("HANDOFF.md");
  const start = text.indexOf("## ✅ 当前状态");
  t.eq(start >= 0, true, "HANDOFF 必须有「当前状态」块");
  const end = text.indexOf(String.fromCharCode(10) + "---", start);
  t.eq(end > start, true, "状态块后面必须有分隔线");
  const lines = text.slice(start, end).split(String.fromCharCode(10)).filter((l) => l.trim().length > 0);
  const seen = new Set();
  for (const [i, line] of lines.entries()) {
    if (i <= 1) continue; // 标题 + 空行/表头
    t.eq(line.startsWith("|"), true, `状态块第 ${i + 1} 行不是表格行（写坏的典型形态）：${line.slice(0, 60)}`);
    const label = (line.split("|")[1] ?? "").trim();
    if (label === "" || label.includes("---")) continue; // 分隔行
    t.eq(seen.has(label), false, `状态块出现重复行标签「${label}」（编辑时把一行拆成了两行）`);
    seen.add(label);
  }
  t.eq(seen.size >= 8, true, `状态块标签数量异常偏少（${seen.size}），可能被截断`);
};

tests["C169 CHANGELOG 的 C 轮索引必须与正文一致（170 条靠它导航）"] = (t) => {
  const text = read("CHANGELOG.md");
  const entries = parseEntries(text);
  t.eq(entries.length >= 150, true, `条目数异常偏少（${entries.length}），可能解析出了问题`);
  const have = existingIndex(text);
  t.eq(have !== null, true, "CHANGELOG 必须有 C 轮索引块（tools：node scripts/changelog-index.mjs --write）");
  const want = renderIndex(entries);
  t.eq(have === want, true, "索引与正文不一致 —— 先跑 node scripts/changelog-index.mjs --write");
};

tests["C190 现行文档不许写死「包内 N files/个文件」（包会随新增文件变化，写死必漂移）"] = (t) => {
  const files = [
    "README.md",
    "docs/压缩的职责边界.md",
    "docs/压缩的重注入契约.md",
    "docs/发布就绪-2026-11-02.md",
    "evidence/持续优化-总览-2026-11-02.md",
    "evidence/巡检-第4次-2026-11-02.md",
  ];
  const offenders = [];
  const re = new RegExp("包内.{0,14}?(\d+)\s*(?:files|个文件)");
  for (const rel of files) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    for (const line of read(rel).split(String.fromCharCode(10))) {
      if (!re.test(line)) continue;
      if (/第 ?3 ?次|终验|C81|巡检-第3次/.test(line)) continue; // 历史快照允许
      offenders.push(`${rel}: ${line.trim().slice(0, 60)}`);
    }
  }
  t.eq(offenders.length, 0, `现行文档写死了包内文件数（改为「以 pack-check 当次输出为准」）：${offenders.join(" / ")}`);
};
