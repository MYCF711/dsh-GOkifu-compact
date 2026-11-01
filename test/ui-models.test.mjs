/**
 * ui-models.test.mjs —— 页面「摘要模型」下拉的数据源：宿主已注册模型目录（U1）
 *
 * 架构前提（主人拍板）：**插件不自己存凭据、不自己接外部 API**。
 * 用户要用外部 API 就去 DSH 里加 provider，插件的下拉从**宿主已注册的模型目录**里自动长出来。
 * 所以 U1 的全部工作就是「只读宿主目录，聚合成稳定形状」，一行凭据都不碰。
 *
 * 宿主 API 事实（本次对着 `dsh-llm/lib/index.js` 逐行核过，不是照抄）：
 *   · `LlmRuntime.listProviders()` → `[{ id, name }]`（`[...adapters.values()].map(({provider}) => ({...provider}))`，
 *     而 registration 里的 provider 就是 `{id: info.id, name: info.name}`）——**不是**字符串数组。
 *   · `LlmRuntime.listModels(provider)` → `[{ provider, id, name, description?, inputModalities? }]`
 *     ——**没有窗口字段**；窗口只出现在 `resolveModelInfo(provider, model).context.contextWindow`
 *     （宿主对它做 `Number.isInteger(w) && w > 0` 校验）。⇒ 想要真窗口必须逐模型再问一次。
 *   · 服务名就是 `"llm"`（`LlmRuntime extends Service` 里 `super(ctx, "llm")`）。
 *
 * 本文件只测**降级行为**与**形状契约**：假的 llm 对象注入，不启动 DSH、不连任何 provider、不碰真实 home。
 * 覆盖：
 *   ① 两 provider × 若干模型 ⇒ 形状正确、排序稳定（provider 按 id、模型按 name）
 *   ② 某 provider 的 listModels 抛错 ⇒ 只跳过它，其它保留，不抛
 *   ③ listProviders 抛错 / 缺失 ⇒ {providers:[]}，不抛
 *   ④ 畸形模型（缺 id / 缺 name / 空串 / 非字符串）⇒ 过滤掉，不产出半截项
 *   ⑤ contextWindow 缺失/非法/查询抛错 ⇒ null（**绝不伪造数字**）；有则原样给出
 *   ⑥ 路由：`models` 动作与 `state.models` 给同一份目录；假 ctx 没有 llm ⇒ 空目录 + 200，不崩
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const TMP = nodePath.join(ROOT, "tmp");
const LOCAL_HEADERS = { host: "127.0.0.1:19387", "content-type": "application/json" };

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

function rmrf(p) {
  if (p && nodeFs.existsSync(p)) nodeFs.rmSync(p, { recursive: true, force: true });
}

/** 空 home（`state` 动作会扫 graph 目录，别让它去扫真实 home）。 */
function mkTempHome(label) {
  nodeFs.mkdirSync(TMP, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(TMP, `gokifu-ui-models-${label}-`));
}

/** 用 withHome 包住需要 DSH_HOME 的用例，结束后还原环境变量。 */
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

/**
 * 假 llm：只有 catalog 用到的三个方法，全部可注入行为。
 * @param {{providers?:any, listProviders?:Function, listModels?:Function, resolveModelInfo?:Function}} spec
 */
function fakeLlm(spec = {}) {
  const calls = { listProviders: 0, listModels: [], resolveModelInfo: [] };
  const llm = {};
  if (spec.listProviders !== undefined || spec.providers !== undefined) {
    llm.listProviders =
      spec.listProviders ??
      (() => {
        calls.listProviders += 1;
        return spec.providers;
      });
  }
  if (spec.listModels !== undefined) {
    llm.listModels = async (provider) => {
      calls.listModels.push(provider);
      return spec.listModels(provider);
    };
  } else {
    llm.listModels = async (provider) => {
      calls.listModels.push(provider);
      return [];
    };
  }
  if (spec.resolveModelInfo !== undefined) {
    llm.resolveModelInfo = async (provider, model) => {
      calls.resolveModelInfo.push(`${provider}/${model}`);
      return spec.resolveModelInfo(provider, model);
    };
  }
  return { llm, calls };
}

/** 挂一次真实 host 路由（与 ui-health/ui-config 同法：不启动 DSH）。 */
async function mount(ctxExtra = {}) {
  const uiMod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-models=${Math.random()}`);
  const routes = [];
  uiMod.apply({
    webServer: { register: (r) => (routes.push(r), () => {}), host: "127.0.0.1" },
    effect: (fn) => fn(),
    ...ctxExtra,
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

const catalogOf = async (spec) => {
  const { llm } = fakeLlm(spec);
  const mod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-models-cat=${Math.random()}`);
  return mod.modelCatalog(llm);
};

/* ───────────────────────── ① 形状与排序 ───────────────────────── */

tests["U1-1 两个 provider × 若干模型 ⇒ 形状正确、排序稳定（provider 按 id、模型按 name）"] = async (t) => {
  // 故意让 listProviders 给「乱序」、listModels 也给「乱序」，验证排序是我们做的而不是碰运气
  const result = await catalogOf({
    providers: [
      { id: "zeta", name: "Zeta 供应商" },
      { id: "alpha", name: "Alpha 供应商" },
    ],
    listModels: async (provider) =>
      provider === "zeta"
        ? [
            { provider: "zeta", id: "z-2", name: "B 模型" },
            { provider: "zeta", id: "z-1", name: "A 模型" },
          ]
        : [{ provider: "alpha", id: "a-1", name: "唯一模型" }],
    resolveModelInfo: async () => ({}),
  });

  t.eq(
    result,
    {
      providers: [
        { provider: "alpha", name: "Alpha 供应商", models: [{ id: "a-1", name: "唯一模型", contextWindow: null }] },
        {
          provider: "zeta",
          name: "Zeta 供应商",
          models: [
            { id: "z-1", name: "A 模型", contextWindow: null },
            { id: "z-2", name: "B 模型", contextWindow: null },
          ],
        },
      ],
    },
    "形状与排序：provider 按 id 升序、模型按 name 升序；字段只有 id/name/contextWindow",
  );
  // 稳定性：同一输入跑两次必须逐字相同（页面快照可测）
  const again = await catalogOf({
    providers: [
      { id: "zeta", name: "Zeta 供应商" },
      { id: "alpha", name: "Alpha 供应商" },
    ],
    listModels: async (provider) =>
      provider === "zeta"
        ? [
            { provider: "zeta", id: "z-2", name: "B 模型" },
            { provider: "zeta", id: "z-1", name: "A 模型" },
          ]
        : [{ provider: "alpha", id: "a-1", name: "唯一模型" }],
    resolveModelInfo: async () => ({}),
  });
  t.eq(again, result, "同一输入两次输出必须完全一致（排序稳定）");
  // 形状守卫：不许多带字段（U2 的 client 直接按这三个键取值）
  for (const p of result.providers) {
    t.eq(Object.keys(p).sort(), ["models", "name", "provider"], `provider 条目只许有 provider/name/models`);
    for (const m of p.models) t.eq(Object.keys(m).sort(), ["contextWindow", "id", "name"], `模型条目只许有 id/name/contextWindow`);
  }
};

/* ───────────────────────── ② 单 provider 失败 ───────────────────────── */

tests["U1-2 某 provider 的 listModels 抛错 ⇒ 只跳过它，其它保留、不抛"] = async (t) => {
  let thrown = null;
  let result = null;
  try {
    result = await catalogOf({
      providers: [{ id: "ok", name: "好的" }, { id: "boom", name: "坏的" }],
      listModels: async (provider) => {
        if (provider === "boom") throw new Error("provider 挂了（假）");
        return [{ provider: "ok", id: "m1", name: "模型一" }];
      },
      resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }),
    });
  } catch (error) {
    thrown = error;
  }
  t.eq(thrown, null, "单个 provider 抛错不许冒泡（页面不能崩）");
  t.eq(result, { providers: [{ provider: "ok", name: "好的", models: [{ id: "m1", name: "模型一", contextWindow: 128000 }] }] }, "只跳过坏的那个，好的照常给");
  // 反证：如果这条断言只是「碰巧」绿——把两个都弄坏，结果必须是空目录
  const allBad = await catalogOf({
    providers: [{ id: "b1", name: "坏1" }, { id: "b2", name: "坏2" }],
    listModels: async () => {
      throw new Error("全坏");
    },
  });
  t.eq(allBad, { providers: [] }, "全都失败 ⇒ 空目录（不是抛错、也不是半截）");
};

/* ───────────────────────── ③ 列 provider 就失败 ───────────────────────── */

tests["U1-3 listProviders 抛错 / 缺失 ⇒ {providers:[]}，不抛"] = async (t) => {
  const cases = [
    ["抛错", { listProviders: () => { throw new Error("列不出来（假）"); } }],
    ["返回 null", { listProviders: () => null }],
    ["返回非数组", { listProviders: () => ({ nope: true }) }],
  ];
  for (const [label, spec] of cases) {
    let thrown = null;
    let result = null;
    try {
      result = await catalogOf(spec);
    } catch (error) {
      thrown = error;
    }
    t.eq(thrown, null, `${label}：不许抛`);
    t.eq(result, { providers: [] }, `${label}：必须是空目录`);
  }
  // 没有 llm 服务 / 不是对象 ⇒ 同样空目录（fake ctx 的真实情况）
  for (const llm of [undefined, null, 42, "llm", {}]) {
    const mod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-models-cat=${Math.random()}`);
    let thrown = null;
    let result = null;
    try {
      result = await mod.modelCatalog(llm);
    } catch (error) {
      thrown = error;
    }
    t.eq(thrown, null, `llm=${String(llm)}：不许抛`);
    t.eq(result, { providers: [] }, `llm=${String(llm)}：空目录`);
  }
};

/* ───────────────────────── ④ 畸形模型过滤 ───────────────────────── */

tests["U1-4 畸形模型（缺 id/缺 name/空串/非字符串）⇒ 被过滤，不产出半截项"] = async (t) => {
  const result = await catalogOf({
    providers: [{ id: "p", name: "P" }],
    listModels: async () => [
      { provider: "p", id: "good-1", name: "好模型" },
      { provider: "p", id: "", name: "空 id" }, // 空串
      { provider: "p", name: "没有 id" }, // 缺 id
      { provider: "p", id: "no-name" }, // 缺 name
      { provider: "p", id: "empty-name", name: "" }, // 空 name
      { provider: "p", id: 42, name: "id 不是字符串" }, // 类型不对
      { provider: "p", id: "name-num", name: 7 }, // name 类型不对
      null,
      "字符串项",
      { provider: "p", id: "good-2", name: "另一个好模型" },
    ],
    resolveModelInfo: async () => ({}),
  });
  t.eq(
    result,
    {
      providers: [
        {
          provider: "p",
          name: "P",
          // 按 name 排序（这是契约）："另一个好模型" 排在 "好模型" 之前（en 排序规则下 另 < 好）
          models: [
            { id: "good-2", name: "另一个好模型", contextWindow: null },
            { id: "good-1", name: "好模型", contextWindow: null },
          ],
        },
      ],
    },
    "只留两条合法的；畸形项一个都不许漏出来",
  );
  // 反证：过滤不是「把整个 provider 丢掉」—— 合法的还在
  t.eq(result.providers.length, 1, "provider 本身保留");
  t.eq(result.providers[0].models.length, 2, "合法模型数 = 2");
  // provider 条目自身畸形 ⇒ 跳过该 provider（而不是产出 provider:null 之类的半截）
  const mixed = await catalogOf({
    providers: [{ id: "ok", name: "OK" }, { name: "没有 id 的 provider" }, null, "裸字符串 provider"],
    listModels: async () => [],
  });
  t.eq(mixed.providers.map((p) => p.provider), ["ok", "裸字符串 provider"], "provider 缺 id 的跳过；裸字符串按 id 容忍");
};

/* ───────────────────────── ⑤ contextWindow ───────────────────────── */

tests["U1-5 contextWindow：缺失/非法/查询抛错 ⇒ null（绝不伪造数字）；合法则原样给出"] = async (t) => {
  const result = await catalogOf({
    providers: [{ id: "p", name: "P" }],
    listModels: async () => [
      { provider: "p", id: "has-window", name: "有窗口" },
      { provider: "p", id: "no-context", name: "无 context" },
      { provider: "p", id: "bad-zero", name: "窗口 0" },
      { provider: "p", id: "bad-float", name: "窗口 1.5" },
      { provider: "p", id: "bad-string", name: "窗口字符串" },
      { provider: "p", id: "boom", name: "查询会抛" },
    ],
    resolveModelInfo: async (_provider, model) => {
      if (model === "has-window") return { context: { contextWindow: 1000000 } };
      if (model === "no-context") return {};
      if (model === "bad-zero") return { context: { contextWindow: 0 } };
      if (model === "bad-float") return { context: { contextWindow: 1.5 } };
      if (model === "bad-string") return { context: { contextWindow: "1000000" } };
      throw new Error(`模型 ${model} 查不到（假）`);
    },
  });
  const byId = Object.fromEntries(result.providers[0].models.map((m) => [m.id, m.contextWindow]));
  t.eq(byId["has-window"], 1000000, "合法窗口原样给出");
  for (const id of ["no-context", "bad-zero", "bad-float", "bad-string", "boom"]) {
    t.eq(byId[id], null, `${id} 拿不到合法窗口 ⇒ null（绝不写死 1000000 那种假数字）`);
  }
  // 反证：没有任何一项是「被编造的正数」——除了唯一那个真给的
  const forged = result.providers[0].models.filter((m) => m.contextWindow !== null && m.id !== "has-window");
  t.eq(forged, [], "除了真的有窗口那条，其余不许有任何数字");
  // 没有 resolveModelInfo 方法（老宿主/假对象）⇒ 全部 null，但仍要列出模型
  const noInfo = await catalogOf({
    providers: [{ id: "p", name: "P" }],
    listModels: async () => [{ provider: "p", id: "m", name: "模型" }],
  });
  t.eq(noInfo.providers[0].models, [{ id: "m", name: "模型", contextWindow: null }], "没有 resolveModelInfo ⇒ 模型照样列出、窗口 null");
};

/* ───────────────────────── ⑥ 路由接线 ───────────────────────── */

tests["U1-6 路由：models 动作与 state.models 给同一份目录；假 ctx 没有 llm ⇒ 空目录 + 200，不崩"] = async (t) => {
  await withHome("route", async () => {
    const { llm } = fakeLlm({
      providers: [{ id: "magpie", name: "Magpie" }],
      listModels: async () => [{ provider: "magpie", id: "group/deepseek-v4.1-flash1017", name: "V4.1 Flash" }],
      resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }),
    });
    const expected = {
      providers: [
        { provider: "magpie", name: "Magpie", models: [{ id: "group/deepseek-v4.1-flash1017", name: "V4.1 Flash", contextWindow: 1000000 }] },
      ],
    };

    const { handler, uiMod } = await mount({ llm });
    t.eq(uiMod.inject, ["webServer", "llm"], "inject 必须声明 llm（否则拿不到宿主目录）");

    const modelsRes = await call(handler, { action: "models" });
    t.eq(modelsRes.status, 200, "models 动作 200");
    t.eq(modelsRes.json?.ok, true, "ok:true");
    t.eq(modelsRes.json?.models, expected, "models 动作给的是聚合目录");
    t.ok(typeof modelsRes.json?.at === "string" && !Number.isNaN(Date.parse(modelsRes.json.at)), "带 ISO 时间戳（页面可显示刷新时间）");

    const stateRes = await call(handler, { action: "state" });
    t.eq(stateRes.status, 200, "state 动作 200");
    t.eq(stateRes.json?.models, expected, "state 也带同一份 models（首屏一次拿全）");
    // 既有字段语义不许动：抽查几个老字段仍在
    for (const key of ["ok", "config", "defaults", "fieldLabels", "health", "latest", "today", "profile"]) {
      t.ok(Object.hasOwn(stateRes.json ?? {}, key), `state 既有字段仍在：${key}`);
    }

    // 假 ctx 没有 llm（所有既有 ui*.test.mjs 就是这样挂的）⇒ 空目录、200、不崩
    const { handler: bare } = await mount();
    const bareModels = await call(bare, { action: "models" });
    t.eq(bareModels.status, 200, "无 llm 时 models 动作仍 200");
    t.eq(bareModels.json?.models, { providers: [] }, "无 llm ⇒ 空目录");
    const bareState = await call(bare, { action: "state" });
    t.eq(bareState.status, 200, "无 llm 时 state 仍 200");
    t.eq(bareState.json?.models, { providers: [] }, "无 llm ⇒ state.models 空目录");

    // 未知动作仍按老规矩 400（没被新分支吃掉）
    const unknown = await call(bare, { action: "nope" });
    t.eq(unknown.status, 400, "未知 action 仍是 400");
  });
};

/* ───────────────────────── ⑦ 时间预算（不许挂死首屏） ───────────────────────── */

tests["U1-7 宿主调用卡住 ⇒ 降级而不是挂死：provider 层超时=空目录、窗口超时=null、只跳过卡住的那个"] = async (t) => {
  const mod = await import(`${pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href}?ui-models-timeout=${Math.random()}`);
  const hang = () => new Promise(() => {});

  // (a) 连 listProviders 都不回 ⇒ 空目录，且在时间预算附近返回（不是等到天荒地老）
  const started = Date.now();
  const result = await mod.modelCatalog({ listProviders: hang }, { timeBudgetMs: 25 });
  const elapsed = Date.now() - started;
  t.eq(result, { providers: [] }, "listProviders 卡住 ⇒ 空目录");
  t.ok(elapsed < 2000, `必须在时间预算附近返回（实测 ${elapsed}ms，预算 25ms）`);

  // (b) 只卡窗口查询 ⇒ 模型照列、窗口 null（整条消失等于把能选的模型藏了）
  const partial = await mod.modelCatalog(
    {
      listProviders: () => [{ id: "p", name: "P" }],
      listModels: async () => [{ provider: "p", id: "slow", name: "慢模型" }],
      resolveModelInfo: hang,
    },
    { timeBudgetMs: 25 },
  );
  t.eq(
    partial,
    { providers: [{ provider: "p", name: "P", models: [{ id: "slow", name: "慢模型", contextWindow: null }] }] },
    "窗口查询卡住 ⇒ 该项 contextWindow 为 null，模型本身仍列出",
  );

  // (c) 某个 provider 的 listModels 卡住 ⇒ 只跳过它，好的照常
  const skipped = await mod.modelCatalog(
    {
      listProviders: () => [
        { id: "hang", name: "卡住的" },
        { id: "ok", name: "好的" },
      ],
      listModels: async (provider) => (provider === "hang" ? hang() : [{ provider: "ok", id: "m", name: "M" }]),
      resolveModelInfo: async () => ({}),
    },
    { timeBudgetMs: 25 },
  );
  t.eq(skipped.providers.map((p) => p.provider), ["ok"], "listModels 卡住的 provider 只跳过它");
};
