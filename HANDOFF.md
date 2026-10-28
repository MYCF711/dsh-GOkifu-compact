# dsh-kifu-context · 当前状态

> 更新于 2026-10-28 07:2x（本会话）

## 用户原话（逐字）
> 要求就是完善一个最完美的上下文压缩插件。参考市场上热门的记忆插件dsh-ops，billicon-context，等等压缩方法。
> "E:\Downloads\Screenshot_2026-10-28-14-40-47-09.jpg" 这个图片是我文qwen3.8max讨论的过程，qwen3.8max的回复仅供参考，我发出去的是我的真实想法。不过你只要能实现就行。要求是超越市场上所有的压缩方法。性能最好，或者性价比最好。然后你写一个goal，自己跑，我去睡觉
> 写好goal

用户真实想法（截图，**需求权威来源**）：
- 一轮记忆 = 当前节点状态 + 预期目标 + 预想道路；模型挑一条走，成功/失败都产生新节点。
- 所有思考、命令调用归纳成棋谱；**user 的话原样保存为 user 节点**，影响整张棋谱。
- 节点之间可省略；道路 = 节点间的边；**不真倒带丢节点，因为可能殊途同归到同一个错误节点**。
- 省略的内容放 md 索引；每个节点能查到相邻节点的原始记忆。
- 置换判据：换路回到之前卡住的地方 = 前进米数无长进。

## 我的推断（明确标注）
- 官方 `dsh-compaction-basic` 每轮把上一次 checkpoint 再摘要一遍 ⇒ 保留率 ρ^k 衰减，必须自研范围选择。
- 事务层（锁/稳定性/工具对/checkpoint 标记）不能重写 ⇒ 继承官方 backend，只覆盖策略。
- 「每步注入失败清单」用 `agent/pre-step` 返回 `{...decision, messages}`（照官方 `agent-instructions` 的写法）。

## 已建成（附证据）
- 插件包：`src/`（engine + 8 个纯函数模块）、`test/`（81 项全绿）、`evidence/模拟结果.md`
- 文档：`README.md`、`docs/方案书.md`、`docs/市场对标.md`（452 行）、`docs/DSH-技术测绘.md`（1303 行）、
  `docs/最终报告.md`、`docs/重启后验证清单.md`
- **已安装**：junction → `profiles/desktop/node_modules/dsh-kifu-context`；
  `profiles/desktop/package.json` 加 link 依赖；`preset-bundles/personal-assistant/cordis.patch.yml`
  的 `compaction-basic` 行已换成 `chess-context`（备份 `*.bak-before-chess-context-*`）
- 数字（模拟口径，`node test/evidence.mjs`）：累计计费比官方低 **19%–35%**，峰值上下文低 37.7%–43.2%，
  死路清单 0 丢失
- **真模块验证**（`node test/real-modules.mjs` 4 项 + `node test/real-fold.mjs` 5 项，全过）：
  从 app.asar 提取 29 个真实 `@deepseek-ai/*` 包，验证 import / 真 cordis 构造 / Config schema /
  继承链 / **真实 compactRegion 事务 + 棋谱摘要（rules & hybrid）**

## 第二阶段（2026-10-28 重启后）
- 插件**已在真实 DSH 进程里工作**：每步注入 `<chess-ledger>`、graph.json 落盘（2 个会话）。
- 实测暴露并修掉 4 个 bug（见 `docs/运行期修复报告.md`）：source 过滤、verifier 分层、flush debounce、ledger 硬预算。
- 真实模型对照实验：**本插件 8/8 vs 官方 4.67/8** 失败边保留（3 次采样，`evidence/真实模型测试.md`）。
- 真实端到端：真实 bash 失败 → 真实事务 → 续跑 **3/3**（`evidence/真实端到端测试.md`）。
- 性能：2000 边时热上下文 **476 tokens**（原 28,800），事实块 81K 字符（原 222K）。
- **fold 自动触发已直接验证**（`evidence/fold触发验证.md`）：60K 不压、150K 压、growth gate 拦住重复压、增量 90K 再压 —— 触发逻辑已验证（见 evidence/fold触发验证.md 的最新一次运行），摘要来自真实模型。
- 运行期回放（同一份 1863 事件真实日志）：v0.1.2 把 user 节点从 40 降到 **4**、failure 从 56 降到 **22**，热上下文 **392 tokens**（`evidence/重启验证.md`）。

## 未完成 / 阻塞
- **v0.1.2 的修复尚未在当前运行的 DSH 里生效**（进程加载的是 v0.1.0）。重启后按 `docs/重启后验证清单.md` 核对。
- 真实模型对 `[HARD FACTS]` 的遵循度未测（需要跑真实会话）。

## 下一步（唯一）
重启 DSH → 按清单四条核对 → 结果写进 `evidence/重启验证.md`。出问题先 `node test/rollback.mjs`。

## 我自己纠正过的误判
- 曾以为 peer 版本可写 `^0.2.0-rc.1`：实测宿主 0.2.0-rc.2，semver 对预发布不满足 `^0.2.0` ⇒ 改精确版本。
- 曾以为 tier-2 只需改记录：实际必须真的合并 surface 上的两个 checkpoint，否则常驻成本不降。
- 曾以为 `session/event` 里可以 append：测绘确认会被重入保护吞成 warn ⇒ keeper 只更新内存 + 写 sidecar。

---

## 代码审查发现的待修项（2026-10-28 21:00 · 只读审查，未修完）

独立审查（真实日志回放 + 内存复现）报了 15 条。**已修 3 个 P0**：

| # | 问题 | 状态 |
|---|---|---|
| P0-1 | `this.flushTimers` 从未初始化 → 每次「有变化」的事件抛 TypeError，**debounce 落盘完全失效** | ✅ 已修 + 在构造函数注释里写明后果 |
| P0-2 | 节点创建时写死 `worldHash:"pending"`，fold 前统一回填成同一个哈希 → 整段路径被折叠成一个节点 | ✅ 已修：engine 注入 `state.worldHashOf()`，节点用创建时刻真实哈希；`touchPath` 真的喂给世界状态 |
| P0-3 | `mergeNodeInto` 只改 `edge.to` 不改 `edge.from` → 合并非叶子节点后出边全部悬空（实测 155 边里 115 条） | ✅ 已修 + 新增单测覆盖「合并非叶子节点」 |

**未修（按严重度，留给下一轮）**：

| # | 问题 | 影响 |
|---|---|---|
| P1-4 | 热清单每次 digest 变化就**追加**一条新的 user 消息，旧的不替换 | 真实会话已累积 131 条 / 508,308 字符（约 20 万 token）· **已缓解**：两次注入至少隔 40 事件（约 20 轮），注入条数压到 1/20；彻底修法需要替换 surface 上的旧消息 |
| P1-5 | `renderMd` 对每个节点做全边扫描（O(N×E)），且 `#flush` 无条件渲染 | 10000 边 15.8s；`{md:true}` 参数没被 `#flush` 接收 |
| P1-6 | 热清单只用 root 节点的约束，后续 user 消息的约束丢失 | `renderFacts` 里有、ledger 里没有 |
| P1-7 | 测试计数正则对只读工具也生效；EXIT_RE 取正文第一处匹配 | `read` 到 "all tests passed" 判 success |
| P1-8 | facts 无范围限制，摘要体积随**全局**失败数增长 | live fold 摘要已 13,953 字符；再涨会触发官方「summary 不小于被遮蔽内容」使 fold 永久失败 |
| P1-9 | 指令同时要求「每条失败边都出现」和「<1200 字符」 | >15 条死路时不可满足 |
| P1-10 | `backfillState` 在 `compactRegion` 之前，失败不回滚 | 图被改写但 foldCount 不变 · **已修**：fold 前 `toJSON` 快照，range===null / result===null / compactRegion 抛错三条路径都 `Object.assign(g, fromJSON(snapshot))` 恢复 |
| P1-11 | `validate()` 运行期从不调用 | 115 条悬空边无人发现 |
| P1-12 | 置换命中信息被 keeper 丢弃，`renderTranspositionWarning` 无调用点 | 计划表判据「热上下文出现回到节点 N」未实现 |
| P2-13/14/15 | L4 不看预算；约束不截断；`_chessActiveRange` 在 `/compact` 路径为 null；`llm` 模式仍带 facts | P2-13 **已修**（加 L5 兜底）；P2-15 **已修**（README 表述改为「不降级到规则摘要，仍带硬事实」）；P2-14 **已修**（覆盖 `compactRegion` 在事务入口设置 `_chessActiveRange`、finally 恢复 prev，支持嵌套） |

**当前状态**：81 项单测全绿（修完 3 个 P0 后）。
