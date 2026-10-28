# P0（worldHash 类型契约）修复验证

> 2026-10-28/29 · 对应 `docs/P0-worldhash-死循环-根因与修复方案.md`
> 状态：**代码已实施并验证通过；等待 DSH 重启生效**

---

## 一 · 修复内容（实际落到代码里的）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/engine.mjs` | `st.worldHashOf()` 返回 `world.hash()` 的 `.hash` 字符串（兼容 `string` / `{hash}` / `pending`） |
| 2 | `src/engine.mjs` | `st.constraintHashOf()` 改为 `hashSet(collectConstraintText(g))`（`st.constraints` 从未被赋值 ⇒ 恒 `pending`） |
| 3 | `src/graph.mjs` | 新增 `hashText()`；`addAgentNode()` 入口归一化（对象永不进图）；`fromJSON()` 加载边界修复历史脏数据 + **无条件重建 `stateIndex`** |
| 4 | `src/ledger.mjs` | 新增 `shortHash()`：`renderFacts()` 的 `CURRENT_STATE_KEY` 不再裸调 `.slice()` |
| 5 | `test/worldhash.test.mjs` | 6 项纯函数/边界回归（新增） |
| 6 | `test/engine-harness.test.mjs` | 追加 1 项**端到端回归**（旧磁盘棋谱 → `summarize()` 全链路）+ 事件落账里断言哈希是字符串、`stateIndex` 已建立 |
| 7 | `test/verify-graphs.mjs` | 新增全库健康检查工具（只读，退出码非 0 即不健康） |

比原方案**多做了两件事**（都是查出来的，不是猜的）：

1. **`fromJSON` 改为无条件重建 `stateIndex`**。原方案只在「修过字段」时重建，但索引是派生数据 ——
   现场存在「字段已经是字符串、索引却是脏 key / 空」的图（全库 `stateIndex` 只有 5 条），
   只按「改过字段」判断会把这类图漏掉。重建后 5 → **185 条**，置换检测恢复可用。
2. **补了端到端回归测试**。原方案的 5 个测试都是纯函数、传字符串假数据 —— 而这次事故恰恰是
   「假数据的类型比真实数据干净」造成的（事故文档 §2.4 已指出）。新测试把**磁盘上的旧
   `graph.json`** 喂进真实 `#graph()` → `fromJSON()` → `summarize()` → `renderFacts()` 链路。

---

## 二 · 复跑证据（全部可重跑）

```bash
cd D:/主工作区/projects/dsh-chess-context
node test/run.mjs              # 94 passed, 0 failed（原 87 + 新增 7）
node test/verify-install.mjs   # 13/13 全过
node test/real-modules.mjs     # 4/4 全过（真实 @deepseek-ai 包）
node test/real-fold.mjs        # 5/5 全过（真实 compactRegion 事务）
node test/verify-graphs.mjs    # 23 个会话全健康，退出码 0
```

### 2.1 全库回放（`node test/verify-graphs.mjs`）

```
合计：23 个会话 / 1578 个 agent 节点 / 对象 worldHash 1279 → 0 / stateIndex 5 → 185
== 全部健康 ==
```

- 每个会话的 `renderFacts()` 与 `renderLedger()` 都跑通（抛错 = 压缩 100% 失败，是本次事故的直接形态）
- 重新序列化后**对象残留 0**（磁盘靠插件下次 `#flush` 写回，不需要手工迁移 23 个文件）
- 事故会话 `session-5acafe42`：211 个 agent 节点 / 对象 206 → 0 / `stateIndex` 3 → 49 / `renderFacts` 输出 39,336 字符

### 2.2 旧三层树重建（人读视图也一起治）

事故会话的 `nodes/*.md` 里状态字段是 bug 的残影：`worldHash: [object Obje`、`constraintHash: pending`。

```bash
node test/build-tree.mjs "D:/DeepSeek Harness/home/chess-context/sessions/session-5acafe42-..."
# built 267 nodes
```

- 重建后 `n270.md` 的「状态」段变成 `worldHash: 94263eea74f4` / `constraintHash: 22ac5fe51962`
  —— `94263eea…` 正是事故文档 §2.3 里那个对象字段的 `.hash`，证明修复取的是对象的哈希而不是丢掉它
- 全目录扫描 `object Obje` 残留：**0 个文件**
- **只改了派生文件**（`index.md` + `nodes/*.md`），`graph.json` 一个字节没动 —— 数据层的愈合仍走 `fromJSON` 加载边界

> 其它会话没有写三层树（只有 `graph.json` / `graph.md`），不需要重建；旧会话被重新打开时
> 插件会因 `firstWrite` 自动重写整棵树。

### 2.3 变异自检（证明测试真的抓得住，不是摆设）

| 变异 | 结果 |
|---|---|
| 同时把 `engine.worldHashOf` 与 `addAgentNode` 归一化回滚成旧逻辑 | ✗ 红：`worldHash 不是字符串：{"hash":"2e1cfa82…","mode":"paths","files":0}（object）` |
| 只回滚 `fromJSON` 的归一化 | ✗ 红：`加载后 worldHash 仍是 object` |
| 恢复 | 源文件 sha256 与变异前逐字一致，94 passed |

---

## 三 · 真实日志独立核对（不是转述，是重新数的）

### 3.1 故障会话 `session-5acafe42`（`session.v4.jsonl.zstd`，解压后 20,468,318 字节）

| 项 | 数值 | 数法 |
|---|---:|---|
| `compaction/start` 事件 | **226** | 事件类型计数 |
| `compaction/end` 事件 | **226** | 事件类型计数 |
| 其中带 `error` | **223** | `compaction/end.data.error` 非空 |
| ├ `latest?.worldHash?.slice is not a function` | **139** | 错误原文分组 |
| ├ `summarization truncated at the token cap` | **80** | 同上 |
| ├ `produced no text summary content` | **2** | 同上 |
| ├ `terminated` / `Connection error.` | 1 / 1 | 同上 |
| └ 无错误（成功） | **3** | 226 − 223 |

> 与事故文档 §2.2 的分布**逐项一致**（226 / 3 成功 / 139 / 80 / 2 / 1 / 1）。
> 注：文档里「80」「2」是事件数；若按字符串出现次数数（错误原文会在多处被引用）是 85 和 13 —— 两个数都对，口径不同。

### 3.2 magpie `usage.jsonl`（`C:\Users\Administrator\.config\magpie\usage.jsonl`，10,312,222 字节）

| 项 | 数值 |
|---|---:|
| 总请求 | 17,687 |
| `stuck in a loop` | **37** |
| 全部落在 | `deepseek-v4.1-flash` **32** + `sn-deepseek-v4-1-flash-1017` **5**（同一模型两个渠道名），其他模型 **0** |
| 按供应商 | workbuddy 22 / magicrew 7 / raccoon 5 / officeace 2 / magicrew-intl 1 |

> 事故文档写的是 17,318 / 34 —— 那是写文档时刻的快照，日志之后又长了 369 条请求、3 次循环。**结论不变**：
> 死循环只发生在这一个模型上，且发生在超长上下文（≥ 48 万 token）里。

---

## 四 · 部署状态与重启后验收

**代码改完≠生效**：插件在 DSH 启动时 `import`，进程里已经跑着旧代码 —— 必须重启 DSH。

重启后一条命令验收（只读，不改任何数据）：

```bash
cd D:/主工作区/projects/dsh-chess-context && node test/verify-graphs.mjs
```

判据：

- [ ] `对象 worldHash … → 0`（加载边界已修复全部历史脏数据）
- [ ] `stateIndex` 条目 **只增不减**，且随新会话增长（置换检测真的在记录）
- [ ] 任一**新**会话的 `graph.json` 里 `worldHash` 全是字符串（新代码路径）
- [ ] 触发一次压缩后，`compaction/end` 不再出现 `worldHash?.slice is not a function`
- [ ] 长会话里 reasoning 的「做。」密度不再单调上升（这是模型退化的表征，不是原因）

---

## 五 · 未验证 / 已知缺口（不虚报）

| # | 项 | 说明 |
|---|---|---|
| 1 | **重启本身未做** | 本轮不允许中断主人正在用的实例；重启后请按第四节五条核对 |
| 2 | **历史节点的 `worldHash` 语义** | `fromJSON` 只把对象收敛成字符串（取 `.hash`），**不重算** —— 那些哈希是当时 stat 出来的，语义可信但不新鲜 |
| 3 | **`worldHash` 在 fold 前的回填顺序** | `backfillState()` 只回填 `worldHash === "pending"` 的节点；对象值的节点现在被 `fromJSON` 修成字符串，因此**不会被**再回填（保留了创建时刻的真实哈希）—— 这是有意为之 |
| 4 | **压缩阈值（P1）** | 本插件默认 `thresholdRatio 0.45`（1M 窗口 → 45 万触发），在模型退化点（≈48 万）之前。`preset-standard` 里 `compaction-basic` 的 `0.6` 是另一个 preset 的配置，**不在本次修复范围**（属 profile 级改动，需主人决定） |
