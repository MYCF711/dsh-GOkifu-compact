# 测绘 · engine.mjs 归位图（P1 作业图）

> **这份文件是 P1 的唯一作业图**：把 4689 行的 `src/engine.mjs` 按职责搬进房间之前，
> 先钉死「谁调谁、每个导出归哪一类、七件事各在哪几行、搬哪一条会红」。
> 依据 `docs/方案-繁复收敛.md`（P1 只归位 → P2 切房），**本文不改任何逻辑**。
>
> **只读分析**：本次未修改 `src/` `test/` `scripts/` `lib/` 下任何文件，也未改 `docs/README.md`。
>
> 时点：`main@3ff36ff`。代码面与方案里引用的 `6f77089` **逐字节相同**（见 §0 的 `git rev-parse` 证据）。

---

## 0 口径基线（先对齐数字，再谈归位）

| 指标 | 实测 | 口径 |
|---|---:|---|
| `src/engine.mjs` | **4689 行** | `wc -l` |
| 命名导出 | **29** | 24 个 `export function\|const\|class` + 1 个 `export { … }` 块里的 5 个名字 |
| 默认导出 | 1 | `export default class ChessCompactionEngine`（783 行） |
| 顶层 `export` 行 | 26 | 24 + 1（default）+ 1（`export {}` 块） |
| `from "./rooms/*"` 的 import 语句 | **22** | 覆盖 **21** 个不同模块（`hot-inject` 被导入两次） |
| `@deepseek-ai/*` import | **4** 条 | `schemastery` / `dsh-compaction-basic` / `dsh-compaction` / `dsh-llm` |
| `src/rooms/` 房间文件 | **28** | 其中 **21** 被 engine 导入，**7** 不被导入 |
| 静态 import `src/engine.mjs` 的文件 | **0** | `src/` `test/` `scripts/` `lib/` 全扫 |
| 文本提到 `engine.mjs` 的位置 | **208** | 注释 / 文档 / 源码文本断言，**都不是依赖** |
| 读 `engine.mjs` 源码做断言的脚本 | **50** 个文件 | 35 个 `test/` + 15 个 `scripts/` |
| 门禁基线 | **2569 passed, 2 skipped, 0 failed** | `node test/run.mjs`（本次实跑，exit 0）—— **本文档存在之前**的数字；加入本文档后必多 1 项失败（`D-3` 文档未索引），见 §5-5 |

**代码面与方案里引用的 commit 相同**（所以方案 §1 的实测表对本图继续有效）：

```
$ git rev-parse 6f77089:src/engine.mjs HEAD:src/engine.mjs
8fb9086ce0ec88fdad76c24608c630882a5b295b
8fb9086ce0ec88fdad76c24608c630882a5b295b
$ git diff --stat 6f77089..HEAD -- src/ test/ scripts/ lib/ cordis.patch.yml package.json
（空输出 = 两提交之间代码面零差异，差异只在 docs/）
```

### 复现命令

```bash
cd "D:/主工作区/repos/dsh-GOkifu-compact"
wc -l < src/engine.mjs                                             # 4689
grep -cE '^export (async )?(function|const|class)' src/engine.mjs   # 24
grep -cE '^export \{' src/engine.mjs                               # 1
grep -cE '^export default' src/engine.mjs                          # 1
grep -cE '^export' src/engine.mjs                                  # 26
sed -n '4689p' src/engine.mjs | tr ',' '\n' | grep -c .            # 5（块里的名字数）
git rev-parse 6f77089:src/engine.mjs HEAD:src/engine.mjs
node test/run.mjs 2>&1 | tail -2
```

---

## 1 依赖边：engine.mjs ⇄ rooms，以及谁在调它

### 1.1 它调谁（`src/engine.mjs` → `src/rooms/*`，逐条）

22 条语句、21 个模块。行号 = `src/engine.mjs` 里那条 import 的行号。

| import 行 | 模块 | 引入符号数 | 其他 import 者（不含 engine，按目录） |
|---:|---|---:|---|
| 25 | `rooms/kifu-model.mjs` | 10 | 房 9 · test 30 · scripts 20 |
| 26 | `rooms/build-stamp.mjs` | 1 | 房 0 · test 6 · scripts 11 |
| 27 | `rooms/keeper.mjs` | 3 | 房 1 · test 14 · scripts 3 |
| 28 | `rooms/world.mjs` | 1 | 房 0 · test 1 · scripts 0 |
| 29 | `rooms/fold-planner.mjs` | 3 | 房 0 · test 5 · scripts 0 |
| 30 | `rooms/closeout-backfill.mjs` | 4 | 房 1 · test 10 · scripts 11 |
| 31 | `rooms/closeout-plan.mjs` | 8 | 房 0 · test 4 · scripts 2 |
| 32 | `rooms/ledger.mjs` | 4 | 房 3 · test 37 · scripts 14 |
| 33 | `rooms/fold-quality.mjs` | 2 | 房 1 · test 13 · scripts 16 |
| 34 | `rooms/facts-prompt.mjs` | 4 | 房 0 · test 6 · scripts 1 |
| 37 | `rooms/fact-guard.mjs` | 1 | 房 1 · test 4 · scripts 0 |
| 38 | `rooms/tool-value-facts.mjs` | 1 | 房 2 · test 6 · scripts 1 |
| 39 | `rooms/config-schema.mjs` | 3 | 房 2 · test 2 · scripts 0 |
| 40 | `rooms/kifu-persist.mjs` | 4 | 房 1 · test 5 · scripts 3 |
| 42 | `rooms/user-route.mjs` | 1 | 房 0 · test 1 · scripts 1 |
| 43 | `rooms/hot-inject.mjs` | 1（`decideInjection`） | 房 0 · test 3 · scripts 0 |
| 44 | `rooms/loop-guard.mjs` | 2 | 房 0 · test 1 · scripts 1 |
| 45 | `rooms/offline-fold.mjs` | 8 | 房 0 · test 30 · scripts 27 |
| 46 | `rooms/zstd-log.mjs` | 3 | 房 0 · test 2 · scripts 33 |
| 47 | `rooms/hot-inject.mjs` | 1（`afterTailBucket`） | 同上（**同一模块的第二次 import**） |
| 48 | `rooms/touched-files.mjs` | 1 | 房 1 · test 2 · scripts 1 |
| 49 | `rooms/manual-compact.mjs` | 1 | 房 0 · test 1 · scripts 0 |

宿主包（**永久允许，只有 R09 能碰**，见 AGENTS §2.1 / 门禁 C1-R-C）：
`20 @deepseek-ai/schemastery` · `21 @deepseek-ai/dsh-compaction-basic` ·
`22 @deepseek-ai/dsh-compaction` · `23 @deepseek-ai/dsh-llm`；
另有 `16 node:fs` · `17 node:path` · `18 node:os`。

### 1.2 谁调它（反向）

**结论：仓库里没有任何文件 `import … from "…/engine.mjs"`（0 条）。** 真实耦合只有三处，且都不是 import：

1. **`test/engine-harness.test.mjs:23,92-96`** —— 把 `engine.mjs` **源码读成字符串**，用 4 次
   `.replace('from "@deepseek-ai/…"', 'from "./.harness-stubs/stub-….mjs"')` 换成 stub，
   写到 `src/.engine-under-test.mjs`，再 `import()` 那个副本。**测试取的是副本，不是真文件。**
2. **`test/real-modules.mjs:132-137`** —— 把整个 `src/` 拷到 tmp 目录，`import` 拷贝里的 `engine.mjs`。
3. **`package.json` 的 `exports["./engine"]` = `./src/engine.mjs`** —— 这是**对外子路径契约**，
   也是 `cordis.patch.yml` 里 `name: 'dsh-gokifu-compact/engine'` 指向的东西（永久路径，不能改名）。

另有 **208 处** 文本提及 `engine.mjs`（`src/` `test/` `scripts/` `lib/`），全部是注释、文档引用或
`readFileSync` 源码文本断言 —— **改这些地方不会破代码，但改 engine 的代码文本会破它们**（见 §4.2）。

### 1.3 「只被 engine 用」vs「也被外部用」

**21 个被 engine 导入的房间，没有一个是 engine 独占的（0 个）。** 最少的也各有 1 个 test 消费者：

| 模块 | engine 之外还有谁 import | 数量 |
|---|---|---:|
| `manual-compact` | `test/manual-compact.test.mjs` | 1 |
| `world` | `test/selfloop.test.mjs` | 1 |
| `loop-guard` | 1 test + 1 script | 2 |
| `user-route` | 1 test + 1 script | 2 |
| `hot-inject` | 3 test | 3 |
| `touched-files` | 1 房 + 2 test + 1 script | 4 |
| `config-schema` | 2 房 + 2 test | 4 |
| `fact-guard` | 1 房 + 4 test | 5 |
| `fold-planner` | 5 test | 5 |
| `closeout-plan` | 4 test + 2 script | 6 |
| `facts-prompt` | 6 test + 1 script | 7 |
| `kifu-persist` | 1 房 + 5 test + 3 script | 9 |
| `tool-value-facts` | 2 房 + 6 test + 1 script | 9 |
| `build-stamp` | 6 test + 11 script | 17 |
| `keeper` | 1 房 + 14 test + 3 script | 18 |
| `closeout-backfill` | 1 房 + 10 test + 11 script | 22 |
| `fold-quality` | 1 房 + 13 test + 16 script | 30 |
| `zstd-log` | 2 test + 33 script | 35 |
| `kifu-model` | 9 房 + 30 test + 20 script | 59 |
| `ledger` | 3 房 + 37 test + 14 script | 54 |
| `offline-fold` | 30 test + 27 script | 57 |

> **推论（对 P2 直接有用）**：engine 与房间之间**没有"私有"边** —— 你从 engine 里搬走的每一段，
> 都可能同时在某个 `scripts/*-audit.mjs` 里被复用。搬 engine 的**导出**不是搬一间房，
> 而是搬一个**已经被 50~70 个文件依赖的公共面**（见 §2 的「外部消费者」列）。

### 1.4 engine **不**导入的 7 个房间

`migrate` · `node-docs` · `preset-format` · `profile-io` · `query-recall` · `user-patch` · `verify`

前 3 个各走各的消费者（`migrate` 只被 CLI 与测试用；`preset-format` 被 `ui.mjs` + `install.mjs` 用；
`verify` 被 `keeper`/`ledger`/`offline-fold` 用）。**它们不能被当成"engine 的归属房间"。**

### 复现命令

```bash
cd "D:/主工作区/repos/dsh-GOkifu-compact"

# 它调谁：22 条语句 / 21 个模块 / 4 个宿主包
grep -cE '^import .* from "\./rooms/' src/engine.mjs                                    # 22
grep -oE 'from "\./rooms/[a-z-]+\.mjs"' src/engine.mjs | sort -u | wc -l                # 21
grep -oE 'from "@deepseek-ai/[^"]+"' src/engine.mjs | sort -u                           # 4 条

# 谁调它：0 条静态 import
grep -rnE '^[[:space:]]*import[^;]*from[[:space:]]+"[^"]*engine[^"]*"' src/ test/ scripts/ lib/ --include=*.mjs
# ⇒ 空

# 208 处文本提及（不是依赖）
grep -rn "engine\.mjs" src/ test/ scripts/ lib/ --include=*.mjs | wc -l                 # 208

# 50 个读源码做断言的文件（35 test + 15 scripts）
for f in $(grep -rlE 'readFileSync|readSource|read\(' test/ scripts/ --include=*.mjs); do
  grep -q "engine\.mjs" "$f" && echo "$f"
done | wc -l                                                                            # 50

# 21 个模块各自的外部 import 者（精确到解析后的路径）
#   —— 用 §1.3 表的数字：把下面 <mod> 换掉即可逐个复现
node -e '
const fs=require("node:fs"),p=require("node:path");
const ROOT=process.cwd(),out=[];
function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==="node_modules"||e.name[0]===".")continue;const q=p.join(d,e.name);e.isDirectory()?w(q):/[.](mjs|js)$/.test(e.name)&&out.push(q);}}
["src","test","scripts","lib"].forEach(d=>w(p.join(ROOT,d)));
const spec=t=>[...t.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?\bfrom\s*["\x27]([^"\x27]+)["\x27]/g)].map(m=>m[1]);
const target=p.join(ROOT,"src/rooms",process.argv[1]+".mjs");
const hits=out.filter(f=>f!==target&&spec(fs.readFileSync(f,"utf8")).some(s=>s.startsWith(".")&&p.resolve(p.dirname(f),s)===target));
console.log(process.argv[1], hits.length);
' <mod>          # 例：node -e '<上面整段>' kifu-model ⇒ kifu-model 59（含 engine 本身）
```

---

## 2 29 个命名导出归位表（六类）

### 2.1 计数口径（为什么是 29）

- `export (async )?function|const|class` 形态：**24** 个；
- `export { … }` 形态：**1 条语句、5 个名字**（4689 行，全部是 `rooms/closeout-plan.mjs` 的再导出）；
- **24 + 5 = 29**；`export default` 的类按用户口径不计入「命名导出」，但它同样是注册面（§3-⑧）。

### 2.2 归位表

`调用点` 最多列 3 处（行号无前缀 = `src/engine.mjs`）。`外部消费者` = engine 之外真正取这个名字的文件。

| # | 导出 | 定义行 | engine 内调用点 | 外部消费者 | 归类 |
|---:|---|---:|---|---|---|
| 1 | `archivedIdsFromChange` | 140 | 1502 | test/engine-harness.test.mjs:2549 | ① 归档判定 |
| 2 | `newlyArchived` | 166 | 1521 | test/engine-harness.test.mjs:2577 | ① 归档判定 |
| 3 | `buildFoldMarkUsage` | 187 | 4031 | test/engine-harness.test.mjs:2735 | ⑤ 统计与日志 |
| 4 | `isPermanentSummaryError` | 197 | 241, 3864 | test/engine-harness.test.mjs:2327, 2586, 2678 | ② 错误与重试 |
| 5 | `classifySummaryError` | 227 | 3844 | test/engine-harness.test.mjs:2611, 2808 | ② 错误与重试 |
| 6 | `summaryErrorHint` | 250 | 3855 | test/engine-harness.test.mjs:2809, 2813 | ② 错误与重试 |
| 7 | `retryMinDelayMs` | 277 | 3709 | test/engine-harness.test.mjs:2662 | ② 错误与重试 |
| 8 | `retryBackoffFor` | 283 | 3701 | test/engine-harness.test.mjs:2612 | ② 错误与重试 |
| 9 | `safeMeasureFoldQuality` | 478 | 2345, 3603, 3970 | test/fold-mark-sites.test.mjs:79（**源码文本**） | ③ 质量测量 |
| 10 | `summaryTextField` | 501 | 3616, 4042 | test/summary-text-coverage.test.mjs:128（**反向文本**） | ③ 质量测量 |
| 11 | `injectionErrorDelta` | 519 | 1918 | test/engine-harness.test.mjs:970-973 | ④ 注入 |
| 12 | `skipReasonKey` | 532 | 1940 | test/engine-harness.test.mjs:975-977 | ④ 注入 |
| 13 | `injectActionKey` | 549 | 1924 | test/engine-harness.test.mjs:979-982 | ④ 注入 |
| 14 | `bumpSkipReason` | 556 | 1942 | test/engine-harness.test.mjs:983-986；src/rooms/hot-inject.mjs:190（**只提及**） | ④ 注入 |
| 15 | `ledgerBudgetMetrics` | 567 | 959 | **无** | ⑤ 统计与日志 |
| 16 | `ledgerBudgetLogLevel` | 596 | 962 | **无** | ⑤ 统计与日志 |
| 17 | `ledgerBudgetLogLine` | 604 | 963 | **无** | ⑤ 统计与日志 |
| 18 | `accumulateLedgerBudget` | 625 | 961 | test/engine-harness.test.mjs:933 等 **15 处** | ⑤ 统计与日志 |
| 19 | `name` | 716 | **无**（806 的 `name` 是循环变量，遮蔽了它） | test/real-modules.mjs:139 | ⑥ 注册 |
| 20 | `Config` | 733 | 786（`static Config = Config`） | test/real-modules.mjs:140, 187；test/config-schema.test.mjs:167（**源码文本**） | ⑥ 注册 |
| 21 | `backfillSubagentRoute` | 753 | 2661 | **无** | ⑥ 注册 |
| 22 | `backfillSubagentOutcome` | 774 | 2728 | test/backfill-button.test.mjs:307-309 | ⑥ 注册 |
| 23 | `writeAutoBackfillState` | 4245 | 2861, 2996, 3169 | test/backfill-state-multi.test.mjs:215, 226 | ⑤ 统计与日志 |
| 24 | `collectGuardEvents` | 4536 | 4574 | test/engine-harness.test.mjs:3733, 3764 | ③ 质量测量 |
| 25 | `CLOSEOUT_MAX_FOLD_TOKENS` | **再导出** 4689（来源 31） | 2388 | test/engine-harness.test.mjs:2391, 2424；scripts/backfill-plan.mjs:21（**直连 rooms，不经 engine**） | ① 归档判定 |
| 26 | `closeoutExceedsLimit` | 再导出 4689（来源 31） | 2372 | test/engine-harness.test.mjs:2390；test/closeout-plan.test.mjs:5（直连 rooms） | ① 归档判定 |
| 27 | `planCloseoutChunks` | 再导出 4689（来源 31） | **无**（117 行只是注释在说它） | test/engine-harness.test.mjs:2414 | ① 归档判定 |
| 28 | `planChunkedCloseout` | 再导出 4689（来源 31） | 2387 | test/engine-harness.test.mjs:2497；test/closeout-plan.test.mjs:8（直连 rooms） | ① 归档判定 |
| 29 | `runChunkedCloseout` | 再导出 4689（来源 31） | 2427 | test/engine-harness.test.mjs:2445；test/closeout-plan.test.mjs:35（直连 rooms） | ① 归档判定 |

### 2.3 六类小计（合计必须 29）

| 类 | 条数 | 成员 |
|---|---:|---|
| ① 归档判定 | **7** | `archivedIdsFromChange` `newlyArchived` `CLOSEOUT_MAX_FOLD_TOKENS` `closeoutExceedsLimit` `planCloseoutChunks` `planChunkedCloseout` `runChunkedCloseout` |
| ② 错误与重试 | **5** | `isPermanentSummaryError` `classifySummaryError` `summaryErrorHint` `retryMinDelayMs` `retryBackoffFor` |
| ③ 质量测量 | **3** | `safeMeasureFoldQuality` `summaryTextField` `collectGuardEvents` |
| ④ 注入 | **4** | `injectionErrorDelta` `skipReasonKey` `injectActionKey` `bumpSkipReason` |
| ⑤ 统计与日志 | **6** | `buildFoldMarkUsage` `ledgerBudgetMetrics` `ledgerBudgetLogLevel` `ledgerBudgetLogLine` `accumulateLedgerBudget` `writeAutoBackfillState` |
| ⑥ 注册 | **4** | `name` `Config` `backfillSubagentRoute` `backfillSubagentOutcome` |
| **合计** | **29** | — |

**归类判据（写死，避免下一个人改口径）**：
- 「归档判定」= 决定**哪些会话刚被归档**、以及**归档收尾折叠要不要分段/怎么分**。收尾（closeout）是归档后的补偿动作，所以 5 个 `closeout*` 名字归这里，不另开一类。
- 「错误与重试」= 把摘要错误**分类**并给出退避参数；不含 TRANSPORT 循环本体（那不是导出）。
- 「质量测量」= 折叠后**量一下这次折得好不好**（`measureFoldQuality` 的包装、正文落盘三选一、守卫事件采集）。
- 「注入」= 热清单注入结果的**统计键**（是否算渲染失败 / 跳过原因 / append-or-replace）。
- 「统计与日志」= 把事实**记账**（usage 构造、预算指标、日志级别与文案、预算累计、补账进度落盘）。
- 「注册」= 插件**对外注册面**（名字、配置 schema、补账子代理的路由与结局契约）。

### 2.4 按「外部怎么碰它」分组（决定搬的先后顺序；与 §2.3 的六类是**另一个视角**，互不冲突）

| 组 | 条数 | 成员 | 搬走实现 + engine 保留 re-export，会怎样 |
|---|---:|---|---|
| A. `test/` 用 `mod.<name>` 取值 | **22** | harness 19 个 ＋ `name` ＋ `backfillSubagentOutcome` ＋ `writeAutoBackfillState` | **不破测试** |
| B. 只有源码文本断言碰 | **2** | `safeMeasureFoldQuality`、`summaryTextField` | **会红**（re-export 救不了，见 §4.2） |
| C. 完全没有外部消费者 | **4** | `ledgerBudgetMetrics` `ledgerBudgetLogLevel` `ledgerBudgetLogLine` `backfillSubagentRoute` | 不破测试；但**也没有独立测试盯着**，搬错了没人报 |
| D. `Config` | **1** | `Config` | **不许搬**：`z`（schemastery）只许在 engine，且 167 行文本断言钉死 |
| **合计** | **29** | 22 + 2 + 4 + 1 | — |

> 与 §2.3 的差别：六类按**职责**分（7/5/3/4/6/4），本表按**耦合强度**分（22/2/4/1）。
> 两套都必须合计 29 —— 若哪天对不上，说明有人在 engine 里新增/删了导出而没更新本图。

### 复现命令

```bash
cd "D:/主工作区/repos/dsh-GOkifu-compact"

# 29 = 24 + 5
grep -nE '^export (async )?(function|const|class)' src/engine.mjs | wc -l     # 24
grep -nE '^export \{' src/engine.mjs                                          # 4689（1 条，5 个名字）
sed -n '4689p' src/engine.mjs | tr ',' '\n' | grep -c .                       # 5

# 每个导出的定义行 + engine 内调用点
for n in archivedIdsFromChange newlyArchived buildFoldMarkUsage isPermanentSummaryError \
         classifySummaryError summaryErrorHint retryMinDelayMs retryBackoffFor \
         safeMeasureFoldQuality summaryTextField injectionErrorDelta skipReasonKey \
         injectActionKey bumpSkipReason ledgerBudgetMetrics ledgerBudgetLogLevel \
         ledgerBudgetLogLine accumulateLedgerBudget backfillSubagentRoute \
         backfillSubagentOutcome writeAutoBackfillState collectGuardEvents \
         CLOSEOUT_MAX_FOLD_TOKENS closeoutExceedsLimit planCloseoutChunks \
         planChunkedCloseout runChunkedCloseout; do
  printf '%-26s %s\n' "$n" "$(grep -n "\b$n\b" src/engine.mjs | cut -d: -f1 | tr '\n' ',')"
done
grep -nE '^export const (name|Config)' src/engine.mjs      # name=716  Config=733

# 外部消费者（engine 之外取这个名字的文件:行）
for n in archivedIdsFromChange newlyArchived buildFoldMarkUsage isPermanentSummaryError \
         classifySummaryError summaryErrorHint retryMinDelayMs retryBackoffFor \
         safeMeasureFoldQuality summaryTextField injectionErrorDelta skipReasonKey \
         injectActionKey bumpSkipReason ledgerBudgetMetrics ledgerBudgetLogLevel \
         ledgerBudgetLogLine accumulateLedgerBudget backfillSubagentRoute \
         backfillSubagentOutcome writeAutoBackfillState collectGuardEvents; do
  printf '### %s\n' "$n"
  grep -rn "\b$n\b" src/ test/ scripts/ lib/ --include=*.mjs | grep -v '^src/engine.mjs' | cut -c1-140
done

# harness 实际取了哪些 mod.*（= 搬走实现但保留 re-export 时，哪些仍必须存在）
grep -oE 'mod\.[a-zA-Z_]+' test/engine-harness.test.mjs | sort | uniq -c | sort -rn
```

---

## 3 七件事的行区间（全覆盖分区）

**读法**：下表 8 行是**八件事各自的定义区间**（连续、互不重叠，合计 705 行）；
其余 3984 行按「同一件事的**运行期接线** or 别的职责」列进 §3.2 的「杂项」，每块都写明是什么。
**705 + 3984 = 4689**，无空档、无重叠（§3.3 的自检命令会验证这一点）。

> ⚠ **两套编号不要混**：本节用「区间 1–8」（按行号顺序）；§2 用「六类 ①–⑥」（按职责）。
> 例如「注入」在 §2 是**类 ④**，在本节是**区间 5+6**。下文一律写「区间 N」指本节。

### 3.1 八件事的区间（合计 705 行）

| # | 这件事 | 区间 | 行数 | 区间里是什么 | 搬得动吗 |
|---|---|---|---:|---|---|
| 1 | **归档判定** | **140-174** | 35 | `archivedIdsFromChange`（认 `workspace/put/global` 形状）、`newlyArchived`（差分） | ✅ 纯函数零 import，**可直接搬** |
| 2 | **总结错误分类** | **197-260** | 64 | `isPermanentSummaryError` / `classifySummaryError` / `summaryErrorHint` | ✅ 纯正则，**可直接搬** |
| 3 | **重试退避** | **261-395** | 135 | `retryMinDelayMs` / `retryBackoffFor` / `TRANSPORT_RETRY_*` 常量 / `retryableTransportError` / `transportRetryDelayMs` / `throwIfOfflineFinishError` / `runWithTransportRetry` / `retryOfflineSummary` | ⚠ **拆两半**：两个纯函数（261-287）可搬；**289-395 用了 `LlmError`（dsh-llm）⇒ 不能搬** |
| 4 | **折量质量测量** | **472-511** | 40 | `safeMeasureFoldQuality`（诊断抛错降级为 null）、`summaryTextField`（正文三选一，避免图里存两遍） | ✅ 只依赖 `rooms/fold-quality` / 图字段，可搬（但见 §4.2 的文本断言） |
| 5 | **注入错误** | **512-523** | 12 | `injectionErrorDelta`（`skip` + `error:` 前缀 ⇒ 计一次渲染失败） | ✅ 纯函数，可搬 |
| 6 | **跳过原因统计** | **524-565** | 42 | `skipReasonKey` / `injectActionKey`（append vs replace）/ `bumpSkipReason`（有界 8 键） | ✅ 纯函数，可搬 |
| 7 | **预算指标与日志级别** | **566-707** | 142 | `ledgerBudgetMetrics` / `ledgerBudgetLogLevel` / `ledgerBudgetLogLine` / `accumulateLedgerBudget` | ✅ 纯函数，可搬（运行期在 951-1035，别一起搬） |
| 8 | **插件注册** | **716-950** | 235 | `name` / `zodField` / `Config` / `pickBase` / `resolveHome` / `backfillSubagentRoute` / `backfillSubagentOutcome` / `export default class` + `static inject` + `static Config` + 构造函数到 950 | ❌ **`zodField`/`Config` 用了 `z`（schemastery）⇒ 永不能搬**；类同理（`extends`）。`name` 是常量可搬但没意义 |

> **注意区间 3 的坑**：`retryMinDelayMs` / `retryBackoffFor` 与后面的 TRANSPORT 循环挤在同一个区间里，
> 但**只有前两个能进房间**。切房时必须按 261-287 / 289-395 拆，不能整段搬。

### 3.2 杂项（覆盖不到的行，24 块 / 3984 行）

| 区间 | 行数 | 是什么 |
|---|---:|---|
| 1-13 | 13 | 文件头 JSDoc（插件定位：官方事务安全 + 增量语义） |
| 14-49 | 36 | import 声明块（4 条 `@deepseek-ai/*` + 22 条 `./rooms/*` + 3 条 `node:*`） |
| 50-139 | 90 | 常量（`BASE_KEYS` / `FOLD_MARKS_KEEP=20` / `PRESSURE_MARK_MAX_SEQ_AGE=60` / `THRASH_SEQ=30`）+ **12 段孤儿 JSDoc**（多数是已搬去 `rooms/closeout-plan.mjs` 的函数留下的文档，**别当成还有实现**） |
| 175-196 | 22 | `buildFoldMarkUsage`（六类「统计与日志」）+ 空行 —— 被区间 1 与区间 2 切开 |
| 396-471 | 76 | 常量（`edgeSeq` / `FOLD_RETRY_BASE_SEQ=30` / `FOLD_RETRY_CAP_SEQ=480` / `COLD_GRAPH_QUIET_MS=15min` / `SEEN_IDS_CAP=4096`）+ `offlineAssemblerResult`（397-423，离线折叠结果读取）+ 3 段孤儿 JSDoc |
| 708-715 | 8 | 2 段孤儿 JSDoc（预算文件相对位置 / C288 单次折叠上限）+ 空行 |
| 951-1035 | 85 | **区间 7 的运行期**：`consumeLedgerBudget` / `getLedgerBudgetStats` / `#persistLedgerBudget` / `#recordPressure`（压力快照与节流） |
| 1036-1499 | 464 | 棋谱与图缓存层：`#sessionDir` `#graphPath` `#graph` `#runtimeFor` `#flush` `#scheduleFlush` `#noteFlush` `#isGraphPinned` `#markSeen` `#isRecentlySeen` `#invalidateFullFlush` `#pinGraph` `#unpinGraph` `#releaseColdGraph` `#sweepColdGraphs` `releaseColdGraphs` `getGraphCacheStats` `#bindKeeper` `#workspaceRegistry` `#sessionRef` |
| 1500-1540 | 41 | **区间 1 的运行期接线**：`#archivedIdsFrom`（取 registry 兜底）、`#onWorkspaceChange`（差分 → 只对本进程见过的会话 `#closeout`） |
| 1541-1735 | 195 | 归档收尾入口：`closeoutNow`（面板/脚本用）/ `#closeoutNowBody` / `#backfillIfPending` / `#writeUserRoute` |
| 1736-1873 | 138 | 归档收尾主体与结局记账：`#closeout` / `#recordCloseoutOutcome` |
| 1874-1960 | 87 | **区间 5 + 区间 6 的运行期接线**：`#bindLedger`（`agent/pre-step` 钩子；**1918-1921 注入错误计数**、**1924-1938 append/replace 分布**、**1940-1945 跳过原因计数**） |
| 1961-2369 | 409 | 摘要主链：`#markFoldMode` / `summarize`（唯一官方钩子）/ `compactRegion` / `#recordExternalFold` |
| 2370-2632 | 263 | 收尾折叠主链：`#closeoutTooBig`（★ 2371-2373 调 `closeoutExceedsLimit`）/ `#closeoutFold`（★ 2387 `planChunkedCloseout`、2427 `runChunkedCloseout`）/ `#summaryTarget` |
| 2633-2823 | 191 | 补账子代理：`runBackfillSubagentOnce`（2661 `backfillSubagentRoute`、2728 `backfillSubagentOutcome`）/ `runAutoBackfillOnce` |
| 2824-3225 | 402 | 自动补账调度：`#startAutoBackfill` / `#autoBackfillTick`（2861 / 2996 / 3169 落 `writeAutoBackfillState`） |
| 3226-3535 | 310 | 离线补折：`#tryOfflineCloseout` / `#offlineCloseoutFold` |
| 3536-3591 | 56 | `compactNow`（宿主 `/compact` 入口） |
| 3592-3628 | 37 | `recordFoldMark`（**区间 4 的运行期调用点：3603 `safeMeasureFoldQuality`、3616 `summaryTextField`**；另有 2540 行那套 `_lastSummaryFinishReason` 取值→清理顺序被文本断言钉住） |
| 3629-4077 | 449 | 触发策略主链：`#activeRange` / `compactIfNeeded` / `#compactIfNeededBody`（**区间 3 的运行期：3701 / 3709 退避；区间 2 的运行期：3844-3864 错误分类与永久错误闸门**；另含 4031 `buildFoldMarkUsage`（六类「统计与日志」，本节无独立区间）与 4042 `summaryTextField`（区间 4）） |
| 4078-4219 | 142 | `#selectRange` / `#tier2IfNeeded` / `#tier2IfNeededUnsafe` + **类结束（4218）** |
| 4220-4275 | 56 | 补账状态落盘：`LEGACY_BACKFILL_STATE` / `LATEST_BACKFILL_STATE` / `writeAutoBackfillState`（六类「统计与日志」）+ `ENGINE_BY_CTX` 的文档 |
| 4276-4688 | 413 | 模块级工具：`ENGINE_BY_CTX` `RESOLVE_ORDER` `resolveChess` `routedTarget` `resolvePolicy` `resolveSpec` `summarizeTarget` `checkpointSeqs` `hasPriorCheckpoint` `backfillState` `collectConstraintText` `edgeTouchedPaths` + 守卫一组（`RULE_LINE_FIELD_CHARS` `GUARD_ROLE_BY_EVENT_TYPE` `GUARD_ROLES` `GUARD_MAX_EVENTS` `VALUE_FACTS_LIMIT` `guardEventMessage/SourceKind/Role/Text`、**`collectGuardEvents`（六类「质量测量」）**、`guardSummaryOutput`、`collectValueFacts`、`ruleSummary`） |
| 4689-4689 | 1 | `export { … }` 再导出块（区间 1 的 5 个名字；真身在 `rooms/closeout-plan.mjs`） |

### 3.3 边界自检（必须自己会跑）

```bash
cd "D:/主工作区/repos/dsh-GOkifu-compact"

# ① 八件事合计 705 行，且互不重叠（区间已排序、首尾不接）
printf '%s\n' 140-174 197-260 261-395 472-511 512-523 524-565 566-707 716-950 \
| awk -F- '{c+=$2-$1+1} END{print "concerns="c}'        # concerns=705

# ② 全文件 4689 行；杂项 = 4689 − 705 = 3984
wc -l < src/engine.mjs                                  # 4689
#    705 + 3984 = 4689

# ③ 每条区间的首/末行（照抄核对边界）
for r in 140-174 197-260 261-395 472-511 512-523 524-565 566-707 716-950; do
  s=${r%-*}; e=${r#*-}; echo "== $r =="; sed -n "${s}p;${e}p" src/engine.mjs
done

# ④ 三处「区间不是全部」的证据：①④⑤⑥ 的运行期都在 1500+ / 1874+ / 3592+
grep -n "archivedIdsFromChange\|newlyArchived" src/engine.mjs      # 140,1502 / 166,1521
grep -n "injectActionKey\|skipReasonKey\|bumpSkipReason" src/engine.mjs   # 549,1924 / 532,1940 / 556,1942
grep -n "ledgerBudgetMetrics\|accumulateLedgerBudget" src/engine.mjs      # 567,959 / 625,961
```

---

## 4 风险清单：搬哪一条会红

### 4.1 `test/` 真正取用的是哪些导出（功能面）

**没有任何测试 `import` engine 的命名导出**；它们全都走 `test/engine-harness.test.mjs` 的
`load()` → `{ mod }`，再取 `mod.<name>`。所以「搬走实现 + engine 保留同名再导出」= 测试仍绿；
「搬走实现 + 删掉 engine 的导出」= **立即红**。逐条点名：

| 测试文件 | 取的导出 | 断在哪 |
|---|---|---|
| `test/engine-harness.test.mjs` | **19 个 + `default`**：`archivedIdsFromChange` `newlyArchived` `buildFoldMarkUsage` `isPermanentSummaryError` `classifySummaryError` `summaryErrorHint` `retryMinDelayMs` `retryBackoffFor` `injectionErrorDelta` `skipReasonKey` `injectActionKey` `bumpSkipReason` `accumulateLedgerBudget` `collectGuardEvents` `CLOSEOUT_MAX_FOLD_TOKENS` `closeoutExceedsLimit` `planCloseoutChunks` `planChunkedCloseout` `runChunkedCloseout` / `mod.default` | 2549 / 2577 / 2735 / 2327 / 2611 / 2809 / 2662 / 2612 / 970 / 975 / 979 / 983 / 933 / 3733 / 2391 / 2390 / 2414 / 2497 / 2445；`mod.default` → 263 |
| `test/real-modules.mjs` | `name`、`Config`、`default` | 139 / 140,187 / 135 |
| `test/backfill-button.test.mjs` | `backfillSubagentOutcome` | 307-309 |
| `test/backfill-state-multi.test.mjs` | `writeAutoBackfillState` | 215, 226 |
| `test/fold-mark-sites.test.mjs` | `safeMeasureFoldQuality`（**源码文本**，不是 mod.） | 79 |
| `test/summary-text-coverage.test.mjs` | `summaryTextField`（**反向源码文本**） | 128 |
| `test/config-schema.test.mjs` | `Config`（**源码文本**） | 167-170 |
| `test/closeout-plan.test.mjs` | `planChunkedCloseout` / `closeoutExceedsLimit` / `runChunkedCloseout` —— **直连 `rooms/closeout-plan.mjs`**，搬 engine 不影响它 | 5, 8, 35 |

`test/pending-changes.test.mjs:99` 里出现 `summaryTextField` 只是**夹具字符串**，不是消费者。

### 4.2 源码文本断言：**re-export 也救不了**（最容易被忽略的一类）

这 6 条断言**读 `src/engine.mjs` 的文本**，实现或调用点一挪走就红：

| 断言位置 | 钉住的文本 | 后果 |
|---|---|---|
| `test/config-schema.test.mjs:167` | engine 必须含 `SCHEMA.map((entry) => [entry.key, zodField(entry)])` | **`Config` 定义永远不能离开 engine** |
| `test/config-schema.test.mjs:166` | engine 必须含 `from "./rooms/config-schema.mjs"` | engine 必须继续 import 该房 |
| `test/config-schema.test.mjs:168` | engine **不许**再出现 `thresholdRatio: z.number().default(0.45)` | 手写 schema 不许复活 |
| `test/config-schema.test.mjs:169` | engine 必须含 `resolveConfig(c)` | `resolveChess` 的委托不许断 |
| `test/engine-harness.test.mjs:2348` | engine 必须含 `if (isPermanentSummaryError(st.lastFoldError))` | **这个调用点不许搬出 engine**（函数本体可搬） |
| `test/engine-harness.test.mjs:2673` | engine 必须含 `const minDelay = retryMinDelayMs(` | **调用点不许搬** |
| `test/engine-harness.test.mjs:2540-2546` | `recordFoldMark` 体内 `const finishReason = this._lastSummaryFinishReason ?? null;` 必须早于 `this._lastSummaryFinishReason = undefined;`，且两者都在 `mark` 构造之前 | `recordFoldMark` 不许整体外移（顺序敏感） |
| `test/fold-mark-sites.test.mjs:79` | `recordFoldMark` **函数体**必须出现 `safeMeasureFoldQuality` | 调用点不许搬（除非同步改测试） |
| `test/summary-text-coverage.test.mjs:128` | tier2 的 `foldMarks.push` 那一行**不许**出现 `summaryTextField` | 反向约束：别为了"统一"给 tier2 补正文 |

> 另有 **50 个文件**（35 test + 15 scripts）会 `readFileSync("src/engine.mjs")` 做类似断言，
> 本表只列与本图 29 个导出**直接相关**的 6 处；搬动前建议先跑
> `grep -rn "engine\.mjs" test/ | wc -l` 自查影响面（见 §4 末命令）。

### 4.3 `scripts/check-maintenance.mjs` 与 `scripts/doctor.mjs`：**0 引用**

任务书假设这两个脚本引用 engine 的导出 —— **实测不成立**：

```
$ for n in CLOSEOUT_MAX_FOLD_TOKENS planChunkedCloseout planCloseoutChunks runChunkedCloseout \
           closeoutExceedsLimit accumulateLedgerBudget ledgerBudgetMetrics collectGuardEvents \
           writeAutoBackfillState backfillSubagentRoute; do
    printf '%-26s cm=%s doctor=%s\n' "$n" "$(grep -c "$n" scripts/check-maintenance.mjs)" "$(grep -c "$n" scripts/doctor.mjs)"
  done
（全部 cm=0 doctor=0）
$ grep -c "engine" scripts/check-maintenance.mjs scripts/doctor.mjs      # 0 0
```

**真正跨文件钉住 engine 的不是这两个脚本，而是**：

| 契约 | 位置 | 破了会怎样 |
|---|---|---|
| 子路径 `./engine` | `package.json` `exports["./engine"]` | `cordis.patch.yml` 的 `name: 'dsh-gokifu-compact/engine'` 解析不到 ⇒ **插件挂不上** |
| 插件名 | `export const name`（716）与 `src/rooms/preset-format.mjs:19` 的 `PKG_NAME`、`cordis.patch.yml:16` 的 `name:` | 名字不一致 ⇒ preset 块与运行时不是同一个包（`test/bundle.test.mjs:25` / `preset-discovery.test.mjs` 盯这条） |
| harness 的 4 处字符串替换 | `test/engine-harness.test.mjs:92-96` | 见 §4.5(a) |
| `rooms` 登记表 | `test/rooms.test.mjs` 的 `ROOMS`（28 项） | 见 §4.4 |

### 4.4 `rooms` 门禁（R-A…R-F + 4 条结构性）会拦住哪些搬法

| 门禁 | 判据（`test/rooms.test.mjs`） | 会拦住的具体搬法 |
|---|---|---|
| **C1/R-C** | `c1Violations`（368-378）+ 用例 549：`@deepseek-ai/*` 的 import **只许出现在 `src/engine.mjs`**，且 R09 的说明符集合**恰好**是那 4 个（347-352） | 把 `Config`/`zodField`（用 `z`）搬走 ⇒ 红；搬 `summarize`/`compactRegion`（用 `BlockAssembler` `LlmError` `contentHasImage` `createUserMessage` `toolPairingBalanced*`）⇒ 红；搬默认类（`extends BasicCompactionEngine`）⇒ 红 |
| **每个房间的 `forbid`** | `ROOMS` 每项 `forbid: [/^@deepseek-ai\//, /(^|\/)engine(\.mjs)?$/, /(^|\/)scripts\//, /(^|\/)lib\//]`；`roomDependencyViolations`（204-220） | ① 新房 import 宿主包 ⇒ 红；② **房间反向 import engine ⇒ 红**（所以"把函数搬进房间、房间再回调 engine"这条路不存在，搬出去的东西必须**自足**） |
| **C3 登记** | `src/rooms/` 下每个 `.mjs` 必须在 `ROOMS` 里有一行（反向也成立）；未登记 ⇒ `(未登记)` | **新建房间但忘了登记 ROOMS = 直接红**（这是切房最常见的翻车点） |
| **`allowed` 白名单** | 每个 specifier 必须命中该房 `allowed` 前缀，否则 `not-allowed` | 新房若 import `./kifu-model.mjs`，必须在 `allowed` 里写它 |
| **最终路径** | `roomPathViolations`（355-363）：`entry.file === <id>.mjs` 且文件真实存在 | 房间名与 id 不一致（如 `rooms/archive-rule.mjs` 登记成 id `archive`）⇒ 红 |
| **顶层白名单** | `SRC_TOP_LEVEL_ALLOWED = ["engine.mjs","ui.mjs"]`（281）+ 用例 517 | **不能在 `src/` 顶层新建文件** —— 搬出去的东西只能进 `src/rooms/` |
| **`DELETED_FACADES`** | 8 个名字（278）：`verifier` `range` `worldstate` `graph` `keeper` `extract` `ledger` `summary-prompt` 不许在 `src/` 顶层复活、也不许被任何文件 import | 想把②（错误分类）做成 `summary-prompt.mjs`、或把①做成 `range.mjs` ⇒ **红**；给房间起名必须先避开这 8 个 |
| **R-A** | `findReverseDependencies`（250-256）+ 用例 421 | 新房 import `../scripts/…` 或 `../lib/…` ⇒ 红 |
| **R-E** | `rEViolations`（381-393）+ 用例 559 | engine import `rooms/migrate.mjs` ⇒ 红（「禁止 engine 启动钩子」的机器判据） |
| **R-F** | `bannedTokenHits`（395-404）+ 用例 571 | 新房/新脚本出现 `allowedModels` 字样 ⇒ 红 |

> **一句话结论**：搬动**实现**只有一条合法路径 ——
> 新建 `src/rooms/<新id>.mjs` → 在 `ROOMS` 登记（`file`/`allowed`/`forbid`）→ engine 改成 `import` + **保留原有导出**。
> 任何"顺手改个路径""在 `src/` 顶层放个文件""让房间反过来调 engine"都会在 `node test/run.mjs rooms` 里红。

### 4.5 三条最不显眼、但会立刻炸的

**(a) harness 靠字符串替换 4 行宿主 import —— 那 4 行必须逐字留在 engine.mjs**
`test/engine-harness.test.mjs:92-96`：
```js
.replace(`from "@deepseek-ai/schemastery"`,          `from "./.harness-stubs/stub-schemastery.mjs"`)
.replace(`from "@deepseek-ai/dsh-compaction-basic"`, `from "./.harness-stubs/stub-basic.mjs"`)
.replace(`from "@deepseek-ai/dsh-compaction"`,       `from "./.harness-stubs/stub-compaction.mjs"`)
.replace(`from "@deepseek-ai/dsh-llm"`,              `from "./.harness-stubs/stub-llm.mjs"`)
```
这 4 行一旦被改写（换引号风格、拆成多行、挪到别的文件、加 `as`），替换就**静默失配**，
harness 的副本会去 import 真宿主包 ⇒ **加载期就崩**，全量测试红成一片但报错指向很偏远。

**(b) 副本必须放在 `src/` 下，所以 `./rooms/*` 相对路径不能变**
`test/engine-harness.test.mjs:24-27`：副本写到 `src/.engine-under-test.mjs`（**不是 test/**），
就是为了让 `./rooms/xxx.mjs` 能解析。⇒ engine 对房间的引用**只能是 `./rooms/…`**，
而 `src/` 顶层白名单又不许放新文件 —— 两条合起来把"搬去哪"锁死在 `src/rooms/`。

**(c) 4689 行的 `export { … }` 看着像"重复导出"，删了必红**
这 5 个名字在 engine 里**没有定义**（定义在 `rooms/closeout-plan.mjs`），只有这一行转手。
删掉它 ⇒ `mod.CLOSEOUT_MAX_FOLD_TOKENS` 等 **24 处 `mod.` 断言**（23 行，2389-2516）全红；
反过来，真身已经在房间里，所以**不要**为了"归位"把这 5 个函数抄回 engine。

### 复现命令

```bash
cd "D:/主工作区/repos/dsh-GOkifu-compact"

# §4.1 功能面：harness 实际取用的 mod.*
grep -oE 'mod\.[a-zA-Z_]+' test/engine-harness.test.mjs | sort -u
grep -rn "mod\.name\|mod\.Config" test/real-modules.mjs
grep -n "mod\.backfillSubagentOutcome" test/backfill-button.test.mjs
grep -n "mod\.writeAutoBackfillState"  test/backfill-state-multi.test.mjs

# §4.2 源码文本断言（6 处）
grep -n 'SCHEMA.map((entry) => \[entry.key, zodField(entry)\])' test/config-schema.test.mjs
grep -n 'isPermanentSummaryError(st.lastFoldError)' test/engine-harness.test.mjs
grep -n 'const minDelay = retryMinDelayMs('           test/engine-harness.test.mjs
grep -n 'safeMeasureFoldQuality'                     test/fold-mark-sites.test.mjs
grep -n 'summaryTextField'                           test/summary-text-coverage.test.mjs
grep -n '_lastSummaryFinishReason'                   test/engine-harness.test.mjs

# §4.3 「0 引用」的证据
grep -c "engine" scripts/check-maintenance.mjs scripts/doctor.mjs      # 0  0
grep -n '"\./engine"' package.json                                    # exports 子路径
grep -rn "PKG_NAME" src/rooms/preset-format.mjs cordis.patch.yml | head -3

# §4.4 门禁定义与现状（rooms 门禁共 15 条用例）
grep -n "SRC_TOP_LEVEL_ALLOWED\|DELETED_FACADES\|R09_DEEPSEEK_SPECIFIERS" test/rooms.test.mjs
grep -c 'forbid:' test/rooms.test.mjs        # 28 = ROOMS 表项数（28 房）
awk 'NR>=420 && /^  "/{c++} END{print c}' test/rooms.test.mjs   # 15 = rooms 门禁用例数
node test/run.mjs rooms 2>&1 | tail -3       # 架构有没有被破坏的唯一判据

# §4.5 harness 的字符串替换与副本位置
sed -n '23,27p;92,96p' test/engine-harness.test.mjs
sed -n '4689p' src/engine.mjs
```

---

## 5 我没能确定的部分

1. **本图是静态测绘，没有运行期计数**。文中「调用点」全部来自 `grep`；若某条路径在实际会话里
   从不执行（例如 `factGuard:false` 时的 `collectGuardEvents`），图上仍会显示"有调用点"。
   要确认真实调用频次，需要插桩跑真机会话 —— 不在只读范围内。
2. **`planCloseoutChunks` 在 engine 内零调用**（`grep` 只命中定义行 31、注释 117、再导出 4689）。
   我确认它被 `rooms/closeout-plan.mjs:92`（`planChunkedCloseout` 内部）调用，所以它**不是死代码**，
   但"engine 从不用它"这一点只能靠静态判断，没有运行期证据。
3. **`name` 的 engine 内使用我判为「无」**：`806` 的 `for (const name of [...])` 是循环变量，
   遮蔽了模块级 `name`；其余命中（2901、3534、4253-4254）都是别的局部 `name`。若将来有人在类里写
   `static name` 之类，需要重查。
4. **`test/run.mjs` 基线 2569/2/0 是我这一次跑的**。仓库里同时有其它工作在进行（我第一次跑时
   `.harness.lock` 被另一个 `node test/run.mjs` 占着，等了 300 秒退出），数字随时会因他人改动漂移；
   引用时必须带时点。
5. **`docs-index-check` 是红的，而且它会让 `node test/run.mjs` 也红 1 项 —— 这是本文档的必然副作用，不是代码回归**。
   `test/docs-index-check.test.mjs` 的 `D-3` 用例（33-37 行）对**真实仓库**跑 `checkRepo()` 并断言 `ok === true`，
   所以只要本文档没登记进 `docs/README.md`，全量就会多 1 个 failed。实跑：

   ```
   $ node scripts/docs-index-check.mjs
   == 文档索引检查（172 个文件 · docs/research/README.md · evidence/README.md · docs/README.md · docs/knowledge/README.md）==
     ✗ docs/测绘-engine归位图.md —— 没出现在 docs/README.md 里

   ❌ 未索引文档 1 个
   $ echo $?
   1
   ```

   按分工 `docs/README.md` **不由我改**（另有人在同位置写索引，由 Lead 统一登记），
   所以这 1 项要等 **Lead 在 `docs/README.md` 加一行**之后才会转绿。
   **不要为了让门禁变绿去动 `docs/README.md`，也不要把这条红当成"代码坏了"。**
6. **「搬走之后 harness 还能不能加载」我没有实测**。§4.2 / §4.5 的结论来自读 harness 源码
   （`readFileSync` + 4 次 `replace` + 写 `src/.engine-under-test.mjs`），
   没有做「真的搬一个函数出去再跑测试」的实验 —— 那会改 `src/`，超出本任务边界。
7. **`lib/client.js` 侧没有任何 engine 依赖**（0 条 import），但 `name` / 配置键会经 preset 与 HTTP 落到
   浏览器半；这条链（`preset-format` → `cordis.patch.yml` → `lib/client.js`）我只验证了文本存在，
   没有验证端到端生效 —— 那属于「生产是否生效」三态里的第三态，本图不覆盖。

---

## 附：本次未改动的文件（供 Lead 对账）

```
git status --short          ⇒ 只有 4 个未跟踪的 cordis.patch.yml.bak-before-ui-*（他人遗留）
git diff --stat HEAD -- src/ test/ scripts/ lib/ docs/README.md   ⇒ 空
```

新增文件只有这一个：`docs/测绘-engine归位图.md`。