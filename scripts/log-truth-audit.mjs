#!/usr/bin/env node
/**
 * log-truth-audit.mjs —— 「这行日志说的是真的吗」只读审计（C614 / T36）
 *
 * ## 为什么要有它
 *
 * 补账定时器每轮（10 分钟）都打一行：
 *
 *     chess-context: 自动补账避开 0 个刚补过的会话（冷却 45 分钟）
 *
 * 而 `src/engine.mjs` 里这句的**条件**是
 *
 *     const pickPool = ... ? notCooling : withLog;
 *     if (pickPool !== withLog) { info(`… 避开 ${withLog.length - pickPool.length} 个 …`) }
 *
 * `withLog` / `notCooling` 都是 `filter()` 出来的**新数组**，`pickPool` 就是其中之一
 * ⇒ 只要走到「过滤分支」，`pickPool !== withLog` 就**恒真**（两个不同的数组对象）。
 * 于是一个都没冷却（`notCooling.length === withLog.length`）时也照打，数字是
 * `withLog.length - pickPool.length = 0` —— 读日志的人无法用「0」判断冷却到底工作过没有。
 * 这就是「日志说的不是真的」：**这行出现 ≠ 有会话被避开**。
 *
 * 本脚本做三件事，全部只读（真实 home 只 stat / 读，不写）：
 *
 *   ① **真实日志采样**：在已知的宿主日志落点里数这行出现几次、括号里的数字分布。
 *      本机实测：**这行没有落盘**（宿主只在控制台 / GUI 面板打，`<home>` 下只有
 *      `sessions/**` 的 zstd 会话日志和几个插件的私有 log）。所以数字分布
 *      **必须靠 ② 用真代码复现**，不能靠猜。
 *   ② **真代码复现**：复用 `test/engine-harness.test.mjs` 的假 DSH 起 `Engine`，
 *      用「有日志、无事件」的夹具（`#offlineCloseoutFold` 走 `empty-log` 快路径，
 *      不调模型、不花钱），把冷却档位摆成 0 个 / 2 个 / 全冷却 三档，抓**真 logger 输出**。
 *      这样「修前 / 修后」是同一场景下的两行原文，可以直接对拍。
 *   ③ **全库同类扫描**：`src/**` 里所有 `if (A !== B)` / `if (A === B)`，把两侧
 *      追溯到「新数组 / 新对象」的构造点（`filter` / `map` / `slice` / `concat` /
 *      `Array.from` / 字面量 …，**含一层 `const` 别名与三元分支**）——
 *      两侧都是新引用 ⇒ 恒真（`!==`）或恒假（`===`）。另带三条同源规则：
 *      `X.length >= 0` / `> -1`（恒真）、`|| true` / `&& false` / `if (true)`、
 *      `x !== x`（自比较）。
 *
 * ## 为什么不用 AST
 *
 * 仓库零依赖（`package.json` 没有 `dependencies`），审计脚本必须能直接 `node` 跑。
 * 这里用「先剥字符串/注释、再做括号配平 + 一层别名解析」的轻量扫描：它比正则准
 * （注释里的旧代码不会假红，字符串里的 `!==` 不会假红），又不需要装 acorn。
 * **误报豁免写在 `EXEMPT` 里**（逐条写理由），和 `boundary-audit.mjs` 同一套纪律。
 *
 * ## 用法
 *
 *   node scripts/log-truth-audit.mjs           # 人读
 *   node scripts/log-truth-audit.mjs --json    # 机读
 *
 * 退出码：0 = 没有残留的恒真/恒假判断，且复现场景的日志与期望一致；1 = 有（可修的）问题。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

/** 被审计的那行日志的定位串（唯一真源：改文案要同时改这里与测试）。 */
const TARGET_NEEDLE = "自动补账避开";
/** 从日志行里抠数字：`… 避开 12 个 …` ⇒ 12。 */
const TARGET_NUMBER = /自动补账避开\s+(\d+)\s+个/;

const problems = [];
const notes = [];
const report = { logFiles: [], occurrences: [], distribution: {}, scenarios: [], staticHits: [], staticScanned: 0 };
const say = (text = "") => {
  if (!asJson) console.log(text);
};

/* ══════════════════════════ ① 真实日志采样 ══════════════════════════ */

/**
 * 宿主日志的可能落点（**只读**）。
 *
 * 为什么是这张表而不是全盘 `find`：本机 `<workspace> Harness` 有 33 GB（含 776 份会话
 * zstd），全盘扫一次要好几分钟，而日志落点是**有限枚举**的。表里没有的路径就是没有 ——
 * 找不到就明说「没落盘」，不拿会话日志里的**对话引用**冒充日志（那才是真的假证据：
 * 任务书本身就把这行贴进了对话）。
 *
 * @returns {string[]} 真实存在的日志文件（去重、按 mtime 降序）
 */
function candidateLogFiles() {
  const homes = new Set();
  const add = (p) => {
    if (typeof p === "string" && p !== "") homes.add(p);
  };
  add(process.env.DSH_HOME);
  add(path.join(os.homedir(), ".dsh"));
  for (const p of [
    path.join(os.homedir(), "AppData", "Roaming", "@deepseek-ai", "dsh-desktop", "logs"),
    path.join(os.homedir(), "AppData", "Local", "dsh-desktop", "logs"),
  ]) {
    homes.add(p);
  }
  const files = [];
  const pushFile = (p) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 不存在就是没有 */
    }
  };
  const pushDir = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) continue; // 只认一层：插件的私有 log 都在这一层
      if (entry.name.endsWith(".log")) pushFile(p);
    }
  };
  for (const home of homes) {
    pushFile(path.join(home, "app.log"));
    pushDir(path.join(home, "logs"));
  }
  // 去重（同一个文件可能被 DSH_HOME 与 ~/.dsh 命中两次）
  const seen = new Set();
  return files
    .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 数一行日志在日志文件里的出现次数与数字分布。
 *
 * @param {Array<{path:string}>} files
 * @returns {{path:string, count:number, numbers:number[]}[]}
 */
function scanLogFiles(files) {
  const out = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file.path, "utf8");
    } catch {
      continue; // 读不到（占用 / 权限）不算命中，但要在报告里留一行
    }
    const numbers = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(TARGET_NEEDLE)) continue;
      const m = TARGET_NUMBER.exec(line);
      numbers.push(m === null ? NaN : Number(m[1]));
    }
    out.push({ path: file.path, count: numbers.length, numbers });
  }
  return out;
}

function distributionOf(numbers) {
  const dist = {};
  for (const n of numbers) {
    const key = Number.isFinite(n) ? String(n) : "unparsed";
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

/* ══════════════════════════ ③ 全库同类扫描 ══════════════════════════ */

/**
 * 逐条误报豁免（**每条都要写理由**；空理由 = 不许加）。
 *
 * 键 = `file` + 命中表达式片段。用**代码形状**而不是行号，避免改一行就漂移。
 * 当前为空：扫描器还没有误报，先别预置「我觉得它没事」的条目 —— 那种条目会让
 * 真问题在下一次改动里静默消失。
 *
 * @type {Array<{file:string, shape:string, why:string}>}
 */
const EXEMPT = [];

/** 会产生**新数组/新对象**的调用（引用比较恒真/恒假的来源）。 */
const FRESH_CALL = /\.(?:filter|map|slice|concat|flatMap|flat|sort|reverse|splice|split|keys|values|entries)\s*\(|Array\.from\s*\(|Object\.(?:keys|values|entries)\s*\(/;
/** 表达式尾部一旦是这些，返回值就不是数组/对象（`.length` 是 number、`.join` 是 string …）。 */
const PRIMITIVE_TAIL = /\.(?:length|trim|join|includes|indexOf|lastIndexOf|startsWith|endsWith|toString|valueOf|count|size)\s*(?:\([^()]*\))?\s*$/;

/**
 * 把字符串字面量、模板字面量、注释全部抹成空格（**保留偏移与换行**）。
 *
 * 为什么必须做：本仓库的注释里大量引用「旧代码曾经这么写」，不剥注释就会天天
 * 假红（`boundary-audit.mjs` 第 2 轮被噪声坑过一次，同一个坑不踩第二次）。
 *
 * @param {string} src
 * @returns {string} 与 src 等长的「只剩代码」文本
 */
export function stripNonCode(src) {
  const out = src.split("");
  const blank = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  const stack = [{ type: "code" }];
  let i = 0;
  while (i < src.length) {
    const ctx = stack[stack.length - 1];
    const c = src[i];
    if (ctx.type === "template") {
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i);
        i += 1;
        stack.pop();
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(i);
        blank(i + 1);
        i += 2;
        stack.push({ type: "expr", depth: 1 });
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    // code / expr
    if (c === "/" && src[i + 1] === "/") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < src.length && src[i] !== "\n") {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        blank(i);
        i += 1;
      }
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      blank(i);
      i += 1;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        blank(i);
        i += 1;
        if (d === quote) break;
      }
      continue;
    }
    if (c === "`") {
      blank(i);
      i += 1;
      stack.push({ type: "template" });
      continue;
    }
    if (ctx.type === "expr") {
      if (c === "{") {
        ctx.depth += 1;
        i += 1;
        continue;
      }
      if (c === "}") {
        ctx.depth -= 1;
        blank(i);
        i += 1;
        if (ctx.depth === 0) stack.pop();
        continue;
      }
    }
    i += 1;
  }
  return out.join("");
}

/** 找 `if (` / `while (` 的条件区间（在**已剥字符串**的代码里配平括号）。 */
function conditionRanges(code) {
  const ranges = [];
  const re = /\b(?:if|while)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < code.length; i += 1) {
      const c = code[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close > open) ranges.push({ keyword: m[0].trim().replace(/\s*\($/, ""), start: open + 1, end: close });
  }
  return ranges;
}

/** 在**顶层**（括号/方括号/花括号深度 0）找第一个比较运算符。 */
function topLevelComparison(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0) {
      for (const op of ["!==", "===", "!=", "=="]) {
        if (expr.startsWith(op, i)) return { op, at: i };
      }
    }
  }
  return null;
}

/** 顶层三元：返回 `{ q, colon }`（没有就 null）。 */
function topLevelTernary(expr) {
  let depth = 0;
  let q = -1;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === "?" && q < 0) q = i;
    else if (depth === 0 && c === ":" && q >= 0) return { q, colon: i };
  }
  return null;
}

/** 去掉最外层多余括号（配平才去）。 */
function unwrapParens(expr) {
  let e = expr.trim();
  for (;;) {
    if (!e.startsWith("(") || !e.endsWith(")")) return e;
    let depth = 0;
    let ok = true;
    for (let i = 0; i < e.length - 1; i += 1) {
      const c = e[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) return e;
    e = e.slice(1, -1).trim();
  }
}

/**
 * 「这个表达式求值出来是不是**新数组/新对象**」——带推导链的版本。
 *
 * 只做一层 `const` 别名 + 三元分支解析（深到 6 层就放弃，返回 false —— 宁可漏报
 * 也不制造没有证据的红）。`trail` 里留下「谁 ← 什么」，这就是这条命中**独立的证据**：
 * 读的人不用信我，照着链子自己看那两个 `filter()` 是不是各建了一个数组。
 *
 * @param {string} expr 已剥字符串的表达式
 * @param {Map<string,string>} inits `const/let/var` 名字 → 初始化表达式（已剥字符串）
 * @param {string[]} [trail]
 * @param {number} [depth]
 * @returns {{fresh:boolean, trail:string[]}}
 */
export function explainFresh(expr, inits, trail = [], depth = 0) {
  const short = (text) => (text.length > 96 ? `${text.slice(0, 93)}…` : text);
  if (depth > 6) return { fresh: false, trail };
  const e = unwrapParens(expr);
  if (e === "") return { fresh: false, trail };
  const ternary = topLevelTernary(e);
  if (ternary !== null) {
    // 两个分支都是新引用 ⇒ 整体是新引用（`cond ? a.filter() : b.map()`）
    const left = e.slice(ternary.q + 1, ternary.colon);
    const right = e.slice(ternary.colon + 1);
    trail.push(`三元：\`${short(left.trim())}\` / \`${short(right.trim())}\` 两个分支都要看`);
    const a = explainFresh(left, inits, trail, depth + 1);
    const b = explainFresh(right, inits, trail, depth + 1);
    return { fresh: a.fresh && b.fresh, trail };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const init = inits.get(e);
    if (init === undefined) {
      trail.push(`\`${e}\` → 找不到初始化（当外部值，不算新引用）`);
      return { fresh: false, trail };
    }
    trail.push(`\`${e}\` ← \`${short(init)}\``);
    return explainFresh(init, inits, trail, depth + 1);
  }
  // 字面量：`[...]` / `{...}` 一定是新引用
  if (e.startsWith("[") || e.startsWith("{")) {
    trail.push(`\`${short(e)}\` → 字面量（每次求值都新建）`);
    return { fresh: true, trail };
  }
  // 调用：必须是「返回数组/对象」的那几个，且尾部没有被 `.length` / `.join()` 之类改型
  if (FRESH_CALL.test(e) && !PRIMITIVE_TAIL.test(e)) {
    trail.push(`\`${short(e)}\` → 每次求值都返回**新**数组/对象`);
    return { fresh: true, trail };
  }
  return { fresh: false, trail };
}

/** `explainFresh` 的布尔薄壳（给规则判据复用）。 */
export function isFreshReference(expr, inits) {
  return explainFresh(expr, inits).fresh;
}

/** 收集 `const/let/var name = <expr>;` 的初始化表达式（已剥字符串）。 */
function collectInitializers(code) {
  const inits = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const from = m.index + m[0].length;
    let depth = 0;
    let end = code.length;
    for (let i = from; i < code.length; i += 1) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") depth -= 1;
      else if (depth === 0 && c === ";") {
        end = i;
        break;
      } else if (depth === 0 && c === "\n") {
        // 没有分号时按「下一行能不能接上」判：`.filter(…)` 换行接续 / `? :` 换行接续都算同一条
        let j = i + 1;
        while (j < code.length && /\s/.test(code[j])) j += 1;
        const next = code[j] ?? "";
        const continued = /[.?+:,[(*&|]/.test(next) || /[.?:,+&|]\s*$/.test(code.slice(from, i));
        if (!continued) {
          end = i;
          break;
        }
      }
    }
    const init = code.slice(from, end).trim();
    if (init !== "" && !inits.has(m[1])) inits.set(m[1], init);
  }
  return inits;
}

/** 同一行里再找几条「同源恒真」形状（不做数据流，只认字面形状）。 */
function literalRules(line) {
  const hits = [];
  if (/\|\|\s*true\b/.test(line)) hits.push({ rule: "literal-true", why: "`|| true` 恒真" });
  if (/&&\s*false\b/.test(line)) hits.push({ rule: "literal-false", why: "`&& false` 恒假" });
  if (/\bif\s*\(\s*true\s*\)/.test(line)) hits.push({ rule: "literal-true", why: "`if (true)` 恒真" });
  if (/\bif\s*\(\s*false\s*\)/.test(line)) hits.push({ rule: "literal-false", why: "`if (false)` 恒假" });
  if (/\.length\s*>=\s*0\b/.test(line)) hits.push({ rule: "length-nonneg", why: "`length >= 0` 恒真" });
  if (/\.length\s*>\s*-1\b/.test(line)) hits.push({ rule: "length-nonneg", why: "`length > -1` 恒真" });
  // 自比较必须**两边都是同一个裸标识符**：`last.text !== text` 这种属性访问不是自比较
  //（第一版用 `\b` 收尾，把 `prev.source !== source` 全判成了恒真 —— 7 条假红就是这么来的）
  const self = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(!==|===)\s*\1(?![\w$])/.exec(line);
  if (self !== null) hits.push({ rule: "self-compare", why: `\`${self[1]} ${self[2]} ${self[1]}\` 自比较恒${self[2] === "!==" ? "真" : "假"}` });
  return hits;
}

/**
 * 扫一份源码，返回所有「恒真/恒假」形状的命中。
 *
 * @param {string} file 绝对路径
 * @param {string} src
 * @returns {Array<{file:string, line:number, rule:string, why:string, snippet:string, operands?:[string,string]}>}
 */
export function scanSource(file, src) {
  const code = stripNonCode(src);
  const inits = collectInitializers(code);
  const hits = [];
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lineOf = (index) => src.slice(0, index).split("\n").length;

  for (const range of conditionRanges(code)) {
    const condition = code.slice(range.start, range.end);
    const comparison = topLevelComparison(condition);
    if (comparison !== null) {
      const left = condition.slice(0, comparison.at).trim();
      const right = condition.slice(comparison.at + comparison.op.length).trim();
      const leftScan = explainFresh(left, inits);
      const rightScan = explainFresh(right, inits);
      if (leftScan.fresh && rightScan.fresh) {
        hits.push({
          file: rel,
          line: lineOf(range.start),
          rule: "fresh-identity",
          why:
            comparison.op === "!=="
              ? "两侧都是新数组/新对象 ⇒ 引用永不相等 ⇒ 恒真"
              : "两侧都是新数组/新对象 ⇒ 引用永不相等 ⇒ 恒假（分支永远进不去）",
          snippet: `${range.keyword} (${condition.trim()})`,
          operands: [left, right],
          trail: [...leftScan.trail, "—", ...rightScan.trail],
        });
      }
    }
  }
  // 逐行找同源形状
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const hit of literalRules(lines[i])) {
      hits.push({
        file: rel,
        line: i + 1,
        rule: hit.rule,
        why: hit.why,
        snippet: src.split("\n")[i].trim().slice(0, 200),
      });
    }
  }
  return hits;
}

/** 扫 `src/**`（跳过点开头的临时副本与 stub 目录）。 */
function scanRepo() {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  const hits = [];
  for (const file of files.sort()) hits.push(...scanSource(file, fs.readFileSync(file, "utf8")));
  return { files: files.length, hits };
}

/* ══════════════════════════ ② 真代码复现 ══════════════════════════ */

/** 复现场景：同一个夹具，只改「冷却里有几个会话」。 */
const SCENARIOS = [
  { name: "A 冷却 0 个", cooling: 0, expectAvoided: 0 },
  { name: "B 冷却 2 个", cooling: 2, expectAvoided: 2 },
  { name: "C 全冷却（12 个，回退完整列表）", cooling: 12, expectAvoided: 0 },
];

/** 夹具会话数：>10 ⇒ `dueNow > 10` ⇒ 每轮 `max = 3`（走的是真机同一条分档）。 */
const FIXTURE_SESSIONS = 12;

/**
 * 造一个「有欠账、日志为空」的 home。
 *
 * 日志**空文件**是刻意的：`#offlineCloseoutFold` 读到 `events.length === 0` 立刻
 * 返回 `stopped: "empty-log"` —— 这样这一轮**不调模型、不花钱、毫秒级结束**，
 * 而「避开 N 个」那行日志在**进循环之前**就打完了（正是我们要测的那一行）。
 *
 * @param {string} home
 * @returns {string[]} 会话 id
 */
function buildFixture(home) {
  const graphDir = path.join(home, "chess-context");
  const sessionsDir = path.join(graphDir, "sessions");
  const logRoot = path.join(home, "sessions", "--ws--");
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < FIXTURE_SESSIONS; i += 1) {
    const id = `log-truth-${String(i).padStart(2, "0")}`;
    ids.push(id);
    const gdir = path.join(sessionsDir, id);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(
      path.join(gdir, "graph.json"),
      JSON.stringify({
        version: 1,
        rootUserNodeIds: ["n1"],
        nodes: {
          n1: { id: "n1", kind: "user", seq: 1, text: "把构建跑通", constraints: [], ts: now },
          n2: { id: "n2", kind: "agent", seq: 200, text: "末", ts: now },
        },
        edges: {},
        order: ["n1", "n2"],
        // 没有 foldMark ⇒ tail = 200 ⇒ due（> closeoutMinEvents）
        foldMarks: [],
        updatedAt: now,
      }),
      "utf8",
    );
    const logDir = path.join(logRoot, `session-${id}`);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "session.v4.jsonl.zstd");
    fs.writeFileSync(logFile, Buffer.alloc(0));
    // 做旧 10 分钟：tick 会跳过「5 分钟内还在写」的活会话
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(logFile, old, old);
  }
  return ids;
}

/** 清掉 harness 落在 `src/` 的临时副本（与 `test/run.mjs` 收尾同一套动作）。 */
function cleanHarnessArtifacts() {
  const srcDir = path.join(ROOT, "src");
  try {
    for (const name of fs.readdirSync(srcDir)) {
      if (name.startsWith(".engine-under-test") && name.endsWith(".mjs")) fs.rmSync(path.join(srcDir, name), { force: true });
    }
    fs.rmSync(path.join(srcDir, ".harness-stubs"), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "test", ".harness"), { recursive: true, force: true });
  } catch {
    /* 清不掉不影响结论（下次 run.mjs 也会清） */
  }
}

/**
 * 用**当前源码**跑三档冷却，抓真 logger 输出。
 *
 * @returns {Promise<Array<{name:string, cooling:number, expectAvoided:number, line:string|null, avoided:number|null, ok:boolean}>>}
 */
async function reproduceScenarios() {
  const harness = await import(pathToFileURL(path.join(ROOT, "test", "engine-harness.test.mjs")).href);
  const { Engine } = await harness.load();
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "log-truth-"));
      try {
        const ids = buildFixture(home);
        const ctx = harness.makeCtx();
        const lines = [];
        ctx.logger.info = (message) => lines.push(String(message));
        const engine = new Engine(ctx, { graphDir: path.join(home, "chess-context"), auto: false, closeoutMinEvents: 10 });
        // 冷却 = 预置 `_backfillLastPicked`（生产里由上一轮 `.set(id, Date.now())` 写入）
        engine._backfillLastPicked = new Map(ids.slice(0, scenario.cooling).map((id) => [id, Date.now()]));
        await engine.runAutoBackfillOnce();
        const line = lines.find((row) => row.includes(TARGET_NEEDLE)) ?? null;
        const m = line === null ? null : TARGET_NUMBER.exec(line);
        const avoided = m === null ? (line === null ? null : NaN) : Number(m[1]);
        results.push({
          name: scenario.name,
          cooling: scenario.cooling,
          expectAvoided: scenario.expectAvoided,
          line,
          avoided,
          ok: scenario.expectAvoided > 0 ? avoided === scenario.expectAvoided : line === null,
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  } finally {
    cleanHarnessArtifacts();
  }
  return results;
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main() {
  /* ① 真实日志采样 */
  const files = candidateLogFiles();
  report.logFiles = files.map((f) => ({ path: f.path, size: f.size }));
  report.occurrences = scanLogFiles(files);
  const allNumbers = report.occurrences.flatMap((o) => o.numbers);
  report.distribution = distributionOf(allNumbers);

  /* ② 真代码复现 */
  report.scenarios = await reproduceScenarios();

  /* ③ 全库同类扫描 */
  const staticScan = scanRepo();
  report.staticScanned = staticScan.files;
  report.staticHits = staticScan.hits.filter((hit) => {
    const exempt = EXEMPT.find((e) => e.file === hit.file && (hit.snippet ?? "").includes(e.shape));
    if (exempt !== undefined) {
      notes.push(`豁免 ${hit.file}:${hit.line} —— ${exempt.why}`);
      return false;
    }
    return true;
  });

  /* 判定 */
  for (const scenario of report.scenarios) {
    if (!scenario.ok) {
      problems.push(
        `复现场景「${scenario.name}」：期望${scenario.expectAvoided > 0 ? `写「避开 ${scenario.expectAvoided} 个」` : "不写日志"}，实际 ${scenario.line === null ? "没写" : `「${scenario.line}」`}`,
      );
    }
  }
  for (const hit of report.staticHits) {
    problems.push(`恒真/恒假判断 ${hit.file}:${hit.line} —— ${hit.why}：${hit.snippet}`);
  }

  /* 输出 */
  say("== ① 真实日志里的「自动补账避开 N 个」==");
  if (files.length === 0) {
    say("  没有找到任何宿主日志文件（app.log / logs/*.log 都不存在）。");
    say("  ⇒ 这行只打在控制台 / GUI 面板，未落盘；数字分布改用 ② 的真代码复现来测。");
  } else {
    say(`  扫描 ${files.length} 个日志文件：`);
    for (const file of files) say(`    · ${file.path}（${file.size} B）`);
    const total = allNumbers.length;
    say(`  命中 ${total} 次；数字分布：${total === 0 ? "（无）" : JSON.stringify(report.distribution)}`);
    if (total === 0) say("  ⇒ 这行未落盘；数字分布改用 ② 的真代码复现来测。");
  }
  say("");
  say("== ② 真代码复现（同一夹具，只改冷却档位）==");
  for (const scenario of report.scenarios) {
    say(`  ${scenario.name}（期望避开 ${scenario.expectAvoided} 个）`);
    say(`    实际日志：${scenario.line === null ? "（不写）" : scenario.line}`);
    say(`    判定：${scenario.ok ? "✓ 与期望一致" : "✗ 与期望不符"}`);
  }
  const observed = report.scenarios.filter((s) => s.line !== null).map((s) => s.avoided);
  say(`  实际数字分布：${observed.length === 0 ? "（无日志）" : JSON.stringify(distributionOf(observed))}`);
  say("");
  say(`== ③ 全库同类扫描（src/**，${report.staticScanned} 个文件）==`);
  if (report.staticHits.length === 0) {
    say("  没有残留的恒真/恒假判断。");
  } else {
    for (const hit of report.staticHits) {
      say(`  ✗ ${hit.file}:${hit.line}  [${hit.rule}] ${hit.why}`);
      say(`      源码：${hit.snippet}`);
      if (hit.operands !== undefined) say(`      两侧：\`${hit.operands[0]}\` vs \`${hit.operands[1]}\``);
      for (const step of hit.trail ?? []) say(`      · ${step}`);
    }
  }
  for (const note of notes) say(`  · ${note}`);
  say("");
  say(problems.length === 0 ? "== 结论：日志与代码一致（0 个恒真判断）==" : `== 结论：${problems.length} 个问题 ==`);
  for (const problem of problems) say(`  ✗ ${problem}`);
  if (asJson) console.log(JSON.stringify({ ...report, problems, notes }, null, 2));
  return problems.length === 0 ? 0 : 1;
}

/**
 * 只有「直接跑」才执行审计；被 `import` 时只导出扫描器。
 *
 * 为什么要这个守卫：`test/log-truth.test.mjs` 要拿 `scanSource` 当静态守卫（旧写法必须报红），
 * 若 import 就 `process.exitCode = 1`，测试进程会被审计结论带跑偏。
 */
const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`✗ 审计脚本自身失败：${String(error?.stack ?? error)}`);
      cleanHarnessArtifacts();
      process.exitCode = 2;
    });
}
