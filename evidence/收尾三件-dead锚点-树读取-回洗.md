# 本机三件收尾：dead 重开锚点 / 三层树被模型读取 / 历史误报回洗（2026-10-29）

> 对应 goal 当前阶段的 ③④⑤。三件都有可复跑的证据，没有「差不多」。

## ③ `[dead]` 不再是一块永久墓碑：带 `retry-if:<成功边>`

**问题**：`dead` 的语义是「有成功路径不经过它」。但一旦写死成标签，模型会读成**永久**死路 ——
而它的成立依据其实是**某一条**成功边（那条边一旦不通，就该回头重试）。1.1.0 的盲测就指出过这个风险。

**改法**：`dead` 的标记直接从 tewari 的参照点里取锚点（不是猜的 —— `dead` 的定义就是
`same_position` ⇒ `redundantVs` 非空）：

```
- e389 "edit(file_path=/d/主工作…" → Error: cannot edit "/d/主… [dead retry-if:e384+1]
```

图例同步：`dead = a working path avoids it — retry only if retry-if breaks`。
顺带把 `blocked:missing-resource` 的图例从「等它出现」改成「等它出现，**或者把它创建出来**」——
缺文件时模型能做的不是干等，是自己造出来。

测试：`test/markers.test.mjs` 的「dead 带重开锚点」「多参照点」「失败边 >30 条」三条锁住；
变异自检（把 `retry-if` 去掉 ⇒ 断言变红）。

## ⑤ 模型会不会主动去读三层树？——**会，但前提是清单里给了可点的路径**

**先修死指针**：旧版省略行写的是 `full text in graph.md`，而 `graph.md` 从 v1.2.2 起就**不再自动写**
（真实三层树是 `index.md` + `nodes/<id>.md`）。现在引擎把会话树目录传进渲染器：

```
TRACE: <sessions>/<sid>/index.md  (per-node detail: nodes/<id>.md)
- … 13 earlier dead ends omitted for budget: e12..e268 — full text: <sessions>/<sid>/index.md …
```

**盲测（2 个隔离子代理，只给清单 + 问题，不提「去读文件」）**：

| 样本 | 读了什么 | 结果 |
|---|---|---|
| 1 | `index.md`、`graph.md`、`nodes/n7.md`、`n88.md`、`n195.md` | 把 13 条被省略的失败做法**逐条重建**（e12 grep text:? → Cannot find module / e217 subagent 限流 / e268 /tmp 与 D:\tmp 错位 …） |
| 2 | `index.md`、`graph.json`、12 个 `nodes/*.md` | 同上 13 条，并**发现 index.md 已过期**（350 边/17 失败），改用 graph.json（447 边/23 失败）作权威 |

两条都「不用我告诉它去哪」。**结论：清单给出的路径是决定性变量** —— 旧版给的是死指针
（`graph.md`），模型要么读不到、要么读到旧文件；现在给了真实路径，模型会自己去查、并且知道交叉验证。

**副作用（如实记录）**：`index.md` 只在「首次 flush / fold 之后」写，所以会话很长时它会**落后于 graph.json**。
样本 2 自己发现了这点。两条路可选（都还没做）：把真源写进 TRACE 行，或提高树的刷新频率。

## ④ 历史误报回洗（`session-5acafe42`）

**工具**：`test/rewash-graph.mjs <sessionDir> [--apply] [--force]`。默认 dry-run；写前备份
`graph.json.bak-before-rewash-<ts>`；会话日志 2 分钟内还在写就**拒绝**执行（运行中的 `#flush` 会覆盖）。

**范围与安全**：只洗**旧版 `text` 型**（HANDOFF 点名的那 43 条），因为 exit/test/host-error 的
`evidence.{start,end}` 区间**无法可靠对齐**（实测 e21/e38 的区间落在贴着同前缀的另一条命令上，
搬过来只会把别的步骤的输出当成原因）。另外加了「对齐校验」：区间里的 tool/call 参数必须包含
`edge.action` 里的那段命令（归一化后比前 30 字），对不上就跳过。

**结果（`--apply` 已执行）**：

| 指标 | 重洗前 | 重洗后 |
|---|---:|---:|
| failure 边 | 101 | **71** |
| `verify.kind = text`（误报来源） | 43 | **8**（证据对不上，保持原样，不动） |
| 其中 `text → hard-error`（原文确有错误） | — | **4** |
| 其中 `failure → unverified`（真误报） | — | **30** |
| 有 `rewashed` 审计字段 | 0 | **35** |
| `renderFacts` 输出 | 39,336 字符 | 31,135 字符（去掉 30 条误报后变短）|

例：
```
e1  (get_goal)  failure/text → unverified   ← 读 goal 的 JSON 被当成失败
e11 (bash)      failure/text → failure/hard-error + snippet 换成 "Cannot find module …"
e17 (write)     failure/text → failure/host-error + snippet 换成 "Error: cannot modify … file has not been read"
```
树已按新图重建（267 个节点 + index.md）；`node test/verify-graphs.mjs` 全库健康。

**复跑**：
```bash
node test/rewash-graph.mjs "D:/DeepSeek Harness/home/chess-context/sessions/session-5acafe42-b85b-4e06-845a-65428b43d7c0"          # dry-run
node test/rewash-graph.mjs "…同上…" --apply   # 会再洗一遍（幂等：已洗过的 kind 不再是 text，自动跳过）
```

## 局限（不虚报）

1. 8 条 text 型因为证据区间对不上而**没洗**（保守起见不动）——它们的 `verify.kind` 仍是 `text`，
   模型看到的是「原文里出现失败二字」的旧判定；`renderFacts` 里仍然是失败边。
2. 回洗是**一次性数据修复**，不会自动传播到别的会话；要对每个历史会话各跑一次 dry-run + apply。
3. `index.md` 的时效性问题见 ⑤ 的副作用。
