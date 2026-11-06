/**
 * dangling-edge.test.mjs —— 「from 节点不存在」的**真红 + 最小修复**守卫（C639）
 *
 * 真机背景（2026-11-05，<SESSION_ID>）：
 *   `graph.json` 基线的 `nextNode` 是 3795、节点编号连续到 n3794 —— 唯独 **n3780 不存在**；
 *   而 delta 里有一帧写着 `e3913 { from: "n3780", to: "n3781" }`。
 *   派生视图（`nodes/n3780.md`、`index.md`）都证明它**曾经在内存里**，只是记录从未落盘。
 *   于是 `validate()` 报 `edge e3913: from 节点不存在 (n3780)`，doctor 的 C140 长期是 ✗。
 *
 * 本文件钉住五件事（缺一条就会变成「修了个寂寞」或「修完更糟」）：
 *   ① **真红**：夹具不修就必须被判出来（否则守卫是空壳）；
 *   ② **分类**：`from/to 节点不存在` 必须能反解析成结构化列（边 / 节点 / fold 区间 / delta 可重放性）；
 *   ③ **可补回性**：「被 delta 的 `delNodes` 删掉」= 可补桩；「id 分配过、记录从未落盘」= 只能标记；
 *   ④ **修复方式**：只**追加**一帧 delta（★ C188：改基线会让全部旧帧失效），边一条都不删；
 *   ⑤ **口径**：修完 `splitDanglingProblems` 必须把这条边划进「已标记」（C140 降级为 `!`），
 *      而**没标记的悬空边仍是 error**（负面对照，防止把整类问题放过）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";

import { addAgentNode, addEdge, addUserNodeId, createGraph, encodeDeltaFrame, sha, settleEdge, toJSON } from "./graph-fixtures.mjs";
import { auditGraph, loadSessionGraph } from "../scripts/graph-audit.mjs";
import {
  auditSession,
  classifyProblem,
  deltaIndex,
  foldIndexOf,
  foldRanges,
  markDanglingEdges,
  planDanglingMarks,
  recoverability,
  splitDanglingProblems,
} from "../scripts/dangling-audit.mjs";

/* ───────────────────────────── 夹具 ─────────────────────────────
 * 复刻真机形状：**基线里 `nextNode` 远大于节点数**（id 被烧掉过 —— 节点被回滚，id 不回收），
 * 悬空边只活在 delta 层，缺失的端点在任何层都没有记录。
 * 这是唯一能同时覆盖「边在 delta 里」与「节点记录从未落盘」的形状。 */

const BURNED_NEXT_NODE = 1000; // 基线已烧到 n999 ⇒ n999 = 「分配过、没落盘」
const NEVER_ALLOCATED = "n5000"; // ≥ nextNode ⇒ 从未分配（伪造引用）

function baseGraph() {
  const g = createGraph({ sessionId: "fx-dangling-edge" });
  const u = addUserNodeId(g, { seq: 10, text: "把 C140 修绿。" });
  const e0 = addEdge(g, { from: u, intent: "先看一眼", action: "bash(ls)" });
  const a = addAgentNode(g, { seq: 20, goal: "先看一眼", worldHash: "W1", constraintHash: "C1", via: e0 }).id;
  g.edges[e0].to = a;
  settleEdge(g, e0, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  g.nextNode = BURNED_NEXT_NODE;
  g.foldMarks = [{ at: 1, seqStart: 1, seqEnd: 30, closure: { nodes: 0, edges: 0 } }];
  return { g, u, a, e0 };
}

/** 把「基线 + 若干帧 delta」写进临时会话目录（`<tmp>/session-fx-dangling-edge/`）。 */
function writeSession({ extraFrames = [] } = {}) {
  const { g } = baseGraph();
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dangling-edge-"));
  const sessionDir = nodePath.join(dir, "session-fx-dangling-edge");
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  const graphFile = nodePath.join(sessionDir, "graph.json");
  const text = toJSON(g);
  nodeFs.writeFileSync(graphFile, text, "utf8");
  const baseHash = sha(text).slice(0, 16);
  nodeFs.writeFileSync(`${graphFile}.delta.jsonl`, extraFrames.map((f) => encodeDeltaFrame(baseHash, f)).join(""), "utf8");
  return { dir, sessionDir, graphFile, baseHash };
}

/** 真机那一帧的形状：新增 n1000（agent），并挂一条 `from` 悬空的边。 */
function danglingFrame({ from = `n${BURNED_NEXT_NODE - 1}`, to = "n1000", edgeId = "e2" } = {}) {
  return {
    v: 1,
    nodes: {
      n1000: { id: "n1000", seq: 40, kind: "agent", goal: "跑 job_output", worldHash: "W2", constraintHash: "C1", ts: 1_800_000_000_000 },
    },
    edges: {
      [edgeId]: {
        id: edgeId,
        from,
        to,
        intent: "",
        action: "job_output(job_id=bash-e91931d1e39841a2 timeout_ms=900000)",
        sig: "634a0652994bc65f",
        result: "unverified",
        verify: { kind: "read", summary: "33 chars" },
        errorSnippet: "",
        evidence: { start: 30266, end: 30269 },
        transposition: false,
        ts: 1_800_000_000_000,
        weak: "read",
      },
    },
    delNodes: [],
    delEdges: [],
    orderAppend: ["n1000"],
    orderDrop: [],
  };
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "C639-1 真红：from 悬空的边必须被 validate 判出来（守卫不是空壳）"(t) {
    const fx = writeSession({ extraFrames: [danglingFrame()] });
    try {
      // 基线本身自洽（order 与 nodes 双向一致）—— 否则后面的断言分不清是谁的锅
      const baseProblems = auditGraph(JSON.parse(nodeFs.readFileSync(fx.graphFile, "utf8"))).filter((p) => !p.startsWith("foldMarks["));
      t.eq(baseProblems, [], "基线必须干净");

      const plan = planDanglingMarks(fx.graphFile);
      t.eq(plan.marks.length, 1, "恰好一条自洽性缺失（from 悬空）");
      const p = plan.marks[0];
      t.eq(p.kind, "from-missing", "必须判成 from 节点不存在");
      t.eq(p.edge, "e2", "边 id 要解析出来");
      t.eq(p.node, `n${BURNED_NEXT_NODE - 1}`, "缺失节点 id 要解析出来");
      t.eq(p.danglingMarked, false, "修之前不能假装已标记");
      t.eq(p.inDelta, true, "这条边只活在 delta 层（基线里没有它）");
      t.eq(p.nodeDoc, null, "临时目录里没有派生视图");
      t.eq(p.inFold, false, "证据 seq 30266 不在 foldMark [1,30] 内");
    } finally {
      nodeFs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },

  "C639-2 分类：validate 的中文文案 → 结构化列（边 / 节点 / fold / delta）"(t) {
    t.eq(classifyProblem("edge e3913: from 节点不存在 (n3780)"), { kind: "from-missing", edge: "e3913", node: "n3780", index: null, key: null }, "from 悬空");
    t.eq(classifyProblem("edge e7: to 节点不存在 (n9)"), { kind: "to-missing", edge: "e7", node: "n9", index: null, key: null }, "to 悬空");
    t.eq(classifyProblem('stateIndex["W1/C1"] → 不存在的节点 n5').kind, "stateindex-dangling", "悬空索引要单列，不许混进悬空边");
    t.eq(classifyProblem("order 缺节点 n5").kind, "order-missing-node", "节点不在 order");
    t.eq(classifyProblem("foldMarks[3] seqStart>seqEnd").kind, "foldmark-range", "旧版反向区间");
    t.eq(classifyProblem("delta 帧无法回放（图可能停在部分回放）：boom").kind, "delta-unreplayable", "delta 坏帧");
    t.eq(classifyProblem("这是什么鬼").kind, "other", "认不出的必须归 other，不许丢");

    // fold 区间：反向区间也要能命中（否则「是否 fold 造成」这一列永远是「否」= 假绿）
    const ranges = foldRanges({ foldMarks: [{ seqStart: 100, seqEnd: 200 }, { seqStart: 900, seqEnd: 800 }] });
    t.eq(foldIndexOf(ranges, 150), 0, "正常区间命中");
    t.eq(foldIndexOf(ranges, 850), 1, "反向区间按 min/max 归一后仍要命中");
    t.eq(foldIndexOf(ranges, 500), -1, "区间外");
    t.eq(foldIndexOf(ranges, NaN), -1, "没有 seq 的边 = 不在任何折叠区间内");
  },

  "C639-3 可补回性：delNodes 删掉的能补桩；id 分配过但记录没落盘的只能标记"(t) {
    const graph = JSON.parse(toJSON(baseGraph().g));
    const empty = deltaIndex([]);

    // ① 被 delta 的 delNodes 删掉 ⇒ 可补回（C526 补桩的适用面）
    const removed = deltaIndex([{ v: 1, delNodes: ["n1000"] }]);
    t.eq(recoverability("n1000", { graph, raw: graph, delta: removed }).kind, "removedByDelta", "delNodes 删掉的 = 可补回");
    t.eq(recoverability("n1000", { graph, raw: graph, delta: removed }).recoverable, true, "可补回要明说");

    // ② id 分配过（< nextNode）、基线与 delta 都没有 ⇒ 记录丢失，补不回来
    const lost = recoverability("n999", { graph, raw: graph, delta: empty });
    t.eq(lost.kind, "neverPersisted", "id 分配过、记录从未落盘 = 不可补回");
    t.eq(lost.allocated, true, "「分配过」的判据是 id < nextNode");
    t.eq(lost.recoverable, false, "不可补回才能标记");

    // ③ id 从未分配 ⇒ 引用写坏（同样不许「补桩」出一个假局面）
    const bogus = recoverability(NEVER_ALLOCATED, { graph, raw: graph, delta: empty });
    t.eq(bogus.kind, "neverAllocated", "id ≥ nextNode = 从未分配");
    t.eq(bogus.recoverable, false, "写坏的引用同样不可补回");

    // ④ delta 里写过、图上却没有 ⇒ 这是「重放失败」，不是「记录丢失」
    const upserted = deltaIndex([{ v: 1, nodes: { n42: { id: "n42" } } }]);
    t.eq(recoverability("n42", { graph, raw: graph, delta: upserted }).kind, "upsertedByDelta", "delta 写过 = 走重放");
  },

  "C639-4 修复：只追加一帧 delta（基线一个字节都不改，边一条都不删，改前先备份）"(t) {
    const fx = writeSession({ extraFrames: [danglingFrame()] });
    try {
      const baseBefore = nodeFs.readFileSync(fx.graphFile, "utf8");
      const deltaBefore = nodeFs.readFileSync(`${fx.graphFile}.delta.jsonl`, "utf8");
      const backupDir = nodePath.join(fx.dir, "backup");

      const out = markDanglingEdges(fx.graphFile, { apply: true, backupDir, now: 1_800_000_000_000 });
      t.eq(out.marked, ["e2"], "要标记的是那条悬空边");
      t.eq(out.bytes > 0, true, "确实写了一帧");
      t.eq(out.blocked, [], "没有「可补回」的边需要走补桩");

      // ① 基线逐字节不变（★ C188：改基线 = 全部旧帧失效 = 数据丢失）
      t.eq(nodeFs.readFileSync(fx.graphFile, "utf8"), baseBefore, "graph.json 必须逐字节不变");
      // ② 备份在、且与改前逐字节相同
      t.eq(nodeFs.existsSync(nodePath.join(backupDir, "graph.json")), true, "改前必须有备份");
      t.eq(nodeFs.readFileSync(nodePath.join(backupDir, "graph.json"), "utf8"), baseBefore, "备份必须与改前一致");
      t.eq(nodeFs.readFileSync(nodePath.join(backupDir, "graph.json.delta.jsonl"), "utf8"), deltaBefore, "delta 备份必须与改前一致");

      // ③ 只在**尾部追加**，旧帧原样保留
      const deltaAfter = nodeFs.readFileSync(`${fx.graphFile}.delta.jsonl`, "utf8");
      t.eq(deltaAfter.startsWith(deltaBefore), true, "旧帧必须原样保留（append-only）");
      t.eq(deltaAfter.length > deltaBefore.length, true, "确实追加了");

      // ④ 重复 apply 必须是空操作（幂等：不许无限追加）
      const again = markDanglingEdges(fx.graphFile, { apply: true, backupDir });
      t.eq(again.marked, [], "重复 apply 不许再写一帧");
      t.eq(nodeFs.readFileSync(`${fx.graphFile}.delta.jsonl`, "utf8"), deltaAfter, "幂等：文件不许再变");
    } finally {
      nodeFs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },

  "C639-5 修复后：边保留且带 dangling 标记，C140 口径降级为「已标记」"(t) {
    const fx = writeSession({ extraFrames: [danglingFrame()] });
    try {
      markDanglingEdges(fx.graphFile, { apply: true, backupDir: nodePath.join(fx.dir, "backup"), now: 1_800_000_000_000 });

      // 用**同一套**重放机制把图读回来（graph-audit 的 loadSessionGraph 口径）
      const { graph } = loadSessionGraph(fx.graphFile);
      t.eq(graph.edges.e2.dangling, true, "重放后边必须带 dangling 标记");
      t.eq(graph.edges.e2.from, "n999", "边的内容（from）逐字保留 —— 标记不是改写历史");
      t.eq(graph.edges.e2.verify.summary, "33 chars", "其它字段逐字保留");
      t.eq(graph.edges.e2.danglingMissing, ["n999"], "缺失的端点要写进标记（可追溯）");
      t.eq(Object.keys(graph.edges).length, 2, "一条边都没删");

      const problems = auditGraph(graph);
      const split = splitDanglingProblems(graph, problems);
      t.eq(split.real, [], "已标记的边不再算 error");
      t.eq(split.marked.length, 1, "但要出现在「已标记」里（C140 降级为 !，不是消失）");
      t.includes(split.marked[0], "from 节点不存在", "降级后的文案仍要说明原因");

      // auditSession 的口径必须一致（doctor 不直接用它，但脚本自己要用它做汇总）
      const row = auditSession(fx.graphFile);
      t.eq(row.problems.length, 1, "问题仍在（边不删，可追溯）");
      t.eq(row.problems[0].danglingMarked, true, "必须被认成「已标记 dangling」");
    } finally {
      nodeFs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },

  "C639-6 负面对照：没标记的悬空边必须仍然是 real（修复逻辑不许把整类放过）"(t) {
    const fx = writeSession({ extraFrames: [danglingFrame()] });
    try {
      const { graph } = loadSessionGraph(fx.graphFile);
      const problems = auditGraph(graph);
      t.eq(problems.length, 1, "未修时恰有一条真红");
      const split = splitDanglingProblems(graph, problems);
      t.eq(split.marked, [], "没有 dangling 标记时，一条都不许进 marked");
      t.eq(split.real.length, problems.length, "全部问题都是 real");
    } finally {
      nodeFs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },

  "C639-7 免罪符：已标记 dangling 的边若另有问题（失败边无原因）必须仍然算 error"(t) {
    // 一条边同时「from 悬空」+「failure 却没有 errorSnippet/verify.summary」
    const frame = danglingFrame();
    frame.edges.e2.result = "failure";
    frame.edges.e2.verify = { kind: "none", summary: "" };
    delete frame.edges.e2.weak;
    const fx = writeSession({ extraFrames: [frame] });
    try {
      const { graph } = loadSessionGraph(fx.graphFile);
      const problems = auditGraph(graph);
      t.eq(problems.length >= 2, true, "夹具必须同时暴露两个问题");

      // 假装这条边已被标记（doctor 侧看到的就是这个形状）
      graph.edges.e2.dangling = true;
      const split = splitDanglingProblems(graph, problems);
      t.eq(split.marked.length, 1, "只有「端点不存在」那条被放过");
      t.eq(split.marked[0].includes("from 节点不存在"), true, "被放过的必须正是端点缺失那条");
      t.eq(
        split.real.some((x) => x.includes("失败边既无 errorSnippet")),
        true,
        "**dangling 标记不是免罪符**：失败边没原因必须继续算 error",
      );
    } finally {
      nodeFs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },
};
