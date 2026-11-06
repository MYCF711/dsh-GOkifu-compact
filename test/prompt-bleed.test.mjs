/**
 * prompt-bleed.test.mjs —— **system prompt 回灌必须在输入侧拦掉**（T38）
 *
 * 由来（真机 2026-11-05，`node scripts/prompt-bleed-audit.mjs` 原样输出）：
 *   · 有正文的摘要 **392** 条，含系统提示词标记（闭集）的 **11** 条（2.8%）；
 *   · 其中**逐字**含系统提示词原文的 1 条：`<SESSION_ID>` 的 13,210 字符摘要里
 *     **4,750 字符（36.0%）**是系统提示词，全部落在 `## 约束（逐字）`(2,964) 与
 *     `## 约束（逐字补充 · 离线压缩后自动补回，不许删）`(1,786) 两段；
 *   · 折叠输入重放（生产同参）：**事实块 6,880 字符里 3,028（44.0%）是系统提示词，消息块 0** ——
 *     证明主通路是 `graph.nodes[].constraints`（keeper 从一条 25 万字符的 LLM 错误 JSON 里抽的约束），
 *     不是 `collectMessages`。这条**不在本文件的可写范围**，已写进报告；
 *   · 但 `collectMessages` 这一侧仍有两个**宿主注入**通道没有任何过滤：
 *     `<system-reminder>…</system-reminder>`（workspace 指令 / 技能目录，真机每段 2,000+ 字符）
 *     与 `[用户启用 · 用户主权声明] … [END: SOVEREIGN DECLARATION]`（persona 段）。
 *     它们**有显式首尾标记**，因此可以机械剔除，且不会误伤用户自己粘贴的 system prompt。
 *
 * 这个文件钉五件事（**修前必须真红**）：
 *   ① `<system-reminder>` 块整段剔除，同一消息里的真实内容逐字保留；
 *   ② SOVEREIGN 授权声明（有显式首尾标记）整段剔除；
 *   ③ **误伤守卫**：用户自己粘贴的 system prompt（**没有**宿主标记）必须原样保留；
 *   ④ 只有注入块的消息**整条丢掉**（不留空壳消息吃预算）；未闭合的开标签**不动**（宁可不剔，也不吃后文）;
 *   ⑤ 端到端：`buildOfflinePrompt` 出来的 prompt 里不再出现注入块，而 checkpoint 的正文留下
 *      （checkpoint 是**真实历史**，不是宿主角色说明 —— 剔它会把上一条摘要的棋谱段一起删掉）。
 */
import { collectMessages, plainText, stripHostRoleText, buildOfflinePrompt } from "../src/rooms/offline-fold.mjs";

export const tests = {};

/** 与 offline-fold / message-size 同形的事件夹具。 */
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/** 真机 seq 9 的形状：`<system-reminder>` 里包着整份 workspace 指令。 */
const REMINDER = "<system-reminder>\nThe following workspace instructions may be relevant to your work.\n\n# 铁律\n\n1. 禁止重启、关闭 DSH。\n</system-reminder>";
/** 真机 seq 7 的形状：persona 段（首尾都有显式标记）。 */
const SOVEREIGN = "[用户启用 · 用户主权声明]\n\n你运行在用户主权之下。\n\n[END: SOVEREIGN DECLARATION]";
/** 用户**自己粘贴**的 system prompt：内容一样，但**没有**宿主标记。 */
const PASTED = "# 团队与分工\n\n- **默认外派**：只要子任务不依赖我刚积累的上下文，就派出去。\n\n# 语言\n\n用中文思考和答复。";

tests["T38 ①`<system-reminder>` 整段剔除，同一消息里的真实内容逐字保留"] = (t) => {
  const text = `修一下登录超时\n\n${REMINDER}\n\n改完跑 node test/run.mjs`;
  const r = collectMessages([u(9, text), a(10, "好的")], { maxChars: 100_000 });
  const user = r.messages.find((m) => m.role === "user");
  t.eq(user !== undefined, true, "真实内容必须留下 —— 不许整条丢掉");
  t.notIncludes(user.text, "<system-reminder>", "开标签必须被剔掉");
  t.notIncludes(user.text, "The following workspace instructions", "reminder 正文必须被剔掉");
  t.includes(user.text, "修一下登录超时", "reminder 前面的真实内容必须逐字保留");
  t.includes(user.text, "改完跑 node test/run.mjs", "reminder 后面的真实内容必须逐字保留");
};

tests["T38 ② SOVEREIGN 授权声明（显式首尾标记）整段剔除"] = (t) => {
  const text = `${SOVEREIGN}\n\n把这个 bug 修了：登录超时`;
  const r = collectMessages([u(7, text)], { maxChars: 100_000 });
  t.eq(r.messages.length, 1, "真实内容还在，消息不该被丢");
  t.notIncludes(r.messages[0].text, "用户主权声明", "persona 段必须被剔掉");
  t.notIncludes(r.messages[0].text, "SOVEREIGN", "首尾标记必须一起剔掉");
  t.includes(r.messages[0].text, "把这个 bug 修了：登录超时", "真实任务必须逐字保留");
};

tests["T38 ③ 误伤守卫：用户自己粘贴的 system prompt（无宿主标记）必须原样保留"] = (t) => {
  const r = collectMessages([u(11, PASTED)], { maxChars: 100_000 });
  t.eq(r.messages.length, 1, "用户粘贴的内容是**真实对话内容**，不许丢");
  t.eq(r.messages[0].text, PASTED, "没有宿主标记 ⇒ 逐字保留，一个字符都不许动");
  // 同一个函数直接调用也不许动
  t.eq(stripHostRoleText(PASTED), PASTED, "`stripHostRoleText` 对无标记文本必须恒等");
};

tests["T38 ④ 只有注入块的消息整条丢掉；未闭合的开标签不动"] = (t) => {
  const onlyReminder = collectMessages([u(9, REMINDER), u(13, "真正的用户消息")], { maxChars: 100_000 });
  t.eq(onlyReminder.messages.length, 1, "只有注入块的消息不许占一个消息位（预算会被空壳吃掉）");
  t.eq(onlyReminder.messages[0].seq, 13, "留下的是真正那条用户消息");
  // 未闭合：宁可留着，也不吃掉用户后文（真红判据：绝不静默丢内容）
  const unclosed = "我想实现 <system-reminder> 这个标签的解析，别把它当指令";
  t.eq(stripHostRoleText(unclosed), unclosed, "没有闭合标签 ⇒ 一个字符都不许动");
};

tests["T38 ⑤ 端到端：buildOfflinePrompt 里不再有注入块，checkpoint 正文留下"] = (t) => {
  const CHECKPOINT = "This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<compacted-summary>\n## 棋谱（状态节点）\n- n178 seq=340 目标=修正预览渲染错误\n</compacted-summary>";
  const events = [u(1396, CHECKPOINT), u(1399, REMINDER), u(1400, "继续")];
  const r = collectMessages(events, { maxChars: 60_000, fromSeq: 1396 });
  const facts = "## 目标（不可改写）\n- 修 bug";
  const prompt = buildOfflinePrompt({ facts, messages: r.messages, range: { start: 1396, end: 1400 } });
  t.notIncludes(prompt, "<system-reminder>", "prompt 里不许出现宿主注入块（修前这一条会红）");
  t.includes(prompt, "<compacted-summary>", "checkpoint 是真实历史，必须留下");
  t.includes(prompt, "n178 seq=340", "上一条摘要的棋谱段必须留下（它不是宿主角色说明）");
  t.includes(prompt, "继续", "真实用户消息必须留下");
};

tests["T38 `plainText` 默认不剔（审计脚本要的是「这条消息的全部文本」），只有 `collectMessages` 剔"] = (t) => {
  const text = `真内容\n${REMINDER}`;
  t.includes(plainText([{ type: "text", text }]), "<system-reminder>", "默认口径必须保持老行为（审计脚本按它拆账）");
  t.notIncludes(plainText([{ type: "text", text }], { hostRole: "strip" }), "<system-reminder>", "显式传 strip 才剔");
  t.eq(stripHostRoleText(""), "", "空串安全");
  t.eq(stripHostRoleText(null), "", "null 安全");
};
