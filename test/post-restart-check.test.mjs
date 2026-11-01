/**
 * post-restart-check.test.mjs —— 「重启后新代码真的接管了吗」判定表的回归（2026-11-02，C69）
 *
 * 判据必须是**纯函数**，否则重启后第一眼看到的红/绿就没法信任：
 *   · 没有 build.json ⇒ fail（插件没在本次进程里写过启动戳）
 *   · 戳里没有 buildId / buildId 与磁盘不同 ⇒ fail（旧进程仍在跑）
 *   · 有 over-budget 却没有任何归因字段 ⇒ warn（旧代码，等重启）；字段出现后 ⇒ ok
 *   · 没有样本 / 没有统计文件 ⇒ warn（允许 —— 不是坏）
 */

import { evaluatePostRestart } from "../scripts/post-restart-check.mjs";

export const tests = {};

const byId = (result, id) => result.checks.find((c) => c.id === id);

tests["C69-1 没有 build.json ⇒ fail；有但缺 buildId / 与磁盘不同 ⇒ fail（消息点名磁盘值）"] = (t) => {
  const missing = evaluatePostRestart({ stamp: null, diskBuildId: "aaaa1111bbbb", version: "1.17.1", budget: null });
  t.eq(byId(missing, "stamp").level, "fail", "缺启动戳必须 fail");
  t.eq(missing.ok, false, "有 fail 就不是 ok");

  const legacy = evaluatePostRestart({ stamp: { version: "1.17.1", startedAt: 1, pid: 2 }, diskBuildId: "aaaa1111bbbb", version: "1.17.1", budget: null });
  t.eq(byId(legacy, "buildid").level, "fail", "缺 buildId（旧进程）必须 fail");
  t.includes(byId(legacy, "buildid").detail, "aaaa1111bbbb", "消息要点名磁盘 buildId");

  const stale = evaluatePostRestart({ stamp: { version: "1.17.1", buildId: "cccc2222dddd", startedAt: 1, pid: 2 }, diskBuildId: "aaaa1111bbbb", version: "1.17.1", budget: null });
  t.eq(byId(stale, "buildid").level, "fail", "与磁盘不同必须 fail");
  t.includes(byId(stale, "buildid").detail, "cccc2222dddd", "消息要写运行值");
};

tests["C69-2 版本号不一致 ⇒ fail；一致 ⇒ ok"] = (t) => {
  const stamp = { version: "1.17.1", buildId: "aaaa1111bbbb", startedAt: 1, pid: 2 };
  t.eq(byId(evaluatePostRestart({ stamp, diskBuildId: "aaaa1111bbbb", version: "1.17.1", budget: null }), "version").level, "ok", "一致 ok");
  t.eq(byId(evaluatePostRestart({ stamp, diskBuildId: "aaaa1111bbbb", version: "1.18.0", budget: null }), "version").level, "fail", "不一致 fail");
};

tests["C69-3 预算归因：有 over 但无归因字段 ⇒ warn（旧代码）；字段出现 ⇒ ok；无样本 ⇒ warn"] = (t) => {
  const stamp = { version: "1.17.1", buildId: "aaaa1111bbbb", startedAt: 1, pid: 2 };
  const base = { stamp, diskBuildId: "aaaa1111bbbb", version: "1.17.1" };
  const legacy = evaluatePostRestart({ ...base, budget: { samples: 100, "over-budget": 20 } });
  t.eq(byId(legacy, "budget").level, "warn", "有 over 无归因 ⇒ warn");
  t.includes(byId(legacy, "budget").detail, "旧代码", "要说明是旧代码仍在跑");

  const modern = evaluatePostRestart({ ...base, budget: { samples: 100, "over-budget": 20, budgetFloorOver: 3, budgetIrreducible: 17, overBySession: { s1: 5 } } });
  t.eq(byId(modern, "budget").level, "ok", "归因字段出现 ⇒ ok");
  t.includes(byId(modern, "budget").detail, "floorOver=3", "要报出 floorOver");

  const empty = evaluatePostRestart({ ...base, budget: { samples: 0 } });
  t.eq(byId(empty, "budget").level, "warn", "无样本 ⇒ warn");
  t.eq(evaluatePostRestart({ ...base, budget: null }).ok, true, "没有统计文件不该 fail（warn 即可）");
};
