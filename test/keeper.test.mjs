import {
  createGraph,
  failureEdges,
  toJSON,
  fromJSON,
  validate,
  deltaFromDirty,
  applyDelta,
  encodeDeltaFrame,
  decodeDeltaFrames,
} from "../src/rooms/kifu-model.mjs";
import nodeFs from "node:fs";

import { observeEvent, actionSignature, taskPivotScore } from "../src/rooms/keeper.mjs";
import { isValueFact } from "../src/rooms/tool-value-facts.mjs";

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

/* ───── C446：动作指纹（循环判据的键）───── */

tests["C446 动作指纹：键序无关、参数一变就变、同一命令重复跑必相同"] = (t) => {
  const a = actionSignature("bash", { command: "ls -la", description: "看看" });
  const b = actionSignature("bash", { description: "看看", command: "ls -la" }); // 键序不同
  t.eq(a, b, "同样的参数换个键序必须同指纹（否则每次写图的顺序不同就会误判成不同动作）");
  const c = actionSignature("bash", { command: "ls -la src", description: "看看" });
  t.eq(a === c, false, "参数不同 ⇒ 指纹必须不同");
  t.eq(a === actionSignature("edit", { command: "ls -la", description: "看看" }), false, "工具名不同 ⇒ 指纹必须不同");
  // 真机那个误判形状：同一文件的两次不同编辑
  const e1 = actionSignature("edit", { file_path: "D:/a/b.md", old_string: "x", new_string: "y" });
  const e2 = actionSignature("edit", { file_path: "D:/a/b.md", old_string: "y", new_string: "z" });
  t.eq(e1 === e2, false, "同一文件的不同编辑必须区分（这是 C444 的误判来源）");
  // 落到边上
  const g = createGraph({ sessionId: "k8" });
  const st = freshState();
  observeEvent(g, ev("user/message", 1, userMsg("x")), st);
  observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "bash", { command: "npm test" }) }), st);
  const edge = Object.values(g.edges)[0];
  t.eq(typeof edge.sig, "string", "新边的 sig 必须落盘（否则循环判据永远只能看 action）");
  t.eq(edge.sig.length >= 8, true, "指纹不能是空串");
};

/* ───── C461：任务切换（与根目标几乎无词重叠）───── */

tests["C461 taskPivotScore：换任务是「低重叠 + 有实质内容」，短句与同题追问都不算"] = (t) => {
  const prior = { rootText: "修复 dsh-GOkifu-compact 的压缩成本估算", constraints: ["不许重启 DSH"] };
  t.eq(taskPivotScore("继续", prior).reason, "too-short", "「继续」不构成切换");
  t.eq(taskPivotScore("把散点图换成折线图并加注释", prior).pivot, true, "完全另一件事 ⇒ 判切换");
  t.eq(taskPivotScore("压缩成本估算里的峰谷价要按折叠时刻算", prior).pivot, false, "同题追问不算切换");
  // 有约束词出现 ⇒ 明显同题
  const withConstraint = taskPivotScore("这个改动不许重启 DSH，先写脚本", prior);
  t.eq(withConstraint.pivot, false, "提到原约束的肯定是同一件事");
  // 空输入不崩
  t.eq(taskPivotScore("", prior).pivot, false, "空文本");
  t.eq(taskPivotScore("hello world 这是一个新话题", { rootText: "" }).reason, "no-tokens", "没有先前目标可比 ⇒ 不判");
};

tests["C461 落账：换任务时在 user 节点上打 pivot 印记，并累加 g.pivots"] = (t) => {
  const g = createGraph({ sessionId: "c461" });
  const st = freshState();
  observeEvent(g, ev("user/message", 1, userMsg("修复压缩成本估算里的峰谷价")), st);
  t.eq(g.pivots === undefined || g.pivots === 0, true, "第一条（根目标）不可能是切换");
  observeEvent(g, ev("user/message", 3, userMsg("把散点图换成折线图并加注释")), st);
  t.eq(g.pivots, 1, "换任务要计数");
  const pivotNodes = Object.values(g.nodes).filter((n) => n.pivot === true);
  t.eq(pivotNodes.length, 1, "只标记换任务那一条");
  t.eq(pivotNodes[0].text.includes("折线图"), true, "标的是新任务那条");
};

/* ─────────────── AX-04：成功工具结果的短值落边（K-2 退化修复） ─────────────── */

/**
 * 真机 write 成功回执的**逐字形状**（AX-02 从会话里核过，不是造出来的）：
 *   `<path>…</path>\n<type>file</type>\n<content>\nCreated file\n</content>`
 */
const createdFileResult = (path) => `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`;

/** K-2 S2-Q3 的真实形状：GitHub 仓库 API 的 JSON（description 故意很长，测「只留短值」）。 */
const repoJson = () =>
  `{"id": 4242, "node_id": "R_demo4242", "name": "demo-repo", "full_name": "octo/demo-repo", "private": false, "default_branch": "main", "description": "${"长".repeat(3000)}"}`;

/** 跑一条 tool-call + 它的结果，返回图、状态与那条边。 */
function settleOne({ sessionId, tool, args, result, resultSeq = 5, isError = false }) {
  const g = createGraph({ sessionId });
  const st = freshState();
  observeEvent(g, ev("user/message", 1, userMsg("做点什么")), st);
  observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", tool, args) }), st);
  observeEvent(g, ev("tool/result", resultSeq, { message: toolResult("c1", result, isError) }), st);
  return { g, st, edge: Object.values(g.edges)[0] };
}

tests["AX-04 成功 write 结算 ⇒ valueFacts 落边（quote 逐字、evidenceSeq = 结果 seq、evidence.end 保留）"] = (t) => {
  const path = "D:/主工作区/repos/x/src/a.mjs";
  const result = createdFileResult(path);
  const { g, edge } = settleOne({ sessionId: "ax04-a", tool: "write", args: { file_path: path, content: "x".repeat(4000) }, result });
  t.eq(edge.result, "success", "write 回执是 success");
  t.eq(Array.isArray(edge.valueFacts), true, "成功结果必须有 valueFacts");
  t.eq(edge.valueFacts.every((fact) => isValueFact(fact)), true, "每条都必须满足 AX-02 的六字段契约");
  const created = edge.valueFacts.find((fact) => fact.kind === "file_created");
  t.eq(created?.value, path, "Created file 的路径必须留下（K-2 S1-Q1 的退化点）");
  t.eq(result.includes(created.quote), true, "quote 必须是结果原文的逐字连续子串");
  t.eq(created.evidenceSeq, 5, "证据指针 = tool/result 的事件 seq");
  t.eq(created.validAtSeq, 5, "生效时点缺省 = 证据时点");
  t.eq(edge.evidence.end, 5, "evidence.end 必须保留（结算后回填结果事件 seq）");
  t.eq(edge.valueFacts.every((fact) => fact.value !== result), true, "不许把整份结果当一个值（不回灌全文）");
  t.eq(validate(g), [], "加了 valueFacts 不许让图校验变红");
};

tests["AX-04 失败结果 ⇒ 不产 valueFacts（边上连键都不长）"] = (t) => {
  // ① 宿主 isError
  const host = settleOne({ sessionId: "ax04-b1", tool: "write", args: { file_path: "a.md" }, result: '{"id": 4242, "private": false}', isError: true });
  t.eq(host.edge.result, "failure", "isError ⇒ failure");
  t.eq("valueFacts" in host.edge, false, "失败边不许有 valueFacts 字段");

  // ② 行首错误行（write 类没有退出码，错误行才是判据）
  const err = settleOne({ sessionId: "ax04-b2", tool: "write", args: { file_path: "a.md" }, result: 'Error: EACCES: permission denied, open "a.md"' });
  t.eq(err.edge.result, "failure", "行首 Error: ⇒ failure");
  t.eq("valueFacts" in err.edge, false, "错误结果不许进成功值事实");

  // ③ 同一条边**重新结算**成失败时，陈旧的 valueFacts 必须被清掉（与 settleEdge 清 weak 的语义一致）
  const { g, st, edge } = settleOne({ sessionId: "ax04-b3", tool: "github", args: { path: "repos/o/r" }, result: '{"id": 4242, "private": false}' });
  t.eq(edge.valueFacts.length > 0, true, "先得有一条事实");
  st.pendingEdges.set("c1", edge.id); // 模拟同一条边被再次结算
  observeEvent(g, ev("tool/result", 6, { message: toolResult("c1", "boom", true) }), st);
  t.eq(edge.result, "failure", "重新结算成 failure");
  t.eq("valueFacts" in edge, false, "重新结算成「没有值」时不许留陈旧事实");
};

tests["AX-04 unverified 且无 weak ⇒ 不产 valueFacts（不许拿 unverified 蒙混）"] = (t) => {
  const { edge } = settleOne({ sessionId: "ax04-c", tool: "custom_tool", args: { path: "x" }, result: '{"id": 7, "private": true}' });
  t.eq(edge.result, "unverified", "非 github 的 other 类工具只有 unverified");
  t.eq(edge.weak, undefined, "而且没有 weak —— 这正是必须拒绝的形状");
  t.eq("valueFacts" in edge, false, "unverified 且无 weak ⇒ 一条事实都不许产");
};

tests["AX-04 github 读形（GET / 缺省 method）⇒ 抽 id/private，但边的 result 仍是 unverified（不得升格 success）"] = (t) => {
  const result = repoJson();
  const shapes = [
    ["缺省 method（工具默认 GET）", { path: "repos/octo/demo-repo" }],
    ["显式 GET", { path: "repos/octo/demo-repo", method: "GET" }],
    ["HEAD", { path: "repos/octo/demo-repo", method: "HEAD" }],
  ];
  for (let i = 0; i < shapes.length; i += 1) {
    const [label, args] = shapes[i];
    const { g, edge } = settleOne({ sessionId: `ax04-d${i}`, tool: "github", args, result });
    t.eq(edge.result, "unverified", `${label}：github 读结果的 result 必须仍是 unverified`);
    t.eq(edge.weak, undefined, `${label}：边上的 weak 只能由 classify 给，keeper 不许自己打`);
    t.eq(Array.isArray(edge.valueFacts) && edge.valueFacts.length > 0, true, `${label}：K-2 S2-Q3 的 id/private 必须留下`);
    const idFact = edge.valueFacts.find((fact) => fact.kind === "id" && fact.value === 4242);
    t.eq(idFact !== undefined, true, `${label}：id 4242 必须留下`);
    t.eq(result.includes(idFact.quote), true, `${label}：quote 逐字可回证`);
    const priv = edge.valueFacts.find((fact) => fact.kind === "boolean" && fact.value === false);
    t.eq(priv !== undefined, true, `${label}：private=false 必须留下（false 不是「没有」）`);
    t.eq(edge.valueFacts.some((fact) => fact.value === "长".repeat(200)), false, `${label}：长 description 不许变成事实（只留短值）`);
    t.eq(JSON.stringify(edge.valueFacts).length < result.length / 4, true, `${label}：只留短值，不回灌全文`);
    t.eq(validate(g), [], `${label}：valueFacts 不许违反 S2a 的「weak 必须挂 unverified」不变式`);
  }
};

tests["AX-04 github 写形 ⇒ 一条事实都不产；同一结果文本下读形与写形必须不同"] = (t) => {
  const result = '{"id": 4242, "private": false}';
  const writeShapes = [
    ["POST", { path: "repos/o/r", method: "POST", body: { name: "x" }, confirm: true }],
    ["PATCH", { path: "repos/o/r", method: "PATCH", body: { private: true }, confirm: true }],
    ["PUT", { path: "repos/o/r", method: "PUT", body: { a: 1 }, confirm: true }],
    ["DELETE", { path: "repos/o/r", method: "DELETE", confirm: true }],
    ["缺省 method 但带 body", { path: "repos/o/r", body: { name: "x" } }],
    ["缺省 method 但 confirm:true", { path: "repos/o/r", confirm: true }],
  ];
  for (let i = 0; i < writeShapes.length; i += 1) {
    const [label, args] = writeShapes[i];
    const { edge } = settleOne({ sessionId: `ax04-e${i}`, tool: "github", args, result });
    t.eq(edge.result, "unverified", `${label}：写调用本来就没有外部验证信号`);
    t.eq("valueFacts" in edge, false, `${label}：写调用不许被当成弱成功（任务书明令）`);
  }

  // 同一段结果文本：读形抽得出、写形抽不出 ⇒ 判据真的在**实参**上，不是「工具名一刀切」
  const read = settleOne({ sessionId: "ax04-e-read", tool: "github", args: { path: "repos/o/r" }, result });
  const write = settleOne({ sessionId: "ax04-e-write", tool: "github", args: { path: "repos/o/r", method: "POST", confirm: true }, result });
  t.eq(read.edge.valueFacts.length > 0, true, "读形必须抽出事实");
  t.eq("valueFacts" in write.edge, false, "写形必须一条都没有");

  // MCP 的 github 工具：方法在**名字**里，实参没有 method ⇒ 不许按「缺省 GET」当成读形
  const mcp = settleOne({
    sessionId: "ax04-e-mcp",
    tool: "mcp__github__create_pull_request",
    args: { owner: "o", repo: "r", title: "t" },
    result: '{"id": 4242, "private": false}',
  });
  t.eq("valueFacts" in mcp.edge, false, "mcp__github__create_pull_request 是写调用，不许一刀切标弱成功");
};

tests["AX-04 反例：参数是数组 / 结果是顶层数组 ⇒ 不得当返回值"] = (t) => {
  // ① 工具把入参数组回显成结果（todo_write 的真实形状）
  const echoed = settleOne({ sessionId: "ax04-f1", tool: "todo_write", args: { todos: [{ content: "写测试", status: "pending" }] }, result: '[{"content":"写测试","status":"pending"}]' });
  t.eq(echoed.edge.result, "unverified", "local-mutate 没有外部验证信号");
  t.eq("valueFacts" in echoed.edge, false, "数组实参不得当返回值");

  // ② 只读工具读到 JSON 数组：weak 闸放行，但顶层数组照样不抽
  const arr = settleOne({ sessionId: "ax04-f2", tool: "read", args: { file_path: "todos.json" }, result: '[{"id": 1, "private": false}]' });
  t.eq(arr.edge.result, "unverified", "read 是弱成功（result 仍是 unverified）");
  t.eq(arr.edge.weak, "read", "read 的 weak 由 classify 给");
  t.eq("valueFacts" in arr.edge, false, "顶层数组不当返回值（哪怕走了 weak 闸）");
};

tests["AX-04 同结果重复结算 ⇒ 不重复追加 valueFacts"] = (t) => {
  const g = createGraph({ sessionId: "ax04-g" });
  const st = freshState();
  const result = createdFileResult("D:/a/b.md");
  observeEvent(g, ev("user/message", 1, userMsg("写")), st);
  observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "write", { file_path: "D:/a/b.md" }) }), st);
  observeEvent(g, ev("tool/result", 3, { message: toolResult("c1", result) }), st);
  const edge = Object.values(g.edges)[0];
  const first = JSON.stringify(edge.valueFacts);
  const again = observeEvent(g, ev("tool/result", 4, { message: toolResult("c1", result) }), st);
  t.eq(again.changed, false, "重复结果不该再改图");
  t.eq(JSON.stringify(edge.valueFacts), first, "valueFacts 不许重复追加");
  t.eq(edge.valueFacts.length, JSON.parse(first).length, "条数不变");

  // 早退分支之外的**幂等**也要钉住：同一条边被再次结算成同样的成功时，
  // valueFacts 是「覆盖」而不是「追加」（否则重放一次就翻倍）。
  // ⚠ 只有证据指针跟着新事件走（evidenceSeq/validAtSeq = 新的 tool/result seq），值本身必须一样。
  st.pendingEdges.set("c1", edge.id);
  observeEvent(g, ev("tool/result", 5, { message: toolResult("c1", result) }), st);
  const shape = (facts) => JSON.stringify(facts.map((fact) => [fact.kind, fact.value, fact.quote]));
  t.eq(edge.valueFacts.length, JSON.parse(first).length, "同值重结算不许翻倍");
  t.eq(shape(edge.valueFacts), shape(JSON.parse(first)), "同值重结算：值 / quote 逐字不变（只换证据指针）");
  t.eq(edge.valueFacts.every((fact) => fact.evidenceSeq === 5), true, "证据指针跟随这一次的结果事件");
};

tests["AX-04 旧图（无 valueFacts 字段）行为逐字不变：不新增键、delta 帧里也没有该字段"] = (t) => {
  const g = createGraph({ sessionId: "ax04-h" });
  const st = freshState();
  observeEvent(g, ev("user/message", 1, userMsg("跑测试")), st);
  observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "bash", { command: "npm test" }) }), st);
  observeEvent(g, ev("tool/result", 3, { message: toolResult("c1", "boom\n[exit code: 1]") }), st);
  const json = toJSON(g);
  t.eq(json.includes("valueFacts"), false, "没有事实的图，JSON 里不许出现这个键");

  // 同一份 JSON 当作「加字段之前落盘的旧图」载入，继续跑两条结算
  const loaded = fromJSON(json);
  const st2 = freshState();
  observeEvent(loaded, ev("assistant/message", 4, { message: assistantWithCall("c2", "bash", { command: "x" }) }), st2);
  const frame = deltaFromDirty(loaded);
  t.eq(JSON.stringify(frame).includes("valueFacts"), false, "delta 帧里不许凭空多出字段");
  observeEvent(loaded, ev("tool/result", 5, { message: toolResult("c2", "nope\n[exit code: 2]") }), st2);
  t.eq(toJSON(loaded).includes("valueFacts"), false, "失败结算仍然不长键");
  t.eq(validate(loaded), [], "旧图载入 + 结算后校验仍绿");
};

tests["AX-04 图序列化 / delta 回放后 valueFacts 逐字一致"] = (t) => {
  const g = createGraph({ sessionId: "ax04-i" });
  const st = freshState();
  observeEvent(g, ev("user/message", 1, userMsg("查一下仓库")), st);
  observeEvent(g, ev("assistant/message", 2, { message: assistantWithCall("c1", "github", { path: "repos/octo/demo-repo" }) }), st);
  const baseJson = toJSON(g); // 结算之前的基线（delta 写在它上面）
  const baseHash = "0123456789abcdef";
  observeEvent(g, ev("tool/result", 7, { message: toolResult("c1", '{"id": 4242, "node_id": "R_1", "private": false, "default_branch": "main"}') }), st);
  const live = Object.values(g.edges)[0].valueFacts;
  t.eq(live.length >= 3, true, "先要有多条事实可回放");

  // ① graph.json 往返
  const round = fromJSON(toJSON(g));
  t.eq(JSON.stringify(Object.values(round.edges)[0].valueFacts), JSON.stringify(live), "graph.json 往返后必须逐字一致");

  // ② delta 帧应用
  const frame = deltaFromDirty(g);
  const replayed = applyDelta(fromJSON(baseJson), JSON.parse(JSON.stringify(frame)));
  t.eq(JSON.stringify(Object.values(replayed.edges)[0].valueFacts), JSON.stringify(live), "delta 帧应用后必须逐字一致");

  // ③ 编码 / 解码（真正落盘的那一行）
  const { frames, badTail } = decodeDeltaFrames(encodeDeltaFrame(baseHash, frame), baseHash);
  t.eq(badTail, false, "干净帧不该被判成坏尾");
  t.eq(frames.length, 1, "一帧");
  const replayed2 = applyDelta(fromJSON(baseJson), JSON.parse(JSON.stringify(frames[0])));
  const replayedFacts = Object.values(replayed2.edges)[0].valueFacts;
  t.eq(JSON.stringify(replayedFacts), JSON.stringify(live), "编码/解码后必须逐字一致");

  // ④ 逐字段比对（不只是 JSON 字符串相等）
  t.eq(replayedFacts.length, live.length, "条数");
  for (let i = 0; i < live.length; i += 1) {
    t.eq(Object.keys(replayedFacts[i]).sort().join(","), Object.keys(live[i]).sort().join(","), `第 ${i} 条字段集合`);
    t.eq(replayedFacts[i].kind, live[i].kind, `第 ${i} 条 kind`);
    t.eq(replayedFacts[i].value, live[i].value, `第 ${i} 条 value`);
    t.eq(replayedFacts[i].quote, live[i].quote, `第 ${i} 条 quote`);
    t.eq(replayedFacts[i].evidenceSeq, live[i].evidenceSeq, `第 ${i} 条 evidenceSeq`);
    t.eq(replayedFacts[i].validAtSeq, live[i].validAtSeq, `第 ${i} 条 validAtSeq`);
    t.eq(replayedFacts[i].source, live[i].source, `第 ${i} 条 source`);
  }
};

/* ═════════════ AX-21：「结果算不算可信」的判据只在 AX-02 房间（本房间不再自带一份） ═════════════ */

tests["AX-21 判据集中一处：keeper import 共享的 resultKindForValueFacts，不再自带 githubReadShaped"] = (t) => {
  const src = nodeFs.readFileSync(new URL("../src/rooms/keeper.mjs", import.meta.url), "utf8");
  t.includes(src, 'import { extractValueFacts, resultKindForValueFacts } from "./tool-value-facts.mjs";', "必须 import 共享判据（AX-21 起唯一来源）");
  t.includes(src, "resultKindForValueFacts(verdict", "必须真的调用它（import 了不用 = 还是自己判）");
  t.notIncludes(src, "function githubReadShaped", "不许再留一份私有实现（两份实现迟早只修好一份）");
  t.notIncludes(src, "function resultKindForValueFacts", "同上");
  t.notIncludes(src, "GITHUB_REST_TOOLS", "判据表也只许有一份（在 tool-value-facts.mjs）");
};

tests["AX-21 K2-N4 形状：仓库 JSON 的 node_id 必须是一条 id 事实（否则「node_id 是什么」永远答不出）"] = (t) => {
  const result = repoJson();
  const { edge } = settleOne({ sessionId: "ax21-n4", tool: "github", args: { path: "repos/octo/demo-repo", method: "GET" }, result });
  const nodeId = edge.valueFacts?.find((fact) => fact.kind === "id" && fact.value === "R_demo4242");
  t.eq(nodeId !== undefined, true, "node_id 必须留下（`*_id` 也是 id 键形）");
  t.eq(result.includes(nodeId.quote), true, "quote 必须是结果原文的逐字连续子串");
  t.eq(nodeId.evidenceSeq, 5, "证据指针仍是结果事件的 seq");
  t.eq(edge.result, "unverified", "github 读结果的边仍是 unverified（弱成功不升格）");
};
