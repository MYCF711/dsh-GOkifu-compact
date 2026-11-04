#!/usr/bin/env node
/**
 * summary-text-coverage-audit.mjs —— **按写回点统计「摘要正文到底落没落」**（C643/T29）
 *
 * 由来（C643 交付时报的，Lead 确认要修）：
 *   C642 只让**离线补折**（`src/rooms/offline-fold.mjs` 的 `applyOfflineFoldToGraph`）落
 *   `foldMark.summaryText`，而 foldMark 还有**别的写回点**（`src/engine.mjs`）：
 *     · `compactIfNeeded` —— `pressure` / `auto` / `context-overflow` / `archive` / `backfill` /
 *       `disposed` / `loop` 全走这一条；
 *     · `recordFoldMark` —— 手动 `/compact`（`trigger: "manual"`）；
 *     · `#tier2IfNeededUnsafe` —— `trigger: "tier2"`，**不调模型、没有摘要正文**。
 *   真机证据（doctor 22:02:10.932Z 那条 pressure 折痕，在 C642 提交之后）：只有
 *   `summaryChars: 2418`、**没有正文** ⇒ doctor 那句「新折痕起为 0」只对 archive-offline 成立，
 *   对其余路径是**假承诺**。
 *
 * 这个脚本把「差多少」先量出来（**先量，再改**），并且**只读**：
 *   ① 按 `trigger` 拆：每条路径的折痕数、其中有正文的条数（覆盖率）；
 *   ② 按时间分桶：**C642 之前 vs 之后** —— 老折痕没有正文是历史（生产者早于 C642），
 *      新折痕没有正文才是**缺陷**。不分桶的话两个数混在一起，修没修看不出来；
 *   ③ 结论：**哪条路径还没落**（该有正文却 0 覆盖）；
 *   ④ 写回点对照表：每个 trigger 对应源码哪一行、它**该不该**有正文。
 *
 * 正文从哪来：**只有一个实现** —— `summary-persistence-audit.mjs` 的 `summaryTextFor`
 * （`mark.summaryText` 优先，其次 `lastOfflineSummary` **区间全等**才认）。生产写回点、三个审计器、
 * 本脚本共用这一份口径；口径再写一遍就会像 C587 那样「写侧改名、读侧还是老名字」。
 *
 * 用法：
 *   node scripts/summary-text-coverage-audit.mjs                        # 默认 DSH_HOME
 *   node scripts/summary-text-coverage-audit.mjs --home D:/x/home       # 换 home
 *   node scripts/summary-text-coverage-audit.mjs --sessions <dir>       # 直接指 sessions 目录
 *   node scripts/summary-text-coverage-audit.mjs --json                 # 机读
 *   node scripts/summary-text-coverage-audit.mjs --strict               # 该有正文的路径未 100% ⇒ 退出码 1
 *
 * 退出码：0 = 统计跑完；1 = 一张图都读不到（home 指错了），或 `--strict` 下有路径欠正文。
 * 边界：**只读**。不写盘、不改图、不调模型、不 commit、不重启。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";
import { SUMMARY_TEXT_SINCE, resolveHome, summaryTextFor } from "./summary-persistence-audit.mjs";

/**
 * C642 的提交时间（`git log -1 --format=%ct 10d2196` = 1793829593 = 2026-11-05 05:59:53 +08:00）。
 *
 * 为什么用它当分界线：C642 是「正文落盘」那一版代码生效的时刻。**之前**的折痕没有正文是历史
 * （生产者早于 C642，永远补不回来）；**之后**的折痕没有正文 = 那条路径的写回点漏了 —— 两种数
 * 混在一起看，修没修就看不出来。
 */
export const C642_AT = Date.UTC(2026, 10, 4, 21, 59, 53);

/**
 * **该有摘要正文**的路径（写回点 + 出处）。
 *
 * 判据是「这次折叠真的跑过摘要模型」—— 只有它们才有正文可落。
 * 少一条 = 那个写回点漏了；多一条 = 会把「没有正文」的路径判成缺陷（`tier2` 就是这么来的）。
 */
export const BODY_PATHS = Object.freeze({
  pressure: "src/engine.mjs compactIfNeeded（到阈值）",
  auto: "src/engine.mjs compactIfNeeded（自动）",
  "context-overflow": "src/engine.mjs compactIfNeeded（已溢出、被迫自救）",
  archive: "src/engine.mjs compactIfNeeded（归档收尾）",
  backfill: "src/engine.mjs compactIfNeeded（补账）",
  disposed: "src/engine.mjs compactIfNeeded（会话销毁前收尾）",
  loop: "src/engine.mjs compactIfNeeded（检测到思考死循环）",
  manual: "src/engine.mjs recordFoldMark（手动 /compact）",
  "archive-offline": "src/rooms/offline-fold.mjs applyOfflineFoldToGraph（C642 已落）",
});

/**
 * **不单独存正文**的路径 —— 覆盖率恒 0 且**不是缺陷**。
 *
 * 列在这里是为了让「有正文 32%」不会被误读成「另外 68% 都坏了」：分母里混着一条天生不存正文的
 * 路径时，任何覆盖率都永远到不了 100%，于是指标失去判别力（假 100% 与假 0% 是同一个错的两种写法）。
 *
 * ★ 措辞是**量出来的**，不是照抄派单：tier2 折痕**有**正文（真机 27/27 条都有 summaryChars
 * 1,504–4,017 字符，quality 就是拿它算的），只是这份正文是「两段已落盘摘要的重新合并」，
 * 再存一份 = 同一份内容在图里出现两遍以上 ⇒ 按「同一份正文只许出现一次」的硬约束不落盘
 * （见 `src/engine.mjs` 里 tier2 写回处的注释）。
 */
export const NO_BODY_PATHS = Object.freeze({
  tier2: "tier2 合并：正文是把两段**已落盘**的摘要重新合并（C206），再存一份 = 复制，按硬约束不写；summaryChars/quality 仍在",
});

/** 一条折痕属于哪个时间桶（C642 之前 / 之后）—— 没有 `at` 的老记录单列，不猜。 */
function bucketOf(mark) {
  const at = Number(mark?.at);
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  return at >= C642_AT ? "after" : "before";
}

const emptyBucket = () => ({ marks: 0, text: 0, ref: 0, charsOnly: 0, neither: 0, chars: 0 });
const addInto = (bucket, resolved, chars) => {
  bucket.marks += 1;
  if (resolved.text !== null) {
    if (resolved.source === "mark") bucket.text += 1;
    else bucket.ref += 1;
    bucket.chars += resolved.text.length;
  } else if (Number.isFinite(chars) && chars > 0) {
    bucket.charsOnly += 1;
    bucket.chars += chars;
  } else {
    bucket.neither += 1;
  }
};

/**
 * 扫全部会话，按 `trigger` × 时间桶统计正文覆盖。
 *
 * @param {{home?:string, sessionsDir?:string}} [options]
 * @returns {object}
 */
export function collectCoverage({ home = resolveHome(), sessionsDir = null } = {}) {
  const dir = sessionsDir ?? nodePath.join(home, "chess-context", "sessions");
  const names = nodeFs.existsSync(dir) ? nodeFs.readdirSync(dir).sort() : [];
  /** trigger → { all, before, after, unknown } */
  const byTrigger = {};
  const bad = [];
  const totals = { all: emptyBucket(), before: emptyBucket(), after: emptyBucket(), unknown: emptyBucket() };
  let sessions = 0;
  let sessionsWithMarks = 0;

  const bucketFor = (trigger) => {
    byTrigger[trigger] = byTrigger[trigger] ?? { all: emptyBucket(), before: emptyBucket(), after: emptyBucket(), unknown: emptyBucket() };
    return byTrigger[trigger];
  };

  for (const name of names) {
    const file = nodePath.join(dir, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    sessions += 1;
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
      const trigger = String(mark?.trigger ?? "null");
      const resolved = summaryTextFor(graph, mark);
      const chars = Number(mark?.summaryChars);
      const per = bucketFor(trigger);
      const where = bucketOf(mark);
      addInto(per.all, resolved, chars);
      addInto(per[where], resolved, chars);
      addInto(totals.all, resolved, chars);
      addInto(totals[where], resolved, chars);
    }
  }

  return { home, sessionsDir: dir, sessions, sessionsWithMarks, byTrigger, totals, bad };
}

/* ────────────────────────────────── 输出 ────────────────────────────────── */

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "—");
const pct = (part, whole) => (Number(whole) > 0 ? `${((Number(part) / Number(whole)) * 100).toFixed(1)}%` : "—");
const when = (ms) => new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");

/** 覆盖率（有正文 / 折痕）—— 分母为 0 时给 null，不拿 0 冒充。 */
const coverage = (b) => (b.marks === 0 ? null : b.text + b.ref);

/**
 * 一条路径的判词：该有正文吗？实测落了没有？
 *
 * @param {string} trigger
 * @param {{all:object, before:object, after:object}} per
 * @returns {{level:"ok"|"gap"|"n/a"|"legacy", text:string}}
 */
export function verdictOf(trigger, per) {
  if (Object.hasOwn(NO_BODY_PATHS, trigger)) {
    return { level: "n/a", text: `**不单独存正文**（${NO_BODY_PATHS[trigger]}）—— 覆盖率恒 0，不是缺陷` };
  }
  const all = per.all;
  if (all.marks === 0) return { level: "n/a", text: "本机没有这条路径的折痕，无从判断" };
  const after = per.after;
  if (after.marks === 0) {
    return { level: "legacy", text: `C642 之后没有折痕（${fmt(all.marks)} 条全是历史，生产者早于 ${SUMMARY_TEXT_SINCE}）—— 未验证` };
  }
  const covered = coverage(after);
  if (covered === after.marks) {
    return { level: "ok", text: `C642 之后 ${fmt(after.marks)}/${fmt(after.marks)} 条有正文 ✓` };
  }
  return {
    level: "gap",
    text:
      `**还没落**：C642 之后 ${fmt(after.marks)} 条里只有 ${fmt(covered)} 条有正文` +
      `（${fmt(after.charsOnly)} 条只有 summaryChars=${fmt(after.chars)}）`,
  };
}

/** 渲染成人读的报告（验收要的就是这一段）。 */
export function render(stats) {
  const s = stats;
  const out = [];
  out.push("== 摘要正文覆盖率审计（按写回点 · 只读 · 零模型调用）==");
  out.push(`   home         ${s.home}`);
  out.push(`   sessions     ${s.sessionsDir}`);
  out.push(`   扫了         ${fmt(s.sessions)} 个会话 · ${fmt(s.totals.all.marks)} 条 foldMark（其中 ${fmt(s.sessionsWithMarks)} 个会话有折痕）`);
  out.push(`   分界线       ${when(C642_AT)}（${SUMMARY_TEXT_SINCE} 提交时间；之后的折痕没正文才是缺陷）`);
  if (s.bad.length > 0) out.push(`   读不动       ${s.bad.map((b) => `${b.session}（${b.error}）`).join(" · ")}`);
  out.push("");

  const triggers = Object.entries(s.byTrigger).sort((a, b) => b[1].all.marks - a[1].all.marks);
  const wTrig = Math.max(7, ...triggers.map(([k]) => k.length));

  out.push("── ① 按 trigger：谁落了正文，谁只落了字数 ──────────────────────────────");
  out.push(`   ${"trigger".padEnd(wTrig)}  ${"折痕".padStart(6)} ${"有正文".padStart(7)} ${"引用".padStart(6)} ${"只有字数".padStart(9)} ${"都没有".padStart(7)} ${"覆盖率".padStart(8)}`);
  for (const [trigger, per] of triggers) {
    const b = per.all;
    out.push(
      `   ${trigger.padEnd(wTrig)}  ${String(fmt(b.marks)).padStart(6)} ${String(fmt(b.text)).padStart(7)} ${String(fmt(b.ref)).padStart(6)} ` +
        `${String(fmt(b.charsOnly)).padStart(9)} ${String(fmt(b.neither)).padStart(7)} ${pct(coverage(b), b.marks).padStart(8)}`,
    );
  }
  const t = s.totals.all;
  out.push(`   ${"合计".padEnd(wTrig)}  ${String(fmt(t.marks)).padStart(6)} ${String(fmt(t.text)).padStart(7)} ${String(fmt(t.ref)).padStart(6)} ` +
    `${String(fmt(t.charsOnly)).padStart(9)} ${String(fmt(t.neither)).padStart(7)} ${pct(coverage(t), t.marks).padStart(8)}`);
  out.push("   「引用」= 正文存在 lastOfflineSummary 里、本条只留区间引用（最后一段，不复制副本）");
  out.push("   「只有字数」= summaryChars 有值、正文没存 ⇒ **不可复判**（想判「模型写没写那段」时只能说不知道）");
  out.push("");

  out.push(`── ② 时间分桶：${SUMMARY_TEXT_SINCE} 之前 vs 之后 ─────────────────────────────`);
  const bkt = (label, b) =>
    `   ${label.padEnd(10)} ${String(fmt(b.marks)).padStart(6)} 条 · 有正文 ${fmt(b.text)}（${pct(b.text, b.marks)}）· 引用 ${fmt(b.ref)}` +
    ` · 只有字数 ${fmt(b.charsOnly)} · 都没有 ${fmt(b.neither)}`;
  out.push(bkt("之前", s.totals.before));
  out.push(bkt("之后", s.totals.after));
  if (s.totals.unknown.marks > 0) out.push(bkt("没有 at", s.totals.unknown));
  out.push("   ⇒ 老折痕缺正文 = 历史（生产者早于 C642，永远补不回来）；新折痕缺正文 = 写回点漏了。");
  out.push("");
  out.push(`   ${"trigger".padEnd(wTrig)}  ${"之前 折痕/有正文".padStart(16)}  ${"之后 折痕/有正文".padStart(16)}  ${"之后覆盖率".padStart(10)}`);
  for (const [trigger, per] of triggers) {
    out.push(
      `   ${trigger.padEnd(wTrig)}  ${`${fmt(per.before.marks)} / ${fmt(coverage(per.before) ?? 0)}`.padStart(16)}  ` +
        `${`${fmt(per.after.marks)} / ${fmt(coverage(per.after) ?? 0)}`.padStart(16)}  ${pct(coverage(per.after), per.after.marks).padStart(10)}`,
    );
  }
  out.push("");

  out.push("── ③ 结论：哪条路径还没落 ────────────────────────────────────────────");
  const gaps = [];
  const ok = [];
  const na = [];
  for (const [trigger, per] of triggers) {
    const v = verdictOf(trigger, per);
    if (v.level === "gap") gaps.push([trigger, v]);
    else if (v.level === "ok") ok.push([trigger, v]);
    else na.push([trigger, v]);
  }
  // 该有正文、本机却一条折痕都没有的路径 —— 也是覆盖缺口（只是没数据可证）
  for (const trigger of Object.keys(BODY_PATHS)) {
    if (s.byTrigger[trigger] === undefined) na.push([trigger, { level: "n/a", text: "本机没有这条路径的折痕，无从判断" }]);
  }
  for (const [trigger, v] of gaps) out.push(`   ✗ ${trigger.padEnd(wTrig)}  ${v.text}`);
  for (const [trigger, v] of ok) out.push(`   ✓ ${trigger.padEnd(wTrig)}  ${v.text}`);
  for (const [trigger, v] of na) out.push(`   · ${trigger.padEnd(wTrig)}  ${v.text}`);
  out.push("");
  out.push(`   ⇒ 该有正文的路径 ${Object.keys(BODY_PATHS).length} 条：**${ok.length} 条已落 · ${gaps.length} 条欠账**；` +
    `另有 ${Object.keys(NO_BODY_PATHS).length} 条天生没有正文（${Object.keys(NO_BODY_PATHS).join(" / ")}），不进分母。`);
  out.push("");

  out.push("── ④ 写回点对照（代码在哪 · 该不该有正文）────────────────────────────────");
  for (const [trigger, site] of Object.entries(BODY_PATHS)) {
    const per = s.byTrigger[trigger];
    const v = per === undefined ? { level: "n/a", text: "无折痕" } : verdictOf(trigger, per);
    const mark = v.level === "ok" ? "✓" : v.level === "gap" ? "✗" : "·";
    out.push(`   ${mark} ${trigger.padEnd(wTrig)}  ${site}`);
  }
  for (const [trigger, why] of Object.entries(NO_BODY_PATHS)) {
    out.push(`   · ${trigger.padEnd(wTrig)}  ${why}`);
  }
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  // `--name=value` 与 `--name value` 两种写法都认（前者给脚本/CI，后者给人手敲）。
  const flag = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return null;
    const next = argv[at + 1];
    return next !== undefined && !next.startsWith("--") ? next : "";
  };
  const home = flag("home") || resolveHome();
  const sessionsDir = flag("sessions") || null;
  const stats = collectCoverage({ home, sessionsDir });
  if (flag("json") !== null) {
    console.log(JSON.stringify({ c642At: C642_AT, summaryTextSince: SUMMARY_TEXT_SINCE, bodyPaths: BODY_PATHS, noBodyPaths: NO_BODY_PATHS, ...stats }, null, 1));
  } else {
    console.log(render(stats));
  }
  if (stats.sessions === 0) return 1;
  if (flag("strict") !== null) {
    const gaps = Object.entries(stats.byTrigger).filter(([trigger, per]) => verdictOf(trigger, per).level === "gap");
    if (gaps.length > 0) {
      if (flag("json") === null) {
        console.log(`\n✗ --strict：${gaps.map(([trigger]) => trigger).join(" / ")} 在 ${SUMMARY_TEXT_SINCE} 之后仍有折痕没有正文。`);
      }
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
