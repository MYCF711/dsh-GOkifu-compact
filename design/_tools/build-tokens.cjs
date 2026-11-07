/**
 * 生成 design/css/tokens.css —— **官方令牌逐字搬运，不手抄**。
 *
 * 为什么生成：手抄会漂。第一版我按官方深色块逐条誊，漏了十几条
 * （`--dsw-alias-button-elevated-fill`、`--dsw-alias-link`、`--dsw-specific-bubble-highlight` …），
 * 深色下输入框和按钮就是白的。生成之后「漏」这件事不可能再发生。
 *
 * 来源：@deepseek-ai/dsh-client-ui-theme/lib/client.js 里的
 *       `\0dsh-inline-css:` / `\0dsh-css:` 区域（与官方 dist 完全一致）。
 *
 * 用法： node design/_tools/build-tokens.cjs
 */
const fs = require("fs");
const path = require("path");
const { readText } = require("./asar.cjs");

const SOURCE = "dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";
const OUT = path.resolve(__dirname, "..", "css", "tokens.css");

const src = readText(SOURCE);
if (!src) throw new Error("app.asar 里找不到 " + SOURCE);

/** 抽出每段内联 CSS（区域后面第一条 "..." 赋值） */
const sheets = [];
for (const m of src.matchAll(/\\0dsh-(?:inline-)?css:/g)) {
  const tail = src.slice(m.index, m.index + 400000);
  const am = tail.match(/=\s*"((?:[^"\\]|\\.)*)";/);
  if (!am) continue;
  try {
    sheets.push(JSON.parse('"' + am[1] + '"'));
  } catch {
    /* 转义异常的片段跳过 */
  }
}
if (sheets.length === 0) throw new Error("没抽到任何样式表，asar 结构可能变了");

/**
 * 深色：官方只有 `body[data-ds-dark-theme]` 一条通道（由 renderer 按设置写属性）。
 * 这里**同值镜像**一份 `@media (prefers-color-scheme: dark)`：
 *   · 渐进增强 —— 关掉 JS 也跟随系统；
 *   · 让验收工具能真的量到深色（它只认 media query）。
 * 显式选过浅色时 JS 会写 `data-theme="light"`，镜像块即被排除。
 */
function mirrorDark(css) {
  const rules = [...css.matchAll(/body\[data-ds-dark-theme\]\s*\{([^}]*)\}/g)];
  if (rules.length === 0) return "";
  const inner = rules.map((r) => "  html:not([data-theme='light']) body:not([data-ds-dark-theme]){" + r[1] + "}").join("\n");
  return (
    "\n/* ── 深色镜像（同值；给无 JS 与验收工具用）────────────────────────── */\n" +
    "@media (prefers-color-scheme: dark) {\n" +
    inner +
    "\n}\n"
  );
}

const official = sheets.join("\n");

const banner = `/* =============================================================================
 * ⚠ 这个文件是生成的，不要手改。
 *   源头：@deepseek-ai/dsh-client-ui-theme/lib/client.js（本机 DSH 安装里的 app.asar）
 *   重生成：node design/_tools/build-tokens.cjs
 *
 * 内容 = 官方「设计平台」样式表的原样拼接：
 *   静态色板 → 别名层（浅色）→ 深色覆盖 → 半径 / 缓动 / 字体栈 → 抬升 → 滚动条 → 内容字号。
 * 文件末尾「本仓补充」之后才是手写的（基础重置 + 宿主默认值）。
 * ========================================================================== */

`;

const footer = `
/* ══════════════════════════════════════════════════════════════════════════
 * 本仓补充（手写）
 * 上面全部是官方原样；下面只补「官方在运行期注入、静态文件里没有」的那几个，
 * 以及给设计稿用的最小基础重置。
 * ════════════════════════════════════════════════════════════════════════ */

/* 宿主 renderer 会写 --dsh-font-family-text / -code；静态稿给默认值 */
:root {
  --dsh-font-family-text-default: -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
    Helvetica, Arial, sans-serif;
  --dsh-font-family-code-default: "SF Mono", "JetBrains Mono", "Fira Code",
    Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
}

body {
  --dsw-font-family: var(--dsh-font-family-text, var(--dsh-font-family-text-default)), var(--dsh-font-family-text-default);
  --ds-font-family-code: var(--dsh-font-family-code, var(--dsh-font-family-code-default)), var(--dsh-font-family-code-default);

  /* 内容字号：宿主按设置写，静态稿固定 14px，派生量随之算 */
  --dsh-content-font-size: 14px;
  --dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);
  --dsh-content-font-size-secondary: min(
    calc(var(--dsh-content-font-size, 14px) - 1px),
    max(13px, calc(var(--dsh-content-font-size, 14px) - 2px))
  );

  /* 框架间距（ui-layout 运行期写；普通浏览器文档不发布，这里给 0） */
  --dsh-frame-top-clearance: 0px;
  --dsh-frame-overlay-top: 20px;
}

/* ── 基础重置 ─────────────────────────────────────────────────────── */
* { box-sizing: border-box; }

html,
body {
  height: 100%;
  margin: 0;
}

body {
  font-family: var(--dsw-font-family);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

button { font-family: inherit; }
a { color: var(--dsw-alias-link); }

:focus-visible {
  outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-width: var(--dsw-focus-ring-width, 2px);
  outline-style: solid;
  outline-offset: 2px;
}

/* 官方 base 里没给做兜底（只有 scrollbar-width:thin 分支），这里补全 */
@supports not selector(::-webkit-scrollbar) {
  body,
  body * {
    scrollbar-width: thin;
    scrollbar-color: var(--dsh-scrollbar-thumb) transparent;
  }
}
`;

const css = banner + official + mirrorDark(official) + footer;
fs.writeFileSync(OUT, css, "utf8");
console.log("tokens.css  " + sheets.length + " sheets · " + Buffer.byteLength(css) + " B");
