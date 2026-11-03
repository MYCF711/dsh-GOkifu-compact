# DeepSeek 官方更新日志（到 2026-10）· 已核实

> 来源：<https://api-docs.deepseek.com/updates>（HTTP 200，抓取 2026-11-03）
> 用途：**给我们的假设标上日期**。价目、模型名、能力边界都会变，引用时必须知道是哪一版。

## 1. 已核实：带日期的条目

| 日期 | 条目（原文首句） |
|---|---|
| **2026-10-17** | "Opening up the in-house search API" —— 自建搜索（Search & Fetch）开放 |
| （同期） | "**DeepSeek V4.1 Flash has been upgraded to DeepSeek-V4.1-Flash-1017.**" |
| 2026-09-10 | DeepSeek-V4 |
| 2026-08-21 | "DeepSeek-V4-Flash-Vision-Exp Release" —— 多模态视觉理解 |
| 2026-08-13 | "The GA release of DeepSeek-V4-Pro has been rolled out" |
| 2026-07-31 | "The official release of the DeepSeek-V4-Flash API is now in public" |
| 2026-04-24 | "The DeepSeek API now supports V4-Pro and V4-Flash" |

## 2. 对我们最要紧的一句（**已核实**，逐字）

> "The API calling method and **pricing remain unchanged** — simply use `deepseek-flash` to access the latest model."

⇒ 这解释了为什么我们 2026-11-03 复核价目表时**数字与 2026-11-02 完全一致**（见
[`成本模型-deepseek价格.md`](./成本模型-deepseek价格.md)）：V4.1-Flash-1017 这次升级**没有调价**。
也印证了「模型名 `deepseek-flash` 是稳定别名，背后会换实现」——我们代码里按名字前缀认模型（`priceForModel`）是安全的。

## 3. 待核实

- 本页只抓了**标题与首句**，每条下面的详细变更（benchmark、能力矩阵）没读；
- 2026-10-17 的 Search & Fetch 与我们已有的 [`Search与Fetch-工具输出与上下文.md`](./Search%E4%B8%8E%20Fetch-%E5%B7%A5%E5%85%B7%E8%BE%93%E5%87%BA%E4%B8%8E%E4%B8%8A%E4%B8%8B%E6%96%87.md) 是否同一件事，没有逐字比对；
- 更早的日期（2026-04 之前）该页没列出。
