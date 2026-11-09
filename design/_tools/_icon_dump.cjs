/**
 * 从本机 DSH 安装的 app.asar 里取官方图标 SVG 路径。
 *
 * 用法： node design/_tools/_icon_dump.cjs IconPanelLeftOutlineRegular ...
 * 产物： design/_tools/_icons.json（{ 名称: { viewBox, paths[] } }）
 *
 * 为什么要走 asar：DSH Web GUI 的图标全部打包在
 *   dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js
 * 里（minified 的 React 产物），没有独立的 svg 文件可读。
 */
const fs = require("fs");
const path = require("path");
const asar = require("./asar.cjs");

const OUT = path.join(__dirname, "_icons.json");

const bundle = asar.find(/^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-.*\.js$/)[0];
if (!bundle) throw new Error("app.asar 里没有 dsh-web-frontend 的 index bundle");
const c = asar.readText(bundle.path);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 在导出表里找 "<Name>:<alias>" */
function aliasOf(name) {
  const m = c.match(new RegExp("(?<![A-Za-z0-9_$])" + esc(name) + ":([A-Za-z0-9_$]+)"));
  return m ? m[1] : null;
}

function balanced(i) {
  let depth = 0;
  for (let j = i; j < c.length; j++) {
    if (c[j] === "{") depth++;
    else if (c[j] === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return c.length;
}

/** 找到真正产出 <svg> 的那个基础组件（alias 只是包了一层 strokeWidth） */
function baseDef(base) {
  const re = new RegExp("(?<![A-Za-z0-9_$])" + esc(base) + "\\s*=", "g");
  let m;
  while ((m = re.exec(c))) {
    const start = m.index;
    if (!/jsxs?\("svg"/.test(c.slice(start, start + 400))) continue;
    const svgAt = c.indexOf('"svg"', start);
    return c.slice(start, balanced(c.indexOf("{", svgAt)));
  }
  return null;
}

const names = process.argv.slice(2);
const out = JSON.parse(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "{}");

for (const n of names) {
  const a = aliasOf(n);
  if (!a) {
    console.error("MISSING " + n);
    continue;
  }
  let base = a;
  for (let depth = 0; depth < 4; depth++) {
    const m = c.match(
      new RegExp(
        "(?<![A-Za-z0-9_$])" + esc(base) + "\\s*=\\s*[A-Za-z0-9_$]*\\s*=>\\s*[A-Za-z0-9_$.]*\\(\\s*([A-Za-z0-9_$]+)"
      )
    );
    if (!m) break;
    base = m[1];
    if (base === "svg" || base === "jsx" || base === "jsxs") break;
  }
  const def = baseDef(base);
  if (!def) {
    console.error("SVG NOT FOUND " + n);
    continue;
  }
  const vb = def.match(/viewBox:"([^"]+)"/);
  out[n] = {
    viewBox: vb ? vb[1] : "0 0 16 16",
    paths: [...def.matchAll(/d:"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1])
  };
  console.log(n + " => " + out[n].viewBox + " · " + out[n].paths.length + " paths");
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("written " + Object.keys(out).length + " icons -> " + OUT);
