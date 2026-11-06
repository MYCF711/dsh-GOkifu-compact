/**
 * panel-layout.test.mjs —— 总览 / 折痕 / 配置三 tab 的真实组件树、互斥切换与固定阈值档位守卫。
 *
 * 不启动 DSH、不访问网络、不调模型。直接执行 lib/client.js 的 Page 与子组件；
 * 轻量 React runtime 按组件实例保存 hooks，因此点击 tab 后可以重渲染并检查真实互斥状态。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");
const SOURCE = nodeFs.readFileSync(CLIENT, "utf8");

const ADVANCED_WARNING = "以下参数影响折叠时机与成本，改错会导致摘要截断、缓存失效或重复扣费";
const TAB_IDS = Object.freeze(["overview", "folds", "config"]);
export const ADVANCED_FIELD_KEYS = Object.freeze([
  "auto",
  "growthFloorTokens",
  "retainRatio",
  "minFoldTokens",
  "autoBackfill",
  "maxTokens",
  "hotLedger",
  "hotLedgerMaxTokens",
  "hotLedgerMarkers",
  "hotLedgerReplace",
  "transposition",
  "tier2After",
  "firstFoldRatio",
  "headroomTokens",
  "closeoutFold",
  "closeoutMinEvents",
  "closeoutMaxFoldTokens",
  "closeoutTimeoutMs",
]);

/** 只实现本 client 用到的 React 接口；每个组件实例有独立 hook 槽，事件后能真实重渲染。 */
function createReactRuntime() {
  const stores = new Map();
  let current = null;
  let root = null;

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      if (current === null) throw new Error("useState 在组件外调用");
      const index = current.index++;
      const store = current.store;
      if (!(index in store)) store[index] = typeof initial === "function" ? initial() : initial;
      const setValue = (next) => {
        store[index] = typeof next === "function" ? next(store[index]) : next;
      };
      return [store[index], setValue];
    },
    useRef(initial) {
      if (current === null) throw new Error("useRef 在组件外调用");
      const index = current.index++;
      if (!(index in current.store)) current.store[index] = { current: initial };
      return current.store[index];
    },
    useEffect() {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${index}`)).filter((child) => child !== null);
    if (typeof node !== "object") return node;
    if (!("type" in node)) throw new Error(`非法 React 节点：${JSON.stringify(node)}`);
    if (typeof node.type === "function") {
      const name = node.type.name || "Anonymous";
      const key = node.props.key ?? "root";
      const componentPath = `${path}/${name}[${key}]`;
      const store = stores.get(componentPath) ?? [];
      stores.set(componentPath, store);
      const previous = current;
      current = { store, index: 0 };
      let output;
      try {
        output = node.type({ ...node.props, children: node.children.length === 0 ? undefined : node.children.length === 1 ? node.children[0] : node.children });
      } finally {
        current = previous;
      }
      return renderNode(output, componentPath);
    }
    return {
      type: node.type,
      props: { ...node.props },
      children: node.children.map((child, index) => renderNode(child, `${path}/${node.type}[${node.props.key ?? index}]`)).filter((child) => child !== null),
    };
  }

  return {
    react,
    seed(componentName, values) {
      stores.set(`/${componentName}[root]`, values);
    },
    render(component, props = {}) {
      root = renderNode({ type: component, props, children: [] }, "");
      return root;
    },
    tree() {
      return root;
    },
  };
}

function loadClient(source = SOURCE) {
  const runtime = createReactRuntime();
  let loaded = null;
  const fakeWindow = {
    innerWidth: 1280,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load: (row) => (loaded = row) },
  };
  new Function("window", source)(fakeWindow);
  if (loaded === null) throw new Error("client.js 没有注册模块");
  const mod = loaded.factory((spec) => {
    if (spec === "react") return runtime.react;
    throw new Error(`意外 require(${spec})`);
  });
  return { runtime, T: mod.__testables };
}

const { runtime: defaultRuntime, T } = loadClient();

function makeMarks(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    at: Date.UTC(2026, 10, 5, 12, 30 - index, 0),
    seqStart: index * 100 + 1,
    seqEnd: index * 100 + 80,
    trigger: index % 2 === 0 ? "pressure" : "archive-offline",
    summaryChars: 900 + index,
    usage: { inputTokens: 800 + index, outputTokens: 100 + index, totalTokens: 900 + index * 2 },
    truncated: false,
    finishReason: "stop",
  }));
}

const DEFAULTS = {
  auto: true,
  thresholdRatio: 0.45,
  growthFloorTokens: 40000,
  retainRatio: 0.16,
  minFoldTokens: 8000,
  autoBackfill: true,
  summaryMode: "hybrid",
  maxTokens: 8192,
  hotLedger: true,
  hotLedgerMaxTokens: 500,
  hotLedgerMarkers: "semantic",
  hotLedgerReplace: true,
  transposition: true,
  tier2After: 8,
  firstFoldRatio: 0.3,
  headroomTokens: 65536,
  closeoutFold: true,
  closeoutMinEvents: 40,
  closeoutMaxFoldTokens: 150000,
  closeoutTimeoutMs: 90000,
  summarizationProvider: "",
  summarizationModel: "",
};

function fixture(overrides = {}) {
  return {
    ok: true,
    profile: "desktop",
    version: "1.17.6",
    config: { ...DEFAULTS, thresholdRatio: 0.65 },
    defaults: DEFAULTS,
    configFile: "D:/fixture/cordis.patch.yml",
    latest: {
      session: "session-panel-layout",
      totalAfter: 76543,
      foldCount: 5,
      failures: 2,
      resolvedFailures: 1,
      nodes: 42,
      edges: 51,
      lastUsage: { provider: "fixture", model: "rules", inputTokens: 800, outputTokens: 100 },
      lastFold: { shadowedTokens: 20000, seqStart: 401, seqEnd: 480 },
    },
    foldMarks: makeMarks(),
    today: { folds: 5, shadowed: 123456, sessions: 2, totalSessions: 8, totalFailures: 3, costUsd: 0.032, costKnown: 5, peakFolds: 1, truncated: 0, inputTruncated: 0 },
    health: { installed: true, mounted: true, singleInstance: true, profile: "desktop", presets: [{ name: "fixture", file: "D:/fixture/cordis.patch.yml" }] },
    models: { providers: [{ provider: "fixture", name: "Fixture", models: [{ id: "model-128k", name: "Model 128K", contextWindow: 128000 }] }] },
    update: null,
    ...overrides,
  };
}

export function panelRenderer(state = fixture(), source = SOURCE, draftOverrides = null, update = null, models = undefined) {
  const loaded = loadClient(source);
  const seeded = [state, state === null ? {} : { ...state.config, ...(draftOverrides ?? {}) }];
  if (models !== undefined) seeded[6] = models;
  if (update !== null) seeded[8] = update;
  loaded.runtime.seed("Page", seeded);
  loaded.runtime.render(loaded.T.Page);
  return loaded;
}

function childrenOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(childrenOf);
  if (typeof node !== "object") return [];
  return node.children ?? [];
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  for (const child of childrenOf(node)) findAll(child, predicate, out);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join("\n");
  if (typeof node !== "object") return String(node);
  return childrenOf(node).map(textOf).filter(Boolean).join("\n");
}

function tabButton(tree, id) {
  const found = findAll(tree, (node) => node.type === "button" && node.props?.["data-panel-tab"] === id);
  if (found.length !== 1) throw new Error(`tab ${id} 按钮应有 1 个，实际 ${found.length}`);
  return found[0];
}

function tabStates(tree) {
  return TAB_IDS.map((id) => ({ id, pressed: tabButton(tree, id).props["aria-pressed"] }));
}

function activePanel(tree) {
  const panels = findAll(tree, (node) => node.props?.["data-panel-view"] !== undefined);
  if (panels.length !== 1) throw new Error(`同时只能挂载一个面板，实际 ${panels.length}`);
  return panels[0];
}

function clickTab(panel, id) {
  tabButton(panel.runtime.tree(), id).props.onClick();
  panel.runtime.render(panel.T.Page);
  return panel.runtime.tree();
}

function fieldKeys(tree) {
  return findAll(tree, (node) => node.props?.["data-field-key"] !== undefined).map((node) => node.props["data-field-key"]);
}

function pageScrollStyle(tree) {
  const { height, minHeight, overflowY } = tree.props.style;
  return { height, minHeight, overflowY };
}

function assertNoFoldBars(tree) {
  const legacy = findAll(tree, (node) => node.props?.["data-disclosure"] !== undefined
    || node.props?.["data-default-expanded"] !== undefined
    || node.props?.["data-expanded"] !== undefined);
  if (legacy.length !== 0) throw new Error(`面板还残留折叠条节点：${legacy.length}`);
}

function assertMutualExclusivity(tree, expected) {
  assertNoFoldBars(tree);
  const panel = activePanel(tree);
  if (panel.props["data-panel-view"] !== expected) throw new Error(`活动面板应为 ${expected}，实际 ${panel.props["data-panel-view"]}`);
  const expectedPressed = TAB_IDS.map((id) => id === expected);
  if (JSON.stringify(tabStates(tree).map((row) => row.pressed)) !== JSON.stringify(expectedPressed)) {
    throw new Error(`tab pressed 状态不互斥：${JSON.stringify(tabStates(tree))}`);
  }
  const controls = tabButton(tree, expected).props["aria-controls"];
  if (controls !== panel.props.id) throw new Error(`选中 tab 的 aria-controls=${controls} 没指向活动面板 ${panel.props.id}`);
  if (panel.props["aria-labelledby"] !== tabButton(tree, expected).props.id) throw new Error("活动面板 aria-labelledby 未回指选中 tab");
  return panel;
}

function assertOverviewTree(tree) {
  assertMutualExclusivity(tree, "overview");
  const primary = findAll(tree, (node) => node.props?.["data-panel-level"] === "primary");
  if (primary.length !== 3) throw new Error(`总览必须直接显示状态/今日/最近折痕三张卡，实际 ${primary.length}`);
  const rows = findAll(tree, (node) => node.props?.["data-fold-row"] === "true");
  if (rows.length !== 5) throw new Error(`普通总览最近折痕必须恰好 5 条，实际 ${rows.length}`);
  if (!rows.every((row) => childrenOf(row).length === 1)) throw new Error("总览每条折痕必须保持单行 foldMain");
  if (findAll(tree, (node) => node.props?.["data-fold-compact"] === "false").length !== 0) throw new Error("完整折痕列表泄漏到总览");
  if (fieldKeys(tree).length !== 0) throw new Error("配置字段泄漏到总览");
  const text = textOf(tree);
  for (const hidden of ["高级参数（18 项）", "常用配置（4 个控件）", ADVANCED_WARNING]) {
    if (text.includes(hidden)) throw new Error(`总览泄漏了其它 tab 内容：${hidden}`);
  }
  // ★ 用户原话：健康检查 / 最近活跃会话 / 状态 / 补账「应该放在明显的地方」—— **必须在总览**。
  for (const wanted of ["健康检查", "最近活跃会话", "开始补账", "检查更新"]) {
    if (!text.includes(wanted)) throw new Error(`总览缺少「状态与操作」：${wanted}（用户原话要求它们在明显位置，不埋进配置最底下）`);
  }
  return { primaryCards: primary.length, recentRows: rows.length, fullLists: 0, fieldCount: 0 };
}

function assertConfigTree(tree) {
  assertMutualExclusivity(tree, "config");
  const text = textOf(tree);
  for (const wanted of ["常用配置（4 个控件）", "高级参数（18 项）", ADVANCED_WARNING]) {
    if (!text.includes(wanted)) throw new Error(`配置 tab 缺少：${wanted}`);
  }
  // ★ 用户原话：健康检查 / 最近活跃会话 / 补账 在总览（不埋进配置最底下）。
  for (const hidden of ["健康检查", "最近活跃会话", "开始补账", "检查更新"]) {
    if (text.includes(hidden)) throw new Error(`「状态与操作」不得埋进配置最底下（用户原话要求它们在总览）：${hidden}`);
  }
  return fieldKeys(tree);
}

function assertFixedThresholdControl(T, runtime) {
  const field = T.FIELDS.find((entry) => entry.key === "thresholdRatio");
  runtime.render(T.Field, { field, value: 0.65, defaultValue: 0.45, models: { providers: [] }, onChange() {}, gridStyle: T.fieldGridFor(1280).style });
  const selects = findAll(runtime.tree(), (node) => node.type === "select");
  const numbers = findAll(runtime.tree(), (node) => node.type === "input" && node.props?.type === "number");
  if (selects.length !== 1 || numbers.length !== 0) throw new Error("阈值必须是唯一固定档位 select，不能出现 number input");
  const options = findAll(selects[0], (node) => node.type === "option").map((node) => node.props.value);
  const expected = T.THRESHOLD_TIERS.map(String);
  if (JSON.stringify(options) !== JSON.stringify(expected)) throw new Error(`阈值选项漂移：${JSON.stringify(options)} != ${JSON.stringify(expected)}`);
}

/** 序列化的是执行完函数组件后的 host 树，不把未选中的面板偷算进总览。 */
function serializeTree(node, indent = 0) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => serializeTree(child, indent));
  const pad = " ".repeat(indent);
  if (typeof node !== "object") return [`${pad}${String(node)}`];
  const keys = ["id", "role", "data-panel-tabs", "data-panel-tab", "aria-pressed", "aria-controls", "data-panel-view", "aria-labelledby", "data-panel-level", "data-status-kind", "data-fold-compact", "data-fold-row", "data-field-key", "type", "value", "disabled"];
  const attrs = keys.filter((key) => node.props?.[key] !== undefined).map((key) => `${key}=${JSON.stringify(node.props[key])}`);
  const open = `<${node.type}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`;
  const children = childrenOf(node).flatMap((child) => serializeTree(child, indent + 2));
  return [`${pad}${open}`, ...children, `${pad}</${node.type}>`];
}

function switchSnapshot(panel) {
  const tree = panel.runtime.tree();
  return {
    selected: activePanel(tree).props["data-panel-view"],
    tabs: tabStates(tree),
    visiblePanels: findAll(tree, (node) => node.props?.["data-panel-view"] !== undefined).map((node) => node.props["data-panel-view"]),
    compactFoldLists: findAll(tree, (node) => node.props?.["data-fold-compact"] === "true").length,
    fullFoldLists: findAll(tree, (node) => node.props?.["data-fold-compact"] === "false").length,
    foldRows: findAll(tree, (node) => node.props?.["data-fold-row"] === "true").length,
    primaryCards: findAll(tree, (node) => node.props?.["data-panel-level"] === "primary").length,
    fieldCount: fieldKeys(tree).length,
    advancedWarning: textOf(tree).includes(ADVANCED_WARNING),
    pageScroll: pageScrollStyle(tree),
  };
}

const defaultPanel = panelRenderer();
export const DEFAULT_TREE = defaultPanel.runtime.tree();
export const DEFAULT_TAB_STATES = tabStates(DEFAULT_TREE);
export const FIRST_SCREEN_HEIGHT = T.estimateFirstScreenHeight({ foldCount: 5, updateBanner: false });
export const FIRST_SCREEN_HEIGHT_WITH_UPDATE = T.estimateFirstScreenHeight({ foldCount: 5, updateBanner: true });
export const PANEL_RENDER_EVIDENCE = [
  "=== OVERVIEW TAB: REAL REACT HOST TREE (1280x720; style/event props omitted) ===",
  ...serializeTree(DEFAULT_TREE),
  "=== TAB STATES ===",
  JSON.stringify(DEFAULT_TAB_STATES, null, 2),
  "=== OVERVIEW HEIGHT ESTIMATE (NO UPDATE BANNER) ===",
  JSON.stringify(FIRST_SCREEN_HEIGHT, null, 2),
  "=== OVERVIEW HEIGHT ESTIMATE (WITH UPDATE BANNER) ===",
  JSON.stringify(FIRST_SCREEN_HEIGHT_WITH_UPDATE, null, 2),
].join("\n");

const configPanel = panelRenderer();
export const CONFIG_TREE = clickTab(configPanel, "config");
export const TAB_CONTENT_INVENTORY = [
  "=== TAB CONTENT INVENTORY ===",
  "OVERVIEW: 压缩状态 / 今日投入产出 / 最近折痕",
  "CONFIG: 常用配置（4 个控件） / 高级参数（18 项） / 高级警告 / 配置保存控件与来源 / 健康检查 / 最近活跃会话 / 补账操作 / 检查更新",
].join("\n");
export const CONFIG_RENDER_EVIDENCE = [
  "=== CONFIG TAB: REAL REACT HOST TREE (1280x720; style/event props omitted) ===",
  ...serializeTree(CONFIG_TREE),
].join("\n");

const switchPanel = panelRenderer();
const switchProof = [{ step: "initial", ...switchSnapshot(switchPanel) }];
clickTab(switchPanel, "folds");
switchProof.push({ step: "click folds", ...switchSnapshot(switchPanel) });
clickTab(switchPanel, "config");
switchProof.push({ step: "click config", ...switchSnapshot(switchPanel) });
clickTab(switchPanel, "overview");
switchProof.push({ step: "click overview", ...switchSnapshot(switchPanel) });
export const TAB_SWITCH_PROOF = switchProof;
export const TAB_SWITCH_EVIDENCE = [
  "=== TAB MUTUAL EXCLUSION: REAL CLICK / RERENDER SNAPSHOTS ===",
  JSON.stringify(TAB_SWITCH_PROOF, null, 2),
].join("\n");

const thresholdProof = loadClient();
thresholdProof.runtime.render(thresholdProof.T.Field, {
  field: thresholdProof.T.FIELDS.find((entry) => entry.key === "thresholdRatio"),
  value: 0.65,
  defaultValue: 0.45,
  models: { providers: [] },
  onChange() {},
  gridStyle: thresholdProof.T.fieldGridFor(1280).style,
});
export const THRESHOLD_EVIDENCE = [
  "=== THRESHOLD FIXED-TIER CONTROL ===",
  ...serializeTree(thresholdProof.runtime.tree()),
  "=== THRESHOLD SAVE GATE ===",
  JSON.stringify({
    tiers: thresholdProof.T.THRESHOLD_TIERS,
    accepted: thresholdProof.T.thresholdPatchForSave({ thresholdRatio: "0.75" }),
    rejected051: thresholdProof.T.thresholdPatchForSave({ thresholdRatio: 0.51 }),
    rejected070: thresholdProof.T.thresholdPatchForSave({ thresholdRatio: 0.7 }),
  }, null, 2),
].join("\n");

export const tests = {
  "① 总览 tab：状态 + 今日 + 最近5条直接显示；没有折叠条，完整列表与配置不挂载"(t) {
    console.log(PANEL_RENDER_EVIDENCE);
    t.eq(assertOverviewTree(DEFAULT_TREE), { primaryCards: 3, recentRows: 5, fullLists: 0, fieldCount: 0 }, "真实总览树必须一屏直接呈现三组核心信息");
    t.eq(DEFAULT_TAB_STATES, [{ id: "overview", pressed: true }, { id: "folds", pressed: false }, { id: "config", pressed: false }], "默认且仅总览被选中");
    t.eq(T.PANEL_TABS.map((tab) => [tab.id, tab.label]), [["overview", "总览"], ["folds", "折痕"], ["config", "配置"]], "三 tab 内容命名简洁稳定");
    t.notIncludes(SOURCE, "function Disclosure", "旧折叠组件必须移除");
    t.notIncludes(SOURCE, "data-disclosure", "旧折叠钩子必须移除");
    t.eq(pageScrollStyle(DEFAULT_TREE), { height: "100%", minHeight: 0, overflowY: "auto" }, "P0 整页滚动保持原样");
    t.eq(T.styles.foldRow.padding, "16px 0", "折痕列表保持官方16px行距");
    t.eq(FIRST_SCREEN_HEIGHT.visibleFolds, 5, "普通总览折痕数与真实 React 树一致");
    t.eq(FIRST_SCREEN_HEIGHT.foldGaps, 40, "标题+5行之间恰好5个8px gap");
    t.eq(FIRST_SCREEN_HEIGHT.foldRow, 52, "单折痕行=32 padding + 19内容 + 1边框（向上取整）");
    const expectedFoldCard = 24 + 1 + 20 + 5 * T.SPACING.card + 5 * 52;
    const expectedOverview = 112 + T.SPACING.section + expectedFoldCard;
    t.eq(FIRST_SCREEN_HEIGHT.foldCard, expectedFoldCard, "折痕卡高度含全部padding/border/title/gap/行高");
    t.eq(FIRST_SCREEN_HEIGHT.summary, 112, "宽屏状态与今日并排，只取较高一张卡");
    t.eq(FIRST_SCREEN_HEIGHT.overview, expectedOverview, "总览正文=并排摘要+分区间距+折痕卡");
    t.eq(FIRST_SCREEN_HEIGHT.total, 48 + 46 + 28 + 2 * T.SPACING.section + expectedOverview, "无横幅整屏高度独立重算一致");
    t.eq(FIRST_SCREEN_HEIGHT.total, 627, "普通总览总高必须是627px");
    t.eq(FIRST_SCREEN_HEIGHT.availableHeight, 720, "可用高度口径固定为720px");
    t.eq(FIRST_SCREEN_HEIGHT.utilization, 627 / 720, "首屏利用率按总高/可用高度计算");
    t.ok(FIRST_SCREEN_HEIGHT.utilization >= 0.85, "普通总览利用率必须≥85%");
    t.eq(FIRST_SCREEN_HEIGHT.fits, true, `普通总览 ${FIRST_SCREEN_HEIGHT.total}px 必须≤720px`);
    const expectedBannerFoldCard = 24 + 1 + 20 + 3 * T.SPACING.card + 3 * 52;
    const expectedBannerOverview = 112 + T.SPACING.section + expectedBannerFoldCard;
    t.eq(FIRST_SCREEN_HEIGHT_WITH_UPDATE.visibleFolds, 3, "更新横幅出现时保留既有3条收缩策略");
    t.eq(FIRST_SCREEN_HEIGHT_WITH_UPDATE.total, 48 + 46 + 28 + 58 + 3 * T.SPACING.section + expectedBannerOverview, "含横幅整屏高度独立重算一致");
    t.eq(FIRST_SCREEN_HEIGHT_WITH_UPDATE.total, 581, "含更新横幅总览总高必须是581px");
    t.eq(FIRST_SCREEN_HEIGHT_WITH_UPDATE.fits, true, "含更新横幅仍必须一屏");
    const text = textOf(DEFAULT_TREE);
    for (const wanted of ["压缩状态", "正常", "今日投入产出", "今日折叠", "合计遮蔽", "今日成本（估算）", "最近折痕（最近 5 条）", "总览", "折痕", "配置"]) {
      t.includes(text, wanted, `总览缺少 ${wanted}`);
    }
    // ★ 用户原话：健康检查 / 最近活跃会话 / 补账 / 检查更新「应该放在明显的地方」—— 它们（及其统计）**必须在总览**。
    //   只禁「配置参数」平铺到总览；「状态与操作」及其统计（涉及会话/棋谱总数/全库失败边）是用户要看的，**不算次级信息**。
    for (const hidden of ["常用配置（4 个控件）", "高级参数（18 项）", ADVANCED_WARNING]) t.notIncludes(text, hidden, "配置参数不许平铺到总览");
    for (const wanted of ["健康检查", "最近活跃会话", "开始补账", "检查更新"]) t.includes(text, wanted, `总览缺少「状态与操作」：${wanted}`);
    const sixMarkPanel = panelRenderer(fixture({ foldMarks: makeMarks(6) }));
    t.eq(findAll(sixMarkPanel.runtime.tree(), (node) => node.props?.["data-fold-row"] === "true").length, 5, "有6条数据时总览也只取最近5条");
    t.notIncludes(textOf(sixMarkPanel.runtime.tree()), "seq 501–580", "第6条只能进入折痕 tab");
    const updatePanel = panelRenderer(fixture(), SOURCE, null, { current: "1.17.6", latest: "1.18.0", hasUpdate: true });
    t.eq(findAll(updatePanel.runtime.tree(), (node) => node.props?.["data-fold-row"] === "true").length, 3, "真实更新横幅下总览同样收缩为3条");
  },

  "② 官方 tab 素材：chip 几何、选中背景、group/aria-pressed 与自动化任务页一致"(t) {
    t.eq(T.styles.tabBar.display, "flex", "filterTabs 是横向 flex");
    t.eq(T.styles.tabBar.flexWrap, "wrap", "filterTabs 允许窄屏换行");
    t.eq(T.styles.tabBar.gap, "8px 12px", "filterTabs 行列间距逐值复用");
    t.eq(T.styles.tab.height, "28px", "filterTab 高28");
    t.eq(T.styles.tab.padding, "0 10px", "filterTab 左右10");
    t.eq(T.styles.tab.border, 0, "filterTab 无边框");
    t.eq(T.styles.tab.borderRadius, "14px", "filterTab 胶囊半径14");
    t.eq(T.styles.tab.fontSize, "14px", "filterTab 字号14");
    t.eq(T.styles.tab.lineHeight, "22px", "filterTab 行高22");
    t.eq(T.styles.tab.color, "var(--dsw-alias-label-tertiary, #81858c)", "未选文字用 tertiary");
    t.eq(T.styles.tabActive.background, "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))", "选中背景使用官方 hover token");
    t.eq(T.styles.tabActive.color, "var(--dsw-alias-label-primary, currentColor)", "选中文字使用 primary");
    const group = findAll(DEFAULT_TREE, (node) => node.props?.["data-panel-tabs"] === "true");
    t.eq(group.length, 1, "只有一个 tab group");
    t.eq(group[0].props.role, "group", "与自动化任务筛选 chip 一样使用 group");
    const hoverElement = { style: {} };
    tabButton(DEFAULT_TREE, "folds").props.onMouseEnter({ currentTarget: hoverElement });
    t.eq(hoverElement.style.background, "var(--dsw-alias-interactive-bg-hover)", "hover 同样使用官方 token");
    tabButton(DEFAULT_TREE, "folds").props.onMouseLeave({ currentTarget: hoverElement });
    t.eq(hoverElement.style.background, "transparent", "未选项离开 hover 恢复透明");
  },

  "③ 互斥切换：点折痕才显示完整5条；点配置才显示4+18项与警告；回切总览还原"(t) {
    console.log(TAB_SWITCH_EVIDENCE);
    t.eq(TAB_SWITCH_PROOF.map((row) => row.selected), ["overview", "folds", "config", "overview"], "真实点击序列完整");
    for (const row of TAB_SWITCH_PROOF) {
      t.eq(row.visiblePanels, [row.selected], `${row.step} 只能有一个可见面板`);
      t.eq(row.tabs.filter((tab) => tab.pressed).map((tab) => tab.id), [row.selected], `${row.step} 只能有一个 pressed tab`);
      t.eq(row.pageScroll, { height: "100%", minHeight: 0, overflowY: "auto" }, `${row.step} 整页滚动不回退`);
    }
    const folds = TAB_SWITCH_PROOF[1];
    t.eq(folds.compactFoldLists, 0, "折痕 tab 不再平铺总览最近列表");
    t.eq(folds.fullFoldLists, 1, "折痕 tab 挂载一份完整列表");
    t.eq(folds.foldRows, 5, "完整列表真实显示全部5条");
    t.eq(folds.primaryCards, 0, "总览卡片在折痕 tab 全部卸载");
    t.eq(folds.fieldCount, 0, "折痕 tab 不显示配置");
    t.eq(folds.advancedWarning, false, "折痕 tab 不显示高级警告");
    const config = TAB_SWITCH_PROOF[2];
    t.eq(config.foldRows, 0, "配置 tab 不再平铺任何折痕");
    t.eq(config.primaryCards, 0, "配置 tab 不平铺总览卡片");
    t.eq(config.fieldCount, 22, "配置 tab 同时包含常用4项与高级18项");
    t.eq(config.advancedWarning, true, "高级配置警告真实可见");
    t.eq({ ...TAB_SWITCH_PROOF[3], step: "initial" }, TAB_SWITCH_PROOF[0], "回切总览后真实树状态还原");
  },

  "③b 配置 tab：常用4项 + 高级18项 + 警告 + 健康 + 活跃会话 + 补账；无内层滚动容器"(t) {
    console.log(TAB_CONTENT_INVENTORY);
    console.log(CONFIG_RENDER_EVIDENCE);
    const panel = panelRenderer();
    const tree = clickTab(panel, "config");
    t.eq(assertConfigTree(tree), [...T.COMMON_FIELD_KEYS, ...ADVANCED_FIELD_KEYS], "配置字段顺序为常用4项后高级18项，诊断卡集中在同一 tab");
    t.eq(T.FIELDS.length - T.COMMON_FIELD_KEYS.length, 18, "22 - 4 = 18");
    const threshold = loadClient();
    assertFixedThresholdControl(threshold.T, threshold.runtime);
    const scrolling = findAll(tree, (node) => node.props?.style?.overflowY === "auto" && node !== tree);
    t.eq(scrolling, [], "配置不再制造折叠区内滚，统一走整页滚动");
    t.eq(pageScrollStyle(tree), { height: "100%", minHeight: 0, overflowY: "auto" }, "长配置仍由根容器滚动");
    clickTab(panel, "folds");
    t.notIncludes(textOf(panel.runtime.tree()), ADVANCED_WARNING, "离开配置后警告卸载");
    t.eq(fieldKeys(panel.runtime.tree()), [], "离开配置后全部字段卸载");
  },

  "④ 阈值固定档位：select 只认45/50/65/75/85%，保存闸门拒绝任意数字"(t) {
    t.eq(T.THRESHOLD_TIERS, [0.45, 0.5, 0.65, 0.75, 0.85], "固定档位含现默认45%");
    for (const tier of T.THRESHOLD_TIERS) t.eq(T.thresholdTierValue(tier), String(tier), `${tier} 必须可选`);
    for (const invalid of [0.05, 0.51, 0.7, 0.95, "0.51", "", null, undefined, Number.NaN]) t.eq(T.thresholdTierValue(invalid), "", `${JSON.stringify(invalid)} 必须拒绝`);
    t.eq(T.thresholdPatchForSave({ thresholdRatio: "0.75", summaryMode: "rules" }), { ok: true, patch: { thresholdRatio: 0.75, summaryMode: "rules" } }, "合法字符串 canonical 成数字");
    for (const invalid of [0.51, "0.51", 0.7, 0.95]) {
      const checked = T.thresholdPatchForSave({ thresholdRatio: invalid });
      t.eq(checked.ok, false, `${invalid} 必须在 callApi 之前被拒`);
      t.includes(checked.error, "固定档位", "拒绝原因明确");
    }
    t.eq(T.thresholdPatchForSave({ summaryMode: "rules" }), { ok: true, patch: { summaryMode: "rules" } }, "未改阈值不夹带旧自定义值");
    const field = T.FIELDS.find((entry) => entry.key === "thresholdRatio");
    t.eq(field.kind, "threshold", "字段不再是 number");
    t.eq(field.panelLabel, "压缩阈值（固定档位）", "面板名称明确固定档位");
    assertFixedThresholdControl(T, defaultRuntime);
  },

  "④b 保存事件：非法阈值进入dirty draft后点击保存，fetch必须0次且错误可见"(t) {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("非法阈值不应到达fetch");
    };
    try {
      const panel = panelRenderer(fixture(), SOURCE, { thresholdRatio: 0.51 });
      clickTab(panel, "config");
      const saveButtons = findAll(panel.runtime.tree(), (node) => node.type === "button" && textOf(node) === "保存（1 项改动）");
      t.eq(saveButtons.length, 1, "dirty draft 必须产生一个可点击保存按钮");
      saveButtons[0].props.onClick();
      panel.runtime.render(panel.T.Page);
      t.eq(fetchCalls, 0, "非法阈值必须在callApi/fetch之前被保存事件拒绝");
      t.includes(textOf(panel.runtime.tree()), "压缩阈值只能选择固定档位", "保存错误必须真实可见");
      clickTab(panel, "overview");
      t.eq(findAll(panel.runtime.tree(), (node) => node.props?.["data-status-kind"] === "normal").length, 1, "保存错误不得误报成压缩运行错误");
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = originalFetch;
    }
  },

  "⑤ 状态优先级：正常 / 未启用 / 出错都有真实判据"(t) {
    t.eq(T.compressionStatus(fixture(), null).kind, "normal", "接管 + auto + 无截断 = 正常");
    t.eq(T.compressionStatus(fixture({ config: { ...DEFAULTS, auto: false } }), null).kind, "disabled", "关闭自动压缩 = 未启用");
    t.eq(T.compressionStatus(fixture({ health: { installed: false, mounted: false, singleInstance: true } }), null).kind, "disabled", "未接管 = 未启用");
    t.eq(T.compressionStatus(fixture({ health: { installed: true, mounted: true, singleInstance: false } }), null).kind, "error", "多后端 = 出错");
    t.eq(T.compressionStatus(fixture({ today: { truncated: 1, inputTruncated: 0 } }), null).kind, "error", "摘要截断 = 出错");
    const bothTruncated = T.compressionStatus(fixture({ today: { truncated: 2, inputTruncated: 3 } }), null);
    t.eq(bothTruncated.kind, "error", "输入裁切也应报出错");
    t.eq(bothTruncated.hint, "输出截断 2 · 输入裁切 3", "两类截断独立展示，同一fold不得相加成5");
    const unknown = T.compressionStatus(fixture({ today: { truncated: 0, inputTruncated: 0, truncatedUnknown: 2 } }), null);
    t.eq(unknown.kind, "normal", "历史截断状态未知不是当前后端故障");
    t.eq(unknown.label, "正常", "未知观察项不改变运行正常判级");
    t.eq(unknown.hint, "已接管 · 自动压缩开启 · 截断状态未知 2 · 未知不等于未截断", "未知计数必须暴露且不得清零");
    const stale = T.compressionStatus(fixture(), "refresh failed");
    t.eq(stale.kind, "error", "旧state仍在但刷新失败 = 出错，不许继续报正常");
    t.eq(stale.hint, "状态刷新失败 · 显示旧数据", "明确旧数据语义");
    t.eq(T.compressionStatus(null, new Error("offline")).kind, "error", "host 读取失败 = 出错");
    t.eq(T.compressionStatus(fixture({ error: "host state failed" }), null).kind, "error", "state.error 仍 = 出错");
    t.includes(SOURCE, "compressionStatus(state, loadError)", "总览只消费state加载错误，不消费保存/模型目录错误");
    t.includes(SOURCE, "setLoadError(message)", "load catch 必须真的写入loadError");
  },

  "⑤b T90 输入-only 裁切判正常并保留计数；真实 host 卡与错误/未知对照同步验证"(t) {
    const base = fixture();
    const inputState = fixture({ today: { ...base.today, truncated: 0, inputTruncated: 213, truncatedUnknown: 0 } });
    const inputStatus = T.compressionStatus(inputState, null);
    const inputPanel = panelRenderer(inputState);
    const statusCards = findAll(inputPanel.runtime.tree(), (node) => node.props?.["data-status-kind"] !== undefined);
    console.log("=== T90 INPUT-ONLY STATUS ===");
    console.log(JSON.stringify(inputStatus, null, 2));
    console.log("=== T90 REAL HOST STATUS CARD ===");
    if (statusCards.length === 1) console.log(serializeTree(statusCards[0]).join("\n"));

    t.eq(inputStatus, { kind: "normal", label: "正常", hint: "已接管 · 自动压缩开启 · 输入裁切 213" }, "只有输入裁切、输出 truncated=0 时必须判正常且保留输入裁切计数");
    t.eq(inputState.today, { ...base.today, truncated: 0, inputTruncated: 213, truncatedUnknown: 0 }, "判级不得清零或改写 today 的任何计数");
    t.eq(statusCards.length, 1, "真实总览必须渲染一张状态卡");
    t.eq(statusCards[0]?.props["data-status-kind"], "normal", "真实 host 卡必须带 data-status-kind=normal");
    t.includes(textOf(statusCards[0]), "正常", "真实 host 卡必须显示正常");
    t.includes(textOf(statusCards[0]), "已接管 · 自动压缩开启 · 输入裁切 213", "真实 host 卡不得隐藏输入裁切计数");

    t.eq(T.compressionStatus(fixture({ today: { ...base.today, truncated: 1, inputTruncated: 213, truncatedUnknown: 0 } }), null), { kind: "error", label: "出错", hint: "输出截断 1 · 输入裁切 213" }, "输出+输入同时截断仍必须出错且两类计数都保留");
    const liveState = fixture({ today: { ...base.today, truncated: 0, inputTruncated: 213, truncatedUnknown: 7 } });
    t.eq(T.compressionStatus(liveState, null), { kind: "normal", label: "正常", hint: "已接管 · 自动压缩开启 · 输入裁切 213 · 截断状态未知 7 · 未知不等于未截断" }, "真机 input=213/unknown=7 也必须正常且两项计数都保留");
    const livePanel = panelRenderer(liveState);
    const liveCards = findAll(livePanel.runtime.tree(), (node) => node.props?.["data-status-kind"] !== undefined);
    t.eq(liveCards.length, 1, "真机形态仍只渲染一张状态卡");
    t.eq(liveCards[0].props["data-status-kind"], "normal", "真机形态的真实 host 卡必须为 normal");
    t.includes(textOf(liveCards[0]), "输入裁切 213 · 截断状态未知 7", "真实 host 卡必须同时保留两类观测计数");
  },

  "⑥ 加载态缺少 today/latest：总览仍保留健康、活跃会话空态与补账操作"(t) {
    const loading = panelRenderer(null);
    const primary = findAll(loading.runtime.tree(), (node) => node.props?.["data-panel-level"] === "primary");
    t.eq(primary.length, 2, "加载态总览只剩状态卡与折痕空态");
    t.eq(primary.map((node) => node.props["data-status-kind"] ?? "folds"), ["loading", "folds"], "总览身份稳定，不依赖 slice 下标");
    assertMutualExclusivity(loading.runtime.tree(), "overview");
    const text = textOf(loading.runtime.tree());
    // ★ 用户原话：健康检查 / 最近活跃会话 / 补账「应该放在明显的地方」—— 即使数据未加载，**也要在总览**（显示空态，不是藏进配置）。
    t.includes(text, "健康检查", "加载态总览仍显示健康检查（空态）");
    t.includes(text, "开始补账", "加载态总览仍显示补账操作");
    t.eq(fieldKeys(loading.runtime.tree()), [], "加载态也不得借总览平铺配置字段");
  },

  "⑦ 失败分支真红：6条总览、默认配置、双面板、无选中背景或数字阈值都必须被同一守卫拒绝"(t) {
    const crowdedSource = SOURCE.replace("const RECENT_FOLD_LIMIT = 5;", "const RECENT_FOLD_LIMIT = 6;");
    t.ne(crowdedSource, SOURCE, "6条折痕变异确实命中源码");
    const crowded = panelRenderer(fixture({ foldMarks: makeMarks(6) }), crowdedSource);
    t.throws(() => assertOverviewTree(crowded.runtime.tree()), "总览放到第6条必须让守卫变红");

    const configDefaultSource = SOURCE.replace('useState("overview")', 'useState("config")');
    t.ne(configDefaultSource, SOURCE, "默认配置变异确实命中源码");
    const configDefault = panelRenderer(fixture(), configDefaultSource);
    t.throws(() => assertOverviewTree(configDefault.runtime.tree()), "默认配置 tab 必须让总览守卫变红");

    // ★ Lead 修正：旧变异「把诊断卡塞进总览必须让守卫变红」**前提已反** ——
    //   用户原话就是「健康检查 / 最近活跃会话 / 补账 应该放在明显的地方（总览）」。
    //   诊断卡在总览**正是目标行为**，不再是一个失败分支，故移除该变异（其余失败分支保留）。

    const flatSource = SOURCE.replace(
      'h(PanelTabs, { active: activeTab, onChange: setActiveTab }),\n        activePanel);',
      'h(PanelTabs, { active: activeTab, onChange: setActiveTab }),\n        activePanel,\n        h("div", { "data-panel-view": "folds" }, fullFoldListCard));',
    );
    t.ne(flatSource, SOURCE, "双面板平铺变异确实命中源码");
    const flat = panelRenderer(fixture(), flatSource);
    t.throws(() => assertMutualExclusivity(flat.runtime.tree(), "overview"), "同时平铺折痕必须让互斥守卫变红");

    const noActiveStyleSource = SOURCE.replace("style: selected ? { ...styles.tab, ...styles.tabActive } : styles.tab", "style: styles.tab");
    t.ne(noActiveStyleSource, SOURCE, "删除选中背景变异确实命中源码");
    const noActiveStyle = panelRenderer(fixture(), noActiveStyleSource);
    t.eq(tabButton(noActiveStyle.runtime.tree(), "overview").props.style.background, "transparent", "变异夹具确实失去选中背景");
    t.throws(() => {
      if (tabButton(noActiveStyle.runtime.tree(), "overview").props.style.background !== T.styles.tabActive.background) throw new Error("选中背景丢失");
    }, "官方选中背景守卫对变异必须真红");

    const numericSource = SOURCE.replace('panelLabel: "压缩阈值（固定档位）", hint: "只能选 45% / 50% / 65% / 75% / 85%；45% 是现默认值", kind: "threshold"', 'panelLabel: "压缩阈值（固定档位）", hint: "自由数字", kind: "number", step: 0.01, min: 0.05, max: 0.95');
    t.ne(numericSource, SOURCE, "数字输入变异确实命中源码");
    const numeric = loadClient(numericSource);
    t.throws(() => assertFixedThresholdControl(numeric.T, numeric.runtime), "退回自由数字输入必须让阈值守卫变红");
  },
};
