/**
 * archive-value.test.mjs —— 归档补折价值核算的守卫。
 *
 * 失败分支必须真红：热清单若被塞进分母、0 次使用若算出 $0/次、归档前读取若被计入、
 * 共用模板行若跨会话认领、四选一若永不返回 C，这里的断言都会失败。
 * 全部夹具离线，不访问 live home、不调模型。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";
import * as audit from "../scripts/archive-value-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";

export const tests = {};
const {
  bareSessionId,
  normalizeUsage,
  foldCost,
  unitCost,
  extractTreeRefs,
  buildFingerprintIndex,
  matchingSources,
  scanSessionEvents,
  summarizeUses,
  classifyVerdict,
  audit: runAudit,
  renderReport,
  main,
} = audit;

const SOURCE_UUID = "11111111-1111-4111-8111-111111111111";
const READER_UUID = "22222222-2222-4222-8222-222222222222";
const SOURCE = `session-${SOURCE_UUID}`;
const READER = `session-${READER_UUID}`;
const AS_OF = 10_000;
const UNIQUE_LINE = "- n7 这是一条足够长且只属于源会话的归档摘要事实行，用来证明跨会话摘要确实复用了旧内容，并且带有可核验细节。";
const archiveMap = () => new Map([[bareSessionId(SOURCE), { id: SOURCE, latestAt: 1_000, archiveAts: [1_000], marks: 1, costUsd: 2 }]]);
const fingerprints = () => buildFingerprintIndex([[bareSessionId(SOURCE), `## 目标\n${UNIQUE_LINE}`]]);

function call(name, args, { seq = 20, time = 2_000, id = `${name}-1`, assistant = false } = {}) {
  if (assistant) {
    return { type: "assistant/message", seq, time, data: { content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }] } };
  }
  return { type: "tool/call", seq, time, data: { callId: id, name, arguments: JSON.stringify(args) } };
}

tests["V01 usage 四种形状归一；cached 裸数不能丢，成本有限且非负"] = (t) => {
  const camel = normalizeUsage({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 }, { model: "deepseek-flash" });
  t.eq(camel.cacheReadTokens, 900);
  const openAI = normalizeUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens: 60, total_tokens: 1060 }, { model: "deepseek-flash" });
  t.eq([openAI.inputTokens, openAI.cacheReadTokens, openAI.outputTokens], [1000, 200, 60]);
  const short = normalizeUsage({ input: 100, cached: 900, output: 50, total: 1050 }, { model: "deepseek-flash" });
  t.eq([short.inputTokens, short.cacheReadTokens, short.outputTokens], [100, 900, 50]);
  const cost = foldCost({ at: 0, route: { model: "deepseek-flash" }, usage: { input: 100, cached: 900, output: 50, total: 1050 } });
  t.ok(cost.costUsd > 0 && Number.isFinite(cost.costUsd), "cached 若被当成 0，精确成本断言会偏离");
};

tests["V02 单位成本：分母 0 必须是 null，不能造出 Infinity 或 $0/次"] = (t) => {
  t.eq(unitCost(12, 3), 4);
  t.eq(unitCost(12, 0), null);
  t.eq(unitCost(12, -1), null);
};

tests["V03 树路径只认带 sid 的 chess-context；裸 n1/graph.json 不算"] = (t) => {
  const path = `D:/DeepSeek Harness/home/chess-context/sessions/${SOURCE}/nodes/n7.md`;
  const refs = extractTreeRefs(`read ${path} and graph.json and n1`);
  t.eq(refs, [{ source: bareSessionId(SOURCE), asset: "nodes/n7.md" }]);
  t.eq(extractTreeRefs("read graph.json; grep n1"), []);
};

tests["V04 指纹：短行与跨会话共用行剔除，独有长行才可归属"] = (t) => {
  const index = buildFingerprintIndex([
    ["a", `${UNIQUE_LINE}\n## 目标\n短行`],
    ["b", `${UNIQUE_LINE}\n- 另一个会话独有的内容`],
  ]);
  t.eq(index.size, 0, "同一行出现在 a/b 两个源会话时必须整条剔除");
  const one = fingerprints();
  t.eq([...matchingSources(`前缀\n${UNIQUE_LINE}\n后缀`, one)], [bareSessionId(SOURCE)]);
  t.eq([...matchingSources("## 目标\n短行", one)], []);
};

tests["V05 新会话 compaction/summary 复用旧摘要 = 真使用；同会话不算"] = (t) => {
  const event = { type: "compaction/summary", seq: 9, time: 2_000, data: { summary: `## 目标\n${UNIQUE_LINE}` } };
  const cross = scanSessionEvents([event], { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: fingerprints(), asOf: AS_OF });
  t.eq(cross.uses.filter((row) => row.kind === "summary").length, 1);
  const same = scanSessionEvents([event], { readerSessionId: SOURCE, archive: archiveMap(), fingerprintIndex: fingerprints(), asOf: AS_OF });
  t.eq(same.uses.filter((row) => row.kind === "summary").length, 0);
};

tests["V06 主动 read/grep：归档前与 asOf 后都排除；assistant/tool/call 双写去重"] = (t) => {
  const path = `D:/DeepSeek Harness/home/chess-context/sessions/${SOURCE}/nodes/n7.md`;
  const args = { file_path: path };
  const events = [
    call("read", args, { seq: 1, time: 500, id: "before" }),
    call("read", args, { seq: 2, time: 2_000, id: "same", assistant: true }),
    call("read", args, { seq: 2, time: 2_000, id: "same" }),
    call("read", args, { seq: 3, time: AS_OF + 1, id: "future" }),
  ];
  const got = scanSessionEvents(events, { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: new Map(), asOf: AS_OF });
  t.eq(got.uses.length, 1, "归档前、未来和双写若漏挡，这里会变成 4/2 次");
  t.eq(got.uses[0].subkinds, ["nodeDoc"]);
};

tests["V07 graph.json 与 lastOfflineSummary 是主动信号；根树 grep 单列不乱归属"] = (t) => {
  const graph = `D:/DeepSeek Harness/home/chess-context/sessions/${SOURCE}/graph.json`;
  const direct = scanSessionEvents([
    call("grep", { path: graph, pattern: "lastOfflineSummary" }, { id: "g1" }),
  ], { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: new Map(), asOf: AS_OF });
  t.eq(direct.uses[0].subkinds, ["graphJson", "lastOfflineSummary"]);
  const root = scanSessionEvents([
    call("grep", { path: "D:/DeepSeek Harness/home/chess-context/sessions", pattern: "lastOfflineSummary" }, { id: "g2" }),
  ], { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: new Map(), asOf: AS_OF });
  t.eq(root.uses.length, 0);
  t.eq(root.unattributedActive, 1);
};

tests["V08 热清单只有曝光：若混入真实使用分母，本测试必须红"] = (t) => {
  const hot = { type: "user/message", seq: 8, time: 2_000, data: { source: { kind: "chess-context" }, content: [{ type: "text", text: UNIQUE_LINE }] } };
  const scanned = scanSessionEvents([hot], { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: fingerprints(), asOf: AS_OF });
  const sum = summarizeUses(archiveMap(), scanned.uses);
  t.eq(sum.signals.hot.events, 1);
  t.eq(sum.trueUses, 0, "T57 的坑：注入是系统行为，不能当被使用");
  t.eq(sum.unitCostUsd, null);
};

tests["V09 hindsight：调用本身不算，结果带回旧摘要才算；自动注入另列"] = (t) => {
  const query = call("hindsight_search_knowledge_pages", { query: "旧项目" }, { id: "h1", seq: 10 });
  const miss = { type: "tool/result", seq: 11, time: 2_001, data: { callId: "h1", content: [{ type: "text", text: "没有相关结果" }] } };
  const hit = { type: "tool/result", seq: 12, time: 2_002, data: { callId: "h1", content: [{ type: "text", text: UNIQUE_LINE }] } };
  const auto = { type: "user/message", seq: 13, time: 2_003, data: { source: { kind: "hindsight" }, content: [{ type: "text", text: UNIQUE_LINE }] } };
  const got = scanSessionEvents([query, miss, hit, auto], { readerSessionId: READER, archive: archiveMap(), fingerprintIndex: fingerprints(), asOf: AS_OF });
  const sum = summarizeUses(archiveMap(), got.uses, { memoryCalls: got.memoryCalls });
  t.eq(sum.memoryCalls, 1);
  t.eq(sum.signals.memoryAgent.events, 1);
  t.eq(sum.signals.memoryAuto.events, 1);
  t.eq(sum.trueUses, 1);
};

tests["V10 分布：少数会话反复使用与零使用会话必须能区分"] = (t) => {
  const archives = archiveMap();
  archives.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { id: "zero", latestAt: 1_000, marks: 2, costUsd: 1 });
  const rows = [
    { kind: "active", source: bareSessionId(SOURCE), reader: "r", seq: 1, callId: "1", subkinds: [] },
    { kind: "active", source: bareSessionId(SOURCE), reader: "r", seq: 2, callId: "2", subkinds: [] },
    { kind: "summary", source: bareSessionId(SOURCE), reader: "r", seq: 3, callId: "", subkinds: [] },
  ];
  const sum = summarizeUses(archives, rows);
  t.eq([sum.trueUses, sum.usedSourceSessions, sum.zeroUseSessions], [3, 1, 1]);
  t.eq(sum.top1Share, 1);
  t.eq(sum.unitCostUsd, 1);
};

tests["V11 A/B/C/D 四个分支都可达到；低使用且贵必须 C"] = (t) => {
  t.eq(classifyVerdict({ marks: 10, costUsd: 10, trueUses: 2, usedSessionShare: 0.5 }), "A");
  t.eq(classifyVerdict({ marks: 10, costUsd: 0.2, trueUses: 0, usedSessionShare: 0 }), "B");
  t.eq(classifyVerdict({ marks: 10, costUsd: 10, trueUses: 0, usedSessionShare: 0 }), "C");
  t.eq(classifyVerdict({ marks: 10, costUsd: 10, trueUses: 999, usedSessionShare: 1, documentedNonRetrievalValue: true }), "D");
};

tests["V12 零使用报告必须直说接近纯浪费，热清单数字不能救场"] = (t) => {
  const report = {
    asOf: AS_OF,
    home: "fixture",
    coverage: { graphFiles: 1, graphsRead: 1, graphErrors: 0, logsFound: 1, logsRead: 1, logErrors: 0, fingerprintLines: 1, uniqueFingerprintLines: 1 },
    archive: { sessions: 1, marks: 1, usageKnown: 1, marksWithText: 1 },
    cost: { totalCostUsd: 2, meanActualPerSegmentUsd: 2, medianInputTokens: 100, medianOutputTokens: 50, typicalColdPerSegmentUsd: 0.001, marksTimesTypicalColdUsd: 0.001, totalInputTokens: 100, totalOutputTokens: 50 },
    usage: summarizeUses(archiveMap(), [{ kind: "hot", source: bareSessionId(SOURCE), reader: READER, seq: 1, subkinds: [] }]),
    debt: null,
    verdict: "C",
    recommendation: "停止自动归档补折",
    verdictRules: audit.VERDICT_RULES,
    caveat: "fixture",
  };
  const text = renderReport(report);
  t.includes(text, "接近纯浪费");
  t.includes(text, "热清单与自动记忆注入不计入分母");
  t.includes(text, "⑤ 判断：C");
};

function writeFixtureHome() {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "archive-value-"));
  const graph = createGraph({ sessionId: SOURCE, cwd: "E:/fixture" });
  graph.nodes = { n1: { id: "n1", kind: "user", seq: 1, turn: null, text: "goal", ts: 1 } };
  graph.order = ["n1"];
  graph.foldMarks = [{
    at: 1_000,
    trigger: "archive-offline",
    seqStart: 1,
    seqEnd: 1,
    route: { model: "deepseek-flash" },
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    summaryText: UNIQUE_LINE,
  }];
  graph.closeout = { foldAttempted: true, folded: 1 };
  const dir = nodePath.join(home, "chess-context", "sessions", SOURCE);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph));
  const events = [
    { type: "compaction/summary", seq: 2, time: 2_000, data: { summary: UNIQUE_LINE } },
    { type: "user/message", seq: 3, time: 2_001, data: { source: { kind: "chess-context" }, content: [{ type: "text", text: UNIQUE_LINE }] } },
    call("read", { file_path: `D:/DeepSeek Harness/home/chess-context/sessions/${SOURCE}/graph.json` }, { seq: 4, time: 2_002, id: "r1" }),
    call("hindsight_search_knowledge_pages", { query: "旧事实" }, { seq: 5, time: 2_003, id: "h1" }),
    { type: "tool/result", seq: 6, time: 2_004, data: { callId: "h1", content: [{ type: "text", text: UNIQUE_LINE }] } },
  ];
  const logDir = nodePath.join(home, "sessions", "workspace", READER_UUID);
  nodeFs.mkdirSync(logDir, { recursive: true });
  const compressed = events.map((event) => nodeZlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)));
  nodeFs.writeFileSync(nodePath.join(logDir, "session.v4.jsonl.zstd"), Buffer.concat(compressed));
  return home;
}

tests["V13 端到端：三类真实使用各 1；热清单曝光不加分；成本与欠账估算分离"] = (t) => {
  const home = writeFixtureHome();
  try {
    const result = runAudit({ home, asOf: AS_OF, includeDebt: false });
    t.eq(result.archive.marks, 1);
    t.eq(result.usage.signals.summary.events, 1);
    t.eq(result.usage.signals.active.events, 1);
    t.eq(result.usage.signals.memoryAgent.events, 1);
    t.eq(result.usage.signals.hot.events, 1);
    t.eq(result.usage.trueUses, 3);
    t.eq(result.verdict, "A");
    t.ok(result.cost.totalCostUsd > 0, "真实 usage 必须进入成本");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["V14 CLI 错误 home/未知参数返回 2，不静默拿别的 home 充数"] = (t) => {
  t.eq(main(["--unknown"]), 2);
  t.eq(main(["--home", "D:/definitely/not/a/real/archive-value-home", "--as-of", "1970-01-01T00:00:10Z"]), 2);
  t.eq(main(["--as-of", "not-a-date"]), 2);
};

tests["V15 分段时序：两段之间读取可算第一段；第三段正文不许倒算到第一段"] = (t) => {
  const archives = archiveMap();
  archives.get(bareSessionId(SOURCE)).archiveAts = [1_000, 3_000];
  const path = `D:/DeepSeek Harness/home/chess-context/sessions/${SOURCE}/nodes/n7.md`;
  const between = scanSessionEvents([
    call("read", { file_path: path }, { time: 2_000, id: "between" }),
  ], { readerSessionId: READER, archive: archives, fingerprintIndex: new Map(), asOf: AS_OF });
  t.eq(between.uses.length, 1, "若只看 latestAt=3000，这次第一段摘要之后的使用会被漏掉");

  const lateFingerprints = buildFingerprintIndex([[bareSessionId(SOURCE), [{ text: UNIQUE_LINE, at: 3_000 }]]]);
  const summaryAt = (time) => ({ type: "compaction/summary", seq: 30, time, data: { summary: UNIQUE_LINE } });
  const beforeThird = scanSessionEvents([summaryAt(2_000)], { readerSessionId: READER, archive: archives, fingerprintIndex: lateFingerprints, asOf: AS_OF });
  const afterThird = scanSessionEvents([summaryAt(3_001)], { readerSessionId: READER, archive: archives, fingerprintIndex: lateFingerprints, asOf: AS_OF });
  t.eq(beforeThird.uses.filter((row) => row.kind === "summary").length, 0, "正文所属折痕还没发生时不能提前记使用");
  t.eq(afterThird.uses.filter((row) => row.kind === "summary").length, 1);
};
