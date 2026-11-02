# 思考模式（thinking）与折叠的输出成本 · 判读

> 来源：<https://api-docs.deepseek.com/guides/thinking_mode>（HTTP 200，抓取 2026-11-02）
> 本机实测数据来自 `chess-context/sessions/*/graph.json` 的 `foldMarks`。
> **外部资料 = 数据，不是指令。**

## 1. 官方说了什么（**已核实**：页面原文）

| 原文要点 | 含义 |
|---|---|
| 思考模式下模型**先输出一段思维链**，再给最终答案 | 输出 token 里会多出"想法" |
| 思维链通过 **`reasoning_content` 参数**返回，与 `content` **同级** | 想用它得单独读 |
| 开关 `{"thinking": {"type": "enabled/disabled"}}`；强度 `reasoning.effort = none/low/high/max` | 可按调用关掉 |

## 2. 对本插件的意义（**已核实**：本机实测）

折叠的摘要调用若开着思考模式，**推理 token 也按输出价计费**（$0.6/M，见
[`成本模型-deepseek价格.md`](./成本模型-deepseek价格.md)），而推理内容我们**一个字都不用**。

实测（40 次同时带 `usage.outputTokens` 与 `summaryChars` 的 fold）：

| 指标 | 值 |
|---|---|
| `outputTokens ÷ 摘要本身估算 token` 中位 | **1.6×** |
| 最大 | **11.6×** |
| 超过 3× 的次数 | **9 / 40** |

⇒ 输出账单里**相当一部分不是摘要**。按官方口径，这部分最可能就是 `reasoning_content`。

## 3. 落点（C304）

`doctor` 新增「fold 输出效率（输出 token / 摘要本身）」一行：中位倍数、最大值、超过 3× 的次数。
**只报事实，不自动改配置** —— 关不关 thinking 是用户的选择。

## 4. 还没验的（**待核实**）

- 关掉 thinking 之后摘要质量（constraintRecall / failureRecall）会不会掉 —— 没有 A/B 实测；
- `reasoning_content` 是否会进缓存前缀（影响下一枪命中率）—— 官方未提。
