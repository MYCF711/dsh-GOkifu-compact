/**
 * ui-heartbeat.test.mjs —— 路由心跳读侧的 **pid 存活校验**（T5，2026-11-05）
 *
 * 真机事故（2026-11-05 01:45 实测）：`<home>/chess-context/ui-route.json` 写着
 * `{"state":"closed","pid":22508,"port":64535,...}`，而 **pid 22508 早已退出**、64535 无监听；
 * 真正活着的 DSH 是另一个 pid、面板在别的端口。所有「只读心跳、把 state 当结论」的工具
 * （doctor / accept-after-restart / panel-probe）于是**把活着判成了死了**。
 *
 * 根因：心跳是**某个进程**留下的遗嘱，旧读法不验「写遗嘱的人还在不在」，就等于拿上一位
 * 租客的留言当现任的现状。本文件把三种形状钉死：
 *   ① pid 存活 + `state:"closed"` ⇒ 不 stale、判「面板未在服务」（**正常关闭照旧**）；
 *   ② pid 已退出                  ⇒ `stale:true`，调用方拿到 **「无法判断」**（不是「不可用」）；
 *   ③ 文件不存在 / 损坏           ⇒ 不抛，返回明确的缺失态。
 *
 * 「失败分支必须真红」怎么保证：本文件内联了一份**旧判据**（`legacyHeartbeatVerdict`，
 * C332 原样、**故意不查 pid**），在同一个死 pid 夹具上断言它会得出 `not-serving` ——
 * 于是「新判据必须 stale/unknown」这条一旦退化成旧行为，对照断言立刻分道扬镳（`t.ne`）。
 * 共享源码一个字都没为测试改过。
 *
 * 夹具全部建在 `os.tmpdir()` 下，每条用例 finally 清理；不启动 DSH、不碰真实 `ui-route.json`。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { judgeRouteHeartbeat, pidAlive, readRouteHeartbeat, routeHeartbeatFile } from "../src/ui.mjs";

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

/** 建一个临时 home（**不是**真实 DSH home）。 */
function mkHome(label) {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `gokifu-hb-${label}-`));
}

/** 往临时 home 里写心跳（字符串原样写，用于造「半截 JSON」）。 */
function writeHeartbeat(home, payload) {
  const file = routeHeartbeatFile(home);
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return file;
}

/**
 * 拿一个**确定已经退出**的 pid：起一个立刻退出的子进程，`spawnSync` 返回时它已被回收。
 * 万一 pid 被复用（极小概率）就再起一个 —— 夹具的前提必须是真的，不能靠猜。
 */
function deadPid() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
    const pid = Number(r?.pid);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid) === false) return pid;
  }
  throw new Error("拿不到一个确定已退出的 pid —— 夹具环境有问题（探活语义变了？）");
}

/**
 * ⚠ **旧判据**（C332 原样，故意**不查 pid**）：存在就 parse，`state` 就是结论。
 * 它只活在测试文件里（共享源码没为它改过一行），作用是把 bug 钉成可执行的事实：
 * 死 pid 的心跳在旧实现里 `stale` 永远是 false、`state:"closed"` 永远被判成「面板不可用」。
 */
function legacyHeartbeatVerdict(file) {
  if (!nodeFs.existsSync(file)) return { present: false, state: null, stale: false, verdict: "missing" };
  let hb = null;
  try {
    hb = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    hb = null;
  }
  if (hb === null || typeof hb !== "object") return { present: false, state: null, stale: false, verdict: "missing" };
  return {
    present: true,
    state: hb.state ?? null,
    stale: false, // ← 旧实现**没有**这一位：只要文件在，心跳就算有效
    verdict: hb.state === "open" ? "serving" : "not-serving",
  };
}

/* ───────────────────────── 用例 ───────────────────────── */

tests["T5-1 pid 存活 + state=closed ⇒ 不 stale、判「面板未在服务」（正常关闭照旧）"] = (t) => {
  const home = mkHome("alive-closed");
  try {
    const file = writeHeartbeat(home, {
      state: "closed",
      at: Date.now() - 60_000,
      pid: process.pid, // 自己一定活着
      port: 64535,
      hasWebServer: true,
      version: "1.17.6",
      buildId: "abc123",
    });

    const hb = readRouteHeartbeat(home);
    t.eq(hb.file, file, "结论必须带出读的是哪个文件（排障第一眼）");
    t.eq(hb.present, true, "文件在 ⇒ present");
    t.eq(hb.state, "closed", "state 原样带出");
    t.eq(hb.pid, process.pid, "pid 原样带出");
    t.eq(hb.alive, true, "自己的 pid 一定探得到");
    t.eq(hb.stale, false, "进程活着 ⇒ 心跳不 stale");
    t.eq(hb.serving, false, "state=closed ⇒ 不在服务");
    t.eq(hb.verdict, "not-serving", "调用方必须能直接下结论：面板未在服务");
    t.includes(hb.text, "面板未在服务", "文案要能直接贴进 doctor");
    t.notIncludes(hb.text, "无法判断", "进程活着时不该说「无法判断」—— 那样等于把正常关闭也弄瞎");

    // 回归保护：这一条是「修复不能把正常关闭也改掉」—— 新旧判据必须**一致**。
    const legacy = legacyHeartbeatVerdict(file);
    t.eq(legacy.verdict, hb.verdict, "pid 存活时的正常关闭：新旧判据必须给出同一个结论");
    t.eq(legacy.stale, hb.stale, "pid 存活时新旧都不该 stale");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["T5-2 pid 已退出 ⇒ stale:true 且调用方拿到「无法判断」（旧判据会把死心跳当有效 —— 内联对照）"] = (t) => {
  const home = mkHome("dead-pid");
  try {
    const dead = deadPid();
    const file = writeHeartbeat(home, {
      state: "closed",
      at: Date.now() - 3_600_000,
      pid: dead,
      port: 64535,
      hasWebServer: true,
      version: "1.17.6",
      buildId: "deadbeef",
    });
    t.eq(pidAlive(dead), false, `夹具前提：pid ${dead} 必须已经不存在`);

    // ① 旧判据（内联，未改共享源码）：死 pid 的心跳照样「有效」⇒ 照样断言面板不可用。
    const legacy = legacyHeartbeatVerdict(file);
    t.eq(legacy.present, true, "旧判据只要文件在就算有效（这就是 bug 的形状）");
    t.eq(legacy.stale, false, "旧判据没有 stale 位 ⇒ 死 pid 的心跳被当成了有效心跳");
    t.eq(legacy.verdict, "not-serving", "旧判据据这条遗嘱断言「面板不可用」—— 真机就是这么误判的");

    // ② 新判据：同一个文件必须判 stale，且**不下**「不可用」的结论。
    const hb = readRouteHeartbeat(home);
    t.eq(hb.present, true, "文件在 ⇒ present（不是因为「没有心跳」才 unknown）");
    t.eq(hb.alive, false, "记录的 pid 已退出 ⇒ alive:false");
    t.eq(hb.stale, true, "★ 死 pid 的心跳必须标 stale:true");
    t.eq(hb.serving, false, "死的 pid 不可能在服务");
    t.eq(hb.verdict, "unknown", "★ 调用方拿到的是「无法判断」，不是「不可用」");
    t.includes(hb.text, "无法判断", "文案必须说清是「判断不了」");
    t.notIncludes(hb.text, "不可用", "绝不许据遗留心跳断言面板不可用");
    t.includes(hb.text, String(dead), "要点名是哪个 pid 的遗嘱（排障靠它）");

    // ③ 「失败分支真红」：新旧判据在同一个文件上必须**分道扬镳**。
    //    新实现一旦退化成「不查 pid」，这条立刻失败。
    t.ne(hb.verdict, legacy.verdict, "死 pid 上新旧判据必须给出不同结论（否则说明修复没生效）");
    t.ne(hb.stale, legacy.stale, "stale 位是这次修复的核心，死 pid 上新旧必须不同");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["T5-3 心跳文件不存在 / 损坏 ⇒ 不抛，返回明确的缺失态"] = (t) => {
  const home = mkHome("missing");
  try {
    // ① 文件不存在
    const missing = readRouteHeartbeat(home);
    t.eq(missing.present, false, "没有文件 ⇒ present:false");
    t.eq(missing.state, "missing", "缺失态必须点名");
    t.eq(missing.verdict, "missing", "判定：缺失（既不 serving 也不 unknown）");
    t.eq(missing.stale, false, "没有心跳谈不上 stale");
    t.eq(missing.alive, null, "没有 pid ⇒ 无法判断存活");
    t.eq(missing.serving, false, "缺失时不许说在服务");
    t.eq(missing.heartbeat, null, "没有解析结果");
    t.includes(missing.text, "没有可用心跳", "文案要说明是「没有心跳」而不是「面板坏了」");

    // ② 半截 JSON（写到一半被截断 —— 真机上崩溃就是这样）
    writeHeartbeat(home, '{"state":"open","pid":');
    const corrupt = readRouteHeartbeat(home);
    t.eq(corrupt.present, false, "解析失败 ⇒ present:false");
    t.eq(corrupt.state, "corrupt", "损坏要单独点名");
    t.eq(corrupt.verdict, "missing", "损坏按缺失处理");
    t.eq(corrupt.serving, false, "损坏时不许说在服务");
    t.eq(typeof corrupt.error, "string", "要带出解析错误摘要（给人看）");
    t.includes(corrupt.text, "不是合法 JSON", "文案要能一眼看出是文件坏了");

    // ③ 合法 JSON 但不是对象
    writeHeartbeat(home, "null");
    t.eq(readRouteHeartbeat(home).state, "corrupt", "null 不是心跳对象");
    writeHeartbeat(home, "[1,2]");
    t.eq(readRouteHeartbeat(home).state, "corrupt", "数组不是心跳对象");

    // ④ home 目录整棵不存在
    const ghost = nodePath.join(mkHome("ghost"), "nope", "deeper");
    t.eq(readRouteHeartbeat(ghost).verdict, "missing", "home 不存在也只是缺失，不抛");

    // ⑤ 目录当成文件读（EISDIR/读不到）也必须落在缺失态
    const dirHome = mkHome("isdir");
    nodeFs.mkdirSync(routeHeartbeatFile(dirHome), { recursive: true });
    t.eq(readRouteHeartbeat(dirHome).present, false, "读不了（是目录）⇒ present:false，不抛");
    nodeFs.rmSync(dirHome, { recursive: true, force: true });
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["T5-4 state=open 但 pid 已退出 / 没有 pid ⇒ 都不许说「面板在服务」"] = (t) => {
  const home = mkHome("open-dead");
  try {
    const dead = deadPid();
    writeHeartbeat(home, { state: "open", at: Date.now() - 600_000, pid: dead, port: 64535, hasWebServer: true });

    // ① open + 死 pid：这是一个**过期**的「在服务」宣告，同样不能当真
    const staleOpen = readRouteHeartbeat(home);
    t.eq(staleOpen.serving, false, "死的 pid 不可能在服务（open 也不能信）");
    t.eq(staleOpen.stale, true, "open 也应该标 stale");
    t.eq(staleOpen.verdict, "unknown", "过期 open ⇒ 无法判断");

    // ② 老格式心跳没有 pid：无法验证 ⇒ 不许下「在服务」的结论
    writeHeartbeat(home, { state: "open", at: Date.now(), port: 64535 });
    const noPid = readRouteHeartbeat(home);
    t.eq(noPid.alive, null, "没有 pid ⇒ alive:null（无法判断）");
    t.eq(noPid.stale, false, "没有 pid 不等于 stale（不冤枉它）");
    t.eq(noPid.serving, false, "没有 pid 不许说在服务");
    t.eq(noPid.verdict, "unknown", "没有 pid ⇒ 无法判断");

    // ③ 纯判定函数：活 pid + open 才是唯一的 serving
    const live = judgeRouteHeartbeat({ state: "open", at: Date.now(), pid: process.pid, port: 64535 });
    t.eq(live.serving, true, "活 pid + open 才判在服务");
    t.eq(live.verdict, "serving", "结论词是 serving");
    t.includes(live.text, String(process.pid), "文案带出 pid");
    t.eq(judgeRouteHeartbeat({ state: "failed", at: Date.now(), pid: process.pid, error: "register threw" }).verdict, "not-serving", "failed + 活 pid ⇒ 面板未在服务");
    t.eq(judgeRouteHeartbeat(null).verdict, "unknown", "null 心跳不许抛");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["T5-5 pidAlive：活着的 true、死的 false、坏值 null（只探测不发信号）"] = (t) => {
  t.eq(pidAlive(process.pid), true, "自己一定活着");
  t.eq(pidAlive(deadPid()), false, "已退出的 pid 判 false");
  t.eq(pidAlive(0), null, "0 不是合法 pid（且绝不能真去 kill 进程组）");
  t.eq(pidAlive(-1), null, "负数不是合法 pid");
  t.eq(pidAlive(Number.NaN), null, "NaN 不是合法 pid");
  t.eq(pidAlive(1.5), null, "非整数不是合法 pid");
  t.eq(pidAlive(null), null, "null 不是合法 pid");
  t.eq(pidAlive(undefined), null, "undefined 不是合法 pid");
  t.eq(pidAlive("abc"), null, "字符串不是合法 pid");
  t.eq(pidAlive(String(process.pid)), true, "十进制字符串可以接受（心跳文件里可能写成字符串）");
};
