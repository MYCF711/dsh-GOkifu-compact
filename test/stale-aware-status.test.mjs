/**
 * stale-aware-status.test.mjs —— 心跳过期时，三处消费者不许把死进程的旧值当现状（C604/C606）
 *
 * 真机（2026-11-05 01:45）：`<home>/chess-context/ui-route.json` 写着
 *   `{"state":"closed","pid":22508,"port":64535}`
 * 而 pid 22508 早已退出、64535 无人监听，面板实际在别处。三处消费者都**只看 state / 只 parse**，
 * 从不问「写心跳的进程还在不在」：
 *   · `scripts/doctor.mjs` 的「面板路由心跳」⇒ 直接报「**被卸载**，重启才能恢复」（今晚误判的源头）；
 *   · `scripts/status.mjs` ⇒ 拿死端口当现值；
 *   · `scripts/panel-probe.mjs` ⇒ 拿死端口当「端口来源」。
 *
 * 这里钉四件事（夹具全在 `os.tmpdir()`，不碰真实 `ui-route.json`、不启动/不重启 DSH）：
 *   ① 死 pid 心跳 ⇒ doctor 说「心跳过期 / 答不了」，**不许**说「被卸载 / 重启才能恢复」；
 *   ② 活 pid（`process.pid`）心跳 ⇒ 语义与改造前**完全一致**（closed=被卸载、open=已注册）；
 *   ③ 内联「旧判据」对照 —— 只看 state 的实现会把同一份死心跳读成「被卸载」，新判据必须不同
 *      （这条用例在旧判据下必红：它正是本次要修的坑，不是自证自己）；
 *   ④ status / panel-probe 端到端：前者明说「心跳过期（pid 已退出）」，后者「心跳过期 ⇒ 忽略其端口」。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 一个几乎肯定不存在的 pid（Windows/Linux 都不会把 999999 发给普通进程）。 */
const DEAD_PID = 999999;

export const tests = {};

/** 造一个「只有心跳」的临时 home；`heartbeat` 就是 ui-route.json 的全文。 */
function makeHome(heartbeat) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stale-aware-"));
  const gc = nodePath.join(home, "chess-context");
  nodeFs.mkdirSync(gc, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(gc, "ui-route.json"), JSON.stringify(heartbeat), "utf8");
  return home;
}

/** 跑一次脚本，返回 stdout（doctor 有警告时退出码非 0 —— 但 stdout 仍是完整 JSON）。 */
function runScript(rel, args, home) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [nodePath.join(ROOT, "scripts", rel), ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DSH_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      }),
    };
  } catch (error) {
    return {
      status: typeof error?.status === "number" ? error.status : 1,
      stdout: String(error?.stdout ?? error?.message ?? ""),
    };
  }
}

/** doctor 的「面板路由心跳」那一行（`--json` 的 checks 里按名字取）。 */
function doctorHeartbeatRow(home) {
  const payload = JSON.parse(runScript("doctor.mjs", ["--json"], home).stdout || "{}");
  const row = (payload.checks ?? []).find((c) => String(c?.name ?? "").startsWith("面板路由心跳"));
  return row ?? null;
}

/**
 * **旧判据**（内联复刻改造前 doctor 的那段实现 —— 共享源码一个字都没改）：
 * 它只 `JSON.parse` 然后**只看 `state`**，从不问写心跳的 pid 还在不在。
 * 拿它当对照，才能证明新用例不是"自证自己绿"。
 */
function legacyHeartbeatVerdict(heartbeat) {
  if (heartbeat === null || typeof heartbeat !== "object") return "心跳文件解析失败（内容不是 JSON）";
  if (heartbeat.state === "closed") return "⚠ 面板在 ? **被卸载**（热重载或退出）—— `/gokifu/api` 现在大概率不可达，**重启才能恢复**";
  return "面板路由已注册";
}

tests["SAS-1 死 pid 心跳 ⇒ doctor 说「心跳过期 / 答不了」，不许说「被卸载 / 重启才能恢复」"] = (t) => {
  const home = makeHome({ state: "closed", pid: DEAD_PID, port: 64535, at: Date.now() - 3 * 3_600_000 });
  try {
    const row = doctorHeartbeatRow(home);
    t.eq(!!row, true, "必须有「面板路由心跳」这一行");
    t.eq(row.status, "warn", `过期心跳必须是 warn（不是 error），实际 ${JSON.stringify(row)}`);
    const detail = String(row.detail ?? "");
    t.includes(detail, "心跳过期", "文案必须点明「心跳过期」");
    t.includes(detail, `pid ${DEAD_PID}`, "必须点名是哪个 pid 写的心跳");
    t.includes(detail, "已退出", "必须明说那个进程已退出");
    t.includes(detail, "答不了", "必须明说「面板现在是什么状态，这份文件答不了」");
    t.includes(detail, "不作数", "旧 state/port 必须标明不作数");
    // 真机误判的原文：这两句是**今晚误判**的源头，一个字都不许再出现
    t.notIncludes(detail, "被卸载", "过期心跳不许断言「面板被卸载」（那是死进程写的旧 state）");
    t.notIncludes(detail, "重启才能恢复", "过期心跳不许说「重启才能恢复」—— 重启证明不了面板现状");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["SAS-2 活 pid 心跳 ⇒ 语义与改造前一致（closed=被卸载、open=已注册）"] = async (t) => {
  // ① 活进程写 closed ⇒ 仍然是「被卸载 + 重启才能恢复」（这是活人的结论，不是死进程的旧值）
  const closedHome = makeHome({ state: "closed", pid: process.pid, port: 64535, at: Date.now() - 60_000 });
  try {
    const row = doctorHeartbeatRow(closedHome);
    t.eq(row?.status, "warn", `活 pid + closed 仍应 warn：${JSON.stringify(row)}`);
    t.includes(String(row?.detail ?? ""), "被卸载", "活进程写 closed ⇒ 原有「被卸载」语义不变");
    t.includes(String(row?.detail ?? ""), "重启才能恢复", "活进程写 closed ⇒ 原有「重启才能恢复」必须保留");
    t.notIncludes(String(row?.detail ?? ""), "心跳过期", "活 pid 不许报「心跳过期」");
  } finally {
    nodeFs.rmSync(closedHome, { recursive: true, force: true });
  }

  // ② 活进程写 open + 与磁盘一致的 buildId ⇒ ok「已注册 / 一致」
  const openHome = makeHome({ state: "open", pid: process.pid, port: 64349, hasWebServer: true, buildId: repoBuildId() });
  try {
    const row = doctorHeartbeatRow(openHome);
    t.eq(row?.status, "ok", `活 pid + open 应 ok：${JSON.stringify(row)}`);
    t.includes(String(row?.detail ?? ""), "已注册", "open 说的是「已注册」");
    t.includes(String(row?.detail ?? ""), "一致", "buildId 与磁盘一致要说出来");
  } finally {
    nodeFs.rmSync(openHome, { recursive: true, force: true });
  }
};

tests["SAS-3 旧判据对照：只看 state 会把同一份死心跳读成「被卸载」—— 新判据必须不同"] = (t) => {
  const heartbeat = { state: "closed", pid: DEAD_PID, port: 64535, at: Date.now() - 3 * 3_600_000 };
  const home = makeHome(heartbeat);
  try {
    const legacy = legacyHeartbeatVerdict(heartbeat);
    t.includes(legacy, "被卸载", "旧判据（只看 state）确实会把它读成「被卸载」—— 这就是要修的坑");
    t.includes(legacy, "重启才能恢复", "旧判据确实会说「重启才能恢复」");

    const detail = String(doctorHeartbeatRow(home)?.detail ?? "");
    t.includes(detail, "心跳过期", "新判据说的是「心跳过期」");
    t.eq(
      legacy !== detail && legacy.includes("被卸载") && !detail.includes("被卸载"),
      true,
      `同一份心跳：旧判据「被卸载」/ 新判据「心跳过期」—— 判据必须能区分（legacy=${legacy} / now=${detail}）`,
    );
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["SAS-4 status --fast --no-panel：心跳过期要明说，且死端口不许当现值"] = (t) => {
  const home = makeHome({ state: "closed", pid: DEAD_PID, port: 64535, at: Date.now() - 3 * 3_600_000 });
  try {
    const { stdout } = runScript("status.mjs", ["--fast", "--no-panel"], home);
    const row = stdout.split(/\r?\n/).find((line) => line.includes("面板：")) ?? "";
    t.includes(row, "心跳过期", `status 的面板行必须明说「心跳过期」：${row}`);
    t.includes(row, `pid ${DEAD_PID} 已退出`, "要带出写心跳的 pid 与「已退出」");
    t.includes(row, "port=64535 都不是现值", "死端口必须标明不是现值（不许当现值显示）");
    t.notIncludes(row, "面板不可达", "不许把过期心跳读成「面板不可达」的结论");

    // 源码判据：候选端口只认 fresh 心跳（死 pid 的端口连候选都不进）
    const src = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "status.mjs"), "utf8");
    t.includes(src, 'heartbeat?.state === "fresh"', "端口候选必须以 fresh 心跳为前提（C604）");
    t.includes(src, "readUiRouteHeartbeat", "必须复用 build-stamp 的存活校验读法，不许再自己 JSON.parse");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["SAS-5 panel-probe：跳过过期心跳的端口，并打一行「心跳过期 ⇒ 忽略其端口」"] = (t) => {
  const home = makeHome({ state: "closed", pid: DEAD_PID, port: 64535, at: Date.now() - 3 * 3_600_000 });
  try {
    const { stdout } = runScript("panel-probe.mjs", [], home);
    t.includes(stdout, "心跳过期 ⇒ 忽略其端口", "必须有一行明说「心跳过期 ⇒ 忽略其端口」");
    t.includes(stdout, `pid ${DEAD_PID} 已退出`, "要带出写心跳的 pid");
    const portLine = stdout.split(/\r?\n/).find((line) => line.includes("心跳端口")) ?? "";
    t.includes(portLine, "(无)", `过期心跳的端口不许进候选：${portLine}`);
    t.includes(stdout, "不作「跑的是哪一版」的结论", "构建标识那节也不许把过期心跳的 buildId 当现值");

    const src = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "panel-probe.mjs"), "utf8");
    t.includes(src, "readUiRouteHeartbeat", "必须复用 build-stamp 的存活校验读法");
    t.includes(src, "hb.ok &&", "端口候选必须挂在「心跳新鲜」上（C604）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
