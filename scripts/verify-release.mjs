#!/usr/bin/env node
/**
 * verify-release.mjs —— 发布物核对：**tarball 必须逐文件等于 `git archive <tag>`**
 *
 * 为什么需要：`release.mjs` 只能保证「push / tag / npm / Release 都做了」，
 * 它没法回答「用户实际下到的那个包，跟 tag 里的树是不是同一份东西」——
 * 构建脚本、`files` 白名单、`prepack` 钩子、甚至手动改过的 node_modules 都可能让两者分叉。
 *
 * 用法：
 *   node scripts/verify-release.mjs --tarball=<本地 .tgz | https URL>
 *   node scripts/verify-release.mjs --tag=v1.11.12 --tarball=https://registry.npmjs.org/...
 *   node scripts/verify-release.mjs --ref=HEAD --tarball=./dsh-gokifu-compact-1.11.12.tgz --json
 *
 * 判据（与 `release-lib.compareReleaseTrees` 同一份）：
 *   · tarball **多出**文件            ⇒ 失败（发布物含 tag 里没有的东西）
 *   · 同名但内容不同                  ⇒ 失败（`package.json` 的 npm `bin` 归一化除外）
 *   · tag 里有、tarball 里没有        ⇒ **不算失败**（npm 只打包 `files` 子集），列在「未打包」
 *
 * 退出码：0 一致 / 1 不一致 / 2 跑不起来（取不到 tarball、tag 不存在…）
 */

import nodeFs from "node:fs"
import nodePath from "node:path"
import nodeOs from "node:os"
import nodeCrypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { compareReleaseTrees, isOnlyBinNormalization } from "./release-lib.mjs"

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const ROOT = nodePath.resolve(HERE, "..")

const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return null
  if (hit === `--${name}`) return true
  return hit.slice(name.length + 3)
}

const asJson = Boolean(flag("json"))
const tarballArg = flag("tarball")
const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"))
const ref = flag("ref") || flag("tag") || `v${pkg.version}`

function fail(code, message) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 1))
  } else {
    console.error(`✗ ${message}`)
  }
  process.exit(code)
}

if (!tarballArg || tarballArg === true) fail(2, "缺 --tarball=<本地 .tgz 或 https URL>")

const tmpRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "verify-release-"))

/** 取 tarball 到本地（URL 走 curl；本地路径先复制成 `published.tgz`，见下方注释） */
function localTarball(target) {
  const out = nodePath.join(tmpRoot, "published.tgz")
  if (!/^https?:\/\//i.test(target)) {
    const abs = nodePath.resolve(ROOT, target)
    if (!nodeFs.existsSync(abs)) throw new Error(`tarball 不存在：${abs}`)
    // ⚠ 一律复制到 tmpRoot 下的**相对文件名**：GNU tar 会把 `C:\…` 里的 `C:` 当成远程主机
    // （rsh 语法），报 “Cannot connect to C: resolve failed”。用 cwd + 相对名彻底绕开。
    nodeFs.copyFileSync(abs, out)
    return out
  }
  try {
    execFileSync("curl", ["-sSL", "--max-time", "60", "-o", out, target], { stdio: ["ignore", "pipe", "pipe"] })
  } catch (e) {
    throw new Error(`下载失败：${String(e.stderr || e.message).split("\n")[0]}`)
  }
  if (!nodeFs.existsSync(out) || nodeFs.statSync(out).size === 0) throw new Error("下载到 0 字节（可能还没登记，稍后重试）")
  return out
}

/**
 * 递归列出目录下所有文件 → Map<相对路径, {sha256, sha256NoCR}>。
 *
 * **两个哈希**：原始字节的 sha256，和「把 CRLF 换成 LF 后」的内容 sha256。
 * 比较以 `sha256NoCR` 为准 —— Windows 工作树是 CRLF、`git archive` 出 LF、npm 打工作树字节，
 * 同一份内容两边原始 shasum 必然不同（1.11.12 实测差 1,546 B / 2 个 docs）。按原始 shasum 死磕
 * 会让**每次发布都假红**；行尾差异单独作为警告报告。
 */
function hashTree(dir) {
  const out = new Map()
  const walk = (rel) => {
    const abs = nodePath.join(dir, rel)
    for (const ent of nodeFs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(childRel)
      else if (ent.isFile()) {
        const buf = nodeFs.readFileSync(nodePath.join(dir, childRel))
        // 去 CR：先按 binary 取 1:1 字节串，再删掉所有 \r，最后还原字节
        const lf = Buffer.from(buf.toString("binary").split("\r").join(""), "binary")
        out.set(childRel, {
          sha256: nodeCrypto.createHash("sha256").update(buf).digest("hex"),
          sha256NoCR: nodeCrypto.createHash("sha256").update(lf).digest("hex"),
        })
      }
    }
  }
  walk("")
  return out
}

let tarball
try {
  tarball = localTarball(tarballArg)
} catch (e) {
  fail(2, e.message)
}

// ① 导出 tag 的树
const archiveDir = nodePath.join(tmpRoot, "archive")
nodeFs.mkdirSync(archiveDir, { recursive: true })
const tarFile = nodePath.join(tmpRoot, "tree.tar")
try {
  execFileSync("git", ["archive", "--format=tar", `--output=${tarFile}`, ref], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
} catch (e) {
  fail(2, `git archive ${ref} 失败：${String(e.stderr || e.message).trim().split("\n")[0]}`)
}
try {
  execFileSync("tar", ["-x", "-f", "tree.tar", "-C", "archive"], { cwd: tmpRoot, stdio: ["ignore", "pipe", "pipe"] })
} catch (e) {
  fail(2, `解开 git archive 失败：${String(e.stderr || e.message).trim().split("\n")[0]}`)
}

// ② 解开 tarball（npm 包根目录是 package/）
const packDir = nodePath.join(tmpRoot, "packed")
nodeFs.mkdirSync(packDir, { recursive: true })
try {
  execFileSync("tar", ["-xzf", "published.tgz", "-C", "packed"], { cwd: tmpRoot, stdio: ["ignore", "pipe", "pipe"] })
} catch (e) {
  fail(2, `解开 tarball 失败：${String(e.stderr || e.message).trim().split("\n")[0]}`)
}
const packRoot = nodePath.join(packDir, "package")
if (!nodeFs.existsSync(packRoot)) fail(2, "tarball 里没有 package/ 目录 —— 不像 npm 包")

const archiveMap = hashTree(archiveDir)
const tarballMap = hashTree(packRoot)

// ③ package.json 的 npm bin 归一化单独归类
const readBoth = (path) => [
  nodeFs.readFileSync(nodePath.join(archiveDir, path)),
  nodeFs.readFileSync(nodePath.join(packRoot, path)),
]
const normalize = (path) => {
  // ① npm 会把 package.json 的 bin 前导 "./" 去掉（每版都有一条 warn）
  if (path === "package.json") {
    try {
      const [a, b] = readBoth(path)
      if (isOnlyBinNormalization(a.toString("utf8"), b.toString("utf8"))) return true
    } catch {}
  }
  // ② 行尾差异：Windows 工作树是 CRLF，git archive 按 autocrlf 出 LF，而 npm pack 打的是**工作树字节**。
  //    同一个文件在两边字节不同、内容相同 —— 这是打包机制，不是发布物漂移。
  try {
    const [a, b] = readBoth(path)
    const lf = (buf) => buf.toString("binary").split("\r\n").join("\n")
    return lf(a) === lf(b)
  } catch {
    return false
  }
}

const result = compareReleaseTrees(archiveMap, tarballMap, { normalize })

if (asJson) {
  console.log(JSON.stringify({ ok: result.ok, ref, tarball: tarballArg, ...result }, null, 1))
} else {
  const line = (mark, label, list) => {
    if (list.length === 0) return
    console.log(`  ${mark} ${label}（${list.length}）`)
    for (const p of list.slice(0, 20)) console.log(`      ${p}`)
    if (list.length > 20) console.log(`      … 还有 ${list.length - 20} 个`)
  }
  console.log(`\n发布物核对 · ref=${ref} · tarball=${tarballArg}\n`)
  console.log(`  tag 树 ${archiveMap.size} 个文件 · 包内 ${tarballMap.size} 个文件 · 逐个比对 ${result.checked} 个\n`)
  line("✗", "tarball 多出（tag 里没有）", result.extra)
  line("✗", "内容不同", result.changed)
  line("!", "行尾差异（CRLF↔LF，内容一致 —— 只警告）", result.eol)
  line("·", "npm bin 归一化（可接受）", result.normalized)
  line("·", "未打包（tag 有、包里没有）", result.notPacked)
  console.log(result.ok ? "\n✓ 一致：发布物就是 tag 的那棵树\n" : "\n✗ 不一致：发布物与 tag 的树不符\n")
}

nodeFs.rmSync(tmpRoot, { recursive: true, force: true })
process.exit(result.ok ? 0 : 1)
