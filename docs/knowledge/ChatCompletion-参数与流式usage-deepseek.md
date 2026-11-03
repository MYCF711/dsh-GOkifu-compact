# Chat Completion 的参数细则：流式 usage 与已废弃参数 · 已核实

> 来源：<https://api-docs.deepseek.com/api/create-chat-completion>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

### `stream_options.include_usage`

- 类型：`object | null`，默认 `null`；**必须与 `stream: true` 一起用**——
  只给 `stream_options` 而不把 `stream` 设为 `true`，API 直接返回 **400**。
- `include_usage: true` ⇒ 流里**每个 chunk 都带 `usage` 字段**，除最后一个之外值都是 `null`；
- 省略或 `false` ⇒ 除最后一个 chunk 外都没有 `usage`。

⇒ **无论哪种设置，最后一个 chunk 一定有 `usage`**（这也是"用量只在收尾时才准"的原因）。

### 已废弃（传了也无效）

| 参数 | 状态 |
|---|---|
| `frequency_penalty` | **deprecated，不再支持**，传了不生效 |
| `presence_penalty` | **deprecated，不再支持**，传了不生效 |

### 其它

- `logprobs` / `top_logprobs`：支持，返回每个输出 token 的对数概率；
- 流式响应用 **SSE**，以 `data: [DONE]` 结束。

## 2. 对本插件（**已核实**：对照实现）

1. 我们的 `usage` 来自宿主 `assembler.usage`（它聚合流里的 usage 字段）——
   按官方语义，**最后一块才有真值**，这与我们"一次 fold 一条 usage"的做法一致；
2. `frequency_penalty` / `presence_penalty` **是死参数**：如果宿主或配置里还在传，不会有任何效果
   —— 这是"未知/废弃参数被静默忽略"的又一例（同 C417 的官方说法）。

## 3. 待核实

- 宿主是否设置 `include_usage: true`（若不设，中间 chunk 无 usage，但我们只取最终值，影响不大）；
- 宿主是否仍在传已废弃的两个 penalty 参数（无效果，但值得清掉以免误导）。
