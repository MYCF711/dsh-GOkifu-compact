/**
 * user-route.test.mjs —— 会话级「棋路」导出（C667 初稿）
 *
 * 被测：`scripts/user-route.mjs` 的 `buildUserRoute`（纯函数，只读图）+ keeper 的 `manual` 落账。
 *
 * 这个初稿的判据只有四条，别在这里加法（设计已定）：
 *   ① **只装手动发送的**（`manual === true`）；旧图无该字段 = 未知 ⇒ 不收；
 *   ② **顺序即信息**：按 `g.order` 输出，不排序、不合并、不摘要；
 *   ③ **逐字**：`text` 必须是节点原文（超长只截前缀并标 `truncated`，绝不摘要）；
 *   ④ **不产语义判断**：容器里不许出现 goal / pivot / polarity / lexicon / anchors。
 */

import { createGraph, addUserNode } from "./graph-fixtures.mjs";
import { observeEvent as keepObserve } from "../src/rooms/keeper.mjs";
import { buildUserRoute } from "../scripts/user-route.mjs";

const ev = (type, seq, data) => ({ type, seq, data, time: Date.now() });
const msg = (text, source) => ({ id: `m-${Math.random()}`, role: "user", content: [{ type: "text", text }], source });

function freshState() {
  return { lastUserNodeId: null, lastNodeId: null, constraintDirty: false, injected: 0, foldCount: 0 };
}

const tests = {};

tests["C667 棋路只装手动发送：同样 kind=user，没有 rpcId 的一条都不收"] = (t) => {
  const g = createGraph({ sessionId: "s1" });
  const st = freshState();
  // 手动（GUI）
  keepObserve(g, ev("user/message", 9, msg("修吧", { kind: "user", rpcId: "r-1" })), st);
  // 父代理发给子代理的任务书：kind 也是 user，但没有 rpcId
  keepObserve(g, ev("user/message", 11, msg("你是孙代理，只做静态读穿。", { kind: "user" })), st);
  // 手动（GUI）
  keepObserve(g, ev("user/message", 13, msg("推了仓库吗？", { kind: "user", rpcId: "r-2" })), st);

  const route = buildUserRoute(g, { sessionId: "s1" });
  t.eq(route.messages.length, 2, "只收手动那两条");
  t.eq(route.messages.map((m) => m.text), ["修吧", "推了仓库吗？"], "逐字，且保持原顺序");
  t.eq(route.messages.map((m) => m.seq), [9, 13], "seq 区间要能还原位置（棋路与事件棋谱的缝合点）");
  t.eq(route.source.userNodes, 3, "三个 user 节点都记了（只是过滤时只留手动）");
  t.eq(route.source.manualNodes, 2, "手动计数与实际一致");
};

tests["C667 旧图没有 manual 字段 ⇒ 一条都不收（宁可空，不要假）"] = (t) => {
  const g = createGraph({ sessionId: "s2" });
  addUserNode(g, { seq: 1, text: "旧会话的用户原话" });   // 不给 manual
  const route = buildUserRoute(g, { sessionId: "s2" });
  t.eq(route.messages.length, 0, "未知来源不许当成手动");
  t.eq(route.source.userNodes, 1, "但节点数照实报，便于区分「空局」与「抓取失败」");
};

tests["C667 字段面冻结：容器里不许出现任何语义判断"] = (t) => {
  const g = createGraph({ sessionId: "s3" });
  const st = freshState();
  keepObserve(g, ev("user/message", 1, msg("必须用两个空格缩进，不要营销腔", { kind: "user", rpcId: "r-1" })), st);
  const route = buildUserRoute(g, { sessionId: "s3" });
  const flat = JSON.stringify(route);
  for (const forbidden of ["goal", "pivot", "polarity", "lexicon", "anchors", "directives"]) {
    t.eq(flat.includes(`"${forbidden}`), false, `容器不许出现 ${forbidden}（那是结论，不是棋路）`);
  }
  t.eq(route.kind, "gokifu-user-route", "kind 固定，记忆侧按它识别");
  t.eq(route.version, 1, "version 必须显式（不认识就报错降级，不许静默解析）");
};

tests["C667 逐字：换行与空白原样保留，不 collapse"] = (t) => {
  const g = createGraph({ sessionId: "s4" });
  const st = freshState();
  const raw = "第一行\n\n  缩进两个空格\n末尾无换行";
  keepObserve(g, ev("user/message", 5, msg(raw, { kind: "user", rpcId: "r-1" })), st);
  const route = buildUserRoute(g, { sessionId: "s4" });
  t.eq(route.messages[0].text, raw, "原话必须逐字（棋风就藏在换行和缩进里）");
  t.eq(route.messages[0].truncated, false, "未超上限不标 truncated");
};

tests["C667 超长原话只截前缀并标记：绝不摘要"] = (t) => {
  const g = createGraph({ sessionId: "s5" });
  const st = freshState();
  const long = "长".repeat(8100);
  keepObserve(g, ev("user/message", 7, msg(long, { kind: "user", rpcId: "r-1" })), st);
  const route = buildUserRoute(g, { sessionId: "s5" });
  t.eq(route.messages[0].truncated, true, "超 8000 字要标 truncated");
  t.eq(route.messages[0].text.length, 8000, "只留前 8000 字");
  t.eq(long.startsWith(route.messages[0].text), true, "必须是原话前缀（不是概括）");
};

tests["C667 纯函数：两次构建逐字相同，且不改图"] = (t) => {
  const g = createGraph({ sessionId: "s6" });
  const st = freshState();
  keepObserve(g, ev("user/message", 1, msg("看着办", { kind: "user", rpcId: "r-1" })), st);
  const before = JSON.stringify(g);
  const a = buildUserRoute(g, { sessionId: "s6", builtAt: 1 });
  const b = buildUserRoute(g, { sessionId: "s6", builtAt: 1 });
  t.eq(JSON.stringify(a), JSON.stringify(b), "同图两次构建逐字相同（可重建）");
  t.eq(JSON.stringify(g), before, "图一个字节都不能变");
};

tests["C667 cwd 必须带上：项目级棋路靠它聚起来"] = (t) => {
  const g = createGraph({ sessionId: "s7", cwd: "D:/fixture/proj" });
  const route = buildUserRoute(g, { sessionId: "s7" });
  t.eq(route.cwd, "D:/fixture/proj", "没有 cwd，记忆侧的项目级 scopeKey 就建不起来");
};

tests["C667 旧调用点不给来源 ⇒ 节点不多长字段（既有 graph.json 字节不变）"] = (t) => {
  const g = createGraph({ sessionId: "s8" });
  const u = addUserNode(g, { seq: 1, text: "老调用点" });
  t.eq("manual" in u, false, "没给 manual 就不许凭空长字段");
  t.eq("srcKind" in u, false, "没给 srcKind 同样不许长");
  const withSrc = addUserNode(g, { seq: 3, text: "新调用点", manual: true, srcKind: "user" });
  t.eq(withSrc.manual, true, "给了才写");
  t.eq("rpcId" in withSrc, false, "运行时 id 绝不落进图（只留布尔事实）");
};

export { tests };
