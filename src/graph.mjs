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

  // ★ 多参照点（v1.0.0）：对**每条**成功出边单独判定，而不是取并集。
  //   同一条失败边相对 e5 可能是 redundant，相对 e7 可能是 novel —— 这正是「看第二个判优、看第三个判劣」。
  const baselines = alts.map((alt) => {
    const reach = new Set();
    const q = [alt.to];
    const seen = new Set(q);
    while (q.length > 0) {
      const id = q.shift();
      reach.add(id);
      for (const e of Object.values(g.edges)) {
        if (e.from === id && e.to && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    const sameEndpoint = Boolean(to && to === alt.to);
    const reachesEndpoint = Boolean(to && reach.has(to));
    return { edgeId: alt.id, sameEndpoint, reachesEndpoint };
  });

  // 汇总（给热清单用）
  const redundantVs = baselines.filter((b) => b.sameEndpoint).map((b) => b.edgeId);
  const longerVs = baselines.filter((b) => !b.sameEndpoint && b.reachesEndpoint).map((b) => b.edgeId);

  // 探新：失败边终点不在任何 baseline 的可达集合里
  const anyReach = new Set();
  for (const alt of alts) {
    const q = [alt.to];
    const seen = new Set(q);
    while (q.length > 0) {
      const id = q.shift();
      anyReach.add(id);
      for (const e of Object.values(g.edges)) {
        if (e.from === id && e.to && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
  }
  const probes = [];
  if (to && g.nodes[to] && !anyReach.has(to)) {
    probes.push(to);
    const q2 = [to];
    const seen2 = new Set([to]);
    while (q2.length > 0 && probes.length < 8) {
      const id = q2.shift();
      for (const e of Object.values(g.edges)) {
        if (e.from !== id || !e.to || !g.nodes[e.to]) continue;
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
  if (tewari && tewari.alternatives > 0 && edge?.to && tewari.probes?.length === 0 && tewari.vsBaseline !== "longer") {
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
  const ins = Object.values(g.edges).filter((e) => e.to === nodeId);
  lines.push("## 入边", "");
  if (ins.length === 0) lines.push("（无）");
  else for (const e of ins) lines.push(`- ${e.id} ← ${e.from}: ${cut(e.intent || e.action, 80)}${e.result ? ` [${e.result}]` : ""}`);
  lines.push("");
  const outs = Object.values(g.edges).filter((e) => e.from === nodeId);
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
  const depth = new Map();
  const hasIn = new Set(Object.values(g.edges).filter((e) => e.to).map((e) => e.to));
  const roots = Object.keys(g.nodes).filter((id) => !hasIn.has(id));
  const queue = roots.map((id) => [id, 0]);
  while (queue.length > 0) {
    const [id, d] = queue.shift();
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const e of Object.values(g.edges)) {
      if (e.from === id && e.to && !depth.has(e.to)) queue.push([e.to, d + 1]);
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
    const outs = Object.values(g.edges).filter((e) => e.from === id);
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
