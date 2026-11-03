# DeepSeek 错误码：400 / 401 / 402 / 422 / 429 / 500 / 503 · 已核实

> 来源：<https://api-docs.deepseek.com/quick_start/error_codes>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 原文（逐条）

| 码 | 官方说法 | 我们的处置 |
|---|---|---|
| **400** | Invalid Format | 请求体/参数结构不对；**先看错误正文里的上游名字** |
| 401 | Authentication Fails | key 失效/未配置 |
| 402 | **Insufficient Balance** | 余额不足 —— 这一条以前被我们一律当成"失败"记进统计，没区分 |
| 422 | Invalid Parameters | 参数非法（如 `max_tokens` 越界） |
| 429 | Rate Limit Reached | 限流，可重试 |
| 500 | Server Error | 上游故障 |
| 503 | Server Overloaded | 上游过载 |

## 2. 一条实战判据（**已核实**：2026-11-03 本机日志）

某次折叠的 `compaction/end` 错误是：

```
400: {"code":"invalid_request","message":"WPS 灵犀 Lingxi: WPS 灵犀上游返回 400：…"}
```

**错误正文里出现了第三方产品名**（"WPS 灵犀 Lingxi"）⇒ 这次请求**根本没到 DeepSeek**，
而是被路由到了另一个上游。所以：

> **判据：400 的第一个问题不是"我们的提示词写错了"，而是"这条请求发到哪儿去了"。**
> 看到陌生上游名字 ⇒ 查 provider/model 路由配置，别去改提示词。

## 3. 待核实

- 官方页没有给 `402` 的**恢复方式**（充值后是否需要重建 client），我们没测；
- 我们的折叠统计目前把所有 `compaction/end` 错误一视同仁 —— **没有按错误码分类**，
  所以"是余额问题还是格式问题"现在还得人眼看日志（记为候选）。

---

## 4. 我们的分类口径（C467 · **已核实**：`classifySummaryError` + 测试）

折叠失败不再笼统记成"失败"，而是分五类，每类对应**不同动作**（改代码≠改配置≠充值）：

| 类别 | 判据 | 该做什么 |
|---|---|---|
| `upstream-routing` | 正文含「上游返回 / upstream returned / 灵犀 / Lingxi」 | **查路由**（magpie 分组、换非 group 模型）——改提示词没用 |
| `balance` | `402` / Insufficient Balance / 余额 | 充值；期间走规则摘要 |
| `invalid-request` | `400` / invalid format / invalid_request | 先看正文里的上游名字，再查 `max_tokens` 上限 |
| `rate-limit` / `overload` / `timeout` | `429` / `5xx` / timeout | 放慢、稍后重试、调超时 |

**顺序很重要**：`isPermanentSummaryError()` 里也认 400，如果先判它，普通 400 会被吞成 `permanent`，
就再也分不出"被路由到别的上游"这种**最需要人干预**的情况（真机 2026-11-03T05:38 那次正是如此）。

失败分类现在**落在图上**（`lastFoldFailure = {at, kind, message, hint, seq}`），doctor 直接读，不用翻日志。
