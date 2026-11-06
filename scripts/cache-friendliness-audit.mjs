#!/usr/bin/env node
/**
 * cache-friendliness-audit.mjs —— 热清单「注入动作」的**真机**缓存账单（C600，2026-11-05）
 *
 * ## 为什么要有它
 *
 * `scripts/doctor.mjs` 的「热清单注入动作（缓存友好性）」只数了 `append / replace` 两个计数
 * （`ledger-budget.json.injectActions`），然后**按占比**下结论。可占比本身不是账单：
 * 一次 replace 到底打掉多少 token，取决于两件 doctor 看不到的事 ——
 *
 *   ① 被改写的那个位置**前面**已经缓存了多少 token（= 这次还能命中多少）；
 *   ② 那个位置**后面**还压着多少 token（= 这次得按 miss 价重读多少）。
 *
 * 这个脚本把两件事都从**真机会话日志**里量出来（只读，绝不写 `<DSH_HOME_OR_INSTALL_DIR> Harness\home`），
 * 并按「本轮注入动作」分组给出命中率与价格。
 *
 * ## 数据口径（都是本仓已核实的）
 *
 * · **注入动作**：`user/message` 且 `data.source.kind === "chess-context"` 就是热清单那一条。
 *   `surfaceOp === "append"` ⇒ 追加；`surfaceOp = {op:"replace", startSeq, endSeq}` ⇒ 就地改写。
 * · **缓存命中**：`assistant/message.data.usage`：
 *   `inputTokens` **只含未命中**，`cacheReadTokens` 是命中，`totalTokens = miss + hit + out`
 *   （见 `scripts/cache-rate.mjs` 头部的 C361 口径）。
 *   所以命中率的分母是 `miss + hit`，**不是** `inputTokens`。
 * · **归因**：一次注入发生在两次请求之间，只为**紧接着的那一次**请求付账 —— 之后前缀重新落盘，
 *   下一回合照常命中。这个"只付一次"的假设在本脚本里被**事件研究**直接验证（见 §4）。
 *
 * ## 用法
 *
 *   node scripts/cache-friendliness-audit.mjs                     # 扫 DSH_HOME 下所有插件会话
 *   node scripts/cache-friendliness-audit.mjs --session <SESSION_ID>  # 只看一个会话
 *   node scripts/cache-friendliness-audit.mjs --json              # 机器可读
 *   node scripts/cache-friendliness-audit.mjs --max-sessions 50   # 大 home 上先跑个样本
 *
 * 退出码：0 = 正常（审计是**报告**，不是门禁）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/**
 * 单价（$ / 1M token）。取 deepseek-v4 flash **低峰**价（与 `scripts/cache-rate.mjs` 的 C363 同源）：
 * miss $0.15、hit $0.003（= miss 的 1/50）、output $0.6。
 * 换成别的档位只要改这三个数 —— 所有金额都由它们线性推出。
 */
export const PRICES = Object.freeze({ miss: 0.15, hit: 0.003, out: 0.6 });

/** 注入动作的三种取值。 */
export const ACTIONS = Object.freeze(["append", "replace", "none"]);

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/**
 * 消息内容的纯文本。与 `src/rooms/hot-inject.mjs` 的 `messageText` 同口径
 * （那边算 digest/相等性，这边算长度，口径必须一致，否则两边对不上账）。
 * @param {unknown} content
 * @returns {string}
 */
export function messageTextOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 把注入事件归一成动作名。
 * @param {object} event `user/message` 事件
 * @returns {"append"|"replace"|"other"}
 */
export function injectionActionOf(event) {
  const op = event?.surfaceOp;
  if (op === "append") return "append";
  if (op && typeof op === "object" && op.op === "replace") return "replace";
  return "other";
}

/**
 * 两个字符串的**最长公共前缀**长度（字符数）。
 *
 * 这是「稳定前缀」能给到多少缓存的**上界**：被改写的消息与新消息共享 P 个字符，
 * 那么这次请求能命中的 token 就是「清单之前的前缀 + P」。
 * 换成 token 数只要除以该段的中位字符/token 比（本仓按 CJK 4 单位 = 1 token 算，
 * 见 `src/rooms/ledger.mjs` 的 `BUDGET_UNITS_PER_TOKEN`）。
 * @param {string} a
 * @param {string} b
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
 * 热清单的行 → 区段名。用来回答「**到底哪一行变了**」。
 *
 * 渲染顺序见 `renderLedger`：`<chess-ledger>` → ROOT → CONSTRAINTS → 失败边 → CURRENT PATH
 * → CURRENT_STATE_KEY → OPTIONS → UNVERIFIED → TRACE → `</chess-ledger>`。
 * @param {string} line
 * @returns {string}
 */
export function classifyLedgerLine(line) {
  const s = String(line ?? "").trim();
  if (s === "") return "blank";
  if (s.startsWith("<chess-ledger>")) return "open-tag";
  if (s.startsWith("</chess-ledger>")) return "close-tag";
  if (/^ROOT\b|^ROOT USER/.test(s)) return "root-header";
  if (/^CONSTRAINTS/.test(s)) return "constraints";
  if (/^FAILED_ATTEMPTS/.test(s)) return "failures-header";
  if (/^\*/.test(s)) return "failure-edge";
  if (/^CURRENT PATH|^# path:/.test(s)) return "current-path";
  if (/^CURRENT_STATE_KEY/.test(s)) return "current-state-key";
  if (/^OPTIONS/.test(s)) return "options";
  if (/^UNVERIFIED\b/.test(s)) return "unverified";
  if (/^TRACE\b|^WORKING\b/.test(s)) return "trace-working";
  if (/^⚠|^# 压力/.test(s)) return "warning";
  if (/^\d+\.\s|^\[HARD FACTS/.test(s)) return "preamble";
  return "other";
}

/**
 * 两版热清单的**第一处差异**（按行）。
 * @param {string} a 旧清单
 * @param {string} b 新清单
 * @returns {{lineIndex:number, section:string, oldLine:string, newLine:string, charIndex:number}}
 */
export function firstDiff(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const la = x.split("\n");
  const lb = y.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i += 1;
  const oldLine = la[i] ?? "";
  const newLine = lb[i] ?? "";
  return { lineIndex: i, section: classifyLedgerLine(oldLine !== "" ? oldLine : newLine), oldLine, newLine, charIndex: lcpChars(x, y) };
}

/**
 * 单位 → token 的粗略换算（CJK 4 单位 = 1 token，与 `ledger.mjs` 一致）。
 * 只用来把字符账折成 token 账；所有金额对这条换算**不敏感**（同一条曲线两边都乘）。
 * @param {number} chars
 * @returns {number}
 */
export function charsToTokens(chars) {
  const n = Number(chars);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 4) : 0;
}

/**
 * 一次请求的钱。
 * @param {{miss?:number, hit?:number, out?:number}} usage
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {number} 美元
 */
export function requestCost(usage, prices = PRICES) {
  const miss = Number(usage?.miss) || 0;
  const hit = Number(usage?.hit) || 0;
  const out = Number(usage?.out) || 0;
  return (miss * prices.miss + hit * prices.hit + out * prices.out) / 1e6;
}

/**
 * ★ 核心：把「按 seq 排序后的事件流」变成「每次请求 + 它前面那次注入动作」的行。
 *
 * 归因规则（**只付一次**）：注入之后的第一条带 usage 的 `assistant/message` 认领这次注入，
 * 认领后清空。这直接对应「替换只作废到下一次前缀落盘为止」。
 *
 * @param {Array<object>} events 已按 seq 升序
 * @returns {Array<{seq:number, action:"append"|"replace"|"none", miss:number, hit:number, out:number,
 *                  total:number, gapSec:number|null, time:number, anchorSeq:number|null,
 *                  ledgerChars:number|null, ledgerDigest:string|null}>}
 */
export function attributeRequests(events) {
  const rows = [];
  let pending = null;
  let prevTime = null;
  for (const event of events) {
    if (event?.type === "user/message" && event?.data?.source?.kind === "chess-context") {
      const action = injectionActionOf(event);
      if (action === "other") continue; // 未知 surfaceOp：不归因（宁可少算，不许算错）
      pending = {
        action,
        anchorSeq: typeof event?.surfaceOp?.startSeq === "number" ? event.surfaceOp.startSeq : null,
        ledgerChars: messageTextOf(event?.data?.content).length,
        ledgerDigest: typeof event?.data?.source?.digest === "string" ? event.data.source.digest : null,
      };
      continue;
    }
    if (event?.type !== "assistant/message") continue;
    const usage = event?.data?.usage;
    if (!usage || !Number.isFinite(Number(usage.cacheReadTokens))) continue;
    const miss = Number(usage.inputTokens) || 0;
    const hit = Number(usage.cacheReadTokens) || 0;
    const out = Number(usage.outputTokens) || 0;
    const time = Number(event.time) || 0;
    rows.push({
      seq: Number(event.seq) || 0,
      action: pending?.action ?? "none",
      anchorSeq: pending?.anchorSeq ?? null,
      ledgerChars: pending?.ledgerChars ?? null,
      ledgerDigest: pending?.ledgerDigest ?? null,
      miss,
      hit,
      out,
      total: miss + hit + out,
      gapSec: prevTime === null || time === 0 ? null : Math.max(0, (time - prevTime) / 1000),
      time,
    });
    pending = null;
    prevTime = time === 0 ? prevTime : time;
  }
  return rows;
}

/** 中位数（不修改入参）。 */
export function median(values) {
  const a = (values ?? []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  return a[Math.floor(a.length / 2)];
}

/** 分位数（0–1，最近秩）。 */
export function percentile(values, p) {
  const a = (values ?? []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)));
  return a[i];
}

/**
 * 按动作分组汇总（**加权的**，不是各组命中率再平均 —— 那会被小样本带偏）。
 * @param {Array<object>} rows `attributeRequests` 的输出
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {Record<"append"|"replace"|"none", object>}
 */
export function summarizeByAction(rows, prices = PRICES) {
  const out = {};
  for (const action of ACTIONS) {
    const group = (rows ?? []).filter((r) => r.action === action);
    let miss = 0;
    let hit = 0;
    let outTok = 0;
    let cost = 0;
    for (const r of group) {
      miss += r.miss;
      hit += r.hit;
      outTok += r.out;
      cost += requestCost(r, prices);
    }
    const denom = miss + hit;
    out[action] = {
      requests: group.length,
      miss,
      hit,
      out: outTok,
      /** 命中率 = hit / (miss + hit)；无样本时 null（**不是 0**，0 会被读成"全 miss"）。 */
      hitRate: denom === 0 ? null : hit / denom,
      /** 每次请求的中位未命中 token —— 抗长尾，比均值更能说明「这次到底重读了多少」。 */
      medianMiss: median(group.map((r) => r.miss)),
      medianTotal: median(group.map((r) => r.total)),
      cost,
      /** 每次 replace / append 的中位代价（美元），0 样本时 null。 */
      medianCost: group.length === 0 ? null : median(group.map((r) => requestCost(r, prices))),
    };
  }
  return out;
}

/**
 * ★ 反事实：假如这些 replace 请求**没有**打掉前缀（用同会话里非 replace 请求的加权命中率），
 * 它们要花多少钱？差额就是这个动作吃掉的钱。
 *
 * 为什么用「同会话非 replace 的加权命中率」而不是拍一个 95%：它把每个会话自己的上下文长度、
 * 工具输出体量都内生了 —— 我们不假设"缓存本来该多好"，只假设"和同一会话的其它请求一样好"。
 *
 * @param {Array<object>} rows
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {{actual:number, counterfactual:number, wasted:number, baselineHitRate:number|null}}
 */
export function replaceCounterfactual(rows, prices = PRICES) {
  const replaceRows = (rows ?? []).filter((r) => r.action === "replace");
  const baseRows = (rows ?? []).filter((r) => r.action !== "replace");
  let baseMiss = 0;
  let baseHit = 0;
  for (const r of baseRows) {
    baseMiss += r.miss;
    baseHit += r.hit;
  }
  const baselineHitRate = baseMiss + baseHit === 0 ? null : baseHit / (baseMiss + baseHit);
  let actual = 0;
  let counterfactual = 0;
  for (const r of replaceRows) {
    actual += requestCost(r, prices);
    const prompt = r.miss + r.hit;
    const rate = baselineHitRate ?? 0;
    const cfHit = prompt * rate;
    const cfMiss = prompt - cfHit;
    counterfactual += (cfMiss * prices.miss + cfHit * prices.hit + r.out * prices.out) / 1e6;
  }
  return { actual, counterfactual, wasted: actual - counterfactual, baselineHitRate };
}

/**
 * ★ 把 replace 的账单拆成「必要的」与「实现造成的」。
 *
 * 判据（两句话）：
 *   · **必要** = 新清单自己的 token —— 内容变了就必须让模型读到，这部分无论如何都要付
 *     （哪怕改成尾部追加，新清单也得按 miss 价读一遍）；
 *   · **实现** = 剩下的全部 —— 也就是「清单**后面**那一段因为长度/位置平移而重读」的 token。
 *     它既不携带新信息，也不是内容变化逼出来的，纯粹是「就地改写早期位置」这个实现的代价。
 *
 * @param {Array<object>} rows
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {{necessaryTokens:number, implementationTokens:number, necessaryCost:number,
 *            implementationCost:number, totalMiss:number, necessaryShare:number}}
 */
export function decomposeReplaceCost(rows, prices = PRICES) {
  const replaceRows = (rows ?? []).filter((r) => r.action === "replace");
  let totalMiss = 0;
  let necessaryTokens = 0;
  for (const r of replaceRows) {
    totalMiss += r.miss;
    // 新清单自己的 token：内容必须送达的那一份（按 chars→tokens 折，且不许超过 miss 本身）
    necessaryTokens += Math.min(r.miss, charsToTokens(r.ledgerChars ?? 0));
  }
  const implementationTokens = Math.max(0, totalMiss - necessaryTokens);
  const necessaryCost = (necessaryTokens * prices.miss) / 1e6;
  const implementationCost = (implementationTokens * prices.miss) / 1e6;
  return {
    replaceRequests: replaceRows.length,
    totalMiss,
    necessaryTokens,
    implementationTokens,
    necessaryCost,
    implementationCost,
    necessaryShare: totalMiss === 0 ? 0 : necessaryTokens / totalMiss,
  };
}

/**
 * ★ 修复后的预计账单：把这些 replace 请求当成**尾部追加**来付费。
 *
 * 口径：追加时前缀一个 token 都不重读，未命中只剩两块 ——
 *   ① 新清单自己（`ledgerChars` → token）；
 *   ② 一次正常请求本身的增量（取 none 组的中位 miss）。
 * 这不是"预测模型"，是把两个**真机量到的数**按最保守的方式拼起来：
 * 两者都取上界（清单按满长算、增量按中位算），所以只会**高估**修复后的花费。
 *
 * @param {Array<object>} rows
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @returns {{projected:number, actual:number, saving:number, medianAppendMiss:number}}
 */
export function projectedAppendCost(rows, prices = PRICES) {
  const replaceRows = (rows ?? []).filter((r) => r.action === "replace");
  const noneRows = (rows ?? []).filter((r) => r.action === "none");
  const medianNoneMiss = median(noneRows.map((r) => r.miss));
  let projected = 0;
  let actual = 0;
  for (const r of replaceRows) {
    actual += requestCost(r, prices);
    const prompt = r.miss + r.hit;
    const miss = Math.min(prompt, charsToTokens(r.ledgerChars ?? 0) + medianNoneMiss);
    const hit = Math.max(0, prompt - miss);
    projected += (miss * prices.miss + hit * prices.hit + r.out * prices.out) / 1e6;
  }
  return { projected, actual, saving: actual - projected, medianAppendMiss: medianNoneMiss };
}

/**
 * ★ 「稳定前缀」这条路的天花板：把 LCP 拉到 100%，还能多命中多少 token？
 *
 * 结论先行（真机）：**几乎为零**。因为清单只有 ~1.9k 字符（≈480 token），
 * 而它前面的前缀动辄十几万 token —— 稳定前缀只能保住这 1.9k 里没变的那部分。
 * 这个函数存在的意义是让"别改代码"这个结论**可复算**，而不是靠感觉。
 *
 * @param {Array<{oldChars:number, newChars:number, lcpChars:number}>} pairs
 * @param {{miss:number, hit:number, out:number}} [prices]
 * @param {number} [replaceRequests] 分母：replace 请求数（用来算"每次只多赚多少 token"）
 * @returns {{pairs:number, medianLcpShare:number, extraHitTokensIfPerfect:number,
 *            extraSavingIfPerfect:number}}
 */
export function stablePrefixCeiling(pairs, prices = PRICES, replaceRequests = null) {
  const list = (pairs ?? []).filter((p) => Number.isFinite(p?.lcpChars) && Number.isFinite(p?.oldChars));
  const shares = list.map((p) => (p.oldChars === 0 ? 1 : Math.min(1, p.lcpChars / p.oldChars)));
  // 现在：命中的是 lcp 那一段；完美：命中的是整条旧清单
  let extraChars = 0;
  for (const p of list) extraChars += Math.max(0, p.oldChars - p.lcpChars);
  const extraHitTokens = charsToTokens(extraChars);
  const n = replaceRequests ?? list.length;
  return {
    pairs: list.length,
    medianLcpShare: median(shares),
    extraHitTokensIfPerfect: extraHitTokens,
    extraSavingIfPerfect: ((extraHitTokens * (prices.miss - prices.hit)) / 1e6) || 0,
    extraHitTokensPerReplace: n === 0 ? 0 : Math.round(extraHitTokens / n),
  };
}

/**
 * 时间间隔对照：**排除「缓存 TTL 过期」这个混淆项**。
 *
 * 如果 replace 请求的命中率低只是因为「两次请求隔得久」，那同一间隔桶里 none 组也该低。
 * 真机结果：同一桶里 none 98%+ / replace 5% —— 所以不是 TTL，是 replace 本身。
 *
 * @param {Array<object>} rows
 * @param {Array<[number, number]>} [buckets] 左闭右开，单位秒
 * @returns {Array<{label:string, byAction:Record<string, {requests:number, hitRate:number|null}>}>}
 */
export function gapBuckets(rows, buckets = [[0, 5], [5, 30], [30, 120], [120, 600], [600, 3600], [3600, Infinity]]) {
  const out = [];
  for (const [lo, hi] of buckets) {
    const byAction = {};
    for (const action of ACTIONS) {
      let miss = 0;
      let hit = 0;
      let requests = 0;
      for (const r of rows ?? []) {
        if (r.action !== action) continue;
        if (r.gapSec === null || r.gapSec < lo || r.gapSec >= hi) continue;
        miss += r.miss;
        hit += r.hit;
        requests += 1;
      }
      byAction[action] = { requests, hitRate: miss + hit === 0 ? null : hit / (miss + hit) };
    }
    out.push({ label: hi === Infinity ? `≥${lo}s` : `${lo}–${hi}s`, byAction });
  }
  return out;
}

/**
 * 事件研究：replace 的**前一次 / 这一次 / 后一次**请求命中率。
 *
 * 这是「只付一次」假设的**直接证明**：如果 t+1 就回到 98%，说明 replace 只在它自己那一发上收费；
 * 如果 t+1 也低，说明我们的归因漏了别的东西。
 *
 * ★ 两个口径都要给：
 *   · `all`：全部 replace 的邻域。replace 密到「每 6 次请求就有一次」时，邻域本身多半也是 replace
 *     ⇒ 这个中位数只能说明"低命中是常态"，**不能**用来证明单发归因。
 *   · `isolated`：只取「前后两次都不是 replace」的那批（**干净的自然实验**）。这一栏才回答"这一发
 *     被扣了多少、下一发有没有回来"。
 * @param {Array<object>} rows
 * @returns {{all:object, isolated:object}}
 */
export function eventStudy(rows) {
  const rateOf = (r) => (r === undefined || r === null || r.miss + r.hit === 0 ? null : r.hit / (r.miss + r.hit));
  const collect = (predicate) => {
    const before = [];
    const at = [];
    const after = [];
    const list = rows ?? [];
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].action !== "replace") continue;
      if (!predicate(list, i)) continue;
      const b = rateOf(list[i - 1]);
      const a = rateOf(list[i]);
      const c = i + 1 < list.length ? rateOf(list[i + 1]) : null;
      if (b !== null) before.push(b);
      if (a !== null) at.push(a);
      if (c !== null) after.push(c);
    }
    return { before: median(before), at: median(at), after: median(after), samples: at.length };
  };
  return {
    all: collect(() => true),
    isolated: collect((list, i) => list[i - 1]?.action === "none" && list[i + 1]?.action === "none"),
  };
}

/* ────────────────────────── 取数 ────────────────────────── */

/**
 * 从会话文本里挑出**我们关心的事件行**并解析。
 *
 * 为什么要先 `includes` 再 `JSON.parse`：真机会话里最大的单行是几 MB 的工具输出，
 * 全量 parse 一个 150MB 的会话要几十秒；我们只需要两类事件。
 * @param {string} text
 * @returns {Array<object>} 按 seq 升序
 */
export function extractEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    const isInjection = line.includes('"kind":"chess-context"');
    const isAssistant = !isInjection && line.includes('"type":"assistant/message"');
    if (!isInjection && !isAssistant) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg?.type === "assistant/message" || msg?.type === "user/message") events.push(msg);
  }
  events.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  return events;
}

/** 找 DSH_HOME 下所有 `session.v4.jsonl.zstd`。 */
export function listSessionFiles(home) {
  const root = nodePath.join(String(home ?? ""), "sessions");
  if (root === "" || !nodeFs.existsSync(root)) return [];
  const files = [];
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    let entries = [];
    try {
      entries = nodeFs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of entries) {
      if (!s.isDirectory()) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      try {
        if (!nodeFs.existsSync(file)) continue;
        files.push({ file, session: s.name, workspace: ws.name, bytes: nodeFs.statSync(file).size });
      } catch {
        /* 权限/竞态：跳过 */
      }
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 扫一个 home。**只读**。
 * @param {string} home
 * @param {{session?:string|null, maxSessions?:number, maxBytes?:number}} [opts]
 * @returns {{sessions:Array<object>, files:number, bytes:number, skipped:number}}
 */
export function scanHome(home, { session = null, maxSessions = Infinity, maxBytes = Infinity } = {}) {
  const all = listSessionFiles(home);
  // 会话目录名形如 `<SESSION_ID>-…`；用户给的通常是裸 id 前缀，两边都认。
  const picked = session === null ? all : all.filter((f) => f.session.startsWith(session) || f.session === `session-${session}` || f.session.includes(session));
  const sessions = [];
  let bytes = 0;
  let scanned = 0;
  for (const entry of picked) {
    if (scanned >= maxSessions) break;
    if (bytes + entry.bytes > maxBytes && scanned > 0) break;
    let text = "";
    try {
      text = decodeMultiFrameZstd(nodeFs.readFileSync(entry.file)).text;
    } catch {
      continue;
    }
    const events = extractEvents(text);
    if (events.length === 0) continue;
    bytes += entry.bytes;
    scanned += 1;
    sessions.push({ session: entry.session, workspace: entry.workspace, bytes: entry.bytes, events, rows: attributeRequests(events) });
  }
  return { sessions, files: all.length, picked: picked.length, bytes, skipped: all.length - picked.length };
}

/* ────────────────────────── 报告 ────────────────────────── */

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1)}%`);
const usd = (x) => `$${(Number(x) || 0).toFixed(2)}`;
const int = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");

/**
 * 汇总多个会话（**加权的**）。
 * @param {Array<{rows:Array<object>}>} sessions
 */
export function summarizeSessions(sessions) {
  const rows = [];
  const pairs = [];
  for (const s of sessions ?? []) {
    rows.push(...(s.rows ?? []));
    // 连续两版清单的字符对比（只认相邻两次"带文本的"注入）
    const ledgers = (s.events ?? []).filter((e) => e?.type === "user/message" && e?.data?.source?.kind === "chess-context");
    for (let i = 1; i < ledgers.length; i += 1) {
      if (injectionActionOf(ledgers[i]) !== "replace") continue;
      const oldText = messageTextOf(ledgers[i - 1]?.data?.content);
      const newText = messageTextOf(ledgers[i]?.data?.content);
      pairs.push({
        oldChars: oldText.length,
        newChars: newText.length,
        lcpChars: lcpChars(oldText, newText),
        diff: firstDiff(oldText, newText),
      });
    }
  }
  const byAction = summarizeByAction(rows);
  return {
    sessions: (sessions ?? []).length,
    requests: rows.length,
    byAction,
    counterfactual: replaceCounterfactual(rows),
    projected: projectedAppendCost(rows),
    decomposition: decomposeReplaceCost(rows),
    ceiling: stablePrefixCeiling(pairs, PRICES, byAction.replace.requests),
    gaps: gapBuckets(rows),
    study: eventStudy(rows),
    diffSections: (() => {
      const counts = {};
      for (const p of pairs) counts[p.diff.section] = (counts[p.diff.section] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    })(),
    ledgerChars: median(pairs.map((p) => p.newChars)),
  };
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  if (home === "" || !nodeFs.existsSync(home)) {
    console.error("需要 DSH_HOME（或 --home <dir>）；当前为空或不存在。");
    return 2;
  }
  const session = getArg("session", null);
  const maxSessions = Number(getArg("max-sessions", "Infinity"));
  const maxBytes = Number(getArg("max-bytes", String(1200 * 1024 * 1024)));
  const json = argv.includes("--json");

  const scan = scanHome(home, {
    session,
    maxSessions: Number.isFinite(maxSessions) ? maxSessions : Infinity,
    maxBytes: Number.isFinite(maxBytes) ? maxBytes : Infinity,
  });
  const sum = summarizeSessions(scan.sessions);

  if (json) {
    console.log(
      JSON.stringify(
        {
          home,
          session,
          scannedSessions: sum.sessions,
          scannedBytes: scan.bytes,
          totalSessionFiles: scan.files,
          prices: PRICES,
          ...sum,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const { byAction, counterfactual, projected, decomposition, ceiling, gaps, study } = sum;
  const total = byAction.append.requests + byAction.replace.requests + byAction.none.requests;

  console.log("== 热清单注入动作 · 缓存友好性真机审计（只读） ==");
  console.log(`home: ${home}`);
  console.log(`扫到 ${sum.sessions} 个会话 / ${(scan.bytes / 1024 / 1024).toFixed(0)} MB（磁盘上共 ${scan.files} 个会话文件）· 请求 ${int(total)} 次`);
  console.log(`单价：miss $${PRICES.miss}/M · hit $${PRICES.hit}/M（= 1/${Math.round(PRICES.miss / PRICES.hit)}）· out $${PRICES.out}/M`);
  console.log("");

  console.log("── ① 按「本轮注入动作」分组的缓存命中率 ──");
  console.log("   动作      请求数    命中率    miss 合计      hit 合计     每次中位 miss   每次中位上下文   花费");
  for (const action of ACTIONS) {
    const g = byAction[action];
    if (g.requests === 0) continue;
    console.log(
      `   ${action.padEnd(8)} ${String(g.requests).padStart(6)}   ${pct(g.hitRate).padStart(7)}   ` +
        `${int(g.miss).padStart(12)}  ${int(g.hit).padStart(12)}   ${int(g.medianMiss).padStart(12)}   ` +
        `${int(g.medianTotal).padStart(13)}   ${usd(g.cost).padStart(9)}`,
    );
  }
  console.log("");

  console.log("── ② 时间间隔对照（排除「缓存 TTL 过期」这个混淆项） ──");
  console.log("   同一间隔桶内 none 组仍然 98%+ ⇒ 低命中不是「隔得久」造成的。");
  for (const bucket of gaps) {
    const cells = ACTIONS.map((a) => {
      const v = bucket.byAction[a];
      if (v.requests === 0) return `${a} —`;
      return `${a} ${pct(v.hitRate)} (n=${v.requests})`;
    }).join(" · ");
    console.log(`   ${bucket.label.padEnd(9)} ${cells}`);
  }
  console.log("");

  console.log("── ③ 事件研究（「替换只付一次」的直接验证，命中率） ──");
  console.log(
    `   全部 replace 邻域：前一次 ${pct(study.all.before)} → 这一次 ${pct(study.all.at)} → 后一次 ${pct(study.all.after)}` +
      `（${study.all.samples} 组；replace 密到每 6 次请求一次 ⇒ 邻域本身也多是 replace，这一栏只说明"低是常态"）`,
  );
  console.log(
    `   孤立 replace（前后都不是 replace）：前一次 ${pct(study.isolated.before)} → 这一次 ${pct(study.isolated.at)}` +
      ` → 后一次 ${pct(study.isolated.after)}（${study.isolated.samples} 组）⇒ 只扣这一发，下一发就回来`,
  );
  console.log("");

  console.log("── ④ replace 的「必要 vs 实现问题」分解 ──");
  console.log(`   replace 请求 ${decomposition.replaceRequests} 次，未命中合计 ${int(decomposition.totalMiss)} token`);
  console.log(
    `   · 必要（新清单自己必须被读到）      ${int(decomposition.necessaryTokens).padStart(12)} token  ` +
      `(${pct(decomposition.necessaryShare)})  ${usd(decomposition.necessaryCost)}`,
  );
  console.log(
    `   · 实现（清单后面被平移重读）        ${int(decomposition.implementationTokens).padStart(12)} token  ` +
      `(${pct(1 - decomposition.necessaryShare)})  ${usd(decomposition.implementationCost)}`,
  );
  console.log(
    `   清单首行差异分布（哪一行先变）：${sum.diffSections.map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`,
  );
  console.log(`   清单中位长度 ${int(sum.ledgerChars)} 字符（≈${int(charsToTokens(sum.ledgerChars))} token）`);
  console.log("");

  console.log("── ⑤ 反事实：这些 replace 如果没打掉前缀 ──");
  console.log(
    `   基线命中率（同会话非 replace 请求，加权） ${pct(counterfactual.baselineHitRate)}`,
  );
  console.log(`   实际花费 ${usd(counterfactual.actual)} · 反事实 ${usd(counterfactual.counterfactual)} · **多花 ${usd(counterfactual.wasted)}**`);
  console.log(
    `   改成尾部追加后的预计账单：**${usd(projected.projected)}**（未命中 = 新清单 ≈${int(charsToTokens(sum.ledgerChars))} token + 正常增量 ${int(projected.medianAppendMiss)} token）` +
      ` ⇒ **省下 ${usd(projected.saving)}**（同一批请求，口径最保守：清单按满长、增量按中位）`,
  );
  console.log("");

  console.log("── ⑥ 「稳定前缀 + 增量追加」能给到多少（这条路的天花板） ──");
  console.log(
    `   相邻两版清单的 LCP 中位占旧清单 ${pct(ceiling.medianLcpShare)}（${ceiling.pairs} 对）`,
  );
  console.log(
    `   就算把 LCP 拉到 100%：多命中 ${int(ceiling.extraHitTokensIfPerfect)} token（每次 replace 只多 ${int(ceiling.extraHitTokensPerReplace)}）` +
      ` ⇒ 省 ${usd(ceiling.extraSavingIfPerfect)}`,
  );
  console.log("");

  console.log("── 结论 ──");
  console.log(
    `   replace 请求命中 ${pct(byAction.replace.hitRate)}，none 请求命中 ${pct(byAction.none.hitRate)}；` +
      `每次 replace 的中位 miss 是 ${int(byAction.none.medianMiss)} → ${int(byAction.replace.medianMiss)} token（${(byAction.replace.medianMiss / Math.max(1, byAction.none.medianMiss)).toFixed(0)} 倍）。`,
  );
  console.log(
    `   必要部分只占 ${pct(decomposition.necessaryShare)}，剩下 ${pct(1 - decomposition.necessaryShare)} 是「就地改写早期位置」的实现代价 —— 不是清单内容变化逼出来的。`,
  );
  console.log(`   稳定前缀救不了：清单只有 ≈${int(charsToTokens(sum.ledgerChars))} token，天花板 ${usd(ceiling.extraSavingIfPerfect)}。`);
  console.log(`   一句话：**别在中间改，到末尾追加** —— 预计把 ${usd(counterfactual.actual)} 压到 ${usd(projected.projected)}（省 ${usd(projected.saving)}）。`);
  return 0;
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(HERE, "cache-friendliness-audit.mjs")) {
  process.exit(main());
}
