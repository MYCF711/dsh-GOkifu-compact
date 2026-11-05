/**
 * usability-by-age.test.mjs —— 「按折痕年龄分桶」的守卫（T52）
 *
 * 为什么需要（本仓的老规矩）：一个只打印数字的审计脚本，**没有任何东西防它变假**。
 * 这里钉住四件事，每件都配一条「能真红」的反向用例：
 *   ① **分桶逻辑**：边界归右、桶顺序固定、时间不是数要报错；
 *   ② **三档判据**：`not-fixed` / `partial` / `fixed` 三档都能到达（守卫不许永远绿）；
 *   ③ **5 判据的算术**：满分 10、逐项可加、零锚点/长尾巴会被扣分；
 *   ④ **口径与只读**：机械指标必须**从 T33 导入**（不许第二套实现）、脚本**一个字节都不写盘**。
 *
 * 口径为什么必须钉：本仓因为「两套口径」栽过很多次 —— C607（补回 vs 探针）、
 * C638 / C641（两个 filter 比引用）、T26（60.40% 是分母错）。同一个指标写出两份实现，
 * 「791 条」和「791 条」就会变成两个数。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  LANDINGS,
  BUCKET_ORDER,
  NEW_SINCE,
  VERDICT_RULES,
  readGitCommitTime,
  resolveCutPoints,
  bucketOf,
  isNew,
  scoreMark,
  anchorTierOf,
  summarizeBucket,
  compareOldNew,
  verdictOf,
  spanBands,
  tailGapBands,
  groupByBucket,
} from "../scripts/usability-by-age-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "usability-by-age-audit.mjs");
const T33 = nodePath.join(ROOT, "scripts", "summary-usability-audit.mjs");

export const tests = {};

/** 造一个 cut 表（不用真实时间，免得测试跟机器时区/提交历史耦合）。 */
const CUTS = Object.freeze({ T35: 1000, T37: 2000, T50: 3000 });

/** 造一条「什么都好」的 measureSample 形状（字段名必须与 T33 的 measureSample 一致）。 */
function goodMark(over = {}) {
  return {
    at: 2500,
    range: { start: 1, end: 200 },
    chars: 4000,
    ids: 30,
    placeholders: 0,
    traceableShare: 1,
    sectionsPresent: 3,
    sectionsMissing: [],
    endedCleanly: true,
    unknownIds: [],
    outOfRangeLater: [],
    outOfRangeEarlier: [],
    seqMatched: 2,
    seqClaims: 2,
    seqMismatch: [],
    stoppedAt: "n22",
    nextActionCount: 2,
    deadendBullets: 3,
    unverifiedBullets: 2,
    verifiedBullets: 4,
    dupLineCount: 0,
    promptEchoLines: 0,
    toolCallLeak: 0,
    emptyishLines: 0,
    ...over,
  };
}

/* ───────────────────────── ① 分桶逻辑 ───────────────────────── */

tests["T52① 分桶边界归右：at === 提交时刻算「之后」"] = (t) => {
  t.eq(bucketOf(999, CUTS), "pre-T35", "T35 前一毫秒属于老桶");
  t.eq(bucketOf(1000, CUTS), "T35..T37", "T35 提交那一刻起算「之后」（边界归右）");
  t.eq(bucketOf(1999, CUTS), "T35..T37", "T37 前一毫秒还在上一桶");
  t.eq(bucketOf(2000, CUTS), "T37..T50", "T37 提交那一刻起算「之后」");
  t.eq(bucketOf(3000, CUTS), "post-T50", "T50 提交那一刻起算「之后」");
  t.eq(bucketOf(9e12, CUTS), "post-T50", "远未来落在最后一桶");
};

tests["T52① 桶名必须是固定四档（拼错会让统计静默丢行）"] = (t) => {
  t.eq([...BUCKET_ORDER], ["pre-T35", "T35..T37", "T37..T50", "post-T50"], "桶顺序固定");
  const seen = new Set();
  for (const at of [-1, 0, 999, 1000, 1999, 2000, 2999, 3000, 1e12]) seen.add(bucketOf(at, CUTS));
  t.eq([...seen].sort(), [...BUCKET_ORDER].sort(), "任何时间都必须落进这四个桶之一，不许出现第五个名字");
};

tests["T52① 时间不是数必须报错（不许静默算成 pre-T35）"] = (t) => {
  t.throws(() => bucketOf(Number.NaN, CUTS), "NaN 要抛");
  t.throws(() => bucketOf(undefined, CUTS), "undefined 要抛");
  // 反向：合法值不许抛（否则上面的 throws 也可能只是「什么都抛」）
  t.eq(bucketOf(0, CUTS), "pre-T35", "0 是合法时间戳（1970），不许抛");
};

tests["T52① 老/新二分以 T37 为准（Lead 假设点名的就是这条线）"] = (t) => {
  t.eq(NEW_SINCE, "T37", "新折痕的起点必须是 T37");
  t.eq(isNew(1999, CUTS), false, "T37 之前算老");
  t.eq(isNew(2000, CUTS), true, "T37 之后算新");
  t.eq(isNew(9e12, CUTS), true, "越晚越新");
};

tests["T52① groupByBucket 一条都不许丢（丢行 = 分母被悄悄缩小）"] = (t) => {
  const rows = [999, 1000, 2500, 3000].map((at) => ({ measured: { at }, at }));
  const groups = groupByBucket(rows, CUTS);
  const total = Object.values(groups).reduce((n, list) => n + list.length, 0);
  t.eq(total, rows.length, "分组后总数必须等于输入总数");
  t.eq(Object.keys(groups).sort(), [...BUCKET_ORDER].sort(), "四个键都要在（空桶也要在，否则报表缺行）");
  t.eq(groups["post-T50"].length, 1, "3000 落在 post-T50");
};

/* ───────────────────────── ② 分界来自 git ───────────────────────── */

tests["T52② 分界时刻从 git log 现取（不是写死的常量）"] = (t) => {
  const real = readGitCommitTime(LANDINGS[0].sha, { cwd: ROOT });
  t.ok(Number.isFinite(real), `git 读得出 ${LANDINGS[0].sha} 的提交时间（读到 ${real}）`);
  const { cuts, rows } = resolveCutPoints({ cwd: ROOT });
  t.eq(rows.every((row) => row.source === "git"), true, "三条分界都该来自 git");
  t.ok(cuts.T35 < cuts.T37 && cuts.T37 < cuts.T50, "T35 < T37 < T50（顺序反了说明 LANDINGS 被改坏）");
  t.eq(cuts.T35, real, "cuts.T35 就是 git 里那个提交的时间");
};

tests["T52② git 读不到 ⇒ 退回记录值并标 fallback（不许静默）"] = (t) => {
  const fake = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const { rows } = resolveCutPoints({ run: fake });
  t.eq(rows.every((row) => row.source === "fallback"), true, "读不到 git 时三条都要标 fallback");
  t.eq(
    rows.map((row) => row.ms),
    LANDINGS.map((row) => Date.parse(row.at)),
    "fallback 用的是 LANDINGS 里记录的时间",
  );
};

tests["T52② 分界不单调 / 读不出来 ⇒ 直接抛（宁可红，不许出一张顺序错的分桶表）"] = (t) => {
  const flat = () => ({ status: 0, stdout: "1600000000\n", stderr: "" });
  t.throws(() => resolveCutPoints({ run: flat }), "三个提交同一时刻 ⇒ 必须抛（不单调）");
  // 反向：git 吐出垃圾 ⇒ 走 fallback（记录值兜底），不许抛、更不许算出 NaN
  const garbage = () => ({ status: 0, stdout: "not-a-number\n", stderr: "" });
  const fromGarbage = resolveCutPoints({ run: garbage });
  t.eq(fromGarbage.rows.every((row) => row.source === "fallback"), true, "垃圾输出 ⇒ 三条都退记录值");
  t.eq(
    fromGarbage.rows.map((row) => row.ms),
    LANDINGS.map((row) => Date.parse(row.at)),
    "退记录值时不许出 NaN",
  );
  const ok = (cmd, args) => {
    const sha = args[args.length - 1];
    const seconds = sha === LANDINGS[0].sha ? 1000 : sha === LANDINGS[1].sha ? 2000 : 3000;
    return { status: 0, stdout: `${seconds}\n`, stderr: "" };
  };
  const fine = resolveCutPoints({ run: ok });
  t.eq([fine.cuts.T35, fine.cuts.T37, fine.cuts.T50], [1_000_000, 2_000_000, 3_000_000], "正常输入要能算出来（反证上面不是「什么都抛」）");
};

/* ───────────────────────── ③ 三档判据（必须能真红） ───────────────────────── */

tests["T52③ 三档判据：新折痕还有零锚点 ⇒ not-fixed"] = (t) => {
  const v = verdictOf({ newZeroAnchor: 3, oldTraceableRate: 0.5, newTraceableRate: 0.9 });
  t.eq(v.tier, "not-fixed", "零锚点非 0 时，即使可定位率再高也必须判 not-fixed");
  t.includes(v.reason, "0%", "理由要点明「0% 仍在」");
  // 反向：零锚点为 0 时不许被判 not-fixed（否则这一档永远绿）
  t.ne(verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.5, newTraceableRate: 0.9 }).tier, "not-fixed", "零锚点归零就不该是 not-fixed");
};

tests["T52③ 三档判据：涨幅 ≥10pp ⇒ fixed；<10pp ⇒ partial"] = (t) => {
  const fixed = verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.5, newTraceableRate: 0.5 + VERDICT_RULES.minGain });
  t.eq(fixed.tier, "fixed", "恰好 10pp 也算达标（>= 不是 >）");
  t.eq(fixed.gainPp, 10, "涨幅按百分点返回");
  const partial = verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.5, newTraceableRate: 0.55 });
  t.eq(partial.tier, "partial", "只涨 5pp ⇒ 只修掉悬崖");
  const worse = verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.6, newTraceableRate: 0.4 });
  t.eq(worse.tier, "partial", "负增长也算 partial（不是 fixed，也不许变 not-fixed）");
  t.ok(worse.gainPp < 0, "负增长要如实报负数");
};

tests["T52③ 三档判据不许永远绿：三档都要被走到过"] = (t) => {
  const tiers = new Set([
    verdictOf({ newZeroAnchor: 2, oldTraceableRate: 0.4, newTraceableRate: 0.9 }).tier,
    verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.4, newTraceableRate: 0.45 }).tier,
    verdictOf({ newZeroAnchor: 0, oldTraceableRate: 0.4, newTraceableRate: 0.8 }).tier,
  ]);
  t.eq([...tiers].sort(), ["fixed", "not-fixed", "partial"], "三条不同的输入必须给出三个不同的档（否则判据塌成一档）");
};

tests["T52③ 没有老数据可比时不许冒充 fixed"] = (t) => {
  const v = verdictOf({ newZeroAnchor: 0, oldTraceableRate: null, newTraceableRate: 0.7 });
  t.eq(v.tier, "partial", "老桶为空 ⇒ 无从证明「变好」，只能 partial");
  t.eq(v.gainPp, null, "涨幅未知要返回 null，不许拿 0 冒充");
};

/* ───────────────────────── ④ 5 判据的算术 ───────────────────────── */

tests["T52④ 判据满分：5 项各 2 分、总分 10"] = (t) => {
  const score = scoreMark(goodMark());
  t.eq(score.handoff, 2, "四个开关全亮 = 2");
  t.eq(score.traceable, 2, "share=1 = 2");
  t.eq(score.noHallucination, 2, "没有幻觉 = 2");
  t.eq(score.noRedundancy, 2, "没有冗余 = 2");
  t.eq(score.length, 2, "4000 字符在 1000–8000 = 2");
  t.eq(score.total, 10, "总分必须是 10");
};

tests["T52④ 整篇零锚点要被判据抓住（T33 样本 3/5 那种）"] = (t) => {
  const score = scoreMark(goodMark({ ids: 0, placeholders: 42, traceableShare: 0 }));
  t.eq(score.traceable, 0, "0 个真 id ⇒ 可定位 0 分");
  t.ok(score.total < scoreMark(goodMark()).total, "零锚点必须比正常样本分低");
  t.eq(anchorTierOf(0), "bad", "零锚点属于 bad 档");
};

tests["T52④ 冗余/幻觉/长度各扣各的，且都有下限 0"] = (t) => {
  t.eq(scoreMark(goodMark({ dupLineCount: 1 })).noRedundancy, 1.5, "重复行扣 0.5");
  t.eq(scoreMark(goodMark({ toolCallLeak: 1 })).noRedundancy, 1.25, "工具调用泄漏扣 0.75");
  t.eq(scoreMark(goodMark({ dupLineCount: 1, promptEchoLines: 1, toolCallLeak: 1, emptyishLines: 1 })).noRedundancy, 0, "四项全中 = 0（不许负数）");
  t.eq(scoreMark(goodMark({ unknownIds: ["n999"], outOfRangeLater: ["n400"], seqMismatch: ["e1"] })).noHallucination, 0.5, "三处都出问题 = 0.5");
  t.eq(scoreMark(goodMark({ chars: 556 })).length, 1, "556 字符落在 500–1000 档 = 1");
  t.eq(scoreMark(goodMark({ chars: 13210 })).length, 1, "13210 落在 8000–16000 档 = 1");
  t.eq(scoreMark(goodMark({ chars: 300 })).length, 0.5, "太短 = 0.5");
  t.eq(scoreMark(goodMark({ chars: 40000 })).length, 0.5, "太长 = 0.5");
};

tests["T52④ 锚点三档的边界"] = (t) => {
  t.eq(anchorTierOf(0.9), "good", "≥0.9 = good");
  t.eq(anchorTierOf(0.899), "partial", "0.899 = partial");
  t.eq(anchorTierOf(0.3), "partial", "≥0.3 = partial");
  t.eq(anchorTierOf(0.299), "bad", "<0.3 = bad");
  t.eq(anchorTierOf(null), "bad", "没有引用（null）按 bad 算，不许当 good");
};

/* ───────────────────────── ⑤ 汇总的算术 ───────────────────────── */

tests["T52⑤ summarizeBucket：池化率、零锚点率、段齐率、逐项均分"] = (t) => {
  const rows = [
    { measured: goodMark({ ids: 30, placeholders: 10, traceableShare: 0.75 }), score: scoreMark(goodMark({ ids: 30, placeholders: 10, traceableShare: 0.75 })) },
    { measured: goodMark({ ids: 0, placeholders: 30, traceableShare: 0, sectionsPresent: 2 }), score: scoreMark(goodMark({ ids: 0, placeholders: 30, traceableShare: 0 })) },
  ];
  const s = summarizeBucket(rows);
  t.eq(s.n, 2, "分母");
  t.eq(s.ids, 30, "真 id 合计");
  t.eq(s.placeholders, 40, "占位合计");
  t.eq(s.traceableRate, 0.4286, "池化率 = 30/70（不是两条 share 的平均 0.375）");
  t.eq(s.traceableMeanShare, 0.375, "逐条均 = (0.75+0)/2");
  t.eq(s.zeroAnchor, 1, "整篇零锚点 1 条");
  t.eq(s.zeroAnchorRate, 0.5, "零锚点率 50%");
  t.eq(s.sections3Rate, 0.5, "段齐率 50%");
  t.eq(s.total, Math.round(((s.scores.handoff + s.scores.traceable + s.scores.noHallucination + s.scores.noRedundancy + s.scores.length) / 1) * 100) / 100, "总分必须等于 5 项均分之和（可加性）");
};

tests["T52⑤ 空桶不许除零、不许出 NaN"] = (t) => {
  const s = summarizeBucket([]);
  t.eq(s.n, 0, "0 条");
  t.eq(s.traceableRate, null, "没有引用时率记 null（不拿 0 冒充）");
  t.eq(s.total, 0, "总分 0");
  t.eq(Number.isNaN(s.zeroAnchorRate), false, "不许出现 NaN（NaN 会让报表静默变成 0）");
};

tests["T52⑤ compareOldNew 的涨跌按百分点算，且分母各算各的"] = (t) => {
  const rows = [
    { measured: goodMark({ at: 1500, ids: 10, placeholders: 90, traceableShare: 0.1 }), score: scoreMark(goodMark({ traceableShare: 0.1 })) },
    { measured: goodMark({ at: 2500, ids: 90, placeholders: 10, traceableShare: 0.9 }), score: scoreMark(goodMark({ traceableShare: 0.9 })) },
  ];
  const c = compareOldNew(rows, CUTS);
  t.eq(c.old.n, 1, "老桶 1 条");
  t.eq(c.new.n, 1, "新桶 1 条");
  t.eq(c.old.traceableRate, 0.1, "老 10/100");
  t.eq(c.new.traceableRate, 0.9, "新 90/100");
  t.eq(c.gainPp, 80, "涨幅按百分点：80pp");
};

tests["T52⑤ 跨度/离尾部分档：分档器必须把每条折痕分到且只分到一档"] = (t) => {
  const rows = [1, 10, 60, 200, 500].map((span) => ({
    measured: goodMark({ range: { start: 1, end: 1 + span - 1 } }),
    sessionMaxSeq: 1 + span - 1,
  }));
  for (const bands of [spanBands(rows), tailGapBands(rows)]) {
    t.eq(bands.reduce((n, b) => n + b.n, 0), rows.length, `分档合计必须等于输入条数（否则有折痕被静默漏掉）`);
  }
  t.eq(spanBands(rows)[0].n, 1, "span=1 落进「1 事件」");
  t.eq(tailGapBands(rows)[0].n, 5, "这 5 条都折到会话尾部 ⇒ 全在 gap=0 档");
};

/* ───────────────────────── ⑥ 口径与只读（源码级守卫） ───────────────────────── */

tests["T52⑥ 机械指标必须从 T33 导入（不许第二套实现）"] = (t) => {
  const src = nodeFs.readFileSync(SCRIPT, "utf8");
  t.includes(src, 'from "./summary-usability-audit.mjs"', "必须 import T33 的模块");
  t.includes(src, "measureSample", "必须复用 T33 的 measureSample");
  t.includes(src, "resolveHome", "DSH_HOME 解析也必须复用 T33 那一份");
  // 反向：不许在脚本里自己再写一遍 id 提取/占位符统计（那就是第二套口径）
  t.notIncludes(src, "findUnknownIds", "不要在本地重算幻觉 id（用 measureSample 已经算好的字段）");
  t.notIncludes(src, "[ne]\\?", "不要在本地重数 n?/e?（正则会和 T33 分叉）");
};

tests["T52⑥ 归档脚本必须纯只读：源码里不许出现任何写盘调用"] = (t) => {
  const src = nodeFs.readFileSync(SCRIPT, "utf8");
  for (const banned of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "createWriteStream", "unlinkSync"]) {
    t.notIncludes(src, banned, `审计脚本不许写盘（出现 ${banned} 就说明它不是只读的）`);
  }
  // 反向：读盘必须真的在（否则上面那条「没有写」可能只是「什么都没有」）
  t.includes(src, "readFileSync", "必须确实读棋谱");
};

tests["T52⑥ T33 的脚本不许被改（基线必须还在、还会被 import）"] = (t) => {
  t.eq(nodeFs.existsSync(T33), true, "T33 的脚本必须在");
  const src = nodeFs.readFileSync(T33, "utf8");
  t.includes(src, "export function measureSample", "T33 的 measureSample 必须还在（被我们复用）");
  t.includes(src, "export function resolveHome", "T33 的 resolveHome 必须还在");
  t.includes(src, "FROZEN_SAMPLE_SESSIONS", "冻结样本集必须还在（校准要用）");
  t.notIncludes(src, "usability-by-age", "不许反向依赖：T33 不能 import 本脚本（否则分界会成环）");
  const mine = nodeFs.readFileSync(SCRIPT, "utf8");
  t.includes(mine, "FROZEN_SAMPLE_SESSIONS", "本脚本必须用 T33 的冻结样本集做校准");
};
