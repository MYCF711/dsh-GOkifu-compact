# `/chat/completions` 是无状态的：每一轮都要重发全部历史 · **已核实**

> 来源：<https://api-docs.deepseek.com/guides/multi_round_chat>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 官方原文（**已核实**）

> The DeepSeek `/chat/completions` API is a **"stateless"** API, meaning the server does not record
> the context of the user's requests. Therefore, the user must concatenate all previous conversation
> history and pass it to the chat API **with each request**.

⇒ 服务端**不保存**上下文；客户端每轮都要把完整历史拼进去。

## 2. 对本插件的三条推论（**已核实**：逻辑自洽，实现已对照）

1. **压缩的收益是"每轮复利"，不是一次性。**
   折掉 N token 的历史，**之后每一次请求**都少发 N token（直到历史再次增长回来）。
   所以"一次折叠花了 $0.03"要和"之后几十次请求都省"放在一起看 —— 只看单次成本会严重低估收益。
2. **注入必须"替换"而不是"追加"。** 每轮追加一份清单 = 历史**永久**变大，
   在无状态 API 下这是**每轮都付费**的。本插件的 `hotLedgerReplace`（默认开）就是干这个的。
3. **前缀缓存是唯一的反向杠杆。** 历史虽要重发，但重复前缀命中缓存后只按 $0.003/M 计
   （见 [`前缀缓存单元-持久化规则-deepseek.md`](./前缀缓存单元-持久化规则-deepseek.md)）——
   所以"重发"不一定等于"全价"。

## 3. 我们说到什么程度（**待核实**）

- 面板与 doctor 目前把 fold 成本记成**单次花费**，没有把"之后每轮省多少"折算进去（`C356` 起在 doctor 加了一句口径说明，但没有量化）；
- 量化需要"这次 fold 之后又发生了几次请求"——宿主没有直接给出这个数，只能从 seq 增长粗估。

---

## 2026-11-06 复核（同一结论 · **已核实**）

来源：<https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat>（HTTP 200）逐字：

> "DeepSeek /chat/completions API 是一个**"无状态"** API，即服务端不记录用户请求的上下文，
>  用户在每次请求时，**需将之前所有对话历史拼接好后**，传递给对话 API。"

### 对我们的意义（把三条连起来看）

1. **每一步都重发全部历史** ⇒ 账单 ≈ 步数 × 每步上下文；
2. 所以「**前缀缓存有没有被打断**」比「折叠阈值设 45% 还是 70%」重要得多
   （与 `fold-economics` 的判读一致：阈值高低是二阶问题）；
3. 折叠省的是**之后每一步**的重发量 —— 这也解释了为什么回本点中位只有 **6 次请求**。
