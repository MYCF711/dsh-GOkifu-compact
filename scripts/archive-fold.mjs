/**
 * archive-fold.mjs —— **离线**给归档会话补一次摘要（C490）
 *
 * 由来（用户原话）：「需要的不是会话自己去压，而是归档的日志需要去调用**默认模型**压缩一次，
 * 这样就不用依赖对话模型」。
 *
 * 现在的收尾折叠挂在这条链上：归档事件 → `compactIfNeeded(agent)` → 要活着的 surface + 对话模型。
 * 归档后 session 已被摘除 ⇒ `no-foldable-span` ⇒ 尾巴永远压不了（真机 2026-11-03 验证）。
 *
 * 这个脚本绕开那条链：**直接读会话日志**（多帧 zstd，我们本来就会解），把尾部按预算拼成输入，
 * 用**独立的默认模型**跑一次摘要，结果写进我们自己的棋谱（foldMark + closeout）。
 *
 * 三条边界先说清楚（避免误解做了什么）：
 *   ① 我们**不动宿主的压缩历史** —— 宿主的 `session.v4.jsonl.zstd` 原样保留；
 *   ② 这里产出的是**我们账本上的一次折叠**：尾巴不再算欠账，摘要留在 `lastOfflineSummary`；
 *   ③ 重开会话时要不要把它注入回去，是下一步的事（本脚本只负责"压出来 + 记账"）。
 *
 * 用法：
 *   node scripts/archive-fold.mjs --session aa52f421            # 干跑：只打印将要发的输入
 *   node scripts/archive-fold.mjs --session aa52f421 --write    # 真调模型并写回棋谱
 *   node scripts/archive-fold.mjs --due --limit 2 --write       # 只补最旧的 2 个欠账
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "./session-scan.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { applyOfflineFoldToGraph, foldBudgetFor } from "../src/rooms/offline-fold.mjs";
import { COLD_INPUT_PER_MTOK, OUTPUT_PER_MTOK, PEAK_MULTIPLIER, SUMMARY_OUTPUT_TOKENS } from "./backfill-plan.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";

// ★ C490：默认用 `deepseek-flash`，**不用** `group/...`。
//   真机实测（2026-11-03）：`group/deepseek-v4.1-flash1017` 被路由到 wps-lingxi 上游，
//   那个上游**忽略 `thinking:{type:"disabled"}`** —— reasoning 会把 max_tokens 吃光、`content` 回 null；
//   `deepseek-flash` 走 trustoken，实测 reasoning_tokens=0，开关生效。
export const DEFAULT_MODELS = Object.freeze(["deepseek-flash"]);
export const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";

/**
 * ★ C494：**用 DSH 的默认模型**，不是脚本自己挑一个。
 *
 * 由来（用户原话）：「压缩能调用 DSH 的默认模型就应该调用啊，为什么用离线压缩」——
 * 说得对：模型不该由我们用脚本另选。DSH 的默认模型写在 profile 的
 * `cordis.patch.yml` 里（条目 `agent-default-model`），我们照它来。
 *
 * 注意区分两件事，别混：
 *   · **模型**：这里解决 —— 读 profile 配置，拿 `agent-default-model.model`；
 *   · **可折区间**：离线要读日志才有 —— 归档后宿主的 session surface 已经没了，
 *     `compactIfNeeded` 拿不到区间（`no-foldable-span`），这跟用哪个模型无关。
 *
 * @param {string} home DSH_HOME
 * @returns {{provider:string|null, model:string|null, source:string}}
 */
// ★ C495：纯逻辑已搬进 src/rooms/offline-fold.mjs（脚本与引擎共用同一份）
import {
  readDefaultModel,
  collectMessages,
  coverageOf,
  repairMissingConstraints,
  renderFacts,
  buildOfflinePrompt,
  allConstraints,
  plainText,
} from "../src/rooms/offline-fold.mjs";

// 兼容导出：这些实现已经搬进 src/rooms/offline-fold.mjs，脚本这边只做转发
export { readDefaultModel, collectMessages, coverageOf, repairMissingConstraints, renderFacts, buildOfflinePrompt, allConstraints };

/* ────────────────────────── 主流程 ────────────────────────── */


/** 读会话日志 → 事件数组（坏行跳过）。 */
export function readSessionEvents(logFile) {
  let text;
  try {
    text = decodeMultiFrameZstd(fs.readFileSync(logFile)).text;
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function findLogFile(home, sessionDirName) {
  const root = path.join(home, "sessions");
  let found = null;
  const walk = (dir) => {
    if (found !== null) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd") && p.includes(sessionDirName)) found = p;
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return found;
}

async function callModel({ baseUrl, apiKey, model, prompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }) },
      // ★ 思考模式**默认开着**（官方《Thinking Mode》），而且 reasoning 也吃 max_tokens ——
      //   真机实测：max_tokens=16 全被 reasoning 吃掉，`content` 直接是 null。
      //   摘要这种"照事实改写"的活不需要思考，显式关掉，既省钱又不至于返回空。
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        // ★ C574：**给补账一个独立的 user_id**。官方《限速与隔离》逐字：
        //   「user_id 用于我们对您业务侧用户进行 KVCache 隔离，以进行隐私管理」。
        //   补账的输入是几万字符的长前缀（每段都不同），和交互会话共用 user_id 会**抢同一片缓存**；
        //   交互会话的前缀一旦被挤掉，下一次请求就要按全价重算 —— 那正是"折叠完反而更贵"的一种来源。
        //   补账是后台批处理，本来就该跟交互流量分开记账、分开占缓存。
        user_id: "gokifu-backfill",
        // ★ C578：**`reasoning_effort` 的档位不是"强度大小"，`none` 才是关闭开关**。
        //   官方 API 参考逐字：「none 关闭思考模式；low / high / max 开启思考模式」。
        //   所以 C576 里传 `low` 其实还是**开着**思考（只是低强度）。要省 reasoning 必须传 `none`。
        reasoning_effort: "none",
        stream: false,
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (res.ok === false) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const text = json?.choices?.[0]?.message?.content ?? "";
    // ★ C490：空文本必须能自证 —— 打印 finish_reason 与 usage，否则只看到"返回空"没法排查
    return {
      text: String(text),
      usage: json?.usage ?? null,
      model: json?.model ?? model,
      finish: json?.choices?.[0]?.finish_reason ?? null,
      reasoningChars: String(json?.choices?.[0]?.message?.reasoning_content ?? "").length,
      raw: text === "" || text === null ? JSON.stringify(json).slice(0, 300) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const home = env.DSH_HOME ?? "";
  if (home === "") {
    console.error("缺 DSH_HOME");
    return 2;
  }
  const write = argv.includes("--write");
  // ★ C494：默认跟 DSH 走（`agent-default-model`），脚本不再自选模型
  const dshDefault = readDefaultModel(home);
  const model = get("model", env.ARCHIVE_FOLD_MODEL ?? dshDefault.model ?? DEFAULT_MODELS[0]);
  console.log(`  模型来源：${env.ARCHIVE_FOLD_MODEL ? "环境变量 ARCHIVE_FOLD_MODEL" : dshDefault.model ? dshDefault.source : "内置兜底"}（${model}）`);
  const baseUrl = get("base", env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL);
  const apiKey = env.MAGPIE_API_KEY ?? "";
  const maxChars = Number(get("max-chars", 60_000));
  const limit = Number(get("limit", 1));
  const sessionsRoot = path.join(home, "chess-context", "sessions");

  // 选目标：--session 或 --due
  const targets = [];
  if (get("session", "") !== "") {
    const want = String(get("session", ""));
    const dir = fs.readdirSync(sessionsRoot).find((x) => x.includes(want));
    if (dir === undefined) {
      console.error(`找不到会话 ${want}`);
      return 2;
    }
    targets.push(dir);
  } else if (argv.includes("--due")) {
    // ★ C491：按尾巴**从大到小**（与 backfill-plan 的建议一致：先补欠得最多的），
    //   而不是读目录顺序 —— 那个顺序既不稳定也不公平。
    const due = [];
    for (const dir of fs.readdirSync(sessionsRoot)) {
      const file = path.join(sessionsRoot, dir, "graph.json");
      if (!fs.existsSync(file)) continue;
      try {
        const g = loadSessionGraph(file).graph;
        const d = debtOfGraph(g);
        if (d.due) due.push({ dir, tail: d.tail });
      } catch {
        /* 坏图跳过 */
      }
    }
    due.sort((a, b) => b.tail - a.tail);
    for (const x of due) targets.push(x.dir);
  }
  if (targets.length === 0) {
    console.log("没有目标（用 --session <id前缀> 或 --due）");
    return 1;
  }

  for (const dir of targets.slice(0, limit)) {
    const graphFile = path.join(sessionsRoot, dir, "graph.json");
    const { graph } = loadSessionGraph(graphFile);
    const debt = debtOfGraph(graph);
    const logFile = findLogFile(home, dir);
    // ★ C523：**活着的会话不要用脚本写**。真机教训（8cc34e32）：脚本写完，宿主那边把内存里的图
    //   一 flush 就覆盖回去了 —— 钱花了、什么都没留下。判据看日志 mtime：5 分钟内有写入就算活着。
    if (write && logFile !== null && logFile !== undefined) {
      try {
        const ageMin = (Date.now() - fs.statSync(logFile).mtimeMs) / 60_000;
        if (ageMin < 5 && !argv.includes("--force-live")) {
          console.log(`  ! ${dir.slice(0, 16)} 仍在跑（日志 ${ageMin.toFixed(1)} 分钟前还在写）—— 脚本写回会被宿主覆盖，跳过；确实要写加 --force-live`);
          continue;
        }
      } catch {
        /* stat 失败就不拦 */
      }
    }
    if (logFile === null) {
      console.log(`  ✗ ${dir.slice(0, 16)} 找不到会话日志，跳过`);
      continue;
    }
    const events = readSessionEvents(logFile);
    // ★ C522：**有前段缺口就从缺口开始**（C519 把缺口计成欠账，脚本这边也要认，否则永远"没有欠账区间"）
    const rangeStart0 = debt.gap !== undefined && debt.gap !== null ? Number(debt.gap.from) : debt.lastFoldSeq === null ? 1 : debt.lastFoldSeq + 1;
    const rangeEnd = debt.maxSeq;
    // ★ C493：`--chunks N` 分段覆盖（**从头往后**），默认 1 段 = 只压尾部（与 C491 行为一致）
    const maxChunks = Math.max(1, Number(get("chunks", 1)) || 1);
    console.log(`== ${dir.slice(0, 16)} ==`);
    let cursor = rangeStart0;
    for (let chunkNo = 1; chunkNo <= maxChunks; chunkNo += 1) {
    const rangeStart = cursor;
    if (rangeEnd < rangeStart) break;
    // ★ C522：补缺口时必须**从头取**（否则 1 段模式永远只压尾巴）
    // ★ C532：一次都没折过的会话从**头部**开始（否则第一段从中间折，前段永远补不上）
    const fromHead = (debt.gap !== undefined && debt.gap !== null) || (Array.isArray(graph.foldMarks) ? graph.foldMarks.length : 0) === 0;
    // ★ C538：**把棋谱节点 id 带进消息**（引擎那条路已经这么做了，脚本这里漏了 ——
    //   于是脚本产出的摘要状态节点全是 `n?`，引用回溯不了）。
    const idBySeq = (() => {
      const map = new Map();
      for (const node of Object.values(graph?.nodes ?? {})) {
        const seq = Number(node?.seq);
        if (!Number.isFinite(seq) || typeof node?.id !== "string" || node.id === "" || map.has(seq)) continue;
        map.set(seq, node.id);
      }
      return map;
    })();
    const { messages, chars, dropped } = collectMessages(events, { maxChars, fromSeq: maxChunks > 1 || fromHead ? rangeStart : null, idBySeq });
    // ★ C491：**记录真正覆盖的区间**。预算只装得下尾部若干条消息，
    //   若把 `seqEnd` 写成整个欠账区间的末尾，等于宣称"这段都压过了" —— 剩下的就再也看不见了。
    // ★ C491：**没有可做区间就别写**。真机踩过：`--session` 强制重跑一个已结清的会话，
    //   rangeStart 会超过 rangeEnd，写出一条 `seqStart > seqEnd` 的反向 foldMark。
    if (rangeEnd < rangeStart) {
      console.log(`  没有欠账区间（${rangeStart}-${rangeEnd}），跳过`);
      continue;
    }
    const seqs = messages.map((m) => m.seq);
    const cov = coverageOf({ rangeStart, rangeEnd, seqs });
    // ★ C493：分段模式下"这一段"就是从 rangeStart 起的连续段 —— 第一帧可能比它晚 3 个 seq
    //   （中间是工具结果），不该因此报"前段未覆盖"。
    const start = maxChunks > 1 ? rangeStart : cov.start;
    const end = cov.end;
    const facts = renderFacts(graph, { start, end });
    const prompt = buildOfflinePrompt({ facts, messages, range: { start, end } });
    const uncoveredHead = Math.max(0, start - rangeStart);
    const uncoveredTail = Math.max(0, rangeEnd - end);
    console.log(
      `  段 ${start}-${end}（欠账区间 ${rangeStart}-${rangeEnd}` +
        `${uncoveredHead > 0 ? `，**前段 ${rangeStart}-${start - 1} 未覆盖（${uncoveredHead} 事件）**` : ""}` +
        `${uncoveredTail > 0 ? `，尾部还剩 ${uncoveredTail} 事件未覆盖` : ""}）` +
        ` · 消息 ${messages.length} 条（${chars} 字符${dropped > 0 ? `，更早的 ${dropped} 条未放` : ""}）`,
    );
    // ★ C580：**单价与补账计划同源**。这里原来写死 `0.028 / 0.28`（美元/百万 token），
    //   而官方（2026-11-06 核实）低谷是 **¥1 输入未命中 / ¥4 输出** ≈ $0.14 / $0.56 —— **低了 5 倍**，
    //   于是所有"这次大约多少钱"都被系统性低估。改成 import 计划脚本的常量（唯一口径）。
    const priceIn = Number(get("price-in", COLD_INPUT_PER_MTOK));
    const priceOut = Number(get("price-out", OUTPUT_PER_MTOK));
    const estInTok = Math.round(prompt.length * 0.3); // 粗估：以 ASCII 为主
    const estOutTok = Number(get("est-out", SUMMARY_OUTPUT_TOKENS));
    const estCost = (estInTok / 1e6) * priceIn + (estOutTok / 1e6) * priceOut;
    console.log(
      `  输入合计 ${prompt.length} 字符（≈${estInTok} tok）· 估价 ≈ $${estCost.toFixed(4)}（低谷）` +
        ` / $${(estCost * PEAK_MULTIPLIER).toFixed(4)}（高峰）· 模型 ${model}`,
    );
    if (!write) {
      console.log("  （干跑：加 --write 才会真的调用模型并写回）");
      // ★ C493：干跑也要推进游标，否则分段模式会把同一段打印 N 遍
      cursor = end + 1;
      if (end >= rangeEnd) break;
      continue;
    }
    const startedAt = Date.now();
    let result;
    try {
      // ★ C560：**预算与引擎同一算法**（按输入自适应），不再固定 8192
      const maxTokensArg = foldBudgetFor(prompt.length, Number(get("max-tokens", 8192)));
      result = await callModelSafe({ baseUrl, apiKey, model, prompt, maxTokens: maxTokensArg, timeoutMs: Number(get("timeout", 180_000)) });
      // ★ C494：有些上游**忽略** `thinking:{type:"disabled"}`（真机：wps-lingxi 那路），
      //   reasoning 会把 max_tokens 吃光、`content` 回 null。这里自动**放大预算重试一次**。
      if ((result.text ?? "") === "" && result.finish === "length") {
        const bigger = maxTokensArg * 4;
        console.log(`  ↻ 被推理吃光（finish=length），放大到 ${bigger} 重试一次`);
        result = await callModelSafe({ baseUrl, apiKey, model, prompt, maxTokens: bigger, timeoutMs: Number(get("timeout", 180_000)) });
      } else if (result.finish === "length" && Number(result.usage?.reasoning_tokens ?? 0) > 0) {
        // ★ C576：**推理吃掉了大半预算，正文被截断**。真机（2026-11-06 fdd814b1）：
        //   `completion 8192 = reasoning 5372 + 正文 ~2820` —— 摘要正好撞顶被切，
        //   而"文本非空"让旧逻辑以为成功了。有 reasoning 时按它的实测值补足预算重试。
        const need = Math.min(32_768, maxTokensArg + Math.ceil(Number(result.usage.reasoning_tokens) * 1.2));
        console.log(`  ↻ 正文被推理挤掉（reasoning ${result.usage.reasoning_tokens}），放大到 ${need} 重试一次`);
        result = await callModelSafe({ baseUrl, apiKey, model, prompt, maxTokens: need, timeoutMs: Number(get("timeout", 180_000)) });
      }
    } catch (error) {
      console.log(`  ✗ 模型调用失败：${String(error?.message ?? error).slice(0, 200)}`);
      continue;
    }
    const ms = Date.now() - startedAt;
    let text = result.text.trim();
    if (text === "") {
      console.log(
        `  ✗ 模型返回空文本（finish=${result.finish ?? "?"} · reasoning=${result.reasoningChars ?? 0} 字符 · usage=${JSON.stringify(result.usage)}）`,
      );
      if (result.raw !== null) console.log(`    原始响应：${result.raw}`);
      continue;
    }
    // ★ C492：先把质量算一遍，缺的约束**逐字补回**（约束丢了比多几行更糟）
    const preQuality = measureFoldQuality({ graph, range: { start, end }, summaryText: text });
    // ★ C493：`quality.missingConstraints` 只给前 5 条（防止报告过长）——补回时要用**全量**，
    //   否则第 6 条照样丢（真机 cr=0.833 就是这么来的）。
    const allConstraints = [...new Set(Object.values(graph?.nodes ?? {}).flatMap((n) => (Array.isArray(n?.constraints) ? n.constraints : [])))];
    const stillMissing = allConstraints.filter((c) => !text.includes(c));
    let repaired = 0;
    if (stillMissing.length > 0) {
      const fixed = repairMissingConstraints(text, stillMissing);
      text = fixed.text;
      repaired = fixed.repaired;
      console.log(`  ⚠ 模型漏了 ${repaired} 条约束，已逐字补回`);
    }

    // ★ C523：**写回走共享实现**（引擎与脚本必须记同一套字段）。
    //   之前脚本自己写 `offlineUncoveredHead:{start,end,events}`，而 `debtOfGraph` 读的是 `from`
    //   ⇒ 缺口游标永远回到 1，补缺口原地打转。
    // ★ C539：事实块里的 id（死路/已验证边）跨整个会话，越界探针要放行
    const factsIds = (() => {
      const ids = new Set();
      for (const edge of Object.values(graph?.edges ?? {})) {
        if (edge?.result === "failure" || edge?.result === "success") ids.add(String(edge.id));
      }
      return ids;
    })();
    const quality = measureFoldQuality({ graph, range: { start, end }, summaryText: text, allowedIds: factsIds });
    const applied = applyOfflineFoldToGraph(
      graph,
      {
        chunks: [{ start, end, text, quality, repaired, model: result.model, ms, usage: result.usage }],
        coveredStart: start,
        coveredEnd: end,
        uncoveredHead,
        uncoveredTail,
      },
      { rangeStart, rangeEnd, previousGapEvents: debt.gap !== undefined && debt.gap !== null ? Number(debt.gap.events) : undefined, provider: "magpie", model: result.model },
    );
    void applied;
    fs.writeFileSync(graphFile, JSON.stringify(graph, null, 1), "utf8");
    console.log(`  ✓ [${chunkNo}/${maxChunks}] 已写回：段 ${start}-${end} · 摘要 ${text.length} 字符 · ${ms}ms · usage=${JSON.stringify(result.usage)}`);
    // 下一段从这段的末尾继续（分段模式）；单段模式到此为止
    cursor = end + 1;
    if (end >= rangeEnd) break;
    }
  }
  return 0;
}

/** fetch 在部分 Node 上是全局的；这里包一层，失败时给出可读错误。 */
async function callModelSafe(args) {
  return callModel(args);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = main();
  if (code instanceof Promise) code.then((c) => (process.exitCode = c));
  else process.exitCode = code;
}
