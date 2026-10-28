# 三态标签 A/B 实验（子代理，2026-10-28）

> 目的：验证 `blocked` / `dead` / `failed` 三态标签是否真的改变模型行为

## 实验设计

同一场景（修构建 bug），两个版本的热清单：

**A（带三态标签）**：
```
WORKING: user → n2 (exit 0)
LEARNED (3 failed attempts):
- e1 "直接改 prod 配置" → EACCES [blocked:permission revisit_if=permission changes]
- e2 "删掉 node_modules 重装" → 权限不足 [blocked:permission revisit_if=permission changes]
- e3 "绕过 lint 直接构建" → CI 拒绝 [failed:retryability unknown]
```

**B（不带标签）**：
```
WORKING: user → n2 (exit 0)
LEARNED (3 failed attempts):
- e1 "直接改 prod 配置" → EACCES
- e2 "删掉 node_modules 重装" → 权限不足
- e3 "绕过 lint 直接构建" → CI 拒绝
```

## 结果

### 首次选择：**相同**

两版都选 `n2`（WORKING 行是唯一带成功证据的）。

### 失败之后：**不同**

| 维度 | A（三态） | B（无标签） |
|---|---|---|
| **跳过 vs 重试** | `blocked + revisit_if` 是硬约束，权限不变不重试 | 平铺的「失败过一次」，n2 不成后可能又去重试删 node_modules |
| **可区分性** | `blocked`（环境不允许）vs `failed`（方法问题）分层 | 压成同一形状，反推错就把「改个路径就能修」当「权限死路」扔掉 |
| **重开能力** | `revisit_if` 是机器可判的触发条件，权限一变自动重新激活 | 没这个钩子，几天后只记得「上次失败了」 |

**子代理原话**：

> A 与 B 在首次选择上碰巧一致，在「失败后是否浪费轮次、能否正确归因」上 A 严格更优。

### 只能留一个词：`blocked`

> `dead` 是终局，`blocked` 是条件态。目标是「把构建跑通」，而权限恰好是外部可变的（换账号/提权/换 runner），标 `dead` 等于把可恢复路径永久判死，将来权限开了也不会回头看。

## 边界（子代理指出）

> 若失败原因是「这条路径在设计上就不存在」（仓库本无 staging 配置），`dead` 才对；`blocked` 只适用于「路径存在、当前环境挡住」。

**对应 `failureClass` 的实现**：

| 错误 | 判定 | 是否可能误判 |
|---|---|---|
| `EACCES` / `EPERM` | `blocked:permission` | 低（权限确实是外部可变） |
| `ENOENT` / `not found` | `blocked:missing-resource` | **中**（文件可能本来就不该存在） |
| `ETIMEDOUT` | `blocked:timeout` | 低 |
| `ECONNREFUSED` | `blocked:unreachable` | 低 |
| 有成功路径且不经过它 | `dead` | 低（有证据） |
| 其余 | `failed` | — |

**`ENOENT` 的保守处理**：保持 `blocked`（文件可能被创建），`revisit_if=resource appears` 已说明条件。真要判 `dead` 需要「设计上不存在」的证据，规则拿不到。

## 结论

1. **三态设计有效** —— 差别不在首次选择，在**失败后的归因与重试策略**
2. **`blocked` 比 `dead` 更有用** —— 可重启 > 终局
3. **`failed` 不能省** —— 「可重试性未知」是诚实的中间态
4. **`revisit_if` 是给下一轮 agent 的自动触发器**，不是给人看的备注
