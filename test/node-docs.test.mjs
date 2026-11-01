/**
 * node-docs.test.mjs —— 节点文档与棋谱一致性判据（2026-11-02，C110）
 *
 * 两个方向的含义完全不同，测试必须分开：
 *   · **缺文档** = 空指针（热清单省略行写「见 nodes/<id>.md」，模型真会去读）⇒ 必须 warn；
 *   · **多余文档** = 陈旧工件（节点已回滚/删除）⇒ 不误导，只计数，不许升级成错误。
 */

import { nodeDocStats, nodeDocVerdict } from "../src/rooms/node-docs.mjs";

export const tests = {};

tests["C110-1 缺文档 / 多余文档分别统计，且带 .md 后缀也算同一节点"] = (t) => {
  const stats = nodeDocStats({ graphNodes: ["n1", "n2", "n3"], files: ["n1.md", "n3", "n9.md"] });
  t.eq(stats.missing.join(","), "n2", `缺文档必须精确：${JSON.stringify(stats.missing)}`);
  t.eq(stats.orphan.join(","), "n9", `多余文档必须精确：${JSON.stringify(stats.orphan)}`);
  t.eq(nodeDocStats({}).missing.length, 0, "空输入不许抛");
};

tests["C110-2 判级：缺文档 warn（空指针）、只有多余文档保持 ok（仅计数）"] = (t) => {
  const missing = nodeDocVerdict({ missing: ["n7"], orphan: [] });
  t.eq(missing.level, "warn", "缺文档必须 warn");
  t.includes(missing.detail, "空指针", "要说明后果（模型会去读、然后 ENOENT）");
  const orphanOnly = nodeDocVerdict({ missing: [], orphan: ["n9", "n10"] });
  t.eq(orphanOnly.level, "ok", "只有陈旧 md 不许报警（不影响引用）");
  t.includes(orphanOnly.detail, "2 个陈旧 md", "但要计数");
  t.eq(nodeDocVerdict({}).level, "ok", "全干净 ⇒ ok");
};
