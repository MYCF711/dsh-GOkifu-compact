/**
 * tail-gap.test.mjs —— 「71 vs 7」这场数字矛盾的口径守卫（C649）
 *
 * 由来（2026-11-05）：同一台机器同一时刻，
 *   `backfill-forecast` 说欠账 7 个会话，`doctor` 的 C516 说 71 个会话归档时还有 ≥1000 事件未折。
 * 逐条对账（`scripts/tail-gap-audit.mjs`）之后发现两件事：
 *
 *   ① **两个数都对**：doctor 数的是 `closeout.eventsSinceLastFold`（归档那一刻的快照），
 *      debt 数的是「现在还能折什么」——同一批会话里交集只有几个。
 *   ② **但 debt 有一处真漏算**：老判据写成「有洞就只看洞」，
 *      于是「尾巴 339 + 缺口 11」这类会话（离线补折每轮都会留下 5–11 个事件的前缀缺口）
 *      尾巴整段从欠账里消失 —— 本机 39 个会话 / 29,361 事件就是这么被藏起来的。
 *
 * 本文件守的就是这两条，外加 doctor 那一行**不许再把快照说成现状**：
 *   ① debt：小缺口不许吃掉大尾巴（旧判据在同一份夹具上必须真红）
 *   ② 缺口够大仍然算欠（C519 的语义不许因为这次放宽而被顺手删掉）
 *   ③ 两个都小 ⇒ 仍然不欠（放宽不等于把阈值丢掉）
 *   ④ 归档尾巴判据与 `doctor.mjs` 的 C516 **逐字一致**（两边漂了这里就红）
 *   ⑤ doctor 那一行必须把「归档时」和「现在」分开说，并单列「补不了」
 *   ⑥ 分类统计（能补 / 补不了 / 已补完 / closeout 判结清）不许互相串门
 *   ⑦ 探针必须认出「有洞只看洞」是**旧**判据（有人改回去，这条立刻红）
 */
import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addAgentNode, toJSON } from "./graph-fixtures.mjs";
import { debtOfGraph, DEFAULT_MIN_EVENTS } from "../src/rooms/closeout-backfill.mjs";
import { loadSessionGraph } from "../scripts/graph-audit.mjs";
import { archiveTailOf, auditHome, classifyRow, detectDueRule, summarizeRows, BIG_TAIL_MIN } from "../scripts/tail-gap-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 造一张裸图：`seqs` 决定图上节点的序号，`marks` 决定折到哪。 */
function mkGraph({ seqs = [], marks = [], closeout } = {}) {
  const nodes = {};
  for (const [i, seq] of seqs.entries()) nodes[`n${i + 1}`] = { id: `n${i + 1}`, seq };
  const graph = { nodes, edges: {}, order: Object.keys(nodes), foldMarks: marks };
  if (closeout !== undefined) graph.closeout = closeout;
  return graph;
}

/**
 * 造一个最小 DSH home（只出 doctor / audit 需要的那些文件）。
 * @param {Array<{id:string, nodeSeqs?:number[], empty?:boolean, foldMarks?:object[], closeout?:object}>} sessions
 */
function makeHome(sessions) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c649-"));
  for (const s of sessions) {
    const dir = nodePath.join(root, "chess-context", "sessions", s.id);
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = createGraph({ sessionId: s.id });
    if (s.empty !== true) {
      g.rootUserNodeIds = [addUserNodeId(g, { seq: 1, text: "把 71 与 7 的矛盾解释清楚" })];
      for (const seq of s.nodeSeqs ?? []) addAgentNode(g, { seq, goal: "对账", worldHash: "W1", constraintHash: "C1" });
    }
    g.foldMarks = s.foldMarks ?? [];
    if (s.closeout !== undefined) g.closeout = s.closeout;
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
  }
  return root;
}

/** 跑一次 doctor --json（有 error 级检查时退出码非 0，但 stdout 仍是完整 JSON）。 */
function runDoctor(home) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "doctor.mjs"), "--json"], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
  } catch (error) {
    out = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const payload = JSON.parse(out);
  return (prefix) => payload.checks.find((c) => String(c.name).startsWith(prefix));
}

const TEMP = [];
const makeHomeTracked = (sessions) => {
  const home = makeHome(sessions);
  TEMP.push(home);
  return home;
};
process.on("exit", () => {
  for (const home of TEMP) {
    try {
      nodeFs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

/* ─────────────────────── ① debt：小缺口不许吃大尾巴 ─────────────────────── */

/**
 * ★ C649 的**旧判据**（照抄修前那一行）：
 *   `due = 有洞 ? 洞 ≥ 阈值 : 未结清 && 尾巴 ≥ 阈值`
 * 内联在这里，是为了证明「同一份夹具，旧代码确实说它不欠」——
 * 只证明新代码说欠是不够的（那可能是夹具本来就有问题）。
 */
const OLD_due = (tail, gap, closedOut, minEvents = DEFAULT_MIN_EVENTS) =>
  gap > 0 ? gap >= minEvents : closedOut !== true && tail >= minEvents;

tests["C649 ① 小缺口不许吃掉大尾巴（旧判据在同一份夹具上必须是「不欠」）"] = (t) => {
  // 真机形状（session-742a7f59，2026-11-05）：折痕 12–337，尾巴到 676，
  // closeout 同时写着 `offlineUncoveredHead: {events: 11}` 与 `offlineUncoveredTail: {events: 339}`。
  const g = mkGraph({
    seqs: [13, 676],
    marks: [{ seqStart: 12, seqEnd: 337, trigger: "archive-offline", shadowedTokens: 3390 }],
    closeout: {
      at: 1,
      source: "archive-offline",
      foldAttempted: true,
      folded: 1,
      foldOffline: true,
      partial: true,
      offlineUncoveredHead: { from: 1, events: 11 },
      offlineUncoveredTail: { events: 339 },
    },
  });
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.tail, 339, "尾巴 = maxSeq(676) − 最后一次折痕(337)");
  t.eq(debt.gapEvents, 11, "前段还欠 11 个事件");
  t.eq(debt.closedOut, false, "partial 的 closeout 不许算结清（C493）");

  t.eq(OLD_due(debt.tail, debt.gapEvents, debt.closedOut), false, "旧判据在这份夹具上必须判「不欠」（否则证明不了漏算）");
  t.eq(debt.due, true, "尾巴 339 ≥ 40 ⇒ 必须算欠账（C649：缺口不许取代尾巴）");

  // 同一模块的另外两处口径本来就是**相加**的 —— 这才是「due 该独立判」的依据
  t.eq(debt.estTokens, Math.round((debt.tail + debt.gapEvents) * debt.tokensPerEvent), "estTokens 一直是 tail + gap；due 不该另立一套");
};

tests["C649 ② 缺口够大仍然算欠 —— C519 的语义不许被这次放宽顺手删掉"] = (t) => {
  const g = mkGraph({
    seqs: [1, 9000],
    marks: [{ seqStart: 8000, seqEnd: 9000, trigger: "archive-offline" }],
    closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true, partial: true, offlineUncoveredHead: { from: 1, events: 7999 } },
  });
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.tail, 0, "尾巴已经折干净");
  t.eq(debt.gapEvents, 7999, "但前段还欠 7,999");
  t.eq(debt.due, true, "洞够大 ⇒ 欠账（C519 原语义）");
};

tests["C649 ③ 尾巴和缺口都太小 ⇒ 仍然不欠（放宽不等于把阈值丢掉）"] = (t) => {
  const g = mkGraph({
    seqs: [1, 100],
    marks: [{ seqStart: 1, seqEnd: 90, trigger: "archive-offline" }],
    closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true, partial: true, offlineUncoveredHead: { from: 1, events: 5 } },
  });
  const debt = debtOfGraph(g, { minEvents: 40 });
  t.eq(debt.tail, 10, "尾巴 100 − 90 = 10");
  t.eq(debt.gapEvents, 5, "缺口 5");
  t.eq(debt.due, false, "两样都 < 40 ⇒ 不值得花一次模型调用");
};

/* ────────────────── ④ 归档尾巴判据必须与 doctor 一致 ────────────────── */

tests["C649 ④ 归档尾巴判据与 doctor C516 逐字一致（两条路：快照 / 现算）"] = (t) => {
  const SNAP = "session-c649aaaa-0000-4000-8000-000000000001";
  const COMPUTED = "session-c649bbbb-0000-4000-8000-000000000002";
  const home = makeHomeTracked([
    // 快照优先：closeout 写死 1234（图上线索完全不同，也不许改口）
    { id: SNAP, nodeSeqs: [1200], foldMarks: [{ at: 1, seqStart: 1, seqEnd: 999, trigger: "archive" }], closeout: { at: 1, source: "archive", eventsSinceLastFold: 1234 } },
    // 缺字段 ⇒ 现算 maxSeq − max(seqEnd) = 5000 − 3002
    { id: COMPUTED, nodeSeqs: [5000], foldMarks: [{ at: 1, seqStart: 10, seqEnd: 3002, trigger: "archive-offline" }], closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 1 } },
  ]);
  const mine = new Map();
  for (const id of [SNAP, COMPUTED]) {
    const g = loadSessionGraph(nodePath.join(home, "chess-context", "sessions", id, "graph.json")).graph;
    const snap = archiveTailOf(g);
    mine.set(id.replace(/^session-/, "").slice(0, 8), snap);
  }
  t.eq(mine.get("c649aaaa").tail, 1234, "有快照就用快照");
  t.eq(mine.get("c649aaaa").from, "closeout.eventsSinceLastFold", "来源要能说清");
  t.eq(mine.get("c649bbbb").tail, 1998, "缺字段时现算 5000 − 3002");
  t.eq(mine.get("c649bbbb").from, "computed", "来源要能说清");

  const row = runDoctor(home)("归档后剩余的未折尾巴");
  t.eq(!!row, true, "必须有「归档后剩余的未折尾巴」这一行");
  const reported = new Map([...String(row.detail).matchAll(/([0-9a-f]{8})\((\d+)\)/g)].map((m) => [m[1], Number(m[2])]));
  t.eq(reported.get("c649aaaa"), 1234, `doctor 报的快照值要与本脚本一致：${String(row.detail).slice(0, 200)}`);
  t.eq(reported.get("c649bbbb"), 1998, "doctor 报的现算值要与本脚本一致（判据漂了就红）");
  t.eq(BIG_TAIL_MIN, 1000, "门槛同样是 1000（doctor 的 C516 写死的就是它）");
};

/* ───────── ⑤ doctor 那一行：快照 ≠ 现状，且补不了的要单列 ───────── */

tests["C649 ⑤ doctor 必须把「归档时」与「现在」分开说，并单列「补不了」"] = (t) => {
  const STILL = "session-c649cc01-0000-4000-8000-000000000003";
  const EMPTY = "session-c649cc02-0000-4000-8000-000000000004";
  const DONE = "session-c649cc03-0000-4000-8000-000000000005";
  const home = makeHomeTracked([
    // 归档时 5000 未折，现在**还欠**（foldAttempted + folded:0 ⇒ 未结清）
    { id: STILL, nodeSeqs: [5000], foldMarks: [{ at: 1, seqStart: 1, seqEnd: 100, trigger: "archive-offline" }], closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 0, foldError: "timeout", eventsSinceLastFold: 5000 } },
    // 归档时 7706 未折，但图上 0 个节点 ⇒ 算不出折叠区间，永远补不了
    { id: EMPTY, empty: true, closeout: { at: 1, source: "archive", eventsSinceLastFold: 7706 } },
    // 归档时 1200 未折，现在尾巴 0 ⇒ 已折完
    { id: DONE, nodeSeqs: [1200], foldMarks: [{ at: 1, seqStart: 1, seqEnd: 1200, trigger: "archive" }], closeout: { at: 1, source: "archive", foldAttempted: true, folded: 1, eventsSinceLastFold: 1200 } },
  ]);
  const row = runDoctor(home)("归档后剩余的未折尾巴");
  const detail = String(row?.detail ?? "");
  t.eq(row.status, "warn", `有归档大尾巴就必须 warn：${detail.slice(0, 160)}`);
  t.includes(detail, "归档那一刻", "必须明说是**归档那一刻**的数字（快照）");
  t.includes(detail, "不是现在", "必须明说它不是现状 —— 旧文案就是错在这里");
  t.includes(detail, "仍欠 **1**", `现算仍欠的个数要对：${detail.slice(0, 300)}`);
  t.includes(detail, "已折完 1 个", "已折完的要单独数出来");
  t.includes(detail, "**补不了 1 个**", "补不了的必须单列一档（旧文案把它们混进「只能补账」）");
  t.includes(detail, "图里没有节点", "要说明补不了的原因");
  // 三个归档时数字都要在（快照），且不许漏掉任何一个
  for (const n of ["5000", "7706", "1200"]) t.includes(detail, n, `归档时的 ${n} 必须出现在榜单里`);
};

/* ───────────────────── ⑥ 分类统计不许互相串门 ───────────────────── */

tests["C649 ⑥ 分类：能补 / 补不了 / 已补完 / closeout 判结清 各归各的桶"] = (t) => {
  const row = (over) => ({ hasLog: true, nodes: 10, gap: 0, tailNow: 500, due: false, closedOut: false, marks: 3, ...over });
  const rows = [
    row({ due: true, closedOut: false }),
    row({ due: false, closedOut: true, tailNow: 500 }),
    row({ due: false, closedOut: true, tailNow: 10 }),
    row({ due: true, hasLog: false }),
    row({ due: false, closedOut: true, nodes: 0, tailNow: 0 }),
  ];
  const stats = summarizeRows(rows, { minEvents: 40 });
  t.eq(stats.total, 5, "五行都要数进去");
  t.eq(stats.dueNow, 1, "只有第一行现在 due（第二行被 closeout 判结清挡着，第四行日志没了也是补不了）");
  t.eq(stats.cannot.total, 2, "日志缺失 + 空图 = 2 个补不了");
  t.eq(stats.cannot.noLog, 1, "日志缺失算 1 个");
  t.eq(stats.cannot.emptyGraph, 1, "空图算 1 个");
  t.eq(stats.done, 1, "尾巴 10 的那个是已补完");
  t.eq(stats.settledBigTail, 1, "closeout 判结清但尾巴 500 的那个单独一桶");
  t.eq(classifyRow(rows[3], { minEvents: 40 }).code, "no-log", "日志没了先判补不了（哪怕它 due）");
  t.eq(classifyRow(rows[0], { minEvents: 40 }).canFix, true, "due 的是能补的");
  t.eq(classifyRow(rows[1], { minEvents: 40 }).canFix, false, "closeout 判结清的不在补账队列里");
};

/* ───────────── ⑦ 探针：谁把判据改回「有洞只看洞」，这里立刻红 ───────────── */

tests["C649 ⑦ 探针必须认出「有洞只看洞」是旧判据（改回去就红）"] = (t) => {
  const rule = detectDueRule({ minEvents: 40 });
  t.eq(rule.gapSuppressesTail, false, "现行判据必须是「缺口与尾巴各自独立」——若为 true，说明 C649 被回退了");
  t.eq(rule.withGap, true, "尾巴 1000 + 缺口 5 的图必须判 due");
  t.eq(rule.withoutGap, true, "没有缺口时当然也 due（对照）");
  t.includes(rule.text, "各自独立", "报告里的判据描述要跟着一起变");

  // 反证：内联的旧判据在同一个探针输入上必须说「不欠」（否则这条守卫是空的）
  t.eq(OLD_due(1001, 5, false), false, "旧判据在同一份输入上必须判不欠");
};

/* ───────────── ⑧ 端到端：脚本扫出来的榜 == doctor 的榜 ───────────── */

tests["C649 ⑧ auditHome 与 doctor 的榜单必须是同一批会话（同一套判据、同一套阈值）"] = (t) => {
  const home = makeHomeTracked([
    { id: "session-c649dd01-0000-4000-8000-000000000006", nodeSeqs: [2000], foldMarks: [{ at: 1, seqStart: 1, seqEnd: 100, trigger: "archive-offline" }], closeout: { at: 1, source: "archive-offline", foldAttempted: true, folded: 0, eventsSinceLastFold: 2400 } },
    { id: "session-c649dd02-0000-4000-8000-000000000007", nodeSeqs: [900], foldMarks: [], closeout: { at: 1, source: "archive", eventsSinceLastFold: 900 } },
  ]);
  const report = auditHome({ home, minEvents: 40, tailMin: 1000 });
  t.eq(report.scanned, 2, "两个图都要扫到");
  t.eq(report.big.length, 1, "只有归档时 ≥1000 的那个进榜（900 的不许进）");
  t.eq(report.big[0].tailArchive, 2400, "归档时的尾巴用快照");
  t.eq(report.big[0].due, true, "现算它仍然欠（尾巴 1900 ≥ 40）");
  const stats = summarizeRows(report.big, { minEvents: 40 });
  t.eq(stats.dueNow, 1, "分类统计说 1 个能补");
  t.eq(stats.cannot.total, 0, "没有补不了的");
};
