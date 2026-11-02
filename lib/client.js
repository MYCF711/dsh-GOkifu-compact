/**
 * client.js —— 「上下文压缩」详情页的浏览器半（客户端插件）
 *
 * 形态与官方 `@deepseek-ai/dsh-client-ui-*` 完全一致：一个 `window.__ModuleLoader__.load`
 * 工厂，导出 cordis 客户端插件（name/inject/apply）。注册两个槽位：
 *
 *   sidebar.panellist  → 左侧「插件 / 自动化任务」那一列下面的一条（图标 + 标签）
 *   main               → 点开后的整页（key 与 panellist 的 id 相同）
 *
 * 数据全部走 host 半注册的 `/gokifu/api`（见 src/ui.mjs），不依赖 Typert 的构建期生成物。
 * 只 require("react")：页面用原生元素 + 内联样式，不依赖 primitives 的具体 props 契约。
 *
 * ★ U2（2026-11-01，主人拍板「继续做 UI」）：
 *   ① 宽屏双栏：视口 ≥1280px 用 grid 两栏（左=配置表单/保存按钮，右=指标卡/运行状态），
 *      <1280px 回单栏且保持原来的纵向信息顺序；根容器 maxWidth 1600 + 居中。
 *   ② 滚动容器（P0 真实 bug）：宿主把页面塞进 `overflow:hidden` 的居中列，本页以前既没 height
 *      也没 overflow ⇒ 内容超高但滚不动（滚轮/滚动条全废）。现在根容器 height:100% + minHeight:0
 *      + boxSizing:border-box + overflowY:auto（双栏时也是**整页**滚动，两栏各自不滚）。
 *   ③ 焦点环：宿主 `data-input-modality=pointer` 下没有可见焦点。React inline style 不支持
 *      `:focus-visible` ⇒ 所有可交互元素统一经 `focusable()` 渲染，onFocus/onBlur 切 outline。
 *   ④ 摘要模型两级下拉：host 的 `state.models` = `{providers:[{provider,name,models:[{id,name,contextWindow}]}]}`；
 *      provider / model 两个键从自由文本改成 <select>（model 用 <optgroup> 按 provider 分组）；
 *      **目录为空/字段缺失时自动降级回自由文本**（否则新环境里根本配不了）。
 *   ⑤ 去掉假的 100 万窗口：进度条按选中模型的 contextWindow 算；拿不到 ⇒ 显示「—」并隐藏进度条。
 *
 * 测试策略（见 test/ui-layout.test.mjs）：本文件是 classic script（不是 ESM），
 * 布局/窗口来源/选项分组等**纯函数**通过 `exports.__testables` 暴露，测试用 `new Function("window", src)`
 * 加载后直接断言 —— 不渲染 React、不需要 DOM。
 */

window.__ModuleLoader__.load({
  id: "dsh-gokifu-compact",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const PANEL_ID = "gokifu-compact";
    const API = "/gokifu/api";

    /* ───────────────────────── 纯逻辑（可测，无 DOM 依赖） ───────────────────────── */

    /** 双栏断点（主人拍板）：视口 ≥1280px 双栏，否则单栏。 */
    const TWO_COLUMN_MIN_WIDTH = 1280;
    /** matchMedia 查询串（与断点同源，避免两处写死不同步）。 */
    const VIEWPORT_QUERY = `(min-width: ${TWO_COLUMN_MIN_WIDTH}px)`;

    /**
     * ★ U4 ④ 间距尺度：全站只有 4 / 8 / 12 / 16 四档（4px 网格）。
     * 为什么收敛：U2 时根容器 18、两栏 20、卡片内 8 是「几个数各自为政」，分区感不成体系，
     * 细看会觉得上/下/内三层的节奏对不上。现在：
     *   · 16 = 页面/分区级（根容器、两栏之间、两栏内部卡片之间）—— 原来 18/20 统一到 16；
     *   · 8  = 卡片内部行距（参数行、卡片内元素）；
     *   · 12 = 一行内的控件间距（按钮组、指标横排）；
     *   · 4  = 紧贴标题/说明的微间距（h1 与副标题、指标 label 与值）。
     * 测试会扫 styles 里所有 gap 值，只许落在这四档里（防以后又偷偷加 18/20/26 回来）。
     */
    const SPACING = Object.freeze({ section: 16, card: 8, inline: 12, micro: 4 });

    /**
     * ★ U4 ① 字段行窄屏断点：<600px 时「label + 220px 控件 + 120px 默认值」放不下
     * （600 - 左右 padding 56 = 544px 内容宽，再扣 220+120 只剩 ~200px 给中文 label，会折成多行）。
     * 600 也正好是常见移动端横屏/窄窗的分界，取它比 560/640 更直观。
     */
    const FIELD_STACK_BELOW_WIDTH = 600;

    /**
     * ★ U4 ① 字段行布局（纯函数，边界可测）：
     *   >=600px ⇒ 三列 [label | 控件 | 默认值]；
     *   <600px  ⇒ 单列两行（label 在上、控件在下，默认值变成第三行小字）。
     * 拿不到视口宽度（undefined/NaN）时按窄屏处理 —— 宁可两行也别把控件挤扁。
     * @param {number} viewportWidth
     * @returns {{stacked:boolean, style:object}}
     */
    function fieldGridFor(viewportWidth) {
      const usable = typeof viewportWidth === "number" && Number.isFinite(viewportWidth);
      const stacked = !(usable && viewportWidth >= FIELD_STACK_BELOW_WIDTH);
      const base = {
        display: "grid",
        minWidth: 0,
        padding: stacked ? "8px 0" : "6px 0",
        borderBottom: "1px solid rgba(127,127,127,0.12)",
      };
      return stacked
        ? { stacked: true, style: { ...base, gridTemplateColumns: "minmax(0, 1fr)", gap: SPACING.micro, alignItems: "start" } }
        : { stacked: false, style: { ...base, gridTemplateColumns: "1fr 220px 120px", gap: SPACING.card, alignItems: "center" } };
    }

    /**
     * 布局决策（纯函数，1279/1280 边界可测）。
     * @param {number} viewportWidth
     * @returns {"two-col"|"single-col"}
     */
    function layoutFor(viewportWidth) {
      return typeof viewportWidth === "number" && Number.isFinite(viewportWidth) && viewportWidth >= TWO_COLUMN_MIN_WIDTH ? "two-col" : "single-col";
    }

    /** 焦点环样式（inline style 没有 :focus-visible）。 */
    const FOCUS_OUTLINE = "2px solid #4c8dff";
    const FOCUS_OUTLINE_OFFSET = "2px";

    /**
     * 焦点环事件（onFocus/onBlur 直接切 DOM style）。
     * 为什么不用 React state：每个输入各自一份 focused 状态会让 Field/按钮都多一层组件、
     * 而且失焦还原要考虑竞态；这里只改当前元素的内联 style，行为等价且不会丢。
     */
    function focusRing() {
      return {
        onFocus: (event) => {
          const el = event?.currentTarget;
          if (!el || !el.style) return;
          el.style.outline = FOCUS_OUTLINE;
          el.style.outlineOffset = FOCUS_OUTLINE_OFFSET;
        },
        onBlur: (event) => {
          const el = event?.currentTarget;
          if (!el || !el.style) return;
          el.style.outline = "none";
          el.style.outlineOffset = "";
        },
      };
    }

    /**
     * 统一渲染**可交互**原生控件并挂上焦点环（input / select / textarea / button 全部走这里，
     * 保证没有漏网的控件；测试会静态断言页面里不存在裸写的 input/select/button 元素）。
     */
    function focusable(tag, props, ...children) {
      return h(tag, { ...focusRing(), ...(props ?? {}) }, ...children);
    }

    /**
     * 规整宿主模型目录（U1 契约）：
     * `{providers:[{provider,name,models:[{id,name,contextWindow}]}]}` →
     * `[{provider, label, models:[{value,label,contextWindow}]}]`。
     * 语义：provider 必须有不空的 id；模型必须有不空的 id；**label 优先 name、缺了回退 id**；
     * contextWindow 只认正数，其余一律 null（不猜、不伪造）。
     * @param {any} models
     */
    function normalizeModelCatalog(models) {
      const providers = models && Array.isArray(models.providers) ? models.providers : [];
      const out = [];
      for (const provider of providers) {
        if (!provider || typeof provider.provider !== "string" || provider.provider === "") continue;
        const providerLabel = typeof provider.name === "string" && provider.name !== "" ? provider.name : provider.provider;
        const items = [];
        for (const model of Array.isArray(provider.models) ? provider.models : []) {
          if (!model || typeof model.id !== "string" || model.id === "") continue;
          const label = typeof model.name === "string" && model.name !== "" ? model.name : model.id;
          const contextWindow = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
          items.push({ value: model.id, label, contextWindow });
        }
        out.push({ provider: provider.provider, label: providerLabel, models: items });
      }
      return out;
    }

    /**
     * 模型目录是否可用于两级下拉（为空 ⇒ 降级自由文本输入）。
     * @param {any} models
     * @returns {boolean}
     */
    function modelsAvailable(models) {
      return normalizeModelCatalog(models).length > 0;
    }

    /**
     * 两级下拉的分组数据（供 <optgroup>）：`[{provider, label, models:[{value,label,contextWindow}]}]`。
     * @param {any} models
     */
    function modelGroups(models) {
      return normalizeModelCatalog(models);
    }

    /**
     * ⑤ 进度条分母的真实来源（不再写死 1000000）：
     *   ① 当前选中的 provider+model 命中且有 contextWindow ⇒ 用它；
     *   ② 否则取模型目录里**第一个**有 contextWindow 的模型；
     *   ③ 都拿不到 ⇒ null（调用方显示「—」并隐藏进度条，绝不除以假数）。
     * @param {any} models
     * @param {string} provider
     * @param {string} model
     * @returns {number|null}
     */
    function resolveWindowTokens(models, provider, model) {
      const groups = normalizeModelCatalog(models);
      const pickedProvider = groups.find((group) => group.provider === provider);
      const picked = pickedProvider ? pickedProvider.models.find((item) => item.value === model) : null;
      if (picked && picked.contextWindow !== null) return picked.contextWindow;
      for (const group of groups) {
        for (const item of group.models) {
          if (item.contextWindow !== null) return item.contextWindow;
        }
      }
      return null;
    }

    /**
     * ★ U4 ② 长模型名截断的兜底：provider 下拉的悬停 title（完整显示名；缺了回退 id）。
     * @returns {string} 未命中/未选 ⇒ ""（调用方回退到原始值/占位文案）
     */
    function describeProviderSelection(models, provider) {
      const group = normalizeModelCatalog(models).find((item) => item.provider === provider);
      return group ? group.label : "";
    }

    /**
     * ★ U4 ② 同上：model 下拉的悬停 title（name + 窗口，完整显示全名）。
     * @returns {string} 未命中 ⇒ ""
     */
    function describeModelSelection(models, provider, model) {
      const group = normalizeModelCatalog(models).find((item) => item.provider === provider);
      // ⚠ find 没命中返回 undefined（不是 null）：这里必须归一，否则「preset 里存着已下架的模型」
      // 会让 title 计算直接抛错（整页白屏）。U4 自测时真踩到过。
      const item = group ? group.models.find((entry) => entry.value === model) ?? null : null;
      if (item === null) return "";
      return item.contextWindow === null ? item.label : `${item.label}（${fmt(item.contextWindow)} tok）`;
    }

    /**
     * ★ U4 ③ 标题行的当前 profile：只读 host 已经给的字段（health.profile 优先，其次 state.profile），
     * 都不给就 "—"。**不新增 host 接口**。
     * @returns {string}
     */
    function profileLabel(state, health) {
      const name = health?.profile ?? state?.profile;
      return typeof name === "string" && name !== "" ? name : "—";
    }

    /* ───────────────────── 版本检查（U5）：host 的结果 → 展示文本（纯函数，可测） ───────────────────── */

    /**
     * 「检查更新」的状态文案。
     * host 的契约：`{ current, latest, publishedAt, hasUpdate, command, error, cachedAt }`，
     * **检查失败是正常返回值**（`ok:true` + `error`），不是异常 —— 这里只把它翻成一句人话。
     * @param {any} update
     * @returns {"未检查"|"检查失败"|"未知"|"有新版本"|"已是最新"}
     */
    function updateStatusText(update) {
      if (update === null || update === undefined) return "未检查";
      if (typeof update.error === "string" && update.error !== "") return "检查失败";
      if (typeof update.latest !== "string" || update.latest === "") return "未知";
      return update.hasUpdate === true ? "有新版本" : "已是最新";
    }

    /**
     * 顶部横幅的整句文案；不满足条件给空串（调用方据此决定渲不渲染横幅）。
     * 只陈述事实（哪一版、当前哪一版），不含任何行动指导。
     * @param {any} update
     * @returns {string}
     */
    function updateBannerText(update) {
      if (update === null || update === undefined || update.hasUpdate !== true) return "";
      const latest = typeof update.latest === "string" && update.latest !== "" ? update.latest : "?";
      const current = typeof update.current === "string" && update.current !== "" ? update.current : "?";
      return `有新版本 ${latest}（当前 ${current}）`;
    }

    /** 升级命令（profile 与版本都由 host 拼好）；拿不到 ⇒ 空串（按钮不出现）。 */
    function updateCommandText(update) {
      return typeof update?.command === "string" ? update.command : "";
    }

    /** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；没有/非法 ⇒ ""（页面显示 —）。 */
    function formatTimestamp(iso) {
      if (typeof iso !== "string" || iso === "") return "";
      const at = Date.parse(iso);
      if (Number.isNaN(at)) return "";
      const date = new Date(at);
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /* ───────────────────────── 网络 ───────────────────────── */

    async function callApi(action, extra) {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(extra ?? {}) }),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`host 返回了非 JSON（${res.status}）：${text.slice(0, 120)}`);
      }
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json;
    }

    /**
     * ★ U5「检查更新」专用请求（**故意不复用 callApi**）：
     * 检查失败对 host 是**正常返回** —— `{ ok:true, latest:null, hasUpdate:false, error:"…" }`；
     * 而 callApi 见到 `error` 就抛，那样面板只剩一行红字，
     * 「当前版本 / 最新版本 / 上次检查时间」全都没了。所以这里只认 HTTP 状态。
     */
    async function requestUpdate(refresh) {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update", refresh: refresh === true }),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`host 返回了非 JSON（${res.status}）：${text.slice(0, 120)}`);
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json;
    }

    /* ───────────────────────── 小工具 ───────────────────────── */

    const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "—");
    const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : "—");

    /* ───────────────────────── 样式 ───────────────────────── */

    /**
     * 根容器（★ U2 ②）：宿主把 main 槽位塞进 `overflow:hidden` 的居中列，
     * 没有 height/minHeight:0/overflow 时内容超高但**滚不动**（P0）。
     * 所以这里必须是「整页滚动容器」：height:100% + minHeight:0 + boxSizing:border-box + overflowY:auto。
     * maxWidth 1600 + margin auto：宽屏不再挤在 980px 左对齐。
     */
    const PAGE_STYLE = {
      padding: "24px 28px",
      display: "flex",
      flexDirection: "column",
      gap: SPACING.section,
      width: "100%",
      maxWidth: "1600px",
      margin: "0 auto",
      height: "100%",
      minHeight: 0,
      boxSizing: "border-box",
      overflowY: "auto",
      overflowX: "hidden",
      color: "inherit",
    };

    /** ★ U2 ① 两栏 grid（双栏时**整页**滚动，两栏不各自加 overflow）。 */
    const COLUMNS_STYLE = {
      display: "grid",
      gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
      gap: SPACING.section,
      alignItems: "start",
    };
    const COLUMN_STYLE = { display: "flex", flexDirection: "column", gap: SPACING.section, minWidth: 0 };
    /** 左栏 = 配置表单 + 保存/重置（DOM 顺序按单栏优先级排在指标之后，双栏时用 grid 位置换到左边）。 */
    const COLUMN_LEFT_STYLE = { ...COLUMN_STYLE, gridColumn: "1", gridRow: "1" };
    /** 右栏 = 指标卡 + 运行状态。 */
    const COLUMN_RIGHT_STYLE = { ...COLUMN_STYLE, gridColumn: "2", gridRow: "1" };

    const styles = {
      page: PAGE_STYLE,
      columns: COLUMNS_STYLE,
      columnLeft: COLUMN_LEFT_STYLE,
      columnRight: COLUMN_RIGHT_STYLE,
      // ★ U4 ④：标题行改成左右两段（左：标题+副标题；右：profile），宽屏右上方不再是空的。
      header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: SPACING.section, flexWrap: "wrap" },
      headerText: { display: "flex", flexDirection: "column", gap: SPACING.micro, minWidth: 0 },
      headerMeta: { display: "flex", alignItems: "baseline", gap: SPACING.card, flexShrink: 0 },
      h1: { fontSize: "20px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: SPACING.card },
      sub: { fontSize: "12px", opacity: 0.65, margin: 0 },
      card: { border: "1px solid rgba(127,127,127,0.25)", borderRadius: "10px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: SPACING.card },
      cardTitle: { fontSize: "12px", letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.55 },
      row: { display: "flex", flexWrap: "wrap", gap: SPACING.inline },
      actions: { display: "flex", gap: SPACING.inline, alignItems: "center", flexWrap: "wrap" },
      metric: { display: "flex", flexDirection: "column", gap: SPACING.micro, minWidth: "130px" },
      metricLabel: { fontSize: "11px", opacity: 0.55 },
      metricValue: { fontSize: "17px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
      bar: { height: "6px", borderRadius: "3px", background: "rgba(127,127,127,0.2)", overflow: "hidden", width: "100%" },
      barFill: (ratio) => ({ height: "100%", width: `${Math.min(100, Math.max(0, ratio * 100))}%`, background: ratio > 0.9 ? "#e5484d" : ratio > 0.6 ? "#f5a524" : "#3ba55d" }),
      // 字段行样式由 fieldGridFor(viewportWidth) 生成（U4 ①），这里不再保留固定三列。
      fieldLabel: { fontSize: "13px" },
      fieldHint: { fontSize: "11px", opacity: 0.55 },
      modelsNotice: { display: "flex", alignItems: "center", gap: SPACING.card, flexWrap: "wrap", padding: "2px 0" },
      input: { width: "100%", padding: "5px 8px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.08)", color: "inherit", fontSize: "13px", outline: "none" },
      checkbox: { width: "16px", height: "16px", cursor: "pointer", outline: "none" },
      btn: { padding: "7px 14px", borderRadius: "7px", border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.1)", color: "inherit", fontSize: "13px", cursor: "pointer", outline: "none" },
      btnPrimary: { padding: "7px 16px", borderRadius: "7px", border: "1px solid #3b82f6", background: "#2563eb", color: "#fff", fontSize: "13px", cursor: "pointer", fontWeight: 600, outline: "none" },
      pill: (ok) => ({ fontSize: "11px", padding: "2px 8px", borderRadius: "999px", border: `1px solid ${ok ? "#3ba55d" : "#e5484d"}`, color: ok ? "#3ba55d" : "#e5484d" }),
      note: { fontSize: "12px", padding: "8px 12px", borderRadius: "8px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.4)" },
      error: { fontSize: "12px", padding: "8px 12px", borderRadius: "8px", background: "rgba(229,72,77,0.12)", border: "1px solid rgba(229,72,77,0.45)" },
      code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", opacity: 0.7, wordBreak: "break-all" },
      // ★ U5「检查更新」：顶部横幅（有新版本时）与可复制的命令块。间距仍只走 4/8/12/16 四档。
      banner: { display: "flex", flexDirection: "column", gap: SPACING.card, padding: "10px 14px", borderRadius: "10px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.45)" },
      bannerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACING.inline, flexWrap: "wrap" },
      bannerLabel: { fontSize: "13px", fontWeight: 600 },
      codeBlock: { display: "flex", flexDirection: "column", gap: SPACING.card, padding: "8px 10px", borderRadius: "8px", background: "rgba(127,127,127,0.12)", border: "1px solid rgba(127,127,127,0.3)" },
      // userSelect:"all"：剪贴板 API 被禁（非 https / 无权限）时，点一下就能整段选中手动复制。
      codeText: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", wordBreak: "break-all", userSelect: "all", lineHeight: 1.5 },
    };

    /* ───────────────────────── 字段定义 ───────────────────────── */

    const FIELDS = [
      { key: "auto", label: "自动压缩", hint: "关掉后只在手动 /compact 时压", kind: "boolean" },
      { key: "thresholdRatio", label: "触发阈值（占窗口）", hint: "min(窗口×该值, 窗口−输出预留−余量)", kind: "number", step: 0.01, min: 0.05, max: 0.95 },
      { key: "growthFloorTokens", label: "增长闸（tokens）", hint: "距上次 fold 至少新增这么多才再压", kind: "number", step: 1000, min: 0, max: 1000000 },
      { key: "retainRatio", label: "逐字保留尾部", hint: "近期内容不压，按窗口比例", kind: "number", step: 0.01, min: 0, max: 0.9 },
      { key: "minFoldTokens", label: "最小 fold 量（tokens）", hint: "被遮蔽内容少于该值不压", kind: "number", step: 1000, min: 0, max: 1000000 },
      { key: "summaryMode", label: "摘要方式", hint: "hybrid=规则事实+模型润色；rules=零模型调用；llm=全模型", kind: "enum", options: ["hybrid", "rules", "llm"] },
      { key: "maxTokens", label: "摘要输出上限（tokens）", hint: "太贴边会 MAX_TOKENS 截断", kind: "number", step: 256, min: 256, max: 65536 },
      { key: "hotLedger", label: "热清单", hint: "每步注入失败边清单", kind: "boolean" },
      { key: "hotLedgerMaxTokens", label: "热清单预算（tokens）", hint: "清单自身的 token 上限", kind: "number", step: 50, min: 0, max: 20000 },
      { key: "hotLedgerMarkers", label: "清单标记档位", hint: "semantic=带语义+图例；terse=只三态；off=不打标记", kind: "enum", options: ["semantic", "terse", "off"] },
      { key: "hotLedgerReplace", label: "就地替换旧清单", hint: "surface 上永远只有一条", kind: "boolean" },
      { key: "transposition", label: "置换检测", hint: "回到走过的状态时只加边不建节点", kind: "boolean" },
      { key: "tier2After", label: "checkpoint 合并阈值", hint: "checkpoint 超过该值时合并最老的两段", kind: "number", step: 1, min: 0, max: 100 },
      { key: "summarizationProvider", label: "摘要 provider", hint: "留空 = 跟随当前路由", kind: "text" },
      { key: "summarizationModel", label: "摘要 model", hint: "留空 = 跟随当前路由", kind: "text" },
    ];

    /* ───────────────────────── 组件 ───────────────────────── */

    function Metric(props) {
      return h("div", { style: styles.metric },
        h("span", { style: styles.metricLabel }, props.label),
        h("span", { style: styles.metricValue }, props.value),
        props.hint ? h("span", { style: styles.fieldHint }, props.hint) : null);
    }

    /**
     * 单字段渲染。
     * ④ 摘要 provider/model：模型目录可用 ⇒ 两级下拉（model 用 optgroup 按 provider 分组；
     *   选了 provider 就只显示该 provider 的组）；目录不可用 ⇒ 退回自由文本（必须能填）。
     */
    function Field(props) {
      const { field, value, onChange, models, providerValue, gridStyle } = props;
      const groups = modelGroups(models);
      const hasCatalog = groups.length > 0;
      let control;

      if (field.kind === "boolean") {
        control = focusable("input", {
          type: "checkbox",
          checked: Boolean(value),
          onChange: (e) => onChange(field.key, e.target.checked),
          style: styles.checkbox,
        });
      } else if (field.kind === "enum") {
        control = focusable("select", { value: String(value ?? ""), onChange: (e) => onChange(field.key, e.target.value), style: styles.input, title: String(value ?? "") },
          field.options.map((opt) => h("option", { key: opt, value: opt }, opt)));
      } else if (field.kind === "number") {
        control = focusable("input", {
          type: "number",
          value: value ?? "",
          step: field.step ?? 1,
          min: field.min,
          max: field.max,
          onChange: (e) => onChange(field.key, e.target.value),
          style: styles.input,
        });
      } else if (field.key === "summarizationProvider" && hasCatalog) {
        // provider 下拉：第一项「跟随当前路由」；不在目录里的当前值单独留一项，避免显示成别的值。
        const known = new Set(groups.map((group) => group.provider));
        const current = value === undefined || value === null ? "" : String(value);
        control = focusable("select", {
          value: current,
          onChange: (e) => onChange(field.key, e.target.value),
          style: styles.input,
          // ★ U4 ②：长 provider 显示名/长 id 会被 220px 列截断 —— title 悬停看全名。
          title: current === "" ? "跟随当前路由" : describeProviderSelection(models, current) || current,
        },
          h("option", { value: "" }, "跟随当前路由"),
          current !== "" && !known.has(current) ? h("option", { key: "__current__", value: current }, `${current}（当前值，不在目录中）`) : null,
          groups.map((group) => h("option", { key: group.provider, value: group.provider }, group.label)));
      } else if (field.key === "summarizationModel" && hasCatalog) {
        // model 下拉：按 provider 分组（<optgroup>）；选了 provider 就是「两级联动」，只列它的模型。
        const providerId = providerValue === undefined || providerValue === null ? "" : String(providerValue);
        const visible = providerId !== "" && groups.some((group) => group.provider === providerId) ? groups.filter((group) => group.provider === providerId) : groups;
        const visibleIds = new Set(visible.flatMap((group) => group.models.map((item) => item.value)));
        const current = value === undefined || value === null ? "" : String(value);
        // 当前值可能不在「已选 provider 的模型」里（例如换了 provider）——单独留一项，否则受控 select 会显示空白。
        const currentEntry = current === "" ? null : groups.flatMap((group) => group.models.map((item) => ({ ...item, provider: group.provider, providerLabel: group.label }))).find((item) => item.value === current) ?? null;
        const currentLabel = currentEntry === null ? `${current}（当前值，不在目录中）` : `${currentEntry.label}（当前值，属 ${currentEntry.providerLabel}）`;
        control = focusable("select", {
          value: current,
          onChange: (e) => onChange(field.key, e.target.value),
          style: styles.input,
          // ★ U4 ②：模型全名（含窗口）放进 title，长 id（如 ima/deepseek-v4.1-flash）悬停可见。
          title: current === "" ? "跟随 provider / 当前路由" : describeModelSelection(models, providerId, current) || current,
        },
          h("option", { value: "" }, "跟随 provider / 当前路由"),
          current !== "" && !visibleIds.has(current) ? h("option", { key: "__current__", value: current }, currentLabel) : null,
          visible.map((group) => h("optgroup", { key: group.provider, label: group.label },
            group.models.map((item) => h("option", { key: `${group.provider}/${item.value}`, value: item.value },
              item.contextWindow === null ? item.label : `${item.label}（${fmt(item.contextWindow)} tok）`)))));
      } else {
        control = focusable("input", {
          type: "text",
          value: value ?? "",
          onChange: (e) => onChange(field.key, e.target.value),
          placeholder: "留空 = 跟随路由",
          style: styles.input,
          // ★ U4 ②：手填的模型 id 可能很长，title 给完整值（空值时提示跟随路由）。
          title: String(value ?? "") === "" ? "留空 = 跟随路由" : String(value),
        });
      }

      const isSummaryKey = field.key === "summarizationProvider" || field.key === "summarizationModel";
      // ★ U2/U1：宿主模型目录拿不到是**常态**（某些 provider 的 listModels 走网络/不支持）——
      //   明确告诉用户「可手填」，而不是让下拉看起来像「没有模型」。
      const hint = isSummaryKey && !hasCatalog ? `${field.hint}（模型目录未取到，可手填）` : field.hint;
      // ★ U4 ①：窄屏（<600px）走两行，宽屏三列；样式来自纯函数 fieldGridFor(viewportWidth)。
      return h("div", { style: gridStyle ?? fieldGridFor(TWO_COLUMN_MIN_WIDTH).style },
        h("div", null,
          h("div", { style: styles.fieldLabel }, field.label),
          h("div", { style: styles.fieldHint }, hint)),
        control,
        h("div", { style: styles.code }, props.defaultValue === undefined ? "" : `默认 ${String(props.defaultValue)}`));
    }

    /**
     * ① 双栏断点订阅：React inline style 做不了媒体查询 ⇒ matchMedia + change 事件。
     * **卸载时必须 removeEventListener**（同时兼容只提供 addListener/removeListener 的老 WebView）。
     */
    function useWideLayout() {
      const matchMediaOf = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(VIEWPORT_QUERY) : null);
      const [wide, setWide] = useState(() => {
        const mql = matchMediaOf();
        return mql !== null && Boolean(mql.matches);
      });
      useEffect(() => {
        const mql = matchMediaOf();
        if (mql === null) return undefined;
        const onChange = (event) => setWide(Boolean(event?.matches));
        setWide(Boolean(mql.matches));
        if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
        else if (typeof mql.addListener === "function") mql.addListener(onChange);
        return () => {
          if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", onChange);
          else if (typeof mql.removeListener === "function") mql.removeListener(onChange);
        };
      }, []);
      return wide;
    }

    /**
     * ★ U4 ① 视口宽度（matchMedia 只给布尔，给不出 599/600 的像素，所以用 resize 事件）。
     * 卸载 removeEventListener；拿不到 window 时退回 1280（宁可三列，不误判窄屏）。
     */
    function useViewportWidth() {
      const readWidth = () => (typeof window !== "undefined" && typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth) ? window.innerWidth : TWO_COLUMN_MIN_WIDTH);
      const [width, setWidth] = useState(readWidth);
      useEffect(() => {
        if (typeof window === "undefined") return undefined;
        const onResize = () => setWidth(readWidth());
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, []);
      return width;
    }

    function Page() {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState({});
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [saved, setSaved] = useState(null);
      // ★ U2：模型目录独立于 state —— 首屏用 state.models 立刻渲染；空目录时页面照常可用，
      //   用户可以点「刷新模型列表」单独再问一次（action:"models"，失败也是空目录，不影响保存）。
      const [models, setModels] = useState(null);
      const [modelsBusy, setModelsBusy] = useState(false);
      // ★ U5：版本检查与页面主体解耦 —— host 的 state.update 只是**缓存快照**（首屏不等 registry），
      //   没有缓存时首屏画完再补一次；「重新检查」走 refresh:true 强制绕过 host 的 10 分钟缓存。
      const [update, setUpdate] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);
      const [showCommand, setShowCommand] = useState(false);
      const [copied, setCopied] = useState(false);
      const wide = useWideLayout();
      // ★ U4 ①：字段行断点（<600px 两行）需要真实视口宽度。
      const viewportWidth = useViewportWidth();
      const fieldGrid = fieldGridFor(viewportWidth);

      /** 问一次 host 的版本检查。失败（host 半没起来/非 JSON）也落成一条可读结果，不留空白。 */
      const runUpdateCheck = useCallback(async (refresh) => {
        setUpdateBusy(true);
        try {
          const value = await requestUpdate(refresh === true);
          setUpdate(value ?? null);
          setCopied(false);
        } catch (e) {
          setUpdate({
            ok: true,
            current: null,
            latest: null,
            publishedAt: null,
            hasUpdate: false,
            command: "",
            error: String(e.message ?? e),
            cachedAt: null,
          });
        } finally {
          setUpdateBusy(false);
        }
      }, []);

      const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const data = await callApi("state");
          setState(data);
          setDraft({ ...data.config });
          setModels(data.models ?? { providers: [] });
          // ★ U5：首屏只吃 host 的内存缓存（**不发网络**）；没有缓存才在画完之后补一次。
          const cached = data.update ?? null;
          setUpdate(cached);
          if (cached === null) void runUpdateCheck(false);
        } catch (e) {
          setError(String(e.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [runUpdateCheck]);

      useEffect(() => {
        void load();
      }, [load]);

      const dirtyKeys = useMemo(() => {
        if (!state) return [];
        return Object.keys(draft).filter((key) => String(draft[key] ?? "") !== String(state.config?.[key] ?? ""));
      }, [draft, state]);

      const save = useCallback(async () => {
        setBusy(true);
        setError(null);
        setSaved(null);
        try {
          const patch = {};
          for (const key of dirtyKeys) patch[key] = draft[key];
          const result = await callApi("save", { patch });
          setSaved(result);
          await load();
        } catch (e) {
          setError(String(e.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [dirtyKeys, draft, load]);

      const resetDefaults = useCallback(() => {
        if (!state) return;
        setDraft({ ...state.config, ...state.defaults });
      }, [state]);

      /** ★ U2：只刷新模型目录，不挡配置表单（不动 state/draft，不和保存/加载抢 busy）。 */
      const refreshModels = useCallback(async () => {
        setModelsBusy(true);
        try {
          const data = await callApi("models");
          setModels(data.models ?? { providers: [] });
        } catch (e) {
          // 目录刷新失败**不覆盖**页面主体错误（它是可重试的轻操作）
          setError(String(e.message ?? e));
        } finally {
          setModelsBusy(false);
        }
      }, []);

      /**
       * ★ U5：复制升级命令。剪贴板可能不可用（非 https / 权限被拒 / 老 WebView）——
       * 失败时**什么都不做**：代码块本身 user-select:all，用户仍可点一下整段选中复制。
       */
      const copyUpdateCommand = useCallback((command) => {
        if (typeof command !== "string" || command === "") return;
        try {
          const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
          if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
            Promise.resolve(clipboard.writeText(command))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }
        } catch {
          /* 剪贴板被禁：保留可选中复制，不报错 */
        }
      }, []);

      if (error !== null && state === null) {
        return h("div", { style: styles.page },
          h("div", { style: styles.error }, error),
          h("div", { style: styles.fieldHint }, "host 半没加载时会出现这个错误 —— 需要重启 DSH（插件在启动时加载）。"),
          focusable("button", { style: styles.btn, onClick: load }, "重试"));
      }

      const latest = state?.latest ?? null;
      const today = state?.today ?? null;
      const health = state?.health ?? null;
      const cfg = state?.config ?? {};
      const used = latest?.totalAfter ?? 0;
      // ⑤ 窗口大小只认宿主模型目录里的 contextWindow；拿不到就是 null（显示 —、隐藏进度条）。
      const windowTokens = resolveWindowTokens(models, draft.summarizationProvider, draft.summarizationModel);
      const ratio = windowTokens === null ? null : used / windowTokens;
      const mountedOk = Boolean(health?.mounted && health?.singleInstance);
      const versionText = `v${state?.version ?? "?"}`;
      const pill = h("span", { style: styles.pill(mountedOk) }, mountedOk ? "已接管" : "未接管");
      // ★ U4 ③：标题行右侧显示当前 profile（只读 host 已给的 state.profile / health.profile）。
      const profileName = profileLabel(state, health);
      // ★ U5：版本检查的展示值（全部来自 host，页面不自己拼命令、不自己比版本）。
      //   检查失败时 error 有值、latest 为 null —— 卡片显示「检查失败」+ 原因，而不是空白。
      const updateCurrent = typeof update?.current === "string" && update.current !== "" ? update.current : state?.version ?? "—";
      const updateLatest = update === null || update === undefined ? "未检查" : update.error ? "—" : update.latest ?? "—";
      const updateCheckedAt = formatTimestamp(update?.cachedAt) || "—";
      const updateStatus = updateStatusText(update);
      const updateCommand = updateCommandText(update);
      const updateBanner = updateBannerText(update);

      const header = h("div", { style: styles.header },
        h("div", { style: styles.headerText },
          h("h1", { style: styles.h1 },
            "上下文压缩",
            // 单栏：保留原来的「标题 + pill + version」一行（信息优先级不变）；双栏：pill/version 进右栏状态卡。
            wide ? null : pill,
            wide ? null : h("span", { style: styles.sub }, versionText)),
          h("p", { style: styles.sub }, "棋谱式增量 fold · 热清单每步重建 · 失败记忆逐字保留")),
        // 双栏标题行右上角不再空：显示 profile（单栏仍保持原来的紧凑一行，不加戏）。
        wide ? h("div", { style: styles.headerMeta },
          h("span", { style: styles.fieldHint }, "profile"),
          h("span", { style: styles.code }, profileName)) : null);

      /** 右栏顶部：运行状态（双栏才单独成卡；单栏时 pill/version 在标题行里）。 */
      const statusCard = wide
        ? h("div", { style: styles.card },
            h("div", { style: styles.cardTitle }, "运行状态"),
            h("div", { style: styles.row },
              h("div", { style: styles.metric }, h("span", { style: styles.metricLabel }, "接管"), pill),
              h(Metric, { label: "版本", value: versionText }),
              h(Metric, { label: "profile", value: profileName })))
        : null;

      /**
       * ★ U5 顶部横幅：真有新版时才在页面最上方说一次（不埋进设置里）。
       * 「升级命令」展开/收起，命令在可复制的代码块里。**这里不执行任何安装**，只陈述事实 + 给命令。
       */
      const updateNotice = updateBanner === ""
        ? null
        : h("div", { style: styles.banner },
            h("div", { style: styles.bannerRow },
              h("span", { style: styles.bannerLabel }, updateBanner),
              focusable("button", { style: styles.btn, onClick: () => setShowCommand((previous) => !previous) }, showCommand ? "收起命令" : "升级命令")),
            showCommand
              ? h("div", { style: styles.codeBlock },
                  h("code", { style: styles.codeText }, updateCommand === "" ? "—" : updateCommand),
                  h("div", { style: styles.actions },
                    focusable("button", { style: styles.btn, onClick: () => copyUpdateCommand(updateCommand) }, copied ? "已复制" : "复制命令")))
              : null);

      /** ★ U5 右栏「检查更新」卡：当前版本 / 最新版本 / 上次检查时间 / 状态，失败时给原因。 */
      const updateCard = h("div", { style: styles.card },
        h("div", { style: styles.cardTitle }, "检查更新"),
        h("div", { style: styles.row },
          h(Metric, { label: "当前版本", value: updateCurrent }),
          h(Metric, { label: "最新版本", value: updateLatest }),
          h(Metric, { label: "上次检查", value: updateCheckedAt }),
          h(Metric, { label: "状态", value: updateStatus })),
        update?.publishedAt ? h("div", { style: styles.fieldHint }, `最新版发布于 ${formatTimestamp(update.publishedAt) || update.publishedAt}`) : null,
        update?.error ? h("div", { style: styles.error }, `检查失败：${update.error}`) : null,
        h("div", { style: styles.actions },
          focusable("button", { style: styles.btn, disabled: updateBusy, onClick: () => { void runUpdateCheck(true); } }, updateBusy ? "检查中…" : "重新检查")));

      const windowMetric = h(Metric, {
        label: "窗口",
        value: windowTokens === null ? "—" : `${fmt(windowTokens)} tok`,
        hint: windowTokens === null ? "宿主没给 contextWindow" : undefined,
      });

      const latestCard = latest
        ? h("div", { style: styles.card },
            h("div", { style: styles.cardTitle }, "最近活跃会话"),
            h("div", { style: styles.code }, latest.session),
            ratio === null ? null : h("div", { style: styles.bar }, h("div", { style: styles.barFill(ratio) })),
            h("div", { style: styles.row },
              h(Metric, { label: "fold 后总量", value: `${fmt(used)} tok` }),
              windowMetric,
              h(Metric, { label: "占窗口", value: ratio === null ? "—" : pct(ratio) }),
              h(Metric, { label: "fold 次数", value: fmt(latest.foldCount) }),
              h(Metric, { label: "失败边", value: fmt(latest.failures) }),
              // ★ C232：已修正的失败（同 action 后来跑通）—— 判别价值最低，渲染时已沉底（C231）
              h(Metric, { label: "已修正失败", value: fmt(latest.resolvedFailures ?? 0), hint: "同一条命令后来跑通了；清单里沉底" }),
              h(Metric, { label: "棋谱节点", value: fmt(latest.nodes) }),
              latest.lastFold ? h(Metric, { label: "上次遮蔽", value: `${fmt(latest.lastFold.shadowedTokens)} tok`, hint: `seq ${latest.lastFold.seqStart}-${latest.lastFold.seqEnd}` }) : null),
            latest.lastUsage ? h("div", { style: styles.fieldHint },
              `上次摘要：输入 ${fmt(latest.lastUsage.inputTokens)} / 输出 ${fmt(latest.lastUsage.outputTokens)} tok · ${latest.lastUsage.provider ?? "?"}/${latest.lastUsage.model ?? "?"}`) : null)
        : h("div", { style: styles.card }, h("div", { style: styles.cardTitle }, "最近活跃会话"), h("div", { style: styles.fieldHint }, "还没有棋谱"));

      const todayCard = today
        ? h("div", { style: styles.card },
            h("div", { style: styles.cardTitle }, "今天"),
            h("div", { style: styles.row },
              h(Metric, { label: "fold 次数", value: fmt(today.folds) }),
              h(Metric, { label: "涉及会话", value: fmt(today.sessions) }),
              h(Metric, { label: "合计遮蔽", value: `${fmt(today.shadowed)} tok` }),
              h(Metric, { label: "棋谱总数", value: fmt(today.totalSessions) }),
              h(Metric, { label: "全库失败边", value: fmt(today.totalFailures) })))
        : null;

      // ★ U2：模型目录为空时的轻提示 + 刷新按钮（不挡表单；目录拿不到时两个键仍是自由文本）。
      const modelsNotice = modelsAvailable(models)
        ? null
        : h("div", { style: styles.modelsNotice },
            h("span", { style: styles.fieldHint }, "模型目录未取到 —— provider / model 可手填；"),
            focusable("button", { style: styles.btn, disabled: modelsBusy, onClick: refreshModels }, modelsBusy ? "刷新中…" : "刷新模型列表"));

      const paramsCard = h("div", { style: styles.card },
        h("div", { style: styles.cardTitle }, "参数"),
        modelsNotice,
        FIELDS.map((field) => h(Field, {
          key: field.key,
          field,
          value: draft[field.key],
          defaultValue: state?.defaults?.[field.key],
          models,
          providerValue: draft.summarizationProvider,
          gridStyle: fieldGrid.style,
          onChange: (key, value) => setDraft((prev) => ({ ...prev, [key]: value })),
        })));

      const actions = h("div", { style: styles.actions },
        focusable("button", { style: styles.btnPrimary, disabled: busy || dirtyKeys.length === 0, onClick: save }, busy ? "保存中…" : dirtyKeys.length > 0 ? `保存（${dirtyKeys.length} 项改动）` : "保存"),
        focusable("button", { style: styles.btn, disabled: busy, onClick: resetDefaults }, "恢复默认"),
        focusable("button", { style: styles.btn, disabled: busy, onClick: load }, "刷新"),
        h("span", { style: styles.fieldHint }, dirtyKeys.length > 0 ? `未保存：${dirtyKeys.join("、")}` : ""));

      const notices = [
        saved ? h("div", { style: styles.note },
          saved.changed?.length > 0
            ? `已写入 ${saved.changed.length} 个 preset；重启 DSH 后生效。备份：${saved.backup ?? "—"}`
            : "没有改动（值与当前一致）。") : null,
        error !== null ? h("div", { style: styles.error }, error) : null,
        state?.configFile ? h("div", { style: styles.code }, `配置来源：${state.configFile}`) : null,
      ].filter((node) => node !== null);

      // 吸一口气：单栏 DOM 顺序 = 原来的顺序（指标 → 配置 → 按钮 → 提示）；
      // 双栏时用 grid 位置把「配置/按钮/提示」挪到左栏、「指标/状态」留给右栏（整页滚动，两栏不各自滚）。
      const rightColumn = [statusCard, updateCard, latestCard, todayCard].filter((node) => node !== null);
      const leftColumn = [paramsCard, actions, ...notices];

      return h("div", { style: styles.page },
        header,
        // ★ U5：横幅在标题之下、两栏之上（整宽），单栏/双栏都看得见。
        updateNotice,
        h("div", { style: wide ? styles.columns : undefined },
          h("div", { style: wide ? styles.columnRight : undefined }, rightColumn),
          h("div", { style: wide ? styles.columnLeft : undefined }, leftColumn)));
    }

    /* ───────────────────────── 图标 + 注册 ───────────────────────── */

    function Icon(props) {
      const size = props?.size ?? 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M2 5.5h12M2 10.5h12", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
        h("circle", { cx: 6, cy: 5.5, r: 1.8, fill: "currentColor" }),
        h("circle", { cx: 10.5, cy: 10.5, r: 1.8, fill: "currentColor" }));
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => "上下文压缩" },
          Icon,
        ));
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, Page));
    }

    exports.name = "gokifu-compact-ui";
    exports.inject = ["slots"];
    exports.apply = apply;

    /**
     * 测试用纯逻辑出口（★ U2）。**只是加法**：不改变 `window.__ModuleLoader__.load` 的既有契约
     * （模块 id / exports.name / inject / apply 都没动）。本文件是 classic script，
     * 不能用 ESM `export` 语法，所以挂在 exports 上；test/ui-layout.test.mjs 用
     * `new Function("window", src)` 加载后直接断言 —— 不渲染 React、不需要 DOM。
     */
    exports.__testables = {
      TWO_COLUMN_MIN_WIDTH,
      VIEWPORT_QUERY,
      FOCUS_OUTLINE,
      focusRing,
      focusable,
      layoutFor,
      FIELD_STACK_BELOW_WIDTH,
      SPACING,
      fieldGridFor,
      describeProviderSelection,
      describeModelSelection,
      profileLabel,
      updateStatusText,
      updateBannerText,
      updateCommandText,
      formatTimestamp,
      modelsAvailable,
      modelGroups,
      resolveWindowTokens,
      styles,
      FIELDS,
    };

    return module.exports;
  },
});
