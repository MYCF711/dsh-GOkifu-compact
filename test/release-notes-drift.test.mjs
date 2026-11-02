/**
 * release-notes-drift.test.mjs —— 发布说明落没落下改动，必须能被机器算出来（C354）
 *
 * 由来：发布说明是用户唯一会读的版本级文档，本会话里已落后过两次，每次都是靠人翻 CHANGELOG。
 */
import { changelogNumbers, mentionedNumbers, driftOf } from "../scripts/release-notes-drift.mjs";

export const tests = {};

tests["C354 取编号：只认 ### C<数字> 标题，认范围写法"] = (t) => {
  const cl = ["### C12 · a", "### C9 · b", "#### C100 不是标题", "### C9 · dup", "### 无编号"].join("\n");
  t.eq(changelogNumbers(cl), [9, 12], "去重 + 升序，且只认三级标题");

  const notes = "见 C1–C5 与 C20、C9-C11";
  const got = mentionedNumbers(notes);
  for (const n of [1, 2, 3, 4, 5, 9, 10, 11, 20]) t.eq(got.has(n), true, `应包含 C${n}`);
  t.eq(got.has(6), false, "范围外的 C6 不该被算进来");
};

tests["C354 漂移：只报 since 之后的缺口（否则会把历史版本全报成遗漏）"] = (t) => {
  const cl = ["### C1 · x", "### C2 · x", "### C3 · x", "### C4 · x"].join("\n");
  // 发布说明提到 C1–C2 ⇒ 默认从 C3 起算
  const notes = "本版含 C1–C2";
  const r = driftOf(cl, notes, { since: 3 });
  t.eq(r.missing, [3, 4], "只报 C3 / C4");
  t.eq(r.scoped, [3, 4], "scoped 也要只看范围");
  // 全提到 ⇒ 没缺口
  t.eq(driftOf(cl, "C3 与 C4 都写了", { since: 3 }).missing, [], "都提到就不报");
  // since 默认 0 ⇒ 全量（保留旧行为给需要时用）
  t.eq(driftOf(cl, "C1–C2").missing, [3, 4], "默认从 0 起只报未提到的");
};

tests["C355 输出前缀：有遗漏必须用 `!` 开头（门禁的参考门只摘 !/✗ 行，用 ⚠ 会被吞）"] = async (t) => {
  const { spawnSync } = await import("node:child_process");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const script = nodePath.join(here, "..", "scripts", "release-notes-drift.mjs");

  const miss = spawnSync(process.execPath, [script, "--since", "1"], { encoding: "utf8" });
  const missLines = String(miss.stdout ?? "").split("\n").map((l) => l.trim());
  t.eq(missLines.some((l) => l.startsWith("! 漏了")), true, `有遗漏时必须输出「! 漏了 …」：${miss.stdout?.slice(0, 200)}`);

  const clean = spawnSync(process.execPath, [script], { encoding: "utf8" });
  t.includes(String(clean.stdout ?? ""), "没有遗漏", "当前仓库状态应无遗漏（否则先补发布说明）");
};
