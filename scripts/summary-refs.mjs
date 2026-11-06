/**
 * summary-refs.mjs —— 摘要里的「引用」回归探针（C456）
 *
 * 由来：doctor 报「压缩摘要引用了更晚的实体」19 次。追到根因是**提示词覆盖漏洞**（C455 已修：
 * 「只能引用事实块里出现过的 id」以前只写在 `preGraph` 分支里）。
 * 但改的是提示词，效果**只能靠下一次真机折叠验证** —— 所以要有个能反复跑、能对比的探针，
 * 而不是每次去翻 doctor 那一行。
 *
 * 三种引用问题，成因完全不同，必须分开数：
 *   · `unknownIds`   —— 摘要提到的 id 图里**根本没有**（编造，或从旧会话 checkpoint 抄来的旧编号）；
 *   · `outOfRangeLater`   —— 引用了**折叠时还不存在**的实体（编造得更"像真的"，或提示词泄漏）；
 *   · `outOfRangeEarlier` —— 引用了**更早**的实体（回溯历史 kifu，**正常**，不该报警）。
 *
 * 用法：
 *   node scripts/summary-refs.mjs                 # 打印现状
 *   node scripts/summary-refs.mjs --write         # 顺手落一份基线（evidence/摘要引用基线.json）
 *   node scripts/summary-refs.mjs --since <ms>    # 只看这个时间点之后发生的折叠（验证 C455 用这个）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";

export const BASELINE_PATH = "evidence/摘要引用基线.json";

/**
 * 把一批 foldMark 汇总成计数（纯函数）。**只有带 `quality` 的折叠才进统计** ——
 * 老折叠没采集过方向信息，混进来会让"分母"虚高、比例看着变好。
 * @param {Array<object>} marks
 * @param {{since?: number}} [options]
 * @returns {{folds:number, withQuality:number, unknown:number, later:number, earlier:number,
 *            foldsWithLater:number, foldsWithUnknown:number, byTrigger:object,
 *            examples:{later:string[], unknown:string[]}, newestAt:number|null}}
 */
export function summarizeRefs(marks, { since = null } = {}) {
  const out = {
    folds: 0,
    withQuality: 0,
    unknown: 0,
    later: 0,
    earlier: 0,
    foldsWithLater: 0,
    foldsWithUnknown: 0,
    // ★ C469：**按"这次折叠有没有跑过清洗（C458）"分队列**，而不是按时间。
    //   时间基线会把"修复前的旧折叠"一直算进分子（上一轮就是这样：7 条新折叠 100% 带更晚实体，
    //   而那 7 条其实全是**重启前的旧代码**跑的）。`sanitizedIds` 字段只有 C458 之后才会写。
    protectedFolds: 0,
    // ★ C482：写了 sanitizedIds 但没有 sanitizeRan ⇒ 不知道清洗有没有真跑（老记录）
    unconfirmedFolds: 0,
    // ★ C486：规则摘要（fallback=rules / route.model=null）—— 机械渲染，不算幻觉来源
    rulesFolds: 0,
    rulesWithLater: 0,
    unconfirmedWithLater: 0,
    protectedWithLater: 0,
    unprotectedFolds: 0,
    unprotectedWithLater: 0,
    byTrigger: {},
    examples: { later: [], unknown: [] },
    newestAt: null,
  };
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (mark === null || typeof mark !== "object") continue;
    if (since !== null && !(Number(mark.at) > since)) continue;
    out.folds += 1;
    if (Number.isFinite(mark.at) && (out.newestAt === null || mark.at > out.newestAt)) out.newestAt = mark.at;
    const q = mark.quality;
    // ★ C486：**规则摘要**（无模型调用）里的"更晚实体"不是幻觉，是机械渲染的结果 —— 单独记，不算进幻觉口径
    const rulesMode = mark.fallback === "rules" || (mark.route !== null && mark.route !== undefined && mark.route.model === null);
    if (q === null || typeof q !== "object") continue;
    out.withQuality += 1;
    const unknown = Array.isArray(q.unknownIds) ? q.unknownIds : [];
    const later = Array.isArray(q.outOfRangeLater) ? q.outOfRangeLater : [];
    const earlier = Array.isArray(q.outOfRangeEarlier) ? q.outOfRangeEarlier : [];
    out.unknown += unknown.length;
    out.later += later.length;
    out.earlier += earlier.length;
    // ★ C482：**"跑过清洗"不等于"有 sanitizedIds 字段"**。真机 c0a5847a 那次
    //   `sanitizedIds: 0` 但 quality 里还列出 20 个「更晚实体」—— 那是 range 为空、清洗空转。
    //   所以队列归属改成看 `sanitizeRan`；老 foldMark（没有该字段）单独记一栏"未确认"。
    // `sanitizedIds > 0` 本身就证明它跑过（真替换了东西），老记录也按这个算
    if (rulesMode) {
      out.rulesFolds += 1;
      if (later.length > 0) out.rulesWithLater += 1;
    } else if (mark.sanitizeRan === true || Number(mark.sanitizedIds) > 0) {
      out.protectedFolds += 1;
      if (later.length > 0) out.protectedWithLater += 1;
    } else if (mark.sanitizeRan === false) {
      // 明确知道没跑（新版才写得出这个值）⇒ 就是未保护
      out.unprotectedFolds += 1;
      if (later.length > 0) out.unprotectedWithLater += 1;
    } else if (mark.sanitizedIds !== undefined) {
      out.unconfirmedFolds += 1;
      if (later.length > 0) out.unconfirmedWithLater += 1;
    } else {
      out.unprotectedFolds += 1;
      if (later.length > 0) out.unprotectedWithLater += 1;
    }
    if (later.length > 0) {
      out.foldsWithLater += 1;
      const trigger = typeof mark.trigger === "string" ? mark.trigger : "(none)";
      out.byTrigger[trigger] = (out.byTrigger[trigger] ?? 0) + 1;
      if (out.examples.later.length < 8) out.examples.later.push(`${trigger}:${later.slice(0, 4).join(",")}`);
    }
    if (unknown.length > 0) {
      out.foldsWithUnknown += 1;
      if (out.examples.unknown.length < 8) out.examples.unknown.push(unknown.slice(0, 4).join(","));
    }
  }
  return out;
}

/**
 * 与基线比：**只看基线之后新增的折叠**，算"还有多少比例出问题"。
 *
 * 为什么要比比例而不是比总数：总数只会随着折叠增加而变大，看起来永远在恶化；
 * 真正的判据是**新折叠里出问题的比例有没有下降**。
 * @param {object} current summarizeRefs 的结果
 * @param {{since:number, foldsWithLater:number, withQuality:number}|null} baseline
 */
export function compareWithBaseline(current, baseline) {
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline.since)) {
    return { hasBaseline: false, line: "没有基线 —— 加 `--write` 落一份，下次就能比了" };
  }
  const before = Number(baseline.withQuality) || 0;
  const beforeLater = Number(baseline.foldsWithLater) || 0;
  const after = current.withQuality;
  const afterLater = current.foldsWithLater;
  const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);
  return {
    hasBaseline: true,
    beforeRatio: before === 0 ? null : beforeLater / before,
    afterRatio: after === 0 ? null : afterLater / after,
    line:
      `基线之后的新折叠：${after} 条（有 quality），其中带「更晚实体」${afterLater} 条（${pct(afterLater, after)}）；` +
      `基线当时 ${before} 条 / ${beforeLater} 条（${pct(beforeLater, before)}）`,
  };
}

/** 扫所有会话图，取全部 foldMark。 */
export function collectFoldMarks(sessionsRoot) {
  const marks = [];
  if (!fs.existsSync(sessionsRoot)) return marks;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(sessionsRoot, entry.name, "graph.json");
    if (!fs.existsSync(file)) continue;
    let graph;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch {
      continue;
    }
    for (const mark of Array.isArray(graph.foldMarks) ? graph.foldMarks : []) {
      marks.push({ ...mark, session: entry.name.replace(/^session-/, "").slice(0, 8) });
    }
  }
  return marks;
}

function main(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const home = get("home", process.env.DSH_HOME ?? ["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92)));
  const sinceArg = get("since", null);
  const since = sinceArg === null ? null : Number(sinceArg);
  const sessionsRoot = path.join(home, "chess-context", "sessions");
  const marks = collectFoldMarks(sessionsRoot);
  const all = summarizeRefs(marks);

  // ★ C457：**有基线就必须按基线的时间点过滤**。第一版把 `--since` 做成手动参数，
  //   于是"比基线"变成了"全量比全量" —— 而全量里本来就含着基线那 85 条，
  //   比例永远在 22%~24% 之间原地打转，看起来像"改了没用"，其实根本没测到新折叠。
  //   （这是自己用出来的 bug：重启后第一次跑，输出"基线之后的新折叠 85 条"，而新折叠是 0 条。）
  let baselineSince = null;
  try {
    const base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    if (Number.isFinite(base?.since)) baselineSince = base.since;
  } catch {
    baselineSince = null;
  }
  const effectiveSince = since !== null ? since : argv.includes("--all") ? null : baselineSince;
  const cur = effectiveSince === null ? all : summarizeRefs(marks, { since: effectiveSince });

  // 基线
  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    baseline = null;
  }

  console.log("== 摘要引用探针（C456/C457） ==");
  if (effectiveSince !== null) {
    console.log(`  只看 ${new Date(effectiveSince).toISOString()} 之后的折叠（基线自动过滤；要看全量加 --all）`);
  } else {
    console.log("  ⚠ 全量统计（含基线之前的历史折叠）—— 判断「改了有没有用」请看基线之后的部分");
  }
  console.log(`  fold ${cur.folds} 条 · 有 quality 的 ${cur.withQuality} 条（只有它们能判方向）`);
  console.log(`  · 引用了**更晚**实体：${cur.later} 个 id，分布在 ${cur.foldsWithLater} 条折叠${Object.keys(cur.byTrigger).length > 0 ? `（${JSON.stringify(cur.byTrigger)}）` : ""}`);
  console.log(`  · 图里根本没有的 id（编造/旧编号）：${cur.unknown} 个，分布在 ${cur.foldsWithUnknown} 条折叠`);
  console.log(`  · 引用**更早**实体（回溯历史 kifu，正常）：${cur.earlier} 个`);
  if (cur.examples.later.length > 0) console.log(`  例子（更晚）：${cur.examples.later.slice(0, 4).join(" | ")}`);
  // ★ C469：两个队列分开报 —— 这是唯一能回答"C458 到底有没有用"的口径
  console.log(
    `  · 修复后队列（清洗确实跑过：sanitizeRan 或 替换数>0）：${cur.protectedFolds} 条折叠，其中带「更晚实体」${cur.protectedWithLater} 条` +
      (cur.protectedFolds === 0 ? "（**还没有**：等下一次真机折叠）" : ""),
  );
  console.log(`  · 修复前队列（无该字段）：${cur.unprotectedFolds} 条折叠，带「更晚实体」${cur.unprotectedWithLater} 条（历史账，不会自己变好）`);
  if (cur.rulesFolds > 0) {
    console.log(
      `  · 规则摘要（无模型调用）：${cur.rulesFolds} 条折叠，带「更晚实体」${cur.rulesWithLater} 条` +
        ` —— 这些是**机械渲染**出来的引用，不是幻觉；别混进"模型编造"的口径`,
    );
  }
  if (cur.unconfirmedFolds > 0) {
    console.log(
      `  · **未确认队列**（有 sanitizedIds 但缺 sanitizeRan）：${cur.unconfirmedFolds} 条，带「更晚实体」${cur.unconfirmedWithLater} 条` +
        ` —— 这些折叠的清洗可能**空转**（range 为空），不能算进"修复后"`,
    );
  }
  const cmp = compareWithBaseline(cur, baseline);
  console.log(`  ${cmp.line}`);
  if (effectiveSince !== null && cur.withQuality === 0) {
    console.log("  ⇒ 基线之后**还没有新的折叠**：现在下任何结论都太早（重启后先让会话跑出几次 fold）");
  }
  if (effectiveSince !== null) {
    console.log(`  （全量口径：${all.folds} 条 fold / ${all.withQuality} 条有 quality / 带更晚实体 ${all.foldsWithLater} 条，仅供对照）`);
  }

  if (argv.includes("--write")) {
    const snapshot = { at: Date.now(), since: Math.max(cur.newestAt ?? 0, Date.now()), ...cur };
    delete snapshot.examples;
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`  已写基线：${BASELINE_PATH}（之后只看这个时间点之后的折叠）`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));