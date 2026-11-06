/**
 * profile-io.test.mjs —— 两个读文件小工具的契约（C306）
 *
 * 为什么值得单测：它们原来在面板与安装器里各写一遍（C303 扫描抓到）。合成一份之后，
 * 唯一的风险是"读不到时的返回值"被改掉 —— 面板首屏和安装器都靠"坏 JSON 不抛"活着。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { readProfileBundles, readTextOrNull } from "../src/rooms/profile-io.mjs";

export const tests = {};

tests["C306 readProfileBundles：正常/缺文件/坏 JSON/非数组 都要给出确定结果"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "profile-io-"));
  try {
    // ① 正常
    nodeFs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["a", "b", ""] } } }), "utf8");
    t.eq(readProfileBundles(dir), ["a", "b"], "空串要被过滤");

    // ② 不是数组
    nodeFs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: "x" } } }), "utf8");
    t.eq(readProfileBundles(dir), [], "非数组 ⇒ 空数组");

    // ③ 坏 JSON（不许抛）
    nodeFs.writeFileSync(nodePath.join(dir, "package.json"), "{ 坏", "utf8");
    t.eq(readProfileBundles(dir), [], "坏 JSON ⇒ 空数组，不抛");

    // ④ 缺文件
    nodeFs.rmSync(nodePath.join(dir, "package.json"));
    t.eq(readProfileBundles(dir), [], "缺文件 ⇒ 空数组");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["C306 readTextOrNull：读得到返回内容，读不到返回 null"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "profile-io-"));
  try {
    const file = nodePath.join(dir, "x.txt");
    nodeFs.writeFileSync(file, "hello", "utf8");
    t.eq(readTextOrNull(file), "hello", "读得到就返回内容");
    t.eq(readTextOrNull(nodePath.join(dir, "nope.txt")), null, "不存在 ⇒ null（不是空串）");
    t.eq(readTextOrNull(dir), null, "传目录也不许抛");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};
