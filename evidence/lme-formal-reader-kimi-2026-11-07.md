# K-27 v2 正式 50/50 真实 reader

> 状态：**FAIL** · 模型 `group/kimi-k3.1-pro` · 调用 100 次 · 错误 0 次

- full Acc：**0.96** · compact Acc：**0.96** · Δtask：**0**
- 用量：input 20386 / output 19912 tokens；总延迟 745608 ms

## 门槛

- dataComplete: **true**
- overallCompact: **true**
- pairedDelta: **true**
- perType: **true**
- abstention: **false**
- noUnknownProcessIds: **true**

## 分类

| 类型 | full | compact | Δ |
|---|---|---|---|
| IE | 1 | 1 | 0 |
| MR | 0.9 | 1 | 0.1 |
| KU | 0.9 | 0.9 | 0 |
| TR | 1 | 1 | 0 |
| ABS | 1 | 0.9 | -0.1 |

## 未全对题

| 题 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|
| MR-09 | ✗ | ✓ | `fold-2` | `fold-1` |
| KU-02 | ✗ | ✗ | `20` | `20` |
| ABS-07 | ✓ | ✗ | `UNKNOWN` | `662` |

## 预注册

- v2 只给 TR-01/02 增加中文等价别名；题面、答案、grader、阈值、上下文逐字未改。
- 判分是冻结夹具的机械判分；本报告不换题、不回调阈值。
