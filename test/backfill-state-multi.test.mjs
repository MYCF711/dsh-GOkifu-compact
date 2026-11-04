/**
 * backfill-state-multi.test.mjs —— 多实例共享 `<chess-context>` 时，补账状态必须**可归因**
 *
 * 为什么需要（2026-11-05 真机）：本机同时跑着多个 DSH 实例（实测 02:40 有 4640 / 9228 / 10096），
 * 它们共用同一个 `<chess-context>`，旧实现只写一个 `auto-backfill-state.json` ⇒
 *   · 02:30 写的是 `everyMs:600000`（10 分钟，新代码），02:34 被另一实例的 `everyMs:1800000` 盖掉；
 *   · 文件里的 pid 每次看都不一样，而且**读到时就已退出**（10096 → 18704 → …）。
 * ⇒「读一个共享状态文件判断运行状态」读到的是**最后写者**，不是**当前实例**。
 *
 * 本用例钉住三件事：
 *   ① 读侧聚合：默认取「最新且**存活**」的那份；已退出 pid 的旧值只标注、不当现值；
 *   ② 清理：`--prune` 只删「pid 已退出 **且** 超过 1 小时」的，默认一个都不动；
 *   ③ 写侧：引擎按实例落盘（`auto-backfill-state.<pid>.json`）+ latest 索引 + 旧版单文件（兼容）。
 *
 * 「旧实现下会红」的对照是**内联**的（见 ① 里的 oldImplPid）：旧读法只 parse 单文件，
 * 拿到的正是那个已退出实例的 pid —— 与聚合结论不同，所以这条断言在旧实现下必然失败。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processIsAlive } from "../src/rooms/build-stamp.mjs";
import { readBackfillState, pruneBackfillStates } from "../scripts/backfill-state.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "backfill-state.mjs");

export const tests = {};

const writeState = (dir, name, body) => nodeFs.writeFileSync(nodePath.join(dir, name), JSON.stringify(body, null, 2), "utf8");
const runScript = (args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env } });

/**
 * 造三个（其实是四个文件）现场：
 *   · `process.pid` —— 真活 pid，最新一轮有产出（**应该**被默认读到）
 *   · 子进程 pid   —— 真活 pid，更早一轮
 *   · `999999`     —— 死 pid，2 小时前（**应该**被 --prune 删掉）
 *   · 旧版单文件   —— 死 pid 999999 在 **1 分钟前**的最后一次写盘（旧读法就是被它骗的）
 * @returns {{dir:string, child:import("node:child_process").ChildProcess, own:number, now:number}}
 */
function scenario() {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bf-state-multi-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const own = process.pid;
  const now = Date.now();
  writeState(dir, `auto-backfill-state.${own}.json`, {
    at: now - 120_000,
    pid: own,
    due: 9,
    max: 2,
    picked: ["s1", "s2"],
    results: [{ id: "s1", folded: 2, stopped: "done" }],
    doneMs: 5000,
  });
  writeState(dir, `auto-backfill-state.${child.pid}.json`, {
    at: now - 300_000,
    pid: child.pid,
    due: 4,
    max: 2,
    picked: ["s3"],
    results: [{ id: "s3", folded: 1, stopped: "done" }],
    doneMs: 3000,
  });
  writeState(dir, "auto-backfill-state.999999.json", {
    at: now - 2 * 3_600_000,
    pid: 999999,
    due: 7,
    max: 3,
    picked: ["x"],
    results: [{ id: "x", folded: 0, stopped: "error" }],
    doneMs: 900,
  });
  writeState(dir, "auto-backfill-state.json", {
    at: now - 60_000,
    pid: 999999,
    due: 7,
    max: 3,
    picked: ["x"],
    results: [{ id: "x", folded: 0, stopped: "error" }],
    doneMs: 900,
  });
  return { dir, child, own, now };
}

const clean = (dir, child) => {
  try {
    child?.kill?.();
  } catch {
    /* 已经退出 */
  }
  try {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响判定 */
  }
};

tests["① 默认读最新且存活的实例；已退出 pid 的旧值不当现值（旧实现只读单文件 ⇒ 必然红）"] = (t) => {
  const { dir, child, own, now } = scenario();
  try {
    t.eq(processIsAlive(own), true, "夹具前提：process.pid 必须真活");
    t.eq(processIsAlive(child.pid), true, "夹具前提：子进程 pid 必须真活");

    const agg = readBackfillState({ dir, now });
    t.eq(agg.latest?.pid, own, "默认必须取「存活实例里最新」的那份");
    t.eq(agg.latest?.alive, true, "选中那份的写者必须存活");
    t.eq(agg.others.length, 3, `另有 3 个实例状态文件（实际 ${agg.others.length}）`);

    // 旧实现（只 parse `auto-backfill-state.json`）会拿到什么 —— 内联对照
    const legacy = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "auto-backfill-state.json"), "utf8"));
    const oldImplPid = Number(legacy.pid);
    const oldImplShownAsFresh = now - Number(legacy.at) < 5 * 60_000;
    t.eq(oldImplPid, 999999, "旧实现的读法拿到的就是已退出实例 999999");
    t.eq(processIsAlive(oldImplPid), false, "而 999999 已经退出 —— 旧实现把死实例当现值");
    t.eq(oldImplShownAsFresh, true, "它看起来还「很新」（1 分钟前）—— 这正是最骗人的形态");
    t.eq(oldImplPid === agg.latest?.pid, false, "旧实现与聚合结论不同 ⇒ 本用例在旧实现下必然红");

    const out = runScript([`--dir=${dir}`]);
    t.includes(out, `pid ${own}（存活）`, "默认输出要点名存活实例");
    t.includes(out, "折了 2 段", "默认输出要显示那一轮的结局");
    t.includes(out, "另有 3 个实例的状态文件", "默认输出要提示还有几个实例文件");

    const othersLine = out.split(String.fromCharCode(10)).find((line) => line.includes("另有")) ?? "";
    t.eq(othersLine.includes(`auto-backfill-state.${own}.json`), false, "「另有」里不许把选中的那份当成别的实例");
    t.includes(othersLine, "pid 999999（该实例已退出）", "死 pid 必须在同一行里标注「（该实例已退出）」");
    t.includes(othersLine, "1 分钟前", "「另有」那行要带时间");
  } finally {
    clean(dir, child);
  }
};

tests["② --all 列出所有实例（含旧版单文件），死 pid 全部标注已退出"] = (t) => {
  const { dir, child, own, now } = scenario();
  try {
    const out = runScript(["--all", `--dir=${dir}`]);
    const lines = out.split(String.fromCharCode(10));
    t.includes(out, "全部实例（4 个状态文件）", "四个文件都要列出来");
    t.includes(out, `auto-backfill-state.${own}.json`, "要列活跃实例的文件");
    t.includes(out, `auto-backfill-state.${child.pid}.json`, "要列第二个活跃实例的文件");
    t.includes(out, "auto-backfill-state.999999.json", "要列已退出实例的文件");
    t.includes(out, "旧版单文件（兼容）", "旧版单文件要说明身份");
    t.eq(lines.filter((line) => line.includes("pid 999999（该实例已退出）")).length, 2, "两份死 pid 文件都要标注已退出");
    t.includes(out, "存活 2 / 已退出 2", "计数要分开活/死，别混成一个数");

    const meta = JSON.parse(runScript(["--json", "--all", `--dir=${dir}`]));
    t.eq(meta.length, 4, "--json --all 要给全部条目");
    t.eq(meta.filter((row) => row.alive === false).length, 2, "元信息里 dead 条目数要对上");
    t.eq(meta.filter((row) => row.latest === true).length, 1, "只许有一条被标成默认读到的那份");
  } finally {
    clean(dir, child);
  }
};

tests["③ --prune 只删「pid 已退出且超过 1 小时」的（默认不动任何文件）"] = (t) => {
  const { dir, child, own, now } = scenario();
  try {
    const before = nodeFs.readdirSync(dir).sort();
    t.eq(before.length, 4, "删除前 4 个文件");

    // 默认（不带 --prune）：一个都不许删
    runScript([`--dir=${dir}`]);
    t.eq(nodeFs.readdirSync(dir).sort(), before, "默认只读，不许顺手清理");

    const result = pruneBackfillStates({ dir, now });
    t.eq(result.removed.map((entry) => entry.file), ["auto-backfill-state.999999.json"], "只删死 pid 且 >1 小时那份");
    t.eq(result.kept, 3, "活着 2 个 + 未满 1 小时的死实例 1 个都要留着");

    const after = nodeFs.readdirSync(dir).sort();
    t.eq(after.length, 3, "删除后 3 个文件");
    t.eq(after.includes("auto-backfill-state.999999.json"), false, ">1 小时的死实例文件要删掉");
    t.eq(after.includes("auto-backfill-state.json"), true, "旧版单文件（死实例 1 分钟前写的）不许删");
    t.eq(after.includes(`auto-backfill-state.${own}.json`), true, "存活实例的文件不许删");
    t.eq(after.includes(`auto-backfill-state.${child.pid}.json`), true, "第二个存活实例的文件不许删");
    t.eq(readBackfillState({ dir, now }).latest?.pid, own, "清理后默认读到的仍是存活那份");
  } finally {
    clean(dir, child);
  }
};

tests["④ 兼容：只有旧版单文件时仍能读出来（用户机器上现存文件不许失效）"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bf-state-legacy-"));
  try {
    const own = process.pid;
    writeState(dir, "auto-backfill-state.json", {
      at: Date.now() - 30_000,
      pid: own,
      due: 3,
      max: 2,
      picked: ["a"],
      results: [{ id: "a", folded: 1, stopped: "done" }],
      doneMs: 4000,
    });
    const agg = readBackfillState({ dir });
    t.eq(agg.missing, false, "旧版单文件也算状态存在");
    t.eq(agg.latest?.legacy, true, "要认出它是旧版单文件");
    t.eq(agg.latest?.pid, own, "pid 从文件内容读（文件名里没有 pid）");
    t.includes(String(agg.latest?.data?.picked?.[0]), "a", "内容要能原样读到");
    t.eq(agg.others.length, 0, "没有别的实例文件时「另有」为 0");

    const out = runScript([`--dir=${dir}`]);
    t.includes(out, "auto-backfill-state.json（旧版单文件）", "输出要说明这是旧版单文件");
    t.includes(out, "折了 1 段", "旧版单文件的正文照常渲染");
    t.notIncludes(out, "另有", "只有一个文件时不许说「另有 N 个」");
  } finally {
    clean(dir, null);
  }
};

tests["⑤ 写侧：引擎按实例落盘（互不覆盖）+ latest 索引 + 旧版单文件（兼容）"] = async (t) => {
  const harness = await import(pathToFileURL(nodePath.join(ROOT, "test", "engine-harness.test.mjs")).href);
  const { mod } = await harness.load();
  t.eq(typeof mod.writeAutoBackfillState, "function", "引擎要导出落盘函数（可单测）");
  const src = nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
  t.eq(
    src.includes('nodePath.join(dir, "auto-backfill-state.json")'),
    false,
    "写盘不许再直接落地共享单文件（必须走 writeAutoBackfillState）",
  );
  t.eq(src.includes("writeAutoBackfillState(dir, report)"), true, "每轮报告要按实例落盘");

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bf-state-write-"));
  try {
    const first = mod.writeAutoBackfillState(dir, { at: 111, armed: true, everyMs: 600000, firstDelayMs: 120000, pid: 4242 });
    t.eq(nodePath.basename(String(first)), "auto-backfill-state.4242.json", "按 pid 命名的那份是权威");
    t.eq(nodeFs.existsSync(String(first)), true, "按 pid 的文件要真的落盘");
    t.eq(nodeFs.existsSync(nodePath.join(dir, "auto-backfill-state.json")), true, "旧版单文件仍要写（老工具/老用例读它）");
    const index = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "auto-backfill-state.latest.json"), "utf8"));
    t.eq(index, { pid: 4242, at: 111, file: "auto-backfill-state.4242.json" }, "latest 索引内容 = {pid, at, file}");

    // 第二个"实例"写同一目录：按 pid 的互不覆盖，只有旧版单文件是最后写者
    mod.writeAutoBackfillState(dir, { at: 222, pid: 4243, due: 1, picked: [], results: [] });
    const names = nodeFs.readdirSync(dir).sort();
    t.eq(names.includes("auto-backfill-state.4242.json"), true, "第一个实例的文件不许被覆盖/删除");
    t.eq(names.includes("auto-backfill-state.4243.json"), true, "第二个实例另起一份");
    const legacy = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "auto-backfill-state.json"), "utf8"));
    t.eq(legacy.pid, 4243, "旧版单文件保持旧语义 = 最后写者");
    t.eq(JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "auto-backfill-state.4242.json"), "utf8")).at, 111, "先写那份内容没被改");

    const agg = readBackfillState({ dir, isAlive: () => true });
    t.eq(agg.entries.length, 2, "读侧把两个实例都聚合出来（旧版单文件与 4243 是同一次写盘，去重）");
    t.eq(agg.latest?.pid, 4243, "默认取最新那份");
  } finally {
    clean(dir, null);
  }
};
