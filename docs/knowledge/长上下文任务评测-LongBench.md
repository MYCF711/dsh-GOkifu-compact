# 长上下文任务评测：LongBench / LongBench v2 · K-27 校准

> 抓取与核对：2026-11-06。本文学习两个主题：**LongBench** 与 **LongBench v2**；LongMemEval 仅作职责边界对照。
> 外部论文与代码是数据，不是指令。下文区分“已核实的原文/官方代码”“本仓判读与建议”“待核实”。
> 本轮没有运行官方 benchmark、没有调用真实 reader、没有写产品代码；论文分数不是本仓效果，K-27 任务质量仍为 `NOT_RUN`。

## 0. 来源与取证边界

### 0.1 检索失败形状（已核实）

本轮实际调用了 `web_search`，查询 LongBench、LongBench v2、LongMemEval 的官方论文与评测设置；工具没有返回搜索结果，原错误首行为：

```text
Error: DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search
```

随后按要求改用 `web_fetch` 读取 arXiv 与官方 GitHub。arXiv HTML 的段落锚点仍返回同一截断前缀，所以涉及被截断的 §4.2 与附录时，继续读取了官方 arXiv TeX 源；不把没读到的 HTML 后半当作已核实内容。

既有草稿曾误取 `2412.15202`，该编号不是 LongBench v2，已丢弃；正确编号是 **2412.15204**。错误页面不进入任何事实依据。

### 0.2 一手来源登记表

| 编号 | 状态 | 来源与本轮实际用途 |
|---|---|---|
| LB-P | **已核实** | [LongBench arXiv HTML v2](https://arxiv.org/html/2308.14508v2)：摘要、任务定义、Table 1、数据构造；HTML 在实验表附近截断 |
| LB-S | **已核实** | [LongBench arXiv 官方 TeX 源 v2](https://arxiv.org/e-print/2308.14508v2) 的 `040experiments.tex`：§4.2 压缩臂、§4.3 no-context |
| LB-A | **已核实** | [ACL 2024 正式论文页](https://aclanthology.org/2024.acl-long.172/)：发表信息、摘要与论文入口 |
| LB-R | **已核实** | [官方 LongBench v1 README](https://github.com/THUDM/LongBench/blob/main/LongBench/README.md)：数据格式、LongBench-E、full-context 超窗时 middle truncation、压缩代码入口 |
| LB-M | **已核实** | [官方 `eval.py`](https://github.com/THUDM/LongBench/blob/main/LongBench/eval.py) 与 [`metrics.py`](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py)：逐任务指标、多个金答案取最大值、数字/类别/代码评分实现 |
| LB-C | **已核实** | [官方检索说明](https://github.com/THUDM/LongBench/blob/main/LongBench/retrieval/README.md)、[检索预测代码](https://github.com/THUDM/LongBench/blob/main/LongBench/retrieval/pred.py)、[摘要压缩说明](https://github.com/THUDM/LongBench/blob/main/LongBench/summ/README.md) 与 [`compress.py`](https://github.com/THUDM/LongBench/blob/main/LongBench/summ/compress.py)：压缩臂实现入口；只读，未执行 |
| V2-P | **已核实** | [LongBench v2 arXiv HTML v2](https://arxiv.org/html/2412.15204v2)：503 题、六类、20 子任务、难度/长度分层、数据审核、§4.1 |
| V2-S | **已核实** | [LongBench v2 arXiv 官方 TeX 源 v2](https://arxiv.org/e-print/2412.15204v2) 的 `040experiment.tex` 与 `060appendix.tex`：RAG 臂、no-context、生成参数与提示词 |
| V2-R | **已核实** | [官方仓库根 README](https://github.com/THUDM/LongBench/blob/main/README.md)、[`pred.py`](https://github.com/THUDM/LongBench/blob/main/pred.py)、[`result.py`](https://github.com/THUDM/LongBench/blob/main/result.py)：数据字段、full/RAG/no-context 开关、答案提取与聚合 |
| V2-C | **已核实** | [官方链接的检索实现](https://github.com/THUDM/LongCite/blob/main/utils/retrieve.py)：切块与 embedding 相似度检索的代码参照；只读，未执行 |
| LME-P | **已核实** | [LongMemEval arXiv HTML v2](https://arxiv.org/html/2410.10813v2) 与[官方 README](https://github.com/xiaowu0162/LongMemEval/blob/main/README.md)：在线逐会话记忆、full-history、检索与 LLM evaluator 对照 |

### 0.3 待核实总边界

- **待核实**：官方数据与代码的实跑结果、数据版本差异、完整附录中的所有表格；本轮没有复现任何论文分数。[LB-P](https://arxiv.org/html/2308.14508v2) · [V2-P](https://arxiv.org/html/2412.15204v2)
- **待核实**：本仓 K-27 的真实 reader 成绩、置信区间、成本与延迟；本轮只做评测设计校准，不产生跑分结论。[K-27 既有设计](./长期记忆任务验收-LongMemEval.md)
- **待核实**：并行 K-27 第一阶段分支的 50 题夹具与 `--validate` / `--run` 实现；本研究分支不能仅凭任务书宣称它已经落地或通过。

---

## 1. 主题一：LongBench 怎样组织长上下文评测

### 1.1 任务与分层

| 状态 | 已核实事实 | 来源 |
|---|---|---|
| **已核实** | LongBench 有 **21 个数据集、6 大类、4,750 个测试实例**；六类是 single-document QA、multi-document QA、summarization、few-shot learning、synthetic tasks、code completion。 | [LB-P §1](https://arxiv.org/html/2308.14508v2#S1) |
| **已核实** | 统一形式是 `(I, C, A)`：短输入/问题 `I`、长上下文 `C`、答案 `A`；数据还带 `answers`、`length`、`dataset`、`language`、`all_classes`、`_id`。 | [LB-P §3.1](https://arxiv.org/html/2308.14508v2#S3.SS1) · [LB-R Data Format](https://github.com/THUDM/LongBench/blob/main/LongBench/README.md#data-format) |
| **已核实** | LongBench-E 另按 **0–4k / 4k–8k / 8k+** 分桶，用来观察同一任务随输入长度变化的表现；英文/代码长度按词，中文按字符，不把二者混称为 token。 | [LB-R](https://github.com/THUDM/LongBench/blob/main/LongBench/README.md) · [官方 `task.md`](https://github.com/THUDM/LongBench/blob/main/LongBench/task.md) |
| **已核实** | synthetic 的 PassageCount 需要去重计数，PassageRetrieval 需要定位摘要对应段落；multi-doc QA 需要跨证据与干扰文档组合信息，summarization 更依赖全局理解。题型不是可以互相替代的同义标签。 | [LB-P §3.2](https://arxiv.org/html/2308.14508v2#S3.SS2) |

**本仓判读**：可复用的是“**任务类型 × 长度 × 证据结构**”分层，而不是把 21 个数据集原样搬进 K-27。K-27 主层仍应是 IE / MR / KU / TR / ABS；fold 数、原始上下文长度、证据位置与单证据/多证据依赖应在看 reader 结果前冻结为切片元数据。

### 1.2 full-context、检索、摘要与 no-context 臂

| 臂 | 状态 | 官方设置 | 来源 |
|---|---|---|---|
| **full-context** | **已核实** | 将完整上下文放入任务提示；超过模型处理长度时从中间截断，保留首尾。故“官方 full 臂”在超窗样本上实际是 **full-or-middle-truncated**，不能误写成所有样本都完整无截断。 | [LB-R Leaderboard note](https://github.com/THUDM/LongBench/blob/main/LongBench/README.md) |
| **retrieval** | **已核实** | 长上下文先切成 **200 或 500 词（中文为字符）**的块；为逼近同一上下文预算，分别取 **top-7 或 top-3**。比较 BM25、Contriever、OpenAI Embedding；检索块与问题一起给 reader。官方实验用于 QA，不是所有任务都默认检索。 | [LB-S §4.2](https://arxiv.org/e-print/2308.14508v2) · [LB-C retrieval](https://github.com/THUDM/LongBench/blob/main/LongBench/retrieval/pred.py) |
| **summarization** | **已核实** | 将文本分块，逐块生成简短摘要，再把摘要串成压缩上下文；论文只在 summarization 任务上研究这一臂。 | [LB-S §4.2](https://arxiv.org/e-print/2308.14508v2) · [LB-C summ](https://github.com/THUDM/LongBench/blob/main/LongBench/summ/README.md) |
| **no-context** | **已核实** | 只给问题、不给长上下文，用于估计记忆/猜测基线；它不是压缩臂，也不进入 full/compact 损失的定义。 | [LB-S §4.3](https://arxiv.org/e-print/2308.14508v2) |

**本仓判读**：

1. K-27 的 full 臂必须真的包含该题全部原始事件/消息；若被 reader 窗口截断，应记为**仪器无效**，不能继续叫 full，也不能 skip 后从分母删掉。
2. compact 臂只给真实 Engine 产出的最终可见 surface 与热注入，不给原图、金标准或被遮蔽原文。两臂保持同题、同 reader、同提示外壳、同解码与同判分器。
3. 检索臂不是 K-27 主分必需项。本仓没有通用 RAG 产品职责，不应为了模仿 LongBench 新增跨会话语义检索；若未来做诊断性 retrieval，top-N、切块、检索器和预算必须预先固定或全量预注册，不能看测试分后只挑最好的 N。

### 1.3 哪些指标是机械的，机械是否等于语义正确

| 任务/输出 | 状态 | 官方判分方式 | 对 K-27 的可复用边界 |
|---|---|---|---|
| 单文档/多文档英文 QA、TriviaQA | **已核实** | 归一化后 token F1；多个金答案时取该预测在各答案上的最高分。 | 是确定性指标，但部分匹配也会得分，不能替代闭集短答的对/错。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py) |
| 中文 QA、DuReader、摘要 | **已核实** | 中文分词后的 F1 或 ROUGE-L；其余摘要用 ROUGE-L。 | 自动不等于事实正确；K-27 首版不用 ROUGE 给过程事实问答放行。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/eval.py) |
| TREC / LSHT 分类 | **已核实** | 在预测中查找合法类别并按实现给分。 | K-27 应进一步收紧为唯一合法标签，避免一段输出同时含多个标签造成歧义。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py) |
| PassageCount / PassageRetrieval | **已核实** | 论文表称 Accuracy/EM；当前实现实际抽取数字并按“命中数字数 / 预测数字总数”计分，并非简单的整串 exact match。 | 不能仅凭指标名叫 EM 就推断实现；K-27 数字/id 题宜唯一答案、唯一抽取、归一化后精确判 0/1。[LB-P Table 1](https://arxiv.org/html/2308.14508v2#S3.T1) · [LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py) |
| LCC / RepoBench-P | **已核实** | 取有效预测行后计算 edit similarity。 | 相似度不是执行验证；K-27 若不生成代码，无需引入。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py) |

---

## 2. 主题二：LongBench v2 怎样把深推理做成可靠自动评测

### 2.1 题型、难度与长度三层切片

| 状态 | 已核实事实 | 来源 |
|---|---|---|
| **已核实** | LongBench v2 有 **503 道英文四选一题、6 大类、20 子任务**，每题带长上下文、问题、四个选项、金答案与 evidence；上下文范围为 **8k–2M words**。 | [V2-P §1、§3](https://arxiv.org/html/2412.15204v2#S3) |
| **已核实** | 六类及题量为：single-document QA **175**、multi-document QA **125**、long in-context learning **81**、long-dialogue history understanding **39**、code repository understanding **50**、long structured data understanding **33**。 | [V2-P Table 1](https://arxiv.org/html/2412.15204v2#S2.T1) |
| **已核实** | 难度分为 easy **192** / hard **311**；长度分为 short `<32k` **180**、medium `32k–128k` **215**、long `>128k` **108**，均以 words 计。 | [V2-P §3.4](https://arxiv.org/html/2412.15204v2#S3.SS4) |
| **已核实** | 题目设计明确排除简单检索、依赖大量外部知识、刁钻陷阱与大规模计数；自动审核与人工审核共同检查客观答案和难度。 | [V2-P §3.2](https://arxiv.org/html/2412.15204v2#S3.SS2) |

**本仓判读**：v2 的关键不是“把 K-27 改成四选一”，而是证明可靠机械判分与深推理可以共存。K-27 可以保持短答/id/列表/`UNKNOWN`，同时增加跨 fold 综合、更新、时序题；不要为了便于判分把题目退化成只找单个显眼事实。

### 2.2 full、RAG、no-context 与 CoT 设置

| 臂/维度 | 状态 | 官方设置 | 来源 |
|---|---|---|---|
| **full-context** | **已核实** | 超过 128k-token 模型窗口时使用 middle truncation；zero-shot 与 zero-shot+CoT 分开报告。zero-shot 最终答案与 CoT 第二步均固定生成参数，CoT 第一步有独立预算。 | [V2-P §4.1](https://arxiv.org/html/2412.15204v2#S4.SS1) · [V2-S Evaluation Setting](https://arxiv.org/e-print/2412.15204v2) |
| **RAG** | **已核实** | 以指定 tokenizer 切成 **512-token** 块，以“问题+选项”为 query，用 Zhipu Embedding-3 排序；取 top-N 后按原始文档顺序拼接。N 预扫 **4/8/16/32/64/128/256**，形成曲线，而不是事后只报最优 N。 | [V2-S §4.2](https://arxiv.org/e-print/2412.15204v2) · [V2-R `pred.py`](https://github.com/THUDM/LongBench/blob/main/pred.py) |
| **no-context** | **已核实** | 只给问题与选项，用于测量无上下文的记忆/猜测表现。 | [V2-S §4.3](https://arxiv.org/e-print/2412.15204v2) · [V2-R `pred.py`](https://github.com/THUDM/LongBench/blob/main/pred.py) |
| **答案判分** | **已核实** | 官方代码用正则抽取 `The correct answer is ...` 中的 A–D，再与金答案做布尔相等；结果脚本聚合 overall/easy/hard/short/medium/long。这里的字段名 `judge` 是布尔值，不是 LLM judge。 | [V2-R `pred.py`](https://github.com/THUDM/LongBench/blob/main/pred.py) · [`result.py`](https://github.com/THUDM/LongBench/blob/main/result.py) |

**本仓判读**：

- full/compact 之外，CoT 与否属于 reader 设置变化，不能在两个臂之间一边开、一边关。首版最小实验固定一种输出协议即可。
- 若采用预扫描多个预算，必须完整报告曲线；若只做一次最小实验，则事先固定一个预算。两种做法都不允许看分后选最优臂。
- no-context 可作诊断，但 K-27 的 ABS 本身以 `UNKNOWN` 为合法答案，不能把 no-context 的 ABS“高分”解释成记忆能力。

---

## 3. 机械判分与 LLM judge 的可复用判据

### 3.1 判分选择顺序（本仓建议）

1. **闭集单值**：合法标签、布尔、计数、节点/边 id、前/后关系 → 固定输出语法，归一化后**唯一值精确匹配**。
2. **集合/序列**：无序集合先校验元素均来自合法闭集，再去重、排序、逐值比较；顺序题保留顺序比较。重复项、额外项、未知 id 都按预注册规则判错，不能由判分器悄悄“修好”。
3. **拒答**：无证据题唯一合法值为 `UNKNOWN`；不能用 LLM 判断一个编造的 id“看起来差不多”。
4. **有限别名短答**：只有在冻结题目时穷举并审核别名后才可用；别名表是金标准的一部分，不能看 reader 输出后补别名。
5. **开放生成**：只有当答案无法可靠闭集化、且确需评估语义完整性/事实性时，才使用固定 rubric 的 LLM judge。judge 应独立于被测 reader，对 full/compact 臂盲化，冻结提示与版本，并用人工样本做一致性抽检；judge 分数不能覆盖机械不变量红。

LongBench v1 说明“自动指标”覆盖 F1/ROUGE/edit-sim；v2 说明“客观深推理题”可以全部机械判定；LongMemEval 说明灵活开放答案可能需要 LLM evaluator，其论文报告 evaluator 与人类专家一致率超过 97%，但这是**原文报告、未由本仓复现**，不是本仓必须引入 judge 的理由。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/eval.py) · [V2-R](https://github.com/THUDM/LongBench/blob/main/pred.py) · [LME-P §3.3](https://arxiv.org/html/2410.10813v2#S3.SS3)

**结论**：K-27 首版 50 题已经设计为闭集短答、列表、id、`UNKNOWN`，**不需要 LLM judge**。增加 judge 只会新增评分方差与成本，不会修复题目设计问题。

### 3.2 无效仪器、reader-limited 与压缩损失不能混写

| full | compact | 本仓判读 | 是否留在 50 题分母 |
|---|---|---|---|
| 对 | 对 | 该 reader 在此题上保留了任务能力 | **保留** |
| 对 | 错 | **compression-sensitive loss**；优先检查信息缺失、错误摘要、热清单遮蔽 | **保留，计入配对损失** |
| 错 | 对 | 不是压缩损伤；检查格式运气、压缩去噪或输出随机性，不用它抵消分类红线 | **保留** |
| 错 | 错 | 仅凭准确率只能叫 **both-wrong / reader-limited 候选**；检查 full 是否真的可读、题目与金标准是否无歧义 | **保留** |
| 输入超窗、提示错、答案泄漏、传输失败、解析器失效 | 任意 | **仪器无效/协议失败**，不是 reader-limited，也不是正常任务错 | 修复仪器后按预注册协议重跑；不得悄悄删题 |

**边界澄清**：既有的“full 与 compact 同时答错标 reader-limited”应理解为归因标签，而不是豁免。只有 full 输入完整、金标准与判分器验证无误后，both-wrong 才能确认主要受 reader 能力限制；若两臂错法不同，还应审计 compact 是否额外丢失信息。无论归因如何，都不从分母剔除，也不回调阈值。

---

## 4. 对 K-27 已设阈值的校准意见

既有冻结候选见 [`长期记忆任务验收-LongMemEval.md` §5.4](./长期记忆任务验收-LongMemEval.md#54-主指标与验收判据)：`N=50`、五类各 `10`，`Acc_compact≥0.90`、`Δtask≥−0.05`，每类 `Acc_compact≥0.80` 且相对 full 下降不超过 `0.10`，ABS `10/10`，未知 id 为 `0`。

### 4.1 把阈值翻成题数（本仓推算，非论文阈值）

- 总体 `Acc_compact≥0.90` ⇒ 至少 **45/50** 答对。
- `Δtask = (compact_correct − full_correct) / 50 ≥ −0.05`；逐题计数以 `0.02` 为步长，所以 compact 相对 full 多错 **2 题**时差为 `−0.04`，仍过；多错 **3 题**为 `−0.06`，失败。
- 每类 `Acc_compact≥0.80` ⇒ 每类至少 **8/10**；每类相对 full 多错 **1 题**为 `−0.10`，仍过；多错 **2 题**为 `−0.20`，失败。
- ABS 仍是 **10/10**；过程事实未知节点/边 id 仍是 **0**。这些硬门槛不能被其他题型的高分补偿。

### 4.2 结论：**保留，不看结果回调**

1. LongBench-E 与 v2 都支持“按长度/题型拆开看”的必要性，不支持用一个总体平均分掩盖类别退化。[LB-R](https://github.com/THUDM/LongBench/blob/main/LongBench/README.md) · [V2-R `result.py`](https://github.com/THUDM/LongBench/blob/main/result.py)
2. v2 的机械选择题说明 K-27 的闭集严格判分可行；v1 的 F1/ROUGE 不提供放宽 K-27 阈值的依据。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/metrics.py) · [V2-R](https://github.com/THUDM/LongBench/blob/main/pred.py)
3. 50 题总分与每类 10 题都对小样本波动敏感，所以应同时报告逐题配对四格、分子/分母与 95% 区间；**区间难看不是降阈值理由**。下一轮若要改阈值，只能基于新的任务风险分析，在看本轮 reader 结果之前另立版本，不能追溯性放行。
4. full 也不是“100 分金标准”。它是同一 reader 的参照臂；full 低提示 reader/题目仪器问题，full 与 compact 的差才估计压缩损失。LongBench v2 的论文模型分数不能拿来放宽本仓阈值，题型、任务和读者都不同。

---

## 5. 与 LongMemEval 的差异及本仓职责边界

| 维度 | LongBench / v2 | LongMemEval | 本仓 K-27 借什么 |
|---|---|---|---|
| 对象 | **已核实**：主要给 reader 一段长文档/对话/代码/结构化上下文，测理解与推理。[LB-P](https://arxiv.org/html/2308.14508v2) · [V2-P](https://arxiv.org/html/2412.15204v2) | **已核实**：逐会话在线记录、保存/更新、检索，再回答长期交互问题。[LME-P §3.1](https://arxiv.org/html/2410.10813v2#S3.SS1) | 用 full/compact 配对测“压缩后过程续接能力”，不是只测压缩比 |
| 典型知识 | **已核实**：文档事实、跨文档推理、长 ICL、代码库、表格/KG。[V2-P](https://arxiv.org/html/2412.15204v2#S3.SS1) | **已核实**：用户属性、偏好、生活事件、跨会话时间戳与更新。[LME-P §3.2](https://arxiv.org/html/2410.10813v2#S3.SS2) | 只保留本仓任务过程：目标、约束、尝试、验证、失败边、fold 时序 |
| 中间指标 | **已核实**：LongBench 主要看最终任务指标。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/eval.py) | **已核实**：可另报 Recall@k / NDCG@k，并有 full-history 与 retrieval 设置。[LME-P §3.3](https://arxiv.org/html/2410.10813v2#S3.SS3) · [LME README](https://github.com/xiaowu0162/LongMemEval/blob/main/README.md) | 可分别报结构不变量、可见证据、最终答案；不伪造 top-k 检索指标 |
| 判分 | **已核实**：v1 用确定性相似度/分类/数字指标；v2 用选择题精确判分。[LB-M](https://github.com/THUDM/LongBench/blob/main/LongBench/eval.py) · [V2-R](https://github.com/THUDM/LongBench/blob/main/pred.py) | **已核实**：开放答案采用固定 LLM evaluator，论文有一致性 meta-evaluation。[LME-P §3.3](https://arxiv.org/html/2410.10813v2#S3.SS3) | K-27 闭集化后全部机械判分；开放题不是首版必需 |

**不揽进本仓**：跨会话个人事实索引、用户偏好管理、生活事实更新、通用 time-aware query expansion、个人记忆向量检索。它们属于配套长期记忆系统，不是上下文压缩插件的新职责。K-27 的 MR/KU/TR 只指**任务过程**，不是把个人长期记忆换名搬进仓库。

---

## 6. 下一轮真实 reader 最小离线实验建议（本仓判读）

### 6.1 先冻结，再看任何答案

1. 冻结 50 题、五类各 10 题及 `id/type/events/foldPoints/question/answer/evidenceSeqs/grader/applicability`；同时冻结切片元数据、别名、未知 id 规则与 ABS 规则。
2. 冻结 full/compact 输入构造、reader 路由、提示外壳、解码参数、最大输出、重试/超时规则、判分器与现行阈值；记录 manifest 哈希。full 必须适配 reader 窗口，compact 不得泄漏原图、金标准或被遮蔽事件。
3. 普通离线单测先验夹具完整、无泄漏、机械判分与 paired 四格统计；这些只证仪器，不冒充真实任务成绩。依赖中的 K-27 第一阶段若提供 `--validate` / `--run`，前者只验证夹具，后者只评已有 reader 结果，仍需独立核实其实现与输出。

### 6.2 最小真实 reader smoke：10 题、两臂、20 次调用

- 从已冻结 50 题中按**预注册的种子/哈希选题规则**取每类 2 题，共 10 题；跑 full+compact，共 20 次 reader 调用。ablated/no-context/RAG 都不进入这轮最小实验。
- smoke 只验端到端协议、token/成本采集、输出可解析性与 paired 日志，不宣称通过 50 题门禁，不估计“最终提升”，也不根据分数换 reader、改题、补别名或调阈值。
- 若发现题目、金标准、上下文构造或判分器问题，保留原始输出并标记该 smoke 作废；修复后重新冻结版本。若这 10 题要计入正式 50，正式跑必须仍使用未变的预注册配置，不能只重跑失败题。
- 正式验收在同一冻结配置下覆盖 50/50，逐题公开 full/compact 输出、机械判定、四格归因、五类分子/分母、token/延迟/成本；失败与传输错误不静默 skip。

### 6.3 最小输出表

```text
question_id, type, slice_metadata, full_input_hash, compact_input_hash,
full_output, compact_output, full_score, compact_score,
pair_cell, instrument_status, full_tokens, compact_tokens, latency, cost
```

**验收顺序**：仪器完整性 → ABS/未知 id 硬门 → 五类底线 → 总体准确率与 paired Δ → 成本并列报告。成本下降不能抵消任务红；reader-limited 不能从分母消失。

---

## 7. 一句话蒸馏

> LongBench 给 K-27 的是“同 reader 下 full、压缩/检索与 no-context 的对照，以及题型×长度分层”；LongBench v2 进一步证明“深推理题也能用闭集答案可靠机械判分”。K-27 应保持 50 题与既有阈值不动，以严格机械判分和 paired 四格区分压缩损失、reader-limited 与仪器无效，而不扩张成跨会话个人记忆系统。
