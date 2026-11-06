#!/usr/bin/env node
/**
 * summary-persistence-audit.mjs —— **「折叠摘要正文到底存在哪」的只读统计 + 落盘成本**（C642）
 *
 * 由来（Lead 实测 2026-11-05 05:5x）：`node scripts/structure-audit.mjs` 的输出里有一句
 * 一直没人管 ——
 *
 *     候选 383 条（可复判 144 · 正文未落盘 239 · 扫了 541 个会话）
 *
 * 那 239 条**折叠的质量无法复判**：`lastOfflineSummary` 只保留**最后一次**折叠的正文，更早的
 * `foldMark` 只有 `summaryChars`（字数），没有正文。于是 `structure-audit` / `fold-loss-audit` /
 * `repair-coverage-audit` 三个审计器都有同一个缺口 —— 想判「模型到底写没写那一段」时只能说
 * 「不可复判，我不猜」。
 *
 * 这个脚本把「要修多大」先量出来（**先量，再改**），并且**只读**：
 *   ① 全库 foldMark 里，有正文 / 只有字数 / 两者都没有，各多少条；
 *   ② 落盘一份摘要正文要多少字节（p50 / p90 / max，**JSON 内实际占用**，不是字符数）；
 *   ③ 全库都落盘会多占多少磁盘（按 foldMark 数 × 摘要大小估），以及占 `graph.json` 总量的百分比；
 *   ④ A（全文）/ B（前 N + 后 M）/ C（哈希 + 前 200 字符）三种方案的**逐条实测成本**；
 *   ⑤ 每种方案**能回答哪些问题**（能力表，见 `CAPABILITIES`）。
 *
 * 为什么成本要用「JSON 内实际占用」而不是 `text.length`：中文在 `JSON.stringify` 里原样走 UTF-8
 * （3 字节/字），换行会变成 `\n`（2 字节），引号变成 `\"`。按字符数估会**系统性低估**，
 * 而这一轮要拍的板正是磁盘成本 —— 估错的成本表等于没有。
 *
 * 正文从哪来（只读、按可靠度降序，与三个审计器**同源**）：
 *   · `foldMark.summaryText` —— C642 起，除最后一段外，每段折痕各存一份（**不写第二遍**）；
 *   · `graph.lastOfflineSummary.text` —— 只有**区间对得上**的那一次 fold 才用（最后一段走引用，不复制副本）。
 *
 * 用法：
 *   node scripts/summary-persistence-audit.mjs                   # 默认 DSH_HOME
 *   node scripts/summary-persistence-audit.mjs --home <workspace>   # 换 home
 *   node scripts/summary-persistence-audit.mjs --json             # 机读
 *
 * 退出码：0 = 统计跑完（无论数字多少）；1 = 一张图都读不到（home 指错了）。
 * 边界：**只读**。不写盘、不改图、不调模型、不 commit、不重启。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
void HERE;

/**
 * 从这一代起，`applyOfflineFoldToGraph` 会给每条折痕留下**可复判**的正文
 * （非最后一段落 `summaryText`，最后一段落 `summaryTextRef` 引用 `lastOfflineSummary`）。
 *
 * 三个审计器的「不可复判」一律用这个世代号解释：**缺正文 = 生产者比它老**，
 * 不是「正文丢了」—— 两者修法完全不同（等新折痕 vs 查写回点）。
 */
export const SUMMARY_TEXT_SINCE = "C642";

/** 三种方案（成本用真实样本文本逐条算，不写死）。 */
export const SCHEMES = Object.freeze({
  A: { key: "A", name: "全文", head: null, tail: null, hash: false },
  B: { key: "B", name: "前 2000 + 后 800", head: 2000, tail: 800, hash: false },
  C: { key: "C", name: "哈希 + 前 200 字符", head: 200, tail: 0, hash: true },
});

/**
 * 每种方案**能回答哪些问题**（报告要拍的板就是这张表；`✓` 全量 / `△` 部分 / `✗` 不能）。
 *
 * 判据不是拍脑袋：三个审计器真正要调的是
 * `sectionNames/describeStructure`（段名）、`mentionsEdge`（逐字 id）、`repairMissingFailures`
 * + `measureFoldQuality`（重放）。段名与 id 可能出现在**任意位置**，所以「掐头去尾」的 B
 * 在这两项上必然只能给部分答案；而重放要求**逐字**，任何截断都让结论失效。
 */
export const CAPABILITIES = Object.freeze([
  { question: "段名复判（sectionsMissing 到底是判据错还是真漏段）", A: "✓", B: "△ 只在头/尾的段", C: "✗" },
  { question: "失败边逐条 id 提及（mentionsEdge，`e46` 有没有写出来）", A: "✓", B: "△ 中间段丢失", C: "✗" },
  { question: "动作 / 错误短语命中（`file_path=…` / `cannot modify`）", A: "✓", B: "△", C: "✗" },
  { question: "区间记法识别（`e693—e698` 把逐条 id 吞掉）", A: "✓", B: "△", C: "✗" },
  { question: "补回重放（repairMissingFailures ⇒ failureRecall 是不是 1）", A: "✓ 逐字可重放", B: "✗ 截断后重放无效", C: "✗" },
  { question: "摘要质量重算（summaryTokens / compressionRatio）", A: "✓", B: "✗ 分母失真", C: "✗" },
  { question: "截断判定（endedCleanly / 引号配平）", A: "✓", B: "✓ 尾部 800 字够", C: "✗" },
  { question: "「是不是同一份摘要」（去重 / 指纹）", A: "✓", B: "△ 头尾相同才算同", C: "✓ 哈希", },
  { question: "磁盘成本", A: "高（全文 × 折痕数）", B: "中（≈2.8k 字/条封顶）", C: "低（≈216 字/条）" },
]);

/** 与 doctor / graph-audit / 其余审计器同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? nodeOs.homedir(), ".dsh");
}

/**
 * ★ **唯一的正文读取器**（生产写回点 + 三个审计器 + 本脚本共用这一份口径）。
 *
 * 为什么必须共享：`summaryText` / `summaryTextRef` / `lastOfflineSummary` 三者的优先关系一旦在
 * 四个地方各写一遍，就会像 C587 那样「写侧改了字段名、读侧还是老名字」—— 记录全成 null 还没人发现。
 *
 * 取值顺序（可靠度降序）：
 *   ① `mark.summaryText` 非空字符串 ⇒ 这条折痕自己存了正文（C642 起，非最后一段）；
 *   ② `graph.lastOfflineSummary.range` **与这条 mark 的 seqStart/seqEnd 全等** ⇒ 用那一份
 *      （最后一段走引用，`summaryTextRef` 只说明书写意图，判据仍是区间全等）；
 *   ③ 否则 ⇒ 没有正文。**宁可说不知道，也不许拿别的段冒充**（那会把审计变成编造）。
 *
 * @param {any} graph 棋谱
 * @param {any} mark foldMark
 * @returns {{text:string|null, source:"mark"|"lastOfflineSummary"|null, why:string}}
 */
export function summaryTextFor(graph, mark) {
  const own = mark?.summaryText;
  if (typeof own === "string" && own !== "") {
    return { text: own, source: "mark", why: `summaryText（${own.length} 字符，落在本条折痕上）` };
  }
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") {
    return { text: null, source: null, why: `没有 summaryText，也没有 lastOfflineSummary（生产者早于 ${SUMMARY_TEXT_SINCE}）` };
  }
  const same = Number(last?.range?.start) === Number(mark?.seqStart) && Number(last?.range?.end) === Number(mark?.seqEnd);
  if (!same) {
    return {
      text: null,
      source: null,
      why:
        `lastOfflineSummary 是另一段（${last?.range?.start}-${last?.range?.end}），` +
        `本条只有 summaryChars=${mark?.summaryChars ?? "?"}（生产者早于 ${SUMMARY_TEXT_SINCE}）`,
    };
  }
  return {
    text: last.text,
    source: "lastOfflineSummary",
    why: `lastOfflineSummary.range=${last.range.start}-${last.range.end}（引用，不复制副本）`,
  };
}

/** 这段正文**躺进 graph.json 要占多少字节**（含 JSON 转义；中文按 UTF-8 3 字节/字）。 */
export function jsonBytes(text) {
  const raw = String(text ?? "");
  if (raw === "") return 0;
  return Math.max(0, Buffer.byteLength(JSON.stringify(raw), "utf8") - 2);
}

/** 方案 C 的指纹（前 16 位十六进制 = 64 bit，判「是不是同一份」够用）。 */
export function fingerprint(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

/**
 * 一段正文按某个方案**实际落盘**后会变成什么（成本表就是逐条算它）。
 *
 * 省略标记本身也算字节 —— 否则 B 方案的成本会被系统性低估（每条少算十几个字符）。
 *
 * @param {string} text 摘要原文
 * @param {"A"|"B"|"C"} key 方案
 * @returns {string}
 */
export function storeAs(text, key) {
  const scheme = SCHEMES[key];
  if (scheme === undefined) throw new Error(`未知方案：${key}`);
  const body = String(text ?? "");
  if (scheme.hash) return `sha256:${fingerprint(body)} · ${body.slice(0, scheme.head)}`;
  if (scheme.head === null) return body;
  if (body.length <= scheme.head) return body;
  const head = body.slice(0, scheme.head);
  const tail = scheme.tail > 0 ? body.slice(-scheme.tail) : "";
  const omitted = body.length - head.length - tail.length;
  return tail === "" ? `${head}⋯〔省略 ${omitted} 字〕` : `${head}\n⋯〔省略 ${omitted} 字〕\n${tail}`;
}

/** 百分位（nearest-rank；样本空时返回 null，绝不返回 0 冒充「很小」）。 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[at];
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * 扫全部会话，统计「摘要正文的落盘现状 + 三种方案的成本」。
 *
 * 成本口径：**样本内逐条实测**（真实摘要按方案截断后算 JSON 字节）；
 * 样本外的 mark（老 producer 没正文）用**均值外推** —— 报告里两个数都给，且写明是外推。
 *
 * @param {{home?:string, sessionsDir?:string}} [options]
 * @returns {object}
 */
export function collectSummaryStats({ home = resolveHome(), sessionsDir = null } = {}) {
  const dir = sessionsDir ?? nodePath.join(home, "chess-context", "sessions");
  const names = nodeFs.existsSync(dir) ? nodeFs.readdirSync(dir).sort() : [];
  const bad = [];
  const byTrigger = {};
  const sampleBytes = [];
  const sampleChars = [];
  const perSchemeBytes = Object.fromEntries(Object.keys(SCHEMES).map((k) => [k, []]));
  let sessions = 0;
  let sessionsWithMarks = 0;
  let marks = 0;
  let marksWithQuality = 0;
  let withMarkText = 0;
  let withRefText = 0;
  let charsOnly = 0;
  let neither = 0;
  let graphBytes = 0;

  for (const name of names) {
    const file = nodePath.join(dir, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    sessions += 1;
    try {
      graphBytes += nodeFs.statSync(file).size;
    } catch {
      /* 读不到大小不影响统计口径 */
    }
    let graph = null;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch (error) {
      bad.push({ session: name, error: String(error?.message ?? error).slice(0, 160) });
      continue;
    }
    const list = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    if (list.length > 0) sessionsWithMarks += 1;
    for (const mark of list) {
      marks += 1;
      const trigger = String(mark?.trigger ?? "null");
      byTrigger[trigger] = byTrigger[trigger] ?? { marks: 0, text: 0, charsOnly: 0, neither: 0 };
      const bucket = byTrigger[trigger];
      bucket.marks += 1;
      const quality = mark?.quality;
      if (quality !== null && typeof quality === "object") marksWithQuality += 1;
      const resolved = summaryTextFor(graph, mark);
      const chars = Number(mark?.summaryChars);
      if (resolved.text !== null) {
        if (resolved.source === "mark") withMarkText += 1;
        else withRefText += 1;
        bucket.text += 1;
        sampleChars.push(resolved.text.length);
        sampleBytes.push(jsonBytes(resolved.text));
        for (const key of Object.keys(SCHEMES)) perSchemeBytes[key].push(jsonBytes(storeAs(resolved.text, key)));
      } else if (Number.isFinite(chars) && chars > 0) {
        charsOnly += 1;
        bucket.charsOnly += 1;
      } else {
        neither += 1;
        bucket.neither += 1;
      }
    }
  }

  const bytesSorted = [...sampleBytes].sort((a, b) => a - b);
  const charsSorted = [...sampleChars].sort((a, b) => a - b);
  const currentlyStored = sum(sampleBytes);
  const sampleCount = bytesSorted.length;
  const avgBytes = sampleCount === 0 ? 0 : currentlyStored / sampleCount;
  const avgChars = charsSorted.length === 0 ? 0 : sum(charsSorted) / charsSorted.length;

  // 全库落盘：样本内逐条实测 + 样本外按均值外推（老 producer 的正文永远拿不到，只能估）
  const costs = {};
  for (const [key, scheme] of Object.entries(SCHEMES)) {
    const measured = sum(perSchemeBytes[key]);
    const projected = sampleCount === 0 ? 0 : (measured / sampleCount) * marks;
    costs[key] = {
      key,
      name: scheme.name,
      measuredBytes: measured,
      projectedBytes: Math.round(projected),
      netBytes: Math.round(projected - currentlyStored),
      pctOfGraph: graphBytes === 0 ? 0 : (projected / graphBytes) * 100,
      bytesPerMark: Math.round(sampleCount === 0 ? 0 : measured / sampleCount),
    };
  }

  return {
    home,
    sessionsDir: dir,
    sessions,
    sessionsWithMarks,
    marks,
    marksWithQuality,
    withMarkText,
    withRefText,
    withText: withMarkText + withRefText,
    charsOnly,
    neither,
    unreadable: charsOnly + neither,
    byTrigger,
    bad,
    graphBytes,
    samples: {
      count: sampleCount,
      chars: {
        p50: percentile(charsSorted, 0.5),
        p90: percentile(charsSorted, 0.9),
        max: charsSorted.at(-1) ?? null,
        avg: Math.round(avgChars),
      },
      bytes: {
        p50: percentile(bytesSorted, 0.5),
        p90: percentile(bytesSorted, 0.9),
        max: bytesSorted.at(-1) ?? null,
        avg: Math.round(avgBytes),
      },
      currentlyStored,
    },
    costs,
  };
}

/* ────────────────────────────────── 输出 ────────────────────────────────── */

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "—");
const pct1 = (x) => `${(Math.round(Number(x) * 10) / 10).toFixed(1)}%`;
const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(2)} MB`;
const share = (part, whole) => (Number(whole) > 0 ? `${((Number(part) / Number(whole)) * 100).toFixed(1)}%` : "—");

/** 渲染成人读的报告（验收要的就是这一段）。 */
export function render(stats) {
  const s = stats;
  const out = [];
  out.push("== 摘要正文持久化审计（foldMark 里到底存没存 · 只读）==");
  out.push(`   home         ${s.home}`);
  out.push(`   扫了         ${fmt(s.sessions)} 个会话 · ${fmt(s.marks)} 条 foldMark（其中 ${fmt(s.sessionsWithMarks)} 个会话有折痕）`);
  out.push(`   graph.json   ${mb(s.graphBytes)}（${fmt(s.graphBytes)} 字节）—— 成本百分比的分母`);
  if (s.bad.length > 0) out.push(`   读不动       ${s.bad.map((b) => `${b.session}（${b.error}）`).join(" · ")}`);
  out.push("");

  out.push("── ① 现状：正文落盘了没有 ─────────────────────────────────────────────");
  const total = s.marks === 0 ? 1 : s.marks;
  out.push(`   有正文       ${String(fmt(s.withText)).padStart(5)} 条（${share(s.withText, total).padStart(5)}）` +
    ` ← 本条自己的 summaryText ${fmt(s.withMarkText)} 条 · 引用 lastOfflineSummary ${fmt(s.withRefText)} 条`);
  out.push(`   只有字数     ${String(fmt(s.charsOnly)).padStart(5)} 条（${share(s.charsOnly, total).padStart(5)}）` +
    ` ← summaryChars 有值，正文没存 ⇒ **不可复判**`);
  out.push(`   两者都没有   ${String(fmt(s.neither)).padStart(5)} 条（${share(s.neither, total).padStart(5)}）` +
    ` ← 生产者比 C502 还早（连 summaryChars 都没写）`);
  out.push(`   可复判分母   「有正文」= ${fmt(s.withText)} 条；不可复判 ${fmt(s.unreadable)} 条` +
    `（生产者早于 ${SUMMARY_TEXT_SINCE}，不是正文丢了）`);
  out.push(`   带 quality   ${fmt(s.marksWithQuality)} 条（三个审计器的候选池；没有 quality 的 mark 它们本来就不看）`);
  out.push("");
  out.push("   按 trigger 拆：");
  const triggers = Object.entries(s.byTrigger).sort((a, b) => b[1].marks - a[1].marks);
  const wTrig = Math.max(...triggers.map(([k]) => k.length), 6);
  out.push(`   ${"trigger".padEnd(wTrig)}   mark    有正文   只有字数  两者都没有`);
  for (const [trigger, b] of triggers) {
    out.push(
      `   ${trigger.padEnd(wTrig)}  ${String(fmt(b.marks)).padStart(6)}  ${String(fmt(b.text)).padStart(7)}  ` +
        `${String(fmt(b.charsOnly)).padStart(8)}  ${String(fmt(b.neither)).padStart(10)}`,
    );
  }
  out.push("");

  out.push("── ② 一份摘要正文有多大（JSON 内实际占用）──────────────────────────────");
  if (s.samples.count === 0) {
    out.push("   样本 0 份 —— 全库一条正文都没有，成本只能等有折痕后再量（不许拿 0 冒充「很小」）");
  } else {
    out.push(`   样本         ${fmt(s.samples.count)} 份（全库能拿到正文的折痕；老 producer 的正文已永久丢失）`);
    out.push(`   字符         p50 ${fmt(s.samples.chars.p50)} · p90 ${fmt(s.samples.chars.p90)} · max ${fmt(s.samples.chars.max)} · 均值 ${fmt(s.samples.chars.avg)}`);
    out.push(`   字节         p50 ${fmt(s.samples.bytes.p50)} · p90 ${fmt(s.samples.bytes.p90)} · max ${fmt(s.samples.bytes.max)} · 均值 ${fmt(s.samples.bytes.avg)}`);
    out.push(`   已占用       ${mb(s.samples.currentlyStored)}（这就是 lastOfflineSummary 现在那一份的总大小）`);
  }
  out.push("");

  out.push("── ③ 全库都落盘要多少磁盘（foldMark 数 × 摘要大小）──────────────────────");
  out.push(`   按 ${fmt(s.marks)} 条 foldMark × 均值 ${fmt(s.samples.bytes.avg)} 字节估：`);
  out.push(`   ${"方案".padEnd(4)} ${"存法".padEnd(20)} ${"每条".padStart(9)} ${"全库毛成本".padStart(12)} ${"净增".padStart(10)} ${"占 graph.json".padStart(14)}`);
  for (const key of ["A", "B", "C"]) {
    const c = s.costs[key];
    out.push(
      `   ${c.key.padEnd(4)} ${c.name.padEnd(20)} ${String(fmt(c.bytesPerMark)).padStart(9)} ${mb(c.projectedBytes).padStart(12)} ` +
        `${mb(c.netBytes).padStart(10)} ${pct1(c.pctOfGraph).padStart(14)}`,
    );
  }
  out.push(`   净增 = 毛成本 − 已占用（${mb(s.samples.currentlyStored)}，lastOfflineSummary 里那一份不重复写）；`);
  out.push(`   **硬约束**：+50% 是红线（≈ ${mb(s.graphBytes * 0.5)}）；超过就只能选 B 或 C。`);
  out.push("");

  out.push("── ④ 三种方案能回答哪些问题（✓ 全量 / △ 部分 / ✗ 不能）──────────────────");
  for (const key of ["A", "B", "C"]) {
    const c = s.costs[key];
    out.push(
      `   ${c.key} ${c.name}：${fmt(c.bytesPerMark)} 字节/条 · 全库 ${mb(c.projectedBytes)} · 占 graph.json ${pct1(c.pctOfGraph)}`,
    );
    for (const cap of CAPABILITIES) {
      out.push(`      ${cap.question}  →  ${cap[key]}`);
    }
  }
  out.push("");
  out.push("── ⑤ 结论 ──────────────────────────────────────────────────────────────");
  const a = s.costs.A;
  const withinBudget = s.graphBytes > 0 && a.pctOfGraph < 50;
  out.push(
    `   当前可复判 ${fmt(s.withText)}/${fmt(s.marks)} 条（${share(s.withText, total)}）；` +
      `剩下 ${fmt(s.unreadable)} 条不可复判 —— 生产者早于 ${SUMMARY_TEXT_SINCE}，正文当时就没落盘，**永远补不回来**。`,
  );
  out.push(
    `   方案 A 全库落盘 ${mb(a.projectedBytes)}（占 graph.json ${pct1(a.pctOfGraph)}，净增 ${mb(a.netBytes)}）` +
      `⇒ ${withinBudget ? `**在 +50% 红线内，可以选 A**` : `**超过 +50% 红线，只能选 B（${mb(s.costs.B.projectedBytes)}）或 C（${mb(s.costs.C.projectedBytes)}）**`}。`,
  );
  out.push(`   B / C 的正文是截断的 ⇒ 三个审计器能算的只有「段在不在」，重放补回与质量重算都会失真。`);
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return null;
    if (hit === `--${name}`) return "";
    return hit.slice(name.length + 3);
  };
  const home = flag("home") || resolveHome();
  const stats = collectSummaryStats({ home });
  if (flag("json") !== null) {
    console.log(JSON.stringify({ home, summaryTextSince: SUMMARY_TEXT_SINCE, ...stats, capabilities: CAPABILITIES }, null, 1));
  } else {
    console.log(render(stats));
  }
  return stats.sessions === 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
