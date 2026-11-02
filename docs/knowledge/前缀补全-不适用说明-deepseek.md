# Chat Prefix Completion（Beta）：为什么不适用于本插件 · **已核实**

> 来源：<https://api-docs.deepseek.com/guides/chat_prefix_completion>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 官方要点（**已核实**）

- 用法：在 `messages` 末尾放一条 **role = assistant** 的消息，并给该消息加 `"prefix": true`；
- 需要把 `base_url` 换成 **`https://api.deepseek.com/beta`** 才能启用；
- 常见搭配 `stop` 参数（例子里用 `stop: ["```"]`）来截断后续多余输出。

## 2. 为什么我们不用（**已核实**：对照实现）

本插件的摘要请求走**宿主的 `ctx.llm`**（`resolveModelInfo` + 折叠调用），
**不直接打 OpenAI/Anthropic HTTP 接口** ⇒ 我们**没有** `prefix` 参数可传，也没法把 base_url 换成 `/beta`。

⇒ 想让摘要"按固定格式开头"，只能靠 **prompt**（我们的 `facts + 模板`，见 C237 的 `instructionTokens`）
和**输出解析**，不能靠前缀补全这种"续写既定开头"的机制。

## 3. 顺带记住的一条（**已核实**）

前缀补全的**本质是把一段 assistant 前缀塞进上下文再续写** —— 在无状态 API 下，
这段前缀同样会被算进输入 token。**它不省 token，只是控制输出形式。**
