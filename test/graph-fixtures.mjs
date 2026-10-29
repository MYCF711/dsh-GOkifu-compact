/**
 * graph-fixtures.mjs —— 测试夹具层（task-59）
 *
 * 背景：`src/graph.mjs` 的 `addUserNode()` 返回 **id 字符串**，但名字像「创建一个节点」，
 * 已在 C-17（6 处）与 P6-A（1 处）两次诱导出 `const u = addUserNode(...); ... u.id`
 * （undefined）的误用 —— API 形状诱导错误，靠逐处修测试修不干净。
 *
 * 生产 API 不动（`src/keeper.mjs` 仍然拿 id 字符串）。测试层统一从这里取，两个入口语义显式：
 *
 *   · `addUserNode(g, opts)`   → 返回**完整节点对象**（含 id）。新测试用它，`u.id` 永远有效。
 *   · `addUserNodeId(g, opts)` → 返回 **id 字符串**。既有夹具迁移到这里，名字自带类型说明。
 *
 * 为什么不是直接改 src：会波及生产调用点与全部历史夹具（98 处「把返回值当 id 用」），
 * 而这次只需要修测试层；生产行为一个字节不改。
 */

import { addUserNode as addUserNodeImpl } from "../src/graph.mjs";

export * from "../src/graph.mjs";

/** 返回**完整节点对象**（含 id）——`const u = addUserNode(...)` 之后 `u.id` 永远有效。 */
export function addUserNode(g, options) {
  const id = addUserNodeImpl(g, options);
  return g.nodes[id];
}

/** 返回 **id 字符串** —— 名字里的 Id 就是类型说明：别再写 `x.id`。 */
export function addUserNodeId(g, options) {
  return addUserNodeImpl(g, options);
}
