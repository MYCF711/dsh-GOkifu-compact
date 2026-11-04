/**
 * reasoning-share.test.mjs —— **摘要输入剔除 `reasoning` 块**的行为守卫（C639）
 *
 * 背景（真机 2026-11-05，`node scripts/reasoning-share-audit.mjs` 的原始输出；
 * 534 张图 / 690 条 foldMark / 204 个会话重放）：
 *   · 折叠区间内的字符构成：`assistant:reasoning` **63.5%** / `<system-reminder>` 样板 16.4% /
 *     真实用户输入 14.8% / assistant 正文 5.3% ⇒ **脚手架 80.0%**，真实事件只占 20.0%；
 *   · 同一份预算（maxChars=60,000、perMessageChars=2,000、fromSeq=seqStart）重放：
 *     装下的真实事件 10.80 → 15.87 条/段（**+47.2%**）、真实字符 19,823 → 27,176（+37.1%）、
 *     区间覆盖率 54.6% → **74.8%**（+20.3pp），输入字符总量只动 +737；
 *   · 但**不能一刀切**：结论句占 reasoning 字符的 1.91%，其中"非 reasoning 输入里找不到同 8-gram"的
 *     占 0.73%；失败边证据里只有 12 / 1,870（0.6%）是"只在思考里出现"，且会被 `repairMissingFailures`
 *     逐字补回摘要 ⇒ **降权（只留结论句）而不是丢弃**。
 *
 * 这个文件钉七件事（任何一条回退都会红）：
 *   ① **生产口径**：`collectMessages` 的输入里**没有 reasoning 正文**（草稿纸不进摘要）；
 *   ② **结论句保留**：reasoning 里的"这条死路别再试"必须带着 `（思考摘录）` 标记进输入；
 *   ③ **收益是真的**：同一夹具下"只留结论句"装下的真实事件**严格多于**"含 reasoning"（有具体数）；
 *   ④ **`plainText` 默认行为不变**：其它消费方（`message-size-audit` / `archive-fold` 的直接调用）
 *      仍然拿到全部块 —— 这个旋钮只在 `collectMessages` 的调用点打开；
 *   ⑤ **审计口径等价**：审计脚本的 `asKeepVariant` + 新 `plainText` 必须与老行为**逐字节相同**
 *      （否则 ② 的 Δ 里混着别的东西）；
 *   ⑥ **上限**：单条消息的思考摘录 ≤ 800 字符，超出带「…」；
 *   ⑦ **审计与生产同源**：`PRODUCTION_PER_MESSAGE_CHARS` / `MAX_CHARS` / `VARIANTS` 与实现一致。
 */
import {
  REASONING_CONCLUSION_MAX_CHARS,
  REASONING_CONCLUSION_RE,
  THINKING_EXCERPT_MARK,
  collectMessages,
  plainText,
  reasoningConclusionText,
  reasoningSentences,
} from "../src/rooms/offline-fold.mjs";
import {
  MAX_CHARS,
  PRODUCTION_PER_MESSAGE_CHARS,
  VARIANTS,
  asDropVariant,
  asKeepVariant,
  classifyBlock,
  realTextOf,
  reasoningTextOf,
  replayOne,
  textBlocks,
  variantEvents,
} from "../scripts/reasoning-share-audit.mjs";

export const tests = {};

const u = (seq, body) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text: body }] } } });
const a = (seq, blocks) => ({ type: "assistant/message", seq, data: { message: { content: blocks } } });
const reasoning = (body) => ({ type: "reasoning", text: body });
const text = (body) => ({ type: "text", text: body });
const markerOf = (cut) => `…[本轮截断 ${cut} 字符]…`;

tests["C639 生产口径：reasoning 正文不进摘要输入（草稿纸不是「发生了什么」）"] = (t) => {
  const scratch = "I should read the file first, then run the tests, then update the docs.";
  const events = [a(1, [reasoning(scratch), text("先读文件。")])];
  const r = collectMessages(events, { maxChars: 100_000 });
  t.eq(r.messages.length, 1, "有正文的消息照常进输入");
  t.eq(r.messages[0].text, "先读文件。", "正文原样保留");
  t.notIncludes(r.messages[0].text, "I should read the file first", "reasoning 的草稿纸**一个字符都不该**进摘要输入");
  t.eq(r.messages[0].text.length, "先读文件。".length, "输入里只剩真实正文");

  // 纯思考消息（没有 text 块）⇒ 整条跳过，不占预算
  const onlyThinking = collectMessages([a(1, [reasoning("Let me think about the next step. ".repeat(50))]), u(2, "继续")], { maxChars: 100_000 });
  t.eq(onlyThinking.messages.length, 1, "只有 reasoning 的消息要整条跳过（不许拿草稿纸当'这条消息的内容'）");
  t.eq(onlyThinking.messages[0].role, "user", "留下来的只有真实消息");
};

tests["C639 别一刀切：reasoning 里的结论句要带「（思考摘录）」标记留下"] = (t) => {
  const body = "I should read the file first. 这条死路别再试：edit 会报 cannot modify。另外顺手把 docs 也改了。";
  const r = collectMessages([a(1, [reasoning(body), text("好的")])], { maxChars: 100_000 });
  const input = r.messages[0].text;
  t.includes(input, THINKING_EXCERPT_MARK, "结论句必须带可见标记（否则摘要会以为是 assistant 说的）");
  t.includes(input, "这条死路别再试", "「死路」类结论必须留下");
  t.includes(input, "cannot modify", "结论句的错误原文不能切掉");
  t.notIncludes(input, "I should read the file first", "草稿纸（无结论信号）必须丢掉");
  t.notIncludes(input, "顺手把 docs 也改了", "没有结论信号的句子也要丢");
  t.eq(input.endsWith("好的"), true, "真实正文仍然排在最后（拼接顺序不变）");

  // 判据是闭集：命中/不命中都要能被钉住
  t.eq(REASONING_CONCLUSION_RE.test("do not retry the edit"), true, "英文死路句（do not retry）要认");
  t.eq(REASONING_CONCLUSION_RE.test("root cause: the file was never read"), true, "根因句要认");
  t.eq(REASONING_CONCLUSION_RE.test("Let me look at the module"), false, "普通草稿不算结论句");

  // 切句器：不能把路径/小数切碎
  t.eq(reasoningSentences("先看 ledger.mjs 再跑 0.6 的那档。下一句。"), ["先看 ledger.mjs 再跑 0.6 的那档。", "下一句。"], "按 CJK 句末切，路径与小数不切碎");
  t.eq(reasoningConclusionText("Let me think."), "", "没有结论句 ⇒ 空串（不占预算）");
};

tests["C639 收益是真的：同一份预算，只留结论句装下更多真实事件"] = (t) => {
  // 40 条消息：每条 2,000 字符草稿 + 200 字符正文。预算 = 生产默认的 maxChars=60,000。
  // 含 reasoning 时每条消息被单条上限截到 ~2,000 字符 ⇒ 60,000 只装得下 30 条；只留结论句时 40 条全进（8,000 字符）。
  const events = Array.from({ length: 40 }, (_, i) => a(i + 1, [reasoning("R".repeat(2000)), text("T".repeat(200))]));
  const mark = { seqStart: 1, seqEnd: 40 };
  const keep = replayOne(events, mark, "keep");
  const conclude = replayOne(events, mark, "conclude");
  const drop = replayOne(events, mark, "drop");

  t.eq(keep.realEvents, 30, `含 reasoning 时只装得下 30 条真实事件（实测 ${keep.realEvents}）`);
  t.eq(conclude.realEvents, 40, `只留结论句时 40 条全装下（实测 ${conclude.realEvents}）`);
  t.ok(conclude.realEvents > keep.realEvents, "剔除 reasoning 必须真的多装事件 —— 否则这个改动没有意义");
  t.ok(conclude.realChars > keep.realChars, "真实字符也必须更多");
  t.eq(drop.realEvents >= conclude.realEvents, true, "整块丢弃不会比只留结论句更差（结论句是纯增益的代价）");
  // 输入总量是同一份预算：多装的是**构成**变了，不是偷偷加预算
  t.ok(conclude.chars <= MAX_CHARS, `总字符不许突破 maxChars（实际 ${conclude.chars}）`);
  t.eq(drop.reasoningOnlyMsgs, 0, "整块丢弃后不存在这类消息（定义使然）");
};

tests["C639 plainText 默认行为不变：其它消费方仍然拿到全部块（旋钮只在调用点打开）"] = (t) => {
  const content = [reasoning("草稿"), text("正文"), { type: "tool-call", id: "x" }];
  t.eq(plainText(content), "草稿\n正文", "默认 reasoning=keep（老行为逐字节不变）");
  t.eq(plainText(content, { reasoning: "keep" }), "草稿\n正文", "显式 keep 与默认等价");
  t.eq(plainText([reasoning("草稿"), text("正文")], { reasoning: "drop" }), "正文", "drop 才整块丢");
  t.eq(plainText([reasoning("这条死路别再试"), text("正文")], { reasoning: "conclude" }), `${THINKING_EXCERPT_MARK}这条死路别再试\n正文`, "conclude 只留结论句");
  // 边界：非数组 / 字符串 / 空块
  t.eq(plainText("裸字符串"), "裸字符串", "string 直接返回");
  t.eq(plainText(null), "", "null ⇒ 空串");
  t.eq(plainText([{ type: "text" }, { type: "text", text: "" }]), "", "没有 text 的块不算正文");
};

tests["C639 审计口径等价：asKeepVariant + 新 plainText 必须复刻老行为"] = (t) => {
  // 老行为 = 所有块拼起来；新实现走 asKeepVariant（reasoning → text）后必须逐字节相同
  const content = [reasoning("甲".repeat(10)), text("乙"), reasoning("丙")];
  const events = [a(7, content)];
  const replayed = collectMessages([asKeepVariant(events)[0]], { maxChars: 100_000, perMessageChars: 100_000 });
  t.eq(replayed.messages[0].text, plainText(content), "asKeepVariant 的语义必须就是 C639 之前的 plainText");
  t.eq(reasoningTextOf(events[0]), `甲`.repeat(10) + "\n丙", "reasoningTextOf 只取 reasoning 块");
  t.eq(realTextOf(events[0]), "乙", "realTextOf 只取非 reasoning 块");
  t.eq(variantEvents(events, "conclude"), events, "conclude 口径原样返回（生产口径就是原事件流）");
  t.eq(asDropVariant(events)[0].data.message.content.length, 1, "drop 口径把 reasoning 块删掉");
};

tests["C639 摘录上限 800 字符，超出截断留「…」"] = (t) => {
  const long = "失败".repeat(2000); // 4000 字符，全是结论信号
  const out = reasoningConclusionText(long);
  t.eq(out.length, REASONING_CONCLUSION_MAX_CHARS + 1, `摘录长度 = 上限 + 「…」（实际 ${out.length}）`);
  t.eq(out.endsWith("…"), true, "截断必须留痕");
  t.eq(REASONING_CONCLUSION_MAX_CHARS, 800, "上限变了 ⇒ 审计报告 ④ 的 p99/max 口径要一起改");
  // 上限不触发时原样返回
  const short = "这条死路别再试。";
  t.eq(reasoningConclusionText(short), short, "没超上限就原样返回");
};

tests["C639 审计与生产同源：预算常量 / 三档口径没漂"] = (t) => {
  // 不读源码、只看行为：2,000 字符不切、2,001 切（与 collectMessages 的默认值一致）
  const at = collectMessages([u(1, "x".repeat(PRODUCTION_PER_MESSAGE_CHARS))], { maxChars: 100_000 });
  const over = collectMessages([u(1, "x".repeat(PRODUCTION_PER_MESSAGE_CHARS + 1))], { maxChars: 100_000 });
  t.eq(at.messages[0].truncated, undefined, `生产默认单条上限应该是 ${PRODUCTION_PER_MESSAGE_CHARS}`);
  t.eq(over.messages[0].truncated, true, `生产默认单条上限应该是 ${PRODUCTION_PER_MESSAGE_CHARS}（+1 就该切）`);
  t.eq(MAX_CHARS, 60_000, "写入点预算（engine 的 offlineMaxChars）变了 ⇒ 审计 ② 的口径要一起改");
  t.eq(VARIANTS, ["keep", "conclude", "drop"], "三档口径（含 reasoning / 只留结论句 / 整块丢弃）缺一不可");
  // 块归属：reasoning 必须单独成类，否则 ① 的构成表会把它算进 assistant:text
  t.eq(classifyBlock("assistant", { type: "reasoning", text: "x" }), "assistant:reasoning", "reasoning 要单独成类");
  t.eq(classifyBlock("user", { type: "text", text: "<system-reminder>hi" }), "user:reminder", "<system-reminder> 样板要单独成类");
  t.eq(textBlocks([reasoning("a"), { type: "text" }, { type: "image" }]).length, 1, "只认带 text 的块（image/tool-call 不算正文）");
  // 截断留痕与生产同一格式（这里只核一个，防止两份 truncateFor 漂掉）
  const cut = collectMessages([u(1, `${"H".repeat(1200)}${"M".repeat(600)}${"T".repeat(1200)}`)], { maxChars: 100_000 });
  t.includes(cut.messages[0].text, markerOf(1010), "截断标记的格式与 C612 一致");
};
