# 共创说明

## 定位

给 **DSH 会话**装一个**上下文压缩后端**：把「历史 → 一段摘要」换成「历史 → 可复盘的棋谱 DAG + 每步一份极小的热清单」。

不做的事（越界会被 `boundary-audit` 拦）：**不给模型下行动指导**（那是 `AGENTS.md` / persona 的活）、
**不碰工具治理**（`permission` / approval / sandbox 归宿主）、**不做长期记忆**（棋谱记的是过程，不是结论）。

## 三条纪律

1. **证据纪律**：没真跑过的写「未验证」。**没有数字的不进结论表**（那只是观点）。
2. **数字纪律**：文档里的 `passed` / `C1–C<n>` / 条目数**只有一处来源**，由脚本同步，**不要手抄**。
3. **最小改动**：一次 PR 只做一件事，附带对应测试；**不许在同一刀里同时改「结构」与「行为」**。

## 提交前四道门

```bash
node test/run.mjs                          # 全量（**必须串行** —— 并发会抢 test/.harness ⇒ 假红）
node scripts/boundary-audit.mjs            # 越界线索必须 0 条
node scripts/docs-index-check.mjs          # 新增 docs/ 或 evidence/ 下的 .md 必须登记进索引
node scripts/sync-doc-numbers.mjs --check  # 文档里的计数必须等于权威源
```

1. 全绿；新增行为有测试覆盖（纯逻辑放 `src/rooms/`，便于在纯 Node 里测）；
2. `CHANGELOG.md` 已加 `### C<n> · 标题` 条目（**编号连续**，解析器只认这个形状）；
3. 没有凭证、本机绝对路径、会话 id、个人信息的泄漏（`node scripts/privacy-audit.mjs --changed`）；
4. `node scripts/sync-doc-numbers.mjs --write` 已跑过。

## ⚠ 加了测试之后必须跑同步脚本

**这是本仓贡献者最容易撞的坑。** 你加一条测试 ⇒ 全量通过数从 2158 变成 2159 ⇒
下面三条守卫**立刻变红**：

| 守卫 | 它查什么 |
|---|---|
| **C167** | 文档里的 `passed` 数必须等于 `test/counts-baseline.json` |
| **C172** | CHANGELOG 的条目数 / 编号数 / 最大编号必须与 9 份文档里手写的一致 |
| **C485** | 「全量通过数」只有一个来源（`gate.mjs` 跑完回写），文档是它的副本 |

**正确做法**（不是去手改文档）：

```bash
node test/run.mjs                        # 1) 先跑，确认真的绿
npm run gate                             # 2) 8 判分门 + 擦亮基线（会回写 counts-baseline.json）
node scripts/sync-doc-numbers.mjs --write # 3) 一次改完 9 份文档 / 20 处锚点
node scripts/sync-doc-numbers.mjs --check # 4) 应当 exit 0
```

> **手改文档的结果只有两种**：被下一次 `--write` 覆盖，或者被 `--check` 点名到「文件:行号」。
> 这不是纪律问题，是拓扑问题 —— 同一个数有 20 个手抄点，任何人都必漏。
> 详见 `scripts/sync-doc-numbers.mjs` 的文件头注释。

## 提交 PR 的分支纪律

- **并行任务各自开分支 / worktree**（`git worktree add ../<task>-<id> -b task/<id>`），不要多人共用一棵工作树。
- **并行开发中禁用 `git add -A`**：它会把别人没修完的改动一起签进主线
  （真实事故：一个本应是 docs 的提交扫进了 3 个未修完的文件，引入 3 条回归）。只 `git add <具体文件>`。
- **PR 分支永不强推**：不 `--force` / `--force-with-lease`，不 rebase 或 amend 已推送的提交；要改就追加新 commit。
- **测试红的一律不进主线**，留着分支继续修。

## 改这几类东西前先停一下

下面四类属于「**不许在同一刀里改**」的行为面，改动前必须单独复核并补对应测试：

1. 热清单文本（`src/rooms/ledger.mjs` 的渲染输出被 sha 逐字节钉住）；
2. `classify()` 判据（`src/rooms/verify.mjs`，判据集中一处）；
3. `graph.json` / `graph.json.delta.jsonl` 的字节格式（改格式 = 改回滚与崩溃安全）；
4. `cordis.patch.yml` 的 preset 块格式（它是**生成物**，见 [UPDATING.md](UPDATING.md)）。

## 许可

贡献即同意以 MIT 许可发布。
