#!/usr/bin/env node
/**
 * offline-cache-audit.mjs —— 离线折叠（`archive-offline`）的 **prompt 公共前缀** 与 **缓存天花板**（T47，2026-11-05）
 *
 * ## 为什么要有它
 *
 * T45/T46 都在算「**主对话**」的缓存账（`none` 组命中率 97.6%）。离线折叠是另一条路：
 * 它每次都是**一次性的独立请求**（prompt 由 `buildOfflinePrompt` 现拼），跑在后台补账里。
 * 于是有个很自然的怀疑：**折叠的 prompt 开头每次都变 ⇒ 连一个公共前缀单元都形不成 ⇒ 每条全价**。
 *
 * 这个脚本把那个怀疑量出来。它**只读**（`["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92))` 一个字都不写）、
 * **零模型调用**（重放 prompt = 拼字符串，不是推理）。
 *
 * ## 口径（三条，都是本仓已核实的）
 *
 * · **prompt 重放**：`collectMessages`（maxChars=60_000、fromSeq=折痕的 `seqStart`、head 模式）
 *   + `renderFacts` + `buildOfflinePrompt` —— 与 `src/engine.mjs` 的 `runOfflineFold` 调用点同参
 *   （引擎传 `maxChunks:1`、`maxChars: offlineMaxChars ?? 60_000`、补账时 `fromHead` 为真）。
 *   事实块按折痕的 **`at` 时间戳**重建（节点/边都带 `ts`），因此拿到的是**当时**的硬事实，
 *   不是"用最终图重渲染"。这一点决定了本脚本的结论能直接对账（见 ③）。
 * · **公共前缀**：两条 prompt 的**最长公共前缀（LCP）**，按**字符**量、按 `estimateTokens`
 *   折算成 token（中文 0.6 / 其它 0.3，与 `foldBudgetFor` 同源）。
 *   为什么不是"从第 1 个 token 起算"：项目符号与汉字都是多字节，按字符切会偏；LCP 对字符是良定义的，
 *   折算时再乘语言系数 —— 这是本仓 `estimateTokens` 的既定口径，别在别处再写第二份。
 * · **真实命中**：`usage.cacheReadTokens` **不可信**（2026-11-05 快照：922 条里 919 条是 `null`），
 *   但 `totalTokens − inputTokens − outputTokens` 就是命中量（C361 在真机上核过：
 *   `2158 + 19584 + 257 = 21999`）。本脚本两个口径都报，差额就是仪器的盲区。
 *   **这一条推翻了本任务的出发前提**：折叠路径不是"全价"，真实命中 5,228,800 / 13,508,597 token
 *   = **38.7%**（其中 95% 是「同一条 prompt 再发一次」的整条命中，见 ①）。
 *
 * ## 四选一（判据写死在 `verdictOf`，可单测）
 *
 *   **A** prompt 开头每次都变（`seq` / 时间戳 / 会话 id 混进了前缀）⇒ 把不变的部分前置；
 *   **B** 单次请求太短（低于 provider 的缓存单元阈值）⇒ 物理限制；
 *   **C** provider 对这条路径**完全不命中**（`hitShare === 0`）⇒ 记录
 *     （**注意**：`cacheReadTokens` 缺失 ≠ C —— 那是宿主 usage 映射的盲区，真机 99.7% 是 `null`）；
 *   **D** 本来就该不同（每次摘要的输入天然不同）⇒ 不改，写清判据。
 *
 * ## 用法
 *
 *   node scripts/offline-cache-audit.mjs                    # 全库
 *   node scripts/offline-cache-audit.mjs --json             # 机器可读
 *   node scripts/offline-cache-audit.mjs --limit=20         # 先跑 20 个会话
 *   node scripts/offline-cache-audit.mjs --home=<DSH_HOME>  # 换 home
 *   node scripts/offline-cache-audit.mjs --ttl=300          # 相邻折痕的间隔上界（秒）
 *
 * 退出码：0 = 正常（这是**报告**，不是门禁）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { buildOfflinePrompt, collectMessages, estimateTokens, renderFacts } from "../src/rooms/offline-fold.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";

/**
 * 单价（$ / 1M token）。与 `src/ui.mjs` 的 `PRICE_USD_PER_MTOK` 同源（deepseek-v4 flash 低峰）：
 * miss $0.15 / hit $0.003 / out $0.6。**故意不 import**：ui.mjs 会拉起面板依赖，
 * 而这是一份只读审计。`test/offline-cache.test.mjs` 有一条守卫钉住这个等值。
 */
export const PRICES = Object.freeze({ miss: 0.15, hit: 0.003, out: 0.6 });

/** 一次「本该命中」的 token 省下的钱（$/1M）。价格差 = 50 倍。 */
export const PRICE_SPREAD = PRICES.miss - PRICES.hit;

/**
 * prompt 的**段标记**（闭集 —— 全仓唯一登记处，测试钉住每个标记只能命中一次）。
 *
 * 这些字符串**逐字来自** `buildOfflinePrompt` 的返回数组。为什么允许在这里写第二份：
 * 那段是模板字符串（含 `suggestedLength` 插值），没有可 import 的段名；与其把 `buildOfflinePrompt`
 * 改成返回结构化对象（那是跨模块契约，不在本任务范围），不如在这里登记 + 用测试钉住。
 * **漂移判据**：`buildOfflinePrompt` 改了任何一段的标题，`test/offline-cache.test.mjs` 立刻红。
 */
export const SECTION_MARKERS = Object.freeze({
  preamble: "你在为一个**已经归档**的会话做摘要。",
  facts: "# 硬事实（必须全部保留，禁止改写约束与死路）",
  messages: "# 原始消息（按时间顺序，工具结果已省略）",
  requirements: "# 输出要求",
  range: "## 原始坐标（本段）",
  // facts 内部（顺序即渲染顺序）
  goal: "## 目标（不可改写）",
  constraints: "## 约束（一条都不许丢）",
  failures: "## 已探明死路（不许重试）",
  verified: "## 已验证事实",
});

/** 段名 → 中文标签（报告与测试共用，避免两处手写字符串漂移）。 */
export const SECTION_LABELS = Object.freeze({
  preamble: "开头（常量）",
  "facts.goal": "事实块 · 目标",
  "facts.constraints": "事实块 · 约束",
  "facts.failures": "事实块 · 死路",
  "facts.verified": "事实块 · 已验证",
  "facts.other": "事实块 · 其它",
  messages: "原始消息体",
  requirements: "输出要求（常量）",
  range: "原始坐标行",
});

/** token 桶的边界（LCP 折算后的 token 数）。**上界开区间**。 */
const TOKEN_EDGES = [64, 256, 1024, 4096, 16384, Infinity];

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/**
 * 两个字符串的**最长公共前缀**长度（字符数）。
 *
 * 这就是「两次折叠的 prompt 共享多少前缀」的**上界**：provider 的缓存按前缀匹配，
 * 共享 P 个字符 ⇒ 这次请求能命中 P 个字符对应的 token。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function lcpChars(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) i += 1;
  return i;
}

/**
 * 把一次折叠的 `usage` 拆成「未命中 / 命中 / 输出」。
 *
 * `cacheReadTokens` **不能当命中量**：真机 917 条 `archive-offline` 里 849 条是 `null`（字段缺失，
 * 不是 0）。但 `totalTokens` 仍然把命中的 token 算进去了（C361 的真机自证：
 * `inputTokens 2158 + cacheReadTokens 19584 + outputTokens 257 = totalTokens 21999`）。
 * 所以：`hit = total − miss − out`；`cacheReadTokens` 有值就**以它为准**（那是 provider 直给的口径）。
 *
 * @param {{inputTokens?:number, outputTokens?:number, totalTokens?:number, cacheReadTokens?:number|null}} usage
 * @returns {{miss:number, hit:number, out:number, total:number|null, implied:number|null, field:boolean}}
 *   `field` = provider 是否真的给了 `cacheReadTokens`（false 就是仪器盲区）；
 *   `implied` = 由 total 反推的命中量（`field` 为真时也照算，两者应当相等）。
 */
export function usageSplit(usage) {
  // `null` 不是数字：`Number(null) === 0` 会把「字段缺失」误读成「命中 0」—— 这个坑让第一版
  // 审计把 455 条真实命中报成 0（本脚本自己的红过一次，故这里单独写死）。
  const num = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
  const miss = num(usage?.inputTokens) ?? 0;
  const out = num(usage?.outputTokens) ?? 0;
  const total = num(usage?.totalTokens);
  const field = num(usage?.cacheReadTokens) !== null;
  const implied = total === null ? null : total - miss - out;
  const hit = field ? Math.max(0, num(usage?.cacheReadTokens)) : Math.max(0, implied ?? 0);
  return { miss, hit, out, total, implied, field };
}

/**
 * prompt 里各段的**起始偏移**（找不到就是 −1）。
 *
 * 为什么用 `lastIndexOf` 找「输出要求」与「坐标行」：消息体里完全可能出现这两个字符串
 * （用户把提示词贴进对话），而真正的那一份一定在**最后**。`facts` 用 `indexOf`（它是第一段的头）。
 * @param {string} prompt
 * @returns {{facts:number, messages:number, requirements:number, range:number}}
 */
export function locateSections(prompt) {
  const text = String(prompt ?? "");
  return {
    facts: text.indexOf(SECTION_MARKERS.facts),
    messages: text.indexOf(SECTION_MARKERS.messages),
    requirements: text.lastIndexOf(SECTION_MARKERS.requirements),
    range: text.lastIndexOf(SECTION_MARKERS.range),
  };
}

/**
 * 偏移落在 prompt 的哪一段（用于回答「**最先变的是哪一部分**」）。
 *
 * 段序（与 `buildOfflinePrompt` 逐字对应）：preamble → 硬事实（目标 / 约束 / 死路 / 已验证）
 * → 原始消息 → 输出要求 → 原始坐标。
 * @param {string} prompt
 * @param {number} offset
 * @returns {string} `SECTION_LABELS` 的键
 */
export function sectionOf(prompt, offset) {
  const text = String(prompt ?? "");
  const at = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const spans = locateSections(text);
  if (spans.facts < 0 || at < spans.facts) return "preamble";
  const bodyStart = spans.messages < 0 ? text.length : spans.messages;
  if (at >= bodyStart) {
    const reqStart = spans.requirements < 0 ? text.length : spans.requirements;
    const rangeStart = spans.range < 0 ? text.length : spans.range;
    if (at >= rangeStart) return "range";
    if (at >= reqStart) return "requirements";
    return "messages";
  }
  const inner = [
    ["facts.verified", spans.facts + text.slice(spans.facts, bodyStart).indexOf(SECTION_MARKERS.verified)],
    ["facts.failures", spans.facts + text.slice(spans.facts, bodyStart).indexOf(SECTION_MARKERS.failures)],
    ["facts.constraints", spans.facts + text.slice(spans.facts, bodyStart).indexOf(SECTION_MARKERS.constraints)],
    ["facts.goal", spans.facts + text.slice(spans.facts, bodyStart).indexOf(SECTION_MARKERS.goal)],
  ]
    .filter(([, start]) => start >= spans.facts)
    .sort((a, b) => a[1] - b[1]);
  let name = "facts.other";
  for (const [id, start] of inner) if (start <= at) name = id;
  return name;
}

/**
 * 取 `offset` 所在的那一行（首差异的**可读证据**）。
 * @param {string} text
 * @param {number} offset
 * @param {number} [maxChars]
 * @returns {string}
 */
export function lineAt(text, offset, maxChars = 120) {
  const s = String(text ?? "");
  const at = Math.max(0, Math.min(s.length, Number(offset) || 0));
  const start = s.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const end = s.indexOf("\n", at);
  const line = s.slice(start, end < 0 ? s.length : end);
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/**
 * 「把**不变的部分**前置」的**模拟**（本任务只量不改 —— 见报告 ⑤）。
 *
 * 现状：`开头 → 硬事实 → 消息体 → 输出要求 → 坐标行`。
 * 模拟：`开头 → 输出要求 → 硬事实 → 消息体 → 坐标行` —— **字符一个不少，只换顺序**。
 *
 * 为什么这能涨前缀：输出要求是**常量**（602 字符，与消息体无关），
 * 但它排在消息体**后面** ⇒ 按前缀匹配永远缓存不到。前置之后，它就进了公共前缀。
 * @param {string} prompt
 * @returns {string}
 */
export function frontloadInvariants(prompt) {
  const text = String(prompt ?? "");
  const spans = locateSections(text);
  if (spans.facts < 0 || spans.messages < 0 || spans.requirements < 0 || spans.range < 0) return text;
  if (!(spans.facts < spans.messages && spans.messages <= spans.requirements && spans.requirements <= spans.range)) return text;
  return (
    text.slice(0, spans.facts) +
    text.slice(spans.requirements, spans.range) +
    text.slice(spans.facts, spans.messages) +
    text.slice(spans.messages, spans.requirements) +
    text.slice(spans.range)
  );
}

/**
 * 一次折叠**能把多少 token 放进公共前缀**（= 除消息体与坐标行之外的全部）。
 *
 * 这是「不动布局」的天花板：消息体每条都不同（D 类），坐标行每段都不同（C546 已置末尾）。
 * @param {string} prompt
 * @returns {number}
 */
export function ceilingTokens(prompt) {
  const text = String(prompt ?? "");
  const spans = locateSections(text);
  const bodyStart = spans.messages < 0 ? text.length : spans.messages;
  const reqStart = spans.requirements < 0 ? bodyStart : spans.requirements;
  const rangeStart = spans.range < 0 ? text.length : spans.range;
  const head = text.slice(0, bodyStart) + text.slice(reqStart, rangeStart);
  return estimateTokens(head);
}

/**
 * 把 token 数折成美元（一次命中的价差）。
 * @param {number} tokens
 * @returns {number}
 */
export function spreadUsd(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return (n * PRICE_SPREAD) / 1_000_000;
}

/**
 * 折成 token 桶标签（报告用直方图）。
 * @param {number} tokens
 * @returns {string}
 */
export function tokenBucket(tokens) {
  // 同上：`Number(null) === 0` 会把「没有值」静默塞进第一桶（0–63），直方图当场失真。
  const n = tokens === null || tokens === undefined || tokens === "" ? NaN : Number(tokens);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  let lo = 0;
  for (const edge of TOKEN_EDGES) {
    if (n < edge) return edge === Infinity ? `≥${lo}` : lo === 0 ? `0–${edge - 1}` : `${lo}–${edge - 1}`;
    lo = edge;
  }
  return `≥${lo}`;
}

/**
 * **四选一的判据**（数字进、字母出，可单测）。
 *
 * 判据写成**互斥的有序判断**，因为「A 和 D 各占一部分」是最容易糊过去的地方。
 * 关键：`cacheReadTokens` 缺失（`null`）**不能**当作「provider 不缓存」—— 真机 849/917 条是 `null`，
 * 而同一批 `usage` 的 `total − miss − out` 反推出 455 次命中。所以 C 的判据是
 * **命中量真的是 0**（`hitShare === 0`），不是字段缺失（`fieldShare`）。第一版写错这个，
 * 把 40 个会话误判成 C（脚本自己的红一次，故留在这里）。
 *
 *   ① `p50Tokens < 64`（比 provider 的缓存单元还短）⇒ **B**（物理限制，改不了）；
 *   ② 全库命中量 = 0 ⇒ **C**（这条路径没开缓存，记录即可）；
 *   ③ 相邻两条的公共前缀 p50 < 64 token（**开头每次都变**）⇒ **A**（把不变的部分前置）；
 *   ④ 否则 ⇒ **D**（前缀本来就稳定，剩下的 86% 是每次不同的消息体）。
 * @param {{p50Tokens:number, hitShare:number, lcpTokensP50:number}} input
 * @returns {"A"|"B"|"C"|"D"}
 */
export function verdictOf({ p50Tokens, hitShare, lcpTokensP50 }) {
  const tokens = Number(p50Tokens);
  if (!Number.isFinite(tokens) || tokens < 64) return "B";
  if (!(Number(hitShare) > 0)) return "C";
  if (!(Number(lcpTokensP50) >= 64)) return "A";
  return "D";
}

/** 中位数（空数组 ⇒ null，别返回 0 —— 0 会被当成"真的很小"）。 */
export function median(list) {
  const xs = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 分位数（`p` 是 0~1；空数组 ⇒ null）。 */
export function percentile(list, p) {
  const xs = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * Number(p))))];
}

/* ────────────────────────── 重放（只读） ────────────────────────── */

/**
 * 按**时间戳**把图裁成「折痕发生时的样子」。
 *
 * 为什么不用 `seq` 裁：折痕的 `seqStart/seqEnd` 是**欠账区间**，不是图的快照
 * （真机有 `8-8` 这种退化区间，按 seq 裁会把 seq 9 的根节点裁掉 ⇒ 事实块变成 `- (none)`
 * ⇒ 首差异位置全错在 14 字符处，那是**重放伪影**，不是生产事实）。
 * 节点与边都带 `ts`（毫秒），`ts <= 折痕.at` 就是**当时**的图 —— 这是精确重建。
 * @param {object} graph
 * @param {number} at 折痕时间（ms）
 * @returns {object}
 */
export function graphAt(graph, at) {
  // `Number(null) === 0` —— 折痕没有 `at` 时会被裁成**空图**（事实块只剩 `- (none)`），
  // 于是「首差异位置」全错在 14 字符处。这个坑第一版真踩过，故显式排除 null/undefined。
  const cutoff = at === null || at === undefined || at === "" ? NaN : Number(at);
  if (!Number.isFinite(cutoff)) return graph;
  const keep = (value) => {
    const ts = Number(value?.ts);
    return !Number.isFinite(ts) || ts <= cutoff;
  };
  const nodes = {};
  for (const [id, node] of Object.entries(graph?.nodes ?? {})) if (keep(node)) nodes[id] = node;
  const edges = {};
  for (const [id, edge] of Object.entries(graph?.edges ?? {})) if (keep(edge)) edges[id] = edge;
  return {
    ...graph,
    nodes,
    edges,
    rootUserNodeIds: (graph?.rootUserNodeIds ?? []).filter((id) => nodes[id] !== undefined),
    order: (graph?.order ?? []).filter((id) => nodes[id] !== undefined),
  };
}

/**
 * 会话日志索引（一次走完，别在 416 个会话上各走一遍 —— `findSessionLog` 是 O(全库)）。
 * @param {string} home
 * @returns {string[]}
 */
export function indexSessionLogs(home) {
  const root = nodePath.join(String(home ?? ""), "sessions");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".zstd")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * 会话 id → 日志文件（与 `src/rooms/zstd-log.mjs` 的 `findSessionLog` 同一匹配规则：
 * 路径里包含会话 id）。
 * @param {string[]} logs
 * @param {string} sessionId
 * @returns {string|null}
 */
export function findLog(logs, sessionId) {
  const want = String(sessionId ?? "").replace(/^session-/, "");
  if (want === "") return null;
  return (Array.isArray(logs) ? logs : []).find((p) => p.includes(want)) ?? null;
}

/**
 * 一条折痕的 prompt（与 `runOfflineFold` 同参：`maxChunks:1` + 补账的 head 模式）。
 * @param {object} args
 * @param {object} args.graph 图（**当时**的图，见 `graphAt`）
 * @param {Array<object>} args.events 会话事件
 * @param {object} args.mark 折痕
 * @returns {{prompt:string, facts:string, messages:number, chars:number}|null}
 */
export function replayPrompt({ graph, events, mark }) {
  const seqStart = Number(mark?.seqStart);
  if (!Number.isFinite(seqStart)) return null;
  const idBySeq = new Map();
  for (const node of Object.values(graph?.nodes ?? {})) {
    const seq = Number(node?.seq);
    const id = typeof node?.id === "string" ? node.id : null;
    if (!Number.isFinite(seq) || id === null || idBySeq.has(seq)) continue;
    idBySeq.set(seq, id);
  }
  const collected = collectMessages(events, { maxChars: 60_000, fromSeq: seqStart, idBySeq });
  if (collected.messages.length === 0) {
    return { prompt: "", facts: "", messages: 0, chars: 0 };
  }
  const facts = renderFacts(graph, { start: seqStart, end: Number(mark?.seqEnd) });
  const prompt = buildOfflinePrompt({ facts, messages: collected.messages, range: { start: seqStart, end: Number(mark?.seqEnd) } });
  return { prompt, facts, messages: collected.messages.length, chars: collected.chars };
}

/* ────────────────────────── 主流程 ────────────────────────── */

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");
const pct = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`);
const usd = (value) => `$${(Number(value) || 0).toFixed(3)}`;

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const homeArg = argv.find((item) => item.startsWith("--home="));
  const limitArg = argv.find((item) => item.startsWith("--limit="));
  const ttlArg = argv.find((item) => item.startsWith("--ttl="));
  const limit = limitArg === undefined ? Infinity : Math.max(1, Number(limitArg.slice("--limit=".length)) || 1); // 会话数
  const ttl = ttlArg === undefined ? 3600 : Math.max(1, Number(ttlArg.slice("--ttl=".length)) || 3600);
  const home = String(homeArg === undefined ? process.env.DSH_HOME ?? ["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92)) : homeArg.slice("--home=".length)).trim();

  const root = nodePath.join(home, "chess-context", "sessions");
  let dirs = [];
  try {
    dirs = nodeFs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    console.error(`✗ 读不到棋谱目录（${root}）—— 用 --home 指定 DSH_HOME`);
    return 2;
  }

  const logs = indexSessionLogs(home);
  const folds = [];
  let sessions = 0;
  let noLog = 0;
  let noPrompt = 0;
  for (const dir of dirs) {
    if (sessions >= limit) break;
    const file = nodePath.join(root, dir.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const marks = (graph.foldMarks ?? [])
      .filter((mark) => mark?.trigger === "archive-offline")
      .sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
    if (marks.length === 0) continue;
    sessions += 1;
    const log = findLog(logs, dir.name);
    let events = null;
    if (log !== null) {
      try {
        events = readSessionEvents(log);
      } catch {
        events = null;
      }
    }
    if (events === null) noLog += 1;
    marks.forEach((mark, index) => {
      const usage = usageSplit(mark.usage);
      const at = Number(mark.at) || null;
      const prevAt = index === 0 ? null : Number(marks[index - 1]?.at) || null;
      const row = {
        session: dir.name,
        index,
        seqStart: Number(mark.seqStart),
        seqEnd: Number(mark.seqEnd),
        gapSec: at === null || prevAt === null ? null : Math.round((at - prevAt) / 1000),
        usage,
        prompt: null,
        promptTokens: null,
        ceilingTokens: null,
      };
      if (events !== null) {
        const replay = replayPrompt({ graph: graphAt(graph, at), events, mark });
        if (replay === null || replay.prompt === "") {
          noPrompt += 1;
        } else {
          row.prompt = replay.prompt;
          row.promptTokens = estimateTokens(replay.prompt);
          row.ceilingTokens = ceilingTokens(replay.prompt);
        }
      }
      folds.push(row);
    });
  }

  // ② 同会话相邻折痕的公共前缀
  const pairs = [];
  for (let i = 1; i < folds.length; i += 1) {
    const prev = folds[i - 1];
    const cur = folds[i];
    if (prev.session !== cur.session || prev.prompt === null || cur.prompt === null) continue;
    const lcp = lcpChars(prev.prompt, cur.prompt);
    const section = sectionOf(cur.prompt, lcp);
    const front = lcpChars(frontloadInvariants(prev.prompt), frontloadInvariants(cur.prompt));
    const row = {
      session: cur.session,
      seq: `${cur.seqStart}-${cur.seqEnd}`,
      gapSec: cur.gapSec,
      chars: lcp,
      tokens: estimateTokens(cur.prompt.slice(0, lcp)),
      section,
      lineA: lineAt(prev.prompt, lcp),
      lineB: lineAt(cur.prompt, lcp),
      frontChars: front,
      frontTokens: estimateTokens(frontloadInvariants(cur.prompt).slice(0, front)),
      promptTokens: cur.promptTokens,
      ceilingTokens: cur.ceilingTokens,
      hit: cur.usage.hit,
      miss: cur.usage.miss,
    };
    pairs.push(row);
  }

  const withPrompt = folds.filter((f) => f.prompt !== null);
  const fieldShare = folds.length === 0 ? 0 : folds.filter((f) => f.usage.field).length / folds.length;
  const hitFolds = folds.filter((f) => f.usage.hit > 0);
  const hitTokens = folds.reduce((sum, f) => sum + f.usage.hit, 0);
  const missTokens = folds.reduce((sum, f) => sum + f.usage.miss, 0);
  const hitShare = hitTokens + missTokens === 0 ? 0 : hitTokens / (hitTokens + missTokens);
  const p50Prompt = median(withPrompt.map((f) => f.promptTokens));
  const p50Ceiling = median(withPrompt.map((f) => f.ceilingTokens));
  const stableShare = p50Prompt === null || p50Ceiling === null || p50Prompt === 0 ? 0 : p50Ceiling / p50Prompt;
  const retryLike = folds.filter((f) => f.usage.miss < 1000);
  const retryHit = retryLike.filter((f) => f.usage.hit > 0);
  const genuineHit = pairs.filter((p) => p.hit > 0 && p.miss >= 3000);
  const laterFolds = folds.filter((f) => f.index > 0);
  const laterWithPrompt = laterFolds.filter((f) => f.ceilingTokens !== null);

  // ⑤ 天花板：只对「同会话、上一条也在 ttl 内」的折痕算 —— 那才是物理上能命中的部分。
  //   · `ceilingTotal` = 不变量全固定时**每条**折痕最多能进缓存的 token（物理上界）；
  //   · `lcpTotal`     = 现状布局（重放）已经共享的前缀；
  //   · `frontTotal`   = 把「输出要求」等不变量前置后的前缀（A 类修法的产物）；
  //   · `frontGain`    = 修法**增量**（逐条夹取，绝不为负）；
  //   · `alreadyHit`   = 真机实测已命中的 token（重试也算 —— 那是同一份钱）。
  const eligible = pairs.filter((p) => p.gapSec === null || p.gapSec <= ttl);
  const ceilingTotal = eligible.reduce((sum, p) => sum + (p.ceilingTokens ?? 0), 0);
  const lcpTotal = eligible.reduce((sum, p) => sum + (p.tokens ?? 0), 0);
  const frontTotal = eligible.reduce((sum, p) => sum + (p.frontTokens ?? 0), 0);
  // 逐条夹取：**已经命中的那部分不能重复算成"还能省"**
  const realized = eligible.reduce((sum, p) => sum + Math.max(0, Math.min(p.hit ?? 0, p.ceilingTokens ?? 0)), 0);
  const remaining = eligible.reduce((sum, p) => sum + Math.max(0, (p.ceilingTokens ?? 0) - (p.hit ?? 0)), 0);
  // A 类修法（输出要求前置）的增量上界：**只算它真能多加进前缀的那一截**
  const frontGain = eligible.reduce((sum, p) => sum + Math.max(0, (p.frontTokens ?? 0) - (p.tokens ?? 0)), 0);

  const p50Lcp = median(pairs.map((p) => p.tokens));
  const verdict = verdictOf({ p50Tokens: p50Prompt ?? 0, hitShare, lcpTokensP50: p50Lcp ?? 0 });

  /**
   * 间隔 × 命中 的交叉表：直接检验「**TTL 是不是真凶**」。
   * 如果短间隔也不命中 ⇒ 不是 TTL；如果命中只在短间隔里出现 ⇒ 前缀是好的，钱被 TTL 吃掉了。
   */
  const GAP_EDGES = [
    ["<60s", 0, 60],
    ["60–300s", 60, 300],
    ["300–1800s", 300, 1800],
    ["≥1800s", 1800, Infinity],
  ];
  const gapTable = GAP_EDGES.map(([label, lo, hi]) => {
    const rows = pairs.filter((p) => p.gapSec !== null && p.gapSec >= lo && p.gapSec < hi);
    return {
      label,
      n: rows.length,
      withHit: rows.filter((p) => p.hit > 0).length,
      hitP50: median(rows.map((p) => p.hit)),
      lcpP50: median(rows.map((p) => p.tokens)),
    };
  });

  const summary = {
    home,
    sessions,
    folds: folds.length,
    withPrompt: withPrompt.length,
    noLog,
    noPrompt,
    logs: logs.length,
    ttlSeconds: ttl,
    usage: { hitFolds: hitFolds.length, hitTokens, missTokens, hitShare, fieldShare, retryFolds: retryLike.length, retryHitTokens: retryHit.reduce((s, f) => s + f.usage.hit, 0) },
    prompt: { p50Tokens: p50Prompt, p50CeilingTokens: p50Ceiling, stableShare },
    pairs: {
      n: pairs.length,
      charsP50: median(pairs.map((p) => p.chars)),
      charsP90: percentile(pairs.map((p) => p.chars), 0.9),
      charsMax: pairs.length === 0 ? null : Math.max(...pairs.map((p) => p.chars)),
      tokensP50: median(pairs.map((p) => p.tokens)),
      tokensP90: percentile(pairs.map((p) => p.tokens), 0.9),
      tokensMax: pairs.length === 0 ? null : Math.max(...pairs.map((p) => p.tokens)),
      frontTokensP50: median(pairs.map((p) => p.frontTokens)),
      sections: pairs.reduce((acc, p) => {
        acc[p.section] = (acc[p.section] ?? 0) + 1;
        return acc;
      }, {}),
      buckets: pairs.reduce((acc, p) => {
        const key = tokenBucket(p.tokens);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      samples: pairs.slice(0, 3),
      genuineHit: { n: genuineHit.length, tokensP50: median(genuineHit.map((p) => p.hit)), tokensSum: genuineHit.reduce((s, p) => s + p.hit, 0) },
    },
    ceiling: {
      eligiblePairs: eligible.length,
      ceilingTokens: ceilingTotal,
      lcpTokens: lcpTotal,
      frontloadTokens: frontTotal,
      frontloadGainTokens: frontGain,
      realizedTokens: realized,
      remainingTokens: remaining,
      ceilingUsd: spreadUsd(ceilingTotal),
      lcpUsd: spreadUsd(lcpTotal),
      frontloadUsd: spreadUsd(frontGain),
      remainingUsd: spreadUsd(remaining),
      laterWithPrompt: laterWithPrompt.length,
    },
    verdict,
    gapTable,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 1));
    return 0;
  }

  const hist = (values) => {
    const counts = {};
    for (const v of values) {
      const key = tokenBucket(v);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const order = ["0–63", "64–255", "256–1023", "1024–4095", "4096–16383", "≥16384", "unknown"];
    return order.filter((k) => counts[k] !== undefined).map((k) => `${k}: ${counts[k]}`).join(" · ") || "（无）";
  };

  console.log("== 离线折叠缓存审计（只读 · 零模型调用）==");
  console.log(`home：${home}`);
  console.log(`折痕：${fmt(folds.length)} 条 archive-offline / ${fmt(sessions)} 个会话 / 日志 ${fmt(logs.length)} 份（重放成功 ${fmt(withPrompt.length)} 条${noLog > 0 ? `，缺日志 ${noLog} 个会话` : ""}${noPrompt > 0 ? `，重放为空 ${noPrompt} 条` : ""}）`);
  console.log("");
  console.log("① 现状：provider 到底命中多少（**不信 `cacheReadTokens`**，用 total 反推）");
  console.log(`   · \`cacheReadTokens\` 有值的折痕：${fmt(folds.filter((f) => f.usage.field).length)} / ${fmt(folds.length)}（${pct(fieldShare)}）—— 其余是 \`null\`（**字段缺失，不是 0**）`);
  console.log(`   · 由 \`total − miss − out\` 反推的命中：${fmt(hitFolds.length)} 条折痕 / ${fmt(hitTokens)} token`);
  console.log(`   · 输入命中率（按 token）：${fmt(hitTokens)} / ${fmt(hitTokens + missTokens)} = ${pct(hitShare)}`);
  console.log(`   · 其中**重试**（同一条 prompt 再发一次，miss < 1000）占 ${fmt(retryLike.length)} 条 / ${fmt(retryHit.reduce((s, f) => s + f.usage.hit, 0))} token —— 那不是"前缀稳定"，是**同一条消息发了两遍**`);
  console.log(`   · 真实「相邻折痕」命中（miss ≥ 3000）：${fmt(genuineHit.length)} 条，p50 ${fmt(median(genuineHit.map((p) => p.hit)))} token`);
  console.log("");
  console.log(`② 公共前缀分布（同会话、按 \`at\` 排序的相邻两条；重放：facts 按 \`at\` 重建 + head 模式取消息）`);
  console.log(`   字符：p50 ${fmt(summary.pairs.charsP50)} / p90 ${fmt(summary.pairs.charsP90)} / max ${fmt(summary.pairs.charsMax)}`);
  console.log(`   token：p50 ${fmt(summary.pairs.tokensP50)} / p90 ${fmt(summary.pairs.tokensP90)} / max ${fmt(summary.pairs.tokensMax)}`);
  console.log(`   直方图（token）：${hist(pairs.map((p) => p.tokens))}`);
  console.log(`   折叠 prompt 本身：p50 ${fmt(p50Prompt)} token；不变量前缀（除消息体与坐标行）p50 ${fmt(p50Ceiling)} token = ${pct(stableShare)}`);
  console.log("");
  console.log("③ 首差异位置（两次折叠的 prompt 从第几个字符开始不一样）");
  const sections = Object.entries(summary.pairs.sections).sort((a, b) => b[1] - a[1]);
  console.log(`   落在各段：${sections.map(([id, n]) => `${SECTION_LABELS[id] ?? id} ${n}`).join(" · ") || "（无）"}`);
  console.log(`   ⇒ **不是从第 1 个 token 就分叉**：p50 在 ${fmt(summary.pairs.tokensP50)} token 处才分叉，且 p90 之后才到消息体`);
  for (const sample of summary.pairs.samples) {
    console.log(`   例 \`${sample.session.slice(0, 12)}\` seq ${sample.seq}（${SECTION_LABELS[sample.section] ?? sample.section}，偏移 ${fmt(sample.chars)} 字符 / ${fmt(sample.tokens)} token，间隔 ${sample.gapSec}s）`);
    console.log(`      上一条：${JSON.stringify(sample.lineA)}`);
    console.log(`      这一条：${JSON.stringify(sample.lineB)}`);
  }
  console.log("");
  console.log(`④ 判断：**${verdict}**`);
  console.log(`   · B（请求太短）：prompt p50 = ${fmt(p50Prompt)} token ≫ 64（provider 缓存单元量级）⇒ **不成立**`);
  console.log(`   · C（provider 不启用）：\`total − miss − out\` 反推出 ${fmt(hitFolds.length)} 次命中 / ${fmt(hitTokens)} token（命中率 ${pct(hitShare)}）⇒ **不成立**；\`cacheReadTokens\` 缺失是**宿主 usage 映射**的问题，不是 provider 没开`);
  console.log(`   · A（开头每次都变）：公共前缀 p50 = ${fmt(p50Lcp)} token（**不是 0，也不小**）⇒ 开头**没有**每次都变；只剩「输出要求」块（常量 602 字符）排在消息体之后进不了前缀，那点残差 = ${usd(summary.ceiling.frontloadUsd)}`);
  console.log(`   · D（本来就该不同）：不变量前缀只占 prompt 的 ${pct(stableShare)}，其余 ${pct(1 - stableShare)} 是消息体；按 \`fromSeq=seqStart\` 头取且相邻段不重叠 ⇒ 正文天生不同 ⇒ **成立**`);
  console.log("");
  console.log("   间隔 × 命中（检验 TTL 是不是真凶）：");
  for (const row of gapTable) {
    if (row.n === 0) continue;
    console.log(`     ${row.label.padEnd(10)} 相邻 ${String(row.n).padStart(3)} 条 · 有命中 ${String(row.withHit).padStart(3)} 条 · 命中 p50 ${fmt(row.hitP50)} token · 重放 LCP p50 ${fmt(row.lcpP50)} token`);
  }
  console.log(`   ⇒ 主因 **D**（消息体天生不同）；A 的残差与 B/C 都已用数字排除`);
  console.log("");
  console.log(`⑤ 天花板（真机 usage × 价差 $${PRICES.miss} − $${PRICES.hit} = $${PRICE_SPREAD}/1M）`);
  console.log(`   可命中的相邻折痕（同会话、间隔 ≤ ${ttl}s）：${fmt(summary.ceiling.eligiblePairs)} 条`);
  console.log(`   ① 物理天花板（不变量全固定：开头 + 硬事实 + 输出要求，每条折痕最多能进缓存的 token）：${fmt(summary.ceiling.ceilingTokens)} token ⇒ ${usd(summary.ceiling.ceilingUsd)}`);
  console.log(`   ② 其中**真机已经在命中**的部分（逐条 min(hit, 天花板)）：${fmt(summary.ceiling.realizedTokens)} token ⇒ 已省 ${usd(spreadUsd(summary.ceiling.realizedTokens))}`);
  console.log(`   ③ **还能省的（① − ②，逐条夹取）**：${fmt(summary.ceiling.remainingTokens)} token ⇒ ${usd(summary.ceiling.remainingUsd)}`);
  console.log(`   ④ 参考：只把「输出要求」块前置（A 类修法的**全部**增量）：${fmt(summary.ceiling.frontloadGainTokens)} token ⇒ ${usd(summary.ceiling.frontloadUsd)}`);
  console.log(`   ⑤ 参考：现状布局的重放 LCP 总量：${fmt(summary.ceiling.lcpTokens)} token ⇒ ${usd(summary.ceiling.lcpUsd)}（含退化区间重折，那部分 provider 已经全命中）`);
  if (summary.ceiling.remainingUsd < 1) {
    console.log(`   ⇒ 天花板 ${usd(summary.ceiling.remainingUsd)} **< $1** ⇒ 按 T45 的教训：**只报告，不改 buildOfflinePrompt**`);
  } else {
    console.log(`   ⇒ 天花板 ${usd(summary.ceiling.remainingUsd)} **≥ $1** ⇒ 值得改（A 类：把不变量前置）`);
  }
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
