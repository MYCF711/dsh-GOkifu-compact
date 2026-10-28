/**
 * write-fold-evidence.mjs —— 从 evidence/fold触发验证.json 生成同名 .md
 * 为什么分开：md 与 json 必须同源。曾经手写 md 说「4/4 通过」，而 json 里 ②④ 都是 false —— 证据自相矛盾比没有证据更糟。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evidence");
const j = JSON.parse(fs.readFileSync(path.join(OUT, "fold触发验证.json"), "utf8"));
const by = Object.fromEntries(j.results.map((r) => [r.step, r]));
const ok = (r, expectFolded) => (r ? r.folded === expectFolded : null);

const line = (step, expectText, expectFolded, okText, failText) => {
  const r = by[step];
  if (!r) return `| ${step} | 未运行 | — |`;
  const pass = r.folded === expectFolded;
  return `| ${step} | ${expectText} | ${pass ? okText : failText} |`;
};

const md = [
  "# fold 触发验证：自动路径 + 真实模型",
  "",
  `> 生成于 ${j.generatedAt}　模型：\`${j.model}\``,
  `> 模拟上下文窗口 ${j.window}，折叠阈值 ${j.threshold}（45% × 窗口）`,
  ">",
  "> 本文件由 `test/write-fold-evidence.mjs` 从同目录 `fold触发验证.json` 生成 —— **md 与 json 必然同源**。",
  "",
  "## 为什么单独测这个",
  "",
  "`real-fold.mjs` 只证明「给一个范围，compactRegion 能压」，没证明**自动路径会触发**。",
  "阈值判断、增长门（growth gate）、增量范围、溢出自救，全是引擎自己的逻辑；写错就会「永远不 fold」或「每步都 fold」。",
  "",
  "## 本次运行结果",
  "",
  "| 场景 | 期望 | 实际 |",
  "|---|---|---|",
  `| ① ${j.threshold} 以下 | 不 fold | ${ok(by["below-threshold"], false) ? "未 fold ✅" : "fold 了 ❌"} |`,
  `| ② 超过阈值 | fold + surface 收缩 | ${by["over-threshold"]?.folded ? `fold ✅（${by["over-threshold"].before} → ${by["over-threshold"].after} 节点，摘要 ${by["over-threshold"].summaryChars ?? 0} 字符）` : "未 fold ❌"} |`,
  `| ③ 立刻再调（增量 0） | growth gate 拦住 | ${ok(by["growth-gate"], false) ? "被拦住 ✅" : "又 fold 了 ❌"} |`,
  `| ④ 增量足够 | 再次 fold | ${ok(by["second-fold"], true) ? "再次 fold ✅" : "未 fold ❌"} |`,
  `| ⑤ 溢出自救 | 已压干净则 no-op | ${by.overflow?.folded ? "fold 了（可接受）" : "未 fold ✅"} |`,
  "",
  "## 判读方式",
  "",
  "**这不是一个确定性测试。** 它依赖真实模型（摘要由模型生成），同一天两次运行结果可能不同：",
  "本次与上一次相比，②④ 就出现过一次通过、一次未通过的差异。",
  "",
  "- 确定性部分（事务链、范围选择、checkpoint 写入）由 `test/real-fold.mjs` 覆盖，每次都必须全过。",
  "- 本测试证明的是「触发逻辑存在且能在真实模型下走通」，不是「每次都会 fold」。",
  "",
  "## 复跑",
  "",
  "```bash",
  "node test/real-fold-trigger.mjs   # 写 json",
  "node test/write-fold-evidence.mjs # 从 json 生成 md",
  "```",
];
fs.writeFileSync(path.join(OUT, "fold触发验证.md"), md.join("\n"), "utf8");
console.log("evidence/fold触发验证.md 已从 json 重新生成");
