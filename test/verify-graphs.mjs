/**
 * verify-graphs.mjs —— 全库棋谱健康检查（P0 worldHash 类型契约的验收工具）
 *
 * 用途：把 `<DSH_HOME>/chess-context/sessions/<sessionId>/graph.json` 全部过一遍
 * `fromJSON()`，校验三件事：
 *   1. 加载后 agent 节点的 `worldHash` / `constraintHash` 全是**字符串**
 *      （事故：v1.3.4 把 `worldstate.hash()` 的 `{hash,mode,files}` 对象写进了节点，
 *       ledger 的 `.slice()` 抛 TypeError → 226 次压缩只成功 3 次）
 *   2. 加载后 `renderFacts()` 不抛错（这是 summarize() 的第一步，抛错 = 压缩 100% 失败）
 *   3. 重新序列化（下一次 flush 写回的形态）不再有对象残留
 * 另外报告 `stateIndex` 的条目数（置换检测是否可用）—— 加载时按节点字段重建。
 *
 * 用法：
 *   node test/verify-graphs.mjs                 # 用 DSH_HOME 或默认路径
 *   node test/verify-graphs.mjs <sessions目录>  # 指定目录
 *   node test/verify-graphs.mjs --json          # 只输出 JSON（给脚本用）
 *   node test/verify-graphs.mjs <目录> --strict # 开启不变量门禁（S1a）
 *
 * 退出码：0 = 全健康；1 = 有任何一条不健康（对象残留 / renderFacts 抛错 / 解析失败），
 *         或 --strict 下任一图违反不变量；2 = 参数错误（未知参数 / 数值非法 / 多余位置参数）。
 * 注意：本脚本**只读**，不写任何 graph.json —— 磁盘痊愈靠插件下次 flush。
 *
 * ★ S1a（2026-10-29）：新增**可选**的 --strict 不变量门禁（退化图 / 自环 / 边节点比 / 坍缩图）。
 *   - 默认模式（文档化调用：无参 / `<目录>` / `--json`）**行为不变**：一条不变量都不判、
 *     退出码只看 problems，输出与 1.9.1 逐字节一致。
 *     ★ 注意：旧文本模式**不打印** `row.warnings`（1.9.1 就是如此）—— 只有 `--json` 的
 *       `rows[].warnings` 里有这些警告。别以为默认模式会显示「疑似重试风暴」之类的 warn 行。
 *   - 严格模式**逐图**判定（不做全局聚合 —— 聚合会把一张坏图稀释掉），
 *     任一图违反 ⇒ 退出码 1，并打印每张失败图的完整 session 标识 + 具体数值 + 判据；
 *     ★ 严格模式下**逐图 ✓/✗、末尾结论、JSON 的 `summary.unhealthySessions` 与
 *       `payload.strict.ok` 全部与退出码同口径**：坏图不会再先打 ✓，也不会再打印
 *       「== 全部健康 ==」这种只看 problems 的旧结论。
 *   - 判据的数学定义、阈值出处、空图/单节点/边界语义见 `test/graph-invariants.mjs` 顶部注释。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fromJSON, toJSON, graphHealth } from "../src/graph.mjs";
import { renderFacts, renderLedger } from "../src/ledger.mjs";
import { checkGraphs, checkGraphsWithExemptions, parseArgs, usageText } from "./graph-invariants.mjs";
import { graphFingerprint, parseExemptions, todayIso } from "./graph-exemptions.mjs";

function defaultRoot() {
  const home = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
  return nodePath.join(home, "chess-context", "sessions");
}

const argv = process.argv.slice(2);
const cli = parseArgs(argv);
if (cli.errors.length > 0) {
  for (const error of cli.errors) console.error(`参数错误：${error}`);
  console.error("");
  console.error(usageText());
  process.exit(2);
}
if (cli.help) {
  console.log(usageText());
  process.exit(0);
}
const asJson = cli.json;
const strict = cli.strict;
const limits = cli.limits;
const root = cli.root ?? defaultRoot();

/**
 * C-13 历史豁免清单：**只有 --strict 下才有意义**（默认模式不判不变量，豁免无从谈起）。
 * 清单读不懂就当场 exit 2 —— 一份读不懂的清单既不能当「空清单」（等于静默取消豁免），
 * 更不能当「全放行」（红线会消失）。
 */
let manifest = null;
if (cli.exemptions !== null) {
  if (!strict) {
    console.error("参数错误：--exemptions 只在 --strict 下有效（默认模式不判不变量，没有可豁免的东西）");
    console.error("");
    console.error(usageText());
    process.exit(2);
  }
  let text;
  try {
    text = nodeFs.readFileSync(cli.exemptions, "utf8");
  } catch (error) {
    console.error(`参数错误：读不到豁免清单 ${cli.exemptions}：${String(error.message ?? error)}`);
    process.exit(2);
  }
  manifest = parseExemptions(text);
  if (!manifest.ok) {
    for (const error of manifest.errors) console.error(`豁免清单错误：${error}`);
    console.error("");
    console.error(`文件：${cli.exemptions}`);
    process.exit(2);
  }
}

if (!nodeFs.existsSync(root)) {
  console.error(`找不到棋谱目录：${root}`);
  process.exit(1);
}

const rows = [];
/** 成功加载的图（S1a 严格门禁只对它们判定；解析失败的图已计入 problems）。 */
const loaded = [];
/** 每张图的原始内容指纹（C-13：豁免要求「图内容一字未改」）。session → sha256。 */
const fingerprints = {};
let bad = 0;

for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = nodePath.join(root, entry.name, "graph.json");
  if (!nodeFs.existsSync(file)) continue;

  const row = {
    session: entry.name,
    agents: 0,
    objectWorldHashBefore: 0,
    objectWorldHashAfter: 0,
    stateIndexBefore: 0,
    stateIndexAfter: 0,
    factsChars: 0,
    ledgerTokens: 0,
    edges: 0,
    nodes: 0,
    selfLoops: 0,
    selfLoopRate: 0,
    edgePerNode: 0,
    warnings: [],
    problems: [],
  };

  let raw;
  try {
    raw = nodeFs.readFileSync(file, "utf8");
  } catch (error) {
    row.problems.push(`读文件失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    row.problems.push(`JSON 解析失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  const agentsOf = (g) => Object.values(g.nodes ?? {}).filter((n) => n && n.kind === "agent");
  row.agents = agentsOf(parsed).length;
  row.objectWorldHashBefore = agentsOf(parsed).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  row.stateIndexBefore = Object.keys(parsed.stateIndex ?? {}).length;

  let g;
  try {
    g = fromJSON(raw);
  } catch (error) {
    row.problems.push(`fromJSON 失败：${String(error)}`);
    bad += 1;
    rows.push(row);
    continue;
  }

  loaded.push({ session: entry.name, sessionId: String(g.sessionId ?? ""), graph: g });
  // 指纹取**原始** JSON（fromJSON 之后的派生修复不算图内容变了，见 graph-exemptions.mjs）
  try {
    fingerprints[entry.name] = graphFingerprint(JSON.parse(raw)).sha256;
  } catch {
    fingerprints[entry.name] = "";
  }

  row.objectWorldHashAfter = agentsOf(g).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  row.stateIndexAfter = Object.keys(g.stateIndex ?? {}).length;
  if (row.objectWorldHashAfter > 0) row.problems.push(`加载后仍有 ${row.objectWorldHashAfter} 个对象的 worldHash`);

  for (const node of agentsOf(g)) {
    if (typeof node.worldHash !== "string") row.problems.push(`${node.id}.worldHash 类型 ${typeof node.worldHash}`);
    if (typeof node.constraintHash !== "string") row.problems.push(`${node.id}.constraintHash 类型 ${typeof node.constraintHash}`);
  }

  try {
    row.factsChars = renderFacts(g).length;
  } catch (error) {
    row.problems.push(`renderFacts 抛错：${String(error)}`);
  }

  // 热清单也过一遍：它每步都渲染，是这条链路上最先炸的消费者之一
  try {
    row.ledgerTokens = renderLedger(g, { maxTokens: 500 }).tokens;
  } catch (error) {
    row.problems.push(`renderLedger 抛错：${String(error)}`);
  }

  const h = graphHealth(g);
  row.edges = h.edges;
  row.nodes = h.nodes;
  row.selfLoops = h.selfLoops;
  row.selfLoopRate = h.selfLoopRate;
  row.edgePerNode = h.edgePerNode;
  if (h.selfLoopRate >= 0.05) {
    row.warnings.push(`自环 ${h.selfLoops}/${h.edges} = ${(h.selfLoopRate * 100).toFixed(1)}% 图已坍缩，手割结论不可信`);
  }
  // 边/节点比只是信息：一步 K 次工具调用 ⇒ K 条边 + 1 节点。>8 才可能是异常（重试风暴）。
  if (h.edgePerNode > 8) row.warnings.push(`边/节点 ${h.edgePerNode.toFixed(2)} 大于 8，疑似重试风暴`);

  const round = JSON.parse(toJSON(g));
  const objectAfterRound = agentsOf(round).filter((n) => typeof n.worldHash === "object" && n.worldHash !== null).length;
  if (objectAfterRound > 0) row.problems.push(`重新序列化后仍有 ${objectAfterRound} 个对象`);

  if (row.problems.length > 0) bad += 1;
  rows.push(row);
}

const total = rows.reduce(
  (acc, r) => ({
    sessions: acc.sessions + 1,
    agents: acc.agents + r.agents,
    before: acc.before + r.objectWorldHashBefore,
    after: acc.after + r.objectWorldHashAfter,
    idxBefore: acc.idxBefore + r.stateIndexBefore,
    idxAfter: acc.idxAfter + r.stateIndexAfter,
    edges: acc.edges + r.edges,
    nodes: acc.nodes + r.nodes,
    selfLoops: acc.selfLoops + r.selfLoops,
    unhealthyGraphs: acc.unhealthyGraphs + (r.selfLoopRate >= 0.05 ? 1 : 0),
  }),
  { sessions: 0, agents: 0, before: 0, after: 0, idxBefore: 0, idxAfter: 0, edges: 0, nodes: 0, selfLoops: 0, unhealthyGraphs: 0 },
);

const summary = {
  root,
  sessions: total.sessions,
  agents: total.agents,
  objectWorldHash: { before: total.before, after: total.after },
  stateIndex: { before: total.idxBefore, after: total.idxAfter },
  unhealthySessions: bad,
  graphHealth: {
    edges: total.edges,
    nodes: total.nodes,
    selfLoops: total.selfLoops,
    selfLoopRate: total.edges > 0 ? total.selfLoops / total.edges : 0,
    edgePerNode: total.nodes > 0 ? total.edges / total.nodes : 0,
    collapsedGraphs: total.unhealthyGraphs,
  },
};

/**
 * S1a 严格门禁：**逐图**判定（不做全局聚合 —— 下面这张表按行计数相加：3 图 23 边 / 7 节点 = 3.29，
 * 而其中一张是 8.5，会被两张好图稀释）。默认模式不构造 gate，行为与 1.9.1 完全一致。
 */
const gate = strict
  ? manifest
    ? checkGraphsWithExemptions(loaded, limits, manifest, { fingerprints })
    : // 无清单：结构补齐为空数组，让下方报告段只有一条路径（不足为凭的字段不能是 undefined）
      Object.assign(checkGraphs(loaded, limits), { exempted: [], expired: [], missed: [], preExemptionFailed: 0 })
  : null;

/**
 * 严格模式下的「不健康会话」= problems 失败 ∪ 不变量失败（按 session 去重）。
 * 两者可能落在同一张图上（例如加载成功但 renderFacts 抛错 + 又有自环），所以用集合而不是相加。
 * 默认模式仍只用 problems（bad），语义与 1.9.1 一致。
 */
const problemSessions = new Set(rows.filter((r) => r.problems.length > 0).map((r) => r.session));
const invariantSessions = new Set(gate ? gate.failed.map((item) => item.session) : []);
const unhealthySessions = gate ? new Set([...problemSessions, ...invariantSessions]).size : bad;
/** 严格模式的唯一裁决字段：与 process.exitCode 严格同口径（true ⇔ 退出码 0）。 */
const strictOk = gate !== null && gate.ok && gate.checked > 0 && unhealthySessions === 0;
// problems 里有多少张**没有**同时被不变量判红（文本里给「另有 N 个」用，避免重复计数）
const problemOnlyCount = [...problemSessions].filter((session) => !invariantSessions.has(session)).length;
// 严格模式下把 summary 的口径改成「problems ∪ 不变量」，消费方不必在 summary / strict 之间猜；
// 默认模式的 bad 与这里同值，输出逐字节不变。
summary.unhealthySessions = unhealthySessions;

if (asJson) {
  const payload = { summary, rows };
  if (gate) {
    payload.strict = {
      enabled: true,
      limits: gate.limits,
      checked: gate.checked,
      // ★ 唯一裁决：与退出码一致（空目录 / 有 problems 时也为 false）
      ok: strictOk,
      failed: gate.failed.length,
      // problems 失败的会话数（不变量失败见 failed；两者去重后是 summary.unhealthySessions）
      problemSessions: problemSessions.size,
      graphs: gate.graphs.map((item) => ({
        session: item.session,
        sessionId: item.sessionId,
        ok: item.ok,
        metrics: item.metrics,
        violations: item.violations.map((v) => ({ code: v.code, value: v.value, limit: v.limit, message: v.message })),
        ...(item.exempted && item.exempted.length ? { exempted: item.exempted.map((x) => x.code) } : {}),
      })),
    };
    // C-13：只有给了清单才出现 exemptions 段。字段全给，审计方不用猜。
    if (manifest) {
      payload.strict.exemptions = {
        file: cli.exemptions,
        entries: manifest.entries.length,
        applied: gate.exempted.length,
        preExemptionFailed: gate.preExemptionFailed,
        // 「豁免 ≠ 通过」：这个数字是**被豁免吸收的**违规条数，不是通过数
        appliedDetail: gate.exempted.map((x) => ({
          session: x.session,
          sessionId: x.sessionId,
          code: x.code,
          value: x.value,
          registeredE: x.registeredE,
          registeredN: x.registeredN,
          registeredL: x.registeredL,
          reason: x.reason,
          registeredBy: x.registeredBy,
          registeredOn: x.registeredOn,
          expiresOn: x.expiresOn,
          source: x.source,
        })),
        expired: gate.expired.map((x) => ({ session: x.session, sessionId: x.sessionId, code: x.code, expiresOn: x.entry?.expiresOn ?? null, reasons: x.reasons })),
        missed: gate.missed.map((x) => ({ session: x.session, sessionId: x.sessionId, code: x.code, reasons: x.reasons })),
      };
    }
  }
  console.log(JSON.stringify(payload, null, 1));
} else {
  console.log(`== verify-graphs（${root}）==`);
  const strictBySession = gate ? new Map(gate.graphs.map((item) => [item.session, item])) : null;
  for (const r of rows) {
    const invariant = strictBySession?.get(r.session);
    // 严格模式下 ✓/✗ 必须同时反映 problems 与不变量，否则会出现「坏图先打 ✓」。
    const mark = r.problems.length === 0 && (!invariant || invariant.ok) ? "✓" : "✗";
    console.log(
      `  ${mark} ${r.session.slice(0, 34).padEnd(36)} agent ${String(r.agents).padStart(4)}  ` +
        `对象 ${r.objectWorldHashBefore}→${r.objectWorldHashAfter}  ` +
        `stateIndex ${r.stateIndexBefore}→${r.stateIndexAfter}  ` +
        `facts ${r.factsChars} 字 / ledger ${r.ledgerTokens} tok` +
        (r.problems.length ? `\n      ${r.problems.join("\n      ")}` : "") +
        (invariant && !invariant.ok ? `\n      不变量：${invariant.violations.map((v) => v.code).join(", ")}` : ""),
    );
  }
  console.log(
    `\n合计：${summary.sessions} 个会话 / ${summary.agents} 个 agent 节点 / ` +
      `对象 worldHash ${summary.objectWorldHash.before} → ${summary.objectWorldHash.after} / ` +
      `stateIndex ${summary.stateIndex.before} → ${summary.stateIndex.after}`,
  );
  const gh = summary.graphHealth;
  console.log(
    "图结构：边 " + gh.edges + " / 节点 " + gh.nodes + " / 自环 " + gh.selfLoops +
      " = " + (gh.selfLoopRate * 100).toFixed(1) + "% / 边节点比 " + gh.edgePerNode.toFixed(2) +
      " / 坍缩图 " + gh.collapsedGraphs + " 个",
  );
  // ★ 严格模式不再打印只看 problems 的旧健康结论（它会与不变量判定矛盾）；
  //   默认模式保持 1.9.1 的原文，逐字节不变。
  if (!gate) console.log(bad === 0 ? "== 全部健康 ==" : bad + " 个会话不健康");
  if (gh.collapsedGraphs > 0) {
    console.log("");
    console.log("⚠ " + gh.collapsedGraphs + " 个图存在自环坍缩（修复前版本产生的历史边）；新产生的边已不再自环。");
    console.log("  历史边可用：node test/rewash-selfloop.mjs --apply（默认 dry-run）");
  }

  if (gate) {
    console.log("");
    console.log(
      `== 严格门禁（--strict）==\n` +
        `阈值：每图 自环 ≤ ${gate.limits.maxSelfLoops} / 边节点比 ≤ ${gate.limits.maxEdgePerNode} / 自环率 < ${(gate.limits.maxSelfLoopRate * 100).toFixed(1)}% / 退化图（N=0 且 E>0）禁止`,
    );
    const skipped = summary.sessions - loaded.length;
    if (skipped > 0) {
      console.log(`⚠ ${skipped} 张图解析失败，未参与不变量判定（原因见上方 problems；未参与 ≠ 通过）`);
    }
    // ★ C-13：豁免必须逐条打印，并明确「豁免 ≠ 通过」。绝不把豁免折叠成一句「OK」。
    if (gate.exempted.length > 0) {
      console.log("");
      console.log(`豁免 ${gate.exempted.length} 条已登记的历史违规（来自 ${cli.exemptions}）—— 豁免 ≠ 通过：`);
      for (const x of gate.exempted) {
        console.log(`  ⊘ ${x.session}  ${x.code} = ${typeof x.value === "number" && x.code === "edge-per-node" ? x.value.toFixed(2) : x.value}`);
        console.log(`      登记值：E=${x.registeredE} / N=${x.registeredN} / L=${x.registeredL}（${x.code}） 有效期至 ${x.expiresOn}`);
        console.log(`      理由：${x.reason}`);
        console.log(`      登记：${x.registeredBy} @ ${x.registeredOn}；来源：${x.source}`);
      }
      if (gate.preExemptionFailed > gate.failed.length) {
        console.log(`  豁免前 ${gate.preExemptionFailed} 张违规 → 豁免后 ${gate.failed.length} 张（其中 ${gate.exempted.length} 条违规被已登记条目吸收）`);
      }
    }
    if (gate.expired.length > 0) {
      console.log("");
      console.log(`⚠ ${gate.expired.length} 条豁免已过期（过期即失效，按违规判红；请重新评估后更新清单）：`);
      for (const x of gate.expired) console.log(`  ⌛ ${x.session}  ${x.code}：${x.reasons.join("；")}`);
    }
    if (gate.missed.length > 0 && manifest) {
      // 有清单但仍然红的 —— 把「为什么没被吸收」说清楚，否则等于让作者去猜
      console.log(`  ${gate.missed.length} 条违规未被清单吸收（新图 / 数值已变 / 判据未登记）：`);
      for (const x of gate.missed.slice(0, 20)) console.log(`      · ${x.session}  ${x.code}：${x.reasons.join("；")}`);
      if (gate.missed.length > 20) console.log(`      · 另 ${gate.missed.length - 20} 条`);
    }
    if (gate.checked === 0) {
      console.log("没有可检查的图（0 张）—— 空目录不构成门禁通过。");
      if (problemOnlyCount > 0) console.log(`⚠ 另有 ${problemOnlyCount} 个会话健康检查失败（未参与不变量判定）。`);
    } else if (gate.ok) {
      if (unhealthySessions === 0) {
        console.log(`✓ ${gate.checked} 张图全部满足不变量。`);
      } else {
        console.log(`✓ ${gate.checked} 张图全部满足不变量；但 ${problemOnlyCount} 个会话健康检查失败（见上方 ✗）。`);
      }
    } else {
      console.log(`✗ ${gate.failed.length} / ${gate.checked} 张图违反不变量：`);
      for (const item of gate.failed) {
        const label = item.sessionId && item.sessionId !== item.session ? `${item.session}（graph.sessionId=${item.sessionId}）` : item.session;
        console.log(`  ✗ ${label}`);
        for (const v of item.violations) console.log(`      · ${v.code}: ${v.message}`);
        console.log(
          `      · 度量：边 ${item.metrics.edges} / 节点 ${item.metrics.nodes} / 自环 ${item.metrics.selfLoops}` +
            ` / 自环率 ${(item.metrics.selfLoopRate * 100).toFixed(1)}% / 边节点比 ${item.metrics.edgePerNode.toFixed(2)}`,
        );
      }
      if (problemOnlyCount > 0) console.log(`  另有 ${problemOnlyCount} 个会话健康检查失败（见上方 ✗）。`);
    }
  }
}

process.exitCode = gate === null ? (bad === 0 ? 0 : 1) : strictOk ? 0 : 1;
