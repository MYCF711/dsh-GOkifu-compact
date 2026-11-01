/**
 * pack-check.test.mjs —— 「包内文件必须全部来自 git 跟踪文件」判据的回归（2026-11-02，C82）
 *
 * 用纯函数测判据本身：中文路径、关键文件缺失、多打进来的文件三种情形。
 */

import { CRITICAL_FILES, comparePack } from "../scripts/pack-check.mjs";

export const tests = {};

tests["C82-1 comparePack：包内 ⊆ 跟踪 ⇒ ok；多出来的文件必须点名（含中文路径）"] = (t) => {
  const tracked = ["package.json", "src/ui.mjs", "docs/三层树设计.md", ...CRITICAL_FILES];
  const clean = comparePack({ packed: tracked, tracked });
  t.eq(clean.ok, true, "完全一致应 ok");
  t.eq(clean.untracked.length, 0, "不应有未跟踪项");

  const dirty = comparePack({ packed: [...tracked, "docs/未提交的新文档.md"], tracked });
  t.eq(dirty.ok, false, "多打进来的文件必须判失败");
  t.eq(dirty.untracked.length, 1, "要列出未跟踪项");
  t.eq(dirty.untracked[0], "docs/未提交的新文档.md", "中文路径要原样点名（不能因转义而漏报/误报）");
};

tests["C82-2 comparePack：关键文件缺失（白名单/入口被改坏）⇒ 失败并列出缺哪个"] = (t) => {
  const tracked = ["package.json", "src/ui.mjs"];
  const result = comparePack({ packed: tracked, tracked });
  t.eq(result.ok, false, "缺关键文件必须失败");
  t.eq(result.missingCritical.includes("src/engine.mjs"), true, "要列出缺的关键文件");
  t.eq(result.missingCritical.includes("lib/client.js"), true, "要列出缺的 client");
};

tests["C82-3 空输入不许抛：空包/空跟踪都要给出可判读结果"] = (t) => {
  const empty = comparePack({});
  t.eq(empty.packedCount, 0, "空包计数 0");
  t.eq(empty.ok, false, "空包必然缺关键文件 ⇒ 不 ok");
  const noCritical = comparePack({ packed: ["a"], tracked: ["a"] });
  t.eq(noCritical.ok, false, "缺关键文件仍要失败（防止「只打一个文件」被当成通过）");
};
