# Responses API：**无服务端状态**，且超窗直接 **400** · 已核实

> 来源：<https://api-docs.deepseek.com/guides/responses_api>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

| 参数/能力 | 状态 |
|---|---|
| base_url | `https://api.deepseek.com`（Responses 格式） |
| `previous_response_id` | **Not supported（stateless API）** |
| `conversation` | **Not supported（stateless API）** |
| `store` | **Not supported**（响应永远带 `store: false`） |
| `truncation` | **Not supported** —— **超出上下文窗口的请求直接返回 400** |
| `parallel_tool_calls` / `max_tool_calls` | Ignored（并行工具调用始终开启） |
| `background` / `metadata` / `include` / `prompt` / `service_tier` | Not supported |
| `instructions` | 会被插到**第一条 system 消息**里 |

## 2. 对本插件的两条影响（**已核实**）

1. **不存在"服务端帮我们截断"这件事。** 超窗就是 **400**（不是静默截断、不是部分完成）。
   ⇒ 客户端必须自己把上下文压进窗口，**我们的折叠不是优化，是必需**。
2. **这种 400 必须被当成"可恢复"**：正确的反应是**再折一段**，而不是"永久失败 + 退避到上限"。
   C382 起 `isPermanentSummaryError()` 会先排除 `context length / context window / too long / too many tokens` 这类文案，
   保留真正的永久错误（普通 400 / 401 / 402 / 422）。

## 3. 待核实

- 宿主实际走的是哪种格式（Chat / Responses / Anthropic）——三种格式的超窗报错文案我们不都见过；
- 超窗 400 时宿主的 `finishReason` 会不会也给 `max-tokens`（若给，我们的截断仪器会重复计数）。
