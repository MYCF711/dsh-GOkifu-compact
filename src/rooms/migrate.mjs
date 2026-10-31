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
 * 增量帧文件名。
 * ⚠ 必须与 `kifu-persist.sessionPaths().deltaFile` 的 basename 一致（那里的值由
 * `<graphFile>.delta.jsonl` 拼出）。测试 `test/migrate.test.mjs` 有断言盯着这两个名字。
 */
export const DELTA_NAME = "graph.json.delta.jsonl";

/**
 * 新鲜度**证据**：返回每个「最近 maxAgeMs 内被写过」的会话及**具体文件**。
 *
 * 为什么要看 delta：1.9.2 起是**增量落盘** —— `graph.json` 只在回合边界写，
 * 插件活跃时往往只有 `graph.json.delta.jsonl` 在动。旧实现只 stat `graph.json`，
 * 真实库实测有 8 个会话的 delta 在 120s 内被写却没人拦 ⇒ apply 可能在插件
 * 仍活跃时放行，随后内存 flush 覆盖迁移结果。
 *
 * 判据：
 *   · `graph.json` 必看（缺失照旧抛 ENOENT，不静默跳过）；
 *   · `graph.json.delta.jsonl` 存在才看；
 *   · 任一文件的 |now - mtime| < maxAgeMs ⇒ 该会话算 fresh。
 *
 * 用**绝对值**：NTFS 的时间戳可能比 `Date.now()` 超前几毫秒（时钟粒度/回拨），
 * 只看 age>=0 会把「刚写过」误判成「旧文件」，守卫就失效了。
 *
 * @returns {{session: string, file: string, ageMs: number}[]} 命中的（会话, 文件）对
 */
export function freshEvidence(root, { now = Date.now(), maxAgeMs = APPLY_FRESHNESS_MS, only = null } = {}) {
  const out = [];
  for (const dir of selectedSessions(root, only)) {
    const session = nodePath.basename(dir);
    for (const name of ["graph.json", DELTA_NAME]) {
      const file = nodePath.join(dir, name);
      // graph.json 缺失时 statSync 照旧抛错（与旧行为一致）；delta 允许不存在。
      if (name !== "graph.json" && !nodeFs.existsSync(file)) continue;
      const ageMs = Math.abs(now - nodeFs.statSync(file).mtimeMs);
      if (ageMs < maxAgeMs) out.push({ session, file: name, ageMs });
    }
  }
  return out;
}

/**
 * 新鲜度守卫：返回「最近 maxAgeMs 内被写过」的会话（apply 前必须为空）。
 * 为什么需要：运行中的插件会在内存 flush 时把清理结果覆盖回去（实测 netCleaned=0）。
 * 同时看 `graph.json` 与 `graph.json.delta.jsonl`（增量落盘，见 `freshEvidence`）。
 * @returns {string[]} 会话目录名（去重，保留发现顺序）
 */
export function freshSessions(root, opts = {}) {
  return [...new Set(freshEvidence(root, opts).map((hit) => hit.session))];
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
  // 守卫必须点名**具体文件**：图在 1.9.2 起是增量落盘，只报「graph.json 新鲜」
  // 会让人误以为主图没动就能 apply —— 真正在写的是 delta。
  const fresh = freshEvidence(root, { now, maxAgeMs, only });
  if (fresh.length > 0) {
    const sessions = new Set(fresh.map((hit) => hit.session));
    const detail = fresh.slice(0, 3).map((hit) => `${hit.session} 的 ${hit.file}`).join("、");
    throw new Error(
      `migrate: 拒绝 apply —— ${sessions.size} 个会话的文件在 ${maxAgeMs / 1000}s 内被写过（${detail}${fresh.length > 3 ? " …" : ""}）。` +
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

/* ───────────────────────────── merge（sidecar 回灌） ───────────────────────────── */

/**
 * merge 的备份目录：`<backupRoot>/merge-<iso>`（apply 且真的写了才创建）。
 * 与 apply 的整目录备份同根（`<DSH_HOME>/chess-context/migrate-backups`），便于排障时一处找齐。
 */
export function mergeBackupDir({ backupRoot = backupsRoot(), stamp = new Date(), session = "" } = {}) {
  const runDir = nodePath.join(backupRoot, `merge-${stamp.toISOString().replace(/[:.]/g, "-")}`);
  // ★ task-163：同一次 mergeMany 的多个会话共用同一个 backupRoot + stamp ⇒ 必须按会话分子目录，
  //   否则后一个会话的 graph.json/MERGE.json 会把前一个**覆盖掉**（实测：48 会话只剩最后一份）。
  const dir = session ? nodePath.join(runDir, String(session).replace(/[^A-Za-z0-9._-]/g, "_")) : runDir;
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 汇总用的备份目录去重：同一 run 目录只留一条（48 个会话共用一个 root ⇒ 1 条）。
 * 输入是 `perSession`（每项可有 `backupDir`，指向 `<run>/<session>`）。
 * @returns {string[]} 去重后的 **run 目录**列表
 */
export function uniqueBackupDirs(perSession) {
  const dirs = (perSession ?? [])
    .map((one) => one?.backupDir)
    .filter((dir) => typeof dir === "string" && dir.length > 0)
    .map((dir) => nodePath.dirname(dir));
  return [...new Set(dirs)];
}

/**
 * 校验 sidecar 并读出边（纯只读，不碰图）。
 * @returns {{ok:boolean, errors:string[], sidecar:any, edges:any[]}}
 */
export function readSidecar(file, { sessionId = "" } = {}) {
  const errors = [];
  let sidecar = null;
  if (!nodeFs.existsSync(file)) return { ok: false, errors: [`sidecar 不存在：${file}`], sidecar: null, edges: [] };
  try {
    sidecar = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`sidecar 不是合法 JSON（${String(error?.message ?? error)}）`], sidecar: null, edges: [] };
  }
  if (sidecar === null || typeof sidecar !== "object") errors.push("sidecar 顶层不是对象");
  if (sidecar?.format !== SIDECAR_FORMAT) errors.push(`sidecar format 不对：${String(sidecar?.format)}（应为 ${SIDECAR_FORMAT}）`);
  if (sidecar?.version !== SIDECAR_VERSION) errors.push(`sidecar version 不支持：${String(sidecar?.version)}（应为 ${SIDECAR_VERSION}）`);
  if (sessionId && typeof sidecar?.sessionId === "string" && sidecar.sessionId.length > 0 && sidecar.sessionId !== sessionId) {
    errors.push(`sidecar 属于别的会话：${sidecar.sessionId}（当前 ${sessionId}）`);
  }
  const edges = Array.isArray(sidecar?.edges) ? sidecar.edges : null;
  if (edges === null) errors.push("sidecar.edges 不是数组");
  else if (edges.length === 0) errors.push("sidecar 里没有边（空边）");
  if (Array.isArray(edges)) {
    edges.forEach((edge, i) => {
      if (edge === null || typeof edge !== "object") errors.push(`edges[${i}] 不是对象`);
      else if (typeof edge.id !== "string" || edge.id.length === 0) errors.push(`edges[${i}] 缺 id`);
    });
  }
  return { ok: errors.length === 0, errors, sidecar, edges: errors.length === 0 ? edges : [] };
}

/**
 * 把一个 sidecar 回灌进会话图（R14）。
 *
 * 语义（与 apply 对称）：
 *   · 按 **edge.id** 合并；图里已有同 id ⇒ **跳过**（绝不覆盖当前边）；
 *   · 保留 sidecar 里的原字段（JSON 深拷贝，不重算/不改写）；
 *   · 有改动才 `updatedAt = now`、原子写 graph.json、**重建 index.md**；
 *   · **默认 dry-run**（不写任何文件）；`apply:true` 才写，写之前把 graph.json / index.md
 *     备份到 `<backupRoot>/merge-<iso>/`，并落一份 `MERGE.json` 审计；
 *   · 幂等：同一 sidecar 回灌第二次 ⇒ `merged:0`、`skipped:N`、不写盘、不建备份。
 *
 * ⚠ **merge 不是字节级还原**：它把边并回去、刷新 `updatedAt`、重建 index.md，
 *   个别会话的 `stateIndex`（派生数据）可能与归档前不同。要**逐字节**回到某个时点，
 *   请用 `--rollback=<apply 的备份目录>`（apply 的整目录备份才是字节级快照）。
 *
 * @param {string} dir 会话目录（含 graph.json）
 * @param {{sidecarFile?:string, apply?:boolean, backupRoot?:string, stamp?:Date, now?:number}} [options]
 * @returns {{mode:string, session:string, sidecar:string, ok:boolean, dryRun:boolean, total:number, merged:number, skipped:number, duplicates:number, mergedIds:string[], errors:string[], backupDir:string, graphBytesBefore:number, graphBytesAfter:number, indexRebuilt:boolean}}
 */
export function mergeSidecar(dir, { sidecarFile = "", apply = false, backupRoot = backupsRoot(), stamp = new Date(), now = Date.now() } = {}) {
  const session = nodePath.basename(dir);
  const file = sidecarFile || nodePath.join(dir, SIDECAR_NAME);
  const result = {
    mode: apply ? "merge-apply" : "merge-dry-run",
    session,
    sidecar: file,
    ok: false,
    dryRun: !apply,
    total: 0,
    merged: 0,
    skipped: 0,
    duplicates: 0,
    mergedIds: [],
    errors: [],
    backupDir: "",
    graphBytesBefore: 0,
    graphBytesAfter: 0,
    indexRebuilt: false,
  };

  const graphFile = nodePath.join(dir, "graph.json");
  if (!nodeFs.existsSync(graphFile)) {
    result.errors.push(`会话目录里没有 graph.json：${graphFile}`);
    return result;
  }
  const read = readSidecar(file, { sessionId: session });
  if (!read.ok) {
    result.errors.push(...read.errors);
    return result;
  }
  result.total = read.edges.length;

  let text;
  let g;
  try {
    text = nodeFs.readFileSync(graphFile, "utf8");
    g = fromJSON(text);
  } catch (error) {
    result.errors.push(`graph.json 读不出（${String(error?.message ?? error)}）`);
    return result;
  }
  result.graphBytesBefore = Buffer.byteLength(text);

  const seen = new Set();
  for (const edge of read.edges) {
    if (seen.has(edge.id)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(edge.id);
    if (g.edges && g.edges[edge.id]) {
      result.skipped += 1;
      continue;
    }
    g.edges[edge.id] = JSON.parse(JSON.stringify(edge));
    result.mergedIds.push(edge.id);
    result.merged += 1;
  }

  if (result.merged === 0) {
    // 幂等：没有新边 ⇒ 一个字节都不写（不建备份、不碰 index.md）
    result.graphBytesAfter = result.graphBytesBefore;
    result.ok = true;
    return result;
  }

  g.updatedAt = now;
  const next = toJSON(g);
  result.graphBytesAfter = Buffer.byteLength(next);

  if (!apply) {
    result.ok = true;
    return result;
  }

  // ① 显式备份（graph.json + index.md）；② 原子写 graph.json；③ 重建 index.md；④ MERGE.json 审计
  const backupDir = mergeBackupDir({ backupRoot, stamp, session });
  result.backupDir = backupDir;
  nodeFs.copyFileSync(graphFile, nodePath.join(backupDir, "graph.json"));
  const indexFile = nodePath.join(dir, "index.md");
  if (nodeFs.existsSync(indexFile)) nodeFs.copyFileSync(indexFile, nodePath.join(backupDir, "index.md"));
  writeFileAtomic(graphFile, next);
  writeFileAtomic(indexFile, renderIndexMd(g));
  result.indexRebuilt = true;
  writeFileAtomic(
    nodePath.join(backupDir, "MERGE.json"),
    JSON.stringify({ ...result, appliedAt: new Date(now).toISOString(), root: dir }, null, 1),
  );
  result.ok = true;
  return result;
}

/**
 * 回灌一批会话（CLI 用）：`target` 可以是单个 sidecar 文件、单个会话目录、或会话根目录。
 * 返回汇总 + 每会话结果。任何一条出错 ⇒ `ok:false`（但已成功的仍然写完了，逐条可查）。
 *
 * 备份布局：同一次调用里所有会话共用 `<backupRoot>/merge-<iso>/`，**每个会话一个子目录**
 * （`<session>/graph.json|index.md|MERGE.json`）。汇总字段 `backupDirs` 给的是**去重后的 run 目录**
 * （共用 root ⇒ 1 条），`perSession[].backupDir` 仍是各自子目录，两条信息互不替代。
 *
 * ⚠ 与 `mergeSidecar` 相同：**不是字节级还原**（`updatedAt` 会刷、`stateIndex` 可能不同）；
 *   逐字节恢复用 apply 备份 + `rollback`。
 */
export function mergeMany(target, { apply = false, backupRoot = backupsRoot(), stamp = new Date(), now = Date.now() } = {}) {
  const dirs = [];
  const sidecars = [];
  if (!nodeFs.existsSync(target)) {
    return {
      mode: apply ? "merge-apply" : "merge-dry-run",
      target,
      sessions: 0,
      merged: 0,
      skipped: 0,
      ok: false,
      errors: [`目标不存在：${target}`],
      backupDirs: [],
      perSession: [],
    };
  }
  if (nodeFs.statSync(target).isDirectory()) {
    const direct = nodePath.join(target, SIDECAR_NAME);
    if (nodeFs.existsSync(direct) && nodeFs.existsSync(nodePath.join(target, "graph.json"))) {
      dirs.push(target);
    } else {
      for (const dir of listSessions(target)) {
        if (nodeFs.existsSync(nodePath.join(dir, SIDECAR_NAME))) dirs.push(dir);
      }
    }
  } else {
    sidecars.push(target);
  }
  const perSession = dirs.map((dir) => mergeSidecar(dir, { apply, backupRoot, stamp, now }));
  for (const file of sidecars) {
    // sidecar 文件 → 会话目录 = 它的父目录
    perSession.push(mergeSidecar(nodePath.dirname(file), { sidecarFile: file, apply, backupRoot, stamp, now }));
  }
  const merged = perSession.reduce((n, r) => n + r.merged, 0);
  const skipped = perSession.reduce((n, r) => n + r.skipped, 0);
  const errors = perSession.flatMap((r) => r.errors.map((e) => `${r.session}: ${e}`));
  return {
    mode: apply ? "merge-apply" : "merge-dry-run",
    target,
    sessions: perSession.length,
    merged,
    skipped,
    ok: perSession.length > 0 && errors.length === 0,
    errors,
    backupDirs: uniqueBackupDirs(perSession),
    perSession,
  };
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