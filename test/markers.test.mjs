/**
 * markers.test.mjs —— 热清单标记契约（「给模型用，不是给人看」）
 *
 * 这一组测试锁的是 2026-10-29 修掉的三类模型消费者缺陷：
 *   1. 标记裸奔：旧版把图例绑在「检测到手割」上 ⇒ 一个只有 EACCES 失败、没有成功路径的
 *      会话里，`[blocked]` 出现了却没有任何解释。
 *   2. 图例不全：`redundant` / `longer` 真的会出现在清单里，旧图例里从来没有它们。
 *   3. 原因失踪：旧版 level ≥3 直接把 `→ 报错` 整段砍掉 ⇒ 全库实测 133 条可见失败边里
 *      只有 25 条带原因；而原因正是模型避免重犯的判据。
 * 外加两处「手割标记要真的出现」：
 *   4. 失败边 >30 条时也要给最近这批边算手割（旧版「显示条数 ≤30 才算」）。
 *   5. 多参照点：同一条失败边相对 e10 是 redundant、相对 e20 是 longer —— 两个结论都要在。
 */

import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, failureEdges, tewariAnalysis } from "../src/graph.mjs";
import { renderLedger, renderFailureLine, failureTags } from "../src/ledger.mjs";

export const tests = {};

/** 只有资源类失败、没有任何成功路径的会话（旧版在这里让 [blocked] 裸奔）。 */
function blockedOnlyGraph() {
  const g = createGraph({ sessionId: "markers-blocked" });
  const u = addUserNode(g, { seq: 1, text: "把构建跑通。不要动 prod 配置。" });
  const e1 = addEdge(g, { from: u, intent: "直接改 prod 配置", action: "write(file_path=prod.yml)" });
  // ★ P6-A：失败边必须有真实终点，否则会被当 rewash 残留过滤（本夹具要测「只有 blocked 失败」的图例）
  settleEdge(g, e1, { to: u, result: "failure", verify: { kind: "exit", summary: "EACCES" }, errorSnippet: "Error: EACCES: permission denied, open 'prod.yml'" });
  const e2 = addEdge(g, { from: u, intent: "删掉 node_modules 重装", action: "bash(rm -rf node_modules)" });
  settleEdge(g, e2, { to: u, result: "failure", verify: { kind: "exit", summary: "ETIMEDOUT" }, errorSnippet: "npm ERR! network timeout ETIMEDOUT" });
  return g;
}

/**
 * 成功路径 A：u -e10-> n2 -e11-> n3；成功路径 B：u -e20-> n4 -e21-> n2
 * 失败边 e1：u -> n2（和 e10 同终点 ⇒ redundant:e10；从 e20 的子树也到得了 ⇒ longer:e20）
 */
function multiBaselineGraph() {
  const g = createGraph({ sessionId: "markers-tewari" });
  const u = addUserNode(g, { seq: 1, text: "把构建跑通。" });
  const mk = (from, id, to, goal) => {
    const node = addAgentNode(g, { seq: 10 + g.order.length, goal, worldHash: `W${to}`, constraintHash: "C1", via: id }).id;
    g.edges[id].to = node;
    return node;
  };
  const e10 = addEdge(g, { from: u, intent: "改 dev 配置", action: "edit(file_path=dev.yml)" });
  const n2 = mk(u, e10, "n2", "dev 配置改好");
  settleEdge(g, e10, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e11 = addEdge(g, { from: n2, intent: "重新构建", action: "bash(npm run build)" });
  const n3 = mk(n2, e11, "n3", "构建通过");
  settleEdge(g, e11, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e20 = addEdge(g, { from: u, intent: "先装依赖", action: "bash(npm ci)" });
  const n4 = mk(u, e20, "n4", "依赖装好");
  settleEdge(g, e20, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e21 = addEdge(g, { from: n4, intent: "把 dev 配置写进工作区", action: "cp dev.yml" });
  g.edges[e21].to = n2; // n4 也能到 n2 ⇒ 相对 e20 是「绕路也能到」
  settleEdge(g, e21, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e1 = addEdge(g, { from: u, intent: "直接改 prod 配置", action: "write(file_path=prod.yml)" });
  g.edges[e1].to = n2;
  settleEdge(g, e1, { result: "failure", verify: { kind: "exit", summary: "EACCES" }, errorSnippet: "Error: EACCES: permission denied" });
  return { g, ids: { e1, e10, e11, e20, e21, u, n2, n3, n4 } };
}

/** 40 条失败边（超过「只对前 30 条算手割」的旧门槛）。 */
function manyFailuresGraph(n = 40) {
  const g = createGraph({ sessionId: "markers-many" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿。" });
  const e0 = addEdge(g, { from: u, intent: "改对缓存键", action: "edit(file_path=cache.js)" });
  const n2 = addAgentNode(g, { seq: 3, goal: "缓存键改好", worldHash: "W1", constraintHash: "C1", via: e0 }).id;
  g.edges[e0].to = n2;
  settleEdge(g, e0, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  for (let i = 0; i < n - 1; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个写法`, action: `bash(npm test ${i})` });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case${i} expected 1 got 2` });
    g.edges[e].to = n2; // 与成功边同终点 ⇒ 每条都该有 redundant:e0
  }
  return { g, n2, e0 };
}

tests["标记裸奔：只有 blocked 失败、没有成功路径时，图例必须出现"] = () => {
  const r = renderLedger(blockedOnlyGraph(), { maxTokens: 500 });
  if (!r.text.includes("[blocked:permission]")) throw new Error(`EACCES 没写成 blocked:permission：\n${r.text}`);
  if (!r.text.includes("[blocked:timeout]")) throw new Error(`ETIMEDOUT 没写成 blocked:timeout：\n${r.text}`);
  if (!r.text.includes("# markers:")) throw new Error(`标记出现了却没有图例（旧版 bug）：\n${r.text}`);
  if (!r.text.includes("blocked:permission =")) throw new Error(`图例没有解释 blocked:permission：\n${r.text}`);
  if (!r.text.includes("retry when it changes")) throw new Error(`图例没说清什么条件变了能再试：\n${r.text}`);
};

tests["图例按用到的标记动态生成（没用到的不出现）"] = () => {
  const r = renderLedger(blockedOnlyGraph(), { maxTokens: 500 });
  if (r.text.includes("dead =")) throw new Error("没用到 dead 却解释了 dead（浪费预算）");
  if (r.text.includes("novel =")) throw new Error("没用到 novel 却解释了 novel");
};

tests["手割标记的图例：redundant / longer 必须被解释（旧图例从来没有）"] = () => {
  const { g, ids } = multiBaselineGraph();
  const r = renderLedger(g, { maxTokens: 900 });
  if (!r.text.includes(`redundant:${ids.e10}`)) throw new Error(`缺 redundant:${ids.e10}：\n${r.text}`);
  if (!r.text.includes(`longer:${ids.e20}`)) throw new Error(`缺 longer:${ids.e20}：\n${r.text}`);
  if (!r.text.includes("redundant =")) throw new Error(`redundant 没有图例：\n${r.text}`);
  if (!r.text.includes("longer =")) throw new Error(`longer 没有图例：\n${r.text}`);
};

tests["多参照点：同一条失败边同时给出 redundant 与 longer 两个结论"] = () => {
  const { g, ids } = multiBaselineGraph();
  const e1 = g.edges[ids.e1];
  const t = tewariAnalysis(g, e1);
  if (t.baselines.length !== 2) throw new Error(`参照点应为 2 条成功出边，实际 ${t.baselines.length}`);
  if (!t.redundantVs.includes(ids.e10)) throw new Error(`相对 ${ids.e10} 应判 redundant：${JSON.stringify(t.redundantVs)}`);
  if (!t.longerVs.includes(ids.e20)) throw new Error(`相对 ${ids.e20} 应判 longer：${JSON.stringify(t.longerVs)}`);
  const merged = failureTags(e1, t);
  // 这条边的错误是 EACCES ⇒ 先判 blocked（三态的优先级），所以是 blocked + 两个手割结论并存
  if (!merged.some((x) => x.startsWith("blocked"))) throw new Error(`应判 blocked（EACCES 优先）：${JSON.stringify(merged)}`);
  if (!merged.some((x) => x.startsWith("redundant:")) || !merged.some((x) => x.startsWith("longer:"))) {
    throw new Error(`两个手割结论没有同时进标记：${JSON.stringify(merged)}`);
  }
};

tests["dead 带重开锚点：retry-if 指向那条成功边（不是永久墓碑）"] = () => {
  const { g, e0 } = manyFailuresGraph(3);
  const t = tewariAnalysis(g, failureEdges(g).find((e) => e.id !== e0));
  const tags = failureTags(failureEdges(g).find((e) => e.id !== e0), t);
  if (!tags.some((x) => x === `dead retry-if:${e0}`)) throw new Error(`dead 没带重开锚点：${JSON.stringify(tags)}`);
  const r = renderLedger(g, { maxTokens: 500 });
  if (!r.text.includes("retry only if retry-if breaks")) throw new Error(`图例没解释 retry-if：\n${r.text}`);
};

tests["TRACE：热清单指向真的三层树（不再是 v1.2.2 起就不再写的 graph.md）"] = () => {
  const { g } = manyFailuresGraph(3);
  // ★ P6a（2026-10-30）：TRACE 只给**相对**路径（`<sid>/index.md`），不再写绝对盘符/用户名。
  //   旧断言是 `TRACE: D:/x/chess-context/sessions/abc/index.md` —— 那正是 P6a 要回收的 45 token。
  const r = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/abc" });
  if (!r.text.includes("TRACE: abc/index.md")) throw new Error(`缺相对 TRACE 行：\n${r.text}`);
  if (/TRACE:[^\n]*(?:[A-Za-z]:[\\/]|\/d\/|\/Users\/)/.test(r.text)) throw new Error(`TRACE 泄漏了绝对路径：\n${r.text}`);
  if (r.text.includes("per-node detail")) throw new Error("TRACE 行不该再带长尾巴（P6a 已压掉）");
  // 可配置根：传 traceRoot 时前缀出现
  const rooted = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/abc", traceRoot: "sessions" });
  if (!rooted.text.includes("TRACE: sessions/abc/index.md")) throw new Error(`traceRoot 不生效：\n${rooted.text}`);
  if (r.text.includes("graph.md")) throw new Error("还在指向已废弃的 graph.md");
  // 不传 treeDir 时不该凭空造路径
  const plain = renderLedger(g, { maxTokens: 500 });
  if (plain.text.includes("TRACE:")) throw new Error("没有树目录却印了 TRACE");
};

tests["失败边 >30 条：最近的边仍然带手割标记（旧版一条都没有）"] = () => {
  const { g, e0 } = manyFailuresGraph(40);
  const r = renderLedger(g, { maxTokens: 500 });
  if (!r.text.includes(`retry-if:${e0}`)) throw new Error(`40 条失败边时手割标记消失（dead 应带 retry-if）：\n${r.text}`);
};

tests["原因在任何降级档位都保留（旧版 L3+ 全砍）"] = () => {
  const { g } = manyFailuresGraph(40);
  for (const maxTokens of [500, 300, 200]) {
    const r = renderLedger(g, { maxTokens });
    const edgeLines = r.text.split("\n").filter((l) => /^- e\d+ /.test(l));
    if (edgeLines.length === 0) throw new Error(`预算 ${maxTokens} 下一条失败边都没有`);
    for (const line of edgeLines) {
      if (!line.includes(" → ")) throw new Error(`预算 ${maxTokens} / L${r.level} 下丢了原因：${line}`);
    }
  }
};

tests["renderFailureLine：level 3 也带原因，只是更短"] = () => {
  const g = blockedOnlyGraph();
  const e = failureEdges(g)[0];
  const l0 = renderFailureLine(e, 0);
  const l3 = renderFailureLine(e, 3);
  if (!l0.includes(" → ")) throw new Error(`L0 缺原因：${l0}`);
  if (!l3.includes(" → ")) throw new Error(`L3 缺原因：${l3}`);
  if (l3.length >= l0.length) throw new Error(`L3 不比 L0 短：${l3.length} vs ${l0.length}`);
};

tests['markers:"off" 完全不打标记；"terse" 只写三态但图例仍在'] = () => {
  const g = blockedOnlyGraph();
  const off = renderLedger(g, { maxTokens: 500, markers: "off" });
  if (off.text.includes("[blocked")) throw new Error(`off 模式仍有标记：\n${off.text}`);
  if (off.text.includes("# markers:")) throw new Error("off 模式仍有图例");
  const terse = renderLedger(g, { maxTokens: 500, markers: "terse" });
  if (!terse.text.includes("[blocked]")) throw new Error(`terse 模式应只写三态：\n${terse.text}`);
  if (terse.text.includes("[blocked:permission]")) throw new Error("terse 模式不该带原因");
  if (!terse.text.includes("# markers:")) throw new Error(`terse 模式也要给图例：\n${terse.text}`);
};

tests["标记的 token 成本可控：图例不超过 10 行"] = () => {
  const { g } = manyFailuresGraph(40);
  const r = renderLedger(g, { maxTokens: 500 });
  const legend = r.text.split("\n").filter((l) => l.startsWith("# "));
  if (legend.length > 10) throw new Error(`图例 ${legend.length} 行，太贵`);
};

/* ═════════════════════ L4/L5 兜底档的标记契约（task-33 补） ═════════════════════
 *
 * 缺口：上面所有用例都跑在 L0–L3（预算够）或 L3（manyFailuresGraph + 500），
 * 兜底档（L4/L5）从来没被断言过 —— reviewer 的 M2 变异（L4/L5 裁决退回旧行为）在
 * ledger/markers 上 0 红。这里补的是「兜底档里 markers 三态仍生效，且标记不影响裁决」。
 */

/** 胖夹具：小预算必然落到兜底档；失败原因是 EACCES ⇒ semantic 档标 `[blocked:permission]`。 */
function fallbackGraph({ failures = 40, sessionId = "markers-fallback" } = {}) {
  const long = "你是并行工作流 WS-C17 的执行子代理，仓库在主工作区里，已有大量未提交改动必须保留。".repeat(5);
  const g = createGraph({ sessionId, cwd: "/tmp" });
  const u = addUserNode(g, { seq: 1, text: `${long}\n\n约束：${Array.from({ length: 5 }, (_, i) => `第${i + 1}条必须遵守的约束，不许删掉，也不许绕过。`).join(" ")}` });
  let cursor = u; // addUserNode 返回 id 字符串（u.id 是 undefined）
  for (let i = 0; i < 8; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步：推进一格`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1} 完成`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    cursor = node;
  }
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个写法再试一遍`, action: `bash(npm test ${i})` });
    settleEdge(g, e, {
      to: u, // ★ P6-A：无终点失败会被当 rewash 残留过滤 ⇒ 给真实终点；用自环避免 tewari 造出 novel 标记
      result: "failure",
      verify: { kind: "exit", summary: "EACCES" },
      errorSnippet: `Error: EACCES: permission denied, open '/usr/lib/node_modules/x${i}'`,
    });
  }
  return g;
}

tests['L4/L5 兜底档：markers 三态仍生效，且标记不改变兜底裁决'] = () => {
  const g = fallbackGraph();
  // 预算 1000：L0–L3 都装不下（图纸够胖），而 L4(20 条)/L5(10 条) 都装得下 ——
  // 这正是「裁决必须择优」的判别窗口：退回旧行为（走进 L4 就返回）时这里会拿到 L4。
  const sem = renderLedger(g, { maxTokens: 1000, markers: "semantic" });
  const terse = renderLedger(g, { maxTokens: 1000, markers: "terse" });
  const off = renderLedger(g, { maxTokens: 1000, markers: "off" });
  for (const [name, r] of [["semantic", sem], ["terse", terse], ["off", off]]) {
    if (r.level !== 5) throw new Error(`markers=${name} 应落到 L5（兜底择优；L4 的 20 条更费），实际 L${r.level}`);
    if (r.shownFailures !== 10 || r.omittedEdges !== 30) {
      throw new Error(`markers=${name} 不许改变兜底列多少条：shown=${r.shownFailures} omitted=${r.omittedEdges}`);
    }
  }
  if (!sem.text.includes("[blocked:permission]")) throw new Error(`semantic 兜底档应带原因：\n${sem.text}`);
  if (!sem.text.includes("blocked:permission =")) throw new Error(`semantic 兜底档缺图例：\n${sem.text}`);
  if (!terse.text.includes("[blocked]") || terse.text.includes("[blocked:")) throw new Error(`terse 兜底档只该写三态：\n${terse.text}`);
  if (!terse.text.includes("# markers:")) throw new Error(`terse 兜底档也要给图例：\n${terse.text}`);
  if (/\[(blocked|dead|redundant|longer|novel|failed|unverified)/.test(off.text)) throw new Error(`off 兜底档不许有任何标记：\n${off.text}`);
  if (off.text.includes("# markers:")) throw new Error("off 兜底档不许有图例");
  if (!(off.tokens < terse.tokens && terse.tokens <= sem.tokens)) {
    throw new Error(`标记应逐级更省：off=${off.tokens} terse=${terse.tokens} semantic=${sem.tokens}`);
  }
};
