# dsh-GOkifu-compact

> 当前版本：**`1.11.7`** · npm [`dsh-gokifu-compact`](https://www.npmjs.com/package/dsh-gokifu-compact) · [GitHub Releases](https://github.com/MYCF711/dsh-GOkifu-compact/releases) · 更新记录见 [CHANGELOG.md](CHANGELOG.md)

**DSH 的棋谱式上下文压缩后端 —— 把「历史 → 一段摘要」换成「历史 → 可复盘的棋谱 DAG + 每步只有 351 tokens 的热清单」。**

```
热清单     351 tokens       （2000 边合成夹具 · L5 降级档 · 2026-10-30/10-31 两次实测同值；旧版全量 28,800）
失败保留   8 / 8            （历史口径 †；官方 8 段模板 4.67 / 8）
清单开销   未复现/待测       （原载 0.2% = 历史单会话 v1.3.1 后实测；无复跑命令、无对照组；源 evidence/真实计费核对.md）
验证       486 项单测（0 skipped） · 真实包 8/8 † · 真实进程 fold 3~6/6 †
```

GO = 围棋，kifu = 棋谱，compact = 压缩。一局棋下完，棋谱上不只有落子顺序，还有每一手的评语。
这个插件把 agent 的每一步变成一手棋（节点）、把当时的思考变成评语（目标 / 约束 / 失败原因），
整个任务变成一局可以复盘的棋。**棋谱是给模型用的，不是给人看的** —— 热清单里的每个字都为模型决策服务。

> **† 历史口径（未复现）**：`失败保留 8/8`、`真实包 8/8`、`真实进程 fold 3~6/6` 都是**早期真机测量**，**本轮没有复跑命令、没有复现**，不要当现行指标引用。
>
> **351 tokens 的口径**：这是 **2000 边合成夹具**在 **L5 降级档**下的结果，**不是真实会话均值**。真实会话里预算按 `字符数/3` 估算，实测**系统性低估 5.2%~22.1%（中位 9.7%）**（见 `计划表.md` 的 OPT-TOKENS 节）；**真实会话口径尚未校准** —— 正解是引入宿主 tokenizer（`ctx.tokenMeter`）后重测，**未做**。

---

## 功能

- **增量 fold** —— 只压「上一个 checkpoint 之后」的新内容；一段历史一生只被摘要一次。
- **失败记忆** —— 每条失败尝试的意图 / 动作 / 报错原文 / seq 由规则抽取并**逐字**保留，模型没有丢弃它的权限。
- **手割（tewari）** —— 同一条失败边相对**每条**成功路径分别给结论：同型 / 绕路 / 探新，不是一个笼统的「失败」。
- **热清单** —— 每步重建的小清单：语义标记（`blocked:permission` / `dead retry-if:e1`）+ 动态图例 + 报错原文；**就地替换**，surface 上永远只有一条。
- **置换检测** —— 状态哈希命中历史节点时不新建分支，只在图上加一条边，并提示「回到节点 N —— 这里试过的路都记着」。
- **三层树** —— `index.md`（全量索引）/ `nodes/<id>.md`（单节点细节）/ `graph.json`（数据源），模型按需往下查。
- **压缩永不失败** —— 摘要三层降级：配置的摘要模型 → 当前路由模型 → 规则摘要（零模型调用），fold 一定能落地。
- **可诊断** —— `doctor` 一条命令体检、`measure-billing` 按真实 usage 对账、`rewash` 回洗历史误报。

## 怎么工作

```
每一步：事件流 ──► 棋谱 DAG（节点 = 状态；边 = 尝试 + 验证信号）
                        │
                        ▼
              热清单（根目标 / 约束 / 成功路径 / 失败边）──► 注入模型
                        │
             到阈值（默认窗口 45% 且增量 ≥ 40K）
                        ▼
              增量 fold：只压上一个 checkpoint 之后 ──► 棋谱摘要（失败边逐字保留）
```

和官方 `dsh-compaction-basic` 的区别：

| | 官方 `compaction-basic` | 本插件 |
|---|---|---|
| 压缩范围 | 从 surface 第一个非 system 节点起（**含上次 checkpoint**） | 上一个 checkpoint **之后** |
| 保留率 | 每轮重摘 → 按 ρ^k 衰减（实测安全规则 5 轮后剩 10%） | 一段内容只摘一次 |
| 失败记录 | 融进散文摘要，模型可以丢 | 规则抽取 + 逐字注入，模型无权丢 |
| 热上下文 | 无 | 351 tokens / 步（**2000 边合成夹具 · L5 降级档**；真实会话口径未校准），带语义标记与报错原文 |

### ⚠ 棋谱落盘：`graph.json` 的语义（1.9.2 起）

**`graph.json` 不再代表「最新状态」，而是「上一回合基线 + 当前增量」。**

```
每次都重写整图（≤1.9.1）      增量落盘（1.9.2 起）
graph.json = 最新             graph.json              = 上一个回合边界的完整基线
                              graph.json.delta.jsonl  = 本回合的增量帧（带 baseHash + checksum）
                              （两者合并 = 最新状态）
```

**⇒ 它在回合内落后一回合。** 任何直接 `JSON.parse(graph.json)` 当「最新」的脚本，**都会少一回合的数据**。
`graph.json` 只在**回合边界**（`agent/status idle`）落一次完整快照；回合内的每一步只往
`graph.json.delta.jsonl` 追加一帧。

| 你要什么 | 怎么拿 |
|---|---|
| **最新状态**（推荐） | **基线 + 增量一起读**：`fromJSON(graph.json 文本)` → 用基线内容哈希 `decodeDeltaFrames(delta 文本, baseHash)` → 逐帧 `applyDelta(g, frame)`。三个函数都从包入口 `dsh-gokifu-compact/graph` 导出（源码 `src/rooms/kifu-model.mjs`，随包发布）；落盘/读盘侧（`graphRoot` / `sessionPaths` / `createPersistStore` 等）走 `dsh-gokifu-compact/persist` |
| 上一回合基线（做 diff / 审计） | 直接读 `graph.json` 可以，但**要说明「这是基线不是最新」** |
| 崩溃安全 | 每帧带 `baseHash`（generation）+ `checksum31`：半写帧解码时就地停止，加载时把 delta 截到最后一条好帧；**旧 generation 的帧整体忽略** |

**为什么这样设计**：写放大从 **×80 / ×70 / ×62** 降到 **×37 / ×33 / ×31**（三张真实图 60 步 + 1 回合边界），
fold 后 flush 从 **429–836 ms** 降到 **≤95 ms**；代价是「读的人必须知道这是增量结构」。

**三条已知余量（选型时要知道）**

1. **短回合写放大**：每回合边界落一份完整基线（0.5–0.6 MB）。真实分布 p50=40 步/回合 ⇒ 写放大 ≈×20–25；
   但**极短回合（<10 步，p10=13.9）**摊销不足，写放大仍可能 >×50。
2. **dirty > 100 的 flush**：fold 后只写 dirty 节点 —— 5–20 个 dirty 时 **9–23 ms**，100 个时约 **87–89 ms**
   （改前全量 429–836 ms）。dirty 数极大时收益收窄。
3. **`appendFileSync` 的原子性依赖 OS**：本机 NTFS 上 1 KB 级追加已过半写测试；**跨平台（尤其网络文件系统）未验证**。

### 热上下文长什么样

每步 `agent/pre-step` 注入（内容不变时复用；变了就**就地替换**上一条，surface 永远只有一条）：

```
<chess-ledger>
ROOT USER (verbatim): 把 tests/case*.test.js 跑绿：缓存键算错了。不要动 prod 配置。
CONSTRAINTS (verbatim):
- 不要动 prod 配置。
CURRENT GOAL: 缓存键修好，case7 通过
WORKING: user → n2 (exit 0)
LEARNED (3 failed attempts):
TRACE: <sessions>/<sid>/index.md  (per-node detail: nodes/<id>.md)
# markers:
#   dead = a working path avoids it — retry only if retry-if breaks
#   redundant = working edge <edge> reaches the SAME position — take it
#   blocked:permission = needs a permission this environment lacks — retry when it changes
- e2 "把缓存键改成 JSON.stringify 全部参数" → AssertionError: case7 expected 1 got 2 … [dead retry-if:e1]
- e3 "装全局 sqlite 依赖后再跑" → npm ERR! EACCES: permission denied, mkdir … [blocked:permission]
</chess-ledger>
```

预算不够时**降级不丢边**：先缩短意图与报错，再砍 seq，最后只列最近 N 条 + 汇总行。
标记档位可调：`semantic`（默认）| `terse`（只写三态）| `off`（不打标记）。

## 安装

**两步，不用手改任何 YAML。**

```bash
# 1) 装包（DSH 会把它作为普通依赖装进 profile；不会把它塞进 bundles，避免双挂载）
dsh plugin --profile <profile> add dsh-gokifu-compact

# 2) 一条命令接管压缩后端（自动改 preset 的 compaction group，带备份、可回滚、幂等）
npx dsh-gokifu-compact install --profile <profile>

# 3) 重启 DSH（插件在启动时加载），然后自检
npx dsh-gokifu-compact doctor
```

> 第 1 步会打印一条 `declares no dsh.bundle — installed as a plain dependency` —— **这是预期的**：
> 本插件挂在 agent preset 里，不做 profile 级 bundle（做了会在顶层再挂一份，与 preset 内那份双实例冲突）。

第 2 步做的是**唯一一件必须改文件的事**：把 agent preset 的 compaction group 里
`@deepseek-ai/dsh-compaction-basic` 那一行换成 `dsh-gokifu-compact`。为什么脚本必须改文件而不是
自动在启动时生效——因为那一行在 preset 的 `config.plugins` 数组内部，profile 级 / bundle 级的
patch 打不到它（`applyEntryPatches` 只递归 `group: true` 且 `config` 为数组的条目）。
脚本替你改、替你备份、也能替你还原：

```bash
npx dsh-gokifu-compact install --dry-run     # 先看会改什么（不写盘）
npx dsh-gokifu-compact revert                # 还原（恢复 .bak-before-gokifu-* 备份）
```

**从源码（开发用，一条命令含链接 + 改 preset + 校验）**

```bash
git clone https://github.com/MYCF711/dsh-GOkifu-compact.git
cd dsh-GOkifu-compact
node test/install.mjs --dry-run   # 预演
node test/install.mjs             # 真装
node test/rollback.mjs            # 回滚
```

> ⚠ **压缩后端只能有一个**：`ctx.compaction` 在同一 isolate realm 里只能注册一次，同时挂
> `dsh-compaction-basic` 会在构造期抛 `service "compaction" has been registered`，并连累整个
> preset generation。安装器做的就是「换掉那一行」；不要手工再复制一份。

## 配置

```yaml
- id: gokifu-compact
  name: 'dsh-gokifu-compact'
  config:
    auto: true                # 自动压缩（继承基类的 between-step 压力触发）
    thresholdRatio: 0.45      # 压力闸：min(窗口×0.45, 窗口−输出预留−64K)
    growthFloorTokens: 40000  # 增长闸：距上次 fold 至少新增这么多 token
    retainRatio: 0.16         # 逐字保留的近期尾部
    summaryMode: hybrid       # hybrid | rules（零模型调用）| llm
    maxTokens: 8192           # 摘要输出上限（实测一次 fold 用到 2,902，留足余量防截断）
    summarizationProvider: '' # 留空 = 跟随当前路由（最稳）
    summarizationModel: ''    # 想用免费模型，先确认 provider 的模型表里有那个 id
    hotLedger: true           # 每步注入失败清单
    hotLedgerMaxTokens: 500
    hotLedgerMarkers: semantic # semantic | terse | off
    hotLedgerReplace: true    # 就地替换旧清单（surface 永远一条）
```

全部配置项与含义见 [`docs/性能与成本.md`](docs/性能与成本.md) 与 `src/engine.mjs` 的 `Config`。

## 常见问题

**关掉原生压缩，自动压缩还在吗？** 在 —— 本插件**就是**那个自动压缩后端：它继承官方的
`BasicCompactionEngine`（同一套 between-step 压力触发、context-overflow 兜底、事务语义），
`auto` 默认 `true`，装的不是「替代品」而是「换引擎」。变的只是「压缩范围 = 上一个 checkpoint 之后」
与「失败记忆逐字保留」。

**压缩之后数字会降吗？会不会只增不减？** 会降。一次 fold 用一个 checkpoint **替换掉整段被遮蔽的
历史**，tokenMeter 重新计算后数字直接下降；但不会归零 —— 还会保留逐字尾部（`retainRatio`，默认 16%）
和摘要本身。典型形状是**锯齿**：涨到阈值（窗口 45%）→ 压到约 20% → 再涨。如果你看到「只涨不降」，
先跑 `npx dsh-gokifu-compact doctor` 看压缩是不是在失败（`compaction/end` 的错误会直接列出来）。

**装完没反应 / 压缩没触发？** 插件在 DSH 启动时加载，**必须重启**。重启后跑 `npx dsh-gokifu-compact doctor`
（在源码仓库里是 `node scripts/doctor.mjs`），它会告诉你四件事：装没装上、摘要模型能不能解析、
最近的压缩成功/失败、棋谱与树健不健康。

**会不会把失败记忆弄丢？** 不会。失败边由规则抽取并逐字注入摘要 prompt，模型输出后还会机械追加约束段；
模型没有「决定丢掉某条」的权限。真实模型对照里本插件保留 8/8，官方 8 段模板平均 4.67/8。

**摘要模型要配吗？** 不用，留空就跟随当前路由。配了但 provider 的模型表里没有那个 id 时，
引擎会退回路由模型；再不行就退回规则摘要（零模型调用）—— 宁可摘要朴素，也不让压缩失败。

**历史数据会不会把压缩弄坏？** 不会。插件加载棋谱时会自动修复旧格式（`worldHash` 对象 → 字符串、状态索引重建）；
旧版本追加出来的几十条热清单会被一次性换成一行占位。全库 1,279 个坏字段实测归零。

**为什么压缩还是会让 prompt 缓存失效？** DSH 的 surface `replace` 语义决定：替换点之后的 KV 前缀会失效。
增量 fold 让替换点尽可能靠后，但无法消除（这是 seam 的语义，不是实现选择）。真实会话实测缓存命中率 94~97%。

**能和多分支/子代理一起用吗？** 子代理各自独立会话、各自一张棋谱；主会话的置换提示只在同一会话内生效。

## 参考源

只借鉴**结构与规律**，未复制代码：

| 来源 | 用在哪 |
|---|---|
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | README 模板、发版七步、维护检查脚本（`scripts/`） |
| [billion-context](https://github.com/ranxianglei/billion-context)（MIT + 署名附加条款） | 「增量 fold / 只压已消费内容」的架构不变量、缓存与保留率的判据 |
| [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（MIT） | 「每个机制一节」的说明结构、对 prompt 缓存影响如实交代的写法 |
| [DSH 官方 `dsh-compaction` / `dsh-compaction-basic`](https://github.com/deepseek-ai)（随 DSH 分发） | 继承 `compactRegion` / `surfaceOp: replace` 事务语义，只覆盖策略层 |

设计依据与实测数据在 [`docs/市场对标.md`](docs/市场对标.md) 与 [`evidence/`](evidence/)。

## 文档

- [快速开始](QUICKSTART.md) · [方案书](docs/方案书.md) · [计划表](docs/计划表.md)
- [三层树设计](docs/三层树设计.md) · [DSH 技术测绘](docs/DSH-技术测绘.md)（1300 行，带 asar 行号）
- [性能与成本](docs/性能与成本.md) · [真实计费核对](evidence/真实计费核对.md)
- [最终报告](docs/最终报告.md) · [P0 修复记录](docs/P0-worldhash-死循环-根因与修复方案.md)

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)（发版流程见 `scripts/release.mjs`；维护侧的 `HANDOFF.md`
> 不随 npm 包发布，在 GitHub 仓库根目录）

## 许可

MIT。见 [LICENSE](LICENSE)。
