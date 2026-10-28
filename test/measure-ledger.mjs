/**
 * measure-ledger.mjs —— 全库热清单的「代价 / 信息量」测量器
 *
 * 为什么需要它：热清单的每次改动都在做**权衡**（多写一点 → 多花 token），
 * 而这个权衡只能用真实棋谱量出来，不能靠感觉。本工具把 `<DSH_HOME>/chess-context/sessions`
 * 下每个会话的热清单渲染一遍，报告三件事：
 *   · tokens —— 每屏多贵（保守口径：字符数 / 3）
 *   · 带原因的失败边数 —— 模型判断「是不是同一个坑」靠的就是报错原文
 *   · 降级档位 —— 预算压力落在哪一档
 *
 * 用法：
 *   node test/measure-ledger.mjs [out.json]        # 只读，不写任何棋谱
 *   DSH_HOME=… node test/measure-ledger.mjs        # 换一个 home
 *
 * 对照实验：`git worktree add <dir> <old-commit>`，把本文件拷进去跑，对比两份 json
 * （v1.4.0 的报告见 `evidence/热清单标记AB实验.md` §3）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fromJSON } from "../src/graph.mjs";
import { renderLedger } from "../src/ledger.mjs";

const root = process.env.CHESS_SESSIONS ?? nodePath.join(process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh"), "chess-context", "sessions");
// ★ 第一个非 `--` 参数才是输出文件（写成 process.argv[2] 会把 `--terse` 当成文件名，
//   实测会在 cwd 里生成一个叫 `--terse` 的文件）。
const outArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const outPath = outArg ?? "";
const markers = process.argv.includes("--terse") ? "terse" : process.argv.includes("--off") ? "off" : "semantic";

if (!nodeFs.existsSync(root)) {
  console.error(`找不到棋谱目录：${root}`);
  process.exit(1);
}

const rows = [];
for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = nodePath.join(root, d.name, "graph.json");
  if (!nodeFs.existsSync(f)) continue;
  let g;
  try {
    g = fromJSON(nodeFs.readFileSync(f, "utf8"));
  } catch {
    continue;
  }
  const r = renderLedger(g, { maxTokens: 500, markers });
  const fails = Object.values(g.edges).filter((e) => e.result === "failure").length;
  const edgeLines = r.text.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- …"));
  rows.push({
    session: d.name,
    agents: Object.values(g.nodes).filter((n) => n.kind === "agent").length,
    fails,
    shown: r.shownFailures,
    level: r.level,
    tokens: r.tokens,
    chars: r.text.length,
    withReason: edgeLines.filter((l) => l.includes(" → ")).length,
    tagged: edgeLines.filter((l) => l.includes(" [")).length,
  });
}

const sum = rows.reduce(
  (a, r) => ({ tokens: a.tokens + r.tokens, withReason: a.withReason + r.withReason, tagged: a.tagged + r.tagged, shown: a.shown + r.shown, level: a.level + r.level }),
  { tokens: 0, withReason: 0, tagged: 0, shown: 0, level: 0 },
);

if (outPath) nodeFs.writeFileSync(outPath, JSON.stringify(rows, null, 1), "utf8");

console.log(`== measure-ledger（markers=${markers}）==`);
for (const r of rows) {
  console.log(
    `${r.session.slice(0, 26).padEnd(28)} fails=${String(r.fails).padStart(3)} shown=${String(r.shown).padStart(3)} L${r.level} tok=${String(r.tokens).padStart(4)} reasons=${String(r.withReason).padStart(3)} tagged=${String(r.tagged).padStart(3)}`,
  );
}
console.log(
  `\n合计：${rows.length} 个会话 / 展示 ${sum.shown} 条失败边 / tokens ${sum.tokens} / 带原因 ${sum.withReason} / 带标记 ${sum.tagged} / 平均档位 L${(sum.level / Math.max(rows.length, 1)).toFixed(2)}`,
);
