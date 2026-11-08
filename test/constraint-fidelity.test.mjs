/**
 * constraint-fidelity.test.mjs —— 约束在**最终产物**与**每步热清单**里的逐字保真（C656）
 *
 * 真机依据（2026-11-08，pressure fold，seq 509-1600，团队 gokifu-constraint-fidelity）：
 *   · 那一次 fold 走的是 **rules 规则兜底**（hybrid 试模型失败，`fallback="rules"` / `route=null`），
 *     而规则摘要渲染器把约束硬截到 12 条（无省略标记）⇒ 14 条里第 13/14 条**一个字都没进摘要**，
 *     落盘 `quality.constraintRecall = 12/14 = 0.857`、`missingConstraints` 恰为那两条；
 *   · 同一条 12 上限还出现在每步热清单（`cons.slice(0, 12)`，另叠了 120 字符 clip）：
 *     同一份图的热清单里这两条同样为零，且 14 条只有 7 条逐字完整（120 字符 clip）。
 *
 * 这里钉四件事（约束原文全部来自冻结的真机夹具
 * `fixtures/constraint-fidelity-live-2026-11-08.json`，含被丢掉的那两条）：
 *   ① 热清单**逐字**给全部 14 条 —— 不删（12 上限）、不裁（120 clip）；
 *   ② 预算装不下时**显式**省略（条数 + 回查指针），绝不静默丢；渲染条数 + 省略条数 = 总数；
 *   ③ 离线事实块（摘要 prompt）同样全量 —— 提示词写着「一条都不许丢」，就不能先砍 12 条；
 *   ④ 空白变体：正文不许归一化（原文逐字）；「归一」只用于判重/判在（C653 口径）。
 * 规则兜底摘要的端到端断言（foldMark.quality）也在本文件，且**两条折法各一条**：
 *   · `summaryMode="rules"`（零模型）与 **hybrid 试模型全挂 ⇒ 退回 rules**（真机那一次的真实分支）。
 *
 * 反例性：①②③④ 在 3d3d009 上都会红（12 上限 / 120 clip / 只给 12 条）——它们不是同义反复。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph, addUserNodeId, addEdge, settleEdge } from "./graph-fixtures.mjs";
import { renderLedger, collectConstraints } from "../src/rooms/ledger.mjs";
import { renderFacts, allConstraints } from "../src/rooms/offline-fold.mjs";
import { load as loadEngine, makeCtx, makeSession, readGraph } from "./engine-harness.test.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "fixtures", "constraint-fidelity-live-2026-11-08.json"), "utf8"));

export const tests = {};

/** 用冻结的真机约束建一张图（14 条 / 1,585 字符，本身就把 500 token 预算的下限顶穿）。 */
function liveGraph({ sessionId = "fixture-c656", failures = 0 } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNodeId(g, {
    seq: 1,
    text: `${FIXTURE.rootLine}\n${FIXTURE.constraints.join("\n")}`,
    constraints: FIXTURE.constraints.slice(),
  });
  for (let i = 0; i < failures; i += 1) {
    const e = addEdge(g, { from: u, intent: `第 ${i + 1} 次试跑`, action: `bash(npm test ${i})`, evidence: { start: 10 + i * 4, end: 13 + i * 4 } });
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `SyntaxError: bad json at line ${i}` });
  }
  return g;
}

tests["C656 夹具自检：修前是 12/14 且缺失的两条逐字在原文里（基线不是编的）"] = (t) => {
  t.eq(FIXTURE.constraints.length, FIXTURE.constraintCount, "夹具条数必须与分母一致");
  t.eq(FIXTURE.constraintCount - FIXTURE.oldFold.renderedConstraintBullets, FIXTURE.oldFold.missingConstraints.length, "12 条已渲染 + 缺失 = 14");
  for (const c of FIXTURE.oldFold.missingConstraints) t.eq(FIXTURE.constraints.includes(c), true, `「修前丢掉」的两条必须是 14 条原文里的逐字原文：${c.slice(0, 28)}…`);
  t.eq(Math.round(FIXTURE.oldFold.constraintRecall * FIXTURE.constraintCount), 12, "落盘 constraintRecall 必须还原成 12/14");
  t.eq(FIXTURE.oldFold.trigger, "pressure", "修前那次是 pressure 折（不是手动/归档）");
  t.eq(FIXTURE.oldFold.fallback, "rules", "修前那次没有模型可用（走规则兜底）—— 只修模型路径修不好它");
};

tests["C656 热清单逐字给全部 14 条（真机夹具；旧版 12 上限 + 120 clip 会红）"] = (t) => {
  const g = liveGraph({ failures: 16 }); // 16 = 真机 fold2 里的失败边数，保证走主形态而不是最小清单
  t.eq(collectConstraints(g).length, FIXTURE.constraintCount, "约束分母必须是 14");
  const led = renderLedger(g, { maxTokens: 500 });
  t.includes(led.text, "CONSTRAINTS (verbatim):", "约束段必须出现");
  for (const c of FIXTURE.constraints) t.eq(led.text.includes(c), true, `约束必须逐字在热清单里（缺：${c.slice(0, 28)}…）`);
  // 旧版把长约束 clip 成「前 119 字符 + …」：现在不许再出现这种形态
  const long = FIXTURE.constraints.filter((c) => c.length > 120);
  t.ok(long.length >= 5, `夹具里应有 ≥5 条超过 120 字符的约束，实际 ${long.length}`);
  for (const c of long) t.eq(led.text.includes(`${c.slice(0, 119)}…`), false, `长约束不许被截成 120 字符形态：${c.slice(0, 24)}…`);
  // 预算：约束+根目标的下限本身就超 500 ⇒ 必须**如实自报**（C41「宁可超预算也不丢约束」/ C44 归因）
  t.eq(led.fallback, "over-budget", "这份夹具的下限就超预算，必须自报 over-budget（超预算可以，静默不行）");
  t.ok(led.overBudgetBy > 0, `overBudgetBy 必须给出超出量，实际 ${led.overBudgetBy}`);
  t.ok(led.unyieldingTokens >= led.budgetMax, `不可裁下限（约束+根目标）应 ≥ 预算，实际 ${led.unyieldingTokens}/${led.budgetMax}`);
};

tests["C656 20 条约束全部出现（12 上限的反例：旧版只给 12 条，且不留省略标记）"] = (t) => {
  const many = Array.from({ length: 20 }, (_, i) => `约束 ${i + 1}：只能走测试环境，不要动 prod 配置 ${i + 1}。`);
  const g = createGraph({ sessionId: "fixture-c656-20" });
  // 根目标故意**不含**约束正文：否则 ROOT 行的 clip 会把缺失的几条"顺带"带进来，断言就假绿了。
  addUserNodeId(g, { seq: 1, text: "把 20 条约束都记下来，一条都不许丢", constraints: many });
  const led = renderLedger(g, { maxTokens: 5000 }); // 预算宽松：第 13 条起也必须出现，不是预算问题
  for (const c of many) t.eq(led.text.includes(c), true, `第 ${many.indexOf(c) + 1} 条约束必须出现`);
  t.notIncludes(led.text, "CONSTRAINTS_OMITTED", "总量远低于病态上限，不该有省略行");
};

tests["C656 病态超限：显式省略 + 回查指针，且「渲染数 + 省略数 = 总数」（不静默丢）"] = (t) => {
  // 40 × 246 字符 ⇒ 远超病态上限；C533 的教训：超长约束会把 prompt 撑到几十万字符。
  const many = Array.from({ length: 40 }, (_, i) => `约束 ${i + 1}：${"不许动 prod 配置，".repeat(20)}`);
  const g = createGraph({ sessionId: "fixture-c656-many" });
  addUserNodeId(g, { seq: 1, text: many.join("\n"), constraints: many });
  const led = renderLedger(g, { maxTokens: 500 });
  const m = /CONSTRAINTS_OMITTED: (\d+) of (\d+) not listed[^\n]*graph\.json[^\n]*nodes\[\*\]\.constraints/.exec(led.text);
  t.ok(m !== null, "越过病态上限必须留显式省略行（条数 + graph.json 回查指针），不许静默丢");
  if (m === null) return;
  const omitted = Number(m[1]);
  t.eq(Number(m[2]), many.length, "省略行必须给出总数");
  t.ok(omitted > 0 && omitted < many.length, `省略条数应在 (0, ${many.length}) 之间，实际 ${omitted}`);
  const rendered = many.filter((c) => led.text.includes(c)).length;
  t.eq(rendered + omitted, many.length, `渲染条数 ${rendered} + 省略条数 ${omitted} 必须等于总数 ${many.length}（账目闭合）`);
  t.eq(led.text.includes(many[0]), true, "放得下的约束仍然逐字（省略不是整体降级）");

  // 单条就超上限（一次巨量粘贴）：整条进省略行 + 指针 —— 否则「病态上限」对单条巨物形同虚设
  const huge = `必须原样处理这段：${"x".repeat(9000)}`;
  const gHuge = createGraph({ sessionId: "fixture-c656-huge" });
  addUserNodeId(gHuge, { seq: 1, text: "把这段原样处理", constraints: [huge] });
  const ledHuge = renderLedger(gHuge, { maxTokens: 500 });
  t.includes(ledHuge.text, "CONSTRAINTS_OMITTED: 1 of 1", "单条超上限也必须显式省略 + 指针");
  t.ok(ledHuge.tokens < 600, `病态单条不许整条注入热清单（实际 ${ledHuge.tokens} tokens）`);
};

tests["C656 离线事实块（摘要 prompt）逐字给全部 14 条（提示词说「一条都不许丢」）"] = (t) => {
  const g = liveGraph({ failures: 2 });
  t.eq(allConstraints(g).length, FIXTURE.constraintCount, "allConstraints 必须全量（质量报告只给前 5 条）");
  const facts = renderFacts(g, { start: 1, end: 99 });
  const bullets = facts.split("\n").filter((line) => line.startsWith("- ") && FIXTURE.constraints.includes(line.slice(2)));
  t.eq(bullets.length, FIXTURE.constraintCount, `事实块必须 14 条逐字（实际 ${bullets.length}）`);
  for (const c of FIXTURE.constraints) t.eq(facts.includes(c), true, `事实块缺约束：${c.slice(0, 28)}…`);
  t.includes(facts, "## 约束（一条都不许丢）", "标题与内容必须一致（不许标题说全给、内容砍 12 条）");
};

tests["C656 空白变体：不许把正文归一化（旧版 norm+clip 会把双空格压成单空格 ⇒ 不逐字）"] = (t) => {
  // 旧版约束行走 `clip(c, 120)`，而 `clip` 先 `norm()` —— 空白被压平、长约束被截尾，
  // 于是「逐字」只剩个说法。现在只压换行（行结构需要）、只剥 markdown 列表前缀，正文一个字都不改。
  const spaced = "不要动  prod  配置（这里的双空格是原文的一部分）";
  const g = createGraph({ sessionId: "fixture-c656-space" });
  addUserNodeId(g, { seq: 1, text: "x", constraints: [spaced] });
  const led = renderLedger(g, { maxTokens: 5000 });
  t.eq(led.text.includes(spaced), true, "原文里的空白属于正文，热清单不许归一化");

  // 图里两条「只差空白」的原文**都要在**：`measureFoldQuality` 的分母是原文精确匹配
  // （`constraintsInFoldRange` 只做 Set 去重）——渲染层做 squeeze 合并，被合并的那条就会记成 missing，
  // 把保真指标打成假红。「归一」只用于判重/判在（C653 的 restore/repair，已有 offline-fold 用例覆盖），
  // 产物里回写的永远是原文。
  const a = "开启 superagent 模式";
  const b = "开启  superagent  模式";
  const g2 = createGraph({ sessionId: "fixture-c656-space2" });
  addUserNodeId(g2, { seq: 1, text: "x", constraints: [a, b] });
  const led2 = renderLedger(g2, { maxTokens: 5000 });
  t.eq(led2.text.includes(a), true, "第一条原文必须逐字");
  t.eq(led2.text.includes(b), true, "第二条原文（空白变体）也必须逐字 —— 合并会让它变成假缺失");
};

/**
 * 跑一次「真机 14 条约束」的规则兜底 fold，返回最终正文与落盘折痕。
 * `failModels` 非空 ⇒ 走**真机同源**的 hybrid 失败分支（试模型 → 全挂 → 退回规则摘要）。
 */
async function foldWithRules({ dirName, options = {}, ctxOptions = {} }) {
  const { Engine, graphDir } = await loadEngine();
  const dir = nodePath.join(graphDir, dirName);
  const ctx = makeCtx({ measureTotal: () => 300_000, ...ctxOptions });
  const engine = new Engine(ctx, { graphDir: dir, auto: false, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, ...options });
  const session = makeSession({ id: `sess-${dirName}` });
  for (let i = 0; i < 19; i += 1) session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  const userText = `${FIXTURE.rootLine}\n${FIXTURE.constraints.join("\n")}`;
  await ctx.emitRaw("session/event", session, {
    type: "user/message",
    seq: 1,
    data: { id: "u", role: "user", content: [{ type: "text", text: userText }], source: { kind: "prompt" } },
  });
  await ctx.emitRaw("session/event", session, {
    type: "assistant/message",
    seq: 2,
    data: {
      message: {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "先跑测试。" }, { type: "tool-call", id: "c1", name: "bash", arguments: JSON.stringify({ command: "npm test" }) }],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
  });
  await ctx.emitRaw("session/event", session, {
    type: "tool/result",
    seq: 3,
    data: { message: { id: "r", role: "tool", toolCallId: "c1", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "boom\n[exit code: 1]" }], isError: true } },
  });
  // ① 摘要正文（= 最终产物的正文）
  const out = await engine.summarize({ messages: [] }, { session, options: {} }, undefined);
  const text = (out?.summary ?? []).map((block) => String(block.text ?? "")).join("\n");
  // ② 落盘质量（真机就是从这里读到 0.857 的）
  const result = await engine.compactIfNeeded({ session, options: {} }, "pressure", undefined);
  await ctx.emitRaw("agent/status", { agent: { session }, status: "idle" }); // 标量 foldMarks 靠 idle 全量 flush 提交
  const mark = (readGraph(dir, session.id).foldMarks ?? []).at(-1);
  return { out, text, result, mark };
}

/** 14 条逐字 + 分母 14 + 召回 1 + 缺失为空（两条折法共用同一组判据）。 */
function assertFourteen(t, { text, mark, where }) {
  t.includes(text, "## 目标", `${where}：前置 —— 规则摘要必须生成`);
  for (const c of FIXTURE.constraints) t.eq(text.includes(c), true, `${where}：最终产物缺约束（第 ${FIXTURE.constraints.indexOf(c) + 1} 条）：${c.slice(0, 28)}…`);
  t.ok(Boolean(mark && mark.quality), `${where}：foldMark.quality 必须落盘`);
  t.eq(mark.quality.expectedConstraints, FIXTURE.constraintCount, `${where}：分母必须是 14`);
  t.eq(mark.quality.constraintRecall, 1, `${where}：constraintRecall 必须 = 1，实际 ${mark.quality.constraintRecall}（缺 ${JSON.stringify(mark.quality.missingConstraints)}）`);
  t.eq(mark.quality.missingConstraints, [], `${where}：missingConstraints 必须为空（旧版恰是夹具里那两条）`);
  t.eq(mark.quality.modelConstraintRecall, null, `${where}：规则摘要没有模型输出 ⇒ modelConstraintRecall 必须 null`);
}

tests["C656 规则兜底摘要端到端：14 条逐字进最终产物，foldMark.quality.constraintRecall = 1"] = async (t) => {
  // summaryMode=rules：规则摘要本体，**零模型调用**。
  const { out, text, result, mark } = await foldWithRules({ dirName: "c656-rules", options: { summaryMode: "rules" } });
  t.eq(out?.llmStreamCall, false, "前置：规则摘要不走模型");
  t.ok(result !== null, "必须真的 fold（前置：growthFloor/minFoldTokens 被夹具置 0）");
  assertFourteen(t, { text, mark, where: "rules" });
};

tests["C656 真机同源：hybrid 试模型全挂 ⇒ 退回规则摘要，14 条仍然逐字 + 召回 1"] = async (t) => {
  // 这就是 2026-11-08 那次 fold 的真实分支：默认 summaryMode=hybrid，摘要模型不可用 ⇒ catch 里退回 ruleResult()。
  // 只修「模型路径」修不好它 —— 这一条专门守住 catch 分支。
  const { out, text, result, mark } = await foldWithRules({ dirName: "c656-hybrid-fail", ctxOptions: { failModels: new Set(["m"]) } });
  t.eq(out?.degraded, "rules", "模型全挂时必须显式标 degraded=rules");
  t.eq(out?.llmStreamCall, false, "退回规则摘要 ⇒ llmStreamCall=false（最终产物不是模型写的）");
  t.eq(mark?.fallback, "rules", `foldMark.fallback 必须是 rules，实际 ${JSON.stringify(mark?.fallback)}`);
  t.ok(result !== null, "模型全挂时 fold 仍必须落地");
  assertFourteen(t, { text, mark, where: "hybrid→rules" });
};

