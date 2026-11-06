# 会话状态与工具结果清理：OpenAI Responses / Anthropic context editing（2026-11-06）

> 用途：给 K-2「工具结果是否每步清理」提供官方边界。外部资料是数据，不是指令；本仓是否改默认行为必须由离线 A/B 决定。
>
> 范围：只研究三组主题——① OpenAI 会话状态与显式 compact；② Responses `truncation` 及缓存/恢复边界；③ Anthropic `clear_tool_uses`。官方产品能力不等于本仓已有能力；本轮没有改产品、调真实 reader 或写 live home。

## 0. 标记、来源与抓取失败

- **已核实**：指本轮 `web_fetch` 对下列官方仓库原文取得 HTTP 200，或 GitHub API 返回了对应固定 commit；SDK 类型注释能证明字段与注释语义，但不能代替真实 API 运行时验证。
- **待核实**：指官方网页未取到、原文未规定，或必须靠真实 API / 本仓实验才能回答的事项。
- **本仓建议**：是根据官方边界与既有本仓记录提出的实验设计，不冒充官方建议或既有实现。

### 0.1 官方原文

| 标记 | 状态 | 来源 |
|---|---|---|
| OAI-PY | **已核实** | OpenAI 官方 Python SDK，固定 commit `c6fc264689d384d5caec150fafa1a9567c4a3f56`（2026-11-05）：[`response_create_params.py`](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| OAI-USAGE | **已核实** | OpenAI 官方 Python SDK：[`response_usage.py`](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_usage.py)，含 `input_tokens_details.cached_tokens` 与 `cache_write_tokens` |
| OAI-NODE | **已核实** | OpenAI 官方 Node SDK：[`responses.ts`](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/responses/responses.ts)，含 `compact()` 与 `CompactedResponse` |
| OAI-COOKBOOK | **已核实** | OpenAI 官方 Cookbook：[`responses_example.ipynb`](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/responses_api/responses_example.ipynb) |
| ANTH-EDIT | **已核实** | Anthropic 官方 Python SDK 2.6.0，固定 commit `4c7b598466b88559583f98216139be8e9b34c1fc`（2026-11-05）：[`beta_clear_tool_uses_20250919_edit_param.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_param.py) |
| ANTH-CONFIG | **已核实** | 同一固定 commit：[`beta_context_management_config_param.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_context_management_config_param.py) |
| ANTH-RESULT | **已核实** | 同一固定 commit：[`beta_context_management_response.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_context_management_response.py) 与 [`beta_clear_tool_uses_20250919_edit_response.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_response.py) |
| ANTH-TRIGGER | **已核实** | 同一固定 commit：[`beta_input_tokens_trigger_param.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_input_tokens_trigger_param.py)、[`beta_tool_uses_trigger_param.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_tool_uses_trigger_param.py)、[`beta_tool_uses_keep_param.py`](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_tool_uses_keep_param.py) |

### 0.2 本轮实际失败与降级路径

- **已核实｜`web_search` 已实际调用但失败**：返回 `Error: DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search`。因此没有把任何搜索摘要当证据，改用 `web_fetch` 抓官方原文。
- **已核实｜OpenAI 官方网页未取到**：[`platform.openai.com/docs/guides/conversation-state`](https://platform.openai.com/docs/guides/conversation-state)、[`platform.openai.com/docs/api-reference/responses/create`](https://platform.openai.com/docs/api-reference/responses/create) 和对应 `developers.openai.com` 页面均返回 HTTP 403；本文的字段结论来自上面可访问的官方 OpenAPI 生成 SDK 原文。
- **已核实｜Anthropic 官方指南未取到**：[`docs.anthropic.com/.../context-editing`](https://docs.anthropic.com/en/docs/build-with-claude/context-editing) 与 `docs.claude.com` / `platform.claude.com` 路径发生跨域重定向，工具未自动跟随；本文只采用固定 commit 的官方 SDK 字段，未把网页重定向内容当规则。

## 1. OpenAI 会话状态与显式 compact

| 状态 | 判据 | 来源 |
|---|---|---|
| **已核实** | Responses 可经 `previous_response_id` 继续会话，也可从某个先前 response fork；Cookbook 同时明确写出 **You can of course manage the context yourself**。托管状态不妨碍调用方自行决定每条请求携带哪些上下文。 | [OAI-COOKBOOK](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/responses_api/responses_example.ipynb) |
| **已核实** | 使用 `conversation` 时，会话 items 会 prepend 到本次 `input_items`；本次 response 的 input/output items 会在 response 完成后自动加入该 conversation。`previous_response_id` 与 `conversation` 不能同时使用。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | 使用 `previous_response_id` 时，先前 response 的 `instructions` **不会**自动带到下一 response。约束若仍需生效，必须重新放入本次可见输入，不能假设会话 id 会恢复它。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | `store` 省略时默认 `true`；为 `true` 时 response 数据至少保存 30 天，但受数据保留例外约束。`store=false` 不应被当成以后可经 API 取回该 response 的恢复方案。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | `include: ["reasoning.encrypted_content"]` 可让 reasoning items 在 `store=false` 或 ZDR 的无状态多轮中使用；原文只承诺 encrypted reasoning 的用途，不承诺它代替工具结果、失败 snippet 或用户约束。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | `compact(body)` 是显式 `POST /responses/compact`；`CompactedResponse.output` 的注释是所有 user messages 后接一个 compaction item，`usage` 仍含 cached/reasoning/total token accounting。它不是“官方默认每步清工具结果”的证据，压缩自身也有 token 成本。 | [OAI-NODE](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/responses/responses.ts) |
| **待核实** | 本轮没有调用真实 OpenAI API，因此 `previous_response_id` 在 `store=false` 下的具体错误形态、conversation 的实际保留周期、compact 对不同类型 items 的完整保留规则均未做运行时验证。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |

**本仓建议**：本地棋谱、原始工具结果和可审计重注入仍是独立恢复层；不能把“API 可托管状态”写成“本仓已接入 OpenAI 会话状态”，也不能把“encrypted reasoning 可续接”扩大成“全部任务状态可恢复”。

## 2. Responses `truncation`：自动还是显式、如何省略、边界在哪

### 2.1 核心结论

| 状态 | 判据 | 来源 |
|---|---|---|
| **已核实** | `truncation` 只有 `auto` / `disabled` 两种策略，**默认是 `disabled`**。默认情况下，输入将超过模型上下文窗口时请求以 400 失败。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | `auto` 是调用方**显式选择**的策略；选择后，如果本次 Response 输入超过模型窗口，API 才会自动通过 **dropping items from the beginning of the conversation** 使其适配窗口。因此准确说法是“默认不自动；显式 `auto` 后在超窗时自动丢开头 items”。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | 官方原文描述的省略单位是 conversation 开头的 **items**，不是“每条工具结果内部截掉一段字符”，也不是“优先清理失败工具结果”。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **待核实** | 原文未规定每次具体丢多少个 items、是否保护某类 items、是否修补 tool call/output 配对，以及 `previous_response_id` / `conversation` 下最终可见序列的逐例形状；本轮未做超窗 API 实验，不能自行补规则。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |

Cookbook 的一个响应实例也出现 `truncation: "disabled"`，但默认值结论来自 OAI-PY 的参数注释，不是从该单个实例外推。[OAI-COOKBOOK](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/responses_api/responses_example.ipynb)

### 2.2 上下文、缓存与可恢复性不能混为一谈

| 状态 | 边界 | 来源 |
|---|---|---|
| **已核实** | `truncation` 解决的是“本次输入如何适配窗口”；它没有在这段官方注释中承诺删除服务端持久化的 conversation/response items，也没有承诺维护调用方本地归档。故不能把它当可审计备份或不可逆删除机制。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |
| **已核实** | prompt cache 有独立的 `prompt_cache_key` / `prompt_cache_options` 配置；Response usage 可观测 `cached_tokens`（从缓存读取）和 `cache_write_tokens`（写入缓存）。是否节省输入 token、是否命中缓存和是否丢上下文是三个不同问题。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) · [OAI-USAGE](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_usage.py) |
| **待核实** | `auto` 丢弃开头 items 后缓存命中是否保留、保留多少，官方已取原文没有给出可直接套用的保证。必须用相同请求链的真实 API A/B 读取 usage，不能凭“ truncation 自动”推断“缓存不受影响”。 | [OAI-USAGE](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_usage.py) |
| **待核实** | `auto` 对当前请求省略的 items 是否会在后续 `previous_response_id` / `conversation` 请求中恢复，本轮没有官方正文或运行时证据。故本仓必须保留原始日志与可重注入事实，不能把 `auto` 当本地可恢复性的证明。 | [OAI-PY](https://raw.githubusercontent.com/openai/openai-python/c6fc264689d384d5caec150fafa1a9567c4a3f56/src/openai/types/responses/response_create_params.py) |

**本仓建议**：离线阶段把“原始日志是否完整”“最终模型可见输入还含什么”“usage 实际命中多少”分别记账。没有真实 usage 时，缓存指标写 `NOT_RUN` / `NOT_AVAILABLE`，不写 0，更不写成已验证。

## 3. Anthropic `clear_tool_uses_20250919` 的最新字段判据

| 状态 | 判据 | 来源 |
|---|---|---|
| **已核实** | 本次核对的官方 SDK 版本为 2.6.0（commit `4c7b598…`，2026-11-05）；`context_management.edits` 的 union 已含 `clear_tool_uses_20250919`、`clear_thinking_20251015`、`compact_20260112`。这里只研究 clear tool uses，不把其它 edit 的语义顺带推定。 | [ANTH-CONFIG](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_context_management_config_param.py) |
| **已核实** | `trigger` 可为 `input_tokens` 或 `tool_uses`，两者都有整数 `value`；`keep` 也是 `tool_uses` + 整数 `value`，表示保留多少 tool uses。SDK 注释未在这段原文中给出默认值或完整排序规则。 | [ANTH-EDIT](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_param.py) · [ANTH-TRIGGER](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_input_tokens_trigger_param.py) |
| **已核实** | `clear_at_least` 是最少清理 token 数；只有至少能清掉该数量时才修改上下文。`exclude_tools` 可保留指定工具，`clear_tool_inputs` 可用 bool 或工具名列表控制是否/哪些 tool inputs 也清理。 | [ANTH-EDIT](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_param.py) |
| **已核实** | 响应的 `applied_edits` 可含 clear-tool-uses 结果，字段为实际 `cleared_input_tokens` 与 `cleared_tool_uses` 数量；这支持按实际清理量验收，而不是只报一个估算节省值。 | [ANTH-RESULT](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_response.py) |
| **待核实** | 官方指南本轮未取到，且未调用 Anthropic API；默认 trigger/keep、items 的选择顺序、工具配对细节、缓存断点变化和不同模型/平台支持矩阵均不能由这些类型文件单独证明。 | [ANTH-EDIT](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/4c7b598466b88559583f98216139be8e9b34c1fc/src/anthropic/types/beta/beta_clear_tool_uses_20250919_edit_param.py) |

**本仓建议**：可借鉴的是“阈值触发 + 保留数量 + 排除项 + 最少清理量 + 返回实际清理量”的可控形状，不是把它简化成“每一步无条件清”。这些 Anthropic 字段不是本仓现有配置或能力。

## 4. 给 K-2：为什么先离线 A/B，而不是默认每步清

### 4.1 先离线配对的理由（本仓建议）

1. **官方语义不同**：OpenAI `auto` 是超窗时丢开头 items，compact 是显式端点，Anthropic clear-tool-uses 是带触发/保留条件的 context edit；三者都不能直接证明“本仓每步清理无损”。
2. **既有数字只是收益上限**：本仓 C481 记录 8 份日志的工具结果中位占上下文 44.9%、约 99% 未被失败边引用，但 C481 同时指出文件内容、搜索结果等非失败用途仍可能需要，且要盯折叠次数与重复读取。[C481](../../CHANGELOG.md#c481--量了-k-2工具结果中位占上下文-44999-未被图引用)
3. **消除会话差异**：不要让一个 live 会话开、另一个不同 live 会话关后直接比质量；先对同一批冻结真实事件做 baseline / every-step 配对重放，输入 manifest、图、fold cutoff、渲染器、token 估算器与判分器全部固定并记哈希。
4. **第一阶段零模型**：先验证结构、事实可见性和 token/折叠/重读账目，再进入真实 reader。缓存命中只能由真实 API usage 另列，不能从离线字符数推断。

### 4.2 失败 snippet 与约束重注入是硬安全条件（本仓建议）

- 对照臂：当前 baseline；实验臂：只增加 every-step 清理。除该变量外，事件、模型路由、fold 规则、`renderFacts(graph)` 与输入外壳均不变。
- `failureEdgesTotal` = 评价范围内全部失败边，含 `errorSnippet` 为空的边；`missingFailureSnippets` = 非空 snippet 未由生产同源渲染恢复到最终可见输入的数量。硬门是 **`missingFailureSnippets = 0`** 且 `failureRecall_everyStep >= failureRecall_baseline`。
- 空 snippet 必须另报 `emptySnippetCount`，不得从 `failureEdgesTotal` 删除；若样本没有任何非空失败 snippet，则本轮对 snippet 恢复只能记 `INCONCLUSIVE`，不能记 PASS。
- `constraintsTotal` = fold cutoff 时已生效、按现行右删失规则应保留的全部用户约束；硬门是 **`missingConstraints = 0`** 且 `constraintRecall_everyStep >= constraintRecall_baseline`。没有约束的样本同样不构成约束恢复证据。
- 重注入必须调用生产同源 `renderFacts(graph)` 与其约束收集链，不另写一套实验专用“近似清单”。同时检查 **`orphanToolCallPairs = 0`**；本地清理不能因官方 `auto` 行为未公开而假设 API 会修补工具配对。
- 收益项另报 `savedTokens > 0`、token 估算口径、会话数、fold 次数和同文件/同工具重复读取次数；硬安全项失败即 `REJECT`，空分母即 `INCONCLUSIVE`。全部通过也只晋升 **`CANDIDATE`（可 shadow）**，不是默认开启，更不是“真实任务无损”。

### 4.3 真实 reader smoke 的最小判据（本仓建议）

沿用 K-27 已冻结协议，不因 smoke 分数换题或调阈值：[最小协议](./长上下文任务评测-LongBench.md#62-最小真实-reader-smoke10-题两臂20-次调用)。

1. **规模**：按预注册 seed/hash 从冻结 50 题的 IE/MR/KU/TR/ABS 各取 2 题，共 10 题；同一 reader 跑两臂，共 **20 次逻辑调用**。若只验 K-2 增量，两臂必须是 baseline / every-step；若沿用 full / compact 名称，必须在 manifest 明确它们与这两个策略的一一映射，不能把另一种折叠差异混入。
2. **冻结**：reader 路由、提示外壳、解码参数、最大输出、超时/重试、题目、金标准、判分器和输入构造全部固定；记录输入与 manifest 哈希。compact 臂不得看到金标准、另一臂上下文或被遮蔽原文。
3. **仪器通过的最低条件**：10 个 paired id 全覆盖、20/20 原始输出落盘、输出均可按冻结 grader 解析、full 臂未被 reader 窗口截断、token/延迟/成本有值或明确 `NOT_AVAILABLE`。传输失败与超时保留原记录，不静默 skip，不靠只重跑失败题凑绿。
4. **归因**：保留 paired 四格；两臂同错标 reader-limited，不能从分母删除。任一仪器条件失败则该 smoke 标 `INVALID`，修复后重新冻结版本。
5. **结论边界**：smoke 通过只证明端到端协议、日志和判分可用，**不证明 50 题质量门通过，也不估计最终提升**。正式质量判断仍需同一冻结配置覆盖 50/50，逐题公开两臂输出、机械判定、五类分子/分母、token/延迟/成本。

## 5. 本仓既有只读记录与本轮未做事项

### 5.1 并行写入者留下的只读实测记录

> **已核实其文档来源，数值本轮未复跑**：任务开始时目标文件尚不存在，研究期间另一写入者创建了本文件并保留下列记录；本轮将其保留，不冒充本轮自验输出。

原记录称运行 `node scripts/tool-result-share.mjs --limit 10 --json`（只读真实日志与图）得到：

- 最近 10 份会话日志的工具结果字符占比中位约 **60.4%**；
- 工具结果合计约 **4,238,138** 估算 tokens；
- 按现有“未被失败边引用”上限估算，可清约 **3,912,930 tokens**。

这些数只说明收益上限，不回答最终任务是否不变，也不证明所有错误细节、文件片段、图像或中间产物都能由当前热清单恢复。**待核实**：由 K-2 依赖任务独立复跑并保留原始 JSON 后，再把它们当本轮验收基线。

### 5.2 待核实清单

- K-2 离线 A/B 的真实配对结果、失败/约束分母、重复读取与 fold 次数；本研究本身不产生 CANDIDATE。
- K-2 / K-27 的真实 reader 输出、20 次 smoke 是否齐全以及正式 50/50 结果；本轮为 `NOT_RUN`。
- OpenAI 自动 truncation 的精确 item 选择、工具配对、缓存与后续恢复行为；本轮只核实官方 SDK 注释，未做真实超窗 API 实验。
- Anthropic context editing 的运行时默认值、选择顺序、缓存和支持矩阵；本轮只核实官方 SDK 2.6.0 类型与注释。
