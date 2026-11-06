# 关联标识与隐私：OpenTelemetry logs / trace（2026-11-06）

> 用途：为 K-31 永久隐私审计器补充 correlation identifiers 判据。本轮只做外研与规则设计，不写产品代码，不把 OpenTelemetry 的建议说成本仓已经实现的命令。
> 标记口径：**已核实** = 本轮实际抓到官方原文；**规则建议（待实现）** = 由官方事实和本仓既有 P1–P5 分类推导，不是 OTel 规范原文；**待核实** = 仍需仓内样本或实现证据。
> 官方页面快照：本轮页面显示 OpenTelemetry Specification **1.62.0**、Semantic Conventions **1.45.0**；`session` 语义约定仍为 **Development**，不能当成稳定字段承诺。

## 0. 给 K-31 的先行结论

1. **已核实**：`TraceId` / `SpanId` 的标准用途是把日志、请求路径及操作关联起来；`session.id` 的标准用途则是标识最终用户的一段会话，并把该期间的 Logs、Events、Spans 联成一组。二者不能因为都叫 ID 就混为一谈。来源：[Tracing API · SpanContext](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)、[Logs Data Model · Trace Context Fields](https://opentelemetry.io/docs/specs/otel/logs/data-model/#trace-context-fields)、[Semantic conventions for session](https://opentelemetry.io/docs/specs/semconv/general/session/)。
2. **规则建议（待实现）**：裸 `traceId` / `spanId` / `requestId` / `runId` 默认进 `review`；只有证明它联接到真实用户会话、非公开 telemetry，或兼具访问凭据作用时才升级为 `confirmed`。但未处置的 `review` 同样让发布门失败，不能把「尚未证实」写成「安全」。
3. **规则建议（待实现）**：真实 `session.id`、`session.previous_id`、DSH 真实会话标识，以及任何已证明能联接到这些会话的 trace/span/request/run id，均判 `confirmed` 并阻断；真实 session 联接不因字段改名为 `traceId` 而放行。
4. **规则建议（待实现）**：`public-synthetic` 只接受精确登记的官方文档示例或本仓合成 fixture；UUID、32 位 hex、16 位 hex、随机外观、全零占位或「看起来不像真的」都不是充分的公开证明。
5. **已核实**：OTel 明确说敏感性的判断依赖具体上下文，并把 **Session tokens**、**User behavior data** 列入敏感数据示例；因此「是 telemetry 标准字段」不等于「可公开发布」。来源：[Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)。

## 1. 检索形状与官方来源

### 1.1 `web_search` 已实际调用但失败（已核实）

本轮一次传入 4 个限定 `opentelemetry.io` 的 query。工具没有返回搜索结果，而是返回：

```text
Error: DeepSeek API error (HTTP 400): 腾讯 Marvis TENCENT: 客户端AI业务错误: 无效模型id
```

错误同时给出请求端点 `http://127.0.0.1:3425/v1/messages`，并说明 search endpoint 与 chat 配置分开。本轮没有修改宿主配置，按任务约定改用 `web_fetch` 抓官方原文。完整错误形状与后续实测输出见 `tmp/dsh-gokifu-compact/otel/REPORT.md`。

### 1.2 成功抓取的官方来源（均为 HTTP 200，已核实）

| 编号 | 官方 URL | 本文核实的内容 |
|---|---|---|
| S1 | <https://opentelemetry.io/docs/specs/otel/logs/data-model/> | Logs 顶层字段；TraceId/SpanId/TraceFlags；Attributes 可含其他 request context |
| S2 | <https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext> | SpanContext 的传播语义、ID 长度与编码、root/child 的 TraceId 关系、Span 的操作语义 |
| S3 | <https://opentelemetry.io/docs/concepts/signals/logs/> | 自动把现有日志与 active trace/span 关联；日志字段表 |
| S4 | <https://opentelemetry.io/docs/concepts/signals/traces/> | trace 是请求路径；span 是工作单元；parent/child 与跨进程关联 |
| S5 | <https://opentelemetry.io/docs/specs/semconv/general/session/> | session 覆盖最终用户活动；session.id / session.previous_id；Development / Opt-In |
| S6 | <https://opentelemetry.io/docs/security/handling-sensitive-data/> | 敏感性依上下文；数据最小化；删除、redaction、hash 的边界 |
| S7 | <https://opentelemetry.io/docs/concepts/signals/baggage/> | Baggage 可传播 user/client id；HTTP header 可见性与向下游继续传播的风险 |
| S8 | <https://opentelemetry.io/docs/specs/otel/baggage/api/> | Baggage 是应用自定义 name/value；可清除后再发往不受信进程 |

补充失败形状：抓取 `https://opentelemetry.io/docs/specs/otel/logs/data-model/index.md` 时发生一次 `tool call timed out after 30000ms`；同一官方页面的 HTML URL（S1）已成功返回 HTTP 200，本文只使用成功读到的内容。

## 2. ID 的规范语义与相互关系

### 2.1 TraceId / SpanId 是关联标识，不是 session 的同义词

| 项 | 已核实的官方事实 | 官方 URL |
|---|---|---|
| **TraceId** | 有效值是至少一个字节非零的 **16-byte** 数组；API 的 hex 形式必须是 **32 个小写 hex 字符**。root span 创建新 TraceId，有 parent 的 span 沿用 parent 的 TraceId，所以它能串起一条 trace 中的 spans。 | [S2 · SpanContext](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)、[S2 · Span Creation](https://opentelemetry.io/docs/specs/otel/trace/api/#span-creation) |
| **SpanId** | 有效值是至少一个字节非零的 **8-byte** 数组；hex 形式必须是 **16 个小写 hex 字符**。一个 Span 表示 trace 中的一个 operation，parent/child 关系构成 trace tree。 | [S2 · SpanContext](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)、[S2 · Span](https://opentelemetry.io/docs/specs/otel/trace/api/#span) |
| **SpanContext** | 包含 TraceId、SpanId、TraceFlags、TraceState，是可序列化并随 distributed context 传播的不可变部分。 | [S2](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)、[S4 · Span Context](https://opentelemetry.io/docs/concepts/signals/traces/#span-context) |
| **日志关联** | Logs Data Model 把 TraceId、SpanId、TraceFlags 列为可选顶层字段；有 SpanId 时也应有 TraceId。概念页说明自动 instrumentation / SDK 可用 active trace 和 span 的 IDs 关联现有日志。 | [S1](https://opentelemetry.io/docs/specs/otel/logs/data-model/#trace-context-fields)、[S3](https://opentelemetry.io/docs/concepts/signals/logs/#opentelemetry-logs-for-applications) |
| **trace 的业务粒度** | trace 描述 request 在应用中的路径；span 是其中一个 unit of work / operation，可跨进程、服务、VM 等组装。 | [S4](https://opentelemetry.io/docs/concepts/signals/traces/) |

**规则建议（待实现）**：上述条款定义的是 observability correlation 与传播，不定义登录态、Cookie、访问授权或 DSH 会话边界。审计器因此不得写出「凡 traceId 都是 secret」或「凡 traceId 都可公开」这两条绝对规则；必须再看来源和可联接性。

### 2.2 requestId / runId 与它们的关系

- **已核实**：S1 的 Logs 顶层字段表有 TraceId/SpanId，但没有通用 `RequestId` 或 `RunId` 顶层字段；`Attributes` 可以承载「Trace Context Fields 之外的 request context」，也允许应用自定义数据。来源：[S1 · Log and Event Record Definition](https://opentelemetry.io/docs/specs/otel/logs/data-model/#log-and-event-record-definition)、[S1 · Attributes](https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-attributes)。
- **已核实**：Baggage 也是应用自定义 name/value，可用来传播 `clientId`、User ID 等上下文，但它与 span/log attributes 不是自动等同的存储。来源：[S8 · Overview](https://opentelemetry.io/docs/specs/otel/baggage/api/#overview)、[S7 · Baggage is not the same as attributes](https://opentelemetry.io/docs/concepts/signals/baggage/#baggage-is-not-the-same-as-attributes)。
- **待核实**：本轮核对的 Base Logs Data Model / Tracing API 没有给通用 `requestId` / `runId` 规定与 TraceId 的一一映射；特定 vendor、RPC 系统或本仓字段是否另有语义约定，需按实际 producer 核对，不能外推为「整个 OTel 永远没有同名字段」。

**规则建议（待实现）**：普通 request/run/interaction id 只表示某次应用级交互或执行，可能覆盖一次 HTTP 请求、一次 agent run、一次重试或一批操作；实现者可以另建它与 trace/span 的映射，也可以直接复用某个真实 session id。故审计器要先识别 producer 与生命周期，再判分类，不能仅按字段名或值形状推断等价关系。

### 2.3 session.id 为什么需要单独阻断

| 已核实事实 | 隐私含义（规则建议） | 官方 URL |
|---|---|---|
| Session 是应用活动与 end user 在一段期间内执行的动作；每个 session 有唯一 ID，并加入该期间产生的 Logs、Events、Spans。 | 真实 `session.id` 是把 telemetry 联到真实用户活动的直接枢纽，不能按普通随机 ID 放行。 | [S5](https://opentelemetry.io/docs/specs/semconv/general/session/) |
| 新 session 可带 `session.previous_id`，使 backend 联接前后两个 session；属性表还明确写「for this user」。 | `session.previous_id` 不是较低敏感的旧值；它扩大跨会话追踪链，真实值同样阻断。 | [S5 · Attributes](https://opentelemetry.io/docs/specs/semconv/general/session/#attributes)、[Session registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/session/#session-previous-id) |
| `session.id` / `session.previous_id` 当前为 Development、Opt-In、string。 | 不因字段处于 Development 就降低隐私等级；也不能要求它们必须是 UUID。 | [S5](https://opentelemetry.io/docs/specs/semconv/general/session/) |
| OTel 把 Session tokens 和 User behavior data 都列为可能的敏感数据。 | `session.id` 不应被机械当成认证 token；但它所连接的用户行为仍需保护。真正 Cookie/access session token 走 P1，真实行为联接走 P4。 | [S6 · Sensitive data considerations](https://opentelemetry.io/docs/security/handling-sensitive-data/#sensitive-data-considerations) |

**关系边界（已核实事实的直接合并）**：一个 session 覆盖一段期间内的多项活动，因此可包含多个请求和多个 traces；一个 trace 又由多个 spans 组成。`session.id ≠ traceId ≠ spanId`，`requestId/runId` 也不能在没有 producer 证据时补上等号。来源：[S4](https://opentelemetry.io/docs/concepts/signals/traces/) + [S5](https://opentelemetry.io/docs/specs/semconv/general/session/)。

## 3. 何时只是公开关联元数据，何时必须脱敏

### 3.1 「可传播 / 可关联」不等于「可公开发布」

1. **已核实**：SpanContext 本来就可跨进程传播，Baggage 和其他 trace context 还可进入 HTTP headers；OTel 明确提醒其可能被网络观察者看到，并被下游继续传出网络边界。来源：[S2](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)、[S7 · Baggage security considerations](https://opentelemetry.io/docs/concepts/signals/baggage/#baggage-security-considerations)。
2. **已核实**：OTel 不会替实现者判断具体上下文中的敏感数据，要求实现者审查 telemetry、遵循数据最小化并保护敏感信息。来源：[S6 · Your responsibility](https://opentelemetry.io/docs/security/handling-sensitive-data/#your-responsibility)。
3. **规则建议（待实现）**：本文的「公开关联元数据」是本仓发布分类，不是 OTel 官方安全标签。只有 `public-synthetic`（或本仓既有的精确 `public-declared`）才能直接过门；标准字段名、跨服务传播需求、hex/UUID 形状都不构成这个分类。

### 3.2 为什么不能仅凭 UUID 判敏感或不敏感

- **已核实**：TraceId/SpanId 的规范形状是 bytes / lowercase hex，不是 UUID；`session.id` 的规范类型是 string，官方虽给出 UUID 形状示例，但没有把类型限定为 UUID。来源：[S2 · Retrieving the TraceId and SpanId](https://opentelemetry.io/docs/specs/otel/trace/api/#retrieving-the-traceid-and-spanid)、[S5](https://opentelemetry.io/docs/specs/semconv/general/session/#attributes)。
- **规则建议（待实现）**：同一个 UUID 字面量可以出现在合成 fixture、真实 DSH `sessions/<id>` 路径、真实 `session.id`、request id 或 access id 中；敏感性来自**来源、用途、可联接性和授权语义**，不是字符集、长度、版本位或随机性。
- **规则建议（待实现）**：正则只适合**发现候选**。没有 provenance 时标 `review`；有真实会话/私有 telemetry 联接证据时标 `confirmed`；有可审计合成来源时才标 `public-synthetic`。
- **已核实**：OTel 对 hash 也给出限制：输入空间小且可预测时，用户 ID/name 的 hash 在实践中可能可逆。来源：[S6 · Risk and limitations of hashing for anonymization](https://opentelemetry.io/docs/security/handling-sensitive-data/#deleting-and-hashing-user-information)。
- **规则建议（待实现）**：稳定 hash 还可能保留跨记录联接性；发布不需要关联时优先删除或换成明确合成值，不把「已哈希」自动改成公开。

## 4. K-31 永久审计器的分类判据

> 本节全部是**规则建议（待实现）**，依据为 S1–S8 及本仓既有《发布脱敏与日志清理-外部资料》的 P1/P4 分类；不是 OTel 给本仓下达的实现命令。

### 4.1 决策表

| 命中与证据 | 分类 | 门禁动作 | 判据边界 |
|---|---|---|---|
| 真实 `session.id` / `session.previous_id`、真实 DSH session id、真实 `sessions/<id>` 材料中的标识 | **confirmed** | **阻断** | 不因 UUID、随机性、已过期或字段改名而放行；过期不等于失去历史联接性 |
| 任意 trace/span/request/run/interaction id，已证明能 join 到真实用户、真实 session、非公开 spans/logs，或能读取非公开 backend 数据 | **confirmed** | **阻断并脱敏** | 字段叫 `traceId` 不降低等级；若兼具认证/访问作用，同时按 P1 处理 |
| 明确的真实 session token / cookie / access token | **confirmed** | **阻断** | 属 P1 凭据，不只按 P4 关联标识处理 |
| 裸 `traceId` / `spanId` / `traceparent`，或普通 `requestId` / `runId` / `interactionId`，来源和联接关系未明 | **review** | **未处置即阻断** | 不伪称已确认泄露，也不因「通常只是 correlation」放行 |
| 来自真实运行记录的 ID，但本轮尚未找到 session/user/private-backend 联接 | **review** | **未处置即阻断** | 「真实来源」提高调查优先级；只有联接证据充分时才把结论写成 confirmed |
| OTel 官方文档逐字示例，或本仓明确 synthetic fixture 中的 ID | **public-synthetic**，仅精确登记后 | 可放行该命中 | 登记 `(path, ruleId, literal, sourceUrl/fixtureId, reason)`；同值换路径、换字段或进入真实运行上下文必须重判 |
| 已主动公开且经所有者确认不再联接非公开数据的真实关联 ID | 不冒充 synthetic；走既有 **public-declared** 精确豁免 | 仅登记后放行 | 「曾出现在公开 issue」本身不证明其余 trace/log/session 数据也公开 |
| 全零 ID、明显占位符、随机测试样例 | 默认 **review**；有精确 fixture/占位登记才可 **public-synthetic** | 未登记则阻断 | 全零 TraceId/SpanId 在规范上无效，但「无效 ID」仍不自动证明整段材料合成 |

### 4.2 建议的规则 ID 与优先级

| ruleId | 扫描对象 | 默认分类与升级条件 |
|---|---|---|
| **P4-OTEL-TRACE** | `traceId` / `trace_id` / `traceparent` 中 32-hex 候选 | `review`；真实用户/session/私有 telemetry 联接证据 ⇒ `confirmed`；精确官方/合成登记 ⇒ `public-synthetic` |
| **P4-OTEL-SPAN** | `spanId` / `span_id` / `parentId` / `traceparent` 中 16-hex 候选 | 同上；SpanId 单独出现时也要查同一记录的 TraceId 与上下文 |
| **P4-APP-CORRELATION** | `requestId` / `runId` / `interactionId` / `correlationId` | `review`；若 producer 证据表明它实际复用 session/access id，立即升级 P4 或 P1 `confirmed` |
| **P4-SESSION-LINK** | `session.id` / `sessionId` / `session_id` / `session.previous_id` / `sessions/<id>` | 真实值或真实会话材料 ⇒ `confirmed`；语义/来源未明 ⇒ `review` 且仍阻断；精确合成 fixture 才可豁免 |
| **P1-ACCESS-IDENTIFIER** | Cookie、Authorization、session/access token、可读取私有记录的 URL/ID | 有真实凭据或访问语义 ⇒ `confirmed`；不得被 P4 的 synthetic 豁免覆盖 |

**优先级**：`confirmed` 证据 > 精确 `public-synthetic` 登记 > 未明 `review`。同一字面量同时命中 P1 与 P4 时按更严的 P1 处理；同一行或同一 URL 的其他字段继续扫描，不做整行豁免。

### 4.3 confirmed / review / public-synthetic 的验收定义

- **confirmed**：报告必须有不泄露原值的证据类型，例如 `real-session-path`、`real-session-attribute`、`private-telemetry-join`、`access-capability`。没有证据只写 suspicion 时不得叫 confirmed。
- **review**：表示「候选存在，但 provenance / producer / linkage 未闭合」。发布策略是 fail closed；报告措辞保持「待复核」，不写「确认泄露」。
- **public-synthetic**：必须有可回溯来源和精确 allowlist。OTel 官方示例可登记 sourceUrl，本仓 fixture 可登记 fixtureId；禁止 `*.md`、整个 `test/`、整个目录、所有 UUID、所有 32-hex 的宽泛豁免。

### 4.4 脱敏与报告要求

1. **真实 session 联接仍要阻断**：仅把 `session.id` 字段改名、仅删 `user.id`、仅把 UUID 变成另一随机 UUID，都没有证明联接已断开。需要删除真实 ID 及可反查映射，或改用明确合成数据并重审整条记录。
2. **脱敏覆盖所有出现点**：同一真实 ID 可能同时存在于 log body、attributes、`traceparent`、Baggage、URL query、文件路径和 `sessions/<id>` 引用；只遮一个字段不算完成。
3. **不把 hash 当万能脱敏**：确需保留关联时应单独评估可逆性与稳定联接性；公开发布不需要关联时优先删除/合成化。依据：[S6](https://opentelemetry.io/docs/security/handling-sensitive-data/#deleting-and-hashing-user-information)。
4. **报告不二次泄密**：输出 `ruleId + path + line + classification + evidenceType/reason`，不打印完整真实 ID、Cookie、session token 或私有 URL；定位信息也不得暗中重建原值。
5. **审计器只判分，不自动改写**：清理另开一刀并复验；避免为通过扫描器破坏可执行配置或 trace fixture 的格式约束。

### 4.5 K-31 最小合成测试矩阵（规则建议，待实现）

| 用例 | 期望 |
|---|---|
| 精确登记的 OTel 官方 TraceId/SpanId 示例 | `public-synthetic`，该命中可过门 |
| 同一示例值被放进真实 `sessions/<id>` 材料或真实 session 映射 | 来源证据优先，升 `confirmed`，不得沿用文档豁免 |
| 未知来源 `requestId=<UUID>` | `review`，未处置时退出非零 |
| 未知来源 32-hex / 16-hex / UUID | `review`，不能仅凭形状判 confirmed 或 public |
| 真实 `session.id` 与真实 `session.previous_id` 同时出现 | 两个均 `confirmed`，联接链必须清理 |
| `traceId` 与真实 `session.id` / `user.id` / 非公开 trace 记录同现 | `P4-OTEL-TRACE=confirmed`；其他字段各自判分 |
| 真实 session/access token 放在 `runId` 或 `requestId` 字段 | P1/P4 `confirmed`，字段名不降级 |
| 精确 synthetic trace/span fixture，附带另一枚未登记未知 ID | 已登记者可放行，未知者仍 `review`；禁止整文件豁免 |
| 全零 TraceId/SpanId | 先按无效/占位候选报告；无精确登记不得自动公开 |
| 变异：取消真实 session 联接检查 | 对应 confirmed 用例必须变红，防止规则退化成纯 UUID 扫描 |

## 5. 待核实与交接边界

1. **待核实｜仓内样本**：本轮没有读取或扫描 live sessions，也没有取得 K-31 最终 producer 清单；实际字段别名、真实 ID 来源、公开 fixture 和 allowlist 需由实现轮据非 live 合成样本及发布材料校准。官方规则依据仍是 [S1–S8](#12-成功抓取的官方来源均为-http-200已核实)。
2. **待核实｜request/run 语义**：特定 vendor、RPC 或 DSH producer 是否赋予 request/run id 额外访问或 session 语义，要读该 producer；本轮只确认 Base Logs Data Model / Tracing API 没有给出通用一一映射。来源：[S1](https://opentelemetry.io/docs/specs/otel/logs/data-model/)、[S2](https://opentelemetry.io/docs/specs/otel/trace/api/)。
3. **待核实｜规范漂移**：session 语义约定仍为 Development；实现时应重抓 [S5](https://opentelemetry.io/docs/specs/semconv/general/session/)，不要永久硬编码本轮版本号。
4. **规则建议（待实现）**：K-31 仍须沿用 packlist 发布面、P1–P5 既有分类、敏感原值不回显和未处置 review 判红；本文只补 correlation identifiers，不取代《发布脱敏与日志清理-外部资料》中的 OWASP/npm 判据。
5. **本轮未落地**：永久审计器、合成 fixture、门禁接线、索引登记和生产脱敏均未在本任务实施；没有写产品代码、没有重启、没有写 live home、没有 push。
