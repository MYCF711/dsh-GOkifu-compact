#!/usr/bin/env node
/**
 * backfill-idle-audit.mjs —— 「欠账清零之后会怎样」的只读实测（C647）
 *
 * ## 为什么要有它
 *
 * 2026-11-05 06:5x 真机：欠账 47 个会话 / 16,632 事件 / 需 81 段（从 964 段降下来），
 * 近 1 小时折了 100+ 段 —— **清零是几个小时之内的事，而没人验证过清零之后会怎样**。
 * 五条担心，每一条都只能靠实测回答（读代码读不出"10 轮定时器烧多少 CPU"）：
 *
 *   ① 清理：`debtOfGraph` / `listDebts` / `backfill-plan` 的欠账口径是不是真的归 0？
 *   ② 空转：清零后定时器每 10 分钟仍然跑一轮 —— 它挑 0 个，**烧多少 CPU、刷不刷日志**？
 *   ③ 误报：`doctor`「自动补账结局」与 `checkup`「自动补账状态」在没欠账时**实际输出什么**？
 *   ④ 协议：`runOfflineFold` 在 `due = 0`（空区间）时交出的 `stopped` 是哪个值？
 *      它在**协议表**（`src/rooms/offline-fold.mjs` 的 `STOPPED_REASONS`）里登记过吗？
 *   ⑤ 漏捡：清零之后**新归档**的会话，会不会被同一台定时器捡起来？还是必须重启？
 *
 * ## 怎么做的（全部只读）
 *
 * `mkdtemp` 造一个「零欠账」的假 home（`<tmp>/home`），里面的会话**每张图都已折叠到位**
 * （`foldMarks` 的 `seqEnd` 顶到 `maxSeq`、`closeout.folded > 0`），然后：
 *
 *   · 欠账口径走**真函数**：`debtOfGraph` / `listDebts` / `buildPlan` / `summarizePlan` / `planRounds`；
 *   · 定时器走**真 tick**：`test/engine-harness.test.mjs` 的假 DSH 起 `Engine`，
 *     打 `runAutoBackfillOnce()`（C598 的公开入口，与 `setInterval` 走同一条代码），
 *     用 `process.cpuUsage()` 量 10 轮；
 *   · `doctor.mjs` / `checkup.mjs` 用**子进程 + `DSH_HOME=<夹具>`** 跑，抓它们自己打的那一行；
 *   · 「清零后新欠账」用**同一个 engine 实例**：往夹具里加一个未折的会话（图 + 日志），
 *     再打一次 tick —— 不重启、不重建定时器。
 *
 * 真实 home 只做**只读采样**（`listSessionLogs` + 抽 12 张图解析），用来把夹具上量到的
 * 单轮成本换算到真机规模；`DSH_HOME` 只在本进程内指向夹具，退出前还原。
 *
 * ## 用法
 *
 *   node scripts/backfill-idle-audit.mjs           # 人读
 *   node scripts/backfill-idle-audit.mjs --json    # 机读
 *
 * 退出码：0 = 五条结论都成立（可修的都修好了）；1 = 有**可修**的问题（未登记的 stopped / 误报 / 漏捡）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { debtOfGraph, listDebts } from "../src/rooms/closeout-backfill.mjs";
import {
  runOfflineFold,
  offlineFoldOutcome,
  STOPPED_REASONS,
  STOPPED_EMPTY,
  STOPPED_EMPTY_RESPONSE,
} from "../src/rooms/offline-fold.mjs";
import { buildPlan, summarizePlan, planRounds, debtAttemptState, foldedEvidencePresent } from "./backfill-plan.mjs";
import { listSessionLogs } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

/** 夹具规模：真机 556 个会话 ⇒ 这里 120 个，量出来的单轮成本再按 `556/120` 放大。 */
const IDLE_SESSIONS = 120;
/** 每个假会话的节点数（够 `debtOfGraph` 算 tail，又不至于把夹具撑成真机那样 278 MB）。 */
const NODES_PER_SESSION = 24;
/** 定时器间隔（与 `#startAutoBackfill` 默认一致：`DSH_GOKIFU_AUTO_BACKFILL_MIN=10`）。 */
const TICK_MINUTES = 10;
/** 真机会话数（2026-11-05 06:5x 只读 `ls chess-context/sessions | wc -l` = 556）。 */
const REAL_SESSIONS = 556;
/** 真实 home（只读采样用；不存在就跳过）。 */
const REAL_HOME = process.env.DSH_GOKIFU_REAL_HOME ?? "";

const problems = []; // 可修的错（决定退出码）
const notes = []; // 本轮禁改、但要点名的东西
const report = {};
const say = (text = "") => {
  if (!asJson) console.log(text);
};
const ms = (value) => `${Math.round(Number(value) * 10) / 10} ms`;
const section = (title) => say(`\n── ${title} ──`);

/* ────────────────────────── 夹具 ────────────────────────── */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gokifu-backfill-idle-"));
const HOME = path.join(TMP, "home");
const CHESS = path.join(HOME, "chess-context");
const SESSIONS = path.join(CHESS, "sessions");
const LOG_ROOT = path.join(HOME, "sessions", "--ws--");
const now = Date.now();

/**
 * 一个「已折叠到位」的会话图：`foldMarks` 的 `seqEnd` 顶到 `maxSeq`、`closeout.folded = 1`。
 * 两条判据缺一不可 —— 只有 mark 没有 closeout（或反过来）在 `debtOfGraph` 里是两种不同的坏状态
 * （C476 / C569 那两次假成功就是只写了一半）。
 */
function idleGraph(id, { nodes = NODES_PER_SESSION, seqStart = 1 } = {}) {
  const table = {};
  const order = [];
  for (let i = 0; i < nodes; i += 1) {
    const seq = seqStart + i;
    const nodeId = `n${seq}`;
    table[nodeId] = {
      id: nodeId,
      kind: i === 0 ? "user" : "agent",
      seq,
      text: `第 ${seq} 步：把补账跑通`,
      ts: now - (nodes - i) * 60_000,
      ...(i === 0 ? { constraints: ["不许改真实 home"] } : {}),
    };
    order.push(nodeId);
  }
  const lastSeq = seqStart + nodes - 1;
  return {
    version: 1,
    sessionId: id,
    cwd: HOME,
    rootUserNodeIds: [`n${seqStart}`],
    nodes: table,
    edges: {},
    order,
    stateIndex: {},
    foldMarks: [
      {
        seqStart,
        seqEnd: lastSeq,
        trigger: "archive",
        at: now - 3_600_000,
        shadowedTokens: nodes * 40,
        ms: 48_000,
        provider: "fixture",
        model: "fixture-model",
      },
    ],
    closeout: { at: now - 3_600_000, source: "archive", foldAttempted: true, folded: 1, chunkedFolded: 0 },
    lastFoldSeq: lastSeq,
    updatedAt: now - 3_600_000,
  };
}

/** 写一张图（`<chess-context>/sessions/<id>/graph.json`）。 */
function writeGraph(id, graph) {
  const dir = path.join(SESSIONS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "graph.json");
  fs.writeFileSync(file, JSON.stringify(graph, null, 1), "utf8");
  return file;
}

/**
 * 写一份会话日志（离线补折唯一的数据源）。
 * ⚠ 事件条数必须 ≥ 图上的 `maxSeq` —— 否则「图说还有 140 个事件没折、日志里根本没有」
 * 这种自相矛盾的夹具会让补账一段一段地空折（我第一版就是 60 条事件配 seq 200 的图）。
 */
function writeSessionLog(id, { events = 200 } = {}) {
  const dir = path.join(LOG_ROOT, `session-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= events; i += 1) {
    lines.push(
      JSON.stringify(
        i % 2 === 1
          ? { seq: i, type: "user/message", data: { message: { content: [{ type: "text", text: `第 ${i} 步：欠账是新的，定时器要捡起来` }] } } }
          : { seq: i, type: "assistant/message", data: { message: { content: [{ type: "text", text: `第 ${i} 步：收到，继续折` }] } } },
      ),
    );
  }
  const file = path.join(dir, "session.v4.jsonl.zstd");
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`, "utf8")));
  // 做旧 10 分钟：tick 会跳过「日志 5 分钟内还在写」的活会话（那是宿主内存里的图）
  const old = (Date.now() - 10 * 60_000) / 1000;
  fs.utimesSync(file, old, old);
  return file;
}

/* ────────────────────────── 工具 ────────────────────────── */

/** 跑一个 `scripts/*.mjs`（子进程 + `DSH_HOME=<夹具>`），拿回 stdout 与耗时。 */
function runScript(script, args = []) {
  const started = Date.now();
  const out = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: HOME },
  });
  return { status: out.status, stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? ""), ms: Date.now() - started };
}

/** 从人读输出里抓某一行，并切出「名字 — 详情」里的**详情**（名字里自带"停摆"等词，不能拿来判）。 */
function grabDetail(text, needle) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((row) => row.includes(needle));
  if (line === undefined) return { line: null, detail: null };
  const at = line.indexOf(" — ");
  return { line: line.trim(), detail: at >= 0 ? line.slice(at + 3).trim() : line.trim() };
}

/** 复用「假 DSH」：`engine.mjs` 的 `@deepseek-ai/*` 只能由宿主解析器提供（与 `test/run.mjs` 同一条路）。 */
async function loadFixtureEngine() {
  const harness = await import(pathToFileURL(path.join(ROOT, "test", "engine-harness.test.mjs")).href);
  const { Engine } = await harness.load();
  return { Engine, makeCtx: harness.makeCtx };
}

/** 清掉 harness 落在 `src/` 的临时副本（与 `test/run.mjs` 收尾同一套动作）。 */
function cleanHarnessArtifacts() {
  const srcDir = path.join(ROOT, "src");
  try {
    for (const name of fs.readdirSync(srcDir)) {
      if (name.startsWith(".engine-under-test") && name.endsWith(".mjs")) fs.rmSync(path.join(srcDir, name), { force: true });
    }
    fs.rmSync(path.join(srcDir, ".harness-stubs"), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "test", ".harness"), { recursive: true, force: true });
  } catch {
    /* 清不掉不影响结论（下次 run.mjs 也会清） */
  }
}

/** 真实 home 的**只读**采样：日志条数 + 每张图的解析成本（用来把夹具成本换算到真机规模）。 */
function probeRealHome() {
  const sessionsRoot = path.join(REAL_HOME, "chess-context", "sessions");
  if (!fs.existsSync(sessionsRoot)) return { available: false };
  let ids = [];
  try {
    ids = fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(sessionsRoot, name, "graph.json")));
  } catch {
    return { available: false };
  }
  const sample = ids.filter((_, i) => i % Math.max(1, Math.floor(ids.length / 12)) === 0).slice(0, 12);
  // 跑两遍取**第二遍**：第一遍吃的是冷页缓存（+ 杀毒扫描），同一个夹具连跑三次能差 2 倍。
  // 我们量的是「定时器每轮的 CPU」，不是「冷启动」，所以取热的那一遍。
  let bytes = 0;
  let ok = 0;
  let sampleMs = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    bytes = 0;
    ok = 0;
    const t0 = process.hrtime.bigint();
    for (const id of sample) {
      const file = path.join(sessionsRoot, id, "graph.json");
      try {
        bytes += fs.statSync(file).size;
        loadSessionGraph(file);
        ok += 1;
      } catch {
        /* 坏图跳过：这是采样，不是体检 */
      }
    }
    sampleMs = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const logsT0 = process.hrtime.bigint();
  const logs = listSessionLogs(REAL_HOME);
  const logsMs = Number(process.hrtime.bigint() - logsT0) / 1e6;
  return {
    available: true,
    sessions: ids.length,
    sampled: ok,
    sampleMs: Math.round(sampleMs * 10) / 10,
    perGraphMs: ok > 0 ? Math.round((sampleMs / ok) * 100) / 100 : null,
    avgGraphKB: ok > 0 ? Math.round(bytes / ok / 1024) : null,
    logFiles: logs.length,
    listLogsMs: Math.round(logsMs * 10) / 10,
    estTickMs: ok > 0 ? Math.round((sampleMs / ok) * ids.length * 10) / 10 : null,
  };
}

/* ────────────────────────── 主流程 ────────────────────────── */

let exitCode = 0;
const savedHome = process.env.DSH_HOME;
try {
  say("== 补账清零后的行为实测（只读夹具，不碰真实 home）==");
  say(`  夹具：${HOME}`);
  say(`  规模：${IDLE_SESSIONS} 个已折叠到位的会话 × ${NODES_PER_SESSION} 节点；真机 ${REAL_SESSIONS} 个会话`);
  report.fixture = { home: HOME, sessions: IDLE_SESSIONS, nodesPerSession: NODES_PER_SESSION, realSessions: REAL_SESSIONS };

  // 夹具：默认模型（离线补折要解析 provider/model）+ 120 个零欠账会话
  const profileDir = path.join(HOME, "profiles", "desktop");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "cordis.patch.yml"),
    ["- id: agent-default-model", "  provider: fixture-provider", "  model: fixture-model", ""].join("\n"),
    "utf8",
  );
  const idleIds = [];
  for (let i = 0; i < IDLE_SESSIONS; i += 1) {
    const id = `idle-${String(i).padStart(3, "0")}`;
    writeGraph(id, idleGraph(id));
    idleIds.push(id);
  }

  /* ① 清理 */
  section(`① 清理 · 夹具 ${idleIds.length} 个会话，全都没欠账`);
  const graphs = new Map(idleIds.map((id) => [id, loadSessionGraph(path.join(SESSIONS, id, "graph.json")).graph]));
  const dues = idleIds.map((id) => debtOfGraph(graphs.get(id)));
  const dueTrue = dues.filter((d) => d.due === true).length;
  const tailMax = Math.max(0, ...dues.map((d) => Number(d.tail) || 0));
  const attempts = idleIds.map((id) => debtAttemptState(graphs.get(id)));
  const evidence = idleIds.map((id) => foldedEvidencePresent(graphs.get(id)));
  say(`  · debtOfGraph(...).due === true：**${dueTrue}/${idleIds.length}** 个 · tail 最大 ${tailMax} 个事件（阈值 40）`);
  say(`  · debtAttemptState：retried=${attempts.filter((a) => a.retried).length} 个 · foldedEvidencePresent：true ${evidence.filter(Boolean).length}/${evidence.length}`);

  const listed = listDebts({ sessionIds: idleIds, limit: 50, loadGraph: (id) => graphs.get(id) });
  say(`  · listDebts：scanned=${listed.scanned} · **due=${listed.due}** · items=${listed.items.length}`);

  const rows = await buildPlan(HOME); // 走磁盘（自己读图 / 自己找日志），与 tick 的口径最接近
  const plan = summarizePlan(rows, { roughPerEvent: 0 });
  const rounds = planRounds(rows);
  say(
    `  · backfill-plan：buildPlan → ${rows.length} 行 · summarizePlan.total=${plan.total} chunks=${plan.chunks} rounds=${plan.rounds} clicks=${plan.clicks} costUsd=${plan.costUsd} · planRounds → ${rounds.length} 批`,
  );
  report.idle = { sessions: idleIds.length, dueTrue, tailMax, listedDue: listed.due, planTotal: plan.total, rounds: rounds.length };
  const cleanedUp = dueTrue === 0 && listed.due === 0 && plan.total === 0;
  if (!cleanedUp) problems.push(`① 夹具本该零欠账，实测 due=${dueTrue}/${listed.due}/plan=${plan.total}`);
  say(
    cleanedUp
      ? "  ⇒ **清零后欠账口径确实归 0**：三个入口（debtOfGraph / listDebts / buildPlan）都数出 0，没有隐形残留。"
      : "  ⇒ ✗ 有入口仍然数出欠账（夹具或判据有问题）",
  );

  /* ② 空转：10 轮真 tick */
  process.env.DSH_HOME = HOME; // 引擎的 resolveHome() 读这个 —— 只在本进程内、只指向夹具
  const { Engine, makeCtx } = await loadFixtureEngine();
  const ctx = makeCtx();
  const infoLogs = [];
  const warnLogs = [];
  ctx.logger.info = (message) => infoLogs.push(String(message));
  ctx.logger.warn = (message) => warnLogs.push(String(message));
  const engine = new Engine(ctx, { graphDir: CHESS, auto: false, closeoutMinEvents: 40 });

  // 单轮成本拆解：定时器每轮必做的两件事（与有没有欠账无关）。
  // ⚠ 必须**走磁盘**（`loadSessionGraph` 读文件 + 解析 + 校验 delta），拿内存里那份 Map 测出来是假的
  //   —— 实测定时器那一轮 59.5 ms，而"从缓存取"只有 0.3 ms，差 200 倍。
  const tListed = process.hrtime.bigint();
  listDebts({ sessionIds: idleIds, limit: 50, loadGraph: (id) => loadSessionGraph(path.join(SESSIONS, id, "graph.json")).graph });
  const listDebtsMs = Number(process.hrtime.bigint() - tListed) / 1e6;
  const tLogs = process.hrtime.bigint();
  listSessionLogs(HOME);
  const listLogsMs = Number(process.hrtime.bigint() - tLogs) / 1e6;

  const cpu0 = process.cpuUsage();
  const wall0 = process.hrtime.bigint();
  const tickResults = [];
  for (let i = 0; i < 10; i += 1) tickResults.push(await engine.runAutoBackfillOnce());
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const stateFile = path.join(CHESS, "auto-backfill-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const real = probeRealHome();
  const scale = real.available && real.estTickMs !== null ? real.estTickMs / (cpuMs / 10) : REAL_SESSIONS / IDLE_SESSIONS;

  section("② 空转 · 清零后连打 10 轮定时器（生产间隔 10 分钟，这里连打）");
  say(`  · 10 轮全部 ok：${tickResults.filter((r) => r?.ok === true).length}/10`);
  say(`  · **CPU = ${ms(cpuMs)}**（user ${ms(cpu.user / 1000)} + sys ${ms(cpu.system / 1000)}）· 墙钟 ${ms(wallMs)} · 单轮 **${ms(cpuMs / 10)} CPU / ${ms(wallMs / 10)} 墙钟**（夹具 ${IDLE_SESSIONS} 个会话）`);
  say(`  · 拆开看单轮：listDebts（全量扫图）${ms(listDebtsMs)} + listSessionLogs（遍历日志树）${ms(listLogsMs)}`);
  if (real.available) {
    say(
      `  · 真实 home 只读采样：${real.sessions} 个会话 · 抽 ${real.sampled} 张图 ${real.perGraphMs} ms/张（平均 ${real.avgGraphKB} KB）· 日志 ${real.logFiles} 份（${real.listLogsMs} ms）` +
        ` ⇒ 一轮约 **${ms(real.estTickMs)}**（按张数线性外推，真机图比夹具大得多，这个数更接近实况）`,
    );
  } else {
    say("  · 真实 home 不存在，跳过只读采样（按会话数线性外推）");
  }
  const perTickReal = real.available && real.estTickMs !== null ? real.estTickMs : (cpuMs / 10) * scale;
  const perDayMs = perTickReal * ((24 * 60) / TICK_MINUTES);
  const idleLogCount = infoLogs.length; // ★ ⑤ 还会打 tick —— 空转的日志数必须在这里定格
  say(
    `  · 一天 ${Math.round((24 * 60) / TICK_MINUTES)} 轮 ⇒ 约 **${ms(perDayMs)}/天**，占单核 **${(Math.round((perDayMs / 86_400_000) * 10000) / 100).toFixed(2)}%**`,
  );
  say(`  · 日志：info **${idleLogCount}** 行 · warn **${warnLogs.length}** 行`);
  const uniqueLogs = [...new Set(infoLogs)];
  for (const line of uniqueLogs) say(`      「${line}」 × ${infoLogs.filter((x) => x === line).length}`);
  say(`  · 状态文件：due=${state.due} · picked=${JSON.stringify(state.picked)} · results=${JSON.stringify(state.results)} · doneMs=${state.doneMs}`);
  report.cpu = {
    ticks: 10,
    cpuMs: Math.round(cpuMs * 10) / 10,
    wallMs: Math.round(wallMs * 10) / 10,
    perTickCpuMs: Math.round((cpuMs / 10) * 100) / 100,
    perTickWallMs: Math.round((wallMs / 10) * 100) / 100,
    listDebtsMs: Math.round(listDebtsMs * 10) / 10,
    listLogsMs: Math.round(listLogsMs * 10) / 10,
    real,
    perTickRealMs: Math.round(perTickReal * 10) / 10,
    infoLogs: infoLogs.length,
    warnLogs: warnLogs.length,
    uniqueLogs,
    state,
  };
  if (tickResults.some((r) => r?.ok !== true)) problems.push("② 空转 tick 有失败");
  if (infoLogs.length > 0) {
    // 引擎的日志行不在本轮可写范围（`src/engine.mjs` 禁改）—— 点名，但不让它把闸门变红。
    notes.push(
      `② 空转每轮刷 1 行日志（10 轮 ${infoLogs.length} 行）：「${uniqueLogs[0] ?? ""}」—— ` +
        `根因是 src/engine.mjs:2194 的 \`pickPool !== withLog\`（两个 filter 出来的新数组，恒真），` +
        `应比 length；**src/engine.mjs 本轮禁改**，所以只点名、不修`,
    );
  }
  say(
    idleLogCount === 0 && warnLogs.length === 0
      ? `  ⇒ **安静的空转**：10 轮一行日志都不写、单轮 ${ms(perTickReal)}（真机规模）—— 无害，不改。`
      : `  ⇒ **CPU 无害**（单轮 ${ms(perTickReal)}、一天占单核 ${(Math.round((perDayMs / 86_400_000) * 10000) / 100).toFixed(2)}%），` +
          `**但它每轮写一行"避开 0 个刚补过的会话"** —— 这句话是错的（一个都没避开），根因在 src/engine.mjs:2194（本轮禁改）。`,
  );

  /* ③ 误报：doctor / checkup 在没欠账时的原样输出 */
  const doctor = runScript("doctor.mjs");
  const doctorRow = grabDetail(doctor.stdout, "自动补账结局");
  const checkup = runScript("checkup.mjs");
  const checkupRow = grabDetail(checkup.stdout, "自动补账状态");
  // 另一种「没欠账」的形状：状态文件根本不存在（刚清零 / 刚重启还没跑过）
  const backupState = fs.readFileSync(stateFile, "utf8");
  for (const name of ["auto-backfill-state.json", "auto-backfill-state.latest.json", `auto-backfill-state.${process.pid}.json`]) {
    fs.rmSync(path.join(CHESS, name), { force: true });
  }
  const doctorNoFile = runScript("doctor.mjs");
  const doctorNoFileRow = grabDetail(doctorNoFile.stdout, "自动补账结局");
  fs.writeFileSync(stateFile, backupState, "utf8");

  section("③ 误报 · doctor「自动补账结局」/ checkup「自动补账状态」在零欠账时的原样输出");
  say(`  · doctor（退出码 ${doctor.status} —— 1 是**别的检查项**在夹具上必然红，这一行本身是 ✓；${ms(doctor.ms)}）：`);
  say(`      ${doctorRow.line ?? "(没有这一行)"}`);
  say(`  · checkup（退出码 ${checkup.status}，${ms(checkup.ms)}）：`);
  say(`      ${checkupRow.line ?? "(没有这一行)"}`);
  say(`  · doctor（**状态文件不存在**时，退出码 ${doctorNoFile.status}，${ms(doctorNoFile.ms)}）：`);
  say(`      ${doctorNoFileRow.line ?? "(没有这一行)"}`);
  report.doctor = { line: doctorRow.line, detail: doctorRow.detail, status: doctor.status, ms: doctor.ms, noFileLine: doctorNoFileRow.line };
  report.checkup = { line: checkupRow.line, detail: checkupRow.detail, status: checkup.status, ms: checkup.ms };
  const stalled = /可能停了|空转|没跑起来|没更新/.test(String(doctorRow.detail ?? "")) || /可能停了|跑了但一段都没折/.test(String(checkupRow.detail ?? ""));
  const noFileStalled = /可能停了|空转|没跑起来|本版可能需要重启/.test(String(doctorNoFileRow.detail ?? ""));
  if (doctorRow.line === null) problems.push("③ doctor 没有「自动补账结局」这一行");
  if (stalled) problems.push(`③ 零欠账时误报停摆：${doctorRow.detail} / ${checkupRow.detail}`);
  if (noFileStalled) problems.push(`③ 零欠账 + 没有状态文件时误报「需要重启」：${doctorNoFileRow.detail}`);
  say(
    !stalled && !noFileStalled
      ? "  ⇒ **没有误报**：两种「没欠账」的形状都判 ok（有状态文件：`欠账 0 个`；没有状态文件：`没有欠账可补，属正常`），\n     不会把「没活干」读成「停摆 / 本版可能需要重启」。"
      : "  ⇒ ✗ 有误报（零欠账被读成「停了 / 需要重启」）",
  );

  /* ④ 协议：due = 0 时 runOfflineFold 的 stopped 值 */
  const idle = graphs.get(idleIds[0]);
  const idleDebt = debtOfGraph(idle);
  const rangeStart = idleDebt.lastFoldSeq === null ? 1 : Number(idleDebt.lastFoldSeq) + 1;
  const rangeEnd = Number(idleDebt.maxSeq) || 0;
  let modelCalls = 0;
  const noRange = await runOfflineFold({
    graph: idle,
    events: [],
    rangeStart,
    rangeEnd,
    callModel: async () => {
      modelCalls += 1;
      throw new Error("空区间不该调模型");
    },
    measureQuality: () => null,
  });
  const noRangeOutcome = offlineFoldOutcome(noRange, { rangeStart, rangeEnd, maxSeq: rangeEnd });
  const emptyResponse = await runOfflineFold({
    graph: idle,
    events: Array.from({ length: 200 }, (_, i) => ({
      seq: i + 1,
      type: "user/message",
      data: { message: { content: [{ type: "text", text: `第 ${i + 1} 步` }] } },
    })),
    rangeStart,
    rangeEnd: rangeEnd + 200,
    callModel: async () => ({ text: "   ", usage: null, model: "fixture-model" }),
    measureQuality: () => null,
  });
  const emptyResponseOutcome = offlineFoldOutcome(emptyResponse, { rangeStart, rangeEnd: rangeEnd + 200, maxSeq: rangeEnd + 200 });
  const registered = Object.keys(STOPPED_REASONS);
  const unregistered = [noRangeOutcome.stopped, emptyResponseOutcome.stopped].filter(
    (value) => !Object.prototype.hasOwnProperty.call(STOPPED_REASONS, value),
  );

  section("④ 协议 · 空区间（due = 0）时 runOfflineFold / offlineFoldOutcome 交出什么");
  say(`  · 空区间：rangeStart=${rangeStart} > rangeEnd=${rangeEnd} ⇒ chunks=${noRange.chunks.length} · failed=${JSON.stringify(noRange.failed ?? null)} · 模型调用 ${modelCalls} 次`);
  say(`  · offlineFoldOutcome → **stopped = ${JSON.stringify(noRangeOutcome.stopped)}** · partial=${noRangeOutcome.partial} · folded=${noRangeOutcome.folded}`);
  say(`  · 模型空回答 → runOfflineFold.failed = ${JSON.stringify(emptyResponse.failed)} · offlineFoldOutcome → **stopped = ${JSON.stringify(emptyResponseOutcome.stopped)}**`);
  say(`  · 协议表 STOPPED_REASONS（${registered.length} 项）：${registered.join(" · ")}`);
  report.stopped = { stopped: noRangeOutcome.stopped, emptyResponse: emptyResponseOutcome.stopped, registered, unregistered };
  if (unregistered.length > 0) problems.push(`④ 有 stopped 值没在协议表里登记：${unregistered.join(", ")}`);
  say(
    unregistered.length === 0
      ? `  ⇒ **已登记**：${JSON.stringify(noRangeOutcome.stopped)} 与 ${JSON.stringify(emptyResponseOutcome.stopped)} 都在表里（STOPPED_EMPTY / STOPPED_EMPTY_RESPONSE）。`
      : `  ⇒ ✗ **没登记**：${unregistered.join(" / ")} —— 状态文件里会出现协议表外的停止原因，下游没人认得它。`,
  );

  /* ⑤ 漏捡：清零后新归档的会话，同一台定时器捡不捡 */
  const freshId = "fresh-archive";
  writeGraph(freshId, {
    version: 1,
    sessionId: freshId,
    cwd: HOME,
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "把补账跑通", constraints: ["不许改真实 home"], ts: now },
      n200: { id: "n200", kind: "agent", seq: 200, text: "末", ts: now },
    },
    edges: {},
    order: ["n1", "n200"],
    stateIndex: {},
    foldMarks: [],
    updatedAt: now,
  });
  writeSessionLog(freshId, { events: 200 });
  const freshDebt = debtOfGraph(loadSessionGraph(path.join(SESSIONS, freshId, "graph.json")).graph);
  // 模型桩：必须是**异步生成器**（引擎是 `for await`）
  ctx.llm.stream = async function* () {
    yield {
      type: "text-delta",
      text: ["## 目标", "- 把补账跑通", "## 约束", "- 不许改真实 home", "## 当前节点", "- n200（200 步完成）"].join("\n"),
    };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 } };
  };
  const logsBefore = infoLogs.length;
  const pickupTick = await engine.runAutoBackfillOnce();
  const pickupState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const freshGraph = JSON.parse(fs.readFileSync(path.join(SESSIONS, freshId, "graph.json"), "utf8"));
  const freshMarks = (freshGraph.foldMarks ?? []).filter((m) => m.trigger === "archive-offline");
  const freshDebtAfter = debtOfGraph(freshGraph);
  const idleAgain = await engine.runAutoBackfillOnce();
  const idleAgainState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const picked = Array.isArray(pickupState.picked) ? pickupState.picked : [];

  section("⑤ 漏捡 · 清零后新归档一个会话（图 + 日志），**不重启**再打 tick");
  say(`  · 新会话 ${freshId}：debtOfGraph.due = **${freshDebt.due}** · tail=${freshDebt.tail} 事件 · 日志已就位`);
  say(`  · tick 结果：ok=${pickupTick.ok} · 状态文件 picked=**${JSON.stringify(picked)}** · results=${JSON.stringify((pickupState.results ?? []).map((r) => ({ id: r.id, folded: r.folded, stopped: r.stopped })))}`);
  say(
    `  · 图上的折痕：archive-offline **${freshMarks.length}** 段（${freshMarks.map((m) => `${m.seqStart}-${m.seqEnd}`).join(", ") || "无"}）· closeout.folded=${freshGraph.closeout?.folded ?? "(无)"} · 折后 due=${freshDebtAfter.due} · tail=${freshDebtAfter.tail}`,
  );
  say(`  · 再打一轮（应该又安静下来）：ok=${idleAgain.ok} · due=${idleAgainState.due} · picked=${JSON.stringify(idleAgainState.picked)} · 本轮 info 日志 ${infoLogs.length - logsBefore} 行`);
  report.pickup = {
    sessionId: freshId,
    due: freshDebt.due,
    tail: freshDebt.tail,
    picked,
    results: pickupState.results,
    marks: freshMarks.map((m) => ({ start: m.seqStart, end: m.seqEnd })),
    dueAfter: freshDebtAfter.due,
    tailAfter: freshDebtAfter.tail,
    settledDue: idleAgainState.due,
    settledPicked: idleAgainState.picked,
  };
  const pickedUp = picked.includes(freshId) && freshMarks.length > 0 && freshDebtAfter.due === false;
  if (freshDebt.due !== true) problems.push("⑤ 新会话没有被判成欠账（夹具问题）");
  if (!pickedUp) problems.push(`⑤ 清零后新欠账没被捡完（picked=${JSON.stringify(picked)} marks=${freshMarks.length} due=${freshDebtAfter.due}）`);
  if (idleAgainState.due !== 0 || (idleAgainState.picked ?? []).length !== 0) {
    problems.push(`⑤ 折完之后没有回到零欠账（due=${idleAgainState.due} picked=${JSON.stringify(idleAgainState.picked)}）`);
  }
  say(
    pickedUp
      ? "  ⇒ **会被捡起来，不需要重启**：tick 每轮都从 `sessions/` 重新列一遍（`listDebts` 现算），\n     挑中 → 离线补折 → 写 foldMark + closeout → 落状态文件；折完下一轮自动回到 due=0 · picked=[]。"
      : "  ⇒ ✗ 新欠账没被捡起来（要么重启才行，要么排序把它挤掉了）",
  );

  /* 汇总 */
  say("\n== 判断表 ==");
  const row = (ok, label, detail) => say(`  ${ok === "✓" || ok === "⚠" ? ok : ok ? "✓" : "✗"} ${label} —— ${detail}`);
  row(cleanedUp, "清理", `三个入口都数出 0 个欠账（tail 最大 ${tailMax} < 40）`);
  row(
    idleLogCount === 0 && warnLogs.length === 0 ? "✓" : "⚠",
    "空转",
    `单轮 ${ms(perTickReal)}（真机规模）· 一天 ${ms(perDayMs)}（单核 ${(Math.round((perDayMs / 86_400_000) * 10000) / 100).toFixed(2)}%）· ${idleLogCount} 行日志` +
      (idleLogCount === 0 ? " —— 无害，不改" : " —— CPU 无害；那行日志是错的，但根因在 src/engine.mjs（本轮禁改），只点名"),
  );
  row(!stalled && !noFileStalled, "误报", `doctor/checkup 在零欠账时都判 ok（见 ③ 原样输出）`);
  row(unregistered.length === 0, "协议", `空区间 stopped=${JSON.stringify(noRangeOutcome.stopped)} · 空回答 ${JSON.stringify(emptyResponseOutcome.stopped)}${unregistered.length === 0 ? " 都已登记" : " **未登记**"}`);
  row(pickedUp, "漏捡", `新归档会话被同一台定时器捡起并折了 ${freshMarks.length} 段（不重启、折后 due=${freshDebtAfter.due}）`);

  if (notes.length > 0) {
    say(`\n⚠ 点名（不在本轮可写路径，未改）：`);
    for (const note of notes) say(`   · ${note}`);
  }
  if (problems.length > 0) {
    exitCode = 1;
    say(`\n❌ 发现 ${problems.length} 个可修的问题：`);
    for (const problem of problems) say(`   · ${problem}`);
  } else {
    say("\n✅ 五条结论全部成立");
  }
  report.problems = problems;
  report.notes = notes;
} catch (error) {
  exitCode = 1;
  say(`\n❌ 审计脚本自己崩了：${String(error?.stack ?? error)}`);
  report.error = String(error?.message ?? error);
} finally {
  cleanHarnessArtifacts();
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

if (asJson) console.log(JSON.stringify(report, null, 2));
process.exitCode = exitCode;
