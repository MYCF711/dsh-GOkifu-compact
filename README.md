# DSH-GOkifu-compact

> 已经装好了？直接看 [快速开始](QUICKSTART.md)。

> **为什么叫 GOkifu-compact** —— **GO（围棋）+ kifu（棋谱）+ compact（压缩）**。
> **展示名用大写 GO**（`GO` 才是围棋，`go` 是编程语言）；**npm 包名只能小写**（`dsh-gokifu-compact`，这是 npm 的硬限制）。一局棋下完，棋谱上不只有落子顺序，还有每一手的评语。这个插件做的事一样：把 agent 每一步变成一手棋（节点），把当时的思考变成评语（节点的目标 / 约束 / 失败原因），把整个任务变成一局可复盘的棋。高价值的棋局几年后仍能记起整盘怎么下；走到关键处，旧棋谱会吊起记忆，让人悬崖勒马。

### 围棋术语对照（设计说明）

| 中文 | 日文 | 英文 | 本插件对应 |
|---|---|---|---|
| 本手 | 本手（ほんて） | honte / proper move | 成功路径（标准定式） |
| 恶手 | 悪手（あくしゅ） | aku / bad move | `[dead]` —— 没有成功路径经过 |
| 俗手 | 俗手（ぞくしゅ） | zokusu / vulgar move | `[redundant]` —— 表面正常，实际多走了 |
| 新手 | 新手（しんしゅ） | shinshu / new move | `[novel]` —— 探出新状态 |
| 缓手 | 緩手（かんしゅ） | kanshu / slow move | `[longer]` —— 绕远 |
| 手割 | 手割（てわり） | tewari | 手割分析（判断谁亏谁赚） |
| 胜负手 | 勝負手（しょうぶて） | shobute | 关键决策点（未实现） |

**热清单里的标签仍用英文短词**（`dead` / `redundant` / `novel` / `longer`）——
模型训练数据里这些词的出现频率比 `aku` / `zokusu` 高几个数量级，
标签是给模型**执行**的，不是给人**欣赏**的。术语表放这里（给人看设计理念）。

## 三层文件树

每次 flush 额外写三层（`graph.json` 是数据源；`graph.md` 按需生成，见下）：

| 文件 | 内容 | 谁用 |
|---|---|---|
| `index.md` | 落子顺序（每节点一行 + 出边状态） | 模型先读这个 |
| `nodes/<id>.md` | 单节点：评语 / 状态 / 入边 / 出边 / raw 链接 | 模型按需读 |
| ~~`raw/<seq>.md`~~ | 已砍掉 —— 节点 JSON 与 `graph.json` 重复 | — |

**设计依据**：`evidence/棋谱有效性实验.md` —— 干净子代理实验证明三层缺一不可：
索引让模型看到全部死路，节点给详情，原始补抽取的漏。

旧会话补文件：`node test/build-tree.mjs <sessionDir>`。


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
    hotLedgerMarkers: semantic # semantic（带语义+图例）| terse（只三态）| off
    hotLedgerReplace: true   # 就地替换 surface 上的旧清单（surface 永远只有一条）
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

每步 `agent/pre-step` 注入。**surface 上永远只有一条清单**：清单变了就**就地替换**上一条
（DSH 的 `surfaceOp:{op:"replace"}`，官方 system-prompt / tool-result-pruner 用的同一机制），
而不是再追加一条 —— 旧版不替换，实测一个会话累积 **176 条 / 81 万字符 ≈ 27 万 token**
（`evidence/P1-4-清单替换实测.md`）。
v1.5.0 之前追加出来的旧清单也会被**一次性换成一行占位**（surface 只支持 append/replace，不能删节点）——
实测事故会话的 surface 上还压着 44 条 / 29.5 万字符 ≈ 9.8 万 token，下次打开该会话时自动清掉。

**标记一定自带解释** ——
清单里出现的每个标记，图例里都有对应的一行（按实际用到的动态生成，不浪费预算）：

```
<chess-ledger>
ROOT USER (verbatim): 把 tests/case*.test.js 跑绿：缓存键算错了。不要动 prod 配置。
CONSTRAINTS (verbatim):
- 不要动 prod 配置。
CURRENT GOAL: 缓存键修好，case7 通过
WORKING: user → n2 (exit 0)
LEARNED (3 failed attempts):
# markers:
#   dead = a working path avoids it — retry only if that path breaks
#   redundant = working edge <edge> reaches the SAME position — take that one
#   blocked:permission = needs a permission this environment lacks — retry when it changes
- e2 "把缓存键改成 JSON.stringify 全部参数" → AssertionError: case7 expected 1 got 2 … [dead redundant:e1]
- e3 "装全局 sqlite 依赖后再跑" → npm ERR! EACCES: permission denied, mkdir … [blocked:permission]
</chess-ledger>
```

四条设计约束（都是实测逼出来的）：

1. **标记说语义，不说缩写**：`blocked:permission` 比 `[blocked]` 多出的那截就是「什么条件变了能再试」，
   而这正是 `revisit_if` 想给模型的东西（旧版只在 index.md 里给，热清单里看不到）。
2. **图例跟着标记走**：旧版把图例绑在「检测到手割」上 ⇒ 一个只有 EACCES 的会话里 `[blocked]` 裸奔；
   现在有标记必有图例，且只解释用得上的那几条。
3. **原因（报错原文）任何档位都保留**：旧版 L3+ 把 `→ 原因` 整段砍掉，实测全库 133 条可见失败边里
   只有 25 条带原因 —— 而模型判断「这是不是同一个坑」靠的就是报错原文。
4. **手割标记对最近 30 条边算**（每条一次 BFS）：旧版「显示条数 ≤30 才算」⇒ 40 条失败边的会话
   一条标记都没有，而模型只对最近几步做决策。

预算不够时**降级不丢边**：先砍意图与原因的**长度**，再砍 seq，最后只列最近 N 条 + 汇总行。
标记档位可用 `hotLedgerMarkers` 调：`semantic`（默认）| `terse`（只写三态，省 token）| `off`。

## 测试

```bash
node test/run.mjs            # 118 项：图/判定/范围/热上下文/标记契约/事件落账/接线（假 DSH）
node test/doctor.mjs         # 一条命令体检：安装 / 摘要模型 / 压缩成败 / 棋谱 / 树新鲜度
node test/verify-install.mjs # 13 项：安装与挂载校验（含运行期 graph.json 证据）
node test/verify-graphs.mjs  # 全库棋谱健康检查（worldHash 类型 / stateIndex / renderFacts 不抛错）
node test/measure-billing.mjs # 真实 usage 计费审计（prompt / 缓存命中 / 清单占比 / fold 收支）
node test/measure-ledger.mjs # 热清单的 token 与信息量（--terse / --off 可换档对比）
node test/ab-render.mjs      # A/B 夹具：同一张棋谱的三种标记档位各渲染一份（模型消费者实验用）
node test/rewash-graph.mjs   # 历史棋谱回洗（dry-run 默认；--apply 写盘并重建树）
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
| 热上下文爆炸 | 1201 条边 → 28,800 tokens | **323 tokens**（L5 降级 + 汇总行 + 跳过装不下的档位） |
| 标记裸奔（v1.4.0） | `[blocked]` 出现却无解释；`redundant`/`longer` 从不在图例里 | 标记自带语义（`blocked:permission`）+ **按用到的标记动态生成图例** |
| 原因失踪（v1.4.0） | L3+ 把 `→ 报错原文` 整段砍掉（全库 133 条可见失败边只有 25 条带原因） | 任何档位都保留原因（最省档 25 字），带原因条数 89 → **209** |

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


> `graph.md`（整篇人读视图）不再自动写 —— 用 `node test/build-md.mjs <sessionDir>` 按需生成。
