import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { zstdCompressSync } from "node:zlib";
import { evaluatePruneAB, main, scanHome } from "../scripts/tool-result-prune-ab.mjs";
import { renderFacts } from "../src/rooms/ledger.mjs";
import { addEdge, addUserNodeId, createGraph, settleEdge, toJSON } from "./graph-fixtures.mjs";

export const tests = {};

const ROOT_TEXT = "完成离线评测。";
const CONSTRAINT = "必须保留现有 API，不得修改默认行为。";
const SNIPPET = "AssertionError: fixture failure at alpha.js:42 expected=1 actual=2";
const PRIVATE_TOOL_BODY = "fixture-private-tool-body";

const userMsg = (text) => ({ type: "user/message", data: { message: { role: "user", content: [{ type: "text", text }] } } });
const asstMsg = (text) => ({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text }] } } });
const toolResult = (text) => ({ type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text }] } } });

function makeGraph({ snippet = SNIPPET, constraint = CONSTRAINT } = {}) {
  const graph = createGraph({ sessionId: "fixture-k2-prune-ab", cwd: "/tmp" });
  const user = addUserNodeId(graph, { seq: 1, text: ROOT_TEXT, constraints: constraint === null ? [] : [constraint] });
  const edge = addEdge(graph, { from: user, intent: "运行夹具", action: "bash(node fixture.test.mjs)", evidence: { start: 3, end: 3 } });
  settleEdge(graph, edge, { to: user, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: snippet });
  return graph;
}

function makeEvents({ factsInTool = true, filler = 6000 } = {}) {
  const toolText = `${factsInTool ? `${SNIPPET}\n${CONSTRAINT}\n` : ""}${PRIVATE_TOOL_BODY}\n${"x".repeat(filler)}`;
  return [userMsg(ROOT_TEXT), asstMsg("检查夹具。"), toolResult(toolText)];
}

function withTempHome(fn) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "k2-prune-ab-fixture-"));
  try {
    return fn(home);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

function writeLog(home, sessionId, events) {
  const dir = nodePath.join(home, "sessions", "fixture-workspace", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  nodeFs.writeFileSync(nodePath.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(jsonl)));
}

function writeGraph(home, sessionId, graph) {
  const dir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(graph));
}

tests["K-2 工具结果确实节省，生产 facts 保住 failureSnippet 与 constraint"] = (t) => {
  const graph = makeGraph();
  t.includes(renderFacts(graph), SNIPPET, "夹具必须先证明生产 facts 含 snippet");
  t.includes(renderFacts(graph), CONSTRAINT, "夹具必须先证明生产 facts 含约束");
  const result = evaluatePruneAB(makeEvents(), graph);
  t.eq(result.toolResults, 1, "一条原始工具结果");
  t.ok(result.savedChars > 0, "清工具结果后字符数下降");
  t.ok(result.savedTokens > 0, "清工具结果后官方比例 token 下降");
  t.eq(result.baseline.failureRecall, 1, "baseline 从工具结果召回 snippet");
  t.eq(result.everyStep.failureRecall, 1, "every-step 从 facts 召回 snippet");
  t.eq(result.baseline.constraintRecall, 1, "baseline 从工具结果召回约束");
  t.eq(result.everyStep.constraintRecall, 1, "every-step 从 facts 召回约束");
  t.eq(result.decision, "CANDIDATE", "节省且无回归才是候选");
};

tests["K-2 baseline 缺 snippet/约束时，every-step 可由 facts 补齐"] = (t) => {
  const result = evaluatePruneAB(makeEvents({ factsInTool: false }), makeGraph());
  t.eq(result.baseline.failureRecall, 0, "原始工具结果没有 snippet ⇒ baseline 0");
  t.eq(result.everyStep.failureRecall, 1, "facts 补齐 snippet ⇒ every-step 1");
  t.eq(result.baseline.constraintRecall, 0, "原始工具结果没有约束 ⇒ baseline 0");
  t.eq(result.everyStep.constraintRecall, 1, "facts 补齐约束 ⇒ every-step 1");
  t.ok(result.savedTokens > 0, "仍有正节省");
  t.eq(result.decision, "CANDIDATE", "只允许不降，facts 补齐也满足");
};

tests["K-2 召回不降但 savedTokens 非正仍必须 REJECT"] = (t) => {
  const events = [userMsg(ROOT_TEXT), asstMsg("检查夹具。"), toolResult(`${SNIPPET}\n${CONSTRAINT}`)];
  const result = evaluatePruneAB(events, makeGraph());
  t.eq(result.everyStep.failureRecall, result.baseline.failureRecall, "失败召回不降");
  t.eq(result.everyStep.constraintRecall, result.baseline.constraintRecall, "约束召回不降");
  t.ok(result.savedTokens <= 0, "facts 成本超过短工具结果");
  t.eq(result.decision, "REJECT");
  t.includes(result.reasons.join("\n"), "savedTokens<=0");
};

tests["K-2 真红变异：删掉 facts 里的 snippet 必须 REJECT"] = (t) => {
  const graph = makeGraph();
  const mutilatedFacts = renderFacts(graph).replaceAll(SNIPPET, "[removed]");
  const result = evaluatePruneAB(makeEvents(), graph, { factsText: mutilatedFacts });
  t.eq(result.baseline.failureRecall, 1, "baseline 仍有原始工具结果");
  t.eq(result.everyStep.failureRecall, 0, "facts 变异后 snippet 丢失");
  t.eq(result.decision, "REJECT");
  t.includes(result.reasons.join("\n"), "failureRecall regression");
};

tests["K-2 真红变异：删掉 facts 里的约束必须 REJECT"] = (t) => {
  const graph = makeGraph();
  const mutilatedFacts = renderFacts(graph).replaceAll(CONSTRAINT, "[removed]");
  const result = evaluatePruneAB(makeEvents(), graph, { factsText: mutilatedFacts });
  t.eq(result.baseline.constraintRecall, 1, "baseline 仍有原始工具结果");
  t.eq(result.everyStep.constraintRecall, 0, "facts 变异后约束丢失");
  t.eq(result.decision, "REJECT");
  t.includes(result.reasons.join("\n"), "constraintRecall regression");
};

tests["K-2 空分母记 null；缺 snippet 失败边单列且不进分母"] = (t) => {
  const graph = makeGraph({ snippet: "", constraint: null });
  const result = evaluatePruneAB(makeEvents({ factsInTool: false }), graph);
  t.eq(result.failureEdges, 1, "仍是一条失败边");
  t.eq(result.failureSnippetEdges, 0, "空 snippet 不进分母");
  t.eq(result.missingSnippetEdges, 1, "空 snippet 单独计数");
  t.eq(result.baseline.failureRecall, null, "失败空分母不是 1");
  t.eq(result.everyStep.failureRecall, null, "失败空分母不是 1");
  t.eq(result.baseline.constraintRecall, null, "约束空分母不是 1");
  t.eq(result.everyStep.constraintRecall, null, "约束空分母不是 1");
  t.eq(result.decision, "REJECT", "缺分母不能冒充已证明无回归");
};

tests["K-2 CLI 无 home 返回 exit 2"] = (t) => {
  const errors = [];
  const code = main([], { home: "", stdout: () => {}, stderr: (line) => errors.push(line) });
  t.eq(code, 2);
  t.includes(errors.join("\n"), "缺 DSH_HOME");
};

tests["K-2 CLI 没图明确报 MISSING_GRAPH，不输出私有正文"] = (t) => {
  withTempHome((home) => {
    writeLog(home, "fixture-no-graph", makeEvents());
    const report = scanHome(home, { limit: 1 });
    t.eq(report.status, "NO_GRAPH");
    t.eq(report.summary.evaluatedSessions, 0, "没图不能假装已测");
    t.eq(report.summary.missingGraphSessions, 1);
    t.eq(report.summary.decision, null);
    t.eq(report.sessions[0].status, "MISSING_GRAPH");
    t.includes(report.sessions[0].message, "未找到对应 graph.json");
    t.notIncludes(JSON.stringify(report), PRIVATE_TOOL_BODY, "报告不含完整工具结果正文");
  });
  t.ok(true, "临时 home 已清理");
};

tests["K-2 CLI 扫描真实格式的压缩日志与图，输出每会话及汇总"] = (t) => {
  withTempHome((home) => {
    const sessionId = "fixture-with-graph";
    const graph = makeGraph();
    writeLog(home, sessionId, makeEvents());
    writeGraph(home, sessionId, graph);
    let json = "";
    const code = main(["--home", home, "--limit", "1", "--json"], { home: "", stdout: (line) => { json += line; }, stderr: () => {} });
    t.eq(code, 0);
    const report = JSON.parse(json);
    t.eq(report.status, "OK");
    t.eq(report.sessions.length, 1, "每会话一行");
    t.eq(report.sessions[0].decision, "CANDIDATE");
    t.eq(report.summary.evaluatedSessions, 1);
    t.eq(report.summary.decision, "CANDIDATE");
    t.ok(report.summary.savedTokens > 0, "汇总也有正节省");
    t.notIncludes(json, PRIVATE_TOOL_BODY, "JSON 不含完整私有正文");
  });
  t.ok(true, "临时 home 已清理");
};
