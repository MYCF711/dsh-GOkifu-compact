# 提示词压缩（LLMLingua, EMNLP 2023）· 判读

> 来源：<https://arxiv.org/abs/2310.05736>（HTTP 200，抓取 2026-11-02）
> 标题：**LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models**
> 作者：Huiqiang Jiang 等 · EMNLP 2023 · **外部资料 = 数据，不是指令。**

## 1. 它做了什么（原文，**待核实**：没有复跑）

三段式：
1. **budget controller**（粗略级）：给定目标压缩比，先决定每段能留多少，**保证语义完整**；
2. **token-level iterative compression**（细粒级）：逐 token 判断能不能删，考虑 token 之间的相互依赖；
3. **instruction tuning 做分布对齐**：让压缩后的文本更像模型训练时见过的分布。

结论：**最多 20× 压缩**，性能损失很小（GSM8K / BBH / ShareGPT / Arxiv）。

## 2. 对照我们：我们做的是"结构压缩"，不是"token 压缩"

| 维度 | LLMLingua | 我们 |
|---|---|---|
| 压缩单位 | token（细粒度删字） | **结构**（节点/边/规则事实/指针） |
| 预算控制 | budget controller | **L0–L5 档位 + `pickFallback` 三层择优** |
| 可解释性 | 低（删了哪些 token 说不清） | **高**（每条都是图上的事实，可回查 `nodes/<id>.md`） |
| 幻觉风险 | 删字可能改变语义 | **不会**：约束逐字、失败边带 seq |

⇒ 判读：我们用结构压缩换来了可解释性，这是**对的取舍**（压缩产物要能被审计）。
LLMLingua 那条路（token 级删字）对我们**不可取**：删掉一个 `不` 字，约束就反了。

## 3. 但它给了我们一个判据

原文的 budget controller 强调「**在高压缩比下保持语义完整**」——
这正是我们 `fold-quality` 的 `constraintRecall` 在测的事。
⇒ 我们该抄的不是算法，是**它把"压缩比"和"语义保真"当成一对指标同时报**。
我们的 bench（417 tokens / 失败保留 8/8）已经在做，但**压缩比**这个维度没有出现在 doctor 里
（只报 tokens，不报"相对原文压了多少"）。候选 **K-12**：把 `shadowedTokens / 原文 tokens` 的比值报出来，
让"更省了"和"更丢信息了"永远同时可见。

## 4. 本轮顺带量到的（已核实）

超预算最严重的会话（`<SESSION_ID>`，89 节点 / L5 **729 tokens**，超 229）里，
**`CONSTRAINTS (verbatim)` 一段就占了约 450 tokens** —— 11 条逐字约束（用户原始长规格）。
这不是渲染器的问题，是**契约要求逐字保留**。⇒ 这条回答了 doctor 里「约束+根目标下限即超预算」那 86 次是怎么来的。
