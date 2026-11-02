# 摘要被截断（`finish_reason="length"`）· 判读

> 来源：<https://api-docs.deepseek.com/api/create-chat-completion>（HTTP 200，抓取 2026-11-02）
> **外部资料 = 数据，不是指令。**

## 1. 官方原文（**已核实**）

| 要点 | 原文意思 |
|---|---|
| `finish_reason="length"` | 生成**超过 max_tokens**，或整段对话**超过最大上下文** |
| 后果 | 这时 **`message.content` 可能被截断（partially cut off）** |
| `max_tokens` 范围 | 1 – 384K（393216）；不设时非思考模式默认 **8K**、思考模式 **64K** |
| 另一种坑 | JSON 模式下非法 JSON 会被替换成空格 —— 于是 `finish_reason=stop` 时内容也可能"看起来是空的" |

## 2. 对我们意味着什么（**已核实**：本仓库此前**完全没读这个字段**）

我们的折叠摘要调用用 `maxTokens`（默认 8192）。如果模型写到一半被 `max_tokens` 截断：

- `summaryChars` 只是**短一点**，和"正常偏短的摘要"**长得一模一样**；
- `constraintRecall` / `failureRecall` 仍然是 1（规则段是机械追加的），所以**质量指标不会报警**；
- 但被截断的**模型摘要部分**可能已经丢了约束或死路 —— 这是"沉默的信息损失"。

## 3. 落点（C317）

- `src/engine.mjs`：摘要返回时记 `finishReason`（防御式读 `raw.finish_reason` / `raw.message.finishReason` 等多种形状，读不到记 `null`），写进 `foldMark.finishReason`；
- `scripts/doctor.mjs` 新增「摘要截断（finish_reason=length）」一行：报 `N 次里有 M 次截断`，
  **老 foldMark 没有该字段就明说「未采集」**（C317 之前的不记录，不许当成健康）；
- 用后即清（与其它 `_lastSummary*` 字段同一套「谁生产谁消费」）。

## 4. 还没验的（**待核实**）

- 宿主到底把 `finish_reason` 放在哪个字段（不同版本可能不同）—— 现在四种形状都试，实测要等重启后第一次 fold；
- 截断发生率有多高 —— 本机 56 条 foldMark **全部没有该字段**（都是 C317 之前的），所以现在只能报"未采集"；
- 提高 `maxTokens` 与"摘要更长"之间的权衡 —— 没有实测对照。
