/**
 * ui-home.test.mjs —— UI 半与引擎半「必须是同一个 DSH home」的回归（2026-11-07 真机）
 *
 * 真机事故：面板「上下文压缩」状态卡写「未启用 · 插件未安装或未接管」，而引擎正在正常折叠。
 * 根因不是压缩坏了，而是 **两半对 home 的回落不是同一个目录**：
 *
 *   · `src/engine.mjs:resolveHome`   → `DSH_HOME`（非空）→ 否则 `~/.dsh`
 *   · `src/ui.mjs:resolveHome`       → `DSH_HOME`（非空）→ 否则 `$USERPROFILE/DeepSeek Harness/home`
 *
 *   真机上 `~/.dsh` 存在（棋谱 / `build.json` / 心跳全在里面），
 *   而 `$USERPROFILE/DeepSeek Harness/home` **根本不存在**。
 *   ⇒ UI 半在空目录上做体检：`findPresetFiles()` 返回 `[]` ⇒ `health()` 报
 *     `installed:false · mounted:false · notInBundles:true` ⇒ 页面 pill 说「未启用」。
 *     同时 `state.today` 也全是 0（扫的是空 `chess-context/sessions`）。
 *
 *   最坏的地方是这个错**不会报错**：接口 200、JSON 合法、字段齐全，只有值在撒谎。
 *
 * 本文件钉住三件事（都不依赖真实 home / 真实进程）：
 *   ① 未设 `DSH_HOME` 时，UI 半的 home 必须与引擎半**逐字相同**（同源）；
 *   ② `DSH_HOME` 一旦设了就优先，且空串**不算设**（与引擎同规则）；
 *   ③ 一个「引擎写过的 home」拿去喂 `health()` 必须判 `installed:true · mounted:true`，
 *      不许再把装好的实例报成「未启用」。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(REPO, "tmp");
const PKG = "dsh-gokifu-compact";

/**
 * 引擎半的 home 规则（`src/engine.mjs:resolveHome` 的**行为快照**）。
 * 这里刻意重写一遍而不是 import：引擎半是 ESM 单例且带宿主依赖，
 * 而本用例要断言的是「两半保持一致」这件事本身 —— 两边都从文本里跑才不会自证。
 */
const ENGINE_RULE = () =>
  process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : nodePath.join(nodeOs.homedir(), ".dsh");

function mkFixture(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-uihome-${label}-`));
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

/**
 * 建一个「引擎真的写过东西」的 home：profile 声明了本包 + 一张棋谱 + 一个 build stamp。
 * 这就是真机 `~/.dsh` 的形状，只是缩到最小。
 */
function writeLiveHome(home) {
  const profileDir = nodePath.join(home, "profiles", "desktop");
  write(
    nodePath.join(profileDir, "package.json"),
    JSON.stringify(
      { name: "dsh-profile-desktop", private: true, dependencies: { [PKG]: "1.18.5" }, dsh: { profile: { bundles: [PKG] } } },
      null,
      2,
    ) + "\n",
  );
  // 本包自己的 bundle patch：声明了 preset ⇒ `findPresetFiles` 会把它当 preset 收进来。
  write(
    nodePath.join(profileDir, "node_modules", PKG, "cordis.patch.yml"),
    [
      "plugins:",
      "  - insert:",
      "      - id: gokifu-ui",
      `        name: '${PKG}'`,
      "  - insert:",
      "      - id: preset-standard",
      "        name: '@deepseek-ai/dsh-agent-preset'",
      "        config:",
      "          plugins:",
      "            - id: compaction",
      "              name: cordis:group",
      "              config:",
      "                - id: gokifu-compact",
      `                  name: '${PKG}/engine'`,
      "",
    ].join("\n"),
  );
  write(nodePath.join(home, "chess-context", "build.json"), JSON.stringify({ schema: "gokifu/build-stamp/v1", version: "1.18.5" }, null, 2) + "\n");
  write(
    nodePath.join(home, "chess-context", "sessions", "session-fixture", "graph.json"),
    JSON.stringify({ version: 1, sessionId: "session-fixture", nodes: [], edges: [] }, null, 2) + "\n",
  );
  return home;
}

/** 进程级环境变量的保存/还原（用例之间不许互相污染）。 */
function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

/** 每次都新 import 一份 ui.mjs：`resolveHome` 在模块作用域外，环境变量改动必须重新求值。 */
async function freshUi() {
  const url = pathToFileURL(nodePath.join(REPO, "src", "ui.mjs")).href;
  return import(`${url}?uihome=${Math.random()}`);
}

/**
 * 从 `ui.mjs` 源码里取 `resolveHome` 的实现文本 —— 用于「同源」的结构断言。
 * 这是**静态**那半：行为那半由下面的动态用例覆盖。两者都要，因为
 * 行为用例只能证明「当前环境两条相等」，结构断言能证明「不靠环境也一致」。
 */
function uiResolveHomeSource() {
  const text = nodeFs.readFileSync(nodePath.join(REPO, "src", "ui.mjs"), "utf8");
  const match = /function resolveHome\(\) \{[\s\S]*?\n\}/.exec(text);
  return match ? match[0] : null;
}

export const tests = {
  "① 未设 DSH_HOME 时，UI 半的 home 必须与引擎半逐字相同（不许再回落到 DeepSeek Harness/home）"(t) {
    return withEnv({ DSH_HOME: undefined }, async () => {
      const source = uiResolveHomeSource();
      t.eq(typeof source, "string", "src/ui.mjs 里必须有 resolveHome()");
      // 静态：旧的回落字面量不许再出现（它指向一个在真机上不存在的目录）
      t.notIncludes(source, "DeepSeek Harness", "resolveHome 不许回落到 `DeepSeek Harness/home`（该目录在真机上不存在）");
      t.includes(source, ".dsh", "resolveHome 的回落必须与引擎一致：`~/.dsh`");
      t.includes(source, "nodeOs.homedir()", "回落必须走 os.homedir()，不是 USERPROFILE 拼接");

      // 行为：真的把 UI 模块加载起来，比对两半算出来的字符串
      const ui = await freshUi();
      // ui.mjs 不导出 resolveHome（内部函数），用它的可观察出口反推：
      // `findPresetFiles()` 默认参数就是 `resolveHome()`，空 home 与真 home 的结果不可能相同。
      const uiDefaultHome = ui.findPresetFiles(undefined, "desktop");
      const expected = ENGINE_RULE();
      /**
       * 反推口径：`findPresetFiles(<引擎的 home>)` 必须与「不传 home」得到**同一个结果**。
       * 若 UI 半的默认 home 与引擎不同，这两次调用的输入就是两个不同目录，结果必然分叉。
       */
      const engineHome = ui.findPresetFiles(expected, "desktop");
      t.eq(
        uiDefaultHome.map((p) => p.file).sort(),
        engineHome.map((p) => p.file).sort(),
        `默认 home 必须等于引擎 home（${expected}）`,
      );
    });
  },

  "② DSH_HOME 一旦设了就优先；空串不算设（与引擎同规则）"(t) {
    const home = writeLiveHome(mkFixture("env"));
    return withEnv({ DSH_HOME: home }, async () => {
      try {
        const ui = await freshUi();
        t.eq(ui.findPresetFiles(undefined, "desktop").map((p) => p.name), [PKG], "设了 DSH_HOME 就必须读它");
        t.eq(ui.findPresetFiles(home, "desktop").map((p) => p.name), [PKG], "显式传 home 仍优先于环境");
      } finally {
        nodeFs.rmSync(home, { recursive: true, force: true });
      }
    }).then(() =>
      withEnv({ DSH_HOME: "" }, async () => {
        // 空串：引擎侧 `env && env.length > 0` ⇒ 视为没设，回落 ~/.dsh。
        // UI 侧必须同规则（旧写法 `process.env.DSH_HOME ?? ...` 会让空串**通过**并把 home 变成 `""`）。
        const source = uiResolveHomeSource();
        t.notIncludes(source, "??", "空串必须按「没设」处理：`??` 会让 `\"\"` 通过并把 home 变成空目录");
      }),
    );
  },

  /**
   * 这一条走**真实路由**（`POST /gokifu/api {action:"health"}`）而不是内部函数：
   * 用户看到的「未启用」pill 就是由这条请求的响应算出来的。
   * `health()` 本身不是导出，正好也借此证明「面板拿到的值」这一层是通的。
   */
  "③ 引擎写过的 home 走真实 /gokifu/api 体检，必须报 installed/mounted 为 true（不许把装好的报成「未启用」）"(t) {
    const home = writeLiveHome(mkFixture("health"));
    return withEnv({ DSH_HOME: home, DSH_GOKIFU_NO_HEAL: "1" }, async () => {
      try {
        const ui = await freshUi();
        const routes = [];
        ui.apply({
          webServer: { register: (route) => (routes.push(route), () => {}), host: "127.0.0.1" },
          effect: (fn) => fn(),
          get: () => undefined,
        });
        t.eq(routes.length, 1, "必须注册一条 /gokifu/api 路由");

        const response = await callRoute(routes[0].handler, { action: "health" });
        t.eq(response.status, 200, "体检接口必须是 200");
        t.eq(response.json.ok, true);

        const health = response.json.health ?? {};
        t.eq(health.profile, "desktop", "读的必须是 desktop profile");
        t.eq(health.installed, true, "profile 依赖里有本包 ⇒ installed 必须是 true（旧代码在这里说 false）");
        t.eq(health.mounted, true, "进了 dsh.profile.bundles ⇒ mounted 必须是 true");
        t.eq(health.notInBundles, false, "已进 bundles ⇒ notInBundles 必须是 false");
        t.eq(health.singleInstance, true, "该 patch 里没有 compaction-basic ⇒ 单实例");
        t.includes(
          (health.presets ?? []).map((p) => p.name).join(","),
          PKG,
          "presets 里必须能看到本包自己（旧代码这里是空数组）",
        );
      } finally {
        nodeFs.rmSync(home, { recursive: true, force: true });
      }
    });
  },
};

/** 直接喂给路由 handler 的假 req/res（与 test/backfill-button.test.mjs 同一套做法）。 */
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
