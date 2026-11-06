/**
 * release-post-verify.mjs —— 发布事务的后置验证（K-33）
 *
 * 为什么需要：`release.mjs` 原来把「npm view / tarball / Release / verify-release」四条
 * 写成打印给人看的命令。2026-11-06 实际发布 1.18.3 时，publish 返回成功后 registry
 * 仍 404 了约 2 分钟；脚本却已经退出 0 ——「已发布」和「用户能装到」之间没有机器判据。
 *
 * 本模块只做只读验证：
 *   ① 轮询 `npm view <name>@<version> version` 直到等于目标版本；
 *   ② `dist-tags.latest` 必须等于目标版本；
 *   ③ tarball 内 CHANGELOG 必须含该版本段落；
 *   ④ 调 `verify-release.mjs --tag --tarball` 做逐文件比对；
 *   ⑤ 有 token 时核对 GitHub Release：tag 对、非 draft、非 prerelease。
 *
 * 任何一步失败都返回 `ok:false`（README/CI 不应把「publish 返回 0」当发布完成）。
 */

import { execFileSync } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_INTERVAL_MS = 5_000;

/** 轮询直到 fn() 返回 truthy 或超时；返回最后一次值（超时也返回）。 */
export async function pollUntil(fn, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, sleep = sleepMs, now = Date.now } = {}) {
  const started = now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (now() - started >= timeoutMs) return last;
    await sleep(intervalMs);
  }
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `npm view pkg@version version` 的输出去空白后必须精确等于版本。 */
export function npmVersionReady(output, version) {
  return String(output ?? "").trim() === String(version ?? "").trim();
}

/** `npm view pkg dist-tags --json`。 */
export function latestTag(tagsJson) {
  try {
    const parsed = JSON.parse(String(tagsJson ?? ""));
    return typeof parsed?.latest === "string" ? parsed.latest : null;
  } catch {
    return null;
  }
}

/** tarball 里必须能找到 `## <version>` 段（CHANGELOG 的版本标题）。 */
export function tarballChangelogReady(changelog, version) {
  const v = String(version ?? "").trim();
  return v !== "" && new RegExp(`^##\\s+${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(String(changelog ?? ""));
}

/** GitHub Release API 体：tag 对、非 draft、非 prerelease。 */
export function releaseApiReady(payload, { tag, version }) {
  const t = String(tag ?? "");
  const v = String(version ?? "");
  return Boolean(payload && payload.tag_name === t && payload.draft === false && payload.prerelease === false && (payload.name === undefined || payload.name === v));
}

function exec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts }).trim();
}

/**
 * 跑完整后置验证。只读；失败返回 `{ok:false, failedAt, detail}`。
 * @param {{name:string, version:string, tag:string, token?:string, repoRoot:string, timeoutMs?:number, intervalMs?:number}} opts
 */
export async function runPostPublishVerify({ name, version, tag, token = "", repoRoot, owner = "", repo = "", timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS }) {
  const result = { ok: false, failedAt: null, detail: "", versionOut: "", tarball: "" };
  try {
    const versionOut = await pollUntil(
      () => {
        try {
          return exec("npm", ["view", `${name}@${version}`, "version"], { timeout: 20_000 });
        } catch {
          return "";
        }
      },
      { timeoutMs, intervalMs },
    );
    result.versionOut = versionOut;
    if (!npmVersionReady(versionOut, version)) {
      result.failedAt = "npm-version";
      result.detail = `npm view ${name}@${version} version 未传播（最后=${JSON.stringify(versionOut)}）`;
      return result;
    }
    const tags = exec("npm", ["view", name, "dist-tags", "--json"], { timeout: 20_000 });
    if (latestTag(tags) !== version) {
      result.failedAt = "npm-latest";
      result.detail = `dist-tags.latest=${latestTag(tags)}，期望 ${version}`;
      return result;
    }
    const tarball = exec("npm", ["view", `${name}@${version}`, "dist.tarball"], { timeout: 20_000 });
    result.tarball = tarball;
    if (!/^https?:\/\//.test(tarball)) {
      result.failedAt = "npm-tarball";
      result.detail = `dist.tarball 不是 URL：${tarball}`;
      return result;
    }
    const changelog = exec("curl", ["-sL", tarball], { timeout: 120_000 });
    if (!tarballChangelogReady(changelog, version)) {
      result.failedAt = "tarball-changelog";
      result.detail = `tarball 内 CHANGELOG 没有 ## ${version} 段`;
      return result;
    }
    try {
      exec(process.execPath, ["scripts/verify-release.mjs", `--tag=${tag}`, `--tarball=${tarball}`], { cwd: repoRoot, timeout: 180_000 });
    } catch (error) {
      result.failedAt = "verify-release";
      result.detail = String(error?.stdout || error?.stderr || error?.message || error).slice(0, 400);
      return result;
    }
    if (token) {
      let payload = null;
      try {
        const body = exec("curl", [
          "-sS",
          "-H",
          `Authorization: Bearer ${token}`,
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "User-Agent: magpie-plugin-release",
          `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
        ], { timeout: 40_000 });
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
      if (!releaseApiReady(payload, { tag, version })) {
        result.failedAt = "github-release";
        result.detail = `Release API 不是非 draft/prerelease 的 ${tag}（payload=${JSON.stringify(payload)?.slice(0, 200)}）`;
        return result;
      }
    }
    result.ok = true;
    return result;
  } catch (error) {
    result.failedAt = "unexpected";
    result.detail = String(error?.message ?? error).slice(0, 400);
    return result;
  }
}
