/**
 * user-patch-heal.test.mjs —— 用户层遮蔽的「机器级层自动登记」回归（2026-11-02，1.17.1）
 *
 * 目标：安装后重启即用，用户**不需要跑任何命令**。
 * 机制：插件在进程退出时，把用户层 patch 里被 GUI 写回的 `preset-*` 行**原样复制**到机器级
 * `$DSH_HOME/cordis.patch.yml`（宿主最后应用的一层），只把 compaction 成员换成
 * `dsh-gokifu-compact/engine`。persona / 工具开关 / 其它成员一个都不动。
 *
 * 这里只测纯函数 + 写盘（临时目录），不碰真实 home。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_MARKER, healHomePatch, planHomePatch, presetRowsNeedingHomeLayer, stripManagedSection, swapCompactionMember } from "../src/rooms/user-patch.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const LF = String.fromCharCode(10);
const j = (...lines) => lines.join(LF);

/** 一段模拟「GUI 写回」的用户层 patch：preset-standard + compaction-basic + persona。 */
function profilePatch() {
  return j(
    "- id: preset-standard",
    "  name: '@deepseek-ai/dsh-agent-preset'",
    "  config:",
    "    id: standard",
    "    order: 1",
    "    plugins:",
    "      - id: persona",
    "        name: '@deepseek-ai/dsh-persona'",
    "        config:",
    "          suffix: |",
    "            这是主人的 persona，必须原样保留",
    "      - id: compaction",
    "        name: cordis:group",
    "        group: true",
    "        isolate:",
    "          compaction: true",
    "        config:",
    "          - id: compaction-basic",
    "            name: '@deepseek-ai/dsh-compaction-basic'",
    "          - id: command-compact",
    "            name: '@deepseek-ai/dsh-command-compact'",
    "- id: agent-default-model",
    "  config:",
    "    model: group/deepseek-v4.1-flash1017",
  );
}

export const tests = {};

tests["H-1 只把 compaction-basic 换成 engine，persona / 其它成员逐字不动"] = (t) => {
  const rows = presetRowsNeedingHomeLayer(profilePatch());
  t.eq(rows.length, 1, `应当只有 preset-standard 一条，实际 ${rows.length}`);
  t.eq(rows[0].id, "preset-standard", "id 应保留");
  t.includes(rows[0].text, "dsh-gokifu-compact/engine", "必须换成引擎");
  t.eq(rows[0].text.includes("dsh-compaction-basic"), false, "不许残留 compaction-basic");
  t.includes(rows[0].text, "这是主人的 persona，必须原样保留", "persona 必须原样复制");
  t.includes(rows[0].text, "command-compact", "其它 compaction 成员必须保留");
  t.eq(rows[0].text.includes("agent-default-model"), false, "非 preset 顶层行不复制");
};

tests["H-2 plan：home 为空 ⇒ 生成托管段；不带孤立的 []（否则不是合法 entry list）"] = (t) => {
  const plan = planHomePatch(profilePatch(), "");
  t.eq(plan.needed, true, "需要登记");
  t.eq(plan.next.startsWith(MANAGED_MARKER), true, `首行必须是托管标记，实际：${plan.next.slice(0, 40)}`);
  t.eq(plan.next.trim() === "[]", false, "不能只剩 []");
  t.eq(plan.next.split(LF)[0].trim(), MANAGED_MARKER, "标记必须在第一行");
  t.includes(plan.next, "dsh-gokifu-compact/engine", "必须带引擎行");
};

tests["H-3 home 里已有别的内容 ⇒ 追加托管段并原样保留"] = (t) => {
  const existing = j("- id: some-machine-row", "  config:", "    keep: me");
  const plan = planHomePatch(profilePatch(), existing);
  t.eq(plan.needed, true, "需要登记");
  t.eq(plan.next.startsWith(existing), true, "原有内容必须原样在前");
  t.includes(plan.next, "keep: me", "原有行不许被改");
};

tests["H-4 幂等：把生成结果再喂一次 ⇒ needed=false（不会每次启动都写盘）"] = (t) => {
  const first = planHomePatch(profilePatch(), "");
  const second = planHomePatch(profilePatch(), first.next);
  t.eq(second.needed, false, `重复规划不应再写：${JSON.stringify(second.next.slice(0, 60))}`);
};

tests["H-5 用户层已经是 engine（或没有 compaction 成员）⇒ 不需要登记"] = (t) => {
  const already = profilePatch().replace("compaction-basic", "gokifu-compact").replace("@deepseek-ai/dsh-compaction-basic", "dsh-gokifu-compact/engine");
  t.eq(presetRowsNeedingHomeLayer(already).length, 0, "已经是引擎 ⇒ 不复制");
  const unrelated = j("- id: preset-design", "  config:", "    plugins: []");
  t.eq(planHomePatch(unrelated, "").needed, false, "没有 compaction-basic ⇒ 不复制");
};

tests["H-6 stripManagedSection 只删托管段，保留用户自己的 home 行"] = (t) => {
  const existing = j("- id: keep-me", "  config:", "    x: 1");
  const plan = planHomePatch(profilePatch(), existing);
  t.eq(stripManagedSection(plan.next).trim(), existing.trim(), "去托管段后必须等于原文");
};

tests["H-7 healHomePatch 真写盘（临时 home）：首次写、二次幂等、已有 home 先备份"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-heal-"));
  try {
    const home = nodePath.join(root, "home");
    const profileDir = nodePath.join(home, "profiles", "desktop");
    nodeFs.mkdirSync(profileDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(profileDir, "cordis.patch.yml"), profilePatch(), "utf8");
    nodeFs.writeFileSync(nodePath.join(home, "cordis.patch.yml"), j("- id: keep-me", "  config:", "    x: 1"), "utf8");

    const first = healHomePatch({ home, profile: "desktop", now: 111 });
    t.eq(first.wrote, true, `首次必须写入：${JSON.stringify(first)}`);
    const text = nodeFs.readFileSync(nodePath.join(home, "cordis.patch.yml"), "utf8");
    t.includes(text, "dsh-gokifu-compact/engine", "写入后必须带引擎行");
    t.includes(text, "keep-me", "用户自己的 home 行必须保留");
    t.eq(nodeFs.existsSync(nodePath.join(home, "cordis.patch.yml.bak-before-gokifu-111")), true, "已有 home 必须先备份");

    const second = healHomePatch({ home, profile: "desktop", now: 222 });
    t.eq(second.wrote, false, `二次必须幂等：${JSON.stringify(second)}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["H-8 用户层不存在 ⇒ 不写（不凭空造 home patch）"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-heal-empty-"));
  try {
    const result = healHomePatch({ home: root, profile: "desktop" });
    t.eq(result.wrote, false, "没有用户层 patch 时不许写");
    t.eq(result.reason, "no-profile-patch", `原因必须写清：${JSON.stringify(result)}`);
    t.eq(nodeFs.existsSync(nodePath.join(root, "cordis.patch.yml")), false, "不许凭空创建 home patch");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["H-10 漂移：用户层改过人设后，plan 必须报 needed（doctor 的「未漂移」检查靠它）"] = (t) => {
  const original = profilePatch();
  const home = planHomePatch(original, "").next;
  t.eq(planHomePatch(original, home).needed, false, "home 与用户层一致时不许反复写");
  const edited = original.replace("这是主人的 persona，必须原样保留", "这是改过的人设，必须刷新到 home 层");
  const plan = planHomePatch(edited, home);
  t.eq(plan.needed, true, "用户层改过人设 ⇒ 必须判漂移");
  t.includes(plan.next, "这是改过的人设", "重新生成的 home 副本必须带新人设");
  t.eq(plan.next.includes("这是主人的 persona"), false, "旧人设不许残留");
};

tests["H-9 真实用户层样本：本仓 scripts 生成的 swap 与 preset-format 的 findShadowedUserPresets 口径一致"] = async (t) => {
  const { findShadowedUserPresets } = await import("../src/rooms/preset-format.mjs");
  const text = profilePatch();
  t.eq(findShadowedUserPresets(text), ["preset-standard"], "检测器应报遮蔽");
  const rows = presetRowsNeedingHomeLayer(text);
  t.eq(findShadowedUserPresets(rows[0].text), [], "复制行换成引擎后检测器应认为干净");
};
