# Tool Calls：`strict` 模式与「自定义 client tool 会被 422」· 已核实

> 来源：<https://api-docs.deepseek.com/guides/tool_calls>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

| 项 | 状态 |
|---|---|
| `tool_call_id` | 结果必须带**对应调用的 id** 回填（`role: "tool"`, `tool_call_id`） |
| **`strict` 模式（Beta）** | 让模型**严格遵守** Function 的 JSON schema 输出工具参数 |
| **自定义 client tool（`type: "custom"`）** | 返回 **422**（不支持这种形态） |
| 中途插入工具调用 | Chat 接口**不为插入**设计；官方指向 Anthropic / Responses 接口 |

## 2. 对本插件（**已核实**：对照实现）

1. 我们**不直接构造工具调用**（走宿主），所以 `strict` / `tool_call_id` 由宿主负责；
2. 但**失败边的可观测性依赖 `tool_call_id` 的可靠性**：如果宿主把结果回填错 id，我们的 action/evidence 归属就会错；
3. `422`（自定义 client tool）与我们 C349 的永久错误判定一致 —— 422 已归入**永久**（不重试）。

## 3. 待核实

- 宿主对工具调用是否启用 `strict`（若启用，参数形状更稳定，对"失败边去重"有利）；
- 宿主是否用过 `type: "custom"`（若用过，会稳定吃 422）。
