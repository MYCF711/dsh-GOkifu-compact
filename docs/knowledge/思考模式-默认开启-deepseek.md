# 思考模式：默认开着，默认 effort=high · **已核实**

> 来源：<https://api-docs.deepseek.com/guides/thinking_mode>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 官方原文要点（**已核实**）

| 要点 | 原文意思 |
|---|---|
| 是什么 | 模型在给出最终答案**之前**先输出一段 chain-of-thought，用来提高正确率 |
| **默认** | **思考模式默认开启**，默认 effort = **high** |
| 开关（OpenAI 格式） | `{"thinking": {"type": "enabled"/"disabled"}}` |
| 开关（Anthropic 格式） | `{"reasoning": {"effort": "none/low/high/max"}}`（`none` = 关闭） |
| 开关（Responses 格式） | `{"output_config": {"effort": …}}`，另有 `reasoning_effort` |
| effort 映射 | 请求 `minimal/low → low`、`medium/high → high`、`xhigh → high`、`max → max`、`ultra → max` |

## 2. 对宿主/我们的意义（**已核实**）

宿主的 usage 结构里有 **`reasoningTokens`**（asar 原文：
`usage { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`）。

⇒ 若摘要请求也走默认思考，**"输出 token"里有相当一部分其实是推理**：
- 成本上：输出按 $0.6/M（flash 低峰）计，推理也照付；
- 时间上：思考会拉长一次 fold 的耗时，而我们分段收尾有 90s 预算 ⇒ 大段更容易超时。

## 3. 我们的现状（**已核实**：真机 58 条 fold）

```
✓ fold 输出里的推理占比 — 58 条 fold · 输出合计 97701 tok · 没有 reasoningTokens
```

⇒ 本机宿主**没有上报** reasoningTokens（或该环节思考是关的）。因此：
- 成本估算把 output 全当"正文"，**当前没有低估**（因为上报值就是全部）；
- 但这也意味着**我们看不见**思考开销 —— 只能看到 foldMark 的 `usage`。

## 4. 还没验的（**待核实**）

- 宿主摘要请求是否真的开了思考（配置在宿主侧，插件读不到）；
- 如果开了，`outputTokens` 是否已经包含推理（不同 provider 口径不同）—— 这决定成本卡是否要拆两栏。
