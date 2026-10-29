/**
 * weak-shell.test.mjs —— S2b「no-exit 弱成功按 N1 收窄」的回归矩阵（2026-10-30）
 *
 * 背景：WS-S2B 报告（tmp/dsh-gokifu-compact/ws-s2b/REPORT.md）实测 —— no-exit 全标 weak
 * 的误报率 2.94%（95% CI 2.25–4.03%），加 N1 八条失败特征后残余 0.49%。
 *
 * 本文件锁住三件事：
 *   1. N1 八条规则**逐条**正反例（命中就不给 weak；不命中才给 weak:"shell"）；
 *   2. `result` 永远是 `unverified`，weak 不进 failureEdges / tewari / renderFacts；
 *   3. 真实形态：node 栈迹、Python traceback、管道、空输出、CRLF、旧图兼容。
 */

import { classify, weakKindOf, shellWeakVetoHits, SHELL_WEAK_VETO_RULES } from "../src/verifier.mjs";
import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, failureEdges, tewariAnalysis } from "../src/graph.mjs";
import { renderLedger, renderFacts } from "../src/ledger.mjs";

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 一条 bash 边 + 一个 agent 节点，settle 成 unverified/shell-weak。 */
function shellWeakGraph({ text = "12 passing", weak = null, sessionId = "fx-shell" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "把测试跑通。" });
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)" });
  const a = addAgentNode(g, { seq: 3, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  g.edges[e].to = a;
  settleEdge(g, e, { result: "unverified", weak, verify: { kind: "no-exit", summary: `${text.length} chars, no exit code` } });
  return { g, ids: [u, a], edge: e };
}

const BENIGN = "total 24\ndrwxr-xr-x 1 user 197121 0 Oct 30 01:00 .\n-rw-r--r-- 1 user 197121 1320 Oct 30 01:00 package.json";

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "S2b-1 N1 规则表：八条规则齐备、id 唯一、每条都有 why 与 test"(t) {
    const ids = SHELL_WEAK_VETO_RULES.map((r) => r.id);
    t.eq(ids.length, 8, `规则必须 8 条，实际 ${ids.length}：${ids.join(",")}`);
    t.eq(new Set(ids).size, 8, "id 不得重复");
    for (const expected of ["SELFEXIT", "NODECRASH", "STACKTAIL", "NOTFOUND", "ERRTYPE", "TESTFAIL", "NPMERR", "PYTRACE"]) {
      t.ok(ids.includes(expected), `缺规则 ${expected}`);
    }
    for (const rule of SHELL_WEAK_VETO_RULES) {
      t.eq(typeof rule.test, "function", `${rule.id} 缺 test`);
      t.ok(String(rule.why ?? "").length > 4, `${rule.id} 缺 why（规则必须能解释自己）`);
    }
    t.eq(SHELL_WEAK_VETO_RULES, Object.freeze(SHELL_WEAK_VETO_RULES) && SHELL_WEAK_VETO_RULES, "规则表只读");
  },

  "S2b-2 每条规则命中 ⇒ 不给 weak；result 仍是 unverified"(t) {
    const positives = {
      SELFEXIT: "changed lines count\n  2\ndiff exit=1",
      NODECRASH: "Error while loading\nevents.js:292\r\n      throw er;\r\n\r\nNode.js v24.20.0\r\n",
      STACKTAIL: "Error: boom\n    at file:///D:/x.mjs:1:1\n",
      NOTFOUND: "bash: line 1: foo: command not found",
      ERRTYPE: "SyntaxError: Unexpected token '}'",
      TESTFAIL: "FAILED (failures=1)",
      NPMERR: "npm error code E404",
      PYTRACE: 'Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nValueError: bad',
    };
    for (const [id, text] of Object.entries(positives)) {
      const hits = shellWeakVetoHits(text);
      t.ok(hits.includes(id), `${id} 必须命中，实际 ${JSON.stringify(hits)}（文本：${JSON.stringify(text.slice(0, 80))}）`);
      const c = classify({ tool: "bash", text });
      t.eq(c.result, "unverified", `${id}: result 必须保持 unverified`);
      t.eq(c.weak, undefined, `${id}: 命中 N1 就不许给 weak`);
      t.eq(c.verify.kind, "no-exit", `${id}: verify.kind 仍是 no-exit`);
    }
  },

  "S2b-3 每条规则的不命中反例：普通输出必须给 weak:\"shell\""(t) {
    const negatives = {
      SELFEXIT: "12 passing\nexit=0",
      NODECRASH: "node -v\nv24.20.0",
      STACKTAIL: "readme says: do not use `at file:///` in docs",
      NOTFOUND: "grep: 3 matches found",
      ERRTYPE: "the word TypeError appears in this documentation line",
      TESTFAIL: "all tests passed, 0 failed",
      NPMERR: "npm notice 1 package",
      PYTRACE: "Traceback is a word in this sentence",
    };
    for (const [id, text] of Object.entries(negatives)) {
      const hits = shellWeakVetoHits(text);
      t.eq(hits, [], `${id} 的反例不该命中任何规则，实际 ${JSON.stringify(hits)}`);
      t.eq(classify({ tool: "bash", text }).weak, "shell", `${id} 反例必须给 weak:"shell"`);
    }
  },

  "S2b-4 node 栈迹：CRLF + 多帧 + Node.js 版本尾巴必须否决"(t) {
    const text = "ReferenceError: x is not defined\r\n    at Object.<anonymous> (D:\\a.mjs:2:3)\r\n    at Module._compile (node:internal/modules/cjs/loader:1:1)\r\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\r\n\r\nNode.js v24.18.1\r\n";
    const hits = shellWeakVetoHits(text);
    t.ok(hits.includes("STACKTAIL"), `必须命中 STACKTAIL，实际 ${JSON.stringify(hits)}`);
    t.ok(hits.includes("NODECRASH"), `必须命中 NODECRASH，实际 ${JSON.stringify(hits)}`);
    t.eq(classify({ tool: "bash", text }).weak, undefined, "node 崩溃不得给 weak");
    // CRLF 归一：纯 LF 的同文本必须命中同一批规则
    t.eq(shellWeakVetoHits(text.replace(/\r\n/g, "\n")), hits, "CRLF 与 LF 必须同结果");
  },

  "S2b-5 Python traceback：任何一帧都否决（不能只看末行）"(t) {
    const text = 'Traceback (most recent call last):\n  File "/tmp/a.py", line 3, in <module>\n    raise ValueError("x")\nValueError: x';
    t.ok(shellWeakVetoHits(text).includes("PYTRACE"), "必须命中 PYTRACE");
    t.eq(classify({ tool: "bash", text }).weak, undefined, "python traceback 不得给 weak");
    // 中段出现 Traceback（前面还有正常输出）也要抓
    const mid = "running...\nTraceback (most recent call last):\n  File \"a.py\"\nKeyboardInterrupt\n";
    t.ok(shellWeakVetoHits(mid).includes("PYTRACE"), "中段 Traceback 也要命中");
  },

  "S2b-6 管道命令：无错误特征 ⇒ weak shell；前段失败被 tail 吞掉但有错误文本 ⇒ 否决"(t) {
    const okPipe = "12 passing\n12 passing lines\n";
    t.eq(shellWeakVetoHits(okPipe), [], "正常管道输出不命中");
    t.eq(classify({ tool: "bash", text: okPipe }).weak, "shell", "正常管道输出可给 weak");
    const badPipe = "npm error code 1\nsome output\n";
    t.ok(shellWeakVetoHits(badPipe).includes("NPMERR"), "管道里出现 npm error 必须否决");
    t.eq(classify({ tool: "bash", text: badPipe }).weak, undefined, "带错误文本的管道不得给 weak");
  },

  "S2b-7 空输出：没有任何内容可判断 ⇒ 不给 weak（不许猜）"(t) {
    const c = classify({ tool: "bash", text: "" });
    t.eq(c.result, "unverified", "空输出仍是 unverified");
    t.eq(c.verify.summary, "empty", "summary 标 empty");
    t.eq(c.weak, undefined, "空输出不得给 weak");
    const ws = classify({ tool: "bash", text: "   \n\t\n" });
    t.eq(ws.weak, undefined, "纯空白也不得给 weak");
  },

  "S2b-8 有退出码时 N1 不参与：exit 0 仍 success、exit≠0 仍 failure（result 语义不变）"(t) {
    t.eq(classify({ tool: "bash", text: "done\n[exit code: 0]" }).result, "success", "exit 0 → success");
    t.eq(classify({ tool: "bash", text: "done\n[exit code: 0]" }).weak, undefined, "success 不得带 weak");
    const bad = classify({ tool: "bash", text: "boom\n[exit code: 1]" });
    t.eq(bad.result, "failure", "exit 1 → failure");
    t.eq(bad.weak, undefined, "failure 不得带 weak");
    // 有 exit code 时即使正文含 N1 特征，也按退出码裁决（N1 只作用于 no-exit 分支）
    t.eq(classify({ tool: "bash", text: "TypeError: x\n[exit code: 0]" }).result, "success", "有 exit 0 时不被 N1 影响");
  },

  "S2b-9 真实 no-exit 正例：git/grep 这类纯读取输出必须能成为弱边"(t) {
    const samples = [
      " M src/ledger.mjs\n M test/ui.test.mjs",
      "src/verifier.mjs:218:export function weakKindOf(edge) {",
      "On branch main\nnothing to commit, working tree clean",
    ];
    for (const text of samples) {
      t.eq(shellWeakVetoHits(text), [], `真实正例不该命中：${text.slice(0, 40)}`);
      const c = classify({ tool: "bash", text });
      t.eq(c.result, "unverified", "正例 result=unverified");
      t.eq(c.weak, "shell", `正例必须给 weak:"shell"：${text.slice(0, 40)}`);
    }
  },

  "S2b-10 弱边不影响标记：failureEdges / tewari / renderFacts 逐字不变"(t) {
    const { g, edge } = shellWeakGraph({ text: BENIGN, weak: null });
    const factsBefore = renderFacts(g);
    t.eq(failureEdges(g).length, 0, "unverified 边不进 failureEdges");
    // 加上 weak:"shell" 后逐项不变
    g.edges[edge].weak = "shell";
    t.eq(failureEdges(g).length, 0, "weak 边仍不进 failureEdges");
    t.eq(renderFacts(g), factsBefore, "renderFacts 必须逐字不变");
    // tewari 只吃 failure 边：给 weak 不影响任何 failure 边的分析
    const g2 = createGraph({ sessionId: "fx-tewari" });
    const u = addUserNode(g2, { seq: 1, text: "目标" });
    const f1 = addEdge(g2, { from: u, intent: "失败", action: "bash(x)" });
    settleEdge(g2, f1, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "boom" });
    const before = JSON.stringify(tewariAnalysis(g2, g2.edges[f1]));
    const w = addEdge(g2, { from: u, intent: "弱", action: "bash(y)" });
    settleEdge(g2, w, { result: "unverified", weak: "shell", verify: { kind: "no-exit", summary: "10 chars, no exit code" } });
    t.eq(JSON.stringify(tewariAnalysis(g2, g2.edges[f1])), before, "tewari 结果不得因 weak 边改变");
  },

  "S2b-11 旧图兼容：没有 weak 字段的 no-exit 边不猜（weakKindOf 返回 null）"(t) {
    const legacy = { id: "e1", result: "unverified", verify: { kind: "no-exit", summary: "10 chars, no exit code" } };
    t.eq(weakKindOf(legacy), null, "旧图 no-exit 边不许猜 weak");
    t.eq(weakKindOf({ result: "unverified", weak: "shell", verify: { kind: "no-exit" } }), "shell", "新图 weak:shell 必须识别");
    t.eq(weakKindOf({ result: "success", weak: "shell", verify: { kind: "exit" } }), null, "success 上的脏 weak 不算");
    t.eq(weakKindOf({ result: "unverified", verify: { kind: "read", summary: "1234 chars" } }), "read", "S2a 旧图只读兼容仍有效");
  },

  "S2b-12 WORKING 覆盖率：同一个 shell no-exit 边，加 weak 前无 WORKING、加后出现"(t) {
    const before = shellWeakGraph({ text: BENIGN, weak: null, sessionId: "fx-cover-before" });
    const rBefore = renderLedger(before.g, { maxTokens: 500 });
    t.eq(rBefore.text.includes("WORKING:"), false, "没有 weak 时不该有 WORKING");
    const after = shellWeakGraph({ text: BENIGN, weak: "shell", sessionId: "fx-cover-after" });
    const rAfter = renderLedger(after.g, { maxTokens: 500 });
    t.ok(rAfter.text.includes("WORKING:"), `有 weak:"shell" 时必须有 WORKING：${rAfter.text}`);
    t.ok(rAfter.text.includes("[weak 1/1]"), "必须标 [weak k/n]");
    t.ok(rAfter.text.includes("# weak k/n ="), "必须带 weak 图例");
    t.ok(rAfter.tokens <= 500, `预算必须 ≤500，实际 ${rAfter.tokens}`);
    // 弱边不得冒充验证摘要
    t.eq(rAfter.text.includes("chars"), false, "弱边不许把「N chars」当验证摘要");
  },

  "S2b-13 预算：40 条 shell 弱边 + 长路径在 500 预算内仍渲染且不超预算"(t) {
    const g = createGraph({ sessionId: "fx-budget" });
    const u = addUserNode(g, { seq: 1, text: "把构建跑通，别动 prod。" });
    let cursor = u;
    for (let i = 0; i < 12; i += 1) {
      const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步`, action: "bash(npm test)" });
      const a = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
      g.edges[e].to = a;
      settleEdge(g, e, { result: "unverified", weak: "shell", verify: { kind: "no-exit", summary: "20 chars, no exit code" } });
      cursor = a;
    }
    const r = renderLedger(g, { maxTokens: 500 });
    t.ok(r.tokens <= 500, `必须 ≤500，实际 ${r.tokens}`);
    if (r.level <= 2) t.ok(r.text.includes("WORKING:"), "L0-L2 必须有 WORKING");
  },
};
