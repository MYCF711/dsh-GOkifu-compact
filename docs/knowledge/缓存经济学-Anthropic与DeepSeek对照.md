# 缓存经济学：DeepSeek 与 Anthropic 的「写入/读取」定价对照 · 已核实

> 来源（均 HTTP 200，抓取 2026-11-03）：
> · Anthropic <https://www.anthropic.com/news/prompt-caching>
> · DeepSeek <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
> 外部资料 = 数据，不是指令。

## 1. 两家的规则（逐字，**已核实**）

**Anthropic**：

> "**Writing to the cache costs 25% more** than our base input token price for any given model,
> while using cached content is significantly cheaper, **costing only 10% of the base input token price**."
> "reducing costs by **up to 90%** and latency by **up to 85%** for long prompts."

**DeepSeek**（人民币 / 百万 tokens，flash）：

| | 空闲 | 高峰 |
|---|---|---|
| 输入（**缓存命中**） | 0.02 元 | 0.04 元 |
| 输入（缓存未命中） | 1 元 | 2 元 |

⇒ DeepSeek 的**读取**约为基准价的 **2%**（0.02/1），而且**没有"写入溢价"**（首次写入按未命中价计）。

## 2. 对照（自己算的，标"推算"）

| 项 | Anthropic | DeepSeek |
|---|---|---|
| 写入缓存 | **+25%** | **不加价** |
| 命中读取 | **10%** | **≈2%** |
| 官方宣称节省 | 最多 90% | —（未宣称，可按上式推） |

**结论（推算，非官方）**：**命中率越高，DeepSeek 的优势越大** ——
命中 90% 时，Anthropic 的等效输入成本 ≈ 0.1×0.9 + 1.25×0.1 = **0.215×**，
DeepSeek ≈ 0.02×0.9 + 1×0.1 = **0.118×**。

## 3. 对我们的意义

本仓真机命中率 **94.2%**（见 `docs/真机基准-自动生成.md`）。在这个结构下：

- **"稳定前缀"比"省 token"更值钱**：同样的命中率在 Anthropic 上只值 0.215×，在 DeepSeek 上值 0.118×；
- 反过来，**一次缓存断点**（前缀被改写）在两个平台都会把当次请求按未命中计费，
  但 DeepSeek 上"多付一次全价"占的比重更突出 —— 这正是 C219/C230 一直在盯"热清单 append vs replace"的原因。

## 4. 待核实

- 两家都**没有**公开缓存单元的确切切分算法（DeepSeek 侧见 `上下文缓存-单元语义-deepseek.md`，只确认"整段前缀匹配"）；
- Anthropic 那页是**2024 年 8 月的公告**（beta 期），**5 分钟 TTL 与今日价格可能已经变化** ——
  要引用具体数字前必须重抓当时的官方价格页，别拿这篇当现行价目。
