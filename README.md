# dsh-GOkifu-compact

<img src="assets/icon-180.png" width="88" height="88" alt="">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.18.5-green.svg)](https://github.com/MYCF711/dsh-GOkifu-compact/releases)
[![npm](https://img.shields.io/npm/v/dsh-gokifu-compact.svg)](https://www.npmjs.com/package/dsh-gokifu-compact)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-orange.svg)](https://github.com/topics/dsh-plugin)

> **一句话**：给 DSH 会话换一个**上下文压缩后端** —— 把「历史 → 一段摘要」换成
> 「历史 → 可复盘的棋谱 DAG + 每步一份极小的热清单」，**失败记忆逐字保留，模型没有丢掉它的权限**。
>
> GO = 围棋，kifu = 棋谱，compact = 压缩。一局棋下完，棋谱上不只有落子顺序，还有每一手的评语。
> 这个插件把 agent 的每一步变成**一手棋**（节点 = 状态）、把当时的思考变成**评语**
> （目标 / 约束 / 失败原因，边 = 尝试 + 验证信号），整个任务变成一局可以复盘的棋。
> **棋谱是给模型用的，不是给人看的** —— 热清单里的每个字都为模型决策服务。

## 它做什么

| 能力 | 工具 / 入口 | 说明 |
|---|---|---|
| **增量 fold** | 自动（`thresholdRatio` 0.45 + `growthFloorTokens` 40K）/ 手动 `/compact` | 只压「上一个 checkpoint 之后」的新内容；**一段历史一生只被摘要一次**，不重摘 |
| **失败记忆** | 热清单的 `LEARNED` 段 | 每条失败尝试的意图 / 动作 / 报错原文 / seq 由**规则**抽取并**逐字**保留；模型无权丢弃 |
| **手割（tewari）** | `src/rooms/kifu-model.mjs` 的 tewari 渲染 | 同一条失败边相对**每条**成功路径分别给结论：同型 / 绕路 / 探新，不是一个笼统的「失败」 |
| **热清单** | 每步 `agent/pre-step` 注入（`hotLedger`） | 语义标记（`blocked:permission` / `dead retry-if:e1`）+ 动态图例 + 报错原文；**就地替换**，surface 上永远只有一条 |
| **置换检测** | `transposition` 开关 | 状态哈希命中历史节点时不新建分支，只在图上加一条边，并提示「回到节点 N —— 这里试过的路都记着」 |
| **三层树** | `<DSH_HOME>/chess-context/sessions/<sid>/` | `index.md`（全量索引）/ `nodes/<id>.md`（单节点细节）/ `graph.json`（数据源），模型按需往下查 |
| **压缩永不失败** | 摘要三层降级 | 配置的摘要模型 → 当前路由模型 → 规则摘要（**零模型调用**），fold 一定能落地 |
| **可诊断** | `doctor` / `handoff-check` / `live-folds` / `status` | 一条命令体检、按真实 usage 对账、回洗历史误报 |
| **归档收尾** | `closeoutFold`（挂在 `domain/changed`） | 归档一个会话时补做一次折叠（尾巴 ≥ `closeoutMinEvents` 才花模型调用） |
| **补账** | 面板「补折」卡 / `scripts/backfill-plan.mjs` | 归档那一刻没压完的会话，账是欠着的；一键补：取消归档 → resume → 收尾折叠 → 原样归档回去 |
| **面板** | `POST /gokifu/api`（复用同一套信任检查，**不新开路由**） | 状态 / 检查更新 / 补折 / 最近活跃会话（含**已修正失败**占比）/ 今天（含**折叠成本估算**）/ 配置 |

**怎么工作**：

```
每一步：事件流 ──► 棋谱 DAG（节点 = 状态；边 = 尝试 + 验证信号）
                        │
                        ▼
             热清单（根目标 / 约束 / 成功路径 / 失败边）──► 注入模型
                        │
             到阈值（默认窗口 45% 且增量 ≥ 40K）
                        ▼
             增量 fold：只压上一个 checkpoint 之后 ──► 棋谱摘要（失败边逐字保留）
```

**和官方 `dsh-compaction-basic` 的区别**：

| | 官方 `compaction-basic` | 本插件 |
|---|---|---|
| 压缩范围 | 从 surface 第一个非 system 节点起（**含上次 checkpoint**） | 上一个 checkpoint **之后** |
| 保留率 | 每轮重摘 → 按 ρ^k 衰减（实测安全规则 5 轮后剩 10%） | 一段内容只摘一次 |
| 失败记录 | 融进散文摘要，模型可以丢 | 规则抽取 + 逐字注入，模型无权丢 |
| 热上下文 | 无 | **417 tokens** / 步（2000 边合成夹具 · L5 降级档），带语义标记与报错原文 |

> 热清单的几个口径（**417 是合成夹具、真实会话 p50 = 419、p90 = 521**）单独放一页，
> 因为它们是审计语言不是介绍语言：[`docs/指标口径.md`](docs/指标口径.md)。

## 1.18 有什么新变化

从 1.17.6 到 1.18.5 的改动里，**使用者能感知到的那部分**（完整清单见 [CHANGELOG.md](CHANGELOG.md)）：

1. **补折不再弹会话，也不再"假成功"**（C576–C585）—— 点一下派**无头子代理**，用「上下文压缩设置」里的
   默认 provider / model 直连摘要，并核验结果**真的落盘**（`foldMark` 有记录才算数）。
   面板可以选 provider 与模型。此前它连一个可供调用的会话壳都没有，适配器一读 `session.requestHeader()` 就抛。
2. **手动折账不再跨会话串区间**（C655）—— `/compact` 只消费本次宿主返回的
   `result.shadowedRange` / `shadowedTokenCount`，删掉了会被另一会话污染的区间载体。
3. **约束只差空白排版时，就地还原成逐字原文**（C653）—— 真实 `constraintRecall` 从 0 / 0.5 回到 **1**，
   而且不重复补段。
4. **只剩残留失败的会话不再显示成"没有失败账"**（C654）—— 保留「无终点残留」计数与 `graph.json` 指针。
5. **输入裁切不再误报成压缩出错**（T90）—— 仅输入裁切 / 历史截断状态未知时保持「正常」，
   输出截断与 host 错误仍然报红。
6. **`doctor` 导入失败会真实返回失败**（C652）—— 不再把「检查没跑起来」显示成 0 错误。
7. **面板改成三枚互斥 tab**（总览 / 折痕 / 配置），补折卡上移到「最近活跃会话 / 检查更新」之前；
   组件、样式、事件、模型选择器、按钮文案与空态**全部复用**，没有新造。
8. **质量评测有结论了**（K-27 / K-26 / K-2，1.18.3–1.18.5）—— 真实 reader 正式 50/50 在 kimi v1e 上
   **六条门槛全绿**，但那是**带确定性后处理**的 PASS，不是裸模型能力；工具结果每步清理（K-2）在受控
   10 会话上是 `CANDIDATE`（省约 112 万 tokens），**仍不默认开启**。

## 界面

DSH 的「上下文压缩」面板（`POST /gokifu/api`）。**信息架构是三枚互斥 tab**，复用官方自动化任务页的
filter chip 与结构树：

| 位置 | 是什么 |
|---|---|
| **总览** | **一级信息**：状态卡（正常 / 未启用 / 出错 / 检查中 + 一句话原因）、今日投入产出、**最近 5 条折痕**（有更新横幅时收到 3 条）、运行诊断与操作。宽屏状态 / 今日**并排**，窄屏回单列 |
| **折痕** | **二级完整列表**：全部 `foldMark`（触发原因 / 区间 / 保真度 / 闭包 / 边界） |
| **配置** | **三级**：摘要 provider 与模型、阈值固定档位（45% / 50% / 65% / 75% / 85%）、增长闸、保留比、热清单预算、标记档位…… |
| **顶部横幅** | 有新版本时出现，给**可复制的升级命令**（**只拼命令，绝不执行安装**） |
| **补折卡** | 一条「检查欠账（**不调模型**）」看清单，一条「开始补账」；干跑会先给出预计花费与分段提示 |

二级 / 三级内容**默认收起**，只在各自 tab 挂载 —— 首屏高度留给状态与折痕，不再把所有指标一次铺开。

**成本估算是估算**：价目用 DeepSeek 官方 `deepseek-flash` **峰谷两档**
（命中 $0.003 / 未命中 $0.15 / 输出 $0.6 每 1M tokens，低峰价；高峰按官方「off-peak rates are half of
the peak rates」翻倍），**不含宿主侧的 system / tools 开销**；没有 usage 的 fold 不参与计算，
页面会标出「N 次有 usage」。补账跑的是**冷缓存**（归档会话闲置后缓存已清空）⇒ 每次折叠按全额输入价计费。

## 环境要求

- **DeepSeek Harness** `^0.2.0-rc.2`（`package.json` 的 `engines.dsh`）
- **Node ≥ 20**（`engines.node`；宿主自带）
- **零运行时依赖** —— `dependencies` / `devDependencies` 都是空对象；`peerDependencies` 里的
  `@deepseek-ai/*` 由宿主提供，**不装、不发**（见 [SECURITY.md](SECURITY.md)）
- 不需要 GitHub / npm 凭证，不需要网络（除宿主自己的模型路由）

## 安装

**装进 profile**（DSH 插件不是 `npm i` 就生效，要装到 profile 里）：

```bash
# 装到默认 profile（--profile 是**必填**的：不传就没有 profile 可解析）
dsh plugin --profile desktop add dsh-gokifu-compact

# 锁定版本
dsh plugin --profile desktop add dsh-gokifu-compact@1.18.5

# 本地开发：直接装这个目录（会以 file: 硬链接方式挂进 profile）
dsh plugin --profile desktop add <本仓库路径>
```

> ⚠ **目标是 `desktop` profile 时，必须用 Desktop 自带的 CLI 包装器**
> （`<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`）。PATH 里的普通 `dsh` 二进制会以
> `profile desktop is managed exclusively by the Electron application` 直接拒绝。
>
> `npm i dsh-gokifu-compact` 只会把它下载到本地 `node_modules`，**不会**让 DSH 加载它 ——
> 包里的 `dsh.bundle.patch` 要由 profile 的安装流程来读。

**装上即接管，不需要选模式。** 本包自带 `dsh.bundle.patch`：装进 profile 后会自动进
`dsh.profile.bundles`，并由这一个包同时完成两件事 ——

1. 插入 UI 页（`/gokifu/api` + 设置页）；
2. **按 id 整体覆盖四个官方 agent preset 的 `config`**：把每个 preset 的 compaction group 里
   `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine` ——
   标准 / PTC / 极简 / 创造四个模式都变成棋谱压缩，模式本身与选择器不变。

⇒ **不新增 preset、不改「新会话默认 preset」**，所以也不会多出一个要学的模式。
桌面版最省事的是**插件市场 → 安装**（点一下）。

然后**重启 DSH**（bundle 层在启动时合并）。重启后随便选个模式发一条消息，压缩就是棋谱压缩了。

> ⚠ **压缩后端只能有一个**：patch 覆盖后，四个 preset 的 compaction group 里都只有
> `dsh-gokifu-compact/engine`（`test/bundle.test.mjs` B-2 与生成器都有机器判据）。
> 若之前装过 1.15.x 的 `dsh-gokifu-preset` 包（或 profile 里留着 `preset-gokifu` 行），
> 先 `dsh plugin --profile <p> remove dsh-gokifu-preset`，否则同名 preset 会重复注册。
>
> ⚠ **`cordis.patch.yml` 是生成物**：里面的 preset 清单是**按宿主版本生成的快照**。
> DSH 升级后需要维护者重跑 `node scripts/make-presets-override.mjs --write` 并发一版新插件
> （生成器有「不新增 preset / 引擎行恰好 4 条 / `!!js` 表达式逐字保留」的机器判据，漏了会拒绝产出）。
> 详见 [UPDATING.md](UPDATING.md)。

**从源码（开发用）**：

```bash
node scripts/make-presets-override.mjs           # dry-run：看将从当前宿主 asar 生成什么
node scripts/make-presets-override.mjs --write   # 重写仓库根的 cordis.patch.yml
dsh plugin --profile <profile> add <本仓库路径>
```

完整的陪装剧本（含一次一问、验收六步）见 [SETUP.md](SETUP.md)。

## 一次真实运行长什么样

**真机数字，全部来自 `evidence/`（生成物，勿手改）**：

| 指标 | 值 | 来源 / 复跑 |
|---|---|---|
| live fold | **1674 次 / 633 会话**（quality 1667 次样本） | `evidence/live-folds.json` · `node scripts/live-folds.mjs --write` |
| 压缩比 | **11.41 – 309.1** | 同上 |
| `failureRecall` 最小 | **0**（有 1 次掉到 0 —— **别再说「召回全 1」**） | 同上 |
| `constraintRecall` 最小 | **0.667** | 同上 |
| boundary 切点落在工具调用中间 | **153 次全 0** | 同上 |
| `foldThrash`（死循环式折叠） | **0** | 同上 |
| 缓存命中率 | **94.2%**（分母 = 未命中 + 命中；33,896 次请求 / 136 个会话文件） | `docs/真机基准-自动生成.md` · `node scripts/live-bench.mjs --write` |
| 全量花费估算 | **$131.91**（最贵 5 个会话占 **71%**） | 同上 |
| 折叠耗时 | 71 次 fold：中位 **11.5s** / p90 **19.5s** / max **61.7s** | 同上 |
| 热清单 | **417 tokens**（2000 边合成夹具 · L5 降级档）· 真实会话 **p50 = 419** / p90 = 521 | `evidence/bench-2000.json` · `evidence/ledger-calibration.md` |

**一次典型的执行序列**：

1. 插件在 `agent/pre-step` 注入 `<chess-ledger>`（内容不变时复用；变了就**就地替换**上一条）；
2. 每个工具结果被判定 `success` / `failure` / `unverified`，失败原因进棋谱（**规则判定，不问模型**）；
3. 上下文到窗口 **45%** 且距上次 fold 增长 **≥ 40K tokens** ⇒ 触发增量 fold；
4. fold 摘要写进 `graph.json` 的 `foldMarks[]`，带 `trigger` / `closure` / `boundary` / `quality` 四个观测字段；
5. 归档一个会话时补做一次收尾折叠，结局写回 `graph.closeout`（成功 / 无可折 / 失败三种）。

> 想知道**你自己**机器上的现状：`npm run status` 一条命令给出「门禁 / 全量测试 / doctor / 面板能力 /
> 补账规模 / 真机基准」六行结论。

## 安全边界

- **零网络面**：插件**不监听任何端口、不发任何出站 HTTP**。唯一的网络动作是调用**宿主注入**的摘要模型
  （`ctx.llm`），走宿主自己的路由与凭证。
- **零依赖**：`dependencies` / `devDependencies` 都是空对象。供应链面 = 本仓自己的 `src/` + `scripts/`。
- **凭证不经过模型，也不经过本插件**：插件不读 keyring、不读 token 文件；落盘的
  `graph.json` / `graph.json.delta.jsonl` 里**没有凭证字段**。
- **模型可见文本只陈述事实**：热清单**不许**出现行动指导（「下一步：…」「不要重试」「you should」）、
  认知指令（「treat as…」「you can…」）、工具治理开关（`permission` / approval / sandbox）。
  由 `node scripts/boundary-audit.mjs` 的 **6 条规则**机器看守，**0 条**才算过。
- **路径不回显**：模型可见文本一律相对化为 `sessions/<sid>/graph.json`、`nodes/<n>.md`
  （Windows 反斜杠曾让掩码整段漏出，已修）。
- **写入面**：只写 `<DSH_HOME>/chess-context/`。**不写**用户仓库、**不写** `profiles/*/cordis.patch.yml`
  （那是安装器的活，且带 `.bak-before-chess-context-<ts>` 备份与回滚）。
- **`graph.json` 是明文**：里面是你的会话目标、约束、工具报错原文。分享前请自行脱敏。

细节与「不构成漏洞的情况」见 [SECURITY.md](SECURITY.md)。

## 已知限制

- **`graph.json` 在回合内落后一回合**（增量落盘）：它 = **上一回合基线的完整快照**，
  `graph.json.delta.jsonl` = 本回合的增量帧。外部工具直接 `JSON.parse(graph.json)` 当「最新」**会少一回合数据**。
  正确读法：`fromJSON(graph.json 文本)` → 用基线内容哈希 `decodeDeltaFrames(delta 文本, baseHash)` →
  逐帧 `applyDelta(g, frame)`。三个函数都从 `dsh-gokifu-compact/graph` 导出
  （源码 `src/rooms/kifu-model.mjs`）；落盘 / 读盘侧（`graphRoot` / `sessionPaths` / `createPersistStore` 等）
  走 `dsh-gokifu-compact/persist`（源码 `src/rooms/kifu-persist.mjs`）。
- **只覆盖四个官方 preset**。第三方插件自带的 preset（例如 `dsh-design-studio` 的「设计模式」）可能在
  自己的 bundle patch 里重新声明 `compaction-basic` —— 那个模式下就是**原生压缩**。强覆盖别人的 preset
  属于越权且会被对方升级冲掉，所以本插件**只登记不覆盖**：`doctor` 的「第三方 preset 的压缩后端」会点名。
- **服务端改动要重启宿主才生效**（`src/**` 走 ESM 启动时加载；`lib/client.js` 改动刷新即可）。
  在 `link:` 安装下，改完代码不重启 = 跑的还是旧构建。判据看 `build.json` 的 `buildId`，**别看启动时间戳**。
- **压缩会让 prompt 缓存失效一部分**：DSH 的 surface `replace` 语义决定替换点之后的 KV 前缀会失效。
  增量 fold 让替换点尽可能靠后，但**无法消除**（这是 seam 的语义，不是实现选择）。
  真实会话实测缓存命中率 **94.2%**。
- **子代理各自独立会话、各自一张棋谱**；主会话的置换提示只在同一会话内生效。
- **跨平台未验证**：`appendFileSync` 的半写测试只在本机 NTFS 上过过，**网络文件系统未验证**。
- **真机走查未做**：面板两套主题的像素级对照、键盘 Tab 顺序 —— 只有静态断言，没有自动化手段。
- **纯读的估算有盲区**：token 按字符估，**图片不计**（Files API 证实图片是独立通道）⇒ 有图会话的估算偏低。

## 开发

```sh
node test/run.mjs                        # 全量单测（**必须串行** —— 并发会抢 test/.harness ⇒ 假红）
node scripts/boundary-audit.mjs          # 越界审计（行为指导 / 工具治理，0 条才算过）
npm run gate                             # 8 判分门 + 5 条参考门（发版前跑全量，不是 --fast）
```

| 质量基线 | 值 |
|---|---|
| 全量测试 | `node test/run.mjs` → **2158 passed**（当次输出 2026-11-07；**必须串行**，否则会出现四种不同的计数） |
| 越界审计 | **0 条**（扫 26 个 `src/**/*.mjs` · **6 条规则** · 豁免 1 条） |
| 文档索引 | **148 个文件 · 未索引 0** |
| 文档数字同步 | **9 份文档 / 20 处锚点**全一致 |

> **别手改文档里的计数** —— 它们由 `node scripts/sync-doc-numbers.mjs --write` 从
> `test/counts-baseline.json` 的 `passed` + `CHANGELOG.md` 写回。手改的结果只有两种：
> 被下一次 `--write` 覆盖，或被 `--check` 点名到「文件:行号」。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 常用诊断命令

```bash
npm run status                            # 一条命令看完：门禁/测试/doctor/面板/补账/真机基准
npx dsh-gokifu-compact doctor             # 体检：装没装上 / 模型能不能解析 / 最近的压缩 / 棋谱健康
npx dsh-gokifu-compact config             # 打印配置总表（31 项，由 schema 生成）
node scripts/handoff-check.mjs            # 交接门禁（16 项判据，FAIL 必须 0）
node scripts/privacy-audit.mjs --changed  # 日常：只扫相对 HEAD 的新增行与未跟踪文件
node scripts/privacy-audit.mjs --pack     # 发布前：扫完整 npm packlist
```

### 测试实例（不碰生产、不写 live home、不调真模型）

`test/engine-harness.test.mjs` 把宿主的 `@deepseek-ai/*` 全部 stub 掉，**在纯 Node 里 new 一个真 Engine**，
挂**隔离的 home**（`test/.harness/`），拿真机会话日志重放：

```bash
node test/run.mjs backfill-e2e          # 真实 Engine + 假 home + 假模型
node test/run.mjs transport-retry       # TRANSPORT 退避重试（30s→60s + 抖动 + deadline 闸）
node test/run.mjs small-window          # 小窗口合并
node test/run.mjs rooms                 # 架构方向门禁（R-A..R-F）
```

> `run.mjs` 的 filter 是**文件名子串**匹配，不是房间名 —— `ui` 命中 `ui` / `ui-security` /
> `ui-config` / `ui-perf`，**不命中** `version-path`。写验收命令时按**文件名**写。

## 验收（不用装宿主也能跑）

```bash
node test/run.mjs                        # 全量（串行）
node scripts/boundary-audit.mjs          # 越界线索 0 条
node scripts/docs-index-check.mjs        # 每个文档都在索引里
node scripts/sync-doc-numbers.mjs --check # 文档里的计数 = 权威源
node scripts/handoff-check.mjs           # 交接门禁 16 项
node scripts/bench-repro.mjs             # 热清单 token 基线（默认只打印，--write 才落盘）
node scripts/pack-check.mjs              # 打包内容可从任意 commit 复现
```

一条命令全跑：`npm run gate`。**门禁数是 8 判分门 + 5 条参考门**（参考门里那几条
「打 tag / 发版 / 重启」本来就卡在授权上，不算红）。

## 故障排查（都是真实踩过的）

| 症状 | 根因 | 处理 |
|---|---|---|
| `compactRegion: no open turn — automatic compaction events must be enclosed in a turn` | 宿主的**自动**压缩路径要求存在未结束的 turn（`basic:460`）；在 turn 之外（例如补账、后台折叠）直接调就会抛 | 不要绕事务语义 —— 走**离线补折**（`scripts/archive-fold.mjs` / 面板「补折」卡），那是另一条入口 |
| 状态文件里五个会话全是 `折了 0 段 · 停止原因 error · TypeError: session.requestHeader is not a function` | 补账是**无头**的（C525 为了不弹会话，特意不传真实 `sessionId`），但连一个可供调用的会话壳都没给；适配器一读 `session.requestHeader()` 就抛（`kimi-k3.1-pro` 才会踩到，`deepseek` 那个适配器不读它） | 已修（C579/C580/C585）：给一个 `id: ""` 的**合成会话壳**（`requestHeader` / `toolHistory` 都返回空），**不会激活任何真实会话**。升级到 ≥ 1.18.3 |
| 随包 `cordis.patch.yml` 引用宿主**已删除的** `list-agents` 子路径，重启后 preset 挂载失败 | 生成器静默兜底到**历史写死的旧宿主路径**，于是产出了「看起来对」的旧快照 | 已修（2026-11-07）：解析顺序改成 `DSH_APP_ASAR` → `DSH_HOME` 父目录同级安装 → 当前进程安装 → 平台标准位置，**一个都找不到就报错退出**，不猜 |
| 重启后 `chess-context/` 不落盘，配置看着对但压缩是原生的 | **用户层 patch 遮蔽**（2026-11-02 实机事故）：`profiles/desktop/cordis.patch.yml`（用户层，**最后应用**）里的 `preset-standard` 快照写回了 `compaction-basic`，盖掉了 bundle 层 | `doctor` 的「用户层 patch 遮蔽」会直接报 error。1.17.1 起退出时**自动**把用户层那几行原样复制到 `$DSH_HOME/cordis.patch.yml`（机器级层，宿主最后应用），下次启动接管，**用户零命令** |
| 归档了会话，但 `foldMarks` 是 0、日志里只有 `compaction/start` 没有 `end` | GUI 归档**根本不发** `session/disposed` —— 收尾折叠原来挂在这个信号上，等于从来没被触发 | 已修（C216）：改挂 workspace 域的 durable 写入 `domain/changed`，并给 `doctor` 补上观测 |
| 手动 `/compact` 抛 `Receiver must be an instance of class ChessCompactionEngine` | 插件装在**两份**（profile 里新旧各一），`this` 拿到的是另一份的类实例 | 卸掉重复的那份重装一次（幂等，会补全所有文件），然后重载 |
| 装完别的插件后**设置页 / 「上下文压缩」页面不见了** | bundle patch 的 `insert` **id 撞车**：宿主按 id 建索引，后写的替换先写的 | `doctor` 的「insert id 唯一性」在撞到本插件 `gokifu-ui` 时直接报 **error**；两个插件抢同一个 preset 则由「preset 覆盖唯一性」报 warn |
| 某个模式好像没走棋谱压缩 | 第三方插件自带的 preset 在自己的 bundle patch 里重新声明了 `compaction-basic` | `doctor` 的「第三方 preset 的压缩后端」会点名是哪个 preset；本插件**只登记不覆盖** |
| `doctor` 报「运行实例版本」不一致（buildId 不同） | 磁盘代码已更新、进程还是旧的（本插件以 `link:` 安装） | 重启 DSH，然后 `node scripts/post-restart-check.mjs` 一次核对（buildId + 归因字段 + doctor 0 错 + boundary 0 条） |
| 两次并发跑 `node test/run.mjs`，通过数出现**四种不同的值** | 两个 `run.mjs` 共用 `test/.harness/graphs`，互相删夹具 ⇒ **假红** | **必须串行**。运行器有锁（`test/.harness.lock`），但别靠它 |
| fold 一直不触发 | 三个原因，按顺序查：① 上下文没到 `thresholdRatio`（默认 45%）；② `growthFloorTokens` 拦住了（距上次 fold 增长 < 40K）；③ `resolveModelInfo` 拿不到 contextWindow（看日志有没有 `no context capacity`） | 先跑 `npx dsh-gokifu-compact doctor` |
| 想看「这个数字还能不能引」 | 时点 / 分母 / 是不是生成物 / 有没有消费者，四问 | [`docs/指标口径.md`](docs/指标口径.md) |

## 装好了吗？跑一条命令就能确认

```bash
npx dsh-gokifu-compact doctor
```

它会告诉你四件事，并给出下一步该跑什么：

| 检查 | 不通过时它会说 |
|---|---|
| **装没装上**（bundle 是否进了 profile、引擎行是否生效） | 没进 `dsh.profile.bundles` → 重装一次；引擎行没换 → 跑生成器 |
| **摘要模型能不能解析** | 配的 provider 模型表里没有那个 id → 退回路由模型；再不行退回规则摘要（**零模型调用**） |
| **最近的压缩成功 / 失败** | `compaction/end` 的错误会直接列出来，并按类分流（网络 / 限流 / 上游路由 / 余额 / 请求非法） |
| **棋谱与树健不健康** | 缺 `nodes/<id>.md` / `index.md` 陈旧 / 闭包不自洽 / 置换合并不可追溯 |

**退出码 0 = 全绿，1 = 有警告或错误。**

> 这条命令**不需要宿主加载插件**也能跑（它读 profile 与磁盘）。面板里的「状态」卡是同一套数据的另一面，
> 但那个只有插件**已经挂载**时才存在。
>
> 想看更全的：`npm run status`（六行结论）、`node scripts/post-restart-check.mjs`（重启后核对）、
> `node scripts/accept-after-restart.mjs`（会直说「跑的不是仓库里这份代码」）。

## 卸载与回滚

**卸插件**（一条命令）：

```bash
dsh plugin --profile <p> remove dsh-gokifu-compact
```

**插件留下的东西**（卸插件**不会**自动清，想彻底干净就照下面逐项删）：

| 残留 | 位置 | 里面有什么 | 要不要删 |
|---|---|---|---|
| 棋谱与树 | `<DSH_HOME>/chess-context/` | `sessions/<sid>/graph.json`、`graph.json.delta.jsonl`、`index.md`、`nodes/*.md`、`build.json` | 想保留历史就留着；重新装回来还能接着用 |
| 迁移 / 修复备份 | `<DSH_HOME>/chess-context/migrate-backups/` | 迁移与修复脚本写的 `.bak-<ts>` + sidecar | 确认不需要回滚后删 |
| profile 备份 | `profiles/<name>/*.bak-before-chess-context-<ts>` | 安装器改 `cordis.patch.yml` / `package.json` 前的原样副本 | 确认新版稳定后删 |
| 隔离实例 | `test/.harness/`（仅开发） | 测试用的假 home 与假图 | 可删（下次跑测试会重建） |

**回滚到旧版本**：

```bash
dsh plugin --profile <p> add dsh-gokifu-compact@1.17.6   # 换成你要的版本
```

回滚**不会**回滚 `graph.json` —— 新版本写过的字段旧版本会当未知字段忽略（一般不致命）。
真出问题就先把 `<DSH_HOME>/chess-context/sessions/` **抄一份**再动手。

仓库侧**一刀一 commit**，所以 `git revert <sha>` 是安全的；数据侧**只认 `.bak-<ts>` + sidecar**，
不手改。完整回滚路径见 [UPDATING.md](UPDATING.md)。

## 文档

**先读这四份**（会被人照着做的）：

- [SETUP.md](SETUP.md) —— 从零装到能用（一次一问 + 验收六步）
- [UPDATING.md](UPDATING.md) —— 升级 / 回滚 / 发版（含 `cordis.patch.yml` 是生成物）
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 怎么提 PR（**加了测试必须跑 `sync-doc-numbers --write`**）
- [MAINTENANCE.md](MAINTENANCE.md) —— 维护台账（当前状态 / 未验证项 / 门禁清单）

**设计与契约**：

- [`docs/指标口径.md`](docs/指标口径.md) —— **README 上每个数字从哪来**（417 是合成夹具、p50 419 是真实会话、8/8 是历史口径）
- [`docs/压缩的职责边界.md`](docs/压缩的职责边界.md) —— 压缩只做什么、不做什么
- [`docs/压缩的重注入契约.md`](docs/压缩的重注入契约.md) —— 热清单 / facts 注入契约 + 逐行对应测试
- [`docs/落盘与回滚不变量.md`](docs/落盘与回滚不变量.md) —— 三份产物 + 6 条不变量
- [`docs/配置总表.md`](docs/配置总表.md) —— **由 schema 生成**（31 项），手改会被测试打回
- [`docs/架构-房间契约.md`](docs/架构-房间契约.md) —— 房间依赖方向与边界（R-A..R-F）

**证据与调研**：

- [`evidence/`](evidence/) —— 实测数据（[`evidence/README.md`](evidence/README.md) 是索引，标明哪份是现值、哪份是历史）
- [`docs/真机基准-自动生成.md`](docs/真机基准-自动生成.md) —— 命中率 / 花费分布 / fold 耗时 / 欠账规模
- [`docs/工程教训集.md`](docs/工程教训集.md) —— 踩过的坑与判据演进
- [`docs/knowledge/结论速查.md`](docs/knowledge/结论速查.md) —— 一页看完所有已核实 / 已否掉的判断（带数字与「谁在保证」）

**更新记录**：[CHANGELOG.md](CHANGELOG.md)（`### C<n> · 标题` 形状，582 条）。

## 参考源

只借鉴**结构与规律**，未复制代码：

| 来源 | 用在哪 |
|---|---|
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | README 模板、发版七步、维护检查脚本 |
| [billion-context](https://github.com/ranxianglei/billion-context)（MIT + 署名附加条款） | 「增量 fold / 只压已消费内容」的架构不变量、缓存与保留率的判据 |
| [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（MIT） | 「每个机制一节」的说明结构、对 prompt 缓存影响如实交代的写法 |
| [dsh-session-superagent](https://github.com/MYCF711/dsh-session-superagent)（MIT，同一作者） | 仓库治理文件的形态（CONTRIBUTING / SECURITY / SETUP / UPDATING / MAINTENANCE / `.github`）与 `assets/icon-180.png` |
| [DSH 官方 `dsh-compaction` / `dsh-compaction-basic`](https://github.com/deepseek-ai)（随 DSH 分发） | 继承 `compactRegion` / `surfaceOp: replace` 事务语义，只覆盖策略层 |

## 许可

MIT。见 [LICENSE](LICENSE)。
