/**
 * gate.test.mjs —— 「一条命令跑完门禁」本身也要有判据（C272）
 *
 * 这条测试防的是：门禁清单被悄悄删掉一项（比如为了让它变绿而删掉 pack）。
 * 清单只能**增**或**显式改名**，不能在无人注意时消失。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATES } from "../scripts/gate.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const tests = {};

tests["C272 门禁清单：八道判分门一个都不能少，且每道门指向的脚本真实存在"] = (t) => {
  // ★ K-31：新增改动隐私审计是第 7 道判分门；只扫 --changed，不让历史材料把 gate 钉红。
  // ★ GH1（2026-11-08）：AX-03 双哈希口径是第 8 道判分门；门禁模式（--require-source
  //   --require-manifest），缺私有产物 / 缺 sidecar / 源码加载失败都不许假绿。
  const judged = GATES.filter((g) => g.advisory !== true).map((g) => g.id).sort();
  const advisory = GATES.filter((g) => g.advisory === true).map((g) => g.id);
  t.eq(judged, ["boundary", "changelog-index", "docs-index", "handoff", "k2-hash", "pack", "privacy", "test"], "判分门必须等于这八项");
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

tests["GH1 k2-hash 门禁：门禁模式 + 缺产物显式红（不许假绿）"] = (t) => {
  // ★ GH1（2026-11-08）：AX-03 双哈希口径接入 gate 时，这条测试守的是「接线」而不是哈希算法本身
  //   （算法正反例在 test/k2-hash-check.test.mjs 的 27 条里）。
  //   要防的三种假绿：① 门被降级成参考门；② 门禁模式被改成兼容模式（skip 冒充通过）；
  //   ③ 私有产物缺失（`tmp/` 是 git 忽略的）时安静退出 0。
  const gate = GATES.find((g) => g.id === "k2-hash");
  t.ok(gate, "k2-hash 必须在门禁清单里（否则 AX-03 双哈希口径无人守）");
  t.eq(gate.advisory === true, false, "双哈希口径必须判分，不能降级成参考门");
  t.eq(gate.args, ["--require-source", "--require-manifest"], "必须是门禁模式：源码加载失败 / sidecar 缺失都要红");
  t.eq(gate.optional === true, false, "--no-pack 不许跳过哈希门（它只读本地文件，不吃磁盘也不慢）");
  t.ok(GATES.indexOf(gate) < GATES.findIndex((g) => g.id === "test"), "0.3s 的哈希门应先于全量测试");

  // 输出判据：只认汇总行，且 pass / fail / skip 三个数都要对得上（"全 skip 但没报错"同样是假绿）
  const expect = gate.expect;
  t.eq(typeof expect, "function", "判据必须是函数（要同时看 verdict / fail / skip 三个数）");
  t.eq(expect("== PASS（29 checks: 29 pass, 0 fail, 0 skip）==").ok, true, "29 项全 pass 必须绿");
  t.eq(expect("== FAIL（29 checks: 27 pass, 2 fail, 0 skip）==").ok, false, "有 fail 必须红");
  t.eq(expect("== FAIL（29 checks: 27 pass, 0 fail, 2 skip）==").ok, false, "门禁模式不许用 skip 冒充通过");
  t.eq(expect("== PASS（0 checks: 0 pass, 0 fail, 0 skip）==").ok, false, "0 项检查不算过（什么都没查）");
  // 夹具是「退出码 2：输入错误，没有汇总行」那一类输出（真实文案见 k2-hash-check 的 readRequiredFile）。
  // 故意不写绝对路径：那会被 privacy-audit 的 P3-PATH 判成 review（本仓路径字面量不许进仓库）。
  t.eq(expect("✗ 文件不存在：tmp/axiom-2026-11-07/ax03/prereg.json").ok, false, "缺私有产物（退出码 2、无汇总行）必须红");
  t.eq(expect("").ok, false, "空输出必须红");
  t.includes(expect("== FAIL（29 checks: 27 pass, 2 fail, 0 skip）==").note, "2 fail", "红的时候要说明 fail 数（否则还要再跑一遍才知道为什么红）");

  // 真跑一遍：冻结产物已在仓库里（C660 版本化到 `test/fixtures/ax03/`）⇒ 必须 PASS 且 0 skip
  const artifacts = ["prereg.json", "fixtures.json"].map((name) => nodePath.join(ROOT, "test", "fixtures", "ax03", name));
  const present = artifacts.every((file) => nodeFs.existsSync(file));
  t.eq(present, true, "C660：AX-03 冻结产物必须版本化在仓库里（否则干净 checkout 上整组 skip）");
  const run = spawnSync(process.execPath, [nodePath.join(ROOT, "scripts", "k2-hash-check.mjs"), ...gate.args], { cwd: ROOT, encoding: "utf8" });
  const out = `${String(run.stdout ?? "")}
${String(run.stderr ?? "")}`;
  t.eq(run.status, 0, `冻结产物齐全时必须 exit 0，实际 ${run.status}`);
  t.eq(expect(out).ok, true, `判据必须绿，实际汇总行：${out.split(String.fromCharCode(10)).find((line) => line.startsWith("== ")) ?? "（无汇总行）"}`);

  // ★ C660：产物版本化之后，「缺产物」不能再靠"本机没那个目录"来造 —— 用一个**空的临时仓库**显式造。
  //   要防的假绿是「缺产物时安静退出 0」，所以这条负例必须真跑。
  const emptyRepo = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gh1-nofix-"));
  try {
    const missing = spawnSync(process.execPath, [nodePath.join(ROOT, "scripts", "k2-hash-check.mjs"), "--repo", emptyRepo, ...gate.args], { cwd: ROOT, encoding: "utf8" });
    const missingOut = `${String(missing.stdout ?? "")}
${String(missing.stderr ?? "")}`;
    t.eq(missing.status !== 0, true, "冻结产物缺失时不许 exit 0（那是假绿）");
    t.includes(missingOut, "文件不存在", "缺产物必须明确报出缺哪个文件，而不是跳过");
    t.eq(expect(missingOut).ok, false, "缺产物时判据必须红");
  } finally {
    nodeFs.rmSync(emptyRepo, { recursive: true, force: true });
  }
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
