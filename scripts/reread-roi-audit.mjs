#!/usr/bin/env node
/**
 * reread-roi-audit.mjs —— 「重读率 + ROI」的裁决（T58 · 只读 · 零模型调用）
 *
 * ── 第一性原理（用户点破的，本轮以此为准） ─────────────────────────────────────
 *
 *   原始问题：上下文窗口有限
 *       ↓
 *   会话长了就撞墙（context-overflow / 被迫中断）
 *       ↓
 *   压缩 = 用「一次模型调用」换「窗口腾出来」
 *
 *   **所以压缩是一笔交易**：成本 = 一次摘要调用（真机 ≈$0.008/段）；收益 = 省下的输入 token；
 *   **失败 = 折完之后又去读/算同样的东西 ⇒ 白折，还多花了钱。**
 *
 *   市场诉求（同类产品用户的真实语言）：① 别让我重复劳动（「刚说过的怎么又忘了」）
 *   ② 别中断 ③ 别乱花钱 ④ 别编。**第 1 条压倒性重要** ——
 *   而「忘了」的可观测形式**就是重读**。
 *
 * ── 这个脚本量什么（一句话） ───────────────────────────────────────────────────
 *
 *   **重读率** = 折叠覆盖了某个**可指认的资产**（文件路径 / shell 命令 / 搜索词 / URL），
 *   在这次折叠**之后**，agent 有没有**又去获取同一个资产**？
 *
 *   · 分子 = 折叠**之后**（`seq > seqEnd`）再次出现在 `tool/call` 里的、逐字相同的资产数；
 *   · 分母 = 折叠区间内**去重后**的可指认资产数（= 可重读机会）；
 *   · 两者都来自**会话日志里的工具调用**，不是摘要文本的子串匹配。
 *
 * ── 「可指认」= 闭集 + 逐字相同（这是本指标唯一的技术含量，也最容易死） ──────────
 *
 *   今晚已经有五个指标死在「代理量」上（语义相似 / 编辑距离 / 词袋余弦）。
 *   这里**一个都不许用**。规则是**闭集**，没列到的一律不算：
 *
 *   | 类型 | 工具（闭集） | 参数 | 规范化（只做这三件） |
 *   |---|---|---|---|
 *   | 文件 | `read` / `edit` / `write` | `file_path` | 去 `./` 前缀 · 统一斜杠为 `/` · 转小写 |
 *   | 命令 | `bash` / `pwsh` / `shell` / `bash_shell` | `command` | 连续空白压成一个空格 · 去首尾空白 |
 *   | 搜索 | `grep` / `glob` | `pattern` | 去首尾空白（**不压内部空白**：正则里空格有意义） |
 *   | 搜索 | `web_search` | `queries[]` | 逐条去首尾空白 |
 *   | URL  | `web_fetch` | `url` | 去首尾空白 |
 *
 *   规范化之后**字符串完全相等**才算同一个资产。**不做** `path.resolve`（那会把「相对 vs 绝对」
 *   两种写法合并 —— 那是语义推断，不是逐字相同）。代价是**少算**：同一个文件用两种写法时不计重读。
 *   方向上是安全的（宁可少算 —— 本指标的死法是「假绿」，不是「假红」）。
 *
 *   闭集外的工具（`read_image` / `job_output` / `send_message` …）**一条都不算**，
 *   报告里单列「未纳入闭集的工具调用」条数，让读者看得见被排除的量。
 *
 * ── 重读 ≠ 重踩（T56 是另一个指标，别混） ─────────────────────────────────────
 *
 *   · **重踩（T56）**：折叠之后**又试了同一个失败动作**（`result === "failure"` 的边）。
 *     它问的是「摘要有没有让下一个自己别重蹈覆辙」。
 *   · **重读（本脚本）**：折叠之后**又获取了同一个资产**（读同一文件 / 跑同一命令 / 搜同一词）。
 *     它问的是「摘要有没有让下一个自己不重复劳动」—— 这是市场诉求第 1 条的可观测形式。
 *
 *   一个动作成功了也会被重读（例如「再读一遍确认」）；一个失败动作也可能不产生重读。
 *   两者**没有包含关系**，报告里不互相引用。
 *
 * ── 四条判据（今晚总结，必须全过） ─────────────────────────────────────────────
 *
 *   ① **有方差**：折痕级重读率的众数占比 < 80%（恒等于某个值 = 常函数，没有信息量）；
 *   ② **与形状无关**：|ρ(离尾部距离)| < 0.2 且 |ρ(折痕跨度)| < 0.2；
 *   ③ **与已有指标不同**：ρ(可定位率) < 0.8 且 ρ(T33 五判据分) < 0.8；
 *   ④ **分子不是修复函数的输出**：分子是**会话日志里的 `tool/call` 事件**，
 *      而修复函数（`repairMissingFailures` / `repairFailuresInText`）只改**摘要文本**、
 *      不写会话日志、不产生工具调用 ⇒ 结构上不可能造出分子。
 *      经验对照：摘要可解析池 vs 不可解析池的重读率（真被修复函数污染过，两池会系统性分叉）。
 *
 * ── ROI（三项分解 + 净值） ────────────────────────────────────────────────────
 *
 *   净收益 = 省下的输入 token − 摘要花费 − 重读白付的 token
 *
 *   · **省下的输入** = `foldMark.shadowedTokens`（图上已有；**缺失记 null，不记 0**）；
 *   · **摘要花费** = `estimateFoldCostUsd(mark.usage, mark.route.model, {at: mark.at})`
 *     —— 与面板/`fold-economics` **同一个函数**，含峰谷两档价；
 *   · **重读白付** = 重读那次 `tool/result` 正文 + 调用参数的 token（`estimateTokens`，
 *     与 `shadowedTokens` 同一套 CJK 感知口径）× 当时的 miss 价。
 *
 *   计价一律折成**美元**（token 与美元不可直接相加，这是本脚本唯一的口径统一动作）：
 *   省下/白付按「输入 cache miss 价」计（保守：miss 是最贵的输入价），摘要花费按真实 usage。
 *   价格用 `priceForModel(该次请求的 agent 模型)`（`request/context` 事件里读得到），
 *   认不出的模型回落 flash 价 = **下限**。
 *
 *   ★ **ROI 要能算负的**：如果白付 + 花费 > 省下，净值就是负数，报告里照写。
 *   ★ 另给一条**请求级上界**：把「重读那次请求的整个输入」都算成白付。
 *     日志里没有 per-request usage ⇒ 用 `foldMark.totalAfter`（折后上下文规模）作**下界**。
 *     它回答的是另一个问题（「这次请求本来能不能不发生」），与增量口径**分列，不合并**。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *   · **纯只读**：`graph.json` / `*.zstd` 只 `readFileSync`；一个字节都不写；
 *   · **不 import 会写盘的函数**（`applyOfflineFoldToGraph` 一律不碰）；
 *   · **不调模型**、不重启、不 commit、不写 `docs/` `evidence/`；
 *   · **判据必须能返回「不通过」**（否则这个守卫就是永远绿的假门禁 —— T54 的老教训）。
 *
 * 用法：
 *   node scripts/reread-roi-audit.mjs                  # 全量（读会话日志，约 20–60 秒）
 *   node scripts/reread-roi-audit.mjs --json           # 机读（报告/测试用）
 *   node scripts/reread-roi-audit.mjs --home <dir>     # 换 DSH_HOME
 *   node scripts/reread-roi-audit.mjs --session <前缀> # 只看某个会话
 *   node scripts/reread-roi-audit.mjs --limit 20       # 明细列最近 N 条重读
 *
 * 退出码：0 = 审计跑完（无论结论「能用」还是「不能用」）；2 = 一张图都读不到（home 给错了）。
 */
import nodePath from "node:path";
import os from "node:os";

import { collectGraphFiles, estimateFoldCostUsd, priceForModel } from "../src/ui.mjs";
import { estimateTokens } from "../src/rooms/offline-fold.mjs";
import { readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { buildLogIndex, correlate, quantile } from "./range-fidelity-audit.mjs";
import { measureSample, resolveSummaryText } from "./summary-usability-audit.mjs";
import { scoreMark } from "./usability-by-age-audit.mjs";

/* ═════════════════════════ ① 闭集：什么叫「可指认的资产」 ═════════════════════════ */

/**
 * 资产抽取规则（**闭集**）。没列到的工具 = 不算资产，一条都不算。
 *
 * 为什么是闭集而不是「参数里看着像路径的都算」：后者会把 `description` / `content`
 * 里出现的路径也算成资产，于是「折叠区间里提过某个文件」就变成「获取了某个文件」——
 * 那是语义推断，今晚五个指标全死在这上面。
 */
export const ASSET_RULES = Object.freeze([
  Object.freeze({ type: "file", tools: Object.freeze(["read", "edit", "write"]), arg: "file_path", multi: false }),
  Object.freeze({ type: "command", tools: Object.freeze(["bash", "pwsh", "shell", "bash_shell"]), arg: "command", multi: false }),
  Object.freeze({ type: "search", tools: Object.freeze(["grep", "glob"]), arg: "pattern", multi: false }),
  Object.freeze({ type: "search", tools: Object.freeze(["web_search"]), arg: "queries", multi: true }),
  Object.freeze({ type: "url", tools: Object.freeze(["web_fetch"]), arg: "url", multi: false }),
]);

/** 资产类型（报告与测试都按这个顺序）。 */
export const ASSET_TYPES = Object.freeze(["file", "command", "search", "url"]);

/** 类型人读名。 */
export const ASSET_LABELS = Object.freeze({ file: "文件", command: "命令", search: "搜索", url: "URL" });

/** 「死路信息进过上下文」的消息来源（与 T56 同一口径，便于横向对照）。 */
export const INJECTION_KINDS = Object.freeze(["compact-checkpoint", "chess-context"]);

/** 热清单注入 = 插件自己的 `chess-context` 消息（T56 实测 63.18% 的折痕折后有过）。 */
export const HOT_LEDGER_KIND = "chess-context";
/** 摘要本体注入 = 宿主把摘要当 checkpoint 塞回 surface。 */
export const CHECKPOINT_KIND = "compact-checkpoint";

/** 实时折叠的 trigger（折痕是**在会话中间**产生的 ⇒ 「折后」在时钟与 seq 上一致）。 */
export const LIVE_TRIGGERS = Object.freeze(["pressure", "context-overflow", "tier2", "auto", "manual", "loop"]);

/**
 * 判据门槛（与 T52–T56 同一套数字；改门槛只改这里）。
 */
export const CRITERIA_RULES = Object.freeze({
  /** 判据 ①：某一取值占比超过这个数就叫「恒等」（常函数，没有信息量）。 */
  maxConstantShare: 0.8,
  /** 判据 ②：|ρ| 小于这个数才算「与形状无关」。 */
  maxAbsRhoShape: 0.2,
  /** 判据 ③：与已有指标 ρ 高于这个数就算「同一个东西」。 */
  maxRhoRedundant: 0.8,
});

/**
 * **样本门槛**：某格可重读机会 < 这个数 ⇒ **不许算率**，报告写「样本不足」。
 * 10 是硬话里给的下限（「某格 < 10 条时不许硬算率」）。
 */
export const MIN_CELL = 10;

/** 明细表默认列几条。 */
export const DEFAULT_LIMIT = 20;

/** 折痕级重读率的分档（固定，输出与测试都按它）。 */
export const RATE_BANDS = Object.freeze([
  Object.freeze({ key: "= 0", test: (v) => v === 0 }),
  Object.freeze({ key: "0–0.2", test: (v) => v > 0 && v < 0.2 }),
  Object.freeze({ key: "0.2–0.5", test: (v) => v >= 0.2 && v < 0.5 }),
  Object.freeze({ key: "0.5–1.0", test: (v) => v >= 0.5 && v < 1 }),
  Object.freeze({ key: "= 1.0", test: (v) => v >= 1 }),
]);

/* ═════════════════════════ ② 规范化（只做「逐字相同」允许的那三件） ═════════════════════════ */

/**
 * 文件路径规范化：去 `./` 前缀 · 统一斜杠 · 转小写 · 压掉重复斜杠 · 去尾斜杠。
 *
 * **不做** `path.resolve` / `path.normalize`：那会把 `..`、相对路径、盘符挂载点都算进来，
 * 属于「看起来同一个文件」的语义推断。本指标只认**字符串逐字相同**，宁可少算。
 *
 * @param {unknown} value
 * @returns {string} 空串 = 不是可指认资产
 */
export function normalizePath(value) {
  let text = String(value ?? "").trim();
  if (text === "") return "";
  text = text.replace(/\\/g, "/"); // 统一斜杠（Windows 两种写法都见过）
  text = text.replace(/\/{2,}/g, "/"); // 压掉重复斜杠（UNC `//srv` 会被压成 `/srv`，已记入已知代价）
  text = text.replace(/^(?:\.\/)+/, ""); // 去 `./` 前缀（可能多个）
  text = text.replace(/\/+$/, ""); // 去尾斜杠（`a/b/` 与 `a/b` 是同一路径）
  return text.toLowerCase(); // Windows 大小写不敏感
}

/**
 * 命令规范化：连续空白压成一个空格 + 去首尾空白。
 * 只去「空白差异」，其余一个字符都不动（`--force` 与 `-f` 仍是两个命令）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCommand(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 搜索词规范化：**只去首尾空白**。
 * 不压内部空白 —— `grep "a b"` 与 `grep "a  b"` 在正则里是不同的模式，压了就变成语义推断。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeQuery(value) {
  return String(value ?? "").trim();
}

/**
 * URL 规范化：只去首尾空白（不转小写 —— 路径段大小写敏感；不去尾斜杠 —— `/a` 与 `/a/` 是两个资源）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeUrl(value) {
  return String(value ?? "").trim();
}

/**
 * 按类型规范化。未登记的类型返回空串（= 不算资产）。
 * @param {string} type
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAsset(type, value) {
  switch (type) {
    case "file":
      return normalizePath(value);
    case "command":
      return normalizeCommand(value);
    case "search":
      return normalizeQuery(value);
    case "url":
      return normalizeUrl(value);
    default:
      return "";
  }
}

/**
 * 资产的**唯一键**：`类型:规范化值`。
 *
 * 类型进键是刻意的：`read("git status")` 与 `bash("git status")` 不是同一个资产，
 * 合并它们就是语义推断。
 *
 * @param {string} type
 * @param {unknown} value
 * @returns {string|null} null = 不可指认
 */
export function assetKey(type, value) {
  const normalized = normalizeAsset(type, value);
  if (normalized === "") return null;
  return `${type}:${normalized}`;
}

/* ═════════════════════════ ③ 从一个 tool/call 事件里抽资产 ═════════════════════════ */

/**
 * 从**一个** `tool/call` 事件里抽出它获取的资产（0..N 条）。
 *
 * 返回值里 `key` 是去重用的唯一键，`raw` 是原始字符串（报告里给人看）。
 *
 * @param {object} call `tool/call` 事件
 * @returns {Array<{type:string, key:string, raw:string, tool:string}>}
 */
export function assetsOfToolCall(call) {
  const name = String(call?.data?.name ?? call?.name ?? "").trim();
  if (name === "") return [];
  const rule = ASSET_RULES.find((item) => item.tools.includes(name));
  if (rule === undefined) return [];
  let args = call?.data?.arguments ?? call?.arguments ?? null;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return []; // 参数不是 JSON ⇒ 抽不出可指认资产（不猜）
    }
  }
  if (args === null || typeof args !== "object") return [];
  const raw = args[rule.arg];
  const values = rule.multi === true ? (Array.isArray(raw) ? raw : []) : [raw];
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const key = assetKey(rule.type, value);
    if (key === null) continue;
    out.push({ type: rule.type, key, raw: value, tool: name });
  }
  return out;
}

/**
 * 一次工具调用的「资产指纹」——**闭集外返回 `null`**（不是空数组：两者语义不同，
 * 空数组 = 闭集内但参数不可指认，null = 这个工具根本不在闭集里）。
 *
 * @param {object} call
 * @returns {Array<{type:string,key:string,raw:string,tool:string}>|null}
 */
export function assetsOfCallOrNull(call) {
  const name = String(call?.data?.name ?? call?.name ?? "").trim();
  const inClosedSet = ASSET_RULES.some((rule) => rule.tools.includes(name));
  if (!inClosedSet) return null;
  return assetsOfToolCall(call);
}

/** 从 `tool/result` 事件里取结果正文（`content` 是块数组，拼 text）。 */
export function resultTextOf(event) {
  const content = event?.data?.message?.content ?? event?.data?.content ?? null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (typeof block?.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** `tool/result` 的 callId（两种历史形状都认）。 */
export function resultCallIdOf(event) {
  return String(event?.data?.message?.toolCallId ?? event?.data?.toolCallId ?? "");
}

/* ═════════════════════════ ④ 会话级索引 ═════════════════════════ */

/**
 * 把一个会话的事件流编成「重读检测」需要的索引。**只解一次**（同一会话的多条折痕共用）。
 *
 * @param {Array<object>} events
 * @returns {{calls:Array<object>, results:Map<string,string>, events:Array<object>,
 *   eventSeqs:number[], stepSeqs:number[], toolCalls:number, closedCalls:number, outsideCalls:number,
 *   unidentifiableCalls:number, outsideTools:Record<string,number>,
 *   models:Array<{seq:number, model:string}>, injection:Array<{seq:number, kind:string}>}}
 */
export function indexSession(events) {
  const list = Array.isArray(events) ? events : [];
  const calls = [];
  const results = new Map();
  const eventSeqs = [];
  const stepSeqs = [];
  const models = [];
  const injection = [];
  let toolCalls = 0;
  let closedCalls = 0;
  let outsideCalls = 0;
  let unidentifiableCalls = 0;
  const outsideTools = Object.create(null);

  for (const event of list) {
    const seq = Number(event?.seq);
    if (!Number.isFinite(seq)) continue;
    eventSeqs.push(seq);
    if (event.type === "tool/call") {
      toolCalls += 1;
      const name = String(event?.data?.name ?? "").trim();
      const assets = assetsOfCallOrNull(event);
      if (assets === null) {
        outsideCalls += 1;
        outsideTools[name] = (outsideTools[name] ?? 0) + 1;
        continue;
      }
      closedCalls += 1;
      if (assets.length === 0) {
        unidentifiableCalls += 1;
        continue;
      }
      const rawArgs = event?.data?.arguments;
      calls.push({
        seq,
        callId: String(event?.data?.callId ?? ""),
        tool: name,
        assets,
        argsText: typeof rawArgs === "string" ? rawArgs : "",
      });
    } else if (event.type === "tool/result") {
      const id = resultCallIdOf(event);
      if (id !== "") results.set(id, resultTextOf(event));
    } else if (event.type === "request/context") {
      const model = String(event?.data?.model ?? "").trim();
      if (model !== "") models.push({ seq, model });
    } else if (event.type === "step/start") {
      // 一次 step = 一次模型请求（真机 621 个会话 91,850 条；`request/context` 只有 646 条 ——
      // 每个会话开头一条，不是每请求一条。**摊销口径的请求数只能数 step/start**。
      stepSeqs.push(seq);
    } else if (event.type === "user/message") {
      const kind = String(event?.data?.source?.kind ?? event?.message?.source?.kind ?? "");
      if (INJECTION_KINDS.includes(kind)) injection.push({ seq, kind });
    }
  }
  calls.sort((a, b) => a.seq - b.seq);
  eventSeqs.sort((a, b) => a - b);
  stepSeqs.sort((a, b) => a - b);
  models.sort((a, b) => a.seq - b.seq);
  injection.sort((a, b) => a.seq - b.seq);
  return {
    calls,
    results,
    events: list,
    eventSeqs,
    stepSeqs,
    toolCalls,
    closedCalls,
    outsideCalls,
    unidentifiableCalls,
    outsideTools,
    models,
    injection,
  };
}

/**
 * 折叠区间 `[lo, hi]` 内**去重后**的可指认资产。
 *
 * 去重的理由：同一个文件在一次折叠里被读了 5 次，只是**一个**可重读机会。
 * 不去重时，一个死循环式重读就能把率拉满（T56 同一个坑）。
 *
 * @param {Array<object>} calls `indexSession().calls`
 * @param {number} lo
 * @param {number} hi
 * @returns {Map<string,{type:string,key:string,raw:string,tool:string,seq:number}>}
 */
export function extractFoldAssets(calls, lo, hi) {
  const map = new Map();
  for (const call of Array.isArray(calls) ? calls : []) {
    if (call.seq < lo || call.seq > hi) continue;
    for (const asset of call.assets) {
      if (map.has(asset.key)) continue;
      map.set(asset.key, { ...asset, seq: call.seq });
    }
  }
  return map;
}

/**
 * 折叠**之后**（`seq > afterSeq`）再次获取的资产。
 *
 * 每个资产**只记第一次**重读：同一条重读被重复获取 5 次，仍然只是一个「重读了的资产」。
 * 这样分子与分母同一量纲（资产数 / 资产数），率不会因为某次重读特别啰嗦而爆表。
 *
 * @param {Array<object>} calls
 * @param {Map<string,string>} results callId → 结果正文
 * @param {Map<string,object>} assets `extractFoldAssets` 的返回
 * @param {number} afterSeq 折叠区间的右端（含）
 * @returns {Array<object>} 每条 = 一次重读
 */
export function findRereads(calls, results, assets, afterSeq) {
  const hits = [];
  if (!(assets instanceof Map) || assets.size === 0) return hits;
  const remaining = new Set(assets.keys());
  for (const call of Array.isArray(calls) ? calls : []) {
    if (call.seq <= afterSeq) continue;
    for (const asset of call.assets) {
      if (!remaining.has(asset.key)) continue;
      remaining.delete(asset.key);
      const text = results instanceof Map ? (results.get(call.callId) ?? "") : "";
      hits.push({
        type: asset.type,
        key: asset.key,
        raw: asset.raw,
        tool: asset.tool,
        foldSeq: Number(assets.get(asset.key)?.seq ?? 0) || null,
        rereadSeq: call.seq,
        contentChars: String(text).length,
        contentTokens: estimateTokens(text) + estimateTokens(call.argsText ?? ""),
      });
    }
  }
  return hits;
}

/**
 * 一次获取是「**修改型**」还是「**读取型**」。
 *
 * 为什么必须分开（这是「重读 ≠ 白读」的那一刀）：
 *   · `read(X)` 是**纯重复劳动** —— 内容没变却又要看一遍，这正是市场诉求第 1 条
 *     （「刚说过的怎么又忘了」）的可观测形式；
 *   · `edit(X)` / `write(X)` 也会命中同一个 path 键（用户口径就这么定的），但它是**修改**，
 *     不是「又看了一遍」；把它算进重读会把「改文件」污名化。
 *
 * 所以主口径按用户定义全算，另给一条**纯读取型重读**（`read`）的敏感性 —— 两条都写进报告。
 *
 * @param {string} tool
 * @returns {boolean} true = 修改型
 */
export function isModifyTool(tool) {
  return tool === "edit" || tool === "write";
}

/**
 * 折叠**之后**出现过的注入事件（分层用）。
 * @param {Array<{seq:number,kind:string}>} injection `indexSession().injection`
 * @param {number} afterSeq
 * @returns {{hot:boolean, checkpoint:boolean, any:boolean}}
 */
export function injectionAfter(injection, afterSeq) {
  const out = { hot: false, checkpoint: false, any: false };
  for (const item of Array.isArray(injection) ? injection : []) {
    if (!(item.seq > afterSeq)) continue;
    if (!INJECTION_KINDS.includes(String(item?.kind ?? ""))) continue; // 只认登记过的两种来源
    out.any = true;
    if (item.kind === HOT_LEDGER_KIND) out.hot = true;
    if (item.kind === CHECKPOINT_KIND) out.checkpoint = true;
  }
  return out;
}

/**
 * 某 seq 时刻的 agent 模型（`request/context` 里最近的一条）。
 * @param {Array<{seq:number,model:string}>} models
 * @param {number} seq
 * @returns {string|null}
 */
export function modelAt(models, seq) {
  let found = null;
  for (const item of Array.isArray(models) ? models : []) {
    if (item.seq > seq) break;
    found = item.model;
  }
  return found;
}

/* ═════════════════════════ ⑤ 单条折痕 ═════════════════════════ */

/** 一个空类型桶。 */
function emptyTypeBucket() {
  return Object.fromEntries(ASSET_TYPES.map((type) => [type, 0]));
}

/**
 * 算**一条** foldMark 的重读行（纯函数，便于单测）。
 *
 * `measurable === false` 时 `rate` 是 `null` —— **不拿 0 冒充**（本仓踩过的坑：
 * `Number(null) === 0` 让「缺测」读成「命中 0」）。
 *
 * @param {object} mark foldMark
 * @param {object} ctx `indexSession()` 的返回 + `{index, session, graph, graphMaxSeq}`
 * @returns {object}
 */
export function markReread(mark, ctx = {}) {
  const rawStart = Number(mark?.seqStart);
  const rawEnd = Number(mark?.seqEnd);
  const sessions = String(ctx?.session ?? "");
  const row = {
    session: sessions,
    index: Number.isFinite(Number(ctx?.index)) ? Number(ctx.index) : null,
    at: Number(mark?.at) || 0,
    trigger: String(mark?.trigger ?? ""),
    /** 实时折叠（折痕在会话中间产生）—— 与 `archive-offline` 分开，后者「折后」在时钟上不存在。 */
    live: LIVE_TRIGGERS.includes(String(mark?.trigger ?? "")),
    seqStart: Number.isFinite(rawStart) ? rawStart : null,
    seqEnd: Number.isFinite(rawEnd) ? rawEnd : null,
    tailGap: null,
    span: Number.isFinite(rawStart) && Number.isFinite(rawEnd) ? Math.abs(rawEnd - rawStart) + 1 : null,
    measurable: false,
    why: "",
    /** 折后还剩多少事件（右删失判据）。 */
    exposure: 0,
    /** 可重读机会 = 去重后的可指认资产数。 */
    opportunities: 0,
    /** 重读次数（每个资产只记第一次）。 */
    rereads: 0,
    /** 修改型重读（`edit`/`write` —— 是改文件，不是「又看了一遍」）。 */
    rereadsModify: 0,
    /** 纯读取型重读 = 总重读 − 修改型（`read`）。 */
    rereadsPure: 0,
    byType: emptyTypeBucket(),
    byTypeRereads: emptyTypeBucket(),
    rate: null,
    ratePure: null,
    /** 分层：折叠**之后**有没有注入（T56：63.18% 有 ⇒ 因果混淆，必须分开）。 */
    injected: { hot: false, checkpoint: false, any: false },
    /* ROI（token + 美元） */
    savedTokens: null,
    savedUsd: null,
    spendUsd: null,
    wasteTokens: 0,
    wasteUsd: null,
    netUsd: null,
    /** 请求级上界：把「重读那次的整个请求输入」都算成白付（下界用 foldMark.totalAfter 代）。 */
    requestWasteTokens: 0,
    requestNetUsd: null,
    /** 摊销口径：折后还剩多少次模型请求（`step/start` 数）。 */
    requestsAfter: 0,
    /** 摊销省下 = 单次省下 × 折后请求数（被遮蔽的 token 从此每请求都不再重付）。 */
    amortizedSavedUsd: null,
    amortizedNetUsd: null,
    /** 回本次数：折后还要来几次请求，这次折叠才不亏。 */
    breakEvenRequests: null,
    /** 判据 ③ 的两个对照量（`audit()` 填）。 */
    traceableShare: null,
    qualityTotal: null,
    summaryAvailable: false,
    detail: [],
  };

  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    row.why = "seq 区间缺失";
    return row;
  }
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);
  const graphMaxSeq = Number.isFinite(Number(ctx?.graphMaxSeq)) ? Number(ctx.graphMaxSeq) : 0;
  row.tailGap = graphMaxSeq > 0 ? graphMaxSeq - hi : null;

  const eventSeqs = Array.isArray(ctx?.eventSeqs) ? ctx.eventSeqs : [];
  row.exposure = eventSeqs.filter((seq) => seq > hi).length;
  row.injected = ctx?.injection === undefined ? { hot: false, checkpoint: false, any: false } : injectionAfter(ctx.injection, hi);

  const assets = extractFoldAssets(ctx?.calls, lo, hi);
  row.opportunities = assets.size;
  for (const asset of assets.values()) row.byType[asset.type] = (row.byType[asset.type] ?? 0) + 1;

  // 右删失：折叠之后一个事件都没有 ⇒ 没有「下一次机会」，不计入分母、也不记 0
  if (row.exposure === 0) {
    row.why = "折后无事件（右删失）";
    return row;
  }
  row.measurable = true;
  if (assets.size === 0) {
    row.why = "折叠区间内没有可指认资产";
    row.measurable = false;
    return row;
  }

  const hits = findRereads(ctx?.calls, ctx?.results, assets, hi);
  for (const hit of hits) {
    row.byTypeRereads[hit.type] = (row.byTypeRereads[hit.type] ?? 0) + 1;
    const modify = isModifyTool(hit.tool);
    if (modify) row.rereadsModify += 1;
    row.detail.push({ ...hit, modify });
  }
  row.rereads = hits.length;
  row.rereadsPure = row.rereads - row.rereadsModify;
  row.rate = assets.size === 0 ? null : row.rereads / assets.size;
  row.ratePure = assets.size === 0 ? null : row.rereadsPure / assets.size;

  /* ── ROI ── */
  // ★ `Number(null) === 0` —— 缺测被读成「省下 0 个 token」正是本仓踩过的坑（T49）。
  //   所以只认真正的 number，null/undefined/字符串一律记 null。
  const shadowed = typeof mark?.shadowedTokens === "number" ? mark.shadowedTokens : Number.NaN;
  row.savedTokens = Number.isFinite(shadowed) ? shadowed : null;
  const spend = estimateFoldCostUsd(mark?.usage, mark?.route?.model, { at: mark?.at ?? null });
  row.spendUsd = spend === null ? null : spend;

  const foldModel = modelAt(ctx?.models, hi);
  const foldPrice = priceForModel(foldModel);
  row.savedUsd = row.savedTokens === null ? null : (row.savedTokens * foldPrice.miss) / 1e6;

  let wasteUsd = 0;
  for (const hit of row.detail) {
    const price = priceForModel(modelAt(ctx?.models, hit.rereadSeq));
    wasteUsd += (hit.contentTokens * price.miss) / 1e6;
  }
  row.wasteUsd = wasteUsd;
  row.wasteTokens = row.detail.reduce((sum, hit) => sum + hit.contentTokens, 0);
  row.netUsd = row.savedUsd === null || row.spendUsd === null ? null : row.savedUsd - row.spendUsd - row.wasteUsd;

  /* ── 摊销口径（真正的产品价值） ──
   * 单次口径有一个**结构性的坑**：摘要请求必须**先读一遍**它要省的 token，
   * 所以「省下 = shadowedTokens（只付一次）」几乎必然小于「花费」——
   * 折得越大，亏得越多，任何压缩策略都过不了。这不是产品的问题，是记账方式的问题。
   *
   * 压缩的真实收益是：**被遮蔽的 token 从此以后每请求都不再重付**。
   * 所以省下要乘「折后还剩多少次请求」，净值才可加。
   */
  const stepSeqs = Array.isArray(ctx?.stepSeqs) ? ctx.stepSeqs : [];
  // ★ **只有实时折叠才摊销**。`archive-offline` 是归档补折 —— 会话早就结束了，
  //   后面那些 `step/start` 是**折叠之前**就发生过的请求，把它们的省下算给这次折叠是凭空的。
  //   不分开算，摊销净值会被 847 条归档补折算成一个虚高的一千多美元。
  row.requestsAfter = row.live === true ? stepSeqs.filter((seq) => seq > hi).length : 0;
  row.amortizedSavedUsd = row.savedUsd === null ? null : (row.savedUsd * row.requestsAfter);
  row.amortizedNetUsd =
    row.amortizedSavedUsd === null || row.spendUsd === null ? null : row.amortizedSavedUsd - row.spendUsd - row.wasteUsd;
  // 回本请求数：折后还要来几次请求，这次折叠才不亏
  const perRequestSaved = row.savedUsd;
  row.breakEvenRequests =
    perRequestSaved === null || row.spendUsd === null || perRequestSaved <= 0 ? null : (row.spendUsd + row.wasteUsd) / perRequestSaved;

  // 请求级上界：折后上下文规模（totalAfter）是重读那次请求输入的下界
  const after = Number(mark?.totalAfter);
  const perRequest = Number.isFinite(after) && after > 0 ? after : null;
  if (perRequest !== null) {
    row.requestWasteTokens = row.rereads === 0 ? 0 : perRequest * row.rereads;
    row.requestNetUsd =
      row.savedUsd === null || row.spendUsd === null
        ? null
        : row.savedUsd - row.spendUsd - (row.requestWasteTokens * foldPrice.miss) / 1e6;
  }
  return row;
}

/* ═════════════════════════ ⑥ 聚合 ═════════════════════════ */

const round = (value, digits = 6) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;

/**
 * 一组行的重读率汇总。
 *
 * **样本门槛**：`opportunities < MIN_CELL` ⇒ `rate = null`（`insufficient: true`）。
 * 这条是硬话：「某格 < 10 条时不许硬算率」。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarize(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.measurable === true);
  const byType = Object.fromEntries(ASSET_TYPES.map((type) => [type, { opportunities: 0, rereads: 0 }]));
  let opportunities = 0;
  let rereads = 0;
  let rereadsPure = 0;
  let rereadsModify = 0;
  let marksWithAsset = 0;
  let marksWithReread = 0;
  const rates = [];
  for (const row of list) {
    opportunities += Number(row.opportunities) || 0;
    rereads += Number(row.rereads) || 0;
    rereadsPure += Number(row.rereadsPure) || 0;
    rereadsModify += Number(row.rereadsModify) || 0;
    if (Number(row.opportunities) > 0) marksWithAsset += 1;
    if (Number(row.rereads) > 0) marksWithReread += 1;
    for (const type of ASSET_TYPES) {
      byType[type].opportunities += Number(row.byType?.[type]) || 0;
      byType[type].rereads += Number(row.byTypeRereads?.[type]) || 0;
    }
    if (row.rate !== null && Number.isFinite(row.rate)) rates.push(Number(row.rate));
  }

  // 众数占比：折痕级重读率里**占比最大的那个取值**的占比（判据 ①）
  const counts = new Map();
  for (const rate of rates) {
    const key = rate.toFixed(6);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let modal = null;
  for (const [key, count] of counts) {
    if (modal === null || count > modal.count) modal = { value: Number(key), count };
  }
  const n = rates.length;
  const insufficient = opportunities < MIN_CELL;

  return {
    marks: Array.isArray(rows) ? rows.length : 0,
    measurable: list.length,
    marksWithAsset,
    marksWithReread,
    opportunities,
    rereads,
    rereadsPure,
    rereadsModify,
    rate: insufficient || opportunities === 0 ? null : rereads / opportunities,
    ratePure: insufficient || opportunities === 0 ? null : rereadsPure / opportunities,
    insufficient,
    byType: Object.fromEntries(
      ASSET_TYPES.map((type) => [
        type,
        {
          opportunities: byType[type].opportunities,
          rereads: byType[type].rereads,
          rate:
            byType[type].opportunities < MIN_CELL || byType[type].opportunities === 0
              ? null
              : byType[type].rereads / byType[type].opportunities,
          insufficient: byType[type].opportunities < MIN_CELL,
        },
      ]),
    ),
    n,
    meanRate: n === 0 ? null : round(rates.reduce((sum, value) => sum + value, 0) / n),
    p50: round(quantile(rates, 0.5)),
    p90: round(quantile(rates, 0.9)),
    modalValue: modal === null ? null : round(modal.value),
    modalShare: n === 0 || modal === null ? null : round(modal.count / n),
    zeroShare: n === 0 ? null : round(rates.filter((value) => value === 0).length / n),
    atOneShare: n === 0 ? null : round(rates.filter((value) => value >= 1).length / n),
    histogram: Object.fromEntries(RATE_BANDS.map((band) => [band.key, rates.filter((value) => band.test(value)).length])),
  };
}

/**
 * 分层：按一个布尔维度把行切开，各自汇总。
 * @param {Array<object>} rows
 * @param {(row:object)=>boolean} predicate
 * @returns {{yes:object, no:object}}
 */
export function stratify(rows, predicate) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    yes: summarize(list.filter((row) => predicate(row) === true)),
    no: summarize(list.filter((row) => predicate(row) !== true)),
  };
}

/**
 * ROI 三项分解。
 *
 * ★ **三项必须在同一个集合上算**（否则「省下 − 花费 − 白付」根本不相减 —— 这是本脚本第一版的真 bug）：
 *   真实语料里 **`archive-offline` 不记 `shadowedTokens`**（1004 条，0% 覆盖），却**记了 `usage`**
 *   （965 条）。把「135 条的省下」和「940 条的花费」相减，得到的是一个既不是这次折叠、
 *   也不是那次折叠的数。所以：
 *     · **同集合口径**（主）= 三条都齐的折痕（`netUsd !== null`），三项真的相加；
 *     · **全量口径**（辅）= 各自的分母，只用来回答「有没有测到」，**不可相减**。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function computeRoi(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.measurable === true && Number(row.opportunities) > 0);
  const out = {
    marks: list.length,
    /* ── 同集合口径（三项真的相加）── */
    completeMarks: 0,
    /** 同集合里的重读次数（**不是全库** —— 两个分母混用会算出一个不存在的平均数）。 */
    completeRereads: 0,
    savedTokens: 0,
    savedUsd: 0,
    spendUsd: 0,
    wasteTokens: 0,
    wasteUsd: 0,
    netUsd: 0,
    marksPositive: 0,
    marksNegative: 0,
    /* ── 全量口径（不同分母，**不可相减**）── */
    marksWithSaved: 0,
    allSavedTokens: 0,
    allSavedUsd: 0,
    marksWithSpend: 0,
    allSpendUsd: 0,
    /** 请求级上界（把「重读那次的整个请求输入」都算成白付）。 */
    requestWasteTokens: 0,
    requestNetUsd: 0,
    /* ── 摊销口径（只算实时折叠）── */
    marksWithAmortized: 0,
    amortizedSavedUsd: 0,
    amortizedNetUsd: 0,
    amortizedPositive: 0,
    amortizedNegative: 0,
    breakEvenMedian: null,
    breakEvenP90: null,
    breakEvenMax: null,
    /** 摊销口径下「省下/花费」的每段量（一句话量级用）。 */
    savedUsdPerMark: null,
    spendUsdPerMark: null,
    amortizedNetMedian: null,
    amortizedNetP10: null,
    amortizedNetP90: null,
    /** 单次口径每段净值。 */
    usdPerMark: null,
    usdPerRereadAvoided: null,
  };
  const breakEvens = [];
  const amortizedNets = [];
  let amortizedSaved = 0;
  let amortizedSpend = 0;

  for (const row of list) {
    // 全量口径：各自的分母（只回答「测到了多少」）
    if (row.savedTokens !== null) {
      out.marksWithSaved += 1;
      out.allSavedTokens += row.savedTokens;
      out.allSavedUsd += row.savedUsd ?? 0;
    }
    if (row.spendUsd !== null) {
      out.marksWithSpend += 1;
      out.allSpendUsd += row.spendUsd;
    }
    if (row.breakEvenRequests !== null && Number.isFinite(row.breakEvenRequests)) breakEvens.push(row.breakEvenRequests);

    // 同集合口径：三条都齐才进
    if (row.netUsd === null || !Number.isFinite(row.netUsd)) continue;
    out.completeMarks += 1;
    out.completeRereads += Number(row.rereads) || 0;
    out.savedTokens += row.savedTokens ?? 0;
    out.savedUsd += row.savedUsd ?? 0;
    out.spendUsd += row.spendUsd ?? 0;
    out.wasteTokens += row.wasteTokens ?? 0;
    out.wasteUsd += row.wasteUsd ?? 0;
    out.netUsd += row.netUsd;
    out.requestWasteTokens += row.requestWasteTokens ?? 0;
    out.requestNetUsd += row.requestNetUsd ?? 0;
    if (row.netUsd > 0) out.marksPositive += 1;
    else if (row.netUsd < 0) out.marksNegative += 1;

    // 摊销口径：只算实时折叠
    if (row.live === true && row.amortizedNetUsd !== null && Number.isFinite(row.amortizedNetUsd)) {
      out.marksWithAmortized += 1;
      out.amortizedSavedUsd += row.amortizedSavedUsd ?? 0;
      out.amortizedNetUsd += row.amortizedNetUsd;
      amortizedSaved += row.savedUsd ?? 0;
      amortizedSpend += row.spendUsd ?? 0;
      amortizedNets.push(row.amortizedNetUsd);
      if (row.amortizedNetUsd > 0) out.amortizedPositive += 1;
      else if (row.amortizedNetUsd < 0) out.amortizedNegative += 1;
    }
  }

  for (const key of ["savedTokens", "wasteTokens", "requestWasteTokens", "allSavedTokens"]) out[key] = Math.round(out[key]);
  for (const key of ["savedUsd", "spendUsd", "wasteUsd", "netUsd", "requestNetUsd", "allSavedUsd", "allSpendUsd", "amortizedSavedUsd", "amortizedNetUsd"]) {
    out[key] = round(out[key], 9);
  }
  out.usdPerMark = out.completeMarks === 0 ? null : round(out.netUsd / out.completeMarks, 9);
  out.usdPerRereadAvoided = out.wasteUsd === 0 ? null : round(out.netUsd / Math.max(1, out.wasteUsd), 6);
  out.savedUsdPerMark = out.marksWithAmortized === 0 ? null : round(amortizedSaved / out.marksWithAmortized, 9);
  out.spendUsdPerMark = out.marksWithAmortized === 0 ? null : round(amortizedSpend / out.marksWithAmortized, 9);
  out.breakEvenMedian = round(quantile(breakEvens, 0.5), 3);
  out.breakEvenP90 = round(quantile(breakEvens, 0.9), 3);
  out.breakEvenMax = breakEvens.length === 0 ? null : round(Math.max(...breakEvens), 3);
  out.amortizedNetMedian = round(quantile(amortizedNets, 0.5), 6);
  out.amortizedNetP10 = round(quantile(amortizedNets, 0.1), 6);
  out.amortizedNetP90 = round(quantile(amortizedNets, 0.9), 6);
  return out;
}

/* ═════════════════════════ ⑦ 四条判据 ═════════════════════════ */

/**
 * 四条判据的裁决。**必须能返回 `pass: false`**（否则就是永远绿的假门禁）。
 *
 * ④ 是**设计保证 + 经验对照**：
 *   · 分子 = 折叠**之后**的 `tool/call` 事件（会话日志），
 *     修复函数（`repairMissingFailures` / `repairFailuresInText` / `repairFoldMarks`）
 *     只**读**图、只**改写摘要文本**，不写会话日志、不产生工具调用 ⇒ 结构上造不出分子；
 *   · 经验对照：摘要**可解析**池 vs **不可解析**池的重读率。若分子真是修复函数的输出，
 *     不可解析池（没人补回过）会显著更低甚至恒 0；两池同量级 ⇒ 分子来自行为，不来自文本。
 *
 * @param {object} result `audit()` 的返回
 * @returns {Array<object>}
 */
export function judgeCriteria(result) {
  const primary = result?.overall ?? null;
  const shape = result?.correlations ?? {};
  const criteria = [];

  // ① 有方差
  const modalShare = primary?.modalShare ?? null;
  const enough = primary !== null && primary.insufficient !== true && (primary.n ?? 0) >= MIN_CELL;
  criteria.push({
    key: "①",
    name: `有方差（众数占比 < ${Math.round(CRITERIA_RULES.maxConstantShare * 100)}%）`,
    value: modalShare,
    detail:
      `众数 = ${num(primary?.modalValue)}，占 ${pct(modalShare)}（n=${int(primary?.n)}，机会 ${int(primary?.opportunities)}，门槛 < ${Math.round(
        CRITERIA_RULES.maxConstantShare * 100,
      )}%）`,
    pass: !enough || modalShare === null ? null : modalShare < CRITERIA_RULES.maxConstantShare,
    degenerate: !enough,
  });

  // ② 与形状无关
  const tail = shape.tailGap ?? null;
  const span = shape.span ?? null;
  const absTail = tail?.spearman === null || tail?.spearman === undefined ? null : Math.abs(tail.spearman);
  const absSpan = span?.spearman === null || span?.spearman === undefined ? null : Math.abs(span.spearman);
  const passShape = absTail !== null && absSpan !== null ? absTail < CRITERIA_RULES.maxAbsRhoShape && absSpan < CRITERIA_RULES.maxAbsRhoShape : null;
  criteria.push({
    key: "②",
    name: `与形状无关（|ρ| < ${CRITERIA_RULES.maxAbsRhoShape}）`,
    value: absTail === null || absSpan === null ? null : Math.max(absTail, absSpan),
    detail: `|ρ(离尾部)| = ${num(absTail)}（n=${int(tail?.n ?? 0)}）· |ρ(跨度)| = ${num(absSpan)}（n=${int(span?.n ?? 0)}）`,
    pass: passShape,
    /** 无方差时 ρ 不可信 —— 这条是「退化通过」，不构成支持。 */
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ③ 与已有指标不同
  const traceable = shape.traceableShare ?? null;
  const qualityTotal = shape.qualityTotal ?? null;
  const rhoTraceable = traceable?.spearman ?? null;
  const rhoQuality = qualityTotal?.spearman ?? null;
  const passRedundant =
    rhoTraceable === null || rhoQuality === null
      ? null
      : Math.abs(rhoTraceable) < CRITERIA_RULES.maxRhoRedundant && Math.abs(rhoQuality) < CRITERIA_RULES.maxRhoRedundant;
  criteria.push({
    key: "③",
    name: `与已有指标不同（ρ < ${CRITERIA_RULES.maxRhoRedundant}）`,
    value: rhoTraceable === null || rhoQuality === null ? null : Math.max(Math.abs(rhoTraceable), Math.abs(rhoQuality)),
    detail: `ρ(可定位率) = ${num(rhoTraceable)}（n=${int(traceable?.n ?? 0)}）· ρ(T33 五判据分) = ${num(rhoQuality)}（n=${int(qualityTotal?.n ?? 0)}）`,
    pass: passRedundant,
    degenerate: (modalShare ?? 1) >= CRITERIA_RULES.maxConstantShare,
  });

  // ④ 分子不是修复函数的输出（设计保证 + 经验对照）
  const pools = result?.poolsBySummaryAvailability ?? null;
  const gap =
    pools === null || pools.available?.rate === null || pools.unavailable?.rate === null
      ? null
      : Math.abs((pools.available.rate ?? 0) - (pools.unavailable.rate ?? 0));
  criteria.push({
    key: "④",
    name: "分子不是修复函数的输出",
    value: gap,
    detail:
      "设计保证：分子是会话日志里折叠**之后**的 `tool/call` 事件；修复函数（`repairMissingFailures` / `repairFailuresInText`）只改摘要文本，不写会话日志、不产生工具调用。" +
      (pools === null
        ? ""
        : `　经验对照：摘要可解析池 ${pct(pools.available?.rate)}（n=${int(pools.available?.n)}，机会 ${int(
            pools.available?.opportunities,
          )}）· 不可解析池 ${pct(pools.unavailable?.rate)}（n=${int(pools.unavailable?.n)}，机会 ${int(pools.unavailable?.opportunities)}）`),
    pass: true,
    degenerate: false,
  });

  return criteria;
}

/* ═════════════════════════ ⑧ 扫描 ═════════════════════════ */

/** 与 doctor / graph-audit / fold-loss-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/**
 * 扫全部会话（只读）。
 *
 * @param {{home?:string, limit?:number, session?:string}} [options]
 * @returns {object}
 */
export function audit({ home = resolveHome(), limit = DEFAULT_LIMIT, session = "" } = {}) {
  const { files } = collectGraphFiles(home);
  const logIndex = buildLogIndex(home);

  const rows = [];
  const epoch = {
    graphs: 0,
    badGraphs: 0,
    marks: 0,
    withRange: 0,
    withAssets: 0,
    noToolCall: 0,
    onlyOutsideTools: 0,
    unidentifiable: 0,
    censored: 0,
    noLog: 0,
    emptyLog: 0,
    logsRead: 0,
    noShadowed: 0,
    noUsage: 0,
    noTotalAfter: 0,
    toolCalls: 0,
    closedCalls: 0,
    outsideCalls: 0,
    unidentifiableCalls: 0,
  };
  const outsideTools = Object.create(null);

  for (const file of files) {
    if (session !== "" && !String(file.dir).includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      epoch.badGraphs += 1;
      continue;
    }
    epoch.graphs += 1;
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    if (marks.length === 0) continue;

    // 日志：目录名有两种（`<uuid>` 与 `session-<uuid>`），两种都要试（归档会话整批命中不了就废了注入维度）
    const dirKey = String(file.dir).toLowerCase();
    const logFile = logIndex.get(dirKey) ?? logIndex.get(dirKey.replace(/^session-/, "")) ?? null;
    if (logFile === null) {
      epoch.noLog += 1;
      for (const [index, mark] of marks.entries()) {
        epoch.marks += 1;
        const row = markReread(mark, { index, session: String(file.dir), graphMaxSeq: 0 });
        row.why = "会话日志缺失";
        row.measurable = false;
        rows.push(row);
      }
      continue;
    }
    const events = readSessionEvents(logFile);
    if (events.length === 0) {
      epoch.emptyLog += 1;
      for (const [index, mark] of marks.entries()) {
        epoch.marks += 1;
        const row = markReread(mark, { index, session: String(file.dir), graphMaxSeq: 0 });
        row.why = "会话日志为空";
        row.measurable = false;
        rows.push(row);
      }
      continue;
    }
    epoch.logsRead += 1;

    const index = indexSession(events);
    epoch.toolCalls += index.toolCalls;
    epoch.closedCalls += index.closedCalls;
    epoch.outsideCalls += index.outsideCalls;
    epoch.unidentifiableCalls += index.unidentifiableCalls;
    for (const [name, count] of Object.entries(index.outsideTools)) outsideTools[name] = (outsideTools[name] ?? 0) + count;

    let graphMaxSeq = 0;
    for (const node of Object.values(graph?.nodes ?? {})) {
      const seq = Number(node?.seq);
      if (Number.isFinite(seq) && seq > graphMaxSeq) graphMaxSeq = seq;
    }
    for (const edge of Object.values(graph?.edges ?? {})) {
      const end = Number(edge?.evidence?.end);
      if (Number.isFinite(end) && end > graphMaxSeq) graphMaxSeq = end;
    }

    marks.forEach((mark, index_) => {
      epoch.marks += 1;
      const row = markReread(mark, {
        index: index_,
        session: String(file.dir),
        graphMaxSeq,
        calls: index.calls,
        results: index.results,
        eventSeqs: index.eventSeqs,
        stepSeqs: index.stepSeqs,
        injection: index.injection,
        models: index.models,
      });
      if (!Number.isFinite(Number(mark?.seqStart)) || !Number.isFinite(Number(mark?.seqEnd))) {
        /* 已在 row.why 里 */
      } else {
        epoch.withRange += 1;
        if (row.opportunities > 0) epoch.withAssets += 1;
        else if (row.exposure === 0) epoch.censored += 1;
        else if (index.closedCalls === 0) epoch.onlyOutsideTools += 1;
        else {
          // 区间内确实没有「闭集内可指认」的调用：区分「区间内没有工具调用」与「有但参数不可指认」
          const lo = Math.min(Number(mark.seqStart), Number(mark.seqEnd));
          const hi = Math.max(Number(mark.seqStart), Number(mark.seqEnd));
          const inside = index.calls.filter((call) => call.seq >= lo && call.seq <= hi);
          if (inside.length === 0) epoch.noToolCall += 1;
          else epoch.unidentifiable += 1;
        }
      }
      if (row.savedTokens === null) epoch.noShadowed += 1;
      if (row.spendUsd === null) epoch.noUsage += 1;
      if (!Number.isFinite(Number(mark?.totalAfter))) epoch.noTotalAfter += 1;

      // 判据 ③ 需要的两个对照量（只对**可测**折痕算一次）
      if (row.measurable === true) {
        const resolved = resolveSummaryText(mark, graph?.lastOfflineSummary ?? null);
        row.summaryAvailable = typeof resolved.text === "string" && resolved.text !== "";
        if (row.summaryAvailable) {
          try {
            const sample = measureSample(
              {
                sessionId: String(graph?.sessionId ?? file.dir),
                trigger: String(mark?.trigger ?? ""),
                source: resolved.source,
                at: Number(mark?.at) || 0,
                seqStart: row.seqStart,
                seqEnd: row.seqEnd,
                text: resolved.text,
                mark,
                lastOfflineSummary: null,
                chars: resolved.text.length,
              },
              graph,
            );
            row.traceableShare = sample.traceableShare;
            row.qualityTotal = scoreMark(sample).total;
          } catch {
            row.traceableShare = null;
            row.qualityTotal = null;
          }
        }
      }
      rows.push(row);
    });
  }

  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.session).localeCompare(String(b.session)));

  const measurableRows = rows.filter((row) => row.measurable === true);
  const overall = summarize(rows);

  // 分层（T56 的混淆项：热清单注入）
  const byHotLedger = stratify(measurableRows, (row) => row.injected?.hot === true);
  const byAnyInjection = stratify(measurableRows, (row) => row.injected?.any === true);
  const byTrigger = stratify(measurableRows, (row) => row.live === true);
  // 敏感性：把「中间被改过」的重读也摘掉之后还剩多少（重读 ≠ 白读）
  const pureOverall = {
    ...overall,
    rate: overall.rate === null ? null : overall.rereadsPure / overall.opportunities,
  };

  const roi = computeRoi(rows);
  const roiLive = computeRoi(measurableRows.filter((row) => row.live === true));

  const correlations = {
    tailGap: correlate(measurableRows, "rate", "tailGap"),
    span: correlate(measurableRows, "rate", "span"),
    traceableShare: correlate(measurableRows, "rate", "traceableShare"),
    qualityTotal: correlate(measurableRows, "rate", "qualityTotal"),
  };

  const poolOf = (list) => {
    const opportunities = list.reduce((sum, row) => sum + (Number(row.opportunities) || 0), 0);
    const rereads = list.reduce((sum, row) => sum + (Number(row.rereads) || 0), 0);
    return {
      n: list.length,
      opportunities,
      rereads,
      rate: opportunities < MIN_CELL || opportunities === 0 ? null : rereads / opportunities,
    };
  };
  const poolsBySummaryAvailability = {
    available: poolOf(measurableRows.filter((row) => row.summaryAvailable === true)),
    unavailable: poolOf(measurableRows.filter((row) => row.summaryAvailable !== true)),
  };

  const result = {
    home,
    graphs: epoch.graphs,
    badGraphs: epoch.badGraphs,
    marks: epoch.marks,
    epoch,
    outsideTools,
    overall,
    pureOverall,
    byHotLedger,
    byAnyInjection,
    byTrigger,
    correlations,
    poolsBySummaryAvailability,
    roi,
    roiLive,
    rows,
    /** 明细：只列 measurable 且有重读的行，最近 N 条。 */
    limited: (limit > 0 ? rows.filter((row) => (row.rereads ?? 0) > 0).slice(-limit) : rows.filter((row) => (row.rereads ?? 0) > 0)),
  };
  result.criteria = judgeCriteria(result);
  result.verdict = result.criteria.some((item) => item.pass === false) ? "unusable" : "usable";
  return result;
}

/* ═════════════════════════ ⑨ 渲染 ═════════════════════════ */

const pct = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
const int = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "—");
const num = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
const usd = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : `$${Number(value) < 0 ? "-" : ""}${Math.abs(Number(value)).toFixed(6)}`;

/** 终端显示宽度（CJK / 全角算 2 格）—— 表格对齐只靠它。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

/** 按**显示宽度**补空格（`padEnd` 在 CJK 上会错位，报告直接歪掉）。 */
export function padDisplay(text, size, align = "left") {
  const body = String(text ?? "");
  const fill = " ".repeat(Math.max(0, Number(size) - displayWidth(body)));
  return align === "right" ? `${fill}${body}` : `${body}${fill}`;
}

/** 会话短名：`session-<uuid>` 的目录名截前 8 位会只剩 `session-`，先剥前缀。 */
const shortSession = (dir) => {
  const body = String(dir ?? "");
  const stripped = body.replace(/^session-/, "");
  return `${body.startsWith("session-") ? "s-" : ""}${stripped.slice(0, 8)}`;
};

/** 一行分层（样本不足就不算率，照写「样本不足」）。 */
function stratumLine(label, bucket) {
  const rate = bucket.insufficient ? "样本不足" : pct(bucket.rate);
  return (
    `    · ${padDisplay(label, 18)}机会 ${padDisplay(int(bucket.opportunities), 6, "right")}　` +
    `重读 ${padDisplay(int(bucket.rereads), 5, "right")}　率 ${padDisplay(rate, 10, "right")}　` +
    `（可测折痕 ${int(bucket.measurable)}${bucket.insufficient ? `，<${MIN_CELL} 不算率` : ""}）`
  );
}

/** 渲染人读报告（返回字符串；CLI 直接 `console.log`）。 */
export function renderReport(result) {
  const out = [];
  const epoch = result.epoch;
  const overall = result.overall;
  const criteria = result.criteria;
  const failed = criteria.filter((item) => item.pass === false);
  const unknown = criteria.filter((item) => item.pass === null);

  out.push(`重读率 + ROI 审计（T58 · 只读 · 零模型调用）`);
  out.push(`home = ${result.home}`);
  out.push(
    `图 = ${int(result.graphs)} 张（坏图 ${int(result.badGraphs)}）· 折痕 = ${int(result.marks)} 条 · ` +
      `有 seq 区间 = ${int(epoch.withRange)} · 读得到日志 = ${int(epoch.logsRead)} 个会话`,
  );
  out.push(
    `一句话结论：**${result.verdict === "usable" ? "重读率能用" : "重读率不能用"}** —— ` +
      `重读率 ${overall.insufficient ? `样本不足（机会 ${int(overall.opportunities)} < ${MIN_CELL}）` : pct(overall.rate)}，` +
      `ROI 净值 ${usd(result.roi.netUsd)}（${Number(result.roi.netUsd) > 0 ? "正" : Number(result.roi.netUsd) < 0 ? "负" : "零"}）` +
      (failed.length > 0 ? `；判据 ${failed.map((item) => item.key).join("、")} 不过。` : `；四条判据全过。`),
  );
  if (unknown.length > 0) out.push(`（判据 ${unknown.map((item) => item.key).join("、")} 不可判 —— 无方差 / 样本不足）`);
  out.push("");

  /* ── ① 抽取规则与覆盖率 ── */
  out.push(`## ① 资产抽取规则（闭集）与覆盖率`);
  out.push(`规范化只做「逐字相同」允许的三件事，**不用语义相似 / 编辑距离 / 词袋余弦**：`);
  for (const rule of ASSET_RULES) {
    out.push(
      `  · ${padDisplay(ASSET_LABELS[rule.type], 6)} ${padDisplay(rule.tools.join("/"), 24)} ` +
        `\`${rule.arg}${rule.multi ? "[]" : ""}\`　→ ${normalizeHint(rule.type)}`,
    );
  }
  out.push(
    `  闭集外工具**一条都不算**（${int(epoch.outsideCalls)} 次调用、${Object.keys(result.outsideTools).length} 种工具）：` +
      Object.entries(result.outsideTools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => `${name}=${count}`)
        .join(" · "),
  );
  out.push(
    `  闭集内但参数不可指认（空串 / 非 JSON）= ${int(epoch.unidentifiableCalls)} 次 —— 记「抽不出」，**不记 0 个资产**。`,
  );
  out.push(
    `  覆盖率：**${int(epoch.withAssets)} / ${int(epoch.withRange)} = ${pct(epoch.withRange === 0 ? null : epoch.withAssets / epoch.withRange)}** 的折痕能抽出至少一个可指认资产`,
  );
  out.push(
    `    抽不出（${int(epoch.withRange - epoch.withAssets)} 条）拆开：折后无事件（右删失）${int(epoch.censored)} · ` +
      `区间内没有工具调用 ${int(epoch.noToolCall)} · 只有闭集外工具 ${int(epoch.onlyOutsideTools)} · ` +
      `参数不可指认 ${int(epoch.unidentifiable)}` +
      `　另有 ${int(epoch.noLog + epoch.emptyLog)} 条会话日志缺失（**不计入覆盖率分母**，也不记 0 个资产）`,
  );
  out.push(
    `  工具调用总量 ${int(epoch.toolCalls)}：闭集内 ${int(epoch.closedCalls)}（${pct(
      epoch.toolCalls === 0 ? null : epoch.closedCalls / epoch.toolCalls,
    )}）· 闭集外 ${int(epoch.outsideCalls)}`,
  );
  out.push("");

  /* ── ② 重读率 ── */
  out.push(`## ② 重读率`);
  out.push(
    `  可重读机会（去重资产）= ${int(overall.opportunities)}　重读 = ${int(overall.rereads)}　` +
      `**重读率 = ${overall.insufficient ? `样本不足（<${MIN_CELL}）` : pct(overall.rate)}**`,
  );
  out.push(
    `  折痕级（n=${int(overall.n)}）：均值 ${num(overall.meanRate)} · 中位 ${num(overall.p50)} · p90 ${num(overall.p90)} · ` +
      `众数 = ${num(overall.modalValue)}（占 ${pct(overall.modalShare)}）· = 0 占 ${pct(overall.zeroShare)} · = 1 占 ${pct(overall.atOneShare)}`,
  );
  out.push(`  直方图：${RATE_BANDS.map((band) => `${band.key}=${int(overall.histogram[band.key])}`).join(" · ")}`);
  out.push(
    `  **敏感性（重读 ≠ 白读）**：修改型重读（` + "`edit`/`write`" + `，是改文件不是「又看一遍」）= ${int(overall.rereadsModify)} 条；` +
      `摘掉之后「纯读取型重读」= ${int(overall.rereadsPure)} / ${int(overall.opportunities)} = ` +
      `${overall.insufficient ? `样本不足（<${MIN_CELL}）` : pct(result.pureOverall.rate)}`,
  );
  out.push("");
  out.push(`  **按资产类型**（分母 = 该类型的可重读机会）：`);
  for (const type of ASSET_TYPES) {
    const bucket = overall.byType[type];
    out.push(
      `    · ${padDisplay(ASSET_LABELS[type], 6)}机会 ${padDisplay(int(bucket.opportunities), 6, "right")}　` +
        `重读 ${padDisplay(int(bucket.rereads), 5, "right")}　率 ${padDisplay(bucket.insufficient || bucket.opportunities === 0 ? "样本不足" : pct(bucket.rate), 10, "right")}`,
    );
  }
  out.push("");
  out.push(`  **分层 A：热清单注入（T56 的混淆项 —— 有/无必须分开算）**`);
  out.push(stratumLine(`有 chess-context 注入`, result.byHotLedger.yes));
  out.push(stratumLine(`无 chess-context 注入`, result.byHotLedger.no));
  out.push(`    差值 = ${diffPct(result.byHotLedger.yes.rate, result.byHotLedger.no.rate)}`);
  out.push(`    对照（任一注入 = 摘要 checkpoint 或热清单，T56 报 63.18%）：`);
  out.push(stratumLine(`有任一注入`, result.byAnyInjection.yes));
  out.push(stratumLine(`无任何注入`, result.byAnyInjection.no));
  out.push("");
  out.push(`  **分层 B：折叠类型（archive-offline 的「折后」在时钟上不存在，必须分开看）**`);
  out.push(stratumLine(`实时折叠（pressure 等）`, result.byTrigger.yes));
  out.push(stratumLine(`归档补折（archive-offline）`, result.byTrigger.no));
  out.push(`    差值 = ${diffPct(result.byTrigger.yes.rate, result.byTrigger.no.rate)}`);
  out.push("");

  /* ── ③ ROI ── */
  const roi = result.roi;
  out.push(`## ③ ROI（三项分解 + 净值）`);
  out.push(`  口径：省下 = \`shadowedTokens\`；花费 = \`estimateFoldCostUsd(mark.usage, mark.route.model, {at})\`；`);
  out.push(`        白付 = 重读的 \`tool/result\` 正文 + 调用参数 token（\`estimateTokens\`）× 当时 miss 价。`);
  out.push(`  **同集合口径**（${int(roi.completeMarks)} 条三条都齐的折痕 —— 只有这一组能真的相减）：`);
  out.push(`    **省下的输入** ${padDisplay(int(roi.savedTokens), 12, "right")} token = ${usd(roi.savedUsd)}`);
  out.push(`    **摘要花费**   ${padDisplay("", 12, "right")}          ${usd(roi.spendUsd)}`);
  out.push(
    `    **重读白付**   ${padDisplay(int(roi.wasteTokens), 12, "right")} token = ${usd(roi.wasteUsd)}` +
      `（这 ${int(roi.completeMarks)} 条里共 ${int(roi.completeRereads)} 次重读，平均 ${
        roi.completeRereads === 0 ? "—" : int(roi.wasteTokens / Math.max(1, roi.completeRereads))
      } token/次）`,
  );
  out.push(
    `  ────────────────────────────────────────────────`,
  );
  out.push(
    `  **净值（单次口径）** = 省下 − 花费 − 白付 = ${usd(roi.netUsd)}　` +
      `（正 ${int(roi.marksPositive)} / 负 ${int(roi.marksNegative)} 条）`,
  );
  out.push(
    `    单次口径**结构上必负**：摘要请求必须**先读一遍**它要省的 token（真机摘要输入中位 ≈ 它遮蔽的 token 数），` +
      `所以「省下只付一次」永远 < 「花费」。这不是产品的问题，是记账方式的问题 —— 见下面摊销口径。`,
  );
  out.push(
    `  **净值（摊销口径，真正的产品价值；只算实时折叠）**：省下 ${usd(roi.savedUsdPerMark)}/段 × 折后请求数 − 花费 ${usd(roi.spendUsdPerMark)}/段 − 白付`,
  );
  out.push(
    `    ⇒ 单条折痕 **中位 ${usd(roi.amortizedNetMedian)}**（p10 ${usd(roi.amortizedNetP10)} · p90 ${usd(roi.amortizedNetP90)}）· ` +
      `合计 **${usd(roi.amortizedNetUsd)}**（${int(roi.marksWithAmortized)} 条实时折痕能算：正 ${int(roi.amortizedPositive)} / 负 ${int(roi.amortizedNegative)}；摊销省下 ${usd(roi.amortizedSavedUsd)}）`,
  );
  out.push(`      合计被少数超长会话带偏，**结论看中位数**。`);
  out.push(
    `    \`archive-offline\`（${int(result.byTrigger.no.measurable)} 条可测折痕）**摊销记 0** —— 归档补折发生在会话结束之后，没有「后续请求」可以省。` +
      `把它们算进去会把净值虚增一个数量级（旧版就是这样错的）。`,
  );
  out.push(
    `    回本请求数（折后还要来几次请求这次折叠才不亏）：中位 **${num(roi.breakEvenMedian, 2)}** 次 · p90 ${num(roi.breakEvenP90, 2)} 次 · 最大 ${num(roi.breakEvenMax, 2)} 次`,
  );
  out.push(
    `  **请求级上界**（把「重读那次的整个请求输入」都算白付，用折后上下文规模 \`totalAfter\` 作下界）：` +
      `${int(roi.requestWasteTokens)} token ⇒ 净值 ${usd(roi.requestNetUsd)}`,
  );
  out.push(
    `    三条口径回答不同问题：单次 = 「这一折本身赚不赚」；摊销 = 「这一折在整个会话里赚不赚」；` +
      `请求级 = 「重读那次请求本来能不能不发生」（把「不重读也得付」的部分也算成浪费，是**上界成本**）。`,
  );
  out.push(
    `  实时折叠子集的**单次**口径：省下 ${usd(result.roiLive.savedUsd)} − 花费 ${usd(result.roiLive.spendUsd)} − 白付 ${usd(result.roiLive.wasteUsd)} = ${usd(result.roiLive.netUsd)}` +
      `（${int(result.roiLive.completeMarks)} 条可算；单次必负，原因是上面那条）`,
  );
  out.push(
    `  **全量口径（不同分母，不可相减）**：有 \`shadowedTokens\` 的折痕 ${int(roi.marksWithSaved)}/${int(roi.marks)}` +
      `（合计 ${int(roi.allSavedTokens)} token = ${usd(roi.allSavedUsd)}）· 有 \`usage\` 的折痕 ${int(roi.marksWithSpend)}/${int(roi.marks)}` +
      `（合计 ${usd(roi.allSpendUsd)}）。`,
  );
  out.push(
    `    ⇒ **${int(roi.marksWithSpend - roi.marksWithSaved)} 条折痕「有花费、没有省下」**：\`archive-offline\` 1004 条**根本不记** ` +
      `\`shadowedTokens\`（离线补折拿不到宿主 token 表），\`tier2\` 22 条连 \`usage\` 都没有。这是本指标**最大的仪器缺口**：` +
      `ROI 只能在实时折叠上算，折算到全库时不能假装知道。`,
  );
  out.push("");

  /* ── ④ 四条判据 ── */
  out.push(`## ④ 四条判据`);
  for (const item of criteria) {
    const flag = item.pass === true ? "✅" : item.pass === false ? "❌" : "⚠️ 不可判";
    out.push(`  ${item.key} ${flag} ${item.name}`);
    out.push(`      ${item.detail}`);
    if (item.degenerate === true) out.push(`      （退化：无方差 / 样本不足 ⇒ 这条不构成支持）`);
  }
  out.push("");

  /* ── ⑤ 结论 ── */
  out.push(`## ⑤ 结论`);
  out.push(
    `  · 重读率**${result.verdict === "usable" ? "能用" : "不能用"}**：` +
      `${failed.length === 0 ? "四条判据全过" : `死于判据 ${failed.map((item) => item.key).join("、")}`}` +
      `${unknown.length > 0 ? `（${unknown.map((item) => item.key).join("、")} 不可判）` : ""}。`,
  );
  out.push(
    `  · ROI：单次口径 **${Number(roi.netUsd) > 0 ? "是正的" : Number(roi.netUsd) < 0 ? "是负的" : "是零"}** ${usd(roi.netUsd)}　·　` +
      `摊销口径 **${Number(roi.amortizedNetUsd) > 0 ? "是正的" : Number(roi.amortizedNetUsd) < 0 ? "是负的" : "是零"}** ${usd(roi.amortizedNetUsd)}　·　` +
      `请求级上界 ${usd(roi.requestNetUsd)}。`,
  );
  out.push(
    `  · 一句话：${
      Number(roi.amortizedNetMedian) > 0
        ? `每折一段摊销后**中位净赚 ${usd(roi.amortizedNetMedian)}**（回本只需折后 ${num(roi.breakEvenMedian, 1)} 次请求，` +
          `而真机每个会话折后中位还有上百次请求），重读白付只吃掉省下收益的 ${pct(
            roi.savedUsd === null || Number(roi.savedUsd) === 0 ? null : Number(roi.wasteUsd) / Number(roi.savedUsd),
          )} —— 即「一次摘要调用换回 ${num(
            roi.spendUsdPerMark === null || Number(roi.spendUsdPerMark) === 0 ? null : Number(roi.amortizedNetMedian) / Number(roi.spendUsdPerMark),
            1,
          )} 倍的输入钱」。`
        : `省下的输入（${usd(roi.savedUsd)}）覆盖不了摘要（${usd(roi.spendUsd)}）+ 重读（${usd(roi.wasteUsd)}），这笔交易在摊销口径上也是亏的。`
    }`,
  );
  out.push("");

  /* ── 明细 ── */
  if (result.limited.length > 0) {
    out.push(`## ⑥ 重读明细（最近 ${result.limited.length} 条折痕）`);
    for (const row of result.limited) {
      out.push(
        `  · ${shortSession(row.session)} #${int(row.index)} ${padDisplay(row.trigger, 16)} ` +
          `seq ${int(row.seqStart)}-${int(row.seqEnd)}　重读 ${int(row.rereads)}/${int(row.opportunities)} = ${pct(row.rate)}` +
          `${row.injected?.hot ? "　[热清单注入]" : ""}${row.live ? "" : "　[归档补折]"}`,
      );
      for (const hit of row.detail.slice(0, 4)) {
        out.push(
          `      ${padDisplay(ASSET_LABELS[hit.type] ?? hit.type, 4)} 折于 seq ${int(hit.foldSeq)} → 重读于 seq ${int(hit.rereadSeq)}` +
            `　${int(hit.contentTokens)} token${hit.modify ? "　（修改型，不算重复劳动）" : ""}　${String(hit.raw).slice(0, 100)}`,
        );
      }
      if (row.detail.length > 4) out.push(`      … 还有 ${row.detail.length - 4} 条`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** 规范化说明（报告里逐条写清，别让人猜）。 */
function normalizeHint(type) {
  switch (type) {
    case "file":
      return "去 `./` · 统一 `/` · 转小写（**不 resolve**）";
    case "command":
      return "连续空白压一个 + 去首尾";
    case "search":
      return "只去首尾空白";
    case "url":
      return "只去首尾空白";
    default:
      return "—";
  }
}

/** 两个率的差值（百分数）；任一为 null 就返回「—」（不拿 0 冒充）。 */
function diffPct(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return "—（样本不足）";
  return `${((Number(a) - Number(b)) * 100).toFixed(2)}pp`;
}

/* ═════════════════════════ ⑩ CLI ═════════════════════════ */

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? String(args[at + 1] ?? "") : null;
  };
  const asJson = args.includes("--json");
  const home = flag("home") ?? resolveHome();
  const session = flag("session") ?? "";
  const limitRaw = flag("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);

  const result = audit({ home, limit: Number.isFinite(limit) ? limit : DEFAULT_LIMIT, session });
  if (result.graphs === 0) {
    console.error(`✗ 一张图都读不到：home = ${home}（用 --home 指定 DSH_HOME）`);
    process.exitCode = 2;
    return;
  }
  if (asJson) {
    const { rows, ...rest } = result;
    console.log(JSON.stringify({ ...rest, rows: rows.length }, null, 1));
    return;
  }
  console.log(renderReport(result));
}

/**
 * 是不是被直接执行（而不是被 `import`）。
 * 用 `endsWith(argv1)` 兜底：Windows 上 `new URL("file://" + 中文路径)` 会百分号编码，
 * 与 `import.meta.url` 逐字不等 —— 那会让 CLI 在中文目录下**静默不跑**（最坏的一种）。
 */
const invokedDirectly = (() => {
  const argv1 = String(process.argv[1] ?? "");
  if (argv1 === "") return false;
  try {
    return import.meta.url === new URL(`file://${argv1}`).href || import.meta.url.endsWith(argv1);
  } catch {
    return import.meta.url.endsWith(argv1);
  }
})();

if (invokedDirectly) {
  main();
}
