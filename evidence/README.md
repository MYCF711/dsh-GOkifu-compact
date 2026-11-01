# `evidence/` 索引：哪个数字是现在，哪个是过去

> 这里放的是**实测数据**（不是估算），但它们的**生成时间不同**。混在一起看会被误当现值。
> 判定一个文件是不是最新，**看内容里的「生成于」时间戳，不要看文件 mtime** —— git checkout 会把 mtime 统一刷成检出时间。

---

## ✅ 最新（2026-11-01，1.16.0 之后跑的，可以当现值引用）

| 文件 | 生成命令 | 生成时间 | 关键数字 |
|---|---|---|---|
| `bench-2000.json` | `node scripts/bench-repro.mjs` | 2026-11-02 | 2000 边夹具 L5 档 = **447 tokens**（351 → 446 来自「出处全档保留 + OPTIONS 不沉默」；446 → 447 来自失败边重试计数 `↻k`） |
| `live-folds.json` / `.md` | `node scripts/live-folds.mjs`（只读，自动汇总 `foldMarks`） | 2026-11-02T19:4xZ | **12 次 live fold / 6 个有 fold 的会话**（2 个 multiFold ≥3）：usage 12/12、trigger 8/12、quality 8/12、closure 8/12；质量 c=1 / f=1、压缩比 48.45–350.68、幻觉探针 0；成本 47–74%（ROI 0.45–0.74）；边界 openAtEnd 全 0；`foldThrash` 0；含 C50 跨轮趋势与 C54 会话分布 |
| `热清单内容普查-2026-11-02.md` | 离线渲染 live 图 + `measureLedgerSections` 分段统计 | 2026-11-02 | session-d70b7c2f（210 节点/228 边）：500 预算 = 574（超 74）· sections failures 898/1415；1200/3000 预算 = 907 · failures 1646/2693。**逐段核实：热清单与摘要指令都不注入工具输出体** ⇒ G-2 `derivable` 在本插件无落点（负结论） |
| `热清单超预算归因-2026-11-02.md` | 离线复现 + 成本结构 + 被否决的 L6 实验 | 2026-11-02 | live over-budget 19/263（7.2%）、最大超 117；离线 1/19（574/500）。**结论：诚实超限是设计内行为**；L6（3 条失败+关标记）能把 574 压到 472，但破坏 M2 不变量与「L5 列 10 条」契约、且 bench 447→238 白丢失败记忆 ⇒ **否决** |
| `折叠成本-实测-2026-11-02.md` | 手工汇总 live `foldMarks[i].usage` | 2026-11-02 | 三次真实 fold：摘要 **input/shadowed = 1.43–1.63**（读整个 surface）、输出仅 362–3004 ⇒ 瓶颈在「读」 |
| `巡检-第2次-2026-11-02.md` | 全门禁重跑 | 2026-11-02 01:0x | 668 测试 / bench 447 / handoff FAIL 0 / boundary 0 / maintenance 8 通过（1 预期失败=无 tag）/ doctor 0 错 5 警 |
| `最终验收-2026-11-02.md` | 六道门禁 + live 现状 + 发版待办 + 已知缺口 | 2026-11-02 01:0x | **676 测试** / bench 447 · 8/8 / handoff FAIL 0 / boundary 0 / docs-index 0 / doctor 0 错 5 警（均已解释）|
| `fold触发验证.json` / `.md` | `node test/real-fold-trigger.mjs`（真实模型） | 2026-11-02T18:50Z | 自动 fold 触发 5/5 + **fold-fields 字段 gate = 6/6**；字段样例 `closure n/e=22/1 preGraph=false graphNodes=26 boundary={overlapping:1,openAtEnd:0,unsettled:0}`；保真度 cRecall=1 / fRecall=0（桩 prompt，见 qualityNote） |
| `真实模型测试.json` / `.md` | `node test/real-model.mjs --runs 3` | 2026-11-01T15:13Z | 失败边 **6.67/8 vs 官方 5.67/8**；**约束 2/2 vs 官方 0/2**；续跑 8/8；热上下文 594 prompt tokens |

---

## ⚠ 历史（1.15 及更早，**数字不要当现值**）

以下文件都是 2026-10-28 ~ 10-31 期间生成的。它们记录的是**当时的版本与当时的夹具**，
其中一些结论已经被后续实测刷新（最典型：`真实模型多规模测试.md` 的 8/8，
在 11-01 的三次采样重跑里是 6.67/8 —— 夹具不同 + 采样波动，不是退步）。

- `真实模型多规模测试.json` / `.md`（10-28，5/15/30 条失败边场景）
- `compare-models.json`（10-31，多模型对照）
- `今日效果评估-2026-10-29.md`（10-29 当日汇总）
- `ima-摘要测试.*`、`模拟结果.*`、`三态标签AB实验.md`、`热清单标记AB实验.md`、`棋谱有效性实验.md`
- `P0-worldhash-修复验证.md`、`P1-4-清单替换实测.md`、`收尾三件-dead锚点-树读取-回洗.md`
- `真实端到端测试.*`、`真实计费核对.md`
- `真实进程首次fold.md`（真实 DSH 进程里的第一次 fold 记录）
- `重启验证.md`（重启后的验收记录）
- `评估报告-2026-10-29-主人打分.md`（主人对 10-29 那版的主观评分，历史方法参考）

---

## 怎么复跑

| 想验证什么 | 跑什么 |
|---|---|
| 热清单体积 / 失败边保留 | `node scripts/bench-repro.mjs` |
| 自动 fold 触发 + 保真度链路 | `node test/real-fold-trigger.mjs`（调真实模型） |
| 与官方模板的对照 | `node test/real-model.mjs --runs 3`（调真实模型） |
| 压缩产物交接 | `node scripts/handoff-check.mjs` |
| live 综合体检 | `node scripts/doctor.mjs` |

> **注意**：`real-fold-trigger` / `real-model` 会调本机 magpie 网关，**不是零成本**；
> 前三个（bench / handoff / doctor）零模型调用，可以随便跑。
