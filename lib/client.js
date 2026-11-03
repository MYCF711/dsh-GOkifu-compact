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
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

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
      if (update.hasUpdate === true) return "有新版本";
      // ★ C428：`hasUpdate:false` 有**三种**原因。C394 已经在服务端给出 `relation`，
      //   但界面一直把它全当"已是最新" —— 而真机上本地 1.17.6 比 registry 1.17.5 **更新**。
      const current = typeof update.current === "string" && update.current !== "" ? update.current : "?";
      if (update.relation === "ahead") return `本地更新（${current} > registry ${update.latest}）`;
      if (update.relation === "same") return "已是最新";
      // 没有 relation（旧服务端）：字面相等才能说"已是最新"，否则中立陈述两个版本号
      if (current === update.latest) return "已是最新";
      return `本地 ${current} / registry ${update.latest}`;
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

    /**
     * ★ C234：补账结果 → 给人看的几行（纯函数）。
     * dryRun 给的是「谁欠多少」，真跑给的是「补完几个 / 折叠几个 / 失败几个」。
     * 一律**只陈述事实**，不写"建议你…"（仓库有 boundary-audit 门禁扫这类句式）。
     */
    /**
     * ★ C239：折叠成本估算怎么显示。价目来自 DeepSeek 官方页（deepseek-flash 低峰），
     * 所以**必须写「估算」**——价目会变，且不含宿主侧的 system/tools 开销。
     * @returns {string} `$0.032` / `$1.06` / `—`（没有数据就不编 0）
     */
    /**
     * ★ C267：上次摘要**到底用了谁**。
     * 为什么要显示：C242 之后「永久性错误 ⇒ 强制走规则摘要」是一条真实路径，
     * 而规则摘要意味着**这次压缩没有模型参与**（质量不同）。用户在面板上应该看得见，不用等 doctor。
     * @returns {{value:string, hint:string}}
     */
    function summaryRouteText(lastUsage) {
      if (!lastUsage || typeof lastUsage !== "object") return { value: "—", hint: "还没有 fold" };
      const model = typeof lastUsage.model === "string" ? lastUsage.model : "";
      const provider = typeof lastUsage.provider === "string" ? lastUsage.provider : "";
      // 规则摘要的记账哨兵：provider=chess-context / model=rules（见 engine.summarize 的规则分支）
      if (model === "rules" || provider === "chess-context") {
        return { value: "规则（无模型）", hint: "这次压缩没有调用模型：要么 summaryMode=rules，要么模型路径失败后兜底" };
      }
      if (model === "") return { value: "未知", hint: "foldMark 里没有 route（旧版本写的）" };
      return { value: model.split("/").at(-1) || model, hint: provider === "" ? "provider 未记录" : `provider: ${provider}` };
    }

    function costText(today) {
      const usd = Number(today?.costUsd);
      if (!Number.isFinite(usd) || usd <= 0) return "—";
      const known = Number(today?.costKnown) || 0;
      const shown = usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
      // ★ C453：按**每次折叠发生的时刻**计价（C452 的峰谷两档）。有高峰折叠时要标出来 ——
      //   否则用户会纳闷"今天怎么比昨天贵一倍"，而答案是"你今天在 9–12 点干活"。
      const peak = Number(today?.peakFolds) || 0;
      const peakNote = peak > 0 ? ` · ${peak} 次按高峰价` : "";
      return known > 0 ? `${shown}（${known} 次有 usage${peakNote}）` : `${shown}${peakNote}`;
    }

    /**
     * ★ C263：把两批补账结果**合并**（面板一次点击自动跑多批，每批仍然有界）。
     * 纯函数：`done/folded/failed` 相加，`results` 拼接，`due` 取**最后一批**（服务端每次都会重算欠账），
     * `total` 相加（面板文案里的"补完 X / Y"是"这一轮一共处理了几个"）。
     */
    function mergeBackfill(acc, batch) {
      if (!batch || typeof batch !== "object") return acc;
      if (acc === null) return { ...batch, results: Array.isArray(batch.results) ? [...batch.results] : [] };
      if (batch.ok === false) return { ...acc, error: batch.error ?? batch.code ?? "补账失败" };
      return {
        ...acc,
        ok: acc.ok !== false && batch.ok !== false,
        due: Number.isFinite(Number(batch.due)) ? Number(batch.due) : acc.due,
        total: (Number(acc.total) || 0) + (Number(batch.total) || 0),
        done: (Number(acc.done) || 0) + (Number(batch.done) || 0),
        folded: (Number(acc.folded) || 0) + (Number(batch.folded) || 0),
        failed: (Number(acc.failed) || 0) + (Number(batch.failed) || 0),
        results: [...(Array.isArray(acc.results) ? acc.results : []), ...(Array.isArray(batch.results) ? batch.results : [])],
      };
    }

    function backfillLines(data) {
      if (!data || typeof data !== "object") return [];
      if (typeof data.error === "string" && data.error !== "") return [`失败：${data.error}`];
      if (data.dryRun === true) {
        const items = Array.isArray(data.items) ? data.items : [];
        const lines = [`欠账 ${fmt(data.due ?? 0)} 个会话（扫了 ${fmt(data.scanned ?? 0)} 个）`];
        // ★ C287：尾巴估算超过常见模型窗口就**先说出来** —— 否则用户点下去会白等十几分钟再失败。
        //   150k 是保守阈值（多数 provider 的窗口在 128k~200k），宁可早提醒。
        const BIG_TAIL_TOKENS = 150_000;
        for (const item of items.slice(0, 8)) {
          const est = Number(item?.estTokens);
          // ★ C290：C289 之后超限不再是"会失败"，而是**自动分段折**（每段 ≤150k tok、单次最多 6 段）——
          //   文案必须跟着改，否则用户会以为这个会话注定补不上。
          const big = Number.isFinite(est) && est > BIG_TAIL_TOKENS ? ` ⚠ 估约 ${(est / 1000).toFixed(0)}k tok，会分成多段折` : "";
          lines.push(`${String(item?.sessionId ?? "").slice(0, 18)} · 尾巴 ${fmt(item?.tail ?? 0)} 事件${big}`);
        }
        if (items.length > 8) lines.push(`…另有 ${fmt(items.length - 8)} 个`);
        if (items.length === 0) lines.push("没有欠账：已归档的会话都已经压过");
        else {
          // ★ C285：官方口径（C284）—— 缓存闲置几小时到几天会自动清空。
          //   补账的对象都是**闲置的归档会话** ⇒ 每个会话的第一次折叠是**冷缓存**，按全额输入计费。
          //   不写这句，用户点下去会以为跟平时一样便宜（平时 98% 命中）。
          // ★ C286：把「大概多少钱」算出来 —— 每个会话的 estTokens 由服务端按**本会话历史 tokens/事件**估的，
          //   再按冷缓存全额输入价（$0.15/M，见 PRICE_USD_PER_MTOK）折算。没有估值的会话不计入，并说明有几个没估。
          const known = items.filter((it) => Number.isFinite(Number(it?.estTokens)) && Number(it.estTokens) > 0);
          const totalTokens = known.reduce((sum, it) => sum + Number(it.estTokens), 0);
          if (known.length > 0) {
            const usd = (totalTokens * 0.15) / 1e6;
            lines.push(
              `预计输入约 ${(totalTokens / 1e6).toFixed(2)} M tok ≈ $${usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(3)}（冷缓存全额价；` +
                `${known.length} 个会话可估${known.length < items.length ? `，另 ${items.length - known.length} 个没有历史 fold 估不了` : ""}）`,
            );
          }
          const bigCount = items.filter((it) => Number.isFinite(Number(it?.estTokens)) && Number(it.estTokens) > BIG_TAIL_TOKENS).length;
          if (bigCount > 0) {
            // ★ C287：**别让用户白花钱**。实测本机 11/11 个可估欠账全部超过 150k tok ⇒ 一次性折叠必然超窗口。
            lines.push(
              `其中 ${bigCount} 个尾巴过大，会**自动分段折叠**（每段 ≤150k tok、单次最多 6 段；装不下就再点一次继续）`,
            );
          }
          lines.push("补账跑的是**冷缓存**（归档会话闲置后缓存已清空）⇒ 每个会话的折叠按全额输入价计费，比平时贵得多");
        }
        // ★ C420：服务端从 C392 就开始返回 `warnings`（「哪几个会超时」），
        //   但**界面一直没显示** —— 算了不显示，等于没算。这里把它们打出来。
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings.slice(0, 3)) lines.push(`⚠ ${String(w)}`);
        }
        // ★ C420：C417 的 `applied`（真正生效的参数）也要可见 —— 参数被忽略时，
        //   用户需要从界面上看出来，而不是去读 JSON。
        const applied = data.applied;
        if (applied && typeof applied === "object" && Array.isArray(applied.sessionIds) && applied.sessionIds.length > 0) {
          lines.push(`本次只处理你指定的 ${fmt(applied.selected ?? applied.sessionIds.length)} 个会话`);
        }
        return lines;
      }
      // ★ C258：失败时**点名**是哪些会话、为什么 —— 只写"失败 3"用户没法处理。
      const head = `补完 ${fmt(data.done ?? 0)} / ${fmt(data.total ?? 0)}（真折叠 ${fmt(data.folded ?? 0)}；失败 ${fmt(data.failed ?? 0)}）`;
      // ★ C259：本次只处理了前 N 个（服务端按 limit 截断）⇒ 明确告诉用户"还剩多少"
      const rest = Number.isFinite(Number(data.due)) ? Math.max(0, Number(data.due) - (Number(data.total) || 0)) : 0;
      const restLine = rest > 0 ? `还有 ${fmt(rest)} 个没补 —— 再点一次「开始补账」继续` : null;
      const failed = (Array.isArray(data.results) ? data.results : []).filter((r) => r && r.ok !== true && r.skipped === undefined);
      if (failed.length === 0) return restLine === null ? [head] : [head, restLine];
      const lines = [head];
      for (const r of failed.slice(0, 5)) {
        lines.push(`✗ ${String(r.sessionId ?? "").slice(0, 18)} · ${String(r.error ?? "未知原因").slice(0, 80)}`);
      }
      if (failed.length > 5) lines.push(`…另有 ${fmt(failed.length - 5)} 个失败`);
      if (restLine !== null) lines.push(restLine);
      return lines;
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
      // ★ C508：模型**二级菜单**（provider 一级 / model 二级）——原生 <optgroup> 在深色主题下
      //   只剩一片看不清的灰字，等于「二级菜单没做」。改成自绘弹层，两级都看得见、点得动。
      pickerWrap: { position: "relative", width: "100%" },
      pickerBtn: { width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.08)", color: "inherit", fontSize: "13px", cursor: "pointer", display: "flex", justifyContent: "space-between", gap: "6px", outline: "none" },
      pickerPop: { position: "absolute", zIndex: 40, top: "calc(100% + 4px)", left: 0, minWidth: "100%", maxHeight: "260px", overflowY: "auto", borderRadius: "8px", border: "1px solid rgba(127,127,127,0.35)", background: "var(--dsh-popover-bg, #1f2430)", color: "var(--dsh-popover-fg, #e6e9ef)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)", padding: "4px" },
      pickerGroup: { fontSize: "11px", opacity: 0.6, padding: "6px 8px 2px", letterSpacing: "0.02em" },
      pickerItem: { display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: "6px", border: "none", background: "transparent", color: "inherit", fontSize: "13px", cursor: "pointer", outline: "none" },
      pickerItemOn: { display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: "6px", border: "none", background: "rgba(59,130,246,0.22)", color: "inherit", fontSize: "13px", cursor: "pointer", fontWeight: 600, outline: "none" },
      pickerEmpty: { fontSize: "12px", opacity: 0.6, padding: "6px 8px" },
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
      // ★ C255：补齐 6 个「preset 里有、面板上没有」的键 —— 其中 closeout* 是 1.17.2/1.17.6 的
      //   归档收尾能力：功能在、文档在，但用户**没法从面板改**（只能手改 yaml）。
      { key: "firstFoldRatio", label: "首折阈值（占窗口）", hint: "只作用于本会话第一次 fold；0 = 关闭", kind: "number", step: 0.01, min: 0, max: 0.9 },
      { key: "headroomTokens", label: "压力余量（tokens）", hint: "路由输出预留之外的额外余量", kind: "number", step: 1024, min: 0, max: 1048576 },
      { key: "closeoutFold", label: "归档收尾折叠", hint: "会话被归档时补一次折叠（尾巴太短则不折叠）", kind: "boolean" },
      { key: "closeoutMinEvents", label: "归档收尾最小事件数", hint: "尾巴至少这么多事件才值得一次模型调用", kind: "number", step: 10, min: 0, max: 10000 },
      { key: "closeoutMaxFoldTokens", label: "收尾单段上限(tokens)", hint: "分段收尾每段的输入上限；窗口大时调大能少跑几轮（默认 150k 偏保守）", kind: "number", step: 10000, min: 20000, max: 800000 },
      { key: "closeoutTimeoutMs", label: "归档收尾超时(ms)", hint: "超时只记日志，归档继续", kind: "number", step: 5000, min: 0, max: 600000 },
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
    /**
     * ★ C508：**模型二级菜单**（provider 一级 → model 二级）。
     *
     * 为什么不用原生 `<select>` + `<optgroup>`：实测在深色主题下，optgroup 的分组标题
     * 只剩一片看不清的灰字 —— 用户看到的正是「二级菜单没做」。
     * 这里自绘弹层：分组标题（provider）与条目（model，带窗口）都是真正可点的元素。
     */
    function SummaryModelPicker(props) {
      const { value, providerValue, models, onChange } = props;
      const groups = modelGroups(models);
      const [open, setOpen] = useState(false);
      const wrapRef = useRef(null);
      const current = value === undefined || value === null ? "" : String(value);
      const providerId = providerValue === undefined || providerValue === null ? "" : String(providerValue);
      // 选了 provider 就只列它的模型（两级联动）；没选就全列，并按 provider 分组
      const visible = providerId !== "" && groups.some((group) => group.provider === providerId) ? groups.filter((group) => group.provider === providerId) : groups;
      const currentEntry = current === "" ? null : groups.flatMap((group) => group.models.map((item) => ({ ...item, providerLabel: group.label }))).find((item) => item.value === current) ?? null;
      const label = current === "" ? "跟随 provider / 当前路由" : `${currentEntry === null ? current : currentEntry.label}${currentEntry === null ? "" : ` · ${currentEntry.providerLabel}`}`;

      // 点外面 / Esc 关闭（弹层是覆盖物，不关会挡住下面的字段）
      useEffect(() => {
        if (!open) return undefined;
        const onDocClick = (event) => {
          const el = wrapRef.current;
          if (el !== null && el !== undefined && typeof el.contains === "function" && !el.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDocClick);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      return h("div", { ref: wrapRef, style: styles.pickerWrap },
        focusable("button", {
          type: "button",
          style: styles.pickerBtn,
          // ★ U4 ②：长 id 悬停看全名（与原生 select 时期同一套纯函数，别因为换了控件就丢掉）
          title: current === "" ? "跟随 provider / 当前路由" : describeModelSelection(models, providerId, current) || current,
          "aria-haspopup": "listbox",
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((v) => !v),
        }, h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label), h("span", null, "▾")),
        open
          ? h("div", { style: styles.pickerPop, role: "listbox" },
              focusable("button", {
                type: "button",
                key: "__inherit__",
                style: current === "" ? styles.pickerItemOn : styles.pickerItem,
                onClick: () => {
                  onChange("");
                  setOpen(false);
                },
              }, "跟随 provider / 当前路由"),
              visible.length === 0
                ? h("div", { style: styles.pickerEmpty }, "目录里没有可用模型 —— 可手填，或点上面的「刷新模型列表」")
                : visible.map((group) => h("div", { key: group.provider },
                    h("div", { style: styles.pickerGroup }, `${group.label} · ${group.provider}`),
                    group.models.map((item) => focusable("button", {
                      type: "button",
                      key: `${group.provider}/${item.value}`,
                      role: "option",
                      style: item.value === current ? styles.pickerItemOn : styles.pickerItem,
                      title: item.value,
                      onClick: () => {
                        // 两步一次给全：选模型的同时把 provider 也定下来（否则会写进一个不匹配的 provider）
                        onChange(item.value, { provider: group.provider });
                        setOpen(false);
                      },
                    }, item.contextWindow === null ? item.label : `${item.label}（${fmt(item.contextWindow)} tok）`)))))
          : null);
    }

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
        // ★ C508：自绘二级菜单（原生 optgroup 在深色主题下看不清 = 用户说的"二级菜单没做"）
        control = h(SummaryModelPicker, {
          value,
          providerValue,
          models,
          // 两级一起落盘：选模型时顺带把 provider 定下来，避免"model 属于 A、provider 写着 B"
          onChange: (next, extra) => {
            onChange(field.key, next);
            if (extra !== undefined && extra.provider !== undefined) onChange("summarizationProvider", extra.provider);
          },
        });
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
      // ★ C234：补账（归档但没压完的会话）—— dryRun 先报清单，再真跑
      const [backfill, setBackfill] = useState(null);
      const [backfillBusy, setBackfillBusy] = useState(false);
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
       * ★ C507：**目录空了就自己再问一次**（不用用户去找「刷新模型列表」）。
       *
       * 为什么加：面板的 provider/model 是 <select>，**前提是模型目录非空**；
       * 目录为空时它们退化成文本框 —— 用户看到的就是「模型选不了」。
       * 首屏那次 `state.models` 可能因为宿主服务还没热起来而为空，这里补一次幂等重试（只补一次）。
       */
      const modelsRetried = useRef(false);
      useEffect(() => {
        if (modelsRetried.current) return undefined;
        if (models === null) return undefined; // 首屏还没回来
        if (modelsAvailable(models)) return undefined; // 有目录就别多问
        modelsRetried.current = true;
        void refreshModels();
        return undefined;
      }, [models, refreshModels]);

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

      /**
       * ★ C234：补账。dryRun=true 只报清单（不 resume、不调模型），false 才真补。
       * 拿不到引擎/控制器时服务端返回 503 + code —— 这里把 code 也显示出来，别只说"失败"。
       */
      const runBackfill = useCallback(async (dryRun) => {
        setBackfillBusy(true);
        try {
          // ★ C259：真跑时**按批**（每次最多 5 个）—— 单个 HTTP 请求里塞 12 个会话要挂 3 分钟，
          //   浏览器/宿主任何一侧超时都会让用户以为失败了（而服务端其实还在跑）。
          //   分批后每次请求 ≤ 5 个，剩下的由用户再点一次继续（面板会显示还剩多少）。
          // ★ C261：limit 与 perItemMs 一起收 —— 一个会话的**硬超时默认 3 分钟**，5 个就是 15 分钟挂在一个请求上。
          //   现在：每次最多 3 个、每个最多 90 秒（≈ 与引擎自己的收尾超时一致）⇒ 最坏 4.5 分钟、典型 45 秒。
          // ★ C262：perItemMs 必须**大于**引擎自己的收尾超时（`closeoutTimeoutMs` 默认 90s），
          //   否则外层超时和内层超时同时到点 —— 外层先开枪，用户看到的是笼统的 "timeout"，
          //   而不是引擎给出的具体原因。留 30 秒余量：120s 外层 / 90s 内层。
          if (dryRun) {
            const dry = await callApi("backfill", { dryRun: true });
            setBackfill(dry && dry.ok === false ? { error: dry.error ?? dry.code ?? "补账失败" } : dry);
            return;
          }
          // ★ C263：一次点击**自动跑多批**（每批仍 ≤3 个 / ≤4.5 分钟），最多 8 批（= 24 个会话）。
          //   为什么不再让用户每批点一次：12 个欠账要点 4 次，中间还得盯着；而每批本身已经很有界。
          //   任何一批报错就停（不带着错继续跑），已补的部分照常显示。
          let acc = null;
          for (let i = 0; i < 8; i += 1) {
            const batch = await callApi("backfill", { limit: 3, perItemMs: 120_000 });
            acc = mergeBackfill(acc, batch);
            setBackfill(acc);
            const rest = Number(acc?.due) - (Number(acc?.total) || 0);
            if (acc?.ok === false || !(rest > 0)) break;
          }
        } catch (e) {
          setBackfill({ error: String(e?.message ?? e) });
        } finally {
          setBackfillBusy(false);
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
              // ★ C267：上次摘要用了谁（规则摘要会让"上次摘要"显示成「规则（无模型）」）
              h(Metric, { label: "上次摘要", value: summaryRouteText(latest.lastUsage).value, hint: summaryRouteText(latest.lastUsage).hint }),
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
              // ★ C239：折叠成本的**估算**（官方价目 × 真实 usage）；hover 说明口径
              h(Metric, { label: "今日折叠成本（估算）", value: costText(today), hint: "DeepSeek 官方价目 ×**低峰**档 × 真实 usage（高峰约 2×，所以这是下限）；不含宿主侧 system/tools" }),
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
      // ★ C234：补账卡。归档会话没有 agent ⇒ 归档那一刻没压完的账只能在这里补
      //   （服务端 actions 是 `backfill`，dryRun 先报清单、不 resume 不调模型）。
      const backfillText = backfillLines(backfill);
      const backfillCard = h("div", { style: styles.card },
        h("div", { style: styles.cardTitle }, "补账"),
        h("div", { style: styles.fieldHint }, "宿主的压缩只对 idle agent 有效；归档会话没有 agent，所以归档那一刻没压完的账要在这里补（取消归档 → resume → 收尾折叠 → 原样归档回去）。"),
        h("div", { style: styles.actions },
          focusable("button", { style: styles.btn, disabled: backfillBusy, onClick: () => { void runBackfill(true); } }, backfillBusy ? "…" : "检查欠账（不调模型）"),
          focusable("button", { style: styles.btn, disabled: backfillBusy, onClick: () => { void runBackfill(false); } }, "开始补账")),
        h("div", { style: styles.code, ...(backfillText.length > 1 ? { whiteSpace: "pre-wrap" } : null) }, backfillText.length === 0 ? "—" : backfillText.join(String.fromCharCode(10))));

      const rightColumn = [statusCard, updateCard, backfillCard, latestCard, todayCard].filter((node) => node !== null);
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
      backfillLines,
      costText,
      mergeBackfill,
      summaryRouteText,
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
