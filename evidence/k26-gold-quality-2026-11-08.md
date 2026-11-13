# K-26 金标质量与压缩质量复核 · 最终结论（2026-11-08）

> 任务：`T8-integration`（lead-protocol）· 结论：**`NOT_ADOPTED`**
> 修订（2026-11-08 · N1-index0）：F1 `GOLD→REJECTED`、F2 quote 修复后合并；K-26 **64G/26R/2P → 63G/27R/2P**，macro **71.18% → 69.10%**。历史 T7 原始 K-2/K-27 结果未改。
> 冻结基线：代码/验收树 `task/axiom-integration @ edd4a9c`；公开文档树 `main @ 3d3d009`。`task/gold-integration` 与 `task/axiom-integration` 同在 `edd4a9c`（`git diff` 为空，合并为 no-op）。未 push、未合并 `main`、未改产品默认。
> `factGuard` 默认保持 **`false`**；不启用、不删失败样本、不回调阈值、不换题。

---

## 1 · 总门槛

| 门槛 | 结果 | 证据 |
|---|---|---|
| K-26 已裁决 precision ≥95% | **FAIL**：macro **69.10%**（63 GOLD / 27 REJECTED / 2 PENDING） | `evidence/k26-audit-2026-11-08.json`；N1-index0 复核；T6R `review-r2/review.json` |
| K-2 不退化 | **FAIL**：full **7/10** → compact **8/10**；degraded `K2-N3`；UNKNOWN 0→1 | `evidence/k2-k27-quality-2026-11-08.json`；T7 `quality/k2-result.json` |
| K-27 pilot ≥90% / Δ≥−5% / perType 全绿 | **FAIL**：full **8/10（80%）**、compact **7/10（70%）**、Δtask **−10%**；KU 1/2、TR 0/2 | `evidence/k2-k27-quality-2026-11-08.json`；T7 `quality/k27-result.json` |
| K-27 正式 50/50 | **NOT_RUN**（未获授权、未运行；不得写 `PASS`） | T7 `quality/REPORT.md` §1.2 |
| 全量测试 / boundary / privacy / docs-index | **PASS**：2351 passed / 0 skipped / 0 failed；boundary 0；privacy changed 0/0；docs-index 0 未索引 | 本报告 §6；T8 复跑记录 |
| 独立标签终审 | **PASS（仅指修订后标签/证据一致性）**：T6R 12/12、92/92、7 条 findings 全部 resolved；**不是** 95% 质量门槛通过 | T6R `review-r2/{REVIEW.md,review.json}` |

> **裁决：`NOT_ADOPTED`。** K-26 主门槛未过（69.10% < 95%），K-2/K-27 也未过；即使标签完整率 92/92、coverage 37/37，也不得用它们冒充 precision 或质量通过。

---

## 2 · K-26 金标（12 份 / 92 条）

### 2.1 最终计数（T6R + N1-index0 口径）

| 项 | 值 |
|---|---|
| 样本 | **12 / 12** |
| 原子事实 | **92 / 92**（index0 4 条 + index1–11 各 8 条） |
| 档位 | **63 GOLD / 27 REJECTED / 2 PENDING** |
| precision（主口径 macro） | **69.10%** |
| precision（micro，已裁决） | **70.00%**（63 / 90） |
| precision（allFacts，保守） | **68.48%**（63 / 92） |
| must-keep `anchorCoverage` | **37 / 37 = 100%**（锚点下界） |
| 标签完整率（status + 同会话 evidenceSeq） | **92 / 92 = 100%** |
| 本轮 88 条 supported quote 逐字 | **61 / 61 = 100%** |
| 全 92 条 supported quote 逐字 | **63 / 63 = 100%**（N1-index0 后；基线 62/64 的缺口已消除，见 2.3） |

### 2.2 T6 修订与 T6R 复核

- T6 独立终审：`NEEDS_REVISION`，5 项 findings、**7 条事实**改判（sample8 F1/F2/F4/F8、sample10 F5、sample6 F2、sample1 F8）全部登记为 R1/R2/R3 修订输入（见 `docs/派单表.md`）。
- R1/R2/R3 修订后，T6R 独立重审：**verdict = PASS**；相对 T6 输入恰好 7 条事实变化，`unexpected = 0`；其余事实与 37 条 mustKeep 未动。
- 计数迁移（历史）：**68 GOLD / 19 REJECTED / 5 PENDING → 64 GOLD / 26 REJECTED / 2 PENDING**；macro 77.80% → **71.18%**（T6R）。N1-index0 后：**63 GOLD / 27 REJECTED / 2 PENDING**，macro **69.10%**。
- 边界：**T6R PASS 是「修订后标签与证据一致」的 PASS，不是质量门槛 PASS**；K-26 仍为 `NOT_ADOPTED`。
- T6R 元数据更正（T4，append-only）：`review-r2/review.json` 对 4-F7/4-F8/9-F5 标 `quoteVerbatim=true` 是历史假阳性（原始会话整段与声明事件均 0 命中）；已追加更正为 false，历史 T6R 原值保留，63G/27R/2P 与指标不变。

### 2.3 index0 继承缺陷（T6-F05）：N1 复核结果（2026-11-08）

- `3e5184c771fe`（index0）F1：旧 quote 是 n1 `seq=9` + n42 `seq=430` 两段事件拼接（multiEventJoin，违反协议 §2.4），单事件连续串不存在；两 seq 均早于该样本 `lastOfflineSummary.range.start=4789`（PRE_WINDOW），range 内无原始用户原话含后半句（ledger/checkpoint 复制品不充当用户原话）。**改判 `GOLD → REJECTED`（not-supported）**，新 quote 收敛为 `seq=9` 单事件 12 字符逐字片段。
- F2：旧 quote 含省略占位与斜杠拼接；原始 `seq=5091` `tool/result` 中 `LOGIN_OK` 与 `GATEWAY 200 … "OK"` 为同一事件内连续两行，新 quote 为 306 字符连续逐字子串（全会话唯一）；range、主体 `tool/result`、时点 n605 均通过，**保留 `GOLD`**。F3 原样 `GOLD`；F4 原 `REJECTED` 不变。
- index0：**3G/1R → 2G/2R**；私有 labels 的 `finalReview` 已标 `legacy`，不参与当前档位读取。该改判是**诚实下调**（macro 71.18% → 69.10%），不是质量提升。
- 范围硬规则没有被放松：本轮 88 条 supported 的 `evidenceSeq` 越界为 **0**；sample8 的 4 条 PRE/POST_WINDOW 已按 ADJ-01 改 `not-supported`。

### 2.4 复跑命令与关键输出

```text
# 以下命令在 task/gold-integration（与 task/axiom-integration 同 rev edd4a9c）工作树、私有标签副本上运行；<REPO> = 主工作树根
$ node scripts/k26-fact-guard-eval.mjs \
    --manifest tmp/k26-labels/manifest.json \
    --labels tmp/k26-labels/labels.jsonl \
    --review-dir tmp/k26-empty \
    --audit "<REPO>/evidence/k26-audit-2026-11-08.json" \
    --home "$DSH_HOME" --out /tmp/k26-eval.json
frozen   : 92 facts = 63G/27R/2P (samples 12)
alignment: OK
replay   : supported 78, rejected 14
precision: label 70.00% (63/90) · guardAccepted 71.79% (56/78) · guardRecall 88.89%
probes   : 10/10
privacy  : PASS · noModelCalls PASS

$ node scripts/k26-coverage-check.mjs \
    --labels tmp/k26-labels/labels.jsonl --home "$DSH_HOME" --out /tmp/k26-coverage.json
{"samples": 12, "withChecklist": 12, "notRun": 0, "invalid": 0, "coverage": 1}
```

---

## 3 · K-2 真实 reader（10 题 × 2 臂 = 20 次）

| 项 | full | compact |
|---|---:|---:|
| 正确 | **7 / 10** | **8 / 10** |
| UNKNOWN | 0 | 1 |
| 错误 | 0 | 0 |
| answerPresentCoverage | 10 / 10 | 10 / 10 |

- 实际调用 **20 / 20**，0 重试；原样回答保留在私有 `quality/raw/`。
- **degraded = K2-N3**（full 正确、compact `ordered-mismatch`）；`unknownIncrease = 1`（K2-O1 compact = `UNKNOWN`）；`abstentionClean = false`。
- 结果状态 **REGRESSION**：存在 full 答对而 compact 答错的题，且 UNKNOWN 增加。`answerPresentCoverage 10/10` 只是字符串覆盖，不是模型答对率。
- 结论：K-2 门 **FAIL**。

---

## 4 · K-27 pilot（10 题 × 2 臂 × 3 采样 = 60 次）

| 项 | 结果 |
|---|---|
| 实际调用 | **60 / 60**，0 错误、0 重试 |
| full 正确 | **8 / 10 = 80%** |
| compact 正确 | **7 / 10 = 70%** |
| Δtask | **−10%** |
| perType | IE 2/2 vs 2/2 · MR 2/2 vs 2/2 · KU 2/2 vs **1/2** · TR **0/2 vs 0/2** · ABS 2/2 vs 2/2 |
| ABS 逐字 UNKNOWN | **2 / 2**（两臂） |
| pilot 门 | **FAIL**（overallCompact / pairedDelta / perType 均未过；abstention 通过） |
| 正式 50/50 | **NOT_RUN**（未获授权；不得写 `PASS`） |

- 关键失败原样保留：`KU-01` compact 三样本 `later-ok / UNKNOWN / UNKNOWN` → 多数 UNKNOWN；`TR-01/TR-02` 中文 `之前/之后` 与冻结 `exact` 英文答案冲突，两臂均判错（0/2），**不调题、不调阈值、不补 alias**。
- 结论：K-27 pilot **FAIL**；正式 50/50 **NOT_RUN**；候选质量差 ≠ 产品可启用。

---

## 5 · 最终裁决

**`NOT_ADOPTED`。**

- `factGuard` 默认保持 **`false`**；不改 `config-schema`、不改产品默认、不合并 `main`、不 push、不重启 DSH。
- K-26：`63 GOLD / 27 REJECTED / 2 PENDING`，macro **69.10% < 95%**；K-2 `REGRESSION`；K-27 pilot `FAIL`；三条均未过。
- 失败样本、`REJECTED`、`PENDING`、原始回答与失败原文全部保留；没有为让结果变绿而删样本、改题、调阈值或提高 `PENDING`。
- 下一轮若复审：只能基于同一冻结集与同一门槛；held-out 另行立项，不得用本轮 12 份外推。

---

## 6 · 工程门（T8 复跑 + N1-index0 复跑）

```text
$ node test/run.mjs                         # task/axiom-integration @ edd4a9c
== 2351 passed, 0 skipped, 0 failed ==

$ node scripts/boundary-audit.mjs
✅ 越界线索 0 条

$ node scripts/privacy-audit.mjs --changed
✅ privacy-audit changed: pass（confirmed=0 / review=0）

$ node scripts/docs-index-check.mjs
✅ 未索引文档 0 个
```

- **N1-index0 集成复跑（2026-11-08）**：K26 eval/coverage 原样输出见 §2.4；`docs-index-check` **未索引文档 0**；`privacy-audit --changed` **files=16 · confirmed=0 · review=0 · public-synthetic=3 · pass**。

---

## 7 · 未验项 / 边界

- **K-27 正式 50/50 = NOT_RUN**：本轮只有 pilot（10 题 × 2 臂 × 3 采样），不能代表正式质量；不得写 `K-27 PASS`。
- **K-26 held-out 未做**：结论只限冻结 12 份样本，不外推到全部会话/全部模型。
- **index0 继承 quote 缺陷（T6-F05）已按 N1 复核处理**：F1→`REJECTED`；F2 quote 修复但保留 `GOLD`；F3/F4 不变；全 92 条 supported quote 为 **63/63 = 100%**，本轮 88 条仍为 61/61；但 K-26 macro 69.10% 仍 <95%。
- **K-2/K-27 的 reader 非确定性**：同一上下文不同采样可能翻转；本轮保留原始输出与分母，不重试、不挑样本。
- 本轮没有改产品代码、没有改默认开关、没有发布或推送；`factGuard` 仍为实验态。

---

## 8 · 来源（公开聚合）

- `evidence/k26-audit-2026-11-08.json`：K-26 12 份 / 92 条 / **63G·27R·2P** 的聚合（无正文、无 quote、无 sid/path；历史 64/26/2 与 68/19/5 均保留在 `history`）。
- `evidence/k2-k27-quality-2026-11-08.json`：K-2/K-27 聚合计数（无原始回答、无题面上下文）。
- `tmp/gold-quality-2026-11-08/review-r2/{REVIEW.md,review.json}`：T6R 独立重审（私有）。
- `tmp/gold-quality-2026-11-08/quality/{k2-result.json,k27-result.json,REPORT.md,raw/}`：T7 真实 reader 原始结果与报告（私有）。
- `docs/knowledge/K-26原子事实标注协议.md`：K-26 规则与本次最终状态补充。
