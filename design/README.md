# design/ —— DSH Web GUI 外壳 + 上下文压缩面板（可交互原型）

> **这一层是「设计稿」，不是产物。** 四屏 HTML 都按 **官方 DSH Web GUI 的真实几何与令牌** 写，
> 用来在动代码之前定住「插件页长什么样、点下去怎么动」。
> **权威来源不是截图，是官方 dist** —— 每一处数值都在 `css/*.css` 里标了出自哪个包、哪个文件。

---

## 1 · 四屏

| 文件 | 是什么 | 看什么 |
|---|---|---|
| `dsh-shell.html` | **DSH Web 外壳**（会话页） | 三栏 AppFrame、侧边栏、会话页头部、输入卡片 —— 这是「框架」 |
| `gokifu-overview.html` | 上下文压缩 · **总览** | 压缩状态 / 今日投入产出 / 最近折痕 / 健康检查 / 补折 |
| `gokifu-folds.html` | 上下文压缩 · **折痕** | 完整折痕列表（时间 / seq 区间 / 触发原因 / 摘要字符数 / 完成度） |
| `gokifu-config.html` | 上下文压缩 · **配置** | 常用配置 4 个控件 + 危险提示 + 高级参数 9 项 + 保存动作 |

四屏共用同一份侧边栏与同一套令牌；「上下文压缩」那一行在面板屏里是选中态。

---

## 2 · 交互（`js/app.js`，原生 JS，无框架无构建）

| 动作 | 怎么试 | 行为 |
|---|---|---|
| 折叠侧边栏 | 点左上角面板图标 / **Ctrl+B**（mac 为 ⌘B） | 280px ↔ 56px 轨道，选择存 localStorage |
| **外观三选一** | 底部 **跟随系统 / 浅色 / 深色** 分段控件 | 三档都记住；「跟随系统」随 OS 实时变 |
| 全局面板行 | 点「上下文压缩」 | 跳到总览；「插件 / 自动化任务」弹 toast（本仓不做） |
| tab | 点 总览 / 折痕 / 配置 | 四屏互跳 |
| 工作区 | 点工作区行 | 展开 / 收起该工作区的会话 |
| 会话搜索 | 点「工作区」右侧放大镜 / **Ctrl+K** | 就地展开输入框，本地过滤；Esc 关闭 |
| 会话 | 点某条会话 | 选中态 + 改 `<title>` |
| 输入框 | 直接打字 | 自动增高（≤336px）、Enter 发送、Shift+Enter 换行 |
| 发送 | Enter 或点蓝色圆钮 | 追加一条用户气泡 → 思考中 → 追加助手回复（假数据） |
| 工具调用行 | 点 `Read …` | 展开文件信息 |
| 折痕行 | 点任意一条 | 展开摘要摘录 + 用量 |
| 配置 · 开关 | 点开关 | 切换 + 左侧 2px 脏标记 |
| 配置 · 下拉 | 点「45%」「hybrid」等 | 二级弹层（官方 pickerPop 形状），选中打勾 |
| 配置 · 保存 | 改几项后点「保存（N 项改动）」 | 写入 toast + 清脏；未改时按钮禁用 |
| 配置 · 恢复默认 / 刷新 | 底部两个次按钮 | 回到 schema 默认 / 回到上次保存快照 |

> 所有「会落盘」的动作都只落 localStorage 或弹 toast —— 这是原型，不是产品。
> 真实数据要接 `src/ui.mjs` 的 `/gokifu/api`。

### 深浅色：两套都是一等公民

- **浅色是默认**（DSH 官方默认就是浅色），不是「深色的降级版」。
  卡片、状态 pill、进度条、警告条、开关轨道都是 `color-mix(…, --dsw-alias-label-primary)` 这类**双主题同源**写法，
  不是各写一份 hex。
- 深色走官方 `body[data-ds-dark-theme]`（renderer 也是写这个属性），
  `build-tokens.cjs` 会**同值镜像**一份 `@media (prefers-color-scheme: dark)`：
  关掉 JS 也跟随系统，验收工具也能真的量到深色。显式选浅色时 JS 写 `data-theme="light"`，镜像块即被排除。
- **两套都逐屏量过**：4 屏 × 4 尺寸（1440 / 1280 / 1024 / 430）× 浅色 + 深色，
  截断 / 重叠 / 对比度 / 点击区 / 脚本报错 / 断链 全绿。

---

## 3 · 为什么是这个样子（数值出处）

| 元素 | 几何 | 官方来源 |
|---|---|---|
| 三栏 AppFrame | grid，左右栏 + 中栏 | `dsh-client-ui-layout` → `AppFrame.module.css` |
| 侧边栏 | 展开 **280px** / 收起 **56px**；< 1024px 自动收起 | 同上 + `ui-layout/README.zh.md:30` |
| 侧栏内边距 | `--dsh-sidebar-inline-padding: 12px`，`padding: 6px 12px` | `SidebarRoot.module.css:5` |
| 品牌行 | 高 **60px**，18px/600，`letter-spacing: .04em` | `SidebarRoot.module.css:37,43` |
| 图标按钮 | **28×28**，`--dsw-radius-sm`（8px） | `SidebarRoot.module.css:47` |
| 新建会话 | 高 **38px**，12px 圆角，**0.5px** 描边，`8px 12px` 内边距 | `SidebarRoot.module.css:57` |
| 全局面板行 | `min-height: 36px`，`padding: 7px 8px`，行距 **2px** | `SidebarRoot.module.css:73-75` |
| 工作区行 / 会话行 | **34px** / **32px** | `workspace*.css`（`*Row`） |
| 会话页头部 | `min-height: 76px`，`padding: 10px 28px 0 20px`，底边 0.5px `border-l3` | `conversation*.css`（`*Header`） |
| 输入卡片 | **28px** 圆角（`--dsw-radius-panel`）+ `--dsw-elevation-soft`，`padding-top: 8px`，`gap: 12px` | `conversation*.css`（`*Card`） |
| 发送按钮 | **34×34** 圆形，`--dsw-alias-button-info-fill` | `conversation*.css`（`*Primary`） |
| 用户气泡 | `--dsw-specific-bubble`，**20px** 圆角，`10px 16px` | `chat*.css`（`*Bubble`） |
| 面板 tab | 高 **28px**，**14px** 圆角，`0 10px` | 官方自动化任务页 `TaskManagerPage.module.css:143-189` |
| 面板卡片 | **0.5px** 描边 + **20px** 圆角（`--dsw-radius-xl`），`12px 14px` | `official-settings-tree.md:164-170` |
| 字段行 | `padding: 16px 0`，底边 0.5px `border-l2` | `official-settings-tree.md:108-113` |
| 间距尺度 | 全站只有 **4 / 8 / 12 / 16** 四档 | `lib/client.js:53-62`（`SPACING`） |

### 颜色

**一个都没挑，全从官方令牌取** —— 而且 `css/tokens.css` 是**生成**的（见 §5），
所以不存在「抄漏一条」：官方 `dsh-client-ui-theme` 的静态色板 + 别名层 + 深色覆盖逐字搬运。

- 侧栏底色 `--dsw-specific-sidebar-fill` = `#f9fafb`
- 面板行选中 `--dsw-specific-sidebar-nav-item-active` = `#ebeef2`
- 用户气泡 `--dsw-specific-bubble` = `#edf3fe`
- 主文字 `--dsw-alias-label-primary` = `#0f1115`；次要 `-secondary` = `#61666b`
- 品牌蓝 `--dsw-static-deepseek-500` = `#4176e6`
- 圆角只有 `4 / 8 / 12 / 16 / 20 / 28`（`radius-xs … radius-panel`）
- 缓动 `--ds-ease-in-out` = `cubic-bezier(.4,0,.2,1)`

---

## 4 · 目录

```
design/
  dsh-shell.html          外壳（会话页）
  gokifu-overview.html    上下文压缩 · 总览
  gokifu-folds.html       上下文压缩 · 折痕
  gokifu-config.html      上下文压缩 · 配置
  css/
    tokens.css            ⚙ 生成：官方设计令牌（浅色 + 深色 + 深色镜像 + 半径/缓动/字体/抬升/滚动条）
    shell.css             AppFrame / 侧边栏 / 会话页 / 输入区 / toast
    gokifu.css            上下文压缩面板（卡片 / tab / 字段行 / 折痕行 / 下拉 / 开关 / 按钮）
  js/
    app.js                交互层（侧栏 / 主题 / 跳转 / 搜索 / 输入 / 折痕 / 配置表单）
  assets/
    icons.svg             ⚙ 生成：官方 35 枚图标（viewBox / path 原样，只换成 <symbol>）
  _tools/                 生成与自检脚本（见 §5）
  README.md               本文件
```

四屏 HTML 也是生成的，且**自包含**：图标 sprite 内联在 `<body>` 里，只有 `css/*.css` 与 `js/app.js` 外链。
直接双击就能看，不需要起服务器。

---

## 5 · 怎么重新生成 / 自检

链：**app.asar → 图标 + 令牌 → sprite → 四屏 HTML**。

> **前置：`app.asar` 从哪来。** 第 1/2/3 步要读本机 DSH 安装里的 `app.asar`，
> 脚本**不写死任何人的本机路径**（那会让别人 clone 下来直接跑不起来）。定位顺序：
> ① 环境变量 `DSH_APP_ASAR`；② 从 `DSH_INSTALL_DIR` / `DSH_HOME` / 当前目录逐级向上找
> `<某级>/resources/app.asar`；③ 都没有就报错并告诉你怎么设。
>
> ```powershell
> # 本机（Windows）示例
> $env:DSH_APP_ASAR = "<DSH 安装目录>\resources\app.asar"
> ```
>
> 只跑第 4–6 步（`_sprite.cjs` / `render.cjs` / `smoke.cjs`）**不需要** asar ——
> 它们只读仓库里的 `_tools/_icons.json` 与 `assets/icons.svg`，任何机器都能跑。
> 脚本内部的路径一律 `path.resolve(__dirname, …)` 相对本文件定位。

```bash
# 1) 官方各包 CSS → tmp/design-official-css/（派生，不进 git）
node design/_tools/extract-official-css.cjs

# 2) 官方令牌 → css/tokens.css（含深色镜像）
node design/_tools/build-tokens.cjs

# 3) 官方图标 path → _tools/_icons.json
node design/_tools/_icon_dump.cjs IconPanelLeftOutlineRegular IconCompactOutlineRegular ...

# 4) 图标 JSON → assets/icons.svg
node design/_tools/_sprite.cjs

# 5) sprite + 标记 → 四屏 HTML
node design/_tools/render.cjs

# 6) 静态自检（结构 / 动作 / 图标 / 令牌 / 断链 / 外观三选一，76 项）
node design/_tools/smoke.cjs
```

- 改文案 / 改结构 → `_tools/render.cjs`
- 改样式 → `css/shell.css`、`css/gokifu.css`
- 改交互 → `js/app.js`
- **`css/tokens.css`、`assets/icons.svg`、四屏 `*.html` 都是生成物，不要手改**

`smoke.cjs` 是这次加的**回归门禁**：它拦的就是「CSS 写了 `.gk-switch__thumb`、render 忘了带上子元素」
这类只有对着真实 DOM 才看得见的问题（本次真踩过 —— 开关渲染成一个纯蓝药丸）。

---

## 6 · 边界（照 `AGENTS.md` §2.0a）

- **官方有对应语义就用官方语义**：卡片、tab、字段行、按钮、气泡、状态 pill、下拉弹层全是官方几何。
- **本仓特有概念**（棋谱 / 折痕 / 失败边 / 补折 / 候选）**保留内容**，但排版按官方规范写，
  **不硬套** Trajectory / Usage / Queue 这些官方没有对应语义的组件。
- **没有官方证据就不补位**：这一版里没有画右栏、没有画命令面板、没有画附件预览 ——
  它们在 DSH 里是独立插件，设计稿里不假装存在。
- **已知偏离**（都是可读性让步，逐条记着）：
  - `.row-time` 用 12px + `label-secondary`（官方 10px + `label-tertiary`，对比度 3.55:1 不够）；
  - 会话列内容宽 `clamp(560px, …, 620px)`（官方下界 680px，中文一行 49 字偏长）；
  - `.gk-btn--primary` 用 `--dsw-static-deepseek-600`（官方 `#5686fe` 配白字只有 3.5:1）；
  - `.gk-warning` / `.gk-pill--ok` / `.gk-bar` 用 `color-mix(…, --dsw-alias-label-primary)`
    （官方原色配自身浅底只有 2.3–3.7:1）—— 这条**同时**修好了深色下「暗红配暗红」；
  - 收起成 56px 轨道时**隐藏外观分段控件**（3 个 28px 按钮塞不进 56px），只留「设置」图标。

---

## 7 · 还没做的

- **右栏（rightbar）**：每会话一个停靠面，本插件不用，设计稿里没画。
- **真实数据**：折痕 / 用量 / 会话名全是示意值，接 `src/ui.mjs` 的 `/gokifu/api` 才有真数据。
- **模型目录**：模型选择器只弹提示，没画两级目录（宿主 `modelCatalog()` 才有）。
- **附件 / 语音 / 权限预设**：只有 toast 占位。

---

## 8 · 已落回真实插件（`lib/client.js`）

四屏定稿后，把设计里**能落到真实数据上**的部分移植进了插件本体（`lib/client.js`，React inline style）。
下表是「设计 → 代码」的对照，以及**为什么有几条没搬**。

| 设计里的 | 落回代码的方式 | 证据 |
|---|---|---|
| `.gk-card__head` 两端对齐 | 新增 `styles.cardHead`（`justify-content: space-between`），状态卡的标题与 pill 分开到两端 | `panel-layout` ① |
| `.gk-bar` + `--ratio` | 状态卡那一行里加**窗口占用条**：分子 = `state.latest.totalAfter`，分母 = 宿主模型目录的 `contextWindow`；**拿不到目录就不画**（绝不退回写死的 100 万） | `panel-layout` ⑧ |
| `.gk-fold__head` / `__detail` + 旋转箭头 | 折痕行整行是按钮，`aria-expanded` 驱动展开区；**同一时刻只展开一条** | `panel-layout` ⑧ |
| `.gk-switch`（36×20 + 16 拇指） | 布尔字段从原生 `<input type=checkbox>` 换成自绘 `role="switch"`，点击 / 空格 / Enter 三个入口都能切 | `panel-layout` ⑧ |
| `.gk-field[data-dirty]` 左侧 2px 竖线 | 行根 `position:relative` + 一个 `aria-hidden` 的绝对定位 `<span>`（inline 没有 `::before`），标签同时加粗到 500 | `panel-layout` ⑧ |
| `.gk-pill--ok/--warn/--error` 的对比度 | 文字改成 `color-mix(…, label-primary)`：绿 2.28:1 / 红 3.69:1 在浅色底上不达标，混完两套主题都 ≥4.5:1 | `ui-layout` ⑨（gap 扫描）+ 人眼 |
| `.gk-warning` | 同上，底与描边也换成 `color-mix`（原来写死 `rgba(229,72,77,…)`） | 同上 |
| `.gk-pop` 官方 menu 令牌 | 弹层从 `Canvas/CanvasText`（**系统色**，不跟 DSH 主题）改成 `--dsw-specific-menu` / `--dsw-elevation-prominent` / 背景模糊，全部带系统色兜底 | `ui.test` C511 |
| `.gk-sub` / `.gk-code` / `.gk-metric__label` 用 `label-secondary` | 三处 `opacity: 0.55–0.7` 改成**颜色令牌**（opacity 在深色下会把灰字压糊） | `ui-layout` ⑨ |
| `.gk-page { background: bg-base }` | 根容器补 `background: var(--dsw-alias-bg-base, transparent)` | — |
| 窄窗 `padding: 16px` | `<600px` 时根容器收到 16px（与字段行两行断点同源） | `ui-layout` ① |

### 没搬的三条（**不是漏了，是设计稿在这几处落后于实现**）

1. **今日投入产出的 Metric 横排**（`render.cjs:468-472`）：`test/panel-simple.test.mjs` 的①④明确禁止总览重新堆指标
   （`FORBIDDEN_METRICS` + `metricNodes === 0` 双守卫）。这是**用户拍过的简化**，搬回来等于把守卫删掉。
2. **折痕行的「摘要摘录」**（`.gk-fold__excerpt`）：`state.foldMarks` 的白名单只有 `summaryChars`（**字符数**），
   没有摘要正文；`test/fold-list.test.mjs:65,84` 还明确禁止 `summaryText` 进列表 payload。
   **没有真实数据就不画假文本框**（AGENTS §2.0a）。展开区里放的是**用量 + 完成度**（这两个是真的）。
3. **字段行三列 → 两列**（去掉「默认 X」第三格）：第三格是**真信息**（`state.defaults`），
   设计稿为了紧凑省掉了它，但代码这边没有理由丢掉。

> 另外设计稿里 tab 用 `<a href>` 互跳（四屏原型需要），插件里没有路由 —— 代码仍用
> `<button role="group" aria-pressed>`（与官方自动化任务页的 filter chip 一致），这是**有意分歧**。
