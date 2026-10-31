/**
 * release-lib.mjs —— `release.mjs` 的纯逻辑层（可单测，零副作用）
 *
 * 为什么单独拆出来：2026-10-31 的真实事故 —— 仓库 `remote.origin.url` 被写成
 * `git+https://github.com/…`（非法 scheme），`release.mjs` 的体检**照样通过**（正则能匹配
 * `github.com:`），直到真做 `git push` 才炸；而当时的执行顺序是「push → tag → **Release → npm**」，
 * 于是留下「npm 已发、Release 已建、但 main 没推、tag 指向错误 commit」的半途状态。
 *
 * 本文件把两件事变成可测的纯函数：
 *   ① `classifyRemote()`：**先判 scheme 再判仓库**，`git+*` 直接拒，并给出可执行的修法；
 *   ② `runTransaction()`：**顺序执行 + 首个失败即中止**，让「git 步骤成功之后才允许副作用」成为结构保证，
 *      而不是散落在调用点的 if。
 */

/** 非法 remote scheme 前缀：`git+https:` / `git+ssh:` / `git+file:` … */
const BAD_SCHEME_RE = /^git\+/i

/** GitHub 仓库的三种合法写法：scp 式 ssh、`ssh://`、`https://`。 */
const SSH_RE = /^[a-z0-9._-]+@github\.com:([^/\s]+)\/([^/\s]+)$/i
const SSH_URL_RE = /^ssh:\/\/(?:[a-z0-9._-]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+)\/?$/i
const HTTPS_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i

/**
 * 解析 GitHub remote。
 * @returns {{owner:string, repo:string}|null} 不是 GitHub 或用了非法 scheme 时返回 null
 */
export function parseRepo(url) {
  const raw = String(url ?? "").trim()
  if (!raw || BAD_SCHEME_RE.test(raw)) return null
  for (const re of [SSH_RE, SSH_URL_RE, HTTPS_RE]) {
    const m = raw.match(re)
    if (m) {
      const repo = m[2].replace(/\.git$/i, "")
      if (!m[1] || !repo) return null
      return { owner: m[1], repo }
    }
  }
  return null
}

/**
 * 判断 remote 能不能用，并给出人话理由。
 * @returns {{ok:true, repo:{owner:string,repo:string}, url:string} | {ok:false, reason:string}}
 */
export function classifyRemote(url) {
  const raw = String(url ?? "").trim()
  if (!raw) {
    return { ok: false, reason: "remote.origin.url 为空 —— 没有远端就发不了版（git remote add origin …）" }
  }
  if (BAD_SCHEME_RE.test(raw)) {
    const scheme = raw.split(":").slice(0, 2).join(":").split("+")[0]
    return {
      ok: false,
      reason:
        `remote.origin.url 用了非法协议（${raw.slice(0, raw.indexOf(":") + 1)}…）—— ` +
        `git 会去找 remote helper「git-remote-${scheme}+」并报 "is not a git command"。` +
        `改成 git@github.com:<owner>/<repo>.git（推荐）或 https://github.com/<owner>/<repo>.git：` +
        `git remote set-url origin git@github.com:<owner>/<repo>.git`,
    }
  }
  const repo = parseRepo(raw)
  if (!repo) {
    return { ok: false, reason: `remote.origin.url 不是 GitHub 仓库（${raw}）—— 这个脚本只处理 GitHub` }
  }
  return { ok: true, repo, url: raw }
}

/**
 * 顺序执行一串步骤，**第一个失败就停**，后面的步骤一律不执行。
 *
 * 这就是「git push 成功之后才允许 npm / Release」的结构保证：把有副作用的动作排进 steps，
 * 前面任何一步抛错，`ok` 就是 false，调用方据此直接退出（不再执行剩余副作用）。
 *
 * @param {{name:string, run:() => any}[]} steps
 * @param {{
 *   onStart?:(step:{name:string}, index:number)=>void,
 *   onSettled?:(step:{name:string}, error:any, value:any)=>void,
 * }} [opts]
 * @returns {{ok:boolean, done:string[], failed:string|null, error:any, aborted:string[]}}
 */
export function runTransaction(steps, opts = {}) {
  const list = Array.isArray(steps) ? steps : []
  const done = []
  for (let i = 0; i < list.length; i++) {
    const step = list[i]
    if (opts.onStart) opts.onStart(step, i)
    try {
      const value = step.run()
      if (opts.onSettled) opts.onSettled(step, null, value)
      done.push(step.name)
    } catch (error) {
      if (opts.onSettled) opts.onSettled(step, error, undefined)
      return {
        ok: false,
        done,
        failed: step.name,
        error,
        aborted: list.slice(i + 1).map((s) => s.name),
      }
    }
  }
  return { ok: true, done, failed: null, error: null, aborted: [] }
}

/**
 * 从 CHANGELOG 某节里读出「N 个测试文件」的**声明**。
 * 支持这些写法（本仓历史都用过）：
 *   `（37 个测试文件）` · `（37 个测试文件；481 + 5）` · `37 个测试文件`
 * @returns {number|null} 没写就返回 null（不是错误）
 */
export function declaredTestFiles(section) {
  // 允许 markdown 强调：`42 个测试文件` 与 `**42** 个测试文件` 都要能读出来
  const m = String(section ?? "").match(/(\d+)\s*\*{0,2}\s*个测试文件/)
  return m ? Number(m[1]) : null
}

/**
 * 校验「N 个测试文件」的声明与实际发现的 `test/*.test.mjs` 数量是否一致。
 *
 * **三态**（这是 task-160 的契约）：
 *   · 一致     ⇒ `{ ok: true,  declared: N }`
 *   · 不一致   ⇒ `{ ok: false, declared: N, reason }` —— 发布必须被拦住
 *   · 没有声明 ⇒ `{ ok: true,  declared: null }` —— 不报错（允许不写这个数）
 *
 * 为什么要有这条：本仓 CHANGELOG 长期写「N 个测试文件」，而 N 从 1.11.5 起就停在 37、
 * 实际已经 42 —— 数字漂了 5 个版本没人发现。用户会拿这个数判断覆盖面。
 *
 * @param {string} section 当前版本那一节的正文
 * @param {number} actual 实际 `test/*.test.mjs` 文件数
 */
export function checkTestFileCount(section, actual) {
  const declared = declaredTestFiles(section)
  if (declared === null) return { ok: true, declared: null, actual }
  if (declared === actual) return { ok: true, declared, actual }
  return {
    ok: false,
    declared,
    actual,
    reason:
      `CHANGELOG 写的「${declared} 个测试文件」与实际 ${actual} 个不符 —— ` +
      `改了测试文件就必须同步这句（或删掉它，脚本不会因此报错）。` +
      `实际值怎么数：ls test/*.test.mjs | wc -l（看历史版本：` +
      `git ls-tree -r --name-only <tag>^{commit} test/ | grep -c '\\.test\\.mjs$'）`,
  }
}
