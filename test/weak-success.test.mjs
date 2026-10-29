/**
 * weak-success.test.mjs —— S2a「只读弱成功」的验收夹具（2026-10-30）
 *
 * 规格：docs/方案-持续优化.md §15.3；根 计划表.md §S2a。
 *
 * 铁律（任何一条破了 = 这个切片失败）：
 *   1. 弱成功**只**进 WORKING 路径，并且必须带 `[weak k/n]` 标记 + 图例；
 *   2. `result` 仍是 `unverified`：success 计数 / failureEdges / openEdges / facts / tewari 一个字不动；
 *   3. 弱边**不得**进入 tewari 的 alts、不得让 failureClass 判 dead（实测把 read 当 success：dead +8 / redundant +9）；
 *   4. 旧图（没有 weak 字段）仍能读、仍能渲染；只读弱锚点由 settle 时已写的 `verify.kind === "read"` 识别。
 *
 * 夹具用**真实链路**：keeper.observeEvent（classify → settleEdge → step/end 建节点）→ renderLedger，
 * 不手写 result/weak 字段（手写的只出现在「旧图兼容」与「tewari 反例」两处，且写明了原因）。
 */

import {
  createGraph,
  addUserNode,
  addEdge,
  addAgentNode,
  settleEdge,
  failureEdges,
  openEdges,
  tewariAnalysis,
  failureClass,
  validate,
  toJSON,
  fromJSON,
} from "../src/graph.mjs";
import { classify, weakKindOf } from "../src/verifier.mjs";
import { observeEvent } from "../src/keeper.mjs";
import { renderLedger, renderFacts } from "../src/ledger.mjs";

export const tests = {};

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** 一个会话 + 递增 seq 的时钟。 */
function session() {
  const g = createGraph({ sessionId: "weak-fixture", cwd: "/tmp/weak" });
  const st = {
    pendingEdges: new Map(),
    lastNodeId: null,
    lastUserNodeId: null,
    constraintDirty: true,
    touched: [],
    stepEdges: [],
    injected: 0,
  };
  let seq = 0;
  return { g, st, next: () => (seq += 1) };
}

function userMessage(s, text) {
  // 真实事件形状（2026-10-30 用当前会话日志核实）：user/message 的 data **就是** message 本体；
  // 只有 assistant/message 与 tool/result 是 data.message。写错了就一个 user 节点都建不出来。
  observeEvent(
    s.g,
    { type: "user/message", seq: s.next(), data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } },
    s.st,
  );
}

/**
 * 一个 step：assistant 文本（意图）+ N 个 tool-call，然后逐个 tool/result，最后 step/end。
 * calls: [{ name, args, text, isError }]
 */
function step(s, { intent = "看情况", calls }) {
  const turn = 1;
  const blocks = [{ type: "text", text: intent }];
  const ids = calls.map((c, i) => ({ ...c, id: `call_${s.next()}_${i}` }));
  for (const c of ids) blocks.push({ type: "tool-call", id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
  observeEvent(
    s.g,
    { type: "assistant/message", seq: s.next(), data: { turn, step: 1, message: { role: "assistant", content: blocks } } },
    s.st,
  );
  for (const c of ids) {
    observeEvent(
      s.g,
      {
        type: "tool/result",
        seq: s.next(),
        data: {
          turn,
          step: 1,
          message: { role: "tool", source: { kind: "tool", callId: c.id }, content: [{ type: "text", text: c.text ?? "" }], isError: c.isError === true },
        },
      },
      s.st,
    );
  }
  observeEvent(s.g, { type: "step/end", seq: s.next(), data: { turn, step: 1 } }, s.st);
}

/** 只读工具的五种真实结果形态（取自真实会话日志的文本形状）。 */
export const READ_CASES = [
  { label: "read 文件", name: "read", args: { file_path: "/d/x/a.mjs" }, text: "<path>/d/x/a.mjs</path>\n<type>file</type>\n<content>\n1: const a = 1;\n2: export default a;\n</content>" },
  { label: "glob 命中", name: "glob", args: { pattern: "src/**/*.mjs" }, text: "src/a.mjs\nsrc/b.mjs\nsrc/c.mjs" },
  { label: "grep 命中", name: "grep", args: { pattern: "TODO", path: "src" }, text: "src/a.mjs:12: TODO 修\nsrc/b.mjs:4: TODO 删" },
  { label: "mcp-read", name: "hindsight_search_knowledge_pages", args: { query: "缓存键" }, text: '{\n "pages": [\n  { "page": "缓存键算法", "page_id": "kp-1", "description": "x" }\n ]\n}' },
  { label: "read_page", name: "read_page", args: { url: "https://example.com/a" }, text: "# 标题\n\n正文第一段。\n\n## 小节\n内容。" },
];

/** 只跑一条只读边的单步会话 —— 验收指标「WORKING 命中 0/5 → ≥3/5」的夹具。 */
function readOnlySession(kase) {
  const s = session();
  userMessage(s, "先看清楚现状，再决定怎么改。");
  step(s, { intent: `读一下：${kase.label}`, calls: [kase] });
  return s;
}

function workingLine(text) {
  return text.split("\n").find((l) => l.startsWith("WORKING:")) ?? "";
}

/** 纯 JSON 深拷贝（**不用 fromJSON**：它会在加载边界回填 constraintHash，会污染 A/B 对比）。 */
function rawClone(g) {
  return JSON.parse(JSON.stringify(g));
}

/* ─────────────────── ① 验收指标：只读夹具 WORKING 命中 ─────────────────── */

tests["只读夹具：5 个只读场景全部出现 WORKING 且标 [weak 1/1]（旧版 0/5）"] = () => {
  let hit = 0;
  const lines = [];
  for (const kase of READ_CASES) {
    const { g } = readOnlySession(kase);
    const text = renderLedger(g, { maxTokens: 500 }).text;
    const line = workingLine(text);
    if (line) hit += 1;
    lines.push(`${kase.label}: ${line || "(无 WORKING)"}`);
    if (line && !line.includes("[weak 1/1]")) throw new Error(`${kase.label} 的弱标记不对：${line}`);
    if (line && !text.includes("# weak k/n =")) throw new Error(`${kase.label} 出现了 weak 却没有图例：\n${text}`);
  }
  if (hit !== READ_CASES.length) throw new Error(`只读夹具 WORKING 命中 ${hit}/${READ_CASES.length}\n${lines.join("\n")}`);
};

/* ─────────────────────────── ② classify 判据 ─────────────────────────── */

tests["只读成功 ⇒ unverified + weak:read（result 不变）"] = () => {
  const r = classify({ tool: "read", text: "文件内容 1234" });
  if (r.result !== "unverified") throw new Error(`result 动了：${r.result}`);
  if (r.weak !== "read") throw new Error(`weak=${JSON.stringify(r.weak)}`);
  if (r.verify.kind !== "read") throw new Error(`kind=${r.verify.kind}`);
  if (!r.verify.summary.includes("chars")) throw new Error(`summary=${r.verify.summary}`);
  for (const tool of ["glob", "grep", "web_search", "hindsight_search_knowledge_pages", "read_page", "library_search"]) {
    if (classify({ tool, text: "命中一条" }).weak !== "read") throw new Error(`${tool} 没标 weak`);
  }
};

tests["只读但无结果（空输出）⇒ 不标 weak"] = () => {
  const r = classify({ tool: "read", text: "" });
  if (r.result !== "unverified") throw new Error(`result=${r.result}`);
  if (r.weak !== undefined) throw new Error(`空输出被标成 weak=${r.weak}`);
  if (r.verify.summary !== "empty") throw new Error(`summary=${r.verify.summary}`);
  const blank = classify({ tool: "glob", text: "   \n\t\n" });
  if (blank.weak !== undefined) throw new Error("纯空白输出被标成 weak");
};

tests["只读报错 ⇒ failure，且没有 weak"] = () => {
  const enoent = classify({ tool: "read", text: "ENOENT: no such file or directory, open 'a.ts'" });
  if (enoent.result !== "failure") throw new Error(`result=${enoent.result}`);
  if (enoent.weak !== undefined) throw new Error("失败边被标了 weak");
  const hostErr = classify({ tool: "read", text: "随便什么内容", isError: true });
  if (hostErr.result !== "failure" || hostErr.weak !== undefined) throw new Error("isError 没有走 failure");
  const errLine = classify({ tool: "grep", text: "查找中…\nError: rg 崩了" });
  if (errLine.result !== "failure" || errLine.weak !== undefined) throw new Error("行首 Error: 没有走 failure");
};

tests["普通成功（exit 0）⇒ success，不是 weak"] = () => {
  const r = classify({ tool: "bash", text: "ok\n[exit code: 0]" });
  if (r.result !== "success") throw new Error(`result=${r.result}`);
  if (r.weak !== undefined) throw new Error("成功边被标了 weak");
};

tests["普通无退出码（shell no-exit）⇒ unverified + weak:\"shell\"（S2b 已实现），且能形成 WORKING"] = () => {
  // ★ 2026-10-30 S2b：本用例原是「S2b 不在本切片」的守门断言（要求 weak 不存在）。
  //   S2b 落地后契约变了：no-exit 且未命中 N1 八条失败特征 ⇒ weak:"shell"（result 仍 unverified）。
  const r = classify({ tool: "bash", text: "ls: 有一堆输出但没有退出码" });
  if (r.result !== "unverified") throw new Error(`result=${r.result}`);
  if (r.verify.kind !== "no-exit") throw new Error(`kind=${r.verify.kind}`);
  if (r.weak !== "shell") throw new Error(`S2b 应给 weak:"shell"，实际 ${JSON.stringify(r.weak)}`);
  // 会话里只有这种边 ⇒ 现在应当出现 WORKING（弱锚点）
  const s = session();
  userMessage(s, "跑一条命令");
  step(s, { calls: [{ name: "bash", args: { command: "ls" }, text: "a.txt\nb.txt" }] });
  const text = renderLedger(s.g, { maxTokens: 500 }).text;
  if (!workingLine(text)) throw new Error(`shell no-exit 应当作为弱锚点出现 WORKING：\n${text}`);
  // 但命中 N1 的 no-exit 不许给 weak（否则就是把真失败当进展）
  const bad = classify({ tool: "bash", text: "Error: boom\n    at file:///D:/x.mjs:1:1" });
  if (bad.result !== "unverified" || bad.weak !== undefined) throw new Error(`N1 命中不得给 weak：${JSON.stringify(bad)}`);
};

/* ─────────────────── ③ keeper 落账 + 图结构 ─────────────────── */

tests["keeper：tool/result 后 edge.weak 落账，result 仍是 unverified，step/end 回填 to"] = () => {
  const s = session();
  userMessage(s, "读一下 a.mjs");
  step(s, { calls: [READ_CASES[0]] });
  const edges = Object.values(s.g.edges);
  if (edges.length !== 1) throw new Error(`边数=${edges.length}`);
  const e = edges[0];
  if (e.result !== "unverified") throw new Error(`result=${e.result}`);
  if (e.weak !== "read") throw new Error(`weak=${JSON.stringify(e.weak)}`);
  if (!e.to || !s.g.nodes[e.to]) throw new Error(`to 没回填：${e.to}`);
  if (!e.from || !s.g.nodes[e.from]) throw new Error(`from 悬空：${e.from}`);
  if (failureEdges(s.g).length !== 0) throw new Error("弱边进了失败集");
  // JSON 往返后 weak 还在（落盘图自描述）
  const back = fromJSON(toJSON(s.g));
  if (back.edges[e.id].weak !== "read") throw new Error("JSON 往返丢了 weak");
};

tests["只读工具但 step 结束仍没有结果（no-result）⇒ 不标 weak，也不当锚点"] = () => {
  const g = createGraph({ sessionId: "no-result" });
  const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, touched: [], stepEdges: [] };
  const seq = [1];
  const next = () => seq[0]++;
  observeEvent(g, { type: "user/message", seq: next(), data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "读一下" }] } }, st);
  // 只声明 tool-call，不给 tool/result，直接 step/end
  observeEvent(g, { type: "assistant/message", seq: next(), data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "读 a" }, { type: "tool-call", id: "call_x", name: "read", arguments: '{"file_path":"a"}' }] } } }, st);
  observeEvent(g, { type: "step/end", seq: next(), data: { turn: 1, step: 1 } }, st);
  const e = Object.values(g.edges)[0];
  if (e.result !== "unverified") throw new Error(`result=${e.result}`);
  if (e.verify?.kind !== "no-result") throw new Error(`kind=${e.verify?.kind}`);
  if (e.weak !== undefined) throw new Error(`没有结果却被标 weak=${e.weak}`);
  const text = renderLedger(g, { maxTokens: 500 }).text;
  if (workingLine(text)) throw new Error(`no-result 的边不该当锚点：\n${text}`);
};

tests["settleEdge：重新结算成 success 时清掉 weak；addEdge 不预置 weak 字段"] = () => {
  const g = createGraph({ sessionId: "s" });
  const u = addUserNode(g, { seq: 1, text: "x" });
  const e = addEdge(g, { from: u, intent: "读", action: "read(file_path=a)" });
  if (Object.hasOwn(g.edges[e], "weak")) throw new Error("addEdge 不该预置 weak");
  settleEdge(g, e, { result: "unverified", verify: { kind: "read", summary: "10 chars" }, weak: "read" });
  if (g.edges[e].weak !== "read") throw new Error("weak 没落账");
  settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  if (Object.hasOwn(g.edges[e], "weak")) throw new Error("重新结算后 weak 没清掉");
};

tests["多轮工具序列：read → read → bash(exit 0) ⇒ 强证据优先，WORKING 仍是强链（弱边不顶掉强证据）"] = () => {
  const s = session();
  userMessage(s, "先看清楚再动手");
  step(s, { intent: "读 a", calls: [READ_CASES[0]] });
  step(s, { intent: "读 b", calls: [READ_CASES[2]] });
  step(s, { intent: "跑测试", calls: [{ name: "bash", args: { command: "npm test" }, text: "12 passing\n[exit code: 0]" }] });
  const text = renderLedger(s.g, { maxTokens: 500 }).text;
  const line = workingLine(text);
  if (!line) throw new Error(`没有 WORKING：\n${text}`);
  // 锚点 = 最后一条强 success（n3 → n4）；弱边只影响 CURRENT PATH，不顶掉 WORKING
  if (!/^WORKING: n\d+ → n\d+ \(exit 0\)$/.test(line)) throw new Error(`WORKING 行不对（强证据被弱边顶掉了？）：${line}`);
  if (text.includes("[weak")) throw new Error(`有强 success 的图不该出现 weak 标记：\n${text}`);
  if (text.includes("# weak k/n =")) throw new Error("没有 weak 标记却有 weak 图例");
  if (failureEdges(s.g).length !== 0) throw new Error("弱边进了失败集");
  // 成功/未验证计数没变：success 只有 1 条，unverified 有 2 条
  const byResult = {};
  for (const e of Object.values(s.g.edges)) byResult[e.result] = (byResult[e.result] ?? 0) + 1;
  if (byResult.success !== 1 || byResult.unverified !== 2) throw new Error(`计数变了：${JSON.stringify(byResult)}`);
};

tests["多轮工具序列：无强锚点时 WORKING 全链 + [weak 3/3]、不把「N chars」当验证摘要"] = () => {
  const s = session();
  userMessage(s, "先看清现状，别急着改");
  step(s, { calls: [READ_CASES[0]] });
  step(s, { calls: [{ name: "bash", args: { command: "npm test" }, text: "12 passing\n[exit code: 0]" }] });
  step(s, { calls: [READ_CASES[3]] });
  const strongText = renderLedger(s.g, { maxTokens: 500 }).text;
  if (!/^WORKING: n\d+ → n\d+ \(exit 0\)$/m.test(strongText)) throw new Error(`有强成功时 WORKING 不对：${strongText}`);
  // 把那条强边降级成弱边（= 只有只读成功的会话）⇒ WORKING 变成带标记的全链
  const strong = Object.values(s.g.edges).find((e) => e.result === "success");
  strong.result = "unverified";
  strong.verify = { kind: "read", summary: "12 chars" };
  strong.weak = "read";
  const text = renderLedger(s.g, { maxTokens: 500 }).text;
  const line = workingLine(text);
  if (!line) throw new Error(`没有 WORKING：\n${text}`);
  if (!/^WORKING: user → n\d+ → n\d+ → n\d+ \[weak 3\/3\]$/.test(line)) throw new Error(`弱链 WORKING 不对：${line}`);
  if (/\(\d+ chars\)/.test(line)) throw new Error(`弱尾部把「N chars」当验证摘要放出来了：${line}`);
};

tests["同一工具重复调用：同一步两条 read 边都算弱，不新建多余节点、不产生 dead/redundant"] = () => {
  const s = session();
  userMessage(s, "同一文件读了两次");
  step(s, { calls: [READ_CASES[0], READ_CASES[0]] });
  const edges = Object.values(s.g.edges);
  if (edges.length !== 2) throw new Error(`边数=${edges.length}`);
  if (edges.filter((e) => e.weak === "read").length !== 2) throw new Error("两条都没标 weak");
  const nodes = Object.keys(s.g.nodes).length;
  if (nodes !== 2) throw new Error(`节点数=${nodes}（user + 1 个 state 才 2）`);
  const text = renderLedger(s.g, { maxTokens: 500 }).text;
  if (!workingLine(text)) throw new Error(`重复只读没有 WORKING：\n${text}`);
  for (const e of failureEdges(s.g)) {
    const t = tewariAnalysis(s.g, e);
    if (t?.redundantVs?.length) throw new Error("重复只读产生了 redundant");
  }
};

/* ─────────────────── ④ 弱成功不得污染 tewari / facts ─────────────────── */

tests["弱成功不进 tewari：同起点的弱边不是「成功替代路径」，failureClass 不判 dead"] = () => {
  // 手写图的原因：要让「失败边」和「弱边」指向同一个节点（keeper 每步一个节点，构造不出同终点）。
  function build(weakAsSuccess) {
    const g = createGraph({ sessionId: "tewari" });
    const u = addUserNode(g, { seq: 1, text: "把测试跑绿" });
    const eWeak = addEdge(g, { from: u, intent: "先读测试文件", action: "read(file_path=tests/case7.test.js)" });
    const eFail = addEdge(g, { from: u, intent: "再跑一遍看看", action: "bash(npm test)" });
    const n = addAgentNode(g, { seq: 8, goal: "看过了", worldHash: "W1", constraintHash: "C1", via: eWeak }).id;
    g.edges[eWeak].to = n;
    g.edges[eFail].to = n;
    settleEdge(g, eWeak, {
      result: weakAsSuccess ? "success" : "unverified",
      verify: { kind: weakAsSuccess ? "exit" : "read", summary: weakAsSuccess ? "exit 0" : "120 chars" },
      weak: weakAsSuccess ? null : "read",
    });
    settleEdge(g, eFail, { result: "failure", verify: { kind: "exit", summary: "exit 137" }, errorSnippet: "Error: flaky test run aborted" });
    return { g, eFail };
  }
  const real = build(false);
  const t = tewariAnalysis(real.g, real.g.edges[real.eFail]);
  if (!t) throw new Error("tewari 没结果");
  if (t.alternatives !== 0) throw new Error(`弱边被当成了成功替代路径：alts=${t.alternatives}`);
  if (t.redundantVs.length !== 0) throw new Error(`弱边产生了 redundant：${t.redundantVs}`);
  if (t.longerVs.length !== 0) throw new Error(`弱边产生了 longer：${t.longerVs}`);
  if (failureClass(real.g.edges[real.eFail], t).kind === "dead") throw new Error("弱边让失败边被判 dead");
  // 反例（变异自检）：同样的边标成 success ⇒ dead 必须出现（证明上一条断言真的在挖东西）
  const bad = build(true);
  const tb = tewariAnalysis(bad.g, bad.g.edges[bad.eFail]);
  if (tb.redundantVs.length === 0) throw new Error("反例不成立：把弱边当 success 也没产生 redundant（夹具失效）");
  if (failureClass(bad.g.edges[bad.eFail], tb).kind !== "dead") throw new Error("反例不成立：把弱边当 success 也没判 dead");
};

tests["弱成功不进 facts：renderFacts 与「抹掉 weak 字段」逐字相同，弱边仍在 UNVERIFIED_CLAIMS"] = () => {
  const s = session();
  userMessage(s, "把 data.jsonl 算出来。必须保持 API 不变。");
  step(s, { calls: [READ_CASES[0]] });
  step(s, { calls: [{ name: "bash", args: { command: "npm test" }, text: "boom\n[exit code: 1]" }] });
  step(s, { calls: [READ_CASES[2]] });
  const withWeak = renderFacts(s.g);
  const stripped = rawClone(s.g);
  for (const e of Object.values(stripped.edges)) delete e.weak;
  const without = renderFacts(stripped);
  if (withWeak !== without) throw new Error("renderFacts 的输出被 weak 影响了");
  if (withWeak.includes("weak")) throw new Error("facts 里出现了 weak 字样（不该把弱成功当事实）");
  // 失败边仍然逐条在，弱边仍在 UNVERIFIED_CLAIMS（既有行为，不新增也不删除）
  // 失败边行是 `* eN intent="…" action=…`；UNVERIFIED_CLAIMS 行是 `* eN "…"` —— 分开数，别混口径
  const failLines = withWeak.split("\n").filter((l) => /^\* e\d+ intent=/.test(l));
  if (failLines.length !== 1) throw new Error(`FAILED_ATTEMPTS 行数=${failLines.length}`);
  if (!withWeak.includes("UNVERIFIED_CLAIMS")) throw new Error("UNVERIFIED_CLAIMS 段丢了");
  const unvLines = withWeak.split("\n").filter((l) => /^\* e\d+ "/.test(l));
  if (unvLines.length < 2) throw new Error(`弱边没留在 UNVERIFIED_CLAIMS：${JSON.stringify(unvLines)}`);
};

/* ─────────────────── ⑤ 预算 / 兼容 / 不变量 ─────────────────── */

tests["热清单预算：弱成功夹具仍 ≤500 tokens（含图例）"] = () => {
  for (const kase of READ_CASES) {
    const { g } = readOnlySession(kase);
    const r = renderLedger(g, { maxTokens: 500 });
    if (r.tokens > 500) throw new Error(`${kase.label} 超预算：${r.tokens}`);
    if (r.text.includes("# weak k/n =") && !workingLine(r.text)) throw new Error("有图例却没有 WORKING 行");
  }
  // 大图：40 条失败边 + 若干弱边，预算仍要守住
  const s = session();
  userMessage(s, "先看一眼再改");
  step(s, { calls: [READ_CASES[0]] });
  for (let i = 0; i < 40; i += 1) {
    step(s, {
      calls: [
        { name: "bash", args: { command: `npm test ${i}` }, text: "Error: 又炸了" , isError: false },
        { name: `bash`, args: { command: `node check${i}.mjs` }, text: "Started background job" },
      ],
    });
  }
  for (const e of Object.values(s.g.edges)) if (e.result === "unverified" && !e.weak && e.verify?.kind === "no-exit") { /* S2b 边：保持原样 */ }
  const r = renderLedger(s.g, { maxTokens: 500 });
  if (r.tokens > 500) throw new Error(`大图超预算：${r.tokens} @L${r.level}`);
};

tests["旧图兼容：没有 weak 字段、只有 verify.kind===\"read\" 的边仍被识别为弱锚点"] = () => {
  const g = createGraph({ sessionId: "legacy" });
  const u = addUserNode(g, { seq: 1, text: "读一下配置文件" });
  const e = addEdge(g, { from: u, intent: "读 config", action: "read(file_path=config.json)" });
  const n2 = addAgentNode(g, { seq: 4, goal: "看过配置", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { result: "unverified", verify: { kind: "read", summary: "1234 chars" } });
  g.edges[e].to = n2;
  const text = renderLedger(g, { maxTokens: 500 }).text;
  const line = workingLine(text);
  if (!line || !line.includes("[weak 1/1]")) throw new Error(`旧图弱锚点没被识别：\n${text}`);
  if (Object.hasOwn(g.edges[e], "weak")) throw new Error("渲染不该给旧图写 weak 字段");
  // 旧图里的「空输出」read（summary=empty）不算弱锚点
  const g2 = createGraph({ sessionId: "legacy-empty" });
  const u2 = addUserNode(g2, { seq: 1, text: "读一下" });
  const e2 = addEdge(g2, { from: u2, intent: "读", action: "read(file_path=empty.txt)" });
  const n2b = addAgentNode(g2, { seq: 4, goal: "", worldHash: "W1", constraintHash: "C1", via: e2 }).id;
  settleEdge(g2, e2, { result: "unverified", verify: { kind: "read", summary: "empty" } });
  g2.edges[e2].to = n2b;
  if (workingLine(renderLedger(g2, { maxTokens: 500 }).text)) throw new Error("空的只读结果不该当弱锚点");
};

tests["旧图兼容：只有强 success 的图，WORKING 行逐字不变（不许出现 weak 标记）"] = () => {
  const g = createGraph({ sessionId: "strong-only" });
  const u = addUserNode(g, { seq: 1, text: "把缓存键修好" });
  const e1 = addEdge(g, { from: u, intent: "改 cache.js", action: "edit(file_path=src/cache.js)" });
  const n2 = addAgentNode(g, { seq: 5, goal: "改完", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  g.edges[e1].to = n2;
  settleEdge(g, e1, { result: "success", verify: { kind: "diff", summary: "3 lines changed" } });
  const e2 = addEdge(g, { from: n2, intent: "跑测试", action: "bash(npm test)" });
  const n3 = addAgentNode(g, { seq: 9, goal: "跑通", worldHash: "W2", constraintHash: "C1", via: e2 }).id;
  g.edges[e2].to = n3;
  settleEdge(g, e2, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const r = renderLedger(g, { maxTokens: 500 });
  if (r.text !== "<chess-ledger>\nROOT USER (verbatim): 把缓存键修好\nCURRENT GOAL: 跑通\nWORKING: user → n2 → n3 (exit 0)\n</chess-ledger>") {
    throw new Error(`强 success 图的输出变了：\n${JSON.stringify(r.text)}`);
  }
};

tests["弱成功不改变既有事件语义：openEdges / failureEdges / validate 结果与抹掉 weak 后一致"] = () => {
  const s = session();
  userMessage(s, "先读再看再跑");
  step(s, { calls: [READ_CASES[0]] });
  step(s, { calls: [{ name: "bash", args: { command: "npm test" }, text: "boom\n[exit code: 1]" }] });
  step(s, { calls: [READ_CASES[1]] });
  const stripped = rawClone(s.g);
  for (const e of Object.values(stripped.edges)) delete e.weak;
  if (failureEdges(s.g).map((e) => e.id).join(",") !== failureEdges(stripped).map((e) => e.id).join(",")) throw new Error("failureEdges 变了");
  if (openEdges(s.g).map((e) => e.id).join(",") !== openEdges(stripped).map((e) => e.id).join(",")) throw new Error("openEdges 变了");
  if (validate(s.g).length !== validate(stripped).length) throw new Error(`validate 结果变了：${JSON.stringify(validate(s.g))}`);
  // 弱边仍是 unverified（不是 untested / success）
  for (const e of Object.values(s.g.edges)) if (e.weak) if (e.result !== "unverified") throw new Error("weak 边 result 漂移");
};

tests["图不变量：weak 挂在非 unverified 上是问题，挂在 unverified 上不是"] = () => {
  const g = createGraph({ sessionId: "inv" });
  const u = addUserNode(g, { seq: 1, text: "x" });
  const e = addEdge(g, { from: u, intent: "读", action: "read(file_path=a)" });
  settleEdge(g, e, { result: "unverified", verify: { kind: "read", summary: "9 chars" }, weak: "read" });
  if (validate(g).some((p) => p.includes("weak"))) throw new Error("合法 weak 被误报");
  settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" }, weak: "read" });
  const problems = validate(g);
  if (!problems.some((p) => p.includes("weak"))) throw new Error(`非法 weak 没被抓住：${JSON.stringify(problems)}`);
};

tests["weakKindOf：只认 unverified + 已落账 weak / 旧图的 verify.kind=read"] = () => {
  if (weakKindOf({ result: "success", verify: { kind: "exit" } }) !== null) throw new Error("success 不该弱");
  if (weakKindOf({ result: "failure", weak: "read" }) !== null) throw new Error("failure 不该弱");
  if (weakKindOf({ result: "unverified", weak: "read" }) !== "read") throw new Error("落账 weak 没认出来");
  if (weakKindOf({ result: "unverified", verify: { kind: "read", summary: "12 chars" } }) !== "read") throw new Error("旧图没认出来");
  if (weakKindOf({ result: "unverified", verify: { kind: "read", summary: "empty" } }) !== null) throw new Error("空输出不该弱");
  if (weakKindOf({ result: "unverified", verify: { kind: "no-exit", summary: "12 chars, no exit code" } }) !== null) throw new Error("shell no-exit 不该弱");
  if (weakKindOf({ result: "unverified", verify: { kind: "none", summary: "x" } }) !== null) throw new Error("kind=none 不该弱");
};

tests["标记档位 markers:off 时，weak 标记与图例仍然出现（安全信息不能被省掉）"] = () => {
  const s = readOnlySession(READ_CASES[1]);
  const r = renderLedger(s.g, { maxTokens: 500, markers: "off" });
  const line = workingLine(r.text);
  if (!line || !line.includes("[weak 1/1]")) throw new Error(`off 档把 weak 吞了：${line}`);
  if (!r.text.includes("# weak k/n =")) throw new Error("off 档缺图例");
};

tests["WORKING 锚点不取失败边 / 不取自环边 / 不取无 to 的边"] = () => {
  const g = createGraph({ sessionId: "anchors" });
  const u = addUserNode(g, { seq: 1, text: "x" });
  const eSelf = addEdge(g, { from: u, intent: "自环", action: "read(a)" });
  settleEdge(g, eSelf, { result: "success", verify: { kind: "exit", summary: "exit 0" }, to: u });
  const eFail = addEdge(g, { from: u, intent: "失败", action: "bash(x)" });
  settleEdge(g, eFail, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
  const eOpen = addEdge(g, { from: u, intent: "未结算", action: "bash(y)" });
  settleEdge(g, eOpen, { result: "unverified", verify: { kind: "no-exit", summary: "x chars, no exit code" } });
  const text = renderLedger(g, { maxTokens: 500 }).text;
  if (workingLine(text)) throw new Error(`不该有 WORKING：\n${text}`);
  // 弱边但 to 悬空（节点不存在）⇒ 同样不能当锚点
  const g2 = createGraph({ sessionId: "dangling" });
  const u2 = addUserNode(g2, { seq: 1, text: "x" });
  const e2 = addEdge(g2, { from: u2, intent: "弱但悬空", action: "read(a)" });
  settleEdge(g2, e2, { result: "unverified", verify: { kind: "read", summary: "9 chars" }, weak: "read", to: "n99" });
  if (workingLine(renderLedger(g2, { maxTokens: 500 }).text)) throw new Error("悬空 to 的弱边被当成锚点");
};