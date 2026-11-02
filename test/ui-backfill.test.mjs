/**
 * ui-backfill.test.mjs —— 面板「补做收尾」（`POST /gokifu/api {"action":"backfill"}`，C216）
 *
 * 为什么要有这个文件：这条路是**唯一**能给「归档时没压完」的老会话补账的入口
 * （宿主的压缩只对 idle agent 有效，归档会话没有 agent）。它一旦静默失效，
 * 面板只会显示「0 条欠账」——比报错更糟，因为没人会去查。
 *
 * 覆盖：
 *   ① 引擎没在这个进程里 ⇒ 503 + `engine-missing`（不许假装补了）
 *   ② dryRun ⇒ 只报清单：不 resume、不调 closeout、不动归档状态
 *   ③ 真补 ⇒ 取消归档 → resume → closeout → **原样归档回去**
 *   ④ 宿主没有 sessionController ⇒ 503 + `no-session-controller`（别让页面以为补成功了）
 *
 * 夹具全部建在仓库 `tmp/` 下（已 gitignore），每条用例 finally 清理；不启动 DSH、不碰真实 home。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGraph, addAgentNode, addUserNode, toJSON } from "../src/rooms/kifu-model.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(ROOT, "tmp");
const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };
const ENGINE_KEY = Symbol.for("dsh-gokifu.engine");

/* ───────────────────────── 夹具 ───────────────────────── */

function mkHome(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-ui-backfill-${label}-`));
}

/** 写一张有「未压缩尾巴」的棋谱：若干节点、没有 foldMark、没有 closeout。 */
function writeGraph(home, sessionId, { maxSeq = 500 } = {}) {
  const dir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = createGraph({ sessionId, cwd: home });
  addUserNode(g, { seq: 1, text: "起点" });
  for (let seq = 5; seq <= maxSeq; seq += 5) {
    // worldHash 必须逐条不同：同 (worldHash, constraintHash) 是「同一局面」，会被转置去重（这是棋谱的本意）
    addAgentNode(g, { seq, turn: Math.ceil(seq / 5), goal: `步 ${seq}`, worldHash: `W${seq}`, constraintHash: "C" });
  }
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
}

/** 挂一次真实的 host 路由（与 ui-health.test.mjs 同法：不启动 DSH）。 */
async function mount(services = {}) {
  const uiMod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-backfill=${Math.random()}`);
  const routes = [];
  uiMod.apply({
    webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" },
    effect: (fn) => fn(),
    get: (name) => services[name],
  });
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  return routes[0].handler;
}

function call(handler, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = {
      method: "POST",
      headers: LOCAL_HEADERS,
      on(event, cb) {
        if (event === "data") cb(Buffer.from(text, "utf8"));
        if (event === "end") cb();
        return req;
      },
    };
    const res = {
      status: 0,
      raw: "",
      writeHead(status) {
        this.status = status;
      },
      end(chunk) {
        this.raw = chunk ?? "";
        try {
          resolve({ status: this.status, json: JSON.parse(this.raw) });
        } catch {
          resolve({ status: this.status, json: null });
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** 把 DSH_HOME 指向夹具跑一段逻辑，结束后逐字还原（不污染别的用例）。 */
async function withHome(home, fn) {
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before;
  }
}

/** 装一个假引擎桥（面板只认 `Symbol.for("dsh-gokifu.engine").closeoutNow`）。 */
function installBridge(impl) {
  const before = globalThis[ENGINE_KEY];
  globalThis[ENGINE_KEY] = impl;
  return () => {
    if (before === undefined) delete globalThis[ENGINE_KEY];
    else globalThis[ENGINE_KEY] = before;
  };
}

export const tests = {};

tests["C216 面板补账：引擎不在进程里 ⇒ 503 engine-missing（不许假装补了）"] = async (t) => {
  const home = mkHome("noengine");
  const uninstall = installBridge(undefined);
  try {
    const handler = await mount();
    const { status, json } = await withHome(home, () => call(handler, { action: "backfill" }));
    t.eq(status, 503, "没有引擎桥必须 503，而不是 200 + 空清单");
    t.eq(json?.ok, false, "ok 必须是 false");
    t.eq(json?.code, "engine-missing", "带可判定的 code（页面据此显示「需要重载宿主」）");
  } finally {
    uninstall();
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C216 面板补账：dryRun 只报清单 —— 不 resume、不调 closeout、不动归档状态"] = async (t) => {
  const home = mkHome("dry");
  let resumed = 0;
  let closed = 0;
  const calls = [];
  const uninstall = installBridge({
    closeoutNow: async () => {
      closed += 1;
      return { folded: true };
    },
  });
  try {
    writeGraph(home, "session-due", { maxSeq: 500 });
    writeGraph(home, "session-small", { maxSeq: 5 });
    writeGraph(home, "session-done", { maxSeq: 500 });
    // 第三条已经收过尾：不许再进清单
    const doneFile = nodePath.join(home, "chess-context", "sessions", "session-done", "graph.json");
    const done = JSON.parse(nodeFs.readFileSync(doneFile, "utf8"));
    done.closeout = { at: 1, eventsSinceLastFold: 500, source: "backfill" };
    nodeFs.writeFileSync(doneFile, JSON.stringify(done, null, 1), "utf8");

    const handler = await mount({
      sessionController: {
        agents: {
          resolveAgent: async (id) => {
            resumed += 1;
            calls.push(`resume:${id}`);
            return { agent: { session: { id } } };
          },
        },
      },
      workspaceRegistry: {
        archivedSessionIds: ["session-due"],
        unarchiveSession: async (id) => calls.push(`unarchive:${id}`),
        archiveSession: async (id) => calls.push(`archive:${id}`),
      },
    });
    const { status, json } = await withHome(home, () => call(handler, { action: "backfill", dryRun: true }));
    t.eq(status, 200, "演练必须成功返回");
    t.eq(json?.dryRun, true, "返回体标明是演练");
    t.eq(json?.due, 1, "只有 session-due 欠账（session-small 尾巴太小、session-done 已收尾）");
    t.eq(json?.items?.[0]?.sessionId, "session-due", "清单点名到会话");
    t.eq(resumed, 0, "演练不许 resume（那是真加载一整份 durable history）");
    t.eq(closed, 0, "演练不许调用模型");
    t.eq(calls.length, 0, "演练不许动归档状态");
  } finally {
    uninstall();
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C216 面板补账：真补走完一圈（取消归档 → resume → closeout → 归档回去）"] = async (t) => {
  const home = mkHome("run");
  const calls = [];
  const archived = ["session-due"];
  const uninstall = installBridge({
    closeoutNow: async (agent, options) => {
      calls.push(`closeout:${agent.session.id}:${options?.source}`);
      return { ok: true, sessionId: agent.session.id, folded: true, source: options?.source };
    },
  });
  try {
    writeGraph(home, "session-due", { maxSeq: 500 });
    const handler = await mount({
      sessionController: {
        agents: {
          resolveAgent: async (id) => {
            calls.push(`resume:${id}`);
            return { agent: { session: { id } } };
          },
        },
      },
      workspaceRegistry: {
        archivedSessionIds: archived,
        unarchiveSession: async (id) => {
          calls.push(`unarchive:${id}`);
          const i = archived.indexOf(id);
          if (i >= 0) archived.splice(i, 1);
        },
        archiveSession: async (id) => {
          calls.push(`archive:${id}`);
          if (!archived.includes(id)) archived.push(id);
        },
      },
    });
    const { status, json } = await withHome(home, () => call(handler, { action: "backfill" }));
    t.eq(status, 200, "真补必须成功返回");
    t.eq(calls.join(","), "unarchive:session-due,resume:session-due,closeout:session-due:backfill,archive:session-due", "顺序：先取消归档、再 resume、再补、最后归档回去");
    t.eq(json?.done, 1, "补成功 1 条");
    t.eq(json?.folded, 1, "真折了 1 条");
    t.eq(json?.canCycle, true, "接上了 registry ⇒ 要如实回报能还原归档状态");
    t.eq(archived, ["session-due"], "补完必须回到「已归档」，不许把会话留在半途");
  } finally {
    uninstall();
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C216 面板补账：宿主没有 sessionController ⇒ 503 no-session-controller（别让页面以为补成功）"] = async (t) => {
  const home = mkHome("noctl");
  const uninstall = installBridge({ closeoutNow: async () => ({ folded: true }) });
  try {
    writeGraph(home, "session-due", { maxSeq: 500 });
    const handler = await mount({});
    const { status, json } = await withHome(home, () => call(handler, { action: "backfill" }));
    t.eq(status, 503, "缺少必需的宿主服务必须 503");
    t.eq(json?.code, "no-session-controller", "说清缺的是哪一个");
    t.eq(json?.due, 1, "失败回包里仍然带出清单（排障要知道本来有几条）");
  } finally {
    uninstall();
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ───────────────────── ★ C234：面板上的「补账」卡 ───────────────────── */

tests["C234 客户端补账文案：dryRun 报清单、真跑报结果、失败只陈述原因"] = async (t) => {
  const nodeFs = await import(nodePath.join ? "node:fs" : "node:fs");
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "lib", "client.js"), "utf8");
  t.includes(src, "backfillLines", "客户端必须暴露补账文案的纯函数");
  t.includes(src, 'callApi("backfill"', "按钮要真的打到 backfill action（不是摆设）");
  t.includes(src, "dryRun: true", "「检查欠账」必须走 dryRun（不 resume、不调模型）");
  t.includes(src, "补账", "卡片标题");
};

/* ─────────────── ★ C260：并发闸门（两个标签页不能同时补） ─────────────── */

tests["C260 补账在途闸门：并发真跑必须被拒，且失败后闸门要释放"] = async (t) => {
  const uiMod = await import(pathToFileURL(nodePath.join(HERE, "..", "src", "ui.mjs")).href);
  const gate = uiMod.BACKFILL_GATE;
  t.eq(!!gate && typeof gate === "object", true, "必须导出 BACKFILL_GATE（可读可重置）");
  t.eq(gate.inFlight, false, "初始必须是空闲");

  // 闸门语义：占住 ⇒ 第二次真跑被拒；释放 ⇒ 又能跑
  gate.inFlight = true;
  t.eq(gate.inFlight, true, "占住之后必须是 inFlight");
  gate.inFlight = false;
  t.eq(gate.inFlight, false, "释放之后必须回到空闲");

  // 源码接线守卫：真跑前后必须成对（else 一次异常会把闸门永久焊死）
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "ui.mjs"), "utf8");
  t.includes(src, "if (BACKFILL_GATE.inFlight)", "真跑前必须先检查闸门");
  t.includes(src, "code: \"backfill-busy\"", "被拒时必须给可辨识的 code");
  t.includes(src, "} finally {", "释放必须在 finally 里（异常也要放）");
  // dryRun 不该被闸门挡住（它不 resume、不调模型）
  const dryLine = src.slice(src.indexOf('const backfillDryRun'), src.indexOf('if (BACKFILL_GATE.inFlight)'));
  t.includes(dryLine, "backfillDryRun", "dryRun 的判断要在闸门之前");
};

/* ─────────────── ★ C261：单会话硬超时可设 + 客户端限量 ─────────────── */

tests["C261 补账的硬超时默认 3 分钟——客户端必须限量并传更短的 perItemMs"] = async (t) => {
  const { DEFAULT_PER_ITEM_MS } = await import(pathToFileURL(nodePath.join(HERE, "..", "src", "rooms", "closeout-backfill.mjs")).href);
  t.eq(DEFAULT_PER_ITEM_MS >= 60_000, true, "服务端默认每个会话的硬超时是分钟级（这正说明客户端必须限量）");

  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "ui.mjs"), "utf8");
  t.includes(src, "perItemMs", "服务端必须接受 perItemMs");
  t.includes(src, "Math.min(180_000", "perItemMs 必须有上界（不许传 1 小时进来）");
  t.includes(src, "Math.max(10_000", "perItemMs 必须有下界（不许传 0 让它立刻全失败）");

  const client = nodeFs.readFileSync(nodePath.join(HERE, "..", "lib", "client.js"), "utf8");
  t.includes(client, "limit: 3", "客户端每次最多 3 个");
  t.includes(client, "perItemMs: 120_000", "客户端要传 120 秒");
  // ★ C262：外层超时必须**大于**内层（引擎 closeoutTimeoutMs 默认 90s），否则外层先开枪、原因丢失
  const schemaMod = await import(pathToFileURL(nodePath.join(HERE, "..", "src", "rooms", "config-schema.mjs")).href);
  const inner = Number(schemaMod.configDefaults().closeoutTimeoutMs);
  t.eq(120_000 > inner, true, `外层 120s 必须大于内层 ${inner}ms，否则用户只看到笼统 timeout`);
};

tests["C392 补账干跑要提前给出「会超时」的会话（否则点下去才发现白跑）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "src", "ui.mjs"), "utf8");

  // 接线：干跑分支必须复用 closeout-plan 的两个纯函数，不许自己再算一套
  t.includes(src, "closeoutTimeoutAdvice(", "必须复用 closeoutTimeoutAdvice（C392）");
  t.includes(src, "recentFoldP90(", "必须用真机 p90（recentFoldP90）");
  t.includes(src, "warnings", "干跑响应必须带 warnings 字段");
  // 失败要降级，不许把干跑本身搞挂
  t.includes(src, "return [];", "算不出来时要返回空数组（降级）");
};

tests["C408 补账可指定 sessionIds（否则只能先碰最大的那个）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "src", "ui.mjs"), "utf8");
  t.includes(src, "body.sessionIds", "必须读取 body.sessionIds（C408）");
  t.includes(src, "items: picked", "dryRun 与真补都必须使用筛选后的清单");
  t.includes(src, "都不在待补清单里", "指定了但没命中时要明确报错（不许静默跑全部）");
  // rankDebts 是 tail 降序 ⇒ 默认先补最大的；这条注释必须留着解释为什么需要 sessionIds
  t.includes(src, "按 tail 降序取前 N 个", "要写清默认排序，解释 sessionIds 的动机");
};
