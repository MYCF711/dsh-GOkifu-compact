/**
 * node-docs-prune.test.mjs —— 「在途 / 真缺失」两段 + `--prune` 清理（2026-11-05，C607）
 *
 * 两条硬要求，测试必须自己先红过一次：
 *
 * ① **在途不许补**。`nodes/*.md` 是节流写出的，刚创建的节点「md 还没轮到写」是正常中间态；
 *    这时补写出来的是**不完整快照**（节点还在长），比缺失更坏。旧实现把在途和真缺失混成一个数、
 *    一起补 —— 所以本文件里「在途的 md 必须**不存在**」这条断言，在旧实现下必红。
 *
 * ② **陈旧 md 默认不许删**。删除是不可逆动作：`--prune` 只预演，`--prune --write` 才真删，
 *    且三条护栏（只认 `^n[0-9]+\.md$` / 图不可信时一个都不删 / 先打印清单与总数）必须各自可验。
 *    旧实现没有 `--prune` —— 真删的用例在旧实现下必红（文件还在）。
 *
 * 真机 `chess-context/` 是真实数据：**本文件所有删除都发生在 os.tmpdir() 的临时 home 里**。
 */

import { spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { addAgentNode, createGraph, toJSON } from "./graph-fixtures.mjs";
import { IN_FLIGHT_MS, orphanNodeDocs, splitMissingNodeDocs } from "../scripts/repair-node-docs.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const REPAIR = nodePath.join(REPO, "scripts", "repair-node-docs.mjs");
const DOCTOR = nodePath.join(REPO, "scripts", "doctor.mjs");

export const tests = {};

/** 造一个临时 home（跑完由调用方删）。 */
function makeHome() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-node-docs-"));
}

/**
 * 造一个会话目录。`ages` 是每个 agent 节点的「创建至今 ms」——
 * 必须能自由控制，否则「刚创建 vs 一小时前」没法测。
 *
 * @param {string} home
 * @param {string} sid
 * @param {{ages?: number[], graphAgeMs?: number, mdFor?: number[]}} options
 *   `mdFor` 是要写 md 的节点序号（1 起）；不写就不建 nodes/。
 */
function makeSession(home, sid, { ages = [60_000], graphAgeMs = 60_000, mdFor = [] } = {}) {
  const dir = nodePath.join(home, "chess-context", "sessions", sid);
  nodeFs.mkdirSync(dir, { recursive: true });
  const graph = createGraph({ sessionId: sid });
  const ids = [];
  ages.forEach((ageMs, index) => {
    const { id } = addAgentNode(graph, { seq: (index + 1) * 10, goal: `goal #${index + 1}`, worldHash: `W${index}`, constraintHash: `C${index}` });
    graph.nodes[id].ts = Date.now() - ageMs;
    ids.push(id);
  });
  graph.updatedAt = Date.now() - graphAgeMs;
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(graph), "utf8");
  if (mdFor.length > 0) {
    const nodesDir = nodePath.join(dir, "nodes");
    nodeFs.mkdirSync(nodesDir, { recursive: true });
    for (const index of mdFor) nodeFs.writeFileSync(nodePath.join(nodesDir, `${ids[index - 1]}.md`), `# ${ids[index - 1]}\n`, "utf8");
  }
  return { dir, ids, nodesDir: nodePath.join(dir, "nodes") };
}


/** 跑 repair-node-docs（子进程，临时 home）。 */
function runRepair(home, ...args) {
  const result = spawnSync(process.execPath, [REPAIR, ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

/** 跑 doctor --json 并取出 C110 那一项。 */
function runDoctorC110(home) {
  const result = spawnSync(process.execPath, [DOCTOR, "--json"], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
  const payload = JSON.parse(String(result.stdout ?? "{}"));
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  return checks.find((check) => String(check?.name ?? "").startsWith("节点文档与棋谱一致")) ?? null;
}

const ls = (dir) => (nodeFs.existsSync(dir) ? nodeFs.readdirSync(dir).sort() : []);

// ───────────────────────────── 纯函数判据 ─────────────────────────────

tests["C607-1 在途的判据：图刚更新 **且** 节点刚创建 ⇒ 在途；任一不满足 ⇒ 真缺失"] = (t) => {
  const now = 1_800_000_000_000;
  t.eq(IN_FLIGHT_MS, 120_000, "在途窗口是 2 分钟（与 doctor 同一个常量，不许各写一套）");

  const graph = {
    updatedAt: now - 1_000,
    nodes: { n1: { ts: now - 500 }, n2: { ts: now - 3_600_000 } },
  };
  const split = splitMissingNodeDocs(graph, ["n1", "n2"], now);
  t.eq(split.inFlight.map((item) => item.id), ["n1"], "刚创建 + 图仍在写 ⇒ 在途");
  t.eq(split.missing, ["n2"], "图仍在写、但节点是一小时前建的 ⇒ 真缺失（C148：否则永久缺失会被永久掩盖）");

  const staticGraph = { updatedAt: now - 3_600_000, nodes: { n1: { ts: now - 500 } } };
  t.eq(splitMissingNodeDocs(staticGraph, ["n1"], now).missing, ["n1"], "图已静止 ⇒ 就算节点刚建也算真缺失（会话不会再来写了）");
  t.eq(splitMissingNodeDocs(staticGraph, ["n1"], now).inFlight.length, 0, "静止图不许有在途");

  const noTs = { updatedAt: now - 500, nodes: { n9: {} } };
  t.eq(splitMissingNodeDocs(noTs, ["n9"], now).missing, ["n9"], "ts 缺失 ⇒ 保守算真缺失（宁可多报，不许假绿）");
  t.eq(splitMissingNodeDocs(null, ["n1"], now).missing, ["n1"], "图缺失不许抛");
};

tests["C607-2 陈旧 md 只认 `^n[0-9]+\\.md$`（其它文件名一律不碰）"] = (t) => {
  const graph = { nodes: { n1: { ts: 1 } } };
  const orphans = orphanNodeDocs(graph, ["n1.md", "n900.md", "n901.md", "notes.md", "n902.md.bak", "README"]);
  t.eq(orphans, ["n900", "n901"], `只许点名 n<数字>.md：${JSON.stringify(orphans)}`);
  t.eq(orphanNodeDocs({ nodes: {} }, []), [], "空输入不许抛");
};

// ───────────────────────────── CLI：--write 跳过在途 ─────────────────────────────

tests["C607-3 --write 只补真缺失，在途一个都不补（补进去的是不完整快照）"] = (t) => {
  const home = makeHome();
  try {
    // 两个节点都没 md：n1 一小时前建的（真缺失）、n2 刚建的（在途，图也在写）
    const { nodesDir, ids } = makeSession(home, "session-mixed", { ages: [3_600_000, 1_000], graphAgeMs: 1_000 });
    t.eq(ls(nodesDir), [], "夹具起点：一个 md 都没有");

    const dry = runRepair(home);
    t.eq(dry.status, 1, `预演发现待办 ⇒ 退出码 1（实际 ${dry.status}：${dry.stderr}）`);
    t.includes(dry.stdout, "待补 1 个节点文档", `只把真缺失算进「待补」：${dry.stdout}`);
    t.includes(dry.stdout, "另有 1 个在途", `在途必须单列：${dry.stdout}`);
    t.eq(ls(nodesDir), [], "预演一个文件都不许写");

    const written = runRepair(home, "--write");
    t.eq(written.status, 0, `真补成功 ⇒ 退出码 0（实际 ${written.status}：${written.stderr}）`);
    t.includes(written.stdout, "已补写 1 个节点文档", `只补 1 个：${written.stdout}`);
    t.eq(ls(nodesDir), [`${ids[0]}.md`], `只许写出真缺失的那个 md，在途的 ${ids[1]} 不许有新文件`);
    t.includes(nodeFs.readFileSync(nodePath.join(nodesDir, `${ids[0]}.md`), "utf8"), ids[0], "补出来的 md 得有内容（不是空文件）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

// ───────────────────────────── CLI：--prune ─────────────────────────────

tests["C607-4 --prune 默认只预演（一个都不删），--prune --write 才删陈旧 md"] = (t) => {
  const home = makeHome();
  try {
    // 图里 2 个节点，md 都在；另造 2 个陈旧 md + 2 个「名字不合规」的文件
    const { nodesDir, ids } = makeSession(home, "session-prune", { ages: [60_000, 60_000], mdFor: [1, 2] });
    nodeFs.writeFileSync(nodePath.join(nodesDir, "n900.md"), "# 陈旧 900\n", "utf8");
    nodeFs.writeFileSync(nodePath.join(nodesDir, "n901.md"), "# 陈旧 901\n", "utf8");
    nodeFs.writeFileSync(nodePath.join(nodesDir, "notes.md"), "# 人写的笔记\n", "utf8");
    nodeFs.writeFileSync(nodePath.join(nodesDir, "n902.md.bak"), "备份\n", "utf8");
    const before = ls(nodesDir);
    t.eq(before.length, 6, `夹具起点 6 个文件：${JSON.stringify(before)}`);

    // ① 不加 --prune：连清单都不打，一个都不删
    const plain = runRepair(home, "--write");
    t.eq(plain.status, 0, `没有缺失也没有 --prune ⇒ 退出码 0（实际 ${plain.status}）`);
    t.notIncludes(plain.stdout, "将删除", `没给 --prune 不许出现删除清单：${plain.stdout}`);
    t.eq(ls(nodesDir), before, "没给 --prune 一个文件都不许少");
    t.includes(plain.stdout, "另有 2 个陈旧 md", "但要点出有几个陈旧 md（否则没人会去清）");

    // ② 只给 --prune：预演，仍然一个都不删
    const dry = runRepair(home, "--prune");
    t.eq(dry.status, 1, `--prune 预演发现待清理 ⇒ 退出码 1（实际 ${dry.status}）`);
    t.includes(dry.stdout, "陈旧 md 2 个", `总数要打出来：${dry.stdout}`);
    t.includes(dry.stdout, "将删除", "预演也要打「将删除」清单");
    t.includes(dry.stdout, "n900", "清单要列出将删的节点 id");
    t.eq(ls(nodesDir), before, `--prune 单独跑 = 预演，一个文件都不许删（实际：${JSON.stringify(ls(nodesDir))}）`);

    // ③ --prune --write：真删，且只删陈旧的那两个
    const pruned = runRepair(home, "--prune", "--write");
    t.eq(pruned.status, 0, `真删成功 ⇒ 退出码 0（实际 ${pruned.status}：${pruned.stderr}）`);
    t.includes(pruned.stdout, "已删除 2 个陈旧 md", `要报删了几个：${pruned.stdout}`);
    t.eq(ls(nodesDir), [`${ids[0]}.md`, `${ids[1]}.md`, "n902.md.bak", "notes.md"].sort(), `只剩活节点 md + 名字不合规的文件：${JSON.stringify(ls(nodesDir))}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C607-5 护栏：图不可信（空图 / 读不出）时 --prune --write 一个都不删"] = (t) => {
  const home = makeHome();
  try {
    // ① 空图（nodes/order 都是空）：这时「节点不在图里」对**所有** md 都成立 —— 删了就清空整个 nodes/
    const emptyDir = nodePath.join(home, "chess-context", "sessions", "session-empty");
    nodeFs.mkdirSync(nodePath.join(emptyDir, "nodes"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(emptyDir, "graph.json"), toJSON(createGraph({ sessionId: "session-empty" })), "utf8");
    nodeFs.writeFileSync(nodePath.join(emptyDir, "nodes", "n1.md"), "# 真节点的文档\n", "utf8");

    // ② 旧版本图：loadSessionGraph 直接抛 ⇒ 图不可信
    const legacyDir = nodePath.join(home, "chess-context", "sessions", "session-legacy");
    nodeFs.mkdirSync(nodePath.join(legacyDir, "nodes"), { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(legacyDir, "graph.json"),
      JSON.stringify({ version: 999, nodes: {}, edges: {}, order: [] }),
      "utf8",
    );
    nodeFs.writeFileSync(nodePath.join(legacyDir, "nodes", "n7.md"), "# 旧图的文档\n", "utf8");

    const before = [ls(nodePath.join(emptyDir, "nodes")), ls(nodePath.join(legacyDir, "nodes"))];
    const run = runRepair(home, "--prune", "--write");
    t.eq(run.status, 0, `没有可删的 ⇒ 退出码 0（实际 ${run.status}：${run.stderr}）`);
    t.includes(run.stdout, "跳过陈旧 md 清理", `空图必须明说「跳过清理」：${run.stdout}`);
    t.includes(run.stdout, "读不出", `读不出的会话必须点名：${run.stdout}`);
    t.eq(
      [ls(nodePath.join(emptyDir, "nodes")), ls(nodePath.join(legacyDir, "nodes"))],
      before,
      "护栏生效：图不可信时一个文件都不许删",
    );
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

// ───────────────────────────── doctor C110 两段 ─────────────────────────────

tests["C607-6 doctor C110：真缺失与在途分成两段，不许混成一个数"] = (t) => {
  const home = makeHome();
  try {
    // 静止会话（一小时没动）+ 一个真缺失；活跃会话（刚更新）+ 一个在途
    makeSession(home, "session-static", { ages: [3_600_000], graphAgeMs: 3_600_000 });
    makeSession(home, "session-live", { ages: [500], graphAgeMs: 500 });

    const row = runDoctorC110(home);
    t.eq(!!row, true, "必须有「节点文档与棋谱一致（C110）」这一项");
    t.eq(row.status, "warn", `真缺失是空指针风险 ⇒ warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "真缺失 1 个", `真缺失要单独成段：${row.detail}`);
    t.includes(String(row.detail), "在途 1 个", `在途要单独成段：${row.detail}`);
    t.includes(String(row.detail), "空指针", "要说明后果（热清单省略行会指向它们）");
    t.includes(String(row.detail), "不计入真缺失", "在途必须明说不计入缺失（否则读的人以为坏了）");
    t.eq(String(row.detail).includes("个节点缺"), false, `旧文案「N 个节点缺」把两段混成一个数，必须消失：${row.detail}`);

    // 只有在途 ⇒ 必须 ok（正常中间态，不是故障）
    const liveOnly = makeHome();
    try {
      makeSession(liveOnly, "session-live", { ages: [500], graphAgeMs: 500 });
      const liveRow = runDoctorC110(liveOnly);
      t.eq(liveRow.status, "ok", `只剩在途 ⇒ ok：${JSON.stringify(liveRow)}`);
      t.includes(String(liveRow.detail), "真缺失 0 个", `要明说真缺失是 0：${liveRow.detail}`);
      t.includes(String(liveRow.detail), "在途 1 个", `在途仍然要报出来：${liveRow.detail}`);
    } finally {
      nodeFs.rmSync(liveOnly, { recursive: true, force: true });
    }
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
