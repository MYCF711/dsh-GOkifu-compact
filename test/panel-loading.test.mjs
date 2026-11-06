/**
 * panel-loading.test.mjs —— 面板打开时的全局折痕查询预算。
 *
 * 真机工作集已经超过旧的 256 条摘要 LRU：顺序扫描会循环淘汰，导致冷/热打开都全量重读。
 * 这里用 300 个离线会话钉住：首次每图只读一次、再次打开零读、变更只重读变更图；
 * 全局最近 20 条必须仍然跨会话取数，不能为了快退回当前会话。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SESSION_COUNT = 300;
const BASE = Date.UTC(2026, 10, 1);

function makeHome() {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-panel-loading-"));
  const sessions = nodePath.join(home, "chess-context", "sessions");
  nodeFs.mkdirSync(sessions, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(home, "profiles", "desktop"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(home, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  for (let index = 0; index < SESSION_COUNT; index += 1) writeGraph(home, index, graphFor(index));
  return home;
}

function sessionName(index) {
  return `session-${String(index).padStart(3, "0")}`;
}

function graphFor(index) {
  return {
    version: 1,
    sessionId: sessionName(index),
    nodes: {},
    edges: {},
    foldCount: 1,
    lastFoldTotalTokens: 1000 + index,
    checkpointSeq: null,
    lastFoldUsage: null,
    foldMarks: [{
      at: BASE + index,
      seqStart: index * 100 + 1,
      seqEnd: index * 100 + 80,
      trigger: "pressure",
      summaryChars: 200 + index,
      usage: null,
      truncated: false,
      finishReason: "stop",
    }],
  };
}

function writeGraph(home, index, graph) {
  const dir = nodePath.join(home, "chess-context", "sessions", sessionName(index));
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph), "utf8");
}

async function mount() {
  const ui = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
  const routes = [];
  ui.apply({ webServer: { register: (route) => (routes.push(route), () => {}), host: "127.0.0.1" }, effect: (fn) => fn() });
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，实际 ${routes.length}`);
  return routes[0].handler;
}

function callState(handler) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: "state" });
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
      on(event, callback) {
        if (event === "data") callback(Buffer.from(body, "utf8"));
        if (event === "end") callback();
        return req;
      },
    };
    const res = {
      status: 0,
      raw: "",
      writeHead(status) { this.status = status; },
      end(text) {
        this.raw = text ?? "";
        try {
          resolve({ status: this.status, raw: this.raw, json: JSON.parse(this.raw) });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function countGraphReads() {
  const real = nodeFs.readFileSync;
  const counter = { n: 0 };
  nodeFs.readFileSync = function patched(file, ...args) {
    if (typeof file === "string" && file.endsWith("graph.json")) counter.n += 1;
    return real.call(nodeFs, file, ...args);
  };
  return { counter, restore: () => { nodeFs.readFileSync = real; } };
}

function assertReadBudget(actual, expected = { cold: SESSION_COUNT, warm: 0, changed: 1 }) {
  for (const key of ["cold", "warm", "changed"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${key} 读盘预算不符：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
    }
  }
}

export const tests = {
  "300 会话：首次完整加载每图一次、再次打开零读、变更只读一图且全局排序不变": async (t) => {
    const home = makeHome();
    const previousHome = process.env.DSH_HOME;
    const spy = countGraphReads();
    process.env.DSH_HOME = home;
    try {
      const handler = await mount();
      const reads = { cold: 0, warm: 0, changed: 0 };

      spy.counter.n = 0;
      const cold = await callState(handler);
      reads.cold = spy.counter.n;
      t.eq(cold.status, 200, "首次 state 必须成功");
      t.eq(cold.json.today.totalSessions, SESSION_COUNT, "首次就返回全部会话计数");
      t.eq(cold.json.foldMarks.length, 20, "一次响应就带完整全局最近 20 条");
      t.eq(cold.json.foldMarks[0].seqEnd, 29980, "最新一条来自最后一个会话");
      t.eq(cold.json.foldMarks[19].seqEnd, 28080, "第 20 条仍按全局时刻截取");
      t.eq(new Set(cold.json.foldMarks.map((mark) => mark.seqStart)).size, 20, "不是同一会话的局部列表");

      spy.counter.n = 0;
      const warm = await callState(handler);
      reads.warm = spy.counter.n;
      t.eq(warm.status, 200, "第二次 state 必须成功");
      t.eq(warm.raw, cold.raw, "热缓存不得改变任何面板数据");

      const changed = graphFor(0);
      changed.foldCount = 2;
      changed.foldMarks = [{ ...changed.foldMarks[0], at: BASE + 10_000, seqEnd: 99_999 }, ...changed.foldMarks];
      writeGraph(home, 0, changed);
      const changedFile = nodePath.join(home, "chess-context", "sessions", sessionName(0), "graph.json");
      const later = new Date(Date.now() + 3000);
      nodeFs.utimesSync(changedFile, later, later);

      spy.counter.n = 0;
      const afterChange = await callState(handler);
      reads.changed = spy.counter.n;
      t.eq(afterChange.status, 200, "变更后的 state 必须成功");
      t.eq(afterChange.json.foldMarks[0].seqEnd, 99_999, "变化图必须失效并进入全局第一");
      t.eq(afterChange.json.foldMarks.length, 20, "变更后仍返回完整列表");
      t.eq(afterChange.json.today.totalSessions, SESSION_COUNT, "优化不得减少扫描会话数");

      assertReadBudget(reads);
    } finally {
      spy.restore();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  },

  "失败分支真红：旧 256 条 LRU 的循环淘汰读盘形态必须被同一预算拒绝": (t) => {
    const oldThrashingReads = { cold: SESSION_COUNT * 2 + 1, warm: SESSION_COUNT * 2, changed: SESSION_COUNT };
    t.throws(() => assertReadBudget(oldThrashingReads), "旧实现冷 601 / 热 600 / 变更 300 次读盘必须失败");
    t.throws(() => assertReadBudget({ cold: SESSION_COUNT, warm: 0, changed: 0 }), "变化图零读盘意味着陈旧缓存，也必须失败");
  },
};
