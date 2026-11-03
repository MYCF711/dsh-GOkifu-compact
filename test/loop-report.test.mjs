/**
 * loop-report.test.mjs —— 「循环形状」报告的纯函数（C446）
 *
 * 为什么单独测：这份报告是**判据调参的唯一分母**（阈值 4 到底合不合适，得先知道真机怎么分布）。
 * 而它第一版就踩了一个坑：图里的**边没有 seq 字段**，按 `e.seq` 排序 ⇒ 全库 0 条边、
 * 报告写着"真机没有循环"——把 bug 当成了结论。这里把这个坑钉死。
 */
import { orderedEdges, streakRuns, maxStreakIn, streaksAroundFolds, summarize } from "../scripts/loop-report.mjs";

export const tests = {};

const nodes = { n1: { seq: 10 }, n2: { seq: 20 }, n3: { seq: 30 }, n4: { seq: 40 }, n5: { seq: 50 } };
const edge = (id, to, action, sig) => ({ id, from: null, to, action, ...(sig === undefined ? {} : { sig }) });

tests["C446 边没有 seq 字段也要能排序（按终点节点 seq）——第一版就是在这里报「全库 0 条边」"] = (t) => {
  const g = { nodes, edges: { e3: edge("e3", "n3", "a"), e1: edge("e1", "n1", "a"), e2: edge("e2", "n2", "b") } };
  const got = orderedEdges(g).map((e) => e.id);
  t.eq(got.join(","), "e1,e2,e3", "必须按节点 seq 升序，而不是对象插入序");
  // 边上有 evidence 但节点 seq 缺失 ⇒ 回落 evidence.end
  const g2 = { nodes: {}, edges: { e1: { id: "e1", action: "a", evidence: { start: 5, end: 6 } }, e2: { id: "e2", action: "b", evidence: 9 } } };
  t.eq(orderedEdges(g2).map((e) => e.id).join(","), "e1,e2", "没有节点时回落 evidence");
  // 两个都没有 ⇒ 丢（不能拿 NaN 排序，那会静默打乱顺序）
  t.eq(orderedEdges({ nodes: {}, edges: { e1: { id: "e1", action: "a" } } }).length, 0, "没有 seq 的边必须丢掉");
};

tests["C446 连击按指纹算：同一文件的不同编辑不算连击（与生产判据同口径）"] = (t) => {
  const mk = (n, sigOf) => Array.from({ length: n }, (_, i) => ({ action: "edit(file_path=X)", sig: sigOf(i), seq: i + 1 }));
  t.eq(streakRuns(mk(5, (i) => `s${i}`)).max, 1, "参数全不同 ⇒ 最长连击 1");
  const same = streakRuns(mk(5, () => "s"));
  t.eq(same.max, 5, "同一参数 5 次 ⇒ 连击 5");
  t.eq(same.loopShaped, true, "≥4 就是循环形状");
  t.eq(same.loopRuns.length, 1, "只报一个连击段");
  // 老棋谱（无 sig）按 action 算 —— 与 C444 一致
  const legacy = streakRuns([1, 2, 3, 4].map((i) => ({ action: "bash(x)", seq: i })));
  t.eq(legacy.max, 4, "无 sig 时按动作串算");
};

tests["C446 折叠前后对比：before 只看上一次折叠之后，after 到下一次折叠为止"] = (t) => {
  const g = {
    nodes: {},
    edges: {},
    foldMarks: [{ seqEnd: 30, trigger: "pressure" }, { seqEnd: 60, trigger: "pressure" }],
  };
  const edges = [
    { action: "a", seq: 10 }, { action: "a", seq: 20 }, { action: "a", seq: 30 }, // before：3 连击
    { action: "b", seq: 40 }, { action: "c", seq: 50 },                            // after：各自 1
    { action: "d", seq: 70 }, { action: "d", seq: 80 }, { action: "d", seq: 90 }, { action: "d", seq: 100 }, // 第二次折叠后
  ];
  const out = streaksAroundFolds(g, edges);
  t.eq(out.length, 2, "两次折叠两条记录");
  t.eq(out[0].before, 3, "第一次折叠前 3 连击");
  t.eq(out[0].after, 1, "折叠后掉到 1 ⇒ 看起来被打断了");
  t.eq(out[1].before, 1, "第二次折叠前窗口里只有 b/c（各 1）");
  t.eq(out[1].after, 4, "第二次折叠后 4 连击 ⇒ 没打断");
  // maxStreakIn 的区间语义：不包含左端点
  t.eq(maxStreakIn(edges, 0, 30), 3, "(0,30] 里有 3 条 a");
  t.eq(maxStreakIn(edges, 30, 100), 4, "(30,100] 里最多的是 4 条 d");
};

tests["C446 汇总口径：只有「折叠前就有循环形状」的次数才算进打断率的分母"] = (t) => {
  const reports = [
    { overall: { loopShaped: true, edges: 10, max: 6, runs: [] }, folds: [{ trigger: "pressure", before: 6, after: 1, seqEnd: 1 }] },
    { overall: { loopShaped: false, edges: 10, max: 2, runs: [] }, folds: [{ trigger: "pressure", before: 1, after: 1, seqEnd: 2 }] },
  ];
  const s = summarize(reports);
  t.eq(s.sessions, 2, "会话数");
  t.eq(s.loopSessions, 1, "只有 1 个出现循环形状");
  t.eq(s.longest, 6, "全库最长 6");
  t.eq(s.pressureFolds, 2, "两次折叠都算 pressure 类");
  t.eq(s.pressureAfterLoop, 1, "折叠前有循环形状的只有 1 次（分母不能把 before=1 的算进去）");
  t.eq(s.pressureBroke, 1, "那次折完变短了");
};
