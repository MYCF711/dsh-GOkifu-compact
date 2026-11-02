# dsh-GOkifu-compact · 交接文件

## ✅ 当前状态（滚动更新，2026-11-02 07:1x 本地）

| 项 | 值 |
|---|---|
| 版本 | **1.17.1**（`package.json`；已装到本机并被机器级层接管。`npm publish` / 打 tag **待主人授权** —— `check-maintenance` 只剩这一项预期失败） |
| 代码 | 见 `git log --oneline`；本块写于 `C123`（`e6655c9`）之后 |
| 门禁（串行） | 全量 **864 passed / 0 skipped / 0 failed** · bench **415 tokens** / 失败保留 8/8 · handoff-check **FAIL 0 / WARN 5** · doctor **0 错误 / 4 警告** · boundary-audit **0 条** · docs-index **0** · pack-check **无出处 0** · graph-audit **25 会话 0 不自洽** |
| ⏳ **唯一待办** | **重启 DSH**：`post-restart-check` 仍 `fail 1`（`build.json` 无 `buildId` = 03:01 启动的旧进程）。重启后才会：① `renderErrors` / `skipReasons` / 四个归因字段**首次落盘**；② 新 fold 第一次跑上 C112/C113 的回滚/自愈路径；③ 94 个陈旧 `nodes/*.md` 在各会话下次 fold 时被清掉 |
| 已知边界 | 第三方 preset（如 `dsh-design-studio:preset-design`）不走棋谱压缩（C94，只登记不覆盖）；`dsh` 的 preset 覆盖/insert id 冲突各有 doctor 检查（C95/C96） |
| 行为判据 | 规划器随机不变量（C127：结构/区间/门槛/幂等/溢出更宽松；C128：尾部保留不超 retain+maxNode；C129：注入决策随机不变量；C130：历史清单清理随机不变量；C132：随机合并后图不变量；C133：任意写序点失败；C134：fold 抛错原子性；C135：手动 /compact 深度记账；C136：tier-2 失败清 pending 摘要【真 bug】；C137：手动压缩 pending 兜底清理；C138：foldThrash 累计/清零）· 渲染器不变量（C59）· 落盘回滚（C111–C114）· 探针（C90/C91/C104/C105） |
| 独立审查 | 已跑一轮（C142/C143）：P0 一条已修、**P1 六条已全部处理**（P1-1/P1-3 在 C142，P1-2/P1-4/P1-5/P1-6 在本轮）；剩余 P2 六条已记录 |
| 数据修复 | C144：`graph-audit --repair` 已补写 2 个历史缺失的 `nodes/<id>.md`（只增不删），doctor 回到 **4 警** |
 已完成一轮（C142）：抓到 **P0 一条（回滚丢未落盘变更）+ P1 六条**，P0 与 P1-1/P1-3 已修（含夹具缺陷）；待做 P1-2/P1-4（doctor/graph-audit 重放 delta）、P1-5（规则路径清 route/usage）、P1-6（C130 保留最新一条） |
| 文档判据 | 命令/子命令（C86/C125）、检查名（C97/C98）、常量锚（C100/C101）、测试数（C117）、证据数字（C118/C119/C122/C123）、可发现性（C116/C120）、调研文引用（C121）、HANDOFF 版本（C124） |
| 图体检 | doctor 内建「棋谱结构自洽（C140）」，另可 `node scripts/graph-audit.mjs` 手动跑（只读） |
| 旧图体检入口 | `node scripts/graph-audit.mjs`（只读；四类不变量逐会话体检，live 24 会话 0 不自洽） |
| 最新巡检 | `evidence/巡检-第3次-2026-11-02.md`（七道门禁 + verify-install 19/19 + 重启前后差异表） |
| 人读总览 | `evidence/持续优化-总览-2026-11-02.md`（120 条 C 轮的 2 分钟版：六条线 + 剩余待办） |
| 怎么读这份文件 | 本块 = 现状；下面的是**追加日志**（C1 → C124，旧在上、新在下），只用于查「某个改动为什么这么写」。判读顺序：本块 → `docs/README.md` → `docs/压缩的职责边界.md` → `docs/压缩的重注入契约.md` → `docs/落盘与回滚不变量.md` |

---

## 🗒 追加日志（旧在上、新在下；最后更新到 C124）


| 项 | 值 |
|---|---|
| 版本 | `package.json` 已 bump 到 **1.17.0**（`check-maintenance` 要求：改了代码必须 bump，否则 git 源用户永远停在旧 commit）；**未 npm publish、未打 tag** —— 这两步需主人授权。当前 `check-maintenance` 预期只剩 1 项失败：「1.17.0 没有 tag」= 尚未发版 |
| 单测 | **668 passed / 0 skipped / 0 failed**（`node test/run.mjs`，**必须串行**；并发跑会共用 `test/.harness/graphs`，出现 T2-5 类假红） |
| 本轮提交 | `e7e72f9`（C2/C3/C4，本会话）；并行会话另有 `262c92d`(thrashing 进 doctor) / `c79c8ed`(fold 无效一等可见 + 重注入契约) / `671132a`(调研三份归档) / `a3fe4d4`(ROOMS 登记 touched-files) / `31188a5`(压缩质量观测盘点) |
| **C2 出处覆盖率可观测** | `ledgerBudgetMetrics.provenanceCoverage` → `accumulateLedgerBudget()`（`provenanceMin`/`provenanceLow`；旧 `ledger-budget.json` 无字段时首累计按 **1** 起算，不许当 0）→ doctor「热清单预算（fallback）」显示 `provenanceMin`（旧文件显示「未采集」）；覆盖率 <1 时日志升 warn 并带数值 |
| **C3 省略行可解析** | 热清单省略行 + `FAILED_ATTEMPTS_OMITTED` + `DANGLING_RESIDUE` 统一给「数量 + 区间 + 相对化路径」（`sessions/<sid>/graph.json`、`nodes/<id>.md`；无 treeDir 退化 `graph.json`），**绝不泄漏绝对路径**（P6a）；`renderFacts` 新增 `treeDir/traceRoot` 选项，`engine.summarize` 传入会话目录 |
| **C4 折叠段最近访问文件** | 新房间 `src/rooms/touched-files.mjs`：从图边 `action` 机械解析 `read/edit/write/multi_edit/apply_patch` 的 `file_path`（不解析 bash），按 evidence 区间过滤/倒序/去重/上限 5；`engine.summarize` 在约束段之后**机械追加**（零模型调用），**只进折叠摘要、不进每步热清单** |
| 验证（本轮） | 全量 634/0/0；`ledger-boundary` 8/8、`touched-files` 9/9、`engine-harness` 45/45；真实语料 `measure-ledger`：11 会话 / 3509 tokens，与 HEAD 分支**逐会话一致**（C3 对无省略场景零成本）；doctor live = 0 错误 / 1 警告（`over-budget=5` 是 21:51 重启后的**既有行为**，归因见 `docs/压缩质量-现有观测盘点与缺口.md` §3，不是本轮回归） |
| **C5 交接测试可执行化** | 新脚本 `scripts/handoff-check.mjs`：只读地对 live 每张图渲染一次，按《压缩的重注入契约》七项 + 省略行可解析 + 预算逐项判定（`--json` 机读）。首跑 11 个会话抓出三个真缺口并修掉：⑤UNVERIFIED 在 L2+ 静默消失、失败边不是物理一行（多行 errorSnippet 把 seq 挤到第二行）、出处覆盖率把 OPTIONS/UNVERIFIED 算进分母。修后 **FAIL 11→0 / WARN 8→4**（剩余：2 张无 user 节点孤儿图 + 1 次 over-budget，均已在输出里说明） |
| **独立验证（专员）** | 报告 `tmp/verify-round2/REPORT.md`：以 commit 冻结的干净 worktree 复验，**C2/C3/C4/C5 全部 PASS、P0=0/P1=0**；全量 634/0/0；变异检查证实 C3/C4/单行化/覆盖率口径 4 个新测试真红；边界审计无新增行为指导；预算 C2/C3/C4 逐会话 0 token、C5 条件 +75（生产口径）。它指出的 3 个 P2 已收口：doctor「未采集」不再报 ok、补 `test/unverified-tier.test.mjs`、handoff-check ⑤ 排除 residue（live 修后 FAIL 0 / WARN 3）。全量现为 **638/0/0** |
| **C6/C7 保真度 L1** | `src/rooms/fold-quality.mjs`：`constraintRecall`（丢一条=任务变了）/`failureRecall`（丢一条=必然重踩）/`compressionRatio`；engine 每次 fold 写 `foldMarks[i].quality`；doctor 新增「压缩保真度（最近 fold）」并在召回 <1 时 error/warn + 点名丢失项；老 foldMark 无 quality ⇒ 「未采集」不报 ok。测试：`fold-quality` 6 用例 + engine-harness P2-2-1/P2-2-4 扩展；**C7 补齐两个口径漏洞**：`summaryMode: rules`/降级 fold 也记 quality（以前永远 null ⇒ 「未采集」）；`summaryTokens` 改用 CJK 感知口径（旧 `chars/2` 会系统性低估 compressionRatio）。测试：Q-7 + P2-2-1 公式一致性 + P2-2-2 规则降级保真度 |
| **C8 保真度真值链路（本轮）** | `real-fold-trigger.mjs` 改造成可验证保真度：桩把事件派发给 `ctx.emit("session/event")`（keeper 真跑）+ 补失败调用与 `step/end`（边有终点，不被判残留）+ 校验看所有 foldMark。实测真实模型 3 次 fold：`fold#1 c=2/1 f=1/0`，**不再真空通过**。边界：桩 LLM 自拼 prompt ⇒ constraintRecall 有效、failureRecall 不代表生产；证明的是 engine→keeper→fold-quality→foldMarks 链路。证据 `evidence/fold触发验证.{json,md}` |
| **C9 交接门禁升级（本轮）** | `handoff-check` 增 ⑩保真度（constraintRecall<1=fail / failureRecall<1=warn / 真空样本=warn，并点名丢失项）与 ⑪幻觉探针（unknownIds 非空=warn）；无 fold 的会话不告警、旧折叠缺 quality 标「未采集」。`test/handoff-check.test.mjs` 7 用例。live：FAIL 0 / WARN 6（2 孤儿图 + 3 旧折叠 + 1 over-budget） |
| **C10 模型自身保真（本轮）** | engine 在机械追加段之前留一份纯模型输出 `modelText` → `foldMarks[i].quality.modelConstraintRecall` 变成真实数字（此前生产路径恒 null）；规则路径显式清空防串味；doctor 已会显示「模型自身约束召回」。测试：P2-2-1/P2-2-2 各加断言 |
| **C11 tier-2 保真度（本轮）** | 合并最老两个 checkpoint 的 tier-2 路径也记 `quality` + `summaryChars`，并消费 summarize 留下的 pending 字段（谁生产谁消费）；T2-1 增三条断言。至此**常规 fold / 规则降级 / tier-2 合并**三条压缩路径都有保真度样本 |
| **C12 fold 触发原因（本轮）** | `foldMarks[i].trigger`（pressure / context-overflow / tier2）；doctor 最近 5 次 fold 行内显示，并新增「fold 触发原因」分布（出现 context-overflow ⇒ warn「已被迫自救，压缩没跟上增长」）。测试：溢出自救 / P2-2-1 / T2-1 / P2-2-4 各加断言 |
| **C13 门禁补 ⑫（本轮）** | `handoff-check` 增 ⑫触发原因：分布显示 pressure/context-overflow/tier2；出现 overflow ⇒ warn「压缩没跟上增长」；缺 trigger ⇒「旧版本折叠」warn；无 fold ⇒ ok。`handoff-check` 测试 10/10。live：FAIL 0 / WARN 9（新增的 2 条 ⑥⑫ 均为旧 foldMark 缺字段的「未采集」） |
| **C14 手动压缩记账（本轮）** | `compactNow` 包装 + 公开 `recordFoldMark()` 测试接缝：手动 `/compact` 也写 `foldMark`（trigger="manual"）+ 保真度样本 + summaryChars，并消费 pending 摘要字段。至此 5 类压缩路径（自动/规则降级/tier-2/溢出/手动）全覆盖。engine-harness 47/47 |
| **C15 边界机器审计（本轮）** | `scripts/boundary-audit.mjs`：只扫字符串字面量（剥注释）、两条规则（行为指导 / 工具治理）、`facts-prompt` 摘要指令在 ALLOW 里显式豁免。首跑抓到 2 条真残留并修掉（`continue or abandon` 行动许可、规则摘要标题「与下一步」）。`test/boundary-audit.test.mjs` 5 用例；接入发版验收第 5 步 |
| **C16 重访标记（本轮）** | CURRENT PATH / WORKING 的节点标签带 `×N`（`transpositions` 的符号化，N=总到达次数）；只陈述图结构事实、零成本（无重访逐字节不变）、`# path:` 极压档不标。测试 ledger-boundary M |
| **C17 因果配对（本轮）** | 失败边若被**同一 action 的更晚成功边**解决，行尾标 `↑later-ok:<边id>`（`laterSuccessOf()` 可单测）；只陈述事实、不写建议；live +11 tokens（4/33 命中）、bench 446 不变。测试 ledger-boundary N |
| **C18 重试计数（本轮）** | 失败边同 action 第 k 次失败（k≥2）标 `↻k`，**只在组内最近一条**上标（每条都标 +12 tok，只标最近一条 +1 tok）；bench 基线 446→447、README 同步。ledger-boundary O |
| **C19 收尾（本轮）** | ①补 C14 接线测试（替换桩基类 compactNow 模拟宿主 → 断言 trigger=manual/区间/pending 被消费）；②`package.json`/README 版本 1.16.0 → **1.17.0（未发布）**——修复「改了代码但版本没 bump ⇒ git 源用户永远停在旧 commit」；`check-maintenance` 现只剩 1 项预期失败（1.17.0 无 tag）|
| **C20 fold 成本效率（本轮）** | 三次 live fold 实测：摘要 input/shadowed = **1.43–1.63**（读整个 surface，不是被折叠段）、输出仅 362–3004 ⇒ 瓶颈在「读」。doctor 新增「fold 成本效率」，≥2 判 warn；证据 `evidence/折叠成本-实测-2026-11-02.md`；P2-2-4 增断言 |
| **C21 小窗口 headroom 封顶（本轮）** | 07 调研发现 `headroomTokens=65536` 绝对值在小窗口吃掉阈值：100K 窗口 45%→26.3%、≤73,728 直接抛错（压缩不可用）。`resolveSpec` 改为按 `messageBudget×25%` 封顶（大窗口不变）；engine-harness S4-5。07 调研沉淀 `docs/research/07-trigger-and-budget.md` |
| **C22 巡检第 2 次（本轮）** | 门禁全绿：668 测试 / bench 447 · 8/8 / handoff FAIL 0 / boundary 0 / maintenance 8 通过（1 预期失败=无 tag）/ doctor 0 错 5 警（逐条解释）。修掉 3 处过期文档数字（README 615→668、HANDOFF 634→668、00 §10 补 C18–C21）。证据 `evidence/巡检-第2次-2026-11-02.md` |
| **C23 文档索引门禁（本轮）** | 新增 `docs/research/README.md`（00–07 唯一入口）+ `scripts/docs-index-check.mjs`（除索引外每个 .md 必须登记，否则 exit 1）；补 `evidence/README.md`（新增折叠成本/巡检第2次、bench 446→447、补 3 份漏登记历史证据）；测试 4 用例；接入发版验收第六步 |
| **C24 可寻址闭包（本轮）** | `foldClosureOf(graph, range)`：每次 fold 记「覆盖了哪些节点/边」（计数+首尾 id，不存全量）；三条记账路径（常规/tier-2/手动）都带 `closure`；doctor 最近 5 次 fold 显示 `closure 3n/2e`。测试 fold-closure 4 用例 + P2-2-1/C14/T2-1 断言 |
| **最终验收快照（本轮）** | `evidence/最终验收-2026-11-02.md`：六道门禁全绿 —— 676 测试 / bench 447·8/8 / handoff FAIL 0 / boundary 0 / docs-index 0 / doctor 0 错 5 警（逐条解释）；live 11 会话 / 555 节点 / 672 边 / 自环 0 / 热清单 3543 tok；版本 **1.17.0 未发布**（tag/publish 待授权）；已知缺口：live 真值样本、#9/#11/#17 |
| **收口确认（第 24 轮，2026-11-02 01:10）** | 六道门禁复跑全绿：676 测试 / bench 447·8-8 / handoff FAIL 0 / boundary 0 / docs-index 0 / doctor 0 错 4 警（均为跨日或旧 foldMark 未采集）；版本 1.17.0 未发布，tag/publish 待授权；**本轮无代码改动**（避免收尾引入未验证风险）。剩余：live 真值样本（等真实 fold）、#9/#11/#17 候选、发版授权 |
| **⚠ 用户层 patch 遮蔽（2026-11-02 实机事故）** | 重启后 `chess-context/` 不落盘：`profiles/desktop/cordis.patch.yml`（用户层，最后应用）里的 `preset-standard` 快照写回了 `@deepseek-ai/dsh-compaction-basic`，盖掉了 bundle 层的 engine 覆盖。**已加检测**（`findShadowedUserPresets` + doctor/verify-install 各一项，live 现在准确报 error）；**修复包**在 `home/.gokifu-fix-2026-11-02/`（DSH 完全退出后运行 `apply-fix.cmd`，带备份/原子替换/回滚；幂等）。教训：**verify 只看包内 patch 不够，必须看最后生效的用户层** |
| **✅ 已收口（2026-11-02 02:36）** | 主人重启后引擎由**机器级层**接管：`/gokifu/api` version 1.17.1；`doctor` 0 错误 / 1 警告（用户层遮蔽 = ✓ 已被机器级层接管）；`verify-install` 19/19；`chess-context/sessions/` 恢复写入（`session-8cc34e32…`）。修复包 `home/.gokifu-fix-2026-11-02/` 留作应急（1.17.1 起正常退出会自动登记，不需要它） |
| **C27 机器级层自愈（1.17.1，本轮）** | 插件在**进程退出时**把用户层里被写回 compaction-basic 的 `preset-*` 行原样复制到 `$DSH_HOME/cordis.patch.yml`（宿主最后应用），只换 compaction 成员 → 下次启动接管，**用户零命令**。doctor/verify 三态化（已登记 ✓ / 未登记提示）。测试 `user-patch-heal` 9 用例；离线组装验证 persona 与 22 个成员逐字保留 |
| **⏰ 无人值守约定（2026-11-02）** | 每小时定时任务（`schedule-c0e8f774…`）为**自愈式**：每轮先 `get_goal` —— 空则 `create_goal`（max_goal_rounds=240）、blocked/paused 则 `update_goal resume`、complete 则新建，然后才干活。所以 goal 被系统判受阻不会让循环停摆。硬约束不变：串行全量测试、只 add 自己文件、不重启 DSH、不 push |
| **C28 live fold 证据（1.17.1 后）** | `node scripts/live-folds.mjs` 扫 `foldMarks` 生成 `evidence/live-folds.{json,md}`（只读）。真机 6 次 fold：usage 6/6、trigger 2/6、quality 2/6（其余是老 fold 无字段）、c=1/f=1、压缩比 127–133.8、成本 1.43–1.81、空闭包 2。巡检照它报数，不再手抄 |
| **C29 机器级层漂移观测（1.17.1）** | doctor 新增「机器级层与用户层一致（未漂移）」：`planHomePatch(profile,home).needed` 判副本落后 ⇒ warn（可自愈）；测试 H-10 覆盖「改人设 ⇒ 判漂移、新副本带新人设」 |
| **C30 闭包 preGraph（1.17.1 后）** | `foldClosureOf` 增 `preGraph`/`graphNodes`：区间早于本图（或图空）⇒ preGraph=true（重启续跑的历史不可回查）；`live-folds` 证据页 + `doctor` 保真度 detail 消费；测试 CL-5/CL-6 + live-folds 3 条 |
| **C31 fold 边界完整性（1.17.1 后）** | `foldBoundaryOf` 记 `{overlapping, openAtEnd, unsettled}`，三条记账路径都写 `foldMark.boundary`；doctor 新检查（openAtEnd>0 ⇒ error）；live-folds 证据页加边界行；测试 fold-boundary 4 用例 + harness 断言 |
| **C32 研究收口 + 真实链路 gate（1.17.1 后）** | ① G-2 `derivable` 判**不适用**（离线渲染普查：热清单/摘要指令都不注入工具输出体，无降级落点）→ `evidence/热清单内容普查-2026-11-02.md`；② `real-fold-trigger` 加 `fold-fields` 断言（closure/preGraph/boundary 必须存在且 openAtEnd=0），真机 **6/6** |
| **C33 非破坏合并数据层（1.17.1 后）** | `into.superseded[]`（≤8 条 id/seq/goal/ts/at）+ `supersededCount` + 出边 `retargetedFrom`；`transpositions`/`×N` 渲染不动；doctor 新增「置换合并可追溯」审计（记录指向仍在图里的节点 ⇒ error）；测试 merge-provenance 4 用例 |
| **C34 运行实例版本标记（1.17.1 后）** | engine 启动写 `<chess-context>/build.json`（version/startedAt/pid，原子、失败静默、测试写临时目录）；doctor 新增「运行实例版本」：磁盘更新而进程落后 ⇒ warn「重启后生效」；测试 build-stamp 4 用例 |
| **C35 合同 §6-4 消费者 + 验收清单刷新（1.17.1 后）** | doctor 新增「fold 悬空（dangling）」（fromBroken⇒error / liveUnsettled⇒warn）；live-folds 汇总 dangling；合同 §6 表刷新到 2026-11-02 live 数字并补第 9–13 行。live：3 次 fold、liveUnsettled 0 |
| **C36 handoff-check ① 语义修正（1.17.1 后）** | 空图（0 节点）⇒ ① 记 ok「不适用」，不再当成「缺 rootUserNodeIds」告警；live WARN **9 → 7**；测试 H-11 |
| **C36.1 ⑥ 误报修复（1.17.1）** | 当前路径===工作路径时 ledger 只写 `WORKING:` 行，⑥ 旧判据不认 ⇒ 合法渲染被判 FAIL（live 7520721a 实测）；补 `/^WORKING:/m` + H-12；live handoff-check **FAIL 1→0**、WARN 7 |
| **✅ 重启后自动转绿（03:01 重启）** | `build.json` 已落盘（v1.17.1 / 03:01）、home 层漂移自愈；doctor 只剩「fold 边界完整性」未采集（下次 fold 落 boundary 即转 ✓） |
| **C37 ⑬fold边界门禁 + ①agent-only（1.17.1）** | handoff-check 新增 ⑬：`boundary.openAtEnd>0` ⇒ fail（与 doctor 同口径）；① 区分空图 / agent-only（ok）/ 有 user 漏记 root（warn）/ 缺 ROOT USER（fail）；测试 H-13/H-14；live WARN 8→7 |
| **C38 真空样本告警分层（1.17.1）** | handoff-check ⑩ 真空样本改 ok（detail 标明「非缺陷」）；doctor 保真度在**全部样本真空**时 warn「保真度未被检验」。live handoff WARN **7→5**；测试 H-15 + H-4 改写 |
| **C39 摘要指令 preGraph 提示（1.17.1）** | `buildChessInstruction({preGraph})`：本段早于棋谱时明说「没有节点 id，只按 seq 引用，不许编造 nN」；engine 用 `foldClosureOf(...).preGraph` 传参；测试 facts-prompt 3 用例 |
| **C41 over-budget 归因（1.17.1）** | live 19/263（7.2%）超预算、最大 117 tokens；离线 1/19（574/500）。成因=根目标+约束+最少失败边的下限 > 500。L6（3 条失败+关标记）能把 574 压到 472，但破坏 M2/L5/「诚实超限」三条不变量（bench 447→238）⇒ **否决并入库**；证据页含重新评估阈值 |
| **C42 live 验证 C30/C31（1.17.1）** | 新增 3 次 fold：2 次 preGraph=false（n=156/n=57）、**1 次 preGraph=true**（seq 1022-1487，区间 0 节点）；3 次 boundary.openAtEnd 全 **0** ⇒ doctor「fold 边界完整性」转 ✓；`unsettled` 口径澄清为「未拿到强验证（含 unverified）」并写入合同 §6 |
| **C43 成本口径修正（1.17.1）** | `input/shadowed` 含 host 固定开销（工具/system/保留尾部/旧 checkpoint），单看会误判；新增 `foldCostMetrics`（share 判据 <30%、ratio 仅对照、roi 收益）；doctor 改「fold 成本口径（遮蔽占读入）」；live **47%–74%**、ROI 0.45–0.74 ⇒ 健康 |
| **C44 over-budget 归因指标（1.17.1）** | `renderLedger` 返回 `unyieldingTokens`（根目标+约束，不可裁）；`ledger-budget.json` 新增 `budgetFloorOver`（底线即超预算的次数）；doctor 预算告警追加设计内归因。live 待下次重启后生效；测试 T-4 + 累计规则断言 |
| **C45 图例去行动建议 + 审计规则（1.17.1）** | `MARKER_LEGEND` 8 条全部改事实口径（删 retry when / take it / or create it）；`boundary-audit` 新增 `retry-advice` error 规则（英文行动建议与中文同口径）；markers 测试同步；bench 447 / L5 不变 |
| **C46 UNVERIFIED 去认知指令（1.17.1）** | `treat as unproven` → `unproven`（只陈述状态）；`boundary-audit` 新增 `epistemic-advice`（treat as / you can / make sure to…）；测试 B-6/B-7 + 事实写法不假红 + U-4；B-1 放宽为「至少命中行为指导」 |
| **C47 摘要章节标题去指令（1.17.1）** | `## 已探明死路（逐条保留，一条不许少）` → `## 已探明死路`（facts-prompt 模板 + ruleSummary 两侧一致）；规则已在正文规则段，标题不再长期带指令；真机脚本期望同步；bench 447 / L5 |
| **C48 over-budget 按会话归因（1.17.1）** | `ledger-budget.json` 新增 `overBySession`（前 8 来源）+ doctor 显示「主要来源」；离线归因证明 19.5% 由 `session-d70b7c2f`（649/500，7 条长失败原因）单会话放大，非系统性退化 |
| **C49 over-budget 归因细分（1.17.1）** | 新增 `budgetIrreducible`（已列全失败边仍超 ⇒ 再省必须丢失败记忆，设计内）；doctor 同时显示 floorOver / irreducible；测试覆盖两种形态；证据页追加第 6 节 |
| **C50 live-folds 跨轮趋势（1.17.1）** | `trendOf`：新增 fold / 质量下限变化 / 边界回归 / 成本漂移；`main()` 读上次快照后一起落盘；证据页加「与上次对比」小节；测试 L-6 |
| **C51 图例单行化（1.17.1）** | L2+ 标记图例压成一行（无换行/无 `#   ` 前缀），L0/L1 仍多行；bench **447→446**（基线已更新+注明理由）；「uniform 标记剔除」实验省到 413 但丢语义（全 blocked 会话失去「被什么挡住」）⇒ 否决入库 |
| **C52 同类失败标记汇总（1.17.1）** | L2+ 且失败边 ≥3、完整标记串完全相同时 → 一行 `# all N failures: <key>`，逐行不再重复（图例仍解释键；retry-if 指针因完整串不同而保留）；bench **446→430**；c17 三个夹具预算重定（300→270、330→280，注释写明） |
| **C53 构建标识 buildId（1.17.1）** | `repoBuildId()` = package.json + src 所有 .mjs 内容哈希（12 hex）写入 build.json；doctor 同比较 semver 与 buildId，stale ⇒「运行实例 build X vs 磁盘 Y，重启后生效」；live 现报 `unknown vs 11f699aeab7d`；测试 S-6/S-7；rooms 允许 node:crypto |
| **C54 会话分布 + thrash 进证据（1.17.1）** | `live-folds` 新增 `bySession`（有 fold 会话数 / multiFold≥3 / top3）与 `summary.thrash`；证据页加「会话分布」小节；live 首跑 **12 次 fold / 6 会话 / 2 个 multiFold / thrash 0**；测试 L-7 |
| **C55 研究文档收口（2026-11-02）** | `docs/research/00` §11 重排（候选 8–26 全部归位、去重复行号）+ §11.1 状态快照（731 passed / bench 430 / handoff WARN 4 / doctor 3 警 / verify-install 19-19 / boundary 0 / folds 12-6） |
| **C56 清冗余指针（1.17.1）** | 省略行尾与 UNVERIFIED 计数行的两处冗余指针删除（无损）；bench **430→415**；README/合同文案同步 |
| **C57 超预算离线归因脚本（1.17.1）** | `scripts/overbudget-report.mjs`：逐会话重渲染 + 三态归因（floor / irreducible / reducible?）；live 首跑 23 会话 → within 22 / irreducible 1 / reducible? **0**（无渲染 bug）；测试 3 例 |
| **C58 超预算快照 + 跨轮对比（1.17.1）** | `overbudget-report --out` 写 `evidence/over-budget-snapshot.{json,md}`（含 `trendOverBudget`：构成增删 / 头号来源变化）；首快照 20:02Z：within 22 / irreducible 1 / reducible? 0；测试 C58 |
| **C59 渲染不变量模糊测试（2026-11-02）** | `test/ledger-properties.test.mjs`：10 种子 × 5 预算 = 50 次渲染（31 次 over-budget、覆盖 L3/L5/省略），断言根与约束头段、失败边账目闭合、超限自报、出处覆盖率=1、无绝对路径/无指导、渲染幂等；首跑全绿 |
| **C60 折叠纯函数不变量（2026-11-02）** | `test/fold-properties.test.mjs`：随机图+随机区间，闭包计数=暴力扫描、preGraph 语义、openAtEnd≤overlapping 且全盖为 0、unsettled、保真度召回/unknownIds/压缩比；首跑全绿 |
| **C61 引擎级折叠不变量（2026-11-02）** | `engine-harness` C61：真实 `compactIfNeeded` 后断言失败边/约束一条不少、闭包与暴力重算一致、`openAtEnd=0`、foldMark 字段齐全；顺带记下两个测试坑（idle 才落盘、失败边要落在折叠头） |
| **C62 连续折叠不变量（2026-11-02）** | `engine-harness` C62：三轮真实 fold，断言区间单调（不许重扫已折区域）、失败边只增不减、每次 foldMark 带 quality/closure/boundary；首跑全绿 |
| **C63 修正超预算归因假阳性（1.17.1）** | `renderLedger` 新增 `attemptTokens`；`classifyBudget` 把 `reducible?` 换成 `bug`（所选 > 最省尝试才报）；C59 追加「over-budget ⇒ 所选 = 最省尝试」不变量；live 复核 bug=0（此前 8fe881d1 被误报） |
| **C64 专员审计落地（1.17.1）** | P0：摘要模板「需要时按 seq 回读」→「（seq 可定位）」；P1：删置换告警「别重复」、图例去 retry-if 建议、`safeMeasureFoldQuality` 兜住诊断异常、职责边界改「已修清单」；P2：handoff-check 用 `budgetMax`、overbudget-report 按生产形状渲染（666 而非 641）、doctor 悬空未采集→warn、审计补 `directive-short`/`memory-restore-advice`、文档数字统一 415 |
| **C65 诊断脚本安全默认（1.17.1）** | `live-folds` 默认只打印、`--write` 才落盘（L-8 用例）；`traceRecent` 接入 `traceDropped` 计数并在 doctor 显示；bench 415 不变 |
| **C66 doctor 四项检查补测（2026-11-02）** | `test/doctor-cli.test.mjs`：子进程 + 临时 home 断言 fold 悬空 / 边界完整性 / 置换合并可追溯 / 分项占用四项（含「未采集必须 warn」与「自相矛盾必须 error」）；4 例全绿 |
| **C67 minimal 字段接消费者（1.17.1）** | `minimal` → `minimalRenders` 计数 → doctor 显示「最小清单（无失败边）N 次」；T-5 + engine-harness + doctor-cli 三处断言；**专员审计 12 条全部收口** |
| **C68 发布就绪评估（2026-11-02）** | `docs/发布就绪-2026-11-02.md`：交付物形态 / 能力面 / 七层验证证据 / 「已无优化方向」逐项依据 / 已知缺口与不修理由 / 专员审核结论 / 重启清单（交用户）/ 结论：到达能力上限，唯一待办=重启 |
| **C69 重启后核对脚本（2026-11-02）** | `scripts/post-restart-check.mjs`：buildId/版本/预算归因三态 + doctor 0 错 + boundary 0 条，一条命令给 fail/warn；live 实测 fail 1（缺 buildId）/ warn 1（578 次 over 无归因）⇒ 明确指向「等重启」；测试 3 例 |
| **C70 live fold 逐会话质量快照（2026-11-02）** | `evidence/fold质量-多会话-2026-11-02.md`：6 会话 / 15 次 fold，quality 11 次召回全 1、boundary 7 次 openAtEnd 全 0、closure 11 次可寻址、thrash 0；`session-1286ce28` 的旧 fold 无字段=升级前产物；合同 §6 补 `post-restart-check` |
| **C71 研究文档收口（2026-11-02）** | `docs/research/00` §11 补 27–33、§11.1 刷新（752 passed / folds 15-6 / c=f=1）、新增 §11.2 审计规则演进（C15→C64 五次扩规则的漏网句式与「自审盲区」教训） |
| **C72 真实会话校准（2026-11-02）** | `scripts/ledger-calibration.mjs`：live 24 会话按生产形状渲染 → **p50 419** / p90 521 / max 688 / 超预算 3-24；证明 bench 415 与真实中位一致（此前「未校准」已消除）；证据 `evidence/ledger-calibration.{json,md}`；测试 2 例 |
| **C73 负结论（2026-11-02）** | 试图用 provider `outputTokens` 校准本地 `estimateTokens`：实测比值中位 0.537 但**分母含 reasoning/格式开销**，与摘要正文不同量 ⇒ 指标不落地（脚本已回滚）；正解仍需宿主 tokenizer；判据「分母必须与分子同量」入库 |
| **C74 合同 §6 现状列刷新（2026-11-02）** | 14 行全部按 20:56Z 实测刷新（2293 渲染/583 超、15 次 fold、dangling 11、sections failures 68%、trigger pressure 11/15、closure preGraph 1 true/7 false、boundary 8 次 openAtEnd 0、buildId 缺失=等重启）；表头标明「这是快照，判读看命令」 |
| **C75 模糊测试加固（2026-11-02）** | `ledger-properties` 种子 10→40（50→200 次渲染）+ 断言「必须命中 over-budget / 省略分支」；`fold-properties` 闭包种子 7→20 + 断言「必须覆盖到节点」；防止属性测试退化成恒真 |
| **C76 live 证据补采（2026-11-02）** | 新增第 7 个会话 `634616f8`（第 16 次 fold：pressure、c=1/f=1、closure+boundary 齐全、openAtEnd=0）；live-folds / 逐会话页 / evidence README / research §11.1 四处口径同步（16 次 / 7 会话 / 8 次 boundary 全 0 / 成本 47–76%） |
| **C77 发布就绪文档数字刷新（2026-11-02）** | 749→754 passed、13→16 次 fold / 6→7 会话、成本 47→76%、超预算改双口径（即期 bug=0 + 累计 583/2293）；表头标注「快照，判读看命令」 |
| **C78 交接门禁补 ⑭fold成本（2026-11-02）** | handoff-check 新增 ⑭（遮蔽占读入 <30% ⇒ warn，按最差一次判；无 usage=未采集 ok）；live 本会话「3 次 fold 最低 64% 健康」；测试 H-12/H-13 |
| **C79 交接门禁 ⑮⑯（2026-11-02）** | handoff-check 新增 ⑮fold悬空（fromBroken⇒fail / liveUnsettled⇒warn / residue 不判错）与 ⑯闭包自洽（区间反向或 nodes>graphNodes⇒fail，preGraph 标注）；live 本会话两项皆 ok；测试 H-14/H-15 |
| **C80 合同 §6c：有意不加门禁的字段（2026-11-02）** | route/ms/summaryChars/totalAfter/foldCount 属纯诊断；fallback 属全局趋势；区间由 ⑯ 间接校验；判据「只有存在可判错边界才加门禁」写进合同 |
| **C81 终验收尾（2026-11-02T21:13Z）** | 7 门禁 + verify-install + post-restart + 即期归因一次串行跑完并归档 `evidence/终验-2026-11-02.md`：758 passed / bench 415 无 DRIFT / handoff FAIL 0 WARN 5 / doctor 0 错 3 警 / boundary 0 / verify-install 19-19 / post-restart **fail 1**（旧进程，等重启）/ 即期 bug 0 |
| **C82 打包可复现性检查（2026-11-02）** | `scripts/pack-check.mjs`：npm pack 文件必须全部 ⊆ `git ls-files` + 关键文件齐全；坑：`git ls-files` 默认转义中文路径（需 `-c core.quotePath=false`），否则 57 个中文文档假红；实测包内 121 文件、无出处 0；测试 3 例 |
| **C83 CLI 路由测试（2026-11-02）** | `test/cli-routing.test.mjs`：转发目标必须存在、每个 command 必须写进用法、bin 存在且分派 doctor、files 白名单含 bin 目录；子进程验证未知命令非 0 + `--help` 为 0；4 例全绿 |
| **C84 安装产物生成器补测（2026-11-02）** | `make-presets-override` 此前零测试：新增 3 例（dry-run 不改文件/不留备份且自检通过、两次输出逐字相同、仓库 patch 覆盖四 preset 且无 compaction-basic） |
| **C85 bench 默认不写盘（2026-11-02）** | `test/bench.mjs` 写证据改为显式 `--write`；档位打进 stdout 摘要行，`bench-repro` 改为解析 stdout（旧写法依赖证据文件会过期）；门禁跑完工作树不再变脏；测试 3 例 |
| **C86 用户文档命令校验（2026-11-02）** | `test/docs-commands.test.mjs`：README/QUICKSTART 里 `node scripts|test/X.mjs` 必须存在、`npx` 子命令必须被 cli 分派；体检结果 0 腐坏（历史计划文档有意排除，理由写进测试头） |
| **C87 patch↔包名一致性（2026-11-02）** | `test/patch-manifest.test.mjs`：引擎行 = `<pkg>/engine` × 4、四个 preset 覆盖块齐全、insert 用同一包名、无 compaction-basic 配置行；踩坑：头部注释含该词，判据只查 YAML 行 |
| **C88 回滚路径补测 + 字典序 bug（2026-11-02）** | revert 此前零测试；补 5 例并修真 bug：备份名 `…-999` 字典序排在 `…-1000` 后 ⇒ 回滚会挑旧备份；改为按尾部数字排序，「999 vs 1000 选 1000」用例在旧实现上必红 |
| **C89 安装第①步补测（2026-11-02）** | `patchProfileForUi`/`removeManualUiRow` 此前零测试：5 例（无文件不乱建 / dry-run 不落盘 / 真跑留备份且幂等 / 删除留备份 / 结构不认识拒绝改）；全绿=实现正确 |
| **C90 注入渲染失败可观测（2026-11-02）** | `injectionErrorDelta` + engine 计数 `ledgerBudget.renderErrors` + doctor「注入渲染失败 N 次」；hot-inject 真实降级用例（缺 rootUserNodeIds 才真抛）；测试四态 + doctor 显示 |
| **C91 注入跳过原因分布（2026-11-02）** | `skipReasonKey` + `bumpSkipReason`（有界 8 键，超出归 other）+ `ledgerBudget.skipReasons`（每 20 次落盘）+ doctor「跳过分布」前 3 名；测试 6 条 + doctor 显示 |
| **C92 最近访问文件解析器健壮性（2026-11-02）** | 正则元字符/引号/空格/截断/空值 14 种形状：永不抛、返回值必是输入子串（禁止猜）、元字符路径精确；3 组全绿（无 bug） |
| **C93 索引端点指纹（2026-11-02）** | `endpointNumber`：非 `n<数字>` 的 id 不再退化成 0（`node42`⇒42，无数字⇒字符串指纹）；2 例（稳定性/区分度 + 端点变化后必须重建）；记下「快路径靠 cheapKey，改结构必须 bump 版本」的设计约定 |
| **C94 第三方 preset 压缩边界（2026-11-02）** | 发现 `dsh-design-studio:preset-design` 自带 compaction-basic（设计模式不走棋谱压缩）；doctor 新增「第三方 preset 的压缩后端」检查（warn 点名，不强行覆盖）；坑：preset 行缩进，`^- id:` 漏扫 ⇒ 改 `^\s*- id:` |
| **C95 preset 覆盖唯一性（2026-11-02）** | doctor 新增检查：同一 preset 被 ≥2 个 bundle 覆盖 ⇒ warn 点名（后写者整体接管、压缩后端可能被静默顶掉）；live 实测 5 个 preset 各单 owner、扫 12 个 patch；测试 C95 |
| **C96 insert id 唯一性（2026-11-02）** | doctor 新增检查：insert 行按 id 建索引，撞到本插件 `gokifu-ui` ⇒ **error**（设置页/API 会消失），别人之间撞 ⇒ warn；live 实测 16 个 id 各单 owner、扫 12 个 patch；测试三态 |
| **C97 README 排查入口（2026-11-02）** | 常见问题补三条（第三方 preset 不走棋谱压缩 / insert id 撞车导致页面消失 / 运行实例版本不一致需重启），并写进 doctor 检查名；C97-1 断言 README 点名的检查在 doctor.mjs 真实存在 |
| **C98 QUICKSTART 排查补齐（2026-11-02）** | §四 补三条（第三方 preset 不走棋谱压缩 / insert id 撞车导致页面消失 / 运行实例版本不一致需重启）+ `post-restart-check` 入口；C98-1 断言新手文档必含这三处 |
| **C99 QUICKSTART 项数过期（2026-11-02）** | 「18 项/18-18」实际已 19 项：改为不写死项数 + 保留「哪一项可能短红」；C99-1 禁止 QUICKSTART 出现写死项数 |
| **C100 文档数字锚判据（2026-11-02）** | `docs-numbers`：文档「boundary-audit N 条规则」= `RULES.length`、bench「N tokens」= `EXPECTED_TOKENS`；立刻抓到文档写 5 条、实际 **6** 条（已改正）；两条判据都要求至少命中一次 |
| **C101 数字锚再补两根（2026-11-02）** | 文档「fold 间隔 < N 事件」= `THRASH_SEQ`(30)、`hotLedgerMaxTokens` 数值 = schema 默认(500)；两处都正确 => 由「碰巧对」变「有人看守」；记下「别在正则里塞换行，用 split(fromCharCode(10))」 |
| **C102 live 证据补采（2026-11-02）** | 新增 2 次 fold（8cc34e32 seq 2171–3166；本会话 seq 7930–9799 = 当前摘要来源）：总数 18 / 7 会话、quality 14 次召回全 1、boundary 11 次全 0、thrash 0；四处口径同步 |
| **C103 闭包链检查（2026-11-02）** | live 出现「fold 区间重叠」（1e82afca 7272–8862 vs 上轮 4876–8547）→ 查清是 checkpoint 节点 seq 回落，**节点集不重叠**；新增 `closureChainOf` + live-folds「闭包链」节（18 次 fold / 5 对 / 节点级重叠 0），把「区间 vs 节点集」分开 |
| **C104 越界引用探针（2026-11-02）** | `findOutOfRangeIds`：id 存在但不在本次折叠区间 ⇒ 出界（幻觉探针抓不到的一类）；`measureFoldQuality.outOfRangeIds`、handoff ⑪ 合并两路、doctor 新增一行；测试 Q-8 + H-16；实现坑：`` 被脚本写坏成控制字符 ⇒ 改「不依赖转义」的匹配 |
| **C105 合并 id 不再算幻觉（2026-11-02）** | 置换合并会把被吞节点从 nodes 删除、只留 `superseded[]`；`findUnknownIds` 曾把它判成编造 id（假红）。已把合并历史纳入已知集合；越界探针不重复报；测试 Q-9；live 当前无合并 ⇒ 不改变现有数字 |
| **C106 合并 vs 闭包自洽（2026-11-02）** | 查证 ⑯ 用的是折叠当时的 `closure.graphNodes`（非当前图）⇒ 后续合并缩图不会假红；加回归 H-17（历史闭包不误判 / 真坏数据仍 fail）；无 bug |
| **C107 否决 #17 derivable（2026-11-02）** | 理由：认知指令（epistemic-advice 已禁）/ 需先判定「可推导」/ 收益微小；research §11.3 新增「已否决候选」表；顺带修正 §11.2 规则数（基线 2 + 新增 4 = 6）；facts-prompt 新增 C107 守住「故意的冗余」 |
| **C108 折叠路径记账静态审计（2026-11-02）** | `fold-mark-sites`：静态读 engine.mjs，所有 `foldMarks.push` 与 `recordFoldMark` 必须带 quality/trigger/closure（简写键也认）；防「新增路径漏记 ⇒ doctor 未采集」；坑：正则 `\s` 被脚本吃掉，改无转义字符类 |
| **C109 预算统计必须落盘（2026-11-02）** | `ledger-budget-persist`：每个 `ledgerBudget.X =` 赋值 15 行内必须 `#persistLedgerBudget()`（节流须写注释）；落盘走 `persist.persistBudget` 单一入口；C109-3 用合成片段验证判据本身不作假 |
| **C110 节点文档一致性（2026-11-02）** | 缺 `nodes/<id>.md` = 热清单省略行空指针 ⇒ doctor 新增检查（缺 warn / 陈旧仅计数）；live 24 会话：缺 0、陈旧 94；纯函数 `node-docs.mjs` + 2 例 + doctor-cli 1 例；夹具陷阱：makeHome 默认会话也要补 |
| **C111 陈旧 md 自愈（2026-11-02）** | 94 个陈旧 `nodes/*.md` 全部紧邻 maxNode = 「写了又回滚」残骸；`tree` 落盘时删掉「不在图里」的 `n<数字>.md`（其它文件不碰、失败静默）；测试 C111 + **C111-2 假 port 接口必须与 createFsPort 一致**（缺 readdirSync 会被 catch 吞掉） |
| **C112 回滚后 tree 落盘（2026-11-02）** | 三处 restore() 后的 flush 从非 tree 改为 tree:true：index.md 不会停在回滚前、nodes/*.md 当场自愈（94 残骸的根因）；静态 C112 + 行为 C112（删节点后索引必须同步） |
| **C113 回滚清 dirty（2026-11-02）** | 裸 `Object.assign(g, fromJSON(snap))` 回滚会留下失败尝试的 `delNodes` ⇒ 下一个 delta 帧落盘后，load 回放把已恢复节点再删一遍；新增 `restoreFromSnapshot`（图+dirty 一起回到快照）+ 静态禁用裸 assign；测试 C113-1（记录 bug）/C113-2（修复语义） |
| **C114 端到端验收 + 不变量表（2026-11-02）** | C113 补端到端：基线落盘→合并→回滚→落盘→load，两节点都在；新增 `docs/落盘与回滚不变量.md`（6 条不变量 + 允许现象 + 改动检查清单） |
| **C115 live 第 19 次 fold（2026-11-02）** | 本会话 seq 9802–11525（pressure，c=1/f=1，openAtEnd 0）= 当前摘要来源；总数 19 / 7 会话、quality 15、boundary 12 全 0、闭包链 6 对无节点重叠；四处口径同步 |
| **C116 docs 根索引（2026-11-02）** | 新增 `docs/README.md`（24 份文档按现状/历史分组 + 判读顺序）；`docs-index-check` 覆盖 docs 根 ⇒ 未索引 0；以后新文档不登记会红 |
| **C117 测试数锚（2026-11-02）** | 修正现行文档两处过期测试数（743/754 → 824），统一写成「当次输出 + 时间戳」；docs-numbers 新增 C117：现行文档任何 `N passed` 必须同时带时间戳与「当次输出」提示 |
| **C118 证据数字一致性（2026-11-02）** | `evidence-consistency`：从 `live-folds.json` 重算总数/会话数/quality 数/压缩比/成本/thrash，断言 README 与 research §11.1 出现同口径字符串；逐会话表与 bySession 一致、openAtEnd 和为 0；措辞容错、数字不饶 |
| **C119 证据文件陈旧（2026-11-02）** | `bench-2000.json` 还写着 447（文档/基线全写 415）—— C85 改成不写盘后没人刷新；已 `--write` 刷成 415/L5；新增 C119-1（证据==基线）与 C119-2（校准 p50/p90/min/max/超预算==README 行） |
| **C120 证据双向可发现性（2026-11-02）** | C120-1 每个 evidence 文件主干必须在 README（允许 `X.*`）/ C120-2 README 点名文件必须存在 / C120-3 现行文档 `evidence/xxx` 引用必须存在；体检 39 文件 0 孤儿、27 引用 0 悬空 |
| **C121 调研文死链（2026-11-02）** | `压缩质量盘点` 指向不存在的 `04-compression-evaluation.md`（实际是 01-academic / 02-product）已修正；新增 C121：现行文档 + research 内对 `docs/research/NN-*.md` 的引用必须存在（只查调研文，历史引用不误报） |
| **C122 可引用数字表 446→415（2026-11-02）** | `06-可引用数字表.md` 的热清单行停在 446（旧 351），现 415；已更正并补口径演进；新增 C122：按 `bench-repro` 来源行定位校验 token 数（不能用 C100-2，会把外部 185/2.6K 误报） |
| **C123 数字表算术自洽（2026-11-02）** | 06 表两条纯算术判据：三次采样均值必须 == 文中 6.67、804/10419 必须 ≈ 1/13；坑：`(\d+)/8` 会吃掉 `6.67/8` 的 67，改为按「三次采样：」字段定位 |
| ⚠ 并行会话警告 | 同一工作树存在**另一个会话**在并发提交（见上方提交列表，`262c92d` 曾把本会话未跟踪的 `touched-files.mjs` 扫进它的提交）。**提交前必须 `git log` + `git status` 核对；只用显式 `git add <文件>`，禁用 `git add -A`** |
| 下一轮候选 | ① 压缩质量评估 L1（`constraintRecall`/`failureRecall`/`compressionRatio`，零模型调用，见 `docs/压缩质量-现有观测盘点与缺口.md` §4）；② `foldRange{fromSeq,toSeq,reason}` 显式 forgotten 边界（改 graph schema，**需契约先行**）；③ fold-planner 预算两档动态化（纯函数）；④ `superseded_by` 标注（不删边）；⑤ 可寻址闭包（压缩块 → 原始 seq 闭包） |

## 🆕 2026-11-01 21:50 · 1.16.0（已发布 → 历史）

| 项 | 值 |
|---|---|
| 版本 | **1.16.0** —— **已发布**（2026-11-01 22:07 UTC+8）：npm `latest` = 1.16.0、tag `v1.16.0`、GitHub Release（draft=false）；`verify-release --tag=v1.16.0` 校验「发布物 == tag 那棵树」通过 |
| 单测 | **615 passed / 0 skipped / 0 failed**（`node test/run.mjs`，**必须串行**；并发跑会共用 `test/.harness/graphs`，出现 T2-5 之类假红） |
| 架构 | **bundle patch 按 id 整体覆盖四个官方 agent preset 的 `config`**：把 `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine`。标准 / PTC / 极简 / 创造四个模式**全部**走棋谱压缩；**不新增 preset、不改 `agent-preset-registry` 默认 preset** |
| 生成器 | `node scripts/make-presets-override.mjs [--write]` —— 读宿主 asar 里的官方 preset，**文本级**改写（官方文件里的 `!!js` 表达式绝不能被 YAML round-trip）。DSH 升级后重跑再发版 |
| 已否决 | **运行时接管方案（R17）**：`src/rooms/takeover.mjs` + `installTakeover` 会让 preset 生成树挂载失败（重启后会话只剩宿主级工具，`bash`/`read`/`write` 全消失）。代码在 `git stash`：`wip:R17-takeover（事故，留档）`，**不要恢复** |
| 隔离验证（真跑过） | ① `--dump-config` 四个 `- id: preset-*` 行都带 `dsh-gokifu-compact/engine`；② `agentPreset: "standard"` 会话里**工具齐全**（模型成功调用工具并拿到输出）；③ `<home>/chess-context/sessions/<id>/graph.json` 落盘（含 user/agent 节点与带 verify 的边）；④ 卸载后 `--dump-config` 里引擎行归零、四个 preset 内部 `compaction-basic` 全部回来 |
| 桌面 live | **21:51 重启后已加载新 patch**：`doctor` 全绿（错误 0 / 警告 0）、`verify-install` 18/18；本会话 `session-1286ce28` 的 preset 投影 = **`standard`**，且 assistant 消息里有 **3 条含 `<chess-ledger>`**、ledger 里带 failed 边 → **标准模式在 live 上确实由 GOkifu 引擎压缩** |
| 已验（live） | ① preset 投影 = standard；② 热清单注入 3 次；③ 失败边进 ledger；④ `doctor` 0 错 0 警、`verify-install` 18/18 |
| 已验（隔离实例 · 真实 fold） | 给引擎行加小阈值（thresholdRatio .004 / firstFoldRatio .002 / retainRatio .001 / minFoldTokens 200）后连发三条长 prompt：会话日志 `compaction/start → compaction/summary → compaction/end`，graph 写入 `foldMarks: [{seqStart:8, seqEnd:9, shadowedTokens:8093, totalAfter:9844, foldCount:1, ms:7476, usage:{in:16595,out:934}}]` ⇒ **压缩确实走 GOkifu 棋谱摘要** |
| 已验（官方安装流程） | 干净 profile（只含 base + web-app）跑 `dsh plugin --profile installprobe add D:/主工作区/repos/dsh-GOkifu-compact`：① 依赖自动写入（link）；② **`dsh.profile.bundles` 自动追加 `dsh-gokifu-compact`**；③ `--dump-config` 显示四个 `- id: preset-*` 行各带 `dsh-gokifu-compact/engine`、外加 `gokifu-ui` 行 ⇒ GUI 插件市场点「安装」走的是同一条通道 |
| 未验证 | 1.15.x 旧会话 header 里 `agentPreset: "gokifu"` 在移除 preset-gokifu 后的恢复行为 —— 升级前扫一遍会话日志（脚本在 Hindsight `1.16.0 升级前必查`） |


> 2026-11-01 · 给下一个会话
> **先读这一页，再读 `docs/最终报告.md`。不要重新推导。**
> 当前版本 **1.14.0**（**未发布**：无 tag、无 npm 发布 —— 本轮主人只授权推 GitHub）；单测 **613 / 0 skipped / 0 failed**（**54 个测试文件**）。
> **⚠ 桌面 live 里本插件一个版本都没装**（11-01 14:15 重建的新 home）—— 不是「停在旧版本」，是「0 个版本」。
> 装回去：清单已过闸（1.12.0）→ `dsh plugin add`（官方通道，成功后会**自动**把包追加进 bundles）→
> `make-preset` 生成 preset bundle 并同样 `dsh plugin add` → **在会话里选中该 preset** → 重启验证。详见「新版 DSH 适配」。

## ⚠ 最新状态（2026-11-01 · 1.14.0 · 未发布）

| 项 | 值 |
|---|---|
| 版本 | **1.14.0**（`package.json` = `README:3` = `CHANGELOG 有 ## 1.14.0`） |
| tag / npm | **都没有** —— 本版只存在于工作树；`npm latest` 仍是 **1.11.17**。**本轮主人只授权 push 到 GitHub（main + tag），不 npm publish** |
| 单测 | **613 passed / 0 skipped / 0 failed**（**54 个测试文件**；1.13.0 是 597/0/0、52 文件）· `ui` **75/0** · `ui-models` 7/0 · `ui-layout` 9/0 · `engine-harness` 43/0 · `ledger` 20/0 · `c17` 15/0 |
| 本轮（1.14.0）改了什么 | ① **模型目录**：`inject` 加 `llm`、新增 `models` 动作（只读宿主目录、不存凭据）② **页面改版**：宽屏双栏 + 滚动容器 P0 修复 + 焦点环 + 两级模型下拉 ③ 两件欠账收口：`thresholdRatio` **事实更正（不改数值）**、**手动压缩按钮「不做」** |
| `check-maintenance` | **8 通过 / 0 警告 / 1 失败** —— 唯一失败是「当前版本 1.14.0 有 tag」，属**发版步骤未执行** |
| **桌面 live** | **0 个版本**：`profiles/desktop/package.json` 无本包依赖、`dsh.profile.bundles` 无本包、`<home>/chess-context` 不存在。1.9–1.14 的收益**一条都没生效** |
| 下一步（唯一档停的事） | **装到 live** —— 需**停机窗口 + 主人授权 + 主人重启**；四步见下方「新版 DSH 适配」。**不要手改 `package.json` 加 `link:`**（那正是历史上丢插件的机制） |

> 其余仍未做：**`README:3` / 本文件版本号都没有门禁**（`check-maintenance` 不读它们）。
> ~~**M2/M3**（UI 暂停中）~~ ⇒ **UI 已于 1.14.0 解冻并改版**（见下方「UI」节）；其中 **外部 API 通道按主人裁定不做**
> （插件不存凭据、不接外部 API，用户去 DSH 加供应商 ⇒ 下拉自动出现）。
> ~~**tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）~~
> ⇒ **1.13.0 已做，但结论要改口径**：热清单定价改成 **CJK 感知 + ASCII 侧对齐宿主 `CHARS_PER_TOKEN=4`**
> （**没有**改成接 `ctx.tokenMeter`）—— 因为 `ctx.tokenMeter.measure(session)` 早就接好了
> （`engine.mjs` 的会话压力 / fold 阈值），它吃的是 **session surface**；而热清单是一段**自造文本**，套不上 measure。
> 详见 `CHANGELOG` 的 `## 1.13.0` / W-A 与 `src/rooms/ledger.mjs` 的定价注释。

### 已了结的旧账（2026-11-01 复核，别再当待办）

- **P6-C 真实 apply 已经执行了**（旧版本文件写「仍未执行」，是错的）：`D:\主工作区\tmp\dsh-gokifu-compact\LIVE-APPLY-2026-10-31T14-20-18-959Z.log`
  → preflight **exit 0**（176 会话 / 30,341,323 B）→ dry-run → `--apply` → `migrate verify … "ok": true`、
  **`archived=6219 deleted=6219 sessions=48`**、`[exit 0]`（2026-10-31 22:20 本地）。整目录备份在
  `D:\主工作区\tmp\dsh-gokifu-compact\live-apply-backup-2026-10-31T14-20-18-959Z\`。
  **没做完的是「重启后读日志验收」** —— 而 11-01 的 home 重建让那一步**永久不可复现**。
- **S1b（清理 2 张历史自环图）可关**：对上述归档快照实测 `test/rewash-selfloop.mjs` dry-run
  = **176 个 graph.json / 0 个含自环 / 全库自环 0 / 37,194 = 0.0%**（点名的两张图仍在，但已无自环）。

## 新版 DSH 适配（0.2.1-rc.5）—— 装回去之前必读

> 完整方案（逐行源码实测）：`E:\Documents\deepseek-harness\default-workspace\gokifu-2026-11-01\compat-deploy.md`。
> 本节只留结论与顺序，别整段抄。

**三道版本闸（缺一不可，全在宿主 `dsh-app-boot` 里）**

| # | 时机 | 不满足的后果 |
|---|---|---|
| ① | 安装前 `installBundle` 的兼容性检查 | **直接拒装**（`incompatible-version`），pnpm 都没跑 |
| ② | 启动：bundle 层 `evaluatePluginCompatibility` | **整层 patch 静默跳过**（源码注释原话 "nothing is printed"）⇒ UI 行也不会被插入 |
| ③ | 启动：行级 `preflight()` | 该行被 `disabled`，往 stderr 打一行 |

②③ 只认 profile 自己的豁免文件 `$DSH_HOME/profiles/<p>/compatibility.json`（键必须是精确 `name@version`，
**插件升级与 DSH 升级都不继承**）。

**本版已把闸门改成「说真话」**：4 个 `@deepseek-ai/dsh-*` peer `0.2.0-rc.2` → `^0.2.0-rc.2`（**条目一条都没删** ——
peer 表同时是模块解析路由表），并补 `engines.dsh`。⚠ 这套 range 能过闸**依赖宿主继续传
`{ includePrerelease: true }`**（实测见 CHANGELOG 1.12.0 的 F1 节）。

**四步装回（停机窗口里按序做，任一步失败就停在原状）**

1. **过闸** —— 1.12.0 已把清单改好（4 个 dsh peer 改范围 + 补 `engines.dsh`），正常情况无需豁免；
   若要用旧包，走官方 `dsh plugin --profile desktop allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。
2. **装 bundle —— `dsh plugin add` 就是官方 install 通道**
   ```bash
   dsh plugin --profile desktop add "D:\主工作区\repos\dsh-GOkifu-compact"
   ```
   **机制更正（1.13.0 实测，别再按旧笔记走 Web 页面）**：`dsh plugin add` **不只是转发 pnpm** ——
   成功后它会调 `reconcile()`（`dsh-plugin-manager/lib/types/operations.js:96-124`），把「本次新增的依赖
   且其 `package.json` 声明了 `dsh.bundle`」**自动追加进 `dsh.profile.bundles`**。
   ⇒ **CLI 通道 = 官方 install_bundle 的等价物**，不需要 Web 页面，**更不能手改 profile 加 `link:`**
   （手改正是历史上丢插件的机制）。
   **不要**用插件自带的 `node scripts/cli.mjs install`（读已不存在的 `preset-bundles/`、手写 UI 行会与 bundle 通道双挂载）。
3. **生成并装 preset 的引擎行（C 段 · 1.13.0 的正式解法）**
   ```bash
   # 默认就是 dry-run；生成时别把 DSH_HOME 指向目标 home（否则「不许写进运行中 home」的守卫会拒，退出码 2）
   env -u DSH_HOME node scripts/make-preset.mjs
   env -u DSH_HOME node scripts/make-preset.mjs --write --out "<repo>/tmp/preset-bundle"
   dsh plugin --profile desktop add "<repo>/tmp/preset-bundle"     # 同样会被 reconcile 选进 bundles
   ```
   - 它从**当前宿主 asar** 读官方 `dsh-web-app/presets/standard.patch.yml`，**只**把 compaction group 里的
     `- id: compaction-basic` 换成 `- id: gokifu-compact / name: 'dsh-gokifu-compact/engine'`，
     **其余 32 条插件行逐字保留** ⇒ DSH 升级后**重跑一次**即可，不会像手抄那样把插件清单冻成快照、静默丢新版新增行。
   - 引擎**不能**放在 profile/bundle 级 patch，必须在 preset 的 compaction group 里；`command-compact` 与
     `tool-result-pruner` 两行**保留**。
4. **在会话里选中该 preset** —— **机制（1.13.0 实测）：preset 插件是惰性激活的**：不选该 preset 的会话
   **不会 mount `config.plugins`**。⇒「装完没反应」最常见的原因是**没选 preset**，不是装坏了。
   选完 → 重启 → 跑 `node test/verify-install.mjs`（preset 那 5 项应从 `!` 转绿）+ `node scripts/doctor.mjs` 验。

**两条硬教训（都有磁盘证据，别再踩）**

1. **「安装态与 preset 必须同源」，而手加的 `link:` 会被插件管理器抹掉**：2026-10-31 22:02:22 DSH 插件管理器重写
   `profile/package.json` 时是**按自己的托管清单重建**，把插件 `cli.mjs install` 手加的 `link:` 依赖与 bundle 项一起丢了
   （现场备份 `D:\主工作区\.trash\2026-10-31\live-profile-before-gokifu-reinstall\package.json`），而 preset 还指着它
   ⇒ 所有相关 resume 报 `gokifu-compact (dsh-gokifu-compact): never started (gateway/internal)`。
   **⇒ 必须走官方通道装，不要只手改 package.json。**
2. **引擎名必须写 `dsh-gokifu-compact/engine`**，不能写包根：包根 `exports["."]` → `src/ui.mjs` 是 UI host，
   DSH 会把 UI host 当压缩引擎，**装回去了照样挂**。

> 其它陷阱：桌面 `gokifu-停窗减枝.cmd` 必须是 **GBK(CP936) + CRLF**（1306 B / 39 CRLF / 无 BOM）；
> UTF-8 编辑器保存会让它静默失效。`live` 若用 `link:` 指向工作树，则**工作树里任何未提交改动重启后都会被直接加载**。
>
> **⚠ 启动器（1.13.0 发现并已修）**：`D:\DeepSeek Harness\启动 DSH.cmd` **原本是坏的** —— 两处路径写
> `%~dp0DeepSeek Harness Desktop\`，而实际目录名是 `Desktop\`（连它的 `.bak-20261101` 备份也是同一处错
> ⇒ **升级后就一直断**）。已改成 `%~dp0Desktop\`、重写为 CRLF/无 BOM，并逐条验证引用的 3 个路径都存在。
> **为什么这条重要**：「重启 DSH」正是装回插件的第 2 步 —— 启动器坏了会被误判成**「插件把宿主搞崩」**。

## 测试用 DSH 实例（W-C · 1.13.0 建成，这是本轮最重要的能力）

> 目的：以后**任何**「装回去到底行不行」的验证，都在这个**独立实例**上做，不再拿生产 home 冒险。
> 细节与逐条证据：`E:\Documents\deepseek-harness\default-workspace\gokifu-2026-11-01\test-instance.md`。

| 项 | 值 |
|---|---|
| 测试 home | **`E:\Documents\deepseek-harness\dsh-test-home`**（独立 `DSH_HOME`，与生产 `D:\DeepSeek Harness\home` 完全隔离） |
| 端口 | **62619**（生产是 62618）⇒ 两个实例可同时跑 |
| profile | `web`（自动创建），已装 `dsh-gokifu-compact` + 自建 preset bundle，二者都在 `dsh.profile.bundles` 里 |
| 起停 | 起：`dsh --profile web --host 127.0.0.1 --port 62619 --no-open`；停：`netstat -ano \| grep LISTENING \| grep :62619` 拿 PID 后 `taskkill //PID <PID> //T //F` |
| 复现命令序 | `test-instance.md` §7（一条条可照抄） |
| 副产物 | `E:\.pnpm-store`（官方 `dsh plugin add` **自己选的** pnpm store，74 MB，不要时 `rm -rf /e/.pnpm-store`） |

**已验证到哪一段（A→B→C→引擎加载）**

- **A 过闸 PASS**；
- **B 官方通道** `dsh plugin add` 装 bundle：软链 + **自动选进 `dsh.profile.bundles`** + `--dump-config` 里出现
  本包 patch 插的 `- id: gokifu-ui` ⇒ bundle 层**没有被版本闸静默跳过**；
- **C preset**：`make-preset.mjs` dry-run 看到「32 条插件行逐字保留 / 仅 compaction 组 2 行不同」→ `--write` →
  同一个 `dsh plugin add` 装进 profile（两个 bundle 都在 bundles 里）；
- **引擎真的加载**（三层证据）：① 组合树里引擎行与探针行都在、无 `disabled`；② `--dump-config-schema` 里该行
  `status:"schema"` 且 `$defs` 是本插件 `config-schema.mjs` 生成的**带中文 description 的 Config**（说明模块真被 import）；
  ③ 同 realm `inject:["compaction"]` 探针被激活，写出
  `{"hasService":true,"constructorName":"ChessCompactionEngine","hooks":{summarize/compactIfNeeded/compactNow/compactRegion 全 function}}`。
  旁证：`POST http://127.0.0.1:62619/gokifu/api {"action":"health"}` → **HTTP 200** + 插件自己的 JSON。

**还差什么（诚实写）**：「**会话选中 preset → 引擎实例化 → 真压一轮**」**没验** —— 测试 home 没配模型路由，
也没有擅自把生产 magpie 接过去。所以准确说法是：**「引擎行被加载、实例化、注册服务」已实测；
「引擎接管压缩并产出棋谱」未实测。**

## UI（1.14.0 解冻后改版）

> 背景：主人 2026-10-30 说「UI 先放下」（*没人用的插件不需要 UI*），本版**解冻**。立场仍然是「只读宿主」——
> 见下面的架构定调。

**架构定调（主人拍板，以后别再自己发挥）**

1. **插件不自己存凭据、不自己接外部 API**。用户要用外部 API，**去 DSH 里加供应商**；
   插件页面的摘要模型下拉从**宿主已注册的模型目录**里自动长出来。
   ⇒ M3（插件私有 secrets / `external-summary` 模块 / 外部 API 面板）**不做**。
2. **插件页不是会话级的** ⇒ 拿不到 agent / 会话状态 ⇒ 任何「当前能否压缩」的实时判断都做不出可信结论（见「不做」节）。

**改了什么**

| 面 | 改动 |
|---|---|
| 模型目录（U1） | `inject` → `["webServer","llm"]`；新增纯函数 `modelCatalog(llm)`；新增 `{"action":"models"}`，且 `state` 响应同时带 `models`。**只读** `listProviders()` / `listModels()` / `resolveModelInfo()`；任何失败降级不抛（单 provider 挂只跳过） |
| 页面（U2） | 宽屏双栏（≥1280px，`maxWidth 1600px` 居中，窄屏回单栏）；**滚动容器 P0 修复**（`height:100%` / `minHeight:0` / `boxSizing` / `overflowY:auto`）；**焦点环**（全部交互元素经 `focusable()` + onFocus/onBlur）；**摘要模型两级下拉**（provider → model，`<optgroup>`，目录为空降级自由文本） |
| 页面（U4 收尾） | 窄屏断点 600（600−56 padding=544，扣 220 控件 + 120 默认值列只剩 ~200 给中文 label 会折行）；长模型名/长 id 加 `title`；标题行显示当前 profile；`SPACING={section:16,card:8,inline:12,micro:4}` 把 18/20/26/10/2 收敛成 **4px 网格** |
| 窗口 | **去掉硬编码的 1000000**：按选中模型的 `contextWindow`；拿不到显示 `—` 并隐藏进度条 |

**三个宿主 API 事实（省一次考古）**：服务名就是 **`"llm"`**；`listProviders()` 返回 **`[{ id, name }]`**；
**`listModels()` 里没有窗口字段** —— 窗口只能逐模型问 `resolveModelInfo(provider, model).context.contextWindow`。
⇒ 首屏要为每个模型问一次，所以每次宿主调用有 **4 秒时间预算**（`CATALOG_CALL_TIMEOUT_MS = 4000`），
超时按「拿不到」降级 —— `dsh-llm-deepseek` 的 `listModels()` 背后是 `discoverModels?.()`，**可能走网络**，
**页面宁可少一个下拉项，也不许卡住首屏**。

**`thresholdRatio` 的事实更正（本版不改数值）**：主人被问「0.6 要不要降到 0.5」答「降到 0.5」，但
**插件的默认值本来就是 0.45**（`config-schema.mjs` 与 `install.mjs` 的 `engineBlock()` 模板都是 0.45）；
仓库里唯一的 `0.6` 是**升级前的 profile 级 override**（`cordis.patch.yml:489`），已随旧 home 消失。
⇒ **0.45 已经比 0.5 更早触发**，符合主人「更早压」的意图 ⇒ **不改**。事实已追加进
`docs/P0-worldhash-死循环-根因与修复方案.md` 的 P1 节（**原文一字未删**）。

**测试**：`ui-models` **7/0**、`ui-layout` **9/0**、`ui` 切片 **75/0/0**（基线 59）。
**未验证**：真实浏览器里的目视效果（1280 / 599 视口）没看过；4 秒预算只在夹具里模拟过卡住；
窗口查询**无缓存**（模型多的 provider 会慢，延迟未测）。

## 不做（有理由，别再问「为什么没做」）

1. **手动压缩按钮 / 禁用态** —— **历史欠账第 8 条已解释关闭**（考古报告 `考古-2026-11-01/04-GOkifu/10-未完成事项.md` §8）。
   实测宿主 `dsh-command-compact/lib/index.js`：**不排队** —— `executeCompact` 直接调 `ctx.compaction.compactNow(...)`；
   busy 时抛 `ManualCompactionError("busy")`，渲染成英文
   "Compaction is unavailable because this process has an active compaction, or the agent is not idle."
   ⇒ **DSH 原生是报错的**，只是英文且不说人话。插件 **1.11.13** 起已把该 message 改成人话
   （`compactNow` override + `annotateManualCompactError`，保留 `code`/`name`/`cause`/`stack`，宿主分类不受影响）。
   而且**页面里根本没有压缩按钮** —— 手动压缩就是原生 `/compact` 斜杠命令。
   **三条不做理由**：① 页面不是会话级的，拿不到 agent/会话状态，做不出可信的「当前能否压缩」；
   ② 加按钮等于重复原生 `/compact` 的能力面，还会把用户重新引回 busy 报错那条路；
   ③ 报错可读性已经解决 —— **这才是当初欠账的真实痛点**。
2. **插件私有凭据 / 外部 OpenAI 兼容 API 通道（M3-1 / M3-2 / M3-AUTH-1）** —— 主人裁定：外部 API 去 DSH 里加供应商，
   插件**只读**模型目录 ⇒ 不存 key、不接外网、不做面板；`M3-AUTH-1` 的凭据调查随之**不再需要**。
3. **把 `thresholdRatio` 改成 0.5** —— 见上：插件默认已是 0.45，比 0.5 **更早**触发；改成 0.5 反而**更晚**。

## 历史状态（2026-10-31 · 1.11.14）—— **已被上方取代，留作时间线**（本节「P6-C 仍未执行 / live=1.11.2」两处与事实不符，见上方「已了结的旧账」与「最新状态」）

| 项 | 值 |
|---|---|
| 版本 | **1.11.14**（`package.json` = `README:3` = `CHANGELOG 有 ## 1.11.14`） |
| tag / npm | `v1.11.14` annotated · npm `latest = 1.11.14` · `dist.shasum 765ff0aa…` |
| 单测 | **542 passed / 0 skipped / 0 failed**（45 个测试文件）· `engine` 39/0 · `ledger` 31/0 · `release-hardening` 22/0 |
| 安装校验 | `node test/verify-install.mjs` **16 ✓ / 0 ✗** |
| `check-maintenance` | **9 通过 / 0 警告 / 0 失败** |
| **桌面 live** | **仍是 1.11.2**（`profiles/desktop/package.json` 指向 `github:…/dsh-GOkifu-compact#v1.11.2`）—— **落后 12 个版本，那 11 版的收益在 live 上一个都没生效** |
| 工作树 | HEAD `4804173` 已含**未发布**的 P2-2（`engine: fold 可观测字段`）⇒ 当前树全量 **546/0/0**，**下次发版要 bump 1.11.15** |
| 下一步（唯一档停的事） | **P6-C 真实 apply 仍未执行** —— 需主人授权 + 停插件窗口；预检 `scripts/p6c-preflight.mjs` · 手册 `docs/P6C-停窗执行手册.md`；**真跑不带 `--force`**；`--verify` 已在 **6,219 条真实规模 PASS** |

> 其余仍未做：**M2/M3**（UI 暂停中）· ~~**tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）~~
> ⇒ **本条已于 1.13.0 解决，口径不同**：热清单定价改成 **CJK 感知 + ASCII 侧对齐宿主 `CHARS_PER_TOKEN=4`**，**没有**改成接 `ctx.tokenMeter`（它吃 session surface，已用于会话压力/fold 阈值；热清单是自造文本、套不上 measure）。见 `CHANGELOG` 的 `## 1.13.0` / W-A。

## 历史状态（2026-10-29 · 1.9.1）—— **已被上方取代，留作时间线**

| 项 | 值 |
|---|---|
| 版本 | **1.9.1**（工作区 = 已安装 junction 指向的源码，npm latest 仍是 1.8.1 —— 未发布） |
| 单测 | **134 passed / 0 failed**（新增 `test/selfloop.test.mjs` 8 项 + harness 端到端 1 项） |
| 全库自环 | **6,172 → 0**（`node test/rewash-selfloop.mjs --apply` 已执行） |
| 未生效 | **必须重启 DSH**：正在跑的进程仍加载旧代码，会持续把自环写回（实测每分钟 +100 条） |

### 这一版修了什么（三份独立评估共同指向的那个洞）

`worldstate.touch()` 收到单个路径字符串却按可迭代对象遍历 ⇒ 路径被逐字符拆开 ⇒
`worldHash` 对所有步骤恒定 ⇒ `addAgentNode` 每步命中同一 `stateIndex` 节点 ⇒
`step/end` 把边的 `to` 指回 `from` ⇒ **全库 61.3% 的边是自环** ⇒
`dead` 判定 109/109 全错、`redundant` 135 条全假 ⇒ 热清单告诉模型「这条路永远别试」。

四处修复：`touch` 兼容 string/array、`addAgentNode` 禁止命中本步起点、
`tewariAnalysis` 排除自环边、`failureClass` 要求 `to !== from`。
另修：`#flush({md:true})` 键名写错（fold 后 nodes 从不刷新）、maxTokens 三处默认不一致（→8192）、
压缩连续失败告警进热清单。

**重启后的验收**：
```bash
node test/doctor.mjs          # 「图结构（自环）」应为 ✓（0 个坍缩图）
node test/verify-graphs.mjs   # 图结构：自环 0 = 0.0%
node test/rewash-selfloop.mjs # 若运行期又写出自环，说明修复没生效 —— 先查 worldstate.touch
```

---

## 一句话

DSH 的上下文压缩后端插件。把「历史 → 一段摘要」换成
**「历史 → 棋谱 DAG（节点=状态，边=尝试+结果）+ 每步重建的极短热上下文」**。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | **1.8.0**（已发布：npm `dsh-gokifu-compact@1.8.0` · [Release v1.8.0](https://github.com/MYCF711/dsh-GOkifu-compact/releases/tag/v1.8.0)）|
| 单测 | **118 passed, 0 failed** |
| 挂载校验 | 13/13 |
| GitHub | https://github.com/MYCF711/dsh-GOkifu-compact |
| npm | `dsh-gokifu-compact@1.7.0`（`dsh plugin --profile <name> add dsh-gokifu-compact`）|
| 最新 Release | https://github.com/MYCF711/dsh-GOkifu-compact/releases/tag/v1.8.0 |
| 本地路径 | `D:\主工作区\projects\dsh-chess-context`（物理目录名保留旧名 `chess`；junction 名 `dsh-gokifu-compact`） |
| 包名 | `dsh-gokifu-compact`（npm 只能小写）；展示名 `dsh-GOkifu-compact` |
| 运行期生效 | ✅ 10:0x 已重启：GUI 里**第一次真实 fold 成功**（遮蔽 440,847 tok → surface 1391→373，面板 81%→约 16%）|

## 今天做了什么（0.1.0 → 1.3.4）

### 第一阶段：核心实现（v0.1.x）

- 棋谱 DAG（graph / verifier / extract / ledger / range / keeper / engine）
- **增量 fold**：只压上一个 checkpoint 之后的内容（官方每次重压全部 → ρ^k 衰减）
- **失败记忆**：规则抽取 + 逐字保留（模型没有「决定丢掉」的权限）
- **机械约束段**：约束不经过模型（实测模型在 15 条失败边压力下会把 3 条约束全丢）
- 19 个 bug 修复（3 个 P0：`flushTimers` / `worldHash` / `mergeNodeInto`）

### 第二阶段：模型消费者视角（v1.2.6 → v1.3.4）

六个版本，**全部子代理实测驱动**：

| 版本 | 变更 |
|---|---|
| v1.2.6 | 三层树补缺陷 1/3/4（`errorSnippet` 400 / 写所有 `g.nodes` / 失败边全表） |
| v1.2.7 | 补缺陷 2/5（评语兜底 162 节点 / `verify:kind` 101 条） |
| v1.2.8 | 补缺陷 6（写顺序 json 最后 = 提交点 + `index.md` 带 `updated`） |
| v1.2.9 | 修死链 230 个 + 计数（`g.nodes`）+ 评语标注「非 LLM 原话」 |
| v1.3.0 | text 型 failure 标记 `[text:?]`（47 条）—— 数据层回洗会被运行中的会话覆盖 |
| v1.3.1 | 热清单省预算：短标签 + L4 20 条（**310 tokens / L4**） |
| v1.3.2-4 | 文档同步（最终报告 v1.x 章节 / 三层树设计 / 数字校正） |

### 第三阶段：P0 死循环修复（v1.3.4 → v1.3.5）

**这是插件上线以来最严重的 bug，不是平台问题**：`worldstate.hash()` 返回
`{ hash, mode, files }` 对象，`engine.worldHashOf()` 把它原样写进节点 ⇒
`renderFacts()` 的 `latest?.worldHash?.slice()` 抛 TypeError ⇒ 压缩事务回滚。
实机 `session-5acafe42`：**226 次压缩只成功 3 次**，上下文涨到 66 万 token，
模型 reasoning 退化自我重复，被 magpie 判死循环中断（37 次，全部在同一模型上）。

修复内容（`docs/P0-worldhash-死循环-根因与修复方案.md` + `evidence/P0-worldhash-修复验证.md`）：

- `worldHashOf()` 收敛成字符串；`constraintHashOf()` 改由 `hashSet(collectConstraintText(g))`（原来 `st.constraints` 从未赋值）
- `addAgentNode()` 入口归一化；`fromJSON()` 加载边界修复历史脏数据 + **无条件重建 `stateIndex`**
- `ledger.mjs` 加 `shortHash()` 防御层
- 新增 `test/worldhash.test.mjs`（6 项）+ 端到端回归（旧磁盘图 → `summarize()`）+ `test/verify-graphs.mjs`（全库健康检查）
- 全库回放：23 会话 / 1578 agent 节点 / 对象 worldHash **1279 → 0** / `stateIndex` **5 → 185**

## 核心设计（四条，缺一不可）

### 1. 棋谱 = 落子 + 评语 + 复盘

| 棋谱 | 插件 |
|---|---|
| 一手棋 | 节点（局面） |
| 落子 + 结果 | 边（尝试 + 验证信号） |
| 棋谱评语 | 节点的 `goal` / 约束 / `errorSnippet`（LLM 当时写下的） |
| 复盘 | 从根沿边走一遍 |

### 2. 手割（tewari）

两判定 + 多标签：

- `same_position`（同型）：和某条成功路径到同一终点
- `different` + `redundantVs` / `longerVs` / `probes`：相对**每条**成功路径分别判定

### 3. 失败三态

| 状态 | 条件 | 带什么 |
|---|---|---|
| `blocked` | 资源类（EACCES / ENOENT / timeout / ECONNREFUSED） | `revisit_if=...` |
| `dead` | 有成功路径且**有终点**证明不经过它 | `revisit_if=working path fails` |
| `failed` | 其余（可重试性未知） | 无 |

**关键顺序**：先判 `blocked` 再判 `dead` —— 权限不足是环境性阻塞，不是本质无解。

### 4. 三层树

```
sessions/<sessionId>/
├── index.md          缩进树（每节点只出现一次）+ 失败边全表
├── nodes/<id>.md     评语 / 状态 / 入边 / 出边 / [verify:kind] / [text:?]
└── graph.json        数据源（插件恢复用）
```

**为什么不是目录嵌套**：棋谱是 **DAG**，最大入度 **119**（n174 有 119 个父），transposition 边占 **61%**。嵌套会重复 119 份。

详见 `docs/三层树设计.md`。

### 第四阶段：标记自解释 + 原因不许丢（v1.3.5 → 1.4.0）

模型消费者盲测（12 次受试）暴露三处「内容不够模型用」：

1. **标记裸奔**：图例绑在「检测到手割」上 ⇒ 只有 EACCES 的会话里 `[blocked]` 没有解释
2. **标记是缩写不是语义**：`[blocked]` → `[blocked:permission]`（说出「什么变了能再试」）
3. **原因失踪**：L3+ 把 `→ 报错原文` 整段砍掉（全库 133 条可见失败边只有 25 条带原因），
   而盲测里 **12/12 次回答**都引用了报错原文

改法：动态图例（出现即解释）+ 任何档位都留原因（逐档变短）+ 手割只算一次（尾部 30 条）
+ 注定装不下的档位直接跳过（2000 边渲染 **7.58 ms → 0.478 ms**）+ 配置 `hotLedgerMarkers`。
代价：全库 tokens **+6.8%**，换来带原因的失败边 **89 → 209（2.35×）**。
证据：`evidence/热清单标记AB实验.md`（含「报错原文误导」场景的 1/6 vs 0/6）。

### 第五阶段：清单就地替换（v1.4.0 → 1.5.0）

旧版每次注入都**追加**一条新消息 ⇒ 实测 `session-5acafe42` 累积 **176 条 / 81 万字符 ≈ 27 万 token**
（它上下文峰值 672K 里约 27 万是插件自己注入的）—— 压缩插件自己的热上下文成了最大的消费者。
现在用 DSH 官方的 `surfaceOp:{op:"replace"}` **就地替换**，surface 上永远只有一条；
历史追加出来的旧清单被一次性换成一行占位（事故会话 surface 上还压着 44 条 / 29.5 万字符 ≈ 9.8 万 token）。
证据与遗留：`evidence/P1-4-清单替换实测.md`。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/engine.mjs` | 引擎（继承 dsh-compaction-basic） |
| `src/graph.mjs` | 棋谱 DAG + 手割 + 三态 + 三层树渲染 |
| `src/ledger.mjs` | 热清单 + 硬事实块 |
| `src/summary-prompt.mjs` | 摘要指令 + 机械约束 |
| `src/verifier.mjs` | 成功/失败判定 |
| `test/run.mjs` | 118 项单测 |
| `test/verify-graphs.mjs` | 全库棋谱健康检查（P0 验收工具） |
| `test/ab-render.mjs` | 热清单标记 A/B 夹具（模型消费者实验） |
| `test/real-ledger-replace.mjs` | 真实 Session 上的「清单就地替换」机制验证（8 项） |
| `test/measure-billing.mjs` | 真实 usage 计费审计（prompt/缓存/清单占比/fold 收支） |
| `test/rewash-graph.mjs` | 历史棋谱回洗（errorSnippet 重取 + text 型误报降级；dry-run 默认） |
| `test/doctor.mjs` | 一条命令体检（安装 / 摘要模型 / 压缩成败 / 棋谱 / 树新鲜度） |
| `test/real-headless-fold.mjs` | **真实 dsh 进程**里的 fold 验收（真 Session / 真 compactRegion） |
| `test/markers.test.mjs` | 标记契约（9 项） |
| `docs/三层树设计.md` | 三层树设计依据 + 6 缺陷 |
| `docs/P0-worldhash-死循环-根因与修复方案.md` | P0 根因 + 修复方案 + 验证清单 |
| `docs/最终报告.md` | 完整报告（含 v1.x 章节） |
| `evidence/` | 17 个证据文件（含 `P0-worldhash-修复验证.md`） |

## 未完成（按优先级）

> **2026-11-01（1.14.0）复核：这一节是 2026-10-29 的旧清单，只有历史价值。**
> 当前真正的「未完成」只有三件：
> **① 把插件装到 live**（见顶部「最新状态」与「新版 DSH 适配」四步；需停机窗口 + 授权 + 重启）；
> **② preset 生成并装进 live 后，还要在会话里选中它**（preset 插件惰性激活 —— 不选就等于没装）；
> **③ 真实压缩一轮的验收**（在测试实例上补模型路由，或在 live 装完重启后看 `compaction/summary` 与棋谱落盘）。
> 下表第 1 项早已完成，第 4–6 项是旧 home 的数据问题，**新 home 上没有那些数据**（`<home>/chess-context` 不存在）。
> ~~tokenMeter~~ 已在 **1.13.0** 解决（热清单定价 CJK 感知；见顶部「最新状态」的划线说明）。
> ~~UI 相关（M1-1 / M2-1 / M2-2 / M3-1 / M3-2 / M2-3）~~ 已在 **1.14.0** 解冻并收口（改版见「UI」节；
> 其中外部 API / 私有凭据通道按主人裁定**不做**；`M2-3` 的「真机 fold 走所选模型」验收仍未做）。
> ~~手动压缩按钮~~（历史欠账第 8 条）已在 **1.14.0** 判定**不做并关闭**，理由见「不做」节。
> **1.14.0 的 UI 视觉验收仍未做**：真实浏览器 1280/599 视口没看过（只有源码级 + 纯函数级断言）。

> 2026-10-29：goal 当前阶段的 ①–⑤ 全部完成（各有可复跑脚本 + 证据文件，见下方表格）。
> 下面只剩「需要主人动一下」和「后续可选」两类。

| # | 项 | 说明 |
|---|---|---|
| 1 | **重启 DSH（部署最新代码）** | ✅ 已做；`doctor` 全绿（0 错误 0 警告）|
| 2 | **GUI 长会话的自然 fold** | 机制链路已在真实 dsh 进程验证（`test/real-headless-fold.mjs`，多次 3~6/6 成功）；GUI 里 45 万 token 的自然触发要等重启后跑一段 |
| 3 | **真实计费对账（口径已建）** | `test/measure-billing.mjs` 能按会话拆「未缓存/缓存/清单占比/fold 收支」；网关价目表不落盘，金额需主人按账单折算 |
| 4 | **其它历史会话的回洗** | `test/rewash-graph.mjs` 只对 session-5acafe42 跑过；其余会话按需各自 dry-run + apply |
| 5 | **index.md 时效性** | v1.6.1 起每次 flush 重写；`nodes/*.md` 仍只在首次/fold 后写（快照，细节以 graph.json 为准） |
| 6 | **`text` 型残留 8 条** | 证据区间对不上，保守未洗（见 `evidence/收尾三件-dead锚点-树读取-回洗.md`） |

## goal ①–⑤ 的验收对应

| 项 | 证据 / 复跑 |
|---|---|
| ① 真实计费核对 | `evidence/真实计费核对.md` · `node test/measure-billing.mjs` |
| ② 真实进程首次 fold | `evidence/真实进程首次fold.md` · `node test/real-headless-fold.mjs` |
| ③ dead 重开锚点 / 缺资源语义 | `evidence/收尾三件-dead锚点-树读取-回洗.md` · `node test/run.mjs markers` |
| ④ 历史误报回洗 | 同上 · `node test/rewash-graph.mjs <sessionDir> [--apply]` |
| ⑤ 三层树被模型主动读取 | 同上（盲测 2/2）· 渲染层 `TRACE:` 行 |

## 怎么验证 / 装 / 回滚

```bash
cd D:/主工作区/projects/dsh-chess-context

# 验证（当前 v1.3.5 工作区）
node test/run.mjs            # 118 passed
node test/verify-install.mjs # 13/13
node test/real-modules.mjs   # 4/4
node test/real-fold.mjs      # 5/5
node test/bench.mjs 2000     # 323 tokens / 0.478 ms
node test/verify-graphs.mjs  # 全库棋谱健康检查（P0 验收；重启后必跑）

# 装 / 回滚
node test/install.mjs --dry-run
node test/install.mjs
node test/rollback.mjs
```

## 用户的核心指示（逐字，不要曲解）

> **这是给模型用的，不是给我用的，也不是给我看的。要你喜欢才是真的好用。**

> 做一个任务就像完成一局棋局，把每轮的思考变成一次落子。棋谱本来也能在每一次落子或者分支里面保留评语，这个评语就是 llm 自己写的，也能追溯到当时的完整想法。

> 走出同型甚至不如同型的结果，或者不知道如不如标准定式的适合一般有一种专门的复盘方法……就是在原本标准定式的走法里面把多出来的几步插进去，就能知道多的到底对不对，谁亏谁赚。

## ⚠ 死循环警告（给下一个会话）

今天后半段陷入了「**发版 → 再发版 → 再发版**」的循环（v1.2.6 → v1.3.4，9 个版本）。

**下一次会话不要这样**：

1. **先确认有真实需求再改** —— 不要为了发版而发版
2. **一个改动一个版本**，不要「文档同步」也单独发版
3. **用户说「做交接文件」时，说明他想结束当前会话** —— 不要继续发版
4. **优先做未完成清单里的高优先级项**，不要在小事上打转

> 本轮（P0 修复）是这条警告想要的样子：有真实故障、只动 1 个版本号、不推送不发 Release。

## 今天的四个最大教训

1. **结构对了不等于内容对了** —— 三层树结构对，但内容不全（截断/漏写/全表没列/评语没兜底/误报没标注）
2. **不要改运行中的数据** —— `#flush` 会覆盖 `graph.json`
3. **SGF 是树，我们是 DAG** —— 最大入度 119，目录嵌套会重复爆炸
4. **假数据比真实数据干净，会把契约不一致藏住** —— 87 项单测全用字符串 `worldHash`，
   而真实 `worldstate.hash()` 返回对象；P0 因此躲过了全部单测，直到实机 226 次压缩只成功 3 次。
   **修法是加一条走真实数据形状的端到端回归**（`test/engine-harness.test.mjs` 的 P0 用例）。
