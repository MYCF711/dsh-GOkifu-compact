/**
 * tier2.test.mjs —— tier-2（checkpoint 合并）的**行为**回归矩阵（task-128 / OPT-TIER2）
 *
 * 为什么要有它：评审报告把 `src/engine.mjs:670` 的 `#tier2` 说成「无调用点、应删」。
 * 只读核实结论（本文件用测试钉住）：
 *   · `#tier2(session, g)` 在 `:611` **确实被调用**（每次常规 fold 之后一行）；
 *   · 但它的方法体是**空的**（只有一行注释），所以它是**无副作用的空调用**，不是「无调用点」；
 *   · 真正干活的是 `#tier2IfNeeded`（`:642`），它**只在 `compactIfNeeded` 的
 *     `trigger === "pressure" && tier2After > 0` 分支里被调用**（`:500-501`）。
 *   ⇒ 报告的「无调用点」判断是错的；「应删」也不成立（删了会顺手改到私有方法面）。
 *     本刀**不动 engine.mjs**，只把行为钉成测试（含空方法无副作用这一条）。
 *
 * 覆盖：8 checkpoint 触发一次 / range = 最老两条 / foldMarks 追加 tier2:true /
 *       foldMarks 裁剪 / tier2After=0 永不触发 / 非 pressure 不触发。
 * 夹具复用 `engine-harness.test.mjs` 的 fake engine（同一套 stub 与假 session）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { load, makeSession, makeCtx, readGraph } from "./engine-harness.test.mjs";
import { fromJSON, decodeDeltaFrames, applyDelta, sha } from "../src/rooms/kifu-model.mjs";
import { createGraph, toJSON } from "./graph-fixtures.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = nodePath.join(HERE, "..", "src", "engine.mjs");

/** 在 surface 上放 n 个 checkpoint 事件（`checkpointSeqs` 的判据：user/message + source.kind）。 */
function pushCheckpoints(session, n, { from = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const seq = session.push("user/message", { source: { kind: "compact-checkpoint", compactionId: `cp-${from + i}` }, content: [{ type: "text", text: "cp" }] });
    out.push(seq);
  }
  return out;
}

/** 在 checkpoint 之后再补若干普通节点，保证有可压内容。 */
function pushPlain(session, n) {
  for (let i = 0; i < n; i += 1) {
    session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  }
}

/**
 * 读「完整」图：graph.json 基线 + 重放 delta。
 * 为什么不能只用 readGraph：tier-2 的 #flush 默认写的是 **delta 帧**（不是基线快照），
 * 只读 graph.json 会看不到刚追加的 foldMarks。
 */
function readGraphFull(graphDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const file = nodePath.join(graphDir, "sessions", safe, "graph.json");
  const text = nodeFs.readFileSync(file, "utf8");
  const g = fromJSON(text);
  const dfile = file + ".delta.jsonl";
  if (nodeFs.existsSync(dfile)) {
    const { frames } = decodeDeltaFrames(nodeFs.readFileSync(dfile, "utf8"), sha(text).slice(0, 16));
    for (const frame of frames) applyDelta(g, frame);
  }
  return g;
}

const tier2Marks = (graph) => (graph.foldMarks ?? []).filter((m) => m.tier2 === true);

/* ───────────────────────────── 用例 ───────────────────────────── */

tests["T2-0 只读核实：`#tier2` 有调用点但方法体是空的；真正干活的是 `#tier2IfNeeded`"] = async () => {
  const src = nodeFs.readFileSync(ENGINE_SRC, "utf8");
  // ① 空方法确实被调用（评审报告说「无调用点」是错的）
  if (!src.includes("this.#tier2(session, g);")) throw new Error("`#tier2` 的调用点不见了 —— 先确认代码是否被改过");
  // ② 方法体是空的（只有注释）
  const body = /#tier2\(_session, _g\) \{\n([\s\S]*?)\n  \}/.exec(src);
  if (body === null) throw new Error("找不到 `#tier2` 定义");
  const code = body[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("/*") && !l.startsWith("*") && !l.startsWith("//") && !l.endsWith("*/"))
    .join("");
  if (code !== "") throw new Error(`\`#tier2\` 不再是空方法（现在有代码：${code}）—— 本测试的前提变了，需要复核`);
  // ③ 真正干活的那个只在 pressure 分支被调用
  const calls = [...src.matchAll(/this\.#tier2IfNeeded\(/g)].length;
  if (calls !== 1) throw new Error(`#tier2IfNeeded 调用点应为 1 处，实际 ${calls}`);
  const guard = /if \(trigger === "pressure" && this\.chess\.tier2After > 0\) \{/.test(src);
  if (!guard) throw new Error("找不到 pressure + tier2After>0 的守卫");
  // ④ 空调用**无副作用**：跑一次常规 fold，foldMarks 只多一条**非 tier2** 记录
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-t2-noop" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: nodePath.join(graphDir, "tier2-noop"), auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  pushPlain(session, 19);
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("应当 normal fold");
  const g = readGraph(nodePath.join(graphDir, "tier2-noop"), "sess-t2-noop");
  if ((g.foldMarks ?? []).length !== 1) throw new Error(`只有一条 normal foldMark，实际 ${(g.foldMarks ?? []).length}`);
  if (g.foldMarks[0].tier2 === true) throw new Error("normal fold 的记录不该带 tier2 标记");
  if (tier2Marks(g).length !== 0) throw new Error("`#tier2` 空调用不该产生 tier2 记录");
};

tests["T2-1 tier2After=8：第 8 个 checkpoint 触发合并一次，range = 最老两条（不是最老一条、不是最新）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-trigger");
  const session = makeSession({ id: "sess-t2-trigger" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  const cps = pushCheckpoints(session, 8);
  pushPlain(session, 3);
  const before = [...session.surface.nodes];
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  if (!result) throw new Error("tier-2 应当触发并返回合并结果");
  if (engine.compactCalls.length !== 1) throw new Error(`compactRegion 应被调用 1 次，实际 ${engine.compactCalls.length}`);
  const call = engine.compactCalls[0];
  if (call.start !== cps[0]) throw new Error(`起点必须是最老 checkpoint ${cps[0]}，实际 ${call.start}`);
  if (call.end !== cps[1]) throw new Error(`终点必须是第二条 checkpoint ${cps[1]}，实际 ${call.end}`);
  // 合并后：被合并的两个 checkpoint 从 surface 消失，多出一个新 checkpoint
  for (const gone of [cps[0], cps[1]]) {
    if (session.surface.nodes.includes(gone)) throw new Error(`合并后 ${gone} 不该还在 surface 上`);
  }
  const survivors = session.surface.nodes.filter((s) => !before.includes(s));
  if (survivors.length !== 1) throw new Error(`合并应产生 1 个新 checkpoint 节点，实际 ${survivors.length}`);
  // 只合并最老两条：其余 6 条仍在
  for (const keep of cps.slice(2)) {
    if (!session.surface.nodes.includes(keep)) throw new Error(`checkpoint ${keep} 不该被合并`);
  }
  // 记账：追加一条 tier2:true，且 seqStart/seqEnd = 最老两条
  const g = readGraphFull(dir, "sess-t2-trigger");
  const marks = tier2Marks(g);
  if (marks.length !== 1) throw new Error(`tier2 标记应 1 条，实际 ${marks.length}`);
  if (marks[0].seqStart !== cps[0] || marks[0].seqEnd !== cps[1]) {
    throw new Error(`tier2 记账范围错：期望 ${cps[0]}–${cps[1]}，实际 ${marks[0].seqStart}–${marks[0].seqEnd}`);
  }
  // tier-2 走的是自己的记账路径 ⇒ 不走常规 fold 的 foldCount/普通 foldMark
  if (g.foldCount !== 0) throw new Error(`tier-2 不该增加 foldCount，实际 ${g.foldCount}`);
  if ((g.foldMarks ?? []).length !== 1) throw new Error(`foldMarks 应只有那条 tier2，实际 ${(g.foldMarks ?? []).length}`);
};

tests["T2-2 不足阈值不触发：7 个 checkpoint（tier2After=8）一次都不合并"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-under");
  const session = makeSession({ id: "sess-t2-under" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  pushCheckpoints(session, 7);
  pushPlain(session, 3);
  await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  const g = readGraph(dir, "sess-t2-under");
  if (tier2Marks(g).length !== 0) throw new Error("7 个 checkpoint 不该触发 tier-2");
  // 不足时不能误报：compactRegion 的调用（若有）不可能是「最老两条」
  for (const call of engine.compactCalls) {
    if (call.end === session.surface.nodes[1]) throw new Error("不足阈值却按 tier-2 范围合并了");
  }
};

tests["T2-3 裁剪：foldMarks 超过 tier2After×2 时只留最后 tier2After 条"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-trim");
  const sessionId = "sess-t2-trim";
  // ★ 关键：预置基线必须发生在**任何 engine 实例碰这个 session 之前** ——
  //   persist 层会记住基线 sha（delta 帧按它写）。先让引擎写一轮再把 graph.json 换掉，
  //   会让后续 delta 的 baseHash 对不上（帧被当成孤儿跳过），测试会假红。
  const dirSessions = nodePath.join(dir, "sessions", sessionId);
  nodeFs.mkdirSync(dirSessions, { recursive: true });
  const seeded = createGraph({ sessionId });
  seeded.foldMarks = Array.from({ length: 16 }, (_, i) => ({ at: 1 + i, seqStart: 100 + i, seqEnd: 200 + i, tier2: i % 2 === 0 }));
  nodeFs.writeFileSync(nodePath.join(dirSessions, "graph.json"), toJSON(seeded), "utf8");

  const session = makeSession({ id: sessionId });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  const cps = pushCheckpoints(session, 8);
  pushPlain(session, 3);
  await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  // 标量（foldMarks）不单独触发 delta —— 回合边界 idle 的全量 flush 才是提交点（与真实 engine 一致）
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
  const g = readGraphFull(dir, sessionId);
  // 16 条历史 + 1 条新的 = 17 > tier2After×2 = 16 ⇒ 裁到 8
  if (g.foldMarks.length !== 8) throw new Error(`裁剪后应留 8 条，实际 ${g.foldMarks.length}`);
  // 保留的是**最后** 8 条：最后一条必须是刚写入的 tier2 记录
  const last = g.foldMarks.at(-1);
  if (last.tier2 !== true) throw new Error("保留的最后一条应当是刚写的 tier2 记录");
  if (last.seqStart !== cps[0] || last.seqEnd !== cps[1]) throw new Error("tier2 记账范围错");
  // 裁剪留的是「最近」的：最老的历史记录（at=1）必须已被丢掉
  if (g.foldMarks.some((m) => m.at === 1)) throw new Error("最老的历史 foldMark 应被裁掉");
};

tests["T2-4 tier2After=0：永不触发（12 个 checkpoint 也不合并）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-zero");
  const session = makeSession({ id: "sess-t2-zero" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 0 });
  const cps = pushCheckpoints(session, 12);
  pushPlain(session, 3);
  await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  const g = readGraphFull(dir, "sess-t2-zero");
  if (tier2Marks(g).length !== 0) throw new Error("tier2After=0 时绝不允许合并");
  for (const call of engine.compactCalls) {
    if (call.start === cps[0] && call.end === cps[1]) throw new Error("tier2After=0 却按 tier-2 范围合并了");
  }
  // 12 个 checkpoint 一个都不许消失
  for (const seq of cps) {
    if (!session.surface.nodes.includes(seq)) throw new Error(`tier2After=0 时 checkpoint ${seq} 不该被合并`);
  }
};

tests["T2-5 非 pressure 不触发（现状）：auto/context-overflow 都不走 tier-2"] = async () => {
  const { Engine, graphDir } = await load();
  // ① auto + 低于阈值：既不 fold 也不 tier-2
  const dir = nodePath.join(graphDir, "tier2-auto");
  const session = makeSession({ id: "sess-t2-auto" });
  const ctx = makeCtx({ measureTotal: () => 30_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  const cps = pushCheckpoints(session, 8);
  pushPlain(session, 3);
  const r1 = await engine.compactIfNeeded({ session, options: {} }, "auto", undefined);
  if (r1 !== null) throw new Error(`auto + 低水位应当不 fold，实际 ${JSON.stringify(r1)?.slice(0, 60)}`);
  if (engine.compactCalls.length !== 0) throw new Error("auto 分支不该调用 compactRegion");
  for (const seq of cps) {
    if (!session.surface.nodes.includes(seq)) throw new Error("非 pressure 分支不许合并 checkpoint");
  }
  // ② auto + 高于阈值：走常规 fold（说明「8 个 checkpoint 在非 pressure 下也没被 tier-2 吃掉」）
  const ctx2 = makeCtx({ measureTotal: () => 300_000 });
  const dir2 = nodePath.join(graphDir, "tier2-auto2");
  const session2 = makeSession({ id: "sess-t2-auto2" });
  const engine2 = new Engine(ctx2, { graphDir: dir2, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  const cps2 = pushCheckpoints(session2, 8);
  pushPlain(session2, 19);
  await engine2.compactIfNeeded({ session: session2, options: {} }, "auto", undefined);
  const g2 = readGraphFull(dir2, "sess-t2-auto2");
  if (tier2Marks(g2).length !== 0) throw new Error("非 pressure 触发绝不允许产生 tier2 记录");
  for (const seq of cps2) {
    if (!session2.surface.nodes.includes(seq)) throw new Error(`非 pressure 下 checkpoint ${seq} 不该被合并`);
  }
};
