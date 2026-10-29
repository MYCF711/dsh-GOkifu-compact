/**
 * link-path.mjs —— `link:` / `file:` 依赖规格的**解析与身份判定**（安装器、挂载校验、doctor 共用一份）
 *
 * 为什么单独一个文件：这个缺陷踩过两次，都是「只看字符串、不看解析后的真实目标」——
 *   · `scripts/install.mjs` 以前：只要 `dependencies[pkg]` 存在就跳过 ⇒ 指向不存在的目录也永远不修
 *   · `test/verify-install.mjs` 以前：只查 `link:` 前缀 ⇒ 目标不存在也报 ✓（假绿）
 * 一个实现、三处调用，才不会有第二条路径绕过修复。
 *
 * 事实依据（本轮实测，见 tmp/dsh-gokifu-compact/install-link/）：
 *   · pnpm（DSH 自带 v11.7.0）对 `link:<不存在的目录>` **退出码 0**，只打一行
 *     `[WARN] Installing a dependency from a non-existent directory`，并且**不建任何链接**
 *     ⇒ 「重装即坏」不是报错，是静默少一个包；靠退出码的门禁看不见它。
 *   · `link:` 支持绝对路径与相对路径（相对 = 相对 profile 目录，即 package.json 所在目录）；
 *     DSH 的 `anchorPathSpec`（asar `dsh-plugin-manager/lib/index.js:215-219`）只把 `./x`、`../x`
 *     锚成绝对路径，绝对路径原样透传给 pnpm ⇒ 两种写法都在契约内。
 *   · Windows 大小写不敏感：`link:.../SRC-Real` 与 `.../src-real` 是同一个目录，pnpm 也能链上
 *     ⇒ 判定必须用 realpath（会规范化大小写），不能用字符串比较，否则会造出**假 RED**。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";

/** `link:` / `file:` 前缀（pnpm 的两种本地协议；`portal:` 语义不同，不收）。 */
const LOCAL_SPEC_RE = /^(link|file):(.*)$/i;

/**
 * 把一条依赖规格拆成「协议 + 路径文本」。
 * @param {unknown} spec package.json dependencies 里的值
 * @returns {{kind:"empty"|"link"|"file"|"other", raw:string, pathText:string|null}}
 */
export function parseSpec(spec) {
  const raw = typeof spec === "string" ? spec.trim() : "";
  if (raw.length === 0) return { kind: "empty", raw, pathText: null };
  const m = LOCAL_SPEC_RE.exec(raw);
  if (!m) return { kind: "other", raw, pathText: null };
  const pathText = m[2].trim();
  return { kind: pathText.length === 0 ? "empty" : m[1].toLowerCase(), raw, pathText: pathText.length === 0 ? null : pathText };
}

/**
 * 解析规格里的路径文本为绝对路径。
 * 相对路径按 pnpm 契约从 `baseDir`（profile 目录）起算；Windows 下顺手认 MSYS 风格 `/d/x`
 * （那是 Git Bash 的路径，直接 `path.resolve` 会变成 `D:\d\x` 这种不存在的怪路径）。
 */
export function resolveSpecPath(pathText, baseDir) {
  if (typeof pathText !== "string" || pathText.length === 0) return null;
  let text = pathText;
  if (WIN && /^\/[A-Za-z]\//.test(text)) text = `${text[1].toUpperCase()}:${text.slice(2)}`;
  return nodePath.resolve(baseDir, text);
}

/** realpath（规范化大小写、跟随 junction）；不存在返回 null。 */
export function realPathOrNull(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  try {
    return nodeFs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** 两个路径是不是同一个真实位置。Windows 下大小写不敏感；任一侧不存在时退化为 resolve + 小写比较。 */
export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const ra = realPathOrNull(a) ?? nodePath.resolve(a);
  const rb = realPathOrNull(b) ?? nodePath.resolve(b);
  return WIN ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** 读目录下 package.json 的 name；读不到返回 null（不抛）。 */
export function readPackageName(dir) {
  try {
    const file = nodePath.join(dir, "package.json");
    const pkg = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * 说清「为什么读不到 package.json」（S10c）。
 * 为什么要分档：旧文案只有一句「读不到 package.json」，而目标目录**根本不存在**时也是这一句
 * —— 看的人会去查 JSON 语法，真正的根因（link: 指向一个不存在的目录）被藏起来。
 *
 * ⚠ 先判 `dir` 本身、再判 `dir/package.json`：旧版只 `statSync(<dir>/package.json)`，
 *   于是「dir 是个文件（ENOTDIR）」「package.json 本身是个目录」两种情形都被说成「package.json 不存在」，
 *   又把「package.json 是目录」错标成「路径不是目录」（那是 dir 的问题，不是文件的问题）。
 * @returns {"package.json 不存在"|"路径不是目录"|"package.json 不是文件"|"package.json 不是合法 JSON"|"package.json 里没有 name"|"package.json 读取失败"|null}
 */
export function describePackageNameFailure(dir) {
  if (typeof dir !== "string" || dir.length === 0) return "package.json 不存在";
  let dirStat;
  try {
    dirStat = nodeFs.statSync(dir);
  } catch (error) {
    // dir 自己就不存在时，最贴切的说法仍是「package.json 不存在」（没有目录自然没有清单）
    return error.code === "ENOENT" ? "package.json 不存在" : `package.json 读取失败（${error.code ?? error.message}）`;
  }
  if (!dirStat.isDirectory()) return "路径不是目录";
  const file = nodePath.join(dir, "package.json");
  let st;
  try {
    st = nodeFs.statSync(file);
  } catch (error) {
    return error.code === "ENOENT" ? "package.json 不存在" : `package.json 读取失败（${error.code ?? error.message}）`;
  }
  if (!st.isFile()) return "package.json 不是文件";
  let text;
  try {
    text = nodeFs.readFileSync(file, "utf8");
  } catch (error) {
    return `package.json 读取失败（${error.code ?? error.message}）`;
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return "package.json 不是合法 JSON";
  }
  return typeof pkg?.name === "string" ? null : "package.json 里没有 name";
}

/**
 * 看一条链接/目录**自己**（不跟随）的状态。
 * 为什么不用 existsSync：断掉的 junction 目录项存在、但 existsSync 返回 false，
 * 而安装器正好需要区分「没有」「有但是断链」「有且指向别处」三种情况。
 */
export function statLink(p) {
  let st = null;
  try {
    st = nodeFs.lstatSync(p);
  } catch {
    return { present: false, isLink: false, targetExists: false, realPath: null, readlink: null, isRealDirectory: false };
  }
  const isLink = st.isSymbolicLink();
  let readlink = null;
  if (isLink) {
    try {
      readlink = nodeFs.readlinkSync(p);
    } catch {
      readlink = null;
    }
  }
  const realPath = realPathOrNull(p);
  return {
    present: true,
    isLink,
    isRealDirectory: st.isDirectory() && !isLink,
    targetExists: realPath !== null,
    realPath,
    readlink,
  };
}

/**
 * 解析一条依赖规格并核对它指向的真实目录。
 * @returns {{
 *   kind:string, raw:string, pathText:string|null, path:string|null,
 *   target:{exists:boolean, isDirectory:boolean, realPath:string|null, packageName:string|null},
 *   ok:boolean
 * }}
 */
export function inspectSpec(spec, baseDir) {
  const parsed = parseSpec(spec);
  const abs = parsed.kind === "link" || parsed.kind === "file" ? resolveSpecPath(parsed.pathText, baseDir) : null;
  const real = realPathOrNull(abs);
  let isDirectory = false;
  if (real !== null) {
    try {
      isDirectory = nodeFs.statSync(real).isDirectory();
    } catch {
      isDirectory = false;
    }
  }
  const packageName = isDirectory ? readPackageName(real) : null;
  return {
    ...parsed,
    path: abs,
    target: { exists: real !== null, isDirectory, realPath: real, packageName },
    ok: real !== null && isDirectory,
  };
}

/**
 * 读一个 profile 的安装态：依赖规格（字符串）+ 它解析到的目标 + node_modules 里那个链接。
 * 这是 install / verify-install / doctor 共用的**唯一**判据来源。
 */
export function inspectProfileInstall({ dshHome, profile = "desktop", pkgName }) {
  const profileDir = nodePath.join(dshHome, "profiles", profile);
  const profilePkgPath = nodePath.join(profileDir, "package.json");
  /** 读/解析 profile/package.json 失败的种类：null（成功）| ENOENT | EACCES | … | "invalid-json" | "invalid-shape" */
  let manifestErrorKind = null;
  let manifestError = null;
  let manifest = null;
  try {
    const text = nodeFs.readFileSync(profilePkgPath, "utf8");
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      manifestErrorKind = "invalid-json";
      manifestError = `${profilePkgPath} 不是合法 JSON（${error.message}）`;
    }
    if (manifestErrorKind === null && (manifest === null || typeof manifest !== "object")) {
      manifestErrorKind = "invalid-shape";
      const got = manifest === null ? "null" : Array.isArray(manifest) ? "数组" : typeof manifest;
      manifestError = `${profilePkgPath} 的顶层不是对象（JSON 是 ${got}）`;
      manifest = null;
    }
  } catch (error) {
    // ENOENT = 文件/目录不存在；别的（EISDIR/EACCES/EBUSY…）原样报，不许都写成「读不到」。
    manifestErrorKind = error.code ?? "read-error";
    manifestError =
      error.code === "ENOENT"
        ? `profile/package.json 不存在：${profilePkgPath}`
        : `profile/package.json 读取失败（${error.code ?? error.message}）：${profilePkgPath}`;
  }
  const declared = manifest?.dependencies?.[pkgName] ?? null;
  const spec = declared === null ? null : inspectSpec(declared, profileDir);
  const linkedPath = nodePath.join(profileDir, "node_modules", pkgName);
  const linked = statLink(linkedPath);
  /** node_modules/<pkg> 这一侧读不到包名时的原因（与 manifestError 同族，供 ✗ 详情用）；读到为 null。 */
  const linkedPackageNameHint = linked.targetExists ? describePackageNameFailure(linkedPath) : null;

  // 链接模式（link:/file:）：node_modules 必须指向规格解析出来的那个真实目录。
  // registry 模式（版本号）：node_modules 必须是落在 profile 内的一份实装，包名要对。
  const local = spec !== null && (spec.kind === "link" || spec.kind === "file");
  const linkedPackageName = linked.targetExists ? readPackageName(linkedPath) : null;
  const profileReal = realPathOrNull(profileDir) ?? profileDir;
  const sep = WIN ? "\\" : "/";
  const linkedInsideProfile =
    linked.realPath !== null &&
    (WIN ? linked.realPath.toLowerCase() : linked.realPath).startsWith(
      (WIN ? profileReal.toLowerCase() : profileReal) + sep,
    );

  const hasDependency = declared !== null && String(declared).trim().length > 0;
  const specResolves = local ? spec.ok : linked.targetExists;
  const specPackageName = local ? spec.target.packageName : linkedPackageName;
  /** 本地目录读不到包名时的**具体**原因（目录里的 package.json 缺失 / 不是 JSON / 没有 name）；读到了为 null。 */
  const specPackageNameHint = local && specPackageName === null && spec.target.isDirectory
    ? describePackageNameFailure(spec.target.realPath)
    : null;
  const packageNameHint = local ? specPackageNameHint : linkedPackageNameHint;
  const packageMatches = specPackageName === pkgName;
  const linkConsistent = local
    ? linked.targetExists && spec.ok && samePath(linked.realPath, spec.target.realPath)
    : linked.targetExists && linkedInsideProfile;

  return {
    dshHome,
    profile,
    profileDir,
    profilePkgPath,
    manifest,
    manifestError,
    manifestErrorKind,
    pkgName,
    declared,
    spec,
    local,
    linkedPath,
    linked,
    linkedPackageName,
    linkedPackageNameHint,
    specPackageNameHint,
    packageNameHint,
    linkedInsideProfile,
    checks: { hasDependency, specResolves, packageMatches, linkConsistent },
    /**
     * 人类可读的失败原因（第一条不过的）。
     * S10c：这里必须落到**真实根因**上 —— 清单读不出（ENOENT / 不是合法 JSON / 权限）、目标目录不存在、
     * 目标不是目录、目标里缺 package.json，各有各的话；旧版一律写「profile/package.json 没有 X 依赖」，
     * 清单**根本不存在**时也这么说 ⇒ 看的人去查依赖声明，真正的根因（清单缺失/坏 JSON）被藏起来。
     * （`scripts/doctor.mjs` 直接把它当详情打印，所以这句就是用户看到的那行。）
     */
    failure: (() => {
      if (manifestError !== null) return `依赖声明无法核对：${manifestError}`;
      if (!hasDependency) return `profile/package.json 没有 ${pkgName} 依赖`;
      if (!specResolves) {
        if (!local) return `node_modules 里没有可用的 ${pkgName}`;
        const p = spec.path ?? "(无法解析)";
        if (!spec.target.exists) return `依赖 ${declared} 解析后的目录不存在：${p}`;
        if (!spec.target.isDirectory) return `依赖 ${declared} 解析到的不是目录：${p}`;
        return `依赖 ${declared} 解析后不可用：${p}`;
      }
      if (!packageMatches) {
        if (specPackageName !== null) return `解析到的包名是 ${specPackageName}，不是 ${pkgName}`;
        const hint = packageNameHint ?? "原因未知";
        return local
          ? `目标目录 ${spec.target.realPath ?? spec.path ?? "(未知)"} 里的 package.json 读不出包名：${hint}`
          : `profile/node_modules 里的 ${pkgName} 读不出包名：${hint}`;
      }
      if (!linkConsistent) {
        return `node_modules 实际指向 ${linked.realPath ?? "(断链)"}，与依赖规格 ${spec?.target?.realPath ?? declared} 不一致`;
      }
      return null;
    })(),
  };
}

/** 生成写进 package.json 的规格：绝对路径 + 正斜杠（本仓库既有契约）。 */
export function toLinkSpec(absPath) {
  return `link:${String(absPath).replace(/\\/g, "/")}`;
}

/**
 * 建目录链接。优先用 Node 自带的 junction（不经 shell，中文/空格路径不会被引号规则咬到，
 * 也不需要管理员权限）；失败才退回 `cmd /c mklink /J`。
 * @returns {"junction"|"mklink"}
 */
export function createDirLink(target, dest) {
  const absTarget = nodePath.resolve(target);
  nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
  try {
    nodeFs.symlinkSync(absTarget, dest, "junction");
    return "junction";
  } catch (error) {
    if (!WIN) throw error;
    execFileSync("cmd", ["/c", "mklink", "/J", dest, absTarget], { stdio: "ignore" });
    return "mklink";
  }
}

/** 删目录链接（只删链接本身，绝不递归删目标内容）。真目录不删，返回 false。 */
export function removeDirLink(dest) {
  const st = statLink(dest);
  if (!st.present || !st.isLink) return false;
  nodeFs.rmSync(dest);
  return !statLink(dest).present;
}
