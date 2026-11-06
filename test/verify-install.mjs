/**
 * verify-install.mjs —— 不重启 DSH 的「挂载校验」
 *
 * 检查 6 组事，任何一条失败都退出码 1：
 *   ① 包已链接进 profile/node_modules，且能读到 package.json（包名 / main / peers）
 *      ＋ **宿主版本闸**（F1）：4 条 @deepseek-ai/dsh-* peer 条目齐、每条范围能覆盖宿主版本、
 *      engines.dsh 存在且与 peer 口径一致 —— 判据是结构，不是某个写死的版本字符串。
 *   ② 依赖声明**解析到真实目标**：规格是 link:/file: 时，解析出的目录必须存在、包名必须是我们、
 *     且 profile/node_modules 的实际指向必须与它一致；写版本号时按 registry 安装判（实装在 profile 内）
 *     UI 挂载通道二选一：bundle（dsh.profile.bundles 含本包）或手工行（profile 的 cordis.patch.yml
 *     里有 `id: gokifu-ui`），**两条都在 = 双挂载 = 红**（task-118）
 *   ③ preset 的 compaction group 里是 dsh-gokifu-compact，且没有 compaction-basic（单实例）。
 *      preset 发现**两代兼容**（W5）：新版 = `<home>/profiles/<p>/package.json` 的
 *      `dsh.profile.bundles[]` 声明的 bundle 包（包根 `cordis.patch.yml`，含
 *      `@deepseek-ai/dsh-agent-preset`）；旧版 = `<home>/preset-bundles/<dir>/cordis.patch.yml`。
 *      **两代都找不到 preset** 在「profile 清单可读」时是**合法中间态**（warn，不计入失败）；
 *      但**有 preset 却没挂引擎行**必须红 —— 两种语义分开断言，不许糊成一个布尔。
 *   ④ preset 的 group 仍然 isolate:{compaction:true}（否则整个 preset 挂载失败）
 *   ⑤ preset 里其他 compaction 成员（command-compact / tool-result-pruner）还在
 *   ⑥ 运行期证据：<DSH_HOME>/chess-context/sessions 下有 graph.json（说明 keeper 真跑过）
 *
 * ⚠ ② 的历史坑：旧版只判 `Boolean(pkg.dependencies[PKG])` —— 字符串在就算过。
 *   profile 里写的是 `link:D:/主工作区/projects/dsh-gokifu-compact`（该目录不存在），
 *   于是「目标不存在」也报 ✓。判定必须落到**解析后的真实目标**，见 scripts/link-path.mjs。
 *
 * 用法：node test/verify-install.mjs [--profile desktop] [--preset personal-assistant]
 * 作为模块：import { verifyInstall }，用假 DSH_HOME 跑正负例（test/install-link.test.mjs）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProfileInstall, samePath } from "../scripts/link-path.mjs";
// ★ W5（2026-11-01）：preset 发现复用 W4 的两代兼容实现（新版 bundle / 旧 preset-bundles），
//   不再写死 `<DSH_HOME>/preset-bundles/personal-assistant/cordis.patch.yml`。
//   为什么 import install.mjs 是安全的：它就在 ../scripts/、没有模块级副作用（唯一的
//   `if (invokedDirectly)` 判的是 argv[1]，import 时恒为 false）；而且 test/install-link.test.mjs
//   的 F1/F2 夹具（makeInstalledCopy）本来就会复制 scripts/install.mjs 进「已装包」副本，
//   所以经 junction 执行本文件时这条相对 import 也能解析 —— 不需要第三份内联实现。
import { presetsWithCompaction } from "../scripts/install.mjs";
import { findShadowedUserPresets } from "../src/rooms/preset-format.mjs";

export const PKG = "dsh-gokifu-compact";
export const DEFAULT_DSH_HOME = "D:\\DeepSeek Harness\\home";

/* ═══════════════ 宿主版本闸的结构性判定（F1 · 2026-11-01） ═══════════════
 *
 * 为什么不是「把常量 0.2.0-rc.2 换成 0.2.1-rc.5」：
 *   ① 宿主的兼容判定是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
 *      （dsh-app-boot 的 unmetRequirements）。把范围写成**精确版本**，下一次宿主再升一个
 *      预发布照样卡死 —— 这不是一次事故，是一个会复发的形状。
 *   ② 更硬的一条：`peerDependencies` 在这套宿主里**同时是模块解析路由表**。
 *      dsh-app-boot 的 routeLinked() 只在「祖先目录 package.json 的 peerDependencies 里
 *      出现这个名字」时，把插件里的 `import '@deepseek-ai/dsh-*'` 改指宿主安装目录里的副本；
 *      名字不在 peer 表里 ⇒ 落回原生解析 ⇒ link 安装下 import 不到。
 *      ⇒ 断言必须同时防「值被钉死」和「条目被删」。
 *
 * 所以这里判三件事（而不是比对字符串）：条目齐 / 范围能覆盖宿主版本 / engines.dsh 存在且口径一致。
 * 不引 semver 依赖：本包 dependencies 为空，校验器要能在没装依赖的 profile 里跑。
 */

/** 必须在 peerDependencies 里声明的宿主包（少一条 ⇒ link 安装下 import 不到该副本）。 */
export const DSH_PEERS = [
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
];

/**
 * 解析 `major.minor.patch[-prerelease]`（build metadata 忽略，判版本时它不参与比较）。
 * @param {unknown} text
 * @returns {{major:number,minor:number,patch:number,pre:string[]}|null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split(".") };
}

/**
 * 预发布感知的版本比较（语义同 semver.compare：无预发布 > 同号预发布；数字标识符 < 字母标识符）。
 * @returns {number|NaN} 无法解析时返回 NaN（调用方按「不认识」处理，不猜）
 */
export function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return Number.NaN;
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const width = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < width; i += 1) {
    const p = a.pre[i];
    const q = b.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
      continue;
    }
    if (pNum !== qNum) return pNum ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * 最小满足判定：只认本包实际会用到的两种范围写法 —— `^a.b.c[-pre]` 与精确 `a.b.c[-pre]`。
 * 语义对齐宿主：`semver.satisfies(runtime, range, { includePrerelease: true })`（预发布参与比较）。
 * 其它写法（`~` / `>=` / `||` / 通配）一律判「不认识」→ false，让清单回到可判形态，不静默放行。
 * @param {string} version 待判版本（宿主运行时版本）
 * @param {string} range package.json 里声明的范围
 */
export function satisfies(version, range) {
  if (typeof range !== "string" || parseVersion(version) === null) return false;
  const text = range.trim();
  if (parseVersion(text) !== null) return compareVersion(version, text) === 0;
  const caret = /^\^(.+)$/.exec(text);
  if (caret === null) return false;
  const lower = caret[1].trim();
  const base = parseVersion(lower);
  if (base === null || compareVersion(version, lower) < 0) return false;
  // caret 上界按 semver 的 0.x 语义：0.x 抬 minor，0.0.x 抬 patch，其余抬 major。
  // 上界写成 `X.Y.Z-0`（semver 的 caret 展开就是 `<0.3.0-0` 这种形式）——
  // 少了 `-0` 就会把「下一个版本的预发布」（如 0.3.0-rc.1）误判进范围。
  const upper = base.major > 0 ? `${base.major + 1}.0.0-0` : base.minor > 0 ? `0.${base.minor + 1}.0-0` : `0.0.${base.patch + 1}-0`;
  return compareVersion(version, upper) < 0;
}

/**
 * 范围里能取到的最低版本（`^1.2.3` → `1.2.3`；精确版原样）。
 * @returns {string|null} 不认识的写法返回 null
 */
export function rangeLowerBound(range) {
  if (typeof range !== "string") return null;
  const text = range.trim();
  const caret = /^\^(.+)$/.exec(text);
  const candidate = caret === null ? text : caret[1].trim();
  return parseVersion(candidate) === null ? null : candidate;
}

/**
 * 当前宿主 DSH 版本：显式入参 → 环境变量 → `<DSH_HOME>/dsh-runtimes/<*>/runtime.json` 的 `desktopVersion`
 * （与在跑宿主同一来源）。全部拿不到时返回 null，调用方降级为「只判范围形态」而不是假绿。
 * @param {{dshHome?:string, dshVersion?:string}} [options]
 * @returns {string|null}
 */
export function resolveHostDshVersion(options = {}) {
  const explicit = options.dshVersion ?? process.env.DSH_RUNTIME_VERSION ?? process.env.DSH_VERSION;
  if (typeof explicit === "string" && parseVersion(explicit) !== null) return explicit.trim();
  const home = options.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME;
  const root = nodePath.join(home, "dsh-runtimes");
  if (!nodeFs.existsSync(root)) return null;
  let newest = null;
  for (const entry of nodeFs.readdirSync(root)) {
    const file = nodePath.join(root, entry, "runtime.json");
    if (!nodeFs.existsSync(file)) continue;
    try {
      const version = JSON.parse(nodeFs.readFileSync(file, "utf8")).desktopVersion;
      if (typeof version === "string" && parseVersion(version) !== null && (newest === null || compareVersion(version, newest) > 0)) newest = version.trim();
    } catch {
      /* 读不出的 runtime.json 只是少一个来源，不阻校验（更不许因此判绿） */
    }
  }
  return newest;
}

/**
 * 对一个包清单做版本闸的结构性判定。
 * @param {any} manifest 插件自己的 package.json（已解析）
 * @param {{hostVersion?:string|null}} [options]
 * @returns {{ok:boolean, hostVersion:string|null, peersMissing:string[], rangeProblems:string[], enginesProblems:string[], enginesDetail:string}}
 */
export function evaluateManifest(manifest, options = {}) {
  const hostVersion = options.hostVersion ?? null;
  const peers = manifest?.peerDependencies ?? {};
  const engines = manifest?.engines ?? {};
  const peersMissing = DSH_PEERS.filter((name) => typeof peers[name] !== "string" || peers[name].trim() === "");
  const rangeProblems = [];
  for (const name of DSH_PEERS) {
    const range = peers[name];
    if (typeof range !== "string") continue; // 缺条目由 peersMissing 报，不重复计
    if (parseVersion(range.trim()) !== null) {
      rangeProblems.push(`${name}=${range} 是精确版（宿主一升就卡死，应写范围）`);
      continue;
    }
    if (rangeLowerBound(range) === null) {
      rangeProblems.push(`${name}=${range} 不是本判定支持的范围写法（只认 ^a.b.c 与精确版）`);
      continue;
    }
    if (hostVersion !== null && !satisfies(hostVersion, range)) rangeProblems.push(`${name}=${range} 不满足宿主 ${hostVersion}`);
  }
  const enginesProblems = [];
  const engineRange = typeof engines.dsh === "string" ? engines.dsh.trim() : "";
  if (engineRange === "") enginesProblems.push("缺 engines.dsh（宿主有声明就只按它判，缺了就只能靠 peer 一条条对）");
  else {
    const lower = rangeLowerBound(engineRange);
    if (lower === null) enginesProblems.push(`engines.dsh=${engineRange} 不是本判定支持的范围写法`);
    else
      for (const name of DSH_PEERS) {
        const range = peers[name];
        if (typeof range !== "string" || rangeLowerBound(range) === null) continue;
        if (!satisfies(lower, range)) enginesProblems.push(`engines.dsh 下界 ${lower} 不在 ${name}=${range} 内（两处闸门口径不一致）`);
      }
  }
  return {
    ok: peersMissing.length === 0 && rangeProblems.length === 0 && enginesProblems.length === 0,
    hostVersion,
    peersMissing,
    rangeProblems,
    enginesProblems,
    enginesDetail: `${engineRange === "" ? "engines.dsh=(无)" : `engines.dsh=${engineRange}`}${hostVersion === null ? "｜宿主版本未知" : `｜host=${hostVersion}`}${enginesProblems.length === 0 ? "" : `；${enginesProblems.join("；")}`}`,
  };
}

/**
 * @param {{dshHome?:string, profile?:string, preset?:string, dshVersion?:string}} [options]
 *   `dshVersion` 可显式指定宿主版本（不给则按 DSH_RUNTIME_VERSION / DSH_VERSION / `<DSH_HOME>/dsh-runtimes` 取）
 * @returns {{checks:{name:string,ok:boolean,detail:string,severity?:"error"|"warn"}[], failed:number, warnings:number, install:any, profileDir:string, presetFile:string}}
 *   `failed` **不含**合法中间态的 warn 项（例如新版 home 还没自建 preset）；那些计入 `warnings`。
 */
export function verifyInstall(options = {}) {
  const DSH_HOME = options.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME;
  const PROFILE = options.profile ?? "desktop";
  const PRESET = options.preset ?? "personal-assistant";
  const PROFILE_DIR = nodePath.join(DSH_HOME, "profiles", PROFILE);
  // 旧一代的固定位置：只用于「两代都没找到」时的报错文案（新版 home 没有它，不算错误）。
  const LEGACY_PRESET_FILE = nodePath.join(DSH_HOME, "preset-bundles", PRESET, "cordis.patch.yml");
  // F1：宿主版本只在能拿到时才做「范围覆盖」判定；拿不到就降级为判范围形态（不是判绿）。
  const hostVersion = resolveHostDshVersion({ dshHome: DSH_HOME, dshVersion: options.dshVersion });

  const checks = [];
  /**
   * `severity` 三态：ok / error / warn。
   * 只有 **warn** 是「合法中间态」（例如新版 home 还没自建 preset），不计入 `failed`；
   * 非绿且没标 warn 的一律按 error 计入 `failed`（保持旧调用方「不算红」的判据不漂移）。
   */
  const add = (name, ok, detail = "", severity) => checks.push({ name, ok, detail, ...(ok || severity === undefined ? {} : { severity }) });

  /* ① 包链接 */
  const pkgJson = nodePath.join(PROFILE_DIR, "node_modules", PKG, "package.json");
  const pkgPresent = nodeFs.existsSync(pkgJson);
  add("包已链接进 profile/node_modules", pkgPresent, pkgJson);
  if (pkgPresent) {
    const pkg = JSON.parse(nodeFs.readFileSync(pkgJson, "utf8"));
    add("包名正确", pkg.name === PKG, pkg.name);
    add("有 main 入口", typeof pkg.main === "string" && nodeFs.existsSync(nodePath.resolve(nodePath.dirname(pkgJson), pkg.main)), pkg.main ?? "(none)");
    const peers = pkg.peerDependencies ?? {};
    const want = ["@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-compaction", "@deepseek-ai/dsh-llm", "@deepseek-ai/schemastery"];
    const missing = want.filter((p) => !peers[p]);
    add("peerDependencies 齐全", missing.length === 0, missing.join(", ") || "ok");
    // F1（2026-11-01）：从「比对某个精确版本字符串」改成三条结构性判据 ——
    //   条目齐（删一条宿主就解析不到）、范围能覆盖宿主版本（精确钉死 = 下次升级再炸）、
    //   engines.dsh 存在且与 peer 口径一致（宿主有 engines.dsh 时就只按它判）。
    const gate = evaluateManifest(pkg, { hostVersion });
    add("dsh peer 条目齐全（4 条，删任何一条宿主就解析不到）", gate.peersMissing.length === 0, gate.peersMissing.join(", ") || "ok");
    add(
      "peer 范围覆盖宿主版本（不许钉死精确版）",
      gate.rangeProblems.length === 0,
      gate.rangeProblems.join("；") || (hostVersion === null ? "宿主版本未知，已校验：范围不是精确钉死" : `host=${hostVersion}`),
    );
    add("engines.dsh 存在且与 peer 口径一致", gate.enginesProblems.length === 0, gate.enginesDetail);
  } else {
    // 包不在时也把这 7 条显式判红 —— 检查项数量恒定（18），门禁才好比对；
    // 悄悄少几条 = 「看着全过其实没查」的另一种假绿。
    const why = "(node_modules 里没有这个包，无法核对)";
    add("包名正确", false, why);
    add("有 main 入口", false, why);
    add("peerDependencies 齐全", false, why);
    add("dsh peer 条目齐全（4 条，删任何一条宿主就解析不到）", false, why);
    add("peer 范围覆盖宿主版本（不许钉死精确版）", false, why);
    add("engines.dsh 存在且与 peer 口径一致", false, why);
  }

  /* ② profile/package.json —— 解析到真实目标，不只看字符串 */
  const install = inspectProfileInstall({ dshHome: DSH_HOME, profile: PROFILE, pkgName: PKG });
  if (nodeFs.existsSync(install.profilePkgPath)) {
    const mode = install.local ? install.spec.kind : "registry";
    // S10c：清单读不出来时，第一条就是根因（旧版这里只写 "(无)"，看的人不知道是清单坏了还是没写这条）
    add(
      "profile/package.json 声明了本包依赖",
      install.checks.hasDependency,
      install.manifestError === null ? (install.declared ?? "(无)") : `(读不出依赖：${install.manifestError})`,
    );
    // S10c：这条的 ✗ 详情要一句话说清「到底哪个环节不存在」——
    // 旧文案在「目标目录根本不存在」时也写「(读不到 package.json)」，把根因藏起来了。
    const specDetail = (() => {
      if (install.local) {
        const p = install.spec.path ?? "(无法解析)";
        if (!install.spec.target.exists) return `${install.declared} → ${p}（目标目录不存在）`;
        if (!install.spec.target.isDirectory) return `${install.declared} → ${p}（目标不是目录）`;
        return `${install.declared} → ${p}`;
      }
      return `${install.declared}（${mode}）→ ${install.linkedPath}${install.linked.targetExists ? "" : "（node_modules 里没有它）"}`;
    })();
    add("依赖规格解析后目标存在（link:/file: 目标目录 / registry 实装）", install.checks.specResolves, specDetail);
    // S10c：包名这条只该在「目录真的存在但读不到我们的名字」时给细节；
    // 目录不存在 / 目标不是目录时不许抢话（那是上一条的根因），也不许再写「读不到 package.json」这种含糊说法。
    const packageDetail = install.local
      ? install.spec.target.exists
        ? install.spec.target.isDirectory
          ? `${install.spec.target.packageName ?? `(包名读不出：${install.specPackageNameHint ?? "原因未知"})`}（目标 ${install.spec.target.realPath ?? install.spec.path}）`
          : `(未核对：目标不是目录：${install.spec.path ?? "(无法解析)"})`
        : `(未核对：目标目录不存在：${install.spec.path ?? "(无法解析)"})`
      : install.linked.targetExists
        ? `${install.linkedPackageName ?? `(包名读不出：${install.linkedPackageNameHint ?? "原因未知"})`}`
        : `(未核对：node_modules 里没有 ${PKG} 的链接（或链接已断）：${install.linkedPath})`;
    add("解析到的包名是本包", install.checks.packageMatches, packageDetail);
    const linkDetail = install.local
      ? `实际 → ${install.linked.realPath ?? "(断链)"}｜规格 → ${install.spec.target.realPath ?? (install.spec.target.exists ? "(未解析)" : `(目标目录不存在：${install.spec.path ?? "?"})`)}`
      : `实际 → ${install.linked.realPath ?? "(断链)"}`;
    add("profile/node_modules 实际指向与依赖规格一致", install.checks.linkConsistent, linkDetail);
    // ★ task-118：UI 挂载有两条**语义等价**的通道 ——
    //   bundle（本包自带 cordis.patch.yml，profile 的 dsh.profile.bundles 写本包即自动合并）
    //   与手工行（profile 自己的 cordis.patch.yml 里 `- id: gokifu-ui`）。
    //   两条同时存在 ⇒ 两个 host 半注册同一个 /gokifu/api 前缀 ⇒ 启动失败。
    //   ⇒ 判据从「bundle 里不许有它」改成「**恰好一条**通道」。
    const bundles = install.manifest?.dsh?.profile?.bundles ?? [];
    const profilePatch = nodePath.join(PROFILE_DIR, "cordis.patch.yml");
    const patchText = nodeFs.existsSync(profilePatch) ? nodeFs.readFileSync(profilePatch, "utf8") : "";
    const hasManualRow = /^\s*- id:\s*gokifu-ui\s*$/m.test(patchText);
    const inBundle = bundles.includes(PKG);
    // S10c：清单读不出来时这条不能凭 "?? []" 判绿 —— 那等于没查就说没问题。
    add(
      "UI 挂载通道二选一（bundle 或手工行，不双挂载）",
      install.manifestError === null && inBundle !== hasManualRow,
      install.manifestError === null
        ? `bundle=${inBundle ? "有" : "无"}｜手工行=${hasManualRow ? "有" : "无"}${inBundle && hasManualRow ? "（两条都在 = 双挂载）" : inBundle || hasManualRow ? "" : "（两条都没有 = 没挂载）"}`
        : `（未核对：${install.manifestError}）`,
    );
  } else {
    // 同上：文件不在时也把这 5 条显式判红（第一条带路径 + 具体原因），保持检查项总数恒定 18
    // S10c：原因取自 inspectProfileInstall 的 manifestError（ENOENT / 不是合法 JSON / EACCES… 各有措辞）
    const why = `(${install.manifestError ?? `profile/package.json 不存在：${install.profilePkgPath}`}，无法核对)`;
    add("profile/package.json 声明了本包依赖", false, why);
    for (const name of ["依赖规格解析后目标存在（link:/file: 目标目录 / registry 实装）", "解析到的包名是本包", "profile/node_modules 实际指向与依赖规格一致", "UI 挂载通道二选一（bundle 或手工行，不双挂载）"]) {
      add(name, false, why);
    }
  }

  /* ③④⑤ preset —— 两代兼容发现（W5）。
   *
   * 为什么不能只看 `<home>/preset-bundles/<预设名>/`：新版 DSH（0.2.1-rc.5）**没有这个目录**，
   * 用户 preset 改成「bundle 包 + `dsh.profile.bundles` 声明」。发现的唯一来源是
   * `scripts/install.mjs` 的 `presetsWithCompaction()`（与 UI 半的 findPresetFiles 同构），
   * 这里不再自拼路径，避免第三份实现漂移。
   *
   * 语义（核心，别糊成一个布尔）：
   *   · 两代都找不到 preset + **profile 清单可读** ⇒ **合法中间态**：标 `severity:"warn"`，
   *     不计入 failed（新版 home 还没自建 preset 是正常过程，不是错误）；
   *   · 找到了 preset 但里面没有 `dsh-gokifu-compact/engine` ⇒ **红**（有 preset 却没挂引擎）；
   *   · profile 清单都读不出（空 home / 坏 JSON）⇒ 无法区分「还没初始化」与「--home 指错了」，
   *     preset 组保持红（与「空 home 18/18 红」的既有门禁同口径，不许当中间态放行）。
   */
  const presets = presetsWithCompaction(DSH_HOME, PROFILE);
  // 多个 preset 时优先体检「已经挂了引擎行」的那个，避免旧的多 preset home 误报。
  const preset = presets.find((p) => p.text.includes(`${PKG}/engine`)) ?? presets[0] ?? null;
  const homeManifestReadable = install.manifestError === null && install.manifest !== null;
  /** 这次「找不到 preset」是不是合法中间态（只影响非绿项的 severity，不影响 ok）。 */
  const presetAbsentIsLegal = presets.length === 0 && homeManifestReadable;
  const addPreset = (name, ok, detail) => add(name, ok, detail, ok ? undefined : presetAbsentIsLegal ? "warn" : "error");
  if (preset !== null) {
    const text = preset.text;
    addPreset("preset 引用了 dsh-gokifu-compact/engine", text.includes(`${PKG}/engine`) || text.includes(`'${PKG}'`), preset.file);
    addPreset("preset 里没有 compaction-basic（单实例）", !text.includes("- id: compaction-basic"), preset.file);
    addPreset("preset 保留 command-compact", text.includes("dsh-command-compact"), preset.file);
    addPreset("preset 保留 tool-result-pruner", text.includes("dsh-compaction-tool-result-pruner"), preset.file);
    // 找 chess-context 所在 group 的 isolate
    const engineName = `${PKG}/engine`;
    const idx = text.indexOf(`'${engineName}'`) >= 0 ? text.indexOf(`'${engineName}'`) : text.indexOf(`${PKG}`);
    const before = text.slice(Math.max(0, idx - 2200), idx);
    const iso = before.lastIndexOf("isolate:");
    const isoBlock = iso >= 0 ? before.slice(iso, iso + 120) : "";
    addPreset("引擎行仍在 isolate:{compaction:true} 的 group 内", /compaction:\s*true/.test(isoBlock), isoBlock.replace(/\s+/g, " ").slice(0, 80));
  } else {
    // 找不到 preset 时也补齐 5 条（总数恒为 18），保持门禁可比对。
    // 文案同时保留「preset 文件不存在，无法核对」这个旧串（既有断言按它匹配），
    // 后面再补一句人类可读的结论：合法中间态 ? 怎么修 : 为什么红。
    const conclusion = presetAbsentIsLegal
      ? "两代都未发现含 compaction 的 preset —— 新版 home 需先自建 preset bundle 再跑 install；这是合法中间态，不是失败"
      : "两代都未发现含 compaction 的 preset，且 profile 清单读不出 —— 无法确认这是有效的 DSH home（检查 --home / profile 名）";
    const why = `(preset 文件不存在，无法核对)；${conclusion}`;
    addPreset("preset 文件存在", false, `${LEGACY_PRESET_FILE}（${conclusion}）`);
    for (const name of ["preset 引用了 dsh-gokifu-compact/engine", "preset 里没有 compaction-basic（单实例）", "preset 保留 command-compact", "preset 保留 tool-result-pruner"]) {
      addPreset(name, false, why);
    }
  }

  /* ⑦ 用户层 patch 是否遮蔽引擎 / 机器级层是否已登记（2026-11-02 实机事故；1.17.1 自动登记）
     遮蔽 + home 层已有 engine ⇒ 视为通过（等下次启动）；遮蔽 + 没有 ⇒ 记 warn（非失败），
     因为插件会在退出时自动写 home 层，用户不需要命令。 */
  {
    const userPatch = nodePath.join(PROFILE_DIR, "cordis.patch.yml");
    let shadowed = [];
    let homeHasEngine = false;
    try {
      const text = nodeFs.existsSync(userPatch) ? nodeFs.readFileSync(userPatch, "utf8") : "";
      shadowed = findShadowedUserPresets(text);
      const homePatch = nodePath.join(DSH_HOME, "cordis.patch.yml");
      homeHasEngine = nodeFs.existsSync(homePatch) && nodeFs.readFileSync(homePatch, "utf8").includes("dsh-gokifu-compact/engine");
    } catch {
      /* 读不出按未采集处理 */
    }
    add(
      "用户层 patch 不遮蔽压缩引擎",
      shadowed.length === 0 || homeHasEngine,
      shadowed.length === 0
        ? "用户层没有把 preset 写回 compaction-basic"
        : homeHasEngine
          ? `${shadowed.join(", ")} 已被机器级层接管（重启后生效）`
          : `${shadowed.join(", ")} 写回了 compaction-basic；插件退出时会自动登记到 home/cordis.patch.yml，下次启动生效`,
      shadowed.length > 0 && !homeHasEngine ? "warn" : undefined,
    );
  }


  /* ⑥ 运行期证据 */
  const graphRoot = nodePath.join(DSH_HOME, "chess-context", "sessions");
  let graphs = [];
  if (nodeFs.existsSync(graphRoot)) {
    for (const d of nodeFs.readdirSync(graphRoot)) {
      const f = nodePath.join(graphRoot, d, "graph.json");
      if (nodeFs.existsSync(f)) graphs.push({ dir: d, size: nodeFs.statSync(f).size, mtime: nodeFs.statSync(f).mtime });
    }
  }
  add("运行期已产出棋谱（keeper 真跑过）", graphs.length > 0, graphs.length ? `${graphs.length} 个会话，最新 ${graphs.sort((a, b) => b.mtime - a.mtime)[0].dir.slice(0, 24)}… (${graphs[0]?.size ?? 0}B)` : "无 graph.json");

  // failed = 真失败（不含合法中间态的 warn）；warnings = 中性提示数。
  // 注意：非绿的 warn 项 `ok` 仍是 false（旧调用方用 `checks.filter(c => !c.ok)` 数「非绿项」不受影响），
  // 但不再算进 failed —— 这就是「没有 preset」与「有 preset 但没挂」两种语义的分界。
  const failed = checks.filter((c) => !c.ok && c.severity !== "warn").length;
  const warnings = checks.filter((c) => c.severity === "warn").length;
  // presetName 给 CLI 头部展示用（两代发现到的真实名字；没有就是 null）——**仅展示，不参与判据/退出码**。
  return { checks, failed, warnings, install, profileDir: PROFILE_DIR, presetFile: preset?.file ?? LEGACY_PRESET_FILE, presetName: preset?.name ?? null };
}

/** 命令行入口：打印 + 退出码。 */
export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const profile = getArg("profile", "desktop");
  const preset = getArg("preset", "personal-assistant");
  const result = verifyInstall({ profile, preset });
  // W-B：头部不再印死 --preset 的旧默认名（personal-assistant 在新版 home 已不存在）；
  // 印两代发现到的真实 preset 名，没有就 (none)。**纯展示**，18 条判据/severity/退出码都没动。
  console.log(`== verify-install（profile=${profile}, preset=${result.presetName ?? "(none)"}）==`);
  // 三态：✓ 绿 / ✗ 真失败 / ! 合法中间态（例如新版 home 还没自建 preset —— 不算失败）
  for (const c of result.checks) {
    const mark = c.ok ? "✓" : c.severity === "warn" ? "!" : "✗";
    console.log(`  ${mark} ${c.name}${c.detail ? `　— ${c.detail}` : ""}`);
  }
  const summary =
    result.failed === 0
      ? `全部通过${result.warnings > 0 ? `（${result.warnings} 项提示：合法中间态，不计失败）` : ""}`
      : `${result.failed} 项失败${result.warnings > 0 ? ` / ${result.warnings} 项提示（合法中间态，不计失败）` : ""}`;
  console.log(String.fromCharCode(10) + `== ${summary} ==`);
  return result.failed === 0 ? 0 : 1;
}

// 同 scripts/install.mjs：经 junction 调用时 argv[1] 是链接路径、import.meta.url 是真身，
// 用 nodePath.resolve 比会判 false ⇒ 什么也不打印、退出码 0（假绿）。必须 realpath 比。
const invokedDirectly = process.argv[1] !== undefined && (samePath(process.argv[1], fileURLToPath(import.meta.url)));
if (invokedDirectly) process.exitCode = main();
