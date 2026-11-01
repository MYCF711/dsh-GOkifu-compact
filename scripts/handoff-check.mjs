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
  const hasRoot = Array.isArray(graph?.rootUserNodeIds) && graph.rootUserNodeIds.length > 0;
  out.push(check("①根目标", !hasRoot ? "warn" : text.includes("ROOT USER") ? "ok" : "fail", hasRoot ? "" : "图里没有 rootUserNodeIds（可能不是从用户消息开始的会话）"));

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
  const hasPath = text.includes("CURRENT PATH") || text.includes("# path:") || text.includes("# WORKING:");
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
      `${ledger.fallback} tokens=${ledger.tokens}/${ledger.maxTokens ?? maxTokens} level=L${ledger.level}`,
    ),
  );

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
      graph = fromJSON(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
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
