/**
 * offline-finish.test.mjs —— 「离线补折被截断」下游必须看得见（C609）
 *
 * 背景（真机 2026-11-05）：`graph.foldMarks` 现在的主来路是**离线补折**（283/462 条）。
 * 它的写入点是 `src/rooms/offline-fold.mjs` 的 `applyOfflineFoldToGraph` ——
 * 那里**只写 `truncated`（我们自己的判定）**，不写 `finishReason`（上游的终止原因），
 * 因为 `runOfflineFold` 交出来的 chunk 上只带 `usage` / `model` / `ms`，**根本没有 finish**。
 * 而 `todayAggregateFrom` 只读 `finishReason` ⇒ 离线折叠被截断了，面板上恒等于"没截断"。
 *
 * 这个文件钉三件事：
 *   ① **截断要能被下游看见**：上游 finish=length ⇒ chunk.truncated ⇒ foldMark.truncated ⇒ today.truncated +1；
 *   ② **没截断不许假报**：finish=stop ⇒ 0，且**不落进「不知道」**（false 是有证据的"没截断"）；
 *   ③ **两个字段不许合并**：`finishReason` 仍然是上游原值、`truncated` 仍然是我们的判定，
 *      两者同时在场时只算一次；两者都没有（旧记录）时算「不知道」，**不能**算成"没截断"。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { runOfflineFold, applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";
import { todayAggregateFrom, collectGraphFiles } from "../src/ui.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const TMP = nodePath.join(HERE, ".tmp-offline-finish");

/** 与 offline-fold.test.mjs 同形的最小图（够 runOfflineFold 取事实/约束）。 */
const graph = {
  rootUserNodeIds: ["n1"],
  nodes: {
    n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] },
  },
  edges: {},
};
const u = (seq, text) => ({ type: "user/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const a = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
const events = [u(1, "把构建跑通"), a(2, "先看配置"), u(3, "别动 prod")];

const measure = () => ({ constraintRecall: 1, failureRecall: 1 });

/** 假模型：上游终止原因由参数给定（这就是"夹具里那段上游 finish"）。 */
function fakeModel(finish, text) {
  return async () => ({ text, finish, usage: { completion_tokens: finish === "length" ? 4000 : 300 }, model: "fake" });
}

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

tests["C609 离线折叠被截断（上游 finish=length）⇒ foldMark 与下游 today 都看得出来"] = async (t) => {
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 3,
    maxTokens: 4000,
    callModel: fakeModel("length", "## 目标\n- 半句话"),
    measureQuality: measure,
  });
  t.eq(out.chunks[0].truncated, true, "上游 finish=length ⇒ chunk 必须标 truncated");
  // ★ C650：**这两条断言被反转了**。C609 当初钉的是「chunk 上没有 finish」这个**缺陷事实**
  //   （原文注释：「这正是"foldMark 那条路上游 finish 取不到"的证据，不是笔误」）。
  //   T42/T44 把那个缺陷修掉了（chunk 组装不再丢 `finish`）⇒ 这里钉新合同，
  //   否则「绿」等于要求继续丢字段。反向守卫见 `test/finish-reason.test.mjs`。
  t.eq(out.chunks[0].finish, "length", "chunk 携带上游 finish（写入点据此写 finishReason）");

  const g = { foldMarks: [] };
  const now = Date.now();
  applyOfflineFoldToGraph(g, out, { now, provider: "offline", model: "fake" });
  const mark = g.foldMarks[0];
  t.eq(mark.truncated, true, "foldMark 必须写 truncated（截断证据的落点）");
  t.eq(mark.finishReason, "length", "★ C650：上游原值落进 foldMark.finishReason（以前断言「不许写」，因为当时取不到）");
  t.eq(mark.offline, true, "这条要标成离线补折（来路要能认出来）");

  seedHome("session-truncated", g.foldMarks);
  const agg = today();
  t.eq(agg.truncated, 1, "下游必须数得到这 1 次截断（旧实现恒为 0 —— 这就是本次要修的那件事）");
  t.eq(agg.truncatedUnknown, 0, "有截断证据 ⇒ 不许落进「不知道」");
};

tests["C609 没截断时不许假报：finish=stop ⇒ 0，且不算「不知道」"] = async (t) => {
  const out = await runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 3,
    maxTokens: 4000,
    callModel: fakeModel("stop", "## 目标\n- 把构建跑通\n- 不许动 prod 配置"),
    measureQuality: measure,
  });
  t.eq(out.chunks[0].truncated, false, "finish=stop 且没撞上限 ⇒ 不算截断");

  const g = { foldMarks: [] };
  applyOfflineFoldToGraph(g, out, { now: Date.now(), provider: "offline", model: "fake" });
  t.eq(g.foldMarks[0].truncated, false, "foldMark 要明确写 false（不是留空）");

  seedHome("session-complete", g.foldMarks);
  const agg = today();
  t.eq(agg.truncated, 0, "没截断就一次都不许数");
  t.eq(agg.truncatedUnknown, 0, "truncated=false 是有证据的「没截断」，不是「不知道」");
};

tests["C609 「不知道」与「没截断」必须分得开（旧记录两个字段都没有）"] = async (t) => {
  const now = Date.now();
  seedHome("session-legacy", [
    // 旧记录：C317/C584 之前的 foldMark —— 上游没给 finish，我们也没写 truncated
    { at: now, trigger: "pressure", shadowedTokens: 100, measuredBefore: 1000 },
    // 我们的判定明确说"写完了"
    { at: now, trigger: "archive-offline", offline: true, truncated: false },
  ]);
  const agg = today();
  t.eq(agg.truncated, 0, "两条都不该算截断");
  t.eq(agg.truncatedUnknown, 1, "只有那条旧记录算「不知道」——不许把 truncated=false 也混进来");
};

tests["C609 两种证据同时在场只算一次（truncated 不是 finishReason 的副本，绝不朴素相加）"] = async (t) => {
  const now = Date.now();
  seedHome("session-both", [
    // 上游说 length，我们自己也判了 truncated=true：同一次折叠，**只能算一次**
    { at: now, trigger: "pressure", finishReason: "length", truncated: true },
    // 上游 stop，我们也判了"写完了"：0
    { at: now, trigger: "pressure", finishReason: "stop", truncated: false },
    // 上游口径变体（连字符）：同样要认出来
    { at: now, trigger: "pressure", finishReason: "max-tokens", truncated: true },
  ]);
  const agg = today();
  t.eq(agg.truncated, 2, "两次被截断的折叠各算一次（不许因为两个字段都在就翻倍）");
  t.eq(agg.truncatedUnknown, 0, "三条都有证据 ⇒ 没有「不知道」");

  nodeFs.rmSync(TMP, { recursive: true, force: true });
};
