/**
 * query-recall.mjs —— 「代码锚点按需召回」纯函数模块（Q1-core）
 *
 * 问题：用户当前这句话里明确点名了某个文件或某个代码符号，但那段历史已经折进摘要/旧 checkpoint，
 * 模型手里只剩「改过接口」这种话 —— 它知道做过什么，却不知道**是哪个文件、哪个符号**。
 * 这些锚点本来就在图边的 `action` / `errorSnippet` / `verify.summary` 里，不需要调用模型、
 * 不需要读盘、也不需要新的常驻缓存：机械匹配就能把**已有证据**重新推到模型眼前。
 *
 * 两条公理（docs/上下文压缩-真理与项目铁律.md）：
 *   · 可见性公理：图里有不等于模型看得见 ⇒ 召回只做「把已有边按锚点挑出来并渲染成短文本」；
 *   · 证据不增公理：召回**不生成新事实** —— 每一条 item 的 text 都逐字取自边上的既有字段，
 *     不猜测、不补写、不读文件全文；匹配不上就输出空串（空比编造好）。
 *
 * 边界（红线，任何一条破了就不要这个功能）：
 *   · 纯函数：无 I/O、无模型、无宿主依赖、**无模块级可变状态 / 常驻缓存**；
 *   · 只读 `graph.edges`，复用 `parseTouchedFileAction`（touched-files）与 `evidenceSpan`（kifu-model）
 *     这两处既有的机械解析，不另写一份「路径到底怎么解析」；
 *   · 只陈述已有事实，不写「下一步应该…」这类行为指导；
 *   · 默认不接生产路径（本文件只导出三个纯函数，由上层决定何时调用）。
 *
 * 冻结接口（integration/eval 已按此开发，不许改形）：
 *   extractQueryAnchors(queryText)                      => { paths, symbols }
 *   collectQueryRecall(graph, queryText, { limit })     => { anchors, items, stats }
 *   renderQueryRecall(graph, queryText, { limit, maxChars }) => { text, anchors, items, stats }
 */

import { evidenceSpan } from "./kifu-model.mjs";
import { parseTouchedFileAction } from "./touched-files.mjs";

/** 渲染段的标题（有内容时 text 必须以此开头；空集时 text 为 ""，不输出空标题）。 */
export const QUERY_RECALL_HEADER = "## 当前问题相关证据（机械召回）";
export const QUERY_RECALL_DEFAULT_LIMIT = 6;
export const QUERY_RECALL_DEFAULT_MAX_CHARS = 1200;

const DEFAULT_LIMIT = QUERY_RECALL_DEFAULT_LIMIT;
const DEFAULT_MAX_CHARS = QUERY_RECALL_DEFAULT_MAX_CHARS;
/** 锚点最长多少字符（与 kifu-model 里 action 的 240 上限一致，超出必然是被截断的垃圾）。 */
const MAX_ANCHOR_CHARS = 240;
/** 每条 item 的 text 上限 —— 只放「证据短文本」，绝不放文件全文。 */
const MAX_ITEM_TEXT_CHARS = 200;
/** 符号命中处摘录的上下文长度。 */
const MAX_EXCERPT_CHARS = 120;
const MAX_SYMBOL_CHARS = 120;

/**
 * 排序档位（越大越靠前）。契约：**完整路径 > 仓库相对后缀 > 反引号 basename > 符号**。
 * 同档内部不引入任何「长度/数字」加成 —— 同分一律交给 seqEnd 与 edge id 决定，保证可复现。
 */
const SCORE_FULL_PATH = 100;
const SCORE_PATH_SUFFIX = 80;
const SCORE_BASENAME = 60;
const SCORE_SYMBOL = 40;

/**
 * 「失败」的既有拼法（按语义归类，不是只认 `failure`）：
 *   · `failure` —— kifu-model / verify 房间的现行值；
 *   · `failed`  —— 真实数据与 lme-task50 夹具里出现的旧写法。
 * 少认一个就会把 errorSnippet 吞掉（等于丢掉「为什么失败」），所以这里显式收全。
 */
const FAILURE_RESULTS = new Set(["failure", "failed"]);

/**
 * 「看起来像代码/文档文件」的扩展名白名单。
 *
 * 为什么必须用白名单而不是 `\.\w+$`：`graph.edges` / `obj.method` 与 `a.mjs` 在形状上不可区分。
 * 白名单让 `graph.edges` 留在**符号**一侧，让 `run.mjs` 落到**路径**一侧；猜不出来的就不认（保守）。
 */
const FILE_EXTENSIONS = new Set([
  "mjs", "cjs", "mts", "cts", "js", "jsx", "ts", "tsx", "json", "jsonl", "md", "mdx", "markdown",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "lock", "env",
  "py", "pyi", "go", "rs", "java", "kt", "kts", "cs", "cpp", "cc", "cxx", "h", "hpp", "m", "mm",
  "rb", "php", "pl", "lua", "swift", "dart", "scala", "clj", "ex", "exs", "erl", "hrl",
  "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "xml", "svg",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "txt", "log", "csv", "tsv", "sql", "graphql", "gql", "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "zip", "gz", "tar", "docx", "xlsx", "pptx",
]);

/* ────────────────────────────── 小工具（纯字符串） ────────────────────────────── */

/** 压缩空白（含换行）—— 输出必须是单行，否则渲染会串行。 */
function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 去掉候选锚点两端的引号 / 行号后缀 / 句末标点。返回 null 表示「空掉了」。 */
function cleanPathCandidate(value) {
  let text = String(value ?? "").trim();
  if (text === "") return null;
  if (text.length > MAX_ANCHOR_CHARS * 2) return null;
  text = text.replace(/^[`"'“”‘’«»]+/u, "").replace(/[`"'“”‘’«»]+$/u, "");
  // `path:12` / `path:12-14` / `path#L12-L14` 是「跳到某行」的写法：行号不是路径的一部分。
  text = text.replace(/#L\d+(?:-L?\d+)?$/i, "");
  text = text.replace(/:(\d+)(?:\s*[-–~]\s*\d+)?$/, "");
  // 句末标点（中英文）都不是路径字符。
  text = text.replace(/[，。；：、,;!?！？…]+$/u, "");
  // 英文句号：只有「剥掉后仍然像带扩展名的文件」才剥（`a.mjs.` ⇒ `a.mjs`）。
  while (/\.[A-Za-z0-9]{1,8}\.$/u.test(text)) text = text.slice(0, -1);
  text = text.trim();
  if (text === "") return null;
  return text.slice(0, MAX_ANCHOR_CHARS);
}

/** 扩展名是否在文件白名单里（`run.mjs` ⇒ true，`graph.edges` ⇒ false）。 */
function hasKnownExtension(value) {
  const match = /\.([A-Za-z0-9]{1,8})$/u.exec(String(value ?? ""));
  return match !== null && FILE_EXTENSIONS.has(match[1].toLowerCase());
}

function looksLikeUrl(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(String(value ?? ""));
}

/** 形如路径（绝对 / UNC / 含斜杠且扩展名已知 / 带已知扩展名的裸文件名）。 */
function isPlausiblePath(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text.length > MAX_ANCHOR_CHARS) return false;
  if (looksLikeUrl(text)) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true; // Windows 盘符绝对路径：不要求扩展名
  if (/^\\\\[^\\/]+[\\/]/.test(text)) return true; // UNC
  if (text.startsWith("/")) return text.length > 1; // POSIX 绝对路径：不要求扩展名
  if (text.startsWith("-")) return false; // 命令行开关
  if (text.includes(":")) return false; // 相对路径里不该有冒号（防从命令串里抠）
  if (/[<>|*?$&;{}()\[\]\s"'`=]/.test(text)) return false; // 通配 / 重定向 / 管道 / 引号
  const base = text.split("/").pop() ?? "";
  return hasKnownExtension(base); // 仓库相对路径 / 裸文件名：必须有已知扩展名
}

/** 路径比较用的规范化：`\`→`/`、去 `./`、合并重复斜杠、去尾斜杠、盘符小写。 */
function normalizeQueryPath(value) {
  let text = String(value ?? "").trim();
  if (text === "") return "";
  // ★ 快路径（M-3 收尾）：绝大多数真实路径本来就已规范化 —— 没有反斜杠 / 引号 / `./` / 重复斜杠 /
  //   尾斜杠、盘符也已小写时，直接返回，省掉 5 次正则替换（10k 条边 × 每次路径查询都走一遍）。
  if (!/[\\`"'“”‘’«»]|\.\/|\/{2,}|\/$/.test(text) && !/^[A-Z]:\//.test(text)) return text;
  text = text.replace(/^[`"'“”‘’«»]+/u, "").replace(/[`"'“”‘’«»]+$/u, "");
  text = text.replace(/\\/g, "/");
  // 保留 UNC 的前导 `//`，其余位置合并重复斜杠（`a//b` 与 `a/b` 是同一个位置）。
  if (text.startsWith("//")) text = `//${text.slice(2).replace(/\/{2,}/g, "/")}`;
  else text = text.replace(/\/{2,}/g, "/");
  text = text.replace(/^(?:\.\/)+/, "");
  text = text.replace(/\/+$/, "");
  const drive = /^([A-Za-z]):\//.exec(text);
  if (drive !== null) text = `${drive[1].toLowerCase()}:${text.slice(2)}`;
  return text;
}

/** Windows 语义（盘符 / UNC）下大小写不敏感；纯 POSIX 路径保持大小写敏感。 */
function isWindowsPath(normalized) {
  return /^[A-Za-z]:\//.test(normalized) || /^\/\/[^/]/.test(normalized);
}

function basenameOf(normalized) {
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** 去重用的键：Windows 路径统一小写（同一台机器上 `Src\A.mjs` 与 `src/a.mjs` 是同一个文件）。 */
function pathKey(normalized) {
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/** 标识符 / 点链的形状（`render` · `graph.edges` · `$x`）。 */
function isSymbolShape(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text.length > MAX_SYMBOL_CHARS) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(text);
}

/** `obj.method` 形状的额外约束：最后一段 ≥ 2 字符（挡掉 `e.g` / `i.e` 这类拉丁缩写）。 */
function isDottedSymbolShape(value) {
  const text = String(value ?? "").trim();
  if (!isSymbolShape(text)) return false;
  const parts = text.split(".");
  if (parts.length < 2) return false;
  if (text.length < 4) return false;
  if (parts[parts.length - 1].length < 2) return false;
  return !hasKnownExtension(text); // `a.mjs` 是文件名，不是符号
}

/** 反引号里形如工具调用（`read(file_path=…)`）的内容：直接复用既有解析器取路径。 */
function backtickToolCallPath(candidate) {
  if (!/^[A-Za-z0-9_-]+\(/.test(candidate)) return null;
  const parsed = parseTouchedFileAction(candidate);
  return parsed === null ? null : cleanPathCandidate(parsed);
}

/** 反引号里的路径：比正文更宽松（允许中文名、允许盘符路径里带空格），但仍要求「像路径」。 */
function backtickPath(candidate) {
  const cleaned = cleanPathCandidate(candidate);
  if (cleaned === null) return null;
  if (!isPlausiblePath(cleaned)) return null;
  // 反引号里的命令串不能当路径（`npm run build` 没有扩展名也不会走到这里，但 `cat a.mjs` 会）。
  if (/\s/.test(cleaned) && !/^[A-Za-z]:[\\/]/.test(cleaned) && !/^\\\\/.test(cleaned)) return null;
  if (/[<>|*?$&;{}()\[\]"'`=]/.test(cleaned)) return null;
  return cleaned;
}

/** 反引号里的符号：标识符 / 点链；末尾的 `()` 只是「这是函数」的写法，不是名字的一部分。 */
function backtickSymbol(candidate) {
  const text = String(candidate ?? "").trim().replace(/\(\s*\)$/, "").trim();
  if (text === "") return null;
  if (hasKnownExtension(text) && !text.includes("/")) return null; // `run.mjs` 已在路径分支
  if (!isSymbolShape(text)) return null;
  if (!text.includes(".")) return text;
  return isDottedSymbolShape(text) ? text : null;
}

/* ────────────────────────────── 锚点抽取 ────────────────────────────── */

/**
 * 从**当前用户消息**里机械抽出代码锚点。
 *
 * 只认三类显式写法（其余一律不猜，宁可少召回也不制造假锚点）：
 *   1. 反引号内容：反引号 = 用户显式点名，允许裸 basename（`` `run.mjs` ``）与 `render()` / `obj.method`；
 *   2. 正文里的绝对路径（`D:\…` / UNC / `/tmp/…`）与带已知扩展名的仓库相对路径（`src/rooms/x.mjs`）；
 *   3. 明确文件语境（`文件` / `file` / `路径` / `path` …）后紧跟的裸 basename。
 *
 * **不接受**：正文里裸露的单标识符（`renderQueryRecall` 不带反引号 / 不带 `()` / 不是 `obj.method`）、
 * bash 命令里的裸文件名（`cat a.txt`）、URL 里的斜杠、`A/B` 这种普通斜杠短语、目录（没有已知扩展名）。
 *
 * @param {unknown} queryText
 * @returns {{paths: string[], symbols: string[]}} paths 保留原文（不转斜杠、不改大小写），匹配时才规范化
 */
export function extractQueryAnchors(queryText) {
  const raw = typeof queryText === "string" ? queryText : "";
  const paths = [];
  const symbols = [];
  const seenPath = new Set();
  const seenSymbol = new Set();

  const addPath = (value) => {
    const cleaned = cleanPathCandidate(value);
    if (cleaned === null || !isPlausiblePath(cleaned)) return;
    const key = pathKey(normalizeQueryPath(cleaned));
    if (key === "" || seenPath.has(key)) return;
    seenPath.add(key);
    paths.push(cleaned);
  };
  const addSymbol = (value) => {
    const symbol = String(value ?? "").trim();
    if (!isSymbolShape(symbol) || seenSymbol.has(symbol)) return;
    seenSymbol.add(symbol);
    symbols.push(symbol);
  };

  if (raw.trim() === "") return { paths, symbols };

  // ① 反引号先处理：它是用户显式指定，优先级最高；处理过的内容从正文里摘掉，避免被后面重复抽一遍。
  let rest = raw.replace(/`([^`\n]{1,240})`/g, (_whole, inner) => {
    const candidate = String(inner ?? "").trim();
    const fromCall = backtickToolCallPath(candidate);
    if (fromCall !== null) {
      addPath(fromCall);
      return " ";
    }
    const asPath = backtickPath(candidate);
    if (asPath !== null) {
      addPath(asPath);
      return " ";
    }
    const asSymbol = backtickSymbol(candidate);
    if (asSymbol !== null) addSymbol(asSymbol);
    return " ";
  });

  // ② URL 先摘掉：`https://x/y` 里的 `/x/y` 不是仓库路径。
  rest = rest.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/g, " ");

  // ③ 绝对路径：Windows 盘符 / UNC（允许任意扩展名、甚至没有扩展名）。
  rest = rest.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'`<>|?*；，。：、（）()\[\]{}]*/g, (matched) => {
    addPath(matched);
    return " ";
  });
  // ④ POSIX 绝对路径（前面不能紧贴字母/数字/点/冒号，避免把 `https://…` 的残留或 `a/b` 抠出来）。
  rest = rest.replace(/(?<![\w.:\-\/])\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*/g, (matched) => {
    addPath(matched);
    return " ";
  });
  // ⑤ 仓库相对路径：必须含 `/` 且扩展名在文件白名单里（`A/B` 这种短语因此不会被当路径）。
  rest = rest.replace(/(?:\.{1,2}\/)?[\p{L}\p{N}_.\-]+(?:\/[\p{L}\p{N}_.\-]+)+\/?/gu, (matched) => {
    addPath(matched);
    return " ";
  });
  // ⑥ 明确文件语境里的裸 basename（`文件 run.mjs` / `file run.mjs`）。没有语境就绝不猜。
  rest = rest.replace(
    /(?:文件|路径|脚本|模块|file|path|script|module)\s*[:：=]?\s*([\p{L}\p{N}_.\-]+\.[A-Za-z0-9]{1,8})/giu,
    (_whole, base) => {
      addPath(base);
      return " ";
    },
  );
  // ⑦ 符号：`name()` 形式（明确的调用写法）。
  rest = rest.replace(/(?<![\w$.\/\\-])([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(\s*\)/g, (_whole, name) => {
    if (name.length >= 2 && !hasKnownExtension(name)) addSymbol(name);
    return " ";
  });
  // ⑧ 符号：`obj.method` 形式（点链）。`a.mjs` 这类文件名在这里被扩展名白名单挡掉。
  rest.replace(/(?<![\w$.\/\\-])([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)(?![\w$])/g, (_whole, name) => {
    if (isDottedSymbolShape(name)) addSymbol(name);
    return _whole;
  });

  return { paths, symbols };
}

/* ────────────────────────────── 路径匹配 ────────────────────────────── */

/**
 * 锚点与边路径的匹配档位。
 *
 * @param {string} anchor 已规范化的锚点
 * @param {string} edgePath 已规范化的边路径
 * @param {boolean} [windowsSemantics] 图所在的文件系统是否是 Windows（`graph.cwd` 是盘符路径）
 *   —— Windows 上 `Src/Rooms/A.mjs` 与 `src/rooms/a.mjs` 是同一个文件，**相对路径**也必须
 *   大小写不敏感；POSIX 上相对路径保持大小写敏感（`A.mjs` 与 `a.mjs` 是两个文件）。
 * @returns {number} 0 表示不匹配
 */
function matchPathScore(anchor, edgePath, windowsSemantics = false) {
  if (anchor === "" || edgePath === "") return 0;
  const caseInsensitive = windowsSemantics || isWindowsPath(anchor) || isWindowsPath(edgePath);
  const a = caseInsensitive ? anchor.toLowerCase() : anchor;
  const p = caseInsensitive ? edgePath.toLowerCase() : edgePath;
  if (a === p) return SCORE_FULL_PATH;
  if (a.includes("/")) {
    // 锚点更短：锚点是边路径的**仓库相对后缀**（`src/a.mjs` ⊂ `D:/repo/src/a.mjs`）。
    if (p.endsWith(`/${a}`)) return SCORE_PATH_SUFFIX;
    // 锚点更长：边是锚点的仓库相对后缀（图里存的是相对路径、用户给的是绝对路径）。
    if (p.includes("/") && a.endsWith(`/${p}`)) return SCORE_PATH_SUFFIX;
    return 0;
  }
  // 裸 basename（只可能来自反引号 / 明确文件语境）：按文件名匹配，档位低于后缀。
  return basenameOf(p) === a ? SCORE_BASENAME : 0;
}

/* ────────────────────────────── 证据读取（只读边上已有字段） ────────────────────────────── */

/**
 * 标识符边界匹配器：`render` 不得命中 `renderer`（前后都不能是标识符字符）。
 *
 * 点链（`graph.edges`）左侧**还**要排除 `.`：`x.graph.edges` 是另一个符号（或一个更长的点链），
 * 不是用户点名的那个点链；否则 `` `graph.edges` `` 会在 `x.graph.edges` 上误命中。
 */
function symbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = symbol.includes(".") ? "(?<![A-Za-z0-9_$.])" : "(?<![A-Za-z0-9_$])";
  return new RegExp(`${left}${escaped}(?![A-Za-z0-9_$])`);
}

/** 符号命中处的短摘录（±40 字符，压成单行）。 */
function excerptAround(text, index, length) {
  const head = text.slice(Math.max(0, index - 40), index);
  const body = text.slice(index, index + length);
  const tail = text.slice(index + length, index + length + 40);
  return collapseWhitespace(`${head}${body}${tail}`).slice(0, MAX_EXCERPT_CHARS);
}

/**
 * 在边的既有字符串字段里找符号（精确边界），命中返回首次出现的字段位置（不建摘录）。
 *
 * ★ 性能（M-3 收尾）：
 *   · `pattern` 由调用方**每个符号只编译一次**（10k 条边 × N 符号，逐边 new RegExp 是纯浪费）；
 *   · **不分配**逐字段的 `{label,text}` 包装对象，也不建 candidates 数组（10k 边 × 7 字段 = 7 万临时对象）；
 *   · **不建摘录字符串** —— 只把命中位置写进调用方给的 `out`（只有最终保留的 ≤limit 条才需要摘录）。
 */
function matchField(pattern, text, out) {
  if (typeof text !== "string" || text === "") return false;
  const match = pattern.exec(text);
  if (match === null) return false;
  out.text = text;
  out.index = match.index;
  out.length = match[0].length;
  return true;
}

/** 字段顺序即优先级：action → intent → sig → text → verify.summary → errorSnippet → result。 */
function findSymbolHit(edge, pattern, out) {
  const summary = edge.verify !== null && typeof edge.verify === "object" ? edge.verify.summary : undefined;
  return (
    matchField(pattern, edge.action, out) ||
    matchField(pattern, edge.intent, out) ||
    matchField(pattern, edge.sig, out) ||
    matchField(pattern, edge.text, out) ||
    matchField(pattern, summary, out) ||
    matchField(pattern, edge.errorSnippet, out) ||
    matchField(pattern, edge.result, out)
  );
}

/**
 * 结果短语：失败边**必须**保留已有失败原因（errorSnippet 优先，其次 verify.summary）。
 *
 * 枚举不止 `failure` 一种拼法 —— 真实数据与夹具里都出现过别名，所以这里**按语义归类**，
 * 而不是只认四个字面值（否则失败边会把 errorSnippet 吞掉，等于丢掉「为什么失败」）：
 *   · 失败类：`failure` / `failed`（夹具与旧数据写法）⇒ 统一输出 `失败: <原因>`；
 *   · 其余（`success` / `ok` / `later-ok` / `unverified` / `untested` / 未知值）⇒ **保留原词**
 *     并附上已有的结算摘要（`summary`）—— `later-ok` 的语义就是「后来跑通了」，摘要是它的证据。
 */
function statusText(edge) {
  const raw = typeof edge.result === "string" ? edge.result.trim() : "";
  const reason = collapseWhitespace(edge.errorSnippet);
  const summary = collapseWhitespace(edge.verify !== null && typeof edge.verify === "object" ? edge.verify.summary : "");
  const label = raw === "" ? "untested" : raw;
  if (FAILURE_RESULTS.has(raw)) return `失败: ${reason || summary || label}`;
  return summary === "" ? label : `${label}（${summary}）`;
}

/**
 * 组装 item.text：只拼边上的已有事实（action / intent / 命中摘录 + 结果短语），单行、截 200 字符。
 *
 * ★ B-2（reviewer）：**状态后缀必须预留空间**。真实图里 `action` 常常贴着 240 字符上限，
 *   先拼 action 再 `slice(0,200)` 会把 `⇒ 失败: <errorSnippet>` 整段切掉 —— 那正好是失败边
 *   唯一有用的部分（「为什么失败」）。所以这里先算后缀，再按剩余空间裁 action：
 *   · 正常长度：与旧输出逐字相同（`<head> ⇒ <status>`）；
 *   · head 过长：裁到剩余空间并加 `…`，**后缀完整保留**；
 *   · 后缀自身超长（errorSnippet 极长）：head 让空，最终 200 字符上限内保住 `⇒ 失败: ` + 原因前缀。
 *
 * 不写「下一步应该…」——是否要继续、要读哪个文件，是模型自己的判断，召回只提供历史。
 */
function buildItemText(edge, { kind, symbol, excerpt }) {
  const action = collapseWhitespace(edge.action);
  const intent = collapseWhitespace(edge.intent);
  const status = `⇒ ${statusText(edge)}`;
  let head = action || intent || excerpt || "";
  if (kind === "symbol" && symbol !== null && excerpt !== "" && !head.includes(symbol)) {
    head = head === "" ? excerpt : `${head} ${excerpt}`;
  }
  const cap = MAX_ITEM_TEXT_CHARS;
  if (head !== "" && head.length + 1 + status.length > cap) {
    // 1 = head 与 status 之间的空格；再留 1 个字符给省略号。
    const room = cap - status.length - 1;
    head = room > 1 ? `${head.slice(0, room - 1).trimEnd()}…` : "";
  }
  const text = head === "" ? status : `${head} ${status}`;
  return collapseWhitespace(text).slice(0, cap);
}

/** 把内部候选行转成冻结形状的 item（text / 摘录只在**保留的**行上才算 —— 见 collectQueryRecall）。 */
function toItem(row) {
  const excerpt = row.symbolText === null ? "" : excerptAround(row.symbolText, row.symbolIndex, row.symbolLength);
  return {
    id: row.id,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    path: row.path,
    symbol: row.symbol,
    kind: row.kind,
    text: buildItemText(row.edge, { kind: row.kind, symbol: row.symbol, excerpt }),
    score: row.score,
  };
}

/* ────────────────────────────── 召回 ────────────────────────────── */

/** 取 `graph.edges` 的 `[id, edge]` 列表；坏输入（null / 缺字段 / 非对象边）一律安全降级。 */
function edgeEntries(graph) {
  if (graph === null || typeof graph !== "object") return [];
  const edges = graph.edges;
  if (edges === null || typeof edges !== "object") return [];
  if (Array.isArray(edges)) {
    const rows = [];
    edges.forEach((edge, index) => {
      if (edge !== null && typeof edge === "object") rows.push([String(edge.id ?? index), edge]);
    });
    return rows;
  }
  const rows = [];
  for (const [key, edge] of Object.entries(edges)) {
    if (edge !== null && typeof edge === "object") rows.push([String(edge.id ?? key), edge]);
  }
  return rows;
}

/** limit 归一化：非法（NaN / ≤0 / 非数字）⇒ 默认 6；合法则取整。 */
function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.floor(number);
}

/** maxChars 归一化：非法（NaN / <0 / 非数字）⇒ 默认 1200；0 是合法的「一个字都不输出」。 */
function normalizeMaxChars(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_MAX_CHARS;
  return Math.floor(number);
}

/** 排序：档位降序 ⇒ seqEnd 新到旧 ⇒ edge id 字典序（完全确定，无时间/无随机）。 */
function compareItems(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.seqEnd !== a.seqEnd) return b.seqEnd - a.seqEnd;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** `a` 是否应排在 `b` 前面（与 compareItems 同序，供 top-K 用，避免两处排序判据漂移）。 */
function isBetter(a, b) {
  return compareItems(a, b) < 0;
}

/**
 * top-K（K = limit）的「最差在堆顶」二叉堆。
 *
 * ★ 为什么要它（M-3 收尾）：真实最大图一次符号查询命中 9,359 条，旧实现把 9,359 个候选行**全部**
 *   建出来再全量排序，只为取前 6 条 —— 排序 O(n log n) 与 9k 个临时对象都是白花的。
 *   这里只保留「当前最好的 K 条」，且**先比较元组、输了就不建对象**。
 * 契约不变：最终 `items` 仍按 compareItems 全序排列，`matchedEdges` 仍是全部命中数。
 */
function offerTopK(heap, row, limit) {
  if (heap.length < limit) {
    heap.push(row);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!isBetter(heap[parent], heap[index])) break;
      const swap = heap[parent];
      heap[parent] = heap[index];
      heap[index] = swap;
      index = parent;
    }
    return;
  }
  if (!isBetter(row, heap[0])) return; // 不比当前最差更好 ⇒ 丢弃（连对象都不用建）
  heap[0] = row;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    let worst = left;
    if (right < heap.length && isBetter(heap[left], heap[right])) worst = right;
    if (!isBetter(heap[index], heap[worst])) break;
    const swap = heap[index];
    heap[index] = heap[worst];
    heap[worst] = swap;
    index = worst;
  }
}

/**
 * 按当前用户消息里的代码锚点，从图边里机械召回相关证据。
 *
 * 规则（顺序即契约）：
 *   1. 只读 `graph.edges`；每条边先取 `evidenceSpan` —— 没有 seq 的边**无法给出处**，不进结果
 *      （但仍计入 `stats.scannedEdges`，账必须真实）；
 *   2. 路径优先复用 `parseTouchedFileAction(edge.action)`；锚点与边路径规范化后比：
 *      完整路径（100）> 仓库相对后缀（80）> 反引号 basename（60）；
 *   3. 符号在边的既有字符串字段（action / intent / sig / text / verify.summary / errorSnippet / result）
 *      里做**精确边界**匹配（40）—— `render` 不命中 `renderer`；
 *   4. 排序：档位 ⇒ seqEnd 新到旧 ⇒ edge id 字典序；
 *   5. `limit` 真截断：`items` 只留前 `limit` 条，`stats.truncated` 反映是否被截过。
 *
 * @param {unknown} graph 棋谱（只读 `edges`）
 * @param {unknown} queryText 当前用户消息原文
 * @param {{limit?: number}} [options]
 * @returns {{anchors: {paths: string[], symbols: string[]}, items: Array<object>, stats: object}}
 */
export function collectQueryRecall(graph, queryText, options = {}) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const limit = normalizeLimit(opts.limit);
  const anchors = extractQueryAnchors(queryText);
  const entries = edgeEntries(graph);
  const stats = {
    scannedEdges: entries.length,
    matchedEdges: 0,
    truncated: false,
    limit,
    kept: 0,
    pathAnchors: anchors.paths.length,
    symbolAnchors: anchors.symbols.length,
  };
  if (anchors.paths.length === 0 && anchors.symbols.length === 0) {
    return { anchors, items: [], stats };
  }

  const normalizedPaths = anchors.paths
    .map((original) => ({ original, normalized: normalizeQueryPath(original) }))
    .filter((pair) => pair.normalized !== "");
  // 图所在的文件系统语义（`graph.cwd` 是盘符路径 ⇒ Windows）：决定相对路径是否大小写不敏感。
  const windowsSemantics = graph !== null && typeof graph === "object" && typeof graph.cwd === "string"
    ? isWindowsPath(normalizeQueryPath(graph.cwd))
    : false;
  // 每个符号只编译一次边界正则（见 findSymbolHit）。
  const symbolPatterns = anchors.symbols.map((symbol) => ({ symbol, pattern: symbolPattern(symbol) }));
  // 复用同一个命中位置对象：命中才写、不分配（见 matchField）。
  const hit = { text: "", index: 0, length: 0 };
  let matched = 0;
  const best = [];
  for (const [edgeId, edge] of entries) {
    const span = evidenceSpan(edge);
    if (span === null) continue; // 没有 seq 就没法给出处 ⇒ 不进结果
    let bestPath = null;
    let bestSymbol = null;

    // 只有查询里**真的有路径锚点**时才解析 action（符号查询不必为 10k 条边白跑一遍解析器）。
    if (normalizedPaths.length > 0) {
      const rawAction = edge.action;
      // ★ 廉价预筛（M-3 收尾）：解析器只认 `file_path=` / `path=` 两种键，没有这两者必然返回 null。
      //   真实图里大半边是 bash/网络工具，先做两次 indexOf 就省掉它们整段正则解析。
      if (typeof rawAction === "string" && (rawAction.includes("file_path=") || rawAction.includes("path="))) {
        const edgePathRaw = parseTouchedFileAction(rawAction);
        const edgePath = edgePathRaw === null ? "" : normalizeQueryPath(edgePathRaw);
        if (edgePath !== "") {
          for (const pair of normalizedPaths) {
            const score = matchPathScore(pair.normalized, edgePath, windowsSemantics);
            if (score > 0 && (bestPath === null || score > bestPath.score)) {
              // 记录**锚点原文**（`paths` 保留原文的契约在 `item.path` 上也一致）
              bestPath = { score, path: pair.original };
            }
          }
        }
      }
    }

    if (symbolPatterns.length > 0) {
      for (const entry of symbolPatterns) {
        if (findSymbolHit(edge, entry.pattern, hit)) {
          bestSymbol = { score: SCORE_SYMBOL, symbol: entry.symbol, text: hit.text, index: hit.index, length: hit.length };
          break; // 锚点顺序即优先级，第一个命中就够（可复现）
        }
      }
    }

    if (bestPath === null && bestSymbol === null) continue;
    matched += 1; // stats.matchedEdges 是**全部**命中数，与 limit 无关
    const kind = bestPath !== null ? "path" : "symbol";
    const score = bestPath !== null ? bestPath.score : bestSymbol.score;
    // ★ M-3（性能）：候选行只为「可能进 top-K」的边创建；text / 摘录推迟到 toItem（只对保留行）。
    offerTopK(
      best,
      {
        id: edgeId,
        seqStart: span.start,
        seqEnd: span.end,
        path: bestPath === null ? null : bestPath.path,
        symbol: bestSymbol === null ? null : bestSymbol.symbol,
        kind,
        symbolText: bestSymbol === null ? null : bestSymbol.text,
        symbolIndex: bestSymbol === null ? 0 : bestSymbol.index,
        symbolLength: bestSymbol === null ? 0 : bestSymbol.length,
        score,
        edge,
      },
      limit,
    );
  }

  stats.matchedEdges = matched;
  // 堆里只有「最好的 limit 条」，这里按冻结契约的全序排好再建 item（≤limit 条）。
  best.sort((a, b) => (isBetter(a, b) ? -1 : isBetter(b, a) ? 1 : 0));
  const items = best.map((row) => toItem(row));
  stats.kept = items.length;
  stats.truncated = matched > limit;
  return { anchors, items, stats };
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

/** 渲染一行：`- e3 (seq 10-12) path src/a.mjs — <证据短文本>`（只有 id + seq + 已有事实）。 */
function formatItemLine(item) {
  const label = item.path !== null ? `path ${item.path}` : `symbol ${item.symbol}`;
  return `- ${item.id} (seq ${item.seqStart}-${item.seqEnd}) ${label} — ${item.text}`;
}

/**
 * 把召回结果渲染成一段可直接注入的短文本。
 *
 * 契约：
 *   · 无锚点 / 无匹配 ⇒ `text === ""`（不输出空标题）；
 *   · 有内容 ⇒ 以 `## 当前问题相关证据（机械召回）` 开头，逐行 `id + seq + 证据短文本`；
 *   · `maxChars` 是**硬上限**：放不下的行直接丢弃（对应的 item 也不进 `items`），
 *     `stats.truncated` 必须真实反映「因 limit 或 maxChars 被截过」；
 *   · 内容只陈述已有事实，不写「下一步应该…」。
 *
 * @param {unknown} graph
 * @param {unknown} queryText
 * @param {{limit?: number, maxChars?: number}} [options]
 * @returns {{text: string, anchors: object, items: Array<object>, stats: object}}
 */
export function renderQueryRecall(graph, queryText, options = {}) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const limit = normalizeLimit(opts.limit);
  const maxChars = normalizeMaxChars(opts.maxChars);
  const collected = collectQueryRecall(graph, queryText, { limit });

  const lines = [];
  const items = [];
  let usedChars = 0; // == 最终 text 的字符数（精确记账，见下）
  let truncated = collected.stats.truncated;
  for (const item of collected.items) {
    const line = formatItemLine(item);
    // ★ 精确记账（reviewer MINOR）：首行 = 标题 + `\n` + 行；后续行 = `\n` + 行。
    //   旧实现每行都多算 1 个字符（末行尾部换行），导致「恰好到上限」的一行被误判放不下。
    const isFirst = items.length === 0;
    const cost = (isFirst ? QUERY_RECALL_HEADER.length + 1 : 1) + line.length;
    if (usedChars + cost > maxChars) {
      truncated = true;
      break;
    }
    if (isFirst) lines.push(QUERY_RECALL_HEADER);
    lines.push(line);
    usedChars += cost;
    items.push(item);
  }

  const text = items.length === 0 ? "" : lines.join("\n");
  const stats = { ...collected.stats, truncated, kept: items.length, maxChars };
  return { text, anchors: collected.anchors, items, stats };
}
