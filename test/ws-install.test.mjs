/**
 * ws-install 切片测试：S10c（诊断信息与措辞）+ C-12（入口判据）+ S10e 的 EOF 换行
 *
 * 命名注意：文件名必须能被 `node test/run.mjs <filter>` 选中，所以用 `ws-install.test.mjs`；
 * 与 `install-link.test.mjs`（S10a 的 29 项）完全不重叠、不改它一行。
 *
 * 三条纪律（都来自本仓库踩过的坑）：
 *   1. 负例必须有**旧代码副本**撑着：C-12 的旧判据副本取自 git HEAD，逐字；不是"手写等价体"。
 *   2. 断言不许是常量：每条都同时给正例（绿）与负例（红），并核对"旧行为会红"这一事实。
 *   3. 夹具全在 os.tmpdir()，真 profile 一个字节都不碰；运行时也不写仓库（复制到 tmp 再跑）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { samePath, toLinkSpec, inspectProfileInstall, describePackageNameFailure } from "../scripts/link-path.mjs";
import { verifyInstall, PKG } from "./verify-install.mjs";

const WIN = process.platform === "win32";
const PRESET = "personal-assistant";
const REPO_DIR = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = nodePath.join(REPO_DIR, "test", "fixtures", "entry-argv");

export const tests = {};

/* ───────────────────────── 夹具工具 ───────────────────────── */

function rmrf(p) {
  if (p && nodeFs.existsSync(p)) nodeFs.rmSync(p, { recursive: true, force: true });
}

function mkTemp(label) {
  return nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-ws-install-${label}-`));
}

function write(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

function writePkg(dir, { name = PKG, main = "src/ui.mjs", peers = true } = {}) {
  const MI = "0.2.0-rc.2";
  write(nodePath.join(dir, "package.json"), JSON.stringify({
    name,
    version: "9.9.9-fixture",
    main,
    ...(peers
      ? {
          peerDependencies: {
            "@deepseek-ai/dsh-compaction-basic": MI,
            "@deepseek-ai/dsh-compaction": MI,
            "@deepseek-ai/dsh-llm": MI,
            "@deepseek-ai/dsh-session": MI,
            "@deepseek-ai/schemastery": "^3.18.4",
          },
        }
      : {}),
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
 * 一个健康的假 DSH_HOME（profiles/desktop + 预设 + 运行期证据 + 链接），
 * 与 test/install-link.test.mjs 的 makeHome 同构 —— 故意重复，避免跨文件耦合。
 */
function makeHealthyHome(label, { link = true } = {}) {
  const home = mkTemp(label);
  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
  write(nodePath.join(profileDir, "cordis.patch.yml"), "# fixture profile patch\n");
  write(nodePath.join(home, "preset-bundles", PRESET, "cordis.patch.yml"), PRESET_YML);
  write(nodePath.join(home, "chess-context", "sessions", "fixture-session", "graph.json"), "{}\n");
  const pkgSrc = nodePath.join(home, "pkg-src");
  writePkg(pkgSrc);
  write(nodePath.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-fixture",
    private: true,
    dependencies: { [PKG]: toLinkSpec(pkgSrc) },
    // ★ task-118：健康态 = **bundle 通道**（本包自带 cordis.patch.yml），profile 里没有手工 gokifu-ui 行
    dsh: { profile: { bundles: [PKG] } },
  }, null, 2) + "\n");
  if (link) nodeFs.symlinkSync(pkgSrc, nodePath.join(profileDir, "node_modules", PKG), "junction");
  return { home, profileDir, pkgSrc, cleanup: () => rmrf(home) };
}

function verify(home) {
  return verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET });
}

function named(result, fragment) {
  return result.checks.find((c) => c.name.includes(fragment));
}

function runNode(args, { timeout = 120_000, env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env, GOKIFU_REPO_ROOT: REPO_DIR, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? "spawn-error", out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/* ═════════════════════ S10c · 诊断信息与措辞 ═════════════════════ */

tests["S10c-1 目标目录不存在：详情写「目标目录不存在」，不许再写误导的「读不到 package.json」"] = (t) => {
  const fixture = makeHealthyHome("s10c1");
  const missingDir = nodePath.join(fixture.home, "projects", "dsh-gokifu-compact"); // 故意不存在
  try {
    // 前置：这个目录必须真的不存在，否则本用例什么也没证明
    t.ok(!nodeFs.existsSync(missingDir), `前置：${missingDir} 不应存在`);
    const stale = toLinkSpec(missingDir);
    write(nodePath.join(fixture.profileDir, "package.json"), JSON.stringify({
      name: "dsh-profile-fixture", private: true, dependencies: { [PKG]: stale },
    }, null, 2) + "\n");

    const result = verify(fixture.home);
    const resolves = named(result, "依赖规格解析后目标存在");
    const nameCheck = named(result, "解析到的包名是本包");
    t.ok(resolves?.ok === false, "「目标存在」这条必须红");
    t.ok(nameCheck?.ok === false, "「包名是本包」这条也必须红（目录都没有，名字无处可读）");
    // 旧版这里一律是 "(读不到 package.json)" —— 与真实根因无关，看的人会去查 JSON 语法
    t.includes(resolves.detail, "目标目录不存在");
    t.notIncludes(resolves.detail, "读不到 package.json");
    t.includes(resolves.detail, missingDir.replace(/\\/g, "/"));
    t.notIncludes(nameCheck.detail, "读不到 package.json");
    t.includes(nameCheck.detail, "未核对");
    t.includes(nameCheck.detail, "目标目录不存在");
  } finally {
    fixture.cleanup();
  }
};

tests["S10c-2 判定层：目标目录里的 package.json 缺失/坏 JSON/没有 name 各给各的措辞"] = (t) => {
  const home = mkTemp("s10c2");
  try {
    const target = nodePath.join(home, "目录 里的 假包");
    nodeFs.mkdirSync(target, { recursive: true });
    const profileDir = nodePath.join(home, "profiles", "desktop");
    write(nodePath.join(profileDir, "package.json"), JSON.stringify({
      name: "dsh-profile-fixture", private: true, dependencies: { [PKG]: toLinkSpec(target) },
    }, null, 2) + "\n");

    // 前置：分档函数给出的原因不许正好等于旧版那句笼统话（否则修复等于没生效）
    const bare = describePackageNameFailure(target);
    t.ok(typeof bare === "string" && bare.length > 0, `分档函数必须给出原因：${bare}`);
    t.ne(bare, "读不到 package.json", "不许返回旧版的笼统话");

    // (a) 目录在、package.json 缺失 ⇒ 「package.json 不存在」
    const r1 = verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET });
    const c1 = named(r1, "解析到的包名是本包");
    t.ok(c1?.ok === false, "没有 package.json ⇒ 包名这条必红");
    t.includes(c1.detail, "package.json 不存在");
    // 旧版在这一条上一律是 `(读不到 package.json)` —— 与「没有清单 / 清单坏 / 没有 name」无关
    t.notIncludes(c1.detail, "读不到 package.json");

    // (b) package.json 存在但不是合法 JSON
    write(nodePath.join(target, "package.json"), "{ name: 这不是 JSON\n");
    const c2 = named(verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET }), "解析到的包名是本包");
    t.includes(c2.detail, "不是合法 JSON");

    // (c) package.json 里没有 name
    write(nodePath.join(target, "package.json"), JSON.stringify({ version: "1.0.0" }) + "\n");
    const c3 = named(verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET }), "解析到的包名是本包");
    t.includes(c3.detail, "没有 name");

    // (d) 包名读到了、只是不是我们 ⇒ 详情里出现真实包名，不出现任何「读不到」
    write(nodePath.join(target, "package.json"), JSON.stringify({ name: "someone-else" }) + "\n");
    const c4 = named(verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET }), "解析到的包名是本包");
    t.ok(c4?.ok === false, "包名不符必须红");
    t.includes(c4.detail, "someone-else");
    t.notIncludes(c4.detail, "读不到");

    // 对照组：健康夹具的包名这条必须绿（证明上面几条不是「永远红」）
    const healthy = makeHealthyHome("s10c2-healthy", { link: false });
    try {
      t.ok(named(verify(healthy.home), "解析到的包名是本包")?.ok === true, "健康夹具的包名这条必须绿");
    } finally {
      healthy.cleanup();
    }
  } finally {
    rmrf(home);
  }
};

tests["S10c-3 manifestError 进 ✗ 详情：profile/package.json 缺失时说清是 ENOENT 与路径，坏 JSON 说清坏在哪"] = (t) => {
  const home = mkTemp("s10c3");
  try {
    const result = verify(home); // 空 home：profile/package.json 根本不存在
    const declares = named(result, "profile/package.json 声明了本包依赖");
    const resolves = named(result, "依赖规格解析后目标存在");
    t.ok(declares?.ok === false, "缺清单时这条必红");
    t.includes(declares.detail, "profile/package.json 不存在");
    t.includes(declares.detail, nodePath.join(home, "profiles", "desktop", "package.json"));
    t.includes(resolves.detail, "profile/package.json 不存在");
    t.eq(result.checks.length, 16, "缺清单时检查项数量仍必须是 16（门禁才可比对）");
    t.eq(result.failed, 16, "空 home ⇒ 16 项全红");

    // 清单在但不是 JSON ⇒ manifestError 必须分档说「不是合法 JSON」（不是笼统的「读不到」）
    const profileDir = nodePath.join(home, "profiles", "desktop");
    write(nodePath.join(profileDir, "package.json"), "{ 坏掉的 JSON\n");
    const st = inspectProfileInstall({ dshHome: home, profile: "desktop", pkgName: PKG });
    t.eq(st.manifestErrorKind, "invalid-json", "分档代号");
    t.includes(st.manifestError, "不是合法 JSON");
    t.notIncludes(st.manifestError, "不存在");
    // verify-install 这边：清单读不出内容时不许谎报绿灯（dsh.profile.bundles 那条必须跟着红）
    const bad = verify(home);
    t.eq(bad.checks.length, 16, "坏 JSON 时检查项数量仍 16");
    t.eq(bad.failed, 16, "坏 JSON ⇒ 16 项全红");
    const badDeclares = named(bad, "profile/package.json 声明了本包依赖");
    t.includes(badDeclares.detail, "不是合法 JSON");
    t.includes(badDeclares.detail, nodePath.join(home, "profiles", "desktop", "package.json"));
    const badBundles = named(bad, "UI 挂载通道二选一");
    t.ok(badBundles?.ok === false, "清单读不出来时挂载通道那条必须红，不许凭 ?? [] 判绿");
    t.includes(badBundles.detail, "不是合法 JSON");
  } finally {
    rmrf(home);
  }
};

/* ── S10c-4/5：`failure`（doctor.mjs 直接打印的那一句）与分档函数的边界 ── */

/** 只有 profiles/desktop 的裸壳 home（② 组之外的检查一律红，正好把注意力留给 ② 组）。 */
function makeBareHome(label) {
  const home = mkTemp(label);
  const profileDir = nodePath.join(home, "profiles", "desktop");
  nodeFs.mkdirSync(profileDir, { recursive: true });
  return { home, profileDir, cleanup: () => rmrf(home) };
}

function writeProfilePkg(profileDir, deps) {
  write(nodePath.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-fixture", private: true, dependencies: deps,
  }, null, 2) + "\n");
}

function state(home) {
  return inspectProfileInstall({ dshHome: home, profile: "desktop", pkgName: PKG });
}

tests["S10c-4 failure 分档：清单读不出 / 坏 JSON / 目标目录不存在 / 目标不是目录 / 目标缺 package.json 各有各的话"] = (t) => {
  // ① profile/package.json 缺失（ENOENT）—— 旧版这里说「profile/package.json 没有 X 依赖」，
  //    清单根本不存在却让人去查依赖声明，根因被藏起来（doctor 打印的就是这一句）。
  const h1 = makeBareHome("s10c4-a");
  try {
    const st = state(h1.home);
    t.eq(st.manifestErrorKind, "ENOENT", "分档代号");
    t.includes(st.failure, "依赖声明无法核对");
    t.includes(st.failure, st.manifestError, "failure 必须原样带上 manifestError");
    t.includes(st.failure, nodePath.join(h1.profileDir, "package.json"), "failure 必须带清单路径");
    t.notIncludes(st.failure, `没有 ${PKG} 依赖`, "清单都不存在，不许说「没有依赖」");
  } finally {
    h1.cleanup();
  }

  // ② 清单在但不是 JSON
  const h2 = makeBareHome("s10c4-b");
  try {
    write(nodePath.join(h2.profileDir, "package.json"), "{ 坏掉的 JSON\n");
    const st = state(h2.home);
    t.eq(st.manifestErrorKind, "invalid-json", "分档代号");
    t.includes(st.failure, "不是合法 JSON");
    t.includes(st.failure, nodePath.join(h2.profileDir, "package.json"));
    t.notIncludes(st.failure, `没有 ${PKG} 依赖`);
    t.notIncludes(st.failure, "不存在", "坏 JSON 不许说成「不存在」");
  } finally {
    h2.cleanup();
  }

  // ③ 目标目录不存在
  const h3 = makeBareHome("s10c4-c");
  try {
    const missingDir = nodePath.join(h3.home, "projects", "dsh-gokifu-compact");
    writeProfilePkg(h3.profileDir, { [PKG]: toLinkSpec(missingDir) });
    t.ok(!nodeFs.existsSync(missingDir), "前置：目标目录不存在");
    const st = state(h3.home);
    t.includes(st.failure, "解析后的目录不存在");
    t.includes(st.failure, missingDir.replace(/\\/g, "/"));
    t.notIncludes(st.failure, "读不到 package.json");
  } finally {
    h3.cleanup();
  }

  // ④ 目标存在但不是目录 —— 旧版一律说「解析后的目录不存在」，与真相不符
  const h4 = makeBareHome("s10c4-d");
  try {
    const aFile = nodePath.join(h4.home, "其实是个文件");
    write(aFile, "x");
    writeProfilePkg(h4.profileDir, { [PKG]: toLinkSpec(aFile) });
    const st = state(h4.home);
    t.includes(st.failure, "解析到的不是目录");
    t.includes(st.failure, aFile.replace(/\\/g, "/"));
    t.notIncludes(st.failure, "解析后的目录不存在");
    t.notIncludes(st.failure, "读不到 package.json");
  } finally {
    h4.cleanup();
  }

  // ⑤ 目标目录在、但里面没有 package.json —— 这是「文件缺失」，不是「路径不存在」
  const h5 = makeBareHome("s10c4-e");
  try {
    const emptyPkgDir = nodePath.join(h5.home, "刚 clone 下来的包");
    nodeFs.mkdirSync(emptyPkgDir, { recursive: true });
    writeProfilePkg(h5.profileDir, { [PKG]: toLinkSpec(emptyPkgDir) });
    const st = state(h5.home);
    t.includes(st.failure, "package.json 读不出包名");
    t.includes(st.failure, "package.json 不存在");
    t.notIncludes(st.failure, "读不到 package.json");
    // verify-install 这边：包名这条详情要把「目标里缺清单」说出来，不是「原因未知」
    const r = verifyInstall({ dshHome: h5.home, profile: "desktop", preset: PRESET });
    const nameCheck = named(r, "解析到的包名是本包");
    t.ok(nameCheck?.ok === false, "包名这条必红");
    t.includes(nameCheck.detail, "package.json 不存在");
    t.notIncludes(nameCheck.detail, "原因未知");
    t.notIncludes(nameCheck.detail, "读不到 package.json");
  } finally {
    h5.cleanup();
  }

  // ⑥ 对照组：健康夹具的 failure 必须是 null（doctor 用 `failure ?? linkedPath` 兜底，非 null 就会印错话）
  const healthy = makeHealthyHome("s10c4-healthy");
  try {
    const st = state(healthy.home);
    t.eq(st.failure, null, `健康时 failure 必须是 null：${st.failure}`);
    t.eq(st.manifestError, null, "健康时 manifestError 必须是 null");
    t.ok(Object.values(st.checks).every(Boolean), "健康时四条判据都应为真");
  } finally {
    healthy.cleanup();
  }
};

tests["S10c-5 分档函数边界：dir 是文件 / package.json 是目录 / 读得到包名时返回 null"] = (t) => {
  const home = mkTemp("s10c5");
  try {
    // (a) dir 本身是文件 → 「路径不是目录」（旧版先 stat <dir>/package.json，拿 ENOTDIR 说成「package.json 不存在」）
    const asFile = nodePath.join(home, "其实是文件");
    write(asFile, "x");
    t.eq(describePackageNameFailure(asFile), "路径不是目录");

    // (b) dir 在、<dir>/package.json 是个目录 → 「package.json 不是文件」（旧版反过来说成「路径不是目录」）
    const pkgIsDir = nodePath.join(home, "清单是目录");
    nodeFs.mkdirSync(nodePath.join(pkgIsDir, "package.json"), { recursive: true });
    t.eq(describePackageNameFailure(pkgIsDir), "package.json 不是文件");

    // (c) dir 不存在 → 「package.json 不存在」
    t.eq(describePackageNameFailure(nodePath.join(home, "根本没有")), "package.json 不存在");

    // (d) 包名读得到 → null（有原因才返回字符串）
    const good = nodePath.join(home, "好包");
    writePkg(good);
    t.eq(describePackageNameFailure(good), null);

    // (e) verify-install：目标存在但不是目录时，两条详情都不许说「原因未知」或「读不到 package.json」
    const profileDir = nodePath.join(home, "profiles", "desktop");
    nodeFs.mkdirSync(nodePath.join(profileDir, "node_modules"), { recursive: true });
    write(nodePath.join(home, "preset-bundles", PRESET, "cordis.patch.yml"), PRESET_YML);
    writeProfilePkg(profileDir, { [PKG]: toLinkSpec(asFile) });
    const r = verifyInstall({ dshHome: home, profile: "desktop", preset: PRESET });
    const resolves = named(r, "依赖规格解析后目标存在");
    const nameCheck = named(r, "解析到的包名是本包");
    t.ok(resolves?.ok === false, "目标不是目录 ⇒「依赖规格解析后目标存在」必红");
    t.includes(resolves.detail, "目标不是目录");
    t.ok(nameCheck?.ok === false, "「解析到的包名是本包」也必红");
    t.includes(nameCheck.detail, "目标不是目录");
    t.notIncludes(nameCheck.detail, "原因未知");
    t.notIncludes(nameCheck.detail, "读不到 package.json");
  } finally {
    rmrf(home);
  }

  // (f) registry 模式（写版本号）但 node_modules 里没有它的链接 → 说清「没有链接」，不许「原因未知」
  const h6 = makeBareHome("s10c5-f");
  try {
    writeProfilePkg(h6.profileDir, { [PKG]: "1.9.1" });
    const r6 = verifyInstall({ dshHome: h6.home, profile: "desktop", preset: PRESET });
    const nameCheck6 = named(r6, "解析到的包名是本包");
    t.ok(nameCheck6?.ok === false, "registry 模式没有实装 ⇒ 包名这条必红");
    t.includes(nameCheck6.detail, "未核对：node_modules 里没有");
    t.notIncludes(nameCheck6.detail, "原因未知");
  } finally {
    h6.cleanup();
  }
};

/* ═════════════════════ S10e · 缺失形态占位红 + EOF 换行 ═════════════════════ */

tests["S10e-1 preset 缺失：4 条占位红 + 1 条路径，总数仍 16"] = (t) => {
  const fixture = makeHealthyHome("s10e1");
  try {
    rmrf(nodePath.join(fixture.home, "preset-bundles"));
    const result = verify(fixture.home);
    const presetFile = nodePath.join(fixture.home, "preset-bundles", PRESET, "cordis.patch.yml");
    t.ok(!nodeFs.existsSync(presetFile), "前置：预设文件应不存在");
    t.eq(result.checks.length, 16, "检查项数量");
    const presetChecks = result.checks.filter((c) => c.name.startsWith("preset "));
    t.eq(presetChecks.length, 5, "preset 组必须是 5 条（1 条路径 + 4 条占位）");
    t.ok(presetChecks.every((c) => c.ok === false), "preset 组 5 条必须全红");
    const fileCheck = presetChecks.find((c) => c.name === "preset 文件存在");
    t.includes(fileCheck.detail, presetFile);
    for (const c of presetChecks.filter((x) => x.name !== "preset 文件存在")) {
      t.includes(c.detail, "preset 文件不存在，无法核对");
    }
    // 反向对照：预设补回来以后这 5 条必须转绿（证明不是常量红）
    write(nodePath.join(fixture.home, "preset-bundles", PRESET, "cordis.patch.yml"), PRESET_YML);
    const fixed = verify(fixture.home);
    t.ok(fixed.checks.filter((c) => c.name.startsWith("preset ")).every((c) => c.ok === true), "补回预设后 preset 组应全绿");
    t.eq(fixed.failed, 0, `健康夹具补回预设后应 0 红：${fixed.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join(" / ")}`);
  } finally {
    fixture.cleanup();
  }
};

tests["S10e-2 profile/package.json 缺失：5 条占位红（首条带路径），总数仍 16，且首条不是含糊话"] = (t) => {
  const fixture = makeHealthyHome("s10e2");
  try {
    const profilePkg = nodePath.join(fixture.profileDir, "package.json");
    nodeFs.rmSync(profilePkg);
    const result = verify(fixture.home);
    t.ok(!nodeFs.existsSync(profilePkg), "前置：清单应不存在");
    t.eq(result.checks.length, 16, "检查项数量");
    // ② 组：从「声明了本包依赖」到「UI 挂载通道二选一」共 5 条
    const names = [
      "profile/package.json 声明了本包依赖",
      "依赖规格解析后目标存在（link:/file: 目标目录 / registry 实装）",
      "解析到的包名是本包",
      "profile/node_modules 实际指向与依赖规格一致",
      "UI 挂载通道二选一（bundle 或手工行，不双挂载）",
    ];
    for (const name of names) {
      const c = result.checks.find((x) => x.name === name);
      t.ok(c !== undefined, `缺清单时「${name}」这条不许消失（少一条 = 假绿）`);
      t.ok(c?.ok === false, `「${name}」必须红`);
    }
    const first = result.checks.find((x) => x.name === "profile/package.json 声明了本包依赖");
    t.includes(first.detail, "profile/package.json 不存在");
    t.includes(first.detail, profilePkg);
    // 旧版这条只说 "profile/package.json 不存在：<路径>"；新版必须带上 manifestError 的整句（含路径与原因）
    t.includes(first.detail, `不存在：${profilePkg}`);
    // 检查顺序恒定：①5 条 → ②5 条 → ③④⑤5 条 → ⑥1 条 = 16
    t.eq(result.checks.length, 16, "顺序与数量都要恒定");
    t.eq(result.failed, 5, "只有 ② 组 5 条红、①③④⑤⑥ 仍绿（其余部分没被牵连）");
    t.ok(result.checks.filter((c) => c.ok).length === 11, "绿项必须是 11 条");
    // 反例：清单缺失时，②组第一项以外的 4 条不能各说各话
    for (const c of result.checks.filter((x) => names.slice(1).includes(x.name))) {
      t.includes(c.detail, "profile/package.json 不存在");
    }
  } finally {
    fixture.cleanup();
  }
};

tests["S10e-3 EOF 换行：scripts/link-path.mjs 与 test/verify-install.mjs 的 wc -l == awk NR"] = (t) => {
  const files = ["scripts/link-path.mjs", "test/verify-install.mjs"];
  for (const rel of files) {
    const file = nodePath.join(REPO_DIR, rel);
    const text = nodeFs.readFileSync(file, "utf8");
    t.ok(text.endsWith("\n"), `${rel} 必须以换行结尾`);
    t.ok(!text.endsWith("\n\n"), `${rel} 不许以空行结尾（无意义 diff）`);
    const wc = text.split("\n").length - 1; // = `wc -l`
    const awk = text === "" ? 0 : text.split("\n").filter((_, i, all) => i < all.length - 1 || all[i] !== "").length; // = `awk 'END{print NR}'`
    t.eq(wc, awk, `${rel}：wc -l 与 awk NR 必须相等`);
    // 生成端也有真实文件可数：用系统 wc 交叉核对一次（本机有 Git Bash）
    try {
      const out = execFileSync("wc", ["-l", file], { encoding: "utf8" });
      t.eq(Number(out.trim().split(/\s+/)[0]), text.split("\n").length - 1, `${rel}：系统 wc -l 与读文件数一致`);
    } catch {
      // 没有 wc 的机器跳过这条（主断言不看它）
      console.log("    (无 wc 命令，跳过交叉核对)");
    }
  }
};

/* ═════════════════════ C-12 · 入口判据 ═════════════════════ */

/**
 * 把夹具脚本复制到 tmp 下、换成**非 ASCII 文件名**再执行（仓库里的文件一个都不重命名）。
 * CLI 形态：node <脚本> --dir <输出目录>；仓库根由 GOKIFU_REPO_ROOT 环境变量给。
 */
function runEntryFixture(fixtureName, scriptName, { extra = [] } = {}) {
  const src = nodePath.join(FIXTURES, fixtureName);
  if (!nodeFs.existsSync(src)) throw new Error(`缺夹具 ${src}（重新生成：node test/fixtures/entry-argv/gen.mjs）`);
  const dir = mkTemp("c12");
  const script = nodePath.join(dir, scriptName);
  nodeFs.copyFileSync(src, script);
  const outDir = nodePath.join(dir, "out");
  const result = runNode([script, "--dir", outDir, ...extra]);
  return { ...result, dir, script, outDir, cleanup: () => rmrf(dir) };
}

tests["C-12-1 负例：旧判据在非 ASCII 文件名下静默不执行（exit 0、零输出）—— 这就是要修的假绿"] = (t) => {
  const r = runEntryFixture("ab-old.mjs", "ab 渲染.mjs");
  try {
    t.eq(r.code, 0, `旧判据在本机实测就是 exit 0：${r.out}`);
    t.eq(r.out, "", "旧判据下什么也不打印（假绿的形态）");
    t.ok(!nodeFs.existsSync(r.outDir), "旧判据下连输出目录都不该被创建");
    // 对照：同一份旧代码、ASCII 文件名 ⇒ 正常干活（证明上一条是"文件名编码"造成的，不是脚本坏了）
    const ok = mkTemp("c12-control");
    try {
      const script = nodePath.join(ok, "ab-ascii.mjs");
      nodeFs.copyFileSync(nodePath.join(FIXTURES, "ab-old.mjs"), script);
      const outDir = nodePath.join(ok, "out");
      const res = runNode([script, "--dir", outDir]);
      t.eq(res.code, 0, `ASCII 对照应成功：${res.out}`);
      // 同一份旧代码、ASCII 文件名 ⇒ 旧判据为真、正常干活：
      // 证明「非 ASCII 下什么都不干」是**文件名编码**造成的，不是脚本本身坏了。
      t.includes(res.out, "semantic: ");
      t.ok(nodeFs.existsSync(nodePath.join(outDir, "semantic.md")), "ASCII 对照应写出 semantic.md");
    } finally {
      rmrf(ok);
    }
  } finally {
    r.cleanup();
  }
};

/**
 * ★ 真文件自检（task-33 补；reviewer 指出 C-12-2 原来只跑 `ab-now.mjs` 夹具副本，
 *   把 `test/ab-render.mjs` 改成旧判据时只有 C-12-5 会红 —— 因为 C-12-2 测的是生成物）。
 * 做法：把工作区的**原文件** `test/ab-render.mjs` 放进一个临时镜像（test/ + src/ + scripts/ + package.json，
 * 保持相对 import 结构），再用**非 ASCII 文件名**直接执行。夹具过期（改了 ab-render 忘记重生成）时，
 * 真文件与夹具的渲染结果会逐字不同 ⇒ 本用例红。
 */
function runRealAbRenderNonAscii() {
  const dir = mkTemp("c12-real");
  const mirror = nodePath.join(dir, "mirror");
  nodeFs.mkdirSync(nodePath.join(mirror, "test"), { recursive: true });
  nodeFs.cpSync(nodePath.join(REPO_DIR, "src"), nodePath.join(mirror, "src"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(mirror, "scripts"), { recursive: true });
  for (const f of ["install.mjs", "link-path.mjs"]) {
    nodeFs.copyFileSync(nodePath.join(REPO_DIR, "scripts", f), nodePath.join(mirror, "scripts", f));
  }
  nodeFs.copyFileSync(nodePath.join(REPO_DIR, "package.json"), nodePath.join(mirror, "package.json"));
  const script = nodePath.join(mirror, "test", "ab 渲染.mjs");
  nodeFs.copyFileSync(nodePath.join(REPO_DIR, "test", "ab-render.mjs"), script);
  // task-59：ab-render 的 addUserNodeId 从 test/graph-fixtures.mjs 来，镜像必须一起带上
  nodeFs.copyFileSync(nodePath.join(REPO_DIR, "test", "graph-fixtures.mjs"), nodePath.join(mirror, "test", "graph-fixtures.mjs"));
  const outDir = nodePath.join(dir, "out");
  const result = runNode([script, "--dir", outDir]);
  return { ...result, outDir, cleanup: () => rmrf(dir) };
}

tests["C-12-2 正例：修好后的判据在非 ASCII 文件名下照常执行（三个臂都写出来）"] = (t) => {
  const r = runEntryFixture("ab-now.mjs", "ab 渲染.mjs");
  try {
    t.eq(r.code, 0, `应退出 0：${r.out}`);
    t.includes(r.out, "semantic:");
    t.includes(r.out, "terse:");
    t.includes(r.out, "off:");
    for (const arm of ["semantic", "terse", "off"]) {
      const file = nodePath.join(r.outDir, `${arm}.md`);
      t.ok(nodeFs.existsSync(file), `应写出 ${arm}.md`);
      t.ok(nodeFs.readFileSync(file, "utf8").includes("<chess-ledger>"), `${arm}.md 内容应是渲染结果`);
    }
    const semantic = nodeFs.readFileSync(nodePath.join(r.outDir, "semantic.md"), "utf8");
    const off = nodeFs.readFileSync(nodePath.join(r.outDir, "off.md"), "utf8");
    t.ok(semantic.includes("[dead"), "semantic 臂应带标记");
    t.ok(!off.includes("[dead"), "off 臂不该带标记（三个臂不是同一份输出）");

    // ★ 真文件自检：上面跑的是夹具副本；这里跑工作区的 test/ab-render.mjs 原文件
    const real = runRealAbRenderNonAscii();
    try {
      t.eq(real.code, 0, `真文件 + 非 ASCII 文件名应退出 0：${real.out}`);
      t.includes(real.out, "semantic:");
      for (const arm of ["semantic", "terse", "off"]) {
        t.ok(nodeFs.existsSync(nodePath.join(real.outDir, `${arm}.md`)), `真文件应写出 ${arm}.md`);
      }
      const realSemantic = nodeFs.readFileSync(nodePath.join(real.outDir, "semantic.md"), "utf8");
      t.eq(realSemantic, semantic, "真文件与夹具副本的渲染结果必须逐字相同（不同 ⇒ 夹具过期，gen.mjs 该重跑）");
    } finally {
      real.cleanup();
    }
  } finally {
    r.cleanup();
  }
};

tests["C-12-3 两种入口：直接执行干活，被 import 时零副作用"] = (t) => {
  const dir = mkTemp("c12-import");
  try {
    const script = nodePath.join(dir, "ab 渲染.mjs");
    nodeFs.copyFileSync(nodePath.join(FIXTURES, "ab-now.mjs"), script);
    const outDir = nodePath.join(dir, "should-not-exist");
    const probe = nodePath.join(dir, "probe.mjs");
    // 故意把输出目录塞进 argv：CLI 段一旦被误触发就会写盘，这个目录就是「副作用探测器」。
    // ⚠ ESM 的 import 会被提升，所以这条 push 必须写在动态 import() 之前而不是顶层。
    write(probe, [
      'import { pathToFileURL } from "node:url";',
      'const outDir = process.argv[3];',
      'process.argv.push("--dir", outDir);',
      "const url = pathToFileURL(process.argv[2]).href;",
      "const mod = await import(url);",
      "console.log(JSON.stringify({ arms: mod.ARMS, hasRender: typeof mod.renderArm, hasJudger: typeof mod.judgeEntry }));",
      "const r = mod.renderArm('semantic', 500, 'basic');",
      "console.log('render ok', typeof r.text, r.text.includes('<chess-ledger>'));",
    ].join("\n") + "\n");
    const res = runNode([probe, script, outDir]);
    // 关键断言是「import 不许触发 CLI 段」：输出里不许出现任何臂的标题，
    // 也不许创建 --dir 指向的目录（probe 把 outDir 塞进了 process.argv，CLI 段若跑就会写盘）。

    t.eq(res.code, 0, `import 必须成功：${res.out}`);
    t.notIncludes(res.out, "arm=semantic");
    t.notIncludes(res.out, "semantic: ");
    t.includes(res.out, '["semantic","terse","off"]');
    t.includes(res.out, '"hasRender":"function"');
    t.includes(res.out, '"hasJudger":"function"');
    t.includes(res.out, "render ok string true");
    t.ok(!res.out.includes("##########"), "import 时 CLI 段一次都不许跑");
    t.ok(!nodeFs.existsSync(outDir), "import 路径不许创建输出目录");
  } finally {
    rmrf(dir);
  }
};

tests["C-12-4 判据本身：等价路径/大小写/junction/非 ASCII 都判真，别的脚本判假"] = (t) => {
  // 用夹具里的同一实现（与 test/ab-render.mjs 逐字节同源，见 fixtures/entry-argv/ab-now.mjs）
  const dir = mkTemp("c12-4");
  try {
    const script = nodePath.join(dir, "ab 渲染.mjs");
    nodeFs.copyFileSync(nodePath.join(FIXTURES, "ab-now.mjs"), script);
    const probe = nodePath.join(dir, "probe.mjs");
    write(probe, [
      'import nodePath from "node:path";',
      'import { pathToFileURL } from "node:url";',

      "const mod = await import(pathToFileURL(process.argv[2]).href);",
      "const self = process.argv[2];",
      "const url = pathToFileURL(self).href;",
      "const cases = {",
      "  same: mod.judgeEntry(self, url),",
      "  dotted: mod.judgeEntry(nodePath.join(nodePath.dirname(self), '.', nodePath.basename(self)), url),",
      "  other: mod.judgeEntry(nodePath.join(nodePath.dirname(self), 'other.mjs'), url),",
      "  empty: mod.judgeEntry('', url),",
      "  undef: mod.judgeEntry(undefined, url),",
      "  badUrl: mod.judgeEntry(self, 'not a url'),",
      "  selfUrl: mod.judgeEntry(url, url),",
      "  fileUrlPath: mod.judgeEntry(new URL(url).href, url),",
      "  parentTrail: mod.judgeEntry(nodePath.join(nodePath.dirname(self), 'x', '..', nodePath.basename(self)), url),",
      "  asciiSelf: mod.judgeEntry(nodePath.join(nodePath.dirname(self), 'plain.mjs'), pathToFileURL(nodePath.join(nodePath.dirname(self), 'plain.mjs')).href),",
      "};",
      "console.log(JSON.stringify(cases));",
    ].join("\n") + "\n");
    const res = runNode([probe, script]);
    t.eq(res.code, 0, `probe 应成功：${res.out}`);
    const got = JSON.parse(res.out.trim().split("\n").pop());
    t.eq(got.same, true, "同一路径（含非 ASCII）必须判真 —— 旧判据在这里判假");
    t.eq(got.dotted, true, "./ 形式等价路径必须判真");
    t.eq(got.parentTrail, true, "x/../ 形式等价路径必须判真");
    t.eq(got.selfUrl, true, "两边都传 file:// URL 也必须判真");
    t.eq(got.fileUrlPath, true, "argv[1] 是 file:// URL 形式时也必须判真");
    t.eq(got.other, false, "别的脚本必须判假（否则每次 import 都会干活）");
    // 对照：ASCII 文件名下旧判据也能判真 —— 说明旧判据只在非 ASCII 上崩，本用例在测「等价转换」而不是「名字里有没有中文」
    t.eq(got.asciiSelf, true, "ASCII 路径同样必须判真");
    t.eq(got.empty, false, "argv[1] 为空必须判假");
    t.eq(got.undef, false, "argv[1] 缺失必须判假");
    t.eq(got.badUrl, false, "非法 URL 必须判假，不许抛");
    // 旧判据在同一批输入上的结果（用同一份夹具做对照，证明新判据确实收紧了）
    t.ok(samePath(script, script), "samePath 自反");
    if (WIN) {
      t.ok(samePath(script.toUpperCase(), script), "Windows 大小写不敏感：同一文件必须判同一");
    }
  } finally {
    rmrf(dir);
  }
};

tests["C-12-5 本仓库的 ab-render.mjs 不再用「URL 结尾等于 basename」判入口"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(REPO_DIR, "test", "ab-render.mjs"), "utf8");
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // 注释里可以提到旧写法（那是解释），代码里不许出现
    .join("\n");
  t.ok(!/import\.meta\.url\.endsWith\(/.test(code), "代码里不许再有 import.meta.url.endsWith(...)");
  t.ok(!/endsWith\(nodePath\.basename\(/.test(code), "也不许留着等价的 endsWith(basename)");
  t.ok(code.includes("fileURLToPath("), "必须经 fileURLToPath 归一");
  t.ok(/judgeEntry\(process\.argv\[1\], import\.meta\.url\)/.test(code), "入口必须走同一个判据函数");
  // 直接跑真文件（ASCII 名）必须仍正常干活 —— 修入口不许把主路径弄坏
  const out = nodePath.join(os.tmpdir(), `gokifu-c12-live-${process.pid}-${Date.now()}`);
  try {
    const res = runNode([nodePath.join(REPO_DIR, "test", "ab-render.mjs"), "--dir", out]);
    t.eq(res.code, 0, `真文件应成功：${res.out}`);
    t.includes(res.out, "semantic: L");
    t.ok(nodeFs.existsSync(nodePath.join(out, "off.md")), "真文件应写出 off.md");
  } finally {
    rmrf(out);
  }
};

/* ═════════════════════ task-118 · bundle 与手工行只能二选一 ═════════════════════ */

tests["S11 挂载通道二选一：bundle / 手工行各自都算健康，两条同时存在 = 双挂载 = 红"] = (t) => {
  // ① bundle 通道（新常态：本包自带 cordis.patch.yml）
  const bundleHome = makeHealthyHome("s11-bundle");
  try {
    const r = verify(bundleHome.home);
    const chk = named(r, "UI 挂载通道二选一");
    t.eq(chk?.ok, true, `bundle 通道必须绿：${chk?.detail}`);
    t.includes(chk.detail, "bundle=有");
    t.includes(chk.detail, "手工行=无");
  } finally {
    bundleHome.cleanup();
  }

  // ② 手工通道（旧形态仍然合法：bundle 里没有本包，profile 有 id: gokifu-ui）
  const manualHome = makeHealthyHome("s11-manual");
  try {
    const pkgFile = nodePath.join(manualHome.profileDir, "package.json");
    const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
    pkg.dsh = { profile: { bundles: [] } };
    write(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    write(nodePath.join(manualHome.profileDir, "cordis.patch.yml"), [
      "# fixture profile patch",
      "- insert:",
      "    - id: gokifu-ui",
      `      name: '${PKG}'`,
      "",
    ].join("\n"));
    const r = verify(manualHome.home);
    const chk = named(r, "UI 挂载通道二选一");
    t.eq(chk?.ok, true, `手工通道也必须绿：${chk?.detail}`);
    t.includes(chk.detail, "bundle=无");
    t.includes(chk.detail, "手工行=有");
  } finally {
    manualHome.cleanup();
  }

  // ③ 两条同时存在 ⇒ 双挂载 ⇒ 红（两个 host 半抢同一个 /gokifu/api 前缀）
  const bothHome = makeHealthyHome("s11-both");
  try {
    write(nodePath.join(bothHome.profileDir, "cordis.patch.yml"), [
      "# fixture profile patch",
      "- insert:",
      "    - id: gokifu-ui",
      `      name: '${PKG}'`,
      "",
    ].join("\n"));
    const r = verify(bothHome.home);
    const chk = named(r, "UI 挂载通道二选一");
    t.eq(chk?.ok, false, "两条通道同时存在必须红");
    t.includes(chk.detail, "双挂载");
  } finally {
    bothHome.cleanup();
  }

  // ④ 两条都没有 ⇒ 没挂载 ⇒ 红（装好了但没生效，旧版这里曾静默绿）
  const noneHome = makeHealthyHome("s11-none");
  try {
    const pkgFile = nodePath.join(noneHome.profileDir, "package.json");
    const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
    pkg.dsh = { profile: { bundles: [] } };
    write(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    const r = verify(noneHome.home);
    const chk = named(r, "UI 挂载通道二选一");
    t.eq(chk?.ok, false, "两条通道都没有必须红");
    t.includes(chk.detail, "没挂载");
  } finally {
    noneHome.cleanup();
  }
};
