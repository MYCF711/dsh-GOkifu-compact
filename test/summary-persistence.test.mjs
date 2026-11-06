/**
 * summary-persistence.test.mjs —— 「折叠摘要正文必须落盘」的守卫（C642）
 *
 * 病（Lead 实测 2026-11-05 05:5x）：`structure-audit` 的输出里长期挂着一句
 * 「候选 383 条（可复判 144 · 正文未落盘 239）」。那 239 条**折叠的质量无法复判** ——
 * `lastOfflineSummary` 只保留**最后一次**折叠的正文，更早的 `foldMark` 只有 `summaryChars`。
 * 三个审计器（structure / fold-loss / repair-coverage）于是都只能说「不可复判，我不猜」。
 *
 * 修法是**两条一起**，缺一条这个洞就还在：
 *   ① 写回点给每条折痕落正文（`summaryText`），最后一段只留**引用**（`summaryTextRef`）——
 *      一条摘要只存一遍（`lastOfflineSummary` 已经有一份，写两遍 = 磁盘成本凭空翻倍）；
 *   ② 下一次折叠**先把上一份搬进它自己的折痕**，再覆盖 `lastOfflineSummary` ——
 *      不搬的话「只有最后一次可复判」这条根本没变，只是从「第 N 次」挪到「第 N+1 次」。
 *
 * 本文件钉住 7 件事（每一条都对应一个具体的退化方式）：
 *   1. 写回点：非最后一段自带正文、最后一段只留引用、`lastOfflineSummary` 行为不变；
 *   2. **同一份正文在整张图里只出现一次**（字节级，不是「大概」）；
 *   3. 第二次折叠把上一份搬进来，且搬完撤掉引用（「正文在哪」只许有一个说法）；
 *   4. 向后兼容：老 mark（没有 `summaryText`）照旧按 `lastOfflineSummary` 区间读，
 *      拿不到时**如实说「生产者早于 C642」**，绝不拿别的段冒充；
 *   5. 成本口径：B 的省略标记也算字节、C = 哈希 + 前 200、A = 全文（成本表不能系统性低估）；
 *   6. 三个审计器的「可复判」分母都改成**有正文的 mark 数**（静态守卫，防止改回去）；
 *   7. 端到端：`collectSummaryStats` 真的去读一个 sessions 目录，三类计数与成本都要有数。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";
import { collectSummaryStats, jsonBytes, percentile, storeAs, summaryTextFor } from "../scripts/summary-persistence-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

/** 统计某个字符串在一段 JSON 文本里出现几次（`JSON.stringify` 会把换行写成 `\n`）。 */
const countOf = (text, needle) => String(text).split(needle).length - 1;

const T1 = "## 目标\n- 把压缩链路修到可交付\n## 棋谱\n- n1 用户提出目标";
const T2 = "## 目标\n- 第二条折痕的正文\n## 已探明死路\n- e12 跑测试 → exit 2";

/* ─────────────────── ① 写回点：正文落盘 / 最后一段只留引用 ─────────────────── */

tests["C642 写回点：非最后一段自带 summaryText，最后一段只留 summaryTextRef 引用"] = (t) => {
  const graph = { foldMarks: [], closeout: {} };
  applyOfflineFoldToGraph(
    graph,
    {
      chunks: [
        { start: 1, end: 10, text: T1 },
        { start: 11, end: 20, text: T2 },
      ],
      coveredStart: 1,
      coveredEnd: 20,
    },
    { now: 1 },
  );
  t.eq(graph.foldMarks.length, 2, "两段各一条折痕");
  t.eq(graph.foldMarks[0].summaryText, T1, "非最后一段必须自带正文（三个审计器的复判依据）");
  t.eq(graph.foldMarks[1].summaryText, undefined, "最后一段**不许**写副本（lastOfflineSummary 已有一份）");
  t.eq(graph.foldMarks[1].summaryTextRef, "lastOfflineSummary", "最后一段留引用，说明正文在哪");
  t.eq(graph.lastOfflineSummary.text, T2, "lastOfflineSummary 行为不变（旧读侧一个字节都不受影响）");
  t.eq(graph.foldMarks[1].summaryChars, T2.length, "summaryChars 仍然与正文逐字对得上");
};

tests["C642 一条摘要只存一遍：同一份正文在整张图里只许出现一次"] = (t) => {
  const graph = { foldMarks: [], closeout: {} };
  applyOfflineFoldToGraph(graph, { chunks: [{ start: 1, end: 10, text: T1 }] }, { now: 1 });
  const json = JSON.stringify(graph);
  // `JSON.stringify` 把换行写成 `\n` 两个字符 —— 统计时也要按那个形态数
  const encoded = JSON.stringify(T1).slice(1, -1);
  t.eq(countOf(json, encoded), 1, "写两遍 = 磁盘成本凭空翻倍（这是本轮的硬约束）");
};

/* ───────────── ② 第二次折叠：上一份必须搬进它自己的折痕 ───────────── */

tests["C642 第二次折叠：上一份正文必须搬进它自己的折痕（否则「只有最后一次可复判」根本没变）"] = (t) => {
  const graph = { foldMarks: [], closeout: {} };
  applyOfflineFoldToGraph(graph, { chunks: [{ start: 1, end: 10, text: T1 }] }, { now: 1 });
  t.eq(graph.foldMarks[0].summaryText, undefined, "第一次折叠时它是最后一段 ⇒ 只留引用");
  t.eq(graph.foldMarks[0].summaryTextRef, "lastOfflineSummary", "（引用指向当时那份正文）");

  applyOfflineFoldToGraph(graph, { chunks: [{ start: 11, end: 20, text: T2 }] }, { now: 2 });

  t.eq(graph.foldMarks[0].summaryText, T1, "第二次折叠要把上一份搬进 mark#0");
  t.eq(graph.foldMarks[0].summaryTextRef, undefined, "搬完必须撤掉引用 —— 「正文在哪」只许有一个说法");
  t.eq(graph.foldMarks[1].summaryText, undefined, "新的最后一段仍然只留引用（不写副本）");
  t.eq(graph.foldMarks[1].summaryTextRef, "lastOfflineSummary", "（新引用指向新正文）");
  t.eq(summaryTextFor(graph, graph.foldMarks[0]).text, T1, "两条折痕都可复判（历史不再有洞）");
  t.eq(summaryTextFor(graph, graph.foldMarks[1]).text, T2, "最后一条走引用也能复判");
  t.eq(countOf(JSON.stringify(graph), JSON.stringify(T1).slice(1, -1)), 1, "搬完仍然只有一份副本");
};

tests["C642 搬运用区间全等判定：lastOfflineSummary 与任何折痕都对不上时一个字都不动"] = (t) => {
  const graph = {
    foldMarks: [{ at: 1, seqStart: 1, seqEnd: 10, trigger: "archive-offline", summaryChars: 9 }],
    lastOfflineSummary: { at: 2, range: { start: 11, end: 20 }, text: T2 },
    closeout: {},
  };
  const before = JSON.stringify(graph.foldMarks[0]);
  applyOfflineFoldToGraph(graph, { chunks: [{ start: 31, end: 40, text: T1 }] }, { now: 3 });
  t.eq(JSON.stringify(graph.foldMarks[0]), before, "区间对不上 ⇒ 老 mark 一个字段都不许改（不然就是编造）");
};

/* ─────────────────────── ③ 向后兼容：老 mark 照旧能读 ─────────────────────── */

tests["C642 向后兼容：老 mark 没有 summaryText ⇒ 按 lastOfflineSummary 区间读，读不到就说「生产者早于 C642」"] = (t) => {
  const graph = {
    foldMarks: [
      { at: 1, seqStart: 1, seqEnd: 10, trigger: "archive-offline", summaryChars: 4 },
      { at: 2, seqStart: 11, seqEnd: 20, trigger: "archive-offline", summaryChars: 4 },
    ],
    lastOfflineSummary: { at: 2, range: { start: 11, end: 20 }, text: T2 },
  };
  const old = summaryTextFor(graph, graph.foldMarks[0]);
  t.eq(old.text, null, "老 mark 拿不到正文 ⇒ 如实说没有（不猜）");
  t.eq(old.source, null, "没有正文就没有来源");
  t.includes(old.why, "生产者早于 C642", "要说明是**世代**问题（修法完全不同：等新折痕，不是查写回点）");
  t.eq(summaryTextFor(graph, graph.foldMarks[1]).text, T2, "区间对得上的老 mark 仍然读得到");
  t.eq(summaryTextFor({ foldMarks: [] }, graph.foldMarks[0]).text, null, "连 lastOfflineSummary 都没有 ⇒ null（不抛）");
  // 空正文与「没有正文」是同一件事：空摘要本来就不可复判
  t.eq(summaryTextFor({ lastOfflineSummary: { range: { start: 1, end: 10 }, text: "" } }, graph.foldMarks[0]).text, null, "空正文 = 不可复判");
};

/* ─────────────────────── ④ 成本口径（成本表不许系统性低估） ─────────────────────── */

tests["C642 成本口径：A 全文 / B 掐头去尾（省略标记也算字节）/ C 哈希 + 前 200"] = (t) => {
  const text = "x".repeat(5000);
  t.eq(storeAs(text, "A"), text, "A 就是全文（一个字节都不省）");

  const b = storeAs(text, "B");
  t.eq(b.length < text.length, true, "B 必须比全文短");
  t.includes(b, "省略", "截断要留省略标记（否则读者以为摘要就这么短）");
  t.eq(b.startsWith("x".repeat(2000)), true, "B 前 2000 字符原样");
  t.eq(b.endsWith("x".repeat(800)), true, "B 后 800 字符原样");
  t.eq(jsonBytes(b) > jsonBytes(text.slice(0, 2000)), true, "标记本身也要算字节（少算 = 成本表低估）");

  const c = storeAs(text, "C");
  t.eq(c.startsWith("sha256:"), true, "C 以指纹开头");
  t.eq(c.length, "sha256:".length + 16 + " · ".length + 200, "C = 前缀 + 16 位十六进制 + 200 字符");
  t.eq(storeAs("short", "B"), "short", "短于 head 的正文不截断，也不许加标记");
  t.eq(storeAs(text, "C") === storeAs(text, "C"), true, "C 是确定性的（同文同指纹）");
  t.ne(storeAs("abc", "C").slice(7, 23), storeAs("abd", "C").slice(7, 23), "差一个字指纹必须不同");
  t.throws(() => storeAs("x", "Z"), "未知方案必须抛（不许静默返回全文）");
};

tests["C642 百分位：空样本返回 null（绝不用 0 冒充「很小」）"] = (t) => {
  t.eq(percentile([], 0.5), null, "没有样本就是没有");
  t.eq(percentile([1, 2, 3, 4], 0.5), 2, "p50 取 nearest-rank");
  t.eq(percentile([1, 2, 3, 4], 0.9), 4, "p90 不许越界");
  t.eq(jsonBytes(""), 0, "空正文 0 字节");
  t.eq(jsonBytes('a"b'), 4, "引号转义要算进去（`\\\"` 多 1 字节）");
  t.eq(jsonBytes("中"), 3, "中文按 UTF-8 3 字节算 —— 按字符数估会系统性低估");
};

/* ─────────────────── ⑤ 静态守卫：写回点与三个审计器 ─────────────────── */

tests["C642 静态守卫：写回点必须写正文，三个审计器必须共用同一个读取器与同一个世代号"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(REPO, "src", "rooms", "offline-fold.mjs"), "utf8");
  const at = src.indexOf("export function applyOfflineFoldToGraph");
  t.eq(at > 0, true, "写回点必须存在");
  const body = src.slice(at);
  t.includes(body, "summaryText: text", "非最后一段必须落 summaryText（否则三个审计器又只能「无法判定」）");
  t.includes(body, "summaryTextRef", "最后一段必须留引用（写副本 = 摘要存两遍）");
  t.includes(body, "owner.summaryText = previous.text", "上一次的正文必须搬进它自己的折痕");

  for (const name of ["structure-audit.mjs", "fold-loss-audit.mjs", "repair-coverage-audit.mjs"]) {
    const audit = nodeFs.readFileSync(nodePath.join(REPO, "scripts", name), "utf8");
    t.includes(audit, 'from "./summary-persistence-audit.mjs"', `${name} 必须用共享读取器（四个读侧各写一份 = C587 老路）`);
    t.includes(audit, "SUMMARY_TEXT_SINCE", `${name} 必须报出「生产者早于 C642」的世代`);
  }
  // 读取器只许有一个实现：另外两个脚本不许再自己写一份
  for (const name of ["structure-audit.mjs", "fold-loss-audit.mjs"]) {
    const audit = nodeFs.readFileSync(nodePath.join(REPO, "scripts", name), "utf8");
    t.eq(/export function summaryTextFor\(/.test(audit), false, `${name} 不许再定义一份 summaryTextFor（只能转出）`);
  }
};

/* ─────────────────────── ⑥ 端到端：真的去读一个 sessions 目录 ─────────────────────── */

tests["C642 端到端：collectSummaryStats 三类计数与成本都要有数（含「两者都没有」的老折痕）"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "summary-persistence-"));
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "sess-persist");
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = createGraph({ sessionId: "sess-persist", cwd: "E:/x" });
    // 真机摘要 p50 ≈ 6.5k 字符：成本对比必须在**这个量级**上做，短文本会把 B 的截断掩盖掉
    // （3000 字以内容器都装得下 ⇒ B 与 A 一样贵，反而看不出「B 比 A 便宜」）。
    const LONG = `## 目标\n- 把压缩链路修到可交付\n${"x".repeat(5000)}`;
    g.foldMarks = [
      // ① 自带正文（C642 起，非最后一段）
      { at: 3000, seqStart: 1, seqEnd: 10, trigger: "archive-offline", summaryChars: LONG.length, summaryText: LONG, quality: { sectionsMissing: [] } },
      // ② 最后一段：只有引用
      { at: 2000, seqStart: 11, seqEnd: 20, trigger: "archive-offline", summaryChars: LONG.length, summaryTextRef: "lastOfflineSummary", quality: {} },
      // ③ 老 producer：只有字数
      { at: 1000, seqStart: 21, seqEnd: 30, trigger: "archive-offline", summaryChars: 6400, quality: {} },
      // ④ 比 C502 还老：连 summaryChars 都没有
      { at: 500, seqStart: 31, seqEnd: 40, trigger: null },
    ];
    g.lastOfflineSummary = { at: 2000, range: { start: 11, end: 20 }, text: LONG, model: "m" };
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g));

    const stats = collectSummaryStats({ home });
    t.eq(stats.sessions, 1, "扫了 1 个会话");
    t.eq(stats.marks, 4, "4 条折痕");
    t.eq(stats.withMarkText, 1, "自带正文 1 条");
    t.eq(stats.withRefText, 1, "引用 lastOfflineSummary 1 条");
    t.eq(stats.withText, 2, "可复判 2 条");
    t.eq(stats.charsOnly, 1, "只有字数 1 条");
    t.eq(stats.neither, 1, "两者都没有 1 条");
    t.eq(stats.unreadable, 2, "不可复判 = 只有字数 + 两者都没有");
    t.eq(stats.samples.count, 2, "样本 = 能拿到正文的 2 条");
    t.eq(stats.samples.chars.max, LONG.length, "max 取最长的那份");
    t.eq(stats.costs.A.projectedBytes > 0, true, "方案 A 的全库成本要有数（不许 0 冒充「很小」）");
    t.eq(stats.costs.A.projectedBytes > stats.costs.B.projectedBytes, true, "A（全文）必须比 B（截断）贵");
    t.eq(stats.costs.B.projectedBytes > stats.costs.C.projectedBytes, true, "B 必须比 C（哈希 + 200）贵");
    t.eq(stats.costs.C.bytesPerMark > 0, true, "C 的每条成本也要有数");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["C642 端到端：home 里一张图都没有 ⇒ sessions=0（退出码 1 的依据，不许假装跑过）"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "summary-persistence-empty-"));
  try {
    const stats = collectSummaryStats({ home });
    t.eq(stats.sessions, 0, "空 home 一个会话都没有");
    t.eq(stats.marks, 0, "0 条折痕");
    t.eq(stats.samples.chars.p50, null, "没有样本 ⇒ p50 是 null 而不是 0");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
