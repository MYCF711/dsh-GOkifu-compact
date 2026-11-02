/**
 * ledger-boundary.test.mjs —— 压缩产物的「来源与选项」保真（2026-11-01）
 *
 * 三条来自 `docs/research/03-human-memory.md` 的建议，都是**压缩本职**（不是记忆管理）：
 *   A. **出处（seq）任何降级档位都不砍** —— 来源监控：模型必须知道一条事实「哪来的」。
 *      越紧的档位越需要它，旧版却在 L2+ 整段砍掉（`seq && level <= 1`）。
 *   C. **失败原因用中段省略** —— 错误码常在开头、路径常在结尾，纯首部截断会把路径切没，
 *      而「哪个文件 EACCES」正是这条失败边唯一的判别价值。
 *   D. **OPTIONS 在 L2+ 也保留一行计数** —— 提取诱发遗忘（RIF）：只列当前路径会让模型
 *      忘记还有别的路；沉默本身就是断言（"只有这一条路"）。
 *
 * 这三条都只改**压缩产物怎么呈现**，不碰历史、不碰工具、不碰系统提示词。
 */

import { provenanceCoverageOf, renderFailureLine, renderFacts, renderLedger } from "../src/rooms/ledger.mjs";

export const tests = {};

function mkEdge(over = {}) {
  return {
    id: "e1",
    from: "n1",
    to: "n2",
    intent: "bash(node test.mjs) — 跑测试看看",
    action: "bash(command=node test.mjs)",
    result: "failure",
    errorSnippet: "ERROR: EACCES: permission denied, open '/very/long/path/to/config.json'",
    evidence: { start: 10, end: 12 },
    verify: { kind: "exit", summary: "exit code: 1" },
    ts: Date.now(),
    ...over,
  };
}

function mkGraph(edges = []) {
  const now = Date.now();
  const nodes = {
    n1: { id: "n1", kind: "user", seq: 1, text: "把测试跑绿", ts: now - 3000 },
    n2: { id: "n2", kind: "agent", seq: 2, goal: "跑测试", ts: now - 2000 },
  };
  const g = {
    version: 1,
    sessionId: "s",
    cwd: "E:/x",
    order: ["n1", "n2"],
    nodes,
    edges: {},
    nextNode: 3,
    nextEdge: edges.length + 1,
    // 注意：不要写 `rootNode: "n1"` —— ledger 读的是 `g.rootNode?.text`，生产图里根本没有这个字段
    // （只有 rootUserNodeIds），传 id 会让 ROOT USER 行渲染成空。
    rootUserNodeIds: ["n1"],
  };
  for (const e of edges) g.edges[e.id] = e;
  return g;
}

tests["C227 残留失败必须显式计数（omittedResidue 以前算了没人用）"] = (t) => {
  // 事故：`renderLedger` 算了 `omittedResidue` 却**从来没用过** ——
  // 「无终点」的 rewash 残留失败被静默丢掉，模型读「LEARNED (1 failed attempts)」会以为那就是全部。
  // 本仓库的规矩是「静默省略比多花 token 更危险」，所以补一行计数 + 指针（不展开内容）。
  const now = Date.now();
  const old = now - 60 * 60 * 1000;
  // 残留 = 已结算（不是 untested）且 to=null 且已过 10 分钟 —— 见 classifyDangling
  const residue = mkEdge({ id: "e9", to: null, result: "failure", ts: old });
  const g = mkGraph([mkEdge({ id: "e1" }), residue]);
  const out = renderLedger(g, { now, maxTokens: 500 });
  t.includes(out.text, "无终点残留", "残留失败必须有一行计数（否则模型以为清单是全量）");
  t.includes(out.text, "1 条", "要给出条数");
  // 零成本：没有残留时不许出这行
  const clean = renderLedger(mkGraph([mkEdge()]), { now, maxTokens: 500 });
  t.eq(clean.text.includes("无终点残留"), false, "没有残留时不许出这行");
};

tests["A 出处（seq）在任何降级档位都保留"] = (t) => {
  const edge = mkEdge();
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const line = renderFailureLine(edge, level);
    // 格式随档位变（L0/L1 是 `(seq a-b)`，L2+ 是 `(sa-b)`），但**出处数字一个都不能少**。
    t.includes(line, "10-12", `level=${level} 的失败边必须保留出处数字（来源监控）`);
  }
};

tests["C 失败原因中段省略：错误码（首）与路径后缀（尾）都还在"] = (t) => {
  const line = renderFailureLine(mkEdge(), 3); // reasonLen = 25（最紧档）
  t.includes(line, "EACCES", "开头错误码不能在紧档位丢失");
  t.includes(line, "json", "结尾路径后缀不能在紧档位丢失");
  t.notIncludes(line, "permission denied, open", "中段应被省略（证明真的做了中段截断而不是纯首部）");
};

tests["D OPTIONS 在预算紧张时也保留一行计数（不许沉默）"] = (t) => {
  const now = Date.now();
  const option = {
    id: "e9",
    from: "n2",
    to: null,
    result: "untested",
    intent: "换一条路：grep 整个仓库找调用点",
    action: "grep(pattern=foo)",
    ts: now - 1000,
  };
  const g = mkGraph([option]);

  const loose = renderLedger(g, { now, maxTokens: 500 });
  t.includes(loose.text, "OPTIONS", "宽松预算下必须有 OPTIONS 段（列表或计数行）");

  const tight = renderLedger(g, { now, maxTokens: 120 });
  t.includes(tight.text, "OPTIONS", "预算被压到紧张时也必须留 OPTIONS 行 —— 沉默等于断言「没有别的路」");
};

tests["I 出处覆盖率：失败边行必须带 (seq …)；OPTIONS/UNVERIFIED 与「源数据无 evidence」都不拉低它"] = (t) => {
  const now = Date.now();
  const g = mkGraph([
    mkEdge({ id: "e1", evidence: { start: 10, end: 12 } }),
    mkEdge({ id: "e2", evidence: { start: 20, end: 21 }, intent: "bash(npm test)" }),
  ]);
  // OPTIONS / UNVERIFIED 的 `- eN "…"` 行本来就不带 seq（不含 `→`）——不能算进失败边的分母。
  g.edges.e7 = { id: "e7", from: "n2", to: null, intent: "试试另一条路", action: "grep(pattern=foo)", result: "untested", ts: now - 1000 };
  g.edges.e8 = { id: "e8", from: "n2", to: "n2", intent: "跑了但没外部信号", action: "bash(true)", result: "unverified", verify: { kind: "none", summary: "无" }, evidence: { start: 30, end: 31 }, ts: now - 1000 };
  for (const maxTokens of [500, 120]) {
    const r = renderLedger(g, { now, maxTokens });
    t.eq(
      r.provenanceCoverage,
      1,
      `maxTokens=${maxTokens} 时出处覆盖率必须是 1（掉下来说明渲染器在砍 seq）；实际 ${r.provenanceCoverage}`,
    );
  }
  // 数据缺口（老图没有 evidence）不是渲染器的锅：覆盖率仍算 1，但必须单独计数出来。
  const legacy = renderLedger(mkGraph([mkEdge({ id: "e1", evidence: null })]), { now, maxTokens: 2000 });
  t.eq(legacy.provenanceCoverage, 1, "源边没有 evidence 时不该算成「渲染砍出处」");
  t.eq(legacy.evidenceMissing, 1, "没有 evidence 的失败边必须被单独计数（数据缺口要可见）");
  // 真正的渲染回退：结构化口径下，本来有 evidence 的边却没印 seq ⇒ 覆盖率必须 <1
  t.eq(
    provenanceCoverageOf('- e1 "x" → boom\n', { e1: { id: "e1", evidence: { start: 1, end: 2 } } }),
    0,
    "有 evidence 的边没印 seq 时覆盖率必须掉到 0（指标真的能抓到渲染回退）",
  );
  t.eq(
    provenanceCoverageOf('- e1 "x" → boom (seq 1-2)\n', { e1: { id: "e1", evidence: { start: 1, end: 2 } } }),
    1,
    "正常行必须是 1",
  );
};

tests["M 重访过的状态在路径里标 ×N（图结构事实，不是行动建议）"] = (t) => {
  const now = Date.now();
  const g = mkGraph([mkEdge({ id: "e1", evidence: { start: 10, end: 12 } })]);
  // currentPath 沿 node.via 回溯 —— 夹具里 n2 必须挂到 e1 上，路径行才会渲染
  g.nodes.n2.via = "e1";
  const plain = renderLedger(g, { now, maxTokens: 2000 }).text;
  t.notIncludes(plain, "×", "没有重访的会话不许出现 ×（零成本）");
  // transpositions=1 ⇒ 该状态被另一条路径再次到达 ⇒ 一共到过 2 次
  g.nodes.n2.transpositions = 1;
  const revisited = renderLedger(g, { now, maxTokens: 2000 }).text;
  t.includes(revisited, "n2×2", "重访过的状态必须标出「到过几次」");
  t.notIncludes(revisited, "×1", "×N 的 N 是总到达次数，最小是 2（不许印 ×1）");
  // 边界：只陈述图结构事实，不许夹带行动建议
  t.notIncludes(revisited, "不要", "路径行不许给行动指令（那是 AGENTS/persona 的职责）");
  t.notIncludes(revisited, "建议", "路径行不许给建议");
};

tests["N 失败后来被同一 action 跑通 ⇒ 行内标 ↑later-ok:<边id>（事实，不是建议）"] = (t) => {
  const now = Date.now();
  const okLater = {
    id: "e2",
    from: "n2",
    to: "n2",
    intent: "再跑一次",
    action: "bash(npm test)",
    result: "success",
    verify: { kind: "exit", summary: "exit 0" },
    evidence: { start: 30, end: 31 },
    ts: now - 500,
  };
  const g = mkGraph([mkEdge({ id: "e1", evidence: { start: 10, end: 12 }, action: "bash(npm test)" }), okLater]);
  g.nodes.n2.via = "e1";
  const text = renderLedger(g, { now, maxTokens: 2000 }).text;
  t.includes(text, "↑later-ok:e2", "同一 action 后来成功了，必须标出来（否则模型以为路还堵着）");
  t.notIncludes(text, "建议", "只陈述事实，不许给行动建议");
  // 成功发生在失败之前 ⇒ 不是「后来解决」
  const g2 = mkGraph([
    mkEdge({ id: "e1", evidence: { start: 10, end: 12 }, action: "bash(npm test)" }),
    { ...okLater, id: "e0", evidence: { start: 1, end: 2 } },
  ]);
  g2.nodes.n2.via = "e1";
  t.notIncludes(renderLedger(g2, { now, maxTokens: 2000 }).text, "↑later-ok", "成功在失败之前不算解决");
  // 不同 action ⇒ 不是同一件事
  const g3 = mkGraph([
    mkEdge({ id: "e1", evidence: { start: 10, end: 12 }, action: "bash(npm test)" }),
    { ...okLater, action: "bash(npm lint)" },
  ]);
  g3.nodes.n2.via = "e1";
  t.notIncludes(renderLedger(g3, { now, maxTokens: 2000 }).text, "↑later-ok", "不同命令不能算同一件事");
};

tests["O 同一 action 失败过 k 次 ⇒ 标 ↻k（计数事实，不是「别重试」的指令）"] = (t) => {
  const now = Date.now();
  const action = "bash(npm test)";
  const g = mkGraph([
    mkEdge({ id: "e1", action, evidence: { start: 10, end: 12 } }),
    mkEdge({ id: "e2", action, evidence: { start: 20, end: 22 } }),
    mkEdge({ id: "e3", action: "bash(npm lint)", evidence: { start: 30, end: 32 } }),
  ]);
  g.nodes.n2.via = "e1";
  const text = renderLedger(g, { now, maxTokens: 2000 }).text;
  t.includes(text, "↻2", "同一条命令失败两次，必须标出次数（这是计数事实）");
  t.notIncludes(text, "↻1", "只失败一次不许印 ↻1（没有「反复」可言）");
  // 只在同 action 组里**最近的那条**上标（每条都标会白烧 token，计数是同一个数字）
  const occurrences = text.split("↻2").length - 1;
  t.eq(occurrences, 1, `重试计数只该出现 1 次（最近的 e2），实际 ${occurrences} 处`);
  // 边界：只给计数，不许变成行动指令
  t.notIncludes(text, "不要重试", "计数 ≠ 指令（行动建议归 AGENTS/persona）");
};

tests["#1 压缩无效（thrashing）状态要显示出来，但只在真的连续发生时"] = (t) => {
  const now = Date.now();
  const quiet = mkGraph([]);
  t.notIncludes(renderLedger(quiet, { now, maxTokens: 500 }).text, "未回收足够空间", "正常会话不该有这行（零成本）");

  const once = mkGraph([]);
  once.foldThrash = 1;
  t.notIncludes(renderLedger(once, { now, maxTokens: 500 }).text, "未回收足够空间", "只发生一次不算 thrashing");

  const twice = mkGraph([]);
  twice.foldThrash = 2;
  const text = renderLedger(twice, { now, maxTokens: 500 }).text;
  t.includes(text, "未回收足够空间", "连续 2 次必须显示（学 Claude Code 的 Autocompact is thrashing）");
  t.includes(text, "连续 2 次", "要写明连续几次，便于判断严重程度");
  t.notIncludes(text, "不要", "只陈述状态，不给行动指令（边界）");
};

tests["#4 重注入契约：根目标/约束/失败边/OPTIONS/未验证/出处 一项都不能少"] = (t) => {
  // 这是「压缩后必须重灌什么」的机器判据（学 Claude Code 的 "What survives compaction" 表）。
  // 断言用的是**内容**而不是标题措辞，这样以后改标题不会误红，但删掉任何一类信息一定会红。
  const now = Date.now();
  const g = {
    version: 1,
    sessionId: "s",
    cwd: "E:/x",
    nextNode: 3,
    nextEdge: 4,
    order: ["n1", "n2"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "把测试跑绿", constraints: ["不要动 prod 配置"], ts: now - 5000 },
      n2: { id: "n2", kind: "agent", seq: 2, goal: "跑测试", ts: now - 4000 },
    },
    edges: {
      e1: {
        id: "e1", from: "n1", to: "n2",
        intent: "bash(npm test)", action: "bash(command=npm test)", result: "failure",
        errorSnippet: "ERROR: EACCES: permission denied, open '/x/config.json'",
        evidence: { start: 10, end: 12 }, ts: now - 3000,
      },
      e2: { id: "e2", from: "n2", to: null, result: "untested", intent: "换条路：grep 调用点", action: "grep(pattern=foo)", ts: now - 2000 },
      e3: {
        id: "e3", from: "n2", to: "n2",
        intent: "试试 rm -rf 清缓存", action: "bash(rm -rf cache)", result: "unverified",
        verify: { kind: "none", summary: "无外部信号" }, evidence: { start: 20, end: 21 }, ts: now - 1000,
      },
    },
    // 注意：不要写 `rootNode: "n1"` —— ledger 读的是 `g.rootNode?.text`，生产图里根本没有这个字段
    // （只有 rootUserNodeIds），传 id 会让 ROOT USER 行渲染成空。
    rootUserNodeIds: ["n1"],
  };
  const text = renderLedger(g, { now, maxTokens: 2000 }).text;
  t.includes(text, "把测试跑绿", "① 根目标必须重灌");
  t.includes(text, "不要动 prod 配置", "② 约束必须重灌");
  t.includes(text, "EACCES", "③ 失败边的原因必须重灌");
  t.includes(text, "grep", "④ OPTIONS 必须重灌");
  t.includes(text, "rm -rf", "⑤ UNVERIFIED 必须重灌");
  t.includes(text, "(seq ", "⑥ 出处（seq）必须重灌");
};

/* ───────────── 候选 #3：省略行必须「能查到」（2026-11-01，调研 03 §E「取不到 = 真没了」） ─────────────
 *
 * 判据：模型看到「有东西被省掉了」之后，必须能拿到**可解析的位置**（相对路径 + 节点区间），
 * 否则它只能猜，或者把「没列出来」误当成「不存在」。
 * 同时不允许泄漏绝对路径（P6a：会带出本机用户名/盘符，且白烧 token）。
 */

const ABS_TREE = "D:\\DeepSeek Harness\\home\\chess-context\\sessions\\sess-abc";

tests["J 热清单省略行：给出相对化的可解析位置，绝不泄漏绝对路径"] = (t) => {
  const now = Date.now();
  const edges = [10, 20, 30].map((seq, i) => mkEdge({ id: `e${i + 1}`, evidence: { start: seq, end: seq + 1 } }));
  const g = mkGraph(edges);
  // 省略行只在 L4/L5 出现：用 120 预算 + tailFailures=1 压到 L4（3 条失败边、只列最近 1 条）。
  const withDir = renderLedger(g, { now, maxTokens: 120, tailFailures: 1, treeDir: ABS_TREE, traceRoot: "sessions" });
  t.includes(withDir.text, "omitted for budget", "有边被省略时必须出现省略行（沉默 = 断言没有）");
  t.includes(withDir.text, "sessions/sess-abc/graph.json", "省略行必须给出可解析的位置（相对化）");
  t.includes(withDir.text, "nodes/<id>.md", "还要给出逐节点文件的取法");
  t.notIncludes(withDir.text, "D:\\DeepSeek Harness", "不许把绝对路径写进热清单");
  const bare = renderLedger(g, { now, maxTokens: 120, tailFailures: 1 });
  t.includes(bare.text, "graph.json", "没有 treeDir 时也必须留一个可解析指向（不许只剩泛称）");
};

tests["K 摘要事实块省略行：同样带可解析位置（相对路径 + 区间）"] = (t) => {
  const edges = [1, 2, 3, 4, 5].map((seq) => mkEdge({ id: `e${seq}`, evidence: { start: seq, end: seq } }));
  const g = mkGraph(edges);
  const facts = renderFacts(g, { maxFailures: 2, headFailures: 1, treeDir: ABS_TREE, traceRoot: "sessions" });
  t.includes(facts, "FAILED_ATTEMPTS_OMITTED", "极端规模下必须显式声明「有失败边没列」");
  t.includes(facts, "sessions/sess-abc/graph.json", "省略行必须给出去哪查（相对化）");
  t.notIncludes(facts, "D:\\DeepSeek Harness", "摘要事实块同样不许泄漏绝对路径");
  const bare = renderFacts(g, { maxFailures: 2, headFailures: 1 });
  t.includes(bare, "graph.json", "无 treeDir 时退化为 graph.json，但仍有指向");
  t.includes(bare, "do not invent", "原有的「不许编造/合并」保真语义不能丢");
};

tests["L 分项占用：sections 覆盖七段 + total，单位是字符不是 token"] = (t) => {
  // 为什么要有（2026-11-01）：做「分项预算」之前必须先知道钱花在哪一段。
  // 这条测试同时钉死一个踩过的坑：sections 是**字符数**，不能拿 renderLedger().tokens 当分母
  //（单位不同，实测会算出 238% 的失败边占比）。
  const now = Date.now();
  const g = mkGraph([
    mkEdge({ id: "e1", evidence: { start: 10, end: 12 } }),
    mkEdge({ id: "e2", evidence: { start: 20, end: 21 } }),
  ]);
  g.nodes.n1.constraints = ["不要动 prod 配置"];
  const r = renderLedger(g, { now, maxTokens: 2000 });
  const s = r.sections;
  for (const key of ["root", "constraints", "failures", "options", "unverified", "path", "other"]) {
    t.eq(typeof s[key], "number", `sections.${key} 必须是数字`);
  }
  t.eq(typeof s.total, "number", "sections.total 必须是数字（算占比的分母）");
  t.ok(s.total >= s.failures, "total 必须 >= 任一分段（它是各段之和）");
  t.ok(s.failures > 0, "有失败边的图里 failures 段必须 > 0");
  t.ok(s.constraints > 0, "有约束的图里 constraints 段必须 > 0");
};
