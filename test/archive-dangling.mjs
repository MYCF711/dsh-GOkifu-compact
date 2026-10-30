#!/usr/bin/env node
/**
 * archive-dangling.mjs —— P6-C：把 rewash 残留悬空边归档到 sidecar 并从主图移除（task-67）
 *
 * 为什么是 sidecar 而不是直接删：ws-dangling 报告 §3 C 方案 —— 主图 −2.99MB / flush −21.4%，
 * 但 268 条「失败边」是历史证据，不能丢。sidecar（`graph.dangling.json`）保留全部字段 + 源图 sha256
 * + 生成时间 + 判据，随时可 merge 回来。
 *
 * 判据（**复用 src/ledger.mjs**，不另写）：
 *   residue(e)        = classifyDangling(e) === "residue"      → 归档并删除
 *   live_unsettled(e) = classifyDangling(e) === "live-unsettled" → **保留**（防误清未结算）
 *   from-broken(e)    = classifyDangling(e) === "from-broken"    → **保留**（另一类，214 条全在 5acafe42）
 *
 * 用法：
 *   node test/archive-dangling.mjs                 # dry-run（默认，不写任何文件）
 *   node test/archive-dangling.mjs --json          # dry-run + JSON
 *   node test/archive-dangling.mjs --apply         # 真执行（先整目录备份）
 *   node test/archive-dangling.mjs --verify        # 只读校验（配合 --backup=<dir>）
 *   node test/archive-dangling.mjs --rollback=<backupDir>
 *   --root=<sessionsRoot>  --backup-dir=<dir>  --now=<epochMs>
 *
 * 退出码：0 正常；1 校验失败/执行失败；2 参数错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromJSON, toJSON, renderIndexMd } from "../src/graph.mjs";
import { classifyDangling, DANGLING_STALE_MS } from "../src/ledger.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = nodePath.join(process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh"), "chess-context", "sessions");
const DEFAULT_BACKUP_ROOT = nodePath.join(HERE, "..", "..", "tmp", "dsh-gokifu-compact", "stopwindow");
const SIDECAR_NAME = "graph.dangling.json";
const SIDECAR_FORMAT = "dsh-gokifu-dangling-sidecar";
const SIDECAR_VERSION = 1;
const CRITERIA = Object.freeze({
  residue: "to==null && age>10min (classifyDangling==='residue')",
  excludedLive: "to==null && untested && age<=10min — kept in graph",
  excludedFromBroken: "edge.from not in g.nodes — separate class, kept in graph",
  staleMs: DANGLING_STALE_MS,
});

/* ───────────────────────────── 基础工具 ───────────────────────────── */

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 同目录 tmp + rename（Windows 上 rename 覆盖已存在文件是原子的）。 */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  nodeFs.writeFileSync(tmp, text, "utf8");
  try {
    nodeFs.renameSync(tmp, file);
  } catch (err) {
    try { nodeFs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 递归列文件（相对路径、字节、sha256），用于备份清单。 */
export function hashTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const abs = nodePath.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) {
        const buf = nodeFs.readFileSync(abs);
        out.push({ rel: r, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
      }
    }
  };
  walk(root, "");
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/* ───────────────────────────── 纯函数层 ───────────────────────────── */

/**
 * 计算一个会话图里要归档的边、要保留的边、以及 from 悬空计数。**不修改图**。
 * @returns {{residue: object[], live: object[], fromBroken: object[]}}
 */
export function planSession(graph, { now = Date.now() } = {}) {
  const residue = [];
  const live = [];
  const fromBroken = [];
  for (const edge of Object.values(graph.edges ?? {})) {
    const kind = classifyDangling(edge, { graph, now });
    if (kind === "residue") residue.push(edge);
    else if (kind === "live-unsettled") live.push(edge);
    else if (kind === "from-broken") fromBroken.push(edge);
  }
  return { residue, live, fromBroken };
}

/** 构造 sidecar 对象（含源图 sha256 / 生成时间 / 判据 / 全部字段的 edges）。 */
export function buildSidecar(graph, residueEdges, { now = Date.now(), sourceSha = "", sessionId = "" } = {}) {
  return {
    format: SIDECAR_FORMAT,
    version: SIDECAR_VERSION,
    sessionId: sessionId || graph.sessionId || "",
    source: { graph: "graph.json", sha256: sourceSha, bytes: 0 },
    generatedAt: new Date(now).toISOString(),
    criteria: CRITERIA,
    edges: residueEdges.map((e) => JSON.parse(JSON.stringify(e))),
  };
}

/** 从图里删除给定 id 的边（原地）。返回删除条数。 */
export function removeEdges(graph, ids) {
  let n = 0;
  for (const id of ids) {
    if (graph.edges && graph.edges[id]) {
      delete graph.edges[id];
      n += 1;
    }
  }
  if (n > 0) graph.updatedAt = Date.now();
  return n;
}

/* ───────────────────────────── 扫描 / dry-run ───────────────────────────── */

/** 扫描 `<root>` 下所有会话目录（每个含 graph.json）。 */
export function listSessions(root) {
  if (!nodeFs.existsSync(root)) return [];
  return nodeFs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => nodePath.join(root, e.name))
    .filter((dir) => nodeFs.existsSync(nodePath.join(dir, "graph.json")))
    .sort();
}

/**
 * dry-run：只读扫描，返回全部数字。**绝不写文件**。
 */
export function dryRun(root, { now = Date.now() } = {}) {
  const sessions = listSessions(root);
  let residue = 0;
  let live = 0;
  let fromBroken = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let affected = 0;
  const perSession = [];
  for (const dir of sessions) {
    const text = nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8");
    let g;
    try {
      g = fromJSON(text);
    } catch {
      continue;
    }
    const plan = planSession(g, { now });
    if (plan.residue.length === 0) {
      residue += 0;
      live += plan.live.length;
      fromBroken += plan.fromBroken.length;
      bytesBefore += Buffer.byteLength(text);
      bytesAfter += Buffer.byteLength(text);
      continue;
    }
    affected += 1;
    residue += plan.residue.length;
    live += plan.live.length;
    fromBroken += plan.fromBroken.length;
    bytesBefore += Buffer.byteLength(text);
    const clone = fromJSON(text);
    removeEdges(clone, plan.residue.map((e) => e.id));
    bytesAfter += Buffer.byteLength(toJSON(clone));
    perSession.push({ session: nodePath.basename(dir), residue: plan.residue.length, bytesBefore: Buffer.byteLength(text) });
  }
  return {
    mode: "dry-run",
    root,
    sessions: sessions.length,
    affectedSessions: affected,
    residue,
    liveUnsettled: live,
    fromBroken,
    sidecarEdges: residue,
    graphBytesBefore: bytesBefore,
    graphBytesAfter: bytesAfter,
    deltaBytes: bytesAfter - bytesBefore,
    perSession,
  };
}

/* ───────────────────────────── 备份 ───────────────────────────── */

/** 整目录备份到 `<backupRoot>/backup-<ts>/`，返回备份目录与清单。 */
export function backupTree(root, { backupRoot = DEFAULT_BACKUP_ROOT, stamp = new Date() } = {}) {
  const ts = stamp.toISOString().replace(/[:.]/g, "-");
  const dest = nodePath.join(backupRoot, `backup-${ts}`);
  if (nodeFs.existsSync(dest)) throw new Error(`备份目录已存在：${dest}`);
  nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
  nodeFs.cpSync(root, dest, { recursive: true });
  const files = hashTree(dest);
  const sourceFiles = hashTree(root);
  // 逐文件比对（copy 后必须与源逐字一致）
  if (files.length !== sourceFiles.length) throw new Error(`备份文件数不一致：源 ${sourceFiles.length} / 备份 ${files.length}`);
  for (let i = 0; i < files.length; i += 1) {
    if (files[i].rel !== sourceFiles[i].rel || files[i].sha256 !== sourceFiles[i].sha256) {
      throw new Error(`备份校验失败：${files[i].rel}`);
    }
  }
  const manifest = { createdAt: stamp.toISOString(), source: root, files, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
  writeFileAtomic(nodePath.join(dest, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
  return { dir: dest, manifest };
}

/** 从备份恢复（覆盖回 source），返回恢复文件数。 */
export function rollback(backupDir) {
  const manifestFile = nodePath.join(backupDir, "MANIFEST.json");
  if (!nodeFs.existsSync(manifestFile)) throw new Error(`备份缺少 MANIFEST.json：${backupDir}`);
  const manifest = JSON.parse(nodeFs.readFileSync(manifestFile, "utf8"));
  const wanted = new Set(manifest.files.map((f) => f.rel));
  let restored = 0;
  for (const f of manifest.files) {
    if (f.rel === "MANIFEST.json") continue;
    const src = nodePath.join(backupDir, f.rel);
    const dst = nodePath.join(manifest.source, f.rel);
    nodeFs.mkdirSync(nodePath.dirname(dst), { recursive: true });
    nodeFs.copyFileSync(src, dst);
    const sha = sha256(nodeFs.readFileSync(dst, "utf8"));
    if (sha !== f.sha256) throw new Error(`恢复后哈希不一致：${f.rel}`);
    restored += 1;
  }
  // 删除 apply 之后新增、备份里没有的文件（如 graph.dangling.json）——否则「回滚」不是逐字还原
  let removed = 0;
  for (const cur of hashTree(manifest.source)) {
    if (wanted.has(cur.rel)) continue;
    nodeFs.rmSync(nodePath.join(manifest.source, cur.rel), { force: true });
    removed += 1;
  }
  return { restored, removed, source: manifest.source };
}

/* ───────────────────────────── apply ───────────────────────────── */

/**
 * 真执行：先整目录备份 → 逐会话写 sidecar + 删 residue + 重建 index.md。
 * @returns {{backupDir:string, sessions:number, archived:number, deleted:number, bytesBefore:number, bytesAfter:number}}
 */
export function apply(root, { now = Date.now(), backupRoot = DEFAULT_BACKUP_ROOT, stamp = new Date() } = {}) {
  const dry = dryRun(root, { now });
  const backup = backupTree(root, { backupRoot, stamp });
  let archived = 0;
  let deleted = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const perSession = [];
  for (const dir of listSessions(root)) {
    const graphFile = nodePath.join(dir, "graph.json");
    const text = nodeFs.readFileSync(graphFile, "utf8");
    let g;
    try {
      g = fromJSON(text);
    } catch {
      continue;
    }
    const plan = planSession(g, { now });
    if (plan.residue.length === 0) continue;
    const before = Buffer.byteLength(text);
    const sourceSha = sha256(text);
    const sidecar = buildSidecar(g, plan.residue, { now, sourceSha, sessionId: nodePath.basename(dir) });
    sidecar.source.bytes = before;
    writeFileAtomic(nodePath.join(dir, SIDECAR_NAME), JSON.stringify(sidecar, null, 1));
    const n = removeEdges(g, plan.residue.map((e) => e.id));
    const next = toJSON(g);
    writeFileAtomic(graphFile, next);
    // 重建 index.md（三层树的入口；边行会少 N 行）
    writeFileAtomic(nodePath.join(dir, "index.md"), renderIndexMd(g));
    archived += plan.residue.length;
    deleted += n;
    bytesBefore += before;
    bytesAfter += Buffer.byteLength(next);
    perSession.push({ session: nodePath.basename(dir), archived: plan.residue.length, deleted: n, bytesBefore: before, bytesAfter: Buffer.byteLength(next) });
  }
  const summary = {
    mode: "apply",
    root,
    backupDir: backup.dir,
    sessions: dry.sessions,
    affectedSessions: perSession.length,
    archived,
    deleted,
    liveUnsettled: dry.liveUnsettled,
    fromBroken: dry.fromBroken,
    graphBytesBefore: bytesBefore,
    graphBytesAfter: bytesAfter,
    deltaBytes: bytesAfter - bytesBefore,
    perSession,
  };
  writeFileAtomic(nodePath.join(backup.dir, "APPLY.json"), JSON.stringify(summary, null, 1));
  return summary;
}

/* ───────────────────────────── verify ───────────────────────────── */

/**
 * 只读校验：
 *   ① sidecar 行数 == 被删边数（sidecar 存在 ⇒ graph 里该会话 residue 必须 0）；
 *   ② fromBroken 与备份时一致；
 *   ③ residue = 0；
 *   ④ 随机抽 10 条 sidecar 边与**备份图**里的同 id 边逐字段相同。
 */
export function verify(root, { now = Date.now(), backupDir = "", seed = 20261030 } = {}) {
  const problems = [];
  const sessions = listSessions(root);
  let sidecarEdges = 0;
  let residue = 0;
  let fromBroken = 0;
  let checkedSessions = 0;
  const samples = [];
  // 备份图索引（用于逐字段比对）
  const backupGraphs = new Map();
  if (backupDir && nodeFs.existsSync(backupDir)) {
    for (const dir of listSessions(backupDir)) {
      const p = nodePath.join(dir, "graph.json");
      try {
        backupGraphs.set(nodePath.basename(dir), JSON.parse(nodeFs.readFileSync(p, "utf8")));
      } catch {
        /* ignore */
      }
    }
  }
  for (const dir of sessions) {
    const sid = nodePath.basename(dir);
    const g = fromJSON(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
    const plan = planSession(g, { now });
    residue += plan.residue.length;
    fromBroken += plan.fromBroken.length;
    const sidecarFile = nodePath.join(dir, SIDECAR_NAME);
    if (!nodeFs.existsSync(sidecarFile)) continue;
    checkedSessions += 1;
    let sidecar;
    try {
      sidecar = JSON.parse(nodeFs.readFileSync(sidecarFile, "utf8"));
    } catch (err) {
      problems.push(`${sid}: sidecar 不是合法 JSON（${err.message}）`);
      continue;
    }
    if (sidecar.format !== SIDECAR_FORMAT || sidecar.version !== SIDECAR_VERSION) problems.push(`${sid}: sidecar 格式/版本不对`);
    if (!Array.isArray(sidecar.edges)) problems.push(`${sid}: sidecar.edges 不是数组`);
    const ids = new Set((sidecar.edges ?? []).map((e) => e.id));
    sidecarEdges += ids.size;
    // ① graph 里不许再有这些边
    for (const id of ids) if (g.edges[id]) problems.push(`${sid}: 归档后 graph 仍含 ${id}`);
    // ② residue 必须 0
    if (plan.residue.length !== 0) problems.push(`${sid}: 归档后仍有 ${plan.residue.length} 条 residue`);
    // ④ 抽样逐字段
    if (backupGraphs.has(sid)) {
      const before = backupGraphs.get(sid);
      for (const e of sidecar.edges ?? []) {
        if (!before.edges[e.id]) problems.push(`${sid}: 备份图里找不到 ${e.id}`);
      }
    }
  }
  // ② fromBroken 与 APPLY.json / 备份时的数字一致
  if (backupDir) {
    const applyFile = nodePath.join(backupDir, "APPLY.json");
    if (nodeFs.existsSync(applyFile)) {
      const apply = JSON.parse(nodeFs.readFileSync(applyFile, "utf8"));
      if (apply.fromBroken !== fromBroken) problems.push(`fromBroken 变了：apply 时 ${apply.fromBroken}，现在 ${fromBroken}`);
    }
  }
  // ④ 随机抽 10 条（固定种子，可复跑）
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const all = [];
  for (const dir of sessions) {
    const f = nodePath.join(dir, SIDECAR_NAME);
    if (!nodeFs.existsSync(f)) continue;
    const sc = JSON.parse(nodeFs.readFileSync(f, "utf8"));
    for (const e of sc.edges ?? []) all.push({ sid: nodePath.basename(dir), edge: e });
  }
  for (let i = 0; i < Math.min(10, all.length); i += 1) {
    const pick = all[Math.floor(rand() * all.length)];
    const before = backupGraphs.get(pick.sid);
    const same = before?.edges?.[pick.edge.id];
    if (!same) {
      problems.push(`抽样 ${pick.sid}/${pick.edge.id}: 备份里找不到`);
      continue;
    }
    const a = JSON.stringify(same);
    const b = JSON.stringify(pick.edge);
    if (a !== b) problems.push(`抽样 ${pick.sid}/${pick.edge.id}: 字段不一致`);
    samples.push({ session: pick.sid, edge: pick.edge.id, identical: a === b });
  }
  return {
    mode: "verify",
    root,
    sessions: sessions.length,
    withSidecar: checkedSessions,
    sidecarEdges,
    residue,
    fromBroken,
    samples,
    problems,
    ok: problems.length === 0 && residue === 0,
  };
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const opts = { mode: "dry-run", json: false, root: DEFAULT_ROOT, backupRoot: DEFAULT_BACKUP_ROOT, backupDir: "", now: Date.now() };
  for (const arg of argv) {
    if (arg === "--apply") opts.mode = "apply";
    else if (arg === "--verify") opts.mode = "verify";
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--backup-dir=")) opts.backupRoot = arg.slice("--backup-dir=".length);
    else if (arg.startsWith("--backup=")) opts.backupDir = arg.slice("--backup=".length);
    else if (arg.startsWith("--rollback=")) { opts.mode = "rollback"; opts.backupDir = arg.slice("--rollback=".length); }
    else if (arg.startsWith("--now=")) opts.now = Number(arg.slice("--now=".length));
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else { console.error(`未知参数：${arg}`); process.exit(2); }
  }
  return opts;
}

function printHelp() {
  console.log(`archive-dangling —— P6-C 悬空边 sidecar 归档工具
  node test/archive-dangling.mjs [--root=<sessionsRoot>] [--json]          # dry-run（默认）
  node test/archive-dangling.mjs --apply [--backup-dir=<dir>]              # 执行（先整目录备份）
  node test/archive-dangling.mjs --verify --backup=<backupDir>             # 只读校验
  node test/archive-dangling.mjs --rollback=<backupDir>                    # 从备份恢复`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  let code = 0;
  if (opts.mode === "dry-run") {
    result = dryRun(opts.root, { now: opts.now });
  } else if (opts.mode === "apply") {
    result = apply(opts.root, { now: opts.now, backupRoot: opts.backupRoot });
  } else if (opts.mode === "verify") {
    result = verify(opts.root, { now: opts.now, backupDir: opts.backupDir });
    if (!result.ok) code = 1;
  } else if (opts.mode === "rollback") {
    result = rollback(opts.backupDir);
  }
  if (opts.json) console.log(JSON.stringify(result, null, 1));
  else if (opts.mode === "dry-run") {
    console.log(`== archive-dangling dry-run ==`);
    console.log(`root: ${result.root}`);
    console.log(`sessions: ${result.sessions}（affected ${result.affectedSessions}）`);
    console.log(`residue: ${result.residue}`);
    console.log(`liveUnsettled: ${result.liveUnsettled}（保留）`);
    console.log(`fromBroken: ${result.fromBroken}（保留）`);
    console.log(`sidecar edges: ${result.sidecarEdges}`);
    console.log(`graph bytes: ${result.graphBytesBefore} → ${result.graphBytesAfter}（${result.deltaBytes}）`);
  } else if (opts.mode === "verify") {
    console.log(result.ok ? `✓ verify ok：sidecar ${result.sidecarEdges} 条 / residue ${result.residue} / fromBroken ${result.fromBroken}` : `✗ verify 失败：${result.problems.join("; ")}`);
  } else {
    console.log(JSON.stringify(result, null, 1));
  }
  process.exit(code);
}

const isMain = process.argv[1] && pathToFileURL(nodePath.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
