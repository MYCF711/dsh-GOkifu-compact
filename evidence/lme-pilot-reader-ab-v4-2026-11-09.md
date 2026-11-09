# K-27 真实 reader pilot smoke（10 题 × 2 臂）

> **PILOT_ONLY**：不是正式 50/50 质量门；预注册规则见文末，不换题、不回调阈值。

- 模型：`deepseek-v4.1-flash-1017`
- 调用：20 次（10 题 × full/compact）
- 机械判分：full **10/10** · compact **10/10** · Δ **0**
- 用量：input 15538 / output 6752 tokens；总延迟 152137 ms

| 题 | 类 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|---|
| IE-01 | IE | ✓ | ✓ | `n-ie01-root` | `n-ie01-root` |
| IE-02 | IE | ✓ | ✓ | `e-ie02-parse` | `e-ie02-parse` |
| MR-01 | MR | ✓ | ✓ | `e-mr01-a,e-mr01-b` | `e-mr01-a,e-mr01-b` |
| MR-02 | MR | ✓ | ✓ | `e-mr02-a,e-mr02-c` | `e-mr02-a,e-mr02-c` |
| KU-01 | KU | ✓ | ✓ | `later-ok` | `later-ok` |
| KU-02 | KU | ✓ | ✓ | `retain-20` | `retain-20` |
| TR-01 | TR | ✓ | ✓ | `before` | `before` |
| TR-02 | TR | ✓ | ✓ | `after` | `after` |
| ABS-01 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |
| ABS-02 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |

## 预注册

- first 2 per type in frozen fixture order；五类各 2 题，共 10 题；每题两臂各一次。
- reader 只看 `{id,arm,question,context}` 四字段；金标准、证据、grader、applicability 不进入请求。
- 判分是冻结夹具的机械判分；本 pilot 不据此改默认剪枝、不宣称正式质量门通过。
