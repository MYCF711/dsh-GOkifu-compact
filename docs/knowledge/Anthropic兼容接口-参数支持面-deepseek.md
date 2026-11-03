# Anthropic 兼容接口：哪些参数**被忽略** · **已核实**

> 来源：<https://api-docs.deepseek.com/guides/anthropic_api>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实

| 项 | 状态 |
|---|---|
| base_url | `https://api.deepseek.com/anthropic` |
| 鉴权 | `x-api-key: <KEY>` 或 `Authorization: Bearer <KEY>` 均可 |
| **`cache_control`** | **Ignored**（前缀缓存自动生效，不需要也不接受断点标记） |
| `anthropic-beta` | 对 `/messages` **Ignored**（仅 Files API 需要 `files-api-2025-04-14`） |
| `anthropic-version` | **Ignored** |
| `tool_choice` | `none` 全支持；`auto` 支持（`disable_parallel_tool_use` 被忽略）；`any` 被当成 `auto`（**不强制**）；`tool` 选中指定工具 |
| 自定义 client tool 的 `type:"custom"` | 返回 **422** |
| `max_tokens` | 支持；**默认与实际上限取决于模型、思考模式与 effort** |

## 2. 对我们意味着什么（**已核实**：对照实现）

1. **缓存断点这条路彻底不用想了。** 我们的前缀缓存命中率 97.4%（C362/C376）**完全是自动前缀缓存**的结果，
   与"有没有标记断点"无关 —— 之前如果想过"加 cache_control 提高命中"，可以永久放弃。
2. `max_tokens` 的**默认值随思考模式/effort 变化** ⇒ 我们折叠摘要的 `maxTokens`（默认 8192）
   在思考模式下可能被别的上限挤压，这也解释了为什么"输出 token 里可能混着推理"（见
   [`思考模式-默认开启-deepseek.md`](./思考模式-默认开启-deepseek.md)）。
3. 走 Anthropic 格式时，`anthropic-beta`/`anthropic-version` 传了也没用 —— **不要写进代码或文档当依赖**。

## 3. 待核实

- 宿主（DSH）对 `magpie` 用的是 OpenAI 还是 Anthropic 格式？两种格式下**同一请求的 usage 口径是否一致**（C361 的 miss/hit/out 拆分）未验；
- `any` 被降级成 `auto` 对宿主"强制调用某个工具"的逻辑有没有影响 —— 插件侧不可见。

---

## base_url 复核（2026-11-03 · **已核实**）

来源：<https://api-docs.deepseek.com/zh-cn/>（HTTP 200）逐字：

| PARAM | VALUE |
|---|---|
| `base_url`（OpenAI） | `https://api.deepseek.com` |
| `base_url`（Anthropic） | `https://api.deepseek.com/anthropic` |
| `model` | `deepseek-flash` / `deepseek-v4-pro` |

> "模型名请使用 `deepseek-flash`。该模型现已升级为 **DeepSeek-V4.1-Flash-1017**，**调用方式保持不变**。
> 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` **仍可调用，但对应模型已下线**。"

**对我们的用处**：本仓任何"换 base_url / 换模型名"的排查都从这张表出发 ——
旧模型名**不会报错**（会静默由新模型承接），所以"名字能调通"**不能**证明配置是对的。
