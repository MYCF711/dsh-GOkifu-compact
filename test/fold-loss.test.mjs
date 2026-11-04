/**
 * fold-loss.test.mjs —— **「折叠后失败边消失」的守卫**（C607）
 *
 * 由来（真机，2026-11-04 19:00:57Z，`session-fdd814b1-9c44-4c7d-8777-862d456f21a4`
 * 的 `foldMark #10`，`trigger=archive-offline`，区间 seq 3472-3705）：
 *   doctor 报「压缩保真度 · 丢失的失败边 — e694, e695, e696, e697」，
 *   而这 4 条边的 `evidence` 全都落在折叠区间**内**（3624-3628 / 3624-3630 / 3624-3632 / 3624-3634）。
 *
 * 根因是**两段链**（两段都在 `renderFacts` / 摘要拼装这一处）：
 *   ① `renderFacts` 把动作**从左往右**切 80 字符 ⇒ 6 条死路的动作
 *      `edit(file_path=D:\…\ptc-domain-presets\docs\<文件>)` 全被切在 `…\ptc-do` 上，
 *      **真正有区分度的文件名被切掉了** —— 6 条死路在事实块里长得一模一样；
 *   ② 提示词从未要求「死路一条边一行」，于是模型把 6 条合并成
 *      `e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）`：
 *      中间 4 条 id 当场消失（`failureRecall` 0.43），而且「同一文件」本身是**错的**
 *      （那是 4 个不同文件：full-host / hmr / model / nested）。
 *
 * 修法（三处都在允许范围内，见 `docs/方案书.md` §「失败边逐条出现，不合并、不省略」）：
 *   · `compactAction` —— 动作里的路径压成 basename（80 字符里保住「哪个文件」）；
 *   · `buildOfflinePrompt` —— 死路**一条边一行**，**禁止** `eA—eB` 区间合并；
 *   · `repairMissingFailures` —— 机械补回（与约束补回同构），`failureRecall` 必然 = 1。
 *
 * 本文件里的用例在**旧实现**下必红（见交付报告里的 A/B 对照）。
 */
// ★ 用「命名空间导入」而不是具名导入：旧实现里没有 `compactAction` / `repairMissingFailures` 时，
//   具名导入会让整个 `run.mjs` 在 import 阶段崩掉（它不接 import 错误）——
//   那样**后面所有测试文件都不会跑**，一次回归把全库变成"跑不了"。命名空间导入下，
//   缺函数只会让**这一条用例**红（TypeError），其余照跑。
import * as offlineFold from "../src/rooms/offline-fold.mjs";
import { measureFoldQuality } from "../src/rooms/fold-quality.mjs";

const { buildOfflinePrompt, compactAction, renderFacts, repairMissingFailures, runOfflineFold } = offlineFold;

export const tests = {};

/* ───────────────────────── 真机夹具（逐字来自 graph.json） ───────────────────────── */
const DOCS = String.raw`D:\DeepSeek Harness\default-workspace\projects\dsh\plugins\ptc-domain-presets\docs`;
const POSIX = "/d/DeepSeek Harness/default-workspace/projects/dsh/plugins/ptc-domain-presets/docs";

/** 造一条真机形状的失败边（动作是长 Windows 路径，错误是带引号 POSIX 路径 + 原因）。 */
const failedEdit = (id, file, start, end, to = "n462") => ({
  id,
  // ★ `from`/`to` 必须在图里：`classifyDangling` 会把 `to == null` 的旧边归成 residue，
  //   而 residue **不是**「哪一步失败了」，探针会先把它们排除掉（`failuresInFoldRange`）。
  from: "n461",
  to,
  intent: "",
  action: `edit(file_path=${DOCS}\\${file})`,
  result: "failure",
  verify: { kind: "host-error", summary: `Error: cannot modify "${POSIX}/${file}": file has not been read` },
  errorSnippet: `Error: cannot modify "${POSIX}/${file}": file has not been read — read the file, then retry`,
  evidence: { start, end },
  ts: 1793746126291,
});

/** 6 条连续死路（e693–e698，4 个不同文件）+ 1 条区间外的死路（e699）。 */
function makeGraph() {
  return {
    rootUserNodeIds: ["n1"],
    // `collectConstraints` 按 `order` 走（与真实 graph.json 同形）
    order: ["n1", "n461", "n462"],
    nodes: {
      n1: { id: "n1", seq: 1, kind: "user", text: "把 PTC 域预设装好并核验", constraints: ["不许动 prod 配置"] },
      n461: { id: "n461", seq: 3620, kind: "state", text: "Lead 开始改 4 份验证文档" },
      n462: { id: "n462", seq: 3630, kind: "state", text: "6 次 edit 连续被拒" },
    },
    edges: {
      e693: failedEdit("e693", "full-host-verification.md", 3624, 3626),
      e694: failedEdit("e694", "full-host-verification.md", 3624, 3628),
      e695: failedEdit("e695", "hmr-verification.md", 3624, 3630),
      e696: failedEdit("e696", "model-verification.md", 3624, 3632),
      e697: failedEdit("e697", "nested-verification.md", 3624, 3634),
      e698: failedEdit("e698", "nested-verification.md", 3624, 3636),
      // 区间**外**（3800 > 3705）：不是这次的死路，补回时不许越权带进来
      e699: {
        id: "e699",
        from: "n461",
        to: "n462",
        action: "bash(npm test)",
        intent: "跑测试",
        result: "failure",
        errorSnippet: "exit 1",
        evidence: { start: 3800, end: 3801 },
        ts: 1793746126291,
      },
    },
  };
}

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(3472, "继续把预设装完"), a(3500, "先看 full-host 验证"), u(3705, "装好了吗")];

/** 真机模型输出（abridged）：把 6 条死路合并成一行区间记法。 */
const MERGED = [
  "## 目标",
  "- 把 PTC 域预设装好并核验",
  "",
  "## 棋谱（状态节点）",
  "n439 Lead 规划真实凭据泄漏扫描 → 形成安装前收尾计划。",
  "",
  "## 已探明死路",
  "e693—e698 对同一文件连续 edit → cannot modify（重复 6 次）。",
  "",
  "## 已验证事实",
  "n451 终审 PASS → 无代码 blocker。",
].join("\n");

/** 真机期望形状（修复目标）：一条边一行，动作 + 为什么失败。 */
const PER_EDGE = [
  "## 目标",
  "- 把 PTC 域预设装好并核验",
  "",
  "## 已探明死路",
  '- e693 「edit(file_path=full-host-verification.md)」→ cannot modify（file has not been read）',
  '- e694 「edit(file_path=full-host-verification.md)」→ cannot modify（file has not been read）',
  '- e695 「edit(file_path=hmr-verification.md)」→ cannot modify（file has not been read）',
  '- e696 「edit(file_path=model-verification.md)」→ cannot modify（file has not been read）',
  '- e697 「edit(file_path=nested-verification.md)」→ cannot modify（file has not been read）',
  '- e698 「edit(file_path=nested-verification.md)」→ cannot modify（file has not been read）',
  "",
  "## 约束（逐字）",
  "- 不许动 prod 配置",
].join("\n");

const countOf = (text, needle) => String(text).split(needle).length - 1;

/** 跑一次离线折叠（真 `measureFoldQuality`，与 engine 注入的是同一个函数）。 */
async function fold(summaryText) {
  return runOfflineFold({
    graph: makeGraph(),
    events,
    rangeStart: 3472,
    rangeEnd: 3705,
    callModel: async () => ({ text: summaryText, usage: null, model: "fake" }),
    measureQuality: ({ graph: g, range, summaryText: text }) => measureFoldQuality({ graph: g, range, summaryText: text }),
  });
}

/* ───────────────────────── ① 真机复现：合并成区间 ⇒ 必须逐条补回 ───────────────────────── */

tests["C607 真机复现：模型把 e693—e698 合并成区间 ⇒ 4 条 id 由机械补回，failureRecall 回到 1"] = async (t) => {
  const out = await fold(MERGED);
  const chunk = out.chunks[0];
  t.eq(chunk.quality.expectedFailures, 6, "分母 = 区间内的 6 条失败边（e699 在区间外，不该算）");
  t.eq(chunk.quality.failureRecall, 1, "补回后 failureRecall 必须 = 1（契约：死路逐条出现）");
  t.eq(chunk.quality.missingFailures, [], "补回后 missingFailures 必须清空");
  t.eq(chunk.repairedFailures, 4, "丢了 4 条：e694 / e695 / e696 / e697（e693、e698 在区间记法里逐字出现过）");
  t.eq(chunk.quality.failuresRepairedIds, ["e694", "e695", "e696", "e697"], "补回的是哪 4 条要留痕（否则模型自己漏了多少看不见）");
  // 补回的正文必须是「id + 动作 + 为什么失败」的可读句子
  t.includes(
    chunk.text,
    'e694 「edit(file_path=full-host-verification.md)」→ Error: cannot modify full-host-verification.md: file has not been read',
    "补回行要写清「哪个文件 + 为什么失败」",
  );
  for (const id of ["e694", "e695", "e696", "e697"]) {
    t.eq(countOf(chunk.text, id), 1, `${id} 只许出现一次（补回不是重复堆砌）`);
  }
  // 4 个不同文件都要能读出来 —— 这正是「对同一文件连续 edit」丢掉的信息
  for (const file of ["full-host-verification.md", "hmr-verification.md", "model-verification.md", "nested-verification.md"]) {
    t.includes(chunk.text, file, `补回段要能看出是哪个文件（${file}）`);
  }
  t.eq(chunk.text.includes("e699"), false, "区间外的死路不许补回（越权）");
};

/* ───────────────────────── ② 已经逐条写全 ⇒ 一条都不许补 ───────────────────────── */

tests["C607 不重复补回：模型已逐条写全 ⇒ repairedFailures = 0，每个 id 只出现一次"] = async (t) => {
  const out = await fold(PER_EDGE);
  const chunk = out.chunks[0];
  t.eq(chunk.repairedFailures, 0, "已经逐条写了就别再补（否则摘要里每条死路出现两次）");
  t.eq(chunk.quality.failuresRepaired, undefined, "没补回就不该有 failuresRepaired 字段");
  t.eq(chunk.quality.failureRecall, 1, "本来就该是 1");
  for (const id of ["e693", "e694", "e695", "e696", "e697", "e698"]) {
    t.eq(countOf(chunk.text, id), 1, `${id} 只许出现一次`);
  }
  t.eq(chunk.text.includes("逐字补充"), false, "没缺口就不该出现补回段");
};

/* ───────────────────────── ③ 事实块必须保住「哪个文件」（80 字符切的是盘符前缀） ───────────────────────── */

tests["C607 事实块：动作里的文件名必须活过 80 字符截断（旧实现切在 …\\ptc-do 上）"] = (t) => {
  const facts = renderFacts(makeGraph(), { start: 3472, end: 3705 });
  for (const file of ["full-host-verification.md", "hmr-verification.md", "model-verification.md", "nested-verification.md"]) {
    t.includes(facts, file, `事实块必须能看出是哪个文件（${file}）—— 否则 6 条死路长得一模一样`);
  }
  // 错误原文里真正有用的那半句（原因）也不许被切掉
  t.includes(facts, "file has not been read", "错误原因要留住（它才是「为什么失败」）");
  t.eq(facts.includes(String.raw`D:\DeepSeek Harness`), false, "盘符与目录不该占满 80 字符的预算");
  // 每条失败边仍然是**一行一条**（不许合并）
  for (const id of ["e693", "e694", "e695", "e696", "e697", "e698", "e699"]) {
    t.eq(facts.split("\n").filter((line) => line.startsWith(`- ${id} `)).length, 1, `${id} 必须单独一行`);
  }
};

/* ───────────────────────── ④ 提示词必须点名「一条边一行」并禁止区间合并 ───────────────────────── */

tests["C607 提示词：死路必须一条边一行，且禁止 eA—eB 区间合并"] = (t) => {
  const prompt = buildOfflinePrompt({ facts: "## 目标\n- x", messages: [{ role: "user", text: "做件事" }], range: { start: 1, end: 9 } });
  t.includes(prompt, "一条边一行", "要明确规定逐条写");
  t.includes(prompt, "e693—e698", "要点名真机那个区间写法（不点名模型照样合并）");
  t.includes(prompt, "回查不到原文", "要说清为什么不许合并（可回查是这本棋谱的意义）");
  t.includes(prompt, "「动作」→ 为什么失败", "行格式要写死：动作 + 为什么失败");
  // 旧规则不许被这次改动挤掉
  t.includes(prompt, "引用实体只能引用上面出现过的", "C458 的实体引用规则还在");
  t.includes(prompt, "不许编造", "诚实规则还在");
};

/* ───────────────────────── ⑤ 纯函数：compactAction ───────────────────────── */

tests["C607 compactAction：路径压成 basename，非路径原样，超长才截断"] = (t) => {
  t.eq(
    compactAction(`edit(file_path=${DOCS}\\full-host-verification.md)`),
    "edit(file_path=full-host-verification.md)",
    "`file_path=` 的值压成 basename（路径里有空格，不能按空白切）",
  );
  t.eq(
    compactAction(`Error: cannot modify "${POSIX}/model-verification.md": file has not been read`),
    'Error: cannot modify "model-verification.md": file has not been read',
    "带引号的裸路径也要压",
  );
  t.eq(compactAction("bash(npm test)"), "bash(npm test)", "没有路径就原样");
  t.eq(compactAction("  a\n\nb  "), "a b", "空白归一");
  t.eq(compactAction(null), "", "空值给空串");
  t.eq(compactAction("x".repeat(200)).length, 81, "超长才截断（80 + 省略号）");
  t.eq(compactAction("x".repeat(200)).endsWith("…"), true, "截断了要标出来");
};

/* ───────────────────────── ⑥ 纯函数：repairMissingFailures ───────────────────────── */

tests["C607 repairMissingFailures：空清单原样返回；有清单补一节「逐字补充」"] = (t) => {
  t.eq(repairMissingFailures("## 目标\n- x", []), { text: "## 目标\n- x", repaired: [] }, "没缺口就一个字都不改");
  t.eq(repairMissingFailures("## 目标\n- x", null), { text: "## 目标\n- x", repaired: [] }, "null 也不能炸");

  const graph = makeGraph();
  const fixed = repairMissingFailures("## 目标\n- x", [graph.edges.e695, graph.edges.e697]);
  t.eq(fixed.repaired, ["e695", "e697"], "补回的是哪两条");
  t.includes(fixed.text, "## 已探明死路（逐字补充 · 机械补回，不许重试）", "补回段要有标题（与约束补回同构）");
  t.includes(fixed.text, '- e695 「edit(file_path=hmr-verification.md)」→ Error: cannot modify hmr-verification.md', "e695 的行要可读");
  t.includes(fixed.text, '- e697 「edit(file_path=nested-verification.md)」→ Error: cannot modify nested-verification.md', "e697 的行要可读");
  // 补回行不许带双引号：`describeStructure` 用引号配平判「结尾是否干净」，
  // 截断切在引号里会把「机械补回」误读成「摘要被截断」（假红）。
  t.eq(fixed.text.includes('"'), false, "补回段不许出现双引号");
  t.eq(fixed.text.split("\n").filter((line) => line.startsWith("- e")).length, 2, "一条边一行");
};
