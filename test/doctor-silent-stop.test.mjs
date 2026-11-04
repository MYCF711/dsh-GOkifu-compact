/**
 * doctor-silent-stop.test.mjs —— 「自动补账静默停摆」必须是一条可断言的健康项（2026-11-05，C599）
 *
 * 由来（真机 2026-11-05 00:03 的 `auto-backfill-state.json`）：
 *   `{ due: 217, max: 5, doneMs: 13775, results: [5 条 stopped:"error", folded:0] }`
 * —— 每轮都"跑完了"，却一个会话都没补成；而 doctor 里它与健康状态**长得一模一样**。
 * 同一天还有另外两个同族 bug（补账不跑、探测器恒假），共同点是：出问题时磁盘上看不出来。
 *
 * 三条判据各自钉住一种静默：
 *   ① 跑完了但全是 stopped≠done（最像健康的一种停摆）⇒ `!`，并写清原因；
 *   ② 状态文件超过 90 分钟没更新而 `due>0` ⇒ 定时器可能停了；
 *   ③ `due>0` 而状态文件不存在 ⇒ 本版可能还没重启（引擎不会写这个文件）。
 *
 * 全部走 `node scripts/doctor.mjs --json`（真实子进程 + 临时 home），只读，不碰 DSH_HOME。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNodeId, addEdge, addAgentNode, settleEdge, toJSON } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

const MIN = 60 * 1000;

/**
 * 造最小 home。
 * @param {{state?: object|null, seq?: number, patchText?: string|null}} [options] `state` 为要写的 auto-backfill-state.json（null = 不写）；
 *   `seq` = 图上最大事件序号（决定 `debtOfGraph` 现算的欠账）；`patchText` = 要写的 profile patch
 */
function makeHome({ state = null, seq = 4, patchText = null } = {}) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-silent-"));
  const dir = nodePath.join(root, "chess-context", "sessions", "session-silent-stop");
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = createGraph({ sessionId: "session-silent-stop" });
  const u = addUserNodeId(g, { seq: 1, text: "把测试跑绿" });
  const e = addEdge(g, { from: u, intent: "跑测试", action: "bash(npm test)", evidence: { start: 2, end: 3 } });
  const n = addAgentNode(g, { seq, goal: "跑测试", worldHash: "W1", constraintHash: "C1", via: e }).id;
  settleEdge(g, e, { to: n, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
  if (state !== null) {
    nodeFs.writeFileSync(nodePath.join(root, "chess-context", "auto-backfill-state.json"), JSON.stringify(state, null, 2), "utf8");
  }
  if (patchText !== null) {
    const profileDir = nodePath.join(root, "profiles", "desktop");
    nodeFs.mkdirSync(profileDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(profileDir, "cordis.patch.yml"), patchText, "utf8");
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
    });
  } catch (error) {
    out = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const payload = JSON.parse(out);
  return { checks: payload.checks, find: (prefix) => payload.checks.find((c) => String(c.name).startsWith(prefix)) };
}

tests["C599 ① 跑完一轮但结局全是 stopped≠done ⇒ 必须 `!` 警告，并写清原因（真机形状）"] = (t) => {
  // 真机 2026-11-05 00:03 的原样：doneMs 有值、due 很大、5 个会话全是 error
  const home = makeHome({
    state: {
      at: Date.now() - 2 * MIN,
      due: 217,
      max: 5,
      picked: ["session-a", "session-b", "session-c", "session-d", "session-e"],
      results: ["session-a", "session-b", "session-c", "session-d", "session-e"].map((id) => ({
        id,
        marks: 0,
        folded: 0,
        stopped: "error",
        partial: true,
        error: 'Error: cannot get required service "llm" in inactive context',
      })),
      doneMs: 13775,
    },
  });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(!!row, true, "必须新增「自动补账结局」这一条检查");
    t.eq(row.status, "warn", `全 stopped=error 必须 warn（这就是静默停摆）：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "没有一个 done", "要明说「一个 done 都没有」");
    t.includes(String(row.detail), "5 个结局全是 error", "要数出结局条数与 stopped 取值");
    t.includes(String(row.detail), "cannot get required service", "要带出真实错误（否则只能靠猜）");
    t.includes(String(row.detail), "空转", "要给出结论：补账在空转");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C599 ② 状态文件超过 90 分钟没更新且 due>0 ⇒ 必须 `!` 警告「自动补账可能停了」"] = (t) => {
  // 默认 30 分钟一轮 ⇒ 90 分钟没动就是三轮没跑（定时器被卸载 / 进程卡住）
  const home = makeHome({
    state: {
      at: Date.now() - 3 * 60 * MIN,
      due: 42,
      max: 5,
      picked: ["session-a"],
      results: [{ id: "session-a", marks: 2, folded: 2, stopped: "done", partial: false, error: null }],
      doneMs: 9000,
    },
  });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(!!row, true, "必须有这一条检查");
    t.eq(row.status, "warn", `90 分钟没更新而欠账 42 个必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "自动补账可能停了", "要直接说出结论");
    t.includes(String(row.detail), "180 分钟没更新", "要报出到底多久没更新");
    t.includes(String(row.detail), "42", "要带出欠账数（决定这条严不严重）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C599 ③ due>0 而状态文件不存在 ⇒ 提示「还没跑过（本版可能需要重启）」"] = (t) => {
  // 夹具图的尾巴 200 事件 ≥ closeoutMinEvents(40) ⇒ debtOfGraph 现算 due>0
  const home = makeHome({ state: null, seq: 200 });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(!!row, true, "没有状态文件时这条检查也不许消失（消失 = 静默）");
    t.eq(row.status, "warn", `有欠账却从没跑过必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "还没有跑过", "要写「还没跑过」");
    t.includes(String(row.detail), "重启", "要指出「本版可能需要重启」这个可执行动作");
    t.includes(String(row.detail), "auto-backfill-state.json", "要点名缺的是哪个文件");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C599 ④ 反向：健康的一轮必须 ok（检测器不许恒假 —— 恒 warn 与恒 ok 一样没用）"] = (t) => {
  const home = makeHome({
    state: {
      at: Date.now() - 3 * MIN,
      due: 2,
      max: 5,
      picked: ["session-a", "session-b"],
      results: [
        { id: "session-a", marks: 3, folded: 3, stopped: "done", partial: false, error: null },
        { id: "session-b", marks: 1, folded: 1, stopped: "done", partial: true, error: null },
      ],
      doneMs: 61000,
    },
  });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(row.status, "ok", `补进了东西就必须 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "2/2 个 done", "要报出 done 比例");
    t.includes(String(row.detail), "折了 4 段", "要报出本轮真实产出");
    t.includes(String(row.detail), "欠账 2 个", "要带出剩余欠账");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C599 ⑤ 没有欠账时「还没跑过」不算故障（不许把全新安装报成红灯）"] = (t) => {
  // 空图（没有节点、没有 foldMark）⇒ 现算 due = 0
  const home = makeHome({ state: null, seq: 1 });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(row.status, "ok", `没有欠账时必须是 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "没有欠账可补", "要说明为什么不算故障");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C599 ⑥ 「已布防但还没跑第一轮」要按首轮延迟判：没到点 ok，超时了才 warn"] = (t) => {
  // 引擎启动时就落 `{armed:true, everyMs, firstDelayMs}`（C593）—— 这个形状没有 results/due，
  // 若也按「全是 stopped≠done」判就会把每次刚重启都报成红灯。
  const armed = (ageMin) => ({ at: Date.now() - ageMin * MIN, armed: true, everyMs: 30 * MIN, firstDelayMs: 2 * MIN, pid: 4242 });

  const fresh = makeHome({ state: armed(1) });
  try {
    const row = runDoctor(fresh).find("自动补账结局");
    t.eq(row.status, "ok", `刚布防 1 分钟（首轮 +2 分钟）应是 ok：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "还没跑过第一轮", "要明说还没跑第一轮");
    t.includes(String(row.detail), "还没到点", "要说明为什么不算故障");
  } finally {
    nodeFs.rmSync(fresh, { recursive: true, force: true });
  }

  // 布防 40 分钟 > 首轮 2 分钟 + 一轮 30 分钟 ⇒ 定时器根本没跑起来
  const stale = makeHome({ state: armed(40) });
  try {
    const row = runDoctor(stale).find("自动补账结局");
    t.eq(row.status, "warn", `超过「首轮 + 一轮」仍一轮未跑必须 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "定时器没跑起来", "要给出结论");
  } finally {
    nodeFs.rmSync(stale, { recursive: true, force: true });
  }
};

tests["C599 ⑦ 开关是关的 ⇒ 状态文件停更属正常（否则「我自己关的」会永远变红）"] = (t) => {
  // 引擎每轮开头就 `return`，所以关掉之后状态文件冻结 —— 这条若不排除，
  // 每次手动关掉自动补账的人都会看到一条永久的假警告（探测器自己恒假）。
  const home = makeHome({
    state: { at: Date.now() - 5 * 60 * MIN, due: 88, max: 5, picked: ["session-a"], results: [], doneMs: 1200 },
    patchText: "- insert:\n    - id: gokifu-compact\n      config:\n        autoBackfill: false\n",
  });
  try {
    const row = runDoctor(home).find("自动补账结局");
    t.eq(!!row, true, "关掉开关时这条检查也不许消失（消失 = 静默）");
    t.eq(row.status, "ok", `开关关掉时停更不许判 warn：${JSON.stringify(row)}`);
    t.includes(String(row.detail), "已在设置里关闭", "要说明为什么停更正常");
    t.includes(String(row.detail), "88", "仍然要报出欠账数（关掉不等于没有欠账）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
