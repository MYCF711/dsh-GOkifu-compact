# dsh-GOkifu-compact · 交接文件

> 2026-11-01 · 给下一个会话
> **先读这一页，再读 `docs/最终报告.md`。不要重新推导。**
> 当前版本 **1.12.0**（**未发布**：无 tag、npm `latest` 仍是 1.11.17）；单测 **577 / 0 skipped / 0 failed**（**49 个测试文件**）。
> **⚠ 桌面 live 里本插件一个版本都没装**（11-01 14:15 重建的新 home）—— 不是「停在旧版本」，是「0 个版本」。
> 装回去要先改清单过版本闸、再走官方插件通道、再重建 preset 的引擎行 ⇒ 见下方「新版 DSH 适配」。

## ⚠ 最新状态（2026-11-01 · 1.12.0 · 未发布）

| 项 | 值 |
|---|---|
| 版本 | **1.12.0**（`package.json` = `README:3` = `CHANGELOG 有 ## 1.12.0`） |
| tag / npm | **都没有** —— 本版只存在于工作树；`npm latest` 仍是 **1.11.17**。发版命令是 `node scripts/release.mjs --yes`（annotated tag + npm publish + GitHub Release，见 `AGENTS.md:127` 与 `check-maintenance` 的 tag 断言） |
| 单测 | **577 passed / 0 skipped / 0 failed**（**49 个测试文件**）· `install-link` 29/0 · `ws-install` 19/0 · `ui` 54/0 · `engine-harness` 43/0 · `rooms` 15/0 · `p6c-preflight` 6/0 · `preset-discovery` 7/0 · `preset-wiring` 4/0 · `bundle` 6/0 |
| 安装校验（**真实新 home**） | `node test/verify-install.mjs` **18 项 = 13 ✗ / 5 !**；`node scripts/doctor.mjs` **错误 1 / 警告 11** —— 都是「插件还没装」的必然结果，**不是本版缺陷**（没为凑绿去动 live） |
| `check-maintenance` | **8 通过 / 0 警告 / 1 失败** —— 唯一失败是「当前版本 1.12.0 有 tag」，属**发版步骤未执行** |
| **桌面 live** | **0 个版本**：`profiles/desktop/package.json` 无本包依赖、`dsh.profile.bundles` 无本包、`<home>/chess-context` 不存在。上一版收益**一条都没生效** |
| 下一步（唯一档停的事） | **重装到新 home** —— 需**停机窗口 + 主人授权 + 主人重启**；三段顺序见下方「新版 DSH 适配」。**不要只手改 `package.json` 加 `link:`**（会被插件管理器抹掉） |

> 其余仍未做：**M2/M3**（UI 暂停中）· **tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）· **`README:3` / 本文件版本号都没有门禁**（`check-maintenance` 不读它们）。

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

**三段重装（停机窗口里按序做，任一步失败就停在原状）**

1. **过闸** —— 本版已改好清单，正常情况无需豁免；若要用旧包，走官方
   `dsh plugin --profile desktop allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。
2. **装 bundle** —— 走**官方插件通道**（Web 侧栏 Plugins 页 / `plugin_manager` 的 `install_bundle` / `dsh plugin add`）。
   **不要**用插件自带的 `node scripts/cli.mjs install`：它会去读已不存在的 `preset-bundles/`、往 profile patch 手写 UI 行
   （与 bundle 通道只能二选一，双挂载 = `duplicate prefix route` 启动失败）、且完全不知道版本闸。
3. **重建 preset 的引擎行** —— 引擎**不能**放在 profile/bundle 级 patch，必须替换 **preset 的 compaction group**
   里的 `- id: compaction-basic`。做法：新建自己的 preset bundle（**别整份覆盖官方 `standard`**，那等于冻结快照会丢新版新增行），
   在它的 `plugins[compaction].config` 里写 `- id: gokifu-compact` / `name: 'dsh-gokifu-compact/engine'`，
   **保留** `command-compact` 与 `tool-result-pruner` 两行。

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

> 其余仍未做：**M2/M3**（UI 暂停中）· **tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）。

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

> **2026-11-01 复核：这一节是 2026-10-29 的旧清单，只有历史价值。**
> 当前真正的「未完成」只有两件：**① 重装到新 home**（见顶部「最新状态」与「新版 DSH 适配」）；
> **② 重建 preset 的 compaction group 行**（引擎名 `dsh-gokifu-compact/engine`）。
> 下表第 1 项早已完成，第 4–6 项是旧 home 的数据问题，**新 home 上没有那些数据**（`<home>/chess-context` 不存在）。

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
