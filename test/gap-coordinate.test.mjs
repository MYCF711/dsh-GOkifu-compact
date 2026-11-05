/**
 * gap-coordinate.test.mjs —— gap 的「真实 seq 坐标」与「可折事件条数」不得混用。
 *
 * 反例：可折消息位于 seq 1/3/5/9/10，seq 2/4/6/7/8 是非消息事件。
 * 第一轮尾折 [9,10] 后留下 3 条真实缺口（seq 1/3/5）。旧代码把 events=3
 * 当成坐标跨度，第二轮算成 [1,3]，并用 coveredEnd-coveredStart+1=3 清账，
 * 于是 seq 5 永远没有 foldMark，debt 却已经 due=false。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";

import { load, makeCtx } from "./engine-harness.test.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { applyOfflineFoldToGraph, collectMessages, runOfflineFold } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const msg = (seq, type = "user/message", text = "x") => ({
  type,
  seq,
  data: { message: { content: [{ type: "text", text }] } },
});
const noise = (seq, type = "step/start") => ({ type, seq, data: {} });
const fakeModel = async () => ({
  text: "## 目标\n- 假模型摘要\n\n## 已建立事实\n- 不访问真实模型",
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  model: "fake",
  finish: "stop",
});

function mixedEvents() {
  return [
    msg(1),
    noise(2),
    msg(3, "assistant/message"),
    noise(4),
    msg(5),
    noise(6, "turn/start"),
    noise(7),
    msg(8, "system/message", "系统消息不可折"),
    msg(9, "user/message", "yyyyyyyy"),
    msg(10, "assistant/message", "yyyyyyyy"),
  ];
}

function foldableSeqs(events) {
  return collectMessages(events, { maxChars: Number.MAX_SAFE_INTEGER }).messages.map((m) => Number(m.seq));
}

function offlineRanges(graph) {
  return (graph.foldMarks ?? [])
    .filter((m) => m.trigger === "archive-offline")
    .map((m) => [Number(m.seqStart), Number(m.seqEnd)]);
}

function gapView(graph) {
  const gap = debtOfGraph(graph, { minEvents: 1 }).gap;
  return gap ? { from: gap.from, ...(gap.end === undefined ? {} : { end: gap.end }), events: gap.events } : null;
}

function uncoveredSeqs(events, graph) {
  const ranges = offlineRanges(graph);
  return foldableSeqs(events).filter((seq) => !ranges.some(([start, end]) => seq >= start && seq <= end));
}

async function withHomeEnv(home, fn) {
  const keys = ["DSH_HOME", "DSH_GOKIFU_NO_HEAL", "DSH_GOKIFU_AUTO_BACKILL_ROUNDS", "DSH_GOKIFU_AUTO_BACKFILL_ROUNDS", "DSH_GOKIFU_AUTO_BACKFILL_MAX"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DSH_HOME = home;
  process.env.DSH_GOKIFU_NO_HEAL = "1";
  process.env.DSH_GOKIFU_AUTO_BACKFILL_ROUNDS = "1";
  process.env.DSH_GOKIFU_AUTO_BACKFILL_MAX = "1";
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

tests["混合非消息事件：连续两轮补折必须覆盖 seq 1/3/5/9/10，seq5 不得永久漏折"] = async (t) => {
  const { Engine } = await load();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gap-coordinate-"));
  const sid = "gap-coordinate";
  const events = mixedEvents();
  const graphDir = nodePath.join(home, "chess-context");
  const sessionGraphDir = nodePath.join(graphDir, "sessions", sid);
  let engine;
  try {
    const logDir = nodePath.join(home, "sessions", "--gap-coordinate--", `session-${sid}`);
    nodeFs.mkdirSync(logDir, { recursive: true });
    const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
    nodeFs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`)));
    const old = (Date.now() - 600_000) / 1000;
    nodeFs.utimesSync(logFile, old, old);
    nodeFs.mkdirSync(sessionGraphDir, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(sessionGraphDir, "graph.json"),
      JSON.stringify({
        version: 1,
        sessionId: sid,
        cwd: home,
        rootUserNodeIds: ["n10"],
        nodes: { n10: { id: "n10", kind: "agent", seq: 10, text: "末", ts: 1 } },
        edges: {},
        order: ["n10"],
        stateIndex: {},
        // 已有一个在线折痕，首轮因此走「尾巴优先」；它不是离线折痕，不参与覆盖判定。
        foldMarks: [{ at: 1, seqStart: 0, seqEnd: 0, trigger: "pressure" }],
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await withHomeEnv(home, async () => {
      const ctx = makeCtx();
      ctx.llm.stream = async function* (options) {
        ctx.streamCalls.push(options);
        yield { type: "text-delta", text: "## 目标\n- 假模型摘要" };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      };
      engine = new Engine(ctx, {
        graphDir,
        auto: false,
        autoBackfill: true,
        closeoutMinEvents: 1,
        // [n10] x = 7 字符；[n10] yyyyyyyy = 14 字符。
        // 尾取时装下 seq9/10（28），头取时装下 seq1/3/5（21），同一个预算形成审核员反例。
        offlineMaxChars: 28,
        offlineFoldTimeoutMs: 5_000,
        summarizationProvider: "fake",
        summarizationModel: "fake-model",
      });
      engine._llmHandle = ctx.llm;

      const firstRun = await engine.runAutoBackfillOnce();
      const afterFirst = engine.graphs.get(sid);
      console.log(`FIXTURE foldableSeqs=${JSON.stringify(foldableSeqs(events))}; nonMessageSeqs=[2,4,6,7,8]`);
      console.log(`ROUND 1 run.ok=${firstRun.ok}; uncoveredHead=${afterFirst.closeout?.offlineUncoveredHead?.events}; gap=${JSON.stringify(gapView(afterFirst))}; offlineMarks=${JSON.stringify(offlineRanges(afterFirst))}`);
      console.log(`ROUND 1 debt.due=${debtOfGraph(afterFirst, { minEvents: 1 }).due}; partial=${afterFirst.closeout?.partial === true}`);
      t.eq(firstRun.ok, true, "第一轮自动补折");
      // ★ 修正（Lead）：这条守卫原本假设「首轮**尾折** [9,10]、留下 seq1/3/5 缺口」。
      //   但离线补账**设计就是从头取**（offline-fold.mjs:342-343、:959-962），
      //   首轮按头取把 [1,10] 全折了 —— **剩不下缺口**。已用对照实验确认：HEAD 与加修复后首轮行为一致。
      //   所以这里守的是「头取全折 ⇒ **没有永久漏折**」（seq5 在 [1,10] 里被折到），
      //   而「有缺口时 gap.end 必须指向真实 seq」由 test/gap-coordinate-unit.test.mjs 直接守。
      t.eq(offlineRanges(afterFirst), [[1, 10]], "离线补账是 head-first：首轮按头取覆盖全区间");
      t.eq(uncoveredSeqs(events, afterFirst), [], "首轮后所有可折消息（含 seq5）都已被折到，无永久漏折");

      const secondRun = await engine.runAutoBackfillOnce();
      const afterSecond = engine.graphs.get(sid);
      const debt2 = debtOfGraph(afterSecond, { minEvents: 1 });
      const ranges2 = offlineRanges(afterSecond);
      const unfolded = uncoveredSeqs(events, afterSecond);
      console.log(`ROUND 2 run.ok=${secondRun.ok}; window2=${JSON.stringify(ranges2.at(-1))}; offlineMarks=${JSON.stringify(ranges2)}`);
      console.log(`ROUND 2 closeout.partial=${afterSecond.closeout?.partial === true}; gap=${JSON.stringify(gapView(afterSecond))}; debt2.due=${debt2.due}`);
      console.log(`UNFOLDED real foldable seqs=${JSON.stringify(unfolded)}`);
      t.eq(secondRun.ok, true, "第二轮自动补折");
      // 首轮已按头取全折 ⇒ 第二轮**无账可补**，不应再为「不存在的缺口」发起模型调用。
      t.eq(ctx.streamCalls.length, 1, "首轮全折后第二轮不应再调模型（没有缺口）");
      t.eq(ranges2, [[1, 10]], "折痕仍只有首轮那一段，不虚构第二轮窗口");
      t.eq(unfolded, [], "所有真实消息最终都必须被折到");
      t.eq(afterSecond.closeout?.partial === true, false, "两轮后不得仍有 partial");
      t.eq(debt2.gapEvents, 0, "两轮后不得遗留缺口条数");
      t.eq(debt2.due, false, "真实消息全部覆盖后才允许结清");
    });
  } finally {
    try { clearTimeout(engine?._autoBackfill?.first); } catch { /* ignore */ }
    try { clearInterval(engine?._autoBackfill?.timer); } catch { /* ignore */ }
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["纯非消息头部：可折缺口仍为 0（保留 T64）"] = async (t) => {
  const events = [
    noise(1, "session"),
    noise(2, "sandbox/mode"),
    noise(3, "turn/start"),
    noise(4),
    msg(5, "system/message", "系统消息"),
    noise(6, "approval/policy"),
    noise(7, "permission/preset"),
    msg(8, "tool/result", "工具结果不可折"),
    msg(9),
    msg(10, "assistant/message"),
  ];
  const out = await runOfflineFold({
    graph: { sessionId: "gap-coordinate-empty-head", nodes: {}, edges: {}, foldMarks: [] },
    events,
    rangeStart: 1,
    rangeEnd: 8,
    fromHead: true,
    callModel: fakeModel,
    measureQuality: () => null,
  });
  t.eq(out.uncoveredHead, 0, "纯非消息头部不得虚构缺口");
  t.eq(out.uncoveredTail, 0, "欠账区间内没有可折尾巴");
  t.eq(out.coveredStart, 9, "实际覆盖仍从第一条真实消息 seq9 开始");
};

tests["部分覆盖扣账：coveredEvents 按条数，下一 gap.from/end 用真实 seq5"] = async (t) => {
  const events = [msg(1), noise(2), msg(3, "assistant/message"), noise(4), msg(5)];
  const graph = { sessionId: "gap-coordinate-partial", nodes: {}, edges: {}, foldMarks: [], closeout: {} };
  const result = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 5,
    maxChars: 2,
    fromHead: true,
    callModel: fakeModel,
    measureQuality: () => null,
  });
  t.eq(result.coveredEvents, 2, "坐标跨度 1..3 是 3，但实际只覆盖 seq1/3 两条");
  t.eq(result.uncoveredTail, 1, "还剩 seq5 一条");
  t.eq(result.uncoveredTailStart, 5, "剩余起点是真实 seq5");
  t.eq(result.uncoveredTailEnd, 5, "剩余终点是真实 seq5");
  applyOfflineFoldToGraph(graph, result, {
    rangeStart: 1,
    rangeEnd: 5,
    previousGapEvents: 3,
    previousGapEnd: 5,
    provider: "fake",
    model: "fake",
  });
  t.eq(graph.closeout.offlineUncoveredHead, { from: 5, end: 5, events: 1 }, "剩余缺口必须同时记录真实坐标与条数");
  t.eq(graph.closeout.partial, true, "还剩 seq5 时不得提前结清");
};
