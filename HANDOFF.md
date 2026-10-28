# DSH-GOkifu-compact · 交接文件

> 2026-10-28 · 给下一个会话
> **先读这一页，再读 `docs/最终报告.md`。不要重新推导。**
> ⚠ **最紧急的一件事**：v1.3.5 修了 P0（worldHash 类型 bug 导致压缩 98.7% 失败 → 模型死循环），
> 代码已在工作区、单测全绿，但**插件在 DSH 启动时加载，必须重启才生效**。
> 重启后第一件事：`node test/verify-graphs.mjs`（见 `evidence/P0-worldhash-修复验证.md`）。

## 一句话

DSH 的上下文压缩后端插件。把「历史 → 一段摘要」换成
**「历史 → 棋谱 DAG（节点=状态，边=尝试+结果）+ 每步重建的极短热上下文」**。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | **1.6.2**（P0 1.3.5 → 标记 1.4.0 → 替换 1.5.0 → 计费/摘要 1.5.1 → 收尾 1.6.0 → index 刷新 1.6.1 → 规则兜底 1.6.2，均未发版） |
| 单测 | **118 passed, 0 failed** |
| 挂载校验 | 13/13 |
| GitHub | https://github.com/MYCF711/DSH-GOkifu-compact |
| 最新 Release | https://github.com/MYCF711/DSH-GOkifu-compact/releases/tag/v1.3.4（1.3.5 只在本地） |
| 本地路径 | `D:\主工作区\projects\dsh-chess-context`（物理目录名保留旧名 `chess`；junction 名 `dsh-gokifu-compact`） |
| 包名 | `dsh-gokifu-compact`（npm 只能小写）；展示名 `DSH-GOkifu-compact` |
| 运行期生效 | ✅ v1.4.0 已重启生效；✅ v1.5.0 也已重启生效（02:37 那次，日志里已见 `replace`） |

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
| `test/markers.test.mjs` | 标记契约（9 项） |
| `docs/三层树设计.md` | 三层树设计依据 + 6 缺陷 |
| `docs/P0-worldhash-死循环-根因与修复方案.md` | P0 根因 + 修复方案 + 验证清单 |
| `docs/最终报告.md` | 完整报告（含 v1.x 章节） |
| `evidence/` | 17 个证据文件（含 `P0-worldhash-修复验证.md`） |

## 未完成（按优先级）

| # | 项 | 说明 |
|---|---|---|
| 1 | **再重启一次 DSH** | v1.5.0（清单就地替换）需要重启才生效；重启后跑 `node test/verify-graphs.mjs`（全库健康）|
| 2 | **真实计费核对** | 现在有真实长会话了：`session-5acafe42` 的 176 条清单 × 平均 4600 字符是真金白银。核对网关账单口径的节省 |
| 3 | **`ENOENT` 边界** | `failureClass` 判 `blocked:missing-resource`，但文件可能本来就不该存在（应是 `dead`）—— 规则无法区分 |
| 4 | **旧数据回洗** | `session-5acafe42` 的 101 条 failure 里 43 条 text 型假阳性。**会话已停止**，可回洗（v1.3.0 起渲染层有 `[text:?]` 标记，数据层回洗仍待做） |
| 6 | **`[dead]` 为「墓碑」的风险** | 1.1.0 盲测指出：写成永久墓碑会关掉「权限变了本来能走」的路。现在靠 `dead` 图例里的「retry only if that path breaks」缓解，未做机器强制 |
| 5 | **模型是否主动 read 三层树** | 未验证（子代理是被要求读的） |

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
