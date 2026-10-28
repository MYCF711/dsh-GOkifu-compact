# 快速开始 · DSH-GOkifu-compact

> 给「已经装好，现在要用」的人。安装/回滚细节见 [README](../README.md)。

## 一 · 重启后先做这三步（3 分钟）

### 1. 确认插件已加载

```bash
cd D:/主工作区/projects/dsh-gokifu-compact
node test/verify-install.mjs
```

期望：**13 项全过**，最后一行 `== 全部通过 ==`。
其中「运行期已产出棋谱」那条的 mtime 应该是**刚刚**（说明 keeper 在工作）。

### 2. 看一次真实会话的棋谱

```bash
ls -lt "D:/DeepSeek Harness/home/chess-context/sessions" | head -3
```

挑最新那个目录，看 `graph.json`：

```bash
node -e "const g=require('D:/DeepSeek Harness/home/chess-context/sessions/<目录>/graph.json'); console.log('节点',Object.keys(g.nodes).length,'边',Object.keys(g.edges).length,'fold',g.foldCount)"
```

期望：节点数 > 0、边数 > 0。

### 3. 确认热上下文真的在注入

新开一个会话，随便让 agent 做点带工具调用的事，然后看它的 system 消息里有没有 `<chess-ledger>`。

或者直接看当前会话的 `graph.json` 是否在增长（每步都会更新）。

## 二 · 日常怎么用

**你不需要做任何事。** 插件挂在 `compaction` 槽位上，行为是：

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
| 插件源码 | `D:\主工作区\projects\dsh-gokifu-compact` |
| 棋谱数据 | `<DSH_HOME>\chess-context\sessions\<sessionId>\graph.json` |
| 人读视图 | 同目录 `graph.md`（只在 idle / fold 后更新） |
| 证据 | 项目 `evidence/`（13 个文件，每个 .md + .json） |

## 七 · 一句话原理

普通压缩是「把历史缩成一段摘要」，摘要会丢细节、而且每次压缩都把上次摘要再摘要一遍（几何衰减）。

棋谱是「把历史存成一张带失败记忆的图」+「每步只给模型看一张极小的索引」：
- **失败边**由规则从工具结果里判，不靠模型总结
- **约束**由规则逐字保留，不经过模型
- **摘要**只在 fold 时生成一次，且只压上一个 checkpoint 之后的内容（增量）
