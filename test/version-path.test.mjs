/**
 * version-path.test.mjs —— S10′：host 侧 `readVersion()` 在「含中文 / 空格 / % 号」的路径下必须读到真实版本
 *
 * 为什么单独立文件：这条缺陷的症状极轻（页面标题显示 `v?`），根因却是**路径解码**——
 * `new URL(import.meta.url).pathname` 得到的是百分号编码串（`/D:/%E4%B8%BB%E5%B7%A5…`），
 * 在 Windows 上把盘符前的斜杠一剥，交给 `readFileSync` 就是 ENOENT；`readVersion()` 的
 * `catch` 把它吞成 `null`，页面 `v${state?.version ?? "?"}` 于是渲染成 `v?`。
 *
 * 本文件钉住四件事：
 *   ① 当前仓库（真实中文路径）下 `state.version` === `package.json` 的 `version`（**不硬编码版本号**）
 *   ② 模块被搬到「空格 + 非 ASCII」目录里，读到的必须是**那份** `package.json`（用派生值，不用字面量）
 *   ③ file URL 转换语义：`fileURLToPath` 还原、`pathname` 直读必失败 —— 附 ASCII 对照组，证明断言不是常量
 *   ④ `package.json` 缺失时仍返回 `null`（保持既有容错接口，不改成抛错）
 *
 * 复跑：`node test/run.mjs version-path`
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const REAL_PKG = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));

/** 非 ASCII 字符检测（用来校准「这台机器的仓库路径真的会触发编码」）。 */
function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(text);
}

/** 旧表达式：`new URL(...).pathname` 去掉 Windows 盘符前的斜杠（= 被修复的那一行）。 */
function oldExpressionPath(fileUrl) {
  return new URL(fileUrl).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

/** 造一份「引擎 host 半」最小副本：src/ui.mjs + scripts/{install,link-path}.mjs + package.json。 */
function makeFixture(options = {}) {
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-s10p-"));
  const dir = options.dirName ? nodePath.join(root, options.dirName) : root;
  nodeFs.mkdirSync(nodePath.join(dir, "src"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "scripts"), { recursive: true });
  for (const file of ["ui.mjs"]) {
    nodeFs.copyFileSync(nodePath.join(ROOT, "src", file), nodePath.join(dir, "src", file));
  }
  // ★ A2-1：ui.mjs 现在从 ./rooms/preset-format.mjs 取块格式 —— 夹具必须带上该房间文件，
  //   否则 ESM 解析在加载期就 ENOENT（本用例测的是 readVersion，不是包布局）。
  nodeFs.mkdirSync(nodePath.join(dir, "src", "rooms"), { recursive: true });
  nodeFs.copyFileSync(
    nodePath.join(ROOT, "src", "rooms", "preset-format.mjs"),
    nodePath.join(dir, "src", "rooms", "preset-format.mjs"),
  );
  for (const file of ["install.mjs", "link-path.mjs"]) {
    nodeFs.copyFileSync(nodePath.join(ROOT, "scripts", file), nodePath.join(dir, "scripts", file));
  }
  if (options.withPkg !== false) {
    const pkg = { ...REAL_PKG, version: options.version ?? REAL_PKG.version };
    nodeFs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  }
  return { root, dir, moduleFile: nodePath.join(dir, "src", "ui.mjs") };
}

/** 起一个假 ctx，拿到 host 路由，按 ui.test.mjs 的方式调一次 `{action:"state"}`。 */
async function callState(moduleFile) {
  const uiMod = await import(pathToFileURL(moduleFile).href);
  const routes = [];
  uiMod.apply({ webServer: { register: (route) => (routes.push(route), () => {}) }, effect: (fn) => fn() });
  if (routes.length !== 1) throw new Error(`应注册 1 条路由，得到 ${routes.length}`);
  const handler = routes[0].handler;
  const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-s10p-home-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await new Promise((resolve, reject) => {
      const req = {
        method: "POST",
        // 2026-10-30 CSRF 加固：POST 必须带 JSON content-type + 回环 Host（同 lib/client.js 的真机请求形状）。
        headers: { host: "127.0.0.1:19387", "content-type": "application/json" },
        on: (event, cb) => {
          if (event === "data") cb(Buffer.from(JSON.stringify({ action: "state" })));
          if (event === "end") cb();
        },
      };
      const res = {
        status: 0,
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          resolve({ status: this.status, json: JSON.parse(text) });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

function tempRoot() {
  return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-s10p-url-"));
}

export const tests = {
  "readVersion：当前仓库（真实中文路径）下 state.version === package.json 的 version": async (t) => {
    // 校准（条件式，避免在 ASCII 检出上假红）：本机仓库路径含非 ASCII 时，旧表达式拿到的必然是百分号编码串。
    // 判别力兜底不靠这条：下面第 2 个用例**自己造**「空格 + 非 ASCII」目录，任何检出上都判得红旧实现。
    if (hasNonAscii(ROOT)) {
      t.includes(oldExpressionPath(pathToFileURL(ROOT).href), "%", "含非 ASCII 的仓库路径在旧表达式下必然残留百分号编码");
    }
    t.ok(typeof REAL_PKG.version === "string" && REAL_PKG.version.length > 0, "package.json 应有非空 version");

    const state = await callState(nodePath.join(ROOT, "src", "ui.mjs"));
    t.eq(state.status, 200, "state 状态码");
    t.eq(state.json.ok, true, "state.ok");
    t.eq(state.json.version, REAL_PKG.version, "页面版本必须等于 package.json 的 version（不是 null / 不是 v?）");
    t.ne(state.json.version, null, "version 不得为 null");
  },

  "readVersion：模块位于「空格 + 非 ASCII」目录时，读到的是该目录那份 package.json": async (t) => {
    // 派生值，不写字面量版本号：把真实版本加后缀写进副本，断言读到的是副本里的那个值
    const fixtureVersion = `${REAL_PKG.version}-pathfix`;
    const { root, dir, moduleFile } = makeFixture({ dirName: "含 空格 与 中文-üñî-目录", version: fixtureVersion });
    try {
      t.ok(hasNonAscii(dir), `夹具目录应含非 ASCII：${dir}`);
      t.ok(dir.includes(" "), `夹具目录应含空格：${dir}`);
      // 校准：该路径确实需要百分号编码（空格 → %20、中文 → %E4…）
      const href = pathToFileURL(moduleFile).href;
      t.includes(oldExpressionPath(href), "%20", "旧表达式输入应含 %20（空格被编码）");
      t.eq(nodeFs.existsSync(oldExpressionPath(href)), false, "旧表达式在该路径上读不到文件（根因）");

      const state = await callState(moduleFile);
      t.eq(state.status, 200, "state 状态码");
      t.eq(state.json.version, fixtureVersion, "必须读到副本那份 package.json 的版本");
      t.eq(nodePath.resolve(fileURLToPath(pathToFileURL(moduleFile))), nodePath.resolve(moduleFile), "副本模块路径可经 fileURLToPath 往返");
      t.eq(nodeFs.existsSync(moduleFile), true, "副本模块实际存在");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  },

  "file URL 转换：空格 / 非 ASCII / % 号经 fileURLToPath 还原；pathname 直读必失败（ASCII 对照组成功）": (t) => {
    // 对照组：纯 ASCII 路径 —— 旧表达式与 fileURLToPath 归一后必须等价。
    // 只比转换结果、不要求该路径存在，因此不受本机 tmpdir 形态影响（本机 tmpdir 是 8.3 短名 ADMINI~1，
    // `~` 会被编码成 %7E —— 连「纯 ASCII 的临时目录」都会踩同一个坑，不能拿来当对照组）。
    const plain = "C:/s10p-ascii/plain/package.json";
    const plainUrl = pathToFileURL(plain);
    t.eq(nodePath.resolve(oldExpressionPath(plainUrl.href)), nodePath.resolve(fileURLToPath(plainUrl)), "ASCII 对照组：两种写法必须等价（否则下面的失败没有判别力）");

    const root = tempRoot();
    try {
      const fixture = { version: "s10p-fixture" };
      const cases = [
        nodePath.join(root, "s10p 空格 目录", "package.json"),
        nodePath.join(root, "s10p-100% 号", "package.json"),
        nodePath.join(root, "s10p-日本語-üñî", "package.json"),
      ];
      for (const real of cases) {
        nodeFs.mkdirSync(nodePath.dirname(real), { recursive: true });
        nodeFs.writeFileSync(real, JSON.stringify(fixture), "utf8");
        const url = pathToFileURL(real);
        const converted = fileURLToPath(url);
        t.eq(nodePath.resolve(converted), nodePath.resolve(real), `fileURLToPath 应还原真实路径：${real}`);
        t.eq(JSON.parse(nodeFs.readFileSync(converted, "utf8")).version, fixture.version, `经 fileURLToPath 应能读到内容：${real}`);
        // 旧表达式在这三种路径上必然指不到真实文件（百分号编码 vs 真实文件名）
        t.ne(nodePath.resolve(oldExpressionPath(url.href)), nodePath.resolve(converted), `旧表达式与真实路径不应等价：${real}`);
        t.eq(nodeFs.existsSync(oldExpressionPath(url.href)), false, `旧表达式应读不到：${real}`);
        t.includes(oldExpressionPath(url.href), "%", `旧表达式输出应残留百分号编码：${real}`);
      }
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  },

  "readVersion：package.json 缺失时返回 null（既有容错接口不变，不改成抛错）": async (t) => {
    const { root, moduleFile } = makeFixture({ withPkg: false });
    try {
      const state = await callState(moduleFile);
      t.eq(state.status, 200, "缺 package.json 时路由仍应 200（只降级版本号）");
      t.eq(state.json.version, null, "读不到 package.json 时 version 应为 null");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  },
};
