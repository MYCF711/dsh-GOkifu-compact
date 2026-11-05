/**
 * cache-miss.test.mjs —— `none` 组的 miss **必须被逐条归因**（C611，2026-11-05）
 *
 * ## 这条守卫保护什么
 *
 * T45 修完 replace 之后，账单上还剩一行没人解释：
 *
 * | 动作 | 请求 | 命中率 | 每次中位 miss | 花费 |
 * |---|---|---|---|---|
 * | none | 98,109 | 97.6% | 976 | $213.25 |
 *
 * `none` 组的定义是「这一发**什么都没做**」—— 那它的 miss 凭什么发生？
 * `scripts/cache-miss-audit.mjs` 的回答是把 miss 拆成 `growth`（新增，物理上无缓存可命中）
 * 与 `waste`（前缀重读，本该命中），再按 **间隔 / 改写事件 / prompt 大小** 归因。
 *
 * ## 守卫断言的是什么
 *
 * ① **恒等式**：`miss === growth + waste`，且 `growth ≤ miss`（拆账不许凭空造 token）；
 * ② **判据互斥且完整**：四类（D/B/A/U）在合成数据上**各自只命中自己那一条** ——
 *    任何一条判据被删掉/写反，至少两条会撞在一起（这是"失败分支必须真红"的最直接形式）；
 * ③ **阈值恰好**：`waste === NOISE_TOKENS` 算 D、`+1` 就不算；`gap === TTL_SECONDS` 算 A、`−1s` 不算；
 * ④ **受控 lift 必须控制间隔**：同一间隔桶内比较 —— 不控制就会把「轮开始天然间隔长」
 *    记到注入头上（本仓第一版审计差点这么写，见脚本 §④ 的注释）；
 * ⑤ **端到端夹具**：真造一个多帧 zstd 会话日志，`scanHome` 出来的行数/桶份额/判定必须与手算一致；
 * ⑥ **`chess-context` 必须被排除在外**：那是 T45 的 `replace`/`append` 组，混进来就重复计费；
 * ⑦ **价目表与 T45 同源**：两边漂移会让两份报告的美元不可比。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import zlib from "node:zlib";

import {
  BUCKETS,
  NOISE_TOKENS,
  PRICES,
  TTL_SECONDS,
  attributeRequests,
  ceilingOf,
  classifyRow,
  controlledLift,
  decompose,
  extractEvents,
  gapBucket,
  growthOf,
  gini,
  median,
  promptBucket,
  requestCost,
  rewriteKindsOf,
  scanHome,
  sessionConcentration,
  sizeTest,
  verdictOf,
  wasteOf,
} from "../scripts/cache-miss-audit.mjs";
import { PRICES as T45_PRICES } from "../scripts/cache-friendliness-audit.mjs";

export const tests = {};

/* ────────────────────────── 夹具构造 ────────────────────────── */

/** 一条 `assistant/message`（带 usage）。`miss` = inputTokens（**只含未命中**）。 */
function assistant(seq, time, { miss, hit, out = 100, turn = 1, step = 1 }) {
  return {
    type: "assistant/message",
    seq,
    time,
    data: { turn, step, message: { role: "assistant", content: [] }, usage: { inputTokens: miss, cacheReadTokens: hit, outputTokens: out, totalTokens: miss + hit + out } },
    surfaceOp: "append",
  };
}

/** 一条 `user/message`（注入）。 */
function userMessage(seq, time, kind, surfaceOp = "append") {
  return { type: "user/message", seq, time, data: { source: { kind }, content: [{ type: "text", text: "x" }] }, surfaceOp };
}

/** 一次折叠事务（compaction/start → summary → end）。 */
function compaction(seq, time, id = "c1") {
  return [
    { type: "compaction/start", seq, time, data: { compactionId: id, turn: 1 } },
    { type: "compaction/summary", seq: seq + 1, time: time + 1, data: { compactionId: id, summary: [{ type: "text", text: "摘要" }] } },
    { type: "compaction/end", seq: seq + 2, time: time + 2, data: { compactionId: id, turn: 1 } },
  ];
}

/**
 * 端到端夹具：4 条 `none` 请求，四条归因**各一条**（D/B/A/U），外加一条 `chess-context`
 * 请求（必须不被算进 `none` 组）。
 *
 * 手算（t0 = 1_000_000_000）：
 *
 * | seq | 时间 | miss | hit | prompt | prev | growth | waste | 间隔 | 结论 |
 * |---|---|---|---|---|---|---|---|---|---|
 * | 3  | t0        | 5,000 | 5,000  | 10,000 | —      | —      | —      | 冷启动 ⇒ 不产行 |
 * | 5  | t0+10s    | 1,000 | 9,000  | 10,000 | 10,000 | 0      | 1,000  | 10s  | **U** |
 * | 7  | t0+20s    | 2,000 | 10,000 | 12,000 | 10,000 | 2,000  | 0      | 10s  | **D** |
 * | 11 | t0+30s    | 8,000 | 4,000  | 12,000 | 12,000 | 0      | 8,000  | 10s  | **B**（期间有折叠事务）|
 * | 20 | t0+430s   | 9,000 | 3,000  | 12,000 | 12,000 | 0      | 9,000  | 400s | **A**（间隔 ≥ TTL）|
 *
 * waste 合计 18,000：D 0 · B 8,000（44.4%）· A 9,000（50.0%）· U 1,000（5.6%）⇒ 判定 A。
 */
const T0 = 1_000_000_000;
const FIXTURE_EVENTS = [
  { type: "system/message", seq: 1, time: T0, data: { message: { role: "system", content: [] } } },
  userMessage(2, T0 + 1, "user"),
  assistant(3, T0 + 2, { miss: 5_000, hit: 5_000 }),
  { type: "tool/result", seq: 4, time: T0 + 3, data: { result: "ok" } },
  assistant(5, T0 + 10_000, { miss: 1_000, hit: 9_000 }),
  userMessage(6, T0 + 11_000, "time-context"),
  assistant(7, T0 + 20_000, { miss: 2_000, hit: 10_000 }),
  ...compaction(8, T0 + 21_000),
  assistant(11, T0 + 30_000, { miss: 8_000, hit: 4_000 }),
  assistant(20, T0 + 430_000, { miss: 9_000, hit: 3_000 }),
  userMessage(21, T0 + 431_000, "chess-context", "append"),
  assistant(22, T0 + 432_000, { miss: 12_345, hit: 100 }),
];

/** 把事件序列写成**多帧** zstd（宿主就是这么写的：首尾相接的一串独立帧）。 */
function writeZstdFixture(dir, events, { name = "session-fixture-0001", workspace = "ws-a" } = {}) {
  const sessionDir = nodePath.join(dir, "sessions", workspace, name);
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, "utf8")));
  const file = nodePath.join(sessionDir, "session.v4.jsonl.zstd");
  nodeFs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

function tmpHome() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "cache-miss-"));
}

/* ────────────────────────── ① 恒等式 ────────────────────────── */

tests["C611 拆账恒等：miss === growth + waste，且 growth ≤ miss（不许凭空造 token）"] = (t) => {
  const cases = [
    { miss: 1000, prompt: 10_000, prevPrompt: 10_000 }, // 前缀整段失效
    { miss: 1000, prompt: 10_000, prevPrompt: 9_000 }, // 只付新增
    { miss: 1000, prompt: 10_000, prevPrompt: 12_000 }, // 折叠后变短：growth 必须夹到 0
    { miss: 0, prompt: 10_000, prevPrompt: 10_000 }, // 全命中
    { miss: 5000, prompt: 5000, prevPrompt: 0 }, // 冷启动
  ];
  for (const c of cases) {
    const r = wasteOf(c);
    t.eq(r.growth + r.waste, r.miss, `恒等式破裂：${JSON.stringify(c)}`);
    t.ok(r.growth >= 0 && r.waste >= 0, `两部分都必须非负：${JSON.stringify(c)}`);
    t.ok(r.growth <= r.miss, `growth 不得超过 miss：${JSON.stringify(c)}`);
  }
  // 反方向：折叠（prompt 变小）时 growth 必须是 0，不能把"变短"当成负新增去抵账
  t.eq(growthOf(10_000, 12_000), 0, "prompt 变小时 growth 必须是 0");
  t.eq(growthOf(12_000, 10_000), 2_000, "prompt 变大时 growth = 差值");
  t.eq(growthOf(5_000, null), 5_000, "冷启动 growth = 整条 prompt");
};

/* ────────────────────────── ② 阈值恰好 ────────────────────────── */

tests["C611 阈值恰好：waste=NOISE_TOKENS 算 D，+1 就不算；gap=TTL 算 A，−1s 不算"] = (t) => {
  const base = { prompt: 100_000, prevPrompt: 100_000, gapSec: 10, rewrites: [] };
  const at = { ...base, miss: NOISE_TOKENS };
  const over = { ...base, miss: NOISE_TOKENS + 1 };
  t.eq(wasteOf(at).waste, NOISE_TOKENS, "夹具自身：waste 应恰好等于 NOISE_TOKENS");
  t.eq(classifyRow(at), "D", `waste === NOISE_TOKENS 必须算 D（noise=${NOISE_TOKENS}）`);
  t.ne(classifyRow(over), "D", `waste === NOISE_TOKENS + 1 不许再算 D`);

  const noRewrite = { prompt: 100_000, prevPrompt: 100_000, miss: 50_000, rewrites: [] };
  t.eq(classifyRow({ ...noRewrite, gapSec: TTL_SECONDS }), "A", `gap === TTL_SECONDS 必须算 A（ttl=${TTL_SECONDS}）`);
  t.eq(classifyRow({ ...noRewrite, gapSec: TTL_SECONDS - 1 }), "U", `gap === TTL_SECONDS − 1 必须算 U`);
  // 间隔桶边界（上界开区间）
  t.eq(gapBucket(0), "0–5s", "gap 0");
  t.eq(gapBucket(4.999), "0–5s", "gap 4.999");
  t.eq(gapBucket(5), "5–30s", "gap 5 落下一桶（上界开区间）");
  t.eq(gapBucket(299.9), "120–300s", "gap 299.9");
  t.eq(gapBucket(300), "300–600s", "gap 300 落下一桶");
  t.eq(gapBucket(3600), "≥3600s", "gap 3600 落最后一桶");
  t.eq(gapBucket(null), "unknown", "缺间隔要显式 unknown，不许猜 0");
  // prompt 桶边界（<16k 起）
  t.eq(promptBucket(15_999), "<16k", "prompt 15,999");
  t.eq(promptBucket(16_000), "16–64k", "prompt 16,000");
  t.eq(promptBucket(1_000_000), "≥768k", "prompt 1M");
};

/* ────────────────────────── ③ 判据互斥（失败分支必须真红） ────────────────────────── */

tests["C611 四类判据互斥：同一批合成数据里四类各自只命中自己（删/写反任何一条都会撞车）"] = (t) => {
  // 四条请求，唯一差别是「期间有没有改写」与「间隔多长」
  const cases = [
    { name: "D", row: { miss: 200, prompt: 100_000, prevPrompt: 100_000, gapSec: 10, rewrites: [] } },
    { name: "B", row: { miss: 90_000, prompt: 100_000, prevPrompt: 100_000, gapSec: 10, rewrites: ["compaction/summary"] } },
    { name: "A", row: { miss: 90_000, prompt: 100_000, prevPrompt: 100_000, gapSec: 600, rewrites: [] } },
    { name: "U", row: { miss: 90_000, prompt: 100_000, prevPrompt: 100_000, gapSec: 10, rewrites: [] } },
  ];
  const got = cases.map((c) => classifyRow(c.row));
  t.eq(got, ["D", "B", "A", "U"], "四类归因必须一一对应");
  t.eq(new Set(got).size, 4, "四类不许撞车（撞车说明某条判据被删或写反）");

  // 反方向：**B 与 A 的分界必须是「有没有改写」，不是间隔长短**
  t.eq(classifyRow({ ...cases[1].row, gapSec: 9999 }), "B", "长间隔 + 有改写 ⇒ 仍然记 B（改写优先于 TTL）");
  t.eq(classifyRow({ ...cases[2].row, gapSec: 0 }), "U", "短间隔 + 无改写 ⇒ 只能是 U，不许硬塞进 A 或 B");
  // D 不许被改写事件"抬高"：本来就只付新增时，改写事件不该让这一行变成 B
  t.eq(classifyRow({ ...cases[0].row, rewrites: ["compaction/summary"] }), "D", "waste ≤ noise 时即使有改写也算 D（零头不归因）");

  // 判定规则：B 过半 ⇒ B；A+U 过半 ⇒ A；D 过半 ⇒ D
  const mk = (shares) => ({ buckets: Object.fromEntries(BUCKETS.map((k) => [k, { shareOfWaste: shares[k] ?? 0 }])), totalCost: 100 });
  t.eq(verdictOf(mk({ B: 0.9 })).code, "B", "B 过半必须判 B（这是唯一值得改代码的方向）");
  t.eq(verdictOf(mk({ A: 0.3, U: 0.3 })).code, "A", "A+U 过半必须判 A（物理限制）");
  t.eq(verdictOf(mk({ D: 0.8 })).code, "D", "D 过半必须判 D（正常增量）");
  t.eq(verdictOf(mk({ D: 0.4, A: 0.2, U: 0.2, B: 0.2 })).code, "mixed", "没有主导原因时不许硬挑一个");
  const asA = verdictOf(mk({ A: 0.1, U: 0.9 }));
  t.eq(asA.label, "TTL 过期", "A/U 合并后的标签要写明是 TTL 这一族");
};

/* ────────────────────────── ④ 改写事件识别 ────────────────────────── */

tests["C611 只有 replace 与 compaction/* 算「改前缀」，尾部 append 不许被算进来"] = (t) => {
  t.eq(rewriteKindsOf([]), [], "空事件流没有改写");
  t.eq(
    rewriteKindsOf([
      { type: "tool/result", surfaceOp: "append" },
      { type: "user/message", surfaceOp: "append", data: { source: { kind: "time-context" } } },
    ]),
    [],
    "纯追加（surfaceOp: append）不改前缀 —— 记进来就重复计费",
  );
  t.eq(
    rewriteKindsOf([{ type: "user/message", surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 }, data: { source: { kind: "compact-checkpoint" } } }]),
    ["replace:user/message:compact-checkpoint"],
    "就地改写要带上是哪条消息（kind 决定是谁干的）",
  );
  t.eq(rewriteKindsOf([{ type: "tool/result", surfaceOp: { op: "replace", startSeq: 9, endSeq: 9 } }]), ["replace:tool/result"], "无 kind 时不留尾冒号");
  t.eq(
    rewriteKindsOf([...compaction(1, 0), { type: "compaction/prune", seq: 4, time: 4, data: { shadowedSeqs: [3] } }]),
    ["compaction/end", "compaction/prune", "compaction/start", "compaction/summary"],
    "折叠事务的四个事件都要认（prune 单独出现也要认）",
  );
};

/* ────────────────────────── ⑤ 受控 lift ────────────────────────── */

tests["C611 受控 lift：同一间隔桶内比较（不控制间隔就会把「轮开始天然间隔长」记到注入头上）"] = (t) => {
  // 长间隔桶里全是"整段失效"，但没有一个带改写 —— 若按全局算 lift 会爆表，按桶算必须为 1x 以下
  const rows = [
    { gapSec: 900, miss: 90_000, prompt: 100_000, rewrites: [] },
    { gapSec: 900, miss: 90_000, prompt: 100_000, rewrites: [] },
    { gapSec: 900, miss: 90_000, prompt: 100_000, rewrites: [] },
  ];
  const lift = controlledLift(rows, (r) => (r.rewrites ?? []).length > 0);
  t.eq(lift, [], "该桶里没有任何带特征的样本 ⇒ 不产出（不许拿别的桶当分母）");

  const mixed = [
    { gapSec: 10, miss: 90_000, prompt: 100_000, rewrites: ["compaction/summary"] },
    { gapSec: 10, miss: 100, prompt: 100_000, rewrites: [] },
    { gapSec: 900, miss: 99_000, prompt: 100_000, rewrites: [] },
  ];
  const l = controlledLift(mixed, (r) => (r.rewrites ?? []).length > 0);
  t.eq(l.length, 1, "只有 10s 桶有样本，只出一行");
  t.eq(l[0].bucket, "5–30s", "桶标签要对");
  t.eq(l[0].rate, 1, "有改写：1/1 整段失效");
  t.eq(l[0].base, 0, "同桶无改写：0/1 失效");
  t.eq(l[0].lift, null, "基线为 0 时 lift 记 null（不许除零成 Infinity）");
};

/* ────────────────────────── ⑥ 会话分布 ────────────────────────── */

tests["C611 会话集中度：基尼 0 = 完全均匀，1 = 全压一个会话"] = (t) => {
  t.eq(gini([10, 10, 10, 10]), 0, "完全均匀必须是 0");
  t.ok(gini([0, 0, 0, 1000]) > 0.7, "全压一个会话必须接近 1");
  t.eq(gini([]), 0, "空输入不许 NaN");
  t.eq(gini([0, 0]), 0, "全零不许 NaN");
  const rows = [
    { session: "a", miss: 90_000, prompt: 100_000, waste: 90_000 },
    { session: "b", miss: 100, prompt: 100_000, waste: 100 },
  ];
  const c = sessionConcentration(rows);
  t.eq(c.sessions, 2, "两个会话");
  t.ok(c.top1 > 0.99, `前 1%（至少 1 个）就是几乎全部 waste（实测 ${c.top1.toFixed(4)}）`);
  t.ok(c.gini > 0, "两个会话差 900 倍，基尼必须为正");
  t.eq(c.top[0].session, "a", "按 waste 降序");
};

/* ────────────────────────── ⑦ C 的判据 ────────────────────────── */

tests["C611 C 的判据：失效率随 prompt 单调上升才叫「上下文太大」，平的就是证伪"] = (t) => {
  const mk = (prompt, drop) => ({ gapSec: 10, prompt, prevPrompt: prompt, miss: drop ? prompt * 0.9 : 10, rewrites: [] });
  // 每桶 ≥ 50 个样本（`sizeTest` 只统计 n≥50 的桶，少于此数一律不进曲线）
  const flat = [...Array(60).fill(0).map(() => mk(20_000, false)), ...Array(60).fill(0).map(() => mk(400_000, false))];
  const flatRes = sizeTest(flat);
  t.eq(flatRes.monotone, true, "全 0 失效率算平（0 >= 0×0.9）");
  const rising = [...Array(60).fill(0).map(() => mk(400_000, false)), ...Array(60).fill(0).map(() => mk(900_000, true))];
  const risingRes = sizeTest(rising);
  t.eq(risingRes.rows.map((r) => r.bucket), ["256–512k", "≥768k"], "两个 prompt 桶");
  t.eq(risingRes.rows.map((r) => r.drop), [0, 60], "大 prompt 桶整段失效");
  t.eq(risingRes.monotone, true, "单调上升 ⇒ C 成立");
  t.ok(risingRes.first === 0 && risingRes.last === 1, "两端分别是 0 与 100%");
};

/* ────────────────────────── ⑧ 端到端夹具 ────────────────────────── */

tests["C611 端到端夹具：多帧 zstd 日志 ⇒ 4 条 none 请求、四桶份额与手算一致、判定 A"] = (t) => {
  const home = tmpHome();
  try {
    writeZstdFixture(home, FIXTURE_EVENTS);
    const scan = scanHome(home, {});
    t.eq(scan.scanned, 1, "扫到 1 个会话");
    t.eq(scan.rows.length, 4, "冷启动不产行、chess-context 请求被排除 ⇒ 恰好 4 条");
    t.eq(
      scan.rows.map((r) => r.seq),
      [5, 7, 11, 20],
      "行必须按 seq 升序且落在正确的请求上",
    );
    t.eq(
      scan.rows.map((r) => r.waste),
      [1_000, 0, 8_000, 9_000],
      "waste 必须逐条等于手算",
    );
    t.eq(
      scan.rows.map((r) => r.growth),
      [0, 2_000, 0, 0],
      "growth 必须逐条等于手算",
    );
    t.eq(
      scan.rows.map((r) => Math.round(r.gapSec)),
      [10, 10, 10, 400],
      "间隔（秒）必须逐条等于手算",
    );

    const sum = decompose(scan.rows);
    t.eq(sum.rows, 4, "4 行");
    t.eq(sum.miss, 20_000, "miss 合计 = 1,000 + 2,000 + 8,000 + 9,000");
    t.eq(sum.growth, 2_000, "必要部分 = 2,000");
    t.eq(sum.waste, 18_000, "waste 合计 = 1,000 + 8,000 + 9,000");
    t.eq(
      BUCKETS.map((k) => sum.buckets[k].n),
      [1, 1, 1, 1],
      "四桶各 1 条（D/B/A/U）",
    );
    t.eq(Math.round(sum.buckets.B.shareOfWaste * 1000) / 10, 44.4, "B 占 waste 44.4%");
    t.eq(Math.round(sum.buckets.A.shareOfWaste * 1000) / 10, 50, "A 占 waste 50.0%");
    t.eq(Math.round(sum.buckets.U.shareOfWaste * 1000) / 10, 5.6, "U 占 waste 5.6%");
    t.eq(verdictOf(sum).code, "A", "A+U = 55.6% ≥ 50% ⇒ 判 A（物理限制）");
    t.eq(
      Math.round(ceilingOf(sum).ceiling * 1e6) / 1e6,
      0.0012,
      "天花板 = B 的 8,000 token × $0.15/M = $0.0012",
    );

    // 反方向：把折叠事务从夹具里删掉，seq=11 那条必须从 B 变成 U（这是"失败分支真红"的执行版）
    const noCompaction = FIXTURE_EVENTS.filter((e) => !String(e.type).startsWith("compaction/"));
    const rows2 = attributeRequests(extractEvents(noCompaction.map((e) => JSON.stringify(e)).join("\n")));
    const at11 = rows2.find((r) => r.seq === 11);
    t.eq(at11.rewrites, [], "删掉折叠事务后 seq=11 期间没有改写事件");
    t.eq(classifyRow({ ...at11, gapSec: at11.gapSec ?? Infinity }), "U", "于是它必须改判 U —— 说明 B 的判据真的在看事件，不是在猜");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

/* ────────────────────────── ⑨ 价目表同源 ────────────────────────── */

tests["C611 价目表与 T45 同源（两边漂移会让两份报告的美元不可比）"] = (t) => {
  t.eq(PRICES, T45_PRICES, "cache-miss-audit 的 PRICES 必须与 cache-friendliness-audit 完全一致");
  t.eq(requestCost({ miss: 1_000_000, hit: 0, out: 0 }), 0.15, "1M miss = $0.15");
  t.eq(requestCost({ miss: 0, hit: 1_000_000, out: 0 }), 0.003, "1M hit = $0.003");
  t.eq(requestCost({ miss: 0, hit: 0, out: 1_000_000 }), 0.6, "1M out = $0.6");
  t.eq(requestCost({}), 0, "空 usage = 0（不许 NaN）");
  t.eq(median([]), 0, "空中位数 = 0（不许 NaN）");
};
