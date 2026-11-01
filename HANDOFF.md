# dsh-GOkifu-compact · 交接文件

## 🆕 2026-11-01 21:50 · 1.16.0（当前工作树）

| 项 | 值 |
|---|---|
| 版本 | **1.16.0**（commit `b2e9b3a`）。npm 上仍是 **1.15.2** —— 1.16.0 未发布、未打 tag |
| 单测 | **615 passed / 0 skipped / 0 failed**（`node test/run.mjs`，**必须串行**；并发跑会共用 `test/.harness/graphs`，出现 T2-5 之类假红） |
| 架构 | **bundle patch 按 id 整体覆盖四个官方 agent preset 的 `config`**：把 `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-gokifu-compact/engine`。标准 / PTC / 极简 / 创造四个模式**全部**走棋谱压缩；**不新增 preset、不改 `agent-preset-registry` 默认 preset** |
| 生成器 | `node scripts/make-presets-override.mjs [--write]` —— 读宿主 asar 里的官方 preset，**文本级**改写（官方文件里的 `!!js` 表达式绝不能被 YAML round-trip）。DSH 升级后重跑再发版 |
| 已否决 | **运行时接管方案（R17）**：`src/rooms/takeover.mjs` + `installTakeover` 会让 preset 生成树挂载失败（重启后会话只剩宿主级工具，`bash`/`read`/`write` 全消失）。代码在 `git stash`：`wip:R17-takeover（事故，留档）`，**不要恢复** |
| 隔离验证（真跑过） | ① `--dump-config` 四个 `- id: preset-*` 行都带 `dsh-gokifu-compact/engine`；② `agentPreset: "standard"` 会话里**工具齐全**（模型成功调用工具并拿到输出）；③ `<home>/chess-context/sessions/<id>/graph.json` 落盘（含 user/agent 节点与带 verify 的边）；④ 卸载后 `--dump-config` 里引擎行归零、四个 preset 内部 `compaction-basic` 全部回来 |
| 桌面 live | **21:51 重启后已加载新 patch**：`doctor` 全绿（错误 0 / 警告 0）、`verify-install` 18/18；本会话 `session-1286ce28` 的 preset 投影 = **`standard`**，且 assistant 消息里有 **3 条含 `<chess-ledger>`**、ledger 里带 failed 边 → **标准模式在 live 上确实由 GOkifu 引擎压缩** |
| 已验（live） | ① preset 投影 = standard；② 热清单注入 3 次；③ 失败边进 ledger；④ `doctor` 0 错 0 警、`verify-install` 18/18 |
| 已验（隔离实例 · 真实 fold） | 给引擎行加小阈值（thresholdRatio .004 / firstFoldRatio .002 / retainRatio .001 / minFoldTokens 200）后连发三条长 prompt：会话日志 `compaction/start → compaction/summary → compaction/end`，graph 写入 `foldMarks: [{seqStart:8, seqEnd:9, shadowedTokens:8093, totalAfter:9844, foldCount:1, ms:7476, usage:{in:16595,out:934}}]` ⇒ **压缩确实走 GOkifu 棋谱摘要** |
| 未验证 | ① GUI 插件市场点「安装」的完整点击流程（安装通道本身有 B-4 测试，且 live 的 profile 已是「bundles 含本包」状态）；② 1.15.x 旧会话 header 里 `agentPreset: "gokifu"` 在移除 preset-gokifu 后的恢复行为 —— 升级前扫一遍会话日志（脚本在 Hindsight `1.16.0 升级前必查`） |


> 2026-11-01 · 给下一个会话
> **先读这一页，再读 `docs/最终报告.md`。不要重新推导。**
> 当前版本 **1.14.0**（**未发布**：无 tag、无 npm 发布 —— 本轮主人只授权推 GitHub）；单测 **613 / 0 skipped / 0 failed**（**54 个测试文件**）。
> **⚠ 桌面 live 里本插件一个版本都没装**（11-01 14:15 重建的新 home）—— 不是「停在旧版本」，是「0 个版本」。
> 装回去：清单已过闸（1.12.0）→ `dsh plugin add`（官方通道，成功后会**自动**把包追加进 bundles）→
> `make-preset` 生成 preset bundle 并同样 `dsh plugin add` → **在会话里选中该 preset** → 重启验证。详见「新版 DSH 适配」。

## ⚠ 最新状态（2026-11-01 · 1.14.0 · 未发布）

| 项 | 值 |
|---|---|
| 版本 | **1.14.0**（`package.json` = `README:3` = `CHANGELOG 有 ## 1.14.0`） |
| tag / npm | **都没有** —— 本版只存在于工作树；`npm latest` 仍是 **1.11.17**。**本轮主人只授权 push 到 GitHub（main + tag），不 npm publish** |
| 单测 | **613 passed / 0 skipped / 0 failed**（**54 个测试文件**；1.13.0 是 597/0/0、52 文件）· `ui` **75/0** · `ui-models` 7/0 · `ui-layout` 9/0 · `engine-harness` 43/0 · `ledger` 20/0 · `c17` 15/0 |
| 本轮（1.14.0）改了什么 | ① **模型目录**：`inject` 加 `llm`、新增 `models` 动作（只读宿主目录、不存凭据）② **页面改版**：宽屏双栏 + 滚动容器 P0 修复 + 焦点环 + 两级模型下拉 ③ 两件欠账收口：`thresholdRatio` **事实更正（不改数值）**、**手动压缩按钮「不做」** |
| `check-maintenance` | **8 通过 / 0 警告 / 1 失败** —— 唯一失败是「当前版本 1.14.0 有 tag」，属**发版步骤未执行** |
| **桌面 live** | **0 个版本**：`profiles/desktop/package.json` 无本包依赖、`dsh.profile.bundles` 无本包、`<home>/chess-context` 不存在。1.9–1.14 的收益**一条都没生效** |
| 下一步（唯一档停的事） | **装到 live** —— 需**停机窗口 + 主人授权 + 主人重启**；四步见下方「新版 DSH 适配」。**不要手改 `package.json` 加 `link:`**（那正是历史上丢插件的机制） |

> 其余仍未做：**`README:3` / 本文件版本号都没有门禁**（`check-maintenance` 不读它们）。
> ~~**M2/M3**（UI 暂停中）~~ ⇒ **UI 已于 1.14.0 解冻并改版**（见下方「UI」节）；其中 **外部 API 通道按主人裁定不做**
> （插件不存凭据、不接外部 API，用户去 DSH 加供应商 ⇒ 下拉自动出现）。
> ~~**tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）~~
> ⇒ **1.13.0 已做，但结论要改口径**：热清单定价改成 **CJK 感知 + ASCII 侧对齐宿主 `CHARS_PER_TOKEN=4`**
> （**没有**改成接 `ctx.tokenMeter`）—— 因为 `ctx.tokenMeter.measure(session)` 早就接好了
> （`engine.mjs` 的会话压力 / fold 阈值），它吃的是 **session surface**；而热清单是一段**自造文本**，套不上 measure。
> 详见 `CHANGELOG` 的 `## 1.13.0` / W-A 与 `src/rooms/ledger.mjs` 的定价注释。

### 已了结的旧账（2026-11-01 复核，别再当待办）

- **P6-C 真实 apply 已经执行了**（旧版本文件写「仍未执行」，是错的）：`D:\主工作区\tmp\dsh-gokifu-compact\LIVE-APPLY-2026-10-31T14-20-18-959Z.log`
  → preflight **exit 0**（176 会话 / 30,341,323 B）→ dry-run → `--apply` → `migrate verify … "ok": true`、
  **`archived=6219 deleted=6219 sessions=48`**、`[exit 0]`（2026-10-31 22:20 本地）。整目录备份在
  `D:\主工作区\tmp\dsh-gokifu-compact\live-apply-backup-2026-10-31T14-20-18-959Z\`。
  **没做完的是「重启后读日志验收」** —— 而 11-01 的 home 重建让那一步**永久不可复现**。
- **S1b（清理 2 张历史自环图）可关**：对上述归档快照实测 `test/rewash-selfloop.mjs` dry-run
  = **176 个 graph.json / 0 个含自环 / 全库自环 0 / 37,194 = 0.0%**（点名的两张图仍在，但已无自环）。

## 新版 DSH 适配（0.2.1-rc.5）—— 装回去之前必读

> 完整方案（逐行源码实测）：`E:\Documents\deepseek-harness\default-workspace\gokifu-2026-11-01\compat-deploy.md`。
> 本节只留结论与顺序，别整段抄。

**三道版本闸（缺一不可，全在宿主 `dsh-app-boot` 里）**

| # | 时机 | 不满足的后果 |
|---|---|---|
| ① | 安装前 `installBundle` 的兼容性检查 | **直接拒装**（`incompatible-version`），pnpm 都没跑 |
| ② | 启动：bundle 层 `evaluatePluginCompatibility` | **整层 patch 静默跳过**（源码注释原话 "nothing is printed"）⇒ UI 行也不会被插入 |
| ③ | 启动：行级 `preflight()` | 该行被 `disabled`，往 stderr 打一行 |

②③ 只认 profile 自己的豁免文件 `$DSH_HOME/profiles/<p>/compatibility.json`（键必须是精确 `name@version`，
**插件升级与 DSH 升级都不继承**）。

**本版已把闸门改成「说真话」**：4 个 `@deepseek-ai/dsh-*` peer `0.2.0-rc.2` → `^0.2.0-rc.2`（**条目一条都没删** ——
peer 表同时是模块解析路由表），并补 `engines.dsh`。⚠ 这套 range 能过闸**依赖宿主继续传
`{ includePrerelease: true }`**（实测见 CHANGELOG 1.12.0 的 F1 节）。

**四步装回（停机窗口里按序做，任一步失败就停在原状）**

1. **过闸** —— 1.12.0 已把清单改好（4 个 dsh peer 改范围 + 补 `engines.dsh`），正常情况无需豁免；
   若要用旧包，走官方 `dsh plugin --profile desktop allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。
2. **装 bundle —— `dsh plugin add` 就是官方 install 通道**
   ```bash
   dsh plugin --profile desktop add "D:\主工作区\repos\dsh-GOkifu-compact"
   ```
   **机制更正（1.13.0 实测，别再按旧笔记走 Web 页面）**：`dsh plugin add` **不只是转发 pnpm** ——
   成功后它会调 `reconcile()`（`dsh-plugin-manager/lib/types/operations.js:96-124`），把「本次新增的依赖
   且其 `package.json` 声明了 `dsh.bundle`」**自动追加进 `dsh.profile.bundles`**。
   ⇒ **CLI 通道 = 官方 install_bundle 的等价物**，不需要 Web 页面，**更不能手改 profile 加 `link:`**
   （手改正是历史上丢插件的机制）。
   **不要**用插件自带的 `node scripts/cli.mjs install`（读已不存在的 `preset-bundles/`、手写 UI 行会与 bundle 通道双挂载）。
3. **生成并装 preset 的引擎行（C 段 · 1.13.0 的正式解法）**
   ```bash
   # 默认就是 dry-run；生成时别把 DSH_HOME 指向目标 home（否则「不许写进运行中 home」的守卫会拒，退出码 2）
   env -u DSH_HOME node scripts/make-preset.mjs
   env -u DSH_HOME node scripts/make-preset.mjs --write --out "<repo>/tmp/preset-bundle"
   dsh plugin --profile desktop add "<repo>/tmp/preset-bundle"     # 同样会被 reconcile 选进 bundles
   ```
   - 它从**当前宿主 asar** 读官方 `dsh-web-app/presets/standard.patch.yml`，**只**把 compaction group 里的
     `- id: compaction-basic` 换成 `- id: gokifu-compact / name: 'dsh-gokifu-compact/engine'`，
     **其余 32 条插件行逐字保留** ⇒ DSH 升级后**重跑一次**即可，不会像手抄那样把插件清单冻成快照、静默丢新版新增行。
   - 引擎**不能**放在 profile/bundle 级 patch，必须在 preset 的 compaction group 里；`command-compact` 与
     `tool-result-pruner` 两行**保留**。
4. **在会话里选中该 preset** —— **机制（1.13.0 实测）：preset 插件是惰性激活的**：不选该 preset 的会话
   **不会 mount `config.plugins`**。⇒「装完没反应」最常见的原因是**没选 preset**，不是装坏了。
   选完 → 重启 → 跑 `node test/verify-install.mjs`（preset 那 5 项应从 `!` 转绿）+ `node scripts/doctor.mjs` 验。

**两条硬教训（都有磁盘证据，别再踩）**

1. **「安装态与 preset 必须同源」，而手加的 `link:` 会被插件管理器抹掉**：2026-10-31 22:02:22 DSH 插件管理器重写
   `profile/package.json` 时是**按自己的托管清单重建**，把插件 `cli.mjs install` 手加的 `link:` 依赖与 bundle 项一起丢了
   （现场备份 `D:\主工作区\.trash\2026-10-31\live-profile-before-gokifu-reinstall\package.json`），而 preset 还指着它
   ⇒ 所有相关 resume 报 `gokifu-compact (dsh-gokifu-compact): never started (gateway/internal)`。
   **⇒ 必须走官方通道装，不要只手改 package.json。**
2. **引擎名必须写 `dsh-gokifu-compact/engine`**，不能写包根：包根 `exports["."]` → `src/ui.mjs` 是 UI host，
   DSH 会把 UI host 当压缩引擎，**装回去了照样挂**。

> 其它陷阱：桌面 `gokifu-停窗减枝.cmd` 必须是 **GBK(CP936) + CRLF**（1306 B / 39 CRLF / 无 BOM）；
> UTF-8 编辑器保存会让它静默失效。`live` 若用 `link:` 指向工作树，则**工作树里任何未提交改动重启后都会被直接加载**。
>
> **⚠ 启动器（1.13.0 发现并已修）**：`D:\DeepSeek Harness\启动 DSH.cmd` **原本是坏的** —— 两处路径写
> `%~dp0DeepSeek Harness Desktop\`，而实际目录名是 `Desktop\`（连它的 `.bak-20261101` 备份也是同一处错
> ⇒ **升级后就一直断**）。已改成 `%~dp0Desktop\`、重写为 CRLF/无 BOM，并逐条验证引用的 3 个路径都存在。
> **为什么这条重要**：「重启 DSH」正是装回插件的第 2 步 —— 启动器坏了会被误判成**「插件把宿主搞崩」**。

## 测试用 DSH 实例（W-C · 1.13.0 建成，这是本轮最重要的能力）

> 目的：以后**任何**「装回去到底行不行」的验证，都在这个**独立实例**上做，不再拿生产 home 冒险。
> 细节与逐条证据：`E:\Documents\deepseek-harness\default-workspace\gokifu-2026-11-01\test-instance.md`。

| 项 | 值 |
|---|---|
| 测试 home | **`E:\Documents\deepseek-harness\dsh-test-home`**（独立 `DSH_HOME`，与生产 `D:\DeepSeek Harness\home` 完全隔离） |
| 端口 | **62619**（生产是 62618）⇒ 两个实例可同时跑 |
| profile | `web`（自动创建），已装 `dsh-gokifu-compact` + 自建 preset bundle，二者都在 `dsh.profile.bundles` 里 |
| 起停 | 起：`dsh --profile web --host 127.0.0.1 --port 62619 --no-open`；停：`netstat -ano \| grep LISTENING \| grep :62619` 拿 PID 后 `taskkill //PID <PID> //T //F` |
| 复现命令序 | `test-instance.md` §7（一条条可照抄） |
| 副产物 | `E:\.pnpm-store`（官方 `dsh plugin add` **自己选的** pnpm store，74 MB，不要时 `rm -rf /e/.pnpm-store`） |

**已验证到哪一段（A→B→C→引擎加载）**

- **A 过闸 PASS**；
- **B 官方通道** `dsh plugin add` 装 bundle：软链 + **自动选进 `dsh.profile.bundles`** + `--dump-config` 里出现
  本包 patch 插的 `- id: gokifu-ui` ⇒ bundle 层**没有被版本闸静默跳过**；
- **C preset**：`make-preset.mjs` dry-run 看到「32 条插件行逐字保留 / 仅 compaction 组 2 行不同」→ `--write` →
  同一个 `dsh plugin add` 装进 profile（两个 bundle 都在 bundles 里）；
- **引擎真的加载**（三层证据）：① 组合树里引擎行与探针行都在、无 `disabled`；② `--dump-config-schema` 里该行
  `status:"schema"` 且 `$defs` 是本插件 `config-schema.mjs` 生成的**带中文 description 的 Config**（说明模块真被 import）；
  ③ 同 realm `inject:["compaction"]` 探针被激活，写出
  `{"hasService":true,"constructorName":"ChessCompactionEngine","hooks":{summarize/compactIfNeeded/compactNow/compactRegion 全 function}}`。
  旁证：`POST http://127.0.0.1:62619/gokifu/api {"action":"health"}` → **HTTP 200** + 插件自己的 JSON。

**还差什么（诚实写）**：「**会话选中 preset → 引擎实例化 → 真压一轮**」**没验** —— 测试 home 没配模型路由，
也没有擅自把生产 magpie 接过去。所以准确说法是：**「引擎行被加载、实例化、注册服务」已实测；
「引擎接管压缩并产出棋谱」未实测。**

## UI（1.14.0 解冻后改版）

> 背景：主人 2026-10-30 说「UI 先放下」（*没人用的插件不需要 UI*），本版**解冻**。立场仍然是「只读宿主」——
> 见下面的架构定调。

**架构定调（主人拍板，以后别再自己发挥）**

1. **插件不自己存凭据、不自己接外部 API**。用户要用外部 API，**去 DSH 里加供应商**；
   插件页面的摘要模型下拉从**宿主已注册的模型目录**里自动长出来。
   ⇒ M3（插件私有 secrets / `external-summary` 模块 / 外部 API 面板）**不做**。
2. **插件页不是会话级的** ⇒ 拿不到 agent / 会话状态 ⇒ 任何「当前能否压缩」的实时判断都做不出可信结论（见「不做」节）。

**改了什么**

| 面 | 改动 |
|---|---|
| 模型目录（U1） | `inject` → `["webServer","llm"]`；新增纯函数 `modelCatalog(llm)`；新增 `{"action":"models"}`，且 `state` 响应同时带 `models`。**只读** `listProviders()` / `listModels()` / `resolveModelInfo()`；任何失败降级不抛（单 provider 挂只跳过） |
| 页面（U2） | 宽屏双栏（≥1280px，`maxWidth 1600px` 居中，窄屏回单栏）；**滚动容器 P0 修复**（`height:100%` / `minHeight:0` / `boxSizing` / `overflowY:auto`）；**焦点环**（全部交互元素经 `focusable()` + onFocus/onBlur）；**摘要模型两级下拉**（provider → model，`<optgroup>`，目录为空降级自由文本） |
| 页面（U4 收尾） | 窄屏断点 600（600−56 padding=544，扣 220 控件 + 120 默认值列只剩 ~200 给中文 label 会折行）；长模型名/长 id 加 `title`；标题行显示当前 profile；`SPACING={section:16,card:8,inline:12,micro:4}` 把 18/20/26/10/2 收敛成 **4px 网格** |
| 窗口 | **去掉硬编码的 1000000**：按选中模型的 `contextWindow`；拿不到显示 `—` 并隐藏进度条 |

**三个宿主 API 事实（省一次考古）**：服务名就是 **`"llm"`**；`listProviders()` 返回 **`[{ id, name }]`**；
**`listModels()` 里没有窗口字段** —— 窗口只能逐模型问 `resolveModelInfo(provider, model).context.contextWindow`。
⇒ 首屏要为每个模型问一次，所以每次宿主调用有 **4 秒时间预算**（`CATALOG_CALL_TIMEOUT_MS = 4000`），
超时按「拿不到」降级 —— `dsh-llm-deepseek` 的 `listModels()` 背后是 `discoverModels?.()`，**可能走网络**，
**页面宁可少一个下拉项，也不许卡住首屏**。

**`thresholdRatio` 的事实更正（本版不改数值）**：主人被问「0.6 要不要降到 0.5」答「降到 0.5」，但
**插件的默认值本来就是 0.45**（`config-schema.mjs` 与 `install.mjs` 的 `engineBlock()` 模板都是 0.45）；
仓库里唯一的 `0.6` 是**升级前的 profile 级 override**（`cordis.patch.yml:489`），已随旧 home 消失。
⇒ **0.45 已经比 0.5 更早触发**，符合主人「更早压」的意图 ⇒ **不改**。事实已追加进
`docs/P0-worldhash-死循环-根因与修复方案.md` 的 P1 节（**原文一字未删**）。

**测试**：`ui-models` **7/0**、`ui-layout` **9/0**、`ui` 切片 **75/0/0**（基线 59）。
**未验证**：真实浏览器里的目视效果（1280 / 599 视口）没看过；4 秒预算只在夹具里模拟过卡住；
窗口查询**无缓存**（模型多的 provider 会慢，延迟未测）。

## 不做（有理由，别再问「为什么没做」）

1. **手动压缩按钮 / 禁用态** —— **历史欠账第 8 条已解释关闭**（考古报告 `考古-2026-11-01/04-GOkifu/10-未完成事项.md` §8）。
   实测宿主 `dsh-command-compact/lib/index.js`：**不排队** —— `executeCompact` 直接调 `ctx.compaction.compactNow(...)`；
   busy 时抛 `ManualCompactionError("busy")`，渲染成英文
   "Compaction is unavailable because this process has an active compaction, or the agent is not idle."
   ⇒ **DSH 原生是报错的**，只是英文且不说人话。插件 **1.11.13** 起已把该 message 改成人话
   （`compactNow` override + `annotateManualCompactError`，保留 `code`/`name`/`cause`/`stack`，宿主分类不受影响）。
   而且**页面里根本没有压缩按钮** —— 手动压缩就是原生 `/compact` 斜杠命令。
   **三条不做理由**：① 页面不是会话级的，拿不到 agent/会话状态，做不出可信的「当前能否压缩」；
   ② 加按钮等于重复原生 `/compact` 的能力面，还会把用户重新引回 busy 报错那条路；
   ③ 报错可读性已经解决 —— **这才是当初欠账的真实痛点**。
2. **插件私有凭据 / 外部 OpenAI 兼容 API 通道（M3-1 / M3-2 / M3-AUTH-1）** —— 主人裁定：外部 API 去 DSH 里加供应商，
   插件**只读**模型目录 ⇒ 不存 key、不接外网、不做面板；`M3-AUTH-1` 的凭据调查随之**不再需要**。
3. **把 `thresholdRatio` 改成 0.5** —— 见上：插件默认已是 0.45，比 0.5 **更早**触发；改成 0.5 反而**更晚**。

## 历史状态（2026-10-31 · 1.11.14）—— **已被上方取代，留作时间线**（本节「P6-C 仍未执行 / live=1.11.2」两处与事实不符，见上方「已了结的旧账」与「最新状态」）

| 项 | 值 |
|---|---|
| 版本 | **1.11.14**（`package.json` = `README:3` = `CHANGELOG 有 ## 1.11.14`） |
| tag / npm | `v1.11.14` annotated · npm `latest = 1.11.14` · `dist.shasum 765ff0aa…` |
| 单测 | **542 passed / 0 skipped / 0 failed**（45 个测试文件）· `engine` 39/0 · `ledger` 31/0 · `release-hardening` 22/0 |
| 安装校验 | `node test/verify-install.mjs` **16 ✓ / 0 ✗** |
| `check-maintenance` | **9 通过 / 0 警告 / 0 失败** |
| **桌面 live** | **仍是 1.11.2**（`profiles/desktop/package.json` 指向 `github:…/dsh-GOkifu-compact#v1.11.2`）—— **落后 12 个版本，那 11 版的收益在 live 上一个都没生效** |
| 工作树 | HEAD `4804173` 已含**未发布**的 P2-2（`engine: fold 可观测字段`）⇒ 当前树全量 **546/0/0**，**下次发版要 bump 1.11.15** |
| 下一步（唯一档停的事） | **P6-C 真实 apply 仍未执行** —— 需主人授权 + 停插件窗口；预检 `scripts/p6c-preflight.mjs` · 手册 `docs/P6C-停窗执行手册.md`；**真跑不带 `--force`**；`--verify` 已在 **6,219 条真实规模 PASS** |

> 其余仍未做：**M2/M3**（UI 暂停中）· ~~**tokenMeter**（`len/3` 保留，正解是 `ctx.tokenMeter` 端口 + R06 预算改 token 单位，未立项）~~
> ⇒ **本条已于 1.13.0 解决，口径不同**：热清单定价改成 **CJK 感知 + ASCII 侧对齐宿主 `CHARS_PER_TOKEN=4`**，**没有**改成接 `ctx.tokenMeter`（它吃 session surface，已用于会话压力/fold 阈值；热清单是自造文本、套不上 measure）。见 `CHANGELOG` 的 `## 1.13.0` / W-A。

## 历史状态（2026-10-29 · 1.9.1）—— **已被上方取代，留作时间线**

| 项 | 值 |
|---|---|
| 版本 | **1.9.1**（工作区 = 已安装 junction 指向的源码，npm latest 仍是 1.8.1 —— 未发布） |
| 单测 | **134 passed / 0 failed**（新增 `test/selfloop.test.mjs` 8 项 + harness 端到端 1 项） |
| 全库自环 | **6,172 → 0**（`node test/rewash-selfloop.mjs --apply` 已执行） |
| 未生效 | **必须重启 DSH**：正在跑的进程仍加载旧代码，会持续把自环写回（实测每分钟 +100 条） |

### 这一版修了什么（三份独立评估共同指向的那个洞）

`worldstate.touch()` 收到单个路径字符串却按可迭代对象遍历 ⇒ 路径被逐字符拆开 ⇒
`worldHash` 对所有步骤恒定 ⇒ `addAgentNode` 每步命中同一 `stateIndex` 节点 ⇒
`step/end` 把边的 `to` 指回 `from` ⇒ **全库 61.3% 的边是自环** ⇒
`dead` 判定 109/109 全错、`redundant` 135 条全假 ⇒ 热清单告诉模型「这条路永远别试」。

四处修复：`touch` 兼容 string/array、`addAgentNode` 禁止命中本步起点、
`tewariAnalysis` 排除自环边、`failureClass` 要求 `to !== from`。
另修：`#flush({md:true})` 键名写错（fold 后 nodes 从不刷新）、maxTokens 三处默认不一致（→8192）、
压缩连续失败告警进热清单。

**重启后的验收**：
```bash
node test/doctor.mjs          # 「图结构（自环）」应为 ✓（0 个坍缩图）
node test/verify-graphs.mjs   # 图结构：自环 0 = 0.0%
node test/rewash-selfloop.mjs # 若运行期又写出自环，说明修复没生效 —— 先查 worldstate.touch
```

---

## 一句话

DSH 的上下文压缩后端插件。把「历史 → 一段摘要」换成
**「历史 → 棋谱 DAG（节点=状态，边=尝试+结果）+ 每步重建的极短热上下文」**。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | **1.8.0**（已发布：npm `dsh-gokifu-compact@1.8.0` · [Release v1.8.0](https://github.com/MYCF711/dsh-GOkifu-compact/releases/tag/v1.8.0)）|
| 单测 | **118 passed, 0 failed** |
| 挂载校验 | 13/13 |
| GitHub | https://github.com/MYCF711/dsh-GOkifu-compact |
| npm | `dsh-gokifu-compact@1.7.0`（`dsh plugin --profile <name> add dsh-gokifu-compact`）|
| 最新 Release | https://github.com/MYCF711/dsh-GOkifu-compact/releases/tag/v1.8.0 |
| 本地路径 | `D:\主工作区\projects\dsh-chess-context`（物理目录名保留旧名 `chess`；junction 名 `dsh-gokifu-compact`） |
| 包名 | `dsh-gokifu-compact`（npm 只能小写）；展示名 `dsh-GOkifu-compact` |
| 运行期生效 | ✅ 10:0x 已重启：GUI 里**第一次真实 fold 成功**（遮蔽 440,847 tok → surface 1391→373，面板 81%→约 16%）|

## 今天做了什么（0.1.0 → 1.3.4）

### 第一阶段：核心实现（v0.1.x）

- 棋谱 DAG（graph / verifier / extract / ledger / range / keeper / engine）
- **增量 fold**：只压上一个 checkpoint 之后的内容（官方每次重压全部 → ρ^k 衰减）
- **失败记忆**：规则抽取 + 逐字保留（模型没有「决定丢掉」的权限）
- **机械约束段**：约束不经过模型（实测模型在 15 条失败边压力下会把 3 条约束全丢）
- 19 个 bug 修复（3 个 P0：`flushTimers` / `worldHash` / `mergeNodeInto`）

### 第二阶段：模型消费者视角（v1.2.6 → v1.3.4）

六个版本，**全部子代理实测驱动**：

| 版本 | 变更 |
|---|---|
| v1.2.6 | 三层树补缺陷 1/3/4（`errorSnippet` 400 / 写所有 `g.nodes` / 失败边全表） |
| v1.2.7 | 补缺陷 2/5（评语兜底 162 节点 / `verify:kind` 101 条） |
| v1.2.8 | 补缺陷 6（写顺序 json 最后 = 提交点 + `index.md` 带 `updated`） |
| v1.2.9 | 修死链 230 个 + 计数（`g.nodes`）+ 评语标注「非 LLM 原话」 |
| v1.3.0 | text 型 failure 标记 `[text:?]`（47 条）—— 数据层回洗会被运行中的会话覆盖 |
| v1.3.1 | 热清单省预算：短标签 + L4 20 条（**310 tokens / L4**） |
| v1.3.2-4 | 文档同步（最终报告 v1.x 章节 / 三层树设计 / 数字校正） |

### 第三阶段：P0 死循环修复（v1.3.4 → v1.3.5）

**这是插件上线以来最严重的 bug，不是平台问题**：`worldstate.hash()` 返回
`{ hash, mode, files }` 对象，`engine.worldHashOf()` 把它原样写进节点 ⇒
`renderFacts()` 的 `latest?.worldHash?.slice()` 抛 TypeError ⇒ 压缩事务回滚。
实机 `session-5acafe42`：**226 次压缩只成功 3 次**，上下文涨到 66 万 token，
模型 reasoning 退化自我重复，被 magpie 判死循环中断（37 次，全部在同一模型上）。

修复内容（`docs/P0-worldhash-死循环-根因与修复方案.md` + `evidence/P0-worldhash-修复验证.md`）：

- `worldHashOf()` 收敛成字符串；`constraintHashOf()` 改由 `hashSet(collectConstraintText(g))`（原来 `st.constraints` 从未赋值）
- `addAgentNode()` 入口归一化；`fromJSON()` 加载边界修复历史脏数据 + **无条件重建 `stateIndex`**
- `ledger.mjs` 加 `shortHash()` 防御层
- 新增 `test/worldhash.test.mjs`（6 项）+ 端到端回归（旧磁盘图 → `summarize()`）+ `test/verify-graphs.mjs`（全库健康检查）
- 全库回放：23 会话 / 1578 agent 节点 / 对象 worldHash **1279 → 0** / `stateIndex` **5 → 185**

## 核心设计（四条，缺一不可）

### 1. 棋谱 = 落子 + 评语 + 复盘

| 棋谱 | 插件 |
|---|---|
| 一手棋 | 节点（局面） |
| 落子 + 结果 | 边（尝试 + 验证信号） |
| 棋谱评语 | 节点的 `goal` / 约束 / `errorSnippet`（LLM 当时写下的） |
| 复盘 | 从根沿边走一遍 |

### 2. 手割（tewari）

两判定 + 多标签：

- `same_position`（同型）：和某条成功路径到同一终点
- `different` + `redundantVs` / `longerVs` / `probes`：相对**每条**成功路径分别判定

### 3. 失败三态

| 状态 | 条件 | 带什么 |
|---|---|---|
| `blocked` | 资源类（EACCES / ENOENT / timeout / ECONNREFUSED） | `revisit_if=...` |
| `dead` | 有成功路径且**有终点**证明不经过它 | `revisit_if=working path fails` |
| `failed` | 其余（可重试性未知） | 无 |

**关键顺序**：先判 `blocked` 再判 `dead` —— 权限不足是环境性阻塞，不是本质无解。

### 4. 三层树

```
sessions/<sessionId>/
├── index.md          缩进树（每节点只出现一次）+ 失败边全表
├── nodes/<id>.md     评语 / 状态 / 入边 / 出边 / [verify:kind] / [text:?]
└── graph.json        数据源（插件恢复用）
```

**为什么不是目录嵌套**：棋谱是 **DAG**，最大入度 **119**（n174 有 119 个父），transposition 边占 **61%**。嵌套会重复 119 份。

详见 `docs/三层树设计.md`。

### 第四阶段：标记自解释 + 原因不许丢（v1.3.5 → 1.4.0）

模型消费者盲测（12 次受试）暴露三处「内容不够模型用」：

1. **标记裸奔**：图例绑在「检测到手割」上 ⇒ 只有 EACCES 的会话里 `[blocked]` 没有解释
2. **标记是缩写不是语义**：`[blocked]` → `[blocked:permission]`（说出「什么变了能再试」）
3. **原因失踪**：L3+ 把 `→ 报错原文` 整段砍掉（全库 133 条可见失败边只有 25 条带原因），
   而盲测里 **12/12 次回答**都引用了报错原文

改法：动态图例（出现即解释）+ 任何档位都留原因（逐档变短）+ 手割只算一次（尾部 30 条）
+ 注定装不下的档位直接跳过（2000 边渲染 **7.58 ms → 0.478 ms**）+ 配置 `hotLedgerMarkers`。
代价：全库 tokens **+6.8%**，换来带原因的失败边 **89 → 209（2.35×）**。
证据：`evidence/热清单标记AB实验.md`（含「报错原文误导」场景的 1/6 vs 0/6）。

### 第五阶段：清单就地替换（v1.4.0 → 1.5.0）

旧版每次注入都**追加**一条新消息 ⇒ 实测 `session-5acafe42` 累积 **176 条 / 81 万字符 ≈ 27 万 token**
（它上下文峰值 672K 里约 27 万是插件自己注入的）—— 压缩插件自己的热上下文成了最大的消费者。
现在用 DSH 官方的 `surfaceOp:{op:"replace"}` **就地替换**，surface 上永远只有一条；
历史追加出来的旧清单被一次性换成一行占位（事故会话 surface 上还压着 44 条 / 29.5 万字符 ≈ 9.8 万 token）。
证据与遗留：`evidence/P1-4-清单替换实测.md`。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/engine.mjs` | 引擎（继承 dsh-compaction-basic） |
| `src/graph.mjs` | 棋谱 DAG + 手割 + 三态 + 三层树渲染 |
| `src/ledger.mjs` | 热清单 + 硬事实块 |
| `src/summary-prompt.mjs` | 摘要指令 + 机械约束 |
| `src/verifier.mjs` | 成功/失败判定 |
| `test/run.mjs` | 118 项单测 |
| `test/verify-graphs.mjs` | 全库棋谱健康检查（P0 验收工具） |
| `test/ab-render.mjs` | 热清单标记 A/B 夹具（模型消费者实验） |
| `test/real-ledger-replace.mjs` | 真实 Session 上的「清单就地替换」机制验证（8 项） |
| `test/measure-billing.mjs` | 真实 usage 计费审计（prompt/缓存/清单占比/fold 收支） |
| `test/rewash-graph.mjs` | 历史棋谱回洗（errorSnippet 重取 + text 型误报降级；dry-run 默认） |
| `test/doctor.mjs` | 一条命令体检（安装 / 摘要模型 / 压缩成败 / 棋谱 / 树新鲜度） |
| `test/real-headless-fold.mjs` | **真实 dsh 进程**里的 fold 验收（真 Session / 真 compactRegion） |
| `test/markers.test.mjs` | 标记契约（9 项） |
| `docs/三层树设计.md` | 三层树设计依据 + 6 缺陷 |
| `docs/P0-worldhash-死循环-根因与修复方案.md` | P0 根因 + 修复方案 + 验证清单 |
| `docs/最终报告.md` | 完整报告（含 v1.x 章节） |
| `evidence/` | 17 个证据文件（含 `P0-worldhash-修复验证.md`） |

## 未完成（按优先级）

> **2026-11-01（1.14.0）复核：这一节是 2026-10-29 的旧清单，只有历史价值。**
> 当前真正的「未完成」只有三件：
> **① 把插件装到 live**（见顶部「最新状态」与「新版 DSH 适配」四步；需停机窗口 + 授权 + 重启）；
> **② preset 生成并装进 live 后，还要在会话里选中它**（preset 插件惰性激活 —— 不选就等于没装）；
> **③ 真实压缩一轮的验收**（在测试实例上补模型路由，或在 live 装完重启后看 `compaction/summary` 与棋谱落盘）。
> 下表第 1 项早已完成，第 4–6 项是旧 home 的数据问题，**新 home 上没有那些数据**（`<home>/chess-context` 不存在）。
> ~~tokenMeter~~ 已在 **1.13.0** 解决（热清单定价 CJK 感知；见顶部「最新状态」的划线说明）。
> ~~UI 相关（M1-1 / M2-1 / M2-2 / M3-1 / M3-2 / M2-3）~~ 已在 **1.14.0** 解冻并收口（改版见「UI」节；
> 其中外部 API / 私有凭据通道按主人裁定**不做**；`M2-3` 的「真机 fold 走所选模型」验收仍未做）。
> ~~手动压缩按钮~~（历史欠账第 8 条）已在 **1.14.0** 判定**不做并关闭**，理由见「不做」节。
> **1.14.0 的 UI 视觉验收仍未做**：真实浏览器 1280/599 视口没看过（只有源码级 + 纯函数级断言）。

> 2026-10-29：goal 当前阶段的 ①–⑤ 全部完成（各有可复跑脚本 + 证据文件，见下方表格）。
> 下面只剩「需要主人动一下」和「后续可选」两类。

| # | 项 | 说明 |
|---|---|---|
| 1 | **重启 DSH（部署最新代码）** | ✅ 已做；`doctor` 全绿（0 错误 0 警告）|
| 2 | **GUI 长会话的自然 fold** | 机制链路已在真实 dsh 进程验证（`test/real-headless-fold.mjs`，多次 3~6/6 成功）；GUI 里 45 万 token 的自然触发要等重启后跑一段 |
| 3 | **真实计费对账（口径已建）** | `test/measure-billing.mjs` 能按会话拆「未缓存/缓存/清单占比/fold 收支」；网关价目表不落盘，金额需主人按账单折算 |
| 4 | **其它历史会话的回洗** | `test/rewash-graph.mjs` 只对 session-5acafe42 跑过；其余会话按需各自 dry-run + apply |
| 5 | **index.md 时效性** | v1.6.1 起每次 flush 重写；`nodes/*.md` 仍只在首次/fold 后写（快照，细节以 graph.json 为准） |
| 6 | **`text` 型残留 8 条** | 证据区间对不上，保守未洗（见 `evidence/收尾三件-dead锚点-树读取-回洗.md`） |

## goal ①–⑤ 的验收对应

| 项 | 证据 / 复跑 |
|---|---|
| ① 真实计费核对 | `evidence/真实计费核对.md` · `node test/measure-billing.mjs` |
| ② 真实进程首次 fold | `evidence/真实进程首次fold.md` · `node test/real-headless-fold.mjs` |
| ③ dead 重开锚点 / 缺资源语义 | `evidence/收尾三件-dead锚点-树读取-回洗.md` · `node test/run.mjs markers` |
| ④ 历史误报回洗 | 同上 · `node test/rewash-graph.mjs <sessionDir> [--apply]` |
| ⑤ 三层树被模型主动读取 | 同上（盲测 2/2）· 渲染层 `TRACE:` 行 |

## 怎么验证 / 装 / 回滚

```bash
cd D:/主工作区/projects/dsh-chess-context

# 验证（当前 v1.3.5 工作区）
node test/run.mjs            # 118 passed
node test/verify-install.mjs # 13/13
node test/real-modules.mjs   # 4/4
node test/real-fold.mjs      # 5/5
node test/bench.mjs 2000     # 323 tokens / 0.478 ms
node test/verify-graphs.mjs  # 全库棋谱健康检查（P0 验收；重启后必跑）

# 装 / 回滚
node test/install.mjs --dry-run
node test/install.mjs
node test/rollback.mjs
```

## 用户的核心指示（逐字，不要曲解）

> **这是给模型用的，不是给我用的，也不是给我看的。要你喜欢才是真的好用。**

> 做一个任务就像完成一局棋局，把每轮的思考变成一次落子。棋谱本来也能在每一次落子或者分支里面保留评语，这个评语就是 llm 自己写的，也能追溯到当时的完整想法。

> 走出同型甚至不如同型的结果，或者不知道如不如标准定式的适合一般有一种专门的复盘方法……就是在原本标准定式的走法里面把多出来的几步插进去，就能知道多的到底对不对，谁亏谁赚。

## ⚠ 死循环警告（给下一个会话）

今天后半段陷入了「**发版 → 再发版 → 再发版**」的循环（v1.2.6 → v1.3.4，9 个版本）。

**下一次会话不要这样**：

1. **先确认有真实需求再改** —— 不要为了发版而发版
2. **一个改动一个版本**，不要「文档同步」也单独发版
3. **用户说「做交接文件」时，说明他想结束当前会话** —— 不要继续发版
4. **优先做未完成清单里的高优先级项**，不要在小事上打转

> 本轮（P0 修复）是这条警告想要的样子：有真实故障、只动 1 个版本号、不推送不发 Release。

## 今天的四个最大教训

1. **结构对了不等于内容对了** —— 三层树结构对，但内容不全（截断/漏写/全表没列/评语没兜底/误报没标注）
2. **不要改运行中的数据** —— `#flush` 会覆盖 `graph.json`
3. **SGF 是树，我们是 DAG** —— 最大入度 119，目录嵌套会重复爆炸
4. **假数据比真实数据干净，会把契约不一致藏住** —— 87 项单测全用字符串 `worldHash`，
   而真实 `worldstate.hash()` 返回对象；P0 因此躲过了全部单测，直到实机 226 次压缩只成功 3 次。
   **修法是加一条走真实数据形状的端到端回归**（`test/engine-harness.test.mjs` 的 P0 用例）。
