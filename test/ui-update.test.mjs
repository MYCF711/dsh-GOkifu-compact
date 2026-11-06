/**
 * ui-update.test.mjs —— 面板「检查更新」（U5）：当前版本 / 最新版本 / 有无新版 / 升级命令
 *
 * 架构前提：面板只**报告**，不**安装**。升级要改 `profiles/<profile>/package.json`
 * （`dsh plugin --profile … add`），装完还得重载宿主 —— 那是人的动作。
 * 所以这里的全部工作就是：读 registry 的 `dist-tags/latest`、按**语义化版本**比一次、
 * 拼出命令、**10 分钟内存缓存**。本文件同时钉住「不联网也能测」：fetch 全部注入。
 *
 * 覆盖：
 *   ① registry 有新版本 ⇒ `hasUpdate:true` + 命令里的版本正确；`state` 首屏**不发网络**
 *   ② registry 与本地同版本 ⇒ `hasUpdate:false`
 *   ③ registry 不可达 / HTTP 错 / 垃圾响应 / 不回包 ⇒ `ok:true` + `error`，**不抛**
 *   ④ 缓存：两次不带 refresh 只打一次网络；`refresh:true` 再打一次；缓存键含 profile
 *   ⑤ 语义化比较（`0.8.9 < 0.8.10`）—— 换成字符串比较这里必红
 *   ⑥ 客户端：横幅文案 / 状态文案 / 时间格式，以及「重新检查」「检查失败」真的接上了
 *
 * 不连网、不启动 DSH、不碰真实 home（路由用例全部跑在临时 DSH_HOME 里）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(ROOT, "tmp");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");
const UI = nodePath.join(ROOT, "src", "ui.mjs");
const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };
/** 真实的包名/版本（`current` 的期望值就从这里来 —— 不在测试里再抄一份版本号）。 */
const PKG = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

function rmrf(p) {
  if (p && nodeFs.existsSync(p)) nodeFs.rmSync(p, { recursive: true, force: true });
}

function mkTempHome(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-ui-update-${label}-`));
}

/** `state` 动作会扫 graph 目录 —— 一律跑在空 home 里，绝不碰真实 DSH_HOME。 */
async function withHome(label, fn) {
  const home = mkTempHome(label);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmrf(home);
  }
}

/** 临时替换 globalThis.fetch（用例结束必还原）；`checkUpdate` 在**调用时**才解析 fetch。 */
async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete globalThis.fetch;
    else globalThis.fetch = prev;
  }
}

/** 一份最小可用的 registry packument 响应（形状与 `/dsh-gokifu-compact` 真实响应一致）。 */
function registryResponse(latest, publishedAt) {
  const body = {
    name: PKG.name,
    "dist-tags": { latest },
    versions: { [latest]: { name: PKG.name, version: latest } },
    time: publishedAt === null || publishedAt === undefined ? {} : { [latest]: publishedAt },
  };
  return { ok: true, status: 200, json: async () => body };
}

/** 本地版本 + 一个次版本（1.17.6 → 1.18.0）：无论以后版本号怎么涨，它都严格更新。 */
function nextMinor(version) {
  const [major, minor] = String(version).split(".");
  return `${major}.${Number(minor) + 1}.0`;
}

/** 挂一次真实 host 路由（与 ui-health / ui-models 同法：不启动 DSH）。 */
async function mount() {
  const uiMod = await import(`${pathToFileURL(UI).href}?ui-update=${Math.random()}`);
  const routes = [];
  uiMod.apply({
    webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" },
    effect: (fn) => fn(),
  });
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  return { handler: routes[0].handler, uiMod };
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

/** 与 test/ui-layout.test.mjs 同法加载 client bundle（classic script，只注入 window）。 */
function loadClientBundle() {
  const src = nodeFs.readFileSync(CLIENT, "utf8");
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (row) => (loaded = row) } };
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", src);
  fn(fakeWindow);
  if (loaded === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
  const react = {
    createElement: (...args) => ({ args }),
    useState: () => [undefined, () => {}],
    // ★ C510：客户端用了 useRef（模型二级菜单）——假 React 必须也有，否则渲染类测试会炸
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  const mod = loaded.factory((spec) => {
    if (spec === "react") return react;
    throw new Error(`client.js 意外 require(${spec})`);
  });
  return { src, mod };
}

/* ───────────────────────── ① 有新版本 ───────────────────────── */

tests["U5-1 registry 有新版本 ⇒ hasUpdate:true、命令里的版本正确；state 首屏不发网络"] = async (t) => {
  await withHome("new", async () => {
    const latest = nextMinor(PKG.version);
    const publishedAt = "2026-11-01T10:00:00.000Z";
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return registryResponse(latest, publishedAt);
      },
      async () => {
        const { handler, uiMod } = await mount();
        t.eq(typeof uiMod.checkUpdate, "function", "host 半导出 checkUpdate（唯一实现）");
        t.eq(uiMod.UPDATE_CACHE_MS, 600000, "缓存窗口 = 10 分钟");

        // 首屏：只读内存缓存 —— registry 再怎么慢都不该出现在打开页面的路径上
        const stateRes = await call(handler, { action: "state" });
        t.eq(stateRes.status, 200, "state 200");
        t.eq(calls, 0, "state 不许为版本检查发网络（首屏不等 registry）");
        t.eq(stateRes.json?.update, null, "没有缓存时 state.update = null（页面自己决定补不补）");
        t.eq(stateRes.json?.version, PKG.version, "既有 version 字段语义未动");

        // 点「重新检查」/ 首屏补一次：走 action:"update"
        const res = await call(handler, { action: "update" });
        t.eq(res.status, 200, "update 200（不是新路由，仍是 POST /gokifu/api）");
        t.eq(calls, 1, "检查更新打一次 registry");
        t.eq(res.json?.ok, true, "ok:true");
        t.eq(res.json?.current, PKG.version, "current = package.json 里的版本");
        t.eq(res.json?.latest, latest, "latest = registry 的 dist-tags/latest");
        t.eq(res.json?.publishedAt, publishedAt, "publishedAt = time[latest]");
        t.eq(res.json?.hasUpdate, true, `${latest} > ${PKG.version} ⇒ 有新版本`);
        t.eq(
          res.json?.command,
          `dsh plugin --profile desktop add ${PKG.name}@${latest}`,
          "命令：profile 缺省 desktop、版本用 latest",
        );
        t.eq(res.json?.error, null, "成功时 error 是 null");
        t.ok(
          typeof res.json?.cachedAt === "string" && !Number.isNaN(Date.parse(res.json.cachedAt)),
          "cachedAt 是 ISO 时间（页面显示「上次检查」）",
        );
        t.eq(
          Object.keys(res.json ?? {}).sort(),
          ["cachedAt", "command", "current", "error", "hasUpdate", "latest", "ok", "publishedAt", "relation"],
          "返回体字段与契约一致（只这 9 个；C394 起新增 relation）",
        );

        // 有了缓存之后，state 直接能显示，且仍然不发网络
        const stateAgain = await call(handler, { action: "state" });
        t.eq(calls, 1, "有缓存后 state 也不发网络");
        t.eq(stateAgain.json?.update?.latest, latest, "state.update 给缓存里的 latest");
        t.eq(stateAgain.json?.update?.hasUpdate, true, "state.update 带 hasUpdate");
        t.eq(stateAgain.json?.update?.command, res.json.command, "state.update 带同一条命令");
      },
    );
  });
};

/* ───────────────────────── ② 已是最新 ───────────────────────── */

tests["U5-2 registry 与本地同版本 ⇒ hasUpdate:false（不靠字符串碰运气）"] = async (t) => {
  await withHome("same", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return registryResponse(PKG.version, "2026-10-30T08:00:00.000Z");
      },
      async () => {
        const { handler } = await mount();
        const res = await call(handler, { action: "update" });
        t.eq(calls, 1, "真的问了一次 registry");
        t.eq(res.status, 200, "200");
        t.eq(res.json?.ok, true, "ok:true");
        t.eq(res.json?.latest, PKG.version, "latest 照给（不因为没新版就吞掉）");
        t.eq(res.json?.hasUpdate, false, "同版本 ⇒ 没有新版");
        t.eq(res.json?.error, null, "没有错误");
        t.eq(res.json?.command, "", "没有新版 ⇒ 不给命令（本地比 registry 新时给 @latest 等于教人降级）");
      },
    );
  });
};

/* ───────────────────────── ③ 失败路径 ───────────────────────── */

tests["U5-3 registry 不可达 / HTTP 错 / 垃圾响应 / 不回包 ⇒ ok:true + error，不抛"] = async (t) => {
  await withHome("fail", async () => {
    const cases = [
      [
        "连接被拒（ECONNREFUSED）",
        async () => {
          const error = new TypeError("fetch failed");
          error.cause = { code: "ECONNREFUSED" };
          throw error;
        },
        /ECONNREFUSED/,
      ],
      ["registry 5xx", async () => ({ ok: false, status: 503, json: async () => ({}) }), /503/],
      ["返回里没有版本号", async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }), /版本号/],
      [
        "abort 超时（AbortSignal.timeout 的形状）",
        async () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          throw error;
        },
        /超时/,
      ],
      ["宿主没有 fetch", null, /fetch/],
    ];
    for (const [label, impl, pattern] of cases) {
      await withFetch(impl === null ? undefined : impl, async () => {
        const { handler } = await mount();
        let thrown = null;
        let res = null;
        try {
          res = await call(handler, { action: "update" });
        } catch (error) {
          thrown = error;
        }
        t.eq(thrown, null, `${label}：路由不许抛（页面不能整页坏掉）`);
        t.eq(res?.status, 200, `${label}：仍是 200（不是 4xx/5xx）`);
        t.eq(res?.json?.ok, true, `${label}：ok:true`);
        t.eq(res?.json?.latest, null, `${label}：latest 是 null（不编造版本）`);
        t.eq(res?.json?.hasUpdate, false, `${label}：hasUpdate:false`);
        t.eq(res?.json?.publishedAt, null, `${label}：publishedAt 是 null`);
        t.ok(String(res?.json?.error ?? "").length > 0, `${label}：error 必须非空（页面要显示原因）`);
        t.ok(pattern.test(String(res?.json?.error)), `${label}：error 里带原因（实测：${res?.json?.error}）`);
        t.ok(
          typeof res?.json?.command === "string" && res.json.command.startsWith("dsh plugin --profile desktop add "),
          `${label}：命令仍给出（版本回落 @latest，由 npm 解析）`,
        );
      });
    }

    // 真正「不回包」的 registry：外层必须有时间上限，否则请求会挂到天荒地老
    const uiMod = await import(`${pathToFileURL(UI).href}?ui-update-timeout=${Math.random()}`);
    const started = Date.now();
    const value = await uiMod.checkUpdate({
      profile: "hang",
      current: "1.0.0",
      timeoutMs: 25,
      fetch: () => new Promise(() => {}),
    });
    const elapsed = Date.now() - started;
    t.eq(value.ok, true, "不回包也是 ok:true");
    t.eq(value.latest, null, "不回包 ⇒ latest:null");
    t.eq(value.hasUpdate, false, "不回包 ⇒ hasUpdate:false");
    t.ok(/超时/.test(String(value.error)), `不回包 ⇒ error 说的是超时（实测：${value.error}）`);
    t.ok(elapsed < 2000, `必须在时间预算附近返回（实测 ${elapsed}ms，预算 25ms）`);
  });
};

/* ───────────────────────── ④ 缓存 ───────────────────────── */

tests["U5-4 缓存：两次不带 refresh 只打一次网络；refresh:true 再打一次；键含 profile"] = async (t) => {
  await withHome("cache", async () => {
    const latest = nextMinor(PKG.version);
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return registryResponse(latest, "2026-11-01T10:00:00.000Z");
      },
      async () => {
        const { handler } = await mount();

        const first = await call(handler, { action: "update", profile: "cache-a" });
        t.eq(calls, 1, "第一次真的问了 registry");
        t.eq(first.json?.latest, latest, "第一次拿到 latest");

        const second = await call(handler, { action: "update", profile: "cache-a" });
        t.eq(calls, 1, "10 分钟内第二次命中缓存，不再打网络");
        t.eq(second.json?.cachedAt, first.json?.cachedAt, "两次给的是同一份快照（cachedAt 相同）");

        await call(handler, { action: "update", profile: "cache-a", refresh: true });
        t.eq(calls, 2, "refresh:true 强制绕过缓存，再打一次");

        await call(handler, { action: "update", profile: "cache-a" });
        t.eq(calls, 2, "刷新后的结果又进了缓存（第三次仍不打网络）");

        const other = await call(handler, { action: "update", profile: "cache-b" });
        t.eq(calls, 3, "缓存键含 profile：换个 profile 必须重新问（命令不一样）");
        t.eq(
          other.json?.command,
          `dsh plugin --profile cache-b add ${PKG.name}@${latest}`,
          "命令里的 profile 用请求里的那个",
        );

        await call(handler, { action: "update", profile: "cache-b" });
        t.eq(calls, 3, "cache-b 也进了缓存");

        // 非法 profile 回落 desktop（不拼出不安全的命令），且用的是 desktop 的缓存键
        await call(handler, { action: "update", profile: "bad profile!!" });
        const badProfile = await call(handler, { action: "update", profile: "bad profile!!" });
        t.eq(
          badProfile.json?.command,
          `dsh plugin --profile desktop add ${PKG.name}@${latest}`,
          "非法 profile 回落 desktop",
        );
        t.eq(calls, 4, "回落 desktop 后第二次同样命中 desktop 缓存");

        // 单飞：同一 profile 的两次「同时」请求只打一次网络（React 开发态会跑两遍 effect、用户也会连点）
        const [concurrentA, concurrentB] = await Promise.all([
          call(handler, { action: "update", profile: "cache-c" }),
          call(handler, { action: "update", profile: "cache-c" }),
        ]);
        t.eq(calls, 5, "并发两次只打一次 registry（单飞）");
        t.eq(concurrentA.json?.latest, latest, "并发 A 拿到结果");
        t.eq(concurrentB.json?.latest, latest, "并发 B 共用同一份结果");
      },
    );
  });
};

/* ───────────────────────── ⑤ 语义化比较 ───────────────────────── */

tests["U5-5 语义化比较：0.8.9 < 0.8.10（字符串比较会在这里红）"] = async (t) => {
  const uiMod = await import(`${pathToFileURL(UI).href}?ui-update-semver=${Math.random()}`);
  t.eq(uiMod.compareVersions("0.8.9", "0.8.10"), -1, "0.8.9 < 0.8.10（字典序说反了）");
  t.eq(uiMod.compareVersions("0.8.10", "0.8.9"), 1, "反向对称");
  t.eq(uiMod.compareVersions("1.9.0", "1.10.0"), -1, "1.9.0 < 1.10.0（字典序同样说反）");
  t.eq(uiMod.compareVersions("1.17.6", "1.18.0"), -1, "1.17.6 < 1.18.0");
  t.eq(uiMod.compareVersions("1.17.6", "1.17.6"), 0, "同版本 ⇒ 0");
  t.eq(uiMod.compareVersions("2.0.0", "1.99.99"), 1, "主版本优先");
  t.eq(uiMod.compareVersions("v1.17.6", "1.17.6"), 0, "容忍 v 前缀");
  t.eq(uiMod.compareVersions("1.18.0-rc.1", "1.18.0"), -1, "预发布 < 正式版");
  t.eq(uiMod.compareVersions("1.18.0-rc.2", "1.18.0-rc.1"), 1, "预发布按数字段比");
  t.eq(uiMod.compareVersions("nope", "1.0.0"), null, "解析不了 ⇒ null（不猜）");
  t.eq(uiMod.compareVersions("1.17.6", null), null, "current 缺失 ⇒ null（页面显示未知）");
  // 反证：字典序确实会把这两对判反 —— 上面那两条断言不是「碰巧绿」
  t.eq("0.8.9" < "0.8.10", false, "字典序认为 0.8.9 不小于 0.8.10");
  t.eq("1.9.0" < "1.10.0", false, "字典序认为 1.9.0 不小于 1.10.0");
};

/* ───────────────────────── ⑥ 客户端 ───────────────────────── */

tests["U5-6 客户端：横幅/状态文案与时间格式，且「重新检查」「检查失败」真的接上"] = async (t) => {
  const { src, mod } = loadClientBundle();
  const T = mod.__testables;
  for (const key of ["updateStatusText", "updateBannerText", "updateCommandText", "formatTimestamp"]) {
    t.eq(typeof T[key], "function", `__testables 暴露 ${key}（纯逻辑可测）`);
  }

  t.eq(
    T.updateBannerText({ current: "1.17.6", latest: "1.18.0", hasUpdate: true }),
    "有新版本 1.18.0（当前 1.17.6）",
    "顶部横幅文案（只陈述事实）",
  );
  t.eq(T.updateBannerText({ current: "1.17.6", latest: "1.17.6", hasUpdate: false }), "", "已是最新 ⇒ 不显示横幅");
  t.eq(T.updateBannerText(null), "", "还没有结果 ⇒ 不显示横幅");
  t.eq(T.updateBannerText({ hasUpdate: true, latest: "", current: "" }), "有新版本 ?（当前 ?）", "字段缺失也不产出 undefined");

  t.eq(T.updateStatusText(null), "未检查", "没检查过");
  t.eq(T.updateStatusText({ latest: "1.18.0", hasUpdate: true, error: null }), "有新版本", "有新版本");
  // ★ C428 起：服务端会给 `current` 与 `relation`；"已是最新"需要 relation=same（或字面相等）
  t.eq(T.updateStatusText({ current: "1.17.6", latest: "1.17.6", hasUpdate: false, relation: "same", error: null }), "已是最新", "已是最新");
  t.eq(T.updateStatusText({ latest: null, hasUpdate: false, error: "registry HTTP 503" }), "检查失败", "检查失败");
  t.eq(T.updateStatusText({ latest: "", hasUpdate: false, error: null }), "未知", "拿不到版本号 ⇒ 未知");

  t.eq(T.updateCommandText({ command: "dsh plugin --profile desktop add x@1.0.0" }), "dsh plugin --profile desktop add x@1.0.0", "命令原样透传");
  t.eq(T.updateCommandText(null), "", "没有命令 ⇒ 空串");
  t.eq(T.updateCommandText({}), "", "字段缺失 ⇒ 空串");

  t.eq(T.formatTimestamp("2026-11-01T10:00:00.000Z").length, 16, "时间格式 YYYY-MM-DD HH:mm");
  t.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(T.formatTimestamp("2026-11-01T10:00:00.000Z")), "形状固定（本地时区）");
  t.eq(T.formatTimestamp(""), "", "空串 ⇒ 空（页面显示 —）");
  t.eq(T.formatTimestamp("nope"), "", "非法时间 ⇒ 空（绝不显示 Invalid Date）");
  t.eq(T.formatTimestamp(undefined), "", "undefined ⇒ 空");

  // 接线（防回退）：请求走 action:"update"、绕过 host 缓存的按钮是真的、失败文本真的渲染出来
  t.includes(src, 'action: "update"', "客户端发的是 action:\"update\"");
  t.includes(src, "refresh: refresh === true", "refresh 是布尔（true 才绕过 host 缓存）");
  t.includes(src, "重新检查", "「重新检查」按钮存在");
  t.includes(src, "检查失败：", "检查失败时把原因渲染出来（不是空白）");
  t.includes(src, "updateBannerText(update)", "横幅文案接纯函数");
  t.includes(src, 'style: styles.banner', "横幅样式真的用上");
  t.includes(src, "copyUpdateCommand(updateCommand)", "命令可复制");
  // 检查失败是 host 的正常返回（ok:true + error）：不许走会把 error 当异常的 callApi
  t.notIncludes(src, 'callApi("update"', "检查失败要能显示 —— 不能复用会抛错的 callApi");
};

tests["C234 backfillLines：dryRun 报清单、真跑报结果、失败只说原因（纯函数）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  t.eq(typeof T.backfillLines, "function", "__testables 暴露 backfillLines");

  const dry = T.backfillLines({
    dryRun: true,
    scanned: 44,
    due: 2,
    items: [{ sessionId: "<SESSION_ID>", tail: 13029 }, { sessionId: "<SESSION_ID>", tail: 900 }],
  });
  t.includes(dry[0], "欠账 2 个会话", `首行给总数：${dry[0]}`);
  t.includes(dry[0], "扫了 44 个", `首行给扫描面：${dry[0]}`);
  t.includes(dry[1], "尾巴 13,029 事件", `逐条要带尾巴大小：${dry[1]}`);

  const empty = T.backfillLines({ dryRun: true, scanned: 44, due: 0, items: [] });
  t.includes(empty.join(" "), "没有欠账", "零欠账要说清楚，不许留空");

  const real = T.backfillLines({ ok: true, total: 2, done: 2, folded: 1, failed: 0 });
  t.includes(real[0], "补完 2 / 2", `真跑给结果：${real[0]}`);
  t.includes(real[0], "失败 0", `要带失败数：${real[0]}`);

  t.eq(T.backfillLines({ error: "engine-missing" })[0], "失败：engine-missing", "服务端错误只陈述原因");
  // ★ C258：真跑失败时必须点名会话与原因（只写"失败 N"没法处理）
  const withFails = T.backfillLines({
    ok: true, total: 3, done: 1, folded: 1, failed: 2,
    results: [
      { sessionId: "session-aaa-111", ok: true },
      { sessionId: "session-bbb-222", ok: false, error: "resume 没有拿到 live agent" },
      { sessionId: "session-ccc-333", ok: false, error: "timeout" },
      { sessionId: "session-ddd-444", ok: false, skipped: "dry-run" },
    ],
  });
  t.eq(withFails.length, 3, `1 行汇总 + 2 行失败（skipped 不算失败）：${JSON.stringify(withFails)}`);
  t.includes(withFails[1], "session-bbb-222", "要点名失败的会话");
  t.includes(withFails[1], "live agent", "要带失败原因");
  t.eq(withFails.join(" ").includes("session-ddd-444"), false, "dry-run 的 skipped 不算失败，不许列出来");
  t.eq(T.backfillLines(null).length, 0, "null ⇒ 空（页面显示 —）");
};

tests["C239 costText：估算成本的显示口径（带覆盖率、没数据给 —）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  t.eq(typeof T.costText, "function", "__testables 暴露 costText");
  t.eq(T.costText({ costUsd: 1.0634, costKnown: 33 }), "$1.06（33 次有 usage）", "大于 0.1 保留两位");
  const small = T.costText({ costUsd: 0.0322, costKnown: 1 });
  t.eq(small.startsWith("$0.032"), true, `小于 0.1 保留三位：${small}`);
  t.eq(T.costText({ costUsd: 0, costKnown: 0 }), "—", "没有成本 ⇒ —（不编 0）");
  t.eq(T.costText(null), "—", "null ⇒ —");
};

tests["C259 补账按批：还有剩余时要明说「再点一次继续」（别让用户以为一次就该补完）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  const partial = T.backfillLines({ ok: true, due: 12, total: 5, done: 5, folded: 4, failed: 0, results: [] });
  t.eq(partial.length, 2, `一批 5/12 ⇒ 两行：${JSON.stringify(partial)}`);
  t.includes(partial[1], "还有 7 个", `要算剩余：${partial[1]}`);
  t.includes(partial[1], "再点一次", "要告诉用户怎么继续");

  const all = T.backfillLines({ ok: true, due: 5, total: 5, done: 5, folded: 5, failed: 0, results: [] });
  t.eq(all.length, 1, `全补完 ⇒ 只有一行：${JSON.stringify(all)}`);
  t.eq(all.join(" ").includes("再点一次"), false, "补完了就不该再让用户点");
};

tests["C263 一次点击自动跑多批：合并规则（计数相加 / results 拼接 / due 取最后一批 / 出错即停）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  t.eq(typeof T.mergeBackfill, "function", "__testables 暴露 mergeBackfill");

  const a = { ok: true, due: 7, total: 3, done: 3, folded: 2, failed: 1, results: [{ sessionId: "s1", ok: true }] };
  const b = { ok: true, due: 4, total: 3, done: 3, folded: 3, failed: 0, results: [{ sessionId: "s2", ok: true }] };
  const ab = T.mergeBackfill(a, b);
  t.eq(ab.total, 6, "total 相加");
  t.eq(ab.done, 6, "done 相加");
  t.eq(ab.failed, 1, "failed 相加");
  t.eq(ab.due, 4, "due 取最后一批（服务端每次重算欠账）");
  t.eq(ab.results.length, 2, "results 拼接");
  t.eq(ab.ok, true, "两批都成功 ⇒ ok");

  // 第一批之前 acc 是 null ⇒ 直接接住
  const first = T.mergeBackfill(null, a);
  t.eq(first.total, 3, "acc=null 时直接用本批");
  t.eq(Array.isArray(first.results), true, "results 必须是数组");

  // 任何一批报错 ⇒ 合并结果带 error（面板据此停并显示）
  const bad = T.mergeBackfill(a, { ok: false, code: "backfill-busy", error: "已经有一次补账在跑" });
  t.eq(bad.ok !== undefined, true, "出错也要返回对象（不许 undefined）");
  t.includes(String(bad.error), "补账", "错误原因要传下去");
};

tests["C267 面板显示「上次摘要」：规则兜底必须一眼看出来（不是模型）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  t.eq(typeof T.summaryRouteText, "function", "__testables 暴露 summaryRouteText");

  // 规则摘要的哨兵（engine.summarize 的规则分支就是这么记的）
  const rules = T.summaryRouteText({ provider: "chess-context", model: "rules" });
  t.includes(rules.value, "规则", `规则摘要要显式显示：${rules.value}`);
  t.includes(rules.hint, "没有调用模型", "要说明它没花模型调用");

  // 模型路径：只显示短名（别把 group/xxx 整串塞进指标）
  const model = T.summaryRouteText({ provider: "magpie", model: "group/deepseek-v4.1-flash1017" });
  t.eq(model.value, "deepseek-v4.1-flash1017", `取最后一段：${model.value}`);
  t.includes(model.hint, "magpie", "hint 里带 provider");

  t.eq(T.summaryRouteText(null).value, "—", "没有数据 ⇒ —");
  t.eq(T.summaryRouteText({ model: "" }).value, "未知", "只有空 model ⇒ 未知（不许编）");
};

tests["C271 价目单点化：代码里的价格必须等于知识库那张表的低峰列（漂了就红）"] = async (t) => {
  const uiMod = await import(pathToFileURL(nodePath.join(HERE, "..", "src", "ui.mjs")).href);
  const P = uiMod.PRICE_USD_PER_MTOK;
  t.eq(!!P && typeof P === "object", true, "必须导出 PRICE_USD_PER_MTOK");

  // 从知识库条目里把那三个数字抠出来比对（表是「低峰 | 高峰」两列，取第一个数）
  const doc = nodeFs.readFileSync(nodePath.join(HERE, "..", "docs", "knowledge", "成本模型-deepseek价格.md"), "utf8");
  // 取该行第一个金额（= 低峰列，表里低峰在左）
  const grabFirst = (label) => {
    const line = doc.split("\n").find((l) => l.includes(label));
    const m = line.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!m) throw new Error(`「${label}」行里没有金额`);
    return Number(m[1]);
  };
  t.eq(grabFirst("cache hit"), P.hit, "cache hit 价必须与知识库低峰列一致");
  t.eq(grabFirst("cache miss"), P.miss, "cache miss 价必须与知识库低峰列一致");
  t.eq(grabFirst("输出"), P.out, "输出价必须与知识库低峰列一致");

  // 估算是低峰口径 ⇒ 必须小于等于高峰口径（下限），别把高峰价塞进来
  t.eq(P.hit < P.miss, true, "hit 必须比 miss 便宜（这是缓存机制的前提）");
  t.eq(P.out > P.miss, true, "输出比输入贵——如果反了，大概是抄错了列");
};

tests["C285 补账前必须说明「冷缓存」：归档会话的折叠按全额输入计费（不是平时的 98% 命中）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  const lines = T.backfillLines({
    ok: true,
    dryRun: true,
    scanned: 44,
    due: 2,
    items: [
      { sessionId: "session-aaa", tail: 12000 },
      { sessionId: "session-bbb", tail: 3000 },
    ],
  });
  t.eq(lines.length >= 3, true, `要有清单 + 冷缓存提示：${JSON.stringify(lines)}`);
  const joined = lines.join(" ");
  t.includes(joined, "冷缓存", "必须说明补账走冷缓存");
  t.includes(joined, "全额", "必须说明按全额输入计费");

  // 没有欠账时不该出现这句（零成本，也不制造焦虑）
  const empty = T.backfillLines({ ok: true, dryRun: true, scanned: 44, due: 0, items: [] });
  t.eq(empty.join(" ").includes("冷缓存"), false, "没有欠账时不该提冷缓存");
};

tests["C286 补账前要给出「大概多少钱」：按每个会话的 estTokens × 冷缓存全额价"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  const lines = T.backfillLines({
    ok: true,
    dryRun: true,
    scanned: 44,
    due: 3,
    items: [
      { sessionId: "a", tail: 12000, estTokens: 1_000_000 },
      { sessionId: "b", tail: 3000, estTokens: 500_000 },
      { sessionId: "c", tail: 100, estTokens: null }, // 没有历史 fold ⇒ 估不了
    ],
  });
  const joined = lines.join(" ");
  t.includes(joined, "1.50 M tok", `要报总 token：${joined}`);
  t.includes(joined, "$0.23", `要报折算金额（1.5M × 0.15/M = 0.225 → 0.23）：${joined}`);
  t.includes(joined, "另 1 个没有历史 fold 估不了", "估不了的要说清有几个，不许静默");

  // 全都没有估值 ⇒ 不显示金额行（不编数字）
  const noEst = T.backfillLines({ ok: true, dryRun: true, scanned: 5, due: 1, items: [{ sessionId: "x", tail: 900 }] });
  t.eq(noEst.join(" ").includes("M tok"), false, "没有估值时不许出现金额行");
};

tests["C287 大尾巴要提前提醒：估算超过 150k tok 的会话可能超出模型窗口"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  const lines = T.backfillLines({
    ok: true, dryRun: true, scanned: 44, due: 2,
    items: [
      { sessionId: "big-tail-session", tail: 13515, estTokens: 1_212_919 },
      { sessionId: "small-one", tail: 900, estTokens: 40_000 },
    ],
  });
  const bigLine = lines.find((l) => l.includes("big-tail-session"));
  const smallLine = lines.find((l) => l.includes("small-one"));
  t.includes(bigLine, "会分成多段折", `大尾巴要说明会分段折（C289 之后不再是会失败）：${bigLine}`);
  t.includes(bigLine, "1213k tok", `要报估算量级：${bigLine}`);
  t.eq(smallLine.includes("⚠"), false, `小尾巴不该警告：${smallLine}`);
};

tests["C290 文案必须跟得上 C289：超大尾巴是「自动分段折」，不再写「会失败」"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  const lines = T.backfillLines({
    ok: true, dryRun: true, scanned: 44, due: 1,
    items: [{ sessionId: "big", tail: 13_000, estTokens: 1_200_000 }],
  });
  const joined = lines.join(" ");
  t.includes(joined, "自动分段折叠", "汇总里要说明会自动分段");
  t.includes(joined, "每段 ≤150k tok", "要给出单段上限");
  t.includes(joined, "再点一次", "装不下要说可以再点一次继续");
  t.eq(joined.includes("会失败"), false, "C289 之后不许再说「会失败」——那是旧行为的说法");
};

tests["C394 `hasUpdate:false` 有三种原因，必须用 relation 区分（ahead / same / null）"] = async (t) => {
  const { versionRelation } = await import("../src/ui.mjs");
  t.eq(typeof versionRelation, "function", "必须导出 versionRelation");
  // 本地 1.17.6、registry 1.17.5 ⇒ 本地更新（不能让人以为"已是最新"）
  t.eq(versionRelation("1.17.6", "1.17.5"), "ahead", "本地比 registry 新 ⇒ ahead");
  t.eq(versionRelation("1.17.5", "1.17.6"), "behind", "registry 更新 ⇒ behind");
  t.eq(versionRelation("1.17.6", "1.17.6"), "same", "相同 ⇒ same");
  t.eq(versionRelation("1.17.6", null), null, "查不到 ⇒ null（不许当成 same）");
  t.eq(versionRelation(null, "1.17.5"), null, "本地未知 ⇒ null");

  // 接线：update 的返回值里必须带 relation
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "src", "ui.mjs"), "utf8");
  t.includes(src, "value.relation = versionRelation(", "update 必须设置 relation（C394）");
};

tests["C420 面板必须显示 warnings 与 applied（算了不显示=没算；参数被忽略要看得见）"] = async (t) => {
  const { mod } = loadClientBundle();
  const T = mod.__testables;
  // dryRun 带 warnings ⇒ 必须出现在文案里
  const withWarn = T.backfillLines({
    dryRun: true, due: 2, scanned: 3,
    items: [{ sessionId: "s1", tail: 100, estTokens: 200000 }],
    warnings: ["3 个会话按 p90 估算会超过 90s 单会话超时"],
  });
  t.eq(withWarn.some((l) => l.includes("90s")), true, "warnings 必须被渲染（C420）");
  // 带 applied（指定了 id）⇒ 要说明只处理指定的那些
  const withApplied = T.backfillLines({
    dryRun: true, due: 5, scanned: 5,
    items: [{ sessionId: "s1", tail: 100 }],
    applied: { sessionIds: ["s1"], selected: 1, limit: 1, minEvents: 40 },
  });
  t.eq(withApplied.some((l) => l.includes("只处理你指定的 1 个会话")), true, "applied 必须被渲染");
  // 没有这些字段时不许凭空加行
  const plain = T.backfillLines({ dryRun: true, due: 0, scanned: 1, items: [] });
  t.eq(plain.some((l) => l.includes("⚠") || l.includes("只处理你指定的")), false, "没有字段就不许多渲染");
};

tests["C428 更新文案不许把「本地更新」说成「已是最新」（relation=ahead）"] = async (t) => {
  const T = loadClientBundle().mod.__testables;
  // 本地 1.17.6 比 registry 1.17.5 新 —— 旧文案会显示"已是最新"，那是误读
  t.eq(T.updateStatusText({ current: "1.17.6", latest: "1.17.5", hasUpdate: false, relation: "ahead" }).includes("本地更新"), true,
    "ahead 必须说「本地更新」（C428）");
  t.eq(T.updateStatusText({ current: "1.17.6", latest: "1.17.6", hasUpdate: false, relation: "same" }), "已是最新", "same 才是已是最新");
  t.eq(T.updateStatusText({ current: "1.17.5", latest: "1.17.6", hasUpdate: true, relation: "behind" }), "有新版本", "behind 要有新版本");
  // 没有 relation（老服务端）⇒ 不许猜"已是最新"
  const noRel = T.updateStatusText({ current: "1.17.6", latest: "1.17.5", hasUpdate: false });
  t.eq(noRel === "已是最新", false, "没有 relation 时不许说「已是最新」");
};
