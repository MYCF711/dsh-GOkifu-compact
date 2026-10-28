# fold 触发验证：自动路径 + 真实模型

> 生成于 2026-10-28T07:54:08.545Z　模型：`group/deepseek-v4.1-flash1017`
> 模拟上下文窗口 200000，折叠阈值 90000（45% × 窗口）
>
> 本文件由 `test/write-fold-evidence.mjs` 从同目录 `fold触发验证.json` 生成 —— **md 与 json 必然同源**。

## 为什么单独测这个

`real-fold.mjs` 只证明「给一个范围，compactRegion 能压」，没证明**自动路径会触发**。
阈值判断、增长门（growth gate）、增量范围、溢出自救，全是引擎自己的逻辑；写错就会「永远不 fold」或「每步都 fold」。

## 本次运行结果

| 场景 | 期望 | 实际 |
|---|---|---|
| ① 90000 以下 | 不 fold | 未 fold ✅ |
| ② 超过阈值 | fold + surface 收缩 | 未 fold ❌ |
| ③ 立刻再调（增量 0） | growth gate 拦住 | 被拦住 ✅ |
| ④ 增量足够 | 再次 fold | 未 fold ❌ |
| ⑤ 溢出自救 | 已压干净则 no-op | fold 了（可接受） |

## 判读方式

**这不是一个确定性测试。** 它依赖真实模型（摘要由模型生成），同一天两次运行结果可能不同：
本次与上一次相比，②④ 就出现过一次通过、一次未通过的差异。

- 确定性部分（事务链、范围选择、checkpoint 写入）由 `test/real-fold.mjs` 覆盖，每次都必须全过。
- 本测试证明的是「触发逻辑存在且能在真实模型下走通」，不是「每次都会 fold」。

## 复跑

```bash
node test/real-fold-trigger.mjs   # 写 json
node test/write-fold-evidence.mjs # 从 json 生成 md
```