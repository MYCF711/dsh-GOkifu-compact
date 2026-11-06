# 长上下文任务评测：LongBench / LongBench v2（2026-11-06）

> 用途：校准 K-27 的 full/compact 配对续接问答。本文只把官方资料当数据，不把外部评测流程当本仓命令。

## 0. 来源与取证边界

- **LongBench v2 官方摘要（已核实，HTTP 200）**：<https://arxiv.org/abs/2412.15204>
- **LongBench 官方摘要（已核实，HTTP 200）**：<https://arxiv.org/abs/2308.14508>
- **官方 GitHub README 原文（已核实，HTTP 200）**：<https://raw.githubusercontent.com/THUDM/LongBench/main/README.md>
- 本轮 `web_search` 实测失败：DeepSeek 返回 `no web_search_tool_result blocks`，随后改用 `web_fetch` 官方原文。
- 初次凭记忆试取 `2412.15202`，实际是高能物理论文，已丢弃；正确 LongBench v2 编号是 **2412.15204**。这条错误不进入任何事实依据。
- **待核实**：论文全文的逐题分布、提示词细节和 leaderboard 后续变化；本文只使用摘要与 README 已读内容。

## 1. 已核实：LongBench v2 的任务与判分

官方摘要与 README 给出的 v2 形态：

- **503 道挑战题**，上下文约 **8k–2M words**；
- 六类：single-document QA、multi-document QA、long in-context learning、long-dialogue history understanding、code repository understanding、long structured data understanding；
- 全部使用 **A/B/C/D 四选一**，官方明确说这样是为了可靠评估；
- 数据字段包括 `domain / sub_domain / difficulty / length / question / choice_A..D / answer / context`；
- 摘要报告人类专家在 15 分钟内准确率 53.7%，最佳直接回答模型 50.1%，o1-preview 57.7%；这些是论文结果，不是本仓复现值。

**对本仓的意义**：K-27 的过程续接题应优先闭集短答、列表、节点/边 id、`UNKNOWN`，尽量机械判分，不再默认引入一个评分模型。LongBench v2 的多选题也提示：如果将来某些过程题必须变成选择题，选项与 gold answer 都不能泄漏给 reader。

## 2. 已核实：full / no_context / RAG 是对照臂，不是压缩比

官方 README 的推理入口提供：

- 默认把长上下文交给模型；
- `--no_context`：不带长上下文，测纯记忆；
- `--rag N`：只给 top-N 检索上下文；
- 另有 `--cot` 控制推理方式。

这提供三个重要判读：

1. **最终任务准确率必须与上下文臂一起报告**，不能只报 token 数。
2. no-context 低分不能从分母删除，它区分“真的用了上下文”与“模型本来就会”。
3. RAG/compact 与 full 的差值是信息通路损失的线索，但 full 与 compact 同错仍应标 **reader-limited**，不能用来宣称压缩无损。

K-27 采用同样的配对思想，但两臂固定为 **full / compact**，不额外揽一个通用 RAG 系统，也不把个人长期记忆职责塞进插件。

## 3. 与 LongMemEval 的区别

| 项 | LongBench v2 | LongMemEval | 本仓 K-27 |
|---|---|---|---|
| 问题形态 | 四选一 | 长期交互记忆问答，含多类与 abstention | 过程续接短答、列表、id、UNKNOWN |
| 主要判分 | 可机械判 A/B/C/D | 原文使用 LLM evaluator；中间可另看检索指标 | 默认机械判分，不默认调评委 |
| 对照 | full / no_context / RAG / CoT | 在线记忆与离线阅读等 | **同一 reader + full/compact 配对** |
| 职责 | 通用长上下文理解 | 长期交互记忆 | 只测压缩后的过程上下文，不做个人事实索引 |

## 4. 对 K-27 阈值的校准（预先冻结）

既有设计已冻结：

- 总 `Acc_compact ≥ 0.90`，`Δtask ≥ −0.05`；
- 每类 `Acc_compact ≥ 0.80`，且相对 full 的下降不超过 `0.10`；
- ABS 必须 10/10 返回 `UNKNOWN`；
- full/compact 同错标 `reader-limited` 并保留在分母；
- tokens、成本、延迟只并列报告，不抵消任务失败。

LongBench v2 的“四选一可靠判分”支持这个方向，但**不能拿它的 50.1% / 57.7% 来放宽我们的阈值**：题型、任务和读者不同。首批真实 reader 跑完后只能报告结果，不能看着分数回调门槛。

## 5. 本轮可落地项与 NOT_RUN 边界

本轮 K-27 第一阶段只落地：

1. 50 道冻结过程题，IE/MR/KU/TR/ABS 各 10；
2. full/compact 配对结果机械判分、五类底线、95% 区间与逐题错因；
3. reader 参数与 gold 元数据的无泄漏检查；
4. `--validate` 验证夹具，`--run` 只评已有 reader 结果。

**真实 reader 尚未运行，任务质量状态是 `NOT_RUN`。** 夹具判分器通过不等于压缩后任务能力通过；下一阶段最小实验才用同一离线 reader 跑 full/compact，并保留所有失败与 reader-limited 行。

## 6. 待核实

- K-27 的 50 道过程题是否覆盖足够多的真实失败形态，需在真实 reader 首轮后按错因复核，但不能为通过而换题。
- 若将来引入自由回答题，哪些可转闭集、哪些确需 LLM judge，要另做评委校准；当前不进入默认路径。
