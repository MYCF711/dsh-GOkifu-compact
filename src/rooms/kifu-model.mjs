/**
 * graph.mjs —— 棋谱 DAG 的纯数据层
 *
 * 设计契约（写死，改动必须同步 test/core.test.mjs）：
 *   节点 = 状态（UserNode 原话 / AgentNode 目标 + 状态哈希）
 *   边   = 动作 + 结果（预想道路 → 执行 → 验证信号）
 *   置换 = 两条不同的入边指向同一个节点（stateKey 命中）
 *
 * 本模块零依赖（除 node:crypto），不触碰 DSH，可脱离宿主单测。
 */

import { createHash } from "node:crypto";

export const GRAPH_VERSION = 1;

/* ────────────────────────────── 基础 ────────────────────────────── */

export function sha(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 规范化文本：去首尾空白、压缩连续空白、统一换行。 */
export function norm(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 按「排序后的元素序列」算哈希 —— 与顺序无关的集合哈希。 */
export function hashSet(items) {
  const sorted = [...new Set(items.map((x) => norm(String(x))))].filter((x) => x.length > 0).sort();
  return sha(sorted.join("\u0000"));
}

/**
 * 把「哈希」收敛成字符串。worldstate.hash() 返回 { hash, mode, files }（含元数据），
 * 而节点字段的契约是字符串 —— 在边界统一归一化，兼容历史脏数据。
 */
export function hashText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.hash === "string") return value.hash;
  if (value === null || value === undefined) return "pending";
  return String(value);
}

export function createGraph({ sessionId, cwd = "" }) {
  const now = Date.now();
  return {
    version: GRAPH_VERSION,
    sessionId: String(sessionId ?? ""),
    cwd,
    createdAt: now,
    updatedAt: now,
    nextNode: 1,
    nextEdge: 1,
    nodes: {},          // id -> node
    edges: {},          // id -> edge
    order: [],          // 节点创建顺序（id 数组）
    stateIndex: {},     // stateKey -> 最早的 nodeId
    rootUserNodeIds: [],// 首个 user 节点（可多个：用户每次重申根目标会新建）
    checkpointSeq: null,// 最近一次 fold 产生的 checkpoint 消息 seq
    foldCount: 0,
    lastFoldTotalTokens: 0,
    foldMarks: [],      // 每次 fold 的 {at, seqStart, seqEnd, nodeIds, edgeIds}
    lastFoldUsage: null,// 最近一次摘要调用的真实 usage {inputTokens, outputTokens, provider, model, at}
  };
}

/* ────────────────────────────── 节点 ────────────────────────────── */

/**
 * 用户节点：原话逐字保存。★ 不可压缩、不可被后续节点覆盖（约束锚）。
 * @returns 新节点 id
 */
export function addUserNode(g, { seq, turn = null, text, constraints }) {
  const id = `n${g.nextNode++}`;
  g.nodes[id] = {
    id,
    kind: "user",
    seq,
    turn,
    text: String(text ?? ""),          // 逐字，不 norm
    constraints: Array.isArray(constraints) ? [...constraints] : extractConstraints(text),
    ts: Date.now(),
  };
  g.order.push(id);
  if (g.rootUserNodeIds.length === 0) g.rootUserNodeIds.push(id);
  g.updatedAt = Date.now();
  bumpRev(g);
  markNodeDirty(g, id);
  markOrderAppend(g, id);
  return id;
}

/**
 * Agent 节点：一个状态快照。
 * @returns { id, transposition: null | { nodeId, hops } }
 *   若 stateKey 命中已有节点，则**不新建节点**，只返回命中信息（图上只多一条边）。
 */
export function addAgentNode(g, { seq, turn = null, goal, worldHash, constraintHash, via = null }) {
  // ★ P0：哈希字段只存字符串。历史实机里 keeper 把 worldstate.hash() 的返回对象
  //   （{ hash, mode, files }）直接写了进来，导致 ledger 的 `.slice()` 崩溃。
  worldHash = hashText(worldHash);
  constraintHash = hashText(constraintHash);
  // 落账阶段还没有真实状态哈希（要 stat 文件，成本高）——先占位，fold 前回填。
  const pending = worldHash === "pending" || constraintHash === "pending";
  const key = `${worldHash}/${constraintHash}`;
  // ★ 2026-10-29 修复（自环，全库 60.9%）：置换只应命中**更早的**状态，
  //   绝不该命中本步的起点。`via` 边的 from 就是本步起点；命中它 = 原地打转，
  //   不是「殊途同归」。旧版无条件复用 ⇒ `step/end` 把边的 to 指回起点 ⇒ `from === to`，
  //   图坍缩成自环（a0d03648: 530 边 / 23 节点），并让 tewari 的 dead 判定 109/109 全错。
  const originId = via && g.edges[via] ? g.edges[via].from ?? null : null;
  if (!pending) {
    const existing = g.stateIndex[key];
    if (existing !== undefined && existing !== originId && g.nodes[existing]) {
      return { id: existing, transposition: { nodeId: existing, hops: hopsBetween(g, via, existing) } };
    }
  }
  const id = `n${g.nextNode++}`;
  g.nodes[id] = {
    id,
    kind: "agent",
    seq,
    turn,
    goal: norm(goal).slice(0, 400),
    worldHash,
    constraintHash,
    via,
    ts: Date.now(),
  };
  g.order.push(id);
  if (!pending) g.stateIndex[key] = id;
  g.updatedAt = Date.now();
  bumpRev(g);
  markNodeDirty(g, id);
  markOrderAppend(g, id);
  return { id, transposition: null };
}

/**
 * 置换合并：把 fromId 并进 intoId（两条不同的路到达同一状态）。
 * 语义：fromId 的入边改指向 intoId 并标 transposition；fromId 从图中移除。
 * @returns 被重定向的边 id 列表
 */
export function mergeNodeInto(g, fromId, intoId) {
  if (fromId === intoId || !g.nodes[fromId] || !g.nodes[intoId]) return [];
  const node = g.nodes[fromId];
  const redirected = new Set();
  // 先处理入边（via 指向的那条），再扫全部边 —— 否则 via 边可能晚于扫描才被指过来
  if (node.via && g.edges[node.via]) {
    g.edges[node.via].to = intoId;
    g.edges[node.via].transposition = true;
    redirected.add(node.via);
  }
  for (const edge of Object.values(g.edges)) {
    // 出边也要改：旧版只改 edge.to，合并非叶子节点后它的所有出边 from 会指向已删除节点。
    // 实测（真实会话 graph.json）155 条边里 115 条 from 悬空 —— 图结构被悄悄破坏。
    if (edge.from === fromId) edge.from = intoId;
    if (edge.to === fromId) {
      edge.to = intoId;
      edge.transposition = true;
      redirected.add(edge.id);
    }
  }
  // 目标节点被别的边指回来 → 记录一次置换事实（人读视图用）
  g.nodes[intoId].transpositions = (g.nodes[intoId].transpositions ?? 0) + 1;
  delete g.nodes[fromId];
  g.order = g.order.filter((id) => id !== fromId);
  for (const [key, value] of Object.entries(g.stateIndex)) if (value === fromId) delete g.stateIndex[key];
  g.updatedAt = Date.now();
  bumpRev(g);
  // P3：合并动了目标节点、被重定向的边，以及所有 from 改向的边
  markNodeDirty(g, intoId);
  markNodeDeleted(g, fromId);
  for (const edge of Object.values(g.edges)) {
    if (edge.from === intoId || edge.to === intoId) markEdgeDirty(g, edge.id);
  }
  for (const id of redirected) markEdgeDirty(g, id);
  return [...redirected];
}

/** 从 via 边回溯到目标节点经过的边数；找不到返回 null。 */
function hopsBetween(g, viaEdgeId, nodeId) {
  let cursor = viaEdgeId;
  let hops = 0;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const edge = g.edges[cursor];
    if (!edge) break;
    hops += 1;
    if (edge.from === nodeId) return hops;
    cursor = predecessorEdge(g, edge.from);
  }
  return null;
}

function predecessorEdge(g, nodeId) {
  if (!nodeId) return null;
  const node = g.nodes[nodeId];
  return node && node.kind === "agent" ? node.via ?? null : null;
}

/* ────────────────────────────── 边 ────────────────────────────── */

export function addEdge(g, { from, intent = "", action = "", evidence = null }) {
  const id = `e${g.nextEdge++}`;
  g.edges[id] = {
    id,
    from,
    to: null,
    intent: norm(intent).slice(0, 200),
    action: norm(action).slice(0, 240),
    result: "untested",       // untested | success | failure | unverified
    verify: { kind: "none", summary: "" },
    errorSnippet: "",
    evidence,
    transposition: false,
    ts: Date.now(),
  };
  g.updatedAt = Date.now();
  bumpRev(g);
  markEdgeDirty(g, id);
  return id;
}

/**
 * 结算一条边。
 *
 * `weak`（S2a, 2026-10-30）：只读工具的「弱成功」标记（当前只有 "read"）。
 * 它**不改 result**（仍是 unverified）—— 只给热清单的 WORKING 路径当锚点用。
 * 只有在值非空时写字段：非弱边保持磁盘上的旧形状（图 JSON 不因本切片多出 `weak: null`）。
 */
export function settleEdge(g, edgeId, { to = null, result, verify, errorSnippet = "", weak = null }) {
  const edge = g.edges[edgeId];
  if (!edge) throw new Error(`settleEdge: unknown edge ${edgeId}`);
  edge.to = to ?? edge.to;
  edge.result = result;
  edge.verify = verify ?? { kind: "none", summary: "" };
  edge.errorSnippet = String(errorSnippet ?? "").slice(0, 600);
  if (weak) edge.weak = weak;
  else delete edge.weak; // 重新结算成 success/failure 时清掉陈旧标记（弱成功只能挂在 unverified 上）
  if (to && edge.transposition === undefined) edge.transposition = false;
  g.updatedAt = Date.now();
  bumpRev(g);
  markEdgeDirty(g, edgeId);
  return edge;
}

/** 所有失败边（热上下文的核心资产），按创建顺序。 */
export function failureEdges(g) {
  return Object.values(g.edges)
    .filter((e) => e.result === "failure")
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** 未验证 / 未结算的边。 */
export function openEdges(g) {
  return Object.values(g.edges).filter((e) => e.result === "unverified" || e.result === "untested");
}

/** 沿 via 链回溯出当前主路径（节点数组，从根到当前）。 */
export function currentPath(g, nodeId) {
  const path = [];
  let id = nodeId;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = g.nodes[id];
    if (!node) break;
    path.push(node);
    if (node.kind === "user") break;
    const edge = node.via ? g.edges[node.via] : null;
    id = edge ? edge.from : null;
  }
  return path.reverse();
}

/** 图里最新的 agent 节点（= 当前状态）。 */
export function latestAgentNode(g) {
  for (let i = g.order.length - 1; i >= 0; i -= 1) {
    const node = g.nodes[g.order[i]];
    if (node && node.kind === "agent") return node;
  }
  return null;
}

/* ─────────────────────── 约束抽取（user 原话） ─────────────────────── */

const CONSTRAINT_RE =
  /(必须|不要|不能|不许|禁止|只能|一定要|务必|记得|注意|要求|永远|绝不|never|must|do not|don't|only|always|required?)/i;

/**
 * 从用户原话里抽约束句。逐字保留原句（只去首尾空白），保证差一个「必须/最好」也不失真。
 * @returns string[]
 */
export function extractConstraints(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const sentences = raw
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const picked = sentences.filter((s) => CONSTRAINT_RE.test(s));
  return picked.slice(0, 40);
}

/* ─────────────────────── 序列化 / 落盘视图 ─────────────────────── */

export function toJSON(g) {
  return JSON.stringify(g, null, 1);
}

export function fromJSON(text) {
  const obj = JSON.parse(text);
  if (obj.version !== GRAPH_VERSION) throw new Error(`graph: unsupported version ${obj.version}`);
  // ★ P0 历史数据修复：v1.3.4 及以前，keeper 把 worldstate.hash() 返回的
  //   { hash, mode, files } 对象直接写进了节点字段。这里在加载边界统一收敛成字符串，
  //   否则 ledger 的 `.slice()` 会抛 "latest?.worldHash?.slice is not a function"，
  //   整个压缩链路失败（实机 session-5acafe42：187 次该错误 / 226 次压缩仅 3 次成功）。
  let pendingConstraint = 0;
  for (const node of Object.values(obj.nodes ?? {})) {
    if (!node || node.kind !== "agent") continue;
    node.worldHash = hashText(node.worldHash);
    node.constraintHash = hashText(node.constraintHash);
    if (node.constraintHash === "pending") pendingConstraint += 1;
  }
  // ★ 第二处历史修复：旧版 st.constraints 从未赋值 ⇒ 所有节点 constraintHash 都是
  //   "pending" ⇒ stateIndex 永远为空、置换检测形同虚设（全库 1,440 节点只有 5 条索引）。
  //   按时序累积回填（节点创建时只看到它之前的约束），与运行期 constraintHashOf 的语义一致。
  if (pendingConstraint > 0) {
    const seen = [];
    for (const id of obj.order ?? []) {
      const n = obj.nodes?.[id];
      if (!n) continue;
      if (n.kind === "user" && Array.isArray(n.constraints)) {
        seen.push(...n.constraints);
      } else if (n.kind === "agent" && n.constraintHash === "pending") {
        n.constraintHash = hashSet(seen);
      }
    }
  }
  // stateIndex 是**派生数据**，不是权威数据：不论本次是否修复过字段，都在加载边界
  // 按节点真实字段重建一遍。旧 index 里可能有 "[object Object]/…" 这类脏 key，
  // 也可能因为 constraintHash 恒为 pending 而从未建立（全库 1,440 节点只有 5 条索引）。
  const rebuilt = {};
  for (const id of obj.order ?? []) {
    const n = obj.nodes?.[id];
    if (!n || n.kind !== "agent") continue;
    if (n.worldHash === "pending" || n.constraintHash === "pending") continue;
    const key = `${n.worldHash}/${n.constraintHash}`;
    if (rebuilt[key] === undefined) rebuilt[key] = id;
  }
  obj.stateIndex = rebuilt;
  return obj;
}

/** 人读视图（棋谱）。机器判定永远走 JSON，md 只是给人看的。 */
export function renderMd(g) {
  // P1-5：先建 from -> edges[] 索引。旧版每个节点都 `Object.values(g.edges).filter(...)`，
  // O(N×E)：实测 2000 边 313ms、5000 边 3.05s、10000 边 15.8s。
  const byFrom = new Map();
  for (const edge of Object.values(g.edges)) {
    const list = byFrom.get(edge.from);
    if (list) list.push(edge);
    else byFrom.set(edge.from, [edge]);
  }
  const lines = [`# 棋谱 ${g.sessionId}`, ""];
  lines.push(`> 节点 ${g.order.length} · 边 ${Object.keys(g.edges).length} · fold ${g.foldCount} 次 · 更新 ${new Date(g.updatedAt).toISOString()}`);
  lines.push("");
  for (const id of g.order) {
    const node = g.nodes[id];
    if (!node) continue;
    if (node.kind === "user") {
      lines.push(`## ${id} · USER  seq=${node.seq}`);
      lines.push("");
      for (const line of String(node.text).split("\n")) lines.push(`> ${line}`);
      if (node.constraints.length) {
        lines.push("");
        lines.push("约束：");
        for (const c of node.constraints) lines.push(`- ${c}`);
      }
      const userOut = byFrom.get(id) ?? [];
      if (userOut.length) {
        lines.push("");
        for (const e of userOut) appendEdgeLine(lines, e);
      }
      lines.push("");
    } else {
      lines.push(`## ${id} · STATE  seq=${node.seq}  state=${String(node.worldHash).slice(0, 8)}/${String(node.constraintHash).slice(0, 8)}`);
      if (node.goal) lines.push(`目标：${node.goal}`);
      const outs = byFrom.get(id) ?? [];
      if (outs.length) {
        lines.push("");
        for (const e of outs) appendEdgeLine(lines, e);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function appendEdgeLine(lines, e) {
  lines.push(`- **${e.id}** ${e.intent || "(无意图)"} → \`${e.action || "-"}\` ⇒ ${e.result}${e.to ? ` → ${e.to}` : ""}${e.transposition ? "  ↻置换" : ""}`);
  if (e.errorSnippet) lines.push(`  原因：${e.errorSnippet.split("\n")[0]}`);
}

/**
 * 图健康度（2026-10-29）—— 自环与边/节点比。
 *
 * 自环边（`from === to`）意味着「这一步没有移动」：DAG 的每条边本应让局面前进。
 * 全库实测（修复前）**60.9%** 是自环，直接把棋谱塌成一堆原地打转的边：
 *   · `tewariAnalysis` 的同终点判定恒真 ⇒ `dead` 109/109 全错、`redundant` 135 条全假
 *   · 三层树的缩进深度不再前进
 * 健康阈值只看**自环率 < 5%**。边/节点比只作信息：一个 step 若有 K 次工具调用，
 * 就产生 K 条边 + 1 个节点，K=2~5 是常态（实测健康会话 1.5~3.4），不能当缺陷。
 *
 * @returns {{edges:number, nodes:number, selfLoops:number, selfLoopRate:number, edgePerNode:number, healthy:boolean}}
 */
export function graphHealth(g) {
  const edges = Object.values(g?.edges ?? {});
  const nodes = Object.keys(g?.nodes ?? {}).length;
  let selfLoops = 0;
  for (const e of edges) if (e.from && e.to && e.from === e.to) selfLoops += 1;
  const edgePerNode = nodes > 0 ? edges.length / nodes : 0;
  const selfLoopRate = edges.length > 0 ? selfLoops / edges.length : 0;
  return {
    edges: edges.length,
    nodes,
    selfLoops,
    selfLoopRate,
    edgePerNode,
    healthy: selfLoopRate < 0.05,
  };
}

/**
 * 校验不变量，返回问题清单（空数组=健康）。
 * 这些不变量是「棋谱可回溯」的底线，任何一条破了，热上下文就不该相信这张图。
 */
export function validate(g) {
  const problems = [];
  for (const [id, edge] of Object.entries(g.edges)) {
    if (edge.from && !g.nodes[edge.from]) problems.push(`edge ${id}: from 节点不存在 (${edge.from})`);
    if (edge.to && !g.nodes[edge.to]) problems.push(`edge ${id}: to 节点不存在 (${edge.to})`);
    if (edge.result === "failure" && !edge.errorSnippet && !edge.verify?.summary) {
      problems.push(`edge ${id}: 失败边既无 errorSnippet 也无 verify.summary（失败记忆会丢）`);
    }
    // S2a：弱成功只能挂在 unverified 上 —— 一旦被写成 success/failure，
    // 它就会被 failureEdges / tewari / 统计当成真验证（实测 dead +8 / redundant +9 就是这么来的）
    if (edge.weak && edge.result !== "unverified") {
      problems.push(`edge ${id}: weak=${edge.weak} 却 result=${edge.result}（弱成功必须保持 unverified）`);
    }
  }
  for (const id of g.order) {
    const node = g.nodes[id];
    if (!node) { problems.push(`order 引用了不存在的节点 ${id}`); continue; }
    if (node.kind === "user" && !node.text) problems.push(`user ${id}: 原话为空（约束锚失效）`);
    if (node.kind === "agent" && (!node.worldHash || !node.constraintHash)) {
      problems.push(`agent ${id}: 缺状态哈希（置换表会退化）`);
    }
  }
  return problems;
}

/**
 * 手割分析（tewari）—— 围棋的复盘方法：把多出的着法拿掉，还原标准定式，看谁亏谁赚。
 *
 * 这里做的是同一件事：给定一条失败边，看**同一起点**是否存在不经过它的成功路径。
 *   - pure_loss     ：同起点有成功路径，且完全不经过失败边的终点 → 这一步纯亏
 *   - detour        ：成功路径能到达失败边的终点，但绕了路 → 可能是必要绕路
 *   - no_alternative：同起点没有成功路径可比 → 无法判断
 *
 * @param {object} g    棋谱
 * @param {object} edge 要分析的边（必须 result === "failure"）
 * @returns {{kind: string, alternatives: number, note: string}|null}
 */

/* ─────────────── 手割缓存的索引（P1 性能，2026-10-30） ─────────────── */

/**
 * 图的结构修订号。
 *
 * 为什么不把 rev 写进 graph 对象：`graph.json` 的形状是契约（toJSON/fromJSON 与测试逐字节
 * 比对），多一个字段就是 schema 漂移。用 WeakMap 挂在对象外部：不进 JSON、不影响 GC。
 * 五个改图函数（addUserNode / addAgentNode / addEdge / settleEdge / mergeNodeInto）各 bump 一次。
 */
const GRAPH_REV = new WeakMap();
function bumpRev(g) {
  GRAPH_REV.set(g, (GRAPH_REV.get(g) ?? 0) + 1);
}
/** 只读：当前修订号（测试与诊断用）。 */
export function graphRevision(g) {
  return GRAPH_REV.get(g) ?? 0;
}

const TEWARI_CACHE = Symbol("tewariCache");

/**
 * 手割分析的调用/计算/命中计数（测试与诊断用；生产里只增三个整数）。
 */
export const _tewariStats = { calls: 0, computes: 0, hits: 0 };
/** 只给测试用：memo=false 时必须退化成「每次重算」（语义与旧实现完全一致）。 */
export const _tewariOptions = { memo: true };

/**
 * O(1) 的「便宜键」：只要图**结构**变过，这几个数就一定变。
 *   · rev —— 五个改图函数各 bump 一次（keeper 里唯一绕过 mutator 的 `edge.to = node.id`
 *     紧跟在 addAgentNode 之后，所以也被 rev 覆盖）；
 *   · updatedAt —— 覆盖 engine 的 `Object.assign(g, fromJSON(snapshot))` 回滚；
 *   · nextEdge / order.length —— 覆盖新增边/节点与合并删节点。
 * 渲染器用它做快速命中判断；真正严格的结构签名（含 to/from 数字和）仍留在 graphIndex 里，
 * 由手割分析那条路径承担（它调用次数少、对「同毫秒直接改边」更敏感）。
 */
function cheapKey(g) {
  return `${graphRevision(g)}|${g.updatedAt ?? 0}|${g.nextEdge ?? 0}|${g.order?.length ?? 0}`;
}

/**
 * 取（或重建）一张图的**结构索引**：入/出邻接表 + 每节点可达集 + 每条失败边的结论。
 *
 * 缓存键 = 结构修订号 + updatedAt + 边/节点数 + to/from 的数字和。
 * 为什么要 to/from 数字和：`updatedAt` 是毫秒精度，同毫秒内的两次 settle 会撞键；
 * 而节点 id 形如 `n123`，取数字累加是一趟 O(E) 的整数运算，任何一条边的端点变化都会让键变化。
 * `Object.assign(g, fromJSON(snapshot))`（engine 的失败回滚）不改 rev，但会改 updatedAt ⇒ 也会失效。
 *
 * ★ P2（2026-10-30）：`byTo` 与 `byFrom` 一起建，供 renderNodeMd / renderIndexMd 使用 ——
 *   那两个渲染器原来是 O(N×E)（每个节点都 `Object.values(g.edges).filter(...)`，BFS 每轮也是），
 *   5000 边实测 3.6s / 7.0s；现在索引一次建好后是 O(E + N)。
 */
function graphIndex(g) {
  const edges = Object.values(g.edges);
  let toSum = 0;
  let fromSum = 0;
  for (const e of edges) {
    if (e.to) toSum = (toSum + (Number(String(e.to).slice(1)) || 0)) | 0;
    if (e.from) fromSum = (fromSum + (Number(String(e.from).slice(1)) || 0)) | 0;
  }
  const cheap = cheapKey(g);
  const sig = `${cheap}|${edges.length}|${Object.keys(g.nodes).length}|${toSum}|${fromSum}`;
  let cache = g[TEWARI_CACHE];
  if (cache === undefined || cache.sig !== sig) {
    const byFrom = new Map();
    const byTo = new Map();
    for (const e of edges) {
      const f = byFrom.get(e.from);
      if (f) f.push(e);
      else byFrom.set(e.from, [e]);
      if (e.to) {
        const t = byTo.get(e.to);
        if (t) t.push(e);
        else byTo.set(e.to, [e]);
      }
    }
    cache = { sig, cheap, byFrom, byTo, reach: new Map(), results: new Map() };
    Object.defineProperty(g, TEWARI_CACHE, { value: cache, enumerable: false, configurable: true, writable: true });
    _graphIndexStats.builds += 1;
  } else {
    cache.cheap = cheap; // 签名一致但便宜键更新过（例如回滚后结构复位）—— 记住它，让渲染器能走快路径
  }
  return cache;
}

/** 只读诊断：索引重建次数（测试用；证明缓存真的在复用）。 */
export const _graphIndexStats = { builds: 0 };
/** 只给测试用：memo=false 时每个渲染器各建一次临时索引（不再跨调用复用）。 */
export const _graphIndexOptions = { memo: true };

/** 建一份不入缓存的邻接索引（memo 关闭时的退化路径）。 */
function buildIndexUncached(g) {
  const byFrom = new Map();
  const byTo = new Map();
  for (const e of Object.values(g.edges)) {
    const f = byFrom.get(e.from);
    if (f) f.push(e);
    else byFrom.set(e.from, [e]);
    if (e.to) {
      const t = byTo.get(e.to);
      if (t) t.push(e);
      else byTo.set(e.to, [e]);
    }
  }
  return { sig: "", byFrom, byTo, reach: new Map(), results: new Map() };
}

/** 渲染器用的索引入口：memo 开则复用（跨调用，O(1) 快路径），关则每次现建。 */
function renderIndex(g) {
  if (!_graphIndexOptions.memo) {
    _graphIndexStats.builds += 1;
    return buildIndexUncached(g);
  }
  const cache = g[TEWARI_CACHE];
  // ★ 快路径必须 O(1)：renderNodeMd 会被**每个节点**调一次（N 次），
  //   若每次都算 O(E) 的结构签名，就等于把 O(N×E) 又请回来了（实测 5000 边 14.9s）。
  if (cache !== undefined && cache.cheap === cheapKey(g)) return cache;
  return graphIndex(g);
}


/** 某节点的可达集合（含自身），同一张图内记忆化。 */
function tewariReach(index, start) {
  const hit = index.reach.get(start);
  if (hit !== undefined) return hit;
  const set = new Set([start]);
  const q = [start];
  while (q.length > 0) {
    const id = q.shift();
    for (const e of index.byFrom.get(id) ?? []) {
      if (e.to && !set.has(e.to)) {
        set.add(e.to);
        q.push(e.to);
      }
    }
  }
  index.reach.set(start, set);
  return set;
}

/**
 * 手割分析（tewari）—— 围棋的复盘方法：把多出的着法拿掉，还原标准定式，看谁亏谁赚。
 *
 * ★ P1（2026-10-30）：加记忆化。`renderLedger` 每次 pre-step 都跑，且会在 6 个降级档位里
 *   重复分析同一批失败边（实测真实最差图 212ms/次，其中 tewari 占 87%；一次渲染 49 次调用
 *   里只有 7 次是必要的）。现在同一张图、同一结构下，每条失败边只算一次，跨调用复用。
 *
 *   语义与逐字段输出**完全不变**：命中缓存时返回同一个对象（调用方只读，不写）。
 */
export function tewariAnalysis(g, edge) {
  _tewariStats.calls += 1;
  if (!edge || edge.result !== "failure") return null;
  const from = edge.from;
  const to = edge.to;
  if (!from || !g.nodes[from]) return null;
  // ★ 2026-10-29：自环边（from === to）不代表任何移动 —— 它不是「走到某个局面」，
  //   谈不上「殊途同归」或「绕路」。历史图里 60.9% 的边是这种（旧版 stateIndex 复用起点导致），
  //   必须在这里挡掉；否则同一步的兄弟命令会互相成为「替代路径」，
  //   dead 判定实测 109/109 全错（把「同一步另一条命令成功了」说成「有工作路径避开它」）。
  if (from === to) return null;

  if (!_tewariOptions.memo) {
    _tewariStats.computes += 1;
    return tewariCompute(g, edge, null);
  }
  const index = graphIndex(g);
  const hit = index.results.get(edge.id);
  if (hit !== undefined) {
    _tewariStats.hits += 1;
    return hit;
  }
  _tewariStats.computes += 1;
  const result = tewariCompute(g, edge, index);
  index.results.set(edge.id, result);
  return result;
}

/**
 * 真正的手割计算。`index === null` 时按旧写法现建临时邻接表（关缓存时走这条，
 * 语义与旧版逐条 `Object.values(g.edges).filter/find` 完全等价）。
 */
function tewariCompute(g, edge, index) {
  const from = edge.from;
  const to = edge.to;
  const idx = index ?? (() => {
    const byFrom = new Map();
    for (const e of Object.values(g.edges)) {
      const list = byFrom.get(e.from);
      if (list) list.push(e);
      else byFrom.set(e.from, [e]);
    }
    return { byFrom, reach: new Map() };
  })();
  const outgoing = (id) => idx.byFrom.get(id) ?? [];
  const reachOf = (start) => (index !== null ? tewariReach(idx, start) : tewariReach(idx, start));

  // 同一起点的成功出边（排除自身；自环成功边不算替代路径 —— 它没有离开起点）
  const alts = outgoing(from).filter(
    (e) => e.id !== edge.id && e.result === "success" && e.to && e.to !== e.from && g.nodes[e.to],
  );

  // ★ 多参照点（v1.0.0）：对**每条**成功出边单独判定，而不是取并集。
  //   同一条失败边相对 e5 可能是 redundant，相对 e7 可能是 novel —— 这正是「看第二个判优、看第三个判劣」。
  const baselines = alts.map((alt) => {
    const reach = reachOf(alt.to);
    const sameEndpoint = Boolean(to && to === alt.to);
    const reachesEndpoint = Boolean(to && reach.has(to));
    return { edgeId: alt.id, sameEndpoint, reachesEndpoint };
  });

  // 汇总（给热清单用）
  const redundantVs = baselines.filter((b) => b.sameEndpoint).map((b) => b.edgeId);
  const longerVs = baselines.filter((b) => !b.sameEndpoint && b.reachesEndpoint).map((b) => b.edgeId);

  // 探新：失败边终点不在任何 baseline 的可达集合里
  // （旧实现把这份 BFS 又完整算了一遍；现在直接并已被记忆化的 reach 集合，等价且只算一次）
  const anyReach = new Set();
  for (const alt of alts) for (const id of reachOf(alt.to)) anyReach.add(id);

  const probes = [];
  if (to && g.nodes[to] && !anyReach.has(to)) {
    probes.push(to);
    const q2 = [to];
    const seen2 = new Set([to]);
    while (q2.length > 0 && probes.length < 8) {
      const id = q2.shift();
      for (const e of outgoing(id)) {
        if (!e.to || !g.nodes[e.to]) continue;
        if (anyReach.has(e.to) || seen2.has(e.to)) continue;
        seen2.add(e.to);
        probes.push(e.to);
        q2.push(e.to);
        if (probes.length >= 8) break;
      }
    }
  }

  const samePosition = redundantVs.length > 0;
  let vsBaseline = "unknown";
  if (samePosition) vsBaseline = "same";
  else if (longerVs.length > 0) vsBaseline = "longer";

  return {
    kind: samePosition ? "same_position" : "different",
    samePosition,
    probes,
    vsBaseline,
    // ★ 多参照点明细：每条成功路径一个结论
    baselines,
    redundantVs,
    longerVs,
    alternatives: alts.length,
    note: samePosition
      ? `殊途同归：与 ${redundantVs.join(",")} 到达同一局面`
      : probes.length > 0
        ? `探出 ${probes.length} 处标准定式没走过的节点`
        : longerVs.length > 0
          ? `标准定式 ${longerVs.join(",")} 也能到达，但这一步绕了路`
          : "与标准定式不同型，且未探出新节点",
  };
}

/**
 * 失败三态（v1.1.1）—— 两个子代理 A/B 实验的反馈：
 *   1. 资源类错误（EACCES/ENOENT/timeout）→ blocked，带 revisitIf（什么条件变了可以再试）
 *   2. 有证据的「同起点有成功路径且不经过它」→ dead
 *   3. 其余 → failed（可重试性未知）
 *
 * 关键：**先判 blocked 再判 dead** —— 权限不足是环境性阻塞，不是本质无解；
 * 把 EACCES 写成 dead 会让「拿到权限后本来能走的路」被永久关掉。
 */
export function failureClass(edge, tewari) {
  const text = `${edge?.errorSnippet ?? ""} ${edge?.verify?.summary ?? ""}`;

  // 1) 资源类 → blocked（环境性，不是本质无解）
  if (/(EACCES|EPERM|permission denied|权限不足|access denied)/i.test(text)) {
    return { kind: "blocked", reason: "permission", revisitIf: "permission changes" };
  }
  if (/(ENOENT|not found|no such file|不存在)/i.test(text)) {
    return { kind: "blocked", reason: "missing-resource", revisitIf: "resource appears" };
  }
  if (/(ETIMEDOUT|timeout|超时|timed out)/i.test(text)) {
    return { kind: "blocked", reason: "timeout", revisitIf: "network/service recovers" };
  }
  if (/(ECONNREFUSED|connection refused|连接被拒)/i.test(text)) {
    return { kind: "blocked", reason: "unreachable", revisitIf: "service up" };
  }

  // 2) 有证据的 dead：同起点有成功路径，失败**有终点**且终点不在任何成功路径上。
  //    to 为 null（没走到任何节点）不算证据 —— 只说明试过没成，不能证明「有替代」。
  //    ★ 2026-10-29：`to !== from` 必查 —— 自环边没有离开起点，不存在「绕开它的路径」
  //      （旧版漏了这一条，实测 109/109 条 dead 全是同一步兄弟命令的伪影）。
  if (
    tewari &&
    tewari.alternatives > 0 &&
    edge?.to &&
    edge.to !== edge.from &&
    tewari.probes?.length === 0 &&
    tewari.vsBaseline !== "longer"
  ) {
    return { kind: "dead", reason: "a-working-path-avoids-it", revisitIf: "working path fails" };
  }

  // 3) 其余 → failed（可重试性未知）
  return { kind: "failed", reason: "retryability unknown" };
}

/** 单节点 md（三层文件树：index / nodes / raw 的第二层） */
export function renderNodeMd(g, nodeId) {
  const n = g.nodes[nodeId];
  if (!n) return "";
  const cut = (x, k) => String(x ?? "").slice(0, k);
  const lines = [`# ${nodeId} · ${n.kind.toUpperCase()}  seq=${n.seq}`, ""];
  if (n.kind === "user") {
    lines.push("## 原话", "", ...String(n.text ?? "").split("\n").map((l) => `> ${l}`), "");
    if (n.constraints?.length) lines.push("## 约束", "", ...n.constraints.map((c) => `- ${c}`), "");
  } else {
    // 缺陷 2：goal 常常为空（200 节点只有 7 个有）——用入边的 intent/action 兜底
    if (n.goal) {
      lines.push("## 评语（LLM 当时的目标）", "", n.goal, "");
    } else if (n.via && g.edges[n.via]) {
      const via = g.edges[n.via];
      const text = via.intent || via.action;
      if (text) lines.push(`## 评语（来自入边 ${n.via}，非 LLM 原话）`, "", text, "");
    }
    lines.push("## 状态", "", `- worldHash: \`${cut(n.worldHash, 12)}\``, `- constraintHash: \`${cut(n.constraintHash, 12)}\``, "");
  }
  // ★ P2：索引只取一次（renderNodeMd 会被逐节点调用；每个节点再各取两次会把 O(1) 快路径走成 2N 次）
  const idx = renderIndex(g);
  const ins = idx.byTo.get(nodeId) ?? [];
  lines.push("## 入边", "");
  if (ins.length === 0) lines.push("（无）");
  else for (const e of ins) lines.push(`- ${e.id} ← ${e.from}: ${cut(e.intent || e.action, 80)}${e.result ? ` [${e.result}]` : ""}`);
  lines.push("");
  const outs = idx.byFrom.get(nodeId) ?? [];
  lines.push("## 出边", "");
  if (outs.length === 0) lines.push("（无）");
  else for (const e of outs) lines.push(`- ${e.id} → ${e.to ?? "(未结算)"}: ${cut(e.intent || e.action, 80)}${e.result ? ` [${e.result}]` : ""}${e.result === "failure" ? ` [verify:${e.verify?.kind ?? "none"}]` : ""}${e.errorSnippet ? ` — ${cut(e.errorSnippet, 400)}` : ""}`);
  lines.push("");
  lines.push("## 原始记录", "", "（raw/ 已砍掉：节点数据在 graph.json，见 docs/CHANGELOG v1.2.4）", "");
  return lines.join("\n");
}

/** 索引 md（三层文件树的第一层，替代整篇 graph.md） */
export function renderIndexMd(g) {
  const cut = (x, k) => String(x ?? "").slice(0, k);

  // 计算每个节点的深度（从**入度为 0 的节点**出发的最短路径；转置边不重复入队）
  // 用入度 0 而不是 rootUserNodeIds：后者每个 user 消息都是一个"根"，会导致所有节点深度都是 0
  //
  // ★ P2（2026-10-30）：BFS 与节点出边都走结构索引（byFrom/byTo），不再每个节点/每轮都
  //   `Object.values(g.edges)` 全表扫 —— 旧写法是 O(N×E)：5000 边实测 3.6s。
  const idx = renderIndex(g);
  const depth = new Map();
  const roots = Object.keys(g.nodes).filter((id) => !idx.byTo.has(id));
  const queue = roots.map((id) => [id, 0]);
  while (queue.length > 0) {
    const [id, d] = queue.shift();
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const e of idx.byFrom.get(id) ?? []) {
      if (e.to && !depth.has(e.to)) queue.push([e.to, d + 1]);
    }
  }

  const lines = [
    `# 棋谱 ${g.sessionId}`,
    "",
    `> 节点 ${Object.keys(g.nodes).length} · 边 ${Object.keys(g.edges).length} · fold ${g.foldCount} 次 · updated ${new Date(g.updatedAt).toISOString()}`,
    "",
    "## 落子顺序（缩进 = 深度；每个节点只出现一次）",
    "",
  ];
  for (const id of g.order) {
    const n = g.nodes[id];
    if (!n) continue;
    const d = depth.get(id) ?? 0;
    const indent = "  ".repeat(Math.min(d, 12)); // 深度封顶 12 级，防路径爆炸
    const label = n.kind === "user" ? "USER" : "STATE";
    const title = n.kind === "user" ? cut(n.text, 40) : n.goal ? cut(n.goal, 40) : "(无目标)";
    lines.push(`${indent}- [${id}](./nodes/${id}.md) ${label} seq=${n.seq} ${title}`);
    const outs = idx.byFrom.get(id) ?? [];
    for (const e of outs) {
      const mark = e.result === "success" ? "✓" : e.result === "failure" ? "✗" : "?";
      lines.push(`${indent}  - ${e.id} ${mark} ${cut(e.intent || e.action, 30)}${e.result === "failure" && e.verify?.kind === "text" ? " [text:?]" : ""}`);
    }
  }
  // 失败边全表：index 的缩进树每个节点只出现一次，跨边/置换边不在树里。
  // 模型要枚举**全部**失败边时用这一段（子代理实测：只靠缩进树只能看到 190/404 条边）。
  lines.push("", "## 失败边全表（含跨边 / 置换边）", "");
  let failCount = 0;
  for (const e of Object.values(g.edges)) {
    if (e.result !== "failure") continue;
    failCount += 1;
    const from = e.from ?? "?";
    const to = e.to ?? "(未结算)";
    lines.push(
      `- ${e.id} ${from} → ${to}: ${cut(e.intent || e.action, 60)} — ${cut(e.errorSnippet || e.verify?.summary || "(无原因)", 160)} [verify:${e.verify?.kind ?? "none"}]${e.verify?.kind === "text" ? " [text:?]" : ""}`,
    );
  }
  if (failCount === 0) lines.push("（无）");
  return lines.join("\n");
}
/* ─────────────── P3（2026-10-30）：增量落盘 ───────────────
 *
 * 背景（实测）：一次 flush 写 graph.json(0.5–0.6MB) + index.md(13–92KB)，
 * 而一步真正新增只有 ~762B ⇒ 写放大 ×800–975；fold 后还要全量重写 361–415 个 nodes/*.md（429–836ms）。
 *
 * 设计：
 *   · **dirty 跟踪**（本文件的 mutator 里打点，WeakMap 存，不进 graph JSON 形状）；
 *   · **delta 帧**：每帧只写本次变更的节点/边（绝对 upsert）+ 标量 + order 追加/删除；
 *   · **generation 保护**：帧头记录它写在其上的基线内容哈希；基线一旦重写（压缩），
 *     旧帧因哈希不匹配被整体忽略 ⇒「先写基线 rename、后清 delta」在任意崩溃点都安全；
 *   · **尾部坏帧**：加载时遇到 JSON 坏/校验不符的行就地停止（半写帧不会污染图）。
 */

const DIRTY = new WeakMap();

function dirtyOf(g) {
  let d = DIRTY.get(g);
  if (d === undefined) {
    d = { nodes: new Set(), edges: new Set(), delNodes: new Set(), delEdges: new Set(), orderAppend: [], orderDrop: [] };
    DIRTY.set(g, d);
  }
  return d;
}

/** 标记一个节点被写（add / merge 的目标 / 直接改字段）。 */
export function markNodeDirty(g, id) {
  if (id) dirtyOf(g).nodes.add(id);
}
/** 标记一条边被写。 */
export function markEdgeDirty(g, id) {
  if (id) dirtyOf(g).edges.add(id);
}
/** 标记节点被删（order 里也要去掉）。 */
export function markNodeDeleted(g, id) {
  if (!id) return;
  const d = dirtyOf(g);
  d.delNodes.add(id);
  d.nodes.delete(id);
  d.orderDrop.push(id);
}
/** 标记 order 新增（节点创建时调用）。 */
export function markOrderAppend(g, id) {
  if (id) dirtyOf(g).orderAppend.push(id);
}

/** 只读：当前 dirty 集（写盘成功后再 clearDirty）。 */
export function peekDirty(g) {
  const d = dirtyOf(g);
  return {
    nodes: [...d.nodes],
    edges: [...d.edges],
    delNodes: [...d.delNodes],
    delEdges: [...d.delEdges],
    orderAppend: [...d.orderAppend],
    orderDrop: [...d.orderDrop],
    empty:
      d.nodes.size === 0 && d.edges.size === 0 && d.delNodes.size === 0 && d.delEdges.size === 0 && d.orderAppend.length === 0 && d.orderDrop.length === 0,
  };
}

/** 写盘成功后清空 dirty（失败时不能清 —— 否则丢一次变更）。 */
export function clearDirty(g) {
  const d = dirtyOf(g);
  d.nodes.clear();
  d.edges.clear();
  d.delNodes.clear();
  d.delEdges.clear();
  d.orderAppend.length = 0;
  d.orderDrop.length = 0;
}

/** 从 dirty 集生成一帧增量（只放本帧真的要持久化的字段，不加新 schema）。 */
export function deltaFromDirty(g, dirty = peekDirty(g)) {
  const nodes = {};
  for (const id of dirty.nodes) if (g.nodes[id]) nodes[id] = g.nodes[id];
  const edges = {};
  for (const id of dirty.edges) if (g.edges[id]) edges[id] = g.edges[id];
  return {
    v: 1,
    nodes,
    edges,
    delNodes: dirty.delNodes ?? [],
    delEdges: dirty.delEdges ?? [],
    orderAppend: dirty.orderAppend ?? [],
    orderDrop: dirty.orderDrop ?? [],
    scalars: {
      updatedAt: g.updatedAt,
      nextNode: g.nextNode,
      nextEdge: g.nextEdge,
      rootUserNodeIds: g.rootUserNodeIds,
      foldCount: g.foldCount,
      lastFoldTotalTokens: g.lastFoldTotalTokens,
      checkpointSeq: g.checkpointSeq,
      lastFoldUsage: g.lastFoldUsage ?? null,
      foldMarks: g.foldMarks ?? [],
    },
  };
}

/**
 * 把一帧增量应用到图上（幂等：upsert 是绝对覆盖；order 追加前查重）。
 * 应用后 stateIndex 按 fromJSON 的同一规则重建 —— 它是派生数据，不进 delta。
 */
export function applyDelta(g, delta) {
  if (!delta || delta.v !== 1) throw new Error(`graph: unsupported delta version ${delta?.v}`);
  for (const [id, node] of Object.entries(delta.nodes ?? {})) g.nodes[id] = node;
  for (const [id, edge] of Object.entries(delta.edges ?? {})) g.edges[id] = edge;
  for (const id of delta.delNodes ?? []) delete g.nodes[id];
  for (const id of delta.delEdges ?? []) delete g.edges[id];
  const s = delta.scalars ?? {};
  for (const k of ["updatedAt", "nextNode", "nextEdge", "rootUserNodeIds", "foldCount", "lastFoldTotalTokens", "checkpointSeq"]) {
    if (s[k] !== undefined) g[k] = s[k];
  }
  if (s.lastFoldUsage !== undefined) g.lastFoldUsage = s.lastFoldUsage;
  if (Array.isArray(s.foldMarks)) g.foldMarks = s.foldMarks;
  for (const id of delta.orderDrop ?? []) {
    const at = g.order.indexOf(id);
    if (at >= 0) g.order.splice(at, 1);
  }
  if ((delta.orderAppend ?? []).length > 0) {
    const seen = new Set(g.order);
    for (const id of delta.orderAppend) {
      if (!seen.has(id)) {
        g.order.push(id);
        seen.add(id);
      }
    }
  }
  rebuildStateIndex(g);
  bumpRev(g);
  // 结构变了 ⇒ 索引缓存必须作废（直接删挂载的 Symbol，下次渲染重建）
  try {
    delete g[TEWARI_CACHE];
  } catch {
    /* ignore */
  }
  return g;
}

/** stateIndex 重建（与 fromJSON 里的规则逐字一致：按时序、只收非 pending 的 agent）。 */
export function rebuildStateIndex(g) {
  const rebuilt = {};
  for (const id of g.order ?? []) {
    const n = g.nodes?.[id];
    if (!n || n.kind !== "agent") continue;
    if (n.worldHash === "pending" || n.constraintHash === "pending") continue;
    const key = `${n.worldHash}/${n.constraintHash}`;
    if (rebuilt[key] === undefined) rebuilt[key] = id;
  }
  g.stateIndex = rebuilt;
  return g;
}

/* ── 帧的编码/解码：`<baseHash16> <checksum31> <json>` 一行一帧 ── */

/** 便宜校验（不是密码学哈希；只用来挡住「半写/坏帧」）。 */
export function checksum31(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/** 编码一帧：baseHash 是它写在其上的 graph.json 内容哈希（十六进制前 16 位）。 */
export function encodeDeltaFrame(baseHash, delta) {
  const body = JSON.stringify(delta);
  return `${baseHash}\t${checksum31(body)}\t${body}\n`;
}

/**
 * 解码 delta 文件内容：只接受 baseHash 与当前基线一致、且校验通过的帧；遇到坏帧就地停止。
 * @returns {{frames: object[], badTail: boolean}}
 */
export function decodeDeltaFrames(text, baseHash) {
  const frames = [];
  let badTail = false;
  for (const line of String(text ?? "").split("\n")) {
    if (line.length === 0) continue;
    const p1 = line.indexOf("\t");
    const p2 = p1 < 0 ? -1 : line.indexOf("\t", p1 + 1);
    if (p1 < 0 || p2 < 0) {
      badTail = true;
      break;
    }
    const frameBase = line.slice(0, p1);
    if (frameBase !== baseHash) {
      // 基线已重写（压缩后留下的旧帧）⇒ 整段忽略，不是坏帧
      badTail = true;
      break;
    }
    const sum = Number(line.slice(p1 + 1, p2));
    const body = line.slice(p2 + 1);
    if (!Number.isFinite(sum) || checksum31(body) !== sum) {
      badTail = true;
      break;
    }
    try {
      frames.push(JSON.parse(body));
    } catch {
      badTail = true;
      break;
    }
  }
  return { frames, badTail };
}

/* ── index.md 增量追加（fold / 首次写全量；其余每次只追加新内容） ── */

/**
 * 生成 index.md 的追加段：只写本帧新增/变化的节点行、边行与失败原因。
 * 追加段自描述（`## 增量 · <iso> · +N 节点 / +M 边`），fold 时由全量重建覆盖掉。
 */
export function renderIndexAppend(g, dirty = peekDirty(g), label = "") {
  const cut = (x, k) => String(x ?? "").slice(0, k);
  const lines = [];
  const nodeIds = [...(dirty.nodes ?? [])].filter((id) => g.nodes[id]);
  const edgeIds = [...(dirty.edges ?? [])].filter((id) => g.edges[id]);
  const delNodes = dirty.delNodes ?? [];
  if (nodeIds.length === 0 && edgeIds.length === 0 && delNodes.length === 0) return "";
  lines.push("");
  lines.push(
    `## 增量 · ${new Date(g.updatedAt ?? Date.now()).toISOString()}${label ? ` · ${label}` : ""} · +${nodeIds.length} 节点 / +${edgeIds.length} 边${delNodes.length ? ` / −${delNodes.length} 节点` : ""}`,
  );
  for (const id of nodeIds) {
    const n = g.nodes[id];
    const kind = n.kind === "user" ? "USER" : "STATE";
    const title = n.kind === "user" ? cut(n.text, 40) : n.goal ? cut(n.goal, 40) : "(无目标)";
    lines.push(`- [${id}](./nodes/${id}.md) ${kind} seq=${n.seq} ${title}`);
    for (const e of renderIndexEdgesOf(g, id)) {
      const mark = e.result === "success" ? "✓" : e.result === "failure" ? "✗" : "?";
      lines.push(`  - ${e.id} ${mark} ${cut(e.intent || e.action, 30)}${e.result === "failure" && e.verify?.kind === "text" ? " [text:?]" : ""}`);
    }
  }
  for (const id of edgeIds) {
    const e = g.edges[id];
    if (!e) continue;
    const mark = e.result === "success" ? "✓" : e.result === "failure" ? "✗" : "?";
    lines.push(
      `- ${e.id} ${mark} ${e.from} → ${e.to ?? "(未结算)"}: ${cut(e.intent || e.action, 40)}${e.result === "failure" ? ` — ${cut(e.errorSnippet || e.verify?.summary || "(无原因)", 120)}` : ""}`,
    );
  }
  for (const id of delNodes) lines.push(`- ${id} （已合并，见置换节点）`);
  return lines.join("\n");
}

/** 便捷：某节点的出边（走结构索引，避免增量渲染再退回 O(N×E)）。 */
function renderIndexEdgesOf(g, id) {
  let idx = null;
  try {
    idx = g[TEWARI_CACHE] && g[TEWARI_CACHE].cheap === cheapKey(g) ? g[TEWARI_CACHE] : graphIndex(g);
  } catch {
    idx = null;
  }
  return idx ? idx.byFrom.get(id) ?? [] : Object.values(g.edges).filter((e) => e.from === id);
}