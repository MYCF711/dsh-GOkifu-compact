/**
 * tool-value-facts.mjs —— 成功工具结果的值型事实抽取器（AX-02，2026-11-07）
 *
 * 为什么需要（K-2 已证实的退化，不是假设）：
 *   `evidence/k2-reader-expand-2026-11-07.json` 的 4 题里，2 题在「每步清理工具结果」后
 *   从答对变成答不出 —— 而丢失的都不是长文，是**短值**：
 *     · S1-Q1 成功 `write` 回执里的 `Created file` + 路径；
 *     · S2-Q3 仓库 API JSON 里的 `id` / `private`。
 *   ⇒ 第二条公理要补的不是「别删」，而是「删之前把可回证的短值留下来」。
 *
 * 本房间只做一件事：**从已判定成功的工具结果文本里抽取 ≤ N 条短事实**。
 * 落盘（keeper 的边）、渲染（ledger/hot-inject）都不在这里 —— 那两层见 AX-04 / AX-08。
 *
 * 契约（任务书 AX-02，逐条对应）：
 *   1. 每项**恰好** `{kind, value, quote, evidenceSeq, validAtSeq, source}` 六个字段；
 *   2. 保留：Created file / Updated file、文件路径、明确 id、boolean、关键配置值；
 *   3. **数组实参不得当返回值** —— 本房间*根本不读* `args`；顶层 JSON 数组一律不产事实
 *      （`todo_write` 之类会把入参数组回显成结果，按元素抽就是把实参当返回值）；
 *   4. 错误结果不进成功值事实 —— `resultKind` 为 `failure`/`unverified`（无 weak）或 `isError === true`
 *      一律返回 `[]`。**`weak` 是允许的**（`classify` 的 `weak:"read"/"shell"`：工具自报无错、
 *      但没有外部验证信号）—— 真机语料里 API/JSON 读取正是这一类，若只认 `success`，
 *      K-2 S2-Q3 的 id/private 永远进不了图（见 REPORT「未验项/冲突」）。
 *   5. 无 id 不编造 —— 结果里没有名为 `id`（或 `*_id`）的标量就不产 `id` 事实；
 *   6. 无法识别返回 `[]`（空数组是**正常**返回值，不是错误）；
 *   7. `quote` 必须是结果原文的**逐字连续子串** —— 下游（K-26 守卫 / AX-08）拿它复核，
 *      不允许改写、补全、摘要。构造时还会再过一次 `text.includes(quote)` 兜底。
 *
 * 形状来源（都从真机会话逐字核对过，没有一条是猜的）：
 *   · write 成功：`<path>…</path>\n<type>file</type>\n<content>\nCreated file\n</content>`
 *   · write/编辑成功：`The file … has been updated successfully.`
 *   · read 成功：`<path>…</path>\n<type>file</type>\n<content>\n1: …\n</content>`（内容行带 `N: ` 前缀）
 *   · API/JSON 成功：裸 JSON 对象（`{"id":…,"private":…}`）；K-2 S2-Q3 的真实形态是
 *     **`gh api` 的 JSON + 末尾 `[exit code: 0]` 一行**，而且结果可能被截断 ——
 *     所以 JSON 解析走「顶层成员扫描」：完整成员照抽，截断处停下，不要求整份 JSON 可解析。
 *
 * 依赖：`./config-schema.mjs`（配置键的**单一来源**，只为判断「这个键算不算关键配置值」）。
 * 不碰 fs / 网络 / 宿主包；纯函数、确定性：同样输入永远同样输出。
 *
 * ★ AX-21（2026-11-08）：**「结果算不算可信」的判据也只留在这里**。
 *   `githubReadShaped` / `resultKindForValueFacts` 原先分别写在 keeper（在线）与 offline-fold
 *   （离线）里 —— 后者漏了 GitHub 读形映射，于是 K-2 S2-Q3 的 `id` / `private` 在离线路径
 *   **一条都抽不出来**（`evidence/k2-reader-expand-2026-11-07.json` 的 6 题退化里有 4 题是 API 值）。
 *   两条路径现在共用同一对纯函数：判据改一处，两条路径同时改（不可能再分叉）。
 *
 * ★ AX-22（2026-11-08）：K-2 剩下的**两条**退化根因也在这里收口，但**默认关闭**：
 *
 *   · 根因③ —— `read` 的**文件正文行值**：AX-21 之后 read 结果只产 `file_path` 一条，
 *     正文里 `id: 'codearts',` 这种短值一条都不进图（K2-N2 / K2-N3）。
 *   · 根因④ —— **顶层 JSON 数组**：契约第 3 条为了防「数组实参当返回值」一律不抽，
 *     于是 GitHub `contents` API 的 `[{name, path, sha, size, …}]` 整份丢弃（K2-N5 / K2-N6）。
 *
 *   两个新形状各配一个**默认 `false`** 的开关（`options.allowReadContent` /
 *   `options.allowTopLevelArray`），且**只有「这次结果是读形」**（`readShapeForValueFacts`：
 *   `read` / `read_file`，或 GitHub REST 的 GET/HEAD/缺省）才生效。
 *   默认关闭 ⇒ 线上 keeper / 旧语料**逐字节不变**（契约第 3 条仍是默认行为）；
 *   只有 K-2 的派生路径（`scripts/k2-value-reader.mjs` 的 `deriveValueFacts`）显式打开。
 *   为什么必须再宽一档信任闸：read 结果的 `resultKind` 是 classify 的 `weak:"read"`，
 *   旧契约只认 `success`/`weak` 两个字面量 ⇒ 正文行值连门都进不去（`read` 连 `file_path`
 *   都不产）。新形状额外接受 `read` / `shell` 两种**弱成功**，且**只在开关打开 + 读形**时。
 */

import { SCHEMA } from "./config-schema.mjs";

/** 事实种类的闭集。新增种类 = 改契约，必须同时改测试与下游（AX-04/AX-08）。 */
export const VALUE_FACT_KINDS = Object.freeze(["file_created", "file_updated", "file_path", "id", "boolean", "config", "value"]);

/**
 * 上限（默认值也是契约的一部分，测试钉住）：
 *   · `maxFacts`      —— 一条边最多留几条；再多就回到「回灌」的老问题；
 *   · `maxValueChars` —— 单个值的字符上限；超了就**丢弃**这条事实，绝不截断（截断的值 = 假值）；
 *   · `maxQuoteChars` —— 单条证据的字符上限（K-26 的 quote 口径是「可截断到 120」，这里宽一些以容纳
 *                        path + Created file 的整块回执，但仍远小于一份工具结果）；
 *   · `maxResultChars`—— 超过这个大小的结果不抽（防御性上限，不是「大结果不能用」：
 *                        300 KB 的 JSON 只保留 id/private 正是本房间的正常工作）。
 */
export const VALUE_FACT_LIMITS = Object.freeze({
  maxFacts: 8,
  maxValueChars: 200,
  maxQuoteChars: 320,
  maxResultChars: 2_000_000,
});

/** 通用配置键（仓库自身的配置键从 SCHEMA 取，不在这里抄第二份）。 */
const GENERIC_CONFIG_KEYS = Object.freeze(["default_branch", "version", "visibility", "language", "status", "mode", "environment"]);

/** 通用布尔键：`private` 就是 K-2 S2-Q3 的那一题；其余是同一形状的常见兄弟。 */
const GENERIC_BOOLEAN_KEYS = Object.freeze(["private", "public", "archived", "disabled", "enabled", "fork", "template", "is_template", "ok", "success", "factGuard"]);

const CONFIG_KEY_SET = new Set([...SCHEMA.map((field) => field.key), ...GENERIC_CONFIG_KEYS]);
const BOOLEAN_KEY_SET = new Set([...SCHEMA.filter((field) => field.type === "boolean").map((field) => field.key), ...GENERIC_BOOLEAN_KEYS]);

/** 明确 id 的键形：`id` 或 `*_id`（`node_id` 这类也算；`_ids` 是数组，天然被标量规则挡掉）。 */
function isIdKey(key) {
  return key === "id" || /_id$/.test(key);
}

/** 结果来源的信任闸：只有这两种可以产事实（`weak` 必须由调用方显式给，不自己升格）。 */
const TRUSTED_RESULT_KINDS = new Set(["success", "weak"]);

/**
 * ★ AX-22：**read 正文行值 / 顶层 JSON 数组**两个新形状额外接受的「弱成功」结果种类。
 *
 * 为什么需要额外一档：read 结果的 `resultKind` 是 classify 的 `weak:"read"`
 * （`{result:"unverified", weak:"read"}`，R04 的只读兜底分支），**不是**字面量 `"weak"`
 * —— 旧信任闸只认 `success`/`weak`，于是 read 结果连 `file_path` 都产不出来。
 * 这一档**只在「开关打开 + 这次是读形」时**生效（见 `readShapeForValueFacts`），
 * 所以线上 keeper（不传 options）的行为逐字节不变。
 */
const EXTRA_TRUSTED_READ_KINDS = new Set(["read", "shell"]);

/**
 * ★ AX-22：会产出 `<path>…</path>\n<content>…</content>` 包络的**只读**工具。
 *
 * 只列真会回正文的工具名（`read` / `read_file`）—— 不按「像 read」猜：
 * `web_fetch` / `read_page` 的结果是网页正文（没有 `<content>` 包络），
 * `grep` / `glob` 的结果是命中列表（不是文件正文）。列错一个就等于给别的工具开闸。
 */
const READ_CONTENT_TOOLS = new Set(["read", "read_file"]);

/** 单行短值的寒暄/回执词：它们不是「值」，不该占一条事实。 */
const ACK_RE = /^(?:ok|okay|done|success|successful|no changes?|created file|updated file|完成|成功|已创建|已更新|已写入|好的|收到)$/i;

/** 行首错误形态（只在「纯文本短值」分支用；JSON 分支另有 error 成员判据）。 */
const TEXT_ERROR_RE = /^(?:[A-Za-z_$][\w$]*(?:Error|Exception)\b|Traceback\b|Error\b|error\b|ERROR\b|FAILED\b|fatal\b|panic:)/;

/**
 * 从**成功**工具结果里抽取短小的值型事实。
 *
 * @param {{
 *   tool?: string,             // 工具名，只用于 source（`tool:write` 这种）
 *   result?: string|object,    // 工具结果文本；对象会先 JSON.stringify（确定性由调用方保证）
 *   resultKind?: string,       // "success"（默认）| "weak" —— 其余（failure/unverified）一律 []
 *                             //   "weak" = classify 的 weak:"read"/"shell"：工具自报无错、无外部验证信号。
 *                             //   调用方必须显式传，抽取器不自己给结果升格。
 *   isError?: boolean,         // 宿主标记；true 一律 []
 *   evidenceSeq: number,       // 必填：这条结果的会话事件 seq（给不出就不产事实）
 *   validAtSeq?: number,       // 可选：事实生效时点；默认 = evidenceSeq
 *   args?: unknown,            // 只在「GitHub 读形」判定里读 method/body/confirm 三个键（AX-22）；
 *                             //   **绝不把实参里的任何值当事实**（契约第 3 条：数组实参不得当返回值）
 *   maxFacts?: number,
 *   maxValueChars?: number,
 *   maxQuoteChars?: number,
 *   maxResultChars?: number,
 * }} input
 * @param {{
 *   allowReadContent?: boolean,   // ★ AX-22：read 正文的短值行（默认 false）
 *   allowTopLevelArray?: boolean, // ★ AX-22：顶层 JSON 数组的标量（默认 false）
 * }} [options] 两个开关都**只在「这次结果是读形」时**有效（见 `readShapeForValueFacts`）
 * @returns {Array<{kind:string, value:string|number|boolean, quote:string, evidenceSeq:number, validAtSeq:number, source:string}>}
 */
export function extractValueFacts(input = {}, options = {}) {
  try {
    return extractUnsafe(input, options);
  } catch {
    // 抽取器永远不抛：坏输入 = 没有事实（空数组），不是错误。
    return [];
  }
}

function extractUnsafe(input, options) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];

  // ① 成功闸：错误结果不得进入成功值事实（宿主标记优先，其次调用方给的 resultKind）。
  if (input.isError === true) return [];
  // ★ AX-22：两个新形状各有一个**默认关闭**的开关；两者都关时，这里的判据与 AX-21 逐字相同。
  const opts = options !== null && typeof options === "object" && !Array.isArray(options) ? options : {};
  const rawKind = input.resultKind === undefined || input.resultKind === null ? "success" : String(input.resultKind);
  const wantReadContent = opts.allowReadContent === true;
  const wantTopLevelArray = opts.allowTopLevelArray === true;
  // 「这次结果算不算读」只在开关打开时才有意义（省掉无谓的 args 形状判定）。
  const readShaped = (wantReadContent || wantTopLevelArray) && readShapeForValueFacts(input.tool, input.args);
  const trusted =
    TRUSTED_RESULT_KINDS.has(rawKind) || (readShaped && EXTRA_TRUSTED_READ_KINDS.has(rawKind));
  if (!trusted) return [];
  const readContentOn = wantReadContent && readShaped;
  const topLevelArrayOn = wantTopLevelArray && readShaped;

  // ② seq 闸：没有证据指针就不产事实（编号是回证链路，不许补 0/补时间戳）。
  const evidenceSeq = input.evidenceSeq;
  if (!Number.isSafeInteger(evidenceSeq) || evidenceSeq < 0) return [];
  const validAtSeqRaw = input.validAtSeq === undefined || input.validAtSeq === null ? evidenceSeq : input.validAtSeq;
  if (!Number.isSafeInteger(validAtSeqRaw) || validAtSeqRaw < 0) return [];

  // ③ 文本化。对象结果先序列化（确定性由调用方保证：同一对象同一 JSON 文本）。
  let text;
  if (typeof input.result === "string") text = input.result;
  else if (input.result !== null && typeof input.result === "object") {
    try {
      text = JSON.stringify(input.result);
    } catch {
      return [];
    }
  } else return [];
  if (typeof text !== "string" || text.trim() === "") return [];

  const limits = resolveLimits(input);
  if (text.length > limits.maxResultChars) return [];

  // ④ 文件包络先解析出来：后面既给文件事实用，也决定「末尾退出码」这条防御判据要不要生效。
  const envelope = readFileEnvelope(text);
  // 壳命令的结果若末尾自报非零退出码，就不是成功值（宿主/调用方标错时兜底；read 的文件正文不适用）。
  if (envelope === null) {
    const exitCode = trailingExitCode(text);
    if (exitCode !== null && exitCode !== 0) return [];
  }

  const ctx = {
    text,
    source: sourceOf(input.tool),
    evidenceSeq,
    validAtSeq: validAtSeqRaw,
    limits,
  };
  const out = [];
  const seen = new Set();

  const add = (kind, value, quote) => {
    if (out.length >= limits.maxFacts) return false;
    if (typeof value === "string") {
      if (value.length === 0 || value.length > limits.maxValueChars) return false;
    } else if (typeof value !== "number" && typeof value !== "boolean") return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    const q = String(quote ?? "").trim();
    if (q === "" || q.length > limits.maxQuoteChars || q.includes("\u0000")) return false;
    // 逐字兜底：构造成本再低，也不允许一条「原文里找不到」的 quote 流出去。
    if (!text.includes(q)) return false;
    const key = `${kind}\u0000${typeof value}\u0000${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ kind, value, quote: q, evidenceSeq: ctx.evidenceSeq, validAtSeq: ctx.validAtSeq, source: ctx.source });
    return true;
  };
  /** 满额就不再扫（大结果 / 长正文里继续扫只是白烧 CPU）。 */
  const full = () => out.length >= limits.maxFacts;

  // ⑤ 文件回执/路径：先于 JSON 分支（write 的 `<content>` 里只有 Created file，不是 JSON）。
  if (envelope !== null) {
    const path = envelope.path;
    if (envelope.receipt === "Created file") add("file_created", path, blockQuote(text, envelope, limits.maxQuoteChars));
    else if (envelope.receipt === "Updated file") add("file_updated", path, blockQuote(text, envelope, limits.maxQuoteChars));
    else add("file_path", path, text.slice(envelope.pathOpen, envelope.pathClose));
  }

  // ⑥ 编辑回执（无 `<path>` 包络，单独一句）：`The file … has been updated successfully.`
  //    认出来就**不再**走 ⑦ —— 否则整句会再被当成一条纯文本 `value`，同一事实出现两次。
  let receiptOnly = false;
  if (envelope === null) {
    const edited = /^The file (.+?) has been updated successfully\.?\s*$/.exec(text.trim());
    if (edited !== null) {
      add("file_updated", edited[1].trim(), edited[0]);
      receiptOnly = true;
    }
  }

  // ⑦ JSON：裸 JSON 结果 / read 包络里的 JSON 内容（行号前缀会先剥掉再解析）。
  //    quote 直接从「用于解析的那段文本」里切：行号前缀只在行首、标量片段永远不含它，
  //    所以切出来的 quote 仍是**结果原文的连续子串**（`add` 里的 includes 兜底会再验一次）。
  if (envelope === null) {
    if (!receiptOnly) {
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) {
        collectJsonFacts({ jsonText: trimmed, add });
      } else if (trimmed.startsWith("[")) {
        // 契约第 3 条：顶层数组不当返回值（`todo_write` 之类会把入参数组回显成结果）。
        // ★ AX-22：只有「可信读形 + 调用方显式开 allowTopLevelArray」才按元素抽
        //   （GitHub contents API 的真实形状就是顶层数组）。默认 false ⇒ 逐字回到旧契约。
        if (topLevelArrayOn) collectJsonArrayFacts({ jsonText: trimmed, add, full });
      } else if (trimmed.startsWith("<")) {
        // 其它 XML 形状：不猜。
      } else {
        collectPlainValue(trimmed, add);
      }
    }
  } else if (envelope.contentOpen >= 0 && envelope.contentClose >= 0) {
    const contentText = text.slice(envelope.contentOpen + 9, envelope.contentClose);
    const stripped = stripReadLineNumbers(contentText);
    const first = stripped.trimStart();
    if (first.startsWith("{")) {
      collectJsonFacts({ jsonText: stripped.slice(stripped.indexOf(first)), add });
    } else if (first.startsWith("[")) {
      // 读到的文件是 JSON 数组：同「顶层数组」规则，默认不按元素抽（★ AX-22 开关打开才抽）。
      if (topLevelArrayOn) collectJsonArrayFacts({ jsonText: stripped.slice(stripped.indexOf(first)), add, full });
    } else if (readContentOn) {
      // ★ AX-22：read 正文不是 JSON（源码/文本）时，短值行本身就是 K-2 要留的值（K2-N2 / K2-N3）。
      collectReadContentValues({ contentText: stripped, add, full, limits });
    }
  }

  return out;
}

/* ───────────────────────────── 限制 / source ───────────────────────────── */

function resolveLimits(input) {
  const pick = (raw, fallback, min, max) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  return {
    maxFacts: pick(input.maxFacts, VALUE_FACT_LIMITS.maxFacts, 1, 32),
    maxValueChars: pick(input.maxValueChars, VALUE_FACT_LIMITS.maxValueChars, 16, 1024),
    maxQuoteChars: pick(input.maxQuoteChars, VALUE_FACT_LIMITS.maxQuoteChars, 32, 2048),
    maxResultChars: pick(input.maxResultChars, VALUE_FACT_LIMITS.maxResultChars, 1024, 8_000_000),
  };
}

function sourceOf(tool) {
  const name = normalizeToolName(tool);
  return `tool:${name === "" ? "unknown" : name}`;
}

/**
 * 工具名 → 规范形（小写、非字母数字压成下划线、去首尾下划线、截断 40）。
 *
 * 为什么必须共用：K-2 派生值事实时要判「这条事实的来源工具」与「这条边是哪个工具发起的」
 * 是不是同一个 —— 一边是 `fact.source`（`tool:github`），一边是 `edge.action`
 * （`github(path=repos/o/r)`，keeper 的 `actionSummary` 形状）。两侧各写一份归一化，
 * 等于给同一个工具造出两个名字，匹配就恒假。
 */
export function normalizeToolName(tool) {
  return String(tool ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** `tool:github` → `github`；不是 `tool:` 前缀 ⇒ 空串（**不猜**）。 */
export function toolNameFromSource(source) {
  const m = /^tool:(.*)$/.exec(String(source ?? "").trim());
  return m === null ? "" : m[1];
}

/** `github(path=repos/o/r)` → `github`（`actionSummary` 形状）；没有括号 ⇒ 整串；空 ⇒ 空串。 */
export function toolNameFromAction(action) {
  const text = String(action ?? "").trim();
  if (text === "") return "";
  const m = /^([^(]*?)\(/.exec(text);
  return normalizeToolName(m === null ? text : m[1]);
}

/* ─────────────────── 结果可信度：GitHub 读形（AX-21 起为唯一来源） ─────────────────── */

/**
 * **工具本身就是 GitHub REST 端点**的几种名字。
 *
 * 只认这几种，是因为「HTTP 方法在实参里」这件事只有这类工具成立：
 *   · `github`（DSH 的 github 工具：`{path, method?, body?, confirm?}`，method 缺省 GET）；
 *   · 少数命名空间形态（`mcp__github` / `github_api` …）。
 * **绝不能**用 `includes("github")` 之类的一刀切 ——
 *   `mcp__github__create_pull_request` 这类 MCP 工具的方法在**名字**里、实参里没有 `method`，
 *   按「无 method ⇒ GET」判就会把写调用标成弱成功（任务书 AX-04 明令禁止）。
 *   它们的 `toolClass` 已经是 mcp-read / mcp-write，走 classify 自己的 weak，不需要这里兜。
 */
const GITHUB_REST_TOOLS = new Set(["github", "github_api", "github__api", "mcp__github", "mcp__github_api"]);

/** HTTP 的读形方法（无副作用、结果就是「读到的值」）。 */
const GITHUB_READ_METHODS = new Set(["GET", "HEAD"]);

/** 这次 github 调用是不是**读形**（GET/HEAD，或没给 method 的缺省 GET）。 */
export function githubReadShaped(toolName, args) {
  const name = String(toolName ?? "").trim().toLowerCase();
  if (!GITHUB_REST_TOOLS.has(name)) return false;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const method = typeof a.method === "string" ? a.method.trim().toUpperCase() : "";
  // 显式给了方法：只有 GET/HEAD 算读（POST/PATCH/PUT/DELETE/其它一律不是）
  if (method !== "") return GITHUB_READ_METHODS.has(method);
  // 没给方法 ⇒ 工具缺省 GET。但**出现写形状的实参**就不是读：
  //   `body` 只有写方法才带；`confirm: true` 是写方法的确认闸（读调用永远不会设）。
  if (a.body !== undefined && a.body !== null) return false;
  if (a.confirm === true) return false;
  return true;
}

/**
 * ★ AX-22：「这次结果算不算**读**」—— 两个新形状（read 正文行值 / 顶层 JSON 数组）
 * 共用的**工具形闸**，判据的唯一来源。
 *
 * 只认两种：
 *   · 会回 `<path>/<content>` 包络的只读工具（`read` / `read_file`）；
 *   · GitHub REST 端点的读形（GET / HEAD / 缺省 GET —— 写形的实参 `body` / `confirm:true` 不算）。
 *
 * 为什么必须是纯函数并导出：K-2 的派生路径（`scripts/k2-value-reader.mjs`）要在**打开开关前**
 * 先判一次工具形（只有读形才传 `true`），而抽取器内部还要再判一次（防调用方乱传）。
 * 两处各写一份正则，等于给「什么算读」造出两个答案 —— 那正是 AX-21 收口掉的错误。
 *
 * @param {unknown} toolName tool-call 的工具名
 * @param {unknown} args tool-call 的实参（只读 `method` / `body` / `confirm` 三个键）
 * @returns {boolean}
 */
export function readShapeForValueFacts(toolName, args) {
  const name = normalizeToolName(toolName);
  if (READ_CONTENT_TOOLS.has(name)) return true;
  return githubReadShaped(name, args);
}

/**
 * 给 `extractValueFacts` 的 `resultKind`（抽取器的**信任闸**，不是边上的 result）。
 *
 * ⚠ 这个函数**不许改 `verdict`**：边的 `result` 永远是 classify 的判定。
 *   github 读形在这里被当成 `weak` 只是「结果里的 id/private 是可回证的读到的值」，
 *   **不是**「这次调用成功了」—— 边仍然是 `unverified`（S2a 的弱成功语义）。
 *
 * 纯函数、不抛（坏 `verdict` 按「没有弱成功」处理）：在线（keeper）与离线
 * （`collectFoldValueFacts`）拿到的是**逐字段相同**的结果 —— 这是 K-2 两条路径同源的形式判据。
 *
 * @param {{result?:string, weak?:string|null}} verdict classify 的返回值
 * @param {string} toolName tool-call 的工具名
 * @param {unknown} args tool-call 的实参
 * @returns {"success"|"failure"|"unverified"|"weak"|"read"|"shell"}
 */
export function resultKindForValueFacts(verdict, toolName, args) {
  const v = verdict !== null && typeof verdict === "object" ? verdict : {};
  if (v.result === "success") return "success";
  if (v.result === "failure") return "failure";
  // 剩下的只有 unverified：classify 自己的弱成功（read / shell）优先
  if (typeof v.weak === "string" && v.weak !== "") return v.weak;
  // K-2 S2-Q3 的真实形状：github 读形结果被 classify 判 unverified 且**没有** weak
  if (githubReadShaped(toolName, args)) return "weak";
  return "unverified";
}

/** 末条非空行若是 `[exit code: N]` 就返回 N（壳命令的退出码标记）；否则 null。 */
function trailingExitCode(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    const m = /^\[exit code:\s*(-?\d+)\]$/.exec(line);
    return m === null ? null : Number(m[1]);
  }
  return null;
}

/* ───────────────────────────── 文件包络 ───────────────────────────── */

/**
 * 解析 DSH 文件类工具的回执包络：
 *   `<path>…</path>\n<type>file</type>\n<content>\n…\n</content>`
 * `<content>` 里**只有** `Created file` / `Updated file` 时才认作写回执；
 * 其余内容（read 的正文）只提供路径。
 */
function readFileEnvelope(text) {
  const pathOpen = text.indexOf("<path>");
  if (pathOpen < 0) return null;
  const pathBodyStart = pathOpen + 6;
  const pathCloseAt = text.indexOf("</path>", pathBodyStart);
  if (pathCloseAt < 0) return null;
  const path = text.slice(pathBodyStart, pathCloseAt).trim();
  if (path === "") return null;

  let contentOpen = -1;
  let contentClose = -1;
  let receipt = null;
  let receiptEnd = -1;
  const open = text.indexOf("<content>", pathCloseAt);
  if (open >= 0) {
    const close = text.indexOf("</content>", open + 9);
    if (close >= 0) {
      contentOpen = open;
      contentClose = close;
      const body = text.slice(open + 9, close);
      const m = /^\s*(Created file|Updated file)\s*$/.exec(body);
      if (m !== null) {
        receipt = m[1];
        const wordAt = body.indexOf(m[1]);
        receiptEnd = open + 9 + wordAt + m[1].length;
      }
    }
  }
  return { path, pathOpen, pathClose: pathCloseAt + 7, contentOpen, contentClose, receipt, receiptEnd };
}

/**
 * 写回执的 quote：从 `<path>` 到 `Created file`/`Updated file` 的**连续原文**。
 * 太长（极端深路径）时退回 `<path>…</path>` 单行 —— 仍然逐字，仍能回证「哪个文件」。
 */
function blockQuote(text, envelope, maxQuoteChars) {
  if (envelope.receiptEnd > envelope.pathOpen) {
    const block = text.slice(envelope.pathOpen, envelope.receiptEnd);
    if (block.length <= maxQuoteChars) return block;
  }
  return text.slice(envelope.pathOpen, envelope.pathClose);
}

/* ───────────────────────────── JSON ───────────────────────────── */

const CONFIG_EXCLUDE_RE = /(?:^|_)(?:url|uri|link|href|html|avatar|content|body|text|patch|diff|message|description|sha|token|secret|password|key)$/i;

/**
 * 从一个 JSON **对象**文本里抽标量事实（只抽顶层；嵌套对象/数组整块跳过）。
 *
 * 为什么不要求整份 JSON 可解析：K-2 S2-Q3 的真实结果是 `gh api` 的 JSON **后面还跟着
 * `[exit code: 0]`**，而大结果还可能被宿主截断。整份 `JSON.parse` 会直接失败，
 * 但 `"id"` / `"private"` 明明已经完整出现在前缀里 —— 那正是要留住的短值。
 * 所以判据是「顶层成员扫描到哪算到哪」：完整成员照抽，截断处停下。
 *
 * @param {{jsonText:string, add:(kind:string,value:any,quote:string)=>void}} args
 *   `jsonText` 既是被扫描的那段，也是 quote 的来源（read 的行号前缀已剥掉；标量片段不含前缀）。
 */
function collectJsonFacts({ jsonText, add }) {
  const members = scanTopLevelMembers(jsonText);
  if (members.length === 0) return;

  // 整份可解析时先做数组/类型判定；不可解析（截断/尾随文本）时按成员前缀继续。
  let parsed;
  let parsedOk = false;
  try {
    parsed = JSON.parse(jsonText);
    parsedOk = true;
  } catch {
    /* 截断或尾随文本：按成员前缀抽 */
  }
  if (parsedOk) {
    if (parsed === null || typeof parsed !== "object") return;
    if (Array.isArray(parsed)) return;
  }

  /** 取成员自己的标量值（重复键以**第一次**出现为准；解析不了的成员跳过）。 */
  const valueCache = new Map();
  const valueOf = (member) => {
    if (valueCache.has(member.key)) return valueCache.get(member.key);
    let box;
    try {
      const value = JSON.parse(`{${jsonText.slice(member.keyStart, member.valueEnd)}}`)[member.key];
      box = { ok: value !== undefined, value };
    } catch {
      box = { ok: false, value: undefined };
    }
    valueCache.set(member.key, box);
    return box;
  };

  // 错误结果：`{"error":…}` / `{"ok":false}` / `{"status":"error"}` 一律不当成功值。
  //   即使整份 JSON 被截断，只要前缀里出现了这些键，也按错误处理（保守优先）。
  for (const member of members) {
    if (!["error", "ok", "success", "status"].includes(member.key)) continue;
    const box = valueOf(member);
    if (!box.ok) continue;
    if (member.key === "error" && box.value !== null && box.value !== undefined) return;
    if ((member.key === "ok" || member.key === "success") && box.value === false) return;
    if (member.key === "status" && typeof box.value === "string" && /^(?:error|failed|failure|fail)$/i.test(box.value)) return;
  }

  const seenKeys = new Set();
  for (const member of members) {
    if (seenKeys.has(member.key)) continue;
    seenKeys.add(member.key);
    const firstChar = jsonText[member.valueStart];
    if (firstChar === "{" || firstChar === "[") continue; // 嵌套结构整块跳过（大结果只留短标量）
    if (CONFIG_EXCLUDE_RE.test(member.key)) continue;

    const box = valueOf(member);
    if (!box.ok) continue;
    const kind = classifyJsonMember(member.key, box.value);
    if (kind === null) continue;
    if (typeof box.value === "string" && !acceptableString(box.value)) continue;
    add(kind, box.value, jsonText.slice(member.keyStart, member.valueEnd));
  }
}

function classifyJsonMember(key, value) {
  if (isIdKey(key)) {
    if (typeof value === "string" || typeof value === "number") return "id";
    return null;
  }
  if (typeof value === "boolean") return BOOLEAN_KEY_SET.has(key) ? "boolean" : null;
  if (CONFIG_KEY_SET.has(key) && (typeof value === "string" || typeof value === "number")) return "config";
  return null;
}

/** 字符串值必须是单行、短、无控制字符（JSON 里的 `\n` 是转义，抽出来会跨行）。 */
function acceptableString(value) {
  if (value.length === 0 || value.length > VALUE_FACT_LIMITS.maxValueChars) return false;
  if (value.includes("\n") || value.includes("\r") || value.includes("\u0000")) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

/**
 * 扫顶层对象的成员（只要 span，不做语义判断）：`{key, keyStart, valueStart, valueEnd}`。
 * 为什么要自己扫：`JSON.parse` 丢掉了空格与转义形态，而 quote 必须是**原文**的连续子串；
 * 而且大结果可能被截断（见 `collectJsonFacts` 的注释）。
 *
 * @returns {Array<{key:string,keyStart:number,valueStart:number,valueEnd:number}>}
 *   **已扫完的完整成员前缀**：不是对象 ⇒ 空数组；中途截断/语法坏 ⇒ 截断处之前的成员。
 */
function scanTopLevelMembers(text) {
  const members = [];
  let i = 0;
  const n = text.length;
  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i += 1;
  };
  skipWs();
  if (text[i] !== "{") return [];
  i += 1;
  skipWs();
  if (text[i] === "}") return members;
  for (;;) {
    skipWs();
    if (text[i] !== '"') return members;
    const keyStart = i;
    const keyEnd = skipJsonString(text, i);
    if (keyEnd < 0) return members;
    let key;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return members;
    }
    i = keyEnd;
    skipWs();
    if (text[i] !== ":") return members;
    i += 1;
    skipWs();
    const valueStart = i;
    const valueEnd = skipJsonValue(text, i);
    if (valueEnd < 0) return members;
    members.push({ key, keyStart, valueStart, valueEnd });
    i = valueEnd;
    skipWs();
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    return members;
  }
}

/** 从 `"` 起跳过一个 JSON 字符串，返回闭合引号之后的下标；未闭合返回 -1。 */
function skipJsonString(text, from) {
  let i = from + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/** 跳过一个 JSON 值（标量/对象/数组），返回结束下标（exclusive）；失败返回 -1。 */
function skipJsonValue(text, from) {
  const c = text[from];
  if (c === undefined) return -1;
  if (c === '"') return skipJsonString(text, from);
  if (c === "{" || c === "[") {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i = skipJsonString(text, i);
        if (i < 0) return -1;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }
  let i = from;
  while (i < text.length && !",}]".includes(text[i]) && !/\s/.test(text[i])) i += 1;
  return i > from ? i : -1;
}

/* ═══════════════════ AX-22：read 正文行值 / 顶层 JSON 数组 ═══════════════════
 *
 * 这两个形状都是**默认关闭**的（`allowReadContent` / `allowTopLevelArray`），且只在
 * 「这次结果是读形」时生效。为什么默认关：线上 keeper 的 `extractValueFacts` 调用不传 options，
 * 于是 `graph.json` 的字节形状、旧语料的事实集、契约第 3 条（数组实参不得当返回值）全部逐字不变。
 */

/** 行首是注释标记 ⇒ 这行是**散文**，不是值（K-2 的 read 正文前 50 行全是文档注释）。 */
const COMMENT_LINE_RE = /^(?:\/\/|\/\*|\*|#)/;

/**
 * 行内必须至少有一个**标量字面量**（引号串 / 数字 / `true|false`），否则只是语句骨架。
 *
 * 为什么需要：`<content>` 是整份源码，`export const X = [` / `{` / `});` 这类骨架行
 * 挤进 `maxFacts` 的额度后，真正带值的行（`id: 'codearts',`）反而落选 ——
 * K2-N2 / K2-N3 的答案行就会因为「前 N 行全是散文/骨架」而永远进不了图。
 */
const SCALAR_LITERAL_RE = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|-?\b\d+(?:\.\d+)?\b|\b(?:true|false)\b/;

/**
 * 从 **read 正文**（已剥掉 `N: ` 行号前缀）里抽短值行。
 *
 * 判据（与 `collectPlainValue` 同一精神，只是一行一行看）：
 *   · 非空、≤ `maxValueChars`、含字母/数字、不是注释行、不是寒暄/错误行、含标量字面量；
 *   · `value` = 该行（去首尾空白），`quote` = 同一行逐字（`add` 的 `includes` 兜底再验一次）；
 *   · 条数由 `maxFacts` 封顶（`full()` 一到就停）。
 *
 * @param {{contentText:string, add:(kind:string,value:any,quote:string)=>boolean, full:()=>boolean, limits:{maxFacts:number,maxValueChars:number}}} args
 */
function collectReadContentValues({ contentText, add, full, limits }) {
  for (const line of String(contentText ?? "").split("\n")) {
    if (full()) return;
    const value = line.trim();
    if (value === "") continue;
    if (value.length > limits.maxValueChars) continue;
    if (COMMENT_LINE_RE.test(value)) continue;
    if (value.includes("\u0000") || value.includes("[exit code:")) continue;
    if (ACK_RE.test(value) || TEXT_ERROR_RE.test(value)) continue;
    if (!SCALAR_LITERAL_RE.test(value)) continue;
    add("value", value, value);
  }
}

/** 顶层数组里要跳过的键：URL 类字段动辄上百字符，占额度却不是「短值」。 */
const ARRAY_VALUE_EXCLUDE_RE = /(?:^|_)(?:url|uri|href|link)$/i;

/**
 * 从**顶层 JSON 数组**里抽标量：数组元素本身是标量就抽它；是对象就抽它的**顶层标量字段**
 * （`name` / `path` / `sha` / `size` 这种；嵌套对象/数组整块跳过）。
 *
 * 为什么需要：GitHub `contents` API 的结果就是 `[{name, path, sha, size, …}, …]`
 * （K2-N5 / K2-N6），而契约第 3 条为了防「`todo_write` 把入参数组回显成结果」一律不抽数组 ——
 * 于是这两题的答案（`sha` / `size`）在压缩上下文里一条都没有。
 *
 * `quote` 一律是**原 JSON 片段**（对象字段是 `"sha":"…"`，数组元素是元素原文），
 * 所以模型能逐字回证、守卫能 `includes` 复核；`value` 取标量的字符串形（数字 `23738` → `"23738"`），
 * 与 `kind:"value"` 的渲染契约（`normalizeValueFact` 只接受字符串值）对齐。
 *
 * @param {{jsonText:string, add:(kind:string,value:any,quote:string)=>boolean, full:()=>boolean}} args
 *   `jsonText` 既是被扫描的那段，也是 quote 的来源（read 的行号前缀已剥掉）
 */
function collectJsonArrayFacts({ jsonText, add, full }) {
  for (const element of scanTopLevelElements(jsonText)) {
    if (full()) return;
    const elementFirst = jsonText[element.start];
    if (elementFirst === "[") continue; // 嵌套数组整块跳过（大结果只留短标量）
    if (elementFirst === "{") {
      const slice = jsonText.slice(element.start, element.end);
      for (const member of scanTopLevelMembers(slice)) {
        if (full()) return;
        if (ARRAY_VALUE_EXCLUDE_RE.test(member.key)) continue; // URL/URI 这类长串不是短值
        const memberFirst = slice[member.valueStart];
        if (memberFirst === "{" || memberFirst === "[") continue;
        const quote = slice.slice(member.keyStart, member.valueEnd);
        let value;
        try {
          value = JSON.parse(`{${quote}}`)[member.key];
        } catch {
          continue;
        }
        const scalar = scalarText(value);
        if (scalar === null) continue;
        add("value", scalar, quote);
      }
      continue;
    }
    const raw = jsonText.slice(element.start, element.end);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue; // 截断处之后的元素不猜
    }
    const scalar = scalarText(value);
    if (scalar === null) continue;
    add("value", scalar, raw);
  }
}

/** 标量 → `kind:"value"` 的字符串值；对象/数组/超长串/控制字符 ⇒ null。 */
function scalarText(value) {
  if (typeof value === "string") return acceptableString(value) ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  return null;
}

/**
 * 扫顶层**数组**的元素 span（只要边界，不做语义判断）：`{start, end}`。
 * 与 `scanTopLevelMembers` 同一条纪律：截断/语法坏 ⇒ 返回**已经扫完的完整前缀**。
 *
 * @returns {Array<{start:number, end:number}>}
 */
function scanTopLevelElements(text) {
  const elements = [];
  let i = 0;
  const n = text.length;
  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i += 1;
  };
  skipWs();
  if (text[i] !== "[") return elements;
  i += 1;
  for (;;) {
    skipWs();
    if (text[i] === "]") return elements;
    const start = i;
    const end = skipJsonValue(text, i);
    if (end < 0) return elements;
    elements.push({ start, end });
    i = end;
    skipWs();
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    return elements;
  }
}

/* ───────────────────────────── read 的行号前缀 ───────────────────────────── */

/**
 * read 的 `<content>` 是「行号 + 正文」：`1: {`。先把 `N: ` 前缀剥掉再解析 JSON。
 * 只剥行首前缀 —— 标量片段（`"id": 1`）本来就不含它，所以 quote 仍是原文子串。
 *
 * @param {string} content `<content>` 与 `</content>` 之间的原文
 * @returns {string} 剥掉 `N: ` 前缀后的文本（行数与换行保持不变）
 */
function stripReadLineNumbers(content) {
  const parts = [];
  let lineStart = 0;
  for (let i = 0; i <= content.length; i += 1) {
    if (i !== content.length && content[i] !== "\n") continue;
    const line = content.slice(lineStart, i);
    const m = /^[ \t]*\d+:[ \t]?/.exec(line);
    parts.push(m === null ? line : line.slice(m[0].length));
    lineStart = i + 1;
  }
  return parts.join("\n");
}

/* ───────────────────────────── 纯文本短值 ───────────────────────────── */

/**
 * 单行短结果本身就是值（K-2 pilot 的 `uname -s` → `MINGW64_NT-10.0-26200`）。
 * 只收一行、≤ maxValueChars、非寒暄、非错误、非 XML/JSON 开头。
 */
function collectPlainValue(trimmed, add) {
  if (trimmed.length === 0 || trimmed.length > VALUE_FACT_LIMITS.maxValueChars) return;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return;
  if (trimmed.includes("\u0000") || trimmed.includes("[exit code:")) return;
  if (/^[<{["']/.test(trimmed)) return;
  if (ACK_RE.test(trimmed)) return;
  if (TEXT_ERROR_RE.test(trimmed)) return;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return;
  add("value", trimmed, trimmed);
}

/* ───────────────────────────── 校验器 ───────────────────────────── */

const FACT_KEYS = Object.freeze(["kind", "value", "quote", "evidenceSeq", "validAtSeq", "source"].sort());
const FILE_KINDS = new Set(["file_created", "file_updated", "file_path"]);

/**
 * 一条值事实是否满足契约（下游落盘/渲染前可再验一次；也用于测试的逐条自检）。
 * 只认**恰好**六个字段 —— 多字段会让「契约是什么」再次变成口头约定。
 */
export function isValueFact(fact) {
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) return false;
  const keys = Object.keys(fact).sort();
  if (keys.length !== FACT_KEYS.length || !keys.every((k, i) => k === FACT_KEYS[i])) return false;
  if (!VALUE_FACT_KINDS.includes(fact.kind)) return false;
  if (FILE_KINDS.has(fact.kind)) {
    if (typeof fact.value !== "string" || fact.value === "") return false;
  } else if (fact.kind === "boolean") {
    if (typeof fact.value !== "boolean") return false;
  } else if (fact.kind === "id" || fact.kind === "config") {
    if (typeof fact.value !== "string" && !(typeof fact.value === "number" && Number.isFinite(fact.value))) return false;
  } else if (fact.kind === "value") {
    if (typeof fact.value !== "string" || fact.value === "") return false;
  }
  if (typeof fact.quote !== "string" || fact.quote === "" || fact.quote.includes("\u0000")) return false;
  if (!Number.isSafeInteger(fact.evidenceSeq) || fact.evidenceSeq < 0) return false;
  if (!Number.isSafeInteger(fact.validAtSeq) || fact.validAtSeq < 0) return false;
  if (typeof fact.source !== "string" || !/^tool:[a-z0-9_.-]+$/.test(fact.source)) return false;
  return true;
}
