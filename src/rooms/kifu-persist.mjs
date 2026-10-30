/**
 * kifu-persist —— 落盘与增量协议（R01，A2-2，2026-10-30）
 *
 * 职责：把图写成三层树（`index.md` + `nodes/<id>.md` + `graph.json`）与增量帧
 * （`graph.json.delta.jsonl`）；读回时重放 delta、截断坏尾、**报**修复原因。
 * 本房间是**唯一**允许碰 `graph.json` 字节的地方。
 *
 * 从 `src/engine.mjs` 搬出（常量 / 路径推导 / #graph / #flush / #scheduleFlush / 预算落盘）。
 * 引擎侧只剩 delegate —— 它再也不能「顺手」改落盘语义。
 *
 * ★ 两处**唯一的行为变更**（迁移计划 §3.2，必须单列）：
 *   ① `load` 读不出 / 版本不符：返回 `{repaired:true, repairedReason}`（旧版静默建空图，无日志）；
 *   ② `flush` 失败：返回 `{ok:false, error, dirtyKept:true}`，**dirty 照旧不清**（旧版自己 warn）。
 *      日志级别由 R09 决定 —— 房间不 import 任何 logger。
 *
 * 写序是**崩溃安全契约**（`_ORDER`）：
 *   index.md（全量或追加）→ nodes/*.md → graph.json.tmp → rename → delta 清空/追加 → clearDirty
 * 任何并行/乱序实现都违约。
 *
 * 依赖：R00（`graph.mjs` 的纯函数，含 delta 帧编解码）、`node:fs`、`node:path`。
 * 禁止：`@deepseek-ai/*`、session 对象（只吃 `{id,cwd}`）、R09、R11。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import {
  createGraph,
  fromJSON,
  toJSON,
  renderIndexMd,
  renderIndexAppend,
  renderNodeMd,
  sha,
  validate,
  peekDirty,
  clearDirty,
  deltaFromDirty,
  encodeDeltaFrame,
  decodeDeltaFrames,
  applyDelta,
} from "./kifu-model.mjs";

/** 预算指标文件名（键集合冻结，见契约 §2.9）。 */
export const LEDGER_BUDGET_FILE = "ledger-budget.json";

/** `index.md` 超过这个大小就全量重建（否则只追加增量段）。92KB 的大图允许涨到 ~2.8×。 */
export const INDEX_APPEND_LIMIT = 256 * 1024;

/** delta 压缩阈值：至少这么大，或超过基线的 20%（`max(DELTA_COMPACT_MIN, 基线×RATIO)`）。 */
export const DELTA_COMPACT_MIN = 64 * 1024;
export const DELTA_COMPACT_RATIO = 0.2;

/** 写序常量（测试断言用）。 */
export const _ORDER = ["index", "nodes", "graphTmp", "rename", "delta", "clearDirty"];

/** 会话 id → 安全目录名（与 engine 旧 `safeId` 逐字相同）。 */
export function safeSessionId(id) {
  return String(id ?? "session").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/** 棋谱根目录：`graphDir` 非空用它，否则 `<dshHome>/chess-context`。 */
export function graphRoot({ graphDir = "", dshHome = "" } = {}) {
  if (graphDir && graphDir.length > 0) return graphDir;
  return nodePath.join(dshHome, "chess-context");
}

/** 一个会话的六个落点（三层树 + delta + 预算文件）。 */
export function sessionPaths(root, sessionId) {
  const dir = nodePath.join(root, "sessions", safeSessionId(sessionId));
  const graphFile = nodePath.join(dir, "graph.json");
  return {
    dir,
    graphFile,
    deltaFile: `${graphFile}.delta.jsonl`,
    indexFile: nodePath.join(dir, "index.md"),
    nodesDir: nodePath.join(dir, "nodes"),
    budgetFile: nodePath.join(root, LEDGER_BUDGET_FILE),
  };
}

/** 默认 fs port（可注入 —— 测试用假 port 断言写序，不碰真实磁盘）。 */
export function createFsPort(fs = nodeFs) {
  return {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, text, enc) => fs.writeFileSync(p, text, enc),
    appendFileSync: (p, text, enc) => fs.appendFileSync(p, text, enc),
    renameSync: (a, b) => fs.renameSync(a, b),
    statSync: (p) => fs.statSync(p),
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    rmSync: (p, opts) => fs.rmSync(p, opts),
  };
}

/**
 * 创建落盘 store。
 *
 * @param {object} options
 * @param {ReturnType<typeof createFsPort>} options.port   fs port（可假）
 * @param {string} options.root                            棋谱根目录
 * @param {(level: "warn"|"error"|"info", line: string) => void} [options.onWarn]  日志出口（房间自己不打日志）
 * @param {(step: string) => void} [options.onStep]       测试缝：每个写序阶段回调一次（生产不传）
 */
export function createPersistStore({ port = createFsPort(), root = "", onWarn = () => {}, onStep = null } = {}) {
  /** 每会话的基线哈希（16 位）—— delta 帧都带它；基线重写后旧帧自然失效。 */
  const baseHash = new Map();
  /** 已写过三层树的会话（2000 边时 4000 文件会卡事件循环，只首次与 fold 后写）。 */
  const treeWritten = new Set();
  /** 已进入 graph.json/delta 但还没写过 nodes/<id>.md 的节点（fold 时补写）。 */
  const nodesPendingMd = new Map();

  const warn = (line) => {
    try {
      onWarn("warn", line);
    } catch {
      /* 日志实现坏掉不许影响落盘 */
    }
  };
  const step = (name) => {
    if (!onStep) return;
    try {
      onStep(name);
    } catch {
      /* 测试缝异常不许影响落盘 */
    }
  };
  const base16 = (text) => sha(text).slice(0, 16);

  /**
   * 读回一个会话的图（基线 + delta 重放 + 坏尾截断）。
   * @returns {{graph: object, baseHash: string|undefined, repaired: boolean, repairedReason: string|null, truncatedFrames: number}}
   */
  function load({ id, cwd } = {}) {
    const key = String(id ?? "session");
    const p = sessionPaths(root, key);
    let truncatedFrames = 0;
    try {
      const text = port.readFileSync(p.graphFile, "utf8");
      const graph = fromJSON(text);
      const base = base16(text);
      baseHash.set(key, base);
      if (port.existsSync(p.deltaFile)) {
        const dtext = port.readFileSync(p.deltaFile, "utf8");
        const { frames, badTail } = decodeDeltaFrames(dtext, base);
        for (const f of frames) applyDelta(graph, f);
        if (badTail) {
          truncatedFrames = 1;
          // 截到最后一个好帧（防止后续追加接在半帧后面）
          const good = frames.map((f) => encodeDeltaFrame(base, f)).join("");
          port.writeFileSync(p.deltaFile, good, "utf8");
          warn(`chess-context: delta 尾部有坏帧，已截断到第 ${frames.length} 帧（半写不污染图）`);
        }
      }
      return { graph, baseHash: base, repaired: false, repairedReason: null, truncatedFrames };
    } catch (error) {
      // ★ A2-2 行为变更①：不再静默建空图 —— 返回 repaired + 原因，由 R09 打日志。
      const graph = createGraph({ sessionId: key, cwd: cwd ?? process.cwd() });
      return { graph, baseHash: undefined, repaired: true, repairedReason: String(error?.message ?? error), truncatedFrames };
    }
  }

  /**
   * 落盘（三层树 + 增量帧）。写序见 `_ORDER`。
   * @returns {{ok:true, baseHash, wroteBaseline:boolean, wroteDelta:boolean} | {ok:false, error:string, dirtyKept:true}}
   */
  function flush({ id, cwd } = {}, graph, { tree = false, full = false } = {}) {
    const key = String(id ?? "session");
    const p = sessionPaths(root, key);
    let wroteBaseline = false;
    let wroteDelta = false;
    try {
      port.mkdirSync(p.dir, { recursive: true });
      // P1-11：落盘前校验图不变量（悬空边 / 失败边没原因 / agent 缺哈希）。
      const problems = validate(graph);
      if (problems.length > 0) {
        warn(`chess-context: 棋谱不变量告警 ${problems.length} 条：${problems.slice(0, 3).join("; ")}`);
      }

      const dirty = peekDirty(graph);
      const firstWrite = !treeWritten.has(key);

      // ── index.md ──────────────────────────────────────────────
      const needFullIndex = tree || firstWrite || !port.existsSync(p.indexFile) || port.statSync(p.indexFile).size > INDEX_APPEND_LIMIT;
      if (needFullIndex) {
        port.writeFileSync(p.indexFile, renderIndexMd(graph), "utf8");
        treeWritten.add(key);
        step("index");
      } else if (!dirty.empty) {
        const append = renderIndexAppend(graph, dirty);
        if (append) port.appendFileSync(p.indexFile, `${append}\n`, "utf8");
        step("index");
      }

      // ── nodes/<id>.md ─────────────────────────────────────────
      let pending = nodesPendingMd.get(key);
      if (pending === undefined) {
        pending = new Set();
        nodesPendingMd.set(key, pending);
      }
      if (firstWrite) {
        port.mkdirSync(p.nodesDir, { recursive: true });
        for (const nodeId of Object.keys(graph.nodes)) {
          if (graph.nodes[nodeId]) port.writeFileSync(nodePath.join(p.nodesDir, `${nodeId}.md`), renderNodeMd(graph, nodeId), "utf8");
        }
        pending.clear();
        step("nodes");
      } else if (tree || pending.size > 0) {
        port.mkdirSync(p.nodesDir, { recursive: true });
        const writeSet = new Set([...pending, ...dirty.nodes]);
        for (const nodeId of writeSet) {
          if (!graph.nodes[nodeId]) continue;
          port.writeFileSync(nodePath.join(p.nodesDir, `${nodeId}.md`), renderNodeMd(graph, nodeId), "utf8");
        }
        pending.clear();
        step("nodes");
      } else {
        for (const nodeId of dirty.nodes) pending.add(nodeId);
      }

      // ── graph.json + delta（提交点 = rename）──────────────────
      const baseExists = port.existsSync(p.graphFile);
      if (!baseExists) {
        const text = toJSON(graph);
        const tmp = `${p.graphFile}.tmp`;
        port.writeFileSync(tmp, text, "utf8");
        step("graphTmp");
        port.renameSync(tmp, p.graphFile);
        step("rename");
        port.writeFileSync(p.deltaFile, "", "utf8");
        step("delta");
        baseHash.set(key, base16(text));
        wroteBaseline = true;
      } else {
        let base = baseHash.get(key);
        if (base === undefined) {
          base = base16(port.readFileSync(p.graphFile, "utf8"));
          baseHash.set(key, base);
        }
        const baseBytes = port.statSync(p.graphFile).size;
        const deltaBytes = port.existsSync(p.deltaFile) ? port.statSync(p.deltaFile).size : 0;
        const compactLimit = Math.max(DELTA_COMPACT_MIN, Math.floor(baseBytes * DELTA_COMPACT_RATIO));
        if (full || deltaBytes > compactLimit) {
          const text = toJSON(graph);
          const tmp = `${p.graphFile}.tmp`;
          port.writeFileSync(tmp, text, "utf8");
          step("graphTmp");
          port.renameSync(tmp, p.graphFile); // 提交点
          step("rename");
          port.writeFileSync(p.deltaFile, "", "utf8");
          step("delta");
          baseHash.set(key, base16(text));
          wroteBaseline = true;
        } else if (!dirty.empty) {
          port.appendFileSync(p.deltaFile, encodeDeltaFrame(base, deltaFromDirty(graph, dirty)), "utf8");
          step("delta");
          wroteDelta = true;
        }
      }
      clearDirty(graph);
      step("clearDirty");
      return { ok: true, baseHash: baseHash.get(key), wroteBaseline, wroteDelta };
    } catch (error) {
      // ★ A2-2 行为变更②：不吞错、也**不清 dirty** —— 下次 flush 会把这一轮变更一起写下去。
      return { ok: false, error: String(error?.message ?? error), dirtyKept: true };
    }
  }

  /** 落 `ledger-budget.json`（原子写）。失败返回 `{ok:false,error}`，不抛。 */
  function persistBudget(stats) {
    try {
      const p = sessionPaths(root, "_budget");
      port.mkdirSync(nodePath.dirname(p.budgetFile), { recursive: true });
      const tmp = `${p.budgetFile}.tmp-${process.pid}`;
      port.writeFileSync(tmp, JSON.stringify(stats, null, 1), "utf8");
      port.renameSync(tmp, p.budgetFile);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 忘掉一个会话的三张表（将来 `session/disposed` 的唯一清理点；本次不接）。 */
  function forget(id) {
    const key = String(id ?? "session");
    baseHash.delete(key);
    treeWritten.delete(key);
    nodesPendingMd.delete(key);
  }

  return { root, load, flush, persistBudget, forget };
}