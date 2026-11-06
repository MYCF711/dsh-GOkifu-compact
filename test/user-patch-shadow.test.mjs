/**
 * user-patch-shadow.test.mjs —— 「用户层 patch 遮蔽压缩引擎」检测的回归（2026-11-02）
 *
 * 实机事故：重启后插件 UI 正常、工具齐全，但会话里跑的是官方压缩、keeper 不落盘。
 * 根因：`profiles/<p>/cordis.patch.yml`（用户层，**最后**应用）里有一份 preset 快照，
 * 写着 `@deepseek-ai/dsh-compaction-basic`，把插件 bundle 层「换成 engine」的覆盖盖回去了。
 * 此前 doctor/verify-install 都看不出来（它们只看包内 patch）。
 *
 * 本测试钉住检测函数的口径：只看**顶层** `- id: preset-*`，块内出现 compaction-basic 才算遮蔽。
 */

import { findShadowedUserPresets } from "../src/rooms/preset-format.mjs";

export const tests = {};

const NL = String.fromCharCode(10);
const j = (...lines) => lines.join(NL);

tests["S-1 顶层 preset 块里写回 compaction-basic ⇒ 必须被抓到"] = (t) => {
  const patch = j(
    "- id: preset-standard",
    "  name: '@deepseek-ai/dsh-agent-preset'",
    "  config:",
    "    plugins:",
    "      - id: compaction",
    "        name: cordis:group",
    "        config:",
    "          - id: compaction-basic",
    "            name: '@deepseek-ai/dsh-compaction-basic'",
  );
  t.eq(findShadowedUserPresets(patch), ["preset-standard"], "必须报 preset-standard 被遮蔽");
};

tests["S-2 已经换成 engine 的 preset ⇒ 干净"] = (t) => {
  const patch = j(
    "- id: preset-standard",
    "  config:",
    "    plugins:",
    "      - id: compaction",
    "        config:",
    "          - id: gokifu-compact",
    "            name: 'dsh-gokifu-compact/engine'",
  );
  t.eq(findShadowedUserPresets(patch), [], "引擎行在场时不许误报");
};

tests["S-3 多个 preset 只报有问题的那些；没 preset 的文件返回空"] = (t) => {
  const patch = j(
    "- id: preset-standard",
    "  config:",
    "          - id: compaction-basic",
    "            name: '@deepseek-ai/dsh-compaction-basic'",
    "- id: preset-ptc",
    "  config:",
    "          - id: gokifu-compact",
    "            name: 'dsh-gokifu-compact/engine'",
  );
  t.eq(findShadowedUserPresets(patch), ["preset-standard"], "只报被遮蔽的 preset");
  t.eq(findShadowedUserPresets("[]"), [], "空 patch 不报");
  t.eq(findShadowedUserPresets(""), [], "空文本不报");
};

tests["S-4 只看顶层 preset 行：内层的 id 不制造假 preset"] = (t) => {
  const patch = j(
    "- id: preset-standard",
    "  config:",
    "    plugins:",
    "      - id: preset-lookalike", // 缩进的 id（内层成员）不是顶层 preset
    "        name: someone",
    "      - id: compaction",
    "        config:",
    "          - id: compaction-basic",
    "            name: '@deepseek-ai/dsh-compaction-basic'",
  );
  t.eq(findShadowedUserPresets(patch), ["preset-standard"], "只认顶层 preset-standard");
};

tests["S-5 CRLF 文本同样能识别（Windows 上 profile patch 常见）"] = (t) => {
  const crlf = j("- id: preset-standard", "  config:", "    - id: compaction-basic", "      name: '@deepseek-ai/dsh-compaction-basic'").replace(/\n/g, String.fromCharCode(13, 10));
  t.eq(findShadowedUserPresets(crlf), ["preset-standard"], "CRLF 不应影响判定");
};
