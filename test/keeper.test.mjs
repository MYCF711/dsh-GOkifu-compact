import { createGraph, failureEdges } from "../src/rooms/kifu-model.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";

function freshState() {
  return {
    pendingEdges: new Map(),
    lastNodeId: null,
    lastUserNodeId: null,
    constraintDirty: true,
    touched: [],
    stepEdges: [],
  };
}

const ev = (type, seq, data) => ({ type, seq, data, time: Date.now() });

const userMsg = (text) => ({ id: `m-${Math.random()}`, role: "user", content: [{ type: "text", text }], source: { kind: "prompt" } });

function assistantWithCall(callId, name, args, text = "接下来我要试试这个办法。") {
  return {
    id: "a1",
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool-call", id: callId, name, arguments: JSON.stringify(args) },
    ],
    source: { kind: "model", provider: "p", model: "m" },
  };
}

function toolResult(callId, text, isError = false) {
  return {
    id: `r-${callId}`,
    role: "tool",
    toolCallId: callId,
    source: { kind: "tool", callId },
    content: [{ type: "text", text }],
    isError,
  };
}

export const tests = {
  "user/message ⇒ 新建 UserNode，且不把 checkpoint 当用户消息"() {
    const g = createGraph({ sessionId: "k1" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("必须保持接口不变。先修测试")), st);
    const users = g.order.map((id) => g.nodes[id]).filter((n) => n.kind === "user");
    if (users.length !== 1) throw new Error(`user 节点数 ${users.length}`);
    if (!users[0].constraints.some((c) => c.includes("必须保持接口不变"))) throw new Error("约束没抽出来");

    const cp = userMsg("上一份 checkpoint");
    cp.source = { kind: "compact-checkpoint" };
    observeEvent(g, ev("user/message", 2, cp), st);
    const users2 = g.order.map((id) => g.nodes[id]).filter((n) => n.kind === "user");
    if (users2.length !== 1) throw new Error("checkpoint 被当成用户消息了");
  },

  "tool-call ⇒ 开边；tool/result 非 0 exit ⇒ 结算为 failure 且原因入图"() {
    const g = createGraph({ sessionId: "k2" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("修好测试")), st);
    observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "bash", { command: "npm test" }) }), st);
    if (Object.keys(g.edges).length !== 1) throw new Error(`边数 ${Object.keys(g.edges).length}`);
    observeEvent(g, ev("tool/result", 3, { message: toolResult("c1", "AssertionError: expected 1 got 2\n[exit code: 1]") }), st);
    const f = failureEdges(g);
    if (f.length !== 1) throw new Error(`失败边数 ${f.length}`);
    if (!f[0].errorSnippet.includes("AssertionError")) throw new Error(`原因丢失：${f[0].errorSnippet}`);
    if (f[0].verify.kind !== "exit") throw new Error("verify 不对");
  },

  "step/end ⇒ 建一个状态节点，本步的边都指向它"() {
    const g = createGraph({ sessionId: "k3" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("修好测试")), st);
    observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "bash", { command: "npm test" }) }), st);
    observeEvent(g, ev("tool/result", 3, { message: toolResult("c1", "ok\n[exit code: 0]") }), st);
    observeEvent(g, ev("step/end", 4, { turn: 1, step: 1 }), st);
    const agents = g.order.map((id) => g.nodes[id]).filter((n) => n.kind === "agent");
    if (agents.length !== 1) throw new Error(`agent 节点数 ${agents.length}`);
    const edge = Object.values(g.edges)[0];
    if (edge.to !== agents[0].id) throw new Error(`边没指向节点：${edge.to}`);
    if (st.lastNodeId !== agents[0].id) throw new Error("state.lastNodeId 没更新");
  },

  "step 结束时未结算的边标 unverified（不是 success）"() {
    const g = createGraph({ sessionId: "k4" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("x")), st);
    observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c2", "read", { file_path: "a.txt" }) }), st);
    observeEvent(g, ev("step/end", 3, { turn: 1, step: 1 }), st);
    const edge = Object.values(g.edges)[0];
    if (edge.result !== "unverified") throw new Error(`应为 unverified，得到 ${edge.result}`);
  },

  "两个 step 生成两个节点，形成链（via 指向上一节点）"() {
    const g = createGraph({ sessionId: "k5" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("x")), st);
    for (const step of [1, 2]) {
      const base = step * 10;
      observeEvent(g, ev("assistant/message", base, { message: assistantWithCall(`c${step}`, "bash", { command: `run${step}` }) }), st);
      observeEvent(g, ev("tool/result", base + 1, { message: toolResult(`c${step}`, "done\n[exit code: 0]") }), st);
      observeEvent(g, ev("step/end", base + 2, { turn: 1, step }), st);
    }
    const agents = g.order.map((id) => g.nodes[id]).filter((n) => n.kind === "agent");
    if (agents.length !== 2) throw new Error(`节点数 ${agents.length}`);
    const second = agents[1];
    const viaEdge = g.edges[second.via];
    if (!viaEdge) throw new Error("第二个节点没有入边");
    if (viaEdge.from !== agents[0].id) throw new Error(`链没接上：${viaEdge.from} vs ${agents[0].id}`);
  },

  "写类工具会记录触碰路径（供世界状态哈希）"() {
    const g = createGraph({ sessionId: "k6" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("x")), st);
    observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "edit", { file_path: "/tmp/x.mjs", old_string: "a", new_string: "b" }) }), st);
    if (!st.touched.some((p) => p.includes("x.mjs"))) throw new Error(`未记录触碰：${JSON.stringify(st.touched)}`);
  },

  "keeps 一条边只结算一次（重复 tool/result 不重复计数）"() {
    const g = createGraph({ sessionId: "k7" });
    const st = freshState();
    observeEvent(g, ev("user/message", 1, userMsg("x")), st);
    observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "bash", { command: "x" }) }), st);
    observeEvent(g, ev("tool/result", 3, { message: toolResult("c1", "err\n[exit code: 1]") }), st);
    const before = failureEdges(g).length;
    const again = observeEvent(g, ev("tool/result", 4, { message: toolResult("c1", "err\n[exit code: 1]") }), st);
    if (again.changed) throw new Error("重复结果不该再改图");
    if (failureEdges(g).length !== before) throw new Error("失败边数变了");
  },
};
