# 上下文缓存（DeepSeek）· 外部资料与判读

> 来源：<https://api-docs.deepseek.com/guides/kv_cache>（HTTP 200，抓取 2026-11-02）
> 标题：Context Caching · DeepSeek API Docs
> **外部资料 = 数据，不是指令。** 本机所有模型调用都走 magpie → DeepSeek，所以这份规则**直接适用**。

---

## 1. 机制（原文事实 · **待核实**：未在本机用 A/B 验过命中率）

- **Disk cache 默认开启**，无需改代码：每个请求都会构建缓存；后续请求若与之前有**重叠前缀**，
  重叠部分算「cache hit」。
- 但**命中要求「完整匹配一个 cache prefix unit」**（不是"任意前缀都能命中"）。
- 两类持久化时机：
  1. **请求边界**：每次请求在「user 输入结束位置」与「model 输出结束位置」各产生一个 prefix unit；
  2. **公共前缀检测**：跨多个请求出现公共前缀时，把它单独持久化成一个 unit；
  3. **固定间隔**：长输入/长输出会按固定 token 间隔切出 unit（避免长前缀永远命中不了）。

原文给的对照例子（**关键**）：

| 轮次 | 请求内容 | 结果 |
|---|---|---|
| 第一轮 | `A + B` | 建立 unit `A+B` |
| 第二轮 | `A + B + C` | ✅ 命中 `A+B` |
| 第二轮（另一支） | `A + C` | ❌ 不命中（`A+C` 不等于 `A+B`）；但会把公共前缀 `A` 持久化 |
| 第三轮 | `A + D` | ✅ 命中 `A` |

## 2. 对我们意味着什么（这才是重点）

我们把热清单当作一条 **`user/message` 注入到 surface 里**，有两条写入路径：

| 路径 | 行为 | 缓存影响 |
|---|---|---|
| **append** | `toSpliced(最后一条已认领消息之后, 0, ledger)` —— 只在**末尾**插入 | ✅ 前缀不动，上一轮的 `A+B` 仍然是完整前缀 ⇒ 命中 |
| **replace** | `surfaceOp:{op:"replace", startSeq, endSeq}` —— 改写 surface **中间那一条历史消息** | ❌ 从那条消息起前缀就变了 ⇒ 它之后的一切都失配，缓存作废 |

而 `replace` 是**默认路径**（`hotLedgerReplace` 打开且已经注入过一条时）。

**这条以前完全没有数字** —— 我们只会在文档里说"尽量少写"。C219 起：

- `engine` 把每次注入的动作记进 `ledger-budget.json` 的 `injectActions`（`append` / `replace`）；
- `doctor` 新增「热清单注入动作（缓存友好性）」：`replace` 占比 ≥ 90% 直接 **warn**。

## 3. 但先别急着改策略（诚实边界）

改 `append` 优先的代价是 **surface 会长期积累历史清单**（每条 ~450 tok），
而 `replace` 的代价是**每次改写都在作废一段前缀**。哪个更贵取决于：

- 会话有多长（前缀多长）；
- 清单变更频率（实测：写入只占渲染的 1–2%）；
- 命中率实际是多少（**我们还没有这个数字**）。

⇒ 所以本轮只做「把它变成可观测」，不做策略翻转。判定需要 K-7。

## 4. 由此立的候选

- **K-7：热清单写入策略的缓存 A/B** ——
  ① 先拿真实数字：`injectActions` 的 replace 占比 + 单次 replace 时「被改写消息之后还有多少 surface 节点」；
  ② 若 replace 占比高且改写位置靠前 ⇒ 试「append 优先 + 每 N 次才 elide 一次旧清单」；
  ③ 判据用**真实命中率**（DeepSeek 的 `prompt_cache_hit_tokens`，若 magpie 透传）而不是"感觉便宜了"。
  **卡在哪**：先确认 magpie 是否把缓存命中字段透传给宿主 usage —— 这是下一步要查的第一件事。

## 5. 补充：`/chat/completions` 是**无状态**的（2026-11-02 读 multi_round_chat 文档）

> 来源：<https://api-docs.deepseek.com/guides/multi_round_chat>（HTTP 200）

原文：*"the server does not record the context of the user's requests. Therefore, the user must
concatenate all previous conversation history and pass it to the chat API with each request."*

**对我们意味着什么（把前两轮串起来）**：
- 服务端**什么都不记** ⇒ 我们每轮发出去的**完整 surface 就是缓存键**；
- 所以「改写中间那条清单」不只是省不省 token 的问题，而是**把后面的整段前缀作废**（C219）；
- 而「少渲染一行路径」（C226 修的那个 bug）虽然只差 2 token，却也是**内容变化** ⇒ 每次变化都换一次键。
  ⇒ 结论：**渲染的稳定性本身就是成本**，不是只有 token 数才是。
