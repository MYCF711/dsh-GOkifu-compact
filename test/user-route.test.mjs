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
import { writeUserRoute, readUserRouteCount, readUserRouteState, userRoutePath, truncateVerbatim } from "../src/rooms/user-route.mjs";
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


/* ───── C668：落盘守卫（假 port，一个字节都不碰真盘）───── */

function fakePort({ files = new Map(), failRename = false } = {}) {
  return {
    files,
    exists: (f) => files.has(f),
    read: (f) => files.get(f),
    write: (f, text) => files.set(f, text),
    rename: (a, b) => {
      if (failRename) throw new Error("EBUSY");
      files.set(b, files.get(a));
      files.delete(a);
    },
    remove: (f) => files.delete(f),
    // 目录分隔符在 Windows 上可能是混合的（join 产出 `\`、夹具里手写 `/`）⇒ 两种前缀都认，
    // 但**返回 basename**：调用方会用 join(dir, name) 重建真实路径。
    list: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(dir) || k.startsWith(dir.replace(/\//g, "\\")))
        .map((k) => k.slice(k.lastIndexOf("\\") + 1).slice(k.lastIndexOf("/") + 1)),
    mtimeMs: () => Date.now(),
  };
}

function graphWithManual(texts) {
  const g = createGraph({ sessionId: "s1" });
  texts.forEach((t, i) => addUserNode(g, { seq: (i + 1) * 2, text: t, manual: true, srcKind: "user" }));
  return g;
}

tests["C668 落盘：0 条手动原话 ⇒ 一个字节都不写（不留噪音文件）"] = (t) => {
  const g = createGraph({ sessionId: "s1" });
  addUserNode(g, { seq: 1, text: "我是孙代理", manual: false, srcKind: "user" });
  const port = fakePort();
  const r = writeUserRoute("D:/fixture/sess", g, { sessionId: "s1", port });
  t.eq(r.ok, false, "不写");
  t.eq(r.reason, "no-manual-messages", "要给出可读原因");
  t.eq(port.files.size, 0, "盘上一个字节都没有");
};

tests["C668 落盘：已有容器条数更多 ⇒ 不覆盖（图落后一回合时保护旧件）"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort();
  const oldContainer = { version: 1, kind: "gokifu-user-route", messages: [{}, {}, {}] };
  port.files.set(userRoutePath(dir), JSON.stringify(oldContainer));
  t.eq(readUserRouteCount(dir, port), 3, "先确认能读出旧件条数");
  const g = graphWithManual(["只说了一句"]);
  const r = writeUserRoute(dir, g, { sessionId: "s1", port });
  t.eq(r.ok, false, "不覆盖");
  t.eq(r.reason.startsWith("would-shrink"), true, `reason 要说清是会变少：${r.reason}`);
  t.eq(JSON.parse(port.files.get(userRoutePath(dir))).messages.length, 3, "旧件逐字没动");
};

tests["C668 落盘：先写 tmp 再 rename（半写文件不会出现）"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort();
  const g = graphWithManual(["你看着办", "修吧"]);
  const r = writeUserRoute(dir, g, { sessionId: "s1", now: 123, port });
  t.eq(r.ok, true, "应当写成功");
  t.eq(r.count, 2, "条数要对");
  t.eq([...port.files.keys()].filter((f) => f.includes(".tmp-")).length, 0, "tmp 必须已 rename 掉，不许残留");
  t.eq(port.files.has(userRoutePath(dir)), true, "目标文件存在");
  t.eq(JSON.parse(port.files.get(userRoutePath(dir))).kind, "gokifu-user-route", "内容可解析");
};

tests["C668 落盘：rename 失败也要清 tmp 且绝不抛错（归档路径不许炸）"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort({ failRename: true });
  const g = graphWithManual(["你看着办"]);
  let threw = null;
  let r = null;
  try {
    r = writeUserRoute(dir, g, { sessionId: "s1", port });
  } catch (error) {
    threw = error;
  }
  t.eq(threw, null, "绝不抛错");
  t.eq(r.ok, false, "失败要返回 ok:false");
  t.eq(String(r.reason).startsWith("rename-failed"), true, `reason 要能定位：${r.reason}`);
  t.eq([...port.files.keys()].filter((f) => f.includes(".tmp-")).length, 0, "tmp 必须被清掉");
  t.eq(port.files.has(userRoutePath(dir)), false, "不许留下半个目标文件");
};

tests["C668 墓碑：把 manual 过滤拿掉（把注入源也当手动）必须红"] = (t) => {
  const g = createGraph({ sessionId: "s9" });
  addUserNode(g, { seq: 1, text: "你看着办", manual: true, srcKind: "user" });
  addUserNode(g, { seq: 3, text: "我是父代理的委派 prompt", manual: false, srcKind: "user" });
  const route = buildUserRoute(g, { sessionId: "s9" });
  t.eq(route.messages.length, 1, "只要少收一条，就说明 manual 判据还在生效");
  t.eq(route.messages[0].text, "你看着办", "收的必须是手动那条");
};

/* ───── C670：两条盲审 P1 缺陷 + 三处健壮性 ───── */

tests["C670/D-1 图被重建时：有旧容器就不许覆盖（新会话无容器仍可写）"] = (t) => {
  const dir = "D:/fixture/sess";
  const g = graphWithManual(["重建后的 C", "重建后的 D"]);
  // 已有 2 条旧容器；重建图也攒到 2 条 ⇒ 旧逻辑会直接盖掉（等条数不算 shrink）
  const seeded = fakePort();
  seeded.files.set(userRoutePath(dir), JSON.stringify({ version: 1, kind: "gokifu-user-route", messages: [{}, {}] }));
  const r = writeUserRoute(dir, g, { sessionId: "s1", port: seeded, graphRepaired: true });
  t.eq(r.ok, false, "重建图 + 有旧容器 ⇒ 不写");
  t.eq(r.reason, "graph-repaired", "要给出可读原因");
  t.eq(JSON.parse(seeded.files.get(userRoutePath(dir))).messages.length, 2, "旧容器逐字没动");
  // 反例：没有旧容器（新会话）时，重建图也该能写 —— 否则全部新会话都被误杀
  const fresh = fakePort();
  const r2 = writeUserRoute(dir, g, { sessionId: "s1", port: fresh, graphRepaired: true });
  t.eq(r2.ok, true, "没有旧容器 ⇒ 允许写（新会话路径）");
};

tests["C670/D-6 已有容器版本不认识 ⇒ 拒绝覆盖（不许静默降级）"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort();
  port.files.set(userRoutePath(dir), JSON.stringify({ version: 99, kind: "gokifu-user-route", messages: [{}, {}, {}, {}] }));
  const r = writeUserRoute(dir, graphWithManual(["你看着办"]), { sessionId: "s1", port });
  t.eq(r.ok, false, "版本不认识就不写");
  t.eq(r.reason, "version-unknown:99", `reason 要点名版本：${r.reason}`);
  t.eq(JSON.parse(port.files.get(userRoutePath(dir))).version, 99, "旧文件没被改写");
  // 解析不出来的同样不许覆盖
  const broken = fakePort();
  broken.files.set(userRoutePath(dir), "{ 这不是 JSON");
  const r2 = writeUserRoute(dir, graphWithManual(["你看着办"]), { sessionId: "s1", port: broken });
  t.eq(r2.reason, "version-unknown:unparsable", `坏文件也要拒写：${r2.reason}`);
};

tests["C670/D-7 崩溃遗留的过期 .tmp-* 会被回收（新鲜的不动）"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort();
  const base = userRoutePath(dir);
  port.files.set(`${base}.tmp-1-old`, "x");
  port.files.set(`${base}.tmp-2-new`, "y");
  port.mtimeMs = (f) => (f.endsWith("-old") ? 0 : Date.now());   // old 视为很早以前
  const r = writeUserRoute(dir, graphWithManual(["你看着办"]), { sessionId: "s1", port, now: Date.now() });
  t.eq(r.ok, true, "正常写入");
  t.eq(r.cleanedTmp, 1, "只回收过期的那一个");
  t.eq(port.files.has(`${base}.tmp-1-old`), false, "过期 tmp 已删");
  t.eq(port.files.has(`${base}.tmp-2-new`), true, "新鲜 tmp 不动（可能是别的进程正在写）");
};

tests["C670/D-9 截断不切开代理对：不许留半个 emoji"] = (t) => {
  // 让第 8000 个 char 正好是 emoji 的高位代理
  const filler = "a".repeat(7999);
  const raw = filler + "😀" + "b".repeat(10);
  const out = truncateVerbatim(raw, 8000);
  t.eq(out.truncated, true, "超长要标 truncated");
  t.eq(out.text.length, 7999, "高位代理落在边界 ⇒ 退一格");
  const last = out.text.charCodeAt(out.text.length - 1);
  t.eq(last >= 0xd800 && last <= 0xdbff, false, "结尾不许是孤立高位代理");
  t.eq([...out.text].every((ch) => ch.length >= 0 && true), true, "逐码点可遍历");
};

tests["C670/D-8 容器 source 必须带真有值的现场量（不许恒 null 的死字段）"] = (t) => {
  const g = graphWithManual(["你看着办"]);
  const route = buildUserRoute(g, { sessionId: "s10", stats: { sessionSeq: 1234 } });
  t.eq(route.source.sessionSeq, 1234, "sessionSeq 要真的写进去");
  t.eq(typeof route.source.foldCount, "number", "foldCount 必须是数（0 也算）");
  t.eq("graphRevision" in route.source, false, "死字段 graphRevision 必须删掉");
  t.eq("sessionEvents" in route.source, false, "死字段 sessionEvents 必须删掉");
};

tests["C670/D-5 delta 坏掉时 CLI 与房间都必须拒写"] = (t) => {
  const dir = "D:/fixture/sess";
  const port = fakePort();
  const r = writeUserRoute(dir, graphWithManual(["你看着办"]), { sessionId: "s1", port, deltaBroken: true });
  t.eq(r.ok, false, "delta 坏 ⇒ 不写");
  t.eq(r.reason, "delta-broken", `reason 要是 delta-broken：${r.reason}`);
  t.eq(port.files.size, 0, "一个字节都没写");
};

export { tests };
