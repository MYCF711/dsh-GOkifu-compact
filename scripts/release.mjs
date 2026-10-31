#!/usr/bin/env node
// release.mjs —— 把「发布」从七步里的记忆题变成一条命令
//
// 为什么要有它：push 不是发布。真实的漏法是「代码推上去了，npm 没发、tag 没打、
// Release 没建」，而没有任何命令会报错 —— 表现只是 GitHub 右侧一直写着
// 「暂无发布版本」、用户永远停在旧版本。这个脚本把第 5~6 步（npm / tag / Release）
// 连同前置条件一起做成可执行、可预演的动作。
//
//   node scripts/release.mjs                 # 预演：列计划 + 逐项体检，什么都不改
//   node scripts/release.mjs --yes           # 真做：tag + push + Release
//   node scripts/release.mjs --yes --npm     # 再加 npm 发布（有 publish:npm 脚本就用它）
//
// 体检项（任一不过就退出码 1，且 --yes 也不动手）：
//   ① package.json 有 version               ② CHANGELOG 有这一版那一段
//   ②b 「N 个测试文件」的声明 == test/*.test.mjs 实际数（**没写这句不报错**）
//   ③ 工作区干净                            ④ 当前在默认分支
//   ⑤ remote 是合法 GitHub URL（拒 git+https 之类）  ⑥ 远端可达（ls-remote 必须成功）
//   ⑦ 不落后远端（fetch 必须成功，失败=红，不再吞成 note）  ⑧ tag 还没被占
//
// 执行顺序（**事务化**：前一步失败 ⇒ 后面一步根本不执行）：
//   push 分支 → tag -a + push tag → npm publish（--npm 时）→ GitHub Release
//   ⇒ git 步骤没过，绝不会出现「npm 已发 / Release 已建，但 main 没推」的半途状态。
//
// 需要 GitHub token 才能建 Release：
//   GITHUB_TOKEN / GH_TOKEN 环境变量。没有也能跑 —— 它会打印手工建 Release 的命令。

import { execSync, execFileSync } from "node:child_process"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { classifyRemote, runTransaction, checkTestFileCount } from "./release-lib.mjs"

const ROOT = process.cwd()
const argv = new Set(process.argv.slice(2))
const DRY = !argv.has("--yes")
const ALSO_NPM = argv.has("--npm")

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim()
}
function shOk(cmd) {
  try {
    sh(cmd)
    return true
  } catch {
    return false
  }
}

const problems = []
const notes = []
function bad(msg) {
  problems.push(msg)
}
function note(msg) {
  notes.push(msg)
}

// ── ①② 版本与 CHANGELOG ──────────────────────────────────────────────

if (!existsSync(join(ROOT, "package.json"))) {
  console.error(C.red("✗ 这里没有 package.json —— 请在插件仓库根目录跑"))
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const version = pkg.version
const tag = `v${version}`
if (!version) bad("package.json 里没有 version")

const changelogPath = join(ROOT, "CHANGELOG.md")
if (!existsSync(changelogPath)) {
  bad("没有 CHANGELOG.md —— 用户感知不到这一版改了什么（UPDATING.md 第 0 步）")
}

/** 从 CHANGELOG 里抽出某个版本那一节（到下一个 ## 为止） */
function changelogSection(v) {
  if (!existsSync(changelogPath)) return ""
  const text = readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n")
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^##\\s+${esc}\\b[^\\n]*\\n`, "m")
  const m = re.exec(text)
  if (!m) return ""
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/^##\s/m)
  const body = (next >= 0 ? rest.slice(0, next) : rest).trim()
  return body
}
const section = version ? changelogSection(version) : ""
if (version && !section) bad(`CHANGELOG.md 里没有「## ${version}」那一段 —— 先写更新内容再发版`)

// ── 「N 个测试文件」的声明必须等于事实 ────────────────────────────────
// 这条是 task-160 加的：本仓 CHANGELOG 连续 5 个版本写「37 个测试文件」，实际早就是 42
// —— 数字漂了没人发现，而用户会拿它判断覆盖面。**没写这句不报错**（允许不写）。
const testDir = join(ROOT, "test")
const actualTestFiles = existsSync(testDir)
  ? readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).length
  : 0
const testFileCheck = checkTestFileCount(section, actualTestFiles)
if (testFileCheck.declared === null) {
  note(`CHANGELOG 没写「N 个测试文件」⇒ 跳过该数字校验（实际 ${actualTestFiles} 个）`)
} else if (!testFileCheck.ok) {
  bad(testFileCheck.reason)
}

/**
 * 去掉 `> 起因：…` 那段 —— 它写给维护者，不进 Release 正文。
 * （UPDATING 四：一条一行说的是改了什么，`> 起因` 说的是为什么。用户感知不到后者。）
 */
function stripCause(md) {
  const out = []
  let skipping = false
  for (const line of md.split("\n")) {
    if (/^>\s*起因[：:]/.test(line)) {
      skipping = true
      continue
    }
    if (skipping) {
      if (/^>/.test(line)) continue // 引用块续行
      skipping = false
      if (line.trim() === "") continue
    }
    out.push(line)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}
const releaseBody = stripCause(section)

// ── ③④⑤ git 体检 ───────────────────────────────────────────────────

let branch = ""
let remote = ""
try {
  branch = sh("git rev-parse --abbrev-ref HEAD")
  remote = sh("git config --get remote.origin.url")
} catch {
  bad("这不是一个 git 仓库（或没有 origin）")
}
if (branch) {
  let def = ""
  try {
    def = sh("git symbolic-ref --short refs/remotes/origin/HEAD").replace(/^origin\//, "")
  } catch {
    def = "main"
  }
  if (branch !== def) bad(`当前分支是 ${branch}，默认分支是 ${def} —— magpie 的 git 源只认默认分支`)
}
if (branch) {
  const dirty = shOk("git diff --quiet") && shOk("git diff --cached --quiet")
  if (!dirty) bad("工作区有未提交的改动 —— 发布的内容必须和提交一致")
}

/**
 * remote 能不能用 —— 先判 scheme 再判仓库。
 * 这一层是 2026-10-31 事故的直接产物：`git+https://…` 曾被当成合法 GitHub URL，
 * 体检全绿、push 全崩。判定逻辑在 release-lib.mjs 里（可单测）。
 */
const remoteCheck = remote ? classifyRemote(remote) : { ok: false, reason: "没有 remote.origin" }
const gh = remoteCheck.ok ? remoteCheck.repo : null
if (!remoteCheck.ok) bad(remoteCheck.reason)

let behind = 0
if (gh && branch) {
  // ⑤/⑥ 远端可达：ls-remote 必须成功。失败 ⇒ 红（不许「跳过检查」继续发版）。
  if (!shOk("git ls-remote --heads origin")) {
    bad(
      "git ls-remote origin 失败 —— 远端不可达（URL 写错 / 凭据失效 / 网络不通）。" +
        "先跑 `git ls-remote origin` 亲自确认能通，再发版。",
    )
  } else {
    try {
      sh("git fetch origin --quiet")
      const counts = sh(`git rev-list --left-right --count origin/${branch}...HEAD`)
      const [b, a] = counts.split(/\s+/).map(Number)
      behind = b || 0
      if (behind > 0) bad(`落后远端 ${behind} 个提交 —— 先 pull / merge，别在旧基线上发版`)
      if (a > 0) note(`本地领先远端 ${a} 个提交（发布时会一起推上去）`)
    } catch (e) {
      // ⑦ fetch 失败不再是 note —— 那就是「不知道远端正不正常」，不能发版。
      bad(`git fetch origin 失败（${String(e.stderr || e.message).trim().split("\n")[0]}）—— 远端状态未知，先修好再发版`)
    }
  }
}

// ── ⑧ tag 是否已被占（并区分「指向本 commit」与「指向别的 commit」）──────
// 1.11.3 的现场：Release API 在 push 失败后**自动建了一个轻量 tag**，指向当时远端的旧 commit。
// 那种情况不能默默 force —— 必须让人确认「这个 tag 是不是发错了」。

let tagExistsLocal = false
let tagExistsRemote = false
let tagCommitLocal = ""
let tagCommitRemote = ""
if (gh) {
  tagExistsLocal = shOk(`git rev-parse -q --verify refs/tags/${tag}`)
  // ⚠ 不能用 `refs/tags/x^{commit}`：Windows 上 execSync 走 cmd.exe，`^` 是转义字符 ⇒
  // 会被吃成 `refs/tags/x{commit}`，命令失败、脚本崩（2026-10-31 实测：tag 已存在时跑预演直接抛异常）。
  // `rev-list -n1` 对 annotated / lightweight tag 都会剥到 commit，且没有 shell 元字符。
  if (tagExistsLocal) {
    try {
      tagCommitLocal = sh(`git rev-list -n1 refs/tags/${tag}`)
    } catch {
      tagCommitLocal = ""
    }
  }
  try {
    // ⚠ 不能给 ls-remote 传 `refs/tags/x` 这种精确 pattern：那样**不会**输出 `^{}` 剥皮行，
    // 拿到的只是 tag 对象 sha（annotated tag 时 ≠ commit）。列全部 tag 再由 JS 过滤。
    const out = sh(`git ls-remote --tags origin`)
    const lines = out.split("\n").filter(Boolean)
    const deref = lines.find((l) => l.endsWith(`refs/tags/${tag}^{}`))
    const plain = lines.find((l) => l.endsWith(`refs/tags/${tag}`))
    tagExistsRemote = Boolean(plain || deref)
    // annotated tag：deref 行的 sha 才是 commit；lightweight tag：只有 plain 行且它本身就是 commit。
    tagCommitRemote = ((deref ?? plain ?? "").split(/\s+/)[0] ?? "").trim()
  } catch {}
  const headSha = shOk("git rev-parse HEAD") ? sh("git rev-parse HEAD") : ""
  /** tag 指向的 commit 是不是 HEAD 本身或 HEAD 的祖先（= 正常「发过了，之后又提交了几次」） */
  const tagIsBehindHead = (sha) => {
    if (!sha) return false
    if (!headSha) return false
    if (sha === headSha || headSha.startsWith(sha)) return true
    try {
      sh(`git merge-base --is-ancestor ${sha} HEAD`)
      return true
    } catch {
      return false
    }
  }
  if (tagExistsLocal || tagExistsRemote) {
    const remoteSha = tagCommitRemote || tagCommitLocal
    if (tagExistsRemote && remoteSha && !tagIsBehindHead(remoteSha)) {
      bad(
        `远端 tag ${tag} 已存在，但指向 ${remoteSha.slice(0, 12)}，既不是 HEAD 也不是 HEAD 的祖先 —— ` +
          `可能是上次发布中断时由 Release API 自动建的轻量 tag。脚本**不会自动 force**。` +
          `确认这个 tag 发错之后，手工修：git push --force origin refs/tags/${tag}:refs/tags/${tag}`,
      )
    } else {
      bad(`tag ${tag} 已存在 —— 同一个版本号不能发两次；先 bump version`)
    }
  }
}

// ── 体检结果 ─────────────────────────────────────────────────────────

const CHANGELOG_STEPS = [
  "第 0 步 写 CHANGELOG",
  "第 1 步 bump version",
  "第 2 步 npm pack --dry-run",
  "第 3 步 提交",
  "第 4 步 git push <默认分支>",
  "第 5 步 npm publish（本脚本的 --npm）",
  "第 6 步 tag + Release（本脚本）",
  "第 7 步 四条验证",
]

console.log(C.bold(`\n发布预演 · ${gh ? `${gh.owner}/${gh.repo}` : "(未知仓库)"} · ${tag}\n`))
console.log(C.dim("七步里这一步在做什么："))
console.log(C.dim("  0 写 CHANGELOG → 1 bump → 2 pack 预演 → 3 提交 → 4 push →"))
console.log(C.dim("  5 npm publish → 6 tag+Release → 7 四条验证"))
console.log(C.dim(`  ${CHANGELOG_STEPS.join(" · ")}\n`))

if (problems.length) {
  console.log(C.red("✗ 体检没通过，下面这些先解决：\n"))
  for (const p of problems) console.log(C.red(`  · ${p}`))
  console.log()
  process.exit(1)
}

console.log(C.green("✓ 体检通过：版本 / CHANGELOG / 工作区 / 分支 / tag 都没问题\n"))
for (const n of notes) console.log(C.yellow(`  ! ${n}`))

// ── 计划 ─────────────────────────────────────────────────────────────

const plan = []
plan.push({ what: `git push origin ${branch}`, why: "第 4 步：git 源检测看默认分支 HEAD（**失败即中止，后面一步都不做**）" })
plan.push({ what: `git tag -a ${tag} -m "release ${tag}" && git push origin ${tag}`, why: "第 6 步：annotated tag（带消息）让「某 bug 出在哪版」可查，且 GitHub Release 才有说明" })
if (ALSO_NPM) {
  const script = pkg.scripts?.["publish:npm"] ? "npm run publish:npm" : "npm publish"
  plan.push({ what: script, why: "第 5 步：npm 源的用户比 registry 上的 version（**排在 Release 之前**：npm 失败就不建 Release）" })
}
plan.push({
  what: `POST /repos/${gh.owner}/${gh.repo}/releases`,
  why: `第 6 步：Release 正文 = CHANGELOG 的 ${version} 段（${releaseBody.split("\n").length} 行，已去掉 > 起因）`,
})
plan.push({ what: "四条验证", why: "第 7 步：npm 版本 / tarball 内容 / magpie plugin list / Release 在" })

console.log(C.bold("计划：\n"))
for (const [i, s] of plan.entries()) {
  console.log(`  ${i + 1}. ${s.what}`)
  console.log(C.dim(`     ${s.why}`))
}

if (DRY) {
  console.log(C.yellow("\n这是预演（dry-run），什么都没改。真做：node scripts/release.mjs --yes [--npm]\n"))
  process.exit(0)
}

// ── 真做（事务化：前一步失败 ⇒ 后面一步根本不执行）────────────────────

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
console.log()

const doneSteps = []

/**
 * 失败即中止：把「后面还有什么没做」写清楚，然后退出 1。
 * 这是 2026-10-31 事故的教训 —— 当时 push/tag 全失败，脚本却继续建 Release、继续 npm publish，
 * 留下「npm 有、main 没推、tag 指向旧 commit」的半途状态。
 */
function abort(step, detail) {
  console.log(C.red(`\n✗ 已中止：${step} 失败 —— 后续步骤全部未执行`))
  console.log(C.dim(`  已完成：${doneSteps.length ? doneSteps.join(" → ") : "（无）"}`))
  if (detail) console.log(C.dim(`  ${detail}`))
  console.log(
    C.dim(
      `  未执行：${["tag -a " + tag, ALSO_NPM ? "npm publish" : null, "GitHub Release"]
        .filter(Boolean)
        .join(" · ")}`,
    ),
  )
  console.log(C.dim("  ⇒ 没有任何新的对外副作用被制造出来。修好远端后重跑同一条命令。\n"))
  process.exit(1)
}

// ①② 推分支 + annotated tag —— 走 runTransaction（首步失败 ⇒ tag 步根本不执行）
const gitTx = runTransaction(
  [
    {
      name: `push ${branch}`,
      label: `push ${branch}`,
      run: () => sh(`git push origin ${branch}`, { stdio: "pipe" }),
      hint: "远端不可达或被拒。**tag / npm / Release 一件都没做。**",
    },
    {
      name: `tag ${tag}`,
      label: `tag ${tag}`,
      run: () => sh(`git tag -a ${tag} -m "release ${tag}" && git push origin ${tag}`, { stdio: "pipe" }),
      hint: "本地 tag 可能已建；远端 tag 没上去。修好后单独补：git push origin " + tag,
    },
  ],
  {
    onStart: (step) => process.stdout.write(`  ${step.label} … `),
    onSettled: (step, err) => {
      if (!err) return console.log(C.green("ok"))
      console.log(C.red("失败"))
      console.log(C.dim(String(err.stderr || err.message).trim().split("\n").slice(0, 4).join("\n")))
    },
  },
)
if (!gitTx.ok) {
  const failedStep = gitTx.done.length === 0 ? `git push origin ${branch}` : `tag -a ${tag} && git push origin ${tag}`
  const hint = gitTx.done.length === 0
    ? "远端不可达或被拒。**tag / npm / Release 一件都没做。**"
    : "本地 tag 可能已建；远端 tag 没上去。修好后单独补：git push origin " + tag
  abort(failedStep, hint)
}
doneSteps.push(`push ${branch}`, `tag ${tag}`)

// ③ npm 发布（在 Release 之前：npm 失败就不该留下一个「Release 说有、npm 上没有」的状态）
let published = null
if (ALSO_NPM) {
  const npmScript = pkg.scripts?.["publish:npm"] ? "npm run publish:npm" : "npm publish"
  console.log(C.dim(`\n  ${npmScript}（npm 登记有 1~2 分钟延迟，别在这窗口里重试）\n`))
  try {
    execSync(npmScript, { cwd: ROOT, stdio: "inherit" })
    published = true
    doneSteps.push(`npm publish ${version}`)
  } catch {
    published = false
  }
  if (!published) {
    abort(`${npmScript}`, "npm 没发出去（OTP / 2FA / 权限 / 网络）。**GitHub Release 未创建。**")
  }
}

let released = false

/** 这个仓库有没有 release.yml（有的话推 tag 就会自动建 Release，我们不该再建一遍） */
const hasReleaseWorkflow = existsSync(join(ROOT, ".github", "workflows", "release.yml"))

/** GET /releases/tags/<tag>，返回 html_url 或 null */
function existingRelease() {
  if (!token) return null
  try {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "--max-time",
        "20",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: magpie-plugin-release",
        `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/tags/${tag}`,
      ],
      { encoding: "utf8" },
    )
    const j = JSON.parse(out)
    return j?.html_url ?? null
  } catch {
    return null
  }
}
if (token) {
  // ⚠ 这里**故意不用 node 的 fetch**。实测（Windows + 本机证书库）node 的 https 栈打
  //   api.github.com 会报 `fetch failed` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，
  //   而系统 curl 走 schannel 正常。发布这一步失败会留下「tag 有了、Release 没有」的
  //   半截状态，不值得赌运行时。
  // 有 release.yml 的仓库：推 tag 就会自动建 Release，我们自己再建一遍会 422。
  // 没 workflow 的：先查一次（可能上次手工建过 / 上次跑到一半），没有才建。
  if (hasReleaseWorkflow) {
    const url = existingRelease()
    if (url) {
      console.log(`  Release … ${C.green("ok")}（release.yml 已建）${url}`)
    } else {
      console.log(C.yellow("  Release … 交给 release.yml（推 tag 已触发），约 1 分钟后按第 ④ 条确认"))
    }
    released = true
  } else if (existingRelease()) {
    console.log(`  Release … ${C.green("ok")}（这个 tag 的 Release 已经存在，不重复建）`)
    released = true
  } else {
    const payload = JSON.stringify({
      tag_name: tag,
      target_commitish: branch,
      name: version,
      body: releaseBody,
      draft: false,
      prerelease: false,
    })
    try {
      const out = execFileSync(
        "curl",
        [
          "-sS",
          "-X",
          "POST",
          "--max-time",
          "40",
          "-H",
          `Authorization: Bearer ${token}`,
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "User-Agent: magpie-plugin-release",
          "-H",
          "Content-Type: application/json; charset=utf-8",
          "--data-binary",
          "@-",
          `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases`,
        ],
        { input: payload, encoding: "utf8" },
      )
      let body = {}
      try {
        body = JSON.parse(out)
      } catch {}
      if (body?.html_url) {
        console.log(`  Release … ${C.green("ok")} ${body.html_url}`)
        released = true
      } else {
        console.log(`  Release … ${C.red("失败")} ${body?.message || String(out).slice(0, 160)}`)
      }
    } catch (e) {
      const detail = String(e.stderr || e.message).trim().slice(0, 160)
      console.log(`  Release … ${C.red("失败")} ${detail}`)
      if (/curl/i.test(detail)) {
        console.log(C.dim("    这台机器没有 curl？手工建：GitHub → Releases → Draft a new release"))
      }
    }
  }
} else {
  console.log(C.yellow("  Release … 跳过（没有 GITHUB_TOKEN / GH_TOKEN）"))
  console.log(C.dim("    手工建：GitHub → Releases → Draft a new release → 选 " + tag))
  console.log(C.dim("    正文直接把 CHANGELOG 里 " + version + " 那一段粘过去"))
}

// ── 第 7 步留给人看的清单 ─────────────────────────────────────────────

console.log(C.bold("\n第 7 步 · 四条验证（逐条跑，别只看版本号）：\n"))
const name = pkg.name
console.log(`  ① npm view ${name} version                 # 已是 ${version}？`)
console.log(`  ② curl -s $(npm view ${name}@${version} dist.tarball) | tar -xzOf - package/CHANGELOG.md | head -5`)
console.log(`     # 要看到新内容，不只看版本号`)
console.log(`  ③ magpie plugin list                       # 本机认得新版本 / 新 commit？`)
console.log(`  ④ curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \\`)
console.log(`       https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/tags/${tag}`)
console.log(`     # 200 且 "draft": false`)
console.log()
console.log(
  C.dim(
    "没过这四条，不要说「已发布」。detail: https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md\n",
  ),
)

// 走到这里说明 push / tag /（npm）全部成功。Release 失败仍是失败（否则「npm 有、Release 没有」）。
const failed = !!token && !released
if (failed) {
  console.log(C.red("\n✗ GitHub Release 没建成 —— push/tag/npm 都已完成，只差 Release："))
  console.log(C.dim("  手工建：GitHub → Releases → Draft a new release → 选 " + tag))
  console.log(C.dim("  或重跑本脚本（tag 已存在会先被 ⑧ 拦住；那就手工建一次）"))
}
process.exit(failed ? 1 : 0)
