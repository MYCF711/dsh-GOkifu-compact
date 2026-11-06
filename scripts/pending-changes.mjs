#!/usr/bin/env node
/**
 * pending-changes.mjs —— **「这个时间点之后改过的代码，哪些还没被运行实例验证」**（C646）
 *
 * 由来（今晚连续 4 次踩同一个坑，Lead 要求把它变成自动检测）：
 *   代码已经改了，但跑的是旧进程 —— 每次都白烧一整轮验证。
 *     · 04:5x C607 机械补回：`failuresRepaired` 在 534 条折痕里出现 **0 次**，而进程比代码早 41 分钟；
 *     · 05:5x C607 提示词：`git show adfaa8c` 里**没有**这条规则；
 *     · 06:0x C640 回滚修复：修完之后**又新增**第 2 条悬空边；
 *     · 06:2x C642 摘要正文：「C642 之后」的 71 条折痕**全部**是旧代码写的。
 *   `scripts/checkup.mjs` 原来只有一条「build X ≠ 磁盘 Y」：它说得出"不一致"，
 *   却说不出**"哪些改动还没生效、各自该跑什么命令复验"** —— 于是每一轮都要人肉去 `git log` 里翻。
 *
 * 判据（四条，缺一条就会说谎）：
 *   ① **时间点只认 `build.json.startedAt`**，不认文件 mtime。
 *      `git checkout` / `rebase` / `clone` 会把整棵树的 mtime 重写成"刚刚"，内容却一个字节没变
 *      （本仓 C293/C294 已经两次踩到：「时间戳会骗人」）。
 *   ② **只信 git 的提交时间**：`git log --since=<T>` 回答的是「这段内容什么时候进入历史」。
 *      工作区未提交的改动 git 不记录时刻 ⇒ 单列一桶，**明确标注"时刻不可判"**，绝不当成"没改动"。
 *   ③ **读不到就说"无法判断"**：git 不存在 / 不是仓库 / build.json 读不出来时**不许**退化成一个绿字
 *      —— 那正是这个脚本要堵的假绿。
 *   ④ **每条建议必须是真能跑的命令**：脚本自己先 `require` 得到入口（有 main 守卫）才给 `node <脚本>`，
 *      否则退回全量体检；文档工具不给裸跑（`add-changelog` 之类跑一次会改文件）。
 *
 * 用法：
 *   node scripts/pending-changes.mjs                    # 时间点 = <home>/chess-context/build.json.startedAt
 *   node scripts/pending-changes.mjs --since=2026-11-05T04:28:33Z
 *   node scripts/pending-changes.mjs --home=D:/x/home --root=D:/x/repo
 *   node scripts/pending-changes.mjs --json             # 机读
 *
 * 退出码：0 = 无待验证改动；1 = 有待验证改动（每条都附复验命令）；2 = 无法判断（**不是**"没有改动"）。
 *
 * 边界：**只读**。只调 `git log` / `git status`（不 add、不 commit、不 checkout、不 write）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
/** 本仓根目录（`scripts/` 的上一级）。 */
export const ROOT = nodePath.resolve(HERE, "..");

/** 只看这两棵子树：`src/**` 是运行时，`scripts/**` 是诊断设施。 */
export const WATCHED_DIRS = ["src", "scripts"];

/** 改动归类（按「验证它需要什么证据」切，不按目录切）。 */
export const CHANGE_CLASSES = {
  /** 模型看到的那段文本 / 输入口径变了 —— 摘要质量只能靠真机折痕证明。 */
  PROMPT: "改提示词",
  /** 磁盘上留下什么变了 —— 只能靠新产生的记录证明。 */
  WRITE_BACK: "改写回点",
  /** 判据本身变了 —— 旧记录按新判据重算会变，必须重跑。 */
  DETECTOR: "改探测器",
  /** 只影响文档 —— 不需要真机证据，跑一致性检查即可。 */
  DOCS: "改文档",
  /** 没命中任何已知判据 —— 用全量体检兜底（宁可多跑一条，也不许假装"不用验"）。 */
  OTHER: "未归类",
};

/* ────────────────────────────────────────────────────────────────────────────
 * ① 时间点：只认 build.json.startedAt
 * ──────────────────────────────────────────────────────────────────────────── */

/** 本机时区的 ISO（带偏移），报告里比 UTC 好读。 */
function isoLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/**
 * 读「运行实例的启动时刻」。
 *
 * ★ 为什么**不用**文件 mtime：checkout / rebase / clone 会把 mtime 全部重写成"刚刚"，
 *   内容却一个字节没变（本仓 C293/C294 两次踩到）。`startedAt` 是**进程启动那一刻**写进去的，
 *   才是"从这一刻起，磁盘上的改动都不在运行实例里"的唯一可信锚点。
 *
 * @param {{dir?:string, readFile?:(file:string)=>string}} [options] `dir` = `<home>/chess-context`
 * @returns {{state:"ok"|"missing"|"invalid", file:string|null, reason?:string,
 *            startedAt?:number, iso?:string, local?:string, pid?:number|null, buildId?:string|null}}
 */
export function readStartPoint({ dir, readFile = (file) => nodeFs.readFileSync(file, "utf8") } = {}) {
  if (typeof dir !== "string" || dir.trim() === "") {
    return { state: "missing", file: null, reason: "没有给 home 目录（--home / DSH_HOME 都为空）" };
  }
  const file = nodePath.join(dir, "build.json");
  let text;
  try {
    text = readFile(file);
  } catch (error) {
    const code = error?.code ?? "";
    return { state: "missing", file, reason: `读不到 build.json${code ? `（${code}）` : ""}` };
  }
  let stamp = null;
  try {
    stamp = JSON.parse(String(text));
  } catch {
    return { state: "invalid", file, reason: "build.json 不是合法 JSON（写盘可能中断）" };
  }
  const startedAt = Number(stamp?.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    // ★ 这里**不许**退回 mtime：那正好是"时间戳会骗人"的那条路。
    return { state: "invalid", file, reason: "build.json 里没有可用的 startedAt（不拿文件 mtime 顶）" };
  }
  const pid = Number(stamp?.pid);
  return {
    state: "ok",
    file,
    startedAt,
    iso: new Date(startedAt).toISOString(),
    local: isoLocal(startedAt),
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    buildId: typeof stamp?.buildId === "string" && stamp.buildId !== "" ? stamp.buildId : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ② 采集：git log（提交）+ git status（工作区）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 默认 git 执行器（可注入：夹具里换成假的，才能证明"读不到时真红"）。 */
export function runGit({ root, args }) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    // ★ 必须显式给 stdio：execFileSync 的 stderr **默认会漏到父进程**，
    //   "不是 git 仓库"的 `fatal:` 会混进报告正文（报告要能直接贴给人看）。
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 把 git 的失败翻译成人话（**不许**吞成空字符串，那会变成假绿）。 */
function describeGitError(error) {
  if (error === null || error === undefined) return "git 失败（没有错误对象）";
  if (error.code === "ENOENT") return "找不到 git（PATH 里没有）";
  const stderr = String(error.stderr ?? "").trim();
  const first = stderr.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  if (/not a git repository/i.test(first)) return `不是 git 仓库（${first.slice(0, 120)}）`;
  if (first !== "") return first.slice(0, 200);
  return String(error.message ?? error).split(/\r?\n/)[0].slice(0, 200);
}

const stripPrefix = (value, prefix) => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
const isWatched = (p) => WATCHED_DIRS.some((dir) => p === dir || p.startsWith(`${dir}/`));

function ensureFile(files, p) {
  let entry = files.get(p);
  if (entry === undefined) {
    entry = { path: p, commits: [], added: [], removed: [] };
    files.set(p, entry);
  }
  return entry;
}

/**
 * 解析 `git log --unified=0 -p` 的混合输出。
 *
 * 为什么用 `--pretty=format:` + 控制字符：一次调用同时拿到「提交元信息」和「逐文件 diff」，
 * 不必为每个文件再跑一次 `git diff`（本仓 17 个文件 × N 个提交会慢一个数量级）。
 */
function parseLog(text) {
  const commits = [];
  const files = new Map();
  let commit = null;
  let current = null;
  let oldPath = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("\u0001")) {
      const parts = line.slice(1).split("\u0002");
      commit = { hash: parts[0] ?? "", iso: parts[1] ?? "", subject: (parts[2] ?? "").trim() };
      commits.push(commit);
      current = null;
      continue;
    }
    // 路径只从 `---` / `+++` 行取：`diff --git a/x b/x` 在路径含空格时会被切错。
    if (line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? null : stripPrefix(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const next = line === "+++ /dev/null" ? oldPath : stripPrefix(line.slice(4), "b/");
      current = next !== null && next !== undefined && isWatched(next) ? ensureFile(files, next) : null;
      if (current !== null && commit !== null && !current.commits.includes(commit.hash)) current.commits.push(commit.hash);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return { commits, files: [...files.values()] };
}

/** 解析 `git status --porcelain=v1`。 */
function parseStatus(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2).trim() || "?";
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.slice(rest.lastIndexOf(" -> ") + 4);
    rest = rest.trim();
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (!isWatched(rest)) continue;
    out.push({ path: rest, code });
  }
  return out;
}

/**
 * 采集「时间点之后」的改动。
 *
 * 两种来源，**分开报**（混在一起就分不出"到底是不是在启动之后改的"）：
 *   · `commit`    —— `git log --since` 命中：有提交时刻，可判先后；
 *   · `workspace` —— 工作区未提交：git **不记录**工作区文件的修改时刻 ⇒ 时刻不可判（不是"没改动"）。
 *
 * @returns {{state:"ok", since:string, commits:Array, files:Array} | {state:"unavailable", reason:string}}
 */
export function collectChanges({ root, sinceMs, git = runGit } = {}) {
  if (typeof root !== "string" || root.trim() === "") return { state: "unavailable", reason: "没有仓库目录（--root 为空）" };
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return { state: "unavailable", reason: "没有可用的时间点（startedAt 缺失）" };
  const since = new Date(sinceMs).toISOString();

  let log;
  try {
    log = git({
      root,
      args: ["log", `--since=${since}`, "--unified=0", "--pretty=format:\u0001%H\u0002%cI\u0002%s", "-p", "--", ...WATCHED_DIRS],
    });
  } catch (error) {
    return { state: "unavailable", reason: describeGitError(error) };
  }

  let status;
  try {
    status = git({ root, args: ["status", "--porcelain=v1", "--untracked-files=all", "--", ...WATCHED_DIRS] });
  } catch (error) {
    return { state: "unavailable", reason: describeGitError(error) };
  }

  const parsed = parseLog(log ?? "");
  const files = parsed.files.map((entry) => ({ ...entry, source: "commit", timing: "after" }));
  for (const dirty of parseStatus(status ?? "")) {
    const existing = files.find((entry) => entry.path === dirty.path);
    if (existing !== undefined) {
      // 同一个文件既有提交又有未提交改动 ⇒ 记成"还有一版没落"（内容以工作区为准）
      existing.dirty = dirty.code;
      continue;
    }
    files.push({ path: dirty.path, commits: [], added: [], removed: [], source: "workspace", timing: "unknown", dirty: dirty.code });
  }
  return { state: "ok", since, sinceLocal: isoLocal(Date.parse(since)), commits: parsed.commits, files };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ③ 归类：按改动内容判「要哪一类真机证据」
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `src/**` 的判据表（顺序 = 具体度，先命中先算）。
 *
 * 每条 = 「diff 里出现了这个符号 ⇒ 这次改动动的是哪一层能力 ⇒ 用哪条只读审计证明它」。
 * 命令都经过真机跑通（退出码 0），不是猜的。
 */
const SRC_ROUTES = [
  {
    re: /REASONING_CONCLUSION|reasoningConclusion|思考摘录/,
    cls: "PROMPT",
    command: "node scripts/reasoning-share-audit.mjs",
    why: "摘要是拿 reasoning 喂的：剔掉后占比 / 重放覆盖率有没有变",
  },
  {
    re: /perMessageChars|单条消息/,
    cls: "PROMPT",
    command: "node scripts/message-size-audit.mjs",
    why: "单条消息上限切掉多少字符、切掉的到底是谁的",
  },
  {
    // `inputCutMessages` / `inputTruncated` 是 `collectMessages` 的返回字段 ⇒ 改的是**喂给模型的输入**。
    // ★ 加 pathRe：同一个符号在 `src/ui.mjs` 里是**计数器**（面板今日聚合），不是提示词 ——
    //   不按路径切开，两件事就会被归成同一类（那正是本仓反复踩的"混口径"）。
    re: /inputCutMessages|inputTruncated|输入被裁/,
    pathRe: /^src\/(?:rooms\/)?offline-fold\.mjs$/i,
    cls: "PROMPT",
    command: "node scripts/input-truncation-audit.mjs",
    why: "「输入被裁」有没有真的写进 foldMark（假「没截断」）",
  },
  {
    re: /summaryText|摘要正文|NO_BODY_PATHS/,
    cls: "WRITE_BACK",
    command: "node scripts/summary-text-coverage-audit.mjs",
    why: "按写回点统计摘要正文落没落（每条路径分开算）",
  },
  {
    re: /failuresRepaired|机械补回/,
    cls: "WRITE_BACK",
    command: "node scripts/repair-coverage-audit.mjs",
    why: "死路机械补回到底跑没跑过（0 次 = 没接线）",
  },
  {
    re: /restoreFromSnapshot|rollbackFloor|keepPersisted|回滚/,
    cls: "WRITE_BACK",
    command: "node scripts/dangling-audit.mjs",
    why: "回滚之后有没有新造悬空边（结构自洽 + 分类统计）",
  },
  {
    re: /todayAggregateFrom|truncatedUnknown|peakFolds|inputTruncated/,
    pathRe: /^src\/ui\.mjs$/i,
    cls: "DETECTOR",
    command: "node scripts/doctor.mjs",
    why: "面板今日聚合字段（doctor 与面板同源，重算一遍对数）",
  },
  {
    re: /sectionsMissing|describeStructure|段名/,
    cls: "DETECTOR",
    command: "node scripts/structure-audit.mjs",
    why: "段名判据（记录值 vs 正文事实）",
  },
];

/** 文档工具：跑它会**写文件**（changelog / 版本号 / 文档索引），所以只给一致性检查，不给裸跑。 */
const DOC_TOOL_RE = /^(?:add-changelog|changelog-index|sync-doc-numbers|docs-index-check|docs-numbers|release-notes-drift|handoff-check|release|release-lib)\.mjs$/;

/** 兜底命令：没命中任何判据时，至少把全量体检跑一遍（宁可多跑，也不许假装"不用验"）。 */
const FALLBACK_COMMAND = "node scripts/doctor.mjs";

/**
 * 给**一个文件**归类，并给出「重启后跑什么能验证它」。
 *
 * @param {{path:string, added?:string[], removed?:string[], canRun?:(path:string)=>boolean}} change
 * @returns {{classes:Array<{cls:string, why:string}>, commands:Array<{command:string, why:string}>}}
 */
export function classifyChange({ path: filePath, added = [], removed = [], canRun = () => false } = {}) {
  const p = String(filePath ?? "");
  const text = [p, ...added, ...removed].join("\n");
  const classes = [];
  const commands = [];
  const push = (cls, why) => {
    if (!classes.some((entry) => entry.cls === cls)) classes.push({ cls, why });
  };
  const pushCmd = (command, why) => {
    if (!commands.some((entry) => entry.command === command)) commands.push({ command, why });
  };

  if (isWatched(p) === false) return { classes, commands: [] };

  if (p.startsWith("scripts/")) {
    const base = nodePath.posix.basename(p);
    if (DOC_TOOL_RE.test(base)) {
      push(CHANGE_CLASSES.DOCS, "文档生成/校验脚本（只影响文档，不碰运行时）");
      pushCmd("node scripts/docs-index-check.mjs", "文档索引与命令表是否一致（只读）");
    } else if (canRun(p)) {
      push(CHANGE_CLASSES.DETECTOR, "诊断/审计脚本本身改了 ⇒ 判据变了，旧记录按新判据重算会变");
      pushCmd(`node ${p}`, "跑一次它自己的判据（只读）");
    } else {
      push(CHANGE_CLASSES.OTHER, "脚本改了但没有 CLI 入口（库文件）⇒ 从调用它的检查里看");
      pushCmd(FALLBACK_COMMAND, "全量体检兜底（它必然会走到这条路径）");
    }
    return { classes, commands };
  }

  // src/**：先看路径（提示词文件），再看 diff 内容（改了哪个符号）
  if (/prompt|facts/i.test(nodePath.posix.basename(p))) {
    push(CHANGE_CLASSES.PROMPT, "文件名就是提示词/事实块（模型看到的那段文本）");
    pushCmd("node scripts/deadend-adherence-audit.mjs", "提示词硬规则的遵守率（模型侧 / 机械补回分开算）");
  }
  for (const route of SRC_ROUTES) {
    // `pathRe` 可选的第二条判据：同一个符号在不同文件里语义不同时（输入口径 vs 计数器），靠它切开
    if (route.pathRe !== undefined && !route.pathRe.test(p)) continue;
    if (!route.re.test(text)) continue;
    push(CHANGE_CLASSES[route.cls], `diff 命中「${String(route.re).slice(1, -1).split("|")[0]}」`);
    pushCmd(route.command, route.why);
  }
  if (classes.length === 0) {
    push(CHANGE_CLASSES.OTHER, "没命中已知判据（改的可能是一般逻辑）");
    pushCmd(FALLBACK_COMMAND, "全量体检兜底：新代码有没有把它跑坏");
  }
  return { classes, commands };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ④ 组装报告
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 脚本能不能单独跑（有 CLI 入口才给 `node <脚本>`，否则建议的命令本身就是错的）。
 *
 * 只认「源码里读得到 `process.argv`」这一条静态判据 —— 本仓的 CLI 有两种形状：
 * `main()` + 守卫（`process.argv[1]`）和**顶层直接跑**（`doctor.mjs` 是 `process.argv.includes("--json")`），
 * 两种都必须算可跑，否则 doctor 会被误判成"库文件"、建议出一条错命令。
 * ⚠ 这是**静态**判据：真正跑不跑得起来由调用方（人/CI）执行时验，本脚本只保证「入口存在」。
 */
function canRunScript(root, p, readText) {
  try {
    return /process\.argv/.test(String(readText(nodePath.join(root, p))));
  } catch {
    return false;
  }
}

/**
 * 生成完整报告。
 *
 * ★ `diskBuildId` 的用处：`buildId` 是 `package.json` + `src/**\/*.mjs` 的内容哈希。
 *   两者相等 ⇒ **src 一个字节都没变** ⇒ 即使 git 说「有提交改过 src」（amend / cherry-pick /
 *   revert-revert 会把同一份内容重新提一次），也**不是**待验证改动。这条能消掉最常见的一类假阳性。
 *   ⚠ 它**不覆盖** `scripts/**`（脚本不在 buildId 里）—— 脚本侧的"新"只能靠 git 判。
 *
 * @param {{root?:string, home?:string, graphDir?:string, sinceMs?:number, git?:Function,
 *          diskBuildId?:string|null, readText?:(file:string)=>string, readFile?:(file:string)=>string}} [options]
 */
export function buildReport({
  root = ROOT,
  home = "",
  graphDir = "",
  sinceMs,
  git = runGit,
  diskBuildId = null,
  readText = (file) => nodeFs.readFileSync(file, "utf8"),
  readFile = (file) => nodeFs.readFileSync(file, "utf8"),
} = {}) {
  const dir = graphDir !== "" ? graphDir : home !== "" ? nodePath.join(home, "chess-context") : "";
  const startPoint = sinceMs === undefined ? readStartPoint({ dir, readFile }) : {
    state: "ok",
    file: null,
    startedAt: Number(sinceMs),
    iso: new Date(Number(sinceMs)).toISOString(),
    local: isoLocal(Number(sinceMs)),
    pid: null,
    buildId: null,
  };
  if (startPoint.state !== "ok") {
    return { state: "unknown", reason: startPoint.reason, startPoint, commits: [], files: [], byClass: {}, commands: [] };
  }

  const changes = collectChanges({ root, sinceMs: startPoint.startedAt, git });
  if (changes.state !== "ok") {
    return { state: "unknown", reason: changes.reason, startPoint, commits: [], files: [], byClass: {}, commands: [] };
  }

  // buildId 相等 ⇒ src/**/*.mjs 的内容与运行实例一致（这条只对 .mjs 成立）
  const buildIdProven =
    typeof diskBuildId === "string" && diskBuildId !== "" && typeof startPoint.buildId === "string" && startPoint.buildId !== "" && diskBuildId === startPoint.buildId;

  const files = [];
  const dropped = [];
  for (const change of changes.files) {
    if (buildIdProven && /^src\/.*\.mjs$/i.test(change.path) && change.source === "commit" && change.dirty === undefined) {
      dropped.push(change.path);
      continue;
    }
    const classified = classifyChange({ path: change.path, added: change.added, removed: change.removed, canRun: (p) => canRunScript(root, p, readText) });
    files.push({
      path: change.path,
      source: change.source,
      timing: change.timing,
      commits: change.commits,
      dirty: change.dirty ?? null,
      classes: classified.classes,
      commands: classified.commands,
    });
  }

  const byClass = {};
  const commands = [];
  for (const file of files) {
    for (const entry of file.classes) byClass[entry.cls] = (byClass[entry.cls] ?? 0) + 1;
    for (const entry of file.commands) if (!commands.some((c) => c.command === entry.command)) commands.push(entry);
  }

  return {
    state: "ok",
    startPoint,
    since: changes.since,
    commits: changes.commits,
    files,
    byClass,
    commands,
    buildIdProven,
    dropped,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑤ 渲染
 * ──────────────────────────────────────────────────────────────────────────── */

/** 需要真机证据的那几类（改文档不需要：跑一致性检查就够了）。 */
const NEEDS_EVIDENCE = new Set([CHANGE_CLASSES.PROMPT, CHANGE_CLASSES.WRITE_BACK, CHANGE_CLASSES.DETECTOR, CHANGE_CLASSES.OTHER]);

/** 一句话总结（checkup 那一段的第一行）。 */
export function summarize(report) {
  if (report.state !== "ok") return `无法判断：${report.reason}`;
  if (report.files.length === 0) return "无待验证改动";
  const counts = Object.entries(report.byClass)
    .map(([cls, n]) => `${cls} ${n}`)
    .join(" · ");
  // ⚠ 类计数**按文件算**、一个文件可命中多类 ⇒ 之和 ≥ 文件数，写明免得被读成"文件数算错了"
  return `时间点 = build.json.startedAt（${report.startPoint.local ?? report.startPoint.iso}）之后 ${report.commits.length} 个提交 / ${report.files.length} 个文件（${counts}；一个文件可多类）`;
}

/**
 * 多行段落（`checkup.mjs` 用这一段）。
 * @returns {string} 单行 = 总结；有改动时后面跟逐文件归类 + 复验命令
 */
export function formatSection(report) {
  if (report.state !== "ok") {
    // ★ 这里**不许**输出"无改动"：读不到 git / build.json 时只能说"判不了"。
    return `无法判断：${report.reason} —— 这不是「没有改动」，是**判不了**`;
  }
  if (report.files.length === 0) return "无待验证改动";

  const lines = [summarize(report)];
  const need = report.files.filter((file) => file.classes.some((entry) => NEEDS_EVIDENCE.has(entry.cls)));
  const docsOnly = report.files.filter((file) => !file.classes.some((entry) => NEEDS_EVIDENCE.has(entry.cls)));

  if (need.length === 0) {
    lines.push("      需要真机证据：无（这一批只动了文档）");
  } else {
    lines.push("      需要真机证据（重启 DSH 后再跑，跑不了就是**没验证**）：");
    for (const file of need) {
      const cls = file.classes.map((entry) => entry.cls).join(" + ");
      const why = file.classes.map((entry) => entry.why).join("；");
      const where = file.source === "workspace" ? "（工作区未提交，时刻不可判）" : `（${file.commits.length} 个提交）`;
      lines.push(`        · ${cls} · ${file.path}${where}`);
      lines.push(`            依据：${why}`);
      for (const entry of file.commands) lines.push(`            ${entry.command}    # ${entry.why}`);
    }
  }
  if (docsOnly.length > 0) {
    lines.push(`      不需要真机证据：${docsOnly.map((file) => file.path).join("、")}`);
  } else {
    lines.push("      不需要真机证据：无");
  }
  return lines.join("\n");
}

/** CLI 正文（人读）。 */
export function formatReport(report) {
  if (report.state !== "ok") {
    return [
      "== 待验证改动 ==",
      `  ✗ 无法判断：${report.reason}`,
      "  ⇒ 这不是「没有改动」—— 判据拿不到输入时**必须**说不知道（假绿比红更贵）。",
    ].join("\n");
  }
  if (report.files.length === 0) {
    return ["== 待验证改动 ==", `  ✓ 无待验证改动（时间点 ${report.startPoint.local ?? report.startPoint.iso} 之后 src/ 与 scripts/ 都没有提交）`].join("\n");
  }
  const lines = ["== 待验证改动 ==", `  时间点：build.json.startedAt = ${report.startPoint.local ?? report.startPoint.iso}（UTC ${report.startPoint.iso}）`];
  if (report.startPoint.pid !== null) lines.push(`  写戳进程：pid ${report.startPoint.pid} · build ${report.startPoint.buildId ?? "?"}`);
  lines.push(`  之后有 ${report.commits.length} 个提交、${report.files.length} 个文件改动：`);
  for (const commit of report.commits) lines.push(`    ${commit.hash.slice(0, 7)}  ${commit.iso}  ${commit.subject}`);
  lines.push("");
  for (const file of report.files) {
    const cls = file.classes.map((entry) => entry.cls).join(" + ") || "未归类";
    const where = file.source === "workspace" ? "工作区未提交（时刻不可判）" : `${file.commits.map((hash) => hash.slice(0, 7)).join(" ")}`;
    lines.push(`  · ${cls} · ${file.path}`);
    lines.push(`      来源：${where}`);
    for (const entry of file.classes) lines.push(`      依据：${entry.why}`);
    for (const entry of file.commands) lines.push(`      验证：${entry.command}    # ${entry.why}`);
  }
  if (report.buildIdProven === true) {
    lines.push("");
    lines.push(`  （buildId 与磁盘一致 ⇒ 这些 src 改动的内容其实已经生效，只是历史被重写过；已从待验证里剔除 ${report.dropped.length} 个）`);
  }
  lines.push("");
  lines.push("  ⇒ **重启 DSH 后**把上面「验证」的每条命令各跑一次；跑出来的数字才是这一批改动的证据。");
  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑥ 给 checkup 用的便捷入口
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一条命令拿段落（`scripts/checkup.mjs` 在「运行实例版本」下面插这一段）。
 * @returns {{state:"ok"|"unknown", text:string, report:object}}
 */
export function pendingSection({ home = "", graphDir = "", root = ROOT, sinceMs, git = runGit, diskBuildId = null, readText, readFile } = {}) {
  const report = buildReport({
    root,
    home,
    graphDir,
    sinceMs,
    git,
    diskBuildId: diskBuildId ?? safeDiskBuildId(),
    ...(readText === undefined ? {} : { readText }),
    ...(readFile === undefined ? {} : { readFile }),
  });
  return { state: report.state, text: formatSection(report), report };
}

/** 磁盘 buildId（失败不许抛：诊断设施不能拖垮体检）。 */
function safeDiskBuildId() {
  try {
    return repoBuildId(ROOT);
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑦ CLI
 * ──────────────────────────────────────────────────────────────────────────── */

function defaultHome() {
  if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "") return process.env.DSH_HOME;
  const profile = process.env.USERPROFILE ?? "";
  return nodePath.join(nodePath.dirname(nodePath.dirname(profile)), "DeepSeek Harness", "home");
}

function parseArgs(argv) {
  const out = { json: false, sinceMs: undefined, home: defaultHome(), root: ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      index += 1;
      return argv[index] ?? "";
    };
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--since")) {
      const raw = takeValue();
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      out.sinceMs = Number.isFinite(ms) && ms > 0 ? ms : undefined;
      out.sinceRaw = raw;
    } else if (arg.startsWith("--home")) out.home = takeValue();
    else if (arg.startsWith("--root")) out.root = takeValue();
  }
  return out;
}

const USAGE = [
  "用法：node scripts/pending-changes.mjs [--json] [--since=<ISO|毫秒>] [--home=<dir>] [--root=<dir>]",
  "  时间点默认取 <home>/chess-context/build.json 的 startedAt（不取文件 mtime）。",
  "  退出码：0 = 无待验证改动；1 = 有待验证改动；2 = 无法判断（不是「没有改动」）。",
].join(String.fromCharCode(10));

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help === true) {
    console.log(USAGE);
    return 0;
  }
  let report;
  try {
    report = buildReport({ root: options.root, home: options.home, sinceMs: options.sinceMs, diskBuildId: safeDiskBuildId() });
  } catch (error) {
    report = { state: "unknown", reason: String(error?.message ?? error), startPoint: null, commits: [], files: [], byClass: {}, commands: [] };
  }
  if (options.json === true) {
    console.log(JSON.stringify({ ...report, summary: summarize(report) }, null, 2));
  } else {
    console.log(formatReport(report));
  }
  if (report.state !== "ok") return 2;
  return report.files.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
