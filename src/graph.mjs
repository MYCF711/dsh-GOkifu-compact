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
  return id;
}

/**
 * Agent 节点：一个状态快照。
 * @returns { id, transposition: null | { nodeId, hops } }
 *   若 stateKey 命中已有节点，则**不新建节点**，只返回命中信息（图上只多一条边）。
 */
export function addAgentNode(g, { seq, turn = null, goal, worldHash, constraintHash, via = null }) {
  // 落账阶段还没有真实状态哈希（要 stat 文件，成本高）——先占位，fold 前回填。
  const pending = worldHash === "pending" || constraintHash === "pending";
  const key = `${worldHash}/${constraintHash}`;
  if (!pending) {
    const existing = g.stateIndex[key];
    if (existing !== undefined) {
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

/** 找到导向某节点的所有入边（含置换边）。 */
export function incomingEdges(g, nodeId) {
  return Object.values(g.edges).filter((e) => e.to === nodeId);
}

/** 找到从某节点出发的所有边。 */
export function outgoingEdges(g, nodeId) {
  return Object.values(g.edges).filter((e) => e.from === nodeId);
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
  return id;
}

export function settleEdge(g, edgeId, { to = null, result, verify, errorSnippet = "" }) {
  const edge = g.edges[edgeId];
  if (!edge) throw new Error(`settleEdge: unknown edge ${edgeId}`);
  edge.to = to ?? edge.to;
  edge.result = result;
  edge.verify = verify ?? { kind: "none", summary: "" };
  edge.errorSnippet = String(errorSnippet ?? "").slice(0, 600);
  if (to && edge.transposition === undefined) edge.transposition = false;
  g.updatedAt = Date.now();
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
export function tewariAnalysis(g, edge) {
  if (!edge || edge.result !== "failure") return null;
  const from = edge.from;
  const to = edge.to;
  if (!from || !g.nodes[from]) return null;

  // 同一起点的成功出边（排除自身）
  const alts = Object.values(g.edges).filter(
    (e) => e.from === from && e.id !== edge.id && e.result === "success" && e.to && g.nodes[e.to],
  );
  if (alts.length === 0) {
    return {
      kind: "no_alternative",
      alternatives: 0,
      note: "同起点没有成功路径可比，无法手割",
    };
  }

  // 失败边没有终点节点（尝试没走到任何状态）：只要有成功替代路径，就是纯亏
  if (!to) {
    return {
      kind: "pure_loss",
      alternatives: alts.length,
      note: "失败边没有终点节点；同起点存在不经过它的成功路径",
    };
  }

  // 从成功后继出发做 BFS，看能否到达失败边的终点
  const reachable = new Set();
  const queue = alts.map((e) => e.to);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    reachable.add(id);
    for (const e of Object.values(g.edges)) {
      if (e.from === id && e.to && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }

  if (to && reachable.has(to)) {
    return {
      kind: "detour",
      alternatives: alts.length,
      note: "失败终点在成功路径上，可能是绕路",
    };
  }
  return {
    kind: "pure_loss",
    alternatives: alts.length,
    note: "把这一步拿掉，同起点有成功路径且不经过它",
  };
}
