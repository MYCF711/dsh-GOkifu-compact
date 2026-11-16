# Q1 Stage B runner：120 次硬上限的可证伪装置

> **定位**：Stage B 只问一件事 —— 把 `renderQueryRecall()` 的机械召回块加进读者上下文，
> 是否让同一批**已冻结**的 20 题更容易答对，且不引入退化、不增加 UNKNOWN、不破坏 token / p95。
> **它不是采纳依据**：本合成题集的决策上限是 `POSITIVE_SIGNAL`，**绝不 ADOPT**；生产默认仍是 `NOT_ADOPTED`。

- 预注册（唯一判定来源）：`evidence/query-recall-prereg-v1.json`（`experimentId = q1-query-recall-stage-b-1`）
- runner：`scripts/query-recall-pilot.mjs`（默认 dry-run；`--run` 才可能联网）
- 离线测试：`test/query-recall-pilot.test.mjs`（36 用例，0 模型调用）

---

## 1 · 命令面

| 命令 | 行为 | 网络 |
|---|---|---|
| `node scripts/query-recall-pilot.mjs` | **dry-run（默认）**：核对冻结 sha、Stage A 证据、Stage A 性能证据，展开 120 个请求计划，逐题打印两臂字符数；不写任何文件 | **none** |
| `node scripts/query-recall-pilot.mjs --run --authorize q1-query-recall-stage-b-1` | 真实运行 120 次（严格串行、0 重试），写私有明细 + 公开聚合 | 120 次 |
| `--repo <dir>` | 测试/隔离用根目录（只影响输入 JSON 与输出路径，不改变被 import 的实现） | 同左 |
| `--overwrite` | 允许覆盖已存在的结果文件（默认拒绝） | — |

`--stage-a-p95` **已废弃**：p95 必须来自落盘证据 `evidence/query-recall-stage-a-perf.json`，
传这个参数会直接 USAGE 退出（不接受命令行裸声明）。

`--run` 的前置条件（全部在构造 transport **之前**）：

1. `--authorize` 等于预注册 `experimentId`（两处必须同名）；
2. 环境变量 `LME_READER_MODEL` / `LME_READER_ENDPOINT` 显式给出（runner **不写死**模型 id 与 endpoint）；
3. 结果文件不存在，或显式 `--overwrite`。

## 2 · 闸门顺序（任何一条不过 ⇒ 0 次调用）

| # | 检查 | 依据 | 退出码 |
|---|---|---|---|
| ① | 预注册存在且可解析 | `evidence/query-recall-prereg-v1.json` | `3` |
| ② | 冻结输入的 sha256 与 `frozenInputs` 逐字一致（**7 键**：fixtures / stage-a 脚本 / stage-a 测试 / reader / grader / **impl** / **stageAEvidenceSha256**）；预注册内部（`stageGate` / `design`）的 sha 与 `frozenInputs` 自洽 | 预注册 `frozenInputs` | `3` |
| ②b | **请求口径**与冻结 reader 源码逐字一致（temperature / max_tokens / stream / 超时 / variant / postprocess 六项） | 预注册 `design.readerConfig` | `3` |
| ③ | Stage A 证据存在、`status == PASS`、`required` 全成立、`aggregate.failed/misses/falsePositives == 0`、`evidence.hitRate == 1`、证据内夹具 sha 与冻结值一致、证据里 `impl.sha256`（若已登记）与当前实现一致 | 预注册 `stageGate.stageA` | `3` |
| ③b | **Stage A 性能证据**：`evidence/query-recall-stage-a-perf.json` 存在、**字节 sha256 等于 `stageGate.perf.sha256`**，`max(bench.renderMs.p95, bench.derivedRenderMs.p95) ≤ 25` 且 `bench.deltaError == false` | 预注册 `stageGate.perf` | `3` |
| ④ | 计划可展开：20 题 × 2 臂 × 3 样本 = 120；两臂同题同参数；A1 − A0 仅为召回块 | 预注册 `design` | `3` |
| ④b | 预注册决策政策与代码一致：`decisionCap == "POSITIVE_SIGNAL"`、`saturation.scorableTasks == 可计分题数` | 预注册 `decisionCap` / `saturation` | `3` |
| ⑤ | 授权口令 | 预注册 `experimentId` | `2` |
| ⑥ | `LME_READER_MODEL` / `LME_READER_ENDPOINT` 非空 | 预注册 `design.readerConfig` | `3` |
| ⑦ | 结果文件不存在或 `--overwrite` | runner 自身保护 | `3` |

**实现与证据已冻结**：`frozenInputs.impl` / `frozenInputs.stageAEvidenceSha256` 已在真实调用前登记，
当前实现与 Stage A 证据必须逐字匹配；性能文件 `stageGate.perf.sha256` 同步冻结，dry-run 已实测全部 `ok`。

预算闸在 ⑦ 之后：`createBudget(120)` 的第 121 次 `take()` **直接抛错**，抛在 transport 之前 ——
「第 121 个调用」在结构上不存在（不是靠事后统计）。

## 3 · 两臂构造

- `A0`（baseline）：`prereg.design.contextBase` 原文；
- `A1`（recall）：`contextBase + 两个换行 + renderQueryRecall(graph, query, {limit, maxChars}).text`；
- **召回块为空时 A1 与 A0 逐字相同**（B-19 就是这种情况），不追加空块。

调用顺序在第一次调用前固定：按题号逐题，**每题先 A0 × 3 样本、再 A1 × 3 样本**，串行 `await`，无重试。
任何一次调用失败（非 2xx / 解析失败 / 无 content）⇒ 该样本记 `ok:false`，**不补样、不追加**；
整体判为 `INCOMPLETE`，决策只记 `NOT_DECIDED`。

## 4 · 为什么复用冻结 reader 的「函数」而不是它的 CLI

`scripts/lme-pilot-reader.mjs` 是 reader 的唯一口径（prompt / temperature=0 / max_tokens=2048 / 归一化 / 多数票），
但它的导出面不够：

1. 只导出 `runPilot`，其选择规则是「五类各前 2 题 = 10 题 × 2 臂」，与这里固定的 20 题顺序不是同一形状；
2. 它只保留**被选中样本**的 raw，逐样本 raw / usage / 延迟会被合并掉，而预注册要求逐样本记录；
3. `callChat` 没有导出，无法单次调用。

因此 runner **直接 import 它的导出函数**：`buildMessages`（prompt 逐字）、`normalizeReaderAnswer`、
`postProcessAnswer`（归一化逐字），并 import 冻结 grader 的 `gradeAnswer`（判分逐字）。
HTTP 传输的请求字段按冻结源码镜像（`temperature: 0` / `max_tokens: 2048` / `stream: false` / 120 s 超时），
并且**运行前会调用 `checkFrozenTransport()` 做运行期对账**：六项口径必须与冻结源码逐字相等，否则**直接拒绝**。
测试同时解析冻结源码对账，并有一条「把 temperature 改成 0.7 ⇒ 必须红」的用例。

## 5 · 判定（只收紧，不加宽）

样本级：`UNKNOWN`（归一化后等于 `UNKNOWN` / `无法确定` / `不知道`）**不算对也不算错**；
`CORRECT` = 小写归一化后与 gold 或 aliases 之一逐字相等；`WRONG` = 其余（弃答题上的 WRONG 记为编造）。
多数票：3 样本取多数，**平票取第 1 个样本**。

**可计分题** = gold 不是 `UNKNOWN` 的题（本集 18 道，预注册 `saturation.scorableTasks` 与代码互相校验）。饱和按可计分题算：
`majorityCorrect >= 可计分题数` 即饱和 —— 用总题数当分母会让 20/20 保护永远不可达。

| 条件（按顺序） | 判定 |
|---|---|
| 调用记录不完整（失败 / 缺失） | `NOT_DECIDED` |
| 存在任一题 A0 对而 A1 不对（UNKNOWN 也算丢答案），或 A1 多数票 < A0 | `NEGATIVE_SIGNAL` |
| 任一臂在可计分题上饱和 | `POSITIVE_SIGNAL`（最高只能到这里） |
| A1 > A0 | `POSITIVE_SIGNAL`（**决策上限**：本合成题集绝不 ADOPT） |
| 多数票相同，样本级 / UNKNOWN / 翻转全相同 | `NO_DIFFERENCE` |
| 其余（多数票相同但样本级有差） | `NOT_DECIDED` |

**为什么绝不 ADOPT**（M-5）：题面里的 12 道「召回题」是 base 答案 + 召回块的直接答案 ——
它证明的是「读者会读召回块」，不是「真实工作里召回块带来收益」。真实收益只能由真实会话的
端到端实验回答。因此 `adoption` 恒为 `NOT_ADOPTED`，结果里显式写 `decisionCap = "POSITIVE_SIGNAL"`。

五道门仍全部计算并输出（`stageA` / `pairedNoRegression` / `unknownNotIncreased` /
`tokenPositive` / `p95Positive`），只是它们不再能把结论推到 ADOPT。
`tokensPerCorrectMajority = inputTokens / max(1, 多数票正确题数)`；`p95Positive = A1.p95 ≤ A0.p95 + 50`（每样本端到端 wallMs，最近秩分位）。

## 6 · 输出面 1：私有明细 `evidence/query-recall-pilot.results.json`

只在真实 `--run` 时写。schema `query-recall-pilot-results-v1`：

| 字段 | 内容 |
|---|---|
| `stageAStatus` / `callsUsed` / `retriesUsed` / `decision` / `saturationTriggered` | 预注册 `reporting.status` 要求的五个必写字段 |
| `decisionCap` / `decisionCapReason` / `scorableTasks` | M-5 的决策上限与可计分题数 |
| `stageA` | 证据状态、sha256、聚合（14/14、hitRate、misses、falsePositives）、`impl`（declared/actual/registered）、`perf`（p95 / deltaError / samples / 图规模） |
| `frozen` | 7 份冻结输入的 sha256（相对路径） |
| `reader` | variant、postprocess、temperature、maxTokens、samplesPerArm、retries、model；endpoint **不记录** |
| `tasks[].arms[A].samples[]` | 逐样本：`raw`、`normalized`、`graded`、`outcome`、`usage`、`latencyMs`、`finishReason`、`error` |
| `tasks[].arms[A].majority` | 多数票答案、票数、逐票计数 |
| `aggregate` / `byFamily` / `gates` / `decisionReasons` | 聚合、族计数、五道门、判定理由 |

本题全部为**纯合成**题面 / 上下文 / 答案，raw 回答虽是逐样本原文，但不含任何真实数据。

## 7 · 输出面 2：公开聚合 `evidence/query-recall-pilot-public.json`

schema `query-recall-pilot-public-v1`。只放聚合与票型：

- 顶层：`experimentId`、`status`、`stageAStatus`、`stageAP95Ms`、`stageAPerfSha256`、`callsUsed`、`retriesUsed`、`maxCalls`、`samplesPerArm`、`model`；
- `arms.A0/A1`：多数票计数、样本计数、tokens、`tokensPerCorrectMajority`、`wallMs.{p50,p95}`；
- `perTask[]`：`id`、`family`、`derivableFrom`、每臂 `outcome` 与 `votes`、`regression`；
- `gates` / `decision` / `adoption` / `saturationTriggered` / `decisionCap` / `scorableTasks` / `decisionReasons`；
- `abstentions[]`、`fabrications[]`、`byFamily`、`frozen`（只有 sha）。

**明确不含**：raw 回答、prompt、context、endpoint、任何路径、会话 id。

## 8 · 冻结输入的字节注意

预注册冻结的是 **sha256 字节**。当前登记值：reader `c035954a…` / grader `d8eaf62e…`（LF 字节），
impl `src/rooms/query-recall.mjs`，证据字节由 `stageAEvidenceSha256` 冻结。
任何 EOL 归一化（例如 `git restore .` / 编辑器统一换行）都会改变 sha ⇒ 闸门 ② **必然拒绝**（设计行为）。
本仓 `core.autocrlf=input` + `core.eol=lf`，干净 checkout 上是 LF —— 预注册也按 LF 登记，两边一致；
**不要**再为这两个文件做 EOL 转换，也不要擅自加 `-text`（那会让 checkout 变成 CRLF，反而对不上登记值）。

## 9 · 真实运行结果（2026-11-16，已完成）

- **120/120 调用完成，0 重试、0 调用错误**；reader 为冻结配置 `group/deepseek-v4.1-flash-1017`，temperature=0。
- A0 多数票正确 **8/20**，A1 **15/20**；UNKNOWN 样本 **30 → 5**（未增加）。
- **B-06 退化**：A0 多数票 `关闭` 为正确，A1 多数票 `关` 按冻结 gold/aliases 判错。
  没有事后扩 alias 或修改 grader，因此 `pairedNoRegression=false`。
- token 效率为正（2352.38 → 1592.2 input tokens / 多数票正确题），但 wall p95 **2265 → 2838ms**，`p95Positive=false`。
- 最终裁决：**`NEGATIVE_SIGNAL`；`adoption=NOT_ADOPTED`**。原始逐样本与公开聚合分别见
  `evidence/query-recall-pilot.results.json` / `evidence/query-recall-pilot-public.json`。

## 10 · 仍未证明的事

- 本合成题集只能证伪，不能证成；即使无退化，最高也只是 `POSITIVE_SIGNAL`。本次已实际触发退化，不能外推为真实工作收益。
- Stage A 性能 p95 来自 `evidence/query-recall-stage-a-perf.json`（render 9.779 / derived 9.996，取 max = 9.996ms，340 样本），不是 runner 现测；重跑后必须与 `stageGate.perf.sha256` 一起更新。
- 真实模型的 raw 回答若编出路径/会话 id 形状，privacy-audit 可能把私有明细判红；不得为了过门改写 raw。
