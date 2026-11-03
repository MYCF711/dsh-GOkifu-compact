# 「完成」的语义：成功才算完成，尝试不算（Kubernetes Job）· 已核实

> 来源：<https://kubernetes.io/docs/concepts/workloads/controllers/job/>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 原文（逐字，**已核实**）

> "**once at least one Pod has terminated with success** and all Pods are terminated,
> then the Job is **completed with success**."

> "A **Pod failure policy** … enables your cluster to handle Pod failures based on the container exit codes …
> In some situations, you may want to have a better control when handling Pod failures than the control provided by
> the Pod **backoff failure policy**, which is based on the Job's `.spec.backoffLimit`."

即：Job 的完成状态**由"成功"定义**；失败只消耗 `backoffLimit` 这个重试预算，**不会把 Job 变成已完成**。

## 2. 我们踩的同一个坑（C476 / C477）

2026-11-03 真机：会话「发布代码仓库并公开」归档时写下

```json
"closeout": { "source": "archive", "foldAttempted": true, "folded": 0, "foldNote": "nothing-to-fold" }
```

而我们的判据是 `closedOut = graph.closeout !== undefined` —— **等价于"尝试过就算完成"**。后果：

- 账本侧：`due` 变 `false`，**永远不再补**（C476 修）
- 引擎侧：重开该会话时 `#backfillIfPending` 直接 return，**永远不再试**（C477 修）

改法：`closeoutSettles()` 只认「真的折了」或「确实没内容」；失败/超时/算不出区间/无原因的老记录 ⇒ **未完成**。

## 3. 待核实

- `backoffLimit` 的**具体退避曲线**（指数？上限多少）这页没给公式，只提到"基于 `.spec.backoffLimit`"；
- 我们没有照搬 Job 的重试预算：我们的"预算"是**事件退避**（`FOLD_RETRY_BASE_SEQ`…），语义不同，别混用。
