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

---

## 2026-11-06 复核：Token 换算比例（**已核实**，HTTP 200）

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/token_usage>。逐字：

> 1 个英文字符 ≈ **0.3** 个 token。1 个中文字符 ≈ **0.6** 个 token。

「每一次实际处理 token 数量以模型返回为准，可以从 usage 中查看」。

### 对我们的影响（已在 C582 落地）

以前一律用 `字符数 / 4`（≈0.25/字符）估算 —— 对**以中文为主**的 prompt **低估约 2.4 倍**：

| 输入 | 旧估算 | 新估算（按语言） | 真机实测 |
|---|---|---|---|
| 12,000 个中文字 | 3,000 | **7,200** | 6,751 ✓ |
| 12,000 个英文字符 | 3,000 | 3,600 | — |

后果：`foldBudgetFor` 给出的输出预算偏小 ⇒ 摘要容易被截断（与 C576 那个"正文被推理挤掉"是叠加的）。

---

## 2026-11-06 复核：更新日志（**已核实**，HTTP 200）

来源：<https://api-docs.deepseek.com/zh-cn/updates>

- 2026-10-17：**DeepSeek-V4.1-Flash-1017** 上线，「API 调用方式与价格保持不变，仍使用 `deepseek-flash` 即可」；
  基准普遍提升（HLE 42.6 / Terminal-Bench 4.0 42.3 / DeepSWE v1.1 77.0）。
- 同期开放**自研搜索 API**（Search / Fetch 独立计费）。

**对我们**：模型名不用改（我们解析到的就是 `deepseek-v4.1-flash1017`），
所以这条只作为"当前模型确实是最新版本"的凭据记着。
