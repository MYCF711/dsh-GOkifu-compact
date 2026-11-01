# 更新记录

## 1.17.1 — 2026-11-02（**未发布**）

> 主题：**装完重启就生效，用户永远不需要跑命令。**
> 事故背景：1.17.0 装到已存在 preset 快照的 profile 上时，GUI 写回的用户层 patch 会盖掉引擎（C26 只加了检测）。

### C66 · doctor 四项「只有消费者、没有测试」的检查补测（审计 P2 收尾）

**背景**：专员审计指出 `fold 悬空 / fold 边界完整性 / 置换合并可追溯 / 热清单分项占用`
四项 doctor 检查**没有任何测试引用** —— 它们恰好是合同 §6 里最容易悄悄失效的验收项。

**做法**：新增 `test/doctor-cli.test.mjs`，用**子进程 + 临时 home** 测真实行为（doctor 是脚本、无 export）：
造最小 home（`chess-context/sessions/<sid>/graph.json` + 可选 `ledger-budget.json`），跑
`node scripts/doctor.mjs --json` 再断言指定检查项（注意 doctor 有警告时退出码非 0，`execFileSync` 会 throw，
测试里改用 `error.stdout`）：

1. **fold 悬空**：无 `dangling` ⇒ **warn「未采集」**（C64 刚改的纪律），全 0 ⇒ ok；
2. **fold 边界完整性**：`openAtEnd > 0` ⇒ **error**，=0 ⇒ ok；
3. **置换合并可追溯**：`superseded` 记录指向**仍在图里**的节点 ⇒ error「自相矛盾」；指向已消失节点 ⇒ ok 并报合并次数；
4. **热清单预算 / 分项占用**：无统计文件 ⇒ warn 未采集；有 `sectionsAvg` ⇒ 预算 ok 且分项占用行给出失败边占比（夹具 ≈67%）。

### C65 · 诊断脚本默认不写盘 + 收掉两个「写入即弃」字段

**背景**：C64 的审计员把 `live-folds.mjs` 当只读跑，结果覆盖了两个已跟踪证据文件（已还原）。
根因不是操作失误，而是**脚本的默认行为是写仓库** —— 诊断工具不该有这样的默认。

**做法**：

1. `live-folds.mjs` 改为**默认只打印**，落盘必须显式 `--write`（`--dry-run` 保留为同义参数，向后兼容）；
   生成行与 md 页脚的命令同步为 `--write`；新增 L-8 用例断言「不传 --write 时不创建/不覆盖」；
2. `traceRecent`（TRACE 行是否为预算退回旧形态）此前只被一个测试读 —— 接进
   `ledgerBudgetMetrics` → `accumulateLedgerBudget` 的 **`traceDropped`** 计数 → doctor 预算行
   显示「TRACE 为预算降级 N 次」；engine-harness 断言两种形态（降级计 1 / 未降级不计）。

**仍为已知项（下一轮）**：`renderMinimalLedger` 返回的 `minimal: true` 仍无消费者；
doctor 的「fold 悬空 / 边界完整性 / 分项占用 / 置换合并」四项仍缺专门测试。

### C64 · 专员审计（12 条）落地：P0 恢复指令 + 两处潜伏指导 + 诊断不许拖垮压缩 + 数字口径

**来源**：外部「严格专员」只读审计（2026-11-02，HEAD `e8ea1d5`，12 条 finding，其中 1 条 P0、5 条 P1）。

**P0（已修）**：摘要**输出模板**（`facts-prompt.mjs`）与规则摘要（`engine.mjs`）里那行
`逐字原文仍在 DSH 会话日志中，**需要时**按 seq 回读` —— 「什么时候该回读」是**恢复记忆的时机决策**，
职责边界明列禁止；而它会随每一次摘要**永久留在上下文里**（live 已抓到实文 11 处）。
改为 `逐字原文在 DSH 会话日志中（seq 可定位）`：只陈述坐标事实。

**P1（已修 4 条）**：

- 热清单置换告警末尾 `…，别重复。` → 删末句（祈使短句属行动指导；`boundary-audit` 的旧规则按构造漏掉）；
- 标记图例 `dead = a working path avoids it (retry-if edge exists)` → `…; the tag names that edge`
  （旧文案在 live 渲染出现 20 次，且被 `markers` 测试钉死 —— 测试一并改）；
- `measureFoldQuality` 是**纯诊断**，却在 fold 主链路上无保护（同函数里 logger/hook/persist 全都 try/catch）：
  图缺 `order` 时直接抛 `g.order is not iterable`，会把「已成功的 fold」变成失败。新增
  **`safeMeasureFoldQuality`**，失败降级 `quality=null`（doctor 已有「未采集」分支）；
- 契约漂移：`docs/压缩的职责边界.md` 的「当前代码没有已确认的越权项 / 热清单全是会话事实」与实测冲突 →
  改为**已修清单表**（C15/C45/C46/C47/C64 六条）+ 明确「审计规则是渐进补齐的」。

**P1/P2 数值与口径（已修）**：

- `handoff-check` 读不存在的 `ledger.maxTokens` ⇒ 预算分母恒为 500；改读 `budgetMax`，并加 H-11 用例；
- `overbudget-report` 未按生产形状渲染（缺 `treeDir`）⇒ 贴边界会话少算约 4%（实测 641 vs 666）；
  现按生产选项渲染，live 复算：d70b7c2f **666/500**、floor/irreducible 3 例、**bug=0**；
- `doctor`「fold 悬空」把「未采集」报 `ok` → 改 `warn`（与同文件纪律一致）；
- `boundary-audit` 补两条规则：**`directive-short`**（别重复/别再试…）与 **`memory-restore-advice`**
  （需要时…回读 / when needed read back），B-8 用例含「纯事实不假红」反向断言；
- 文档数字统一到 **bench 415**（此前 447/446/430 三套并存），测试数改为「当次输出 + 最近实测」；
- 属性测试收紧：直接复用 `boundary-audit` 的 `RULES`（单一来源）、`over-budget` 时 `attemptTokens` 缺失即失败、
  生成器补置换边；`tewari-perf` 补「置换提示不许带祈使短句」。

**未修（记为已知项，下一轮）**：`traceRecent`/`minimal` 两个无 live 消费者的字段；
doctor 四项检查（悬空/边界/分项占用/置换合并）仍缺专门测试。

**审计员的误操作已如实披露**：它把 `scripts/live-folds.mjs` 当只读跑（会覆盖 `evidence/live-folds.*`），
已 `git checkout --` 还原、`git status` 干净 —— 这件事本身也提示：**诊断脚本的默认写盘行为值得加 `--dry-run` 默认**。

### C63 · 修正 C57 的假阳性：`reducible?` 改为「所选不是最省尝试」的**裁决 bug** 判据

**问题（上线一小时内就被 live 抓到）**：C57 用 `shownFailures < failureCount` 猜「还有更省形态」，
于是 `session-8fe881d1`（L5、已省略 11 条失败、只超 3 tok）被判成 `reducible?` —— 但 **L5 本身就是最省的一份**，
再省只能删内容。这条诊断会天天喊狼来了。

**做法**：

- `renderLedger` 返回值新增 **`attemptTokens`**（本次所有档位尝试的 `{level, tokens}`）——
  「所选是不是最省」从猜测变成可核对的事实；
- `classifyBudget` 改判据：`floor`（约束+根目标下限即超）→ **`bug`**（所选 tokens > 最省尝试 tokens，
  兜底裁决真的挑贵了）→ 其余归 `irreducible`（已是最省仍超，只能删内容）；
- `ledger-properties`（C59）追加不变量：**凡是 `over-budget`，所选 tokens 必须等于 `attemptTokens` 的最小值**。

**live 复核**：24 会话 → `within=22 / floor=1 / irreducible=1 / bug=0`（假阳性消失）。

### C62 · 连续折叠不变量（增量语义：区间单调、失败边只增不减、每次都留指标）

**问题**：C61 验证了「一次折叠之后账还对」。真实会话是**连续折叠** —— 更需要确认的是
「第二次折叠不许重扫第一次已折的区域」「失败记忆只增不减」「每一次都留 quality/closure/boundary」。
这三件事没有任何单条用例覆盖过。

**做法**：`engine-harness` C62，连续三轮「铺节点 → 造失败边 → summarize → compactIfNeeded → idle flush → 读回」：

- **区间单调**：第 N 次的 `seqStart` 必须 **大于** 上一次的 `seqEnd`（否则就是重扫已折区域）；
- **失败边只增不减**（折叠是「换摘要」，不是「清账」）；
- 每一次 foldMark 都必须带 `quality` / `closure` / `boundary`；
- 三轮后失败边总数与 foldMarks 数量对得上。

**结果**：首跑全绿 —— 增量语义（`foldRange` 闭包的另一半）在真实引擎路径上成立。

### C61 · 引擎级折叠不变量：真实 compactIfNeeded 之后，记忆与指标都不许退化

**问题**：C59/C60 覆盖了渲染与折叠**纯函数**，但真实路径是「事件 → keeper 落账 → `compactIfNeeded`
→ 摘要 → foldMark 落盘」。手写用例各自断言一两个字段，没有一条用例把「折叠之后账还对不对」串起来。

**做法**：`engine-harness` 新增 C61，用 harness 真实驱动一次 fold（10 条失败边落在**可折叠头部**，
尾部保留 10 个 prompt），折叠后从 `graph.json` 读回并断言：

1. **失败边一条不少**（折叠只换摘要，不许删记忆）；
2. **约束一条不少**；
3. foldMark 的 `closure` 与**用区间暴力重算**的结果一致（nodes/edges/preGraph）；
4. `boundary.openAtEnd === 0`（切点在 step 边界）；
5. foldMark 字段齐全：`trigger=pressure`、`quality`（召回 ∈ [0,1]、`expectedConstraints/expectedFailures ≥ 1`、
   `unknownIds` 是数组）、`dangling` 快照、`summaryChars > 0`。

**过程中修掉的两个测试写法坑**（值得记）：① `graph.json` 只在 `agent/status=idle` 时落盘 —— 读图前必须 flush；
② 失败边的证据 seq 必须与 surface 节点在同一段序号里、且落在**保留尾部之前**，否则 fold 区间不覆盖它们
（第一次写成了「全在尾部」，`expectedFailures=0`）。

### C60 · 折叠纯函数层的不变量测试（闭包 / 边界 / 保真度）

**问题**：`foldClosureOf`（可寻址闭包）、`foldBoundaryOf`（切点完整性）、`measureFoldQuality`（保真度）
是「这次折叠可不可信」的三条机器判据，但此前只有少量手写夹具 —— 区间形状一变就可能漏。

**做法**：新增 `test/fold-properties.test.mjs`（固定种子随机图 + 随机区间 + seq 空洞）：

- **闭包**：节点/边计数必须等于**暴力扫描**结果；`firstNode`/`lastNode`/`firstEdge`/`lastEdge`
  是匹配集合里最小/最大的 id；`graphNodes` = order∩nodes；`preGraph` **当且仅当**
  「区间内无节点且区间终点早于图内最小 seq」为真；
- **边界**：`overlapping` 等于区间相交的边数；`openAtEnd` 等于**恰好跨过终点**的边数且 `≤ overlapping`；
  区间盖住全部证据时 `openAtEnd` 必须为 0；`unsettled` 等于未结算边数；
- **保真度**：摘要含全部约束与全部失败 id ⇒ `constraintRecall = failureRecall = 1`、`unknownIds = []`、
  `compressionRatio = shadowed / summaryTokens`；删一条约束 ⇒ 掉召回且该条进 `missingConstraints`；
  把某失败 id 换成 `e9999` ⇒ 掉召回且 `e9999` 进 `unknownIds`。

**结果**：首次运行即全绿 —— 三个判据在随机长尾区间下与暴力扫描一致。

### C59 · 热清单渲染的**不变量（模糊）测试**

**问题**：`ledger-boundary` / `c17-*` / `markers` 都是手写夹具，只覆盖作者想到的形状；
压缩产物的风险恰在长尾形状（失败边 0 vs 40 条、约束 0 vs 12 条、预算 150 vs 无上限）。

**做法**：新增 `test/ledger-properties.test.mjs` —— 固定种子的伪随机图（**10 个种子 × 5 档预算 = 50 次渲染**，
其中 **31 次落在 over-budget**、覆盖 L3/L5 与省略分支），断言六条必须恒成立的契约：

1. 根目标与每条约束的**头段**都在（clip 只裁尾）；
2. `shownFailures + omittedEdges === failureCount`（失败边账目闭合）；
3. `tokens <= budget` 或 `fallback === "over-budget"`，且 `overBudgetBy === tokens - budget`；
4. 有失败边时 `provenanceCoverage === 1`；`impossible` 永不出现；
5. 模型可见文本**无绝对路径**、**无行动/认知指导**（C45/C46 的判据在渲染侧同样成立）；
6. 同一图两次渲染**逐字相同**（渲染必须是纯的）。

种子固定 ⇒ 失败可复现；生成器还会制造同名 action（`↻k`）与长失败原因（省略分支）。

**结果**：首次运行即全绿 —— 说明这些不变量在随机长尾形状下确实成立（不是靠手写夹具凑出来的）。

### C58 · 超预算快照 + 跨轮对比（`--out`）

**做法**：`overbudget-report.mjs --out <base>` 写 `json` + 人读 `md` 快照，并计算与**上一次快照**的对比
（`trendOverBudget`：构成增删、头号来源是否变化）。每小时跑一次时，直接回答「超预算的构成变了没有」。

**live 首快照**：`2026-11-01T20:02Z`，budget=500、23 会话 → `within=22 / irreducible=1 / reducible?=0`，
唯一超限 `session-d70b7c2f`（641/500，失败边 10/10 已列全）。trend 首次写入 = 「无旧快照」。

证据：`evidence/over-budget-snapshot.{json,md}`（已登记到 `evidence/README.md`）。

测试：`overbudget-report` 新增 C58（delta 增删 / 头号来源变化 / 无旧快照）。

### C57 · `scripts/overbudget-report.mjs`：超预算的离线归因（一键回答「26% 到底是什么」）

**问题**：`ledger-budget.json` 只给聚合计数（例如 `over-budget 384/1477 ≈ 26%`）。聚合会被
**一个长失败原因的会话反复渲染**放大 —— C48 已经用离线分析确认过，但那次是一次性脚本，
下一个人还得重写一遍。

**做法**：新增只读诊断脚本 `scripts/overbudget-report.mjs`：

- 用**当前** live 图在指定预算（默认 500）下逐会话重渲染；
- 把超限归成三类：`floor`（约束+根目标下限即超）、`irreducible`（失败边已全部列出仍超，
  再省只能丢失败记忆）、`reducible?`（**还有更省形态没被选中** —— 只有这一类可能是渲染 bug）；
- 输出按超出量降序的清单 + 一句「即期快照 ≠ 累计计数」的提醒；永远退出码 0（诊断不该让流水线红）。

**live 首跑**：23 个会话 → `within=22 / irreducible=1 / floor=0 / reducible?=0`，
唯一超限是 `session-d70b7c2f`（641/500，失败边 10/10 已列全）—— **没有一类是渲染 bug**。

测试：新增 `overbudget-report.test.mjs` 3 例（三态判定 / 三会话归因与排序 / 空 home 不抛）；
合同 §6 的验收流程补上这条命令。

### C56 · 清两处冗余指针（无损）：bench 430 → 415

**做法**（纯删冗余，不动任何事实条目）：

1. 省略行的尾巴 `(per node: nodes/<id>.md) / by seq in the session log` →
   `/ nodes/<id>.md`（`graph.json` 已在前，节点文件也保留；`by seq` 对模型没有额外可执行信息）；
2. `UNVERIFIED` **计数行**的 `— detail in graph.json` 去掉 —— 它是计数行不是省略行，
   位置约定已由同一份清单的 `TRACE` 与 docs 承载。

**bench：430 → 415（−15 tok / −3.5%）**；基线、README、合同 §6 的示例文案同步更新。

门禁：全量 731 passed / 0 skipped / 0 failed（无测试引用被删的两个字符串；handoff-check ⑧ 仍能解出省略行 ——
`omitted for budget` 与 `graph.json` 指针都在）。

### C55 · 研究文档收口：`docs/research/00` §11 重排 + 状态快照

**问题**：§11 的候选表停在 C33 前后，且行号有重复（两个 `18`），最近 10 刀（C41–C54）的结论
散落在 CHANGELOG 里、研究文档看不到 —— 下一轮/下一个人得靠翻 commit 才能恢复状态。

**做法**：

- §11 重排为 **8–26 号**完整清单：每条写清「落在哪个 commit / 现在的状态 / 为什么暂缓」；
- 新增 **§11.1 当前状态快照**：全量 731 passed、bench **430**/L5、handoff FAIL 0/WARN 4、
  doctor 0 错/3 警、verify-install **19/19**、boundary-audit 0、live fold 12 次/6 会话、
  质量 c=1/f=1、压缩比 48.45–350.68、成本 47–74% —— 全部是串行门禁实测值；
- 明确记下两个「待重启才生效」的项：`buildId` 一致化、over-budget 归因字段落盘。

本轮无代码改动（纯沉淀），门禁仍全量复跑确认没有漂移。

### C54 · `live-folds` 会话分布 + 压缩无效（foldThrash）进证据页

**问题**：证据页有逐次明细，但没有回答「**是不是同一个会话被反复折**」——而 `foldThrash`
（连续两次 fold 间隔 <30 事件 = 压缩没回收足够空间）此前只有 doctor 在看，证据页看不到。

**做法**：

- `collectLiveFolds` 顺带收集 `foldThrash >= 2` 的会话（有界 5 条）；
- `summarizeFolds` 新增 `bySession`：有 fold 的会话数 / **multiFold（≥3 次）** / 折叠最多的前 3；
- `main()` 把 thrash 汇总进 `summary.thrash {sessions, max, list}`；证据页新增「## 会话分布」小节。

**live 首跑**：**12 次 fold / 6 个有 fold 的会话**，其中 **2 个会话被折过 ≥3 次**，`foldThrash = 0`；
另注意压缩比下限从此前的 113 降到 **48.45**（新 fold 折了更小的增量，仍在 1 个数量级以上）。

测试：`live-folds` 新增 L-7（multiFold / top / thrash 三处）。

### C53 · 构建标识（buildId）：版本号比不出「运行实例落后」

**发现（C34 的设计缺陷）**：`build.json` 只记 semver，而整轮优化里版本号一直是 **1.17.1** ——
于是 C44–C52 全部落盘后，doctor 仍显示「运行实例 v1.17.1 与磁盘代码一致」。
「哪一版代码在跑」这个核心问题其实**没被回答**。

**做法**：

- `build-stamp.mjs` 新增 **`repoBuildId()`**：`package.json` + `src` 下所有 `.mjs` 的内容哈希（12 位十六进制）；
  写入 `build.json` 的 `buildId` 字段（`writeBuildStamp` 默认自动算）；
- 新增 **`compareBuildId(stamp, diskBuildId)`**：ok / stale / missing；
- `doctor` 的「运行实例版本」同时比较 semver 与构建标识 —— stale 时直接写
  **「运行实例 build X vs 磁盘 Y —— 重启 DSH 后才生效」**。

**live 即刻生效**：当前进程的戳里没有 `buildId`（旧代码写的），doctor 现在如实报
**「运行实例 build unknown vs 磁盘 11f699aeab7d —— 磁盘代码已变，重启后才生效」** ——
这正是此前几轮反复踩的坑，现在一眼可见。

房间契约：`build-stamp` 允许 `node:crypto`（rooms 单测同步）。测试：S-6（哈希稳定、改文件即变）、S-7（三态比较）。

### C52 · 同类失败的无损压缩：标记提到一行汇总（bench 446 → 430）

**做法**：L2+ 且失败边 ≥3 时，若每条失败行的**完整标记串完全相同**（典型：全部 `blocked:permission`），
就把标记从每行移到一行汇总 `# all N failures: blocked:permission`，图例照旧解释键含义 ⇒ **语义零丢失**
（还多了一个事实：它们全属同一类）。逐行唯一的东西不会被并掉 —— 判据用的是**完整标记串**，
所以 `dead retry-if:e1` 与 `dead retry-if:e2` 仍然逐行保留（C51 那次「uniform 剔除」的教训）。

bench：**446 → 430（−16 tok / −3.6%）**；live 同类会话每次渲染省约 40–60 字符。

**夹具预算重定**（只改预算、断言未动）：`c17-path-at-every-level` 三个用例因整体变便宜而档位上移 ——
C17-2/C17-3 的 300 → 270、C17-8 的 330 → 280，均在代码注释里写明原因与日期；
`markers` 的两条断言改成「逐行标记 **或** 汇总行」等价形式（`# all 10 failures: blocked:permission`）。

### C51 · L2+ 标记图例压成一行（+ 一次被测试否决的「uniform 标记剔除」实验）

**改动（保留）**：`markerLegendLines` 在 **L2 及更紧的档位**把图例压成一行
（`# markers: failed = … · novel = …`），L0/L1 仍是多行形式（预算宽裕时更好读）。
无任何语义丢失，纯排版；真实会话图例常有 2–4 个键，每次渲染省约 5–10 tokens。

bench：**447 → 446**（夹具只有 1 个标记键，只省 1 token），基线已更新并写明理由。

**被否决的实验（负结论入库）**：还试过「**uniform 标记剔除**」——L2+ 且失败边 ≥3 时，
把「每一行都带」的标记（典型是 `failed` / `novel` / 全部 `blocked:permission`）整段删掉，连图例一起去掉。
bench 省到 **413（−34 tok）**，但**语义真的丢了**：全部 blocked 的会话里
`[blocked:permission]` 与图例是唯一说明「被什么挡住」的地方，删掉后模型只看到「失败过」。
`markers` / `ledger` 共 5 条用例当场变红 —— 不是因为测试碍事，而是因为它证明「省的是信息」。
⇒ 撤销 uniform 剔除，只保留单行图例。

测试：`markers` 新增「L2+ 图例单行 / L0/L1 多行」用例；其余断言不变。

### C50 · `live-folds` 跨轮趋势（每小时跑一次时最该看的是「变了什么」）

**问题**：`live-folds` 每次覆盖写证据页，只给**当前快照**。每小时巡检时真正要回答的是
「这一小时新增了几次 fold？质量下限有没有变差？边界有没有回归？成本占比漂移多少？」—— 之前得手动 diff。

**做法**：

- 新增纯函数 `trendOf(prev, summary)`：`newFolds` / `qualityChanged`（c/f 召回下限与幻觉命中）/
  `boundaryRegressed`（openAtEnd 增加）/ `costShareDelta`（遮蔽占读入下限漂移）；
- `main()` 写入前先读上一次的 `live-folds.json`，算 trend 一起落盘（`payload.trend`）；
- 证据页新增「## 与上次对比（C50）」小节。

**live 首次运行**：上次快照 `2026-11-01T19:33Z` → 新增 fold **0**、质量下限无变化、无边界回归。

测试：`live-folds` 新增 L-6（纯函数四类变化 + 无旧快照返回 null）。

### C49 · over-budget 归因再细分：`budgetIrreducible`（已列全失败边仍超）

**问题**：C44 只分出「约束+根目标下限即超预算」一种设计内形态。但 C48 的离线归因显示，
live 最常见的是另一种：**失败边已经全部列出**（7 条长原因，`shownFailures === failureCount`），
此时再省就只能删失败边 —— 同样属于设计内（合同红线：每条失败边都要出现），却仍被算成「over-budget」，
看起来像渲染问题。

**做法**：

- `ledgerBudgetMetrics` 透传 `shownFailures` / `failureCount`；
- `accumulateLedgerBudget` 新增 **`budgetIrreducible`**：`over-budget && shownFailures >= failureCount && failureCount > 0`；
- `doctor` 文案区分：`budgetFloorOver`（约束+根目标不可裁）与 `budgetIrreducible`（再省必须丢失败记忆）。

判读口径：两者之和若远小于 over-budget 总数，才说明存在「还有更省形式却没选」的真问题。

测试：`engine-harness` 断言两种形态（列全 ⇒ 计 1；`shown < count` ⇒ 不计）。

### C48 · over-budget 按会话归因（聚合比例 ≠ 系统性问题）

**现象**：live 聚合 `over-budget 178 / 911（19.5%）`、maxOver 191 —— 已到 C41 写下的重评阈值附近。
但离线复现 22 张 live 图（预算 500）**只有 1 张超**：`session-d70b7c2f`，649/500。
它的结构是「unyielding ≈300 tok（root+约束）+ 7 条很长失败原因（1180 字符）」——
失败边只有 7 条（≤10），L4/L5 与 L3 同文，再降只能删失败边（违反「诚实超限 > 静默省略」）。

**结论**：19.5% 是**一个会话反复渲染**放大的，不是系统性渲染退化。

**做法**：`ledger-budget.json` 新增 **`overBySession`**（有界保留前 8 个超预算来源）；
`doctor` 预算检查在超预算时直接显示「主要来源：<会话> N 次」。
证据页 `evidence/热清单超预算归因-2026-11-02.md` 追加第 5 节（离线归因表）。

测试：`engine-harness` 断言按会话累计（a=2 / b=1）与非超预算不记归因。

### C47 · 摘要章节标题去指令（`## 已探明死路（逐条保留，一条不许少）` → `## 已探明死路`）

**发现（C45/C46 同源清扫的第三处）**：摘要模板与规则摘要的章节标题里带着**指令**——
`（逐条保留，一条不许少）`。摘要产物会成为**后续轮次的上下文内容**，标题里的指令于是长期留在模型眼前，
等于借压缩之手持续下命令（「一条不许少」是给写摘要的模型的规则，不是给后来模型的）。

**做法**：

- `facts-prompt.mjs` 的模板标题改为 `## 已探明死路`；「每条都必须出现」已在上方规则里说了两遍，不靠标题传递；
- `engine.mjs` 的 `ruleSummary`（降级摘要）同标题，两侧一致；
- 真机脚本的模板期望同步（`real-e2e.mjs` / `real-model-scenarios.mjs`）。

**影响面**：仅摘要文本（不进热清单）⇒ bench 仍 447 / L5；历史 fold 的标题保持原样（不重写已落盘摘要）。

### C46 · UNVERIFIED 段去认知指令 + 审计新增 `epistemic-advice` 规则

**发现（C45 的同类清扫）**：`UNVERIFIED (ran, but no external signal — treat as unproven)`
里的 **`treat as unproven`** 是「告诉模型怎么看待这批边」的**认知指令** —— 与「何时再试」的行动指导同源，
属于 AGENTS/persona。压缩该做的是陈述状态（跑了、没有外部信号、因此未验证），不是教模型怎么处理它。

**做法**：

- 标题改为事实口径：`UNVERIFIED (ran, but no external signal — unproven)`（保留 `unproven` 状态词，
  去掉 `treat as` 指令）；
- `boundary-audit` 新增规则 **`epistemic-advice`**（error）：`treat as|you can|you may|make sure to|be sure to|feel free`；
- 规则重叠处（如 `you should retry it` 同时命中 behavior-guidance 与 retry-advice）在测试里按
  「**至少命中行为指导**」断言，不强行二选一。

测试：`boundary-audit` 新增 B-6（英文 retry 建议）与 B-7（认知指令），并验证**纯事实写法不假红**
（`connection refused` / `the required resource is absent`）；`unverified-tier` 新增 U-4
（UNVERIFIED 段不许出现 `treat as`）。B-1 同时放宽为「至少命中行为指导」（多规则可并存）。

### C45 · 标记图例去掉行动建议 + 越界审计补英文「retry advice」规则

**发现的越界（模型可见文本）**：热清单的标记图例从 1.9.x 起就带着行动指导 ——
`retry only if retry-if breaks` / `retry when it changes` / `retry when it appears, or create it` /
`take it`。这属于「该不该再试 / 该走哪条路」的判断（AGENTS / persona 职责），不是压缩该说的话。
C15 只修掉了 `(continue or abandon)` 一处，**图例这 8 条一直没被抓到** —— 因为
`boundary-audit` 的行为指导规则只认中文短语与 `you should / you must / you may`。

**做法**：

- `MARKER_LEGEND` 全部改成**只陈述事实**：`the environment lacks a required permission` /
  `the required resource is absent` / `no answer within the time limit` / `connection refused` /
  `a working edge <edge> reaches the SAME position`（不再有 retry / take it / create it）；
- `boundary-audit` 新增规则 **`retry-advice`**（error）：`retry when|retry only|retry it|take it|or create it|should retry`
  —— 与中文「下一步 / 不要重试」同口径，防止同类英文指导再漏进来；
- 测试：`markers` 两条图例断言改成新的**事实口径**；`boundary-audit` 现有 B-1..B-5 全绿（新规则无新增 finding）。

**效果**：模型可见文本里不再有「什么时候该再试」的建议；压缩只陈述「这条路为什么不通」，
要不要再走由模型/AGENTS 决定。图例同时变短（约省 40% 图例字符），bench 仍 447 / L5（夹具未触达差异）。

### C44 · over-budget 归因指标：区分「渲染超预算」与「不可裁下限超预算」

**背景**（接 C41/C43 同一类问题）：C41 已确认超预算是「宁可超也不丢约束/失败边」的设计内结果，
但 `ledger-budget.json` 只记 `over-budget` 计数，**看不出这 118 次里有多少是「约束+根目标本身就超预算」**
（不可裁 ⇒ 谁改渲染都没用）与「渲染还能再降」的混合。

**做法**：

- `renderLedger` 每次返回 `unyieldingTokens`（根目标行 + 约束块的 token 数 —— 这两段任何档位都只能 clip、不能删）；
- `ledgerBudgetMetrics` 透传该字段；`accumulateLedgerBudget` 新增 **`budgetFloorOver`** 计数：
  `fallback=over-budget && unyieldingTokens >= budgetMax` ⇒ 说明**底线即超预算**（设计内）；
- `doctor` 预算检查在命中时追加「其中 N 次是『约束+根目标下限』即超预算（不可裁，设计内 —— 见 C41）」。

**live 现状**：`over-budget 118/658（17.9%）`、maxOver 147 —— 但因运行实例是 C44 之前的代码，
`budgetFloorOver` 要等下次重启后由新进程写出；届时这条告警能直接给出「设计内 / 可改进」的比例。

测试：`ledger-budget` 新增 T-4（约束+根目标 > 预算时如实给出 unyieldingTokens，且必须小于整段清单）；
`engine-harness` 断言累计规则（底线超预算计 1，非底线不计）。

### C43 · 成本口径修正：`input/shadowed` 含 host 固定开销，改用「遮蔽占读入」

**问题**：`doctor` 的 fold 成本检查用 `input/shadowed ≥ 2` 判「读两倍才压一倍」。live 里出现 2.11 就直接告警 ——
但摘要请求的 input **包含 host 固定开销**（工具 schema、system/AGENTS、保留尾部、旧 checkpoint），
这些与压缩策略无关；工具多的会话会被误判成「折得太碎」。

**做法**：

- `fold-quality.mjs` 新增纯函数 `foldCostMetrics`，三个数各回答一件事：
  `share = shadowed/input`（**判据**：<30% 才算折太碎/太早）、`ratio = input/shadowed`（旧口径，仅对照）、
  `roi = (shadowed - summary)/input`（每读 1 token 换回多少永久缩减）；
- `doctor` 检查改名「fold 成本口径（遮蔽占读入）」：按 `share` 判定，文本同时给出 ratio 与 ROI；
- `live-folds` 每条 fold 记 `shadowedShare`，summary/证据页/控制台都改用新口径。

live 结果：**遮蔽占读入 47%–74%**，ROI **0.45–0.74** —— 10 次 fold 全部健康，此前的 2.11 告警是误读。

测试：`fold-quality` 新增 Q-8/Q-9（三口径计算、非法输入返回 null、share 与 ROI 同向）；
`live-folds` L-2 断言必带 share 区间。

### C42 · live 验证：C30/C31 真值到齐 + `unsettled` 语义澄清

**本轮 live 新增 3 次 fold（当前 10 次 / 21 个会话）**，`closure` 与 `boundary` 全部落盘：

| fold 区间 | closure | preGraph | graphNodes | boundary |
|---|---|---|---|---|
| 2333-4261 | n=156 / e=163 | false | 240 | openAtEnd **0** · overlapping 163 · unsettled 145 |
| 4685-6211 | n=57 / e=61 | false | 251 | openAtEnd **0** · overlapping 61 · unsettled 59 |
| 1022-1487 | **n=0 / e=0** | **true** | 104 | openAtEnd **0** · overlapping 0 |

⇒ **C30（preGraph）与 C31（boundary）都在真机上验证通过**；doctor「fold 边界完整性」从「未采集」转为
**✓（3 次 fold 都切在 step 边界）**。质量仍 c=1 / f=1，幻觉探针 0，压缩比 113–351。

**语义澄清**：`boundary.unsettled` 统计的是「区间内**未拿到强验证**的边」（`unverified`/`untested`）——
live 里 bash 成功大多没有退出码标记，会落进 `unverified`，所以这个数通常很大（145/163）。
字段注释与合同 §6 第 10 行已改成这个口径；它只作观测，不参与判错。

合同 §6 的 live 列同步刷新：provenanceMin=1（433 次渲染）、trigger pressure=6/10、liveUnsettled=0。

### C41 · 热清单 over-budget 归因 + 一次被否决的 L6 实验（负结论入库）

**现象**：重启后 `ledger-budget.json` 出现 **over-budget 19/263（7.2%）**，最大超 117 tokens。

**归因**（离线 19 张 live 图，`maxTokens=500`）：只有 1/19 超（`d70b7c2f`，574/500）。
超限来自**不可再裁的结构** —— 根目标 clip 后 168 字符 + 约束（逐字，丢一条任务就变）+ 最少失败边
+ 标记图例 4 行；这几项的**下限**在个别会话里已经 > 500 tokens。

**实验（否决）**：加 L6「只留 3 条失败边 + 关标记图例」—— 实测把 574 压到 **472**（装下了），
但同时破坏三条已记录的不变量：① M2「预算内选最省」被 L6 的绝对最省顶掉（bench 447 → **238**，
白丢 209 token 失败记忆）；② L5「列最近 10 条 + 省略数真实」契约；③ 既有原则**「诚实超限 > 静默省略」**。
⇒ **不引入 L6**，保持「宁可超预算也不丢约束/失败边」，用 `fallback: over-budget` + `overBudgetBy` 把超限做成可见状态。

证据：`evidence/热清单超预算归因-2026-11-02.md`（含成本结构表与重新评估阈值：占比 >20% 或 maxOver >200 tokens）。

### C39 · 摘要指令如实告知「本段早于棋谱」（preGraph）

**问题**：重启续跑的历史可能整段早于棋谱（C30 的 `preGraph`）—— 这一段**没有任何节点 id**。
摘要模型却仍可能按惯例引 `nN`（例如「见 n12」），幻觉探针（`quality.unknownIds`）随后记一笔，
而热清单/摘要里就多了一条查不到的引用。

**做法**（只在摘要指令里加事实，不影响会话模型）：

- `buildChessInstruction` 新增 `preGraph` 参数：为 true 时在事实块后加一行
  「the folded segment predates the chess record, so it has NO node ids. Cite it by seq ranges only;
  never introduce a node id that is not listed above.」
- `engine.summarize` 用 `foldClosureOf(g, range).preGraph` 传参 —— 与 foldMark 里落盘的是同一个判定。

测试：新增 `facts-prompt.test.mjs` 3 用例（事实块逐字带上 / preGraph 提示恰好出现一次且非 preGraph 不出现 /
契约要点仍在）。摘要指令属 `facts-prompt.mjs` 的既有 ALLOW 例外（读者是摘要模型，不是会话模型）。

### C38 · 真空保真度样本：逐会话不再告警，全体真空由 doctor 兜底

**问题**：`handoff-check` ⑩ 把「真空样本」（折叠区间里本来就没有约束/失败边可丢）记成 warn。
live 里 3/7 条 WARN 都是它 —— 门禁因此被训练成「满屏噪声」，真正的缺陷反而被淹没。

**做法**（把告警放在它该在的层级）：

- 逐会话 ⑩：真空样本 ⇒ **ok**，detail 明确写「真空样本（本区间没有约束/失败边可丢 —— 不算缺陷；
  全体真空由 doctor 全局告警）」；
- `doctor` 保真度：**全部**样本都是真空 ⇒ **warn**「保真度实际未被检验」；只要有一次非真空样本，
  就按原判据（constraintRecall=1 / failureRecall=1）评估。这样「全局盲区」不会被静默放过。

live 效果：`handoff-check` **WARN 7 → 5**；doctor 保真度仍 ✓（3 次样本，最近一次期望约束 1 / 失败边 3）。

测试：`handoff-check` 新增 H-15（真空 ⇒ ok + detail 标明真空），H-4 同步改写（原「真空必须 warn」的旧契约
按 C38 调整）。

### C37 · handoff-check ⑬（fold 边界进交接门禁）+ ① 的 agent-only 语义

**⑬ fold 边界**：C31 的 `boundary.openAtEnd` 此前只有 doctor 在**全局**看，单会话交接门禁看不到 ——
但「摘要引用区间外的结果」正是交接时最该拦的问题。新增 ⑬：`openAtEnd > 0` ⇒ **fail**（与 doctor 的 error 同口径）；
旧 fold 无 boundary ⇒ ok「未采集」；有记录且全 0 ⇒ ok。测试 H-13。

**① agent-only 语义**：live 新出现一个 **10 个 agent 节点、0 个 user 节点**的会话（子代理/自动化会话），
① 报「图里没有 rootUserNodeIds」——但它本来就没有根目标，不是缺陷。现在区分三态：
空图 ⇒ ok「不适用」；**没有任何 user 节点 ⇒ ok「agent-only 会话，根目标不适用」**；
有 user 节点却漏记 root ⇒ warn（点名 keeper 漏记）；有根但清单缺 ROOT USER ⇒ fail。测试 H-14。

live 效果：`handoff-check` **WARN 8 → 7**（agent-only 会话不再误报）；⑬ 在 live 全 0 判据下为 ok。

### C36.1 · handoff-check ⑥ 误报修复：单独 `WORKING:` 行也是「当前位置」

**发现**：C36 收尾跑门禁时出现 **FAIL 1**（会话 `7520721a`，⑥当前位置）——离线复现后确认是**检查器的锅**：
当前路径 === 工作路径时，ledger 只写一行 `WORKING: user → n21 → n22`（省 20–40 tokens 的既定行为），
而 ⑥ 只认 `CURRENT PATH` / `# path:` / `# WORKING:` 三种字面 ⇒ 把合法渲染判成 FAIL。

**修法**：⑥ 的判据补 `/^WORKING:/m`；新增 H-12（构造只渲染 WORKING 行的图，断言 ⑥ = ok）。

live 效果：`handoff-check` **FAIL 1 → 0**，WARN 7（3 条真空质量样本、2 条旧 fold 无 quality/trigger、
1 条 over-budget、1 条真空样本）；C36 提交信息里写的 FAIL 0 至此才真正成立。

**付记（同轮重启验证）**：主人 03:01 重启后，C29/C34 两项 live 转 ✓ ——
`build.json` 已落盘（version 1.17.1 / startedAt 03:01）、home 层漂移已自愈；doctor 只剩 1 条警告
（「fold 边界完整性」未采集，等重启后第一次 fold 落 `boundary` 即转 ✓）。

### C36 · handoff-check ①：空图是「不适用」，不是「缺 rootUserNodeIds」

**问题**：`handoff-check` 的 ①根目标 把两种完全不同的情况混成一个 warn：
「图里没有 rootUserNodeIds（可能不是从用户消息开始的会话）」——
live 里有 2 个会话是**空图**（0 节点，本次没记录任何事件），它们长期占着告警位，
但根本没有可检查的内容。门禁的可信度取决于告警都指向真问题。

**做法**：先数节点 —— `nodes === 0` ⇒ ① 记 **ok**，detail 写「空图（本次会话没有记录任何节点 ⇒
根目标检查不适用）」；有节点但缺 `rootUserNodeIds` ⇒ 仍是 warn；有根但清单里没有 ROOT USER ⇒ fail。

live 效果：`handoff-check` **WARN 9 → 7**（两个空图不再误报）；其余 7 条均可解释
（3 条真空质量样本、2 条旧 fold 无 quality/trigger、1 条 over-budget、1 条真空样本）。

测试：`handoff-check` 新增 H-11（空图 ⇒ ok + detail 含「空图」；有节点缺 root ⇒ 仍 warn）。

### C35 · 合同 §6-4 的消费者：`dangling.liveUnsettled` 进 doctor + 证据页；验收清单刷新到 live 现状

**问题**：合同 §6 第 4 行要求「`foldMarks.dangling.liveUnsettled` 记录趋势，升高说明 fold 边界切在动作中间」，
但 live 里它**只被写进 graph.json，没有消费者**（`live-folds` 只是搬运字段）。同时 §6 表格的「现在（live）」
一列还停在 2026-11-01（大量「尚无样本」，与事实不符）。

**做法**：

- `doctor` 新增 **「fold 悬空（dangling）」**：`fromBroken > 0` ⇒ error（图坏了）；
  `liveUnsettled > 0` ⇒ warn（可能切在动作中间，配合「fold 边界完整性」看）；否则 ok 并报 residue/candidates 合计；
- `live-folds` 汇总 dangling（residue/candidates/liveUnsettled/fromBroken）并写进证据页；
- 合同 §6 表格刷新到今天的 live 现实：provenanceMin=1、over-budget=17/637（2.7%）、foldThrash=0、
  dangling liveUnsettled=0、failures 占比 54%（健康）、trigger pressure=3/7；
  另补第 9–13 行（preGraph / boundary / 合并审计 / 运行实例版本 / 机器级层漂移）。

live 结果：「fold 悬空」= ✓（3 次 fold：residue 3 / candidates 1 / liveUnsettled 0 / fromBroken 0）。

### C34 · 「运行实例是哪一版代码」落盘标记（build.json）+ doctor 检查

**问题**：本机踩过两次同类陷阱 —— 磁盘代码已更新，但**正在跑的进程还是旧代码**，新字段/新检查要等重启才出现
（C26 事故；C30/C31 之后 doctor 的「未采集」）。磁盘文件、package.json 都回答不了「现在跑的是哪版」。

**做法**：

- `src/rooms/build-stamp.mjs`：插件启动时（engine 构造）写 `<chess-context>/build.json`
  —— `{schema, version, startedAt, pid}`，原子替换、失败静默；
  **写在图根目录的父目录**，所以测试跑在临时目录，不碰真实 home；
- `doctor` 新增「运行实例版本（build.json）」：一致 ⇒ ✓；**磁盘更新而进程落后 ⇒ warn「重启 DSH 后才生效」**；
  旧版本没有戳 ⇒ 未采集（明确写磁盘版本）。

测试：新增 `build-stamp.test.mjs` 4 用例（写读往返 / compare 三态 / 失败静默 / 版本与 package.json 一致）。

**当前 live 状态**：正在跑的进程（02:36 启动）早于本刀 ⇒ doctor 显示「未采集」；下次重启后写入并转 ✓。

### C33 · 非破坏合并的数据层（superseded / retargetedFrom）+ doctor 审计

**问题**：`mergeNodeInto` 做置换合并时把 from 节点整个删掉 —— 图结构收拢了，但**被吞节点的身份**
（id/seq/目标）和「这条出边原本属于谁」永久消失，只能靠 `transpositions` 数字倒推。

**做法**（只加事实、不改结构、不动渲染）：

- `into.superseded[]`：有界保留最近 **8** 条被吞记录 `{id, seq, goal, ts, at}`；
  `into.supersededCount`：累计次数（可以大于保留条数）；
- 出边 `from` 被改指向时记 `retargetedFrom`（第一次来源，`??=` 不覆盖），边仍指 `into`；
- `transpositions` 与热清单的 `×N` 渲染**完全不变**（不引入新的模型可见文本 ⇒ bench 不动）。

**消费者**：`doctor` 新增「置换合并可追溯（superseded）」—— 每条记录必须指向**已不在图里**的节点且带 seq
（自相矛盾 ⇒ error）；无合并时显示「没有发生置换合并（无需审计）」。

测试：新增 `merge-provenance.test.mjs` 4 用例（身份保留 / 出边来源 + validate / 有界 8 条 + 计数 9 /
JSON 往返）；`core` 既有合并测试照旧通过（结构语义没动）。

### C32 · 研究收口（G-2 负结论）+ 真实链路字段 gate

**① G-2 `derivable` 负结论（不适用）**：离线渲染 live 图（`session-d70b7c2f`，210 节点/228 边）并逐段核对
`renderLedger` 的注入内容 —— 热清单只有失败原因/约束原文/未验证状态/路径，摘要指令只有
ROOT+CONSTRAINTS+FAILED_ATTEMPTS，**两处都没有可再取的「工具输出体」** ⇒ 没有"先降级"的落点，
强加字段会变成无消费者的死数据。证据：`evidence/热清单内容普查-2026-11-02.md`；
候选 #17 在 research/00 §11 改为「✅ 不适用」。

**② 真实链路字段 gate**：`real-fold-trigger` 增加 `fold-fields` 断言 —— 真实模型路径上，每次 fold 的
`closure.nodes/edges`、`closure.preGraph/graphNodes`、`boundary.openAtEnd` 必须存在，且 `openAtEnd` 必须为 0；
缺字段或切开调用直接判 **fail**（不再只靠单测）。真机重跑：**6/6**，字段样例
`closure n/e=22/1 preGraph=false graphNodes=26 boundary={overlapping:1, openAtEnd:0, unsettled:0}`。

### C31 · 折叠边界完整性（切点不许落在工具调用中间）

**问题**：fold 在 step 边界执行，正常不会切开一次工具调用；一旦切开，摘要引用的调用其**结果落在区间外**，
模型回查时看到悬空 attempt。此前没有任何记录，只能事后猜。

**做法**：新增 `foldBoundaryOf(graph, range)`（纯函数）：`{overlapping, openAtEnd, unsettled}` ——
`openAtEnd` = 证据区间跨过 fold 终点的边数（正常应为 0）；`unsettled` = 区间内未结算边（只观测）。
三条记账路径（自动 fold / 溢出 / tier-2）都写进 `foldMark.boundary`。

消费者：`doctor` 新增「fold 边界完整性」（openAtEnd>0 ⇒ **error**；旧 fold 无字段 ⇒ 未采集）；
`live-folds` 证据页加"边界完整性"行（切点数 + 未结算边合计）。

测试：新增 `fold-boundary.test.mjs` 4 用例；`engine-harness` 的 foldMark 断言加 boundary
（并断言 openAtEnd=0）；`live-folds` L-2/L-3 同步。

### C30 · 闭包如实标注 preGraph（区间早于本图时，「可回查」不是承诺）

**问题**：C24 的闭包只记节点/边计数 + 首尾 id。重启续跑会话时，fold 覆盖的 seq 段可能**没有任何图节点**
（图是本次启动才建的），闭包 nodes=0 —— 但「0」看起来像「恰好没有实体」，而真相是「这段历史在图里根本不可回查」。
live 实测就出现过：一次 fold 遮蔽 163K token，闭包 0 节点。

**做法**：`foldClosureOf` 增加两个字段：

- `preGraph`：区间内 0 节点，且**区间结束早于全图最早节点**（或图里还没有任何节点）⇒ true；
- `graphNodes`：折叠发生时图里共有多少节点（区分「新图」与「有图但区间在前」）。

三个消费者：`live-folds` 证据页多一行 preGraph 计数；`doctor` 的保真度 detail 在 >0 时补
「N 次覆盖图外历史（无节点可回查）」；foldMark 自然落盘（每次 fold 都带）。

测试：`fold-closure` 新增 CL-5/CL-6（区间早于图 ⇒ preGraph；区间在图之后 ≠ preGraph；空图 ⇒ true；
有节点在区间内 ⇒ false）；`live-folds` 的 L-1/L-2/L-3 同步断言。

### C29 · 机器级层漂移观测（doctor 新检查 + 1 用例）

**问题**：`home/cordis.patch.yml` 是用户层 preset 行的副本（只换 compaction 成员）。用户在会话里改了
persona，home 层还是旧的 —— 下次启动会先看到旧 persona，直到退出时自愈才刷新。这属可自愈的中间态，
但巡检时看不出来。

**做法**：`doctor` 新增「机器级层与用户层一致（未漂移）」：用 `planHomePatch(profile, home).needed`
判断副本是否落后；落后判 **warn**（不判 error —— 自动机制会收敛），detail 写清「退出时自动刷新，下次启动生效」。

测试：`user-patch-heal` 新增 H-10（改人设 ⇒ 必须判漂移、新副本带新人设、旧人设不残留）。

### C28 · live fold 证据一键汇总（脚本 + 证据页 + 5 用例）

**问题**：`doctor` 只看最近几个数，`evidence/折叠成本-实测-*.md` 是手工抄的；每轮巡检要回答
「fold 有没有 trigger / quality / closure、成本效率多少」，靠手工必然漂。

**做法**：新增只读 `scripts/live-folds.mjs` —— 扫 `<DSH_HOME>/chess-context/sessions/*/graph.json`
的 `foldMarks[i]`，输出 `evidence/live-folds.json` + `.md`：覆盖率（trigger/quality/closure/usage）、
trigger 分布、质量下限、压缩比区间、幻觉探针累计、成本区间（input ÷ shadowed）、闭包空/非空计数；
证据页写明**生成时间**与生成命令；空 home / 坏 json / 无 fold 都不抛；`--dry-run` 不落盘。

**真机结果（2026-11-02T18:40Z）**：6 次 live fold / 12 个会话 —— usage 6/6、**trigger 2/6、quality 2/6**
（4 次是 1.17 之前的老 fold，字段还没上线）；质量 c=1 / f=1、压缩比 127.07–133.76、unknownIds=0；
成本 input/遮蔽 **1.43–1.81**；空闭包 2 次（新会话尚无节点，属正常）。

测试：`test/live-folds.test.mjs` 5 用例（字段与排序 / 覆盖率与区间 / Markdown 生成时间与明细 /
CLI 写盘与 dry-run / 空 home 不抛）。

### C27 · 「机器级层自动登记」：插件退出时自愈，下次启动接管

**问题**：profile 用户层 `cordis.patch.yml` 最后应用。GUI 的 preset 快照写着 `compaction-basic`，
把 bundle 层的引擎覆盖盖回去 —— 用户装完重启，插件 UI/工具都正常，但压缩其实还是官方的。

**为什么不能直接改用户层**：运行中写 patch 会整树热重载（本机两次事故）；而且改用户层等于改用户的定制。

**做法**：宿主还有一层**机器级 patch** `$DSH_HOME/cordis.patch.yml`，比 profile 层**更晚**应用
（`composeEntries([bundle 层, profile 层, home 层])`，已用宿主源码 + 离线组装验证）。
宿主 patch 语义只能「按 id 整值替换顶层/组内条目」，不能改嵌套 id、不能重命名 —— 所以：

- 插件在启动时算出「用户层里哪些 `preset-*` 行被写回了 compaction-basic」；
- 在 **进程退出时**（`process.on('exit')`，同步、原子、带备份）把这些 preset 行**原样复制**到 home 层，
  **只把 compaction 成员换成 `dsh-gokifu-compact/engine`** —— persona、工具开关、其它成员一个不动；
- 下次启动 home 层最后应用 ⇒ 引擎接管；**不需要任何命令**。
- 幂等：托管段每次重算，内容不变就不写；`DSH_GOKIFU_NO_HEAL=1` 可关闭。
- doctor / verify-install 改为三态：遮蔽 + 已登记 ⇒ ✓；遮蔽 + 未登记 ⇒ 提示「退出时自动登记，下次启动生效」。

离线验证（真实 profile，未重启）：把 plan 结果作为 home 层组装，`preset-standard` 的 compaction 变成
`dsh-gokifu-compact/engine`，persona 1192 字符与 22 个插件成员逐字保留。

**重启实测（2026-11-02 02:36，真机）**：主人重启后（新进程、新端口 56006）
`/gokifu/api` 报 **version 1.17.1**；`doctor` **0 错误 / 1 警告**（「用户层 patch 不遮蔽压缩引擎」= ✓
「已被机器级层接管」）；`verify-install` **19/19 全部通过**；`chess-context/sessions/` 恢复写入
（新目录 `session-8cc34e32…` 02:36:14）。⇒ 机器级层方案在真机上接管成功。

测试：`test/user-patch-heal.test.mjs` 9 用例（只换成员 / persona 逐字保留 / 空 home 生成合法 entry list /
已有 home 内容保留并备份 / 幂等 / 已是引擎不复制 / 真写盘 / 无用户层不凭空造 / 与检测器口径一致）。

## 1.17.0 — 2026-11-01（**未发布**：仅工作树，未 npm publish / 未打 tag）

> 本轮主题：**把「压缩产物能不能回查、记忆够不够」变成可观测 + 可解析 + 机械保真。**
> 全部改动只落在压缩本职（产自本次会话历史、只在压缩生命周期出现），不改工具契约 / 系统提示词 / AGENTS / 跨会话记忆。
> 边界成文法：`docs/压缩的职责边界.md`；调研蒸馏：`docs/research/00-蒸馏-对本插件的可执行结论.md`。

### C2 · 出处覆盖率收口成可观测指标（来源监控可量化）

- `engine.mjs`：`ledgerBudgetMetrics()` 增加 `provenanceCoverage`；新增纯函数 `accumulateLedgerBudget()`，
  累计 `provenanceMin`（下限，初值 1）与 `provenanceLow`（<1 次数）。
  **旧 `ledger-budget.json` 没有该字段时首累计按 1 起算** —— 不许把「没采集」误报成「出处全丢了」。
- 日志：只有 `coverage < 1` 才升 warn 并带数值；正常路径日志文案与旧版**逐字一致**（不刷屏）。
- `scripts/doctor.mjs`：热清单预算一节追加 `provenanceMin`；旧文件显示「未采集」。
- 为什么：出处（seq）是刻意保留的能力，很容易在追 token 预算时被悄悄优化掉；有了这个数字，
  任何「为省字符砍出处」的改动都会在测试与 doctor 里立刻显形。

### C3 · 省略行必须「能查到」（数量 + 区间 + 可解析位置）

- 热清单省略行、`renderFacts` 的 `FAILED_ATTEMPTS_OMITTED`、`DANGLING_RESIDUE` 三处统一：
  给出**相对化**的 `sessions/<sid>/graph.json` + `nodes/<id>.md` + 节点区间；
  没有 `treeDir` 时退化为 `graph.json`，**不许只剩泛称**。
- `renderFacts` 新增 `treeDir / traceRoot` 选项（默认空 ⇒ 行为不变），`engine.summarize` 传入会话目录。
- 相对化沿用 P6a 规则（`traceRelativeDir`）：**绝不把绝对路径写进热清单**（泄漏本机用户名/盘符且白烧 token）。
- 真实语料实测：11 会话 / 3509 tokens，与改动前**逐会话一致**（没有省略场景时零成本）。

### C4 · 折叠摘要机械追加「最近访问的文件」

- 新房间 `src/rooms/touched-files.mjs`：从图**边**的 `action` 机械解析 `read/edit/write/multi_edit/apply_patch`
  的 `file_path/path`（引号、空格、盘符、240 字符截断都覆盖）；只取 evidence 与本次 fold range 有交集的边，
  按最近访问倒序、按路径去重、上限 5。**不解析 bash 里的路径**（启发式猜出来的会污染事实清单）。
- `engine.summarize` 在「机械追加约束段」之后同样机械追加 `## 最近访问的文件（机械保留，不由模型改写）`。
- **只进折叠摘要（一次性），不进每步热清单**；只陈述「哪个文件、seq 区间」，不写「下一步该读哪个」。

### C5 · 「压缩产物交接测试」可执行化 + 它抓到的三个 live 缺口

- 新增 `scripts/handoff-check.mjs`：只读地把 `docs/压缩的重注入契约.md` 的七项契约 + 省略行可解析 + 预算，
  对 **live 每个会话的图**逐张判定（`--json` 机读；退出码：有 FAIL ⇒ 1）。
- 第一次跑 live（11 个会话）就抓到三个真缺口，同时修掉：
  1. **UNVERIFIED 在 L2+ 静默消失**（契约 ⑤ 违反）⇒ L2+ 保留一行计数 `UNVERIFIED: N unproven (latest eN)`；
     代价：有未验证声明的紧档会话可能 over-budget（实测 500→513，**有意权衡**，doctor 可见）。
  2. **失败边不是物理上一行**（多行 errorSnippet 把 `(seq …)` 挤到第二行）⇒ intent/reason 单行化；
     这是有意的字节变更，`hot-inject` 的 golden sha 已更新并写明理由（字符数不变 186）。
  3. **出处覆盖率口径错误**（把 OPTIONS/UNVERIFIED 算进分母 ⇒ live 恒 <1）⇒ 只统计失败边行，
     并区分「渲染器砍 seq」（fail）与「源边本来没有 evidence」（`evidenceMissing`，warn）。
- 结果：`handoff-check` live 从 **FAIL 11 / WARN 8** → **FAIL 0 / WARN 4**（剩余 warn 是两张开局无 user 节点的
  孤儿图和一次 over-budget，均已说明原因）。

### C5.1 · 独立验证后的 P2 收口（报告：`tmp/verify-round2/REPORT.md`）

独立验证（以 commit 冻结的干净 worktree 复验，不采用实现者自测）结论：**C2/C3/C4/C5 全部 PASS，P0=0 / P1=0**。
它指出的 3 个 P2 已在本提交收口：

1. **P2-1 doctor「未采集」误报 ok** ⇒ 旧 `ledger-budget.json`（无 provenance 字段）现在给 **warn** 而不是 ok；
   并防御 `provenanceMin<1` 但 `provenanceLow` 缺失/为 0 的跨版本混写（P3-1）。
2. **P2-2 UNVERIFIED L2+ 计数行无回归测试**（删掉整行全量仍全绿）⇒ 新增 `test/unverified-tier.test.mjs`：
   9 档预算逐一断言「有未验证边就不许沉默」「L0/L1 完整列表 + L2+ 计数行」「没有就别加假计数」「residue 不算」。
3. **P2-3 handoff-check ⑤ 假 warn**（`2fcebdc7` 的未验证边是 residue：facts 会列、热清单按 P6-A 排除）
   ⇒ 判据改为与 `renderLedger` 一致地排除 residue，并移除过时注释（P3-5）。修后 live = **FAIL 0 / WARN 3**。

### C6 · 保真度 L1 接进 fold 与 doctor（`fold-quality.mjs`）

- `src/rooms/fold-quality.mjs`（纯函数、零模型调用）：`constraintRecall`（最终产物里逐字出现的约束 ÷ 图里的约束）、
  `failureRecall`（本次 fold 区间内、最终产物里出现 edge id 的失败边占比）、`compressionRatio`（遮蔽 token ÷ 摘要 token）；
  过滤口径与 `renderFacts`/热清单一致（排除 residue；按 seq 区间取交集）；空集返回 1（不是 0）；`e1` 不匹配 `e12`。
- engine：每次 fold 把它写进 `foldMarks[i].quality`（含 expectedConstraints/expectedFailures/missing 列表）。
- doctor：新增「压缩保真度（最近 fold）」——`constraintRecall < 1` 判 **error**（丢约束=任务变了），
  `failureRecall < 1` 判 warn（丢失败边=必然重踩），并单独列出「丢失的约束 / 丢失的失败边」；
  老 foldMark 没有 quality ⇒ 明确写「未采集」，不报 ok。
- 测试：`test/fold-quality.test.mjs` 6 用例（逐字约束/边界匹配/区间过滤/residue/空集/模型 vs 最终产物）；
  engine-harness 扩 P2-2-1（foldMark 必须带 quality 且 recall 口径正确）与 P2-2-4（doctor 显示保真度、召回<1 升级告警并点名）。

### C7 · 保真度指标的「口径与覆盖」两个漏洞（规则降级模式 + token 单位）

`fold-quality` 接进 fold/doctor 之后暴露出两个会让指标**报假数**的漏洞（不是算错，是口径不对）：

1. **规则摘要 / 全挂降级 fold 的 `quality` 永远是 null**：`_lastSummaryText` 只在模型路径设置，
   于是 `summaryMode: rules` 与 hybrid 全挂后的降级路径，doctor 只能写「未采集」——
   而「降级路径有没有丢约束/失败边」恰恰最该被机器证明（规则摘要是机械生成的，recall 应恒为 1）。
   修法：把摘要文本记账收进 `ruleResult()`，降级分支复用同一个 `ruleResult()`。
2. **`summaryTokens` 用 `Math.ceil(summaryChars/2)` 粗估**：对 ASCII 重的摘要系统性高估 token ⇒
   `compressionRatio`（遮蔽÷摘要）被系统性低估。修法：不传 `summaryTokens`，让 `fold-quality`
   用与热清单/bench 同一套 **CJK 感知口径**（CJK 1 token/字 + 其余 1/4）现算。

测试：`fold-quality` 增 Q-7（混合文本 88 单位 = 22 tokens，明确 `ne` 掉 chars/2 的旧口径）；
engine-harness P2-2-1 增「compressionRatio 必须严格等于 shadowed/summary」；P2-2-2 增
「规则降级 fold 必须带 quality 且 constraintRecall = 1」。

**C7.1 顺手修掉发布门禁里的一条假警告**：`scripts/bench-repro.mjs` 对 2000 边夹具在 L5 下必然省略 1191 条边，
旧文案会打 `[WARN] 降级不应丢边` —— 但 L4/L5 的省略是**设计**（清单里有汇总行指向 graph.json），
真正要防的是**静默省略**（由 `ledger-boundary` J/K 与 `handoff-check` ⑧ 守住）。
改成中性 `[INFO]`，让这条门禁不再"狼来了"；同时把脚本头部示例里的旧基线 351 对齐到 446。

### C8 · 保真度的「真值链路」跑通了：real-fold-trigger 现在能验证（更正上一轮结论）

上一轮把「real-fold-trigger 不能验证保真度」写进了文档。诊断对了（keeper 没跑），**结论下早了**：
问题不是「没法验证」，而是「手写桩没把事件派发出去」。

- `session.append()` 里加 `session._emit(event)` → `buildCtx()` 接成 `ctx.emit("session/event", session, event)`
  —— engine 的 keeper 正是注册在这里；
- 补一条**失败的**工具调用 + 紧随一个 `step/end`（keeper 在该步建 agent 节点并把边指向它；
  否则边一直 `to=null`，10 分钟后被判成 rewash 残留，保真度统计不到它）；
- 校验改成看**所有** foldMark（增量 fold 的早期 range 才包含那条失败边），并优先读引擎内存图
  （落盘是 debounce/idle 触发的，进程退出时盘上可能是旧快照）。

实测（真实模型，3 次 fold）：`fold#1 quality: c=2/1 f=1/0` —— **期望约束 2 / 期望失败边 1，不再是真空通过**。
**证据边界**：本文件的 `ctx.llm` 是桩（自己拼 prompt，不用引擎的棋谱指令），所以 `constraintRecall=1`
是引擎机械追加保证的（有效），`failureRecall` 受桩 prompt 影响、**不代表生产**；它证明的是
`engine → keeper → fold-quality → foldMarks` 这一段真的在跑。证据：`evidence/fold触发验证.{json,md}`。

### C9 · 把保真度/幻觉探针接进「交接门禁」

`handoff-check` 原来只查重注入契约 ①–⑨；`fold-quality` 落地后 `foldMarks[i].quality` 已是图的一部分，
门禁必须一起看 —— 否则「交接合格」可能掩盖「约束/失败边丢了、或者摘要编造了 id」。

- 新增 **⑩保真度**：最近一次有质量样本的 fold —— `constraintRecall < 1` ⇒ **fail**（丢约束=任务变了，并点名）；
  `failureRecall < 1` ⇒ warn（并点名丢失的失败边）；`expectedConstraints/expectedFailures` 全 0 ⇒ warn「真空样本」。
- 新增 **⑪幻觉探针**：`findUnknownIds` 的 `unknownIds` 非空 ⇒ warn 并点名「摘要提到但图里没有的 eN/nN」。
- 噪声控制：**没有 fold 记录**的会话 ⑩/⑪ 直接 ok（不给没压缩过的会话加告警）；有 fold 但缺 quality ⇒
  warn「旧版本折叠，升级后会自然出现」。
- 测试：`test/handoff-check.test.mjs` 7 用例（健康样本 / 丢约束 fail / 丢失败边 warn / 真空 warn /
  未知 id warn / 无 fold 不告警 / 旧折叠缺 quality warn）。

live 复跑：FAIL 0 / WARN 6（2 张无 user 节点孤儿图 + 3 个旧折叠缺 quality + 1 次 over-budget，均可解释）。

### C10 · 记录「模型自己的约束召回」（去掉机械兜底后还剩多少）

`constraintRecall` 量的是**最终产物**，而约束是引擎在模型输出之后**机械追加**的 —— 所以它恒为 1，
回答不了「模型自己保住了多少」。`modelConstraintRecall`（只对模型输出那部分算）此前在生产路径上恒为 null，
因为这个字段只有单测传了 `modelText`。

- engine.summarize：在 push 机械段（约束 / 最近访问文件）**之前**留一份纯模型文本 `modelText`，
  随其他 `_lastSummary*` 一起交给 `#commit` → `measureFoldQuality({ modelText })`；
- 规则摘要路径**显式清空** `_lastSummaryModelText`（没有模型输出，不许把上一次 fold 的值串过来）；
- 现在 `foldMarks[i].quality.modelConstraintRecall` 是真实数字，doctor 的「压缩保真度」已经会显示
  `模型自身约束召回 x`（C6 就留好了位置，只是此前永远是 null）。

测试：engine-harness P2-2-1 增「hybrid fold 必须有 0–1 的 modelConstraintRecall」；
P2-2-2 增「规则摘要的 modelConstraintRecall 必须 null（不许串味）」。

### C11 · tier-2 合并也记保真度（压缩生命周期全覆盖）

tier-2（合并最老两个 checkpoint）走的是自己的记账路径，`foldMarks.push({tier2:true})` **没有 quality** ——
于是「保真度」只覆盖常规 fold，医生对 tier-2 合并只能「未采集」。它同样是压缩生命周期的一部分，同样产出摘要。

- `#tier2IfNeededUnsafe`：合并成功后读 `_lastSummaryText/_lastSummaryModelText` → `measureFoldQuality({ graph, range:{start,end}, summaryText, modelText })`，
  写入 `foldMarks[i].quality` 与 `summaryChars`；
- 同时把 summarize 留下的 pending 摘要字段**消费掉**（谁生产谁消费；此前 tier-2 会让这些字段一直挂到下一次常规 fold，
  虽然会被覆盖，但两处生命周期共用一组字段本身就是隐患）。
- 测试：`tier2.test.mjs` T2-1 增「tier2 foldMark 必须带 quality / constraintRecall 是数字 / summaryChars > 0」
  （并沿用 P2-2-1 的办法先手动调一次 summarize，让 pending 文本有值）。

### C12 · 「为什么压」也变成可观测：foldMark.trigger + doctor 触发原因分布

此前每个 fold 只知道「压了」，不知道**是到阈值正常压（pressure）、还是上下文已经溢出后的被迫自救（context-overflow）、
还是 checkpoint 合并（tier2）**。后者是最该早发现的健康信号：overflow 出现 = 压缩没跟上上下文增长。

- `foldMarks[i].trigger`：`compactIfNeeded` 把收到的 trigger 原样记下；tier-2 合并记 `"tier2"`；
- doctor「最近 5 次 fold」行内显示 `触发 <reason>`；新增「fold 触发原因」分布行，
  出现 `context-overflow` ⇒ **warn** 并写明「已被迫自救，说明压缩没跟上增长」；
- 测试：溢出自救用例断言 `trigger=context-overflow`；P2-2-1 断言常规 fold `trigger=pressure`；
  T2-1 断言 tier-2 `trigger=tier2`；P2-2-4 断言 doctor 显示与 overflow→warn。

### C13 · 交接门禁补 ⑫触发原因（overflow = 压缩没跟上增长，是 per-session 告警）

C12 让 doctor 看到 fold 触发原因；门禁也必须看 —— 对一个**具体会话**而言，`context-overflow`
（上下文已溢出、压缩被迫自救）是「压缩健康」的直接告警，不是全局统计问题。

- `handoff-check` 新增 ⑫：分布显示 `pressure=… / context-overflow=… / tier2=…`；
  出现 `context-overflow` ⇒ **warn** 并写明「压缩没跟上增长」；有 fold 但缺 trigger ⇒ warn「旧版本折叠」；
  没有 fold 的会话 ⇒ ok（不加噪声）。
- 测试：`test/handoff-check.test.mjs` 增 H-8/H-9/H-10（pressure 分布 / overflow warn / 缺 trigger 与无 fold 的区分）。

### C14 · 手动 `/compact` 也记账（最后一条没有保真度样本的压缩路径）

自动 fold / 规则降级 / tier-2 / 溢出都有 `foldMark` + 保真度样本，只有**手动 `/compact`** 没有：
它走 `compactNow → compactRegion`，不经过 `compactIfNeeded`，所以连 `foldMark` 都不写。
用户手动压一次，doctor/handoff-check 完全看不见。

- `compactNow` 包装：进入时置 `_manualCompactDepth`，成功后用 `recordFoldMark(session, {range, trigger:"manual"})` 记账；
- `compactRegion`：手动深度 > 0 时记下本次区间（`_manualRange`），供 `recordFoldMark` 用；
- 新增公开方法 `recordFoldMark()`（测试接缝，与 `consumeLedgerBudget` 同性质）：消费 summarize 留下的
  pending 摘要文本 → `measureFoldQuality` → 写 `quality`/`summaryChars`/`trigger` → 裁剪到 `FOLD_MARKS_KEEP` → 落盘；
- 至此 **5 类压缩路径全部有保真度样本**：自动 fold / 规则降级 / tier-2 / 溢出 / 手动。
- 测试：engine-harness 增 C14（手动记录 must be 有内容：期望约束 ≥ 1、recall = 1、pending 被消费、落盘可查）。

### C15 · 「压缩不得越权」变成机器审计（首跑抓出 2 条真实残留）

`docs/压缩的职责边界.md` 是成文法，但此前只有**人工**审计 —— 连续多轮快速改动后一定会漏。

- 新增 `scripts/boundary-audit.mjs`：只扫**字符串字面量**（先剥注释，避免「注释里引述旧版越权文案」假红），
  两条规则：①行为指导（`下一步：`/`不要重试`/`you should`/`continue or abandon`…）②工具治理
  （`permission: allow|ask|deny`/`approval:`/`sandbox_permissions`）。唯一豁免是 `facts-prompt.mjs` 的
  摘要模型指令（写在脚本 `ALLOW` 里并注明理由）。
- **首跑抓到 2 条**：
  1. `ledger.mjs` 的 `STALE_UNSETTLED … listed as OPTIONS (continue or abandon)` —— 上一轮清理 OPTIONS 时
     漏在**事实块**里的真实越权（行动许可），已改 `(not yet landed)`；
  2. `engine.mjs` 规则摘要小标题 `## 当前节点与下一步` —— 内容早已改成「最近一条用户消息」事实，
     标题是旧版残留（会误导读者以为压缩还在给行动建议），已改 `## 当前节点与最近用户消息`，
     同步 `real-e2e` / `real-model-scenarios` 两处引用。
- 测试：`test/boundary-audit.test.mjs` 5 用例（中英文指导都抓、注释不抓、工具治理、豁免粒度、真实仓库 0 条）。
- 接入发版验收：四步 → 五步（加 `boundary-audit`）。

### C16 · 路径里标出「重访过的状态」（×N）—— 循环第一次在热清单里可见

调研候选 #15（`reentryCount`，来自 05 §3.2/§5.3「most-used 的符号版」）的最小落地：
图里本来就有 `node.transpositions`（`mergeNodeInto` 记的「同一状态被另一条路径再次到达」次数），
但热清单**从来没显示过它** —— 模型看到一长串路径节点，不知道自己在原地打转。

- `renderLedger`：CURRENT PATH / WORKING 行的节点标签追加 `×N`（N = 总到达次数 = transpositions + 1）；
- **只陈述图结构事实**：显示「这个位置被到过 N 次」，不写「你该换条路」（行动判断归模型/AGENTS）；
- 零成本：只有真的重访过才有字符，正常会话逐字节不变（测试钉住「没有重访不许出现 ×」）；
- `# path:` 的 L4/L5 极度压缩形态不标（那里先保「当前位置」本身）；
- 测试：ledger-boundary 增 M（重访 → `n2×2`；无重访无 ×；不许 ×1；不许夹带「不要/建议」字样）。

### C17 · 「这条失败后来被同一命令跑通了」—— 因果配对第一次进热清单

05 号调研的结论：**因果配对（「这个报错在改 X 之后消失」）是这类系统唯一无法重建的东西** ——
文件可再读、命令可再跑，但「同一个 action 后来成功了」只存在于历史里。
此前热清单只列失败边，模型会以为那条路仍然堵着。

- `renderFailureLine` 新增可选参数 `resolvedBy`：若同一 `action` 的**成功边发生在更晚**，
  行尾标 `↑later-ok:<边id>`（只给可回查的边 id）；
- `renderLedger` 建一次成功边索引，逐行做一次查询（零模型调用）；`laterSuccessOf()` 导出可单测；
- **只陈述事实**：不写「你应该去试」；成功在失败之前、或 action 不同 ⇒ 不标；
- 成本：live 11 会话实测 **+11 tokens**（4/33 失败边命中），2000 边夹具 446 不变（夹具 action 唯一）；
- 测试：ledger-boundary 增 N（同 action 后来成功 → 标记；成功在前 / 不同 action → 不标；不含建议字样）。

### C18 · 失败边的「重试计数」↻k（调研候选 #15 收尾）

同一 action 在同一段历史里失败过 k 次，此前要模型自己比对多行才能看出来；现在直接标 `↻k`。
这是**计数事实**（这条命令被反复试过），不是「别重试」的指令 —— 行动判断仍归 AGENTS/persona。

- `renderFailureLine` 新增 `retried` 参数：k ≥ 2 时行尾标 `↻k`；
- **只标同 action 组里最近的那一条**（每条都标会白烧 token、计数还是同一个数字）：
  2000 边夹具先按「每条都标」试过是 **+12 tokens**，改成只标最近一条后 **+1 token**；
- 测试：ledger-boundary 增 O（↻2 出现且只出现 1 次 / 不许 ↻1 / 不许变成「不要重试」指令）；
- 基线更新：bench-repro `EXPECTED_TOKENS 446 → 447`、README 顶部数字同步（+1 的来源写明是 ↻k）。

### C19 · 补手动压缩的接线测试 + 版本号 bump（1.16.0 → 1.17.0）

两件收尾工作：

1. **补 C14 的接线测试**（此前 `recordFoldMark()` 有测试，但「`compactNow` 真的会调到它」没有覆盖）：
   在 engine-harness 里临时替换桩基类的 `compactNow` 模拟宿主（算 range → 调 `compactRegion` → 返回成功），
   断言 `foldMark.trigger="manual"`、区间正确、pending 摘要被消费。这是 C14 唯一没被钉住的接线。
2. **版本号 bump**：`check-maintenance` 报「改了 24 个代码文件但 version 还是 1.16.0」——
   后果是 **git 源的用户永远停在旧 commit**（magpie 按版本号判断有没有更新）。
   `package.json` / README 当前版本 → **1.17.0**，并明确标注**未发布**。
   bump 后 `check-maintenance` 只剩 1 项预期失败：「1.17.0 没有 tag」= 尚未发版；
   **打 tag / npm publish 需主人授权**，本轮不做。

### C20 · fold 的「成本效率」可观测（摘要输入 ÷ 遮蔽）+ 三次 live fold 的实测账

从 live `foldMarks[i].usage` 拉出三次真实 fold 的账（`evidence/折叠成本-实测-2026-11-02.md`）：

| # | 遮蔽 | 摘要输入 | 输出 | 输入/遮蔽 | 耗时 |
|---|---:|---:|---:|---:|---:|
| 1 | 112,024 | 178,750 | 2,310 | 1.60 | 16.4 s |
| 2 | 81,941 | 133,852 | 3,004 | 1.63 | 19.0 s |
| 3 | 83,044 | 118,992 | 362 | 1.43 | 5.0 s |

**关键事实**：摘要请求读的**不是被折叠段，而是整个 surface** —— 读 1.4–1.6 倍才压 1 倍；
输出很小（362–3,004），**瓶颈在「读」不在「写」**。所以 fold 成本随触发点变晚而变贵，
优化应先减输入而不是压输出预算。

- doctor 新增「fold 成本效率（摘要输入 ÷ 遮蔽）」：显示 min–max，**比值 ≥2 判 warn**
  （「读两倍才压一倍：检查触发点是否太晚 / 增量范围是否切得太碎」）；老 foldMark 无 usage ⇒「未采集」；
- 测试：P2-2-4 增（0.10 → ok；变异成 5.0 → warn 且说明含义）。

### C21 · 小窗口下的 headroom 封顶（07 调研发现的真实缺陷：≤73K 窗口压缩直接抛错）

07 号调研（`docs/research/07-trigger-and-budget.md`）对照生产实践时发现：
**`headroomTokens` 是绝对值（默认 65536），在小窗口上会吃掉阈值** ——

| 窗口 | 修前有效阈值 | 修后 |
|---|---|---|
| 200K | 45% | 45%（不变） |
| 128K | 42.4% | 45% |
| 100K | **26.3%**（过度提前压） | 45% |
| ≤73,728 | **直接抛错**（压缩完全不可用，上下文只增不减） | 45% |

- `resolveSpec`：headroom 按 `messageBudget × 25%` 封顶（`HEADROOM_MAX_RATIO`）。
  大窗口行为完全不变；小窗口回到 `thresholdRatio` 的比例语义，且不再抛错；
- 测试：engine-harness 增 **S4-5**（100K 窗口 + 30K 占用 ⇒ 阈值 45K，不该 fold；64K 窗口 ⇒ 不抛错）；
- 07 调研结论同时沉淀：`thresholdRatio 0.45` 可保留（其合法性来自**增量 fold**，不是 45% 本身更优）；
  「提前算好」在生产产品里也没做成（Codex 的 prefix 预热 PR 已关闭）；成本函数是「fold 频次 × 单次读入」，
  已由 `minFoldTokens` / `growthFloor` 兜住。

### C22 · 巡检第 2 次：门禁全绿，修掉三处过期文档数字

连续多轮改动（C16–C21）之后用**同一套门禁**重新核一遍（`evidence/巡检-第2次-2026-11-02.md`）：

| 门禁 | 结果 |
|---|---|
| 全量单测（串行独占） | **668 / 0 / 0** |
| bench-repro | **447 tokens** · 失败保留 **8/8** · exit 0 |
| handoff-check（live） | **FAIL 0 / WARN 9** |
| boundary-audit | **0 条** |
| check-maintenance | 8 通过 / 0 警告 / **1 预期失败**（1.17.0 无 tag = 未发版） |
| doctor（live） | **0 错误 / 5 警告**（跨日 + 旧 foldMark 未采集 + 既有 over-budget，逐条已解释） |

**修掉的过期数字**（文档与实测不一致）：
- `README.md` 顶部「615 项单测」→ **668**；
- `HANDOFF.md` 1.17.0 行「634 passed」→ **668**；
- `00 蒸馏 §10` 落地表只到 C17 → 补齐 **C18–C21**（含各自验证证据）。

**没有发现新的代码回归。**

### C23 · 文档索引 + 「新增文档必须登记」的机器检查

调研/证据文档是这个项目的主要产出，但散在 `docs/research/`（8 份）与 `evidence/`（20 份）里 ——
东西一多就会出现「写了但没人知道它在」的**孤儿文档**，而人肉维护索引一定会漏。

- 新增 **`docs/research/README.md`**：00–07 的唯一入口（每份一句话结论 + 它贡献了哪些候选/落地项 +
  必须先读的三份成文法）；
- 新增 **`scripts/docs-index-check.mjs`**：两个目录各以 `README.md` 为索引，
  **除索引外每个 .md 的 basename 都必须出现在索引里**，否则 exit 1 并点名；
- 补 `evidence/README.md`：新增 `折叠成本-实测` 与 `巡检-第2次` 两行、把 bench 数字 446 → **447**、
  补登记三份此前漏掉的历史证据（真实进程首次fold / 重启验证 / 评估报告）；
- 测试 `test/docs-index-check.test.mjs` 4 用例（缺失能抓 / 目录列举口径 / 真实仓库 0 缺失 / 索引文件必须存在）；
- 接入发版验收流程（五步 → 六步）。

### C24 · 可寻址闭包：每次 fold 记下「覆盖了图里哪些节点/边」

04 号调研的 D1（「派生件带闭包」）与 00 候选 #12（可寻址闭包）的最小落地。
被遮蔽的原文在 append-only 日志里按 seq 可回读；但从摘要/热清单看到的 `n41`、`e88`
属于**哪一次 fold**、原始 seq 落在哪，此前只能靠 `foldMarks` 的区间自己推。

- `kifu-model`：新增 `foldClosureOf(graph, range)` —— 返回本次折叠区间内的
  **节点/边计数 + 首尾 id**（不存全量列表：一个 fold 可能覆盖几百个实体，全存会让 graph.json 膨胀；
  首尾 id + seq 区间已足够定位）；空区间返回 0（不是 null），非法 range 返回 null；
- engine：**三条 fold 记账路径都带 `closure`**（常规 fold / tier-2 合并 / 手动压缩）；
- doctor：「最近 5 次 fold」行内显示 `closure <nodes>n/<edges>e`（老 foldMark 无该字段 ⇒ 不显示）；
- 测试：新增 `test/fold-closure.test.mjs` 4 用例（区间过滤 / 首尾 id 正确 / 空区间与非法 range / 纯函数+可序列化），
  engine-harness P2-2-1 与 C14、tier2 T2-1 各加「必须带 closure」断言。

### C25 · 最终验收快照（六道门禁 + live 现状 + 发版待办 + 已知缺口）

`evidence/最终验收-2026-11-02.md` 把当前真实状态一次写清（以后接手先看它 + HANDOFF 顶部）：

- 六道门禁：**676 测试 / bench 447·8-8 / handoff FAIL 0 / boundary 0 / docs-index 0 / doctor 0 错 5 警**；
- live：11 会话 / 555 节点 / 672 边 / 自环 0 / 热清单 3543 tok；3 次历史 fold 全为旧版本（`quality/trigger/closure` 尚未产生）；
- 版本 **1.17.0 未发布**：tag / npm publish 两步待主人授权（按铁律不由我触发）；
- 已知缺口诚实列出：live 真值样本、`#9/#11/#17` 未做、`#12` 仅最小版。

### C26 · 实机事故：用户层 patch 遮蔽压缩引擎 —— 加检测 + 修复脚本

**现象**：重启 1.17.0 后，插件 UI 正常（`/gokifu/api` 报 version 1.17.0、mounted）、工具齐全、
`doctor`/`verify-install` 全绿 —— 但 `chess-context/` 不再落盘，会话里跑的是官方压缩。

**根因**：`profiles/desktop/cordis.patch.yml`（**用户层 patch，最后应用**）里有一份 `preset-standard`
快照，写着 `@deepseek-ai/dsh-compaction-basic`。用户层在 bundle 层之后应用 ⇒ 把插件
cordis.patch.yml 里「换成 `dsh-gokifu-compact/engine`」的覆盖又盖回去了。
（这份快照由 GUI 的预设编辑/快照机制生成；`cordis.patch.yml.pre-v33.bak` 等备份即其痕迹。）

**修法（两条）**：

1. **检测**（不能再静默绿）：`preset-format.mjs` 新增 `findShadowedUserPresets(patchText)`；
   `doctor` 新增「用户层 patch 不遮蔽压缩引擎」（error）；`verify-install` 新增同项检查。
   live 上立刻从「全绿」变为准确报错 1 项。
2. **修复**（按本机铁律：不在会话里直接写 profile patch）：生成
   `home/.gokifu-fix-2026-11-02/{cordis.patch.yml.fixed, apply-fix.cmd, rollback.cmd, README.txt}`
   —— 只改 2 行（preset-standard 的 compaction 成员 → engine），脚本要求 DSH 完全退出后运行，
   自动备份 → 原子替换 → 校验 → 失败自动回滚；幂等（已修好会直接提示无需操作）。

测试：新增 `test/user-patch-shadow.test.mjs` 5 用例（顶层 preset 才认 / 引擎干净不误报 /
多 preset 只报坏的 / 缩进 id 不制造假 preset / CRLF）。

### C26.1 · 事故收尾：教训入库 + 验收口径补「最后生效的那一层」

- `docs/工程教训集.md` 新增 §9「验证 patch 时，要验最后生效的那一层」：记录本次假绿
  （`verify-install` 18/18 全绿但引擎被用户层 patch 遮蔽），并给出判据与检测入口；
- `docs/压缩的重注入契约.md` §6 发版验收流程补 `verify-install`（19 项，含用户层遮蔽检查），
  并注明「只看包内 patch 会得到假绿」；
- 修复包新增 `verify-after-restart.cmd`：重启后双击即可跑 `verify-install` + `doctor` 两条门禁；
- HANDOFF 增加「⏳ 当前待办」行（等主人退出 → 跑 apply-fix.cmd → 启动 → 复核）。

### 验证

- 全量 `node test/run.mjs`（串行）：**681 passed / 0 skipped / 0 failed**
- `doctor`（live）：**1 错误 / 4 警告** —— 该错误即本条事故的真实状态，修复脚本跑完并重启后应变绿
- 六道门禁与 live 数据见 `evidence/最终验收-2026-11-02.md`
- `docs-index-check`：27 个文件 / **0 个未索引**
- `check-maintenance`：8 通过 / 0 警告 / **1 失败（1.17.0 无 tag，预期）**
- `boundary-audit`：0 条；`bench-repro`：447 / 8/8 / exit 0（1.16.0 时 615；本轮与并行会话共新增 23 条）。
- 定向：`ledger-boundary` 8/8、`touched-files` 9/9、`unverified-tier` 3/3、`engine-harness` 45/45（含新增 P7-5、C4 两条）。
- doctor（live home）：0 错误 / 1 警告；该警告 `over-budget=5` 经归因为 21:51 重启后**既有行为**，非本轮回归。
- 独立验证（`tmp/verify-round2/REPORT.md`）：全量 634/0/0（ed3e5b1 干净 worktree）、C2/C3/C4/C5 逐项 PASS、
  边界审计无新增行为指导、预算 C2/C3/C4 逐会话 0 token。

## 1.16.0 — 2026-11-01

> 本轮主题：**压缩方法就是替换官方压缩 —— 不再需要一个叫 gokifu 的模式。**
> 触发：装上之后用户在 DSH 里选了内置的「标准模式」，压缩仍然是官方的 `@deepseek-ai/dsh-compaction-basic`
> —— 本插件此前只在自己那个 `gokifu` preset 里生效，换个模式就把压缩换回去了。

### 改了什么

**bundle patch 按 id 整体覆盖四个官方 agent preset 的 `config`**，把每个 preset 的 compaction group 里
`@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine`：

```
- insert:
    - id: gokifu-ui                     # ① UI host 行（/gokifu/api + 设置页）
      name: 'dsh-gokifu-compact'
- id: preset-standard                   # ② 四个官方模式整体覆盖
  config: { id, order, plugins: [...] } #    plugins 逐字保留，只换压缩引擎那一行
- id: preset-ptc
- id: preset-minimal
- id: preset-cordis
```

- **不新增 preset**、**不改 `agent-preset-registry` 的默认 preset**、**不动选择器** —— 四个模式还是那四个模式，
  只是压缩后端换成棋谱（失败记忆逐字保留、每步热清单、置换检测、压缩永不裸截断）。
- 新增生成器 `scripts/make-presets-override.mjs`：从宿主 asar 读官方 preset 原文，
  **文本级**改写（绝不 YAML round-trip），产出 `cordis.patch.yml`；DSH 升级后重跑再发版。

### 为什么不能用「新增 preset」或「运行时接管」

1. **新增 preset（1.15.0–1.15.2 的做法）**：用户得手动切模式，换了模式就换回官方压缩 —— 与「这是替换官方压缩」的产品定位相反。
2. **运行时接管（2026-11-01 开发中方案，已否决）**：在 `apply` 里拿 `agentPresets` 注册表，改完 `definition.plugins` 再
   `activate()` 重挂 generation。**实测事故**：应用后重启，会话里 `bash`/`read`/`write` 等 preset 内工具全部消失
   （只剩宿主级工具）＝ preset 生成树挂载失败。假 service 单测测不出真实 `activate()` 的副作用。
   代码已 stash 留档（`wip:R17-takeover（事故，留档）`），**不合并**。
3. **patch 为什么只能整体覆盖**：`dsh-app-boot` 的 `applyEntryPatches()` 建 id 索引时只递归
   `entry.group === true && Array.isArray(entry.config)` 的行；preset 行是 `@deepseek-ai/dsh-agent-preset`，
   它的 `config` 是**对象**、`plugins` 在对象里 ⇒ patch 的 id 索引到不了 preset 内部的 compaction 行。
   实测 `--dump-config`：顶层（dsh-base 层）有一份 `compaction-basic`，四个内置 preset 内部各有一份。

### 为什么生成器是「文本级」而不是「YAML 解析 + 重新序列化」

官方 preset 里有 `disabled: !!js process.platform === 'win32'` 这类表达式。一旦 `yaml.load → yaml.dump`，
`!!js` 标签会退化成普通值，宿主不再按表达式求值 ⇒ `tool-bash`/`tool-pwsh` 的启停直接改变。
所以生成器只做按行处理：定位 `^ {6}config:` 取 config 块（统一减 4 空格重排），只替换
`- id: compaction-basic` 与紧邻的 `name:` 两行；自检里有一条硬断言：**`!!js` 表达式数量必须与官方四个文件之和完全一致**。

### 验证（隔离实例，2026-11-01 21:4x）

隔离 profile（`dsh-base` + `dsh-web-app` + 本包，独立 `DSH_HOME`，未碰 live）：

1. `--dump-config`：`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 四行全部带
   `name: dsh-gokifu-compact/engine`，预设内部 `compaction-basic` 归零（顶层 dsh-base 那份保留，属 headless 路径）。
2. 起实例 → `POST /gokifu/api {"action":"health","profile":"bprobe"}` → `installed:true / mounted:true / notInBundles:false`。
3. 用 DSH 自有 HTTP RPC 建会话（`agentPreset: "standard"`）+ 真实回合：
   - **工具齐全**：模型成功调用 `pwsh` 工具并拿到输出（`hello-from-bplan`）—— 这是 1.16 方案相对运行时接管的关键回归；
   - **GOkifu 引擎在岗**：`<home>/chess-context/sessions/<id>/graph.json` 落盘，含 user/agent 节点与带 `verify` 的边。
4. **卸载回退**：把本包从 `dsh.profile.bundles` 与 `dependencies` 移除 → `--dump-config` 里
   `gokifu-compact/engine` 归零、四个 preset 内部 `compaction-basic` 全部回来 ⇒ 干净回退，无残留。
5. **真实压缩（fold）**：给隔离实例的引擎行加小阈值（`thresholdRatio: 0.004 / firstFoldRatio: 0.002 /
   retainRatio: 0.001 / minFoldTokens: 200`）后连发三条长 prompt，会话日志出现
   `compaction/start` → `compaction/summary` → `compaction/end`，`graph.json` 的 `foldMarks` 写入
   `{seqStart:8, seqEnd:9, shadowedTokens:8093, totalAfter:9844, foldCount:1, ms:7476,
   usage:{inputTokens:16595, outputTokens:934}}` ⇒ **压缩事件确实走 GOkifu 的棋谱摘要**，不是官方 8 段模板。

6. **官方安装流程**：干净 profile（只含 `dsh-base` + `dsh-web-app`）跑
   `dsh plugin --profile installprobe add D:/主工作区/repos/dsh-GOkifu-compact` —— 依赖自动写入、
   **`dsh.profile.bundles` 自动追加本包**，随后 `--dump-config` 里四个 preset 行全部带引擎行。
   GUI 插件市场点「安装」走的是同一条通道，所以「一键安装、无需手改 YAML」成立。

单测：`node test/run.mjs` = **615 passed / 0 skipped / 0 failed**（串行；改 `bundle.test.mjs` B-2 为「UI 行 + 四个 preset 覆盖」的断言）。

### 已知代价与边界

- preset 清单是**宿主版本快照**：DSH 升级后必须重跑 `node scripts/make-presets-override.mjs --write` 再发版。
- 1.15.x 装过 `preset-gokifu` 的 home：升级后该 preset 消失，**已经切到 standard 的会话不受影响**；
  若某会话 header 里 `agentPreset` 仍是 `gokifu`（1.15.0–1.15.2 期间创建且从未切换过），重建时按投影值取，
  升级前建议扫一遍会话日志确认（脚本见 HANDOFF「升级前必查」）。
- **桌面 live 已生效**（21:51 重启后）：本会话（preset 投影 = `standard`）的 `chess-context` 里
  graph 66 节点 / 71 边 / `foldMarks` 1 条，`graph.json.delta.jsonl` 实时更新，注入消息里带 `<chess-ledger>`
  ⇒ 标准模式确实由 GOkifu 引擎压缩。
- **未验证**：GUI 插件市场点「安装」的完整点击流程（安装通道本身有 B-4 测试，且 live 的 profile 已是
  「bundles 含本包」的状态）。

## 1.15.2 — 2026-11-01

> 小版本：**新会话选择器里那个「gokifu / 暂无描述」补上描述**，并把生成器自检口径修正。

### 改了什么

1. preset 声明里写入 `description`（registry 的 `list()` 会读它，新会话选择器直接显示）：
   `棋谱式上下文压缩 — 替换内置 compaction-basic：失败记忆逐字保留、每步热清单、置换检测；压缩永不裸截断。`
   - 生成器默认带这段文案；`node scripts/make-preset.mjs --bundle --write --description '...'` 可覆盖。
2. 校验器口径修正（真 bug）：`validatePresetPatch` / `validateBundlePatch` 原来对 `compaction-basic`
   做**任意子串**判红 —— 描述里写「把 compaction-basic 换掉」就会被自己误杀。现在只认
   `- id: compaction-basic` 这种**行 id**；测试里两处 `notIncludes(body, "compaction-basic")` 同步改成行 id 判定。
   为什么值得单独说：这条误杀会让**任何带解释性描述的生成物都产不出来**，是隐藏的自锁。

### 验证

- 全量单测 **617 passed / 0 skipped / 0 failed**（54 文件）。
- 生成物：`cordis.patch.yml` 7910 B，`description` 在 preset config 里（第 19 行）；
  32 条官方插件行仍逐字保留、无 `- id: compaction-basic`。
- ⚠ 描述要**重启 DSH 后**才出现在选择器里（bundle patch 只在启动时读）。

---

## 1.15.1 — 2026-11-01

> 1.15.0 的**安装路径回归修复**（1.15.0 已发出去，只能往上补一版）。

### 修了什么

1.15.0 把 preset 声明并进本包后，`findPresetFiles` / `presetsWithCompaction` 已经能在
「只有本包、没有旧 preset bundle」的 home 上发现它 —— 但旧一代的**早退分支**没改：

```js
const root = nodePath.join(dshHome, "preset-bundles");
if (!nodeFs.existsSync(root)) return [];   // ← 新式 home 根本没有这个目录，直接返回 []
```

⇒ 全新安装（profile 里只有 `dsh-gokifu-compact` 一个包）时，唯一那份 preset 声明被这行
`return []` 吞掉：`health.mounted` 假红、页面显示「未接管」、`verify-install` 的 preset 组也会
判「两代都找不到」。live 桌面因为还挂着旧的 `dsh-gokifu-preset` 包才侥幸没暴露。

现在该分支返回 `ownPreset === null ? [] : [ownPreset]`（`src/ui.mjs` 与 `scripts/install.mjs`
两份实现同步改，`test/preset-discovery.test.mjs` 的「两处一致」用例继续锁着）。

### 新增回归（预设发现）

- 「本包 patch 自己声明 preset 时必须被发现；UI-only 的 ≤1.14.0 旧包仍必须排除」；
- 「只有本包声明 preset、home 里没有 `preset-bundles/` ⇒ 不许被旧一代早退吞掉」（就是本 bug）。

### 验证

- 全量单测 **617 passed / 0 skipped / 0 failed**（54 个测试文件；1.15.0 基线 615）。
- 隔离实例 `web115b`（只装本包 1.15.x 的 tarball，无旧 preset bundle）：
  `findPresetFiles` / `presetsWithCompaction` 都返回 `[dsh-gokifu-compact]`；
  `--dump-config` 三条（registry default / gokifu-ui / preset-gokifu）齐全。

---

## 1.15.0 — 2026-11-01

> 本轮主题：**把安装做成「跟别的插件一样」** —— 一个包、一次安装、装上即接管。
> 触发：主人在插件市场里点安装，被宿主版本闸拒（npm 上只有 1.11.17 的精确 `0.2.0-rc.2` 钉死），
> 且发现本插件的安装要「插件包 + 另装 preset bundle + 手跑生成器 + 手选 preset」四步，跟别的插件不一样。
> 对照参考：`ranxianglei/billion-context`（单包 + `dsh.bundle.patch`，装完即生效）。
> **本版 npm publish 1.15.0**（主人本轮明确授权）；1.14.0 也已补发到 npm。

### V1 · bundle patch 升级成「三合一生成物」（本版核心）

`cordis.patch.yml` 以前只插 UI 一行（引擎必须在 preset 里，而 preset 是另一个包）。现在它是
**生成物**，一个 patch 里同时做三件事：

```yaml
- insert:
    - id: gokifu-ui            # ① UI host：/gokifu/api + 设置页
    - id: preset-gokifu        # ② agent preset：compaction group 的 compaction-basic → dsh-gokifu-compact/engine
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: gokifu, ... plugins: [ ...官方 standard 的 32 条行逐字保留... ] }
- id: agent-preset-registry     # ③ 新会话默认 preset 指向 gokifu —— 装上即接管
  config:
    default: gokifu
```

⇒ 安装从「两步 + 手跑生成器 + 手选 preset」变成 **一条命令 / 市场点一下**；
`dsh plugin add` 成功后 `reconcile()` 自动把本包写进 `dsh.profile.bundles`，重启即生效。
用户仍可在 **设置 → Agent presets** 把新任务默认 preset 改回别的（`selectedDefault` 存 settings，
优先级高于本 patch 的 `default`）。

### V2 · 生成器：`--bundle` 模式（读宿主当前 asar，不冻结）

- 新增 `buildBundlePatch()` / `validateBundlePatch()`；`node scripts/make-preset.mjs --bundle --write`
  重写仓库根 `cordis.patch.yml`（旧文件备份 `.bak-<ts>`）。
- 自检：UI 行在 / preset 声明在 / 引擎行是 `dsh-gokifu-compact/engine` / **不许残留 `- id: compaction-basic`** /
  注册表补丁有 `default:` / 顶层 `- insert:` 恰好一条 / **插件行集合与官方 preset 不多不少**。
- preset 快照随宿主版本（本版按 0.2.1-rc.5 生成）：**DSH 升级后维护者重跑一次并联同插件发版**；
  这是「一个包装上」的代价，写进 README 安装节，不藏着。

### V3 · preset 发现与「接管」判定修正（真 bug）

1. **本包 patch 现在同时是 preset 来源**：`findPresetFiles` / `presetsWithCompaction` 以前无条件
   `bundle === PKG_NAME → continue`（那时它只有 UI 行）。现在改成「**只有真的声明了 preset 才当 preset**」，
   旧包（UI-only）行为不变。
2. **不许自我遮蔽**：只有本包命中时不再提前 `return` —— 旧 home 的 preset 在 `preset-bundles/` 里，
   提前返回会让安装器/doctor 找不到真正要改的 preset（新加的 C5 幂等回归就是踩这个）。
3. **`health.singleInstance` 作用域修正**：以前是「所有被发现的 preset 里都不许有 compaction-basic」，
   于是只要装了别的 preset（例如 `dsh-design-studio`）页面就永远显示**未接管**——单实例规则的作用域
   本来是「**本 preset 内部**」。现在只在本引擎所在声明里判，页面终于能如实显示「已接管」。

### 验证

- 全量单测 **615 passed / 0 skipped / 0 failed**（**54** 个测试文件；1.14.0 基线 613）。
- 新增 `bundle.test.mjs` B-2 重写为三合一形状断言；`make-preset.test.mjs` 增 `buildBundlePatch` /
  `validateBundlePatch` 正负例（缺注册表 / 残留 compaction-basic / 缺 UI 行都必须拒绝）。
- 隔离实例端到端（`dsh-test-home/profiles/web115`，62620，只用**这一个包**）：
  `--dump-config` 里三条都在（`agent-preset-registry default: gokifu` / `gokifu-ui` /
  `preset-gokifu` 且引擎行在 `isolate:{compaction:true}` 组内）；实例起得来，
  `POST /gokifu/api {"action":"health"}` = **200**。
- live 桌面（0.2.1-rc.5）实测：1.14.0 发布后市场入口可装；`verify-install` 17/18（最后一项要运行期棋谱）。

### 迁移注意（旧安装 → 1.15.0）

- 先 `dsh plugin --profile <p> remove dsh-gokifu-preset`（旧的独立 preset bundle），**再重启**；
  否则两个包都声明 `id: gokifu` ⇒ 同名 preset 重复注册。
- 本版不改变引擎行为/配置项；`thresholdRatio` 默认仍是 0.45。

---

## 1.14.0 — 2026-11-01

> 本轮主题：**UI 解冻后的一次改版** —— 摘要模型下拉改成「只读宿主模型目录」，页面做宽屏双栏 / 滚动容器 P0 修复 /
> 焦点环 / 两级下拉；另收掉两件欠账：`thresholdRatio` 的事实更正、**手动压缩按钮「不做」的定论**。
> **本版只推 GitHub（main + tag），不 npm publish**（主人本轮明确选择）；**仍未装 live**。

### U1 · 模型目录：只读宿主 `llm`，插件不存任何凭据

**架构定调（主人拍板）**：插件**不自己存凭据、不自己接外部 API** —— 用户要在 DSH 里加供应商，
页面的摘要模型下拉就自动长出来。⇒ 插件**只读宿主已注册的模型目录**。

**改法**（`src/ui.mjs`，+144/−1）：`inject` → `["webServer", "llm"]`；新增纯函数 `modelCatalog(llm)`；
新增动作 `{"action":"models"}`，`state` 响应同时携带 `models`。目录形状：

```
{ providers: [ { provider, name, models: [ { id, name, contextWindow: number|null } ] } ] }
```

**任何失败都降级不抛**：单个 provider 挂掉只跳过它；`listProviders()` 抛错 ⇒ 空目录；畸形项（缺 id / 空串 /
非字符串）过滤掉，不产出半截项。

**三个实测 API 事实（记下来省一次考古）**

| 事实 | 出处 |
|---|---|
| 宿主服务名就是 **`"llm"`** | `dsh-llm/lib/index.js` 的 `LlmRuntime extends Service` → `super(ctx, "llm")` |
| `listProviders()` 返回 **`[{ id, name }]`**（**没有窗口字段**） | 实测 |
| **`listModels()` 里也没有窗口** —— 窗口只能逐模型问 `resolveModelInfo(provider, model).context.contextWindow` | 宿主对窗口做 `Number.isInteger(w) && w > 0` 校验，非法直接抛 `INVALID_MODEL_CONTEXT` |

**防住的一个真实风险**：`dsh-llm-deepseek` 的 `listModels()` 背后是 `discoverModels?.()` —— **可能走网络**，
而这台机器的组合树里 `llm-deepseek-api-key` / `llm-deepseek-account` 都在 ⇒「首屏等一次网络发现」是真会发生的。
⇒ 每次宿主调用加 **4 秒时间预算**（`CATALOG_CALL_TIMEOUT_MS = 4000` + `Promise.race`），超时按「拿不到」降级：
**页面宁可少一个下拉项，也不许卡住首屏。**
（踩坑：那个 timer **不能 `unref`** —— 宿主调用真实卡死时不产生任何句柄，unref 后事件循环先退出 ⇒ `await` 永不返回。）

**窗口绝不伪造**：拿不到就 `null`，页面显示 `—` 并隐藏进度条 —— 旧版写死的 `1000000` 已删掉。

**测试**：`test/ui-models.test.mjs` **7/0**（形状与排序 · 单 provider 抛错只跳过 · `listProviders` 抛错 ⇒ 空目录 ·
畸形项过滤 · 窗口缺失/非法/查询抛错 ⇒ `null` · `models` 与 `state.models` 同一份目录 · **宿主卡住 ⇒ 降级不挂死**）。

### U2 + U4 · 页面：宽屏双栏 + 滚动容器 P0 修复 + 焦点环 + 两级下拉

（`lib/client.js`，+603/−68）

| 改动 | 说明 |
|---|---|
| **宽屏双栏** | ≥1280px：左配置 / 右指标与状态，根容器 `maxWidth 1600px` 居中；<1280px 回单栏并保持原纵向顺序 |
| **滚动容器 P0 修复** | `styles.page` 补 `height:100%` / `minHeight:0` / `boxSizing:border-box` / `overflowY:auto` —— 修掉「内容超高但滚不动」；双栏时也是**整页**滚动（两栏各自不滚） |
| **焦点环** | 所有可交互元素统一经 `focusable()` 渲染，`onFocus`/`onBlur` 切 outline（修掉 pointer 模态下看不见焦点） |
| **摘要模型两级下拉** | provider → model（`<optgroup>` 分组）；**目录为空时降级回自由文本**；当前值不在目录里时单独留一项（否则受控 select 会显示空白） |
| **窗口** | 按选中模型的 `contextWindow`；拿不到显示 `—` 并隐藏进度条 |
| **U4 ① 窄屏断点 600** | 理由：600 − 56 padding = 544，扣掉 220 控件 + 120 默认值列只剩 ~200 给中文 label，会折行 ⇒ <600 改两行堆叠 |
| **U4 ② 长名兜底** | provider / model 下拉与文本输入都加 `title`（长 id 如 `ima/deepseek-v4.1-flash` 悬停可见全名） |
| **U4 ③ 标题行显示 profile** | 只读宿主已有字段（`health.profile` 优先，其次 `state.profile`） |
| **U4 ④ 间距收敛** | `SPACING = {section:16, card:8, inline:12, micro:4}`，把原来的 18/20/26/10/2 收敛成 **4px 网格** |

**两个真 bug（各自自测时抓到的，值得记）**

1. **`focusable` 漏透传 `children`** ⇒ `select` 的 `<option>` 与按钮文案被吞 ⇒ 页面显示成**空下拉** / 空白按钮。
2. **`describeModelSelection` 里 `find` 未命中返回 `undefined` 而不是 `null`** ⇒ `=== null` 兜不住 ⇒
   preset 里存着**已下架模型**时 title 计算直接抛错、**整页白屏**。

**测试**：`test/ui-layout.test.mjs` **9/0**（双栏 1279/1280 **逐像素**边界 · 滚动容器四属性防回退 ·
焦点环静态覆盖 · 两级下拉与空目录降级 · 窗口来源不再写死 1000000 · 599/600 断点 · 长名 `title` ·
标题行 profile · **gap 只有 4/8/12/16 四档**，以后新加值会被抓）。
`ui` 切片 **75/0/0**（基线 59 → 71 → 75）。

### thresholdRatio：一个事实更正（**本版不改数值**）

主人被问「`thresholdRatio` 0.6 要不要降」，拍板「降到 0.5」。**但前提是错的**：

- 插件 `src/rooms/config-schema.mjs` 的默认值**本来就是 0.45**；`scripts/install.mjs` 的 `engineBlock()`
  模板也是 **0.45**；
- 仓库里唯一的 `0.6` 出现在**历史文档** `docs/P0-worldhash-死循环-根因与修复方案.md`，
  它记的是升级前那个 **profile 级 override**（`cordis.patch.yml:489`）—— 那个 profile 已随旧 home 一起消失。

⇒ **0.45 已经比主人要的 0.5 更早触发**，符合他「更早压」的意图 ⇒ **不改数值**。
已在该历史文档的 P1 节**追加**记录（原文一字未删）。

### 手动压缩按钮：**不做**（有理由，不是漏做）

实测宿主 `dsh-command-compact/lib/index.js`：**不排队** —— `executeCompact` 直接调
`ctx.compaction.compactNow(...)`；busy 时抛 `ManualCompactionError("busy")`，渲染成英文
"Compaction is unavailable because this process has an active compaction, or the agent is not idle."
⇒ **DSH 原生是报错的**（只是英文、不说人话）；插件 **1.11.13** 起已把该 message 改成人话
（`compactNow` override + `annotateManualCompactError`，保留 `code`/`name`/`cause`/`stack`，宿主分类不受影响）。
而且**插件页面里根本没有压缩按钮** —— 手动压缩就是原生 `/compact` 斜杠命令。

**结论：不做按钮、不做禁用态。** 三条理由：
① 页面不是会话级的，拿不到 agent/会话状态，做不出可信的「当前能否压缩」；
② 加按钮等于重复原生 `/compact` 的能力面，还会把用户重新引回 busy 报错那条路；
③ 报错可读性已经解决 —— **这才是当初欠账的真实痛点**。

### 验证

- 全量：**613 passed / 0 skipped / 0 failed**（**54 个测试文件**；1.13.0 基线 597/0/0、52 文件）
- 新增测试文件 **2 个**：`ui-models`(7) · `ui-layout`(9)
- 分文件：`ui` **75/0** · `ui-models` 7/0 · `ui-layout` 9/0 · `preset-wiring` 4/0 · `install-link` 29/0 ·
  `ws-install` 19/0 · `bundle` 6/0 · `version` 4/0 · `rooms` 15/0

### 未验证 / 已知问题

- **没有在真实浏览器里做视觉验收**：双栏 / 滚动 / 焦点环 / 下拉的断言全部是**源码级 + 纯函数级**
  （`ui-layout` 的 9 条静态覆盖）；**真实 1280 / 599 视口下的目视效果没看过**，也没有在真机上滚一次长页面。
- **没有装到 live**：桌面 home 里本插件仍是 0 个版本。
- 模型目录的 **4 秒预算**只在夹具里模拟过「卡住」，**没有对真实慢网络实测**。
- 窗口只取 `resolveModelInfo(...).context.contextWindow` 且**没有缓存**：`models` 动作每次逐模型问一遍，
  模型多的 provider 会慢（有 4s 总预算兜着，但**延迟未测**）。

### 未修项

- **`README:3` 与 `HANDOFF` 的版本号仍没有门禁**（`check-maintenance` 不读它们）。
- 热清单定价的两套口径（session 压力走 `ctx.tokenMeter` / 热清单走本地加权）**未统一**。
- `lib/client.js` 仍不带 profile（生产恒为 desktop ⇒ 现在不发作，换 profile 会）。

## 1.13.0 — 2026-11-01

> 本轮主题：**让「热清单到底占多少 token」第一次有真数**，并把「装回新版」最容易卡住的 C 段
> （preset 的引擎行）做成**可重跑的生成器**；同时第一次在**独立 DSH 实例**上跑通「装 → 组合树 → 引擎实例化」。
> **本版未发布**（无 tag、无 npm 发布）、**未装 live**。

### W-A · 热清单定价接真：CJK 1 token/字 + ASCII 侧对齐宿主 `CHARS_PER_TOKEN=4`

**问题**：热清单的预算判定用 `ceil(len / 3)`（一律 3 字符/token）。实测（`计划表.md` 的 OPT-TOKENS，走网关
`usage.prompt_tokens`）它对**纯中文低估 38%**、对**真实热清单低估 8.8%**。低估意味着「以为没超预算、其实超了」——
而热清单预算是个**硬预算**，这是危险方向。

**改法**：`单位 = Σ每码点(CJK ? 4 : 1)`，`4 单位 = 1 token`
⇒ **CJK 1 token/字、其余 1/4 token/字**（ASCII 侧与宿主 `dsh-token-meter/lib/types/estimate.js` 的
`CHARS_PER_TOKEN = 4` 同一套常数）。

- **全角标点算 CJK**（U+3000–303F / U+FF00–FFEF）：与汉字在 BPE 同区间，且本仓热清单标点几乎全是全角；
- 含**星形平面扩展汉字** U+20000–2FA1F（旧 BMP 正则会漏）；emoji / 箭头 `→` / 省略号 `…` 按非 CJK
  （不是「BPE 更便宜」的断言，而是按下面这个锚点校准出来的）；
- 预算数学（`renderLedger` 里原 **7 处** `maxTokens * 3` / `/ 3` 的字符↔token 换算）一并搬到**单位域**；
  **`hotLedgerMaxTokens = 500` 与 `PATH_QUOTA_CHARS = 150` 一个都没改** —— 只改估算口径，不改预算。

**校准锚点**（本仓唯一一条有真实网关 usage 的热清单）：418 汉字 + 2060 ASCII（2478 字符，含大量箭头与占位符）

| 口径 | 值 | 对实测 905 的偏差 |
|---|---|---|
| 旧 `len / 3` | 826 | **−8.8%** |
| 新（CJK×1 + 其余×1/4） | **933** | **+3.1%** |

**归档 176 会话只读复算**（`test/measure-ledger.mjs`，改前/改后各一次）：

| 指标 | 改前 | 改后 |
|---|---|---|
| tokens 合计 | 72,582 | **73,547** |
| avg | 412.40 | **417.88（+1.3%）** |
| max | 826 | **933（+13%）** |
| over-500 张数 | 25 | **25** |
| 平均档位 | L1.89 | L2.00 |

**这层意思必须说清**：over-500 **张数没变**，是因为渲染器**自适应降档**（L0 63→48、L1 12→23、L2 36→42）
把预算从 ASCII 侧挪给了 CJK 侧。但**若只换公式不重渲染，同一批文本会是 avg 436.03 / over 56 张**
⇒ **旧口径那 25 张「合规」里，有 31 张其实是靠低估撑出来的**。
所以这不是「性能优化」，是**把预算判定从自指指标变成真指标**：同一份 500 预算，以前装的是「估计 500、实际 550–900」。

**踩到的坑（值得记进「坑」）**：`doomed()`（跳过「铁定装不下」的档）若照字面把
「按 `LEVEL_LEN` 上限猜行长、再 `/3`」直接换成「×4 单位」，下界会涨 **~2.6×**，把**本来装得下的档**误判成
「注定装不下」—— 实测当场让失败边从 30 条掉到 20 条、两条既有用例变红。已改成**逐条按真实 intent/reason 长度累加**。

**测试**：新增 `test/ledger-pricing.test.mjs` **9/0**，全部**钉死数值**（400 ASCII = 100、10 汉字 = 10、
锚点 933、8 个全角标点 = 8、8 个扩展 B 汉字 = 8……），不写「大于几」这种恒真断言；
旧的假绿 `estimateTokens 是保守估计`（断言 `>= 3`，对任何非空中文串恒真）已就地重写为钉值；
5 处既有 c17 用例因**夹具预算随定价漂移**而调整（`C17-2/3/4/8/11`），**断言语义未放松**
（唯一一处 `=== 3` → `>= 3`，而用例标题本就写「L3+」），每处留 `★ W-A（2026-11-01）` 注释。

### W-B · `scripts/make-preset.mjs`：C 段（preset 引擎行）的正式解法

**问题**：「装回新版」的 C 段是把 preset 的 compaction group 里 `- id: compaction-basic` 换成
`- id: gokifu-compact / name: 'dsh-gokifu-compact/engine'`。以前只能**手抄一份官方 preset** ——
那会把「当时那版 DSH 的插件清单」**冻成快照**，DSH 升级新增的行（如 `time-context`）会静默丢失。

**改法**：生成器从**当前宿主 asar** 读官方
`dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` → 找 compaction group →
**只替换那 2 行** → 其余**逐字保留** → 输出可直接 `dsh plugin add` 的 preset bundle 包。

- **默认 dry-run**，`--write` 才落盘；`--out/--id/--name/--order/--asar/--version` 可覆盖；
- 退出码 **0/1/2**，其中 `2` = 参数错误或**输出目录守卫**（落在运行中的 DSH home 里直接拒，
  且**在任何写盘之前**拦）；
- 生成物自检：正文不许残留 `compaction-basic`、必须有 `dsh-gokifu-compact/engine`（**拒绝包根** ——
  包根 `exports["."]` 是 UI host，DSH 会把 UI host 当压缩引擎）、必须有 agent-preset 声明。

**验证**：真机 dry-run（宿主 **0.2.1-rc.5**）**32 条插件行逐字保留**，唯一差异就是 compaction 组那 2 行；
`make-preset` **6/0**。

### W-D · UI health 自检不再写死 `profile=desktop`

`POST /gokifu/api {"action":"health"}` 以前写死 `profiles/desktop`。W-C 在独立测试实例上实测到**假红**：
profile 叫 `web`，插件明明装好、也进了 `dsh.profile.bundles`，health 却返回
`installed:false / notInBundles:true`。现在 `health()` 接受 `profile` 参数并在返回体带出实际用的 profile。

**验证**：`test/ui-health.test.mjs` **5/0**，其中「**非默认 profile 名装好了也必须报 `installed:true`**」
在旧实现上必红（这就是回归的核心）。
**已知边界**：`lib/client.js` 目前不带 profile —— 生产恒为 desktop ⇒ 现在不发作，但换 profile 就会。

### 验证

- 全量：**597 passed / 0 skipped / 0 failed**（**52 个测试文件**；1.12.0 基线 577/0/0/49 文件）
- 新增测试文件 **3 个**：`ledger-pricing`(9) · `make-preset`(6) · `ui-health`(5)
- 分文件：`ledger` 20/0 · `c17-path-at-every-level` 15/0 · `engine-harness` 43/0 · `ledger-budget` 7/0 · `ledger-scale` 4/0

### 未验证 / 已知问题

- **真实压缩一轮没跑通**。W-C 在独立实例上把「引擎行被加载 → `Config` schema 真求值 → `ctx.compaction`
  服务注册 → 构造出 `ChessCompactionEngine`」全部验到了（同 realm 的 `inject:["compaction"]` 探针被激活），
  但「**会话选中 preset → 引擎实例化 → 真压一轮**」**没验证**：测试 home 没配模型路由，
  也没有擅自接生产 magpie 网关。
- **preset 插件是惰性激活的**：不选该 preset 的会话不会 mount `config.plugins`
  ⇒「装完没反应」最常见的原因是**没选 preset**，不是装坏了。
- **没有装到 live**：桌面 home 里本插件仍是 **0 个版本**，装回去需要**停机窗口 + 主人授权 + 主人重启**。
- 新定价只在**归档语料**上复算过；**现网 usage 对账**还欠一次：下次真实 fold 时记 `usage.prompt_tokens`
  与 `estimateTokens(注入文本)` 比一下即可。
- `doomed()` 现在按真实行遍历失败边（原先是 O(1) 的估算）⇒ 超大失败集下的渲染耗时**未单独压测**。

### 未修项

- **`README:3` 与 `HANDOFF` 的版本号仍然没有门禁**（`check-maintenance` 不读它们，只能人肉同步）。
- 热清单定价的「CJK 1 token/字」在**纯中文**文本上是**上界**（实测纯中文约 0.54 token/字）——
  这是刻意的保守选择（见 `src/rooms/ledger.mjs` 定价注释），但**纯 CJK 会话会偏保守**，未按场景细分。
- 会话压力 / fold 触发已由宿主 `ctx.tokenMeter.measure(session)` 定价，与本版的热清单定价**是两套口径**
  （前者吃 session surface，后者吃一段自造文本）—— 两套口径**未做统一**。

## 1.12.0 — 2026-11-01

> 本轮主题：**让插件在 0.2.1-rc.5 的宿主上重新装得回去**，外加修掉两个已实测缺陷。
> 宿主把三道版本闸（installBundle 拒装 / bundle 层静默跳过 / 行级 preflight 禁用）同时拨到「不兼容」侧，
> 而判据是结构化版本比较 —— **改清单 4+1 行就能过闸**，引擎/UI 的宿主 API 调用点本身都还在。
> **本版没有发布、没有改 live、没有打 tag**（发版属下一步）。

### F1 · 兼容 DSH 0.2.1-rc.5：peer 改「范围」+ 补 `engines.dsh`

**问题**：桌面宿主升到 **0.2.1-rc.5**，而插件 4 个 `@deepseek-ai/dsh-*` peer 钉死精确 `0.2.0-rc.2`。
宿主判据（`dsh-app-boot/lib/index.js` 的 `unmetRequirements()` / `evaluatePluginCompatibility()`）：

```
有 engines.dsh → 只用它判（peer 一律忽略）
否则            → 只看 peerDependencies 里名字是 @deepseek-ai/dsh 或 @deepseek-ai/dsh-* 的项，
                  逐条 semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

**精确版当 range = 「只等于自己」** ⇒ 4 条全 unmet ⇒ 三道闸同时关：

1. 安装前 `installBundle` **直接拒装**（`incompatible-version`，pnpm 都还没跑）；
2. 手工塞进 profile 后，只要进了 `dsh.profile.bundles`，启动时**整层 bundle 被静默跳过**（源码注释原话 "nothing is printed"）；
3. 行级 preflight 另有一道（把该行 `disabled` 并往 stderr 打一行）。

**改法（清单 4+1 行）**

| 处 | 改前 | 改后 |
|---|---|---|
| 4 个 `@deepseek-ai/dsh-*` peer | `0.2.0-rc.2` | **`^0.2.0-rc.2`** |
| `engines` | `{ "node": ">=20" }` | 增 **`"dsh": "^0.2.0-rc.2"`**（宿主有它时只用它判，闸门收到一处） |

**peer 条目一条都没删**（这点比「改成范围」更要紧）：这套宿主里 `peerDependencies` **同时是模块解析路由表** ——
`dsh-app-boot` 的 `routeLinked()` 只把「出现在祖先 `package.json` peer 表里的名字」改指宿主自带副本；
名字不在表里 ⇒ 落回原生解析 ⇒ `link:` 安装下 `import '@deepseek-ai/dsh-*'` 直接解析不到。
所以断言必须同时防「值被钉死」和「条目被删」。

**⚠ 这个 range 的可行性依赖宿主保留 `includePrerelease`**（用宿主 asar 自带 semver 7.8.5 实测）：

| 调用 | 结果 |
|---|---|
| `satisfies("0.2.1-rc.5", "^0.2.0-rc.2")` —— **默认**选项 | **false** |
| `satisfies("0.2.1-rc.5", "^0.2.0-rc.2", { includePrerelease: true })` —— **宿主实际用法**（`dsh-app-boot/lib/index.js` 逐字） | **true** |
| `satisfies("0.2.1-rc.5", "0.2.0-rc.2")` —— 改前的精确版 | false |
| `satisfies("0.3.0-rc.1", "^0.2.0-rc.2", { includePrerelease: true })` —— 上界 | false（正常） |

⇒ **若 DSH 哪天取消 `includePrerelease`，这个范围会重新变成不满足**（闸门重新收紧，不会静默放行）。
这条前提已写进 `test/verify-install.mjs` 的判据注释，留给下一个升级的人。

**自研断言改结构化**（`test/verify-install.mjs`，检查项 **16 → 18**）：
① 4 条 dsh peer 条目齐（`DSH_PEERS`）② 每条范围能覆盖**当前宿主版本** ③ `engines.dsh` 存在且与 peer 口径一致。
**不再比对写死的版本字符串**；版本解析自带（本包 `dependencies` 为空，校验器要能在没装依赖的 profile 里跑，
所以不引 semver 依赖），语义对齐宿主的 `includePrerelease: true`，caret 上界取 `<X.Y.0-0`
（少 `-0` 会把下一个预发布如 `0.3.0-rc.1` 误判进范围）。
宿主版本读 `<DSH_HOME>/dsh-runtimes/<*>/runtime.json` 的 `desktopVersion`（与在跑宿主同源）；
读不到时**只判范围形态**，不假绿。

**验证**：`install-link` **29/0**、`ws-install` **19/0**（新增 F1-1…F1-5 五条：范围语义与宿主一致 /
健康清单在 0.2.1-rc.5 上过闸且旧形状必红 / 删任一 peer 条目必红 / 缺 `engines.dsh` 或与 peer 口径不一致各自红 /
`verify-install` 真挂上这 3 条判据且健康夹具 **18/18** 全绿）。

### B1 · 摘要模型回退分支：不再往 `BlockAssembler` 回写（rc.5 上会静默降级）

**问题**：宿主 `@deepseek-ai/dsh-llm@0.2.1-rc.5` 的 `BlockAssembler` **没有 `chunks`**，
`usage` / `finish` 是**只读 getter**（严格模式赋值 `TypeError`）。旧写法在「摘要模型 ≠ 当前路由 且第一次失败」
的回退分支里回写四个字段 ⇒ 抛错 ⇒ 被 `summarize` 外层 `catch { …退回规则摘要 }` 吞掉 ⇒
**回退分支静默失效、fold 降级成规则摘要**（表面只留一条会误导读者的 warn「摘要模型全部不可用」）。
不是崩溃，是**悄悄降质**，更坏。

**改法**：`const assembler` → `let`；回退分支改**换引用** ——
`assembler = await runStream(routed, new BlockAssembler())`（`runStream` 本来就 `return into`），
后文 `assembler.blocks()` / `assembler.usage` 自然读 retry 的产物。不回写旧实例、不依赖 `chunks`。

**测试（红 → 绿）**：新增 `test/engine-retry-assembler.test.mjs` **2 条** ——
`B1-0 夹具自检：替身确实是 rc.5 形状（没有 chunks；usage/finish 只读）`、
`B1-1 回退分支在 rc.5 形状的 BlockAssembler 上必须真的走通（不得降级成规则摘要）`。
**改前 1 passed / 1 failed**（红在 `degraded="rules"` + 摘要不含 retry 产出 + `usage` 缺失 + 出现「全部不可用」），
**改后 2 passed / 0 failed**；旧形状回归 `engine-harness` 43/0 不变 ⇒ 换引用是等价变换。

### C1 · 停窗预检：探测失败从 fail-open 改成 fail-closed

**问题**：`scripts/p6c-preflight.mjs` 的 `processCount()` 在 `tasklist` 跑不起来时返回 `{count: 0}`，
调用方只算 `count > 0` ⇒ **「探不到」被当成「没在跑」** ⇒ 输出「✓ 可以开窗：DSH 未运行」并 **exit 0**。
它守的是全仓唯一破坏性写盘动作（P6-C / S1b / `--apply`）的开机许可；本仓已有三次
「插件在跑却写盘 ⇒ 清理被内存图覆盖（`netCleaned=0`）」的实测记录。

**改法**：`processCount()` 拆**三态** —— 「明确跳过」（`--proc-name=` 空，`skipped:true`，不算失败）/
「探测成功」（`probed:true` + `count`）/「探测失败」（`probed:false` + `error`，带出 `ENOENT` / `ETIMEDOUT` / 退出码）；
调用方 `running = portIsOpen || count > 0 || procFailed`（**探测失败按「可能在跑」处理**），
`runtime` 增 `procProbed` / `procSkipped` / `procError`，verdict 独立一档「无法确认 DSH 是否已退出（fail-closed）」。

**测试（红 → 绿）**：`test/p6c-preflight.test.mjs` 新增
`p6c-preflight 拒绝：进程探测失败必须 fail-closed（tasklist 不可用 ≠ 没在跑）`
（子进程 `PATH` 置空 ⇒ 断言 `ready===false`、`procProbed===false`、退出码 **1**），并给既有三态各补断言。
**旧实现上必红**（实测：`探测失败必须 exit 1，实际 0`）。
**改前**：`✓ 可以开窗：可以开窗：DSH 未运行…` **EXIT 0** → **改后**：`✗ 不可以开窗：…无法确认 DSH 是否已退出（进程探测失败：ENOENT）…` **EXIT 1**。
`p6c-preflight` 专项 **6/0/0**（原 5 条全绿 + 新增 1）。

### W4/W5 · preset 发现两代兼容 + doctor/verify 的 preset 检查按语义分档

**问题**：新版 DSH **没有 `<DSH_HOME>/preset-bundles` 目录**（全 asar grep `preset-bundles` = 0 命中）。
用户 preset 改成「**bundle 包** + profile 的 `dsh.profile.bundles[]` 声明」，patch 里写
`name: '@deepseek-ai/dsh-agent-preset'`。旧代码只认 `preset-bundles/` ⇒ `src/ui.mjs` 的 `findPresetFiles()`
与 `scripts/install.mjs` 的 `presetsWithCompaction()` **双双静默返回 `[]`** ⇒ 新 home 上必然假红。

**改法**：先扫新版形态（`profiles/<p>/package.json` 的 `dsh.profile.bundles[]` → `node_modules/<name>/cordis.patch.yml`，
命中判据含 `@deepseek-ai/dsh-agent-preset` / `- id: compaction-basic` / 本包名），再回退旧 `preset-bundles/`；
**排除本包自身 bundle**（防自指：它只插 UI 行，永远不是 preset）；profile 名可参数化。
两份实现（`src/ui.mjs` / `scripts/install.mjs`）逻辑相同且有测试钉「同一夹具逐字段相同」。

**语义分档（这条比"兼容"更要紧）**：`doctor` / `verify-install` 里 ——
「**两代都没有 preset**」= **合法中间态**（warn / `!`，不计 failed）；
「**有** preset 但没挂 `dsh-gokifu-compact/engine`」= **error / failed**。两种状态分开断言，不许糊成一个布尔。

**真机证据**：旧 home 回退实测命中 `personal-assistant`；新 home `superagent` profile 实测命中 `dsh-superagent`；
真实新 home 上 `verify-install` **18 项 = 13 失败 / 5 提示**、`doctor` **错误 1 / 警告 11**（改前 错误 3 / 警告 8）。

**验证**：`preset-discovery` **7/0**、`preset-wiring` **4/0**（`verify-install` 与 `doctor` 两个入口都断言，防止只改对一处）。

### 附带 · `scripts/bench-repro.mjs`：一条命令复现 README 顶部的两个指标

新增 `scripts/bench-repro.mjs` —— 跑到 `hot-list tokens: 351 (fixture=2000-edges, tier=L5)` 与
`failure-retention: 8 / 8`；**数字漂移则 `exit 2`**（算法或夹具变了要人工确认后再更新基线），跑不通 `exit 1`。
基线常量集中在一处（`EXPECTED_TOKENS` / `EXPECTED_TIER` / `EXPECTED_RETENTION`），改算法时同步 README 与本脚本。

### 验证

- 全量：**577 passed / 0 skipped / 0 failed**（**49 个测试文件**；基线 **558/0/0、46 文件**）
- 新增测试文件 **3 个**：`engine-retry-assembler`(2) · `preset-discovery`(7) · `preset-wiring`(4)；
  另有既有文件扩容：`p6c-preflight` **+1**（5→6）、`ws-install` **+5**（14→19）。
  对账：文件 **46 + 3 = 49**、用例 **558 + 2 + 7 + 4 + 1 + 5 = 577**，两处都对得上
- 分文件（`node test/run.mjs <filter>` 口径）：`install-link` **29/0** · `ws-install` **19/0** · `preset-discovery` **7/0** · `preset-wiring` **4/0** ·
  `p6c-preflight` **6/0** · `engine-harness` **43/0** · `ui` **54/0** · `rooms` **15/0** · `bundle` **6/0**
- `scripts/bench-repro.mjs`：**EXIT 0**（351 tokens / 8-8）
- `check-maintenance`（pre-tag）：**通过 8 / 警告 0 / 失败 1**（`CHANGELOG 有 1.12.0 这一节` 已转绿）—— 唯一失败是「当前版本 1.12.0 有 tag」，
  属**发版步骤未执行**（本版不打 tag），不是内容问题

### 未验证 / 已知问题

- **没有真实安装到新 home**：需**停机窗口 + 主人授权 + 主人重启**。本版只把「装得回去」的条件备齐（清单过闸 + preset 两代兼容），
  **一次都没有对真实 profile 跑过 `install`**。真实新 home 上 `verify-install` **13 失败 / 5 提示**、
  `doctor` **错误 1 / 警告 11** 是「插件还没装」的必然结果，不是本版缺陷；**没有为了凑绿去动 live**。
- **B1 只在「复刻 rc.5 成员表」的替身上验证过**（本机工作树没有 `node_modules`）。真实 rc.5 宿主上仍需重启后跑一次真实 fold 验收。
- **preset 的「写回」路径未在 bundle 形态下真机验证**：`src/ui.mjs` 保存配置时写的是「发现到的 preset 文件」，
  新版形态下那就是 bundle 包根 `cordis.patch.yml` —— 备份/`pruneBackups` 也会落在 bundle 包目录里，
  会不会污染包或进 git **未实测**（只有发现侧有两代兼容的测试）。
- **`.cmd` 打包形态**：桌面启动脚本必须 GBK(CP936) + CRLF（1306 B / 39 个 CRLF / 无 BOM），
  用 UTF-8 编辑器保存会静默失效 —— 本版没动它，记录给运维窗口。

### 未修项（本轮明确不做）

- **`README:3` 没有任何门禁**（见 1.11.15 S11 的订正）：`check-maintenance` 不读 README、`release*.mjs` / `verify-release.mjs`
  也没有 README 断言 ⇒ 只能靠人肉同步。**要治得给 `check-maintenance` 加一条**（`scripts/**` 属发布侧，本轮不动）。
- **`HANDOFF.md` 的版本号同样没有门禁**（本轮靠人手改准）。
- **tokenMeter 仍未立项**：热清单预算数学仍是 `len/3` 字符粗估（8 处硬编码 `/3`），
  实测对 CJK 系统性低估（纯中文 **−38%**、真实热清单中位 **−9.7%**）；正解是宿主 `ctx.tokenMeter` 端口 + 预算改 token 单位，属结构变更。
- **preset 的 compaction group 行仍待重建**：新 home 上没有可用的 preset bundle，引擎行要在运维窗口里新建（引擎名必须
  `dsh-gokifu-compact/engine`，不能写包根 —— 包根 `exports["."]` 是 UI host）。

## 1.11.17 — 2026-10-31

### P6C-4 · 停窗预检的进程计数：解析**本地化提示行**导致的假「DSH 还在跑」

**现场（真实卡死）**：主人 22:12 完全退出桌面实例后双击桌面脚本两次，两次日志都是
`portOpen=false procCount=1 running=true -> exit 1` —— **端口已关（DSH 确实退出了）却仍判「在运行」**，
停窗流程根本开不了。

**根因（又是「解析人类可读输出」）**：`tasklist` 在**没有匹配进程**时会打印一句本地化提示

```
信息: 没有运行的任务匹配指定标准。
```

`spawnSync(encoding:"utf8")` 把 GBK 字节解成 `U+FFFD` ⇒ 这一行**既不是空行、也不以 `INFO:` 开头**
（`INFO:` 只在英文系统上出现）⇒ 旧过滤条件全部放行 ⇒ `processCount` 返回 **1** ⇒
`running = portOpen || count > 0` **恒真**。

**修复**：改用 **`tasklist /FO CSV`** + **行首必须是 `"`** + 按**映像名（第一 CSV 字段）复核**。
匹配到的进程行一定以 `"` 开头，本地化提示行不会 ⇒ 计数可靠。

**回归（墓碑用例）**：`test/p6c-preflight.test.mjs` 新增一条 —— 进程名不存在时
`procCount` 必须为 **0**、`running` 必须 **false**、夹具就绪时 **exit 0**。
**该用例在旧实现上必红**（`procCount=1` / exit 1），在新实现上必绿。

> 这与 1.11.11 的 `git status --porcelain` 假红是**同一类**坑：拿人类看的输出当机器接口。
> 结论写在这儿：**凡是要解析命令输出，优先选有稳定结构/分隔符的格式（`-z`、`CSV`、`--json`），
> 不要用「行首关键字 + 语言假定」去过滤。**

### 验证

- 全量：**558 passed / 0 skipped / 0 failed**（**46 个测试文件**；557 + 1 墓碑用例）
- `p6c-preflight` **5/0** · `release-hardening` 22/0
- `verify-install` **16/16**（live profile 已修复到一致；本版**未动 live**）
- `npm pack --dry-run --json`：**77 文件**（数量不变）

**未验证**

- 修复只覆盖「无匹配进程」的场景；**同名进程存在时的计数**仍依赖 `tasklist` 的 CSV 行为，没有在真机上同时跑两个实例去验证。
- `verify-install` 16/16 是**当下环境**的快照 —— 1.11.16 发布时它是 14/16、本轮改动提交时又一度是 6/16（live profile 在 22:01–22:04 被重装），**这个数字随时会随 live 状态变**，不能当天长地久的门禁基线引用。

## 1.11.16 — 2026-10-31

### P2-1 · 同一份日志、换模型比：脚本 + 一组真实数据

**问题**：「哪个模型做摘要更好/更快」一直靠感觉。要比就必须**喂同一份东西**，否则比的是切片大小差异。

**新增 `scripts/compare-models.mjs`**（纯函数 + CLI，只读 `DSH_HOME`，唯一写出的是 `--out`）

| 固定住的变量 | 做法 |
|---|---|
| **同一折叠切片** | 取**最近一条 `foldMark` 的 `[seqStart, seqEnd]`**，没有就全量；`renderFacts(g,{range})` **逐字节相同** ⇒ 不同模型看到的不是不同大小的切片 |
| **同一 instruction** | `buildChessInstruction`，**不按模型改写** |
| **同一 `maxTokens`** 与 `temperature: 0` | 命令行显式给，默认生产值 |
| **每模型 N 次**（默认 3） | **只对成功样本取中位**；失败单独计数 + 保留错误原文（**不把失败当 0 拉低中位**） |

记录：延迟中位 / usage / 失败数 / 摘要长度 / **四章节完整度**（目标·死路·已验证事实·原始坐标）。
`--dry-run` 只读图不发请求；不给 `--session` 时自动挑「失败边最多」的真实会话。

**真跑一组**（`evidence/compare-models.json`，session `session-d288e7a2…`，9 条失败边、facts 1830 tok，`maxTokens=8192`，repeat 3）

| 模型 | 成功 | 延迟中位 | 摘要中位 | 四章节 | usage 中位 |
|---|---|---|---|---|---|
| `group/deepseek-v4.1-flash1017` | **3/3** | **11451 ms** | **1769 字符** | 4/4 | 4808 tok |
| `group/gokifu-compact` | **3/3** | **27076 ms** | **2211 字符** | 4/4 | **网关回 0（无真实 usage）** |

- **gokifu-compact 慢约 2.4×、长 25%，四章节一样齐**；但它的 **usage 全是 0**（网关不回真实用量）
  ⇒ **这一组数据算不出成本对比**，只能比延迟与长度。
- **附带发现（重要）**：`maxTokens=900` 时 `flash1017` **0/3** —— 预算被 reasoning 吃光，
  `finish_reason=length` 且 `content: null`。**maxTokens 给小了不是「摘要短一点」，是「完全拿不到摘要」**。
  （该组原文留在 `tmp/` 里，**故意不进包**。）

**测试 +11（546 → 557）**：`parseArgs`（未知开关必须报错）/ `median` / `pickFoldSlice` / prompt 字节一致 /
**切片外失败边不许进 prompt** / 四章节口径 / `parseChatResponse` / 假 fetch 四态（成功·HTTP 500·网络异常·空摘要）/
中位只算成功 / 报表形状 / CLI `--dry-run` 端到端。
变异（逐条红）：未知开关静默忽略 / 中位混入失败 / HTTP 失败当成功 / 忽略 range。

### 验证

- 全量：**557 passed / 0 skipped / 0 failed**（**46 个测试文件**；546 + 11）
- `compare-models` **11/0**
- `npm pack --dry-run --json`：**77 文件**（75 + `scripts/compare-models.mjs` + `evidence/compare-models.json`
  —— 证据写进 `evidence/` 就会被 `files` 打进包）
- **`verify-install`：14/16** —— 仍是 **live profile 环境漂移**（本包在 live profile 里没有依赖声明、也没挂载），
  与 1.11.16 内容无关；**没有动 live**

### 未验证 / 已知问题

- 对比只做了**一组会话**（9 条失败边、facts 1830 tok）；**换会话/换切片长度结论可能不同**，不能当普遍结论。
- **成本对比不可算**：`gokifu-compact` 的 usage 全 0；`flash1017` 的 usage 是真实的，但没有可比对的一侧。
- 「四章节完整度」是**按标题/关键词命中**判的，判的是「有没有写」，**不判内容对不对**。
- `verify-install` 14/16 如实记录（同 1.11.15，环境问题，未动 live）。

## 1.11.15 — 2026-10-31

### P2-2 · fold 变成可观测的：每一次都能查到「走了哪条路由、多久、花了多少 token」

**问题**：fold 只有 `count` 和最后一次的 mode —— **想回答「上次压缩为什么这么慢 / 用的是哪个模型 /
是不是降级了」只能翻会话日志**，而日志会滚掉。

**改法**

- `foldMark` 追加四个字段（外加 `foldCount`）：
  | 字段 | 含义 |
  |---|---|
  | **`route`** | `provider/model` —— **无条件记录**（有的 provider 不回 `usage`，但路由永远可得；旧写法把 route 写在 `usage` 判断里，缺 usage 就丢） |
  | **`fallback`** | 本轮摘要模式（`rules` / `null`）—— 与 S3 的降级标记同源 |
  | **`ms`** | `summary + commit + flush` 的**端到端**耗时 |
  | **`usage`** | 真实 usage 快照（provider 没回就是空） |
- **裁传统一**：`FOLD_MARKS_KEEP = 20`，**常规 fold 与 tier-2 共用同一个上限**（旧版 tier-2 单独用 `tier2After×2`，
  两条路径各裁各的 ⇒ 保留条数不可预测）。要改只改这一个常量。
- **`doctor` 新增「最近 5 次 fold」**：跨会话倒序 5 条；旧图缺字段显示 **「—」**（不猜）；tier-2 记录单独标注。

**测试 +4（542 → 546）**：foldMark 四字段 / 降级时 `fallback=rules` / 20 条裁剪 / doctor 的 5 条与「—」。
变异：不写四字段 / 去掉裁剪 / doctor 不显示 —— 三条逐条红。

### S11 · 文档状态三处与事实对齐（代码零改动）

审计 §八 R9 指出三处文档与事实相反：

| 处 | 修复 |
|---|---|
| `README` 版本行 | 曾写 `1.7.1` ⇒ 本版一次性把 `README:3` 同步成 `1.11.15`。**⚠ 订正（2026-11-01，1.12.0）**：原文接着写「由 `check-maintenance` 与发布门禁共同盯着」——**这句是错的**：实测 `grep -c README scripts/check-maintenance.mjs` = **0**，`scripts/release*.mjs` / `scripts/verify-release.mjs` 里也没有任何 README 断言 ⇒ **`README:3` 至今没有任何门禁**，只能人肉同步（1.9.3 就因为 `README:3` 落后吃过一次冻结令）。修法见 1.12.0「未修项」。 |
| `docs/计划表.md` | 首行标注 **「已归档」**，并注明「2026-10-29 起唯一持续任务表改为仓库根的 `计划表.md`」 |
| `HANDOFF.md` 顶部 | 日期 `2026-10-28` → **`2026-10-31`**；删掉过期的「最紧急：v1.3.5 修 worldHash P0」三条；新增**最新状态表**（版本 / tag / npm shasum / 单测数 / verify / check / **live 仍 1.11.2、落后多版** / 未发的 P2-2 / **P6-C 真实 apply 仍欠**）；旧 1.9.1 块降级为「历史状态 …… 留作时间线」 |

**diff 核对**：与备份比 **−5 行 / +19 行**，**尾部 6 行完全一致**（旧内容一字未删）。

### 验证

- 全量：**546 passed / 0 skipped / 0 failed**（**45 个测试文件**；542 + 4）
- `engine-harness` **43/0** · `tier2` **7/0** · `ledger` **31/0** · `release-hardening` **22/0**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**75 文件**（数量不变）
- **`verify-install`：14/16** —— ⚠ **不是本版引入的缺陷**，是 **live profile 的环境漂移**（见下）

### 未验证 / 已知问题

- **`verify-install` 14/16**：这是**本机 live profile 与当前代码的漂移**，与 1.11.15 的内容无关 ——
  **没有动 live**（未改 `profiles/*/cordis.patch.yml`、未重装）。如实记录：这版发布时该门禁是红的。
- P2-2 的四个字段**只在夹具与引擎级验证**；**没有在真机上让一次真实 fold 落后再从 doctor 读回**去确认显示正确。
- `ms` 是**端到端墙钟**，包含 `flush` 的磁盘时间 ⇒ 与机器负载相关，**不能当模型的推理耗时**。
- S11 是文档项，**代码零改动**；`docs/计划表.md` 里更早的历史内容未逐条复核。

## 1.11.14 — 2026-10-31

### S3 · 降级要看得见：规则摘要会在热清单里明说「这次没有模型润色」

**问题**：模型调用失败时 `summarize` 会退到**规则摘要**（纯模板拼装）。这一步**静默发生** ——
用户只看到「压缩过了」，不知道这次的摘要**没有经过模型**，遇到摘要质量差时会以为插件坏了。

**改法**

- `summarize` 的**四条路径**（含 auto 与 manual）都写两个字段到图上：
  **`lastFoldMode`**（`"rules"` / `"hybrid"` / `"llm"`）与 **`lastFoldDegraded`**（同一事实的布尔别名，
  热清单/诊断读哪个都行）。**写失败绝不影响摘要本身**。
- 热清单在 `mode === "rules"` 时固定显示一行：**`⚠ 上次摘要是规则生成（无模型润色）`**；
  `hybrid` 与旧图（没有这个字段）**不显示** —— 不制造假警报。
- 这一行**计入 `prePathChars`**，**500 token 预算仍然成立**。

### S4 · `minFold` 按窗口缩放：小窗口不再被 8000 卡住

**问题**：`minFoldTokens` 原来是固定 **8000**。窗口小的模型（例如 32K）永远够不到这个门槛 ⇒
**永远不 fold**，历史一直堆到溢出为止。

- `resolveSpec` 返回 **`minFoldTokens = max(8000, 窗口 × 0.08)`**，`selectRange` 用它；
  **overflow 分支回落配置值**（溢出自救不该被这个下限挡住）
- **显式配置优先**：`8000` 只作为**默认哨兵**（注释里写明了这点），用户写了值就按用户的来

**测试 +9（533 → 542）**：`ledger` S3-1/S3-2（提示行出现与不出现）、
`engine-harness` S3-3…S3-5（四条路径写标记 / 旧图不显示 / 预算仍成立）+ **S4-1…S4-4**
（缩放公式 / 显式配置优先 / overflow 回落 / 边界）、`manual-compact` MC-4 补 manual 标记。
变异：删提示行 / rules 不写标记 / 取消缩放 —— 三条逐条红。

### 验证

- 全量：**542 passed / 0 skipped / 0 failed**（**45 个测试文件**；533 + 9）
- `engine-harness` **39/0** · `ledger` **31/0** · `release-hardening` 22/0
- `verify-install` **16/16**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**75 文件**（数量不变）

**未验证**

- S3 的提示行只在**夹具与引擎级**验证过「rules 才出现」；**没有在真机上制造一次真实的模型失败**去确认它在真实热清单里的位置与可读性。
- S4 的缩放只经单测覆盖；**没有在 32K 这类小窗口的真实会话里观察过 fold 频次变化**。
- 「500 预算仍成立」是**按 token 估算**的（夹具上的 prePathChars 统计），不是真机计费对账。

## 1.11.13 — 2026-10-31

### ① 手动压缩失败**说人话**（新增房间 R16 `manual-compact`）

**问题**：`compactNow()` 失败时抛的是宿主底层错误 —— 用户看到 `Error: cannot compact while turn is open`
之类的原文，**不知道是自己点早了、还是插件卡了、还是真出 bug**。

- 新增 **`src/rooms/manual-compact.mjs`**（零依赖）：`classify` / `describe` / `annotate`
- 分类九种：`open-turn` · `idle` · `busy-lock` · `cancelled` · `summary` · `persistence` · `commit` · `changed` · `unknown`；
  **原始 `code` 与 `cause` 一字不改地保留**（诊断加人话，不吞证据）
- `engine` 覆盖 `compactNow`：**成功路径原样返回**；失败时把诊断挂到原错误上、换成人话 message，**仍 rethrow 原错误**
  （调用方拿到的仍是原来的 error 对象，只是多了 `.diagnosis`）
- 测试 4 条：纯函数四态 + **真实 Basic 探针**（开着的 turn ⇒ `busy/open-turn`；`turn/end` 之后不再命中）
- `rooms` 登记 **R16**（房间集合 **12 → 13**）；变异：不诊断 / open turn 分类失效 / annotate 改 code —— 三条逐条红

### ② TRACE 行带上「最近三个节点」（S5）

**问题**：TRACE 原来只说「细节在 `sessions/<sid>/index.md`」—— 模型不知道最近走了哪三步，想定位就得先读盘
（一次工具调用 + 一轮上下文）。

- `ledger` 的 TRACE 行现在附带**最近 3 个路径节点的 id + 一句话**（短语取 agent 的 `goal` / user 的 `text`，按
  `TRACE_PHRASE_CHARS` 截断）
- **不新增 IO**：只用已经算好的路径节点对象与节点自带字段
- **绝对路径照旧打码**：TRACE 行不泄漏盘符/用户名的既有硬约束不变（`goal` 里完全可能写着路径）

### ③ P6-C 停窗预检与执行手册

- 新增 **`scripts/p6c-preflight.mjs`**：迁移**之前**的只读预检 —— 端口可连接 / 同名进程在跑 ⇒ **拒绝 apply（exit 1）**；
  正常时打印会话数与 graph 哈希；`--port=0 --proc-name=` 可跳过外部探测（供夹具用）
- 新增 **`docs/P6-C 停窗执行手册.md`**（190 行）：只在**主人明确给停窗授权**后使用；未授权只做只读部分
  （预检 + dry-run）；只归档 `settled residue`，`candidate` 一条不动
- 测试 4 条：夹具就绪时 exit 0 且带会话数/哈希 · 端口可连必须 exit 1 · 同名进程必须 exit 1 ·
  **只读保证**（跑前跑后夹具整树 sha256 不变）

### ④ 发布脚本：拒绝脏树 + 发布物核对

- **脏树硬门禁**：`git status --porcelain` 非空即红、exit 1（**含未跟踪文件**；`evidence/` 等噪声**不豁免**），
  打印前 20 行与恢复办法。旧实现只查 `git diff`，**看不见未跟踪文件**。
- 新增 **`scripts/verify-release.mjs`**：`git archive <tag>` 的树 vs tarball 的 `package/` **逐文件比对**；
  比较键 = **去 CR 后的内容 sha256**（Windows 工作树 CRLF / archive LF ⇒ 按原始 shasum 必假红），
  行尾差异**只警告不红**；tarball 多出文件 / 内容真变 ⇒ 红。
- `release.mjs` 接上 `--verify-tarball=`：npm publish 成功后、建 Release 之前核对，不过就 abort。

### 验证

- 全量：**533 passed / 0 skipped / 0 failed**（**45 个测试文件**）
- `manual-compact` **4/0** · `ledger` **29/0** · `p6c-preflight` **4/0** · `rooms` 15/0 · `release-hardening` **22/0**
- `verify-install` **16/16**
- `npm pack --dry-run --json`：**75 文件**（71 → 75：`manual-compact.mjs` / `p6c-preflight.mjs` / `P6-C 手册` / `verify-release.mjs`）

**未验证**

- 手动压缩诊断是**分类正确性**的证据（夹具 + 真实 Basic 探针），**没有在真机上制造过一次真实失败**去验 message 是否好读。
- P6-C 的**真实 apply 仍未执行**（需主人授权 + 停窗窗口）；预检与手册只是把「怎么安全做」准备好。
- `--verify-tarball` 的 abort 分支**没有被真发版触发过**（本版发布时未传该参数）。

## 1.11.12 — 2026-10-31

### S8 首折削峰：第一次 fold 提前到 30%，之后回到 45%

**问题**：`thresholdRatio`（默认 0.45）对**每一次** fold 都一样。但第一次 fold 的代价最高 ——
它要一次性压掉整段历史（没有 checkpoint 可续），而那正是用户最可能撞上长时间停顿的时刻。

**改法**

| 项 | 变化 |
|---|---|
| 新配置 **`firstFoldRatio`** | preset 里的键（`PRESET_KEYS` **16 → 17**）；范围 **0 – 0.95**，**默认 0.30** |
| 生效范围 | **只作用于本会话第一次 fold**：首折阈值 = **min(窗口 × 0.30, pressureBudget)**；之后回到 `thresholdRatio`（0.45）。**200K 窗口下的具体值：首折 60K / 正常 90K** |
| 不受影响 | **overflow 分支照旧**（它有自己的触发条件）；若首折阈值 ≤ `retainTokens` ⇒ **回退正常阈值**（不会压到留不住尾巴） |
| preset 块格式 | `engineBlock` 增 `firstFoldRatio` 行（**21 → 22 行 / 15 → 16 键**）；`rooms` 的 preset 块 golden 已同步 |

**测试 +7（505 → 512，`engine-harness` 32/0）**：首折触发 / 第二次回到正常阈值 / 配 0 即关闭 /
边界（0.95、≤ retainTokens 回退）/ **fold 次数最多 +1** / retain 守卫 / overflow 不受影响。
变异自检：首折分支失效 / 首折比例用到每一次 / 默认改成 0 —— 三条逐条红。

**验收口径的更正（同版内，`4dd5f0b`）**：原写「fold 次数不增加」，**这条本身不成立** ——
首折提前意味着同一会话可能多一次 fold。测试名改为「**fold 次数最多 +1（首折提前一次）**」，断言未动；
`docs/方案-持续优化.md` 的 S8 节写明了为什么「不增加」不可能成立。**代码零改动。**

**连带调整**：`test/real-fold-trigger.mjs` 的 ① 改用 **50K**（首折阈值已降到 60K，旧的 60K 用例会直接触发 fold，判据随即失效）。

### 验证

- 全量：**512 passed / 0 skipped / 0 failed**（**43 个测试文件**；505 + 7）
- `engine-harness` **32/0** · `config-schema` 11/0 · `ui` 54/0 · `rooms` 15/0 · `release-hardening` 15/0
- `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变）

**未验证**

- 首折削峰是**引擎级/夹具级**证据，**没有在真机上量的收益** —— 「首折更早、单次更小」的方向性成立，
  但「用户实际感知的停顿降低了多少」没有观测数据。
- `firstFoldRatio` 只经 preset 与单测覆盖，**没有在真实会话里跑过非默认值**。

## 1.11.11 — 2026-10-31

### 修 `check-maintenance` 的一个**假红**：`git status --porcelain` 的首行空格被 `.trim()` 吃掉

**现场**：终审时 `check-maintenance` 报 **8 通过 / 1 失败**，而工作树其实只有 `evidence/bench-2000.json` 这一个
本该被豁免的噪声文件 —— 也就是说，**它把「只改了 evidence」误判成「改了代码没 bump 版本」**。

**根因（一个字符的事）**：`git status --porcelain` 的首行形如 ` M evidence/x.json` ——
**状态码 X 位是一个空格**。旧实现把整段 stdout `.trim()` 了，首行的那个空格被吃掉，再按固定列 `slice(3)`：

```
" M evidence/x.json"  → trim → "M evidence/x.json" → slice(3) → "vidence/x.json"   ← 少了 v
```

于是 `evidence/` 过滤失效 ⇒ 假红。（后续行没有行首空格问题，所以**只有第一行会歪** —— 这类 bug 极难靠肉眼发现。）

**改法**

- 新增 **`gitRaw()`**：返回**未 trim** 的 stdout，专供解析用；`git()` 保持原来的 trim 行为（其余检查不变）。
- 脏文件改用 **`git status --porcelain -z`** + 新增 **`parsePorcelainZ()`**：按 NUL 切记录，
  每条记录是 `XY <path>`，**逐条** `slice(3)` 取路径；rename/copy 记录后面紧跟一个「原路径」token
  （没有 XY 前缀），解析时跳过。
  用 `-z` 还顺带解决另一个坑：普通 porcelain 会给**含空格 / 非 ASCII** 的路径加引号并转义
  （`"a b.txt"` 之类），`-z` 给的是**原始路径**，不用反解义。

**新增 `test/check-maintenance.test.mjs`（4 条回归，全部真跑脚本）**

| 用例 | 钉住什么 |
|---|---|
| 基线 | 干净夹具必须 **9/0** |
| **首行空格** | 脏 `evidence/bench-2000.json` 必须**仍 9/0**（这就是那个假红的原样复现） |
| 不放过代码 | 脏 `src/` 仍必须**红**（不能为了 evidence 把代码变更也放过） |
| 可恢复 | `git checkout -- evidence/` 之后回到 **9/0** |

### 验证

- 全量：**505 passed / 0 skipped / 0 failed**（**43 个测试文件**；501 + 4）
- `check-maintenance` 专项 **4/0** · `release-hardening` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；`test/` 不进包）

**未验证**

- 假红只在 `check-maintenance` 里修了；**别的脚本若也用 `.trim()` + 固定列解析 `--porcelain`，可能有同样的歪一字符问题** ——
  本次没有全仓排查（`grep` 过一遍，只有这一处按列切）。

## 1.11.10 — 2026-10-31

### 修一个会**悄悄吞掉备份**的真 bug：回灌备份按会话分子目录

**现场**：`migrate-dangling --merge-sidecar --apply` 的备份目录原本是**每次运行一个**（`merge-<iso>/`），
同一次 `mergeMany` 里的多个会话**共用同一个目录** ⇒ 后一个会话的 `graph.json` / `MERGE.json`
把前一个**覆盖掉**。真实规模演练时 **48 个会话最后只剩 1 份备份**，而且**没有任何报错**。

**改法**

| 项 | 变化 |
|---|---|
| `mergeBackupDir()` | 新增 `session` 参数：备份写到 **`<run>/<session>/`**（会话名做 `[^A-Za-z0-9._-] → _` 清洗）；不传 `session` 时仍是原来的 `<run>` |
| `mergeMany().backupDirs` | 用 **`uniqueBackupDirs()` 去重** —— 同一次运行里 N 个会话共用同一个 run 目录，汇总列表只留一条（`perSession[].backupDir` 仍是各自的**精确路径**，不受影响） |
| `mergeSidecar` / `mergeMany` 的 JSDoc | 明确写出：**merge 不是字节级还原** —— `updatedAt` 会被刷新、`stateIndex` 可能与原图不同。**要逐字节恢复，请用 `apply` 的整目录备份 + `rollback`** |

**测试 +3（498 → 501）**

- **B1** `uniqueBackupDirs` 去重：同一 run 目录只出现一次，顺序保留
- **B2** 同一 root 的两份备份**都不丢**（回归上面那个「48 会话只剩 1 份」的 bug）
- **B3** 非字节级还原：行为断言（`updatedAt` 刷新后与原图不同）+ 文档断言（JSDoc 里写了「不是字节级」）

变异自检：不去重 / 不分子目录 / 删掉「非字节级」说明 —— 三条逐条红。

### 验证

- 全量：**501 passed / 0 skipped / 0 failed**（**42 个测试文件**；498 + 3）
- `migrate` **24/0** · `release-hardening` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；只改 `src/` 与 `test/`）

**未验证**

- 备份修复只在夹具上验证；**真实库的 merge 仍未执行过**（真实 `sessions/**` 的 apply / merge 都需主人授权 + 停插件窗口）。
- 「非字节级还原」只是**把差异写清楚**，没有提供「让 merge 变成字节级」的选项 —— 需要逐字节就用 `apply` 备份 + `rollback`。

## 1.11.9 — 2026-10-31

### 发布脚本新增门禁：CHANGELOG 写的「N 个测试文件」必须等于事实

**这条门禁上线当天就抓到了真实漂移**：CHANGELOG 从 1.11.5 起一直写着同一个旧数字（**37**），
实际早就是 **42** —— 连续几个版本没人对过账（它不影响构建，所以从来不会自己叫）。

**新增（`scripts/release-lib.mjs`，纯逻辑、可单测）**

| 导出 | 行为 |
|---|---|
| `declaredTestFiles(section)` | 读「N 个测试文件」；**没写返回 `null`**；容错 `**42** 个测试文件` / `（42 个测试文件；493 + 7）` / `42个测试文件` |
| `checkTestFileCount(section, actual)` | **三态**：一致放行 / 不一致给出 `{declared, actual, reason}` / 无声明放行 |

**`scripts/release.mjs` 体检 ②b**：当前版本那一节的数字 ≠ `test/*.test.mjs` 实际数 ⇒ **红，`--yes` 也不动手**；
**没写这句不报错**（允许不声明）。红文案同时给出两个数与「怎么数」（含历史版本数法）：

```
· CHANGELOG 写的「N 个测试文件」与实际 42 个不符 —— 改了测试文件就必须同步这句（或删掉它，脚本不会因此报错）。
  实际值怎么数：ls test/*.test.mjs | wc -l（看历史版本：git ls-tree -r --name-only <tag>^{commit} test/ | grep -c '\.test\.mjs$'）
```

### 顺带修掉两个「只在预演期才撞到」的发布脚本缺陷

写这条门禁时跑 dry-run，脚本**直接崩了**，顺藤摸出两个真缺陷（都不影响发版那一刻，但会让「已发版本上再跑一次预演」变成堆栈）：

1. **tag 已存在时 dry-run 崩**：`git rev-parse -q --verify refs/tags/x^{commit}` —— Windows 上 `execSync` 走 **cmd.exe**，
   `^` 是转义字符 ⇒ 被吃成 `{commit}`，命令失败抛异常（手动在 Git Bash 里跑同一命令是好的，极难从表面看出）。
   改用 `git rev-list -n1 refs/tags/<tag>`（无 shell 元字符，annotated / lightweight 都剥到 commit）+ try/catch。
2. **「tag 指向别的 commit」误报**：给 `ls-remote` 传**精确 pattern** 时**不会**输出 `^{}` 剥皮行 ⇒ 拿到的是 tag 对象 sha（≠ commit）；
   而且判据原本是「≠ HEAD」，但「发过之后 main 又往前走了」是**正常态**。改为列全部 tag 再在 JS 里过滤剥皮行，
   判据改成「**既不是 HEAD 也不是 HEAD 的祖先**」（`git merge-base --is-ancestor`）才报。

### 验证

- 全量：**498 passed / 0 skipped / 0 failed**（**42 个测试文件**；493 + 5 条 `release-hardening`）
- `release-hardening` **15/0** · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（`test/` 不进包，数量不变）
- 三态端到端（临时克隆、版本 9.9.9）：声明 37 / 实际 42 ⇒ **exit 1**；**无声明** ⇒ **exit 0**（附跳过说明）；声明 42 ⇒ **exit 0**
- 仓库记录更正：1.11.8 节的「37」已改为「42」并在原处注明「发布时误写；npm 上已发内容无法改」

**未验证**

- 门禁只校验**当前 `package.json` 版本那一节**；历史各节不追溯。
- 没把「仓库自洽」做成单测：若在测试套件里断言「当前版本的数字 == 实际数」，每加一个测试文件都会红到下一版
  （已发布那一节是冻结的）⇒ 这条只在**发布时**才对得起来。

## 1.11.8 — 2026-10-31

### sidecar 现在能**回灌**：归档掉的悬空边可以放回图里

1.11.1 起 `migrate-dangling --apply` 把 settled residue 归档到 `graph.dangling.json`（sidecar），
**但一直没有回灌工具** —— 报告里写「字段齐全、可回灌」，实际只能靠人手写 JSON。这一版把这条路补完。

**新增（R14 `src/rooms/migrate.mjs`）**

| 导出 | 作用 |
|---|---|
| `readSidecar(file)` | 读 + 校验：`format` / `version` / **非空 `edges`** / 每条边必须有 `id` / 会话匹配；**坏文件一律拒绝且不动图** |
| `mergeSidecar(graph, sidecar, opts)` | 按 `edge.id` 合并；**同 id 跳过、不覆盖**；保留 sidecar 原字段；**原子写 `graph.json` + 重建 `index.md`** |
| `mergeMany(target, opts)` | 目标可以是**文件或目录**；批量 |
| `mergeBackupDir(opts)` | 回灌前先备份 `graph.json` / `index.md` 并落 `MERGE.json` |

- **默认 dry-run**：只有 `--apply` 才写盘；**幂等** —— 二次 merge 0 条命中且**不写盘**。
- CLI：`--merge-sidecar=<file|dir> [--apply] [--backup-dir=] [--json]`；有错误 **exit 1**。

**CLI 摘要（`scripts/migrate-dangling.mjs`）**

- 修掉 `main()` 里 merge 分支的**重复执行链**（只留 `mergeMany`，错误 exit 1），人类摘要移到输出链。
- 无 `--json` 时打印：标题 / target / `sessions|merged|skipped` / 逐会话行 / backup 目录 / errors / dry-run 或已回灌提示；
  **`--json` 仍是纯 JSON**（可 `JSON.parse`）。
- `mergeMany`：目标不存在时**直接报「目标不存在」**（不再默默去读 `./graph.json`）。

**测试 +7**（486 → 493）

- M1 回灌与备份 · M2 幂等 · M3 **五类拒绝**（format/version/空 edges/边无 id/会话不匹配）· M4 同 id 不覆盖 · M5 `mergeMany` 批量
- C1 **真跑 CLI 六态**（人类摘要 / `--json` / apply 备份 / 幂等 / 坏 version / 目标不存在）· C2 结构回归（merge 分支恰好 2 处）
- 变异自检：覆盖已存在边 / dry-run 写盘 / 不校验 version / 执行链重复分支 / `--json` 走人类摘要 / 删人类摘要分支 —— 逐条红

### 验证

- 全量：**493 passed / 0 skipped / 0 failed**（**42** 个测试文件 —— 发布时误写 37，此处已按实际更正；npm 上 1.11.8 的 CHANGELOG 仍是 37，无法改）
- `migrate` **21/0** · `rooms` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；只改 `src/` `scripts/` `test/`）

**未验证**

- 回灌**没有对真实库跑过** —— 全部证据来自夹具；真实 `sessions/**` 的 apply 仍需主人授权 + 停插件窗口。
- 回灌只按 `edge.id` 去重：**同一个「边」若在 sidecar 里 id 不同（历史重复归档），会被当成两条各插一次**。

## 1.11.7 — 2026-10-31

### 真实测试与门禁都不再「靠输出猜」

**问题**：两个门禁的判据都在**猜**，而不是**问退出码**。

1. `test/all.mjs` 用正则 `/failed|✗/` 扫子进程输出判失败 —— 测试名里可能**字面含 `✗`**
   （例如 `✓ S10c-3 manifestError 进 ✗ 详情…`）⇒ **把绿当红**；反过来，子进程真失败但输出没命中关键字 ⇒ **漏报**。
2. `test/real-fold-trigger.mjs` 无论 4/5 还是 5/5 **都 exit 0** ⇒ 它作为门禁时几乎没有意义。

**改法**

| 文件 | 变更 |
|---|---|
| `test/all.mjs` | 删掉 `/failed\|✗/` 正则判据，**只按子进程退出码**；**超时 / 起不来 / 无退出码一律算红**（不许当成「没输出=没事」）；导出 `STEPS` / `stepPassed` / `runStep` / `allPassed` 供单测直测 |
| `test/real-fold-trigger.mjs` | **加退出码**：4/5 ⇒ `exit 1`；依赖未提取（跑不了）⇒ `exit 2` 表示「未运行」而不是「通过」 |
| 同上 · ⑤ 溢出自救 | 没有可压内容时记 **N/A**（不计失败）—— 先注入新内容让它有东西可压；⑤ 判红不再是「环境没给料」的假失败 |
| 同上 · usage 对账 | 打印模型返回的 `usage`（**prompt / completion / total / calls**）并累加落盘，真实调用的成本可对账 |
| 同上 · 预清理 | 跑前**清空 `graphs-trigger`** —— 旧状态会让 ② 的 growth gate 误拦，**第二次跑必红** |

**新增 `test/test-gate.test.mjs`（5 条）**：`exit 0` 但输出含 `✗` **不得**误红 / 非 0 **必红** /
起不来 · 超时 **必红** / 4 通过 1 失败 **必败** / 结构回归（`STEPS` 与导出面）。

**变异自检**：`stepPassed` 恒 `true` ⇒ TG-2/TG-3 红；判据退回正则 ⇒ TG-5 红。

### 验证

- 全量：**486 passed / 0 skipped / 0 failed**（37 个测试文件；481 + 5）
- `node test/all.mjs` → **exit 0**（5 个步骤全绿：单测 / 挂载校验 / 真实模块 / 真实事务 / 性能基准）
- `node test/real-fold-trigger.mjs` → **5/5 exit 0**，usage 已打印
- `verify-install` **16/16** · `bench 2000` **351 tokens**
- `npm pack --dry-run --json`：**71 文件**（数量不变；`test/` 不进包）

**未验证**

- `real-fold-trigger` 依赖**真实模型**（走 magpie `127.0.0.1:3425`）与已提取的模块目录；缺依赖时它会 **exit 2（未运行）**，
  这是有意的语义 —— 但也就意味着**它在别的机器上可能根本不跑**，不能当「任何环境都能复现」的证据。
- `all.mjs` 的「超时必红」用 300s 默认超时，**没有真的等满 300s 去验证**（用的是注入假 `exec` 的单测）。

## 1.11.6 — 2026-10-31

### tier-2 解耦：checkpoint 的常驻成本不再随 fold 次数线性涨

**问题（只读核实）**：fold 的 range 从**上一个 checkpoint 之后**开始 ⇒ 旧 checkpoint **全部留在 surface**
（实测 `start=1009 > cp8=1008`），每 fold 一次就 +1 条；而旧代码**只在 pressure 分支**才收 tier-2。
⇒ auto 路径连做 12 次 fold，surface 上就线性涨到 **12 条旧 checkpoint**。

**改法**

- `src/engine.mjs`：删掉那个**空的 `#tier2`**（调用点 + 定义一起删）；常规 fold **成功后**
  （`tier2After > 0`）`await #tier2IfNeeded()`；**失败只 warn，不影响本次 fold**。
- `#tier2IfNeeded` 加 `_tier2InFlight` **防重入**（同一时刻只允许一个 tier-2 在跑，防递归 / 二次 `compactRegion`）。

**前后对照（同一会话 12 次 fold）**

| | surface 上旧 checkpoint 条数 | tier-2 次数 |
|---|---|---|
| 旧 | **12**（`[1..12]`，max 12） | 0（auto 路径从不触发） |
| 新 | **8**（`[1..8,7,8,7,8]`，max 8） | 14 次 = 12 fold + **2 tier-2** |

**测试 6 → 7**：T2-0 改写（空方法已删、fold 后调用、防重入）、T2-5 改写（auto 也触发）、
T2-6 新增（不递归 / 压回上限 / `tier2After=0` 不触发）。变异：删掉 fold 后的触发 ⇒ T2-0/T2-5/T2-6 红。

### 迁移守卫补上 delta：只看 `graph.json` 会漏掉「插件其实在写」

**问题**：`migrate-dangling --apply` 的 120s 新鲜度守卫**只 stat `graph.json`**。但 1.9.2 起是**增量落盘** ——
`graph.json` 只在回合边界写，插件活跃时往往**只有 `graph.json.delta.jsonl` 在动**。
真实库实测：**8 个会话的 delta 在 120s 内被写过，而旧守卫一个都没拦住** ⇒ apply 可能在插件仍活跃时放行，
随后内存 flush 把迁移结果覆盖回去（这正是 P6-C 反复强调的 `netCleaned=0` 场景）。

**改法**

- 新增导出 **`DELTA_NAME = "graph.json.delta.jsonl"`**（与 `kifu-persist.sessionPaths().deltaFile` 的 basename
  必须一致，测试有断言盯着这两个名字）。
- 新增 **`freshEvidence()`**：返回每个「120s 内被写过」的会话**及具体文件**；`freshSessions()` 在其上去重。
- 判据：`graph.json` **必看**（缺失照旧抛 ENOENT，不静默跳过）；**delta 存在就看 delta**；
  delta 缺失不判 fresh（老库没有 delta 文件也照样能迁移）。
- 拒绝 apply 时的报错会**点名会话与文件**，而不是只说「有会话新鲜」。

**测试 +4**：P6C-11（只有 delta 在写 ⇒ 拦住并点名文件）/ P6C-12（delta 缺失不影响）/ P6C-13（两者都旧 ⇒ 放行）/
P6C-14（多会话混判：按会话去重，逐个点名）。

### 验证

- 全量：**481 passed / 0 skipped / 0 failed**（36 个测试文件；476 + 1 tier-2 + 4 migrate）
- `tier2` **7/0** · `migrate` **14/0** · `engine-harness` 25/0 · `rooms` 15/0 · `verify-install` **16/16**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**71 文件**（数量不变：只改 `src/` 与 `test/`，无新增文件）

**未验证**

- tier-2 的**运行期**收益未在真机观测 —— 8 vs 12 是引擎级前后对照（同一会话、同一 fold 序列）。
- delta 守卫只在测试夹具与**只读扫描**真实库上验证过；**真实 apply 仍未执行**（需主人授权 + 停插件窗口）。

## 1.11.5 — 2026-10-31

### S10d · 测试运行器终于能区分「跳过」与「通过」，「空壳用例」不再是绿的

**问题**：旧 `run.mjs` 里，平台/权限不对时用 `return` 早退，**会计入 passed** —— 单看
「N passed」根本排除不了跳过；而且一个**一条断言都没有**的用例也会静默算通过。

**改法**

| 能力 | 说明 |
|---|---|
| `t.skip(reason)` | 计入 `skipped`，不计 pass/failed；**exit code 只由 failed 决定** |
| 汇总行 | `== N passed, M skipped, K failed ==`（新增中间那段，跳过不再藏在 passed 里） |
| **零断言检测** | `assertions === 0` **且**源码里没有 `throw` / `assert` 证明 ⇒ 计入 `zeroAssertions` 并**按失败处理**。本仓 300+ 用例是 throw 风格（算有证明），空壳用例从此不再静默算 pass |
| `--dir=` | 仅供 `run-skip` 夹具指向临时目录 |

- **`install-link` 6 处平台/权限早退改为 `t.skip(...)`**，原有断言一字未改。
- 新增 `test/run-skip.test.mjs` **3 条**：四态（pass/fail/skip/零断言）可区分、skip 不导致失败、零断言严格红。

**变异自检**：删掉 skip 分支 ⇒ `run-skip` 红；删掉零断言检测 ⇒ `run-skip` 红。

### 验证

- 全量：**476 passed / 0 failed / 0 skipped**（36 个测试文件；473 + 3）
- `install-link` **29/0** · `run-skip` **3/0** · `rooms` 15/0 · `verify-install` **16/16**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**71 文件**（数量不变，只改 `test/`）

**未验证**

- 零断言检测只认 `assertions` 计数与 `throw`/`assert` 的**文本证据**：如果一个用例用别的方式实打实地检查了东西（例如把结果写进外部文件再断言），仍可能被误判 —— 目前本仓没有这种写法。
- `skipped` 总数现在是 0（本机 Windows）。**跨平台**（Linux/macOS 上那 6 条会真的 skip）没有实跑过。

## 1.11.4 — 2026-10-31

### 发布脚本加固：坏 remote 在预演阶段就红，git 步骤事务化

**背景是一起真实事故**：1.11.3 发布时 `scripts/release.mjs --yes --npm` 返回 **EXIT 1** ——
仓库 `remote.origin.url` 被写成 `git+https://…`（那串正是 `package.json` 的 `repository.url`，
在 npm 里是规范写法，**但不是合法的 git remote**）。旧体检用正则匹配 `github.com:` 照样通过；
真做时 `git push` 全崩，**而脚本继续建 Release、继续 `npm publish`**，留下
「npm 已发 / Release 已建 / main 没推 / tag 指向旧 commit」的半途状态。

**新增 `scripts/release-lib.mjs`**（纯逻辑、可单测、零副作用）

| 导出 | 作用 |
|---|---|
| `parseRepo(url)` | 只认 scp 式 `git@github.com:o/r(.git)`、`ssh://git@github.com/o/r`、`https://github.com/o/r`；`git+*`、`file://`、非 GitHub、空 → `null` |
| `classifyRemote(url)` | **先判 scheme 再判仓库**；`git+…` 直接拒，并给出可执行的修法（`git remote set-url origin git@github.com:<owner>/<repo>.git`） |
| `runTransaction(steps)` | 顺序执行 + **首步失败即中止**，返回 `{ok, done, failed, error, aborted}` |

**`scripts/release.mjs` 体检从 5 项增到 8 项**

- ⑤ **remote 必须是合法 GitHub URL**（不再「正则匹配到 github.com 就算过」）
- ⑥ **`git ls-remote --heads origin` 必须成功** —— 远端不可达直接红
- ⑦ **`git fetch` 失败从 note 改成 red** —— 旧版把「不知道远端正不正常」当成「跳过检查继续发版」
- ⑧ **tag 已存在时区分两种情况**：指向本 commit ⇒「不能发两次」；**指向别的 commit**（1.11.3 的现场：Release API 自动建了轻量 tag）⇒ **不自动 force**，报错并给 `git push --force origin refs/tags/<tag>:refs/tags/<tag>` 的人工修法

**真做改成事务**：`runTransaction([push 分支, tag -a && push tag])` → 任一失败即 `abort()`，
打印「已完成 / 未执行：tag · npm · Release」；**`npm publish` 移到 Release 之前** ——
npm 失败就不建 Release（避免「Release 说有、npm 上没有」）；Release 失败仍 exit 1。

**`scripts/check-maintenance.mjs` 也补了两项**（日常维护就能提前发现）

- ⑧ `remote.origin` 必须是合法 GitHub URL（复用 `classifyRemote`，同一份判据）
- ⑨ `git rev-parse --show-toplevel` 必须等于 cwd（防串仓 —— `ROOT` 取 `process.cwd()`，
  在子目录或别人的仓库里跑会把版本号/CHANGELOG/tag 写错对象而看起来一切正常）

**验证**

- 全量：**473 passed / 0 failed**（36 个测试文件；463 + 10 条 `release-hardening`）
- `check-maintenance`：**9 项**
- `npm pack --dry-run --json`：**71 文件**（70 + `scripts/release-lib.mjs`；`release.mjs` 运行时依赖它，必须随包）
- **预演**：release-ready 的临时克隆上 `node scripts/release.mjs` → **EXIT 0**；
  同一克隆把 remote 换成 `git+https://…` → **EXIT 1**，报错点名协议并给修法

**未验证**

- 未改 `.github/workflows/release.yml`（存在时脚本走「推 tag 自动建 Release」分支，本次未触碰）。
- `check-maintenance` 的 ⑧ 只判 URL 形状，**不探远端可达性**（保持「不需要网络」的定位；可达性由 `release.mjs` 的 ⑥ 在发版时把关）。

## 1.11.3 — 2026-10-31

### P0-1 · `exit` 判据收紧：不再被正文子串误判

旧实现用 `slice(-200)` 在尾部 200 字符里**子串搜索** `[exit code: N]` ⇒ 命令**输出正文里提到**这串就误判成「有退出码」，
且「标记之后还有输出」时前后结论不一致。

- 新增 `lastLineExitCode()`：取**末条非空行**，**整行等于** `[exit code: N]` 才算有退出码；否则视为 no-exit。
- `verify.mjs` 顶部注释同步；`_internal` 导出 `LOCAL_MUTATE_TOOLS` / `lastLineExitCode`。
- 测试 +3（`verifier` OPT-V-1 / OPT-V-2、`weak-shell` S2b-14）；变异：退回 `slice(-200)` ⇒ OPT-V-1 变红。

### P0-2 · `local-mutate` 从只读表拆出（不再被当成「只读工具」）

`todo_write` / `update_goal` / `create_goal` / `hindsight_ingest_document` / `team_task_*` / `send_message` /
`spawn_teammate` / `subagent` / `schedule_*` / `job_kill` … 这些**会改状态但不是文件写**的工具，原先把它们混在只读表里，
分类结果自相矛盾。现在：

- 新增 `LOCAL_MUTATE_TOOLS`；`toolClass()` 返回 **`local-mutate`**（与 `read-only` / `write` 并列）
- `classify()` 对 local-mutate 给 **`unverified` + kind `none`，且不带 `weak`**（它既不是「进展」也不是「失败」）
- `WRITE_TOOLS` / `present` 与 `isError` 的**优先级不变**
- 变异：把 local-mutate 放回只读表 ⇒ S2b-14 + OPT-V-2 变红

### 外部入口 · 新增 `dsh-gokifu-compact/graph` 与 `/persist`

1.11.2 的 README 教外部工具去读 `node_modules/dsh-gokifu-compact/src/rooms/kifu-model.mjs` —— 那是**深层路径**，
`exports` 里没有 ⇒ 现代 ESM 解析会直接拒绝。现在补两个正式入口：

| 入口 | 目标 | 用途 |
|---|---|---|
| `dsh-gokifu-compact/graph` | `src/rooms/kifu-model.mjs` | `fromJSON` / `toJSON` / `decodeDeltaFrames` / `applyDelta` / `renderIndexMd` … |
| `dsh-gokifu-compact/persist` | `src/rooms/kifu-persist.mjs` | `graphRoot` / `sessionPaths` / `createPersistStore` / `load` / `flush` … |

- 新增 `test/package-exports.test.mjs`（**7 条**）：声明齐全、子路径可解析、真实 `import` 成功、导出面非空、不泄漏内部路径
- README 的「怎么拿最新状态」一行改为指向这两个入口

### 零失败边最小注入（OPTIONS 之后又一刀「别让热清单吃白饭」）

**问题**：只读统计 **167 个真实会话**，**42 个（25.1%）零失败边** —— 它们照样要付一份完整热清单的 token。

**改法**：

- `ledger.mjs` 新增 `renderMinimalLedger`：`<chess-ledger>` 内只有三行 —— `GOAL` / `CONSTRAINTS: N` / `NO_FAILED_ATTEMPTS_YET`；
  **`renderLedger` 一个字节不动**（167 会话新旧对比 `byteDiff=0`）
- `hot-inject.decideInjection`：零失败边且 `hasLedgerState` ⇒ 用最小渲染走**原注入流程**（digest / 限流 / replace / fold 补回全不变）；空图仍 `skip no-ledger`
- 实测（42 个零失败会话）：最小注入 **avg 25.4 tok / max 57**（同批会话的完整最小档 avg 386 / max 497）
- 分布：root 覆盖 **42/42**、constraints **32/42**、完全空 **0**（不会出现「三行全空」的哑注入）
- 测试 +4：OPT-E-1 触发与三项内容 / OPT-E-2 空图 skip / OPT-E-3 有失败边时字节不变（sha 钉死）/ OPT-E-4 fold 补回
- 变异：零失败退回 skip ⇒ E-1/E-4 红；删 `NO_FAILED_ATTEMPTS_YET` 行 ⇒ E-1/E-4 红

### tier-2 行为矩阵

- 新增 `test/tier2.test.mjs`（**6 条**，engine 零改动）+ `engine-harness` 导出 4 个 helper —— 把此前「文档说有、代码没测」的第二档行为逐条核实。

### 验证

- 全量：**463 passed / 0 failed**（36 个测试文件；443 + 7 exports + 3 verify + 6 tier2 + 4 hot-inject）
- `rooms` **15/0** · `hot-inject` **12/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.336 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）
- `npm pack --dry-run --json`：**70 文件**（数量不变）/ 562,344 B；`test/`·`tmp/` 命中 0

**未验证（必须知道）**

- 最小注入的**运行期收益未在真机观测** —— 25.4 tok 是离线夹具口径，167 会话统计是只读扫描。
- tier-2 矩阵跑在假 ctx 上，不是真机行为。
- README 里的「真实包 8/8 †」「真实进程 fold 3~6/6 †」带 **†** = 历史口径，**本版未复跑**。

## 1.11.2 — 2026-10-30

### 本包改成 DSH bundle（UI 挂载不再需要用户手改 YAML）

**这是第一个 UI bundle 版。** 以前装完包要**手改 profile 的 `cordis.patch.yml`** 加一条
`- insert: [{id: gokifu-ui, name: 'dsh-gokifu-compact'}]` 才能挂上 UI。手改有两个后患：

1. **双挂载**：用户升级包后手工行还留着，和 bundle 通道同时挂 ⇒ 两个 host 半注册同一个 `/gokifu/api` 前缀 ⇒ **启动即失败**（duplicate prefix route）；
2. **没挂载**：`dsh plugin add` 不会自己补挂载行 ⇒ 「装好了但没生效」，且**没有任何报错**。

**改法**

- 新增 **`cordis.patch.yml`（28 行）**：只做一件事 —— `- insert: [{id: gokifu-ui, name: 'dsh-gokifu-compact'}]`。
  **引擎不在这里**：压缩后端必须挂在 **agent preset 的 compaction group 内部**，profile/bundle 级 patch 打不到 `preset.config.plugins`；那一行仍由 `install.mjs` 改 preset。
  `id` 保持 `gokifu-ui`（与历史手工行一致）⇒ 从手工通道切过来时，日志/文档/doctor 口径都不用改。
- `package.json`：`dsh.bundle.patch = "./cordis.patch.yml"` · `dsh.manifestVersion = 1` · `files`/`exports` 补 `cordis.patch.yml`；`main` 与 `dsh.client` 不变。
- **`scripts/install.mjs` 改 bundle 优先**：
  - `findManualUiRow` / `removeManualUiRow`：定位并（带备份）删除 profile 里的旧手工行
  - `patchProfileBundles()`：把本包**追加**进 `dsh.profile.bundles`，保持既有顺序；写前备份 profile/`package.json`
  - `ensureBundleChannel()` = **先加 bundle、再删手工行** —— 顺序保证任何中断都不会出现「两条都没有」的空窗
  - `git`/`registry` 规格**不改写成 `link`**
- **`test/verify-install.mjs` 判据升级**：旧判据「bundles 里没有它」→ **「UI 挂载通道二选一，不双挂载」**：两条都在 = 红（双挂载）、都没有 = 红（没挂载）；检查项总数仍 **16**。
- **`test/ws-install.test.mjs`**：健康夹具改走 bundle 通道；**新增 S11 四种态**（bundle-only 绿 / manual-only 绿 / both 红 / neither 红）。
- **`test/install-link.test.mjs`** 夹具同步。
- **新增 `test/bundle.test.mjs`（6 条）**：B-1 声明齐全 · B-2 patch 只插 UI 一行 · B-3 `findManualUiRow` 三态 · B-4 bundle 优先+备份+幂等 · B-5 dry-run 零写 · B-6 registry 规格不被改写。
- **变异自检（4 条，逐条实测红）**：删 `dsh.bundle` ⇒ B-1；patch 塞引擎行 ⇒ B-2；安装器不删手工行 ⇒ B-4；判据退回「bundle 里不许有」⇒ S11 + S10e-1。

### 验证

- 全量：**443 passed / 0 failed**（36 个测试文件；436 + 6 bundle + 1）
- `rooms` **15/0** · `ws-install` **14/0** · `install-link` **29/0** · `bundle` **6/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.423 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）
- `npm pack --dry-run --json`：**70 文件**（69 + `cordis.patch.yml`）/ 558,113 B；`test/`·`tmp/` 命中 0
- live 当前仍是**手工通道**（`bundle=无｜手工行=有`）—— `verify-install` 按「二选一」判据通过

**未验证（必须知道）**

- **未跑 live install**：`--apply` 到真实 profile 的 bundle 切换没有执行过（只在 dry-run 与夹具上验证）。
- **未启 DSH**：bundle 通道在真实插件树里的加载行为未观测。
- 从手工通道切换到 bundle 的**中断恢复**只在单测里模拟（顺序保证 + 备份），真机未演练。

## 1.11.1 — 2026-10-30

### P6-C 落地：未落地尝试不再被当成残留（**热清单新增 OPTIONS 段**）

1.11.0 之前，**超过 10 分钟仍没落地的尝试**（`to===null && result==="untested"`）被归进 `residue` 一起从热清单里丢掉。
这是错的：它不是残留，而是**「你可以继续，也可以放弃」的选项** —— 模型有权知道它存在。

**P6C-1 · 悬空边从四类变五类**

| 类 | 判据 | 进热清单？ |
|---|---|---|
| `residue` | `to===null` 且**已结算**（`result !== "untested"`）且 >10 分钟 | 不进（真残留，可归档） |
| **`candidate`（新）** | `to===null` 且 `result === "untested"` 且 >10 分钟 | **进 OPTIONS 段**，陈旧标 `[stale 42m]` |
| `live-unsettled` | `to===null` 且 `untested` 且 ≤10 分钟 | 进 OPTIONS（新鲜） |
| `from-broken` | `from` 指向不存在的节点 | 保留可见 |
| `none` | 其余 | — |

- 新增导出 `isDanglingOption(edge)`：只认 `result==="untested"` 的无终点边；**刚结算的失败边不算选项**
- `renderLedger` 新增 `OPTIONS (not yet landed — you may continue or abandon):` 区段；**UNVERIFIED 不再包含未落地的边**
- `renderFacts` 同样拆出 OPTIONS 段，并加 `STALE_UNSETTLED: N edges are untested and older than 10min — listed as OPTIONS …, NOT residue.` 计数行
- 测试 +3（`[stale 42m]` 标记 / settled 仍归 residue 的回归 / renderFacts 拆分与计数）

### P6C-2 · 迁移工具晋升为房间 R14 + 独立 CLI

- **`src/rooms/migrate.mjs`（20,913 B / 21 导出）**：`planSession` / `buildSidecar` / `removeEdges` / `listSessions` / `dryRun` / `freshSessions` / `backupTree` / `rollback` / `apply` / `verify` + 路径规则
- **`scripts/migrate-dangling.mjs`** 新 CLI（默认 dry-run）＋ `scripts/cli.mjs` 增 `migrate-dangling` 子命令；参数 `--apply` / `--verify` / `--rollback` / `--backup` / `--root` / `--backup-dir` / `--sessions=` / `--force` / `--now` / `--json` / `--help`；退出码 0/1/2
- **只归档 settled residue** —— `candidate` 一条都不动，且 `planSession` 有硬断言：`residue` 集合里出现 `result==="untested"` 就抛错（防判据回退时悄悄归档）
- **路径经 R01**：`sessionsRoot()` = `join(graphRoot({...}), "sessions")`，不自己拼
- **120s 新鲜度守卫**：`--apply` 前扫会话目录，任一 `graph.json` 的 `|now − mtime| < 120s` ⇒ **拒绝 apply 且不备份、不写任何文件**（用绝对值：NTFS 时间戳可能比 `Date.now()` 超前几毫秒）；`--force` 才跳过
- **备份写到 `sessions/` 之外**（`<DSH_HOME>/chess-context/migrate-backups/backup-<ts>`），否则会被自身 `cpSync` 递归
- **坏图逐会话汇总**：`dryRun`/`apply`/`verify` 都返回 `badGraphs:[{session, ok:false, reason}]`（旧原型静默跳过）
- 原型 `test/archive-dangling.mjs` 删除，测试迁为 `test/migrate.test.mjs`（**10/0**：7 条原有 + 路径经 R01 + 守卫 + 坏图）

**P6C-3 · 隔离目录端到端演练（PASS）**

夹具 2 会话 × 5 边（residue / candidate / live / from-broken / 真失败各一），跑前跑后 `git status` = 0：

| 阶段 | 结果 |
|---|---|
| dry-run | `residue:2 / candidates:2 / liveUnsettled:2 / fromBroken:2`，`deltaBytes:-68`；**整树 sha 前后完全相同** ⇒ 真的没写 |
| apply | 归档 **2 条 residue**、**`candidate` 一条未动**（重算 residue=0 / candidate=1）、`-68 B` |
| sidecar | 每会话 `graph.dangling.json`：源图 `sha256`/`bytes`/`criteria` + 归档边**全字段** ⇒ 可回灌 |
| verify | `ok:true`，抽样边与备份图逐字段相同，`problems:[]` |
| rollback | 整树 sha **回到原值** ⇒ 逐字恢复 |

### 发布流程修复：`release.mjs` 现在打 **annotated tag**

1.10.0 / 1.11.0 的 tag 是**轻量 tag**（`git cat-file -t` 只看到 `commit`）—— 没有作者、日期、消息，
GitHub Release 的 Tag 一栏是空的，「这一版改了什么」在 tag 上查不回来。
**修复**：`scripts/release.mjs` 的计划文本与真做命令统一为 `git tag -a <tag> -m "release <tag>"`；
`scripts/check-maintenance.mjs` 增加静态断言 ⑦ 盯着这条，谁改回 lightweight 立刻红。
⚠ **已发布的 `v1.11.0` 不追改**（tag 是对外契约）；规则从**本版起**生效。

### 验证

- 全量：**436 passed / 0 failed**（36 个测试文件；A3 收口 430 + P6C-1 的 3 + P6C-2 的 10 − 原型 7）
- `rooms` 架构门禁 **15/0** · `migrate` **10/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.333 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）—— 与基线逐字一致
- `npm pack --dry-run --json`：**69 文件**（67 + `rooms/migrate.mjs` + `scripts/migrate-dangling.mjs`）/ 552,403 B；`test/`·`tmp/`·harness 命中 **0**

**未验证（必须知道）**

- **对 live `sessions/**` 的 apply 从未执行** —— P6C-3 是隔离夹具（2 会话），真实库是 150 个会话 / 13,043 个 agent 节点；规模与真实判据分布都没经历过。
- **停插件窗口流程一次都没跑**（隔离目录压根没碰运行中的插件）。
- **sidecar 回灌未实现**（字段齐全 ≠ 有回灌工具）。
- P6C-2 有一处**契约文字偏差**已披露：契约 R14 的允许依赖未列 R06，但判据必须单一来源（`classifyDangling` 只在 R06）⇒ 房间实际 import `./ledger.mjs` 的判据函数与 `DANGLING_STALE_MS`，已补进 ROOMS 的 allowed 表。

## 1.11.0 — 2026-10-30

### 最小交付房间架构收口：A2 + A3 全部完成（**首个把 16 房间落到底的正式版**）

1.10.0 只做到 A3-1a/b/c（三个房间 + 8 个门面还在）。这一版把 **A3 剩余四刀、删门面、四条新门禁**全部做完：
**`src/` 顶层只剩 `engine.mjs`（R09）与 `ui.mjs`（R11）**，其余 11 个房间全部在 `src/rooms/`，
**8 个旧门面已删除**（任何复活都会被门禁判红）。

**A3 物理搬迁 · 后四刀（纯移动，旧路径留一行 `export *` 门面）**

| 刀 | 房间 | 文件 | 自证方式 |
|---|---|---|---|
| A3-1d | `R00 kifu-model` | `src/graph.mjs`（1,136 行 / 47,853 B）→ `src/rooms/kifu-model.mjs` | `git` 100% 重命名，0 行改动；导出面 43 === 43 |
| A3-1e | `R03 keeper` | `src/keeper.mjs` + `src/extract.mjs` → `src/rooms/keeper.mjs`（12,335 B） | 合并正文与「两份备份去 import 后拼接」**逐字节相同**；导出 11 === 11 |
| A3-1f | `R06 ledger` | `src/ledger.mjs`（871 行 / 55,948 B）→ `src/rooms/ledger.mjs` | 对备份 `diff` **只有 2 行**（`./graph.mjs`→`../graph.mjs`、`./verifier.mjs`→`../verifier.mjs`） |
| A3-1g | `R07 facts-prompt` | `src/summary-prompt.mjs`（101 行）→ `src/rooms/facts-prompt.mjs` | `cmp` **逐字节相同**，零 import 修正 |

**A3-2 · 删除 8 个旧门面 + 一次性改 import**

- `git rm src/{verifier,range,worldstate,graph,keeper,extract,ledger,summary-prompt}.mjs`
- 重写 **44 个文件 / 77 行** import（纯路径，无断言改动）：`src/engine.mjs` 6 条、`src/rooms/*` 5 条、
  `test/` 37 文件 + `scripts/doctor.mjs`
- **pack 75 → 67（−8）**：这正是「门面存在时同一份实现有两个入口」的代价被消掉的直接体现

**A3-2-fix + A3-3 · 让「删门面」可被机器判定（4 + 2 条新门禁，`rooms` 9 → 15 用例）**

| 规则 | 断言 |
|---|---|
| `src/` 顶层白名单 | 只允许 `engine.mjs` / `ui.mjs`（harness 生成物不计） |
| 已删门面引用扫描 | `src/` 与 `test/` 不得引用那 8 个名字；按**解析后的绝对路径**判定（房间内部同目录引用放行） |
| 最终路径 | `ROOMS` 每项 `file === <id>.mjs` 且真实存在；房间集合必须等于契约 11 个 |
| **C1/R-C 精确化** | `@deepseek-ai/*` 的 **import** 只允许出现在 `src/engine.mjs`，且宿主说明符集合必须**恰好**那 4 个 —— 判据按**说明符**而非裸文本，所以 preset 块与注释里仍可写官方包名（行为面冻结） |
| **R-E** | `src/engine.mjs` 不得 import `rooms/migrate.mjs`（P6-C「禁止 engine 启动钩子」的机器判据） |
| **R-F** | `src/`·`scripts/`·`lib/` 不得出现 `allowedModels` 字样（宿主全局配置，插件不读不写） |

每条都带**判据自检**与**变异自检**（恢复 `src/graph.mjs`、把测试 import 改回旧路径、给引擎偷 import `schemastery`、
给 engine 加 migrate import、在 doctor 里写 `allowedModels` —— 5 组全部实测变红，还原后 15/0）。

**隔离实例运行时验证（A2-R / A3-R）**

- **A2-R PASS**：`tmp/dsh-gokifu-compact/test-home/`（独立 `DSH_HOME` + profile `test`，headless 不占端口）——
  `compaction start → summary → end` 一次完整、`foldCount=1`、摘要含完整棋谱结构；桌面
  `profiles/desktop/cordis.patch.yml` sha256 `047a342e…` / mtime / size **三项跑前跑后全同**，19387 同 PID 仍在监听。
- **A3-R PASS**：在 `0b61fb9` 干净树上复跑（跑前/跑后 `git status` 均 0 项）—— EXIT 0、`foldCount=1`、摘要 **7 段齐全**、桌面与仓库零变化。

**验证**

- 全量：**430 passed / 0 failed**（36 个测试文件；A3-2-fix 426 + A3-3 新增 4）
- `rooms` 架构门禁：**15/0** · `verify-install`：**16/16**
- `bench 2000`：**351 tokens** / 1.133 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）—— 与迁移基线逐字一致
- `npm pack --dry-run --json`：**67 文件** / 539,339 B / `9f7e2a4b0c923066eb7ef29ffa6d26364da6715f`；`test/`·`tmp/`·harness 命中 **0**

**未验证（必须知道）**

- **A2-R / A3-R 都是隔离实例，不是 live 桌面重启** —— live 侧（19387）的注入与落盘行为仍未在真实会话中观测。
- **运行期收益未验证** —— 性能数字全部来自离线夹具。
- `lib/client.js` 的 `FIELDS`（15 键）仍是配置的第 4 份来源（收敛 4/5），留待 R12。
- R14 `migrate` 房间仍未创建（P6-C 原型在 `test/archive-dangling.mjs`，未接 CLI）。

## 1.10.0 — 2026-10-30

### 房间化架构：A2 五刀 + A3 前三刀（**GitHub 试用版，桌面不自动更新**）

> ⚠ **分发说明**：1.10.0 **只发 GitHub Release，不发 npm**。DSH 桌面端只认 npm registry，
> 因此**不会自动更新到本版**；想试用请从本 Release 的源码/tarball 手动安装。
> npm 上的 `latest` 仍是 1.9.3。

这一版把「上下文压缩后端」从单文件堆拆成 **16 个房间（R00–R15）**，落地了 A2 全部五刀与 A3 前三刀。
**行为零变更**：所有搬迁都是纯移动 + 旧路径留一行 `export * from "…"` 门面，热清单文本 / classify 判据 /
`graph.json`·delta 字节 / preset 块格式**一个字节都没动**。

**A2 · 五刀（抽房间 + 收敛配置来源 + 删死接口）**

| 刀 | 房间 | 内容 | 验收 |
|---|---|---|---|
| A2-1 | `R15 preset-format`（8,364 B） | preset 纯文本格式 `parseEngineBlock` / `renderEngineBlock` / `replaceCompactionBlock` / `engineBlock` / `KEY_COMMENTS`；`src/ui.mjs` 与 `scripts/install.mjs` 双用（install 必须 re-export，删掉会让 3 个测试红） | 390/0 · pack 65 |
| A2-4 | `R15 config-schema`（14,968 B） | 配置的**单一来源**：`SCHEMA` 23 键 / `PRESET_KEYS` 16 / `BASE_KEYS` 11；`resolve()` / `describe()` / `validatePatch()` / `engineBlock()` 全部派生。**收敛 4/5** —— `lib/client.js` 的 `FIELDS`（15 键硬编码）仍是第 4 份，留待 R12 | 401/0 · pack 66 |
| A2-5 | — | 死接口清理（纯删除）：`renderTranspositionWarning` / `incomingEdges` / `outgoingEdges` 及 engine 里的无用 import / re-export | 401/0（同数）· pack 66（−664 B） |
| A2-2 | `R01 kifu-persist`（12,364 B） | 落盘与增量协议搬出 engine：`load` / `flush` / `persistBudget` / `paths`，吃注入的 fs `port`。**两处行为单列**：① load 读不出/版本不符 ⇒ `{repaired, repairedReason}` + 一行 warn（旧版静默建空图）；② flush 失败 ⇒ `{ok:false, error, dirtyKept:true}`，dirty 照旧不清 | 412/0 · pack 67 |
| A2-3 | `R08 hot-inject`（12,554 B） | 每步注入策略搬出 engine（259 行）：`#bindLedger` / `foldFailureWarning` / `ledgerDigest` / `findLedgerNode` / `messageTextOf` / `elideLegacyLedgers`；`createUserMessage` 由 R09 参数注入 ⇒ **R08 不 import DSH** | 424/0 · pack 68 |

> A2 之间还有一刀 **A2-2-fix**：`rooms` 门禁补 `ROOMS` 登记表与 4 条用例（未登记文件必须红、方向依赖断言），416/0。

**A3 · 前三刀（物理搬迁，旧路径留一行门面）**

| 刀 | 房间 | 文件 | 验收 |
|---|---|---|---|
| A3-1a | `R04 verify` | `src/verifier.mjs` → `src/rooms/verify.mjs`（17,914 B，325 行原样） | 424/0（同数）· pack 69 |
| A3-1b | `R02 fold-planner` | `src/range.mjs` → `src/rooms/fold-planner.mjs`（6,502 B，git 100% 相似度） | 424/0（同数）· pack 70 |
| A3-1c | `R05 world` | `src/worldstate.mjs` → `src/rooms/world.mjs`（3,292 B）；内部 import `./graph.mjs` → `../graph.mjs`（下沉一层） | 424/0（同数）· pack 71 |

**四条可静态断言的架构方向规则**（`test/rooms.test.mjs`，9/0）：
R-A `src/**` 不得 import `scripts/`/`lib/`；R-B R00–R08 不得 import `@deepseek-ai/*`/R09/R11/`scripts/`；
R-C **R09 之外**任何文件不得 import `@deepseek-ai/*`；R-D `lib/client.js` 不 import 仓库内文件、R10/R14 不 import R09。

**验证**

- 全量：**424 passed / 0 failed**（36 个测试文件）
- `verify-install`：**16/16**
- `bench 2000`：**351 tokens** / 1.336 ms（81260 / 386945 字符、1.41 MB、2001 节点）—— 与迁移基线逐字一致（ms 为运行噪声）
- `npm pack --dry-run --json`：**71 文件** / 537,438 B / `49c13887ff3fa9c23e46d573df7410f84b00b3a0`；`test/`·`tmp/`·harness 命中 **0**
- `rooms` 架构门禁：**9/0**

**未验证（必须知道）**

- **真机重启验证（A2-R）未做** —— 全部 424 项都在假 ctx / 夹具上跑；真实 surface `replace` 行为未在桌面 DSH 上观测。
- **运行期收益未验证** —— 性能数字全部来自离线夹具。
- A3 物理搬迁只做了 3/7 刀：`graph` / `keeper+extract` / `ledger` / `summary-prompt` 仍在原位。

## 1.9.3 — 2026-10-30

### 修 README 版本行（1.9.2 的发布缺陷）

1.9.2 的 npm 包里 `README.md` 第 3 行仍写着「当前版本 1.9.1」—— 用户装上包后第一眼看到的就是错的版本号。
本版**只修这一处**：`README.md` 第 3 行 = **1.9.3**，与 `package.json` 的 `version` 一致。

- 代码零改动：`src/`、`scripts/`、`lib/` 与 1.9.2 逐字节相同。包内其余差异只有 `package.json` 的版本号、
  `README.md`（本修复），以及 `docs/` 两份维护文档的最终稿。
- 发布门禁新增硬断言：`README.md` 的「当前版本：x.y.z」必须等于 `package.json` 的 `version`，不一致即拒绝发布。
- 单测 **378 项全绿**（含 task-59 的测试夹具改造；`test/` 不进包）。

## 1.9.2 — 2026-10-30

### ⚠ 破坏性契约变化：`graph.json` 不再是「最新状态」

**1.9.2 起，落盘拆成「上一回合基线 + 当前增量」：**

| 文件 | 内容 |
|---|---|
| `graph.json` | **上一个回合边界**的完整基线 |
| `graph.json.delta.jsonl` | 本回合的增量帧，一帧一行 `<baseHash16>\t<checksum31>\t<json>` |

`graph.json` 只在**回合边界**（`agent/status idle`）落一次；回合内每一步只追加 delta 帧。
⇒ **外部工具若只 `JSON.parse(graph.json)`，会少一个回合的数据。** 最新状态 = 基线 + 按序重放 delta
（`fromJSON` → `decodeDeltaFrames(text, baseHash)` → `applyDelta`，三个函数在 `src/graph.mjs`）。
README 新增「graph.json 契约（外部工具必读）」一节，含三条余量（短回合写放大 / dirty>100 flush / `appendFileSync` 跨平台）。

### P3 · flush 写放大 ×800–975 治理（增量 delta + index 追加 + dirty 节点）

- `graph.json.delta.jsonl`：每步只追加 dirty 节点/边（绝对 upsert）+ 标量 + order 追加；
  合并阈值 `max(64KB, 基线 20%)`，超过则写新基线（`tmp` → `rename`）并清空 delta
- 崩溃安全：帧带 `baseHash`（generation 保护，基线重写后旧帧整体忽略）+ `checksum31`
  （半写帧就地停止并截断到最后一个好帧）+ 幂等重放（同一批帧重放多次结果相同）
- `index.md` 稳态**追加**增量段（~200–800 B/次），fold / 首次 / 缺失 / >256KB 时全量重建；
  `nodes/*.md` 稳态不写，只记 pending，fold 时只写 dirty
- 实测（三张真实图 × 60 步 + 1 回合边界）：写放大 **×80.16 / ×70.04 / ×61.75 → ×37.41 / ×33.31 / ×30.75**；
  稳态每步写 **10.5–11.8 KB → 591–713 B（−94%）**；fold 后 flush **429–836 ms → 9.4–22.9 ms**
  （5–20 个 dirty 节点）/ **76.5–88.8 ms**（100 个）
- 测试：`test/persist-incremental.test.mjs` **8 项**（重放等价 / 幂等 / 半写帧 / generation 保护 /
  index 增量 / engine 端到端 / nodes dirty）
- 已知边界：**极短回合（<10 步）** 每回合的全量基线摊销不足，写放大仍可能 >×50；
  `appendFileSync` 跨平台原子性未验证

### P4 · 首屏 `state` 的 graph.json 解析缓存

- `src/ui.mjs` 新增 `(绝对路径, mtimeMs, size) → 聚合摘要` 缓存 + `pruneGraphCache()`：
  改文件必失效（同 mtime 但 size 不同也失效）
- 133 图 / 33 MB 实测：热路径 p50 **140.5 ms → 20.9 ms**（另一轮 **242.5 → 51.1**）；
  冷路径也更快（**170.7 → 101.3** / **386.4 → 196.7**）；`state` 响应 **3,648 B 逐字相同**
- 测试：`test/ui-perf.test.mjs` **10 项**

### P5 · 生产口径 token 预算与 `pickFallback`

- `renderLedger` 新增 `fallback` 三态（`none` / `over-budget` / `impossible`）+ `overBudgetBy`：
  **不再静默返回超预算文本** —— 调用方拿到的每个结果都能区分「预算内 / 兜底超限 / 无解」
- `pickFallback` 择优顺序固定：预算内优先 → tokens 最小 → 平手列得多；全超选最省并标 `over-budget`；
  无非空文本返回 `null`（`impossible`）
- 生产口径（`treeDir` = 真实会话目录、`maxTokens=500`，133 图）：
  **>500 = 24/133（与 1.9.1 HEAD 的 24 相同，新增 0）**、avg **444.80**（HEAD 430.85，+13.95 ≤ +20）、
  max **905**（与 HEAD 完全相同）。24 张全部是 L4/L5 兜底档 —— 正文本身 >1500 字符，不是预算记账 bug
- 测试：`test/ledger-budget.test.mjs` **7 项**

### P6a · `TRACE:` 行绝对路径改相对，回收 avg +17 tok/图

- `TRACE:` 从 `D:\DeepSeek Harness\home\chess-context\sessions\<sid>/index.md …`（137.7 字符）
  改成 `sessions/<sid>/index.md`（57.5 字符），`traceRoot` 可配置（默认无前缀，生产传 `sessions`）
- 生产口径 133 图：avg **445.08 → 429.64（−15.44 tok/图）**；over500 **24 → 18**；max **905 → 878**；
  逐会话 85 便宜 / 7 变贵（5 个是 TRACE 变短后落进更低档位、列了更多内容）/ 41 不变；
  `renderFacts` **133 图 0 差异**
- 测试：`test/trace-relative.test.mjs` **7 项**（Windows 盘符 / POSIX 用户名路径 / traceRoot 可配置 / 不泄漏绝对路径 …）

### P6-A · 悬空边只在分析中排除（不剪数据）

- 新增 `classifyDangling()`（`residue` / `live-unsettled` / `from-broken` / `none`）与 `danglingStats()`；
  **只过滤显示，不改 `graph.json`**
- 判定：`residue := to==null && age>10min`；**`live_unsettled`（untested 且 ≤10 分钟）必须保留可见**
  —— 这是 Lead 批准的**更保守**口径（keeper 先 settle 结果、`step/end` 才回填 `to`，
  按字面公式会把刚结算的新鲜失败当场隐藏）
- `from` 悬空 **214 条**（全在 `5acafe42`，`mergeNodeInto` 老 bug）单独标记，不混入 `to=null` residue
- 实测（133 图）：热清单**无终点失败边 158 → 0**；avg **−18.98**；over500 **17 → 17**；max **878 → 878**；
  全库 `residue 5,566 / liveUnsettled 1 / fromBroken 214`
- `renderFacts` **仍列全部失败边**（失败记忆不丢），新增 `DANGLING_RESIDUE: N` / `FROM_DANGLING: 214` /
  `LIVE_UNSETTLED: N` 显式计数
- 测试：`test/dangling-exclusion.test.mjs` **8 项**

### P7 · `fallback` 与 `traceRoot` 接进 engine / doctor（不留死开关）

- `src/engine.mjs`：新增配置 `hotLedgerTraceRoot`（schema 默认 `"sessions"`），生产 `renderLedger` 调用传
  `traceRoot: "sessions"` ⇒ 生产热清单 `TRACE:` 为 `sessions/<sid>/index.md`，不泄漏盘符/用户名
- engine **消费** `fallback`：`over-budget` → warn 日志含 `overBudgetBy=` / `budget=`；
  `impossible` → error；`ledgerBudgetMetrics` 累计并原子落盘 `<graphDir>/ledger-budget.json`；
  提供 `getLedgerBudgetStats()` / `onLedgerBudget` 钩子（可测，不静默）
- `scripts/doctor.mjs`：新增「热清单预算（fallback）」项，显示 `none / over-budget / impossible` 分布与
  `maxOverBudgetBy`；字段缺失写「未采集」；`impossible > 0` 记 error
- 测试：`test/engine-harness.test.mjs` 增至 **25 项**（+4 条 P7 接线用例）

### S2b · `no-exit` 弱成功按 N1 收窄

- `verifier.classify()` 的 shell 分支：`[exit code]` 存在时行为不变；**无退出码时默认给 `weak:"shell"`**，
  命中 N1 任一规则则不给。`result` **永远是 `unverified`**（不进已验证事实）
- N1 八条 veto 规则集中在 `SHELL_WEAK_VETO_RULES` 一处（id + 说明 + 正则）：末行自报非零 / 末行 `Node.js vX` /
  尾部 node 栈迹 / `command not found`·`No such file`·`cannot stat` / 行首 `SyntaxError|AssertionError|…` /
  `FAILED (failures=N)` 等；规则表可测试、可追溯
- 真实采样：全标 weak 的误报率 **2.94% → 收窄后约 0.49%**（≈48/9762 条假进展）
- 测试：`test/weak-shell.test.mjs` **13 项**（每条规则命中/不命中 + 旧图兼容 + renderFacts 不变 + 变异自检）

### 测试

- `node test/run.mjs`：**373 passed / 0 failed**（30 个测试文件，`EXIT 0`；2026-10-30 03:2x 实测）
- 新增测试文件：`persist-incremental`(8) · `ui-perf`(10) · `ledger-budget`(7) · `trace-relative`(7) ·
  `dangling-exclusion`(8) · `weak-shell`(13)；`engine-harness` 21 → **25**

## 1.9.1 — 2026-10-29


### 修图坍缩：全库 61.3% 的边是自环（三份独立评估共同指向）

事故：`worldstate.touch(paths)` 收到的是**单个路径字符串**（`engine.mjs` 的
`st.touchPath = (p) => world.touch(p)`），却按可迭代对象遍历 ⇒ 一个路径被拆成逐字符的
20 多个「路径」⇒ 触碰集合是十来个字符 ⇒ `hash()` 对所有会话、所有步骤返回**同一个哈希**
⇒ `addAgentNode` 每步命中同一 `stateIndex` 节点 ⇒ `step/end` 把边的 `to` 指回 `from`。

实测：全库 **6,172 / 10,059 = 61.3%** 自环，边/节点 3.36，极端会话 530 边 / 23 节点。
连锁后果：`tewariAnalysis` 的同终点判定恒真 ⇒ **`dead` 判定 109/109 全错**、
`redundant` 135 条全假 ⇒ 热清单告诉模型「这条路永远别试」，真相只是「同一步里另一条命令成功了」。

四处修复：
- `worldstate.touch()`：兼容 string / array 入参，单字符丢弃
- `addAgentNode()`：置换命中**本步起点**时强制新建节点（真正的置换——回到更早状态——照旧复用）
- `tewariAnalysis()`：自环边不入手割；自环成功边不算替代路径
- `failureClass()`：`edge.to !== edge.from` 才能判 `dead`

### 修两个真 bug（评估中发现）

- **fold 后 `nodes/*.md` 从不刷新**：`#flush(session, { md: true })` 的键名写错（签名是 `tree`）
- **摘要上限三处默认互相矛盾**：Config 4096 / resolveChess 2048 / 安装配置 8192 ⇒ 统一 8192
  （3072~4096 在真实会话里会贴边触发 `MAX_TOKENS`，历史 82 次）

### 压缩失败不再静默

- 连续失败计数进热清单：`⚠ CONTEXT COMPRESSION IS FAILING (N consecutive folds failed; last error: …)`，
  成功一次即清零。此前只写 `logger.warn`，实测 856 次失败 / 5.5 小时无人知晓。

### 诊断与清理工具

- `graphHealth(g)`（`src/graph.mjs`）：自环数 / 自环率 / 边节点比
- `doctor`：新增「图结构（自环）」一项
- `verify-graphs`：报告图健康度，自环 ≥5% 标 ⚠
- `test/rewash-selfloop.mjs`：清洗历史自环边（保留边与结果，只把 `to` 置 null），dry-run 默认、带备份
- 已对全库执行：自环 **6,172 → 0**，坍缩图 **42 → 0**

### 只读工具的「成功」只进 WORKING，不进已验证事实（S2a）

根因：`read` / `grep` / `glob` 这类只读工具执行成功，只能说明「读到了」，不能说明「任务往前走了」。
旧实现把它一律计为 `unverified` ⇒ 纯只读会话的热清单里**没有 WORKING 路径**（实测 106 个会话里
只有 21 张图能渲染出 WORKING），模型看不到「我刚才走到哪」。

- `verifier.classify()`：只读类工具（`read` / `mcp-read`）+ 输出非空 + 无任何失败信号 ⇒ 额外给
  `weak: "read"`，**`result` 仍是 `unverified`**（不改既有语义，避免 `failureEdges` / `openEdges` /
  `tewari` 的判定漂移）
- keeper 落账 `edge.weak`；`renderLedger` **只在没有强 success 锚点时才**用弱边建 WORKING，
  渲染时标 `[weak k/n]` + 图例；旧图按 settle 时已写的 `verify.kind === "read"` 识别
- `renderFacts` 的 `UNVERIFIED_CLAIMS` 段**继续列**这些边 —— 弱成功不会被当成已验证事实
- 实测（活库 106 会话）：有 WORKING 的会话 **21 → 39**（+18，回退 0、既有行变化 0）；
  日志回放 106 份：**25 → 44**（+19，丢失 0）；`dead` / `redundant` / `longer` 增量 **0**；
  `renderFacts` 逐字不同 **0**；热清单仍 ≤500 tokens

### 可选严格不变量门禁 + 历史图豁免（S1a / S1c / C-13）

- `test/graph-invariants.mjs`（新）：纯判定层，四条判据 —— `degenerate-graph`（节点 0 但有边）、
  `self-loop`（`from === to`）、`edge-per-node`（默认 >8）、`collapsed-graph`（自环率 ≥5%）
- `test/verify-graphs.mjs` 增 `--strict` 与三个阈值参数（`--max-self-loops` / `--max-edge-per-node` /
  `--max-self-loop-rate`）。**默认模式（无参 / `<目录>` / `--json`）一行代码都没改行为**：
  实测用 HEAD 版本与本版对同一份冻结夹具（132 张 `graph.json`）跑文本与 JSON 两种默认模式，
  **stdout / stderr 逐字节一致（`cmp` 无差异）、退出码一致**
- 为什么不设默认门禁：全库 `--strict` 下 **15 / 132 张图红** —— 2 张历史自环坍缩图
  （`session-1331683e…` 509/628 = 81.1%、`session-69dd787e…` 115/153 = 75.2%）+ 13 张旧版节点
  冻结造成的高 ratio（13 张全部 >8，最高 530 边 / 23 节点 = **23.04**）。这 13 张不可修（`to` 不可知、节点冻结不可逆），
  设默认会永久红 ⇒ 保留阈值 8、`--strict` 保持可选
- `test/graph-exemptions.mjs`（新）+ `test/fixtures/history-exemptions.json`：**显式、可审计、可过期的
  历史违规豁免清单**（C-13），只在 `--strict --exemptions=<文件>` 下生效。每条记录
  `sessionId` / 判据代号 / `E,N,L` 数值 / 理由 / 登记人 / 登记日期 / 有效期 / 指纹（由该图
  node+edge 全字段派生的 sha256）
  - **精确而非宽松**：一条豁免只吸收「同一张图 + 同一判据 + 同一组数值 + 同一指纹」。
    同一张图的 ratio 继续增长、或新加一条自环 ⇒ **照样红**
  - **豁免 ≠ 通过**：被豁免的 17 条逐条打印（⊘ 带登记值与理由），并单独报告
    「豁免前 N 张违规 → 豁免后 M 张」
  - **实测**（同上冻结夹具）：`--strict` 15 张红 →加 `--exemptions` 后 **0 张红、退出码 0**
    （17 条违规被已登记条目吸收）
  - 到期日（默认 2027-06-30）过后自动失效恢复判红，且不是静默的 —— 输出会打「已过期 N 条」
- 测试：`test/graph-invariants.test.mjs` 31 项（含 CLI 端到端退出码、逐图 ✓/✗ 与退出码同口径）；
  C-13 另有已登记图绿 / 未登记坏图红 / 数值变化仍红 / 部分豁免 / 空清单 / 清单格式错误 / 过期失效等用例

### 安装判据统一 + 打包后 `doctor` 真的能跑（S10a / B3）

- `scripts/link-path.mjs`（新）：`link:` / `file:` 依赖规格的**唯一**判据来源 —— `parseSpec` /
  `resolveSpecPath` / `samePath`（Windows 大小写不敏感）/ `statLink`（区分「没有 / 断链 / 指向别处」，
  不用 `existsSync`）/ `inspectProfileInstall` / `createDirLink`（Node junction，免 shell 引号，
  中文与空格安全）/ `removeDirLink`（只删链接，真目录拒删）
- `scripts/install.mjs` 改用它：断链与「指向别处」的 junction 会重建，不再「存在即跳过」；
  `mklink` 兜底实测中文 + 空格路径可用
- `test/verify-install.mjs` 修掉「读不到 package.json」式假绿：目标目录不存在时说「目标目录不存在」，
  不再给误导性措辞
- 🔴 **`doctor` 从 `test/doctor.mjs` 迁到 `scripts/doctor.mjs`**：`test/` 不在 `files` 里 ⇒
  1.9.0 及更早从 npm 装的用户跑 `npx dsh-gokifu-compact doctor` 会 **ENOENT**（README 的安装第 3 步
  就是这条命令）。1.9.1 起 doctor 与 `cli.mjs` 同在 `scripts/`，随包发布
- `test/install-link.test.mjs`（新）29 项，含 4 组变异自检（判据退回字符串比较 / 安装器退回
  「键在就跳过」/ junction 退回「存在即跳过」/ 入口判据退回字符串比较，各自必须变红）

### 安装验证的诊断措辞、占位红与入口判据（S10c / S10e / C-12）

- `test/verify-install.mjs`：目标目录不存在 / `package.json` 缺失 / 坏 JSON / 没有 `name` **各给各的措辞**，
  不再一律写「读不到 package.json」（实测：坏状态的根因是 `link:` 指向的目录不存在，
  旧文案会把人引到错的排查方向）。`manifestError` 现在进 ✗ 详情
- 检查项总数**恒为 16**：`profile/package.json` 缺失时补 5 条占位红（首条带路径）、`preset` 缺失时补
  4 条占位红 —— 缺文件不再让总数缩水（缩水等于悄悄少查）
- `test/ab-render.mjs` 的入口判据改成 `fileURLToPath` + `realpath` 等价判定：
  旧判据「`import.meta.url` 结尾等于 basename」在**非 ASCII 文件名**下静默不执行（exit 0、零输出 = 假绿），
  新判据对等价路径 / Windows 大小写 / junction / 非 ASCII 都判真，被 import 时零副作用
- `scripts/link-path.mjs` 与 `test/verify-install.mjs` 补末尾换行（`wc -l == awk NR`）
- 测试：`test/ws-install.test.mjs` **13 项**（S10c-1..5 / S10e-1..3 / C-12-1..5），16 个变异体自证不是假绿

### 版本号在中文路径下读成 `v?`（S10′）

`src/ui.mjs` 的 `HERE` 用 `new URL(import.meta.url).pathname` —— 得到的是**百分号编码串**
（`/D:/%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/…`），Windows 上交给 `readFileSync` 直接 ENOENT，
被 `readVersion()` 的 `catch` 吞成 `null` ⇒ 页面标题渲染成 `v?`。改用 `fileURLToPath`（Node 官方解码入口，
空格 `%20`、中文、`%7E` 一并还原）。测试用**派生值**而不是字面量：
① 当前真实中文路径读到的版本 === `package.json` 的 `version`；② 模块搬到「空格 + 非 ASCII」目录后读到的是那份
`package.json`；③ `fileURLToPath` 能还原、`pathname` 直读必失败（附 ASCII 对照组，证明断言不是常量）；
④ `package.json` 缺失时仍返回 `null`（保留既有容错接口）。`test/version-path.test.mjs` 4 项

### `/gokifu/api` 同源校验与备份轮转（A1 / A2 · 安全）

审计实测的原始缺陷：`/gokifu/api` 接受**跨站** `text/plain` POST —— `Origin: http://evil.example`
+ `content-type: text/plain` 得到 **200 且 preset 被改写**（`text/plain` 属 CORS 简单请求，
不触发预检，`OPTIONS` 上不返 `Access-Control-Allow-Origin` 挡不住写）。M2 的密钥字段一落地，
这条就升级成「任意网页可换掉你的摘要模型密钥」。

三段校验（全部在 `readBody` **之前**）：

| # | 规则 | 为什么是这条 |
|---|---|---|
| ① | `Host` 必须存在、合法、且为回环（`127/8` / `::1` / `localhost` / `*.localhost`） | 防 DNS rebinding —— 那种情况下 `Origin == Host == evil.example` 也自洽，只比同源挡不住。`webServer` 绑 `0.0.0.0` 时自动放开，其它非回环主机走 `DSH_GOKIFU_ALLOWED_HOSTS` 显式放行 |
| ② | 带 `Origin` ⇒ 必须与 `Host` 同协议 + 同主机 + 同端口 | 浏览器 POST 必带 `Origin` |
| ③ | 带 `Sec-Fetch-Site` ⇒ 只允许 `same-origin` / `none`，**`same-site` 也拒** | 实测本机 `127.0.0.1:19401 → 127.0.0.1:19400` 的来源报的是 `same-site` 而不是 `cross-site`，只拒 `cross-site` 会漏 |
| ④ | `content-type` 必须是 `application/json`（允许 `; charset=`） | HTML 表单发不出 JSON ⇒ 非 JSON 一律 415 |
| ⑤ | **缺 `Origin` ⇒ 允许，但 `Host` 必须回环** | 浏览器对 POST 一定带 `Origin`，缺它只可能是 curl / node / 本项目测试；这条是回归护栏，不能把本机工具一起拒掉 |

- 备份轮转：每个 preset 最多保留 **5** 份 `.bak-before-ui-<ms>`，超出的删最旧的；同毫秒多次保存用
  `-2`/`-3` 后缀防覆盖
- 密钥守卫：新配置块里出现密钥（键名以 `key`/`secret`/`password`/`credential`/`token` 结尾，或值形如
  `sk-…`/`ghp_…`/PEM 私钥头）**直接抛错不落盘**；源文件原本就有密钥时**跳过备份**并返回
  `backupSkipped`（否则每个备份都是明文副本）。密钥识别只回**键名**，绝不回值
- 测试：`test/ui-security.test.mjs` 25 项 —— 跨站 `text/plain` / 外站 `Origin` / `Origin: null` /
  同 IP 异端口（`same-site`）/ DNS rebinding 形状 / 缺 Host / 非 JSON content-type 全部 403 或 415 且
  preset 一字不变；同源浏览器请求与无 Origin 的本机调用仍 200（防止把功能改坏）
- ⚠ **已上线的 DSH 进程没有重启，跑着的仍是旧代码** —— 本修复要在重启后才生效

### 性能：热清单渲染与三层树渲染的索引化（P1 / P2）

**P1 · `tewariAnalysis` 记忆化 + transposition 索引化**（`src/graph.mjs`、`src/ledger.mjs`）

热清单渲染的热点在 `tewariAnalysis`：一次 `renderLedger` 会在每个档位各算一遍手割，全库一轮调用
3,523 次而必要只有约 800 次；置换提示对每条路径做 `Object.values(g.edges).some(...)`，是 O(path×E)。
「无缓存」的代价实测是 **234ms/次**（`session-c328440a`，158 节点路径）。

- 每张图维护 `tewariIndex`（`byFrom` 邻接表 + 每节点可达集 + 失败边结论缓存），挂在 WeakMap / 非枚举
  Symbol 上，**不进 `graph.json`**；缓存键 = 结构修订号 + `updatedAt` + 边/节点数 + `to`/`from` 数字和
  （数字和专门兜住「同毫秒两次 settle」与「绕过 bump 直接改边」两种撞键）
- 旧实现把同一份「baseline 可达集 BFS」在两处各算一遍 → 合并成一次
- 置换提示改成预建 `Set`（`from>to`），`has()` 取代全表扫描

实测（133 张真实图）：`renderLedger` / `renderFacts` 输出**逐字节相同**；全库一轮渲染
**487.4ms → 70.5ms（6.9×）**，最差单图 **150.82ms → 8.99ms（16.8×）**；tewari 调用
**3,523 → 804（−77%）**。新增 `test/tewari-perf.test.mjs` 7 项（含「关掉记忆化必须退化」变异自检）。

**P2 · `renderIndexMd` / `renderNodeMd` 的 O(N×E) 索引化**（`src/graph.mjs`）

三层树的 index/node md 每次 debounce flush 都要重写：`renderIndexMd` 每轮 BFS 都 `Object.values(g.edges)`
全表扫，`renderNodeMd` 每个节点各做一次入边/出边全表 filter —— 节点数一多就是 O(N×E)。
5000 边合成图上 `renderIndexMd` 要 **3,506.8ms**、`renderNodeMd` 要 **7,208ms**。

- `graphIndex(g)` 增加 `byTo`（入边表）；`renderIndexMd` 的 BFS / 根判定 / 出边查询与 `renderNodeMd` 的
  入出边查询全部走 `byFrom` / `byTo`；`renderNodeMd` 每次调用只取一次索引
- `renderIndex(g)` 用便宜键（`rev|updatedAt|nextEdge|order.length`）判缓存，不命中才算完整结构签名
  （否则逐节点调用会把 O(E) 签名乘 N 次：5000 边实测会从 6.4ms 退化到 14.9s）

实测：133 张真实图输出**逐字节不变**（index **133/133**、node md **7,843/7,843**）；真实最大图
**49.39ms → 0.54ms（91×）** / **51.46ms → 0.60ms（86×）**；5000 边合成图 **3,506.8ms → 4.26ms（823×）** /
**7,208ms → 6.37ms（1,132×）**。新增 `test/render-index-perf.test.mjs` 6 项。

> 两项都不改任何输出文本 —— 这是硬验收：性能优化若改变了模型看到的热清单，就不是优化。

### 测试

- 新增 `test/selfloop.test.mjs`（8 项）+ `engine-harness` 端到端 1 项（自环回归）
- 新增测试文件与项数：
  `test/weak-success.test.mjs`（22 · S2a）、`test/graph-invariants.test.mjs`（31 · S1a）、
  `test/install-link.test.mjs`（29 · S10a）、`test/ws-install.test.mjs`（13 · S10c/S10e/C-12）、
  `test/version-path.test.mjs`（4 · S10′）、`test/c17-path-at-every-level.test.mjs`（15 · C17）、
  `test/graph-exemptions.test.mjs`（12 · C-13）、`test/ui-security.test.mjs`（25 · A1/A2）、
  `test/ui-config.test.mjs`（13 · 配置写入正确性）、`test/tewari-perf.test.mjs`（7 · P1）、
  `test/render-index-perf.test.mjs`（6 · P2）
- `test/run.mjs`：**316 passed / 0 failed**（24 个测试文件，`EXIT 0`；2026-10-30 02:31 实测）
- 之前的 125 项无一覆盖 `from === to` —— 这正是这个回归能躲过所有自测的原因

## 1.9.0 — 2026-10-29

### 「上下文压缩」详情页（DSH 原生 GUI 里的第三方插件页）

左侧栏「插件 / 自动化任务」那一列新增一条 **上下文压缩**，点开是整页（与「自动化任务」同一套
`sidebar.panellist` + `main` 槽位，来自 asar 里的 `dsh-client-ui-schedule` 实现）。

**页面内容（MVP）**
- 状态：最近活跃会话（fold 后总量 / fold 次数 / 失败边 / 节点数 / 上次遮蔽）、今天汇总
  （fold 次数 / 会话数 / 合计遮蔽 / 全库失败边）、上次摘要真实 usage（含 provider/model）
- 参数（15 项）：自动压缩、触发阈值、增长闸、逐字保留、最小 fold 量、摘要方式、输出上限、
  热清单开关/预算/标记档/就地替换、置换检测、checkpoint 合并阈值、摘要 provider/model
- 操作：保存（写 preset + 自动备份，提示重启生效）、恢复默认、刷新；未保存改动会列出键名
- 只读展示配置来源路径

**结构（为什么这么切）**
- 包根 `dsh-gokifu-compact` = UI host 半（`src/ui.mjs`，注册 `POST /gokifu/api`），
  引擎挪到 `dsh-gokifu-compact/engine` —— 因为 `dsh-client-modules` 只对**包根说明符**做客户端发现，
  子路径条目不会加载 `dsh.client`
- 浏览器半 `lib/client.js`：`window.__ModuleLoader__.load` 形状、只 `require("react")`、
  数据全走 host 路由（不用 Typert —— 那是 DSH 构建期生成的，第三方拿不到）
- 安装器新增两步：preset 引擎名迁移（`dsh-gokifu-compact` → `/engine`）+ profile 的
  `cordis.patch.yml` 挂 `gokifu-ui`（都带备份、幂等）

### 测试

125 项全绿（新增 6 项 UI 测试：块解析/渲染回环、sanitizePatch 拦非法值、saveConfig 写盘+备份+
同值不重写、客户端 bundle 的 `__ModuleLoader__` 形状与两个 slot 注册、`POST /gokifu/api` 的
state/save/未知 action）

## 1.8.1 — 2026-10-29

### doctor：一天的 fold 收益一眼可见

- 新增「今天 fold 的总量」：`N 次（M 个会话）· 合计遮蔽 X tokens` —— 数据来自各会话棋谱的
  `foldMarks`（按 fold 发生的 `at` 过滤，不按文件 mtime），不用翻会话日志
- 实测（2026-10-29）：今天 26 次 fold / 12 个会话 / 遮蔽 **2,304,388 tokens**；重启后 **0 失败**
- 「上次 fold 的成本」继续显示真实 usage（含 provider 缓存字段：一次缓存命中的 fold 只有
  5,329 新输入 + 647,168 缓存读，冷启动那次则是 629,184 全新输入）

## 1.8.0 — 2026-10-29

### 配置 id 统一 + 安装改成「两条命令、不用手改 YAML」

- **配置项 id 改名**：preset 里的 `- id: chess-context` → `- id: gokifu-compact`，
  与展示名 `dsh-GOkifu-compact` 对齐（注入消息的 `source.kind` 仍是 `chess-context` ——
  那是跨版本的数据契约，改了会让历史会话里的旧清单认不出来）
- **新增 CLI**：`dsh-gokifu-compact install | revert | doctor`
  - `install` 自动找 profile/preset，把 preset 的 compaction group 里
    `@deepseek-ai/dsh-compaction-basic` 那一行换成 `dsh-gokifu-compact`；
    带备份（`.bak-before-gokifu-*`）、幂等、`--dry-run`、旧 id 自动纠偏
  - `revert` 恢复最近一次备份；`doctor` 转发体检
  - 逻辑只有一份（`scripts/install.mjs`），`test/install.mjs` 变成薄封装
- **不再声明 `dsh.bundle`**：本插件是「agent preset 内的压缩后端」，不是 profile 级 bundle。
  声明 bundle 会让 `dsh plugin add` 把它塞进 `dsh.profile.bundles`，于是顶层再挂一份，
  与 preset 内那份形成双实例（`ctx.compaction` 只能注册一次 ⇒ 构造期抛错）
- preset 示例默认写 `auto: true`：关掉原生 `compaction-basic` 不影响自动压缩 ——
  本插件继承同一个 `BasicCompactionEngine`（同一套 between-step 压力触发与 context-overflow 兜底），
  换的只是「压缩范围 = 上一个 checkpoint 之后」和「失败记忆逐字保留」
- `doctor` 新增两项检查：压缩后端已接管 / 原生已让位
- README 安装段重写为两步命令；新增 FAQ「关掉原生压缩，自动压缩还在吗？」

### 真机首折实测 + 三处收尾修复

- **GUI 里第一次真实 fold 成功**（重启后第一轮触发，`session-e16faf2b`）：
  遮蔽 seq 9–3167 / **440,847 tok** → 摘要 2 块 4.2K 字符（输入 629,184 / 输出 2,902 tok，`magpie/group/deepseek-v4.1-flash1017`）；
  surface 节点 1391 → 373，对话消息从 ~574K 降到 ~157K（面板 81% → 约 16%），热清单仍只有 1 条（就地替换生效）
- **修 `graph.checkpointSeq` 记错**：原来写「被遮蔽区间起点」（fold 后已不在 surface 上，实机一直是 9），
  改成写「checkpoint 消息的 seq」
- **`doctor` 三处改进**：压缩统计改 **1 小时窗口 + 最近成功/失败时间**（历史失败不再吓人，
  判定看「最新一条是不是成功」）；新增「上次 fold 的成本（真实 usage）」；树新鲜度支持批量修复
- **`test/build-tree.mjs --all`**：一次性重建所有 index.md 落后于 graph.json 的会话（本次修了 48 个 / 1760 个节点文件）
- **摘要输出上限抬高**：`maxTokens` 默认 2048 → 4096，preset 3072 → **8192** ——
  实测一次 fold 用掉 2,902 tok，3072 太贴边，触顶会 MAX_TOKENS 截断（截断 = fold 失败）
- **`graph.lastFoldUsage`**：每次 fold 的真实 usage（输入/输出/provider/model/时间）写进棋谱，计费对账不必再翻会话日志；
  `doctor` 对新旧图都能显示（旧图没有该字段时从会话日志的 `compaction/summary` 事件兜底）

### 测试

118 项单测全绿 · `verify-install` 13 项全过（含 isolate group 内仍是我们的引擎行）

## 1.7.1 — 2026-10-29

### 发布后收尾

- 维护检查 `scripts/check-maintenance.mjs` 适配本仓库：`evidence/`（测量数据，每跑一次 bench/measure 都会变）
  与 `test/.harness/`（测试产物）不再算「代码改动」—— 否则每跑一次基准都要求 bump 一次版本
- HANDOFF / README 写入发布信息（npm `dsh-gokifu-compact@1.7.0`、Release v1.7.0、安装命令）

## 1.7.0 — 2026-10-29

> 起因：自 v1.3.4 起累计 9 个版本未发布；本版是首个公开发布，汇总 1.3.5–1.6.3 的全部改动，
> 并把展示名统一为 `dsh-GOkifu-compact`（前缀小写、只有 GO 大写）。

### 首个公开发布（汇总 1.3.5 – 1.6.3）

**P0 修复：压缩 226 次只成功 3 次的根因**
- `worldHash` 类型契约（对象 → 字符串）+ `fromJSON` 加载边界自愈历史脏数据 + `stateIndex` 重建
- 实机 `session-5acafe42`：139 次 `worldHash?.slice is not a function`、223/226 次压缩失败；修后全库 1,279 个对象字段归零

**热清单（给模型看的那一小块）**
- 标记自带语义：`blocked:permission` / `dead retry-if:<edge>`；图例按用到的标记动态生成（出现即解释）
- 报错原文任何档位都不丢；手割多参照点（同一失败边相对每条成功路径分别结论）
- **清单就地替换**：surface 上永远只有一条（旧版累积过 176 条 / 81 万字符 ≈ 27 万 token）
- 历史清单一次性换成一行占位；2000 边渲染 0.478 ms / 323 tokens

**压缩本身**
- 增量 fold（只压 checkpoint 之后）+ 机械约束段
- 摘要三层降级：配置模型 → 路由模型 → 规则摘要（压缩永不因摘要模型挂掉而失败）
- 真实 dsh 进程里 fold 3~6 次全成功（`test/real-headless-fold.mjs`）

**工具与维护**
- `test/doctor.mjs` 体检、`test/measure-billing.mjs` 真实计费审计、`test/rewash-graph.mjs` 历史回洗、
  `test/verify-graphs.mjs` 全库健康、`test/ab-render.mjs` 标记 A/B 夹具
- 仓库维护照搬 `magpie-plugin-scaffold`：`scripts/check-maintenance.mjs` + `scripts/release.mjs`

### 展示名

- `DSH-GOkifu-compact` → **`dsh-GOkifu-compact`**（前缀小写、只有 GO 大写；包名仍为 `dsh-gokifu-compact`）
- GitHub 仓库同步改名：`MYCF711/dsh-GOkifu-compact`
- 修正 `cordis.patch.yml` 里写错的包名（`dsh-chess-context` → `dsh-gokifu-compact`）

### 测试

118 项单测全绿 + 真实包验证 8/8 + 真实进程 fold 3~6/6

## 1.6.3 — 2026-10-29

### 真实 DSH 进程里的首次 fold + 修掉「rules 模式从未成功过」的真 bug

**新增 `test/real-headless-fold.mjs`**：起一个**真正的 dsh headless 进程**（独立 profile + overlay，
阈值压到 0.002 触发），跑迷你任务并核对 `compaction/*` 与 checkpoint —— 真 Session、真 compactRegion、
真 surface 替换。实测 **3~5 次 fold 全成功、0 失败**（`evidence/真实进程首次fold.md`）。

**抓到的真 bug**：第一次跑时 7 次 fold 全报
`session event "compaction/summary" carries non-JSON-serializable data` ——
官方 `commitCompactionBody()` 把 `summarize()` 返回的 `provider`/`model` **不判空**写进事件，
而规则摘要（`summaryMode: rules` 与「摘要模型全挂」的兜底）没带这两个字段 ⇒ `provider: undefined` ⇒
真实 Session 的 JSON 校验拒绝。**`summaryMode: rules` 在真实 DSH 里从未成功过**（假 Session 不校验，
桌面 preset 又用 hybrid，所以一直没暴露）。
修法：所有 summarize() 返回路径都带 provider/model 字符串（规则摘要用当前路由做记账口径，
没有路由用 `chess-context`/`rules` 哨兵）。+harness 断言。

### 测试

118 项单测 + 真实进程 fold 测试（3 次成功 / 0 失败）

## 1.6.2 — 2026-10-29

### 压缩永不因摘要模型挂掉而失败（hybrid ⇒ 规则摘要兜底）+ doctor 体检

**规则摘要兜底**：`summarize()` 现在三层降级：
① 配置的摘要模型 → ② 失败就退回「当前路由模型」重试一次（v1.5.1）→ ③ 还不行且 `summaryMode=hybrid`
就**退回规则摘要（零模型调用）**，fold 必须能落地。压缩失败 = 上下文只增不减，比摘要质量下降严重得多。
`summaryMode=llm` 不降级（用户明确要模型输出）。+2 harness 用例。

**doctor**：新工具 `node test/doctor.mjs` —— 一条命令体检：安装态 / 摘要模型是否在 provider 模型表里 /
最近压缩成败与错误 / 棋谱健康 / 树新鲜度。本轮实机 131 次压缩失败就是它抓出来的
（配置里 `magpie/ima/deepseek-v4.1-flash` 不在 provider 模型表）。

### 测试

118 项全绿

## 1.6.1 — 2026-10-29

### index.md 每次落盘都刷新（它是模型读的入口）

盲测里子代理当场发现  落后于 （350 边/17 失败 vs 447 边/23 失败）——
因为旧版只在「首次 flush / fold 后」写树。现在 **每次 flush 重写 index.md**（单文件；2000 边实测
renderIndexMd 3.27ms + 写盘 0.65ms，debounce 后每 1.2s 最多一次）， 仍只在首次/fold 后写
（2000 个文件不能每步来一遍）。+1 harness 用例。

### 测试

116 项全绿

## 1.6.0 — 2026-10-29

### goal ③④⑤ 三件收尾

**③ `[dead]` 不再是一块永久墓碑**：标记直接从 tewari 参照点取锚点 ——
`dead retry-if:e384+1`（那条成功边不通了就回头重试）；图例同步；
`blocked:missing-resource` 的图例改成「等它出现，**或者把它创建出来**」。

**⑤ 热清单指向**真的**三层树**：旧省略行写的是 `graph.md`，而它从 v1.2.2 起就不再自动写了（死指针）。
现在引擎把会话树目录传进渲染器，输出 `TRACE: <sessions>/<sid>/index.md (per-node detail: nodes/<id>.md)`。
**盲测 2/2**：两个隔离子代理（只给清单、不提读文件）都自己读了 index.md / graph.json / nodes/*.md，
并把清单里被省略的 13 条失败做法逐条重建；其中一个还发现 index.md 已过期、改用 graph.json 作权威。

**④ 历史误报回洗**：新工具 `test/rewash-graph.mjs`（dry-run 默认、写前备份、会话在写则拒绝、证据对齐校验）。
对 `session-5acafe42` 执行 `--apply`：failure 边 101 → **71**，`text` 型误报 43 → **8**（剩下 8 条证据对不上，保守不动），
其中 4 条改判 `hard-error`（原文确有错误）、30 条降级 `unverified`；35 条留 `rewashed` 审计字段；树已重建。

证据：`evidence/收尾三件-dead锚点-树读取-回洗.md`

### 测试

115 项全绿（+4 errorSnippet 回归、+2 标记契约）

## 1.5.1 — 2026-10-29

### 真实计费核对 + 摘要模型失效兜底（实机数据驱动）

**1. 真实计费核对（`evidence/真实计费核对.md`）** —— 用会话日志里每次请求的真实 usage 拆账：

| 会话 | 请求 | prompt tokens | 缓存命中率 | 清单占 prompt | 其中陈旧副本 |
|---|---:|---:|---:|---:|---:|
| session-5acafe42 | 653 | 258,330,390 | 94.5% | **21.3%** | **54.4M token** |
| session-5787ac6b | 429 | 194,031,958 | 94.7% | 2.7% | 5.1M |
| session-e16faf2b（当前） | 348 | 93,691,039 | 97.0% | **0.2%** | 0.13M |

三条结论：① 真实 prompt 缓存吃掉 94~97% ⇒「省 token」≠「省钱」；② 旧版热清单是那个会话里**最大的浪费源**
（21.3%，其中 98.9% 是陈旧副本，v1.5.0 已消除）；③ fold 真实成功率 3/226、1/51 ⇒ 模拟的
「省 22.7%–43.3%」在实机上从未发生。

**2. 摘要模型失效兜底（实机 8 次失败暴露）**：当前会话超过阈值后连续 8 次压缩全部报
`pi-ai provider "magpie" has no configured model "ima/deepseek-v4.1-flash"` ——
插件 patch 与 preset 把摘要模型写成 magpie/ima，而 magpie provider 的模型表里没有它。

- 引擎：`summarize()` 在显式配置的摘要模型失败时**退回当前路由模型重试一次**（只一次；
  与路由相同则照旧抛错）。现有 harness 用例 2 条。
- 配置：插件自带 `cordis.patch.yml` 与**已安装** preset 的摘要模型改为留空（跟随路由）；
  安装态备份 `cordis.patch.yml.bak-before-summarizer-fix-1793213214`。
- 新工具：`test/measure-billing.mjs`（真实 usage 审计；解压多帧 zstd 依赖本机 python + zstandard）。

### 测试

109 项全绿（+2 摘要回落用例）

## 1.5.0 — 2026-10-29

### P1-4 彻底修法：热清单**就地替换**，surface 永远只有一条

**问题（拿真实会话日志数出来的）**：旧版每次注入都**追加**一条新 `user/message`，旧的不替换。
`session-5acafe42`（死循环那个会话）累积 **176 条 / 809,819 字符 ≈ 27 万 token** ——
它的上下文峰值 672,392 token 里，约 27 万是**这个插件自己注入的热清单**。
一个压缩插件自己的热上下文成了最大的上下文消费者。

| 会话 | 注入条数 | 累计字符 | ≈ tokens |
|---|---:|---:|---:|
| `session-5acafe42` | 176 | 809,819 | ≈ 270,000 |
| `session-365cdcf6` | 103 | 238,083 | ≈ 79,000 |
| `session-5787ac6b` | 74 | 155,569 | ≈ 52,000 |
| 12 个会话合计 | 375 | 1,225,074 | ≈ 408,000 |

**改法**：`pre-step` 里找到当前 surface 上最后一条 `chess-context` 节点，用 DSH 官方的
`surfaceOp: {op:"replace", startSeq, endSeq}` + `sourceEventSeqs` **就地替换**（官方 system-prompt
的 in-history 提交、`tool-result-pruner` 用的同一机制），并且**不进** `decision.messages`。
首次注入（或清单被 fold 遮蔽）时仍走追加路径。

- 内容一字不差时直接返回：不写日志、不推进 `contentGeneration`
- 锚点失效（刚被 fold 遮蔽）会抛错 ⇒ **捕获后退回追加**，绝不因此丢信息
- 被 fold 遮蔽后**立刻补回**，不等限流（否则模型一段时间内看不到死路清单）
- 限流维持原样（≥40 事件 / 失败边 +5）—— 替换不占额外 prompt，但会写日志事件并推进
  `contentGeneration`（下游 `startsSeries`），节奏不动最稳
- 新增配置 `hotLedgerReplace`（默认 `true`，false 退回追加）
- **历史包袱一次清**：v1.5.0 之前追加出来的旧清单不能被删除（surface 只有 append/replace），
  但可以逐条**替换成一行占位**（`[stale chess-ledger elided …]`）。实测 `session-5acafe42` 的 surface 上
  还压着 **44 条 / 295,255 字符 ≈ 9.8 万 token** —— 那个会话下次被打开时会被自动清掉。
  幂等：占位本身 < 200 字符，下次进来直接跳过。

**验证**

- `test/real-ledger-replace.mjs`（新，8/8）：真实 `@deepseek-ai/dsh-session` 上验证替换机制 ——
  含「连续替换 50 次仍只有一条」「替换非当前节点抛错」「漏报 sourceEventSeqs 抛错」「替换后仍能按
  `source.kind` 找回当前清单」
- `test/engine-harness.test.mjs`（+3）：就地替换（`decision.messages` 无新增、surface 恒 1 条、内容更新）、
  被 fold 遮蔽后立刻补回、历史旧清单被换成占位且幂等；变异自检（关掉替换 / 关掉清理 ⇒ 用例变红）
- `node test/run.mjs` → **107 passed, 0 failed**；verify-install 13/13；real-modules 4/4；real-fold 5/5

产物：`evidence/P1-4-清单替换实测.md`

**遗留**：历史累积要等下一次 fold 才会被遮蔽（surface 只有 append/replace，无法删除节点）；
本机运行实例需**再重启一次**才带上本改动。

## 1.4.0 — 2026-10-29

### 模型消费者视角：标记必须自解释、原因不许丢（子代理盲测驱动）

**三处实测缺陷**（都不是结构问题，是「写进去的内容不够模型用」）：

1. **标记裸奔**：图例被绑在「检测到手割」上 ⇒ 一个只有 EACCES 失败、没有成功路径的会话里
   `[blocked]` 出现了却没有任何解释；而 `redundant` / `longer` 真的会出现在清单里，
   图例里**从来没有**它们。
2. **标记是缩写，不是语义**：`[blocked]` 说不出「什么被挡住了、什么条件变了能再试」——
   而那正是 1.1.0 设计三态时给出的理由（`revisit_if`）。现在写成 `[blocked:permission]`。
3. **原因失踪**：旧版 level ≥3 直接把 `→ 报错原文` 整段砍掉 ⇒ 全库 133 条可见失败边里只有
   **25 条**带原因。而盲测里 **12/12 次回答**都引用了报错原文 —— 它是模型判断「是不是同一个坑」的判据。

**改动**

- `src/ledger.mjs`：`failureTags()` + `MARKER_LEGEND` + `legendKey()`；图例**按用到的标记动态生成**
  （出现即解释）；`renderFailureLine()` 任何档位都保留原因（`[90,60,36,25]` 逐档变短）；
  手割分析改为**只算一次**（尾部 30 条，旧版放在档位循环里重复 6 次，且显示条数 >30 时一条都不算）；
  新增档位预判：**注定装不下的级别直接跳过**（2000 边渲染 7.58 ms → **0.478 ms**）
- `src/engine.mjs`：新增配置 `hotLedgerMarkers: semantic | terse | off`（默认 `semantic`）
- `test/markers.test.mjs`（新，9 项）：标记裸奔、图例动态生成、`redundant`/`longer` 图例、
  多参照点、>30 条失败边仍有手割、原因在任何档位都在、三档位行为
- `test/ab-render.mjs`（新）：A/B 夹具 —— 同一张棋谱三种档位各渲染一份，两个场景（基本 / 误导）
- `test/engine-harness.test.mjs`：新增「标记档位一路传到热清单」用例（非法档位回落 `semantic`）
- `docs/最终报告.md` / `docs/性能与成本.md` / `README.md` / `docs/计划表.md`：数字与示例同步

**盲测结果（`evidence/热清单标记AB实验.md`）**

| 实验 | 结果 |
|---|---|
| ① 报错原文已说清该怎么做（3 臂 × 3 样本） | **8/8 满分，三臂无差别**（与 1.1.0 三态 A/B 的「差异为零」一致） |
| ② 报错原文**误导**（2 臂 × 6 样本） | 带标记 **0/6** 重试等价死路；不带标记 **1/6** 重试（理由：「SIGKILL 是外部中止，不是否定性证据」） |
| 引用率 | 带标记 6/6 次回答引用了 `dead`/`redundant`；不带标记只能引报错原文 |

方向性证据（n=6，不显著）：标记只在**报错原文误导**时有价值；默认保留 `semantic`，预算敏感可关。

**全库代价（45 个真实会话同语料新旧对比）**：tokens 19,267 → 20,579（**+6.8%**），
带原因的失败边 89 → **209（2.35×）**，平均档位 L1.40 → L1.42。

### 测试

104 项全绿（原 94 + 新增 10）；`bench-2000.json`：323 tokens / 0.478 ms

## 1.3.5 — 2026-10-28

### P0 修复：`worldHash` 类型契约（事故：压缩 226 次只成功 3 次 → 上下文涨到 66 万 → 模型死循环）

**根因**：`worldstate.hash()` 返回 `{ hash, mode, files }` 对象，engine 的 `worldHashOf()`
把它原样交给 keeper，节点字段于是存了**对象**；随后 `renderFacts()` 里
`latest?.worldHash?.slice(0, 12)` 对对象调 `.slice()` 抛
`latest?.worldHash?.slice is not a function` —— 这一步在 `summarize()` 之前，
于是 `compactRegion` 事务整体回滚，**压缩彻底不工作**。

**改动**

- `src/engine.mjs`：`worldHashOf()` 收敛成字符串（兼容 `string` / `{hash}` / `pending`）；
  `constraintHashOf()` 改为 `hashSet(collectConstraintText(g))`（`st.constraints` 从未被赋值
  ⇒ `constraintHash` 恒为 `pending` ⇒ `stateIndex` 永不建立、置换检测形同虚设）
- `src/graph.mjs`：新增 `hashText()`；`addAgentNode()` 入口归一化（对象永不进图）；
  `fromJSON()` 在加载边界修复历史脏数据（对象 → 字符串、按时序回填 pending `constraintHash`）
  并**无条件重建 `stateIndex`**（派生数据不信任磁盘旧值）
- `src/ledger.mjs`：新增 `shortHash()` 防御层，`CURRENT_STATE_KEY` 不再裸调 `.slice()`

**验证**

- `node test/run.mjs` → **94 passed, 0 failed**（87 + 新增 7）
- 全库回放（新增工具 `node test/verify-graphs.mjs`）：23 个会话 / 1578 个 agent 节点 /
  对象 worldHash **1279 → 0** / `stateIndex` **5 → 185** / 全部会话 `renderFacts`+`renderLedger` 不抛错
- 真实日志独立核对：`session-5acafe42` 的 `compaction/end` **226** 次、`error` **223** 次、
  其中本错误 **139** 次
- 变异自检：把修复回滚 → 新增的端到端回归变红（两层都回滚时错误与实机同形）
- 干净 HEAD 克隆 + `git apply` 补丁 → 94 passed（不是改着源码跑的自证）

**产物**：`docs/P0-worldhash-死循环-根因与修复方案.md`、`docs/P0-worldhash-死循环修复.patch`、
`evidence/P0-worldhash-修复验证.md`、`test/worldhash.test.mjs`、`test/verify-graphs.mjs`

**部署**：插件在 DSH 启动时加载，**需重启生效**；历史数据由 `fromJSON` 加载边界自动修复，
无需手工迁移。

## 1.3.4 — 2026-10-28

### 文档数字同步到 v1.3.1

- `docs/性能与成本.md`：476 → **310 tokens**（注明 v1.2.x 时 476）
- `docs/最终报告.md`：结论段与性能表同步
- `docs/计划表.md` M11：310 tokens / 81K 事实块 / 1.3ms md

### 测试

87 项全绿

## 1.3.3 — 2026-10-28

### 文档：新增 `docs/三层树设计.md`

- 为什么是「缩进树 + 扁平节点」的混合（DAG 最大入度 119，不能目录嵌套）
- 每层的作用与消费者
- **6 个实测缺陷**的完整记录（子代理驱动，v1.2.6 → v1.3.0）
- **3 条核心教训**（结构 ≠ 内容 / 不改运行中的数据 / SGF 树 vs DAG）
- 性能数据（253 节点 ~150ms）

### 测试

87 项全绿

## 1.3.2 — 2026-10-28

### 文档：最终报告加 v1.x 章节

- 6 个版本的变更表（1.2.6 → 1.3.1）
- 3 条核心教训：结构 ≠ 内容 / 不改运行中的数据 / SGF 树 vs DAG
- 实测数据对比：热上下文 476→310、节点 200→242、评语 7→162、死链 230→0

### 测试

87 项全绿

## 1.3.1 — 2026-10-28

### 热清单省预算：短标签 + L4 条数 50 → 20

**问题**：v1.3.0 加了 `[text:?]` / `[verify:kind]` / 三态完整标签（`[dead:a-working-path-avoids-it revisit_if=...]`），
2000 边场景热清单从 L4 降到 **L5**（只显示 10 条）。

**改法**：

1. 热清单用**短标签**（`[dead]` / `[blocked]` / `[failed]`），详细版留 `index.md`
2. `tailFailures` 从 50 → **20**

**实测**：2000 边 → 热上下文 **310 tokens / L4**（之前 276 / L5、476 / L4）

### 测试

87 项全绿

## 1.3.0 — 2026-10-28

### text 型 failure 标记 `[text:?]`（渲染层，不改数据）

**问题**：真实会话的 101 条 failure 里 43 条是 `verify.kind === "text"` —— 其中大量是假阳性（`get_goal`/`update_goal` 的合法 JSON、skill 列表、markdown 被当成失败）。

**为什么不在数据层回洗**：真实会话在跑，`#flush` 会覆盖 `graph.json`（实测：回洗 5 条后立刻被覆盖）。

**改法**：渲染层标记 —— `renderNodeMd` 和 `index.md` 的 text 型 failure 加 `[text:?]`，提示模型「这个判定不可靠，看原因自己判断」。

### 实测

- **47 条** text 型 failure 现在带 `[text:?]`
- 数据层不动（避免与运行中的会话冲突）

### 测试

87 项全绿

## 1.2.9 — 2026-10-28

### 修三层树的死链与计数（第二个子代理实测）

| 问题 | 修法 |
|---|---|
| **`raw/` 死链**：v1.2.4 砍掉 raw 但节点里还写 `../raw/<seq>.md`（230 个节点全是死链） | 改成「（raw/ 已砍掉：节点数据在 graph.json）」 |
| **计数不一致**：index 用 `g.order.length`，graph.json 是 `g.nodes` 数量（227 vs 229） | 改用 `Object.keys(g.nodes).length` |
| **评语不是 LLM 原话**：165 份「评语（来自入边）」只是把 action 抄一遍 | 标注「（非 LLM 原话）」 |

### 实测

- 死链：**0 个**（之前 230 个全是）
- index 计数：**235**（= `g.nodes`，与 graph.json 一致）
- 评语标注：**170 个**节点带「非 LLM 原话」

### 测试

87 项全绿

## 1.2.8 — 2026-10-28

### 缺陷 6：读时重建不一致

**问题**：`graph.json` / `index.md` / `nodes/` 三个来源在写入过程中不一致（边读边写）。

**修法**：

1. **写入顺序**：先写 `nodes/` + `index.md`，**最后**写 `graph.json`（原子 rename = 提交点）
2. **版本标记**：`index.md` 头部写 `> updated: <ISO>`（与 `graph.json` 的 `updatedAt` 同源），读者可对比

**注意**：Windows 不支持目录原子 rename，所以不是完全原子 —— 但 `graph.json` 的 rename 是提交点，读者以它为准。

### 测试

87 项全绿

## 1.2.7 — 2026-10-28

### 三层树补缺陷 2 & 5（子代理实测驱动）

| # | 缺陷 | 修法 |
|---|---|---|
| 2 | **意图缺失**：200 节点只有 7 个有 `goal`，边无 `intent` | `renderNodeMd` 的「评语」段加兜底：`goal` 为空时用**入边的 `intent`**，再为空用**入边的 `action`** |
| 5 | **标签不可信**：43/98 是 verifier 误报（`text` 型） | `renderNodeMd` / `index.md` 的失败边都带 `[verify:kind]`（`exit` / `host-error` / `text` / `none`），模型能区分「真失败」和「文本误报」 |

### 实测

- 评语兜底：**162 个节点**现在有评语（之前只有 7 个）
- verify 标签：**101 条**失败边带 `[verify:kind]`

### 测试

87 项全绿

## 1.2.6 — 2026-10-28

### 三层树补三处缺陷（子代理实测驱动）

一个隔离子代理只靠三层树回答「这个会话试过哪些失败路径」，报了 6 个缺陷，其中 **3 个是实现问题**：

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | **原因**缺失：98 条 failure 只有 13 条带附注 | `renderNodeMd` 出边的 `errorSnippet` 截断 100 → **400** |
| 3 | **节点缺失**：`#flush` / `build-tree` 只写 `g.order`，被合并且仍被边引用的节点没文件 | 改成写**所有** `g.nodes` |
| 4 | **index 只列 190/404 条边**：缩进树每节点只出现一次，跨边/置换边不在 | 加「**失败边全表**」段（含跨边） |

### 实测

- `index.md` 21KB → **54.6KB**，含全部失败边（id / from → to / 意图 / 错误原文 160 字符）
- `nodes/` **224 个**（含被合并且仍被边引用的）
- `build-tree.mjs` 不再写 `raw/`（v1.2.4 砍掉后残留的代码）

### 未修（记录在 HANDOFF）

- 标签不可信（43/98 是 verifier 误报）—— 旧数据，新代码已修（v0.1.2）
- 读时重建不一致 —— 边读边写，任何计数要带时间戳

### 测试

87 项全绿

## 1.2.5 — 2026-10-28

### `index.md` 改缩进树（每节点只出现一次）

`index.md` 从平铺改成按深度的缩进树：

- 缩进 = 从**入度为 0 的节点**出发的最短路径深度（封顶 12 级）
- 每个节点只出现一次
- 出边挂在节点下一行

**实测输出**：

```markdown
- [n1](./nodes/n1.md) USER seq=968 我重启了...
- [n2](./nodes/n2.md) USER seq=969 <hindsight_knowledge>...
  - e1 ✗ get_goal
- [n12](./nodes/n12.md) USER seq=1042 持续优化...
  - [n59](./nodes/n59.md) STATE seq=1363 (无目标)
    - e66 ✗ edit(file_path=...
```

### 为什么不做目录嵌套（用户提议过）

真实数据：203 节点 / 396 边，**多父节点 7 个，最大入度 119**（n174 有 119 个父），transposition 边占 61%。

嵌套会让 n174 在 119 个目录里重复 → 文件爆炸 + 不同步。**棋谱是 DAG，不是树** —— 缩进树只表达深度，不复制节点。

### 测试

87 项全绿

## 1.2.4 — 2026-10-28

### 砍掉 `raw/`（节点 JSON 与 `graph.json` 重复）

三层文件树的 `raw/` 存的是**节点 JSON**，和 `graph.json` 完全重复（200 文件 / 430KB）。
真正的「原始记录」应该是**事件原文**，不是节点 JSON —— 这个以后从 session 日志接。

**改动**：

- `#flush` / `build-tree.mjs` 不再写 `raw/`
- 三层变两层：`index.md` + `nodes/*.md`（+ `graph.json` 数据源）

**省**：430KB / 200 文件。

### 测试

87 项全绿

## 1.2.3 — 2026-10-28

### 展示名改为 `DSH-GOkifu-compact`（大写 GO）

`GO` 才是围棋（`go` 是编程语言）。但 **npm 包名只能小写**（`dsh-gokifu-compact`），这是 npm 的硬限制。

- README / AGENTS / QUICKSTART / docs 标题：`DSH-GOkifu-compact`
- GitHub 仓库：`MYCF711/DSH-GOkifu-compact`
- npm 包名 / 配置项 / 路径：保持 `dsh-gokifu-compact`（小写）

### 测试

87 项全绿

## 1.2.2 — 2026-10-28

### 性能：`graph.md` 不再自动写

`graph.md` 是整篇人读视图（157KB），每次 flush 写是纯 IO 浪费；三层文件树（index/nodes/raw）已经是人读视图。

**改法**：

- `#flush` 不再写 `graph.md`
- 需要时：`node test/build-md.mjs <sessionDir>` 按需生成

**保留**：`graph.json`（数据源，插件自己恢复用，必须写）。

### 测试

87 项全绿

## 1.2.1 — 2026-10-28

### 文档：README 加三层文件树说明

把 `index.md` / `nodes/*.md` / `raw/*.md` 三层的作用与消费者写清楚了。

### 工具：`test/build-tree.mjs`

给 v1.2.0 之前已有的会话补三层文件树（从 `graph.json` 生成）。
实测：`session-5acafe42` 补了 **183 个节点**。

### 测试

87 项全绿

## 1.2.0 — 2026-10-28

### 三层文件树（index / nodes / raw）

**问题**：`graph.md` 是整篇 177KB，人无法浏览，模型无法按需加载。

**改法**：每次 flush 额外写三层：

```
sessions/<id>/
├── index.md          落子顺序（每个节点一行 + 出边状态）
├── nodes/n1.md       单节点：评语 / 状态 / 入边 / 出边 / raw 链接
├── raw/1.md          原始记录（节点 JSON 全文）
└── graph.json / graph.md  （保留兼容）
```

**index.md**：

```markdown
- [n1](./nodes/n1.md) USER seq=1 目标：把构建跑通
  - e1 ✓ 跑 npm install
- [n2](./nodes/n2.md) STATE seq=2 装依赖
```

**nodes/n2.md**：

```markdown
# n2 · AGENT  seq=2
## 评语（LLM 当时的目标）
装依赖
## 状态
- worldHash: `W1`
- constraintHash: `C1`
## 入边
- e1 ← n1: 跑 npm install [success]
## 出边
（无）
## 原始记录
../raw/2.md
```

**设计依据**：`evidence/棋谱有效性实验.md` —— 干净子代理实验证明三层缺一不可：
索引让模型看到全部死路，节点给详情，原始补抽取的漏。

### 测试

**87 项**（+2：index.md / 单节点 md）

## 1.1.0 — 2026-10-28

### 失败三态（子代理 A/B 实验驱动）

**实验结论**：两个隔离子代理独立做 A/B（带标记 vs 不带），**行为差异为零**。
`[dead]` 作为「别重试」的指令没用 —— 失败记录 + `WORKING` 行已经足够推出；
而且**有损**：把「相对于当前成功路径」写成永久墓碑，会关掉「权限变了本来能走」的路。

**改法**：`failureClass(edge, tewari)` 返回三态：

| 状态 | 条件 | 带什么 |
|---|---|---|
| `blocked` | 资源类错误（EACCES / ENOENT / timeout / ECONNREFUSED） | `revisit_if=...`（什么条件变了可以再试） |
| `dead` | 有成功路径且**失败边有终点**证明不经过它 | `revisit_if=working path fails` + `redundant:<edge>` |
| `failed` | 其余（可重试性未知） | 无 |

**关键顺序**：先判 `blocked` 再判 `dead` —— 权限不足是环境性阻塞，不是本质无解。

**关键边界**：`to` 为 null（没走到任何节点）**不算 dead 证据** —— 只说明试过没成，不能证明有替代。

**实测输出**：

```
LEARNED (3 failed attempts):
# dead=a working path avoids it (revisit_if it fails) | blocked=needs a resource (revisit_if it changes) | failed=retryability unknown | novel=explored states no working path covered
- e2 "绕路到B" → boom [dead:a-working-path-avoids-it revisit_if=working path fails redundant:e1]
- e3 "写 prod" → EACCES [blocked:permission revisit_if=permission changes]
- e4 "试命令" → boom [failed:retryability unknown]
```

### 测试

85 项全绿

## 1.0.0 — 2026-10-28

### 手割多参照点（Multi-baseline tewari）

**问题**：之前取成功路径的并集，同一条失败边只能给一个结论。
但「看第二个你判断优，看第三个是劣」—— 同一条失败边相对不同成功路径可能有不同结论。

**改法**：`tewariAnalysis` 对**每条**成功出边单独判定，返回：

```js
{
  baselines: [
    { edgeId: "e1", sameEndpoint: true,  reachesEndpoint: true  },
    { edgeId: "e2", sameEndpoint: false, reachesEndpoint: false },
  ],
  redundantVs: ["e1"],   // 相对哪些成功路径是冗余（同终点）
  longerVs: [],          // 相对哪些绕路
  probes: [...],         // 探出的新节点
}
```

热清单显示：

```
- e3 "绕到B" → boom [redundant vs e1]
```

**1.0.0 含义**：API 稳定、语义完整（同型 / 探新 / 冗余 / 绕路，每条边明确指向「相对哪条成功路径」）。

### 测试

85 项全绿

## 0.9.1 — 2026-10-28

### 热清单去重：`CURRENT PATH` 与 `WORKING` 相同时只显示一个

之前两个都显示（一个含失败边，一个只有成功边），模型会困惑。
现在：如果当前路径 == 成功路径，只显示 `WORKING`；不同才额外显示 `CURRENT PATH`。

### 文档：README 加围棋术语对照表

把「本手 / 恶手 / 俗手 / 新手 / 缓手 / 手割」等术语的日文/英文版列出来，
说明它们和插件标签的对应关系（标签本身仍用英文短词，模型友好）。

### 测试

85 项全绿

## 0.9.0 — 2026-10-28

### 热清单标题改 `LEARNED` + 每条失败边都有归属标签

**问题**：`PROVEN DEAD ENDS` 是给人类看的标题，而且里面混着三种完全不同的边：
- 真正的死路（没有成功路径经过）
- 等价成功路径（`redundant`）
- 探出新状态（`novel`）

**改法**：

```
LEARNED (2 failed attempts):
# dead=no working path goes through it (don't retry) | redundant=a working path reaches the same endpoint | novel=explored states no working path covered (may revisit) | longer=detours vs a working path
- e1 "删掉整个 node_modules" → 权限不足 [dead]
- e2 "绕远路到同一终点" → boom [redundant]
```

每条失败边现在**必有标签**：

| 标签 | 含义 | 该怎么做 |
|---|---|---|
| `[dead]` | 没有成功路径经过 | 别重试 |
| `[redundant]` | 有成功路径到同一终点 | 走那条 |
| `[novel]` | 探出了成功路径没走过的状态 | 可复查 |
| `[longer]` | 比成功路径绕远 | 走短的 |

### 测试

85 项全绿

## 0.8.0 — 2026-10-28

### `WORKING` 显示完整成功路径

之前只显示最近一条边（`user → n2`），模型不知道整条路怎么走通的。
现在从最新成功节点回溯到根，拼出完整路径：

```
WORKING: user → n2 → n3 (exit 0)
```

这是「棋谱」该有的样子：**整盘棋的行棋顺序**，不是最后一手。

### 测试

85 项全绿

## 0.7.0 — 2026-10-28

### 模型消费者视角优化（给模型用，不是给人看）

**1. 手割标记改成模型能直接理解的英文短词 + 图例**

| 旧 | 新 | 图例含义 |
|---|---|---|
| `[同型]` | `[redundant]` | same endpoint as a working path |
| `[探新]` | `[novel]` | explored states no working path covered |
| `[劣]` | `[longer]` | detours |

图例只在确实有标记时出现（省 token）：
```
# tags: redundant=same endpoint as a working path | novel=explored states no working path covered | longer=detours
```

**2. 新增 `WORKING` 行 —— 模型不能只看到死路，还要知道哪条路是通的**

```
WORKING: user → n2 (exit 0)
```

**3. 消除 `PROVEN DEAD ENDS` 与「同型」的矛盾**：`redundant` 明确说它等价于成功路径，不是真正的死路。

### 实测热清单

```
<chess-ledger>
ROOT USER (verbatim): 目标：把构建跑通
CURRENT PATH: n1(user) → n2
CURRENT GOAL: 装好了
WORKING: user → n2 (exit 0)
PROVEN DEAD ENDS (1 total; do not retry blind):
# tags: redundant=same endpoint as a working path | novel=explored states no working path covered | longer=detours
- e1 "绕路A" → boom [redundant]
</chess-ledger>
```

### 测试

85 项全绿

### 待办（下一版）

- 手割多参照点：同一失败边相对多条成功路径的分别结论
- 真实模型 A/B：带手割标记 vs 不带，验证模型是否真的少走死路

## 0.6.0 — 2026-10-28

### 重构：手割从四档改成「两判定 + 多标签」

**问题**：四档（profit / detour / pure_loss / no_alternative）是单选，容易模棱两可：
- 同一条失败边可能同时「有价值」和「不如原型」；
- 同一个失败边可能通向多个收敛点，从不同参照看结论不同。

**改法**：判定只有**两种**，其余是**可同时成立**的标签：

| 判定 | 含义 |
|---|---|
| `same_position` | **同型** —— 失败边和某条成功路径到达同一终点（殊途同归，完全等价） |
| `different` | **不同型** —— 其余情况 |

不同型时额外记录两个**独立**维度：

| 字段 | 含义 | 热清单标记 |
|---|---|---|
| `probes` | 探出的、标准定式没走过的节点（最多 8 个） | `[探新]` |
| `vsBaseline` | 相对标准定式：`same` / `longer`（绕路）/ `unknown` | `[劣]` |

**多标签可以同时出现**：`[探新 劣]` = 这条路探出了新东西，但比标准定式绕了路。

### 实测

```
# 同型：失败边和成功路径到同一节点
- e1 "绕路A" → boom [同型]

# 探新：失败边走了标准定式没走过的节点
- e2 "探索路" → boom [探新]
```

### 已知局限（记在 HANDOFF）

- 多条成功路径目前取并集，**没有分别列出**「相对每条路径的结论」——不同参照点可能给出不同结论。
- `probes` 与 `vsBaseline: longer` 逻辑上互斥（一个要求不在基线，一个要求在基线），
  所以 `[探新 劣]` 只在「终点在基线但沿途探新」时出现。

### 测试

85 项（4 个 tewari 测试改断言后全绿）

## 0.5.1 — 2026-10-28

### 修复：手割漏了「赚」这一档

0.5.0 只做了「亏」，但手割的核心是「谁亏谁赚」。补上 `profit` 并重排判定顺序：

| 判定 | 条件 | 标记 |
|---|---|---|
| `profit` | 同起点**没有**别的成功路径，但失败之后走出了成功 → 必要试错 | **`[赚]`** |
| `detour` | 标准定式（同起点成功路径）能到达失败终点，但绕了路 | `[绕路]` |
| `pure_loss` | 标准定式不经过它 → 这一步多余 | `[纯亏]` |
| `no_alternative` | 同起点没有成功路径，失败之后也没有成功 | 无 |

**判定顺序很关键**：先算「有没有标准定式」（同起点成功路径），再算「失败之后有没有成功」，
最后才落到 pure_loss —— 否则会把「必要试错」误判成「纯亏」。

### 实测两种输出

```
# 赚：没有别的成功路径，试错后走出来了
- e1 "先试 npm install" → ETIMEDOUT [赚]

# 纯亏：有别的成功路径，这一步多余
- e1 "直接改 prod" → EACCES [纯亏]
```

### 测试

**85 项**（+1：profit）

## 0.5.0 — 2026-10-28

### 新增：手割分析（tewari）

围棋的复盘方法：把多出的着法拿掉，还原标准定式，判断谁亏谁赚。
本插件用它判断**一条失败边是不是纯亏**：

| 判定 | 含义 | 热清单标记 |
|---|---|---|
| `pure_loss` | 同起点有成功路径，且完全不经过失败边的终点 | **`[纯亏]`** |
| `detour` | 成功路径能到达失败终点，但绕了路 | `[绕路]` |
| `no_alternative` | 同起点没有成功路径可比 | 无标记 |

**为什么重要**：原来的插件只记录「e1 失败了」，手割进一步回答「**为什么**这一步多余」——
把这一步拿掉，同起点有成功的替代路径。这正是围棋复盘里「手割」做的事。

**实测输出**：

```
PROVEN DEAD ENDS (1 total; do not retry blind):
- e1 "直接改 prod 配置" → EACCES: permission denied [纯亏]
```

**实现**：

- `graph.mjs` 新增 `tewariAnalysis(g, edge)`：对失败边做 BFS，找同起点的成功路径，判断终点是否可达
- `ledger.mjs` 的 `renderFailureLine` 支持 tewari 参数，热清单显示 `[纯亏]` / `[绕路]`
- 只对**当前显示**的失败边做，且 ≤30 条（每条一次 BFS，防 O(E²)）
- 失败边没有终点节点时，同起点有成功替代即判 `pure_loss`

### 测试

**84 项**（+3：pure_loss / detour / no_alternative）

## 0.4.0 — 2026-10-28

### 破坏性变更：包名 `dsh-kifu-context` → `dsh-gokifu-compact`

命名拆开看：**GO（围棋）+ kifu（棋谱）+ compact（压缩）**。

- **Go**：棋种
- **kifu**：棋谱（围棋/将棋的记谱方式：一局棋的完整记录 + 每手评语）
- **compact**：这个插件实际做的事（上下文压缩）

比 `kifu-context` 更明确：`context` 只说明「上下文」没说明「压缩」；`GOkifu` 把棋种和棋谱都标出来。

**展示名用大写 GO**（`GO` 才是围棋）；npm 包名只能小写（`dsh-gokifu-compact`，npm 硬限制）。

### 术语澄清：`transposition` 不是核心

- `transposition`（转置检测）是**国际象棋引擎**的概念（同一局面经不同路径到达时不重复搜索）。
- 围棋有等价情形（棋界叫「同形」/「同型」），但没有这个术语。
- 本插件里它只是**优化**：命中历史节点时不新建分支，加一条回边。
- **核心是「失败记忆 + 增量 fold」**：
  - 失败记忆负责**明确否定走错的着法**（`failureEdges` + 热清单 + 节点 `errorSnippet`）
  - 增量 fold 负责**每段历史只摘要一次**（不重压、不 ρ^k 衰减）

README 已按这个口径改写：卖点从「转置检测」改为「失败记忆 + 评语可复盘」。

### 升级步骤

```bash
node test/rollback.mjs     # 卸旧名
node test/install.mjs      # 装新名
# 重启 DSH
```

## 0.3.0 — 2026-10-28

### 破坏性变更：包名 `dsh-chess-context` → `dsh-gokifu-compact`

`chess` 在英文里是国际象棋，而这个插件的隐喻是**围棋棋谱（kifu）**。改名原因见下。

**升级步骤**（已装过的）：

```bash
node test/rollback.mjs          # 先卸旧名
node test/install.mjs           # 装新名
# 重启 DSH
```

preset 的 `cordis.patch.yml` 与 profile 的 `package.json` 里的引用已同步更新。

### 新隐喻（写进 README 与仓库描述）

> 把 agent 的每一步变成棋谱上的一手：落子、评语、复盘。
> 上下文压缩不再是丢掉历史，而是把历史下成一局随时能复盘的棋 ——
> 每一手都保留 LLM 自己写下的评语和完整想法，环环相扣。
> 高价值的棋局几年后仍能记起整盘怎么下；走到关键处，旧棋谱会吊起记忆，让人悬崖勒马。

- **节点 = 一手棋**（局面）
- **边 = 一手尝试**（落子 + 结果）
- **评语 = LLM 当时写下的目标 / 约束 / 失败原因**（可追溯到完整想法）
- **复盘 = 从根节点沿边走一遍，整盘怎么下的都在**

### 保留项

- `transposition`（转置检测）术语保留 —— 那是国际象棋引擎的概念
  （同一局面经不同路径到达时不重复搜索），本插件确实借用了。

## 0.2.1 — 2026-10-28

### 文档

- **修正隐喻**：`package.json` / GitHub 仓库描述里的 `chess-record DAG`（国际象棋）改为
  **go game record (kifu)**（围棋棋谱）。项目名保留 `chess`（已发布，改名成本高于收益），
  但隐喻取围棋：**节点 = 局面（交叉点），边 = 一手尝试（落子 + 结果），失败记忆 = AlphaGo 的胜负回溯**。
- 代码里的 `transposition`（转置检测）**保留不改** —— 那是国际象棋引擎的术语
  （同一局面经不同路径到达时不重复搜索），本插件确实借用了这个概念。
  所以准确表述是「围棋棋谱 + 国际象棋转置表」的混合，README 顶部已写明。

## 0.2.0 — 2026-10-28

> 从 0.1.0 到 0.2.0 累计修掉 **19 个 bug**（3 个 P0 级数据破坏），
> 单测从 64 项增到 81 项，全部通过。核心行为变化：约束不再经过模型。

### 新增

- **机械约束段**：`summarize()` 在模型输出后机械追加 `## 约束（机械保留，逐字；不由模型改写）`。
  多规模实测（5/15/30 条失败边）发现模型会把 3 条约束全丢（0/2~3/3 之间跳），
  改为规则拼回后约束保留率 **100%**，不依赖模型遵守。
- **L5 降级档**：`hotLedgerMaxTokens` 在小预算下多一档兜底（只留最近 10 条），极端输入不再超预算。
- **`compactRegion` 覆盖**：官方 `/compact` 路径也能拿到正确的 fold 范围（摘要里的 seq 不再是 `undefined-undefined`）。
- **`renderLedger` 置换提示**：当前路径上有 `transposition` 边时输出「回到已走过的状态」警告
  —— 之前 `renderTranspositionWarning` 全项目无调用点，这个提示永远不会出现。
- **`validate()` 落盘前校验**：图不变量（悬空边 / 缺状态哈希 / 失败边没原因）有问题时进日志。

### 修复（19 个）

**P0（会悄悄破坏图数据）**

- `this.flushTimers` 从未初始化 → 每次「有变化」的事件抛 TypeError，**1.2s debounce 落盘从未工作**。
- 节点创建写死 `worldHash: "pending"`，fold 前统一回填成**同一个哈希** → 整段路径被判定为同一状态、
  折叠成一个节点（实测 4 个 step 后节点 5→2、3 条边 `from` 悬空）。
- `mergeNodeInto` 只改 `edge.to` 不改 `edge.from` → 合并非叶子节点后它的所有出边指向已删除节点
  （真实会话 155 条边里 **115 条** `from` 悬空）。

**P1**

- 热清单每次 digest 变化就**追加**新 user 消息、旧的不替换（真实会话累积 131 条 / 508,308 字符）。
  **已缓解**：两次注入至少隔 40 事件 + 失败边增长不足 5 条不注入。
- `renderMd` 对每个节点做一次全边扫描 O(N×E) → 建 `from→edges[]` 索引后 **406ms → 1.3ms（258 倍）**。
- 热清单只看 root 节点的约束，后续 user 消息里的约束全部丢失 → 改用 `collectConstraints(g)` 全量去重。
- 测试计数正则对只读工具也生效（`read` 到 "all tests passed" 被判 success）→ 加 `if (!readOnly)`。
- `EXIT_RE` 取正文第一处匹配（`sed` 打印的测试文件里写着 `[exit code: 1]` 会把 exit 0 的命令判失败）
  → 只看末尾 200 字符。
- `renderFacts` 无范围限制，摘要体积随**全局**失败数增长 → 支持 `{ range }` 只取本段失败边。
- `backfillState` 在 `compactRegion` 之前执行，fold 失败不回滚 → fold 前 `toJSON` 快照，
  `range===null` / `result===null` / 抛错三条路径都恢复。
- `validate()` 运行期从不调用 → `#flush` 落盘前校验。
- 置换命中信息被 keeper 丢弃，`renderTranspositionWarning` 无调用点 → 在 `renderLedger` 里真正输出。
- 指令同时要求「每条失败边都必须出现」和「整份记录 <1200 字符」→ 超过约 15 条死路不可满足。
  改为「每条死路约 40 字符 + 600 字符余量」。

**P2**

- L4 降级不看 `maxTokens`（12 条 200 字约束 + 120 条失败边 → 1,095 tokens，预算 500 的 219%）→ 加 L5。
- `_chessActiveRange` 在 `/compact` 路径为 null → 覆盖 `compactRegion` 在事务入口设置、`finally` 恢复。
- `summaryMode: "llm"` 的文档说「完全交给模型」，实际仍带 facts → 文档改为「不降级到规则摘要，仍带硬事实」。

**运行期实测（真实会话暴露）**

- `user/message` 的 `source.kind` 只应把 `user` 当真用户
  （hindsight / agent-instructions / subagent 注入被当成 UserNode，污染约束集与根目标）。
  真实日志回放：user 节点 **22 → 4**。
- verifier 把只读工具（`get_goal`/`update_goal`/`hindsight_*`）的 JSON 文本误判为 failure。
  真实日志回放：failure **88 → 22**。
- `tool/result` 与 `pendingEdges` 的匹配缺失 → 回放 1807 事件，未匹配 **0 条**。
- `EXIT_RE` 渲染（同上）。

### 变更

- `src/engine.mjs` 去掉内嵌**裸 NUL 字节**（`parts.join("\0")` → `String.fromCharCode(0)`），
  `file`/`grep` 不再把整个文件判为 binary。
- `package.json` 的 `files` 排除测试产物（`src/.engine-under-test.mjs` / `src/.harness-stubs`）。

### 文档

- 新增 [`QUICKSTART.md`](./QUICKSTART.md)：重启后 3 步验证 + 日常使用 + 4 类故障处理 + 7 个配置项。
- 新增 [`docs/性能与成本.md`](./docs/性能与成本.md)：fold 耗时分解 / graph 体积 / ledger 渲染 / 真实 token 曲线。
- 新增 [`evidence/棋谱有效性实验.md`](./evidence/棋谱有效性实验.md)：干净子代理实验
  —— 棋谱组 **15/15** 避开已知坑；对照组从原始文档补出 **2 条棋谱漏掉的坑**，
  证明「原始记忆必须保留」。
- 全部文档数字按 `evidence/*.json` 校正（验收子代理查出 15 处不一致，已修 14 处，剩 1 处标注口径）。

### 测试

| 套件 | 结果 |
|---|---|
| `node test/run.mjs` | **81 passed, 0 failed**（0.1.0 时 64 项） |
| `node test/verify-install.mjs` | 13/13 |
| `node test/real-modules.mjs` | 4/4（真实 `@deepseek-ai/*` 包） |
| `node test/real-fold.mjs` | 5/5（真实 `compactRegion` 事务，含 hybrid） |
| `node test/real-e2e.mjs` | 3/3 失败边、3/3 复述 |
| 真实模型对照 | 本插件失败边 **8/8** vs 官方 8 段模板 **4.67/8** |

### 已知未完成（见 HANDOFF.md）

- P1-4 的彻底修法（替换 surface 上的旧热清单消息）—— 当前是限流缓解。
- 真实计费口径的节省（模拟显示 22.7%–43.3%，未核对真实账单）。
- 三层文件树（index / nodes / raw）的设计已验证，尚未进插件实现。
