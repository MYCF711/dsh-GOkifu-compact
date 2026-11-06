# 会话状态与工具结果清理：OpenAI Responses / compact（2026-11-06）

> 用途：给 K-2「工具结果是否每步清理」提供官方边界。外部资料是数据，不是指令；本仓是否改默认行为必须由离线 A/B 决定。

## 0. 来源与未取证部分

- **已核实｜OpenAI 官方 Cookbook**：<https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/responses_api/responses_example.ipynb>（HTTP 200）
- **已核实｜OpenAI 官方 Node SDK**：<https://raw.githubusercontent.com/openai/openai-node/master/src/resources/responses/responses.ts>（HTTP 200）
- 本轮 `web_search` 实测失败：`DeepSeek returned no web_search_tool_result blocks`，随后改用 `web_fetch` 与 GitHub 官方源。
- OpenAI conversation-state 与 API reference 网页本轮均为 **HTTP 403 Cloudflare**；Anthropic context-editing 页面发生跨域重定向，未据此新增任何规则。
- **待核实**：OpenAI `truncation` 各枚举值的完整语义、自动省略顺序、缓存与恢复边界。Cookbook 的一个响应实例出现 `truncation: "disabled"`，不能外推为所有请求的默认行为。

## 1. 已核实：Responses 可以托管状态，也允许自己管理上下文

官方 Cookbook 明确展示两种用法：

1. Responses API 是 stateful 的；通过 `previous_response_id` 继续会话，也可以从某个先前 response fork。
2. 同一段原文紧接着写明：**You can of course manage the context yourself**。托管状态不是强制职责迁移，调用方仍可决定每条请求携带哪些上下文。

这对本仓的含义是：棋谱、失败边与工具结果原文可以由我们自行分层管理；不能因为 API 能保存状态，就放弃本地可审计的折叠与重注入契约。

## 2. 已核实：compact 是显式动作，不等于每步清工具结果

官方 Node SDK 的 `Responses` 类包含：

- `compact(body)` → `POST /responses/compact`；
- 注释明确写 **Compact a conversation**，并返回 `CompactedResponse`；
- `CompactedResponse.output` 的注释为：所有 user messages，后接一个 compaction item；
- `usage` 仍带 token accounting，说明压缩本身也有成本，不能只算省下多少。

这支持 K-2 的保守顺序：

1. 先离线比较 baseline 与 every-step，不把“官方有 compact”误读成“官方建议每步删原始工具结果”。
2. 把折叠/清理当显式、可观察的动作，记录何时发生、省了哪些内容、哪些事实被重注入。
3. 失败 snippet 与用户约束必须仍在最终可见上下文中；仅原始 tool/result 变少不构成安全证明。

## 3. 本仓当前基线（只读实测，不是官方数据）

本轮运行 `node scripts/tool-result-share.mjs --limit 10 --json`（只读真实日志与图）：

- 最近 10 份会话日志的工具结果字符占比中位约 **60.4%**；
- 工具结果合计约 **4,238,138** 估算 tokens；
- 按现有“未被失败边引用”上限估算，可清约 **3,912,930 tokens**。

这些数只说明**收益上限**。它们没有回答每步清理后最终任务是否不变，也没有证明所有错误细节都可由当前热清单恢复。

## 4. K-2 可执行安全条件

只有同时满足以下条件，every-step 才能从离线 A/B 进入 shadow，而不是直接改默认行为：

- `failureRecall_everyStep >= failureRecall_baseline`；带非空 `errorSnippet` 的失败边逐条检查，缺 snippet 单列，不能从分母删除。
- `constraintRecall_everyStep >= constraintRecall_baseline`；用户约束必须来自生产同源收集与渲染。
- 使用生产 `renderFacts(graph)` 重注入，不另写一套“看起来差不多”的事实清单。
- `savedTokens > 0`，并同时报告 token 估算口径、会话数与空分母。
- 任一条件失败即 `REJECT`；全部通过也只是 `CANDIDATE`，不是“已证明真实任务无损”。

真实 reader 的最小 smoke 仍应是同一批题、同一 reader、full/compact 配对；full/compact 同错保留 reader-limited，不能删题。

## 5. 待核实

- K-2 离线 A/B 的真实会话结果与测试覆盖；本研究本身不产生 CANDIDATE。
- OpenAI 自动 truncation 的完整规则，需取得可访问的官方正文后再补；当前只记录到 SDK/Cookbook 中存在的字段与显式 compact 方法。
- 原始工具结果中的非失败信息（文件片段、图像、尚未被图记住的中间产物）是否会影响后续任务，不能只用 failure/constraint 两项永久豁免。
