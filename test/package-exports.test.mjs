/**
 * package-exports.test.mjs —— OPT-EXPORTS：外部能不能真的 `import("dsh-gokifu-compact/graph")`
 *
 * 背景（P1-2 交付面断路）：README 让外部读者用 `fromJSON / decodeDeltaFrames / applyDelta` 读增量图，
 * 但只给了源码路径 `src/graph.mjs` —— 该门面在 A3 已被删除，且包 `exports` 没有 `./graph` 子路径。
 * 外部工具（复盘脚本、审计工具）按 README 写 `import` 会直接 ERR_PACKAGE_PATH_NOT_EXPORTED / 404。
 *
 * 本文件钉住四件事：
 *   ① `exports` 里有 `./graph` → `src/rooms/kifu-model.mjs`、`./persist` → `src/rooms/kifu-persist.mjs`，
 *      且原有 `.` / `./engine` / `./client` / `./package.json` / `./cordis.patch.yml` 一个不少；
 *   ② **真实安装形态**（临时 `node_modules/dsh-gokifu-compact`）下，两条子路径都能被 Node 解析并拿到预期导出；
 *   ③ 子路径入口与直接 import 源文件是**同一个实现**（防止 exports 指错文件却碰巧导出同名函数）；
 *   ④ README 里出现的每个 `src/**.mjs` 路径都真实存在 —— 不允许再写已删除的门面（如 `src/graph.mjs`）。
 *
 * 全程离线：临时目录 + 子进程 probe，不 npm install、不联网、不碰 live。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const PKG = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));

/** 新增/既有 exports 的期望值（写死在这里 = 变更时必须显式改测试）。 */
const EXPECTED_EXPORTS = {
  ".": { default: "./src/ui.mjs" },
  "./engine": "./src/engine.mjs",
  "./client": "./lib/client.js",
  "./graph": "./src/rooms/kifu-model.mjs",
  "./persist": "./src/rooms/kifu-persist.mjs",
  "./package.json": "./package.json",
  "./cordis.patch.yml": "./cordis.patch.yml",
};

/** graph 子路径必须能拿到的三个函数（README 第 70 行承诺的能力）。 */
const GRAPH_FNS = ["fromJSON", "decodeDeltaFrames", "applyDelta"];
/** persist 子路径必须能拿到的落盘侧入口。 */
const PERSIST_FNS = ["graphRoot", "sessionPaths", "createFsPort", "createPersistStore", "safeSessionId"];

const PROBE = `
const graph = await import("dsh-gokifu-compact/graph");
const persist = await import("dsh-gokifu-compact/persist");
const root = await import("dsh-gokifu-compact");
// 直接按绝对文件 URL 打开源文件（不能用包内子路径 —— exports 会挡未登记的子路径，那正是本测试要证明的）
const directGraph = await import(new URL("./node_modules/dsh-gokifu-compact/src/rooms/kifu-model.mjs", import.meta.url).href);
const directPersist = await import(new URL("./node_modules/dsh-gokifu-compact/src/rooms/kifu-persist.mjs", import.meta.url).href);
console.log(JSON.stringify({
  graphTypes: Object.fromEntries(${JSON.stringify(GRAPH_FNS)}.map((k) => [k, typeof graph[k]])),
  persistTypes: Object.fromEntries(${JSON.stringify(PERSIST_FNS)}.map((k) => [k, typeof persist[k]])),
  rootKeys: Object.keys(root).sort(),
  sameGraphRef: graph.fromJSON === directGraph.fromJSON,
  samePersistRef: persist.graphRoot === directPersist.graphRoot,
}));
`;

/** 造一个真实安装形态：<tmp>/node_modules/dsh-gokifu-compact/{package.json,src,lib,scripts}。 */
function makeInstall() {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-pkg-exports-"));
  const pkgDir = nodePath.join(dir, "node_modules", "dsh-gokifu-compact");
  nodeFs.mkdirSync(pkgDir, { recursive: true });
  for (const entry of ["src", "lib", "scripts"]) {
    nodeFs.cpSync(nodePath.join(ROOT, entry), nodePath.join(pkgDir, entry), { recursive: true });
  }
  for (const entry of ["package.json", "cordis.patch.yml"]) {
    nodeFs.copyFileSync(nodePath.join(ROOT, entry), nodePath.join(pkgDir, entry));
  }
  nodeFs.writeFileSync(nodePath.join(dir, "probe.mjs"), PROBE, "utf8");
  return { dir, pkgDir };
}

function runProbe(install) {
  const res = spawnSync(process.execPath, ["probe.mjs"], { cwd: install.dir, encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) {
    throw new Error(`probe 退出码 ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`probe 输出不是 JSON：${JSON.stringify(line?.slice(0, 300))} / ${String(error?.message ?? error)}`);
  }
}

export const tests = {};

tests["OPT-EXPORTS · package.json 的 exports 表：新增 ./graph 与 ./persist，既有条目一个不少"] = async () => {
  const got = PKG.exports ?? {};
  const gotKeys = Object.keys(got).sort();
  const wantKeys = Object.keys(EXPECTED_EXPORTS).sort();
  if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys)) {
    throw new Error(`exports 键集不符：\n  实际: ${gotKeys.join(", ")}\n  期望: ${wantKeys.join(", ")}`);
  }
  for (const [key, want] of Object.entries(EXPECTED_EXPORTS)) {
    const actual = got[key];
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(`exports[${key}] 不符：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`);
    }
  }
};

tests["OPT-EXPORTS · 每个 exports 目标文件都真实存在（含新加的两个）"] = async () => {
  const missing = [];
  for (const [key, target] of Object.entries(EXPECTED_EXPORTS)) {
    const rel = typeof target === "string" ? target : target.default;
    if (!nodeFs.existsSync(nodePath.join(ROOT, rel))) missing.push(`${key} → ${rel}`);
  }
  if (missing.length > 0) throw new Error(`exports 指向不存在的文件：\n  ${missing.join("\n  ")}`);
};

tests["OPT-EXPORTS · 真实安装形态：import(\"dsh-gokifu-compact/graph\") 拿到 fromJSON/decodeDeltaFrames/applyDelta"] = async () => {
  const install = makeInstall();
  try {
    const out = runProbe(install);
    for (const fn of GRAPH_FNS) {
      if (out.graphTypes[fn] !== "function") throw new Error(`/graph 缺函数 ${fn}（typeof=${out.graphTypes[fn]}）`);
    }
  } finally {
    nodeFs.rmSync(install.dir, { recursive: true, force: true });
  }
};

tests["OPT-EXPORTS · 真实安装形态：import(\"dsh-gokifu-compact/persist\") 拿到落盘侧入口"] = async () => {
  const install = makeInstall();
  try {
    const out = runProbe(install);
    for (const fn of PERSIST_FNS) {
      if (out.persistTypes[fn] !== "function") throw new Error(`/persist 缺函数 ${fn}（typeof=${out.persistTypes[fn]}）`);
    }
  } finally {
    nodeFs.rmSync(install.dir, { recursive: true, force: true });
  }
};

tests["OPT-EXPORTS · 子路径入口与源文件是同一实现（不是碰巧同名的另一份）"] = async () => {
  const install = makeInstall();
  try {
    const out = runProbe(install);
    if (out.sameGraphRef !== true) throw new Error(`/graph 没有指向 src/rooms/kifu-model.mjs（sameGraphRef=${out.sameGraphRef}）`);
    if (out.samePersistRef !== true) throw new Error(`/persist 没有指向 src/rooms/kifu-persist.mjs（samePersistRef=${out.samePersistRef}）`);
    if (!Array.isArray(out.rootKeys) || out.rootKeys.length === 0) throw new Error("包根入口 import 失败（rootKeys 为空）");
  } finally {
    nodeFs.rmSync(install.dir, { recursive: true, force: true });
  }
};

tests["OPT-EXPORTS · README 里出现的每个 src/**.mjs 路径都真实存在（不再指向已删门面）"] = async () => {
  const readme = nodeFs.readFileSync(nodePath.join(ROOT, "README.md"), "utf8");
  const paths = [...new Set([...readme.matchAll(/(?:^|[^A-Za-z0-9_./-])(src\/[A-Za-z0-9_./-]+\.mjs)/g)].map((m) => m[1]))];
  if (paths.length === 0) throw new Error("没从 README 里解析出任何 src/**.mjs 路径（断言会假绿）");
  const missing = paths.filter((rel) => !nodeFs.existsSync(nodePath.join(ROOT, rel)));
  if (missing.length > 0) throw new Error(`README 指向不存在的源码路径：${missing.join(", ")}（已删门面必须改成包入口）`);
  if (paths.includes("src/graph.mjs")) throw new Error("README 仍写着已删除的 src/graph.mjs，应改成 dsh-gokifu-compact/graph");
  if (!readme.includes("dsh-gokifu-compact/graph")) throw new Error("README 没有给出外部读图入口 dsh-gokifu-compact/graph");
};

tests["OPT-EXPORTS · 包 files 覆盖 src/（两个 exports 目标会真的被打进 tarball）"] = async () => {
  if (!Array.isArray(PKG.files) || !PKG.files.includes("src")) throw new Error("package.json files 未包含 src，exports 目标可能不进包");
  // exports 目标在 files 允许范围内且没有被 !src/.engine-under-test* 之类的排除规则命中
  for (const rel of [EXPECTED_EXPORTS["./graph"], EXPECTED_EXPORTS["./persist"]]) {
    const normalized = rel.replace(/^\.\//, "");
    if (!normalized.startsWith("src/")) throw new Error(`exports 目标不在 src/ 下：${rel}`);
    if (/\.engine-under-test/.test(normalized)) throw new Error(`exports 目标被包排除规则命中：${rel}`);
  }
};
