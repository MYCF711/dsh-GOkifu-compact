# K-27 关系行「渲染消歧」同窗配对对照（v1 vs v4）

> **PILOT_ONLY / NOT_ADOPTED** · 预注册 `evidence/lme-relation-prereg-ab-v1v4-2026-11-09.json`（sha `0d4b18773e15…`）· **0 模型调用**（本文件只是聚合）。

- 决策档：**POSITIVE_SIGNAL** —— 多数票 10 → 10，样本级 29/30 → 30/30，无回归题
- 有效性门：对照 full 30/30 样本 · 10/10 多数；处理 full 30/30 样本 · 10/10 多数
- compact 多数票：**10/10 → 10/10**；样本级 **29/30 → 30/30**
- compact 字符数：776 → 811
- 翻转：修好 无；回归 无

## KU-01（唯一历史错题）

| 臂 | 票型 | 多数票正确 | 上下文字符 |
|---|---|---|---|
| v1 compact | {"later-ok":2,"UNKNOWN":1} | ✅ | 82 |
| v4 compact | {"later-ok":3} | ✅ | 84 |

处理轮多数票是否仍是状态词：**否（H1 被支持）**

## 逐题（compact 臂）

| 题 | 类型 | v1 票型 | v1 多数 | v4 票型 | v4 多数 | 翻转 |
|---|---|---|---|---|---|---|
| IE-01 | IE | {"n-ie01-root":3} | ✅ | {"n-ie01-root":3} | ✅ |  |
| IE-02 | IE | {"e-ie02-parse":3} | ✅ | {"e-ie02-parse":3} | ✅ |  |
| MR-01 | MR | {"e-mr01-a,e-mr01-b":3} | ✅ | {"e-mr01-a,e-mr01-b":3} | ✅ |  |
| MR-02 | MR | {"e-mr02-a,e-mr02-c":3} | ✅ | {"e-mr02-a,e-mr02-c":3} | ✅ |  |
| KU-01 | KU | {"later-ok":2,"UNKNOWN":1} | ✅ | {"later-ok":3} | ✅ |  |
| KU-02 | KU | {"retain-20":3} | ✅ | {"retain-20":3} | ✅ |  |
| TR-01 | TR | {"before":3} | ✅ | {"before":3} | ✅ |  |
| TR-02 | TR | {"after":3} | ✅ | {"after":3} | ✅ |  |
| ABS-01 | ABS | {"UNKNOWN":3} | ✅ | {"UNKNOWN":3} | ✅ |  |
| ABS-02 | ABS | {"UNKNOWN":3} | ✅ | {"UNKNOWN":3} | ✅ |  |

## 自检

- 冻结输入哈希：8/8 通过
- 两轮同窗：一致
- 问题项：0

---

PILOT_ONLY：10 题 pilot 的 +1/−1 在噪声量级；本文件不代表 formal 50/50 通过，也不代表关系行有效，更不授权修改默认值。公开面不含逐样本原始模型输出。
