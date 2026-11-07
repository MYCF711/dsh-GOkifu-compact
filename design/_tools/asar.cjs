/**
 * 读本机 DSH 安装目录里的 app.asar（Electron 私有容器）。
 *
 * 为什么不用现成库：仓库不带依赖，而 asar 头只有 16 字节，自己解比引三方便宜。
 *   uint32[0] = 4
 *   uint32[1] = headerSize      ← 头部长（含 8 字节对齐）
 *   uint32[2] = headerSize
 *   uint32[3] = jsonSize        ← 头 JSON 的字节数
 *   JSON 从 offset 16 开始，文件内容从 8 + headerSize 开始
 */
const fs = require("fs");
const path = require("path");

/**
 * 定位本机 DSH 安装目录里的 app.asar。
 *
 * **不写死任何人的本机路径**（仓库要能在别人机器上跑）。顺序：
 *   1. `DSH_APP_ASAR` 环境变量（显式指定，最优先）
 *   2. 从 `DSH_HOME` / `DSH_INSTALL_DIR` / 当前目录 逐级向上找 `<某级>/resources/app.asar`
 *   3. 都没有 ⇒ 抛错并告诉你怎么设，**不猜**
 */
function resolveAsar() {
  const explicit = process.env.DSH_APP_ASAR;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const roots = [process.env.DSH_INSTALL_DIR, process.env.DSH_HOME, process.cwd()].filter(
    (value) => typeof value === "string" && value !== "",
  );
  for (const root of roots) {
    let dir = path.resolve(root);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(dir, "resources", "app.asar");
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "找不到 app.asar：请设 DSH_APP_ASAR 指向 <DSH 安装目录>/resources/app.asar" +
      "（例如 macOS 的 /Applications/DeepSeek Harness.app/Contents/Resources/app.asar）",
  );
}

const ASAR = resolveAsar();

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(ASAR)) throw new Error("找不到 app.asar：" + ASAR);
  const buf = fs.readFileSync(ASAR);
  const headerSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const base = 8 + headerSize;
  const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonSize));

  const entries = [];
  (function walk(o, pfx) {
    for (const name of Object.keys(o)) {
      const val = o[name];
      const p = pfx ? pfx + "/" + name : name;
      if (val.files) walk(val.files, p);
      else entries.push({ path: p, offset: Number(val.offset), size: val.size });
    }
  })(header.files, "");

  cache = { buf, base, entries, byPath: new Map(entries.map((e) => [e.path, e])) };
  return cache;
}

/** 按 asar 内路径读文本；不存在返回 undefined */
function readText(entryPath) {
  const { buf, base, byPath } = load();
  const e = byPath.get(entryPath);
  if (!e) return undefined;
  return buf.toString("utf8", base + e.offset, base + e.offset + e.size);
}

/** 按前缀/正则找条目 */
function find(re) {
  return load().entries.filter((e) => re.test(e.path));
}

module.exports = { ASAR, readText, find, load };
