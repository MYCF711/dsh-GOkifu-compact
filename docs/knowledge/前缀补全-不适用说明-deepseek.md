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

## 4. 同类能力：FIM Completion（Beta）也不适用（**已核实**，C405）

> <https://api-docs.deepseek.com/guides/fim_completion>（HTTP 200）

官方：FIM（Fill In the Middle）给 **prefix + suffix**，让模型补中间；常用于**内容/代码补全**；
**max tokens 只有 4K**；需要 `base_url = https://api.deepseek.com/beta`；价目页标注**仅非思考模式**。

对本插件同样**不适用**：我们不写补全，折叠走完整生成。
值得记的只有两点：① 4K 上限说明它服务的是"补一小段"；② beta 端点与我们无关（同上一条）。

### 待核实（C436 补齐）

- 本文是**外部资料判读**，本机**未做对照实测** —— 其中的数字与结论属于来源的口径，能否在本机复现（或对我们的场景是否成立）**尚未验证**。
