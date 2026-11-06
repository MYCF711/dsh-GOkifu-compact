# K-27 真实 reader pilot smoke（10 题 × 2 臂）

> **PILOT_ONLY**：不是正式 50/50 质量门；预注册规则见文末，不换题、不回调阈值。

- 模型：`deepseek-v4.1-flash-1017`
- 调用：**40 次 API 调用**（10 题 × full/compact × 两步：extract → answer）
- 机械判分：full **6/10** · compact **7/10** · Δ **1**
- 用量：input 5916 / output 9164 tokens；总延迟 77550 ms

| 题 | 类 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|---|
| IE-01 | IE | ✓ | ✓ | `n-ie01-root` | `n-ie01-root` |
| IE-02 | IE | ✓ | ✗ | `e-ie02-parse` | `UNKNOWN` |
| MR-01 | MR | ✓ | ✓ | `e-mr01-a,e-mr01-b` | `e-mr01-a,e-mr01-b` |
| MR-02 | MR | ✗ | ✓ | `UNKNOWN` | `e-mr02-a,e-mr02-c` |
| KU-01 | KU | ✗ | ✗ | `UNKNOWN` | `UNKNOWN` |
| KU-02 | KU | ✗ | ✗ | `20` | `20` |
| TR-01 | TR | ✗ | ✓ | `UNKNOWN` | `before` |
| TR-02 | TR | ✓ | ✓ | `之后` | `after` |
| ABS-01 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |
| ABS-02 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |

## 预注册

- first 2 per type in frozen fixture order；五类各 2 题，共 10 题；每题两臂各一次。
- reader 只看 `{id,arm,question,context}` 四字段；金标准、证据、grader、applicability 不进入请求。
- 判分是冻结夹具的机械判分；本 pilot 不据此改默认剪枝、不宣称正式质量门通过。
