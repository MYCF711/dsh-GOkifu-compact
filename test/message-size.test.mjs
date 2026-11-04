/**
 * message-size.test.mjs —— **单条消息正文上限（`perMessageChars`）的行为守卫**（C612）
 *
 * 背景（真机 2026-11-05，`scripts/message-size-audit.mjs` 的原始输出）：
 *   · 52,159 条消息 / 79.4M 字符：p50 795、p90 3,278、p99 14,317、max 251,157；
 *   · 2000 只切 18.9% 的消息，而切掉的字符里 **90.2% 是脚手架** ——
 *     assistant 的 `reasoning` 块 56.4% + `<system-reminder>` 样板 33.8%，
 *     真实用户输入只占 7.2%、assistant 正文 2.6%（"长的是工具输出"证伪：`tool/result` 一条都不进输入）；
 *   · 重放 616 条 foldMark：区间文本覆盖率 30.5%(2000) → 31.5%(8000)，只 +1.0 个百分点，
 *     而装下的文本条数 38.7 → 28.1（−27%）、工具行 51.7 → 37.2（−28%）。
 *   ⇒ **结论：默认值保持 2000**（理由写在 `src/rooms/offline-fold.mjs` 的 `take()` 里）。
 *
 * 这个文件钉六件事（改默认值的人一定会看到红）：
 *   ① 默认值**就是** 2000：2000 字符不切、2001 字符切；
 *   ② 截断要**留痕**：`truncated:true` + 正文里带「本轮截断 N 字符」+ 头 70%/尾 30%；
 *   ③ 旋钮可用且语义正确：显式传 8000 时 8000 字符不切、8001 切；`<500` 夹到 500；`0`/`undefined` 回落 2000；
 *   ④ **长工具输出**：`tool/result` 一条都不进输入（所以"切了正好"），`tool/call` 摘要行固定 120 字符上限，
 *      挤不进工具预算时进 `dropped`（留痕在账上）；
 *   ⑤ 单条放宽**不会突破总预算**：`perMessageChars = Infinity` 时 `chars <= maxChars` 仍成立；
 *   ⑥ 审计脚本与生产**同源**：`PRODUCTION_PER_MESSAGE_CHARS` 与实测默认值一致（漂了就红）。
 */
import { collectMessages, toolDigestLine } from "../src/rooms/offline-fold.mjs";
import { CANDIDATES, PRODUCTION_PER_MESSAGE_CHARS, TOOL_LINE_CHARS } from "../scripts/message-size-audit.mjs";

export const tests = {};

const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const tool = (seq, name, args) => ({ type: "tool/call", seq, data: { name, arguments: JSON.stringify(args) } });
const toolResult = (seq, text) => ({ type: "tool/result", seq, data: { message: { content: [{ type: "text", text }] } } });

/** `truncateFor` 的固定格式（`…[本轮截断 N 字符]…`）。测试按它算期望长度，不猜。 */
const markerOf = (cut) => `…[本轮截断 ${cut} 字符]…`;

tests["C612 默认单条上限 = 2000：2000 字符不切、2001 字符切（默认值漂了这里就红）"] = (t) => {
  const exact = collectMessages([u(1, "x".repeat(2000))], { maxChars: 100_000 });
  t.eq(exact.messages.length, 1, "2000 字符的消息要整条放进去");
  t.eq(exact.messages[0].truncated, undefined, "没超上限 ⇒ 不带 truncated 标记");
  t.eq(exact.messages[0].text.length, 2000, "正文原样");
  t.eq(exact.inputCutMessages, 0, "没有正文被切");

  const over = collectMessages([u(1, "x".repeat(2001))], { maxChars: 100_000 });
  t.eq(over.messages.length, 1, "超上限也只截断、不整条丢");
  t.eq(over.messages[0].truncated, true, "超 1 个字符也要留痕");
  t.eq(over.inputCutMessages, 1, "被切的条数记进 inputCutMessages");
  t.eq(over.inputTruncated, true, "输入侧被裁 ⇒ inputTruncated=true");
};

tests["C612 截断留痕：正文里带「本轮截断 N 字符」，且保留头 70% / 尾 30%"] = (t) => {
  const body = `${"H".repeat(1200)}${"M".repeat(600)}${"T".repeat(1200)}`; // 3000 字符
  const r = collectMessages([u(1, body)], { maxChars: 100_000 });
  const text = r.messages[0].text;
  // perCap 2000 ⇒ keepHead 1400 / keepTail 590 ⇒ 切掉 3000-1400-590 = 1010 字符
  const marker = markerOf(1010);
  t.includes(text, marker, "正文里必须能看见「切了多少字符」——这是审计对账的唯一线索");
  t.eq(text.length, 1400 + 1 + marker.length + 1 + 590, "长度 = 头 1400 + 换行 + 标记 + 换行 + 尾 590");
  t.eq(text.slice(0, 1400), `${"H".repeat(1200)}${"M".repeat(200)}`, "头 70%（1400 字符）原样保留");
  t.eq(text.slice(-590), "T".repeat(590), "尾 30%（590 字符）原样保留 —— 结论通常在尾部");
};

tests["C612 旋钮语义：显式 8000 时 8000 不切、8001 切；<500 夹到 500；0/undefined 回落 2000"] = (t) => {
  const r8000 = collectMessages([u(1, "x".repeat(8000)), u(2, "y".repeat(8001))], { maxChars: 100_000, perMessageChars: 8000 });
  t.eq(r8000.messages[0].truncated, undefined, "8000 字符 = 上限本身，不切");
  t.eq(r8000.messages[1].truncated, true, "8001 字符要切");
  t.eq(r8000.inputCutMessages, 1, "只切了一条");

  const clamped = collectMessages([u(1, "z".repeat(600))], { maxChars: 100_000, perMessageChars: 100 });
  t.eq(clamped.messages[0].truncated, true, "perMessageChars=100 也要按 500 夹取后切");
  // room = max(500, 100) = 500 ⇒ keepHead 350 / keepTail 140 ⇒ 切掉 600-350-140 = 110
  t.eq(clamped.messages[0].text.length, 350 + 1 + markerOf(110).length + 1 + 140, "room=500 ⇒ 头 350 / 尾 140（不是按 100 切）");

  for (const bad of [0, undefined, null, Number.NaN]) {
    const r = collectMessages([u(1, "w".repeat(4000))], { maxChars: 100_000, perMessageChars: bad });
    t.eq(r.messages[0].truncated, true, `perMessageChars=${String(bad)} 必须回落 2000（否则 4000 字符不会被切）`);
  }
};

tests["C612 长工具输出：tool/result 一条都不进输入，tool/call 摘要行有固定上限"] = (t) => {
  // 30 万字符的工具输出 —— 老问题「长的是工具输出」在这里被直接证伪
  const events = [u(1, "把构建跑通"), toolResult(2, "L".repeat(300_000)), a(3, "看完了")];
  const r = collectMessages(events, { maxChars: 100_000 });
  t.eq(r.messages.length, 2, "只收 user/assistant 文本（工具结果被跳过）");
  t.eq(r.messages.some((m) => m.role === "tool"), false, "没有 tool 角色的消息");
  t.eq(r.chars, "把构建跑通".length + "看完了".length, "30 万字符的工具输出一个字符都没进输入");
  t.eq(r.inputTruncated, false, "工具结果再长也不构成「输入被裁」");

  // 工具**调用**摘要行走另一条路：参数压到 80 字符 + `…`
  const digest = toolDigestLine({ name: "bash", arguments: JSON.stringify({ command: "Q".repeat(500) }) });
  t.ok(digest.length <= TOOL_LINE_CHARS, `摘要行必须 ≤ ${TOOL_LINE_CHARS} 字符（实测 ${digest.length}）`);
  t.includes(digest, "…", "被切的参数要留「…」——切了要看得见");

  // 挤不进工具预算的工具行走 dropped（留痕在账上），不影响文本行
  const many = [tool(1, "bash", { command: "a".repeat(80) }), tool(2, "bash", { command: "b".repeat(80) }), tool(3, "bash", { command: "c".repeat(80) })];
  const tight = collectMessages([...many, u(4, "把构建跑通")], { maxChars: 1200, toolShare: 0.1 });
  t.eq(tight.messages.filter((m) => m.role === "tool").length, 1, "工具预算 toolCap=120 只放得下 1 行");
  t.eq(tight.dropped, 2, "放不下的工具行要记进 dropped（否则面板看不出少了几次调用）");
  t.eq(tight.messages.some((m) => m.role === "user"), true, "工具预算紧不许把文本行挤掉（C490 的形状）");
};

tests["C612 单条放宽不突破总预算：perMessageChars=Infinity 时仍按 maxChars 截断"] = (t) => {
  const events = [u(1, "p".repeat(25_000)), u(2, "q".repeat(25_000)), u(3, "r".repeat(25_000))];
  const capped = collectMessages(events, { maxChars: 60_000, perMessageChars: Infinity });
  t.eq(capped.messages.length, 3, "三条都还在（各自被截到剩余预算里）");
  t.eq(capped.inputCutMessages, 1, "只有撞上总预算的那条被切 ⇒ 留痕 1 条");
  // `truncateFor` 的 `keepTail = room - keepHead - 10` 里那 10 是**估**的标记长度，
  // 实际标记是 `…[本轮截断 N 字符]…`（15–19 字符）⇒ 每条被切的消息会**溢出 5–9 字符**。
  // 这里把这条已知的 ±ε 钉死（放宽单条上限不该把这个 ε 放大）。
  t.ok(capped.chars <= 60_000 + 20, `总字符必须贴着 maxChars（实际 ${capped.chars}，允许标记的 ±20 溢出）`);
  t.ok(capped.chars >= 59_900, `也不许提前收手（实际 ${capped.chars}）—— 预算没吃满就是白丢上下文`);
};

tests["C612 审计脚本与生产同源：PRODUCTION_PER_MESSAGE_CHARS 必须等于实测默认值"] = (t) => {
  // 用 2000/2001 的边界反推生产默认值 —— 不读源码、只看行为，改默认值必红
  const at2000 = collectMessages([u(1, "x".repeat(PRODUCTION_PER_MESSAGE_CHARS))], { maxChars: 100_000 });
  const atPlus1 = collectMessages([u(1, "x".repeat(PRODUCTION_PER_MESSAGE_CHARS + 1))], { maxChars: 100_000 });
  t.eq(at2000.messages[0].truncated, undefined, `默认值应该是 ${PRODUCTION_PER_MESSAGE_CHARS}（这个长度不该被切）`);
  t.eq(atPlus1.messages[0].truncated, true, `默认值应该是 ${PRODUCTION_PER_MESSAGE_CHARS}（+1 就该被切）`);
  t.eq(PRODUCTION_PER_MESSAGE_CHARS, CANDIDATES[0], "审计脚本的基线档必须就是生产默认值（两处漂了这里就红）");
  t.eq(CANDIDATES.includes(Infinity), true, "候选里必须有「无上限」一档，否则权衡表缺上界");
  t.eq(TOOL_LINE_CHARS, 120, "工具行的固定上限变了 ⇒ 审计报告里的 tool 口径要一起改");
};
