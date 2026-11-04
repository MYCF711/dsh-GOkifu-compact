/**
 * input-truncation.test.mjs —— **「输入被裁」必须与「输出没写完」分得开**（C610）
 *
 * 背景（真机 2026-11-05，`scripts/input-truncation-audit.mjs` 的原始输出）：
 *   · 520 张图 / 526 条 foldMark，**0 条**带任何输入侧字段 —— 这件事压根没记；
 *   · 重放 525 条可重放的 mark：**525 条**输入侧被裁过（480 条整条丢弃、519 条正文被切）；
 *   · 交叉表：`truncated:false` 的 238 条**全部**是「输入被裁、模型正常收尾」——
 *     即 100% 的 `truncated:false` 都是**假「没截断」**。
 *
 * 两条截断来源（`src/rooms/offline-fold.mjs`）语义完全不同，本文件钉住它们不许合并：
 *   · 响应侧 `truncated`（`looksTruncated`）—— **模型写没写完**；
 *   · 输入侧 `inputTruncated`（`collectMessages`）—— **模型看没看全**（事件没放进去 / 单条被切）。
 *
 * 这个文件钉五件事：
 *   ① `collectMessages` 要把两种输入侧裁切**聚合**出来（`dropped` / 正文被切）；
 *   ② 端到端：**输入被裁 + 模型正常收尾** ⇒ `inputTruncated:true` 而 `truncated:false`（过去正是这里串味）；
 *   ③ 取值只能是**布尔或 null**（`null` = 不知道），不许用字符串；
 *   ④ 生产者没给 ⇒ 写 `null`，**不许**拿 `false` 冒充「不知道」；
 *   ⑤ 下游今日聚合**单独一个数**，绝不并进 `truncated`。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectMessages, runOfflineFold, applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";
import { todayAggregateFrom, collectGraphFiles } from "../src/ui.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const TMP = nodePath.join(HERE, ".tmp-input-truncation");

/** 与 offline-fold / offline-finish 同形的事件夹具。 */
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

/** 与 offline-finish.test.mjs 同形的最小图（够 runOfflineFold 取事实/约束）。 */
const graph = {
  rootUserNodeIds: ["n1"],
  nodes: {
    n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] },
  },
  edges: {},
};
const measure = () => ({ constraintRecall: 1, failureRecall: 1 });

/** 把 marks 写成一份 graph.json，返回可喂给 todayAggregateFrom 的 home。 */
function seedHome(sessionId, marks) {
  nodeFs.rmSync(TMP, { recursive: true, force: true });
  const dir = nodePath.join(TMP, "chess-context", "sessions", sessionId);
  nodeFs.mkdirSync(dir, { recursive: true });
  const g = { version: 1, sessionId, nodes: {}, edges: {}, order: [], foldCount: marks.length, foldMarks: marks };
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
  return TMP;
}

const today = () => todayAggregateFrom(collectGraphFiles(TMP));

tests["C610 collectMessages 聚合「整条被丢」：dropped>0 ⇒ inputTruncated=true（正文没切也算裁过）"] = (t) => {
  // 四条 800 字符，预算 1000：尾巴优先只装得下最后一条，前面三条**整条没放进去**
  const events = [u(1, "x".repeat(800)), a(2, "y".repeat(800)), u(3, "z".repeat(800)), a(4, "w".repeat(800))];
  const r = collectMessages(events, { maxChars: 1000 });
  t.eq(r.dropped, 3, "三条整条没放进去");
  t.eq(r.inputCutMessages, 0, "没有一条是「正文被切」（是整条丢）");
  t.eq(r.inputTruncated, true, "整条被丢 ⇒ 输入被裁");
  t.eq(typeof r.inputTruncated, "boolean", "聚合值必须是布尔，不许是字符串");
};

tests["C610 collectMessages 聚合「单条正文被切」：per-message 上限命中 ⇒ inputCutMessages=1"] = (t) => {
  // 真机的主来路：perMessageChars 默认 2000，任何超过 2000 字符的消息都会被切
  const events = [u(1, "z".repeat(5000))];
  const r = collectMessages(events, { maxChars: 60000 });
  t.eq(r.messages.length, 1, "这条消息放进去了（不是整条丢）");
  t.eq(r.messages[0].truncated, true, "消息自己带着「正文被切」的标记");
  t.eq(r.dropped, 0, "没有整条丢弃");
  t.eq(r.inputCutMessages, 1, "一条正文被切");
  t.eq(r.inputTruncated, true, "正文被切 ⇒ 输入被裁");
};

tests["C610 输入没裁 ⇒ inputTruncated=false（有证据的「没裁」，不是「不知道」）"] = (t) => {
  const events = [u(1, "把构建跑通"), a(2, "先看配置"), u(3, "别动 prod")];
  const r = collectMessages(events, { maxChars: 60000 });
  t.eq(r.dropped, 0, "没有整条丢弃");
  t.eq(r.inputCutMessages, 0, "没有正文被切");
  t.eq(r.inputTruncated, false, "输入完整 ⇒ false（不是 null）");
};

tests["C610 端到端：输入被裁 + 模型正常收尾 ⇒ inputTruncated:true 而 truncated:false（过去的串味点）"] = async (t) => {
  // 一条 6000 字符的 assistant 消息 ⇒ 必被 per-message 上限切；模型本身写得完整（finish=stop）
  const events = [u(1, "把构建跑通"), a(2, "z".repeat(6000)), u(3, "别动 prod")];
  const callModel = async () => ({
    text: `## 目标\n- 把构建跑通\n- 不许动 prod 配置\n${"摘要正文".repeat(120)}`,
    finish: "stop",
    usage: { completion_tokens: 300 },
    model: "fake",
  });
  const out = await runOfflineFold({ graph, events, rangeStart: 1, rangeEnd: 3, maxTokens: 4000, callModel, measureQuality: measure });
  const chunk = out.chunks[0];
  t.eq(chunk.inputTruncated, true, "输入侧：那条 6000 字符的消息只喂进去 2000 字符 ⇒ 裁过");
  t.eq(chunk.inputCutMessages, 1, "被切的是 1 条");
  t.eq(chunk.truncated, false, "响应侧：finish=stop 且正文够长 ⇒ 模型写完了");

  const g = { foldMarks: [] };
  applyOfflineFoldToGraph(g, out, { now: Date.now(), provider: "offline", model: "fake" });
  const mark = g.foldMarks[0];
  t.eq(mark.truncated, false, "foldMark 的响应侧仍然是 false（模型写完了）");
  t.eq(mark.inputTruncated, true, "foldMark 必须同时留下输入侧证据 —— 旧实现只记 false，这就是假「没截断」");
  t.eq(mark.inputCutMessages, 1, "条数也要落下来，供审计核对");
  t.ne(mark.truncated, mark.inputTruncated, "两个字段**必须能不同**（合成一个就再也分不出「没写完」与「没看全」）");
};

tests["C610 生产者没给 ⇒ 写 null（不知道），不许拿 false 冒充"] = (t) => {
  const g = { foldMarks: [] };
  // 只有响应侧结论、没有输入侧结论的 chunk（旧生产者 / 别处的调用方）
  applyOfflineFoldToGraph(g, { chunks: [{ start: 1, end: 2, text: "摘要" }] }, { now: 1 });
  const mark = g.foldMarks[0];
  t.eq(mark.inputTruncated, null, "没有证据 ⇒ null（不知道），不是 false（没裁）");
  t.eq(mark.inputCutMessages, null, "条数不知道也写 null");
  t.eq(typeof mark.inputTruncated, "object", "null 是 object —— 关键是**不许是字符串**");
};

tests["C610 下游今日聚合：「输入被裁」单独一个数，绝不并进 truncated"] = (t) => {
  const now = Date.now();
  seedHome("session-input-cut", [
    // 输入被裁、模型正常收尾 —— 过去这一条会落进「假没截断」
    { at: now, trigger: "archive-offline", offline: true, truncated: false, inputTruncated: true, inputCutMessages: 1 },
    // 两边都裁
    { at: now, trigger: "pressure", truncated: true, inputTruncated: true, inputCutMessages: 2 },
    // 都没裁
    { at: now, trigger: "pressure", truncated: false, inputTruncated: false, inputCutMessages: 0 },
    // 旧记录：响应侧与输入侧**都没有字段**（两条都不知道，不算截断、也不算「没裁」）
    { at: now, trigger: "pressure" },
  ]);
  const agg = today();
  t.eq(agg.inputTruncated, 2, "两条有输入侧裁切证据（含那条 truncated:false 的）");
  t.eq(agg.truncated, 1, "输出截断只数 1 条 —— 不许把输入侧的 2 条并进来");
  t.eq(agg.truncatedUnknown, 1, "旧记录仍然算「不知道」（C609 的口径不许被这次改动带坏）");
  nodeFs.rmSync(TMP, { recursive: true, force: true });
};
