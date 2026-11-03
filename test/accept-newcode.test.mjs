/**
 * accept-newcode.test.mjs —— 「C446/C448/C449 这几轮改动生效了没」的离线探针（C450）
 *
 * 为什么值得钉：这些改动**不改面板能力**，能力探针看不见；而 buildId 又会骗人（C293/C294）。
 * 唯一可靠的证据是磁盘上的图：`sig` 只有新代码才写，`CURRENT GOAL` 只依赖图数据。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { newCodeProbe } from "../scripts/accept-after-restart.mjs";
import { createGraph, addUserNodeId, addEdge, addAgentNode, settleEdge } from "./graph-fixtures.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const TMP = nodePath.join(HERE, ".tmp-newcode");

function writeSession(root, name, g) {
  const dir = nodePath.join(root, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
}

/** 造一个「多轮 user + agent 节点」的会话（CURRENT GOAL 兜底要它才渲染）。 */
function graph({ withSig = false, extraUser = "改成先跑 lint 再跑测试。" } = {}) {
  const g = createGraph({ sessionId: "probe" });
  const u = addUserNodeId(g, { seq: 1, text: "把 data.jsonl 算出来。" });
  const e1 = addEdge(g, { from: u, action: "bash(node calc.mjs)", ...(withSig ? { sig: "abc123" } : {}) });
  const n2 = addAgentNode(g, { seq: 5, goal: "", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  g.edges[e1].to = n2;
  settleEdge(g, e1, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  if (extraUser !== null) addUserNodeId(g, { seq: 9, text: extraUser });
  return g;
}

tests["C450 newCodeProbe：sig 覆盖率能区分「新代码写的边」与「老棋谱」"] = (t) => {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  writeSession(TMP, "session-old", graph({ withSig: false }));
  writeSession(TMP, "session-new", graph({ withSig: true }));
  const r = newCodeProbe(TMP);
  t.eq(r.sessions, 2, "两个会话都要数到");
  t.eq(r.edges, 2, "两条边");
  t.eq(r.sigEdges, 1, "只有带 sig 的那条算（这正是新旧代码的判别式）");
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};

tests["C450 newCodeProbe：没 home / 空目录不许炸（验收脚本要能在任何机器上跑）"] = (t) => {
  const r = newCodeProbe(nodePath.join(TMP, "__nope__"));
  t.eq(r.sessions, 0, "目录不存在 ⇒ 0 会话");
  t.eq(r.edges, 0, "0 条边");
  t.eq(r.goal, null, "没有会话就没有目标");
  t.eq(r.goalReason, "no-session", "理由要可读");
};

tests["C450 newCodeProbe：目标行会给出「渲染什么」或「为什么不渲染」"] = (t) => {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  // ① 有信息量的最新指令 ⇒ 渲染 latest-user
  writeSession(TMP, "session-a", graph({ extraUser: "改成先跑 lint 再跑测试。" }));
  const a = newCodeProbe(TMP);
  t.eq(a.goal?.source, "latest-user", "应回落到最近 user 原话");
  t.includes(a.goal?.text ?? "", "先跑 lint", "内容要带出来");
  // ② 最新只是「继续」⇒ 不渲染，且理由必须说明是过滤掉的（不是"没数据"）
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  writeSession(TMP, "session-b", graph({ extraUser: "继续" }));
  const b = newCodeProbe(TMP);
  t.eq(b.goal, null, "接续词不渲染");
  t.includes(b.goalReason, "接续词", "理由要说清是过滤，而不是没原料");
  // ③ 单轮会话 ⇒ 与 ROOT 重复，也不渲染
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  writeSession(TMP, "session-c", graph({ extraUser: null }));
  const c = newCodeProbe(TMP);
  t.eq(c.goal, null, "单轮不渲染");
  t.includes(c.goalReason, "单轮", "理由要说清单轮");
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};
