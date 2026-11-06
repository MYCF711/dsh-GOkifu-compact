/**
 * profile-io.mjs —— 读 profile 目录的两个小工具（C306）
 *
 * 为什么单独成文件：`readProfileBundles` 与 `readTextOrNull` 原来在
 * `src/ui.mjs`（面板）和 `scripts/install.mjs`（安装/卸载 CLI）里**各写了一遍，逐字相同**。
 * C303 的重复扫描把这组抓了出来 —— 重复的代码不会一起改。
 *
 * 这里的函数都是"读不到就返回空/ null"，**不抛** —— 调用方（面板首屏、安装器）都不该因为
 * 一个坏 JSON 就整体失败。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

/**
 * 读 `profile/package.json` 里的 `dsh.profile.bundles`（数组）。
 * @param {string} profileDir
 * @returns {string[]} 读不到就是空数组
 */
export function readProfileBundles(profileDir) {
  const file = nodePath.join(profileDir, "package.json");
  try {
    if (!nodeFs.existsSync(file)) return [];
    const pkg = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    const bundles = pkg?.dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles.filter((b) => typeof b === "string" && b.trim() !== "") : [];
  } catch {
    return [];
  }
}

/**
 * 读一个文本文件；不存在或读出错就 `null`。
 * @param {string} file
 * @returns {string|null}
 */
export function readTextOrNull(file) {
  try {
    return nodeFs.existsSync(file) ? nodeFs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}
