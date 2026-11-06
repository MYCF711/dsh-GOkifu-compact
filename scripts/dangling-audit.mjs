#!/usr/bin/env node
/**
 * dangling-audit.mjs —— 全库「结构不自洽」只读审计 + 悬空边分类（C639）
 *
 * 为什么要有它：`doctor` 的 C140 每次只报**一句话**（`1/527 个会话不自洽：…edge e3913: from 节点不存在 (n3780)`），
 * 但这一句话背后至少有四种**成因完全不同**的坏图，而它们的正确处置方式相反：
 *
 *   · 边在 delta 里、只是**基线丢了** ⇒ 重放就能补回来（补，不删）；
 *   · 端点节点被 delta 的 `delNodes` 删掉 ⇒ C526 的**补桩**（stub）就是为它设计的；
 *   · 端点节点的**记录从未落盘**（id 分配过、图里没有、delta 里也没有）⇒ 补不回来，**只能标记**；
 *   · 边本身不存在、只是 order / stateIndex 引用错 ⇒ 另一类，别混进来。
 *
 * 这个脚本把「哪一类、能不能补、fold 有没有参与」变成可复核的列，并给出全库分类统计。
 * `--apply` 只做一类**最小**修复：把「补不回来」的悬空边**标记为 dangling**（追加一帧 delta，
 * 不删边、不改基线、不碰其它会话）。
 *
 * 为什么修复走 **delta 帧**而不是重写 `graph.json`（★ C188 的血泪）：
 *   `graph.json.delta.jsonl` 的每一帧都带「基线内容哈希」，重写基线会让**全部旧帧失效** ⇒
 *   `load()` 判定 badTail 并把 delta 截断到 0 帧 ⇒ 这个会话丢掉 10 个节点 / 10 条边（实测）。
 *   delta 是 append-only 的，追加一帧**不改基线哈希**，所以对**正在跑的宿主**也安全。
 *
 * 用法（默认只读）：
 *   node scripts/dangling-audit.mjs                 # 全库审计 + 分类统计
 *   node scripts/dangling-audit.mjs --json          # 机读
 *   node scripts/dangling-audit.mjs --session=8cc34e32       # 只审计一个会话（id 前缀）
 *   node scripts/dangling-audit.mjs --apply --session=8cc34e32 # 标记该会话的不可补悬空边（先备份到 tmp/）
 *   node scripts/dangling-audit.mjs --apply --dry-run        # 只报告将要写什么
 *
 * 退出码：0 全绿；1 有**未标记**的不自洽；2 参数错误。
 * 边界：不加 `--apply` 时**只读**（不写任何文件）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { applyDelta, decodeDeltaFrames, encodeDeltaFrame, fromJSON, sha } from "../src/rooms/kifu-model.mjs";
import { auditGraph, auditRawIndex, loadSessionGraph } from "./graph-audit.mjs";

/* ─────────────── 问题类型的**唯一口径**（doctor 的 C140 也走这里） ───────────────
 * 每个 kind 给：给人看的标签 + 它属于哪一族（统计用）。
 * 「族」是把 `order 缺节点` / `order 有幽灵节点` 这类同源问题归并，避免统计表碎成十几行。 */
export const KINDS = {
  "from-missing": { label: "from 节点不存在", family: "from/to 节点不存在" },
  "to-missing": { label: "to 节点不存在", family: "from/to 节点不存在" },
  "order-missing-node": { label: "节点不在 order", family: "节点不在 order" },
  "order-ghost": { label: "order 有幽灵节点", family: "order 有幽灵节点" },
  "order-dangling": { label: "order 引用了不存在的节点", family: "order 有幽灵节点" },
  "stateindex-dangling": { label: "stateIndex 悬空", family: "stateIndex 悬空" },
  "duplicate-id": { label: "重复 id", family: "重复 id" },
  "foldmark-range": { label: "foldMark 区间反向", family: "foldMark 区间反向（旧版本）" },
  "foldmark-closure": { label: "foldMark 闭包越界", family: "foldMark 闭包越界" },
  "delta-unreplayable": { label: "delta 无法回放", family: "delta 无法回放" },
  "edge-failure-no-reason": { label: "失败边无原因", family: "其它" },
  "weak-result": { label: "弱成功挂了非 unverified", family: "其它" },
  "agent-missing-hash": { label: "agent 缺状态哈希", family: "其它" },
  "user-empty-text": { label: "user 原话为空", family: "其它" },
  unparsable: { label: "图无法解析", family: "其它" },
  other: { label: "其它", family: "其它" },
};

/** 把 `validate()` / `auditGraph()` 的**中文文案**反解析成结构化问题。
 *  为什么用正则反解析而不是重写一遍检查：口径必须跟 `validate()` 逐字一致 ——
 *  重写一遍就是第二份真相（这一族 bug 已经出过三次，见 doctor C300 的注释）。 */
const PARSERS = [
  { re: /^edge (\S+): from 节点不存在 \((\S+)\)$/, kind: "from-missing", edge: 1, node: 2 },
  { re: /^edge (\S+): to 节点不存在 \((\S+)\)$/, kind: "to-missing", edge: 1, node: 2 },
  { re: /^order 缺节点 (\S+)$/, kind: "order-missing-node", node: 1 },
  { re: /^order 有幽灵节点 (\S+)$/, kind: "order-ghost", node: 1 },
  { re: /^order 引用了不存在的节点 (\S+)$/, kind: "order-dangling", node: 1 },
  { re: /^stateIndex\["([^"]*)"\] → 不存在的节点 (\S+)$/, kind: "stateindex-dangling", node: 2, key: 1 },
  { re: /^foldMarks\[(\d+)\] seqStart>seqEnd$/, kind: "foldmark-range", index: 1 },
  { re: /^foldMarks\[(\d+)\] closure\.nodes\((\d+)\) > graphNodes\((\d+)\)$/, kind: "foldmark-closure", index: 1 },
  { re: /^edge (\S+): 失败边既无 errorSnippet 也无 verify\.summary（失败记忆会丢）$/, kind: "edge-failure-no-reason", edge: 1 },
  { re: /^edge (\S+): weak=(\S+) 却 result=(\S+)（弱成功必须保持 unverified）$/, kind: "weak-result", edge: 1 },
  { re: /^agent (\S+): 缺状态哈希（置换表会退化）$/, kind: "agent-missing-hash", node: 1 },
  { re: /^user (\S+): 原话为空（约束锚失效）$/, kind: "user-empty-text", node: 1 },
  { re: /^delta 帧无法回放/, kind: "delta-unreplayable" },
];

/** 一条文案 → `{kind, edge, node, index, key}`。认不出的一律 `other`（不丢，只归堆）。 */
export function classifyProblem(text) {
  const s = String(text ?? "");
  for (const p of PARSERS) {
    const m = p.re.exec(s);
    if (m === null) continue;
    return { kind: p.kind, edge: p.edge ? m[p.edge] : null, node: p.node ? m[p.node] : null, index: p.index ? Number(m[p.index]) : null, key: p.key ? m[p.key] : null };
  }
  return { kind: "other", edge: null, node: null, index: null, key: null };
}

/* ─────────────── 图的几何量：fold 区间 / 边的 seq ─────────────── */

/** foldMarks → `[{index, lo, hi}]`（反向区间按 min/max 归一，否则永远不命中）。 */
export function foldRanges(graph) {
  const out = [];
  for (const [index, mark] of (graph?.foldMarks ?? []).entries()) {
    const a = Number(mark?.seqStart);
    const b = Number(mark?.seqEnd);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push({ index, lo: Math.min(a, b), hi: Math.max(a, b) });
  }
  return out;
}

/** 边 / 节点的「位置」：优先 `evidence`（数字或 `{start,end}`），其次 `seq`。 */
export function seqOf(item) {
  const ev = item?.evidence;
  if (typeof ev === "number") return ev;
  if (Number.isFinite(ev?.start)) return Number(ev.start);
  if (Number.isFinite(item?.seq)) return Number(item.seq);
  return NaN;
}

/** 该位置落在哪个 foldMark 区间里（-1 = 不在任何折叠区间内）。 */
export function foldIndexOf(ranges, seq) {
  if (!Number.isFinite(seq)) return -1;
  const hit = ranges.find((r) => seq >= r.lo && seq <= r.hi);
  return hit === undefined ? -1 : hit.index;
}

/* ─────────────── delta 层：这份「丢失」能不能靠重放补回来 ─────────────── */

/**
 * delta 帧里出现过的 id 集合。
 *
 * 三个集合缺一不可：
 *   · `upsertNodes/upsertEdges`：这一层**写过**它（⇒ 「在 delta 里」）；
 *   · `deletedNodes/deletedEdges`：这一层**删过**它（⇒ 悬空是 `delNodes` 造成的，C526 补桩的适用面）；
 *   · `orderAppended/orderDropped`：order 漂移的来源。
 *
 * @param {Array<any>} frames 由 `decodeDeltaFrames` 解出的帧
 */
export function deltaIndex(frames) {
  const out = {
    frames: frames.length,
    upsertNodes: new Set(),
    upsertEdges: new Set(),
    deletedNodes: new Set(),
    deletedEdges: new Set(),
    orderAppended: new Set(),
    orderDropped: new Set(),
  };
  for (const f of frames ?? []) {
    for (const id of Object.keys(f?.nodes ?? {})) out.upsertNodes.add(id);
    for (const id of Object.keys(f?.edges ?? {})) out.upsertEdges.add(id);
    for (const id of f?.delNodes ?? []) out.deletedNodes.add(id);
    for (const id of f?.delEdges ?? []) out.deletedEdges.add(id);
    for (const id of f?.orderAppend ?? []) out.orderAppended.add(id);
    for (const id of f?.orderDrop ?? []) out.orderDropped.add(id);
  }
  return out;
}

/**
 * 一个「缺失的 id」的可补回性判定（**这是本脚本的核心判据**）。
 *
 * `id` 是边的端点（或 order/index 引用的节点）。
 *   · `removedByDelta`  —— 基线里有、被 delta 的 `delNodes` 删掉 ⇒ **补桩即可**（C526 的设计面），
 *                          因为「它被删了」这件事本身还在 delta 里，可追溯；
 *   · `upsertedByDelta` —— delta 里写过它，重放却在图上找不到 ⇒ delta 无法回放（另一类 bug）；
 *   · `neverPersisted`  —— **基线没有、任何帧也没有**，但 id < nextNode（**分配过**）⇒ 记录丢失；
 *   · `neverAllocated`  —— id ≥ nextNode ⇒ 这条引用**从来没被分配**（伪造 / 写坏的 id）。
 *
 * 只有 `removedByDelta` 是可「补回」的；后两类都只能标记。
 *
 * @param {string} id
 * @param {{graph:any, raw:any, delta:ReturnType<typeof deltaIndex>}} ctx
 */
export function recoverability(id, { graph, raw, delta }) {
  const inBase = Boolean(raw?.nodes?.[id]) || Boolean(raw?.edges?.[id]);
  const removed = delta.deletedNodes.has(id) || delta.deletedEdges.has(id);
  const upserted = delta.upsertNodes.has(id) || delta.upsertEdges.has(id);
  const allocated = /^[ne](\d+)$/.test(String(id)) ? Number(String(id).slice(1)) < Number(graph?.nextNode ?? graph?.nextEdge ?? 0) : false;
  if (removed) return { kind: "removedByDelta", inBase, upserted, allocated, recoverable: true };
  if (upserted) return { kind: "upsertedByDelta", inBase, upserted, allocated, recoverable: true };
  if (allocated) return { kind: "neverPersisted", inBase, upserted, allocated, recoverable: false };
  return { kind: "neverAllocated", inBase, upserted, allocated, recoverable: false };
}

/* ─────────────── 单会话审计 ─────────────── */

/**
 * 审计一个 `graph.json`（**只读**）。
 * @param {string} graphFile
 * @returns {{session:string, graphFile:string, problems:Array<any>, frames:number, deltaError:string|null, badTail:boolean, scanned:boolean}}
 */
export function auditSession(graphFile) {
  const session = nodePath.basename(nodePath.dirname(graphFile));
  const dir = nodePath.dirname(graphFile);
  let loaded;
  try {
    loaded = loadSessionGraph(graphFile);
  } catch (error) {
    return {
      session,
      graphFile,
      problems: [{ kind: "unparsable", label: KINDS.unparsable.label, text: String(error?.message ?? error).slice(0, 160) }],
      frames: 0,
      deltaError: null,
      badTail: false,
      scanned: false,
    };
  }
  const { raw, graph } = loaded;
  // ★ 帧必须自己解一次：`loadSessionGraph` 只回图，不回「哪些 id 在 delta 里」。
  let frames = [];
  try {
    const base = sha(nodeFs.readFileSync(graphFile, "utf8")).slice(0, 16);
    const deltaFile = `${graphFile}.delta.jsonl`;
    if (nodeFs.existsSync(deltaFile)) frames = decodeDeltaFrames(nodeFs.readFileSync(deltaFile, "utf8"), base).frames;
  } catch {
    /* 帧解析失败由下面的 deltaError 报 */
  }
  const delta = deltaIndex(frames);
  const ranges = foldRanges(graph);

  const texts = [...auditRawIndex(raw), ...auditGraph(graph)];
  if (loaded.deltaError) texts.push(`delta 帧无法回放（图可能停在部分回放）：${loaded.deltaError}`);

  // 重复 id：`validate()` **不查** order 里的重复（对象键天生唯一，只有 order 是数组）。
  const seen = new Set();
  const dups = new Set();
  for (const id of graph?.order ?? []) {
    if (seen.has(id) && !dups.has(id)) dups.add(id);
    seen.add(id);
  }

  const problems = [];
  for (const text of texts) {
    const c = classifyProblem(text);
    const meta = KINDS[c.kind] ?? KINDS.other;
    const anchor = c.edge ? graph?.edges?.[c.edge] : c.node ? graph?.nodes?.[c.node] : null;
    const seq = seqOf(anchor);
    const rec = c.node ? recoverability(c.node, { graph, raw, delta }) : null;
    problems.push({
      kind: c.kind,
      label: meta.label,
      family: meta.family,
      text,
      edge: c.edge,
      node: c.node,
      key: c.key,
      seq: Number.isFinite(seq) ? seq : null,
      foldIndex: foldIndexOf(ranges, seq),
      inFold: foldIndexOf(ranges, seq) >= 0,
      // 「这条边/这个 id 在 delta 里吗」—— 决定它是不是「重放就能补回来」
      inDelta: Boolean(c.edge ? delta.upsertEdges.has(c.edge) : c.node ? delta.upsertNodes.has(c.node) : false),
      deletedByDelta: Boolean(c.edge ? delta.deletedEdges.has(c.edge) : c.node ? delta.deletedNodes.has(c.node) : false),
      recover: rec,
      nodeDoc: c.node && nodeFs.existsSync(nodePath.join(dir, "nodes", `${c.node}.md`)) ? `nodes/${c.node}.md` : null,
      danglingMarked: Boolean(c.edge && graph?.edges?.[c.edge]?.dangling === true),
    });
  }
  for (const id of dups) {
    const seq = seqOf(graph?.nodes?.[id]);
    const foldIndex = foldIndexOf(ranges, seq);
    problems.push({
      kind: "duplicate-id",
      label: KINDS["duplicate-id"].label,
      family: KINDS["duplicate-id"].family,
      text: `order 里重复出现 ${id}`,
      edge: null,
      node: id,
      key: null,
      seq: Number.isFinite(seq) ? seq : null,
      foldIndex,
      inFold: foldIndex >= 0,
      inDelta: delta.upsertNodes.has(id),
      deletedByDelta: delta.deletedNodes.has(id),
      recover: recoverability(id, { graph, raw, delta }),
      nodeDoc: nodeFs.existsSync(nodePath.join(dir, "nodes", `${id}.md`)) ? `nodes/${id}.md` : null,
      danglingMarked: false,
    });
  }
  return { session, graphFile, problems, frames: frames.length, deltaError: loaded.deltaError ?? null, badTail: Boolean(loaded.badTail), scanned: true };
}

/* ─────────────── 全库 ─────────────── */

/** 默认 home 的推导与 doctor 保持一致（`DSH_HOME` 优先）。 */
export function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim().length > 0) return env.trim();
  return nodePath.join(os.homedir(), ".dsh");
}

/**
 * 扫整个 `<home>/chess-context/sessions`。
 * @param {string} sessionsDir
 * @param {{only?: string|null}} [options] `only` = 会话 id 前缀过滤
 */
export function auditAll(sessionsDir, { only = null } = {}) {
  const rows = [];
  if (!nodeFs.existsSync(sessionsDir)) return rows;
  for (const entry of nodeFs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (only && !entry.name.includes(only)) continue;
    const graphFile = nodePath.join(sessionsDir, entry.name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    rows.push(auditSession(graphFile));
  }
  return rows;
}

/** 分类统计：按类型族、按 fold×delta 交叉、按可补回性。 */
export function summarize(rows) {
  const byFamily = new Map();
  const byFoldDelta = new Map();
  const byRecover = new Map();
  let total = 0;
  let bad = 0;
  let marked = 0;
  let frames = 0;
  for (const row of rows) {
    frames += row.frames;
    if (row.problems.length > 0) bad += 1;
    for (const p of row.problems) {
      total += 1;
      if (p.danglingMarked) marked += 1;
      const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
      bump(byFamily, p.family);
      bump(byFoldDelta, `${p.inFold ? "fold 区间内" : "非 fold"} · ${p.inDelta ? "delta 里有" : "delta 里没有"}${p.deletedByDelta ? "（被 delNodes 删）" : ""}`);
      bump(byRecover, p.recover === null || p.recover === undefined ? "无端点（order/index 类）" : p.recover.kind);
    }
  }
  return { sessions: rows.length, bad, total, marked, frames, byFamily, byFoldDelta, byRecover };
}

const RECOVER_LABEL = {
  removedByDelta: "可补回（基线有、被 delta 的 delNodes 删）",
  upsertedByDelta: "可补回（delta 写过、图上没有）",
  neverPersisted: "**不可补回**（id 分配过，记录从未落盘）",
  neverAllocated: "**不可补回**（id 从未分配，引用写坏）",
  "无端点（order/index 类）": "无端点（order/index 类）",
};

function renderRow(row) {
  const out = [];
  const head = row.problems.some((p) => !p.danglingMarked) ? "✗" : "!";
  out.push(`${head} ${row.session}  （${row.problems.length} 条 · delta ${row.frames} 帧${row.badTail ? " · 尾部残帧" : ""}）`);
  for (const p of row.problems) {
    const parts = [`[${p.label}]`];
    if (p.edge) parts.push(`边 ${p.edge}`);
    if (p.node) parts.push(`节点 ${p.node}`);
    parts.push(`fold 区间: ${p.inFold ? `是 (#${p.foldIndex})` : "否"}`);
    parts.push(`delta 可重放: ${p.inDelta ? "是" : "否"}${p.deletedByDelta ? "（delNodes）" : ""}`);
    if (p.recover) parts.push(`可补回: ${RECOVER_LABEL[p.recover.kind] ?? p.recover.kind}`);
    if (p.nodeDoc) parts.push(`派生视图 ${p.nodeDoc} 存在`);
    if (p.danglingMarked) parts.push("**已标记 dangling**");
    out.push(`    ${parts.join(" · ")}`);
    out.push(`    ${p.text}`);
  }
  return out;
}

/* ─────────────── 修复：把「补不回来」的悬空边标记为 dangling（追加一帧 delta） ─────────────── */

/**
 * 计划（不写盘）：哪些边可以被标记、哪些被拦下。
 * @param {string} graphFile
 */
export function planDanglingMarks(graphFile) {
  const row = auditSession(graphFile);
  const marks = [];
  const blocked = [];
  for (const p of row.problems) {
    if (!["from-missing", "to-missing"].includes(p.kind)) continue;
    if (p.danglingMarked) continue;
    if (p.recover?.recoverable) {
      // 可补回的那一类**不在这里修**：那要用 C526 的补桩（heal），不是标记。
      blocked.push({ ...p, why: "可补回（removedByDelta/upsertedByDelta）—— 应先补桩，不标记" });
      continue;
    }
    marks.push(p);
  }
  return { session: row.session, graphFile, marks, blocked };
}

/**
 * 追加一帧 delta，把**不可补回**的悬空边标记为 dangling。
 *
 * 语义（三条，都是硬约束）：
 *   ① **不删边**：边是历史（「当时从那个局面调用了那个工具」），删了就没法追溯；
 *   ② **不改基线**：`graph.json` 一个字节都不动 —— 改了会让全部 delta 帧失效（C188）；
 *   ③ **只写一帧**：所有要标记的边打包进同一帧，`scalars` 留空（不碰任何标量）。
 *
 * 备份：写盘前把 `graph.json` + `graph.json.delta.jsonl` 复制到 `backupDir`。
 *
 * @param {string} graphFile
 * @param {{apply?: boolean, backupDir?: string, now?: number, reason?: string}} [options]
 * @returns {{session:string, marked:string[], frame:any|null, backup:string|null, bytes:number, blocked:Array<any>}}
 */
export function markDanglingEdges(graphFile, { apply = false, backupDir = "", now = Date.now(), reason = "" } = {}) {
  const plan = planDanglingMarks(graphFile);
  if (plan.marks.length === 0) return { session: plan.session, marked: [], frame: null, backup: null, bytes: 0, blocked: plan.blocked };

  const text = nodeFs.readFileSync(graphFile, "utf8");
  const base = sha(text).slice(0, 16);
  // ★ 边必须从**重放后**的图上取：悬空边常常只活在 delta 层（基线里根本没有它），
  //   只读 `graph.json` 会 `continue` 掉，修复就成了空写。
  const graph = fromJSON(text);
  const deltaFile0 = `${graphFile}.delta.jsonl`;
  if (nodeFs.existsSync(deltaFile0)) {
    const { frames } = decodeDeltaFrames(nodeFs.readFileSync(deltaFile0, "utf8"), base);
    for (const frame of frames) applyDelta(graph, frame);
  }

  const edges = {};
  for (const p of plan.marks) {
    const edge = graph.edges?.[p.edge];
    if (!edge) continue;
    // 只**加**字段：原有字段逐字保留（边的内容是历史，不改写）。
    edges[p.edge] = {
      ...edge,
      dangling: true,
      danglingMissing: [p.node],
      danglingAt: now,
      danglingReason:
        reason ||
        `端点 ${p.node} 的图记录从未落盘（id 已分配但基线/任何 delta 帧里都没有；仅派生视图 ${p.nodeDoc ?? "缺失"}）。` +
        "保留边以维持可追溯，不做补桩（补桩会伪造一个不存在的局面）。",
    };
  }
  // 空帧 = 白写一行（还会让 `deltaFrames` 计数漂移）—— 一条都取不到就不写。
  if (Object.keys(edges).length === 0) return { session: plan.session, marked: [], frame: null, backup: null, bytes: 0, blocked: plan.blocked };
  const frame = { v: 1, nodes: {}, edges, delNodes: [], delEdges: [], orderAppend: [], orderDrop: [] };
  const line = encodeDeltaFrame(base, frame);

  // 自检：这一帧必须能被**同一套**解码器读回来（否则就是写了个坏帧）。
  if (decodeDeltaFrames(line, base).frames.length !== 1) throw new Error("dangling-audit: 生成的帧无法自解，已中止（未写盘）");

  let backup = null;
  if (apply) {
    const dir = backupDir && backupDir.length > 0 ? backupDir : nodePath.join(process.cwd(), "tmp", `dangling-backup-${now}`);
    nodeFs.mkdirSync(dir, { recursive: true });
    backup = nodePath.join(dir, "graph.json");
    nodeFs.copyFileSync(graphFile, backup);
    const deltaFile = `${graphFile}.delta.jsonl`;
    if (nodeFs.existsSync(deltaFile)) nodeFs.copyFileSync(deltaFile, `${backup}.delta.jsonl`);
    nodeFs.appendFileSync(deltaFile, line, "utf8");
  }
  return { session: plan.session, marked: plan.marks.map((p) => p.edge), frame, backup, bytes: Buffer.byteLength(line, "utf8"), blocked: plan.blocked };
}

/* ─────────────── doctor 侧的口径（C140 只调这一个函数） ─────────────── */

/**
 * 把 C140 的问题列表切成「真问题」与「已标记 dangling」。
 *
 * ★ C639：`doctor` 的 C140 必须能区分这两者 —— 已标记的边**仍要出现在报告里**（降级为 `!`），
 *   但不再是 error。判据只有一条：**边上有 `dangling: true`**（由 `--apply` 写进 delta 层，
 *   重放后即可见），且问题的 `edge <id>:` 前缀与之对上。
 *
 * @param {any} graph 重放 delta 之后的图
 * @param {string[]} problems `auditGraph()` / `auditRawIndex()` 给出的文案
 * @returns {{real: string[], marked: string[]}}
 */
export function splitDanglingProblems(graph, problems) {
  const markedEdges = new Set();
  for (const [id, edge] of Object.entries(graph?.edges ?? {})) {
    if (edge?.dangling === true) markedEdges.add(id);
  }
  const real = [];
  const marked = [];
  for (const text of problems ?? []) {
    const c = classifyProblem(text);
    // ★ 只放过「端点不存在」这两类。已标记的边若**另外**还有问题（失败边没原因 / 弱成功挂了
    //   success …），那些问题与 dangling 无关，必须继续算 error —— 否则标记就成了万能免罪符。
    const endpointOnly = c.kind === "from-missing" || c.kind === "to-missing";
    if (endpointOnly && c.edge !== null && markedEdges.has(c.edge)) marked.push(text);
    else real.push(text);
  }
  return { real, marked };
}

/* ─────────────── CLI ─────────────── */

function parseArgs(argv) {
  const opts = { json: false, apply: false, dryRun: false, session: null, home: null, backupDir: "" };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--session=")) opts.session = arg.slice("--session=".length);
    else if (arg.startsWith("--home=")) opts.home = arg.slice("--home=".length);
    else if (arg.startsWith("--backup-dir=")) opts.backupDir = arg.slice("--backup-dir=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(fsHelp);
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

const fsHelp = `dangling-audit —— 全库「结构不自洽」只读审计 + 悬空边分类（C639）
  node scripts/dangling-audit.mjs [--json] [--session=<id 前缀>] [--home=<DSH_HOME>]
  node scripts/dangling-audit.mjs --apply [--session=<id 前缀>] [--backup-dir=<dir>] [--dry-run]
默认路径：<DSH_HOME>/chess-context/sessions（与 doctor 同源）`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = opts.home ?? resolveHome();
  const sessionsDir = nodePath.join(home, "chess-context", "sessions");

  if (opts.apply) {
    const rows = auditAll(sessionsDir, { only: opts.session });
    const targets = rows.filter((r) => r.problems.some((p) => ["from-missing", "to-missing"].includes(p.kind) && !p.danglingMarked));
    if (targets.length === 0) {
      console.log("没有需要标记的悬空边（全库已经自洽，或都已标记）。");
      process.exit(0);
    }
    if (targets.length > 1 && !opts.session) {
      console.error(`✗ 命中 ${targets.length} 个会话 —— **只修 1 个**是硬约束。请用 --session=<id 前缀> 指定：`);
      for (const row of targets) console.error(`    ${row.session}`);
      process.exit(2);
    }
    for (const row of targets) {
      const out = markDanglingEdges(row.graphFile, { apply: !opts.dryRun, backupDir: opts.backupDir });
      const verb = opts.dryRun ? "[dry-run] 将标记" : "已标记";
      console.log(`${verb}：${out.session} → ${out.marked.join(", ")}（${out.bytes} bytes 追加到 delta）`);
      if (out.backup) console.log(`  备份：${out.backup}`);
      for (const b of out.blocked) console.log(`  ⚠ 跳过 ${b.edge}：${b.why}`);
    }
    process.exit(0);
  }

  const rows = auditAll(sessionsDir, { only: opts.session });
  const stats = summarize(rows);
  const bad = rows.filter((r) => r.problems.length > 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          home,
          sessionsDir,
          sessions: stats.sessions,
          bad: stats.bad,
          total: stats.total,
          marked: stats.marked,
          frames: stats.frames,
          byFamily: Object.fromEntries(stats.byFamily),
          byFoldDelta: Object.fromEntries(stats.byFoldDelta),
          byRecover: Object.fromEntries(stats.byRecover),
          rows: bad,
        },
        null,
        1,
      ),
    );
    process.exit(bad.some((r) => r.problems.some((p) => !p.danglingMarked)) ? 1 : 0);
  }

  console.log("== 悬空/不自洽全库审计（只读） ==");
  console.log(`home: ${home}`);
  console.log(`会话 ${stats.sessions} 个 · 不自洽 ${stats.bad} 个 · 问题 ${stats.total} 条（其中已标记 dangling ${stats.marked} 条）· delta 帧合计 ${stats.frames}`);
  console.log("");
  if (bad.length === 0) {
    console.log("  ✅ 全部自洽");
  } else {
    for (const row of bad) for (const line of renderRow(row)) console.log(line);
  }
  console.log("");
  console.log("── 分类统计 · 按类型族 ──");
  for (const [k, v] of [...stats.byFamily].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${((v / Math.max(1, stats.total)) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  console.log("── 分类统计 · fold × delta ──");
  for (const [k, v] of [...stats.byFoldDelta].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log("── 分类统计 · 可补回性 ──");
  for (const [k, v] of [...stats.byRecover].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${RECOVER_LABEL[k] ?? k}`);

  process.exit(bad.some((r) => r.problems.some((p) => !p.danglingMarked)) ? 1 : 0);
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
