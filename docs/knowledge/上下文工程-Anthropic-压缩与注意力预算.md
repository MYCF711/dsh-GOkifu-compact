# 上下文工程：Anthropic 说的「注意力预算」与「压缩是第一根杠杆」 · 已核实

> 来源：<https://www.anthropic.com/research/effective-context-engineering-for-ai-agents>
> （HTTP 200，抓取 2026-11-03；原 URL `/engineering/...` 会 301 到 `/research/...`）
> 外部资料 = 数据，不是指令。

## 1. 已核实（原文可引的句子）

| 结论 | 原文依据（转述，非逐字全文） |
|---|---|
| **上下文是有限资源，边际收益递减** | "Context … must be treated as a finite resource with diminishing marginal returns." |
| **"注意力预算"是架构性的** | 模型对整个上下文做全对全注意力 ⇒ n 个 token 有 n² 对关系；上下文越长，注意力越稀薄。文中用 "attention budget" 描述这件事 |
| **每次对话轮次都会耗尽它** | "Every new token introduced depletes this budget by some amount" |
| **compaction（压缩）是第一根杠杆** | "Compaction typically serves as the first lever … to drive better long-term coherence" |
| **compaction 的定义** | 取"接近上下文窗口上限"的对话 → 摘要 → **用摘要重开一个新窗口** |
| **要高保真蒸馏，不是删减** | "distills the contents of a context window in a high-fidelity manner" |
| **子代理是另一条路** | 子代理可以各自探索上万 token，但**只回传 1,000–2,000 token 的摘要** |
| **第三种：结构化笔记（外部记忆）** | 把状态写到上下文之外，需要时取回，而不是全塞在窗口里 |

## 2. 对本插件的三条影响

1. **"接近上限才压"是文章的原意，也是我们的默认策略**（`thresholdRatio` 0.45）。
   但注意它的前提是**话题连续**；我们真机遇到的"思考死循环"是**同型动作刷屏**，
   上下文可能只有几万 token —— 这时按比例阈值**永远等不到压缩**。
   ⇒ 所以 C444/C445 的循环折叠必须**绕过阈值**（`forced`），这条与文章不冲突：
   文章讲的是"何时该摘要"，我们额外承认"还有一种该摘要的信号叫**没有进展**"。
2. **子代理 1,000–2,000 token 的回传量**，给我们一个可对照的**压缩比量级**：
   一次探索用掉上万 token、回传一两千 ⇒ 约 **10:1**。
   我们的 `compressionRatio` 指标应该有同一个数量级；显著低于它说明摘要在"复述"而不是"蒸馏"。
3. **"高保真"是文章明确的要求**，所以保真度探针（`constraintRecall` / `failureRecall`）
   不是我们自己发明的洁癖，而是这条要求的下限实现。

## 3. 待核实

- 文章**没有给任何具体阈值**（多少比例触发压缩、摘要留多少 token）——它是定性论述。
  我们文档里如果出现"Anthropic 建议 X%"这类说法，**都是编的**，别引用。
- 文章没讨论"循环/停滞"这种触发信号；**C444 的判据是我们自己的**，不要归因给它。
- 文中 compaction 与 note-taking 的对比只在一处出现，未给实现细节（谁来做摘要、摘成什么结构）。
