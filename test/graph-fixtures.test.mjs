/**
 * graph-fixtures.test.mjs —— 测试夹具层的「返回形状」契约（task-59）
 *
 * 背景：`src/graph.mjs` 的 `addUserNode()` 返回 id 字符串，但名字像「创建一个节点」，
 * 已在 C-17（6 处）与 P6-A（1 处）两次诱导出 `const u = addUserNode(...); ... u.id`
 * （undefined）的误用。测试层现在统一从 `./graph-fixtures.mjs` 取：
 *
 *   · `addUserNode()`   → 完整节点对象（`u.id` 永远有效）
 *   · `addUserNodeId()` → id 字符串（名字自带类型说明）
 *
 * 本文件把这两个形状钉死：谁把 `addUserNode` 改回返回 id 字符串（或把 `addUserNodeId`
 * 改成返回节点对象），这里立刻红 —— 这就是「防第三次」的机械保险。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createGraph, addUserNode, addUserNodeId } from "./graph-fixtures.mjs";
import { addUserNode as addUserNodeFromSrc } from "../src/graph.mjs";

export const tests = {};

tests["夹具层形状：addUserNode 返回完整节点对象（含 id），且就是 g.nodes[id] 本身"] = (t) => {
  const g = createGraph({ sessionId: "fixture-shape-1" });
  const u = addUserNode(g, { seq: 1, text: "目标：跑绿" });
  t.eq(typeof u, "object", "addUserNode 必须返回节点对象（返回 id 字符串正是历史两次误用的温床）");
  t.ok(u !== null, "不能是 null");
  t.eq(typeof u.id, "string", "节点对象必须带 string id");
  t.ok(/^n\d+$/.test(u.id), `id 形状应是 n<数字>，实际 ${u.id}`);
  t.eq(g.nodes[u.id], u, "返回对象必须就是 g.nodes[id]（同一引用，不是副本）");
  t.eq(g.order.at(-1), u.id, "新节点必须在 g.order 末尾");
  t.eq(u.kind, "user", "kind 必须是 user");
  t.eq(u.text, "目标：跑绿", "原话逐字保存");
  t.ok(Array.isArray(u.constraints), "constraints 应是数组");
  // 反例说明：id 字符串的 .id 是 undefined 且不抛错 —— 所以必须靠形状断言拦
  t.eq("n1".id, undefined, "id 字符串的 .id 是 undefined（这正是要避免的静默误用）");
};

tests["夹具层形状：addUserNodeId 返回 id 字符串（不是节点对象）"] = (t) => {
  const g = createGraph({ sessionId: "fixture-shape-2" });
  const id = addUserNodeId(g, { seq: 1, text: "目标：跑绿" });
  t.eq(typeof id, "string", "addUserNodeId 必须返回 id 字符串（名字里的 Id 就是类型说明）");
  t.ok(/^n\d+$/.test(id), `id 形状应是 n<数字>，实际 ${id}`);
  t.ok(g.nodes[id] !== undefined, "id 必须能在 g.nodes 里查到");
  t.eq(g.nodes[id].id, id, "节点自己的 id 必须与返回的 id 一致");
};

tests["夹具层形状：两个 helper 建出的节点逐字段一致（只是返回形态不同）"] = (t) => {
  const a = createGraph({ sessionId: "fixture-shape-3a" });
  const b = createGraph({ sessionId: "fixture-shape-3b" });
  const nodeA = addUserNode(a, { seq: 1, text: "同一段话", constraints: ["必须保持"] });
  const idB = addUserNodeId(b, { seq: 1, text: "同一段话", constraints: ["必须保持"] });
  t.eq(nodeA.id, idB, "同样的调用必须得到同样的 id");
  for (const field of ["id", "kind", "seq", "text"]) {
    t.eq(nodeA[field], b.nodes[idB][field], `字段 ${field} 必须一致`);
  }
  t.eq(JSON.stringify(nodeA.constraints), JSON.stringify(b.nodes[idB].constraints), "constraints 必须一致");
};

tests["夹具层边界：生产 src 的 addUserNode 仍然返回 id 字符串（本任务不改生产行为）"] = (t) => {
  const g = createGraph({ sessionId: "fixture-shape-4" });
  const id = addUserNodeFromSrc(g, { seq: 1, text: "x" });
  t.eq(typeof id, "string", "src/graph.mjs 的 addUserNode 必须保持返回 id 字符串（keeper 依赖）");
  t.ok(g.nodes[id] !== undefined, "id 必须能在 g.nodes 里查到");
};

tests["结构守卫：test/ 下没有文件从 src/graph.mjs 直接导入 addUserNode（防第三次误用）"] = (t) => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const f of nodeFs.readdirSync(here).filter((x) => x.endsWith(".mjs") && x !== "graph-fixtures.mjs")) {
    const text = nodeFs.readFileSync(nodePath.join(here, f), "utf8");
    for (const line of text.split("\n")) {
      if (!/from\s+"\.\.\/src\/graph\.mjs"/.test(line)) continue;
      const names = /\{([^}]*)\}/.exec(line)?.[1] ?? "";
      if (/(^|,)\s*addUserNode\s*(,|$)/.test(names)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  t.eq(offenders.length, 0, `这些文件还在直接引 src 的 addUserNode（应改引 ./graph-fixtures.mjs 的 addUserNode 或 addUserNodeId）：\n${offenders.join("\n")}`);
};
