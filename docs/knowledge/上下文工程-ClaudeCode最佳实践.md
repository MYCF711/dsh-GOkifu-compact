# Claude Code 最佳实践里的「压缩与成本」 · 已核实

> 来源：<https://www.anthropic.com/engineering/claude-code-best-practices>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实（原文逐句）

| 结论 | 原文 |
|---|---|
| 自动压缩是**默认行为** | "your conversation is **compacted automatically before the context window fills**" |
| 压缩点**靠近窗口顶部**，而不是半腰 | "With a **1M-token window** on most current models and **compaction near the top of it**, you'll rarely run out of context." |
| **每轮都重发整段对话** ⇒ 无关历史一直在付费 | "**Every request sends the whole conversation**, so a session that's collected three unrelated tasks **re-reads all three on every turn** of the fourth." |
| 缓存热时打折、过期后全价 | "That's **discounted while the cache is warm** and **full price once it expires**." |
| 官方用 `/usage` 找成本来源 | 在付费档上按 skill / subagent / plugin / MCP 拆分，并"**flags patterns like long context or frequent cache misses once one of them passes 10% of your usage**" |
| 对策之一是**换任务就 `/clear`** | "`/clear` between unrelated tasks. It costs nothing, and it means the next task doesn't keep paying for the previous one's history." |

## 2. 对我们的对照

- **"每轮重发整段对话"** —— 与我们 A1 的结论完全一致（成本大头是前缀有没有失配，不是注入多少）。
  DeepSeek 也是无状态 API，`inputTokens` 只是未命中部分（C361/C411 已核实）。
- **"压缩点靠近窗口顶部"** —— 我们默认 `thresholdRatio = 0.45`（半腰偏下），**比它激进**。
  但两边的缓存经济学不同（我们实测单次 fold ≈ $0.032、缓存命中 94%），**不能直接照抄**；
  这一条记为待办：用我们自己的数据算"45% vs 70%"的总成本，再决定要不要动默认值。
- **`/clear`** —— 我们没有等价物。但可以**发现**它该被用时：用户换了件事之后，
  旧任务的历史每轮都在付费。C461 起在棋谱里给这种消息打 `pivot` 印记，doctor 会报「可清理的会话」。

## 3. 待核实

- 原文没写"compaction near the top"到底是多少百分比（只给了 1M 窗口这个背景），**不能引用成"80%"之类的数**；
- `/usage` 的 10% 阈值是**他们的产品功能**，不是通用建议；
- 该页是 Claude Code 产品文档，**不是模型层规范** —— 我们的阈值/缓存行为以 DeepSeek 官方文档为准。
