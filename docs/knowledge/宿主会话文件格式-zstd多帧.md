# 宿主会话文件是**多帧 zstd**，离线 grep 不到内容 · **已核实（有限）**

> 证据：本机 `home/sessions/<workspace>/<session>/session.v4.jsonl.zstd` 实测（2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 实测事实（**已核实**）

| 观察 | 数据 |
|---|---|
| 文件形态 | `session.v4.jsonl.zstd`，单个会话 **13,756,109 字节** |
| zstd magic（`28 b5 2f fd`）出现次数 | **9,193 次** ⇒ 是**多帧拼接**（每帧一段 jsonl） |
| `zlib.zstdDecompressSync(buf)` | 只解出 **232 字节**（第一帧），不报错 ⇒ **看起来成功，其实只拿到开头** |
| `zlib.createZstdDecompress()` 流式 | **`Error: Unknown frame descriptor`** ⇒ Node 的解码器不接受这种拼接 |
| 直接 `grep '<chess-ledger>'` | 0 命中（压缩过，当然搜不到） |

## 2. 为什么值得记下来（**已核实**：差点白跑一轮）

想验证"热清单是**替换**还是**追加**"，第一反应是去会话文件里数 `<chess-ledger>` 出现次数。
这条路**走不通**，而且**静默走不通**：
`zstdDecompressSync` 返回 232 字节、不抛错 —— 如果只看"解压成功"就往里搜，会得到"0 份清单"，得出错误结论。

## 3. 正确做法（**已核实**）

- 注入行为（replace vs append）**已经有行为测试**：`test/hot-inject.test.mjs` 的
  「契约①：surface 只留一条 —— 第二次注入走 replace，节点数不增长」；
- 需要看真实会话内容时，只能依赖宿主自己的接口（面板/日志），**不要离线解析这个文件**。

## 4. 还没弄清的（**待核实**）

- 多帧是怎么切分的（是否有长度前缀/索引文件）—— 摸清了才能写只读解析器；
- 是否所有会话都用同一格式（样本只查了 1 个会话）。

> **来源（补记 C436）**：本机 `DSH_HOME` 下的 `home/sessions/<workspace>/<session>/session.v4.jsonl.zstd`（本机实测）。
