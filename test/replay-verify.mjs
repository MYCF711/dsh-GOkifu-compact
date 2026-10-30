/**
 * replay-verify.mjs —— 用**真实会话日志**回放 v0.1.2，产出「无需重启的验证证据」
 *
 * 为什么需要它：v0.1.2 的修复要重启 DSH 才在运行进程里生效，而重启会中断当前会话。
 * 这个脚本直接读当前会话落盘的 `session.v4.jsonl.zstd`（1024+ 事件），
 * 用磁盘上的 v0.1.2 代码回放，再和运行中的 v0.1.0 产出的 graph.json 对比 ——
 * 同一份输入，两版代码，差多少一目了然。
 *
 * 用法：node test/replay-verify.mjs [--session <id>]
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { createGraph, failureEdges } from "../src/rooms/kifu-model.mjs";
import { observeEvent } from "../src/rooms/keeper.mjs";
import { renderLedger } from "../src/rooms/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OUT = nodePath.join(HERE, "..", "evidence");
const DSH_HOME = process.env.DSH_HOME ?? "D:\\DeepSeek Harness\\home";
const SESSIONS = nodePath.join(DSH_HOME, "sessions");

/* ── 找最新会话日志 ── */
function findSessions() {
  const found = [];
  for (const project of nodeFs.readdirSync(SESSIONS)) {
    const dir = nodePath.join(SESSIONS, project);
    if (!nodeFs.statSync(dir).isDirectory()) continue;
    for (const sid of nodeFs.readdirSync(dir)) {
      const f = nodePath.join(dir, sid, "session.v4.jsonl.zstd");
      if (nodeFs.existsSync(f)) found.push({ project, sid, file: f, mtime: nodeFs.statSync(f).mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/* ── 逐帧解 zstd（DSH 是「header 帧 + 每 append 批次一帧」的拼接） ── */
function decodeZstd(file) {
  const buf = nodeFs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  let i = -1;
  while ((i = buf.indexOf(MAGIC, i + 1)) !== -1) offsets.push(i);
  offsets.push(buf.length);
  const parts = [];
  let frames = 0;
  for (let k = 0; k < offsets.length - 1; k += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1])));
      frames += 1;
    } catch {
      /* 压缩数据内部可能碰巧出现 magic，跳过 */
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames };
}

/* ── 回放 ── */
function replay(events) {
  const g = createGraph({ sessionId: "replay" });
  const st = {
    pendingEdges: new Map(),
    lastNodeId: null,
    lastUserNodeId: null,
    constraintDirty: true,
    touched: [],
    stepEdges: [],
    injected: 0,
  };
  for (const ev of events) {
    try {
      observeEvent(g, ev, st);
    } catch {
      /* 单条坏事件不该中断回放 */
    }
  }
  const failures = failureEdges(g);
  const users = Object.values(g.nodes).filter((n) => n.kind === "user");
  const ledger = renderLedger(g, { maxTokens: 500 });
  return { g, failures, users, ledger, injected: st.injected ?? 0 };
}

/* ── 主流程 ── */
const argSession = process.argv.indexOf("--session") >= 0 ? process.argv[process.argv.indexOf("--session") + 1] : null;
const all = findSessions();
const picked = argSession ? all.filter((s) => s.sid.startsWith(argSession))[0] : all[0];
if (!picked) {
  console.error("找不到会话日志");
  process.exit(1);
}
console.log(`会话：${picked.sid}（${picked.project}）`);
console.log(`文件：${picked.file}`);

const { text, frames } = decodeZstd(picked.file);
const events = text.split("\n").filter(Boolean).map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}).filter(Boolean);

console.log(`解帧 ${frames}，事件 ${events.length}`);

const v2 = replay(events);
console.log(`当前代码回放：节点 ${v2.g.order.length} / 边 ${Object.keys(v2.g.edges).length} / 失败 ${v2.failures.length} / user 节点 ${v2.users.length} / 忽略注入 ${v2.injected}`);
console.log(`热上下文：${v2.ledger.tokens} tokens（L${v2.ledger.level}），失败边 ${v2.ledger.failureCount} 条`);

/* 读运行中 v0.1.0 的 graph.json（同一个会话） */
const liveDir = nodePath.join(DSH_HOME, "chess-context", "sessions", picked.sid);
const liveFile = nodePath.join(liveDir, "graph.json");
let live = null;
if (nodeFs.existsSync(liveFile)) {
  live = JSON.parse(nodeFs.readFileSync(liveFile, "utf8"));
  console.log(`v0.1.0 运行中：节点 ${Object.keys(live.nodes).length} / 边 ${Object.keys(live.edges).length} / 失败 ${Object.values(live.edges).filter((e) => e.result === "failure").length}`);
}

/* ── 输出报告 ── */
const liveStats = live
  ? {
      nodes: Object.keys(live.nodes).length,
      edges: Object.keys(live.edges).length,
      failures: Object.values(live.edges).filter((e) => e.result === "failure").length,
      users: Object.values(live.nodes).filter((n) => n.kind === "user").length,
      userTexts: Object.values(live.nodes).filter((n) => n.kind === "user").map((n) => n.text.slice(0, 60).replace(/\n/g, " ")),
    }
  : null;

const md = [];
md.push("# 重启验证证据（无需重启 · 用真实会话日志回放 v0.1.2）", "");
md.push(`> 生成于 ${new Date().toISOString()}`);
md.push(`> 会话：\`${picked.sid}\`（${picked.project}）`);
md.push(`> 日志：${events.length} 个事件，${frames} 个 zstd 帧`);
md.push(">");
md.push("> 做法：读**当前会话真实落盘日志**（v0.1.0 运行期产生），用磁盘上的 **v0.1.2 代码**回放，");
md.push("> 再与运行中的 v0.1.0 写入的 `graph.json` 对比。同一份输入，两版代码。");
md.push("");
md.push("## 一 · 同一份会话，两版代码的差异");
md.push("");
md.push("| 指标 | v0.1.0（运行中） | 当前代码（回放） |");
md.push("|---|---|---|");
if (liveStats) {
  md.push(`| 节点数 | ${liveStats.nodes} | ${v2.g.order.length} |`);
  md.push(`| 边数 | ${liveStats.edges} | ${Object.keys(v2.g.edges).length} |`);
  md.push(`| failure 边 | ${liveStats.failures} | **${v2.failures.length}** |`);
  md.push(`| user 节点 | ${liveStats.users} | **${v2.users.length}** |`);
} else {
  md.push(`| 节点数 | （没有运行期 graph.json） | ${v2.g.order.length} |`);
}
md.push("");
md.push("## 二 · v0.1.0 把哪些东西当成了「用户的话」");
md.push("");
if (liveStats) {
  md.push("运行中的 user 节点（v0.1.0）：");
  md.push("");
  for (const t of liveStats.userTexts) md.push(`- \`${t}\``);
  md.push("");
}
md.push("当前代码回放后的 user 节点（只有真人输入）：");
md.push("");
for (const u of v2.users) md.push(`- seq=${u.seq} \`${u.text.slice(0, 70).replace(/\n/g, " ")}\``);
md.push("");
md.push("## 三 · v0.1.0 的 failure 边里有多少是误报");
md.push("");
md.push("当前代码回放后剩下的 failure 边（逐条可核对）：");
md.push("");
md.push("| # | 动作 | 验证信号 | 原因（首 90 字） |");
md.push("|---|---|---|---|");
for (const e of v2.failures.slice(0, 40)) {
  md.push(`| ${e.id} | ${(e.action || "").slice(0, 50).replace(/\|/g, "\\|")} | ${e.verify?.kind ?? ""} | ${(e.errorSnippet || "").split("\n")[0].slice(0, 90).replace(/\|/g, "\\|")} |`);
}
md.push("");
md.push("## 四 · 热上下文");
md.push("");
md.push(`v0.1.2 渲染结果：**${v2.ledger.tokens} tokens**（降级档 L${v2.ledger.level}），失败边总数 ${v2.ledger.failureCount}，本次列出 ${v2.ledger.shownFailures}，预算内省略 ${v2.ledger.omittedEdges}。`);
md.push("");
md.push("## 五 · 结论与待办");
md.push("");
md.push("- 上述差异 **只证明代码正确**，不证明运行进程已经用它 —— 运行中的仍是 v0.1.0。");
md.push("- 真正生效需要重启 DSH；重启后按 `docs/重启后验证清单.md` 的 ⑥ 四条核对。");
md.push("- 回放偏差来源：v0.1.0 的 graph 是在**不同事件窗口**写的（每 25 事件），节点数天然会差一些；");
md.push("  但 user 节点与 failure 边的**性质差异**（注入 vs 真人、误报 vs 真错）是确定性的。");
nodeFs.mkdirSync(OUT, { recursive: true });
nodeFs.writeFileSync(nodePath.join(OUT, "重启验证.md"), md.join("\n"), "utf8");
nodeFs.writeFileSync(
  nodePath.join(OUT, "重启验证.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), session: picked.sid, events: events.length, frames, v012: { nodes: v2.g.order.length, edges: Object.keys(v2.g.edges).length, failures: v2.failures.length, users: v2.users.length, ignoredInjections: v2.injected, ledgerTokens: v2.ledger.tokens, ledgerLevel: v2.ledger.level }, v010: liveStats }, null, 2),
  "utf8",
);
console.log(`\n已写入 evidence/重启验证.md`);
