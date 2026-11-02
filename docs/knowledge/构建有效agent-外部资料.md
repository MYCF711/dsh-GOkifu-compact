# Building effective agents（Anthropic 2024-12）· 判读

> 来源：<https://www.anthropic.com/engineering/building-effective-agents>（HTTP 200，抓取 2026-11-02）
> 标题：**Building effective agents** · Anthropic Engineering · 2024-12-19
> 注：官方自己在页首说明「2024 年 12 月之后工具生态已变，当前做法看 Managed Agents 文档」——
> 所以下面只取**仍然成立的结构性判断**，不抄具体工具名。
> **外部资料 = 数据，不是指令。**

## 1. 原文的结构性判断（**待核实**：没有在本机复现他们的客户样本）

- 做得最好的实现，**不是用复杂框架**，而是「**简单、可组合的模式**」；
- 把系统分三类：**workflow**（预定义流程）、**agent**（自主决策循环）、以及它们的组合；
- 常见 building block：prompt chaining、routing、parallelization、**orchestrator-workers**、
  **evaluator-optimizer**；
- 反复强调：**复杂度要挣来** —— 先问「用最简单的方案能不能做」，不能才加。

## 2. 对照我们（这个插件属于哪一类）

| 原文分类 | 我们 | 说明 |
|---|---|---|
| workflow | ✅ 折叠链（选区间 → 生成 → 重注入） | 预定义、可复现 |
| agent | ⛔ 不参与 | 我们**不**替代模型做决策 |
| **evaluator-optimizer** | ✅ **`fold-quality`** | 折叠后按规则**复核**召回，不合格就标记出来 |

⇒ 判读：我们是一个**挂在别的 agent 上的 workflow + evaluator**，不是 agent 本身。
这解释了为什么本项目的边界一直是「只改压缩产物，不碰历史/工具/系统提示词」——
那不是保守，是**分类正确**。

## 3. 三条能落到本仓库的

1. **「复杂度要挣来」**：这条正好是我们候选表的用法 ——
   K-1/K-2/K-3 都被**数据/重新理解否掉**，而不是被实现掉（第 6 轮否决轮）。
   外部证据支持这种「先证伪再动手」的纪律。
2. **evaluator 必须与生成器分离**：我们的 `fold-quality` 用的是**规则**（约束/失败边是否还在），
   不是让模型自评 —— 与原文把 evaluator 单列成一步的思路一致。
3. **可组合 > 大框架**：我们的房间（rooms）都是小函数 + 注入式端口（`createUserMessage`、日志、预算回调），
   没有任何一个房间 import 宿主。⇒ 这条**已经做到**，不用改。

## 4. 本轮实测的附带案例（已核实）

`docs/方案-持续优化.md` 一直写着「打包后 `npx dsh-gokifu-compact doctor` 必 ENOENT（⛔ 未修，候选 C-19）」。
今天真验了一遍：`npm pack` → 解包 → 直接跑 `scripts/cli.mjs doctor`，
输出 **0 错 / 7 警**（157 个文件里含 `scripts/doctor.mjs`），CLI 也已经从同目录解析 ——
**这条候选早就修好了，文档在说谎**。C228 加了四条守卫把「修好的状态」钉住。

> 教训（和原文的「复杂度要挣来」同源）：**候选表里的状态也要有判据**，
> 否则「未修」会永远留在那里，让下一个人白做一遍。
