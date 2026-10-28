# 更新记录

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

命名拆开看：**Go（围棋）+ kifu（棋谱）+ compact（压缩）**。

- **Go**：棋种
- **kifu**：棋谱（围棋/将棋的记谱方式：一局棋的完整记录 + 每手评语）
- **compact**：这个插件实际做的事（上下文压缩）

比 `kifu-context` 更明确：`context` 只说明「上下文」没说明「压缩」；`gokifu` 把棋种和棋谱都标出来。

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
