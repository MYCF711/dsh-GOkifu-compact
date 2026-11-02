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
 * 用法：node scripts/doctor.mjs [--json]   （装好的包里是 npx dsh-gokifu-compact doctor）
 * 退出码：0 全绿；1 有警告或错误。
 */

import nodeFs from "node:fs";
import { nodeDocStats } from "../src/rooms/node-docs.mjs";
import { auditGraph, auditRawIndex, loadSessionGraph } from "./graph-audit.mjs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GRAPH_VERSION, fromJSON, countResolvedFailures, isTruncatedFinish } from "../src/rooms/kifu-model.mjs";
import { measureLedgerTimings } from "../src/rooms/ledger.mjs";
import { inspectProfileInstall } from "./link-path.mjs";
import { selectSessionLogs } from "./log-window.mjs";
import { accumulateCacheUsage, createCacheUsage, summarizeCacheUsage } from "./cache-usage.mjs";
// ★ W5/W-B（2026-11-01）：preset 发现复用 install.mjs 的两代兼容实现（与 UI 半的 findPresetFiles 同构），
//   不再写死「旧 home 的某个固定 preset 目录/名字」—— 新版 DSH 没有 preset-bundles，旧 home 才走它。
//   选 `./install.mjs` 而不是 `../src/ui.mjs`：doctor 是 CLI 侧脚本，install.mjs 就在同目录、
//   模块级零副作用；ui.mjs 是**宿主半**（webServer 路由 + DEFAULTS），CLI 不该为一段发现逻辑拉它进来。
import { presetsWithCompaction } from "./install.mjs";
import { findShadowedUserPresets } from "../src/rooms/preset-format.mjs";
import { planHomePatch } from "../src/rooms/user-patch.mjs";
import { compareBuildId, compareBuildStamp, readBuildStamp, repoBuildId, repoVersion } from "../src/rooms/build-stamp.mjs";
import { foldCostMetrics } from "../src/rooms/fold-quality.mjs";

const asJson = process.argv.includes("--json");
const home = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
const profilePatch = nodePath.join(home, "profiles", "desktop", "cordis.patch.yml");
/* ★ W5：preset 两代兼容发现（新版：profiles/desktop/package.json 的 dsh.profile.bundles 声明的
   bundle 包；旧版：<home>/preset-bundles/<dir>/cordis.patch.yml）。
   语义：两代都没有 ⇒ warn「合法中间态」；有 preset 但没挂 gokifu 引擎行 ⇒ error。 */
const presets = presetsWithCompaction(home, "desktop");
/** 优先体检「已经挂了引擎行」的那个 preset；没有就取第一个（用于报「有 preset 但没挂」）。 */
const preset = presets.find((p) => p.text.includes("dsh-gokifu-compact")) ?? presets[0] ?? null;
const chessRoot = nodePath.join(home, "chess-context", "sessions");
const sessionsRoot = nodePath.join(home, "sessions");

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });

/* ── 1. 安装态 ──
   以前这里只 `existsSync(node_modules/<pkg>)`：junction 在就报 ok，而依赖声明可能指向
   一个**不存在的目录**（重装即坏）。判据与 verify-install 共用 scripts/link-path.mjs。 */
const installState = inspectProfileInstall({ dshHome: home, profile: "desktop", pkgName: "dsh-gokifu-compact" });
const installOk = Object.values(installState.checks).every(Boolean);
add(
  "插件已链接进 profile",
  installOk ? "ok" : "error",
  installOk ? `${installState.declared} → ${installState.linked.realPath}` : installState.failure ?? installState.linkedPath,
);
const presetText = preset?.text ?? "";
const hasOurName = presetText.includes("dsh-gokifu-compact");
const hasNativeByName = /name:\s*'@deepseek-ai\/dsh-compaction-basic'/.test(presetText);
add(
  "preset 引用了 dsh-gokifu-compact",
  preset === null ? "warn" : hasOurName ? "ok" : "error",
  preset === null
    ? "未发现含 compaction 的 preset（两代都查过：新版看 profile 的 dsh.profile.bundles、旧版看 preset-bundles；新版 home 需自建 preset bundle，这是合法中间态，不是错误）"
    : hasOurName
      ? preset.file
      : `${preset.file} 里没有 dsh-gokifu-compact —— 跑一次 dsh-gokifu-compact install`,
);
add(
  "preset 里没有 compaction-basic（单实例）",
  preset === null ? "warn" : hasNativeByName ? "warn" : "ok",
  preset === null ? "未发现 preset（没有可让位的原生行）" : "压缩后端只能有一个",
);

/* ── 2. 摘要模型是否可解析 ── */
function readPresetSummarizer() {
  if (preset === null) return null;
  const text = preset.text;
  const at = text.indexOf("dsh-gokifu-compact");
  if (at < 0) return null; // 有 preset 但这版还没挂引擎行：没有摘要模型可核
  const block = text.slice(at);
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
const hasOurEngine = hasOurName;
const hasNative = /- id:\s*compaction-basic/.test(presetText);
add(
  "压缩后端已接管（preset 里是 gokifu-compact）",
  preset === null ? "warn" : hasOurEngine ? "ok" : "error",
  preset === null
    ? "未发现 preset（新版看 profile 的 dsh.profile.bundles、旧版看 preset-bundles，两代都没有）—— 新版 home 需先自建 preset bundle，再跑一次 install（合法中间态，不是错误）"
    : hasOurEngine
      ? "preset 的 compaction group 内是 dsh-gokifu-compact（自动压缩由它提供）"
      : `preset（${preset.file}）里没有 dsh-gokifu-compact —— 跑一次 dsh-gokifu-compact install`,
);
/* ── 1.5 用户层 patch 是否遮蔽引擎 / 机器级层是否已登记（2026-11-02 实机事故）
   用户层 `profiles/<p>/cordis.patch.yml` 是**最后应用**的一层：GUI 的 preset 快照会把
   `@deepseek-ai/dsh-compaction-basic` 写回去。插件 1.17.1 起会在**进程退出时**自动把该行
   复制到机器级 `$DSH_HOME/cordis.patch.yml`（宿主最后应用），下次启动接管 —— 用户不需要命令。
   判定：遮蔽 + 机器级层已有引擎 ⇒ ok（等下次启动）；遮蔽 + 没有 ⇒ warn（自动登记待生效）。 */
{
  let shadowed = [];
  let homeHasEngine = false;
  try {
    const profileText = nodeFs.existsSync(profilePatch) ? nodeFs.readFileSync(profilePatch, "utf8") : "";
    shadowed = findShadowedUserPresets(profileText);
    const homePatch = nodePath.join(home, "cordis.patch.yml");
    homeHasEngine = nodeFs.existsSync(homePatch) && nodeFs.readFileSync(homePatch, "utf8").includes("dsh-gokifu-compact/engine");
  } catch {
    /* 读不出按未采集处理 */
  }
  add(
    "用户层 patch 不遮蔽压缩引擎",
    shadowed.length === 0 || homeHasEngine ? "ok" : "warn",
    shadowed.length === 0
      ? "用户层 patch 没有把 preset 写回 compaction-basic"
      : homeHasEngine
        ? `${shadowed.join(", ")} 已被机器级层接管（home/cordis.patch.yml 有 engine 覆盖）—— 重启后生效`
        : `${shadowed.join(", ")} 在用户层写回了 @deepseek-ai/dsh-compaction-basic；插件会在退出时自动登记到机器级层，**下次启动生效**（无需命令）。急用可跑 home/.gokifu-fix-2026-11-02/apply-fix.cmd`,
  );
}

/* ── 1.6 机器级层是否与用户层一致（漂移检测）
   home 层是用户层 preset 行的**副本**（只换 compaction 成员）。用户改了 persona 但还没退出时，
   home 层还是旧的 —— 下次启动会先看到旧 persona，直到退出时自愈才刷新。
   这里只做观测：不一致 ⇒ 提示「退出时自动刷新」，不判 error（自动机制会收敛）。 */
{
  let drift = false;
  let checked = false;
  try {
    const profileText = nodeFs.existsSync(profilePatch) ? nodeFs.readFileSync(profilePatch, "utf8") : "";
    const homePatch = nodePath.join(home, "cordis.patch.yml");
    if (nodeFs.existsSync(homePatch) && findShadowedUserPresets(profileText).length > 0) {
      checked = true;
      drift = planHomePatch(profileText, nodeFs.readFileSync(homePatch, "utf8")).needed;
    }
  } catch {
    /* 读不出按未采集处理 */
  }
  add(
    "机器级层与用户层一致（未漂移）",
    !drift ? "ok" : "warn",
    checked === false
      ? "没有需要复核的机器级层登记（用户层未遮蔽）"
      : drift
        ? "home 层副本比用户层旧（persona/配置已改）—— 插件退出时会自动刷新，下次启动生效"
        : "home 层与用户层一致（只差 compaction 成员）",
  );
}

/* ── 1.7 运行实例版本（C34）：磁盘更新了但进程还是旧代码时，必须一眼看出来 ── */
{
  const stamp = readBuildStamp(nodePath.join(home, "chess-context"));
  const cmp = compareBuildStamp(stamp, repoVersion());
  // ★ C53：semver 长期不变（1.17.1），只比版本号会把「运行实例是几小时前的代码」判成一致 ——
  //   构建标识（src 内容哈希）才能看出落后。
  const diskBuild = repoBuildId();
  const buildCmp = compareBuildId(stamp, diskBuild);
  const started = Number.isFinite(cmp.startedAt) ? new Date(cmp.startedAt).toISOString().slice(11, 19) + "Z" : "?";
  const buildNote = `build ${buildCmp.running ?? "?"} vs 磁盘 ${diskBuild}`;
  add(
    "运行实例版本（build.json）",
    cmp.state === "ok" && buildCmp.state === "ok" ? "ok" : "warn",
    cmp.state === "missing"
      ? `未采集（还没有 build.json —— 旧版本或还没重启过；磁盘代码 v${cmp.disk} · build ${diskBuild}）`
      : buildCmp.state === "stale" || cmp.state === "stale"
        ? `运行实例 v${cmp.running} / **${buildNote}** —— 磁盘代码已变（新字段/新检查此时还不会出现），**重启 DSH 后才生效**`
        : `运行实例 v${cmp.running}（启动于 ${started}，${buildNote}）与磁盘代码一致`,
  );
}

add(
  "原生 compaction-basic 已让位（单实例）",
  preset === null ? "warn" : hasNative ? "error" : "ok",
  preset === null ? "未发现 preset（没有原生的 compaction-basic 可让位）" : hasNative ? "preset 里还有 compaction-basic ⇒ 两个 ctx.compaction 会冲突" : "没有 compaction-basic，不会双实例",
);

const sum = readPresetSummarizer();
if (sum === null) {
  add("摘要模型配置", "warn", preset === null ? "未发现 preset（跳过 —— 两代都查过：profile 的 dsh.profile.bundles / preset-bundles）" : "preset 里没有 gokifu 引擎行（跳过 —— 先跑 install）");
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
function listSessionLogs() {
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
  return files;
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
// ★ C218：按**时间窗**选日志，而不是「最新 6 份」——旧写法会漏掉真实折叠（C-18 事故：
//   01:12 那次 fold 落在第 7 份日志里，doctor 报「成功 0 / 失败 0」）。上限 24 份，解压成本可控。
const cacheUsage = createCacheUsage();
for (const { file, session } of selectSessionLogs(listSessionLogs(), { windowMs: WINDOW_MS, head: 6, limit: 24 })) {
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
    // ★ C220：同一趟解压顺手把每次调用的缓存命中捞出来（assistant/message 带 usage）
    if (e.type === "assistant/message" && e.data?.usage) accumulateCacheUsage(cacheUsage, e.data.usage);
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
        if (lastErrors.length < 3) {
          // ★ C212：类身份不一致这类错误，光看原文没法处置 —— 附一句「该做什么」。
          const hint = /Receiver must be an instance of class/i.test(String(e.data.error))
            ? "（插件被装载了两份/类身份不一致 ⇒ 重启 DSH，并确认同名插件只有一条）"
            : "";
          lastErrors.push(`${session.slice(0, 20)}: ${e.data.error}${hint}`);
        }
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
/** ★ P2-2（task-192）：跨会话收集 foldMarks（带 session 名），供「最近 5 次 fold」展示。 */
const recentFoldMarks = [];
  const foldGrowth = [];
/** ★ 2026-11-01：出现「压缩无效」的会话数 / 最深连续次数。 */
let thrashGraphs = 0;
let maxThrash = 0;
/** ★ C216：归档收尾观测 —— 归档时插件有没有补最后一段（closeout + archive foldMark）。 */
const closeouts = [];
const missingCloseout = [];
let archivedWithGraph = 0;
/** 宿主 registry 里的归档集合（workspace 域 global 记录）。读不到就当没有 —— 只是观测。 */
const archivedIds = (() => {
  try {
    const f = nodePath.join(home, "storages", "workspace.json");
    const raw = JSON.parse(nodeFs.readFileSync(f, "utf8"));
    const ids = raw?.global?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
})();
let todayFolds = 0;
let todayShadow = 0;
let todaySessions = 0;
// ★ 2026-10-29：图结构健康度（自环 = 图坍缩；它会让 dead/redundant 标记全错）
let graphEdges = 0;
let graphNodes = 0;
let selfLoops = 0;
let collapsedGraphs = 0;
// ★ C33：置换合并的可审计性（有 superseded 记录的节点 / 记录总数 / 自相矛盾数）
let mergeNodes = 0;
let mergeOps = 0;
let mergeBad = 0;
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
      // ★ C183：聚合统计同样要重放 delta（否则节点/边数系统性偏低，自环率也会被扭曲）
      const g = loadSessionGraph(f).graph;
      {
        const es = Object.values(g.edges ?? {});
        const ns = Object.keys(g.nodes ?? {}).length;
        let sl = 0;
        for (const e of es) if (e.from && e.to && e.from === e.to) sl += 1;
        graphEdges += es.length;
        graphNodes += ns;
        selfLoops += sl;
        if (es.length > 0 && sl / es.length >= 0.05) collapsedGraphs += 1;
      }
      for (const node of Object.values(g.nodes ?? {})) {
        if (node?.kind !== "agent") continue;
        agents += 1;
        if (node.worldHash && typeof node.worldHash === "object") objectHash += 1;
        if (Array.isArray(node.superseded) && node.superseded.length > 0) {
          mergeNodes += 1;
          mergeOps += Number(node.supersededCount ?? node.superseded.length);
          for (const rec of node.superseded) {
            // 记录必须指向「已被吞掉」的节点（仍在 nodes 里 = 自相矛盾），且带 seq
            if (!rec || typeof rec.id !== "string" || g.nodes[rec.id] !== undefined) mergeBad += 1;
            else if (rec.seq !== null && typeof rec.seq !== "number") mergeBad += 1;
          }
        }
      }
      const marks = g.foldMarks ?? [];
      for (const mark of marks) recentFoldMarks.push({ ...mark, session: d.name });
      // ★ C216：归档收尾 —— closeout 是「归档那一刻」的记账，archive foldMark 是「真的补折了」。
      //   两者缺一都说明「归档了但 kifu 最后一段没压过」，而这条以前完全看不见。
      {
        const bareId = d.name.startsWith("session-") ? d.name : `session-${d.name}`;
        const archived = archivedIds.has(d.name) || archivedIds.has(bareId);
        const archiveFold = marks.filter((m) => m.trigger === "archive").at(-1);
        if (archived && g.closeout === undefined) {
          archivedWithGraph += 1;
          missingCloseout.push(d.name);
        }
        if (g.closeout !== undefined || archiveFold !== undefined) {
          closeouts.push({ session: d.name, closeout: g.closeout, archiveFold, archived });
        }
      }
      // ★ C196：fold 新鲜度 —— 距上次 fold 之后又长了多少事件。只展示不判断（阈值 doctor 看不到）。
      if (marks.length > 0) {
        const last = marks.filter((m) => Number.isFinite(m.seqEnd)).at(-1);
        let maxSeq = 0;
        for (const node of Object.values(g.nodes ?? {})) {
          const seq = Number(node?.seq);
          if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
        }
        if (last !== undefined && maxSeq > 0) {
          foldGrowth.push({ session: d.name, growth: Math.max(0, maxSeq - Number(last.seqEnd)), at: last.at ?? 0, folds: marks.length });
        }
      }
      // ★ 2026-11-01（调研候选 #1）：压缩无效（thrashing）—— 连续两次 fold 间隔 < 30 事件的会话数。
      if (typeof g.foldThrash === "number" && g.foldThrash >= 2) {
        thrashGraphs += 1;
        maxThrash = Math.max(maxThrash, g.foldThrash);
      }
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
    // ★ C180（C146 同族）：**活跃会话里 index.md 落后是常态** —— graph.json 每 ~1.2s 追加一帧，
    //   index.md 只在 tree 落盘（fold）时重写。只看「index 比 graph 旧 5 分钟」会把**所有**
    //   正在跑、还没 fold 的会话都算成陈旧（本轮 live 立刻出现 1 个）。
    //   判据改成：**图自己也不再更新**（静止 > 5 分钟）却仍比 index 新 5 分钟 ⇒ 才是真陈旧。
    const graphIdle = Date.now() - mtime > 5 * 60 * 1000;
    if (indexMtime === 0 ? graphIdle : graphIdle && mtime - indexMtime > 5 * 60 * 1000) indexStale += 1;
  }
}
/* ── 3.3d 新观测字段覆盖（C193）──
   这五个字段是「压缩是否被真正观测到」的指标；缺哪个就说明对应路径**还没有真机样本**
   （不是错误，但必须让人看见「我们现在到底看得到什么」）。 */
{
  const budgetFile = nodePath.join(home, "chess-context", "ledger-budget.json");
  let keys = [];
  if (nodeFs.existsSync(budgetFile)) {
    try {
      keys = Object.keys(JSON.parse(nodeFs.readFileSync(budgetFile, "utf8")));
    } catch {
      keys = [];
    }
  }
  const wanted = ["renderErrors", "skipReasons", "budgetFloorOver", "budgetIrreducible", "overBySession"];
  const present = wanted.filter((k) => keys.includes(k));
  const missing = wanted.filter((k) => !keys.includes(k));
  add(
    "观测字段覆盖（C193）",
    // 只有「一个都没有」才 warn（说明新代码还没跑过任何 fold）；部分落盘是正常进度
    present.length > 0 ? "ok" : "warn",
    present.length === wanted.length
      ? `全部 ${wanted.length} 个字段已落盘（${present.join(", ")}）`
      : `已落盘 ${present.length}/${wanted.length}${present.length > 0 ? `（${present.join(", ")}）` : ""}；缺：${missing.join(", ")} —— 缺的字段等对应路径（fold / 超预算 / 渲染失败）出现真机样本`,
  );
}

add("棋谱库", objectHash === 0 ? "ok" : "error", `${sessions} 个会话 / ${agents} 个 agent 节点 / worldHash 对象残留 ${objectHash}`);
add("树新鲜度", indexStale === 0 ? "ok" : "warn", `index.md 落后 graph.json 超过 5 分钟的会话：${indexStale} 个`);

// ★ C230：抗干扰度的累加器（3.3c 里逐会话累加，报告在该块之后）
const interference = { total: 0, resolved: 0, worst: [] };

/* ── 3.3c 棋谱结构自洽（C140）──
   结构坏掉的图会安静地留在磁盘上（validate 只在写盘时告警一行）。这里逐会话体检：
   悬空边 / 悬空 stateIndex / order 漂移 / foldMark 闭包越界。发现即 error（数据损坏）。 */
{
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const bad = [];
  const legacy = [];
  const badTail = [];
  const legacyFoldMarks = [];
  let scanned = 0;
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const graphFile = nodePath.join(sessionsRoot, entry.name, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      let loaded;
      try {
        loaded = loadSessionGraph(graphFile);
      } catch (error) {
        // ★ C145/C148：把「旧版本图」和「真的损坏」分开 ——
        //   但**判据必须是文件里的 version 值**，不能靠错误文案：
        //   `{}`（缺 version）也会抛 "unsupported version"，那是坏图，不是旧版本。
        let version;
        try {
          version = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"))?.version;
        } catch {
          version = undefined;
        }
        const message = String(error?.message ?? error);
        if (typeof version === "number" && version !== GRAPH_VERSION) {
          legacy.push(`${entry.name.slice(0, 16)}: v${version}（当前 v${GRAPH_VERSION}）`);
        } else {
          bad.push(`${entry.name.slice(0, 16)}: ${message.slice(0, 60)}`);
        }
        continue;
      }
      scanned += 1;
      // ★ C230：失败边里「后来同一 action 跑通过」的占比（与热清单的 ↑later-ok 同口径）
      {
        const seqEnd = (e) => (typeof e?.evidence === "number" ? e.evidence : Number.isFinite(e?.evidence?.end) ? e.evidence.end : NaN);
        const all = Object.values(loaded.graph?.edges ?? {});
        const fails = all.filter((e) => e?.result === "failure" && typeof e.action === "string" && e.action !== "");
        // ★ C300：**不在这里重写一遍** —— 用 `rooms/kifu-model.mjs` 的那份，
        //   面板卡片与这里的口径必须永远一致（这一族 bug 已经出过三次）。
        const resolved = countResolvedFailures(loaded.graph);
        interference.total += fails.length;
        interference.resolved += resolved;
        if (fails.length >= 5 && resolved / fails.length > 0.5) {
          interference.worst.push(`${entry.name.slice(0, 16)}(${resolved}/${fails.length})`);
        }
      }
      // ★ C142（审查 P1-3）：悬空 stateIndex 只能在**原始 JSON** 上查（fromJSON 会重建）
      // ★ C143（审查 P1-4）：结构检查也必须在**重放 delta 之后**的图上做
      const problems = [...auditRawIndex(loaded.raw), ...auditGraph(loaded.graph)];
      // ★ C148（复审 P1-3）：delta 回放失败 ⇒ 体检看到的是**部分回放**的图，必须报出来
      if (loaded.deltaError) problems.push(`delta 帧无法回放（图可能停在部分回放）：${loaded.deltaError}`);
      if (loaded.badTail) badTail.push(`${entry.name.slice(0, 16)}: delta 尾部残帧（写入中断）`);
      // ★ C187：`foldMarks[i] seqStart>seqEnd` 是**旧版本**（<C187）tier-2 合并写下的历史记录 ——
      //   surface 顺序不保证按 seq 递增，旧代码直接取 cps[0]/cps[1] 得到反向区间。
      //   新代码（C187 起）按 seq 排序后取最老两条，不会再产生。这类记录**不在新数据里出现**，
      //   因此降为 warn（`graph-audit --repair-foldmarks` 可清理，原值保留在 legacyRange）。
      const legacyRangeProblems = problems.filter((x) => /^foldMarks\[\d+\] seqStart>seqEnd$/.test(x));
      const realProblems = problems.filter((x) => !legacyRangeProblems.includes(x));
      if (legacyRangeProblems.length > 0) legacyFoldMarks.push(`${entry.name.slice(0, 16)}: ${legacyRangeProblems[0]}`);
      if (realProblems.length > 0) bad.push(`${entry.name.slice(0, 16)}: ${realProblems[0]}`);
    }
  }
  add(
    "棋谱结构自洽（C140）",
    bad.length > 0 ? "error" : legacy.length > 0 || badTail.length > 0 || legacyFoldMarks.length > 0 ? "warn" : "ok",
    scanned === 0
      ? legacy.length > 0 || badTail.length > 0
        ? `0 个可读会话（${legacy.length} 个旧版本 + ${badTail.length} 个残帧会话；不是「没有图」）：${[...legacy, ...badTail].slice(0, 3).join(" / ")}`
        : "未采集（没有会话图）"
      : bad.length > 0
        ? `${bad.length}/${scanned} 个会话不自洽：${bad.slice(0, 3).join(" / ")}`
        : legacy.length > 0
          ? `${scanned} 个会话自洽；${legacy.length} 个**旧版本图**（引擎读到会重建空图 ⇒ 升级/降级前请先停窗备份）：${legacy.slice(0, 3).join(" / ")}`
          : legacyFoldMarks.length > 0
            ? `${scanned} 个会话自洽；${legacyFoldMarks.length} 个含**旧版本反向 foldMark**（C187 前的 tier-2，新版本不再产生；\`graph-audit --repair-foldmarks\` 可清理，但**必须先退出 DSH** —— 运行实例手里有内存态，重启后会把它写回来）：${legacyFoldMarks.slice(0, 2).join(" / ")}`
            : `${scanned} 个会话全部自洽（悬空边 / 索引 / order / 闭包）`,
  );
}


{
  const { total, resolved } = interference;
  const share = total > 0 ? resolved / total : 0;
  if (total === 0) {
    add("热清单抗干扰（已修正失败占比）", "warn", "未采集（本轮没有扫到任何失败边）");
  } else {
    const pct = Math.round(share * 100);
    add(
      "热清单抗干扰（已修正失败占比）",
      share > 0.5 ? "warn" : "ok",
      `${resolved}/${total} 条失败边背后的命令**后来跑通过**（${pct}%）—— 这些行仍会出现在 LEARNED 里（契约要求不丢失败记忆），但它们的判别价值最低` +
        (interference.worst.length > 0 ? `；占比 ≥50% 的会话：${interference.worst.slice(0, 3).join(" / ")}` : ""),
    );
  }
}

/* ── 3.3b 节点文档与棋谱一致（C110）──
   热清单省略行会写「见 nodes/<id>.md」。文件缺失 = 空指针（模型会去读，然后 ENOENT）；
   文件比节点多 = 陈旧工件（不影响引用，只计数）。 */
{
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  let scanned = 0;
  let missingAll = 0;
  let inFlightAll = 0;
  let orphanAll = 0;
  const skippedDocs = [];
  const deltaIssues = [];
  const worst = [];
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = nodePath.join(sessionsRoot, entry.name);
      const graphFile = nodePath.join(dir, "graph.json");
      if (!nodeFs.existsSync(graphFile)) continue;
      let loaded;
      try {
        // ★ C143（审查 P1-2）：必须重放 delta —— 运行时 load 会重放；只读基线会把
        //   「只在 delta 里、其实还活着」的节点当成不存在（误报陈旧）或漏报真实缺失（假绿）。
        loaded = loadSessionGraph(graphFile);
      } catch (error) {
        // ★ C148（复审 P1-1）：**不许静默跳过** —— 否则旧版本/坏图会话完全不进这条检查，
        //   而 detail 还写「齐全」，等于永久假绿。
        skippedDocs.push(`${entry.name.slice(0, 16)}: ${String(error?.message ?? error).slice(0, 40)}`);
        continue;
      }
      const graph = loaded.graph;
      if (loaded.deltaError) deltaIssues.push(`${entry.name.slice(0, 16)}: ${loaded.deltaError.slice(0, 60)}`);
      else if (loaded.badTail) deltaIssues.push(`${entry.name.slice(0, 16)}: delta 尾部残帧`);
      scanned += 1;
      const nodesDir = nodePath.join(dir, "nodes");
      const files = nodeFs.existsSync(nodesDir) ? nodeFs.readdirSync(nodesDir) : [];
      const stats = nodeDocStats({ graphNodes: Object.keys(graph.nodes ?? {}), files });
      // ★ C146（C143 的真实副作用）：delta 重放后能看到「刚建、md 还没写出」的节点 ——
      //   nodes/*.md 是**节流写出**的（pending 攒到下一次落盘才写），活跃会话里这会持续出现。
      //   所以：图在最近 2 分钟内更新过（会话仍在跑）⇒ 记为**在途**，不报警；
      //   只有「图已静止」却仍缺文档，才是真正的空指针风险。
      // ★ C148（复审 P2-4）：在途只对**刚创建**的节点成立（按节点自己的 ts）——
      //   只看 graph.updatedAt 会让「一直活跃的会话里永久缺失的 md」永远算在途、永不报警。
      const now = Date.now();
      for (const id of stats.missing) {
        const node = graph.nodes?.[id];
        const created = Number(node?.ts) || 0;
        const inFlight = now - (Number(graph.updatedAt) || 0) < 120_000 && now - created < 120_000;
        if (inFlight) inFlightAll += 1;
        else {
          missingAll += 1;
          if (worst.length < 3) worst.push(`${entry.name.slice(0, 16)}:${id}`);
        }
      }
      orphanAll += stats.orphan.length;
    }
  }
  const notes = [];
  if (inFlightAll > 0) notes.push(`${inFlightAll} 个在途（刚创建，md 按落盘节流延迟写出）`);
  if (orphanAll > 0) notes.push(`${orphanAll} 个陈旧 md（节点已不在图里，仅计数）`);
  if (deltaIssues.length > 0) notes.push(`${deltaIssues.length} 个会话的 delta 无法完整回放：${deltaIssues.slice(0, 2).join(" / ")}`);
  if (skippedDocs.length > 0) notes.push(`${skippedDocs.length} 个会话被跳过（旧版本/坏图，无法体检）：${skippedDocs.slice(0, 2).join(" / ")}`);

  const verdict = missingAll > 0
    ? { level: "warn", detail: `${missingAll} 个节点缺 nodes/<id>.md（热清单省略行会指向它们 ⇒ 空指针）：${worst.join(" / ")}${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}` }
    : {
        level: skippedDocs.length > 0 || deltaIssues.length > 0 ? "warn" : "ok",
        detail:
          scanned === 0
            ? `0 个可读会话${skippedDocs.length > 0 ? `（${skippedDocs.length} 个被跳过：${skippedDocs.slice(0, 3).join(" / ")}，不是「没有图」）` : "（没有会话图）"}`
            : `${scanned} 个会话的节点文档齐全${notes.length > 0 ? `（${notes.join(" · ")}）` : ""}`,
      };
  add("节点文档与棋谱一致（C110）", verdict.level, verdict.detail);
}

/* ── 3.4 第三方 preset 的压缩后端（C94）──
   我们的 patch 只覆盖**四个官方 preset**。第三方插件若自带 preset（例如 dsh-design-studio 的
   `preset-design`「设计模式」），它可能在自己的 bundle patch 里重新声明 compaction-basic ⇒
   那个模式下**不经过棋谱压缩**。这不是我们该强行覆盖的东西（越权 + 会被对方升级覆盖），
   但用户看到「同一个插件，有的模式记忆行为不一样」时必须能查到原因。 */
{
  const profileDir = nodePath.join(home, "profiles", "desktop");
  const pkgFile = nodePath.join(profileDir, "package.json");
  const foreign = [];
  let scanned = 0;
  if (nodeFs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      for (const name of bundles) {
        if (name.includes("gokifu")) continue; // 自己的 patch 不参与
        const patch = nodePath.join(profileDir, "node_modules", name, "cordis.patch.yml");
        if (!nodeFs.existsSync(patch)) continue;
        scanned += 1;
        const text = nodeFs.readFileSync(patch, "utf8");
        // 逐个 preset 块看：块内是否出现 `- id: compaction-basic`
        // ★ preset 行可能缩进（第三方 patch 常放在 insert: 块里），所以允许前导空白
        const ids = [...text.matchAll(/^\s*- id:\s*(preset-[a-z0-9-]+)\s*$/gm)].map((m) => ({ id: m[1], at: m.index }));
        for (let i = 0; i < ids.length; i += 1) {
          const end = i + 1 < ids.length ? ids[i + 1].at : text.length;
          if (/- id:\s*compaction-basic/.test(text.slice(ids[i].at, end))) foreign.push(`${name}:${ids[i].id}`);
        }
      }
    } catch {
      /* 读不出 profile 清单不影响其它检查 */
    }
  }
  if (scanned === 0) {
    add("第三方 preset 的压缩后端（C94）", "ok", "未采集（profile 里没有其它带 bundle patch 的插件）");
  } else if (foreign.length > 0) {
    add(
      "第三方 preset 的压缩后端（C94）",
      "warn",
      `${foreign.length} 个第三方 preset 仍用 compaction-basic：${foreign.join(" · ")} —— 那些模式下不经过棋谱压缩（不强行覆盖，属设计边界）`,
    );
  } else {
    add("第三方 preset 的压缩后端（C94）", "ok", `扫了 ${scanned} 个第三方 bundle patch，没有 preset 自带压缩后端`);
  }
}

/* ── 3.4b insert id 唯一性（C96）──
   bundle patch 的 `insert` 行靠 id 建索引：两个插件插同一个 id，后写的会**替换**先写的 ——
   被替掉的那个插件等于静默禁用。若撞的是我们的 `gokifu-ui`，设置页/`/gokifu/api` 会消失。 */
{
  const profileDir = nodePath.join(home, "profiles", "desktop");
  const pkgFile = nodePath.join(profileDir, "package.json");
  const owners = new Map();
  let scanned = 0;
  if (nodeFs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      for (const name of bundles) {
        const patch = nodePath.join(profileDir, "node_modules", name, "cordis.patch.yml");
        if (!nodeFs.existsSync(patch)) continue;
        scanned += 1;
        const text = nodeFs.readFileSync(patch, "utf8");
        // insert 块的子行固定 4 空格缩进（宿主 patch 语法），这里只认这一层
        for (const m of text.matchAll(/^    - id:\s*([a-z0-9-]+)\s*$/gm)) {
          const id = m[1];
          if (!owners.has(id)) owners.set(id, []);
          if (!owners.get(id).includes(name)) owners.get(id).push(name);
        }
      }
    } catch {
      /* 读不出清单不影响其它检查 */
    }
  }
  const conflicts = [...owners.entries()].filter(([, list]) => list.length > 1);
  const ours = conflicts.filter(([id]) => id === "gokifu-ui");
  if (scanned === 0) {
    add("insert id 唯一性（C96）", "ok", "未采集（profile 里没有 bundle patch）");
  } else if (ours.length > 0) {
    add(
      "insert id 唯一性（C96）",
      "error",
      `**本插件的 gokifu-ui 行被别的 bundle 撞了**：${ours.map(([id, list]) => `${id}←${list.join("+")}`).join(" · ")} —— 设置页/\`/gokifu/api\` 可能消失`,
    );
  } else if (conflicts.length > 0) {
    add(
      "insert id 唯一性（C96）",
      "warn",
      `${conflicts.length} 个 insert id 被多个 bundle 使用：${conflicts.map(([id, list]) => `${id}←${list.join("+")}`).join(" · ")} —— 后写者会替换先写者（被替掉的插件等于静默禁用）`,
    );
  } else {
    add("insert id 唯一性（C96）", "ok", `${owners.size} 个 insert id 各只有一个 owner（扫了 ${scanned} 个 bundle patch）`);
  }
}

/* ── 3.45 preset 覆盖唯一性（C95）──
   多个 bundle 若覆盖**同一个 preset id**，后写的那份会整体接管 config ——
   若别人的覆盖里又带回调 compression-basic，我们的引擎就被**静默顶掉**了。
   live 目前每个 preset 只有一个 owner；这条检查是为了将来出现第二个 owner 时能立刻看见。 */
{
  const profileDir = nodePath.join(home, "profiles", "desktop");
  const pkgFile = nodePath.join(profileDir, "package.json");
  const owners = new Map();
  let scanned = 0;
  if (nodeFs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(pkgFile, "utf8"));
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      for (const name of bundles) {
        const patch = nodePath.join(profileDir, "node_modules", name, "cordis.patch.yml");
        if (!nodeFs.existsSync(patch)) continue;
        scanned += 1;
        const text = nodeFs.readFileSync(patch, "utf8");
        for (const m of text.matchAll(/^\s*- id:\s*(preset-[a-z0-9-]+)\s*$/gm)) {
          const id = m[1];
          if (!owners.has(id)) owners.set(id, []);
          if (!owners.get(id).includes(name)) owners.get(id).push(name);
        }
      }
    } catch {
      /* 读不出清单不影响其它检查 */
    }
  }
  const conflicts = [...owners.entries()].filter(([, list]) => list.length > 1);
  if (scanned === 0) {
    add("preset 覆盖唯一性（C95）", "ok", "未采集（profile 里没有 bundle patch）");
  } else if (conflicts.length > 0) {
    add(
      "preset 覆盖唯一性（C95）",
      "warn",
      `${conflicts.length} 个 preset 被多个 bundle 覆盖：${conflicts.map(([id, list]) => `${id}←${list.join("+")}`).join(" · ")} —— 后写者整体接管 config，压缩后端可能被静默顶掉`,
    );
  } else {
    add("preset 覆盖唯一性（C95）", "ok", `${owners.size} 个 preset 各只有一个覆盖者（扫了 ${scanned} 个 bundle patch）`);
  }
}

/* ── 3.5 置换合并可追溯（C33）：被吞节点的身份必须留有记录 ── */
add(
  "置换合并可追溯（superseded）",
  mergeBad > 0 ? "error" : "ok",
  mergeBad > 0
    ? `${mergeBad} 条记录自相矛盾（指向仍在图里的节点 / 缺 seq）—— 合并审计不可信`
    : mergeNodes > 0
      ? `${mergeNodes} 个节点记录过合计 ${mergeOps} 次合并（被吞节点 id/seq/goal 有界保留）`
      : "没有发生置换合并（无需审计）",
);
{
  const rate = graphEdges > 0 ? (selfLoops / graphEdges) * 100 : 0;
  const ratio = graphNodes > 0 ? graphEdges / graphNodes : 0;
  add(
    "图结构（自环）",
    collapsedGraphs === 0 ? "ok" : "warn",
    `边 ${graphEdges} / 节点 ${graphNodes} / 自环 ${selfLoops} = ${rate.toFixed(1)}% / 边节点比 ${ratio.toFixed(2)}` +
      (collapsedGraphs === 0
        ? "（0 个坍缩图）"
        : `（${collapsedGraphs} 个图坍缩 —— 旧版遗留边；热清单的 dead/redundant 标记在这些会话上不可信）`),
  );
}
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
/* ★ 2026-11-01（C20）：fold 的**成本效率** —— 摘要请求读了多少 token，才换回多少遮蔽 token。
   live 实测 input/shadowed = 1.43–1.63：**摘要请求读的是整个 surface，不是只读被折叠段**。
   比值 ≥2 说明「读两倍才压一倍」—— 触发点太晚、或增量范围切得太碎。纯观测，不改行为。 */
{
  const rows = recentFoldMarks
    .map((m) => foldCostMetrics({ inputTokens: m?.usage?.inputTokens, shadowedTokens: m?.shadowedTokens, summaryTokens: m?.usage?.outputTokens }))
    .filter(Boolean);
  if (rows.length === 0) {
    add("fold 成本口径（遮蔽占读入）", "warn", "未采集（老 foldMark 没有 usage/shadowedTokens）");
  } else {
    const shares = rows.map((r) => r.share);
    const ratios = rows.map((r) => r.ratio);
    const rois = rows.map((r) => r.roi);
    const minShare = Math.min(...shares);
    add(
      "fold 成本口径（遮蔽占读入）",
      minShare < 0.3 ? "warn" : "ok",
      `遮蔽占读入 ${(minShare * 100).toFixed(0)}–${(Math.max(...shares) * 100).toFixed(0)}%` +
        `（${rows.length} 次 fold；input/shadowed ${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)} 含 host 工具/system 固定开销，不单独判错）` +
        ` · 每读 1 token 换回 ${Math.min(...rois).toFixed(2)}–${Math.max(...rois).toFixed(2)} token 永久缩减` +
        // ★ C236：折叠调用的**缓存命中率**（与每步注入的 97% 是两个世界：折叠每次都是新区间）。
        //   实测 33 次 fold：输入 7.06 M、其中缓存读仅 241 k = 3.4% ⇒ 折叠才是可数的成本（≈$0.032/次）。
        (() => {
          const withCache = recentFoldMarks.filter((m) => Number.isFinite(m?.usage?.inputTokens) && Number.isFinite(m?.usage?.cacheReadTokens));
          if (withCache.length === 0) return "";
          const input = withCache.reduce((n, m) => n + m.usage.inputTokens, 0);
          const cache = withCache.reduce((n, m) => n + m.usage.cacheReadTokens, 0);
          if (input <= 0) return "";
          return ` · fold 缓存命中 ${Math.round((cache / input) * 100)}%（${withCache.length} 次；与注入的 97% 不是一个世界 —— 折叠每次都是新区间）`;
        })() +
        // ★ C237：**我们自己的指令**占 fold 输入多少（facts + 模板）。实测 1.7% ⇒
        //   「input/shadowed = 1.4」不是我们造成的，以后别再猜。
        (() => {
          const known = recentFoldMarks.filter((m) => Number.isFinite(m?.usage?.instructionTokens) && Number.isFinite(m?.usage?.inputTokens) && m.usage.inputTokens > 0);
          if (known.length === 0) return "";
          const share = known.reduce((n, m) => n + m.usage.instructionTokens / m.usage.inputTokens, 0) / known.length;
          return ` · 我们的指令占输入 ${(share * 100).toFixed(1)}%（${known.length} 次；其余是宿主送进来的消息 —— input/shadowed 的差额不归我们）`;
        })() +
        (minShare < 0.3 ? " —— 折得太碎/太早：遮蔽段占读入不足 30%，考虑提高增长闸" : ""),
    );
  }
}

/* ★ P2-2（task-192）：最近 5 次 fold 的 route / fallback / ms / usage。
   旧图的 foldMark 没有这些字段 ⇒ 明确写「—」（不许用 0/undefined 冒充数据）。
   tier-2 的合并记录不是 fold（没有 route/usage），也按「—」显示。 */
{
  const fmt = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));
  const sorted = recentFoldMarks
    .filter((m) => typeof m.at === "number")
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
  if (sorted.length === 0) {
    add("最近 5 次 fold（route/fallback/ms/usage）", "warn", "没有任何 fold 记录");
  } else {
    const lines = sorted.map((m) => {
      const when = new Date(m.at).toISOString();
      const route = m.route ? `${fmt(m.route.provider)}/${fmt(m.route.model)}` : "—";
      const usage = m.usage ? `in ${fmt(m.usage.inputTokens)} / out ${fmt(m.usage.outputTokens)}` : "—";
      // ★ 2026-11-01：摘要字符数（老 foldMark 没有 ⇒ 显示「—」）。超 3000 字符标「!」——
      //   指令预算约 920 字符（40/死路 + 600），模型偶尔会不遵守，长了要能看见。
      const charsRaw = m.summaryChars;
      const chars = charsRaw === null || charsRaw === undefined ? "—" : `${charsRaw}${charsRaw > 3000 ? "!" : ""}`;
      const shadow = fmt(m.shadowedTokens);
      const ms = fmt(m.ms);
      const fb = fmt(m.fallback);
      const kind = m.tier2 === true ? "tier-2 " : "";
      // 2026-11-01（C12）：为什么压也要看得见 —— pressure / context-overflow（已溢出，被迫自救）/ tier2
      const trigger = fmt(m.trigger);
      // ★ 2026-11-02（C24）：可寻址闭包 —— 这一次 fold 覆盖了图里多少节点/边（老 foldMark 无该字段 ⇒ 不显示）。
      const closure = m.closure && typeof m.closure === "object" ? ` · closure ${fmt(m.closure.nodes)}n/${fmt(m.closure.edges)}e` : "";
      return `${when} ${kind}#${fmt(m.foldCount)} 触发 ${trigger}${closure} · 遮蔽 ${shadow} tok · 摘要 ${chars} 字符 · 路由 ${route} · fallback ${fb} · ${ms} ms · ${usage}（${String(m.session).slice(0, 24)}）`;
    });
    add("最近 5 次 fold（route/fallback/ms/usage）", "ok", lines.join("\n"));
  }
}
/* ★ C196：fold 新鲜度 —— 回答「什么时候会再 fold」。只展示，不判断。 */
{
  const top = [...foldGrowth].sort((a, b) => b.growth - a.growth).slice(0, 3);
  if (top.length === 0) {
    add("fold 新鲜度（距上次 fold 的事件数）", "warn", "没有可用的 fold 记录（或都没有 seqEnd）");
  } else {
    const text = top
      .map((x) => `${String(x.session).slice(0, 18)}: +${x.growth} 事件（${x.folds} 次 fold，最近 ${new Date(x.at).toISOString()}）`)
      .join(" · ");
    add("fold 新鲜度（距上次 fold 的事件数）", "ok", `${text}（只是观测：真正触发时机由窗口阈值与 growthFloor 共同决定）`);
  }
}

/* ★ C216：归档收尾 —— 回答「会话被归档时，最后那一段到底压了没有」。
   判据（真机 1.17.5 的失败样本）：已归档 + 有棋谱 + 一条 closeout 都没有 ⇒ 归档信号没接上。
   这条是 C210 那次真机验证得出的：它挂在 `session/disposed` 上，而 GUI 归档根本不发这个事件。 */
{
  const withCloseout = closeouts.filter((x) => x.closeout !== undefined);
  const withArchiveFold = closeouts.filter((x) => x.archiveFold !== undefined);
  const recent = withCloseout
    .sort((a, b) => Number(b.closeout?.at ?? 0) - Number(a.closeout?.at ?? 0))
    .slice(0, 3)
    .map(
      (x) =>
        `${String(x.session).slice(0, 18)}: 尾巴 ${x.closeout.eventsSinceLastFold} 事件 · ${x.closeout.source ?? "?"} · ` +
        `${x.archiveFold ? "已补折" : Number(x.closeout?.chunkedFolded) > 0 ? `分段折了 ${x.closeout.chunkedFolded} 段` : "未补折"}`,
    )
    .join(" · ");
  if (missingCloseout.length > 0) {
    add(
      "归档收尾（closeout）",
      "warn",
      `${missingCloseout.length} 个会话已归档、留下棋谱，却一条 closeout 都没有（${missingCloseout.slice(0, 3).join(" / ")}${missingCloseout.length > 3 ? " …" : ""}）` +
        ` —— 归档没走到收尾路径：1.17.6 之前挂在 session/disposed 上，而 GUI 归档只写 workspace 域、不发该事件（C216）` +
        `${withCloseout.length > 0 ? `；另有 ${withCloseout.length} 个 closeout 是宿主退出/销毁时才补上的` : ""}`,
    );
  } else if (withCloseout.length === 0) {
    add("归档收尾（closeout）", "warn", "未采集（还没有会话在归档时被收尾过）");
  } else {
    // ★ C266：**按来源分桶**。重启后最该看的一句话是：closeout 是不是由 `archive`（新挂的 domain/changed）驱动的。
    //   若仍然只有 `disposed`，说明 GUI 归档那条路还没接管（C216 未生效）；`backfill` 则说明是补账补的。
    const bySource = {};
    for (const x of withCloseout) {
      const key = typeof x.closeout?.source === "string" && x.closeout.source !== "" ? x.closeout.source : "unknown";
      bySource[key] = (bySource[key] ?? 0) + 1;
    }
    // ★ C292：C289 之后「超大尾巴」改走**分段折叠**（逐段 compactRegion）——
    //   那条路记的是 `ledger-budget.externalFolds`，**不进 graph.foldMarks**。
    //   所以只按 `trigger==="archive"` 数 foldMark 会漏掉分段折的那些，把"已经折过"报成"未补折"。
    //   这里把外部折叠次数一并说出来（它包含分段收尾），让判读有据。
    const externalFolds = (() => {
      // 直接读账本文件（doctor 其它地方也是这么读的）：分段折叠记在 `externalFolds` 上。
      try {
        const file = nodePath.join(home, "chess-context", "ledger-budget.json");
        if (!nodeFs.existsSync(file)) return 0;
        const parsed = JSON.parse(nodeFs.readFileSync(file, "utf8"));
        return Number.isFinite(Number(parsed?.externalFolds)) ? Number(parsed.externalFolds) : 0;
      } catch {
        return 0;
      }
    })();
    // ★ C298：分段折完的会话会在 `closeout.chunkedFolded` 上留数（引擎回写的）；单列出来，
    //   否则"记了 closeout 却没有 archive fold"会一直被读成"没折过"。
    const chunkedSessions = closeouts.filter((x) => Number(x?.closeout?.chunkedFolded) > 0).length;
    const chunkedText = chunkedSessions > 0 ? ` · 其中 ${chunkedSessions} 个是**分段折完的**（closeout.chunkedFolded > 0）` : "";
    const externalText = externalFolds > 0 ? ` · 另有 ${externalFolds} 次外部/分段折叠（不入 foldMarks，见 C289/C292）` : "";
    const sourceText = ` · 来源 ${Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" / ")}`;
    add(
      "归档收尾（closeout）",
      // ★ C298：分段折完的会话也算"折过了"（它们不进 foldMarks，只留 closeout.chunkedFolded）
      withArchiveFold.length > 0 || chunkedSessions > 0 ? "ok" : "warn",
      `${withCloseout.length} 个会话记了 closeout，其中 ${withArchiveFold.length} 个真的补了 archive fold${chunkedText}${externalText}${sourceText} —— ${recent}`,
    );
  }
}

/* ★ 2026-11-01（C12）：fold 触发原因分布 —— `context-overflow` 出现 = 已经被迫自救，
   说明压缩没跟上上下文增长（阈值/增长门控太晚）。这是压缩健康里最该早发现的一条。 */
{
  const withTrigger = recentFoldMarks.filter((m) => typeof m?.trigger === "string" && typeof m.at === "number");
  if (withTrigger.length === 0) {
    add("fold 触发原因", "warn", "未采集（老 foldMark 没有 trigger 字段 —— 旧版本或还没 fold 过）");
  } else {
    const counts = new Map();
    for (const m of withTrigger) counts.set(m.trigger, (counts.get(m.trigger) ?? 0) + 1);
    const overflow = counts.get("context-overflow") ?? 0;
    add(
      "fold 触发原因",
      overflow > 0 ? "warn" : "ok",
      [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" / ") +
        (overflow > 0 ? ` —— 其中 ${overflow} 次是「上下文已溢出后被迫自救」，说明压缩没跟上增长` : ""),
    );
  }
}

/* ★ 2026-11-01（保真度 L1，`src/rooms/fold-quality.mjs`）：最近 fold 的「约束/失败边有没有留住」。
   判据（`docs/压缩的重注入契约.md` §6 第 6b 行）：
     · constraintRecall **必须 = 1** —— 丢一条约束 = 任务变了 ⇒ error；
     · failureRecall < 1 ⇒ warn（丢一条失败边 = 下一个模型必然重踩；也可能是模型没按模板写 edge id）；
     · compressionRatio 只记趋势，不设阈值。
   老 foldMark 没有 quality 字段 ⇒ 明确写「未采集」，不许报 ok。 */
{
  const withQuality = recentFoldMarks
    .filter((m) => m?.quality && typeof m.quality === "object" && typeof m.at === "number")
    .sort((a, b) => b.at - a.at)
    .slice(0, 10);
  if (withQuality.length === 0) {
    add("压缩保真度（最近 fold）", "warn", "未采集（foldMark 还没有 quality —— 旧版本或还没 fold 过）");
  } else {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 1);
    const cMin = Math.min(...withQuality.map((m) => num(m.quality.constraintRecall)));
    const fMin = Math.min(...withQuality.map((m) => num(m.quality.failureRecall)));
    const ratios = withQuality.map((m) => m.quality.compressionRatio).filter((x) => Number.isFinite(x));
    // C30：有几次 fold 的区间早于本图（重启续跑的历史没有节点可回查）—— 只在 >0 时写进 detail。
    const preGraph = withQuality.filter((m) => m.closure?.preGraph === true).length;
    const addressText = preGraph > 0 ? ` · ${preGraph} 次覆盖图外历史（无节点可回查）` : "";
    const ratioText = ratios.length > 0 ? ` · compressionRatio ${Math.min(...ratios)}–${Math.max(...ratios)}` : "";
    const latest = withQuality[0].quality;
    // C38：逐会话的真空样本不再告警，但**全部**样本都是真空 = 保真度其实从未被检验 ⇒ 这里兜底。
    const vacuumCount = withQuality.filter(
      (m) => !(Number(m.quality.expectedConstraints) > 0) && !(Number(m.quality.expectedFailures) > 0),
    ).length;
    const allVacuum = vacuumCount === withQuality.length;
    add(
      "压缩保真度（最近 fold）",
      cMin < 1 ? "error" : fMin < 1 ? "warn" : allVacuum ? "warn" : "ok",
      `constraintRecall min=${cMin} · failureRecall min=${fMin}${ratioText}` +
        `（${withQuality.length} 次 fold 有样本；最近一次：期望约束 ${latest.expectedConstraints ?? "?"} / 期望失败边 ${latest.expectedFailures ?? "?"}` +
        `${latest.modelConstraintRecall === null || latest.modelConstraintRecall === undefined ? "" : ` / 模型自身约束召回 ${latest.modelConstraintRecall}`}）${addressText}` +
        (allVacuum ? ` —— 全部 ${withQuality.length} 次样本都是真空（折叠区间内没有约束/失败边可丢），保真度实际未被检验` : ""),
    );
    // 点名缺失项（最多各 5 条），让人能直接去查是哪条约束/哪条失败边被丢了
    const missingC = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.missingConstraints) ? m.quality.missingConstraints : [])))].slice(0, 5);
    const missingF = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.missingFailures) ? m.quality.missingFailures : [])))].slice(0, 5);
    if (missingC.length > 0) add("压缩保真度 · 丢失的约束", "error", missingC.join(" | "));
    if (missingF.length > 0) add("压缩保真度 · 丢失的失败边", "warn", missingF.join(", "));
    // ★ 2026-11-01：幻觉探针（`findUnknownIds`）—— 摘要提到但图里没有的 id。
    //   只在真出现时显示一行（正常会话零成本）；非空意味着模型的摘要编造了边/节点编号。
    const unknownIds = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.unknownIds) ? m.quality.unknownIds : [])))].slice(0, 10);
    // ★ C104：还有一类探针沉默的错引用 —— 图里有、但不在本次折叠区间内。
    // ★ C206：tier-2 合并的摘要是**规则重建**的（它要把被合并两段的约束/死路/路径都带上），
    //   天然会引用「合并区间之外」的节点与边 —— 那不是幻觉，是合并语义。所以只对**常规 fold** 判越界。
    const outOfRangeSource = withQuality.filter((m) => m.tier2 !== true);
    // ★ C212：只把「引用了**更晚**的实体」算问题（折叠时那段还不存在 ⇒ 编造/错引）。
    //   「引用更早的实体」是回溯历史 kifu，合法（旧版混在一起 ⇒ 把正常回溯也报成越界）。
    const outOfRangeIds = [
      ...new Set(outOfRangeSource.flatMap((m) => (Array.isArray(m.quality.outOfRangeIds) ? m.quality.outOfRangeIds : []))),
    ].slice(0, 8);
    const laterIds = [
      ...new Set(
        outOfRangeSource.flatMap((m) => (Array.isArray(m.quality.outOfRangeLater) ? m.quality.outOfRangeLater : [])),
      ),
    ].slice(0, 8);
    if (unknownIds.length > 0) {
      add(
        "压缩摘要的未知 id（幻觉探针）",
        "warn",
        // ★ C241：别一口咬定是"模型编造"。实测这 4 个 id（n583/n1000/n1600/n2202）**在本会话图里都真实存在**，
        //   它们是摘要从**上下文里的旧编号**（跨会话的 compacted checkpoint 文本）抄来的 —— 属于"编号不属于本图"，
        //   不是纯粹的幻觉。两种成因都写出来，免得下一个人照着"幻觉"去查模型。
        `摘要提到但图里没有：${unknownIds.join(", ")}（可能是模型编造，也可能是从上下文里抄来的旧编号 —— 两者都值得看一眼）`,
      );
    }
    if (laterIds.length > 0) {
      add("压缩摘要的越界 id（C104/C212）", "warn", `摘要引用了**更晚**的实体（折叠时还不存在）：${laterIds.join(", ")}`);
    } else if (outOfRangeIds.length > 0) {
      // ★ C280：旧版读 `outOfRangeLater`（那时根本没这个字段）⇒ 永远读到空 ⇒ 一律断言
      //   「全部是引用更早的，正常」。那是**仪器在撒谎**：真正引用更晚的问题永远看不见。
      //   现在先确认「有没有采集过方向信息」，再决定敢不敢下"正常"这个结论。
      const directionKnown = outOfRangeSource.some((m) => Array.isArray(m.quality.outOfRangeLater) || Array.isArray(m.quality.outOfRangeEarlier));
      if (directionKnown) {
        // 只有「更早」的引用 ⇒ 回溯历史 kifu，正常，不再占一行警告
        add("压缩摘要的越界 id（C104/C212）", "ok", `越界 ${outOfRangeIds.length} 个，全部是引用更早的实体（回溯历史 kifu）—— 正常`);
      } else {
        add(
          "压缩摘要的越界 id（C104/C212）",
          "warn",
          `越界 ${outOfRangeIds.length} 个，但**没有采集方向**（C280 之前的 fold 只存了合并数组）—— ` +
            "无法区分「回溯更早（正常）」与「引用更晚（编造）」；升级后新的 fold 会自动带上方向",
        );
      }
    }
  }
}
  // ★ 2026-11-01（调研候选 #1）：压缩无效（thrashing）—— 与有没有 fold 记录无关，单独一行。
  add(
    "压缩无效（thrashing）",
    thrashGraphs === 0 ? "ok" : "warn",
    thrashGraphs === 0
      ? "没有会话出现「连续两次 fold 间隔 < 30 事件」"
      : `${thrashGraphs} 个会话出现压缩未回收足够空间（最深连续 ${maxThrash} 次）—— 热清单里会有 ⚠ 提示`,
  );
add("最近一次落盘", newestFlush > 0 ? "ok" : "warn", newestFlush ? new Date(newestFlush).toISOString() : "没有任何棋谱");

/* ── 4.8 fold 悬空（合同 §6-4）：liveUnsettled > 0 = fold 切在动作中间；fromBroken > 0 = 图已坏 ── */
{
  const marks = recentFoldMarks.filter((m) => m?.dangling && typeof m.dangling.liveUnsettled === "number");
  if (marks.length === 0) {
    // ★ C64（专员审计 P2）：与本文件自己的纪律保持一致 ——「未采集」不能报 ok。
    add("fold 悬空（dangling）", "warn", "未采集（foldMark 还没有 dangling —— 旧版本）");
  } else {
    const sum = (key) => marks.reduce((acc, m) => acc + (m.dangling[key] ?? 0), 0);
    const live = sum("liveUnsettled");
    const broken = sum("fromBroken");
    const residue = sum("residue");
    const candidates = sum("candidates");
    add(
      "fold 悬空（dangling）",
      broken > 0 ? "error" : live > 0 ? "warn" : "ok",
      broken > 0
        // ★ C276：只说"需要 migrate"等于没说 —— 用户不知道命令叫什么、也不知道可以先 dry-run。
        ? `${broken} 条边的 from 节点已不存在（图坏了）：` +
          "先 `dsh-gokifu-compact migrate-dangling` 看清单（dry-run），确认后加 `--apply`（会自动备份）"
        : live > 0
          ? `${live} 条边在 fold 时仍未结算（可能切在动作中间）—— 结合「fold 边界完整性」看`
          : `${marks.length} 次 fold：residue ${residue} / candidates ${candidates} / liveUnsettled 0 / fromBroken 0`,
    );
  }
}

/* ── 4.9 fold 边界完整性（C31）：切点落在工具调用中间 = 摘要引用区间外结果，判 error ── */
{
  const withBoundary = recentFoldMarks
    .filter((m) => m?.boundary && typeof m.boundary.openAtEnd === "number")
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 10);
  if (withBoundary.length === 0) {
    add("fold 边界完整性", "warn", "未采集（foldMark 还没有 boundary —— 旧版本或还没 fold 过）");
  } else {
    const open = withBoundary.reduce((sum, m) => sum + (m.boundary.openAtEnd ?? 0), 0);
    add(
      "fold 边界完整性",
      open > 0 ? "error" : "ok",
      open > 0
        ? `${open} 次 fold 的切点落在工具调用中间（摘要会引用区间外的结果）`
        : `${withBoundary.length} 次 fold 都切在 step 边界（openAtEnd=0）`,
    );
  }
}

/* ★ C220：上下文缓存命中 —— 本机 96% 的输入 token 走缓存（DeepSeek disk cache）。
   这条是**成本侧的唯一真相**：真正贵的是「没命中的那部分」，而不是我们注入了多少。 */
{
  const c = summarizeCacheUsage(cacheUsage);
  if (c.calls === 0) {
    add("上下文缓存命中（缓存读 / 计费输入）", "warn", "未采集（窗口内的会话日志里没有带 usage 的调用）");
  } else {
    const pct = (v) => (v === null ? "—" : Math.round(v * 100) + "%");
    add(
      "上下文缓存命中（缓存读 / 计费输入）",
      c.ratioMedian !== null && c.ratioMedian < 0.5 ? "warn" : "ok",
      `${c.calls} 次调用 · 缓存读 ${c.cacheTokens} tok / 计费输入 ${c.inputTokens} tok（占比 ${pct(c.savedShare)}）· 单次命中率中位 ${pct(c.ratioMedian)}（最低 ${pct(c.ratioMin)}）· 缓存断点 ${c.breaks} 次（较上一次骤降 >30pp）` +
        // ★ C284：官方原文——缓存是"尽力而为，不保证 100% 命中"，构建耗时秒级、闲置几小时到几天自动清空。
        //   说清楚这几句，才不会有人去追 100%（那是达不到的），也不会把秒级构建当成"接口慢"。
        " · 官方口径：尽力而为、不保证 100%；构建耗时秒级；闲置几小时到几天自动清空",
    );
  }
}

/* ── 5. 热清单预算（fallback 仪表盘，P7 / task-58） ──
   engine 每次 renderLedger 后会把 {none, over-budget, impossible, maxOverBudgetBy} 落到
   `<DSH_HOME>/chess-context/ledger-budget.json`。没有这个文件 = 从未采集（旧版本或还没跑过）
   —— 必须明确写「未采集」，不能假装健康。 */
  const budgetFile = nodePath.join(home, "chess-context", "ledger-budget.json");
  let stats = null;
  let parseError = "";
  if (nodeFs.existsSync(budgetFile)) {
    try {
      stats = JSON.parse(nodeFs.readFileSync(budgetFile, "utf8"));
    } catch (err) {
      parseError = err?.message ?? String(err);
    }
  }
  if (!nodeFs.existsSync(budgetFile)) {
    add("热清单预算（fallback）", "warn", "未采集（还没有 ledger-budget.json —— 插件尚未产生新的热清单，或版本 < 1.9.2）");
  } else if (parseError) {
    add("热清单预算（fallback）", "warn", `未采集（ledger-budget.json 读不出：${parseError}）`);
  } else {
    const none = Number(stats.none ?? 0);
    const over = Number(stats["over-budget"] ?? 0);
    const impossible = Number(stats.impossible ?? 0);
    const maxOver = Number(stats.maxOverBudgetBy ?? 0);
    const total = none + over + impossible;
    // ★ 2026-11-01（调研候选 #2）：出处覆盖率下限。旧版 ledger-budget.json 没有该字段 ⇒ 写「未采集」，
    //   不许报 0（那会把「没采集」误报成「出处全丢了」）。
    // ★ P2-1/P3-1（独立验证 2026-11-01）：「未采集」不能报 **ok**（那等于说"出处都齐"）；
    //   有字段但 min<1（即便 provenanceLow 缺失/为 0，跨版本混写才会出现）也必须 warn。
    const provMin = stats.provenanceMin;
    const provLow = Number(stats.provenanceLow ?? 0);
    const provMissing = provMin === undefined || provMin === null;
    const provDropped = !provMissing && Number(provMin) < 1;
    const provText = provMissing
      ? " · provenanceMin=未采集"
      : ` · provenanceMin=${provMin}${provLow > 0 ? `（<1 共 ${provLow} 次）` : ""}`;
    // ★ C195：注入**命中率** —— 光看「渲染了多少次」看不出「模型实际看到几次清单」。
    //   skipReasons 记的是每次被跳过的原因；命中率 = (samples - 跳过总数) / samples。
    const hasSkipStats = stats.skipReasons !== undefined && stats.skipReasons !== null;
    const skipTotal = Object.values(stats.skipReasons ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const samples = Number(stats.samples ?? 0);
    const injected = samples > 0 ? Math.max(0, samples - skipTotal) : 0;
    const hitRate = samples > 0 ? injected / samples : null;
    const hitText =
      !hasSkipStats || hitRate === null
        ? " · 清单写入=未采集（旧版本没有 skipReasons）"
        // ★ C257：写入率极低时**给出旋钮**（C248/C251 加的两个引擎配置）。
        //   只陈述"有这两个开关"，不写"建议你调" —— 要不要更实时是用户自己的判断。
        : ` · 清单写入 ${injected}/${samples}（${Math.round(hitRate * 100)}%；清单在 surface 上常驻，低占比=少重复写，不是看不见）` +
          (hitRate < 0.05 ? ` · 想更实时可调 hotLedgerMinEvents / hotLedgerMinFailureDelta（见 docs/配置总表.md）` : "");
    add(
      "热清单预算（fallback）",
      impossible > 0 ? "error" : over > 0 || provLow > 0 || provMissing || provDropped ? "warn" : "ok",
      `none=${none} / over-budget=${over} / impossible=${impossible} · 最大 overBudgetBy=${maxOver}${provText}${hitText}` +
        (Number(stats.budgetFloorOver) > 0
          ? ` · 其中 ${stats.budgetFloorOver} 次是「约束+根目标下限」即超预算（不可裁，设计内 —— 见 C41）`
          : "") +
        (Number(stats.renderErrors) > 0 ? ` · **注入渲染失败 ${stats.renderErrors} 次**（本轮注入被跳过，查日志）` : "") +
        (stats.skipReasons && Object.keys(stats.skipReasons).length > 0
          ? ` · 跳过分布 ${Object.entries(stats.skipReasons)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([k, v]) => `${k}=${v}`)
              .join(" / ")}`
          : "") +
        // ★ C245：超预算的**成因**（约束/根目标不可裁 vs 可压缩内容占大头）
        (stats.overByCause && typeof stats.overByCause === "object" && Object.keys(stats.overByCause).length > 0
          ? ` · 成因 ${Object.entries(stats.overByCause)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(([k, n]) => (k === "constraints" ? `约束占大头=${n}` : `内容占大头=${n}`))
              .join(" / ")}`
          : "") +
        // ★ C244：over-budget 的**档位分布** —— 落在 L5 说明已是最省一份（设计内），落在 L0–L3 说明还有空间。
        (stats.overByLevel && typeof stats.overByLevel === "object" && Object.keys(stats.overByLevel).length > 0
          ? ` · 超预算档位 ${Object.entries(stats.overByLevel)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(([lv, n]) => `${lv}=${n}`)
              .join(" / ")}`
          : "") +
        (Number(stats.minimalRenders) > 0 ? ` · 最小清单（无失败边）${stats.minimalRenders} 次` : "") +
        (Number(stats.traceDropped) > 0 ? ` · TRACE 为预算降级 ${stats.traceDropped} 次` : "") +
        (Number(stats.budgetIrreducible) > 0
          ? ` · ${stats.budgetIrreducible} 次已列全失败边仍超（再省只能丢失败记忆 —— 设计内，见 C49）`
          : "") +
        (stats.overBySession && typeof stats.overBySession === "object" && Object.keys(stats.overBySession).length > 0
          ? ` · 主要来源：${Object.entries(stats.overBySession)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map(([sid, n]) => `${sid.slice(0, 16)}… ${n} 次`)
              .join(" / ")}`
          : "") +
        `（共 ${total} 次渲染${total === 0 ? "；样本为空" : ""}${stats.updatedAt ? `，更新于 ${new Date(stats.updatedAt).toISOString()}` : ""}）`,
    );
    // ★ 2026-11-01：分项占用（平均）—— 回答「这几次渲染的钱花在哪一段」。
    //   没有这个消费者，sections 就是个只算不用的指标（第 2 轮的教训）。
    {
      const avg = stats.sectionsAvg;
      const samples = Number(stats.samples ?? 0);
      const totalChars = avg && typeof avg === "object" ? Number(avg.total ?? 0) : 0;
      if (totalChars > 0 && samples > 0) {
        const pct = (key) => Math.round((100 * Number(avg[key] ?? 0)) / totalChars);
        add(
          "热清单分项占用（平均）",
          "ok",
          `根目标 ${pct("root")}% · 约束 ${pct("constraints")}% · 失败边 ${pct("failures")}% · ` +
            `未验证 ${pct("unverified")}% · OPTIONS ${pct("options")}% · 路径 ${pct("path")}% · 其它 ${pct("other")}%` +
            `（共 ${samples} 次渲染，合计 ${Math.round(totalChars)} 字符）`,
        );
      }
    }
  }

/* ★ C198：宿主直接调用 compactRegion 的折叠（我们的 compactIfNeeded 之外）—— 以前完全不留账。 */
{
  const ext = stats && typeof stats === "object" ? Number(stats.externalFolds ?? 0) : 0;
  const last = stats && typeof stats === "object" && stats.lastExternalFold && typeof stats.lastExternalFold === "object" ? stats.lastExternalFold : null;
  if (stats === null || stats === undefined) {
    add("外部折叠（宿主直调 compactRegion）", "warn", "未采集（没有 ledger-budget.json）");
  } else if (ext === 0) {
    add("外部折叠（宿主直调 compactRegion）", "ok", "0 次（本次实例内没有宿主直调的折叠，或尚未发生）—— 该字段 C198 起才写");
  } else {
    const q = last?.quality ? `q=${last.quality.constraintRecall}/${last.quality.failureRecall}` : "q=—";
    const b = last?.boundary ? `openAtEnd=${last.boundary.openAtEnd}` : "openAtEnd=—";
    add(
      "外部折叠（宿主直调 compactRegion）",
      "ok",
      `${ext} 次 · 最近 ${last ? `${last.seqStart}-${last.seqEnd} ${q} ${b} ${new Date(last.at).toISOString()}` : "—"}（这些折叠以前完全不留账，证据里看不到）`,
    );
  }
}

/* ★ C219：热清单**注入动作** —— 缓存友好性。
   append = 只在末尾追加（前缀不动，DeepSeek 的 disk cache 还能命中）；
   replace = 改写 surface 中间那条（从那里起前缀失配，缓存作废）。
   这条以前完全看不到：我们只在文档里说"尽量少写"，没有数字。 */
{
  const actions = stats && typeof stats === "object" && stats.injectActions && typeof stats.injectActions === "object" ? stats.injectActions : null;
  const append = Number(actions?.append) || 0;
  const replace = Number(actions?.replace) || 0;
  if (actions === null || append + replace === 0) {
    add("热清单注入动作（缓存友好性）", "warn", "未采集（ledger-budget.json 里还没有 injectActions —— C219 起才写；重启后自然出现）");
  } else {
    const total = append + replace;
    const pct = Math.round((replace / total) * 100);
    add(
      "热清单注入动作（缓存友好性）",
      pct >= 90 ? "warn" : "ok",
      `append ${append} / replace ${replace}（replace 占 ${pct}%；replace = 改写 surface 中间那条 ⇒ 从那里起前缀失配、缓存作废，占比越高越贵）`,
    );
  }
}

/* ★ C197：token 压力快照 —— 回答「为什么还不 fold」：是没到阈值，还是根本没被调用。 */
{
  const pressure = stats && typeof stats === "object" && stats.pressure && typeof stats.pressure === "object" ? stats.pressure : null;
  if (pressure === null) {
    add("fold 压力（token / 阈值）", "warn", "未采集（`ledger-budget.json` 里还没有 `pressure` —— 该字段 C197 起才写）");
  } else {
    const tokens = Number(pressure.tokens) || 0;
    const threshold = Number(pressure.threshold) || 0;
    const pct = threshold > 0 ? Math.round((tokens / threshold) * 100) : 0;
    const ago = Number.isFinite(pressure.at) ? Math.max(0, Math.round((Date.now() - pressure.at) / 1000)) : null;
    add(
      "fold 压力（token / 阈值）",
      "ok",
      `${tokens.toLocaleString()} / ${threshold.toLocaleString()}（${pct}%）· 距阈值还差 ${(Number(pressure.remaining) || 0).toLocaleString()} · 触发=${pressure.trigger ?? "—"}` +
        (ago === null ? "" : ` · ${ago}s 前更新`),
    );
  }
}
/* ★ C304：折叠的**输出效率** —— 输出 token 里有多少不是摘要本身。
   官方文档（thinking_mode）：思考的想法走 `reasoning_content`，与 `content` 同级返回；
   开了 thinking 就会按输出价（$0.6/M）多生成一坨我们根本不用的推理。
   本机实测（40 次带 usage 的 fold）：outputTokens / 摘要估算 token 中位 **2 倍**，9 次超 3 倍、最大 **12 倍**。
   只报事实，不自动改配置（关不关 thinking 是用户的选择）。 */
{
  const samples = [];
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
      if (!nodeFs.existsSync(file)) continue;
      let g;
      try {
        // ★ C183：脚本侧读图必须走 loadSessionGraph（会重放 delta），不许裸 fromJSON
        g = loadSessionGraph(file).graph;
      } catch {
        continue;
      }
      for (const mark of Array.isArray(g?.foldMarks) ? g.foldMarks : []) {
        const out = Number(mark?.usage?.outputTokens);
        const chars = Number(mark?.summaryChars);
        if (!Number.isFinite(out) || out <= 0 || !Number.isFinite(chars) || chars <= 0) continue;
        samples.push(out / Math.max(1, Math.round(chars / 3.5)));
      }
    }
  }
  if (samples.length === 0) {
    add("fold 输出效率（输出 token / 摘要本身）", "warn", "未采集（没有同时带 usage.outputTokens 与 summaryChars 的 fold）");
  } else {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const heavy = samples.filter((x) => x > 3).length;
    add(
      "fold 输出效率（输出 token / 摘要本身）",
      heavy > samples.length / 2 ? "warn" : "ok",
      `${samples.length} 次 fold：中位 **${median.toFixed(1)}×**、最大 ${sorted.at(-1).toFixed(1)}×；` +
        `${heavy} 次超过 3× —— 输出账单里有一部分不是摘要（多半是 thinking 的 reasoning_content，按输出价计费）`,
    );
  }
}

/* ★ C332：面板路由的心跳。真机教训（2026-11-02）：插件实例被热重载/卸载后，
   `/gokifu/api` 变成 GET 404 / POST 405，而 doctor、全量测试、门禁**全是绿的** ——
   面板静默死掉几十分钟没人发现。UI 侧在注册时写心跳、卸载时标 closed，这里只读文件、不探网。 */
{
  const heartbeat = nodePath.join(home, "chess-context", "ui-route.json");
  if (!nodeFs.existsSync(heartbeat)) {
    add("面板路由心跳", "warn", "未采集（没有 ui-route.json —— C332 之前启动的实例不会写；重启后才有）");
  } else {
    let hb = null;
    try {
      hb = JSON.parse(nodeFs.readFileSync(heartbeat, "utf8"));
    } catch {
      hb = null;
    }
    if (hb === null || typeof hb !== "object") {
      add("面板路由心跳", "warn", "心跳文件解析失败（内容不是 JSON）");
    } else {
      const at = Number.isFinite(hb.at) ? new Date(hb.at).toISOString() : "?";
      const minutes = Number.isFinite(hb.at) ? Math.round((Date.now() - hb.at) / 60000) : null;
      if (hb.state === "closed") {
        add(
          "面板路由心跳",
          "warn",
          `⚠ 面板在 ${at} **被卸载**（热重载或退出）—— \`/gokifu/api\` 现在大概率不可达，**重启才能恢复**`,
        );
      } else {
        add("面板路由心跳", "ok", `面板路由已注册（${at}${minutes === null ? "" : `，${minutes} 分钟前`}，pid ${hb.pid ?? "?"}）`);
      }
    }
  }
}

/* ★ C317：摘要被截断（finish_reason="length"）—— 官方文档说这时**内容可能被截断**，
   而被截断的摘要在 foldMark 里与完整的几乎一样（只是 summaryChars 短些）。
   只在采集到 finishReason 的 fold 上统计；老 foldMark 没有该字段就明说"未采集"。 */
{
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  let total = 0;
  let known = 0;
  let truncated = 0;
  let unknown = 0;
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
      if (!nodeFs.existsSync(file)) continue;
      let g;
      try {
        g = loadSessionGraph(file).graph;
      } catch {
        continue;
      }
      for (const mark of Array.isArray(g?.foldMarks) ? g.foldMarks : []) {
        total += 1;
        const reason = mark?.finishReason;
        if (typeof reason !== "string") {
          unknown += 1;
          continue;
        }
        known += 1;
        // ★ C320：三种拼法（max-tokens / max_tokens / length）归一化后统一判 —— 别再来回猜口径
        if (isTruncatedFinish(reason)) truncated += 1;
      }
    }
  }
  if (total === 0) {
    add("摘要截断（stopReason=max_tokens）", "warn", "未采集（没有 foldMark）");
  } else if (known === 0) {
    add("摘要截断（stopReason=max_tokens）", "warn", `未采集（${total} 条 foldMark 都没有 stopReason —— C317/C318 之前的不记录）`);
  } else {
    add(
      "摘要截断（finish_reason=length）",
      truncated > 0 ? "warn" : "ok",
      `${known} 次有 finishReason 的 fold 里 **${truncated}** 次是 length` +
        `（终止原因=max-tokens ⇒ 内容可能被截断，摘要可能丢了约束/死路）` +
        (unknown > 0 ? ` · 另有 ${unknown} 条未采集（C317 之前的 fold）` : ""),
    );
  }
}

/* ★ C314：热清单渲染的**实测耗时**（取最大的那个会话）。
   为什么值得报：C313 证明慢在拼字符串（95%），而不是查图 —— 既然改不动，
   那就**把它变成早期预警**：一旦最大会话的渲染超过阈值，这里就会变色，
   不必等到"用户觉得卡"才发现。 */
{
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  let biggest = null;
  if (nodeFs.existsSync(sessionsRoot)) {
    for (const entry of nodeFs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = nodePath.join(sessionsRoot, entry.name, "graph.json");
      if (!nodeFs.existsSync(file)) continue;
      let g;
      try {
        g = loadSessionGraph(file).graph;
      } catch {
        continue;
      }
      const nodes = Object.keys(g?.nodes ?? {}).length;
      if (biggest === null || nodes > biggest.nodes) biggest = { nodes, g, name: entry.name };
    }
  }
  if (biggest === null) {
    add("热清单渲染耗时（最大会话）", "warn", "未采集（没有可读的会话图）");
  } else {
    const ms = Math.round(measureLedgerTimings(biggest.g, { reps: 3 }).total * 10) / 10;
    const level = ms >= 100 ? "warn" : "ok";
    add(
      "热清单渲染耗时（最大会话）",
      level,
      `${biggest.name.slice(0, 18)}（${biggest.nodes} 节点）单次 **${ms} ms**` +
        ` —— 每步注入都付这个钱；C313 实测慢在拼字符串（查图只占 5%），` +
        (ms >= 100 ? "已经到该管的时候了（见 K-16）" : "当前还不值得优化（K-16 的触发线是 100 ms）"),
    );
  }
}

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
