/**
 * probe-compaction-wiring.test.mjs —— 「压缩引擎这一组挂了谁」的解析与角色分类（C213）
 *
 * 背景：真机手动 `/compact` 抛过 `Receiver must be an instance of class ChessCompactionEngine`
 * —— 说明有东西把 `this` 换掉了。能查的线索只有 preset（`cordis.patch.yml`）里那一组；
 * 这个探针把成员与角色（provider / wrapper / caller）摆出来，让「先怀疑谁」有依据而不是靠猜。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { classifyMembers, extractCompactionGroup } from "../scripts/probe-compaction-wiring.mjs";

export const tests = {};
const NL = String.fromCharCode(10);

const SAMPLE = [
  "  - id: compaction",
  "    name: cordis:group",
  "    group: true",
  "    config:",
  "      - id: gokifu-compact",
  "        name: 'dsh-gokifu-compact/engine'",
  "      - id: command-compact",
  "        name: '@deepseek-ai/dsh-command-compact'",
  "      - id: tool-result-pruner",
  "        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  "        config:",
  "          thresholdChars: 8192",
  "          headChars: 4096",
  "  - id: delegation",
  "    name: cordis:group",
].join(NL);

tests["C213 能从 preset 里抠出 compaction 组，且每个成员的 config 不串味"] = (t) => {
  const group = extractCompactionGroup(SAMPLE);
  t.eq(group !== null, true, "必须找到 compaction 组");
  const ids = group.members.map((m) => m.id);
  t.eq(ids, ["gokifu-compact", "command-compact", "tool-result-pruner"], "成员顺序与内容");
  const pruner = group.members.find((m) => m.id === "tool-result-pruner");
  t.eq(pruner.config.thresholdChars, "8192", "pruner 的 config 必须落在自己身上");
  const engine = group.members.find((m) => m.id === "gokifu-compact");
  t.eq(Object.keys(engine.config).length, 0, "engine 不该吃到 pruner 的 config（串味检查）");
  t.eq(group.members.some((m) => m.id === "delegation"), false, "兄弟 group 不许被算进来");
};

tests["C213 角色分类：provider / wrapper / caller 各自归位（wrapper 才是「换了 this」的头号嫌疑）"] = (t) => {
  const group = extractCompactionGroup(SAMPLE);
  const roles = classifyMembers(group.members);
  t.eq(roles.provider.map((m) => m.id), ["gokifu-compact"], "provider 只有一个");
  t.eq(roles.wrapper.map((m) => m.id), ["tool-result-pruner"], "pruner 必须归到 wrapper");
  t.eq(roles.caller.map((m) => m.id), ["command-compact"], "命令插件归 caller，不许冤枉成 wrapper");
};

tests["C213 缺文件/缺 group 时探针必须失败（不许静默 ok）"] = (t) => {
  t.eq(extractCompactionGroup(""), null, "空文本 ⇒ null");
  t.eq(extractCompactionGroup("  - id: something-else"), null, "没有 compaction 组 ⇒ null（探针据此退出码 1）");
};
