# 更新记录

## 1.11.12 — 2026-10-31

### S8 首折削峰：第一次 fold 提前到 30%，之后回到 45%

**问题**：`thresholdRatio`（默认 0.45）对**每一次** fold 都一样。但第一次 fold 的代价最高 ——
它要一次性压掉整段历史（没有 checkpoint 可续），而那正是用户最可能撞上长时间停顿的时刻。

**改法**

| 项 | 变化 |
|---|---|
| 新配置 **`firstFoldRatio`** | preset 里的键（`PRESET_KEYS` **16 → 17**）；范围 **0 – 0.95**，**默认 0.30** |
| 生效范围 | **只作用于本会话第一次 fold**：首折阈值 = **min(窗口 × 0.30, pressureBudget)**；之后回到 `thresholdRatio`（0.45） |
| 不受影响 | **overflow 分支照旧**（它有自己的触发条件）；若首折阈值 ≤ `retainTokens` ⇒ **回退正常阈值**（不会压到留不住尾巴） |
| preset 块格式 | `engineBlock` 增 `firstFoldRatio` 行（**21 → 22 行 / 15 → 16 键**）；`rooms` 的 preset 块 golden 已同步 |

**测试 +7（505 → 512，`engine-harness` 32/0）**：首折触发 / 第二次回到正常阈值 / 配 0 即关闭 /
边界（0.95、≤ retainTokens 回退）/ **fold 次数最多 +1** / retain 守卫 / overflow 不受影响。
变异自检：首折分支失效 / 首折比例用到每一次 / 默认改成 0 —— 三条逐条红。

**验收口径的更正（同版内，`4dd5f0b`）**：原写「fold 次数不增加」，**这条本身不成立** ——
首折提前意味着同一会话可能多一次 fold。测试名改为「**fold 次数最多 +1（首折提前一次）**」，断言未动；
`docs/方案-持续优化.md` 的 S8 节写明了为什么「不增加」不可能成立。**代码零改动。**

**连带调整**：`test/real-fold-trigger.mjs` 的 ① 改用 **50K**（首折阈值已降到 60K，旧的 60K 用例会直接触发 fold，判据随即失效）。

### 验证

- 全量：**512 passed / 0 skipped / 0 failed**（**43 个测试文件**；505 + 7）
- `engine-harness` **32/0** · `config-schema` 11/0 · `ui` 54/0 · `rooms` 15/0 · `release-hardening` 15/0
- `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变）

**未验证**

- 首折削峰是**引擎级/夹具级**证据，**没有在真机上量的收益** —— 「首折更早、单次更小」的方向性成立，
  但「用户实际感知的停顿降低了多少」没有观测数据。
- `firstFoldRatio` 只经 preset 与单测覆盖，**没有在真实会话里跑过非默认值**。

## 1.11.11 — 2026-10-31

### 修 `check-maintenance` 的一个**假红**：`git status --porcelain` 的首行空格被 `.trim()` 吃掉

**现场**：终审时 `check-maintenance` 报 **8 通过 / 1 失败**，而工作树其实只有 `evidence/bench-2000.json` 这一个
本该被豁免的噪声文件 —— 也就是说，**它把「只改了 evidence」误判成「改了代码没 bump 版本」**。

**根因（一个字符的事）**：`git status --porcelain` 的首行形如 ` M evidence/x.json` ——
**状态码 X 位是一个空格**。旧实现把整段 stdout `.trim()` 了，首行的那个空格被吃掉，再按固定列 `slice(3)`：

```
" M evidence/x.json"  → trim → "M evidence/x.json" → slice(3) → "vidence/x.json"   ← 少了 v
```

于是 `evidence/` 过滤失效 ⇒ 假红。（后续行没有行首空格问题，所以**只有第一行会歪** —— 这类 bug 极难靠肉眼发现。）

**改法**

- 新增 **`gitRaw()`**：返回**未 trim** 的 stdout，专供解析用；`git()` 保持原来的 trim 行为（其余检查不变）。
- 脏文件改用 **`git status --porcelain -z`** + 新增 **`parsePorcelainZ()`**：按 NUL 切记录，
  每条记录是 `XY <path>`，**逐条** `slice(3)` 取路径；rename/copy 记录后面紧跟一个「原路径」token
  （没有 XY 前缀），解析时跳过。
  用 `-z` 还顺带解决另一个坑：普通 porcelain 会给**含空格 / 非 ASCII** 的路径加引号并转义
  （`"a b.txt"` 之类），`-z` 给的是**原始路径**，不用反解义。

**新增 `test/check-maintenance.test.mjs`（4 条回归，全部真跑脚本）**

| 用例 | 钉住什么 |
|---|---|
| 基线 | 干净夹具必须 **9/0** |
| **首行空格** | 脏 `evidence/bench-2000.json` 必须**仍 9/0**（这就是那个假红的原样复现） |
| 不放过代码 | 脏 `src/` 仍必须**红**（不能为了 evidence 把代码变更也放过） |
| 可恢复 | `git checkout -- evidence/` 之后回到 **9/0** |

### 验证

- 全量：**505 passed / 0 skipped / 0 failed**（**43 个测试文件**；501 + 4）
- `check-maintenance` 专项 **4/0** · `release-hardening` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；`test/` 不进包）

**未验证**

- 假红只在 `check-maintenance` 里修了；**别的脚本若也用 `.trim()` + 固定列解析 `--porcelain`，可能有同样的歪一字符问题** ——
  本次没有全仓排查（`grep` 过一遍，只有这一处按列切）。

## 1.11.10 — 2026-10-31

### 修一个会**悄悄吞掉备份**的真 bug：回灌备份按会话分子目录

**现场**：`migrate-dangling --merge-sidecar --apply` 的备份目录原本是**每次运行一个**（`merge-<iso>/`），
同一次 `mergeMany` 里的多个会话**共用同一个目录** ⇒ 后一个会话的 `graph.json` / `MERGE.json`
把前一个**覆盖掉**。真实规模演练时 **48 个会话最后只剩 1 份备份**，而且**没有任何报错**。

**改法**

| 项 | 变化 |
|---|---|
| `mergeBackupDir()` | 新增 `session` 参数：备份写到 **`<run>/<session>/`**（会话名做 `[^A-Za-z0-9._-] → _` 清洗）；不传 `session` 时仍是原来的 `<run>` |
| `mergeMany().backupDirs` | 用 **`uniqueBackupDirs()` 去重** —— 同一次运行里 N 个会话共用同一个 run 目录，汇总列表只留一条（`perSession[].backupDir` 仍是各自的**精确路径**，不受影响） |
| `mergeSidecar` / `mergeMany` 的 JSDoc | 明确写出：**merge 不是字节级还原** —— `updatedAt` 会被刷新、`stateIndex` 可能与原图不同。**要逐字节恢复，请用 `apply` 的整目录备份 + `rollback`** |

**测试 +3（498 → 501）**

- **B1** `uniqueBackupDirs` 去重：同一 run 目录只出现一次，顺序保留
- **B2** 同一 root 的两份备份**都不丢**（回归上面那个「48 会话只剩 1 份」的 bug）
- **B3** 非字节级还原：行为断言（`updatedAt` 刷新后与原图不同）+ 文档断言（JSDoc 里写了「不是字节级」）

变异自检：不去重 / 不分子目录 / 删掉「非字节级」说明 —— 三条逐条红。

### 验证

- 全量：**501 passed / 0 skipped / 0 failed**（**42 个测试文件**；498 + 3）
- `migrate` **24/0** · `release-hardening` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；只改 `src/` 与 `test/`）

**未验证**

- 备份修复只在夹具上验证；**真实库的 merge 仍未执行过**（真实 `sessions/**` 的 apply / merge 都需主人授权 + 停插件窗口）。
- 「非字节级还原」只是**把差异写清楚**，没有提供「让 merge 变成字节级」的选项 —— 需要逐字节就用 `apply` 备份 + `rollback`。

## 1.11.9 — 2026-10-31

### 发布脚本新增门禁：CHANGELOG 写的「N 个测试文件」必须等于事实

**这条门禁上线当天就抓到了真实漂移**：CHANGELOG 从 1.11.5 起一直写着同一个旧数字（**37**），
实际早就是 **42** —— 连续几个版本没人对过账（它不影响构建，所以从来不会自己叫）。

**新增（`scripts/release-lib.mjs`，纯逻辑、可单测）**

| 导出 | 行为 |
|---|---|
| `declaredTestFiles(section)` | 读「N 个测试文件」；**没写返回 `null`**；容错 `**42** 个测试文件` / `（42 个测试文件；493 + 7）` / `42个测试文件` |
| `checkTestFileCount(section, actual)` | **三态**：一致放行 / 不一致给出 `{declared, actual, reason}` / 无声明放行 |

**`scripts/release.mjs` 体检 ②b**：当前版本那一节的数字 ≠ `test/*.test.mjs` 实际数 ⇒ **红，`--yes` 也不动手**；
**没写这句不报错**（允许不声明）。红文案同时给出两个数与「怎么数」（含历史版本数法）：

```
· CHANGELOG 写的「N 个测试文件」与实际 42 个不符 —— 改了测试文件就必须同步这句（或删掉它，脚本不会因此报错）。
  实际值怎么数：ls test/*.test.mjs | wc -l（看历史版本：git ls-tree -r --name-only <tag>^{commit} test/ | grep -c '\.test\.mjs$'）
```

### 顺带修掉两个「只在预演期才撞到」的发布脚本缺陷

写这条门禁时跑 dry-run，脚本**直接崩了**，顺藤摸出两个真缺陷（都不影响发版那一刻，但会让「已发版本上再跑一次预演」变成堆栈）：

1. **tag 已存在时 dry-run 崩**：`git rev-parse -q --verify refs/tags/x^{commit}` —— Windows 上 `execSync` 走 **cmd.exe**，
   `^` 是转义字符 ⇒ 被吃成 `{commit}`，命令失败抛异常（手动在 Git Bash 里跑同一命令是好的，极难从表面看出）。
   改用 `git rev-list -n1 refs/tags/<tag>`（无 shell 元字符，annotated / lightweight 都剥到 commit）+ try/catch。
2. **「tag 指向别的 commit」误报**：给 `ls-remote` 传**精确 pattern** 时**不会**输出 `^{}` 剥皮行 ⇒ 拿到的是 tag 对象 sha（≠ commit）；
   而且判据原本是「≠ HEAD」，但「发过之后 main 又往前走了」是**正常态**。改为列全部 tag 再在 JS 里过滤剥皮行，
   判据改成「**既不是 HEAD 也不是 HEAD 的祖先**」（`git merge-base --is-ancestor`）才报。

### 验证

- 全量：**498 passed / 0 skipped / 0 failed**（**42 个测试文件**；493 + 5 条 `release-hardening`）
- `release-hardening` **15/0** · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（`test/` 不进包，数量不变）
- 三态端到端（临时克隆、版本 9.9.9）：声明 37 / 实际 42 ⇒ **exit 1**；**无声明** ⇒ **exit 0**（附跳过说明）；声明 42 ⇒ **exit 0**
- 仓库记录更正：1.11.8 节的「37」已改为「42」并在原处注明「发布时误写；npm 上已发内容无法改」

**未验证**

- 门禁只校验**当前 `package.json` 版本那一节**；历史各节不追溯。
- 没把「仓库自洽」做成单测：若在测试套件里断言「当前版本的数字 == 实际数」，每加一个测试文件都会红到下一版
  （已发布那一节是冻结的）⇒ 这条只在**发布时**才对得起来。

## 1.11.8 — 2026-10-31

### sidecar 现在能**回灌**：归档掉的悬空边可以放回图里

1.11.1 起 `migrate-dangling --apply` 把 settled residue 归档到 `graph.dangling.json`（sidecar），
**但一直没有回灌工具** —— 报告里写「字段齐全、可回灌」，实际只能靠人手写 JSON。这一版把这条路补完。

**新增（R14 `src/rooms/migrate.mjs`）**

| 导出 | 作用 |
|---|---|
| `readSidecar(file)` | 读 + 校验：`format` / `version` / **非空 `edges`** / 每条边必须有 `id` / 会话匹配；**坏文件一律拒绝且不动图** |
| `mergeSidecar(graph, sidecar, opts)` | 按 `edge.id` 合并；**同 id 跳过、不覆盖**；保留 sidecar 原字段；**原子写 `graph.json` + 重建 `index.md`** |
| `mergeMany(target, opts)` | 目标可以是**文件或目录**；批量 |
| `mergeBackupDir(opts)` | 回灌前先备份 `graph.json` / `index.md` 并落 `MERGE.json` |

- **默认 dry-run**：只有 `--apply` 才写盘；**幂等** —— 二次 merge 0 条命中且**不写盘**。
- CLI：`--merge-sidecar=<file|dir> [--apply] [--backup-dir=] [--json]`；有错误 **exit 1**。

**CLI 摘要（`scripts/migrate-dangling.mjs`）**

- 修掉 `main()` 里 merge 分支的**重复执行链**（只留 `mergeMany`，错误 exit 1），人类摘要移到输出链。
- 无 `--json` 时打印：标题 / target / `sessions|merged|skipped` / 逐会话行 / backup 目录 / errors / dry-run 或已回灌提示；
  **`--json` 仍是纯 JSON**（可 `JSON.parse`）。
- `mergeMany`：目标不存在时**直接报「目标不存在」**（不再默默去读 `./graph.json`）。

**测试 +7**（486 → 493）

- M1 回灌与备份 · M2 幂等 · M3 **五类拒绝**（format/version/空 edges/边无 id/会话不匹配）· M4 同 id 不覆盖 · M5 `mergeMany` 批量
- C1 **真跑 CLI 六态**（人类摘要 / `--json` / apply 备份 / 幂等 / 坏 version / 目标不存在）· C2 结构回归（merge 分支恰好 2 处）
- 变异自检：覆盖已存在边 / dry-run 写盘 / 不校验 version / 执行链重复分支 / `--json` 走人类摘要 / 删人类摘要分支 —— 逐条红

### 验证

- 全量：**493 passed / 0 skipped / 0 failed**（**42** 个测试文件 —— 发布时误写 37，此处已按实际更正；npm 上 1.11.8 的 CHANGELOG 仍是 37，无法改）
- `migrate` **21/0** · `rooms` 15/0 · `verify-install` **16/16**
- `npm pack --dry-run --json`：**71 文件**（数量不变；只改 `src/` `scripts/` `test/`）

**未验证**

- 回灌**没有对真实库跑过** —— 全部证据来自夹具；真实 `sessions/**` 的 apply 仍需主人授权 + 停插件窗口。
- 回灌只按 `edge.id` 去重：**同一个「边」若在 sidecar 里 id 不同（历史重复归档），会被当成两条各插一次**。

## 1.11.7 — 2026-10-31

### 真实测试与门禁都不再「靠输出猜」

**问题**：两个门禁的判据都在**猜**，而不是**问退出码**。

1. `test/all.mjs` 用正则 `/failed|✗/` 扫子进程输出判失败 —— 测试名里可能**字面含 `✗`**
   （例如 `✓ S10c-3 manifestError 进 ✗ 详情…`）⇒ **把绿当红**；反过来，子进程真失败但输出没命中关键字 ⇒ **漏报**。
2. `test/real-fold-trigger.mjs` 无论 4/5 还是 5/5 **都 exit 0** ⇒ 它作为门禁时几乎没有意义。

**改法**

| 文件 | 变更 |
|---|---|
| `test/all.mjs` | 删掉 `/failed\|✗/` 正则判据，**只按子进程退出码**；**超时 / 起不来 / 无退出码一律算红**（不许当成「没输出=没事」）；导出 `STEPS` / `stepPassed` / `runStep` / `allPassed` 供单测直测 |
| `test/real-fold-trigger.mjs` | **加退出码**：4/5 ⇒ `exit 1`；依赖未提取（跑不了）⇒ `exit 2` 表示「未运行」而不是「通过」 |
| 同上 · ⑤ 溢出自救 | 没有可压内容时记 **N/A**（不计失败）—— 先注入新内容让它有东西可压；⑤ 判红不再是「环境没给料」的假失败 |
| 同上 · usage 对账 | 打印模型返回的 `usage`（**prompt / completion / total / calls**）并累加落盘，真实调用的成本可对账 |
| 同上 · 预清理 | 跑前**清空 `graphs-trigger`** —— 旧状态会让 ② 的 growth gate 误拦，**第二次跑必红** |

**新增 `test/test-gate.test.mjs`（5 条）**：`exit 0` 但输出含 `✗` **不得**误红 / 非 0 **必红** /
起不来 · 超时 **必红** / 4 通过 1 失败 **必败** / 结构回归（`STEPS` 与导出面）。

**变异自检**：`stepPassed` 恒 `true` ⇒ TG-2/TG-3 红；判据退回正则 ⇒ TG-5 红。

### 验证

- 全量：**486 passed / 0 skipped / 0 failed**（37 个测试文件；481 + 5）
- `node test/all.mjs` → **exit 0**（5 个步骤全绿：单测 / 挂载校验 / 真实模块 / 真实事务 / 性能基准）
- `node test/real-fold-trigger.mjs` → **5/5 exit 0**，usage 已打印
- `verify-install` **16/16** · `bench 2000` **351 tokens**
- `npm pack --dry-run --json`：**71 文件**（数量不变；`test/` 不进包）

**未验证**

- `real-fold-trigger` 依赖**真实模型**（走 magpie `127.0.0.1:3425`）与已提取的模块目录；缺依赖时它会 **exit 2（未运行）**，
  这是有意的语义 —— 但也就意味着**它在别的机器上可能根本不跑**，不能当「任何环境都能复现」的证据。
- `all.mjs` 的「超时必红」用 300s 默认超时，**没有真的等满 300s 去验证**（用的是注入假 `exec` 的单测）。

## 1.11.6 — 2026-10-31

### tier-2 解耦：checkpoint 的常驻成本不再随 fold 次数线性涨

**问题（只读核实）**：fold 的 range 从**上一个 checkpoint 之后**开始 ⇒ 旧 checkpoint **全部留在 surface**
（实测 `start=1009 > cp8=1008`），每 fold 一次就 +1 条；而旧代码**只在 pressure 分支**才收 tier-2。
⇒ auto 路径连做 12 次 fold，surface 上就线性涨到 **12 条旧 checkpoint**。

**改法**

- `src/engine.mjs`：删掉那个**空的 `#tier2`**（调用点 + 定义一起删）；常规 fold **成功后**
  （`tier2After > 0`）`await #tier2IfNeeded()`；**失败只 warn，不影响本次 fold**。
- `#tier2IfNeeded` 加 `_tier2InFlight` **防重入**（同一时刻只允许一个 tier-2 在跑，防递归 / 二次 `compactRegion`）。

**前后对照（同一会话 12 次 fold）**

| | surface 上旧 checkpoint 条数 | tier-2 次数 |
|---|---|---|
| 旧 | **12**（`[1..12]`，max 12） | 0（auto 路径从不触发） |
| 新 | **8**（`[1..8,7,8,7,8]`，max 8） | 14 次 = 12 fold + **2 tier-2** |

**测试 6 → 7**：T2-0 改写（空方法已删、fold 后调用、防重入）、T2-5 改写（auto 也触发）、
T2-6 新增（不递归 / 压回上限 / `tier2After=0` 不触发）。变异：删掉 fold 后的触发 ⇒ T2-0/T2-5/T2-6 红。

### 迁移守卫补上 delta：只看 `graph.json` 会漏掉「插件其实在写」

**问题**：`migrate-dangling --apply` 的 120s 新鲜度守卫**只 stat `graph.json`**。但 1.9.2 起是**增量落盘** ——
`graph.json` 只在回合边界写，插件活跃时往往**只有 `graph.json.delta.jsonl` 在动**。
真实库实测：**8 个会话的 delta 在 120s 内被写过，而旧守卫一个都没拦住** ⇒ apply 可能在插件仍活跃时放行，
随后内存 flush 把迁移结果覆盖回去（这正是 P6-C 反复强调的 `netCleaned=0` 场景）。

**改法**

- 新增导出 **`DELTA_NAME = "graph.json.delta.jsonl"`**（与 `kifu-persist.sessionPaths().deltaFile` 的 basename
  必须一致，测试有断言盯着这两个名字）。
- 新增 **`freshEvidence()`**：返回每个「120s 内被写过」的会话**及具体文件**；`freshSessions()` 在其上去重。
- 判据：`graph.json` **必看**（缺失照旧抛 ENOENT，不静默跳过）；**delta 存在就看 delta**；
  delta 缺失不判 fresh（老库没有 delta 文件也照样能迁移）。
- 拒绝 apply 时的报错会**点名会话与文件**，而不是只说「有会话新鲜」。

**测试 +4**：P6C-11（只有 delta 在写 ⇒ 拦住并点名文件）/ P6C-12（delta 缺失不影响）/ P6C-13（两者都旧 ⇒ 放行）/
P6C-14（多会话混判：按会话去重，逐个点名）。

### 验证

- 全量：**481 passed / 0 skipped / 0 failed**（36 个测试文件；476 + 1 tier-2 + 4 migrate）
- `tier2` **7/0** · `migrate` **14/0** · `engine-harness` 25/0 · `rooms` 15/0 · `verify-install` **16/16**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**71 文件**（数量不变：只改 `src/` 与 `test/`，无新增文件）

**未验证**

- tier-2 的**运行期**收益未在真机观测 —— 8 vs 12 是引擎级前后对照（同一会话、同一 fold 序列）。
- delta 守卫只在测试夹具与**只读扫描**真实库上验证过；**真实 apply 仍未执行**（需主人授权 + 停插件窗口）。

## 1.11.5 — 2026-10-31

### S10d · 测试运行器终于能区分「跳过」与「通过」，「空壳用例」不再是绿的

**问题**：旧 `run.mjs` 里，平台/权限不对时用 `return` 早退，**会计入 passed** —— 单看
「N passed」根本排除不了跳过；而且一个**一条断言都没有**的用例也会静默算通过。

**改法**

| 能力 | 说明 |
|---|---|
| `t.skip(reason)` | 计入 `skipped`，不计 pass/failed；**exit code 只由 failed 决定** |
| 汇总行 | `== N passed, M skipped, K failed ==`（新增中间那段，跳过不再藏在 passed 里） |
| **零断言检测** | `assertions === 0` **且**源码里没有 `throw` / `assert` 证明 ⇒ 计入 `zeroAssertions` 并**按失败处理**。本仓 300+ 用例是 throw 风格（算有证明），空壳用例从此不再静默算 pass |
| `--dir=` | 仅供 `run-skip` 夹具指向临时目录 |

- **`install-link` 6 处平台/权限早退改为 `t.skip(...)`**，原有断言一字未改。
- 新增 `test/run-skip.test.mjs` **3 条**：四态（pass/fail/skip/零断言）可区分、skip 不导致失败、零断言严格红。

**变异自检**：删掉 skip 分支 ⇒ `run-skip` 红；删掉零断言检测 ⇒ `run-skip` 红。

### 验证

- 全量：**476 passed / 0 failed / 0 skipped**（36 个测试文件；473 + 3）
- `install-link` **29/0** · `run-skip` **3/0** · `rooms` 15/0 · `verify-install` **16/16**
- `bench 2000`：**351 tokens**（与基线一致）
- `npm pack --dry-run --json`：**71 文件**（数量不变，只改 `test/`）

**未验证**

- 零断言检测只认 `assertions` 计数与 `throw`/`assert` 的**文本证据**：如果一个用例用别的方式实打实地检查了东西（例如把结果写进外部文件再断言），仍可能被误判 —— 目前本仓没有这种写法。
- `skipped` 总数现在是 0（本机 Windows）。**跨平台**（Linux/macOS 上那 6 条会真的 skip）没有实跑过。

## 1.11.4 — 2026-10-31

### 发布脚本加固：坏 remote 在预演阶段就红，git 步骤事务化

**背景是一起真实事故**：1.11.3 发布时 `scripts/release.mjs --yes --npm` 返回 **EXIT 1** ——
仓库 `remote.origin.url` 被写成 `git+https://…`（那串正是 `package.json` 的 `repository.url`，
在 npm 里是规范写法，**但不是合法的 git remote**）。旧体检用正则匹配 `github.com:` 照样通过；
真做时 `git push` 全崩，**而脚本继续建 Release、继续 `npm publish`**，留下
「npm 已发 / Release 已建 / main 没推 / tag 指向旧 commit」的半途状态。

**新增 `scripts/release-lib.mjs`**（纯逻辑、可单测、零副作用）

| 导出 | 作用 |
|---|---|
| `parseRepo(url)` | 只认 scp 式 `git@github.com:o/r(.git)`、`ssh://git@github.com/o/r`、`https://github.com/o/r`；`git+*`、`file://`、非 GitHub、空 → `null` |
| `classifyRemote(url)` | **先判 scheme 再判仓库**；`git+…` 直接拒，并给出可执行的修法（`git remote set-url origin git@github.com:<owner>/<repo>.git`） |
| `runTransaction(steps)` | 顺序执行 + **首步失败即中止**，返回 `{ok, done, failed, error, aborted}` |

**`scripts/release.mjs` 体检从 5 项增到 8 项**

- ⑤ **remote 必须是合法 GitHub URL**（不再「正则匹配到 github.com 就算过」）
- ⑥ **`git ls-remote --heads origin` 必须成功** —— 远端不可达直接红
- ⑦ **`git fetch` 失败从 note 改成 red** —— 旧版把「不知道远端正不正常」当成「跳过检查继续发版」
- ⑧ **tag 已存在时区分两种情况**：指向本 commit ⇒「不能发两次」；**指向别的 commit**（1.11.3 的现场：Release API 自动建了轻量 tag）⇒ **不自动 force**，报错并给 `git push --force origin refs/tags/<tag>:refs/tags/<tag>` 的人工修法

**真做改成事务**：`runTransaction([push 分支, tag -a && push tag])` → 任一失败即 `abort()`，
打印「已完成 / 未执行：tag · npm · Release」；**`npm publish` 移到 Release 之前** ——
npm 失败就不建 Release（避免「Release 说有、npm 上没有」）；Release 失败仍 exit 1。

**`scripts/check-maintenance.mjs` 也补了两项**（日常维护就能提前发现）

- ⑧ `remote.origin` 必须是合法 GitHub URL（复用 `classifyRemote`，同一份判据）
- ⑨ `git rev-parse --show-toplevel` 必须等于 cwd（防串仓 —— `ROOT` 取 `process.cwd()`，
  在子目录或别人的仓库里跑会把版本号/CHANGELOG/tag 写错对象而看起来一切正常）

**验证**

- 全量：**473 passed / 0 failed**（36 个测试文件；463 + 10 条 `release-hardening`）
- `check-maintenance`：**9 项**
- `npm pack --dry-run --json`：**71 文件**（70 + `scripts/release-lib.mjs`；`release.mjs` 运行时依赖它，必须随包）
- **预演**：release-ready 的临时克隆上 `node scripts/release.mjs` → **EXIT 0**；
  同一克隆把 remote 换成 `git+https://…` → **EXIT 1**，报错点名协议并给修法

**未验证**

- 未改 `.github/workflows/release.yml`（存在时脚本走「推 tag 自动建 Release」分支，本次未触碰）。
- `check-maintenance` 的 ⑧ 只判 URL 形状，**不探远端可达性**（保持「不需要网络」的定位；可达性由 `release.mjs` 的 ⑥ 在发版时把关）。

## 1.11.3 — 2026-10-31

### P0-1 · `exit` 判据收紧：不再被正文子串误判

旧实现用 `slice(-200)` 在尾部 200 字符里**子串搜索** `[exit code: N]` ⇒ 命令**输出正文里提到**这串就误判成「有退出码」，
且「标记之后还有输出」时前后结论不一致。

- 新增 `lastLineExitCode()`：取**末条非空行**，**整行等于** `[exit code: N]` 才算有退出码；否则视为 no-exit。
- `verify.mjs` 顶部注释同步；`_internal` 导出 `LOCAL_MUTATE_TOOLS` / `lastLineExitCode`。
- 测试 +3（`verifier` OPT-V-1 / OPT-V-2、`weak-shell` S2b-14）；变异：退回 `slice(-200)` ⇒ OPT-V-1 变红。

### P0-2 · `local-mutate` 从只读表拆出（不再被当成「只读工具」）

`todo_write` / `update_goal` / `create_goal` / `hindsight_ingest_document` / `team_task_*` / `send_message` /
`spawn_teammate` / `subagent` / `schedule_*` / `job_kill` … 这些**会改状态但不是文件写**的工具，原先把它们混在只读表里，
分类结果自相矛盾。现在：

- 新增 `LOCAL_MUTATE_TOOLS`；`toolClass()` 返回 **`local-mutate`**（与 `read-only` / `write` 并列）
- `classify()` 对 local-mutate 给 **`unverified` + kind `none`，且不带 `weak`**（它既不是「进展」也不是「失败」）
- `WRITE_TOOLS` / `present` 与 `isError` 的**优先级不变**
- 变异：把 local-mutate 放回只读表 ⇒ S2b-14 + OPT-V-2 变红

### 外部入口 · 新增 `dsh-gokifu-compact/graph` 与 `/persist`

1.11.2 的 README 教外部工具去读 `node_modules/dsh-gokifu-compact/src/rooms/kifu-model.mjs` —— 那是**深层路径**，
`exports` 里没有 ⇒ 现代 ESM 解析会直接拒绝。现在补两个正式入口：

| 入口 | 目标 | 用途 |
|---|---|---|
| `dsh-gokifu-compact/graph` | `src/rooms/kifu-model.mjs` | `fromJSON` / `toJSON` / `decodeDeltaFrames` / `applyDelta` / `renderIndexMd` … |
| `dsh-gokifu-compact/persist` | `src/rooms/kifu-persist.mjs` | `graphRoot` / `sessionPaths` / `createPersistStore` / `load` / `flush` … |

- 新增 `test/package-exports.test.mjs`（**7 条**）：声明齐全、子路径可解析、真实 `import` 成功、导出面非空、不泄漏内部路径
- README 的「怎么拿最新状态」一行改为指向这两个入口

### 零失败边最小注入（OPTIONS 之后又一刀「别让热清单吃白饭」）

**问题**：只读统计 **167 个真实会话**，**42 个（25.1%）零失败边** —— 它们照样要付一份完整热清单的 token。

**改法**：

- `ledger.mjs` 新增 `renderMinimalLedger`：`<chess-ledger>` 内只有三行 —— `GOAL` / `CONSTRAINTS: N` / `NO_FAILED_ATTEMPTS_YET`；
  **`renderLedger` 一个字节不动**（167 会话新旧对比 `byteDiff=0`）
- `hot-inject.decideInjection`：零失败边且 `hasLedgerState` ⇒ 用最小渲染走**原注入流程**（digest / 限流 / replace / fold 补回全不变）；空图仍 `skip no-ledger`
- 实测（42 个零失败会话）：最小注入 **avg 25.4 tok / max 57**（同批会话的完整最小档 avg 386 / max 497）
- 分布：root 覆盖 **42/42**、constraints **32/42**、完全空 **0**（不会出现「三行全空」的哑注入）
- 测试 +4：OPT-E-1 触发与三项内容 / OPT-E-2 空图 skip / OPT-E-3 有失败边时字节不变（sha 钉死）/ OPT-E-4 fold 补回
- 变异：零失败退回 skip ⇒ E-1/E-4 红；删 `NO_FAILED_ATTEMPTS_YET` 行 ⇒ E-1/E-4 红

### tier-2 行为矩阵

- 新增 `test/tier2.test.mjs`（**6 条**，engine 零改动）+ `engine-harness` 导出 4 个 helper —— 把此前「文档说有、代码没测」的第二档行为逐条核实。

### 验证

- 全量：**463 passed / 0 failed**（36 个测试文件；443 + 7 exports + 3 verify + 6 tier2 + 4 hot-inject）
- `rooms` **15/0** · `hot-inject` **12/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.336 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）
- `npm pack --dry-run --json`：**70 文件**（数量不变）/ 562,344 B；`test/`·`tmp/` 命中 0

**未验证（必须知道）**

- 最小注入的**运行期收益未在真机观测** —— 25.4 tok 是离线夹具口径，167 会话统计是只读扫描。
- tier-2 矩阵跑在假 ctx 上，不是真机行为。
- README 里的「真实包 8/8 †」「真实进程 fold 3~6/6 †」带 **†** = 历史口径，**本版未复跑**。

## 1.11.2 — 2026-10-30

### 本包改成 DSH bundle（UI 挂载不再需要用户手改 YAML）

**这是第一个 UI bundle 版。** 以前装完包要**手改 profile 的 `cordis.patch.yml`** 加一条
`- insert: [{id: gokifu-ui, name: 'dsh-gokifu-compact'}]` 才能挂上 UI。手改有两个后患：

1. **双挂载**：用户升级包后手工行还留着，和 bundle 通道同时挂 ⇒ 两个 host 半注册同一个 `/gokifu/api` 前缀 ⇒ **启动即失败**（duplicate prefix route）；
2. **没挂载**：`dsh plugin add` 不会自己补挂载行 ⇒ 「装好了但没生效」，且**没有任何报错**。

**改法**

- 新增 **`cordis.patch.yml`（28 行）**：只做一件事 —— `- insert: [{id: gokifu-ui, name: 'dsh-gokifu-compact'}]`。
  **引擎不在这里**：压缩后端必须挂在 **agent preset 的 compaction group 内部**，profile/bundle 级 patch 打不到 `preset.config.plugins`；那一行仍由 `install.mjs` 改 preset。
  `id` 保持 `gokifu-ui`（与历史手工行一致）⇒ 从手工通道切过来时，日志/文档/doctor 口径都不用改。
- `package.json`：`dsh.bundle.patch = "./cordis.patch.yml"` · `dsh.manifestVersion = 1` · `files`/`exports` 补 `cordis.patch.yml`；`main` 与 `dsh.client` 不变。
- **`scripts/install.mjs` 改 bundle 优先**：
  - `findManualUiRow` / `removeManualUiRow`：定位并（带备份）删除 profile 里的旧手工行
  - `patchProfileBundles()`：把本包**追加**进 `dsh.profile.bundles`，保持既有顺序；写前备份 profile/`package.json`
  - `ensureBundleChannel()` = **先加 bundle、再删手工行** —— 顺序保证任何中断都不会出现「两条都没有」的空窗
  - `git`/`registry` 规格**不改写成 `link`**
- **`test/verify-install.mjs` 判据升级**：旧判据「bundles 里没有它」→ **「UI 挂载通道二选一，不双挂载」**：两条都在 = 红（双挂载）、都没有 = 红（没挂载）；检查项总数仍 **16**。
- **`test/ws-install.test.mjs`**：健康夹具改走 bundle 通道；**新增 S11 四种态**（bundle-only 绿 / manual-only 绿 / both 红 / neither 红）。
- **`test/install-link.test.mjs`** 夹具同步。
- **新增 `test/bundle.test.mjs`（6 条）**：B-1 声明齐全 · B-2 patch 只插 UI 一行 · B-3 `findManualUiRow` 三态 · B-4 bundle 优先+备份+幂等 · B-5 dry-run 零写 · B-6 registry 规格不被改写。
- **变异自检（4 条，逐条实测红）**：删 `dsh.bundle` ⇒ B-1；patch 塞引擎行 ⇒ B-2；安装器不删手工行 ⇒ B-4；判据退回「bundle 里不许有」⇒ S11 + S10e-1。

### 验证

- 全量：**443 passed / 0 failed**（36 个测试文件；436 + 6 bundle + 1）
- `rooms` **15/0** · `ws-install` **14/0** · `install-link` **29/0** · `bundle` **6/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.423 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）
- `npm pack --dry-run --json`：**70 文件**（69 + `cordis.patch.yml`）/ 558,113 B；`test/`·`tmp/` 命中 0
- live 当前仍是**手工通道**（`bundle=无｜手工行=有`）—— `verify-install` 按「二选一」判据通过

**未验证（必须知道）**

- **未跑 live install**：`--apply` 到真实 profile 的 bundle 切换没有执行过（只在 dry-run 与夹具上验证）。
- **未启 DSH**：bundle 通道在真实插件树里的加载行为未观测。
- 从手工通道切换到 bundle 的**中断恢复**只在单测里模拟（顺序保证 + 备份），真机未演练。

## 1.11.1 — 2026-10-30

### P6-C 落地：未落地尝试不再被当成残留（**热清单新增 OPTIONS 段**）

1.11.0 之前，**超过 10 分钟仍没落地的尝试**（`to===null && result==="untested"`）被归进 `residue` 一起从热清单里丢掉。
这是错的：它不是残留，而是**「你可以继续，也可以放弃」的选项** —— 模型有权知道它存在。

**P6C-1 · 悬空边从四类变五类**

| 类 | 判据 | 进热清单？ |
|---|---|---|
| `residue` | `to===null` 且**已结算**（`result !== "untested"`）且 >10 分钟 | 不进（真残留，可归档） |
| **`candidate`（新）** | `to===null` 且 `result === "untested"` 且 >10 分钟 | **进 OPTIONS 段**，陈旧标 `[stale 42m]` |
| `live-unsettled` | `to===null` 且 `untested` 且 ≤10 分钟 | 进 OPTIONS（新鲜） |
| `from-broken` | `from` 指向不存在的节点 | 保留可见 |
| `none` | 其余 | — |

- 新增导出 `isDanglingOption(edge)`：只认 `result==="untested"` 的无终点边；**刚结算的失败边不算选项**
- `renderLedger` 新增 `OPTIONS (not yet landed — you may continue or abandon):` 区段；**UNVERIFIED 不再包含未落地的边**
- `renderFacts` 同样拆出 OPTIONS 段，并加 `STALE_UNSETTLED: N edges are untested and older than 10min — listed as OPTIONS …, NOT residue.` 计数行
- 测试 +3（`[stale 42m]` 标记 / settled 仍归 residue 的回归 / renderFacts 拆分与计数）

### P6C-2 · 迁移工具晋升为房间 R14 + 独立 CLI

- **`src/rooms/migrate.mjs`（20,913 B / 21 导出）**：`planSession` / `buildSidecar` / `removeEdges` / `listSessions` / `dryRun` / `freshSessions` / `backupTree` / `rollback` / `apply` / `verify` + 路径规则
- **`scripts/migrate-dangling.mjs`** 新 CLI（默认 dry-run）＋ `scripts/cli.mjs` 增 `migrate-dangling` 子命令；参数 `--apply` / `--verify` / `--rollback` / `--backup` / `--root` / `--backup-dir` / `--sessions=` / `--force` / `--now` / `--json` / `--help`；退出码 0/1/2
- **只归档 settled residue** —— `candidate` 一条都不动，且 `planSession` 有硬断言：`residue` 集合里出现 `result==="untested"` 就抛错（防判据回退时悄悄归档）
- **路径经 R01**：`sessionsRoot()` = `join(graphRoot({...}), "sessions")`，不自己拼
- **120s 新鲜度守卫**：`--apply` 前扫会话目录，任一 `graph.json` 的 `|now − mtime| < 120s` ⇒ **拒绝 apply 且不备份、不写任何文件**（用绝对值：NTFS 时间戳可能比 `Date.now()` 超前几毫秒）；`--force` 才跳过
- **备份写到 `sessions/` 之外**（`<DSH_HOME>/chess-context/migrate-backups/backup-<ts>`），否则会被自身 `cpSync` 递归
- **坏图逐会话汇总**：`dryRun`/`apply`/`verify` 都返回 `badGraphs:[{session, ok:false, reason}]`（旧原型静默跳过）
- 原型 `test/archive-dangling.mjs` 删除，测试迁为 `test/migrate.test.mjs`（**10/0**：7 条原有 + 路径经 R01 + 守卫 + 坏图）

**P6C-3 · 隔离目录端到端演练（PASS）**

夹具 2 会话 × 5 边（residue / candidate / live / from-broken / 真失败各一），跑前跑后 `git status` = 0：

| 阶段 | 结果 |
|---|---|
| dry-run | `residue:2 / candidates:2 / liveUnsettled:2 / fromBroken:2`，`deltaBytes:-68`；**整树 sha 前后完全相同** ⇒ 真的没写 |
| apply | 归档 **2 条 residue**、**`candidate` 一条未动**（重算 residue=0 / candidate=1）、`-68 B` |
| sidecar | 每会话 `graph.dangling.json`：源图 `sha256`/`bytes`/`criteria` + 归档边**全字段** ⇒ 可回灌 |
| verify | `ok:true`，抽样边与备份图逐字段相同，`problems:[]` |
| rollback | 整树 sha **回到原值** ⇒ 逐字恢复 |

### 发布流程修复：`release.mjs` 现在打 **annotated tag**

1.10.0 / 1.11.0 的 tag 是**轻量 tag**（`git cat-file -t` 只看到 `commit`）—— 没有作者、日期、消息，
GitHub Release 的 Tag 一栏是空的，「这一版改了什么」在 tag 上查不回来。
**修复**：`scripts/release.mjs` 的计划文本与真做命令统一为 `git tag -a <tag> -m "release <tag>"`；
`scripts/check-maintenance.mjs` 增加静态断言 ⑦ 盯着这条，谁改回 lightweight 立刻红。
⚠ **已发布的 `v1.11.0` 不追改**（tag 是对外契约）；规则从**本版起**生效。

### 验证

- 全量：**436 passed / 0 failed**（36 个测试文件；A3 收口 430 + P6C-1 的 3 + P6C-2 的 10 − 原型 7）
- `rooms` 架构门禁 **15/0** · `migrate` **10/0** · `verify-install` **16/16**
- `bench 2000`：**351 tokens** / 1.333 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）—— 与基线逐字一致
- `npm pack --dry-run --json`：**69 文件**（67 + `rooms/migrate.mjs` + `scripts/migrate-dangling.mjs`）/ 552,403 B；`test/`·`tmp/`·harness 命中 **0**

**未验证（必须知道）**

- **对 live `sessions/**` 的 apply 从未执行** —— P6C-3 是隔离夹具（2 会话），真实库是 150 个会话 / 13,043 个 agent 节点；规模与真实判据分布都没经历过。
- **停插件窗口流程一次都没跑**（隔离目录压根没碰运行中的插件）。
- **sidecar 回灌未实现**（字段齐全 ≠ 有回灌工具）。
- P6C-2 有一处**契约文字偏差**已披露：契约 R14 的允许依赖未列 R06，但判据必须单一来源（`classifyDangling` 只在 R06）⇒ 房间实际 import `./ledger.mjs` 的判据函数与 `DANGLING_STALE_MS`，已补进 ROOMS 的 allowed 表。

## 1.11.0 — 2026-10-30

### 最小交付房间架构收口：A2 + A3 全部完成（**首个把 16 房间落到底的正式版**）

1.10.0 只做到 A3-1a/b/c（三个房间 + 8 个门面还在）。这一版把 **A3 剩余四刀、删门面、四条新门禁**全部做完：
**`src/` 顶层只剩 `engine.mjs`（R09）与 `ui.mjs`（R11）**，其余 11 个房间全部在 `src/rooms/`，
**8 个旧门面已删除**（任何复活都会被门禁判红）。

**A3 物理搬迁 · 后四刀（纯移动，旧路径留一行 `export *` 门面）**

| 刀 | 房间 | 文件 | 自证方式 |
|---|---|---|---|
| A3-1d | `R00 kifu-model` | `src/graph.mjs`（1,136 行 / 47,853 B）→ `src/rooms/kifu-model.mjs` | `git` 100% 重命名，0 行改动；导出面 43 === 43 |
| A3-1e | `R03 keeper` | `src/keeper.mjs` + `src/extract.mjs` → `src/rooms/keeper.mjs`（12,335 B） | 合并正文与「两份备份去 import 后拼接」**逐字节相同**；导出 11 === 11 |
| A3-1f | `R06 ledger` | `src/ledger.mjs`（871 行 / 55,948 B）→ `src/rooms/ledger.mjs` | 对备份 `diff` **只有 2 行**（`./graph.mjs`→`../graph.mjs`、`./verifier.mjs`→`../verifier.mjs`） |
| A3-1g | `R07 facts-prompt` | `src/summary-prompt.mjs`（101 行）→ `src/rooms/facts-prompt.mjs` | `cmp` **逐字节相同**，零 import 修正 |

**A3-2 · 删除 8 个旧门面 + 一次性改 import**

- `git rm src/{verifier,range,worldstate,graph,keeper,extract,ledger,summary-prompt}.mjs`
- 重写 **44 个文件 / 77 行** import（纯路径，无断言改动）：`src/engine.mjs` 6 条、`src/rooms/*` 5 条、
  `test/` 37 文件 + `scripts/doctor.mjs`
- **pack 75 → 67（−8）**：这正是「门面存在时同一份实现有两个入口」的代价被消掉的直接体现

**A3-2-fix + A3-3 · 让「删门面」可被机器判定（4 + 2 条新门禁，`rooms` 9 → 15 用例）**

| 规则 | 断言 |
|---|---|
| `src/` 顶层白名单 | 只允许 `engine.mjs` / `ui.mjs`（harness 生成物不计） |
| 已删门面引用扫描 | `src/` 与 `test/` 不得引用那 8 个名字；按**解析后的绝对路径**判定（房间内部同目录引用放行） |
| 最终路径 | `ROOMS` 每项 `file === <id>.mjs` 且真实存在；房间集合必须等于契约 11 个 |
| **C1/R-C 精确化** | `@deepseek-ai/*` 的 **import** 只允许出现在 `src/engine.mjs`，且宿主说明符集合必须**恰好**那 4 个 —— 判据按**说明符**而非裸文本，所以 preset 块与注释里仍可写官方包名（行为面冻结） |
| **R-E** | `src/engine.mjs` 不得 import `rooms/migrate.mjs`（P6-C「禁止 engine 启动钩子」的机器判据） |
| **R-F** | `src/`·`scripts/`·`lib/` 不得出现 `allowedModels` 字样（宿主全局配置，插件不读不写） |

每条都带**判据自检**与**变异自检**（恢复 `src/graph.mjs`、把测试 import 改回旧路径、给引擎偷 import `schemastery`、
给 engine 加 migrate import、在 doctor 里写 `allowedModels` —— 5 组全部实测变红，还原后 15/0）。

**隔离实例运行时验证（A2-R / A3-R）**

- **A2-R PASS**：`tmp/dsh-gokifu-compact/test-home/`（独立 `DSH_HOME` + profile `test`，headless 不占端口）——
  `compaction start → summary → end` 一次完整、`foldCount=1`、摘要含完整棋谱结构；桌面
  `profiles/desktop/cordis.patch.yml` sha256 `047a342e…` / mtime / size **三项跑前跑后全同**，19387 同 PID 仍在监听。
- **A3-R PASS**：在 `0b61fb9` 干净树上复跑（跑前/跑后 `git status` 均 0 项）—— EXIT 0、`foldCount=1`、摘要 **7 段齐全**、桌面与仓库零变化。

**验证**

- 全量：**430 passed / 0 failed**（36 个测试文件；A3-2-fix 426 + A3-3 新增 4）
- `rooms` 架构门禁：**15/0** · `verify-install`：**16/16**
- `bench 2000`：**351 tokens** / 1.133 ms（81,260 / 386,945 字符、1.41 MB、2001 节点）—— 与迁移基线逐字一致
- `npm pack --dry-run --json`：**67 文件** / 539,339 B / `9f7e2a4b0c923066eb7ef29ffa6d26364da6715f`；`test/`·`tmp/`·harness 命中 **0**

**未验证（必须知道）**

- **A2-R / A3-R 都是隔离实例，不是 live 桌面重启** —— live 侧（19387）的注入与落盘行为仍未在真实会话中观测。
- **运行期收益未验证** —— 性能数字全部来自离线夹具。
- `lib/client.js` 的 `FIELDS`（15 键）仍是配置的第 4 份来源（收敛 4/5），留待 R12。
- R14 `migrate` 房间仍未创建（P6-C 原型在 `test/archive-dangling.mjs`，未接 CLI）。

## 1.10.0 — 2026-10-30

### 房间化架构：A2 五刀 + A3 前三刀（**GitHub 试用版，桌面不自动更新**）

> ⚠ **分发说明**：1.10.0 **只发 GitHub Release，不发 npm**。DSH 桌面端只认 npm registry，
> 因此**不会自动更新到本版**；想试用请从本 Release 的源码/tarball 手动安装。
> npm 上的 `latest` 仍是 1.9.3。

这一版把「上下文压缩后端」从单文件堆拆成 **16 个房间（R00–R15）**，落地了 A2 全部五刀与 A3 前三刀。
**行为零变更**：所有搬迁都是纯移动 + 旧路径留一行 `export * from "…"` 门面，热清单文本 / classify 判据 /
`graph.json`·delta 字节 / preset 块格式**一个字节都没动**。

**A2 · 五刀（抽房间 + 收敛配置来源 + 删死接口）**

| 刀 | 房间 | 内容 | 验收 |
|---|---|---|---|
| A2-1 | `R15 preset-format`（8,364 B） | preset 纯文本格式 `parseEngineBlock` / `renderEngineBlock` / `replaceCompactionBlock` / `engineBlock` / `KEY_COMMENTS`；`src/ui.mjs` 与 `scripts/install.mjs` 双用（install 必须 re-export，删掉会让 3 个测试红） | 390/0 · pack 65 |
| A2-4 | `R15 config-schema`（14,968 B） | 配置的**单一来源**：`SCHEMA` 23 键 / `PRESET_KEYS` 16 / `BASE_KEYS` 11；`resolve()` / `describe()` / `validatePatch()` / `engineBlock()` 全部派生。**收敛 4/5** —— `lib/client.js` 的 `FIELDS`（15 键硬编码）仍是第 4 份，留待 R12 | 401/0 · pack 66 |
| A2-5 | — | 死接口清理（纯删除）：`renderTranspositionWarning` / `incomingEdges` / `outgoingEdges` 及 engine 里的无用 import / re-export | 401/0（同数）· pack 66（−664 B） |
| A2-2 | `R01 kifu-persist`（12,364 B） | 落盘与增量协议搬出 engine：`load` / `flush` / `persistBudget` / `paths`，吃注入的 fs `port`。**两处行为单列**：① load 读不出/版本不符 ⇒ `{repaired, repairedReason}` + 一行 warn（旧版静默建空图）；② flush 失败 ⇒ `{ok:false, error, dirtyKept:true}`，dirty 照旧不清 | 412/0 · pack 67 |
| A2-3 | `R08 hot-inject`（12,554 B） | 每步注入策略搬出 engine（259 行）：`#bindLedger` / `foldFailureWarning` / `ledgerDigest` / `findLedgerNode` / `messageTextOf` / `elideLegacyLedgers`；`createUserMessage` 由 R09 参数注入 ⇒ **R08 不 import DSH** | 424/0 · pack 68 |

> A2 之间还有一刀 **A2-2-fix**：`rooms` 门禁补 `ROOMS` 登记表与 4 条用例（未登记文件必须红、方向依赖断言），416/0。

**A3 · 前三刀（物理搬迁，旧路径留一行门面）**

| 刀 | 房间 | 文件 | 验收 |
|---|---|---|---|
| A3-1a | `R04 verify` | `src/verifier.mjs` → `src/rooms/verify.mjs`（17,914 B，325 行原样） | 424/0（同数）· pack 69 |
| A3-1b | `R02 fold-planner` | `src/range.mjs` → `src/rooms/fold-planner.mjs`（6,502 B，git 100% 相似度） | 424/0（同数）· pack 70 |
| A3-1c | `R05 world` | `src/worldstate.mjs` → `src/rooms/world.mjs`（3,292 B）；内部 import `./graph.mjs` → `../graph.mjs`（下沉一层） | 424/0（同数）· pack 71 |

**四条可静态断言的架构方向规则**（`test/rooms.test.mjs`，9/0）：
R-A `src/**` 不得 import `scripts/`/`lib/`；R-B R00–R08 不得 import `@deepseek-ai/*`/R09/R11/`scripts/`；
R-C **R09 之外**任何文件不得 import `@deepseek-ai/*`；R-D `lib/client.js` 不 import 仓库内文件、R10/R14 不 import R09。

**验证**

- 全量：**424 passed / 0 failed**（36 个测试文件）
- `verify-install`：**16/16**
- `bench 2000`：**351 tokens** / 1.336 ms（81260 / 386945 字符、1.41 MB、2001 节点）—— 与迁移基线逐字一致（ms 为运行噪声）
- `npm pack --dry-run --json`：**71 文件** / 537,438 B / `49c13887ff3fa9c23e46d573df7410f84b00b3a0`；`test/`·`tmp/`·harness 命中 **0**
- `rooms` 架构门禁：**9/0**

**未验证（必须知道）**

- **真机重启验证（A2-R）未做** —— 全部 424 项都在假 ctx / 夹具上跑；真实 surface `replace` 行为未在桌面 DSH 上观测。
- **运行期收益未验证** —— 性能数字全部来自离线夹具。
- A3 物理搬迁只做了 3/7 刀：`graph` / `keeper+extract` / `ledger` / `summary-prompt` 仍在原位。

## 1.9.3 — 2026-10-30

### 修 README 版本行（1.9.2 的发布缺陷）

1.9.2 的 npm 包里 `README.md` 第 3 行仍写着「当前版本 1.9.1」—— 用户装上包后第一眼看到的就是错的版本号。
本版**只修这一处**：`README.md` 第 3 行 = **1.9.3**，与 `package.json` 的 `version` 一致。

- 代码零改动：`src/`、`scripts/`、`lib/` 与 1.9.2 逐字节相同。包内其余差异只有 `package.json` 的版本号、
  `README.md`（本修复），以及 `docs/` 两份维护文档的最终稿。
- 发布门禁新增硬断言：`README.md` 的「当前版本：x.y.z」必须等于 `package.json` 的 `version`，不一致即拒绝发布。
- 单测 **378 项全绿**（含 task-59 的测试夹具改造；`test/` 不进包）。

## 1.9.2 — 2026-10-30

### ⚠ 破坏性契约变化：`graph.json` 不再是「最新状态」

**1.9.2 起，落盘拆成「上一回合基线 + 当前增量」：**

| 文件 | 内容 |
|---|---|
| `graph.json` | **上一个回合边界**的完整基线 |
| `graph.json.delta.jsonl` | 本回合的增量帧，一帧一行 `<baseHash16>\t<checksum31>\t<json>` |

`graph.json` 只在**回合边界**（`agent/status idle`）落一次；回合内每一步只追加 delta 帧。
⇒ **外部工具若只 `JSON.parse(graph.json)`，会少一个回合的数据。** 最新状态 = 基线 + 按序重放 delta
（`fromJSON` → `decodeDeltaFrames(text, baseHash)` → `applyDelta`，三个函数在 `src/graph.mjs`）。
README 新增「graph.json 契约（外部工具必读）」一节，含三条余量（短回合写放大 / dirty>100 flush / `appendFileSync` 跨平台）。

### P3 · flush 写放大 ×800–975 治理（增量 delta + index 追加 + dirty 节点）

- `graph.json.delta.jsonl`：每步只追加 dirty 节点/边（绝对 upsert）+ 标量 + order 追加；
  合并阈值 `max(64KB, 基线 20%)`，超过则写新基线（`tmp` → `rename`）并清空 delta
- 崩溃安全：帧带 `baseHash`（generation 保护，基线重写后旧帧整体忽略）+ `checksum31`
  （半写帧就地停止并截断到最后一个好帧）+ 幂等重放（同一批帧重放多次结果相同）
- `index.md` 稳态**追加**增量段（~200–800 B/次），fold / 首次 / 缺失 / >256KB 时全量重建；
  `nodes/*.md` 稳态不写，只记 pending，fold 时只写 dirty
- 实测（三张真实图 × 60 步 + 1 回合边界）：写放大 **×80.16 / ×70.04 / ×61.75 → ×37.41 / ×33.31 / ×30.75**；
  稳态每步写 **10.5–11.8 KB → 591–713 B（−94%）**；fold 后 flush **429–836 ms → 9.4–22.9 ms**
  （5–20 个 dirty 节点）/ **76.5–88.8 ms**（100 个）
- 测试：`test/persist-incremental.test.mjs` **8 项**（重放等价 / 幂等 / 半写帧 / generation 保护 /
  index 增量 / engine 端到端 / nodes dirty）
- 已知边界：**极短回合（<10 步）** 每回合的全量基线摊销不足，写放大仍可能 >×50；
  `appendFileSync` 跨平台原子性未验证

### P4 · 首屏 `state` 的 graph.json 解析缓存

- `src/ui.mjs` 新增 `(绝对路径, mtimeMs, size) → 聚合摘要` 缓存 + `pruneGraphCache()`：
  改文件必失效（同 mtime 但 size 不同也失效）
- 133 图 / 33 MB 实测：热路径 p50 **140.5 ms → 20.9 ms**（另一轮 **242.5 → 51.1**）；
  冷路径也更快（**170.7 → 101.3** / **386.4 → 196.7**）；`state` 响应 **3,648 B 逐字相同**
- 测试：`test/ui-perf.test.mjs` **10 项**

### P5 · 生产口径 token 预算与 `pickFallback`

- `renderLedger` 新增 `fallback` 三态（`none` / `over-budget` / `impossible`）+ `overBudgetBy`：
  **不再静默返回超预算文本** —— 调用方拿到的每个结果都能区分「预算内 / 兜底超限 / 无解」
- `pickFallback` 择优顺序固定：预算内优先 → tokens 最小 → 平手列得多；全超选最省并标 `over-budget`；
  无非空文本返回 `null`（`impossible`）
- 生产口径（`treeDir` = 真实会话目录、`maxTokens=500`，133 图）：
  **>500 = 24/133（与 1.9.1 HEAD 的 24 相同，新增 0）**、avg **444.80**（HEAD 430.85，+13.95 ≤ +20）、
  max **905**（与 HEAD 完全相同）。24 张全部是 L4/L5 兜底档 —— 正文本身 >1500 字符，不是预算记账 bug
- 测试：`test/ledger-budget.test.mjs` **7 项**

### P6a · `TRACE:` 行绝对路径改相对，回收 avg +17 tok/图

- `TRACE:` 从 `D:\DeepSeek Harness\home\chess-context\sessions\<sid>/index.md …`（137.7 字符）
  改成 `sessions/<sid>/index.md`（57.5 字符），`traceRoot` 可配置（默认无前缀，生产传 `sessions`）
- 生产口径 133 图：avg **445.08 → 429.64（−15.44 tok/图）**；over500 **24 → 18**；max **905 → 878**；
  逐会话 85 便宜 / 7 变贵（5 个是 TRACE 变短后落进更低档位、列了更多内容）/ 41 不变；
  `renderFacts` **133 图 0 差异**
- 测试：`test/trace-relative.test.mjs` **7 项**（Windows 盘符 / POSIX 用户名路径 / traceRoot 可配置 / 不泄漏绝对路径 …）

### P6-A · 悬空边只在分析中排除（不剪数据）

- 新增 `classifyDangling()`（`residue` / `live-unsettled` / `from-broken` / `none`）与 `danglingStats()`；
  **只过滤显示，不改 `graph.json`**
- 判定：`residue := to==null && age>10min`；**`live_unsettled`（untested 且 ≤10 分钟）必须保留可见**
  —— 这是 Lead 批准的**更保守**口径（keeper 先 settle 结果、`step/end` 才回填 `to`，
  按字面公式会把刚结算的新鲜失败当场隐藏）
- `from` 悬空 **214 条**（全在 `5acafe42`，`mergeNodeInto` 老 bug）单独标记，不混入 `to=null` residue
- 实测（133 图）：热清单**无终点失败边 158 → 0**；avg **−18.98**；over500 **17 → 17**；max **878 → 878**；
  全库 `residue 5,566 / liveUnsettled 1 / fromBroken 214`
- `renderFacts` **仍列全部失败边**（失败记忆不丢），新增 `DANGLING_RESIDUE: N` / `FROM_DANGLING: 214` /
  `LIVE_UNSETTLED: N` 显式计数
- 测试：`test/dangling-exclusion.test.mjs` **8 项**

### P7 · `fallback` 与 `traceRoot` 接进 engine / doctor（不留死开关）

- `src/engine.mjs`：新增配置 `hotLedgerTraceRoot`（schema 默认 `"sessions"`），生产 `renderLedger` 调用传
  `traceRoot: "sessions"` ⇒ 生产热清单 `TRACE:` 为 `sessions/<sid>/index.md`，不泄漏盘符/用户名
- engine **消费** `fallback`：`over-budget` → warn 日志含 `overBudgetBy=` / `budget=`；
  `impossible` → error；`ledgerBudgetMetrics` 累计并原子落盘 `<graphDir>/ledger-budget.json`；
  提供 `getLedgerBudgetStats()` / `onLedgerBudget` 钩子（可测，不静默）
- `scripts/doctor.mjs`：新增「热清单预算（fallback）」项，显示 `none / over-budget / impossible` 分布与
  `maxOverBudgetBy`；字段缺失写「未采集」；`impossible > 0` 记 error
- 测试：`test/engine-harness.test.mjs` 增至 **25 项**（+4 条 P7 接线用例）

### S2b · `no-exit` 弱成功按 N1 收窄

- `verifier.classify()` 的 shell 分支：`[exit code]` 存在时行为不变；**无退出码时默认给 `weak:"shell"`**，
  命中 N1 任一规则则不给。`result` **永远是 `unverified`**（不进已验证事实）
- N1 八条 veto 规则集中在 `SHELL_WEAK_VETO_RULES` 一处（id + 说明 + 正则）：末行自报非零 / 末行 `Node.js vX` /
  尾部 node 栈迹 / `command not found`·`No such file`·`cannot stat` / 行首 `SyntaxError|AssertionError|…` /
  `FAILED (failures=N)` 等；规则表可测试、可追溯
- 真实采样：全标 weak 的误报率 **2.94% → 收窄后约 0.49%**（≈48/9762 条假进展）
- 测试：`test/weak-shell.test.mjs` **13 项**（每条规则命中/不命中 + 旧图兼容 + renderFacts 不变 + 变异自检）

### 测试

- `node test/run.mjs`：**373 passed / 0 failed**（30 个测试文件，`EXIT 0`；2026-10-30 03:2x 实测）
- 新增测试文件：`persist-incremental`(8) · `ui-perf`(10) · `ledger-budget`(7) · `trace-relative`(7) ·
  `dangling-exclusion`(8) · `weak-shell`(13)；`engine-harness` 21 → **25**

## 1.9.1 — 2026-10-29


### 修图坍缩：全库 61.3% 的边是自环（三份独立评估共同指向）

事故：`worldstate.touch(paths)` 收到的是**单个路径字符串**（`engine.mjs` 的
`st.touchPath = (p) => world.touch(p)`），却按可迭代对象遍历 ⇒ 一个路径被拆成逐字符的
20 多个「路径」⇒ 触碰集合是十来个字符 ⇒ `hash()` 对所有会话、所有步骤返回**同一个哈希**
⇒ `addAgentNode` 每步命中同一 `stateIndex` 节点 ⇒ `step/end` 把边的 `to` 指回 `from`。

实测：全库 **6,172 / 10,059 = 61.3%** 自环，边/节点 3.36，极端会话 530 边 / 23 节点。
连锁后果：`tewariAnalysis` 的同终点判定恒真 ⇒ **`dead` 判定 109/109 全错**、
`redundant` 135 条全假 ⇒ 热清单告诉模型「这条路永远别试」，真相只是「同一步里另一条命令成功了」。

四处修复：
- `worldstate.touch()`：兼容 string / array 入参，单字符丢弃
- `addAgentNode()`：置换命中**本步起点**时强制新建节点（真正的置换——回到更早状态——照旧复用）
- `tewariAnalysis()`：自环边不入手割；自环成功边不算替代路径
- `failureClass()`：`edge.to !== edge.from` 才能判 `dead`

### 修两个真 bug（评估中发现）

- **fold 后 `nodes/*.md` 从不刷新**：`#flush(session, { md: true })` 的键名写错（签名是 `tree`）
- **摘要上限三处默认互相矛盾**：Config 4096 / resolveChess 2048 / 安装配置 8192 ⇒ 统一 8192
  （3072~4096 在真实会话里会贴边触发 `MAX_TOKENS`，历史 82 次）

### 压缩失败不再静默

- 连续失败计数进热清单：`⚠ CONTEXT COMPRESSION IS FAILING (N consecutive folds failed; last error: …)`，
  成功一次即清零。此前只写 `logger.warn`，实测 856 次失败 / 5.5 小时无人知晓。

### 诊断与清理工具

- `graphHealth(g)`（`src/graph.mjs`）：自环数 / 自环率 / 边节点比
- `doctor`：新增「图结构（自环）」一项
- `verify-graphs`：报告图健康度，自环 ≥5% 标 ⚠
- `test/rewash-selfloop.mjs`：清洗历史自环边（保留边与结果，只把 `to` 置 null），dry-run 默认、带备份
- 已对全库执行：自环 **6,172 → 0**，坍缩图 **42 → 0**

### 只读工具的「成功」只进 WORKING，不进已验证事实（S2a）

根因：`read` / `grep` / `glob` 这类只读工具执行成功，只能说明「读到了」，不能说明「任务往前走了」。
旧实现把它一律计为 `unverified` ⇒ 纯只读会话的热清单里**没有 WORKING 路径**（实测 106 个会话里
只有 21 张图能渲染出 WORKING），模型看不到「我刚才走到哪」。

- `verifier.classify()`：只读类工具（`read` / `mcp-read`）+ 输出非空 + 无任何失败信号 ⇒ 额外给
  `weak: "read"`，**`result` 仍是 `unverified`**（不改既有语义，避免 `failureEdges` / `openEdges` /
  `tewari` 的判定漂移）
- keeper 落账 `edge.weak`；`renderLedger` **只在没有强 success 锚点时才**用弱边建 WORKING，
  渲染时标 `[weak k/n]` + 图例；旧图按 settle 时已写的 `verify.kind === "read"` 识别
- `renderFacts` 的 `UNVERIFIED_CLAIMS` 段**继续列**这些边 —— 弱成功不会被当成已验证事实
- 实测（活库 106 会话）：有 WORKING 的会话 **21 → 39**（+18，回退 0、既有行变化 0）；
  日志回放 106 份：**25 → 44**（+19，丢失 0）；`dead` / `redundant` / `longer` 增量 **0**；
  `renderFacts` 逐字不同 **0**；热清单仍 ≤500 tokens

### 可选严格不变量门禁 + 历史图豁免（S1a / S1c / C-13）

- `test/graph-invariants.mjs`（新）：纯判定层，四条判据 —— `degenerate-graph`（节点 0 但有边）、
  `self-loop`（`from === to`）、`edge-per-node`（默认 >8）、`collapsed-graph`（自环率 ≥5%）
- `test/verify-graphs.mjs` 增 `--strict` 与三个阈值参数（`--max-self-loops` / `--max-edge-per-node` /
  `--max-self-loop-rate`）。**默认模式（无参 / `<目录>` / `--json`）一行代码都没改行为**：
  实测用 HEAD 版本与本版对同一份冻结夹具（132 张 `graph.json`）跑文本与 JSON 两种默认模式，
  **stdout / stderr 逐字节一致（`cmp` 无差异）、退出码一致**
- 为什么不设默认门禁：全库 `--strict` 下 **15 / 132 张图红** —— 2 张历史自环坍缩图
  （`session-1331683e…` 509/628 = 81.1%、`session-69dd787e…` 115/153 = 75.2%）+ 13 张旧版节点
  冻结造成的高 ratio（13 张全部 >8，最高 530 边 / 23 节点 = **23.04**）。这 13 张不可修（`to` 不可知、节点冻结不可逆），
  设默认会永久红 ⇒ 保留阈值 8、`--strict` 保持可选
- `test/graph-exemptions.mjs`（新）+ `test/fixtures/history-exemptions.json`：**显式、可审计、可过期的
  历史违规豁免清单**（C-13），只在 `--strict --exemptions=<文件>` 下生效。每条记录
  `sessionId` / 判据代号 / `E,N,L` 数值 / 理由 / 登记人 / 登记日期 / 有效期 / 指纹（由该图
  node+edge 全字段派生的 sha256）
  - **精确而非宽松**：一条豁免只吸收「同一张图 + 同一判据 + 同一组数值 + 同一指纹」。
    同一张图的 ratio 继续增长、或新加一条自环 ⇒ **照样红**
  - **豁免 ≠ 通过**：被豁免的 17 条逐条打印（⊘ 带登记值与理由），并单独报告
    「豁免前 N 张违规 → 豁免后 M 张」
  - **实测**（同上冻结夹具）：`--strict` 15 张红 →加 `--exemptions` 后 **0 张红、退出码 0**
    （17 条违规被已登记条目吸收）
  - 到期日（默认 2027-06-30）过后自动失效恢复判红，且不是静默的 —— 输出会打「已过期 N 条」
- 测试：`test/graph-invariants.test.mjs` 31 项（含 CLI 端到端退出码、逐图 ✓/✗ 与退出码同口径）；
  C-13 另有已登记图绿 / 未登记坏图红 / 数值变化仍红 / 部分豁免 / 空清单 / 清单格式错误 / 过期失效等用例

### 安装判据统一 + 打包后 `doctor` 真的能跑（S10a / B3）

- `scripts/link-path.mjs`（新）：`link:` / `file:` 依赖规格的**唯一**判据来源 —— `parseSpec` /
  `resolveSpecPath` / `samePath`（Windows 大小写不敏感）/ `statLink`（区分「没有 / 断链 / 指向别处」，
  不用 `existsSync`）/ `inspectProfileInstall` / `createDirLink`（Node junction，免 shell 引号，
  中文与空格安全）/ `removeDirLink`（只删链接，真目录拒删）
- `scripts/install.mjs` 改用它：断链与「指向别处」的 junction 会重建，不再「存在即跳过」；
  `mklink` 兜底实测中文 + 空格路径可用
- `test/verify-install.mjs` 修掉「读不到 package.json」式假绿：目标目录不存在时说「目标目录不存在」，
  不再给误导性措辞
- 🔴 **`doctor` 从 `test/doctor.mjs` 迁到 `scripts/doctor.mjs`**：`test/` 不在 `files` 里 ⇒
  1.9.0 及更早从 npm 装的用户跑 `npx dsh-gokifu-compact doctor` 会 **ENOENT**（README 的安装第 3 步
  就是这条命令）。1.9.1 起 doctor 与 `cli.mjs` 同在 `scripts/`，随包发布
- `test/install-link.test.mjs`（新）29 项，含 4 组变异自检（判据退回字符串比较 / 安装器退回
  「键在就跳过」/ junction 退回「存在即跳过」/ 入口判据退回字符串比较，各自必须变红）

### 安装验证的诊断措辞、占位红与入口判据（S10c / S10e / C-12）

- `test/verify-install.mjs`：目标目录不存在 / `package.json` 缺失 / 坏 JSON / 没有 `name` **各给各的措辞**，
  不再一律写「读不到 package.json」（实测：坏状态的根因是 `link:` 指向的目录不存在，
  旧文案会把人引到错的排查方向）。`manifestError` 现在进 ✗ 详情
- 检查项总数**恒为 16**：`profile/package.json` 缺失时补 5 条占位红（首条带路径）、`preset` 缺失时补
  4 条占位红 —— 缺文件不再让总数缩水（缩水等于悄悄少查）
- `test/ab-render.mjs` 的入口判据改成 `fileURLToPath` + `realpath` 等价判定：
  旧判据「`import.meta.url` 结尾等于 basename」在**非 ASCII 文件名**下静默不执行（exit 0、零输出 = 假绿），
  新判据对等价路径 / Windows 大小写 / junction / 非 ASCII 都判真，被 import 时零副作用
- `scripts/link-path.mjs` 与 `test/verify-install.mjs` 补末尾换行（`wc -l == awk NR`）
- 测试：`test/ws-install.test.mjs` **13 项**（S10c-1..5 / S10e-1..3 / C-12-1..5），16 个变异体自证不是假绿

### 版本号在中文路径下读成 `v?`（S10′）

`src/ui.mjs` 的 `HERE` 用 `new URL(import.meta.url).pathname` —— 得到的是**百分号编码串**
（`/D:/%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/…`），Windows 上交给 `readFileSync` 直接 ENOENT，
被 `readVersion()` 的 `catch` 吞成 `null` ⇒ 页面标题渲染成 `v?`。改用 `fileURLToPath`（Node 官方解码入口，
空格 `%20`、中文、`%7E` 一并还原）。测试用**派生值**而不是字面量：
① 当前真实中文路径读到的版本 === `package.json` 的 `version`；② 模块搬到「空格 + 非 ASCII」目录后读到的是那份
`package.json`；③ `fileURLToPath` 能还原、`pathname` 直读必失败（附 ASCII 对照组，证明断言不是常量）；
④ `package.json` 缺失时仍返回 `null`（保留既有容错接口）。`test/version-path.test.mjs` 4 项

### `/gokifu/api` 同源校验与备份轮转（A1 / A2 · 安全）

审计实测的原始缺陷：`/gokifu/api` 接受**跨站** `text/plain` POST —— `Origin: http://evil.example`
+ `content-type: text/plain` 得到 **200 且 preset 被改写**（`text/plain` 属 CORS 简单请求，
不触发预检，`OPTIONS` 上不返 `Access-Control-Allow-Origin` 挡不住写）。M2 的密钥字段一落地，
这条就升级成「任意网页可换掉你的摘要模型密钥」。

三段校验（全部在 `readBody` **之前**）：

| # | 规则 | 为什么是这条 |
|---|---|---|
| ① | `Host` 必须存在、合法、且为回环（`127/8` / `::1` / `localhost` / `*.localhost`） | 防 DNS rebinding —— 那种情况下 `Origin == Host == evil.example` 也自洽，只比同源挡不住。`webServer` 绑 `0.0.0.0` 时自动放开，其它非回环主机走 `DSH_GOKIFU_ALLOWED_HOSTS` 显式放行 |
| ② | 带 `Origin` ⇒ 必须与 `Host` 同协议 + 同主机 + 同端口 | 浏览器 POST 必带 `Origin` |
| ③ | 带 `Sec-Fetch-Site` ⇒ 只允许 `same-origin` / `none`，**`same-site` 也拒** | 实测本机 `127.0.0.1:19401 → 127.0.0.1:19400` 的来源报的是 `same-site` 而不是 `cross-site`，只拒 `cross-site` 会漏 |
| ④ | `content-type` 必须是 `application/json`（允许 `; charset=`） | HTML 表单发不出 JSON ⇒ 非 JSON 一律 415 |
| ⑤ | **缺 `Origin` ⇒ 允许，但 `Host` 必须回环** | 浏览器对 POST 一定带 `Origin`，缺它只可能是 curl / node / 本项目测试；这条是回归护栏，不能把本机工具一起拒掉 |

- 备份轮转：每个 preset 最多保留 **5** 份 `.bak-before-ui-<ms>`，超出的删最旧的；同毫秒多次保存用
  `-2`/`-3` 后缀防覆盖
- 密钥守卫：新配置块里出现密钥（键名以 `key`/`secret`/`password`/`credential`/`token` 结尾，或值形如
  `sk-…`/`ghp_…`/PEM 私钥头）**直接抛错不落盘**；源文件原本就有密钥时**跳过备份**并返回
  `backupSkipped`（否则每个备份都是明文副本）。密钥识别只回**键名**，绝不回值
- 测试：`test/ui-security.test.mjs` 25 项 —— 跨站 `text/plain` / 外站 `Origin` / `Origin: null` /
  同 IP 异端口（`same-site`）/ DNS rebinding 形状 / 缺 Host / 非 JSON content-type 全部 403 或 415 且
  preset 一字不变；同源浏览器请求与无 Origin 的本机调用仍 200（防止把功能改坏）
- ⚠ **已上线的 DSH 进程没有重启，跑着的仍是旧代码** —— 本修复要在重启后才生效

### 性能：热清单渲染与三层树渲染的索引化（P1 / P2）

**P1 · `tewariAnalysis` 记忆化 + transposition 索引化**（`src/graph.mjs`、`src/ledger.mjs`）

热清单渲染的热点在 `tewariAnalysis`：一次 `renderLedger` 会在每个档位各算一遍手割，全库一轮调用
3,523 次而必要只有约 800 次；置换提示对每条路径做 `Object.values(g.edges).some(...)`，是 O(path×E)。
「无缓存」的代价实测是 **234ms/次**（`session-c328440a`，158 节点路径）。

- 每张图维护 `tewariIndex`（`byFrom` 邻接表 + 每节点可达集 + 失败边结论缓存），挂在 WeakMap / 非枚举
  Symbol 上，**不进 `graph.json`**；缓存键 = 结构修订号 + `updatedAt` + 边/节点数 + `to`/`from` 数字和
  （数字和专门兜住「同毫秒两次 settle」与「绕过 bump 直接改边」两种撞键）
- 旧实现把同一份「baseline 可达集 BFS」在两处各算一遍 → 合并成一次
- 置换提示改成预建 `Set`（`from>to`），`has()` 取代全表扫描

实测（133 张真实图）：`renderLedger` / `renderFacts` 输出**逐字节相同**；全库一轮渲染
**487.4ms → 70.5ms（6.9×）**，最差单图 **150.82ms → 8.99ms（16.8×）**；tewari 调用
**3,523 → 804（−77%）**。新增 `test/tewari-perf.test.mjs` 7 项（含「关掉记忆化必须退化」变异自检）。

**P2 · `renderIndexMd` / `renderNodeMd` 的 O(N×E) 索引化**（`src/graph.mjs`）

三层树的 index/node md 每次 debounce flush 都要重写：`renderIndexMd` 每轮 BFS 都 `Object.values(g.edges)`
全表扫，`renderNodeMd` 每个节点各做一次入边/出边全表 filter —— 节点数一多就是 O(N×E)。
5000 边合成图上 `renderIndexMd` 要 **3,506.8ms**、`renderNodeMd` 要 **7,208ms**。

- `graphIndex(g)` 增加 `byTo`（入边表）；`renderIndexMd` 的 BFS / 根判定 / 出边查询与 `renderNodeMd` 的
  入出边查询全部走 `byFrom` / `byTo`；`renderNodeMd` 每次调用只取一次索引
- `renderIndex(g)` 用便宜键（`rev|updatedAt|nextEdge|order.length`）判缓存，不命中才算完整结构签名
  （否则逐节点调用会把 O(E) 签名乘 N 次：5000 边实测会从 6.4ms 退化到 14.9s）

实测：133 张真实图输出**逐字节不变**（index **133/133**、node md **7,843/7,843**）；真实最大图
**49.39ms → 0.54ms（91×）** / **51.46ms → 0.60ms（86×）**；5000 边合成图 **3,506.8ms → 4.26ms（823×）** /
**7,208ms → 6.37ms（1,132×）**。新增 `test/render-index-perf.test.mjs` 6 项。

> 两项都不改任何输出文本 —— 这是硬验收：性能优化若改变了模型看到的热清单，就不是优化。

### 测试

- 新增 `test/selfloop.test.mjs`（8 项）+ `engine-harness` 端到端 1 项（自环回归）
- 新增测试文件与项数：
  `test/weak-success.test.mjs`（22 · S2a）、`test/graph-invariants.test.mjs`（31 · S1a）、
  `test/install-link.test.mjs`（29 · S10a）、`test/ws-install.test.mjs`（13 · S10c/S10e/C-12）、
  `test/version-path.test.mjs`（4 · S10′）、`test/c17-path-at-every-level.test.mjs`（15 · C17）、
  `test/graph-exemptions.test.mjs`（12 · C-13）、`test/ui-security.test.mjs`（25 · A1/A2）、
  `test/ui-config.test.mjs`（13 · 配置写入正确性）、`test/tewari-perf.test.mjs`（7 · P1）、
  `test/render-index-perf.test.mjs`（6 · P2）
- `test/run.mjs`：**316 passed / 0 failed**（24 个测试文件，`EXIT 0`；2026-10-30 02:31 实测）
- 之前的 125 项无一覆盖 `from === to` —— 这正是这个回归能躲过所有自测的原因

## 1.9.0 — 2026-10-29

### 「上下文压缩」详情页（DSH 原生 GUI 里的第三方插件页）

左侧栏「插件 / 自动化任务」那一列新增一条 **上下文压缩**，点开是整页（与「自动化任务」同一套
`sidebar.panellist` + `main` 槽位，来自 asar 里的 `dsh-client-ui-schedule` 实现）。

**页面内容（MVP）**
- 状态：最近活跃会话（fold 后总量 / fold 次数 / 失败边 / 节点数 / 上次遮蔽）、今天汇总
  （fold 次数 / 会话数 / 合计遮蔽 / 全库失败边）、上次摘要真实 usage（含 provider/model）
- 参数（15 项）：自动压缩、触发阈值、增长闸、逐字保留、最小 fold 量、摘要方式、输出上限、
  热清单开关/预算/标记档/就地替换、置换检测、checkpoint 合并阈值、摘要 provider/model
- 操作：保存（写 preset + 自动备份，提示重启生效）、恢复默认、刷新；未保存改动会列出键名
- 只读展示配置来源路径

**结构（为什么这么切）**
- 包根 `dsh-gokifu-compact` = UI host 半（`src/ui.mjs`，注册 `POST /gokifu/api`），
  引擎挪到 `dsh-gokifu-compact/engine` —— 因为 `dsh-client-modules` 只对**包根说明符**做客户端发现，
  子路径条目不会加载 `dsh.client`
- 浏览器半 `lib/client.js`：`window.__ModuleLoader__.load` 形状、只 `require("react")`、
  数据全走 host 路由（不用 Typert —— 那是 DSH 构建期生成的，第三方拿不到）
- 安装器新增两步：preset 引擎名迁移（`dsh-gokifu-compact` → `/engine`）+ profile 的
  `cordis.patch.yml` 挂 `gokifu-ui`（都带备份、幂等）

### 测试

125 项全绿（新增 6 项 UI 测试：块解析/渲染回环、sanitizePatch 拦非法值、saveConfig 写盘+备份+
同值不重写、客户端 bundle 的 `__ModuleLoader__` 形状与两个 slot 注册、`POST /gokifu/api` 的
state/save/未知 action）

## 1.8.1 — 2026-10-29

### doctor：一天的 fold 收益一眼可见

- 新增「今天 fold 的总量」：`N 次（M 个会话）· 合计遮蔽 X tokens` —— 数据来自各会话棋谱的
  `foldMarks`（按 fold 发生的 `at` 过滤，不按文件 mtime），不用翻会话日志
- 实测（2026-10-29）：今天 26 次 fold / 12 个会话 / 遮蔽 **2,304,388 tokens**；重启后 **0 失败**
- 「上次 fold 的成本」继续显示真实 usage（含 provider 缓存字段：一次缓存命中的 fold 只有
  5,329 新输入 + 647,168 缓存读，冷启动那次则是 629,184 全新输入）

## 1.8.0 — 2026-10-29

### 配置 id 统一 + 安装改成「两条命令、不用手改 YAML」

- **配置项 id 改名**：preset 里的 `- id: chess-context` → `- id: gokifu-compact`，
  与展示名 `dsh-GOkifu-compact` 对齐（注入消息的 `source.kind` 仍是 `chess-context` ——
  那是跨版本的数据契约，改了会让历史会话里的旧清单认不出来）
- **新增 CLI**：`dsh-gokifu-compact install | revert | doctor`
  - `install` 自动找 profile/preset，把 preset 的 compaction group 里
    `@deepseek-ai/dsh-compaction-basic` 那一行换成 `dsh-gokifu-compact`；
    带备份（`.bak-before-gokifu-*`）、幂等、`--dry-run`、旧 id 自动纠偏
  - `revert` 恢复最近一次备份；`doctor` 转发体检
  - 逻辑只有一份（`scripts/install.mjs`），`test/install.mjs` 变成薄封装
- **不再声明 `dsh.bundle`**：本插件是「agent preset 内的压缩后端」，不是 profile 级 bundle。
  声明 bundle 会让 `dsh plugin add` 把它塞进 `dsh.profile.bundles`，于是顶层再挂一份，
  与 preset 内那份形成双实例（`ctx.compaction` 只能注册一次 ⇒ 构造期抛错）
- preset 示例默认写 `auto: true`：关掉原生 `compaction-basic` 不影响自动压缩 ——
  本插件继承同一个 `BasicCompactionEngine`（同一套 between-step 压力触发与 context-overflow 兜底），
  换的只是「压缩范围 = 上一个 checkpoint 之后」和「失败记忆逐字保留」
- `doctor` 新增两项检查：压缩后端已接管 / 原生已让位
- README 安装段重写为两步命令；新增 FAQ「关掉原生压缩，自动压缩还在吗？」

### 真机首折实测 + 三处收尾修复

- **GUI 里第一次真实 fold 成功**（重启后第一轮触发，`session-e16faf2b`）：
  遮蔽 seq 9–3167 / **440,847 tok** → 摘要 2 块 4.2K 字符（输入 629,184 / 输出 2,902 tok，`magpie/group/deepseek-v4.1-flash1017`）；
  surface 节点 1391 → 373，对话消息从 ~574K 降到 ~157K（面板 81% → 约 16%），热清单仍只有 1 条（就地替换生效）
- **修 `graph.checkpointSeq` 记错**：原来写「被遮蔽区间起点」（fold 后已不在 surface 上，实机一直是 9），
  改成写「checkpoint 消息的 seq」
- **`doctor` 三处改进**：压缩统计改 **1 小时窗口 + 最近成功/失败时间**（历史失败不再吓人，
  判定看「最新一条是不是成功」）；新增「上次 fold 的成本（真实 usage）」；树新鲜度支持批量修复
- **`test/build-tree.mjs --all`**：一次性重建所有 index.md 落后于 graph.json 的会话（本次修了 48 个 / 1760 个节点文件）
- **摘要输出上限抬高**：`maxTokens` 默认 2048 → 4096，preset 3072 → **8192** ——
  实测一次 fold 用掉 2,902 tok，3072 太贴边，触顶会 MAX_TOKENS 截断（截断 = fold 失败）
- **`graph.lastFoldUsage`**：每次 fold 的真实 usage（输入/输出/provider/model/时间）写进棋谱，计费对账不必再翻会话日志；
  `doctor` 对新旧图都能显示（旧图没有该字段时从会话日志的 `compaction/summary` 事件兜底）

### 测试

118 项单测全绿 · `verify-install` 13 项全过（含 isolate group 内仍是我们的引擎行）

## 1.7.1 — 2026-10-29

### 发布后收尾

- 维护检查 `scripts/check-maintenance.mjs` 适配本仓库：`evidence/`（测量数据，每跑一次 bench/measure 都会变）
  与 `test/.harness/`（测试产物）不再算「代码改动」—— 否则每跑一次基准都要求 bump 一次版本
- HANDOFF / README 写入发布信息（npm `dsh-gokifu-compact@1.7.0`、Release v1.7.0、安装命令）

## 1.7.0 — 2026-10-29

> 起因：自 v1.3.4 起累计 9 个版本未发布；本版是首个公开发布，汇总 1.3.5–1.6.3 的全部改动，
> 并把展示名统一为 `dsh-GOkifu-compact`（前缀小写、只有 GO 大写）。

### 首个公开发布（汇总 1.3.5 – 1.6.3）

**P0 修复：压缩 226 次只成功 3 次的根因**
- `worldHash` 类型契约（对象 → 字符串）+ `fromJSON` 加载边界自愈历史脏数据 + `stateIndex` 重建
- 实机 `session-5acafe42`：139 次 `worldHash?.slice is not a function`、223/226 次压缩失败；修后全库 1,279 个对象字段归零

**热清单（给模型看的那一小块）**
- 标记自带语义：`blocked:permission` / `dead retry-if:<edge>`；图例按用到的标记动态生成（出现即解释）
- 报错原文任何档位都不丢；手割多参照点（同一失败边相对每条成功路径分别结论）
- **清单就地替换**：surface 上永远只有一条（旧版累积过 176 条 / 81 万字符 ≈ 27 万 token）
- 历史清单一次性换成一行占位；2000 边渲染 0.478 ms / 323 tokens

**压缩本身**
- 增量 fold（只压 checkpoint 之后）+ 机械约束段
- 摘要三层降级：配置模型 → 路由模型 → 规则摘要（压缩永不因摘要模型挂掉而失败）
- 真实 dsh 进程里 fold 3~6 次全成功（`test/real-headless-fold.mjs`）

**工具与维护**
- `test/doctor.mjs` 体检、`test/measure-billing.mjs` 真实计费审计、`test/rewash-graph.mjs` 历史回洗、
  `test/verify-graphs.mjs` 全库健康、`test/ab-render.mjs` 标记 A/B 夹具
- 仓库维护照搬 `magpie-plugin-scaffold`：`scripts/check-maintenance.mjs` + `scripts/release.mjs`

### 展示名

- `DSH-GOkifu-compact` → **`dsh-GOkifu-compact`**（前缀小写、只有 GO 大写；包名仍为 `dsh-gokifu-compact`）
- GitHub 仓库同步改名：`MYCF711/dsh-GOkifu-compact`
- 修正 `cordis.patch.yml` 里写错的包名（`dsh-chess-context` → `dsh-gokifu-compact`）

### 测试

118 项单测全绿 + 真实包验证 8/8 + 真实进程 fold 3~6/6

## 1.6.3 — 2026-10-29

### 真实 DSH 进程里的首次 fold + 修掉「rules 模式从未成功过」的真 bug

**新增 `test/real-headless-fold.mjs`**：起一个**真正的 dsh headless 进程**（独立 profile + overlay，
阈值压到 0.002 触发），跑迷你任务并核对 `compaction/*` 与 checkpoint —— 真 Session、真 compactRegion、
真 surface 替换。实测 **3~5 次 fold 全成功、0 失败**（`evidence/真实进程首次fold.md`）。

**抓到的真 bug**：第一次跑时 7 次 fold 全报
`session event "compaction/summary" carries non-JSON-serializable data` ——
官方 `commitCompactionBody()` 把 `summarize()` 返回的 `provider`/`model` **不判空**写进事件，
而规则摘要（`summaryMode: rules` 与「摘要模型全挂」的兜底）没带这两个字段 ⇒ `provider: undefined` ⇒
真实 Session 的 JSON 校验拒绝。**`summaryMode: rules` 在真实 DSH 里从未成功过**（假 Session 不校验，
桌面 preset 又用 hybrid，所以一直没暴露）。
修法：所有 summarize() 返回路径都带 provider/model 字符串（规则摘要用当前路由做记账口径，
没有路由用 `chess-context`/`rules` 哨兵）。+harness 断言。

### 测试

118 项单测 + 真实进程 fold 测试（3 次成功 / 0 失败）

## 1.6.2 — 2026-10-29

### 压缩永不因摘要模型挂掉而失败（hybrid ⇒ 规则摘要兜底）+ doctor 体检

**规则摘要兜底**：`summarize()` 现在三层降级：
① 配置的摘要模型 → ② 失败就退回「当前路由模型」重试一次（v1.5.1）→ ③ 还不行且 `summaryMode=hybrid`
就**退回规则摘要（零模型调用）**，fold 必须能落地。压缩失败 = 上下文只增不减，比摘要质量下降严重得多。
`summaryMode=llm` 不降级（用户明确要模型输出）。+2 harness 用例。

**doctor**：新工具 `node test/doctor.mjs` —— 一条命令体检：安装态 / 摘要模型是否在 provider 模型表里 /
最近压缩成败与错误 / 棋谱健康 / 树新鲜度。本轮实机 131 次压缩失败就是它抓出来的
（配置里 `magpie/ima/deepseek-v4.1-flash` 不在 provider 模型表）。

### 测试

118 项全绿

## 1.6.1 — 2026-10-29

### index.md 每次落盘都刷新（它是模型读的入口）

盲测里子代理当场发现  落后于 （350 边/17 失败 vs 447 边/23 失败）——
因为旧版只在「首次 flush / fold 后」写树。现在 **每次 flush 重写 index.md**（单文件；2000 边实测
renderIndexMd 3.27ms + 写盘 0.65ms，debounce 后每 1.2s 最多一次）， 仍只在首次/fold 后写
（2000 个文件不能每步来一遍）。+1 harness 用例。

### 测试

116 项全绿

## 1.6.0 — 2026-10-29

### goal ③④⑤ 三件收尾

**③ `[dead]` 不再是一块永久墓碑**：标记直接从 tewari 参照点取锚点 ——
`dead retry-if:e384+1`（那条成功边不通了就回头重试）；图例同步；
`blocked:missing-resource` 的图例改成「等它出现，**或者把它创建出来**」。

**⑤ 热清单指向**真的**三层树**：旧省略行写的是 `graph.md`，而它从 v1.2.2 起就不再自动写了（死指针）。
现在引擎把会话树目录传进渲染器，输出 `TRACE: <sessions>/<sid>/index.md (per-node detail: nodes/<id>.md)`。
**盲测 2/2**：两个隔离子代理（只给清单、不提读文件）都自己读了 index.md / graph.json / nodes/*.md，
并把清单里被省略的 13 条失败做法逐条重建；其中一个还发现 index.md 已过期、改用 graph.json 作权威。

**④ 历史误报回洗**：新工具 `test/rewash-graph.mjs`（dry-run 默认、写前备份、会话在写则拒绝、证据对齐校验）。
对 `session-5acafe42` 执行 `--apply`：failure 边 101 → **71**，`text` 型误报 43 → **8**（剩下 8 条证据对不上，保守不动），
其中 4 条改判 `hard-error`（原文确有错误）、30 条降级 `unverified`；35 条留 `rewashed` 审计字段；树已重建。

证据：`evidence/收尾三件-dead锚点-树读取-回洗.md`

### 测试

115 项全绿（+4 errorSnippet 回归、+2 标记契约）

## 1.5.1 — 2026-10-29

### 真实计费核对 + 摘要模型失效兜底（实机数据驱动）

**1. 真实计费核对（`evidence/真实计费核对.md`）** —— 用会话日志里每次请求的真实 usage 拆账：

| 会话 | 请求 | prompt tokens | 缓存命中率 | 清单占 prompt | 其中陈旧副本 |
|---|---:|---:|---:|---:|---:|
| session-5acafe42 | 653 | 258,330,390 | 94.5% | **21.3%** | **54.4M token** |
| session-5787ac6b | 429 | 194,031,958 | 94.7% | 2.7% | 5.1M |
| session-e16faf2b（当前） | 348 | 93,691,039 | 97.0% | **0.2%** | 0.13M |

三条结论：① 真实 prompt 缓存吃掉 94~97% ⇒「省 token」≠「省钱」；② 旧版热清单是那个会话里**最大的浪费源**
（21.3%，其中 98.9% 是陈旧副本，v1.5.0 已消除）；③ fold 真实成功率 3/226、1/51 ⇒ 模拟的
「省 22.7%–43.3%」在实机上从未发生。

**2. 摘要模型失效兜底（实机 8 次失败暴露）**：当前会话超过阈值后连续 8 次压缩全部报
`pi-ai provider "magpie" has no configured model "ima/deepseek-v4.1-flash"` ——
插件 patch 与 preset 把摘要模型写成 magpie/ima，而 magpie provider 的模型表里没有它。

- 引擎：`summarize()` 在显式配置的摘要模型失败时**退回当前路由模型重试一次**（只一次；
  与路由相同则照旧抛错）。现有 harness 用例 2 条。
- 配置：插件自带 `cordis.patch.yml` 与**已安装** preset 的摘要模型改为留空（跟随路由）；
  安装态备份 `cordis.patch.yml.bak-before-summarizer-fix-1793213214`。
- 新工具：`test/measure-billing.mjs`（真实 usage 审计；解压多帧 zstd 依赖本机 python + zstandard）。

### 测试

109 项全绿（+2 摘要回落用例）

## 1.5.0 — 2026-10-29

### P1-4 彻底修法：热清单**就地替换**，surface 永远只有一条

**问题（拿真实会话日志数出来的）**：旧版每次注入都**追加**一条新 `user/message`，旧的不替换。
`session-5acafe42`（死循环那个会话）累积 **176 条 / 809,819 字符 ≈ 27 万 token** ——
它的上下文峰值 672,392 token 里，约 27 万是**这个插件自己注入的热清单**。
一个压缩插件自己的热上下文成了最大的上下文消费者。

| 会话 | 注入条数 | 累计字符 | ≈ tokens |
|---|---:|---:|---:|
| `session-5acafe42` | 176 | 809,819 | ≈ 270,000 |
| `session-365cdcf6` | 103 | 238,083 | ≈ 79,000 |
| `session-5787ac6b` | 74 | 155,569 | ≈ 52,000 |
| 12 个会话合计 | 375 | 1,225,074 | ≈ 408,000 |

**改法**：`pre-step` 里找到当前 surface 上最后一条 `chess-context` 节点，用 DSH 官方的
`surfaceOp: {op:"replace", startSeq, endSeq}` + `sourceEventSeqs` **就地替换**（官方 system-prompt
的 in-history 提交、`tool-result-pruner` 用的同一机制），并且**不进** `decision.messages`。
首次注入（或清单被 fold 遮蔽）时仍走追加路径。

- 内容一字不差时直接返回：不写日志、不推进 `contentGeneration`
- 锚点失效（刚被 fold 遮蔽）会抛错 ⇒ **捕获后退回追加**，绝不因此丢信息
- 被 fold 遮蔽后**立刻补回**，不等限流（否则模型一段时间内看不到死路清单）
- 限流维持原样（≥40 事件 / 失败边 +5）—— 替换不占额外 prompt，但会写日志事件并推进
  `contentGeneration`（下游 `startsSeries`），节奏不动最稳
- 新增配置 `hotLedgerReplace`（默认 `true`，false 退回追加）
- **历史包袱一次清**：v1.5.0 之前追加出来的旧清单不能被删除（surface 只有 append/replace），
  但可以逐条**替换成一行占位**（`[stale chess-ledger elided …]`）。实测 `session-5acafe42` 的 surface 上
  还压着 **44 条 / 295,255 字符 ≈ 9.8 万 token** —— 那个会话下次被打开时会被自动清掉。
  幂等：占位本身 < 200 字符，下次进来直接跳过。

**验证**

- `test/real-ledger-replace.mjs`（新，8/8）：真实 `@deepseek-ai/dsh-session` 上验证替换机制 ——
  含「连续替换 50 次仍只有一条」「替换非当前节点抛错」「漏报 sourceEventSeqs 抛错」「替换后仍能按
  `source.kind` 找回当前清单」
- `test/engine-harness.test.mjs`（+3）：就地替换（`decision.messages` 无新增、surface 恒 1 条、内容更新）、
  被 fold 遮蔽后立刻补回、历史旧清单被换成占位且幂等；变异自检（关掉替换 / 关掉清理 ⇒ 用例变红）
- `node test/run.mjs` → **107 passed, 0 failed**；verify-install 13/13；real-modules 4/4；real-fold 5/5

产物：`evidence/P1-4-清单替换实测.md`

**遗留**：历史累积要等下一次 fold 才会被遮蔽（surface 只有 append/replace，无法删除节点）；
本机运行实例需**再重启一次**才带上本改动。

## 1.4.0 — 2026-10-29

### 模型消费者视角：标记必须自解释、原因不许丢（子代理盲测驱动）

**三处实测缺陷**（都不是结构问题，是「写进去的内容不够模型用」）：

1. **标记裸奔**：图例被绑在「检测到手割」上 ⇒ 一个只有 EACCES 失败、没有成功路径的会话里
   `[blocked]` 出现了却没有任何解释；而 `redundant` / `longer` 真的会出现在清单里，
   图例里**从来没有**它们。
2. **标记是缩写，不是语义**：`[blocked]` 说不出「什么被挡住了、什么条件变了能再试」——
   而那正是 1.1.0 设计三态时给出的理由（`revisit_if`）。现在写成 `[blocked:permission]`。
3. **原因失踪**：旧版 level ≥3 直接把 `→ 报错原文` 整段砍掉 ⇒ 全库 133 条可见失败边里只有
   **25 条**带原因。而盲测里 **12/12 次回答**都引用了报错原文 —— 它是模型判断「是不是同一个坑」的判据。

**改动**

- `src/ledger.mjs`：`failureTags()` + `MARKER_LEGEND` + `legendKey()`；图例**按用到的标记动态生成**
  （出现即解释）；`renderFailureLine()` 任何档位都保留原因（`[90,60,36,25]` 逐档变短）；
  手割分析改为**只算一次**（尾部 30 条，旧版放在档位循环里重复 6 次，且显示条数 >30 时一条都不算）；
  新增档位预判：**注定装不下的级别直接跳过**（2000 边渲染 7.58 ms → **0.478 ms**）
- `src/engine.mjs`：新增配置 `hotLedgerMarkers: semantic | terse | off`（默认 `semantic`）
- `test/markers.test.mjs`（新，9 项）：标记裸奔、图例动态生成、`redundant`/`longer` 图例、
  多参照点、>30 条失败边仍有手割、原因在任何档位都在、三档位行为
- `test/ab-render.mjs`（新）：A/B 夹具 —— 同一张棋谱三种档位各渲染一份，两个场景（基本 / 误导）
- `test/engine-harness.test.mjs`：新增「标记档位一路传到热清单」用例（非法档位回落 `semantic`）
- `docs/最终报告.md` / `docs/性能与成本.md` / `README.md` / `docs/计划表.md`：数字与示例同步

**盲测结果（`evidence/热清单标记AB实验.md`）**

| 实验 | 结果 |
|---|---|
| ① 报错原文已说清该怎么做（3 臂 × 3 样本） | **8/8 满分，三臂无差别**（与 1.1.0 三态 A/B 的「差异为零」一致） |
| ② 报错原文**误导**（2 臂 × 6 样本） | 带标记 **0/6** 重试等价死路；不带标记 **1/6** 重试（理由：「SIGKILL 是外部中止，不是否定性证据」） |
| 引用率 | 带标记 6/6 次回答引用了 `dead`/`redundant`；不带标记只能引报错原文 |

方向性证据（n=6，不显著）：标记只在**报错原文误导**时有价值；默认保留 `semantic`，预算敏感可关。

**全库代价（45 个真实会话同语料新旧对比）**：tokens 19,267 → 20,579（**+6.8%**），
带原因的失败边 89 → **209（2.35×）**，平均档位 L1.40 → L1.42。

### 测试

104 项全绿（原 94 + 新增 10）；`bench-2000.json`：323 tokens / 0.478 ms

## 1.3.5 — 2026-10-28

### P0 修复：`worldHash` 类型契约（事故：压缩 226 次只成功 3 次 → 上下文涨到 66 万 → 模型死循环）

**根因**：`worldstate.hash()` 返回 `{ hash, mode, files }` 对象，engine 的 `worldHashOf()`
把它原样交给 keeper，节点字段于是存了**对象**；随后 `renderFacts()` 里
`latest?.worldHash?.slice(0, 12)` 对对象调 `.slice()` 抛
`latest?.worldHash?.slice is not a function` —— 这一步在 `summarize()` 之前，
于是 `compactRegion` 事务整体回滚，**压缩彻底不工作**。

**改动**

- `src/engine.mjs`：`worldHashOf()` 收敛成字符串（兼容 `string` / `{hash}` / `pending`）；
  `constraintHashOf()` 改为 `hashSet(collectConstraintText(g))`（`st.constraints` 从未被赋值
  ⇒ `constraintHash` 恒为 `pending` ⇒ `stateIndex` 永不建立、置换检测形同虚设）
- `src/graph.mjs`：新增 `hashText()`；`addAgentNode()` 入口归一化（对象永不进图）；
  `fromJSON()` 在加载边界修复历史脏数据（对象 → 字符串、按时序回填 pending `constraintHash`）
  并**无条件重建 `stateIndex`**（派生数据不信任磁盘旧值）
- `src/ledger.mjs`：新增 `shortHash()` 防御层，`CURRENT_STATE_KEY` 不再裸调 `.slice()`

**验证**

- `node test/run.mjs` → **94 passed, 0 failed**（87 + 新增 7）
- 全库回放（新增工具 `node test/verify-graphs.mjs`）：23 个会话 / 1578 个 agent 节点 /
  对象 worldHash **1279 → 0** / `stateIndex` **5 → 185** / 全部会话 `renderFacts`+`renderLedger` 不抛错
- 真实日志独立核对：`session-5acafe42` 的 `compaction/end` **226** 次、`error` **223** 次、
  其中本错误 **139** 次
- 变异自检：把修复回滚 → 新增的端到端回归变红（两层都回滚时错误与实机同形）
- 干净 HEAD 克隆 + `git apply` 补丁 → 94 passed（不是改着源码跑的自证）

**产物**：`docs/P0-worldhash-死循环-根因与修复方案.md`、`docs/P0-worldhash-死循环修复.patch`、
`evidence/P0-worldhash-修复验证.md`、`test/worldhash.test.mjs`、`test/verify-graphs.mjs`

**部署**：插件在 DSH 启动时加载，**需重启生效**；历史数据由 `fromJSON` 加载边界自动修复，
无需手工迁移。

## 1.3.4 — 2026-10-28

### 文档数字同步到 v1.3.1

- `docs/性能与成本.md`：476 → **310 tokens**（注明 v1.2.x 时 476）
- `docs/最终报告.md`：结论段与性能表同步
- `docs/计划表.md` M11：310 tokens / 81K 事实块 / 1.3ms md

### 测试

87 项全绿

## 1.3.3 — 2026-10-28

### 文档：新增 `docs/三层树设计.md`

- 为什么是「缩进树 + 扁平节点」的混合（DAG 最大入度 119，不能目录嵌套）
- 每层的作用与消费者
- **6 个实测缺陷**的完整记录（子代理驱动，v1.2.6 → v1.3.0）
- **3 条核心教训**（结构 ≠ 内容 / 不改运行中的数据 / SGF 树 vs DAG）
- 性能数据（253 节点 ~150ms）

### 测试

87 项全绿

## 1.3.2 — 2026-10-28

### 文档：最终报告加 v1.x 章节

- 6 个版本的变更表（1.2.6 → 1.3.1）
- 3 条核心教训：结构 ≠ 内容 / 不改运行中的数据 / SGF 树 vs DAG
- 实测数据对比：热上下文 476→310、节点 200→242、评语 7→162、死链 230→0

### 测试

87 项全绿

## 1.3.1 — 2026-10-28

### 热清单省预算：短标签 + L4 条数 50 → 20

**问题**：v1.3.0 加了 `[text:?]` / `[verify:kind]` / 三态完整标签（`[dead:a-working-path-avoids-it revisit_if=...]`），
2000 边场景热清单从 L4 降到 **L5**（只显示 10 条）。

**改法**：

1. 热清单用**短标签**（`[dead]` / `[blocked]` / `[failed]`），详细版留 `index.md`
2. `tailFailures` 从 50 → **20**

**实测**：2000 边 → 热上下文 **310 tokens / L4**（之前 276 / L5、476 / L4）

### 测试

87 项全绿

## 1.3.0 — 2026-10-28

### text 型 failure 标记 `[text:?]`（渲染层，不改数据）

**问题**：真实会话的 101 条 failure 里 43 条是 `verify.kind === "text"` —— 其中大量是假阳性（`get_goal`/`update_goal` 的合法 JSON、skill 列表、markdown 被当成失败）。

**为什么不在数据层回洗**：真实会话在跑，`#flush` 会覆盖 `graph.json`（实测：回洗 5 条后立刻被覆盖）。

**改法**：渲染层标记 —— `renderNodeMd` 和 `index.md` 的 text 型 failure 加 `[text:?]`，提示模型「这个判定不可靠，看原因自己判断」。

### 实测

- **47 条** text 型 failure 现在带 `[text:?]`
- 数据层不动（避免与运行中的会话冲突）

### 测试

87 项全绿

## 1.2.9 — 2026-10-28

### 修三层树的死链与计数（第二个子代理实测）

| 问题 | 修法 |
|---|---|
| **`raw/` 死链**：v1.2.4 砍掉 raw 但节点里还写 `../raw/<seq>.md`（230 个节点全是死链） | 改成「（raw/ 已砍掉：节点数据在 graph.json）」 |
| **计数不一致**：index 用 `g.order.length`，graph.json 是 `g.nodes` 数量（227 vs 229） | 改用 `Object.keys(g.nodes).length` |
| **评语不是 LLM 原话**：165 份「评语（来自入边）」只是把 action 抄一遍 | 标注「（非 LLM 原话）」 |

### 实测

- 死链：**0 个**（之前 230 个全是）
- index 计数：**235**（= `g.nodes`，与 graph.json 一致）
- 评语标注：**170 个**节点带「非 LLM 原话」

### 测试

87 项全绿

## 1.2.8 — 2026-10-28

### 缺陷 6：读时重建不一致

**问题**：`graph.json` / `index.md` / `nodes/` 三个来源在写入过程中不一致（边读边写）。

**修法**：

1. **写入顺序**：先写 `nodes/` + `index.md`，**最后**写 `graph.json`（原子 rename = 提交点）
2. **版本标记**：`index.md` 头部写 `> updated: <ISO>`（与 `graph.json` 的 `updatedAt` 同源），读者可对比

**注意**：Windows 不支持目录原子 rename，所以不是完全原子 —— 但 `graph.json` 的 rename 是提交点，读者以它为准。

### 测试

87 项全绿

## 1.2.7 — 2026-10-28

### 三层树补缺陷 2 & 5（子代理实测驱动）

| # | 缺陷 | 修法 |
|---|---|---|
| 2 | **意图缺失**：200 节点只有 7 个有 `goal`，边无 `intent` | `renderNodeMd` 的「评语」段加兜底：`goal` 为空时用**入边的 `intent`**，再为空用**入边的 `action`** |
| 5 | **标签不可信**：43/98 是 verifier 误报（`text` 型） | `renderNodeMd` / `index.md` 的失败边都带 `[verify:kind]`（`exit` / `host-error` / `text` / `none`），模型能区分「真失败」和「文本误报」 |

### 实测

- 评语兜底：**162 个节点**现在有评语（之前只有 7 个）
- verify 标签：**101 条**失败边带 `[verify:kind]`

### 测试

87 项全绿

## 1.2.6 — 2026-10-28

### 三层树补三处缺陷（子代理实测驱动）

一个隔离子代理只靠三层树回答「这个会话试过哪些失败路径」，报了 6 个缺陷，其中 **3 个是实现问题**：

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | **原因**缺失：98 条 failure 只有 13 条带附注 | `renderNodeMd` 出边的 `errorSnippet` 截断 100 → **400** |
| 3 | **节点缺失**：`#flush` / `build-tree` 只写 `g.order`，被合并且仍被边引用的节点没文件 | 改成写**所有** `g.nodes` |
| 4 | **index 只列 190/404 条边**：缩进树每节点只出现一次，跨边/置换边不在 | 加「**失败边全表**」段（含跨边） |

### 实测

- `index.md` 21KB → **54.6KB**，含全部失败边（id / from → to / 意图 / 错误原文 160 字符）
- `nodes/` **224 个**（含被合并且仍被边引用的）
- `build-tree.mjs` 不再写 `raw/`（v1.2.4 砍掉后残留的代码）

### 未修（记录在 HANDOFF）

- 标签不可信（43/98 是 verifier 误报）—— 旧数据，新代码已修（v0.1.2）
- 读时重建不一致 —— 边读边写，任何计数要带时间戳

### 测试

87 项全绿

## 1.2.5 — 2026-10-28

### `index.md` 改缩进树（每节点只出现一次）

`index.md` 从平铺改成按深度的缩进树：

- 缩进 = 从**入度为 0 的节点**出发的最短路径深度（封顶 12 级）
- 每个节点只出现一次
- 出边挂在节点下一行

**实测输出**：

```markdown
- [n1](./nodes/n1.md) USER seq=968 我重启了...
- [n2](./nodes/n2.md) USER seq=969 <hindsight_knowledge>...
  - e1 ✗ get_goal
- [n12](./nodes/n12.md) USER seq=1042 持续优化...
  - [n59](./nodes/n59.md) STATE seq=1363 (无目标)
    - e66 ✗ edit(file_path=...
```

### 为什么不做目录嵌套（用户提议过）

真实数据：203 节点 / 396 边，**多父节点 7 个，最大入度 119**（n174 有 119 个父），transposition 边占 61%。

嵌套会让 n174 在 119 个目录里重复 → 文件爆炸 + 不同步。**棋谱是 DAG，不是树** —— 缩进树只表达深度，不复制节点。

### 测试

87 项全绿

## 1.2.4 — 2026-10-28

### 砍掉 `raw/`（节点 JSON 与 `graph.json` 重复）

三层文件树的 `raw/` 存的是**节点 JSON**，和 `graph.json` 完全重复（200 文件 / 430KB）。
真正的「原始记录」应该是**事件原文**，不是节点 JSON —— 这个以后从 session 日志接。

**改动**：

- `#flush` / `build-tree.mjs` 不再写 `raw/`
- 三层变两层：`index.md` + `nodes/*.md`（+ `graph.json` 数据源）

**省**：430KB / 200 文件。

### 测试

87 项全绿

## 1.2.3 — 2026-10-28

### 展示名改为 `DSH-GOkifu-compact`（大写 GO）

`GO` 才是围棋（`go` 是编程语言）。但 **npm 包名只能小写**（`dsh-gokifu-compact`），这是 npm 的硬限制。

- README / AGENTS / QUICKSTART / docs 标题：`DSH-GOkifu-compact`
- GitHub 仓库：`MYCF711/DSH-GOkifu-compact`
- npm 包名 / 配置项 / 路径：保持 `dsh-gokifu-compact`（小写）

### 测试

87 项全绿

## 1.2.2 — 2026-10-28

### 性能：`graph.md` 不再自动写

`graph.md` 是整篇人读视图（157KB），每次 flush 写是纯 IO 浪费；三层文件树（index/nodes/raw）已经是人读视图。

**改法**：

- `#flush` 不再写 `graph.md`
- 需要时：`node test/build-md.mjs <sessionDir>` 按需生成

**保留**：`graph.json`（数据源，插件自己恢复用，必须写）。

### 测试

87 项全绿

## 1.2.1 — 2026-10-28

### 文档：README 加三层文件树说明

把 `index.md` / `nodes/*.md` / `raw/*.md` 三层的作用与消费者写清楚了。

### 工具：`test/build-tree.mjs`

给 v1.2.0 之前已有的会话补三层文件树（从 `graph.json` 生成）。
实测：`session-5acafe42` 补了 **183 个节点**。

### 测试

87 项全绿

## 1.2.0 — 2026-10-28

### 三层文件树（index / nodes / raw）

**问题**：`graph.md` 是整篇 177KB，人无法浏览，模型无法按需加载。

**改法**：每次 flush 额外写三层：

```
sessions/<id>/
├── index.md          落子顺序（每个节点一行 + 出边状态）
├── nodes/n1.md       单节点：评语 / 状态 / 入边 / 出边 / raw 链接
├── raw/1.md          原始记录（节点 JSON 全文）
└── graph.json / graph.md  （保留兼容）
```

**index.md**：

```markdown
- [n1](./nodes/n1.md) USER seq=1 目标：把构建跑通
  - e1 ✓ 跑 npm install
- [n2](./nodes/n2.md) STATE seq=2 装依赖
```

**nodes/n2.md**：

```markdown
# n2 · AGENT  seq=2
## 评语（LLM 当时的目标）
装依赖
## 状态
- worldHash: `W1`
- constraintHash: `C1`
## 入边
- e1 ← n1: 跑 npm install [success]
## 出边
（无）
## 原始记录
../raw/2.md
```

**设计依据**：`evidence/棋谱有效性实验.md` —— 干净子代理实验证明三层缺一不可：
索引让模型看到全部死路，节点给详情，原始补抽取的漏。

### 测试

**87 项**（+2：index.md / 单节点 md）

## 1.1.0 — 2026-10-28

### 失败三态（子代理 A/B 实验驱动）

**实验结论**：两个隔离子代理独立做 A/B（带标记 vs 不带），**行为差异为零**。
`[dead]` 作为「别重试」的指令没用 —— 失败记录 + `WORKING` 行已经足够推出；
而且**有损**：把「相对于当前成功路径」写成永久墓碑，会关掉「权限变了本来能走」的路。

**改法**：`failureClass(edge, tewari)` 返回三态：

| 状态 | 条件 | 带什么 |
|---|---|---|
| `blocked` | 资源类错误（EACCES / ENOENT / timeout / ECONNREFUSED） | `revisit_if=...`（什么条件变了可以再试） |
| `dead` | 有成功路径且**失败边有终点**证明不经过它 | `revisit_if=working path fails` + `redundant:<edge>` |
| `failed` | 其余（可重试性未知） | 无 |

**关键顺序**：先判 `blocked` 再判 `dead` —— 权限不足是环境性阻塞，不是本质无解。

**关键边界**：`to` 为 null（没走到任何节点）**不算 dead 证据** —— 只说明试过没成，不能证明有替代。

**实测输出**：

```
LEARNED (3 failed attempts):
# dead=a working path avoids it (revisit_if it fails) | blocked=needs a resource (revisit_if it changes) | failed=retryability unknown | novel=explored states no working path covered
- e2 "绕路到B" → boom [dead:a-working-path-avoids-it revisit_if=working path fails redundant:e1]
- e3 "写 prod" → EACCES [blocked:permission revisit_if=permission changes]
- e4 "试命令" → boom [failed:retryability unknown]
```

### 测试

85 项全绿

## 1.0.0 — 2026-10-28

### 手割多参照点（Multi-baseline tewari）

**问题**：之前取成功路径的并集，同一条失败边只能给一个结论。
但「看第二个你判断优，看第三个是劣」—— 同一条失败边相对不同成功路径可能有不同结论。

**改法**：`tewariAnalysis` 对**每条**成功出边单独判定，返回：

```js
{
  baselines: [
    { edgeId: "e1", sameEndpoint: true,  reachesEndpoint: true  },
    { edgeId: "e2", sameEndpoint: false, reachesEndpoint: false },
  ],
  redundantVs: ["e1"],   // 相对哪些成功路径是冗余（同终点）
  longerVs: [],          // 相对哪些绕路
  probes: [...],         // 探出的新节点
}
```

热清单显示：

```
- e3 "绕到B" → boom [redundant vs e1]
```

**1.0.0 含义**：API 稳定、语义完整（同型 / 探新 / 冗余 / 绕路，每条边明确指向「相对哪条成功路径」）。

### 测试

85 项全绿

## 0.9.1 — 2026-10-28

### 热清单去重：`CURRENT PATH` 与 `WORKING` 相同时只显示一个

之前两个都显示（一个含失败边，一个只有成功边），模型会困惑。
现在：如果当前路径 == 成功路径，只显示 `WORKING`；不同才额外显示 `CURRENT PATH`。

### 文档：README 加围棋术语对照表

把「本手 / 恶手 / 俗手 / 新手 / 缓手 / 手割」等术语的日文/英文版列出来，
说明它们和插件标签的对应关系（标签本身仍用英文短词，模型友好）。

### 测试

85 项全绿

## 0.9.0 — 2026-10-28

### 热清单标题改 `LEARNED` + 每条失败边都有归属标签

**问题**：`PROVEN DEAD ENDS` 是给人类看的标题，而且里面混着三种完全不同的边：
- 真正的死路（没有成功路径经过）
- 等价成功路径（`redundant`）
- 探出新状态（`novel`）

**改法**：

```
LEARNED (2 failed attempts):
# dead=no working path goes through it (don't retry) | redundant=a working path reaches the same endpoint | novel=explored states no working path covered (may revisit) | longer=detours vs a working path
- e1 "删掉整个 node_modules" → 权限不足 [dead]
- e2 "绕远路到同一终点" → boom [redundant]
```

每条失败边现在**必有标签**：

| 标签 | 含义 | 该怎么做 |
|---|---|---|
| `[dead]` | 没有成功路径经过 | 别重试 |
| `[redundant]` | 有成功路径到同一终点 | 走那条 |
| `[novel]` | 探出了成功路径没走过的状态 | 可复查 |
| `[longer]` | 比成功路径绕远 | 走短的 |

### 测试

85 项全绿

## 0.8.0 — 2026-10-28

### `WORKING` 显示完整成功路径

之前只显示最近一条边（`user → n2`），模型不知道整条路怎么走通的。
现在从最新成功节点回溯到根，拼出完整路径：

```
WORKING: user → n2 → n3 (exit 0)
```

这是「棋谱」该有的样子：**整盘棋的行棋顺序**，不是最后一手。

### 测试

85 项全绿

## 0.7.0 — 2026-10-28

### 模型消费者视角优化（给模型用，不是给人看）

**1. 手割标记改成模型能直接理解的英文短词 + 图例**

| 旧 | 新 | 图例含义 |
|---|---|---|
| `[同型]` | `[redundant]` | same endpoint as a working path |
| `[探新]` | `[novel]` | explored states no working path covered |
| `[劣]` | `[longer]` | detours |

图例只在确实有标记时出现（省 token）：
```
# tags: redundant=same endpoint as a working path | novel=explored states no working path covered | longer=detours
```

**2. 新增 `WORKING` 行 —— 模型不能只看到死路，还要知道哪条路是通的**

```
WORKING: user → n2 (exit 0)
```

**3. 消除 `PROVEN DEAD ENDS` 与「同型」的矛盾**：`redundant` 明确说它等价于成功路径，不是真正的死路。

### 实测热清单

```
<chess-ledger>
ROOT USER (verbatim): 目标：把构建跑通
CURRENT PATH: n1(user) → n2
CURRENT GOAL: 装好了
WORKING: user → n2 (exit 0)
PROVEN DEAD ENDS (1 total; do not retry blind):
# tags: redundant=same endpoint as a working path | novel=explored states no working path covered | longer=detours
- e1 "绕路A" → boom [redundant]
</chess-ledger>
```

### 测试

85 项全绿

### 待办（下一版）

- 手割多参照点：同一失败边相对多条成功路径的分别结论
- 真实模型 A/B：带手割标记 vs 不带，验证模型是否真的少走死路

## 0.6.0 — 2026-10-28

### 重构：手割从四档改成「两判定 + 多标签」

**问题**：四档（profit / detour / pure_loss / no_alternative）是单选，容易模棱两可：
- 同一条失败边可能同时「有价值」和「不如原型」；
- 同一个失败边可能通向多个收敛点，从不同参照看结论不同。

**改法**：判定只有**两种**，其余是**可同时成立**的标签：

| 判定 | 含义 |
|---|---|
| `same_position` | **同型** —— 失败边和某条成功路径到达同一终点（殊途同归，完全等价） |
| `different` | **不同型** —— 其余情况 |

不同型时额外记录两个**独立**维度：

| 字段 | 含义 | 热清单标记 |
|---|---|---|
| `probes` | 探出的、标准定式没走过的节点（最多 8 个） | `[探新]` |
| `vsBaseline` | 相对标准定式：`same` / `longer`（绕路）/ `unknown` | `[劣]` |

**多标签可以同时出现**：`[探新 劣]` = 这条路探出了新东西，但比标准定式绕了路。

### 实测

```
# 同型：失败边和成功路径到同一节点
- e1 "绕路A" → boom [同型]

# 探新：失败边走了标准定式没走过的节点
- e2 "探索路" → boom [探新]
```

### 已知局限（记在 HANDOFF）

- 多条成功路径目前取并集，**没有分别列出**「相对每条路径的结论」——不同参照点可能给出不同结论。
- `probes` 与 `vsBaseline: longer` 逻辑上互斥（一个要求不在基线，一个要求在基线），
  所以 `[探新 劣]` 只在「终点在基线但沿途探新」时出现。

### 测试

85 项（4 个 tewari 测试改断言后全绿）

## 0.5.1 — 2026-10-28

### 修复：手割漏了「赚」这一档

0.5.0 只做了「亏」，但手割的核心是「谁亏谁赚」。补上 `profit` 并重排判定顺序：

| 判定 | 条件 | 标记 |
|---|---|---|
| `profit` | 同起点**没有**别的成功路径，但失败之后走出了成功 → 必要试错 | **`[赚]`** |
| `detour` | 标准定式（同起点成功路径）能到达失败终点，但绕了路 | `[绕路]` |
| `pure_loss` | 标准定式不经过它 → 这一步多余 | `[纯亏]` |
| `no_alternative` | 同起点没有成功路径，失败之后也没有成功 | 无 |

**判定顺序很关键**：先算「有没有标准定式」（同起点成功路径），再算「失败之后有没有成功」，
最后才落到 pure_loss —— 否则会把「必要试错」误判成「纯亏」。

### 实测两种输出

```
# 赚：没有别的成功路径，试错后走出来了
- e1 "先试 npm install" → ETIMEDOUT [赚]

# 纯亏：有别的成功路径，这一步多余
- e1 "直接改 prod" → EACCES [纯亏]
```

### 测试

**85 项**（+1：profit）

## 0.5.0 — 2026-10-28

### 新增：手割分析（tewari）

围棋的复盘方法：把多出的着法拿掉，还原标准定式，判断谁亏谁赚。
本插件用它判断**一条失败边是不是纯亏**：

| 判定 | 含义 | 热清单标记 |
|---|---|---|
| `pure_loss` | 同起点有成功路径，且完全不经过失败边的终点 | **`[纯亏]`** |
| `detour` | 成功路径能到达失败终点，但绕了路 | `[绕路]` |
| `no_alternative` | 同起点没有成功路径可比 | 无标记 |

**为什么重要**：原来的插件只记录「e1 失败了」，手割进一步回答「**为什么**这一步多余」——
把这一步拿掉，同起点有成功的替代路径。这正是围棋复盘里「手割」做的事。

**实测输出**：

```
PROVEN DEAD ENDS (1 total; do not retry blind):
- e1 "直接改 prod 配置" → EACCES: permission denied [纯亏]
```

**实现**：

- `graph.mjs` 新增 `tewariAnalysis(g, edge)`：对失败边做 BFS，找同起点的成功路径，判断终点是否可达
- `ledger.mjs` 的 `renderFailureLine` 支持 tewari 参数，热清单显示 `[纯亏]` / `[绕路]`
- 只对**当前显示**的失败边做，且 ≤30 条（每条一次 BFS，防 O(E²)）
- 失败边没有终点节点时，同起点有成功替代即判 `pure_loss`

### 测试

**84 项**（+3：pure_loss / detour / no_alternative）

## 0.4.0 — 2026-10-28

### 破坏性变更：包名 `dsh-kifu-context` → `dsh-gokifu-compact`

命名拆开看：**GO（围棋）+ kifu（棋谱）+ compact（压缩）**。

- **Go**：棋种
- **kifu**：棋谱（围棋/将棋的记谱方式：一局棋的完整记录 + 每手评语）
- **compact**：这个插件实际做的事（上下文压缩）

比 `kifu-context` 更明确：`context` 只说明「上下文」没说明「压缩」；`GOkifu` 把棋种和棋谱都标出来。

**展示名用大写 GO**（`GO` 才是围棋）；npm 包名只能小写（`dsh-gokifu-compact`，npm 硬限制）。

### 术语澄清：`transposition` 不是核心

- `transposition`（转置检测）是**国际象棋引擎**的概念（同一局面经不同路径到达时不重复搜索）。
- 围棋有等价情形（棋界叫「同形」/「同型」），但没有这个术语。
- 本插件里它只是**优化**：命中历史节点时不新建分支，加一条回边。
- **核心是「失败记忆 + 增量 fold」**：
  - 失败记忆负责**明确否定走错的着法**（`failureEdges` + 热清单 + 节点 `errorSnippet`）
  - 增量 fold 负责**每段历史只摘要一次**（不重压、不 ρ^k 衰减）

README 已按这个口径改写：卖点从「转置检测」改为「失败记忆 + 评语可复盘」。

### 升级步骤

```bash
node test/rollback.mjs     # 卸旧名
node test/install.mjs      # 装新名
# 重启 DSH
```

## 0.3.0 — 2026-10-28

### 破坏性变更：包名 `dsh-chess-context` → `dsh-gokifu-compact`

`chess` 在英文里是国际象棋，而这个插件的隐喻是**围棋棋谱（kifu）**。改名原因见下。

**升级步骤**（已装过的）：

```bash
node test/rollback.mjs          # 先卸旧名
node test/install.mjs           # 装新名
# 重启 DSH
```

preset 的 `cordis.patch.yml` 与 profile 的 `package.json` 里的引用已同步更新。

### 新隐喻（写进 README 与仓库描述）

> 把 agent 的每一步变成棋谱上的一手：落子、评语、复盘。
> 上下文压缩不再是丢掉历史，而是把历史下成一局随时能复盘的棋 ——
> 每一手都保留 LLM 自己写下的评语和完整想法，环环相扣。
> 高价值的棋局几年后仍能记起整盘怎么下；走到关键处，旧棋谱会吊起记忆，让人悬崖勒马。

- **节点 = 一手棋**（局面）
- **边 = 一手尝试**（落子 + 结果）
- **评语 = LLM 当时写下的目标 / 约束 / 失败原因**（可追溯到完整想法）
- **复盘 = 从根节点沿边走一遍，整盘怎么下的都在**

### 保留项

- `transposition`（转置检测）术语保留 —— 那是国际象棋引擎的概念
  （同一局面经不同路径到达时不重复搜索），本插件确实借用了。

## 0.2.1 — 2026-10-28

### 文档

- **修正隐喻**：`package.json` / GitHub 仓库描述里的 `chess-record DAG`（国际象棋）改为
  **go game record (kifu)**（围棋棋谱）。项目名保留 `chess`（已发布，改名成本高于收益），
  但隐喻取围棋：**节点 = 局面（交叉点），边 = 一手尝试（落子 + 结果），失败记忆 = AlphaGo 的胜负回溯**。
- 代码里的 `transposition`（转置检测）**保留不改** —— 那是国际象棋引擎的术语
  （同一局面经不同路径到达时不重复搜索），本插件确实借用了这个概念。
  所以准确表述是「围棋棋谱 + 国际象棋转置表」的混合，README 顶部已写明。

## 0.2.0 — 2026-10-28

> 从 0.1.0 到 0.2.0 累计修掉 **19 个 bug**（3 个 P0 级数据破坏），
> 单测从 64 项增到 81 项，全部通过。核心行为变化：约束不再经过模型。

### 新增

- **机械约束段**：`summarize()` 在模型输出后机械追加 `## 约束（机械保留，逐字；不由模型改写）`。
  多规模实测（5/15/30 条失败边）发现模型会把 3 条约束全丢（0/2~3/3 之间跳），
  改为规则拼回后约束保留率 **100%**，不依赖模型遵守。
- **L5 降级档**：`hotLedgerMaxTokens` 在小预算下多一档兜底（只留最近 10 条），极端输入不再超预算。
- **`compactRegion` 覆盖**：官方 `/compact` 路径也能拿到正确的 fold 范围（摘要里的 seq 不再是 `undefined-undefined`）。
- **`renderLedger` 置换提示**：当前路径上有 `transposition` 边时输出「回到已走过的状态」警告
  —— 之前 `renderTranspositionWarning` 全项目无调用点，这个提示永远不会出现。
- **`validate()` 落盘前校验**：图不变量（悬空边 / 缺状态哈希 / 失败边没原因）有问题时进日志。

### 修复（19 个）

**P0（会悄悄破坏图数据）**

- `this.flushTimers` 从未初始化 → 每次「有变化」的事件抛 TypeError，**1.2s debounce 落盘从未工作**。
- 节点创建写死 `worldHash: "pending"`，fold 前统一回填成**同一个哈希** → 整段路径被判定为同一状态、
  折叠成一个节点（实测 4 个 step 后节点 5→2、3 条边 `from` 悬空）。
- `mergeNodeInto` 只改 `edge.to` 不改 `edge.from` → 合并非叶子节点后它的所有出边指向已删除节点
  （真实会话 155 条边里 **115 条** `from` 悬空）。

**P1**

- 热清单每次 digest 变化就**追加**新 user 消息、旧的不替换（真实会话累积 131 条 / 508,308 字符）。
  **已缓解**：两次注入至少隔 40 事件 + 失败边增长不足 5 条不注入。
- `renderMd` 对每个节点做一次全边扫描 O(N×E) → 建 `from→edges[]` 索引后 **406ms → 1.3ms（258 倍）**。
- 热清单只看 root 节点的约束，后续 user 消息里的约束全部丢失 → 改用 `collectConstraints(g)` 全量去重。
- 测试计数正则对只读工具也生效（`read` 到 "all tests passed" 被判 success）→ 加 `if (!readOnly)`。
- `EXIT_RE` 取正文第一处匹配（`sed` 打印的测试文件里写着 `[exit code: 1]` 会把 exit 0 的命令判失败）
  → 只看末尾 200 字符。
- `renderFacts` 无范围限制，摘要体积随**全局**失败数增长 → 支持 `{ range }` 只取本段失败边。
- `backfillState` 在 `compactRegion` 之前执行，fold 失败不回滚 → fold 前 `toJSON` 快照，
  `range===null` / `result===null` / 抛错三条路径都恢复。
- `validate()` 运行期从不调用 → `#flush` 落盘前校验。
- 置换命中信息被 keeper 丢弃，`renderTranspositionWarning` 无调用点 → 在 `renderLedger` 里真正输出。
- 指令同时要求「每条失败边都必须出现」和「整份记录 <1200 字符」→ 超过约 15 条死路不可满足。
  改为「每条死路约 40 字符 + 600 字符余量」。

**P2**

- L4 降级不看 `maxTokens`（12 条 200 字约束 + 120 条失败边 → 1,095 tokens，预算 500 的 219%）→ 加 L5。
- `_chessActiveRange` 在 `/compact` 路径为 null → 覆盖 `compactRegion` 在事务入口设置、`finally` 恢复。
- `summaryMode: "llm"` 的文档说「完全交给模型」，实际仍带 facts → 文档改为「不降级到规则摘要，仍带硬事实」。

**运行期实测（真实会话暴露）**

- `user/message` 的 `source.kind` 只应把 `user` 当真用户
  （hindsight / agent-instructions / subagent 注入被当成 UserNode，污染约束集与根目标）。
  真实日志回放：user 节点 **22 → 4**。
- verifier 把只读工具（`get_goal`/`update_goal`/`hindsight_*`）的 JSON 文本误判为 failure。
  真实日志回放：failure **88 → 22**。
- `tool/result` 与 `pendingEdges` 的匹配缺失 → 回放 1807 事件，未匹配 **0 条**。
- `EXIT_RE` 渲染（同上）。

### 变更

- `src/engine.mjs` 去掉内嵌**裸 NUL 字节**（`parts.join("\0")` → `String.fromCharCode(0)`），
  `file`/`grep` 不再把整个文件判为 binary。
- `package.json` 的 `files` 排除测试产物（`src/.engine-under-test.mjs` / `src/.harness-stubs`）。

### 文档

- 新增 [`QUICKSTART.md`](./QUICKSTART.md)：重启后 3 步验证 + 日常使用 + 4 类故障处理 + 7 个配置项。
- 新增 [`docs/性能与成本.md`](./docs/性能与成本.md)：fold 耗时分解 / graph 体积 / ledger 渲染 / 真实 token 曲线。
- 新增 [`evidence/棋谱有效性实验.md`](./evidence/棋谱有效性实验.md)：干净子代理实验
  —— 棋谱组 **15/15** 避开已知坑；对照组从原始文档补出 **2 条棋谱漏掉的坑**，
  证明「原始记忆必须保留」。
- 全部文档数字按 `evidence/*.json` 校正（验收子代理查出 15 处不一致，已修 14 处，剩 1 处标注口径）。

### 测试

| 套件 | 结果 |
|---|---|
| `node test/run.mjs` | **81 passed, 0 failed**（0.1.0 时 64 项） |
| `node test/verify-install.mjs` | 13/13 |
| `node test/real-modules.mjs` | 4/4（真实 `@deepseek-ai/*` 包） |
| `node test/real-fold.mjs` | 5/5（真实 `compactRegion` 事务，含 hybrid） |
| `node test/real-e2e.mjs` | 3/3 失败边、3/3 复述 |
| 真实模型对照 | 本插件失败边 **8/8** vs 官方 8 段模板 **4.67/8** |

### 已知未完成（见 HANDOFF.md）

- P1-4 的彻底修法（替换 surface 上的旧热清单消息）—— 当前是限流缓解。
- 真实计费口径的节省（模拟显示 22.7%–43.3%，未核对真实账单）。
- 三层文件树（index / nodes / raw）的设计已验证，尚未进插件实现。
