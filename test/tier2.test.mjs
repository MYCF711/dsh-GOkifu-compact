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

tests["T2-0 只读核实（A 方案后）：空 `#tier2` 已删，常规 fold 之后直接调 `#tier2IfNeeded`"] = async () => {
  const src = nodeFs.readFileSync(ENGINE_SRC, "utf8");
  // ① 空的 #tier2 已彻底删掉（调用点与方法定义都不能再出现）
  if (src.includes("this.#tier2(session, g);")) throw new Error("空的 #tier2 调用点还在 —— A 方案应当已经删掉");
  if (/#tier2\(_session, _g\)/.test(src)) throw new Error("空的 #tier2 方法定义还在 —— A 方案应当已经删掉");
  // ② 常规 fold 之后确实调 #tier2IfNeeded，且带 tier2After>0 守卫
  if (!src.includes("await this.#tier2IfNeeded(agent, signal);")) throw new Error("常规 fold 之后找不到 #tier2IfNeeded 调用（A 方案的核心触发点）");
  if (!/if \(this\.chess\.tier2After > 0\) \{/.test(src)) throw new Error("找不到 tier2After>0 的守卫");
  // ③ pressure 分支的触发仍在（两条路径共用同一个方法）
  if (!/if \(trigger === "pressure" && this\.chess\.tier2After > 0\) \{/.test(src)) throw new Error("pressure 分支的触发被弄丢了");
  const calls = [...src.matchAll(/this\.#tier2IfNeeded\(agent, signal\)/g)].length;
  if (calls !== 2) throw new Error(`#tier2IfNeeded 应恰好 2 处调用（pressure 分支 + fold 之后），实际 ${calls}`);
  // ④ 防重入：有 in-flight 标记（重入直接返回 null）
  if (!/if \(this\._tier2InFlight\) return null;/.test(src)) throw new Error("缺少 _tier2InFlight 防重入");
  // ⑤ 没有 checkpoint 时，常规 fold 之后不该产生 tier2 记录（不该乱合并）
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
  if (tier2Marks(g).length !== 0) throw new Error("没有 checkpoint 时不该产生 tier2 记录");
  if (engine.compactCalls.length !== 1) throw new Error(`没有 checkpoint 时只该有常规 fold 一次 compactRegion，实际 ${engine.compactCalls.length}`);
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

tests["T2-3 裁剪：foldMarks 统一上限 20 条（P2-2 与 tier-2 共用同一条规则）"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-trim");
  const sessionId = "sess-t2-trim";
  // ★ 关键：预置基线必须发生在**任何 engine 实例碰这个 session 之前** ——
  //   persist 层会记住基线 sha（delta 帧按它写）。先让引擎写一轮再把 graph.json 换掉，
  //   会让后续 delta 的 baseHash 对不上（帧被当成孤儿跳过），测试会假红。
  const dirSessions = nodePath.join(dir, "sessions", sessionId);
  nodeFs.mkdirSync(dirSessions, { recursive: true });
  const seeded = createGraph({ sessionId });
  // ★ P2-2（task-192）：上限统一成 20（foldMark 的可观测字段也需要更多历史）；
  //   旧规则是 tier2After×2（默认 16）。这里预置 25 条，验证「不管哪条路径 push，都按 20 裁」。
  seeded.foldMarks = Array.from({ length: 25 }, (_, i) => ({ at: 1 + i, seqStart: 100 + i, seqEnd: 200 + i, tier2: i % 2 === 0 }));
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
  // 25 条历史 + 1 条新的 = 26 > 20 ⇒ 裁到 20
  if (g.foldMarks.length !== 20) throw new Error(`裁剪后应留 20 条，实际 ${g.foldMarks.length}`);
  // 保留的是**最后** 20 条：最后一条必须是刚写入的 tier2 记录
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

tests["T2-5 压力无关（A 方案）：auto 常规 fold 之后也按 tier2After 收 checkpoint"] = async () => {
  const { Engine, graphDir } = await load();
  const dir = nodePath.join(graphDir, "tier2-auto");
  const session = makeSession({ id: "sess-t2-auto" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  const cps = pushCheckpoints(session, 8);
  pushPlain(session, 19);
  const result = await engine.compactIfNeeded({ session, options: {} }, "auto", undefined);
  if (!result) throw new Error("auto 高水位应当 normal fold");
  // 两次 compactRegion：① 常规 fold ② fold 之后收 checkpoint
  if (engine.compactCalls.length !== 2) throw new Error(`应为「fold + tier-2」共 2 次 compactRegion，实际 ${engine.compactCalls.length}`);
  const tier = engine.compactCalls[1];
  if (tier.start !== cps[0] || tier.end !== cps[1]) throw new Error(`tier-2 范围必须是最老两条 ${cps[0]}–${cps[1]}，实际 ${tier.start}–${tier.end}`);
  for (const gone of [cps[0], cps[1]]) if (session.surface.nodes.includes(gone)) throw new Error(`checkpoint ${gone} 应已被合并`);
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 标量（foldMarks）靠回合边界全量 flush 提交
  const g = readGraphFull(dir, "sess-t2-auto");
  const marks = tier2Marks(g);
  if (marks.length !== 1) throw new Error(`auto 路径应产生 1 条 tier2 记录，实际 ${marks.length}`);
  if (marks[0].seqStart !== cps[0] || marks[0].seqEnd !== cps[1]) throw new Error("tier2 记账范围错");
};

tests["T2-6 A 方案收口：不递归、tier2After=0 不收、checkpoint 数量被压回上限内"] = async () => {
  const { Engine, graphDir } = await load();
  // ① auto 路径：一次 fold 只触发一次 tier-2（不递归、不重复）
  const dir = nodePath.join(graphDir, "tier2-norecurse");
  const session = makeSession({ id: "sess-t2-norecurse" });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 8 });
  pushCheckpoints(session, 9);
  pushPlain(session, 19);
  await engine.compactIfNeeded({ session, options: {} }, "auto", undefined);
  if (engine.compactCalls.length !== 2) throw new Error(`一次 fold 最多「fold + 1 次 tier-2」，实际 ${engine.compactCalls.length} 次 —— 疑似递归`);
  if (engine._tier2InFlight !== false) throw new Error("tier-2 结束后 _tier2InFlight 必须复位");
  // 9 → 7：两个被合并（stub 的 fold 新 checkpoint 不注册事件，所以只减不增）⇒ 数量回到上限内
  const cpsAfter = session.surface.nodes.filter((s) => session.eventAt(s)?.data?.source?.kind === "compact-checkpoint");
  if (cpsAfter.length !== 7) throw new Error(`9 个 checkpoint 合并两条后应剩 7 个，实际 ${cpsAfter.length}`);
  if (cpsAfter.length > 8) throw new Error("checkpoint 数量必须被压回 tier2After 以内");

  // ② 再折一次（checkpoint 仍不足 8）⇒ 只做常规 fold，不再叠加 tier-2
  pushPlain(session, 19);
  const before = engine.compactCalls.length;
  await engine.compactIfNeeded({ session, options: {} }, "auto", undefined);
  if (engine.compactCalls.length - before !== 1) throw new Error(`第二次 fold 只该有 1 次 compactRegion，实际 ${engine.compactCalls.length - before}`);

  // ③ tier2After=0 ⇒ 永不收（与 compactIfNeeded 的守卫一致）
  const dir0 = nodePath.join(graphDir, "tier2-zero2");
  const session0 = makeSession({ id: "sess-t2-zero2" });
  const engine0 = new Engine(ctx, { graphDir: dir0, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, tier2After: 0 });
  const cps0 = pushCheckpoints(session0, 12);
  pushPlain(session0, 19);
  await engine0.compactIfNeeded({ session: session0, options: {} }, "auto", undefined);
  if (engine0.compactCalls.length !== 1) throw new Error(`tier2After=0 时只该有常规 fold，实际 ${engine0.compactCalls.length} 次`);
  for (const seq of cps0) if (!session0.surface.nodes.includes(seq)) throw new Error(`tier2After=0 时 checkpoint ${seq} 不该被合并`);
};


