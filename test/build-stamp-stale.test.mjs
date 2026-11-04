/**
 * build-stamp-stale.test.mjs —— 「戳是谁写的、那个人还在不在」（2026-11-05）
 *
 * 由来（真机 2026-11-05 01:45 实测）：`<home>/chess-context/build.json` 里写着
 * `{"buildId":"e880016159fa","pid":22508,...}`，而 **pid 22508 早就退出了**，真正在跑的是
 * 另一个 pid。旧实现只做 `JSON.parse` 就把 stamp 当「运行实例的现状」交给 checkup / doctor /
 * accept-after-restart ⇒ 它们拿死进程的旧值当真，把「旧构建」误判成「功能 bug」，一晚上连错几次。
 *
 * 这里钉住四件事：
 *   ① pid 已退出 ⇒ `stale:true` / `usable:false`，且**不许**把旧 buildId 当现值；
 *   ② 「旧判据」会把这份戳判成新鲜 —— 内联对照（不改共享源码），证明这条守卫不是自证自己；
 *   ③ 只有 pid 还活着时才谈「一致 / 落后」；EPERM（进程存在但没权限发信号）算活；
 *   ④ `ui-route.json` 心跳同构；checkup 端到端时该行是 `warn`、文案含「已退出」、**不**说「需要重启」。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareBuildId,
  processIsAlive,
  readBuildStamp,
  readUiRouteHeartbeat,
  writeBuildStamp,
} from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 一个几乎肯定不存在的 pid（Windows/Linux 都不会把 999999 发给普通进程）。 */
const DEAD_PID = 999999;

export const tests = {};

/** 造一个「死 pid 写过戳」的临时目录。 */
function deadStampDir({ buildId = "e880016159fa", pid = DEAD_PID, startedAt = 1793811430385 } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-stale-"));
  const result = writeBuildStamp({ dir, version: "1.17.1", buildId, pid, now: startedAt });
  if (result.ok !== true) throw new Error(`夹具写戳失败：${JSON.stringify(result)}`);
  return dir;
}

/**
 * **旧判据**（内联复刻，用来当对照 —— 共享源码一个字都没改）：
 * 旧实现 / 旧 checkup 只看「戳里的 buildId 是否等于磁盘」，**从不问写戳的进程还在不在**。
 */
const legacySaysFresh = (stamp, diskBuildId) => stamp !== null && stamp !== undefined && stamp.buildId === diskBuildId;

tests["BSS-1 死 pid 的戳 ⇒ stale:true / usable:false，且旧判据会把它当现值（对照）"] = (t) => {
  const dir = deadStampDir();
  try {
    const reading = readBuildStamp({ dir });
    t.eq(reading.state, "stale", `pid 已退出必须是 stale，实际 ${reading.state}：${reading.reason}`);
    t.eq(reading.stale, true, "stale 标志必须为 true（调用方据此拒绝把旧值当现值）");
    t.eq(reading.usable, false, "不可信时不许 usable —— 否则调用方仍会拿它下结论");
    t.eq(reading.pidAlive, false, "必须报出「那个 pid 不在了」");
    t.eq(reading.pid, DEAD_PID, "必须报出是哪个 pid 写的");
    t.eq(reading.buildId, "e880016159fa", "旧的 buildId 仍要读得出来（供文案引用，但不当现值）");
    t.includes(reading.reason, "已退出", "文案必须明说那个进程已退出");
    t.includes(reading.reason, `pid ${DEAD_PID}`, "文案必须点名 pid");

    // 对照：旧判据（以及共享的 compareBuildId）会把同一份戳判成「一致 / 新鲜」
    const raw = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "build.json"), "utf8"));
    t.eq(legacySaysFresh(raw, "e880016159fa"), true, "旧判据会把它当现值 —— 这正是要修的那个坑");
    t.eq(compareBuildId(raw, "e880016159fa").state, "ok", "compareBuildId 本身不看 pid（它的职责就是纯比对），守卫在 readBuildStamp");
    t.eq(
      legacySaysFresh(raw, "e880016159fa") === true && reading.usable === false,
      true,
      "同一份戳：旧判据说「是现值」、新判据说「不可用」—— 这就是这条用例的区分力",
    );
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["BSS-2 活 pid 的戳 ⇒ fresh / usable:true（用本进程 pid 真探一次）"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-live-"));
  try {
    writeBuildStamp({ dir, version: "1.17.1", buildId: "aaaaaaaaaaaa", pid: process.pid, now: Date.now() });
    const reading = readBuildStamp({ dir });
    t.eq(reading.state, "fresh", `活 pid 必须 fresh，实际 ${reading.state}：${reading.reason}`);
    t.eq(reading.stale, false, "活 pid 不是 stale");
    t.eq(reading.usable, true, "活 pid 才允许拿来判断运行版本");
    t.eq(reading.pidAlive, true, "必须报出 pid 还活着");
    t.eq(reading.buildId, "aaaaaaaaaaaa", "buildId 必须原样读出");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["BSS-3 没有戳 / 坏戳 ⇒ missing / invalid，都不是「现值」"] = (t) => {
  const emptyDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-none-"));
  const badDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-bad-"));
  try {
    const missing = readBuildStamp({ dir: emptyDir });
    t.eq(missing.state, "missing", "没有 build.json ⇒ missing");
    t.eq(missing.usable, false, "缺失不许当现值");

    nodeFs.writeFileSync(nodePath.join(badDir, "build.json"), "{ not json", "utf8");
    const invalid = readBuildStamp({ dir: badDir });
    t.eq(invalid.state, "invalid", "坏 JSON ⇒ invalid（旧实现把「缺失」和「坏了」都归成 null）");
    t.eq(invalid.usable, false, "坏戳不许当现值");

    // pid 字段缺失 ⇒ 不知道就说不知道，不许默认「新鲜」
    const noPidDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-nopid-"));
    try {
      nodeFs.writeFileSync(nodePath.join(noPidDir, "build.json"), JSON.stringify({ buildId: "bbbbbbbbbbbb", version: "1.17.1" }), "utf8");
      const noPid = readBuildStamp({ dir: noPidDir });
      t.eq(noPid.state, "unverifiable", "没有 pid ⇒ 无从校验 ⇒ unverifiable");
      t.eq(noPid.usable, false, "unverifiable 也不许当现值");
    } finally {
      nodeFs.rmSync(noPidDir, { recursive: true, force: true });
    }
  } finally {
    nodeFs.rmSync(emptyDir, { recursive: true, force: true });
    nodeFs.rmSync(badDir, { recursive: true, force: true });
  }
};

tests["BSS-4 processIsAlive：EPERM 算活（Windows pid 4 就是这种），ESRCH 算死，非法 pid 不算活"] = (t) => {
  t.eq(processIsAlive(process.pid), true, "本进程必须判活");
  t.eq(processIsAlive(DEAD_PID), false, `${DEAD_PID} 必须判死`);

  const eperm = Object.assign(new Error("permission denied"), { code: "EPERM" });
  t.eq(
    processIsAlive(1234, {
      kill: () => {
        throw eperm;
      },
    }),
    true,
    "EPERM = 进程存在但没权限发信号 ⇒ 算活（否则 Windows 上 System 进程会被判死）",
  );
  const esrch = Object.assign(new Error("no such process"), { code: "ESRCH" });
  t.eq(
    processIsAlive(1234, {
      kill: () => {
        throw esrch;
      },
    }),
    false,
    "ESRCH = 没有这个进程 ⇒ 死",
  );
  t.eq(processIsAlive(0), false, "pid 0 不是可校验的进程号");
  t.eq(processIsAlive(-5), false, "负数 pid 不算活");
  t.eq(processIsAlive("abc"), false, "非数字 pid 不算活（不许默认成活）");
};

tests["BSS-5 旧签名 readBuildStamp(dir) 仍返回原始 stamp（doctor.mjs / post-restart-check.mjs 依赖它）"] = (t) => {
  const dir = deadStampDir({ buildId: "cccccccccccc" });
  try {
    const raw = readBuildStamp(dir);
    t.eq(raw !== null && typeof raw === "object", true, "旧签名必须继续返回对象（不能因为新增判定就改成返回状态壳）");
    t.eq(raw.buildId, "cccccccccccc", "旧签名返回的仍是原始 buildId");
    t.eq(raw.pid, DEAD_PID, "旧签名不替调用方判断存活（它只读文件）");
    t.eq(readBuildStamp(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "stamp-empty-"))), null, "没有文件时旧签名仍返回 null");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["BSS-6 ui-route 心跳：死 pid ⇒ stale，端口/state 只算旧值"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "route-stale-"));
  try {
    nodeFs.writeFileSync(
      nodePath.join(dir, "ui-route.json"),
      JSON.stringify({ state: "closed", pid: DEAD_PID, port: 64535, at: Date.now() - 3 * 3_600_000 }),
      "utf8",
    );
    const hb = readUiRouteHeartbeat({ dir });
    t.eq(hb.state, "stale", `心跳 pid 已退出必须是 stale，实际 ${hb.state}`);
    t.eq(hb.stale, true, "stale 标志必须为 true");
    t.eq(hb.usable, false, "过期心跳不许用来断言面板状态");
    t.eq(hb.pid, DEAD_PID, "要报出心跳里的 pid");
    t.eq(hb.port, 64535, "旧端口仍可读出（供文案说明「这是旧值」）");
    t.eq(hb.routeState, "closed", "旧 state 仍可读出");
    t.includes(hb.reason, "已退出", "文案必须明说进程已退出");
    t.includes(hb.reason, "过期", "文案要说这是过期心跳");

    // 活 pid 的心跳照旧可用
    nodeFs.writeFileSync(nodePath.join(dir, "ui-route.json"), JSON.stringify({ state: "open", pid: process.pid, port: 60623 }), "utf8");
    const live = readUiRouteHeartbeat({ dir });
    t.eq(live.state, "fresh", `活 pid 的心跳必须 fresh，实际 ${live.state}`);
    t.eq(live.usable, true, "活 pid 的心跳可用");
    t.eq(live.port, 60623, "端口必须原样读出");

    // 没有心跳文件 ⇒ missing（checkup 据此不加行）
    t.eq(readUiRouteHeartbeat({ dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "route-none-")) }).state, "missing", "没有文件 ⇒ missing");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

/** 跑一次 checkup（临时 home，**不设** DSH_GOKIFU_FAKE_DISK_BUILD ⇒ 走真实的 pid 存活探测）。 */
function runCheckup(home, extraArgs = []) {
  const env = { ...process.env, DSH_HOME: home };
  delete env.DSH_GOKIFU_FAKE_DISK_BUILD;
  try {
    const stdout = execFileSync(process.execPath, [nodePath.join(ROOT, "scripts", "checkup.mjs"), ...extraArgs], {
      cwd: ROOT,
      encoding: "utf8",
      env,
      timeout: 300_000,
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error?.status ?? 1, stdout: String(error?.stdout ?? error?.message ?? "") };
  }
}

tests["BSS-7 checkup 端到端：死 pid 的 build.json ⇒ 该行 warn + 含「已退出」+ 不说「需要重启」，且红项不来自它"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "checkup-stale-"));
  const gc = nodePath.join(home, "chess-context");
  nodeFs.mkdirSync(gc, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(gc, "build.json"),
    JSON.stringify({ schema: "gokifu/build-stamp/v1", buildId: "e880016159fa", pid: DEAD_PID, startedAt: 1793811430385 }),
    "utf8",
  );
  nodeFs.writeFileSync(nodePath.join(gc, "ui-route.json"), JSON.stringify({ state: "closed", pid: DEAD_PID, port: 64535 }), "utf8");
  try {
    const r = runCheckup(home, ["--json"]);
    const parsed = JSON.parse(r.stdout || "{}");
    const row = (parsed.rows ?? []).find((x) => x.name === "运行实例版本");
    t.eq(row?.level, "warn", `stamp 过期必须是 warn（不是 bad ⇒ 不许说「需要重启」），实际 ${JSON.stringify(row)}`);
    t.includes(String(row?.detail ?? ""), "已退出", "文案必须含「已退出」");
    t.includes(String(row?.detail ?? ""), "无法据此判断运行版本", "必须明说「据此判断不了」");
    t.notIncludes(String(row?.detail ?? ""), "需要重启", "stamp 过期时**不得**把结论写成「需要重启」");
    // 红项必须来自别的检查项（若有），不能是「运行实例版本」这一行
    const badNames = (parsed.rows ?? []).filter((x) => x.level === "bad").map((x) => x.name);
    t.eq(badNames.includes("运行实例版本"), false, `「运行实例版本」不许是红项（实际红项：${badNames.join(",")}）`);
    t.eq(
      parsed.verdict === "yellow" || badNames.length > 0,
      true,
      `verdict 不许因为 stamp 过期变成 red（实际 ${parsed.verdict}，红项 ${badNames.join(",") || "无"}）`,
    );
    // 面板心跳同样只报「过期」，不断言面板死活
    const hbRow = (parsed.rows ?? []).find((x) => x.name === "面板心跳");
    t.eq(hbRow?.level, "warn", `过期心跳必须是 warn，实际 ${JSON.stringify(hbRow)}`);
    t.includes(String(hbRow?.detail ?? ""), "已退出", "心跳行也要说清 pid 已退出");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["BSS-8 checkup 人读模式：结论是「运行版本不可知」，不是「先重启」"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "checkup-stale-human-"));
  const gc = nodePath.join(home, "chess-context");
  nodeFs.mkdirSync(gc, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(gc, "build.json"),
    JSON.stringify({ schema: "gokifu/build-stamp/v1", buildId: "e880016159fa", pid: DEAD_PID, startedAt: 1793811430385 }),
    "utf8",
  );
  try {
    const r = runCheckup(home);
    t.includes(r.stdout, "已退出", "人读输出必须写明写戳的进程已退出");
    t.notIncludes(r.stdout, "先重启", "结论不许让人「先重启」（它不是重启能证明的事）");
    t.notIncludes(r.stdout, "新代码**未生效**", "不许把过期 stamp 读成「新代码未生效」");
    t.includes(r.stdout, "运行版本不可知", "必须给出「不可知」这个结论");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
