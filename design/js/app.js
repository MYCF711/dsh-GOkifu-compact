/**
 * app.js —— 设计稿的交互层（原生 JS，无框架、无构建）
 *
 * 只做「原型该有的手感」，不假装有后端：
 *   · 侧边栏折叠（Ctrl/⌘+B，< 1024px 自动收起，选择记在 localStorage）
 *   · 深浅色（默认跟随系统，点过就以选择为准）
 *   · 全局面板行 / tab 跳转（四屏互通）
 *   · 工作区展开收起 + 会话搜索（本地过滤）
 *   · 输入框：自动增高、Enter 发送、Shift+Enter 换行、发送后追加一轮对话
 *   · 折痕行 / 工具行展开
 *   · 配置表单：开关、二级下拉、脏标记、保存 / 恢复默认 / 刷新
 *
 * 所有会「落盘」的动作都只落 localStorage 或弹一条 toast —— 这是原型，不是产品。
 */
(() => {
  "use strict";

  /* ── 小工具 ─────────────────────────────────────────────────────── */
  const KEY = "dsh-design:";
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(KEY + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(KEY + k, JSON.stringify(v));
      } catch {
        /* 隐私模式下写不进去，忽略 */
      }
    }
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const on = (el, type, fn, opts) => el && el.addEventListener(type, fn, opts);

  /** 官方鱼形 path：从页面上已有的标记里借一份，避免这里再抄 4KB 路径 */
  const fishSvg = (size) => {
    const ref = $(".brand__mark svg");
    if (!ref) return "";
    return `<svg viewBox="${ref.getAttribute("viewBox")}" width="${size}" height="${size}" aria-hidden="true" style="fill:currentColor">${ref.innerHTML}</svg>`;
  };

  /* ── toast ──────────────────────────────────────────────────────── */
  let toastTimer = 0;
  function toast(message, kind) {
    const layer = $("[data-toast-layer]");
    if (!layer) return;
    clearTimeout(toastTimer);
    layer.textContent = "";
    const el = document.createElement("div");
    el.className = "toast";
    el.dataset.kind = kind || "info";
    el.textContent = message;
    layer.appendChild(el);
    requestAnimationFrame(() => layer.classList.add("is-visible"));
    toastTimer = window.setTimeout(() => {
      layer.classList.remove("is-visible");
      window.setTimeout(() => el.remove(), 240);
    }, 2200);
  }

  /* ── 主题：跟随系统 / 浅色 / 深色 ──────────────────────────────── */
  const THEME_KEY = "theme";
  const THEMES = ["system", "light", "dark"];

  function storedTheme() {
    const v = store.get(THEME_KEY, "system");
    return THEMES.includes(v) ? v : "system";
  }

  function resolvedDark(choice) {
    if (choice === "dark") return true;
    if (choice === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(choice) {
    const dark = resolvedDark(choice);
    document.body.toggleAttribute("data-ds-dark-theme", dark);
    // data-theme 只用来关掉 tokens.css 里那份「无 JS 兜底」的深色镜像
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.themeChoice = choice;
    $$("[data-theme-pick]").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.themePick === choice));
    });
  }

  function initTheme() {
    applyTheme(storedTheme());
    on(window.matchMedia("(prefers-color-scheme: dark)"), "change", () => {
      // 只有「跟随系统」时才需要重算
      if (storedTheme() === "system") applyTheme("system");
    });
    $$("[data-theme-pick]").forEach((btn) => {
      on(btn, "click", () => {
        const choice = btn.dataset.themePick;
        store.set(THEME_KEY, choice);
        applyTheme(choice);
        toast({ system: "外观：跟随系统", light: "外观：浅色", dark: "外观：深色" }[choice]);
      });
      on(btn, "keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          btn.click();
        }
      });
    });
  }

  /* ── 侧边栏折叠 ────────────────────────────────────────────────── */
  const AUTO_COLLAPSE_BELOW = 1024;

  function sidebarCollapsed() {
    const frame = $(".app-frame");
    return frame ? frame.hasAttribute("data-sidebar-collapsed") : false;
  }

  function applySidebar(collapsed) {
    const frame = $(".app-frame");
    const bar = $(".sidebar");
    if (frame) frame.toggleAttribute("data-sidebar-collapsed", collapsed);
    if (bar) bar.toggleAttribute("data-collapsed", collapsed);
    const btn = $('.logo-row [data-action="toggle-sidebar"]');
    if (btn) {
      btn.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
      btn.title = collapsed ? "展开侧边栏（Ctrl+B）" : "收起侧边栏（Ctrl+B）";
    }
  }

  function resolveSidebar() {
    const stored = store.get("sidebar", null);
    applySidebar(stored === null ? window.innerWidth < AUTO_COLLAPSE_BELOW : stored === "collapsed");
  }

  function toggleSidebar() {
    store.set("sidebar", sidebarCollapsed() ? "expanded" : "collapsed");
    // 让 grid 过渡跑起来（初始渲染不想要动画）
    const frame = $(".app-frame");
    if (frame) frame.setAttribute("data-animating", "");
    applySidebar(!sidebarCollapsed());
  }

  /* ── 工作区 / 会话树 ───────────────────────────────────────────── */
  let searchQuery = "";

  function filterSessions() {
    const q = searchQuery.trim().toLowerCase();
    let total = 0;

    $$(".ws-group").forEach((group) => {
      const wsTitle = ($(".ws-row .row-title", group) || {}).textContent || "";
      const rows = $$(".session-row", group);
      let hit = 0;

      rows.forEach((row) => {
        const title = (($(".row-title", row) || {}).textContent || "").toLowerCase();
        const match = q === "" || title.includes(q) || wsTitle.toLowerCase().includes(q);
        row.hidden = !match;
        if (match) hit += 1;
      });

      const open = group.dataset.open !== "false";
      group.hidden = q === "" ? !open : hit === 0;
      total += hit;
    });

    const empty = $("[data-session-empty]");
    if (empty) empty.hidden = !(q !== "" && total === 0);
  }

  function initTree() {
    $$(".ws-group").forEach((group) => {
      const row = $(".ws-row", group);
      const open = row.getAttribute("aria-expanded") === "true";
      group.dataset.open = String(open);
      group.hidden = !open;
    });

    $$('[data-action="toggle-ws"]').forEach((row) => {
      on(row, "click", () => {
        const group = row.closest(".ws-group");
        const open = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", String(open));
        group.dataset.open = String(open);
        filterSessions();
      });
      on(row, "keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    });

    $$(".session-row").forEach((row) => {
      const select = () => {
        $$(".session-row[data-selected]").forEach((r) => r.removeAttribute("data-selected"));
        row.setAttribute("data-selected", "");
        const title = $(".row-title", row);
        if (title) document.title = title.textContent + " · DeepSeek Harness";
      };
      on(row, "click", select);
      on(row, "keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      });
    });

    const input = $('[data-action="search"]');
    const searchBtn = $('[data-action="toggle-search"]');
    const root = $("[data-search-root]");

    const closeSearch = () => {
      if (!input || input.hidden) return;
      input.hidden = true;
      input.value = "";
      searchQuery = "";
      if (root) root.removeAttribute("data-searching");
      filterSessions();
    };

    on(searchBtn, "click", () => {
      if (!input) return;
      input.hidden = false;
      if (root) root.setAttribute("data-searching", "");
      input.focus();
    });

    on(input, "input", () => {
      searchQuery = input.value;
      filterSessions();
    });
    on(input, "keydown", (e) => {
      if (e.key === "Escape") closeSearch();
    });
    on(input, "blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== input) closeSearch();
      }, 120);
    });
  }

  /* ── 会话页：输入框 + 发送 ─────────────────────────────────────── */
  const COMPOSER_MAX = 336;

  function initComposer() {
    const input = $("[data-composer]");
    if (!input) return;

    const sendBtn = $('[data-action="send"]');
    const scroll = $("[data-scroll]");
    const col = $("[data-chat-col]");

    const sync = () => {
      const empty = input.innerText.trim() === "";
      input.toggleAttribute("data-empty", empty);
      if (sendBtn) sendBtn.disabled = empty;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, COMPOSER_MAX) + "px";
    };

    const toBottom = () => {
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    };

    const appendRunning = () => {
      const row = document.createElement("div");
      row.className = "running msg-in";
      row.dataset.running = "";
      row.innerHTML = `<span class="running__content"><span class="running__icon">${fishSvg(14)}</span><span class="running__text">正在思考…</span></span>`;
      col.appendChild(row);
      return row;
    };

    const REPLY =
      "收到。这一屏是静态原型，真实回包要接 <code>/gokifu/api</code>。" +
      "侧边栏折叠（Ctrl+B）、tab 跳转、折痕展开、配置表单的脏标记都能点。";

    const doSend = () => {
      const text = input.innerText.trim();
      if (text === "") return;

      const userRow = document.createElement("div");
      userRow.className = "user-row msg-in";
      userRow.innerHTML = '<div class="user-stack"><div class="bubble"></div></div>';
      $(".bubble", userRow).textContent = text;
      col.appendChild(userRow);

      input.innerHTML = "";
      sync();
      toBottom();

      const stale = $("[data-running]");
      if (stale) stale.remove();
      const running = appendRunning();
      toBottom();

      window.setTimeout(() => {
        running.remove();
        const reply = document.createElement("div");
        reply.className = "assistant msg-in";
        reply.innerHTML = "<p>" + REPLY + "</p>";
        col.appendChild(reply);
        toBottom();
      }, 1400);
    };

    on(input, "input", sync);
    on(input, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    on(input, "paste", () => window.setTimeout(sync, 0));
    on(sendBtn, "click", doSend);
    sync();
  }

  /* ── 工具行 / 折痕行展开 ───────────────────────────────────────── */
  function initDisclosures() {
    $$('[data-action="toggle-tool"]').forEach((btn) => {
      on(btn, "click", () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", String(open));
        const body = $(".tool-row__body", btn.closest(".tool-row"));
        if (body) body.hidden = !open;
      });
    });

    $$('[data-action="toggle-fold"]').forEach((btn) => {
      on(btn, "click", () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", String(open));
        const detail = $(".gk-fold__detail", btn.closest(".gk-fold"));
        if (detail) detail.hidden = !open;
      });
    });
  }

  /* ── 配置表单 ──────────────────────────────────────────────────── */
  function fieldLabel(field) {
    const el = $(".gk-field__label", field);
    return el ? el.textContent.trim() : field.dataset.field;
  }

  function fieldValue(field) {
    const kind = field.dataset.kind;
    if (kind === "boolean") {
      const sw = $(".gk-switch", field);
      return sw ? sw.getAttribute("aria-checked") : "false";
    }
    if (kind === "enum") {
      const picker = $(".gk-picker", field);
      return picker ? picker.dataset.value : "";
    }
    const input = $(".gk-input", field);
    return input ? input.value : "";
  }

  function setFieldValue(field, value) {
    const kind = field.dataset.kind;
    if (kind === "boolean") {
      const sw = $(".gk-switch", field);
      if (sw) sw.setAttribute("aria-checked", value);
      return;
    }
    if (kind === "enum") {
      const picker = $(".gk-picker", field);
      if (!picker) return;
      picker.dataset.value = value;
      const label = $(".gk-select__value", picker);
      if (label) label.textContent = value;
      $$(".gk-pop__item", picker).forEach((item) => {
        const hit = item.dataset.value === value;
        item.setAttribute("aria-selected", String(hit));
        const check = $(".gk-pop__check", item);
        if (hit && !check) {
          item.insertAdjacentHTML("beforeend", '<svg class="ico ico--14 gk-pop__check" aria-hidden="true"><use href="#i-check" /></svg>');
        } else if (!hit && check) {
          check.remove();
        }
      });
      return;
    }
    const input = $(".gk-input", field);
    if (input) input.value = value;
  }

  function syncDirty() {
    const dirty = $$(".gk-field[data-dirty='true']");
    const save = $('[data-action="save-config"]');
    const hint = $("[data-config-dirty]");
    const banner = $("[data-config-banner]");
    const bannerText = $("[data-config-banner-text]");

    if (save) {
      save.disabled = dirty.length === 0;
      save.textContent = dirty.length > 0 ? `保存（${dirty.length} 项改动）` : "保存";
    }
    if (hint) hint.textContent = dirty.length === 0 ? "没有改动" : `未保存：${dirty.map(fieldLabel).join("、")}`;
    if (banner) banner.hidden = dirty.length === 0;
    if (bannerText) bannerText.textContent = dirty.length === 0 ? "" : `未保存：${dirty.map(fieldLabel).join("、")}`;
  }

  function markDirty(field) {
    if (!field) return;
    field.dataset.dirty = String(fieldValue(field) !== field.dataset.snapshot);
    syncDirty();
  }

  function closePickers() {
    $$(".gk-picker").forEach((picker) => {
      const btn = $(".gk-select", picker);
      const pop = $(".gk-pop", picker);
      if (btn) btn.setAttribute("aria-expanded", "false");
      if (pop) pop.hidden = true;
    });
  }

  function initConfig() {
    const panel = $(".gk-panel [data-field]");
    if (!panel) return;

    $$(".gk-field").forEach((field) => {
      field.dataset.snapshot = fieldValue(field);
    });

    $$('[data-action="toggle-switch"]').forEach((sw) => {
      const flip = () => {
        const field = sw.closest(".gk-field");
        sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
        markDirty(field);
      };
      on(sw, "click", flip);
      on(sw, "keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          flip();
        }
      });
    });

    $$(".gk-picker").forEach((picker) => {
      const btn = $(".gk-select", picker);
      const pop = $(".gk-pop", picker);
      on(btn, "click", (e) => {
        e.stopPropagation();
        const open = btn.getAttribute("aria-expanded") === "true";
        closePickers();
        if (!open) {
          btn.setAttribute("aria-expanded", "true");
          pop.hidden = false;
        }
      });
      on(pop, "click", (e) => {
        const item = e.target.closest(".gk-pop__item");
        if (!item) return;
        e.stopPropagation();
        setFieldValue(picker.closest(".gk-field"), item.dataset.value);
        closePickers();
        markDirty(picker.closest(".gk-field"));
      });
    });

    $$(".gk-field .gk-input").forEach((input) => {
      on(input, "input", () => markDirty(input.closest(".gk-field")));
    });

    on(document, "click", () => closePickers());
    on(document, "keydown", (e) => {
      if (e.key === "Escape") closePickers();
    });

    on($('[data-action="save-config"]'), "click", () => {
      const dirty = $$(".gk-field[data-dirty='true']");
      if (dirty.length === 0) return;
      dirty.forEach((field) => {
        field.dataset.snapshot = fieldValue(field);
        field.dataset.dirty = "false";
      });
      syncDirty();
      toast(`已写入 ${dirty.length} 个 preset；重启 DSH 后生效`);
    });

    on($('[data-action="reset-config"]'), "click", () => {
      let changed = 0;
      $$(".gk-field").forEach((field) => {
        const def = field.dataset.default;
        if (def !== undefined && fieldValue(field) !== def) {
          setFieldValue(field, def);
          changed += 1;
        }
        markDirty(field);
      });
      toast(changed > 0 ? `已恢复 ${changed} 项默认值` : "已经是默认值");
    });

    on($('[data-action="reload-config"]'), "click", () => {
      $$(".gk-field").forEach((field) => {
        setFieldValue(field, field.dataset.snapshot);
        field.dataset.dirty = "false";
      });
      syncDirty();
      toast("已重新读取配置");
    });

    syncDirty();
  }

  /* ── 其余动作 ──────────────────────────────────────────────────── */
  const PANEL_HREF = { compact: "gokifu-overview.html" };
  const PANEL_LABEL = { plugins: "插件", cron: "自动化任务" };

  function busy(btn, pending, done) {
    if (!btn) return done && done();
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = pending;
    window.setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
      if (done) done();
    }, 900);
  }

  function initActions() {
    $$("[data-panel]").forEach((row) => {
      on(row, "click", () => {
        const id = row.dataset.panel;
        if (PANEL_HREF[id]) {
          window.location.href = PANEL_HREF[id];
          return;
        }
        toast(`「${PANEL_LABEL[id] || id}」面板不在本仓范围内 —— 本仓只做上下文压缩`);
      });
    });

    const actions = {
      "toggle-sidebar": () => toggleSidebar(),
      "new-session": () => toast("新建会话：原型里不真的建会话"),
      settings: () => toast("设置面板：走 DSH 原生的 sidebar.settings 席位"),
      "crumb-workspace": () => toast("切换工作区：原型里只有一个工作区"),
      "pick-model": () => toast("模型目录走宿主的 ctx.remote.session.modelCatalog()"),
      refresh: (el) => busy(el, "…", () => toast("已刷新会话")),
      more: () => toast("更多：置顶 / 重命名 / 归档"),
      attach: () => toast("附件：走 dsh-client-file-upload"),
      permission: () => toast("权限预设：完全访问 / 只读 / 询问"),
      "backfill-provider": () => toast("补折 provider：跟随当前路由"),
      "backfill-model": () => toast("补折 model：跟随 provider / 当前路由"),
      "backfill-run": (el) => busy(el, "派发中…", () => toast("已派一个子代理去补折", "ok")),
      "check-update": (el) => {
        const text = $("[data-update-text]");
        busy(el, "检查中…", () => {
          if (text) text.textContent = "检查更新：已是最新（1.11.0）";
          toast("已是最新版本", "ok");
        });
      }
    };

    Object.keys(actions).forEach((name) => {
      $$(`[data-action="${name}"]`).forEach((el) => {
        if (el.dataset.bound === "true") return;
        el.dataset.bound = "true";
        on(el, "click", (e) => {
          e.preventDefault();
          actions[name](el, e);
        });
      });
    });
  }

  /* ── 全局快捷键 ───────────────────────────────────────────────── */
  function initShortcuts() {
    on(document, "keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const btn = $('[data-action="toggle-search"]');
        if (btn) btn.click();
      }
    });
  }

  /* ── 启动 ──────────────────────────────────────────────────────── */
  function init() {
    initTheme();
    resolveSidebar();
    // 首帧之后才开过渡，避免加载时侧栏从 280 动画到 56
    requestAnimationFrame(() => {
      const frame = $(".app-frame");
      if (frame) frame.setAttribute("data-animating", "");
    });

    let resizeTimer = 0;
    on(window, "resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (store.get("sidebar", null) === null) resolveSidebar();
      }, 120);
    });

    initTree();
    initComposer();
    initDisclosures();
    initConfig();
    initActions();
    initShortcuts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
