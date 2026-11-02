/**
 * ui.test.mjs —— 详情页的两半：preset 块读写（host）+ 客户端 bundle 的注册形状
 *
 * 覆盖的都是「静默出错」面：
 *   · 块解析/渲染一旦丢值，页面上显示的配置就和实际生效的不一致
 *   · sanitizePatch 一旦放过非法值，引擎会在构造期抛错（整个 preset generation 挂掉）
 *   · 客户端 bundle 一旦不是 `window.__ModuleLoader__.load` 形状，页面根本不会出现
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const require = createRequire(pathToFileURL(nodePath.join(ROOT, "package.json")));

const installMod = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "install.mjs")).href);
const { parseEngineBlock, renderEngineBlock, PKG_NAME, ENTRY_ID } = installMod;

function tempHome() {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-ui-"));
  nodeFs.mkdirSync(nodePath.join(dir, "preset-bundles", "personal-assistant"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "profiles", "desktop", "node_modules"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  return dir;
}

const SAMPLE = [
  "- insert:",
  "    - id: preset-personal-assistant",
  "      name: '@deepseek-ai/dsh-agent-preset'",
  "      config:",
  "        plugins:",
  "          - id: compaction",
  "            name: cordis:group",
  "            group: true",
  "            config:",
  "              # ★ 旧注释",
  "              - id: gokifu-compact",
  `                name: '${PKG_NAME}/engine'`,
  "                config:",
  "                  auto: true                # 注释",
  "                  thresholdRatio: 0.45",
  "                  summaryMode: hybrid",
  "                  summarizationModel: ''",
  "              - id: command-compact",
  "                name: '@deepseek-ai/dsh-command-compact'",
  "",
].join("\n");

export const tests = {
  "parseEngineBlock：读到缩进/配置，块边界止于下一个同级条目": async () => {
    const parsed = parseEngineBlock(SAMPLE);
    if (parsed === null) throw new Error("没解析到块");
    if (parsed.indent !== "              ") throw new Error(`缩进错：${JSON.stringify(parsed.indent)}`);
    if (parsed.config.thresholdRatio !== 0.45) throw new Error("thresholdRatio 没读到");
    if (parsed.config.summaryMode !== "hybrid") throw new Error("summaryMode 没读到");
    if (parsed.config.summarizationModel !== "") throw new Error("空字符串没解析成空串");
    if (parsed.config.auto !== true) throw new Error("布尔没解析");
    if (parsed.raw.includes("command-compact")) throw new Error("块尾越界，吃到了下一个条目");
  },

  "renderEngineBlock：值原样回写、名字带 /engine、可再解析": async () => {
    const parsed = parseEngineBlock(SAMPLE);
    const rendered = renderEngineBlock({ ...parsed.config, thresholdRatio: 0.6 }, parsed.indent);
    if (!rendered.includes(`name: '${PKG_NAME}/engine'`)) throw new Error("没有写 /engine 名字");
    const next = SAMPLE.replace(parsed.raw, rendered);
    const again = parseEngineBlock(next);
    if (again.config.thresholdRatio !== 0.6) throw new Error(`回读失败：${again.config.thresholdRatio}`);
    if (again.config.auto !== true) throw new Error("布尔回写丢失");
    if (!next.includes("command-compact")) throw new Error("替换把后面的条目吃掉了");
  },

  "sanitizePatch：拦住越界与非法枚举，未知键跳过": async () => {
    const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
    const { patch, skipped } = uiMod.sanitizePatch({ thresholdRatio: 0.5, hotLedger: false, bogus: 1 });
    if (patch.thresholdRatio !== 0.5) throw new Error("合法值被丢");
    if (patch.hotLedger !== false) throw new Error("布尔被丢");
    if (!skipped.includes("bogus")) throw new Error("未知键没有跳过");
    let threw = false;
    try {
      uiMod.sanitizePatch({ thresholdRatio: 2 });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("越界值没被拒");
    threw = false;
    try {
      uiMod.sanitizePatch({ summaryMode: "nope" });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("非法枚举没被拒");
  },

  "saveConfig：写回 preset、留备份、同值不重复写": async () => {
    const home = tempHome();
    const preset = nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml");
    nodeFs.writeFileSync(preset, SAMPLE, "utf8");
    const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
    const result = uiMod.saveConfig({ thresholdRatio: 0.33 }, { home });
    if (result.changed.length !== 1) throw new Error(`应当写 1 个文件，得到 ${result.changed.length}`);
    if (!result.backup || !nodeFs.existsSync(result.backup)) throw new Error("没有备份");
    const text = nodeFs.readFileSync(preset, "utf8");
    if (!text.includes("thresholdRatio: 0.33")) throw new Error("新值没写进去");
    if (!text.includes("command-compact")) throw new Error("写回吃掉了后面的条目");
    const again = uiMod.saveConfig({ thresholdRatio: 0.33 }, { home });
    if (again.changed.length !== 0) throw new Error("同值不应再次写盘");
  },

  "客户端 bundle：是 __ModuleLoader__ 形状，apply 注册 sidebar.panellist + main": async () => {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, "lib", "client.js"), "utf8");
    let loaded = null;
    const fakeWindow = { __ModuleLoader__: { load: (row) => (loaded = row) } };
    // 客户端 bundle 是 classic script（不是 ESM）：用 Function 求值，只注入 window
    const fn = new Function("window", src);
    fn(fakeWindow);
    if (loaded === null) throw new Error("没有调用 __ModuleLoader__.load");
    if (loaded.id !== PKG_NAME) throw new Error(`模块 id 应为包名，得到 ${loaded.id}`);
    const react = {
      createElement: (...args) => ({ args }),
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    };
    const mod = loaded.factory((spec) => {
      if (spec === "react") return react;
      throw new Error(`意外 require(${spec})`);
    });
    if (typeof mod.apply !== "function") throw new Error("没有导出 apply");
    const registered = [];
    const ctx = { slots: { inject: (_slot, fn) => fn(), register: (options, component) => registered.push({ options, component }) } };
    mod.apply(ctx);
    const names = registered.map((r) => r.options.name);
    if (!names.includes("sidebar.panellist")) throw new Error(`没注册侧栏条目：${names.join(",")}`);
    if (!names.includes("main")) throw new Error(`没注册页面：${names.join(",")}`);
    const panel = registered.find((r) => r.options.name === "sidebar.panellist");
    const page = registered.find((r) => r.options.name === "main");
    if (panel.options.id !== page.options.key) throw new Error("侧栏 id 与页面 key 不一致（点了不会跳转）");
    if (typeof panel.component !== "function" || typeof page.component !== "function") throw new Error("组件不是函数");
  },
};

tests["host 路由：POST /gokifu/api 返回 state（含 config/health/today）"] = async () => {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
  const routes = [];
  const ctx = { webServer: { register: (route) => (routes.push(route), () => {}) }, effect: (fn) => fn() };
  uiMod.apply(ctx);
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  const route = routes[0];
  if (route.path !== "/gokifu/api") throw new Error(`路由路径错：${route.path}`);
  if (route.kind !== "prefix") throw new Error(`路由种类错：${route.kind}`);
  const handler = route.handler;
  const home = tempHome();
  nodeFs.writeFileSync(nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml"), SAMPLE, "utf8");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const call = (body) =>
      new Promise((resolve, reject) => {
        const req = {
          method: "POST",
          // 2026-10-30 CSRF 加固后：POST 必须带 JSON content-type，Host 必须是回环地址。
          // 这里模拟的正是 lib/client.js 在真机里的请求形状（同源 fetch + application/json）。
          headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
          on: (event, cb) => {
            if (event === "data") cb(Buffer.from(JSON.stringify(body)));
            if (event === "end") cb();
          },
        };
        const res = {
          status: 0,
          writeHead(status) {
            this.status = status;
          },
          end(text) {
            resolve({ status: this.status, json: JSON.parse(text) });
          },
        };
        Promise.resolve(handler(req, res)).catch(reject);
      });
    const state = await call({ action: "state" });
    if (state.status !== 200) throw new Error(`state 状态码 ${state.status}`);
    if (state.json.ok !== true) throw new Error("state 没返回 ok");
    if (state.json.config.thresholdRatio !== 0.45) throw new Error("state 没带配置");
    if (state.json.configFile === null) throw new Error("state 没带配置文件路径");
    const bad = await call({ action: "nope" });
    if (bad.status !== 400) throw new Error(`未知 action 应 400，得到 ${bad.status}`);
    const saved = await call({ action: "save", patch: { thresholdRatio: 0.55 } });
    if (saved.json.ok !== true) throw new Error(`save 失败：${JSON.stringify(saved.json)}`);
    if (!saved.json.restartRequired) throw new Error("save 没提示需要重启");
    const text = nodeFs.readFileSync(nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml"), "utf8");
    if (!text.includes("thresholdRatio: 0.55")) throw new Error("save 没写进文件");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
};

tests["C232 面板的「已修正失败」与 doctor 同口径（同 action 后来跑通才算）"] = async (t) => {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
  const now = Date.now();
  const edge = (over) => ({
    id: "e1", from: "n1", to: "n2", intent: "x", action: "bash(npm test)", result: "failure",
    evidence: { start: 1, end: 2 }, ts: now, ...over,
  });
  const g = {
    nodes: { n1: {}, n2: {} },
    edges: {
      a: edge({ id: "a", action: "bash(npm test)", result: "failure", evidence: { start: 1, end: 2 } }),
      b: edge({ id: "b", action: "bash(npm test)", result: "success", evidence: { start: 5, end: 6 } }),   // 后来跑通 ⇒ a 算已修正
      c: edge({ id: "c", action: "bash(npm run lint)", result: "failure", evidence: { start: 7, end: 8 } }), // 没有后续 success ⇒ 不算
      d: edge({ id: "d", action: "bash(npm test)", result: "success", evidence: { start: 3, end: 4 } }),   // 在 a 之前 ⇒ 不救 a
    },
  };
  t.eq(uiMod.countResolvedFailures(g), 1, "只有 a 被后来的成功救回");
  t.eq(uiMod.countResolvedFailures(null), 0, "坏输入不许抛，返回 0");
  t.eq(uiMod.countResolvedFailures({ edges: {} }), 0, "空图返回 0");
};

tests["C239 折叠成本估算：价格口径（命中/未命中/输出）与「没数据不编 0」"] = async (t) => {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
  const est = uiMod.estimateFoldCostUsd;
  // 官方价（低峰）：未命中 0.15 / 命中 0.003 / 输出 0.6 每 1M
  t.eq(Math.abs(est({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }) - 0.15) < 1e-9, true, "100 万未命中 = $0.15");
  t.eq(Math.abs(est({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 }) - 0.003) < 1e-9, true, "100 万全命中 = $0.003");
  t.eq(Math.abs(est({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }) - 0.6) < 1e-9, true, "100 万输出 = $0.6");
  // 实测形态：input 231k（其中命中 16k）+ 输出 1k
  const real = est({ inputTokens: 231443, cacheReadTokens: 16384, outputTokens: 1072 });
  t.eq(real > 0.03 && real < 0.04, true, `一次真实 fold 应落在 3~4 美分（实际 ${real}）`);
  t.eq(est(null), null, "没有 usage ⇒ null（页面显示 —，不许编 0）");
  t.eq(est({ cacheReadTokens: 100 }), null, "缺 inputTokens ⇒ null");
  t.eq(est({ inputTokens: 100, cacheReadTokens: 999 }), est({ inputTokens: 100, cacheReadTokens: 100 }), "命中数不许超过输入（夹紧）");
};

tests["C282 图缓存必须 LRU 淘汰，不许「满了就全清」（那是一次缓存雪崩）"] = async (t) => {
  const uiMod = await import(pathToFileURL(nodePath.join(HERE, "..", "src", "ui.mjs")).href);
  t.eq(typeof uiMod.lruSet, "function", "必须导出 lruSet（可单测）");

  // ① 超过上限只淘汰最久未用的一条，不是清空
  const map = new Map();
  for (let i = 0; i < 5; i += 1) uiMod.lruSet(map, `k${i}`, i, 3);
  t.eq([...map.keys()], ["k2", "k3", "k4"], `插入 5 条上限 3 ⇒ 只留最近 3 条：${[...map.keys()]}`);

  // ② 命中续命：被访问过的条目不该被后来的挤掉
  uiMod.lruSet(map, "k2", 2, 3); // k2 变成最新
  uiMod.lruSet(map, "k5", 5, 3); // 该淘汰 k3（最久未用）
  t.eq([...map.keys()], ["k4", "k2", "k5"], `命中的条目必须续命：${[...map.keys()]}`);

  // ③ 值被更新（同 key 覆盖）而不是重复插入
  t.eq(map.get("k2"), 2, "同 key 覆盖值");
  t.eq(map.size, 3, "size 不许超上限");

  // ④ 接线断言：graphSummary 命中时必须调 lruSet（否则热条目会被冷条目挤掉）
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "ui.mjs"), "utf8");
  t.includes(src, "lruSet(GRAPH_CACHE, entry.file, cached)", "命中路径必须续命");
  t.eq(src.includes("GRAPH_CACHE.clear()"), false, "不许再有「满了全清」");
};

tests["C345 折叠成本必须按**实际模型**计价：pro 比 flash 贵 3.3–4.4 倍"] = async (t) => {
  const { estimateFoldCostUsd, priceForModel, PRICE_USD_PER_MTOK, MODEL_PRICES_USD_PER_MTOK } = await import("../src/ui.mjs");
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 100_000 };

  const flash = estimateFoldCostUsd(usage, "deepseek-flash");
  const pro = estimateFoldCostUsd(usage, "deepseek-v4-pro");
  t.eq(pro > flash, true, "pro 必须比 flash 贵");
  // 手算 flash：(500k miss×0.15 + 500k hit×0.003 + 100k out×0.6)/1M = 0.075+0.0015+0.06
  t.eq(Math.abs(flash - 0.1365) < 1e-9, true, `flash 手算应为 0.1365，实际 ${flash}`);
  t.eq(Math.abs(pro - 0.539) < 1e-9, true, `pro 手算应为 0.539，实际 ${pro}`);

  // 认不出 / 不传模型 ⇒ 回落 flash（下限估算），且要能看出"没匹配上"
  t.eq(priceForModel("some-other-model").matched, false, "认不出必须标 matched=false");
  t.eq(priceForModel(undefined).miss, PRICE_USD_PER_MTOK.miss, "不传模型回落 flash");
  t.eq(priceForModel("deepseek-v4-pro").out, 1.98, "pro 输出价 1.98");
  // 两张表都要有出处
  t.eq(MODEL_PRICES_USD_PER_MTOK["deepseek-v4-pro"].miss, 0.66, "pro miss 0.66");
};

tests["C346 成本聚合必须按每个 fold 自己的模型计价（usage 里带了 model 才可能）"] = async (t) => {
  const { estimateFoldCostUsd } = await import("../src/ui.mjs");
  // 同一个 usage，除了 model 之外完全相同 —— 两条价格必须不同
  const base = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 };
  const flash = estimateFoldCostUsd({ ...base, model: "deepseek-flash" });
  const pro = estimateFoldCostUsd({ ...base, model: "deepseek-v4-pro" });
  t.eq(Math.abs(flash - 0.15) < 1e-9, true, `flash miss 1M = 0.15，实际 ${flash}`);
  t.eq(Math.abs(pro - 0.66) < 1e-9, true, `pro miss 1M = 0.66，实际 ${pro}`);
  t.eq(pro > flash * 4, true, "pro 至少是 flash 的 4 倍（低报 4 倍就是这么来的）");

  // 引擎必须把模型写进 usage（否则估价永远回落 flash）
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const engine = nodeFs.readFileSync(nodePath.join(here, "..", "src", "engine.mjs"), "utf8");
  t.includes(engine, "model: this._lastSummaryModel ?? null", "usage 里必须写 model（C346）");
  t.includes(engine, "provider: this._lastSummaryProvider ?? null", "usage 里也要写 provider");
};

tests["C361 真机 usage 的 inputTokens 是「未命中」：成本必须按 miss+hit+out 算"] = async (t) => {
  const { estimateFoldCostUsd } = await import("../src/ui.mjs");
  // 真机样本（会话文件里抓的）：inputTokens 只含未命中，total = miss + hit + out
  const real = { inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: 19584 };
  const got = estimateFoldCostUsd(real, "deepseek-flash");
  // 手算：(2158×0.15 + 19584×0.003 + 257×0.6)/1e6 = (323.7+58.752+154.2)/1e6
  const want = (2158 * 0.15 + 19584 * 0.003 + 257 * 0.6) / 1e6;
  t.eq(Math.abs(got - want) < 1e-9, true, `应得 ${want}，实际 ${got}`);

  // 旧口径（input 含 hit，没有 totalTokens）不能被打破
  const legacy = { inputTokens: 10000, outputTokens: 500, cacheReadTokens: 9000 };
  const legacyCost = estimateFoldCostUsd(legacy, "deepseek-flash");
  const legacyWant = (1000 * 0.15 + 9000 * 0.003 + 500 * 0.6) / 1e6;
  t.eq(Math.abs(legacyCost - legacyWant) < 1e-9, true, `老口径应得 ${legacyWant}，实际 ${legacyCost}`);

  // total 对不上（既不是 miss+hit+out）⇒ 退回老口径，不许瞎猜
  const weird = { inputTokens: 1000, outputTokens: 10, totalTokens: 999999, cacheReadTokens: 400 };
  const weirdCost = estimateFoldCostUsd(weird, "deepseek-flash");
  const weirdWant = (600 * 0.15 + 400 * 0.003 + 10 * 0.6) / 1e6;
  t.eq(Math.abs(weirdCost - weirdWant) < 1e-9, true, `total 不可信时退回老口径：${weirdWant} vs ${weirdCost}`);
};

tests["C372 路由自愈：ensureUiRoute 存在、无 webServer 时安全返回 false、引擎真的会调"] = async (t) => {
  const ui = await import("../src/ui.mjs");
  t.eq(typeof ui.ensureUiRoute, "function", "必须导出 ensureUiRoute");
  // 没有 webServer 的进程（真机见过的"插件被加载进非 UI 进程"）⇒ 安全返回 false，不抛
  t.eq(ui.ensureUiRoute({}), false, "没有 webServer 时返回 false");
  t.eq(ui.ensureUiRoute(null), false, "null ctx 也不能抛");

  // 说明：这里**不**用假 ctx 跑完整 apply —— apply 会读 profile/模型目录，
  // 在夹具里必然抛错，测出来的只会是"apply 抛了"而不是"幂等"。幂等由模块级开关实现，
  // 这里改为断言**接线**：引擎必须在 pre-step 里尝试自愈。
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const engine = nodeFs.readFileSync(nodePath.join(here, "..", "src", "engine.mjs"), "utf8");
  t.includes(engine, "ensureUiRoute?.(this.ctx)", "引擎必须在 pre-step 尝试自愈（C372）");
  const uiSrc = nodeFs.readFileSync(nodePath.join(here, "..", "src", "ui.mjs"), "utf8");
  t.includes(uiSrc, "let uiRouteRegistered = false", "必须有模块级幂等开关");
  t.includes(uiSrc, "uiRouteRegistered = false;", "dispose 后必须重置开关（否则再也装不回来）");
};

tests["C380 初始化失败必须留一条兜底路由（面板要能回答「我为什么坏了」）"] = async (t) => {
  const ui = await import("../src/ui.mjs");
  t.eq(typeof ui.registerFallbackRoute, "function", "必须导出 registerFallbackRoute");

  let registered = null;
  const ctx = {
    webServer: { register: (route) => { registered = route; return () => {}; } },
    effect: (fn) => { fn(); },
  };
  t.eq(ui.registerFallbackRoute(ctx, new Error("boom")), true, "应当注册成功");
  t.eq(!!registered, true, "必须真的调用了 register");
  t.eq(registered.path, "/gokifu/api", "路径必须是面板的 /gokifu/api");
  t.eq(registered.kind, "prefix", "用 prefix 匹配");

  // 兜底路由的响应：500 + 错误摘要（人能看懂）
  let code = null;
  let body = "";
  const res = { writeHead: (c) => { code = c; }, end: (b) => { body = b; } };
  await registered.handler({ method: "POST" }, res);
  t.eq(code, 500, "必须回 500（而不是 404/405）");
  t.includes(body, "面板初始化失败", "要说明是初始化失败");
  t.includes(body, "boom", "要带出原始错误摘要");

  // 没有 webServer 的进程：安全返回 false
  t.eq(ui.registerFallbackRoute({}, new Error("x")), false, "没有 webServer 不抛，返回 false");
};
