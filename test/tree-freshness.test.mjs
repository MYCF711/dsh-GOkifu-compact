/**
 * tree-freshness.test.mjs —— `index.md` 陈不陈旧的判据（C459）
 *
 * 由来：真机 doctor 报「2 个会话 index.md 落后 graph.json 超过 5 分钟」，
 * 把两个都打开复验 —— **最新节点 id 都在 index.md 里**（`n2467` / `n72`）。
 * 那是 mtime 假阳性：`graph.json` 会被标量写入（foldCount / 压力快照 / 预算计数）不断刷新，
 * `index.md` 只在**节点集合变化**时追加。两个 mtime 本来就不该同步。
 */
import { indexFreshness } from "../scripts/doctor.mjs";

export const tests = {};

const NOW = 1_760_000_000_000;
const MIN = 60 * 1000;

tests["C459 会话还在跑 ⇒ 不判陈旧（活跃会话里 index 落后是常态）"] = (t) => {
  const r = indexFreshness({ graphMtime: NOW - 10 * 1000, indexMtime: NOW - 3 * MIN, now: NOW });
  t.eq(r.stale, false, "图还在更新 ⇒ 不算陈旧");
  t.eq(r.reason, "graph-active", "理由要说清");
};

tests["C459 没有 index.md 且图已静止 ⇒ 陈旧"] = (t) => {
  const r = indexFreshness({ graphMtime: NOW - 10 * MIN, indexMtime: 0, now: NOW });
  t.eq(r.stale, true, "连入口文件都没有");
  t.eq(r.reason, "no-index", "理由");
};

tests["C459 mtime 落后但**内容是最新的** ⇒ 不陈旧（这正是真机那 2 个假阳性）"] = (t) => {
  const r = indexFreshness({
    graphMtime: NOW - 10 * MIN,
    indexMtime: NOW - 30 * MIN,
    now: NOW,
    indexText: "…… 最后一行 | n2467 | 落账 |",
    lastNodeId: "n2467",
  });
  t.eq(r.stale, false, "内容里有最新节点 ⇒ 树其实是新的");
  t.eq(r.reason, "content-fresh", "要能和「mtime 就新」区分开（报告里要能说'假阳性 N 个'）");
};

tests["C459 mtime 落后且内容里缺最新节点 ⇒ 真陈旧"] = (t) => {
  const r = indexFreshness({
    graphMtime: NOW - 10 * MIN,
    indexMtime: NOW - 30 * MIN,
    now: NOW,
    indexText: "…… 最后一行 | n2466 | 落账 |",
    lastNodeId: "n2467",
  });
  t.eq(r.stale, true, "最新节点没进 index ⇒ 模型读不到它");
  t.eq(r.reason, "content-missing-node", "理由要点名是内容缺节点，不是 mtime");
};

tests["C459 拿不到内容时按 mtime 保守判，并标明「没复验」"] = (t) => {
  const r = indexFreshness({ graphMtime: NOW - 10 * MIN, indexMtime: NOW - 30 * MIN, now: NOW });
  t.eq(r.stale, true, "读不到 index 时宁可报出来");
  t.eq(r.reason, "mtime-only", "理由要说明这是没复验过的判断");
  // 边界：落后**刚好等于**阈值（5 分钟）⇒ 仍在容忍范围内，连内容都不用读
  const edge = indexFreshness({ graphMtime: NOW - 10 * MIN, indexMtime: NOW - 15 * MIN, now: NOW, indexText: "n1", lastNodeId: "n1" });
  t.eq(edge.reason, "mtime-fresh", "刚好 5 分钟不判陈旧（阈值是「超过」）");
  // 超过一秒就进入内容复验
  const over = indexFreshness({ graphMtime: NOW - 10 * MIN, indexMtime: NOW - 15 * MIN - 1000, now: NOW, indexText: "n1", lastNodeId: "n1" });
  t.eq(over.reason, "content-fresh", "超过阈值 ⇒ 改按内容判");
};
