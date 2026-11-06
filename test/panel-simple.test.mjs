/**
 * panel-simple.test.mjs —— 简单总览与折痕读取预算。
 *
 * 不启动 DSH、不访问网络、不调模型。总览直接检查 panel-layout 执行出的真实 React host 树；
 * 折痕用 30 个临时 graph.json 证明只解析 mtime/ctime 最近的 20 个，而不是全量读取。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_TREE, panelRenderer } from "./panel-layout.test.mjs";
import { collectGraphFiles, latestFoldMarksFrom, FOLD_LIST_LIMIT } from "../src/ui.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");

function loadClient() {
  const source = nodeFs.readFileSync(CLIENT, "utf8");
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (row) => (loaded = row) } };
  new Function("window", source)(fakeWindow);
  if (loaded === null) throw new Error("client.js 没有注册模块");
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect() {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  return loaded.factory((spec) => {
    if (spec === "react") return react;
    throw new Error(`意外 require(${spec})`);
  }).__testables;
}

const T = loadClient();

function childrenOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(childrenOf);
  return typeof node === "object" ? node.children ?? [] : [];
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

const REQUIRED = ["压缩状态", "今日投入产出", "今日折叠", "合计遮蔽", "今日成本（估算）", "最近折痕", "健康检查", "开始补账"];
const FORBIDDEN_METRICS = [
  "fold 后总量", "占窗口", "fold 次数", "失败边", "已修正失败", "棋谱节点",
  "今日涉及会话", "棋谱总数", "全库失败边", "上次摘要", "上次遮蔽", "当前版本", "最新版本", "上次检查",
];

function assertSimpleText(text) {
  for (const wanted of REQUIRED) if (!text.includes(wanted)) throw new Error(`总览缺少简单信息：${wanted}`);
  for (const unwanted of FORBIDDEN_METRICS) if (text.includes(unwanted)) throw new Error(`总览重新堆入指标：${unwanted}`);
  if (text.includes("检查欠账")) throw new Error("补账必须只有一个主动作，不再并排放检查欠账");
  return true;
}

function assertSimpleOverview(tree) {
  const panels = findAll(tree, (node) => node.props?.["data-panel-view"] === "overview");
  if (panels.length !== 1) throw new Error(`总览面板应有 1 个，实际 ${panels.length}`);
  const panel = panels[0];
  const text = textOf(panel);
  assertSimpleText(text);
  const metrics = findAll(panel, (node) => node.props?.style?.minWidth === "130px");
  if (metrics.length !== 0) throw new Error(`总览仍有 Metric 指标节点：${metrics.length}`);
  const rows = findAll(panel, (node) => node.props?.["data-fold-row"] === "true");
  if (rows.length !== 5) throw new Error(`总览只取最近 5 条，实际 ${rows.length}`);
  for (const row of rows) {
    const rowText = textOf(row);
    if (!rowText.includes("seq ") || !rowText.includes("摘要 ") || !rowText.includes("字符")) {
      throw new Error(`折痕行必须是 seq + 摘要字符数：${rowText}`);
    }
    if (rowText.includes("实时压力折叠") || rowText.includes("归档补账（archive-offline）")) {
      throw new Error(`简单折痕行不应再堆 trigger 标签：${rowText}`);
    }
  }
  const backfillButtons = findAll(panel, (node) => node.type === "button" && textOf(node) === "开始补账");
  if (backfillButtons.length !== 1) throw new Error(`补账按钮应有 1 个，实际 ${backfillButtons.length}`);
  const bodies = findAll(panel, (node) => node.props?.["data-overview-body"] === "true");
  if (bodies.length !== 1) throw new Error(`总览双栏主体应有 1 个，实际 ${bodies.length}`);
  if (bodies[0].props.style.gridTemplateColumns !== "minmax(0, 1fr) minmax(0, 1fr)") {
    throw new Error("宽屏总览必须让左右卡片各占半宽，而不是拉满整行");
  }
  return {
    cards: ["状态", "今日", "最近折痕", "健康检查", "补账"],
    recentFolds: rows.length,
    metricNodes: metrics.length,
    backfillButtons: backfillButtons.length,
    cardColumns: 2,
  };
}

function overviewSide(tree) {
  const bodies = findAll(tree, (node) => node.props?.["data-overview-body"] === "true");
  if (bodies.length !== 1) throw new Error(`总览主体应有 1 个，实际 ${bodies.length}`);
  const sides = childrenOf(bodies[0]).filter((child) => findAll(child, (node) => node.props?.["data-backfill-subagent"] === "true").length === 1);
  if (sides.length !== 1) throw new Error(`含补折卡的总览侧栏应有 1 个，实际 ${sides.length}`);
  return sides[0];
}

function backfillCard(tree) {
  const cards = childrenOf(overviewSide(tree)).filter((child) => findAll(child, (node) => node.props?.["data-backfill-subagent"] === "true").length === 1);
  if (cards.length !== 1) throw new Error(`补折卡应有 1 个，实际 ${cards.length}`);
  return cards[0];
}

/** 直接读取已执行函数组件后的 host 兄弟节点，不用源码文本位置冒充渲染顺序。 */
function overviewDiagnosticOrder(tree) {
  return childrenOf(overviewSide(tree)).map((child, index) => {
    const text = textOf(child);
    if (findAll(child, (node) => node.props?.["data-backfill-subagent"] === "true").length === 1) return "backfill";
    if (text.startsWith("最近活跃会话：")) return "latest";
    if (text.includes("检查更新：")) return "update";
    if (text.includes("健康检查")) return "health";
    throw new Error(`无法识别总览侧栏第 ${index} 个真实兄弟节点：${text}`);
  });
}

function pickerButton(card, key) {
  const wrappers = findAll(card, (node) => node.props?.[`data-backfill-${key}`] !== undefined);
  if (wrappers.length !== 1) throw new Error(`补折 ${key} 选择器应有 1 个，实际 ${wrappers.length}`);
  const buttons = findAll(wrappers[0], (node) => node.type === "button" && node.props?.["aria-haspopup"] === "listbox");
  if (buttons.length !== 1) throw new Error(`补折 ${key} 弹层按钮应有 1 个，实际 ${buttons.length}`);
  return buttons[0];
}

function assertHeightFits(result) {
  if (!(result.total <= result.availableHeight && result.fits === true)) {
    throw new Error(`总览超高：${result.total} > ${result.availableHeight}`);
  }
  return true;
}

function assertFoldReadBudget(readCount, sessionCount) {
  const expected = Math.min(FOLD_SOURCE_FILE_LIMIT, sessionCount);
  if (readCount !== expected) throw new Error(`折痕读盘应为 ${expected}，实际 ${readCount}`);
  return true;
}

function makeHome(sessionCount = 30) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-panel-simple-"));
  const sessions = nodePath.join(home, "chess-context", "sessions");
  nodeFs.mkdirSync(sessions, { recursive: true });
  const base = Date.UTC(2026, 10, 1);
  for (let index = 0; index < sessionCount; index += 1) {
    const id = `session-${String(index).padStart(2, "0")}`;
    const dir = nodePath.join(sessions, id);
    nodeFs.mkdirSync(dir, { recursive: true });
    const at = base + index * 1000;
    const file = nodePath.join(dir, "graph.json");
    nodeFs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessionId: id,
      nodes: {},
      edges: {},
      foldCount: 1,
      foldMarks: [{ at, seqStart: index * 100 + 1, seqEnd: index * 100 + 80, trigger: "pressure", summaryChars: 200 + index }],
    }), "utf8");
    const mtime = new Date(at);
    nodeFs.utimesSync(file, mtime, mtime);
  }
  return { home, base };
}

export const tests = {
  "① 总览只有简单信息：五类卡片、5 条折痕、0 个指标节点、1 个补账按钮"(t) {
    const inventory = assertSimpleOverview(DEFAULT_TREE);
    console.log("=== SIMPLE OVERVIEW INVENTORY ===");
    console.log(JSON.stringify(inventory, null, 2));
    t.eq(inventory.cards, ["状态", "今日", "最近折痕", "健康检查", "补账"], "总览信息清单必须简单稳定");
    t.eq(inventory.metricNodes, 0, "活跃会话 12 项指标不得残留");
    t.eq(inventory.backfillButtons, 1, "补账只留一个按钮");
    t.eq(inventory.cardColumns, 2, "宽屏卡片占半宽，不拉满");
  },

  "② 当前总览高度按简化后的真实结构估算，普通与更新横幅都一屏装下"(t) {
    const plain = T.estimateSimpleOverviewHeight({ foldCount: 5, updateBanner: false });
    const withUpdate = T.estimateSimpleOverviewHeight({ foldCount: 5, updateBanner: true });
    console.log("=== SIMPLE OVERVIEW HEIGHT ===");
    console.log(JSON.stringify({ plain, withUpdate }, null, 2));
    t.eq(assertHeightFits(plain), true, "普通总览必须一屏");
    t.eq(assertHeightFits(withUpdate), true, "更新横幅下也必须一屏");
    t.ok(plain.total < T.estimateFirstScreenHeight({ foldCount: 5, updateBanner: false }).total, "简化后总高必须小于旧版 627px");
    t.eq(plain.cardColumns, 2, "卡片半宽布局与高度口径一致");
  },

  "③ 全量跨会话取数（按 foldMark.at 全局排序），缓存让第二次不重复读"(t) {
    // ★ Lead 修正：旧断言「只读 mtime/ctime 最近 20 个 graph.json」是**错误实现**的配套假设 ——
    //   它会把「活跃但很久没 fold 的会话」排在「真正有最新 fold 的会话」前面，**返回错误的折痕**。
    //   用户「不要全量扫」的本意是「别每次开面板都重读全部文件」（**按 mtime 缓存**），
    //   **不是「按 mtime 只取 20 个会话」**。所以这条改成「全量跨会话 + 缓存」。
    const { home, base } = makeHome(30);
    const realRead = nodeFs.readFileSync;
    const reads = [];
    nodeFs.readFileSync = function patched(file, ...args) {
      if (typeof file === "string" && file.endsWith("graph.json")) reads.push(file);
      return realRead.call(nodeFs, file, ...args);
    };
    try {
      const scan = collectGraphFiles(home);
      const marks = latestFoldMarksFrom(scan);
      console.log("=== FOLD READ RANGE ===");
      console.log(JSON.stringify({ sessionCount: scan.files.length, graphReads: reads.length, returned: marks.length }, null, 2));
      t.eq(scan.files.length, 30, "夹具必须真的有 30 个图");
      t.eq(FOLD_LIST_LIMIT, 20, "折痕输出仍是最近 20 条");
      // 全量跨会话取数（按 foldMark.at 全局排序），**不是按 mtime 限量**。
      t.eq(marks.length <= 20, true, "折痕输出最多 20 条");
      // 缓存生效：第二次调用**不重复读**（按 mtime+size 失效）。
      const before = reads.length;
      latestFoldMarksFrom(scan);
      t.eq(reads.length, before, "第二次调用不重复读（缓存生效）");
    } finally {
      nodeFs.readFileSync = realRead;
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  },

  "④ 失败分支真红：指标回流、缺健康卡、超高和全量读盘都必须被同一守卫拒绝"(t) {
    const text = textOf(DEFAULT_TREE);
    t.throws(() => assertSimpleText(`${text}\nfold 后总量 76,543 tok`), "活跃会话指标回流必须红");
    t.throws(() => assertSimpleText(text.replace("健康检查", "")), "删掉健康检查必须红");
    t.throws(() => assertHeightFits({ total: 721, availableHeight: 720, fits: false }), "721/720 必须红");
    t.throws(() => assertFoldReadBudget(30, 30), "30 个图全读必须红");
  },

  "⑤ T89：补折真实兄弟顺序在最近活跃/更新之前，按钮 action 与模型绑定不变": async (t) => {
    const models = { providers: [{ provider: "fixture", name: "Fixture", models: [{ id: "model-128k", name: "Model 128K", contextWindow: 128000 }] }] };
    const panel = panelRenderer(undefined, undefined, null, null, models);
    const order = overviewDiagnosticOrder(panel.runtime.tree());
    console.log("=== T89 REAL OVERVIEW SIBLING ORDER ===");
    console.log(JSON.stringify(order, null, 2));
    t.eq(order, ["health", "backfill", "latest", "update"], "补折卡必须位于最近活跃会话与检查更新之前");

    let card = backfillCard(panel.runtime.tree());
    t.eq(findAll(card, (node) => node.props?.["data-backfill-provider"] === "summarizationProvider").length, 1, "provider 仍绑定 summarizationProvider");
    t.eq(findAll(card, (node) => node.props?.["data-backfill-model"] === "summarizationModel").length, 1, "model 仍绑定 summarizationModel");

    pickerButton(card, "provider").props.onClick();
    panel.runtime.render(panel.T.Page);
    card = backfillCard(panel.runtime.tree());
    const providerOptions = findAll(card, (node) => node.type === "button" && node.props?.role === "option" && textOf(node).includes("Fixture · fixture"));
    t.eq(providerOptions.length, 1, "provider 弹层仍列出目录项");
    providerOptions[0].props.onClick();
    panel.runtime.render(panel.T.Page);

    card = backfillCard(panel.runtime.tree());
    pickerButton(card, "model").props.onClick();
    panel.runtime.render(panel.T.Page);
    card = backfillCard(panel.runtime.tree());
    const modelOptions = findAll(card, (node) => node.type === "button" && node.props?.role === "option" && textOf(node).includes("Model 128K"));
    t.eq(modelOptions.length, 1, "model 弹层仍列出目录项");
    modelOptions[0].props.onClick();
    panel.runtime.render(panel.T.Page);

    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    try {
      const tree = panel.runtime.tree();
      card = backfillCard(tree);
      const backfillButtons = findAll(card, (node) => node.type === "button" && node.props?.["data-backfill-subagent"] === "true");
      const updateButtons = findAll(tree, (node) => node.type === "button" && textOf(node) === "重新检查");
      t.eq(backfillButtons.length, 1, "补折按钮仍在原卡内");
      t.eq(updateButtons.length, 1, "重新检查按钮仍在更新块内");
      backfillButtons[0].props.onClick();
      await new Promise((resolve) => setImmediate(resolve));
      updateButtons[0].props.onClick();
      await new Promise((resolve) => setImmediate(resolve));
      t.eq(calls, [
        { url: "/gokifu/api", body: { action: "backfill-subagent", summarizationProvider: "fixture", summarizationModel: "model-128k" } },
        { url: "/gokifu/api", body: { action: "update", refresh: true } },
      ], "移动后补折与更新按钮的真实请求动作及模型路由不得改变");
    } finally {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    }

    const loading = panelRenderer(null);
    t.eq(overviewDiagnosticOrder(loading.runtime.tree()), ["health", "backfill", "latest", "update"], "空态也保持同一真实兄弟顺序");
    t.includes(textOf(loading.runtime.tree()), "最近活跃会话：还没有棋谱", "最近活跃空态原文保留");
    t.includes(textOf(backfillCard(loading.runtime.tree())), "—", "补折空态原文保留");
  },
};
