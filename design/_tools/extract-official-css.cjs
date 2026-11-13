/**
 * 从本机 DSH 安装的 app.asar 里导出官方 Web GUI 的 CSS（设计令牌 + 组件样式）。
 *
 * 产物落在 tmp/design-official-css/（**派生内容，不进 git、不进包**）：
 *   design-platform.css   静态色板 + 别名层 + 深色覆盖（dsh-client-ui-theme）
 *   theme.css             :root 半径 / 缓动 / 字体栈 / 抬升 / 滚动条
 *   layout.css            AppFrame 三栏
 *   sidebar.css           侧边栏外壳
 *   workspace.css         工作区 / 会话行
 *   conversation.css      会话页头部 + 输入区
 *   chat.css              消息气泡 / 流式行
 *   *.pretty.css          上面各文件的换行版本（方便读）
 *
 * 用法： node design/_tools/extract-official-css.cjs
 */
const fs = require("fs");
const path = require("path");
const asar = require("./asar.cjs");

const OUT = path.resolve(__dirname, "..", "..", "tmp", "design-official-css");

const PKGS = [
  "dsh-client-ui-theme",
  "dsh-client-ui-layout",
  "dsh-client-ui-sidebar",
  "dsh-client-ui-workspace",
  "dsh-client-ui-conversation",
  "dsh-client-ui-chat",
  "dsh-client-ui-settings",
  "dsh-client-ui-plugin-manager",
  "dsh-client-ui-schedule",
  "dsh-client-ui-trajectory",
  "dsh-client-ui-jobs",
  "dsh-client-ui-goal",
  "dsh-client-ui-tool",
  "dsh-client-ui-sidebar-right"
];

fs.mkdirSync(OUT, { recursive: true });

for (const pkg of PKGS) {
  const src = asar.readText("dsh/node_modules/@deepseek-ai/" + pkg + "/lib/client.js");
  if (!src) {
    console.log("MISSING " + pkg);
    continue;
  }

  // 每段 `\0dsh-css:` / `\0dsh-inline-css:` 区域后面第一条 "..." 赋值就是该模块的样式表
  const sheets = [];
  for (const m of src.matchAll(/\\0dsh-(?:inline-)?css:/g)) {
    const tail = src.slice(m.index, m.index + 400000);
    const am = tail.match(/=\s*"((?:[^"\\]|\\.)*)";/);
    if (!am) continue;
    try {
      sheets.push(JSON.parse('"' + am[1] + '"'));
    } catch {
      /* 跳过转义异常的片段 */
    }
  }

  const name = pkg.replace(/^dsh-client-ui-/, "");
  const css = sheets.join("\n");
  fs.writeFileSync(path.join(OUT, name + ".css"), css, "utf8");
  fs.writeFileSync(path.join(OUT, name + ".pretty.css"), css.replaceAll("}", "}\n"), "utf8");
  console.log(name.padEnd(18) + sheets.length + " sheets · " + css.length + " B");
}

console.log("\n-> " + OUT);
