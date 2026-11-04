#!/usr/bin/env node
/**
 * repair-coverage-audit.mjs —— **「死路机械补回到底跑没跑过」的逐条审计**（C641）
 *
 * 由来（上一轮真机统计自相矛盾，两条同时成立）：
 *   · 534 条 `trigger=archive-offline` 的 foldMark 里，`quality.failuresRepaired` **出现 0 次**；
 *   · 同一批里 `failureRecall < 1` 的有 **18 条**（3.4%）。
 *
 * 按 C607 的设计，`failureRecall` 应该**恒 = 1**（补回后重新测量）。两条同时成立只有三种可能：
 *   ① **补回函数没被调用**（某个生产者/某个分支根本没接）；
 *   ② **被调用但提前 return**（`missing` 算出来是空的 —— 那说明判据与记录不一致）；
 *   ③ **补回了但没写 `failuresRepaired` 字段**（留痕条件写窄了）。
 * 本脚本就是来把 ① / ② / ③ 分开的：**对那 18 条逐条判断**，而不是看汇总数。
 *
 * 判据（全部机械、零模型调用、只读）：
 *   · 前置条件：`failuresInFoldRange(graph, range)` 非空，且其中至少一条 `mentionsEdge(text, id)` 为假
 *     —— 这就是 `runOfflineFold` 里 `missingFailureEdges.length > 0` 的那个条件；
 *   · 重放：把**真机摘要原文**（`graph.lastOfflineSummary.text`，仅最后一段保留）喂给
 *     `repairMissingFailures` + `measureFoldQuality`，看补回后 `failureRecall` 是不是 1；
 *   · 留痕：摘要原文里有没有补回段标题（`## 已探明死路（逐字补充`）。
 *
 * 三条结论只有一条能成立：
 *   **A** 前置条件成立、摘要里没有补回段、记录里也没有 `failuresRepaired` ⇒ 补回**没被执行**；
 *   **B** 摘要里有补回段、但记录里没有 `failuresRepaired` ⇒ 补回了**没留痕**；
 *   **C** 缺失的 id 在摘要里其实出现过（判据假阳/假阴）⇒ **判据**有 bug；
 *   **D** 该 mark 走的是规则摘要（`fallback=rules` / 无模型输出）⇒ 本来就没有模型输出，不是缺陷。
 *
 * 另外还回答一个**必须回答**的问题：这 18 条是「补回代码跑了但没生效」，还是
 * 「写这些 mark 的那个进程里根本没有补回代码」？判据是**字段世代**：
 *   · `quality.failuresRepaired`（C607 起写）、`inputTruncated`（C610 起写）——
 *     缺哪个字段，就说明写它的进程早于那次提交（模块在宿主启动时加载，改代码不重启不生效）。
 *
 * 用法：
 *   node scripts/repair-coverage-audit.mjs                 # 默认 DSH_HOME
 *   node scripts/repair-coverage-audit.mjs --home <dir>    # 换 home
 *   node scripts/repair-coverage-audit.mjs --json          # 机读（报告/测试用）
 *   node scripts/repair-coverage-audit.mjs --no-git        # 不查 git 世代（离线/无 .git 时）
 *   node scripts/repair-coverage-audit.mjs --limit=50      # 只看最近 50 条 foldMark（冒烟）
 *
 * 退出码：0 = 审计跑完（无论数字是多少）；2 = 一张图都读不到（home 给错了）。
 * 边界：**只读**。不写盘、不改图、不调模型。
 */
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectGraphFiles } from "../src/ui.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { failuresInFoldRange, mentionsEdge, measureFoldQuality } from "../src/rooms/fold-quality.mjs";
import { repairMissingFailures } from "../src/rooms/offline-fold.mjs";

/** 补回段标题（`repairMissingFailures` 写进摘要的那一行）—— 留痕的**直接**证据。 */
export const REPAIR_HEADING = "## 已探明死路（逐字补充";

/** 与 doctor / graph-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".dsh");
}

/** 四类结论（顺序即报告里的顺序）。 */
export const VERDICTS = Object.freeze({
  A: "A 补回没被执行（前置条件成立，但摘要里没有补回段）",
  B: "B 补回了但没留痕（摘要里有补回段，记录里没有 failuresRepaired）",
  C: "C 判据有 bug（缺失的 id 在摘要里其实出现过 / 判据假阳）",
  D: "D 规则摘要路径（本来就没有模型输出，不是缺陷）",
});

/**
 * 判断**一条** mark 属于哪一类。
 *
 * 入参全部来自真机（除了 `replay` 是现算的）：
 * @param {object} mark foldMark
 * @param {{hasText:boolean, text:string|null, missingNow:string[]|null, repaired:string[]|null, after:object|null}} replay
 * @returns {{verdict:"A"|"B"|"C"|"D", why:string, evidence:string[]}}
 */
export function classifyMark(mark, replay) {
  const quality = mark?.quality;
  const recordedMissing = Array.isArray(quality?.missingFailures) ? quality.missingFailures : [];
  const recordedRepaired = Number(quality?.failuresRepaired);
  const hasRecordedField = Number.isFinite(recordedRepaired) && quality?.failuresRepaired !== undefined && quality?.failuresRepaired !== null;
  const evidence = [];

  // ── D：规则摘要 / 非离线 / 没有模型输出 ───────────────────────────────
  // 判据与 mark 自己的字段同源：`fallback === "rules"` 是「走了规则摘要」的**既有**写法
  // （engine 的自动折叠写 `summaryMode === "rules"`），`offline !== true` 说明根本不是离线补折。
  if (String(mark?.fallback ?? "") === "rules" || mark?.offline !== true) {
    evidence.push(`fallback=${mark?.fallback ?? "null"} · offline=${mark?.offline ?? "null"}`);
    return { verdict: "D", why: "不是模型摘要（离线折痕的 offline 必须为 true）", evidence };
  }
  evidence.push(`trigger=${mark?.trigger} · offline=true · fallback=null · model=${mark?.route?.model ?? "—"}`);

  // ── C：判据本身有问题 ────────────────────────────────────────────────
  // 只有在**拿到了摘要原文**时才能验判据；没有原文时不能凭空说判据对/错。
  if (replay.hasText && Array.isArray(replay.missingNow)) {
    // 假阳：`mentionsEdge` 说「提过」，但 id 并不是一个独立标识符（前后还粘着字母）。
    const falsePositive = recordedMissing.filter((id) => mentionsEdge(replay.text, id) && !new RegExp(`(?:^|[^A-Za-z0-9_])${id}(?![0-9])`).test(replay.text));
    if (falsePositive.length > 0) {
      evidence.push(`判据假阳：${falsePositive.join(",")}`);
      return { verdict: "C", why: "mentionsEdge 把「粘在别的标识符里」当成了独立出现", evidence };
    }
    // 记录的缺失集与现算的不一致 ⇒ 记录陈旧或判据变过（不是补回的问题）。
    const recordedKey = [...recordedMissing].sort().join(",");
    const nowKey = [...replay.missingNow].sort().join(",");
    if (recordedKey !== nowKey && recordedMissing.length > 0) {
      evidence.push(`记录缺失 [${recordedKey}] ≠ 现算缺失 [${nowKey}]`);
      return { verdict: "C", why: "记录与现算不一致（记录陈旧 / 判据被改过）", evidence };
    }
  }

  // ── B：补回了但没留痕 ────────────────────────────────────────────────
  if (replay.hasText && replay.text.includes(REPAIR_HEADING) === true && hasRecordedField === false) {
    evidence.push("摘要里有补回段，但 quality.failuresRepaired 缺失");
    return { verdict: "B", why: "补回跑了、摘要里也有，但留痕字段没写", evidence };
  }

  // ── A：前置条件成立、补回没被执行 ─────────────────────────────────────
  // 前置条件的**直接**证据：记录里的 `missingFailures` 非空（它就是
  // `failuresInFoldRange(...).filter(e => !mentionsEdge(text, e.id))` 的同一份输出）。
  if (recordedMissing.length > 0) {
    evidence.push(`记录 missingFailures=[${recordedMissing.join(",")}] ⇒ missingFailureEdges.length > 0`);
    if (replay.hasText) {
      evidence.push(`摘要里有补回段：${replay.text.includes(REPAIR_HEADING) ? "有（判 B）" : "没有"}`);
      evidence.push(`重放补回 ${replay.repaired?.length ?? 0} 条 ⇒ 补回后 failureRecall=${replay.after?.failureRecall ?? "—"}`);
    } else {
      evidence.push("摘要原文未保留（只有最后一段的 lastOfflineSummary 有 text），重放不可做");
    }
    evidence.push(`quality.failuresRepaired=${quality?.failuresRepaired === undefined ? "缺失" : JSON.stringify(quality.failuresRepaired)}`);
    return { verdict: "A", why: "补回函数没被执行（若执行，摘要里必有补回段、记录里必有字段）", evidence };
  }

  // 记录里 missing 是空的、但 failureRecall < 1：分母/分子对不上 ⇒ 记录本身可疑（仍归 C）。
  evidence.push(`failureRecall=${quality?.failureRecall} 但 missingFailures=[]`);
  return { verdict: "C", why: "failureRecall < 1 却记录 missingFailures=[] —— 记录自相矛盾", evidence };
}

/**
 * 扫全部会话，挑出 `failureRecall < 1` 的 `archive-offline` 折痕，逐条重放。
 *
 * @param {{home?:string, limit?:number, session?:string}} [opts]
 * @returns {{home:string, graphs:number, marks:number, archiveOffline:number, rows:Array<object>, epoch:object}}
 */
export function audit({ home = resolveHome(), limit = 0, session = "" } = {}) {
  const { files } = collectGraphFiles(home);
  const rows = [];
  const epoch = { marks: 0, hasFailuresRepaired: 0, hasInputTruncated: 0, repairedPositive: 0, qualityNull: 0, byFr: new Map() };
  for (const file of files) {
    if (session !== "" && !file.dir.includes(session)) continue;
    let graph;
    try {
      graph = loadSessionGraph(file.file).graph;
    } catch {
      /* 坏图跳过（体检脚本的老规矩：一张坏图不许让整份报告失败） */
      continue;
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    marks.forEach((mark, index) => {
      if (String(mark?.trigger) !== "archive-offline") return;
      epoch.marks += 1;
      if (mark?.quality && Object.prototype.hasOwnProperty.call(mark.quality, "failuresRepaired")) epoch.hasFailuresRepaired += 1;
      if (Object.prototype.hasOwnProperty.call(mark, "inputTruncated")) epoch.hasInputTruncated += 1;
      if (Number(mark?.quality?.failuresRepaired) > 0) epoch.repairedPositive += 1;
      if (mark?.quality === null || typeof mark?.quality !== "object") epoch.qualityNull += 1;
      const recall = Number(mark?.quality?.failureRecall);
      if (!Number.isFinite(recall)) return;
      const key = recall < 1 ? "<1" : "=1";
      epoch.byFr.set(key, (epoch.byFr.get(key) ?? 0) + 1);
      if (!(recall < 1)) return;

      // 重放：只有「最后一段」的摘要原文被保留在 `graph.lastOfflineSummary` 里。
      const summary = graph?.lastOfflineSummary;
      const sameRange =
        summary !== undefined &&
        summary !== null &&
        Number(summary?.range?.start) === Number(mark.seqStart) &&
        Number(summary?.range?.end) === Number(mark.seqEnd);
      const text = sameRange ? String(summary?.text ?? "") : null;
      const hasText = text !== null && text !== "";
      let missingNow = null;
      let repaired = null;
      let after = null;
      if (hasText) {
        const edges = failuresInFoldRange(graph, { start: mark.seqStart, end: mark.seqEnd });
        const missingEdges = edges.filter((edge) => !mentionsEdge(text, edge.id));
        missingNow = missingEdges.map((edge) => String(edge.id));
        const fixed = repairMissingFailures(text, missingEdges);
        repaired = fixed.repaired;
        after = measureFoldQuality({ graph, range: { start: mark.seqStart, end: mark.seqEnd }, summaryText: fixed.text });
      }
      const replay = { hasText, text, missingNow, repaired, after };
      const verdict = classifyMark(mark, replay);
      rows.push({
        session: file.dir,
        index,
        seqStart: Number(mark.seqStart),
        seqEnd: Number(mark.seqEnd),
        at: Number(mark.at),
        trigger: String(mark?.trigger ?? ""),
        offline: mark?.offline === true,
        fallback: mark?.fallback ?? null,
        model: mark?.route?.model ?? null,
        summaryChars: Number(mark.summaryChars) || 0,
        failureRecall: recall,
        expectedFailures: Number(mark?.quality?.expectedFailures) || 0,
        missingFailures: Array.isArray(mark?.quality?.missingFailures) ? mark.quality.missingFailures : [],
        recordedRepaired: mark?.quality?.failuresRepaired ?? null,
        qualityRepaired: mark?.qualityRepaired ?? null,
        truncated: mark?.truncated === true,
        hasText,
        textMissing: missingNow,
        replayedRepaired: repaired,
        recallAfterRepair: after === null ? null : after.failureRecall,
        hasRepairHeading: hasText ? text.includes(REPAIR_HEADING) : null,
        ...verdict,
      });
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const limited = limit > 0 ? rows.slice(-limit) : rows;
  return {
    home,
    graphs: files.length,
    marks: epoch.marks,
    archiveOffline: epoch.marks,
    rows: limited,
    epoch: {
      marks: epoch.marks,
      hasFailuresRepaired: epoch.hasFailuresRepaired,
      hasInputTruncated: epoch.hasInputTruncated,
      repairedPositive: epoch.repairedPositive,
      qualityNull: epoch.qualityNull,
      byFr: Object.fromEntries(epoch.byFr),
    },
  };
}

/**
 * 代码世代：`repairMissingFailures` / `inputTruncated` 分别是什么时候进仓库的。
 *
 * 为什么需要它：宿主是**启动时加载 ESM**，改完代码不重启不生效 ——
 * 「补回从没跑过」必须能分清是**代码没生效**还是**分支没走**。
 * 没有 .git（打包/离线）时返回 null，不报错。
 *
 * @param {{root?:string}} [opts]
 * @returns {{repair:string|null, inputTruncated:string|null}|null}
 */
export function codeGeneration({ root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  const at = (symbol) => {
    try {
      const out = execFileSync("git", ["-C", root, "log", "--format=%aI", "-S", symbol, "--", "src/rooms/offline-fold.mjs"], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
      const lines = out.split("\n").map((x) => x.trim()).filter((x) => x !== "");
      return lines.length === 0 ? null : lines[lines.length - 1];
    } catch {
      return null;
    }
  };
  const repair = at("repairMissingFailures");
  const inputTruncated = at("inputTruncated");
  if (repair === null && inputTruncated === null) return null;
  return { repair, inputTruncated };
}

/* ────────────────────────────────── 输出 ────────────────────────────────── */

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "—");

function render(result, { generation = null } = {}) {
  const lines = [];
  lines.push("# 失败边补回覆盖率审计（只读 · 零模型调用）");
  lines.push("");
  lines.push(`home = ${result.home}`);
  lines.push(
    `会话 ${result.graphs} 个 · \`trigger=archive-offline\` 折痕 ${result.archiveOffline} 条 · ` +
      `其中 failureRecall<1 的 **${result.rows.length}** 条`,
  );
  lines.push("");
  lines.push("## ① 逐条结论");
  lines.push("");
  for (const [i, row] of result.rows.entries()) {
    lines.push(
      `### ${i + 1}. ${row.session.slice(0, 20)} · seq ${row.seqStart}-${row.seqEnd} · ${iso(row.at)}`,
    );
    lines.push(
      `- 触发/路径：trigger=${row.trigger} · offline=${row.offline} · fallback=${row.fallback === null ? "null" : row.fallback} · model=${row.model ?? "—"}`,
    );
    lines.push(
      `- 记录：failureRecall=${row.failureRecall.toFixed(3)} · expectedFailures=${row.expectedFailures} · ` +
        `missingFailures=[${row.missingFailures.join(", ")}] · failuresRepaired=${row.recordedRepaired === null ? "缺失" : row.recordedRepaired} · qualityRepaired=${row.qualityRepaired}`,
    );
    lines.push(
      `- 前置条件（\`missingFailureEdges.length > 0\`）：${row.missingFailures.length > 0 ? "**成立**" : "不成立"}` +
        `${row.hasText ? ` · 摘要原文重放缺失 [${(row.textMissing ?? []).join(", ")}] ⇒ 补回 ${row.replayedRepaired?.length ?? 0} 条 ⇒ 补回后 failureRecall=${row.recallAfterRepair}` : " · 摘要原文未保留（只有最后一段有）"}`,
    );
    lines.push(`- 摘要里有补回段：${row.hasRepairHeading === null ? "—（无原文）" : row.hasRepairHeading ? "**有**" : "没有"} · 响应截断=${row.truncated}`);
    for (const e of row.evidence) lines.push(`- 证据：${e}`);
    lines.push(`- **结论：${row.verdict}** —— ${row.why}`);
    lines.push("");
  }

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of result.rows) counts[row.verdict] += 1;
  lines.push("## ② 分类统计");
  lines.push("");
  for (const key of ["A", "B", "C", "D"]) lines.push(`- ${VERDICTS[key]}：**${counts[key]}** 条`);
  lines.push("");

  lines.push("## ③ 代码世代（为什么「一次都没跑过」）");
  lines.push("");
  lines.push(
    `- \`trigger=archive-offline\` 共 ${result.epoch.marks} 条：` +
      `带 \`quality.failuresRepaired\` 的 **${result.epoch.hasFailuresRepaired}** 条 · ` +
      `带 \`inputTruncated\` 的 **${result.epoch.hasInputTruncated}** 条 · ` +
      `补回数 > 0 的 **${result.epoch.repairedPositive}** 条`,
  );
  if (generation !== null) {
    lines.push(`- 补回代码（\`repairMissingFailures\`）进仓库：${generation.repair ?? "—"}`);
    lines.push(`- 输入侧裁切字段（\`inputTruncated\`）进仓库：${generation.inputTruncated ?? "—"}`);
  }
  if (result.epoch.marks > 0 && result.epoch.hasInputTruncated === 0) {
    lines.push(
      "- **判据**：`inputTruncated` 是 C610 起**每条折痕都写**的字段（boolean 三态）；" +
        "一条都没有 ⇒ 写这些折痕的进程早于 C610。而补回（C607）比它更早 —— " +
        "**没有任何一条折痕是由带补回代码的进程写下的**，所以「补回 0 次」是**没跑到**，不是「跑到且没漏」。",
    );
  }
  if (result.epoch.marks > 0 && result.epoch.hasInputTruncated > 0 && result.epoch.hasFailuresRepaired === 0) {
    lines.push("- **判据**：已经有进程带 C610 字段，却没有一条带 `failuresRepaired` ⇒ 补回真的没生效（不是世代问题）。");
  }
  lines.push("");
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const home = get("home", resolveHome());
  const limit = Number(get("limit", 0)) || 0;
  const session = String(get("session", "") ?? "");
  const result = audit({ home, limit, session });
  if (result.graphs === 0) {
    console.error(`读不到任何会话图（home=${home}）—— 检查 DSH_HOME / --home。`);
    return 2;
  }
  const generation = argv.includes("--no-git") ? null : codeGeneration();
  if (argv.includes("--json")) console.log(JSON.stringify({ ...result, generation }, null, 2));
  else console.log(render(result, { generation }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
