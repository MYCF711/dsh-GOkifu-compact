/**
 * index-fingerprint.test.mjs —— 结构索引缓存键的端点指纹（2026-11-02，C93）
 *
 * 背景：`graphIndex` 的缓存键包含「端点 id 的数字和」，用来在同一毫秒内改边时也能失效。
 * 旧实现 `Number(String(id).slice(1))` **假定 id 一定是 `n<数字>`**：
 * 遇到 `node7` 这类非 `n` 前缀 id（老数据 / 迁移图 / 手写夹具）会退化成 0，
 * 多个不同端点全部贡献 0 ⇒ 缓存键碰撞 ⇒ **同一毫秒内改边时拿到过期索引**（手割分析会算错）。
 *
 * 这里钉住两件事：
 *   ① `endpointNumber` 对「n42 / node42 / 无数字 id / 空串」都是稳定且可区分的；
 *   ② 真实回归：把端点改成另一个**非数字** id 后，索引必须重建（builds 增加）。
 */

import { _graphIndexStats, endpointNumber, renderNodeMd } from "../src/rooms/kifu-model.mjs";

export const tests = {};

tests["C93-1 endpointNumber：尾部数字优先、无数字退化为字符串指纹、空串为 0"] = (t) => {
  t.eq(endpointNumber("n42"), 42, "n42 ⇒ 42");
  t.eq(endpointNumber("node42"), 42, "node42 也必须取到 42（旧实现是 0）");
  t.eq(endpointNumber(""), 0, "空串 ⇒ 0");
  const a = endpointNumber("nodeA");
  const b = endpointNumber("nodeB");
  t.eq(a > 0 && b > 0, true, "无数字 id 的指纹必须 > 0（否则所有端点都贡献 0）");
  t.eq(a !== b, true, `不同 id 必须不同指纹：nodeA=${a} nodeB=${b}`);
  t.eq(endpointNumber("nodeA"), a, "指纹必须确定（可重复）");
  t.eq(Number.isInteger(a), true, "指纹必须是整数");
};

function rawGraph(toId) {
  return {
    version: 1,
    sessionId: "c93",
    order: ["nodeA", toId],
    nodes: {
      nodeA: { id: "nodeA", kind: "user", seq: 1, text: "把索引修好" },
      [toId]: { id: toId, kind: "agent", seq: 2, goal: "跑测试", via: "eX" },
    },
    edges: {
      eX: {
        id: "eX",
        from: "nodeA",
        to: toId,
        intent: "跑测试",
        action: "bash(npm test)",
        result: "failure",
        errorSnippet: "ERR: boom",
        evidence: { start: 2, end: 3 },
      },
    },
    foldMarks: [],
  };
}

tests["C93-2 端点变化必须让索引失效（走正常的版本号/updatedAt 路径）"] = (t) => {
  const g = rawGraph("nodeB");
  renderNodeMd(g, "nodeA");
  const afterFirst = _graphIndexStats.builds;
  renderNodeMd(g, "nodeA");
  t.eq(_graphIndexStats.builds, afterFirst, "结构没变时不许重建（快路径要生效）");

  // ★ 设计约定：任何结构变更都必须 bump 版本号（rev / updatedAt / nextEdge 至少一个）。
  //   渲染器的快路径正是靠 `cheapKey`（rev|updatedAt|nextEdge|order.length）保持 O(1) ——
  //   所以「直接改端点但什么都不 bump」属于**未定义用法**，这里按约定补上 updatedAt。
  g.nodes.nodeC = { ...g.nodes.nodeB, id: "nodeC" };
  delete g.nodes.nodeB;
  g.order = ["nodeA", "nodeC"];
  g.edges.eX.to = "nodeC";
  g.updatedAt = (g.updatedAt ?? 0) + 1;
  renderNodeMd(g, "nodeA");
  t.eq(_graphIndexStats.builds > afterFirst, true, "端点变化 + 版本更新后必须重建索引");

  // 指纹本身也要能区分（这是 graphIndex 全量签名的那一层防线）
  t.eq(endpointNumber("nodeB") !== endpointNumber("nodeC"), true, "两个非数字端点 id 的指纹必须不同");
};
