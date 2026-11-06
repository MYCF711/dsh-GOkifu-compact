/**
 * archive-flush-md.test.mjs —— 归档前必须把末尾节点文档结清。
 *
 * 稳态节流保持不变：dirty 第一次进 nodesPendingMd，下一次普通 flush 才写。
 * closeout 是唯一的例外：会话就要静止，不能再等那一次未来的 flush。
 * 所有图都写在 os.tmpdir() 的临时 home；引擎测试不调模型。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { createPersistStore, sessionPaths } from "../src/rooms/kifu-persist.mjs";
import { IN_FLIGHT_MS, splitMissingNodeDocs } from "../scripts/repair-node-docs.mjs";
import { addUserNode, createGraph } from "./graph-fixtures.mjs";
import { load as loadEngine, makeCtx, makeSession } from "./engine-harness.test.mjs";

export const tests = {};

async function withTempHome(fn) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-archive-flush-md-"));
  try {
    return await fn(home);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

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

tests["归档 closeout 当次结清 pending 与本轮 dirty 的节点 md"] = async (t) => {
  await withTempHome((home) => {
    const root = nodePath.join(home, "chess-context");
    const store = createPersistStore({ root });
    const session = { id: "archive-store", cwd: home };
    const graph = createGraph(session);
    const first = addUserNode(graph, { seq: 1, text: "首个节点" });
    const paths = sessionPaths(root, session.id);
    const md = (id) => nodePath.join(paths.nodesDir, `${id}.md`);

    t.eq(store.flush(session, graph).ok, true, "首次落盘成功");
    t.eq(nodeFs.existsSync(md(first.id)), true, "首个节点已有 md");

    const pending = addUserNode(graph, { seq: 2, text: "已进入 graph delta、等待下一次 flush 的节点" });
    t.eq(store.flush(session, graph).ok, true, "稳态 flush 成功");
    t.eq(nodeFs.existsSync(md(pending.id)), false, "稳态第一次 flush 只进 pending");
    t.eq(store.load(session).graph.nodes[pending.id]?.text, pending.text, "graph delta 已能读回末尾节点");

    t.eq(store.flush(session, graph, { full: true, closeout: true }).ok, true, "归档 closeout 成功");
    t.eq(nodeFs.existsSync(md(pending.id)), true, "归档当次结清此前 pending 的 md");

    const tail = addUserNode(graph, { seq: 3, text: "归档信号到达时仍是本轮 dirty 的末尾节点" });
    t.eq(store.flush(session, graph, { full: true, closeout: true }).ok, true, "再次归档 closeout 成功");
    t.eq(nodeFs.existsSync(md(tail.id)), true, "归档当次也写出本轮 dirty，不许再留给不存在的下一次 flush");
    t.eq(store.load(session).graph.nodes[tail.id]?.text, tail.text, "图与 md 指向同一个末尾节点");
  });
};

tests["真实 Engine 归档提前返回时末尾节点 md 仍已落盘"] = async (t) => {
  await withTempHome(async (home) => {
    const { Engine } = await loadEngine();
    const graphDir = nodePath.join(home, "chess-context");
    const ctx = makeCtx();
    const engine = new Engine(ctx, { graphDir, auto: false, closeoutFold: false });
    const session = makeSession({ id: "archive-engine" });
    try {
      await ctx.emitRaw("session/event", session, userEvent(session, "首个节点"));
      await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" });
      clearFlushTimers(engine);

      const graph = engine.graphs.get(session.id);
      const tail = addUserNode(graph, { seq: session.nextSeq(), text: "归档前最后一个节点" });
      // 老 closeout 视为已结清，#closeout 会在首次 full flush 后提前返回。
      // 旧实现因此把 tail 留进 pending，且没有第二次 flush；这条在修复前必须红。
      graph.closeout = { at: 1, eventsSinceLastFold: session.seq, folds: 0, source: "archive" };
      await ctx.emitRaw("session/disposed", session);

      const paths = sessionPaths(graphDir, session.id);
      const disk = JSON.parse(nodeFs.readFileSync(paths.graphFile, "utf8"));
      t.eq(disk.nodes[tail.id]?.text, tail.text, "归档图里已有末尾节点（夹具必须真的命中漏写现场）");
      t.eq(nodeFs.existsSync(nodePath.join(paths.nodesDir, `${tail.id}.md`)), true, "提前返回也不能把末尾 md 留在 pending");
    } finally {
      clearFlushTimers(engine);
    }
  });
};

tests["普通 full flush 节流不变：在途节点不提前写，下一次普通 flush 才写"] = async (t) => {
  await withTempHome((home) => {
    const root = nodePath.join(home, "chess-context");
    const store = createPersistStore({ root });
    const session = { id: "steady-state", cwd: home };
    const graph = createGraph(session);
    addUserNode(graph, { seq: 1, text: "基线" });
    store.flush(session, graph);
    const paths = sessionPaths(root, session.id);
    const md = (id) => nodePath.join(paths.nodesDir, `${id}.md`);

    const fresh = addUserNode(graph, { seq: 2, text: "刚创建且图仍在写" });
    t.eq(store.flush(session, graph, { full: true }).ok, true, "普通 full flush 成功");
    t.eq(nodeFs.existsSync(md(fresh.id)), false, "full 不是 closeout：在途节点仍按节流延迟");
    const split = splitMissingNodeDocs(graph, [fresh.id], Date.now());
    t.eq(split.inFlight.map((item) => item.id), [fresh.id], `夹具命中 repair 的 <${IN_FLIGHT_MS / 1000} 秒在途口径`);
    t.eq(split.missing, [], "在途不计真缺失");

    t.eq(store.flush(session, graph).ok, true, "下一次普通 flush 成功");
    t.eq(nodeFs.existsSync(md(fresh.id)), true, "下一次普通 flush 写出此前 pending");

    const next = addUserNode(graph, { seq: 3, text: "下一批在途节点" });
    t.eq(store.flush(session, graph, { full: true }).ok, true, "后续普通 full flush 成功");
    t.eq(nodeFs.existsSync(md(next.id)), false, "节流不是一次性状态：新 dirty 仍先进入 pending");
  });
};
