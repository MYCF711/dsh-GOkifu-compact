/**
 * release-post-verify.test.mjs —— K-33：发布后验证的纯判据
 *
 * 发布脚本最容易骗人的地方：`npm publish` 返回 0，但 registry 还没传播。
 * 这里只测「怎样算验证通过」，不连网络、不跑真实发布。
 */

import {
  npmVersionReady,
  latestTag,
  tarballChangelogReady,
  releaseApiReady,
  pollUntil,
} from "../scripts/release-post-verify.mjs";

export const tests = {};

tests["K33-1 npm version 必须精确等于目标版本（空白可忽略）"] = (t) => {
  t.eq(npmVersionReady("1.18.3\n", "1.18.3"), true, "带换行也算");
  t.eq(npmVersionReady(" 1.18.3 ", "1.18.3"), true, "前后空白可忽略");
  t.eq(npmVersionReady("1.18.2", "1.18.3"), false, "旧版本必须红");
  t.eq(npmVersionReady("", "1.18.3"), false, "空输出必须红");
  t.eq(npmVersionReady("1.18.30", "1.18.3"), false, "不许前缀匹配");
};

tests["K33-2 dist-tags.latest 必须等于目标版本"] = (t) => {
  t.eq(latestTag('{"latest":"1.18.3","next":"1.19.0-beta.1"}'), "1.18.3", "取 latest");
  t.eq(latestTag('{"next":"1.19.0-beta.1"}'), null, "没有 latest 必须红");
  t.eq(latestTag("not json"), null, "坏 JSON 不许当通过");
};

tests["K33-3 tarball 内 CHANGELOG 必须有版本标题"] = (t) => {
  t.eq(tarballChangelogReady("# x\n\n## 1.18.3（2026-11-06）\n", "1.18.3"), true, "精确标题");
  t.eq(tarballChangelogReady("## 1.18.30\n", "1.18.3"), false, "不许前缀命中");
  t.eq(tarballChangelogReady("## 1.18.2\n", "1.18.3"), false, "旧版本必须红");
};

tests["K33-4 GitHub Release 必须 tag 对、非 draft、非 prerelease"] = (t) => {
  const ok = { tag_name: "v1.18.3", name: "1.18.3", draft: false, prerelease: false };
  t.eq(releaseApiReady(ok, { tag: "v1.18.3", version: "1.18.3" }), true, "正常");
  t.eq(releaseApiReady({ ...ok, draft: true }, { tag: "v1.18.3", version: "1.18.3" }), false, "draft 必须红");
  t.eq(releaseApiReady({ ...ok, prerelease: true }, { tag: "v1.18.3", version: "1.18.3" }), false, "prerelease 必须红");
  t.eq(releaseApiReady({ ...ok, tag_name: "v1.18.2" }, { tag: "v1.18.3", version: "1.18.3" }), false, "tag 不对必须红");
  t.eq(releaseApiReady(null, { tag: "v1.18.3", version: "1.18.3" }), false, "取不到 Release 必须红");
};

tests["K33-5 pollUntil 用注入时钟：先空后到，超时返回最后一次"] = async (t) => {
  let n = 0;
  const sleeps = [];
  const ok = await pollUntil(
    () => {
      n += 1;
      return n >= 3 ? "ready" : "";
    },
    { timeoutMs: 10_000, intervalMs: 5_000, sleep: async (ms) => sleeps.push(ms), now: () => sleeps.length * 5_000 },
  );
  t.eq(ok, "ready", "第三次应成功");
  t.eq(sleeps, [5_000, 5_000], "每次间隔 5s");

  let m = 0;
  const timedOut = await pollUntil(
    () => {
      m += 1;
      return "";
    },
    { timeoutMs: 10_000, intervalMs: 5_000, sleep: async () => {}, now: () => m * 5_000 },
  );
  t.eq(timedOut, "", "超时返回最后一次空值");
};

tests["K33-6 判据不是恒真：五个纯函数全部有反例"] = (t) => {
  t.eq(npmVersionReady("1.18.2", "1.18.3"), false, "npm 反例");
  t.eq(latestTag("{}"), null, "tag 反例");
  t.eq(tarballChangelogReady("## 1.18.2", "1.18.3"), false, "tarball 反例");
  t.eq(releaseApiReady({ tag_name: "v1.18.3", draft: true, prerelease: false }, { tag: "v1.18.3", version: "1.18.3" }), false, "Release 反例");
};
