#!/usr/bin/env node
/**
 * probe-compaction-wiring.mjs —— 只读：看「压缩引擎这一组」到底挂了哪些插件（C213）
 *
 * 为什么需要：真机上手動 `/compact` 抛过
 *   `Receiver must be an instance of class ChessCompactionEngine`
 * —— 说明有东西把 `this` 换掉了。最可能的来源是**同一 group 里的其它插件**
 * （例如 tool-result-pruner 这类会包装 `ctx.compaction` 的插件），但这一点不能靠猜：
 * 这个脚本把 preset 里那一组原样打出来，并标注「哪些名字听起来会碰 ctx.compaction」。
 *
 * 用法：
 *   node scripts/probe-compaction-wiring.mjs                 # 读 DSH_HOME 下的 cordis.patch.yml
 *   node scripts/probe-compaction-wiring.mjs --file <path>
 *   node scripts/probe-compaction-wiring.mjs --json
 *
 * 退出码：0 = 读到并给出结论（哪怕有嫌疑项）；1 = 找不到文件/解析不出 group。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** 从 YAML 文本里抠出 `id: compaction` 那个 group 的成员（不引第三方 yaml 依赖）。 */
export function extractCompactionGroup(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-\s+id:\s*compaction\s*$/.test(l));
  if (start < 0) return null;
  const indent = (l) => l.match(/^\s*/)[0].length;
  const baseIndent = indent(lines[start]);
  const members = [];
  let groupHeader = [];
  let inConfig = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const ind = indent(line);
    if (line.trim().length > 0 && ind <= baseIndent && /^\s*-\s+id:/.test(line)) break; // 下一个同级插件
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (inConfig && /^\s*-\s+id:\s*(\S+)\s*$/.test(line)) {
      const id = line.match(/^\s*-\s+id:\s*(\S+)/)[1];
      const memberIndent = ind;
      const member = { id, name: null, config: {} };
      // 采集该成员后续行（缩进更深）
      for (let j = i + 1; j < lines.length; j += 1) {
        const l2 = lines[j];
        const i2 = indent(l2);
        if (l2.trim().length > 0 && i2 < memberIndent) break;
        // 兄弟成员开始了（同缩进的 `- id:`）⇒ 本成员结束，别再吃别人的 config
        if (i2 === memberIndent && /^\s*-\s+id:/.test(l2)) break;
        const nameHit = l2.match(/^\s+name:\s*'?([^'\s]+)'?\s*$/);
        if (nameHit && member.name === null) member.name = nameHit[1];
        const kv = l2.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/);
        if (kv && kv[1] !== "name") member.config[kv[1]] = kv[2].replace(/\s+#.*$/, "").replace(/^'|'$/g, "");
      }
      members.push(member);
      continue;
    }
    if (!inConfig) groupHeader.push(line.trim());
  }
  return { baseIndent, header: groupHeader.filter(Boolean), members };
}

/**
 * 把同组成员分成三类（纯函数，便于单测）：
 *   wrapper  —— 名字像「包装/代理压缩」的（pruner / wrap / proxy）⇒ 最可能换掉 `this`
 *   caller   —— 名字像「命令/入口」的（command / compact-command）⇒ 它只是调用方
 *   provider —— 我们自己（engine）
 */
export function classifyMembers(members) {
  const wrapper = [];
  const caller = [];
  const provider = [];
  for (const m of members ?? []) {
    const s = `${m.id} ${m.name ?? ""}`.toLowerCase();
    if (/gokifu-compact/.test(s) && /engine/.test(s)) provider.push(m);
    else if (/prun|wrap|proxy|intercept/.test(s)) wrapper.push(m);
    else if (/command|cmd|slash/.test(s)) caller.push(m);
  }
  return { provider, wrapper, caller };
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf("--file");
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : nodePath.join(nodeOs.homedir(), ".dsh");
  const file = fileArg >= 0 ? args[fileArg + 1] : nodePath.join(home, "cordis.patch.yml");
  const json = args.includes("--json");
  if (!nodeFs.existsSync(file)) {
    process.stderr.write(`找不到 ${file}\n`);
    process.exit(1);
  }
  const group = extractCompactionGroup(nodeFs.readFileSync(file, "utf8"));
  if (group === null) {
    process.stderr.write(`${file} 里没有 \`- id: compaction\` 这一组\n`);
    process.exit(1);
  }
  const roles = classifyMembers(group.members);
  const suspects = roles.wrapper;
  const payload = {
    file,
    members: group.members,
    provider: roles.provider.map((m) => m.id),
    wrapper: roles.wrapper.map((m) => `${m.id} → ${m.name ?? "?"}`),
    caller: roles.caller.map((m) => m.id),
  };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + String.fromCharCode(10));
  } else {
    process.stdout.write(`压缩引擎所在 group：${file}` + String.fromCharCode(10));
    for (const m of group.members) {
      const cfgKeys = Object.keys(m.config);
      process.stdout.write(`  · ${m.id} → ${m.name ?? "?"}${cfgKeys.length > 0 ? `（${cfgKeys.map((k) => `${k}=${m.config[k]}`).join(", ")}）` : ""}` + String.fromCharCode(10));
    }
    if (roles.caller.length > 0) process.stdout.write(`  调用方（命令入口）：${roles.caller.map((m) => m.id).join(", ")}` + String.fromCharCode(10));
    process.stdout.write(
      (suspects.length > 0
        ? `⚠ 同组里有 ${suspects.length} 个**包装器**：${suspects.map((m) => m.id).join(", ")} —— 真机若报「Receiver must be an instance of class …」，先查它们是不是把 ctx.compaction 换成了代理对象`
        : "✓ 同组里没有明显会包装 ctx.compaction 的插件") + String.fromCharCode(10),
    );
  }
  process.exit(0);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
