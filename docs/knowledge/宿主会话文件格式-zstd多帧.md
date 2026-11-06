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

## 3. 正确做法（**已核实**，C359 起）

- **多帧切分已解决**：按 zstd magic（`28 B5 2F FD`）切帧、逐帧 `zstdDecompressSync` ——
  实现在 `scripts/session-scan.mjs` 的 `decodeMultiFrameZstd()`，实测一个 35.7 MB 的会话文件
  解出 **25,718 行 JSONL / 3,369 条 assistant 消息**，切错的帧跳过、不抛。
- 注入行为（replace vs append）仍然**靠行为测试**，不要靠 grep：
  `test/hot-inject.test.mjs` 的「契约①：surface 只留一条 —— 第二次注入走 replace」
  （C358 曾用 grep 数 `<chess-ledger>`，几乎全是假阳性 —— 模型自己也会写出这个字面量）。

## 4. `assistant/message` 到底有什么（**已核实**，C447 实测）

> 样本：`<SESSION_ID>-…`（本机，35.7 MB，25,718 行）

| 块类型 | 出现次数 |
|---|---|
| `tool-call` | 3,208 |
| `reasoning` | 1,606 |
| `text` | **227** |

- **3,369 条 assistant 消息里 3,142 条（93.3%）没有 `text` 块**；有 text 的中位长度 904 字。
- 直接后果：任何"从 assistant 文本抽意图/目标"的逻辑，覆盖率天然只有个位数百分比。
  对得上棋谱里的事实 —— 19,375 个 agent 节点只有 **62 个（0.3%）** 有 `goal`；
  21,163 条边只有 **101 条（0.5%）** 有 `intent`。
- ⇒ 热清单里的 `CURRENT GOAL` 这行原本**几乎从不出现**（它取 `latest.goal`）。
  **C448 已修**：goal 为空时回落到「最近一条 user 原话」（且不能是根，否则与 ROOT 重复）。
  实测覆盖率 **0.3% → 78%（29/37 会话）**，代价 **+255 tokens / 37 个会话（+1.6%）**。
- **C449 再修一层（内容质量）**：真实多轮会话里「最新一条 user 消息」长度**中位只有 12 字**，
  最短的一批是 `继续`×3 / `go` / `修一下` / `都是0` / `我重启好了`×2。
  把「继续」渲染成 `CURRENT GOAL: 继续` 会让模型以为当前目标就是"继续" ⇒ 加 `isInformativeAsk()` 过滤：
  纯接续/确认词（继续、go、ok、好的…）与 ≤2 字碎片不渲染。覆盖率 **78% → 68%**，但内容有信息量。
  没去更早的消息里找一条有信息量的：那条**多半已经做完了**，写成目标会把模型拽回去重做。
- 为什么**没有**选 `reasoning` 当数据源：实测 1,618 条推理块，**首句是背景分析**
  （"The user is asking me to..."，与 ROOT 重复），**末句是下一步动作**（"Let me read the code."，
  与 WORKING/action 重复）⇒ 抽出来是**冗余**，不值得每条边多存 60 字符。

## 5. 还没弄清的（**待核实**）

- `reasoning` 块的文本结构（是否分段、多长）—— 决定"从推理里抽一句意图"是否划算；
- 是否所有会话比例都类似（目前只统计了最大的 1 个会话）。

> **来源（补记 C436）**：本机 `DSH_HOME` 下的 `home/sessions/<workspace>/<session>/session.v4.jsonl.zstd`（本机实测）。
