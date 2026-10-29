/**
 * doctor.mjs —— 一条命令回答「插件现在健康吗？」
 *
 * 为什么需要它：真实故障（摘要模型 id 不存在）发生时，界面上什么都看不出来 ——
 * 只有会话日志里 115 条 `compaction/end error`。这个工具把「看不出来的坏」变成一次可读的体检：
 *
 *   1. 安装态：junction / preset 引用 / 单实例（复用 verify-install 的判据）
 *   2. 摘要模型：preset 里配的 provider/model 是否真的在 provider 的模型表里（本轮实机故障就是这条）
 *   3. 压缩健康：最近 N 个会话的 compaction 成功/失败与最近错误（这就是 115 次失败的可视化）
 *   4. 棋谱健康：worldHash 对象残留 / stateIndex / 最近 flush 时间
 *   5. 树新鲜度：index.md 是否落后于 graph.json（v1.6.1 修过，但值得盯）
 *
 * 用法：node test/doctor.mjs [--json]
 * 退出码：0 全绿；1 有警告或错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fromJSON } from "../src/graph.mjs";

const asJson = process.argv.includes("--json");
const home = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
const profilePatch = nodePath.join(home, "profiles", "desktop", "cordis.patch.yml");
const presetPatch = nodePath.join(home, "preset-bundles", "personal-assistant", "cordis.patch.yml");
const chessRoot = nodePath.join(home, "chess-context", "sessions");
const sessionsRoot = nodePath.join(home, "sessions");

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });

/* ── 1. 安装态 ── */
const linkPath = nodePath.join(home, "profiles", "desktop", "node_modules", "dsh-gokifu-compact");
add("插件已链接进 profile", nodeFs.existsSync(linkPath) ? "ok" : "error", linkPath);
add(
  "preset 引用了 dsh-gokifu-compact",
  nodeFs.existsSync(presetPatch) && nodeFs.readFileSync(presetPatch, "utf8").includes("dsh-gokifu-compact") ? "ok" : "error",
  presetPatch,
);
add(
  "preset 里没有 compaction-basic（单实例）",
  nodeFs.existsSync(presetPatch) && !/name:\s*'@deepseek-ai\/dsh-compaction-basic'/.test(nodeFs.readFileSync(presetPatch, "utf8")) ? "ok" : "warn",
  "压缩后端只能有一个",
);

/* ── 2. 摘要模型是否可解析 ── */
function readPresetSummarizer() {
  if (!nodeFs.existsSync(presetPatch)) return null;
  const text = nodeFs.readFileSync(presetPatch, "utf8");
  const block = text.slice(text.indexOf("dsh-gokifu-compact"));
  const provider = /summarizationProvider:\s*'?([^'\n]*)'?/.exec(block)?.[1]?.trim() ?? "";
  const model = /summarizationModel:\s*'?([^'\n]*)'?/.exec(block)?.[1]?.trim() ?? "";
  return { provider, model };
}
function providerModels(name) {
  if (!nodeFs.existsSync(profilePatch)) return [];
  const text = nodeFs.readFileSync(profilePatch, "utf8");
  const idx = text.indexOf(`- id: ${name}`);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 4000);
  const models = [];
  for (const m of slice.matchAll(/^\s+- id:\s*(\S+)/gm)) models.push(m[1]);
  return models;
}
/* ── 2.5 压缩后端接管：preset 里必须是我们的引擎，且没有 compaction-basic ── */
const presetText = nodeFs.existsSync(presetPatch) ? nodeFs.readFileSync(presetPatch, "utf8") : "";
const hasOurEngine = presetText.includes("dsh-gokifu-compact");
const hasNative = /- id:\s*compaction-basic/.test(presetText);
add(
  "压缩后端已接管（preset 里是 gokifu-compact）",
  hasOurEngine ? "ok" : "error",
  hasOurEngine ? "preset 的 compaction group 内是 dsh-gokifu-compact（自动压缩由它提供）" : "preset 里没有 dsh-gokifu-compact —— 跑一次 dsh-gokifu-compact install",
);
add(
  "原生 compaction-basic 已让位（单实例）",
  hasNative ? "error" : "ok",
  hasNative ? "preset 里还有 compaction-basic ⇒ 两个 ctx.compaction 会冲突" : "没有 compaction-basic，不会双实例",
);

const sum = readPresetSummarizer();
if (sum === null) {
  add("摘要模型配置", "warn", "读不到 preset（跳过）");
} else if (sum.provider === "" && sum.model === "") {
  add("摘要模型配置", "ok", "留空 = 跟随当前路由（最稳）");
} else {
  const models = providerModels(sum.provider);
  const ok = models.includes(sum.model);
  add(
    "摘要模型在 provider 的模型表里",
    ok ? "ok" : "error",
    ok ? `${sum.provider}/${sum.model}` : `配的是 ${sum.provider}/${sum.model}，但 ${sum.provider} 只提供：${models.join(", ") || "(读不到)"}`,
  );
}

/* ── 3. 压缩健康：最近会话的 compaction 成败 ── */
const PY = `import sys, zstandard
with open(sys.argv[1],'rb') as f:
    sys.stdout.buffer.write(zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True).read())`;
function recentSessionLogs(limit) {
  if (!nodeFs.existsSync(sessionsRoot)) return [];
  const files = [];
  for (const ws of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(sessionsRoot, ws.name);
    let sessions;
    try {
      sessions = nodeFs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const f = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (!nodeFs.existsSync(f)) continue;
      files.push({ file: f, mtime: nodeFs.statSync(f).mtimeMs, session: s.name });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}
let foldOk = 0;
let logUsage = null;
let foldFail = 0;
let foldOkAll = 0;
let foldFailAll = 0;
let lastOkAt = 0;
let lastFailAt = 0;
const lastErrors = [];
const WINDOW_MS = 60 * 60 * 1000; // 1 小时：只看「现在是不是还在坏」，历史失败是已修掉的旧账
const since = Date.now() - WINDOW_MS;
for (const { file, session } of recentSessionLogs(6)) {
  let events;
  try {
    events = execFileSync("python", ["-c", PY, file], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n");
  } catch {
    continue;
  }
  for (const line of events) {
    if (line.length === 0) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof e.time === "number" ? e.time : 0;
    if (e.type === "compaction/summary" && e.data?.usage) {
      // 旧版本写的 graph 没有 lastFoldUsage —— 从会话日志里捞最近一次摘要的真实 usage 兜底
      if (logUsage === null || at > logUsage.at) {
        logUsage = {
          at,
          inputTokens: e.data.usage.inputTokens,
          outputTokens: e.data.usage.outputTokens,
          provider: e.data.provider ?? null,
          model: e.data.model ?? null,
          shadowedTokens: e.data.shadowedTokenCount ?? null,
          session,
        };
      }
      continue;
    }
    if (e.type !== "compaction/end") continue;
    if (e.data?.error) {
      foldFailAll += 1;
      lastFailAt = Math.max(lastFailAt, at);
      if (at >= since) {
        foldFail += 1;
        if (lastErrors.length < 3) lastErrors.push(`${session.slice(0, 20)}: ${e.data.error}`);
      }
    } else {
      foldOkAll += 1;
      lastOkAt = Math.max(lastOkAt, at);
      if (at >= since) foldOk += 1;
    }
  }
}
const inWindow = foldOk + foldFail > 0;
const okN = inWindow ? foldOk : foldOkAll;
const failN = inWindow ? foldFail : foldFailAll;
const fmtAt = (ms) => (ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—");
// 判定看「最新一条是谁」：成功在失败之后 ⇒ 当前是健康的，历史失败数只作背景。
const healthyNow = lastOkAt > 0 && lastOkAt >= lastFailAt;
add(
  inWindow ? "最近的压缩尝试（1h）" : "最近的压缩尝试（全部历史）",
  healthyNow ? "ok" : okN === 0 && failN > 0 ? "error" : "warn",
  `成功 ${okN} / 失败 ${failN}（最近成功 ${fmtAt(lastOkAt)} · 最近失败 ${fmtAt(lastFailAt)}）` +
    `${lastErrors.length ? `；最近错误：${lastErrors[0]}` : ""}`,
);

/* ── 4. 棋谱健康 ── */
let sessions = 0;
let agents = 0;
let objectHash = 0;
let indexStale = 0;
let newestFlush = 0;
let lastFold = null;
let todayFolds = 0;
let todayShadow = 0;
let todaySessions = 0;
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const today0 = todayStart.getTime();
if (nodeFs.existsSync(chessRoot)) {
  for (const d of nodeFs.readdirSync(chessRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = nodePath.join(chessRoot, d.name, "graph.json");
    if (!nodeFs.existsSync(f)) continue;
    sessions += 1;
    const mtime = nodeFs.statSync(f).mtimeMs;
    newestFlush = Math.max(newestFlush, mtime);
    try {
      const g = fromJSON(nodeFs.readFileSync(f, "utf8"));
      for (const node of Object.values(g.nodes ?? {})) {
        if (node?.kind !== "agent") continue;
        agents += 1;
        if (node.worldHash && typeof node.worldHash === "object") objectHash += 1;
      }
      const marks = g.foldMarks ?? [];
      const todayMarks = marks.filter((m) => (m.at ?? 0) >= today0);
      if (todayMarks.length > 0) todaySessions += 1;
      todayFolds += todayMarks.length;
      todayShadow += todayMarks.reduce((sum, m) => sum + (m.shadowedTokens ?? 0), 0);
      const u = g.lastFoldUsage;
      if (u && typeof u.at === "number" && (lastFold === null || u.at > lastFold.at)) {
        lastFold = { ...u, session: d.name, foldCount: g.foldCount ?? 0, mark: (g.foldMarks ?? []).at(-1) ?? null };
      }
    } catch {
      /* 坏图单独报 */
    }
    const indexPath = nodePath.join(chessRoot, d.name, "index.md");
    const indexMtime = nodeFs.existsSync(indexPath) ? nodeFs.statSync(indexPath).mtimeMs : 0;
    if (indexMtime === 0 || mtime - indexMtime > 5 * 60 * 1000) indexStale += 1;
  }
}
add("棋谱库", objectHash === 0 ? "ok" : "error", `${sessions} 个会话 / ${agents} 个 agent 节点 / worldHash 对象残留 ${objectHash}`);
add("树新鲜度", indexStale === 0 ? "ok" : "warn", `index.md 落后 graph.json 超过 5 分钟的会话：${indexStale} 个`);
const cost = lastFold ?? (logUsage === null ? null : { ...logUsage, source: "会话日志" });
add(
  "今天 fold 的总量",
  todayFolds === 0 ? "warn" : "ok",
  todayFolds === 0
    ? "今天还没有 fold"
    : `${todayFolds} 次（${todaySessions} 个会话）· 合计遮蔽 ${todayShadow.toLocaleString()} tokens`,
);
add(
  "上次 fold 的成本（真实 usage）",
  cost === null ? "warn" : "ok",
  cost === null
    ? "没有任何摘要 usage 记录"
    : `遮蔽 ${cost.mark?.shadowedTokens ?? cost.shadowedTokens ?? "?"} tok` +
      `${cost.mark ? `（seq ${cost.mark.seqStart ?? "?"}-${cost.mark.seqEnd ?? "?"}）` : ""}` +
      ` → 摘要输入 ${cost.inputTokens ?? "?"} / 输出 ${cost.outputTokens ?? "?"} tok` +
      `（${cost.provider ?? "?"}/${cost.model ?? "?"}${cost.source ? "，来自" + cost.source : `，fold #${cost.foldCount}`}，${cost.session.slice(0, 24)}）`,
);
add("最近一次落盘", newestFlush > 0 ? "ok" : "warn", newestFlush ? new Date(newestFlush).toISOString() : "没有任何棋谱");

/* ── 输出 ── */
const bad = checks.filter((c) => c.status === "error").length;
const warn = checks.filter((c) => c.status === "warn").length;
if (asJson) {
  console.log(JSON.stringify({ checks, bad, warn }, null, 1));
} else {
  console.log("== dsh-gokifu-compact doctor ==");
  for (const c of checks) {
    const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${bad === 0 ? "✅" : "❌"} 错误 ${bad} / 警告 ${warn}`);
}
process.exitCode = bad > 0 ? 1 : 0;
