# 快速开始 · dsh-GOkifu-compact

> 给「已经装好，现在要用」的人。安装/回滚细节见 [README](README.md)。
>
> **安装只有一步**：插件市场点「安装」，或 `dsh plugin --profile <p> add dsh-gokifu-compact`，
> 然后重启 DSH。**装好重启即可，不需要去设置里选任何模式** —— 本包的 bundle patch 会按 id
> 整体覆盖 DSH 内置的四个 agent preset（标准 / PTC / 极简 / 创造），把它们的压缩引擎
> `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine`。所以四个模式**都是**棋谱压缩。
> 也不会多出一个叫 `gokifu` 的模式（1.16 起不再新增 preset）。
> **不要再单独装 `dsh-gokifu-preset`**（1.15.x 的旧版做法；两个都装会导致同名 preset 重复）。

## 一 · 重启后先做这四步（3 分钟）

### 1. 确认插件已加载

```bash
cd "<workspace>"
node test/verify-install.mjs
```

期望：**逐项列表里只有「运行期已产出棋谱」可能在首次启动后短暂为红**（还没有会话跑过 compression），
其余全绿；跑过一个会话后应当**全部通过**（脚本会打印「全部通过」并给出项数，不在此处写死数字 —— 检查项会随版本增加）。
（S10a 起「依赖声明的 link 目标」是真检查：解析后的目录必须存在、包名必须是本包、node_modules 实际指向要一致 —— 以前只查字符串前缀，目标不存在也报 ✓）
其中「运行期已产出棋谱」那条的 mtime 应该是**刚刚**（说明 keeper 在工作）。

### 2. 看一次真实会话的棋谱

```bash
ls -lt "<workspace> Harness/home/chess-context/sessions" | head -3
```

挑最新那个目录，看 `graph.json`：

```bash
node -e "const g=require('<workspace> Harness/home/chess-context/sessions/<目录>/graph.json'); console.log('节点',Object.keys(g.nodes).length,'边',Object.keys(g.edges).length,'fold',g.foldCount)"
```

期望：节点数 > 0、边数 > 0。

### 3. 确认热上下文真的在注入

新开一个会话，随便让 agent 做点带工具调用的事，然后看它的 system 消息里有没有 `<chess-ledger>`。

或者直接看当前会话的 `graph.json` 是否在增长（每步都会更新）。

### 4. 确认四个模式都换成了棋谱引擎

看组合出来的树里，每个内置 preset 的 compaction group 是不是我们的引擎：

```bash
dsh --profile <p> --dump-config | grep -E "^- id: preset-|gokifu-compact/engine"
```

期望：`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 四行都出现，
且每行下面各有一个 `name: dsh-gokifu-compact/engine`。

更省事的判据：**随便选一个模式开会话，发一条消息，看 `<DSH_HOME>/chess-context/sessions/<id>/graph.json`
有没有出现** —— 官方压缩不会产生这个目录。

- 只出现部分 preset ⇒ 宿主版本变了（preset 文件形状变了），重跑
  `node scripts/make-presets-override.mjs` 看哪一步报错（生成器有自检，不会产出坏文件）；
- 一个都没有 ⇒ 本包没进 `dsh.profile.bundles`，或 profile 里还留着旧手工行（两条通道只能二选一）。

## 二 · 日常怎么用

**你不需要做任何事。**（选标准模式、PTC、极简、创造都一样。）插件挂在 `compaction` 槽位上，行为是：

| 时机 | 它做什么 |
|---|---|
| 每一步 | 把 `<chess-ledger>`（根目标 + 约束 + 已探明死路清单）注入到 model 的输入里 |
| 每个工具结果 | 判定 success / failure / unverified，失败原因进棋谱 |
| 上下文到 45% | 自动 fold：把旧历史压成棋谱摘要，保留失败边与约束 |
| 你手动 `/compact` | 走同一条棋谱路径（不是官方的 8 段模板） |

**判断它有没有在工作**：看 `graph.json` 的 `foldCount` 和 `updatedAt`。

## 三 · 配置（`cordis.patch.yml` 里）

```yaml
dsh-gokifu-compact:
  thresholdRatio: 0.45        # 压力闸：上下文用到 45% 就 fold
  retainRatio: 0.1            # fold 后保留最近 10% 的对话
  minFoldTokens: 8000         # 小于这个量不值得 fold
  growthFloorTokens: 20000    # 距上次 fold 增长不足 20K 就不再 fold（省钱）
  hotLedgerMaxTokens: 500     # 热上下文预算（硬上限，超了自动降级）
  summaryMode: hybrid         # rules / llm / hybrid
  tier2After: 5               # 攒够 5 个 checkpoint 后合并一次
```

**最常调的两个**：
- `hotLedgerMaxTokens`：觉得热上下文太长就调小（默认 500）
- `thresholdRatio`：想更早压缩就调小（0.35），想少压就调大（0.6）

## 四 · 出问题怎么办

### 插件没加载 / 会话报 compaction 冲突

```bash
node test/verify-install.mjs   # 看哪一项红
```

最常见：preset 里 `compaction-basic` 没被 disable（单实例规则）。

### 想退回官方压缩

```bash
node test/rollback.mjs
```

它恢复三样：preset 的 `cordis.patch.yml`、profile 的 `package.json`、删除 node_modules 里的 junction。
**不动** `<DSH_HOME>/chess-context/` 下的图数据（重新装回来还能接着用）。

### 棋谱数据坏了

`graph.json` 解析失败时，插件会**自动重建空图**（不崩），但会丢历史。
想保留现场就先复制一份再重启。

### 某个模式好像没走棋谱压缩

本插件只覆盖**四个官方 preset**（标准 / PTC / 极简 / 创造）。第三方插件自带的 preset
（例如 `dsh-design-studio` 的「设计模式」）可能在它自己的 bundle patch 里重新声明 `compaction-basic`
—— 那个模式下就是原生压缩。强覆盖别人的 preset 属越权、且会被对方升级冲掉，所以本插件**只登记不覆盖**：
`node scripts/doctor.mjs` 的「第三方 preset 的压缩后端（C94）」会点名是哪个 preset。

### 装完别的插件后设置页 / 「上下文压缩」页面不见了

多半是 bundle patch 的 `insert` **id 撞车**：宿主按 id 建索引，后写的替换先写的。
`doctor` 的「insert id 唯一性（C96）」在撞到本插件 `gokifu-ui` 时会直接报 **error**；
两个插件抢同一个 preset 则由「preset 覆盖唯一性（C95）」报 warn。

### `doctor` 说「运行实例版本」不一致

说明磁盘代码已更新、但进程还是旧的（本插件用 `link:` 安装）。重启 DSH 后跑一条命令核对：

```bash
node scripts/post-restart-check.mjs   # 期望全 ✓：buildId 一致 + 归因字段出现 + doctor 0 错 + boundary 0 条
```

### fold 一直不触发

三个原因，按顺序查：
1. 上下文没到 `thresholdRatio`（默认 45%）
2. `growthFloorTokens` 拦住了（距上次 fold 增长 < 20K）
3. `resolveModelInfo` 拿不到 contextWindow（看日志有没有 `no context capacity`）

## 五 · 想验证它「真的比官方强」

```bash
node test/real-model.mjs        # 对照实验：本插件 8/8 vs 官方模板 4.67/8
node test/real-e2e.mjs          # 真实 bash 失败 → 压缩 → 续跑 3/3
node test/replay-verify.mjs     # 用你当前会话的真实日志回放，看修复前后差异
```

三个都调真实模型（走 magpie 网关），会花 token 但不多（每次 2–4K）。

## 六 · 目录在哪

| 东西 | 路径 |
|---|---|
| 插件源码 | `<workspace>` |
| 棋谱数据 | `<DSH_HOME>\chess-context\sessions\<sessionId>\graph.json` |
| 人读视图 | 同目录 `graph.md`（只在 idle / fold 后更新） |
| 证据 | 项目 `evidence/`（13 个文件，每个 .md + .json） |

## 七 · 一句话原理

普通压缩是「把历史缩成一段摘要」，摘要会丢细节、而且每次压缩都把上次摘要再摘要一遍（几何衰减）。

棋谱是「把历史存成一张带失败记忆的图」+「每步只给模型看一张极小的索引」：
- **失败边**由规则从工具结果里判，不靠模型总结
- **约束**由规则逐字保留，不经过模型
- **摘要**只在 fold 时生成一次，且只压上一个 checkpoint 之后的内容（增量）
