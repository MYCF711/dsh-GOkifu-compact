# Search / Fetch API：给 agent 的"实时网页"，也是上下文膨胀的来源 · 已核实（部分）

> 来源：<https://api-docs.deepseek.com/guides/search>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

- **Search API**：按查询找网页，返回**结构化结果**，由 DeepSeek 自建搜索引擎提供；
- **Fetch API**：取回网页内容。

两者面向"agent 与 RAG 应用访问实时网页"。

## 2. 对本插件（**部分已核实**）

1. 我们**不直接调用**这两个接口 —— 折叠/注入走宿主 `ctx.llm` 与宿主工具，插件不发起搜索；
2. 但它们产出的东西**会进入上下文**：一次 fetch 返回的正文可能几万 token，是**工具结果爆炸**的主要来源之一；
3. 所以我们的策略不变、但责任更清楚：**折叠 + 宿主的 `tool-result-pruner`** 才是把这类内容压下去的手段
   （`verify-install` 一直在确认 preset 里**保留** `tool-result-pruner`，就是为这条）。
4. A29（图片盲区）同理：搜索/抓取的**图片**也不进我们的文本估算。

## 3. 待核实

- 宿主是否给 agent 挂了 search/fetch 工具；若挂了，`tool/result` 里这类内容占比多少（可用 `session-scan` 按类型统计）。
- Fetch 回来的正文是否被宿主自动截断（若截断，折叠的收益会被高估）。

## 2.5 端点与返回形式（**已核实**，C419）

| 项 | 值 |
|---|---|
| Search | `POST https://api.deepseek.com/v1/tools/search` |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` |
| 鉴权 | 同 DeepSeek API 的 **Bearer** |
| 返回 | 都是**原始 JSON**；**Fetch 把网页正文转成 Markdown** |

⇒ 两个直接含义：① Fetch 的结果**是文本（Markdown）**，会进我们的 token 估算（不像图片那样是盲区）；
'
'② 但一个长页面可能几万 token —— 它是**工具结果膨胀**的典型来源，靠折叠与宿主的 `tool-result-pruner` 压。
