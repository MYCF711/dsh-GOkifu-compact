/**
 * ui-perf.test.mjs —— P4：首屏 `state` 的 graph.json 解析缓存（task-40）
 *
 * 背景：state 一次要把 home/chess-context/sessions 下所有 graph.json 全量 parse（live 133 个 / 33MB，342~400ms）。
 * 修法：按 (绝对路径, mtimeMs, size) 缓存「聚合摘要」（只存 foldMarks/计数，不存整图）；同一次请求两个聚合共用一次扫描。
 *
 * 本文件钉住五件事：
 *   ① 冷路径每个 graph.json 读一次；热路径 **0 次读盘**（命中缓存）
 *   ② 改文件（mtime/size 变化）必须失效，并返回新值
 *   ③ 同 mtime 但 size 不同也必须失效（缓存键包含 size）
 *   ④ 坏图也只读一次（坏结果被缓存），聚合行为与旧实现一致
 *   ⑤ 输出与**旧实现**逐字段相等（参考实现直接照抄 P4 之前的 latestGraph/todayAggregate）
 *
 * 全部离线：临时 home + 假 req/res，不启动 DSH、不碰真实 graph。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

const GRAPH_MARK = "graph.json";

/** 造一个 home：graphs = { 会话名: 图对象 | 原始文本 }。 */
function makeHome(graphs) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-p4-"));
  const sessions = nodePath.join(dir, "chess-context", "sessions");
  nodeFs.mkdirSync(sessions, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "profiles", "desktop"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  for (const [name, graph] of Object.entries(graphs)) {
    const sessionDir = nodePath.join(sessions, name);
    nodeFs.mkdirSync(sessionDir, { recursive: true });
    const text = typeof graph === "string" ? graph : JSON.stringify(graph);
    nodeFs.writeFileSync(nodePath.join(sessionDir, GRAPH_MARK), text, "utf8");
  }
  return { home: dir, sessions };
}

/** 一张结构完整的图（字段覆盖 latest/today 用到的全部）。 */
function makeGraph(overrides = {}) {
  const now = Date.now();
  return {
    foldCount: 2,
    lastFoldTotalTokens: 1234,
    checkpointSeq: 5,
    foldMarks: [{ at: now, shadowedTokens: 300, seqStart: 1, seqEnd: 2 }],
    lastFoldUsage: { inputTokens: 100, outputTokens: 20, provider: "p", model: "m" },
    nodes: { a: {}, b: {}, c: {} },
    edges: { e1: { result: "failure" }, e2: { result: "success" }, e3: { result: "failure" } },
    ...overrides,
  };
}

async function mount() {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href + "?p4=" + Math.random());
  const routes = [];
  uiMod.apply({ webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" }, effect: (fn) => fn() });
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  return { handler: routes[0].handler, uiMod };
}

function call(handler, body = { action: "state" }) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
      on(ev, cb) {
        if (ev === "data") cb(Buffer.from(text, "utf8"));
        if (ev === "end") cb();
        return req;
      },
    };
    const res = {
      status: 0,
      raw: "",
      writeHead(s) {
        this.status = s;
      },
      end(c) {
        this.raw = c ?? "";
        resolve({ status: this.status, raw: this.raw, json: safeJson(this.raw) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

/** 统计 graph.json 的 readFileSync 次数（fs 是单例，ui.mjs 与我们共用同一个对象）。 */
function countGraphReads() {
  const real = nodeFs.readFileSync;
  const counter = { n: 0 };
  nodeFs.readFileSync = function patched(file, ...args) {
    if (typeof file === "string" && file.endsWith(GRAPH_MARK)) counter.n += 1;
    return real.call(nodeFs, file, ...args);
  };
  return {
    counter,
    restore() {
      nodeFs.readFileSync = real;
    },
  };
}

/* ───────────── 旧实现参考（照抄 P4 之前的 latestGraph / todayAggregate，用于逐字段比对） ───────────── */

function refLatestGraph(home) {
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) return null;
  let best = null;
  for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = nodePath.join(root, d.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    const mtime = nodeFs.statSync(file).mtimeMs;
    if (best === null || mtime > best.mtime) best = { dir: d.name, file, mtime };
  }
  if (best === null) return null;
  try {
    const g = JSON.parse(nodeFs.readFileSync(best.file, "utf8"));
    const marks = g.foldMarks ?? [];
    const failures = Object.values(g.edges ?? {}).filter((e) => e?.result === "failure").length;
    return {
      session: best.dir,
      updatedAt: best.mtime,
      foldCount: g.foldCount ?? 0,
      totalAfter: g.lastFoldTotalTokens ?? 0,
      checkpointSeq: g.checkpointSeq ?? null,
      lastFold: marks.length > 0 ? marks[marks.length - 1] : null,
      lastUsage: g.lastFoldUsage ?? null,
      failures,
      nodes: Object.keys(g.nodes ?? {}).length,
      edges: Object.keys(g.edges ?? {}).length,
    };
  } catch {
    return null;
  }
}

function refTodayAggregate(home) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let folds = 0;
  let shadowed = 0;
  const sessions = new Set();
  let totalSessions = 0;
  let totalFailures = 0;
  if (!nodeFs.existsSync(root)) return { folds, shadowed, sessions: 0, totalSessions, totalFailures };
  for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = nodePath.join(root, d.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    totalSessions += 1;
    try {
      const g = JSON.parse(nodeFs.readFileSync(file, "utf8"));
      const marks = (g.foldMarks ?? []).filter((m) => (m.at ?? 0) >= from);
      if (marks.length > 0) {
        folds += marks.length;
        sessions.add(d.name);
        shadowed += marks.reduce((sum, m) => sum + (m.shadowedTokens ?? 0), 0);
      }
      totalFailures += Object.values(g.edges ?? {}).filter((e) => e?.result === "failure").length;
    } catch {
      /* 坏图跳过 */
    }
  }
  return { folds, shadowed, sessions: sessions.size, totalSessions, totalFailures };
}

export const tests = {};

/* ───────────────────────── ① 冷/热 ───────────────────────── */

tests["P4 · 冷路径每个 graph.json 读一次；热路径 0 次读盘"] = async () => {
  const { home } = makeHome({ s1: makeGraph(), s2: makeGraph({ foldCount: 7 }), s3: makeGraph({ foldCount: 9 }) });
  await withHome(home, async () => {
    const { handler } = await mount();
    const spy = countGraphReads();
    try {
      const cold = await call(handler);
      if (cold.status !== 200) throw new Error(`state 应 200，得到 ${cold.status}`);
      if (spy.counter.n !== 3) throw new Error(`冷路径应读 3 个 graph.json（=会话数），实际 ${spy.counter.n}`);
      spy.counter.n = 0;
      const warm = await call(handler);
      if (warm.status !== 200) throw new Error(`热路径 state 应 200，得到 ${warm.status}`);
      if (spy.counter.n !== 0) throw new Error(`热路径不应再读 graph.json，实际读了 ${spy.counter.n} 次`);
      if (warm.raw !== cold.raw) throw new Error("热路径输出与冷路径不一致");
    } finally {
      spy.restore();
    }
  });
};

/* ───────────────────────── ② 改文件失效 ───────────────────────── */

tests["P4 · 改文件（内容+mtime+size 变化）必须失效并返回新值"] = async () => {
  const { home, sessions } = makeHome({ alpha: makeGraph({ foldCount: 1 }) });
  await withHome(home, async () => {
    const { handler } = await mount();
    const first = await call(handler);
    if (first.json.latest.foldCount !== 1) throw new Error(`初始值应为 1，得到 ${first.json.latest.foldCount}`);
    const file = nodePath.join(sessions, "alpha", GRAPH_MARK);
    const next = makeGraph({ foldCount: 42, lastFoldTotalTokens: 999 });
    nodeFs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8"); // 内容变长 ⇒ size 也变
    const later = new Date(Date.now() + 3000);
    nodeFs.utimesSync(file, later, later); // 显式把 mtime 推到未来，排除同毫秒偶然
    const second = await call(handler);
    if (second.json.latest.foldCount !== 42) throw new Error(`改文件后应看到 42，得到 ${second.json.latest.foldCount}（缓存未失效）`);
    if (second.json.latest.totalAfter !== 999) throw new Error(`totalAfter 未更新：${second.json.latest.totalAfter}`);
  });
};

tests["P4 · 同 mtime 但 size 不同也必须失效（缓存键含 size）"] = async () => {
  const { home, sessions } = makeHome({ beta: makeGraph({ foldCount: 1 }) });
  await withHome(home, async () => {
    const { handler } = await mount();
    const file = nodePath.join(sessions, "beta", GRAPH_MARK);
    // 固定到整秒，避免 utimes 的毫秒/100ns 精度差异让「同 mtime」构造失败
    const fixed = 1700000000;
    nodeFs.utimesSync(file, fixed, fixed);
    const before = nodeFs.statSync(file);
    const first = await call(handler);
    if (first.json.latest.foldCount !== 1) throw new Error("初始值应为 1");
    const changed = makeGraph({ foldCount: 22, extraPadding: "x".repeat(64) });
    nodeFs.writeFileSync(file, JSON.stringify(changed), "utf8");
    nodeFs.utimesSync(file, fixed, fixed); // 还原 mtime（同整秒）
    const after = nodeFs.statSync(file);
    if (after.mtimeMs !== before.mtimeMs) throw new Error(`构造失败：mtime 没还原（${before.mtimeMs} → ${after.mtimeMs}）`);
    if (after.size === before.size) throw new Error("构造失败：size 没变化，测不到 size 键");
    const second = await call(handler);
    if (second.json.latest.foldCount !== 22) throw new Error(`同 mtime 不同 size 应失效，得到 foldCount=${second.json.latest.foldCount}`);
  });
};

tests["P4 · 同 size 但 mtime 变也必须失效（缓存键含 mtime）"] = async () => {
  const { home, sessions } = makeHome({ delta: makeGraph({ foldCount: 1 }) });
  await withHome(home, async () => {
    const { handler } = await mount();
    const file = nodePath.join(sessions, "delta", GRAPH_MARK);
    const fixed = 1700000000;
    nodeFs.utimesSync(file, fixed, fixed);
    const before = nodeFs.statSync(file);
    const first = await call(handler);
    if (first.json.latest.foldCount !== 1) throw new Error("初始值应为 1");
    // 只把 1 改成 2（同长度），mtime 推到未来 ⇒ size 不变、mtime 变
    const text = JSON.stringify(makeGraph({ foldCount: 2 }));
    nodeFs.writeFileSync(file, text, "utf8");
    nodeFs.utimesSync(file, fixed + 10, fixed + 10);
    const after = nodeFs.statSync(file);
    if (after.size !== before.size) throw new Error(`构造失败：size 变了（${before.size} → ${after.size}）`);
    if (after.mtimeMs === before.mtimeMs) throw new Error("构造失败：mtime 没变");
    const second = await call(handler);
    if (second.json.latest.foldCount !== 2) throw new Error(`同 size 不同 mtime 应失效，得到 foldCount=${second.json.latest.foldCount}`);
  });
};

tests["P4 · 冷路径每个 graph.json 只 stat 一次（latest/today 共用一次扫描）"] = async () => {
  const { home } = makeHome({ s1: makeGraph(), s2: makeGraph(), s3: makeGraph() });
  await withHome(home, async () => {
    const { handler } = await mount();
    const realStat = nodeFs.statSync;
    const counter = { n: 0 };
    nodeFs.statSync = function patched(file, ...args) {
      if (typeof file === "string" && file.endsWith(GRAPH_MARK)) counter.n += 1;
      return realStat.call(nodeFs, file, ...args);
    };
    try {
      const res = await call(handler);
      if (res.status !== 200) throw new Error(`state 应 200，得到 ${res.status}`);
      if (counter.n !== 3) throw new Error(`3 个会话应只 stat 3 次（共用扫描），实际 ${counter.n} 次`);
    } finally {
      nodeFs.statSync = realStat;
    }
  });
};

/* ───────────────────────── ③ 坏图 ───────────────────────── */

tests["P4 · 坏图只读一次（坏结果也缓存），聚合与旧实现一致"] = async () => {
  const good = makeGraph({ foldCount: 5 });
  const { home } = makeHome({ good, bad: "{ 这不是 JSON" });
  await withHome(home, async () => {
    const { handler } = await mount();
    const spy = countGraphReads();
    try {
      const cold = await call(handler);
      if (spy.counter.n !== 2) throw new Error(`冷路径应读 2 个文件，实际 ${spy.counter.n}`);
      if (cold.json.today.totalSessions !== 2) throw new Error(`totalSessions 应含坏图 = 2，得到 ${cold.json.today.totalSessions}`);
      spy.counter.n = 0;
      const warm = await call(handler);
      if (spy.counter.n !== 0) throw new Error(`坏图热路径不应重读，实际 ${spy.counter.n} 次`);
      if (warm.raw !== cold.raw) throw new Error("坏图存在时热路径输出与冷路径不一致");
    } finally {
      spy.restore();
    }
  });
};

/* ───────────────────────── ④ 缓存清理 / 路径键 ───────────────────────── */

tests["P4 · 会话目录删除后缓存被清理（同名同 mtime 同 size 重建能读出新内容）"] = async () => {
  const { home, sessions } = makeHome({ gamma: makeGraph({ foldCount: 1 }) });
  await withHome(home, async () => {
    const { handler } = await mount();
    const file = nodePath.join(sessions, "gamma", GRAPH_MARK);
    const fixed = 1700000000;
    nodeFs.utimesSync(file, fixed, fixed);
    const stat = nodeFs.statSync(file);
    const first = await call(handler);
    if (first.json.today.totalSessions !== 1) throw new Error("初始应有 1 个会话");
    nodeFs.rmSync(nodePath.join(sessions, "gamma"), { recursive: true, force: true });
    const gone = await call(handler);
    if (gone.json.today.totalSessions !== 0) throw new Error(`删掉会话后应 0，得到 ${gone.json.today.totalSessions}`);
    // 重建：同样长度的内容（1→2 单字符替换，size 不变）+ 还原 mtime
    nodeFs.mkdirSync(nodePath.join(sessions, "gamma"), { recursive: true });
    const text = JSON.stringify(makeGraph({ foldCount: 2 }));
    nodeFs.writeFileSync(file, text, "utf8");
    nodeFs.utimesSync(file, fixed, fixed);
    const rebuilt = nodeFs.statSync(file);
    if (rebuilt.mtimeMs !== stat.mtimeMs) throw new Error("构造失败：重建文件 mtime 没还原");
    if (rebuilt.size !== stat.size) throw new Error(`构造失败：重建文件 size 变了（${stat.size} → ${rebuilt.size}）`);
    const again = await call(handler);
    if (again.json.latest.foldCount !== 2) throw new Error(`缓存未清理：重建后应读到 2，得到 ${again.json.latest.foldCount}`);
  });
};

tests["P4 · 不同 home 的同名会话不串缓存（键含绝对路径）"] = async () => {
  const a = makeHome({ same: makeGraph({ foldCount: 11 }) });
  const b = makeHome({ same: makeGraph({ foldCount: 22 }) });
  const { handler } = await mount(); // 同一个模块实例，缓存跨 home 复用 —— 正是要验证的场景
  const readA = await withHome(a.home, () => call(handler));
  const readB = await withHome(b.home, () => call(handler));
  const readA2 = await withHome(a.home, () => call(handler));
  if (readA.json.latest.foldCount !== 11) throw new Error(`home A 应为 11，得到 ${readA.json.latest.foldCount}`);
  if (readB.json.latest.foldCount !== 22) throw new Error(`home B 应为 22（被 home A 的缓存污染？），得到 ${readB.json.latest.foldCount}`);
  if (readA2.json.latest.foldCount !== 11) throw new Error(`切回 home A 应为 11，得到 ${readA2.json.latest.foldCount}`);
};

/* ───────────────────────── ⑤ 与旧实现逐字段等价 ───────────────────────── */

tests["P4 · state.latest / state.today 与旧实现逐字段（含字段顺序）完全相同"] = async () => {
  const graphs = {
    broken: "{oops", // 先写 ⇒ mtime 最老，不会成为 latest（否则 latest 恒为 null，字段顺序就测不到了）
    alpha: makeGraph({ foldCount: 3 }),
    beta: makeGraph({ foldCount: 8, lastFoldTotalTokens: 0, checkpointSeq: null }),
    gamma: makeGraph({
      foldCount: 0,
      foldMarks: [
        { at: Date.now() - 86400000 * 3, shadowedTokens: 111 }, // 前天：不计入 today
        { at: Date.now() - 3600000, shadowedTokens: 222, seqStart: 9, seqEnd: 10 },
      ],
      lastFoldUsage: null,
    }),
  };
  const { home } = makeHome(graphs);
  // 固定 mtime 顺序：broken < alpha < beta < gamma（gamma 是 latest，字段顺序才有意义）
  const stamps = { broken: 1700000001, alpha: 1700000100, beta: 1700000200, gamma: 1700000300 };
  for (const [name, sec] of Object.entries(stamps)) {
    nodeFs.utimesSync(nodePath.join(home, "chess-context", "sessions", name, GRAPH_MARK), sec, sec);
  }
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler);
    if (res.status !== 200) throw new Error(`state 应 200，得到 ${res.status}`);
    if (res.json.latest === null) throw new Error("latest 不该是 null（夹具构造错了）");
    if (res.json.latest.session !== "gamma") throw new Error(`latest 应指向 gamma，得到 ${res.json.latest.session}`);
    const wantLatest = JSON.stringify(refLatestGraph(home));
    const gotLatest = JSON.stringify(res.json.latest);
    if (gotLatest !== wantLatest) throw new Error(`latest 与旧实现不同：\n  旧: ${wantLatest}\n  新: ${gotLatest}`);
    const wantToday = JSON.stringify(refTodayAggregate(home));
    const gotToday = JSON.stringify(res.json.today);
    if (gotToday !== wantToday) throw new Error(`today 与旧实现不同：\n  旧: ${wantToday}\n  新: ${gotToday}`);
    // 连续两次（第二次全热）必须字节一致
    const again = await call(handler);
    if (again.raw !== res.raw) throw new Error("热路径输出与冷路径不逐字一致");
  });
};

tests["P4 · health 动作也走同一套扫描且与旧语义一致"] = async () => {
  const { home } = makeHome({ alpha: makeGraph() });
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { action: "health" });
    if (res.status !== 200) throw new Error(`health 应 200，得到 ${res.status}`);
    if (res.json.today.totalSessions !== 1) throw new Error(`health.today.totalSessions 应 1，得到 ${res.json.today.totalSessions}`);
    if (res.json.latest === null) throw new Error("health.latest 不应为 null");
  });
};
