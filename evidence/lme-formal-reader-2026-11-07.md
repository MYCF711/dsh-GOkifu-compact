# K-27 v2 正式 50/50 真实 reader

> 状态：**FAIL** · 模型 `deepseek-v4.1-flash-1017` · 调用 100 次 · 错误 0 次

- full Acc：**1** · compact Acc：**0.88** · Δtask：**-0.12**
- 用量：input 14046 / output 13839 tokens；总延迟 160242 ms

## 门槛

- dataComplete: **true**
- overallCompact: **false**
- pairedDelta: **false**
- perType: **false**
- abstention: **false**
- noUnknownProcessIds: **true**

## 分类

| 类型 | full | compact | Δ |
|---|---|---|---|
| IE | 1 | 1 | 0 |
| MR | 1 | 0.9 | -0.1 |
| KU | 1 | 0.8 | -0.2 |
| TR | 1 | 0.8 | -0.2 |
| ABS | 1 | 0.9 | -0.1 |

## 未全对题

| 题 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|
| MR-04 | ✓ | ✗ | `3` | `UNKNOWN` |
| KU-01 | ✓ | ✗ | `later-ok` | `UNKNOWN` |
| KU-02 | ✓ | ✗ | `retain-20` | `20` |
| TR-01 | ✓ | ✗ | `之前` | `UNKNOWN` |
| TR-02 | ✓ | ✗ | `之后` | `UNKNOWN` |
| ABS-10 | ✓ | ✗ | `UNKNOWN` | `untested` |

## 失败归因

6 道 compact 失败、full 全对；逐条看 compact 上下文后，**答案都在上下文里**，不是压缩丢事实：

| 题 | compact 上下文里的答案 | 模型答 | 归因 |
|---|---|---|---|
| MR-04 | `distinct failed count=3` | `UNKNOWN` | 模型过度弃答 |
| KU-01 | `current=later-ok` | `UNKNOWN` | 模型过度弃答 |
| KU-02 | `current constraint=retain-20` | `20` | 截断/抽取只取数字 |
| TR-01 | `failed before seq=403` | `UNKNOWN` | 模型过度弃答 |
| TR-02 | `failure seq=411 precedes fold-2` | `UNKNOWN` | 模型过度弃答 |
| ABS-10 | `untested` / `right-censored` | `untested` | 应弃答却回答了状态（abstention 违规） |

因此本 FAIL 的首因是 **reader 提示词/抽取与弃答判据**，不是 compact 上下文缺失。正式结论保持 FAIL；不换题、不回调阈值。

## 预注册

- v2 只给 TR-01/02 增加中文等价别名；题面、答案、grader、阈值、上下文逐字未改。
- 判分是冻结夹具的机械判分；本报告不换题、不回调阈值。
