# `evidence/` 索引：哪个数字是现在，哪个是过去

> 这里放的是**实测数据**（不是估算），但它们的**生成时间不同**。混在一起看会被误当现值。
> 判定一个文件是不是最新，**看内容里的「生成于」时间戳，不要看文件 mtime** —— git checkout 会把 mtime 统一刷成检出时间。

---

## ✅ 最新（2026-11-01，1.16.0 之后跑的，可以当现值引用）

| 文件 | 生成命令 | 生成时间 | 关键数字 |
|---|---|---|---|
| `候选待决-2026-11-02.md` | 人工整理（两条未落地候选的待决表：#9 `foldRange` forgotten 边界、#10 规划器预算两档） | 2026-11-02 | #9 ⛔ 暂缓（schema 变更 + 无真机样本）；#10 🟡 可做但须「先判据、后实现、bench ≤415 且失败保留 8/8 才算过」；附「重启后先看什么来决定取舍」的三分支判据 |
| `回滚预案-2026-11-02.md` | 人工整理（重启后行为不对时的 10 分钟退路） | 2026-11-02 | ①设置里禁用插件（30 秒、可逆、不需重启）②换 registry 已发布 1.16.0 ③仓库 `git switch --detach v1.16.0`；数据侧只增不删（`--repair --dry-run` 先行、备份优先）；明确三件**不要**做的事（手改 patch / 杀进程拉起 / 无备份写入） |
| `归档收尾-验证单-2026-11-02.md` | **交接单**：归档本会话后照它核对 C210（closeout 是否写、`trigger: archive` 是否出现、区间是否有序）；含归档前快照、3 条验证命令、成功/失败判据与处置、安全边界 | 归档测试 / 交接时 |
| `手动压缩失败-类身份不一致-2026-11-02.md` | 真机事故：05:15Z 某会话手动 `/compact` 抛 `Receiver must be an instance of class ChessCompactionEngine` —— 事实（日志 JSON）、三类成因、我们做的诊断（C212）、以及还没查清的「谁换了 this」 | 排查手动压缩失败/插件装载两份时 |
| `重启验收清单-2026-11-02.md` | 人工整理（把「重启后 5 分钟内判断新代码是否接管」写成 6 步，每步给期望输出与不符处置） | 2026-11-02 | ①buildId/startedAt ②新指标 `renderErrors`/`skipReasons`/归因字段是否落盘 ③doctor+graph-audit+boundary ④第 21 次 fold 质量 ⑤bench+handoff ⑥全套回归；附 5 类症状对照表 |
| `发布核对-2026-11-02.md` | 只读核对（`npm view` / `npm pack --dry-run` / `git tag` / `check-maintenance`） | 2026-11-02 | 本地 **1.17.1** vs registry **1.16.0**（1.17.0/1.17.1 均未发布）；8 个 tag 最后一个 `v1.16.0`；`check-maintenance` 失败 1；pack **128 files / 2.8 MB** 且全部来自 git 跟踪；附三步发布命令与逐步回滚 |
| `变更审查包-C110-C140-2026-11-02.md` | 人工整理（把本轮 31 条提交按「行为变更 / 只增判据 / 文档判据」分开 + 5 个请审查者回答的问题） | 2026-11-02 | 供独立审查视角逐条挑错：B1–B7 行为变更（含 **B2 会删文件**）、随机化判据的假红/假绿风险、**已标注的 4 条诚实缺口**、边界自查 |
| `持续优化-总览-2026-11-02.md` | 人工汇总（C1–C125 六条线 + 剩余待办） | 2026-11-02 | 120 条 C 轮提交的 2 分钟版：压缩质量/边界审计/落盘回滚/发布共存/文档一致性/调研否决；**唯一待办 = 重启 DSH** |
| `ledger-calibration.json` / `.md` | `node scripts/ledger-calibration.mjs --write`（默认只打印） | 2026-11-01T20:50Z | budget=500、24 会话：**p50 = 419** / p90 = 521 / min 32 / max 688；超预算 3/24；档位 L3=11 L0=5 L2=4 L5=2 L1=2 —— 与合成夹具 415 基本一致，证明 bench 不是虚高 |
| `bench-2000.json` | `node scripts/bench-repro.mjs --write`（**默认只打印**，C85） | 2026-11-02 | 2000 边夹具 L5 档 = **415 tokens**（口径演进见 `scripts/bench-repro.mjs` 顶部注释；最近三刀：`↻k` +1 → 图例单行 −1 → 同类失败标记汇总 −16 → 清冗余指针 −15） |
| `live-folds.json` / `.md` | `node scripts/live-folds.mjs --write`（**默认只打印**，显式 `--write` 才落盘） | 2026-11-02T03:33Z | **31 次 live fold / 9 个有 fold 的会话**（另有 1 条手工压缩记录，无区间）（4 个 multiFold ≥3）：quality 26/31、closure 26/31、boundary 23/31（含 3 次 tier-2 合并；**重启后 04:26Z 首现两次真实折叠**）；质量 c=1 / f=1、压缩比 48.45–350.68、幻觉探针 0；成本 47–76%；`foldThrash` 0；含跨轮趋势与会话分布 |
| `fold质量-多会话-2026-11-02.md` | 从 `live-folds.json` 的 `folds[]` 按会话摆开（逐会话 fold 次数 / quality / closure / boundary / openAtEnd / 召回最小值） | 2026-11-02T03:33Z | **7 个有 fold 的会话、28 次 fold**：采集到 quality 的 21 次召回全 1；带 boundary 的 18 次 openAtEnd 全 0；closure 21 次（preGraph true 1 / false 7）；含 2 次 tier-2 合并 |
| `热清单内容普查-2026-11-02.md` | 离线渲染 live 图 + `measureLedgerSections` 分段统计 | 2026-11-02 | session-d70b7c2f（210 节点/228 边）：500 预算 = 574（超 74）· sections failures 898/1415；1200/3000 预算 = 907 · failures 1646/2693。**逐段核实：热清单与摘要指令都不注入工具输出体** ⇒ G-2 `derivable` 在本插件无落点（负结论） |
| `热清单超预算归因-2026-11-02.md` | 离线复现 + 成本结构 + 被否决的 L6 实验 | 2026-11-02 | live over-budget 19/263（7.2%，2026-11-02 早间快照）、最大超 117；离线 1/19（574/500）。**结论：诚实超限是设计内行为**；L6（3 条失败+关标记）能把 574 压到 472，但破坏 M2 不变量与「L5 列 10 条」契约、且 bench 447→238 白丢失败记忆 ⇒ **否决** |
| `over-budget-snapshot.json` / `.md` | `node scripts/overbudget-report.mjs --out evidence/over-budget-snapshot`（只读+写快照） | 2026-11-01T20:02Z | budget=500、23 会话：within **22** / irreducible **1** / floor 0 / reducible? **0**；唯一超限 `d70b7c2f` 641/500（失败边 10/10 已列全）。含 C58 跨轮对比（构成增删 / 头号来源变化） |
| `折叠成本-实测-2026-11-02.md` | 手工汇总 live `foldMarks[i].usage` | 2026-11-02 | 三次真实 fold：摘要 **input/shadowed = 1.43–1.63**（读整个 surface）、输出仅 362–3004 ⇒ 瓶颈在「读」 |
| `巡检-第4次-2026-11-02.md` | 人工整理（与第 3 次同格式，便于对照） | 2026-11-02 09:2x | 代码侧 **880 passed / bench 415 / doctor 0 错 4 警 / graph-audit 26 会话 0 不自洽 / pack 以当次输出为准**；live 侧**仍是旧进程**（无 buildId；ledger-budget 3550 样本、17.2% 超预算、无归因键；fold 20 次）；写明「为什么现在停手守夜」三条理由 |
| `巡检-第3次-2026-11-02.md` | 七道门禁 + verify-install + post-restart-check + live 折叠质量（当次实测） | 2026-11-02 07:3xZ | 845 测试 / bench 415 / handoff FAIL 0 WARN 5 / doctor 0 错 4 警 / boundary 0 / docs-index 0 / pack 0；verify-install **19/19**（含「用户层 patch 不遮蔽引擎」）；post-restart-check **fail 1 warn 1**（旧进程）；live 19 fold（c=f=1、openAtEnd 0、thrash 0；602 次 over-budget 仍无归因字段） |
| `巡检-第2次-2026-11-02.md` | 全门禁重跑 | 2026-11-02 01:0x | 当次全量测试（见该文件正文） / bench 415 / handoff FAIL 0 / boundary 0 / maintenance 8 通过（1 预期失败=无 tag）/ doctor 0 错 5 警 |
| `终验-2026-11-02.md` | 完整串行收尾核对（7 道门禁 + verify-install + post-restart-check + 即期归因） | 2026-11-01T21:13Z | 758 passed / bench 415（无 DRIFT）/ handoff FAIL 0 WARN 5 / doctor 0 错 3 警 / boundary 0 / docs-index 0 / verify-install 19-19；post-restart-check **fail 1**（buildId 缺失=旧进程，等重启）；即期归因 within 21 · floor 1 · irreducible 2 · **bug 0** |
| `最终验收-2026-11-02.md` | 六道门禁 + live 现状 + 发版待办 + 已知缺口 | 2026-11-02 01:0x | 当次全量测试见正文 / bench 415 · 8/8 / handoff FAIL 0 / boundary 0 / docs-index 0 / doctor 0 错 5 警（均已解释）|
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
| 热清单体积 / 失败边保留 | `node scripts/bench-repro.mjs`（默认不写盘；加 `--write` 才更新本页 `bench-2000.json`） |
| 自动 fold 触发 + 保真度链路 | `node test/real-fold-trigger.mjs`（调真实模型） |
| 与官方模板的对照 | `node test/real-model.mjs --runs 3`（调真实模型） |
| 压缩产物交接 | `node scripts/handoff-check.mjs` |
| live 综合体检 | `node scripts/doctor.mjs` |

> **注意**：`real-fold-trigger` / `real-model` 会调本机 magpie 网关，**不是零成本**；
> 前三个（bench / handoff / doctor）零模型调用，可以随便跑。
