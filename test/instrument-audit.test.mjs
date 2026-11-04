/**
 * instrument-audit.test.mjs —— 「折叠证据字段」判据的回归（2026-11-05，C608）
 *
 * 这个测试要钉住的是**判据本身**，不是某个数：
 *
 *   ① **来路 → 该不该有**：`graph.foldMarks` 有四个写入点，字段集不同。离线补折
 *      （`offline-fold.mjs:808`）只写 `route.model` + `truncated`；tier-2 不调模型；
 *      手动 `/compact`（`recordFoldMark`）只写 `finishReason`。把这些算进分母，
 *      就会在「最近 10 条全是离线补折」时得出**反的结论**（真机 2026-11-05 03:1x 就是这么红的）。
 *   ② **旧判据必须真红**：同一个夹具，旧口径（分母=全部、只读 `usage.model`）判「仪器没生效」，
 *      新口径判「判据错」。少了这条断言，「改判据」和「为了变绿而放水」就分不开。
 *   ③ **真缺仍然要红**：模型路径上少写一个字段，新判据也必须报「仪器没生效」。
 *      否则等于把检查改成永真 —— 那是另一种假绿。
 *   ④ **落点认两个**（C604）：`usage.model` 缺但 `route.model` 在 ⇒ 不算缺。
 *
 * 黑盒部分直接跑 `scripts/doctor.mjs`（DSH_HOME 指向夹具）与 `scripts/instrument-audit.mjs`：
 * 判据是给这两个程序用的，只测函数不算测到。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  C398_LANDED_AT,
  VERDICT,
  foldEvidenceExpectation,
  hasExpectedEvidence,
  legacyEvidence,
  summarizeFoldEvidence,
} from "../scripts/instrument-audit.mjs";

export const tests = {};

const REPO = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = nodePath.join(REPO, "scripts", "instrument-audit.mjs");
const DOCTOR = nodePath.join(REPO, "scripts", "doctor.mjs");

/** C398 之后的一个时刻（用来表示「写入点已经装了这三个字段」）。 */
const AFTER_C398 = C398_LANDED_AT + 60 * 60 * 1000;
const BEFORE_C398 = C398_LANDED_AT - 60 * 60 * 1000;

/** 造一条 foldMark。默认 = 模型路径、三个字段齐全、C398 之后。 */
function makeMark(over = {}) {
  const base = {
    at: over.at ?? AFTER_C398,
    seqStart: 1,
    seqEnd: 9,
    trigger: "pressure",
    shadowedTokens: 1000,
    measuredBefore: 120000,
    thresholdTokens: 300000,
    windowTokens: null,
    finishReason: "stop",
    route: { provider: "magpie", model: "group/deepseek-v4.1-flash1017" },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, model: "group/deepseek-v4.1-flash1017" },
    summaryChars: 1200,
    session: "session-fixture",
  };
  const merged = { ...base, ...over };
  // 显式传 `undefined` = 把该字段**去掉**（模拟写入点根本没写这个 key）
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

/** 离线补折的样子（照 offline-fold.mjs:808 的字段集）。 */
function makeOfflineMark(over = {}) {
  return makeMark({
    trigger: "archive-offline",
    offline: true,
    measuredBefore: null,
    finishReason: undefined,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: null, reasoningTokens: null },
    route: { provider: "offline", model: "group/deepseek-v4.1-flash1017" },
    truncated: false,
    ...over,
  });
}

/** 临时 DSH home（只放 chess-context/sessions/<id>/graph.json）。 */
function makeHome(sessions) {
  const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "c608-audit-"));
  for (const [name, marks] of Object.entries(sessions)) {
    const dir = nodePath.join(home, "chess-context", "sessions", name);
    nodeFs.mkdirSync(dir, { recursive: true });
    const graph = { version: 1, order: [], nodes: {}, edges: [], foldCount: marks.length, foldMarks: marks };
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(graph));
  }
  return home;
}

function rmHome(home) {
  try {
    nodeFs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* 清不掉无所谓：是临时目录 */
  }
}

function runDoctor(home) {
  // ★ 用 spawnSync 而不是 execFileSync：夹具 home 缺东西时 doctor 会 exitCode=1（"错误 N" 那一行），
  //   而我们关心的是**它打印了什么**，不是退出码。execFileSync 会在非 0 时直接抛错，把输出吞掉。
  const out = spawnSync(process.execPath, [DOCTOR], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
  return `${out.stdout ?? ""}${out.stderr ?? ""}`;
}

function evidenceLine(output) {
  const line = String(output)
    .split("\n")
    .find((l) => l.includes("折叠证据字段（C398/C400）"));
  return line ?? "";
}

tests["IA-1 来路 → 该不该有：四个写入点各自的字段集"] = (t) => {
  // 模型路径（compactIfNeeded）：三个都该有
  const model = foldEvidenceExpectation(makeMark());
  t.eq(model.kind, "model", "pressure 走 compactIfNeeded 的模型路径");
  t.eq(model.expects, { model: true, finish: true, measured: true }, "模型路径三个字段都该有");
  t.includes(model.author, "src/engine.mjs:3009", "模型路径要指向真正的写入点");

  // 离线补折：一个都不该有（模型名落 route.model、截断落 truncated）
  const offline = foldEvidenceExpectation(makeOfflineMark());
  t.eq(offline.kind, "offline", "archive-offline 是离线补折");
  t.eq(offline.expects, { model: false, finish: false, measured: false }, "离线补折本来就不写这三字段");
  t.includes(offline.author, "offline-fold.mjs:808", "离线补折的判据要指向它的写入点");
  t.eq(hasExpectedEvidence(makeOfflineMark()), false, "离线补折不该进分母");

  // tier-2：分段合并，不调模型
  const tier2Mark = makeMark({
    trigger: "tier2",
    tier2: true,
    measuredBefore: undefined,
    finishReason: undefined,
    usage: undefined,
    route: undefined,
  });
  const tier2 = foldEvidenceExpectation(tier2Mark);
  t.eq(tier2.kind, "tier2", "tier2 标记要认出分段合并");
  t.eq(tier2.expects, { model: false, finish: false, measured: false }, "分段合并不调模型 ⇒ 一个都不该有");

  // 手动 /compact：recordFoldMark 只写 finishReason
  const manual = foldEvidenceExpectation(makeMark({ trigger: "manual", measuredBefore: undefined, usage: undefined, route: undefined }));
  t.eq(manual.kind, "manual", "trigger=manual 走 recordFoldMark");
  t.eq(manual.expects, { model: false, finish: true, measured: false }, "手动路径只该有 finishReason");

  // 规则摘要降级：没有模型调用 ⇒ 只有 measuredBefore
  const rules = foldEvidenceExpectation(makeMark({ fallback: "rules", usage: undefined, route: undefined, finishReason: undefined }));
  t.eq(rules.kind, "rules", "fallback=rules 是规则摘要");
  t.eq(rules.expects, { model: false, finish: false, measured: true }, "规则摘要只有 measuredBefore 该有");

  // C398 之前：那时写入点里没有这些字段
  const legacy = foldEvidenceExpectation(
    makeMark({ at: BEFORE_C398, usage: undefined, finishReason: undefined, measuredBefore: undefined, route: undefined }),
  );
  t.eq(legacy.kind, "legacy", "C398 之前的记录要单独归一类");
  t.eq(legacy.expects, { model: false, finish: false, measured: false }, "旧记录不该被算成「该有却没写」");
};

tests["IA-2 窗口全是离线补折 ⇒ 新判据判「判据错」，不是「仪器没生效」"] = (t) => {
  const marks = Array.from({ length: 10 }, (_, i) => makeOfflineMark({ at: AFTER_C398 + i * 60000 }));
  const summary = summarizeFoldEvidence(marks, { limit: 10 });
  t.eq(summary.stats.expected, 0, "离线补折一条都不该进分母");
  t.eq(summary.stats.notApplicable, 10, "10 条都该被排除");
  t.eq(summary.stats.missing, 0, "没有「该有却没写」的");
  t.eq(summary.verdict, VERDICT.CRITERIA, "结论必须是「判据错」");
  t.eq(summary.stats.rawAllZero, true, "旧口径在这个窗口上确实是全 0");
  t.eq(summary.latestExpected, null, "窗口里没有模型路径的折叠可作跨窗口证据");
};

tests["IA-3 旧判据必须真红（同一夹具：旧=仪器没生效，新=判据错）"] = (t) => {
  const marks = Array.from({ length: 10 }, (_, i) => makeOfflineMark({ at: AFTER_C398 + i * 60000 }));
  const legacy = legacyEvidence(marks, { limit: 10 });
  t.eq(legacy.counts, { window: 10, model: 0, finish: 0, measured: 0 }, "旧判据数出来就是三个 0");
  t.eq(legacy.allZero, true, "旧判据在这里必须红");
  t.eq(legacy.verdict, VERDICT.INSTRUMENT, "旧判据的结论是「仪器没生效」");
  t.includes(legacy.detail, "三个都是 0", "旧判据原文要保留（复现真机那句话）");

  const summary = summarizeFoldEvidence(marks, { limit: 10 });
  t.ne(summary.verdict, legacy.verdict, "新旧结论必须不同 —— 否则不是改判据，是改数据");
  t.eq(summary.verdict, VERDICT.CRITERIA, "新判据把同一个窗口判成判据错");
};

tests["IA-4 模型路径真缺字段 ⇒ 新判据照样红（不许改成永真）"] = (t) => {
  const missing = makeMark({
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    finishReason: undefined,
    measuredBefore: undefined,
    route: undefined,
  });
  const summary = summarizeFoldEvidence([missing], { limit: 10 });
  t.eq(summary.stats.expected, 1, "模型路径要进分母");
  t.eq(summary.stats.missing, 1, "三个字段都没写 ⇒ 记一条缺");
  t.eq(summary.stats.allExpectedMissing, true, "该有的全缺");
  t.eq(summary.verdict, VERDICT.INSTRUMENT, "真缺就是「仪器没生效」");
  t.eq(summary.rows[0].missing, ["模型名", "finishReason", "measuredBefore"], "要逐个说出缺哪个");
};

tests["IA-5 同一窗口里既有「本来没有」也有「真缺」 ⇒ 混合"] = (t) => {
  const marks = [
    makeOfflineMark({ at: AFTER_C398 + 5 * 60000 }),
    makeMark({ at: AFTER_C398 + 4 * 60000 }), // 齐全
    makeMark({
      at: AFTER_C398 + 3 * 60000,
      usage: undefined,
      route: { provider: "magpie", model: null },
      finishReason: undefined,
      measuredBefore: undefined,
    }),
  ];
  const summary = summarizeFoldEvidence(marks, { limit: 10 });
  t.eq(summary.stats.expected, 2, "两条模型路径进分母");
  t.eq(summary.stats.missing, 1, "其中一条真缺");
  t.eq(summary.stats.notApplicable, 1, "离线那条排除");
  t.eq(summary.verdict, VERDICT.MIXED, "部分缺 ⇒ 混合");
};

tests["IA-6 模型名的两个落点都认（C604）：usage.model 缺、route.model 在 ⇒ 不算缺"] = (t) => {
  const withRoute = makeMark({
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    route: { provider: "magpie", model: "group/kimi-k3.1-pro" },
  });
  const summary = summarizeFoldEvidence([withRoute], { limit: 10 });
  t.eq(summary.stats.perField.model.expect, 1, "模型路径要进模型名分母");
  t.eq(summary.stats.perField.model.have, 1, "route.model 也算模型名（C604）");
  t.eq(summary.stats.perField.model.route, 1, "要能数出 route 落点有几条");
  t.eq(summary.stats.perField.model.usage, 0, "usage 落点确实是空的");
  t.eq(summary.stats.missing, 0, "不许把「换了字段」判成「没采集」");
  t.eq(summary.rows[0].values.usageModel, null, "原始字段确实空着 —— 判据认的是落点有值，不是字段存在");

  const noModel = makeMark({
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    route: { provider: "magpie", model: null },
  });
  const noModelStats = summarizeFoldEvidence([noModel], { limit: 10 }).stats.perField.model;
  t.eq([noModelStats.expect, noModelStats.have], [1, 0], "两个落点都空才算缺");
};

tests["IA-7 规则摘要降级不该被算成「仪器没生效」（它会正常出现在窗口里）"] = (t) => {
  const summary = summarizeFoldEvidence([makeMark({ fallback: "rules", usage: undefined, route: undefined, finishReason: undefined })], {
    limit: 10,
  });
  t.eq(summary.stats.perField.model.expect, 0, "规则摘要不进模型名分母");
  t.eq([summary.stats.perField.measured.expect, summary.stats.perField.measured.have], [1, 1], "但它必须带着 measuredBefore");
  t.eq(summary.stats.missing, 0, "不许因为没调模型而报缺");
  t.eq(summary.verdict, VERDICT.HEALTHY, "该有的都齐 ⇒ 无需修复");
};

tests["IA-8 CLI 黑盒：默认判据错 / --legacy 复现旧红"] = (t) => {
  const marks = Array.from({ length: 3 }, (_, i) => makeOfflineMark({ at: AFTER_C398 + i * 60000 }));
  const home = makeHome({ "sess-a": marks });
  try {
    const sessionsDir = nodePath.join(home, "chess-context", "sessions");
    const now = execFileSync(process.execPath, [AUDIT, "--limit=3", `--sessions-dir=${sessionsDir}`], { cwd: REPO, encoding: "utf8" });
    t.includes(now, "结论：规则摘要路径本来就没有这些字段（doctor 判据错）", "新判据的结论句要原样出现");
    t.includes(now, "本来就没有", "逐条判定要说明这条不该有");
    t.includes(now, "trigger=archive-offline", "每条要打印来路（trigger）");

    const old = execFileSync(process.execPath, [AUDIT, "--limit=3", `--sessions-dir=${sessionsDir}`, "--legacy"], {
      cwd: REPO,
      encoding: "utf8",
    });
    t.includes(old, "旧判据复刻（分母=全部 3 条）：最近 3 条 foldMark：usage.model 0 · finishReason 0 · measuredBefore 0", "旧判据要能复现那句话");
    t.includes(old, "⇒ **三个都是 0**：仪器未生效", "旧判据必须真红（原文是「未生效」）");
  } finally {
    rmHome(home);
  }
};

tests["IA-9 doctor 黑盒：全是离线补折时不再报「仪器没生效」，而是用跨窗口证据回答"] = (t) => {
  // 窗口 10 条：10 条离线 + 1 条更早的模型路径（齐全）⇒ 该有的被挤出窗口，走跨窗口兜底。
  const offline = Array.from({ length: 10 }, (_, i) => makeOfflineMark({ at: AFTER_C398 + (i + 1) * 60000 }));
  const model = makeMark({ at: AFTER_C398 });
  const home = makeHome({ "sess-a": [...offline, model] });
  try {
    const line = evidenceLine(runDoctor(home));
    t.ok(line.length > 0, "doctor 必须打印这一条");
    t.includes(line, "✓", "正确口径下这条应当绿");
    t.notIncludes(line, "三个都是 0", "不许再出现旧判据那句");
    t.includes(line, "已排除出分母", "要说明分母被修正");
    t.includes(line, "仪器已生效", "要用最近一条该有的 fold 回答「仪器活没活」");
  } finally {
    rmHome(home);
  }
};

tests["IA-10 doctor 黑盒：模型路径真缺字段 ⇒ 仍然红（restart 分支不许被吞）"] = (t) => {
  const broken = makeMark({
    at: AFTER_C398 + 10 * 60000,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    route: { provider: "magpie", model: null },
    finishReason: undefined,
    measuredBefore: undefined,
  });
  const home = makeHome({
    "sess-a": [broken, ...Array.from({ length: 9 }, (_, i) => makeOfflineMark({ at: AFTER_C398 + i * 60000 }))],
  });
  try {
    const line = evidenceLine(runDoctor(home));
    t.includes(line, "!", "真缺要红");
    t.includes(line, "该有却缺 1 条", "要点出缺了几条");
    t.includes(line, "仪器未生效", "三个字段都没写时要说清是仪器没生效（原文用「未生效」）");
    t.notIncludes(line, "✓", "不许绿");
  } finally {
    rmHome(home);
  }
};
