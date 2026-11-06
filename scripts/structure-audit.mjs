#!/usr/bin/env node
/**
 * structure-audit.mjs —— 「`sectionsMissing` 恒假红」的只读证伪（C638）
 *
 * 为什么需要它：`src/rooms/fold-quality.mjs` 的 `describeStructure` 旧判据是
 * `body.includes("## 死路")`，而 prompt / 事实块 / 模型实际产出的段名是 **`## 已探明死路`**
 * （`src/rooms/offline-fold.mjs` 的 facts 块、`src/engine.mjs:3443`）。
 * ⇒ 那条判据对真机正文**永远 false**：本机 224 条 `sectionsMissing` 里 221 条点名「死路」，
 *   而点开摘要正文，那一整段就在那里。
 *
 * 这个脚本把「**记录值**」和「**正文事实**」摆在一起，一眼可判是哪种病：
 *   · **判据错** —— 记录说缺段，正文里那个段以别名出现（`## 已探明死路`）；
 *   · **真漏段** —— 记录说缺段，正文里确实没有（= 提示词/截断问题，改判据没用）；
 *   · **混合** —— 同一条里两种都有（例如只补回了 `## 约束（逐字）` 的截断摘要）。
 *
 * 判据（与修后的生产代码同源，直接调 `describeStructure` 复判）：
 *   段名按**别名全等**比 —— `## 棋谱（状态节点）` 归一化成 `棋谱`，
 *   `## 已探明死路（不许重试）` 归一化成 `已探明死路`，再与 `SECTION_ALIASES` 全等。
 *   **不是** `body.includes(name)`：那会让句子里的「死路」也算命中 ⇒ 探针恒绿。
 *
 * 正文从哪来（只读，按可靠度降序）：
 *   · `graph.lastOfflineSummary.text` —— 只有**区间对得上**的那一次 fold 才落盘；
 *     更早的 fold 只留下 `summaryChars`（正文没存），本脚本**如实标「无法判定」，不猜**。
 *
 * ★ C642：正文的读取口径**只有一份**（`summary-persistence-audit.mjs` 的 `summaryTextFor`）——
 *   C642 起写回点给每条折痕都落 `summaryText`（最后一段走 `summaryTextRef` 引用），
 *   于是「可复判」的分母 = **有正文的 mark 数**，而不是「最后一次折叠」。剩下拿不到正文的
 *   一律是**生产者早于 C642**，报告里单独点出来（不是正文丢了，等新折痕即可）。
 *
 * 用法：
 *   node scripts/structure-audit.mjs                    # 最近 10 条（有正文的）
 *   node scripts/structure-audit.mjs --limit=10
 *   node scripts/structure-audit.mjs --all              # 连正文未落盘的一起列（判定=无法判定）
 *   node scripts/structure-audit.mjs --session=d70b7c2f # 只看某个会话
 *   node scripts/structure-audit.mjs --home <workspace>   # 指定 home
 *   node scripts/structure-audit.mjs --json             # 机读
 *
 * 退出码：0 = 审计跑完（无论结论）；1 = 一条候选都没有（home 指错了 / 数据被清过）。
 * 边界：**只读**。不写盘、不改图、不调模型、不 commit、不重启。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeStructure,
  failuresInFoldRange,
  sectionNames,
  SECTION_ALIASES,
} from "../src/rooms/fold-quality.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";
import { SUMMARY_TEXT_SINCE, summaryTextFor } from "./summary-persistence-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
void HERE;

/**
 * 旧判据的必备段：别名表的键；其中「死路」是**唯一条件段**（区间里有失败边才要求）。
 * 与 `fold-quality.mjs` 的 `REQUIRED_SECTIONS_WITH_FAILURES` 同口径（那边是私有常量）；
 * 两边一致由 `test/structure-audit.test.mjs` 的「旧判据对照」用例钉住。
 */
const REQUIRED_ALL = Object.keys(SECTION_ALIASES);
const REQUIRED_BASE = REQUIRED_ALL.filter((name) => name !== "死路");

/** 与 doctor / graph-audit / fold-loss-audit 同源：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? nodeOs.homedir(), ".dsh");
}

/**
 * 摘要正文的取法 —— ★ C642 起**只有一个实现**（`summary-persistence-audit.mjs` 的 `summaryTextFor`），
 * 这里原样转出。四个读侧（本脚本 / fold-loss / repair-coverage / 成本审计）各写一份，
 * 就是 C587「写侧改了字段名、读侧还是老名字」的老路。
 *
 * 判据没变：`mark.summaryText` 优先，其次 `lastOfflineSummary` 的**区间必须全等**；
 * 对不上就是「正文没落盘」—— 这时宁可说不知道，也不拿别的段冒充（那会把审计变成编造）。
 */
export { summaryTextFor };

/**
 * ★ **旧判据（C638 之前）**：`body.includes("## 名")` —— 逐字全等，认不出别名。
 *
 * **只用于对照/回归**，生产代码不得调用（生产走 `describeStructure`）。
 * 留在这里是为了让「同一批真机正文，旧判据真红、新判据不再红」这件事**一条命令可复现**，
 * 而不是靠报告里的转述。
 *
 * @param {string} text 摘要正文
 * @param {{expectFailures?:boolean}} [options]
 * @returns {string[]} 旧判据认为缺失的段名
 */
export function legacySectionsMissing(text, { expectFailures = false } = {}) {
  const body = String(text ?? "");
  const required = expectFailures === true ? REQUIRED_ALL : REQUIRED_BASE;
  return required.filter((name) => !body.includes(`## ${name}`));
}

/** 该段在正文里存在吗（生产判据同款：`sectionNames` 归一化后与别名**全等**，不是包含）。 */
export function matchSection(headings, name) {
  const aliases = SECTION_ALIASES[name] ?? [name];
  const alias = headings.find((heading) => aliases.includes(heading)) ?? null;
  return { present: alias !== null, alias };
}

/**
 * 一条 foldMark 的判定。
 *
 * @param {object} input
 * @param {string} input.session 会话目录名
 * @param {number} input.index foldMark 下标（0 起；输出里 +1 显示）
 * @param {any} input.mark foldMark
 * @param {any} input.graph 棋谱（判 expectFailures 用）
 * @param {string|null} input.text 摘要正文（null = 未落盘）
 * @returns {{session:string, fold:number, at:number|null, listed:string[], headings:string[],
 *   details:Array<{name:string,present:boolean,alias:string|null,mentioned:boolean}>,
 *   probeMissing:string[]|null, verdict:string, why:string}}
 */
export function judgeMark({ session, index, mark, graph, text }) {
  const listed = Array.isArray(mark?.quality?.sectionsMissing) ? mark.quality.sectionsMissing.map(String) : [];
  const base = {
    session: String(session ?? ""),
    fold: Number(index) + 1,
    at: Number.isFinite(Number(mark?.at)) ? Number(mark.at) : null,
    listed,
  };
  if (text === null || text === undefined) {
    return {
      ...base,
      headings: [],
      details: [],
      probeMissing: null,
      legacyMissing: null,
      verdict: "无法判定",
      why: `正文未落盘（只有 summaryChars；生产者早于 ${SUMMARY_TEXT_SINCE}）—— 不猜`,
    };
  }
  const headings = sectionNames(text);
  const details = listed.map((name) => {
    const hit = matchSection(headings, name);
    // 内容在、标题不在（模型写成了句子）—— 保守判红，但要说清楚，别让人以为整段都没了
    const mentioned = !hit.present && String(text).includes(name);
    return { name, present: hit.present, alias: hit.alias, mentioned };
  });
  const wrong = details.filter((d) => d.present);
  const real = details.filter((d) => !d.present);
  let verdict;
  if (listed.length === 0) verdict = "无缺失";
  else if (real.length === 0) verdict = "判据错";
  else if (wrong.length === 0) verdict = "真漏段";
  else verdict = "混合";

  // 生产判据复判（修前/修后跑同一条命令，结论句会变 —— 这正是验收要看的）
  const range = { start: Number(mark?.seqStart), end: Number(mark?.seqEnd) };
  const expectFailures = Number.isFinite(range.start) && Number.isFinite(range.end) ? failuresInFoldRange(graph, range).length > 0 : false;
  const probe = describeStructure(text, { expectFailures });

  const why = [];
  for (const d of wrong) why.push(`「${d.name}」在正文里写作 \`## ${d.alias}\``);
  for (const d of real) why.push(`「${d.name}」正文里没有同级标题${d.mentioned ? "（只有句子提到，没有段）" : ""}`);
  return {
    ...base,
    headings,
    details,
    probeMissing: probe.sectionsMissing,
    legacyMissing: legacySectionsMissing(text, { expectFailures }),
    verdict,
    why: why.join("；"),
  };
}

/**
 * 扫全部会话，取最近 N 条带 `sectionsMissing` 的 foldMark。
 *
 * 默认只保留**能复判**（正文落盘）的条目 —— 表格里每一行都是一个可核的判定；
 * `--all` 才把「无法判定」的行一起列出来（它们同样算候选，只是不能当证据）。
 *
 * @param {object} [options]
 * @param {string} [options.home] DSH home
 * @param {string} [options.sessionsDir] 直接指定 sessions 目录（测试用）
 * @param {number} [options.limit] 最多几条（默认 10）
 * @param {string|null} [options.sessionFilter] 会话名包含这个子串
 * @param {boolean} [options.includeUnreadable] 是否把「正文未落盘」也计入 limit
 * @returns {{rows:Array<object>, candidates:number, readable:number, unreadable:number, sessions:number, bad:Array<{session:string,error:string}>}}
 */
export function collectAudits({ home = resolveHome(), sessionsDir = null, limit = 10, sessionFilter = null, includeUnreadable = false } = {}) {
  const dir = sessionsDir ?? nodePath.join(home, "chess-context", "sessions");
  const names = nodeFs.existsSync(dir) ? nodeFs.readdirSync(dir) : [];
  const all = [];
  const bad = [];
  let sessions = 0;
  for (const name of names) {
    if (sessionFilter !== null && !name.includes(sessionFilter)) continue;
    const file = nodePath.join(dir, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    sessions += 1;
    let graph = null;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch (error) {
      bad.push({ session: name, error: String(error?.message ?? error).slice(0, 160) });
      continue;
    }
    const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    for (const [index, mark] of marks.entries()) {
      const listed = mark?.quality?.sectionsMissing;
      if (!Array.isArray(listed) || listed.length === 0) continue;
      const summary = summaryTextFor(graph, mark);
      all.push({ session: name, index, mark, graph, text: summary.text, summaryWhy: summary.why });
    }
  }
  // 最近优先（at 缺失的排最后，仍然可判）
  all.sort((a, b) => (Number(b.mark?.at) || 0) - (Number(a.mark?.at) || 0));
  const readable = all.filter((x) => x.text !== null).length;
  const picked = (includeUnreadable ? all : all.filter((x) => x.text !== null)).slice(0, limit);
  const rows = picked.map((x) => ({
    ...judgeMark({ session: x.session, index: x.index, mark: x.mark, graph: x.graph, text: x.text }),
    summaryWhy: x.summaryWhy,
    trigger: x.mark?.trigger ?? null,
    summaryChars: x.mark?.summaryChars ?? null,
  }));
  return { rows, candidates: all.length, readable, unreadable: all.length - readable, sessions, bad };
}

/** 一行一句话（验收要的五个字段都在）。 */
export function formatRow(row, width = 2) {
  const at = row.at === null ? "时间未知" : new Date(row.at).toISOString().replace("T", " ").slice(0, 19);
  const listed = row.listed.length === 0 ? "(none)" : `[${row.listed.join(" / ")}]`;
  const headings = row.headings.length === 0 ? "—" : row.headings.join(" / ");
  const verdict = row.verdict === "无法判定" ? `无法判定（${row.summaryWhy}）` : `${row.verdict}（${row.why}）`;
  return (
    `${String(row.fold).padStart(width)}  ${row.session} · fold#${row.fold} · ${at} · trigger=${row.trigger ?? "?"} · ` +
    `sectionsMissing=${listed} · 正文标题=${headings} · 判定=${verdict}`
  );
}

/** 结论句（修前/修后跑同一条命令，这行会变 —— 这是验收要看的）。 */
export function conclusionOf({ rows, candidates, readable, unreadable }) {
  const tally = { 判据错: 0, 真漏段: 0, 混合: 0, 无法判定: 0 };
  for (const row of rows) if (tally[row.verdict] !== undefined) tally[row.verdict] += 1;
  const judged = rows.filter((r) => r.verdict !== "无法判定").length;
  const stillMissing = rows.filter((r) => Array.isArray(r.probeMissing) && r.probeMissing.length > 0).length;
  const legacyMissing = rows.filter((r) => Array.isArray(r.legacyMissing) && r.legacyMissing.length > 0).length;
  const names = {};
  for (const row of rows) for (const name of row.listed) names[name] = (names[name] ?? 0) + 1;
  const nameText = Object.entries(names)
    .map(([k, v]) => `${k}×${v}`)
    .join("、");
  const aliasText = Object.entries(SECTION_ALIASES)
    .map(([k, v]) => `${k}⇐${v.join("/")}`)
    .join(" · ");
  let verdict;
  if (judged === 0) verdict = "这批没有可复判的正文 ⇒ 下不了结论（先确认 home 是否指对）";
  else if (tally.判据错 === judged && tally.混合 === 0) verdict = "段名判据错（记录值里的段名与正文的实际叫法不同，不是真漏段）";
  else if (tally.真漏段 === judged && tally.混合 === 0) verdict = "真漏段（正文确实没有这些段 ⇒ 是提示词/截断问题，改判据没用）";
  else if (tally.判据错 + tally.真漏段 + tally.混合 === judged) verdict = "混合（既有判据错、也有真漏段 —— 要按段名分别处理）";
  else verdict = "见上表";
  return (
    `结论：可复判 ${judged} 条中 判据错 ${tally.判据错} 条 / 真漏段 ${tally.真漏段} 条 / 混合 ${tally.混合} 条` +
    `（点名段分布 ${nameText || "—"}）⇒ ${verdict}；` +
    `同一批正文按**旧判据** \`body.includes("## 名")\` 复判：${judged} 条里 ${legacyMissing} 条仍报缺段（恒假红），` +
    `按**当前** describeStructure 复判：${stillMissing} 条仍报缺段（段名按别名全等比：${aliasText}）；` +
    `候选共 ${candidates} 条，其中正文未落盘 ${unreadable} 条（生产者早于 ${SUMMARY_TEXT_SINCE} ⇒ 不可复判；可复判 ${readable}）。`
  );
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return null;
    if (hit === `--${name}`) return "";
    return hit.slice(name.length + 3);
  };
  const asJson = flag("json") !== null;
  const limitRaw = flag("limit");
  const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : 10;
  const sessionFilter = flag("session");
  const home = flag("home") || resolveHome();
  const includeUnreadable = flag("all") !== null;
  const result = collectAudits({ home, limit, sessionFilter: sessionFilter || null, includeUnreadable });
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { home, ...result, conclusion: conclusionOf(result) },
        null,
        1,
      ) + String.fromCharCode(10),
    );
  } else {
    console.log(`== 结构契约审计（sectionsMissing 到底是不是真的）==`);
    console.log(`   home         ${home}`);
    console.log(`   候选         ${result.candidates} 条（可复判 ${result.readable} · 不可复判 ${result.unreadable} —— 正文未落盘，生产者早于 ${SUMMARY_TEXT_SINCE} · 扫了 ${result.sessions} 个会话${includeUnreadable ? " · --all" : ""}）`);
    console.log(`   判据         sectionNames（## 名，去括号注记）+ SECTION_ALIASES 全等；${Object.entries(SECTION_ALIASES).map(([k, v]) => `${k}⇐${v.join("/")}`).join(" · ")}`);
    if (result.bad.length > 0) console.log(`   读不动       ${result.bad.map((b) => `${b.session}（${b.error}）`).join(" · ")}`);
    console.log("");
    if (result.rows.length === 0) console.log("  （没有候选 —— home 指错了？）");
    const width = String(result.rows.length).length;
    for (const row of result.rows) console.log(formatRow(row, width));
    console.log("");
    console.log(conclusionOf(result));
  }
  process.exitCode = result.candidates === 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
