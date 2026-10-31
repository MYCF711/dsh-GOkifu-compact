/**
 * release-hardening.test.mjs —— 发布脚本的加固回归（2026-10-31 事故的直接产物）
 *
 * 事故：仓库 `.git/config` 的 `remote.origin.url` 被写成 `git+https://github.com/…`（非法 scheme），
 * `release.mjs` 体检**照样通过** ⇒ 真做时 `git push` 全崩，但脚本继续建 Release、继续 `npm publish`，
 * 留下「npm 已发 / Release 已建 / main 没推 / tag 指向旧 commit」的半途状态。
 *
 * 本文件钉四件事：
 *   ① `parseRepo` 只认 ssh 与 https 两种写法，`git+*` / `file://` / 空 一律 null；
 *   ② `classifyRemote` 对 `git+*` 给出**可执行的修法**（不是一句「不是 GitHub 仓库」）；
 *   ③ `runTransaction` **首步失败即中止**，后面的步骤一次都不执行（这是「git 成功后才 npm/Release」的结构保证）；
 *   ④ 真脚本在坏 remote 的临时仓库里**预演就红**（exit 1），且错误信息点名 scheme 问题。
 *
 * 全程离线：临时仓库用 `git init`，不发网络请求（坏 remote 在 ls-remote 之前就被拒）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseRepo, classifyRemote, runTransaction, checkTestFileCount, declaredTestFiles, declaredTestFilesAll, compareReleaseTrees, isOnlyBinNormalization } from "../scripts/release-lib.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "release.mjs");

const t = {};
export const tests = t;

// ── ① parseRepo ───────────────────────────────────────────────────────

t["RH-1 parseRepo：scp 式 ssh / ssh:// / https / 带 .git 后缀都认"] = () => {
  const cases = [
    ["git@github.com:MYCF711/dsh-GOkifu-compact.git", "MYCF711", "dsh-GOkifu-compact"],
    ["git@github.com:MYCF711/dsh-GOkifu-compact", "MYCF711", "dsh-GOkifu-compact"],
    ["https://github.com/MYCF711/dsh-GOkifu-compact.git", "MYCF711", "dsh-GOkifu-compact"],
    ["https://github.com/MYCF711/dsh-GOkifu-compact", "MYCF711", "dsh-GOkifu-compact"],
    ["https://github.com/MYCF711/dsh-GOkifu-compact/", "MYCF711", "dsh-GOkifu-compact"],
    ["ssh://git@github.com/MYCF711/dsh-GOkifu-compact.git", "MYCF711", "dsh-GOkifu-compact"],
    ["ssh://git@github.com:443/MYCF711/dsh-GOkifu-compact", "MYCF711", "dsh-GOkifu-compact"],
  ];
  for (const [url, owner, repo] of cases) {
    const got = parseRepo(url);
    if (!got) throw new Error(`应识别为 GitHub 仓库但返回 null：${url}`);
    if (got.owner !== owner || got.repo !== repo) {
      throw new Error(`${url} ⇒ ${JSON.stringify(got)}，期望 ${owner}/${repo}`);
    }
  }
};

t["RH-2 parseRepo：git+https / git+ssh / file:// / 空 / 非 github 一律 null"] = () => {
  const bad = [
    "git+https://github.com/MYCF711/dsh-GOkifu-compact.git",
    "git+ssh://git@github.com/MYCF711/dsh-GOkifu-compact.git",
    "file:///d/repo.git",
    "",
    "   ",
    "https://gitlab.com/a/b.git",
    "git@gitlab.com:a/b.git",
  ];
  for (const url of bad) {
    if (parseRepo(url) !== null) throw new Error(`不该识别为 GitHub 仓库：${JSON.stringify(url)}`);
  }
};

// ── ② classifyRemote ──────────────────────────────────────────────────

t["RH-3 classifyRemote：git+ 被拒且给出「怎么改」；合法 ssh 通过"] = () => {
  const bad = classifyRemote("git+https://github.com/MYCF711/dsh-GOkifu-compact.git");
  if (bad.ok) throw new Error("git+https 必须被拒");
  if (!/git\+/.test(bad.reason)) throw new Error(`理由要点名 git+ 协议：${bad.reason}`);
  if (!/git remote set-url/.test(bad.reason)) throw new Error(`理由要给可执行的修法：${bad.reason}`);

  const empty = classifyRemote("");
  if (empty.ok) throw new Error("空 remote 必须被拒");

  const good = classifyRemote("git@github.com:MYCF711/dsh-GOkifu-compact.git");
  if (!good.ok) throw new Error(`合法 ssh remote 应通过：${good.reason}`);
  if (good.repo.owner !== "MYCF711" || good.repo.repo !== "dsh-GOkifu-compact") {
    throw new Error(`解析错了：${JSON.stringify(good.repo)}`);
  }
};

// ── ③ runTransaction ──────────────────────────────────────────────────

t["RH-4 runTransaction：全成功时按序执行，done 顺序一致"] = () => {
  const calls = [];
  const r = runTransaction([
    { name: "a", run: () => calls.push("a") },
    { name: "b", run: () => calls.push("b") },
    { name: "c", run: () => calls.push("c") },
  ]);
  if (!r.ok) throw new Error("应成功");
  if (calls.join(",") !== "a,b,c") throw new Error(`执行顺序错：${calls.join(",")}`);
  if (r.done.join(",") !== "a,b,c") throw new Error(`done 顺序错：${r.done.join(",")}`);
  if (r.aborted.length !== 0) throw new Error("不该有 aborted");
};

t["RH-5 runTransaction：首步失败 ⇒ 后面一步都不执行（这就是「push 成功才 npm/Release」）"] = () => {
  const calls = [];
  const r = runTransaction([
    { name: "push", run: () => { calls.push("push"); throw new Error("remote helper 挂了"); } },
    { name: "tag", run: () => calls.push("tag") },
    { name: "npm", run: () => calls.push("npm") },
    { name: "release", run: () => calls.push("release") },
  ]);
  if (r.ok) throw new Error("应失败");
  if (calls.join(",") !== "push") throw new Error(`失败后不得继续执行副作用，实际调用：${calls.join(",")}`);
  if (r.failed !== "push") throw new Error(`failed 应为 push，实际 ${r.failed}`);
  if (r.aborted.join(",") !== "tag,npm,release") throw new Error(`aborted 应列出剩余步骤：${r.aborted.join(",")}`);
};

t["RH-6 runTransaction：中间步失败 ⇒ 之前的保留、之后的零调用"] = () => {
  const calls = [];
  const r = runTransaction([
    { name: "push", run: () => calls.push("push") },
    { name: "tag", run: () => { calls.push("tag"); throw new Error("tag 冲突"); } },
    { name: "npm", run: () => calls.push("npm") },
  ]);
  if (r.ok) throw new Error("应失败");
  if (calls.join(",") !== "push,tag") throw new Error(`实际调用：${calls.join(",")}`);
  if (r.done.join(",") !== "push") throw new Error(`done 应只含已成功的：${r.done.join(",")}`);
  if (r.aborted.join(",") !== "npm") throw new Error(`aborted 应含 npm：${r.aborted.join(",")}`);
};

// ── ④ 真脚本：坏 remote 在预演阶段就红 ────────────────────────────────

/** 造一个最小可跑的临时仓库（不联网）。 */
function makeRepo(remoteUrl, { version = "9.9.9" } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rel-hardening-"));
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  nodeFs.writeFileSync(
    nodePath.join(dir, "package.json"),
    JSON.stringify({ name: "rel-hardening-fixture", version }, null, 2),
  );
  nodeFs.writeFileSync(
    nodePath.join(dir, "CHANGELOG.md"),
    `# 更新记录\n\n## ${version} — 2026-10-31\n\n- fixture\n`,
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["remote", "add", "origin", remoteUrl]);
  return dir;
}

function runScript(dir) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

t["RH-7 真脚本：git+https remote ⇒ 预演就 exit 1 且点名协议问题"] = () => {
  const dir = makeRepo("git+https://github.com/MYCF711/dsh-GOkifu-compact.git");
  try {
    const { code, out } = runScript(dir);
    if (code !== 1) throw new Error(`应 exit 1，实际 ${code}\n${out.slice(0, 400)}`);
    if (!/git\+/.test(out)) throw new Error(`输出没点名 git+ 协议：\n${out.slice(0, 400)}`);
    if (!/体检没通过/.test(out)) throw new Error(`应走「体检没通过」分支：\n${out.slice(0, 400)}`);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

t["RH-8 真脚本：file:// remote ⇒ 预演就 exit 1（不是 GitHub）"] = () => {
  const dir = makeRepo("file:///tmp/whatever.git");
  try {
    const { code, out } = runScript(dir);
    if (code !== 1) throw new Error(`应 exit 1，实际 ${code}\n${out.slice(0, 400)}`);
    if (!/不是 GitHub 仓库/.test(out)) throw new Error(`应说明不是 GitHub 仓库：\n${out.slice(0, 400)}`);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

// ── ⑤ 源码结构：git 步骤必须排在 npm / Release 之前 ────────────────────

t["RH-9 源码顺序：runTransaction(push,tag) → npm → Release，且失败走 abort"] = () => {
  const src = nodeFs.readFileSync(SCRIPT, "utf8");
  const iTx = src.indexOf("runTransaction(");
  const iAbort = src.indexOf("已中止");
  const iNpm = src.indexOf("npmScript");
  // 锚点用执行段里的 `let released = false` —— plan 里也出现过 POST /repos/，不能用它
  const iRelease = src.indexOf("let released = false");
  for (const [name, i] of [["runTransaction", iTx], ["abort", iAbort], ["npm", iNpm], ["Release", iRelease]]) {
    if (i < 0) throw new Error(`release.mjs 里找不到 ${name} 的锚点 —— 结构被改过了？`);
  }
  if (!(iTx < iNpm && iNpm < iRelease)) {
    throw new Error(`顺序必须是 git 事务 → npm → Release（实际 ${iTx} / ${iNpm} / ${iRelease}）`);
  }
  if (!/if \(!gitTx\.ok\)/.test(src)) throw new Error("git 事务失败后必须有硬中止（if (!gitTx.ok)）");
  if (!/if \(!published\)/.test(src)) throw new Error("npm 失败后必须有硬中止（if (!published)），不能继续建 Release");
};

t["RH-10 源码：远端 tag 指向别的 commit 时只提示人工 force，不自动 force"] = () => {
  const src = nodeFs.readFileSync(SCRIPT, "utf8");
  if (!src.includes("不会自动 force")) throw new Error("必须明说「不会自动 force」");
  if (!src.includes("--force origin refs/tags/")) throw new Error("必须给出手工 force 的命令");
  if (src.includes("run(`git push --force")) throw new Error("脚本里不得出现自动 force 的调用");
};

// ── ⑥ 「N 个测试文件」声明的三态（task-160）────────────────────────────

t["TG-COUNT-1 一致：声明数 == 实际数 ⇒ 放行"] = () => {
  const r = checkTestFileCount("- 全量：（42 个测试文件）", 42);
  if (!r.ok) throw new Error(`应放行，实际 ${JSON.stringify(r)}`);
  if (r.declared !== 42) throw new Error(`declared 应为 42，实际 ${r.declared}`);
};

t["TG-COUNT-2 不一致：声明数 ≠ 实际数 ⇒ 红，且理由里两个数字都在"] = () => {
  const r = checkTestFileCount("- 全量：（37 个测试文件）", 42);
  if (r.ok) throw new Error("数字不符必须判红");
  if (r.declared !== 37 || r.actual !== 42) throw new Error(`declared/actual 错：${JSON.stringify(r)}`);
  if (!r.reason.includes("37") || !r.reason.includes("42")) {
    throw new Error(`理由必须同时写出声明值与实际值：${r.reason}`);
  }
  // 还要给出「怎么数」的写法建议（含历史版本的 git ls-tree 数法）
  if (!r.reason.includes("ls test/*.test.mjs") || !r.reason.includes("ls-tree")) {
    throw new Error(`理由必须给出计数方法：${r.reason}`);
  }
};

t["TG-COUNT-3 无声明：没写「N 个测试文件」⇒ 不报错（允许不写）"] = () => {
  const r = checkTestFileCount("- 全量：493 passed / 0 failed", 42);
  if (!r.ok) throw new Error(`没声明不该红：${JSON.stringify(r)}`);
  if (r.declared !== null) throw new Error(`declared 应为 null，实际 ${r.declared}`);
};

t["TG-COUNT-4 解析容错：`**42** 个测试文件` / `42 个测试文件；493 + 7` 都要能读"] = () => {
  const cases = ["（**42** 个测试文件）", "（42 个测试文件；493 + 7）", "42 个测试文件", "（42个测试文件）"];
  for (const c of cases) {
    const got = declaredTestFiles(c);
    if (got !== 42) throw new Error(`解析失败：${JSON.stringify(c)} ⇒ ${got}`);
  }
  if (declaredTestFiles("没有任何数字声明") !== null) throw new Error("无声明应返回 null");
};

t["TG-COUNT-5 一节里出现多个数字：全部都要等于实际，否则红并列出所有值"] = () => {
  // 真实场景：正文引用了旧版报错原文（含 37），汇总行写 42 —— 门禁不能被自己的举例骗过
  const mixed = "旧版写（37 个测试文件），这次是（42 个测试文件）";
  const r = checkTestFileCount(mixed, 42);
  if (r.ok) throw new Error("一节里 37 与 42 并存必须判红（否则门禁被自己的举例骗过）");
  if (!r.reason.includes("37") || !r.reason.includes("42")) throw new Error("理由要列出所有值：" + r.reason);
  if (!r.reason.includes("占位符")) throw new Error("理由要说明「引用旧数字请用占位符」：" + r.reason);
  if (declaredTestFilesAll(mixed).join(",") !== "37,42") throw new Error("应读出全部值：" + declaredTestFilesAll(mixed));
  // 全一致则放行
  const okAll = checkTestFileCount("（42 个测试文件）\n…（**42** 个测试文件）", 42);
  if (!okAll.ok) throw new Error("全部一致应放行：" + JSON.stringify(okAll));
};

// ── ⑦ 发布物核对：tarball 与 git archive <tag> 逐文件比对（task-181）──────────
// 比较键 = **去 CR 后的内容 sha256**（Windows 工作树 CRLF / archive LF ⇒ 原始 shasum 必然不同）
const tree = (pairs) => new Map(pairs.map(([p, h]) => [p, { sha256: "raw-" + h, sha256NoCR: h }]));
const bare = (pairs) => new Map(pairs);

t["V-1 发布物一致：去 CR 后同名同哈希 ⇒ 放行"] = () => {
  const r = compareReleaseTrees(tree([["a.mjs", "h1"], ["b.md", "h2"]]), tree([["a.mjs", "h1"], ["b.md", "h2"]]));
  if (!r.ok) throw new Error("应放行：" + JSON.stringify(r));
  if (r.checked !== 2) throw new Error("checked 应为 2，实际 " + r.checked);
  if (r.eol.length !== 0) throw new Error("原始字节也相同，不该有 eol 警告");
};

t["V-2 tarball 多出文件 ⇒ 红（发布物含 tag 里没有的东西）"] = () => {
  const r = compareReleaseTrees(tree([["a.mjs", "h1"]]), tree([["a.mjs", "h1"], ["evil.js", "h9"]]));
  if (r.ok) throw new Error("多出文件必须判红");
  if (r.extra.join() !== "evil.js") throw new Error("extra 应列出 evil.js：" + JSON.stringify(r.extra));
};

t["V-3 去 CR 后仍不同 ⇒ 红；tag 有、包里没有 ⇒ 只记 notPacked 不算失败"] = () => {
  const r = compareReleaseTrees(tree([["a.mjs", "h1"], ["README.md", "h2"]]), tree([["a.mjs", "hX"]]));
  if (r.ok) throw new Error("内容不同必须判红");
  if (r.changed.join() !== "a.mjs") throw new Error("changed 应列出 a.mjs：" + JSON.stringify(r.changed));
  if (!r.notPacked.includes("README.md")) throw new Error("README.md 应进 notPacked：" + JSON.stringify(r.notPacked));
};

t["V-4 归一化例外：normalize(path) 为真时记 normalized、不算失败"] = () => {
  const r = compareReleaseTrees(tree([["package.json", "h1"]]), tree([["package.json", "h2"]]), { normalize: () => true });
  if (!r.ok) throw new Error("归一化后应放行：" + JSON.stringify(r));
  if (r.normalized.join() !== "package.json") throw new Error("应记 normalized");
};

t["V-5 npm bin 归一化判定：只差 `./` 前缀算等价，真改内容不算"] = () => {
  const base = { name: "x", version: "1.0.0", bin: { x: "./scripts/cli.mjs" } };
  const normalized = { name: "x", version: "1.0.0", bin: { x: "scripts/cli.mjs" } };
  const changed = { name: "x", version: "1.0.1", bin: { x: "scripts/cli.mjs" } };
  if (!isOnlyBinNormalization(JSON.stringify(base), JSON.stringify(normalized))) throw new Error("只差 ./ 前缀应判为等价");
  if (isOnlyBinNormalization(JSON.stringify(base), JSON.stringify(changed))) throw new Error("版本号变了不该算等价");
  if (isOnlyBinNormalization("{坏 json", JSON.stringify(base))) throw new Error("坏 JSON 应判 false");
};

t["V-6 行尾差异只警告不红（CRLF 工作树 vs LF archive）"] = () => {
  // 去 CR 后相同、原始 shasum 不同 ⇒ ok:true + eol 里有它
  const archive = new Map([["docs/a.md", { sha256: "rawCrlfDifferent", sha256NoCR: "sameContent" }]]);
  const packed = new Map([["docs/a.md", { sha256: "rawOther", sha256NoCR: "sameContent" }]]);
  const r = compareReleaseTrees(archive, packed);
  if (!r.ok) throw new Error("行尾差异不该判红：" + JSON.stringify(r));
  if (r.eol.join() !== "docs/a.md") throw new Error("应记 eol 警告：" + JSON.stringify(r));
  if (r.changed.length !== 0) throw new Error("不该进 changed");
};

t["V-7 发布物核对脚本存在且结构正确（回归）"] = () => {
  const p = nodePath.join(ROOT, "scripts", "verify-release.mjs");
  if (!nodeFs.existsSync(p)) throw new Error("缺 scripts/verify-release.mjs");
  const src = nodeFs.readFileSync(p, "utf8");
  if (!src.includes("git archive")) throw new Error("必须用 git archive 取 tag 树");
  if (!src.includes("compareReleaseTrees")) throw new Error("必须复用 release-lib 的比较判据（单一来源）");
  if (!src.includes("sha256NoCR")) throw new Error("必须按去 CR 后的内容哈希比较");
};
