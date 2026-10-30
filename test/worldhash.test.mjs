/**
 * worldHash 类型契约回归测试（P0，2026-10-28 实机故障）
 *
 * 事故现场：session-5acafe42 的 graph.json 里 206/267 个 agent 节点的 worldHash
 * 是 { hash, mode, files } 对象（worldstate.hash() 的返回值被直接写入）。
 * ledger.renderLedger() 里 `latest?.worldHash?.slice(0, 12)` 对对象抛
 *   "latest?.worldHash?.slice is not a function"
 * ⇒ 压缩链路 226 次里只有 3 次成功，上下文一路涨到 66 万 token，模型思考退化死循环。
 *
 * 本测试锁三件事：
 *   1. addAgentNode 收到对象也没关系 —— 落库前收敛成字符串
 *   2. fromJSON 读历史脏数据时自动修复（不用手工迁移 200+ 会话）
 *   3. renderLedger 对脏数据不抛错（防御性 = 双保险）
 */

import { createGraph, addUserNodeId, addAgentNode, addEdge, fromJSON, toJSON, hashText } from "./graph-fixtures.mjs";
import { renderFacts } from "../src/rooms/ledger.mjs";

export const tests = {
  "hashText：字符串原样、对象取 .hash、空值 pending"() {
    if (hashText("abc") !== "abc") throw new Error("字符串被改写");
    const obj = { hash: "deadbeef", mode: "stat", files: 21 };
    if (hashText(obj) !== "deadbeef") throw new Error(`对象未取 .hash：${hashText(obj)}`);
    if (hashText(null) !== "pending") throw new Error("null 应为 pending");
    if (hashText(undefined) !== "pending") throw new Error("undefined 应为 pending");
  },

  "addAgentNode：worldHash 传对象时落库为字符串"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNodeId(g, { seq: 1, text: "目标：修好测试" });
    const e = addEdge(g, { from: u, intent: "试 A", action: "bash(test)" });
    const node = addAgentNode(g, {
      seq: 5,
      goal: "A 完成",
      worldHash: { hash: "aaa111", mode: "stat", files: 3 },
      constraintHash: { hash: "ccc333", mode: "set", files: 1 },
      via: e,
    });
    const n = g.nodes[node.id];
    if (typeof n.worldHash !== "string" || n.worldHash !== "aaa111") {
      throw new Error(`worldHash 未收敛：${JSON.stringify(n.worldHash)} (${typeof n.worldHash})`);
    }
    if (typeof n.constraintHash !== "string" || n.constraintHash !== "ccc333") {
      throw new Error(`constraintHash 未收敛：${JSON.stringify(n.constraintHash)} (${typeof n.constraintHash})`);
    }
    // stateIndex 必须建立（修复前对象 key 会变成 "[object Object]/..." 或根本不写）
    const key = "aaa111/ccc333";
    if (g.stateIndex[key] !== node.id) throw new Error(`stateIndex 未建立：${JSON.stringify(g.stateIndex)}`);
  },

  "fromJSON：历史脏数据（对象 worldHash）自动修复并重建 stateIndex"() {
    const dirty = {
      version: 1,
      sessionId: "legacy",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 1,
      nextNode: 3,
      nextEdge: 2,
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "目标" },
        n2: {
          id: "n2",
          kind: "agent",
          seq: 2,
          goal: "第一步",
          worldHash: { hash: "bbb222", mode: "stat", files: 21 },
          constraintHash: "ddd444",
          via: null,
          ts: 1,
        },
      },
      edges: {},
      order: ["n1", "n2"],
      stateIndex: { "[object Object]/ddd444": "n2" },
      rootUserNodeIds: ["n1"],
      checkpointSeq: null,
      foldCount: 0,
      lastFoldTotalTokens: 0,
      foldMarks: [],
    };
    const g = fromJSON(JSON.stringify(dirty));
    if (typeof g.nodes.n2.worldHash !== "string" || g.nodes.n2.worldHash !== "bbb222") {
      throw new Error(`fromJSON 未修复：${JSON.stringify(g.nodes.n2.worldHash)}`);
    }
    if (g.stateIndex["[object Object]/ddd444"] !== undefined) throw new Error("脏 stateIndex 未被清理");
    if (g.stateIndex["bbb222/ddd444"] !== "n2") throw new Error(`stateIndex 未重建：${JSON.stringify(g.stateIndex)}`);
    // 再序列化一次必须是干净的字符串（保证下次 flush 后磁盘数据痊愈）
    const round = JSON.parse(toJSON(g));
    if (typeof round.nodes.n2.worldHash !== "string") throw new Error("重新落盘后仍是对象");
  },

  "renderFacts：worldHash 是对象时不抛错（防御层）"() {
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNodeId(g, { seq: 1, text: "目标：修好测试" });
    const e = addEdge(g, { from: u, intent: "试 A", action: "bash(test)" });
    const node = addAgentNode(g, { seq: 5, goal: "A 完成", worldHash: "aaa111", constraintHash: "ccc333", via: e });
    // 绕过 addAgentNode 直接注入脏对象，模拟旧数据未经 fromJSON 的情况
    g.nodes[node.id].worldHash = { hash: "aaa111bbb222ccc333", mode: "stat", files: 3 };
    g.nodes[node.id].constraintHash = { hash: "ccc333ddd444", mode: "set", files: 1 };
    const out = renderFacts(g);
    if (!out.includes("CURRENT_STATE_KEY: aaa111bbb222/ccc333ddd444")) {
      throw new Error(`CURRENT_STATE_KEY 渲染错误：\n${out}`);
    }
  },

  "fromJSON：历史 pending constraintHash 回填并重建 stateIndex"() {
    const dirty = {
      version: 1, sessionId: "legacy2", cwd: "/tmp", createdAt: 1, updatedAt: 1,
      nextNode: 5, nextEdge: 1,
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "必须保留登录框", constraints: ["必须保留登录框"] },
        n2: { id: "n2", kind: "agent", seq: 2, goal: "A", worldHash: "W1", constraintHash: "pending", via: null, ts: 1 },
        n3: { id: "n3", kind: "agent", seq: 3, goal: "B", worldHash: "W1", constraintHash: "pending", via: null, ts: 1 },
        n4: { id: "n4", kind: "agent", seq: 4, goal: "C", worldHash: "W2", constraintHash: "pending", via: null, ts: 1 },
      },
      edges: {}, order: ["n1", "n2", "n3", "n4"],
      stateIndex: {},
      rootUserNodeIds: ["n1"], checkpointSeq: null, foldCount: 0, lastFoldTotalTokens: 0, foldMarks: [],
    };
    const g = fromJSON(JSON.stringify(dirty));
    for (const id of ["n2", "n3", "n4"]) {
      if (g.nodes[id].constraintHash === "pending") throw new Error(id + " 的 constraintHash 未回填");
    }
    const keys = Object.keys(g.stateIndex);
    if (keys.length !== 2) throw new Error("stateIndex 应为 2 条，实际 " + keys.length + ": " + JSON.stringify(keys));
    if (g.stateIndex["W1/" + g.nodes.n2.constraintHash] !== "n2") throw new Error("W1 未保留最早节点 n2");
  },

  "fromJSON：字段本身干净但 stateIndex 脏/空时也重建（派生数据，不信任磁盘上的旧索引）"() {
    const dirty = {
      version: 1, sessionId: "legacy3", cwd: "/tmp", createdAt: 1, updatedAt: 1,
      nextNode: 3, nextEdge: 1,
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "目标" },
        n2: { id: "n2", kind: "agent", seq: 2, goal: "A", worldHash: "W1", constraintHash: "C1", via: null, ts: 1 },
      },
      edges: {}, order: ["n1", "n2"],
      // 旧实机现场：字段是字符串（或 pending 被 fold 回填过），但索引里全是脏 key
      stateIndex: { "[object Object]/pending": "n2" },
      rootUserNodeIds: ["n1"], checkpointSeq: null, foldCount: 0, lastFoldTotalTokens: 0, foldMarks: [],
    };
    const g = fromJSON(JSON.stringify(dirty));
    if (g.stateIndex["[object Object]/pending"] !== undefined) throw new Error("脏 key 未被清理");
    if (g.stateIndex["W1/C1"] !== "n2") throw new Error(`干净字段也未重建索引：${JSON.stringify(g.stateIndex)}`);
  },
};
