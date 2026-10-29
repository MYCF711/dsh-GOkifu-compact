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
