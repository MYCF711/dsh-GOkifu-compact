# dsh-gokifu-compact

> 已经装好了？直接看 [快速开始](QUICKSTART.md)。

> **为什么叫 gokifu-compact** —— **Go（围棋）+ kifu（棋谱）+ compact（压缩）**。一局棋下完，棋谱上不只有落子顺序，还有每一手的评语。这个插件做的事一样：把 agent 每一步变成一手棋（节点），把当时的思考变成评语（节点的目标 / 约束 / 失败原因），把整个任务变成一局可复盘的棋。高价值的棋局几年后仍能记起整盘怎么下；走到关键处，旧棋谱会吊起记忆，让人悬崖勒马。


DSH（DeepSeek Harness）的上下文压缩后端。它把「历史 → 一段摘要」换成
**「历史 → 棋谱 DAG（节点=状态，边=尝试+结果+验证信号） + 每步重建的极短热上下文」**。

三句话讲清它和市面上所有方案的区别：

1. **增量 fold**：每次只压「上一个 checkpoint 之后」新增的部分 —— 一段内容一生只被摘要一次。
   官方 `dsh-compaction-basic`（以及绝大多数商业 harness）每轮都把上一次的摘要再摘要一遍，
   早期约束与否定结果按 ρ^k 衰减（Compaction Cliff 实测：安全规则 5 轮后只剩 10%）。
2. **失败记忆是一等公民**：每条失败尝试（意图 / 动作 / 报错原文 / seq 坐标）由规则抽取，
   **逐字**注入摘要 prompt，并在每步的热上下文里重建。模型没有「决定丢掉它」的权限。
3. **置换检测**：状态哈希（世界状态 + 已知约束集）命中历史节点时，不新建分支，只在图上加一条
   指向旧节点的边，并提示「回到节点 N —— 这里试过的路都记着」。

---

## 装

```bash
# 1) 先看要改什么（不写盘）
node test/install.mjs --dry-run

# 2) 装（会备份 profile/package.json 与 preset 的 cordis.patch.yml）
node test/install.mjs

# 3) 重启 DSH 后按 docs/重启后验证清单.md 四条确认

# 回滚
node test/rollback.mjs
```

安装做三件事：

| # | 动作 | 为什么 |
|---|---|---|
| ① | `<profile>/node_modules/dsh-gokifu-compact` → 本项目的 junction | 让 preset 能按包名解析到它 |
| ② | `profile/package.json` 的 `dependencies` 加一条 `link:` | 供 pnpm 感知（**不加 `dsh.profile.bundles`**，否则会在顶层再挂一份，与 preset 内那份冲突） |
| ③ | preset 的 `cordis.patch.yml` 里把 group 内的 `compaction-basic` 换成 `dsh-gokifu-compact` | 真正生效的是 preset 内那一份（见 `docs/DSH-技术测绘.md` §9 陷阱 4） |

> ⚠ **单实例硬规则**：`ctx.compaction` 在同一 isolate realm 里只能注册一次，
> 注册第二个会在构造期抛 `service "compaction" has been registered`，并连带整个 preset generation 挂掉。
> 安装脚本会把旧行替换掉，不要手工复制一份。

## 配置

```yaml
- id: chess-context
  name: 'dsh-gokifu-compact'
  config:
    thresholdRatio: 0.45      # 压力闸：min(窗口×0.45, 窗口−输出预留−64K)
    headroomTokens: 65536
    retainRatio: 0.16         # 逐字保留的近期尾部
    retainTokens:             # 或给绝对值（与 retainRatio 互斥）
    growthFloorTokens: 40000  # 增长闸：距上次 fold 至少新增这么多 token
    minFoldTokens: 8000       # 被遮蔽内容少于这个数不值得压
    summaryMode: hybrid       # hybrid | rules（零模型调用）| llm
    maxTokens: 2048
    summarizationProvider: magpie                 # 留空=跟随最近一次路由
    summarizationModel: ima/deepseek-v4.1-flash   # 推荐：ima 免费模型，实测 8/8 死路、2/2 约束
    hotLedger: true           # 每步注入失败清单
    hotLedgerMaxTokens: 500
    transposition: true       # 置换检测
    tier2After: 8             # checkpoint 超过 8 个就把最老的两段合并
    graphDir: ''              # 留空 = <DSH_HOME>/chess-context
    auto: true
```

`summaryMode` 的取舍：

| 模式 | 模型调用 | 适合 |
|---|---|---|
| `rules` | **0 次** | 高频小 fold、预算敏感；摘要由规则模板生成（目标/约束/死路/已验证/当前节点） |
| `hybrid`（默认） | 1 次/fold | 需要模型补写「意图」与「下一步」；硬事实仍由规则给定 |
| `llm` | 1 次/fold | 只在明确需要模型自由发挥时 |

## 推荐摘要模型

`summaryMode: hybrid` 需要一次模型调用。推荐把 `summarizationProvider` / `summarizationModel`
指向 **ima 免费模型**（先用 `magpie-ima-local-auth` 插件接入）：

```yaml
summaryMode: hybrid
summarizationProvider: magpie
summarizationModel: ima/deepseek-v4.1-flash
```

实测（同一份 8 条失败边 + 2 条约束的合成会话，3 次采样）：

| 模板 | 死路保留 | 约束保留 | 摘要长度 |
|---|---|---|---|
| 本插件棋谱模板 + ima V4.1-Flash | **8/8（3/3 次）** | **2/2（3/3 次）** | 1,887 字符 |
| 官方 8 段模板 | 5/8 | 0/2 | ~3,072 字符 |

也就是说：**ima 这种免费小模型最适合的正是“单轮、结构化、无工具”的摘要任务**，而不是
当 DSH 的 agent 后端。它在这里比官方模板更听话，而且不占主路由额度。

证据：[evidence/ima-摘要测试.md](evidence/ima-摘要测试.md)（3 次采样原始输出）。

## 它产出什么

```
<DSH_HOME>/chess-context/sessions/<session>/graph.json   完整 DAG（节点 + 边 + 索引）
<DSH_HOME>/chess-context/sessions/<session>/graph.md     人读棋谱（节点/边/结果/置换标记）
```

DSH 自己的会话日志仍是原始记忆的唯一来源 —— 节点上只记 `seq` 坐标，需要逐字原文时按 seq 回读。

## 热上下文长什么样

每步 `agent/pre-step` 注入（清单不变时复用，不重复注入）：

```
<chess-ledger>
ROOT USER (verbatim): 必须把测试改成绿的，不要动 prod 配置…
CONSTRAINTS (verbatim):
- 必须把测试改成绿的。
- 不要动 prod 配置。
CURRENT PATH: n1 → n3 → n7
CURRENT GOAL: 把 fold 的起点挪到 checkpoint 之后
PROVEN DEAD ENDS (do not retry blind; every one of these was tried):
- e2 "改成流式写入" → TypeError: Cannot read properties of undefined (reading 'pipe') (seq 120-131)
- e5 "换用 sqlite" → ENOENT: no such file or directory, open 'data/x.db' (seq 208-211)
</chess-ledger>
```

预算不够时**降级不丢边**：先砍原因长度、再砍动作，最后只留 `e<id>`（可回查 graph.md）。

## 测试

```bash
node test/run.mjs            # 81 项：图/判定/范围/热上下文/事件落账/接线（假 DSH）
node test/verify-install.mjs # 13 项：安装与挂载校验（含运行期 graph.json 证据）
node test/evidence.mjs       # 重算 evidence/模拟结果.md（计费、保留率、热上下文成本）
node test/bench.mjs 2000     # 2000 条边的性能与体量

# 用**真实的** @deepseek-ai 模块验证（从 app.asar 提取依赖闭包到 tmp，不重启 DSH）
node test/real-modules.mjs   # import / 真 cordis 构造 / Config schema / 继承链
node test/real-fold.mjs      # 真实 compactRegion 事务 + 棋谱摘要（rules 与 hybrid 都能跑通）
node test/real-fold-trigger.mjs  # fold 自动触发（阈值/增长门/增量）；需要真实模型，结果非确定，手动跑

# 用**真实模型**（magpie 默认路由组）验证
node test/real-model.mjs     # 对照实验：本插件 8/8 vs 官方 4.67/8 失败边保留
node test/real-e2e.mjs       # 真实 bash 失败 → 压缩 → 续跑 3/3
```

### v0.1.2 · 运行期修复（2026-10-28）

插件在真实会话里跑起来后，暴露并修掉了 8 个 bug，详见 [运行期修复报告](docs/运行期修复报告.md)；性能分解见 [性能与成本](docs/性能与成本.md)。

| Bug | 修复前 | 修复后 |
|---|---|---|
| 系统注入被当成用户的话 | user 节点 13 个（含 Hindsight/系统说明） | **3 个**（全是真人输入） |
| 只读工具文本被当成失败 | failure 55 条（30+ 误报） | **8 条**（逐条核对全真） |
| 落盘滞后 | 每 25 事件才写 | 变化后 1.2s debounce 写 |
| 热上下文爆炸 | 1201 条边 → 28,800 tokens | **476 tokens**（L4 降级 + 汇总行） |

三层验证的分工：

| 层 | 文件 | 回答什么问题 |
|---|---|---|
| 纯函数 | `test/*.test.mjs` | 图不变量、判定规则、增量范围、热上下文降级 |
| 假 DSH | `test/engine-harness.test.mjs` | engine 的接线：构造 / 落账 / 注入 / 门控 / 溢出自救 |
| **真模块** | `test/real-modules.mjs` + `test/real-fold.mjs` | **重启后会不会崩**：依赖名对不对、能否继承官方事务、摘要是否真的替换了官方模板 |

最后一层是从 `app.asar` 里把 29 个 `@deepseek-ai/*` 包提取到 `tmp/dsh-gokifu-compact/modules`
再 import 的 —— 它验证的是真实类，不是 stub。

## 已知边界（诚实清单）

- **压缩仍是替换**：DSH 的 surface replace 会让 KV 前缀从替换点起失效。增量 fold 让替换点尽可能靠后，
  但无法消除（这是 seam 的语义，不是实现选择）。
- **规则判定会误判**：判不出来的一律标 `unverified`，绝不标 `success`；`errorSnippet` 保留报错原文兜底。
- **不做多分支并行执行**：无廉价验证器时多分支搜索是烧钱（ReSCALE 反证），本插件只做「失败后换路」的记录与提示。
- **未在真实会话中重启验证过**（本会话不能重启自身）：接线由 harness 测试覆盖，运行期表现按
  `docs/重启后验证清单.md` 核对。

## 文档

- [方案书](docs/方案书.md) · [计划表](docs/计划表.md)
- [市场对标](docs/市场对标.md)（billion-context / opencode-dcp / LLMLingua / LCM / Compaction Cliff…）
- [DSH 技术测绘](docs/DSH-技术测绘.md)（1300 行，每条带 asar 行号）
- [最终报告](docs/最终报告.md) · [重启后验证清单](docs/重启后验证清单.md)
- [证据：模拟结果](evidence/模拟结果.md)
