/**
 * fold-cost-time.test.mjs —— 折叠成本要按**折叠发生的时刻**计价（C453）
 *
 * 背景：C452 补上了官方峰谷两档（off-peak 是 peak 的一半），但如果聚合时不传时刻，
 * 每一次折叠都会被按低谷价算 —— 白天干活时面板就系统性**低报一倍**。
 * `foldMark.at` 本来就在，只是以前没人拿它定价。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { todayAggregateFrom, collectGraphFiles, estimateFoldCostUsd } from "../src/ui.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const TMP = nodePath.join(HERE, ".tmp-foldcost");

/** 造一个只有 foldMarks 的最小图（够 todayAggregateFrom 用）。 */
function writeGraph(home, sessionId, foldMarks) {
  const dir = nodePath.join(home, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const graph = {
    version: 1,
    sessionId,
    cwd: "D:/tmp",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextNode: 2,
    nextEdge: 1,
    nodes: {},
    edges: {},
    order: [],
    stateIndex: {},
    rootUserNodeIds: [],
    foldCount: foldMarks.length,
    foldMarks,
  };
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph), "utf8");
  return dir;
}

/** 今天本地零点起算的一个时刻：取"今天 UTC hh:00" —— 用它来构造峰/谷两个时间点。 */
function todayUtcHour(h) {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0);
}

const USAGE = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 1_000_000, model: "deepseek-flash" };

tests["C453 今日聚合按 foldMark.at 计价：高峰折叠必须算成两倍，并单独计数"] = (t) => {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  // 2026-11-02 是周一；但这里用"今天的 UTC 小时"，避免依赖跑测试的日期是周几 —— 所以两条都取同一小时，
  // 只让**单价**成为变量：一条标在高峰时段，另一条用低谷价直接对账。
  // ★ C509：这两个时刻必须**都在「本地今天」里**，否则半夜跑这条测试必红
  //   （沿用原写法时：本地 00:13 的"今天 UTC hh:00"其实落在本地午夜之前 ⇒ 聚合把它们全过滤掉 ⇒ costKnown=0）。
  const startLocal = new Date();
  startLocal.setHours(0, 0, 0, 0);
  const fromLocal = startLocal.getTime();
  const isWeekend = [0, 6].includes(new Date().getUTCDay());
  // 高峰窗口是 UTC 01–04：从本地午夜起往后找**第一个**落在该窗口的整点（可能在今天稍晚，也可能明天）
  const peakAt = (() => {
    const d = new Date(fromLocal);
    for (let i = 0; i < 48; i += 1) {
      const t = fromLocal + i * 3600_000;
      const h = new Date(t).getUTCHours();
      if (h >= 1 && h <= 3 && t >= fromLocal) return Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate(), h, 0, 0);
      void d;
    }
    return fromLocal + 2 * 3600_000;
  })();
  const offAt = fromLocal + 12 * 3600_000;   // 本地午夜 +12h：一定在「今天」里，且不在 UTC 01–03
  writeGraph(TMP, "session-cost", [
    { at: offAt, trigger: "pressure", shadowedTokens: 1000, usage: USAGE },
    { at: peakAt, trigger: "pressure", shadowedTokens: 1000, usage: USAGE },
  ]);
  const agg = todayAggregateFrom(collectGraphFiles(TMP));
  const single = estimateFoldCostUsd(USAGE, "deepseek-flash", { at: offAt });
  t.eq(agg.costKnown, 2, "两次折叠都有 usage");
  t.eq(Number(agg.costUsd.toFixed(6)), Number((single + estimateFoldCostUsd(USAGE, "deepseek-flash", { at: peakAt })).toFixed(6)), "总额 = 各自按自己时刻计价之和");
  if (isWeekend) {
    t.eq(agg.peakFolds, 0, "周末没有高峰段（UTC 02:00 也按低谷算）");
    t.eq(Number(agg.costUsd.toFixed(6)), Number((single * 2).toFixed(6)), "周末两条都是低谷价");
  } else {
    t.eq(agg.peakFolds, 1, "只有那条落在高峰窗口里");
    t.eq(Number(agg.costUsd.toFixed(6)), Number((single * 3).toFixed(6)), "低谷 1 份 + 高峰 2 份 = 3 倍单份");
  }
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};

tests["C453 同一份 usage 换个 at：峰时正好是低谷两倍（聚合层的源头保证）"] = (t) => {
  const off = estimateFoldCostUsd(USAGE, "deepseek-flash", { at: todayUtcHour(12) });
  const on = estimateFoldCostUsd(USAGE, "deepseek-flash", { at: todayUtcHour(2) });
  const weekend = [0, 6].includes(new Date().getUTCDay());
  t.eq(weekend ? on === off : Math.abs(on - off * 2) < 1e-9, true, weekend ? "周末两档相同" : "峰时 = 低谷 × 2");
  // 不传 at ⇒ 低谷（下限），这条是 C452 定下的约定，别在聚合里被破坏
  t.eq(estimateFoldCostUsd(USAGE, "deepseek-flash"), off, "不传 at 必须等于低谷价");
};
