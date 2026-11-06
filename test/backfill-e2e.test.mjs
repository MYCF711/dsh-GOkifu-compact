/**
 * backfill-e2e.test.mjs —— **端到端**：定时器那条路真的能把欠账折掉
 *
 * 为什么单独一个文件（C598）：真机三次重启都在猜（名额/截止/预算），因为
 *   · `#autoBackfillTick` 是私有的，没有测试能端到端跑到它；
 *   · `chunks.length === 0` 时引擎直接 return，图上一个字段都不写。
 * 现在有公开入口 `runAutoBackfillOnce()` ⇒ 用**合成 target**（`{id, cwd}`，与 tick 生产形状一致）
 * 走完整条路：挑人 → 离线补折 → 写 foldMark + closeout → 落状态文件。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const harness = async () => await import(pathToFileURL(nodePath.join(process.cwd(), "test", "engine-harness.test.mjs")).href);

export const tests = {};

tests["C598 自动补账端到端：合成 target 也能真的折出 foldMark"] = async (t) => {
  const { load, makeCtx } = await harness();
  const { Engine } = await load();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bf-e2e-"));
  const sid = "bf-e2e";
  // ① 会话日志（离线补折唯一的数据源）
  const logDir = nodePath.join(home, "sessions", "--ws--", `session-${sid}`);
  nodeFs.mkdirSync(logDir, { recursive: true });
  const events = [];
  for (let i = 1; i <= 200; i += 1) {
    events.push({ seq: i, type: i % 2 ? "user/message" : "assistant/message", data: { message: { content: [{ type: "text", text: `第 ${i} 步：把构建跑通` }] } } });
  }
  nodeFs.writeFileSync(
    nodePath.join(logDir, "session.v4.jsonl.zstd"),
    zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10))),
  );
  // ①b 把日志"做旧"：tick 会跳过 5 分钟内还在写的活会话（那是宿主内存里的图）
  const old = (Date.now() - 10 * 60_000) / 1000;
  nodeFs.utimesSync(nodePath.join(logDir, "session.v4.jsonl.zstd"), old, old);
  // ② 默认模型（离线补折要解析 provider/model）
  const prof = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(prof, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(prof, "cordis.patch.yml"), ["- id: agent-default-model", "  provider: mock", "  model: mock-model", ""].join(String.fromCharCode(10)));
  // ③ 棋谱：一条约束 + 一个尾巴
  const graphDir = nodePath.join(home, "chess-context");
  const gdir = nodePath.join(graphDir, "sessions", sid);
  nodeFs.mkdirSync(gdir, { recursive: true });
  const now = Date.now();
  nodeFs.writeFileSync(
    nodePath.join(gdir, "graph.json"),
    JSON.stringify({
      version: 1,
      rootUserNodeIds: ["n1"],
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "把构建跑通", constraints: ["不许动 prod 配置"], ts: now },
        n2: { id: "n2", kind: "agent", seq: 200, text: "末", ts: now },
      },
      edges: {},
      order: ["n1", "n2"],
      foldMarks: [],
      updatedAt: now,
    }),
  );
  // ④ 模型桩：必须是**异步生成器**（引擎是 for await）
  const ctx = makeCtx();
  ctx.llm.stream = async function* () {
    yield {
      type: "text-delta",
      text: [
        "## 目标",
        "- 把构建跑通",
        "## 约束",
        "- 不许动 prod 配置",
        "## 棋谱（状态节点）",
        "- n1 → n2：跑通构建",
        "## 已探明死路",
        "- 无",
        "## 已建立事实",
        "- 构建可通过",
        "## 当前节点",
        "- n2（200 步完成）",
      ].join(String.fromCharCode(10)),
    };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 } };
  };
  // ⑤ 模拟**后台 job 的真实处境**：`ctx.llm` 在两个回合之间是 inactive 的
  //   （真机：`Error: cannot get required service "llm" in inactive context`）
  //   ⇒ 必须自动回退到本地网关 HTTP 直连（C599）。
  let httpCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    httpCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!String(url).includes("/chat/completions")) throw new Error(`unexpected url ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                "## 目标",
                "- 把构建跑通",
                "## 约束",
                "- 不许动 prod 配置",
                "## 当前节点",
                "- n2（200 步完成）",
              ].join(String.fromCharCode(10)),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 80 },
        model: body.model,
      }),
    };
  };
  ctx.llm.stream = async function* () {
    yield {
      type: "text-delta",
      text: ["## 目标", "- 把构建跑通", "## 约束", "- 不许动 prod 配置", "## 当前节点", "- n2（200 步完成）"].join(String.fromCharCode(10)),
    };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 } };
  };
  const engine = new Engine(ctx, { graphDir, auto: false, closeoutMinEvents: 10 });
  const r = await engine.runAutoBackfillOnce();
  t.eq(r.ok, true, "一轮补账不许抛");
  const g = JSON.parse(nodeFs.readFileSync(nodePath.join(gdir, "graph.json"), "utf8"));
  const marks = (g.foldMarks ?? []).filter((m) => m.trigger === "archive-offline");
  t.eq(marks.length >= 1, true, `必须真的折出 archive-offline（实际 ${marks.length} 段）`);
  t.eq(Number(g.closeout?.folded) > 0, true, "closeout 要记折了几段");
  const stateFile = nodePath.join(graphDir, "auto-backfill-state.json");
  t.eq(nodeFs.existsSync(stateFile), true, "必须写状态文件（否则零产出与没跑过无法区分）");
  const state = JSON.parse(nodeFs.readFileSync(stateFile, "utf8"));
  t.eq(Array.isArray(state.results) && state.results.length >= 1, true, "状态文件要有每个会话的结局");
  t.eq(state.results.every((x) => x.error === null || x.error === undefined), true, "结局里不许有 error");
  globalThis.fetch = realFetch;
  // ★ C600：**不许直连网关端口**（C500 红线）—— 这条守卫改成"一张 fetch 都不许打"
  t.eq(httpCalls, 0, `不许直连网关（实际打了 ${httpCalls} 次）`);
  nodeFs.rmSync(home, { recursive: true, force: true });
};
