/**
 * verify-install.mjs —— 不重启 DSH 的「挂载校验」
 *
 * 检查 6 组事，任何一条失败都退出码 1：
 *   ① 包已链接进 profile/node_modules，且能读到 package.json（包名 / main / peers）
 *   ② 依赖声明**解析到真实目标**：规格是 link:/file: 时，解析出的目录必须存在、包名必须是我们、
 *     且 profile/node_modules 的实际指向必须与它一致；写版本号时按 registry 安装判（实装在 profile 内）
 *     UI 挂载通道二选一：bundle（dsh.profile.bundles 含本包）或手工行（profile 的 cordis.patch.yml
 *     里有 `id: gokifu-ui`），**两条都在 = 双挂载 = 红**（task-118）
 *   ③ preset 的 compaction group 里是 dsh-gokifu-compact，且没有 compaction-basic（单实例）
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

export const PKG = "dsh-gokifu-compact";
export const DEFAULT_DSH_HOME = "D:\\DeepSeek Harness\\home";

/**
 * @param {{dshHome?:string, profile?:string, preset?:string}} [options]
 * @returns {{checks:{name:string,ok:boolean,detail:string}[], failed:number, install:any, profileDir:string, presetFile:string}}
 */
export function verifyInstall(options = {}) {
  const DSH_HOME = options.dshHome ?? process.env.DSH_HOME ?? DEFAULT_DSH_HOME;
  const PROFILE = options.profile ?? "desktop";
  const PRESET = options.preset ?? "personal-assistant";
  const PROFILE_DIR = nodePath.join(DSH_HOME, "profiles", PROFILE);
  const PRESET_FILE = nodePath.join(DSH_HOME, "preset-bundles", PRESET, "cordis.patch.yml");

  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

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
    const badVersion = Object.entries(peers).filter(([, v]) => /^\^0\.2\.0/.test(v));
    add("peer 版本是精确 0.2.0-rc.2（预发布不能用 ^0.2.0）", badVersion.length === 0, JSON.stringify(peers));
  } else {
    // 包不在时也把这 4 条显式判红 —— 检查项数量恒定（16），门禁才好比对；
    // 悄悄少几条 = 「看着全过其实没查」的另一种假绿。
    const why = "(node_modules 里没有这个包，无法核对)";
    add("包名正确", false, why);
    add("有 main 入口", false, why);
    add("peerDependencies 齐全", false, why);
    add("peer 版本是精确 0.2.0-rc.2（预发布不能用 ^0.2.0）", false, why);
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
    // 同上：文件不在时也把这 5 条显式判红（第一条带路径 + 具体原因），保持检查项总数恒定 16
    // S10c：原因取自 inspectProfileInstall 的 manifestError（ENOENT / 不是合法 JSON / EACCES… 各有措辞）
    const why = `(${install.manifestError ?? `profile/package.json 不存在：${install.profilePkgPath}`}，无法核对)`;
    add("profile/package.json 声明了本包依赖", false, why);
    for (const name of ["依赖规格解析后目标存在（link:/file: 目标目录 / registry 实装）", "解析到的包名是本包", "profile/node_modules 实际指向与依赖规格一致", "UI 挂载通道二选一（bundle 或手工行，不双挂载）"]) {
      add(name, false, why);
    }
  }

  /* ③④⑤ preset */
  if (nodeFs.existsSync(PRESET_FILE)) {
    const text = nodeFs.readFileSync(PRESET_FILE, "utf8");
    add("preset 引用了 dsh-gokifu-compact/engine", text.includes(`${PKG}/engine`) || text.includes(`'${PKG}'`));
    add("preset 里没有 compaction-basic（单实例）", !text.includes("- id: compaction-basic"));
    add("preset 保留 command-compact", text.includes("dsh-command-compact"));
    add("preset 保留 tool-result-pruner", text.includes("dsh-compaction-tool-result-pruner"));
    // 找 chess-context 所在 group 的 isolate
    const engineName = `${PKG}/engine`;
    const idx = text.indexOf(`'${engineName}'`) >= 0 ? text.indexOf(`'${engineName}'`) : text.indexOf(`${PKG}`);
    const before = text.slice(Math.max(0, idx - 2200), idx);
    const iso = before.lastIndexOf("isolate:");
    const isoBlock = iso >= 0 ? before.slice(iso, iso + 120) : "";
    add("引擎行仍在 isolate:{compaction:true} 的 group 内", /compaction:\s*true/.test(isoBlock), isoBlock.replace(/\s+/g, " ").slice(0, 80));
  } else {
    // 同上：preset 文件不在时也补齐 5 条（第一条带路径），保持检查项总数恒定 16
    const why = "(preset 文件不存在，无法核对)";
    add("preset 文件存在", false, PRESET_FILE);
    for (const name of ["preset 引用了 dsh-gokifu-compact/engine", "preset 里没有 compaction-basic（单实例）", "preset 保留 command-compact", "preset 保留 tool-result-pruner"]) {
      add(name, false, why);
    }
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

  const failed = checks.filter((c) => !c.ok).length;
  return { checks, failed, install, profileDir: PROFILE_DIR, presetFile: PRESET_FILE };
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
  console.log(`== verify-install（profile=${profile}, preset=${preset}）==`);
  for (const c of result.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `　— ${c.detail}` : ""}`);
  console.log(result.failed === 0 ? "\n== 全部通过 ==" : `\n== ${result.failed} 项失败 ==`);
  return result.failed === 0 ? 0 : 1;
}

// 同 scripts/install.mjs：经 junction 调用时 argv[1] 是链接路径、import.meta.url 是真身，
// 用 nodePath.resolve 比会判 false ⇒ 什么也不打印、退出码 0（假绿）。必须 realpath 比。
const invokedDirectly = process.argv[1] !== undefined && (samePath(process.argv[1], fileURLToPath(import.meta.url)));
if (invokedDirectly) process.exitCode = main();
