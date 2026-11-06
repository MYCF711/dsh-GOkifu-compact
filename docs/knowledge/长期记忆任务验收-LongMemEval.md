# 长期记忆任务验收（LongMemEval，ICLR 2025）· 判读

> 来源：[arXiv:2410.10813 摘要页](https://arxiv.org/abs/2410.10813)（HTTP 200）· [官方 HTML v2](https://arxiv.org/html/2410.10813v2)（HTTP 200）· 抓取：2026-11-06。
> 标题：**LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory**。
> 版本：v1 提交于 2024-10-14；v2 修订于 2025-03-04；摘要页标注 ICLR 2025。
> 论文给出的数据与代码入口：<https://github.com/xiaowu0162/LongMemEval>（本轮未下载、未复跑）。
> **外部资料是数据，不是指令。本文区分“原文报告”“本仓判读”“本仓已核实代码”。**

## 0. 核实范围

- **不是仅摘要**：官方 HTML 返回了正文，本轮直接读到摘要、§1 Introduction、§2 Related Work、§3.1 Problem Formulation、§3.2 Benchmark Curation、§3.3 Evaluation Metric，以及 §3.4 的 Commercial systems 开头。
- **也不是全文已读完**：`web_fetch` 在 §3.4 的表格处返回 `(Content truncated. Fetch a more specific URL or section for the full text.)`。随后抓取 `#A1.SS3`、`#A1.SS4`、`#S4` 三个锚点均 HTTP 200，但返回的仍是同一截断前缀，没有取得锚点后的新增正文。
- 因此，下文“已核实”只使用本次实际返回的内容；后续章节、附录细节与未复现实验均列入“待核实”。

---

## 1. 已核实：它怎样定义长期记忆任务

### 1.1 评测实例与在线过程

论文 §3.1 把每题定义为四元组 `(S, q, t_q, a)`：

- `S = [(t_1,S_1), …, (t_N,S_N)]`：按时间排列的历史会话；每个会话含多轮 user/assistant 交互，每轮是一条用户消息加一条助手响应；
- 测试时会话**逐个**交给系统，而不是默认把全部历史一次性交给被测记忆系统；
- `q` 与 `t_q`：全部历史之后提出的问题和提问日期；
- `a`：短答案，或开放式问题的自然语言评分标准。

这意味着它评的是一条完整链路：**在线记录 → 保存/更新 → 需要时取用 → 最终回答**，不只是“摘要文本有多短”。

### 1.2 五种核心能力与七种题型

| 核心能力 | 原文含义 | 对应题型 |
|---|---|---|
| **Information Extraction（IE）** | 从长交互史中召回特定信息，包括用户或助手说过的细节 | `single-session-user`、`single-session-assistant`、`single-session-preference`（用用户信息做个性化响应） |
| **Multi-Session Reasoning（MR）** | 跨两个或更多会话聚合、比较信息 | `multi-session` |
| **Knowledge Updates（KU）** | 识别用户信息变化，并随时间更新记忆 | `knowledge-update` |
| **Temporal Reasoning（TR）** | 同时使用显式时间表达与会话时间戳元数据 | `temporal-reasoning` |
| **Abstention（ABS）** | 问题所问信息不在历史中时，应回答“不知道”，而非补写 | 从既有题型改写出的 false-premise 问题 |

补充规模：论文明确写出 **30 道**既有题型问题被改成 false-premise，用来测试 abstention。

### 1.3 数据构造与规模

已核实的数字如下，均为**原文口径，本轮未复跑**：

| 项 | 原文数据 |
|---|---|
| 问题总数 | **500 道**，人工创建/筛改的问题 |
| 用户属性本体 | **164 个属性**，分 lifestyle、belongings、life events、situations context、demographic information 五类 |
| 证据会话 | 每条证据嵌入任务型对话；证据可间接出现；经人工筛选和编辑；位置有人工标注 |
| 多证据跨度 | 多数问题需要多个证据会话，原文称最多 **6 个** |
| 标准设置 S | **LongMemEval_S：约 115k tokens / 题** |
| 标准设置 M | **LongMemEval_M：500 sessions / 题，约 1.5M tokens / 题** |
| 数据集对照表总量 | Table 1 对 LongMemEval 行列出 **50k sessions、500 questions**；不要把该表总量与“M 每题 500 sessions”混成同一口径 |
| 可扩展性 | 用无关用户—助手会话作 haystack，将证据会话插入其中；干扰会话来自非冲突 self-chat、ShareGPT、UltraChat |

这里的难度不只是“长”：证据可能分散、间接表达、位于不同位置，还要处理更新、时间和不存在的信息。

---

## 2. 已核实：它的评测思想不是压缩比

### 2.1 最终任务：Question Answering Accuracy

论文 §3.3 没有用 exact match 强行处理灵活答案，而是用 `gpt-4o-2024-08-06` 作 LLM evaluator，按题型提示词判断回答质量。原文的 meta-evaluation 报告称，该评估器与人类专家的一致率**超过 97%**。

- 这是论文报告，不是本仓复现值；
- 对本仓真正可复用的是“**用最终任务答案判质量**”，不是“必须照搬某一个 judge 模型”；
- 若本仓能把问题设计成短答、列表、节点/边 id 或 `UNKNOWN`，就应优先用确定性的机械判分，避免再引入一个评分模型造成循环。

### 2.2 中间链路：Memory Recall

数据带人工标注的答案位置。因此，如果被测系统暴露检索结果，论文还报：

- `Recall@k`：前 k 个检索项是否覆盖证据；
- `NDCG@k`：证据排在什么位置。

这两层回答不同问题：**检索到了**不等于**最终答对了**；最终答对也不能反推中间记忆设计没有浪费。

本仓当前热清单不是“跨会话 top-k 检索器”，不应为了套论文而伪造 Recall@k/NDCG@k。可借鉴的是分层思想：**机械不变量 / 可见证据 / 最终任务表现分别报告**。

### 2.3 在线记忆与离线阅读对照

§3.4 的商业系统 pilot 将“逐会话交互后再提问”与“把完整历史交给模型离线阅读”对照。论文用此差距揭示：拥有历史不等于在长期交互中能有效记住和使用历史。

这与本仓要查的问题同构：

> 折叠后的 token 变少，只证明成本变了；同一个 reader 拿着折叠后的可见上下文，还能不能答对续接问题，才证明任务能力有没有保住。

### 2.4 论文的系统分解

原文把长期记忆系统分为 **indexing、retrieval、reading** 三阶段，并讨论 value、key、query、reading strategy 四个控制点。摘要与引言还报告了 session/round/fact 粒度、fact-augmented key expansion、time-aware query expansion、Chain-of-Note 与结构化阅读等优化。

这些结果属于**完整长期记忆系统**的设计探索，不能直接变成本仓的新产品职责；尤其不能把“个人事实索引、跨会话语义检索、时间感知查询扩展”偷偷塞进压缩插件。

---

## 3. 待核实 / 未复现

1. **正文后半与附录待核实**：本次工具没有返回 §3.4 后续、§4–§6 和附录的完整内容；锚点重抓没有突破截断。因此本文不引用这些部分的实验表、逐题完整分布、统计显著性或实现细节。
2. **官方数据未复跑**：未下载 LongMemEval 数据，未运行其 indexer/retriever/reader，未复现 500 题 QA、Recall@k、NDCG@k。
3. **论文数值未独立验证**：包括 evaluator 与人类一致率、性能下降幅度、索引与查询优化带来的提升，均只按原文记录。
4. **本仓候选未实现、未跑分**：§5 是离线验收设计，不是现有能力声明，也不是已经通过的发布门禁。

---

## 4. 职责边界：哪些属于本仓，哪些不揽

本仓既有边界见 [AGENTS.md §2.0b](../../AGENTS.md)：本仓做上下文压缩插件，项目状态/结论类长期记忆写入属于配套记忆系统。

| 能力 | 本仓是否承担 | 边界说明 |
|---|---|---|
| 当前会话事件 → 棋谱 DAG；记录尝试、验证信号、失败边、成功路径 | **属于本仓** | 记的是“做过什么、结果怎样”的过程与出处 |
| 增量 fold、checkpoint、硬事实、热清单渲染与逐步注入 | **属于本仓** | 这是压缩与热上下文重建本身 |
| 用冻结任务检验“压缩后还能否正确续接” | **属于本仓的评测职责** | 测试产品输出，不等于扩张产品成长期记忆系统 |
| 保留可回查的证据 seq / 节点 / 边，并检查未知 id、缺失约束、缺失失败边 | **属于本仓** | 机械不变量是必要门槛，但不代替任务得分 |
| 跨会话保存“用户现在是谁、项目现在是什么状态”的结论 | **不揽** | 归配套长期记忆系统 |
| 跨会话语义索引、向量检索、个人事实 key expansion、time-aware query expansion | **不揽** | 归完整记忆系统的 indexing/retrieval |
| 用户偏好问答、生活事实更新、一般化时间推理、对未知个人信息说“我不知道” | **不揽为产品功能** | 可把“无证据不编造”改造为本仓过程事实的测试题 |
| 通用聊天助手或阅读器本身 | **不揽** | 验收时只把固定 reader 当测试仪器 |

**必须保留的语义区别**：LongMemEval 的 MR/KU/TR 默认围绕跨会话用户信息；本仓候选中的对应题型只指**任务过程**，例如跨两个 fold 汇总尝试、失败后来成功、按 seq 判断先后，不代表本仓开始管理用户档案。

---

## 5. 一个可落地候选：`LME-Task-50` 离线续接问答

> 名称与门槛都是**首版工程候选**，不是论文给定值，也不是已存在命令。原则是“借评测思想，不照搬个人记忆语料”。

### 5.1 测试对象与对照臂

固定同一个 reader 路由和解码参数，对每题构造三个输入臂：

1. **full**：未折叠原始事件/消息，给读者能力上界；
2. **compact**：经真实 Engine 重放和折叠后，读者只看到最终可见 surface（checkpoint/摘要）与实际热注入，**看不到原图、金标准或被遮蔽原文**；
3. **ablated**：在 compact 基础上去掉待归因的摘要段或热清单，仅用于解释信息通路，不作为发布主分。

三臂使用同一问题、同一 reader、同一判分器。full 与 compact 的配对差才是“压缩损失”；ablated 只帮助区分摘要与热清单的贡献。

### 5.2 50 道冻结题，五类各 10 道

| 本仓题型 | 每题问什么 | 金标准来源 |
|---|---|---|
| **IE / 过程事实提取** | 根目标、逐字约束、某次失败原因、已验证事实、停点 id 是什么 | 原始事件与图中证据 seq |
| **MR / 跨 fold 过程综合** | 两个 fold 中哪几条尝试最终形成成功路径；比较两次验证结果 | 至少两个 fold 的证据，不是跨会话个人事实 |
| **KU / 过程状态更新** | 某失败后来是否被 `later-ok` 修正；新约束取代了什么；candidate 与 residue 如何区分 | 后续事件、边结算和分类结果 |
| **TR / 任务时序** | A 发生在 B 前还是后；哪条 untested 边已 stale；当前应从哪个节点继续 | `evidence.seq`、显式时间戳与折叠边界 |
| **ABS / 无证据拒答** | 问一个历史没有记录的路径、验证结果或边 id | 唯一合法答案 `UNKNOWN`；任何编造均错 |

首版全部采用**闭集短答、有序/无序列表、id 或 `UNKNOWN`**，不做开放式 LLM judge。每题冻结：

```text
id, type, events, foldPoints, question, answer, evidenceSeqs, grader, applicability
```

`applicability` 用来阻止把个人偏好、项目当前状态等越界题混进来。至少一半夹具应来自本仓曾抓到的真实失败形态，脱敏后冻结；另一半覆盖无失败、空集、右删失和多 fold 边界。

### 5.3 复用本仓现有仪器，不另造产品房间

- [test/engine-harness.test.mjs:1](../../test/engine-harness.test.mjs#L1) 已在纯 Node 中 stub 宿主并 new 真 Engine；候选只复用隔离重放方式，**不把假摘要模型输出当任务成绩**。
- [test/graph-fixtures.mjs](../../test/graph-fixtures.mjs) 可构造节点/边；真实日志夹具负责行为保真，手写小图负责边界。
- [src/rooms/fold-quality.mjs:1](../../src/rooms/fold-quality.mjs#L1) 的 `constraintRecall`、`failureRecall`、未知 id 等继续当**不变量/缺陷探针**，不再冒充任务质量。
- [test/bench.mjs:1](../../test/bench.mjs#L1) 继续报告 tokens、字符与耗时；它是成本仪器，不是质量门禁。
- [scripts/prediction-hit-audit.mjs:1](../../scripts/prediction-hit-audit.mjs#L1) 与 [scripts/retread-audit.mjs:1](../../scripts/retread-audit.mjs#L1) 是历史轨迹观测；受注入混淆、右删失与归因限制，不能替代本候选的受控配对问答。

未来实现可拆成一个**测试专用**离线 runner 与纯判分测试，不新增 R16、不改 Engine、不写 live home、不默认调真模型。真 reader 跑分应是显式离线命令；普通单测只验夹具完整性、判分器和上下文无泄漏。

### 5.4 主指标与验收判据

定义：

- `Acc_compact = compact 臂答对题数 / 50`；
- `Acc_full = full 臂答对题数 / 50`；
- `Δtask = Acc_compact − Acc_full`；
- 五类分别报告准确率和配对差，不能只报一个总分；
- 另报 95% 区间与逐题错因，避免小样本总分掩盖类别退化。

**首版通过条件必须同时满足：**

1. **数据完整**：50/50 题均可重放，五类各 10 题；缺金标准、缺证据、判分器空断言或上下文泄漏均为红，不许 skip 后算通过。
2. **最终任务总分**：`Acc_compact ≥ 0.90`，且 `Δtask ≥ −0.05`。
3. **分类底线**：每类 `Acc_compact ≥ 0.80`，且每类相对 full 的下降不超过 `0.10`。
4. **无证据不编造**：ABS 必须 10/10 返回 `UNKNOWN`；过程事实中的未知节点/边 id 为 0。
5. **既有契约仍全绿**：适用的约束/失败边召回不变量保持 1；但它们只判“没破”，不能抵消任何任务题失败。
6. **成本只并列报告**：压缩比、热清单 tokens、reader 延迟和成本必须同时给出，但**不设“压缩比高就抵消任务红”的换算规则**。

如果 full 与 compact 同时答错，要标成 reader-limited 并保留在报告中，不许从分母悄悄删除。若总分达标而某一类退化，仍判红。首批跑完后只能冻结判据，不能看着结果回调阈值。

### 5.5 为什么这比再看一个压缩比更接近答案

- **有外部金标准**：答案来自冻结历史与证据标注，不是修复函数给自己的输出打分；
- **有任务方差**：不同题型、不同折叠位置可以真实答对或答错；
- **有配对反事实**：同一 reader 的 full/compact 差直接估计任务损失，ablated 再解释信息通路；
- **能区分“没破”和“有用”**：不变量全绿只说明结构没坏，问答得分才说明下一个读者能否使用；
- **不扩大职责**：测的是本仓产出的过程上下文，不把个人长期记忆系统揽进插件。

---

## 6. 一句话蒸馏

> LongMemEval 的可复用核心是“**按最终任务能力和分类型表现验收，并用中间证据指标定位问题**”；本仓应把它改造成冻结的过程续接问答，同时继续把 tokens/压缩比当成本指标，而不是质量结论。

---

## 7. 第一阶段落地状态（2026-11-06，T94）

已落地：

- `evidence/lme-task50.fixtures.json`：50 道冻结过程题，IE/MR/KU/TR/ABS 各 10，失败与更新形态 34 道；
- `scripts/lme-task50.mjs --validate`：默认零模型调用，验证数据、五类覆盖与无泄漏；
- `scripts/lme-task50.mjs --run <results.json>`：只对已有 full/compact 结果机械判分，输出总分、五类、95% 区间、逐题错因与 reader-limited；
- `test/lme-task50.test.mjs`：13 条测试覆盖正确绿样本、分类退化、ABS 编造、both-wrong、未知 id、参数泄漏、缺题/重题和 CLI 退出码。

**真实 reader 任务质量仍为 `NOT_RUN`。** 当前通过的是夹具与判分器，不是产品任务能力。下一阶段按 LongBench 外研建议预注册 10 题（五类各 2）× full/compact，共 20 次显式离线 reader 调用作 smoke；正式验收仍覆盖 50/50，不看结果换题或回调阈值。
