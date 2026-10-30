/**
 * install-link.test.mjs —— 安装 link 路径与挂载校验的回归矩阵（S10a）
 *
 * 为什么要有这个文件：这两个缺陷都是**假绿**性质，靠「跑一遍说全过」永远发现不了。
 * 所以这里同时放正例与负例，并且负例必须真的变红 —— 断言不许是常量。
 *
 *   正例：存在的真实目录 / 中文+空格 / 大小写不同 / 相对与绝对 / junction / 复制安装
 *   负例（必须红）：目标不存在 / 包名不符 / node_modules 指向别处 / 断链 / 规格是版本号但没有实装
 *   生成端：已有键但指错目录 → 安装器必须改写；错向 junction → 必须重建；dry-run 不写盘
 *   一致性：安装后立刻校验必须全绿（两个修复不能各自为政）
 *
 * 全部夹具都在 os.tmpdir() 下（与 test/ui.test.mjs 同一约定），只把假 DSH_HOME 指过去；
 * 真 profile 一次也不碰。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSpec, resolveSpecPath, inspectSpec, statLink, samePath, createDirLink, removeDirLink, inspectProfileInstall, toLinkSpec } from "../scripts/link-path.mjs";
import { run as runInstall, PROJECT_DIR } from "../scripts/install.mjs";
import { verifyInstall } from "./verify-install.mjs";

const WIN = process.platform === "win32";
const PKG = "dsh-gokifu-compact";
const PRESET = "personal-assistant";
const MI = "0.2.0-rc.2";
const REPO_DIR = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));

export const tests = {};

/* ───────────────────────── 夹具 ───────────────────────── */

function rmrf(p) {
  if (p && nodeFs.existsSync(p)) nodeFs.rmSync(p, { recursive: true, force: true });
}

function mkTempRoot(label) {
  return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-install-${label}-`));
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

function writePkg(dir, { name = PKG, main = "src/ui.mjs" } = {}) {
  write(nodePath.join(dir, "package.json"), JSON.stringify({
    name,
    version: "9.9.9-fixture",
    main,
    peerDependencies: {
      "@deepseek-ai/dsh-compaction-basic": MI,
      "@deepseek-ai/dsh-compaction": MI,
      "@deepseek-ai/dsh-llm": MI,
      "@deepseek-ai/dsh-session": MI,
      "@deepseek-ai/schemastery": "^3.18.4",
    },
  }, null, 2) + "\n");
  write(nodePath.join(dir, main), "export const fixture = true;\n");
}

const PRESET_YML = [
  "plugins:",
  "  - group: true",
  "    isolate:",
  "      compaction: true",
  "      toolResultPruner: true",
  "    config:",
  "      - id: gokifu-compact",
  `        name: '${PKG}/engine'`,
  "        config:",
  "          auto: true",
  "      - id: command-compact",
  "        name: 'dsh-command-compact'",
  "      - id: tool-result-pruner",
  "        name: 'dsh-compaction-tool-result-pruner'",
  "",
].join("\n");

/**
 * 造一个假 DSH_HOME：profiles/desktop + preset-bundles/personal-assistant + 运行期证据 + 一个包源目录。
 * @returns {{home:string, profileDir:string, pkgSrc:string, spec:string, cleanup:()=>void}}
 */
function makeHome(label, { deps } = {}) {
  const home = mkTempRoot(label);
  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
  write(nodePath.join(profileDir, "cordis.patch.yml"), "# fixture profile patch\n");
  write(nodePath.join(home, "preset-bundles", PRESET, "cordis.patch.yml"), PRESET_YML);
  write(nodePath.join(home, "chess-context", "sessions", "fixture-session", "graph.json"), "{}\n");
  const pkgSrc = nodePath.join(home, "pkg-src");
  writePkg(pkgSrc);
  const spec = toLinkSpec(pkgSrc);
  const dependencies = deps === undefined ? { [PKG]: spec } : deps;
  write(nodePath.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-fixture",
    private: true,
    ...(dependencies === null ? {} : { dependencies }),
  }, null, 2) + "\n");
  return { home, profileDir, pkgSrc, spec, cleanup: () => rmrf(home) };
}

function readDeps(profileDir) {
  return JSON.parse(nodeFs.readFileSync(nodePath.join(profileDir, "package.json"), "utf8")).dependencies ?? {};
}

function setDeps(profileDir, deps) {
  const file = nodePath.join(profileDir, "package.json");
  const pkg = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  pkg.dependencies = deps;
  nodeFs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function linkDest(profileDir) {
  return nodePath.join(profileDir, "node_modules", PKG);
}

/** 跑安装器（隔离到假 home，收集日志）。 */
function installVerbose(home, extra = []) {
  const log = [];
  const orig = console.log;
  console.log = (...m) => log.push(m.join(" "));
  try {
    const code = runInstall(["--home", home, "--profile", "desktop", "--preset", PRESET, ...extra]);
    return { code, log: log.join("\n") };
  } finally {
    console.log = orig;
  }
}

/** 取校验结果里某条检查。 */
function checkNamed(result, fragment) {
  return result.checks.find((c) => c.name.includes(fragment));
}

function withHome(label, options, fn) {
  const fixture = makeHome(label, options);
  try {
    fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

/* ───────────────────────── A · 解析层 ───────────────────────── */

tests["A1 存在的真实目录：link: 绝对路径解析到同一个真实目标"] = (t) => {
  withHome("a1", {}, ({ pkgSrc, spec }) => {
    const s = inspectSpec(spec, "/unused-base");
    t.ok(s.kind === "link", `协议应为 link，实际 ${s.kind}`);
    t.ok(s.ok, `目标应存在：${s.path}`);
    t.ok(s.target.isDirectory, "目标应是目录");
    t.eq(s.target.packageName, PKG, "包名");
    t.ok(samePath(s.target.realPath, pkgSrc), "realpath 应等于夹具目录");
  });
};

tests["A2 不存在的目标：解析为「目标不存在」（负例的基本面）"] = (t) => {
  withHome("a2", {}, ({ home }) => {
    const missing = `${toLinkSpec(nodePath.join(home, "projects", "dsh-gokifu-compact"))}`;
    const s = inspectSpec(missing, home);
    t.eq(s.kind, "link", "协议");
    t.ok(!s.target.exists, "不应判为目标存在");
    t.ok(!s.ok, "不应判为可解析");
    t.eq(s.target.packageName, null, "读不到包名时必须是 null，不能伪造");
  });
};

tests["A3 Windows 大小写差异：同一真实目录，不许造出假 RED"] = (t) => {
  if (!WIN) {
    console.log("    (跳过：本机非 Windows，大小写敏感，差异本来就该判不同)");
    return;
  }
  withHome("a3", {}, ({ pkgSrc, spec }) => {
    const upper = toLinkSpec(pkgSrc).replace(/pkg-src$/, "PKG-Src").replace(/^link:([a-z]):/, (m, d) => `link:${d.toUpperCase()}:`);
    const s = inspectSpec(upper, "/unused");
    t.ok(s.ok, `大小写不同也应解析成功：${upper}`);
    t.ok(samePath(s.target.realPath, pkgSrc), "realpath 应规范化到同一目录");
    t.ok(samePath(spec, upper), "两个规格应判为同一路径");
  });
};

tests["A4 中文 + 空格目录：可解析、可当安装源、包名可读"] = (t) => {
  const home = mkTempRoot("a4");
  try {
    const dir = nodePath.join(home, "源 中文 空格", "真·包");
    writePkg(dir);
    const s = inspectSpec(toLinkSpec(dir), home);
    t.ok(s.ok, `中文空格目录应可解析：${s.path}`);
    t.eq(s.target.packageName, PKG, "包名");
    t.eq(s.path, dir, "解析出的路径应与原路径一致");
  } finally {
    rmrf(home);
  }
};

tests["A5 相对 link: 按 profile 目录解析（pnpm 契约）"] = (t) => {
  withHome("a5", {}, ({ home, profileDir, pkgSrc }) => {
    const rel = "link:" + nodePath.relative(profileDir, pkgSrc).replace(/\\/g, "/");
    const s = inspectSpec(rel, profileDir);
    t.ok(s.ok, `相对路径应解析成功：${rel}`);
    t.ok(samePath(s.target.realPath, pkgSrc), "相对与绝对应落到同一目录");
    t.ok(!nodePath.isAbsolute(parseSpec(rel).pathText), "夹具本身应是相对形式");
    // 同样一条相对串，从别的 baseDir 解析就是别的地方 —— 证明 baseDir 参与了解析
    const other = inspectSpec(rel, home);
    t.ok(!samePath(other.path, pkgSrc), "换 baseDir 不应解析到同一处");
  });
};

tests["A6 file: 与 link: 同义；版本号归 registry（不是本地链接）"] = (t) => {
  t.eq(parseSpec("link:D:/x").kind, "link", "link");
  t.eq(parseSpec("file:./x").kind, "file", "file");
  t.eq(parseSpec("portal:D:/x").kind, "other", "portal 不收（语义不同）");
  t.eq(parseSpec("1.9.1").kind, "other", "版本号");
  t.eq(parseSpec("^1.9.1").kind, "other", "范围版本");
  t.eq(parseSpec("").kind, "empty", "空串");
  t.eq(parseSpec("link:").kind, "empty", "link: 后面没有路径");
  t.ok(parseSpec(null).kind === "empty", "非字符串按空处理");
};

tests["A7 MSYS 风格 /d/… 在 Windows 上按 D:/… 解析（不许变成 D:\\d\\…）"] = (t) => {
  if (!WIN) {
    console.log("    (跳过：本机非 Windows)");
    return;
  }
  const got = resolveSpecPath("/d/主工作区/projects", "E:\\base");
  t.eq(got, "D:\\主工作区\\projects", "盘符形式");
};

tests["A8 toLinkSpec：绝对路径 + 正斜杠（写回 package.json 的既有契约）"] = (t) => {
  const spec = toLinkSpec("D:\\主工作区\\projects\\x");
  t.eq(spec, "link:D:/主工作区/projects/x", "形式");
  t.ok(!spec.includes("\\"), "不许留反斜杠");
  t.ok(nodePath.isAbsolute(spec.slice("link:".length)), "路径部分必须是绝对路径");
};

/* ───────────────────────── B · 链接层 ───────────────────────── */

tests["B1 junction：创建 / 识别 / 定向 / 删除，且不动目标内容"] = (t) => {
  const home = mkTempRoot("b1");
  try {
    const target = nodePath.join(home, "源 中文 空格", "目标");
    write(nodePath.join(target, "keep.txt"), "keep\n");
    const dest = nodePath.join(home, "链接 dest");
    let how;
    try {
      how = createDirLink(target, dest);
    } catch (error) {
      // 权限不允许时明确跳过（本机实测不需要管理员，这里只是兜底）
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
        console.log(`    (跳过：本机不允许建目录链接 ${error.code})`);
        return;
      }
      throw error;
    }
    t.ok(how === "junction" || how === "mklink", `创建方式：${how}`);
    const st = statLink(dest);
    t.ok(st.present, "目录项应存在");
    t.ok(st.isLink, "应识别为链接（不是实目录）");
    t.ok(st.targetExists, "目标应可达");
    t.ok(samePath(st.realPath, target), "realpath 应指向目标");
    t.eq(nodeFs.readFileSync(nodePath.join(dest, "keep.txt"), "utf8"), "keep\n", "经链接应能读到目标内容");
    t.ok(removeDirLink(dest), "应能删掉链接");
    t.ok(!statLink(dest).present, "删后目录项应消失");
    t.ok(nodeFs.existsSync(nodePath.join(target, "keep.txt")), "目标内容不许被删");
  } finally {
    rmrf(home);
  }
};

tests["B2 断链：目录项在、目标不在 —— 必须能与「没有」区分开"] = (t) => {
  if (!WIN) {
    console.log("    (跳过：夹具用 junction，本机非 Windows)");
    return;
  }
  const home = mkTempRoot("b2");
  try {
    const dest = nodePath.join(home, "断链");
    nodeFs.symlinkSync(nodePath.join(home, "不存在"), dest, "junction");
    const st = statLink(dest);
    t.ok(st.present, "目录项应存在（lstat 能看见）");
    t.ok(st.isLink, "应识别为链接");
    t.ok(!st.targetExists, "目标不存在");
    t.eq(st.realPath, null, "realpath 应为 null");
    t.ok(nodeFs.existsSync(dest) === false, "existsSync 跟随链接时为 false —— 所以不能用它判「有没有」");
    t.ok(removeDirLink(dest), "断链应可删");
  } finally {
    rmrf(home);
  }
};

tests["B3 removeDirLink 拒绝删真实目录（防误删源码）"] = (t) => {
  const home = mkTempRoot("b3");
  try {
    const real = nodePath.join(home, "真目录");
    write(nodePath.join(real, "f.txt"), "x");
    t.ok(!removeDirLink(real), "真实目录不应被删除");
    t.ok(nodeFs.existsSync(nodePath.join(real, "f.txt")), "内容应完好");
  } finally {
    rmrf(home);
  }
};

/* ───────────────────────── C · 安装器（生成端） ───────────────────────── */

tests["C1 已有键但指向不存在的目录 → 安装器必须改写（旧代码在这里「已存在，跳过」）"] = (t) => {
  const fixture = makeHome("c1");
  const stale = `link:${nodePath.join(fixture.home, "projects", "dsh-gokifu-compact").replace(/\\/g, "/")}`;
  setDeps(fixture.profileDir, { [PKG]: stale });
  try {
    const { code, log } = installVerbose(fixture.home);
    t.eq(code, 0, `安装器应成功\n${log}`);
    const now = readDeps(fixture.profileDir)[PKG];
    t.eq(now, toLinkSpec(PROJECT_DIR), "依赖声明应被改写成真实项目目录");
    t.ok(nodeFs.existsSync(PROJECT_DIR), "改写后的目标必须真实存在");
    t.ok(inspectSpec(now, fixture.profileDir).ok, "改写后必须可解析");
    t.ok(samePath(statLink(linkDest(fixture.profileDir)).realPath, PROJECT_DIR), "junction 应指向真实项目目录");
    const backups = nodeFs.readdirSync(fixture.profileDir).filter((f) => f.startsWith("package.json.bak-before-gokifu-"));
    t.ok(backups.length === 1, `应留 1 份备份，实际 ${backups.length}`);
    t.ok(log.includes("已修"), `日志应说明「已修」：\n${log}`);
  } finally {
    fixture.cleanup();
  }
};

tests["C2 node_modules 指着别的目录 → 安装器必须重建链接"] = (t) => {
  const fixture = makeHome("c2");
  try {
    const wrongTarget = nodePath.join(fixture.home, "别的目录");
    writePkg(wrongTarget, { name: "not-our-package" });
    createDirLink(wrongTarget, linkDest(fixture.profileDir));
    t.ok(!samePath(statLink(linkDest(fixture.profileDir)).realPath, fixture.pkgSrc), "前置：链接应指向别处");
    const { code, log } = installVerbose(fixture.home);
    t.eq(code, 0, `安装器应成功\n${log}`);
    t.ok(samePath(statLink(linkDest(fixture.profileDir)).realPath, PROJECT_DIR), "链接应被重建到真实项目目录");
    t.ok(log.includes("重建"), `日志应说明「重建」：\n${log}`);
    t.ok(nodeFs.existsSync(nodePath.join(wrongTarget, "package.json")), "被换掉的旧目标目录不许被删");
  } finally {
    fixture.cleanup();
  }
};

tests["C3 断链 → 安装器必须重建（不能因为 existsSync=false 就报 EEXIST）"] = (t) => {
  if (!WIN) {
    console.log("    (跳过：夹具用 junction，本机非 Windows)");
    return;
  }
  const fixture = makeHome("c3");
  try {
    nodeFs.symlinkSync(nodePath.join(fixture.home, "不存在"), linkDest(fixture.profileDir), "junction");
    const { code, log } = installVerbose(fixture.home);
    t.eq(code, 0, `安装器应成功\n${log}`);
    t.ok(samePath(statLink(linkDest(fixture.profileDir)).realPath, PROJECT_DIR), "断链应被重建为真链接");
  } finally {
    fixture.cleanup();
  }
};

tests["C4 dry-run：一个字节都不写（预设/依赖/链接/备份）"] = (t) => {
  const fixture = makeHome("c4");
  const stale = `link:${nodePath.join(fixture.home, "projects", "dsh-gokifu-compact").replace(/\\/g, "/")}`;
  setDeps(fixture.profileDir, { [PKG]: stale });
  try {
    const beforePkg = nodeFs.readFileSync(nodePath.join(fixture.profileDir, "package.json"), "utf8");
    const beforeProfilePatch = nodeFs.readFileSync(nodePath.join(fixture.profileDir, "cordis.patch.yml"), "utf8");
    const beforePreset = nodeFs.readFileSync(nodePath.join(fixture.home, "preset-bundles", PRESET, "cordis.patch.yml"), "utf8");
    const { code, log } = installVerbose(fixture.home, ["--dry-run"]);
    t.eq(code, 0, `dry-run 应成功\n${log}`);
    t.eq(nodeFs.readFileSync(nodePath.join(fixture.profileDir, "package.json"), "utf8"), beforePkg, "package.json 不该变");
    t.eq(nodeFs.readFileSync(nodePath.join(fixture.profileDir, "cordis.patch.yml"), "utf8"), beforeProfilePatch, "profile patch 不该变");
    t.eq(nodeFs.readFileSync(nodePath.join(fixture.home, "preset-bundles", PRESET, "cordis.patch.yml"), "utf8"), beforePreset, "preset 不该变");
    t.ok(!statLink(linkDest(fixture.profileDir)).present, "不该建链接");
    const backups = nodeFs.readdirSync(fixture.profileDir).filter((f) => f.includes(".bak-before-"));
    t.eq(backups.length, 0, "不该产生备份文件");
    t.ok(log.includes("[dry]"), "dry-run 应打印 [dry] 计划");
  } finally {
    fixture.cleanup();
  }
};

tests["C5 已经正确时不动它（幂等，且不产生新备份）"] = (t) => {
  const fixture = makeHome("c5");
  try {
    const first = installVerbose(fixture.home);
    t.eq(first.code, 0, `首跑应成功\n${first.log}`);
    const specAfterFirst = readDeps(fixture.profileDir)[PKG];
    const backupsAfterFirst = nodeFs.readdirSync(fixture.profileDir).filter((f) => f.startsWith("package.json.bak-before-gokifu-")).length;
    const second = installVerbose(fixture.home);
    t.eq(second.code, 0, `二跑应成功\n${second.log}`);
    t.eq(readDeps(fixture.profileDir)[PKG], specAfterFirst, "依赖声明不该再变");
    t.eq(nodeFs.readdirSync(fixture.profileDir).filter((f) => f.startsWith("package.json.bak-before-gokifu-")).length, backupsAfterFirst, "不该再备份");
    t.ok(second.log.includes("已指向本目录"), `应说明已正确：\n${second.log}`);
  } finally {
    fixture.cleanup();
  }
};

tests["C6 复制安装（node_modules 里是真实目录）→ 不改依赖声明"] = (t) => {
  const fixture = makeHome("c6", { deps: { [PKG]: "1.9.1" } });
  try {
    writePkg(linkDest(fixture.profileDir)); // 真实目录，不是链接
    const { code, log } = installVerbose(fixture.home);
    t.eq(code, 0, `应成功\n${log}`);
    t.eq(readDeps(fixture.profileDir)[PKG], "1.9.1", "复制安装的版本声明不许被改成 link:");
    t.ok(log.includes("复制"), `应说明按复制安装处理：\n${log}`);
  } finally {
    fixture.cleanup();
  }
};

/* ───────────────────────── D · 校验器（假绿修复 + 变异自检） ───────────────────────── */

function verifyFixture(fixture, extra = {}) {
  return verifyInstall({ dshHome: fixture.home, profile: "desktop", preset: PRESET, ...extra });
}

tests["D1 正例：健康夹具必须 16/16 全绿（证明断言不是常量红）"] = (t) => {
  const fixture = makeHome("d1");
  try {
    createDirLink(fixture.pkgSrc, linkDest(fixture.profileDir));
    const result = verifyFixture(fixture);
    const failedNames = result.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`);
    t.eq(result.checks.length, 16, "检查项数量");
    t.eq(result.failed, 0, `健康夹具不该红：\n${failedNames.join("\n")}`);
  } finally {
    fixture.cleanup();
  }
};

tests["D2 变异 1：link 指向不存在的目录 → 必须红（这就是原来的假绿）"] = (t) => {
  const fixture = makeHome("d2");
  try {
    createDirLink(fixture.pkgSrc, linkDest(fixture.profileDir)); // 链接本身是好的
    const stale = `link:${nodePath.join(fixture.home, "projects", "dsh-gokifu-compact").replace(/\\/g, "/")}`;
    setDeps(fixture.profileDir, { [PKG]: stale }); // 只把声明改坏
    const result = verifyFixture(fixture);
    t.ok(result.failed >= 1, "必须有失败项");
    t.ok(checkNamed(result, "依赖规格解析后目标存在")?.ok === false, "「目标存在」这条必须红");
    t.ok(checkNamed(result, "解析到的包名是本包")?.ok === false, "包名这条必须红");
    t.ok(checkNamed(result, "实际指向与依赖规格一致")?.ok === false, "一致性这条必须红");
    t.ok(String(checkNamed(result, "依赖规格解析后目标存在")?.detail).includes("不存在"), "详情要指出不存在");
  } finally {
    fixture.cleanup();
  }
};

tests["D3 变异 2：目标存在但不是这个包 → 必须红（不能只看目录在不在）"] = (t) => {
  const fixture = makeHome("d3");
  try {
    const decoy = nodePath.join(fixture.home, "冒牌包");
    writePkg(decoy, { name: "someone-elses-package" });
    createDirLink(decoy, linkDest(fixture.profileDir));
    setDeps(fixture.profileDir, { [PKG]: toLinkSpec(decoy) });
    const result = verifyFixture(fixture);
    t.ok(checkNamed(result, "依赖规格解析后目标存在")?.ok === true, "目录存在这条应通过");
    t.ok(checkNamed(result, "解析到的包名是本包")?.ok === false, "包名这条必须红");
    t.ok(String(checkNamed(result, "解析到的包名是本包")?.detail).includes("someone-elses-package"), "详情要点出真实包名");
  } finally {
    fixture.cleanup();
  }
};

tests["D4 变异 3：声明指向 A、node_modules 却指向 B → 必须红"] = (t) => {
  const fixture = makeHome("d4");
  try {
    const other = nodePath.join(fixture.home, "另一个包");
    writePkg(other);
    createDirLink(other, linkDest(fixture.profileDir)); // 链接指向 B
    // 声明指向 A（夹具自带的 pkg-src）
    const result = verifyFixture(fixture);
    t.ok(checkNamed(result, "实际指向与依赖规格一致")?.ok === false, "一致性这条必须红");
  } finally {
    fixture.cleanup();
  }
};

tests["D5 变异 4：node_modules 断链 → 必须红，且不能被 existsSync 骗过"] = (t) => {
  if (!WIN) {
    console.log("    (跳过：夹具用 junction，本机非 Windows)");
    return;
  }
  const fixture = makeHome("d5");
  try {
    nodeFs.symlinkSync(nodePath.join(fixture.home, "不存在"), linkDest(fixture.profileDir), "junction");
    const result = verifyFixture(fixture);
    t.ok(checkNamed(result, "包已链接进 profile/node_modules")?.ok === false, "① 这条必须红");
    t.ok(checkNamed(result, "实际指向与依赖规格一致")?.ok === false, "一致性这条必须红");
  } finally {
    fixture.cleanup();
  }
};

tests["D6 变异 5：版本号声明但没有实装 → 必须红"] = (t) => {
  const fixture = makeHome("d6", { deps: { [PKG]: "1.9.1" } });
  try {
    const result = verifyFixture(fixture);
    t.ok(checkNamed(result, "依赖规格解析后目标存在")?.ok === false, "registry 模式没有实装时必须红");
  } finally {
    fixture.cleanup();
  }
};

tests["D7 反例：npm/复制安装（版本号 + 实目录在 profile 内）→ 不许假红"] = (t) => {
  const fixture = makeHome("d7", { deps: { [PKG]: "1.9.1" } });
  try {
    writePkg(linkDest(fixture.profileDir)); // 真实目录，落在 profile 内
    const result = verifyFixture(fixture);
    t.eq(result.failed, 0, `复制安装不该红：${result.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}`);
  } finally {
    fixture.cleanup();
  }
};

tests["D8 变异 6：preset 里没有我们的引擎 → 必须红"] = (t) => {
  const fixture = makeHome("d8");
  try {
    createDirLink(fixture.pkgSrc, linkDest(fixture.profileDir));
    write(nodePath.join(fixture.home, "preset-bundles", PRESET, "cordis.patch.yml"), "plugins:\n  - id: compaction-basic\n");
    const result = verifyFixture(fixture);
    t.ok(checkNamed(result, "preset 引用了")?.ok === false, "preset 引用这条必须红");
    t.ok(checkNamed(result, "preset 里没有 compaction-basic")?.ok === false, "单实例这条必须红");
  } finally {
    fixture.cleanup();
  }
};

/* ───────────────────────── E · 两端一致 ───────────────────────── */

tests["E1 安装器修完，校验器立刻全绿（两个修复不许各自为政）"] = (t) => {
  const fixture = makeHome("e1");
  const stale = `link:${nodePath.join(fixture.home, "projects", "dsh-gokifu-compact").replace(/\\/g, "/")}`;
  setDeps(fixture.profileDir, { [PKG]: stale });
  try {
    const before = verifyFixture(fixture);
    t.ok(before.failed > 0, "前置：坏状态下校验必须先报红（否则后面全绿没有意义）");
    const { code, log } = installVerbose(fixture.home);
    t.eq(code, 0, `安装器应成功\n${log}`);
    const after = verifyFixture(fixture);
    t.eq(after.failed, 0, `修完应全绿，实际红：\n${after.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join("\n")}`);
  } finally {
    fixture.cleanup();
  }
};

tests["E2 判据只有一份：verify 与 doctor 都走 inspectProfileInstall"] = (t) => {
  const fixture = makeHome("e2");
  try {
    createDirLink(fixture.pkgSrc, linkDest(fixture.profileDir));
    const st = inspectProfileInstall({ dshHome: fixture.home, profile: "desktop", pkgName: PKG });
    t.ok(Object.values(st.checks).every(Boolean), "健康时四项判据都应为真");
    t.eq(st.failure, null, "健康时 failure 应为 null");
    const stale = `link:${nodePath.join(fixture.home, "projects", "dsh-gokifu-compact").replace(/\\/g, "/")}`;
    setDeps(fixture.profileDir, { [PKG]: stale });
    const bad = inspectProfileInstall({ dshHome: fixture.home, profile: "desktop", pkgName: PKG });
    t.ok(!Object.values(bad.checks).every(Boolean), "坏状态必须有判据为假");
    t.ok(String(bad.failure).includes("不存在"), `failure 应说明不存在：${bad.failure}`);
  } finally {
    fixture.cleanup();
  }
};
/* ───────────────────────── F · 入口层（经 junction 直接执行不许静默退出） ───────────────────────── */

/** 把 scripts/ 里两个文件复制进夹具，造一个「已装好的包」，再用 junction 挂出来。 */
function makeInstalledCopy(fixture, label) {
  const pkgCopy = nodePath.join(fixture.home, `pkg-copy-${label}`);
  // ★ A2-1：install.mjs 现在从 src/rooms/preset-format.mjs 取块格式（R-A 消反向依赖）。
  //   「装好的包副本」必须包含该房间文件，否则 junction 场景下 ESM 解析直接失败。
  for (const rel of [["scripts", "install.mjs"], ["scripts", "link-path.mjs"], ["test", "verify-install.mjs"], ["src", "rooms", "preset-format.mjs"]]) {
    const from = nodePath.join(REPO_DIR, ...rel);
    const to = nodePath.join(pkgCopy, ...rel);
    nodeFs.mkdirSync(nodePath.dirname(to), { recursive: true });
    nodeFs.copyFileSync(from, to);
  }
  const view = nodePath.join(fixture.home, `装好的包-${label}`);
  createDirLink(pkgCopy, view);
  return { pkgCopy, view };
}

function runNode(args, options = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }) };
  } catch (error) {
    return { code: error.status ?? "spawn-error", out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

tests["F1 经 junction 路径执行 install.mjs：必须真的干活（旧写法静默退出 0，什么都不做）"] = (t) => {
  const fixture = makeHome("f1");
  try {
    const { view } = makeInstalledCopy(fixture, "install");
    const entry = nodePath.join(view, "scripts", "install.mjs");
    const result = runNode([entry, "--home", fixture.home, "--dry-run"]);
    t.eq(result.code, 0, `应退出 0：${result.out}`);
    t.ok(result.out.includes("== dsh-gokifu-compact install =="), `必须真的执行 run()（旧写法这里输出为空）：\n${result.out}`);
    t.ok(result.out.includes("[dry]"), `dry-run 应打印计划：\n${result.out}`);
  } finally {
    fixture.cleanup();
  }
};

tests["F2 经 junction 路径执行 verify-install.mjs：必须打印检查（不许「空输出 + 退出码 0」）"] = (t) => {
  const fixture = makeHome("f2");
  try {
    createDirLink(fixture.pkgSrc, linkDest(fixture.profileDir));
    const { view } = makeInstalledCopy(fixture, "verify");
    const entry = nodePath.join(view, "test", "verify-install.mjs");
    const result = runNode([entry], { env: { ...process.env, DSH_HOME: fixture.home } });
    t.ok(result.out.includes("== verify-install（profile=desktop, preset=personal-assistant）=="), `必须打印表头：\n${result.out}`);
    t.ok(result.out.includes("✓"), "应逐条打印检查结果");
    t.eq(result.code, 0, `健康夹具应退出 0：\n${result.out}`);
  } finally {
    fixture.cleanup();
  }
};
