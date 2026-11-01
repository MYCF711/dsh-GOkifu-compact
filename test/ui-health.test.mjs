/**
 * ui-health.test.mjs —— UI 自检（`POST /gokifu/api {"action":"health"}`）**不再写死 profile=desktop**（W-D）
 *
 * 为什么要有这个文件：W-C 在真实测试实例上实测到的假红 —— 测试 home 的 profile 叫 `web`，
 * 插件明明装好并进了 `dsh.profile.bundles`，health 自检却返回 `installed:false, notInBundles:true`。
 * 根因是 `src/ui.mjs` 的 `health()` 把 profile 名写死成 `desktop`（而 `findPresetFiles` 早已支持 profile 参数）。
 * 「装了没反应」排障第一眼看的就是这个接口 —— 它说假话的代价很高，所以这里把它钉死。
 *
 * 覆盖：
 *   ① 默认 profile=desktop 装好 ⇒ installed:true / notInBundles:false
 *   ② **非默认 profile=web** 同样装好 ⇒ 也必须 true（旧实现会读 desktop ⇒ 假红；这条就是回归的核心）
 *   ③ profile 不存在 / package.json 坏 ⇒ installed:false 且不抛（health 是自检，不许 500）
 *   ④ 返回体带出实际用的 profile（显式传入 / 缺省 desktop / 非法名回落 desktop）
 *   ⑤ `state` 动作的 health 也按同一 profile 口径（可选字段；不传时行为与旧版一致）
 *
 * 夹具全部建在仓库 `tmp/` 下（已 gitignore），每条用例 finally 清理；不启动 DSH、不碰真实 home。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PKG_NAME } from "../scripts/install.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(ROOT, "tmp");
const PKG = PKG_NAME;
const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };

/* ───────────────────────── 夹具 ───────────────────────── */

function mkHome(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-ui-health-${label}-`));
}

function cleanup(home) {
  nodeFs.rmSync(home, { recursive: true, force: true });
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

/**
 * 造一个「装好了」的 profile：依赖里有本包 + `dsh.profile.bundles` 含本包。
 * @param {string} home
 * @param {string} profile
 * @param {{installed?:boolean, inBundles?:boolean, badJson?:boolean}} [options]
 */
function writeProfile(home, profile, { installed = true, inBundles = true, badJson = false } = {}) {
  const profileDir = nodePath.join(home, "profiles", profile);
  nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
  const file = nodePath.join(profileDir, "package.json");
  if (badJson) {
    write(file, "{ 这不是合法 JSON\n");
    return profileDir;
  }
  const pkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: installed ? { [PKG]: "link:D:/fixture/dsh-gokifu-compact" } : {},
    dsh: { profile: { bundles: inBundles ? [PKG] : [] } },
  };
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return profileDir;
}

/** 挂一次真实的 host 路由（与 ui-config.test.mjs 同法：不启动 DSH）。 */
async function mount() {
  const uiMod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-health=${Math.random()}`);
  const routes = [];
  uiMod.apply({ webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" }, effect: (fn) => fn() });
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
        let json = null;
        try {
          json = JSON.parse(this.raw);
        } catch {
          json = null;
        }
        resolve({ status: this.status, json });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把 DSH_HOME 指向夹具跑一段逻辑，结束后逐字还原（不污染别的用例）。 */
async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

export const tests = {
  async "① 默认 profile=desktop：依赖 + bundles 都装好 ⇒ installed:true、notInBundles:false"(t) {
    const home = mkHome("desktop");
    try {
      writeProfile(home, "desktop");
      return await withHome(home, async () => {
        const handler = await mount();
        const { status, json } = await call(handler, { action: "health" });
        t.eq(status, 200, "健康自检必须 200");
        t.eq(json?.ok, true, "ok 应为 true");
        t.eq(json?.health?.installed, true, `装好了必须报 installed:true：${JSON.stringify(json?.health)}`);
        t.eq(json?.health?.notInBundles, false, "已在 dsh.profile.bundles ⇒ notInBundles:false");
        t.eq(json?.health?.profile, "desktop", "缺省 profile 应是 desktop");
      });
    } finally {
      cleanup(home);
    }
  },

  async "② 非默认 profile=web：同样装好也必须 installed:true（旧实现读死 desktop ⇒ 这条必红）"(t) {
    const home = mkHome("web");
    try {
      // 只有 profiles/web —— 没有 profiles/desktop（旧实现会去读它，然后报未装）
      writeProfile(home, "web");
      return await withHome(home, async () => {
        const handler = await mount();
        const { status, json } = await call(handler, { action: "health", profile: "web" });
        t.eq(status, 200, "非默认 profile 的健康自检也必须 200");
        t.eq(
          json?.health?.installed,
          true,
          `profile=web 已装好，自检不许再说未装（旧实现假红现场）：${JSON.stringify(json?.health)}`,
        );
        t.eq(json?.health?.notInBundles, false, "web 的 bundles 里已有本包 ⇒ notInBundles:false");
        t.eq(json?.health?.profile, "web", "返回体必须带出实际用的 profile");
      });
    } finally {
      cleanup(home);
    }
  },

  async "③ profile 不存在 / package.json 坏 JSON ⇒ installed:false 且不抛（200，不是 500）"(t) {
    const missingHome = mkHome("missing");
    const brokenHome = mkHome("broken");
    try {
      writeProfile(brokenHome, "web", { badJson: true });
      return await (async () => {
        const handler = await mount();
        const missing = await withHome(missingHome, () => call(handler, { action: "health", profile: "ghost" }));
        t.eq(missing.status, 200, "profile 不存在也要 200（自检不许抛）");
        t.eq(missing.json?.ok, true, "ok 仍为 true");
        t.eq(missing.json?.health?.installed, false, "profile 不存在 ⇒ installed:false（不是抛错）");
        t.eq(missing.json?.health?.notInBundles, true, "读不到 bundles ⇒ notInBundles:true");
        const broken = await withHome(brokenHome, () => call(handler, { action: "health", profile: "web" }));
        t.eq(broken.status, 200, "package.json 坏 JSON 也要 200");
        t.eq(broken.json?.health?.installed, false, "坏 JSON ⇒ installed:false（不抛）");
        t.eq(broken.json?.health?.notInBundles, true, "坏 JSON ⇒ notInBundles:true");
      })();
    } finally {
      cleanup(missingHome);
      cleanup(brokenHome);
    }
  },

  async "④ 返回体带出实际用的 profile：显式传入就用它 / 缺省 desktop / 非法名回落 desktop（且不能穿越出 home）"(t) {
    const home = mkHome("profile-field");
    try {
      writeProfile(home, "web");
      return await withHome(home, async () => {
        const handler = await mount();
        const web = await call(handler, { action: "health", profile: "web" });
        t.eq(web.json?.profile, "web", "health 响应顶层必须带 profile");
        t.eq(web.json?.health?.profile, "web", "health 对象里也要带 profile");
        const dflt = await call(handler, { action: "health" });
        t.eq(dflt.json?.profile, "desktop", "不传 profile 时缺省 desktop（向后兼容）");
        const evil = await call(handler, { action: "health", profile: "../../../etc" });
        t.eq(evil.json?.profile, "desktop", "含路径分隔符的非法 profile 名必须回落 desktop（防路径穿越）");
        t.eq(evil.status, 200, "非法 profile 名不抛错，按 desktop 兜底");
      });
    } finally {
      cleanup(home);
    }
  },

  async "⑤ state 动作的 health 也按同一 profile 口径（可选字段；不传时与旧版一致）"(t) {
    const home = mkHome("state");
    try {
      writeProfile(home, "web");
      return await withHome(home, async () => {
        const handler = await mount();
        const web = await call(handler, { action: "state", profile: "web" });
        t.eq(web.status, 200, "state 必须 200");
        t.eq(web.json?.profile, "web", "state 响应也应带出 profile");
        t.eq(web.json?.health?.installed, true, `state 的 health 也必须用 web 口径：${JSON.stringify(web.json?.health)}`);
        t.eq(web.json?.health?.notInBundles, false, "state 的 health 也要认 web 的 bundles");
        const dflt = await call(handler, { action: "state" });
        t.eq(dflt.json?.profile, "desktop", "state 不传 profile 时缺省 desktop（旧行为不变）");
      });
    } finally {
      cleanup(home);
    }
  },
};
