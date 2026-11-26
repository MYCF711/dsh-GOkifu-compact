/**
 * ui-layout.test.mjs —— 客户端 UI 的「布局 / 窗口来源 / 模型下拉 / 滚动容器 / 焦点环」回归（U2，2026-11-01）
 *
 * 为什么这样测：`lib/client.js` 是**浏览器端 classic script**（`window.__ModuleLoader__.load` 工厂），
 * 没有 DOM，也不该在 Node 里渲染 React。所以这里只做两件事：
 *   ① 用 `new Function("window", src)` 加载真文件（与 test/ui.test.mjs 同法），把 factory 执行出来的
 *      `exports.__testables` 拿去断**纯逻辑**：双栏断点 1279/1280、窗口来源、模型分组、降级判定；
 *   ② 对源码/样式常量做**防回退**断言（滚动容器必须 overflowY:auto + minHeight:0；焦点环必须覆盖所有
 *      可交互元素；matchMedia 订阅必须在卸载时 removeEventListener）—— 防以后有人把这些改回去。
 *
 * 覆盖主人拍板的五件事：
 *   ① 宽屏双栏（≥1280px）       → layoutFor / styles.columns / VIEWPORT_QUERY
 *   ② 滚动容器（P0 滚不动）      → styles.page 的 height/minHeight/boxSizing/overflowY/overflowX
 *   ③ 焦点环（pointer 模态看不见）→ focusRing 的 onFocus/onBlur + 所有控件必须经 focusable() 渲染
 *   ④ 摘要模型两级下拉 + 降级     → modelGroups / modelsAvailable（label 回退 id；空目录 ⇒ 自由文本）
 *   ⑤ 去掉假的 100 万窗口        → resolveWindowTokens（选中模型 → 第一个有窗口 → null）
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");

/** 与 test/ui.test.mjs 同法加载 client bundle（classic script，只注入 window）。 */
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
  return { src, loaded, mod };
}

const { src: CLIENT_SRC, loaded: LOADED, mod: MOD } = loadClientBundle();
const T = MOD.__testables;

/** 模型目录夹具（= U1 在 state.models 里给的契约形状）。 */
const MODELS = {
  providers: [
    {
      provider: "deepseek",
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 200000 },
        { id: "deepseek-lite", name: "DeepSeek Lite", contextWindow: null },
      ],
    },
    {
      provider: "magpie",
      name: "",
      models: [{ id: "magpie-128k", name: "", contextWindow: 128000 }],
    },
  ],
};

export const tests = {
  "① 双栏断点：1279 单栏 / 1280 双栏（边界逐像素），并保留 __ModuleLoader__ 契约"(t) {
    // 模块契约不能变（宿主靠 id 找 bundle、靠 apply 注册槽位）
    t.eq(LOADED.id, "dsh-gokifu-compact", "模块 id 必须保持包名");
    t.eq(MOD.name, "gokifu-compact-ui", "exports.name 不能变");
    t.ok(Array.isArray(MOD.inject) && MOD.inject.includes("slots"), "inject 仍要含 slots");
    t.eq(typeof MOD.apply, "function", "apply 必须是函数");

    t.eq(T.TWO_COLUMN_MIN_WIDTH, 1280, "断点是 1280px");
    t.eq(T.VIEWPORT_QUERY, "(min-width: 1280px)", "matchMedia 查询串与断点同源");
    t.eq(T.layoutFor(1279), "single-col", "1279px 必须单栏");
    t.eq(T.layoutFor(1280), "two-col", "1280px 必须双栏");
    t.eq(T.layoutFor(1920), "two-col", "宽屏双栏");
    t.eq(T.layoutFor(800), "single-col", "窄屏单栏");
    t.eq(T.layoutFor(undefined), "single-col", "拿不到视口宽度时按单栏（不许猜双栏）");
    t.eq(T.layoutFor(Number.NaN), "single-col", "NaN 按单栏");
    t.eq(T.layoutFor("1280"), "single-col", "字符串不做隐式转换（宁可单栏）");
    // 布局样式：grid 两栏 + 左 1.15fr / 右 1fr + gap 20
    t.eq(T.styles.columns.gridTemplateColumns, "minmax(0, 1.15fr) minmax(0, 1fr)", "双栏 grid 列宽");
    t.eq(T.styles.columns.gap, T.SPACING.section, "两栏间距（U4 收敛到分区级 16）");
    t.eq(T.styles.columnLeft.gridColumn, "1", "左栏（配置）在 grid 第 1 列");
    t.eq(T.styles.columnRight.gridColumn, "2", "右栏（指标/状态）在 grid 第 2 列");
    // matchMedia 订阅必须在卸载时 removeEventListener（要求里点名）
    t.includes(CLIENT_SRC, 'addEventListener("change"', "必须订阅 matchMedia change");
    t.includes(CLIENT_SRC, 'removeEventListener("change"', "卸载必须 removeEventListener");
  },

  "② 滚动容器（P0）：styles.page 必须有 height:100% / minHeight:0 / boxSizing / overflowY:auto / overflowX:hidden（防回退）"(t) {
    const page = T.styles.page;
    t.eq(page.overflowY, "auto", "内容超高要能滚（宿主外层 overflow:hidden）");
    t.eq(page.minHeight, 0, "flex 子项 minHeight:0 才允许收缩出滚动");
    t.eq(page.height, "100%", "撑满宿主给的槽位高度");
    t.eq(page.boxSizing, "border-box", "padding 不许把高度算爆");
    t.eq(page.overflowX, "hidden", "只纵向滚，横向不出滚动条");
    // 宽屏限制：不再 980px 单栏，改 1600 + 居中
    t.eq(page.maxWidth, "1600px", "根容器 maxWidth 1600");
    t.eq(page.margin, "0 auto", "超宽屏居中");
    t.notIncludes(String(page.maxWidth), "980", "不许退回 980px");
    // 两栏容器不许自己加 overflow（整页滚动）
    t.eq(T.styles.columns.overflowY, undefined, "两栏不各自滚动（整页滚动）");
    t.eq(T.styles.columnLeft.overflowY, undefined, "左栏不各自滚动");
    t.eq(T.styles.columnRight.overflowY, undefined, "右栏不各自滚动");
  },

  "③ 焦点环：onFocus/onBlur 切 outline，且所有可交互元素都经 focusable() 渲染（静态覆盖）"(t) {
    t.eq(T.FOCUS_OUTLINE, "2px solid #4c8dff", "焦点环颜色/宽度按主人要求");
    // 真跑一遍 handler（不依赖 DOM：fake element 只需要 .style）
    const ring = T.focusRing();
    const el = { style: {} };
    ring.onFocus({ currentTarget: el });
    t.eq(el.style.outline, "2px solid #4c8dff", "聚焦时加外框");
    t.eq(el.style.outlineOffset, "2px", "聚焦时留 offset");
    ring.onBlur({ currentTarget: el });
    t.eq(el.style.outline, "none", "失焦还原");
    t.eq(el.style.outlineOffset, "", "失焦清 offset");
    // 覆盖所有可交互元素：源码里不许有裸的 h("input"/"select"/"textarea"/"button")
    for (const tag of ["input", "select", "textarea", "button"]) {
      t.notIncludes(CLIENT_SRC, `h("${tag}"`, `可交互元素 ${tag} 必须走 focusable()（裸写 = 没焦点环）`);
    }
    // focusable 必须把 children 透传下去（否则 select 的 option / button 的文案会被吞掉 —— 真踩过）
    // 本文件的 react 桩是 `createElement: (...args) => ({ args })`，所以看 args：[tag, props, ...children]
    const sample = T.focusable("select", { value: "x" }, "跟随当前路由", { tag: "option", props: {}, children: [] });
    t.eq(sample.args[0], "select", "focusable 返回对应原生标签");
    t.eq(sample.args[1].value, "x", "focusable 透传 props");
    t.eq(sample.args.length, 4, "focusable 必须把 children 透传（option/按钮文案不许被吞）");
    t.eq(typeof sample.args[1].onFocus, "function", "focusable 必须挂 onFocus");
    t.eq(typeof sample.args[1].onBlur, "function", "focusable 必须挂 onBlur");
    const focusableUses = (CLIENT_SRC.match(/focusable\(/g) ?? []).length;
    t.ok(focusableUses >= 8, `focusable() 覆盖数太少（${focusableUses} 处）`);
    for (const tag of ["input", "select", "button"]) {
      t.includes(CLIENT_SRC, `focusable("${tag}"`, `必须真的用 focusable 渲染 ${tag}`);
    }
  },

  "④ 摘要模型两级下拉：模型分组 + label 回退 id + 目录为空降级自由文本"(t) {
    const groups = T.modelGroups(MODELS);
    t.eq(groups.length, 2, "两个 provider 两组");
    t.eq(groups[0].provider, "deepseek", "保留 provider id 作为 value");
    t.eq(groups[0].label, "DeepSeek", "provider label 用 name");
    t.eq(groups[1].label, "magpie", "provider name 缺失 ⇒ label 回退 id");
    t.eq(groups[0].models[0].value, "deepseek-v4", "模型 value 用 id");
    t.eq(groups[0].models[0].label, "DeepSeek V4", "模型 label 用 name");
    t.eq(groups[1].models[0].label, "magpie-128k", "模型 name 缺失 ⇒ label 回退 id");
    t.eq(groups[1].models[0].contextWindow, 128000, "contextWindow 透传");
    t.eq(groups[0].models[1].contextWindow, null, "null 窗口保持 null（不猜）");
    // 降级判定：目录为空/缺字段/畸形 ⇒ 自由文本
    t.eq(T.modelsAvailable(undefined), false, "没有 models 字段 ⇒ 降级");
    t.eq(T.modelsAvailable(null), false, "null ⇒ 降级");
    t.eq(T.modelsAvailable({}), false, "空对象 ⇒ 降级");
    t.eq(T.modelsAvailable({ providers: [] }), false, "空 providers ⇒ 降级");
    t.eq(T.modelsAvailable({ providers: [{ provider: "", models: [] }] }), false, "provider 没 id ⇒ 降级");
    t.eq(T.modelsAvailable(MODELS), true, "有目录 ⇒ 用下拉");
    t.eq(T.modelGroups({ providers: [] }), [], "空目录分组为空");
    // 字段定义仍是 where:"preset" 的两个字符串键（kind 保持 text 作为降级形态）
    const providerField = T.FIELDS.find((f) => f.key === "summarizationProvider");
    const modelField = T.FIELDS.find((f) => f.key === "summarizationModel");
    t.ok(providerField !== undefined && modelField !== undefined, "两个摘要模型字段必须还在");
    t.eq(providerField.kind, "text", "降级形态仍是文本输入");
    // 源码里确实有降级分支的提示语 + 「刷新模型列表」轻操作（U1 的目录可能走网络，首屏不该被它挡住）
    t.includes(CLIENT_SRC, "模型目录未取到，可手填", "降级时要有可读提示");
    t.includes(CLIENT_SRC, 'callApi("models")', "必须能单独刷新模型目录（action:\"models\"）");
    t.includes(CLIENT_SRC, "刷新模型列表", "目录为空时要有刷新按钮");
    t.includes(CLIENT_SRC, "modelsBusy", "刷新目录不能和保存/加载抢同一个 busy");
  },

  "⑤ 窗口来源：选中模型 → 目录里第一个有 contextWindow 的 → null（不再写死 1000000）"(t) {
    t.eq(T.resolveWindowTokens(MODELS, "deepseek", "deepseek-v4"), 200000, "命中选中模型");
    t.eq(T.resolveWindowTokens(MODELS, "magpie", "magpie-128k"), 128000, "另一个 provider 的模型");
    t.eq(T.resolveWindowTokens(MODELS, "deepseek", "deepseek-lite"), 200000, "选中的没窗口 ⇒ 回退第一个有窗口的");
    t.eq(T.resolveWindowTokens(MODELS, "", ""), 200000, "未选模型（跟随路由）⇒ 回退第一个有窗口的");
    t.eq(T.resolveWindowTokens(MODELS, "不存在", "也没有"), 200000, "选了目录外的值 ⇒ 仍回退第一个有窗口的");
    const noWindow = { providers: [{ provider: "p", name: "P", models: [{ id: "m", name: "M", contextWindow: null }] }] };
    t.eq(T.resolveWindowTokens(noWindow, "p", "m"), null, "都拿不到窗口 ⇒ null（页面显示 — 且隐藏进度条）");
    t.eq(T.resolveWindowTokens(undefined, "p", "m"), null, "没有目录 ⇒ null");
    // 防回退：源码里不许再出现写死的 1000000
    t.notIncludes(CLIENT_SRC, "windowTokens = 1000000", "不许再写死 100 万窗口");
    t.notIncludes(CLIENT_SRC, "const windowTokens = 1000000", "不许再写死 100 万窗口");
    t.includes(CLIENT_SRC, "resolveWindowTokens(models", "进度条分母必须来自模型目录（独立 models state）");
  },

  "⑥ U4-① 窄屏字段行：<600px 两行、>=600px 三列（599/600 边界），resize 订阅可卸载"(t) {
    t.eq(T.FIELD_STACK_BELOW_WIDTH, 600, "字段行断点 600（<600 ⇒ label 上、控件下）");
    t.eq(T.fieldGridFor(599).stacked, true, "599px 必须两行");
    t.eq(T.fieldGridFor(600).stacked, false, "600px 恢复三列");
    t.eq(T.fieldGridFor(1280).stacked, false, "宽屏三列");
    t.eq(T.fieldGridFor(undefined).stacked, true, "拿不到宽度按窄屏（宁可两行，也不把控件挤扁）");
    t.eq(T.fieldGridFor(Number.NaN).stacked, true, "NaN 按窄屏");
    t.eq(T.fieldGridFor(1280).style.gridTemplateColumns, "1fr 220px 120px", "宽屏列定义不变");
    t.eq(T.fieldGridFor(599).style.gridTemplateColumns, "minmax(0, 1fr)", "窄屏单列（label/控件/默认值各占一行）");
    t.eq(T.fieldGridFor(599).style.gap, T.SPACING.micro, "窄屏行距 = 4（微间距档）");
    t.eq(T.fieldGridFor(1280).style.gap, T.SPACING.card, "宽屏行距 = 8（卡片档）");
    // resize 订阅必须能卸载（与双栏的 matchMedia 一样不许泄漏）
    t.includes(CLIENT_SRC, 'addEventListener("resize"', "必须订阅 resize 才能拿到真实像素");
    t.includes(CLIENT_SRC, 'removeEventListener("resize"', "卸载必须 removeEventListener");
    t.includes(CLIENT_SRC, "fieldGridFor(viewportWidth)", "Page 必须按真实视口宽度算字段行");
  },

  "⑦ U4-② 长模型名/长 id：select 与文本输入都有 title（悬停看全名）"(t) {
    t.eq(T.describeProviderSelection(MODELS, "deepseek"), "DeepSeek", "provider title 用显示名");
    t.eq(T.describeProviderSelection(MODELS, "magpie"), "magpie", "provider name 缺 ⇒ 回退 id");
    t.eq(T.describeProviderSelection(MODELS, "nope"), "", "未知 provider ⇒ 空串（调用方回退）");
    const withWindow = T.describeModelSelection(MODELS, "deepseek", "deepseek-v4");
    t.includes(withWindow, "DeepSeek V4", "模型 title 含 name");
    t.includes(withWindow, "tok", "模型 title 带 contextWindow");
    t.eq(T.describeModelSelection(MODELS, "deepseek", "deepseek-lite"), "DeepSeek Lite", "窗口 null ⇒ 只显示名字（不伪造）");
    t.eq(T.describeModelSelection(MODELS, "deepseek", "nope"), "", "未知模型 ⇒ 空串");
    // 源码层：select / 文本输入确实挂了 title
    t.includes(CLIENT_SRC, "describeProviderSelection(models, current)", "provider select 的 title 接纯函数");
    t.includes(CLIENT_SRC, "describeModelSelection(models, providerId, current)", "model select 的 title 接纯函数");
    t.includes(CLIENT_SRC, "title: String(value ?? \"\") === \"\" ? \"留空 = 跟随路由\" : String(value)", "文本输入也要 title");
    const titleCount = (CLIENT_SRC.match(/title:/g) ?? []).length;
    t.ok(titleCount >= 4, `title 至少 4 处（select×3 + 文本输入），实际 ${titleCount}`);
  },

  "⑧ U4-③ 标题行显示当前 profile（只读 host 已有字段；health 优先于 state）"(t) {
    t.eq(T.profileLabel({ profile: "desktop" }, { profile: "web" }), "web", "health.profile 优先");
    t.eq(T.profileLabel({ profile: "desktop" }, null), "desktop", "health 没给 ⇒ 用 state.profile");
    t.eq(T.profileLabel({ profile: "desktop" }, {}), "desktop", "health 空对象 ⇒ 用 state.profile");
    t.eq(T.profileLabel({}, null), "—", "都没有 ⇒ —");
    t.eq(T.profileLabel(null, null), "—", "state 为 null 也不抛");
    t.eq(T.profileLabel(null, { profile: "" }), "—", "空串不当默认值");
    t.includes(CLIENT_SRC, "profileLabel(state, health)", "标题行与状态卡共用同一 profile 来源");
    t.includes(CLIENT_SRC, "styles.headerMeta", "宽屏标题行右侧要有 profile 区（右上方不再空）");
    // 只读 host 字段：不得为此新增接口调用
    // ★ C234：白名单补 `backfill`（补账是面板的真功能，服务端 C216 起就有这个 action；
    // `update` 走的是自己的 requestUpdate，不经过 callApi；其余新 action 仍会被这条抓住。
    t.eq((CLIENT_SRC.match(/callApi\("(?!state|models|save|defaults|backfill)/g) ?? []).length, 0, "不许为 profile 新增 host 接口");
  },

  "⑨ U4-④ gap 收敛：全站只有 4/8/12/16 四档（以后新加一个 gap 值会被抓）"(t) {
    t.eq(T.SPACING, { section: 16, card: 8, inline: 12, micro: 4 }, "间距尺度固定四档");
    const allowed = new Set(Object.values(T.SPACING));
    const gaps = [];
    const walk = (value, at) => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => walk(child, `${at}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "gap" && typeof child === "number") gaps.push({ at, value: child });
        else if (typeof child === "object") walk(child, `${at}.${key}`);
      }
    };
    walk(T.styles, "styles");
    walk(T.fieldGridFor(1280).style, "fieldGrid(1280)");
    walk(T.fieldGridFor(599).style, "fieldGrid(599)");
    t.ok(gaps.length >= 8, `至少扫到 8 个 gap（实际 ${gaps.length}）`);
    for (const { at, value } of gaps) t.ok(allowed.has(value), `${at} 的 gap=${value} 不在 4/8/12/16 档内`);
    // 三层节奏必须一致：页面/分区级 = 16，卡片内 = 8
    t.eq(T.styles.page.gap, T.SPACING.section, "根容器 = 分区级 16");
    t.eq(T.styles.columns.gap, T.SPACING.section, "两栏之间 = 分区级 16");
    t.eq(T.styles.columnLeft.gap, T.SPACING.section, "栏内卡片之间 = 分区级 16");
    t.eq(T.styles.columnRight.gap, T.SPACING.section, "右栏同样是分区级 16");
    t.eq(T.styles.card.gap, T.SPACING.card, "卡片内部 = 8");
    // 收敛前的旧值一个都不许回来
    for (const legacy of [18, 20, 26, 10, 2]) {
      t.ok(!gaps.some((entry) => entry.value === legacy), `gap=${legacy} 是收敛前的旧值，不许回来`);
    }
  },
};

/**
 * ★ C269：卡片「定义了但没摆进布局」是本仓库最容易犯的错 ——
 *   `backfillCard` 是我手加进 `rightColumn` 的；下一次有人加卡片忘了这一步，面板上看不见任何异常，
 *   只是**功能凭空消失**。这里用静态断言把「定义 + 摆位」成对钉住。
 */
tests["C269 每张右栏卡片都必须既定义、又出现在 rightColumn 里（否则功能静默消失）"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "lib", "client.js"), "utf8");
  const layout = src.match(/const rightColumn = \[([^\]]*)\]/);
  t.eq(layout !== null, true, "必须有 rightColumn 布局数组");
  const placed = layout[1].split(",").map((x) => x.trim()).filter(Boolean);

  for (const card of ["statusCard", "updateCard", "backfillCard", "latestCard", "todayCard"]) {
    t.eq(new RegExp(`const ${card} =`).test(src), true, `${card} 必须被定义`);
    t.eq(placed.includes(card), true, `${card} 被定义了却没进 rightColumn —— 面板上看不见它`);
  }
  // 反向：布局里不许有不存在的变量（拼错名字 ⇒ 运行时 undefined）
  for (const name of placed) {
    t.eq(new RegExp(`const ${name} =`).test(src), true, `rightColumn 里的 ${name} 没有对应定义（拼错了？）`);
  }
};

/**
 * ★ C270：面板承诺的每个 action，服务端都必须真的认。
 *   反向（服务端有、面板不调）允许存在，但必须是**已知允许列表** ——
 *   新增一个没人调的服务端 action，要么补面板，要么明确加进允许列表并写原因。
 */
tests["C270 面板调的每个 action 服务端都必须认；服务端多余 action 要有明确允许"] = (t) => {
  const client = nodeFs.readFileSync(nodePath.join(HERE, "..", "lib", "client.js"), "utf8");
  const server = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "ui.mjs"), "utf8");

  const called = new Set([
    ...[...client.matchAll(/callApi\("([a-z]+)"/g)].map((m) => m[1]),
    ...[...client.matchAll(/action:\s*"([a-z]+)"/g)].map((m) => m[1]),
  ]);
  const served = new Set([...server.matchAll(/action === "([a-z]+)"/g)].map((m) => m[1]));

  t.eq(called.size > 0, true, "必须能解析出客户端调用的 action（正则失配会让这条永远绿）");
  for (const name of called) {
    t.eq(served.has(name), true, `面板调用了 ${name}，但服务端没有这个 action（点了会 404/未知 action）`);
  }
  // 服务端有、面板不用的：只允许这两个已知项（它们已并入 state 载荷）
  const ALLOWED_SERVER_ONLY = new Set(["defaults", "health"]);
  for (const name of served) {
    if (ALLOWED_SERVER_ONLY.has(name)) continue;
    t.eq(called.has(name), true, `服务端有 action "${name}" 但面板从不调用 —— 要么补面板，要么加进允许列表并写原因`);
  }
};

tests["⑨ C510 假 React 必须提供客户端用到的每个 hook（否则渲染类测试假绿）"] = (t) => {
  const hooks = new Set([...CLIENT_SRC.matchAll(/\b(use[A-Z][A-Za-z]*)\s*\(/g)].map((x) => x[1]));
  const local = new Set([
    ...[...CLIENT_SRC.matchAll(/function\s+(use[A-Z][A-Za-z]*)\s*\(/g)].map((x) => x[1]),
    ...[...CLIENT_SRC.matchAll(/const\s+(use[A-Z][A-Za-z]*)\s*=/g)].map((x) => x[1]),
  ]);
  const fakeSrc = nodeFs.readFileSync(nodePath.join(HERE, "ui-layout.test.mjs"), "utf8");
  // 不用正则：避免 `` 在模板串里被当成退格符（这个坑今天已经踩两次）
  const missing = [...hooks].filter((name) => !local.has(name) && !fakeSrc.includes(`${name}:`));
  t.eq(missing, [], `假 React 缺这些 hook：${missing.join(", ")}`);
};

/* ───── C688：面板字段表 = 手写表 + host 下发的新键（消灭"新键不出现在面板"） ───── */

tests["C688 面板只补 host 有、手写表没有的键；已手写的键零变化"] = async (t) => {
  const x = T;
  const fields = x.FIELDS.map((f) => f.key);

  // ① 空 state ⇒ 一个都不补（既有行为逐字不变）
  t.eq(x.fieldsFromState(undefined).length, 0, "没有 state 时不许凭空造字段");
  t.eq(x.fieldsFromState({}).length, 0, "没有 fields 时不许补");
  t.eq(x.fieldsFromState({ fields: [] }).length, 0, "空数组不补");

  // ② 手写表已有的键 ⇒ 不重复补（面板的呈现决策由面板说了算）
  const dup = x.fieldsFromState({ fields: [{ key: fields[0], label: "HOST", type: "number", range: [0, 1], where: "preset" }] });
  t.eq(dup.length, 0, `手写表已有的键 ${fields[0]} 不许被 host 覆盖`);

  // ③ host 有、手写表没有的键 ⇒ 补进来，且 min/max 取 host 的 range
  const added = x.fieldsFromState({
    fields: [{ key: "__c688_new_key__", label: "新键", type: "number", range: [0.05, 0.95], where: "preset", desc: "说明" }],
  });
  t.eq(added.length, 1, "host 独有的键必须补进面板");
  t.eq(added[0].min, 0.05, "min 必须取 host 的 range[0]");
  t.eq(added[0].max, 0.95, "max 必须取 host 的 range[1]");
  t.eq(added[0].step, 0.01, "小数域必须给小数步长（否则面板只能选整数）");
  t.eq(added[0].label, "新键", "label 取 host 的");
};

tests["C688 只读键（host 不认保存的）不许进面板 —— 否则又是一个填了不生效的控件"] = async (t) => {
  const x = T;
  const engineKey = x.fieldsFromState({ fields: [{ key: "__c688_engine_only__", label: "只读", type: "number", range: [0, 10], where: "engine" }] });
  t.eq(engineKey.length, 0, `where:"engine" 的键面板不可写，不许渲染成控件`);
};

/* ───── C690：数值域以 host 为准（面板不许放行会被 host 400 的值） ───── */

tests["C690 面板手写的 min/max 必须被 host 的 range 覆盖（3 处 host 更严的历史问题）"] = async (t) => {
  const x = T;
  const hostByKey = x.fieldsByKey({
    fields: [
      { key: "headroomTokens", type: "number", range: [0, 512000], where: "preset" },
      { key: "closeoutMinEvents", type: "number", range: [1, 10000], where: "preset" },
      { key: "closeoutTimeoutMs", type: "number", range: [1000, 600000], where: "preset" },
    ],
  });
  const headroom = x.withHostRange({ key: "headroomTokens", label: "压力余量", kind: "number", min: 0, max: 2000000, step: 1000 }, hostByKey);
  t.eq(headroom.max, 512000, "面板原写 2000000，必须被 host 的 512000 收窄（否则保存即 400）");
  const minEvents = x.withHostRange({ key: "closeoutMinEvents", label: "归档最小事件", kind: "number", min: 0, max: 10000, step: 1 }, hostByKey);
  t.eq(minEvents.min, 1, "面板原写 0，必须被 host 的 1 抬高");
  const timeout = x.withHostRange({ key: "closeoutTimeoutMs", label: "收尾超时", kind: "number", min: 0, max: 600000, step: 100 }, hostByKey);
  t.eq(timeout.min, 1000, "面板原写 0，必须被 host 的 1000 抬高");
  // 呈现决策仍归面板：label 不许被覆盖
  t.eq(headroom.label, "压力余量", "label 是面板的呈现决策，host 不覆盖");
};

tests["C690 host 没给 range 时不猜（不可编辑/无界的键保持面板原值）"] = async (t) => {
  const x = T;
  const byKey = x.fieldsByKey({ fields: [{ key: "maxTokens", type: "number", range: [256, 65536], where: "preset" }] });
  const noRange = x.withHostRange({ key: "retainTokens", kind: "number", min: 0, max: 999999, step: 1000 }, byKey);
  t.eq(noRange.min, 0, "host 没这个键 ⇒ 保持面板原值");
  t.eq(noRange.max, 999999, "host 没这个键 ⇒ 保持面板原值");
  // 小数域必须给小数步长，整数域不许被改成 0.01
  const frac = x.withHostRange({ key: "maxTokens", kind: "number", step: 256, min: 256, max: 65536 }, x.fieldsByKey({ fields: [{ key: "maxTokens", type: "number", range: [0.05, 0.95] }] }));
  t.eq(frac.step, 0.01, "小数域 ⇒ 步长必须 0.01");
  const int = x.withHostRange({ key: "maxTokens", kind: "number", step: 256, min: 256, max: 65536 }, byKey);
  t.eq(int.step, 256, "整数域 ⇒ 保留面板自己的步长（不强行改 1）");
  t.eq(int.max, 65536, "整数域 max 取 host");
};

/* ───── C694：面板不许把「已暂存」说成「重启后生效」 ───── */

tests["C694 保存结果显示必须区分「已暂存未生效」与「已生效」（B1 零代价修正）"] = async (t) => {
  const nodeFs = (await import("node:fs")).default;
  const src = nodeFs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 必须按宿主返回的 applied 分流，而不是一律宣称「重启后生效」
  t.includes(src, "saved.applied === false", "必须用宿主返回的 applied 判断是否真正生效");
  t.includes(src, "先运行 node scripts/apply-pending-preset.mjs --write", "暂存态必须告诉用户跑哪个命令才会生效");
  t.eq(/重启 DSH 后生效/.test(src), false, "不许再出现无条件的「重启 DSH 后生效」——那是假话（光重启不应用）");
};

tests["C694 应用脚本必须真实存在（文案指向的路径不许是幽灵）"] = async (t) => {
  const nodeFs = (await import("node:fs")).default;
  t.eq(nodeFs.existsSync(new URL("../scripts/apply-pending-preset.mjs", import.meta.url)), true, "文案里点名的脚本必须存在");
};
