/**
 * panel-layout.test.mjs —— 一屏分级面板的真实组件树 / 默认折叠 / 固定阈值档位守卫。
 *
 * 不启动 DSH、不访问网络、不调模型。直接执行 lib/client.js 的 Page 与子组件；
 * 轻量 React runtime 按组件实例保存 hooks，因此点击按钮后可以重渲染并检查真实展开状态。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");
const SOURCE = nodeFs.readFileSync(CLIENT, "utf8");

const ADVANCED_WARNING = "以下参数影响折叠时机与成本，改错会导致摘要截断、缓存失效或重复扣费";
const OFFICIAL_CHEVRON_D = "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6";
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

function panelRenderer(state = fixture(), source = SOURCE, draftOverrides = null) {
  const loaded = loadClient(source);
  loaded.runtime.seed("Page", [state, state === null ? {} : { ...state.config, ...(draftOverrides ?? {}) }]);
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

function disclosures(tree) {
  return findAll(tree, (node) => typeof node.type === "string" && node.props["data-panel-level"] !== undefined && node.type === "section");
}

function disclosureButton(tree, id) {
  const found = findAll(tree, (node) => node.props?.["data-disclosure"] === id);
  if (found.length !== 1) throw new Error(`Disclosure ${id} 按钮应有 1 个，实际 ${found.length}`);
  return found[0];
}

function fieldKeys(tree) {
  return findAll(tree, (node) => node.props?.["data-field-key"] !== undefined).map((node) => node.props["data-field-key"]);
}

function assertDefaultTree(tree) {
  const sections = disclosures(tree);
  if (sections.length !== 3) throw new Error(`应有 3 个 Disclosure，实际 ${sections.length}`);
  for (const section of sections) {
    if (section.props["data-default-expanded"] !== "false" || section.props["data-expanded"] !== "false") {
      throw new Error(`默认折叠被破坏：${JSON.stringify(section.props)}`);
    }
  }
  const primaryRows = findAll(tree, (node) => node.props?.["data-fold-row"] === "true");
  if (primaryRows.length !== 3) throw new Error(`首屏折痕必须恰好 3 条，实际 ${primaryRows.length}`);
  const text = textOf(tree);
  for (const hidden of ["高级参数（18 项）", "健康检查", "开始补账", ADVANCED_WARNING, "seq 301–380", "seq 401–480"]) {
    if (text.includes(hidden)) throw new Error(`默认首屏泄露了折叠内容：${hidden}`);
  }
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

/** 序列化的是执行完函数组件后的 host 树，不把未挂载的 Disclosure children 偷算进首屏。 */
function serializeTree(node, indent = 0) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => serializeTree(child, indent));
  const pad = " ".repeat(indent);
  if (typeof node !== "object") return [`${pad}${String(node)}`];
  const keys = ["data-panel-level", "data-status-kind", "data-default-expanded", "data-expanded", "data-disclosure", "aria-expanded", "data-fold-compact", "data-fold-row", "type", "value", "disabled"];
  const attrs = keys.filter((key) => node.props?.[key] !== undefined).map((key) => `${key}=${JSON.stringify(node.props[key])}`);
  const open = `<${node.type}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`;
  const children = childrenOf(node).flatMap((child) => serializeTree(child, indent + 2));
  return [`${pad}${open}`, ...children, `${pad}</${node.type}>`];
}

const defaultPanel = panelRenderer();
export const DEFAULT_TREE = defaultPanel.runtime.tree();
export const DEFAULT_DISCLOSURE_STATES = disclosures(DEFAULT_TREE).map((node) => ({
  level: node.props["data-panel-level"],
  defaultExpanded: node.props["data-default-expanded"],
  expanded: node.props["data-expanded"],
}));
export const FIRST_SCREEN_HEIGHT = T.estimateFirstScreenHeight({ foldCount: 3, updateBanner: true });
export const PANEL_RENDER_EVIDENCE = [
  "=== FIRST SCREEN REACT TREE (1280x720; style/event props omitted) ===",
  ...serializeTree(DEFAULT_TREE),
  "=== DEFAULT DISCLOSURE STATES ===",
  JSON.stringify(DEFAULT_DISCLOSURE_STATES, null, 2),
  "=== FIRST SCREEN HEIGHT ESTIMATE ===",
  JSON.stringify(FIRST_SCREEN_HEIGHT, null, 2),
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
  "① 一级首屏：状态 + 今日三项 + 最近3条；三个二/三级区全部真实默认收起"(t) {
    assertDefaultTree(DEFAULT_TREE);
    const primary = findAll(DEFAULT_TREE, (node) => node.props?.["data-panel-level"] === "primary");
    t.eq(primary.length, 3, "一级必须是状态卡、今日卡、最近折痕卡三张");
    const primaryRows = findAll(DEFAULT_TREE, (node) => node.props?.["data-fold-row"] === "true");
    t.eq(primaryRows.length, 3, "首屏只画最近3条");
    t.eq(primaryRows.every((row) => childrenOf(row).length === 1), true, "首屏每条折痕只有 foldMain 一个布局子行；完整明细在二级");
    t.eq(T.styles.foldRow.padding, "16px 0", "单行化不破坏官方16px行距");
    // 独立盒模型：24 padding + 1 border + 20 title + N个gap + N条单行，不允许漏算 flex gap。
    const expectedFoldCard = 24 + 1 + 20 + 3 * T.SPACING.card + 3 * 52;
    t.eq(FIRST_SCREEN_HEIGHT.foldGaps, 24, "标题+3行之间恰好3个8px gap");
    t.eq(FIRST_SCREEN_HEIGHT.foldRow, 52, "单折痕行=32 padding + 19内容 + 1边框（向上取整）");
    t.eq(FIRST_SCREEN_HEIGHT.foldCard, expectedFoldCard, "折痕卡高度必须含全部padding/border/title/gap/行高");
    const expectedPrimary = Math.max(112 + T.SPACING.section + 112 + T.SPACING.section + expectedFoldCard, 3 * 61 + 2 * T.SPACING.section);
    t.eq(FIRST_SCREEN_HEIGHT.total, 48 + 46 + T.SPACING.section + 74 + expectedPrimary, "整屏高度独立重算一致");
    const text = textOf(DEFAULT_TREE);
    for (const wanted of ["压缩状态", "正常", "今日投入产出", "今日折叠", "合计遮蔽", "今日成本（估算）", "最近折痕（最近 3 条）", "折痕列表", "常用配置", "高级"]) {
      t.includes(text, wanted, `首屏缺少 ${wanted}`);
    }
    // ★ 用户指正（截图实测）：「二级」「三级」「别动」是**结构概念**，不是给用户看的文案。
    //   一级 = 点开「上下文压缩」面板**直接可见**；二级 = **展开后**才看到。
    //   标签按**内容**命名（折痕列表 / 常用配置 / 高级配置），层级编号一律不许印上去。
    for (const bad of ["二级 ·", "三级 ·", "二级·", "三级·", "高级·别动", "高级 · 别动"]) {
      t.notIncludes(text, bad, `层级编号/「别动」不许出现在 UI 标签：${bad}`);
    }
    for (const hidden of ["涉及会话", "棋谱总数", "全库失败边", "高级参数（18 项）", ADVANCED_WARNING]) t.notIncludes(text, hidden, "次级信息不许平铺到首屏");
    t.eq(DEFAULT_DISCLOSURE_STATES.map((row) => row.defaultExpanded), [false, false, false].map(String), "默认状态全部 false");
    t.eq(FIRST_SCREEN_HEIGHT.fits, true, `含更新横幅估算 ${FIRST_SCREEN_HEIGHT.total}px，必须 ≤720px`);
    t.ok(FIRST_SCREEN_HEIGHT.total <= 720, `首屏高度 ${FIRST_SCREEN_HEIGHT.total}px 超屏`);
  },

  "② 二级交互：点击官方 chevron 按钮才挂载完整5条与4个常用控件，再点真正收起"(t) {
    const panel = panelRenderer();
    disclosureButton(panel.runtime.tree(), "fold-history").props.onClick();
    panel.runtime.render(panel.T.Page);
    let tree = panel.runtime.tree();
    t.eq(disclosureButton(tree, "fold-history").props["aria-expanded"], "true", "完整折痕已展开");
    t.eq(findAll(tree, (node) => node.props?.["data-fold-row"] === "true").length, 8, "首屏3条 + 完整5条 = 8条真实行");
    t.eq(findAll(tree, (node) => node.props?.["data-fold-compact"] === "false").length, 1, "完整列表只在二级挂载一份");
    disclosureButton(tree, "common-config").props.onClick();
    panel.runtime.render(panel.T.Page);
    tree = panel.runtime.tree();
    t.eq(fieldKeys(tree), T.COMMON_FIELD_KEYS, "常用配置恰好是阈值/摘要方式/provider/model");
    assertFixedThresholdControl(panel.T, panel.runtime);
    const chevronPaths = findAll(tree, (node) => node.type === "button" && node.props?.["data-disclosure"] !== undefined)
      .flatMap((button) => findAll(button, (node) => node.type === "path"))
      .map((path) => path.props.d);
    t.eq(chevronPaths, [OFFICIAL_CHEVRON_D, OFFICIAL_CHEVRON_D, OFFICIAL_CHEVRON_D], "三个 Disclosure 都逐 path 复用官方 chevron");
    disclosureButton(tree, "fold-history").props.onClick();
    disclosureButton(tree, "common-config").props.onClick();
    panel.runtime.render(panel.T.Page);
    assertDefaultTree(panel.runtime.tree());
    t.eq(disclosures(panel.runtime.tree()).every((node) => node.props["data-expanded"] === "false"), true, "再次点击后两个二级区都收起");
  },

  "③ 三级：18项其余参数 + 警告 + 健康 + 补账，默认一个都不挂载"(t) {
    const panel = panelRenderer();
    t.notIncludes(textOf(panel.runtime.tree()), ADVANCED_WARNING, "默认不显示高级内容");
    disclosureButton(panel.runtime.tree(), "advanced-config").props.onClick();
    panel.runtime.render(panel.T.Page);
    const tree = panel.runtime.tree();
    t.eq(disclosureButton(tree, "advanced-config").props["aria-expanded"], "true", "高级区真实展开");
    t.eq(fieldKeys(tree), ADVANCED_FIELD_KEYS, "高级恰好收进其余18项，常用4项不重复");
    const text = textOf(tree);
    for (const wanted of [ADVANCED_WARNING, "健康检查", "开始补账", "最近活跃会话", "检查更新"]) t.includes(text, wanted, `高级区缺少 ${wanted}`);
    t.eq(T.FIELDS.length - T.COMMON_FIELD_KEYS.length, 18, "22 - 4 = 18");
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
      disclosureButton(panel.runtime.tree(), "common-config").props.onClick();
      panel.runtime.render(panel.T.Page);
      const saveButtons = findAll(panel.runtime.tree(), (node) => node.type === "button" && textOf(node) === "保存（1 项改动）");
      t.eq(saveButtons.length, 1, "dirty draft 必须产生一个可点击保存按钮");
      saveButtons[0].props.onClick();
      panel.runtime.render(panel.T.Page);
      t.eq(fetchCalls, 0, "非法阈值必须在callApi/fetch之前被保存事件拒绝");
      t.includes(textOf(panel.runtime.tree()), "压缩阈值只能选择固定档位", "保存错误必须真实可见");
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
    t.eq(unknown.kind, "unknown", "截断状态未知不能冒充正常");
    t.eq(unknown.label, "待核查", "未知单独显示待核查");
    t.eq(unknown.hint, "截断状态未知 2 · 未知不等于未截断", "未知计数必须暴露");
    const stale = T.compressionStatus(fixture(), "refresh failed");
    t.eq(stale.kind, "error", "旧state仍在但刷新失败 = 出错，不许继续报正常");
    t.eq(stale.hint, "状态刷新失败 · 显示旧数据", "明确旧数据语义");
    t.eq(T.compressionStatus(null, new Error("offline")).kind, "error", "host 读取失败 = 出错");
    t.includes(SOURCE, "compressionStatus(state, loadError)", "一级只消费state加载错误，不消费保存/模型目录错误");
    t.includes(SOURCE, "setLoadError(message)", "load catch 必须真的写入loadError");
  },

  "⑥ 加载态缺少 today/latest：诊断卡不得因数组下标变化混进一级"(t) {
    const loading = panelRenderer(null);
    const primary = findAll(loading.runtime.tree(), (node) => node.props?.["data-panel-level"] === "primary");
    t.eq(primary.length, 2, "加载态一级只剩状态卡与折痕空态，不能拿诊断卡补位");
    t.eq(primary.map((node) => node.props["data-status-kind"] ?? "folds"), ["loading", "folds"], "一级身份稳定，不依赖 slice 下标");
    const text = textOf(loading.runtime.tree());
    t.notIncludes(text, "最近活跃会话", "latest 缺失时诊断卡仍只能留在三级");
    t.notIncludes(text, "检查更新", "更新卡不得补进一级");
    t.notIncludes(text, "开始补账", "补账不得补进一级");
  },

  "⑦ 失败分支真红：内存变异成默认展开或数字阈值时，同一守卫必须抛错"(t) {
    const expandedSource = SOURCE.replaceAll("defaultOpen: false", "defaultOpen: true");
    t.ne(expandedSource, SOURCE, "默认展开变异确实命中源码");
    const expanded = panelRenderer(fixture(), expandedSource);
    t.throws(() => assertDefaultTree(expanded.runtime.tree()), "默认全展开必须让首屏守卫变红");

    const numericSource = SOURCE.replace('panelLabel: "压缩阈值（固定档位）", hint: "只能选 45% / 50% / 65% / 75% / 85%；45% 是现默认值", kind: "threshold"', 'panelLabel: "压缩阈值（固定档位）", hint: "自由数字", kind: "number", step: 0.01, min: 0.05, max: 0.95');
    t.ne(numericSource, SOURCE, "数字输入变异确实命中源码");
    const numeric = loadClient(numericSource);
    t.throws(() => assertFixedThresholdControl(numeric.T, numeric.runtime), "退回自由数字输入必须让阈值守卫变红");
  },
};
