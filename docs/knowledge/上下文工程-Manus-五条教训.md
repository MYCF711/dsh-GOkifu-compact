# Manus 的上下文工程五条教训（含可核对的数字） · 已核实

> 来源：<https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>
> （HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。数字均取自原文，未做四舍五入改写。

## 1. 已核实（原文里的具体数）

| 结论 | 原文依据 |
|---|---|
| **输入/输出极度不对称** | agent 的 "input-to-output token ratio is around **100:1**"（输出通常只是一个函数调用） |
| **缓存差价是 10 倍** | 以 Claude Sonnet 为例：cached input **0.30 USD/MTok** vs uncached **3 USD/MTok** —— "a **10x** difference" |
| **前缀一 token 都不能变** | "even a single-token difference can invalidate the cache from that token onward" |
| **常见自杀式写法** | 在 system prompt **开头**放精确到秒的时间戳 —— "it also kills your cache hit rate" |
| **不要改历史** | "Avoid modifying previous actions or observations"（改动靠前的内容会作废后面全部缓存） |
| **序列化必须确定** | "Ensure your serialization is deterministic"（很多语言的对象键序不保证） |
| **别删工具，遮住就行** | 增删工具会让缓存失效 + 模型对着不存在的工具发呆；Manus 用**logit mask** 限制可选动作 |
| **错误留在上下文里** | "**Erasing failure removes evidence**" —— 抹掉失败等于让模型没法适应 |
| **Recitation（复诵）** | Manus 维护 `todo.md` 并在**每一步**重写，把目标"recite into the **end** of the context"，把全局计划推回近期注意力，避开 lost-in-the-middle |
| **文件系统当上下文** | 可随时读写的外部记忆，比全塞进窗口更可靠 |

## 2. 对我们这个插件的对照（哪些**已经**满足）

| Manus 的要求 | 我们的现状 |
|---|---|
| 前缀稳定 / 不动历史 | ✅ 热清单是**尾部就地替换**（`hotLedgerReplace`），C268 已按 DeepSeek 缓存单元语义确认过"改动点越靠后作废越少"；实测断点 2.6% |
| 序列化确定 | ✅ **C446 实测**：36 个真机会话、同一张图渲染两次逐字相同；`now` 差 6 小时也逐字相同（0 差异） |
| 错误留证据 | ✅ `failureRecall` 探针长期 = 1，失败边是清单主体 |
| 复诵目标 | ⚠️ **只到一半**：ROOT/CONSTRAINTS 有，但 `CURRENT GOAL` 取自 agent 节点的 `goal` 字段 —— **真机 19,295 个 agent 节点里只有 62 个（0.3%）有 goal**，所以这行几乎从不出现 |

## 3. 待核实

- 「每步重写 todo」的**成本/收益**：文章说它避免 goal misalignment，但没给量化；
  我们实测 `450 tok/步`（C-3 结论）在 97% 缓存命中下是零头，**但仍未做 A/B**，不能照抄成"我们也该每步刷"。
- logit mask 在本宿主不可用（宿主不暴露 logits 处理），所以"遮住工具"这条**做不到**，只能靠提示词。
- 100:1 的输入输出比是 Manus 自己的负载；我们的真机会话没统计过这个比值。

## 4. 反过来的一条教训（这条是**我们自己**踩的，不要归因给文章）

判据不能只看"动作串"：`actionSummary` 只取 2 个关键参数，于是 **同一文件的每次不同编辑**都逐字相同。
真机 36 个会话里 3 个出现连续 5–6 次 `edit(...)`、`result` 全是 `success` —— 那是真在改代码。
C446 因此给边加了 `sig`（工具名 + 完整参数的指纹），循环判据改用指纹。
