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

    /* ───────────────────────── 小工具 ───────────────────────── */

    const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "—");
    const pct = (v) => (typeof v === "number" ? `${Math.round(v * 1000) / 10}%` : "—");

    const styles = {
      page: { padding: "24px 28px", display: "flex", flexDirection: "column", gap: "18px", maxWidth: "980px", color: "inherit" },
      h1: { fontSize: "20px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "10px" },
      sub: { fontSize: "12px", opacity: 0.65, margin: 0 },
      card: { border: "1px solid rgba(127,127,127,0.25)", borderRadius: "10px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "8px" },
      cardTitle: { fontSize: "12px", letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.55 },
      row: { display: "flex", flexWrap: "wrap", gap: "26px" },
      metric: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "130px" },
      metricLabel: { fontSize: "11px", opacity: 0.55 },
      metricValue: { fontSize: "17px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
      bar: { height: "6px", borderRadius: "3px", background: "rgba(127,127,127,0.2)", overflow: "hidden", width: "100%" },
      barFill: (ratio) => ({ height: "100%", width: `${Math.min(100, Math.max(0, ratio * 100))}%`, background: ratio > 0.9 ? "#e5484d" : ratio > 0.6 ? "#f5a524" : "#3ba55d" }),
      fieldRow: { display: "grid", gridTemplateColumns: "1fr 220px 120px", gap: "10px", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(127,127,127,0.12)" },
      fieldLabel: { fontSize: "13px" },
      fieldHint: { fontSize: "11px", opacity: 0.55 },
      input: { width: "100%", padding: "5px 8px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.08)", color: "inherit", fontSize: "13px" },
      btn: { padding: "7px 14px", borderRadius: "7px", border: "1px solid rgba(127,127,127,0.35)", background: "rgba(127,127,127,0.1)", color: "inherit", fontSize: "13px", cursor: "pointer" },
      btnPrimary: { padding: "7px 16px", borderRadius: "7px", border: "1px solid #3b82f6", background: "#2563eb", color: "#fff", fontSize: "13px", cursor: "pointer", fontWeight: 600 },
      pill: (ok) => ({ fontSize: "11px", padding: "2px 8px", borderRadius: "999px", border: `1px solid ${ok ? "#3ba55d" : "#e5484d"}`, color: ok ? "#3ba55d" : "#e5484d" }),
      note: { fontSize: "12px", padding: "8px 12px", borderRadius: "8px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.4)" },
      error: { fontSize: "12px", padding: "8px 12px", borderRadius: "8px", background: "rgba(229,72,77,0.12)", border: "1px solid rgba(229,72,77,0.45)" },
      code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", opacity: 0.7, wordBreak: "break-all" },
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

    function Field(props) {
      const { field, value, onChange } = props;
      let control;
      if (field.kind === "boolean") {
        control = h("input", { type: "checkbox", checked: Boolean(value), onChange: (e) => onChange(field.key, e.target.checked), style: { width: "16px", height: "16px", cursor: "pointer" } });
      } else if (field.kind === "enum") {
        control = h("select", { value: String(value ?? ""), onChange: (e) => onChange(field.key, e.target.value), style: styles.input },
          field.options.map((opt) => h("option", { key: opt, value: opt }, opt)));
      } else if (field.kind === "number") {
        control = h("input", { type: "number", value: value ?? "", step: field.step ?? 1, min: field.min, max: field.max, onChange: (e) => onChange(field.key, e.target.value), style: styles.input });
      } else {
        control = h("input", { type: "text", value: value ?? "", onChange: (e) => onChange(field.key, e.target.value), placeholder: "留空 = 跟随路由", style: styles.input });
      }
      return h("div", { style: styles.fieldRow },
        h("div", null,
          h("div", { style: styles.fieldLabel }, field.label),
          h("div", { style: styles.fieldHint }, field.hint)),
        control,
        h("div", { style: styles.code }, props.defaultValue === undefined ? "" : `默认 ${String(props.defaultValue)}`));
    }

    function Page() {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState({});
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [saved, setSaved] = useState(null);

      const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const data = await callApi("state");
          setState(data);
          setDraft({ ...data.config });
        } catch (e) {
          setError(String(e.message ?? e));
        } finally {
          setBusy(false);
        }
      }, []);

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

      if (error !== null && state === null) {
        return h("div", { style: styles.page },
          h("div", { style: styles.error }, error),
          h("div", { style: styles.fieldHint }, "host 半没加载时会出现这个错误 —— 需要重启 DSH（插件在启动时加载）。"),
          h("button", { style: styles.btn, onClick: load }, "重试"));
      }

      const latest = state?.latest ?? null;
      const today = state?.today ?? null;
      const health = state?.health ?? null;
      const cfg = state?.config ?? {};
      const used = latest?.totalAfter ?? 0;
      const windowTokens = 1000000;
      const ratio = windowTokens > 0 ? used / windowTokens : 0;

      return h("div", { style: styles.page },
        h("h1", { style: styles.h1 },
          "上下文压缩",
          h("span", { style: styles.pill(Boolean(health?.mounted && health?.singleInstance)) }, health?.mounted && health?.singleInstance ? "已接管" : "未接管"),
          h("span", { style: styles.sub }, `v${state?.version ?? "?"}`)),
        h("p", { style: styles.sub }, "棋谱式增量 fold · 热清单每步重建 · 失败记忆逐字保留"),

        latest ? h("div", { style: styles.card },
          h("div", { style: styles.cardTitle }, "最近活跃会话"),
          h("div", { style: styles.code }, latest.session),
          h("div", { style: styles.bar }, h("div", { style: styles.barFill(ratio) })),
          h("div", { style: styles.row },
            h(Metric, { label: "fold 后总量", value: `${fmt(used)} tok` }),
            h(Metric, { label: "fold 次数", value: fmt(latest.foldCount) }),
            h(Metric, { label: "失败边", value: fmt(latest.failures) }),
            h(Metric, { label: "棋谱节点", value: fmt(latest.nodes) }),
            latest.lastFold ? h(Metric, { label: "上次遮蔽", value: `${fmt(latest.lastFold.shadowedTokens)} tok`, hint: `seq ${latest.lastFold.seqStart}-${latest.lastFold.seqEnd}` }) : null),
          latest.lastUsage ? h("div", { style: styles.fieldHint },
            `上次摘要：输入 ${fmt(latest.lastUsage.inputTokens)} / 输出 ${fmt(latest.lastUsage.outputTokens)} tok · ${latest.lastUsage.provider ?? "?"}/${latest.lastUsage.model ?? "?"}`) : null)
          : h("div", { style: styles.card }, h("div", { style: styles.cardTitle }, "最近活跃会话"), h("div", { style: styles.fieldHint }, "还没有棋谱")),

        today ? h("div", { style: styles.card },
          h("div", { style: styles.cardTitle }, "今天"),
          h("div", { style: styles.row },
            h(Metric, { label: "fold 次数", value: fmt(today.folds) }),
            h(Metric, { label: "涉及会话", value: fmt(today.sessions) }),
            h(Metric, { label: "合计遮蔽", value: `${fmt(today.shadowed)} tok` }),
            h(Metric, { label: "棋谱总数", value: fmt(today.totalSessions) }),
            h(Metric, { label: "全库失败边", value: fmt(today.totalFailures) }))) : null,

        h("div", { style: styles.card },
          h("div", { style: styles.cardTitle }, "参数"),
          FIELDS.map((field) => h(Field, {
            key: field.key,
            field,
            value: draft[field.key],
            defaultValue: state?.defaults?.[field.key],
            onChange: (key, value) => setDraft((prev) => ({ ...prev, [key]: value })),
          }))),

        h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
          h("button", { style: styles.btnPrimary, disabled: busy || dirtyKeys.length === 0, onClick: save }, busy ? "保存中…" : dirtyKeys.length > 0 ? `保存（${dirtyKeys.length} 项改动）` : "保存"),
          h("button", { style: styles.btn, disabled: busy, onClick: resetDefaults }, "恢复默认"),
          h("button", { style: styles.btn, disabled: busy, onClick: load }, "刷新"),
          h("span", { style: styles.fieldHint }, dirtyKeys.length > 0 ? `未保存：${dirtyKeys.join("、")}` : "")),

        saved ? h("div", { style: styles.note },
          saved.changed?.length > 0
            ? `已写入 ${saved.changed.length} 个 preset；重启 DSH 后生效。备份：${saved.backup ?? "—"}`
            : "没有改动（值与当前一致）。") : null,
        error !== null ? h("div", { style: styles.error }, error) : null,
        state?.configFile ? h("div", { style: styles.code }, `配置来源：${state.configFile}`) : null);
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
    return module.exports;
  },
});
