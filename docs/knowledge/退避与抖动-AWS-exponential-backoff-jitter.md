# 退避与抖动（AWS Architecture Blog）· 部分已核实 · **我们这一版决定不用**

> 来源：<https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>（HTTP 200，抓取 2026-11-03）
> 外部资料 = 数据，不是指令。

## 1. 已核实（原文可查的句子）

| 结论 | 原文 |
|---|---|
| 抖动分几种策略 | 文中出现 **"Full Jitter"**、**"Equal Jitter"**（"we always keep some of the backoff and jitter by a smaller amount"）、**"Decorrelated Jitter"**（"similar to 'Full Jitter', but we also increase the maximum jitter based on the last random value"） |
| Equal Jitter 是输家 | "'Equal Jitter' is **the loser**. It does slightly **more work** than 'Full Jitter', and takes **much longer**." |
| 抖动整体能显著减少工作量 | "Both **cut down work substantially** relative to both the **no-jitter** approaches." |

## 2. 待核实

- **具体公式没抓到**：该页的代码块是前端渲染的，本次抓取只拿到文字段落。
  常见写法（`sleep = random_between(0, min(cap, base * 2 ** attempt))`）来自同名文章的转述，
  **不能当成官方原文引用**；
- 文中实验的并发规模、服务端模型都是他们的场景，数字不可移植。

## 3. 对我们的判读：**这一版不做**（诚实记"否决"，免得下轮重来）

我们当前的退避是两道**确定性**门（C350/C367）：

1. 事件口径：`min(base·2^(failures-1), cap)` 个事件之后才再试；
2. 时间口径：限流 ≥30s、过载 ≥5s 的最小等待。

加了抖动能解决的唯一问题是**多客户端同时重试造成的同步冲击**。而我们是：

- **单客户端**（一个插件进程），同一会话同一时刻只有一次折叠；
- 相邻会话的折叠由各自的事件流驱动，天然不同步；
- 真要撞击，撞的是**账号级并发**（flash 2500 / pro 500），远没到。

反过来，把"最小等待"改成随机值会**削弱**我们特意加的限流保护（这可能让 `rand()` 偶尔给出接近 0 的等待），
正是 C367 想避免的事。

**⇒ 结论：保持确定性退避。若将来出现"多实例/多会话同时折叠"的实证（doctor 里一次能看到 3+ 个并发折叠），再回来加 Full Jitter。**

---

## 4. 「并发」到底指什么（2026-11-03 官方中文页复核 · **已核实**）

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit>（HTTP 200）

逐字要点：

> "**一个请求从发出后，到模型响应完成之前记为一个并发**"
> "并发限制**以账号粒度计，与 API Key 无关**"
> "对于一个账号，在并发限度内，您的 API 请求都会得到响应；**超过并发限度时，您会收到 HTTP 429 错误码**"
> 限制：`deepseek-flash` **2500** / `deepseek-v4-pro` **500**（可提工单扩容，扩容不加价）

这两句改变了我们的判读方式：

1. **429 不是"每秒请求太多"，而是"同时在飞的请求太多"** ⇒ 退避要按**并发**控（我们本来就是串行折叠），
   按时间窗放慢只是间接手段；
2. **限制是账号级、与 API Key 无关** ⇒ 多个 DSH 实例 / 多个会话共用同一额度。

**对"要不要加抖动"的影响**：这一条**强化了否决**（见 §3）——抖动的目标是打散**同刻**的重试，
而我们的折叠是**单请求串行**、并发上限 2500 远超实际（同时最多几条），
真正的风险从来不是"撞在一起"，而是"配置指错了上游"（见 C467 那次 400）。
