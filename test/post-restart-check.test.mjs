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

tests["C243 折叠观测字段 + 注入动作：只在新代码跑过之后才 ok，否则 warn（不是 fail）"] = (t) => {
  const stamp = { buildId: "b1", version: "1.17.6", startedAt: 1, pid: 1 };
  const base = { stamp, diskBuildId: "b1", version: "1.17.6", budget: {} };

  // ① 还没有 foldMark ⇒ warn（等等看，不是失败）
  const noFold = evaluatePostRestart({ ...base });
  const nf = noFold.checks.find((c) => c.id === "fold-fields");
  t.eq(nf.level, "warn", "没有 foldMark 只能 warn");

  // ② 老 foldMark（没有 instructionTokens）⇒ warn，且文案要说清两种可能
  const oldFold = evaluatePostRestart({ ...base, latestFold: { at: 1, usage: { inputTokens: 100 } } });
  const of = oldFold.checks.find((c) => c.id === "fold-fields");
  t.eq(of.level, "warn", "老 foldMark 只能 warn");
  t.includes(of.detail, "规则摘要", "要说明「也可能是规则摘要」——别让人误判成重启没生效");

  // ③ 新 foldMark ⇒ ok（这条是"新代码接管"的第二重证据）
  const newFold = evaluatePostRestart({ ...base, latestFold: { at: 2, usage: { inputTokens: 100, instructionTokens: 42 } } });
  const xf = newFold.checks.find((c) => c.id === "fold-fields");
  t.eq(xf.level, "ok", "有 instructionTokens ⇒ ok");
  t.includes(xf.detail, "42", "要报出实际数字");

  // ④ 注入动作：没有 ⇒ warn；有 ⇒ ok 并列出计数
  const noInject = evaluatePostRestart({ ...base });
  t.eq(noInject.checks.find((c) => c.id === "inject-actions").level, "warn", "没有 injectActions ⇒ warn");
  const withInject = evaluatePostRestart({ ...base, budget: { injectActions: { append: 5, replace: 1 } } });
  const wi = withInject.checks.find((c) => c.id === "inject-actions");
  t.eq(wi.level, "ok", "有 injectActions ⇒ ok");
  t.includes(wi.detail, "append=5", "要列出 count");

  // ⑤ 这两条不许把整体判成 fail（它们只是"还没到"）
  t.eq(noFold.ok, true, "只有待观测项时整体仍然是 ok（fail 才算失败）");
};
