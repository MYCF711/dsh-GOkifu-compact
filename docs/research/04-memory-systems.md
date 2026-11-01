# 记忆系统调研：写入/整合/遗忘/检索/版本化/可寻址 → 能借给纯压缩插件的极小集合

> 2026-11-01 · 调研第 4 轮（记忆系统轴）
> 读者：`dsh-gokifu-compact` 的维护者。**本文不回答"怎么记住更多"，只回答一个问题：**
> 主流 agent 记忆系统在这六个维度上做了什么，其中**哪一小部分能安全借给一个只做上下文压缩的插件**。
>
> 硬约束：`docs/压缩的职责边界.md`（两条判据 + 越权红线）。已有蒸馏：`docs/research/00-蒸馏-对本插件的可执行结论.md`。
> 本文**不重复** 00 的结论，只在需要时引用其编号（如「00 §1.1」）。

---

## 0 · 方法与证据

**抓取时间**：2026-11-01（Asia/Shanghai）。`web_search` 本机不可用，全部靠已知 URL + arXiv API + GitHub raw 定向抓取。

**证据分级**（每行都带）：

- **【核实·原文】** — 本轮抓到了一手文本/源码/schema，能引原话或字段名。
- **【核实·摘要】** — 抓到了论文摘要（arXiv API），但正文细节未逐段读完。
- **【二手】** — 博客、README 二手描述、变更日志。方向可信，细节不保证。
- **【未核实】** — 模型知识，本轮没抓到。**当线索，不当依据。**

**可达性实测**（先说清楚哪里是空白）：

| 对象 | 结果 | 处理 |
|---|---|---|
| Hindsight 本机服务 `192.168.1.6:8888`（v0.10.2） | 【核实】`/openapi.json`（343 KB）、`/v1/bank-template-schema`、`/health`、`/metrics` 匿名 200；**bank 级端点 401**（`Invalid API key`） | 只读探测：拿 schema 与端点语义，**不发 token、不碰真实记忆内容** |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) README | 【核实】全文可抓 | 原文 |
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | 【核实】README + `docs/en/concepts/{03,06,07,09}.md` 可抓；**`docs.openviking.ai` 站点对 `.md` 返回 SPA HTML**（与 `docs.windsurf.com` 同病）| 用 GitHub 里的 vitepress 源文件，站点页判「未核实」 |
| arXiv `export.arxiv.org` | 【核实】API 可用；`arxiv.org/html/*` 全文 HTML 可抓 | 7 篇论文按 ID 精确取 |
| [letta-ai/letta](https://github.com/letta-ai/letta) · `docs.letta.com` | 【核实】`llms.txt` + `agent-sdk/memory/index.md`、`concepts/memfs/index.md` 可抓 | 原文 |
| GitHub API | 【核实】仓库搜索/目录列举可用 | 用于确认 OpenViking 的 docs 位置 |

**四条自我限制**：

1. **Hindsight 我看到的是"壳"不是"肉"**：没有 API key 就拿不到 memory/observation 实例。凡涉及"实际去重效果""proof_count 何时递增"的，一律写「未核实」。
2. **论文数字不转述为性能承诺**：本插件不做记忆，论文的 LoCoMo/LongMemEval 分数在这里没有可迁移性，只在"他们优化什么"这一层有用。
3. **不把"产品做了什么"当"产品做对了"**：多处给出的是**它们的路线变化**（mem0 从 UPDATE/DELETE 改成 ADD-only），变化本身才是证据。
4. 本仓现状只引用我本轮**读过码**的部分（`src/rooms/ledger.mjs`、`src/engine.mjs`、`src/rooms/kifu-model.mjs`），不转述旧文档。

---

## 1 · 判据复述：记忆系统与压缩的交界在哪

`压缩的职责边界.md` §1 的两条判据，用记忆系统的语言重写一遍，就是本文的筛子：

| 判据 | 对记忆系统的含义 | 后果 |
|---|---|---|
| ① 产自**本次会话**的历史 | bank / 知识库 / 跨会话巩固 / 用户画像 全部出局 | Hindsight、OpenViking、Letta、MemOS 的**主体**都不可借 |
| ② 只在**压缩生命周期**出现 | 每步常驻的检索、常开的重排、随时可调的记忆工具 出局 | 记忆系统的**检索层**整体不可借 |
| 附加红线（§2） | 不许教模型"何时 restore"、不许自建记忆工具接管工具层、不许改 persona/规则 | MemGPT 的核心主张（模型自编辑 + 分页换入）**正面撞线** |

于是本文真正要找的东西只有一类：**在"把一段历史降维成一个产物"这个动作上，那些系统为了不丢原件而付出的工程代价，能不能用同样的形状付一次。**
换句话说：**借它们的"指针与状态"，不借它们的"存储与检索"。**

---

## 2 · 横向事实表（一格一句）

| 系统 | 写入/整合 | 遗忘 | 检索 | 版本化 | 可寻址（事实→原件） |
|---|---|---|---|---|---|
| **Hindsight** | LLM 抽事实 + 后台 consolidation 成 observation | 无 TTL/衰减；用**配额**+**可逆 invalidate** | 4 臂并行 + RRF + 重排 + 按 token 裁剪 | `state`/`history`/mental-model `delta` | **强**：memory→chunk→document 三级链 |
| **OpenViking** | 会话提交即归档 + 抽 memory 为 markdown；派生摘要后台生成 | 未公开 | 目录内检索 + 意图分析；L0/L1/L2 分层 | 派生文件带 `coalesce_version` 防旧覆盖 | **强**：`viking://` URI，L2 即原件 |
| **MemOS** | MemReader 解析 → task–concept–fact 层级图 | 生命周期含 `expiration`（策略未公开） | MemScheduler 按意图调度 | **MemCube 自带 provenance + versioning** | **强（抽象层）**：MemCube 元数据 |
| **SimpleMem** | 写时合成（online synthesis）+ LLM 语义裁判门控 | 无（低增益即丢弃） | 多索引 + 意图规划 + 动态预算 | 无 | **无**（全文 0 处 provenance） |
| **mem0** | 2025：LLM 选 ADD/UPDATE/DELETE/NOOP；2026 v3：**ADD-only** | 旧版靠 DELETE；v3 不删不改 | semantic+BM25+entity 融合 | v3 靠"只增"隐式留史 | **弱**（未见源消息 id） |
| **Letta/MemGPT** | 模型自编辑 memory blocks；FIFO 驱逐 + 队首递归摘要 | FIFO 驱逐（无 TTL） | 函数调用 + 分页；现行 MemFS 用**文件路径** | **git 版本**（MemFS） | **强**：路径即地址，commit 即版本 |
| **Zep/Graphiti** | episode 摄入 → 抽边 → 冲突**invalidate 不删** | 无 TTL；失效可查历史 | cosine + BM25 + BFS 三路，明确"不靠 LLM 摘要" | **双时间轴**（事件时间 T / 摄入时间 T′） | **强**：每条派生事实回指 episode |
| **A-MEM** | 新笔记建链，且**改写旧笔记**（memory evolution） | 无 | 链接网络 + 相似度 | 无 | **无**（改写即覆盖） |
| **MemoryOS** | STM→MTM FIFO；MTM→LPM 按 heat 升降级 | **有**：`Heat=αN+βL+γR`，`R=exp(−Δt/μ)`，μ=1e7 s | 两级（先段后页） | 无 | **无**（页即原文，事实级无回指） |

**一行读法**：**做压缩的（SimpleMem/A-MEM/MemoryOS）几乎都不留回指；做记忆的（Hindsight/Graphiti/Letta/OpenViking）都以回指为前提。**
这不是巧合——它们优化的指标不同。**本插件优化的是"同样的历史丢得最少、还原得最准"，所以只能站后一列。**

---

## 3 · 逐系统

### 3.1 Hindsight（本机已装，v0.10.2）

**① 架构/数据模型**【核实·原文】bank → memory unit。memory unit 的字段（取自本机 `openapi.json` 的 `MemoryGraphTableRow` / list 端点参数）：`id`、`type`（`world`/`experience`/`observation`）、`document_id`、`chunk_id`、`proof_count`、`state`、`consolidation_state`、`tags`、`entities`、`mentioned_at`/`occurred_start`/`occurred_end`。上游是三层：**document（原文）→ chunk（切片，`store_document_text` 可关）→ memory unit（派生事实）**，之上再有 entity 图、observation（整合层）、mental model / knowledge page（文件夹式 wiki 页）。

**② 写入与整合**【核实·原文】retain 用 LLM 抽事实+时间+实体+关系，归一化成 canonical entity / time series / 索引；抽取模式 `concise|verbose|custom|verbatim|chunks`。observation 由 consolidation 生成，作用域按 tag fnmatch 划分（`tags_match: all|exact`），`max_observations_per_scope` 限制每域条数。README 原话：observation 是"deduplicated beliefs"，**"Each observation keeps its supporting evidence with exact quotes and a proof count, and is *refined* rather than overwritten"**。人工侧有 curate：`PATCH /memories/{id}` 改 `state`，示例 `{"reason":"superseded: server decommissioned 2026-06-01","state":"invalidated"}`。

**③ 遗忘与衰减**【核实·原文】**没有时间衰减**。我在 bank 模板 51 个字段与 343 KB openapi 全文里按词边界搜 `ttl|decay|half_life|expires_at`：**0 命中**。它替代衰减的是两件东西：**配额**（`max_observations_per_scope`，逼整合而不是逼过期）与**可逆失效**（"Invalidated memories are excluded from recall, consolidation, and graph maintenance but **kept for audit (reversible)**"）。→ **不能照搬的是它的配额数值**（属于 bank 容量策略）；**能照搬的是"用配额触发整合、不用时间触发删除"这条形状**。

**④ 检索**【核实·原文】4 臂并行：vector / BM25 / graph（entity-temporal-causal）/ temporal（时间窗）；结果 **RRF 融合 → cross-encoder 重排 → 按 token 上限裁剪**。budget 分 low/mid/high，且有 `fixed` / `adaptive`（按 `max_tokens` 比例 + min/max clamp）两种映射函数；每臂可单独开关；`recall_include_chunks` 可把原文切片一并返回。

**⑤ 版本化与可寻址**【核实·原文】`GET /memories/{id}/history`："full history of an observation, with each change's source facts resolved to their text"；`GET /v1/default/chunks/{chunk_id}` 取源切片；mental model 有 `history` + `delta` 刷新模式 + `keep_trace`；knowledge-base 有 `tree`/`folders`/`pages`（层级 URI）。

**⑥ 证据** 全部【核实·原文】（本机服务 schema + 上游 README）。

**⑦ 对纯压缩插件**
- **可借**：(a) **三级闭包链**的形状（派生 → 切片 → 原文），我们已有原件（append-only 日志）与区间，缺的是"从产物指回去"的字段；(b) **invalidate 而非 delete**（它的 `state` + `reason` 就是我们的 `supersededBy`）；(c) **`proof_count`**——"这条被独立见过几次"是**与时间无关的权重**，比任何衰减公式都安全。
- **不可借**：整条记忆管道（抽取/实体归一/图/observation/bank）、4 臂检索、跨会话。

### 3.2 OpenViking（volcengine，AGPL-3.0）

**① 架构/数据模型**【核实·原文】虚拟文件系统 `viking://`：`resources/`（文档、代码）+ `user/{id}/{memories,skills,peers}`。**目录级**语义侧车：`.abstract.md`（L0，默认 256 字符）+ `.overview.md`（L1，默认 4000 字符），文件本体是 L2。

**② 写入与整合**【核实·原文】`session.commit` 归档会话并把 memory 抽成 markdown（"you can inspect, edit, and merge"）；派生摘要由后台队列生成，**不构成跨 VikingFS/向量库/队列的原子事务**（`09-transaction.md` 明说）。并发写同一目录摘要时用 `coalesce_version`：**"only the latest version may write back"**，旧任务在写回前丢弃。

**③ 遗忘**【核实·原文】**未公开**。README 与 `03/06/07/09` 四篇里没有 TTL/衰减/淘汰策略的记载。→ 记「未公开」，不推断。

**④ 检索**【核实·原文】`HierarchicalRetriever` 每次查询跑**一次全局向量检索**，用目录/类型/权限/`level` 约束范围——**默认不递归导航目录**。`find()` = QUICK；`search()` 有 reranker 时走 THINKING（先做意图分析）；结果带 `abstract`（L0）。分层披露顺序写死在文档里：**先摘要（L0）→ 再概览（L1）→ 最后才读正文（L2）**。

**⑤ 版本化与可寻址**【核实·原文】`viking://` URI 本身即地址，L2 即原件；L0 **从 L1 派生**（L1 正文里 H1 之后、第一个 `##` 之前的那段），不是从 L2 直接压。站点的「Version management」页返回 SPA，**未核实**。

**⑥ 证据** README 与 docs 源文件【核实·原文】；版本管理页【未核实】。

**⑦ 对纯压缩插件**
- **可借**：(a) **分层预算**（256/4000 是显式字符预算，且"截断优先整句"——若一句都放不下则保留该整句）；(b) **"上层从下层派生"的方向纪律**（L0 派生自 L1）：对应我们的"L4 汇总行必须从边集算出来，不能由模型另写一段"；(c) **`coalesce_version`**：派生写回必须带版本戳，旧结果不许覆盖新结果。
- **不可借**：整个 context database、目录检索、后台抽取、多租户/ACL。

### 3.3 MemOS（MemTensor，arXiv 2507.03724）

**① 架构/数据模型**【核实·摘要】三种基质：**plaintext / activation（KV-cache 中间态）/ parameter（权重）**。基本单元是 **MemCube**："encapsulates both memory content and metadata such as **provenance and versioning**"，可 compose / migrate / fuse。明文层按 **task–concept–fact 路径**组织成层级图。

**② 写入与整合**【核实·摘要】明文层"supports conflict detection, deduplication, versioning, and forgetting policies"；生命周期 `generation → activation → fusion → archiving → expiration`，由 `MemReader` / `MemScheduler` / `MemLifecycle` / `MemOperator` 分工。

**③ 遗忘**【核实·摘要】有 `expiration` 这个**生命周期状态**，但论文没给策略、阈值、触发条件 → **不可照搬**（它的 expiration 依赖多层调度的系统语义，单插件没有那个语义）。

**④ 检索**【核实·摘要】MemScheduler "selects appropriate memory types based on task intent, and dynamically plans invocation order"——**检索被当成调度问题，不是排序问题**。

**⑤ 版本化与可寻址**【核实·摘要】**MemCube 是全组里对"可寻址"最强的抽象**：内容 + 出处 + 版本 + 可组合，四件事在一个对象里。

**⑥ 证据** 摘要与 HTML 全文关键段【核实·摘要】；具体 API/阈值【未核实】。

**⑦ 对纯压缩插件**
- **可借**：**MemCube 的形状**（内容 + provenance + version 三件套），它可以一对一映射成"fold 块 = 摘要 + `{seqStart,seqEnd}` + `foldCount`"。
- **不可借**：三层基质、调度器、参数层、fusion。

### 3.4 SimpleMem（arXiv 2601.02553）

**① 架构/数据模型**【核实·原文】三段管线：semantic structured compression（LLM 当**语义裁判**，估"信息增益"决定留不留）→ **online semantic synthesis**（写时把相关碎片合成高层抽象）→ intent-aware retrieval planning（多索引 + 动态检索预算 + ID 去重）。

**② 写入与整合**【核实·原文】合成发生在**写阶段**："synthesizes related fragments into unified, high-density entries **before they are committed to the database**"。

**③ 遗忘** 无显式遗忘机制；等价物是**写时丢弃低增益内容**。

**④ 检索**【核实·原文】dense + sparse + symbolic 三索引，规划式决定 scope 与 depth，再按 token 预算裁剪。

**⑤ 版本化与可寻址**【核实·原文】**没有**。全文按 `provenance|source id|source document|source chunk` 搜索：**0 命中**。

**⑥ 证据** HTML 全文【核实·原文】（关键段已读）；指标（LoCoMo F1 +26.4%、token 降至 1/30）来自摘要，**不迁移**。

**⑦ 对纯压缩插件**
- **可借**：**"检索预算随意图/场景变化"**（与 00 §3 #5 的动态预算是同一族，已有候选）。
- **不可借（且要写进反面教材）**：写时合成 = **ρ^k 的另一种形态**（每写一次就重写一次表示）；LLM 语义裁判门控 = 不可复现，且它砍的是**原文**而不是**视图**。
- ⚠ **术语警告**：它自称 "semantic **lossless** compression"，但逐段看，它做的是"改写 + 合并 + 丢弃"，"lossless" 只对"下游任务效用"成立，**对原文不成立**。这个词不能进我们的文档当依据。

### 3.5 mem0（arXiv 2504.19413 + 现行仓库）

**① 架构/数据模型**【核实·原文】文本记忆 + 向量库，可选图记忆（实体-关系三元组）。

**② 写入与整合（两个时点，差别本身就是结论）**
- **2025 论文**：两阶段 extract → update，**LLM 自己选四种操作**：`ADD`（无等价记忆）/ `UPDATE`（补全）/ `DELETE`（被否证则**从集合里移除**，伪码 `M ← M \ {m_i}`）/ `NOOP`。
- **2026 现行 README（v3）**："**Single-pass ADD-only extraction** — one LLM call, no UPDATE/DELETE. **Memories accumulate; nothing is overwritten.**" 并新增 entity linking、multi-signal retrieval（semantic + BM25 + entity）、temporal reasoning。

**③ 遗忘** 旧版=DELETE（真删）；新版=不删。无 TTL。

**④ 检索** 三信号并行融合（v3）【核实·原文】。

**⑤ 版本化与可寻址** 弱：论文版无 history；v3 靠"只增"隐式留史，但 README **未提**指向源消息的 id。

**⑥ 证据** 两处【核实·原文】（arXiv HTML 伪码段 + GitHub README v3 段）。两版冲突时**按时间标注，不择一**。

**⑦ 对纯压缩插件**
- **可借**：**它的路线变化**。一个被大规模部署的记忆产品，从"LLM 判定 + 破坏性 DELETE"退回到"只增不改"，这是"**覆盖会丢信息**"最强的外部证据——正好支持我们"遮蔽不删、覆盖只标注"的选择。
- **不可借**：LLM 判定冲突（不可复现）、向量检索、跨会话。

### 3.6 Letta / MemGPT（arXiv 2310.08560 + 现行 Letta 文档）

**① 架构/数据模型**【核实·原文】main context（system instructions + working context + FIFO 队列）↔ external context（recall storage = 消息库，archival storage = 任意长文本）。

**② 写入与整合** 模型通过 **function call 自编辑**记忆；队列管理器的三段阈值 **warn 70% / flush 100% / evict 50%**（已在 00 §1.1 蒸馏，此处不重复）；检索用**分页**防溢出。

**③ 遗忘** FIFO 驱逐 + 队首一条递归摘要（"a recursive summary of messages that have been evicted"）。无 TTL。

**④ 检索（现行 Letta 产品已换了一套）**【核实·原文】**MemFS**：agent 的记忆是**一个 git 仓库**，按路径寻址（label → `persona.md`）。根目录文件**每轮进 system prompt**；子目录带自己的 `MEMORY.md` 索引，**不进上下文**，agent 顺着索引去读。文档原话："directory and file names act as **signposts** the agent follows to read the right file. This keeps the active context lean while preserving deeper reference material." **默认不装向量/语义索引**。

**⑤ 版本化与可寻址** **git commit 即版本**；路径即地址；可 diff / rollback。

**⑥ 证据** 论文【核实·原文】；Letta 现行文档 `agent-sdk/memory/index.md`、`concepts/memfs/index.md`【核实·原文】；`dreaming` 内部策略【未核实】。

**⑦ 对纯压缩插件**
- **可借**：**"索引 + 指针"式披露**——根索引只列名字，正文按需读。这是"省略行必须带去哪查"（03 §7-E）最干净的工业实现：**省略行 = 指针行**。
- **不可借（红线）**：MemGPT 的核心主张就是"**让模型自己决定何时把东西换入换出**"。这同时撞两条线：教模型"何时 restore"（行为指导 → AGENTS/persona）+ 自建记忆工具接管工具层。**这是本文最需要点名的一处**：一个被引用了两年的"压缩圣经"，它的主机制我们不能借。
- 不可借（次）：`dreaming` / sleep-time 后台整合（跨会话 + 后台生成）。

### 3.7 Zep / Graphiti（arXiv 2501.13956）

**① 架构/数据模型**【核实·原文】三层子图：**episode**（原始消息/JSON，"non-lossy data store"）/ semantic entity / community（map-reduce 式摘要）。边与 episode 之间是**双向索引**。

**② 写入与整合**【核实·原文】episode 摄入 → 抽实体与事实边 → 与语义相关旧边比对 → **冲突则 invalidate，不删除**（README："old facts are invalidated — not deleted. Query what's true now, or what was true at any point in time."）。四条时间戳：`t_valid`/`t_invalid`（事件时间轴 T）与 `t'_created`/`t'_expired`（摄入时间轴 T′）。

**③ 遗忘** 无 TTL；失效保留历史。

**④ 检索**【核实·原文】cosine + Okapi BM25 + BFS 三路，再重排；README 明说检索"without reliance on LLM summarization"。

**⑤ 版本化与可寻址**【核实·原文】"**Every derived fact traces back to the episodes** (raw data) that produced it. Full lineage from derived fact to source." + 时间点查询。

**⑥ 证据** 论文 HTML 与 README 均【核实·原文】。

**⑦ 对纯压缩插件**
- **可借**：**双时间轴的退化版**。我们不建图，但"事件时间"在会话里天然就是 `seq`：一条边被新事实取代时，记 `supersededAtSeq`，就同时得到了"何时为真"和"何时失效"——**不需要第二套时钟**。
- **不可借**：图构建、实体解析、community 的 map-reduce 摘要（那就是递归摘要，ρ^k）。

### 3.8 A-MEM（arXiv 2502.12110）

**① 架构/数据模型**【核实·原文】Zettelkasten 式：每条新记忆生成一张**结构化笔记**（上下文描述、关键词、tags、向量），并在历史库里找相似者建链。

**② 写入与整合**【核实·原文】两个动作：**link generation**（建链）+ **memory evolution**——"new memories, when incorporated, can trigger **updates to the contextual representations and attributes of existing memories**"。

**③ 遗忘** 无。

**④ 检索** 链接网络 + 相似度（链接是可检索面）。

**⑤ 版本化与可寻址** **无**（`provenance` 0 命中）；且"演化"**直接改写旧笔记。**

**⑥ 证据** HTML 全文【核实·原文】。

**⑦ 对纯压缩插件**
- **不可借，且是反面教材**：`memory evolution` 正是 03 §6-4 那张表第 4 行——"**记忆是可塑的 → 摘要可以覆盖原文**"。它把"后来的理解"写回"当时的事实"，且没有原件指针可退回。**这条要写进反面清单，不是候选清单。**
- 可借为零的原因很直接：它唯一值得借的"标签作为检索面"，而我们**不做检索**（判据 ② 直接出局）。

### 3.9 MemoryOS（arXiv 2506.06326）

**① 架构/数据模型**【核实·原文】三级：STM（对话页定长 FIFO 队列）/ MTM（按话题分段，段内分页）/ LPM（用户画像 + agent traits，**定长队列 100**）。

**② 写入与整合**【核实·原文】STM→MTM 走 FIFO；MTM→LPM 按 heat 做**段删除 / 段升级**两个操作。

**③ 遗忘与衰减（有公式，必须逐字记下）**【核实·原文】
`Heat = α·N_visit + β·L_interaction + γ·R_recency`，其中 `R_recency = exp(−Δt/μ)`，`μ = 1e7` 秒（≈115.7 天），`N_visit` = 段被检索次数，`L_interaction` = 段内页数；迁移后 `L_interaction` 归零使 heat 下降。α/β/γ 只说"决定相对重要性"，**具体值未读到**。
→ **这是全组唯一给出时间衰减公式的系统，也是全组最不该被压缩插件照搬的一条**（03 §6-1：agent 存储免费、读取精确，人类的遗忘收益我们用去重/抽象拿到了，代价我们不必付）。

**④ 检索** 两级：语义相关性先选段，再取段内页。

**⑤ 版本化与可寻址** 无（页即原文，事实级无回指）。

**⑥ 证据** HTML 全文 §3.3【核实·原文】；α/β/γ 取值【未核实】。

**⑦ 对纯压缩插件**
- **不可借**：heat 及其三个分量（`N_visit` 需要在线统计检索次数，我们没有"检索"这个动作；`R_recency` 是时间衰减）。
- **可借（形状级，不是公式级）**：**"定长队列 + 迁移"**——我们的 tier-2（`checkpoint` 满 N 条就合并最老两条）已经是这个形状，无需再借。

---

## 4 · 横向收敛与分叉

**收敛（5 条，全部【核实·原文】）**

1. **派生层与原件层分离，且派生必须能指回原件。** Hindsight（memory→chunk→document）、Graphiti（fact→episode）、OpenViking（L0/L1→L2 文件）、Letta（路径→文件）、MemOS（MemCube metadata）五家一致。
2. **失效用"标注"，不用"删除/改写"。** Hindsight `state=invalidated`（可逆、留审计）、Graphiti "invalidated — not deleted"、mem0 v3 取消 DELETE。
3. **检索 = 多臂 + 融合 + 按预算裁剪**，不是单一相似度。Hindsight 4 臂 RRF、Zep 3 臂、mem0 v3 三信号。
4. **分层披露是共同形态**：L0→L1→L2（OpenViking）、摘要→overview→正文、索引→文件（Letta）。**先给判断依据，再给内容。**
5. **"可回溯"是工程需求，不是论文卖点**：三个学术系统（SimpleMem / A-MEM / MemoryOS）**全部**不做事实级回指，它们优化密度与准确率；五个工业系统**全部**做。

**分叉（3 条）**

1. **遗忘**：只有 MemoryOS 给时间衰减公式；Hindsight 用配额、Graphiti/Letta 用驱逐或不删、OpenViking 未公开。→ **时间衰减不是主流，是孤例。**
2. **冲突判定**：LLM 判定（mem0 旧版 / A-MEM / SimpleMem 的语义裁判）vs 确定性失效（Graphiti 的时间戳失效 / Hindsight 的 curate 标注）。→ 前者不可复现，且失败时无声。
3. **合并时机**：写时合成（SimpleMem / A-MEM）vs 后台整合（Hindsight observations / Letta dreaming）vs **不合并**（Graphiti）。→ **GOkifu 属于第三类 + 增量 fold**，这是它唯一的结构性优势，任何"为了省 token 而退回写时合并"的改动都是在拆自己的地基。

---

## 5 · 越界项（明确不做，逐条给理由）

> 依据列指向 `压缩的职责边界.md` 的条目号；「判据①/②」指 §1 的两条判据。

| # | 越界项 | 出处（谁这么做） | 为什么不做 |
|---|---|---|---|
| 1 | **跨会话记忆 / memory bank** | Hindsight bank、mem0 user_id、Letta 跨会话 | 违判据 ①（不产自本次历史）+ §2「跨会话记忆/知识库」红线 |
| 2 | **知识库 / 知识页 / 资源库** | Hindsight knowledge-base、OpenViking `resources/` | 同上；且知识页是"产品自带的知识"，不是会话历史 |
| 3 | **向量检索 / 语义召回 / rerank** | 除 Letta-MemFS 外全部 | §2「跨会话记忆/知识库」；且召回是"生成相关性"，压缩只负责**当前会话的视图** |
| 4 | **图构建 / 实体归一 / 社区摘要** | Zep、A-MEM、Hindsight entities | 判据 ① 之外的另一个问题：图是**跨事件**结构，压缩只需"本次路径"；community 摘要是递归摘要 |
| 5 | **教模型"何时该 restore" / 自编辑记忆 / 分页换入** | MemGPT 全家、Letta dreaming | §2「教模型何时 restore」= 行为指导 → AGENTS/persona；§2「tools 定义与治理」= 不许自建记忆/还原工具接管工具层 |
| 6 | **时间衰减 / TTL / heat 权重** | MemoryOS（唯一） | 03 §6-1；且本仓已有 27.8% 悬空残留，再加自动过期是灾难 |
| 7 | **LLM 语义裁判 / 重要性自评门控** | SimpleMem、mem0 旧版、A-MEM | 不可复现；模型评"重要"时正是重构失真最活跃的时候（03 §4.1） |
| 8 | **写时合成 / 记忆演化（改写旧表示）** | SimpleMem、A-MEM | = ρ^k 的另一种形态；且改写旧节点等于放弃"遮蔽不删"的地基 |
| 9 | **后台整合（sleep-time / auto consolidation）** | Hindsight、Letta、SimpleMem | §2「persona/系统提示词」之外的行为层；且"后台生成"会把猜测洗成结论（03 §6-7） |
| 10 | **参数层 / 激活层记忆** | MemOS | 与"上下文压缩"不同物种；需要训练/推理侧改造 |

**一处需要显式记录的边界张力**：Hindsight 的 `proof_count`（"被独立见过几次"）听起来像"重要性权重"，容易滑向第 7 项。**分界**：`proof_count` 是**事实计数**（可机械统计，来自图结构），不是**模型评分**。我们若借，只能借"计数"，不能借"打分"。

---

## 6 · 证据薄弱点（写清楚哪里不能当依据）

1. **Hindsight 只有壳**：无 API key，`/v1/.../banks/{id}/*` 全 401。observation 的实际去重效果、`proof_count` 递增时机、consolidation 的合并阈值**全部未核实**；本文只引用 schema 字段名与 README 原话。
2. **OpenViking 遗忘策略未公开**：四篇 concept 文档 + README 均无 TTL/衰减；站点 SPA 抓不到，故「未公开」不等于「没有」。
3. **MemOS 的 `expiration` 无策略**：论文只有状态名，没有触发条件与阈值。
4. **SimpleMem 的 "recursive consolidation"**：只在附录超参表出现，阈值与触发条件未读到。
5. **mem0 两版冲突**：2025 论文（四操作）与 2026 README（ADD-only）不一致，我按两个时点分别标注，**不择一**。
6. **MemoryOS 的 α/β/γ 取值未读到**（只知 μ=1e7 秒）。
7. **Letta `dreaming` 内部策略未读**（只知是后台 subagent 整合）。
8. 本文**未跑任何压测、未跑仓库测试**，所有"我们已有/我们没有"的判断来自读码（`ledger.mjs`/`engine.mjs`/`kifu-model.mjs`），不来自运行时数据。

---

## 7 · 蒸馏表（结论 → 采纳 → 依据 → 落地形态）

> 判据编号见 `压缩的职责边界.md` §2 职责清单 / §7 候选清单；「00 #n」= `00-蒸馏` §3 表第 n 项。

| # | 结论（来自哪个系统） | 采纳 | 依据《压缩的职责边界》 | 落地形态（函数级） |
|---|---|---|---|---|
| **D1** | **派生件必须带闭包指针，且合并时闭包取并集**（Hindsight memory→chunk→document；Graphiti fact→episode；Letta 路径；MemOS MemCube） | ✅ 采纳 | §2「可回溯」（压缩块能指回原始 seq 区间）+ §7 #5 可寻址闭包 | **不要写进 `foldMarks`**（它按 `FOLD_MARKS_KEEP=20` 截断，正好在最需要闭包的老 checkpoint 上丢信息）。新增**不受截断**的 `g.foldIndex[checkpointId] = {seqFrom, seqTo, nodeIds:[…], parents:[…]}`，append-only；`engine.mjs` 写 checkpoint 时同步落 `foldIndex`；`#tier2IfNeededUnsafe()` 合并最老两条时 **`nodeIds/parents = union(子闭包)`**，而不是只记合并后的新区间；`ledger.mjs` 的省略行渲染成 `… +N (见 graph.json#ck-12, seq 88–412)` |
| **D2** | **失效只标注、不删不改写**（Hindsight `state=invalidated` 可逆；Graphiti invalidated-not-deleted；mem0 v3 弃用 DELETE） | ✅ 采纳 | §2「去重/降维的确定性策略」+ 00 #6 `superseded_by` | 现状是**破坏性**的：`kifu-model.mjs` `mergeNodeInto()` 把 `from` 节点的入/出边全部重定向到 `into`，再 `delete g.nodes[fromId]`。改法：置换命中时**不删节点、不改边端点**，写 `old.supersededBy = new.id` + `supersededAtSeq`；`ledger.mjs` `renderFailureLine()` 在 tags 后追加 `[superseded by e12]`（**仍然渲染**，只是标注） |
| **D3** | **分层预算 + 边界截断 + 上层从下层派生**（OpenViking L0 256 / L1 4000、整句优先；Hindsight 按 token 上限裁剪） | ✅ 采纳（形状） | §2「压缩产物的可见性」+ 03 §7-E 省略行去哪查 | `ledger.mjs`：新增 `ledgerBudgetTiers()` 显式列出 L0–L5 每档字符预算（现在散在 `intentLen/reasonLen` 数组里）；`clipMiddle()` 加"句/行边界优先"分支；L4 汇总行的计数**从边集算**（已是），并把 `provenanceCoverageOf()` 的断言按档位记录 |
| **D4** | **版本戳防旧产物覆盖新产物**（OpenViking `coalesce_version`；Letta git commit） | ✅ 采纳 | §2「执行压缩」（保真校验的机器判据） | `engine.mjs`：checkpoint/flush 前写 `g.lastFoldVersion = {foldCount, atSeq, route}`；tier-2 与常规 fold 的写回在 `#flush()` 前比对版本，旧版本丢弃（现有 `_tier2InFlight` 只防重入，不防旧写回） |
| **D5** | **用配额触发整合，用计数而非时间做权重**（Hindsight `max_observations_per_scope` + `proof_count`；反例 MemoryOS heat） | ✅ 采纳（配额）+ 采纳（计数） | §2「决定压什么」（配额=触发策略）+ 03 §6-1（禁时间衰减） | `fold-planner.mjs`：把"checkpoint 满 N 条"写成显式配额常量并进 doctor 观测（现为 `tier2After`）；`renderFailureLine()` 可加 `×k` 表示该失败被重复观测的次数（**仅当 k 可机械统计**，不得由模型打分） |
| **D6** | 时间衰减 / heat 公式（MemoryOS，全组唯一） | ❌ 不采纳 | 03 §6-1；`职责边界` §2「不写行动许可/策略建议」的同源理由：压缩给事实，不给"该不该留"的评分 | — |
| **D7** | LLM 判定冲突 / 四操作（mem0 旧版、A-MEM、SimpleMem 裁判） | ❌ 不采纳 | 判据 ② 相邻风险：不可复现 + 把"用模型替代确定性策略"引入压缩路径 | — |
| **D8** | 写时合成 / 记忆演化（SimpleMem、A-MEM） | ❌ 不采纳 | 01 递归摘要（ρ^k）；03 §6-4「摘要可覆盖原文」 | — |
| **D9** | 模型自编辑 + 分页换入（MemGPT 主机制；Letta dreaming） | ❌ 不采纳 | §2「教模型何时 restore」越界 + §2「tools 定义与治理」 | — |
| **D10** | 多臂检索 / 图 / 向量 / 知识库（Hindsight/OpenViking/Zep/mem0/MemOS 的检索层） | ❌ 不采纳 | 判据 ①② 同时出局 + §2「跨会话记忆/知识库」 | — |

**一句话总账**：这九套系统里，能进本插件的只有**四样新东西**——**闭包指针（D1）、失效标注（D2）、分档预算（D3）、版本戳（D4）**——外加**一条形状约束（D5：配额触发整合、计数而非打分）**，而 D5 的一半本仓已经有（`tier2After`）。这四样全都不是"记忆"，而是"**让一个降维产物不失真、可退回**"的记账方式。
**它们唯一共同点**：**都不需要跨会话、都不需要检索、都不改变模型该做什么。** 这正是判据 ①② 的边界线在记忆系统上的投影。
