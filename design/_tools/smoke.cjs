/**
 * 静态冒烟测试 —— 没有浏览器也能拦住「CSS/JS 与标记脱节」这类回归。
 *
 * 起因：开关的白色拇指写在 .gk-switch__thumb 上，而 render.cjs 生成 .gk-switch 时
 * 忘了带上子元素，页面看着「能开」，其实是个纯蓝药丸。这类问题 TypeScript 不管、
 * 单测不管，只有对着真实 DOM 才看得见 —— 这里用一组结构断言代替。
 *
 * 用法： node design/_tools/smoke.cjs
 * 退出码：0 全绿 / 1 有失败
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES = ["dsh-shell.html", "gokifu-overview.html", "gokifu-folds.html", "gokifu-config.html"];

let failed = 0;
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  console.error("  ✗ " + name + (detail ? "  →  " + detail : ""));
  return false;
}

/** 粗略但要够用：数出现次数 */
const count = (html, re) => (html.match(re) || []).length;

const appSrc = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
const spriteSrc = fs.readFileSync(path.join(ROOT, "assets", "icons.svg"), "utf8");

/* ── 1 · app.js 里认识的动作 ──────────────────────────────────────── */
const knownActions = new Set();
// actions 表里的键可能是裸标识符（settings:）也可能带引号（"toggle-sidebar":）
const table = appSrc.slice(appSrc.indexOf("const actions = {"), appSrc.indexOf("Object.keys(actions)"));
for (const m of table.matchAll(/^\s{6}(?:"([a-z0-9-]+)"|([a-z][a-z0-9-]*))\s*:/gm)) {
  knownActions.add(m[1] || m[2]);
}
// 单独绑定的（不在 actions 表里，或由各自 init 处理）
[
  "toggle-ws",
  "toggle-tool",
  "toggle-fold",
  "toggle-switch",
  "open-picker",
  "toggle-search",
  "search",
  "send",
  "save-config",
  "reset-config",
  "reload-config"
].forEach((a) => knownActions.add(a));

/* ── 2 · sprite 里的图标 id ───────────────────────────────────────── */
const spriteIds = new Set([...spriteSrc.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));

for (const file of PAGES) {
  const full = path.join(ROOT, file);
  console.log("\n" + file);
  const html = fs.readFileSync(full, "utf8");

  /* 2.1 基本接线 */
  check("引用了 js/app.js", html.includes('src="js/app.js"'));
  check("引用了三份样式", ["css/tokens.css", "css/shell.css", "css/gokifu.css"].every((c) => html.includes(c)));
  check("带 data-page", /<html[^>]*data-page="[a-z]+"/.test(html));
  check("带 toast 容器", html.includes("data-toast-layer"));

  /* 2.2 图标引用都在 sprite 里 */
  const used = new Set([...html.matchAll(/#i-([a-z0-9-]+)/g)].map((m) => m[1]));
  const missingIcons = [...used].filter((id) => !spriteIds.has(id));
  check("图标 id 全部存在", missingIcons.length === 0, `缺 ${missingIcons.join(", ")}`);

  /* 2.3 data-action 都是 app.js 认识的 */
  const actions = [...new Set([...html.matchAll(/data-action="([a-z0-9-]+)"/g)].map((m) => m[1]))];
  const unknown = actions.filter((a) => !knownActions.has(a));
  check("data-action 全部有处理", unknown.length === 0, `未处理：${unknown.join(", ")}`);

  /* 2.4 侧边栏 */
  check("只有一个 .app-frame", count(html, /class="app-frame"/g) === 1);
  check("侧边栏有品牌行", html.includes("brand__mark") && html.includes("brand__name"));
  check("有 3 个全局面板行", count(html, /class="panel-row"/g) === 3);
  check("工作区行都有折叠箭头", count(html, /class="ws-row"/g) === count(html, /ws-row__chevron/g));
  check("工作区行都带 data-action=toggle-ws", count(html, /class="ws-row"/g) === count(html, /data-action="toggle-ws"/g));
  check("有搜索输入", html.includes("search-input"));
  check("外观三选一齐全", count(html, /data-theme-pick="/g) === 3, `找到 ${count(html, /data-theme-pick="/g)} 个`);
  check(
    "外观选项是 跟随系统/浅色/深色",
    ["system", "light", "dark"].every((t) => html.includes(`data-theme-pick="${t}"`))
  );

  /* 2.5 开关必须有白色拇指（这就是本次回归） */
  const switches = count(html, /class="gk-switch"/g);
  if (switches > 0) {
    check("开关都带拇指", switches === count(html, /gk-switch__thumb/g), `${switches} 个开关 / ${count(html, /gk-switch__thumb/g)} 个拇指`);
  }

  /* 2.6 配置字段 */
  const fields = count(html, /class="gk-field"/g);
  if (fields > 0) {
    check("字段都有 data-default", fields === count(html, /data-default="/g), `${fields} 字段 / ${count(html, /data-default="/g)} 个默认值`);
    check("字段都有 data-kind", fields === count(html, /data-kind="/g));
    check("字段都有 label", fields === count(html, /class="gk-field__label"/g));
  }

  /* 2.7 下拉 */
  const pickers = count(html, /class="gk-picker"/g);
  if (pickers > 0) {
    check("下拉都有 .gk-select", pickers === count(html, /class="gk-select"/g));
    check("下拉都有 .gk-pop", pickers === count(html, /class="gk-pop"/g));
    check("下拉都有选项", count(html, /class="gk-pop__item"/g) >= pickers);
  }

  /* 2.8 折痕 / 工具行 */
  const folds = count(html, /class="gk-fold"/g);
  if (folds > 0) {
    check("折痕都有 head", folds === count(html, /class="gk-fold__head"/g));
    check("折痕都有 detail", folds === count(html, /class="gk-fold__detail"/g));
  }
  const tools = count(html, /class="tool-row"/g);
  if (tools > 0) {
    check("工具行都有 head", tools === count(html, /class="tool-row__head"/g));
    check("工具行都有 body", tools === count(html, /class="tool-row__body"/g));
  }

  /* 2.9 输入框 */
  if (html.includes("data-composer")) {
    check("输入框可编辑", /contenteditable="true"[^>]*data-composer/.test(html) || /data-composer[^>]*contenteditable="true"/.test(html));
    check("发送按钮初始禁用", /class="composer__send"[^>]*disabled/.test(html));
  }

  /* 2.10 页面间跳转目标存在 */
  const hrefs = [...new Set([...html.matchAll(/href="([a-z0-9-]+\.html)"/g)].map((m) => m[1]))];
  const broken = hrefs.filter((h) => !fs.existsSync(path.join(ROOT, h)));
  check("页面跳转目标存在", broken.length === 0, `断链：${broken.join(", ")}`);
}

/* ── 3 · 样式文件里被引用的变量都有定义 ──────────────────────────── */
console.log("\ncss/");
const cssFiles = ["tokens.css", "shell.css", "gokifu.css"];
const cssAll = cssFiles.map((f) => fs.readFileSync(path.join(ROOT, "css", f), "utf8")).join("\n");
const defined = new Set([...cssAll.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
/** 这几个由宿主（DSH renderer / 内联样式）给：焦点环颜色、字体角色、字号、工作区缩进、进度条比率 */
const EXTERNAL = new Set([
  "--dsw-focus-ring-color",
  "--dsh-font-family-text",
  "--dsh-font-family-code",
  "--dsh-code-font-size",
  "--dsh-workspace-indent",
  "--ratio"
]);
const referenced = new Set([...cssAll.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
const undef = [...referenced].filter((v) => !defined.has(v) && !EXTERNAL.has(v));
check("var() 引用的令牌都有定义", undef.length === 0, `未定义：${undef.join(", ")}`);

/* ── 汇总 ──────────────────────────────────────────────────────── */
console.log("\n" + "-".repeat(52));
if (failed === 0) {
  console.log(`PASS  ${passed} 项断言全过`);
  process.exit(0);
}
console.log(`FAIL  ${failed} 项失败 / ${passed + failed} 项`);
process.exit(1);
