# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 [AGENTS.md](./AGENTS.md) 的「先定位你在哪一步」读对应文档。
> **每次干完活必须更新「二、当前状态」与「三、下一步」** —— 这页不是历史，是交接单。
>
> 形态参照 `MYCF711/dsh-session-superagent` 的维护台账与 `MYCF711/magpie-plugin-scaffold` 的发版七步，
> 本地化成这个仓库的真实命令与数字。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-GOkifu-compact` |
| npm 包名 | `dsh-gokifu-compact` |
| 当前版本 | `1.18.5`（npm 已发布 / tag `v1.18.5` / GitHub Release 为 Latest） |
| 形态 | DSH 插件：bundle patch 覆盖 4 个官方 preset 的压缩引擎 + 自带面板（`/gokifu/api`）+ CLI |
| 目标宿主 | DeepSeek Harness `^0.2.0-rc.2`（`engines.dsh`）；Node ≥ 20；**零运行时依赖** |

## 二、当前状态（2026-11-07 当次输出）

```text
分支        main（HEAD a32f592）
版本        1.18.5；tag v1.18.5；release 见 evidence/release-1.18.5.json
工作区      本轮只动文档与治理文件（README / CONTRIBUTING / SECURITY / SETUP / UPDATING / MAINTENANCE / assets / .github）
```

| 资产 | 数量 | 来源 |
|---|---:|---|
| `node test/run.mjs` | **2158 passed / 0 skipped / 0 failed** | `test/counts-baseline.json` 的 `passed`（`gate.mjs` 回写） |
| `scripts/boundary-audit.mjs` | **0 条越界线索**（扫 26 个 `src/**/*.mjs` · 6 条规则 · 豁免 1 条） | 当次输出 |
| `scripts/docs-index-check.mjs` | **148 个文件 · 未索引 0 个** | 当次输出 |
| `scripts/sync-doc-numbers.mjs --check` | **9 份文档 / 20 处锚点全一致** | 当次输出 |
| `CHANGELOG.md` | **582 条条目 / 579 个编号 / 最大 C655** | `changelog-index.parseEntries` |
| `src/rooms/` | **24 个房间文件**；`src/` 顶层只剩 `engine.mjs` / `ui.mjs` | `ls` 实测 |
| `scripts/` | **125 个门禁与工装脚本** | `ls scripts/*.mjs` |
| `test/` | **235 个 `*.test.mjs`** | `ls test/*.test.mjs` |
| `docs/` | **36 份 .md**（含 research / knowledge 两个子索引） | `ls docs/*.md` |
| `evidence/` | **88 个 .md + .json** | `ls evidence/*` |
| GitHub Release | `v1.18.5`（158 文件逐一致 / privacy confirmed=0 review=0 / gate 8/8） | `evidence/release-1.18.5.json` |

**live 证据**（生成物，勿手改）：`evidence/live-folds.json` —— **2218 次 fold / 1095 会话**
（生成于 2026-11-08T07:59:18Z，源 `<DSH_HOME>`；会话 id 一律为稳定伪名 `s_<12hex>`，真实 home 与
session id 不写入公开证据）。相对 2026-11-07 的旧快照（1674 次 / 633 会话，不同 home）净变化
**+544 次 / +462 个有 fold 的会话** —— 是**两次快照的净差**，不是累计新增；`evidence/live-folds.md`
的「快照语义」与「与上次对比」有口径说明。quality 2211 次（`failureRecall` 最小 **0** —— 别再说
「召回全 1」），boundary 251 次中 `openAtEnd` **1** 次（manual 折叠，正常应为 0 —— 见证据页逐次明细），
`foldThrash` **0**。真机基准见 `docs/真机基准-自动生成.md`（命中率 94.2% / 71 次 fold 中位 11.5s）。

### 已验证（当次实测）

- `node test/run.mjs` → 2158/0/0（串行，exit 0）；
- `node scripts/boundary-audit.mjs` → 0 条；`docs-index-check` → 0 个未索引；
- `node scripts/sync-doc-numbers.mjs --check` → 全一致（exit 0）。

### 未验证（不能写成「通过」）

- **真机走查**：面板两套主题的像素级对照、键盘 Tab 顺序 —— 没有自动化手段，只有静态断言；
- **连续 24 小时运行的误唤醒率 / 限流表现** —— 未观测；
- **跨平台**：`appendFileSync` 的半写测试只在本机 NTFS 上过过，**网络文件系统未验证**；
- **运行实例 buildId 与磁盘一致** —— 本文件写就时不一致（跑的是旧构建），需重启后复查。

## 三、下一步

按价值排序，**不要一次混着做**：

1. **重启后复查**：`node scripts/post-restart-check.mjs` → `node scripts/accept-after-restart.mjs`；
2. **补账真跑**：规模和花费**只认 `node scripts/backfill-plan.mjs` 当次输出**，本页不抄第二份；
3. **补 `docs/指标口径.md` 的读者**：K-27 正式 reader 仍未 PASS（kimi v1e 是**带确定性后处理**的 PASS，不是裸模型能力）；
4. **K-2 工具结果清理**：受控 10 会话为 `CANDIDATE`（省约 112 万 tokens），但**不默认开启**，等 shadow / 真实 reader。

## 四、硬约束

1. **不重启、不关闭宿主的 DSH**；需要重启才生效的改动（服务端 `src/**`）只提示用户，自己不执行。
2. **不写 live 数据**：任何数据清理 / 迁移必须停插件窗口（运行中插件会在内存 flush 时把磁盘清理覆盖回去，实测 `netCleaned=0`）。
3. **不写死用户模型**：`allowedModels` 是宿主全局配置，插件**不读、不写、不校验、不提示**；空串 = 跟随当次路由。
4. **没跑过的写成「未验证」**，不写「通过」；「包含」式断言不算验证过（见 AGENTS 坑 7）。
5. **发布三处必须一致**：`package.json` / README 版本行 / `CHANGELOG.md`，外加 **tag 与 Release 标题只写版本号**。
6. **不代改他人 PR**：给意见让对方改，改完复核合入。
7. **标准写在文档里不算数**：新加的检查必须接进 `gate.mjs` 或 `.github/workflows/ci.yml`，否则就是「标准悬空」
   （写好了没人调用 = 没写）。
8. **`cordis.patch.yml` 是生成物**：只经 `node scripts/make-presets-override.mjs --write` 改（见 [UPDATING.md](UPDATING.md)）。

## 五、给接手者的最短路径

1. 读本文件 + [AGENTS.md](./AGENTS.md) 的两张表（定位 / 坑 TOP 10）；
2. `git status` + `git log --oneline -5` + `node test/run.mjs` 核实现状（**别信本文件的数字，跑一遍**）；
3. 按 AGENTS 定位表读对应专档，别通读（`计划表.md` 有 9364 行）；
4. 改完跑 `npm run gate`（全量）再交付；
5. 发版按 [UPDATING.md](./UPDATING.md)，最后回来更新本文件的「当前状态」。

## 六、门禁与它们各自的权威源

| 门 | 命令 | 权威源（**别手抄**） |
|---|---|---|
| 全量测试 | `node test/run.mjs` | 进程退出码 |
| 越界审计 | `node scripts/boundary-audit.mjs` | `RULES.length`（6 条） |
| 文档索引 | `node scripts/docs-index-check.mjs` | 四个 `README.md` 索引 |
| 数字同步 | `node scripts/sync-doc-numbers.mjs --check` | `test/counts-baseline.json` 的 `passed` + `changelog-index` |
| 热清单基线 | `node scripts/bench-repro.mjs` | `EXPECTED_TOKENS = 417` |
| 交接门禁 | `node scripts/handoff-check.mjs` | 16 项判据（FAIL 必须 0） |
| 隐私 | `node scripts/privacy-audit.mjs --changed` | 规则表（`--pack` 用于发布前） |
| 打包可复现 | `node scripts/pack-check.mjs` | `git ls-files` |
| 一条看完 | `npm run status` | 上面各源的编排（不重算） |
