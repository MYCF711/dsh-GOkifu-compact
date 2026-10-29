/**
 * graph-invariants.mjs —— 图不变量门禁的纯判定层（S1a，2026-10-29）
 *
 * 为什么单独成文件，而不是塞进 `src/graph.mjs`：
 *   1. 它是**校验工具**的判断，不是运行期引擎的规则 —— engine / summarize 不该因为
 *      「门禁阈值」多走任何一个分支；
 *   2. 可独立卸载：删本文件 + 删 `test/verify-graphs.mjs` 的 strict 段 ⇒ 回到 1.9.1 行为；
 *   3. 可被单测直接 import —— `verify-graphs.mjs` 是顶层执行脚本，import 它就会扫描磁盘。
 *
 * ── 三个指标的数学定义（逐图独立计算；与 `src/graph.mjs` 的 `graphHealth()` 同口径）──
 *
 *   N = |Object.keys(g.nodes)|      节点表大小（**不是** `order.length`：order 可能引用已删节点）
 *   E = |Object.values(g.edges)|    边表大小
 *   L = #{ e : e.from && e.to && e.from === e.to }   两侧都有值且相等的边 = 自环
 *       ★ from / to 为 null / undefined / "" 的「未结算边」**不算**自环 —— 沿用
 *         `graphHealth()` 既有定义（`if (e.from && e.to && e.from === e.to)`），不另造口径。
 *
 *   edgePerNode = N > 0 ? E / N : 0     ← 空图定义为 0，不是 NaN / Infinity
 *   selfLoopRate = E > 0 ? L / E : 0    ← 空图定义为 0，不是 0/0
 *
 * 边界（全部有测试）：
 *   · 空图（N=0,E=0）      ⇒ 0 / 0 ⇒ 四条判据全绿（0 阈值也不能把它判红，见下）
 *   · 退化图（N=0,E>0）    ⇒ edgePerNode 记 0（不引入 Infinity），但 ④ 判红 —— 边没有可归属的节点
 *   · 单节点（N=1,E=0）    ⇒ edgePerNode 0 ⇒ 绿
 *   · 正常链（每步 1 边）   ⇒ edgePerNode ≈ 1 ⇒ 绿
 *   · 正常分支（一步 K 边） ⇒ 长期 edgePerNode → K，K 实测 1.5~3.4 是常态 ⇒ 不能当缺陷
 *
 * ── 四条判据与默认阈值（每条都有出处，不是拍脑袋）──
 *
 *   ① self-loop         L > maxSelfLoops（默认 0）
 *      出处：1.9.1 修复后新边不再自环；DAG 的每条边本应让局面前进，`from === to` 意味着
 *      「这一步没有移动」，会让 tewari 的同终点判定恒真（实测 dead 109/109 全错）。
 *   ② edge-per-node     edgePerNode > maxEdgePerNode（默认 8）
 *      出处：`test/verify-graphs.mjs`（1.9.1 起）既有的 warn 阈值「>8 疑似重试风暴」。
 *      ★ 方案书 §四 曾写「边/节点比 ≤ 1.5」—— **该数字没有任何代码或实测依据，且与
 *        `src/graph.mjs:400-402` 的注释直接矛盾**（那里写明「一个 step 若有 K 次工具调用，
 *        就产生 K 条边 + 1 个节点，K=2~5 是常态（实测健康会话 1.5~3.4），不能当缺陷」）。
 *        ★ 数学口径（别再说反）：设 S 步、每步 K 次工具调用 ⇒ N=1+S、E=K·S，
 *          edgePerNode = K·S/(1+S) → K（S→∞）。所以「≤1.5」的真实含义是
 *          **长期每步约 1.5 次工具调用**，而不是「每步只发 0.5 次」；
 *          只有把常态下沿 K=2 拿来比，才等价于「每步比常态少 0.5 次」。
 *        2026-10-29 实测（99 张真实图，`tmp/dsh-gokifu-compact/s1a/real-stats.json`）：
 *        自环为 0 的 96 张图里 edgePerNode 中位数 1.37、p75 2.50、p90 10.64、最大 23.04；
 *        若用 ≤1.5，**41/96 张健康图（42.7%）会被判红**，其中包括当天正常运行的 1.61 / 2.40
 *        图。所以阈值取既有代码的 8，并**显式参数化**（--max-edge-per-node），不照搬 1.5。
 *   ③ collapsed-graph   L > 0 且 selfLoopRate >= maxSelfLoopRate（默认 0.05）
 *      出处：`src/graph.mjs:418` 的 `healthy: selfLoopRate < 0.05` —— 与 doctor / 汇总行的
 *      「坍缩图」完全同一个口径。
 *      ★ 为什么条件是 `L > 0 &&`：若只写 `rate >= limit`，把 limit 设成 0 时空图（rate=0）
 *        会被判红 —— 「没有自环的图被判坍缩」是明显的假红。加上 L > 0 后，
 *        `--max-self-loop-rate=0` 的语义是「任何一条自环都算坍缩」，空图仍绿。
 *      ★ 与 ① 的关系（说清楚，不拿冗余判据凑数）：默认配置（maxSelfLoops=0）下，
 *        **③ 蕴含 ①**（坍缩 ⇒ 有自环 ⇒ self-loop 红），不是反过来。
 *        反例（有测试）：2 条自环 / 50 条边 = 4% < 5% ⇒ ① 红、③ 绿。
 *        所以 ③ 不是 ① 的替代品，只是「同一批自环里更严重的那一类」的额外标注；
 *        它**独立于 ① 生效**只有一条路径：**放宽 ①** 时，例如
 *        `--max-self-loops=2` 且某图 2 条自环 / 40 条边（rate 恰 5%）⇒ ① 绿、③ 红。
 *        这条路径有专门测试（"坍缩图：放宽自环数后仍能独立触发"），变异 M3 也证明它会真红。
 *   ④ degenerate-graph  N === 0 且 E > 0（无阈值，结构性）
 *      为什么单独成判据：edgePerNode 的分母是 N，N=0 时按既有口径记 0，比率判据永远不触发；
 *      但「有边、没有任何节点」意味着所有边都无归属，图不可回溯，必须明确判红。
 *      ★ 不把 0/0 或 E/0 算成 Infinity —— 那会让 JSON.stringify 把 value 写成 null。
 *        详情用**有限的边数**（value=E）表达，metric 仍记 0（与 graphHealth 口径一致）。
 *      空图（N=0,E=0）不在本条：没有边就没有「无归属的边」，仍按既有约定判绿。
 */

import { applyExemptions, findExemption, parseExemptions, todayIso } from "./graph-exemptions.mjs";

/** 默认门禁阈值。改这里 = 改门禁，必须同步计划表与测试。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxSelfLoops: 0,
  maxEdgePerNode: 8,
  maxSelfLoopRate: 0.05,
});

/** 判据代号（输出与测试都用它定位，不靠文案）。 */
export const INVARIANT_CODES = Object.freeze(["degenerate-graph", "self-loop", "edge-per-node", "collapsed-graph"]);

/** 输出里每张图最多列出的自环边 id 数（其余折成「另 N 条」，避免 509 条边刷屏）。 */
const MAX_LISTED_SELF_LOOP_EDGES = 5;

/**
 * 逐图度量。三个指标与 `src/graph.mjs` 的 `graphHealth()` **逐值相同**（有测试锁定）。
 * 额外给出 selfLoopEdges / openEdges 只为报告用，不参与判定。
 *
 * @param {object} g 棋谱（`fromJSON()` 之后的形态）
 * @returns {{edges:number,nodes:number,selfLoops:number,selfLoopEdges:string[],openEdges:number,selfLoopRate:number,edgePerNode:number}}
 */
export function measureGraph(g) {
  const edges = Object.values(g?.edges ?? {});
  const nodes = Object.keys(g?.nodes ?? {}).length;
  const selfLoopEdges = [];
  let openEdges = 0;
  for (const e of edges) {
    if (!e) continue;
    if (!e.to) openEdges += 1;
    if (e.from && e.to && e.from === e.to) selfLoopEdges.push(String(e.id ?? "(no-id)"));
  }
  const edgeCount = edges.length;
  const selfLoops = selfLoopEdges.length;
  return {
    edges: edgeCount,
    nodes,
    selfLoops,
    selfLoopEdges,
    openEdges,
    selfLoopRate: edgeCount > 0 ? selfLoops / edgeCount : 0,
    edgePerNode: nodes > 0 ? edgeCount / nodes : 0,
  };
}

function formatSelfLoopEdges(ids) {
  if (ids.length === 0) return "无";
  const shown = ids.slice(0, MAX_LISTED_SELF_LOOP_EDGES).join(", ");
  return ids.length > MAX_LISTED_SELF_LOOP_EDGES ? `${shown} … 另 ${ids.length - MAX_LISTED_SELF_LOOP_EDGES} 条` : shown;
}

/**
 * 单图判定。
 *
 * @param {{session:string, sessionId?:string, graph:object, limits?:object}} input
 * @returns {{session:string, sessionId:string, ok:boolean, violations:{code:string,message:string,value:number,limit:number}[], metrics:object}}
 */
export function checkGraph({ session, sessionId = "", graph, limits = DEFAULT_LIMITS }) {
  const metrics = measureGraph(graph);
  const violations = [];

  // ★ N=0 且 E>0：边表还在、节点表被清空 ⇒ 所有边无归属。此时 edgePerNode 的分母为 0，
  //   既有口径把它记作 0（不引入 Infinity），比率判据永远不会触发 —— 必须单独判红。
  //   空图（N=0,E=0）不在此列：没有边就没有「无归属的边」，仍按既有约定判绿。
  if (metrics.nodes === 0 && metrics.edges > 0) {
    violations.push({
      code: "degenerate-graph",
      value: metrics.edges,
      limit: 0,
      message: `有 ${metrics.edges} 条边但 0 个节点（边无归属，图结构不可回溯）`,
    });
  }

  if (metrics.selfLoops > limits.maxSelfLoops) {
    violations.push({
      code: "self-loop",
      value: metrics.selfLoops,
      limit: limits.maxSelfLoops,
      message: `自环 ${metrics.selfLoops} 条 > 上界 ${limits.maxSelfLoops}（边 ${formatSelfLoopEdges(metrics.selfLoopEdges)}）`,
    });
  }

  if (metrics.edgePerNode > limits.maxEdgePerNode) {
    violations.push({
      code: "edge-per-node",
      value: metrics.edgePerNode,
      limit: limits.maxEdgePerNode,
      message: `边/节点 ${metrics.edgePerNode.toFixed(2)} > 上界 ${limits.maxEdgePerNode}（${metrics.edges} 条边 / ${metrics.nodes} 个节点）`,
    });
  }

  if (metrics.selfLoops > 0 && metrics.selfLoopRate >= limits.maxSelfLoopRate) {
    violations.push({
      code: "collapsed-graph",
      value: metrics.selfLoopRate,
      limit: limits.maxSelfLoopRate,
      message: `自环率 ${(metrics.selfLoopRate * 100).toFixed(1)}% ≥ 上界 ${(limits.maxSelfLoopRate * 100).toFixed(1)}%（${metrics.selfLoops}/${metrics.edges} 条边）`,
    });
  }

  return { session: String(session ?? ""), sessionId: String(sessionId ?? ""), ok: violations.length === 0, violations, metrics };
}

/**
 * 多图判定。**逐图**判，不做全局聚合 —— 全局聚合会把一张坏图稀释掉（CLI 全局口径：3 图 23 边 / 7 节点 = 3.29，
 * 而其中一张是 8.5；测试合并图必须给 node/edge id 加唯一前缀，直接 spread 会撞 id、不是相加）。
 *
 * @param {{session:string, sessionId?:string, graph:object}[]} items
 * @param {object} [limits]
 * @returns {{ok:boolean, limits:object, graphs:object[], failed:object[], checked:number}}
 */
export function checkGraphs(items, limits = DEFAULT_LIMITS, exemptions = null) {
  const graphs = items.map((item) => checkGraph({ ...item, limits }));
  const failed = graphs.filter((x) => !x.ok);
  return { ok: failed.length === 0, limits, graphs, failed, checked: graphs.length };
}

/**
 * 带历史豁免的判定（C-13）。与 `checkGraphs` 的唯一区别：逐条违规先过一次豁免清单。
 *
 * ★ 什么时候用：`--strict` 且给了 `--exemptions`。默认/不给清单时**一个字都不变**。
 * ★ 返回结构在 `checkGraphs` 的结果上**只增不减**：`graphs[].violations` 里只剩**未豁免**的
 *   违规（所以 `ok` 是真实结论），被豁免的单独放 `graphs[].exempted` / 顶层 `exempted`。
 *   「豁免 ≠ 通过」靠三件事同时成立来保证：① 被豁免条目逐条打印 ② `exempted` 非空时
 *   结论行明说「豁免 N 条」③ 有 `expired` / `missed` 时同样打印原因。
 */
export function checkGraphsWithExemptions(items, limits, manifest, { fingerprints = {}, today = todayIso() } = {}) {
  const gate = checkGraphs(items, limits);
  const applied = applyExemptions(gate, manifest, { fingerprints, today });
  return { ...applied, preExemptionFailed: gate.failed.length };
}

/* ────────────────────────── CLI 参数 ────────────────────────── */

const NUMERIC_FLAGS = {
  "max-self-loops": { key: "maxSelfLoops", integer: true, min: 0, label: "自环边数上界" },
  "max-edge-per-node": { key: "maxEdgePerNode", integer: false, min: 0, label: "每张图的边/节点比上界" },
  "max-self-loop-rate": { key: "maxSelfLoopRate", integer: false, min: 0, max: 1, label: "每张图的自环率上界（0~1）" },
};

/**
 * 解析 CLI 参数（纯函数，不碰磁盘）。**未知参数一律报错** —— 静默忽略 `--strct` 这种拼写错误
 * 等于给出一个假绿的门禁。
 *
 * @param {string[]} argv
 * @returns {{root:string|null, json:boolean, strict:boolean, help:boolean, limits:object, errors:string[]}}
 */
export function parseArgs(argv = []) {
  const limits = { ...DEFAULT_LIMITS };
  const out = { root: null, json: false, strict: false, help: false, limits, exemptions: null, errors: [] };
  const positional = [];

  for (const arg of argv) {
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--strict") {
      out.strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--exemptions")) {
      const eq = arg.indexOf("=");
      const raw = eq < 0 ? "" : arg.slice(eq + 1);
      if (eq < 0 || raw.trim() === "") {
        out.errors.push("--exemptions 需要一个路径，写成 --exemptions=<文件>（历史豁免清单）");
      } else {
        out.exemptions = raw;
      }
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq < 0) {
        out.errors.push(`未知参数 ${arg}（数值参数要写成 --name=value）`);
        continue;
      }
      const name = arg.slice(2, eq);
      const raw = arg.slice(eq + 1);
      const spec = NUMERIC_FLAGS[name];
      if (!spec) {
        out.errors.push(`未知参数 --${name}`);
        continue;
      }
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || (spec.integer && !Number.isInteger(value))) {
        out.errors.push(`--${name} 需要${spec.integer ? "整数" : "数字"}，收到 ${JSON.stringify(raw)}`);
        continue;
      }
      if (value < spec.min || (spec.max !== undefined && value > spec.max)) {
        out.errors.push(`--${name} 超出范围 [${spec.min}, ${spec.max ?? "∞"}]，收到 ${value}`);
        continue;
      }
      limits[spec.key] = value;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 1) out.errors.push(`多余的位置参数：${positional.slice(1).join(" ")}`);
  out.root = positional[0] ?? null;
  return out;
}

/** CLI 用法文本（--help 与参数错误时打印）。 */
export function usageText() {
  return [
    "用法：node test/verify-graphs.mjs [sessions目录] [选项]",
    "",
    "  --json                    只输出 JSON（给脚本用）",
    "  --strict                  开启不变量门禁：退化图 / 自环 / 边节点比 / 坍缩图 任一违反 ⇒ 退出码 1",
    "  --max-self-loops=N        每张图允许的自环边数上界（默认 0）",
    "  --max-edge-per-node=R     每张图的边/节点比上界（默认 8）",
    "  --max-self-loop-rate=R    每张图的自环率上界，0~1（默认 0.05；自环数为 0 时永不触发）",
    "  --exemptions=<文件>       历史违规图豁免清单（C-13）。只吸收「同图 + 同判据 + 同数值 + 同指纹」",
    "                            的违规；数值或图内容一变就恢复判红。豁免条目会被逐条打印（豁免 ≠ 通过）",
    "  --help                    打印本用法",
    "",
    "退出码：0 = 健康（或未开 strict 且无 problems）；1 = 不健康 / 严格门禁失败；2 = 参数错误",
  ].join("\n");
}
