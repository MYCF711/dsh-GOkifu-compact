/**
 * test/c17-path-at-every-level.test.mjs —— C-17：路径行按档位**变省**，而不是 L3+ 直接消失
 *
 * 背景（2026-10-30，实测）：
 *   S2a 给会话加了 `WORKING: …` 行（+28~46 tokens），3 个会话因此从 L2 掉到 L3，
 *   而 1.9.1 的渲染链写的是 `path.length > 1 && level <= 2` —— L3 起整个路径段不渲染。
 *   于是「为了显示工作路径」反而让**路径连同工作位置一起消失**：
 *     session-569f9cd0：L2=453 → L3=376，WORKING 无
 *     session-8bfe7040：L2=438 → L3=356，WORKING 无
 *     session-e02194c6：L2=489 → L3=394，WORKING 无
 *
 * 修法（只改 renderLedger 的路径段，不新增配置键、不动预算、不动档位语义）：
 *   · L0–L2 `full` —— 与 1.9.1 **逐字相同**；
 *   · L3      `head` —— 路径保留头 3 + 尾 3，中间折叠成 `… +N`；
 *   · L4/L5   `n1`   —— 只留当前位置 + 一行 `# path:` 说明。
 *   任何形态都必须含**最后一个节点**（当前位置）；`[weak k/n]` 与图例不许省。
 *
 * 这一组测试锁的就是上面每一句：档位映射、逐字不变、折叠可逆（节点不伪造）、不塌方、
 * 预算上限、无工作路径时的退化、markers:off 不省安全标记、与 S2a weak 标识共存。
 */

import { createGraph, addUserNodeId, addEdge, settleEdge, addAgentNode } from "./graph-fixtures.mjs";
import { renderLedger, estimateTokens } from "../src/ledger.mjs";

export const tests = {};

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** 一条成功链：user → n2 → … → n(hops+1)，每跳一条 exit 0 的成功边。 */
function chainGraph({ hops = 6, sessionId = "c17-chain", rootText = "把构建跑通。" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: rootText }); // addUserNodeId 返回 id 字符串
  let cursor = u;
  const ids = [u];
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    ids.push(node);
    cursor = node;
  }
  return { g, ids };
}

/** 只有弱锚点（S2a）：user → n2 一条只读弱成功边 + 若干失败边。 */
function weakOnlyGraph({ failures = 10, sessionId = "c17-weak" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "看下这个仓库怎么跑。" });
  const e1 = addEdge(g, { from: u, intent: "先看一眼 README", action: "read(file_path=README.md)" });
  const n2 = addAgentNode(g, { seq: 3, goal: "读过 README", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  g.edges[e1].to = n2;
  settleEdge(g, e1, { result: "unverified", weak: "read", verify: { kind: "read", summary: "1234 chars" } });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次试跑`, action: `bash(npm test ${i})` });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42` });
  }
  return { g, u, n2 };
}

/** 一条很长的中文根目标 —— 复现「大图把预算吃光」的形态（真实库里的 5 个 L5 超限图同型）。 */
function fatRootGraph({ hops = 6, constraints = 10, sessionId = "c17-fat" } = {}) {
  const long = "你是并行工作流 WS-C17 的执行子代理，仓库在主工作区里，已有大量未提交改动必须保留。".repeat(6);
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: `${long}\n\n约束：${Array.from({ length: 4 }, (_, i) => `第${i + 1}条必须遵守的约束，不许删掉。`).join(" ")}` });
  let cursor = u;
  const ids = [u];
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    ids.push(node);
    cursor = node;
  }
  for (let i = 0; i < constraints; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个写法`, action: `bash(npm test ${i})` });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42` });
  }
  return { g, ids };
}

const line = (text, prefix) => text.split("\n").find((l) => l.startsWith(prefix)) ?? null;

/**
 * 从 `CURRENT PATH: A(user) → n2 → … +5 → n9 → n10` 这样的行里取出所有节点 id。
 *
 * ★ 2026-10-30 修（C17 收尾）：旧实现是 `slice(prefix.length + 2)` —— 前缀后面只有**一个**空格，
 *   多切一个字符会把首个 id 咬掉一半（实测 "user" 变成 "ser"，C17-11 因此报
 *   「显示序列不是真实链的子序列：ser,n21 (exit 0)」）。同时行尾的 ` (exit 0)` /
 *   ` (working edge e74)` / `(user)` 后缀要剥掉，否则尾部 id 永远对不上。
 */
function idsIn(pathLine, prefix) {
  const body = pathLine.slice(prefix.length).trimStart();
  return body
    .split(" → ")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("…"))
    .map((s) => s.replace(/\(.*\)$/, "").trim())
    .filter(Boolean);
}

/**
 * 在预算上扫描，返回**恰好落在 target 档**的那次渲染。
 *
 * 为什么不写死预算：档位是「渲染结果装不装得下」反推出来的，夹具改一个字档位就会漂 ——
 * 实测 C17-2 原本假设「12 跳 + 10 条失败边 ⇒ 预算 500 必然 L3」，实际落在 L2/308：
 * C-17 修好「路径行不再被整块丢掉」之后，同一份内容反而更小。扫描让断言与预算解耦。
 */
function renderAtLevel(g, target, opts = {}) {
  const full = renderLedger(g, { maxTokens: 1e9, ...opts }).tokens;
  for (let budget = Math.max(full, 1); budget >= 1; budget -= 1) {
    const r = renderLedger(g, { maxTokens: budget, ...opts });
    if (r.level === target) return { ...r, budget };
  }
  throw new Error(`预算扫描没有找到 L${target}（full=${full}）`);
}

/** 可被预算逼出来的档位集合（给「L0–L2 里能测到几档」这类断言用）。 */
function levelsReachable(g) {
  const seen = new Set();
  const full = renderLedger(g, { maxTokens: 1e9 }).tokens;
  for (let budget = Math.max(full, 1); budget >= 1; budget -= 1) {
    seen.add(renderLedger(g, { maxTokens: budget }).level);
  }
  return seen;
}

/**
 * 成功链 + K 条**会推进节点**的失败边 ⇒ 当前路径 ≠ 工作路径，两条行同时出现。
 * `chainGraph` 是「当前路径 === 工作路径」，1.9.1 在那种图上只印 WORKING 一行 ——
 * 想测 CURRENT PATH 就必须用这个夹具，否则断言的是旧版根本不存在的行。
 */
function mixedGraph({ hops = 12, failures = 12, sessionId = "c17-mixed" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。" });
  let cursor = u;
  const pathIds = [u];
  for (let i = 0; i < hops; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    pathIds.push(node);
    cursor = node;
  }
  const workingIds = [...pathIds];
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 次`, action: `bash(npm test ${i})` });
    const node = addAgentNode(g, { seq: 2000 + i, goal: `try${i}`, worldHash: `WF${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, {
      result: "failure",
      verify: { kind: "exit", summary: "exit 1" },
      errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42`,
    });
    pathIds.push(node);
    cursor = node;
  }
  return { g, pathIds, workingIds };
}

/**
 * 「工作路径尾 === 当前路径尾」但两条路径**不等**的形态（真实 session-569f9cd0 就是它）：
 * 一条 success 边的 `to` 是 user 节点 ⇒ currentPath 走到 user 就停住，working 链却继续往回走。
 * 旧代码把 WORKING 并进 CURRENT PATH 之后仍然执行 `${folded.workingLine}`，
 * 实测输出一行字面量 `null [weak 1/1]`（既印了 null，又把工作位置藏了）。
 */
function mergedTailGraph({ sessionId = "c17-merged" } = {}) {
  const g = createGraph({ sessionId });
  const u1 = addUserNodeId(g, { seq: 1, text: "先看现状。" });
  const e1 = addEdge(g, { from: u1, intent: "第一步", action: "bash(ls)" });
  const a1 = addAgentNode(g, { seq: 3, goal: "第一步", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  g.edges[e1].to = a1;
  settleEdge(g, e1, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e2 = addEdge(g, { from: a1, intent: "用户补充约束", action: "user(msg)" });
  const u2 = addUserNodeId(g, { seq: 4, text: "再补一句：别动 prod。" });
  g.edges[e2].to = u2;
  settleEdge(g, e2, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e3 = addEdge(g, { from: u2, intent: "继续", action: "bash(npm test)" });
  const a2 = addAgentNode(g, { seq: 6, goal: "继续", worldHash: "W2", constraintHash: "C1", via: e3 }).id;
  g.edges[e3].to = a2;
  settleEdge(g, e3, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return { g, pathIds: [u2, a2], workingIds: [u1, a1, u2, a2] };
}

/* ─────────────────────────── 1. 档位 → 形态 ─────────────────────────── */

tests["C17-1 L0/L1/L2 的路径行与旧版逐字相同（不放宽也不改格式）"] = () => {
  // (a) 当前路径 === 工作路径：1.9.1 只印 WORKING 一行（C-17 不改这个；否则每个会话白白多一整条重复路径）
  const same = chainGraph({ hops: 6 });
  const sameFull = `WORKING: ${same.ids.map((id) => (same.g.nodes[id]?.kind === "user" ? "user" : id)).join(" → ")} (exit 0)`;
  let checked = 0;
  for (const level of [0, 1, 2]) {
    if (!levelsReachable(same.g).has(level)) continue;
    const r = renderAtLevel(same.g, level);
    checked += 1;
    if (!r.text.includes(sameFull)) throw new Error(`L${level} 的 WORKING 不是旧格式：\n${r.text}`);
    if (line(r.text, "CURRENT PATH:")) {
      throw new Error(`1.9.1 在「当前路径===工作路径」时不印 CURRENT PATH（C-17 不许改成重复两行），L${level} 却印了：\n${r.text}`);
    }
  }
  if (checked === 0) throw new Error("没有任何一档被预算逼出来（夹具不适用）");

  // (b) 当前路径 ≠ 工作路径：两行都印，且 L0–L2 都是全量（一个字符都不折）
  const mixed = mixedGraph({ hops: 6, failures: 3 });
  const fullCur = `CURRENT PATH: ${mixed.pathIds.map((id) => `${id}${mixed.g.nodes[id]?.kind === "user" ? "(user)" : ""}`).join(" → ")}`;
  const fullWork = `WORKING: ${mixed.workingIds.map((id) => (mixed.g.nodes[id]?.kind === "user" ? "user" : id)).join(" → ")} (exit 0)`;
  let checkedMixed = 0;
  for (const level of [0, 1, 2]) {
    if (!levelsReachable(mixed.g).has(level)) continue;
    const r = renderAtLevel(mixed.g, level);
    checkedMixed += 1;
    if (!r.text.includes(fullCur)) throw new Error(`L${level} 的 CURRENT PATH 不是全量旧格式：\n${r.text}`);
    if (!r.text.includes(fullWork)) throw new Error(`L${level} 的 WORKING 不是全量旧格式：\n${r.text}`);
    if (r.text.includes("… +")) throw new Error(`L${level} 不该折叠（L0–L2 与 1.9.1 逐字相同）：\n${r.text}`);
  }
  if (checkedMixed === 0) throw new Error("混合夹具没有任何一档被预算逼出来");
};

tests["C17-2 预算紧张时路径行折叠而不是消失（折叠必须真的省字）"] = () => {
  // 47 个节点的当前路径 + 41 个节点的工作路径，在 L3（预算 388）下**装不下全量** ⇒ 必须折，
  // 但**不许整块消失**（旧版 `path.length > 1 && level <= 2` 在这里一行都不印 —— C-17 要修的就是这个）。
  // 夹具用 hops=40/failures=6：这是实测能在预算扫描里稳定命中 L3 的形态。
  const { g, pathIds } = mixedGraph({ hops: 40, failures: 6, sessionId: "c17-l3" });
  const fullLen = `CURRENT PATH: ${pathIds.map((id) => `${id}${g.nodes[id]?.kind === "user" ? "(user)" : ""}`).join(" → ")}`.length;
  const r = renderLedger(g, { maxTokens: 388 });
  if (r.level < 3) throw new Error(`夹具应落在 L3+（降级档），实际 L${r.level} (${r.tokens} tokens)`);
  const cur = line(r.text, "CURRENT PATH:");
  const work = line(r.text, "WORKING:");
  if (!cur) throw new Error(`L${r.level} 丢了 CURRENT PATH：
${r.text}`);
  if (!work) throw new Error(`L${r.level} 丢了 WORKING：
${r.text}`);
  if (!cur.includes("… +")) throw new Error(`L${r.level} 的 CURRENT PATH 没有折叠：${cur}`);
  if (!work.includes("… +")) throw new Error(`L${r.level} 的 WORKING 没有折叠：${work}`);
  // 折叠后的行必须明显短于全量行（不是「折了但还是那么长」）
  if (cur.length > fullLen * 0.8) throw new Error(`折叠没省下多少：${cur.length} vs 全量 ${fullLen}：${cur}`);
  // ★ rev6：路径行有**固定额度**（150 字符，含 weak 图例与后缀），不是「把剩余预算吃光」
  if (cur.length + work.length > 150) throw new Error(`路径行超出固定额度 150 字符：${cur.length + work.length}`);
};

tests["C17-3 折叠后的行不许丢头尾：起点（user）与当前位置必须在（折叠计数必须真实）"] = () => {
  const { g, pathIds } = mixedGraph({ hops: 40, failures: 6, sessionId: "c17-fold" });
  const r = renderLedger(g, { maxTokens: 388 });
  const cur = line(r.text, "CURRENT PATH:");
  if (!cur || !cur.includes("… +")) throw new Error(`L${r.level} 的长路径没有折叠：${cur}`);
  const shown = idsIn(cur, "CURRENT PATH:");
  if (shown[0] !== pathIds[0]) throw new Error(`丢了路径起点：${shown[0]} ≠ ${pathIds[0]}
${cur}`);
  if (shown.at(-1) !== pathIds.at(-1)) throw new Error(`丢了当前位置：${shown.at(-1)} ≠ ${pathIds.at(-1)}
${cur}`);
  // 折叠数必须与「真实节点数 - 显示节点数」相等（不许凭空造节点、不许瞎写数字）
  const claimed = Number(/(?:… \+)(\d+)/.exec(cur)?.[1] ?? NaN);
  if (!Number.isFinite(claimed)) throw new Error(`折叠计数缺失：${cur}`);
  if (claimed !== pathIds.length - shown.length) throw new Error(`折叠计数不对：声称 ${claimed}，实际省略 ${pathIds.length - shown.length}`);
  if (claimed < 1) throw new Error(`折叠数必须 ≥1（不许印「… +0」）：${cur}`);
  for (const id of shown) if (!g.nodes[id]) throw new Error(`路径行里出现了不存在的节点 ${id}`);
  // 显示序列必须是真实路径的**子序列**（不伪造、不重排）
  let at = 0;
  for (const id of shown) {
    const found = pathIds.indexOf(id, at);
    if (found < 0) throw new Error(`显示序列不是真实路径的子序列：${shown.join(",")} @ ${id}`);
    at = found + 1;
  }
};

tests["C17-4 L5 兜底档也保留当前位置（不许把路径整块吞掉）"] = () => {
  const { g, pathIds, workingIds } = mixedGraph({ hops: 40, failures: 6, sessionId: "c17-l5" });
  const r = renderLedger(g, { maxTokens: 243 });
  if (r.level !== 5) throw new Error(`夹具应落到 L5，实际 L${r.level} (${r.tokens})`);
  const current = pathIds.at(-1);
  // L5 兜底把 CURRENT PATH 折成 `# path:` 摘要行 —— 行首不再是 "CURRENT PATH:"，而是 "# path:"
  const digest = line(r.text, "# path:");
  if (!digest) throw new Error(`L5 缺 # path: 摘要行（模型要知道路径被省过）：
${r.text}`);
  if (!digest.includes(current)) throw new Error(`L5 的 # path: 不含当前位置 ${current}：${digest}`);
  if (!digest.includes("current:")) throw new Error(`L5 的 # path: 必须明写 current，否则模型不知道哪个是当前位置：${digest}`);
  const work = line(r.text, "WORKING:");
  if (!work) throw new Error(`L5 丢了 WORKING：
${r.text}`);
  if (!work.includes("… +")) throw new Error(`L5 的 WORKING 应折叠：${work}`);
  if (idsIn(work, "WORKING:").at(-1) !== workingIds.at(-1)) {
    throw new Error(`L5 的 WORKING 丢了尾部（工作位置 ${workingIds.at(-1)}）：${work}`);
  }
  // 连摘要都放不下时，必须退到**一行**最小形态（current id 仍在），绝不允许整块消失
  const tiny = renderLedger(g, { maxTokens: 60 });
  const tinyLine = line(tiny.text, "# path:");
  if (!tinyLine) throw new Error(`L${tiny.level} 连最小路径行都没有（静默省略）：
${tiny.text}`);
  if (!tinyLine.includes(current)) throw new Error(`最小路径行丢了当前位置 ${current}：${tinyLine}`);
};

/* ─────────────────────── 2. 预算与既有语义 ─────────────────────── */

tests["C17-5 预算上限：500 预算下，失败边 ≤20 条的会话必须装进去（含路径行）"] = () => {
  // 12 跳 + 10 条失败边：这就是「不该超预算」的常规形态
  const g = createGraph({ sessionId: "c17-budget" });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通，别动 prod。" });
  let cursor = u;
  for (let i = 0; i < 12; i += 1) {
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 步`, action: `bash(step${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `step ${i + 1}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    cursor = node;
  }
  for (let i = 0; i < 10; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次：换个写法`, action: `bash(npm test ${i})` });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: case${i} expected 1 got 2 at tests/case${i}.test.js:42` });
  }
  const r = renderLedger(g, { maxTokens: 500 });
  if (r.tokens > 500) throw new Error(`超预算：${r.tokens} tokens（预算 500）`);
  if (!line(r.text, "WORKING:")) throw new Error(`预算内但没有 WORKING：\n${r.text}`);
  // 失败边一条不少
  if (r.shownFailures !== 10) throw new Error(`失败边展示 ${r.shownFailures}，应为 10`);
  if (!r.text.includes("LEARNED (10 failed attempts")) throw new Error("失败边总数丢了");
};

tests["C17-6 L1–L5 档位语义不变：档位越高越省（tokens 单调不增）"] = () => {
  const { g } = fatRootGraph({ hops: 20, constraints: 12, sessionId: "c17-monotone" });
  let prev = Infinity;
  const seen = [];
  let budget = 1e9;
  for (let i = 0; i < 8; i += 1) {
    const r = renderLedger(g, { maxTokens: budget });
    seen.push(`L${r.level}=${r.tokens}`);
    if (r.tokens > prev) throw new Error(`档位上移后 tokens 反而变多：${seen.join(" ")}`);
    prev = r.tokens;
    if (r.level >= 5 || r.tokens <= 1) break;
    budget = r.tokens - 1;
  }
  if (seen.length < 3) throw new Error(`没有测到多档：${seen.join(" ")}`);
};

tests["C17-7 markers:off 不省掉路径（标记档位与路径档位互不影响）"] = () => {
  // 当前路径 ≠ 工作路径的夹具：两行本来就都该出现，markers:off 不许动它们
  const { g } = mixedGraph({ hops: 40, failures: 6, sessionId: "c17-off" });
  // 档位用 renderAtLevel 扫描：markers:off 会让同一预算的 tokens 变少，写死 388 会掉到 L1。
  const off = renderAtLevel(g, 3, { markers: "off" });
  if (off.level !== 3) throw new Error(`夹具应落在 L3，实际 L${off.level}`);
  if (!line(off.text, "CURRENT PATH:")) throw new Error(`markers:off 掉了路径：
${off.text}`);
  if (!line(off.text, "WORKING:")) throw new Error(`markers:off 掉了 WORKING：
${off.text}`);
  if (off.text.includes("[blocked")) throw new Error("markers:off 却仍有标记");
  if (off.text.includes("# markers:")) throw new Error("markers:off 却仍有标记图例");
  // 同一夹具带标记时必须**有**图例（证明上面的 notIncludes 不是「本来就没有」的假绿）
  const on = renderLedger(g, { maxTokens: 388 });
  if (!on.text.includes("# markers:")) throw new Error(`带标记时应有图例，否则 markers:off 的断言没有对照：
${on.text}`);
};

tests["C17-8 没有工作路径时的退化：L3+ 说清「没有」，L0–L2 维持旧行为（不出这一行）"] = () => {
  const g = createGraph({ sessionId: "c17-nopath" });
  const u = addUserNodeId(g, { seq: 1, text: "把构建跑通。" });
  let cursor = u;
  for (let i = 0; i < 14; i += 1) {
    // 全部失败边照常推进节点（to 有效）—— 但**没有任何**成功/弱成功边 ⇒ 没有工作路径
    const e = addEdge(g, { from: cursor, intent: `第 ${i + 1} 次`, action: `bash(npm test ${i})` });
    const node = addAgentNode(g, { seq: 3 + i * 2, goal: `try ${i}`, worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = node;
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "EACCES: permission denied" });
    cursor = node;
  }
  const r = renderLedger(g, { maxTokens: 500 });
  if (r.level !== 3) throw new Error(`夹具应落在 L3，实际 L${r.level}`);
  const none = line(r.text, "# WORKING:");
  if (!none) throw new Error(`L3 没有工作路径时应给一行说明：\n${r.text}`);
  if (!none.includes("none")) throw new Error(`说明文案不对：${none}`);
  if (line(r.text, "WORKING: ")) throw new Error(`没有工作路径却印了 WORKING: 行：\n${r.text}`);
  // L0 不变：没有 WORKING、也没有 # WORKING 说明
  const l0 = renderLedger(g, { maxTokens: 1e9 });
  if (l0.level !== 0) throw new Error(`应得 L0，实际 L${l0.level}`);
  if (l0.text.includes("# WORKING:")) throw new Error(`L0 多了旧版没有的 # WORKING 行：\n${l0.text}`);
  if (line(l0.text, "WORKING: ")) throw new Error("L0 没有工作路径却印了 WORKING");
};

tests["C17-9 与 S2a 共存：降级档折叠路径后 [weak k/n] 与其图例仍在，且不出伪造的验证摘要"] = () => {
  const { g } = weakOnlyGraph({ failures: 12 });
  const r = renderAtLevel(g, 3); // 档位由预算反推，不写死预算（写死过一次，夹具一改就漂）
  const work = line(r.text, "WORKING:");
  if (!work) throw new Error(`L3 丢了弱 WORKING：\n${r.text}`);
  if (!work.includes("[weak 1/1]")) throw new Error(`弱标记被折叠掉了：${work}`);
  if (!r.text.includes("# weak k/n =")) throw new Error(`弱图例被折叠掉了：\n${r.text}`);
  if (work.includes("chars")) throw new Error(`弱边不许出验证摘要：${work}`);
  // 图例必须与 WORKING 行同在一份清单里（不依赖档位）
  const idx = r.text.indexOf("# weak k/n =");
  if (idx < 0) throw new Error("图例缺席");
};

tests["C17-10 与 S2a 共存：L0–L2 的弱 WORKING 明文与 1.9.1+S2a 定稿一致（C-17 不动它）"] = () => {
  const { g } = weakOnlyGraph({ failures: 2 });
  const r = renderLedger(g, { maxTokens: 1e9 });
  if (r.level !== 0) throw new Error(`应得 L0，实际 L${r.level}`);
  if (!r.text.includes("WORKING: user → n2 [weak 1/1]")) throw new Error(`L0 的弱 WORKING 明文变了：\n${r.text}`);
  if (!r.text.includes("# weak k/n =")) throw new Error("L0 缺弱图例");
};

tests["C17-11 折叠不伪造：降级档的 WORKING 仍是真实节点序列的子序列"] = () => {
  const { g, ids } = chainGraph({ hops: 20, sessionId: "c17-subseq" });
  const r = renderLedger(g, { maxTokens: 60 });
  const work = line(r.text, "WORKING:");
  if (!work) throw new Error(`L${r.level} 丢了 WORKING：
${r.text}`);
  if (!work.includes("… +")) throw new Error(`L${r.level} 的 WORKING 应折叠：${work}`);
  const shown = idsIn(work, "WORKING:").map((id) => (id === "user" ? ids[0] : id));
  let at = 0;
  for (const id of shown) {
    const found = ids.indexOf(id, at);
    if (found < 0) throw new Error(`显示序列不是真实链的子序列：${shown.join(",")} @ ${id}
${work}`);
    at = found + 1;
  }
  if (shown.at(-1) !== ids.at(-1)) throw new Error(`WORKING 丢了尾部节点 ${ids.at(-1)}：${work}`);
  // 折叠计数必须与真实省略数一致
  const claimed = Number(/(?:… \+)(\d+)/.exec(work)?.[1] ?? NaN);
  if (!Number.isFinite(claimed)) throw new Error(`折叠计数缺失：${work}`);
  if (claimed !== ids.length - shown.length) throw new Error(`折叠计数不对：声称 ${claimed}，实际省略 ${ids.length - shown.length}`);
};

tests["C17-12 旧形态回归：只有 2 个节点的路径（缩短折叠不会印「… +0」）"] = () => {
  const { g } = chainGraph({ hops: 1, sessionId: "c17-short" });
  for (const budget of [1e9, 1]) {
    const r = renderLedger(g, { maxTokens: budget });
    const oneLine = line(r.text, "CURRENT PATH:") ?? line(r.text, "WORKING:");
    if (r.text.includes("… +0")) throw new Error(`折叠数写成 0 了：\n${r.text}`);
    if (oneLine && oneLine.includes("…")) throw new Error(`两条节点的路径不该折叠：${oneLine}`);
  }
};

tests["C17-13 estimateTokens 与预算判定：折叠后的文本确实被算小了（不是靠放宽预算通过）"] = () => {
  // ★ 用**有失败边**的夹具：没有失败边时 L3/L4/L5 的正文几乎相同，pickFallback 会选最早的那档（L3），
  //   「预算 1 ⇒ L5」根本不成立（实测：chainGraph 无失败边时预算 1 落在 L3/40）。有失败边时
  //   L5 只列 10 条、L3 要列全量 ⇒ 兜底档才是真的更省。
  const { g } = mixedGraph({ hops: 12, failures: 12, sessionId: "c17-est" });
  const full = renderLedger(g, { maxTokens: 1e9 });
  const r = renderLedger(g, { maxTokens: 1 });
  if (estimateTokens(r.text) !== r.tokens) throw new Error("tokens 与 estimateTokens 不一致");
  if (r.level !== 5) throw new Error(`预算 1 必须落到兜底档 L5，实际 L${r.level}`);
  if (r.tokens >= full.tokens) throw new Error(`兜底档没有变省：L5=${r.tokens} vs 全量=${full.tokens}`);
};

/* ───────────────── 4. C17 收尾修掉的两个缺陷的回归（2026-10-30） ───────────────── */

tests["C17-14 合并形态不许印出字面量 null（真实 session-569f9cd0 的形态）"] = () => {
  // 工作路径尾 === 当前路径尾的形态（真实 session-569f9cd0）：旧代码在这条路径上输出过字面量
  // `null [weak 1/1]`。现在 L3+ **优先分开写**（显式 WORKING），预算不够才允许合并且把
  // `(working edge …)` 标记保在 CURRENT PATH 上。
  const { g } = mergedTailGraph();
  for (const budget of [1e9, 500, 388, 100, 60, 1]) {
    const r = renderLedger(g, { maxTokens: budget });
    for (const bad of ["\nnull", "null [", "\nundefined", "undefined "]) {
      if (r.text.includes(bad)) throw new Error(`预算 ${budget} 的清单里出现字面量 ${JSON.stringify(bad.trim())}：\n${r.text}`);
    }
    // 任何档位都必须有路径信息（不许静默省略）
    const hasPath = ["CURRENT PATH:", "WORKING:", "# path:", "# WORKING:"].some((p) => line(r.text, p));
    if (!hasPath) throw new Error(`预算 ${budget}（L${r.level}）没有任何路径行：\n${r.text}`);
  }
  // 宽松预算（L0）必须是显式 WORKING 行 + CURRENT PATH 两行（1.9.1 语义，不合并）
  const loose = renderLedger(g, { maxTokens: 1e9 });
  if (!line(loose.text, "WORKING:")) throw new Error(`L0 缺显式 WORKING 行：\n${loose.text}`);
};

tests["C17-15 只有 WORKING 的形态（当前路径===工作路径）在降级档不许抛 TypeError"] = () => {
  // 回归：fitPaths 曾经在 `curIds === null`（foldPaths 省掉了 CURRENT PATH）时落进读取
  // `curIds.length` 的分支 ⇒ `TypeError: Cannot read properties of null (reading 'length')`，
  // 全量测试 C17-11/12/13 三红、runner 只打印到崩溃点。
  // ★ 现在降级档允许退到一行最小形态 `# path: <current>`，所以断言的是「有路径信息」而不是「必须有 WORKING:」。
  for (const hops of [1, 2, 20]) {
    const { g, ids } = chainGraph({ hops, sessionId: `c17-only-work-${hops}` });
    for (const budget of [1e9, 500, 100, 60, 10, 1]) {
      const r = renderLedger(g, { maxTokens: budget }); // 抛错就是失败
      const hasPath =
        Boolean(line(r.text, "WORKING:")) || Boolean(line(r.text, "CURRENT PATH:")) || Boolean(line(r.text, "# path:")) || Boolean(line(r.text, "# WORKING:"));
      if (!hasPath) throw new Error(`hops=${hops} 预算=${budget}：路径信息整块消失（静默省略）：\n${r.text}`);
      // 当前位置必须在（要么在 WORKING 尾部，要么在 `# path:` 行里）
      const current = ids.at(-1);
      if (!r.text.includes(current)) throw new Error(`hops=${hops} 预算=${budget}：清单里找不到当前位置 ${current}：\n${r.text}`);
      if (r.text.includes("\nnull")) throw new Error(`hops=${hops} 预算=${budget}：出现字面量 null：\n${r.text}`);
    }
  }
};
