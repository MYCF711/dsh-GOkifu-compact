/**
 * ui.mjs —— 「上下文压缩」详情页的 host 半（HTTP 路由 + 状态/配置读写）
 *
 * 为什么需要 host 半：引擎挂在 **agent preset 的 compaction group（isolate realm）** 里，
 * 浏览器页面摸不到它；而配置又写在 preset 的 `cordis.patch.yml`（磁盘文件）。
 * 所以页面只做 UI，数据由这里通过 `ctx.webServer` 的具名路由提供：
 *
 *   POST /gokifu/api  {action:"state"|"save"|"health"|"defaults", patch?, sessionId?}
 *
 * 设计约束（都是实机踩出来的）：
 *   · 只走 webServer 具名路由，不用 Typert —— Typert 的 remote-client 是 DSH 构建期生成的，
 *     第三方插件拿不到那条流水线；`register({kind, path, handler})` 是公开的、够用。
 *   · 写配置**必须**走文本级块替换（`scripts/install.mjs` 的 renderEngineBlock），
 *     因为 preset 里那一块前后都有别的行；用 YAML 库整份重写会丢注释与顺序。
 *   · 保存后必须重启才生效（插件在 boot 时读 preset），所以返回值带 `restartRequired`。
 *
 * 安全：服务器默认只绑 127.0.0.1；这里不做额外鉴权（本机工具），但只接受本机来源。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { parseEngineBlock, renderEngineBlock, ENTRY_ID, PKG_NAME } from "../scripts/install.mjs";

export const name = "dsh-gokifu-compact/ui";
export const inject = ["webServer"];

/** 与 engine.mjs 的 Config 保持一致的默认值（页面用来显示「默认」）。 */
export const DEFAULTS = Object.freeze({
  auto: true,
  thresholdRatio: 0.45,
  headroomTokens: 65536,
  retainRatio: 0.16,
  growthFloorTokens: 40000,
  minFoldTokens: 8000,
  summaryMode: "hybrid",
  // ★ 2026-10-29：与 engine.mjs 的 Config 默认值、桌面 preset 的实际配置统一到 8192。
  //   旧的三处不一致（4096 / 2048 / 8192），而 3072~4096 在真实会话里贴边触发 MAX_TOKENS。
  maxTokens: 8192,
  summarizationProvider: "",
  summarizationModel: "",
  hotLedger: true,
  hotLedgerMaxTokens: 500,
  hotLedgerMarkers: "semantic",
  hotLedgerReplace: true,
  transposition: true,
  tier2After: 8,
});

/** 页面允许改的键（白名单；其余键不碰）。 */
const EDITABLE = new Set(Object.keys(DEFAULTS));

const NUM_RANGES = {
  thresholdRatio: [0.05, 0.95],
  headroomTokens: [0, 512000],
  retainRatio: [0, 0.9],
  growthFloorTokens: [0, 1000000],
  minFoldTokens: [0, 1000000],
  maxTokens: [256, 65536],
  hotLedgerMaxTokens: [0, 20000],
  tier2After: [0, 100],
};

const ENUMS = {
  summaryMode: ["hybrid", "rules", "llm"],
  hotLedgerMarkers: ["semantic", "terse", "off"],
};

function resolveHome() {
  return process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home");
}

/** 找 preset 文件：优先含我们引擎行的那些；找不到就报错给页面。 */
export function findPresetFiles(home = resolveHome()) {
  const root = nodePath.join(home, "preset-bundles");
  if (!nodeFs.existsSync(root)) return [];
  const out = [];
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "cordis.patch.yml");
    if (!nodeFs.existsSync(file)) continue;
    const text = nodeFs.readFileSync(file, "utf8");
    if (text.includes(PKG_NAME) || text.includes("- id: compaction-basic")) {
      out.push({ name: entry.name, file, text });
    }
  }
  return out;
}

/** 最近活跃的棋谱（按 graph.json mtime）。 */
function latestGraph(home = resolveHome()) {
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) return null;
  let best = null;
  for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = nodePath.join(root, d.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    const mtime = nodeFs.statSync(file).mtimeMs;
    if (best === null || mtime > best.mtime) best = { dir: d.name, file, mtime };
  }
  if (best === null) return null;
  try {
    const g = JSON.parse(nodeFs.readFileSync(best.file, "utf8"));
    const marks = g.foldMarks ?? [];
    const failures = Object.values(g.edges ?? {}).filter((e) => e?.result === "failure").length;
    return {
      session: best.dir,
      updatedAt: best.mtime,
      foldCount: g.foldCount ?? 0,
      totalAfter: g.lastFoldTotalTokens ?? 0,
      checkpointSeq: g.checkpointSeq ?? null,
      lastFold: marks.length > 0 ? marks[marks.length - 1] : null,
      lastUsage: g.lastFoldUsage ?? null,
      failures,
      nodes: Object.keys(g.nodes ?? {}).length,
      edges: Object.keys(g.edges ?? {}).length,
    };
  } catch {
    return null;
  }
}

/** 今天的 fold 汇总（按 foldMarks.at，不按文件 mtime）。 */
function todayAggregate(home = resolveHome()) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let folds = 0;
  let shadowed = 0;
  const sessions = new Set();
  let totalSessions = 0;
  let totalFailures = 0;
  if (!nodeFs.existsSync(root)) return { folds, shadowed, sessions: 0, totalSessions, totalFailures };
  for (const d of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = nodePath.join(root, d.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    totalSessions += 1;
    try {
      const g = JSON.parse(nodeFs.readFileSync(file, "utf8"));
      const marks = (g.foldMarks ?? []).filter((m) => (m.at ?? 0) >= from);
      if (marks.length > 0) {
        folds += marks.length;
        sessions.add(d.name);
        shadowed += marks.reduce((sum, m) => sum + (m.shadowedTokens ?? 0), 0);
      }
      totalFailures += Object.values(g.edges ?? {}).filter((e) => e?.result === "failure").length;
    } catch {
      /* 坏图跳过 */
    }
  }
  return { folds, shadowed, sessions: sessions.size, totalSessions, totalFailures };
}

/** 安装/单实例/摘要模型 三项体检（比 test/doctor.mjs 轻，够页面用）。 */
function health(home = resolveHome()) {
  const presets = findPresetFiles(home);
  const withOurs = presets.filter((p) => p.text.includes(ENTRY_ID));
  const withNative = presets.filter((p) => /^\s*- id: compaction-basic\s*$/m.test(p.text));
  const profilePkgFile = nodePath.join(home, "profiles", "desktop", "package.json");
  let profileOk = false;
  let inBundles = false;
  if (nodeFs.existsSync(profilePkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(profilePkgFile, "utf8"));
      profileOk = Boolean(pkg.dependencies?.[PKG_NAME]) || nodeFs.existsSync(nodePath.join(home, "profiles", "desktop", "node_modules", PKG_NAME));
      inBundles = (pkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
    } catch {
      /* ignore */
    }
  }
  return {
    installed: profileOk,
    mounted: withOurs.length > 0,
    singleInstance: withNative.length === 0,
    notInBundles: !inBundles,
    presets: presets.map((p) => ({ name: p.name, file: p.file })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON: ${String(error?.message ?? error)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/** 校验并规整页面提交的 patch；非法键/值直接报错（不静默丢）。 */
export function sanitizePatch(patch) {
  const out = {};
  const skipped = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!EDITABLE.has(key)) {
      skipped.push(key);
      continue;
    }
    if (NUM_RANGES[key] !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
      const [min, max] = NUM_RANGES[key];
      if (n < min || n > max) throw new Error(`${key} 超出范围 [${min}, ${max}]`);
      out[key] = key === "thresholdRatio" || key === "retainRatio" ? Math.round(n * 1000) / 1000 : Math.round(n);
      continue;
    }
    if (ENUMS[key] !== undefined) {
      if (!ENUMS[key].includes(value)) throw new Error(`${key} 必须是 ${ENUMS[key].join(" | ")}`);
      out[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    out[key] = String(value ?? "");
  }
  return { patch: out, skipped };
}

/** 把 patch 写进 preset（带备份）；返回改动清单。 */
export function saveConfig(patch, options = {}) {
  const home = options.home ?? resolveHome();
  const { patch: clean, skipped } = sanitizePatch(patch);
  const presets = findPresetFiles(home).filter((p) => p.text.includes(ENTRY_ID));
  if (presets.length === 0) throw new Error(`没有找到含 ${ENTRY_ID} 的 preset（先跑 install）`);
  const changed = [];
  let backup = null;
  for (const preset of presets) {
    const parsed = parseEngineBlock(preset.text);
    if (parsed === null) continue;
    const next = { ...parsed.config, ...clean };
    const block = renderEngineBlock(next, parsed.indent, parsed.commentLines);
    const text = preset.text.replace(parsed.raw, block);
    if (text === preset.text) continue;
    backup = `${preset.file}.bak-before-ui-${Date.now()}`;
    nodeFs.copyFileSync(preset.file, backup);
    nodeFs.writeFileSync(preset.file, text, "utf8");
    changed.push(preset.file);
  }
  return { changed, skipped, backup, restartRequired: changed.length > 0 };
}

export function apply(ctx) {
  const route = {
    kind: "prefix",
    path: "/gokifu/api",
    handler: async (req, res) => {
      try {
        if (req.method === "OPTIONS") return sendJson(res, 204, {});
        if (req.method !== "POST") return sendJson(res, 405, { error: "只接受 POST" });
        const body = await readBody(req);
        const action = String(body.action ?? "state");
        if (action === "state") {
          const home = resolveHome();
          const presets = findPresetFiles(home).filter((p) => p.text.includes(ENTRY_ID));
          const parsed = presets.length > 0 ? parseEngineBlock(presets[0].text) : null;
          return sendJson(res, 200, {
            ok: true,
            version: readVersion(),
            config: parsed?.config ?? {},
            defaults: DEFAULTS,
            configFile: presets[0]?.file ?? null,
            latest: latestGraph(home),
            today: todayAggregate(home),
            health: health(home),
          });
        }
        if (action === "defaults") return sendJson(res, 200, { ok: true, defaults: DEFAULTS });
        if (action === "save") {
          const result = saveConfig(body.patch ?? {}, { home: resolveHome() });
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "health") return sendJson(res, 200, { ok: true, health: health(resolveHome()), latest: latestGraph(resolveHome()), today: todayAggregate(resolveHome()) });
        return sendJson(res, 400, { error: `未知 action: ${action}` });
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    },
  };
  ctx.effect(() => ctx.webServer.register(route), "gokifu-ui: /gokifu/api");
}

function readVersion() {
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
