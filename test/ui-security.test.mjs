/**
 * ui-security.test.mjs —— `/gokifu/api` 的 CSRF 防护与备份密钥面（WS-UIAUDIT A1 / A2）
 *
 * 覆盖的都是「安全面静默失效」：
 *   · A1 跨站 text/plain 简单请求（不预检）能否改写 preset
 *   · A1 外站 Origin / 同 IP 异端口（sec-fetch-site: same-site）/ Origin: null 是否被拒
 *   · A1 无 Origin 的本机调用（curl / node / 本测试）是否仍然可用 —— 这条是**回归护栏**，
 *        真实浏览器实测（tmp/dsh-gokifu-compact/ws-csrf/browser-origin-probe.mjs）证明
 *        同源 POST 必带 Origin，所以「无 Origin」只可能是本机工具，不能连带拒掉。
 *   · A1 非回环 Host（DNS rebinding 形状）是否被拒
 *   · A1 content-type 非 JSON / 缺失是否被拒
 *   · A2 备份轮转上限、含密钥配置不得落盘明文备份、且响应里不得出现密钥值
 *
 * 全部离线：假 req/res 直调路由 handler + 临时 home，不启动 DSH、不碰真实 preset。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

const installMod = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "install.mjs")).href);
const { PKG_NAME, ENTRY_ID } = installMod;

/** 与真机 preset 同构的最小样例。 */
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
  `              - id: ${ENTRY_ID}`,
  `                name: '${PKG_NAME}/engine'`,
  "                config:",
  "                  auto: true                # 注释",
  "                  thresholdRatio: 0.45",
  "                  summaryMode: hybrid",
  "                  summarizationModel: ''",
  "              - id: command-compact",
  "                name: '@deepseek-ai/dsh-compact-command'",
  "",
].join("\n");

/** 带疑似密钥的样例（模拟 M2 把 key 写进 preset 之后的形态）。 */
const SECRET_SAMPLE = SAMPLE.replace(
  "                  summarizationModel: ''",
  "                  summarizationModel: ''\n                  summarizationApiKey: 'sk-abcdefghijklmnop0123456789'",
);

const FAKE_KEY = "sk-abcdefghijklmnop0123456789";
const PRESET_NAME = "cordis.patch.yml";
const BACKUP_MARK = ".bak-before-ui-";

const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };
const BROWSER_HEADERS = { ...LOCAL_HEADERS, origin: "http://127.0.0.1:19387", "sec-fetch-site": "same-origin" };

function tempHome(presetText = SAMPLE) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-ui-sec-"));
  const presetDir = nodePath.join(dir, "preset-bundles", "personal-assistant");
  nodeFs.mkdirSync(presetDir, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "profiles", "desktop", "node_modules"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  const preset = nodePath.join(presetDir, PRESET_NAME);
  nodeFs.writeFileSync(preset, presetText, "utf8");
  return { home: dir, preset, presetDir };
}

async function mount(bindHost = "127.0.0.1") {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href + "?sec=" + Math.random());
  const routes = [];
  // 默认按 127.0.0.1 断言（即使测试进程所在的 DSH 绑到 0.0.0.0，这个 suite 也必须跑默认策略）；
  // 需要验证「绑 0.0.0.0」时显式传 bindHost（task-34 的 fail-closed 用例）。
  const ctx = { webServer: { register: (r) => (routes.push(r), () => {}), host: bindHost }, effect: (fn) => fn() };
  uiMod.apply(ctx);
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  return { handler: routes[0].handler, uiMod };
}

/** 假 req/res 直调 handler；headers 缺省 = 本机无 Origin 调用形状。 */
function call(handler, { method = "POST", headers = LOCAL_HEADERS, body = null, rawBody = null } = {}) {
  return new Promise((resolve, reject) => {
    const text = rawBody ?? (body === null ? "" : JSON.stringify(body));
    const req = {
      method,
      headers,
      destroyed: false,
      on(event, cb) {
        if (event === "data" && text.length > 0) {
          const buf = Buffer.from(text, "utf8");
          const mid = Math.floor(buf.length / 2);
          cb(buf.subarray(0, mid));
          cb(buf.subarray(mid));
        }
        if (event === "end") cb();
        return req;
      },
      destroy() {
        req.destroyed = true;
      },
    };
    const res = {
      status: 0,
      resHeaders: null,
      raw: "",
      writeHead(status, resHeaders) {
        this.status = status;
        this.resHeaders = resHeaders ?? null;
      },
      end(chunk) {
        this.raw = chunk ?? "";
        resolve({ status: this.status, headers: this.resHeaders, raw: this.raw, json: safeJson(this.raw) });
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

function backupNames(preset) {
  return nodeFs.readdirSync(nodePath.dirname(preset)).filter((n) => n.startsWith(`${PRESET_NAME}${BACKUP_MARK}`));
}

export const tests = {};

/* ───────────────────────── A1 · CSRF ───────────────────────── */

tests["A1 · 跨站 text/plain 简单请求（evil.example）必须 403，且 preset 一个字节都不变"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, {
      headers: { host: "127.0.0.1:19387", "content-type": "text/plain;charset=UTF-8", origin: "http://evil.example", "sec-fetch-site": "cross-site" },
      body: { action: "save", patch: { thresholdRatio: 0.91 } },
    });
    if (res.status !== 403) throw new Error(`跨站 text/plain 应 403，得到 ${res.status}：${res.raw.slice(0, 160)}`);
    if (res.json?.code !== "cross-site") throw new Error(`应命中 sec-fetch-site 分支，得到 code=${res.json?.code}`);
  });
  const after = nodeFs.readFileSync(preset, "utf8");
  if (after !== before) throw new Error("跨站请求改写了 preset");
  if (backupNames(preset).length !== 0) throw new Error("跨站请求还产生了备份");
};

tests["A1 · 外站 Origin + application/json 必须 403"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, {
      headers: { host: "127.0.0.1:19387", "content-type": "application/json", origin: "http://evil.example" },
      body: { action: "save", patch: { thresholdRatio: 0.91 } },
    });
    if (res.status !== 403) throw new Error(`外站 Origin 应 403，得到 ${res.status}`);
    if (res.json?.code !== "cross-origin") throw new Error(`应命中同源比对分支，得到 code=${res.json?.code}`);
  });
  if (nodeFs.readFileSync(preset, "utf8") !== before) throw new Error("外站请求改写了 preset");
};

tests["A1 · 同 IP 异端口（实测 sec-fetch-site: same-site）也必须 403"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, {
      headers: { host: "127.0.0.1:19387", "content-type": "text/plain", origin: "http://127.0.0.1:19401", "sec-fetch-site": "same-site" },
      body: { action: "save", patch: { thresholdRatio: 0.93 } },
    });
    if (res.status !== 403) throw new Error(`same-site 应 403，得到 ${res.status}`);
  });
  if (nodeFs.readFileSync(preset, "utf8") !== before) throw new Error("same-site 请求改写了 preset");
};

tests["A1 · Origin: null（沙箱/本地文件来源）必须 403"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { headers: { ...LOCAL_HEADERS, origin: "null" }, body: { action: "state" } });
    if (res.status !== 403) throw new Error(`Origin: null 应 403，得到 ${res.status}`);
  });
};

tests["A1 · 无 Origin 的本机调用（curl / 本项目测试的形状）仍然 200"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const st = await call(handler, { body: { action: "state" } });
    if (st.status !== 200) throw new Error(`本机无 Origin 调用应 200，得到 ${st.status}：${st.raw.slice(0, 160)}`);
    if (st.json?.config?.thresholdRatio !== 0.45) throw new Error("state 没带配置");
    const save = await call(handler, { body: { action: "save", patch: { thresholdRatio: 0.5 } } });
    if (save.status !== 200 || save.json?.ok !== true) throw new Error(`本机保存应成功，得到 ${save.status}/${JSON.stringify(save.json)}`);
  });
};

tests["A1 · 无 Origin 但自报 cross-site / same-site 必须 403（同 IP 异端口实测就是 same-site）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const cross = await call(handler, { headers: { ...LOCAL_HEADERS, "sec-fetch-site": "cross-site" }, body: { action: "state" } });
    if (cross.status !== 403) throw new Error(`自报 cross-site 应 403，得到 ${cross.status}`);
    const sameSite = await call(handler, { headers: { ...LOCAL_HEADERS, "sec-fetch-site": "same-site" }, body: { action: "state" } });
    if (sameSite.status !== 403) throw new Error(`自报 same-site 应 403（实测跨端口简单请求就是这个值），得到 ${sameSite.status}`);
  });
};

tests["A1 · 同源浏览器请求（Origin == Host，含 sec-fetch-site: same-origin）必须通过"] = async () => {
  const { home, preset } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { headers: BROWSER_HEADERS, body: { action: "save", patch: { thresholdRatio: 0.55 } } });
    if (res.status !== 200 || res.json?.ok !== true) throw new Error(`同源保存应成功，得到 ${res.status}/${JSON.stringify(res.json)}`);
    if (res.json?.changed?.length !== 1) throw new Error(`应写 1 个文件，得到 ${JSON.stringify(res.json?.changed)}`);
  });
  const text = nodeFs.readFileSync(preset, "utf8");
  if (!text.includes("thresholdRatio: 0.55")) throw new Error("同源保存没写进文件");
};

tests["A1 · 非回环 Host（DNS rebinding 形状：Origin 与 Host 自洽）必须 403"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, {
      headers: { host: "evil.example:19387", "content-type": "application/json", origin: "http://evil.example:19387", "sec-fetch-site": "same-origin" },
      body: { action: "save", patch: { thresholdRatio: 0.91 } },
    });
    if (res.status !== 403) throw new Error(`非回环 Host 应 403，得到 ${res.status}`);
    if (res.json?.code !== "untrusted-host") throw new Error(`应命中 Host 分支，得到 code=${res.json?.code}`);
  });
  if (nodeFs.readFileSync(preset, "utf8") !== before) throw new Error("rebinding 形状的请求改写了 preset");
};

tests["A1 · Host 缺失 / 非法必须 403"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const noHost = await call(handler, { headers: { "content-type": "application/json" }, body: { action: "state" } });
    if (noHost.status !== 403) throw new Error(`缺 Host 应 403，得到 ${noHost.status}`);
    const badHost = await call(handler, { headers: { host: "127.0.0.1:99999", "content-type": "application/json" }, body: { action: "state" } });
    if (badHost.status !== 403) throw new Error(`非法端口 Host 应 403，得到 ${badHost.status}`);
  });
};

tests["A1 · content-type 非 JSON 或缺失必须 415（同源也拒）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const plain = await call(handler, { headers: { ...LOCAL_HEADERS, "content-type": "text/plain" }, rawBody: "{}" });
    if (plain.status !== 415) throw new Error(`text/plain 同源应 415，得到 ${plain.status}`);
    const none = await call(handler, { headers: { host: "127.0.0.1:19387" }, rawBody: "{}" });
    if (none.status !== 415) throw new Error(`缺 content-type 应 415，得到 ${none.status}`);
    const json = await call(handler, { headers: { ...LOCAL_HEADERS, "content-type": "application/json; charset=utf-8" }, rawBody: '{"action":"state"}' });
    if (json.status !== 200) throw new Error(`application/json; charset 应通过，得到 ${json.status}`);
  });
};

tests["A1 · 外站 Origin 读 state 也必须 403（不只写）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { headers: { ...LOCAL_HEADERS, origin: "http://evil.example" }, body: { action: "state" } });
    if (res.status !== 403) throw new Error(`外站读 state 应 403，得到 ${res.status}`);
    if (res.raw.includes("defaults") || res.raw.includes("configFile")) throw new Error("403 响应仍泄露了 state 字段");
  });
};

tests["A1 · OPTIONS 仍 204 且不带 ACAO；GET 仍 405"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const opt = await call(handler, { method: "OPTIONS", headers: { host: "127.0.0.1:19387", origin: "http://evil.example", "access-control-request-method": "POST" } });
    if (opt.status !== 204) throw new Error(`OPTIONS 应 204，得到 ${opt.status}`);
    const acao = opt.headers?.["access-control-allow-origin"] ?? opt.headers?.["Access-Control-Allow-Origin"];
    if (acao !== undefined) throw new Error(`OPTIONS 不得回 ACAO（跨站读会被放行），得到 ${acao}`);
    const get = await call(handler, { method: "GET", headers: { host: "127.0.0.1:19387" } });
    if (get.status !== 405) throw new Error(`GET 应 405，得到 ${get.status}`);
  });
};

/* ───────────────────────── A2 · 备份与密钥 ───────────────────────── */

tests["A2 · 备份轮转：连写 8 次最多留 5 份，删掉的是最旧的"] = async () => {
  const { home, preset } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const first = uiMod.saveConfig({ thresholdRatio: 0.11 }, { home });
    if (!first.backup || !nodeFs.existsSync(first.backup)) throw new Error("第 1 次保存没有备份");
    const firstName = nodePath.basename(first.backup);
    for (let i = 2; i <= 8; i += 1) {
      const r = uiMod.saveConfig({ thresholdRatio: 0.1 + i * 0.01 }, { home });
      if (r.changed.length !== 1) throw new Error(`第 ${i} 次保存没写盘`);
    }
    const names = backupNames(preset);
    if (names.length !== uiMod.BACKUP_KEEP) throw new Error(`备份应轮转到 ${uiMod.BACKUP_KEEP} 份，实际 ${names.length}：${names.join(",")}`);
    if (names.includes(firstName)) throw new Error(`最旧的备份没被删掉：${firstName}`);
  });
};

tests["A2 · preset 含密钥时不落明文备份，且响应里不得出现密钥值"] = async () => {
  const { home, preset } = tempHome(SECRET_SAMPLE);
  // 前置：fixture 里确实有密钥样式（否则这条测试是假绿）
  if (!nodeFs.readFileSync(preset, "utf8").includes(FAKE_KEY)) throw new Error("fixture 没写进密钥，测试无效");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { headers: BROWSER_HEADERS, body: { action: "save", patch: { auto: false } } });
    if (res.status !== 200 || res.json?.ok !== true) throw new Error(`保存应成功，得到 ${res.status}/${JSON.stringify(res.json)}`);
    if (res.json?.backup !== null) throw new Error(`含密钥时不得产生备份，得到 backup=${JSON.stringify(res.json?.backup)}`);
    if (!res.json?.backupSkipped) throw new Error("没返回 backupSkipped 说明");
    if (!res.json.backupSkipped.keys.includes("summarizationApiKey")) throw new Error(`backupSkipped.keys 应含键名，得到 ${JSON.stringify(res.json.backupSkipped.keys)}`);
    if (res.raw.includes(FAKE_KEY)) throw new Error("save 响应里泄露了密钥值");
  });
  if (backupNames(preset).length !== 0) throw new Error(`含密钥的 preset 仍产生了备份：${backupNames(preset).join(",")}`);
  const text = nodeFs.readFileSync(preset, "utf8");
  if (!text.includes("auto: false")) throw new Error("非密钥字段没写进去");
  if (!text.includes(FAKE_KEY)) throw new Error("原有密钥被写坏了");
};

tests["A2 · 通过 patch 传密钥键：400 拒绝（不静默丢）、不落盘、不进备份"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { headers: BROWSER_HEADERS, body: { action: "save", patch: { summarizationApiKey: FAKE_KEY, thresholdRatio: 0.47 } } });
    if (res.status !== 400) throw new Error(`含白名单外的键必须 400（B6 不静默丢），得到 ${res.status}：${res.raw.slice(0, 160)}`);
    if (!res.json?.skipped?.includes("summarizationApiKey")) throw new Error(`400 体里应回显 skipped，得到 ${JSON.stringify(res.json?.skipped)}`);
    if (!String(res.json?.error ?? "").includes("summarizationApiKey")) throw new Error(`错误文本里应出现键名，得到 ${JSON.stringify(res.json?.error)}`);
    if (res.raw.includes(FAKE_KEY)) throw new Error("响应里回显了密钥值");
  });
  const text = nodeFs.readFileSync(preset, "utf8");
  if (text !== before) throw new Error("含白名单外键的请求竟然改了 preset");
  if (text.includes("thresholdRatio: 0.47")) throw new Error("同单里的合法键也不该被写（整单拒绝）");
  if (backupNames(preset).length !== 0) throw new Error("被拒的保存不该产生备份");
};

tests["A2 · 密钥识别不误判 Tokens 类数字键（防正则过宽）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const numeric = ["headroomTokens: 65536", "hotLedgerMaxTokens: 500", "minFoldTokens: 8000", "maxTokens: 8192", "growthFloorTokens: 40000", "tier2After: 8", "thresholdRatio: 0.45", "hotLedgerMarkers: semantic", "hotLedgerReplace: true"].join("\n");
    const hits = uiMod.findSecretLike(numeric);
    if (hits.length !== 0) throw new Error(`把普通数字键误判成密钥：${hits.join(",")}`);
    if (uiMod.findSecretLike("summarizationApiKey: 'sk-abcdefghijklmnop'").length === 0) throw new Error("漏判 summarizationApiKey");
    if (uiMod.findSecretLike("apiToken: abc123").length === 0) throw new Error("漏判 apiToken");
    if (uiMod.findSecretLike("summarizationApiKey: ''").length !== 0) throw new Error("空值不该算密钥");
  });
};

tests["A2 · 普通 preset 的保存仍然照常备份（防止把功能改坏）"] = async () => {
  const { home, preset } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const r = uiMod.saveConfig({ thresholdRatio: 0.33 }, { home });
    if (r.changed.length !== 1) throw new Error("应写 1 个文件");
    if (!r.backup || !nodeFs.existsSync(r.backup)) throw new Error("应产生备份");
    if (r.backupSkipped !== null) throw new Error(`无密钥时不该有 backupSkipped：${JSON.stringify(r.backupSkipped)}`);
    const again = uiMod.saveConfig({ thresholdRatio: 0.33 }, { home });
    if (again.changed.length !== 0) throw new Error("同值不应再次写盘");
    if (backupNames(preset).length !== 1) throw new Error(`同值不该新增备份，实际 ${backupNames(preset).length}`);
  });
};

/* ───────────────────────── 运营者显式放行（反代 / 隧道） ───────────────────────── */

tests["A1 · DSH_GOKIFU_ALLOWED_HOSTS 放行的主机接受 https 反代源；未放行则拒"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const spawn = (headers, options) => uiMod.checkRequestTrust({ headers }, options);
    const allowed = spawn({ host: "gui.example", origin: "https://gui.example", "sec-fetch-site": "same-origin" }, { allowedHosts: ["gui.example"] });
    if (allowed.ok !== true || allowed.mode !== "allowlisted-host") throw new Error(`放行主机应通过，得到 ${JSON.stringify(allowed)}`);
    const notAllowed = spawn({ host: "gui.example", origin: "https://gui.example", "sec-fetch-site": "same-origin" }, {});
    if (notAllowed.ok !== false || notAllowed.mode !== "untrusted-host") throw new Error(`未放行的非回环 Host 必须拒，得到 ${JSON.stringify(notAllowed)}`);
    const wrongOrigin = spawn({ host: "gui.example", origin: "https://other.example" }, { allowedHosts: ["gui.example"] });
    if (wrongOrigin.ok !== false || wrongOrigin.mode !== "cross-origin") throw new Error(`放行主机的异源 Origin 仍必须拒，得到 ${JSON.stringify(wrongOrigin)}`);
  });
};

tests["A1 · 环境变量 DSH_GOKIFU_ALLOWED_HOSTS 真的接进了路由（不是死代码）"] = async () => {
  const { home } = tempHome();
  const prev = process.env.DSH_GOKIFU_ALLOWED_HOSTS;
  process.env.DSH_GOKIFU_ALLOWED_HOSTS = "gui.example";
  try {
    await withHome(home, async () => {
      const { handler } = await mount();
      const res = await call(handler, {
        headers: { host: "gui.example", "content-type": "application/json", origin: "https://gui.example", "sec-fetch-site": "same-origin" },
        body: { action: "state" },
      });
      if (res.status !== 200) throw new Error(`放行主机应 200，得到 ${res.status}：${res.raw.slice(0, 160)}`);
    });
  } finally {
    if (prev === undefined) delete process.env.DSH_GOKIFU_ALLOWED_HOSTS;
    else process.env.DSH_GOKIFU_ALLOWED_HOSTS = prev;
  }
};

/* ───────────────────────── task-34：绑 0.0.0.0 必须 fail closed ───────────────────────── */

tests["task-34 · 绑 0.0.0.0 时 rebinding 形状（host=origin=evil.example）必须被拒，不再无条件放行"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler, uiMod } = await mount("0.0.0.0");
    // reviewer 的探针 csrf-rebinding-check.mjs 就是这个形状：host 与 origin 自洽，靠同源比对挡不住
    const res = await call(handler, {
      headers: { host: "evil.example:19387", "content-type": "application/json", origin: "http://evil.example:19387", "sec-fetch-site": "same-origin" },
      body: { action: "save", patch: { thresholdRatio: 0.91 } },
    });
    if (res.status !== 403) throw new Error(`绑 0.0.0.0 时非回环 Host 必须 403，得到 ${res.status}：${res.raw.slice(0, 160)}`);
    if (res.json?.code !== "untrusted-host") throw new Error(`应命中 Host 分支，得到 code=${res.json?.code}`);
    if (!String(res.json?.error ?? "").includes("DSH_GOKIFU_ALLOWED_HOSTS")) throw new Error(`403 文案要给出可操作提示，得到 ${JSON.stringify(res.json?.error)}`);
    // 回环 Host 在 0.0.0.0 下仍然正常（不能连本机也一起拒）
    const ok = await call(handler, { headers: LOCAL_HEADERS, body: { action: "state" } });
    if (ok.status !== 200) throw new Error(`0.0.0.0 下回环调用应 200，得到 ${ok.status}`);
    const direct = uiMod.checkRequestTrust({ headers: { host: "evil.example", origin: "http://evil.example" } }, { boundAllInterfaces: true });
    if (direct.ok !== false) throw new Error(`checkRequestTrust(boundAllInterfaces) 必须拒，得到 ${JSON.stringify(direct)}`);
    const allowlisted = uiMod.checkRequestTrust({ headers: { host: "evil.example", origin: "http://evil.example" } }, { boundAllInterfaces: true, allowedHosts: ["evil.example"] });
    if (allowlisted.ok !== true) throw new Error(`显式白名单后应放行，得到 ${JSON.stringify(allowlisted)}`);
  });
};

tests["task-34 · 默认 127.0.0.1 行为不变（非回环 Host 一样拒，回环一样过）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount("127.0.0.1");
    const bind = (host, origin) => uiMod.checkRequestTrust({ headers: { host, origin } }, { boundAllInterfaces: false });
    if (bind("127.0.0.1:19387", "http://127.0.0.1:19387").ok !== true) throw new Error("回环同源应通过");
    if (bind("evil.example:19387", "http://evil.example:19387").ok !== false) throw new Error("非回环应拒");
    if (bind("127.0.0.1:19387", "http://evil.example").ok !== false) throw new Error("异源 Origin 应拒");
  });
};

/* ───────────────────────── task-34：reviewer 边界四类 ───────────────────────── */

tests["边界 · IPv6 回环 [::1] 与全写 [0:0:0:0:0:0:0:1] 都当回环，异端口仍拒"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const trust = (host, origin) => uiMod.checkRequestTrust({ headers: { host, origin } }, {});
    const short = trust("[::1]:19387", "http://[::1]:19387");
    if (short.ok !== true) throw new Error(`[::1] 同源应通过，得到 ${JSON.stringify(short)}`);
    const long = trust("[0:0:0:0:0:0:0:1]:19387", "http://[::1]:19387");
    if (long.ok !== true) throw new Error(`[0:0:0:0:0:0:0:1] 与 [::1] 应视作同一台机器，得到 ${JSON.stringify(long)}`);
    const mixed = trust("[::1]:19387", "http://[0:0:0:0:0:0:0:1]:19387");
    if (mixed.ok !== true) throw new Error(`反向写法也应通过，得到 ${JSON.stringify(mixed)}`);
    const wrongPort = trust("[::1]:19387", "http://[::1]:19400");
    if (wrongPort.ok !== false || wrongPort.mode !== "cross-origin") throw new Error(`IPv6 异端口必须拒，得到 ${JSON.stringify(wrongPort)}`);
    if (uiMod.isLoopbackHostname("[::1]") !== true || uiMod.isLoopbackHostname("0:0:0:0:0:0:0:1") !== true) throw new Error("isLoopbackHostname 未认 IPv6 回环");
    if (uiMod.canonicalHostname("[::1]") !== uiMod.canonicalHostname("[0:0:0:0:0:0:0:1]")) throw new Error("canonicalHostname 未归一 IPv6");
  });
};

tests["边界 · Host 大小写不敏感；大写非回环仍然被拒；白名单同样大小写不敏感"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const trust = (host, origin, options) => uiMod.checkRequestTrust({ headers: { host, origin } }, options ?? {});
    if (trust("LOCALHOST:19387", "http://LocalHost:19387").ok !== true) throw new Error("大小写不同的 localhost 应同源");
    if (trust("127.0.0.1:19387", "http://127.0.0.1:19387").ok !== true) throw new Error("常规回环应通过");
    if (trust("EVIL.EXAMPLE:19387", "http://evil.example:19387").ok !== false) throw new Error("大写的非回环 Host 不能因为转小写就放行");
    const allowUpper = trust("GUI.Example:19387", "https://gui.example", { allowedHosts: ["gui.example"] });
    if (allowUpper.ok !== true) throw new Error(`白名单应大小写不敏感，得到 ${JSON.stringify(allowUpper)}`);
    const allowUpperEnv = uiMod.checkRequestTrust({ headers: { host: "gui.example", origin: "https://GUI.EXAMPLE" } }, { allowedHosts: ["GUI.EXAMPLE"] });
    if (allowUpperEnv.ok !== true) throw new Error("白名单与 Origin 的大小写都应归一");
  });
};

tests["边界 · Host 缺端口按 http 默认 80 比，显式 :80 与缺省等价，异端口仍拒"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const trust = (host, origin) => uiMod.checkRequestTrust({ headers: { host, origin } }, {});
    if (trust("127.0.0.1", "http://127.0.0.1").ok !== true) throw new Error("双方都缺端口（默认 80）应通过");
    if (trust("127.0.0.1:80", "http://127.0.0.1").ok !== true) throw new Error("显式 :80 与缺省应等价");
    if (trust("127.0.0.1", "http://127.0.0.1:80").ok !== true) throw new Error("反向也应等价");
    if (trust("127.0.0.1", "http://127.0.0.1:19387").ok !== false) throw new Error("缺省 80 vs 19387 必须判为跨源");
    if (trust("127.0.0.1:19387", "http://127.0.0.1").ok !== false) throw new Error("反向也必须判为跨源");
    const auth = uiMod.parseAuthority("127.0.0.1");
    if (auth.port !== "80") throw new Error(`缺端口应算 80，得到 ${JSON.stringify(auth)}`);
    if (uiMod.parseAuthority("127.0.0.1:99999") !== null) throw new Error("非法端口应返回 null");
  });
};

tests["边界 · 同毫秒连写 8 次：备份名不覆盖（-2/-3…），轮转后恰好 5 份且内容各不相同"] = async () => {
  const { home, preset } = tempHome();
  const realNow = Date.now;
  Date.now = () => 1793294999000; // 冻结时钟：强制 8 次落在同一毫秒
  try {
    await withHome(home, async () => {
      const { uiMod } = await mount();
      for (let i = 1; i <= 8; i += 1) {
        const r = uiMod.saveConfig({ thresholdRatio: 0.1 + i * 0.01 }, { home });
        if (r.changed.length !== 1) throw new Error(`第 ${i} 次保存没写盘`);
      }
      const names = backupNames(preset);
      if (names.length !== uiMod.BACKUP_KEEP) throw new Error(`同毫秒也应轮转到 ${uiMod.BACKUP_KEEP} 份，得到 ${names.length}：${names.join(",")}`);
      if (new Set(names).size !== names.length) throw new Error(`备份名重复：${names.join(",")}`);
      const suffixed = names.filter((n) => /-\d+$/.test(n.replace(/\.bak-before-ui-\d+/, "")));
      if (suffixed.length === 0) throw new Error(`同毫秒去重后缀没生效（应出现 -2/-3…）：${names.join(",")}`);
      const contents = names.map((n) => nodeFs.readFileSync(nodePath.join(nodePath.dirname(preset), n), "utf8"));
      if (new Set(contents).size !== contents.length) throw new Error("有备份内容被后来的保存覆盖了");
    });
  } finally {
    Date.now = realNow;
  }
};
