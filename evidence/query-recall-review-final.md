# Q1 独立复核与最终处置（2026-11-16）

## 结论

**运行时无遗留阻断；Stage B 真实配对裁决为 `NEGATIVE_SIGNAL`，`adoption = NOT_ADOPTED`。**

`queryRecall` 保持默认 `false`。不把 Stage A 的性能与合成命中率解释为真实任务收益，也不为追求正向结果修改冻结 grader。

## 审核人与范围

- 独立 reviewer：`q1-review`（只读复核 + 独立复跑；执行模型 `group/deepseek-v4.1-flash-1017`）。
- 初审：2 BLOCKER / 5 MAJOR / 7 MINOR。
- 复审：B-1/B-2、M-1/M-2/M-3/M-5 全 FIXED；M-4 的 impl/evidence 已 FIXED，指出 perf 哈希与决策文本仍需收口。
- 最终 Lead 复验：perf sha 强制比对、派生 p95 取 max、预注册 `decisionCap/scorableTasks` 与 runner 互校。

## 初审问题与关闭证据

| 项 | 问题 | 最终证据 |
|---|---|---|
| B-1 | UI `true` 没进 `this.chess` | `RESOLVE_ORDER` 补键；engine-harness **129/129**，含开启后真召回段 |
| B-2 | 长 action 吞失败原因 | 状态后缀预留空间；真实长 action 失败原因 **9/9 保留**；Stage A SA-15 |
| M-1 | harness 注入冒充用户 query | 复用 keeper `HUMAN_SOURCES`；9 类注入源测试全跳过；hot-inject **43/43** |
| M-2 | 同 query 图增长每步 replace | queryDigest 与 recallText digest 分离；同 query + 新边 + 1 事件回到原限流 |
| M-3 | 符号/多锚点 p95 超 25ms | lazy text + top-K；最终真实图 340 次、命中 240，派生 p95 **9.996ms** |
| M-4 | Stage B 未绑定实现/证据/perf | 7 个冻结输入 + perf sha；篡改 impl/evidence/perf 均拒绝；p95 取 render/derived 最大值 |
| M-5 | 合成题可能误判 ADOPT | `decisionCap = POSITIVE_SIGNAL`、可计分题 18；runner 不存在 ADOPT 分支 |
| MINOR | Windows 相对路径、点链边界、maxChars、软加载、配置注释 | 各有直测；静态 import 替代软加载；配置头注释同步 |

## 最终门禁

- 全量：**2541 passed / 3 skipped / 0 failed**（真实运行 Stage B 前）。
- Q1 专项：core 23 + Stage A 10 + pilot 36 = **69/69**。
- Stage A：**15/15**，证据命中 15/15，漏召 0，误召 0。
- 最大真实图：10,118,188 B / 10,252 节点 / 10,470 边；340 次渲染、240 次命中；render p95 9.779ms，derived p95 9.996ms。
- 默认关闭：注入文本逐字不变，两个 Q1 状态字段不读不写；UI/preset 可写回，Engine 能读取。
- boundary 0、privacy pass、docs-index 0 未索引、pack 禁入文件 0。

## Stage B 真实配对结果

- 20 题 × A0/A1 × 3 样本 = **120 次调用**，全部完成，**0 重试、0 调用错误**。
- A0 多数票正确 **8/20**；A1 **15/20**。
- UNKNOWN 样本：A0 30 → A1 5（未增加）。
- 但 **B-06 从 A0 多数票正确退化为 A1 多数票错误**，`pairedNoRegression=false`。
- p95 wall time：A0 2265ms → A1 2838ms，`p95Positive=false`。
- 最终：**`NEGATIVE_SIGNAL` / `NOT_ADOPTED`**。

B-06 的 A1 多数票为 `关`；冻结 gold 是 `默认关闭`，aliases 只含 `关闭 / 默认关 / off`。
按冻结 exact/alias 判分必须算错。**不在结果出来后扩 alias 或改 grader。**

## 产品处置

1. 不默认开启；实验代码与开关保留，便于后续 held-out 题集复验。
2. 当前 20 题合成集本身最高只允许 `POSITIVE_SIGNAL`；本次因退化更降为 `NEGATIVE_SIGNAL`。
3. 若要重新提议默认开启，必须先有新的 held-out 任务与新的预注册，不能复用本次结果包装成通过。
