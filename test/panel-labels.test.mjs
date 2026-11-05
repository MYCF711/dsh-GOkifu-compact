/**
 * panel-labels.test.mjs —— 面板标签与全局折痕空态守卫。
 *
 * 直接执行真实 Page / Disclosure / FoldList，并用临时 home 里的真实 graph.json
 * 验证 state.foldMarks 的跨会话取数。不启动 DSH、不访问网络、不调模型。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath } from "node:url";
import { collectGraphFiles, latestGraphFrom, latestFoldMarksFrom, FOLD_LIST_LIMIT } from "../src/ui.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");
const SOURCE = nodeFs.readFileSync(CLIENT, "utf8");
const FORBIDDEN_LABEL_TEXT = Object.freeze(["二级", "三级", "别动"]);
const BASE = Date.UTC(2026, 10, 5, 4, 0, 0);

/** 只实现 client 用到的 React 接口；每个组件实例有独立 hook 槽。 */
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

function one(node, predicate, description) {
  const found = findAll(node, predicate);
  if (found.length !== 1) throw new Error(`${description}应有 1 个，实际 ${found.length}`);
  return found[0];
}

function labelsOf(tree) {
  return findAll(tree, (node) => node.props?.["data-disclosure"] !== undefined).map(textOf);
}

function panelRenderer(state, source = SOURCE) {
  const loaded = loadClient(source);
  loaded.runtime.seed("Page", [state, { ...state.config }]);
  loaded.runtime.render(loaded.T.Page);
  return loaded;
}

function foldCardText(tree, compact) {
  return textOf(one(tree, (node) => node.props?.["data-fold-compact"] === String(compact), compact ? "首屏折痕卡" : "完整折痕卡"));
}

function mark(offset, sequence) {
  return {
    at: BASE + offset,
    seqStart: sequence * 100 + 1,
    seqEnd: sequence * 100 + 80,
    trigger: sequence % 2 === 0 ? "archive-offline" : "pressure",
    summaryChars: 900 + sequence,
    usage: null,
    truncated: false,
    finishReason: "stop",
  };
}

function writeGraph(home, session, foldMarks, mtimeOffset) {
  const dir = nodePath.join(home, "chess-context", "sessions", session);
  nodeFs.mkdirSync(dir, { recursive: true });
  const file = nodePath.join(dir, "graph.json");
  nodeFs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessionId: session,
    nodes: {},
    edges: {},
    order: [],
    foldCount: foldMarks.length,
    lastFoldTotalTokens: 76543,
    checkpointSeq: null,
    foldMarks,
    lastFoldUsage: null,
  }), "utf8");
  const mtime = new Date(BASE + mtimeOffset);
  nodeFs.utimesSync(file, mtime, mtime);
}

function stateFor(scan, foldMarks) {
  const config = {
    auto: true,
    thresholdRatio: 0.45,
    summaryMode: "hybrid",
    summarizationProvider: "",
    summarizationModel: "",
  };
  return {
    ok: true,
    profile: "desktop",
    version: "1.17.6",
    config,
    defaults: { ...config },
    configFile: null,
    latest: latestGraphFrom(scan),
    foldMarks,
    today: {
      folds: foldMarks.length,
      shadowed: 123456,
      sessions: foldMarks.length === 0 ? 0 : 1,
      totalSessions: scan.files.length,
      totalFailures: 0,
      costUsd: 0,
      costKnown: 0,
      peakFolds: 0,
      truncated: 0,
      inputTruncated: 0,
    },
    health: { installed: true, mounted: true, singleInstance: true, profile: "desktop", presets: [] },
    models: { providers: [{ provider: "fixture", name: "Fixture", models: [{ id: "model-128k", name: "Model 128K", contextWindow: 128000 }] }] },
    update: null,
  };
}

function renderScenario(name, home) {
  const scan = collectGraphFiles(home);
  const foldMarks = latestFoldMarksFrom(scan);
  const state = stateFor(scan, foldMarks);
  const panel = panelRenderer(state);
  const defaultTree = panel.runtime.tree();
  const defaultFoldText = foldCardText(defaultTree, true);
  const labels = labelsOf(defaultTree);
  one(defaultTree, (node) => node.props?.["data-disclosure"] === "fold-history", "折痕 Disclosure").props.onClick();
  panel.runtime.render(panel.T.Page);
  const expandedTree = panel.runtime.tree();
  return {
    name,
    state,
    foldMarks,
    latestSession: state.latest?.session ?? null,
    currentFoldCount: state.latest?.foldCount ?? 0,
    labels,
    defaultTree,
    defaultFoldText,
    expandedTree,
    fullFoldText: foldCardText(expandedTree, false),
  };
}

function buildScenarios() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-panel-labels-"));
  try {
    const globalHome = nodePath.join(root, "global");
    writeGraph(globalHome, "global-current", [mark(100, 1), mark(300, 3)], 10_000);
    writeGraph(globalHome, "global-other", [mark(200, 2)], 9_000);

    const currentEmptyHome = nodePath.join(root, "current-empty");
    writeGraph(currentEmptyHome, "current-empty", [], 10_000);
    writeGraph(currentEmptyHome, "archived-with-folds", [mark(100, 1), mark(400, 4)], 9_000);

    const emptyHome = nodePath.join(root, "empty");
    writeGraph(emptyHome, "empty-current", [], 10_000);

    return {
      global: renderScenario("全局有折痕", globalHome),
      currentEmpty: renderScenario("当前会话无（全局有折痕）", currentEmptyHome),
      empty: renderScenario("全局真无", emptyHome),
    };
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

const scenarios = buildScenarios();

function evidenceFor(scenario) {
  return [
    `=== ${scenario.name} ===`,
    `最近活跃会话：${scenario.latestSession}；该会话 foldCount=${scenario.currentFoldCount}；全局列表=${scenario.foldMarks.length} 条`,
    "[首屏最近折痕]",
    scenario.defaultFoldText,
    "[展开后的折痕列表]",
    scenario.fullFoldText,
    "[展开区标签]",
    ...scenario.labels,
  ].join("\n");
}

export const RENDER_EVIDENCE = [scenarios.global, scenarios.currentEmpty, scenarios.empty].map(evidenceFor).join("\n\n");

function assertCleanLabels(labels) {
  for (const forbidden of FORBIDDEN_LABEL_TEXT) {
    if (labels.some((label) => label.includes(forbidden))) throw new Error(`标签含结构术语：${forbidden}；${JSON.stringify(labels)}`);
  }
}

function assertFoldTextConsistency(markCount, text) {
  const hasEmpty = text.split("\n").includes("还没有折叠");
  if (markCount > 0 && hasEmpty) throw new Error("全局有折痕却显示空态");
  if (markCount === 0 && !hasEmpty) throw new Error("全局真无折痕却缺少空态");
}

function countText(text, needle) {
  return text.split(needle).length - 1;
}

export const tests = {
  "① 三个展开区按内容命名，标签不含结构层级或警告词": (t) => {
    t.eq(scenarios.global.labels, ["折痕列表（3）", "常用配置", "高级配置"], "全局有折痕时标签与计数准确");
    t.eq(scenarios.empty.labels, ["折痕列表（0）", "常用配置", "高级配置"], "全局真空时仍按内容命名");
    for (const scenario of Object.values(scenarios)) {
      t.throws(() => assertCleanLabels(["二级 · 折痕列表"]), "负例自身必须被守卫拒绝");
      assertCleanLabels(scenario.labels);
      for (const forbidden of FORBIDDEN_LABEL_TEXT) {
        for (const label of scenario.labels) t.notIncludes(label, forbidden, `${scenario.name}标签不得出现 ${forbidden}`);
      }
    }
    t.includes(scenarios.global.expandedTree ? textOf(scenarios.global.expandedTree) : "", "折痕列表（最近 3 条）", "展开后完整列表使用同一全局数据");
  },

  "② foldMarks 跨会话按折痕时刻排序，当前会话为空不再抹掉全局列表": (t) => {
    t.eq(scenarios.global.latestSession, "global-current", "最近活跃会话仍按 graph mtime 独立计算");
    t.eq(scenarios.global.foldMarks.map((row) => row.seqEnd), [380, 280, 180], "全局列表按 at 跨会话排序，而不是拼接会话");
    t.eq(scenarios.currentEmpty.latestSession, "current-empty", "夹具确保当前活跃会话就是空会话");
    t.eq(scenarios.currentEmpty.currentFoldCount, 0, "当前会话确实没有折痕");
    t.eq(scenarios.currentEmpty.foldMarks.map((row) => row.seqEnd), [480, 180], "空当前会话仍返回其它会话的全局折痕");
    for (const scenario of [scenarios.global, scenarios.currentEmpty]) {
      t.ok(scenario.foldMarks.length > 0, `${scenario.name}必须有全局折痕`);
      t.notIncludes(scenario.defaultFoldText, "还没有折叠", `${scenario.name}首屏不得假空`);
      t.notIncludes(scenario.fullFoldText, "还没有折叠", `${scenario.name}完整列表不得假空`);
      t.eq(countText(textOf(scenario.expandedTree), "还没有折叠"), 0, `${scenario.name}整个展开页面都不得出现空态`);
    }
    t.includes(scenarios.currentEmpty.fullFoldText, "seq 401–480", "其它会话的真实折痕必须实际渲染");
  },

  "③ 三种真实渲染输出：全局有 / 当前会话无 / 全局真无": (t) => {
    console.log(RENDER_EVIDENCE);
    t.includes(RENDER_EVIDENCE, "=== 全局有折痕 ===", "输出含全局有折痕场景");
    t.includes(RENDER_EVIDENCE, "=== 当前会话无（全局有折痕） ===", "输出含当前会话空、全局非空场景");
    t.includes(RENDER_EVIDENCE, "=== 全局真无 ===", "输出含全局真空场景");
    t.eq(scenarios.empty.foldMarks, [], "全局真空时 host 返回空数组");
    t.includes(scenarios.empty.defaultFoldText, "还没有折叠", "只有全局真空时首屏才显示空态");
    t.includes(scenarios.empty.fullFoldText, "还没有折叠", "只有全局真空时完整列表才显示空态");
    t.notIncludes(scenarios.empty.fullFoldText, "seq", "真空不得硬塞折痕行");
    t.eq(countText(textOf(scenarios.empty.expandedTree), "还没有折叠"), 2, "真空展开后首屏与完整列表各有一个合法空态");
  },

  "④ 全局最近列表跨会话封顶 20 条，空扫描才返回空": (t) => {
    const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-panel-labels-limit-"));
    try {
      writeGraph(home, "left", Array.from({ length: 15 }, (_, index) => mark(index * 2, index + 1)), 10_000);
      writeGraph(home, "right", Array.from({ length: 15 }, (_, index) => mark(index * 2 + 1, index + 21)), 9_000);
      const marks = latestFoldMarksFrom(collectGraphFiles(home));
      t.eq(marks.length, FOLD_LIST_LIMIT, "跨会话总量必须封顶 20");
      t.eq(FOLD_LIST_LIMIT, 20, "面板契约仍是最近 20 条");
      const epochs = marks.map((row) => row.at);
      t.eq(epochs, [...epochs].sort((a, b) => b - a), "全局输出必须最新在前");
      t.eq(marks[0].at, BASE + 29, "最新一条来自另一个会话，不被最近活跃会话遮住");
      t.eq(latestFoldMarksFrom({ files: [] }), [], "没有棋谱才是真正空列表");
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  },

  "⑤ 失败分支真红：旧标签或假空态变异必须被同一守卫拒绝": (t) => {
    const oldLabelSource = SOURCE.replace(
      "title: `折痕列表（${allFoldMarks.length}）`",
      "title: `二级 · 完整折痕列表（${allFoldMarks.length}）`",
    );
    t.ne(oldLabelSource, SOURCE, "旧标签变异必须命中源码");
    const oldLabelPanel = panelRenderer(scenarios.global.state, oldLabelSource);
    t.throws(() => assertCleanLabels(labelsOf(oldLabelPanel.runtime.tree())), "旧标签必须让标签守卫变红");

    const missingEmptySource = SOURCE.replaceAll("marks.length === 0", "false");
    t.ne(missingEmptySource, SOURCE, "隐藏空态变异必须命中源码");
    const missingEmptyPanel = panelRenderer(scenarios.empty.state, missingEmptySource);
    const missingEmptyText = foldCardText(missingEmptyPanel.runtime.tree(), true);
    t.throws(() => assertFoldTextConsistency(0, missingEmptyText), "全局真空却不显示空态必须变红");

    const falseEmptySource = SOURCE.replaceAll("marks.length === 0", "true");
    t.ne(falseEmptySource, SOURCE, "假空态变异必须命中源码");
    const falseEmptyPanel = panelRenderer(scenarios.global.state, falseEmptySource);
    const falseEmptyText = foldCardText(falseEmptyPanel.runtime.tree(), true);
    t.throws(() => assertFoldTextConsistency(scenarios.global.foldMarks.length, falseEmptyText), "全局有折痕却显示空态必须变红");
  },
};
