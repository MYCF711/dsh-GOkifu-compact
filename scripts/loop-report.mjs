/**
 * loop-report.mjs —— 「思考死循环」在**真机语料**上长什么样（C446）
 *
 * 由来：C444/C445 加了循环判据（连续相同动作 ≥4 ⇒ 强制折一次），但一直缺两件事：
 *   ① 真机上一共有多少会话出现这种形状？—— 没有分母，阈值 4 就是拍脑袋；
 *   ② **压缩到底能不能打断循环？** —— 用户在 DSH-GO 那个会话里"手动压一次就好了"，
 *      而那是宿主自带的 /compact，我们自己的折叠从没被这样观察过。
 *
 * 这个脚本用**棋谱图**（我们自己的边：action + seq + foldMarks）回答这两个问题：
 *   · 每个会话的「最长连续相同动作」；
 *   · 每次折叠**之前 / 之后**的最长连续同型动作 —— 折叠之后掉下来，才算真的打断了。
 *
 * 注意口径：
 *   · 只统计 `action` 逐字相同的**连续**边（中间隔了别的动作就断）；
 *   · 「相同」用的是 `actionSummary(tool,args)` 的产物，对同一命令逐字稳定；
 *   · 折叠点用 `foldMark.seqEnd`；after 窗口到**下一次折叠**为止（或 200 条边封顶）。
 *
 * 用法：
 *   node scripts/loop-report.mjs                # 全库汇总（默认 DSH_HOME）
 *   node scripts/loop-report.mjs --json         # 机器可读
 *   node scripts/loop-report.mjs --min 4 --top 10
 */
import fs from "node:fs";
import path from "node:path";
import { loadSessionGraph } from "./graph-audit.mjs";
import { actionKeyOf } from "../src/rooms/loop-guard.mjs";

/** 默认 home：优先环境变量，其次本机实际路径。 */
export function defaultHome() {
  return process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home";
}

/**
 * 按 seq 升序的边（图里 edges 是对象，顺序不保证）。
 *
 * ★ C446 修：**边本身没有 seq 字段**（只有 id/from/to/action/evidence/sig…）。
 * 第一版按 `e.seq` 排序 ⇒ 全库 0 条边、报告写着"真机没有循环"——差点把一个 bug 当成结论。
 * 现在按**边的终点节点的 seq** 排；拿不到再退回 evidence.end。
 */
export function orderedEdges(graph) {
  const nodes = graph?.nodes ?? {};
  const seqOf = (e) => {
    const byNode = Number(nodes[e?.to]?.seq ?? nodes[e?.from]?.seq ?? NaN);
    if (Number.isFinite(byNode)) return byNode;
    const ev = e?.evidence;
    if (Number.isFinite(Number(ev))) return Number(ev);
    return Number.isFinite(ev?.end) ? Number(ev.end) : NaN;
  };
  return Object.values(graph?.edges ?? {})
    .map((e) => ({ ...e, seq: seqOf(e) }))
    .filter((e) => Number.isFinite(e.seq))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 连续相同动作的段落。
 * @param {Array<{action?: string, seq?: number}>} edges 已按 seq 升序
 * @param {{minRepeat?: number}} [options]
 * @returns {{max: number, runs: Array<{action: string, len: number, fromSeq: number, toSeq: number}>,
 *            loopShaped: boolean, loopRuns: Array<object>}}
 */
export function streakRuns(edges, { minRepeat = 4 } = {}) {
  const min = Math.max(2, Number(minRepeat) || 4);
  const list = Array.isArray(edges) ? edges : [];
  const runs = [];
  let i = 0;
  const keyAt = (e) => actionKeyOf(e);
  while (i < list.length) {
    const key = keyAt(list[i]);
    if (key === null) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < list.length && keyAt(list[j]) === key) j += 1;
    runs.push({ action: String(list[i].action ?? ""), len: j - i, fromSeq: Number(list[i].seq), toSeq: Number(list[j - 1].seq) });
    i = j;
  }
  const max = runs.reduce((m, r) => Math.max(m, r.len), 0);
  const loopRuns = runs.filter((r) => r.len >= min);
  return { max, runs, loopShaped: loopRuns.length > 0, loopRuns };
}

/** 某段 seq 区间内的最长连续同型动作（不含区间外）。 */
export function maxStreakIn(edges, fromSeq, toSeq) {
  const slice = (Array.isArray(edges) ? edges : []).filter((e) => Number(e.seq) > fromSeq && Number(e.seq) <= toSeq);
  return streakRuns(slice, { minRepeat: 2 }).max;
}

/**
 * 每次折叠「之前 / 之后」的最长连续同型动作。
 *
 * 为什么比的是**跨折叠两侧**：如果折叠真的打断了循环，折叠后那段应该明显更短；
 * 若两边一样长，说明折叠只是换了个位置继续循环（那就说明"压缩能治循环"是错觉）。
 *
 * @param {object} graph
 * @param {Array} edges 已按 seq 升序
 * @param {{windowEdges?: number}} [options] after 窗口到下一次折叠，最多 windowEdges 条
 * @returns {Array<{trigger: string, seqEnd: number, before: number, after: number, bounded: boolean}>}
 */
export function streaksAroundFolds(graph, edges, { windowEdges = 200 } = {}) {
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks.filter((m) => Number.isFinite(Number(m?.seqEnd))) : [];
  if (marks.length === 0) return [];
  const sorted = [...marks].sort((a, b) => Number(a.seqEnd) - Number(b.seqEnd));
  const lastSeq = edges.length > 0 ? Number(edges[edges.length - 1].seq) : Number.MAX_SAFE_INTEGER;
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const mark = sorted[i];
    const end = Number(mark.seqEnd);
    const next = sorted[i + 1] !== undefined ? Number(sorted[i + 1].seqEnd) : lastSeq;
    // before 窗口：上一次折叠之后 → 本次折叠
    const prevEnd = i === 0 ? -Infinity : Number(sorted[i - 1].seqEnd);
    const before = maxStreakIn(edges, prevEnd === -Infinity ? -Infinity : prevEnd, end);
    // after 窗口：本次折叠 → 下一次折叠（或封顶 windowEdges 条边）
    const afterEdges = edges.filter((e) => Number(e.seq) > end && Number(e.seq) <= next).slice(0, windowEdges);
    const after = afterEdges.length === 0 ? 0 : streakRuns(afterEdges, { minRepeat: 2 }).max;
    out.push({
      trigger: typeof mark.trigger === "string" ? mark.trigger : "(none)",
      seqEnd: end,
      before,
      after,
      bounded: next !== lastSeq,
    });
  }
  return out;
}

/** 扫描 home 下的棋谱图。 */
export function listGraphs(home) {
  const root = path.join(home, "chess-context", "sessions");
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith("session-"));
  const out = [];
  for (const d of dirs) {
    const file = path.join(root, d, "graph.json");
    if (!fs.existsSync(file)) continue;
    try {
      // ★ 必须走图审计的读取：**边和 foldMarks 常落在 delta 里**，直接 JSON.parse 基线只有 0 条边
      //   （第一版就是这么写的 —— 报告显示"全库 0 条边"，差点被当成"真机没有循环"）。
      const { graph } = loadSessionGraph(file);
      out.push({ id: d.slice("session-".length), file, graph });
    } catch {
      /* 坏图跳过（报告不该因为一个文件打不开就整体失败） */
    }
  }
  return out;
}

/** 汇总：把每个会话的结果压成几行能贴进文档的数。 */
export function summarize(reports) {
  const total = reports.length;
  const withLoop = reports.filter((r) => r.overall.loopShaped);
  const foldPairs = reports.flatMap((r) => r.folds);
  const loopFolds = foldPairs.filter((f) => f.trigger === "loop");
  const pressureFolds = foldPairs.filter((f) => f.trigger !== "loop");
  const broke = (list) => list.filter((f) => f.before >= 4 && f.after < f.before).length;
  const candidates = (list) => list.filter((f) => f.before >= 4).length;
  return {
    sessions: total,
    edges: reports.reduce((s, r) => s + r.overall.edges, 0),
    loopSessions: withLoop.length,
    loopRate: total === 0 ? 0 : withLoop.length / total,
    longest: reports.reduce((m, r) => Math.max(m, r.overall.max), 0),
    folds: foldPairs.length,
    loopFolds: loopFolds.length,
    pressureFolds: pressureFolds.length,
    pressureAfterLoop: candidates(pressureFolds),
    pressureBroke: broke(pressureFolds),
    loopAfterLoop: candidates(loopFolds),
    loopBroke: broke(loopFolds),
    // ★ C447：**口径透明度**。加了 sig 之前落的棋谱没有指纹，只能按动作串算 ——
    //   而动作串会把"同一文件的不同编辑"算成连击（真机 3 个会话就是这么来的）。
    //   所以报告必须自己说清楚：这次统计里有多少条边真的带了指纹。
    sigEdges: reports.reduce((s, r) => s + (r.overall.sigEdges ?? 0), 0),
  };
}

/* ───────────────────────── CLI ───────────────────────── */

function main(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = get("home", defaultHome());
  const min = Number(get("min", 4));
  const top = Number(get("top", 8));
  const asJson = argv.includes("--json");

  const graphs = listGraphs(home);
  const reports = graphs.map(({ id, graph }) => {
    const edges = orderedEdges(graph);
    const overall = streakRuns(edges, { minRepeat: min });
    overall.sigEdges = edges.filter((e) => typeof e.sig === "string" && e.sig !== "").length;
    return { id, overall: { ...overall, edges: edges.length }, folds: streaksAroundFolds(graph, edges) };
  });
  const s = summarize(reports);

  if (asJson) {
    console.log(JSON.stringify({ summary: s, sessions: reports.map((r) => ({ id: r.id, max: r.overall.max, edges: r.overall.edges, folds: r.folds })) }, null, 2));
    return 0;
  }

  console.log(`== 循环形状报告（连续相同动作 ≥${min}）· ${home} ==`);
  console.log(`  会话 ${s.sessions} 个 / 边 ${s.edges} 条；出现循环形状的会话 **${s.loopSessions}** 个（${(s.loopRate * 100).toFixed(1)}%）；全库最长连续同型动作 **${s.longest}**`);
  console.log(`  折叠 ${s.folds} 次（loop ${s.loopFolds} / 其它 ${s.pressureFolds}）`);
  console.log(`  · 折叠前就有循环形状的：${s.pressureAfterLoop} 次；折叠后变短：${s.pressureBroke} 次 ⇒ ${s.pressureAfterLoop === 0 ? "无可判断（历史折叠前没有循环形状）" : `打断率 ${(s.pressureBroke / s.pressureAfterLoop * 100).toFixed(0)}%`}`);
  if (s.loopFolds > 0) console.log(`  · 循环折叠本身：${s.loopFolds} 次，其中折叠后变短 ${s.loopBroke} 次`);

  const topList = [...reports].sort((a, b) => b.overall.max - a.overall.max).slice(0, top);
  if (topList.length > 0 && topList[0].overall.max >= min) {
    console.log(`  最长连续同型动作（前 ${topList.length}）：`);
    for (const r of topList) {
      if (r.overall.max < min) break;
      const run = r.overall.runs.find((x) => x.len === r.overall.max);
      console.log(`    ${r.id.slice(0, 8)}  ${r.overall.max} 次  ${String(run?.action ?? "").slice(0, 70)}  (seq ${run?.fromSeq}–${run?.toSeq})`);
    }
  } else {
    console.log(`  ✅ 没有任何会话出现连续 ${min} 次相同动作`);
  }
  const sigPct = s.edges === 0 ? 0 : (s.sigEdges / s.edges) * 100;
  console.log(`  ⚠ 口径：只算**逐字相同且连续**的动作；中间插了别的动作就断。折叠后窗口到下一次折叠（或 200 条边）。`);
  console.log(`  ⚠ 指纹覆盖：${s.sigEdges}/${s.edges} 条边（${sigPct.toFixed(1)}%）—— ${sigPct < 100 ? "老棋谱没有 sig，只能按动作串算，**会把同一文件的不同编辑算成连击**（偏宽）" : "全部带指纹，与生产判据同口径"}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("loop-report.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
