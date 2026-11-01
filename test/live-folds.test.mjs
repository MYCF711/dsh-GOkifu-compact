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
import { SCHEMA, closureChainOf, collectLiveFolds, main, renderMarkdown, summarizeFolds, trendOf } from "../scripts/live-folds.mjs";

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
    t.includes(md, "session-modern0002", "明细里要有会话 id");
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
};
