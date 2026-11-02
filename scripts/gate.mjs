/**
 * gate.mjs —— **一条命令跑完所有门禁**（C272）
 *
 * 为什么要有它：合并/交付前要跑的东西散在六个脚本里（测试、越权审计、文档索引、CHANGELOG 索引、
 * 交接检查、打包可复现），每一步的命令和判据都在不同文件里。人手跑必然漏——
 * 本会话就漏过一次「文档里的测试数没跟着更新」。
 *
 * 用法：
 *   node scripts/gate.mjs              # 全跑
 *   node scripts/gate.mjs --no-pack    # 跳过 npm pack（慢，且需要网络/磁盘）
 *   node scripts/gate.mjs --quiet      # 只打印汇总（子进程输出收起来）
 *
 * 退出码：全部通过 0；任一失败 1（并逐条列出失败的门）。
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

/**
 * 门禁清单（顺序 = 从便宜到贵；失败时先看到便宜的那几条，反馈更快）。
 * `expect` = 通过时该步的输出特征；匹配不到也算失败（防止"命令退出 0 但其实没跑"）。
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
    // 已知遗留 1 条（legacy foldMark，见 HANDOFF 的「已知遗留」）—— 超过 1 才算回归
    expect: (out) => {
      const m = out.match(/FAIL\s+(\d+)/);
      if (m === null) return { ok: false, note: "输出里没有 FAIL 计数（判据消失？）" };
      const n = Number(m[1]);
      return { ok: n <= 1, note: n === 1 ? "1 条已知遗留（legacy foldMark）" : `FAIL=${n}` };
    },
  },
  // 从仓库根跑：部分测试按 CWD 解析路径（在 test/ 下跑会 ENOENT）
  { id: "test", name: "全量测试全绿", script: "test/run.mjs", expect: /0 failed/ },
  { id: "pack", name: "打包内容可从任意 commit 复现", script: "pack-check.mjs", expect: /打包内容全部有出处/, optional: true },
]);

function runOne(gate) {
  const cwd = gate.dir === "test" ? nodePath.join(ROOT, "test") : ROOT;
  // 一律从仓库根跑（部分测试按 CWD 解析相对路径，在 test/ 下跑会 ENOENT）
  const script = gate.script.startsWith("test/") ? nodePath.join(ROOT, "test", "run.mjs") : nodePath.join(ROOT, "scripts", gate.script);
  const started = Date.now();
  const res = spawnSync(process.execPath, [script, ...(gate.args ?? [])], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  const out = `${stdout}\n${stderr}`;
  // 期望值可以是正则（默认）也可以是函数（返回 {ok, note}）——有的门"非 0 退出"本身就是结论
  const verdict = typeof gate.expect === "function" ? gate.expect(out) : { ok: gate.expect.test(out), note: undefined };
  const ok = verdict.ok === true && (res.status === 0 || gate.ignoreExit === true);
  return { ...gate, ok, note: verdict.note, ms, status: res.status, out };
}

export function main(argv = process.argv.slice(2)) {
  const skipPack = argv.includes("--no-pack");
  const quiet = argv.includes("--quiet");
  const gates = GATES.filter((g) => !(skipPack && g.optional));

  const results = [];
  for (const gate of gates) {
    const r = runOne(gate);
    results.push(r);
    const mark = r.ok ? "✓" : "✗";
    process.stdout.write(`  ${mark} ${r.name}（${(r.ms / 1000).toFixed(1)}s）\n`);
    if (!r.ok) {
      // 失败时把子进程的输出尾部贴出来 —— 否则"为什么红"还要再跑一遍才知道
      const tail = r.out.trim().split("\n").slice(-12).join("\n");
      process.stdout.write(`     ↳ exit=${r.status}\n${tail.replace(/^/gm, "     ")}\n`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  process.stdout.write(
    `\n${failed.length === 0 ? "✅" : "❌"} 门禁 ${results.length - failed.length}/${results.length} 通过，用时 ${(total / 1000).toFixed(1)}s` +
      (skipPack ? "（已跳过 pack）" : "") +
      "\n",
  );
  if (failed.length > 0) process.stdout.write(`失败：${failed.map((r) => r.id).join(" / ")}\n`);
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
