import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, failureEdges, currentPath } from "../src/graph.mjs";
import { renderLedger, renderFacts, estimateTokens, renderFailureLine, collectConstraints } from "../src/ledger.mjs";

export const tests = {};

function buildGraph({ failures = 0, constraints = [], extraUser = null } = {}) {
  const g = createGraph({ sessionId: "ledger", cwd: "/tmp" });
  const u = addUserNode(g, { seq: 1, text: `把 data.jsonl 算出来。${constraints.join(" ")}` });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u.id, intent: `第 ${i + 1} 次：换个解析方式`, action: `bash(npm test ${i})`, evidence: { start: 10 + i * 4, end: 13 + i * 4 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `SyntaxError: bad json at line ${i}` });
  }
  if (extraUser) addUserNode(g, { seq: 99, text: extraUser });
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
  const { extractConstraintsBlock } = await import("../src/summary-prompt.mjs");
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
  const { extractConstraintsBlock } = await import("../src/summary-prompt.mjs");
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
