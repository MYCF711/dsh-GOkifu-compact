/**
 * live-folds.test.mjs —— live fold 证据汇总（scripts/live-folds.mjs）回归
 *
 * 数据源是 live home 里的 `graph.json#foldMarks`；这里用夹具会话目录验证：
 *   · 覆盖率（trigger / quality / closure / usage）与排序；
 *   · 质量、成本、闭包的汇总结论；
 *   · Markdown 证据页包含生成时间与逐次明细；
 *   · CLI 写文件 / dry-run / 空 home 的边界。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_REDACTED, SCHEMA, closureChainOf, collectLiveFolds, main, pseudonymOf, renderMarkdown, summarizeFolds, trendOf } from "../scripts/live-folds.mjs";
import { encodeDeltaFrame, sha } from "../src/rooms/kifu-model.mjs";
import { check as consistencyCheck } from "../scripts/consistency-check.mjs";
import { createGraph } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 造一个假 home：两个会话，一个老 fold（无 trigger/quality），一个新 fold（字段齐全）。 */
function makeHome() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-folds-"));
  const sessionsRoot = nodePath.join(root, "chess-context", "sessions");
  nodeFs.mkdirSync(sessionsRoot, { recursive: true });
  const legacyDir = nodePath.join(sessionsRoot, "session-legacy0001");
  nodeFs.mkdirSync(legacyDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(legacyDir, "graph.json"),
    JSON.stringify(
      {
        nodes: {},
        edges: {},
        foldMarks: [
          { at: 1762000000000, seqStart: 1, seqEnd: 50, shadowedTokens: 90000, summaryChars: 1200, ms: 5000, usage: { inputTokens: 130000, outputTokens: 800 } },
        ],
      },
      null,
      2,
    ),
  );
  const modernDir = nodePath.join(sessionsRoot, "session-modern0002");
  nodeFs.mkdirSync(modernDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(modernDir, "graph.json"),
    JSON.stringify(
      {
        nodes: {},
        edges: {},
        foldMarks: [
          {
            at: 1762100000000,
            seqStart: 8,
            seqEnd: 1019,
            trigger: "pressure",
            shadowedTokens: 163722,
            summaryChars: 1877,
            ms: 34527,
            route: { provider: "magpie", model: "group/deepseek-v4.1-flash1017" },
            fallback: null,
            usage: { inputTokens: 295805, outputTokens: 5305 },
            quality: {
              constraintRecall: 1,
              failureRecall: 1,
              compressionRatio: 133.76,
              expectedConstraints: 0,
              expectedFailures: 0,
              unknownIds: [],
              summaryTokens: 1224,
            },
            closure: { nodes: 0, edges: 0, firstNode: null, lastNode: null, preGraph: true, graphNodes: 0 },
            boundary: { overlapping: 40, openAtEnd: 0, unsettled: 3 },
            dangling: { residue: 3, candidates: 1, liveUnsettled: 0, fromBroken: 0 },
          },
          {
            at: 1762200000000,
            seqStart: 1020,
            seqEnd: 2100,
            trigger: "overflow",
            shadowedTokens: 41000,
            ms: 8000,
            usage: { inputTokens: 82000, outputTokens: 900 },
            quality: { constraintRecall: 0.8, failureRecall: 0.5, compressionRatio: 12.5, unknownIds: ["e999"], summaryTokens: 400 },
            closure: { nodes: 3, edges: 2, firstNode: "n1", lastNode: "n3", preGraph: false, graphNodes: 7 },
            boundary: { overlapping: 5, openAtEnd: 1, unsettled: 0 },
            dangling: { residue: 0, candidates: 0, liveUnsettled: 0, fromBroken: 0 },
          },
        ],
      },
      null,
      2,
    ),
  );
  // 第三个会话：坏 json（应被计入 unreadable，不抛）
  const brokenDir = nodePath.join(sessionsRoot, "session-broken0003");
  nodeFs.mkdirSync(brokenDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(brokenDir, "graph.json"), "{not json");
  return root;
}

export const tests = {};

tests["L-1 collect：三个会话三条 fold，按时间升序；字段逐项取出"] = (t) => {
  const home = makeHome();
  try {
    const { records, sessions, unreadable } = collectLiveFolds(home);
    t.eq(sessions, 3, "三个会话都要被扫到");
    t.eq(unreadable, 1, "坏 json 必须计数而不是抛");
    t.eq(records.length, 3, "共 3 次 fold");
    t.eq(records.map((r) => r.at), [1762000000000, 1762100000000, 1762200000000], "必须按时间升序");
    const modern = records[1];
    t.eq(modern.trigger, "pressure", "trigger 要取出");
    t.eq(modern.quality.constraintRecall, 1, "quality 要取出");
    t.eq(modern.quality.unknownIds, 0, "unknownIds 记的是条数");
    t.eq(modern.inputPerShadowed, 1.81, "成本比 = input / shadowed（295805/163722≈1.81）");
    t.eq(records[0].trigger, null, "老 fold 没有 trigger 记 null");
    t.eq(records[0].quality, null, "老 fold 没有 quality 记 null");
    t.eq(modern.closure.preGraph, true, "C30 起闭包带 preGraph");
    t.eq(records[2].closure.preGraph, false, "有节点在区间内 ⇒ preGraph=false");
    t.eq(records[0].closure, null, "老 fold 没有 closure 记 null");
    // ★ t3：采集出口就必须是 pseudonym（之后所有消费方不再有机会拿到原始 id）
    t.eq(records.every((r) => /^s_[0-9a-f]{12}$/.test(r.sessionId)), true, "sessionId 必须全部是稳定 pseudonym");
    t.eq(records[1].sessionId, pseudonymOf("session-modern0002"), "同一会话必须映射成同一 pseudonym");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["L-2 summarize：覆盖率 / trigger 分布 / 质量下限 / 成本区间 / 空闭包"] = (t) => {
  const home = makeHome();
  try {
    const { records } = collectLiveFolds(home);
    const s = summarizeFolds(records);
    t.eq(s.total, 3, "总数");
    t.eq(s.coverage.trigger, 2, "两次新 fold 有 trigger");
    t.eq(s.coverage.quality, 2, "两次有 quality");
    t.eq(s.coverage.closure, 2, "两次有 closure");
    t.eq(s.coverage.usage, 3, "三次都有 usage");
    t.eq(s.triggerCounts, { pressure: 1, overflow: 1 }, "trigger 分布");
    t.eq(s.quality.constraintRecallMin, 0.8, "约束召回取最小");
    t.eq(s.quality.failureRecallMin, 0.5, "失败召回取最小");
    t.eq(s.quality.compressionRatioMin, 12.5, "压缩比下限");
    t.eq(s.quality.compressionRatioMax, 133.76, "压缩比上限");
    t.eq(s.quality.unknownIdsTotal, 1, "幻觉探针累计命中");
    t.eq(s.cost.count, 3, "成本样本数");
    t.eq(s.cost.inputPerShadowedMin, 1.44, "成本比下限（130000/90000≈1.44）");
    t.eq(s.closure.count, 2, "闭包样本数");
    t.eq(s.closure.empty, 1, "空闭包一次");
    t.eq(s.closure.preGraph, 1, "preGraph 一次（区间早于本图）");
    t.eq(s.boundary.count, 2, "两次有 boundary");
    t.eq(s.boundary.openAtEnd, 1, "一次切在调用中间（openAtEnd 合计 1）");
    t.eq(s.boundary.unsettled, 3, "未结算边合计 3");
    t.eq(s.dangling.count, 2, "两次有 dangling");
    t.eq(s.dangling.residue, 3, "residue 合计 3");
    t.eq(s.dangling.candidates, 1, "candidates 合计 1");
    t.eq(s.dangling.liveUnsettled, 0, "liveUnsettled 必须为 0（正常 fold 切在 step 边界）");
    t.eq(typeof s.cost.shadowedShareMin, "number", "必须给出遮蔽占读入的下限（C43 口径）");
    t.eq(s.cost.shadowedShareMin <= s.cost.shadowedShareMax, true, "share 区间必须有序");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["L-3 renderMarkdown：带生成时间、覆盖率表、逐次明细"] = (t) => {
  const home = makeHome();
  try {
    const { records } = collectLiveFolds(home);
    const summary = summarizeFolds(records);
    const md = renderMarkdown({ home, records, summary, generatedAt: "2026-11-02T02:40:00Z" });
    t.includes(md, "2026-11-02T02:40:00Z", "必须写明生成时间（判据：看内容不看 mtime）");
    t.includes(md, "| trigger | 2 / 3 |", "覆盖率行要准");
    t.includes(md, "| quality（保真度） | 2 / 3 |", "quality 覆盖率行要准");
    t.includes(md, pseudonymOf("session-modern0002"), "明细里要有会话 pseudonym");
    t.eq(md.includes("session-modern0002"), false, "原始会话 id 不许出现在公开证据页（t3）");
    t.includes(md, HOME_REDACTED, "数据源必须写成 <DSH_HOME>（真实 home 不落盘）");
    t.eq(md.includes(home), false, "真实 home 路径不许出现在证据页");
    t.includes(md, "快照语义", "证据页必须显式声明快照语义（非累计）");
    t.includes(md, "pressure", "明细里要有 trigger");
    t.includes(md, "133.76", "明细里要有压缩比");
    t.includes(md, "preGraph", "证据页要解释 preGraph");
    t.includes(md, "边界完整性", "证据页要报告边界完整性");
    t.includes(md, "悬空", "证据页要报告 dangling");
    t.includes(md, "遮蔽占读入", "证据页要报告 C43 成本口径");
    t.eq(md.includes("undefined"), false, "不许出现 undefined");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["L-4 main：写 json+md；--dry-run 不落盘；json schema 可回读"] = (t) => {
  const home = makeHome();
  const outDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-out-"));
  try {
    const base = nodePath.join(outDir, "live-folds");
    main(["--home", home, "--out", base, "--write"]);
    const json = JSON.parse(nodeFs.readFileSync(`${base}.json`, "utf8"));
    t.eq(json.schema, SCHEMA, "schema 必须写明");
    t.eq(json.folds.length, 3, "json 里也要有 3 条");
    t.eq(json.summary.total, 3, "summary 要一起写");
    // ★ t3：公开 JSON 的脱敏与快照语义
    t.eq(json.home, HOME_REDACTED, "home 必须脱敏成 <DSH_HOME>");
    t.eq(json.homeRedacted, true, "必须显式标明 home 已脱敏");
    t.eq(json.semantics?.snapshot, true, "必须标明这是快照");
    t.eq(json.semantics?.notCumulative, true, "必须标明非累计");
    t.eq(json.semantics?.trendIsNetChange, true, "必须标明对比是净变化口径");
    t.eq(json.folds.every((f) => /^s_[0-9a-f]{12}$/.test(f.sessionId)), true, "json 里的会话也必须是 pseudonym");
    t.eq(nodeFs.existsSync(`${base}.md`), true, "md 也要写");

    const before = nodeFs.readFileSync(`${base}.json`, "utf8");
    nodeFs.writeFileSync(`${base}.json`, "sentinel", "utf8");
    main(["--home", home, "--out", base, "--dry-run"]);
    t.eq(nodeFs.readFileSync(`${base}.json`, "utf8"), "sentinel", "dry-run 不许覆盖既有文件");
    nodeFs.writeFileSync(`${base}.json`, before, "utf8");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
    nodeFs.rmSync(outDir, { recursive: true, force: true });
  }
};

tests["L-5 空 home：0 条也要给结论，不许抛"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-empty-"));
  try {
    const { records } = collectLiveFolds(home);
    t.eq(records.length, 0, "没有会话目录 ⇒ 0 条");
    const s = summarizeFolds(records);
    t.eq(s.total, 0, "总数 0");
    t.eq(s.quality.constraintRecallMin, null, "无样本时给 null 而不是 Infinity");
    const md = renderMarkdown({ home, records, summary: s, generatedAt: "2026-11-02T02:40:00Z" });
    t.includes(md, "生成于", "空 home 也要有证据页");
    t.eq(md.includes("Infinity"), false, "不许出现 Infinity");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["L-6 trendOf：新增 fold / 质量变化 / 边界回归 / 成本漂移都如实报告；没有旧快照返回 null"] = (t) => {
  t.eq(trendOf(null, {}), null, "没有旧快照 ⇒ null");
  const prev = {
    generatedAt: "2026-11-02T00:00:00Z",
    summary: {
      total: 7,
      quality: { constraintRecallMin: 1, failureRecallMin: 1, unknownIdsTotal: 0 },
      boundary: { openAtEnd: 0 },
      cost: { shadowedShareMin: 0.6 },
    },
    folds: [{}, {}, {}, {}, {}, {}, {}],
  };
  const now = {
    total: 10,
    quality: { constraintRecallMin: 1, failureRecallMin: 0.5, unknownIdsTotal: 2 },
    boundary: { openAtEnd: 1 },
    cost: { shadowedShareMin: 0.5 },
  };
  const trend = trendOf(prev, now);
  t.eq(trend.newFolds, 3, "新增 3 次");
  t.eq(trend.qualityChanged, true, "质量下限变化必须报告");
  t.eq(trend.boundaryRegressed, true, "openAtEnd 从 0 变 1 ⇒ 边界回归");
  t.eq(Number((trend.costShareDelta ?? 0).toFixed(2)), -0.1, "成本占比漂移 = 现在 - 上次");
  const same = trendOf(prev, prev.summary && { ...prev.summary });
  t.eq(same.newFolds, 0, "同一快照 ⇒ 0");
  t.eq(same.boundaryRegressed, false, "同一快照 ⇒ 无回归");
  // ★ t3：口径必须是「净变化」，且跨 home 只能由未脱敏的旧快照判定，判定不了就 null
  t.eq(trend.netChange, 3, "净变化 = 本次快照 − 上次快照");
  t.eq(trend.trendKind, "net-change", "必须标明 net-change 口径");
  t.eq(trend.previousHomeChanged, null, "旧快照没有 home ⇒ 同源判定不许猜");
  const crossHome = trendOf({ ...prev, home: "/tmp/home-a" }, now, { home: "/tmp/home-b" });
  t.eq(crossHome.previousHomeChanged, true, "两份未脱敏快照来自不同 home ⇒ 必须报跨 home");
  const sameHome = trendOf({ ...prev, home: "/tmp/home-b/" }, now, { home: "/tmp/home-b" });
  t.eq(sameHome.previousHomeChanged, false, "同一 home 的写法差异（斜杠/大小写）不该误报");
};

tests["L-7 会话分布：同一会话折 ≥3 次进 multiFold；foldThrash≥2 的会话单独列出（C54）"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-multi-"));
  try {
    const sessionsRoot = nodePath.join(root, "chess-context", "sessions");
    nodeFs.mkdirSync(sessionsRoot, { recursive: true });
    const dir = nodePath.join(sessionsRoot, "session-multi0003");
    nodeFs.mkdirSync(dir, { recursive: true });
    const marks = [0, 1, 2].map((i) => ({ at: 1762200000000 + i * 60000, seqStart: 10 + i * 100, seqEnd: 100 + i * 100, trigger: "pressure", shadowedTokens: 50000 }));
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify({ nodes: {}, edges: {}, foldThrash: 3, foldMarks: marks }, null, 2));
    const { records, thrash } = collectLiveFolds(root);
    const summary = summarizeFolds(records);
    t.eq(summary.bySession.sessionsWithFolds, 1, "1 个会话有 fold");
    t.eq(summary.bySession.multiFold, 1, "折过 3 次 ⇒ multiFold");
    t.eq(summary.bySession.top[0].folds, 3, "top 会话折 3 次");
    t.eq(thrash.length, 1, "foldThrash≥2 的会话必须列出");
    t.eq(thrash[0].foldThrash, 3, "thrash 深度如实");
    // ★ t3：会话分布与 thrash 列表同样只留 pseudonym
    t.eq(thrash[0].sessionId, pseudonymOf("session-multi0003"), "thrash 列表的会话必须脱敏");
    t.eq(summary.bySession.top[0].sessionId, pseudonymOf("session-multi0003"), "top 榜的会话必须脱敏");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["L-8 默认不写盘（C65）：不传 --write 时证据文件不应被创建/覆盖"] = (t) => {
  const home = makeHome();
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-nowrite-"));
  try {
    const base = nodePath.join(root, "live");
    const code = main(["--home", home, "--out", base]);
    t.eq(code, 0, "默认 dry-run 也要正常退出");
    t.eq(nodeFs.existsSync(`${base}.json`), false, "默认不许写 json");
    t.eq(nodeFs.existsSync(`${base}.md`), false, "默认不许写 md");
    main(["--home", home, "--out", base, "--write"]);
    t.eq(nodeFs.existsSync(`${base}.json`), true, "--write 才落盘");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["L-9 --previous：对比基线可单独指定（刷新一次不会把 +537 覆盖成 +1）"] = (t) => {
  const home = makeHome();
  const outDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-prev-"));
  try {
    const base = nodePath.join(outDir, "live-folds");
    const older = nodePath.join(outDir, "older.json");
    nodeFs.writeFileSync(
      older,
      JSON.stringify({ generatedAt: "2026-11-07T00:24:15Z", home: HOME_REDACTED, summary: { total: 1, quality: {}, boundary: {}, cost: {} } }),
      "utf8",
    );
    main(["--home", home, "--out", base, "--write", "--previous", older]);
    const json = JSON.parse(nodeFs.readFileSync(`${base}.json`, "utf8"));
    t.eq(json.trend.newFolds, 2, "3 次 − 指定旧快照 1 次 = 净变化 +2");
    t.eq(json.trend.trendKind, "net-change", "指定基线时也必须是净变化口径");
    main(["--home", home, "--out", base, "--write"]);
    const again = JSON.parse(nodeFs.readFileSync(`${base}.json`, "utf8"));
    t.eq(again.trend.newFolds, 0, "不带 --previous 时默认对比同目录同名快照 ⇒ 净变化 0");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
    nodeFs.rmSync(outDir, { recursive: true, force: true });
  }
};

tests["L-10 pseudonym：同 id 稳定、不同 id 不同、可加盐（盐不进证据）"] = (t) => {
  const a = pseudonymOf("session-x0000001");
  t.eq(a, pseudonymOf("session-x0000001"), "同一 id 必须每次得到同一个 pseudonym");
  t.eq(/^s_[0-9a-f]{12}$/.test(a), true, `格式必须是 s_<12hex>（实际 ${a}）`);
  t.eq(a === pseudonymOf("session-x0000002"), false, "不同 id 必须得到不同 pseudonym");
  const salted = pseudonymOf("session-x0000001", "private-salt");
  t.eq(salted === a, false, "换盐必须换映射（可加盐/映射私有）");
  t.eq(salted, pseudonymOf("session-x0000001", "private-salt"), "同盐同 id 仍必须稳定");
};

tests["L-11 --from：只重渲染文案，不改数字 / generatedAt（t6）"] = (t) => {
  const home = makeHome();
  const outDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-live-from-"));
  try {
    const base = nodePath.join(outDir, "live-folds");
    main(["--home", home, "--out", base, "--write"]);
    const before = JSON.parse(nodeFs.readFileSync(`${base}.json`, "utf8"));
    t.eq(nodeFs.readFileSync(`${base}.md`, "utf8").includes("快照语义"), true, "首轮证据页就应有快照语义节");
    // 人为写坏 .md，再用同一份 json 重渲染：数字与 generatedAt 必须原样，只换文案
    nodeFs.writeFileSync(`${base}.md`, "BROKEN", "utf8");
    main(["--from", `${base}.json`, "--out", base, "--write"]);
    const after = JSON.parse(nodeFs.readFileSync(`${base}.json`, "utf8"));
    t.eq(after.generatedAt, before.generatedAt, "--from 不许改 generatedAt（快照时刻不变）");
    t.eq(after.summary.total, before.summary.total, "--from 不许改 total");
    t.eq(JSON.stringify(after.trend), JSON.stringify(before.trend), "--from 沿用快照里的 trend");
    t.eq(after.folds.length, before.folds.length, "--from 不许增删 fold");
    const mdAfter = nodeFs.readFileSync(`${base}.md`, "utf8");
    t.eq(mdAfter.includes("BROKEN"), false, "重渲染必须覆盖坏掉的 .md");
    t.eq(mdAfter.includes("快照语义"), true, "重渲染后的 .md 仍要有快照语义");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
    nodeFs.rmSync(outDir, { recursive: true, force: true });
  }
};

tests["C103 闭包链：相邻 fold 的节点集必须单调不重叠（区间重叠是正常的）"] = (t) => {
  const mk = (sessionId, at, first, last) => ({ sessionId, at, closure: { firstNode: first, lastNode: last } });
  // 正常：n116 → n117（节点不重叠；即使 seq 区间重叠也不算重复折叠）
  const ok = closureChainOf([mk("s1", 1, "n1", "n116"), mk("s1", 2, "n117", "n153")]);
  t.eq(ok.checked, 1, "应检查 1 对相邻 fold");
  t.eq(ok.offenders.length, 0, `节点不重叠不许报：${JSON.stringify(ok.offenders)}`);

  // 真问题：第二次从 n100 开始（n100 ≤ n116）⇒ 节点被重复折叠
  const bad = closureChainOf([mk("s1", 1, "n1", "n116"), mk("s1", 2, "n100", "n153")]);
  t.eq(bad.offenders.length, 1, "节点级重复折叠必须报出来");
  t.includes(bad.offenders[0], "n116→n100", "要点名前后边界");

  // 缺 closure / 非字符串 firstNode 的记录被忽略；不同会话不互相比较
  const mixed = closureChainOf([
    mk("s1", 1, "n1", "n10"),
    { sessionId: "s1", at: 2 },
    { sessionId: "s2", at: 3, closure: { firstNode: "n5", lastNode: "n9" } },
  ]);
  t.eq(mixed.checked, 0, "只有一个带 closure 的记录 ⇒ 没有可比的相邻对");
  t.eq(closureChainOf(null).checked, 0, "null 不许抛");

  // ★ t6（t5 复核）：节点级重叠要分列 —— 后一次是 tier2 合并属设计内，非 tier2 才是质量线索
  const withTrigger = (sessionId, at, first, last, trigger) => ({ sessionId, at, trigger, closure: { firstNode: first, lastNode: last } });
  const merge = closureChainOf([withTrigger("s1", 1, "n1", "n116", "pressure"), withTrigger("s1", 2, "n100", "n153", "tier2")]);
  t.eq(merge.offenders.length, 1, "tier2 合并仍是节点级重叠（要如实记录，不隐藏）");
  t.eq(merge.tier2Merges, 1, "后一次是 tier2 ⇒ 计入 tier2 合并");
  t.eq(merge.nonTier2, 0, "tier2 合并不应算进非 tier2 质量线索");
  const real = closureChainOf([withTrigger("s1", 1, "n1", "n116", "pressure"), withTrigger("s1", 2, "n100", "n153", "pressure")]);
  t.eq(real.nonTier2, 1, "非 tier2 的重复折叠才算质量线索");
  t.eq(real.pairKinds["pressure→pressure"], 1, "trigger 对要计数（写文档时按它分列）");
};

tests["C199 live-folds 必须重放 delta（foldMark 只在 delta 里也要数到）+ 报宿主外部折叠"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-lf199-"));
  try {
    const dir = nodePath.join(root, "chess-context", "sessions", "session-lf199");
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = createGraph({ sessionId: "s" });
    g.foldMarks = [];
    const raw = JSON.stringify(g);
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), raw, "utf8");
    // 只把 foldMark 放进**增量帧**（基线里没有）
    const mark = { at: Date.now(), seqStart: 10, seqEnd: 20, trigger: "host", closure: { nodes: 1, edges: 1 }, boundary: { openAtEnd: 0 }, quality: { constraintRecall: 1, failureRecall: 1 } };
    const frame = encodeDeltaFrame(sha(raw).slice(0, 16), { v: 1, nodes: {}, edges: {}, delNodes: [], delEdges: [], orderAppend: [], orderDrop: [], scalars: { foldMarks: [mark] } });
    nodeFs.writeFileSync(`${nodePath.join(dir, "graph.json")}.delta.jsonl`, frame, "utf8");

    // 宿主外部折叠记在 ledger-budget.json
    nodeFs.writeFileSync(
      nodePath.join(root, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 1, none: 1, externalFolds: 3, lastExternalFold: { at: Date.now(), seqStart: 30, seqEnd: 40, session: "session-lf199" } }),
      "utf8",
    );

    const collected = collectLiveFolds(root);
    t.eq(collected.records.length, 1, `delta 里的 foldMark 必须被数到（实际 ${collected.records.length}）`);
    t.eq(collected.records[0].trigger, "host", "trigger 必须保留");
    t.eq(collected.external.folds, 3, "必须从 ledger-budget 读到 externalFolds");
    t.eq(collected.external.last.session, pseudonymOf("session-lf199"), "外部折叠里的 session 也必须脱敏（t3）");
    t.eq(collected.external.last.seqEnd, 40, "脱敏只换 session，其余字段必须原样保留");
    const summary = summarizeFolds(collected.records, collected.external);
    t.eq(summary.total, 1, "汇总总数必须含 delta 里的那条");
    t.eq(summary.external.folds, 3, "汇总必须透传 external");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C200 一致性核对：证据与磁盘 foldMark 数必须相等（不等就指明「跑 --write」还是真问题）"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-cc200-"));
  try {
    const dir = nodePath.join(root, "chess-context", "sessions", "session-cc200");
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = createGraph({ sessionId: "s" });
    g.foldMarks = [{ at: Date.now(), seqStart: 1, seqEnd: 10, trigger: "pressure" }];
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
    nodeFs.writeFileSync(
      nodePath.join(root, "chess-context", "ledger-budget.json"),
      JSON.stringify({ samples: 1, externalFolds: 0 }),
      "utf8",
    );

    // 证据文件是仓库级的：这里直接比对「磁盘 1 条」与「仓库证据的 total」是否一致，
    // 只要仓库证据不巧好是 1（几乎不可能），就应该报不一致并给出 --write 提示。
    const result = consistencyCheck({ home: root });
    t.eq(result.disk.foldMarks, 1, "磁盘 foldMark 必须数到 1");
    t.eq(typeof result.ok, "boolean", "必须给出 ok");
    if (result.evidence.evidenceTotal !== 1) {
      t.eq(result.ok, false, "证据与磁盘不一致时必须 ok=false");
      t.eq(result.problems.length > 0, true, "必须给出原因");
      t.eq(/--write|不一致|≠/.test(result.problems.join(" / ")), true, `必须给可执行提示：${result.problems.join(" / ")}`);
    }
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};
