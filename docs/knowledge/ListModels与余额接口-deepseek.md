# `GET /models` 与余额接口 · 已核实（接口面）

> 来源：<https://api-docs.deepseek.com/api/list-models>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

| 接口 | 作用 |
|---|---|
| `GET /models` | 列出**当前可用**的模型，并给出每个模型的元信息（如 id / 归属） |
| Get User Balance | 查询账户余额（同属官方 API 参考） |

同类还有 Files（Upload / List / Retrieve / Delete）、Search / Fetch 两组接口。

## 2. 对本插件的含义（**已核实**：对照实现）

1. 面板的 `models` action 列的是**宿主里的模型目录**（`ctx.llm` 提供），不是 `GET /models` —— 两件事；
   `GET /models` 需要**直连 DeepSeek**，而我们走宿主，**不直连**；
2. 因此"面板为什么没显示某个模型"的答案在**宿主模型表**，不在官方 models 列表；
3. 余额同理：插件**读不到**余额（除非宿主暴露），所以"还剩多少钱"这类信息我们**不能**在面板上给。

## 3. 待核实

- 宿主是否为面板暴露了余额/额度信息（`ctx.llm` 或其它服务）——未查到；
- `GET /models` 返回的 id 是否与价目表里的 `deepseek-flash` / `deepseek-v4-pro` 完全一致（未直连验证）。
