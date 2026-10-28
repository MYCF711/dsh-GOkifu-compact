# 更新记录

## 0.3.0 — 2026-10-28

### 破坏性变更：包名 `dsh-chess-context` → `dsh-kifu-context`

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
