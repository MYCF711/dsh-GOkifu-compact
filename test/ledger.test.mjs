import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode, failureEdges, currentPath } from "./graph-fixtures.mjs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { renderLedger, renderFacts, renderMinimalLedger, estimateTokens, renderFailureLine, collectConstraints, currentGoalOf, isInformativeAsk, collectValueFacts, planValueFacts, renderValueFactLine, valueFactDigest, VALUE_FACT_RENDER_LIMIT, _internal } from "../src/rooms/ledger.mjs";
import { extractValueFacts, isValueFact, VALUE_FACT_KINDS } from "../src/rooms/tool-value-facts.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

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

tests["estimateTokens：CJK 1 token/字 + 其余 1/4 token/字（钉死数值，不再只断言「大于几」）"] = () => {
  // ★ W-A（2026-11-01）：旧版这条叫「estimateTokens 是保守估计」，断言却是
  //   `estimateTokens("中文十个字应该超过十") < 3` —— 任何非空中文串都满足（旧式给 4），
  //   **等于恒真**；而实测旧口径对纯中文低估 38%、对真实热清单低估 8.8%。
  //   「名字说保守、断言什么都钉不住」正是本仓 S10d 在打的假绿。现在改成钉死具体数值。
  if (estimateTokens("") !== 0) throw new Error("空串必须 0（不因向上取整变成 1）");
  const tenChinese = "中文十个字应该超过十";
  if (tenChinese.length !== 10) throw new Error(`夹具字面量变了（应 10 字，实际 ${tenChinese.length}）`);
  if (estimateTokens(tenChinese) !== 10) {
    throw new Error(`10 个汉字必须 = 10 token（CJK 1 token/字），实际 ${estimateTokens(tenChinese)}`);
  }
  const ascii400 = "a".repeat(400);
  if (estimateTokens(ascii400) !== 100) {
    throw new Error(`400 ASCII 必须 = 100 token（宿主 CHARS_PER_TOKEN=4），实际 ${estimateTokens(ascii400)}`);
  }
  if (estimateTokens("abc中") !== 2) {
    throw new Error(`3 ASCII + 1 汉字 = ceil((3+4)/4) = 2，实际 ${estimateTokens("abc中")}`);
  }
  // 回归护栏：旧口径 `len/3` 会把 10 个汉字算成 4、把 400 ASCII 算成 134 —— 只要那个口径回来，上面三条立刻红。
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
  // ★ W-A（2026-11-01）：定价从「字符/3」改成「CJK 4 单位/字 + 其余 1/4 token」后，40 条失败边的
  //   L0 从「约 60 token」涨到 **1132 token**，档位阈值整体上移（L0 撑到 1200，L2≈1100、L3≈1000）。
  //   原来的扫描点 [4000,2000,1500,1200,900,…] 只剩 L0 与 L5 ⇒ 覆盖不足变红。
  //   **改用按新阈值取的扫描点**（不是放宽断言）：断言本身一字未动，仍是覆盖 ≥3 档 + 提示行不丢 + 不静默超预算。
  for (const maxTokens of [4000, 2000, 1500, 1200, 1150, 1100, 1050, 1000, 950, 900, 700, 500, 300]) {
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

tests["C302 证据位置只读一处：evidence 数字 / {start,end} / 缺失 三种形态口径一致"] = async (t) => {
  const mod = await import("../src/rooms/kifu-model.mjs");
  t.eq(typeof mod.evidenceEndSeq, "function", "必须导出 evidenceEndSeq");
  t.eq(typeof mod.evidenceStartSeq, "function", "必须导出 evidenceStartSeq");

  // ① 老形态：evidence 是数字
  t.eq(mod.evidenceEndSeq({ evidence: 42 }), 42, "数字形态的 end = 数字本身");
  t.eq(mod.evidenceStartSeq({ evidence: 42 }), 42, "数字形态没有 start ⇒ 退回 end");

  // ② 新形态：{start,end}
  t.eq(mod.evidenceEndSeq({ evidence: { start: 10, end: 20 } }), 20, "对象形态取 end");
  t.eq(mod.evidenceStartSeq({ evidence: { start: 10, end: 20 } }), 10, "对象形态取 start");

  // ③ 缺失 / 坏值：默认 NaN，比较场景可以传 -Infinity
  t.eq(Number.isNaN(mod.evidenceEndSeq({})), true, "没有 evidence ⇒ NaN");
  t.eq(mod.evidenceEndSeq({}, -Infinity), -Infinity, "可以指定 fallback");
  t.eq(Number.isNaN(mod.evidenceEndSeq({ evidence: { end: "x" } })), true, "坏 end ⇒ NaN（不许当 0）");

  // ④ 接线：ledger 不许再自己拼一遍
  const ledgerSrc = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "rooms", "ledger.mjs"), "utf8");
  t.eq(ledgerSrc.includes('typeof e?.evidence === "number" ? e.evidence :'), false, "ledger 不许再有第四份实现");
};

tests["C313 分项计时仪器：给出 total + parts，且各段之和不超过 total 的数倍（不许瞎报）"] = async (t) => {
  const { measureLedgerTimings } = await import("../src/rooms/ledger.mjs");
  t.eq(typeof measureLedgerTimings, "function", "必须导出 measureLedgerTimings");

  const g = createGraph({ sessionId: "sess-c313" });
  addUserNodeId(g, { seq: 1, text: "做点事" });
  const a = addAgentNode(g, { seq: 2 });
  addEdge(g, { from: a, action: "run tests", intent: "跑测试", seq: 3 });

  const r = measureLedgerTimings(g, { reps: 3 });
  t.eq(typeof r.total, "number", "total 必须是数字");
  t.eq(r.total >= 0, true, "total 不许为负");
  t.eq(typeof r.parts, "object", "parts 必须是对象");
  for (const key of ["failureEdges", "successScan", "danglingStats", "options", "paths", "tewari"]) {
    t.eq(typeof r.parts[key], "number", `parts.${key} 必须是数字`);
    t.eq(r.parts[key] >= 0, true, `parts.${key} 不许为负`);
  }
  const sum = Object.values(r.parts).reduce((x, y) => x + y, 0);
  t.eq(sum <= r.total * 20 + 50, true, `各段之和 ${sum.toFixed(1)}ms 明显超过 total ${r.total.toFixed(1)}ms —— 仪器在瞎报`);
  t.eq(typeof r.split, "string", "要给一句可归因说明");
};

tests["C320 截断判定要吃掉三种拼法（max-tokens / max_tokens / length），别再猜口径"] = async (t) => {
  const { isTruncatedFinish } = await import("../src/rooms/kifu-model.mjs");
  t.eq(typeof isTruncatedFinish, "function", "必须导出 isTruncatedFinish");
  // 三层口径实测：assembler 用连字符、zStopReason 用下划线、OpenAI 用 length
  t.eq(isTruncatedFinish("max-tokens"), true, "宿主流式块口径（连字符）");
  t.eq(isTruncatedFinish("max_tokens"), true, "宿主终态联合口径（下划线）");
  t.eq(isTruncatedFinish("length"), true, "OpenAI 原始口径");
  t.eq(isTruncatedFinish("LENGTH"), true, "大小写不敏感");
  // 正常结束都不算截断
  for (const ok of ["stop", "end_turn", "tool-calls", "tool_calls", "completed", ""]) {
    t.eq(isTruncatedFinish(ok), false, `${ok} 不该算截断`);
  }
  t.eq(isTruncatedFinish(null), false, "null 不算截断");
  t.eq(isTruncatedFinish(undefined), false, "undefined 不算截断");
};

tests["C351 token 估算的偏差必须被写死（改常量就得回来改这条，防悄悄漂移）"] = async (t) => {
  const { estimateTokens } = await import("../src/rooms/ledger.mjs");
  // 官方（token_usage 文档）：英文 0.3 token/字、中文 0.6 token/字。
  // 我们故意不用官方比例：CJK 1.0/字（高估 67%，中文场景更安全）、ASCII 0.25/字（低估 17%）。
  // ⇒ 这条测试钉的是"**我们的偏差本身**"：谁改了常量，这里必须一起改，且要来说明理由。
  const cjk = estimateTokens("汉字汉字汉字汉字"); // 8 字
  const ascii = estimateTokens("abcdefgh"); // 8 字
  t.eq(cjk, 8, `CJK 8 字应估 8 token（= 官方 0.6 的 1.67 倍），实际 ${cjk}`);
  t.eq(ascii, 2, `ASCII 8 字应估 2 token（= 官方 0.3 的 0.83 倍），实际 ${ascii}`);
  t.eq(cjk > ascii * 3, true, "CJK 必须明显比 ASCII 贵（这是分档设计的前提）");
};

tests["C352 官方比例估算器：中文 0.6/字、英文 0.3/字（校准脚本依赖它）"] = async (t) => {
  const { officialEstimate, compareEstimates } = await import("../scripts/token-calib.mjs");
  // 10 个汉字 ⇒ 6 token
  t.eq(officialEstimate("汉字汉字汉字汉字汉字").tokens, 6, "10 汉字 ⇒ 6 token（0.6/字）");
  // 10 个英文 ⇒ 3 token
  t.eq(officialEstimate("abcdefghij").tokens, 3, "10 英文 ⇒ 3 token");
  // 换行不计
  t.eq(officialEstimate("\n\n").tokens, 0, "换行不产生 token");
  // 混合：4 汉字(2.4) + 4 英文(1.2) ⇒ ceil(3.6)=4
  t.eq(officialEstimate("数据压缩test").tokens, 4, "混合按各自比例相加后向上取整");

  // compareEstimates 给出比值；纯中文时我们应偏高（CJK 1.0 vs 官方 0.6）
  const cjkOnly = compareEstimates("汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字");
  t.eq(cjkOnly.ratio > 1.5, true, `纯中文时应明显偏高，实际 ${cjkOnly.ratio}`);
  // 纯英文时我们应偏低（0.25 vs 0.3）
  const asciiOnly = compareEstimates("abcdefghijklmnopqrst");
  t.eq(asciiOnly.ratio < 1, true, `纯英文时应偏低，实际 ${asciiOnly.ratio}`);
};

/* ───────── C448：CURRENT GOAL 的原料问题（真机 93.3% 的 assistant 消息没有 text 块） ───────── */

tests["C448 currentGoalOf：agent 有 goal 就用它；没有再兜底最近一条 user 原话（且不能是根）"] = (t) => {
  const g = buildGraph({ failures: 1 });
  const latest = (g.order ?? []).map((id) => g.nodes[id]).filter((n) => n && n.kind === "agent").at(-1);
  // ① 只有根用户 ⇒ 不给（否则就是重复 ROOT）
  t.eq(currentGoalOf(g, { goal: "" }), null, "单轮会话不该伪造 CURRENT GOAL（与 ROOT 重复）");
  // ② 多轮 ⇒ 用最近一条 user 原话
  const g2 = buildGraph({ failures: 1, extraUser: "改成先跑 lint，再跑测试。" });
  const got = currentGoalOf(g2, { goal: "" });
  t.eq(got?.source, "latest-user", "没有 goal 时应回落到最近一条 user 原话");
  t.includes(got?.text ?? "", "先跑 lint", "回落内容必须是用户原话");
  // ③ agent 自己有 goal ⇒ 优先它
  const got2 = currentGoalOf(g2, { goal: "跑通 lint" });
  t.eq(got2?.source, "agent-goal", "有 goal 时不许被兜底覆盖");
  t.eq(got2?.text, "跑通 lint", "goal 原文");
  // ④ 最新那条就是根 ⇒ 不给
  const g3 = buildGraph({ failures: 0 });
  const rootId = g3.rootUserNodeIds[0];
  t.eq(currentGoalOf(g3, { goal: "" }), null, "只有根时不给");
  t.eq(currentGoalOf({ ...g3, rootUserNodeIds: [g3.order.at(-1)] }, { goal: "" }), null, "最新一条就是根时不给");
  t.eq(typeof rootId, "string", "夹具应有根 id");
};

tests["C448 renderLedger：多轮会话必须真的出现 CURRENT GOAL 行（真机现状是 0.3% 才有）"] = (t) => {
  // 有路径才会渲染 CURRENT GOAL 行（它挂在路径块里）⇒ 夹具必须有 agent 节点
  const withPath = (extraUser) => {
    const g = createGraph({ sessionId: "c448" });
    const u = addUserNodeId(g, { seq: 1, text: "把 data.jsonl 算出来。" });
    const e1 = addEdge(g, { from: u, intent: "跑一下", action: "bash(node calc.mjs)" });
    const n2 = addAgentNode(g, { seq: 5, goal: "", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
    g.edges[e1].to = n2;
    settleEdge(g, e1, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    if (extraUser !== null) addUserNodeId(g, { seq: 9, text: extraUser });
    return g;
  };
  const single = renderLedger(withPath(null), { now: 1_760_000_000_000 });
  t.eq(single.text.includes("CURRENT GOAL"), false, "单轮会话不出现（与 ROOT 重复）");
  const multi = renderLedger(withPath("改成先跑 lint，再跑测试。"), { now: 1_760_000_000_000 });
  t.includes(multi.text, "CURRENT GOAL:", "多轮会话必须出现");
  t.includes(multi.text, "先跑 lint", "内容要带上用户原话");
  // 长指令要截断（一行不许无限长）
  const clipped = renderLedger(withPath("改".repeat(400)), { now: 1_760_000_000_000 });
  const line = clipped.text.split(String.fromCharCode(10)).find((l) => l.startsWith("CURRENT GOAL:"));
  t.eq((line ?? "").length <= 240 + 20, true, `CURRENT GOAL 行必须截断，实际 ${(line ?? "").length} 字`);
};

/* ───────── C449：兜底内容要过信息量这道门（真机最新 user 消息中位只有 12 字） ───────── */

tests["C449 isInformativeAsk：纯接续/确认词不算目标，2 字以内一律不算"] = (t) => {
  for (const junk of ["继续", "继续吧。", "go", "GO", "ok", "好的", "嗯", "可以", "接着", "请继续", ""]) {
    t.eq(isInformativeAsk(junk), false, `「${junk}」不该被当成当前目标`);
  }
  for (const real of ["修一下", "都是0", "我重启好了", "按照 gokifu 的方式完善 kifu", "继续修 data.jsonl 那个解析"]) {
    t.eq(isInformativeAsk(real), true, `「${real}」应当被当成当前目标`);
  }
};

tests["C449 currentGoalOf：最新一条只是「继续」⇒ 宁可不给（更早那条多半已做完，写成目标会把模型拽回去重做）"] = (t) => {
  const mk = (extra) => {
    const g = createGraph({ sessionId: "c449" });
    const u = addUserNodeId(g, { seq: 1, text: "把 data.jsonl 算出来。" });
    const e1 = addEdge(g, { from: u, action: "bash(node calc.mjs)" });
    const n2 = addAgentNode(g, { seq: 5, goal: "", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
    g.edges[e1].to = n2;
    addUserNodeId(g, { seq: 9, text: extra });
    return g;
  };
  t.eq(currentGoalOf(mk("继续"), { goal: "" }), null, "「继续」不渲染");
  t.eq(currentGoalOf(mk("go"), { goal: "" }), null, "英文接续词同样不渲染");
  t.eq(currentGoalOf(mk("改成先跑 lint 再跑测试"), { goal: "" })?.text, "改成先跑 lint 再跑测试", "有信息量才渲染");
  // agent 自己有 goal 时，接续词过滤不该把 goal 也挡掉
  t.eq(currentGoalOf(mk("继续"), { goal: "跑通 lint" })?.source, "agent-goal", "goal 优先，且不受兜底过滤影响");
  // 真渲染：最新是「继续」⇒ 不出这行
  const noLine = renderLedger(mk("继续"), { maxTokens: 500, now: 1_760_000_000_000 });
  t.eq(noLine.text.includes("CURRENT GOAL"), false, "「继续」不该在清单里出现");
};

/* ═════════════════ AX-08：成功结果的值型事实如何进热清单（2026-11-07） ═════════════════
 *
 * 判据（AX-08 卡）：K-2 两形状必须**可见且可回证**；guard 关掉零渲染差异；预算不足先裁叙事、
 * 不静默丢值；超预算/省略必须有计数与 graph.json 指针；不得重复注入同值；
 * 与 AX-04 的 `edge.valueFacts` 契约完全一致（用 AX-02 的 `isValueFact` 交叉钉住）。
 */

/** K-2 S1-Q1 的真实形状：成功 `write` 的回执。 */
const createdFileResult = (path) => `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`;

/** K-2 S2-Q3 的真实形状：仓库 API 的 JSON（description 故意很长，测「只留短值」）。 */
const repoJsonResult = () =>
  `{"id": 4242, "node_id": "R_demo4242", "name": "demo-repo", "full_name": "octo/demo-repo", "private": false, "default_branch": "main", "description": "${"长".repeat(3000)}"}`;

/**
 * 一张「成功工具结果」图：user →（成功边）→ agent，边上挂着 AX-02 抽出来的值事实
 * （= AX-04 落盘后的形状）。`failures` 给失败叙事，用来验「预算不足先裁叙事」。
 */
function valueFactGraph({ facts = [], sessionId = "ax08", failures = 0 } = {}) {
  const g = createGraph({ sessionId, cwd: "/tmp" });
  const u = addUserNodeId(g, { seq: 1, text: "把 a.mjs 建出来。" });
  const edgeId = addEdge(g, { from: u, intent: "写文件", action: "write(file_path=D:/x/a.mjs)", evidence: { start: 4, end: 5 } });
  const agent = addAgentNode(g, { seq: 6, goal: "写文件", worldHash: "W1", constraintHash: "C1", via: edgeId }).id;
  const settled = settleEdge(g, edgeId, { to: agent, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  if (facts.length > 0) settled.valueFacts = facts;
  for (let i = 0; i < failures; i += 1) {
    const fe = addEdge(g, { from: agent, intent: `第 ${i + 1} 次：换个写法再试一遍`, action: `bash(npm test ${i})`, evidence: { start: 10 + i * 2, end: 11 + i * 2 } });
    settleEdge(g, fe, {
      to: agent,
      result: "failure",
      verify: { kind: "exit", summary: "exit 1" },
      errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42`,
    });
  }
  return g;
}

const createdFacts = (path = "D:/主工作区/repos/x/src/a.mjs", evidenceSeq = 5) =>
  extractValueFacts({ tool: "write", result: createdFileResult(path), resultKind: "success", evidenceSeq });

const apiFacts = (evidenceSeq = 7) => extractValueFacts({ tool: "github", result: repoJsonResult(), resultKind: "weak", evidenceSeq });

/** 渲染文本里的值事实行（标题行、省略行都不算）。 */
const valueFactRows = (text) =>
  String(text ?? "")
    .split(String.fromCharCode(10))
    .filter((line) => /^- e\d+ (?:file_created|file_updated|file_path|id|boolean|config|value) /.test(line));

tests["AX-08 ①：guard=false 零渲染差异 —— 有 valueFacts 的图与没有它的图逐字相同"] = (t) => {
  const facts = createdFacts();
  t.eq(facts.length > 0, true, "夹具必须先抽出事实（否则本用例什么都没证明）");
  const withFacts = valueFactGraph({ facts, sessionId: "ax08-off" });
  const withoutFacts = valueFactGraph({ facts: [], sessionId: "ax08-off" });
  for (const budget of [2000, 500, 300]) {
    const on = renderLedger(withFacts, { maxTokens: budget });
    const off = renderLedger(withoutFacts, { maxTokens: budget });
    t.eq(on.text, off.text, `maxTokens=${budget}：guard 关掉时 valueFacts 不许改变渲染（一个字符都不许）`);
    t.eq(on.tokens, off.tokens, `maxTokens=${budget}：token 数必须相同`);
  }
  const r = renderLedger(withFacts, { maxTokens: 2000 });
  t.eq(r.text.includes("VALUE FACTS"), false, "guard 关掉时不许出现值事实段");
  t.eq(r.valueFactStats.total, 0, "guard 关掉时统计口径是「没有值」（不假装渲染了 0 条）");
  // 反向：guard 打开必须真的多出东西（否则上面几条零差异是恒真）
  const on = renderLedger(withFacts, { maxTokens: 2000, factGuard: true });
  t.eq(on.text.length > r.text.length, true, "guard 打开必须真的多出值事实段（否则零差异是恒真）");
};

tests["AX-08 ②：K-2 S1-Q1 —— 成功 write 的 Created file 路径进热清单，带原文 seq 可回证"] = (t) => {
  const path = "D:/主工作区/repos/x/src/a.mjs";
  const facts = createdFacts(path, 5);
  const created = facts.find((fact) => fact.kind === "file_created");
  t.eq(created !== undefined, true, "AX-02 必须抽出 file_created");
  t.eq(createdFileResult(path).includes(created.quote), true, "quote 必须是结果原文的连续子串（回证物）");
  const g = valueFactGraph({ facts, sessionId: "ax08-k2a" });
  const r = renderLedger(g, { maxTokens: 2000, factGuard: true });
  t.includes(r.text, "VALUE FACTS", "必须出现值事实段");
  t.includes(r.text, path, "K-2 S1-Q1 的退化点就是这条路径：必须可见");
  t.includes(r.text, "file_created", "类别要能认出来（哪种值）");
  t.includes(r.text, "(seq 5)", "必须带原文 seq（不可回证的值等于没留下）");
  t.eq(valueFactRows(r.text).length, 1, "只该有一条值事实行");
  t.eq(r.valueFactStats.shown, 1, "统计要一致");
};

tests["AX-08 ③：K-2 S2-Q3 —— 仓库 API 的 id / private 进热清单，长 description 不许进"] = (t) => {
  const facts = apiFacts(7);
  const idFact = facts.find((fact) => fact.kind === "id" && fact.value === 4242);
  const privFact = facts.find((fact) => fact.kind === "boolean" && fact.value === false);
  t.eq(idFact !== undefined, true, "id 4242 必须被抽出");
  t.eq(privFact !== undefined, true, "private=false 必须被抽出（false 不是「没有」）");
  t.eq(repoJsonResult().includes(privFact.quote), true, "quote 逐字可回证");
  const g = valueFactGraph({ facts, sessionId: "ax08-k2b" });
  const r = renderLedger(g, { maxTokens: 2000, factGuard: true });
  t.includes(r.text, "id 4242", "id 必须可见（键名已由 kind 说清）");
  t.includes(r.text, "private=false", "boolean 必须带键名，否则模型不知道哪个键是 false");
  t.includes(r.text, "(seq 7)", "两条都指向原文 seq");
  t.eq(r.text.includes("长".repeat(200)), false, "长 description 不许进热清单（只留短值）");
};

tests["AX-08 ④：与 AX-04 契约完全一致 —— 种类闭集逐字相同，且每条渲染事实都过 AX-02 的 isValueFact"] = (t) => {
  // ① ledger 的白名单必须与 AX-02 的 VALUE_FACT_KINDS 覆盖同一批种类（新增种类要回来补样例）。
  const samples = { file_created: "D:/x/a.mjs", file_updated: "D:/x/b.mjs", file_path: "D:/x/c.mjs", id: 4242, boolean: false, config: "main", value: "MINGW64_NT-10.0" };
  t.eq(VALUE_FACT_KINDS.length, Object.keys(samples).length, `夹具必须覆盖全部种类（AX-02 现有 ${VALUE_FACT_KINDS.length} 种）`);
  for (const kind of VALUE_FACT_KINDS) t.eq(Object.hasOwn(samples, kind), true, `AX-02 新增了种类 ${kind} —— 本夹具与 ledger 的白名单必须同步`);
  // ② 每一种都能渲染，且渲染出来的条目满足 AX-02 的六字段契约
  const facts = VALUE_FACT_KINDS.map((kind) => {
    const value = samples[kind];
    const quote = kind === "boolean" || kind === "id" || kind === "config" ? `"${kind === "id" ? "id" : kind}": ${JSON.stringify(value)}` : String(value);
    return { kind, value, quote, evidenceSeq: 5, validAtSeq: 5, source: "tool:write" };
  });
  for (const fact of facts) t.eq(isValueFact(fact), true, `夹具必须满足 AX-02 六字段契约：${fact.kind}`);
  const g = valueFactGraph({ facts, sessionId: "ax08-kinds" });
  const r = renderLedger(g, { maxTokens: 4000, factGuard: true });
  t.eq(r.valueFactStats.shown, facts.length, `每一种都必须能渲染（实际 ${r.valueFactStats.shown}/${facts.length}）`);
  t.eq(r.valueFactStats.malformed, 0, "合法事实不许被计成坏数据");
  for (const kind of VALUE_FACT_KINDS) t.includes(r.text, ` ${kind} `, `渲染行必须标出种类 ${kind}`);
  // ③ 坏数据（未知种类 / 类型不符 / 缺 quote / 负 seq / 超长值）⇒ 一条都不渲成事实，只计 malformed
  const bad = [
    { kind: "bogus", value: "x", quote: "x", evidenceSeq: 1, validAtSeq: 1, source: "tool:write" },
    { kind: "file_created", value: 5, quote: "5", evidenceSeq: 1, validAtSeq: 1, source: "tool:write" },
    { kind: "id", value: 1, quote: "   ", evidenceSeq: 1, validAtSeq: 1, source: "tool:write" },
    { kind: "id", value: 1, quote: '"id": 1', evidenceSeq: -1, validAtSeq: 1, source: "tool:write" },
    { kind: "value", value: "x".repeat(201), quote: "x", evidenceSeq: 1, validAtSeq: 1, source: "tool:write" },
  ];
  const g2 = valueFactGraph({ facts: bad, sessionId: "ax08-bad" });
  const r2 = renderLedger(g2, { maxTokens: 2000, factGuard: true });
  t.eq(r2.valueFactStats.malformed, bad.length, `坏数据必须逐条计 malformed（实际 ${r2.valueFactStats.malformed}）`);
  t.eq(r2.text.includes("VALUE FACTS"), false, "坏数据一条都不许渲成事实");
};

tests["AX-08 ⑤：不得重复注入同值 —— 两条边记同一个值只渲染一条"] = (t) => {
  const fact = { kind: "file_created", value: "D:/x/a.mjs", quote: "D:/x/a.mjs", evidenceSeq: 5, validAtSeq: 5, source: "tool:write" };
  const g = valueFactGraph({ facts: [fact], sessionId: "ax08-dup" });
  const dup = addEdge(g, { from: g.order[0], intent: "再写一次同一个文件", action: "write(file_path=D:/x/a.mjs)", evidence: { start: 30, end: 31 } });
  settleEdge(g, dup, { to: g.order[0], result: "success", verify: { kind: "exit", summary: "exit 0" } });
  g.edges[dup].valueFacts = [{ ...fact, evidenceSeq: 31, validAtSeq: 31 }];
  const r = renderLedger(g, { maxTokens: 2000, factGuard: true });
  t.eq(valueFactRows(r.text).length, 1, "同一个值只许出现一次（重复注入白烧预算，还会误导模型）");
  t.eq(r.valueFactStats.total, 1, "去重后的总数必须是 1");
  t.eq(r.text.includes("(seq 5)"), true, "保留**第一条**（更早的证据）");
  t.eq(r.text.includes("(seq 31)"), false, "后面的同值不再重复注入");
};

tests["AX-08 ⑥：超条数上限 ⇒ 计数 + graph.json 指针（不静默丢）"] = (t) => {
  const facts = [0, 1, 2].map((i) => ({ kind: "value", value: `值${i}`, quote: `值${i}`, evidenceSeq: 10 + i, validAtSeq: 10 + i, source: "tool:bash" }));
  const g = valueFactGraph({ facts, sessionId: "ax08-cap" });
  const r = renderLedger(g, { maxTokens: 4000, factGuard: true, maxValueFacts: 2, treeDir: "D:/DeepSeek Harness/home/chess-context/sessions/ax08", traceRoot: "sessions" });
  t.eq(r.valueFactStats.shown, 2, "上限 2 ⇒ 只渲染 2 条");
  t.eq(r.valueFactStats.omitted, 1, "省略数必须真实");
  t.includes(r.text, "另有 1 条值事实未展开", "省略必须印出计数（沉默 = 断言没有）");
  t.includes(r.text, "sessions/ax08/graph.json", "省略行必须给可解析的位置（相对化）");
  t.notIncludes(r.text, "DeepSeek Harness", "不许把绝对路径写进热清单（P6a）");
  // 没有 treeDir 时也必须留一个可解析指向
  const bare = renderLedger(g, { maxTokens: 4000, factGuard: true, maxValueFacts: 2 });
  t.includes(bare.text, "graph.json", "无 treeDir 时退化为 graph.json，但仍有指向");
  // 没有省略时不许出这一行（零成本）
  const all = renderLedger(g, { maxTokens: 4000, factGuard: true, maxValueFacts: VALUE_FACT_RENDER_LIMIT });
  t.eq(all.valueFactStats.omitted, 0, "没有省略时省略数必须是 0");
  t.eq(all.text.includes("未展开"), false, "没有省略却印了省略行");
};

tests["AX-08 ⑦：预算不足先裁叙事 —— 值事实一条不缩，失败边先降到最近若干条"] = (t) => {
  const facts = createdFacts("D:/x/keep.mjs", 5);
  const g = valueFactGraph({ facts, failures: 40, sessionId: "ax08-budget" });
  const wide = renderLedger(g, { maxTokens: 4000, factGuard: true });
  const tight = renderLedger(g, { maxTokens: 300, factGuard: true });
  t.eq(tight.level >= 4, true, `紧预算必须降到兜底档（实际 L${tight.level}）—— 这就是「先裁叙事」的实现形式`);
  t.eq(tight.shownFailures < wide.shownFailures, true, `叙事（失败边）必须真的被裁掉（${tight.shownFailures} < ${wide.shownFailures}）`);
  t.includes(tight.text, "VALUE FACTS", "值事实段不许被裁掉");
  t.includes(tight.text, "D:/x/keep.mjs", "成功 write 的路径必须还在（K-2 S1-Q1 不许被预算挤没）");
  t.includes(tight.text, "(seq 5)", "seq 也不许被裁");
  t.eq(tight.valueFactStats.shown, 1, "值事实条数不随档位缩水");
  t.eq(["none", "over-budget"].includes(tight.fallback), true, `兜底三态必须显式（实际 ${tight.fallback}）`);
};

tests["AX-08 ⑧：摘要硬事实块与零失败最小清单 —— guard 关掉一行不加，开启时带 evidence=seq"] = (t) => {
  const facts = createdFacts("D:/x/facts.mjs", 5);
  const g = valueFactGraph({ facts, sessionId: "ax08-surfaces" });
  // renderFacts（摘要臂）
  const factsOff = renderFacts(g);
  t.eq(factsOff.includes("VALUE_FACTS"), false, "guard 关掉时摘要硬事实块一个字符都不加");
  const factsOn = renderFacts(g, { factGuard: true });
  t.includes(factsOn, "VALUE_FACTS_VERBATIM (1 of 1", "摘要臂要带条数");
  t.includes(factsOn, "evidence=seq 5", "摘要臂同样要带 seq");
  t.includes(factsOn, "D:/x/facts.mjs", "值必须在");
  // renderMinimalLedger（零失败会话）
  const minimalGraph = valueFactGraph({ facts, sessionId: "ax08-min" });
  t.eq(renderLedger(minimalGraph, { maxTokens: 500 }).failureCount, 0, "夹具必须零失败边");
  const minOff = renderMinimalLedger(minimalGraph);
  t.eq(minOff.text.includes("VALUE FACTS"), false, "最小清单 guard 关掉时一行不加");
  const minOn = renderMinimalLedger(minimalGraph, { factGuard: true });
  t.includes(minOn.text, "VALUE FACTS", "零失败会话同样要能看到成功结果值（存了就得注入）");
  t.includes(minOn.text, "D:/x/facts.mjs", "路径必须在");
  t.includes(minOn.text, "(seq 5)", "seq 必须在");
  t.eq(minOn.valueFactStats.shown, 1, "最小清单的统计口径要一致");
};

tests["AX-08 ⑨：valueFactDigest —— 值没变同 digest、值变了必变、没有值就是空串"] = (t) => {
  const empty = valueFactGraph({ facts: [], sessionId: "ax08-digest" });
  t.eq(valueFactDigest(empty), "", "没有值事实时必须返回空串（hot-inject 据此保持旧判据）");
  const facts = createdFacts();
  const a = valueFactGraph({ facts, sessionId: "ax08-digest-a" });
  const b = valueFactGraph({ facts, sessionId: "ax08-digest-b" });
  t.eq(valueFactDigest(a), valueFactDigest(b), "同样的值 ⇒ 同一个 digest（「不重复注入」的前提）");
  const more = valueFactGraph({ facts: [...facts, ...apiFacts(9)], sessionId: "ax08-digest-a" });
  t.ne(valueFactDigest(more), valueFactDigest(a), "多出值事实 ⇒ digest 必须变（否则新的值永远送不到）");
};

tests["AX-08 ⑩：collectValueFacts / planValueFacts / renderValueFactLine 的纯函数契约"] = (t) => {
  const facts = createdFacts();
  const g = valueFactGraph({ facts, sessionId: "ax08-pure" });
  const collected = collectValueFacts(g);
  t.eq(collected.total, 1, "一条事实");
  t.eq(collected.malformed, 0, "合法事实不许计坏数据");
  t.eq(isValueFact(facts[0]), true, "源事实必须满足 AX-02 契约");
  const [fact] = collected.facts;
  t.eq(fact.text, facts[0].value, "渲染用的文本必须逐字等于原值（不改写、不截断）");
  t.eq(fact.evidenceSeq, 5, "证据指针 = 结果事件 seq");
  t.eq(fact.validAtSeq, 5, "缺省 validAtSeq = evidenceSeq");
  t.eq(renderValueFactLine(fact), `- ${fact.edgeId} file_created ${facts[0].value} (seq 5)`, "行格式冻结（改它 = 改行为）");
  const plan = planValueFacts(collected.facts, { limit: 1 });
  t.eq(plan.shown.length, 1, "限额内全渲染");
  t.eq(plan.omitted, 0, "没有省略");
  t.eq(plan.pointer, "graph.json", "没有 treeDir 时指针退化为 graph.json");
  // 坏数组（不是数组）也要计入 malformed，而不是抛
  const brokenGraph = valueFactGraph({ facts: [], sessionId: "ax08-pure-b" });
  Object.values(brokenGraph.edges)[0].valueFacts = "not-an-array";
  t.eq(collectValueFacts(brokenGraph).malformed, 1, "非数组必须计 malformed（不静默、不抛）");
};
