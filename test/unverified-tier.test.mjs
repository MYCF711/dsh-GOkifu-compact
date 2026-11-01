/**
 * unverified-tier.test.mjs —— 契约 ⑤「未验证声明」在每个降级档位都不许沉默（2026-11-01）
 *
 * 为什么单独一个文件：独立验证（`tmp/verify-round2/REPORT.md` P2-2）把 `UNVERIFIED` 的 L2+ 计数行
 * 整段删掉后，全量测试**仍然全绿** —— 说明这条行为当时没有任何测试钉住，可以被无声改坏。
 * 这个零依赖用例补上那颗钉子，覆盖三种情形：
 *   1. 有（非残留）未验证边 ⇒ **任何档位**都必须出现 `UNVERIFIED`（L0/L1 完整列表、L2+ 至少计数行）；
 *   2. L0/L1 必须是完整列表（带 "ran, but no external signal" 说明），不能退化成只有计数；
 *   3. 没有未验证边 ⇒ 任何档位都不许出现 `UNVERIFIED`（不许为了"保险"加一行假计数）。
 *
 * 边界：这只改**压缩产物怎么呈现**，不碰历史、不碰工具、不碰系统提示词（见 `docs/压缩的职责边界.md`）。
 */

import { renderLedger } from "../src/rooms/ledger.mjs";

export const tests = {};

const now = Date.now();

/** 最小棋谱：n1 = 根目标（user），n2 = 当前 agent 位置。 */
function mkGraph(edges = []) {
  const nodes = {
    n1: { id: "n1", kind: "user", seq: 1, text: "把压缩产物做对", ts: now - 5000 },
    n2: { id: "n2", kind: "agent", seq: 2, goal: "整理清单", ts: now - 1000 },
  };
  const g = {
    version: 1,
    sessionId: "s-unverified",
    cwd: "E:/x",
    order: ["n1", "n2"],
    nodes,
    edges: {},
    nextNode: 3,
    nextEdge: edges.length + 1,
    rootUserNodeIds: ["n1"],
  };
  for (const edge of edges) g.edges[edge.id] = edge;
  return g;
}

/** 「跑了但没有外部验证信号」的边（result=unverified，有终点，非 residue）。 */
function unverifiedEdge(id, seq) {
  return {
    id,
    from: "n2",
    to: "n2",
    intent: "跑了一遍但没拿到退出码",
    action: "bash(node x.mjs)",
    result: "unverified",
    verify: { kind: "none", summary: "无外部信号" },
    evidence: { start: seq, end: seq + 1 },
    ts: now - 1000,
  };
}

const BUDGETS = [2000, 500, 300, 200, 150, 120, 90, 60, 30];

tests["U-1 有未验证边时，任何降级档位都不许沉默（L0/L1 列表，L2+ 至少计数行）"] = (t) => {
  const g = mkGraph([unverifiedEdge("e5", 10), unverifiedEdge("e6", 12)]);
  let sawFullList = false;
  let sawCountLine = false;
  for (const maxTokens of BUDGETS) {
    const r = renderLedger(g, { now, maxTokens });
    t.includes(
      r.text,
      "UNVERIFIED",
      `maxTokens=${maxTokens}（L${r.level}）有未验证边时必须出现 UNVERIFIED —— 沉默等于断言「没有未验证的东西」`,
    );
    if (r.text.includes("UNVERIFIED (ran, but no external signal")) sawFullList = true;
    if (/UNVERIFIED: \d+ unproven \(latest e\d+\)/.test(r.text)) sawCountLine = true;
  }
  t.eq(sawFullList, true, "宽松档位（L0/L1）必须给完整列表，而不是只有计数行");
  t.eq(sawCountLine, true, "紧档位（L2+）必须保留一行计数 + 最近一条 id（契约 ⑤ 不许沉默）");
};

tests["U-2 没有未验证边时，任何档位都不许出现 UNVERIFIED（不许加假计数）"] = (t) => {
  const g = mkGraph([]);
  for (const maxTokens of BUDGETS) {
    const r = renderLedger(g, { now, maxTokens });
    t.notIncludes(r.text, "UNVERIFIED", `maxTokens=${maxTokens}（L${r.level}）没有未验证边时不该出现 UNVERIFIED`);
  }
};

tests["U-3 残留（residue）未验证边不进热清单：那是噪声，不是「未验证声明」"] = (t) => {
  // to=null + 已结算 + 没有 ts 的老边 = rewash 残留（P6-A 分类），不该触发契约 ⑤ 的计数行
  const residue = {
    id: "e9",
    from: "n2",
    to: null,
    intent: "历史残留",
    action: "bash(true)",
    result: "unverified",
    verify: { kind: "none", summary: "无" },
    ts: now - 24 * 60 * 60 * 1000,
  };
  const g = mkGraph([residue]);
  for (const maxTokens of BUDGETS) {
    const r = renderLedger(g, { now, maxTokens });
    t.notIncludes(r.text, "UNVERIFIED", `maxTokens=${maxTokens}（L${r.level}）residue 不该触发契约 ⑤ 的输出`);
  }
};
