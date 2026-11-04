#!/usr/bin/env node
/**
 * backfill-state.mjs —— 一条命令看「后台自动补账现在到底在干什么」（**多实例聚合版**）
 *
 * 为什么需要（C593/C594 真机教训，2026-11-04）：补账连续零产出，而
 *   · 日志在宿主控制台里（看不到）
 *   · 图上一个字段都不写（`chunks.length === 0` 时直接 return）
 * ⇒ "零产出" 与 "从没跑过" 在磁盘上长得一模一样。引擎现在每轮落盘：
 *   布防标记、挑中谁、每个会话的结局、异常。
 *
 * ★ 2026-11-05（真机事故）：本机同时跑着多个 DSH 实例，**共享**同一个 `<chess-context>`，
 *   旧实现只写一个 `auto-backfill-state.json` ⇒ 实例之间互相覆盖（实测 02:30 是 `everyMs:600000`，
 *   02:34 被另一实例的 `everyMs:1800000` 盖掉；写进去的 pid 读到时就已退出）。
 *   ⇒ 那个文件回答不了「现在在跑的实例在干什么」，只能说明「最后写者是谁」。
 *
 * 现在的落盘（引擎侧）：`auto-backfill-state.<pid>.json`（每实例一份，互不覆盖）
 *   + `auto-backfill-state.latest.json`（`{pid, at, file}` 索引，最后写者更新）
 *   + `auto-backfill-state.json`（旧版单文件，只为兼容老工具 —— 仍能读）。
 *
 * 本脚本的读侧口径：
 *   · 默认：取**最新且存活**的那份；已退出 pid 的旧文件**标注**「（该实例已退出）」，不当现值；
 *   · 聚合：列出「另有 N 个实例的状态文件（时间/pid）」；
 *   · `--all`：列出全部实例；
 *   · `--prune`：**显式**清理「pid 已退出且超过 1 小时」的文件（默认不动任何文件）。
 *
 * 用法：
 *   node scripts/backfill-state.mjs                # 最新实例（默认）
 *   node scripts/backfill-state.mjs --all          # 所有实例（含已退出的）
 *   node scripts/backfill-state.mjs --json         # 选中那份的原样 JSON
 *   node scripts/backfill-state.mjs --json --all   # 所有实例的元信息 + 内容
 *   node scripts/backfill-state.mjs --prune        # 只删「pid 已退出且 >1 小时」的
 *   node scripts/backfill-state.mjs --dir=<目录>   # 直接指定 <chess-context>（测试/取证）
 *
 * 退出码：0 = 正常（含"还没有状态文件"）；1 = 选中的状态文件不是合法 JSON。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { graphRoot } from "../src/rooms/kifu-persist.mjs";
import { processIsAlive } from "../src/rooms/build-stamp.mjs";

/** 旧版单文件（兼容：老工具只认它）。 */
export const LEGACY_STATE_NAME = "auto-backfill-state.json";
/** 最新索引（`{pid, at, file}`，由最后写者更新）。 */
export const LATEST_STATE_NAME = "auto-backfill-state.latest.json";
/** 按实例的文件名形状。 */
export const INSTANCE_STATE_RE = /^auto-backfill-state\.(\d+)\.json$/;
/** `--prune` 的时间门槛：超过 1 小时的死实例文件才删。 */
export const PRUNE_MIN_AGE_MS = 60 * 60_000;

/**
 * 文件名 → 种类。`null` = 与补账状态无关的文件（必须原样忽略，别去 parse 别人的 JSON）。
 * @param {string} name
 * @returns {{kind:"legacy"|"instance", pid:number|null}|null}
 */
export function classifyStateFile(name) {
  const base = String(name ?? "");
  if (base === LEGACY_STATE_NAME) return { kind: "legacy", pid: null };
  const m = INSTANCE_STATE_RE.exec(base);
  if (m !== null) return { kind: "instance", pid: Number(m[1]) };
  return null;
}

/** 有没有状态文件（任一形态）。 */
function readLatestIndex(dir) {
  try {
    const j = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, LATEST_STATE_NAME), "utf8"));
    return j !== null && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * 扫一个 `<chess-context>`，把**所有实例的状态文件**读成条目。
 *
 * 条目字段：`file / path / pid / at / ageMs / alive / legacy / data / parseError`。
 * `alive` 三态：`true` 存活、`false` 已退出、`null` pid 未知（不判死 —— 不知道就说不知道）。
 *
 * 去重：旧版单文件与同一实例的按 pid 文件是**同一次写盘**（pid + at 相同）⇒ 只留按 pid 那份。
 *
 * @param {{dir:string, isAlive?:(pid:number)=>boolean, now?:number}} options
 * @returns {{dir:string, entries:Array<object>, files:Array<object>, missing:boolean, index:object|null}}
 */
export function listBackfillStates({ dir, isAlive = processIsAlive, now = Date.now() } = {}) {
  const root = String(dir ?? "");
  const files = [];
  let names = [];
  try {
    names = nodeFs.readdirSync(root).sort();
  } catch {
    return { dir: root, entries: [], files: [], missing: true, index: null };
  }
  for (const name of names) {
    const kind = classifyStateFile(name);
    if (kind === null) continue;
    const file = nodePath.join(root, name);
    let mtimeMs = 0;
    try {
      mtimeMs = Number(nodeFs.statSync(file).mtimeMs) || 0;
    } catch {
      /* 读不到 mtime 就用别的时间兜底 */
    }
    let data = null;
    let parseError = null;
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(file, "utf8"));
      if (parsed === null || typeof parsed !== "object") parseError = "not-an-object";
      else data = parsed;
    } catch (error) {
      parseError = String(error?.message ?? error).slice(0, 160);
    }
    const parsedAt = Number(data?.at);
    const at = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : mtimeMs;
    const bodyPid = Number(data?.pid);
    const pid = Number.isInteger(bodyPid) && bodyPid > 0 ? bodyPid : kind.pid;
    // pid 未知 ⇒ 不判死（`alive: null`）：不许把"不知道"说成"已退出"。
    const alive = pid === null || pid === undefined ? null : isAlive(pid) === true;
    files.push({
      file: name,
      path: file,
      legacy: kind.kind === "legacy",
      pid: pid ?? null,
      at,
      ageMs: now - at,
      alive,
      data,
      parseError,
    });
  }
  // 同一次写盘的两种形态只留一份（按 pid 的那份是权威）
  const entries = files.filter(
    (entry) => !(entry.legacy && files.some((other) => !other.legacy && other.pid === entry.pid && other.at === entry.at)),
  );
  entries.sort((a, b) => b.at - a.at || Number(a.pid ?? 0) - Number(b.pid ?? 0));
  return { dir: root, entries, files, missing: entries.length === 0, index: readLatestIndex(root) };
}

/** 条目的一行身份（存活/已退出/未知）。 */
export function describeInstance(entry) {
  const pid = entry?.pid ?? null;
  if (pid === null) return "pid 未知";
  if (entry.alive === false) return `pid ${pid}（该实例已退出）`;
  if (entry.alive === true) return `pid ${pid}（存活）`;
  return `pid ${pid}（存活状态未知）`;
}

/**
 * 默认读的那份：**优先存活**、其次最新。
 * 全死时的兜底仍返回最新那条（诊断要用），但 `dead: true` 明示「这不是现值」。
 * @returns {{latest:object|null, others:Array<object>, dead:boolean, missing:boolean}}
 */
export function readBackfillState(options = {}) {
  const listed = listBackfillStates(options);
  const entries = listed.entries;
  const notDead = entries.filter((entry) => entry.alive !== false);
  const latest = notDead[0] ?? entries[0] ?? null;
  const others = entries.filter((entry) => entry !== latest);
  return { ...listed, latest, others, dead: latest !== null && latest.alive === false };
}

/**
 * 只删「pid 已退出 且 超过 1 小时」的状态文件（`--prune` 显式要求时才调用）。
 * 活着的、pid 未知的一律不动；`latest.json` 只在它指向的文件被删时跟着删。
 *
 * @param {{dir:string, isAlive?:(pid:number)=>boolean, now?:number, maxAgeMs?:number}} options
 * @returns {{removed:Array<object>, kept:number, dirIndexRemoved:boolean}}
 */
export function pruneBackfillStates({ dir, isAlive = processIsAlive, now = Date.now(), maxAgeMs = PRUNE_MIN_AGE_MS } = {}) {
  const listed = listBackfillStates({ dir, isAlive, now });
  const removed = [];
  for (const entry of listed.files) {
    if (entry.alive !== false) continue; // 存活 / pid 未知 ⇒ 不动
    if (!(now - entry.at > maxAgeMs)) continue; // 未超过 1 小时 ⇒ 不动
    try {
      nodeFs.rmSync(entry.path, { force: true });
      removed.push(entry);
    } catch {
      /* 删不掉就留着（诊断设施不许把脚本打挂） */
    }
  }
  let dirIndexRemoved = false;
  const index = listed.index;
  if (index !== null && removed.some((entry) => entry.file === index.file && entry.pid === index.pid)) {
    try {
      nodeFs.rmSync(nodePath.join(listed.dir, LATEST_STATE_NAME), { force: true });
      dirIndexRemoved = true;
    } catch {
      /* 同上 */
    }
  }
  return { removed, kept: listed.files.length - removed.length, dirIndexRemoved };
}

/* ────────────────────────────── 显示 ────────────────────────────── */

/** 相对时间：秒 / 分钟 / 小时。 */
function agoText(t, now = Date.now()) {
  const ms = now - Number(t ?? 0);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  return `${Math.round(ms / 3_600_000)} 小时前`;
}

/** 一份状态的一行摘要（用于 `--all` / 「另有 N 个」）。 */
function oneLineSummary(state) {
  if (state === null || typeof state !== "object") return "（内容读不出来）";
  if (typeof state.error === "string") return `最近一轮抛错：${state.error.slice(0, 60)}`;
  if (state.armed === true && state.picked === undefined) {
    return `已布防 · 每 ${Math.round(Number(state.everyMs) / 60000)} 分钟一轮 · 还没跑过第一轮`;
  }
  const results = Array.isArray(state.results) ? state.results : [];
  const folded = results.reduce((n, r) => n + (Number(r?.folded) || 0), 0);
  const picked = Array.isArray(state.picked) ? state.picked.length : 0;
  return `欠账 ${state.due ?? "?"} · 挑中 ${picked} 个 · 折了 ${folded} 段 · 用时 ${Math.round(Number(state.doneMs ?? 0) / 1000)}s`;
}

/** 一份状态的正文（与旧版口径一致：布防 / 抛错 / 每会话结局）。 */
function renderBody(state) {
  const out = [];
  if (state === null || typeof state !== "object") {
    out.push("  · （状态内容读不出来）");
    return out;
  }
  if (state.armed === true && state.picked === undefined) {
    out.push(`  · 已布防（${agoText(state.at)}）· 每 ${Math.round(Number(state.everyMs) / 60000)} 分钟一轮，首轮 +${Math.round(Number(state.firstDelayMs) / 1000)}s · pid ${state.pid ?? "?"}`);
    out.push("  · 还没有跑过第一轮 —— 若超过首轮时间仍然是这条，说明定时器没跑起来");
    return out;
  }
  if (typeof state.error === "string") {
    out.push(`  · ❌ 最近一轮**抛错**（${agoText(state.at)}）：${state.error}`);
    return out;
  }
  const picked = Array.isArray(state.picked) ? state.picked : [];
  out.push(
    `  · 最近一轮：${agoText(state.at)} · 欠账 ${state.due ?? "?"} 个 · 每轮最多 ${state.max ?? "?"} 个 · 用时 ${Math.round(Number(state.doneMs ?? 0) / 1000)}s`,
  );
  out.push(`  · 挑中：${picked.length === 0 ? "（空）" : picked.map((x) => String(x).slice(0, 12)).join(" · ")}`);
  const results = Array.isArray(state.results) ? state.results : [];
  for (const r of results) {
    const head = `  - ${String(r?.id ?? "").slice(0, 12)}`;
    const tail =
      `折了 ${r?.folded ?? 0} 段` +
      (r?.stopped ? ` · 停止原因 ${r.stopped}` : "") +
      (r?.partial ? " · 仍有缺口" : "") +
      (r?.error ? ` · 错误 ${String(r.error).slice(0, 80)}` : "");
    out.push(`${head} → ${tail}`);
  }
  if (results.length === 0 && picked.length > 0) {
    out.push("  ⚠ 挑中了但没有任何结局记录 ⇒ 说明在记录之前就抛错了（看上一行的 error）");
  }
  return out;
}

/** 「另有 N 个实例的状态文件」那一行（默认输出用）。 */
function othersLine(others) {
  if (others.length === 0) return null;
  const items = others.map((entry) => `${describeInstance(entry)} · ${agoText(entry.at)} · ${entry.file}`);
  return `  · 另有 ${others.length} 个实例的状态文件：${items.join("；")}`;
}

/* ────────────────────────────── CLI ────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const wantAll = argv.includes("--all");
  const wantJson = argv.includes("--json");
  const wantPrune = argv.includes("--prune");
  const dirArg = argv.find((a) => a.startsWith("--dir="));
  const home =
    process.env.DSH_HOME ?? nodePath.join(nodePath.dirname(nodePath.dirname(process.env.USERPROFILE ?? "")), "DeepSeek Harness", "home");
  const root = dirArg ? nodePath.resolve(dirArg.slice("--dir=".length)) : graphRoot({ dshHome: home });

  if (wantPrune) {
    const result = pruneBackfillStates({ dir: root });
    if (result.removed.length === 0) {
      console.log(`== 清理：没有可删的 ==\n   （只删「pid 已退出且超过 1 小时」的；本次保留 ${result.kept} 个文件）\n   ${root}`);
    } else {
      console.log(`== 清理：删了 ${result.removed.length} 个（pid 已退出且超过 1 小时）==`);
      for (const entry of result.removed) console.log(`  - ${entry.file} · ${describeInstance(entry)} · ${agoText(entry.at)}`);
      console.log(`  · 保留 ${result.kept} 个文件${result.dirIndexRemoved ? " · 最新索引指向已删文件，一并移除" : ""}`);
    }
    if (!wantAll) return 0;
  }

  const agg = readBackfillState({ dir: root });
  if (agg.missing) {
    if (wantJson) {
      console.log(JSON.stringify({ missing: true, dir: root }, null, 2));
      return 0;
    }
    console.log(`== 还没有状态文件 ==\n   ${root}\n   可能：① 这一版还没重启（引擎不会写）；② 自动补账被关掉了。`);
    return 0;
  }

  if (wantJson) {
    if (wantAll) {
      console.log(
        JSON.stringify(
          agg.entries.map((entry) => ({
            file: entry.file,
            pid: entry.pid,
            at: entry.at,
            alive: entry.alive,
            legacy: entry.legacy,
            latest: entry === agg.latest,
            parseError: entry.parseError,
            state: entry.data,
          })),
          null,
          2,
        ),
      );
      return 0;
    }
    const selected = agg.latest;
    if (selected?.parseError) {
      console.log(`✗ 状态文件不是合法 JSON：${selected.path}`);
      return 1;
    }
    console.log(JSON.stringify(selected?.data ?? null, null, 2));
    return 0;
  }

  if (wantAll) {
    console.log(`== 后台自动补账状态 · 全部实例（${agg.entries.length} 个状态文件）==`);
    const aliveCount = agg.entries.filter((entry) => entry.alive === true).length;
    const deadCount = agg.entries.filter((entry) => entry.alive === false).length;
    console.log(`  · 存活 ${aliveCount} / 已退出 ${deadCount} / 未知 ${agg.entries.length - aliveCount - deadCount}`);
    for (const entry of agg.entries) {
      const mark = entry === agg.latest ? "→" : " ";
      const tag = entry === agg.latest ? " ← 默认读到这份" : "";
      const legacy = entry.legacy ? " · 旧版单文件（兼容）" : "";
      console.log(
        `${mark} ${describeInstance(entry)} · ${agoText(entry.at)} · ${entry.parseError ? `✗ 不是合法 JSON（${entry.parseError}）` : oneLineSummary(entry.data)} · ${entry.file}${legacy}${tag}`,
      );
    }
    return 0;
  }

  const selected = agg.latest;
  console.log("== 后台自动补账状态 ==");
  console.log(`  · 来源：${describeInstance(selected)} · 写于 ${agoText(selected.at)} · ${selected.file}${selected.legacy ? "（旧版单文件）" : ""}`);
  if (selected.alive === false) {
    console.log("  · ⚠ 写这份状态的进程**已经退出** ⇒ 下面是它退出前的值，**不是**现在在跑的实例");
  }
  if (selected.parseError) {
    console.log(`  ✗ 状态文件不是合法 JSON：${selected.path}`);
    return 1;
  }
  for (const line of renderBody(selected.data)) console.log(line);
  const others = othersLine(agg.others);
  if (others !== null) console.log(others);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
