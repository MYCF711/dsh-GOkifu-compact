/**
 * doctor-cli.test.mjs —— doctor 那几项「只有消费者、没有测试」的检查（2026-11-02，C66）
 *
 * 背景（专员审计 P2）：`fold 悬空 / fold 边界完整性 / 置换合并可追溯 / 热清单预算分项` 四项
 * 检查**没有任何测试引用** —— 它们恰好是合同 §6 里最容易悄悄失效的验收项。
 *
 * doctor 是脚本（模块级执行、无 export），这里用**子进程 + 临时 home** 测真实行为：
 * 造一个最小 home（chess-context/sessions/<sid>/graph.json + 可选 ledger-budget.json），
 * 跑 `node scripts/doctor.mjs --json`，断言指定检查项的状态与文案。
 *
 * 只读：临时目录在 os.tmpdir()，跑完删除；不碰 DSH_HOME。
 */

import { execFileSync, spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge, toJSON } from "./graph-fixtures.mjs";
import { encodeDeltaFrame, sha } from "../src/rooms/kifu-model.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

/** 造最小 home；`mutate(graph)` 可在落盘前改图。 */
function makeHome({ mutate = null, ledgerBudget = null, foreignPatch = null, foreignPatches = null } = {}) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-doctor-"));
  const dir = nodePath.join(root, "chess-context", "sessions", "session-doctor-1");
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = createGraph({ sessionId: "session-doctor-1" });
  const u = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  if (typeof mutate === "function") mutate(g);
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
  if (ledgerBudget !== null) {
    nodeFs.writeFileSync(nodePath.join(root, "chess-context", "ledger-budget.json"), JSON.stringify(ledgerBudget, null, 2), "utf8");
  }
  const patches = foreignPatches !== null ? foreignPatches : foreignPatch !== null ? [foreignPatch] : [];
  if (patches.length > 0) {
    const profDir = nodePath.join(root, "profiles", "desktop");
    for (const entry of patches) {
      nodeFs.mkdirSync(nodePath.join(profDir, "node_modules", entry.bundle), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(profDir, "node_modules", entry.bundle, "cordis.patch.yml"), entry.text, "utf8");
    }
    nodeFs.writeFileSync(
      nodePath.join(profDir, "package.json"),
      JSON.stringify({ name: "fixture-profile", dsh: { profile: { bundles: patches.map((p) => p.bundle) } } }, null, 2),
      "utf8",
    );
  }
  return root;
}

/** 跑 doctor --json，返回 {checks, byName(namePrefix)}。 */
function runDoctor(home) {
  // doctor 在「有警告/错误」时退出码非 0 —— execFileSync 会 throw，但 stdout 仍是完整 JSON
  let out;
  try {
    out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "doctor.mjs"), "--json"], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    out = error && typeof error.stdout === "string" ? error.stdout : "";
  }
  const payload = JSON.parse(out);
  return {
    checks: payload.checks,
    find: (prefix) => payload.checks.find((c) => String(c.name).startsWith(prefix)),
  };
}

tests["C66-1 fold 悬空：没有 dangling 记录 ⇒ warn「未采集」（不许报 ok）；全 0 ⇒ ok"] = (t) => {
  const none = makeHome({ mutate: (g) => { g.foldMarks = [{ at: Date.now(), seqStart: 1, seqEnd: 9 }]; } });
  try {
    const r = runDoctor(none);
    const row = r.find("fold 悬空（dangling）");
    t.eq(!!row, true, "必须有 fold 悬空检查项");
    t.eq(row.status, "warn", `未采集必须 warn：${JSON.stringify(row)}`);
    t.eq(String(row.detail).includes("未采集"), true, "文案要写「未采集」");
  } finally {
    nodeFs.rmSync(none, { recursive: true, force: true });
  }
  const zeros = makeHome({
    mutate: (g) => {
      g.foldMarks = [{ at: Date.now(), seqStart: 1, seqEnd: 9, dangling: { liveUnsettled: 0, fromBroken: 0, residue: 0, candidates: 0 } }];
    },
  });
  try {
    const row = runDoctor(zeros).find("fold 悬空（dangling）");
    t.eq(row.status, "ok", `全 0 应 ok：${JSON.stringify(row)}`);
  } finally {
    nodeFs.rmSync(zeros, { recursive: true, force: true });
  }
};

tests["C66-2 fold 边界完整性：openAtEnd>0 必须 error；=0 才 ok"] = (t) => {
  const bad = makeHome({
    mutate: (g) => {
      g.foldMarks = [{ at: Date.now(), seqStart: 1, seqEnd: 9, boundary: { overlapping: 2, openAtEnd: 1, unsettled: 1 } }];
    },
  });
  try {
    const row = runDoctor(bad).find("fold 边界完整性");
    t.eq(row.status, "error", `切在调用中间必须 error：${JSON.stringify(row)}`);
    t.eq(String(row.detail).includes("切点"), true, "文案要说清切点问题");
  } finally {
    nodeFs.rmSync(bad, { recursive: true, force: true });
  }
  const good = makeHome({
    mutate: (g) => {
      g.foldMarks = [{ at: Date.now(), seqStart: 1, seqEnd: 9, boundary: { overlapping: 2, openAtEnd: 0, unsettled: 0 } }];
    },
  });
  try {
    t.eq(runDoctor(good).find("fold 边界完整性").status, "ok", "切在 step 边界应 ok");
  } finally {
    nodeFs.rmSync(good, { recursive: true, force: true });
  }
};

tests["C66-3 置换合并可追溯：记录指向仍在图里的节点 ⇒ error；指向已消失节点 ⇒ ok"] = (t) => {
  const contradictory = makeHome({
    mutate: (g) => {
      const ids = Object.keys(g.nodes);
      const agentId = ids.find((id) => g.nodes[id].kind === "agent");
      // 记录指向一个**仍在图里**的节点 = 自相矛盾
      g.nodes[agentId].superseded = [{ id: ids[0], seq: 3, goal: "x" }];
      g.nodes[agentId].supersededCount = 1;
    },
  });
  try {
    const row = runDoctor(contradictory).find("置换合并可追溯");
    t.eq(row.status, "error", `自相矛盾必须 error：${JSON.stringify(row)}`);
    t.eq(String(row.detail).includes("自相矛盾"), true, "文案要说清矛盾");
  } finally {
    nodeFs.rmSync(contradictory, { recursive: true, force: true });
  }
  const fine = makeHome({
    mutate: (g) => {
      const ids = Object.keys(g.nodes);
      const agentId = ids.find((id) => g.nodes[id].kind === "agent");
      g.nodes[agentId].superseded = [{ id: "n-gone-1", seq: 3, goal: "x" }];
      g.nodes[agentId].supersededCount = 1;
    },
  });
  try {
    const row = runDoctor(fine).find("置换合并可追溯");
    t.eq(row.status, "ok", `记录指向已消失节点应 ok：${JSON.stringify(row)}`);
    t.eq(String(row.detail).includes("记录过合计"), true, "要报出合并次数");
  } finally {
    nodeFs.rmSync(fine, { recursive: true, force: true });
  }
};

tests["C66-4 热清单预算：无 ledger-budget.json ⇒ warn 未采集；分项占用进 detail"] = (t) => {
  const none = makeHome();
  try {
    const row = runDoctor(none).find("热清单预算");
    t.eq(row.status, "warn", `没有统计文件必须 warn：${JSON.stringify(row)}`);
    t.eq(String(row.detail).includes("未采集"), true, "文案要写未采集");
  } finally {
    nodeFs.rmSync(none, { recursive: true, force: true });
  }
  const withStats = makeHome({
    ledgerBudget: {
      none: 10,
      "over-budget": 0,
      impossible: 0,
      samples: 10,
      maxOverBudgetBy: 0,
      provenanceMin: 1,
      sectionsAvg: { root: 100, constraints: 100, failures: 600, options: 0, unverified: 0, path: 100, other: 0, total: 900 },
      minimalRenders: 7,
      renderErrors: 3,
      skipReasons: { identical: 12, "throttled-events": 4, "no-ledger": 2 },
      updatedAt: Date.now(),
    },
  });
  try {
    const r = runDoctor(withStats);
    const budget = r.find("热清单预算");
    t.eq(budget.status, "ok", `健康统计应 ok：${JSON.stringify(budget)}`);
    // 分项占用是独立检查项（「热清单分项占用（平均）」）——它才是 sectionsAvg 的消费者
    // C67：最小清单渲染次数必须出现在预算行（否则 minimal 字段又成死数据）
    t.eq(String(budget.detail).includes("最小清单"), true, `预算行应带最小清单次数：${budget.detail}`);
    // C90：注入渲染失败必须在预算行可见（否则「本该注入却没注入」在指标里消失）
    t.eq(String(budget.detail).includes("注入渲染失败 3 次"), true, `预算行应带渲染失败次数：${budget.detail}`);
    // C91：跳过原因分布（前 3 名）要出现在预算行
    t.eq(String(budget.detail).includes("跳过分布"), true, `预算行应带跳过分布：${budget.detail}`);
    t.eq(String(budget.detail).includes("identical=12"), true, `分布要带具体原因与次数：${budget.detail}`);
    const sections = r.find("热清单分项占用");
    t.eq(!!sections, true, "必须有分项占用检查项");
    t.eq(String(sections.detail).includes("失败边"), true, `detail 应给出失败边占比：${sections.detail}`);
    t.eq(String(sections.detail).includes("67%") || String(sections.detail).includes("66%"), true, `失败边占比应≈67%：${sections.detail}`);
  } finally {
    nodeFs.rmSync(withStats, { recursive: true, force: true });
  }
};

tests["C94 第三方 preset 仍用 compaction-basic ⇒ warn 并点名（设计边界，不强行覆盖）"] = (t) => {
  const NL = String.fromCharCode(10);
  const patchText = [
    "- insert:",
    "    - id: preset-design",
    "      name: dsh-foreign/preset",
    "      config:",
    "        id: design",
    "        plugins:",
    "          - id: compaction",
    "            group: true",
    "            config:",
    "              - id: compaction-basic",
    "                name: '@deepseek-ai/dsh-compaction-basic'",
  ].join(NL);
  const home = makeHome({ foreignPatch: { bundle: "dsh-foreign", text: patchText } });
  try {
    const row = runDoctor(home).find("第三方 preset 的压缩后端");
    t.eq(!!row, true, "必须有该检查项");
    t.eq(row.status, "warn", `第三方 preset 用 compaction-basic 应 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "preset-design", "要点名是哪个 preset");
    t.includes(row.detail, "不经过棋谱压缩", "要说明后果");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  // 没有第三方 bundle ⇒ 「未采集」ok（不是失败）
  const clean = makeHome();
  try {
    const row = runDoctor(clean).find("第三方 preset 的压缩后端");
    t.eq(row.status, "ok", "没有第三方 patch 应 ok");
    t.includes(row.detail, "未采集", "要写未采集");
  } finally {
    nodeFs.rmSync(clean, { recursive: true, force: true });
  }
};

tests["C95 preset 覆盖唯一性：两个 bundle 覆盖同一 preset ⇒ warn 点名（压缩后端可能被静默顶掉）"] = (t) => {
  const NL = String.fromCharCode(10);
  const mk = (bundle) =>
    ["- insert:", "    - id: preset-standard", `      name: ${bundle}/preset`, "      config:", "        id: standard", "        plugins: []"].join(NL);
  const home = makeHome({
    foreignPatches: [
      { bundle: "dsh-a", text: mk("dsh-a") },
      { bundle: "dsh-b", text: mk("dsh-b") },
    ],
  });
  try {
    const row = runDoctor(home).find("preset 覆盖唯一性");
    t.eq(!!row, true, "必须有该检查项");
    t.eq(row.status, "warn", `同一 preset 被两个 bundle 覆盖应 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "preset-standard", "要点名是哪个 preset");
    t.includes(row.detail, "dsh-a", "要列出覆盖者");
    t.includes(row.detail, "dsh-b", "要列出全部覆盖者");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  const single = makeHome({ foreignPatches: [{ bundle: "dsh-only", text: mk("dsh-only") }] });
  try {
    const row = runDoctor(single).find("preset 覆盖唯一性");
    t.eq(row.status, "ok", "只有一个覆盖者应 ok");
    t.includes(row.detail, "各只有一个覆盖者", "文案说明唯一");
  } finally {
    nodeFs.rmSync(single, { recursive: true, force: true });
  }
};

tests["C96 insert id 唯一性：撞到本插件 gokifu-ui ⇒ error；撞别的 id ⇒ warn；单 owner ⇒ ok"] = (t) => {
  const NL = String.fromCharCode(10);
  const mk = (ids) => ["- insert:", ...ids.flatMap((id) => [`    - id: ${id}`, `      name: ${id}/x`])].join(NL);

  const ours = makeHome({
    foreignPatches: [
      { bundle: "dsh-a", text: mk(["gokifu-ui"]) },
      { bundle: "dsh-b", text: mk(["gokifu-ui"]) },
    ],
  });
  try {
    const row = runDoctor(ours).find("insert id 唯一性");
    t.eq(!!row, true, "必须有该检查项");
    t.eq(row.status, "error", `撞到本插件 UI 行必须 error：${JSON.stringify(row)}`);
    t.includes(row.detail, "gokifu-ui", "要点名被撞的 id");
    t.includes(row.detail, "/gokifu/api", "要说明后果（设置页/API 消失）");
  } finally {
    nodeFs.rmSync(ours, { recursive: true, force: true });
  }

  const foreign = makeHome({
    foreignPatches: [
      { bundle: "dsh-a", text: mk(["dsh-other-row"]) },
      { bundle: "dsh-b", text: mk(["dsh-other-row"]) },
    ],
  });
  try {
    const row = runDoctor(foreign).find("insert id 唯一性");
    t.eq(row.status, "warn", `别人的 id 冲突是 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "dsh-other-row", "要点名冲突的 id");
  } finally {
    nodeFs.rmSync(foreign, { recursive: true, force: true });
  }

  const single = makeHome({ foreignPatches: [{ bundle: "dsh-only", text: mk(["dsh-only-row"]) }] });
  try {
    const row = runDoctor(single).find("insert id 唯一性");
    t.eq(row.status, "ok", "单 owner 应 ok");
    t.includes(row.detail, "各只有一个 owner", "文案说明唯一");
  } finally {
    nodeFs.rmSync(single, { recursive: true, force: true });
  }
};

tests["C110 会话图有节点但缺 nodes/<id>.md ⇒ warn（热清单省略行会指向它）"] = (t) => {
  const NL = String.fromCharCode(10);
  const home = makeHome();
  const sid = "session-c110";
  const dir = nodePath.join(home, "chess-context", "sessions", sid);
  nodeFs.mkdirSync(nodePath.join(dir, "nodes"), { recursive: true });
  // 用**合法图**（有 version；否则 fromJSON 直接抛，doctor 会跳过该会话 —— 见 C146）
  const legacyGraph = createGraph({ sessionId: "session-c110" });
  const uid = addUserNodeId(legacyGraph, { seq: 1, text: "把测试跑绿" });
  legacyGraph.updatedAt = Date.now() - 3_600_000; // 一小时前 = 会话已静止 ⇒ 缺文档是真问题
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(legacyGraph), "utf8");
  void uid;
  try {
    const row = runDoctor(home).find("节点文档与棋谱一致");
    t.eq(!!row, true, "必须有该检查项");
    t.eq(row.status, "warn", `缺节点文档必须 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "空指针", "要说明后果");
    // 补上**所有**会话的文档后应恢复 ok（makeHome 的默认会话也有两个节点）
    const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
    for (const name of nodeFs.readdirSync(sessionsRoot)) {
      const sessionDir = nodePath.join(sessionsRoot, name);
      const graphFile = nodePath.join(sessionDir, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      const graph = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
      nodeFs.mkdirSync(nodePath.join(sessionDir, "nodes"), { recursive: true });
      for (const id of Object.keys(graph.nodes ?? {})) {
        nodeFs.writeFileSync(nodePath.join(sessionDir, "nodes", id + ".md"), "node " + id + NL, "utf8");
      }
    }
    t.eq(runDoctor(home).find("节点文档与棋谱一致").status, "ok", "补齐后应 ok");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C140 doctor 必须对结构坏掉的图报 error（悬空边不会被「看起来正常」掩盖）"] = (t) => {
  const home = makeHome({
    mutate: (g) => {
      // 把第一条边的 to 指向不存在的节点（悬空边）
      const id = Object.keys(g.edges)[0];
      if (id) g.edges[id].to = "n999";
    },
  });
  try {
    const row = runDoctor(home).find("棋谱结构自洽");
    t.eq(!!row, true, "必须有该检查项");
    t.eq(row.status, "error", `悬空边必须 error：${JSON.stringify(row)}`);
    t.includes(row.detail, "不自洽", "要说明有几个会话不自洽");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C145 旧版本图（version 不符）必须 warn 而不是 error —— 它不是损坏，别让 doctor 永久红"] = (t) => {
  const home = makeHome();
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "session-legacy");
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(dir, "graph.json"),
      JSON.stringify({ version: 999, nodes: {}, edges: {}, order: [], foldMarks: [] }),
      "utf8",
    );
    const row = runDoctor(home).find("棋谱结构自洽");
    t.eq(row.status, "warn", `旧版本图应 warn（不是 error）：${JSON.stringify(row)}`);
    t.includes(row.detail, "旧版本图", "detail 必须点明「旧版本图，不是损坏」");
    t.includes(row.detail, "v999", "要带出文件里的版本号（判据来自 raw.version，不是错误文案）");
    t.includes(row.detail, "停窗", "要写清「升级/降级前先停窗备份」——引擎读到会重建空图");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C146 活跃会话里「刚建的节点还没写出 md」必须算在途，不许报警（delta 重放后才看得见）"] = (t) => {
  const home = makeHome({
    mutate: (g) => {
      g.updatedAt = Date.now(); // 图刚更新 = 会话仍在跑
    },
  });
  try {
    const row = runDoctor(home).find("节点文档与棋谱一致");
    t.eq(row.status, "ok", `活跃会话的在途文档不许报警：${JSON.stringify(row)}`);
    t.includes(row.detail, "在途", "detail 必须说明「在途」而不是假装齐全");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C148 缺 version 的坏图必须 error（不许因为文案含 unsupported version 被降级成 warn）"] = (t) => {
  const home = makeHome();
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "session-garbage");
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify({ nodes: {}, edges: {}, order: [] }), "utf8");
    const structure = runDoctor(home).find("棋谱结构自洽");
    t.eq(structure.status, "error", `缺 version 是坏图，必须 error：${JSON.stringify(structure)}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C148 C110 不许把「被跳过的会话」说成齐全/没有图（复审 P1-1）"] = (t) => {
  const home = makeHome();
  try {
    // 把默认会话改成不可读（version 缺失），并删掉它的 nodes 目录，制造「没有任何可读会话」的局面
    const dir = nodePath.join(home, "chess-context", "sessions", "session-doctor-1");
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify({ nodes: {}, edges: {}, order: [] }), "utf8");
    nodeFs.rmSync(nodePath.join(dir, "nodes"), { recursive: true, force: true });
    const row = runDoctor(home).find("节点文档与棋谱一致");
    t.eq(row.status, "warn", `有会话被跳过时必须 warn：${JSON.stringify(row)}`);
    t.eq(row.detail.includes("没有会话图"), false, `不许说「没有会话图」（真相是 1 个被跳过）：${row.detail}`);
    t.includes(row.detail, "被跳过", "要说明有会话被跳过");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C148 delta 帧无法回放必须报出来（不许停在部分回放还报「全部自洽」）"] = (t) => {
  const home = makeHome();
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "session-doctor-1");
    const graphText = nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8");
    // 造一帧**格式合法但版本不认识**的 delta：解码通过、applyDelta 抛错 ⇒ 曾经被静默吞掉
    const frame = encodeDeltaFrame(sha(graphText).slice(0, 16), { v: 2, nodes: {}, edges: {}, scalars: {} });
    nodeFs.writeFileSync(`${nodePath.join(dir, "graph.json")}.delta.jsonl`, frame, "utf8");
    const row = runDoctor(home).find("棋谱结构自洽");
    t.eq(row.status === "error" || row.status === "warn", true, `坏 delta 必须报：${JSON.stringify(row)}`);
    t.eq(/delta|回放/.test(row.detail), true, `detail 必须提到 delta/回放：${row.detail}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C180 活跃会话里「index 落后 graph」不算陈旧（C146 同族假警报）；静止会话才算"] = (t) => {
  // ① 活跃：graph 刚更新、index 很旧 ⇒ 必须 ok（还没到 fold，index 本来就不重写）
  const active = makeHome({
    mutate: (g) => {
      g.updatedAt = Date.now();
    },
  });
  try {
    const dir = nodePath.join(active, "chess-context", "sessions", "session-doctor-1");
    nodeFs.writeFileSync(nodePath.join(dir, "index.md"), "- 旧索引" + String.fromCharCode(10), "utf8");
    const old = Date.now() - 3_600_000;
    nodeFs.utimesSync(nodePath.join(dir, "index.md"), old / 1000, old / 1000);
    const row = runDoctor(active).find("树新鲜度");
    t.eq(row.status, "ok", `活跃会话不该报陈旧：${JSON.stringify(row)}`);
    t.includes(row.detail, "0 个", "计数应为 0");
  } finally {
    nodeFs.rmSync(active, { recursive: true, force: true });
  }

  // ② 静止：graph 与 index 都老，且 index 更老 ⇒ 才算陈旧
  const idle = makeHome();
  try {
    const dir = nodePath.join(idle, "chess-context", "sessions", "session-doctor-1");
    nodeFs.writeFileSync(nodePath.join(dir, "index.md"), "- 旧索引" + String.fromCharCode(10), "utf8");
    const t1 = (Date.now() - 3_600_000) / 1000;
    const t2 = (Date.now() - 7_200_000) / 1000;
    nodeFs.utimesSync(nodePath.join(dir, "graph.json"), t1, t1);
    nodeFs.utimesSync(nodePath.join(dir, "index.md"), t2, t2);
    const row = runDoctor(idle).find("树新鲜度");
    t.eq(row.status, "warn", `静止会话的陈旧 index 必须报：${JSON.stringify(row)}`);
  } finally {
    nodeFs.rmSync(idle, { recursive: true, force: true });
  }
};

tests["C186 重启后一条命令验收：有 buildId 通过、无 buildId 失败（且基线从证据文件读）"] = (t) => {
  const mkHome = (buildId) => {
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-after-"));
    nodeFs.mkdirSync(nodePath.join(home, "chess-context", "sessions"), { recursive: true });
    const stamp = { schema: "gokifu/build-stamp/v1", version: "1.17.1", startedAt: Date.now(), pid: 1234 };
    if (buildId !== null) stamp.buildId = buildId;
    nodeFs.writeFileSync(nodePath.join(home, "chess-context", "build.json"), JSON.stringify(stamp), "utf8");
    return home;
  };
  const run = (home) =>
    spawnSync(process.execPath, [nodePath.join(HERE, "..", "scripts", "after-restart.mjs"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home },
    });

  const good = mkHome("c5a95ee3e4b8");
  try {
    const r = run(good);
    t.eq(r.status, 0, `新进程应通过：${String(r.stderr).slice(0, 200)}`);
    const payload = JSON.parse(r.stdout);
    t.eq(payload.ok, true, "ok=true");
    const buildRow = payload.rows.find((x) => x.id.includes("buildId"));
    t.eq(buildRow.level, "ok", "buildId 检查应为 ok");
    t.includes(buildRow.detail, "c5a95ee3e4b8", "detail 里要有 buildId");
  } finally {
    nodeFs.rmSync(good, { recursive: true, force: true });
  }

  const bad = mkHome(null);
  try {
    const r = run(bad);
    t.eq(r.status, 1, "无 buildId 必须 exit 1");
    const payload = JSON.parse(r.stdout);
    t.eq(payload.ok, false, "ok=false");
  } finally {
    nodeFs.rmSync(bad, { recursive: true, force: true });
  }
};

tests["C193 doctor 必须报「观测字段覆盖」：部分落盘=ok 并列出缺口，一个都没有=warn"] = (t) => {
  // ① 有 skipReasons、无其余 ⇒ ok，detail 点出缺哪些
  const partial = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(partial, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 3, none: 3, skipReasons: { "throttled-events": 1 } }),
      "utf8",
    );
    const row = runDoctor(partial).find("观测字段覆盖");
    t.eq(row.status, "ok", `部分落盘应 ok：${JSON.stringify(row)}`);
    t.includes(row.detail, "1/5", "必须报已落盘数量");
    t.includes(row.detail, "renderErrors", "必须点名缺的字段");
  } finally {
    nodeFs.rmSync(partial, { recursive: true, force: true });
  }

  // ② 一个都没有（文件存在但只有旧键）⇒ warn
  const none = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(none, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 1, none: 1, "over-budget": 0 }),
      "utf8",
    );
    const row = runDoctor(none).find("观测字段覆盖");
    t.eq(row.status, "warn", `一个都没有应 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "0/5", "必须报 0/5");
  } finally {
    nodeFs.rmSync(none, { recursive: true, force: true });
  }
};

tests["C195 doctor 必须报「注入命中率」（光看渲染次数看不出模型实际看到几次清单）"] = (t) => {
  const home = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(home, "chess-context", "ledger-budget.json"),
      JSON.stringify({
        samples: 100,
        none: 90,
        "over-budget": 10,
        impossible: 0,
        provenanceMin: 1,
        provenanceLow: 0,
        skipReasons: { "throttled-events": 80, "throttled-failures": 10 },
      }),
      "utf8",
    );
    const row = runDoctor(home).find("热清单预算（fallback）");
    t.includes(row.detail, "清单写入 10/100（10%", `必须算出写入占比：${row.detail}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  // 没有 skipReasons（旧版本）⇒ 明确写「未采集」，不能假装 100%
  const legacy = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(legacy, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 5, none: 5, "over-budget": 0, impossible: 0 }),
      "utf8",
    );
    const row = runDoctor(legacy).find("热清单预算（fallback）");
    t.includes(row.detail, "清单写入=未采集", "旧数据必须写未采集");
  } finally {
    nodeFs.rmSync(legacy, { recursive: true, force: true });
  }
};

tests["C196 doctor 必须报「fold 新鲜度」：距上次 fold 的事件数（只观测不判断）"] = (t) => {
  const home = makeHome({
    mutate: (g) => {
      g.foldMarks = [{ at: Date.now() - 3_600_000, seqStart: 1, seqEnd: 100, trigger: "pressure" }];
      g.foldCount = 1;
    },
  });
  try {
    const row = runDoctor(home).find("fold 新鲜度");
    t.eq(row.status, "ok", `应为 ok：${JSON.stringify(row)}`);
    t.includes(row.detail, "事件", "detail 必须带事件数");
    t.includes(row.detail, "只是观测", "必须声明「只是观测，不判断」——避免被当门禁");
    t.eq(/\+\d+ 事件/.test(row.detail), true, `必须给出 +N 事件：${row.detail}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }

  // 没有 foldMarks ⇒ warn（观测不到），且不能崩
  const empty = makeHome({ mutate: (g) => { g.foldMarks = []; g.foldCount = 0; } });
  try {
    const row = runDoctor(empty).find("fold 新鲜度");
    t.eq(row.status, "warn", `无记录应 warn：${JSON.stringify(row)}`);
  } finally {
    nodeFs.rmSync(empty, { recursive: true, force: true });
  }
};

tests["C197 doctor 必须报「fold 压力（token/阈值）」：有快照显示百分比与差距，没快照明确写未采集"] = (t) => {
  const withPressure = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(withPressure, "chess-context", "ledger-budget.json"),
      JSON.stringify({
        samples: 1,
        none: 1,
        "over-budget": 0,
        impossible: 0,
        provenanceMin: 1,
        pressure: { session: "s1", tokens: 313879, threshold: 450000, remaining: 136121, trigger: "pressure", at: Date.now() - 5000 },
      }),
      "utf8",
    );
    const row = runDoctor(withPressure).find("fold 压力");
    t.eq(row.status, "ok", `有快照应 ok：${JSON.stringify(row)}`);
    t.includes(row.detail, "70%", `必须给百分比：${row.detail}`);
    t.includes(row.detail, "136,121", "必须给距阈值还差多少（带千分位）");
  } finally {
    nodeFs.rmSync(withPressure, { recursive: true, force: true });
  }

  const without = makeHome();
  try {
    nodeFs.writeFileSync(
      nodePath.join(without, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 1, none: 1, "over-budget": 0, impossible: 0, provenanceMin: 1 }),
      "utf8",
    );
    const row = runDoctor(without).find("fold 压力");
    t.eq(row.status, "warn", `无快照应 warn：${JSON.stringify(row)}`);
    t.includes(row.detail, "未采集", "必须写未采集（不能假装健康）");
  } finally {
    nodeFs.rmSync(without, { recursive: true, force: true });
  }
};

tests["C206 tier-2 合并的摘要引用「区间外 id」不算问题（合并语义），常规 fold 才算"] = (t) => {
  // ① 只有 tier2 的越界 id ⇒ 不许出现「越界 id」这一行
  const tier2Only = makeHome({
    mutate: (g) => {
      g.foldMarks = [
        { at: Date.now(), seqStart: 1, seqEnd: 2, tier2: true, trigger: "tier2", quality: { constraintRecall: 1, failureRecall: 1, outOfRangeIds: ["n9"] } },
      ];
      g.foldCount = 1;
    },
  });
  try {
    const rows = runDoctor(tier2Only);
    const row = rows.find("压缩摘要的越界");
    t.eq(row === undefined || row === null, true, `tier-2 的越界 id 不许报（这是合并语义）：${JSON.stringify(row)}`);
  } finally {
    nodeFs.rmSync(tier2Only, { recursive: true, force: true });
  }

  // ② 常规 fold 的「越界**更早**」⇒ C212 起算正常（回溯历史 kifu），必须是 ok 且明说
  const earlier = makeHome({
    mutate: (g) => {
      g.foldMarks = [
        { at: Date.now(), seqStart: 10, seqEnd: 20, trigger: "pressure", quality: { constraintRecall: 1, failureRecall: 1, outOfRangeIds: ["n2"] } },
      ];
      g.foldCount = 1;
    },
  });
  try {
    const row = runDoctor(earlier).find("压缩摘要的越界");
    if (row === undefined || row === null) throw new Error("越界 id 必须有一行结论（哪怕是 ok）");
    t.eq(row.status, "ok", `引用更早的实体应判 ok：${JSON.stringify(row)}`);
    t.includes(row.detail, "回溯历史", "必须说明为什么正常");
  } finally {
    nodeFs.rmSync(earlier, { recursive: true, force: true });
  }

  // ③ 引用**更晚**的实体 ⇒ 折叠时那段还不存在，必须报（真偏差）
  const later = makeHome({
    mutate: (g) => {
      g.foldMarks = [
        { at: Date.now(), seqStart: 10, seqEnd: 20, trigger: "pressure", quality: { constraintRecall: 1, failureRecall: 1, outOfRangeIds: ["n99"], outOfRangeLater: ["n99"] } },
      ];
      g.foldCount = 1;
    },
  });
  try {
    const row = runDoctor(later).find("压缩摘要的越界");
    if (row === undefined || row === null) throw new Error("引用更晚的实体必须报出来");
    t.eq(row.status, "warn", "必须是 warn");
    t.includes(row.detail, "n99", "必须点名具体 id");
    t.includes(row.detail, "更晚", "必须说明是「更晚」这一侧");
  } finally {
    nodeFs.rmSync(later, { recursive: true, force: true });
  }
};
