# JSON Output 的「空白内容」陷阱 · 已核实

> 来源：<https://api-docs.deepseek.com/guides/json_mode>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 官方原文要点（**已核实**）

启用 JSON Output 需要：`response_format = {"type": "json_object"}`、**prompt 里出现 "json" 字样并给格式示例**、`max_tokens` 设合理（防截断）。

然后是最要命的一条：

> 若模型输出无法被识别为 JSON，**API 会把非 JSON 内容替换成空格（U+0020）**。
> 结果：返回内容**可能只有空格**（看起来是空的），**即使 `finish_reason` 是 `stop`**。
> 官方建议：改 prompt，并且**在代码里处理空白内容**（例如重试）。

## 2. 对我们意味着什么（**已核实**：对照实现）

"成功但内容为空"是最危险的形态：**状态码 200、finish_reason=stop、内容是空白**。
如果我们把它当成功，就会**折掉历史、换回一段空白** ⇒ 数据丢失。

**好消息**：`src/engine.mjs` 已有守卫 —— 摘要产出后检查

```js
if (!summary.some((block) => String(block.text ?? "").trim().length > 0)) {
  throw new Error("chess-context: summarization produced no text summary content");
}
```

`.trim()` 让**只有空格**也算"没有内容" ⇒ 抛错 ⇒ 走 fold 失败路径（restore + 失败计数），**不会静默丢数据**。

## 3. 还没验的（**待核实**）

- 宿主是否启用了 JSON Output（若启用，摘要请求也可能命中这个陷阱）；
- `finish_reason=stop` + 空内容 在我们的失败计数里算哪一类（目前算普通失败，退避按事件+时间闸）。
