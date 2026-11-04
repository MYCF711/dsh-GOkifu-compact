#!/usr/bin/env node
/**
 * checkup.mjs —— **重启后一条命令看全部**（C602）
 *
 * 由来（真机 2026-11-05）：为了确认「新代码到底生效没有」，我每次都手敲 4~6 条命令
 * （build.json / doctor / status / backfill-state / fold-timeline / verify-archive），
 * 每次都要人肉比对"这算好还是不好"。这份重复劳动本身就是 bug 源 —— 漏看一条就会误判。
 *
 * 用法：
 *   node scripts/checkup.mjs          # 人读
 *   node scripts/checkup.mjs --json   # 机读（CI / 门禁）
 *
 * 退出码：0 = 全绿；1 = 有红项；2 = 有黄项（能跑，但有需要看的）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBuildStamp, readUiRouteHeartbeat } from "../src/rooms/build-stamp.mjs";
// ★ 2026-11-05：补账状态由 backfill-state.mjs 统一聚合（多实例共享同一目录），不在这里复制读盘逻辑。
import { readBackfillState, describeInstance } from "./backfill-state.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const json = process.argv.includes("--json");

const home = process.env.DSH_HOME ?? nodePath.join(nodePath.dirname(nodePath.dirname(process.env.USERPROFILE ?? "")), "DeepSeek Harness", "home");
const graphRootDir = nodePath.join(home, "chess-context");

const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });

const run = (script, args = [], timeout = 180_000) => {
  try {
    return execFileSync(process.execPath, [nodePath.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout,
      env: { ...process.env, DSH_HOME: home },
    });
  } catch (error) {
    return String(error?.stdout ?? error?.message ?? "");
  }
};

// ① 运行实例 vs 磁盘
// ★ 2026-11-05（真机事故）：build.json 可能是**已退出进程**写的。真机上 pid 22508 早就没了，
//   戳里却还留着它的 buildId ⇒ 本脚本把「旧构建」当成「功能坏了」的依据，连续误判多次。
//   现在分三态 + 一个「不知道」：新鲜才谈一致/落后；写戳的进程死了就**明说不可信**，不许据此断言。
//   ⚠ 合成夹具（DSH_GOKIFU_FAKE_DISK_BUILD）里的 pid 是编的，不拿它判死 —— 否则临时 home 的用例
//     会全部变成「过期」，而它们要测的是 buildId 比对的另外两态。
const fakeDisk = process.env.DSH_GOKIFU_FAKE_DISK_BUILD;
const synthetic = typeof fakeDisk === "string" && fakeDisk !== "";
const aliveProbe = synthetic ? () => true : undefined;
const shortId = (id) => (typeof id === "string" && id !== "" ? id.slice(0, 12) : "?");
const agoText = (ms) =>
  Number.isFinite(ms) ? (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} 小时前` : `${Math.max(1, Math.round(ms / 60_000))} 分钟前`) : "时间未知";

const stampRead = readBuildStamp({ dir: graphRootDir, isAlive: aliveProbe });
if (stampRead.state === "missing") {
  add("warn", "运行实例版本", "没有 build.json（插件可能没加载）");
} else if (stampRead.state === "invalid") {
  add("warn", "运行实例版本", "build.json 不是合法 JSON");
} else if (stampRead.state === "unverifiable") {
  add("warn", "运行实例版本", `${stampRead.reason} —— 运行版本**不可知**`);
} else if (stampRead.state === "stale") {
  // ★ 关键一行：pid 已退出 ⇒ 戳里的 build 既不能证明「新代码生效」，也不能证明「没生效」。
  add(
    "warn",
    "运行实例版本",
    `${stampRead.reason}（写于 ${agoText(stampRead.ageMs)}，戳里的 build ${shortId(stampRead.buildId)}）—— 这份戳不构成「新代码没生效」的证据，先确认现在跑的是哪个 pid`,
  );
} else {
  const disk = diskBuildId();
  if (disk === null) add("warn", "运行实例版本", "读不到磁盘 buildId（脚本异常）");
  else if (disk === stampRead.buildId)
    add("ok", "运行实例版本", `build ${shortId(stampRead.buildId)} = 磁盘（stamp 由 pid ${stampRead.pid} 写，该进程仍存活）`);
  else
    add(
      "bad",
      "运行实例版本",
      `运行 ${shortId(stampRead.buildId)} ≠ 磁盘 ${shortId(disk)} —— 新代码**未生效**，需要重启 DSH（stamp 由 pid ${stampRead.pid} 写，该进程仍存活）`,
    );
}

// ①b 面板心跳（同一类陷阱）：心跳里的端口/state 可能属于一个早就退出的进程。
//   ⚠ `missing` 时**不加行**：doctor 已经会报「未采集」，这里再报一次只会让既有判定漂移。
const hbRead = readUiRouteHeartbeat({ dir: graphRootDir, isAlive: aliveProbe });
if (hbRead.state === "stale") {
  add(
    "warn",
    "面板心跳",
    `${hbRead.reason}（state=${hbRead.routeState ?? "?"}、端口 ${hbRead.port ?? "?"} 都是旧值，写于 ${agoText(hbRead.ageMs)}）—— 面板现在是什么状态，这份文件答不了`,
  );
} else if (hbRead.state === "invalid") {
  add("warn", "面板心跳", "ui-route.json 不是合法 JSON（写盘可能中断）");
} else if (hbRead.state === "unverifiable") {
  add("warn", "面板心跳", `${hbRead.reason} —— 面板状态**不可知**`);
} else if (hbRead.state === "fresh") {
  add("ok", "面板心跳", `pid ${hbRead.pid} 存活 · state=${hbRead.routeState ?? "?"} · 端口 ${hbRead.port ?? "?"}（${agoText(hbRead.ageMs)}）`);
}
function diskBuildId() {
  // 测试专用：允许覆盖"磁盘 buildId"，否则临时 home 永远与真实磁盘不一致（无法测绿/黄态）
  const forced = process.env.DSH_GOKIFU_FAKE_DISK_BUILD;
  if (typeof forced === "string" && forced !== "") return forced;
  try {
    const out = execFileSync(process.execPath, ["-e", 'import("./src/rooms/build-stamp.mjs").then(m=>console.log(m.repoBuildId()))'], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

// ② 自动补账状态
// ★ 2026-11-05：`<chess-context>` 被**多个实例共享**，一个 `auto-backfill-state.json` 只能说明
//   「最后写者是谁」（实测 02:30/02:34 被不同实例互相覆盖，pid 读到时就已退出）。
//   ⇒ 这里不再自己 parse 单文件，改用 backfill-state.mjs 的聚合口径：取「最新且存活」的那份，
//   已退出 pid 的旧值**不当现值**（只报不可信，不许据此说「补账停了」）。
{
  const agg = readBackfillState({ dir: graphRootDir });
  if (agg.missing) {
    add("warn", "自动补账状态", "还没有 auto-backfill-state.json —— 本版可能未重启，或自动补账被关掉");
  } else {
    const latest = agg.latest;
    const s = latest?.data ?? {};
    const minutes = Math.round((Date.now() - Number(latest?.at ?? 0)) / 60_000);
    const othersNote =
      agg.others.length > 0
        ? ` · 另有 ${agg.others.length} 个实例状态（${agg.others.map((e) => `${describeInstance(e)} ${agoText(Number(e.ageMs ?? 0))}`).join("、")}）`
        : "";
    if (latest?.parseError) {
      add("warn", "自动补账状态", "状态文件不是合法 JSON（写盘可能中断）");
    } else if (latest?.alive === false) {
      // 写这份的进程已经没了 ⇒ 它既不能证明「补账在跑」，也不能证明「补账停了」。
      add(
        "warn",
        "自动补账状态",
        `${describeInstance(latest)} 写的状态（${minutes} 分钟前）—— 已退出实例的旧值**不是**现在在跑的实例，先确认当前 pid${othersNote}`,
      );
    } else if (s.armed === true && s.picked === undefined) {
      add("warn", "自动补账状态", `已布防但还没跑过（${minutes} 分钟前启动）${othersNote}`);
    } else if (typeof s.error === "string") {
      add("bad", "自动补账状态", `最近一轮抛错：${s.error.slice(0, 160)}${othersNote}`);
    } else {
      const results = Array.isArray(s.results) ? s.results : [];
      const folded = results.reduce((n, r) => n + (Number(r.folded) || 0), 0);
      const done = results.filter((r) => (r.stopped ?? "done") === "done" && (Number(r.folded) || 0) > 0).length;
      const inactive = results.filter((r) => r.stopped === "inactive-context").length;
      const detail =
        `${minutes} 分钟前 · 挑中 ${(s.picked ?? []).length} 个 · 折了 ${folded} 段（${done} 个会话有产出）` +
        (inactive > 0 ? ` · ${inactive} 个在等活跃回合` : "") +
        othersNote;
      if (minutes > 90) add("bad", "自动补账状态", `${detail} —— **超过 90 分钟没更新**，可能停了`);
      else if (folded === 0 && results.length > 0 && inactive === results.length) add("warn", "自动补账状态", `${detail} —— 全部在等活跃回合（无人用机时正常）`);
      else if (folded === 0 && results.length > 0) add("bad", "自动补账状态", `${detail} —— 跑了但一段都没折`);
      else add("ok", "自动补账状态", detail);
    }
  }
}

// ③ 折叠速率（近 1 小时）
try {
  const out = run("status.mjs", ["--fast", "--no-panel"]);
  const line = out.split(String.fromCharCode(10)).find((l) => l.includes("自动补账：开") || l.includes("自动补账:"));
  if (line) add("ok", "折叠速率", line.replace(/^[^：:]*[：:]/, "").trim().slice(0, 120));
} catch {
  /* status 失败不影响结论 */
}

// ④ 欠账规模
try {
  const out = run("backfill-forecast.mjs");
  const first = out.split(String.fromCharCode(10)).find((l) => l.includes("欠账") && l.includes("段"));
  if (first) add("ok", "欠账规模", first.replace(/^[^=]*==\s*/, "").trim().slice(0, 140));
} catch {
  /* 测算失败不影响结论 */
}

// ⑤ doctor
try {
  const out = run("doctor.mjs", ["--json"], 300_000);
  const j = JSON.parse(out);
  const bad = (j.checks ?? []).filter((c) => c.status === "bad" || c.ok === false).length;
  const warn = (j.checks ?? []).filter((c) => c.status === "warn" || c.status === "!").length;
  add(bad > 0 ? "bad" : "ok", "doctor", `错误 ${bad} / 警告 ${warn}`);
} catch {
  add("warn", "doctor", "跑不起来（看 doctor 原始输出）");
}

const bad = rows.filter((r) => r.level === "bad").length;
const warn = rows.filter((r) => r.level === "warn").length;
const verdict = bad > 0 ? "red" : warn > 0 ? "yellow" : "green";

if (json) {
  console.log(JSON.stringify({ verdict, rows }, null, 2));
} else {
  const icon = (l) => (l === "ok" ? "✓" : l === "warn" ? "!" : "✗");
  console.log("== 重启后体检 ==");
  for (const r of rows) console.log(`  ${icon(r.level)} ${r.name} — ${r.detail}`);
  // ★ C602：**别让人把"没重启"读成"功能坏了"**。build 不一致时，其余红项多半是它的后果。
  // ★ 2026-11-05：只有「stamp 新鲜且 buildId 与磁盘不同」才算「没重启」；stamp 过期（pid 已退出）
  //   是另一种结论 —— 运行版本**不可知**，不许被读成「未生效」。
  const buildMismatch = rows.some((r) => r.name === "运行实例版本" && r.level === "bad");
  const buildUnknown = rows.some((r) => r.name === "运行实例版本" && r.level === "warn");
  console.log(
    verdict === "green"
      ? "  ⇒ **全绿**：新代码已生效，补账在动。"
      : buildMismatch
        ? "  ⇒ **先重启**：运行实例还是旧构建，下面那些红项很可能只是它的后果；重启后重跑这一条。"
        : verdict === "red"
          ? `  ⇒ **有红项**：补账真的停了，按上面的具体原因查（不会再是「零产出」这种模糊话）。${buildUnknown ? "另：运行实例版本不可知（见上），别拿它当红项的成因。" : ""}`
          : buildUnknown
            ? "  ⇒ **运行版本不可知**：build.json 是已退出进程写的（见「运行实例版本」那行），它既不能证明新代码生效、也不能证明没生效。"
            : "  ⇒ **有黄项**：能跑，但上面 `!` 的每一条都值得看一眼。",
  );
}
process.exit(verdict === "red" ? 1 : verdict === "yellow" ? 2 : 0);
