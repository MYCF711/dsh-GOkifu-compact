/**
 * gate.test.mjs —— 「一条命令跑完门禁」本身也要有判据（C272）
 *
 * 这条测试防的是：门禁清单被悄悄删掉一项（比如为了让它变绿而删掉 pack）。
 * 清单只能**增**或**显式改名**，不能在无人注意时消失。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { GATES } from "../scripts/gate.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const tests = {};

tests["C272 门禁清单：六道门一个都不能少，且每道门指向的脚本真实存在"] = (t) => {
  // ★ C273：判分门 6 项 + 参考门 1 项（维护性卡在"需主人授权打 tag/发版"，不能当门禁红）
  const judged = GATES.filter((g) => g.advisory !== true).map((g) => g.id).sort();
  const advisory = GATES.filter((g) => g.advisory === true).map((g) => g.id);
  t.eq(judged, ["boundary", "changelog-index", "docs-index", "handoff", "pack", "test"], "判分门必须等于这六项");
  t.eq(advisory, ["maintenance", "restart"], "参考门 = 维护性（卡在授权）+ 重启后核对（卡在需要重启）");

  for (const gate of GATES) {
    const rel = gate.script.startsWith("test/") ? gate.script : nodePath.join("scripts", gate.script);
    t.eq(nodeFs.existsSync(nodePath.join(ROOT, rel)), true, `门禁 ${gate.id} 指向的 ${rel} 不存在`);
    const kind = typeof gate.expect;
    t.eq(kind === "object" || kind === "function", true, `门禁 ${gate.id} 必须有判据（正则应是个 RegExp 对象）`);
  }
  // pack 是唯一可跳过的（慢 + 需要磁盘），跳过得有显式理由字段
  const optional = GATES.filter((g) => g.optional === true).map((g) => g.id);
  t.eq(optional, ["pack"], "只有 pack 允许被 --no-pack 跳过");
  // 参考门永远不许影响退出码（否则"没发版"会把门禁钉死成红）
  for (const gate of GATES.filter((g) => g.advisory === true)) {
    t.eq(gate.optional === true, false, `${gate.id} 是参考门，不该同时是 optional（语义要分清）`);
  }
};

tests["C272 package.json 暴露 gate 命令（不然没人知道有这条）"] = (t) => {
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));
  t.eq(pkg.scripts.gate, "node scripts/gate.mjs", "npm run gate 必须指向 scripts/gate.mjs");
};
