#!/usr/bin/env node
/**
 * handoff-check.mjs —— 「压缩产物交接测试」的可执行版（2026-11-01）
 *
 * 为什么要有它：`docs/压缩的重注入契约.md` 把「哪些东西永远不靠摘要活」写成了七项契约，
 *  `test/ledger-boundary.test.mjs` 的 #4 墓碑测试只证明了**夹具**里七项齐全。
 *  真实会话的图形态差得远（有些没有 OPTIONS、有些 0 失败边、有些站在 L2–L5 降级档位），
 *  所以需要拿 **live 的每一张图** 渲染一次，看契约在**生产口径**下是否成立。
 *
 * 这是**只读**检查：不改任何棋谱、不调用模型、不联网。
 *
 * 判据（来自 `docs/压缩的重注入契约.md` §1 + `docs/压缩的职责边界.md`）：
 *   ① 根目标：图有 rootUserNodeIds ⇒ 热清单必须出现 ROOT USER
 *   ② 约束：事实块有 CONSTRAINTS_VERBATIM ⇒ 热清单必须出现 CONSTRAINTS
 *   ③ 失败边：图有失败边 ⇒ 热清单必须出现 LEARNED
 *   ④ 未落地选项：事实块有 OPTIONS ⇒ 热清单必须出现 OPTIONS（L2+ 允许只剩计数行）
 *   ⑤ 未验证声明：有**非残留**的未验证边 ⇒ 热清单必须出现 UNVERIFIED（L0/L1 列表，L2+ 计数行）
 *   ⑥ 当前位置：图有路径 ⇒ 热清单必须出现 CURRENT PATH / # path: / # WORKING:
 *   ⑦ 出处：renderLedger().provenanceCoverage 必须 = 1
 *   ⑧ 省略行可解析：任何「有东西被省掉了」的行都必须带 graph.json 指向
 *   ⑨ 预算：fallback=impossible 是 error；over-budget 是 warn
 *   ⑩ 保真度：foldMark.quality 的 constraintRecall 必须 = 1（fail）/ failureRecall < 1（warn）/ 真空样本=ok（无内容可丢，非缺陷；C38）
 *   ⑪ 幻觉探针：摘要里提到的 eN/nN 必须在图里找得到（`findUnknownIds`）；
 *      C104 起还检查「图里有、但不在本次折叠区间」（`outOfRangeIds`）
 *   ⑫ 触发原因：context-overflow 出现 = 压缩被迫自救（说明没跟上增长）
 *   ⑬ fold 边界：切点落在工具调用中间（openAtEnd>0）= 摘要引用区间外结果 ⇒ fail（C37）
 *   ⑭ fold 成本：遮蔽占读入 < 30% ⇒ warn（折太碎/太早；C43 指标，C78 进门禁）
 *   ⑮ fold 悬空：liveUnsettled>0 ⇒ warn；fromBroken>0 ⇒ fail（C79）
 *   ⑯ 闭包自洽：seqStart>seqEnd 或 closure.nodes>graphNodes ⇒ fail（C79）
 *
 * 用法：
 *   node scripts/handoff-check.mjs                 # 人读
 *   node scripts/handoff-check.mjs --json          # 机读
 *   DSH_HOME=... node scripts/handoff-check.mjs    # 换一个 home
 *
 * 退出码：有 FAIL ⇒ 1；只有 WARN 或全绿 ⇒ 0。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const asJson = process.argv.includes("--json");

const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : nodePath.join(os.homedir(), ".dsh");
const sessionsRoot = nodePath.join(home, "chess-context", "sessions");

const { fromJSON } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "kifu-model.mjs")).href);
const { renderLedger, renderFacts, isDanglingResidue } = await import(pathToFileURL(nodePath.join(REPO, "src", "rooms", "ledger.mjs")).href);

/** 一条检查结果。level: ok / warn / fail。 */
function check(name, level, detail = "") {
  return { name, level, detail };
}

/** 有东西被省掉了的行 —— 必须能查到。 */
function omissionLines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => /omitted for budget|FAILED_ATTEMPTS_OMITTED|DANGLING_RESIDUE/.test(line));
}

/** 对一张图跑全部判据。 */
export function checkGraph(graph, { treeDir = "", traceRoot = "sessions", maxTokens = 500 } = {}) {
  const ledger = renderLedger(graph, { maxTokens, treeDir, traceRoot });
  const text = String(ledger.text ?? "");
  const facts = renderFacts(graph, { treeDir, traceRoot });
  const out = [];

  // ① 根目标
  // ★ C36：空图（0 节点）是「本次会话没有记录任何节点」，不是「缺 rootUserNodeIds」——
  //   旧写法把两者混成同一个 warn，live 里 2 个空图长期占着告警位（没有可检查的内容）。
  const nodes = Object.values(graph?.nodes ?? {});
  const nodeCount = nodes.length;
  const userNodes = nodes.filter((n) => n?.kind === "user").length;
  const hasRoot = Array.isArray(graph?.rootUserNodeIds) && graph.rootUserNodeIds.length > 0;
  // C38：agent-only 会话（没有任何 user 节点，例如子代理/自动化会话）本来就没有根目标，
  //   这与「有 user 节点却漏记 rootUserNodeIds」是两件事 —— 前者是事实，后者才是缺陷。
  const rootState = nodeCount === 0 || userNodes === 0 ? "ok" : !hasRoot ? "warn" : text.includes("ROOT USER") ? "ok" : "fail";
  const rootDetail =
    nodeCount === 0
      ? "空图（本次会话没有记录任何节点 ⇒ 根目标检查不适用）"
      : userNodes === 0
        ? "没有 user 节点（agent-only 会话）⇒ 根目标不适用"
        : hasRoot
          ? ""
          : "图里有 user 节点但没有 rootUserNodeIds（keeper 漏记 —— 这是缺陷）";
  out.push(check("①根目标", rootState, rootDetail));

  // ② 约束
  const factsHasConstraints = facts.includes("CONSTRAINTS_VERBATIM:");
  out.push(check("②约束", !factsHasConstraints ? "ok" : text.includes("CONSTRAINTS") ? "ok" : "fail", factsHasConstraints ? "" : "本会话没有抽取到约束"));

  // ③ 失败边
  const edgeList = graph?.edges && typeof graph.edges === "object" ? Object.values(graph.edges) : [];
  const failureCount = edgeList.filter((e) => e?.result === "failure").length;
  out.push(check("③失败边", failureCount === 0 ? "ok" : text.includes("LEARNED") ? "ok" : "fail", failureCount === 0 ? "0 条失败边" : `${failureCount} 条失败边`));

  // ④ OPTIONS（未落地尝试）
  const factsHasOptions = facts.includes("OPTIONS (not yet landed):");
  out.push(check("④未落地选项", !factsHasOptions ? "ok" : text.includes("OPTIONS") ? "ok" : "fail", factsHasOptions ? "" : "本会话没有未落地尝试"));

  // ⑤ 未验证声明：L0/L1 出完整列表；L2+ 出计数行（ed3e5b1 起）。**判据必须与 renderLedger 一致地排除 residue**
  //   —— 事实块（renderFacts）会列 residue 未验证边，而热清单按 P6-A 排除它们，直接把「facts 有 → ledger 必须有」
  //   当判据会误报（P2-3，独立验证 2026-11-01：2fcebdc7 唯一未验证边是 residue）。
  const unverifiedEdges = edgeList.filter((e) => e?.result === "unverified" && !isDanglingResidue(e, { graph, now: Date.now() }));
  if (unverifiedEdges.length === 0) out.push(check("⑤未验证", "ok", "本会话没有（非残留的）未验证声明"));
  else if (text.includes("UNVERIFIED")) out.push(check("⑤未验证", "ok", `${unverifiedEdges.length} 条未验证声明仍在清单里`));
  else out.push(check("⑤未验证", "fail", `${unverifiedEdges.length} 条未验证声明在 L${ledger.level} 被静默丢掉（契约 ⑤ 违反）`));

  // ⑥ 当前位置（只有当图里真的有路径时才要求 —— 没有 agent 节点的会话本来就没有路径可放）
  const factsHasPath = facts.includes("CURRENT_PATH:");
  // ★ C36.1：单独 WORKING 行（当前路径 === 工作路径时 ledger 只写这一行）也是「当前位置」。
  //   旧判据只认 CURRENT PATH / # path: / # WORKING: —— live 会话因它误报 FAIL（实测 7520721a）。
  const hasPath =
    text.includes("CURRENT PATH") || text.includes("# path:") || text.includes("# WORKING:") || /^WORKING:/m.test(text);
  out.push(
    check(
      "⑥当前位置",
      !factsHasPath || hasPath ? "ok" : "fail",
      factsHasPath ? "" : "本会话还没有 agent 节点（没有路径可放）",
    ),
  );

  // ⑦ 出处覆盖率：<1 = 渲染器在砍 seq（fail）；evidence 缺失 = 源数据缺口（warn，不是渲染的锅）
  const missing = Number(ledger.evidenceMissing ?? 0);
  const coverageOk = ledger.provenanceCoverage === 1;
  out.push(
    check(
      "⑦出处覆盖率",
      coverageOk ? "ok" : "fail",
      coverageOk ? "" : `provenanceCoverage=${ledger.provenanceCoverage}（渲染器在砍 seq）`,
    ),
  );
  if (missing > 0) out.push(check("⑦b证据缺口", "warn", `${missing} 条失败边没有 evidence（老图/keeper 未记录）⇒ 模型无法回查`));

  // ⑧ 省略行可解析
  const omissions = omissionLines(text);
  const badOmissions = omissions.filter((line) => !line.includes("graph.json"));
  out.push(
    check(
      "⑧省略行可解析",
      badOmissions.length === 0 ? "ok" : "fail",
      omissions.length === 0 ? "本档没有省略行" : `${omissions.length} 行省略，${badOmissions.length} 行没有 graph.json 指向`,
    ),
  );

  // ⑨ 预算
  out.push(
    check(
      "⑨预算",
      ledger.fallback === "impossible" ? "fail" : ledger.fallback === "over-budget" ? "warn" : "ok",
      `${ledger.fallback} tokens=${ledger.tokens}/${ledger.budgetMax ?? maxTokens} level=L${ledger.level}`,
    ),
  );

  // ⑩ 保真度（fold-quality L1，2026-11-01）：最近一次有质量样本的 fold 有没有把约束/失败边留住。
  //   判据：《重注入契约》§6 第 6b 行 —— constraintRecall 必须 = 1（丢一条约束 = 任务变了 ⇒ fail）；
  //   failureRecall < 1 ⇒ warn（丢一条失败边 = 下一个模型必然重踩）；expected 全 0 ⇒ 真空样本（warn）。
  const allMarks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const qualityMarks = allMarks.filter((m) => m?.quality);
  const latestQuality = qualityMarks.at(-1)?.quality ?? null;
  if (allMarks.length === 0) {
    // 没 fold 过就没有「压缩产物」可评 —— 这不是缺陷，不该拉高告警数（否则门禁满屏噪声）。
    out.push(check("⑩保真度", "ok", "本会话没有 fold 记录（无需保真度样本）"));
  } else if (latestQuality === null) {
    out.push(check("⑩保真度", "warn", `${allMarks.length} 次 fold 都没有 quality（旧版本折叠；升级后会自然出现）`));
  } else {
    const c = Number(latestQuality.constraintRecall ?? 1);
    const f = Number(latestQuality.failureRecall ?? 1);
    const vacuum = !(Number(latestQuality.expectedConstraints) > 0) && !(Number(latestQuality.expectedFailures) > 0);
    // ★ C38：真空样本（区间里本来就没有约束/失败边可丢）**不是缺陷** —— 逐会话报 warn 只会把门禁
    //   训练成「满屏噪声」。真正的盲区（**所有**样本都是真空）由 doctor 的保真度检查全局告警。
    out.push(
      check(
        "⑩保真度",
        c < 1 ? "fail" : f < 1 ? "warn" : "ok",
        `constraintRecall=${c} failureRecall=${f}` +
          `（期望 约束 ${latestQuality.expectedConstraints ?? "?"} / 失败边 ${latestQuality.expectedFailures ?? "?"}）` +
          (vacuum ? " · 真空样本（本区间没有约束/失败边可丢 —— 不算缺陷；全体真空由 doctor 全局告警）" : "") +
          (c < 1 ? ` · 丢失约束：${JSON.stringify(latestQuality.missingConstraints ?? [])}` : "") +
          (f < 1 ? ` · 丢失失败边：${JSON.stringify((latestQuality.missingFailures ?? []).slice(0, 5))}` : ""),
      ),
    );
  }

  // ⑫ fold 触发原因（C12）：context-overflow 出现 = 上下文已经溢出、压缩被迫自救
  //   （说明压缩没跟上增长）。对一个会话而言这是「压缩健康」的直接告警，不只是一个统计。
  const triggerMarks = allMarks.filter((m) => typeof m?.trigger === "string");
  if (allMarks.length === 0) {
    out.push(check("⑫触发原因", "ok", "本会话没有 fold 记录"));
  } else if (triggerMarks.length === 0) {
    out.push(check("⑫触发原因", "warn", `${allMarks.length} 次 fold 都没有 trigger（旧版本折叠；升级后自动出现）`));
  } else {
    const counts = new Map();
    for (const m of triggerMarks) counts.set(m.trigger, (counts.get(m.trigger) ?? 0) + 1);
    const overflow = counts.get("context-overflow") ?? 0;
    out.push(
      check(
        "⑫触发原因",
        overflow > 0 ? "warn" : "ok",
        [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" / ") +
          (overflow > 0 ? ` —— ${overflow} 次是「溢出后被迫自救」，压缩没跟上增长` : ""),
      ),
    );
  }

  // ⑪ 幻觉探针（fold-quality 的 findUnknownIds）：摘要里提到的 eN/nN 必须在图里找得到。
  //   非空 = 模型编造了节点/边编号（`docs/research/01…` 的「8 类语义错误」里的 hallucinated 类）。
  const unknown = [...new Set(qualityMarks.flatMap((m) => (Array.isArray(m.quality.unknownIds) ? m.quality.unknownIds : [])))].slice(0, 10);
  // ★ C104：除了「图里根本没有」，还有「图里有、但不在本次折叠区间」—— 后者幻觉探针沉默，却同样是错引用。
  const outOfRange = [...new Set(qualityMarks.flatMap((m) => (Array.isArray(m.quality.outOfRangeIds) ? m.quality.outOfRangeIds : [])))].slice(0, 10);
  const probeDetail = (() => {
    const parts = [];
    if (unknown.length > 0) parts.push(`摘要提到但图里没有：${unknown.join(", ")}`);
    if (outOfRange.length > 0) parts.push(`摘要提到但不在本次折叠区间：${outOfRange.join(", ")}`);
    if (parts.length > 0) return parts.join("；");
    return qualityMarks.length === 0 ? "没有质量样本（未采集）" : "";
  })();
  out.push(check("⑪幻觉探针", unknown.length === 0 && outOfRange.length === 0 ? "ok" : "warn", probeDetail));

  // ⑬ fold 边界（C31/C37）：切点落在工具调用中间 ⇒ 摘要引用的结果在区间外（悬空引用）。
  //   以前只有 doctor 在全局看，单会话交接门禁看不到；这里补齐，fail 与 doctor 的 error 同口径。
  {
    const boundaryMarks = allMarks.filter((m) => m?.boundary && typeof m.boundary.openAtEnd === "number");
    if (allMarks.length === 0) {
      out.push(check("⑬fold边界", "ok", "本会话没有 fold 记录"));
    } else if (boundaryMarks.length === 0) {
      out.push(check("⑬fold边界", "ok", "未采集（旧版本 fold 没有 boundary —— 升级后自动出现）"));
    } else {
      const open = boundaryMarks.reduce((sum, m) => sum + (m.boundary.openAtEnd ?? 0), 0);
      out.push(
        check(
          "⑬fold边界",
          open > 0 ? "fail" : "ok",
          open > 0
            ? `${open} 次 fold 的切点落在工具调用中间（摘要会引用区间外的结果）`
            : `${boundaryMarks.length} 次 fold 都切在 step 边界（openAtEnd=0）`,
        ),
      );
    }
  }

  // ⑭ fold 成本口径（C43 的指标，C78 补进交接门禁）：遮蔽占读入 < 30% = 折得太碎/太早。
  //   以前只有 doctor 在全局看；单会话交接时「这次压缩是不是白折了」同样需要判据。
  {
    const withCost = allMarks.filter((m) => typeof m?.shadowedTokens === "number" && m?.usage && typeof m.usage.inputTokens === "number");
    if (allMarks.length === 0) {
      out.push(check("⑭fold成本", "ok", "本会话没有 fold 记录"));
    } else if (withCost.length === 0) {
      out.push(check("⑭fold成本", "ok", "未采集（旧版本 fold 没有 usage/shadowedTokens —— 升级后自动出现）"));
    } else {
      const shares = withCost.map((m) => m.shadowedTokens / Math.max(1, m.usage.inputTokens));
      const min = Math.min(...shares);
      out.push(
        check(
          "⑭fold成本",
          min < 0.3 ? "warn" : "ok",
          min < 0.3
            ? `最低一次遮蔽只占输入 ${(min * 100).toFixed(0)}%（折太碎/太早 —— 对照 doctor 的 ROI 看）`
            : `${withCost.length} 次 fold 的遮蔽占读入最低 ${(min * 100).toFixed(0)}%（健康）`,
        ),
      );
    }
  }

  // ⑮ fold 悬空（C35 的指标，C79 补进交接门禁）：liveUnsettled > 0 = 切在动作中间（warn）；
  //   fromBroken > 0 = 图已坏（fail）。doctor 只有全局口径，单会话交接同样需要判据。
  {
    const withDangling = allMarks.filter((m) => m?.dangling && typeof m.dangling.liveUnsettled === "number");
    if (allMarks.length === 0) {
      out.push(check("⑮fold悬空", "ok", "本会话没有 fold 记录"));
    } else if (withDangling.length === 0) {
      out.push(check("⑮fold悬空", "ok", "未采集（旧版本 fold 没有 dangling —— 升级后自动出现）"));
    } else {
      const live = withDangling.reduce((sum, m) => sum + (m.dangling.liveUnsettled ?? 0), 0);
      const broken = withDangling.reduce((sum, m) => sum + (m.dangling.fromBroken ?? 0), 0);
      out.push(
        check(
          "⑮fold悬空",
          broken > 0 ? "fail" : live > 0 ? "warn" : "ok",
          broken > 0
            ? `${broken} 条边指向不存在的节点（图损坏，先查数据）`
            : live > 0
              ? `${live} 条边在 fold 时未结算（可能切在动作中间 —— 结合 ⑬ 看）`
              : `${withDangling.length} 次 fold 的悬空边均为 0（liveUnsettled=0 / fromBroken=0）`,
        ),
      );
    }
  }

  // ⑯ 闭包自洽（C79）：foldMark 的 closure 必须与 seq 区间/图规模自洽 —— 这是「可回查」的前提，
  //   数据坏了（seqStart > seqEnd、nodes 超过图节点数）会让「按闭包回查」变成空承诺。
  {
    const withClosure = allMarks.filter((m) => m?.closure && typeof m.closure.nodes === "number");
    const bad = withClosure.filter((m) => {
      const start = Number(m.seqStart);
      const end = Number(m.seqEnd);
      const graphNodes = Number(m.closure.graphNodes ?? NaN);
      if (Number.isFinite(start) && Number.isFinite(end) && start > end) return true;
      if (Number.isFinite(graphNodes) && m.closure.nodes > graphNodes) return true;
      return false;
    });
    if (allMarks.length === 0) out.push(check("⑯闭包自洽", "ok", "本会话没有 fold 记录"));
    else if (withClosure.length === 0) out.push(check("⑯闭包自洽", "ok", "未采集（旧版本 fold 没有 closure —— 升级后自动出现）"));
    else {
      const preGraph = withClosure.filter((m) => m.closure.preGraph === true).length;
      out.push(
        check(
          "⑯闭包自洽",
          bad.length > 0 ? "fail" : "ok",
          bad.length > 0
            ? `${bad.length} 条 foldMark 的闭包与区间不一致（seqStart>seqEnd 或 nodes>graphNodes）`
            : `${withClosure.length} 条闭包自洽${preGraph > 0 ? `（其中 ${preGraph} 次区间早于本图，已在摘要里标注）` : ""}`,
        ),
      );
    }
  }

  return { ledger, facts, checks: out };
}

/* ───────────────────────────── CLI ───────────────────────────── */

function main() {
  if (!nodeFs.existsSync(sessionsRoot)) {
    console.error(`没有会话目录：${sessionsRoot}（用 DSH_HOME 指到正确的 home）`);
    process.exitCode = 2;
    return;
  }
  const dirs = nodeFs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => nodePath.join(sessionsRoot, d.name))
    .filter((dir) => nodeFs.existsSync(nodePath.join(dir, "graph.json")));

  const reports = [];
  for (const dir of dirs) {
    let graph;
    try {
      // ★ C183：必须重放 delta —— 这是七道门禁之一，读基线会让「证据数字」系统性偏低
      //   （fold 之后新增的节点/边全在 delta 里）。与运行时 load / doctor / graph-audit 同口径。
      graph = loadSessionGraph(nodePath.join(dir, "graph.json")).graph;
    } catch (error) {
      reports.push({ session: nodePath.basename(dir), error: String(error?.message ?? error), checks: [] });
      continue;
    }
    reports.push({ session: nodePath.basename(dir), result: checkGraph(graph, { treeDir: dir }) });
  }

  const flat = reports.flatMap((r) => r.result?.checks ?? []);
  const fail = flat.filter((c) => c.level === "fail").length;
  const warn = flat.filter((c) => c.level === "warn").length;

  if (asJson) {
    console.log(JSON.stringify({ sessions: reports.length, fail, warn, reports }, null, 1));
  } else {
    console.log(`== 压缩产物交接测试（${reports.length} 个会话 · ${sessionsRoot}）==`);
    for (const report of reports) {
      if (report.error) {
        console.log(`  ✗ ${report.session} —— 图读不出：${report.error}`);
        continue;
      }
      const bad = report.result.checks.filter((c) => c.level !== "ok");
      const mark = report.result.checks.some((c) => c.level === "fail") ? "✗" : bad.length > 0 ? "!" : "✓";
      const detail = bad.length === 0 ? "" : ` — ${bad.map((c) => `${c.name}${c.level === "fail" ? "(FAIL)" : "(warn)"}${c.detail ? `: ${c.detail}` : ""}`).join("；")}`;
      console.log(`  ${mark} ${report.session}${detail}`);
    }
    console.log(`\n${fail === 0 ? "✅" : "❌"} FAIL ${fail} / WARN ${warn}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

// 作为脚本直接跑才执行 CLI（被 import 时只导出 checkGraph）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
