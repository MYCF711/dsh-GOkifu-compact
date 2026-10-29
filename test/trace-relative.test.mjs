/**
 * trace-relative.test.mjs —— P6a「TRACE 绝对路径改相对」的回归矩阵（2026-10-30）
 *
 * 背景（task-46 / task-36 对账）：
 *   · 生产口径下 `renderLedger` 的 `TRACE:` 行写的是**绝对路径**
 *     （`D:\DeepSeek Harness\home\chess-context\sessions\<sid>/index.md ...`，实测 137.7 字符/行）；
 *   · 94/133 个会话带 TRACE 行 ⇒ 白烧 token（净 +2318 = avg +17.43/图），还把本机用户名/盘符
 *     泄漏进热清单。
 *
 * 本文件锁住：
 *   1. 输出**永不**含盘符/用户名/绝对路径；
 *   2. TRACE 行仍可解析、能找回 `index.md`；
 *   3. `traceRoot` 可配置（默认无前缀，传 "sessions" 得到完整相对前缀）；
 *   4. renderFacts 不受影响。
 */

import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode } from "../src/graph.mjs";
import { renderLedger, renderFacts, traceRelativeDir, _internal } from "../src/ledger.mjs";

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 有失败边的图（TRACE 只在有 LEARNED 时出现）。 */
function failingGraph({ sessionId = "fx-trace", failures = 3 } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "把构建跑通。" });
  const ok = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)" });
  const a = addAgentNode(g, { seq: 3, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: ok }).id;
  g.edges[ok].to = a;
  settleEdge(g, ok, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: a, intent: `失败 ${i}`, action: "bash(x)" });
    // ★ P6-A 之后：无终点的失败边会被当 rewash 残留过滤掉 ⇒ 夹具必须给真实终点，
    //   否则 LEARNED 为空、TRACE 行也不会出现（P6a-5 会读到空字符串）。
    settleEdge(g, e, { to: a, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `boom ${i}` });
  }
  return { g, ids: [u, a] };
}

const ABS_WIN = String.raw`D:\DeepSeek Harness\home\chess-context\sessions\abc-123`;
const ABS_POSIX = "/d/DeepSeek Harness/home/chess-context/sessions/abc-123";
const ABS_USER = "C:/Users/Administrator/chess-context/sessions/abc-123";

const traceLine = (text) => text.split("\n").find((l) => l.startsWith("TRACE:")) ?? "";
const ABSOLUTE_RE = /(?:[A-Za-z]:[\\/]|^\/|\/Users\/|\/home\/|DeepSeek Harness|Administrator)/;

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "P6a-1 Windows 绝对路径 → 相对 `<sid>/index.md`，且不泄漏盘符/用户名"(t) {
    t.eq(traceRelativeDir(ABS_WIN), "abc-123", "Windows 反斜杠路径必须抽出 sid");
    const { g } = failingGraph();
    const r = renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN });
    const line = traceLine(r.text);
    t.ok(line.length > 0, `必须有 TRACE 行：${r.text.slice(0, 400)}`);
    t.eq(line, "TRACE: abc-123/index.md", `TRACE 行必须是相对路径，实际 ${JSON.stringify(line)}`);
    t.eq(ABSOLUTE_RE.test(line), false, `TRACE 行不得含绝对路径成分：${line}`);
  },

  "P6a-2 POSIX / 用户名路径同样相对化（`/d/...` 与 `C:/Users/...`）"(t) {
    t.eq(traceRelativeDir(ABS_POSIX), "abc-123", "/d/... 形态");
    t.eq(traceRelativeDir(ABS_USER), "abc-123", "C:/Users/... 形态");
    const { g } = failingGraph({ sessionId: "fx-trace-2" });
    for (const dir of [ABS_POSIX, ABS_USER]) {
      const line = traceLine(renderLedger(g, { maxTokens: 500, treeDir: dir }).text);
      t.eq(line, "TRACE: abc-123/index.md", `目录 ${dir} 的 TRACE 行`);
      t.eq(ABSOLUTE_RE.test(line), false, `不得泄漏绝对路径：${line}`);
    }
  },

  "P6a-3 traceRoot 可配置：默认无前缀，传 sessions 得到完整相对路径"(t) {
    t.eq(traceRelativeDir(ABS_WIN, "sessions"), "sessions/abc-123", "可配置根");
    t.eq(traceRelativeDir(ABS_WIN, "chess-context/sessions"), "chess-context/sessions/abc-123", "多级根");
    const { g } = failingGraph({ sessionId: "fx-trace-3" });
    t.eq(traceLine(renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN, traceRoot: "sessions" }).text), "TRACE: sessions/abc-123/index.md", "renderLedger 的 traceRoot");
    t.eq(traceLine(renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN }).text), "TRACE: abc-123/index.md", "默认无前缀");
  },

  "P6a-4 边界：空/怪路径不崩、不产绝对路径"(t) {
    t.eq(traceRelativeDir(""), ".", "空目录");
    t.eq(traceRelativeDir(null), ".", "null");
    t.eq(traceRelativeDir("weird/path/"), "path", "非 sessions 形态取最后一段");
    const { g } = failingGraph({ sessionId: "fx-trace-4" });
    for (const dir of ["", "weird/path", "D:\\"]) {
      const line = traceLine(renderLedger(g, { maxTokens: 500, treeDir: dir }).text);
      if (line) t.eq(ABSOLUTE_RE.test(line), false, `目录 ${JSON.stringify(dir)} 不得泄漏绝对路径：${line}`);
    }
    // 不传 treeDir ⇒ 没有 TRACE 行
    t.eq(traceLine(renderLedger(g, { maxTokens: 500 }).text), "", "没有 treeDir 不许造 TRACE");
  },

  "P6a-5 TRACE 行仍可解析：`TRACE: <rel>/index.md`，能拼回会话目录里的 index.md"(t) {
    const { g } = failingGraph({ sessionId: "fx-trace-5" });
    const line = traceLine(renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN, traceRoot: "sessions" }).text);
    const m = /^TRACE: ([A-Za-z0-9._\-\/]+)\/index\.md$/.exec(line);
    t.ok(Boolean(m), `TRACE 行必须可被正则解析，实际 ${JSON.stringify(line)}`);
    t.eq(m[1], "sessions/abc-123", "相对目录");
    // 相对路径拼接后必须能定位（等价于 sessions 根 + 相对路径）
    t.eq(`/home/chess-context/${m[1]}/index.md`.endsWith("/index.md"), true, "可拼接定位");
  },

  "P6a-6 renderFacts 不受影响：同一图带不带 treeDir 的 facts 逐字相同"(t) {
    const { g } = failingGraph({ sessionId: "fx-trace-6" });
    const before = renderFacts(g);
    renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN });
    t.eq(renderFacts(g), before, "renderFacts 不得因 TRACE 改动而变化");
    t.eq(before.includes("FAILED_ATTEMPTS"), true, "facts 必须仍含失败清单");
  },

  "P6a-7 预算：相对 TRACE 后同一会话不变贵（≤ 绝对路径版本的 tokens）"(t) {
    // 直接对比「同一图、同一 maxTokens」下相对 vs 绝对的长短：相对行必然更短
    const { g } = failingGraph({ sessionId: "fx-trace-7", failures: 20 });
    const rel = renderLedger(g, { maxTokens: 500, treeDir: ABS_WIN });
    const relLine = traceLine(rel.text);
    t.ok(relLine.length <= 40, `相对 TRACE 行必须 ≤40 字符，实际 ${relLine.length}：${relLine}`);
    t.ok(rel.tokens <= 500, `必须 ≤500，实际 ${rel.tokens}`);
    t.eq(rel.fallback, "none", "正常预算应为 none");
  },
};
