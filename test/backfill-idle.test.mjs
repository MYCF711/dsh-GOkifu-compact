/**
 * backfill-idle.test.mjs —— 「欠账清零之后」的五条守卫（C647）
 *
 * 由来（真机 2026-11-05 06:5x）：欠账 47 个会话 / 16,632 事件 / 需 81 段，近 1 小时折了 100+ 段。
 * **清零之后会发生什么，此前没有任何一条测试管**，而这一段的失败方式全是"安静地错"：
 *
 *   ① 清理：`debtOfGraph` 归零之后，`stopped` 会出现**协议表外的取值**（`"empty"` / `"empty-response"`）——
 *      它们由 `offlineFoldOutcome` 的 `result?.failed ?? "empty"` 产生，而"只抓字面量"的
 *      `test/fold-protocol.test.mjs` 按构造抓不到 `??` 右侧那一个 ⇒「没登记」是隐形的。
 *   ② 空转：清零后定时器每 10 分钟仍然跑一轮 —— 它**不许**写图、**不许**打"干了活"的日志。
 *   ③ 误报：`doctor`「自动补账结局」在没欠账时**不许**判"停了 / 本版可能需要重启"。
 *   ④ 漏捡：清零之后**新归档**的会话必须被同一台定时器捡起来（**不需要重启**）。
 *
 * 全部用夹具（`mkdtemp`）+ 假 DSH（`test/engine-harness.test.mjs`），不碰真实 home。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import {
  runOfflineFold,
  offlineFoldOutcome,
  isKnownStopped,
  STOPPED_REASONS,
  STOPPED_DONE,
  STOPPED_EMPTY,
  STOPPED_EMPTY_RESPONSE,
} from "../src/rooms/offline-fold.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
/** 停止原因的源码扫描范围（与 `test/fold-protocol.test.mjs` 同一组文件）。 */
const PROTOCOL_FILES = [
  "src/engine.mjs",
  "src/rooms/closeout-plan.mjs",
  "src/rooms/offline-fold.mjs",
  "src/rooms/closeout-backfill.mjs",
];

/* ────────────────────────── ① 协议表 ────────────────────────── */

/** 从源码里抓 `stopped: "xxx"` 字面量（与 fold-protocol 同一条正则；模板字符串不算）。 */
function stoppedLiterals(source) {
  return [...String(source ?? "").matchAll(/stopped:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

/** 从源码里抓 `STOPPED_XXX` 常量引用（`offlineFoldOutcome` 改成常量之后的那条路）。 */
function stoppedConstants(source) {
  return [...new Set([...String(source ?? "").matchAll(/\b(STOPPED_[A-Z_]+)\b/g)].map((m) => m[1]))];
}

tests["C647① 每个 stopped 字面量都必须在 STOPPED_REASONS 里登记"] = (t) => {
  const unknown = [];
  for (const rel of PROTOCOL_FILES) {
    for (const literal of stoppedLiterals(nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8"))) {
      if (!Object.prototype.hasOwnProperty.call(STOPPED_REASONS, literal)) unknown.push(`${rel}: ${literal}`);
    }
  }
  t.eq(unknown, [], `出现了没登记的停止原因（下游认不出它算不算"放弃"）：${unknown.join(", ")}`);
};

tests["C647① STOPPED_* 常量必须都登记（`??` 右侧那个字面量以前躲过了扫描）"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "offline-fold.mjs"), "utf8");
  const used = stoppedConstants(src);
  t.ok(used.length >= 2, `offline-fold.mjs 里应该引用常量而不是内联字面量（实际 ${used.join(", ") || "无"}）`);
  // 常量名 → 导出值（只认本模块导出的那几个；`STOPPED_REASONS` 是表本身，跳过）
  const values = { STOPPED_DONE, STOPPED_EMPTY, STOPPED_EMPTY_RESPONSE, STOPPED_DEADLINE: "deadline" };
  for (const name of used) {
    if (name === "STOPPED_REASONS") continue;
    t.ok(name in values, `源码引用了未定义的常量 ${name}`);
    t.eq(isKnownStopped(values[name]), true, `${name} = ${JSON.stringify(values[name])} 必须在 STOPPED_REASONS 里`);
  }
  // 这两个是 C647 补登记的：`due = 0` 的空区间与"模型交空回答"
  t.eq(STOPPED_EMPTY, "empty", "空区间的停止原因");
  t.eq(STOPPED_EMPTY_RESPONSE, "empty-response", "模型空回答的停止原因");
  t.eq(isKnownStopped("no-such-reason"), false, "表外的值必须判否（否则这张表没有意义）");
};

tests["C647① 协议表本身：12 项、值非空、是冻结对象"] = (t) => {
  const reasons = Object.keys(STOPPED_REASONS);
  t.eq(reasons.length, 12, `登记项数（实际 ${reasons.join(", ")}）`);
  t.eq(Object.isFrozen(STOPPED_REASONS), true, "协议表要冻结（运行时改它 = 下游静默改语义）");
  for (const [reason, why] of Object.entries(STOPPED_REASONS)) {
    t.eq(typeof why === "string" && why.trim() !== "", true, `${reason} 的语义必须写清`);
  }
  // 历史值一个都不许掉（fold-protocol.test.mjs 的那张表是这 10 个 + 本轮补的 2 个）
  for (const legacy of ["deadline", "no-op", "error", "done", "busy", "no-log", "empty-log", "no-range", "no-model", "inactive-context"]) {
    t.eq(isKnownStopped(legacy), true, `${legacy} 曾经登记过，不许掉`);
  }
};

/* ────────────────────────── ② due = 0 时的 stopped ────────────────────────── */

tests["C647② due = 0（空区间）时 runOfflineFold 不调模型、outcome 的 stopped 登记过"] = async (t) => {
  const graph = {
    nodes: { n1: { id: "n1", kind: "user", seq: 1, text: "x" }, n24: { id: "n24", kind: "agent", seq: 24, text: "y" } },
    edges: {},
    foldMarks: [{ seqStart: 1, seqEnd: 24, trigger: "archive" }],
    closeout: { source: "archive", foldAttempted: true, folded: 1 },
  };
  const debt = debtOfGraph(graph);
  t.eq(debt.due, false, "夹具必须零欠账");
  let calls = 0;
  const result = await runOfflineFold({
    graph,
    events: [],
    rangeStart: Number(debt.lastFoldSeq) + 1,
    rangeEnd: Number(debt.maxSeq),
    callModel: async () => {
      calls += 1;
      throw new Error("空区间不许调模型");
    },
    measureQuality: () => null,
  });
  t.eq(calls, 0, "空区间一次模型都不许调（空转不花钱）");
  t.eq(result.chunks.length, 0, "空区间不许产出 chunk");
  t.eq(result.failed, undefined, "空区间不是失败：不许带 failed");
  const outcome = offlineFoldOutcome(result, { rangeStart: 25, rangeEnd: 24, maxSeq: 24 });
  t.eq(outcome.stopped, STOPPED_EMPTY, `outcome 必须交 STOPPED_EMPTY（实际 ${outcome.stopped}）`);
  t.eq(isKnownStopped(outcome.stopped), true, "这个值必须在协议表里（否则状态文件里出现没人认得的结局）");
  t.eq(outcome.partial, true, "没折成就是 partial");
  t.eq(outcome.folded, 0, "折了 0 段");
};

tests["C647② 模型交空回答 ⇒ stopped = empty-response（必须登记）"] = (t) => {
  const outcome = offlineFoldOutcome({ chunks: [], failed: STOPPED_EMPTY_RESPONSE }, { rangeStart: 1, rangeEnd: 5, maxSeq: 5 });
  t.eq(outcome.stopped, "empty-response", "空回答要能自证");
  t.eq(isKnownStopped(outcome.stopped), true, "empty-response 必须在协议表里");
  // 正常路径不受影响
  const done = offlineFoldOutcome({ chunks: [{}], coveredStart: 1, coveredEnd: 5, uncoveredHead: 0, uncoveredTail: 0 }, { rangeStart: 1, rangeEnd: 5, maxSeq: 5 });
  t.eq(done.stopped, STOPPED_DONE, "折完了就是 done");
  t.eq(done.partial, false, "全覆盖不算 partial");
};

/* ────────────────────────── ③④ 定时器（真 tick） ────────────────────────── */

/** 「零欠账」夹具 + 一个真引擎。整个文件只建一次（`load()` 自带缓存）。 */
let fixture = null;
async function makeFixture() {
  if (fixture !== null) {
    // ★ 缓存命中也要**重新指回夹具**：上一个用例的 finally 已经把 DSH_HOME 还原成真实 home 了
    process.env.DSH_HOME = fixture.home;
    return fixture;
  }
  const harness = await import(pathToFileURL(nodePath.join(HERE, "engine-harness.test.mjs")).href);
  const { Engine } = await harness.load();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bf-idle-"));
  const chess = nodePath.join(home, "chess-context");
  const sessions = nodePath.join(chess, "sessions");
  const logs = nodePath.join(home, "sessions", "--ws--");
  const now = Date.now();
  const writeGraph = (id, graph) => {
    const dir = nodePath.join(sessions, id);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph, null, 1), "utf8");
    return graph;
  };
  /** 已折叠到位的图（mark + closeout 都在 ⇒ `debtOfGraph.due === false`）。 */
  const idleGraph = (id) => ({
    version: 1,
    sessionId: id,
    cwd: home,
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "把补账跑通", constraints: ["不许改真实 home"], ts: now },
      n24: { id: "n24", kind: "agent", seq: 24, text: "末", ts: now },
    },
    edges: {},
    order: ["n1", "n24"],
    stateIndex: {},
    foldMarks: [{ seqStart: 1, seqEnd: 24, trigger: "archive", at: now - 3_600_000 }],
    closeout: { at: now - 3_600_000, source: "archive", foldAttempted: true, folded: 1 },
    updatedAt: now - 3_600_000,
  });
  writeGraph("idle-a", idleGraph("idle-a"));
  writeGraph("idle-b", idleGraph("idle-b"));
  // 默认模型（离线补折要解析 provider/model）
  nodeFs.mkdirSync(nodePath.join(home, "profiles", "desktop"), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(home, "profiles", "desktop", "cordis.patch.yml"),
    ["- id: agent-default-model", "  provider: fixture-provider", "  model: fixture-model", ""].join("\n"),
    "utf8",
  );
  const ctx = harness.makeCtx();
  const infoLogs = [];
  ctx.logger.info = (message) => infoLogs.push(String(message));
  // ★ 引擎的 `resolveHome()` 读环境变量 —— 只在本测试内指向夹具，退出时还原
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const engine = new Engine(ctx, { graphDir: chess, auto: false, closeoutMinEvents: 40 });
  // 模型桩：必须是异步生成器（引擎是 `for await`）
  ctx.llm.stream = async function* () {
    yield { type: "text-delta", text: ["## 目标", "- 把补账跑通", "## 约束", "- 不许改真实 home", "## 当前节点", "- n200"].join("\n") };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 } };
  };
  fixture = {
    home,
    chess,
    sessions,
    logs,
    ctx,
    engine,
    infoLogs,
    writeGraph,
    readState: () => JSON.parse(nodeFs.readFileSync(nodePath.join(chess, "auto-backfill-state.json"), "utf8")),
    readGraph: (id) => JSON.parse(nodeFs.readFileSync(nodePath.join(sessions, id, "graph.json"), "utf8")),
    restore: () => {
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
    },
  };
  return fixture;
}

tests["C647③ 空转：清零后连打 10 轮 —— 不挑人、不写图、不打「干了活」的日志"] = async (t) => {
  const f = await makeFixture();
  try {
    const before = f.readGraph("idle-a").foldMarks.length;
    const logsBefore = f.infoLogs.length;
    for (let i = 0; i < 10; i += 1) {
      const result = await f.engine.runAutoBackfillOnce();
      t.eq(result?.ok, true, `第 ${i + 1} 轮不许抛`);
    }
    const state = f.readState();
    t.eq(state.due, 0, "状态文件要写 due: 0");
    t.eq(state.picked, [], "零欠账时一个人都不挑");
    t.eq(state.results, [], "零欠账时没有结局记录");
    t.eq(f.readGraph("idle-a").foldMarks.length, before, "空转不许写图（foldMarks 一条都不许多）");
    // 空转可以写一行"跳过"之类的 info，但**不许**出现"干了活"的三条
    const worked = f.infoLogs.slice(logsBefore).filter((line) => /离线补折|自动补账完成|自动补账失败/.test(line));
    t.eq(worked, [], `空转不许打「干了活」的日志：${worked.join(" / ")}`);
  } finally {
    f.restore();
  }
};

tests["C647④ 漏捡：清零后新归档的会话，同一台定时器下一轮就捡（不需要重启）"] = async (t) => {
  const f = await makeFixture();
  try {
    // ① 新归档一个会话：图 + 日志（离线补折的唯一数据源）
    const id = "fresh-archive";
    f.writeGraph(id, {
      version: 1,
      sessionId: id,
      cwd: f.home,
      rootUserNodeIds: ["n1"],
      nodes: { n1: { id: "n1", kind: "user", seq: 1, text: "把补账跑通", constraints: ["不许改真实 home"], ts: Date.now() }, n200: { id: "n200", kind: "agent", seq: 200, text: "末", ts: Date.now() } },
      edges: {},
      order: ["n1", "n200"],
      stateIndex: {},
      foldMarks: [],
      updatedAt: Date.now(),
    });
    const logDir = nodePath.join(f.logs, `session-${id}`);
    nodeFs.mkdirSync(logDir, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 200; i += 1) {
      lines.push(
        JSON.stringify({ seq: i, type: i % 2 === 1 ? "user/message" : "assistant/message", data: { message: { content: [{ type: "text", text: `第 ${i} 步` }] } } }),
      );
    }
    const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
    nodeFs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`, "utf8")));
    // 做旧：tick 会跳过「5 分钟内还在写」的活会话（那是宿主内存里的图）
    const old = (Date.now() - 10 * 60_000) / 1000;
    nodeFs.utimesSync(logFile, old, old);
    t.eq(debtOfGraph(f.readGraph(id)).due, true, "新会话必须是一笔欠账（夹具自检）");

    // ② 同一个 engine 实例再打一轮 —— 没有重建定时器、没有重启
    const result = await f.engine.runAutoBackfillOnce();
    t.eq(result?.ok, true, "捡账那一轮不许抛");
    const state = f.readState();
    t.eq(state.picked, [id], "新欠账必须被挑中（重启才会捡 = 这个用例红）");
    t.eq(state.results.length, 1, "要有一条结局");
    t.eq(state.results[0].folded, 1, "要真的折出 1 段");
    t.eq(state.results[0].stopped, STOPPED_DONE, "结局是 done");
    const graph = f.readGraph(id);
    const marks = (graph.foldMarks ?? []).filter((mark) => mark.trigger === "archive-offline");
    t.eq(marks.length, 1, `图上要落一条 archive-offline 折痕（实际 ${marks.length}）`);
    t.eq([marks[0].seqStart, marks[0].seqEnd], [1, 200], "折痕区间要覆盖整段欠账");
    t.eq(debtOfGraph(graph).due, false, "折完之后必须回到零欠账");
  } finally {
    f.restore();
  }
};

tests["C647④ 清零之后又安静下来：折完的下一轮回到 due=0 / picked=[]"] = async (t) => {
  const f = await makeFixture();
  try {
    const result = await f.engine.runAutoBackfillOnce();
    t.eq(result?.ok, true, "安静的一轮不许抛");
    const state = f.readState();
    t.eq(state.due, 0, "没有欠账了");
    t.eq(state.picked, [], "不挑人");
    t.eq(state.results, [], "没有结局");
  } finally {
    f.restore();
  }
};

/* ────────────────────────── ⑤ doctor 不许误报 ────────────────────────── */

/** 跑一次 doctor（子进程 + `DSH_HOME=<夹具>`），返回「自动补账结局」那一行的**详情**。 */
function doctorBackfillDetail(home) {
  const out = spawnSync(process.execPath, [nodePath.join(ROOT, "scripts", "doctor.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: home },
  });
  const line = String(out.stdout ?? "")
    .split(/\r?\n/)
    .find((row) => row.includes("自动补账结局"));
  t_line: {
    if (line === undefined) return { line: null, detail: null };
  }
  // 检查**名字**里就带"静默停摆" ⇒ 只能拿"名字 — 详情"里的详情判
  const at = line.indexOf(" — ");
  return { line: line.trim(), detail: at >= 0 ? line.slice(at + 3).trim() : line.trim() };
}

tests["C647⑤ doctor 在零欠账时不许误报「停摆 / 本版可能需要重启」"] = async (t) => {
  const f = await makeFixture();
  try {
    // 形状 A：状态文件在（清零后正常跑过一轮）
    const withFile = doctorBackfillDetail(f.home);
    t.ok(withFile.line !== null, "doctor 必须有「自动补账结局」这一行");
    t.includes(withFile.detail, "欠账 0 个", "要把「欠账 0 个」说出来");
    t.eq(/可能停了|空转|没跑起来|没更新|本版可能需要重启/.test(String(withFile.detail)), false, `零欠账不许判停摆：${withFile.detail}`);

    // 形状 B：状态文件不存在（刚清零 / 刚重启还没跑过第一轮）
    for (const name of ["auto-backfill-state.json", "auto-backfill-state.latest.json", `auto-backfill-state.${process.pid}.json`]) {
      nodeFs.rmSync(nodePath.join(f.chess, name), { force: true });
    }
    const noFile = doctorBackfillDetail(f.home);
    t.ok(noFile.line !== null, "没有状态文件时也要有这一行");
    t.includes(noFile.detail, "没有欠账可补", "零欠账 + 没状态文件 = 正常，要说出来");
    t.eq(/可能停了|空转|没跑起来|需要重启/.test(String(noFile.detail)), false, `不许把「还没跑过」读成需要重启：${noFile.detail}`);
  } finally {
    f.restore();
  }
};
