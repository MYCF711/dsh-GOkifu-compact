/**
 * structure-audit.test.mjs —— 「`sectionsMissing` 恒假红」的守卫（C638）
 *
 * 病：`describeStructure` 旧判据是 `body.includes("## 死路")`，而正文里那个段叫
 * `## 已探明死路` ⇒ 判据**永远 false**。本机 224 条 `sectionsMissing` 里 221 条点名「死路」，
 * 点开摘要正文那一段就在那里。恒假红的探针比没有探针更坏：人会学会忽略它，
 * 连真的漏段（截断 / 只补回约束段）一起忽略。
 *
 * 守卫三件事，缺一条这个修复就又退化了：
 *   1. **旧判据在真机形状上真红**（对照）—— 证明这不是「本来就没问题」；
 *   2. **新判据认出别名**（`## 已探明死路` / `## 已探明死路（不许重试）` 都是「死路」段）；
 *   3. **真漏段仍然真红** —— 别名只许放宽到「同一个段的另一种叫法」，不许放宽到任意包含，
 *      否则 `## 底` 里有个「死」字都能算命中，探针恒绿，等于删掉探针。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { describeStructure, sectionNames, SECTION_ALIASES } from "../src/rooms/fold-quality.mjs";
import { collectAudits, conclusionOf, judgeMark, legacySectionsMissing, matchSection, summaryTextFor } from "../scripts/structure-audit.mjs";
import { createGraph } from "./graph-fixtures.mjs";

export const tests = {};

/**
 * 真机形状的摘要正文（`<SESSION_ID>` 的 `lastOfflineSummary`，
 * 标题一个不改、内容压短）：`## 已探明死路` 就是那个段。
 */
const REAL_SHAPE = [
  "## 目标",
  "- 把压缩链路修到可交付",
  "## 棋谱（状态节点）",
  "- n1 用户提出目标",
  "## 已探明死路",
  "- e12 `node test/run.mjs` → exit 2（夹具缺失）",
  "## 已验证事实",
  "- n9 构建通过",
  "## 未验证",
  "- 重启后的行为",
  "## 当前节点与最近用户消息",
  "- n7「继续」",
  "## 原始坐标",
  "- 1-306",
  "## 约束（逐字）",
  "- 只读 home",
].join("\n");

/** 一条带失败边的图（`expectFailures` 的判据来源；区间 1-10 内有 e1）。 */
function mkGraphWithFailure() {
  const g = createGraph({ sessionId: "sess-structure", cwd: "E:/x" });
  g.nodes = {
    n1: { id: "n1", kind: "user", seq: 1, turn: 1, text: "目标：修压缩", constraints: ["只读 home"], ts: 1 },
    n2: { id: "n2", kind: "agent", seq: 5, turn: 1, text: "跑测试", ts: 2 },
  };
  g.order = ["n1", "n2"];
  g.nextNode = 3;
  g.edges = {
    e1: {
      id: "e1",
      from: "n2",
      to: null,
      intent: "跑单测",
      action: "node test/run.mjs",
      result: "failure",
      verify: { kind: "none", summary: "" },
      errorSnippet: "exit 2",
      evidence: { start: 5, end: 6 },
      transposition: false,
      // 必须是「新鲜的失败边」：`isDanglingResidue` 会把 to=null 且 ts 超过 10 分钟的边当旧残留滤掉，
      // 那样 failuresInFoldRange 就返回 0（expectFailures=false），这条夹具就测不到死路判据了。
      ts: Date.now(),
    },
  };
  g.nextEdge = 2;
  return g;
}

tests["C638 旧判据在真机形状上真红（对照：这不是「本来就没问题」）"] = (t) => {
  t.eq(legacySectionsMissing(REAL_SHAPE, { expectFailures: true }), ["死路"], "旧 `includes(\"## 死路\")` 对 `## 已探明死路` 必须判缺失（= 真机那条假红）");
  const fixed = describeStructure(REAL_SHAPE, { expectFailures: true });
  t.eq(fixed.sectionsMissing, [], "新判据：`## 已探明死路` 就是「死路」段");
  t.eq(fixed.sectionsPresent, 3, "3/3 段齐全");
  t.eq(fixed.endedCleanly, true, "这条正文本身是干净收束的（假红不是截断造成的）");
};

tests["C638 真漏段仍然真红（别名不许把探针变恒绿）"] = (t) => {
  // 真机 <SESSION_ID> 的截断形状：后段整段没写
  const truncated = '## 目标\n- 把构建跑通\n## 棋谱\n- grep -n "';
  t.eq(describeStructure(truncated, { expectFailures: true }).sectionsMissing, ["死路"], "没有死路段 ⇒ 必须报缺（新旧都红）");
  t.eq(legacySectionsMissing(truncated, { expectFailures: true }), ["死路"], "对照：旧判据在这条上也是红的（真漏段）");

  // 只补回了「约束（逐字）」的截断摘要（真机 <SESSION_ID> 形状）
  const repairOnly = "## 约束（逐字补充 · 离线压缩后自动补回，不许删）\n- 只读 home";
  t.eq(describeStructure(repairOnly, { expectFailures: true }).sectionsMissing, ["目标", "棋谱", "死路"], "只剩机械补回段 ⇒ 三段全缺");
};

tests["C638 别名不越界：`## 已探明死路` 不许同时算成「目标」「棋谱」"] = (t) => {
  const onlyDead = "## 已探明死路\n- e1 失败";
  t.eq(describeStructure(onlyDead, { expectFailures: true }).sectionsMissing, ["目标", "棋谱"], "死路段只顶死路段");
  t.eq(matchSection(sectionNames(onlyDead), "目标").present, false, "「目标」不许被死路段的字面量满足");
  t.eq(matchSection(sectionNames(onlyDead), "棋谱").present, false, "「棋谱」同理");
};

tests["C638 只认同级 `## ` 标题：`# 死路` / `### 死路` / 句子里的「死路」都不算"] = (t) => {
  const wrongLevel = "# 死路\n- e1\n### 死路\n- e2\n已探明死路：e3、e21 均按上文逐字保留";
  t.eq(sectionNames(wrongLevel), [], "一级/三级标题与句子都不产生「段」");
  t.eq(describeStructure(wrongLevel, { expectFailures: true }).sectionsMissing, ["目标", "棋谱", "死路"], "没有二级死路标题 ⇒ 仍然真红（保守）");
  // 但「内容在、标题不在」要能被审计脚本点出来（别让人误以为整段都没了）
  const row = judgeMark({ session: "s", index: 0, mark: { at: 1, seqStart: 1, seqEnd: 10, quality: { sectionsMissing: ["死路"] } }, graph: mkGraphWithFailure(), text: wrongLevel });
  t.eq(row.details[0].mentioned, true, "句子提到过「死路」⇒ 判定里要注明");
};

tests["C638 括号注记是同一段：`目标（不可改写）` / `棋谱（状态节点）` / `已探明死路（不许重试）`"] = (t) => {
  const annotated = "## 目标（不可改写）\n## 棋谱（状态节点）\n## 已探明死路（不许重试）";
  t.eq(sectionNames(annotated), ["目标", "棋谱", "已探明死路"], "全角括号注记在归一化时剥掉");
  t.eq(describeStructure(annotated, { expectFailures: true }).sectionsMissing, [], "三种真机写法都算齐");
  t.eq(sectionNames("## 目标: \n## 棋谱："), ["目标", "棋谱"], "尾部冒号也归一化");
};

tests["C638 别名表是闭集（新增别名必须过这条）"] = (t) => {
  // fold-quality.mjs 里 `REQUIRED_SECTIONS*` 是私有常量 ⇒ 这里用行为钉住「别名表 = 必备段」
  t.eq(Object.keys(SECTION_ALIASES).sort().join(","), ["目标", "棋谱", "死路"].sort().join(","), "别名表必须覆盖且只覆盖必备段");
  t.eq(SECTION_ALIASES.死路.includes("已探明死路"), true, "「已探明死路」是「死路」段的正当叫法");
  for (const [name, aliases] of Object.entries(SECTION_ALIASES)) {
    for (const alias of aliases) {
      t.eq(sectionNames(`## ${alias}`), [alias], `别名「${alias}」归一化后必须还是它自己`);
      for (const other of Object.keys(SECTION_ALIASES)) {
        if (other === name) continue;
        t.eq(matchSection([alias], other).present, false, `别名「${alias}」不许跨段匹配到「${other}」`);
      }
    }
  }
};

tests["C638 没有失败边时不要求死路段（expectFailures=false 的语义没变）"] = (t) => {
  const noDead = "## 目标\n- x\n## 棋谱\n- y";
  t.eq(describeStructure(noDead).sectionsMissing, [], "没有失败边 ⇒ 省略死路段是合理的");
  t.eq(describeStructure(noDead, { expectFailures: true }).sectionsMissing, ["死路"], "有失败边 ⇒ 必须写");
  // 审计脚本里的旧判据必须与生产同口径（否则「对照」那一列是假的）
  t.eq(legacySectionsMissing(noDead, { expectFailures: false }), [], "旧判据：无失败边时不要求死路");
  t.eq(legacySectionsMissing(noDead, { expectFailures: true }), ["死路"], "旧判据：有失败边时要求死路");
};

tests["C638 审计脚本：判据错 / 真漏段 / 无法判定 三种判定都要判得出来"] = (t) => {
  const graph = mkGraphWithFailure();
  const mark = { at: 1, seqStart: 1, seqEnd: 10, trigger: "archive-offline", summaryChars: REAL_SHAPE.length, quality: { sectionsMissing: ["死路"] } };

  const wrong = judgeMark({ session: "sess", index: 0, mark, graph, text: REAL_SHAPE });
  t.eq(wrong.verdict, "判据错", "正文有 `## 已探明死路` ⇒ 判据错");
  t.eq(wrong.details[0].alias, "已探明死路", "点名命中的是哪个写法");
  t.eq(wrong.legacyMissing, ["死路"], "旧判据在这条上仍然红（对照列）");
  t.eq(wrong.probeMissing, [], "生产判据复判已不报缺段");

  const real = judgeMark({ session: "sess", index: 0, mark, graph, text: "## 目标\n## 棋谱" });
  t.eq(real.verdict, "真漏段", "正文确实没有死路段 ⇒ 真漏段（不许改判据）");
  t.eq(real.legacyMissing, ["死路"], "真漏段上新旧判据一致");

  const mixed = judgeMark({ session: "sess", index: 0, mark: { ...mark, quality: { sectionsMissing: ["目标", "死路"] } }, graph, text: "## 已探明死路\n- e1" });
  t.eq(mixed.verdict, "混合", "一段判据错、一段真漏段 ⇒ 混合");

  const unknown = judgeMark({ session: "sess", index: 0, mark, graph, text: null });
  t.eq(unknown.verdict, "无法判定", "正文未落盘 ⇒ 如实说不知道（不猜）");
  t.eq(unknown.probeMissing, null, "没正文就没有生产复判结果");

  t.eq(summaryTextFor(graph, mark).text, null, "没有 lastOfflineSummary ⇒ 正文取不到");
  t.eq(summaryTextFor({ lastOfflineSummary: { range: { start: 1, end: 9 }, text: "x" } }, mark).text, null, "区间对不上 ⇒ 宁可报未落盘");
  t.eq(summaryTextFor({ lastOfflineSummary: { range: { start: 1, end: 10 }, text: "x" } }, mark).text, "x", "区间对上 ⇒ 用这段");
};

tests["C638 端到端：真的去读一个 sessions 目录，结论句要有数"] = (t) => {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "structure-audit-"));
  try {
    const dir = nodePath.join(home, "chess-context", "sessions", "sess-real");
    nodeFs.mkdirSync(dir, { recursive: true });
    const g = mkGraphWithFailure();
    g.foldMarks = [
      { at: 1000, seqStart: 1, seqEnd: 10, trigger: "archive-offline", summaryChars: REAL_SHAPE.length, quality: { sectionsMissing: ["死路"] } },
      // 更早的一次 fold：正文没落盘（只有 summaryChars）—— 默认不占表格，--all 才列
      { at: 500, seqStart: 11, seqEnd: 20, trigger: "archive-offline", summaryChars: 900, quality: { sectionsMissing: ["死路"] } },
    ];
    g.lastOfflineSummary = { at: 1000, range: { start: 1, end: 10 }, text: REAL_SHAPE, model: "m" };
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g));

    const r = collectAudits({ home, limit: 10 });
    t.eq(r.candidates, 2, "两条 foldMark 都带 sectionsMissing");
    t.eq(r.readable, 1, "只有一条正文落盘");
    t.eq(r.rows.length, 1, "默认只列可复判的（表格里每行都要是可核的证据）");
    t.eq(r.rows[0].verdict, "判据错", "真机形状 ⇒ 判据错");

    const line = conclusionOf(r);
    t.includes(line, "可复判 1 条中 判据错 1 条", "结论句带得出判据错");
    t.includes(line, "旧判据", "结论句要摆出旧判据的对照数");
    t.includes(line, "正文未落盘 1 条", "未落盘的要如实计数（不许静默丢）");

    const all = collectAudits({ home, limit: 10, includeUnreadable: true });
    t.eq(all.rows.length, 2, "--all 把未落盘的也列出来");
    t.eq(all.rows[1].verdict, "无法判定", "未落盘那条的判定是「无法判定」");
    t.eq(all.rows[1].fold, 2, "fold 序号按 1 起（对得上 foldMarks 下标）");
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};
