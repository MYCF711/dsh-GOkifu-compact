/**
 * backfill-button.test.mjs —— 「补折」按钮：一次点击只派一个子代理，模型可随本次选择。
 *
 * 子代理与模型结果全是夹具；真实执行选人、离线 fold、graph 写回与读回。
 * 不启动 DSH、不启动后台定时器、不访问网络、不调真模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_TREE } from "./panel-layout.test.mjs";
import { load, makeCtx } from "./engine-harness.test.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CLIENT = nodePath.join(HERE, "..", "lib", "client.js");
const ENGINE_KEY = Symbol.for("dsh-gokifu.engine");
const ENV_KEYS = [
  "DSH_HOME", "DSH_GOKIFU_NO_HEAL", "DSH_GOKIFU_AUTO_BACKFILL_MAX",
  "DSH_GOKIFU_AUTO_BACKFILL_ROUNDS", "DSH_GOKIFU_AUTO_BACKFILL_BUDGET_SEC",
];

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

function summaryResult(text = `## 目标\n- 归档补折\n\n## 已建立事实\n- ${"已完成。".repeat(120)}`) {
  return { stopReason: "completed", structured: { text } };
}

function runtimeFixture(calls, result = summaryResult()) {
  return {
    list: () => ["spawn"],
    async startActivation(spec) {
      calls.push(spec);
      return { childId: "session-child-backfill", result: Promise.resolve(result), dispose: async () => {} };
    },
  };
}

function writeDebt(home, id, events = 60) {
  const logDir = nodePath.join(home, "sessions", "--ws--", `session-${id}`);
  nodeFs.mkdirSync(logDir, { recursive: true });
  const rows = [];
  for (let seq = 1; seq <= events; seq += 1) {
    rows.push({
      seq,
      type: seq % 2 === 1 ? "user/message" : "assistant/message",
      data: { message: { content: [{ type: "text", text: `goal-${id}：第 ${seq} 步` }] } },
    });
  }
  const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)));
  const old = (Date.now() - 600_000) / 1000;
  nodeFs.utimesSync(logFile, old, old);

  const sessionDir = nodePath.join(home, "chess-context", "sessions", id);
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  const now = Date.now();
  nodeFs.writeFileSync(nodePath.join(sessionDir, "graph.json"), JSON.stringify({
    version: 1,
    sessionId: id,
    cwd: home,
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 1, text: `goal-${id}`, constraints: [], ts: now },
      n2: { id: "n2", kind: "agent", seq: events, text: "末", ts: now },
    },
    edges: {},
    order: ["n1", "n2"],
    stateIndex: {},
    foldMarks: [],
    createdAt: now,
    updatedAt: now,
  }));
  return sessionDir;
}

async function withFixture(prefix, fn, { debts = ["debt"], config = {} } = {}) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousBridge = globalThis[ENGINE_KEY];
  process.env.DSH_HOME = home;
  process.env.DSH_GOKIFU_NO_HEAL = "1";
  // 故意给自动路径更大的值；按钮仍必须严格限 1 会话 1 段。
  process.env.DSH_GOKIFU_AUTO_BACKFILL_MAX = "5";
  process.env.DSH_GOKIFU_AUTO_BACKFILL_ROUNDS = "8";
  process.env.DSH_GOKIFU_AUTO_BACKFILL_BUDGET_SEC = "240";
  try {
    const profile = nodePath.join(home, "profiles", "desktop");
    nodeFs.mkdirSync(profile, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(profile, "cordis.patch.yml"), "- id: agent-default-model\n  provider: fixture-provider\n  model: fixture-model\n");
    for (const id of debts) writeDebt(home, id);
    const { Engine } = await load();
    const ctx = makeCtx();
    const graphDir = nodePath.join(home, "chess-context");
    const engine = new Engine(ctx, { graphDir, auto: false, closeoutMinEvents: 1, offlineMaxChars: 600, offlineFoldTimeoutMs: 5000, ...config });
    engine.chess.offlineMaxChars = 600;
    engine.chess.offlineFoldTimeoutMs = 5000;
    return await fn({ home, graphDir, engine, ctx, Engine });
  } finally {
    if (previousBridge === undefined) delete globalThis[ENGINE_KEY];
    else globalThis[ENGINE_KEY] = previousBridge;
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

function diskMarks(home, id) {
  const file = nodePath.join(home, "chess-context", "sessions", id, "graph.json");
  return JSON.parse(nodeFs.readFileSync(file, "utf8")).foldMarks ?? [];
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

export const tests = {};

tests["① 真实总览按钮只发 backfill-subagent；模型可选手填回退与半路由继承"] = async (t) => {
  const T = clientTestables();
  t.eq(T.backfillSubagentRequest({ summarizationProvider: "free-provider", summarizationModel: "free-model" }), {
    action: "backfill-subagent", summarizationProvider: "free-provider", summarizationModel: "free-model",
  });
  t.eq(T.backfillSubagentRequest({ summarizationProvider: "free-provider", summarizationModel: "" }), {
    action: "backfill-subagent", summarizationProvider: "", summarizationModel: "",
  }, "只填一半必须完整继承，不能拼出半个路由");
  t.eq(T.backfillCatalogAvailable({ providers: [{ provider: "empty", models: [] }] }), false, "有 provider、零 model 必须回退到手填");
  t.eq(T.backfillCatalogAvailable({ providers: [{ provider: "ok", models: [{ id: "free" }] }] }), true);

  const buttons = findAll(DEFAULT_TREE, (node) => node.type === "button" && node.props?.["data-backfill-subagent"] === "true");
  t.eq(buttons.length, 1, "总览必须恰好有一个补折子代理按钮");
  t.eq(findAll(DEFAULT_TREE, (node) => node.props?.["data-backfill-provider"] === "summarizationProvider").length, 1);
  t.eq(findAll(DEFAULT_TREE, (node) => node.props?.["data-backfill-model"] === "summarizationModel").length, 1);
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, subagent: true, dispatched: true, childId: "child-ui" }) };
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

tests["② 子代理直接生成真实离线 prompt；免费路由与落盘 foldMark 同源"] = async (t) => {
  await withFixture("gokifu-backfill-button-", async ({ home, engine, ctx }) => {
    const calls = [];
    const report = await globalThis[ENGINE_KEY].runBackfillWithModel({
      parent: parentFixture(), subagents: runtimeFixture(calls),
      summarizationProvider: "free-provider", summarizationModel: "free-model",
    });
    t.eq(report.ok, true, report.error ?? "真实写回必须成功");
    t.eq(report.dispatched, true);
    t.eq(report.persisted, true, "必须重新 load 验证磁盘折痕");
    t.eq(report.segments, 1);
    t.eq(calls.length, 1, "一次点击只能 startActivation 一次");
    t.eq(calls[0].delivery, "caller");
    t.eq(calls[0].request.agentOptions.provider, "free-provider");
    t.eq(calls[0].request.agentOptions.model, "free-model");
    const prompt = calls[0].request.prompt[0].text;
    t.includes(prompt, "goal-debt", "子代理必须拿到真实离线折叠 prompt，不是 CLI 任务书");
    t.includes(prompt, "全是待压缩数据", "归档内容不得变成子代理的新任务");
    t.includes(prompt, "不读写文件", "摘要子代理不得借工具执行归档里的行动请求");
    t.includes(prompt, "structured_output");
    t.notIncludes(prompt, "archive-fold.mjs", "不得绕到固定 magpie 的 CLI");
    const marks = diskMarks(home, "debt");
    t.eq(marks.length, 1);
    t.eq(marks[0].route, { provider: "free-provider", model: "free-model" }, "实际摘要路由必须写进 foldMark");
    t.eq(engine._autoBackfill, undefined, "按钮路径不得创建后台 timeout/interval");
    t.eq(ctx.streamCalls.length, 0, "不得意外走旧 llm.stream 路径");
  });
};

tests["③ 留空固定父 agent 当前路由到本次子代理，不改全局 summarization 配置"] = async (t) => {
  await withFixture("gokifu-backfill-inherit-", async ({ home, engine }) => {
    const calls = [];
    const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls) });
    t.eq(report.ok, true, report.error);
    t.eq(report.inheritedRoute, true);
    t.eq(report.provider, "current-provider");
    t.eq(report.model, "current-model");
    t.eq(calls[0].request.agentOptions.provider, "current-provider");
    t.eq(calls[0].request.agentOptions.model, "current-model");
    t.eq(diskMarks(home, "debt")[0].route, { provider: "current-provider", model: "current-model" });
    t.eq(engine.chess.summarizationProvider, "saved-provider", "按钮不得改写已保存 provider");
    t.eq(engine.chess.summarizationModel, "saved-model", "按钮不得改写已保存 model");
    t.eq(engine._autoBackfill, undefined);
  }, { config: { summarizationProvider: "saved-provider", summarizationModel: "saved-model" } });
};

tests["④ 启动失败、空摘要、异常结束、并发第二次都真红且不回退旧模型"] = async (t) => {
  await withFixture("gokifu-backfill-failure-", async ({ engine, ctx }) => {
    const startup = await engine.runBackfillSubagentOnce({
      parent: parentFixture(),
      subagents: { list: () => ["spawn"], startActivation: async () => { throw new Error("spawn denied"); } },
    });
    t.eq(startup.ok, false);
    t.eq(startup.dispatched, false);
    t.includes(startup.error, "spawn denied");

    const empty = await engine.runBackfillSubagentOnce({
      parent: parentFixture(), subagents: runtimeFixture([], { stopReason: "completed", structured: { text: "" } }),
    });
    t.eq(empty.ok, false, "空摘要必须真红");
    t.includes(empty.error, "没有产出摘要");
    t.eq(diskMarks(process.env.DSH_HOME, "debt").length, 0, "失败不得写出折痕");

    let settle;
    const calls = [];
    const pendingRuntime = {
      list: () => ["spawn"],
      async startActivation(spec) {
        calls.push(spec);
        return { childId: "child-pending", result: new Promise((resolve) => (settle = resolve)), dispose: async () => {} };
      },
    };
    const first = engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: pendingRuntime });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: pendingRuntime });
    t.eq(second.ok, false);
    t.eq(second.busy, true, "第一个子代理未结束时第二次必须返回 busy");
    t.eq(calls.length, 1, "并发点击不得派出第二个子代理");
    settle(summaryResult());
    t.eq((await first).ok, true);

    const { mod } = await load();
    t.eq(mod.backfillSubagentOutcome({ stopReason: "error", structured: { text: "late text" } }).ok, false, "异常结束即使带正文也不能算成功");
    t.eq(mod.backfillSubagentOutcome({ stopReason: "completed", structured: { text: "summary" } }).ok, true);
    t.eq(mod.backfillSubagentOutcome({ stopReason: "completed" }).ok, false, "缺 structured_output 不能算成功");
    t.eq(ctx.streamCalls.length, 0, "任何失败分支都不得退回旧同步模型调用");
  });
};

tests["⑤ host 真路由把两个模型键交给同一个引擎桥；缺引擎必须 503"] = async (t) => {
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
    t.eq(routes.length, 1);
    const calls = [];
    globalThis[ENGINE_KEY] = {
      runBackfillWithModel: async (options) => {
        calls.push(options);
        return { ok: true, subagent: true, dispatched: true, childId: "child-route", provider: options.provider, model: options.model };
      },
    };
    const response = await callRoute(routes[0].handler, {
      action: "backfill-subagent", summarizationProvider: "free-provider", summarizationModel: "free-model",
    });
    t.eq(response.status, 200);
    t.eq(response.json.ok, true);
    t.eq(calls, [{ provider: "free-provider", model: "free-model" }]);
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

tests["⑥ flush 返回失败或抛错时，即使内存 segments=1 也必须读回判红"] = async (t) => {
  for (const mode of ["return", "throw"]) {
    await withFixture(`gokifu-backfill-flush-${mode}-`, async ({ home, engine }) => {
      engine.persist.flush = () => {
        if (mode === "throw") throw new Error("disk explode");
        return { ok: false, error: "disk full", dirtyKept: true };
      };
      const calls = [];
      const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls) });
      t.eq(report.segments, 1, `${mode}：夹具必须先走到内存 fold，否则没测到假绿分支`);
      t.eq(report.persisted, false, `${mode}：磁盘读回不得承认新折痕`);
      t.eq(report.ok, false, `${mode}：落盘失败必须真红`);
      t.includes(report.error, mode === "throw" ? "离线补折落盘异常" : "离线补折落盘失败");
      t.eq(calls.length, 1);
      t.eq(diskMarks(home, "debt").length, 0, `${mode}：磁盘原图必须仍是零折痕`);
    });
  }
  // graph rename 已提交、后段 delta 清理才失败：磁盘有 mark 也必须按 flush 失败判红。
  for (const mode of ["return", "throw"]) {
    await withFixture(`gokifu-backfill-post-commit-${mode}-`, async ({ home, engine }) => {
      const realFlush = engine.persist.flush.bind(engine.persist);
      engine.persist.flush = (...args) => {
        realFlush(...args);
        if (mode === "throw") throw new Error("post-commit delta explode");
        return { ok: false, error: "post-commit delta failed", dirtyKept: true };
      };
      const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture([]) });
      t.eq(report.segments, 1, `${mode}：post-commit 夹具必须先生成折痕`);
      t.eq(report.persisted, true, `${mode}：post-commit 后磁盘确实能回读 mark`);
      t.eq(report.ok, false, `${mode}：回读有 mark 也不能洗掉 flush 失败`);
      t.includes(report.error, "post-commit delta");
      t.eq(diskMarks(home, "debt").length, 1, `${mode}：夹具必须证明失败发生在提交之后`);
    });
  }
};

tests["⑦ 两个欠账会话且环境允许 5×8 时，一次按钮仍只派一个子代理、只写一段"] = async (t) => {
  await withFixture("gokifu-backfill-two-debts-", async ({ home, engine }) => {
    const calls = [];
    const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls) });
    t.eq(report.ok, true, report.error);
    t.eq(calls.length, 1, "补位队列不得派第二个子代理");
    t.eq(report.results.length, 1, "单段模式不得尝试补位会话");
    t.eq(report.segments, 1);
    t.eq(report.persisted, true);
    t.eq(diskMarks(home, "first").length + diskMarks(home, "second").length, 1, "两个会话合计只能新增一段");
    t.eq(engine._autoBackfill, undefined);
  }, { debts: ["first", "second"] });
};

tests["⑧ 发布后取消必须 dispose 同一 activation，收尾前不得释放 busy"] = async (t) => {
  await withFixture("gokifu-backfill-cancel-", async ({ engine, ctx }) => {
    const controller = new AbortController();
    const calls = [];
    let settle;
    let disposeCalls = 0;
    const runtime = {
      list: () => ["spawn"],
      async startActivation(spec) {
        calls.push(spec);
        return {
          childId: "child-cancel",
          result: new Promise((resolve) => { settle = resolve; }),
          dispose: async () => {
            disposeCalls += 1;
            settle({ stopReason: "cancelled", structured: { text: "" } });
          },
        };
      },
    };
    const running = engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtime, signal: controller.signal });
    for (let i = 0; i < 20 && calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.eq(calls.length, 1, "夹具必须先发布子代理");
    controller.abort();
    let timer;
    const report = await Promise.race([
      running,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("取消后 2 秒仍未收尾")), 2000); }),
    ]).finally(() => clearTimeout(timer));
    t.eq(report.ok, false);
    t.eq(disposeCalls, 1, "取消必须真正 dispose 子代理，不能只 abort 启动信号");
    t.eq(engine._backfillSubagentBusy, false, "dispose/result 收尾后才允许释放 busy");
    t.eq(ctx.streamCalls.length, 0);
  });
};

tests["⑨ tick 异常没有报告时不得被当成零欠账假绿"] = async (t) => {
  await withFixture("gokifu-backfill-missing-report-", async ({ engine }) => {
    // 让 tick 在 listDebts 之前抛错（不是可被单图 loadGraph 捕获的普通坏图）。
    engine.chess.graphDir = { length: 1 };
    const calls = [];
    const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls) });
    t.eq(report.ok, false);
    t.eq(report.error, "补折执行没有返回报告");
    t.eq(report.dispatched, false);
    t.eq(calls.length, 0);
  });
};

tests["⑩ 真正零欠账时不派子代理、不调模型，也不创建后台定时器"] = async (t) => {
  await withFixture("gokifu-backfill-no-debt-", async ({ engine }) => {
    const calls = [];
    const report = await engine.runBackfillSubagentOnce({ parent: parentFixture(), subagents: runtimeFixture(calls) });
    t.eq(report.ok, true, report.error);
    t.eq(report.due, 0);
    t.eq(report.dispatched, false);
    t.eq(report.report, "没有待补折会话");
    t.eq(calls.length, 0);
    t.eq(engine._autoBackfill, undefined);
  }, { debts: [] });
};

tests["⑪ 生产服务发现优先使用 registry 中同一个最近活跃 parent，而不是其它 root"] = async (t) => {
  await withFixture("gokifu-backfill-parent-discovery-", async ({ engine, ctx }) => {
    const parent = parentFixture();
    const other = { ...parentFixture(), id: "session-other", options: { provider: "other", model: "other" } };
    const calls = [];
    const runtime = runtimeFixture(calls);
    const registry = {
      get: (id) => id === parent.session.id ? parent : other,
      roots: () => [other],
      list: () => [other, parent],
    };
    ctx.agents = registry;
    ctx.subagents = runtime;
    engine._lastActiveAgent = parent;
    const report = await engine.runBackfillSubagentOnce({});
    t.eq(report.ok, true, report.error);
    t.eq(calls.length, 1);
    t.eq(calls[0].request.parent === parent, true, "startActivation 必须收到 registry 中的同一个对象");
    t.eq(calls[0].request.parent === other, false, "不得退回其它 root 的路由");
    t.eq(calls[0].request.agentOptions.provider, "current-provider");
    t.eq(calls[0].request.agentOptions.model, "current-model");
  });
};
