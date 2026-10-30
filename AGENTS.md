# dsh-GOkifu-compact · 接管手册（AGENTS.md）

> **这份文件写给「下一个接手的人」**。它不说愿景，只说：这是什么、规则是什么、怎么跑、动之前该查什么、现在做到哪了。
> 读完这份 + `计划表.md` 最后 10 节，就能安全开工。
> **权威来源**：架构细节看 `docs/架构-最小交付房间.md`（681 行）· `docs/架构-房间契约.md`（614 行）· `docs/架构-迁移计划.md`（595 行）；**当前状态与逐刀记账只看 `计划表.md`**。
> **本文件不在 npm 包内**（`package.json:files` 只含 `src/lib/docs/evidence/scripts` + `CHANGELOG`/`QUICKSTART`/`LICENSE`）⇒ 改它不影响发布物。

---

## 0 · 这是什么

DSH（DeepSeek Harness）的**上下文压缩后端插件**。核心不是「把历史缩成一段摘要」，而是：

- 把历史存成**可回溯、可判重、带失败记忆的棋谱 DAG**（节点 = 状态，边 = 尝试 + 验证信号）；
- 每步为模型重建一份**极小的热上下文**（根目标 / 约束 / 成功路径 / 失败边），实测 **351 tokens / 步**（M-00 bench，来源 `计划表.md` 迁移基线节）；
- 相对官方 `dsh-compaction-basic` 的核心修复：**增量 fold**（只压上一个 checkpoint 之后，不重摘历史）⇒ 摆脱 ρ^k 几何衰减。

---

## 1 · 16 个房间（R00–R15）与**最终路径**（A2+A3 已完成）

**现状：A2 + A3 全部收口 —— 11 个房间全在 `src/rooms/`；`src/` 顶层只剩 `engine.mjs`（R09）与 `ui.mjs`（R11）两个永久文件；8 个旧门面已删除**（`verifier` · `range` · `worldstate` · `graph` · `keeper` · `extract` · `ledger` · `summary-prompt`）。**A2-R 与 A3-R 均在隔离实例（`tmp/dsh-gokifu-compact/test-home/`，独立 DSH_HOME）PASS，未碰 live home。**

| id | 房间 | 职责 | 最终路径（A3 已完成） | 命名导出（实测） | 允许依赖 |
|---|---|---|---|---:|---|
| **R00** | `kifu-model` | 棋谱数据层：建图/边/结算/查询/渲染/delta/tewari | `src/rooms/kifu-model.mjs` | 43 | 零依赖（仅 `node:crypto`） |
| **R01** | `kifu-persist` | 落盘与增量协议（load / flush / 路径 / delta 回放 / 坏尾截断） | `src/rooms/kifu-persist.mjs` | 10 | R00 · `node:fs`/`path`（经注入 port） |
| **R02** | `fold-planner` | 增量 fold 范围选择 | `src/rooms/fold-planner.mjs` | 5 | **零依赖** |
| **R03** | `keeper` | 事件 → 图（含 extract） | `src/rooms/keeper.mjs` | 11 | R00 · R04 |
| **R04** | `verify` | 验证信号分类（判据集中一处） | `src/rooms/verify.mjs` | 7 | **零依赖** |
| **R05** | `world` | 世界状态哈希 | `src/rooms/world.mjs` | 1 | R00 |
| **R06** | `ledger` | 热上下文渲染 + 悬空边分类 | `src/rooms/ledger.mjs` | 14 | R00 · R04 |
| **R07** | `facts-prompt` | 摘要硬事实与指令 | `src/rooms/facts-prompt.mjs` | 4 | R06（单向） |
| **R08** | `hot-inject` | 每步注入策略（`#bindLedger` 等） | `src/rooms/hot-inject.mjs` | 9 | R00 · R06（只吃 session port） |
| **R09** | `engine-sheath` | **唯一允许 import `@deepseek-ai/*` 的房间** | `src/engine.mjs`（**永久路径**） | 5 | R00–R08 · R15 |
| **R10** | `ops` | 体检 / 校验 / 回洗 / 归档 CLI | `scripts/`（**永久，不搬**） | — | R00 · R13 |
| **R11** | `ui-host` | 详情页 host 半（HTTP + 配置文件读写） | `src/ui.mjs`（**永久路径**） | 21 | R13·`preset-format` · R15 |
| **R12** | `ui-client` | 浏览器半（React） | `lib/client.js`（**永久路径**） | — | `react`（零本仓依赖） |
| **R13** | `install` | profile / preset 安装与链接 | `scripts/`（**永久，不搬**） | — | R15 |
| **R14** | `migrate` | 数据迁移（P6-C：悬空边归档/剪除） | **未创建**（原型 `test/archive-dangling*.mjs`） | — | R00 · R01 · R06（判据） |
| **R15** | `config-schema` | 配置的**单一来源**（A2-4 后 **4/5 收敛**；`lib/client.js` `FIELDS` 15 键待 R12） | `src/rooms/config-schema.mjs` | 9 | **零依赖** |

**11 个房间文件（`src/rooms/`，`ls` 实测）**：

```
config-schema.mjs   14,968 B     preset-format.mjs    8,364 B
facts-prompt.mjs     6,035 B     verify.mjs          17,914 B
fold-planner.mjs     6,502 B     world.mjs            3,296 B
hot-inject.mjs      12,557 B     kifu-model.mjs      47,853 B
keeper.mjs          12,335 B     ledger.mjs          55,948 B
kifu-persist.mjs    12,368 B
```

**两个永久顶层文件**：`src/engine.mjs`（R09，唯一 import `@deepseek-ai/*`）· `src/ui.mjs`（R11，`main` + `exports "."`）。
**8 个已删门面**：`verifier` / `range` / `worldstate` / `graph` / `keeper` / `extract` / `ledger` / `summary-prompt` —— **它们只能以 `src/rooms/<room>.mjs` 存在**；`test/rooms.test.mjs` 的 `SRC_TOP_LEVEL_ALLOWED = ["engine.mjs","ui.mjs"]` 与 `DELETED_FACADES` 会拦住任何复活。

**关键实现要点（写在代码里的契约，别改）**：
- `preset-format.mjs` 被 `src/ui.mjs` + `scripts/install.mjs` 双用（`install.mjs` **必须 re-export**）；**删 re-export 是「运行期红」不是「加载期红」**（`38914c7` 教训）。
- `config-schema.mjs` = `SCHEMA` 23 键 / `PRESET_KEYS` 16 / `BASE_KEYS` 11；**收敛只到 4/5**（`lib/client.js:78` `FIELDS` 15 键仍是硬编码，待 R12）。
- `kifu-persist.mjs` 吃注入的 `port`，**不吞错**（`{ok,error}` / `repaired`+`repairedReason`）。
- `hot-inject.mjs` 的 session port = `{id, seq, surface:{nodes}, eventAt, append}`，`createUserMessage` 由 R09 注入 ⇒ **R08 不 import DSH**；六条契约常量未改（`INJECT_MIN_EVENTS=40` / `INJECT_MIN_FAILURE_DELTA=5` / `LEDGER_STUB_TEXT` 逐字 / digest 组成 / replace 退回 append / never-throws）。

### 1.1 依赖 DAG

```
R04 verify        （零依赖）
R02 fold-planner  （零依赖）
R15 config-schema （零依赖，被 R09/R11/R12/R13 消费）

R00 kifu-model ──┬── R03 keeper ──（keeper.mjs:11 import classify ⇒ R03→R04 是既有边）
                 ├── R05 world
                 ├── R06 ledger ── R07 facts-prompt（单向）
                 └── R01 kifu-persist

R00+R01+…+R08 ──► R09 engine-sheath  ←── 唯一 DSH 接触点
R08 hot-inject ──►（只吃 session port，由 R09 调用）

R13 install ──┐
R10 ops    ──┼──► R11 ui-host（经 preset-format 纯函数）
             └──► R11 也读 R01 的路径规则
R12 ui-client（只 HTTP + 宿主 slots，零本仓依赖）
R14 migrate（只读 R00 + R01 路径规则，独立 CLI）
```

### 1.2 六条可静态断言的方向规则（`test/rooms.test.mjs`，GUARD-1 已落地）

| 规则 | 断言 | 现状 |
|---|---|---|
| **R-A** | `src/**` 不得 import `../scripts/` 或 `../lib/` | **A2-1 后已转绿**（原先红在 `src/ui.mjs:58`） |
| **R-B** | R00–R08 不得 import `@deepseek-ai/*` / R09 / R11 / `scripts/` | 绿 |
| **R-C** | **R09 之外**任何文件不得 import `@deepseek-ai/*` | 绿 |
| **R-D** | `lib/client.js` 不得 import 仓库内任何文件；R10/R14 不得 import R09 | 绿 |
| **R-E** | `src/engine.mjs` 不得 import `rooms/migrate.mjs`（**P6-C「禁止 engine 启动钩子」的机器判据**）；`migrate.mjs` 若存在也不得 import engine | 绿 |
| **R-F** | `src/**` · `scripts/**` · `lib/**` 中不得出现 `allowedModels` 字样（宿主全局配置，插件不读不写） | 绿 |

**另有两条结构性门禁（A3-2-fix / A3-3 新增，同为 `rooms` filter 内）**：
- **C1/R-C 精确化**：`@deepseek-ai/*` 的 **import** 只允许出现在 `src/engine.mjs`，且 R09 的宿主说明符集合必须**恰好**是契约那 4 个（`dsh-compaction` / `dsh-compaction-basic` / `dsh-llm` / `schemastery`）—— 判据按**说明符**而非裸文本，所以 preset 块与注释里仍可写官方包名（行为面冻结）。
- **最终路径 + 顶层白名单**：`ROOMS` 每项 `file === <id>.mjs` 且真实存在；`src/` 顶层只允许 `engine.mjs` / `ui.mjs`；**`DELETED_FACADES` 里的 8 个名字一旦出现在 `src/` 顶层或被任何文件 import，立即红**。

> `rooms` 门禁跑法：`node test/run.mjs rooms`（现 **15 用例**）。**这条命令是「架构有没有被破坏」的唯一判据**，任何搬动/新增房间后必跑。

---

## 2 · 硬规则（违反即作废，不是建议）

### 2.1 DSH 接缝
- **不改 DSH 安装目录**（`D:\DeepSeek Harness\resources\`）。插件只经官方 **profile 通道**安装。
- **只有 R09（`src/engine.mjs`）可以 import `@deepseek-ai/*`**。其余任何文件 import 宿主包 ⇒ R-C 破，`engine-harness` 的 4 条 stub 也不再够用。
- `cordis.patch.yml` 的 patch **打不中目标时只 warning 不报错**（dsh-app-boot）⇒ 改完必须用 `dsh --dump-config` 或启动日志核对。
- 本插件**不使用 `section`**（`complete: true` 会吞掉其它段）。

### 2.2 profile 安装
- **动 profile 前先备份**：`profiles/<name>/cordis.patch.yml`、`package.json` 各留 `.bak-before-chess-context-<ts>`。
  ⚠ **但备份的「拷贝到」动作本身就是写入** —— **DSH 运行时不要对 `cordis.patch.yml` 做 `cp`/`edit`/`sed -i`**，会触发整树热重载并可能 host `exit(1)`（见 §2.7 / §7-9）。**要么在 DSH 未运行时做，要么走设置 UI。**
- 装/改走 `node scripts/cli.mjs install --dry-run` 先看，再实装；**live profile 两个文件 sha256 前后必须一致**（只读验证安装器没被改坏）。

### 2.3 单实例
- 挂载本插件时**必须 disable `@deepseek-ai/dsh-compaction-basic`**，否则两个 `ctx.compaction` 冲突。
- `summarize()` 是**唯一官方认可的子类钩子**；`compactRegion` 的事务（锁、稳定性校验、工具对平衡）**不要重写** —— 继承，覆盖策略层。

### 2.4 发布 / 回滚
- **npm 只发稳定版** `x.y.z`（不带 `-rc` / `-beta` / `-stage`）；预发布只走 GitHub tag / Release。
- 发布顺序：**冻结写入面 → 现测六份 sha → 跑 `npm pack` 取基线 → re-gate → commit → push → tag → publish → Release**。
  **⚠ 基线起点 = 写入方签字停手之后的现测值，不是任何推定的时刻**（本仓已因这条踩雷 3 次，见 `计划表.md` §九十八 / 草稿 R15）。
- **`README.md` / `package.json` 被 npm 强制包含，即使不在 `files` 里** ⇒ **改 README = 改发布包**（1.9.2 就是 `README:3` 版本行漏改，只能靠 1.9.3 覆盖；npm 不可变，发出去的错改不回来）。
- 回滚 = `git revert <sha>`（**一刀一 commit** 才使这条成立）；数据回滚只认 `.bak-<ts>` + sidecar。

### 2.5 数据迁移（P6-C）
- **禁止 engine 启动钩子**。迁移必须是**独立房间 R14 + 显式 CLI**（`scripts/migrate-dangling.mjs`），默认 `--dry-run`，`--apply` 需**主人授权 + 停插件窗口**。
- **不得杀 DSH 做迁移**，也不得通过重启/停进程「顺便」完成迁移。运行中插件会在内存图 flush 时覆盖磁盘清理（**实测 `netCleaned=0`**）。
- 迁移允许依赖：R00 只读、R01 路径规则、`node:fs/path/crypto`；**禁止 import R09**。
- B 方案（剪除）会**不可逆丢失 268 条失败边**（964 条失败边中 27.8%）⇒ 要保留失败历史选 **C（sidecar）**。

### 2.6 不写死用户模型
- **`allowedModels` 不归插件管**：它是 `profiles/<name>/cordis.patch.yml` 的宿主全局配置 —— 插件**不读、不写、不校验、不提示**。
- **不得在代码/测试/文档里硬编码模型 id**。UI 的模型目录走宿主动态目录 `ctx.remote.session.modelCatalog()`；选择结果只回写两个**字符串**（`summarizationProvider` / `summarizationModel`）。
- 空串语义：**跟随当次路由**（不要改成「默认某个模型」）。
- **已知硬编码待清**：`lib/client.js:190` 的 `windowTokens = 1000000`（进度条比率用的窗口大小），与模型目录无关但同属「猜的数」。

### 2.7 重构纪律
- **一刀一个 commit**，commit 首行 = 切片 id。
- **不许在同一刀里同时改「结构」与「行为」**。
- **不许改热清单文本、`classify()` 判据、`graph.json`/delta 字节、preset 块格式**（改动前必须单独复核）。
- **不许把「热重载」写进任何验收前提。分两层说（见 §5）**：**L1 profile 配置**（`profiles/*/cordis.patch.yml`）确实会热重载，且**运行中改会整树热重载并可能让 host `exit(1)`**（15:00 已实测）⇒ **运行中禁改**；**L2 插件代码 / client bundle 是否热重载仍未验证**。**不能说「所有插件都热重载」，也不能说「热重载不存在」。**
- **每刀完成立刻记账**，不许攒到批次末尾。

### 2.8 通用
- **不删除非本会话创建的文件**；要清只进 `.trash/<date>/`。
- **不留密钥**：本插件不需要密钥；不把任何密钥写进代码或文档。
- 提交前必跑：`node test/run.mjs` + `node test/verify-install.mjs`。

---

## 3 · 怎么跑

```bash
# 全量单测（纯 Node，无需 DSH）
node test/run.mjs

# 单个文件（filter 是【文件名子串】匹配，不是房间名 —— 详见 §3.2 陷阱）
node test/run.mjs ui                       # 命中 ui / ui-security / ui-config / ui-perf
node test/run.mjs rooms                    # 架构方向门禁（R-A..R-D）

# 挂载校验（读 live profile，只读）
node test/verify-install.mjs

# 基准（tokens / ms）
node test/bench.mjs 2000

# 体检（DSH_HOME 只读；exit 0 全绿 / 1 有警告或错误）
node scripts/cli.mjs doctor

# 安装器（先 dry-run！）
node scripts/cli.mjs install --dry-run

# 维护门禁（发布相关：tag / CHANGELOG / 版本跳号）
node scripts/check-maintenance.mjs

# 从 asar 取官方包对照
node /d/主工作区/archive/bili/read-asar.mjs "D:\DeepSeek Harness\resources\app.asar" --list

# 打包自检（test/·tmp/·harness 命中必须 0）
npm pack --dry-run --json
```

### 3.1 一次改动的完整验收（每刀都跑这组）

```bash
node test/run.mjs                 # 0 failed；N == 迁移基线 + 本刀新增用例数
node test/run.mjs rooms           # GUARD-1 之后必跑
node test/verify-install.mjs      # 16/16
node test/bench.mjs 2000          # tokens 与基线一致（ms 有噪声，字符数应逐字一致）
npm pack --dry-run --json         # 文件数 == 基线 + 本刀增量；test/·tmp/·harness 命中 0
node scripts/cli.mjs install --dry-run   # exit 0；live profile 两文件 sha256 前后一致
```

### 3.2 ⚠ `run.mjs` 的 filter 陷阱（写验收命令前必读）

`test/run.mjs` 用**文件名子串**过滤（`run.mjs:19-20`）：
- `ui` 命中 `ui` / `ui-security` / `ui-config` / `ui-perf`，**不命中** `version-path`；
- `ledger` 命中 `ledger` / `ledger-budget` / `ledger-scale`，**不命中** `c17` / `markers` / `dangling-exclusion` / `trace-relative`。

**⇒ 写验收命令时按【文件名】写，不要按房间名写**；房间 → 过滤器的现行对照见 `docs/架构-房间契约.md` 附录 A。

### 3.3 每房间测试入口（按房间名查文件）

| 房间 | `node test/run.mjs <filter>` | 备注 |
|---|---|---|
| R00 | `core` · `graph-invariants` · `graph-exemptions` · `render-index-perf` · `tewari-perf` | 夹具：`test/graph-fixtures.mjs`（`addUserNode` 返回**节点**、`addUserNodeId` 返回 **id** —— 用错会建出 `u.id === undefined` 的边，本仓已犯两次） |
| R01 | `persist-incremental` | 经 engine 间接覆盖；待补假 port 直测 |
| R02 | `range` | — |
| R03 | `keeper` · `weak-success` · `robustness` | `state` 实际 **20 个字段**（不是 13） |
| R04 | `verifier` · `weak-shell` | 判据集中在 `src/rooms/verify.mjs:102-148`；**不要顺手「修」只读表里混着的写状态工具**（会改热清单内容） |
| R05 | `selfloop` | 含「单字符路径」回归 |
| R06 | `ledger` · `markers` · `c17` · `dangling-exclusion` · `ledger-scale` · `ledger-budget` · `trace-relative` | 20+ 测试直接打它 |
| R07 | `ledger`（弱） | 待补 `facts-prompt` |
| R08 | `engine-harness`（端到端）· `hot-inject`（**8/0**，A2-3 已补假 port 直测） | — |
| R09 | `engine-harness` · `persist-incremental` | 待补 stub 命中断言（GUARD-2） |
| R10 | `verify-install` 命令 + `install-link` E2 | 待补 `doctor` 直测（GUARD-3） |
| R11 | `ui` · `ui-security` · `ui-config` · `ui-perf` · `version-path` | — |
| R12 | `ui`（源码文本断言，弱） | 待补 Node 装载用例 |
| R13 | `install-link` · `ws-install` · `ui` | — |
| R14 | 原型 7 用例（`archive-dangling`） | 晋升后补 `migrate` |
| R15 | `ui-config` · `config-schema`（**11/0**） | ✅ A2-4 已补表驱动全键 |

---

## 4 · 动之前的检查清单

### 4.1 新增一个房间
1. 先在 `docs/架构-房间契约.md` §2.1/§2.3 写契约（职责 / 入口 export / 输入→输出 / 错误语义 / 配置键 / 夹具 / **允许依赖** / **禁止依赖**）。
2. 路径：`src/rooms/<room-id>.mjs`，**一房间一文件**（不建 `index.mjs`）。
3. 在 `test/rooms.test.mjs` 的 `ROOMS` 表登记，并**至少加一条方向断言**（它只能依赖谁）。
4. 加测试文件 + 一条**墓碑测试**（删掉这个房间的某个能力必须变红）。
5. 更新 `test/run.mjs` 房间→过滤器对照（`docs/架构-房间契约.md` 附录 A）。
6. `npm pack --dry-run --json`：文件数应 **+1**（`files:["src"]` 会带上）。
7. `node test/run.mjs rooms` 必须仍全绿。

### 4.2 改房间契约
1. **先改契约文档，再改代码**（契约先行，否则「谁改了形状」无从追溯）。
2. 若改的是**导出面**（删/改名）：`grep -rn "<name>" src/ lib/ scripts/ test/` 必须 0 命中（注释除外）才许删。
3. 若改的是**错误语义**：必须在验收里单列，并由 reviewer 批准。
4. 若改的是 **`state` 形状 / 热清单文本 / `classify` 判据 / `graph.json`·delta 字节 / preset 块格式** ⇒ **停**，这四类属于「不许在同刀里改」的行为面。

### 4.3 搬文件（A3）—— ✅ **A3 已全部完成；本节保留为「下次搬迁」的方法与判据**
1. **永久路径不能动**：`src/engine.mjs` · `src/ui.mjs` · `lib/client.js` · `scripts/{install,link-path,doctor,cli}.mjs`（动 = 破 `package.json` 的 `exports` / `bin` / preset 里的 `name`）。
2. 顺序 = **叶子 → 核心**；每步**一个 commit**，旧文件**留一行门面**（re-export），使所有 import 不用改。
3. 每步之后：全量 0 failed + `rooms` 绿 + `npm pack` **+1 文件**。
4. 搬完一轮再观察，才做「删门面 + 一次性改 import」（**pack 会 −7**）。
5. **`scripts/` 不搬进 `src/rooms/`**。

### 4.4 改数据格式（`graph.json` / delta / 预算文件）
**当前契约（1.9.3 起，破坏性变更已写入 README）**：
- `graph.json` = **上一回合基线的完整快照**；`graph.json.delta.jsonl` = **本回合增量帧**，一帧一行 `<baseHash16>\t<checksum31>\t<json>`；
- **回合内落后一回合**（只在 `agent/status idle` 落完整快照）；直接 `JSON.parse(graph.json)` 当最新会少一回合；
- 正确读法：`fromJSON(text)` → `decodeDeltaFrames(deltaText, baseHash)` → 逐帧 `applyDelta(g, frame)`。

改动前必查：
1. **加版本号并实现拒绝**（`fromJSON` 抛 `graph: unsupported version`；`applyDelta` 抛 `graph: unsupported delta version`）——不许静默降级。
2. **写序**：先 rename 基线、再清 delta；旧帧靠 `baseHash` 整体忽略（**安全性不依赖写入顺序**）。
3. **崩溃面**：半写帧截断 / 校验和错 / 基线不匹配 / 断电旧图可加载 / 幂等（重放两次结果相同）。
4. **不许把 `test/`、`tmp/`、`*.harness-stubs`、`.engine-under-test*` 打进包**（`files` 已排除，改动别绕过去）。
5. 改完跑 `persist-incremental` + `dangling-exclusion` + 全量，并**逐字节比对**至少 3 张真实图。

---

## 5 · 当前状态（2026-10-30 17:06 快照 · **A3 全部收口 + 1.11.0 已发布**）

> **本节是「某 commit 的快照」，不是实时状态。**实时状态看 `计划表.md` 对应的刀节（`### A2-5` / `### A2-2` …）。
> **实测命令**：`git rev-parse --short HEAD` · `node test/run.mjs` · `npm pack --dry-run --json` · `ls src/rooms/`。

| 项 | 状态 | 来源 |
|---|---|---|
| **代码 HEAD** | **`e9c812a`**（1.11.0: 最小交付房间架构收口 — A2+A3 全完成） | 本节 `git rev-parse` 实测（本文档提交会在其之上） |
| **工作树** | **干净**（`git status --short` = 0 行） | 同上 |
| **迁移门禁（M-00）** | **`385/0 @ f464d2c`**，`verify-install 16/16`，**pack 64 文件** | `计划表.md` 迁移基线节（逐字粘贴的命令输出） |
| **A2-1（已做完）** | **`390/0`**（33 个测试文件，+5 来自 `rooms` 门禁）；pack **65**（+1） | `计划表.md` A2-1 节 |
| **A2-4（已做完）** | **`401/0`**（34 个测试文件，+11 `config-schema.test.mjs`）；pack **66**；`config-schema` 11/0 · `rooms` 5/0 · `ui-config` **13/0** | `计划表.md` A2-4 节 |
| **A2-5（已做完）** | **`401/0`**（用例数与 A2-4 同数 —— 纯删除）；pack **66**（不变）/ **532,971 B** / `8e24452e…`（比 A2-4 少 664 B，纯删除的预期）；`engine-harness` 25/0 · `ledger` 24/0 · `rooms` 5/0 · `verify-install` 16/16 | `计划表.md` A2-5 节 |
| **A2-2（已做完）** | **`412/0`**（35 个测试文件，+11 `kifu-persist.test.mjs`）；pack **67** / 535,070 B / `f9019efb…`；`kifu-persist` 11/0 · `persist-incremental` 8/0 | `计划表.md` A2-2 节 |
| **A2-3（已做完）** | **`424/0`**（**36 个测试文件**，+8 `hot-inject.test.mjs`）；pack **68**（M-00 **+4**）/ **537,343 B** / `0825ab1a…`；`rooms` **9/0** · `hot-inject` **8/0** · `engine-harness` 25/0 · `verify-install` 16/16 | `计划表.md` A2-3 节 |
| **A2-R（已 PASS）** | **隔离实例 PASS**（`tmp/dsh-gokifu-compact/test-home/`，独立 DSH_HOME，headless）：`compaction start→summary→end` 一次完整、**foldCount=1**、摘要含完整棋谱结构；桌面 `cordis.patch.yml` sha `047a342e…` / mtime / size **三项全同**、19387 同 PID 仍在 ⇒ **live 未受影响**（task-97） | `ws-a2r-verify/REPORT.md` |
| **A3-R（已 PASS）** | **干净树隔离实例 PASS**（HEAD `0b61fb9`、跑前跑后 `git status` 均 0 项）：EXIT=0、**foldCount=1**、摘要 7 段齐全、桌面与仓库零变化（task-107） | `ws-a3r-verify/REPORT.md` |
| **A3 物理搬迁** | ✅ **全部完成**：A3-1a…g 七步搬迁 + **A3-2 删 8 个门面** + A3-2-fix 补门禁 + **A3-3 门禁收口**。`src/rooms/` **11 个文件**；`src/` 顶层 **只剩 `engine.mjs` / `ui.mjs`** | `ls src/rooms/` 实测 |
| **P6-C（R14）** | **原型已提交，未接入 CLI、未在真实数据执行**（`test/archive-dangling.mjs` 474 行 + `.test.mjs` 221 行 / 7 用例，commit `f464d2c`） | `计划表.md` M-00a |
| **`allowedModels`** | **已移除 `gokifu` 条目**；现值只剩 `magpie / group/deepseek-v4.1-flash1017`（1 条，`cordis.patch.yml:583`） | 本节 `grep` 实测 |
| **UI（M1/M2）** | **暂停**（主人指示：优先性能与功能，没人用的插件不需要 UI）⇒ `PROD-M2` 不排期 | `plan` task-5 / 迁移计划 §5.2 |
| **热重载 L1 · profile 配置** | **确实会热重载，且运行中改可能让 host `exit(1)`**（15:00 已实测 · `session-893bfb9d`）⇒ **运行中禁改 `profiles/*/cordis.patch.yml`** | `$DSH_HOME/AGENTS.md` 零·五 |
| **热重载 L2 · 插件代码 / client bundle** | **未验证** —— **不得作为任何验收前提** | `docs/架构-迁移计划.md` §5.3 |
| **运行期收益** | **未验证**（全部性能数字是离线夹具；真机 19387 未观测） | 贯穿 `计划表.md` 各节的「未验证」栏 |
| **已发布版本** | **`1.11.0` —— npm 与 GitHub Release 都已到位**：npm `latest` = **1.11.0**、**`dist.shasum 3de92f1155a0b651e488923f5a6a19005f1b0205`**、**67 文件 / unpacked 1,373,541 B**；commit **`e9c812a`**、tag **`v1.11.0`**（⚠ **轻量 tag**，不是 annotated）、GitHub Release `v1.11.0`（`draft:false` / `prerelease:false`）。门禁 430/0 · `verify-install` 16/16。**包内 `package.json` / `README:3` = 1.11.0，与 npm 一致** | `计划表.md` 1.11.0 节 + `ws-release-1.11.0/REPORT.md`（107 行） |

**引用纪律（本仓踩过 4 次）**：
- **`378/0` 是 1.9.3 发布树的数字，不是工作树** ⇒ 工作树门禁是 **M-00 `385/0` → A2-1 `390/0` → A2-4 `401/0` → A2-5 `401/0`（纯删除，同数）→ A2-2 `412/0` → A2-2-fix `416/0` → A2-3 `424/0` → A3-1a `424/0`（纯移动，同数；pack 68→69）→ **A3 收口 `430/0`（36 文件；`rooms` 9→15；pack **67**，删门面后净减 2）****（每刀递增，引用须写清是哪一刀）。**别拿发布树的数当门禁。**
- 每个数字都带**时点 + 树**（发布树 / 工作树 / 某 commit）。**跨批不可比**。
- 计数/比例必须自带 **定义式 + 分子 + 分母 + 时点**，缺一维视为不可引用。

---

## 6 · 维护任务索引与报告路径

### 6.1 角色
`lead`（拍板 / 停手签字 / 见证）· `master`（授权）· `implementer-gokifu`（写）· `reviewer-gokifu`（**只读复核 + 独立复跑**，不是自评）· `scribe-gokifu`（文档与 `计划表.md` 记账）· `release-gokifu`（发布）· `verifier-gokifu`（发布前/后独立门禁）。

### 6.2 切片索引（详见 `docs/架构-迁移计划.md` §6）

```
M-00a → M-00b → M-00c → M-00d → {GUARD-1, GUARD-2, GUARD-3}
GUARD-1 → A2-1 ✅ → A2-4 ✅ → A2-5 ✅ → A2-2 ✅ → A2-3 ✅ → **A2-R ✅（隔离实例 PASS）**
A3-1a ✅ → b ✅ → c ✅ → d ✅ → e ✅ → f ✅ → g ✅ → A3-2（删 8 门面）✅ → A3-2-fix ✅ → A3-3 ✅ → **A3-R ✅（隔离实例 PASS）**
P6C-0 → P6C-1 → P6C-2 → P6C-3        （与 A2/A3 并行；P6C-3 必须停窗口）
PROBE-1 → PROD-M2                     （等主人恢复 M2，当前暂停）
```

**必须由 reviewer 独立复核的刀**：M-00b/c · A2-1 · A2-2 · A2-3 · A2-4 · A3-1d · A3-1f · A3-2 · A3-3 · A3-R · P6C-1/2/3。

### 6.3 报告与记账路径

| 内容 | 路径 |
|---|---|
| **当前状态 / 逐刀记账 / 基线 / 决策 / 否决** | **`计划表.md`**（唯一权威，按节号引用） |
| 架构定稿 | `docs/架构-最小交付房间.md` · `docs/架构-房间契约.md` · `docs/架构-迁移计划.md` |
| 方案与纪律（当前决定） | `docs/方案-持续优化.md` |
| 试错草稿 / 被否掉的设想（**保留不删**） | `docs/草稿-持续优化.md` |
| 各工作流报告 | `tmp/dsh-gokifu-compact/ws-*/REPORT.md`（每个工作流一个目录） |
| 实测证据（token 数字、日志片段、前后对照） | `evidence/` |
| 冻结期缓冲（发布前只写这里） | `tmp/dsh-gokifu-compact/scribe-buffer/` |
| 临时产物（**不进 git、不进包**） | `tmp/<project>/` |

### 6.4 目录约定

```
src/       引擎与规则（纯函数优先，便于单测）；src/rooms/<id>.mjs = 房间
lib/       浏览器半（React，仅 client.js）
scripts/   CLI：install / link-path / doctor / cli / check-maintenance / release
test/      单测 + 挂载校验，全部可脱离 DSH 跑（36 个 *.test.mjs）
docs/      架构定稿 / 方案 / 草稿 / 测绘报告
evidence/  实测证据
AGENTS.md  本文件（不进包）
```

---

## 7 · 已知陷阱 TOP 10（都是真踩过的）

1. **`README.md` 改了 = 包改了**（npm 强制包含，即使不在 `files`）⇒ 1.9.2 因 `README:3` 漏改版本号被迫发 1.9.3；**已加门禁 A0（`README` 版本行 == `package.json` version）**。
2. **`.gitignore` 管不了 npm** ⇒ `src/.engine-under-test-p3.mjs` 差点进包（57,914 B），靠 `files` 补 `"!src/.engine-under-test-*.mjs"` 才 62→61。
3. **文件大小不能判断内容变没变** ⇒ 版本号 bump 必产生「同尺寸内容变更」（`README` 1.9.1→1.9.3、`package.json` 1.9.2→1.9.3 都是）。**冻结面校验只看 sha256。**
4. **`addUserNode` 返回节点、`addUserNodeId` 返回 id** ⇒ 用错会建出 `u.id === undefined` 的边（本仓已犯 2 次）。
5. **`graph.json` 落后一回合**（增量落盘）⇒ 外部工具直接 `JSON.parse` 当最新会少一回合。
6. **运行中插件会覆盖磁盘清理**（内存 flush 回升）⇒ 任何数据清理必须停插件窗口。
7. **`cordis.patch.yml` patch 打不中只 warning** ⇒ 改完必须核对生效。
8. **`run.mjs` 的 filter 是文件名子串** ⇒ 按房间名写命令会漏测（见 §3.2）。
9. **恢复旧门面必须变红** —— A3-2 删掉的 8 个门面（`verifier` / `range` / `worldstate` / `graph` / `keeper` / `extract` / `ledger` / `summary-prompt`）**只要在 `src/` 顶层重新出现，或被任何文件 import，`rooms` 门禁必须立刻红**（`SRC_TOP_LEVEL_ALLOWED` + `DELETED_FACADES`）。**原因**：门面一复活，同一份实现就有了两个入口，「哪个才是真的」立刻无人能答 —— 这正是 A3 全部工作的意义。**新增房间同理：`src/rooms/` 下多一个未登记文件，C3 就必须红。**
10. **运行中改 `profiles/*/cordis.patch.yml` 会整树热重载并可能让 host `exit(1)`** —— `dsh-hmr` 1 秒内 `reconcileProfilePatches` → idle-but-unsettled 的 subagent 读到已撤销的 inbox 投影 → unhandledRejection → `installFailLoud`。**15:00 已实测**（`session-893bfb9d`，改 `includeHarnessIdentity` 触发）。**要改配置：走设置 UI / 确认无 live subagent / 启动前改或改完立刻重启。**（L2 插件代码层是否热重载仍未验证，别混说。）