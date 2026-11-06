# 07 · 触发点与预算：何时压、压多少、失败怎么办

> 2026-11-02 · 调研（单问题版）
> **唯一问题**：生产级 agent 在**什么时候触发**上下文压缩、**给压缩多少预算**，以及「太早压 / 太晚压」各自的代价 —— 其中哪一小部分能安全用到本插件（一个只做压缩的后端）。
>
> **范围纪律**：只谈「何时压 / 压多少 / 失败怎么办」。跨会话记忆、知识库、检索、行为指导一律不碰（判据见 `docs/压缩的职责边界.md` §1）。**已有结论不重复**：三层通道、ρ^k 衰减、失败边逐字保留、热清单选边 —— 见 `00-蒸馏-对本插件的可执行结论.md`；本文只补它没回答的那一格。
> **取证方式**：`web_search` 不可用，全靠 `web_fetch` + `curl` 定向抓 `.md` 镜像与 GitHub 源码；Codex 侧读的是 `main` 分支**当前源码**（不是文档转述）。

## 0 · 结论先行（六条，按可信度排序）

| # | 结论 | 证据等级 |
|---|---|---|
| 1 | **头部产品里没有一个是「按窗口百分比」压的**：Claude Code 按**绝对 token 窗口**（贴模型上限），Codex 按**活跃上下文占比 65%**，OpenHands 按**事件条数 120**。三种信号族，没有统一比例。 | 【核实·原文】【核实·源码】 |
| 2 | **「太晚压」的第一后果不是效果差，是压缩请求本身放不下**：Codex 在压缩途中收到 `ContextWindowExceeded` 的处理是「删掉最老一条历史再重试」。 | 【核实·源码】 |
| 3 | **「太早压」的代价是实打实的**：压缩要重读它要总结的全部历史、必然废掉对话层缓存、且官方明确警告「过度压缩会丢后来才重要的细节」。Claude Code 的空闲压缩甚至给这个成本设了**下限 100K tokens**。 | 【核实·原文】 |
| 4 | **「摘要该多长」几乎没人公开**：能查到的只有 Codex 的「保留 user 消息 ≤20K」、LangMem 示例的 128 tokens、BC 生产实测的**中位 185 tokens**。**「超过多少就没意义」没有任何公开拐点。** | 【核实·源码】【二手】【未公开】 |
| 5 | **「提前算好」这件事有人试过，但没成**：Codex 的 Prefix Compaction PR（后台预热前缀压缩）**已关闭、未合并**；真正上线的是 Claude Code 的**空闲压缩**（趁你不在时压真压缩）与 Codex 的**后台异步压缩**。 | 【核实·原文】【核实·源码】 |
| 6 | **失败降级的主流形态是「换一种压缩实现」而不是「重试同一个」**：Codex 三形态并存（摘要 / 远程 / 直接开新窗口），Claude Code 用 thrashing 保护**停止重试**。**没有一家做规则摘要兜底。** | 【核实·源码】【核实·原文】 |

## 1 · 触发点：谁用什么信号

### 1.1 横向表（只填抓到的，抓不到写未公开）

| 产品 | 触发信号 | 公开值 / 原文 | 等级 |
|---|---|---|---|
| **Claude Code** | **绝对 token 窗口**（不是百分比）+ 空闲 + 手动 | 200K 窗口的模型在 200K 边界压；原生 1M 模型「约 **967K** tokens」；`/autocompact 500k` 可下调，范围 **100K–1M**；闲置时也会压（`idleCompaction` 默认 true） | 【核实·原文】[model-config](https://code.claude.com/docs/en/model-config)、[settings-reference](https://code.claude.com/docs/en/settings-reference) |
| **Codex** | **活跃上下文占窗口的百分比** | `DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT: u8 = 65`；判定式 `active_context_tokens * 100 >= limit * percent`；可配 1–100；另有绝对量 `model_auto_compact_token_limit`；`model_post_turn_compact_threshold_percent` 默认 **0 = 关** | 【核实·源码】`core/src/config/mod.rs:230`、`session/context_window.rs`、`session/async_compaction.rs` |
| **OpenHands** | **事件条数** | `max_size` 默认 **120**（事件数），`keep_first` 默认 **4**；每步 `condense()` 检查 | 【核实·原文】[condenser](https://docs.openhands.dev/sdk/arch/condenser) |
| **Devin** | 未公开 | 本轮在 `docs.devin.ai` 的 `llms.txt` 与 API 索引（318 页）里**搜不到** compaction 相关页；`02` 记的 `agent.compaction_threshold_tokens` 本轮**未能复现** | 【二手】/【未公开】 |
| **Cursor** | 未公开 | 官方文档无压缩页；用户观测「10–20% 就摘要」（论坛，`02` §2.2） | 【二手】 |
| **LangGraph / LangMem** | **应用自定义** | `max_tokens_before_summary` / `max_summary_tokens`（示例值 256 / 128，非默认） | 【二手】`02` §5.1 |
| **DSH `dsh-compaction-basic`** | 窗口比例 | `floor(min(W×0.8, W−O−headroom))`，`headroom=65536`、`retainRatio=0.16` | 【二手】`docs/市场对标.md` §4.6 |
| **本插件** | 窗口比例 + 增长闸 + 首折削峰 | `0.45` / `0.30` / `40000`，见 §7 的算术 | 【核实·源码】`src/rooms/config-schema.mjs:30,39,69` |

### 1.2 三个必须记住的细节

1. **Claude Code 的「967K」是能力上限减余量，不是比例**。1M 模型压在上限前约 3.3%（967/1000，**此百分比为本文推算**），200K 模型则压在 200K 边界；官方从不给百分比，只给 token 数，且按模型硬编码。【核实·原文】
2. **Codex 是唯一给默认百分比的**，但它同时保留四个触发面：百分比、绝对 token 限、post-turn 百分比、后台预热；`PreTurn / PostTurn` 两相位分开判。【核实·源码】
3. **只有 Claude Code 把「空闲」当触发信号**，且是**唯一带尺寸下限**的触发：默认要求上下文达 **200,000 tokens**，环境变量可改但**低于 100,000 会被抬回 100,000** ⇒ 官方在为「太早压」设防。【核实·原文】

### 1.3 本插件该不该采纳

| 信号 | 判定 | 理由 |
|---|---|---|
| 窗口百分比（Codex 65% / BC 0.45） | ✅ **已在用**（0.45） | 唯一能和「窗口大小未知」解耦的判据；本插件的 fold 是增量的，早压的成本结构与全量摘要不同（§2.3） |
| 绝对 token 限 / 事件条数（Claude Code 967K、Codex `model_auto_compact_token_limit`、OpenHands 120） | ❌ 不采纳为**主判据** | 前者要把每个模型的窗口硬编码，网关别名一换就错位（Claude Code 自己的应对是「识别不到就按 200K 假定并警告」，本插件没有告警面）；后者与本仓事件体积方差（单条工具输出可上万 token）不相关 |
| 增长闸（BC 50K / 本插件 40K） | ✅ **已在用** | 它是「同一段历史别反复压」的唯一防线，且经验上比比例更能防 thrashing（§3） |
| 空闲触发（Claude Code idle） | ❌ 不采纳 | DSH 不提供空闲事件；且空闲压缩本质是「提前把真压缩做掉」，与本插件「只在 `summarize()` 里工作」的契约冲突（`02` §7） |

## 2 · 太早压的代价

### 2.1 一次压缩就是一次大请求（官方原话）

- **Claude Code costs 文档**：「*`/compact` reads the conversation it summarizes, so compacting a large context is itself a large request. When you want a fresh start instead of continuity, `/clear` costs nothing*」【核实·原文】[costs](https://code.claude.com/docs/en/costs)。⇒ 压缩的读入成本 ∝ **被压缩历史的规模**，与「还有多少空间可用」无关。
- **缓存必然被废**：「*Compaction replaces your message history with a summary. By design, this invalidates the conversation layer: the next request has a new, shorter history that doesn't share a prefix with the old one.*」；这类 miss 被单独计为 `expected rebuild (compaction or tool-result clearing)`【核实·原文】[prompt-caching](https://code.claude.com/docs/en/prompt-caching)。
- 同一页还给了一条**时间比数量更重要**的官方建议：「*run `/compact` at a natural break in your work, such as between tasks, instead of waiting for auto-compaction to trigger mid-task*」【核实·原文】⇒ 官方承认「任务中途压」有额外代价，只是它没能自动判定「自然断点」（断点判定属宿主/UI，不属压缩，本文不采纳）。

### 2.2 「压太早」还有一个质量代价

- Anthropic 工程博客：「*overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later*」，调参顺序定为**先 recall 再 precision**【核实·原文】[原文](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)。
- Claude Code 的 `/compact` 在**内容太少**时直接拒绝：`Not enough messages to compact.` —— 官方给的成因包括「单次大粘贴就把窗口填满」，即**按比例触发时可能根本没有可压的东西**【核实·原文】[troubleshooting](https://code.claude.com/docs/en/troubleshooting)。

### 2.3 本仓已有的量化（比外部更贴近我们）

`06-可引用数字表.md` §三 记了三次 live fold 的实算【本仓实测】：**摘要读入 ≈ 遮蔽量 × 1.56**（一次性成本）；回本请求数 **N\* ≈ 1.58 次请求**；但若把读入成本也扣掉，同一批 fold 是 **+271,333 tok（省）/ −160,261 tok（含读入）** —— **单次净额是负的，净赚来自「之后每次请求都少带这段」**。

⇒ 对本插件，「太早压」= 把一次 fold 的固定成本（读入 1.56×遮蔽量 + 一次缓存重建）摊到更少的后续请求上。**代价函数是「fold 频次 × 单次读入」，不是「剩余空间」。**

**量化缺口**：没有任何产品公开「提前 X% 压导致多花 Y%」的数字 —— 【未公开】。本文不编。

### 2.4 该不该采纳

| 做法 | 判定 |
|---|---|
| 「fold 必须越过回本线」 | ✅ **已在用**（`minFoldTokens` 8000、`growthFloorTokens` 40000），且这是本文找到的**唯一有本仓实测支撑的预算纪律** |
| 「把阈值降到 20–30% 更安全」 | ❌ 不采纳 | 没有证据支持；Claude Code 的空闲压缩反而设 100K 下限，方向相反 |

## 3 · 太晚压的代价

### 3.1 压缩请求本身可能放不下（最硬的一条）

Codex `core/src/compact.rs` 的重试循环里，专门有一个分支：

```rust
Err(e) if matches!(e.details(), CodexErrorDetails::ContextWindowExceeded) => {
    if turn_input_len > 1 {
        // Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.
        history.remove_first_item();
        retries = 0;
        continue;
    }
    ...
```

即：**压得太晚时，连「读全量历史来总结」这个请求都会超窗**，实现只能从最老的一条开始丢，直到装得下【核实·源码】。这是「晚」的直接、可观测的后果，比任何效果论都硬。

### 3.2 thrashing：被命名的失败，但没被量化

- 错误文本：`Autocompact is thrashing: the context refilled to the limit...`；触发条件是「压缩成功但文件或工具输出**立刻又把窗口填满**，连续几次」，此时**停止重试**以免空烧 API【核实·原文】[troubleshooting](https://code.claude.com/docs/en/troubleshooting)。
- 官方**没有给出「几次」的具体数字**（原文是 "several times in a row"）——【未公开】。
- 同类现象：Cursor 论坛「10–20% 就摘要、然后卡在循环里」、Devin 变更日志「Unnecessary compaction is no longer triggered on every turn」；归因（`02` §6.D，本轮未推翻）：thrashing 的根因通常不是压缩算法，而是**触发判定与实际占用不一致**（超大单条输出、token 计数偏差）【二手】。

### 3.3 靠近上限时，摘要器自己在「rot 区」工作

- Chroma《Context Rot》（2025-07，**18 个模型**）：模型对上下文的利用**不均匀**，输入越长性能越不稳，且在**简单任务**上就能观察到【核实·摘要】[原文](https://www.trychroma.com/research/context-rot)。
- NoLiMa（2502.05167）：把 needle 与问题的字面重叠压低后，**32K 处 11 个模型掉到短上下文基线一半以下**【核实·摘要，转引 `01` §5.5】。
- ⇒ **越晚压，摘要请求读到的那份历史越长、越不可靠**；而摘要又是唯一一次「把历史交给模型重写」的机会。这条是「晚」的质量代价，方向明确、**无量化**。

### 3.4 该不该采纳

| 做法 | 判定 |
|---|---|
| 把「压缩无效」当一等错误 | ✅ **已落地**（`foldThrash`，`src/engine.mjs:779-783`），且比 Claude Code 更早（间隔 <30 事件即累计） |
| 等接近上限再压（Claude Code 路线） | ❌ 不采纳 | 它靠「贴上限 + 确定性重注入表 + thrashing 保护」兜底，本插件没有那张重注入表，贴上限等于把风险全押在摘要上 |
| 用「压缩前先做确定性修剪」（Codex `toolResultPruner` / DSH 自带 pruner） | ✅ 已在调用链里（`engine.mjs` overflow 分支与阈值分支各 prune 一次），但**只在触发之后**；见 §5 的「提前算」 |

## 4 · 预算：摘要给多少、常驻给多少

### 4.1 摘要输出预算

| 来源 | 预算 | 等级 |
|---|---|---|
| Codex 本地摘要 | **没有显式输出上限**；唯一的硬预算落在**保留的 user 消息**：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（从最新往前装，装不下丢图片/音频）。摘要 prompt 本身 426 字节、固定前缀 399 字节 | 【核实·源码】`compact.rs:63,718+`；【核实·原文】GitHub contents API |
| Claude Code | **未公开**（摘要是一次普通模型响应，文档只写「继承会话的 extended thinking 配置」，v2.1.198+） | 【核实·原文】/【未公开】 |
| LangMem `SummarizationNode` | `max_tokens=256`、`max_summary_tokens=128`（**示例值，非默认**） | 【二手】`02` §5.1 |
| OpenHands | 不给 token 预算，给**减半目标**：超过 `max_size` 后压到约 `max_size // 2`（事件数口径） | 【二手】`02` §5.2（本轮原文只确认 120/4） |
| BC 生产实测 | 每次压缩**产出中位 185 tokens，97.5% ≤ 2K**；折叠量中位 2.6K | 【二手】`06` #5/#6（BC 论文 §6.2） |

**「预算超过多少就没意义」**：查遍上述来源，**没有任何公开拐点**【未公开】。能查到的只有三类替代证据：
① **单项上限**（Claude Code：单个 skill 正文 ≤5,000 tokens、总量 ≤25,000、单文件 >5,000 只回路径引用、auto memory 前 200 行/25KB）；
② **方向性证据**：上下文越长越不可靠（§3.3），以及「token 只需 1/3、端到端反而慢 20–80%」（`01` §5.7，2609.32961）；
③ **本仓口径**：摘要产物实测 594–804 tokens（`06` #7/#9）。

### 4.2 热上下文（每步常驻）预算

| 来源 | 预算 | 等级 |
|---|---|---|
| Claude Code | skill 正文 5k/skill、25k 总量；重读文件最多 5 个、>5k 只给路径；CLAUDE.md「建议 <200 行」 | 【核实·原文】 |
| Codex | user 消息 20K；canonical initial context 每次重插 | 【核实·源码】 |
| 本插件 | 热清单 **500 tokens/步**（`hotLedgerMaxTokens`），实测 446–594 tokens | 【核实·源码】+【本仓实测】`06` #8/#9 |

⇒ **本插件的热上下文预算比所有能查到的产品单项上限小一个数量级以上**（500 vs 5,000/20,000）。「再加就浪费」的边界**远未触及**；反过来，任何为了省这 500 tokens 而砍失败边的改动，代价远大于收益（这也是 `00` §10 里 C4 只进摘要、不进热清单的原因）。

### 4.3 该不该采纳

| 做法 | 判定 |
|---|---|
| 摘要输出设**上限**而不设**目标** | ✅ **已在用**（`maxTokens` 8192；实测产物 594–804，远未顶满） |
| 把 `maxTokens` 调到 1–2K「省成本」 | ❌ 不采纳 | 没有证据表明摘要越长越差；`00`/`01` 已否定「压得更小=更好」；且摘要是**一次性**产物，省它省不出钱 |
| 保留 user 消息的硬预算（Codex 20K） | ⚠️ 有条件 | 本插件的对应物是 `retainRatio 0.16`（=200K 窗口下 30.7K 逐字尾部），语义等价、已覆盖；不需要另加一层 |
| 给热清单加预算**分项下限** | ❌ 暂不 | `00` §11 #16 已按 live 数据下调优先级（根目标/约束并未被压没），本轮无新证据推翻 |

## 5 · 能不能提前算好（pre-compaction / oracle）

### 5.1 三种「提前」形态，只有两种真上线

| 形态 | 谁做过 | 状态 | 等级 |
|---|---|---|---|
| **提前把压缩做掉**（空闲时压真压缩） | Claude Code `idleCompaction` | **已上线**：上下文 ≥200K（下限 100K）+ 空闲约 1 小时 + 该会话在 1 小时 cache TTL 上 ⇒ 压完后用户下一句话直接发摘要；提示语 `Compacted while idle, before the prompt cache expired` | 【核实·原文】 |
| **后台并行压缩**（压缩请求在后台跑） | Codex `Feature::AsyncCompaction` + V2 远程压缩 | **已合并**：`PreTurn/PostTurn` 两相位，判定式同 §1.1；需 feature flag 与服务端支持 | 【核实·源码】`session/async_compaction.rs` |
| **前缀预热**（到较低阈值就先算前缀压缩，正常阈值到达时若没好就让前台赢） | Codex PR #17286 "Prefix Compaction" | **已关闭、未合并**（`state: closed`、`merged_at: null`、`closed_at: 2026-05-16`） | 【核实·原文】GitHub API |
| **失败后补一次**（LLM 报上下文错误 → 写 `CondensationRequest` → 下一步再压） | OpenHands | 已文档化 | 【二手】`02` §5.2 |
| **压缩前挂 hook**（归档 transcript） | Claude Code `PreCompact`（`trigger: manual\|auto`） | 已上线，但**只归档、不预热** | 【核实·原文】`02` §1.6 |

**读法**：唯一「把压缩挪出关键路径」的**生产形态**是「趁闲时做真压缩」和「后台并行跑压缩」；「预计算 fold 计划但不压」这一形态**没有人公开做过**，唯一的近似提案（prefix 预热）死在了 PR 阶段。

### 5.2 对本插件的可行性

- 约束：`summarize()` 是 DSH 唯一认可的压缩钩子（`02` §7），**非压缩时点不能发起压缩请求**，也不能提前写 `graph.json`（会与宿主事务/锁抢状态）。
- 可用面：`hot-inject` 跑在 `agent/pre-step` 的 waterfall 里（`src/rooms/hot-inject.mjs` 文件头），**每步都会读到图** ⇒ 唯一安全的「提前」是**纯计算**：每步算一次「若现在压，会选哪段区间、能省多少、摘要要读多少」，结果只放内存、不落盘、不发请求，真到 `summarize()` 时复用。

| 做法 | 判定 |
|---|---|
| 每步预演 fold 计划（纯函数、内存、不落盘） | ⚠️ **有条件采纳**：必须先证明「同一 session 的两次预演结果一致」（可单测），且**不产生任何日志/事件**，否则等于在非压缩时点写状态 |
| 后台/空闲发起真压缩 | ❌ 不采纳 | DSH 无空闲事件；后台请求会与宿主的 compaction 事务（`surfaceOp: replace`）竞争 |
| 前缀预热（PR #17286 路线） | ❌ 不采纳 | 提案未合并、无生产数据；且它省的是「已经不需要省」的时延（本插件单次 fold 的摘要读入只有遮蔽量的 1.56 倍） |
| 预判「这次 fold 会不会无效」 | ✅ **建议做** | 预演时可以顺带算出「压完还剩多少」，若剩余 > 阈值就提前标记（纯观测，不改行为）—— 这正好补上 §6 的缺口 |

## 6 · 失败与降级

### 6.1 Codex：三形态 + 四条失败分支（读源码逐条）

三形态（共用同一套 PreCompact → `ContextCompaction` item → 替换历史 → PostCompact 生命周期）：

1. 本地 LLM 摘要（`compact.rs`）；
2. 远程/服务端压缩（`compact_remote_v2.rs`）；
3. **token-budget 压缩：不摘要，直接 `start_new_context_window()`**，源码注释原话「*skips model/server summarization and installs a fresh context window instead*」【核实·源码】`compact_token_budget.rs`。

失败分支（`compact.rs` 的 `match attempt_result`）：

| 分支 | 处理 | 等级 |
|---|---|---|
| `Interrupted` / `TurnAborted` / `SessionBudgetExceeded` / `ResponseIncomplete` | **立即失败，不重试** | 【核实·源码】 |
| `ContextWindowExceeded` | 删最老一条历史、`retries = 0`、重来（保前缀缓存） | 【核实·源码】 |
| 其它错误 | 退避重试，上限 = provider 的 `stream_max_retries()` | 【核实·源码】 |
| 压缩模型本身不可用 | `compact_model_fallback.rs`：`should_retry_with_current_model()` ⇒ **换当前模型再压一次**（同模型不重试） | 【核实·源码】 |

**注意**：Codex **没有任何「降级到规则摘要」的路径**。它宁可直接开新窗口，也不生成一份机械摘要。

### 6.2 Claude Code：不重试，直接报错

- thrashing：连续几次「压完立刻又满」⇒ **停止重试并报错**，官方给的恢复手段是「分块读文件 / 带 focus 的 `/compact` / 挪到 subagent / `/clear`」【核实·原文】。
- `Not enough messages to compact.`：内容太少时直接拒绝；关掉 auto-compact ⇒ 撞上限时抛上下文错误，不再尝试压缩【核实·原文】`model-config`。

### 6.3 本插件现状（对照）

| 能力 | 现状 | 判定 |
|---|---|---|
| 失败降级 | `summaryMode: hybrid` 下模型不可用/抛错 ⇒ **规则摘要**（零模型，机械抽取事实）`src/engine.mjs:412-428` | ✅ **比 Codex 更保守**，且与「事实抽取 + 可回溯」架构一致；**保留** |
| 失败可观测 | `foldFailures` / `lastFoldError` 计数；成功即清零（`engine.mjs:757-772`） | ✅ 保留（「当前有故障」语义正确） |
| 失败不污染状态 | fold 抛错 ⇒ 用 `toJSON` 快照回滚整张图（`engine.mjs:731-739,754-760`） | ✅ 强于所有外部实现（它们不回滚） |
| 重试 | **插件自身不重试**（`compactionRetries` 是宿主配置项，默认 1） | ⚠️ 可接受：重试会把「一次大请求」变成两次，且宿主已有 |
| 降级后再判「有效吗」 | 规则摘要也记 `quality`（C11），但**没有「降级后仍然无效就停手」**的判定 | ❌ **缺口**：Codex 有「换模型再试」、Claude Code 有「停止重试」，本插件缺「连续无效就熔断」 |

### 6.4 该不该采纳

⇒ **保留「降级到规则摘要」**（Codex 不做是因为它能选择「直接开新窗口」；本插件不能开新窗口，规则摘要是唯一无损退路）。
**不采纳**「换模型重试」（本插件不 pin 压缩模型，等价于跟随路由）与「不摘要直接开新窗」（会丢光失败边，越红线）。

## 7 · 与本插件现状的对照（`0.45 / 0.30 / 40000`）

### 7.1 数值对照

| 方案 | 触发点（按 200K 窗口折算） | 折算比例 |
|---|---|---|
| 本插件首折 `firstFoldRatio` | 60,000 | **30.0%** |
| 本插件常规 `thresholdRatio` | 90,000 | **45.0%** |
| Codex 默认 | 130,000 | 65% |
| DSH `dsh-compaction-basic` | 163,840 | ~80% |
| Claude Code（200K 模型） | ~200,000（边界） | ~100% |
| Claude Code 空闲压缩下限 | 100,000 | 50%（仅在空闲时） |

⇒ **本插件是这一组里触发最早的**，唯一比它早的是「空闲压缩」那条特殊路径的下限。

### 7.2 但「最早」不等于「最贵」：成本结构不同

`engine.mjs` 的 fold 只压**上一个 checkpoint 之后**的区间（增量），摘要读入实测 = 遮蔽量 × 1.56（`06` #13）；而 Claude Code / DSH 的压缩是**读全量历史重写** ⇒ 同一个 45%，在本插件里是「读 45%×(1−保留) 的增量」，在全量摘要产品里是「读 100%」。**45% 这个值的合法性来自「增量」，不来自「45% 本身更优」** —— 若哪天改成全量重摘，45% 会立刻变成最贵的配置。

### 7.3 三条纯算术发现（不跑测试，直接由 `resolveSpec` 推导）

`resolveSpec`（`src/engine.mjs:1007-1009`）：
`messageBudget = W − 输出预留`；`pressureBudget = messageBudget − 65536`；`阈值 = floor(min(W×ratio, pressureBudget))`。取 `maxTokens=8192`：

| 窗口 W | 常规阈值 | 首折阈值 | 说明 |
|---|---|---|---|
| 200,000 | 90,000（45.0%） | 60,000（30.0%） | 两个比例都生效 |
| 128,000 | 54,272（**42.4%**） | 38,400（30.0%） | `headroomTokens` 开始压过比例 |
| 100,000 | 26,272（**26.3%**） | 26,272（26.3%） | **首折削峰失效**（被 pressureBudget 顶平）；触发点被拉到 26% |
| ≤73,728 | — | — | `pressureBudget ≤ 0` ⇒ **折叠后端起不来，直接抛错** |

三件事：

1. **`firstFoldRatio` 只在 W ≳ 105.3K 时真的提前首折**（条件：`0.30W < W − 73728`）。小窗口上它是空设置。
2. **`headroomTokens = 65536` 是绝对值**，它在小窗口上把 45% 变成 26%，在 ≤72K 窗口上直接抛错。这是「预算」里**唯一一条纯算术、可单测、风险却最大**的项。
3. **`growthFloorTokens = 40000` 在小窗口上会变成主导项**：100K 窗口下，fold 后约剩 15.8K，再涨 40K 才允许折 ⇒ 实际触发点被推到 ~55.8K（≈56%），**比例闸形同虚设**。

### 7.4 判定

| 现状 | 判定 | 依据 |
|---|---|---|
| `thresholdRatio 0.45` | ✅ **保留** | 有 `市场对标` 的 BC 生产依据；且本插件是增量 fold，早压成本被 `growthFloor` 与 `minFoldTokens` 双重约束 |
| `firstFoldRatio 0.30` | ⚠️ **保留但加断言** | 语义（首折削峰）成立，但**在 <105K 窗口上静默失效**；建议加一条纯函数测试锁住「生效窗口下限」，并在 doctor 里显示「本窗口首折是否生效」 |
| `growthFloorTokens 40000` | ⚠️ **保留但需按窗口核** | 200K 窗口下阈值闸主导（90K），40000 不咬合；100K 窗口下它反过来主导（推到 56%）。**至少要在 doctor 里把「实际触发点」算出来显示**，否则配置面板上的 45% 是假的 |
| `headroomTokens 65536` | ❌ **建议改** | 固定 64K 余量在 ≥105K 窗口上无害，在 <105K 上篡改比例、在 ≤72K 上直接抛错；改成 `min(65536, W×k)` 或按输出预留比例缩放，是**纯算术改动**（但属于配置语义变更，需单开一刀） |

## 8 · 净结论：这一小部分能安全用

### 8.1 采纳（4 条，全部是「何时/多少」层面的）

1. **触发用「比例 + 增长闸」双闸**，且比例只当**下限**用 —— Codex 65% 是它的下限不是目标（它还有后台相位）；本插件 45% 同理。**证据：Codex 源码 + BC 生产 + 本仓 45% 已落地。**
2. **每次 fold 必须越过回本线** —— 本仓实测 N\*≈1.58 请求、读入 ≈1.56×遮蔽量。已由 `minFoldTokens`/`growthFloorTokens` 承担。**证据：本仓实数（最强的一档）。**
3. **失效要当一等错误，且升级成「熔断」** —— 学 Claude Code 的 thrashing，但本插件目前只记不熔断。**证据：Claude Code 原文 + 本仓 `foldThrash` 半落地。**
4. **失败降级保留「规则摘要」，不学「开新窗口」** —— 后者会丢失败边，越界。**证据：Codex 三形态源码 + 本仓边界判据。**

### 8.2 明确不采纳（3 条）

1. **绝对 token 触发**（Claude Code 967K 式硬编码）—— 与网关/别名冲突，且本插件无告警面。
2. **空闲/后台预热压缩**（Claude Code idle、Codex async、PR #17286）—— DSH 无对应生命周期；PR 本身也未合并。
3. **摘要输出压到 1–2K 省成本** —— 没有证据支持，且 `01` §5.7 已证「压得更小 ≠ 更好」。

### 8.3 可做的下一步（都不改行为，除最后一条）

| # | 动作 | 风险 |
|---|---|---|
| a | doctor 显示「本窗口实际触发点 / 首折是否生效 / 增长闸是否主导」——纯展示，不改判据 | 小 |
| b | 给 `resolveSpec` 加纯函数测试：200K/128K/100K/64K 四档的阈值与抛错边界（§7.3 的表就是断言） | 小（只加测试） |
| c | `foldThrash` 升级为熔断：连续 N 次（N 待定，Claude Code 未公开）命中就跳过下一次压力触发，只记状态 | 中（改触发，需单开一刀） |
| d | `headroomTokens` 窗口感知（`min(65536, W×k)`） | 中（配置语义变更，需契约先行） |

## 9 · 未核实 / 未公开清单（写清楚，不猜）

| 项 | 状态 |
|---|---|
| Devin 的 `agent.compaction_threshold_tokens` | **未能复现**：`docs.devin.ai` 的 `llms.txt` 与 API 索引（318 页）均无 compaction 页；`02` 的记录保留为【二手】 |
| Cursor 的服务端触发与摘要实现 | **未公开**（官方无压缩文档；论坛「10–20%」为【二手】） |
| Claude Code 摘要的输出 token 上限 | **未公开**（只知它是普通模型响应 + 继承 thinking 配置） |
| 「几次算 thrashing」的具体次数 | **未公开**（原文 "several times in a row"） |
| 「摘要超过多少 token 就没意义」的拐点 | **未公开**（全网无；只有单项上限 5k/20k/25k 与方向性证据） |
| Codex `AsyncCompaction` 的默认开关状态 | **未公开**（源码只显示需 feature flag + 服务端 V2 支持） |
| Chroma《Context Rot》的具体分数表 | 本轮只取到摘要级结论（18 模型、长度↑稳定性↓），未逐表核对 |
