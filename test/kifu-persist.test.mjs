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
  addAgentNode,
  addEdge,
  addUserNodeId,
  clearDirty,
  createGraph,
  deltaFromDirty,
  encodeDeltaFrame,
  peekDirty,
  renderIndexMd,
  renderNodeMd,
  settleEdge,
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
      readdirSync: wrap("readdirSync"),
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

tests["C111 tree 落盘自愈陈旧节点文档（回滚/合并留下的 md 必须清掉）"] = (t) => {
  withTmp((root) => {
    const { port } = makePort();
    const store = createPersistStore({ port, root });
    // 自建最小图（不借 buildGraph：那条夹具的节点集合不适合断言「删一个留一个」）
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
    const eid = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
    const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: eid }).id;
    settleEdge(g, eid, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g);
    const paths = sessionPaths(root, "s1");
    const md = (id) => nodePath.join(paths.nodesDir, id + ".md");
    t.eq(nodeFs.existsSync(md(u)), true, "首次 flush 必须写出用户节点 md");
    t.eq(nodeFs.existsSync(md(n)), true, "首次 flush 必须写出 agent 节点 md");

    // 模拟「写了又回滚」：agent 节点从图里消失，再走一次 tree 落盘
    delete g.nodes[n];
    g.order = g.order.filter((id) => id !== n);
    nodeFs.writeFileSync(nodePath.join(paths.nodesDir, "keep-me.txt"), "x", "utf8");
    const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    t.eq(r.ok, true, "tree 落盘应成功");
    t.eq(nodeFs.existsSync(md(n)), false, `已不在图里的 ${n}.md 必须被清掉`);
    t.eq(nodeFs.existsSync(md(u)), true, "仍在图里的节点文档不许删");
    t.eq(nodeFs.existsSync(nodePath.join(paths.nodesDir, "keep-me.txt")), true, "非节点文件一律不碰");
  });
};

tests["C111-2 假 port 必须与 createFsPort 的接口一致（缺方法会被 try/catch 静默吞掉）"] = (t) => {
  // 真实教训：C111 的清理逻辑用 `port.readdirSync`，而假 port 没有该方法
  // ⇒ 清理抛错、被 catch 吞掉、测试看到「没清理」却以为是实现问题。
  const real = createFsPort();
  const fake = makePort().port;
  for (const key of Object.keys(real)) {
    t.eq(typeof fake[key], "function", `假 port 缺少 createFsPort 的方法 "${key}" —— 注入方与真实实现接口必须一致`);
  }
};

tests["C112 回滚后 index.md 必须跟着图重渲染（不许残留已删节点）"] = (t) => {
  withTmp((root) => {
    const { port } = makePort();
    const store = createPersistStore({ port, root });
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
    const eid = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
    const n = addAgentNode(g, { seq: 4, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: eid }).id;
    settleEdge(g, eid, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    const paths = sessionPaths(root, "s1");
    t.eq(nodeFs.readFileSync(paths.indexFile, "utf8").includes(n), true, "首次渲染必须包含 agent 节点");

    // 模拟回滚：agent 节点从图里消失
    delete g.nodes[n];
    g.order = g.order.filter((x) => x !== n);
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    const index = nodeFs.readFileSync(paths.indexFile, "utf8");
    t.eq(index.includes(n), false, `回滚后 index.md 不许还写着 ${n}（否则人看索引 = 看旧状态）`);
    t.eq(index.includes(u), true, "仍存在的节点必须还在索引里");
  });
};

tests["C133 任意写序点失败：磁盘上的图必须仍可解析，且节点集只会是「旧」或「新」"] = (t) => {
  // 泛化 C111 那三个手挑注入点：把失败打到稳态落盘的**每一个** fs 操作上，
  // 不允许出现「既不是旧图也不是新图」的第三种状态（那意味着半写/丢数据）。
  let checked = 0;
  for (let failIndex = 1; failIndex <= 8; failIndex += 1) {
    withTmp((root) => {
      // 先正常落一版基线
      const okStore = createPersistStore({ port: makePort().port, root });
      const base = buildGraph();
      okStore.flush({ id: "s1", cwd: "D:/tmp/proj" }, base);
      const beforeIds = Object.keys(base.nodes).sort();

      // 再加一个节点，然后在第 failIndex 次 fs 操作上失败
      let ops = 0;
      const badPort = makePort({
        failWhen: () => {
          ops += 1;
          return ops === failIndex;
        },
      });
      const badStore = createPersistStore({ port: badPort.port, root });
      addUserNodeId(base, { seq: 777, turn: 77, text: `第 ${failIndex} 次注入` });
      const afterIds = Object.keys(base.nodes).sort();
      const bad = badStore.flush({ id: "s1", cwd: "D:/tmp/proj" }, base);

      // 失败之后必须能用新 store 读回来，且节点集是两者之一
      const reload = createPersistStore({ port: makePort().port, root }).load({ id: "s1", cwd: "D:/tmp/proj" });
      const loadedIds = Object.keys(reload.graph.nodes).sort();
      const asBefore = JSON.stringify(loadedIds) === JSON.stringify(beforeIds);
      const asAfter = JSON.stringify(loadedIds) === JSON.stringify(afterIds);
      t.eq(asBefore || asAfter, true, `failIndex=${failIndex}（ok=${bad.ok}）读回的节点集既不是旧图也不是新图：${loadedIds.join(",")}`);
      if (!bad.ok) {
        t.eq(peekDirty(base).empty, false, `failIndex=${failIndex} 失败后 dirty 必须保留（下次重试还要写）`);
        checked += 1;
      }
    });
  }
  t.eq(checked >= 4, true, `至少要有 4 个注入点真的失败（否则判据空转），实际 ${checked}`);
};

tests["C142-3 内存图为空（graph.json 读不出时的兜底）绝不许清 nodes/"] = (t) => {
  withTmp((root) => {
    const { port } = makePort();
    const store = createPersistStore({ port, root });
    // 先正常写出一版（3 个文档）：
    const g = createGraph({ sessionId: "s1" });
    const u = addUserNodeId(g, { seq: 1, text: "a" });
    const e1 = addEdge(g, { from: u, intent: "i", action: "bash(x)", evidence: { start: 2, end: 3 } });
    const n1 = addAgentNode(g, { seq: 4, goal: "g1", worldHash: "W1", constraintHash: "C", via: e1 }).id;
    settleEdge(g, e1, { to: n1, result: "success", verify: { kind: "exit", summary: "exit 0" } });
    store.flush({ id: "s1", cwd: "D:/tmp/proj" }, g, { tree: true });
    const paths = sessionPaths(root, "s1");
    const before = nodeFs.readdirSync(paths.nodesDir).filter((f) => f.endsWith(".md")).sort();
    t.eq(before.length, 2, `基线应写出 2 个节点文档，实际 ${before.join(",")}`);

    // 模拟「graph.json 读不出 ⇒ engine 建空图」：用空图做 tree 落盘
    const empty = createGraph({ sessionId: "s1" });
    const r = store.flush({ id: "s1", cwd: "D:/tmp/proj" }, empty, { tree: true });
    t.eq(r.ok, true, "空图落盘本身不应失败");
    const after = nodeFs.readdirSync(paths.nodesDir).filter((f) => f.endsWith(".md")).sort();
    t.eq(after.join(","), before.join(","), `空图不许清 nodes/（C142 审查 P1-1）：${before.join(",")} → ${after.join(",")}`);
  });
};
