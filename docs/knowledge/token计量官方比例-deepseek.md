# Token 计量的官方比例，与我们估算的偏差 · **已核实**

> 来源：<https://api-docs.deepseek.com/quick_start/token_usage>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 官方原文（**已核实**）

> Typically, a Chinese word, an English word, a number, or a symbol is counted as a token.
> **1 English character ≈ 0.3 token. 1 Chinese character ≈ 0.6 token.**
> 实际以模型返回的 usage 为准。

⇒ 英文 **3.33 字/token**，中文 **1.67 字/token**。

## 2. 我们的估算（**已核实**：`src/rooms/ledger.mjs`）

```js
const UNITS_PER_TOKEN = 4;
const CJK_UNITS_PER_CHAR = 4;   // 汉字 = 4 units = 1.0 token/字
// ASCII = 1 unit = 0.25 token/字
```

| 字符 | 官方 | 我们 | 偏差 |
|---|---|---|---|
| 英文/数字/半角符号 | 0.30 token | **0.25** | **低估 ~17%** |
| 汉字（含全角标点） | 0.60 token | **1.00** | **高估 ~67%** |

⇒ 我们的估算**对中文保守、对英文乐观**。后果：
- 热清单预算是"中文场景"下**偏安全**的（宁可贵，不超）；
- 但**英文/路径重的行**（`n315(user) → n316`、`scripts/xxx.mjs`）会被低估 —— 真实 token 比我们报的多。

## 3. 为什么不直接改成官方比例（**已核实**：实测）

把常量改成 `UNITS_PER_TOKEN=20 / ASCII=6 / CJK=12`（正好 = 0.3 与 0.6），全量测试 **17 条变红**：
`P-7`、`estimateTokens 钉死不变量`、`L4/L5 兜底档`、`C52`、`C57-2` 等 —— 它们钉的是**具体 token 数**与**档位阈值**。

也就是说：标定一改，**所有阈值都要重新推导**（bench 417、L0–L5 分档、预算下限…）。这不是一行改动，
已回滚，记为候选 **K-20**（需单独一轮：改比例 → 重跑 bench → 重新推导阈值 → 更新文档数字）。

## 4. 待核实

- 实际 usage 与我们估算的**逐条对照**（同一段文本：我们估 vs 宿主 usage）—— 本机没有这种配对日志；
- 中文场景下"高估 67%"是否真的导致清单被过度裁剪（over-budget 3482 次里有多少是这个原因）。
