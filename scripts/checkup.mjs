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

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const json = process.argv.includes("--json");

const home = process.env.DSH_HOME ?? nodePath.join(nodePath.dirname(nodePath.dirname(process.env.USERPROFILE ?? "")), "DeepSeek Harness", "home");
const graphRootDir = nodePath.join(home, "chess-context");
const stateFile = nodePath.join(graphRootDir, "auto-backfill-state.json");

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
const buildFile = path(buildDir(), "build.json");
function buildDir() {
  return graphRootDir;
}
function path(dir, name) {
  return nodePath.join(dir, name);
}
if (nodeFs.existsSync(buildFile)) {
  try {
    const b = JSON.parse(nodeFs.readFileSync(buildFile, "utf8"));
    const disk = diskBuildId();
    if (disk === null) add("warn", "运行实例版本", "读不到磁盘 buildId（脚本异常）");
    else if (disk === b.buildId) add("ok", "运行实例版本", `build ${String(b.buildId).slice(0, 12)} = 磁盘（pid ${b.pid}）`);
    else
      add(
        "bad",
        "运行实例版本",
        `运行 ${String(b.buildId).slice(0, 12)} ≠ 磁盘 ${String(disk).slice(0, 12)} —— 新代码**未生效**，需要重启 DSH`,
      );
  } catch {
    add("warn", "运行实例版本", "build.json 不是合法 JSON");
  }
} else {
  add("warn", "运行实例版本", "没有 build.json（插件可能没加载）");
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
if (!nodeFs.existsSync(stateFile)) {
  add("warn", "自动补账状态", "还没有 auto-backfill-state.json —— 本版可能未重启，或自动补账被关掉");
} else {
  try {
    const s = JSON.parse(nodeFs.readFileSync(stateFile, "utf8"));
    const minutes = Math.round((Date.now() - Number(s.at ?? 0)) / 60_000);
    if (s.armed === true && s.picked === undefined) {
      add("warn", "自动补账状态", `已布防但还没跑过（${minutes} 分钟前启动）`);
    } else if (typeof s.error === "string") {
      add("bad", "自动补账状态", `最近一轮抛错：${s.error.slice(0, 160)}`);
    } else {
      const results = Array.isArray(s.results) ? s.results : [];
      const folded = results.reduce((n, r) => n + (Number(r.folded) || 0), 0);
      const done = results.filter((r) => (r.stopped ?? "done") === "done" && (Number(r.folded) || 0) > 0).length;
      const inactive = results.filter((r) => r.stopped === "inactive-context").length;
      const detail = `${minutes} 分钟前 · 挑中 ${(s.picked ?? []).length} 个 · 折了 ${folded} 段（${done} 个会话有产出）` + (inactive > 0 ? ` · ${inactive} 个在等活跃回合` : "");
      if (minutes > 90) add("bad", "自动补账状态", `${detail} —— **超过 90 分钟没更新**，可能停了`);
      else if (folded === 0 && results.length > 0 && inactive === results.length) add("warn", "自动补账状态", `${detail} —— 全部在等活跃回合（无人用机时正常）`);
      else if (folded === 0 && results.length > 0) add("bad", "自动补账状态", `${detail} —— 跑了但一段都没折`);
      else add("ok", "自动补账状态", detail);
    }
  } catch {
    add("warn", "自动补账状态", "状态文件不是合法 JSON（写盘可能中断）");
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
  const stale = rows.some((r) => r.name === "运行实例版本" && r.level === "bad");
  console.log(
    verdict === "green"
      ? "  ⇒ **全绿**：新代码已生效，补账在动。"
      : stale
        ? "  ⇒ **先重启**：运行实例还是旧构建，下面那些红项很可能只是它的后果；重启后重跑这一条。"
        : verdict === "yellow"
          ? "  ⇒ **有黄项**：能跑，但上面 `!` 的每一条都值得看一眼。"
          : "  ⇒ **有红项**：补账真的停了，按上面的具体原因查（不会再是「零产出」这种模糊话）。",
  );
}
process.exit(verdict === "red" ? 1 : verdict === "yellow" ? 2 : 0);
