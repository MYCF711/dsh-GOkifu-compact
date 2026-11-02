/**
 * gate.mjs —— **一条命令跑完所有门禁**（C272 / C273）
 *
 * 为什么要有它：合并/交付前要跑的东西散在六个脚本里（测试、越权审计、文档索引、CHANGELOG 索引、
 * 交接检查、打包可复现），每一步的命令和判据都在不同文件里。人手跑必然漏——
 * 本会话就漏过一次「文档里的测试数没跟着更新」。
 *
 * 两类门：
 *   · **判分门**（judged）—— 失败即门禁红，退出码 1；
 *   · **参考门**（advisory）—— 只报告不判分。用于"卡在需要主人授权"的那些（打 tag / 发版）：
 *     它们不能让门禁永远红，但必须在同一条输出里出现，否则没人看见。
 *
 * 用法：
 *   node scripts/gate.mjs              # 全跑
 *   node scripts/gate.mjs --no-pack    # 跳过 npm pack（慢，且需要磁盘）
 *
 * 退出码：判分门全部通过 0；任一判分门失败 1。
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * 门禁清单（顺序 = 从便宜到贵；失败时先看到便宜的那几条，反馈更快）。
 * `expect` = 通过时该步的输出特征（正则），也可以是 `(out) => ({ ok, note })`。
 * 光有退出码 0 不算过 —— 否则"命令没报错但什么都没检查"会被当成绿。
 */
export const GATES = Object.freeze([
  { id: "boundary", name: "越权审计 0 条", script: "boundary-audit.mjs", expect: /越界线索 0 条/ },
  { id: "docs-index", name: "文档都登记在索引里", script: "docs-index-check.mjs", expect: /未索引文档 0 个/ },
  { id: "changelog-index", name: "CHANGELOG 索引与正文一致", script: "changelog-index.mjs", args: ["--check"], expect: /一致|索引/ },
  {
    id: "handoff",
    name: "交接文档无新的 FAIL",
    script: "handoff-check.mjs",
    ignoreExit: true,
    // ★ C279：legacy foldMark 已由 repair-foldmarks 修掉（FAIL 1 → 0）⇒ 现在要求**必须 0**，
    //   以后再出现 FAIL 就是真回归，不再是"已知遗留"。
    expect: (out) => {
      const m = out.match(/FAIL\s+(\d+)/);
      if (m === null) return { ok: false, note: "输出里没有 FAIL 计数（判据消失？）" };
      const n = Number(m[1]);
      return { ok: n === 0, note: n === 0 ? "0 条（legacy 已修）" : `FAIL=${n}（真回归）` };
    },
  },
  // 从仓库根跑：部分测试按 CWD 解析路径（在 test/ 下跑会 ENOENT）
  { id: "test", name: "全量测试全绿", script: "test/run.mjs", expect: /0 failed/ },
  { id: "pack", name: "打包内容可从任意 commit 复现", script: "pack-check.mjs", expect: /打包内容全部有出处/, optional: true },
  {
    id: "maintenance",
    name: "维护性（版本 / tag / 发版）—— 仅供参考，不算门禁",
    script: "check-maintenance.mjs",
    // ★ C273：这条卡在**需要主人授权**（打 tag / npm publish）上，不能当门禁红；
    //   但必须在同一条命令的输出里出现，否则"没发版"永远没人看见。
    advisory: true,
    ignoreExit: true,
    expect: /通过 \d+/,
  },
  {
    id: "field-reads",
    name: "自有结构字段审计（读了但没人写）—— 仅供参考",
    script: "audit-field-reads.mjs",
    // ★ C281：C280 那种「读了不存在的字段却永远报正常」的错，靠人眼发现不了 —— 每次门禁顺带扫一遍。
    //   不做判分门：它扫的是"疑似"，需要人看一眼再决定，红了不该挡住交付。
    advisory: true,
    ignoreExit: true,
    expect: /字段审计/,
  },
  {
    id: "restart",
    name: "重启后核对（运行实例 vs 磁盘代码）—— 仅供参考",
    script: "post-restart-check.mjs",
    // ★ C274：这条回答的是"我改的东西到底跑起来了没有"——**每次门禁都该顺带看一眼**。
    //   它天然会红（代码新、进程旧），所以只能当参考门；红的时候正是该重启的时候。
    advisory: true,
    ignoreExit: true,
    expect: /重启后核对/,
  },
]);

function scriptPathOf(gate) {
  return gate.script.startsWith("test/")
    ? nodePath.join(ROOT, "test", "run.mjs")
    : nodePath.join(ROOT, "scripts", gate.script);
}

function runOne(gate) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [scriptPathOf(gate), ...(gate.args ?? [])], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const out = `${String(res.stdout ?? "")}\n${String(res.stderr ?? "")}`;
  const verdict = typeof gate.expect === "function" ? gate.expect(out) : { ok: gate.expect.test(out), note: undefined };
  const ok = verdict.ok === true && (res.status === 0 || gate.ignoreExit === true);
  return { ...gate, ok, note: verdict.note, ms, status: res.status, out };
}

/** 参考门的结论行：把"通过 N · 警告 M · 失败 K"和第一条 ✗ 摘出来。 */
function advisorySummary(out) {
  const plain = out.replace(ANSI, "");
  const stat = (plain.match(/通过\s+\d+\s*·\s*警告\s+\d+\s*·\s*失败\s+\d+/) ?? [])[0];
  // 有的参考门（如 post-restart-check）没有统计行，只有逐条 ✓/!/✗ —— 那就摘前两条问题行
  const badLines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("✗") || line.startsWith("!"));
  if (stat === undefined) {
    if (badLines.length === 0) return null;
    return badLines.slice(0, 2).join(" · ") + (badLines.length > 2 ? ` · …另 ${badLines.length - 2} 条` : "");
  }
  const bad = badLines[0];
  return bad === undefined ? stat.trim() : `${stat.trim()} · ${bad}`;
}

export function main(argv = process.argv.slice(2)) {
  const skipPack = argv.includes("--no-pack");
  const gates = GATES.filter((g) => !(skipPack && g.optional));

  const results = [];
  for (const gate of gates) {
    const r = runOne(gate);
    results.push(r);
    const mark = r.advisory === true ? "—" : r.ok ? "✓" : "✗";
    process.stdout.write(`  ${mark} ${r.name}（${(r.ms / 1000).toFixed(1)}s）${r.advisory !== true && r.note ? ` — ${r.note}` : ""}\n`);
    if (r.advisory === true) {
      const summary = advisorySummary(r.out);
      if (summary !== null) process.stdout.write(`     ↳ ${summary}\n`);
      continue;
    }
    if (!r.ok) {
      // 失败时把子进程的输出尾部贴出来 —— 否则"为什么红"还要再跑一遍才知道
      const tail = r.out.replace(ANSI, "").trim().split("\n").slice(-12).join("\n");
      process.stdout.write(`     ↳ exit=${r.status}\n${tail.replace(/^/gm, "     ")}\n`);
    }
  }

  const judged = results.filter((r) => r.advisory !== true);
  const failed = judged.filter((r) => r.ok !== true);
  const advisory = results.filter((r) => r.advisory === true);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  process.stdout.write(
    `\n${failed.length === 0 ? "✅" : "❌"} 门禁 ${judged.length - failed.length}/${judged.length} 通过，用时 ${(total / 1000).toFixed(1)}s` +
      (advisory.length > 0 ? `（另有 ${advisory.length} 条仅供参考）` : "") +
      (skipPack ? "（已跳过 pack）" : "") +
      "\n",
  );
  if (failed.length > 0) process.stdout.write(`失败：${failed.map((r) => r.id).join(" / ")}\n`);
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
