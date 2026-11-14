/**
 * auto-backfill-switch.test.mjs —— T68：自动归档补折默认关，且不误伤实时折叠/当前会话收尾。
 *
 * 全部使用隔离 home + 假模型；不写 live profile、不重启 DSH、不调真模型。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { engineBlock, parseEngineBlock } from "../src/rooms/preset-format.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const harness = async () => await import(pathToFileURL(nodePath.join(HERE, "engine-harness.test.mjs")).href);

async function withHome(prefix, fn) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  const previousHome = process.env.DSH_HOME;
  const previousHeal = process.env.DSH_GOKIFU_NO_HEAL;
  process.env.DSH_HOME = home;
  process.env.DSH_GOKIFU_NO_HEAL = "1";
  try {
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousHeal === undefined) delete process.env.DSH_GOKIFU_NO_HEAL;
    else process.env.DSH_GOKIFU_NO_HEAL = previousHeal;
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}


/** ★ C664：读「生效文件」（有 pending 读 pending）。 */
function readEffective(presetPath) {
  const pending = `${presetPath}.pending`;
  return nodeFs.readFileSync(nodeFs.existsSync(pending) ? pending : presetPath, "utf8");
}

function stopAutoBackfill(engine) {
  clearTimeout(engine?._autoBackfill?.first);
  clearInterval(engine?._autoBackfill?.timer);
}

function writeArchiveDebt(home, id) {
  const logDir = nodePath.join(home, "sessions", "--ws--", `session-${id}`);
  nodeFs.mkdirSync(logDir, { recursive: true });
  const events = [];
  for (let seq = 1; seq <= 80; seq += 1) {
    events.push({
      seq,
      type: seq % 2 === 1 ? "user/message" : "assistant/message",
      data: { message: { content: [{ type: "text", text: `第 ${seq} 步：验证开关` }] } },
    });
  }
  const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)));
  const old = (Date.now() - 10 * 60_000) / 1000;
  nodeFs.utimesSync(logFile, old, old);

  const profile = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(profile, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(profile, "cordis.patch.yml"),
    ["- id: agent-default-model", "  provider: fixture-provider", "  model: fixture-model", ""].join("\n"),
  );

  const graphDir = nodePath.join(home, "chess-context");
  const sessionDir = nodePath.join(graphDir, "sessions", id);
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  const now = Date.now();
  nodeFs.writeFileSync(
    nodePath.join(sessionDir, "graph.json"),
    JSON.stringify({
      version: 1,
      sessionId: id,
      cwd: home,
      rootUserNodeIds: ["n1"],
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "验证开关", constraints: ["不调真模型"], ts: now },
        n2: { id: "n2", kind: "agent", seq: 80, text: "末", ts: now },
      },
      edges: {},
      order: ["n1", "n2"],
      stateIndex: {},
      foldMarks: [],
      updatedAt: now,
    }),
  );
  return { graphDir, sessionDir };
}

async function mountUi() {
  const ui = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href + `?auto-switch=${Math.random()}`);
  const routes = [];
  ui.apply({
    webServer: { register: (route) => (routes.push(route), () => {}), host: "127.0.0.1" },
    effect: (fn) => fn(),
  });
  if (routes.length !== 1) throw new Error(`UI 应注册 1 条路由，实际 ${routes.length}`);
  return { ui, handler: routes[0].handler };
}

function callApi(handler, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
      on(event, cb) {
        if (event === "data") cb(Buffer.from(text, "utf8"));
        if (event === "end") cb();
        return req;
      },
    };
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(chunk) {
        const raw = chunk ?? "";
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          /* 非 JSON 时保留 raw，断言会给出原文 */
        }
        resolve({ status: this.status, raw, json });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function writeUiPreset(home) {
  const dir = nodePath.join(home, "preset-bundles", "personal-assistant");
  nodeFs.mkdirSync(dir, { recursive: true });
  const file = nodePath.join(dir, "cordis.patch.yml");
  const block = engineBlock().map((line) => `              ${line}`).join("\n");
  nodeFs.writeFileSync(
    file,
    [
      "- insert:",
      "    - id: preset-personal-assistant",
      "      name: '@deepseek-ai/dsh-agent-preset'",
      "      config:",
      "        plugins:",
      block,
      "",
    ].join("\n"),
  );
  return file;
}

export const tests = {};

tests["T68① 默认关：不布防、不写自动补折状态、不调模型"] = async (t) => {
  const { load, makeCtx } = await harness();
  const { Engine } = await load();
  await withHome("auto-backfill-default-off-", async (home) => {
    const ctx = makeCtx();
    const graphDir = nodePath.join(home, "chess-context");
    const engine = new Engine(ctx, { graphDir, auto: false });
    try {
      t.eq(engine.chess.autoArchiveBackfill, false, "缺省配置必须解析成 false");
      t.eq(engine._autoBackfill, undefined, "默认关却创建了后台定时器");
      t.eq(nodeFs.existsSync(nodePath.join(graphDir, "auto-backfill-state.json")), false, "默认关却写了自动补折布防状态");
      t.eq(ctx.streamCalls.length, 0, "默认关却调用了摘要模型");
    } finally {
      stopAutoBackfill(engine);
    }
  });
};

tests["T68② 显式打开：定时器布防，真实欠账能补出 archive-offline"] = async (t) => {
  const { load, makeCtx, readGraphReplayed } = await harness();
  const { Engine } = await load();
  await withHome("auto-backfill-enabled-", async (home) => {
    const id = "switch-enabled";
    const { graphDir } = writeArchiveDebt(home, id);
    const ctx = makeCtx();
    let modelCalls = 0;
    ctx.llm.stream = async function* () {
      modelCalls += 1;
      yield {
        type: "text-delta",
        text: ["## 目标", "- 验证开关", "## 约束", "- 不调真模型", "## 棋谱（状态节点）", "- n1 → n2", "## 已探明死路", "- 无", "## 已建立事实", "- 开关可用", "## 当前节点", "- n2"].join("\n"),
      };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
    };
    const engine = new Engine(ctx, { graphDir, auto: false, closeoutMinEvents: 10, autoArchiveBackfill: true });
    try {
      t.eq(engine.chess.autoArchiveBackfill, true, "显式 true 必须传到引擎");
      t.eq(typeof engine._autoBackfill?.timer, "object", "打开后必须创建后台定时器");
      const armed = JSON.parse(nodeFs.readFileSync(nodePath.join(graphDir, "auto-backfill-state.json"), "utf8"));
      t.eq(armed.armed, true, "打开后必须落布防状态");
      const ran = await engine.runAutoBackfillOnce();
      t.eq(ran.ok, true, `手动驱动同一 tick 不许失败：${ran.error ?? ""}`);
      const graph = await readGraphReplayed(graphDir, id);
      const marks = (graph.foldMarks ?? []).filter((mark) => mark.trigger === "archive-offline");
      t.eq(marks.length, 1, `打开后必须真补出 1 段，实际 ${marks.length}`);
      t.eq(modelCalls, 1, `打开后应调用 1 次假模型，实际 ${modelCalls}`);
      t.eq(Number(graph.closeout?.folded) > 0, true, "补折结局必须落到 closeout");
    } finally {
      stopAutoBackfill(engine);
    }
  });
};

tests["T68③ 默认关不误伤：pressure 实时折叠与当前会话 archive 收尾照常"] = async (t) => {
  const { load, makeCtx, makeSession, readGraphReplayed } = await harness();
  const { Engine } = await load();
  await withHome("auto-backfill-unaffected-", async (home) => {
    const graphDir = nodePath.join(home, "chess-context");
    const ctx = makeCtx({ measureTotal: () => 300_000 });
    const engine = new Engine(ctx, {
      graphDir,
      auto: false,
      growthFloorTokens: 0,
      minFoldTokens: 0,
      retainRatio: 0.1,
      closeoutMinEvents: 5,
      closeoutTimeoutMs: 5000,
    });
    t.eq(engine.chess.autoArchiveBackfill, false, "夹具必须处于新开关默认关");

    const pressureSession = makeSession({ id: "pressure-still-on" });
    for (let i = 0; i < 19; i += 1) {
      pressureSession.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "实时折叠继续" }] });
    }
    const pressure = await engine.compactIfNeeded({ session: pressureSession, options: {} }, "pressure", undefined);
    t.ok(pressure, "默认关自动补折却挡住了 pressure 实时折叠");
    t.eq(engine.compactCalls.length, 1, "pressure 必须真的走到 compactRegion");
    await ctx.emitRaw("agent/status", { agent: { session: pressureSession }, status: "idle" });
    const pressureGraph = await readGraphReplayed(graphDir, pressureSession.id);
    t.eq(pressureGraph.foldMarks?.at(-1)?.trigger, "pressure", "实时折痕必须仍记为 pressure");

    const current = makeSession({ id: "current-closeout" });
    for (let i = 0; i < 12; i += 1) {
      current.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "当前会话收尾继续" }] });
    }
    await ctx.emitRaw("agent/status", { agent: { session: current }, status: "idle" });
    const callsBefore = engine.compactCalls.length;
    await ctx.emitRaw("domain/changed", {
      domain: "workspace",
      table: "",
      key: "",
      operation: "put",
      value: { archivedSessionIds: [current.id] },
    });
    let closeoutGraph = null;
    for (let i = 0; i < 100; i += 1) {
      closeoutGraph = await readGraphReplayed(graphDir, current.id);
      if (Number(closeoutGraph?.closeout?.folded) > 0 || closeoutGraph?.closeout?.foldError) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    t.eq(engine.compactCalls.length > callsBefore, true, "当前会话归档必须仍发起收尾折叠");
    t.eq(closeoutGraph?.closeout?.source, "archive", "当前会话收尾来源必须仍是 archive");
    t.eq(Number(closeoutGraph?.closeout?.folded) > 0, true, `当前会话必须收尾成功：${JSON.stringify(closeoutGraph?.closeout)}`);
    t.eq((closeoutGraph?.foldMarks ?? []).some((mark) => mark.trigger === "archive"), true, "当前会话必须留下 archive 折痕");
  });
};

tests["T68④ UI：默认关与费用说明可发现，配置可读写并可重新关闭"] = async (t) => {
  await withHome("auto-backfill-ui-", async (home) => {
    const presetFile = writeUiPreset(home);
    const { ui, handler } = await mountUi();

    const defaults = await callApi(handler, { action: "defaults" });
    t.eq(defaults.status, 200, defaults.raw);
    t.eq(defaults.json?.defaults?.autoArchiveBackfill, false, "UI defaults 必须展示默认关");
    const item = defaults.json?.configItems?.find((entry) => entry.key === "autoArchiveBackfill");
    t.ok(item, "UI 必须暴露 autoArchiveBackfill 配置项");
    t.includes(item?.desc, "默认关闭", "说明必须写默认关");
    t.includes(item?.desc, "真实使用 0 次", "说明必须写 T68 使用依据");
    t.includes(item?.desc, "$11.0546", "说明必须写已花费用");
    t.includes(item?.desc, "设为 false 关闭", "说明必须写怎么关");
    t.includes(item?.desc, "scripts/archive-fold.mjs --session <id> --write", "说明必须给手工补折入口");

    const state = await callApi(handler, { action: "state" });
    t.eq(state.status, 200, state.raw);
    t.eq(state.json?.config?.autoArchiveBackfill, false, "未配置时 UI 必须读到生效值 false");
    t.eq(state.json?.configOrigins?.autoArchiveBackfill, "default", "默认值来源必须是 default");
    t.eq(state.json?.unconfiguredKeys?.includes("autoArchiveBackfill"), true, "未配置列表必须包含新键");

    t.eq(ui.sanitizePatch({ autoArchiveBackfill: "true" }), { patch: { autoArchiveBackfill: true }, skipped: [] }, "UI 必须接受字符串 true 并规整成布尔");
    t.throws(() => ui.sanitizePatch({ autoArchiveBackfill: "yes" }), "非法布尔必须真红");

    const opened = ui.saveConfig({ autoArchiveBackfill: true }, { home });
    t.eq(opened.effectiveConfig.autoArchiveBackfill, true, "保存打开后必须回传生效值 true");
    t.includes(readEffective(presetFile), "autoArchiveBackfill: true", "打开必须真的写进隔离 preset");
    const reopened = parseEngineBlock(readEffective(presetFile));
    t.eq(ui.describeConfig(reopened.config).effective.autoArchiveBackfill, true, "UI 必须能读回 true");

    const closed = ui.saveConfig({ autoArchiveBackfill: false }, { home });
    t.eq(closed.effectiveConfig.autoArchiveBackfill, false, "重新关闭后必须回传生效值 false");
    const reread = parseEngineBlock(readEffective(presetFile));
    t.eq(reread.config.autoArchiveBackfill, false, "重新关闭必须真的写回 false");
  });
};
