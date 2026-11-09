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
| `归档收尾-验证单-2026-11-09.md` | **本轮停止交接**：用户要求停止后的真实分支、已复核成果、未合入图缓存工作树、K-26/K-2/K-27 NOT_ADOPTED 与复验命令 | 2026-11-09 | 停止后续实现与实验；图缓存修复未提交、未合入、未独立验收；关系行 BOUNDARY、KU-01 settled 失败保留；不重启、不 push |
| `手动压缩失败-类身份不一致-2026-11-02.md` | 真机事故：05:15Z 某会话手动 `/compact` 抛 `Receiver must be an instance of class ChessCompactionEngine` —— 事实（日志 JSON）、三类成因、我们做的诊断（C212）、以及还没查清的「谁换了 this」 | 排查手动压缩失败/插件装载两份时 |
| `重启验收清单-2026-11-02.md` | 人工整理（**1.17.6 版**：8 步判断新代码是否接管，每步给期望输出与不符处置） | 2026-11-02 | ①版本/进程 ②三条等重启的观测（注入动作 / fold 缓存命中 / 我们的指令占输入 / 归档收尾）③面板两卡+已修正失败 ④补账 dryRun→真跑 ⑤**真的归档一个会话**看 `closeout`（C216 最终判据）⑥bench 417 + graph-audit + boundary + handoff ⑦legacy foldMark（须先退出 DSH）⑧全套回归 971 passed |
| `发布核对-2026-11-02.md` | 只读核对（`npm view` / `npm pack --dry-run` / `git tag` / `check-maintenance`） | 2026-11-02 | 本地 **1.17.1** vs registry **1.16.0**（1.17.0/1.17.1 均未发布）；8 个 tag 最后一个 `v1.16.0`；`check-maintenance` 失败 1；pack **128 files / 2.8 MB** 且全部来自 git 跟踪；附三步发布命令与逐步回滚 |
| `变更审查包-C110-C140-2026-11-02.md` | 人工整理（把本轮 31 条提交按「行为变更 / 只增判据 / 文档判据」分开 + 5 个请审查者回答的问题） | 2026-11-02 | 供独立审查视角逐条挑错：B1–B7 行为变更（含 **B2 会删文件**）、随机化判据的假红/假绿风险、**已标注的 4 条诚实缺口**、边界自查 |
| `持续优化-总览-2026-11-02.md` | 人工汇总（C1–C659 六条线 + 剩余待办；条目数只认仓库根 CHANGELOG 当次，不在本行抄第二份） | 2026-11-02 | 六条线的 2 分钟版：压缩质量/边界审计/落盘回滚/发布共存/文档一致性/调研否决；**唯一待办 = 重启 DSH** |
| `k2-prune-ab-2026-11-06.json` | `node scripts/tool-result-prune-ab.mjs --home <DSH_HOME> --limit 10 --json`（只读离线 A/B） | 2026-11-06 | **已取代（SUPERSEDED）**：旧 10 会话因 raw/ norm 空白差异误报 14/23 条 missing；原 failureRecall **80.23%→77.26%** 与 REJECT 不再作为结论；仅保留作历史 |
| `k32-snippet-normalization-2026-11-06.json` | 修复后 `isRememberedByGraph` + 受控 K-2（≤5MB、排除当前会话） | 2026-11-06 | P2：285 条 snippet，raw 缺 **14** → 归一化后缺 **0**；K-2 受控 10 会话 saved≈**1,122,809 tok**，failure/constraint **1→1**，**CANDIDATE**；仍不默认开启、未跑 reader |
| `k2-controlled-2026-11-06.json` | 受控 K-2 原始输出（`MAX_MB=5`、排除当前根会话、10 条） | 2026-11-06 | evaluated=10 / failureEdges=30 / constraints=32；baseline 2,025,951 tok → every-step 903,142 tok，saved **1,122,809**；failure/constraint 1→1；decision=CANDIDATE；无会话 id |
| `handoff-repair-2026-11-06.json` | `repair-foldmark-fidelity.mjs` 干跑 + handoff 活跃会话修复 | 2026-11-06 | 干跑：1 个历史 foldMark 补回 1 条约束、7 个活跃会话跳过；handoff 由 FAIL2 降到 **FAIL1**（只剩该历史项，未 apply）；默认 dry-run/备份/重读 |
| `release-1.18.3.json` | `node scripts/release.mjs --yes --npm` + `verify-release.mjs` | 2026-11-07 | 1.18.3：tag `v1.18.3` / commit `926b44d` / npm latest 1.18.3 / Release 非 draft；314 文件逐一致；privacy confirmed=0 review=0；全量 2128/0 |
| `release-1.18.4.json` | 同上 + `release-post-verify.mjs` | 2026-11-07 | 1.18.4：tag `v1.18.4` / commit `44c8222` / npm latest 1.18.4 / Release 非 draft；157 文件逐一致；privacy confirmed=0 review=0；全量 2149/0；post-verify exit 0 |
| `release-1.18.5.json` | 同上 + `release-post-verify.mjs` | 2026-11-07 | 1.18.5：tag `v1.18.5` / commit `f91dcbc` / npm latest 1.18.5 / Release 非 draft；158 文件逐一致；privacy confirmed=0 review=0；全量 2149/0；post-verify exit 0 |
| `lme-task50.fixtures.json` | `node scripts/lme-task50.mjs --validate`（默认零模型调用） | 2026-11-06 | K-27 第一阶段：50 道冻结过程题，IE/MR/KU/TR/ABS 各 10；full/compact 配对机械判分与无泄漏检查；真实 reader 任务质量 **NOT_RUN**，不是已通过质量门 |
| `lme-pilot-reader-2026-11-07.{json,md}` | `node scripts/lme-pilot-reader.mjs --run --write` | 2026-11-07 | K-27 预注册 10 题（五类各 2）× 两臂 20 次真实 reader；full **8/10**、compact **7/10**、Δ **-1**；TR 英文/中文判分口径与 KU-02 compact 抽取退化需正式前处理；正式 50/50 仍 **NOT_RUN** |
| `lme-task50-v2.fixtures.json` | `node scripts/lme-task50.mjs --validate` + `test/lme-alias-grader.test.mjs` | 2026-11-07 | K-27 v2：只给 TR-01/02 增加“之前/之后”等价别名；题面/答案/grader/阈值/上下文逐字未改；exact 只接受显式声明别名 |
| `lme-task50-v3-relation.fixtures.json` | `node scripts/lme-relation-render.mjs evidence/lme-task50.fixtures.json evidence/lme-task50-v3-relation.fixtures.json` + `node scripts/lme-relation-coverage.mjs --fixtures evidence/lme-task50-v3-relation.fixtures.json --baseline evidence/lme-task50.fixtures.json`（两者均 0 模型调用） | 2026-11-09 | K-27 v3 关系行夹具：**只重投影 `compactContext`**（主体+证据seq+当前值+状态共行；旧值显式标旧；ABS / before-after 比较题不造关系行）；关系覆盖 **50/50（值型题 38/38）**、反例自测 **20/20**（checker v2 补槽位旧值盲点 X17/X21）；v1 夹具 sha `6a68e82b…` 未变，题面/答案/evidenceSeqs/grader/阈值/prompt 逐字未改；**真实 reader 未跑**（0 调用），不是质量门 |
| `lme-relation-pilot-v5cmp-en-prereg.json` | 冻结预注册文件（文件保持冻结；队长已批准并执行唯一一次 60 调用，结果见下一行） | 2026-11-09 | K-27 关系行 compact 对照预注册：同一 v5cmp-en / `deepseek-v4.1-flash-1017` / temperature 0，只换 compact 臂为 v3 关系行；每类前 2 题 × 2 臂 × 3 样本 = **60 次硬上限、0 重试**；含 full 有效性门、票型分档、**v1→v3 已知差异**（18 题丢证据行 / fold 语境 50→9 / ABS 10 题与比较 2 题改原文投影 / 字符 +9.92%）与 6 条位置推导的授权边界；授权不修改本文件，formal 仍 NOT_RUN、裁决仍 NOT_ADOPTED |
| `lme-relation-pilot-v5cmp-en-2026-11-09.{json,md}` | `LME_READER_VARIANT=v5cmp-en LME_READER_SAMPLES=3 LME_PILOT_FIXTURES=evidence/lme-task50-v3-relation.fixtures.json LME_PILOT_OUT=tmp/k27-relation-pilot/pilot-raw-2026-11-09.json node scripts/lme-pilot-reader.mjs --run --write`（60 次真实调用；逐样本 raw 只留私有 tmp，公开面仅聚合与票型） | 2026-11-09 | K-27 关系行 compact 对照 pilot（预注册 sha `2db532b7…`）：10 题 × 2 臂 × 3 样本 = **60 次**、**0 重试**、0 错误；full 有效性门 **PASSED**（30/30 样本 · 10/10 多数票）；full **10/10** · compact **9/10** · Δ **−1**（决策档 **BOUNDARY**：t9 更正自 EXPLORATORY_POSITIVE —— perType 严格多数，KU 1/2 不通过）；唯一失败 **KU-01 compact 3/3 答成状态词 `settled`**（金标准值 `later-ok`）—— 「状态词冒充值」在真实 reader 上复现；内容差（18 题/19 行丢证据行、fold 50→9、ABS 10 题与比较 2 题改原文、字符 +9.92%）**不作纯语法因果**；formal 50/50 **NOT_RUN**、裁决 **NOT_ADOPTED** |
| `lme-task50-v4-status.fixtures.json` | `node scripts/lme-relation-render-v4.mjs evidence/lme-task50.fixtures.json evidence/lme-task50-v4-status.fixtures.json` + `--verify`（两者均 0 模型调用） | 2026-11-09 | K-27 v4 渲染消歧夹具（sha `fd3e0d15…`）：只把状态从 `status=<词>` 改成行尾 `[<词>]`，**不占 key=value 值位**；与 v3 逐行反向还原后完全一致（改动 59 行 / 38 题，ABS 10 题与比较 2 题原文投影逐字不变）；覆盖 **50/50（值型 38/38）**；v1 `6a68e82b…`、v3 `9055b1b9…`、v3 渲染器 `306dd46e…` 均未改字节 |
| `lme-relation-prereg-ab-v1v4-2026-11-09.json` | 冻结预注册（sha `188fd375…`，在第一次真实调用之前冻结） | 2026-11-09 | K-27 同窗配对对照预注册：同一 v5cmp-en / `deepseek-v4.1-flash-1017` / temperature 0 / 同一冻结 runner，在**同一次窗口**跑 v1 与 v4 两份夹具；每份 10 题 × 2 臂 × 3 样本 = 60 次，两轮共 **120 次硬上限、0 重试**；含两轮 full 有效性门、五档决策规则（INVALID / NEGATIVE / POSITIVE / NO_DIFFERENCE / NOT_DECIDED）与「若 v4 仍答状态词则干扰源是词本身」的预注册解释边界 |
| `冷图回收-内存实测-2026-11-09.md` | 人工整理 + `node scripts/graph-cache-memory.mjs`（只读，0 模型调用） | 2026-11-09 | 冷图回收的定量闭环：1592 张真实 graph.json（222.4 MiB / 17.7 万节点）全驻留 = **+295.7 MB 堆 / +418.1 MB RSS**；走闸门释放后堆只剩 **+0.3 MB**、**RSS 第 8 秒回到基线 67.4 MB**（更正 t6「RSS 不会立刻归还」的旧结论）；最大 12 张 = +72.2 MB（**6.0 MB/张**，全局均值仅 190 KB/张）；磁盘 mtime 1592/1592 未变；附四条交接风险的逐条闭环 |
| `graph-cache-memory-all-2026-11-09.json` | `node scripts/graph-cache-memory.mjs --all --soak 20`（只读） | 2026-11-09 | 全量内存测量原始输出（1592 张）：堆 303.7→8.2 MB、RSS 485.9→67.4 MB、释放 1592/1592、七条断言全过；**私有会话 id 已剥离**（按名次编号保留字节/节点/边形状），`home` 写作 `<DSH_HOME>/chess-context` |
| `graph-cache-memory-top12-2026-11-09.json` | `node scripts/graph-cache-memory.mjs --top 12`（只读） | 2026-11-09 | 最大 12 张的测量原始输出：堆 +72.2 MB → 残留 +1.8 MB、平均 6.0 MB/张；同样已剥离会话 id |
| `lme-pilot-reader-ab-v1-2026-11-09.{json,md}` | `LME_READER_VARIANT=v5cmp-en LME_READER_SAMPLES=3 LME_PILOT_FIXTURES=<v1 夹具> LME_PILOT_OUT=<本行 json> node scripts/lme-pilot-reader.mjs --run --write`（60 次真实调用） | 2026-11-09 | 同窗配对**对照轮**（v1 现行基线）：full **10/10** · compact **10/10**；compact 样本级 **29/30**；KU-01 compact `{later-ok:2, UNKNOWN:1}`（多数票对）；usage in 15449 / out 8136；0 错误 |
| `lme-pilot-reader-ab-v4-2026-11-09.{json,md}` | 同上，`LME_PILOT_FIXTURES=<v4 夹具>`、`LME_PILOT_OUT=<本行 json>`（60 次真实调用） | 2026-11-09 | 同窗配对**处理轮**（v4 消歧）：full **10/10** · compact **10/10**；compact 样本级 **30/30**；KU-01 compact `{later-ok:3}`（**不再答状态词**）；usage in 15538 / out 6752；0 错误 |
| `lme-relation-ab-v1v4-2026-11-09.{json,md}` | `node scripts/lme-relation-ab.mjs --write`（聚合 0 模型调用；确定性重放逐字节相同） | 2026-11-09 | K-27 同窗配对裁决：8 项冻结哈希 8/8 通过、两轮同窗一致、两轮 full 门均过；compact 多数票 **10/10 → 10/10**、样本级 **29/30 → 30/30**、回归 0 / 修好 0；决策档 **`POSITIVE_SIGNAL`**（**但差值只有 1 个样本、无逐题翻转 ⇒ 不作「关系行更好」的结论**）；`authorization` 记录 120/120 调用、0 重试、0 错误；公开面无 raw/trace |
| `k27-ab-结论-2026-11-09.md` | 人工整理（读结果前必看） | 2026-11-09 | 本轮结论与边界：**消歧这一刀有效**（v3 的 `settled×3` 确定性误答 → v4 的 `later-ok×3`）、**但 pilot 已饱和**（两臂 10/10，10 题无法再区分）；v1 基线在 KU-01 上本身不稳定（11-08 1/3 / 本次 2/3）；formal **NOT_RUN**、裁决 **NOT_ADOPTED**、默认**不开**；下一刀（50 题）必须先拍板 6 条位置推导授权或分层报告；附全部哈希与复跑命令 |
| `归档收尾-验证单-2026-11-09.md` | 无命令（交接文档；复跑入口见文内 §5） | 2026-11-09 | 本轮收尾：关系行链路**已验证**（夹具 v3 / checker v2 / 预注册 / 唯一一次 60 调用 pilot / 决策档 BOUNDARY）与冷图**未合入、未复核**（t6 in_progress 无 verdict）分列；含引用红线、状态徽章（formal NOT_RUN、裁决 NOT_ADOPTED）、复跑命令、HANDOFF 更新建议与回退路径；0 模型调用 |
| `lme-formal-reader-2026-11-07.{json,md}` | `node scripts/lme-formal-reader.mjs --run --write` | 2026-11-07 | K-27 v2 正式 50/50：100 次 0 错误；full **100%** / compact **88%** / Δ **-12%**；gate **FAIL**（overallCompact/pairedDelta/perType/abstention）；6 失败上下文均含答案，归因 reader 弃答/抽取，不是压缩丢事实 |
| `lme-reader-prompt-v2-prereg.json` + `lme-pilot-reader-v2-2026-11-07.{json,md}` | 预注册后 `LME_READER_VARIANT=v2 node scripts/lme-pilot-reader.mjs --run --write` | 2026-11-07 | K-27 提示词 v2 pilot：full **7/10** / compact **8/10** / Δ **+1**；full 退化、TR 输出证据 span ⇒ **未放行正式 100 次**；负结果保留，不改夹具/阈值 |
| `lme-reader-prompt-v4m-prereg.json` | 预注册（v4 + 3 次多数采样） | 2026-11-08 | K-27 pilot：同题同上下文采样 3 次取多数；v4 修 TR 格式冲突，v4m 降 reader 抖动；两轮 full 10/10、compact 10/10、Δ0、五类全绿 | <br>（2026-11-08 更正：本行「v4 修 TR 格式冲突……两轮 full 10/10、compact 10/10、Δ0、五类全绿」是 **v2 别名夹具**口径 —— 历史 raw 不记夹具路径，但 `之前/之后` 被判绿只能来自 v2 的 TR-01 `[之前]` / TR-02 `[之后]` aliases；冻结 v1 夹具（无 aliases）下 v4m 3 采样 run（T7，60 次真实调用）重放为 full 8/10、compact 7/10、TR 0/2、perType FAIL。详见 `k27-tr-contract-correction-2026-11-08.md`）
| `lme-pilot-reader-v5cmp-en-2026-11-08.{json,md}` | 预注册（`tmp/k27-tr-contract/prereg`，variant `v5cmp-en`）+ `node scripts/lme-pilot-reader.mjs --run --write`（`LME_READER_VARIANT=v5cmp-en`、`LME_READER_SAMPLES=3`、`LME_PILOT_OUT` 指向本行两个文件） | 2026-11-08 | K-27 v5cmp-en pilot：比较题只准小写英文 `before`/`after`；20 逻辑行 × 3 样本 = **60 次**真实调用、0 错误；full **10/10**、compact **9/10**、Δ **−10%**、TR **2/2 + 2/2**（12/12 样本英文 exact）；门禁 **FAIL**（pairedDelta；KU compact 1/2）；正式 50/50 仍 **NOT_RUN**、裁决 **NOT_ADOPTED** |
| `lme-reader-prompt-v3-prereg.json` + `lme-pilot-reader-v3-2026-11-07.{json,md}` | `LME_READER_VARIANT=v3 LME_PILOT_FIXTURES=evidence/lme-task50-v2.fixtures.json node scripts/lme-pilot-reader.mjs --run --write` | 2026-11-07 | K-27 v3 两步协议（extract→answer）40 次 API 调用：full **6/10** / compact **7/10**；低于放行线，**未跑正式 200 次**；负结果保留 |
| `lme-pilot-reader-kimi-2026-11-07.{json,md}` | `LME_READER_MODEL=group/kimi-k3.1-pro LME_READER_VARIANT=v1 LME_PILOT_FIXTURES=evidence/lme-task50-v2.fixtures.json node scripts/lme-pilot-reader.mjs --run --write` | 2026-11-07 | kimi v1 pilot：full **9/10** / compact **9/10** / Δ0；TR 两臂全对，达到放行线 | 
| `lme-reader-model-kimi-prereg.json` + `lme-formal-reader-kimi-2026-11-07.{json,md}` | `LME_READER_MODEL=group/kimi-k3.1-pro node scripts/lme-formal-reader.mjs --run --write` | 2026-11-07 | kimi v1 正式 50/50：full **96%** / compact **96%** / Δ0；仅 **abstention** 失败（ABS-07 compact 编造 662）；最接近 PASS，仍 FAIL |
| `lme-reader-prompt-v1b-prereg.json` + `lme-formal-reader-kimi-v1b-2026-11-07.{json,md}` | `LME_READER_MODEL=group/kimi-k3.1-pro LME_READER_VARIANT=v1b node scripts/lme-formal-reader.mjs --run --write` | 2026-11-07 | kimi v1b 正式：full **96%** / compact **88%** / Δ **-8%**；abstention 10/10 但 compact 退化；**FAIL**，不采用 |
| `lme-reader-postprocess-v1n-prereg.json` + `lme-formal-reader-kimi-v1n-2026-11-07.{json,md}` | `LME_READER_MODEL=group/kimi-k3.1-pro LME_READER_VARIANT=v1 LME_READER_POSTPROCESS=v1n node scripts/lme-formal-reader.mjs --run --write` | 2026-11-07 | kimi v1n 正式：full **96%** / compact **94%** / Δ **-2%**；修掉 662 编造，但 ABS-08 仍答上下文 id；**FAIL**，不采用 |
| `lme-reader-postprocess-v1e-prereg.json` + `lme-formal-reader-kimi-v1e-2026-11-07.{json,md}` | `LME_READER_MODEL=group/kimi-k3.1-pro LME_READER_VARIANT=v1 LME_READER_POSTPROCESS=v1e node scripts/lme-formal-reader.mjs --run --write` | 2026-11-07 | kimi v1e 正式：full **96%** / compact **94%** / Δ **-2%**，六门槛全绿 **PASS**；带确定性后处理，不是裸模型能力 |
| `k26-samples-2026-11-07.json` | 只读样本清单（无正文） | 2026-11-07 | K-26 主会话专选 12 份（339 候选、排除 327 子代理）；只含样本 ID/字符数/摘要哈希；coverage 12/12 37/37，precision 待 4 份 |
| `k26-audit-2026-11-07.json` | K-26 12/12 聚合（无正文） | 2026-11-07 | 92 条 = **68 GOLD + 19 REJECTED + 5 PENDING**；precision 73.9%–78.2%；coverage 37/37 不等于事实正确 |
| `k2-reader-pilot-2026-11-07.json` | K-2 定向 reader 三样本边界 | 2026-11-07 | 值型小结果两臂都对；2/2 检索标题型退化（baseline 14 标题 vs everyStep 0）；**TASK_CONDITIONAL**，不能默认全局开 |
| `k2-reader-expand-2026-11-07.json` | K-2 reader 扩样（2 会话/4 题） | 2026-11-07 | baseline 4/4，everyStep 2/4；**2/4 退化**；成功工具结果里的值会丢，失败边/约束安全；共省 30,026 字符 |
| `k2-normalize-v2-prereg.json` | 版本化 opt-in 预注册（公开只含规则/哈希/反例类别，无 raw 回答/题面） | 2026-11-08 | K-2 **normalize-v2**：21 条测试向量（sha256 `e7ed12de…`）；规则/哈希/反例类别；`implementation=NOT_APPLIED`、`adoption=NOT_ADOPTED`、`gate6=false`；不改 raw/题面/答案/alias/阈值，不重跑模型；v2 离线复分 compact 8→9，但 official raw 仍 **full 7/10、compact 8/10**、gate6 仍 false |
| `k2-normalize-v2-freeze-2026-11-08.json` | `node scripts/k2-v2-offline-replay.mjs --write` + `node test/run.mjs k2-normalize-v2` | 2026-11-08 | K-2 **normalize-v2** 离线第二列冻结：21 条冻结向量 **21/21**、T7 20 行 v1 复算 **20/20** 逐字一致；v2 只把 K2-N3/compact 的格式假阴性改对（compact **8→9**、degraded **1→0**），**unknownIncrease 1 不变**、**gate6 仍 false**；official 列仍是 raw、**未采用**；零模型调用、官方历史只读 |
| `ledger-calibration.json` / `.md` | `node scripts/ledger-calibration.mjs --write`（默认只打印） | 2026-11-01T20:50Z | budget=500、24 会话：**p50 = 419** / p90 = 521 / min 32 / max 688；超预算 3/24；档位 L3=11 L0=5 L2=4 L5=2 L1=2 —— 与合成夹具 417 基本一致，证明 bench 不是虚高 |
| `bench-2000.json` | `node scripts/bench-repro.mjs --write`（**默认只打印**，C85） | 2026-11-02 | 2000 边夹具 L5 档 = **417 tokens**（口径演进见 `scripts/bench-repro.mjs` 顶部注释；最近三刀：`↻k` +1 → 图例单行 −1 → 同类失败标记汇总 −16 → 清冗余指针 −15；`bench-2000.json` 里的 `ledgerTokens` 也是 417，别再抄 415） |
| `live-folds.json` / `.md` | `node scripts/live-folds.mjs --write`（**默认只打印**，显式 `--write` 才落盘） | 2026-11-08T07:59:18Z | **2218 次 live fold / 1095 会话**（另有 1 条手工压缩记录，无区间；**快照非累计**，口径见 `.md` 的「快照语义」）；quality 2211、质量 c=0.6666666666666666 / f=0（=0 4 条 / <1 33 条，其中 archive-offline 26 条）、压缩比 11.41–309.1、幻觉探针 5 个 id（来自 1 条 fold，不是「5 次命中」）；闭包链 159 对中 26 处节点级重叠 = 21 处 →tier2 合并（设计内）+ 5 处非 tier2（只有后者算质量线索，别把总数当回归）；成本 16–3220%（>100% 共 28 次，其中 23 次路由 `group/kimi-k3.1-pro`；上限由这些小遮蔽量样本抬高，不是模型优劣）；`foldThrash` 0（会话 id 一律为稳定伪名 `s_<12hex>`） |
| `fold质量-多会话-2026-11-02.md` | `node scripts/fold-per-session.mjs --write`（**生成物**，从 `live-folds.json` 摊开，勿手改） | 2026-11-08T07:59:18Z | **1095 个有 fold 的会话 / 2219 条 fold 记录**（= 2218 次 fold + 1 条手工记录）：quality 2211 次召回最小 0.6666666666666666、**failureRecall 最小 0**；带 boundary 的 **251** 次，openAtEnd **合计 1**（manual 1；C655 历史复现折痕，不是自动 fold 的回归）；`foldThrash` 0 |
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
| 摘要有没有编造/越界引用 id（C455 修复的验证） | `node scripts/summary-refs.mjs`（加 `--write` 落基线 `摘要引用基线.json`，之后只看基线之后的新折叠） |

> **注意**：`real-fold-trigger` / `real-model` 会调本机 magpie 网关，**不是零成本**；
> 前三个（bench / handoff / doctor）零模型调用，可以随便跑。
