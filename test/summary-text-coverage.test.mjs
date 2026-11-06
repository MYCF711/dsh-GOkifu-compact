/**
 * summary-text-coverage.test.mjs —— 摘要正文**每条写回点都要落**，且**只落一份**（C643 / T29）
 *
 * 由来（C643 交付时报的，Lead 确认要修）：C642 只让**离线补折**（`src/rooms/offline-fold.mjs` 的
 * `applyOfflineFoldToGraph`）落 `foldMark.summaryText`，而 foldMark 还有别的写回点（`src/engine.mjs`）：
 *   · `compactIfNeeded` —— pressure / auto / context-overflow / archive / backfill / disposed / loop；
 *   · `recordFoldMark` —— 手动 `/compact`。
 * 真机 2026-11-04T22:02:10.932Z 那条 pressure 折痕只有 `summaryChars: 2418`、**没有正文** ⇒
 * doctor 那句「新折痕起为 0」只对 archive-offline 成立，对其余路径是**假承诺**。
 *
 * 本文件钉住三件事（任何一条被回退，这里先红）：
 *   ① 两条写回点都要落 `summaryText`（用引擎已有的 `_lastSummaryText`，不重算）；
 *   ② **同一份正文在图里只许出现一次** —— 别处已存同一份就只留 `summaryTextRef` 引用；
 *   ③ `tier2` **不写**（它的正文是两段已落摘要的合并，再存一份 = 复制），
 *      而 doctor / 覆盖率审计的文案**不许**把它写成「没有摘要正文」—— 真机 27/27 条 tier2
 *      折痕都有 `summaryChars`（1,504–4,017 字符），那是「不落盘」，不是「没有」。
 *
 * 夹具复用 `engine-harness.test.mjs` 的假 engine（同一套 stub 与假 session）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { load, makeSession, makeCtx } from "./engine-harness.test.mjs";
import { BODY_PATHS, C642_AT, NO_BODY_PATHS, collectCoverage, verdictOf } from "../scripts/summary-text-coverage-audit.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ENGINE = nodePath.join(HERE, "..", "src", "engine.mjs");
const DOCTOR = nodePath.join(HERE, "..", "scripts", "doctor.mjs");
const NL = String.fromCharCode(10);

/** 一份「有正文」的摘要（带 id 与失败边，跟真机产物同形）。 */
const SUMMARY = ["## 目标", "- 硬约束：不要动 prod 配置。", "## 已探明死路", '- e1 "npm test" → ERR_EACCES (evidence seq 2-3)'].join(NL);

/** 子串出现次数（用来证明「同一份正文只存了一遍」）。 */
const countOf = (haystack, needle) => String(haystack).split(needle).length - 1;

/** 在 surface 上放 n 个普通节点（保证有可压内容）。 */
function pushPlain(session, n) {
  for (let i = 0; i < n; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
}

/** 读**内存里**的图 —— foldMarks 常落在增量里，只读 graph.json 会看不到刚追加的那条。 */
function graphOf(engine, session) {
  const g = engine.graphs.get(session.id);
  if (g === undefined) throw new Error("图还没建（该先跑一次 fold 或 recordFoldMark）");
  return g;
}

function newEngine({ Engine, graphDir }, name, extra = {}) {
  const session = makeSession({ id: `sess-${name}` });
  const ctx = makeCtx({ measureTotal: () => 300_000 });
  const engine = new Engine(ctx, {
    graphDir: nodePath.join(graphDir, name),
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    // tier-2 单独有测试（`test/tier2.test.mjs`）；这里关掉，别让它在 pressure 用例里多跑一次折叠。
    tier2After: 0,
    ...extra,
  });
  return { session, ctx, engine };
}

tests["T29-1 pressure 折痕必须落 summaryText（C642 只补了 archive-offline 那条）"] = async (t) => {
  const harness = await load();
  const { session, engine } = newEngine(harness, "t29-pressure");
  pushPlain(session, 19);
  // 真实流程里 summarize() 会留下 pending 摘要文本；假 engine 的 compactRegion 不跑 summarize，
  // 所以直接给（与 C14 用例同一处理方式）。
  engine._lastSummaryText = SUMMARY;
  engine._lastSummaryChars = SUMMARY.length;
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  t.ok(result !== null && result !== undefined, "300k 读入 + 阈值 90k ⇒ 必须 fold 一次");
  const mark = (graphOf(engine, session).foldMarks ?? []).at(-1);
  t.eq(mark?.trigger, "pressure", "foldMark.trigger 必须是 pressure");
  t.eq(mark?.summaryText, SUMMARY, "pressure 折痕必须带正文（否则三个审计器只能报「不可复判」）");
  t.eq(mark?.summaryChars, SUMMARY.length, "summaryChars 与正文必须同时存在且对得上");
  t.eq(Object.hasOwn(mark ?? {}, "summaryTextRef"), false, "别处没有同一份正文，就不该写引用");
};

tests["T29-2 手动 /compact（recordFoldMark）折痕必须落 summaryText"] = async (t) => {
  const harness = await load();
  const { session, engine } = newEngine(harness, "t29-manual");
  engine._lastSummaryText = SUMMARY;
  engine._lastSummaryChars = SUMMARY.length;
  const mark = engine.recordFoldMark(session, { range: { start: 2, end: 4 }, trigger: "manual" });
  t.eq(mark.trigger, "manual", "trigger 必须是 manual");
  t.eq(mark.summaryText, SUMMARY, "手动 /compact 也必须落正文（它同样跑过摘要）");
  t.eq(mark.summaryChars, SUMMARY.length, "summaryChars 与正文必须对得上");
};

tests["T29-3 没有正文时一个字段都不写（别用空串冒充「有正文」）"] = async (t) => {
  const harness = await load();
  const { session, engine } = newEngine(harness, "t29-empty");
  const mark = engine.recordFoldMark(session, { range: { start: 2, end: 4 }, trigger: "manual" });
  t.eq(Object.hasOwn(mark, "summaryText"), false, "正文为空时**不许**写 summaryText（空串会骗出假的 100% 覆盖率）");
  t.eq(Object.hasOwn(mark, "summaryTextRef"), false, "正文为空时也不许写引用");
  t.eq(mark.summaryChars, null, "没有摘要 ⇒ summaryChars 记 null（「不知道」不是 0）");
};

tests["T29-4 同一份正文只许出现一次：lastOfflineSummary 已有 ⇒ 只留引用"] = async (t) => {
  const harness = await load();
  const { session, engine } = newEngine(harness, "t29-ref");
  const BODY = ["## 目标", "- 硬约束：不要动 prod 配置。"].join(NL);
  // 先建图（这条 mark 不带正文），再把「同一段同一份正文」放进单槽的 lastOfflineSummary。
  engine.recordFoldMark(session, { range: { start: 1, end: 1 }, trigger: "manual" });
  const g = graphOf(engine, session);
  g.lastOfflineSummary = { at: Date.now(), range: { start: 2, end: 4 }, text: BODY };
  engine._lastSummaryText = BODY;
  engine._lastSummaryChars = BODY.length;
  const mark = engine.recordFoldMark(session, { range: { start: 2, end: 4 }, trigger: "manual" });
  t.eq(mark.summaryTextRef, "lastOfflineSummary", "同一段同一份正文已在别处 ⇒ 必须只留引用");
  t.eq(Object.hasOwn(mark, "summaryText"), false, "有引用就不许再存副本");
  // 硬约束的机器判据：整张图（JSON）里这份正文只出现一次。
  t.eq(countOf(JSON.stringify(g), JSON.stringify(BODY).slice(1, -1)), 1, "同一份正文在图里只许出现一次（重复 = 磁盘成本翻倍）");
};

tests["T29-5 tier2 不落 summaryText（而它不是「没有正文」，是「不重复写」）"] = (t) => {
  const lines = nodeFs.readFileSync(ENGINE, "utf8").split(NL);
  const at = lines.findIndex((line) => line.includes('trigger: "tier2"') && line.includes("foldMarks.push("));
  t.eq(at >= 0, true, "必须找到 tier2 的 foldMarks.push");
  const line = at >= 0 ? lines[at] : "";
  t.eq(line.includes("summaryTextField("), false, "tier2 不许落 summaryText（正文是两段已落摘要的合并 ⇒ 复制）");
  t.eq(/\bsummaryText\b\s*[:,]/.test(line), false, "tier2 不许写 summaryText 字段（别为了「统一」编一个空串）");
  t.includes(line, "summaryChars", "summaryChars 仍要记 —— 否则连「有没有正文」都看不出来");
  const above = lines.slice(Math.max(0, at - 6), Math.max(0, at)).join(NL);
  t.includes(above, "NO_BODY_PATHS", "注释必须写明「缺正文是设计」，否则下一个人会来「修」它");
  t.includes(above, "不是「没有摘要正文」", "必须纠正错误前提：tier2 有正文（真机 27/27 条都有 summaryChars），只是不重复写");
};

tests["T29-6 doctor 那句不许留假承诺，覆盖率判据表要与写回点同源"] = (t) => {
  const doctor = nodeFs.readFileSync(DOCTOR, "utf8");
  t.includes(doctor, "新折痕起为 0", "保真度段必须回答「新折痕还缺不缺正文」");
  t.includes(doctor, "tier2 除外", "必须点名唯一的例外");
  t.includes(doctor, "不重复写", "例外原因要写成「合并 / 复制」");
  t.eq(doctor.includes("它没有摘要正文"), false, "不许把 tier2 说成「没有摘要正文」—— 真机 27/27 条都有 summaryChars");
  // 「该有正文」的路径一条都不能漏（漏了 = 那条写回点没人守）
  for (const trigger of ["pressure", "auto", "context-overflow", "archive", "backfill", "disposed", "loop", "manual", "archive-offline"]) {
    t.eq(Object.hasOwn(BODY_PATHS, trigger), true, `BODY_PATHS 缺 ${trigger}（该路径的折痕会静默失去正文）`);
  }
  t.eq(Object.hasOwn(NO_BODY_PATHS, "tier2"), true, "tier2 必须列进 NO_BODY_PATHS（混进分母 ⇒ 覆盖率永远到不了 100%，指标失去判别力）");
  t.eq(String(NO_BODY_PATHS.tier2).includes("没有摘要正文"), false, "NO_BODY_PATHS 的理由也不许写成「没有摘要正文」");
};

tests["T29-7 覆盖率审计：按 trigger × 时间桶算对（C642 之后才算欠账）"] = (t) => {
  const dir = nodePath.join(HERE, ".harness", "t29-audit", "sessions");
  nodeFs.rmSync(dir, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(dir, "s1"), { recursive: true });
  const after = C642_AT + 1_000;
  const before = C642_AT - 86_400_000;
  const marks = [
    // C642 之后：该有正文的都有，tier2 没有（设计）
    { at: after, seqStart: 1, seqEnd: 2, trigger: "pressure", summaryChars: 10, summaryText: "0123456789" },
    { at: after, seqStart: 3, seqEnd: 4, trigger: "manual", summaryChars: 10, summaryText: "abcdefghij" },
    { at: after, seqStart: 5, seqEnd: 6, trigger: "tier2", summaryChars: 10 },
    // C642 之前：老 producer 只落了字数（历史，永远补不回来，不算欠账）
    { at: before, seqStart: 7, seqEnd: 8, trigger: "pressure", summaryChars: 10 },
  ];
  nodeFs.writeFileSync(
    nodePath.join(dir, "s1", "graph.json"),
    JSON.stringify({ version: 1, sessionId: "s1", nodes: {}, edges: {}, order: [], foldMarks: marks }),
    "utf8",
  );
  const stats = collectCoverage({ sessionsDir: dir });
  t.eq(stats.sessions, 1, "扫到 1 个会话");
  t.eq(stats.byTrigger.pressure.after.marks, 1, "C642 之后 pressure 有 1 条");
  t.eq(stats.byTrigger.pressure.after.text, 1, "C642 之后的 pressure 折痕必须算「有正文」");
  t.eq(stats.byTrigger.pressure.before.charsOnly, 1, "C642 之前的老折痕要落进「只有字数」桶");
  t.eq(stats.byTrigger.tier2.after.charsOnly, 1, "tier2 没有正文 ⇒ 落在「只有字数」");
  t.eq(stats.totals.after.marks, 3, "C642 之后共 3 条（时间分桶按 at 判，不按顺序猜）");
  t.eq(stats.totals.before.marks, 1, "C642 之前共 1 条");
  t.eq(verdictOf("pressure", stats.byTrigger.pressure).level, "ok", "该有正文且 100% ⇒ ok");
  t.eq(verdictOf("manual", stats.byTrigger.manual).level, "ok", "manual 同样 100%");
  t.eq(verdictOf("tier2", stats.byTrigger.tier2).level, "n/a", "tier2 是设计，不是欠账（不许算进分母）");
};
