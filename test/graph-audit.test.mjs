/**
 * graph-audit.test.mjs —— 只读图体检的判据（2026-11-02，C139）
 *
 * 这个脚本的价值在于「**历史遗留的坏图会被点名**」：
 * flush 只在写盘时告警，老版本留下的悬空边 / 悬空索引 / order 漂移不会再被提及。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { auditGraph, auditIndexText, auditRawIndex, auditRoot, repairMissingDocs } from "../scripts/graph-audit.mjs";
import { fromJSON } from "../src/rooms/kifu-model.mjs";
import { createFsPort, createPersistStore } from "../src/rooms/kifu-persist.mjs";
import { addAgentNode, addEdge, addUserNode, createGraph, settleEdge, toJSON } from "./graph-fixtures.mjs";

export const tests = {};

function createGoodGraphWithTwoNodes() {
  const g = createGraph({ sessionId: "session-delta" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿" }).id;
  const e1 = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const a1 = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e1 }).id;
  settleEdge(g, e1, { to: a1, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  const e2 = addEdge(g, { from: a1, intent: "再跑一次", action: "bash(npm test)", evidence: { start: 5, end: 6 } });
  const a2 = addAgentNode(g, { seq: 7, goal: "再跑一次", worldHash: "W2", constraintHash: "C2", via: e2 }).id;
  settleEdge(g, e2, { to: a2, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return g;
}

function goodGraph() {
  const g = createGraph({ sessionId: "s" });
  const u = addUserNode(g, { seq: 1, text: "把测试跑绿" }).id;
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  return g;
}

tests["C139-1 自洽的图必须 0 问题（不许对正常图假红）"] = (t) => {
  t.eq(auditGraph(goodGraph()), [], "正常图不该有问题");
};

tests["C139-2 四类坏数据都必须被点名（悬空边 / 悬空索引 / order 漂移 / 闭包越界）"] = (t) => {
  // ① 悬空边
  const dangling = goodGraph();
  const eid = Object.keys(dangling.edges)[0];
  dangling.edges[eid].to = "n999";
  t.eq(auditGraph(dangling).some((p) => p.includes("to 节点不存在")), true, "悬空边必须报");

  // ② 悬空 stateIndex
  const idx = goodGraph();
  idx.stateIndex = { "W1/C1": "n777" };
  t.eq(auditGraph(idx).some((p) => p.includes("不存在的节点 n777")), true, "悬空索引必须报");

  // ③ order 漂移（缺节点 + 幽灵节点）
  const order = goodGraph();
  order.order = order.order.filter((id) => id !== "n1");
  order.order.push("n555");
  const op = auditGraph(order);
  t.eq(op.some((p) => p.includes("order 缺节点 n1")), true, "order 缺节点必须报");
  t.eq(op.some((p) => p.includes("order 有幽灵节点 n555")), true, "order 幽灵节点必须报");

  // ④ 闭包越界 + seq 反向
  const clos = goodGraph();
  clos.foldMarks = [{ seqStart: 9, seqEnd: 3, closure: { nodes: 7, graphNodes: 5 } }];
  const cp = auditGraph(clos);
  t.eq(cp.some((p) => p.includes("seqStart>seqEnd")), true, "seq 反向必须报");
  t.eq(cp.some((p) => p.includes("closure.nodes(7) > graphNodes(5)")), true, "闭包越界必须报");
};

tests["C139-3 auditRoot：坏文件（无法解析）也要被点名，而不是让脚本崩"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-audit-"));
  try {
    const good = nodePath.join(root, "session-good");
    nodeFs.mkdirSync(good, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(good, "graph.json"), toJSON(goodGraph()), "utf8");
    const broken = nodePath.join(root, "session-broken");
    nodeFs.mkdirSync(broken, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(broken, "graph.json"), "{not json", "utf8");

    const rows = auditRoot(root);
    t.eq(rows.length, 2, "两个会话都要出现在结果里");
    const byName = Object.fromEntries(rows.map((r) => [r.session, r.problems]));
    t.eq(byName["session-good"].length, 0, "好图必须 0 问题");
    t.eq(byName["session-broken"].some((p) => p.includes("无法解析")), true, "坏文件必须点名而不是抛出");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C142-4 悬空 stateIndex 必须在**原始 JSON** 上查（fromJSON 会重建 ⇒ 规范化后永远绿）"] = (t) => {
  const good = goodGraph();
  const raw = JSON.parse(toJSON(good));
  // 正常文件：原始 stateIndex 的 value 都指向真实节点
  t.eq(auditRawIndex(raw), [], "正常文件的原始索引不该有问题");

  // 坏文件：原始 JSON 里塞一个悬空索引（fromJSON 会把它重建掉，所以只能在 raw 上抓）
  raw.stateIndex = { ...(raw.stateIndex ?? {}), "W9/C9": "n999" };
  const problems = auditRawIndex(raw);
  t.eq(problems.some((p) => p.includes("不存在的节点 n999")), true, `原始悬空索引必须报：${JSON.stringify(problems)}`);

  // 反向确认：规范化之后的图看不到它（这正是「假守护」的成因）
  const rebuilt = fromJSON(JSON.stringify(raw));
  t.eq(Object.entries(rebuilt.stateIndex ?? {}).some(([, id]) => id === "n999"), false, "fromJSON 重建后悬空索引消失（所以必须在 raw 上查）");
};

tests["C143 delta 重放：只在 delta 里的节点不许被当成「不存在」（审查 P1-2/P1-4）"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-delta-"));
  try {
    // 用真实 store 造一份「基线 + delta」：先落 N1，再加 N2 只追加 delta
    const store = createPersistStore({ port: createFsPort(), root });
    const g = createGoodGraphWithTwoNodes();
    const base = createGraph({ sessionId: "session-delta" });
    base.nodes = { n1: g.nodes.n1 };
    base.order = ["n1"];
    base.edges = {};
    base.nextNode = 2;
    store.flush({ id: "session-delta", cwd: "D:/tmp/proj" }, base);

    // 第二版：加入 n2 与它的边，只落 delta（非 tree）
    const full = createGoodGraphWithTwoNodes();
    const r = store.flush({ id: "session-delta", cwd: "D:/tmp/proj" }, full, { tree: true });
    t.eq(r.wroteDelta, true, "第二步必须走 delta 帧");

    // 磁盘上 graph.json 只有 n1；nodes/ 里两个文档都在
    const dir = nodePath.join(root, "sessions", "session-delta");
    t.eq(nodeFs.existsSync(nodePath.join(dir, "nodes", "n2.md")), true, "n2.md 必须已写出");
    const baseline = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
    t.eq(Object.keys(baseline.nodes).length, 1, "基线本身只该有 n1（证明 n2 只在 delta 里）");

    const rows = auditRoot(root);
    const problems = rows.find((row) => row.session === "session-delta")?.problems ?? [];
    t.eq(problems.length, 0, `重放 delta 后不该有任何问题：${JSON.stringify(problems)}`);

    // 反证：只用基线（不重放 delta）就会把 n2 当成「图里不存在」—— 正是审查 P1-2 的误报来源
    const baselineOnly = fromJSON(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
    t.eq(Object.keys(baselineOnly.nodes).includes("n2"), false, "基线确实看不到 n2（所以必须重放 delta）");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C144 补写缺失节点文档：只增不删、幂等、dry-run 不写盘"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-repair-"));
  try {
    const g = createGoodGraphWithTwoNodes();
    const dir = nodePath.join(root, "session-repair");
    nodeFs.mkdirSync(nodePath.join(dir, "nodes"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
    // 只写 n1.md；再放一个陈旧文件，确认补写不会删它
    nodeFs.writeFileSync(nodePath.join(dir, "nodes", "n1.md"), "n1", "utf8");
    nodeFs.writeFileSync(nodePath.join(dir, "nodes", "n999.md"), "stale", "utf8");

    // ① dry-run 不写盘
    const dry = repairMissingDocs(root, { dryRun: true });
    t.eq(dry.length > 0, true, `dry-run 也要报告缺哪些：${JSON.stringify(dry)}`);
    t.eq(nodeFs.existsSync(nodePath.join(dir, "nodes", "n2.md")), false, "dry-run 不许写盘");

    // ② 真跑：补齐缺失、保留陈旧
    const written = repairMissingDocs(root);
    t.eq(written.length, dry.length, "真跑的清单应与 dry-run 一致");
    for (const id of Object.keys(g.nodes)) {
      t.eq(nodeFs.existsSync(nodePath.join(dir, "nodes", `${id}.md`)), true, `${id}.md 必须被补写`);
    }
    t.eq(nodeFs.existsSync(nodePath.join(dir, "nodes", "n999.md")), true, "陈旧文件不许删（只增不删）");
    // 补写的内容必须是确定性渲染（与 renderNodeMd 一致）
    t.eq(nodeFs.readFileSync(nodePath.join(dir, "nodes", "n2.md"), "utf8").includes("n2"), true, "补写内容必须来自图");

    // ③ 幂等：第二次无事可做
    t.eq(repairMissingDocs(root).length, 0, "补齐后第二次必须无事可做");
    // ④ 补写后体检必须干净
    t.eq(auditRoot(root).find((r) => r.session === "session-repair").problems, [], "补写后不该再有问题");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C151 index.md 引用不存在的节点必须被点名（C142 P0 的表征：视图说存在、真相说没有）"] = (t) => {
  const NL = String.fromCharCode(10);
  const g = goodGraph();
  const ids = Object.keys(g.nodes);
  // 正常索引：只引用真实节点 ⇒ 0 问题
  t.eq(auditIndexText(g, [`- ${ids[0]} 目标做 A`, `- ${ids[1]} 目标做 B`].join(NL)), [], "只引用真实节点时不该有问题");
  // 坏索引：引用一个图里没有的节点
  const problems = auditIndexText(g, [`- ${ids[0]} ok`, "- n999 幽灵"].join(NL));
  t.eq(problems.length, 1, `必须点名 1 条：${JSON.stringify(problems)}`);
  t.includes(problems[0], "n999", "要带出具体 id");
  t.includes(problems[0], "index.md", "要说明是哪个文件");

  // 反向确认：auditRoot 会把 index.md 一起查
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-index-"));
  try {
    const dir = nodePath.join(root, "session-idx");
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
    nodeFs.writeFileSync(nodePath.join(dir, "index.md"), "- n999 幽灵" + NL, "utf8");
    const row = auditRoot(root).find((r) => r.session === "session-idx");
    t.eq(row.problems.some((p) => p.includes("n999")), true, `auditRoot 必须把 index.md 一起查：${JSON.stringify(row.problems)}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};
