import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges, currentPath } from "./graph-fixtures.mjs";
import { renderLedger, renderFacts, estimateTokens, renderFailureLine, collectConstraints, _internal } from "../src/rooms/ledger.mjs";

const { traceRecentSegment } = _internal;

export const tests = {};

function buildGraph({ failures = 0, constraints = [], extraUser = null } = {}) {
  const g = createGraph({ sessionId: "ledger", cwd: "/tmp" });
  const u = addUserNodeId(g, { seq: 1, text: `把 data.jsonl 算出来。${constraints.join(" ")}` });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个解析方式`, action: `bash(npm test ${i})`, evidence: { start: 10 + i * 4, end: 13 + i * 4 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `SyntaxError: bad json at line ${i}` });
  }
  if (extraUser) addUserNodeId(g, { seq: 99, text: extraUser });
  return g;
}

tests["硬事实块逐字包含原话与每条失败原因"] = () => {
  const g = buildGraph({ failures: 3, constraints: ["必须保持 API 不变。"] });
  const facts = renderFacts(g);
  if (!facts.includes("把 data.jsonl 算出来")) throw new Error("缺原话");
  if (!facts.includes("必须保持 API 不变")) throw new Error("缺约束");
  const lines = facts.split("\n").filter((l) => l.startsWith("* e"));
  if (lines.length !== 3) throw new Error(`失败边行数 ${lines.length}`);
  if (!facts.includes("SyntaxError: bad json at line 0")) throw new Error("缺原因原文");
};

tests["没有失败边时不渲染死路段（省 token）"] = () => {
  const g = buildGraph({ failures: 0 });
  const r = renderLedger(g);
  if (r.failureCount !== 0) throw new Error("failureCount 不对");
  if (r.text.includes("LEARNED")) throw new Error("不该有死路段");
};

tests["预算不足时按档位降级（总数不丢）"] = () => {
  const g = buildGraph({ failures: 60 });
  const r = renderLedger(g, { maxTokens: 300 });
  if (r.level < 2) throw new Error(`应降级，实际 L${r.level}`);
  if (!r.text.includes("LEARNED (60 failed attempts")) throw new Error("总数丢了");
  if (r.failureCount !== 60) throw new Error("failureCount 不对");
};

tests["约束：热清单收集所有 user 节点的约束（不只 root）"] = () => {
  const g = buildGraph({ failures: 1, constraints: ["必须保持 API 不变。"], extraUser: "不要动 prod 配置，只能走测试环境。" });
  const r = renderLedger(g, { maxTokens: 2000 });
  if (!r.text.includes("必须保持 API 不变")) throw new Error("root 约束丢了");
  if (!r.text.includes("不要动 prod 配置")) throw new Error("后续 user 的约束丢了");
};

tests["约束：renderFacts 也包含全部约束"] = () => {
  const g = buildGraph({ failures: 1, constraints: ["必须保持 API 不变。"], extraUser: "不要动 prod 配置。" });
  const facts = renderFacts(g);
  if (!facts.includes("必须保持 API 不变")) throw new Error("root 约束丢了");
  if (!facts.includes("不要动 prod 配置")) throw new Error("后续 user 的约束丢了");
};

tests["extractConstraintsBlock 从事实块里逐字取出约束"] = async () => {
  const { extractConstraintsBlock } = await import("../src/rooms/facts-prompt.mjs");
  const facts = [
    "[HARD FACTS]",
    "ROOT_USER_REQUEST_VERBATIM >>",
    "把 data.jsonl 算出来。",
    "<< END ROOT_USER_REQUEST (seq 1)",
    "CONSTRAINTS_VERBATIM:",
    "* 必须保持公开 API 响应字段不变，不许改接口契约。",
    "* 不许动 prod 配置文件，任何改动只能走测试环境。",
    "FAILED_ATTEMPTS (2; keep every line):",
    "* e1 intent=\"x\" reason=\"y\"",
  ].join("\n");
  const block = extractConstraintsBlock(facts);
  if (!block.includes("必须保持公开 API 响应字段不变")) throw new Error(`丢了第一条：${block}`);
  if (!block.includes("不许动 prod 配置文件")) throw new Error(`丢了第二条：${block}`);
  if (block.includes("FAILED_ATTEMPTS")) throw new Error("越界取到了下一段");
};

tests["extractConstraintsBlock 没有约束时返回空串"] = async () => {
  const { extractConstraintsBlock } = await import("../src/rooms/facts-prompt.mjs");
  if (extractConstraintsBlock("[HARD FACTS]\nFAILED_ATTEMPTS (1):\n* e1") !== "") throw new Error("应为空");
  if (extractConstraintsBlock("") !== "") throw new Error("空输入应为空");
};

tests["estimateTokens 是保守估计"] = () => {
  if (estimateTokens("中文十个字应该超过十") < 3) throw new Error("估算过低");
  if (estimateTokens("") !== 0) throw new Error("空串应为 0");
};

tests["renderFailureLine 含 id / 意图 / 原因"] = () => {
  const g = buildGraph({ failures: 1 });
  const line = renderFailureLine(failureEdges(g)[0], 0);
  if (!line.startsWith("- e1")) throw new Error(`格式不对：${line}`);
  if (!line.includes("换个解析方式")) throw new Error("缺意图");
  if (!line.includes("SyntaxError")) throw new Error("缺原因");
};

tests["collectConstraints 去重"] = () => {
  const g = buildGraph({ failures: 0, constraints: ["必须保持 API 不变。"], extraUser: "必须保持 API 不变。" });
  const cons = collectConstraints(g);
  if (cons.filter((c) => c === "必须保持 API 不变。").length !== 1) throw new Error("没去重");
};

/* ═════════════════════ L4/L5 兜底裁决（task-33 补） ═════════════════════
 *
 * 为什么另立夹具：降级链里 L0–L3 每档都列**全部**失败边，只有 L4 列 tailFailures(20) 条、L5 列 10 条；
 * 而要走到 L4/L5，必须「L0–L3 全装不下」。上面 `buildGraph({failures:60})` 那种图在预算 300 下落的是
 * L2/L3，压根碰不到裁决分支 —— reviewer 的 M2 变异（把 L4/L5 裁决改回「走进哪档就返回哪档」）
 * 因此在 ledger/markers 上 0 红，只在 c17 上 3 红。这一组就是堵这个盲区。
 */

/** 胖夹具：长 root + 长约束 + 8 跳成功链 + N 条长原因失败边 ⇒ 小预算必然落到兜底档。 */
function fallbackGraph({ hops = 8, failures = 40, sessionId = "ledger-fallback" } = {}) {
  const long = "你是并行工作流 WS-C17 的执行子代理，仓库在主工作区里，已有大量未提交改动必须保留。".repeat(5);
  const g = createGraph({ sessionId, cwd: "/tmp" });
  const u = addUserNodeId(g, {
    seq: 1,
    text: `${long}\n\n约束：${Array.from({ length: 5 }, (_, i) => `第${i + 1}条必须遵守的约束，不许删掉，也不许绕过。`).join(" ")}`,
  });
  let cursor = u; // addUserNodeId 返回 id 字符串
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步：推进一格`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1} 完成`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    cursor = node;
  }
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个写法再试一遍`, action: `bash(npm test ${i})` });
    settleEdge(g, e, {
      to: u, // ★ P6-A：无终点失败会被当 rewash 残留过滤 ⇒ 给自环终点（不造假进展）
      result: "failure",
      verify: { kind: "exit", summary: "exit 1" },
      errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42`,
    });
  }
  return g;
}

/** 预算扫描：收集所有落到兜底档（level ≥ 4）的渲染结果。 */
function fallbackRuns(g) {
  const full = renderLedger(g, { maxTokens: 1e9 });
  const rows = [];
  for (let budget = full.tokens; budget >= 1; budget -= 1) {
    const r = renderLedger(g, { maxTokens: budget });
    if (r.level >= 4) rows.push({ budget, level: r.level, tokens: r.tokens, shown: r.shownFailures, omitted: r.omittedEdges, text: r.text });
  }
  return { full, rows };
}

tests["L4/L5 兜底裁决：必须择优（L5 的 10 条比 L4 的 20 条省），不许「走进哪档就返回哪档」"] = () => {
  const g = fallbackGraph();
  const { rows } = fallbackRuns(g);
  if (rows.length === 0) throw new Error("夹具没有落到 L4/L5 —— 本用例什么也证明不了（图不够胖？）");
  // L4 与 L5 的每行格式完全相同（同为 LEVEL_LEN[3] + n1 路径形态），差别只有条数：
  //   L4 列最近 tailFailures(20) 条，L5 列最近 10 条 ⇒ L5 的文本必然更短。
  // 裁决规则（src/ledger.mjs pickFallback）：预算内优先 → tokens 小者胜 → 平手时列得多的胜。
  // 所以在 40 条失败边的图上，兜底一旦被选中就只能是 L5。出现 L4 = 退回旧行为
  //（旧版 L4 只要渲染出来就无条件返回，即使它比 L5 更费）。
  for (const r of rows) {
    if (r.level !== 5) throw new Error(`预算 ${r.budget}：兜底选中了 L${r.level}（应择优选更省的 L5；L4 的 20 条更费）`);
    if (r.shown !== 10) throw new Error(`预算 ${r.budget}：L5 契约是「最近 10 条」，实际 ${r.shown}`);
    if (r.omitted !== 30) throw new Error(`预算 ${r.budget}：省略数必须是真实省略 30，实际 ${r.omitted}`);
  }
  // 「预算内优先」这一层必须真的起作用：预算够时必须装下
  const within = rows.filter((r) => r.tokens <= r.budget);
  if (within.length === 0) throw new Error("没有任何兜底预算装得下 L5 —— 夹具或预算假设有误");
  const lowest = within.reduce((a, b) => (a.budget < b.budget ? a : b));
  if (lowest.tokens > lowest.budget) throw new Error(`预算 ${lowest.budget} 装了 ${lowest.tokens} tokens（超预算）`);
};

tests["L4/L5 兜底：连 L5 都超预算时也必须给完整清单（不空转、不假装装下、省略数真实）"] = () => {
  const g = fallbackGraph();
  const r = renderLedger(g, { maxTokens: 1 });
  if (r.level !== 5) throw new Error(`预算 1 应落到 L5，实际 L${r.level}`);
  if (r.text.length === 0) throw new Error("超预算时不许返回空清单（宁可超预算也不能静默省略）");
  if (!r.text.trimEnd().endsWith("</chess-ledger>")) throw new Error(`兜底清单必须闭合：\n${r.text.slice(-200)}`);
  if (r.tokens <= 1) throw new Error("这里本来就该超预算：诚实超限 > 静默省略");
  if (r.shownFailures !== 10) throw new Error(`L5 的条数契约是最近 10 条，实际 ${r.shownFailures}`);
  if (r.omittedEdges !== 30) throw new Error(`省略数必须真实：期望 30，实际 ${r.omittedEdges}`);
  const lines = r.text.split("\n");
  const summary = lines.find((l) => l.includes("earlier dead ends omitted for budget"));
  if (!summary) throw new Error(`缺「还有多少条没列」的汇总行（不许假装那些失败边不存在）：\n${r.text}`);
  if (!summary.includes(`… ${r.omittedEdges} earlier`)) throw new Error(`汇总行的省略数与 omittedEdges 不一致：${summary}`);
  const failureLines = lines.filter((l) => /^- e\d+ /.test(l));
  if (failureLines.length !== 10) throw new Error(`失败边行数应为 10，实际 ${failureLines.length}`);
  for (const l of failureLines) if (!l.includes(" → ")) throw new Error(`兜底档不许丢失败原因：${l}`);
  // 路径不许被整块吞掉（C-17 契约）：至少要有一行说明当前位置
  if (!lines.some((l) => l.startsWith("# path: ") || l.startsWith("CURRENT PATH: ") || l.startsWith("WORKING: "))) {
    throw new Error(`兜底档把路径整块吞掉了：\n${r.text}`);
  }
};

tests["L4/L5 边界：失败边 ≤10 时两档同文，必须全列，且不许印省略汇总行"] = () => {
  const g = fallbackGraph({ failures: 10, sessionId: "ledger-fallback-small" });
  const { rows } = fallbackRuns(g);
  if (rows.length === 0) throw new Error("夹具没有落到 L4/L5 —— 用例无效");
  for (const r of rows) {
    if (r.shown !== 10) throw new Error(`只有 10 条失败边时兜底必须全列，实际 ${r.shown}（预算 ${r.budget}）`);
    if (r.omitted !== 0) throw new Error(`没有边被省略时省略数必须是 0，实际 ${r.omitted}（预算 ${r.budget}）`);
    if (r.text.includes("earlier dead ends omitted")) throw new Error(`没有省略却印了省略汇总行（预算 ${r.budget}）：\n${r.text}`);
    const failureLines = r.text.split("\n").filter((l) => /^- e\d+ /.test(l));
    if (failureLines.length !== 10) throw new Error(`兜底必须列全 10 条，实际 ${failureLines.length}（预算 ${r.budget}）`);
  }
};

/* ───────────────────── S5：TRACE 最近节点 ───────────────────── */

/**
 * 一条成功链（user → n2 → … → n(hops+1)）+ 一条失败边。
 * 有成功链才有 `path`，有失败边才有 `TRACE:` 行 —— 两者缺一这条用例就测不到东西。
 */
function traceGraph({ hops = 4, goals = null, sessionId = "ledger-trace" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。不要动 prod 配置。" });
  let cursor = u;
  const ids = [u];
  for (let i = 0; i < hops; i += 1) {
    const goal = goals?.[i] ?? `第 ${i + 1} 步`;
    const e = addEdge(g, { from: cursor, intent: goal, action: `bash(step ${i})` });
    const a = addAgentNode(g, { seq: 2 + i, goal, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = a;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    cursor = a;
    ids.push(a);
  }
  const fe = addEdge(g, { from: u, intent: "直接改 prod", action: "write(file_path=prod.yml)" });
  settleEdge(g, fe, { to: u, result: "failure", verify: { kind: "exit", summary: "EACCES" }, errorSnippet: "Error: EACCES" });
  return { g, ids };
}

/** 取 TRACE 行（没有就报错）。 */
function traceLine(text) {
  const line = text.split("\n").find((l) => l.startsWith("TRACE:"));
  if (!line) throw new Error(`清单里没有 TRACE 行：\n${text}`);
  return line;
}

tests["S5 · TRACE 行带最近 3 个路径节点 id + 一句话（不多不少）"] = () => {
  const { g, ids } = traceGraph({ hops: 4, goals: ["读 package.json", "改 dev 配置", "跑 npm test", "看覆盖率"] });
  const r = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/s5" });
  const line = traceLine(r.text);
  if (!line.includes("TRACE: s5/index.md")) throw new Error(`相对路径契约被破坏：${line}`);
  const last3 = ids.slice(-3);
  const recentAt = line.indexOf("recent: ");
  if (recentAt < 0) throw new Error(`TRACE 行没有 recent 段：${line}`);
  const recent = line.slice(recentAt);
  // 顺序必须与路径一致
  let cursor = -1;
  for (const id of last3) {
    const at = recent.indexOf(id, cursor + 1);
    if (at < 0) throw new Error(`recent 里缺节点 ${id} 或顺序错：${recent}`);
    cursor = at;
  }
  // 第 4 个（更早的）节点不许出现 —— 只要最近 3 个
  const earlier = ids[ids.length - 4];
  if (recent.includes(earlier)) throw new Error(`recent 混进了更早的节点 ${earlier}：${recent}`);
  // 每个节点都带一句话（来自 goal；last3 = n3/n4/n5）
  for (const phrase of ["改 dev 配置", "跑 npm test", "看覆盖率"]) {
    if (!recent.includes(phrase)) throw new Error(`recent 缺节点短语「${phrase}」：${recent}`);
  }
  if (recent.includes("读 package.json")) throw new Error(`recent 混进了更早节点的短语：${recent}`);
  // 一句话形态：`recent: nX … → nY … → nZ …`
  if ((recent.match(/→/g) ?? []).length !== 2) throw new Error(`应恰好 3 个节点 2 个箭头：${recent}`);
};

tests["S5 · 空路径时 TRACE 逐字不变（不凭空造 recent）"] = () => {
  // 只有 user + 失败边 ⇒ latestAgentNode 为 null ⇒ path=[]；
  // 但 TRACE 行照旧出现（它在 failures 块里）
  const g = createGraph({ sessionId: "ledger-trace-empty" });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。" });
  const e = addEdge(g, { from: u, intent: "直接改 prod", action: "write(file_path=prod.yml)" });
  settleEdge(g, e, { to: u, result: "failure", verify: { kind: "exit", summary: "EACCES" }, errorSnippet: "EACCES" });
  const r = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/empty" });
  const line = traceLine(r.text);
  if (line !== "TRACE: empty/index.md") throw new Error(`空路径时 TRACE 必须逐字不变，实际：${line}`);
  if (r.text.includes("recent:")) throw new Error("空路径却印了 recent");
};

tests["S5 · 短路径不补齐；短语截断；绝对路径被打码（P6a 硬约束）"] = () => {
  const { g, ids } = traceGraph({
    hops: 2,
    goals: ["读 D:/repo/secret/config.yaml 并检查超长的一句话到底会不会被截断", "跑 npm test"],
    sessionId: "ledger-trace-short",
  });
  const r = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/short" });
  const line = traceLine(r.text);
  // 只有 2 个 agent 节点 + user = 3 个路径节点 ⇒ recent 就是这 3 个（user 没 goal，只出 id）
  if ((line.match(/→/g) ?? []).length !== 2) throw new Error(`3 个路径节点应有 2 个箭头：${line}`);
  for (const id of ids) {
    if (!line.includes(id)) throw new Error(`recent 缺路径节点 ${id}：${line}`);
  }
  // 绝对路径必须打码，且不能出现盘符/家目录
  if (/[A-Za-z]:[\\/]/.test(line) || line.includes("/Users/") || line.includes("/home/")) {
    throw new Error(`TRACE 行泄漏绝对路径：${line}`);
  }
  if (!line.includes("…")) throw new Error(`被截断/打码的短语应留省略号：${line}`);
  // 长短语不得整句进入（18 字符上限 + 打码）
  if (line.includes("并检查超长的一句话到底会不会被截断")) throw new Error(`recent 没截断长短语：${line}`);
  // 短路径 = 2 个 agent + user，不该被补到 3 个 agent
  if (line.includes("n9") || line.includes("n10")) throw new Error(`recent 补了不存在的节点：${line}`);
};

tests["S5 · 500 token 预算下不超预算，且 recent 仍在"] = () => {
  const { g } = traceGraph({ hops: 6, sessionId: "ledger-trace-budget" });
  for (let i = 0; i < 80; i += 1) {
    const e = addEdge(g, { from: g.order[0], intent: `失败 ${i}`, action: "bash(x)" });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: boom ${i}` });
  }
  const r = renderLedger(g, { maxTokens: 500, treeDir: "D:/x/chess-context/sessions/s5-budget" });
  if (r.tokens > 500) throw new Error(`超预算：${r.tokens} > 500（fallback=${r.fallback}）`);
  if (r.fallback !== "none") throw new Error(`应落在预算内：fallback=${r.fallback}`);
  if (!traceLine(r.text).includes("recent: ")) throw new Error(`降级后 TRACE recent 丢了：\n${traceLine(r.text)}`);
};

tests["S5 · 预算只剩几 token 时先丢 recent、不超预算（dropped-for-budget）"] = () => {
  const { g } = traceGraph({ hops: 3, sessionId: "ledger-trace-drop", goals: ["读配置", "改配置", "跑测试"] });
  // 扫一遍预算，找那个「带 recent 会超、丢掉 recent 正好装得下」的临界值。
  // 找不到就说明这个降级分支没被任何夹具覆盖 —— 直接红，不许假绿。
  let hit = null;
  for (let budget = 120; budget <= 400; budget += 1) {
    const r = renderLedger(g, { maxTokens: budget, treeDir: "D:/x/chess-context/sessions/s5-drop" });
    if (r.traceRecent === "dropped-for-budget") {
      hit = { budget, r };
      break;
    }
  }
  if (hit === null) throw new Error("没有任何预算能触发 dropped-for-budget —— 降级分支未被覆盖");
  const { budget, r } = hit;
  if (r.tokens > budget) throw new Error(`丢掉 recent 后仍超预算：${r.tokens} > ${budget}`);
  if (r.text.includes(" · recent: ")) throw new Error(`标了 dropped-for-budget 却仍带 recent 段：\n${r.text}`);
  const line = traceLine(r.text);
  if (!line.startsWith("TRACE: s5-drop/index.md")) throw new Error(`退回旧形态的 TRACE 行不对：${line}`);
  // 反事实：同一预算下把 recent 加回去必须超预算 —— 否则这个降级就是无谓的
  const seg = traceRecentSegment(currentPath(g, g.order.at(-1)));
  if (seg === "") throw new Error("夹具没有路径节点，recent 段为空 —— 用例无效");
  const withRecent = r.text.replace(line, `${line} · ${seg}`);
  if (estimateTokens(withRecent) <= budget) {
    throw new Error(`夹具构造失败：预算 ${budget} 下带 recent 也只有 ${estimateTokens(withRecent)} token（没超）`);
  }
};

/* ═════════════ S3 降级可见（task-186） ═════════════ */

tests["S3-1 lastFoldMode=rules ⇒ 热清单固定出现「⚠ 上次摘要是规则生成」，hybrid/缺字段不出现"] = () => {
  const base = () => buildGraph({ failures: 3, constraints: ["必须保持 API 不变。"] });
  const rules = base();
  rules.lastFoldMode = "rules";
  const withRules = renderLedger(rules).text;
  if (!withRules.includes("⚠ 上次摘要是规则生成（无模型润色）")) throw new Error(`规则摘要后必须有提示行：\n${withRules.slice(0, 200)}`);
  // 别名字段也认（task-186 允许 lastFoldDegraded）
  const alias = base();
  alias.lastFoldDegraded = true;
  if (!renderLedger(alias).text.includes("⚠ 上次摘要是规则生成")) throw new Error("lastFoldDegraded=true 必须同样显示");

  const hybrid = base();
  hybrid.lastFoldMode = "hybrid";
  hybrid.lastFoldDegraded = false;
  const withHybrid = renderLedger(hybrid).text;
  if (withHybrid.includes("上次摘要是规则生成")) throw new Error("正常 hybrid 摘要不许显示降级提示");

  const legacy = base(); // 旧图：两个字段都没有
  const withLegacy = renderLedger(legacy).text;
  if (withLegacy.includes("上次摘要是规则生成")) throw new Error("旧图缺字段时不许显示（向后兼容）");

  const llm = base();
  llm.lastFoldMode = "llm";
  if (renderLedger(llm).text.includes("上次摘要是规则生成")) throw new Error("llm 模式不许显示降级提示");
};

tests["S3-2 降级提示行在各档位都在，且预算口径成立（500 预算的常规会话装得下）"] = () => {
  const g = buildGraph({ failures: 40, constraints: ["必须保持 API 不变。"] });
  g.lastFoldMode = "rules";
  const seen = new Set();
  // 预算从宽到窄扫：命中 L0/L1/L2/L3/L5（L4 只在「20~60 条失败边且预算特定」时出现，见别的用例）
  for (const maxTokens of [4000, 2000, 1500, 1200, 900, 700, 500, 300]) {
    const r = renderLedger(g, { maxTokens });
    if (!r.text.includes("⚠ 上次摘要是规则生成")) throw new Error(`maxTokens=${maxTokens} 时提示行丢了（L${r.level}）`);
    seen.add(r.level);
    if (r.fallback !== "over-budget" && r.tokens > maxTokens) throw new Error(`maxTokens=${maxTokens} 实际 ${r.tokens} tokens（L${r.level}）超预算`);
  }
  if (seen.size < 3) throw new Error(`档位覆盖不足：${[...seen].join(",")}`);
  // 500 预算的常规夹具：S3 的提示行不许把正常会话挤出预算
  const normal = buildGraph({ failures: 3, constraints: ["必须保持 API 不变。"] });
  normal.lastFoldMode = "rules";
  const r500 = renderLedger(normal, { maxTokens: 500 });
  if (r500.tokens > 500) throw new Error(`500 预算下 ${r500.tokens} tokens（L${r500.level}）`);
  if (!r500.text.includes("⚠ 上次摘要是规则生成")) throw new Error("500 预算下提示行不该被裁掉");
};
