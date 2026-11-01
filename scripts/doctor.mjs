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
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fromJSON } from "../src/rooms/kifu-model.mjs";
import { inspectProfileInstall } from "./link-path.mjs";
// ★ W5/W-B（2026-11-01）：preset 发现复用 install.mjs 的两代兼容实现（与 UI 半的 findPresetFiles 同构），
//   不再写死「旧 home 的某个固定 preset 目录/名字」—— 新版 DSH 没有 preset-bundles，旧 home 才走它。
//   选 `./install.mjs` 而不是 `../src/ui.mjs`：doctor 是 CLI 侧脚本，install.mjs 就在同目录、
//   模块级零副作用；ui.mjs 是**宿主半**（webServer 路由 + DEFAULTS），CLI 不该为一段发现逻辑拉它进来。
import { presetsWithCompaction } from "./install.mjs";
import { findShadowedUserPresets } from "../src/rooms/preset-format.mjs";
import { planHomePatch } from "../src/rooms/user-patch.mjs";

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
/** ★ P2-2（task-192）：跨会话收集 foldMarks（带 session 名），供「最近 5 次 fold」展示。 */
const recentFoldMarks = [];
/** ★ 2026-11-01：出现「压缩无效」的会话数 / 最深连续次数。 */
let thrashGraphs = 0;
let maxThrash = 0;
let todayFolds = 0;
let todayShadow = 0;
let todaySessions = 0;
// ★ 2026-10-29：图结构健康度（自环 = 图坍缩；它会让 dead/redundant 标记全错）
let graphEdges = 0;
let graphNodes = 0;
let selfLoops = 0;
let collapsedGraphs = 0;
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
      }
      const marks = g.foldMarks ?? [];
      for (const mark of marks) recentFoldMarks.push({ ...mark, session: d.name });
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
    if (indexMtime === 0 || mtime - indexMtime > 5 * 60 * 1000) indexStale += 1;
  }
}
add("棋谱库", objectHash === 0 ? "ok" : "error", `${sessions} 个会话 / ${agents} 个 agent 节点 / worldHash 对象残留 ${objectHash}`);
add("树新鲜度", indexStale === 0 ? "ok" : "warn", `index.md 落后 graph.json 超过 5 分钟的会话：${indexStale} 个`);
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
  const rows = recentFoldMarks.filter((m) => Number(m?.usage?.inputTokens) > 0 && Number(m?.shadowedTokens) > 0);
  if (rows.length === 0) {
    add("fold 成本效率（摘要输入 ÷ 遮蔽）", "warn", "未采集（老 foldMark 没有 usage/shadowedTokens）");
  } else {
    const ratios = rows.map((m) => Number(m.usage.inputTokens) / Number(m.shadowedTokens));
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    add(
      "fold 成本效率（摘要输入 ÷ 遮蔽）",
      max >= 2 ? "warn" : "ok",
      `input/shadowed = ${min.toFixed(2)}–${max.toFixed(2)}（${rows.length} 次有 usage 的 fold）` +
        (max >= 2 ? " —— 读两倍才压一倍：检查触发点是否太晚 / 增量范围是否切得太碎" : ""),
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
    add(
      "压缩保真度（最近 fold）",
      cMin < 1 ? "error" : fMin < 1 ? "warn" : "ok",
      `constraintRecall min=${cMin} · failureRecall min=${fMin}${ratioText}` +
        `（${withQuality.length} 次 fold 有样本；最近一次：期望约束 ${latest.expectedConstraints ?? "?"} / 期望失败边 ${latest.expectedFailures ?? "?"}` +
        `${latest.modelConstraintRecall === null || latest.modelConstraintRecall === undefined ? "" : ` / 模型自身约束召回 ${latest.modelConstraintRecall}`}）${addressText}`,
    );
    // 点名缺失项（最多各 5 条），让人能直接去查是哪条约束/哪条失败边被丢了
    const missingC = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.missingConstraints) ? m.quality.missingConstraints : [])))].slice(0, 5);
    const missingF = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.missingFailures) ? m.quality.missingFailures : [])))].slice(0, 5);
    if (missingC.length > 0) add("压缩保真度 · 丢失的约束", "error", missingC.join(" | "));
    if (missingF.length > 0) add("压缩保真度 · 丢失的失败边", "warn", missingF.join(", "));
    // ★ 2026-11-01：幻觉探针（`findUnknownIds`）—— 摘要提到但图里没有的 id。
    //   只在真出现时显示一行（正常会话零成本）；非空意味着模型的摘要编造了边/节点编号。
    const unknownIds = [...new Set(withQuality.flatMap((m) => (Array.isArray(m.quality.unknownIds) ? m.quality.unknownIds : [])))].slice(0, 10);
    if (unknownIds.length > 0) {
      add("压缩摘要的未知 id（幻觉探针）", "warn", `摘要提到但图里没有：${unknownIds.join(", ")}`);
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

/* ── 5. 热清单预算（fallback 仪表盘，P7 / task-58） ──
   engine 每次 renderLedger 后会把 {none, over-budget, impossible, maxOverBudgetBy} 落到
   `<DSH_HOME>/chess-context/ledger-budget.json`。没有这个文件 = 从未采集（旧版本或还没跑过）
   —— 必须明确写「未采集」，不能假装健康。 */
{
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
    add(
      "热清单预算（fallback）",
      impossible > 0 ? "error" : over > 0 || provLow > 0 || provMissing || provDropped ? "warn" : "ok",
      `none=${none} / over-budget=${over} / impossible=${impossible} · 最大 overBudgetBy=${maxOver}${provText}` +
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
