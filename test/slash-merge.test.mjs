/**
 * slash-merge.test.mjs —— 「斜杠合并（`e107/e113`）该不该禁」这个决定的守卫（T26）
 *
 * 为什么要有这个文件：`deadend-adherence-audit.mjs` 把「有斜杠的 fold」报成 60.40%，
 * 看上去像个大缺口；`scripts/slash-merge-audit.mjs` 拆开之后发现**分母错了**：
 *   43% 是成功边（规则只管「已探明死路」）、42% 是死路段外的叙述引用（其中 94.87% 被逐条行补偿）、
 *   只有 15% 落在死路段内，而其中 9 / 14 是「同一工具 + 同一错误类」的重复尝试。
 * 结论是**不改提示词**（收益上限 0 个 id，成本是全量重折叠 + 重启）。
 *
 * 这个结论最容易被下一个人推翻的方式有三种，本文件三样都钉住：
 *   ① **有人顺手把「一条边一行」删了/改软** —— 那才是真该守的契约（区间合并会丢 id）；
 *   ② **决策只活在对话里** —— 于是半年后又有人问「要不要禁斜杠」，再改一次提示词；
 *   ③ **判据退化成「合并很多 = 有问题」** —— 比如把 `[ \t]*` 写成 `\s*`，
 *      于是 `e117\n- e164`（合规的一行一条）被算成一次斜杠合并（本仓 `deadend-adherence-audit`
 *      的注释里记着这个坑：破折号那边多算 1 次就凭空多出 47 个「被吞掉的 id」）。
 *
 * 另有两条**结构性事实**用代码钉死（它们才是「不改」的底气）：
 *   · 斜杠合并两端都能被 `mentionsEdge` 命中 ⇒ `repairFailuresInText` **一条都不补**（不丢 id）；
 *   · 破折号区间 `e1—e4` 中间两条**确实**补得回来（说明「不丢」不是把规则关掉了）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

// ★ 命名空间导入：脚本缺导出时只让**本文件**红，不让 run.mjs 在 import 阶段整库崩掉（C641 的教训）。
import * as slash from "../scripts/slash-merge-audit.mjs";
// 破折号那个口径属于兄弟脚本（本脚本只是复用），所以钉子直接钉在它的导出上。
import { countRangeMerges } from "../scripts/deadend-adherence-audit.mjs";
import { buildOfflinePrompt, repairFailuresInText } from "../src/rooms/offline-fold.mjs";
import { createGraph } from "./graph-fixtures.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = nodePath.join(HERE, "..", "src", "rooms", "offline-fold.mjs");
const SOURCE = nodeFs.readFileSync(SRC_FILE, "utf8");

/* ───────────────────────────── 夹具 ───────────────────────────── */

/**
 * 一条**新鲜**的失败边（与 `deadend-adherence.test.mjs` 同一形状）：
 * `to` 必须在图里、`ts` 必须新鲜，否则 `isDanglingResidue` 会把它当 rewash 残留滤掉。
 */
const failureEdge = (id, { start, end, action = "edit(file_path=a.md)", error = "Error: cannot modify" }) => ({
  id,
  from: "n1",
  to: "n2",
  intent: "",
  result: "failure",
  action,
  verify: { kind: "none", summary: "" },
  errorSnippet: error,
  evidence: { start, end },
  transposition: false,
  ts: Date.now(),
});

/** 成功边：斜杠合并里 43% 就是它 —— 规则管不着，必须能和自己区分开。 */
const successEdge = (id, { start, end }) => ({
  id,
  from: "n1",
  to: "n2",
  intent: "",
  result: "success",
  action: `edit(file_path=${id}.md)`,
  verify: { kind: "none", summary: "" },
  errorSnippet: "",
  evidence: { start, end },
  transposition: false,
  ts: Date.now(),
});

function makeGraph(edges, text) {
  const g = createGraph({ sessionId: "sess-slash", cwd: "E:/x" });
  g.nodes = {
    n1: { id: "n1", kind: "user", seq: 1, turn: 1, text: "目标：修压缩", constraints: ["只读 home"], ts: 1 },
    n2: { id: "n2", kind: "agent", seq: 5, turn: 1, text: "连续 edit 被拒", ts: 2 },
  };
  g.order = ["n1", "n2"];
  g.nextNode = 3;
  g.edges = edges;
  g.nextEdge = 100;
  // 正文必须与区间对得上，否则 `lastOfflineSummary` 会被当成「另一段」。
  g.lastOfflineSummary = { at: 1_000, range: { start: 1, end: 12 }, text, model: "test/model" };
  return g;
}

/** e1/e2 成功；e3..e6 失败（全部落在 1–12 内）。 */
function fullGraph(text) {
  return makeGraph(
    {
      e1: successEdge("e1", { start: 1, end: 2 }),
      e2: successEdge("e2", { start: 3, end: 4 }),
      e3: failureEdge("e3", { start: 5, end: 6, action: "edit(file_path=x.md)" }),
      e4: failureEdge("e4", { start: 7, end: 8, action: "edit(file_path=y.md)" }),
      e5: failureEdge("e5", { start: 9, end: 10, action: "edit(file_path=z.md)" }),
      e6: failureEdge("e6", { start: 11, end: 12, action: "edit(file_path=w.md)" }),
    },
    text,
  );
}

/* ───────────────── ① 真该守的那条契约：死路一条边一行 ───────────────── */

tests["T26 提示词：死路仍要求「一条边一行」，且规则只约束「已探明死路」段"] = (t) => {
  const prompt = buildOfflinePrompt({
    facts: "## 目标\n- x",
    messages: [{ role: "user", text: "做件事" }],
    range: { start: 1, end: 9 },
  });
  t.includes(prompt, "「已探明死路」**一条边一行**", "契约原文还在（区间合并会丢 id，这条不能动）");
  t.includes(prompt, "e693—e698", "破折号反例还在（真机丢过 4 个 id）");
  t.includes(prompt, "`- e123 「动作」→ 为什么失败`", "行格式写死");
  t.includes(prompt, "重复 N 次", "重复尝试仍要求逐条写 id、行尾标次数");
  // ★ 决策只写在注释里，**不许**进提示词：进去就等于偷偷改了规则（而且是全量生效的那种改）。
  t.notIncludes(prompt, "斜杠", "决策注释不许泄漏进提示词");
  t.notIncludes(prompt, "slash-merge-audit", "证据脚本名不许进提示词");
};

/* ───────────────── ② 决策必须写在代码里，而不是对话里 ───────────────── */

tests["T26 决策写在 buildOfflinePrompt 里：为什么允许斜杠合并 + 什么条件下复议"] = (t) => {
  const from = SOURCE.indexOf("export function buildOfflinePrompt");
  const to = SOURCE.indexOf("## 原始坐标（本段）", from);
  t.ok(from > 0 && to > from, "要能定位到 buildOfflinePrompt 的函数体");
  const body = SOURCE.slice(from, to);
  t.includes(body, "斜杠合并（`e107/e113`）不在本规则禁止之列", "决策句必须在函数体里（不是文件别处的摆设）");
  t.includes(body, "scripts/slash-merge-audit.mjs", "必须指向可复跑的证据脚本（半年后再问就跑它）");
  t.includes(body, "不改提示词", "要写成**决定**，不是「待议」");
  t.includes(body, "复议", "要写清什么条件下这个决定该被推翻");
  t.includes(body, "60.40%", "要点名被推翻的那个错口径（否则下一个人还会被它骗一次）");
  // 决策块必须在死路规则**附近**（同一段），不能飘到别的规则下面去
  const ruleAt = body.indexOf("一条边一行");
  const noteAt = body.indexOf("斜杠合并（`e107/e113`）不在本规则禁止之列");
  t.ok(Math.abs(noteAt - ruleAt) < 2500, "决策注释要紧贴死路规则（离得太远等于没有）");
};

/* ───────────────── ③ 分类器：什么叫「合并没有改变事实」 ───────────────── */

tests["T26 分类器：同工具+同错误类 = 重复尝试；不同工具 = 必失真"] = (t) => {
  // 真机形状：两次 job_output 失败，差别只是 job id（uuid/hex）⇒ 同一错误类
  const a = failureEdge("e656", {
    start: 1,
    end: 2,
    action: "job_output(job_id=wait-186fbd94344f40da timeout_ms=480000)",
    error: "Error: unknown job wait-186fbd94344f40da",
  });
  const b = failureEdge("e2142", {
    start: 3,
    end: 4,
    action: "job_output(job_id=ffffba256d7d467f timeout_ms=600000)",
    error: "Error: unknown job ffffba256d7d467f",
  });
  const same = slash.classifyPair(a, b);
  t.eq(same.cat, "同工具+同错误类", "同一工具、错误只差一个 job id ⇒ 同一错误类（合并无损）");
  t.eq(same.sameError, false, "但原始错误文本是不同的 —— 所以只比原文会把合理合并判成失真");
  t.eq(same.sameErrorClass, true, "归一之后才是同一个类");

  const read = failureEdge("e113", { start: 5, end: 6, action: "read(file_path=AGENTS.md)", error: "Error: cannot read" });
  t.eq(slash.classifyPair(a, read).cat, "不同工具+不同错误类", "两件不同的事 ⇒ 共享描述必失真");
  t.eq(slash.classifyPair({ result: "success" }, { result: "success" }).cat, "两条都是成功边", "成功边不在规则管辖内");
  t.eq(slash.classifyPair(undefined, a).cat, "id 在图里查不到", "查不到要单列，不许猜");
};

/* ───────────────── ④ 落点：只有死路段里那一次才算违规 ───────────────── */

tests["T26 落点：同一次合并写在「棋谱」不算违规，写在「已探明死路」才算"] = (t) => {
  const text = [
    "## 棋谱（状态节点）",
    "- n3 两次 edit 成功（e1/e2）",
    "## 已探明死路",
    "- e3/e4 「edit(x)」→ 没读过",
    "- e5 「edit(y)」→ 没读过",
    "- e6 「edit(z)」→ 没读过",
  ].join("\n");
  const row = slash.scanFold(fullGraph(text), { session: "sess-slash" });
  t.eq(row.occurrences.length, 2, "两次斜杠合并");
  t.eq(row.occurrences[0].inDeadend, false, "棋谱里的那次（成功边）不算违规");
  t.eq(row.occurrences[0].cat, "两条都是成功边", "而且要认出来它是成功边");
  t.eq(row.occurrences[1].inDeadend, true, "死路段里的那次才是真违规");
  t.eq(row.multiIdLines, 1, "死路段里只有 1 行是多 id 行");
  t.eq(row.soloIdLines, 2, "e5 / e6 各自一行");
  t.eq(row.expandExtraLines, 1, "把那条多 id 行展开只多 1 行 —— 这是「改」的全部格式收益");

  const s = slash.summarize([row]);
  t.eq(s.occurrences, 2, "两次都算进总数（否则又变成「只数想数的」）");
  t.eq(s.successPairs, 1, "成功边单列");
  t.eq(s.deadPairs, 1, "死路段内单列");
  t.eq(s.outsidePairs, 0, "这次没有「他段失败边」");
  t.eq(s.inScopeRate, 1, "1 条有失败边的折痕 / 1 次死路段内合并");
};

/* ───────────────── ⑤ 结构性事实：斜杠不丢 id，破折号才丢 ───────────────── */

tests["T26 不丢 id：斜杠合并两端都命中 ⇒ 补回一条不加；破折号才补得回中间那几条"] = (t) => {
  const merged = [
    "## 已探明死路",
    "- e3/e4 「edit(x)」→ 没读过",
    "- e5 「edit(y)」→ 没读过",
    "- e6 「edit(z)」→ 没读过",
  ].join("\n");
  const g1 = fullGraph(merged);
  const r1 = repairFailuresInText(g1, { start: 1, end: 12 }, merged);
  t.eq(r1.repaired, [], "e3/e4 都被 mentionsEdge 命中 ⇒ 机械补回不该追加任何一条");
  t.eq(r1.text, merged, "正文原样返回（不是「补了但碰巧一样」）");

  const dashed = "## 已探明死路\n- e3—e6 「edit」→ 没读过";
  const g2 = fullGraph(dashed);
  const r2 = repairFailuresInText(g2, { start: 1, end: 12 }, dashed);
  t.eq(r2.repaired, ["e4", "e5"], "**破折号才会真的丢 id** —— 这才是 C607 那条规则的目标");
};

/* ───────────────── ⑥ 分母口径：补回段不算模型正文 ───────────────── */

tests["T26 分母口径：「已探明死路（逐字补充…）」是代码写的，不算进行格式统计"] = (t) => {
  const text = [
    "## 已探明死路",
    "- e1 「a」→ b",
    "## 已探明死路（逐字补充 · 机械补回，不许重试）",
    "- e2 「c」→ d",
    "- e3 「e」→ f",
  ].join("\n");
  const sec = slash.deadendSection(text);
  t.eq(sec.lines.length, 1, "只取模型自己写的那一段（补回段天然一条一边，混进来会把合规率抬成 100%）");
  t.includes(sec.lines[0], "e1", "模型写的那行在");
  t.notIncludes(sec.lines.join("\n"), "e2", "补回段的行不许算进来");
  t.eq(slash.isDeadendSection("已探明死路（逐字补充 · 机械补回，不许重试）"), false, "补回段不是模型正文");
  t.eq(slash.isDeadendSection("已探明死路（不许重试）"), true, "「（不许重试）」仍然是模型写的死路段");
};

/* ───────────────── ⑦ 正则：不许把「换行 + 列表符号」当成合并 ───────────────── */

tests["T26 正则：只认独立的 id 记号（不许把前面贴着字母的 e107 算进来）"] = (t) => {
  t.eq(slash.idsIn("e107/e113"), ["e107", "e113"], "紧凑写法要认");
  t.eq("e108 / e109".match(slash.SLASH_RE)?.length, 1, "带空格的写法要认（模型常这么写）");
  // ★ 判别力在这条：去掉 `(?<![A-Za-z0-9_])` 就会把 `ae107/e113` 这种**不是 id 的字符串**算成合并
  t.eq("…later-ok:ae107/e113".match(slash.SLASH_RE), null, "前面紧贴字母/数字 ⇒ 不是独立 id");
  t.eq("e107/e11345".match(slash.SLASH_RE), null, "五位数字不是 id（`(?![0-9])` 的作用）");
  // ★ 破折号那边才是 `[ \t]*` vs `\s*` 的真坑（本仓记过账：`\s*` 多算 1 次 = 凭空 47 个「被吞掉的 id」）。
  //   本脚本与 `deadend-adherence-audit.mjs` 共用这个口径，所以钉子钉在它身上。
  t.eq(
    countRangeMerges("…↻2，↑later-ok:e117\n- e164 「bash(x)」→ …").dash.length,
    0,
    "换行 + 列表符号**不是**破折号区间（合规摘要不许被记成合并）",
  );
  t.eq(slash.normalizeId("e007"), "e7", "前导零要归一，否则图里查不到变成「未解析」");
  t.eq(slash.lineAt("aaa\ne107/e113 bbb\nccc", 5).startsWith("e107/e113"), true, "行定位要准（样本就是拿它贴原文的）");
};
