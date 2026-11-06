/**
 * backfill-button.test.mjs —— 「补折」按钮：一次点击只派一个子代理，模型可随本次选择。
 *
 * 全部子代理与模型结果都是夹具；不启动 DSH、不启动定时器、不访问网络、不调真模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_TREE } from "./panel-layout.test.mjs";
import { load, makeCtx } from "./engine-harness.test.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CLIENT = nodePath.join(HERE, "..", "lib", "client.js");
const ENGINE_KEY = Symbol.for("dsh-gokifu.engine");

function childrenOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(childrenOf);
  return typeof node === "object" ? node.children ?? [] : [];
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  for (const child of childrenOf(node)) findAll(child, predicate, out);
  return out;
}

function clientTestables() {
  const source = nodeFs.readFileSync(CLIENT, "utf8");
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (row) => (loaded = row) } };
  new Function("window", source)(fakeWindow);
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect() {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  return loaded.factory((spec) => {
    if (spec === "react") return react;
    throw new Error(`意外 require(${spec})`);
  }).__testables;
}

function parentFixture() {
  return {
    id: "session-parent",
    options: { provider: "current-provider", model: "current-model" },
    session: {
      id: "session-parent",
      requestHeader: () => ({ config: { provider: "current-provider", model: "current-model" } }),
    },
  };
}

function runtimeFixture(calls, result) {
  return {
    list: () => ["spawn"],
    async startActivation(spec) {
      calls.push(spec);
      return { childId: "session-child-backfill", result: Promise.resolve(result) };
    },
  };
}

function completed(report = "exit 0; wrote one fold") {
  return { stopReason: "completed", structured: { ok: true, report } };
}

function callRoute(handler, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
      on(event, callback) {
        if (event === "data") callback(Buffer.from(text, "utf8"));
        if (event === "end") callback();
        return req;
      },
    };
    const res = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(chunk) {
        try {
          resolve({ status: this.status, json: JSON.parse(chunk ?? "") });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function makeEngine(ctx, graphDir) {
  return new (globalThis.__BackfillButtonEngine)(ctx, { graphDir, auto: false });
}

export const tests = {};

tests["① 真实总览按钮只发 backfill-subagent；两个模型键留空即跟随当前路由"] = async (t) => {
  const T = clientTestables();
  t.eq(T.backfillSubagentRequest({ summarizationProvider: "free-provider", summarizationModel: "free-model" }), {
    action: "backfill-subagent",
    summarizationProvider: "free-provider",
    summarizationModel: "free-model",
  });
  t.eq(T.backfillSubagentRequest({ summarizationProvider: "free-provider", summarizationModel: "" }), {
    action: "backfill-subagent",
    summarizationProvider: "",
    summarizationModel: "",
  }, "只填一半也必须完整继承，不能拼出半个路由");

  const buttons = findAll(DEFAULT_TREE, (node) => node.type === "button" && node.props?.["data-backfill-subagent"] === "true");
  t.eq(buttons.length, 1, "总览必须恰好有一个补折子代理按钮");
  t.eq(findAll(DEFAULT_TREE, (node) => node.props?.["data-backfill-provider"] === "summarizationProvider").length, 1);
  t.eq(findAll(DEFAULT_TREE, (node) => node.props?.["data-backfill-model"] === "summarizationModel").length, 1);

  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, dispatched: true, childId: "child-ui" }) };
  };
  try {
    buttons[0].props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    t.eq(calls.length, 1, "点一下只能打一次 host 请求");
    t.eq(calls[0].url, "/gokifu/api");
    t.eq(calls[0].body, { action: "backfill-subagent", summarizationProvider: "", summarizationModel: "" });
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
};

tests["② 引擎入口一次只派一个子代理，免费 provider/model 同时进入子代理路由与补折命令"] = async (t) => {
  const { Engine } = await load();
  globalThis.__BackfillButtonEngine = Engine;
  const graphDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-backfill-button-"));
  const previousBridge = globalThis[ENGINE_KEY];
  try {
    const ctx = makeCtx();
    const engine = makeEngine(ctx, graphDir);
    const calls = [];
    const runtime = runtimeFixture(calls, completed());
    const report = await globalThis[ENGINE_KEY].runBackfillWithModel({
      parent: parentFixture(),
      subagents: runtime,
      summarizationProvider: "free-provider",
      summarizationModel: "free-model",
    });
    t.eq(report.ok, true, report.error ?? "子代理成功回执必须成功");
    t.eq(report.dispatched, true);
    t.eq(report.childId, "session-child-backfill");
    t.eq(calls.length, 1, "一次点击只能 startActivation 一次");
    t.eq(calls[0].delivery, "caller");
    t.eq(calls[0].request.agentOptions, { provider: "free-provider", model: "free-model" });
    const prompt = calls[0].request.prompt[0].text;
    t.includes(prompt, "node scripts/archive-fold.mjs --due --limit 1 --chunks 1 --write --model 'free-model'");
    t.includes(prompt, "structured_output");
    t.eq(engine._autoBackfill, undefined, "按钮路径不得创建后台 timeout/interval");
    t.eq(ctx.streamCalls.length, 0, "夹具不得意外走旧同步模型路径");
  } finally {
    if (previousBridge === undefined) delete globalThis[ENGINE_KEY];
    else globalThis[ENGINE_KEY] = previousBridge;
    delete globalThis.__BackfillButtonEngine;
    nodeFs.rmSync(graphDir, { recursive: true, force: true });
  }
};

tests["③ 留空继承父 agent 当前路由，不写入 agentOptions，也不改全局 summarization 配置"] = async (t) => {
  const { Engine } = await load();
  const graphDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-backfill-inherit-"));
  try {
    const ctx = makeCtx();
    const engine = new Engine(ctx, {
      graphDir,
      auto: false,
      summarizationProvider: "saved-provider",
      summarizationModel: "saved-model",
    });
    const calls = [];
    const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls, completed()) });
    t.eq(report.ok, true);
    t.eq(report.inheritedRoute, true);
    t.eq(report.provider, "current-provider");
    t.eq(report.model, "current-model");
    t.eq(Object.hasOwn(calls[0].request, "agentOptions"), false, "留空必须由子代理继承父级，而不是写死覆盖");
    t.includes(calls[0].request.prompt[0].text, "--model 'current-model'");
    t.eq(engine.chess.summarizationProvider, "saved-provider", "按钮不得改写已保存 provider");
    t.eq(engine.chess.summarizationModel, "saved-model", "按钮不得改写已保存 model");
    t.eq(engine._autoBackfill, undefined);
  } finally {
    nodeFs.rmSync(graphDir, { recursive: true, force: true });
  }
};

tests["④ 并发第二次、子代理失败、启动失败都真红；completed 但没有成功回执也不能假绿"] = async (t) => {
  const { Engine, mod } = await load();
  const { backfillSubagentOutcome } = mod;
  const graphDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-backfill-failure-"));
  try {
    const ctx = makeCtx();
    const engine = new Engine(ctx, { graphDir, auto: false });
    let settle;
    const calls = [];
    const pendingRuntime = {
      list: () => ["spawn"],
      async startActivation(spec) {
        calls.push(spec);
        return { childId: "child-pending", result: new Promise((resolve) => (settle = resolve)) };
      },
    };
    const first = engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: pendingRuntime });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: pendingRuntime });
    t.eq(second.ok, false);
    t.eq(second.busy, true, "第一个子代理未结束时第二次必须返回 busy");
    t.eq(calls.length, 1, "并发点击不得派出第二个子代理");
    settle(completed());
    t.eq((await first).ok, true);

    const failed = await engine.runBackfillSubagentOnce({
      parent: parentFixture(),
      subagents: runtimeFixture([], { stopReason: "completed", structured: { ok: false, report: "exit 1; no fold written" } }),
    });
    t.eq(failed.ok, false, "子代理自报失败必须原样变红");
    t.eq(failed.error, "exit 1; no fold written");

    const startup = await engine.runBackfillSubagentOnce({
      parent: parentFixture(),
      subagents: { list: () => ["spawn"], startActivation: async () => { throw new Error("spawn denied"); } },
    });
    t.eq(startup.ok, false);
    t.eq(startup.dispatched, false);
    t.includes(startup.error, "spawn denied");

    t.eq(backfillSubagentOutcome({ stopReason: "error", structured: { ok: true, report: "late text" } }).ok, false, "异常结束即使带 ok=true 也不能算成功");
    t.eq(backfillSubagentOutcome({ stopReason: "completed", structured: { ok: true, report: "wrote" } }).ok, true);
    t.eq(backfillSubagentOutcome({ stopReason: "completed" }).ok, false, "缺 structured_output 不能算成功");
    t.eq(ctx.streamCalls.length, 0, "任何失败分支都不得退回旧同步模型调用");
  } finally {
    nodeFs.rmSync(graphDir, { recursive: true, force: true });
  }
};

tests["⑤ host 真路由把两个模型键交给同一个引擎桥；缺引擎必须 503 而不是旧补账"] = async (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-backfill-route-"));
  const previousHome = process.env.DSH_HOME;
  const previousHeal = process.env.DSH_GOKIFU_NO_HEAL;
  const previousBridge = globalThis[ENGINE_KEY];
  process.env.DSH_HOME = home;
  process.env.DSH_GOKIFU_NO_HEAL = "1";
  try {
    const ui = await import(`${pathToFileURL(nodePath.join(HERE, "..", "src", "ui.mjs")).href}?backfill-button=${Math.random()}`);
    const routes = [];
    ui.apply({
      webServer: { register: (route) => (routes.push(route), () => {}), host: "127.0.0.1" },
      effect: (fn) => fn(),
      get: () => undefined,
    });
    t.eq(routes.length, 1, "host 必须注册同一个 /gokifu/api 路由");
    const calls = [];
    globalThis[ENGINE_KEY] = {
      runBackfillWithModel: async (options) => {
        calls.push(options);
        return { ok: true, dispatched: true, childId: "child-route", provider: options.provider, model: options.model };
      },
    };
    const response = await callRoute(routes[0].handler, {
      action: "backfill-subagent",
      summarizationProvider: "free-provider",
      summarizationModel: "free-model",
    });
    t.eq(response.status, 200);
    t.eq(response.json.ok, true);
    t.eq(calls, [{ provider: "free-provider", model: "free-model" }], "host 不得吞掉或改写本次免费模型");

    delete globalThis[ENGINE_KEY];
    const missing = await callRoute(routes[0].handler, { action: "backfill-subagent", summarizationProvider: "", summarizationModel: "" });
    t.eq(missing.status, 503);
    t.eq(missing.json.code, "engine-missing");
    t.eq(calls.length, 1, "缺引擎不得退回旧 backfill/closeout 路径");
  } finally {
    if (previousBridge === undefined) delete globalThis[ENGINE_KEY];
    else globalThis[ENGINE_KEY] = previousBridge;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousHeal === undefined) delete process.env.DSH_GOKIFU_NO_HEAL;
    else process.env.DSH_GOKIFU_NO_HEAL = previousHeal;
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
