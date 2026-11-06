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

tests["C272 门禁清单：七道判分门一个都不能少，且每道门指向的脚本真实存在"] = (t) => {
  // ★ K-31：新增改动隐私审计是第 7 道判分门；只扫 --changed，不让历史材料把 gate 钉红。
  const judged = GATES.filter((g) => g.advisory !== true).map((g) => g.id).sort();
  const advisory = GATES.filter((g) => g.advisory === true).map((g) => g.id);
  t.eq(judged, ["boundary", "changelog-index", "docs-index", "handoff", "pack", "privacy", "test"], "判分门必须等于这七项");
  t.eq(advisory, ["release-notes", "maintenance", "field-reads", "duplicates", "restart"], "参考门 = 发布说明漂移（C355）+ 维护性（卡授权）+ 重启后核对（卡重启）+ 字段审计（需人判断）");

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

tests["K31 gate 默认以 --changed 运行永久隐私门，且 judged 先于全量测试"] = (t) => {
  const privacy = GATES.find((g) => g.id === "privacy");
  t.ok(privacy, "privacy 门必须存在");
  t.eq(privacy.args, ["--changed"], "日常 gate 只扫相对 HEAD 的新增改动，不做全仓扫描");
  t.eq(privacy.advisory === true, false, "新增泄露必须判红，不能降级 advisory");
  t.ok(GATES.indexOf(privacy) < GATES.findIndex((g) => g.id === "test"), "便宜的隐私门应先于全量测试");
  const cli = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "privacy-audit.mjs"), "utf8");
  t.includes(cli, "const result = pack ? auditPack() : auditChanged()", "CLI 无参默认必须是 --changed");
};

tests["C272 package.json 暴露 gate 命令（不然没人知道有这条）"] = (t) => {
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));
  t.eq(pkg.scripts.gate, "node scripts/gate.mjs", "npm run gate 必须指向 scripts/gate.mjs");
};

tests["C275 三处「怎么验证」的文档都要指向 npm run gate（否则命令存在但没人知道）"] = (t) => {
  const files = [
    ["HANDOFF.md", "HANDOFF"],
    [nodePath.join("docs", "knowledge", "进度.md"), "进度页"],
    [nodePath.join("evidence", "重启验收清单-2026-11-02.md"), "重启验收清单"],
  ];
  for (const [rel, label] of files) {
    const text = nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");
    t.includes(text, "npm run gate", `${label} 必须指向 npm run gate（唯一入口）`);
  }
};
