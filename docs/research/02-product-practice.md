# 工程实践：主流 agent 产品的上下文压缩（2026-11 调研）

> 读者：`dsh-gokifu-compact` 的维护者（棋谱式压缩后端）。本文只回答一个问题：
> **别人在「压缩/裁剪/摘要」这一环上，实际做了什么决定——触发、保留、丢弃、能不能回溯——以及哪些决定带来了可观测的故障。**
>
> 一句话结论：**主流产品在 2026 年已经收敛出「三层通道」——常驻重发层（rules / CLAUDE.md / AGENTS.md）、可丢弃层（工具输出、助手闲聊）、压缩后重灌层（文件、plan、todo、memory）——但绝大多数仍然把「压缩」等同于「一次不可逆的 LLM 摘要」。GOkifu 的差异点不在「压得更狠」，而在「压完之后仍然可回溯、且失败边不被摘要吃掉」。**

---

## 0 · 方法与局限

**抓取时间**：2026-11-01（Asia/Shanghai）。`web_search` 本机不可用，全部靠已知 URL + 各文档站点的 `llms.txt` 索引定向抓取。

**可达性实测**（决定证据密度，先说清楚）：

| 站点 | 结果 | 处理 |
|---|---|---|
| `code.claude.com/docs/...` | 【核实】`.md` 镜像全量可抓（Mintlify） | 本文 Claude Code 一节全部基于原文 |
| `docs.openhands.dev` / `docs.devin.ai` / `docs.crewai.com` / `docs.cline.bot` | 【核实】`.md` 或 `llms-full.txt` 可抓 | 原文 |
| `aider.chat` / `cursor.com/docs` | 【核实】HTML 可抓（正文可读） | 原文 |
| `docs.langchain.com` | 【核实】`.md` 可抓 | 原文 |
| `docs.windsurf.com` | **`.md` 与 `llms-full.txt` 都返回 SPA HTML**（636 KB 全文中 `compact`/`summarize` 零命中） | 只能判「未文档化」，设计细节走【未核实】 |
| `platform.claude.com`（context editing 页） | HTML 200 但正文为客户端渲染，抽不出内容 | 只引用 Anthropic 工程博客对它的描述 |
| `developers.openai.com` | 403 | 改用 `openai/codex` 仓库源码 |
| `cursor.com/llms-full.txt` | 404（返回整页 SPA 脚本） | 弃用，Cursor 一节改为「官方文档 + 论坛」 |

**证据分级**（全文每行都带）：

- **【核实】** — 本轮抓到了一手文本 / 源码 / issue 原文，能引原话或行号。
- **【二手】** — 抓到的是博客、论坛贴、变更日志，方向可信、细节不保证。
- **【未核实】** — 模型知识，本轮没抓到证据。**当作线索，不当作依据。**

**三条自我限制**：

1. 只看「压缩/裁剪/摘要」这一环。检索（Cursor 的 codebase index、Windsurf 的 Fast Context）、跨会话记忆（Devin Memory/Dreaming、Cline Memory Bank）只在它们**替代压缩**时才提一句。
2. 产品文档往往只写「用户可见行为」，不写实现。**「未公开」是本轮的常见结论，不是漏查**——§7 的对比表里这类格子直接写「未公开」。
3. 本仓 `docs/市场对标.md`（2026-10-28）已经记录过 DSH 自带 `dsh-compaction-basic` 的 8 段模板与 Compaction Cliff 数字，本文**不重复**，只在需要对照时引用它。

---

## 1. Anthropic / Claude Code

### 1.1 官方立场：压缩是「上下文工程」的第一根杠杆，不是补丁

Anthropic 工程博客把长任务的手段收敛为三件：**compaction / structured note-taking / sub-agent architectures**【核实，[原文](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)】。其中对 compaction 的定义与取舍写得最清楚：

> "Compaction is the practice of taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary."
>
> "The model preserves architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs or messages. The agent can then continue with this compressed context plus the five most recently accessed files."

同一节给了两条工程纪律，值得单独记：

- **"The art of compaction lies in the selection of what to keep versus what to discard"**，并明确警告 *overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later*。
- **调参顺序是「先 recall 再 precision」**：先在复杂 agent trace 上把压缩 prompt 调到「不漏」，再逐步砍冗余。
- **"clearing tool calls and results"** 被点名为**最低垂的冗余**，也是「最安全最轻的压缩」形态；对应平台侧的 context editing / tool result clearing 功能【核实：文章原话 + 其外链；**具体 API 形态（`clear_tool_uses` 的 trigger/keep 参数）本轮未抓到，属【未核实】**】。

### 1.2 触发条件（Claude Code 实测文档）

【核实，[model-config](https://code.claude.com/docs/en/model-config)、[context-window](https://code.claude.com/docs/en/context-window)】

| 场景 | 默认压缩点 |
|---|---|
| 一般情况 | 达到该模型的**上下文上限**时 |
| Sonnet 4.6 / Opus 4.6 **未开** extended context | **200K 边界** |
| 原生 1M 窗口模型（Fable 系、Sonnet 5+、Haiku 5.5、Opus 4.7+） | **约 967K tokens**（不是 1M 满） |
| 模型 ID 未识别（如网关别名） | 按 Claude Code **假定的 200K** 压，并在启动时警告 |

可调面（同一页）：

- `/autocompact 500k`（写进 user settings 的 `modelSettings`，按模型存）、`autoCompactWindow`（全局）、`--autocompact`（单次启动）、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（环境变量，优先级最高）；**取值范围 100K–1M**。
- **idle compaction**：会话闲置时也会压（可关）。
- **thrashing 保护**：压缩成功但「文件或工具输出立刻又把窗口填满」连续发生几次后，**停止重试并报错** `Autocompact is thrashing: the context refilled to the limit...`【核实，[troubleshooting](https://code.claude.com/docs/en/troubleshooting)】。这是本轮见到的**唯一一个把「压缩无效」当成一等错误**的产品设计。

### 1.3 压缩后保留什么：一张逐机制的清单

Claude Code 官方给了一张 **"What survives compaction"** 表【核实，[context-window](https://code.claude.com/docs/en/context-window)】，这是本轮最有价值的一手材料——它把「压缩」从「生成一段摘要」显式拆成「摘要 + 一批确定性重注入」：

| 机制 | 压缩后 |
|---|---|
| system prompt / output style | 仍生效 |
| 项目根 `CLAUDE.md`、无 `paths:` 的 rules | **从磁盘重注入** |
| auto memory（`MEMORY.md` 前 200 行 / 25KB） | **从磁盘重注入** |
| skill 描述 | 按当前 skills **重建**（需 v2.1.304+） |
| git status 快照 | 若会话开始时有一份，则**重新读一份** |
| plan mode 写的 plan | **从磁盘重注入** |
| 带 `paths:` 的 rules、子目录 `CLAUDE.md` | **按需重载**（不主动恢复） |
| Claude 读过/改过的文件 | **最多重读 5 个**，最近修改优先；单文件 >5,000 tokens 只回一个路径引用（`Referenced file`），不回内容 |
| 被调用的 skill 正文 | 重注入，**单 skill ≤5,000 tokens、总 ≤25,000 tokens**，最旧的先丢 |
| 后台命令 / 后台 subagent | **继续运行**，并提醒 Claude「它们还在跑」，防止重复启动 |
| 早期由 hooks 注入的 context | 跟其余历史一起被摘要（**不保证保真**） |
| 匹配 `compact` source 的 SessionStart hooks | 运行，输出并入压缩后上下文 |

另外一条容易被忽略的实现细节：**v2.1.198 起，摘要请求继承会话的 extended thinking 配置**（开着就用 thinking 生成摘要）【核实，同页】。

### 1.4 工具调用记录：默认丢，但有三个例外

- 默认：**工具调用与结果在压缩中丢弃**（官方博客原话，见 §1.1）。
- 例外一：**仍在运行的后台任务**——不保留输出，但保留「它还在跑」的提醒（防止重复启动同一命令）。
- 例外二：**被 Claude 读/改过的文件的最近 5 个**——不是保留旧内容，而是**重新读盘**（拿到的是最新版，可能已与摘要中的描述冲突）。
- 例外三：**工具结果清理是独立于整段压缩的另一档**（社区常称 microcompaction；官方文档只描述为 *"clearing old tool results from context"*，**未用这个词**）。官方 costs 文档在解释 prompt cache 统计时点名：*"when Claude Code has itself just rewritten the conversation, by compaction or by clearing old tool results from context, it counts the same kind of miss as an expected rebuild"*【核实，[costs](https://code.claude.com/docs/en/costs)】。**即：清工具结果是「预期内的缓存重建」，和整段压缩同等对待。**

### 1.5 成本：压缩本身是一次大请求，且必然破缓存

【核实，[costs](https://code.claude.com/docs/en/costs)、[prompt-caching](https://code.claude.com/docs/en/prompt-caching)】

- `/compact` 要**读一遍它要总结的全部历史**，所以「压缩大上下文本身就是一次大请求」。
- 但**代价落在哪一层，官方写得很具体**：*"Compaction replaces your message history with a summary. By design, this invalidates the conversation layer: the next request has a new, shorter history that doesn't share a prefix with the old one. The system prompt and project context layers can stay cached."* —— 即**被废掉的是「对话层」缓存，system prompt 与项目上下文（CLAUDE.md/auto memory）两层仍可命中**；压缩调用本身也用同一套前缀共享，能吃到缓存【核实，[prompt-caching](https://code.claude.com/docs/en/prompt-caching) 的 "Compacting the conversation" 节】。
- 压缩导致的缓存 miss 被单独归类为 `expected rebuild`；`/usage` 的缓存行会显示 `1 expected rebuild (compaction or tool-result clearing)`。
- 官方在「为什么长会话用量飙升」里把 **Compaction** 单列成一条成因。

### 1.6 Agent SDK 里的压缩：可观测、可挂钩、可下指令

【核实，[agent-sdk/agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)】

- 自动压缩时，流里会发出一条 `type: "system"` / `subtype: "compact_boundary"` 的消息（TS 侧是独立的 `SDKCompactBoundaryMessage` 类型）——**压缩边界是一等可观测事件**。
- **`PreCompact` hook**：压缩前触发，带 `trigger: "manual" | "auto"`，文档建议的用法就是「归档完整 transcript」。
- **压缩指令可写在 `CLAUDE.md` 里**（"Summary instructions" 段，标题自由，压缩器按语义匹配）。
- 文档反复强调：**持久规则放 `CLAUDE.md`（每请求重注入），不要放首轮 prompt**——因为首轮 prompt 会被摘要吃掉。

### 1.7 这一节最该记住的三件事

1. **压缩 = 摘要 + 重注入清单**。Claude Code 的「保留」不是靠摘要写得全，而是靠一张**确定性的重灌表**（§1.3）。摘要只负责「叙述」，不负责「恢复」。
2. **工具输出被明确判为可丢弃**，但「还在跑的后台任务」被明确判为必须保留（因为它会导致**重复劳动**）。
3. **压缩的失败模式被命名了**：thrashing（压完立刻又满）。能被命名的失败才有保护。

---

## 2. Cursor

**先说结论：Cursor 的压缩是服务端黑盒，官方文档没有一页讲它。** 可核实的只有「进上下文的一侧」和「用户观测到的一侧」。

### 2.1 官方文档覆盖的是「注入」，不是「压缩」

【核实，[cursor.com/docs/rules](https://cursor.com/docs/rules)、[help: @ mentions](https://cursor.com/help/customization/context)】

- rules 分四类：Project（`.cursor/rules/*.mdc`）/ User / Team / `AGENTS.md`；生效方式由 `alwaysApply` × `description` × `globs` 三字段决定（总是应用 / 按文件模式自动挂 / 由 Agent 读描述自行拉取 / 仅 @-mention 时）。
- 关键一句：**"When applied, rule contents are included at the start of the model context."** —— rules 是**每轮重发**的，所以**结构上不受压缩影响**。这是 Cursor 对「压缩后忘规则」的答案：把规则放进常驻通道。
- 上下文进入方式：`@` 文件/文件夹/终端/历史 chat/git diff 与分支 diff。
- 我在 `cursor.com/llms.txt`（27 KB 索引）里 grep `compact`/`summariz`：**零命中**；只有 `help/customization/context` 一页与上下文有关。⇒ **压缩机制没有公开文档页。**

### 2.2 用户侧能观测到的形态

【二手，Cursor 官方论坛】存在**自动的、服务端的**历史摘要，以及一个 `/summarize` 命令：

- `Context keeps summarizing at 10-20% of total context window`：用户报告「agent 只用到约 10% 窗口就开始摘要，摘要后忘了刚读的东西，然后卡在循环里」（topic [163850](https://forum.cursor.com/t/163850)）。
- `After context summarization, the agent loses active Skills and tool-usage knowledge`：明确写 *"the long-session, server-side summarization that compacts history"*，压缩后 **Active Skills 不被重新加载**、工具/MCP 用法知识退化（topic [164549](https://forum.cursor.com/t/164549)）。
- `Bug: /summarize command fails silently and does not free up chat context`（topic [173036](https://forum.cursor.com/t/173036)）；`Compaction not happening soon enough`（topic [149490](https://forum.cursor.com/t/149490)）；`[string_above_max_length] in automatic context compaction` 直接把 chat UI 卡死（topic [168194](https://forum.cursor.com/t/168194)）。

### 2.3 判定

- Cursor 的设计**重「检索/注入」、轻「压缩」**：codebase 索引 + `@` 选择 + rules 常驻，把上下文预算尽量花在「选对东西」上；一旦超出就交给服务端摘要，**没有公开的保留清单、没有压缩边界事件、没有 hook**。
- 对 GOkifu 的可学项只有一条：**把不可违反的约束放进每轮重发的通道**（Cursor 用 rules 开头重注，Claude Code 用 CLAUDE.md 从磁盘重注，GOkifu 用每步热清单）——三者是同一个动作的不同实现。
- 压缩实现细节（是否保留工具调用、是否增量）：**【未核实】**，不做推断。

---

## 3. Devin / Windsurf / Cline / Aider

### 3.1 Aider：repo map 是「结构化摘要」的教科书样本

【核实，[aider.chat/docs/repomap](https://aider.chat/docs/repomap.html)】

- **每次请求都发一份全仓地图**：文件列表 + 每个文件里的关键符号（类/方法/函数签名）+ 定义处的关键代码行（用 `⋮...` 省略函数体）。
- 大仓放不下时**不截断、不摘要，而是排序后择优**：以文件为节点、依赖为边构图，跑**图排序（graph ranking）**，把「与当前 chat 最相关」的部分塞进预算。
- 预算：`--map-tokens` **默认 1k tokens**；并**随 chat 状态动态伸缩**——"It will usually stay within that setting's value. But it does expand the repo map significantly at times, especially when **no files have been added to the chat**"。
- 地图里只留「被其它部分引用最多的标识符」，不是全部符号。

**这给出了与「LLM 摘要」完全不同的范式**：预算固定 → 候选全集结构化 → 用**图上的相关性排序**决定谁进来 → **不生成自然语言**。可复算、可解释、零模型调用。

### 3.2 Devin

【核实，[docs.devin.ai/onboard-devin/agents-md](https://docs.devin.ai/onboard-devin/agents-md)、[docs.devin.ai/llms-full.txt](https://docs.devin.ai/llms-full.txt)（CLI 命令表 + 变更日志）】

- **AGENTS.md 有硬性注入上限**：每个文件**自动注入前 16 KiB（16,384 B）**；超长时给模型一条**截断通知**，让它按需去读全文；文档建议「关键指令放前面，常驻内容压进 16 KiB，其余挪到 skills 或引用文件」。
- CLI 侧：`/compact` **手动**触发；`agent.compaction_threshold_tokens` 可让自动压缩**早于**「按窗口算的默认阈值」；`PreCompact` / `PostCompact` 钩子带 `manual`/`auto` 触发器（钩子失败不阻塞压缩）。
- **变更日志是本文最有价值的一手材料之一**（暴露了压缩的四个真实工程坑，全部【核实】）：
  1. *"`/steps`, `/revert`, and `/fork` now show and work with steps from before compaction. Previously, compacting a session made all earlier steps invisible and unrevertible."* ⇒ **压缩曾经直接破坏可回溯性**。
  2. *"Session resume no longer drops early conversation messages after multiple compaction rounds."* ⇒ **多轮压缩 + 恢复 = 丢早期消息**。
  3. *"Unnecessary compaction is no longer triggered on every turn when using the adaptive model."* ⇒ 触发条件写错会**每回合都压**。
  4. *"skills dropped from context by compaction are discovered again when the agent next touches their trigger paths"* / *"Skills discovered mid-session are listed again after context compaction instead of disappearing for the rest of the session."* ⇒ 压缩掉的技能要能被**重新发现**，否则整段会话丧失能力。
- 另有形态：`post_compaction` hook 会把**压缩摘要放到 stdin** 交给外部脚本（可落盘、可审计）。

### 3.3 Cline

【核实：docs + PR/issue】

- 术语是 **"auto condense"**（不是 compaction）：任务头部有 context 进度条 + 可配阈值（PR [#6049](https://github.com/cline/cline/pull/6049)「new Task Header UI with configurable auto condense threshold」）；阈值一度可以**点进度条误设**，后改为硬编码默认并禁用点击（PR [#9348](https://github.com/cline/cline/pull/9348)）。有 `PreCompact` hook（PR [#7513](https://github.com/cline/cline/pull/7513)）。
- **Memory Bank** 是它的「压缩替代品」：6 个 markdown 文件（`projectbrief` / `productContext` / `activeContext` / `systemPatterns` / `techContext` / `progress`），其中 `activeContext.md`「更新最频繁」，靠**结构化笔记跨会话续命**【核实，[docs.cline.bot/best-practices/memory-bank](https://docs.cline.bot/best-practices/memory-bank)】。
- 仍在开着的诉求：issue [#4389](https://github.com/cline/cline/issues/4389)「Improve Context Window Management and Large File Handling」（24 条评论）。
- 判定：Cline 把「阈值」交给了 UI，把「记忆」交给了用户自建的 markdown——**两者都不是压缩算法**。可学的是**把阈值做成显式可见的产品参数**（以及它踩过的坑：阈值必须不可误触）。

### 3.4 Windsurf

- 【核实】**官方全量文档 636 KB 中 `compact` / `summarize` 零命中**（`https://docs.windsurf.com/llms-full.txt`）。⇒ **压缩完全未文档化**。
- 官方文档覆盖的是检索侧：Context Awareness（RAG 索引 + pin）、**Fast Context**（专门的代码检索子代理；官方索引描述为「用 SWE-grep 模型、快至 20×」——【核实·仅索引摘要，未读正文】）、Memories & Rules（跨会话记忆）。
- Cascade 是否在窗口将满时自动摘要、摘要保留什么：**【未核实】**（模型知识：有，且用户可见「上下文用量」指示；但本轮无证据，不应写进设计依据）。

---

## 4. OpenAI Codex

Codex 是**唯一一个把压缩实现完整开源**的主流产品（Rust，`codex-rs`），因此可以逐行核对。

### 4.1 三种压缩形态，共用一套生命周期

【核实，源码】

| 形态 | 文件 | 做什么 |
|---|---|---|
| 本地 LLM 摘要 | [`core/src/compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) | 让模型生成 handoff 摘要，再重建历史 |
| **远程/服务端压缩** | `core/src/compact_remote_v2.rs`、`compact_remote_history.rs` | 由服务端返回压缩结果；历史里出现 `ResponseItem::Compaction` / `ContextCompaction` 两种 item |
| **token-budget 压缩** | [`core/src/compact_token_budget.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_token_budget.rs) | **不摘要**，直接 `start_new_context_window()` 装一个全新窗口；注释原话：*"Token-budget compaction skips model/server summarization and installs a fresh context window instead. It is still modeled as compaction so compact hooks and `ContextCompaction` turn items observe the same lifecycle as local or remote compaction."* |

**这个抽象值得记**：Codex 把「压缩」定义成**生命周期**（PreCompact hooks → `ContextCompaction` turn item → 替换历史 → PostCompact hooks），而**不是**「生成摘要」这个动作。摘要只是其中一种实现，另一种实现是「直接开新窗口」。

### 4.2 触发：默认 65% 就开始，分相位，可后台预热

【核实，源码】

- `codex-rs/core/src/config/mod.rs`：`const DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT: u8 = 65;`（第 230 行）。
- 判定式（`session/async_compaction.rs`）：`active_context_tokens * 100 < context_window * threshold_percent` ⇒ 不压；否则启动压缩。即**按「活跃上下文 token 占模型窗口的百分比」触发，默认 65%**。
- 相位分 **PreTurn / PostTurn**；`model_post_turn_compact_threshold_percent` 单独可配（取值 0–100，0 = 关）。
- 允许**后台异步压缩**（`Feature::AsyncCompaction`），且 `compaction_hash` / model pin 用来防止「压缩还没回来模型就换了」。
- PR [#17286](https://github.com/openai/codex/pull/17286)「Prefix Compaction」：历史到**较低阈值**时就开始在后台预热压缩，正常阈值到达时若前缀结果没好，就让前台压缩赢。⇒ **把压缩延迟从关键路径上挪走。**

### 4.3 摘要 prompt：426 字节，四个问题

【核实，[`prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md) 逐字】

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

摘要被包在一个固定前缀后（[`summary_prefix.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/summary_prefix.md)）：

```
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

**两个细节值得抄**：① 摘要的定位是 **handoff（交接）而不是 recall（回忆）**——四个问题全在问「下一个模型需要什么」；② 前缀明确写 **"avoid duplicating work"**，把「去重」写进了压缩产物本身。

### 4.4 压缩后的历史怎么拼：`build_compacted_history`

【核实，`core/src/compact.rs`】

- 组成 = `SUMMARY_PREFIX + 摘要` ＋ **只保留 user 消息** ＋ **被显式标记的孤立工具输出**，再把 canonical initial context 插回去。
- **user 消息有硬预算**：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（第 63 行）；从**最新往前**装，装不下时保留文本、**丢弃图片/音频**（`preserve_content = tokens <= remaining && 全是 InputText`）。
- **保留「无对应调用的工具输出」**：[`compact_retained_tool_outputs.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_retained_tool_outputs.rs) 的判据是 `metadata.client_authored && FunctionCallOutput{ call_id: None, name: Some(_) }`——即**客户端自己写进去的、命名过的输出**；它们「整条保留或整条丢弃」，不切半。
- **canonical initial context 重新插在「最后一条真实 user 消息（或保留输出）之前」**；若没有真实 user 消息，就插在摘要前，保证**摘要始终在最后**（`insert_initial_context_before_last_real_user_or_summary` 的注释逐条写明了这个顺序）。
- 丢弃：assistant 消息、成对的 tool call/result。

### 4.5 代价与故障（issue）

- [#5957](https://github.com/openai/codex/issues/5957)（open，33 评论）：*"auto compaction caused it to forget the file edits it made and that it was mid-task, essentially resetting its hour of work"*——**忘了自己在改文件、改到一半**，然后停下来。
- [#24948](https://github.com/openai/codex/issues/24948)（open）：反复压缩 + 原始工具输出，**单会话 JSONL 涨到 732 MB（报告区间 700MB–2GB）**——压缩产物被反复追加进日志，存储放大。
- 修复类 PR 集中在两个主题：**压缩后重注入**（[#12252](https://github.com/openai/codex/pull/12252) "Fix compaction context reinjection and model baselines"、[#10574](https://github.com/openai/codex/pull/10574) "refresh developer instructions after compaction replacement history"）与**模型切换后的基线**（[#11659](https://github.com/openai/codex/pull/11659)）。

---

## 5. 开源框架（LangGraph / OpenHands / AutoGen / CrewAI）

### 5.1 LangGraph：压缩是图里的一个 node，checkpointer 负责「不丢」

【核实，[docs.langchain.com/oss/python/langgraph/add-memory](https://docs.langchain.com/oss/python/langgraph/add-memory)】

- 消息就在 `State` 里；`checkpointer`（`InMemorySaver` / `PostgresSaver`）按 `thread_id` 持久化**每个 super-step 的状态快照**，支持回放与时间旅行。**checkpointer 不做压缩**——它保证「压了也能查回去」。
- 压缩只有三种写法，全部是**应用自己写**：
  1. **trim**：`trim_messages`（按 token 裁，保留 system + 最近若干）；
  2. **delete**：`RemoveMessage(id=...)` 从状态里真删；
  3. **summarize**：State 加一个 `summary` 字段，跑 `summarize_conversation` 节点把旧消息摘要掉，再 `RemoveMessage` 删到「只剩 2 条」。
- **滚动摘要的做法**：把已有 summary 拼进 prompt（*"This is a summary of the conversation to date: {summary}\n\nExtend the summary by taking into account the new messages above:"*）——即 **summary = f(旧 summary, 新消息)**，这正是 GOkifu 要避免的 ρ^k 式衰减的形态（每轮重摘，误差累积）。
- **LangMem `SummarizationNode`** 把这套参数化：`token_counter` / `max_tokens=256` / `max_tokens_before_summary=256` / `max_summary_tokens=128`，并用 `RunningSummary` 在 `context` 里滚动累积（示例值，非默认值）。
- **官方明确的红线**：删消息后必须保持 provider 合法性——*"Some providers expect message history to start with a `user` message. Most providers require `assistant` messages with tool calls to be followed by corresponding `tool` result messages."*

**判定**：LangGraph 提供的是**机制**而不是**策略**；它把「压什么」完全交给使用者，因此也把「压坏了」完全交给使用者。

### 5.2 OpenHands Condenser：本轮最完整的公开设计

【核实，[docs.openhands.dev/sdk/arch/condenser](https://docs.openhands.dev/sdk/arch/condenser)】

- 抽象：`CondenserBase` → `RollingCondenser` → `LLMSummarizingCondenser`；另有 `NoOpCondenser`、`PipelineCondenser`（多级串联）。
- **事件日志 append-only，压缩不删事件**：压缩时新建一个 **`Condensation` 事件**，字段为 `forgotten_event_ids` + `summary` + `summary_offset`；每次取上下文时 `View.from_events()` **按 Condensation 过滤掉被遗忘的事件、并在偏移处插入摘要**。⇒ **原始事件永远在日志里，只是不进入「视图」。**
- 参数（默认值）：`max_size = 120`（事件数阈值）、`keep_first = 4`、压缩后目标为 `max_size // 2 = 60`；滚动窗口 = **head（前 4 条原样）+ middle（约 56 条摘要）+ tail（约 56 条原样）**。
- 触发有两种：**自动**（每步 `condense()`，超阈值即压）与**手动**（LLM 报上下文错误后向历史写一个 `CondensationRequest` 事件，下一步被识别）。
- 摘要用**更便宜的模型**（文档明说 "often cheaper model than reasoning LLM"）。

**这三条（事件不删 / 视图过滤 / 显式 forgotten 边界）和 GOkifu 的「遮蔽而非删除」是同一个设计直觉**，差别在于 OpenHands 只记「哪些事件被忘了」，不记「为什么、因果是什么」——那正是棋谱要补的部分。

### 5.3 AutoGen：只有驱逐策略，没有摘要

【核实，源码 `python/packages/autogen-core/src/autogen_core/model_context/`】

四个 `ChatCompletionContext` 实现，**全部是截断/驱逐，零摘要**：

| 实现 | 行为 |
|---|---|
| `UnboundedChatCompletionContext` | 全留（无界） |
| `BufferedChatCompletionContext(buffer_size)` | 只留最近 N 条 |
| `HeadAndTailChatCompletionContext(head_size, tail_size)` | 留最前 N 条 + 最后 M 条，中间丢 |
| `TokenLimitedChatCompletionContext` | 按 token 预算从头部逐条驱逐 |

**判定**：AutoGen 认为「摘要」是应用层的事；框架只保证「窗口内的消息序列合法」。它的 `HeadAndTail` 与 OpenHands 的 rolling window 是同一个形状，但没有摘要——**说明「头尾保留 + 中间丢弃」本身已经能撑住很多场景**。

### 5.4 CrewAI：一个布尔开关

【核实，[docs.crewai.com/en/concepts/agents](https://docs.crewai.com/v1.15.33/en/concepts/agents)】

- Agent 参数 `respect_context_window`，默认 **True**，文档定义一句话：*"Keep messages under context window size by summarizing."*
- 另有独立的 memory 系统（短期/长期/实体记忆），与压缩是两条线。
- 判定：**把压缩做成默认开、无参数的保险丝**，用户不配置也能跑；代价是行为不可观测、不可审计。实现细节（保留什么、用哪个模型摘要）：**【未核实】**。

---

## 6. 压缩后的典型故障（用户抱怨归类）

按「丢了什么」分类，每类给可核查的一手出处。**这一节是本文最该被产品决策直接使用的一节。**

### A. 数据还在磁盘上，但模型已经看不见了

- **Claude Code** [#26771](https://github.com/anthropics/claude-code/issues/26771)（open）：粘贴 ~8,000 字符 DOM，压缩后摘要在，**内容没了**，摘要只写「User provided 8,200 characters of DOM markup for analysis」；完整 transcript 仍躺在 `~/.claude/projects/{project}/*.jsonl`。作者的诉求不是「别压」，而是「**摘要里给可寻址的引用**」。
- 同一 issue 被搬到 HN（[47096210](https://news.ycombinator.com/item?id=47096210)，31 分 / 23 评论），评论区的共识很尖锐：*"Don't treat chat as a contracted space. It's inhalation and exhaust. Store things you care about on disk!"*

### B. 约束/规则被摘要吃掉（最高频）

- [#9796](https://github.com/anthropics/claude-code/issues/9796)（关闭，30 评论）：压缩后**完全忘记 `.claude/project-context.md`**，「压缩前 100% 遵守，压缩后 100% 违反」（该文件是早期社区约定，不是官方机制——但它暴露的失效方式与官方 CLAUDE.md 相同）。
- [#6354](https://github.com/anthropics/claude-code/issues/6354)（open）「Claude forgets everything in CLAUDE.md after compaction」；[#19471](https://github.com/anthropics/claude-code/issues/19471)「CLAUDE.md instructions completely ignored after context compaction」。
- 官方对此的回应不是「把摘要写好」，而是**结构性的**：CLAUDE.md 压缩后**从磁盘重注入**（§1.3）。**规则不靠摘要，靠重发。**

### C. 工作态丢失 → 重复劳动

- **Codex** [#5957](https://github.com/openai/codex/issues/5957)：压缩后「忘了自己改过文件、忘了自己在做任务」，一小时工作被重置。
- **Claude Code** [#70555](https://github.com/anthropics/claude-code/issues/70555)（open）「Working-state continuity: survive compaction and `/clear`（the long-session "goes dumb" problem）」：*"the assistant slowly 'goes dumb' — re-deriving things, forgetting in-flight threads, repeating work"*，并明确把**压缩**与**冷启动失忆**归为同一个问题。
- 这类抱怨的共同点：丢的不是「事实」，是**「进行中的状态」**（正在改哪个文件、下一步是什么、哪些已排除）。

### D. 压缩循环 / thrashing

- **Claude Code**：官方 troubleshooting 专门有一节（错误文本 `Autocompact is thrashing: ...`，§1.2）；另有 [#6004](https://github.com/anthropics/claude-code/issues/6004)「Stuck in Infinite Compaction Loop」、[#30400](https://github.com/anthropics/claude-code/issues/30400)「Context limit reached without automatic compaction triggering」（触发条件本身出错）。
- **Cursor**：论坛 topic 163850「10–20% 就摘要、然后卡在循环里」。
- **Devin**：变更日志 *"Unnecessary compaction is no longer triggered on every turn"*。
- **判定**：thrashing 的根因通常不是压缩算法，而是**触发判定与实际占用不一致**（超大单条输出、模型 token 计数偏差、工具返回虚报 token）。

### E. 压缩后工具/技能能力退化

- **Cursor** 论坛 topic 164549：摘要后 **Active Skills 不重载**、工具/MCP 用法知识退化，导致工具权限类错误。
- **Devin** 变更日志：被压缩掉的 skills 要「下次触碰触发路径时重新发现」；发现过的 skills 压缩后要重新出现在列表里。
- **Claude Code** 对此有明确实现（§1.3）：skill 描述**重建**、被调用过的 skill 正文**重注入且带 5k/25k 双层预算**、路径规则**按需重载**。
- **共性**：工具/技能不是「知识」，是**「当前装载状态」**——它必须被显式恢复，摘要里写一句「他之前用过 X 工具」没有用。

### F. 压缩破坏可回溯性（最容易被忽略，也最伤害信任）

- **Devin** 变更日志：*"Previously, compacting a session made all earlier steps invisible and unrevertible."*（压缩后 `/steps`、`/revert`、`/fork` 看不到压缩前的步骤）
- **Claude Code** [#27242](https://github.com/anthropics/claude-code/issues/27242)（open）「No working mechanism to review previous context after compaction, plan-mode clear, or branch …」。
- **判定**：**压缩与「可撤销」是两个正交需求，但实现时极易耦合在一起**——因为压缩改的就是「历史」这份数据结构。

### G. 压缩本身的成本与静默失败

- **Claude Code**：压缩是读全量历史的大请求，且必然触发一次期望内的缓存重建（§1.5）。
- **Cursor** 论坛 topic 173036：`/summarize` **静默失败**、上下文也没释放——用户不知道「压了」还是「没压」。
- **判定**：压缩必须**要么成功要么硬报错**，且要可观测（次数、耗时、压缩前后 token）。静默失败比不压更糟。

### H. 存储放大与恢复交互

- **Codex** [#24948](https://github.com/openai/codex/issues/24948)：反复压缩把 session JSONL 顶到 700MB–2GB。
- **Devin** 变更日志：*"Session resume no longer drops early conversation messages after multiple compaction rounds."*
- **Claude Code** [#98747](https://github.com/anthropics/claude-code/issues/98747)：*"2.1.286 idle compaction silently discards working context in long-running sessions; no opt-out"*。

### 这一节最该记住的一句

> 所有故障都可以归成一句话：**压缩把「已经付过代价拿到的信息」降级成了「下一个模型的推测」。**
> 越是「贵得来的」（用户手工粘贴的数据、失败过的路径、跑着没停的后台任务、当前装载的技能），越不能交给摘要。

---

## 7 · 横向对比表

> 「原始事件可回溯」= 压缩后能否从落盘记录/状态里取回被压掉的原文。
> 「未公开」= 官方无文档、本轮无可靠一手证据。

| 产品/框架 | 触发 | 压缩粒度 | 保留什么 | 丢弃什么 | 原始事件可回溯 | 保留工具记录 |
|---|---|---|---|---|---|---|
| **Claude Code** | 达窗口上限；1M 模型约 967K；200K 模型在 200K 边界；可 `/autocompact` 下调；闲置也会压 | 整段历史一次摘要 + **确定性重注入表** | system/CLAUDE.md/auto memory/plan/git status 重注入；最近 5 个文件重读；skill 描述重建 + 正文重注入（5k/25k）；后台任务提醒 | 旧工具输出、早期对话细节、路径 scoped rules 需重载 | **是**（会话 transcript 全量写入 `~/.claude/projects/` 的 JSONL；SDK 侧另有 `compact_boundary` 事件可观测） | 默认丢；例外：后台任务状态、重读文件、`PreCompact` hook 可归档全量 |
| **Cursor** | 未公开（用户观测：有时 10–20% 就压） | 服务端摘要（**未公开**） | rules 每轮重发（结构上不受影响）；`@` 选择的内容 | 未公开 | **未公开**；有 `/summarize` 命令 | 未公开 |
| **Devin** | 按窗口比例的默认阈值；`agent.compaction_threshold_tokens` 可提前；`/compact` 手动 | 整段摘要 | AGENTS.md 注入上限 16 KiB（超限给截断通知 + 可读全文）；压缩后 steps/revert/fork 覆盖压缩前 | 技能与工具知识需「重新发现」 | **是**（steps 可跨压缩回溯；`post_compaction` hook 拿到摘要） | 未公开；但压缩后能力退化有记录 |
| **Cline** | 用户可配的 auto-condense 阈值（进度条） | 摘要（未公开细节） | Memory Bank 六个 markdown 文件靠笔记续命 | 未公开 | 未公开（有 `PreCompact` hook 可挂归档） | 未公开 |
| **Aider** | 无「压缩」，每轮重发 repo map | **结构化摘要**：图排序 + token 预算（默认 1k，可动态扩张） | 全仓符号/签名/关键定义行（按相关性择优） | 未入选的文件与函数体 | **不适用**（不删历史；地图每轮重算） | 不适用 |
| **Codex** | 默认 **65%** 触发（可配 1–100）；分 pre-turn/post-turn；可后台预热 | **三种生命周期**：本地摘要 / 服务端压缩 / 直接开新窗口 | 摘要前缀（"avoid duplicating work"）＋ 全部 user 消息（≤20k tokens）＋ 客户端标记的孤立工具输出 ＋ canonical initial context | assistant 消息、成对 tool call/result、超预算消息的图片/音频 | **是**（`Compaction`/`ContextCompaction` item 落在历史里；会话 JSONL 全量） | **部分**：显式标记的 `call_id=None` 输出整条保留 |
| **LangGraph** | 应用自定义（`max_tokens_before_summary` 等） | 图中的一个 node | 由应用决定（常见：system + 最近 N 条 + summary 字段） | 由应用决定（`RemoveMessage` 真删） | **是**（checkpointer 按 thread 存每步快照，可回放） | 由应用决定 |
| **OpenHands** | 事件数 > `max_size`（默认 120）；或 LLM 报错后写 `CondensationRequest` | **滚动窗口 + 追加 Condensation 事件** | head 前 4 条原样 + tail 约 56 条原样 | middle 约 56 条（改为摘要） | **是**（事件日志 append-only，视图层过滤） | 是（事件不删，只是不进视图） |
| **AutoGen** | 应用选择 context 实现 | 驱逐/截断（**无摘要**） | 由实现决定（buffer / head+tail / token 预算） | 超出部分直接丢 | **否**（除非应用自己持久化） | 否 |
| **CrewAI** | `respect_context_window=True`（默认开） | 摘要（**实现未公开**） | 未公开 | 未公开 | 未公开 | 未公开 |
| **DSH `dsh-compaction-basic`**（本仓对照，见 `docs/市场对标.md` §4.6） | `floor(min(W×0.8, W−O−headroom))` | 整段一次摘要（8 段模板） | 模板固定段落 | 原文替换掉 | **是**（DSH 会话事件保留） | 随模板；`tool-result-pruner` 另有确定性修剪 |
| **GOkifu（本仓）** | 由 DSH 压缩生命周期调用（`summarize()` 是唯一钩子） | **增量 fold**：只压上一个 checkpoint 之后 | 根目标/约束/成功路径/失败边/OPTIONS/悬空边分类（每步重灌） | 旧消息遮蔽（**不删**） | **是**（`graph.json` + delta，遮蔽不删事件） | 是（工具调用被分类为验证信号，失败边永久保留） |

**三点从表里直接读出来的结论**：

1. **「可回溯」与「压缩」不冲突**，而且已经成为头部产品的默认（Claude Code / Codex / Devin / LangGraph / OpenHands 全部可回溯）。**不可回溯是 `dsh-compaction-basic` 这一代的设计债，不是行业常态。**
2. **没人能靠「把摘要写好」解决约束丢失**——所有解都在「重发」或「重灌」这一侧（CLAUDE.md / rules / AGENTS.md / canonical context）。
3. **只有 Codex 把「压缩」抽象成生命周期而非动作**，因此它可以有「不摘要、直接开新窗口」这种实现；这是最值得在架构层借鉴的一点。

---

## 8 · 对 GOkifu 的直接启示（可执行项）

> 以下每条都写成「现状 → 别人怎么做 → 具体动作」。涉及冻结面（热清单文本 / `classify()` 判据 / `graph.json` 与 delta 字节 / preset 块格式 / `state` 形状）的，一律标注**需契约先行 + 单独一刀**，不在本文主张直接改。

### 8.1 该学的（按优先级）

**① 把「压缩」定义成生命周期，而不是「生成摘要」这个动作。**（学 Codex）
- 现状：`summarize()` 是 DSH 唯一认可的子类钩子，GOkifu 在钩子里做 fold + 渲染。
- 证据：Codex 的 `compact_token_budget.rs` 明确把「不摘要、直接开新窗口」也当作 compaction，只要它经过同一套 hooks 与 `ContextCompaction` item。
- 动作：在 fold 流程里显式分出 **pre-fold / fold / post-fold** 三个阶段事件（即使当前只有一个实现），并把「本次 fold 用了哪条策略（增量/全量/仅遮蔽）」记进 `graph.json` 的可选字段。**收益**：以后加「token-budget 式硬折叠」时不用改判据，只加一个策略分支。

**② 学 OpenHands 的「显式 forgotten 边界」。**
- 现状：GOkifu 遮蔽旧消息，图里有节点，但**「这次 fold 忘了哪一段」在图上不是一等公民**。
- 证据：OpenHands 的 `Condensation` 事件带 `forgotten_event_ids` + `summary_offset`，视图过滤时按 id 排除。
- 动作：给每个 checkpoint 记 `foldRange: {fromSeq, toSeq, reason}`，写进 `graph.json`（**需 R00/R01 契约先行**）。**收益**：任何「模型说 X 但 X 其实在被遮蔽段里」的排查，都能一步定位；也是「压缩后仍可回溯」的机器判据。

**③ 把「不要重复劳动」写进压缩产物的第一行。**（学 Codex 的 `SUMMARY_PREFIX`）
- 现状：热清单已有 `LEARNED` / 失败边，但没有一句**面向下一个模型的元指令**。
- 证据：Codex 的 prefix 逐字写着 "avoid duplicating work"；实测 issue #5957 的失败正是「重复/中断」。
- 动作：热清单顶部（ROOT 之后、CONSTRAINTS 之前）加一行固定文本，例如 *"以下失败边已付过代价，不要重试；若要重试，先说明为什么这次会不同。"* **注意：这是热清单文本变更 ⇒ 需单开一刀并复核 `ledger` 全部 24 条测试。**

**④ 学 Aider 的「固定预算 + 相关性排序」，而不是「压缩比」。**（GOkifu 已在做，可再进一步）
- 现状：351 tokens/步（M-00 bench）是固定预算，方向正确。
- 证据：Aider `--map-tokens` 默认 1k 且**动态伸缩**——*"it does expand … especially when no files have been added to the chat"*。
- 动作：把 `fold-planner`（R02）的预算从常量改为**两档**：有根目标时收紧（默认），无根目标/新会话时放宽（临时扩张）。判据必须是**纯函数**，可单测。

**⑤ 学 Claude Code 的「重注入清单」，把它列成显式契约。**
- 现状：GOkifu 每步重灌热清单，事实上已经是「重注入」；但没有**清单化**，也没有「哪些东西永远不靠摘要」的书面判据。
- 证据：Claude Code 的 "What survives compaction" 是一张**逐机制的确定表**（§1.3）。
- 动作：在 R06/R07 的契约里加一张「压缩后必须重灌」的表（根目标、约束、未结算 candidate、悬空边分类、后台任务、当前装载的工具/技能），并配**一条墓碑测试**：删掉任一重灌项必须变红。

**⑥ 学 Codex 的「提前量」，把压缩移出关键路径。**
- 现状：GOkifu 只在 DSH 调用 `summarize()` 时工作（压缩时点）。
- 证据：Codex 默认 65% 就开始（不是 90%），并支持**后台预热压缩**（PR #17286）。
- 动作：评估在 `INJECT_MIN_EVENTS=40` 之外再加一个「预折叠水位」（例如窗口 60%），只做**纯计算**的 fold 规划（不落盘、不发请求），把结果缓存到内存；真到压缩时直接复用。**收益**：压缩时延从「跑一遍全图」降到「读缓存」。**需先确认 DSH 是否允许在非压缩时点读图（只读，不写）。**

**⑦ 学 Claude Code 的 thrashing 保护与可观测性。**
- 现状：未知（本轮未查 GOkifu 是否记录「压缩后立即又满」）。
- 证据：`Autocompact is thrashing: ...` 是**唯一把「压缩无效」当一等错误**的实现；Cursor 的 `/summarize` 静默失败被用户当成 bug。
- 动作：记 `foldCount` 与「fold 后 N 步内再次触发 fold」的计数；连续 2 次命中即写入一条 `foldIneffective` 标记并在热清单里提示「上次压缩未回收足够空间」。**不静默。**

**⑧ 学 Devin 的「压缩不得破坏可回溯」的验收项。**
- 现状：GOkifu 有 `graph.json` + delta + sidecar/rollback（P6-C），机制在。
- 证据：Devin 曾因压缩导致 `/steps`、`/revert`、`/fork` 看不到压缩前步骤（变更日志），修复后才恢复。
- 动作：把「压缩前后的可回溯性」写成**验收用例**：fold 前记 `foldRange`，fold 后按 `foldRange` 反查原始事件必须逐字命中；再加一条「fold 后 `revert` 到 fold 前状态」的等价性测试。

### 8.2 该避免的

**⑨ 不要把「摘要」当成唯一手段。**（反面：LangGraph 的默认示例、`dsh-compaction-basic`）
- LangGraph 官方示例就是 `summary + RemoveMessage`，且摘要本身是**滚动的**（`summary = f(旧 summary, 新消息)`）——这正是 ρ^k 衰减的形态；GOkifu 的增量 fold 已经绕开它，**不要为了「省 token」退回「每轮重摘一份总摘要」**。
- 同源证据：Anthropic 明确警告过度压缩会丢掉「后来才变重要」的细节；Codex 的 65% 提前量 + 三形态并存也说明单一手段不够。

**⑩ 不要默认「删」历史。**（反面：LangGraph 的 `RemoveMessage`、AutoGen 的驱逐）
- LangGraph 自己文档都要警告「删完必须保证 provider 合法性」；AutoGen 直接不提供摘要，只提供「丢」。
- GOkifu 的遮蔽语义是对的。**任何「真删」都应该是显式 CLI（现有 P6-C 模式），不能进 engine 启动路径。**

**⑪ 不要把「工具输出」当垃圾一刀切。**（反面：把 tool result 全部清理）
- Claude Code 保留「后台任务还在跑」的提醒（防重复启动）；Codex 保留**客户端标记过的孤立输出**（`call_id=None` 且 `name=Some`）；OpenHands 保留 tail 原样。
- 对 GOkifu：工具调用的**结果文本**可以丢，但**「这类工具在这类输入上验证过/没验证过」这条判据必须留**——这正是 `verify.mjs` 的职责，**不要在 fold 时把未结算的工具调用一起抹掉**（`candidate` 语义的存在理由就在这）。

**⑫ 不要只压「消息」，不压「状态」。**（反面：Cursor/Codex 的失忆类抱怨）
- 证据：Claude Code #70555、Codex #5957 丢的都是**进行中的状态**（正在改哪个文件、下一步、已排除什么）。
- 对 GOkifu：热清单里「当前路径 + 未结算 OPTIONS + 下一步」这三项是压缩的**必留项**，不能因为「它们不是事实、只是状态」而降级为摘要里的一句话。

**⑬ 不要让压缩的触发条件依赖「估算的 token 数」而不做校验。**
- 证据：Cursor「10–20% 就压」、CC #53065「`advisor()` 工具把整份 transcript 转发、虚报输入 token 从而触发过早自动压缩」、Devin「每回合都压」——三例都是**触发判定失真**。
- 对 GOkifu：`INJECT_MIN_EVENTS` / `INJECT_MIN_FAILURE_DELTA` 是**事件数与失败增量**判据（不是 token），这比 token 估算稳健；但**新增任何 token 类判据前，必须先用真机会话校准一次**（当前「运行期收益未验证」是已知状态）。

### 8.3 一条判据（可当验收清单用）

> **压缩产物应当通过「交接测试」而不是「回忆测试」：**
> 把 fold 后的热清单单独交给一个**没有任何历史**的模型，它应当能回答 Codex 那四个问题——
> ① 现在做到哪、做过哪些决定？② 有哪些约束/偏好不可违反？③ 下一步是什么？④ 继续需要的原始材料在哪（路径/引用）？
> **四问全答得上，压缩合格；有一问答不上，就是丢了三样东西之一：目标、约束、或可寻址的引用。**

---

## 附录 · 本文引用的一手链接（均为本轮抓取成功）

**Anthropic / Claude Code**
- 工程博客（compaction / note-taking / sub-agent）：https://www.anthropic.com/research/effective-context-engineering-for-ai-agents
- 上下文窗口与「压缩后保留什么」表：https://code.claude.com/docs/en/context-window
- 何时压缩 / 压缩丢掉什么：https://code.claude.com/docs/en/how-claude-code-works
- 默认压缩阈值与 `/autocompact`：https://code.claude.com/docs/en/model-config
- 成本 / 缓存重建 / 压缩是大请求：https://code.claude.com/docs/en/costs
- thrashing 错误与恢复：https://code.claude.com/docs/en/troubleshooting
- prompt caching（含 compaction 一节）：https://code.claude.com/docs/en/prompt-caching
- Agent SDK 压缩与 `PreCompact`：https://code.claude.com/docs/en/agent-sdk/agent-loop
- CLAUDE.md / auto memory（200 行 / 25KB）：https://code.claude.com/docs/en/memory

**Cursor**
- Rules（四种应用方式，开头重注）：https://cursor.com/docs/rules
- `@` 上下文：https://cursor.com/help/customization/context
- 论坛：`/t/163850`、`/t/164549`、`/t/173036`、`/t/149490`、`/t/168194`（域名 `forum.cursor.com`）

**Devin / Cline / Aider / Windsurf**
- Devin AGENTS.md 16 KiB 上限：https://docs.devin.ai/onboard-devin/agents-md
- Devin 全量文档（CLI `/compact`、`compaction_threshold_tokens`、hooks、变更日志）：https://docs.devin.ai/llms-full.txt
- Cline Memory Bank：https://docs.cline.bot/best-practices/memory-bank
- Cline PR：`cline/cline` #6049 / #9348 / #7513；issue #4389
- Aider repo map（图排序 + `--map-tokens` 1k + 动态扩张）：https://aider.chat/docs/repomap.html
- Windsurf 全量文档（`compact`/`summarize` 零命中）：https://docs.windsurf.com/llms-full.txt

**OpenAI Codex**
- 压缩主流程：https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs
- 摘要 prompt：https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md
- 摘要前缀：https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/summary_prefix.md
- token-budget 压缩（直接开新窗口）：https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_token_budget.rs
- 保留的孤立工具输出：https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_retained_tool_outputs.rs
- 阈值默认 65%：https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs
- 异步压缩触发式：https://github.com/openai/codex/blob/main/codex-rs/core/src/session/async_compaction.rs
- issue #5957（忘记在改文件）、#24948（日志 700MB–2GB）；PR #17286（prefix prewarm）、#12252、#10574、#11659

**开源框架**
- LangGraph 记忆与摘要：https://docs.langchain.com/oss/python/langgraph/add-memory
- OpenHands Condenser 架构：https://docs.openhands.dev/sdk/arch/condenser
- OpenHands Condenser 使用指南：https://docs.openhands.dev/sdk/guides/context-condenser
- AutoGen 上下文实现目录：https://github.com/microsoft/autogen/tree/main/python/packages/autogen-core/src/autogen_core/model_context
- CrewAI Agent 参数（`respect_context_window`）：https://docs.crewai.com/v1.15.33/en/concepts/agents

**用户抱怨（一手）**
- Claude Code issues：#26771（数据在磁盘但看不见）、#9796 / #6354 / #19471（规则丢失）、#70555（长期会话变笨）、#6004 / #30400（压缩循环/不触发）、#27242（压缩后无法复查）、#98747（idle compaction 静默丢弃）、#53065（token 虚报导致过早压缩）
- Codex issues：#5957、#24948
- HN 讨论：https://news.ycombinator.com/item?id=47096210

**二级来源（仅作方向，不作依据）**
- 「Compaction = summarization + restoration（重读文件、恢复 todo、注入 continuation）」的拆解：https://decodeclaude.com/claude-code-compaction/
