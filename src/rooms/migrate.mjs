/**
 * migrate.mjs —— R14 数据迁移房间（P6-C：悬空边 sidecar 归档）
 *
 * 从 `test/archive-dangling.mjs` 原型晋升（task-112 / P6C-2）。职责分层：
 *   · 本房间：**纯逻辑 + 文件操作**（plan / dry-run / apply / verify / rollback / 备份）
 *   · `scripts/migrate-dangling.mjs`：CLI 参数与输出
 *   · `scripts/cli.mjs`：`migrate-dangling` 子命令转发
 *
 * ★ 硬约束（契约 §2.5）：
 *   1. **禁止被 engine import**（P6-C 禁止 engine 启动钩子）—— `test/rooms.test.mjs` 的 R-E 直接断言；
 *   2. 默认 **dry-run**；`apply` 必须先整目录备份 + 校验，且要求图**至少 120 秒没被写过**
 *      （运行中的插件会 flush 覆盖磁盘清理，实测 netCleaned=0）；
 *   3. 判据**只复用 R06**（`classifyDangling`）—— 判据集中一处，本房间不另写；
 *   4. `candidates`（未落地的 untested，P6C-1）**一条都不许归档**，只归档 settled residue。
 *
 * 为什么是 sidecar 而不是直接删：主图 −2.99MB / flush −21.4%，但失败边是历史证据，不能丢。
 * sidecar（`graph.dangling.json`）保留全部字段 + 源图 sha256 + 生成时间 + 判据，随时可 merge 回来。
 *
 * 允许依赖：R00（fromJSON/toJSON/renderIndexMd）· R06（classifyDangling/DANGLING_STALE_MS）
 *          · `node:fs`/`node:path`/`node:crypto`。**禁止** `@deepseek-ai/*`、engine、scripts、lib。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { fromJSON, toJSON, renderIndexMd } from "./kifu-model.mjs";
import { graphRoot } from "./kifu-persist.mjs";
import { classifyDangling, DANGLING_STALE_MS } from "./ledger.mjs";

export const SIDECAR_NAME = "graph.dangling.json";
export const SIDECAR_FORMAT = "dsh-gokifu-dangling-sidecar";
export const SIDECAR_VERSION = 1;

/** apply 的新鲜度守卫：图在这么多毫秒内被写过 ⇒ 认为插件还在跑，拒绝 apply。 */
export const APPLY_FRESHNESS_MS = 120_000;

export const CRITERIA = Object.freeze({
  residue: "to==null && result!=='untested' && age>10min (classifyDangling==='residue') → archived",
  candidates: "to==null && result==='untested' && age>10min (classifyDangling==='candidate') → KEPT (P6C-1)",
  excludedLive: "to==null && untested && age<=10min — kept in graph",
  excludedFromBroken: "edge.from not in g.nodes — separate class, kept in graph",
  staleMs: DANGLING_STALE_MS,
});

/* ───────────────────────────── 路径规则（R01 口径） ───────────────────────────── */

/** `DSH_HOME`（缺省 `~/.dsh`，与 engine 的 resolveHome 同口径）。 */
export function dshHome(env = process.env) {
  if (env.DSH_HOME && String(env.DSH_HOME).length > 0) return env.DSH_HOME;
  return nodePath.join(env.USERPROFILE ?? env.HOME ?? ".", ".dsh");
}

/** 会话根：`<DSH_HOME>/chess-context/sessions`（路径规则复用 R01 `graphRoot`）。 */
export function sessionsRoot(home = dshHome()) {
  return nodePath.join(graphRoot({ graphDir: "", dshHome: home }), "sessions");
}

/** 备份根：`<DSH_HOME>/chess-context/migrate-backups`（P6C-2 定稿；不再是 tmp/）。 */
export function backupsRoot(home = dshHome()) {
  return nodePath.join(home, "chess-context", "migrate-backups");
}

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
    try {
      nodeFs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
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
 *
 * ★ P6C-2：`residue` **只含 settled**（`result !== "untested"`）；`candidates` 单独列出且**永远不归档**。
 *   这里再断言一次 —— 判据在 R06，但「迁移只动 settled」是迁移自己的责任。
 *
 * @returns {{residue: object[], candidates: object[], live: object[], fromBroken: object[]}}
 */
export function planSession(graph, { now = Date.now() } = {}) {
  const residue = [];
  const candidates = [];
  const live = [];
  const fromBroken = [];
  for (const edge of Object.values(graph.edges ?? {})) {
    const kind = classifyDangling(edge, { graph, now });
    if (kind === "residue") {
      if (edge.result === "untested") throw new Error(`migrate: untested 边 ${edge.id} 被判 residue —— 判据与 P6C-1 冲突，拒绝归档`);
      residue.push(edge);
    } else if (kind === "candidate") candidates.push(edge);
    else if (kind === "live-unsettled") live.push(edge);
    else if (kind === "from-broken") fromBroken.push(edge);
  }
  return { residue, candidates, live, fromBroken };
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

/** 坏图记录（P6C-2 定稿形状）：`{session, ok:false, reason}`。 */
function recordBad(session, err) {
  return { session, ok: false, reason: String(err?.message ?? err) };
}

/** 会话选择器：`only` 为 null/空表示全量；否则只认列表里的目录名。 */
function selectedSessions(root, only) {
  const all = listSessions(root);
  if (!only || only.length === 0) return all;
  const set = new Set(only);
  return all.filter((dir) => set.has(nodePath.basename(dir)));
}

/**
 * dry-run：只读扫描，返回全部数字。**绝不写文件**。
 * ★ P6C-2：坏图不再静默 `continue` —— 逐会话汇总进 `badGraphs`（谁的图坏了必须能查）。
 */
export function dryRun(root, { now = Date.now(), only = null } = {}) {
  const sessions = selectedSessions(root, only);
  let residue = 0;
  let candidates = 0;
  let live = 0;
  let fromBroken = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let affected = 0;
  const perSession = [];
  const badGraphs = [];
  for (const dir of sessions) {
    const text = nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8");
    let g;
    try {
      g = fromJSON(text);
    } catch (err) {
      badGraphs.push(recordBad(nodePath.basename(dir), err));
      continue;
    }
    const plan = planSession(g, { now });
    candidates += plan.candidates.length;
    live += plan.live.length;
    fromBroken += plan.fromBroken.length;
    bytesBefore += Buffer.byteLength(text);
    if (plan.residue.length === 0) {
      bytesAfter += Buffer.byteLength(text);
      continue;
    }
    affected += 1;
    residue += plan.residue.length;
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
    candidates,
    liveUnsettled: live,
    fromBroken,
    sidecarEdges: residue,
    graphBytesBefore: bytesBefore,
    graphBytesAfter: bytesAfter,
    deltaBytes: bytesAfter - bytesBefore,
    badGraphs,
    perSession,
  };
}

/**
 * 新鲜度守卫：返回「最近 maxAgeMs 内被写过」的会话（apply 前必须为空）。
 * 为什么需要：运行中的插件会在内存 flush 时把清理结果覆盖回去（实测 netCleaned=0）。
 * @returns {string[]} 会话目录名
 */
export function freshSessions(root, { now = Date.now(), maxAgeMs = APPLY_FRESHNESS_MS, only = null } = {}) {
  const out = [];
  for (const dir of selectedSessions(root, only)) {
    const st = nodeFs.statSync(nodePath.join(dir, "graph.json"));
    // 用绝对值：NTFS 的时间戳可能比 Date.now() 超前几毫秒（时钟粒度/回拨），
    // 只看 age>=0 会把「刚写过」误判成「旧文件」，守卫就失效了。
    const age = now - st.mtimeMs;
    if (Math.abs(age) < maxAgeMs) out.push(nodePath.basename(dir));
  }
  return out;
}

/* ───────────────────────────── 备份 ───────────────────────────── */

/** 整目录备份到 `<backupRoot>/backup-<ts>/`，返回备份目录与清单。 */
export function backupTree(root, { backupRoot = backupsRoot(), stamp = new Date() } = {}) {
  const ts = stamp.toISOString().replace(/[:.]/g, "-");
  const dest = nodePath.join(backupRoot, `backup-${ts}`);
  if (nodeFs.existsSync(dest)) throw new Error(`备份目录已存在：${dest}`);
  nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
  nodeFs.cpSync(root, dest, { recursive: true });
  const files = hashTree(dest);
  const sourceFiles = hashTree(root);
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
 * 真执行：新鲜度守卫 → 整目录备份 → 逐会话写 sidecar + 删 residue + 重建 index.md。
 * @throws 有「最近 120s 内被写过」的会话时拒绝执行（插件可能正在跑）
 */
export function apply(root, { now = Date.now(), backupRoot = backupsRoot(), stamp = new Date(), maxAgeMs = APPLY_FRESHNESS_MS, only = null } = {}) {
  const fresh = freshSessions(root, { now, maxAgeMs, only });
  if (fresh.length > 0) {
    throw new Error(
      `migrate: 拒绝 apply —— ${fresh.length} 个会话的 graph.json 在 ${maxAgeMs / 1000}s 内被写过（${fresh.slice(0, 3).join(", ")}${fresh.length > 3 ? " …" : ""}）。` +
        " 运行中的插件会用内存图 flush 覆盖磁盘清理（实测 netCleaned=0）；先停插件窗口再重试。",
    );
  }
  const dry = dryRun(root, { now, only });
  const backup = backupTree(root, { backupRoot, stamp });
  let archived = 0;
  let deleted = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const perSession = [];
  const badGraphs = [...dry.badGraphs];
  for (const dir of selectedSessions(root, only)) {
    const graphFile = nodePath.join(dir, "graph.json");
    const text = nodeFs.readFileSync(graphFile, "utf8");
    let g;
    try {
      g = fromJSON(text);
    } catch (err) {
      if (!badGraphs.some((b) => b.session === nodePath.basename(dir))) badGraphs.push(recordBad(nodePath.basename(dir), err));
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
    candidates: dry.candidates,
    liveUnsettled: dry.liveUnsettled,
    fromBroken: dry.fromBroken,
    graphBytesBefore: bytesBefore,
    graphBytesAfter: bytesAfter,
    deltaBytes: bytesAfter - bytesBefore,
    badGraphs,
    perSession,
  };
  writeFileAtomic(nodePath.join(backup.dir, "APPLY.json"), JSON.stringify(summary, null, 1));
  return summary;
}

/* ───────────────────────────── verify ───────────────────────────── */

/**
 * 只读校验：
 *   ① sidecar 行数 == 被删边数（sidecar 存在 ⇒ graph 里该会话 residue 必须 0）；
 *   ② fromBroken 与 apply 时一致；
 *   ③ residue = 0；candidates 必须与 apply 时一致（P6C-2：candidates 一条都不许动）；
 *   ④ 固定种子抽 10 条 sidecar 边与**备份图**里的同 id 边逐字段相同。
 */
export function verify(root, { now = Date.now(), backupDir = "", seed = 20261030, only = null } = {}) {
  const problems = [];
  const sessions = selectedSessions(root, only);
  let sidecarEdges = 0;
  let residue = 0;
  let candidates = 0;
  let fromBroken = 0;
  let checkedSessions = 0;
  const samples = [];
  const badGraphs = [];
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
    let g;
    try {
      g = fromJSON(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
    } catch (err) {
      badGraphs.push(recordBad(sid, err));
      continue;
    }
    const plan = planSession(g, { now });
    residue += plan.residue.length;
    candidates += plan.candidates.length;
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
    for (const id of ids) if (g.edges[id]) problems.push(`${sid}: 归档后 graph 仍含 ${id}`);
    if (plan.residue.length !== 0) problems.push(`${sid}: 归档后仍有 ${plan.residue.length} 条 residue`);
    if (backupGraphs.has(sid)) {
      const before = backupGraphs.get(sid);
      for (const e of sidecar.edges ?? []) {
        if (!before.edges[e.id]) problems.push(`${sid}: 备份图里找不到 ${e.id}`);
      }
    }
  }
  if (backupDir) {
    const applyFile = nodePath.join(backupDir, "APPLY.json");
    if (nodeFs.existsSync(applyFile)) {
      const applyInfo = JSON.parse(nodeFs.readFileSync(applyFile, "utf8"));
      if (applyInfo.fromBroken !== fromBroken) problems.push(`fromBroken 变了：apply 时 ${applyInfo.fromBroken}，现在 ${fromBroken}`);
      if (typeof applyInfo.candidates === "number" && applyInfo.candidates !== candidates) {
        problems.push(`candidates 变了：apply 时 ${applyInfo.candidates}，现在 ${candidates}（P6C-2 要求候选一条不动）`);
      }
    }
  }
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
    candidates,
    fromBroken,
    samples,
    badGraphs,
    problems,
    ok: problems.length === 0 && residue === 0,
  };
}