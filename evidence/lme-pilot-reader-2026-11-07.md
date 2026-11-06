# K-27 真实 reader pilot smoke（10 题 × 2 臂）

> **PILOT_ONLY**：不是正式 50/50 质量门；预注册规则见文末，不换题、不回调阈值。

- 模型：`deepseek-v4.1-flash-1017`
- 调用：20 次（10 题 × full/compact）
- 机械判分：full **8/10** · compact **7/10** · Δ **-1**
- 用量：input 2795 / output 2479 tokens；总延迟 44042 ms

| 题 | 类 | full | compact | full 答案 | compact 答案 |
|---|---|---|---|---|---|
| IE-01 | IE | ✓ | ✓ | `n-ie01-root` | `n-ie01-root` |
| IE-02 | IE | ✓ | ✓ | `e-ie02-parse` | `e-ie02-parse` |
| MR-01 | MR | ✓ | ✓ | `e-mr01-a, e-mr01-b` | `e-mr01-a,e-mr01-b` |
| MR-02 | MR | ✓ | ✓ | `e-mr02-a,e-mr02-c` | `e-mr02-a,e-mr02-c` |
| KU-01 | KU | ✓ | ✓ | `later-ok` | `later-ok` |
| KU-02 | KU | ✓ | ✗ | `retain-20` | `20` |
| TR-01 | TR | ✗ | ✗ | `之前` | `UNKNOWN` |
| TR-02 | TR | ✗ | ✗ | `之后` | `之后` |
| ABS-01 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |
| ABS-02 | ABS | ✓ | ✓ | `UNKNOWN` | `UNKNOWN` |

## 预注册

- first 2 per type in frozen fixture order；五类各 2 题，共 10 题；每题两臂各一次。
- reader 只看 `{id,arm,question,context}` 四字段；金标准、证据、grader、applicability 不进入请求。
- 判分是冻结夹具的机械判分；本 pilot 不据此改默认剪枝、不宣称正式质量门通过。

## 判读（不做事后换题）

- **full 8/10、compact 7/10，Δ=-1**：20 次调用全部有正文，无 HTTP/reader 错误；ABS 两臂均 2/2，IE/MR 两臂均 2/2。
- **TR-01/TR-02**：模型答中文「之前/之后」，与金标准 `before/after` 语义对应，但 `exact` 判分只认英文 ⇒ 记为**判分口径命中**，不能据此说任务能力失败；冻结夹具不许事后改。
- **KU-02 compact 把 `retain-20` 答成 `20`**：这是真实的压缩后信息退化候选，正式 50 题前要定位是上下文缺失还是模型抽取偏差。
- 正式 50/50 质量门仍是 **NOT_RUN**；本 pilot 不改默认剪枝，也不回调任何阈值。
