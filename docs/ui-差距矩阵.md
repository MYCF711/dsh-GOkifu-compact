# 上下文压缩插件 UI 差距矩阵

> 审计对象：`lib/client.js`（React 浏览器半）与 `src/ui.mjs`（host 半）。
>
> 权威来源：只读 `<DSH_HOME_OR_INSTALL_DIR> Harness/home/DSH-UI-official.md`、`dsh-ui-official/structure/**`、`dsh-ui-official/assets/**` 与 `LIBRARY-MANIFEST.json`。没有重新拆 asar/CSS，没有按截图自造层级。
>
> 官方冻结基线：`0.2.1-rc.5`；asar SHA-256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`；主库入口证据 `DSH-UI-official.md:35-48`。
>
> 结构文档产物 SHA-256：`official-settings-tree.md = 3d38c2735fab18e55c897220d159fee6e74287bccaf991fbb67c467aa05e583a`；`official-shell-tree.md = c93fc2da4b4ffe2a9198b7d2cab69a123e4646326b25c5d555f41f5b99e99f38`（`LIBRARY-MANIFEST.json:321-328`）。

## 0. 口径与边界

五态沿用官方 `structure/gui-structure-gap.md:13-25`：

- `same`：职责、父级、主要子节点、几何/素材与该行行为一致；不是“看起来差不多”。
- `derived`：同职责与父级、主要结构可辨认，但采用原生等价集成或有明确局部差异。
- `partial`：只实现官方节点的一部分，或混入会改变官方层级的额外节点。
- `missing`：官方节点当前不存在；没有真值时继续隐藏。
- `extra`：当前自造节点在官方对应位置不存在；功能真实也不改判。

本插件是 `sidebar.panellist → main[key=gokifu-compact]` 的**独立插件主面板**，不是官方 SettingsRoot、Conversation、Composer 或 Trajectory。审计只拿相近的官方部件规范做对照，不把整个页面搬入设置模态，也不把棋谱指标伪装成官方会话节点。

“改后”列是本论最小修改的验收目标；实际实施记录、前后文本对照与命令输出见后文。表中“当前证据”的 `lib/client.js` 行号是**改前快照**，用于证明差距来源；改后的准确定位见第6节，官方证据行号始终不变。`src/ui.mjs` 不产出 DOM，host 行的五态只表示它对相应可见部件的数据支持方式，不虚构官方 HTTP 路由。

## 1. 主壳、配置与通用部件矩阵

| # | 当前部件 / 官方相近节点 | 改前 | 改后 | 当前证据 | 官方证据（主库文件:行） | 差距与最小决策 |
|---:|---|---|---|---|---|---|
| 1 | `sidebar.panellist` 导航行 / 官方 PanelRow | partial | derived | `lib/client.js:1205-1210`：正确槽位、`order:30`、标签真实，但图标自画 | `official-shell-tree.md:101`：36 高、gap8、14/22、真实注册项；`gui-structure-gap.md:13-25`：原生集成属 derived | 保留槽位、顺序与动作，只替换图标；不重造导航行 |
| 2 | 侧栏“上下文压缩”图标 / `IconCompactOutlineRegular` | extra | same | `lib/client.js:1197-1202`：两条横线 + 两个 circle，官方无此图元 | `official-assets-reuse.md:53`；`assets/manifest.json:233-244`：16 viewBox、专用于“上下文压缩” | 官方确有同义素材，逐 path 复用，删除手画图元 |
| 3 | `main[key=gokifu-compact]` / 官方 root keyed main | derived | derived | `lib/client.js:1211-1212` | `official-shell-tree.md:89`：全局面板由自己的包注册到 root keyed `main` | 层级正确，保留；不能塞进 sidebar overlay 或 SettingsRoot |
| 4 | 页面双栏、1600px 上限、整页滚动 | extra | extra | `lib/client.js:473-500`、`:787-826`、`:1183-1192` | `official-shell-tree.md:89` 只规定主槽容器，没有本插件详情页双栏树 | 特有页面布局；保留已有滚动修复与 1280/600 断点，不借官方名义重排 |
| 5 | 通用卡片 / Models、Agent preset、inventory 卡 | partial | derived | `lib/client.js:513`：1px 边、10px 圆角、14/16 padding、无卡填充令牌 | `official-settings-tree.md:164-170`：`.5px` settings stroke/fill、radius-xl、12/14；`:204`：inventory card radius-lg；`:219-223`：preset radius-xl | 采用与本页信息卡最接近的 Models/preset 几何：`.5px`、xl=16、12/14、settings fill/stroke；原生 CSS 集成所以 derived，不宣称同树 |
| 6 | 卡片标题 / inventory group title、插件配置卡 heading | partial | derived | `lib/client.js:514`：12px、uppercase、字距、opacity .55 | `official-settings-tree.md:204`：group title 13/20/500；`:212`：插件配置 heading 13/1.5/600 | 改为 13/20/500，去掉自造全大写与弱化为装饰的样式；文案不变 |
| 7 | 参数行 / General selector row | partial | partial | `lib/client.js:79-90`：6/8px 行 padding、1px 自造边、额外“默认值”第三列 | `official-settings-tree.md:108-113`：16px 0、gap8、`.5px` border-l2、标题14/22、说明12/18 | 行几何与令牌对齐；第三列是插件配置元数据，保留，因此整行仍 partial，不冒充官方 General item |
| 8 | 参数标题与说明 / General row typography | partial | derived | `lib/client.js:523-524`：13/11、opacity .55 | `official-settings-tree.md:108-113`：标题14/22 primary、说明12/18 tertiary | 改为官方字号、行高和语义令牌；字段文案与特有默认值不变 |
| 9 | 文本/数字输入 / Models editor input | partial | derived | `lib/client.js:535`：5/8 padding、6px 圆角、1px 边、无36最小高 | `official-settings-tree.md:169-170`：min-height36、radius-md、6/10 padding、border l3 | 只改原生控件几何与令牌，校验和 draft 行为不变 |
| 10 | 布尔字段 / 官方 Switch | missing | missing | `lib/client.js:723-729`：原生16×16 checkbox | `official-settings-tree.md:110-111`：开发者/上传行右侧 Switch；`:309-310`：primitives 内部实现不在本批证据 | 官方 Switch 素材/内部契约确未提供；保留原生等价控件，不手画 Switch 冒充官方 |
| 11 | 普通 enum `<select>` / General 选择器 | derived | derived | `lib/client.js:730-732` | `official-settings-tree.md:108-113`：高36、radius-md、0/14、gap12、module-platform | 动态选项真实；沿用原生 select，几何随共享 input/selector 规范收敛 |
| 12 | provider/model 弹层与 chevron / 官方选择器 | partial | derived | `lib/client.js:602-715`：自绘弹层，触发器用字符 `▾`；`:528-534` | `official-shell-tree.md:128-130`：选择器高28/36因位置而异；`official-settings-tree.md:108-113`：设置选择器高36；`official-assets-reuse.md:73` | 本部件位于设置表单，采用36而非 Composer 28；仅 chevron 换官方矢量，保留已有弹层行为，故 derived |
| 13 | chevron 图元 / `IconChevronDownOutlineRegular` | extra | same | `lib/client.js:630`：字符 `▾` | `official-assets-reuse.md:73`；`assets/manifest.json:373-384`：14px、16 viewBox | 官方已有等价物，逐 path 复用 |
| 14 | 当前模型项 check / `IconCheckOutlineRegular` | missing | same | `lib/client.js:643-713`：只以背景/粗体表示当前项 | `official-shell-tree.md:130`：只给完全相等项打勾；`official-assets-reuse.md:74`；`assets/manifest.json:387-398` | 给 provider/model 及“跟随路由”的当前相等项补官方 check；不选近似项 |
| 15 | provider/model 两级目录 / 官方 ModelSelect | partial | partial | `lib/client.js:634-715`；`src/ui.mjs:648-695` | `official-shell-tree.md:130`：trigger、provider+model(+effort)、>4才搜索、目录真状态 | 数据是真 provider/model；本页是两个配置字段而非 Composer 双 pane，无 effort/搜索。保留特有语义，不伪造完整 ModelSelect |
| 16 | 主/次按钮 / Models buttons | partial | derived | `lib/client.js:537-538`：7px 圆角、按内容撑高、自造蓝色 | `official-settings-tree.md:170`：主/次高36、0/14、radius-md；`official-shell-tree.md:36`：business-primary=#5686fe | 高、padding、圆角、边框与主色对齐；保存/刷新/补账动作不变 |
| 17 | 接管状态 pill / provider tag、inventory StateTag | partial | derived | `lib/client.js:539`：11px、2/8、999胶囊 | `official-settings-tree.md:168`：tag 11/16、1/6、radius-xs；`:196-204`：inventory StateTag | 改成官方 tag 几何与 success/error 语义令牌；健康真值不变，不把 StateTag 语义夸大为官方同款 |
| 18 | 焦点环 / 官方 focus ring | derived | derived | `lib/client.js:102-134`：原生 onFocus/onBlur，2px | `official-shell-tree.md:84-86`、`:170`：focus ring 2px；`official-settings-tree.md:170` | 保留现有2px原生集成及既有测试契约，不为“更好看”改颜色/行为 |
| 19 | 上下文窗口进度条 / ContextMeter | extra | extra | `lib/client.js:520-521`、`:1094-1118` | `official-shell-tree.md:132`：官方是 used+contextWindow 的 ProgressRing，不是本插件最近棋谱条形卡 | 数据语义不同，保留条形图；不把6px条形冒充官方 ring |
| 20 | 更新横幅、更新卡与升级命令 | extra | extra | `lib/client.js:1064-1092`；`src/ui.mjs:697-934`、`:1476-1481` | `official-settings-tree.md:130`：官方 current-version 是 General 一行，值来自 `modules.entries.currentVersion` | 本页是**插件自身** npm 版本，不是 DSH 版本；保留，不伪装成官方 current-version |
| 21 | 复制升级命令的文字按钮 / message copy icon | extra | extra | `lib/client.js:1075-1078` | `official-assets-reuse.md:98` 的官方 copy 目标是 `message_area.go` 消息动作，不是插件升级代码块 | 素材语义位置不匹配，本轮不把消息图标硬塞进来；保留可选中文本与真实剪贴板降级 |
| 22 | 标题、profile、运行状态卡 | extra | extra | `lib/client.js:1027-1062` | `official-shell-tree.md:112-120` 没有插件健康/profile 这种 Conversation header | 特有真值，保留原位置和文案 |
| 23 | 保存/错误/配置来源通知 | extra | extra | `lib/client.js:1155-1168` | `official-settings-tree.md:84-90` 的官方保存走 settings mirror/revision；本插件走 preset 文本块 | 行为与数据源不同，保留真实结果，不冒充官方 Toast/settings mirror |
| 24 | host 模型目录 `modelCatalog` | derived | derived | `src/ui.mjs:648-695`：真实 `llm.listProviders/listModels/resolveModelInfo`，缺窗口为 null | `official-shell-tree.md:130`：模型与 contextWindow 必须来自真目录 | 数据方向正确；保留4秒预算、空目录降级与真实 null，不改 host |
| 25 | host state/save/health/update API | derived | derived | `src/ui.mjs:1424-1482`、`:1673-1702` | `official-shell-tree.md:89` 允许插件自己的 main；官方未给本插件 API | 不可见原生集成；保留路由、CSRF、备份和 revision 外的既有契约，本任务不改 host |
| 26 | 官方动态 `settings.general.item` / `plugins.item` 注册 | missing | missing | 当前只有 `sidebar.panellist` 与 `main`，`lib/client.js:1205-1212` | `official-settings-tree.md:104-138`、`:206-215` | 本插件尚未注册官方动态设置槽；不能为了对齐而假造 General item 或把22键塞进官方 General。保持 main 扩展，标清缺口 |

## 2. 特有棋谱概念：保留，但不冒充官方

| # | 特有部件 | 改前 | 改后 | 当前证据 | 官方证据 | 必须保留/不新增的理由 |
|---:|---|---|---|---|---|---|
| K1 | 棋谱 DAG 的节点/边计数 | extra | extra | `lib/client.js:1100-1118`；`src/ui.mjs:295-313` | 官方 `T0-T6` 是 Session Trajectory ledger，`official-shell-tree.md:135-149`，没有棋谱 DAG | 节点=状态、边=尝试+验证，是本插件数据模型；当前只显示计数，**没有 DAG 图形视图**，本轮不新增 |
| K2 | 最近 fold 的 seq 范围与遮蔽 tokens | extra | extra | `lib/client.js:1115-1118`；`src/ui.mjs:301-313` | 官方 compacted kind 只是会话记录类型，`official-shell-tree.md:143-147`，不是本插件增量 fold 区间 | 保留真实 `seqStart/seqEnd/shadowedTokens`；只按卡片/指标排版，不改含义 |
| K3 | 折痕（foldMarks）列表 | missing | derived | `src/ui.mjs:331-373` 提供最近20条白名单投影，`:1561` 在现有 `state` 响应新增 `foldMarks`；`lib/client.js:625-642` 实现 `FoldList`，`:1181`、`:1245` 摆入现有右栏；`test/fold-list.test.mjs:142-218` 四条真实路由/React树守卫 | 官方没有折痕列表素材或节点；卡片、General 行与 provider tag 几何沿用 `official-settings-tree.md:108-113,164-170` | 本轮已作为特有 derived 部件补齐：逐行显示时刻、seq 区间、trigger、摘要字符数、usage、截断与 finishReason；`archive-offline`=归档补账、`pressure`=实时压力折叠；空数组显示「还没有折叠」 |
| K4 | 失败边与已修正失败 | extra | extra | `lib/client.js:1110-1112`、`:1131`；`src/ui.mjs:271-276` | 官方工具 error/stopped 是执行状态，不是“同 action 后续跑通”的失败记忆，`official-shell-tree.md:124-125` | 保留失败/已修正两个不同指标；不换成统一灰点、对勾或官方工具状态 |
| K5 | 今日 fold、会话、遮蔽与成本估算 | extra | extra | `lib/client.js:1121-1132`；`src/ui.mjs:416-493` | 官方 Usage 是 token 三桶，`official-shell-tree.md:132`，不是按 fold 时刻峰谷计价 | 数据口径特有且真实，保留“估算”与覆盖率，不套用 UsagePill |
| K6 | 补账干跑、分段折叠、失败清单 | extra | extra | `lib/client.js:337-406`、`:974-1010`、`:1172-1181`；`src/ui.mjs:1483-1672` | 官方 QueueDock 是待发送用户输入，`official-shell-tree.md:133`，不是归档会话补折 | 保留 dryRun、限量、在途闸门与逐会话失败原因；不能改名 Queue 冒充官方 |
| K7 | 热清单、置换、首折、closeout 等22个配置字段 | extra | extra | `lib/client.js:554-580` | `official-settings-tree.md:115-138` 的官方 General 11 slot/12行没有这些字段 | 是插件真实 schema；保留字段和默认值，只复用官方行/控件规范，不硬塞进官方 General |
| K8 | 接管健康、单实例与配置路径 | extra | extra | `lib/client.js:1027-1029`、`:1167`；`src/ui.mjs:535-568` | 官方连接状态属于 sidebar.settings，`official-shell-tree.md:106`，语义不是压缩引擎接管 | 保留插件健康真值，不把它伪造成 DSH 连接状态 |

## 3. 官方素材复用登记（无 derived 图元）

| 用途 | 主库素材 | 官方符号 / 来源 | 产物 SHA-256（已用 `sha256sum` 重算） | 集成方式与 derived 判定 |
|---|---|---|---|---|
| 侧栏上下文压缩 | `dsh-ui-official/assets/icons/sidebar/compact.jsx:1-2` | `IconCompactOutlineRegular`；源 `index-BXV-oxvX.js`；登记于 `official-assets-reuse.md:53`、`assets/manifest.json:233-244` | `ecf9b854d8f8f390ccfae6a3819761630fa5032282a397d5ea0afdd070dfdfc2` | **same 图元**：两条 path 的 `d/opacity/stroke` 原样进入 React；只把 `d.jsx` 适配为既有 `h=React.createElement`。没有新 SVG、没有改路径，因此不是 derived 素材 |
| 下拉 chevron | `dsh-ui-official/assets/icons/composer/chevron-down.jsx:1` | `IconChevronDownOutlineRegular`；`official-assets-reuse.md:73`、`assets/manifest.json:373-384` | `865d156be1a74c3829a50acb1b56a59007b9c4280886fe728a5b0ff096a17632` | **same 图元**：原 path，14px、16 viewBox；仅 React 工厂适配 |
| 当前项 check | `dsh-ui-official/assets/icons/composer/check.jsx:1` | `IconCheckOutlineRegular`；`official-assets-reuse.md:74`、`assets/manifest.json:387-398` | `3b47a8c21d5bf626867f2d6b45a6ff8b2f7362123cfa76de5a395a2b2916bb8c` | **same 图元**：原 path，16px、16 viewBox；仅 React 工厂适配 |

CSS 几何/令牌不是新素材文件：它们来自上述两份结构文档，文档 hash 见文首。`derived` 仅描述**原生 React/CSS 集成层级**，不表示修改了官方图元。没有新增 derived 图标、截图、字体、CSS 文件或许可证副本；官方 asar hash 保持 `e1b6f25f…c6915`。

## 4. 最小修改清单（除此之外不改）

1. 用官方 Compact 两条 path 替换自画侧栏 sliders；用官方 chevron 替换 `▾`；给完全相等的当前项补官方 check。
2. 参数行改为16px纵 padding、`.5px border-l2`；标题14/22、说明12/18；输入/选择器/按钮采用官方36px、radius-md与设置令牌。
3. 卡片采用官方 `.5px` settings stroke/fill、radius-xl、12/14；标题13/20/500；健康 pill 采用官方 tag 11/16、1/6、radius-xs。
4. 保留双栏、滚动、字段第三列、23个配置键、所有指标、补账和更新行为；不改 `src/**`、测试、证据、脚本、其他 docs，不改生产 home，不 commit，不重启 DSH，不调模型。

## 5. 改前文本基线（实际运行输出摘要）

修改前通过 `new Function("window", src)` 执行真实 `lib/client.js`，捕获槽位注册的 Icon 并读取 `exports.__testables`：

```text
=== BEFORE: sidebar Icon ===
svg > path(d="M2 5.5h12M2 10.5h12", strokeWidth=1.4) + circle(cx=6,cy=5.5,r=1.8) + circle(cx=10.5,cy=10.5,r=1.8)
=== BEFORE: official-alignment candidates ===
fieldGrid.padding = 6px 0（599px 时为 8px 0）；borderBottom = 1px solid rgba(127,127,127,0.12)
card = 1px border / 10px radius / 14px 16px padding / 无 settings fill
cardTitle = 12px / uppercase / letterSpacing .04em / opacity .55
fieldLabel = 13px；fieldHint = 11px / opacity .55
pickerBtn = 5px 8px / 6px radius / 1px border / gap 6px / 字符 ▾
input = 5px 8px / 6px radius / 1px border / 无 minHeight
btn = 7px 14px / 7px radius；btnPrimary = #2563eb / #3b82f6
pill = 11px / 2px 8px / 999px radius
```

这些值证明本轮不是“另起炉灶”：修改目标全部能在第1节的官方 file:line 找到对应值；官方没有的 DAG、fold、失败边、补账与插件更新内容均保持原样。

## 6. 实施后的前后对照（文本验收）

本轮没有启动/重启 DSH，也没有另起服务；按任务允许的方式，以真实 React 组件树、导出样式和源码 diff 做文本对照，不伪称截图或像素验收。

| 部件 | 改前 | 改后 | 向官方靠拢的证据 |
|---|---|---|---|
| 侧栏图标 | 自画两条横线 + 两个 circle | 官方 Compact 两条 path，`lib/client.js:1219-1223` | `compact.jsx:1-2` 逐属性一致；旧 `M2 5.5h12…` 与 circle 已删除 |
| 下拉尾部 | 字符 `▾` | 官方 Chevron，14px，`lib/client.js:640`、`:1230-1233` | `chevron-down.jsx:1` 原 path |
| 当前项 | 仅背景/粗体，无 check | 官方 Check，provider 精确相等；model 必须 provider+model 同时相等，`lib/client.js:662-673`、`:698-722` | `official-shell-tree.md:130` 的完全相等判据；`check.jsx:1` 原 path |
| 参数行 | 6/8px padding、1px 自造边 | 统一16px 0、`.5px border-l2`，`lib/client.js:79-92` | `official-settings-tree.md:108-113` |
| 卡片 | 1px、10px、14/16、无 fill | `.5px` settings stroke/fill、xl=16、12/14，`lib/client.js:515-519` | `official-settings-tree.md:164-170`、`:219-223` |
| 标题/说明 | 卡标题12+uppercase；字段13/11+opacity | 卡标题13/20/500；字段标题14/22 primary、说明12/18 tertiary，`lib/client.js:518-530` | `official-settings-tree.md:108-113`、`:204`、`:212` |
| 输入/选择器/按钮 | 无36高、6/7px圆角、自造蓝 | 36高、radius-md=8、0/14或6/10、l3/module/business 令牌，`lib/client.js:535-547` | `official-settings-tree.md:108-113`、`:169-170`；`official-shell-tree.md:36` |
| 健康状态 | 999px 胶囊 | 11/16、1/6、radius-xs=4、success/error 令牌，`lib/client.js:548-549` | `official-settings-tree.md:168` 的 tag 几何 |
| 特有内容 | DAG/fold/失败边/补账/更新/profile/双栏 | 全部保留；可见内容未删，本任务未写 host | `lib/client.js:1051-1196`；`src/ui.mjs` 的本任务写入为空（共享树后续他人改动不计入） |

真实执行 `lib/client.js` 后的原样资产断言输出：

```text
=== AFTER: official asset assertions ===
compact/chevron/check exact paths = PASS; legacy sliders/▾ = absent
```

随后直接读取主库 JSX，与客户端的 `d` 属性逐一比对（不是拿客户端常量自证），原样输出：

```text
compact: 2 official path(s) verbatim = PASS
chevron: 1 official path(s) verbatim = PASS
check: 1 official path(s) verbatim = PASS
model check: provider+model exact equality = PASS
```

改后组件树包含 `opacity="0.35"` 的官方外圈 path 与官方弧 path；改后导出样式实测为：`fieldCount=22`、`fieldGrid.padding="16px 0"`、`card.radius=var(--dsw-radius-xl,16px)`、`card.padding="12px 14px"`、`pickerBtn/input/btn.minHeight="36px"`、`pill.padding="1px 6px"`。这些值与上表源码回读一致。

## 7. 实际验收输出

### 7.1 UI 定向回归

命令：`node --check lib/client.js && node test/run.mjs ui-layout`。`node --check` 无输出、退出0；测试原样汇总：

```text
== 12 passed, 0 skipped, 0 failed ==
```

### 7.2 全量串行测试

命令：`node test/run.mjs`（只运行一个实例）。索引集成后的第二次完整运行退出0，原样汇总：

```text
== 2013 passed, 0 skipped, 0 failed ==
```

第一次完整运行曾为 `2012 passed, 0 skipped, 1 failed`，唯一失败是 D-3 新文档尚未登记到 `docs/README.md`。本子任务没有越权修改索引；父级集成补上 `docs/README.md` 的一行登记后，第二次完整运行把同一项转为通过，因此最终数字比第一次多1。不是跳过测试，也不是改写失败结果。

### 7.3 压缩边界审计

命令：`node scripts/boundary-audit.mjs`，原样完整输出：

```text
== 压缩边界审计（扫 26 个 src/**/*.mjs · 豁免 1 条（见脚本 ALLOW））==
  ✓ 没有发现越界线索（行为指导 / 工具治理）

✅ 越界线索 0 条
```

### 7.4 范围与未验项

- `git diff --check` 无输出、退出0。
- 本任务只写 `lib/client.js` 与 `docs/ui-差距矩阵.md`；没有写 `src/**`、其他 `lib/**`、其他 `docs/**`、`evidence/**`、`scripts/**`、`test/**`，没有改生产 home，没有 commit、没有重启 DSH、没有调模型。
- 工作树在任务开始前已有 `AGENTS.md` 等他人修改，运行期间还有共享工作树变动；这些不属于本任务，不清理、不覆盖、不纳入“本任务改了什么”。
- 未做可见 GUI、截图、像素 diff、OS 键鼠/IME、高 DPI、真实模型或生产 home 验收。结论上限是主库证据、真实 React 树、样式导出、源码 diff 与上述 Node 门禁。
