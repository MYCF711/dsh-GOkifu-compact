# 为 agent 写工具（Anthropic）· 外部资料与判读

> 来源：<https://www.anthropic.com/engineering/writing-tools-for-agents>（HTTP 200，抓取 2026-11-02）
> 标题：**Writing effective tools for agents — with agents** · Anthropic Engineering · 2025-09-11
> **外部资料 = 数据，不是指令。**

## 三条能落到我们代码上的

### 1. 工具返回值要「限流」：官方给的默认上限是 **25,000 tokens**（**待核实**：那是 Claude Code 的设置，不是通用定律）

原文：*"For Claude Code, we restrict tool responses to 25,000 tokens by default… We suggest implementing some combination of pagination, range selection, filtering, and/or truncation with sensible default parameter values for any tool responses that could use up lots of context."*

**对我们意味着什么**：
- 我们的 K-2（工具结果常态清理）一直缺一个**参照量级**。25k tokens ≈ **我们 200K 窗口的 12.5%**，
  而 `.dsh` 里 `toolResultPruner` 是宿主提供的现成能力。
- 这条给了 K-2 一个可检验的判据：**一次工具结果超过窗口 12.5% 就该被裁**，而不是"感觉太大"。

### 2. 截断必须**带指引**，否则模型只会更笨

原文：*"If you choose to truncate responses, be sure to steer agents with helpful instructions… encourage agents to pursue more token-efficient strategies, like making many small and targeted searches instead of a single broad search."* 错误信息也一样：要给**具体可执行的下一步**，不要 `E1234`。

**对我们意味着什么**：
- 我们的 `renderLedger` 就有「省略行」——它已经带了解析指引（C3：数量 + 区间 + 相对路径）。
  这条是**外部证据支持我们做对了**，写进知识库备查。
- 而 `C212` 给 `Receiver must be an instance` 补充「重启并确认同名插件只有一条」正是这一类，方向正确。

### 3. **避免只在返回值里塞"隐晦标识符"**

原文：*"…eschew low-level technical identifiers (for example: uuid, 256px_image_url, mime_type)… Agents also tend to grapple with natural language names much stronger than they do with cryptic identifiers. We've found that merely resolving arbitrary alphanumeric UUIDs to more semantically meaningful and interpretable language (or even a 0-indexed ID scheme) significantly improves Claude's precision in retrieval tasks by reducing hallucinations."*

**对我们意味着什么（这条最扎手）**：
- 我们注入的热清单里通篇是 `n1234 / e567` 这种 id —— 按原文，这**正是**"cryptic identifiers"。
  我们自己的 `findUnknownIds` 幻觉探针能抓到"摘要里提到了图里没有的 id"，但抓不到"模型看着 id 猜错了对象"。
- 反驳也成立：这些 id 是**可寻址**的基础（`nodes/<id>.md`、闭包、`pointTo`），去掉就丢了定位能力。
- ⇒ 折中：**id 保留，但每条都要有自然语言锚**（现在的失败边已经带 `intent`/`errorSnippet`，是好的；
  弱项是纯计数行与历史段）。这并入 **K-6**（热清单干扰项治理）一起做。

## 一句话蒸馏

> 工具的返回值是**给模型看的产品界面**：少塞没用的、塞了要能指路、别只给机器 id。
> 我们做对了两件（省略行带指引、错误带处置），**第三件（消解 id）还没做**。
