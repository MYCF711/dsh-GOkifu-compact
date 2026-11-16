#!/usr/bin/env node
/**
 * query-recall-stage-a.mjs —— Q1 查询召回的 Stage A 评测（**零模型调用**，默认只读）
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────────
 *   把 `renderQueryRecall(graph, queryText, {limit, maxChars}) => {text, anchors, items, stats}`
 *   放在**纯合成棋谱 + 合成 query** 上跑一遍，判三件事：
 *     ① 该召回的确定性文件/符号锚点在不在（expected / mandatory）；
 *     ② 不该出现的证据有没有被塞进来（forbidden / forbiddenAnchors）；
 *     ③ 契约边界：`maxChars` 预算、`limit` 上限、无锚点必须空串、重复渲染逐字节一致。
 *   全程**不调模型、不读真实会话**（除非显式 `--home` 跑只读性能基准）。
 *
 * ── 两种模式（互斥） ──────────────────────────────────────────────────────────
 *   node scripts/query-recall-stage-a.mjs
 *       默认：只读合成夹具，打印逐题与聚合；**任何一题失败即 exit 1**。
 *       `--write` 才写 `evidence/query-recall-stage-a.json`，且只写合成聚合
 *       （不写图、不写 query、不写正文、不写会话 id/路径）。
 *
 *   node scripts/query-recall-stage-a.mjs --home <DSH_HOME>
 *       可选：只读真实最大图性能基准 —— 只按 `graph.json` 字节选最大的一张，
 *       经**仓库既有 delta 回放读图器**（`scripts/graph-audit.mjs` 的 `loadSessionGraph`）
 *       加载后反复渲染固定合成 query；输出只有节点/边/字节/时延/RSS 聚合，
 *       **绝不输出会话 id、路径或正文**；不写盘。
 *
 * ── 参数 ─────────────────────────────────────────────────────────────────────
 *   --impl <path>       被测实现（默认 `src/rooms/query-recall.mjs`）
 *   --fixtures <path>   夹具（默认 `evidence/query-recall-stage-a.fixtures.json`）
 *   --json              机读输出
 *   --write             Stage A 通过时写合成聚合证据（与 --home 互斥）
 *   --iterations <n>    --home 基准每题渲染次数（默认 20）
 *   --help
 *
 * ── 退出码 ───────────────────────────────────────────────────────────────────
 *   0 = Stage A 全过 / 基准跑完；1 = 有题失败（真红，不写盘）；
 *   2 = 参数/夹具错误；3 = core 未实现或未导出 `renderQueryRecall`（尚不能评测）。
 *
 * ── 边界 ─────────────────────────────────────────────────────────────────────
 *   · 只写 `evidence/query-recall-stage-a.json`（且必须 `--write` 且 Stage A 通过）；
 *   · 不改核心代码、不改夹具、不 commit；`--home` 模式对真实图**只读**；
 *   · 失败分支可返回「不通过」：缺证据/误召/超预算/不稳定都会 exit 1（不是永远绿的门）。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fromJSON, validate } from "../src/rooms/kifu-model.mjs";
import { graphRoot } from "../src/rooms/kifu-persist.mjs";
import { parseTouchedFileAction } from "../src/rooms/touched-files.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
export const REPO = nodePath.resolve(HERE, "..");
export const DEFAULT_IMPL = nodePath.join(REPO, "src", "rooms", "query-recall.mjs");
export const DEFAULT_FIXTURES = nodePath.join(REPO, "evidence", "query-recall-stage-a.fixtures.json");
export const STAGE_A_EVIDENCE = nodePath.join(REPO, "evidence", "query-recall-stage-a.json");

/** 夹具必须覆盖的五类（`evidence/query-recall-stage-a.fixtures.json` 的 families 是同一份清单）。 */
export const REQUIRED_FAMILIES = Object.freeze(["file-anchor", "symbol-anchor", "no-anchor", "failure-reason", "budget-and-order"]);

/** 退出码（测试与文档共用一份）。 */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, IMPL_MISSING: 3 });

/** 基准用的固定合成 query（与真实会话无关；真实图只读，不改写任何字节）。 */
export const BENCH_QUERIES = Object.freeze([
  "src/rooms/query-recall.mjs renderQueryRecall",
  "ledger.mjs renderLedger 预算",
  "为什么失败 TypeError",
  "applyDelta decodeDeltaFrames",
  "这个怎么办？",
]);

/**
 * 真实图基准的派生锚点上限：从图**内部**选路径与 render/ledger 符号，保证至少有一条命中 query。
 * 这些 query 只存在于内存，**绝不**出现在任何输出里。
 */
export const BENCH_MAX_DERIVED_PATHS = 10;
export const BENCH_MAX_DERIVED_SYMBOLS = 2;

const nowIso = () => new Date().toISOString();
const basenameOf = (file) => nodePath.basename(String(file ?? ""));
const round = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;

/** 排序后取分位（p 为 0–100；最近秩，样本不足时取最大）。 */
export function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[rank];
}

/** 公开输出脱敏：绝不让绝对路径 / 会话 id 形状漏出去（基准与错误信息都走这里）。 */
export function redactPath(text) {
  return String(text ?? "")
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "<path>")
    .replace(/(?:\/(?:home|Users|root)\/[^\s"'`]*)/g, "<path>")
    .replace(/\bsession-[0-9a-f]{8,}\b/gi, "<session>");
}

const safeJson = (value) => {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
};

const charLength = (text) => Array.from(String(text ?? "")).length;

/**
 * `anchors` 的两种合法形态：字符串数组，或 `{paths, symbols}` 这样的字符串数组对象
 * （Q1 实现是后者）。返回扁平列表；既不是数组也不是对象 ⇒ null（契约错误）。
 */
function anchorList(anchors) {
  if (Array.isArray(anchors)) return anchors;
  if (anchors !== null && typeof anchors === "object") {
    const out = [];
    for (const key of ["paths", "symbols", "files", "items"]) if (Array.isArray(anchors[key])) out.push(...anchors[key]);
    return out;
  }
  return null;
}
const sha256 = (text) => nodeCrypto.createHash("sha256").update(String(text ?? "")).digest("hex");

/** 实现文件的字节级 sha256（Stage B 冻结核验用）；读不到返回 null（不编造）。 */
const sha256File = (file) => {
  try {
    return nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

class UsageError extends Error {}
class ImplMissingError extends Error {
  constructor(message, { file = DEFAULT_IMPL } = {}) {
    super(message);
    this.file = file;
  }
}

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 夹具缺字段/引用悬空 = 使用错误（exit 2），不是评测失败。 */
export function loadFixtures(file = DEFAULT_FIXTURES) {
  let text;
  try {
    text = nodeFs.readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`读不到夹具：${basenameOf(file)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError(`夹具不是合法 JSON：${basenameOf(file)}`);
  }
  if (data?.schema !== "query-recall-stage-a-fixtures") throw new UsageError(`夹具 schema 不是 query-recall-stage-a-fixtures：${basenameOf(file)}`);
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) throw new UsageError("夹具没有 tasks");
  if (data.graphs === null || typeof data.graphs !== "object") throw new UsageError("夹具没有 graphs");
  if (!Array.isArray(data.families)) throw new UsageError("夹具没有 families");

  const ids = new Set();
  const tasks = data.tasks.map((task, index) => {
    const id = String(task?.id ?? `#${index + 1}`);
    if (ids.has(id)) throw new UsageError(`夹具任务 id 重复：${id}`);
    ids.add(id);
    if (typeof task?.query !== "string" || task.query === "") throw new UsageError(`${id} 缺 query`);
    if (typeof task?.graph !== "string" || data.graphs[task.graph] === undefined) throw new UsageError(`${id} 引用了不存在的 graph`);
    const options = task.options ?? {};
    if (!Number.isFinite(Number(options.limit)) || Number(options.limit) <= 0) throw new UsageError(`${id} 的 limit 非法`);
    if (!Number.isFinite(Number(options.maxChars)) || Number(options.maxChars) <= 0) throw new UsageError(`${id} 的 maxChars 非法`);
    for (const key of ["expected", "mandatory", "forbidden", "expectedAnchors", "forbiddenAnchors"]) {
      if (task[key] !== undefined && !Array.isArray(task[key])) throw new UsageError(`${id} 的 ${key} 不是数组`);
    }
    return {
      ...task,
      id,
      options: { limit: Number(options.limit), maxChars: Number(options.maxChars) },
      expected: task.expected ?? [],
      mandatory: task.mandatory ?? [],
      forbidden: task.forbidden ?? [],
      expectedAnchors: task.expectedAnchors ?? [],
      forbiddenAnchors: task.forbiddenAnchors ?? [],
      expectEmptyText: task.expectEmptyText === true,
      expectNoAnchors: task.expectNoAnchors === true,
      maxItems: task.maxItems === null || task.maxItems === undefined ? null : Number(task.maxItems),
      repeat: Math.max(1, Math.min(20, Number(task.repeat) || 1)),
      minRecall: task.minRecall === null || task.minRecall === undefined ? null : Number(task.minRecall),
    };
  });
  return { data, text, file, tasks };
}

/** 每个图都必须是仓库能加载的合法棋谱（合成也要过同一套 validate）。 */
export function checkFixtureGraphs(fixtures) {
  const problems = [];
  for (const [name, graph] of Object.entries(fixtures.data.graphs)) {
    try {
      const parsed = fromJSON(JSON.stringify(graph));
      for (const problem of validate(parsed)) problems.push(`${name}: ${problem}`);
    } catch (error) {
      problems.push(`${name}: 无法加载（${redactPath(error?.message ?? error).slice(0, 120)}）`);
    }
  }
  return problems;
}

/* ───────────────────────────── 评测 ───────────────────────────── */

function renderOnce(impl, graph, task) {
  const started = process.hrtime.bigint();
  const result = impl.renderQueryRecall(graph, task.query, { ...task.options });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { result, ms };
}

const anchorMatcher = (matcher) => (typeof matcher === "string" ? matcher : String(matcher?.contains ?? ""));

/** 对一题跑 `repeat` 次并判定（纯函数，测试可直接调用）。 */
export function evaluateTask(impl, graph, task) {
  const problems = [];
  const msSamples = [];
  const runs = [];
  for (let attempt = 0; attempt < task.repeat; attempt += 1) {
    try {
      const { result, ms } = renderOnce(impl, graph, task);
      msSamples.push(ms);
      runs.push(result);
    } catch (error) {
      problems.push(`实现抛错：${redactPath(error?.message ?? error).slice(0, 160)}`);
      break;
    }
  }
  const row = {
    id: task.id,
    class: task.class ?? null,
    family: task.family ?? null,
    ok: false,
    problems,
    chars: 0,
    anchors: 0,
    items: 0,
    recall: { matched: 0, expected: task.expected.length },
    misses: [],
    falsePositives: [],
    msSamples,
    ms: null,
  };
  if (runs.length === 0) return row;

  const first = runs[0];
  const firstText = typeof first?.text === "string" ? first.text : "";
  const firstAnchors = first?.anchors ?? [];
  const firstItems = Array.isArray(first?.items) ? first.items : [];
  row.chars = charLength(firstText);
  const anchorValues = anchorList(firstAnchors);
  row.anchors = anchorValues === null ? 0 : anchorValues.length;
  row.items = firstItems.length;
  row.ms = round(percentile(msSamples, 50), 3);

  // 契约形状：返回对象，text/items 类型正确；anchors 允许数组或 {paths, symbols} 对象。
  if (first === null || typeof first !== "object") problems.push("契约：返回值不是对象");
  if (typeof first?.text !== "string") problems.push("契约：text 不是字符串");
  if (anchorValues === null) problems.push("契约：anchors 既不是数组，也不是 {paths, symbols} 这类字符串数组对象");
  if (!Array.isArray(first?.items)) problems.push("契约：items 不是数组");
  if (first?.stats !== undefined && (first.stats === null || typeof first.stats !== "object")) problems.push("契约：stats 不是对象");

  // 逐字节稳定（重复渲染必须一致）。
  if (runs.length > 1) {
    const signature = (value) => safeJson({ text: value?.text, anchors: value?.anchors, items: value?.items });
    for (let index = 1; index < runs.length; index += 1) {
      if (signature(runs[index]) !== signature(first)) {
        problems.push(`稳定排序：第 ${index + 1} 次渲染与第 1 次逐字节不一致`);
        break;
      }
    }
  }

  // 证据文本只算渲染出来的 text/items；anchors 是**当前 query** 的锚点回显，不算证据。
  const anchorHaystack = safeJson(firstAnchors);
  const haystack = `${firstText}\n${safeJson(firstItems)}`;

  // 空证据契约：没有可用证据时必须空串 + 0 items；`expectNoAnchors` 才额外要求 query 也没有锚点。
  if (task.expectEmptyText) {
    if (firstText.trim() !== "") problems.push("空证据契约：text 不是空串");
    if (firstItems.length !== 0) problems.push(`空证据契约：items=${firstItems.length}（应为 0）`);
    if (task.expectNoAnchors && row.anchors !== 0) problems.push(`空锚点契约：anchors=${row.anchors}（应为 0）`);
  } else {
    if (row.anchors === 0) problems.push("漏召：anchors 为空");
    if (firstText.trim() === "" && firstItems.length > 0) problems.push("契约：有 item 却输出空串");
  }

  // 预算与上限。
  if (row.chars > task.options.maxChars) problems.push(`预算：text ${row.chars} 字符 > maxChars ${task.options.maxChars}`);
  const maxItems = task.maxItems ?? task.options.limit;
  if (row.items > maxItems) problems.push(`limit：items ${row.items} > 上限 ${maxItems}`);

  // 证据召回（expected 是分母；mandatory 是硬门槛）。
  const matchedExpected = task.expected.filter((needle) => haystack.includes(String(needle)));
  row.recall = { matched: matchedExpected.length, expected: task.expected.length };
  const missingMandatory = task.mandatory.filter((needle) => !haystack.includes(String(needle)));
  for (const needle of missingMandatory) {
    problems.push(`漏召：${needle}`);
    row.misses.push(String(needle));
  }
  for (const needle of task.forbidden) {
    if (haystack.includes(String(needle))) {
      problems.push(`误召：${needle}`);
      row.falsePositives.push(String(needle));
    }
  }
  for (const matcher of task.expectedAnchors) {
    const needle = anchorMatcher(matcher);
    if (needle !== "" && !anchorHaystack.includes(needle)) problems.push(`锚点缺失：${needle}`);
  }
  for (const matcher of task.forbiddenAnchors) {
    const needle = anchorMatcher(matcher);
    if (needle !== "" && anchorHaystack.includes(needle)) problems.push(`锚点误召：${needle}`);
  }
  if (task.minRecall !== null && row.recall.expected > 0) {
    const rate = row.recall.matched / row.recall.expected;
    if (rate + 1e-9 < task.minRecall) problems.push(`证据命中率 ${row.recall.matched}/${row.recall.expected} < minRecall ${task.minRecall}`);
  }

  row.ok = problems.length === 0;
  return row;
}

/** 汇总（只含计数/比例/字符/时延；不含图与 query）。 */
export function aggregateRows(rows) {
  const total = rows.length;
  const passed = rows.filter((row) => row.ok).length;
  const expected = rows.reduce((sum, row) => sum + row.recall.expected, 0);
  const matched = rows.reduce((sum, row) => sum + row.recall.matched, 0);
  const misses = rows.reduce((sum, row) => sum + row.misses.length, 0);
  const falsePositives = rows.reduce((sum, row) => sum + row.falsePositives.length, 0);
  const chars = rows.map((row) => row.chars);
  const ms = rows.flatMap((row) => row.msSamples);
  return {
    total,
    passed,
    failed: total - passed,
    evidence: { matched, expected, hitRate: expected === 0 ? null : round(matched / expected, 4) },
    misses,
    falsePositives,
    chars: { p50: percentile(chars, 50), p95: percentile(chars, 95), max: chars.length === 0 ? null : Math.max(...chars) },
    renderMs: { p50: round(percentile(ms, 50), 3), p95: round(percentile(ms, 95), 3), max: round(percentile(ms, 100), 3) },
  };
}

/** 载入被测实现；不存在或缺导出时抛 ImplMissingError（exit 3），不算评测失败。 */
export async function loadImpl(file = DEFAULT_IMPL) {
  if (!nodeFs.existsSync(file)) throw new ImplMissingError("core 尚未实现（文件不存在）", { file });
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new UsageError(`实现模块加载失败：${redactPath(error?.message ?? error).slice(0, 160)}`);
  }
  if (typeof mod.renderQueryRecall !== "function") throw new ImplMissingError("实现没有导出 renderQueryRecall", { file });
  return mod;
}

export function runStageA({ fixtures, impl }) {
  const rows = fixtures.tasks.map((task) => evaluateTask(impl, fixtures.data.graphs[task.graph], task));
  return { rows, summary: aggregateRows(rows) };
}

/* ───────────────────────────── 真实图只读基准 ───────────────────────────── */

/** 只按 graph.json 字节挑最大的一张；返回的 id **不**进公开输出。 */
export function scanLargestGraph(home) {
  const root = graphRoot({ dshHome: home });
  const sessionsDir = nodePath.join(root, "sessions");
  let entries = [];
  try {
    entries = nodeFs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const graphs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(sessionsDir, entry.name, "graph.json");
    try {
      const stat = nodeFs.statSync(file);
      if (stat.isFile()) graphs.push({ file, bytes: stat.size });
    } catch {
      /* 没有 graph.json 的会话目录是正常情况 */
    }
  }
  graphs.sort((a, b) => b.bytes - a.bytes);
  return graphs[0] ?? null;
}

/**
 * 从真实图**内部**派生保证命中的基准 query（路径锚点 + render/ledger 符号锚点）。
 *
 * 只用图的**已有字段**：`parseTouchedFileAction(edge.action)` 取文件路径；边字符串字段里取
 * `render*` / `ledger*` 标识符。派生 query 先渲染一次，**只保留真的产生证据的**——
 * 这样基准不会再用「不命中的 query」掩盖渲染成本。
 *
 * @returns {{pathQueries: Array<{query:string,hit:boolean}>, symbolQueries: Array<{query:string,hit:boolean}>, pathsTried:number, symbolsTried:number}}
 */
export function deriveBenchQueries(graph, impl) {
  const edges =
    graph !== null && typeof graph === "object" && graph.edges !== null && typeof graph.edges === "object" ? Object.values(graph.edges) : [];
  const paths = [];
  const seenPath = new Set();
  for (const edge of edges) {
    let path = null;
    try {
      path = parseTouchedFileAction(edge?.action);
    } catch {
      path = null;
    }
    if (typeof path !== "string" || path === "" || /\s/.test(path)) continue;
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    paths.push(path);
    if (paths.length >= BENCH_MAX_DERIVED_PATHS) break;
  }

  const symbols = [];
  const seenSymbol = new Set();
  const symbolRe = /(?<![A-Za-z0-9_$])((?:render|ledger)[A-Za-z0-9_$]{2,60})(?![A-Za-z0-9_$])/gi;
  outer: for (const edge of edges) {
    const fields = [edge?.action, edge?.intent, edge?.sig, edge?.text, edge?.verify?.summary, edge?.errorSnippet, edge?.result].filter(
      (value) => typeof value === "string" && value.trim() !== "",
    );
    for (const field of fields) {
      for (const match of field.matchAll(symbolRe)) {
        const symbol = match[1];
        if (seenSymbol.has(symbol)) continue;
        seenSymbol.add(symbol);
        symbols.push(symbol);
        if (symbols.length >= BENCH_MAX_DERIVED_SYMBOLS) break outer;
      }
    }
  }

  const probe = (query) => {
    try {
      return impl.renderQueryRecall(graph, query, { limit: 6, maxChars: 1200 })?.text ?? "";
    } catch {
      return "";
    }
  };
  return {
    pathQueries: paths.map((path) => ({ query: path, hit: probe(path).trim() !== "" })),
    symbolQueries: symbols.map((symbol) => ({ query: `${symbol}()`, hit: probe(`${symbol}()`).trim() !== "" })),
    pathsTried: paths.length,
    symbolsTried: symbols.length,
  };
}

/**
 * 最大真实图只读基准。输出**只有**节点/边/字节/时延/RSS 聚合与派生锚点**计数**：
 * 不输出会话 id、不输出路径、不输出符号原文、不输出节点正文、不写盘。
 */
export function benchLargestGraph({ home, impl, iterations = 20 }) {
  const picked = scanLargestGraph(home);
  if (picked === null) throw new UsageError("--home 下没有 chess-context/sessions（找不到可读的 graph.json）");
  const { graph, deltaFrames, deltaError } = loadSessionGraph(picked.file);
  const nodes = Object.keys(graph?.nodes ?? {}).length;
  const edges = Object.keys(graph?.edges ?? {}).length;

  const derived = deriveBenchQueries(graph, impl);
  const keptPaths = derived.pathQueries.filter((entry) => entry.hit);
  const keptSymbols = derived.symbolQueries.filter((entry) => entry.hit);
  if (keptPaths.length === 0) {
    throw new UsageError("真实图里没有可命中的文件路径，无法构造保证命中的 query（拒绝用不命中 query 冒充基准）");
  }
  const queries = [...BENCH_QUERIES, ...keptPaths.map((entry) => entry.query), ...keptSymbols.map((entry) => entry.query)];
  const fixedQueries = BENCH_QUERIES.length;

  // warmup：让 JIT / 索引缓存就位，不计时。
  for (const query of queries) {
    for (let i = 0; i < 2; i += 1) impl.renderQueryRecall(graph, query, { limit: 6, maxChars: 1200 });
  }
  const rssBefore = process.memoryUsage().rss;
  const samples = [];
  const derivedSamples = [];
  let charsMax = 0;
  let hits = 0;
  for (const [index, query] of queries.entries()) {
    const isDerived = index >= fixedQueries;
    for (let i = 0; i < iterations; i += 1) {
      const started = process.hrtime.bigint();
      const result = impl.renderQueryRecall(graph, query, { limit: 6, maxChars: 1200 });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      samples.push(ms);
      if (isDerived) derivedSamples.push(ms);
      const chars = charLength(result?.text);
      charsMax = Math.max(charsMax, chars);
      if (chars > 0) hits += 1;
    }
  }
  const rssAfter = process.memoryUsage().rss;
  const mb = (bytes) => round(bytes / 1024 / 1024, 1);
  const dist = (values) => ({
    p50: round(percentile(values, 50), 3),
    p95: round(percentile(values, 95), 3),
    max: round(percentile(values, 100), 3),
  });
  return {
    graphBytes: picked.bytes,
    nodes,
    edges,
    deltaFrames,
    deltaError: Boolean(deltaError),
    fixedQueries,
    queries: queries.length,
    derived: { pathsTried: derived.pathsTried, pathsHit: keptPaths.length, symbolsTried: derived.symbolsTried, symbolsHit: keptSymbols.length },
    iterationsPerQuery: iterations,
    samples: samples.length,
    renderMs: dist(samples),
    derivedRenderMs: dist(derivedSamples),
    chars: { max: charsMax },
    renderHits: { hit: hits, total: samples.length },
    rssMB: { before: mb(rssBefore), after: mb(rssAfter), delta: round((rssAfter - rssBefore) / 1024 / 1024, 1) },
  };
}

/* ───────────────────────────── 输出 ───────────────────────────── */

function formatStageA({ fixtures, implFile, rows, summary }, { json = false } = {}) {
  const ok = summary.failed === 0;
  const result = {
    ok,
    status: ok ? "PASS" : "FAIL",
    engine: "query-recall-stage-a",
    synthetic: true,
    zeroModelCalls: true,
    fixtures: { file: basenameOf(fixtures.file), sha256: sha256(fixtures.text), tasks: fixtures.tasks.length },
    impl: { file: basenameOf(implFile), sha256: sha256File(implFile) },
    tasks: rows.map((row) => ({
      id: row.id,
      class: row.class,
      family: row.family,
      passed: row.ok,
      chars: row.chars,
      anchors: row.anchors,
      items: row.items,
      recall: row.recall,
      ms: row.ms,
      problems: row.problems.map(redactPath),
    })),
    aggregate: summary,
  };
  if (json) return JSON.stringify(result, null, 2) + "\n";

  const lines = [];
  lines.push("Q1 Stage A · 查询召回零模型评测（纯合成夹具）");
  lines.push(`夹具：${basenameOf(fixtures.file)} · ${fixtures.tasks.length} 题 · ${new Set(rows.map((row) => row.family)).size} 类`);
  lines.push(`实现：${basenameOf(implFile)} · sha256 ${String(sha256File(implFile) ?? "n/a").slice(0, 16)}…`);
  lines.push("── 逐题 ──");
  for (const row of rows) {
    const flag = row.ok ? "✓" : "✗";
    lines.push(`${flag} ${row.id} ${row.class}  chars=${row.chars} anchors=${row.anchors} items=${row.items} recall=${row.recall.matched}/${row.recall.expected} ms=${row.ms}`);
    for (const problem of row.problems.map(redactPath)) lines.push(`    - ${problem}`);
  }
  lines.push("── 聚合 ──");
  const rate = summary.evidence.hitRate === null ? "n/a" : `${(summary.evidence.hitRate * 100).toFixed(1)}%`;
  lines.push(`通过 ${summary.passed}/${summary.total} · 证据命中 ${summary.evidence.matched}/${summary.evidence.expected}（${rate}）· 漏召 ${summary.misses} · 误召 ${summary.falsePositives}`);
  lines.push(`输出字符 p50=${summary.chars.p50} p95=${summary.chars.p95} max=${summary.chars.max}（零模型调用）`);
  lines.push(`渲染 ms p50=${summary.renderMs.p50} p95=${summary.renderMs.p95} max=${summary.renderMs.max}`);
  lines.push(`结论：${ok ? "PASS" : "FAIL"}`);
  return lines.join("\n") + "\n";
}

function writeEvidence({ fixtures, implFile, rows, summary }) {
  const payload = {
    schema: "query-recall-stage-a-result",
    version: 1,
    generatedAt: nowIso(),
    status: "PASS",
    synthetic: true,
    zeroModelCalls: true,
    command: "node scripts/query-recall-stage-a.mjs --write",
    fixtures: { file: basenameOf(fixtures.file), sha256: sha256(fixtures.text), tasks: fixtures.tasks.length },
    impl: { file: basenameOf(implFile), sha256: sha256File(implFile) },
    aggregate: summary,
    perTask: rows.map((row) => ({
      id: row.id,
      class: row.class,
      family: row.family,
      passed: row.ok,
      chars: row.chars,
      anchors: row.anchors,
      items: row.items,
      recall: row.recall,
      problems: row.problems.map(redactPath),
    })),
    notes: [
      "只含纯合成夹具的聚合与逐题计数；不含图、query、正文、会话 id 或路径。",
      "真实最大图的性能基准不进本文件（--home 模式只打印聚合，不落盘）。",
      "本文件不构成生产采纳结论：默认仍是 NOT_ADOPTED，Stage B 见 evidence/query-recall-prereg-v1.json。",
    ],
  };
  nodeFs.writeFileSync(STAGE_A_EVIDENCE, JSON.stringify(payload, null, 2) + "\n");
  return STAGE_A_EVIDENCE;
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const args = { json: false, write: false, home: null, impl: null, fixtures: null, iterations: 20, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} 需要一个值`);
      index += 1;
      return value;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--home") args.home = take("--home");
    else if (arg.startsWith("--home=")) args.home = arg.slice("--home=".length);
    else if (arg === "--impl") args.impl = take("--impl");
    else if (arg.startsWith("--impl=")) args.impl = arg.slice("--impl=".length);
    else if (arg === "--fixtures") args.fixtures = take("--fixtures");
    else if (arg.startsWith("--fixtures=")) args.fixtures = arg.slice("--fixtures=".length);
    else if (arg === "--iterations") args.iterations = Number(take("--iterations"));
    else throw new UsageError(`未知参数：${arg}`);
  }
  if (!Number.isFinite(args.iterations) || args.iterations < 1) throw new UsageError("--iterations 必须是正整数");
  if (args.write && args.home) throw new UsageError("--write 只写合成 Stage A 聚合，不能与 --home 同用");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`✗ ${redactPath(error.message)}\n用法：node scripts/query-recall-stage-a.mjs [--json] [--write] [--impl <path>] [--fixtures <path>] [--home <DSH_HOME>] [--iterations <n>]\n`);
    return EXIT.USAGE;
  }
  if (args.help) {
    process.stdout.write(
      [
        "node scripts/query-recall-stage-a.mjs                  # 合成 Stage A（零模型调用）",
        "node scripts/query-recall-stage-a.mjs --write          # 通过后写 evidence/query-recall-stage-a.json",
        "node scripts/query-recall-stage-a.mjs --home <DSH_HOME> # 最大真实图只读性能基准",
        "node scripts/query-recall-stage-a.mjs --json           # 机读",
      ].join("\n") + "\n",
    );
    return EXIT.OK;
  }

  const implFile = args.impl ? nodePath.resolve(args.impl) : DEFAULT_IMPL;
  let impl;
  try {
    impl = await loadImpl(implFile);
  } catch (error) {
    if (error instanceof ImplMissingError) {
      process.stdout.write(
        [
          `✗ 无法运行 Stage A：${error.message} —— ${basenameOf(error.file)}`,
          "  本评测不调用任何模型；core 落地后可原地重跑，静态守卫先跑：node test/run.mjs query-recall-stage-a",
          "  退出码 3 = 还不能评测（不是评测失败）。",
        ].join("\n") + "\n",
      );
      return EXIT.IMPL_MISSING;
    }
    process.stdout.write(`✗ ${redactPath(error.message)}\n`);
    return EXIT.USAGE;
  }

  if (args.home) {
    try {
      const bench = benchLargestGraph({ home: args.home, impl, iterations: args.iterations });
      if (args.json) process.stdout.write(JSON.stringify({ ok: true, mode: "bench", bench }, null, 2) + "\n");
      else {
        process.stdout.write("Q1 查询召回 · 最大真实图只读基准（零模型调用）\n");
        process.stdout.write(`图：${bench.graphBytes} B · ${bench.nodes} 节点 · ${bench.edges} 边 · delta 帧 ${bench.deltaFrames}${bench.deltaError ? "（有回放错误）" : ""}\n`);
        process.stdout.write(`渲染 ${bench.samples} 次（固定 ${bench.fixedQueries} + 路径锚点 ${bench.derived.pathsHit}/${bench.derived.pathsTried} + 符号锚点 ${bench.derived.symbolsHit}/${bench.derived.symbolsTried}；命中样本 ${bench.renderHits.hit}/${bench.renderHits.total}）：p50=${bench.renderMs.p50}ms p95=${bench.renderMs.p95}ms max=${bench.renderMs.max}ms\n`);
        process.stdout.write(`派生（保证命中）query 时延 p50=${bench.derivedRenderMs.p50}ms p95=${bench.derivedRenderMs.p95}ms max=${bench.derivedRenderMs.max}ms\n`);
        process.stdout.write(`输出字符 max=${bench.chars.max} · RSS ${bench.rssMB.before}→${bench.rssMB.after} MB（Δ${bench.rssMB.delta}）\n`);
        process.stdout.write("边界：只读；不输出会话 id / 路径 / 正文；不写盘。\n");
      }
      return EXIT.OK;
    } catch (error) {
      process.stdout.write(`✗ ${error instanceof UsageError ? redactPath(error.message) : "基准失败（细节已脱敏）"}\n`);
      return error instanceof UsageError ? EXIT.USAGE : EXIT.FAIL;
    }
  }

  let fixtures;
  try {
    fixtures = loadFixtures(args.fixtures ? nodePath.resolve(args.fixtures) : DEFAULT_FIXTURES);
  } catch (error) {
    process.stdout.write(`✗ ${redactPath(error.message)}\n`);
    return EXIT.USAGE;
  }
  const graphProblems = checkFixtureGraphs(fixtures);
  if (graphProblems.length > 0) {
    process.stdout.write(`✗ 夹具图不合法（${graphProblems.length} 条）：\n`);
    for (const problem of graphProblems.slice(0, 8)) process.stdout.write(`  - ${redactPath(problem)}\n`);
    return EXIT.USAGE;
  }

  const { rows, summary } = runStageA({ fixtures, impl });
  process.stdout.write(formatStageA({ fixtures, implFile, rows, summary }, { json: args.json }));

  if (summary.failed === 0 && args.write) {
    const written = writeEvidence({ fixtures, implFile, rows, summary });
    process.stdout.write(`已写合成聚合：evidence/${basenameOf(written)}\n`);
  } else if (args.write) {
    process.stdout.write("Stage A 未全过：不写 evidence 结果 JSON。\n");
  }
  return summary.failed === 0 ? EXIT.OK : EXIT.FAIL;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
