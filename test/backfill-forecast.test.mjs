/**
 * backfill-forecast.test.mjs —— 「值不值得改代码提高上限」这个结论的守卫（C602，2026-11-05）
 *
 * 为什么要有这一组：`scripts/backfill-forecast.mjs` 是**只读**测算器，它唯一的用途是回答
 * 「按现在的调度多久能追平、卡在哪一项」。而它此前有两个**会让结论错掉**的洞：
 *
 *   ① **`--max=8` 被静默忽略**：旧实现用 `argv.indexOf("--max")` 取值，等号写法匹配不上
 *      ⇒ 回落 5，输出跟没传一模一样。读的人会以为"8 个会话也就这样"，而真相是这个数**根本配不出来**
 *      （`src/engine.mjs:2114` 的 `Math.max(0, Math.min(5, adaptive))` 写死）。
 *   ② **没有结论行**：反解散在四行里（24/48/72/120h），且 `maxSessions` 直接吃命令行传的 max，
 *      于是 `--max=8` 时它会把"每轮 8 个会话"判成做得到 —— 又是一次骗人。
 *
 * 这一组钉住三件事（全部离线，不联网、不调模型）：
 *   ① `--max>5` 的输出必须出现 `需改代码（\`Math.min(5, ...)\`）`；
 *   ② 反解表三档（24/48/72h）齐全，且 T 越小 ⇒ 所需会话数 / 预算越大（单调，不许骗人）；
 *   ③ 参数非法 ⇒ 退出码非 0 + 人话（不是静默夹一个数继续算）。
 *
 * 「失败分支必须真红」的证明：第 1 条用例把**旧实现的取值函数**原样抄进来跑一遍，
 * 它给出 5 —— 也就是说，把新实现换回旧实现时，第 2 条用例的 `≤8 会话` / `需改代码` 断言必然失败。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HARD_CAP_MARK,
  HARD_MAX_SESSIONS,
  TARGET_HOURS,
  buildReport,
  formatReport,
  parseCli,
  usage,
} from "../scripts/backfill-forecast.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "backfill-forecast.mjs");
const HOME = process.env.DSH_HOME ?? "";
const SESSIONS = HOME === "" ? "" : nodePath.join(HOME, "chess-context", "sessions");

/**
 * 夹具：真机 2026-11-05 那一批 `archive-offline` 折痕的中位/均值（76s、6,644 出字、245 事件/段）。
 * 只用于**离线**断言渲染逻辑；真机数据的取值仍在脚本里现算（见 `measureFromMarks`），不从这里来。
 */
const MEASURED = {
  n: 118,
  eventsPerSegment: 245,
  segmentSec: 76,
  meanSec: 76,
  p90Sec: 195,
  outputTokens: 6644,
  reasoningMax: 3436,
  inputTokens: 14_246,
};
const ITEMS = [
  { sessionId: "a", tail: 100, gapEvents: 0 },
  { sessionId: "b", tail: 465, gapEvents: 0 },
  { sessionId: "c", tail: 0, gapEvents: 928 },
  { sessionId: "d", tail: 40, gapEvents: 0 },
];

/** 纯函数路径的报告文本（不碰磁盘）。 */
function reportText(overrides = {}) {
  const out = buildReport({ items: ITEMS, measured: MEASURED, recent: 60, windowH: 6, ...overrides });
  out.noLog = 1;
  return { out, text: formatReport(out) };
}

/** 跑一次真 CLI（参数合法性与端到端输出都走它）。 */
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, env: process.env });
}

export const tests = {};

/* ───────────────── ① 旧实现的静默夹取（失败分支真红的证明） ───────────────── */

tests["C602 旧实现的 --max=8 会被静默夹成 5（这条就是回归守卫）"] = async (t) => {
  // ★ 旧实现原样抄写：`argv.indexOf("--max")` 认不出等号写法。
  //   它不报错、不提示，直接回落默认值 —— 这就是"给出误导性结果"的具体形状。
  const oldGetArg = (argv, name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  t.eq(oldGetArg(["--max=8"], "max", 5), 5, "旧实现下 --max=8 取不到值 ⇒ 静默回落 5（输出看起来跟没传一样）");
  t.eq(oldGetArg(["--max", "8"], "max", 5), "8", "旧实现只认空格写法（所以等号写法是纯粹的黑洞）");
  // 新实现两种写法都认，且**不许**回落到 5
  t.eq(parseCli(["--max=8"]).options.max, 8, "新实现必须认等号写法");
  t.eq(parseCli(["--max", "8"]).options.max, 8, "新实现必须认空格写法");
  t.eq(parseCli(["--max=8"]).errors, [], "等号写法不是错误，只是旧实现没实现");
};

/* ───────────────── ② --max>5 必须标注「需改代码」 ───────────────── */

tests[`C602 --max=8 的输出必须出现「${HARD_CAP_MARK}」`] = async (t) => {
  const { out, text } = reportText({ schedule: { ...{ intervalMin: 30, max: 8, rounds: 3, budgetSec: 420, maxTokensCap: 8192 } } });
  t.eq(out.overHardCap, true, "max=8 必须被判定为'超硬上限'");
  t.eq(out.hardMax, HARD_MAX_SESSIONS, `硬上限写死是 ${HARD_MAX_SESSIONS}（src/engine.mjs 的 Math.min(5, ...)）`);
  t.includes(text, HARD_CAP_MARK, "情景模拟必须原样标注「需改代码（`Math.min(5, ...)`）」");
  t.includes(text, "情景模拟", "要说清这是情景、不是能配出来的调度");
  t.includes(text, "≤8 会话", "输出里要看得见 8 —— 不许再静默显示成 5");
  t.notIncludes(text, "≤5 会话", "传了 --max=8 却显示 5，就是旧实现那个洞");
  t.includes(text, "改 env 不管用", "必须点破：环境变量进来后仍过 Math.min(5, ...)");
  // 敏感性表里 max>5 的那一行也要标（那张表最容易被当成"配置建议"）
  const row = text.split("\n").find((line) => /^\s+8\s+8\s+1800/.test(line));
  t.ok(row !== undefined, "敏感性表要有 max=8 那一行");
  t.includes(String(row), HARD_CAP_MARK, "max>5 的敏感性行也要挂标注");

  // 端到端：真跑一次 CLI（有真机数据就真跑，没有就用同一套纯函数渲染）
  if (SESSIONS !== "" && nodeFs.existsSync(SESSIONS)) {
    const cli = runCli(["--max=8"]);
    t.eq(cli.status, 0, `--max=8 必须正常退出（stderr=${String(cli.stderr).slice(0, 200)}）`);
    t.includes(cli.stdout, HARD_CAP_MARK, "真 CLI 的 --max=8 输出必须带标注");
    t.includes(cli.stdout, "≤8 会话", "真 CLI 的 --max=8 必须显示 8 个会话");
  }
};

tests["C602 默认调度（max=5）不许出现情景标注 —— 否则标注就失去意义"] = async (t) => {
  const { out, text } = reportText({ schedule: { intervalMin: 30, max: 5, rounds: 3, budgetSec: 420, maxTokensCap: 8192 } });
  t.eq(out.overHardCap, false, "max=5 在硬上限之内");
  t.notIncludes(text, "情景模拟", "没超上限就不该喊狼来了");
  t.notIncludes(text, "≤5 会话\n  ⚠", "默认调度后面不许跟警告行");
  // 但'硬上限'这句话本身仍要在（敏感性表头），免得读的人不知道 5 是哪来的
  t.includes(text, "硬上限", "表头要说明 max 是硬上限");
};

/* ───────────────── ③ 反解三档齐全且单调 ───────────────── */

tests["C602 反解表：24 / 48 / 72 三档齐全，且 T 越小要求的会话数与预算越大"] = async (t) => {
  const { out, text } = reportText();
  t.eq(
    out.targets.map((x) => x.hours),
    TARGET_HOURS,
    "三档必须正好是 24 / 48 / 72（顺序也别乱）",
  );
  t.eq(out.targets.length, 3, "只给三档 —— 这是结论行，不是清单");
  for (const target of out.targets) {
    t.ok(target.requiredSessions >= 1, `${target.hours}h 的会话数至少 1`);
    t.ok(target.requiredBudgetSec > 0, `${target.hours}h 的预算必须为正`);
    t.ok(Number.isFinite(target.requiredPerHour), `${target.hours}h 的段/小时必须是有限数`);
    t.includes(text, `要 ${target.hours} 小时追平 ⇒ 每轮`, `输出里要有 ${target.hours}h 那条结论`);
  }
  // 单调：T 越小（越急）⇒ 每轮要的会话数、预算都**不减少**
  for (let i = 1; i < out.targets.length; i += 1) {
    const fast = out.targets[i - 1];
    const slow = out.targets[i];
    t.ok(
      fast.requiredSessions >= slow.requiredSessions,
      `${fast.hours}h 要的会话数（${fast.requiredSessions}）必须 ≥ ${slow.hours}h 的（${slow.requiredSessions}）`,
    );
    t.ok(
      fast.requiredBudgetSec >= slow.requiredBudgetSec,
      `${fast.hours}h 要的预算（${fast.requiredBudgetSec}s）必须 ≥ ${slow.hours}h 的（${slow.requiredBudgetSec}s）`,
    );
    t.ok(fast.requiredPerHour >= slow.requiredPerHour, `${fast.hours}h 要的段/小时必须 ≥ ${slow.hours}h 的`);
  }
  // 24h 那一档在 max=5 下多半做不到 —— 做不到就必须标出来（不许悄悄判成 feasible）
  const hard = out.targets[0];
  if (hard.requiredSessions > HARD_MAX_SESSIONS) {
    t.eq(hard.feasible, false, "要的会话数超过硬上限时，反解必须判'做不到'");
    t.includes(text, HARD_CAP_MARK, "做不到的那一档要指向'需改代码'，而不是让人去调 env");
  }
};

/* ───────────────── ④ 参数非法：退出码非 0 + 人话 ───────────────── */

tests["C602 参数非法：退出码非 0，且给出人话（不许静默夹取）"] = async (t) => {
  const cases = [
    ["--max=abc", ["--max", "必须是数字"]],
    ["--max=0", ["--max", "超出范围"]],
    ["--max=5.5", ["--max", "必须是整数"]],
    ["--max", ["--max", "缺少取值"]],
    ["--bogus", ["未知参数", "--bogus"]],
    ["--rounds=-1", ["--rounds", "超出范围"]],
  ];
  for (const [arg, needles] of cases) {
    const cli = runCli([arg]);
    t.ne(cli.status, 0, `${arg} 必须非 0 退出（实际 ${cli.status}）`);
    const text = `${cli.stdout}${cli.stderr}`;
    for (const needle of needles) t.includes(text, needle, `${arg} 的报错要提到"${needle}"`);
    t.includes(text, "用法：", `${arg} 的报错要带用法（人话，不是堆栈）`);
    t.notIncludes(text, "    at ", `${arg} 的报错不许是原始堆栈`);
  }
  // 纯函数层也要一致：非法取值进 errors，合法取值不动 options
  const bad = parseCli(["--max=abc", "--rounds=0"]);
  t.eq(bad.errors.length, 2, "两个坏参数要各自报一条");
  t.eq(bad.options.max, 5, "坏参数不许污染 options（保持默认）");
  // --help 是成功路径
  const help = runCli(["--help"]);
  t.eq(help.status, 0, "--help 必须 0 退出");
  t.includes(help.stdout, HARD_CAP_MARK, "--help 里要写清 >5 只是情景模拟");
  t.includes(usage(), "--max", "usage() 要能单独被打印");
};
