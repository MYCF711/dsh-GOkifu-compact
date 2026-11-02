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

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph, addUserNodeId, addAgentNode, addEdge, settleEdge, toJSON } from "./graph-fixtures.mjs";

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
  nodeFs.writeFileSync(
    nodePath.join(dir, "graph.json"),
    JSON.stringify({ nodes: { n1: { id: "n1", seq: 1 } }, edges: {}, order: ["n1"], foldMarks: [] }),
    "utf8",
  );
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
    t.includes(row.detail, "unsupported version", "要带出原始原因，便于判断该不该迁移");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
