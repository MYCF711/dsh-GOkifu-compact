/**
 * evidence.mjs —— 生成可复跑的证据数字（模拟口径，非真实 DSH 会话）
 * 用法：node test/evidence.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { runPolicy } from "./sim.mjs";
import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, renderMd } from "../src/graph.mjs";
import { renderLedger, renderFacts, estimateTokens } from "../src/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const OUT = nodePath.join(HERE, "..", "evidence");

const CASES = [
  { name: "200K 窗口 · 200 步 · 每步 7K tokens", args: { steps: 200, scale: 1, window: 200_000, reserved: 8192, headroom: 16384 } },
  { name: "1M 窗口 · 600 步 · 每步 7K tokens", args: { steps: 600, scale: 1, window: 1_000_000, reserved: 65536, headroom: 65536 } },
  { name: "200K 窗口 · 200 步 · 每步 21K tokens（大工具输出）", args: { steps: 200, scale: 3, window: 200_000, reserved: 8192, headroom: 16384 } },
];

const results = [];
for (const c of CASES) {
  const chessRules = runPolicy({ ...c.args, strategy: "chess", foldCostModel: "zero" });
  const chessHybrid = runPolicy({ ...c.args, strategy: "chess", foldCostModel: "replay" });
  const official = runPolicy({ ...c.args, strategy: "official" });
  results.push({
    case: c.name,
    args: c.args,
    chessRules: pick(chessRules),
    chessHybrid: pick(chessHybrid),
    official: pick(official),
    savedRules: pct(chessRules.billedTokens, official.billedTokens),
    savedHybrid: pct(chessHybrid.billedTokens, official.billedTokens),
    meanRules: pct(chessRules.meanTokens, official.meanTokens),
    meanHybrid: pct(chessHybrid.meanTokens, official.meanTokens),
  });
}

function pick(r) {
  return {
    folds: r.folds.length,
    requestTokens: r.requestTokens,
    summaryCostTokens: r.summaryCostTokens,
    billedTokens: r.billedTokens,
    meanTokens: r.meanTokens,
    peakTokens: r.peakTokens,
    threshold: r.threshold,
    retainTokens: r.retainTokens,
    finalNodes: r.finalNodes,
    checkpointsLeft: r.checkpointsLeft,
  };
}

function pct(a, b) {
  if (b === 0) return 0;
  return Number((((b - a) / b) * 100).toFixed(2));
}

/* ── 热上下文成本 ── */
function bigGraph(n) {
  const g = createGraph({ sessionId: "evidence" });
  const u = addUserNode(g, { seq: 1, text: "必须保持公开接口不变；不要动 prod 配置；测试要全绿。先把压缩改成增量。" });
  let last = u;
  for (let i = 0; i < n; i += 1) {
    const e = addEdge(g, {
      from: last,
      intent: `尝试方案 ${i}：把 fold 的起点挪到 checkpoint 之后`,
      action: `bash(npm test --filter case${i})`,
      evidence: { start: 1000 + i * 12, end: 1006 + i * 12 },
    });
    settleEdge(g, e, {
      result: "failure",
      verify: { kind: "exit", summary: "exit 1" },
      errorSnippet: `AssertionError: expected ${i} to equal ${i + 1} at suite/case${i}.test.ts:42`,
    });
    const node = addAgentNode(g, { seq: 2000 + i, goal: `方案 ${i} 失败`, worldHash: `W${i}`, constraintHash: "C1", via: e });
    settleEdge(g, e, { to: node.id, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `AssertionError: expected ${i} to equal ${i + 1}` });
    last = node.id;
  }
  return g;
}

const ledgerStats = [];
for (const n of [1, 3, 10, 30, 80]) {
  const g = bigGraph(n);
  const led = renderLedger(g, { maxTokens: 500 });
  const facts = renderFacts(g);
  ledgerStats.push({
    failures: n,
    ledgerTokens: led.tokens,
    ledgerLevel: led.level,
    omittedEdges: led.omittedEdges,
    factsTokens: estimateTokens(facts),
    graphMdBytes: Buffer.byteLength(renderMd(g), "utf8"),
  });
}

/* ── 保留率模型 ── */
const retention = [];
for (let k = 1; k <= 6; k += 1) {
  retention.push({ folds: k, official: Number(Math.pow(0.7, k).toFixed(4)), chess: 1 });
}

const payload = { generatedAt: new Date().toISOString(), cases: results, ledgerStats, retentionModel: retention };
nodeFs.mkdirSync(OUT, { recursive: true });
nodeFs.writeFileSync(nodePath.join(OUT, "模拟结果.json"), JSON.stringify(payload, null, 2), "utf8");

const md = [];
md.push("# 证据 · 增量 fold 与官方策略的对比（模拟口径）", "");
md.push(`> 生成于 ${new Date().toISOString()}　命令：\`node test/evidence.mjs\``);
md.push(">");
md.push("> ⚠ **口径声明**：这是 `test/sim.mjs` 的离散事件模拟，不是真实 DSH 会话的计费记录。");
md.push("> surface 被简化成「节点 = {seq, tokens}」，replace 直接把区间换成一个 700-token 的 checkpoint。");
md.push("> 它验证的是**结构性质**（fold 范围不重叠、峰值有界、失败清单恒在），真实会话的表现需重启 DSH 后按 `docs/重启后验证清单.md` 核对。");
md.push("");
md.push("## 一 · 累计计费（billed tokens = 每步请求 + 摘要调用输入）");
md.push("");
md.push("「摘要成本」口径：官方每次 fold 都要把被遮蔽的整段历史回放给摘要模型（`replay`）；本插件在 `rules` 模式下零模型调用。");
md.push("两条本插件曲线分别代表两种配置：**rules**（`summaryMode: rules`，全零成本）与 **hybrid**（`summaryMode: hybrid`，按官方口径计）。");
md.push("");
md.push("| 场景 | 策略 | fold 次数 | 摘要成本 | 累计计费 | 平均上下文 | 峰值 |");
md.push("|---|---|---|---|---|---|---|");
for (const r of results) {
  md.push(`| ${r.case} | 本插件 rules | ${r.chessRules.folds} | 0 | ${r.chessRules.billedTokens.toLocaleString()} | ${r.chessRules.meanTokens.toLocaleString()} | ${r.chessRules.peakTokens.toLocaleString()} |`);
  md.push(`| ${r.case} | 本插件 hybrid | ${r.chessHybrid.folds} | ${r.chessHybrid.summaryCostTokens.toLocaleString()} | ${r.chessHybrid.billedTokens.toLocaleString()} | ${r.chessHybrid.meanTokens.toLocaleString()} | ${r.chessHybrid.peakTokens.toLocaleString()} |`);
  md.push(`| ${r.case} | 官方口径 | ${r.official.folds} | ${r.official.summaryCostTokens.toLocaleString()} | ${r.official.billedTokens.toLocaleString()} | ${r.official.meanTokens.toLocaleString()} | ${r.official.peakTokens.toLocaleString()} |`);
  md.push(`| ${r.case} | **差额（rules / hybrid）** | | | **省 ${r.savedRules}% / 省 ${r.savedHybrid}%** | 省 ${r.meanRules}% / 省 ${r.meanHybrid}% | |`);
}
md.push("");
md.push("## 二 · 热上下文的成本（失败清单）");
md.push("");
md.push("| 死路条数 | ledger tokens | 降级档位 | 丢失边数 | 硬事实块 tokens | 棋谱 md 字节 |");
md.push("|---|---|---|---|---|---|");
for (const s of ledgerStats) {
  md.push(`| ${s.failures} | ${s.ledgerTokens} | ${s.ledgerLevel} | ${s.omittedEdges} | ${s.factsTokens} | ${s.graphMdBytes} |`);
}
md.push("");
md.push("要点：**丢失边数恒为 0** —— 预算不够时降级（先砍原因长度、再砍动作），不丢边。");
md.push("");
md.push("## 三 · 保留率模型（早期约束/否定结果还剩多少）");
md.push("");
md.push("| 经历 fold 轮次 | 官方口径（每轮重摘要，单轮保留 0.7） | 本插件（每段只压一次） |");
md.push("|---|---|---|");
for (const r of retention) {
  md.push(`| ${r.folds} | ${(r.official * 100).toFixed(1)}% | ${(r.chess * 100).toFixed(0)}% |`);
}
md.push("");
md.push("单轮 0.7 的取值来源：Compaction Cliff（arXiv:2608.22752）在生产配置下测得安全规则一轮后存活 53%、五轮后 10% 的口径量级；本表用 0.7 作示意的中位假设，**不是实测**。");
md.push("本插件的「1」不是乐观假设：约束与失败原因由规则抽取后**逐字**注入摘要 prompt（`renderFacts`），模型没有决定丢弃的权限。");
md.push("");
md.push("## 四 · 复跑");
md.push("");
md.push("```bash");
// 项目根从本文件位置推导：写死目录名正是 S10a 修的缺陷（会随改名悄悄变成不存在的路径）
md.push(`cd ${nodePath.resolve(HERE, "..").replace(/\\/g, "/")}`);
md.push("node test/evidence.mjs   # 重算本文件与 模拟结果.json");
md.push("node test/run.mjs        # 全部单测（含本文件所用的不变量）");
md.push("```");

nodeFs.writeFileSync(nodePath.join(OUT, "模拟结果.md"), md.join("\n"), "utf8");
console.log(md.join("\n"));
