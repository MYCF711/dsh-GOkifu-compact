/**
 * 生成 design/ 下的四屏（含交互标记）：
 *   dsh-shell.html        —— DSH Web 外壳（会话页）· 框架
 *   gokifu-overview.html  —— 上下文压缩 · 总览
 *   gokifu-folds.html     —— 上下文压缩 · 折痕
 *   gokifu-config.html    —— 上下文压缩 · 配置
 *
 * 分工：本文件只负责「结构 + 文案 + 数据属性」；交互全在 js/app.js，
 * 样式全在 css/{tokens,shell,gokifu}.css。
 * 不要手改生成的 *.html —— 改这里再跑 node design/_tools/render.cjs。
 */
const fs = require("fs");
const path = require("path");

// 相对本文件定位（`design/`），**不写死本机绝对路径** —— 别人 clone 下来也能直接跑
const ROOT = path.resolve(__dirname, "..");
const sprite = fs.readFileSync(path.join(ROOT, "assets", "icons.svg"), "utf8").trim();

const icon = (name, cls = "ico") =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}" /></svg>`;

/* 官方鱼形标记（23.16 × 17.04，取自 dsh-web-frontend/dist/favicon.svg） */
const FISH_PATH =
  "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018Z";

const FISH = (size) =>
  size
    ? `<svg viewBox="0 0 23.16 17.04" width="${size}" height="${size}" aria-hidden="true" style="fill:currentColor"><path d="${FISH_PATH}"/></svg>`
    : `<svg viewBox="0 0 23.16 17.04" aria-hidden="true"><path fill="currentColor" d="${FISH_PATH}"/></svg>`;

/* ══════════════════════════════════════════════════════════════════════
 * 侧边栏
 * ════════════════════════════════════════════════════════════════════ */
const WORKSPACES = [
  {
    id: "gokifu",
    name: "dsh-GOkifu-compact",
    open: true,
    sessions: [
      { title: "上下文压缩 · 面板设计", time: "刚刚", dot: "busy", selected: true },
      { title: "P6-C 真实 apply 预演", time: "12 分钟", dot: "done" },
      { title: "0.2.2-rc.1 兼容适配", time: "1 小时", dot: "warn" },
      { title: "折痕渲染性能基线", time: "昨天", dot: "" }
    ]
  },
  { id: "design", name: "设计稿", open: false, sessions: [] },
  {
    id: "dsh",
    name: "DSH 本体",
    open: true,
    sessions: [
      { title: "Web GUI 布局复原", time: "11-06", dot: "" },
      { title: "插件槽位接线", time: "11-05", dot: "done" }
    ]
  }
];

function workspaceGroup(w) {
  const rows = w.sessions
    .map(
      (s) => `
                  <div class="session-row" role="treeitem" tabindex="0"${s.selected ? " data-selected" : ""} style="--dsh-workspace-indent: 14px">
                    <span class="row-dot"${s.dot ? ` data-state="${s.dot}"` : ""}></span>
                    <span class="row-title">${s.title}</span>
                    <span class="row-time">${s.time}</span>
                  </div>`
    )
    .join("");

  return `
                <div class="ws-group" data-ws="${w.id}"${w.open ? "" : " hidden"}>
                  <div class="ws-row" role="treeitem" tabindex="0" aria-expanded="${w.open}" data-action="toggle-ws">
                    <span class="row-slot">${icon("chevron-right", "ico ico--14 ws-row__chevron")}</span>
                    <span class="row-title">${w.name}</span>
                  </div>${rows}
                </div>`;
}

function sidebar(active) {
  const panelRow = (id, glyph, label) => `
            <button type="button" class="panel-row"${active === id ? " data-active" : ""} data-panel="${id}">
              <span class="panel-row__glyph">${icon(glyph)}</span>
              <span class="panel-row__title">${label}</span>
            </button>`;

  return `      <div class="sidebar-col">
        <div class="sidebar">
          <div class="logo-row">
            <button type="button" class="brand" aria-label="新建会话" data-action="new-session">
              <span class="brand__identity">
                <span class="brand__mark">${FISH()}</span>
                <span class="brand__name">DeepSeek Harness</span>
              </span>
            </button>
            <button type="button" class="icon-btn" aria-label="收起侧边栏" title="收起侧边栏（Ctrl+B）" data-action="toggle-sidebar">
              ${icon("panel-left")}
            </button>
          </div>

          <button type="button" class="new-session" aria-label="新建会话" data-action="new-session">
            <span class="new-session__content">${icon("new-chat", "ico ico--18")}<span>新建会话</span></span>
          </button>

          <nav class="panel-list" aria-label="面板">${panelRow("plugins", "plugin", "插件")}${panelRow("cron", "alarm-clock", "自动化任务")}${panelRow("compact", "compact", "上下文压缩")}
          </nav>

          <div class="region-area">
            <div class="section-header" data-search-root>
              <span class="section-label">工作区</span>
              <span class="search-slot">
                <input type="search" class="search-input" placeholder="搜索会话…" aria-label="搜索会话" data-action="search" hidden />
                <button type="button" class="icon-btn" aria-label="搜索会话" title="搜索会话" data-action="toggle-search">
                  ${icon("search")}
                </button>
              </span>
            </div>
            <div class="list-area">
              <div class="session-list" role="tree" aria-label="工作区与会话" data-session-list>${WORKSPACES.map(workspaceGroup).join("")}
                <div class="session-empty" data-session-empty hidden>没有匹配的会话</div>
              </div>
            </div>
          </div>

          <div class="foot-area">
            <div class="footer-actions">
              <div class="theme-seg" role="radiogroup" aria-label="外观" data-theme-seg>
                <button type="button" class="theme-seg__btn" role="radio" aria-checked="true" aria-label="跟随系统" data-theme-pick="system" title="跟随系统">
                  ${icon("follow-system", "ico ico--14")}
                </button>
                <button type="button" class="theme-seg__btn" role="radio" aria-checked="false" aria-label="浅色" data-theme-pick="light" title="浅色">
                  ${icon("light", "ico ico--14")}
                </button>
                <button type="button" class="theme-seg__btn" role="radio" aria-checked="false" aria-label="深色" data-theme-pick="dark" title="深色">
                  ${icon("dark", "ico ico--14")}
                </button>
              </div>
              <button type="button" class="settings-row" data-action="settings">
                <span class="panel-row__glyph">${icon("settings")}</span>
                <span class="panel-row__title">设置</span>
              </button>
            </div>
          </div>
        </div>
      </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 会话页（框架那一屏）
 * ════════════════════════════════════════════════════════════════════════ */
function conversation() {
  return `      <div class="center-col">
        <div class="conv">
          <header class="conv__header">
            <div class="header-leading">
              <button type="button" class="icon-btn" aria-label="展开侧边栏" title="展开侧边栏（Ctrl+B）" data-action="toggle-sidebar">
                ${icon("panel-left")}
              </button>
            </div>
            <div class="title-row">
              <div class="title-cluster">
                <div class="crumbs">
                  <button type="button" class="crumb" data-action="crumb-workspace">dsh-GOkifu-compact</button>
                  <span class="crumb-sep">/</span>
                  <span class="crumb crumb--current">上下文压缩 · 面板设计</span>
                </div>
              </div>
              <div class="header-actions">
                <button type="button" class="selector" title="wps-lingxi · deepseek-v4.1-flash" data-action="pick-model">
                  <span>wps-lingxi / deepseek-v4.1-flash</span>
                  ${icon("chevron-down", "ico ico--14 selector__chevron")}
                </button>
                <button type="button" class="icon-btn" aria-label="刷新" title="刷新" data-action="refresh">${icon("refresh")}</button>
                <button type="button" class="icon-btn" aria-label="更多" title="更多" data-action="more">${icon("ellipsis")}</button>
              </div>
            </div>
          </header>

          <div class="conv__body">
            <div class="conv__scroll" data-scroll>
              <div class="chat-scroll">
                <div class="chat-col" data-chat-col>
                  <div class="user-row">
                    <div class="user-stack">
                      <div class="bubble">创建一个 design 文件夹，先做一个 DSH 模拟，可以通过 dsh web 看。因为这个是一个 dsh 插件，所以要先模拟一下 DSH 的简单环境外观作为框架</div>
                    </div>
                  </div>

                  <div class="assistant">
                    <p>明白，先把外壳做对。DSH 的 Web GUI 不是自造布局，它是三栏 AppFrame：左栏侧边栏、中栏会话页、右栏贴着会话的停靠面板。</p>

                    <div class="tool-row">
                      <button type="button" class="tool-row__head" aria-expanded="false" data-action="toggle-tool">
                        <span class="tool-row__icon">${icon("folder-open", "ico ico--14")}</span>
                        <span class="tool-row__name">Read</span>
                        <span class="tool-row__sep"></span>
                        <span class="tool-row__summary">dsh-web-frontend/dist/assets/index-BNyAYEM7.css</span>
                        ${icon("chevron-down", "ico ico--14 tool-row__chevron")}
                      </button>
                      <div class="tool-row__body" hidden>
                        <div class="tool-row__line"><span>77,469 B</span><span>·</span><span>CSS Module 产物</span></div>
                        <div class="tool-row__line"><span>AppFrame 三栏 / 侧边栏 / 会话页头部 / 输入卡片 全部从这里取</span></div>
                      </div>
                    </div>

                    <p>官方几何逐条对上了：侧边栏展开 280px、折叠 56px 轨道；品牌行 60px；新建会话 38px、12px 圆角、0.5px 描边；全局面板行 36px、行距 2px。</p>

                    <h3>颜色不是挑的，是取出来的</h3>
                    <ul>
                      <li>侧栏底色 <code>#f9fafb</code></li>
                      <li>面板行选中 <code>#ebeef2</code></li>
                      <li>用户气泡 <code>#edf3fe</code>，20px 圆角</li>
                      <li>输入卡片 28px 圆角 + 柔和投影</li>
                    </ul>
                  </div>

                  <div class="running" data-running>
                    <span class="running__content">
                      <span class="running__icon">${FISH(14)}</span>
                      <span class="running__text">正在拆解外壳几何…</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div class="composer-seat">
              <div class="composer">
                <div class="composer__card">
                  <div class="composer__scroll">
                    <div
                      class="composer__input"
                      contenteditable="true"
                      role="textbox"
                      aria-multiline="true"
                      aria-label="给 DeepSeek Harness 发送消息"
                      data-empty
                      data-placeholder="给 DeepSeek Harness 发送消息"
                      data-composer
                    ></div>
                  </div>
                  <div class="composer__row">
                    <div class="composer__tools">
                      <button type="button" class="composer__add" aria-label="添加附件" title="添加附件" data-action="attach">${icon("plus", "ico ico--14")}</button>
                      <button type="button" class="composer__select" title="权限预设" data-action="permission">完全访问</button>
                    </div>
                    <div class="composer__trailing">
                      <button type="button" class="composer__send" aria-label="发送" title="发送（Enter）" data-action="send" disabled>
                        ${icon("send", "ico ico--18")}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="composer__hint">DeepSeek Harness 可能会出错，请核对重要信息。</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 上下文压缩面板
 * ════════════════════════════════════════════════════════════════════ */
const FOLDS = [
  {
    at: "2026-11-08 00:41",
    seq: "132–188",
    trigger: "自动触发",
    chars: "1,284",
    usage: "遮蔽 18,402 tok · 输出 1,105 tok",
    done: "补折 0 条 · 失败边 6 条",
    excerpt:
      "根目标：把 DSH Web 外壳按官方几何复刻，再在里面放上下文压缩面板。\n约束：不改热清单文本 / 不改 graph.json 字节 / 间距只走 4·8·12·16。\n成功路径：app.asar → 官方 CSS → 令牌 → 组件 → 四屏。\n失败边：7z 解 asar 失败（electron 私有头）；401 抓不到 live DOM。"
  },
  {
    at: "2026-11-07 23:12",
    seq: "96–131",
    trigger: "阈值触发",
    chars: "968",
    usage: "遮蔽 12,880 tok · 输出 842 tok",
    done: "补折 1 条 · 失败边 4 条",
    excerpt:
      "根目标：统一间距尺度到 4 档。\n成功路径：SPACING 常量化 → 扫 styles 里所有 gap。\n失败边：18/20/26 三处各自为政，被测试用例拦住。"
  },
  {
    at: "2026-11-07 21:35",
    seq: "58–95",
    trigger: "手动 /compact",
    chars: "742",
    usage: "遮蔽 7,214 tok · 输出 655 tok",
    done: "补折 0 条 · 失败边 3 条",
    excerpt:
      "根目标：把配置项的单一来源收敛到 config-schema。\n成功路径：SCHEMA 23 键 / PRESET_KEYS 16 / BASE_KEYS 11。\n失败边：lib/client.js 的 FIELDS 15 键仍是硬编码，待 R12。"
  },
  {
    at: "2026-11-07 19:02",
    seq: "12–57",
    trigger: "首折",
    chars: "531",
    usage: "遮蔽 2,712 tok · 输出 470 tok",
    done: "补折 0 条 · 失败边 2 条",
    excerpt:
      "根目标：面板信息架构定为 总览 / 折痕 / 配置 三枚互斥 tab。\n成功路径：复用官方自动化任务页的 filter chip。\n失败边：折叠条方案被否（宽屏空、窄屏挤）。"
  }
];

function foldRows(compact) {
  return FOLDS.map(
    (f, i) => `
              <div class="gk-fold"${compact ? ' data-compact="true"' : ""} data-fold="${i}">
                <button type="button" class="gk-fold__head" aria-expanded="false" data-action="toggle-fold">
                  <span class="gk-code">${f.at}</span>
                  <span class="gk-code">seq ${f.seq}</span>
                  ${compact ? `<span class="gk-hint">摘要 ${f.chars} 字符</span>` : `<span class="gk-fold__trigger">${f.trigger}</span>`}
                  ${icon("chevron-down", "ico ico--14 gk-fold__chevron")}
                </button>
                <div class="gk-fold__detail" hidden>
                  <div class="gk-hint">摘要 ${f.chars} 字符 · ${f.usage}</div>
                  <div class="gk-hint">${f.done}</div>
                  <pre class="gk-fold__excerpt">${f.excerpt}</pre>
                </div>
              </div>`
  ).join("");
}

/* 配置项：key 与 src/rooms/config-schema.mjs 对齐；def 是默认值 */
const FIELD_ROWS = [
  { key: "auto", label: "自动压缩", hint: "关掉后只在手动 /compact 时压", kind: "boolean", value: "true" },
  {
    key: "thresholdRatio",
    label: "压缩阈值（固定档位）",
    hint: "只能选 45% / 50% / 65% / 75% / 85%；45% 是现默认值",
    kind: "enum",
    value: "45%",
    options: ["45%", "50%", "65%", "75%", "85%"]
  },
  { key: "growthFloorTokens", label: "增长闸（tokens）", hint: "距上次 fold 至少新增这么多才再压", kind: "number", value: "20000" },
  { key: "retainRatio", label: "逐字保留尾部", hint: "近期内容不压，按窗口比例", kind: "number", value: "0.2" }
];

const ADVANCED_ROWS = [
  { key: "minFoldTokens", label: "最小 fold 量（tokens）", hint: "被遮蔽内容少于该值不压", kind: "number", value: "8000" },
  { key: "autoBackfill", label: "自动补账", hint: "后台每 30 分钟自动补一个归档会话的尾巴", kind: "boolean", value: "true" },
  {
    key: "summaryMode",
    label: "摘要方式",
    hint: "hybrid=规则事实+模型润色；rules=零模型调用；llm=全模型",
    kind: "enum",
    value: "hybrid",
    options: ["hybrid", "rules", "llm"]
  },
  { key: "maxTokens", label: "摘要输出上限（tokens）", hint: "太贴边会 MAX_TOKENS 截断", kind: "number", value: "8192" },
  { key: "hotLedgerMaxTokens", label: "热清单预算（tokens）", hint: "清单自身的 token 上限", kind: "number", value: "1200" },
  {
    key: "hotLedgerMarkers",
    label: "清单标记档位",
    hint: "semantic=带语义+图例；terse=只三态；off=不打标记",
    kind: "enum",
    value: "semantic",
    options: ["semantic", "terse", "off"]
  },
  { key: "transposition", label: "置换检测", hint: "回到走过的状态时只加边不建节点", kind: "boolean", value: "true" },
  { key: "tier2After", label: "checkpoint 合并阈值", hint: "checkpoint 超过该值时合并最老的两段", kind: "number", value: "8" },
  { key: "closeoutFold", label: "归档收尾折叠", hint: "会话被归档时补一次折叠（尾巴太短则不折叠）", kind: "boolean", value: "true" }
];

function fieldRow(f) {
  let control;
  if (f.kind === "boolean") {
    control = `<span class="gk-switch" role="switch" aria-checked="${f.value}" tabindex="0" aria-label="${f.label}" data-action="toggle-switch"><span class="gk-switch__thumb"></span></span>`;
  } else if (f.kind === "enum") {
    const items = f.options
      .map(
        (o) =>
          `<button type="button" class="gk-pop__item" role="option" aria-selected="${o === f.value}" data-value="${o}">${o}${
            o === f.value ? icon("check", "ico ico--14 gk-pop__check") : ""
          }</button>`
      )
      .join("");
    control = `<div class="gk-picker" data-action="open-picker" data-value="${f.value}">
                  <button type="button" class="gk-select" aria-haspopup="listbox" aria-expanded="false">
                    <span class="gk-select__value">${f.value}</span>
                    ${icon("chevron-down", "ico ico--14")}
                  </button>
                  <div class="gk-pop" role="listbox" aria-label="${f.label}" hidden>${items}</div>
                </div>`;
  } else {
    control = `<input class="gk-input" type="text" inputmode="decimal" value="${f.value}" aria-label="${f.label}" />`;
  }
  return `            <div class="gk-field" data-field="${f.key}" data-kind="${f.kind}" data-default="${f.value}" data-dirty="false">
                <div class="gk-field__text">
                  <span class="gk-field__label">${f.label}</span>
                  <div class="gk-field__hint">${f.hint}</div>
                </div>
                <div class="gk-field__control">${control}</div>
              </div>`;
}

function gokifu(tab) {
  const tabs = [
    ["overview", "总览", "gokifu-overview.html"],
    ["folds", "折痕", "gokifu-folds.html"],
    ["config", "配置", "gokifu-config.html"]
  ]
    .map(
      ([id, label, href]) =>
        `<a class="gk-tab"${tab === id ? " data-active" : ""} role="tab" aria-selected="${tab === id}" href="${href}">${label}</a>`
    )
    .join("");

  const header = `          <div class="gk-header">
            <div class="gk-header__text">
              <h1 class="gk-h1">上下文压缩</h1>
              <p class="gk-sub">棋谱式增量 fold · 热清单每步重建 · 失败记忆逐字保留</p>
            </div>
            <div class="gk-header__meta">
              <span class="gk-field__hint">profile</span>
              <span class="gk-code">desktop</span>
            </div>
          </div>`;

  let body;
  if (tab === "folds") {
    body = `          <div class="gk-panel" role="region" aria-label="折痕">
            <section class="gk-card">
              <div class="gk-card__title">折痕列表（最近 ${FOLDS.length} 条）</div>${foldRows(false)}
            </section>
          </div>`;
  } else if (tab === "config") {
    body = `          <div class="gk-panel" role="region" aria-label="配置">
            <div class="gk-banner" data-config-banner hidden>
              <span data-config-banner-text>未保存：—</span>
            </div>

            <section class="gk-card">
              <div class="gk-card__title">常用配置（4 个控件）</div>
${FIELD_ROWS.map(fieldRow).join("\n")}
            </section>

            <div class="gk-warning">以下参数影响折叠时机与成本，改错会导致摘要截断、缓存失效或重复扣费</div>

            <section class="gk-card">
              <div class="gk-card__title">高级参数（${ADVANCED_ROWS.length} 项）</div>
${ADVANCED_ROWS.map(fieldRow).join("\n")}
            </section>

            <div class="gk-actions" data-config-actions>
              <button type="button" class="gk-btn gk-btn--primary" data-action="save-config" disabled>保存</button>
              <button type="button" class="gk-btn" data-action="reset-config">恢复默认</button>
              <button type="button" class="gk-btn" data-action="reload-config">刷新</button>
              <span class="gk-field__hint" data-config-dirty>没有改动</span>
            </div>
          </div>`;
  } else {
    body = `          <div class="gk-panel" role="region" aria-label="总览">
            <div class="gk-cols">
              <section class="gk-card">
                <div class="gk-card__head">
                  <div class="gk-card__title">压缩状态</div>
                  <span class="gk-pill gk-pill--ok">正常</span>
                </div>
                <div class="gk-simple">上次折叠 27 分钟前 · 当前窗口占用 62%</div>
                <div class="gk-bar" role="img" aria-label="窗口占用 62%"><span class="gk-bar__fill" style="--ratio: 0.62"></span></div>
              </section>

              <section class="gk-card">
                <div class="gk-card__title">今日投入产出</div>
                <div class="gk-simple">今日折叠 4 次 · 合计遮蔽 41,208 tok · 今日成本（估算） $0.83</div>
                <div class="gk-metrics">
                  <div class="gk-metric"><span class="gk-metric__label">折叠</span><span class="gk-metric__value">4 次</span></div>
                  <div class="gk-metric"><span class="gk-metric__label">遮蔽</span><span class="gk-metric__value">41,208</span></div>
                  <div class="gk-metric"><span class="gk-metric__label">成本</span><span class="gk-metric__value">$0.83</span></div>
                </div>
              </section>
            </div>

            <div class="gk-cols">
              <section class="gk-card">
                <div class="gk-card__title">最近折痕（最近 ${FOLDS.length} 条）</div>${foldRows(true)}
              </section>

              <div class="gk-stack">
                <section class="gk-card">
                  <div class="gk-card__title">健康检查</div>
                  <div class="gk-simple">已安装 是 · 已接管 是 · 单实例 是</div>
                </section>

                <section class="gk-card">
                  <div class="gk-card__title">补折（点一下派一个子代理）</div>
                  <div class="gk-actions gk-actions--tight">
                    <button type="button" class="gk-select gk-select--wide" data-action="backfill-provider"><span>跟随当前路由</span>${icon("chevron-down", "ico ico--14")}</button>
                    <button type="button" class="gk-select gk-select--wide" data-action="backfill-model"><span>跟随 provider / 当前路由</span>${icon("chevron-down", "ico ico--14")}</button>
                    <button type="button" class="gk-btn gk-btn--primary" data-action="backfill-run">开始补折</button>
                  </div>
                </section>

                <section class="gk-card">
                  <div class="gk-simple">最近活跃会话：dsh-gokifu-compact/上下文压缩 · 面板设计</div>
                </section>

                <section class="gk-card">
                  <div class="gk-simple">
                    <span data-update-text>检查更新：已是最新（1.11.0）</span>
                    <button type="button" class="gk-btn" data-action="check-update">重新检查</button>
                  </div>
                </section>
              </div>
            </div>
          </div>`;
  }

  return `      <div class="center-col">
        <div class="gk-page">
${header}
          <div class="gk-tabs" role="tablist" aria-label="上下文压缩视图">${tabs}</div>
${body}
        </div>
      </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 页面骨架
 * ════════════════════════════════════════════════════════════════════ */
function page({ title, active, main, page: pageId }) {
  return `<!doctype html>
<html lang="zh-CN" data-platform="win32" data-windows-titlebar data-page="${pageId}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="css/tokens.css" />
    <link rel="stylesheet" href="css/shell.css" />
    <link rel="stylesheet" href="css/gokifu.css" />
    <script src="js/app.js" defer></script>
  </head>
  <body>
    ${sprite}

    <div class="app-frame">
${sidebar(active)}
${main}
    </div>

    <div class="toast-layer" role="status" aria-live="polite" data-toast-layer></div>
  </body>
</html>
`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 输出
 * ════════════════════════════════════════════════════════════════════ */
const jobs = [
  { file: "dsh-shell.html", html: page({ page: "shell", title: "DeepSeek Harness", active: null, main: conversation() }) },
  {
    file: "gokifu-overview.html",
    html: page({ page: "overview", title: "上下文压缩 · 总览", active: "compact", main: gokifu("overview") })
  },
  {
    file: "gokifu-folds.html",
    html: page({ page: "folds", title: "上下文压缩 · 折痕", active: "compact", main: gokifu("folds") })
  },
  {
    file: "gokifu-config.html",
    html: page({ page: "config", title: "上下文压缩 · 配置", active: "compact", main: gokifu("config") })
  }
];

for (const j of jobs) {
  fs.writeFileSync(path.join(ROOT, j.file), j.html, "utf8");
  console.log("built " + j.file + " (" + Buffer.byteLength(j.html) + " B)");
}
