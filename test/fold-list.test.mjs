/**
 * fold-list.test.mjs —— 最近活跃会话的折痕列表守卫。
 *
 * 直接跑真 host 路由与真 client FoldList（轻量 React createElement 桩），覆盖：
 * ① state.foldMarks 的字段齐全且只含页面要渲染的白名单；
 * ② 空数组安全，页面明确显示「还没有折叠」；
 * ③ archive-offline / pressure 分类与含义不混淆；
 * ④ 正常行的时间、区间、摘要字符数、usage、截断与 finishReason 都可见。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const CLIENT = nodePath.join(ROOT, "lib", "client.js");

function loadClient() {
  const src = nodeFs.readFileSync(CLIENT, "utf8");
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (row) => (loaded = row) } };
  new Function("window", src)(fakeWindow);
  if (loaded === null) throw new Error("client.js 没有注册模块");
  const react = {
    createElement: (...args) => ({ args }),
    useState: () => [undefined, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  return loaded.factory((spec) => {
    if (spec === "react") return react;
    throw new Error(`意外 require(${spec})`);
  });
}

const client = loadClient();
const T = client.__testables;

/** 把真实 FoldList 返回的 React 树展成逐行文本，不另写一套渲染逻辑。 */
export function renderFoldListText(marks) {
  const tree = T.FoldList({ marks });
  const text = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(text).filter(Boolean).join("\n");
    if (typeof node === "object" && Array.isArray(node.args)) return node.args.slice(2).map(text).filter(Boolean).join("\n");
    return String(node);
  };
  return text(tree);
}

export const HOST_SAMPLE_MARKS = Object.freeze({
  archive: {
    at: Date.UTC(2026, 10, 5, 11, 0, 0),
    seqStart: 1,
    seqEnd: 100,
    trigger: "archive-offline",
    summaryChars: 480,
    usage: null,
    truncated: null,
    finishReason: null,
    summaryText: "这段正文不得进入列表 payload",
    shadowedTokens: 7000,
  },
  pressure: {
    at: Date.UTC(2026, 10, 5, 12, 34, 56),
    seqStart: 101,
    seqEnd: 180,
    trigger: "pressure",
    summaryChars: 960,
    usage: {
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1020,
      cacheReadTokens: 300,
      provider: "not-for-list",
      model: "not-for-list",
    },
    truncated: false,
    finishReason: "stop",
    summaryText: "这段正文也不得进入列表 payload",
    shadowedTokens: 8000,
  },
});

export const RENDER_SAMPLES = Object.freeze({
  empty: renderFoldListText([]),
  normal: renderFoldListText([HOST_SAMPLE_MARKS.pressure]),
  multiple: renderFoldListText([HOST_SAMPLE_MARKS.archive, HOST_SAMPLE_MARKS.pressure]),
});

function makeHome(foldMarks) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-fold-list-"));
  const session = nodePath.join(home, "chess-context", "sessions", "session-fold-list");
  nodeFs.mkdirSync(session, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(home, "profiles", "desktop"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(home, "profiles", "desktop", "package.json"), JSON.stringify({ name: "desktop", dependencies: {} }), "utf8");
  nodeFs.writeFileSync(nodePath.join(session, "graph.json"), JSON.stringify({
    version: 1,
    sessionId: "session-fold-list",
    nodes: {},
    edges: {},
    foldCount: foldMarks.length,
    lastFoldTotalTokens: 1234,
    foldMarks,
    lastFoldUsage: null,
  }), "utf8");
  return home;
}

async function callState(handler) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: "state" });
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
      on(event, callback) {
        if (event === "data") callback(Buffer.from(body, "utf8"));
        if (event === "end") callback();
        return req;
      },
    };
    const res = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(text) {
        try {
          resolve({ status: this.status, json: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

export const tests = {
  "host state.foldMarks：八字段齐全、usage 三桶、最新在前且不泄露无关字段": async (t) => {
    const ui = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
    const home = makeHome([HOST_SAMPLE_MARKS.archive, HOST_SAMPLE_MARKS.pressure]);
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const routes = [];
      ui.apply({ webServer: { register: (route) => (routes.push(route), () => {}), host: "127.0.0.1" }, effect: (fn) => fn() });
      t.eq(routes.length, 1, "必须注册现有 /gokifu/api 路由");
      const response = await callState(routes[0].handler);
      t.eq(response.status, 200, "state 必须成功");
      t.eq(response.json.latest.session, "session-fold-list", "列表对应最近活跃会话");
      t.eq(response.json.foldMarks.length, 2, "两次折叠都返回");
      const first = response.json.foldMarks[0];
      t.eq(Object.keys(first), ["at", "seqStart", "seqEnd", "trigger", "summaryChars", "usage", "truncated", "finishReason"], "host 字段清单必须逐项一致");
      t.eq(first.trigger, "pressure", "数组按最新折痕在前");
      t.eq(first.seqStart, 101, "seqStart 保留");
      t.eq(first.seqEnd, 180, "seqEnd 保留");
      t.eq(first.summaryChars, 960, "summaryChars 保留");
      t.eq(first.truncated, false, "truncated=false 不得丢成未知");
      t.eq(first.finishReason, "stop", "finishReason 保留");
      t.eq(Object.keys(first.usage), ["inputTokens", "outputTokens", "totalTokens"], "usage 只暴露页面渲染的三项");
      t.eq(first.usage, { inputTokens: 900, outputTokens: 120, totalTokens: 1020 }, "token 数值不变");
      const serialized = JSON.stringify(response.json.foldMarks);
      for (const unwanted of ["summaryText", "shadowedTokens", "cacheReadTokens", "provider", "model", "not-for-list", "不得进入列表"]) {
        t.notIncludes(serialized, unwanted, `列表不得带出 ${unwanted}`);
      }
      t.eq(response.json.latest.lastFold.summaryText, HOST_SAMPLE_MARKS.pressure.summaryText, "既有 lastFold 契约保持原样");
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  },

  "空数组与无棋谱都不炸；空态明确显示「还没有折叠」而不是空表": async (t) => {
    const ui = await import(pathToFileURL(nodePath.join(ROOT, "src", "ui.mjs")).href);
    t.eq(ui.foldMarksForUi([]), [], "空数组原样返回");
    t.eq(ui.foldMarksForUi(null), [], "缺失数组也降级为空");
    t.eq(ui.latestFoldMarksFrom({ files: [] }), [], "没有棋谱返回空数组");
    t.eq(RENDER_SAMPLES.empty, "折痕列表\n还没有折叠", "空态文本必须准确");
    t.notIncludes(RENDER_SAMPLES.empty, "seq", "空态不得渲染折痕行");
    t.notIncludes(RENDER_SAMPLES.empty, "最近 0 条", "空态不得伪装成列表");
  },

  "trigger 分类：archive-offline=归档补账、pressure=实时压力折叠，含义与标签都不同": (t) => {
    const archive = T.foldTriggerInfo("archive-offline");
    const pressure = T.foldTriggerInfo("pressure");
    t.eq(archive.kind, "archive-offline", "归档 trigger 不得归类到 pressure");
    t.eq(pressure.kind, "pressure", "压力 trigger 不得归类到 archive-offline");
    t.eq(archive.label, "归档补账（archive-offline）", "归档标签要可见");
    t.eq(pressure.label, "实时压力折叠（pressure）", "压力标签要可见");
    t.ne(archive.label, pressure.label, "两类不能混着显示");
    t.ne(archive.meaning, pressure.meaning, "两类含义不能混用");
    t.includes(archive.meaning, "已归档", "归档补账说明离线补账语义");
    t.includes(pressure.meaning, "在线", "pressure 说明实时压力语义");
    t.eq(T.foldTriggerInfo("manual").label, "manual", "其它 trigger 保留真值");
    t.includes(RENDER_SAMPLES.multiple, archive.label, "多 trigger 树含归档补账");
    t.includes(RENDER_SAMPLES.multiple, pressure.label, "多 trigger 树含实时压力折叠");
    t.includes(RENDER_SAMPLES.multiple, "seq 1–100", "归档区间可见");
    t.includes(RENDER_SAMPLES.multiple, "seq 101–180", "压力区间可见");
  },

  "正常渲染：时间、区间、摘要字符数、usage、截断与 finishReason 全部来自真实 React 树": (t) => {
    t.includes(RENDER_SAMPLES.normal, "折痕列表（最近 1 条）", "标题带实际条数");
    t.includes(RENDER_SAMPLES.normal, T.formatFoldTimestamp(HOST_SAMPLE_MARKS.pressure.at), "时间使用真实格式化函数");
    t.includes(RENDER_SAMPLES.normal, "seq 101–180", "区间可见");
    t.includes(RENDER_SAMPLES.normal, "摘要 960 字符", "摘要字符数可见");
    t.includes(RENDER_SAMPLES.normal, "输入 900 / 输出 120 / 总计 1,020 tok", "token 用量可见");
    t.includes(RENDER_SAMPLES.normal, "截断：否 · finishReason：stop", "完成状态可见");
    t.includes(RENDER_SAMPLES.multiple, "截断：未知 · finishReason：—", "缺失完成状态不得编造");
    const source = nodeFs.readFileSync(CLIENT, "utf8");
    const layout = /const rightColumn = \[([^\]]*)\]/.exec(source);
    t.ok(layout !== null, "必须找到右栏布局");
    t.ok(layout[1].split(",").map((name) => name.trim()).includes("foldListCard"), "折痕卡必须真的摆进现有右栏");
    t.eq(T.styles.foldRow.padding, "16px 0", "行间距沿用官方 General row");
    t.eq(T.styles.foldRow.borderBottom, "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.12))", "行底边沿用官方令牌");
    t.eq(T.styles.foldTrigger.padding, "1px 6px", "trigger tag 沿用官方几何");
  },
};
