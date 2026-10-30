/**
 * kifu-persist.test.mjs —— R01 落盘房间的直测（A2-2，2026-10-30）
 *
 * 为什么必须单开一个文件：`persist-incremental` 是**经 engine 间接覆盖**的，它证明不了
 * 「写序 / 失败注入 / 字节等价」这三件事 —— 而这三件正是 R01 的契约本体。
 *
 * 本文件用**假 port**（记录每次 fs 调用，并能在指定点注入异常）+ 临时目录，钉住：
 *   ① 写序：`_ORDER` 逐项（index → nodes → graphTmp → rename → delta → clearDirty）；
 *   ② 三个失败注入点：rename 之前 / rename 之后清 delta 之前 / 半写帧；
 *   ③ 字节等价：`store.flush` 的产物 vs R00 纯函数（toJSON/renderIndexMd/renderNodeMd/encodeDeltaFrame）
 *      逐字节相同 —— 把落盘字节钉在 R00 上，任何漂移都红；
 *   ④ `load` 遇坏 JSON / 版本不符 ⇒ `{repaired:true, repairedReason}` + 空图，**不静默**。
 */

import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import {
  _ORDER,
  createFsPort,
  createPersistStore,
  graphRoot,
  safeSessionId,
  sessionPaths,
  LEDGER_BUDGET_FILE,
  INDEX_APPEND_LIMIT,
  DELTA_COMPACT_MIN,
  DELTA_COMPACT_RATIO,
} from "../src/rooms/kifu-persist.mjs";
import {
  addEdge,
  addUserNodeId,
  clearDirty,
  createGraph,
  deltaFromDirty,
  encodeDeltaFrame,
  peekDirty,
  renderIndexMd,
  renderNodeMd,
  sha,
  toJSON,
} from "./graph-fixtures.mjs";

/* ───────────────────────────── 夹具 ───────────────────────────── */

function tmpRoot() {
  return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-r01-"));
}

/**
 * 假 port：包真实 fs，记录调用序列，并可在指定点注入异常。
 * @param {{failWhen?: (op: string, args: any[]) => boolean}} [opts]
 */
function makePort(opts = {}) {
  const ops = [];
  const failWhen = opts.failWhen ?? (() => false);
  const wrap = (name) => (...args) => {
    ops.push({ op: name, args });
    if (failWhen(name, args)) throw new Error(`injected-${name}`);
    return nodeFs[name](...args);
  };
  return {
    ops,
    port: {
      readFileSync: wrap("readFileSync"),
      writeFileSync: wrap("writeFileSync"),
      appendFileSync: wrap("appendFileSync"),
      renameSync: wrap("renameSync"),
      statSync: wrap("statSync"),
      existsSync: wrap("existsSync"),
      mkdirSync: wrap("mkdirSync"),
      rmSync: wrap("rmSync"),
    },
    /** 只看写类操作（读/探测过滤掉），用于写序断言。 */
    writes() {
      return ops.filter((o) => ["writeFileSync", "appendFileSync", "renameSync", "mkdirSync"].includes(o.op));
    },
  };
}

/** 造一张小图：1 个用户节点 + 1 个 agent 节点 + 1 条边（不走 keeper，直接建）。 */
function buildGraph(sessionId = "s1") {
  const g = createGraph({ sessionId, cwd: "D:/tmp/proj" });
  addUserNodeId(g, { seq: 1, turn: 1, text: "用户目标：把落盘房间抽出来" });
  return g;
}

function withTmp(fn) {
  const root = tmpRoot();
  try {
    return fn(root);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "常量与路径：LEDGER_BUDGET_FILE / INDEX_APPEND_LIMIT / DELTA_COMPACT_* / safeSessionId / graphRoot / sessionPaths"(t) {
    t.eq(LEDGER_BUDGET_FILE, "ledger-budget.json", "预算文件名");
    t.eq(INDEX_APPEND_LIMIT, 256 * 1024, "index.md 追加上限");
    t.eq(DELTA_COMPACT_MIN, 64 * 1024, "delta 压缩下限");
    t.eq(DELTA_COMPACT_RATIO, 0.2, "delta 压缩比例");
    t.eq(safeSessionId("a/b:c d"), "a_b_c_d", "会话 id 净化");
    t.eq(safeSessionId(undefined), "session", "缺省会话 id");
    t.eq(graphRoot({ graphDir: "D:/g", dshHome: "D:/h" }), "D:/g", "graphDir 非空优先");
    t.eq(graphRoot({ graphDir: "", dshHome: "D:/h" }), nodePath.join("D:/h", "chess-context"), "否则 <dshHome>/chess-context");
    const p = sessionPaths("/root", "sid");
    t.eq(p.dir, nodePath.join("/root", "sessions", "sid"), "dir");
    t.eq(p.graphFile, nodePath.join(p.dir, "graph.json"), "graphFile");
    t.eq(p.deltaFile, `${p.graphFile}.delta.jsonl`, "deltaFile");
    t.eq(p.indexFile, nodePath.join(p.dir, "index.md"), "indexFile");
    t.eq(p.nodesDir, nodePath.join(p.dir, "nodes"), "nodesDir");
    t.eq(p.budgetFile, nodePath.join("/root", "ledger-budget.json"), "budgetFile");
  },

  "写序：首次 flush 的 onStep 序列必须逐项等于 _ORDER"(t) {
    withTmp((root) => {
      const steps = [];
      const { port } = makePort();
      const store = createPersistStore({ port, root, onStep: (s) => steps.push(s) });
      const g = buildGraph();
      const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      t.eq(r.ok, true, "首次 flush 应成功");
      t.eq(steps, _ORDER, "写序必须逐项相同（index→nodes→graphTmp→rename→delta→clearDirty）");
      t.eq(r.wroteBaseline, true, "首次必须写基线");
      t.eq(peekDirty(g).empty, true, "flush 成功后 dirty 必须清空");
    });
  },

  "写序（稳态）：追加帧只走 index→delta→clearDirty，且顺序是 _ORDER 的子序列"(t) {
    withTmp((root) => {
      const steps = [];
      const { port } = makePort();
      const store = createPersistStore({ port, root, onStep: (s) => steps.push(s) });
      const g = buildGraph();
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      steps.length = 0;
      addUserNodeId(g, { seq: 2, turn: 2, text: "第二条" });
      const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      t.eq(r.ok, true, "稳态 flush 应成功");
      t.eq(r.wroteDelta, true, "稳态必须写 delta 帧");
      t.eq(steps, ["index", "delta", "clearDirty"], "稳态写序：追加 index → 追加 delta → 清 dirty");
      // 子序列校验（顺序不许乱）
      let i = 0;
      for (const s of steps) {
        while (i < _ORDER.length && _ORDER[i] !== s) i += 1;
        t.ok(i < _ORDER.length, `步 ${s} 必须是 _ORDER 的子序列（顺序不许乱）`);
        i += 1;
      }
    });
  },

  "失败注入①：rename 之前抛（graph.json.tmp 写失败）⇒ {ok:false} 且 dirty 保留，下次 flush 补齐"(t) {
    withTmp((root) => {
      const { port } = makePort({ failWhen: (op, args) => op === "writeFileSync" && String(args[0]).endsWith(".tmp") });
      const store = createPersistStore({ port, root });
      const g = buildGraph();
      const bad = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      t.eq(bad.ok, false, "注入失败必须返回 ok:false");
      t.eq(bad.dirtyKept, true, "必须声明 dirty 保留");
      t.eq(peekDirty(g).empty, false, "图上的 dirty 必须没被清（宁可重复写，不可丢变更）");
      t.eq(nodeFs.existsSync(sessionPaths(root, "s1").graphFile), false, "基线不该被写出来");

      // 换健康的 port 重试：这一轮的变更必须全部落地
      const healthy = makePort();
      const store2 = createPersistStore({ port: healthy.port, root });
      const ok = store2.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      t.eq(ok.ok, true, "重试必须成功");
      t.eq(peekDirty(g).empty, true, "重试后 dirty 清空");
      const text = nodeFs.readFileSync(sessionPaths(root, "s1").graphFile, "utf8");
      t.includes(text, "s1", "基线内容含会话 id");
    });
  },

  "失败注入②：rename 之后、清 delta 之前抛 ⇒ dirty 保留；旧帧 baseHash 不符被整体忽略"(t) {
    withTmp((root) => {
      // 第一次正常落盘 + 追加一帧
      const { port } = makePort();
      const store = createPersistStore({ port, root });
      const g = buildGraph();
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      addUserNodeId(g, { seq: 2, turn: 2, text: "稳态帧" });
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      const p = sessionPaths(root, "s1");
      const deltaBefore = nodeFs.readFileSync(p.deltaFile, "utf8");
      t.ok(deltaBefore.length > 0, "稳态后 delta 必须非空");

      // 强制全量重写，并让「清 delta」这一步抛
      addUserNodeId(g, { seq: 3, turn: 3, text: "强写帧" });
      const badPort = makePort({ failWhen: (op, args) => op === "writeFileSync" && String(args[0]).endsWith(".delta.jsonl") });
      const store2 = createPersistStore({ port: badPort.port, root });
      const bad = store2.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { full: true });
      t.eq(bad.ok, false, "清 delta 失败必须 ok:false");
      t.eq(peekDirty(g).empty, false, "dirty 必须保留");
      // 基线已被 rename（提交点已过），delta 里是旧帧
      const deltaAfter = nodeFs.readFileSync(p.deltaFile, "utf8");
      t.eq(deltaAfter, deltaBefore, "清 delta 失败 ⇒ 旧帧仍在（这正是崩溃场景）");

      // 加载：旧帧的 baseHash 与新基线不符 ⇒ 整体忽略，图仍正确（含强写帧）
      const store3 = createPersistStore({ port: makePort().port, root });
      const loaded = store3.load({ id: "s1", cwd: "D:/tmp/proj" });
      t.eq(loaded.repaired, false, "基线本身可读，不算 repaired");
      const ids = Object.keys(loaded.graph.nodes);
      t.eq(ids.length, Object.keys(g.nodes).length, "节点数必须与写入的一致（旧帧被忽略）");
      t.eq(peekDirty(loaded.graph).empty, true, "从磁盘读回的图 dirty 应为空");
    });
  },

  "失败注入③：半写帧 ⇒ load 截断到最后一个好帧并报 truncatedFrames"(t) {
    withTmp((root) => {
      const { port } = makePort();
      const store = createPersistStore({ port, root });
      const g = buildGraph();
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      addUserNodeId(g, { seq: 2, turn: 2, text: "好帧" });
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);

      const p = sessionPaths(root, "s1");
      const good = nodeFs.readFileSync(p.deltaFile, "utf8");
      nodeFs.writeFileSync(p.deltaFile, `${good}0123456789abcdef\tdeadbeef\t{"v":1,"ops":[`, "utf8");

      const warns = [];
      const store2 = createPersistStore({ port: makePort().port, root, onWarn: (lvl, line) => warns.push([lvl, line]) });
      const loaded = store2.load({ id: "s1", cwd: "D:/tmp/proj" });
      t.eq(loaded.repaired, false, "半写帧不算 repaired（好帧仍可用）");
      t.eq(loaded.truncatedFrames, 1, "必须报 truncatedFrames=1");
      t.eq(Object.keys(loaded.graph.nodes).length, Object.keys(g.nodes).length, "好帧必须全部应用");
      t.eq(nodeFs.readFileSync(p.deltaFile, "utf8"), good, "delta 文件必须被截回最后一个好帧");
      t.eq(warns.length, 1, "必须 warn 一行");
      t.includes(warns[0][1], "坏帧", "warn 文案要说明坏帧");
    });
  },

  "字节等价：store.flush 的产物与 R00 纯函数逐字节相同（index / nodes / graph.json / delta）"(t) {
    withTmp((root) => {
      // 两张图必须逐字节同源：把 Date.now 钉死，否则 createdAt/ts 差 1ms 就永远不可能等价。
      const realNow = Date.now;
      Date.now = () => 1700000000000;
      try {
      const p = sessionPaths(root, "s1");
      // A 路：store
      const store = createPersistStore({ port: makePort().port, root });
      const gA = buildGraph();
      t.eq(store.flush({ id: "s1", cwd: "D:/tmp/proj" }, gA).ok, true, "store flush");

      // B 路：直接调 R00 的纯函数（同样的图，另一份副本）
      const gB = buildGraph();
      nodeFs.mkdirSync(p.nodesDir, { recursive: true });
      nodeFs.writeFileSync(p.indexFile.replace("index.md", "index.direct.md"), renderIndexMd(gB), "utf8");
      for (const id of Object.keys(gB.nodes)) nodeFs.writeFileSync(nodePath.join(p.nodesDir, `${id}.direct.md`), renderNodeMd(gB, id), "utf8");
      const directGraph = toJSON(gB);
      nodeFs.writeFileSync(`${p.graphFile}.direct`, directGraph, "utf8");

      // index.md
      t.eq(nodeFs.readFileSync(p.indexFile, "utf8"), nodeFs.readFileSync(p.indexFile.replace("index.md", "index.direct.md"), "utf8"), "index.md 逐字节相同");
      // nodes/*.md
      for (const id of Object.keys(gA.nodes)) {
        const a = nodeFs.readFileSync(nodePath.join(p.nodesDir, `${id}.md`), "utf8");
        const b = nodeFs.readFileSync(nodePath.join(p.nodesDir, `${id}.direct.md`), "utf8");
        t.eq(a, b, `nodes/${id}.md 逐字节相同`);
      }
      // graph.json
      const storeGraph = nodeFs.readFileSync(p.graphFile, "utf8");
      t.eq(storeGraph, directGraph, "graph.json 逐字节相同（toJSON）");
      t.eq(storeGraph, toJSON(gA), "store 落盘的就是 toJSON(g)");

      // delta：稳态追加一帧，与 encodeDeltaFrame(base, deltaFromDirty(...)) 逐字节比较
      clearDirty(gB); // store.flush 已经把 gA 的初始 dirty 清掉，B 路要同步到「稳态起点」
      addUserNodeId(gA, { seq: 2, turn: 2, text: "稳态帧" });
      addUserNodeId(gB, { seq: 2, turn: 2, text: "稳态帧" });
      const dirtyB = peekDirty(gB);
      const base = sha(directGraph).slice(0, 16);
      const frameB = encodeDeltaFrame(base, deltaFromDirty(gB, dirtyB));
      t.eq(store.flush({ id: "s1", cwd: "D:/tmp/proj" }, gA).ok, true, "store 稳态 flush");
      const deltaA = nodeFs.readFileSync(p.deltaFile, "utf8");
      t.eq(deltaA, frameB, "delta 帧逐字节相同（编码器是 R00 的）");
      } finally {
        Date.now = realNow;
      }
    });
  },

  "load：坏 JSON ⇒ {repaired:true, repairedReason} 且得到空图（不得静默）"(t) {
    withTmp((root) => {
      const p = sessionPaths(root, "s1");
      nodeFs.mkdirSync(p.dir, { recursive: true });
      nodeFs.writeFileSync(p.graphFile, "{ 这不是 JSON", "utf8");
      const store = createPersistStore({ port: makePort().port, root });
      const r = store.load({ id: "s1", cwd: "D:/tmp/proj" });
      t.eq(r.repaired, true, "必须报 repaired");
      t.ok(typeof r.repairedReason === "string" && r.repairedReason.length > 0, "必须给原因");
      t.eq(Object.keys(r.graph.nodes).length, 0, "必须得到空图");
      t.eq(r.graph.sessionId, "s1", "空图仍带会话 id");
    });
  },

  "load：版本不符 ⇒ repaired 且原因点名版本（不得静默降级）"(t) {
    withTmp((root) => {
      const p = sessionPaths(root, "s1");
      nodeFs.mkdirSync(p.dir, { recursive: true });
      nodeFs.writeFileSync(p.graphFile, JSON.stringify({ version: 99, nodes: {}, edges: {}, order: [] }), "utf8");
      const store = createPersistStore({ port: makePort().port, root });
      const r = store.load({ id: "s1", cwd: "D:/tmp/proj" });
      t.eq(r.repaired, true, "版本不符必须 repaired");
      t.includes(String(r.repairedReason).toLowerCase(), "version", "原因必须点名版本");
    });
  },

  "persistBudget：原子写并回 {ok:true}；失败回 {ok:false,error} 不抛"(t) {
    withTmp((root) => {
      const store = createPersistStore({ port: makePort().port, root });
      const ok = store.persistBudget({ none: 3, samples: 3 });
      t.eq(ok.ok, true, "正常应 ok");
      const text = nodeFs.readFileSync(nodePath.join(root, LEDGER_BUDGET_FILE), "utf8");
      t.includes(text, "\"samples\": 3", "落盘内容");
      const badPort = makePort({ failWhen: (op) => op === "renameSync" });
      const bad = createPersistStore({ port: badPort.port, root }).persistBudget({ samples: 1 });
      t.eq(bad.ok, false, "失败应回 ok:false");
      t.ok(typeof bad.error === "string" && bad.error.length > 0, "必须带 error");
    });
  },

  "forget：清掉三张表后，同一会话重新从磁盘加载（不残留内存态）"(t) {
    withTmp((root) => {
      const store = createPersistStore({ port: makePort().port, root });
      const g = buildGraph();
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      addUserNodeId(g, { seq: 2, turn: 2, text: "第二" });
      store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
      store.forget("s1");
      const again = store.load({ id: "s1", cwd: "D:/tmp/proj" });
      t.eq(Object.keys(again.graph.nodes).length, Object.keys(g.nodes).length, "重载后节点数一致");
      t.eq(again.truncatedFrames, 0, "不该有坏帧");
    });
  },
};