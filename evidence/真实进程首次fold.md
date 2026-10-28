# 真实 DSH 进程里的首次 fold（goal ② 验收）

> 2026-10-29 · 工具：`node test/real-headless-fold.mjs`（可重复跑）
> 这次不是 `real-fold.mjs` 的「假 Session + 真引擎」—— 是**真正的 dsh headless 进程**：真 Session、
> 真 `compactRegion` 事务、真 `session.append` 校验、真 surface 替换。

## 一 · 怎么做到的

1. 给 `profiles/headless` 加一个 **junction**：`profiles/headless/node_modules/dsh-gokifu-compact` →
   `D:\主工作区\projects\dsh-chess-context`（指向仓库本体；实测 `ln -s` 在 Windows 上会**复制**目录，
   必须用 `New-Item -ItemType Junction`，否则测的是旧副本 —— 第一次跑就是这么被骗的）。
2. 用 `--patch` 叠一层临时 overlay：关掉 `compaction-basic` / `compaction-tool-result-pruner`，
   插入 `dsh-gokifu-compact`，把 `thresholdRatio` 压到 0.002（1M 窗口 ⇒ 2000 token 触发）、
   `summaryMode: rules`（不依赖外部模型）。
3. `dsh --profile headless --patch <overlay> --json "<task>"` 跑一个迷你任务，然后从会话日志里核对
   `compaction/start|summary|end` 与 checkpoint 消息。

## 二 · 结果

```
== real-headless-fold：在真实 dsh headless 进程里触发 fold ==
task: 用 node 写一个 1+1 的脚本并运行，把结果告诉我
session: session-f488a7ae-6fc1-4725-a0e1-0031066bdf5d
compaction：成功 3 / 失败 0；checkpoint 消息 3 条
== 全部通过（真实进程 / 真实 Session / 真实 compactRegion） ==
```

另一次手工跑（`session-15bf30bb…`）的细节：**5 次 fold 全成功**，每次都有
`compaction/summary`（`provider=magpie`、`model=group/deepseek-v4.1-flash1017`、shadowed 1,096~2,526 tok）
和一条 `surfaceOp:{op:"replace"}` 的 checkpoint 消息。

## 三 · 这次抓到的真 bug：`summaryMode: rules` 在真实 DSH 里**从未成功过**

第一次 headless 跑：7 次 fold **全部失败**，错误一模一样：

```
session event "compaction/summary" carries non-JSON-serializable data
```

根因：官方 `commitCompactionBody()` 把 `summarize()` 返回的 `provider` / `model` **不判空**地写进
`compaction/summary` 事件。我们的规则摘要（`summaryMode: rules` / 以及「摘要模型全挂」的兜底）只返回
`{summary, rawOutput, llmStreamCall}` —— 于是事件里 `provider: undefined`，真实 `Session.append` 的
JSON 校验直接拒绝。

**为什么之前没发现**：`test/real-fold.mjs` 用的是**假 Session**，不校验 JSON 序列化；而桌面 preset 用
hybrid（模型路径会带 provider/model），所以规则模式从没在真实进程里跑过。

修法：所有 `summarize()` 返回路径都带 `provider` / `model` 字符串（规则摘要没有模型 ⇒ 用当前路由做
记账口径，没有路由就用 `chess-context` / `rules` 哨兵）。已加 harness 断言。

## 四 · 局限

1. 这是**短会话**（阈值压低以触发），不是「用户 GUI 里的长会话」。GUI 长会话的首次自然触发仍要等一次重启；
   但 fold 的机制链路（触发 → 摘要 → 事务 → checkpoint → surface 替换）已经在真实进程里全绿。
2. headless profile 需要手动建 junction（脚本会检查并提示，不会自己改 profile）。
3. `summaryMode: rules` 的摘要质量低于 hybrid（没有模型润色），本测试只验证机制。
