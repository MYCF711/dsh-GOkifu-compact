# P6-C 停窗执行手册（悬空边归档）

> **这份手册只在「主人明确给停窗授权」之后使用。** 没授权就只做只读部分（预检 + dry-run）。
> 工具：`src/rooms/migrate.mjs`（R14）+ CLI `scripts/migrate-dangling.mjs` + 预检 `scripts/p6c-preflight.mjs`。
> 判据来源：`classifyDangling`（`src/rooms/ledger.mjs`）。**只归档 settled residue**；`candidate`（陈旧 untested）一条不动。

---

## 0. 目的

把**已结算、无终点、超 10 分钟**的悬空边（residue）归档进 sidecar（`graph.dangling.json`），从主图里删掉，减小每回合的图体积；
同时**保留**失败历史（sidecar 可回溯）、**保留** candidate（"可以继续，也可以放弃"的 OPTIONS）、**保留** fresh-unsettled 与 from-broken。

---

## 1. 前置条件（缺一不可）

| # | 条件 | 怎么确认 |
|---|---|---|
| 1 | **主人明确授权**本次 apply（含「可以停插件窗口」） | 对话记录；没授权只做到 §3 dry-run |
| 2 | **DSH 完全退出**（含托盘图标、所有 `DeepSeek Harness.exe` 进程） | 预检 §2 必须 `✓ 可以开窗` |
| 3 | **备份盘可用空间 ≥ 30MB**（实际需求 = 会话树 ×1.2，预检会算） | 预检输出 `备份盘：… 可用 X / 需要 Y` |
| 4 | 当前 shell 是**仓库根**（`git rev-parse --show-toplevel` == cwd） | `pwd`；`git rev-parse --show-toplevel` |
| 5 | 版本/工作树状态已记录（出问题好回滚代码） | `git rev-parse --short HEAD`；`git status --short` |

> ⚠ **不要**用 `Stop-Process` 之类替主人杀进程；停窗是主人的动作。本手册只做检查与执行。

---

## 2. 第 0 步：只读预检（`scripts/p6c-preflight.mjs`）

```bash
node scripts/p6c-preflight.mjs            # 人类可读
node scripts/p6c-preflight.mjs --json > /tmp/p6c-preflight.json   # 存档对账基线
```

它检查 5 件事，**全是只读**（不写 live、不建目录、不启停 DSH）：

| 检查 | 期望 |
|---|---|
| DSH 运行态 | 端口 19387 **不可连接** + 进程列表里 `DeepSeek Harness.exe` **0 个** |
| live 会话数 | > 0（当前库约 174 个） |
| `graph.json`-only 哈希 | 打印汇总 sha256（**只对 graph.json**，不含 delta）——停窗后与 apply 前再各取一次，应完全相同 |
| live profile | `profiles/desktop/cordis.patch.yml` 的 mtime + sha256（停窗期间不该变） |
| 备份盘 | 可用空间 ≥ max(30MB, 会话树×1.2) |

**判据**：只要检测到 DSH 仍在运行（端口可连**或**进程 >0），预检就 **exit 1 并拒绝 apply 预检**：

```
✗ 不可以开窗：拒绝 apply 预检：检测到 DSH 正在运行（端口 19387 可连接；进程 14 个）—— 先完全退出桌面实例（含托盘），再重跑本预检
```

> 实测（2026-10-31 17:57，DSH 在跑时）：`EXIT=1`，会话 174 个 / graph.json 27MB / delta 文件 48 个 / 备份盘可用 34GB。

---

## 3. 第 1 步：dry-run 对账（**只读**，apply 前必做）

```bash
node scripts/migrate-dangling.mjs --json > /tmp/p6c-dryrun.json
node scripts/migrate-dangling.mjs            # 人类可读
```

**参考数字（2026-10-31 17:57 实测，174 会话）**：

| 字段 | 参考值 | 含义 |
|---|---:|---|
| `sessions` | **174** | 含 graph.json 的会话数 |
| `affectedSessions` | **48** | 有 residue 要归档的会话数 |
| `residue` / `sidecarEdges` | **6219** | 将归档的悬空边条数 |
| `candidates` | **10** | 陈旧 untested —— **不归档**（OPTIONS 段） |
| `liveUnsettled` | **0** | ≤10min 的 untested —— 不动 |
| `fromBroken` | **214** | `from` 节点不存在 —— 单独一类，不动 |
| `badGraphs` | **0** | 坏图（必须 0；非 0 就先别 apply） |
| `graphBytesBefore → After` | 28,516,279 → 25,180,847 | 主图预计减小 ≈3.2MB |

**判据（对不上就停，先查原因，不要硬 apply）**：

- `sessions` 比预检的会话数少 ⇒ 有会话在停窗期间被删/换目录；
- `badGraphs > 0` ⇒ 先修坏图（或 `--sessions=` 排除），不要带着坏图 apply；
- `residue`/`candidates`/`fromBroken` 与上表差异 >10% ⇒ 停窗期间插件可能又写过（看预检的哈希有没有变），复核后再决定；
- 任何情况下 **dry-run 不许写文件**：跑前跑后 `git status --short` 与 `sessions/` 的 mtime 都不该变。

---

## 4. 第 2 步：apply（**不带 `--force`**）

```bash
node scripts/migrate-dangling.mjs --apply 2>&1 | tee /tmp/p6c-apply.log
```

- **绝对不要带 `--force`**：`--force` 的唯一作用是跳过 120s 新鲜度守卫，只应作为「已确认插件没在跑、但 mtime 恰好新鲜」的兜底，且必须记进报告。
- 守卫同时看 **`graph.json` 与 `graph.json.delta.jsonl`**（task-144）：任一在 120s 内被写过就拒绝，错误会点名是哪个文件。
- 执行顺序（失败即中止，**不会**留下半套）：新鲜度守卫 → 整目录备份到 `migrate-backups/backup-<ts>/`（含 `MANIFEST.json` 逐文件 sha256）→ 逐会话写 sidecar + 删 residue + 重建 `index.md`。
- 预期输出：`archived 6219`、`affectedSessions 48`、`badGraphs 0`，并打印备份目录。

**失败判据**：

| 现象 | 含义 | 处理 |
|---|---|---|
| `拒绝 apply —— N 个会话的文件在 120s 内被写过` | 插件还在写（或刚停窗） | 等 ≥2 分钟再跑；**先查预检的 DSH 运行态**，别急着 `--force` |
| `migrate: 备份目录已存在` | 同一秒重复跑 | 换 `--stamp` 或等一秒 |
| 备份校验失败 / 文件数不一致 | 备份不完整 | **立即停止**，不要继续；查磁盘/权限 |

---

## 5. 第 3 步：verify（只读）

```bash
node scripts/migrate-dangling.mjs --verify --backup=<备份目录>   # 目录在 apply 输出里
```

`ok: true` 要求：sidecar 边数 = 删掉的 residue 条数、residue 归零、fromBroken 不变、candidates 数不变、抽样边逐字段相同。

**判据**：`ok !== true` ⇒ 走 §7 回滚。

---

## 6. 第 4 步：观察一轮

重启 DSH（主人操作），跑一个普通会话，确认：

1. 新回合的 `graph.json` 能正常加载（无 `graph: unsupported version` 之类）；
2. 热清单里不再出现那批 residue，但 `OPTIONS` 段（candidate）仍在；
3. `chess-context/sessions/<id>/graph.dangling.json` 存在且 `graph.json` 比 apply 前小；
4. 没有 `compaction/*` 失败事件。

观察窗口建议：**至少一个完整回合 + 一次 fold**。有问题立刻按 §7 回滚。

---

## 7. 回滚

```bash
node scripts/migrate-dangling.mjs --rollback=<备份目录>
```

- 回滚 = 从备份**逐字恢复**（含 `graph.json` / `index.md` / `nodes/`），并删除备份里没有的多余文件；`MANIFEST.json` 的 sha256 会逐个校验。
- **必须在「重启后的插件写回旧图」之前回滚**：一旦运行中的插件用内存图 flush 覆盖，磁盘上的备份仍是干净的，但内存状态会盖回去 —— 所以回滚后**再重启**一次 DSH。
- 回滚本身也写 live：只在确认 verify 失败或新回合异常时执行，并记录到报告。

---

## 8. 一页速查

```bash
# 0) 预检（DSH 必须已全退）
node scripts/p6c-preflight.mjs --json | tee /tmp/p6c-preflight.json     # 期望 exit 0

# 1) dry-run 对账（只读）
node scripts/migrate-dangling.mjs --json > /tmp/p6c-dryrun.json

# 2) apply（不带 --force）
node scripts/migrate-dangling.mjs --apply 2>&1 | tee /tmp/p6c-apply.log

# 3) verify（只读）
node scripts/migrate-dangling.mjs --verify --backup=<apply 输出里的备份目录>

# 4) 回滚（仅在失败/异常时）
node scripts/migrate-dangling.mjs --rollback=<备份目录>
```

路径：

| 东西 | 位置 |
|---|---|
| 会话图 | `<DSH_HOME>/chess-context/sessions/<sessionId>/graph.json` |
| 增量帧 | 同目录 `graph.json.delta.jsonl`（**只追加**；只在回合边界落全量） |
| sidecar | 同目录 `graph.dangling.json`（`format=dsh-gokifu-dangling-sidecar`, `version=1`） |
| 备份 | `<DSH_HOME>/chess-context/migrate-backups/backup-<ts>/`（**在 sessions 之外**，不会被自身递归） |

---

## 9. 失败判据总表

| 步骤 | 红线 | 处置 |
|---|---|---|
| 预检 | exit 1（DSH 在跑 / 空间不足 / 会话根不存在） | 停窗 / 清空间 / 查路径，**不许跳过预检** |
| dry-run | `badGraphs > 0` / 数字与参考差异 >10% / 有任何写入 | 先查，不 apply |
| apply | 报「拒绝 apply」/ 备份校验失败 | 等窗口 / 查磁盘；**不许默认加 `--force`** |
| verify | `ok !== true` | 立即回滚 + 重启 |
| 观察 | 新回合加载失败 / 热清单异常 / `compaction/*` 失败 | 回滚 + 重启 + 记录 |

---

## 10. 变更记录

| 日期 | 变更 | 执行者 |
|---|---|---|
| 2026-10-31 | 首版（task-179）：新增 `scripts/p6c-preflight.mjs`；把 delta 新鲜度守卫（task-144）写进流程；参考数字取 17:57 实测 | install-gokifu |
