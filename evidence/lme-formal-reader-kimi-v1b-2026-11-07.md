# K-27 v2 正式 50/50 真实 reader

> 状态：**FAIL** · 模型 `group/kimi-k3.1-pro` · 调用 100 次 · 错误 0 次

- full Acc：**0.96** · compact Acc：**0.88** · Δtask：**-0.08**
- 用量：input 23886 / output 22990 tokens；总延迟 816453 ms

## 门槛

- dataComplete: **true**
- overallCompact: **false**
- pairedDelta: **false**
- perType: **false**
- abstention: **true**
- noUnknownProcessIds: **true**

## 分类

| 类型 | full | compact | Δ |
|---|---|---|---|
| IE | 1 | 1 | 0 |
| MR | 1 | 0.8 | -0.2 |
| KU | 0.8 | 0.7 | -0.1 |
| TR | 1 | 0.9 | -0.1 |
| ABS | 1 | 1 | 0 |

## 未全对题

| 题 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|
| MR-02 | ✓ | ✗ | `e-mr02-a,e-mr02-c` | `UNKNOWN` |
| MR-04 | ✓ | ✗ | `3` | `UNKNOWN` |
| KU-02 | ✗ | ✗ | `20` | `20` |
| KU-08 | ✓ | ✗ | `candidate` | `` |
| KU-10 | ✗ | ✗ | `UNKNOWN` | `UNKNOWN` |
| TR-01 | ✓ | ✗ | `之前` | `UNKNOWN` |

## 预注册

- v2 只给 TR-01/02 增加中文等价别名；题面、答案、grader、阈值、上下文逐字未改。
- 判分是冻结夹具的机械判分；本报告不换题、不回调阈值。
