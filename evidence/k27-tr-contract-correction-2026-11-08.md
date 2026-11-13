# K-27 v4 / v4m 历史误述更正（append-only，2026-11-08）

> 本文件是**追加式更正记录**：不改写任何既有 evidence 文件的内容，只声明哪些既有表述在冻结 v1 判分口径下不成立。
> 依据：`tmp/k27-tr-contract/audit/REPORT.md`（TR1 审计）、`tmp/k27-tr-contract/prereg/prereg.json`（v5cmp-en 预注册）、`tmp/k27-tr-contract/prereg/checks.log`（零模型校验）。
> 团队裁决：**NOT_ADOPTED**；正式 50/50 仍 **NOT_RUN**。

## 1. 不成立的表述

| 位置 | 原表述 | 冻结 v1 口径下的实际结果 |
|---|---|---|
| `evidence/README.md:32` | 「v4 修 TR 格式冲突……两轮 full 10/10、compact 10/10、Δ0、五类全绿」 | v4/v4m 的 TR 2/2 与两轮 10/10 是 **v2 别名夹具**（TR-01 `[之前]`、TR-02 `[之后]`）口径；冻结 v1 夹具（无 aliases）重放同批 raw 为 **full 8/10、compact 8/10、TR 0/2、perType FAIL** |
| `evidence/lme-reader-prompt-v4m-prereg.json` 的 `reason` | 「v4 fixed TR format (0/2 -> 2/2)」 | 在冻结 v1 下为**假**：v4 的 TR 仍是 0/2（compact 个别 1/2），2/2 来自 v2 aliases |
| `dsh-GOkifu-compact/evidence/两条公理纠偏-2026-11-07.md:162` | 「v4m 三次多数采样两轮 full 10/10、compact 10/10、Δ0、五类全绿；v4 把 TR 从 0/2 修到 2/2」 | 同上：v2 别名口径；冻结 v1 下 v4m 3 采样 run（T7，60 次真实调用、0 错误）为 **full 8/10、compact 7/10、Δ −10%、TR 0/2、门禁 FAIL** |

## 2. 被 sha256 钉住的文件：原样保留

`evidence/lme-reader-prompt-v4m-prereg.json`（sha256 `aaf0df54…`）**不做任何就地编辑**：它被 `tmp/k27-tr-contract/prereg/prereg.json` 的 `supersedes.sha256` 与校验器 A3 钉死，「就地加注」与「哈希不变」互斥。本文件即其更正声明，**以本文件为准**。

## 3. 边界

- 不得据此重判任何历史 raw：T7 的 `k27-pilot-raw.json`（`a8fa72…`）与 `k27-result.json`（`9628d5…`）原样保留。
- 不得把本更正当作「v4 修好了 TR」的新论据；`v5cmp-en` 是**新实验**，其 60 次 run 需按 `tmp/k27-tr-contract/prereg/prereg.json` 执行，且**只报 pilot 指标**。
- append-only：`evidence/README.md` 只在既有 v4m 行（相对 HEAD 的新增行）行末追加更正注 —— 仅 C1 注时 `git diff --numstat` 为 `1 0`；交付再追加一行索引行后为 `2 0`，**始终只增不删**；`两条公理纠偏` 同理只追加行末注。
- 正式 50/50 仍 `NOT_RUN`；裁决仍 `NOT_ADOPTED`。
