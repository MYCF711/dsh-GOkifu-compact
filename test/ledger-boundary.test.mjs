/**
 * ledger-boundary.test.mjs —— 压缩产物的「来源与选项」保真（2026-11-01）
 *
 * 三条来自 `docs/research/03-human-memory.md` 的建议，都是**压缩本职**（不是记忆管理）：
 *   A. **出处（seq）任何降级档位都不砍** —— 来源监控：模型必须知道一条事实「哪来的」。
 *      越紧的档位越需要它，旧版却在 L2+ 整段砍掉（`seq && level <= 1`）。
 *   C. **失败原因用中段省略** —— 错误码常在开头、路径常在结尾，纯首部截断会把路径切没，
 *      而「哪个文件 EACCES」正是这条失败边唯一的判别价值。
 *   D. **OPTIONS 在 L2+ 也保留一行计数** —— 提取诱发遗忘（RIF）：只列当前路径会让模型
 *      忘记还有别的路；沉默本身就是断言（"只有这一条路"）。
 *
 * 这三条都只改**压缩产物怎么呈现**，不碰历史、不碰工具、不碰系统提示词。
 */

import { renderFailureLine, renderLedger } from "../src/rooms/ledger.mjs";

export const tests = {};

function mkEdge(over = {}) {
  return {
    id: "e1",
    from: "n1",
    to: "n2",
    intent: "bash(node test.mjs) — 跑测试看看",
    action: "bash(command=node test.mjs)",
    result: "failure",
    errorSnippet: "ERROR: EACCES: permission denied, open '/very/long/path/to/config.json'",
    evidence: { start: 10, end: 12 },
    verify: { kind: "exit", summary: "exit code: 1" },
    ts: Date.now(),
    ...over,
  };
}

function mkGraph(edges = []) {
  const now = Date.now();
  const nodes = {
    n1: { id: "n1", kind: "user", seq: 1, text: "把测试跑绿", ts: now - 3000 },
    n2: { id: "n2", kind: "agent", seq: 2, goal: "跑测试", ts: now - 2000 },
  };
  const g = {
    version: 1,
    sessionId: "s",
    cwd: "E:/x",
    order: ["n1", "n2"],
    nodes,
    edges: {},
    nextNode: 3,
    nextEdge: edges.length + 1,
    rootNode: "n1",
    rootUserNodeIds: ["n1"],
  };
  for (const e of edges) g.edges[e.id] = e;
  return g;
}

tests["A 出处（seq）在任何降级档位都保留"] = (t) => {
  const edge = mkEdge();
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const line = renderFailureLine(edge, level);
    t.includes(line, "(seq 10-12)", `level=${level} 的失败边必须保留出处（来源监控）`);
  }
};

tests["C 失败原因中段省略：错误码（首）与路径后缀（尾）都还在"] = (t) => {
  const line = renderFailureLine(mkEdge(), 3); // reasonLen = 25（最紧档）
  t.includes(line, "EACCES", "开头错误码不能在紧档位丢失");
  t.includes(line, "json", "结尾路径后缀不能在紧档位丢失");
  t.notIncludes(line, "permission denied, open", "中段应被省略（证明真的做了中段截断而不是纯首部）");
};

tests["D OPTIONS 在预算紧张时也保留一行计数（不许沉默）"] = (t) => {
  const now = Date.now();
  const option = {
    id: "e9",
    from: "n2",
    to: null,
    result: "untested",
    intent: "换一条路：grep 整个仓库找调用点",
    action: "grep(pattern=foo)",
    ts: now - 1000,
  };
  const g = mkGraph([option]);

  const loose = renderLedger(g, { now, maxTokens: 500 });
  t.includes(loose.text, "OPTIONS", "宽松预算下必须有 OPTIONS 段（列表或计数行）");

  const tight = renderLedger(g, { now, maxTokens: 120 });
  t.includes(tight.text, "OPTIONS", "预算被压到紧张时也必须留 OPTIONS 行 —— 沉默等于断言「没有别的路」");
};

tests["I 出处覆盖率指标：边行必须 100% 带 (seq …)"] = (t) => {
  const now = Date.now();
  const g = mkGraph([
    mkEdge({ id: "e1", evidence: { start: 10, end: 12 } }),
    mkEdge({ id: "e2", evidence: { start: 20, end: 21 }, intent: "bash(npm test)" }),
  ]);
  for (const maxTokens of [500, 120]) {
    const r = renderLedger(g, { now, maxTokens });
    t.eq(
      r.provenanceCoverage,
      1,
      `maxTokens=${maxTokens} 时出处覆盖率必须是 1（掉下来说明有路径在砍 seq）；实际 ${r.provenanceCoverage}`,
    );
  }
};
