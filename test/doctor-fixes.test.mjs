/**
 * doctor-fixes.test.mjs —— C604：把「探测器自己恒红」的四条判据改对（2026-11-05）
 *
 * 由来：`node scripts/doctor.mjs` 在真机上长期停在 `0 错 / 11 警`，其中 5 条**永远清不掉** ——
 * 不是系统坏了，是**判据写错了**。共同点是同一个反模式：
 *
 *   把「历史累计发生过几次」当成「现在健康吗」。
 *
 * 历史记录是只读的：一旦写下一条 `context-overflow` / 一条 `liveUnsettled` / 一条没有
 * `usage.model` 的 foldMark，它就**永远在那里**。而 `!` 的语义是「现在需要有人动手」——
 * 一条永远不会因为「动手」而消失的告警，等于一条噪音，它还会把真正的红灯淹掉。
 * 本仓已经修过同族两次（C551「一个离群样本不该驱动调参」、C552「那条旧记录会把这条线
 * 永久打红」），这次把剩下四条一次收掉：
 *
 *   ① `fold 悬空（dangling）`  —— 全历史求和 ⇒ 改成最近 10 次（与同族「fold 边界完整性」对齐）
 *   ② `fold 触发原因`          —— 全历史累计 ⇒ 改成「每个会话最近一次 fold」
 *   ③ `热清单预算（fallback）` —— `over > 0` ⇒ 改成「还有更省的形式没用上」才算问题
 *   ④ `成本用的模型（口径）`   —— 只读 `usage.model` ⇒ 补上 `route.model`（离线补折落在那里）
 *   ⑤ `归档后剩余的未折尾巴`   —— 缺字段时拿「fold 折到哪」当「还剩多少」⇒ 现算真实尾巴
 *
 * ★ 硬要求：每条用例都**内联一份旧判据**并断言它在同一份夹具上是红的。
 *   只证明「新判据绿」是不够的 —— 那可能是夹具本来就没有问题；
 *   必须同时证明「同一份数据，旧代码会说 !」。旧判据写在测试里，不改共享源码。
 *
 * 全部走 `node scripts/doctor.mjs --json`（真实子进程 + 临时 home），只读，不碰 DSH_HOME。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addAgentNode, toJSON } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 造一个最小 DSH home。
 * @param {{session?: string, foldMarks?: object[], closeout?: object|null, nodeSeqs?: number[],
 *          ledgerBudget?: object|null, archived?: boolean}} [options]
 *   `foldMarks` 直接写进 graph.json；`nodeSeqs` 决定图上最大事件序号（尾巴现算要用）；
 *   `ledgerBudget` 非 null 时写 `<home>/chess-context/ledger-budget.json`；
 *   `archived` 为真时把会话登记进 `storages/workspace.json` 的 archivedSessionIds。
 */
function makeHome({ session = "session-c604-fixture", foldMarks = [], closeout = null, nodeSeqs = [], ledgerBudget = null, archived = false } = {}) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-c604-"));
  const dir = nodePath.join(root, "chess-context", "sessions", session);
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = createGraph({ sessionId: session });
  const user = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
  for (const seq of nodeSeqs) addAgentNode(g, { seq, goal: "跑测试", worldHash: "W1", constraintHash: "C1" });
  g.rootUserNodeIds = [user];
  g.foldMarks = foldMarks;
  if (closeout !== null) g.closeout = closeout;
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
  if (ledgerBudget !== null) {
    nodeFs.writeFileSync(nodePath.join(root, "chess-context", "ledger-budget.json"), JSON.stringify(ledgerBudget, null, 1), "utf8");
  }
  if (archived) {
    const storages = nodePath.join(root, "storages");
    nodeFs.mkdirSync(storages, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(storages, "workspace.json"),
      JSON.stringify({ global: { archivedSessionIds: [session] } }, null, 1),
      "utf8",
    );
  }
  return root;
}

/** 跑 doctor --json（有 error 级检查时退出码非 0，但 stdout 仍是完整 JSON）。 */
function runDoctor(home) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "doctor.mjs"), "--json"], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (error) {
    out = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const payload = JSON.parse(out);
  return { checks: payload.checks, find: (prefix) => payload.checks.find((c) => String(c.name).startsWith(prefix)) };
}

/** 一条 foldMark 的最小形状（`dangling` / `trigger` / `route` 按需覆盖）。 */
const mark = (at, extra = {}) => ({ at, seqStart: 1, seqEnd: 2, shadowedTokens: 100, ...extra });

const MIN = 60 * 1000;
const T0 = Date.now() - 24 * 60 * MIN;

/* ───────────────────── ① fold 悬空（dangling） ───────────────────── */

/** 旧判据（C604 之前）：**全历史**求和。 */
const OLD_danglingVerdict = (marks) => {
  const withD = marks.filter((m) => m?.dangling && typeof m.dangling.liveUnsettled === "number");
  const sum = (k) => withD.reduce((acc, m) => acc + (m.dangling[k] ?? 0), 0);
  return sum("fromBroken") > 0 ? "error" : sum("liveUnsettled") > 0 ? "warn" : "ok";
};

tests["C604 ① fold 悬空：一条 2 天前的 liveUnsettled 不该让这条线永久红（旧判据真红）"] = (t) => {
  // 真机形状（2026-11-05 01:38）：12 次 fold，只有**最早**那次 liveUnsettled=1，
  // 之后 11 次全 0 —— 旧判据求和后恒 > 0，于是「最近 10 次 fold 都切在 step 边界」的
  // 兄弟项是绿的、这一项却永久红。
  const marks = [
    mark(T0, { dangling: { liveUnsettled: 1, fromBroken: 0, residue: 0, candidates: 0 } }),
    ...Array.from({ length: 11 }, (_, i) => mark(T0 + (i + 1) * MIN, { dangling: { liveUnsettled: 0, fromBroken: 0, residue: 0, candidates: 0 } })),
  ];
  t.eq(OLD_danglingVerdict(marks), "warn", "旧判据在这份夹具上必须是红的（否则证明不了修复）");
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("fold 悬空（dangling）");
    t.eq(!!row, true, "必须有「fold 悬空（dangling）」这一行");
    t.eq(row.status, "ok", `最近 10 次都干净 ⇒ 必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "最近 10 次 fold", "要说明判级窗口是最近 10 次");
    t.includes(String(row.detail), "另有 1 条历史悬空", "历史悬空不许被吞掉（只是不再驱动判级）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ① 反向：最近 10 次里真有一条未结算 ⇒ 仍然必须 `!`（修完不许恒绿）"] = (t) => {
  const marks = [
    ...Array.from({ length: 11 }, (_, i) => mark(T0 + i * MIN, { dangling: { liveUnsettled: 0, fromBroken: 0, residue: 0, candidates: 0 } })),
    // 最新那条有 2 条边没结算 = 真的理解成「切在动作中间」
    mark(T0 + 11 * MIN, { dangling: { liveUnsettled: 2, fromBroken: 0, residue: 0, candidates: 0 } }),
  ];
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("fold 悬空（dangling）");
    t.eq(row.status, "warn", `最近一次 fold 有未结算边必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "还有 2 条边未结算", "要数出未结算的边数");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ① fromBroken（图坏了）仍按全历史判 error —— 坏边不会自愈，窗口不能掩盖它"] = (t) => {
  const marks = [
    // 很早以前的坏边
    mark(T0, { dangling: { liveUnsettled: 0, fromBroken: 3, residue: 0, candidates: 0 } }),
    ...Array.from({ length: 11 }, (_, i) => mark(T0 + (i + 1) * MIN, { dangling: { liveUnsettled: 0, fromBroken: 0, residue: 0, candidates: 0 } })),
  ];
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("fold 悬空（dangling）");
    t.eq(row.status, "error", `fromBroken>0 必须 error（与窗口无关）：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "migrate-dangling", "要给出能执行的命令（C276）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ───────────────────── ② fold 触发原因 ───────────────────── */

/** 旧判据（C604 之前）：**全历史**累计里有 context-overflow 就红。 */
const OLD_triggerVerdict = (marks) => {
  const withTrigger = marks.filter((m) => typeof m?.trigger === "string" && typeof m.at === "number");
  const overflow = withTrigger.filter((m) => m.trigger === "context-overflow").length;
  return overflow > 0 ? "warn" : "ok";
};

tests["C604 ② fold 触发原因：2 天前自救过一次、之后又正常 fold ⇒ 结论已不成立（旧判据真红）"] = (t) => {
  // 真机形状：<SESSION_ID> 在 11-04T01:36 溢出自救一次，之后又 fold 了 18 次（最近 archive-offline）；
  // <SESSION_ID> 11-03T06:19 自救一次，之后最近一次是 pressure。旧判据只看累计次数 ⇒ 永久红。
  const marks = [
    mark(T0, { trigger: "context-overflow" }),
    ...Array.from({ length: 5 }, (_, i) => mark(T0 + (i + 1) * MIN, { trigger: "pressure" })),
    mark(T0 + 10 * MIN, { trigger: "archive-offline" }),
  ];
  t.eq(OLD_triggerVerdict(marks), "warn", "旧判据在这份夹具上必须是红的（否则证明不了修复）");
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("fold 触发原因");
    t.eq(row.status, "ok", `该会话最近一次 fold 是 archive-offline ⇒ 必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "历史累计 1 次溢出自救", "历史累计仍要报出来（不隐藏）");
    t.includes(String(row.detail), "已恢复", "要说明为什么它不再驱动判级");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ② 反向：会话**最近一次** fold 就是 context-overflow ⇒ 仍然必须 `!`（修完不许恒绿）"] = (t) => {
  const marks = [mark(T0, { trigger: "pressure" }), mark(T0 + MIN, { trigger: "context-overflow" })];
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("fold 触发原因");
    t.eq(row.status, "warn", `自救之后没恢复必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "被迫自救", "要说明 overflow 的含义（C12）");
    t.includes(String(row.detail), "压缩没跟上增长", "要给出结论");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ───────────────── ③ 热清单预算（fallback）：设计内 vs 可行动 ───────────────── */

/** 旧判据（C604 之前）：只要 over-budget 出现过就红。 */
const OLD_budgetVerdict = (stats) =>
  Number(stats.impossible ?? 0) > 0
    ? "error"
    : Number(stats["over-budget"] ?? 0) > 0 || Number(stats.provenanceLow ?? 0) > 0 || stats.provenanceMin === undefined
      ? "warn"
      : "ok";

const budgetFixture = (over) => ({
  none: 121,
  "over-budget": 16,
  impossible: 0,
  maxOverBudgetBy: 221,
  provenanceMin: 1,
  provenanceLow: 0,
  samples: 137,
  minimalRenders: 62,
  traceDropped: 2,
  budgetIrreducible: 1,
  overByLevel: { L5: 15, L3: 1 },
  overByCause: { content: 15, constraints: 1 },
  skipReasons: { identical: 1426, "throttled-events": 130, "throttled-failures": 3137, "no-ledger": 64 },
  updatedAt: Date.now(),
  ...over,
});

tests["C604 ③ 热清单预算：16 次 over-budget 全在「已是最省 / 已列全失败边」⇒ 设计内，不该红（旧判据真红）"] = (t) => {
  // 真机形状（2026-11-05 01:38）：over-budget=16，L5=15（C244：已是最省一份）、budgetIrreducible=1
  // （C49：已列全失败边，再省只能删失败记忆）⇒ 16/16 都是**设计内**，旧判据却报 !。
  const stats = budgetFixture();
  t.eq(OLD_budgetVerdict(stats), "warn", "旧判据在这份夹具上必须是红的（否则证明不了修复）");
  const home = makeHome({ ledgerBudget: stats });
  try {
    const row = runDoctor(home).find("热清单预算（fallback）");
    t.eq(!!row, true, "必须有「热清单预算（fallback）」这一行");
    t.eq(row.status, "ok", `全部设计内 ⇒ 必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "设计内 16", "要报出设计内的样本数（数字不许被藏起来）");
    t.includes(String(row.detail), "还有更省形式却仍超 0", "要报出「真正该动手」的那部分");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ③ 反向：over-budget 落在低档位（还有更省的形式）⇒ 仍然必须 `!`（修完不许恒绿）"] = (t) => {
  const stats = { ...budgetFixture(), "over-budget": 8, overByLevel: { L2: 8 }, budgetIrreducible: 0, overByCause: { content: 8 } };
  const home = makeHome({ ledgerBudget: stats });
  try {
    const row = runDoctor(home).find("热清单预算（fallback）");
    t.eq(row.status, "warn", `L2 档 = 明明还能更省却仍超预算 ⇒ 必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "还有更省形式却仍超 8", "要数出可行动的那部分");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ③ impossible>0 仍是 error（无解是 bug，不是设计内）"] = (t) => {
  const stats = { ...budgetFixture(), impossible: 2 };
  const home = makeHome({ ledgerBudget: stats });
  try {
    const row = runDoctor(home).find("热清单预算（fallback）");
    t.eq(row.status, "error", `impossible>0 必须 error：${JSON.stringify(row)}`);
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ───────────────── ④ 成本用的模型（口径）：route.model 也是模型名 ───────────────── */

/** 旧判据（C604 之前）：只看 `usage.model`。 */
const OLD_modelVerdict = (marks) => {
  const withUsage = marks.filter((m) => m?.usage && typeof m.usage === "object");
  const missing = withUsage.filter((m) => !(typeof m.usage.model === "string" && m.usage.model !== "")).length;
  return missing > 0 ? "warn" : "ok";
};

tests["C604 ④ 成本口径：离线补折把模型名写在 route.model 上，旧判据看不见（旧判据真红）"] = (t) => {
  // 真机形状：180 条「没有 model」的 fold **全部**都有 route.model（archive-offline 走的是这条路）。
  // 旧判据断言「按 flash 估价、跑 pro 是下限」—— 而磁盘上明明记着 magpie/group/kimi-k3.1-pro。
  const marks = [
    // 在线路径：写 usage.model
    mark(T0, { trigger: "pressure", usage: { inputTokens: 1000, outputTokens: 10, model: "group/deepseek-v4.1-flash1017" } }),
    // 离线补折路径：只有 route.model（真机原样）
    mark(T0 + MIN, { trigger: "archive-offline", route: { provider: "magpie", model: "magpie/group/kimi-k3.1-pro" }, usage: { inputTokens: 14019, outputTokens: 6394 } }),
  ];
  t.eq(OLD_modelVerdict(marks), "warn", "旧判据在这份夹具上必须是红的（否则证明不了修复）");
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("成本用的模型（口径）");
    t.eq(!!row, true, "必须有「成本用的模型（口径）」这一行");
    t.eq(row.status, "ok", `两条都能定出模型名 ⇒ 必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "v4-pro=1", "离线那条要按 pro 计价（不是按下限）");
    t.includes(String(row.detail), "flash=1", "在线那条仍按 flash");
    t.includes(String(row.detail), "取自 `route.model`", "要说明模型名是从哪个字段恢复的");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ④ 反向：usage 与 route 都没有模型名 ⇒ 仍然必须 `!` 并说明按下限算（修完不许恒绿）"] = (t) => {
  const marks = [mark(T0, { trigger: "pressure", usage: { inputTokens: 1000, outputTokens: 10 } })];
  const home = makeHome({ foldMarks: marks });
  try {
    const row = runDoctor(home).find("成本用的模型（口径）");
    t.eq(row.status, "warn", `两处都没有模型名必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "1 条没有 model", "要数出真的没有模型名的条数");
    t.includes(String(row.detail), "下限", "要说明这时的成本是下限（C347）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ───────────────── ⑤ 归档后剩余的未折尾巴：缺字段时不许编造 ───────────────── */

tests["C604 ⑤ 未折尾巴：closeout 缺 eventsSinceLastFold 时不许拿「fold 折到哪」当尾巴（旧判据真红）"] = (t) => {
  // 真机形状（<SESSION_ID>）：closeout 没有 eventsSinceLastFold，
  // lastEnd=3002（-fold 折到的**位置**），而图上最大事件序号只有 1761 ⇒ 真实尾巴是 0。
  // 旧代码 `eventsSinceLastFold ?? Math.max(0, lastEnd)` 把位置当差值 ⇒ 凭空报「还有 3002 事件未折」。
  const marks = [mark(T0, { trigger: "archive-offline", seqStart: 10, seqEnd: 3002 })];
  const closeout = { at: Date.now() - 1000, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true };
  const OLD_tail = Number(closeout.eventsSinceLastFold ?? Math.max(0, 3002));
  t.eq(OLD_tail, 3002, "旧判据算出的尾巴必须是那个编造值（否则证明不了修复）");
  t.eq(OLD_tail >= 1000, true, "旧判据会把它算进「≥1000 未折」的榜单");
  const home = makeHome({ foldMarks: marks, closeout, nodeSeqs: [1761], archived: true });
  try {
    const row = runDoctor(home).find("归档后剩余的未折尾巴");
    t.eq(!!row, true, "必须有「归档后剩余的未折尾巴」这一行");
    t.eq(row.status, "ok", `真实尾巴是 0（1761-1761）⇒ 必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "没有「归档了但还剩一大截没折」", "要给出结论");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C604 ⑤ 反向：缺字段但真实尾巴很大 ⇒ 仍然必须 `!` 并报出真实数字（修完不许恒绿）"] = (t) => {
  const marks = [mark(T0, { trigger: "archive-offline", seqStart: 10, seqEnd: 3002 })];
  const closeout = { at: Date.now() - 1000, source: "archive-offline", foldAttempted: true, folded: 1, foldOffline: true };
  const home = makeHome({ foldMarks: marks, closeout, nodeSeqs: [5000], archived: true });
  try {
    const row = runDoctor(home).find("归档后剩余的未折尾巴");
    t.eq(row.status, "warn", `真实尾巴 1998 ≥ 1000 必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "1998", "要报出现算出来的真实尾巴（不是编造的 3002）");
    t.eq(String(row.detail).includes("3002"), false, "编造值不许再出现");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
