/**
 * usage-score.test.mjs —— 「用量打分」这个候选指标的度量守卫（T57）
 *
 * 为什么需要守卫：这个脚本的全部价值在**三个减法**上，三个都会静默地给出假绿 ——
 *
 *   ① **工具参数是 JSON 文本，`\n` 是转义换行，不是字母 n。**
 *      直接拿 `independentIds` 抽 id，`\n1` 会被数成节点 `n1`。
 *      真机实测：不挡这一条，「引用过节点的会话」从 55 个变成 367 个 ——
 *      **假阳比真信号大 6 倍**，而报告看起来完全正常（精确率还会变好看）。
 *
 *   ② **`index.md` / `graph.json` 满地都是，只有落在 `chess-context/sessions/<sid>/`
 *      下面才算「读了 kifu」。** 不设这条前缀，真机 828 个工具调用会被全算成
 *      「读了棋谱」，而真的只有 386 次树引用 / 32 次节点文档读取。
 *
 *   ③ **摘要正文是 block 数组，不是字符串。**
 *      `compaction/summary.data.summary` 实测是 `[{type:"text", text:"## 目标…"}]`。
 *      只判 `typeof === "string"` 会把**全部**摘要判成「没送达」（S2 送达率算成 0.00%，
 *      而真机 44 个会话明明送达了）—— 于是整个「摘要口径」的结论都是假的。
 *
 * 另外钉住三件事：
 *   · **「被注入」≠「被使用」**：`tool/result` 回显里的 id 不算用量（那是喂进去的）；
 *   · **跨会话读按路径里的 `sid` 归属**，不按「谁在写日志」—— 反过来会全算到读者头上；
 *   · **判据 ① 必须能返回「不通过」**，也必须**能通过**（恒假的判据和恒真的判据一样没用）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉
//   （C641 的教训：具名导入缺符号 ⇒ 后面所有测试文件都不跑）。
import * as audit from "../scripts/usage-score-audit.mjs";

export const tests = {};

const {
  CRITERIA_RULES,
  DISTANCE_BANDS,
  normalizeToolArgs,
  nodeIdsIn,
  parseTreeRefs,
  extractUsage,
  buildUsageRows,
  summarizeSource,
  correlationsOf,
  judgeCriteria,
  compactionSummaryTextOf,
  normalizeSessionId,
  displayWidth,
  padDisplay,
  parseArgs,
  audit: scan,
  renderReport,
} = audit;

/* ───────────────────────────── 夹具 ───────────────────────────── */

const SID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SID_B = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = 1793000000000;

/** 造一张最小棋谱：节点 + 边 + 归档摘要。 */
function makeGraph({
  sessionId = SID_A,
  nodes = [
    { id: "n1", kind: "user", seq: 10 },
    { id: "n2", kind: "agent", seq: 20 },
    { id: "n3", kind: "agent", seq: 30 },
    { id: "n4", kind: "user", seq: 40 },
  ],
  edges = [
    { id: "e1", from: "n1", to: "n2", result: "success", evidence: { start: 10, end: 15 } },
    { id: "e2", from: "n2", to: "n3", result: "failure", evidence: { start: 20, end: 25 } },
    { id: "e3", from: "n3", to: "n4", result: "success", evidence: { start: 30, end: 35 } },
  ],
  summaryText = "## 目标\n- n1 用户给定契约\n- n2 助手读文档\n",
  archiveSeq = 40,
  closeout = { at: NOW, folds: 1, source: "archive-offline", folded: 1, partial: false },
} = {}) {
  const g = {
    version: 1,
    sessionId,
    cwd: "E:/fixture",
    createdAt: NOW,
    updatedAt: NOW,
    nextNode: 5,
    nextEdge: 4,
    nodes: {},
    edges: {},
    order: [],
    foldMarks: [{ at: NOW, seqStart: 10, seqEnd: archiveSeq, trigger: "archive-offline" }],
    closeout,
  };
  for (const node of nodes) {
    g.nodes[node.id] = { turn: null, text: "", constraints: [], ts: NOW, ...node };
    g.order.push(node.id);
  }
  for (const edge of edges) {
    g.edges[edge.id] = { intent: "", action: "bash(command=ls)", verify: { kind: "none", summary: "" }, errorSnippet: "", ...edge };
  }
  if (summaryText !== null) g.lastOfflineSummary = { at: NOW, range: { start: 10, end: archiveSeq }, text: summaryText, model: null };
  return g;
}

/** 一条注入事件（热清单）。 */
const ledgerEvent = (seq, text) => ({
  type: "user/message",
  seq,
  data: { content: [{ type: "text", text }], source: { kind: "chess-context", form: "ledger" } },
});

/** 一条 agent 消息（`blocks` 原样给，便于造 `text` / `reasoning` / `tool-call`）。 */
const assistantEvent = (seq, blocks) => ({ type: "assistant/message", seq, data: { message: { role: "assistant", content: blocks } } });

/** 一条工具调用（参数统一序列化成 JSON 文本，与真机一致）。 */
const toolCallEvent = (seq, args) => ({ type: "tool/call", seq, data: { turn: 1, step: 1, callId: `c${seq}`, name: "bash", arguments: JSON.stringify(args) } });

/** 一条工具结果（回显里出现 id —— 这是「喂进去的」，不许算用量）。 */
const toolResultEvent = (seq, text) => ({ type: "tool/result", seq, data: { content: [{ type: "text", text }] } });

/** 把事件写成**多帧** zstd 会话日志（宿主就是逐条帧写的）。 */
function writeSessionLog(dir, events) {
  nodeFs.mkdirSync(dir, { recursive: true });
  const frames = events.map((event) => nodeZlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8")));
  nodeFs.writeFileSync(nodePath.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
}

/** 造一个最小 DSH_HOME（两棵树 + 两份日志），返回根目录。 */
function makeHome() {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "usage-score-"));
  const graphRoot = nodePath.join(home, "chess-context", "sessions");
  const logRoot = nodePath.join(home, "sessions", "ws");

  // 图 A：8 个节点，摘要列了 n1..n6，热清单只列 n2，agent 只引用了 n2
  //   ⇒ 6 个「被列出」的节点里只有 1 个被用上（真机形态：精确率极低）
  const nodesA = Array.from({ length: 8 }, (_, i) => ({
    id: `n${i + 1}`,
    kind: i === 0 ? "user" : "agent",
    seq: 10 * (i + 1),
  }));
  const graphA = makeGraph({
    sessionId: SID_A,
    nodes: nodesA,
    edges: [{ id: "e1", from: "n1", to: "n2", result: "success", evidence: { start: 10, end: 15 } }],
    summaryText: `## 目标\n${nodesA
      .slice(0, 6)
      .map((node) => `- ${node.id} 步骤`)
      .join("\n")}\n`,
    archiveSeq: 80,
  });
  const eventsA = [
    ledgerEvent(42, "<chess-ledger>\n# path: n2\nLEARNED\n- e2 失败\n</chess-ledger>"),
    assistantEvent(43, [{ type: "text", text: "n2 说明这个方向不通" }]),
    toolResultEvent(44, "回显里写着 n5：这只是工具输出，不算用量"),
  ];

  // 图 B：只被注入、从没被引用 ⇒ 0 个用上
  const graphB = makeGraph({
    sessionId: SID_B,
    nodes: [
      { id: "n1", kind: "user", seq: 5 },
      { id: "n4", kind: "agent", seq: 12 },
    ],
    edges: [{ id: "e1", from: "n1", to: "n4", result: "success", evidence: { start: 5, end: 9 } }],
    summaryText: "## 目标\n- n4 结论\n",
    archiveSeq: 20,
  });
  const eventsB = [ledgerEvent(21, "<chess-ledger>\n# path: n4\n</chess-ledger>")];

  for (const [sid, graph, events] of [
    [SID_A, graphA, eventsA],
    [SID_B, graphB, eventsB],
  ]) {
    nodeFs.mkdirSync(nodePath.join(graphRoot, sid), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(graphRoot, sid, "graph.json"), JSON.stringify(graph));
    writeSessionLog(nodePath.join(logRoot, sid), events);
  }
  return home;
}

/* ───────────────────────── ① 抽取口径（三个静默假绿） ───────────────────────── */

tests["U-1 JSON 转义 `\\n` + 数字**不是**节点 id（假阳比真信号大 6 倍的那个坑）"] = (t) => {
  const valid = new Set(["n1", "n2", "n12"]);
  // 真机形态：参数是 JSON 文本，换行是 `\n` 两个字符
  const raw = JSON.stringify({ command: "echo a\n1\necho b\n2" });
  t.includes(raw, "\\n1", "夹具本身必须含 `\\n1` 这两个字符");
  t.eq(normalizeToolArgs(raw).includes("n1"), false, "归一化后不许再出现 `n1`");
  t.eq(nodeIdsIn(normalizeToolArgs(raw), valid), [], "`\\n1` 不是节点 n1");
  t.eq(nodeIdsIn(normalizeToolArgs(JSON.stringify({ c: "list\n12\n" })), valid), [], "`\\n12` 也不是 n12");

  // 反例：真正的引用必须命中（否则这条判据就是「什么都不算」）
  t.eq(nodeIdsIn("见 n1 节点", valid), ["n1"], "正文里的 n1 要命中");
  t.eq(nodeIdsIn("n12 与 n1 都提到了", valid), ["n12", "n1"], "两个都命中");
  t.eq(nodeIdsIn("e12 不是节点", valid), [], "边 id 不算节点");
  t.eq(nodeIdsIn("the1 不是 e1", new Set(["e1"])), [], "`the1` 不算 e1（独立标识符边界）");
};

tests["U-2 只有落在 `chess-context/sessions/<sid>/` 下面才算「读了 kifu」"] = (t) => {
  t.eq(parseTreeRefs("cat /d/repo/docs/index.md"), [], "本仓自己的 index.md 不算");
  t.eq(parseTreeRefs("read D:/repo/graph.json"), [], "裸 graph.json 不算");
  t.eq(parseTreeRefs("cat /d/home/chess-context/README.md"), [], "chess-context 根目录下的文件不算（不在 sessions/ 下）");
  // ★ 有 uuid 但**不是** chess-context 的树（别的工具/别的记忆库长得一模一样）—— 必须不认
  t.eq(
    parseTreeRefs(`cat /d/other/agent-memory/sessions/${SID_A}/nodes/n5.md`),
    [],
    "只有 uuid 不够：树必须在 `chess-context/sessions/` 下面（否则别人的树会被算成 kifu 用量）",
  );
  t.eq(
    parseTreeRefs(`grep -n n5 "/d/other/sessions/${SID_A}/graph.json"`),
    [],
    "非 chess-context 的 graph.json 也不算",
  );

  const forward = parseTreeRefs(`head -40 "/d/home/chess-context/sessions/${SID_A}/nodes/n12.md"`);
  t.eq(forward.length, 1, "正斜杠路径要命中");
  t.eq(forward[0].sessionId, SID_A, "sid 解析正确");
  t.eq(forward[0].nodeId, "n12", "节点 id 解析正确");
  t.eq(forward[0].kind, "node-doc", "kind = node-doc");

  // 反斜杠版本（JSON 文本里是 `\\`）
  const json = JSON.stringify({ command: `cat "D:\\\\h\\\\chess-context\\\\sessions\\\\${SID_A}\\\\nodes\\\\n7.md"` });
  const back = parseTreeRefs(json);
  t.eq(back.length, 1, "反斜杠路径也要命中（JSON 文本里是双反斜杠）");
  t.eq(back[0].nodeId, "n7", "反斜杠路径的节点 id");

  // `session-` 前缀归一
  const prefixed = parseTreeRefs(`ls /h/chess-context/sessions/session-${SID_A}/index.md`);
  t.eq(prefixed.length, 1, "`session-<uuid>` 目录名要命中");
  t.eq(prefixed[0].sessionId, SID_A, "`session-` 前缀必须剥掉（否则跨会话永远匹配不上）");
  t.eq(prefixed[0].nodeId, null, "index.md 是树级引用，没有具体节点");

  t.eq(normalizeSessionId(`session-${SID_A.toUpperCase()}`), SID_A, "normalizeSessionId 同时剥前缀 + 转小写");
};

tests["U-3 `compaction/summary.data.summary` 是 block 数组，不是字符串"] = (t) => {
  // 真机形态（实测）：summary 是 3 个 text block
  const event = {
    type: "compaction/summary",
    seq: 9,
    data: { compactionId: "c1", summary: [{ type: "text", text: "## 目标\n- n284 拉取通知\n" }, { type: "text", text: "- e6 失败\n" }] },
  };
  const text = compactionSummaryTextOf(event);
  t.includes(text, "n284", "数组形态也要抽得出正文（否则 S2 送达率恒为 0）");
  t.includes(text, "e6", "第二块也在");
  t.eq(compactionSummaryTextOf({ type: "compaction/summary", data: { summary: "纯字符串" } }), "纯字符串\n", "字符串形态兼容");
  t.eq(compactionSummaryTextOf({ type: "user/message", data: { content: [{ type: "text", text: "checkpoint" }] } }), "\ncheckpoint", "checkpoint 形态兼容");
};

/* ───────────────────────── ② 「被注入」≠「被使用」 ───────────────────────── */

tests["U-4 列出 / 使用 / 回显三件事必须分开"] = (t) => {
  const graph = makeGraph();
  const events = [
    ledgerEvent(42, "<chess-ledger>\n# path: n2 → n3\n</chess-ledger>"),
    assistantEvent(43, [{ type: "text", text: "n2 不通，n3 待查" }]),
    toolResultEvent(44, "工具输出里写着 n1 和 n4"),
  ];
  const usage = extractUsage(events, { sessionId: SID_A, validOf: (sid) => (sid === SID_A ? new Set(Object.keys(graph.nodes)) : null) });
  const report = buildUsageRows({ graph, usage, sessionId: SID_A });
  const byId = new Map(report.rows.map((row) => [row.nodeId, row]));

  t.eq(byId.get("n2").listedLedger, true, "n2 被清单列出");
  t.eq(byId.get("n3").listedLedger, true, "n3 被清单列出");
  t.eq(byId.get("n2").used, true, "n2 被引用 ⇒ 用上");
  t.eq(byId.get("n3").used, true, "n3 被引用 ⇒ 用上");
  t.eq(byId.get("n1").used, false, "**工具回显里的 n1 不许算用量**（那是喂进去的；它只因为摘要列过才进表）");
  t.eq(byId.get("n1").score, 0, "n1 的用量分 = 0");
  t.eq(byId.get("n4"), undefined, "**工具回显里的 n4 不许算用量**（摘要也没列过它 ⇒ 根本不在表里）");
  t.eq(byId.get("n2").usageKind, "cite", "强度档 = cite");
  t.eq(byId.get("n3").cites, 1, "cite 计数");
  t.eq(byId.get("n2").listedAt, 42, "记下列出时的 seq");
  t.eq(byId.get("n2").usedAfterListed, true, "使用晚于列出");
};

tests["U-5 跨会话读按**路径里的 sid** 归属，不按「谁在写日志」"] = (t) => {
  const graphA = makeGraph({ sessionId: SID_A });
  const graphB = makeGraph({
    sessionId: SID_B,
    nodes: [
      { id: "n1", kind: "user", seq: 5 },
      { id: "n4", kind: "agent", seq: 12 },
    ],
    edges: [{ id: "e1", from: "n1", to: "n4", result: "success", evidence: { start: 5, end: 9 } }],
    archiveSeq: 20,
  });
  const validById = new Map([
    [SID_A, new Set(Object.keys(graphA.nodes))],
    [SID_B, new Set(Object.keys(graphB.nodes))],
  ]);
  const validOf = (sid) => validById.get(normalizeSessionId(sid)) ?? null;

  // A 的日志里读了 B 的 n4 文档
  const eventsA = [toolCallEvent(45, { command: `cat "/x/chess-context/sessions/${SID_B}/nodes/n4.md"` })];
  const usageA = extractUsage(eventsA, { sessionId: SID_A, validOf });

  t.eq(usageA.toolTreeRefs, 1, "数到一次树引用");
  t.eq(usageA.toolNodeDocRefs, 1, "数到一次节点文档读取");
  t.eq(usageA.own.reads.size, 0, "**不算 A 自己的用量**（A 的图里没有 n4）");
  t.eq(usageA.cross.get(SID_B)?.get("n4"), 1, "记到 B 头上");

  const reportB = buildUsageRows({ graph: graphB, usage: null, cross: usageA.cross.get(SID_B) ?? null, sessionId: SID_B });
  const n4 = reportB.rows.find((row) => row.nodeId === "n4");
  t.ok(n4 !== undefined, "B 的 n4 必须出现在用量行里（跨会话读不能丢）");
  t.eq(n4.used, true, "n4 被用上");
  t.eq(n4.usageKind, "read", "强度档 = read（最强证据）");
  t.eq(n4.reads, 1, "read 计数");
};

tests["U-6 「读出但不在图里」的 id 不许进表（防伪造 id 撑高召回）"] = (t) => {
  const graph = makeGraph();
  const events = [
    assistantEvent(50, [{ type: "text", text: "我编一个不存在的 n9999" }]),
    toolCallEvent(51, { command: `cat "/x/chess-context/sessions/${SID_A}/nodes/n8888.md"` }),
  ];
  const usage = extractUsage(events, { sessionId: SID_A, validOf: () => new Set(Object.keys(graph.nodes)) });
  const report = buildUsageRows({ graph, usage, sessionId: SID_A });
  t.eq(report.rows.filter((row) => row.nodeId === "n9999").length, 0, "正文里的 n9999 不在图里 ⇒ 丢弃");
  t.eq(report.rows.filter((row) => row.nodeId === "n8888").length, 0, "路径里的 n8888 不在图里 ⇒ 丢弃");
  t.eq(usage.toolTreeRefs, 1, "但树引用本身要计数（说明确实去读了，只是读到空）");
};

/* ───────────────────────── ③ 精确率 / 召回率 ───────────────────────── */

tests["U-7 精确率 = 交集/列出，召回率 = 交集/用上；分母为 0 ⇒ null（不是 0）"] = (t) => {
  const rows = [
    { nodeId: "n1", listedLedger: true, listedSummary: true, used: true, usageKind: "cite", score: 3, band: "1–50（尾部）", sessionId: SID_A },
    { nodeId: "n2", listedLedger: true, listedSummary: false, used: false, usageKind: null, score: 0, band: "1–50（尾部）", sessionId: SID_A },
    { nodeId: "n3", listedLedger: true, listedSummary: false, used: false, usageKind: null, score: 0, band: "51–200（近段）", sessionId: SID_A },
    { nodeId: "n4", listedLedger: true, listedSummary: false, used: false, usageKind: null, score: 0, band: "51–200（近段）", sessionId: SID_A },
    // 用上但没列出（漏）
    { nodeId: "n5", listedLedger: false, listedSummary: false, used: true, usageKind: "read", score: 1, band: "51–200（近段）", sessionId: SID_A },
  ];
  const ledger = summarizeSource(rows, "ledger");
  t.eq(ledger.listed, 4, "列出 4 个");
  t.eq(ledger.used, 2, "用上 2 个");
  t.eq(ledger.both, 1, "交集 1 个");
  t.eq(ledger.precision, 0.25, "精确率 = 1/4");
  t.eq(ledger.recall, 0.5, "召回率 = 1/2");
  t.eq(ledger.noise, 3, "噪声 = 列了没用上 3 个");
  t.eq(ledger.missed, 1, "漏 = 用上但没列 1 个");
  t.eq(ledger.modalScore, 0, "众数 = 0");
  t.eq(ledger.modalShare, 0.6, "众数占比 = 3/5");

  const summary = summarizeSource(rows, "summary");
  t.eq(summary.listed, 1, "摘要口径只列了 n1");
  t.eq(summary.precision, 1, "摘要精确率 = 1/1");

  // 空池：必须 null，不能是 0（`Number(null) === 0` 是本仓踩过的坑）
  const empty = summarizeSource([], "ledger");
  t.eq(empty.precision, null, "空池精确率 = null");
  t.eq(empty.recall, null, "空池召回率 = null");
  t.eq(empty.modalShare, null, "空池众数占比 = null");

  // 分桶：桶内交集必须落在正确的桶
  const tail = ledger.bands.find((band) => band.band === "1–50（尾部）");
  const mid = ledger.bands.find((band) => band.band === "51–200（近段）");
  t.eq(tail.listed, 2, "尾部桶列出 2 个");
  t.eq(tail.both, 1, "尾部桶交集 1 个");
  t.eq(mid.listed, 2, "近段桶列出 2 个");
  t.eq(mid.used, 1, "近段桶用上 1 个（n5 没列出但在桶里）");
};

/* ───────────────────────── ④ 四条判据必须能真红、也必须能真绿 ───────────────────────── */

const criteriaResult = (overrides = {}) => ({
  summary: {
    ledger: { modalShare: 0.5, modalScore: 1, nodes: 100, zeroShare: 0.4, listed: 40, both: 10, precision: 0.25, recall: 0.5 },
    summary: { listed: 40 },
  },
  correlations: {
    tailGap: { spearman: 0.05, n: 100 },
    depth: { spearman: -0.08, n: 100 },
    traceableShare: { spearman: 0.12, n: 50 },
    qualityTotal: { spearman: -0.2, n: 50 },
  },
  base: { circularRate: 1 },
  ...overrides,
});

tests["U-8 判据 ① 在「几乎全 0」的池上必须返回不通过（真红）"] = (t) => {
  const criteria = judgeCriteria(criteriaResult({ summary: { ledger: { modalShare: 0.98, modalScore: 0, nodes: 15721, zeroShare: 0.98 }, summary: { listed: 40 } } }));
  const first = criteria.find((item) => item.key === "①");
  t.eq(first.pass, false, "众数占比 98% ≥ 80% ⇒ 不通过");
  t.includes(first.detail, "97.46%".slice(0, 3) === "97." ? "98.00%" : "98.00%", "明细里要有众数占比");
};

tests["U-9 判据 ① 在「真的有方差」的池上必须返回通过（不能恒假）"] = (t) => {
  const criteria = judgeCriteria(criteriaResult());
  const first = criteria.find((item) => item.key === "①");
  t.eq(first.pass, true, "众数占比 50% < 80% ⇒ 通过");
  t.eq(first.degenerate, false, "不是退化通过");
};

tests["U-10 判据 ②③ 在无方差时标「退化通过」，ρ 超门槛时必须真红"] = (t) => {
  // 无方差 ⇒ ②③ 通过但标 degenerate
  const degenerate = judgeCriteria(
    criteriaResult({ summary: { ledger: { modalShare: 0.99, modalScore: 0, nodes: 10, zeroShare: 0.99 }, summary: { listed: 1 } } }),
  );
  t.eq(degenerate.find((item) => item.key === "②").pass, true, "ρ 小 ⇒ 通过");
  t.eq(degenerate.find((item) => item.key === "②").degenerate, true, "但标退化");

  // ρ 超门槛 ⇒ 真红
  const red = judgeCriteria(
    criteriaResult({
      correlations: {
        tailGap: { spearman: 0.9, n: 100 },
        depth: { spearman: -0.08, n: 100 },
        traceableShare: { spearman: 0.95, n: 50 },
        qualityTotal: { spearman: -0.2, n: 50 },
      },
    }),
  );
  t.eq(red.find((item) => item.key === "②").pass, false, "|ρ(离归档距离)| = 0.9 ≥ 0.2 ⇒ 不通过");
  t.eq(red.find((item) => item.key === "③").pass, false, "|ρ(可定位率)| = 0.95 ≥ 0.8 ⇒ 不通过");

  // 缺测 ⇒ 不可判（null），不许冒充通过
  const unknown = judgeCriteria(
    criteriaResult({
      correlations: { tailGap: { spearman: null, n: 0 }, depth: { spearman: null, n: 0 }, traceableShare: null, qualityTotal: null },
    }),
  );
  t.eq(unknown.find((item) => item.key === "②").pass, null, "缺测 ⇒ 不可判");
  t.eq(unknown.find((item) => item.key === "③").pass, null, "缺测 ⇒ 不可判");
};

tests["U-11 判据 ④ 的循环对照：摘要口径恒等于 1（证明没走循环）"] = (t) => {
  const criteria = judgeCriteria(criteriaResult());
  const fourth = criteria.find((item) => item.key === "④");
  t.eq(fourth.pass, true, "设计保证 ⇒ 通过");
  t.eq(fourth.value, 0, "循环口径率 = 1 ⇒ 与 1 的差 = 0");
  t.includes(fourth.detail, "恒等于 1", "明细里必须写明这条对照");
};

/* ───────────────────────── ⑤ 端到端：真扫一个临时 home ───────────────────────── */

tests["U-12 端到端：扫临时 home，结论 = 不能用，且四个信号都有数"] = (t) => {
  const home = makeHome();
  try {
    const result = scan({ home });
    t.eq(result.graphs, 2, "两张图");
    t.eq(result.badGraphs, 0, "没有坏图");
    t.eq(result.signal.withLog, 2, "两份日志都读到了");
    t.eq(result.signal.ledgerSessions, 2, "S1：两张图都有热清单注入");
    t.eq(result.signal.ledgerEvents, 2, "S1：两次注入");
    t.eq(result.summary.ledger.listed, 2, "S1：热清单只列了 n2（A）与 n4（B）");
    t.eq(result.signal.summarySessions, 2, "S2：两张图的摘要都带节点 id");
    t.eq(result.signal.summaryDeliveredSessions, 0, "S2 送达：夹具里没有 compaction/summary ⇒ 0");
    t.eq(result.signal.closeoutNodeIdSessions, 0, "S3：closeout 里没有节点 id ⇒ 不可用");
    t.eq(result.signal.toolTreeRefs, 0, "S4：夹具里没有树引用");
    t.eq(result.signal.toolNodeDocRefs, 0, "S4：一次节点文档读取都没有");
    t.eq(result.signal.usedSessions, 1, "只有 A 有引用（B 只有注入）");

    // 精确率 / 召回率（A 的摘要列 6 个、只引用 1 个；B 的摘要列 1 个、引用 0 个）
    t.eq(result.summary.summary.listed, 7, "摘要列出 7 个 (会话,节点) 对");
    t.eq(result.summary.ledger.used, 1, "用上 1 个（n2）");
    t.eq(result.summary.ledger.both, 1, "交集 1 个");
    t.eq(result.summary.ledger.precision, 0.5, "热清单精确率 = 1/2");
    t.eq(result.summary.ledger.recall, 1, "召回率 = 1/1");

    // 四条判据
    t.eq(result.criteria.length, 4, "四条判据");
    t.eq(
      result.criteria.find((item) => item.key === "①").pass,
      false,
      "8 个节点里 7 个用量分为 0 ⇒ 众数占比 87.5% ≥ 80% ⇒ ① 不通过",
    );
    t.eq(result.verdict, "unusable", "结论 = 不能用");

    // 报告必须包含五个段落
    const text = renderReport(result);
    for (const heading of ["## ① 四个候选信号", "## ② 精确率 / 召回率", "## ③ 四条判据", "## ④ 能不能用", "## ⑤ 如果不可观测，缺什么数据"]) {
      t.includes(text, heading, `报告要有「${heading}」`);
    }
    t.includes(text, "不能用", "一句话结论要给出判定");
    t.includes(text, "S3 closeout 的读记录", "四个信号逐个列");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["U-13 `--no-logs` 时覆盖率记「未观测」（null），不许记 0"] = (t) => {
  const home = makeHome();
  try {
    const result = scan({ home, logs: "none" });
    t.eq(result.graphs, 2, "图照样读到");
    t.eq(result.signal.withLog, 0, "没有日志");
    t.eq(result.signal.coverage.ledger, null, "S1 覆盖率 = null（未观测）");
    t.eq(result.signal.coverage.used, null, "使用覆盖率 = null");
    t.eq(result.signal.coverage.closeout, 0, "S3 是「有图就能判」，所以仍然是 0（不是 null）");
    const text = renderReport(result);
    t.includes(text, "未观测", "报告里要写「未观测」");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["U-14 坏图 / 空 home 不崩（退出码语义在 CLI 层）"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "usage-score-empty-"));
  try {
    const result = scan({ home });
    t.eq(result.graphs, 0, "空 home ⇒ 0 张图");
    // 没有数据 ⇒ 判据全部不可判 ⇒ "partial"（CLI 层用退出码 2 兜底，见文件头）
    t.eq(result.verdict, "partial", "0 张图时结论是「不可判」，绝不能默认「能用」");
    const text = renderReport(result);
    t.includes(text, "没有任何节点被使用", "明细段给出明确说明");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  // 坏 JSON 的图要计入 badGraphs，不能静默当成「没有节点」
  const broken = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "usage-score-broken-"));
  try {
    const dir = nodePath.join(broken, "chess-context", "sessions", SID_A);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), "{ not json");
    const result = scan({ home: broken });
    t.eq(result.graphs, 0, "坏图不算图");
    t.eq(result.badGraphs, 1, "坏图单独计数（不吞）");
  } finally {
    nodeFs.rmSync(broken, { recursive: true, force: true });
  }
};

/* ───────────────────────── ⑥ 杂项：相关 / 分档 / 表格 / CLI ───────────────────────── */

tests["U-15 相关系数：常数序列 ⇒ null（不返回 0）"] = (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ score: 3, tailGap: i * 10, depth: i }));
  const constant = correlationsOf(rows);
  t.eq(constant.tailGap.spearman, null, "score 全相同 ⇒ 无方差 ⇒ ρ = null");
  t.eq(constant.depth.spearman, null, "同上");

  const varied = correlationsOf([
    { score: 1, tailGap: 10, depth: 0 },
    { score: 2, tailGap: 20, depth: 1 },
    { score: 3, tailGap: 30, depth: 2 },
    { score: 4, tailGap: 40, depth: 3 },
  ]);
  t.eq(varied.tailGap.spearman, 1, "完全单调 ⇒ ρ = 1");
  t.eq(varied.tailGap.n, 4, "样本数");
  // 缺测必须剔除，不能当 0
  const withNull = correlationsOf([
    { score: 1, tailGap: null, depth: 0 },
    { score: 2, tailGap: 20, depth: 1 },
    { score: 3, tailGap: 30, depth: 2 },
    { score: 4, tailGap: 40, depth: 3 },
  ]);
  t.eq(withNull.tailGap.n, 3, "缺测那条被剔除");
};

tests["U-16 分桶边界归左（tailGap = 0 是「归档时的状态」）"] = (t) => {
  const bandOf = (gap) => DISTANCE_BANDS.find((spec) => spec.test(gap))?.band ?? null;
  t.eq(bandOf(0), "≤0（归档点及之后）", "0 进第一桶");
  t.eq(bandOf(-5), "≤0（归档点及之后）", "负值也进第一桶（不吞成 null）");
  t.eq(bandOf(1), "1–50（尾部）", "1 进第二桶");
  t.eq(bandOf(50), "1–50（尾部）", "50 还是第二桶");
  t.eq(bandOf(51), "51–200（近段）", "51 进第三桶");
  t.eq(bandOf(200), "51–200（近段）", "200 还是第三桶");
  t.eq(bandOf(201), "201–1000（中段）", "201 进第四桶");
  t.eq(bandOf(1001), "1001+（远段）", "1001 进第五桶");
};

tests["U-17 CJK 表格对齐（显示宽度，不是字符数）"] = (t) => {
  t.eq(displayWidth("abc"), 3, "ASCII 宽度 = 长度");
  t.eq(displayWidth("中文"), 4, "CJK 每字 2 格");
  t.eq(displayWidth("a中"), 3, "混排");
  t.eq(displayWidth(padDisplay("中文", 6)), 6, "补齐后**显示宽度** = 6（4 格 + 2 空格）");
  t.eq(padDisplay("ab", 6, "right"), "    ab", "右对齐");
  t.eq(displayWidth(padDisplay("中文", 8, "right")), 8, "右对齐的显示宽度正确");
};

tests["U-18 CLI 参数解析 + 判据门槛常量与 T52–T56 同源"] = (t) => {
  t.eq(parseArgs([]).limit, 20, "默认 limit = 20");
  t.eq(parseArgs(["--json"]).json, true, "--json");
  t.eq(parseArgs(["--no-logs"]).logs, "none", "--no-logs");
  t.eq(parseArgs(["--home=/x/y"]).home, "/x/y", "--home=");
  t.eq(parseArgs(["--session=abc"]).session, "abc", "--session=");
  t.eq(parseArgs(["--limit=5"]).limit, 5, "--limit=");
  t.eq(parseArgs(["--limit=0"]).limit, 20, "非法 limit 回落默认值");

  t.eq(CRITERIA_RULES.maxConstantShare, 0.8, "判据 ① 门槛 = 80%");
  t.eq(CRITERIA_RULES.maxAbsRhoShape, 0.2, "判据 ② 门槛 = 0.2");
  t.eq(CRITERIA_RULES.maxRhoRedundant, 0.8, "判据 ③ 门槛 = 0.8");
};

tests["U-19 反事实：清单之后的边按「from 被列出没有」分组，清单之前的边不算"] = (t) => {
  const graph = makeGraph({
    edges: [
      // 清单（seq 42）之前的边：不算进任何一组
      { id: "e1", from: "n1", to: "n2", result: "failure", evidence: { start: 10, end: 15 } },
      // 清单之后：from=n2（被列出）⇒ listed 组
      { id: "e2", from: "n2", to: "n3", result: "failure", evidence: { start: 50, end: 55 } },
      // 清单之后：from=n1（没被列出）⇒ unlisted 组
      { id: "e3", from: "n1", to: "n4", result: "success", evidence: { start: 60, end: 65 } },
    ],
  });
  const events = [ledgerEvent(42, "<chess-ledger>\n# path: n2\n</chess-ledger>")];
  const usage = extractUsage(events, { sessionId: SID_A, validOf: () => new Set(Object.keys(graph.nodes)) });
  const report = buildUsageRows({ graph, usage, sessionId: SID_A });
  t.eq(report.counterfactual.listed.edges, 1, "被列出组 1 条边");
  t.eq(report.counterfactual.listed.failures, 1, "被列出组 1 次失败");
  t.eq(report.counterfactual.unlisted.edges, 1, "未列出组 1 条边");
  t.eq(report.counterfactual.unlisted.failures, 0, "未列出组 0 次失败");
};
