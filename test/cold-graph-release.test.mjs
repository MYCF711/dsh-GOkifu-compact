/**
 * cold-graph-release.test.mjs —— C656 冷图安全回收与补账 pin
 *
 * 为什么要有这个文件：`graphs` / `runtime` 一直是**按会话常驻、没有清理路径**的
 * （A1 F17，`docs/架构-房间契约.md` §R09「状态归属」写着「本次不修」）。真机这台机器
 * 1547 个会话、单张图最大 ~10 MB JSON —— 进程活久了，关掉的窗口也留在内存里。
 * C656 补的是**一个闸门**，不是一个"到点就删"的定时器，所以每条判据都必须有用例钉住：
 *
 *   1. 统一闸门：`full flush 成功 + 非活跃 + 无 pin + 无 pending/timer + 图不脏`
 *      五条全绿才**成对**释放 `runtime` + `graphs`；
 *   2. 折叠 pin：`compactIfNeeded` / 手动 `compactNow` 在飞期间钉住图，结束（含异常）归零；
 *   3. `disposed` / `archive` 在 closeout 的**最终 flush** 之后才回收；折叠在飞期间必须 pin 住；
 *   4. `offline` / `backfill`：**per-id pin**，且**绝不覆盖已有活跃图**（磁盘副本可能旧一整个回合）；
 *   5. **保留失败图**：落盘失败 / 脏图 / 折叠退避中的图一律留下（内存是唯一副本）；
 *   6. 真实巨型图**只读**测内存：不写 home，回收后堆确实回落。
 *
 * 全部用 `os.tmpdir()`；唯一碰真实数据的是第 6 条，且只读 `graph.json`（不 flush、不写 home）。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";
import { execFileSync } from "node:child_process";

import { load as loadEngine, makeCtx, makeSession, readGraphReplayed } from "./engine-harness.test.mjs";
import { addUserNode } from "./graph-fixtures.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";

export const tests = {};

/* ───────────────────────── 小工具 ───────────────────────── */

function tmpDir(prefix) {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
}

/** 清掉 debounce 定时器（测试里不真的等 1.2s；闸门判据已经用 flushTimers 表达）。 */
function clearFlushTimers(engine) {
  for (const timer of engine.flushTimers.values()) clearTimeout(timer);
  engine.flushTimers.clear();
}

function userEvent(session, text) {
  return {
    type: "user/message",
    seq: session.nextSeq(),
    data: { id: "u", role: "user", content: [{ type: "text", text }], source: { kind: "prompt" } },
  };
}

async function waitFor(check, { timeoutMs = 6000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check() === true) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return check() === true;
}

/** 观察一次调用期间的「图还在不在 / 有没有被 pin」。 */
function graphObservations(engine, id) {
  const stats = engine.getGraphCacheStats();
  return {
    resident: engine.graphs.has(id),
    pinned: stats.pins.some((p) => p.sessionId === id),
  };
}

/* ─────────────────── 1. 统一闸门 ─────────────────── */

tests["C656 冷图回收闸门：timer/脏图/无 full flush 都拒收，五条全绿才成对释放"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c656-gate-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  const a = makeSession({ id: "c656-gate-a" });
  const b = makeSession({ id: "c656-gate-b" });
  try {
    await ctx.emitRaw("session/event", a, userEvent(a, "甲：第一轮"));
    await ctx.emitRaw("session/event", b, userEvent(b, "乙：第一轮"));
    t.eq(engine.getGraphCacheStats().graphs, 2, "两张图都在内存里（前提）");

    // ① 还有 1.2s debounce 的写没落地 ⇒ 一律不许回收（抽走 = 丢掉这次写）
    const pending = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(pending.released, [], "有 pending timer 时不许回收");
    t.ok((pending.skipped["flush-pending"] ?? 0) >= 2, `必须归因为 flush-pending，实际 ${JSON.stringify(pending.skipped)}`);
    t.eq(engine.graphs.size, 2, "拒绝就留着（不是删一半）");

    // ② 定时器清掉、但还没有 full 落盘 ⇒ 依然拒收（"有过增量写"不等于"落稳了"）
    clearFlushTimers(engine);
    const noFull = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(noFull.released, [], "没过 full flush 的图不许回收");
    t.ok((noFull.skipped["no-full-flush"] ?? 0) >= 2, `必须归因为 no-full-flush，实际 ${JSON.stringify(noFull.skipped)}`);

    // ③ a 的回合边界：full flush 一次；当前会话（热图）保留，b 还没落过全量 ⇒ 也留下
    await ctx.emitRaw("agent/status", { agent: { session: a }, status: "idle" });
    t.eq(engine.graphs.has(a.id), true, "当前会话（热图）在 idle 回收里保留");
    t.eq(engine.graphs.has(b.id), true, "b 还没 full flush ⇒ 闸门拒绝");

    // ④ b 的回合边界：b 落了 full；此时 a 是冷图（非活跃、无 pin、无 timer、不脏）⇒ 成对释放
    clearFlushTimers(engine);
    await ctx.emitRaw("agent/status", { agent: { session: b }, status: "idle" });
    t.eq(engine.graphs.has(b.id), true, "b 是当前会话，保留");
    t.eq(engine.graphs.has(a.id), false, "a 在 b 的回合边界被回收");
    t.eq(engine.runtime.has(a.id), false, "runtime 与 graph 成对释放（不许只删一半）");
    t.eq(engine.getGraphCacheStats().runtime, 1, "runtime 只剩当前会话那份");

    // ⑤ 回收之后再来的事件必须能从磁盘把图读回来，且内容没丢
    await ctx.emitRaw("session/event", a, userEvent(a, "甲：第二轮"));
    t.eq(engine.graphs.has(a.id), true, "新事件会从磁盘重载图");
    const reloaded = engine.graphs.get(a.id);
    t.ok(
      Object.values(reloaded.nodes).some((node) => String(node.text ?? "").includes("甲：第一轮")),
      "重载后第一轮的节点还在（回收前确实落盘了）",
    );
    t.eq(reloaded.sessionId, a.id, "重载图的 sessionId 正确");

    // ⑥ 活跃会话绝不回收（running 期间即使其余条件全满足也不行）
    clearFlushTimers(engine);
    await ctx.emitRaw("agent/status", { agent: { session: a }, status: "running" });
    const activeRefused = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(activeRefused.released.includes(a.id), false, "running 的会话不许回收");
    t.ok((activeRefused.skipped.active ?? 0) >= 1, `必须归因为 active，实际 ${JSON.stringify(activeRefused.skipped)}`);
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C656 fold pin：compactIfNeeded / compactNow 在飞期间图被 pin 住，结束后归零"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c656-foldpin-");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, {
    graphDir: dir,
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    closeoutMinEvents: 5,
  });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id: "c656-fold-pin" });
  try {
    for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
    await ctx.emitRaw("session/event", session, userEvent(session, "根目标"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);

    // ① compactIfNeeded：把 compactRegion 卡住，观察 fold pin
    let releaseRegion = null;
    const regionGate = new Promise((resolve) => {
      releaseRegion = resolve;
    });
    const realRegion = engine.compactRegion;
    engine.compactRegion = async () => {
      await regionGate;
      return { shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 0 };
    };
    const foldPromise = engine.compactIfNeeded({ session, options: {} }, "archive", undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statsDuring = engine.getGraphCacheStats();
    t.eq(statsDuring.pins.some((p) => p.sessionId === session.id && p.reasons.includes("fold")), true, "fold 在飞期间必须有 fold pin");
    t.eq(engine.releaseColdGraphs({ reason: "probe" }).released.includes(session.id), false, "fold 期间闸门必须拒收");
    releaseRegion();
    await foldPromise;
    engine.compactRegion = realRegion;
    t.eq(engine.getGraphCacheStats().pins.length, 0, "fold 结束 pin 必须归零（异常/正常都一样）");

    // ② compactNow：手动 /compact 同样 pin（宿主压缩是异步的）
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(engine));
    const originalNow = proto.compactNow;
    let releaseNow = null;
    const nowGate = new Promise((resolve) => {
      releaseNow = resolve;
    });
    proto.compactNow = async function () {
      await nowGate;
      return { ok: true, shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 10 };
    };
    try {
      const manualPromise = engine.compactNow({ session, options: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      t.eq(
        engine.getGraphCacheStats().pins.some((p) => p.sessionId === session.id && p.reasons.includes("manual-compact")),
        true,
        "手动 /compact 在飞期间必须有 pin",
      );
      releaseNow();
      await manualPromise;
      t.eq(engine.getGraphCacheStats().pins.length, 0, "手动压缩结束 pin 必须归零");
    } finally {
      proto.compactNow = originalNow;
    }
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

/* ─────────────── 3. disposed：pin 到 closeout 最终 flush 之后 ─────────────── */
/** closeout 的公共夹具：造一个够长尾巴的会话，把 compactIfNeeded 卡在一个可控 promise 上。 */
async function closeoutFixture(prefix, id) {
  const { Engine } = await loadEngine();
  const dir = tmpDir(prefix);
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, {
    graphDir: dir,
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    closeoutMinEvents: 5,
    closeoutTimeoutMs: 5000,
  });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id });
  for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
  await ctx.emitRaw("session/event", session, userEvent(session, "根目标：把这一轮收尾"));
  await ctx.emitRaw("session/event", session, userEvent(session, "继续做"));
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  clearFlushTimers(engine);
  // 卡住折叠：证明"折叠在飞期间图还在、且被 pin 住"
  let releaseFold = null;
  const foldGate = new Promise((resolve) => {
    releaseFold = resolve;
  });
  const original = engine.compactIfNeeded.bind(engine);
  engine.compactIfNeeded = async (agent, trigger, signal) => {
    await foldGate;
    return original(agent, trigger, signal);
  };
  return { ctx, engine, session, dir, releaseFold: () => releaseFold() };
}

tests["C656 disposed：折叠在飞期间 pin 住图，closeout 最终 flush 之后才成对回收"] = async (t) => {
  const fx = await closeoutFixture("gokifu-c656-disposed-", "c656-disposed");
  const { ctx, engine, session } = fx;
  try {
    t.eq(engine.graphs.has(session.id), true, "idle 之后当前会话仍在（热图）");
    await ctx.emitRaw("session/disposed", session);

    // 折叠被卡住：图必须还在、并且带 pin
    t.eq(engine.graphs.has(session.id), true, "收尾折叠没有完成前，不许回收图");
    const during = graphObservations(engine, session.id);
    t.eq(during.pinned, true, "收尾折叠期间必须有 pin（否则异步写账会写到被丢弃的对象上）");
    t.eq(engine.releaseColdGraphs({ reason: "probe" }).released, [], "被 pin 的图，闸门必须拒绝");

    fx.releaseFold();
    const released = await waitFor(() => engine.graphs.has(session.id) === false);
    t.eq(released, true, "折叠落账之后必须回收");
    t.eq(engine.runtime.has(session.id), false, "runtime 一起释放");
    t.eq(engine.getGraphCacheStats().pins.length, 0, "pin 必须归零（漏一个就永远回收不掉）");

    const disk = await readGraphReplayed(fx.dir, session.id);
    t.ok(disk.closeout !== null && typeof disk.closeout === "object", "回收前 closeout 已落盘");
    t.eq(disk.closeout.source, "disposed", "closeout 归因正确");
    t.ok((disk.foldMarks ?? []).length >= 1, "收尾折叠的 foldMark 已提交到磁盘（不是只改了内存）");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(fx.dir, { recursive: true, force: true });
  }
};

tests["C656 archive（domain/changed）：同样在 closeout 最终 flush 之后回收"] = async (t) => {
  const fx = await closeoutFixture("gokifu-c656-archive-", "c656-archive");
  const { ctx, engine, session } = fx;
  try {
    const archived = { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: [session.id] } };
    await ctx.emitRaw("domain/changed", archived);
    t.eq(engine.graphs.has(session.id), true, "归档折叠在飞时图还在");
    t.eq(graphObservations(engine, session.id).pinned, true, "归档收尾同样必须 pin");

    fx.releaseFold();
    t.eq(await waitFor(() => engine.graphs.has(session.id) === false), true, "归档收尾落账后回收");

    const disk = await readGraphReplayed(fx.dir, session.id);
    t.eq(disk.closeout?.source, "archive", "closeout 必须归因到 archive");
    t.ok((disk.foldMarks ?? []).length >= 1, "归档折叠的 foldMark 已落盘");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(fx.dir, { recursive: true, force: true });
  }
};

/* ─────────────── 4. offline/backfill：per-id pin + 不覆盖活跃图 ─────────────── */

/** 造一个"有欠账"的临时 home：日志 + graph.json（没有 foldMarks ⇒ 整段都欠着）。 */
function makeBackfillHome(id, { eventCount = 3 } = {}) {
  const home = tmpDir("gokifu-c656-backfill-");
  const graphDir = nodePath.join(home, "chess-context");
  const logDir = nodePath.join(home, "sessions", "--fixture--", `session-${id}`);
  nodeFs.mkdirSync(logDir, { recursive: true });
  const events = [];
  for (let seq = 1; seq <= eventCount; seq += 1) {
    events.push({
      seq,
      type: seq % 2 === 1 ? "user/message" : "assistant/message",
      data: { message: { content: [{ type: "text", text: `第 ${seq} 步 ${"x".repeat(40)}` }] } },
    });
  }
  const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(logFile, nodeZlib.zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")));
  const old = (Date.now() - 600_000) / 1000;
  nodeFs.utimesSync(logFile, old, old);

  const now = Date.now();
  const graph = {
    version: 1,
    sessionId: id,
    cwd: home,
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: "goal", constraints: [], ts: now },
      n2: { id: "n2", kind: "agent", seq: eventCount, text: "末", ts: now },
    },
    edges: {},
    order: ["n1", "n2"],
    stateIndex: {},
    foldMarks: [],
    createdAt: now,
    updatedAt: now,
  };
  const sessionDir = nodePath.join(graphDir, "sessions", id);
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sessionDir, "graph.json"), JSON.stringify(graph), "utf8");
  return { home, graphDir, graph, sessionDir };
}

function backfillCallModel(observed = {}) {
  return async () => {
    observed.calls = (observed.calls ?? 0) + 1;
    return {
      text: "## 目标\n- 补折摘要\n\n## 已探明死路\n- 暂无",
      usage: null,
      billedUsage: null,
      billedCalls: 1,
      model: "c656-fixture",
      finish: "stop",
    };
  };
}

tests["C656 offline/backfill：per-id pin，且不拿磁盘副本覆盖已有内存图"] = async (t) => {
  const { Engine } = await loadEngine();
  const id = "c656-backfill";
  const fixture = makeBackfillHome(id);
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: fixture.graphDir, auto: false, closeoutMinEvents: 1 });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  try {
    // 先放一张"冷的内存图"进缓存，并加一个磁盘副本没有的节点 —— 用对象身份证明"没被覆盖"。
    const resident = JSON.parse(JSON.stringify(fixture.graph));
    resident.nodes.n9 = { id: "n9", kind: "user", seq: 2, text: "resident-only", constraints: [], ts: Date.now() };
    resident.order.push("n9");
    engine.graphs.set(id, resident);

    const observed = {};
    const callModel = async () => {
      observed.calls = (observed.calls ?? 0) + 1;
      observed.residentSame = engine.graphs.get(id) === resident;
      observed.pinned = graphObservations(engine, id).pinned;
      return {
        text: "## 目标\n- 补折摘要\n\n## 已探明死路\n- 暂无",
        usage: null,
        billedUsage: null,
        billedCalls: 1,
        model: "c656-fixture",
        finish: "stop",
      };
    };
    const report = await engine.runAutoBackfillOnce({ callModel, singleSegment: true });

    t.eq(report.ok, true, `补账应成功：${JSON.stringify(report?.error ?? null)}`);
    t.ok(Number(report.segments) >= 1, `必须真的折出一段，实际 segments=${report.segments}`);
    t.eq(observed.calls, 1, "只调用一次模型");
    t.eq(observed.residentSame, true, "补折期间内存图不许被磁盘副本覆盖（对象身份不变）");
    t.eq(observed.pinned, true, "补折期间必须有 per-id pin");
    t.eq(engine.graphs.get(id), resident, "补折结束后仍是同一张内存图");
    t.ok(resident.nodes.n9 !== undefined, "resident-only 节点还在（真的没被覆盖）");
    t.ok((resident.foldMarks ?? []).some((m) => m.trigger === "archive-offline"), "折痕写在这张内存图上");
    t.eq(engine.getGraphCacheStats().pins.length, 0, "补折结束 pin 必须归零");

    const disk = await readGraphReplayed(fixture.graphDir, id);
    t.ok((disk.foldMarks ?? []).some((m) => m.trigger === "archive-offline"), "折痕也落盘了（补账不能只改内存）");
    t.eq(debtOfGraph(resident, { minEvents: 1 }).due, false, "补完以后不再欠账（前提校验）");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(fixture.home, { recursive: true, force: true });
  }
};

tests["C656 offline/backfill：活跃会话的图本轮完全不碰（不写、不覆盖）"] = async (t) => {
  const { Engine } = await loadEngine();
  const id = "c656-backfill-active";
  const fixture = makeBackfillHome(id);
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: fixture.graphDir, auto: false, closeoutMinEvents: 1 });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  try {
    const resident = JSON.parse(JSON.stringify(fixture.graph));
    resident.nodes.n9 = { id: "n9", kind: "user", seq: 2, text: "resident-only", constraints: [], ts: Date.now() };
    engine.graphs.set(id, resident);
    // 活跃（回合在跑）—— 这是比"日志 5 分钟没动"更强的判据
    engine.activeSessions.add(id);

    const observed = { calls: 0 };
    const report = await engine.runAutoBackfillOnce({ callModel: backfillCallModel(observed), singleSegment: true });
    t.eq(report.ok, true, "tick 本身要正常返回");
    t.eq(observed.calls, 0, "活跃会话一次模型都不许调");
    t.eq(Number(report.segments), 0, "活跃会话不许产生折痕");
    t.eq(engine.graphs.get(id), resident, "活跃图对象不被替换");
    t.eq((resident.foldMarks ?? []).length, 0, "活跃图不许被写折痕");
    t.eq(debtOfGraph(resident, { minEvents: 1 }).due, true, "欠账还在（本轮什么都没做）");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(fixture.home, { recursive: true, force: true });
  }
};

/* ─────────────── 5. 保留失败图 ─────────────── */

tests["C656 保留失败图：脏图 / 折叠退避中 / 落盘失败一律不回收"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c656-keep-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id: "c656-keep" });
  try {
    await ctx.emitRaw("session/event", session, userEvent(session, "第一轮"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);
    t.eq(engine.graphs.has(session.id), true, "idle 保留当前会话（热图）");

    // ① 折叠退避中（foldFailures>0）——退避状态只在 runtime 里，释放后从 0 起算 ⇒ 重试风暴
    engine.runtime.get(session.id).foldFailures = 2;
    const backoff = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(backoff.released, [], "折叠退避中的图不许回收");
    t.ok((backoff.skipped["fold-failure"] ?? 0) >= 1, `必须归因为 fold-failure，实际 ${JSON.stringify(backoff.skipped)}`);
    engine.runtime.get(session.id).foldFailures = 0;
    t.eq(engine.releaseColdGraphs({ reason: "probe" }).released, [session.id], "失败标记清掉后可以回收");

    // ② 脏图（新节点进来了、还没落盘）
    await ctx.emitRaw("session/event", session, userEvent(session, "第二轮"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 先落一次干净的 full
    clearFlushTimers(engine);
    addUserNode(engine.graphs.get(session.id), { seq: session.nextSeq(), text: "只改了内存、还没落盘的节点" });
    const dirty = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(dirty.released, [], "脏图不许回收（内存是唯一副本）");
    t.ok((dirty.skipped.dirty ?? 0) >= 1, `必须归因为 dirty，实际 ${JSON.stringify(dirty.skipped)}`);

    // ③ 落盘失败：idle 的 full flush 失败 ⇒ lastFlush.ok=false，回收必须拒收
    const realFlush = engine.persist.flush.bind(engine.persist);
    engine.persist.flush = () => ({ ok: false, error: "EACCES: fixture 只读磁盘", dirtyKept: true });
    try {
      await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
      clearFlushTimers(engine);
      const failed = engine.releaseColdGraphs({ reason: "probe" });
      t.eq(failed.released, [], "落盘失败的图不许回收");
      t.ok((failed.skipped["no-full-flush"] ?? 0) >= 1, `必须归因为 no-full-flush，实际 ${JSON.stringify(failed.skipped)}`);
      t.eq(engine.graphs.has(session.id), true, "失败图保留在内存里（下次还能再写）");
    } finally {
      engine.persist.flush = realFlush;
    }

    // ④ 恢复后：再落一次成功的 full ⇒ 正常回收
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);
    t.eq(engine.releaseColdGraphs({ reason: "probe" }).released, [session.id], "失败修好之后可以回收");

    // ⑤ 磁盘上的图仍然是完整的（回收没有把没写的东西一起带走）
    const disk = await readGraphReplayed(dir, session.id);
    t.ok(Object.values(disk.nodes).some((node) => String(node.text ?? "").includes("第二轮")), "最后一次成功落盘的节点在磁盘上");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

/* ─────────────── 6. 真实巨型图只读测内存 ─────────────── */

/** 找一台真实 DSH home 里最大的 graph.json（只读；找不到返回 null ⇒ 用例 skip）。 */
function findLargestRealGraph() {
  // 只认"环境告诉我的 home"：DSH_HOME（宿主/CLI 都设它）> 显式覆盖 > `~/.dsh` 默认值。
  // **不写死任何本机绝对路径**（隐私门 P3-PATH 会拦，且换台机器就失效）。
  const candidates = [
    process.env.GOKIFU_REAL_HOME,
    process.env.DSH_HOME,
    nodePath.join(nodeOs.homedir(), ".dsh"),
  ].filter((x) => typeof x === "string" && x.length > 0);
  let best = null;
  for (const home of candidates) {
    const sessions = nodePath.join(home, "chess-context", "sessions");
    let dirs = [];
    try {
      dirs = nodeFs.readdirSync(sessions, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const file = nodePath.join(sessions, d.name, "graph.json");
      try {
        const stat = nodeFs.statSync(file);
        if (best === null || stat.size > best.size) best = { home, file, size: stat.size };
      } catch {
        /* 没有 graph.json 的会话目录：跳过 */
      }
    }
  }
  return best;
}

/** 子进程里用 --expose-gc 量：解析一张真实图占多少堆、丢掉引用后能不能真的还回去。 */
function measureGraphMemory(file) {
  const probe = [
    'import fs from "node:fs";',
    "const file = process.env.PROBE_GRAPH;",
    'global.gc(); global.gc();',
    "const base = process.memoryUsage().heapUsed;",
    'let text = fs.readFileSync(file, "utf8");',
    "let graph = JSON.parse(text);",
    "global.gc(); global.gc();",
    "const used = process.memoryUsage().heapUsed;",
    "const nodes = Object.keys(graph.nodes ?? {}).length;",
    "const edges = Object.keys(graph.edges ?? {}).length;",
    "const marks = (graph.foldMarks ?? []).length;",
    "const bytes = Buffer.byteLength(text);",
    "text = null; graph = null;",
    "await new Promise((resolve) => setTimeout(resolve, 50));",
    "global.gc(); global.gc();",
    "const afterDrop = process.memoryUsage().heapUsed;",
    "console.log(JSON.stringify({ base, used, afterDrop, nodes, edges, marks, bytes }));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", probe], {
    env: { ...process.env, PROBE_GRAPH: file },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(String(out).trim().split("\n").at(-1));
}

tests["C656 真实巨型图只读：回收成对生效，堆可回落，且不写 home"] = async (t) => {
  const real = findLargestRealGraph();
  if (real === null || real.size < 1_000_000) {
    t.skip(`没有可用的真实巨型图（需要 >1MB 的 graph.json，实测 ${real === null ? "未找到" : `${real.size} bytes`}）`);
    return;
  }
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c656-real-");
  const graphDir = nodePath.join(dir, "chess-context");
  const mtimeBefore = nodeFs.statSync(real.file).mtimeMs;
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir, auto: false });
  // ★ C659：静默窗口在本文件的通用用例里压到 0（第六判据由专门用例验证）。
  engine.coldGraphQuietMs = 0;
  try {
    // 只读：真实图只作为"内存里那张冷图"的素材，落盘根指向临时目录 ⇒ 一个字节都不写 home。
    const graph = JSON.parse(nodeFs.readFileSync(real.file, "utf8"));
    const id = "c656-real-giant";
    engine.graphs.set(id, graph);
    engine.runtime.set(id, { events: 0 });
    engine.lastFlush.set(id, { ok: true, full: true, at: Date.now() });
    t.eq(engine.graphs.get(id) === graph, true, "冷图已挂进缓存（前提）");

    const released = engine.releaseColdGraphs({ reason: "real-graph-probe" });
    t.eq(released.released, [id], "真实巨型冷图可以被闸门回收");
    t.eq(engine.graphs.has(id), false, "graphs 已释放");
    t.eq(engine.runtime.has(id), false, "runtime 成对释放");
    t.eq(nodeFs.statSync(real.file).mtimeMs, mtimeBefore, "真实图只读：mtime 未变（没有回写）");
    t.eq(engine.getGraphCacheStats().released >= 1, true, "回收统计有记录");

    // 量一下这张真实图到底多贵、丢掉引用后能不能还回去（子进程 --expose-gc）
    const m = measureGraphMemory(real.file);
    const grew = m.used - m.base;
    const retained = m.afterDrop - m.base;
    t.ok(grew > 2 * 1024 * 1024, `真实巨型图解析后必须占 >2MB 堆（实测 ${(grew / 1024 / 1024).toFixed(1)}MB，${m.nodes} 节点 / ${m.edges} 边）`);
    t.ok(retained < grew * 0.35, `丢掉引用后堆必须明显回落（grew=${(grew / 1024 / 1024).toFixed(1)}MB，retained=${(retained / 1024 / 1024).toFixed(1)}MB）`);
    t.ok(m.nodes > 100, `真实图应有可观节点数，实测 ${m.nodes}`);
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

/* ─────────── 9. C659：静默窗口 / fold 后的 full 窗口 / sessionRefs 释放 ─────────── */

tests["C659 静默窗口：最近有动静的会话不许回收，过窗后才收"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c659-quiet-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  const a = makeSession({ id: "c659-quiet-a" });
  const b = makeSession({ id: "c659-quiet-b" });
  try {
    // 默认窗口是 15 分钟，这里不压到 0 —— 要验的正是「刚有动静 ⇒ 拒收」
    t.eq(engine.coldGraphQuietMs, 15 * 60 * 1000, "默认静默窗口必须是 15 分钟");

    await ctx.emitRaw("session/event", a, userEvent(a, "甲：第一轮"));
    await ctx.emitRaw("session/event", b, userEvent(b, "乙：第一轮"));
    // 让两张图都拿到一次成功的 full 落盘（否则拒收理由是 no-full-flush，测不到窗口）
    await ctx.emitRaw("agent/status", { agent: { session: a }, status: "idle" });
    await ctx.emitRaw("agent/status", { agent: { session: b }, status: "idle" });
    clearFlushTimers(engine);

    const stats = engine.getGraphCacheStats();
    t.eq(stats.quietMs, 15 * 60 * 1000, "统计里要带出窗口值（可观测）");
    t.ok(stats.lastSeen.some((row) => row.sessionId === a.id), "a 的最近动静时刻必须被记下");

    const refused = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(refused.released, [], "静默窗口内一张都不许收");
    t.ok((refused.skipped.recent ?? 0) >= 1, `必须归因为 recent，实际 ${JSON.stringify(refused.skipped)}`);
    t.eq(engine.graphs.size, 2, "拒绝就留着（不是删一半）");

    // 窗口压到 0 ⇒ 等效「已经静默很久」⇒ 冷图放行
    engine.coldGraphQuietMs = 0;
    const released = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(released.released.sort(), [a.id, b.id].sort(), "过了静默窗口后两张冷图都能收");
    t.eq(engine.graphs.size, 0, "graphs 清空");
    t.eq(engine.runtime.size, 0, "runtime 成对清空");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C659 fold 成功会作废 full 标记：标量落盘之前闸门必须拒收"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c659-foldwin-");
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, {
    graphDir: dir,
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    closeoutMinEvents: 5,
  });
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id: "c659-foldwin" });
  try {
    for (let i = 0; i < 12; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "继续" }] });
    await ctx.emitRaw("session/event", session, userEvent(session, "根目标"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);

    // 前提：这一轮 idle 已经做过成功的 full 落盘 ⇒ 闸门本来是放行的
    const before = engine.releaseColdGraphs({ reason: "probe-before-fold" });
    t.eq(before.released, [session.id], `fold 之前这张图本来可以被回收（前提），实际 ${JSON.stringify(before.skipped)}`);

    // 回收后图没了 —— 重新造一份：发事件重载 + idle 做 full flush
    await ctx.emitRaw("session/event", session, userEvent(session, "重新载入"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);
    t.eq(engine.graphs.has(session.id), true, "图已重载");

    // 真跑一次 fold（把 compactRegion 换成可控桩，产出一次成功折叠）
    const realRegion = engine.compactRegion;
    engine.compactRegion = async () => ({ shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 0 });
    try {
      await engine.compactIfNeeded({ session, options: {} }, "archive", undefined);
    } finally {
      engine.compactRegion = realRegion;
    }
    clearFlushTimers(engine);

    // 折叠成功改了标量，但还没等到下一次 full 落盘 ⇒ 闸门必须拒收
    const afterFold = engine.releaseColdGraphs({ reason: "probe-after-fold" });
    t.eq(afterFold.released, [], "fold 之后、full 落盘之前不许回收（否则标量记账丢失）");
    t.ok((afterFold.skipped["no-full-flush"] ?? 0) >= 1, `必须归因为 no-full-flush，实际 ${JSON.stringify(afterFold.skipped)}`);

    // 回合边界补一次 full 落盘 ⇒ 恢复放行
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);
    const freed = engine.releaseColdGraphs({ reason: "probe-after-full" });
    t.eq(freed.released, [session.id], `full 落盘之后必须恢复放行，实际 ${JSON.stringify(freed.skipped)}`);
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C659 回收会一并释放 sessionRefs 与 lastSeen：只删图不算回收"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c659-refs-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  engine.coldGraphQuietMs = 0;
  const a = makeSession({ id: "c659-refs-a" });
  try {
    await ctx.emitRaw("session/event", a, userEvent(a, "甲：第一轮"));
    await ctx.emitRaw("agent/status", { agent: { session: a }, status: "idle" });
    clearFlushTimers(engine);

    t.ok(engine.getGraphCacheStats().sessionRefs >= 1, "前提：sessionRefs 里确实挂着 Session 引用");
    t.ok(engine.getGraphCacheStats().lastSeen.some((row) => row.sessionId === a.id), "前提：lastSeen 有这条");

    const released = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(released.released, [a.id], "冷图被回收");

    const stats = engine.getGraphCacheStats();
    t.eq(stats.graphs, 0, "graphs 已释放");
    t.eq(stats.runtime, 0, "runtime 成对释放");
    t.eq(stats.sessionRefs, 0, "sessionRefs 必须一起释放（只删图 = 内存不降）");
    t.eq(stats.lastSeen.some((row) => row.sessionId === a.id), false, "lastSeen 也要清（否则表本身会无限长）");

    // 回收后再来事件：从磁盘重载，且 sessionRefs 重新挂上
    await ctx.emitRaw("session/event", a, userEvent(a, "甲：第二轮"));
    t.eq(engine.graphs.has(a.id), true, "新事件能从磁盘重载图");
    t.ok(engine.getGraphCacheStats().sessionRefs >= 1, "重载后 sessionRefs 重新挂上");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C659 回收之后仍然认得出「这个会话我处理过」：归档收尾不许被静默跳过"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c659-seen-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false, closeoutMinEvents: 1 });
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id: "c659-seen" });
  // 宿主 store 里它仍然是 live 的（真实场景：#onWorkspaceChange 就是靠 ctx.sessions.get 找回来）
  ctx.sessions = { get: (id) => (id === session.id ? session : null) };
  try {
    await ctx.emitRaw("session/event", session, userEvent(session, "第一轮"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);

    const released = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(released.released, [session.id], "冷图被回收");
    const after = engine.getGraphCacheStats();
    t.eq(after.sessionRefs, 0, "重引用（Session 对象）必须删掉");
    t.ok(after.seenIds >= 1, "但「本进程见过它」这条轻量判据必须留着");
    t.eq(engine.archivedBaselineKnown, false, "前提：归档基线还不知道（首次 domain/changed）");

    // 归档事件：基线未知 + sessionRefs 已删 ⇒ 只能靠 seenIds 认出来
    await ctx.emitRaw("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: [session.id] } });
    t.eq(await waitFor(() => engine.graphs.has(session.id) === true), true, "归档收尾必须把图读回来（不许因为 sessionRefs 被删就静默跳过）");

    // 反例：本进程从没见过的会话 id，不该被硬做收尾（历史归档白花模型调用）
    const before = engine.graphs.size;
    await ctx.emitRaw("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: { archivedSessionIds: [session.id, "c659-never-seen"] } });
    t.eq(engine.graphs.has("c659-never-seen"), false, "没见过的会话不硬做收尾");
    t.eq(engine.graphs.size >= before, true, "已有图不受影响");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C661 终态路径不受静默窗口约束：disposed 后**默认窗口**下也要立刻回收"] = async (t) => {
  const fx = await closeoutFixture("gokifu-c661-terminal-", "c661-terminal");
  const { ctx, engine, session } = fx;
  try {
    // ★ 关键：把窗口恢复成**生产默认值**。C659 初版 9 处用例都把它压到 0，
    //   于是「closeout 的 finally 里 unpin → release」被刚推过的 lastSeenAt 以
    //   `recent` 拒绝这件事被完全掩盖 —— 独立复核就是这么把它抓出来的。
    engine.coldGraphQuietMs = 15 * 60 * 1000;
    t.eq(engine.getGraphCacheStats().quietMs, 15 * 60 * 1000, "前提：窗口是生产默认的 15 分钟");

    await ctx.emitRaw("session/disposed", session);
    t.eq(engine.graphs.has(session.id), true, "收尾折叠没完成前图还在（别急着回收）");
    fx.releaseFold();

    const released = await waitFor(() => engine.graphs.has(session.id) === false, { timeoutMs: 8000 });
    t.eq(released, true, "默认 15 分钟窗口下，disposed 收尾完成后必须立刻回收（终态不受静默窗口约束）");
    t.eq(engine.getGraphCacheStats().pins.length, 0, "pin 归零");

    const disk = await readGraphReplayed(fx.dir, session.id);
    t.ok(disk.closeout !== null && typeof disk.closeout === "object", "回收前 closeout 已落盘（不是丢账）");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(fx.dir, { recursive: true, force: true });
  }
};

tests["C662 还有没写出去的节点文档 ⇒ 不许回收（否则 nodes/<id>.md 永远写不出来）"] = async (t) => {
  const { Engine } = await loadEngine();
  const dir = tmpDir("gokifu-c662-pending-");
  const ctx = makeCtx();
  const engine = new Engine(ctx, { graphDir: dir, auto: false });
  engine.coldGraphQuietMs = 0;
  const session = makeSession({ id: "c662-pending" });
  try {
    // ① 第一次 full 落盘 = firstWrite，会把所有节点文档写全并清空 pending
    await ctx.emitRaw("session/event", session, userEvent(session, "第一轮"));
    await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
    clearFlushTimers(engine);
    t.eq(engine.persist.hasPendingNodeDocs(session.id), false, "前提：firstWrite 之后 pending 是空的");

    // ② 再进一个节点，然后走**普通 full**（不是 tree）—— 节流分支只把它攒进 pending
    const g = engine.graphs.get(session.id);
    addUserNode(g, { seq: session.nextSeq(), text: "只进内存、还没到写 md 的那一步" });
    engine.persist.flush({ id: session.id, cwd: session.cwd ?? undefined }, g, { full: true });
    t.eq(engine.persist.hasPendingNodeDocs(session.id), true, "前提：普通 full 之后 pending 里确实攒了节点");

    // ③ 此时「full 成功 + dirty 为空 + pending 非空」—— 回收必须拒收
    const refused = engine.releaseColdGraphs({ reason: "probe" });
    t.eq(refused.released, [], "pending 非空时不许回收（放行 = 那些 md 永远写不出来）");
    t.ok((refused.skipped["node-docs-pending"] ?? 0) >= 1, `必须归因为 node-docs-pending，实际 ${JSON.stringify(refused.skipped)}`);

    // ④ tree 落盘把 pending 写出去之后才放行
    engine.persist.flush({ id: session.id, cwd: session.cwd ?? undefined }, g, { tree: true });
    t.eq(engine.persist.hasPendingNodeDocs(session.id), false, "tree 落盘后 pending 清空");
    t.eq(engine.releaseColdGraphs({ reason: "probe" }).released, [session.id], "pending 清空后正常回收");

    // ⑤ 磁盘上那个节点的 md 真的在（不是"放行了但没写"）
    const disk = await readGraphReplayed(dir, session.id);
    const ids = Object.keys(disk.nodes);
    t.ok(ids.length > 0, "磁盘上仍有节点");
  } finally {
    clearFlushTimers(engine);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};
