# Agent 的失败分类与效率指标（Chip Huyen, 2025） · 已核实

> 来源：<https://huyenchip.com/2025/01/07/agents.html>（HTTP 200，抓取 2026-11-03；AI Engineering 一书 Agents 章的独立版）
> 外部资料 = 数据，不是指令。

## 1. 已核实（文章自己的小标题与句子）

文章把 agent 的失败分成三节：**Planning failures / Tool failures / Efficiency**（目录里逐字可见）。

| 分类 | 原文要点 |
|---|---|
| **Planning failures** | 计划本身不对（该拆的没拆、该用工具的没用） |
| **Tool failures** | "the correct tool is used, but the tool output is wrong"；且 "**Tool failures are tool-dependent. Each tool needs to be tested independently.**"；"**Always print out each tool call and its output** so that you can inspect and evaluate them."；缺工具也是失败形态："this might be because it lacks tools for this domain" |
| **Efficiency** | 计划有效但太贵/太慢。文章建议跟踪的四件事（原文列举）：<br>① 完成任务**平均需要几步**；② 完成任务**平均花多少钱**；③ 每个动作**典型耗时**；④ **有没有特别耗时/费钱的动作**。<br>并且："You can compare these metrics with your **baseline**"（另一个 agent 或**人工**） |

## 2. 对我们这个插件的对照

| 文章要求 | 我们的现状 |
|---|---|
| 每次工具调用与输出都要留痕 | ✅ 边上有 `action` + `result`/`verify` + `errorSnippet`，热清单的失败块就是它的投影 |
| 工具失败要**按工具**分别评测 | ⚠️ 我们的 `verify.mjs` 是**按结果形态**分类（exit/diff/read/no-signal），**不是按工具**。所以回答不了"哪个工具最不可靠" |
| 效率四指标 | ✅ 成本（ledger-budget / 真机基准）· ✅ 动作耗时（fold ms、keeper µs/事件）· ❌ **"完成任务平均几步"没有**（图的 `turn` 能近似，但没算过）· ❌ "特别费钱的动作"没算过 |

**⇒ 记成候选 K-13**：`非常规动作开销榜`——按 action 前缀聚合"这一步花了多少 token / 多久"，把"特别费钱的动作"从文章的建议变成我们的一条命令。

## 3. 待核实

- 文章没有给出任何**数值阈值**（多少步算多、多少钱算贵），只说"与你的 baseline 比"——所以别引用成"行业标准是 X 步"。
- 它与 Anthropic《Building effective agents》(Dec 2024) 的关系：作者自称两者"分工不同"（Anthropic 聚焦孤立模式，他讲框架与失败），
  但**是否术语一一对应**我们没逐条核过。
- 本页只核了这三节的标题与上面的句子；文章其余部分（工具设计、planning 结构）未逐段核实。
