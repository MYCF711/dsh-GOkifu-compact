# K-27 关系行 compact 对照 pilot（10 题 × 2 臂 × 3 样本）

> **PILOT_ONLY / NOT_ADOPTED**：不是正式 50/50 质量门；预注册 `evidence/lme-relation-pilot-v5cmp-en-prereg.json`（sha `2db532b7…`）。

- 模型 / 端点：`deepseek-v4.1-flash-1017` / `http://127.0.0.1:3425/v1/chat/completions`；variant `v5cmp-en`；temperature 0；postprocess none
- 调用：**60** 次（10 题 × full/compact × 3 样本），硬上限 60，重试 **0**
- 机械判分（多数票）：full **10/10** · compact **9/10** · Δ **-1**
- 样本级：full **30/30** · compact **27/30**
- full 有效性门：**PASSED**（30/30 样本 且 10/10 多数票）
- 决策档（仅决定是否再投入）：**BOUNDARY**（更正自 `EXPLORATORY_POSITIVE`：perType 条件从「compact majorityCorrect >= 1（2 题/类即 ≤1/2 也算通过）」更正为「majorityCorrect * 2 > questions（严格多数，2 题必须 2/2）」）
- 逐类严格多数：IE 2/2✅ · MR 2/2✅ · KU 1/2❌ · TR 2/2✅ · ABS 2/2✅
- 授权：队长批准唯一一次（prereg sha `2db532b794dec0ee8b29061c330458f39d3d60ae0b1a63ad810c2d867cc1274f`，runsAuthorized=1，runsUsed=1）
- 用量：input 13839 / output 7170 tokens；总延迟 75401 ms；错误 0 次

## 逐题票型

| 题 | 类型 | full 票型 | full 多数票 | compact 票型 | compact 多数票 |
|---|---|---|---|---|---|
| IE-01 | IE | n-ie01-root×3 | ✅ | n-ie01-root×3 | ✅ |
| IE-02 | IE | e-ie02-parse×3 | ✅ | e-ie02-parse×3 | ✅ |
| MR-01 | MR | e-mr01-a,e-mr01-b×2 / e-mr01-a, e-mr01-b×1 | ✅ | e-mr01-a,e-mr01-b×2 / e-mr01-a, e-mr01-b×1 | ✅ |
| MR-02 | MR | e-mr02-a,e-mr02-c×3 | ✅ | e-mr02-a,e-mr02-c×3 | ✅ |
| KU-01 | KU | later-ok×3 | ✅ | settled×3 | ❌ |
| KU-02 | KU | retain-20×3 | ✅ | retain-20×3 | ✅ |
| TR-01 | TR | before×3 | ✅ | before×3 | ✅ |
| TR-02 | TR | after×3 | ✅ | after×3 | ✅ |
| ABS-01 | ABS | UNKNOWN×3 | ✅ | UNKNOWN×3 | ✅ |
| ABS-02 | ABS | UNKNOWN×3 | ✅ | UNKNOWN×3 | ✅ |

## 已知内容差（不作纯语法因果）

- v1→v3 丢证据行：**18 题 / 19 行**（pilot 内仅 IE-01 的 seq=101）
- fold 语境：**50 → 9** 题；ABS 投影 **10** 题、比较题 **2** 题改原文；compact 字符 **+9.92%**
- 本轮同时改变语法与内容 ⇒ 差异**不能**归因为「纯语法（关系行）」；要单独识别需第三臂「v1 语法 + 只补关系字段」
- 6 条位置推导：pilot 选样 **0/6** 命中，扩 50 题前需授权或分层报告

## 边界

- 逐样本 raw 只保留在私有 tmp（公开面仅聚合与票型）；formal 50/50 **NOT_RUN**、裁决 **NOT_ADOPTED**、关系行渲染**不默认开启**。
