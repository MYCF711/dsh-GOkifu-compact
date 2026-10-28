# P0：思考死循环的根因与修复方案

> 2026-10-28 · 依据：`session-5acafe42`（打造最强上下文压缩插件，13 个子智能体）实机日志 + 全量会话扫描
> 状态：**已实施，验证通过，等待重启生效**。补丁：`docs/P0-worldhash-死循环修复.patch`
> （对 HEAD 干净应用；已落地到工作区）。验证记录与复跑命令见 **`evidence/P0-worldhash-修复验证.md`**。

---

## 一、结论（一句话）

**不是平台错误，也不是「记忆内容」直接导致。**
是 `dsh-gokifu-compact` 的 **worldHash 类型 bug 让压缩 98.7% 失败** → 上下文只增不减 → 涨到 48 万 token 后 `deepseek-v4.1-flash` 的 reasoning 开始退化自我重复 → 被 magpie 的「Stop looping replies」检测器中断。

三个层次，缺一不可：

| 层 | 事实 | 角色 |
|---|---|---|
| 1. 压缩后端坏了 | `worldHash` 存成对象，`renderFacts()` 调 `.slice()` 抛 TypeError；226 次压缩只有 3 次成功 | **根因** |
| 2. 上下文涨到 48 万+ | 压缩不生效，历史只增不减；模型每轮还往历史里写「做。」「一次调用。」 | **条件** |
| 3. 模型 reasoning 退化 | 最后 256 行/句只来自同 15~24 句，被 magpie 判循环并中断 | **结果（不是原因）** |

---

## 二、证据链

### 2.1 循环只发生在超长上下文，且只在 deepseek-v4.1-flash 上

- 扫描 `%DSH_HOME%/sessions` 下 **241 个 >200KB 的会话**（共 568 个会话文件）。其余 327 个文件太小，物理上装不下 48 万 token 上下文。
- 有死循环的会话：**2 个，共 36 次**。
- 循环发生时的上下文：**≥ 486,320 token**（两个会话分别是 486K~507K 和 579K~660K）。
- 239 个会话 **0 次**。
- magpie `usage.jsonl`（17,318 条请求）里 34 条 `stuck in a loop`，**全部**是 `deepseek-v4.1-flash`（31 条）与 `sn-deepseek-v4-1-flash-1017`（5 条，同一模型换渠道名）。其他模型 0 条。

### 2.2 故障会话 session-5acafe42 的实况

| 指标 | 数值 |
|---|---|
| 循环次数 | **34 次**（turn 45~56） |
| 循环时上下文 | 579,673 → 660,029 token |
| 会话峰值上下文 | 672,392 token |
| compaction 启动 | **226 次** |
| compaction 成功 | **3 次（1.3%）** |
| compaction 失败 | **223 次（98.7%）** |

失败原因分布（本会话）：

| 次数 | 错误原文 |
|---:|---|
| **139** | `latest?.worldHash?.slice is not a function` |
| 80 | `chess-context: summarization truncated at the token cap (incomplete record)` |
| 2 | `chess-context: summarization produced no text summary content` |
| 1 | `terminated` |
| 1 | `Connection error.` |

> 全库 29 个有压缩记录的会话合计：497 次压缩 / 成功 177 / 失败 320（64.4%）。其中 `latest?.worldHash?.slice is not a function` **187 次**，是第一名。

### 2.3 类型 bug 的直接证据

`session-5acafe42/graph.json`（444,391 字节）：

- agent 节点 **211 个**
- `worldHash` 是对象 `{hash, mode, files}` 的：**206 个（97.6%）**
- 示例 `n270`：
  ```json
  "worldHash": {
    "hash": "94263eea74f4b09848acaf52ea1d5e68bdb34942830b9c094ba1c7a8775c9ebd",
    "mode": "stat",
    "files": 21
  }
  ```

全库 23 个棋谱：

- agent 节点 **1,440 个**（2026-10-29 00:0x 快照；会话仍在写入，数字会增长）
- `worldHash` 为对象：**1,141 个（79.2%）**
- **19 / 23 个会话的 latest 节点就是对象** ⇒ 这些会话下一次 fold 必炸。

### 2.4 代码级根因（逐跳）

```text
src/worldstate.mjs:44      hash() 返回 { hash, mode, files }        ← 设计如此（带元数据）
        ↓
src/engine.mjs:171         st.worldHashOf = () => st.world.hash()   ← 把对象原样返回
        ↓
src/keeper.mjs:161         worldHash: state.worldHashOf()            ← 对象直接写进节点
        ↓
src/graph.mjs:87          addAgentNode() 不校验类型                  ← 对象进 graph.json
        ↓
src/ledger.mjs:281         latest?.worldHash?.slice(0, 12)           ← 对象没有 .slice
        ↓
renderFacts() 在 summarize() 前调用 → 抛 TypeError → compactRegion 事务回滚
        ↓
上下文无法压缩 → 一路涨到 66 万 token → 模型 reasoning 退化 → magpie 中断
```

**为什么单测没抓到**：`test/core.test.mjs` 里所有 `addAgentNode` 调用都传 `worldHash: "W1"`（字符串假数据），从未覆盖 `worldstate.hash()` 返回对象的真实路径。**假数据的类型比真实数据干净，把契约不一致藏住了。**

### 2.5 第二处 bug（同一补丁修）

`st.constraints` 从未被赋值 ⇒ `constraintHashOf()` 恒返回 `"pending"` ⇒ `addAgentNode` 的 `pending` 判定始终为 true ⇒ `stateIndex` 永不建立。

补丁按**时序累积**回填历史节点的 `constraintHash`（节点创建时只看到它之前所有 user 节点的约束），与运行期语义一致；不是统一塞一个全量哈希。

- 全库 stateIndex 条目：**5 条**
- 全库 agent 节点：**1,440 个**
- ⇒ **置换检测形同虚设**（这是插件的核心卖点之一）

### 2.6 为什么「记忆越长越容易出现」

准确说：**上下文越长越容易出现**。记忆块本身占得很少 —— 该会话只注入 3 次，每次 7,300 字符，共 21,900 字符（约 660K 上下文的 3.3%）。真正的问题是：

1. **上下文只增不减**（压缩坏了）；
2. **模型自己往历史里写低信息行**，形成正反馈：

| turn 区间 | 每轮 reasoning 里「做。」平均次数 |
|---|---:|
| 1 ~ 14 | 0 ~ 2 |
| 39 | 10 |
| 43 | 13 |
| **45（第一次循环）** | **32** |
| 47 ~ 56 | 74 ~ 129 |

每轮写下的「做。」「一次调用。」「时间 05:10。」会被写回历史；下一轮模型读到自己的历史，更倾向同样格式 —— 单调上升，直到最后 256 行里只剩 15~24 个不同句子，触发 magpie 的检测（256 行 / 20 句阈值，重复率 >92%）。

> 所以「记忆越长越容易出现」的体感是对的，但变量是**总上下文长度**，不是记忆块的内容。记忆只是上下文的一部分（3.3%）。

### 2.7 为什么「各供应商都有，WB 最严重」

- 循环全部落在 `deepseek-v4.1-flash` 这一个模型上；各「供应商」只是同一个模型的不同转发渠道。
- 按绝对数：WorkBuddy 21 次最多 —— 因为它的流量最大（5,819 / 17,318 次请求 = 33.6%）。
- 按比率：

| provider | 循环 / 总请求 | 比率 |
|---|---:|---:|
| magicrew-intl | 1 / 125 | 0.80% |
| magicrew | 7 / 1,612 | 0.43% |
| **workbuddy** | **21 / 5,819** | **0.36%** |
| officeace | 2 / 772 | 0.26% |
| raccoon | 5 / 3,508 | 0.14% |

- 该会话实际响应模型：workbuddy 381 次、magicrew 228、raccoon 34、magicrew-intl 10 —— WB 占 58.8%，所以它的循环数最多。**不是 WB 更差，是它扛的活最多。**

---

## 三、修复方案

### P0-A：worldHash 类型契约（本次事故的直接原因）

补丁：`docs/P0-worldhash-死循环修复.patch`

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/engine.mjs:171` | `worldHashOf()` 返回 `world.hash()` 的 `.hash` 字符串；兼容 `string / {hash} / pending` |
| 2 | `src/engine.mjs:172` | `constraintHashOf()` 改为 `hashSet(collectConstraintText(g))`（修 `st.constraints` 从未赋值） |
| 3 | `src/graph.mjs` | 新增 `hashText()`；`addAgentNode()` 入口归一化；`fromJSON()` 加载边界自动修复历史数据（对象→字符串、回填 pending `constraintHash`）+ **无条件**重建 `stateIndex`（免手工迁移 23 个会话） |
| 4 | `src/ledger.mjs:281` | 新增 `shortHash()` 防御层：字符串 / 对象都安全，不再 `.slice()` 裸调用 |
| 5 | `test/worldhash.test.mjs` | 6 个回归测试：`hashText` / `addAgentNode` / `fromJSON` 脏数据 / `fromJSON` pending constraintHash 回填 / **字段干净但索引脏也要重建** / `renderFacts` 防御 |
| 6 | `test/engine-harness.test.mjs` | **端到端回归**：磁盘上的旧 `graph.json` → `#graph()` → `fromJSON()` → `summarize()` → `renderFacts()` 不抛错，且硬事实块带着失败边进了 prompt；事件落账用例追加「哈希必须是字符串 + `stateIndex` 必须建立」断言 |
| 7 | `test/verify-graphs.mjs` | 全库健康检查工具（只读；对象残留 / `renderFacts` 抛错 / 解析失败 → 退出码 1） |

**实施时相对原方案的两处加强**（都是查出来的）：

- **索引无条件重建**：原方案只在「修过字段」时重建，但 `stateIndex` 是派生数据 ——
  现场存在「字段已是字符串、索引却是脏 key 或空」的图，按「改过字段」判断会漏掉。改后 5 → **185 条**。
- **补端到端回归**：原 5 个测试都是纯函数 + 字符串假数据，而这次事故的教训正是「假数据比真实数据干净」。
  新测试直接喂**磁盘上的旧图**，走完整链路（变异自检：把两层修复同时回滚，该测试变红）。

**实施后的实测（本轮，最终代码）**：

- `node test/run.mjs` → **94 passed, 0 failed**（原 87 + 新增 7）
- `node test/verify-install.mjs` → 13/13 全过
- `node test/real-modules.mjs` → 4/4 全过；`node test/real-fold.mjs` → 5/5 全过
- 真实故障图回放：206 个对象 → `fromJSON` 后 **0 个**；`renderFacts` 正常输出 39,336 字符；重新序列化 0 残留
- 全库 23 个棋谱回放（`node test/verify-graphs.mjs`）：1578 个 agent 节点、对象 worldHash **1279 → 0**、
  `stateIndex` **5 → 185 条**、`renderFacts`/`renderLedger` 全部不抛错、退出码 0
- 变异自检：两层修复同时回滚 → 端到端回归**变红**（错误与实机同形）；只回滚 `fromJSON` 归一化 → 也变红
- 真实日志独立核对：`session-5acafe42` 里 `compaction/start`/`end` 各 **226** 次、`error` **223** 次、
  其中 `latest?.worldHash?.slice is not a function` **139** 次 —— 与上面 §2.2 的分布逐项一致

### P0-B：部署生效（必须重启）

- 插件代码在 DSH 启动时加载，**热改不生效**。
- `fromJSON` 会在下次启动加载棋谱时自动修复历史数据；下一次 `#flush` 就会把干净数据写回磁盘。
- 无需手工迁移 23 个 graph.json。

### P1：压缩阈值（建议同批改，可单独决定）

当前 `profiles/desktop/cordis.patch.yml` 的 `preset-standard` 里：

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.6     # 1,000,000 × 0.6 = 600,000 token 才触发
```

但实测模型在 **48 万 token** 就开始退化。建议改成 `0.4`（40 万触发）或 `0.35`，留出安全边际。

**为什么 P0 修完还不够**：本会话 34 次循环里最早一次发生在 **579,673 token**，而阈值是 600,000 ——
**压缩还没轮到触发，模型已经开始退化**。修好压缩只能保证 600K 之后能降下来；600K 之前仍有
约 2 万 token 的暴露窗口，而且下一个长会话会重演。把阈值降到 0.4 是把「退化区」整个挡在触发点之外。

**精确改动点**：`cordis.patch.yml:489` 的 `thresholdRatio: 0.6`（该文件里只有这一处实际生效；
330/333/415 行是注释说明，需同步改文字）。改前先备份：`cp -a cordis.patch.yml cordis.patch.yml.bak-before-threshold-<ts>`。

> 注意：改这里必须整份重写 `preset-standard` 的 `config.plugins`（profile 里已有注释说明为什么按 id 打不中）。属于 profile 级改动，需先备份 `cordis.patch.yml`。

### P2：验收清单

- [x] `node test/run.mjs` 94 passed / 0 failed
- [x] `node test/verify-install.mjs` 全过
- [x] `node test/real-modules.mjs` 4/4、`node test/real-fold.mjs` 5/5
- [x] `node test/verify-graphs.mjs` 全库回放：对象 worldHash 1279 → 0，退出码 0
- [ ] **重启 DSH**（唯一未做项 —— 不允许中断主人正在用的实例）
- [ ] 重启后重跑 `node test/verify-graphs.mjs`：对象 0 残留；`stateIndex` 只增不减
- [ ] 重启后新会话：`graph.json` 里 `worldHash` 全部字符串；`stateIndex` 随 step/end 增长
- [ ] 触发一次压缩，`compaction/end` 无 `worldHash` 错误
- [ ] 观察一轮长会话：reasoning 里「做。」密度不再单调上升

---

## 四、影响面

| 项 | 数值 |
|---|---|
| 全库棋谱会话 | 23 个（2026-10-29 00:2x 快照，会话仍在写入） |
| 受影响（存在对象 worldHash） | 19 个（latest 节点就是对象的） |
| 受影响 agent 节点 | **1279 / 1578（81.1%）** |
| 已发生的压缩失败（本会话） | 226 次尝试 / 223 次失败，其中 139 次是本 bug |
| 已发生的死循环（magpie 全库） | 37 次，全部落在 `deepseek-v4.1-flash`（32）与同模型换渠道名（5） |

---

## 五、不做的事（避免过度修复）

1. **不关 magpie 的 `Stop looping replies`** —— 它是最后一道防线，救过这次 34 次。
2. **不改 `dsh-compaction-basic` 官方包** —— 按项目规范，只覆盖策略层。
3. **不手工改运行中的 graph.json** —— `#flush` 会覆盖；统一走 `fromJSON` 加载边界修复。
4. **不重算历史节点的 `worldHash`** —— `fromJSON` 只把对象收敛成字符串（取 `.hash`），保留当时
   stat 出来的真实哈希，不用今天的文件状态覆盖历史。对 `constraintHash === "pending"` 的节点，
   按 `order` 时序累积回填（节点创建时只能看到它之前的约束）—— 这是为了把 `stateIndex` 建起来，
   语义与运行期 `constraintHashOf` 一致；已知缺口是「历史约束文本与当时状态未必严格对应」。
5. **不动 `preset-standard` 的压缩阈值（P1）** —— 那是另一个 preset 的 profile 级配置，
   不在本插件修复范围；要不要把 `thresholdRatio: 0.6` 降到 0.4 由主人决定（改动点见 P1 节）。
