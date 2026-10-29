/**
 * ui-config.test.mjs —— 配置写入正确性（WS-UIAUDIT B4 / B5 / B6，task-32）
 *
 * 这三条都是「页面说的和引擎做的不一样」：
 *   · B5 空串数字被静默写成 0（`Number("")===0`），阈值 0 会让引擎行为完全变样
 *   · B4 未配置的键被渲染成「关/空」，而引擎实际生效 true/semantic —— host 侧必须回传生效值
 *   · B6 白名单外的键被静默丢弃，用户以为保存成功（M2 的 key 字段正好撞这条）
 *
 * 断言分三层：纯函数（sanitizePatch / describeConfig）、HTTP（真路由 + 临时 home）、
 * 以及跨文件一致性（host 的 DEFAULTS ↔ engine.mjs 的 schema 默认值、host 的字段名 ↔ client.js 的 label）。
 * 全是离线：不启动 DSH、不碰真实 preset。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

const installMod = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "install.mjs")).href);
const { PKG_NAME, ENTRY_ID } = installMod;

/** 与**真实 live preset** 同构：14 个键，缺 hotLedgerMarkers / hotLedgerReplace（B4 的现场）。 */
const SAMPLE_14 = [
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
  "                  headroomTokens: 65536",
  "                  retainRatio: 0.16",
  "                  growthFloorTokens: 40000",
  "                  minFoldTokens: 8000",
  "                  summaryMode: hybrid",
  "                  maxTokens: 8192",
  "                  hotLedger: true",
  "                  hotLedgerMaxTokens: 500",
  "                  transposition: true",
  "                  tier2After: 8",
  "                  summarizationProvider: ''",
  "                  summarizationModel: ''",
  "              - id: command-compact",
  "                name: '@deepseek-ai/dsh-compact-command'",
  "",
].join("\n");

const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };

function tempHome(presetText = SAMPLE_14) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-ui-cfg-"));
  const presetDir = nodePath.join(dir, "preset-bundles", "personal-assistant");
  nodeFs.mkdirSync(presetDir, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "profiles", "desktop", "node_modules"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  const preset = nodePath.join(presetDir, "cordis.patch.yml");
  nodeFs.writeFileSync(preset, presetText, "utf8");
  return { home: dir, preset };
}

async function mount() {
  const uiMod = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href + "?cfg=" + Math.random());
  const routes = [];
  uiMod.apply({ webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" }, effect: (fn) => fn() });
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
        resolve({ status: this.status, raw: this.raw, json: safeJson(this.raw) });
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

function throwsWith(fn, needle, what) {
  let error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (error === null) throw new Error(`${what}：没有抛错（应该是红的）`);
  if (!String(error.message).includes(needle)) throw new Error(`${what}：错误信息里没有「${needle}」，得到 ${JSON.stringify(error.message)}`);
  return error;
}

export const tests = {};

/* ───────────────────────── B5 · 空串不是 0 ───────────────────────── */

tests["B5 · 纯函数：空串/空白/null 的数字字段一律报「不能为空」，绝不写 0"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    for (const [key, value] of [["growthFloorTokens", ""], ["hotLedgerMaxTokens", ""], ["tier2After", ""], ["growthFloorTokens", "   "], ["tier2After", null], ["maxTokens", undefined]]) {
      const error = throwsWith(() => uiMod.sanitizePatch({ [key]: value }), "不能为空", `sanitizePatch({${key}: ${JSON.stringify(value)}})`);
      if (!/增长闸|热清单预算|checkpoint 合并阈值|摘要输出上限/.test(error.message)) {
        throw new Error(`错误信息应含中文字段名，得到 ${JSON.stringify(error.message)}`);
      }
    }
    // 关键反例：旧实现里 Number("") === 0 会「通过」并被写成 0
    throwsWith(() => uiMod.sanitizePatch({ hotLedgerMaxTokens: "", tier2After: "" }), "不能为空", "整批空串");
  });
};

tests["B5 · 纯函数：非十进制/非数字字面量被拒，数字字符串被规整成数字"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    for (const bad of ["abc", "0x10", "1e3", "12px", {}, [], true]) {
      throwsWith(() => uiMod.sanitizePatch({ maxTokens: bad }), "必须是数字", `sanitizePatch({maxTokens: ${JSON.stringify(bad)}})`);
    }
    if (uiMod.sanitizePatch({ maxTokens: "8192" }).patch.maxTokens !== 8192) throw new Error("数字字符串应被转成数字 8192");
    if (typeof uiMod.sanitizePatch({ maxTokens: "8192" }).patch.maxTokens !== "number") throw new Error("规整后必须是 number（否则会以字符串写进 YAML）");
  });
};

tests["B5 · 纯函数：越界报错带中文字段名与范围"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const error = throwsWith(() => uiMod.sanitizePatch({ thresholdRatio: 0.96 }), "超出范围", "thresholdRatio 0.96");
    if (!error.message.includes("触发阈值")) throw new Error(`应含中文字段名，得到 ${JSON.stringify(error.message)}`);
    if (!error.message.includes("[0.05, 0.95]")) throw new Error(`应含范围，得到 ${JSON.stringify(error.message)}`);
    throwsWith(() => uiMod.sanitizePatch({ auto: "yes" }), "true / false", "auto:\"yes\"");
    if (uiMod.sanitizePatch({ auto: "false" }).patch.auto !== false) throw new Error(`auto:"false" 应规整成布尔 false`);
    throwsWith(() => uiMod.sanitizePatch({ summaryMode: "garbage" }), "摘要方式", "summaryMode 非法值");
  });
};

tests["B5 · HTTP：save({growthFloorTokens:''}) 必须 400，且 preset 里绝不出现 growthFloorTokens: 0"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { action: "save", patch: { growthFloorTokens: "" } });
    if (res.status !== 400) throw new Error(`空串应 400，得到 ${res.status}：${res.raw.slice(0, 160)}`);
    if (!String(res.json?.error ?? "").includes("不能为空")) throw new Error(`错误文本应说明不能为空，得到 ${JSON.stringify(res.json?.error)}`);
  });
  const after = nodeFs.readFileSync(preset, "utf8");
  if (/growthFloorTokens:\s*0\b/.test(after)) throw new Error("空串被写成了 0（B5 未修）");
  if (after !== before) throw new Error("被拒的保存改了文件");
};

tests["B5 · HTTP：合法数字字符串会被写成真数字（正例不能连带被拒）"] = async () => {
  const { home, preset } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { action: "save", patch: { maxTokens: "4096" } });
    if (res.status !== 200 || res.json?.ok !== true) throw new Error(`合法保存应 200，得到 ${res.status}/${JSON.stringify(res.json)}`);
  });
  const after = nodeFs.readFileSync(preset, "utf8");
  if (!/maxTokens:\s*4096\b/.test(after)) throw new Error(`应写成数字 4096，得到：${after.split("\n").filter((l) => l.includes("maxTokens")).join(" | ")}`);
  if (/maxTokens:\s*['"]4096['"]/.test(after)) throw new Error("写成字符串了");
};

/* ───────────────────────── B4 · 未配置键 = 生效值 ───────────────────────── */

tests["B4 · state.config 给生效值：缺 hotLedgerReplace/hotLedgerMarkers 时显示 true/semantic"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler, uiMod } = await mount();
    const res = await call(handler, { action: "state" });
    if (res.status !== 200) throw new Error(`state 应 200，得到 ${res.status}`);
    const { config, presetConfig, configOrigins, unconfiguredKeys } = res.json;
    // 现场复刻：文件里真的没有这两个键
    if ("hotLedgerReplace" in presetConfig) throw new Error("fixture 不该有 hotLedgerReplace");
    if ("hotLedgerMarkers" in presetConfig) throw new Error("fixture 不该有 hotLedgerMarkers");
    // 生效值必须与引擎一致
    if (config.hotLedgerReplace !== true) throw new Error(`生效值应为 true，得到 ${JSON.stringify(config.hotLedgerReplace)}`);
    if (config.hotLedgerMarkers !== "semantic") throw new Error(`生效值应为 semantic，得到 ${JSON.stringify(config.hotLedgerMarkers)}`);
    if (configOrigins.hotLedgerReplace !== "default" || configOrigins.hotLedgerMarkers !== "default") {
      throw new Error(`来源应标 default，得到 ${JSON.stringify(configOrigins)}`);
    }
    if (!unconfiguredKeys.includes("hotLedgerReplace") || !unconfiguredKeys.includes("hotLedgerMarkers")) {
      throw new Error(`未配置键应列出这两个，得到 ${JSON.stringify(unconfiguredKeys)}`);
    }
    if (unconfiguredKeys.includes("thresholdRatio")) throw new Error("thresholdRatio 在文件里有，不该算未配置");
    if (config.thresholdRatio !== 0.45 || configOrigins.thresholdRatio !== "preset") {
      throw new Error(`已配置键应原样回传并标 preset，得到 ${JSON.stringify([config.thresholdRatio, configOrigins.thresholdRatio])}`);
    }
    // 16 个可编辑键在 config 里必须齐全（页面据此渲染，缺一个就又是一次「空」）
    for (const key of Object.keys(uiMod.DEFAULTS)) {
      if (!(key in config)) throw new Error(`config 缺键 ${key}（页面会渲染成空）`);
      if (!(key in configOrigins)) throw new Error(`configOrigins 缺键 ${key}`);
    }
  });
};

tests["B4 · 文件里有但引擎不认的值：显示被净化后的生效值，来源标 sanitized"] = async () => {
  const dirty = SAMPLE_14
    .replace("summaryMode: hybrid", "summaryMode: garbage")
    .replace("tier2After: 8", "tier2After: 8\n                  hotLedgerMarkers: nonsense");
  const { home } = tempHome(dirty);
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { action: "state" });
    const { config, configOrigins } = res.json;
    if (config.summaryMode !== "hybrid") throw new Error(`非法 summaryMode 应净化成 hybrid，得到 ${JSON.stringify(config.summaryMode)}`);
    if (config.hotLedgerMarkers !== "semantic") throw new Error(`非法 hotLedgerMarkers 应净化成 semantic，得到 ${JSON.stringify(config.hotLedgerMarkers)}`);
    if (configOrigins.summaryMode !== "sanitized" || configOrigins.hotLedgerMarkers !== "sanitized") {
      throw new Error(`来源应标 sanitized，得到 ${JSON.stringify(configOrigins)}`);
    }
  });
};

tests["B4 · 引擎那条 retainRatio ≥ thresholdRatio 修正也照做（来源标 adjusted）"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const described = uiMod.describeConfig({ thresholdRatio: 0.45, retainRatio: 0.9 });
    const expected = Math.max(0.05, 0.45 - 0.05);
    if (described.effective.retainRatio !== expected) throw new Error(`应被修正为 ${expected}，得到 ${described.effective.retainRatio}`);
    if (described.origins.retainRatio !== "adjusted") throw new Error(`来源应标 adjusted，得到 ${described.origins.retainRatio}`);
    const normal = uiMod.describeConfig({ thresholdRatio: 0.45, retainRatio: 0.16 });
    if (normal.effective.retainRatio !== 0.16 || normal.origins.retainRatio !== "preset") throw new Error("正常值不该被动");
  });
};

/* ───────────────────────── B6 · 不静默丢 ───────────────────────── */

tests["B6 · HTTP：白名单外的键 → 400 + skipped 列表，且整单不写"] = async () => {
  const { home, preset } = tempHome();
  const before = nodeFs.readFileSync(preset, "utf8");
  await withHome(home, async () => {
    const { handler } = await mount();
    // retainTokens 是真实引擎键，但不在页面白名单里 —— 最容易被用户从别处抄过来的那种键
    const res = await call(handler, { action: "save", patch: { retainTokens: 20000, thresholdRatio: 0.5 } });
    if (res.status !== 400) throw new Error(`白名单外的键必须 400，得到 ${res.status}：${res.raw.slice(0, 160)}`);
    if (!Array.isArray(res.json?.skipped) || !res.json.skipped.includes("retainTokens")) throw new Error(`响应应带 skipped，得到 ${JSON.stringify(res.json?.skipped)}`);
    if (!String(res.json?.error ?? "").includes("retainTokens")) throw new Error(`错误文本应点名该键，得到 ${JSON.stringify(res.json?.error)}`);
  });
  const after = nodeFs.readFileSync(preset, "utf8");
  if (after !== before) throw new Error("被拒的保存改了 preset");
  if (after.includes("thresholdRatio: 0.5")) throw new Error("同单里的合法键也被写进去了（应当是整单拒绝）");
};

tests["B6 · saveConfig 默认严格：抛错并挂 .skipped；显式 strictKeys:false 才退回旧行为"] = async () => {
  const { home, preset } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const error = throwsWith(() => uiMod.saveConfig({ nopeKey: 1, thresholdRatio: 0.5 }, { home }), "不支持的配置键", "saveConfig 严格模式");
    if (!Array.isArray(error.skipped) || !error.skipped.includes("nopeKey")) throw new Error(`错误对象上应挂 skipped，得到 ${JSON.stringify(error.skipped)}`);
    const lenient = uiMod.saveConfig({ nopeKey: 1, thresholdRatio: 0.5 }, { home, strictKeys: false });
    if (lenient.changed.length !== 1) throw new Error("宽松模式应写入合法键");
    if (!lenient.skipped.includes("nopeKey")) throw new Error("宽松模式也应回传 skipped");
  });
  if (!/thresholdRatio:\s*0\.5/.test(nodeFs.readFileSync(preset, "utf8"))) throw new Error("宽松模式的合法键没写进去");
};

tests["B6 · 正常保存（全部已知键）不受影响，且回传 effectiveConfig/unconfiguredKeys"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { handler } = await mount();
    const res = await call(handler, { action: "save", patch: { hotLedgerReplace: false, hotLedgerMarkers: "terse", thresholdRatio: 0.5 } });
    if (res.status !== 200 || res.json?.ok !== true) throw new Error(`正常保存应 200，得到 ${res.status}/${JSON.stringify(res.json)}`);
    if (res.json.skipped.length !== 0) throw new Error(`不该有 skipped，得到 ${JSON.stringify(res.json.skipped)}`);
    if (res.json.effectiveConfig.hotLedgerReplace !== false) throw new Error("回传的生效值应含刚写入的 false");
    if (res.json.effectiveConfig.hotLedgerMarkers !== "terse") throw new Error("回传的生效值应含刚写入的 terse");
    if (!Array.isArray(res.json.unconfiguredKeys)) throw new Error("应回传 unconfiguredKeys");
    if (res.json.unconfiguredKeys.includes("hotLedgerReplace")) throw new Error("刚写过的键不该还在未配置列表里");
  });
};

/* ───────────────────────── 跨文件一致性（防再次漂移） ───────────────────────── */

tests["一致性 · host 的 DEFAULTS 必须与 engine.mjs 的 schema 默认值逐键相同"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    const engineSrc = nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
    const mismatches = [];
    for (const [key, value] of Object.entries(uiMod.DEFAULTS)) {
      const m = new RegExp(`^\\s{2}${key}:\\s*z\\.[^\\n]*?\\.default\\(([^)]*)\\)`, "m").exec(engineSrc);
      if (m === null) {
        mismatches.push(`${key}: engine.mjs 的 Config 里找不到带 default 的该键`);
        continue;
      }
      const literal = m[1].trim();
      if (literal !== JSON.stringify(value)) mismatches.push(`${key}: ui=${JSON.stringify(value)} engine=${literal}`);
    }
    if (mismatches.length > 0) throw new Error(`DEFAULTS 与 engine.mjs 漂移：\n  ${mismatches.join("\n  ")}`);
  });
};

tests["一致性 · 中文字段名与 client.js 的 FIELDS label 一致，且覆盖 DEFAULTS 全部键"] = async () => {
  const { home } = tempHome();
  await withHome(home, async () => {
    const { uiMod } = await mount();
    for (const key of Object.keys(uiMod.DEFAULTS)) {
      if (typeof uiMod.FIELD_LABELS[key] !== "string" || uiMod.FIELD_LABELS[key].length === 0) throw new Error(`FIELD_LABELS 缺 ${key}`);
    }
    const clientSrc = nodeFs.readFileSync(nodePath.join(ROOT, "lib", "client.js"), "utf8");
    const pairs = [...clientSrc.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
    if (pairs.length < 10) throw new Error(`没从 client.js 解析出字段表（得到 ${pairs.length} 条），断言会假绿`);
    const mismatches = pairs.filter(([key, label]) => uiMod.FIELD_LABELS[key] !== label).map(([key, label]) => `${key}: client=${label} host=${uiMod.FIELD_LABELS[key]}`);
    if (mismatches.length > 0) throw new Error(`字段名漂移：\n  ${mismatches.join("\n  ")}`);
  });
};
